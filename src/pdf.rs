//! Eigener PDF-Viewer statt des Edge-Viewers von WebView2.
//!
//! Jeder Tab lässt über die DevTools-Schnittstelle (`Fetch`) jede Dokument-Antwort kurz anhalten. Ist es ein PDF,
//! holt Glass die schon geladenen Bytes ab und antwortet stattdessen mit dem Viewer (viewer.html). Adresse, Verlauf
//! und Neu laden bleiben so die der PDF-Datei, und Cookies oder Logins spielen keine Rolle – nichts wird doppelt geladen.
//!
//! PDFs von der Festplatte (`file://`, Kommandozeile, Öffnen-Dialog) zeigt der Viewer unter
//! `http://glass-pdf.localhost/file/<Schlüssel>/<Name>` – nur so kann er sie auch wieder dorthin speichern.
//!
//! Der Viewer holt PDF.js und die Datei von `http://glass-pdf.localhost/`; diese Anfragen beantwortet
//! `watch_requests` in main.rs mit `serve` bzw. `post`, sie gehen nie ins Netz. Was nur der Viewer eines Tabs darf
//! (Unterschriften, Speichern, Verschlüsseln), liegt unter einer geheimen Adresse `api/<Geheimnis>/` pro Tab.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    cell::RefCell,
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    rc::Rc,
};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use windows::core::{HSTRING, PWSTR};

pub const HOST: &str = "http://glass-pdf.localhost/";
const VIEWER_HTML: &str = include_str!("pdf/viewer.html");
/// PDF.js aus src/pdf/vendor, Tabelle von build.rs.
const VENDOR: &[(&str, &[u8])] = include!(concat!(env!("OUT_DIR"), "/pdf_assets.rs"));
/// Die eigenen Skripte und Texte des Viewers.
const OWN: &[(&str, &[u8])] = &[
    ("viewer.mjs", include_bytes!("pdf/viewer.mjs")),
    ("viewer.css", include_bytes!("pdf/viewer.css")),
    ("editor.mjs", include_bytes!("pdf/editor.mjs")),
    ("organize.mjs", include_bytes!("pdf/organize.mjs")),
    ("notes.mjs", include_bytes!("pdf/notes.mjs")),
    ("content.mjs", include_bytes!("pdf/content.mjs")),
    ("redact.mjs", include_bytes!("pdf/redact.mjs")),
    ("textedit.mjs", include_bytes!("pdf/textedit.mjs")),
    ("fields.mjs", include_bytes!("pdf/fields.mjs")),
    ("design.mjs", include_bytes!("pdf/design.mjs")),
    // Deutsche Texte für die Werkzeuge von PDF.js (Englisch bleibt als Rückfall eingebaut)
    ("l10n/locale.json", br#"{"de":"de.ftl"}"#),
    ("l10n/de.ftl", include_bytes!("pdf/de.ftl")),
    // Dieselben Glas-Bausteine wie die Oberfläche (ui.html)
    ("glass-lens.js", include_bytes!("glass-lens.js")),
    ("glass-rim.js", include_bytes!("glass-rim.js")),
    ("group-hover.js", include_bytes!("group-hover.js")),
];
/// So viele PDFs hält ein Tab höchstens bereit, die sein Viewer noch nicht abgeholt hat.
const PENDING: usize = 2;
/// Opaker Sandbox-Origin: Webseiten (Eltern, Opener) kommen nicht an die Geheimnisse des Viewers.
/// wasm-unsafe-eval für Bild-Decoder; data: startet den Worker im eigenen opaken Origin. allow-forms nur, damit
/// submit-Ereignisse (Passwort, Dialoge) ankommen – form-action 'none' verhindert jedes echte Absenden.
fn viewer_csp() -> String {
    format!(
        "sandbox allow-scripts allow-downloads allow-modals allow-forms; default-src 'none'; script-src {HOST} blob: 'wasm-unsafe-eval'; worker-src {HOST} data:; \
         connect-src {HOST} blob: data:; style-src {HOST} 'unsafe-inline'; img-src {HOST} blob: data:; \
         font-src {HOST} blob: data:; base-uri 'none'; form-action 'none'"
    )
}

thread_local! {
    /// PDFs von der Festplatte, die ein Viewer zeigt oder speichern darf: Schlüssel → Pfad.
    static LOCAL: RefCell<HashMap<String, PathBuf>> = RefCell::default();
    /// „Speichern unter“: Bytes, die auf den Dialog warten (Tab, Schlüssel → Vorschlag für den Namen, Inhalt).
    static SAVE_AS: RefCell<HashMap<String, (String, Vec<u8>)>> = RefCell::default();
}

/// Was der Viewer eines Tabs von Glass abholt: PDFs (Schlüssel, Bytes; jedes genau einmal) und das Wallpaper.
#[derive(Clone)]
pub struct Documents(Rc<Inner>);

struct Inner {
    pending: RefCell<VecDeque<(String, Vec<u8>)>>,
    /// Geheime Adresse des Wallpapers für diesen Tab – andere Seiten sollen das Hintergrundbild nicht abrufen können.
    wall: String,
    /// Ebenso der Pfad `api/<Geheimnis>/` (Unterschriften, Speichern, Verschlüsseln).
    api: String,
}

impl Default for Documents {
    fn default() -> Self {
        Self(Rc::new(Inner { pending: RefCell::default(), wall: token(), api: token() }))
    }
}

impl Documents {
    fn add(&self, bytes: Vec<u8>) -> String {
        let mut docs = self.0.pending.borrow_mut();
        while docs.len() >= PENDING {
            docs.pop_front();
        }
        let key = token();
        docs.push_back((key.clone(), bytes));
        key
    }

    fn take(&self, key: &str) -> Option<Vec<u8>> {
        let mut docs = self.0.pending.borrow_mut();
        let i = docs.iter().position(|(k, _)| k == key)?;
        docs.remove(i).map(|(_, bytes)| bytes)
    }

    /// Die Viewer-Seite für ein PDF; `file`: Schlüssel der Datei auf der Festplatte, in die Strg+S speichert.
    fn viewer(&self, name: &str, bytes: Vec<u8>, file: Option<&str>) -> String {
        VIEWER_HTML
            .replace("{{TITLE}}", &escape_html(name))
            .replace("{{DOC}}", &format!("{HOST}doc/{}", self.add(bytes)))
            .replace("{{WALL}}", &format!("{HOST}wallpaper/{}", self.0.wall))
            .replace("{{API}}", &format!("{HOST}api/{}/", self.0.api))
            .replace("{{FILE}}", file.unwrap_or_default())
    }
}

/// 128 Bit Zufall, damit keine andere Seite im Tab das PDF erraten und abrufen kann.
fn token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let part = || {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
        h.finish()
    };
    format!("{:016x}{:016x}", part(), part())
}

// ---------- PDFs von der Festplatte ----------

/// Merkt sich eine Datei und gibt ihren Schlüssel (für `file/<Schlüssel>/…` und `save?file=<Schlüssel>`).
fn remember(path: &Path) -> String {
    let existing = LOCAL.with(|l| l.borrow().iter().find(|(_, p)| p.as_path() == path).map(|(k, _)| k.clone()));
    existing.unwrap_or_else(|| {
        let key = token();
        LOCAL.with(|l| l.borrow_mut().insert(key.clone(), path.to_owned()));
        key
    })
}

/// Adresse, unter der der Viewer die Datei `path` zeigt.
pub fn local_url(path: &Path) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    format!("{HOST}file/{}/{}", remember(path), url_encode(&name))
}

/// Für das Adressfeld: statt der Viewer-Adresse die Datei (`file:///C:/…`).
pub fn display_url(url: &str) -> Option<String> {
    let key = url.strip_prefix(HOST)?.strip_prefix("file/")?.split('/').next()?;
    let path = LOCAL.with(|l| l.borrow().get(key).cloned())?;
    Some(file_url(&path))
}

pub fn file_url(path: &Path) -> String {
    let p = path.to_string_lossy().replace('\\', "/");
    let encoded: String = url_encode(&p).replace("%2F", "/").replace("%3A", ":");
    format!("file:///{encoded}")
}

/// `file:///C:/Ordner/Datei.pdf` → Pfad, wenn es ein PDF ist (die Endung entscheidet, wie im Explorer).
pub fn pdf_path_from_file_url(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("file:///")?;
    let path = percent_decode(rest.split(['?', '#']).next().unwrap_or_default()).replace('/', "\\");
    path.to_ascii_lowercase().ends_with(".pdf").then(|| PathBuf::from(path))
}

// ---------- Abfangen von PDFs aus dem Netz ----------

/// Schaltet das Abfangen für eine neue WebView ein und ruft danach `ready` auf – erst dann darf sie die erste
/// Adresse laden, sonst liefe ein PDF in einem neuen Tab (Link mit target=_blank) am Viewer vorbei.
pub fn intercept(core: &ICoreWebView2, docs: Documents, ready: impl FnOnce() + 'static) {
    use webview2_com::DevToolsProtocolEventReceivedEventHandler;
    // Als Absender kommt die WebView selbst mit – so hält der Handler keinen eigenen Verweis auf sie.
    let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |sender, args| {
        let (Some(core), Some(args)) = (sender, args) else { return Ok(()) };
        let mut raw = PWSTR::null();
        unsafe { args.ParameterObjectAsJson(&mut raw)? };
        let params: Value = serde_json::from_str(&webview2_com::take_pwstr(raw)).unwrap_or_default();
        paused(&core, &docs, &params);
        Ok(())
    }));
    let mut token = 0;
    let listening = unsafe {
        core.GetDevToolsProtocolEventReceiver(windows::core::w!("Fetch.requestPaused"))
            .and_then(|receiver| receiver.add_DevToolsProtocolEventReceived(&handler, &mut token))
    };
    if listening.is_err() {
        return ready();
    }
    // Nur Dokumente (Seiten und iframes), und erst mit der Antwort – dann steht der Content-Type fest.
    let patterns = json!({ "patterns": [{ "resourceType": "Document", "requestStage": "Response" }] });
    // Scheitert es, lädt die Seite trotzdem – dann eben mit dem Edge-Viewer.
    call(core, "Fetch.enable", patterns, move |_| ready());
}

/// Eine Dokument-Antwort ist angehalten: PDF → Viewer, alles andere unverändert weiter.
fn paused(core: &ICoreWebView2, docs: &Documents, p: &Value) {
    let id = p["requestId"].clone();
    let header = |name: &str| {
        p["responseHeaders"]
            .as_array()
            .and_then(|all| all.iter().find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name))))
            .and_then(|h| h["value"].as_str())
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let mime = header("content-type").to_ascii_lowercase();
    let disposition = header("content-disposition");
    let is_pdf = p["responseStatusCode"] == 200
        && (mime.starts_with("application/pdf") || mime.starts_with("application/x-pdf"))
        // Als Download gemeint: bleibt ein Download
        && !disposition.to_ascii_lowercase().starts_with("attachment");
    if !is_pdf {
        return call(core, "Fetch.continueRequest", json!({ "requestId": id }), |_| {});
    }
    let name = file_name(&disposition, p["request"]["url"].as_str().unwrap_or_default());
    let (core2, docs) = (core.clone(), docs.clone());
    call(core, "Fetch.getResponseBody", json!({ "requestId": id }), move |reply| {
        let bytes = reply.and_then(|r| match r["base64Encoded"].as_bool() {
            Some(true) => B64.decode(r["body"].as_str()?).ok(),
            _ => r["body"].as_str().map(|s| s.as_bytes().to_vec()),
        });
        let Some(bytes) = bytes else {
            return call(&core2, "Fetch.continueRequest", json!({ "requestId": id }), |_| {});
        };
        let fulfill = json!({
            "requestId": id,
            "responseCode": 200,
            "responseHeaders": [
                { "name": "Content-Type", "value": "text/html; charset=utf-8" },
                { "name": "Content-Security-Policy", "value": viewer_csp() },
            ],
            "body": B64.encode(docs.viewer(&name, bytes, None)),
        });
        call(&core2, "Fetch.fulfillRequest", fulfill, |_| {});
    });
}

/// DevTools-Methode aufrufen; `done` bekommt die Antwort (oder `None` bei einem Fehler).
fn call(core: &ICoreWebView2, method: &str, params: Value, done: impl FnOnce(Option<Value>) + 'static) {
    let handler = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, reply| {
        done(result.ok().and_then(|_| serde_json::from_str(&reply).ok()));
        Ok(())
    }));
    let _ = unsafe { core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params.to_string()), &handler) };
}

// ---------- Antworten auf glass-pdf.localhost ----------

/// Eine Antwort: Status, MIME-Typ, Inhalt, und ob die Viewer-CSP mitgeht (nur für die Viewer-Seite selbst).
#[derive(Debug, PartialEq)]
pub struct Served {
    pub status: u16,
    pub mime: &'static str,
    pub body: Cow<'static, [u8]>,
    pub csp: Option<String>,
}

impl Served {
    fn ok(mime: &'static str, body: Cow<'static, [u8]>) -> Self {
        Self { status: 200, mime, body, csp: None }
    }
    fn status(status: u16) -> Self {
        Self { status, mime: "text/plain", body: Cow::Borrowed(b""), csp: None }
    }
}

/// Antwort auf eine GET-Anfrage an `http://glass-pdf.localhost/…` – `None` für alle anderen Adressen.
/// `wallpaper` liest das Desktop-Hintergrundbild (nur für die geheime Adresse des Tabs).
pub fn serve(docs: &Documents, uri: &str, wallpaper: impl FnOnce() -> Option<Vec<u8>>) -> Option<Served> {
    let path = uri.strip_prefix(HOST)?.split(['?', '#']).next().unwrap_or_default();
    if path.strip_prefix("wallpaper/").is_some_and(|key| key == docs.0.wall) {
        return Some(match wallpaper() {
            Some(b) => Served::ok(if b.starts_with(b"\x89PNG") { "image/png" } else { "image/jpeg" }, Cow::Owned(b)),
            None => Served::status(404),
        });
    }
    if let Some(call) = path.strip_prefix(&format!("api/{}/", docs.0.api)) {
        return Some(match call {
            "signatures" => Served::ok("application/json", Cow::Owned(std::fs::read(signatures_file()).unwrap_or_else(|_| b"[]".to_vec()))),
            _ => Served::status(404),
        });
    }
    // Eine Datei von der Festplatte: die Viewer-Seite dafür
    if let Some(rest) = path.strip_prefix("file/") {
        let key = rest.split('/').next().unwrap_or_default();
        let Some(file) = LOCAL.with(|l| l.borrow().get(key).cloned()) else { return Some(Served::status(404)) };
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let html = match std::fs::read(&file) {
            Ok(bytes) => docs.viewer(&name, bytes, Some(key)),
            Err(_) => format!("<!doctype html><meta charset=utf-8><title>{0}</title><p style=\"font:14px system-ui;color:#ccc\">{0} lässt sich nicht lesen.</p>", escape_html(&name)),
        };
        return Some(Served { status: 200, mime: "text/html; charset=utf-8", body: Cow::Owned(html.into_bytes()), csp: Some(viewer_csp()) });
    }
    if let Some(key) = path.strip_prefix("doc/") {
        return Some(match docs.take(key) {
            Some(bytes) => Served::ok("application/pdf", Cow::Owned(bytes)),
            None => Served::status(404),
        });
    }
    let body = OWN.iter().chain(VENDOR).find(|(p, _)| *p == path).map(|(_, bytes)| Cow::Borrowed(*bytes));
    let mime = match path.rsplit('.').next().unwrap_or_default() {
        "json" => "application/json",
        "ftl" => "text/plain; charset=utf-8",
        "mjs" | "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    Some(match body {
        Some(body) => Served::ok(mime, body),
        None => Served::status(404),
    })
}

/// Was nach einem POST des Viewers zu tun ist.
#[derive(Debug, PartialEq)]
pub enum Post {
    /// Gleich beantworten.
    Reply(Served),
    /// „Speichern unter“: Glass zeigt den Dialog (main.rs) und meldet das Ergebnis mit `window.__glassSaved`.
    SaveAs(String),
}

/// POST des Viewers an `api/<Geheimnis>/…` (nur der eigene Tab kennt das Geheimnis).
pub fn post(docs: &Documents, uri: &str, body: Vec<u8>) -> Option<Post> {
    let rest = uri.strip_prefix(HOST)?;
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let param = |name: &str| {
        query.split('&').find_map(|kv| kv.strip_prefix(name)?.strip_prefix('=')).map(percent_decode).unwrap_or_default()
    };
    let Some(call) = path.strip_prefix(&format!("api/{}/", docs.0.api)) else { return Some(Post::Reply(Served::status(403))) };
    let reply = |ok: bool| Post::Reply(Served::status(if ok { 204 } else { 400 }));
    Some(match call {
        "signatures" => reply(save_signatures(&body)),
        // Strg+S: zurück in die Datei, aus der das PDF kam (oder die „Speichern unter“ gewählt hat)
        "save" => {
            let Some(file) = LOCAL.with(|l| l.borrow().get(&param("file")).cloned()) else { return Some(reply(false)) };
            if !body.starts_with(b"%PDF") {
                return Some(reply(false));
            }
            Post::Reply(Served::status(if write_atomic(&file, &body).is_ok() { 204 } else { 500 }))
        }
        "save-as" => {
            if !body.starts_with(b"%PDF") {
                return Some(reply(false));
            }
            let ticket = token();
            SAVE_AS.with(|s| s.borrow_mut().insert(ticket.clone(), (param("name"), body)));
            Post::SaveAs(ticket)
        }
        // Mit Passwort schützen: [Länge des Passworts, 4 Byte LE][Passwort UTF-8][PDF]
        "encrypt" => match encrypt(&body) {
            Ok(pdf) => Post::Reply(Served::ok("application/pdf", Cow::Owned(pdf))),
            Err(_) => reply(false),
        },
        _ => Post::Reply(Served::status(404)),
    })
}

/// „Speichern unter“ ausführen (nach dem Dialog in main.rs): `None` = abgebrochen.
/// Liefert den Schlüssel der neuen Datei – künftiges Strg+S speichert dorthin.
pub fn finish_save_as(ticket: &str, choose: impl FnOnce(&str) -> Option<PathBuf>) -> Value {
    let Some((name, bytes)) = SAVE_AS.with(|s| s.borrow_mut().remove(ticket)) else { return json!({ "ok": false }) };
    let Some(path) = choose(&name) else { return json!({ "ok": false, "cancelled": true }) };
    match write_atomic(&path, &bytes) {
        Ok(()) => json!({
            "ok": true,
            "file": remember(&path),
            "name": path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            "path": path.to_string_lossy(),
        }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

/// Erst daneben schreiben, dann ersetzen – bricht etwas ab, bleibt die alte Datei heil.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("glass-tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// AES-256 (PDF 2.0, wie Acrobat „Kompatibel mit Acrobat X und höher“). Ein zufälliges Besitzerkennwort,
/// alle Rechte – geschützt wird das Öffnen.
fn encrypt(body: &[u8]) -> Result<Vec<u8>, String> {
    use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
    use lopdf::{EncryptionState, EncryptionVersion, Object, Permissions};
    let len = u32::from_le_bytes(body.get(..4).ok_or("kurz")?.try_into().map_err(|_| "kurz")?) as usize;
    let password = std::str::from_utf8(body.get(4..4 + len).ok_or("kurz")?).map_err(|e| e.to_string())?;
    let pdf = body.get(4 + len..).ok_or("kurz")?;
    if password.is_empty() {
        return Err("leer".into());
    }
    let mut doc = lopdf::Document::load_mem(pdf).map_err(|e| e.to_string())?;
    if doc.is_encrypted() {
        return Err("schon verschlüsselt".into());
    }
    if doc.trailer.get(b"ID").is_err() {
        let id = || Object::String(token().into_bytes()[..16].to_vec(), lopdf::StringFormat::Hexadecimal);
        doc.trailer.set("ID", Object::Array(vec![id(), id()]));
    }
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).map_err(|e| e.to_string())?;
    let owner = token();
    let filter: std::sync::Arc<dyn CryptFilter> = std::sync::Arc::new(Aes256CryptFilter);
    let version = EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: std::collections::BTreeMap::from([(b"StdCF".to_vec(), filter)]),
        file_encryption_key: &key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: &owner,
        user_password: password,
        permissions: Permissions::all(),
    };
    let state = EncryptionState::try_from(version).map_err(|e| e.to_string())?;
    doc.encrypt(&state).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Der Viewer speichert seine Unterschriften (JSON-Liste). `false`: kein gültiger Inhalt – die Datei bleibt.
fn save_signatures(body: &[u8]) -> bool {
    if body.len() > MAX_SIGNATURES {
        return false;
    }
    let Ok(list @ Value::Array(_)) = serde_json::from_slice::<Value>(body) else { return false };
    let file = signatures_file();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(file, list.to_string()).is_ok()
}

/// Höchstens so groß darf die Liste der Unterschriften werden (wenige, als Linienzüge).
const MAX_SIGNATURES: usize = 4 << 20;

fn signatures_file() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(|p| PathBuf::from(p).join("GlassBrowser"))
        .unwrap_or_else(|| std::env::temp_dir().join("GlassBrowser"))
        .join("signatures.json")
}

/// Dateiname für den Tab-Titel: aus `Content-Disposition`, sonst der letzte Teil der Adresse.
fn file_name(disposition: &str, url: &str) -> String {
    let param = |key: &str| {
        disposition.split(';').map(str::trim).find_map(|part| {
            let (k, v) = part.split_once('=')?;
            k.trim().eq_ignore_ascii_case(key).then(|| v.trim().trim_matches('"').to_owned())
        })
    };
    let from_header = param("filename*")
        .map(|v| percent_decode(v.rsplit("''").next().unwrap_or_default()))
        .or_else(|| param("filename"));
    let from_url = || {
        let path = url.split(['?', '#']).next().unwrap_or_default();
        percent_decode(path.rsplit('/').next().unwrap_or_default())
    };
    let name: String = from_header.filter(|n| !n.trim().is_empty()).unwrap_or_else(from_url).trim().chars().take(200).collect();
    if name.is_empty() { "PDF-Dokument".to_owned() } else { name }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match (bytes[i], bytes.get(i + 1).copied().and_then(hex), bytes.get(i + 2).copied().and_then(hex)) {
            (b'%', Some(hi), Some(lo)) => {
                out.push((hi * 16 + lo) as u8);
                i += 3;
            }
            (b, ..) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_header_or_url() {
        assert_eq!(file_name("", "https://a.de/docs/Vertrag%20neu.pdf?x=1"), "Vertrag neu.pdf");
        assert_eq!(file_name("inline; filename=\"Rechnung.pdf\"", "https://a.de/get?id=3"), "Rechnung.pdf");
        assert_eq!(file_name("inline; filename*=UTF-8''%C3%9Cbersicht.pdf", "https://a.de/x"), "Übersicht.pdf");
        assert_eq!(file_name("", "https://a.de/"), "PDF-Dokument");
    }

    #[test]
    fn documents_are_served_once() {
        let docs = Documents::default();
        let key = docs.add(b"%PDF".to_vec());
        let uri = format!("{HOST}doc/{key}");
        let none = || None;
        assert_eq!(serve(&docs, &uri, none).unwrap().status, 200);
        assert_eq!(serve(&docs, &uri, none).unwrap().status, 404);
        assert_eq!(serve(&docs, "https://example.com/", none), None);
        assert_eq!(serve(&docs, &format!("{HOST}pdf.min.mjs"), none).unwrap().status, 200);
    }

    #[test]
    fn api_only_with_the_tabs_secret() {
        let docs = Documents::default();
        let api = format!("{HOST}api/{}/", docs.0.api);
        assert_eq!(post(&docs, &format!("{HOST}api/guess/signatures"), b"[]".to_vec()), Some(Post::Reply(Served::status(403))));
        assert_eq!(post(&Documents::default(), &format!("{api}signatures"), b"[]".to_vec()), Some(Post::Reply(Served::status(403))));
        assert_eq!(post(&docs, &format!("{api}signatures"), br#"{"not":"a list"}"#.to_vec()), Some(Post::Reply(Served::status(400))));
        assert_eq!(serve(&docs, &format!("{HOST}api/guess/signatures"), || None).unwrap().status, 404);
        assert_eq!(serve(&docs, &format!("{api}signatures"), || None).unwrap().mime, "application/json");
        // Speichern nur in Dateien, die Glass geöffnet hat
        assert_eq!(post(&docs, &format!("{api}save?file=guess"), b"%PDF".to_vec()), Some(Post::Reply(Served::status(400))));
    }

    #[test]
    fn local_files_round_trip() {
        let dir = std::env::temp_dir().join(format!("glass-pdf-test-{}", token()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Mein Vertrag.pdf");
        std::fs::write(&file, b"%PDF-1.4 alt").unwrap();
        let url = local_url(&file);
        assert!(url.ends_with("/Mein%20Vertrag.pdf"));
        assert_eq!(display_url(&url).as_deref(), Some(file_url(&file).as_str()));
        assert_eq!(pdf_path_from_file_url(&file_url(&file)), Some(file.clone()));
        let docs = Documents::default();
        let page = serve(&docs, &url, || None).unwrap();
        assert!(page.csp.is_some() && String::from_utf8_lossy(&page.body).contains("Mein Vertrag.pdf"));
        let key = url.strip_prefix(HOST).unwrap().split('/').nth(1).unwrap().to_owned();
        let save = format!("{HOST}api/{}/save?file={key}", docs.0.api);
        assert_eq!(post(&docs, &save, b"%PDF-1.4 neu".to_vec()), Some(Post::Reply(Served::status(204))));
        assert_eq!(std::fs::read(&file).unwrap(), b"%PDF-1.4 neu");
        // Kein PDF: bleibt ungeschrieben
        assert_eq!(post(&docs, &save, b"<html>".to_vec()), Some(Post::Reply(Served::status(400))));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn encrypts_with_aes256() {
        let pdf = b"%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >> endobj\ntrailer << /Root 1 0 R /Size 4 >>\n%%EOF";
        let mut body = 6u32.to_le_bytes().to_vec();
        body.extend_from_slice(b"geheim");
        body.extend_from_slice(pdf);
        let out = encrypt(&body).unwrap();
        assert!(String::from_utf8_lossy(&out).contains("/Encrypt"));
        assert!(lopdf::Document::load_mem_with_password(&out, "geheim").is_ok());
    }

    #[test]
    fn wallpaper_only_with_the_tabs_key() {
        let docs = Documents::default();
        let wall = || Some(b"\x89PNG".to_vec());
        assert_eq!(serve(&docs, &format!("{HOST}wallpaper/{}", docs.0.wall), wall).unwrap().mime, "image/png");
        assert_eq!(serve(&docs, &format!("{HOST}wallpaper/guess"), wall).unwrap().status, 404);
        assert_eq!(serve(&Documents::default(), &format!("{HOST}wallpaper/{}", docs.0.wall), wall).unwrap().status, 404);
    }
}
