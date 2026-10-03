//! Eigener PDF-Viewer statt des Edge-Viewers von WebView2.
//!
//! Jeder Tab lässt über die DevTools-Schnittstelle (`Fetch`) jede Dokument-Antwort kurz anhalten. Ist es ein PDF,
//! holt Glass die schon geladenen Bytes ab und antwortet stattdessen mit dem Viewer (viewer.html). Adresse, Verlauf
//! und Neu laden bleiben so die der PDF-Datei, und Cookies oder Logins spielen keine Rolle – nichts wird doppelt geladen.
//!
//! PDFs von der Festplatte (`file://`, Kommandozeile, Öffnen-Dialog) zeigt der Viewer unter
//! `http://glass-pdf.localhost/file/<Schlüssel>/<Name>` – nur so kann er sie auch wieder dorthin speichern.
//!
//! Neue PDFs, die der Viewer selbst baut (etwa aus Bildern), öffnet Glass in einem neuen Tab unter
//! `http://glass-pdf.localhost/new/<Schlüssel>/<Name>` – gespeichert wird dann mit „Speichern unter“.
//!
//! Der Viewer holt PDF.js und die Datei von `http://glass-pdf.localhost/`; diese Anfragen beantwortet
//! `watch_requests` in main.rs mit `serve` bzw. `post`, sie gehen nie ins Netz. Was nur der Viewer eines Tabs darf
//! (Unterschriften, Speichern, Verschlüsseln), liegt unter einer geheimen Adresse `api/<Geheimnis>/` pro Tab.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    cell::RefCell,
    collections::{HashMap, HashSet, VecDeque},
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
    ("images.mjs", include_bytes!("pdf/images.mjs")),
    ("compress.mjs", include_bytes!("pdf/compress.mjs")),
    ("imageedit.mjs", include_bytes!("pdf/imageedit.mjs")),
    // Deutsche Texte für die Werkzeuge von PDF.js (Englisch bleibt als Rückfall eingebaut)
    ("l10n/locale.json", br#"{"de":"de.ftl"}"#),
    ("l10n/de.ftl", include_bytes!("pdf/de.ftl")),
    // Englische Texte der eigenen Werkzeuge (die von PDF.js selbst sind auf Englisch eingebaut)
    ("en.mjs", include_bytes!("pdf/en.mjs")),
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
    /// „Speichern unter“: Bytes, die auf den Dialog warten (Ticket → API-Geheimnis des Tabs, Vorschlag für den Namen, Inhalt).
    static SAVE_AS: RefCell<HashMap<String, (String, String, Vec<u8>)>> = RefCell::default();
    /// Ergebnis des Dialogs, bis der Viewer es abholt (Ticket → API-Geheimnis des Tabs, Ergebnis). Abholen statt
    /// `evaluate_script`: Das träfe das oberste Dokument des Tabs – bei einem PDF im iframe die fremde Seite drumherum.
    static SAVED: RefCell<HashMap<String, (String, Value)>> = RefCell::default();
    /// Neue PDFs aus dem Viewer (Schlüssel, Name, Bytes) – auch Neu laden zeigt sie wieder.
    static NEW: RefCell<VecDeque<(String, String, Vec<u8>)>> = RefCell::default();
    /// Installierte Schriften für „Text bearbeiten“ (einmal aus der Registry gelesen).
    static FONTS: RefCell<Option<Rc<Fonts>>> = RefCell::default();
}

/// So viele neue PDFs bleiben im Speicher.
const NEW_KEPT: usize = 6;

/// Was der Viewer eines Tabs von Glass abholt: PDFs (Schlüssel, Bytes; jedes genau einmal) und das Wallpaper.
#[derive(Clone)]
pub struct Documents(Rc<Inner>);

struct Inner {
    pending: RefCell<VecDeque<(String, Vec<u8>)>>,
    /// Geheime Adresse des Wallpapers für diesen Tab – andere Seiten sollen das Hintergrundbild nicht abrufen können.
    wall: String,
    /// Ebenso der Pfad `api/<Geheimnis>/` (Unterschriften, Speichern, Verschlüsseln).
    api: String,
    /// Adressen, unter denen in diesem Tab gerade der Viewer läuft (abgefangene PDFs) – nur sie dürfen dessen
    /// Nachrichten an Glass schicken (`is_viewer`).
    viewers: RefCell<HashSet<String>>,
}

impl Default for Documents {
    fn default() -> Self {
        Self(Rc::new(Inner { pending: RefCell::default(), wall: token(), api: token(), viewers: RefCell::default() }))
    }
}

/// Adresse ohne Sprungmarke (`#page=2` ändert das Dokument nicht).
fn without_fragment(url: &str) -> &str {
    url.split('#').next().unwrap_or_default()
}

impl Documents {
    /// Zeigt das Dokument unter `url` den Viewer? (Für Nachrichten über `window.ipc`, die jede Seite schicken kann.)
    pub fn is_viewer(&self, url: &str) -> bool {
        let url = without_fragment(url);
        is_page(url) || self.0.viewers.borrow().contains(url)
    }

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
            .replace("{{LANG}}", crate::i18n::lang().code())
    }
}

/// 128 Bit Zufall aus dem Zufallsgenerator des Systems, damit keine andere Seite im Tab das PDF erraten und abrufen kann.
fn token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("Zufallsgenerator des Systems");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Viewer-Seite für eine Datei von der Festplatte oder ein neues PDF? Die gibt es nur als Dokument (Seite, iframe),
/// nie per `fetch` – sonst könnte eine Seite sie lesen und das API-Geheimnis darin finden.
pub fn is_page(uri: &str) -> bool {
    uri.strip_prefix(HOST).is_some_and(|path| path.starts_with("file/") || path.starts_with("new/"))
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
    let rest = url.strip_prefix(HOST)?;
    // Neues, noch nicht gespeichertes PDF: nur sein Name
    if let Some(new) = rest.strip_prefix("new/") {
        return new.split_once('/').map(|(_, name)| percent_decode(name));
    }
    let key = rest.strip_prefix("file/")?.split('/').next()?;
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
    // Nur lokale Laufwerke (C:\…): Bei file:////server/… meldete schon das Lesen Windows dort mit dem Konto an
    let local = path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic();
    (local && path.to_ascii_lowercase().ends_with(".pdf")).then(|| PathBuf::from(path))
}

// ---------- Abfangen von PDFs aus dem Netz ----------

/// Schaltet das Abfangen für eine neue WebView ein und ruft danach `ready` auf – erst dann darf sie die erste
/// Adresse laden, sonst liefe ein PDF in einem neuen Tab (Link mit target=_blank) am Viewer vorbei.
/// `answered` erfährt die Adresse jedes Dokuments (Seite oder iframe), dessen Antwort angekommen ist.
pub fn intercept(core: &ICoreWebView2, docs: Documents, answered: impl Fn(&str) + 'static, ready: impl FnOnce() + 'static) {
    use webview2_com::DevToolsProtocolEventReceivedEventHandler;
    // Als Absender kommt die WebView selbst mit – so hält der Handler keinen eigenen Verweis auf sie.
    let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |sender, args| {
        let (Some(core), Some(args)) = (sender, args) else { return Ok(()) };
        let mut raw = PWSTR::null();
        unsafe { args.ParameterObjectAsJson(&mut raw)? };
        let params: Value = serde_json::from_str(&webview2_com::take_pwstr(raw)).unwrap_or_default();
        answered(params["request"]["url"].as_str().unwrap_or_default());
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
    let url = without_fragment(p["request"]["url"].as_str().unwrap_or_default()).to_owned();
    if !is_pdf {
        // Dieselbe Adresse liefert jetzt eine gewöhnliche Seite: die darf nicht mehr als Viewer sprechen
        docs.0.viewers.borrow_mut().remove(&url);
        return call(core, "Fetch.continueRequest", json!({ "requestId": id }), |_| {});
    }
    let name = file_name(&disposition, &url);
    docs.0.viewers.borrow_mut().insert(url);
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
            "fonts" => Served::ok("application/json", Cow::Owned(fonts().list.to_string().into_bytes())),
            // Ergebnis von „Speichern unter“: 204, solange der Dialog noch offen ist
            _ if call.starts_with("saved/") => {
                let ticket = &call["saved/".len()..];
                SAVED.with(|s| {
                    let mut saved = s.borrow_mut();
                    match saved.get(ticket) {
                        Some((api, _)) if *api == docs.0.api => {
                            let (_, result) = saved.remove(ticket).unwrap();
                            Served::ok("application/json", Cow::Owned(result.to_string().into_bytes()))
                        }
                        Some(_) => Served::status(404),
                        None if SAVE_AS.with(|w| w.borrow().get(ticket).is_some_and(|(api, ..)| *api == docs.0.api)) => Served::status(204),
                        None => Served::status(404),
                    }
                })
            }
            // Nur Dateien aus der Liste der installierten Schriften
            _ => match call.strip_prefix("font/").and_then(|file| fonts().files.get(&percent_decode(file).to_lowercase()).cloned()) {
                Some(path) => match std::fs::read(path) {
                    Ok(bytes) => Served::ok("application/octet-stream", Cow::Owned(bytes)),
                    Err(_) => Served::status(404),
                },
                None => Served::status(404),
            },
        });
    }
    // Ein neues PDF aus dem Viewer
    if let Some(rest) = path.strip_prefix("new/") {
        let key = rest.split('/').next().unwrap_or_default();
        let found = NEW.with(|n| n.borrow().iter().find(|(k, ..)| k == key).map(|(_, name, b)| (name.clone(), b.clone())));
        let Some((name, bytes)) = found else { return Some(Served::status(404)) };
        let html = docs.viewer(&name, bytes, None);
        return Some(Served { status: 200, mime: "text/html; charset=utf-8", body: Cow::Owned(html.into_bytes()), csp: Some(viewer_csp()) });
    }
    // Eine Datei von der Festplatte: die Viewer-Seite dafür
    if let Some(rest) = path.strip_prefix("file/") {
        let key = rest.split('/').next().unwrap_or_default();
        let Some(file) = LOCAL.with(|l| l.borrow().get(key).cloned()) else { return Some(Served::status(404)) };
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let html = match std::fs::read(&file) {
            Ok(bytes) => docs.viewer(&name, bytes, Some(key)),
            Err(_) => format!("<!doctype html><meta charset=utf-8><title>{0}</title><p style=\"font:14px system-ui;color:#ccc\">{0} {1}</p>", escape_html(&name), crate::i18n::tr("lässt sich nicht lesen.", "cannot be read.")),
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
    /// „Speichern unter“ (Ticket): Glass zeigt den Dialog (main.rs), der Viewer holt das Ergebnis unter `saved/<Ticket>` ab.
    SaveAs(String),
    /// Ein neues PDF in einem neuen Tab zeigen (Adresse).
    OpenTab(String),
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
            SAVE_AS.with(|s| s.borrow_mut().insert(ticket.clone(), (docs.0.api.clone(), param("name"), body)));
            Post::SaveAs(ticket)
        }
        // Geschütztes PDF entschlüsseln (gleiches Format wie encrypt) – pdf-lib kann verschlüsselte PDFs nicht lesen
        "decrypt" => match decrypt(&body) {
            Ok(pdf) => Post::Reply(Served::ok("application/pdf", Cow::Owned(pdf))),
            Err(_) => reply(false),
        },
        // Neues PDF (etwa aus Bildern): in einem neuen Tab öffnen
        "open-new" => {
            if !body.starts_with(b"%PDF") {
                return Some(reply(false));
            }
            Post::OpenTab(new_document(&param("name"), body))
        }
        // Mit Passwort schützen: [Länge des Passworts, 4 Byte LE][Passwort UTF-8][PDF]
        "encrypt" => match encrypt(&body) {
            Ok(pdf) => Post::Reply(Served::ok("application/pdf", Cow::Owned(pdf))),
            Err(_) => reply(false),
        },
        _ => Post::Reply(Served::status(404)),
    })
}

/// „Speichern unter“ ausführen (`choose` zeigt den Dialog mit einem Namensvorschlag, `None` = abgebrochen).
/// Das Ergebnis holt der Viewer unter `api/<Geheimnis>/saved/<Ticket>` ab; es enthält den Schlüssel der neuen
/// Datei – künftiges Strg+S speichert dorthin.
pub fn finish_save_as(ticket: &str, choose: impl FnOnce(&str) -> Option<PathBuf>) {
    // Bis der Dialog zu ist, bleibt das Ticket in SAVE_AS (der Viewer bekommt so lange 204)
    let Some((api, name, bytes)) = SAVE_AS.with(|s| s.borrow().get(ticket).cloned()) else { return };
    let result = save_as_result(choose(&pdf_name(&name)), &bytes);
    SAVE_AS.with(|s| s.borrow_mut().remove(ticket));
    SAVED.with(|s| s.borrow_mut().insert(ticket.to_owned(), (api, result)));
}

/// Vorschlag für den Dateinamen: Den liefert die Website (Content-Disposition, Adresse) – also nur der Name ohne
/// Ordner, und immer als `.pdf`. Sonst schlüge der Dialog etwa „Rechnung.hta“ vor (eine PDF, die zugleich ein Programm ist).
fn pdf_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control() && !matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')).collect();
    let name = Path::new(name.trim()).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = Path::new(name.trim_end_matches([' ', '.'])).file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if stem.trim().is_empty() { "PDF-Dokument.pdf".to_owned() } else { format!("{}.pdf", stem.trim()) }
}

fn save_as_result(path: Option<PathBuf>, bytes: &[u8]) -> Value {
    let Some(path) = path else { return json!({ "ok": false, "cancelled": true }) };
    match write_atomic(&path, bytes) {
        Ok(()) => json!({
            "ok": true,
            "file": remember(&path),
            "name": path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            "path": path.to_string_lossy(),
        }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

/// Merkt sich ein neues PDF und gibt die Adresse, unter der ein Tab es zeigt.
fn new_document(name: &str, bytes: Vec<u8>) -> String {
    let name: String = name.trim().chars().filter(|c| !matches!(c, '/' | '\\' | '?' | '#')).take(120).collect();
    let name = if name.is_empty() { crate::i18n::tr("Neues PDF.pdf", "New PDF.pdf").to_owned() } else { name };
    let key = token();
    NEW.with(|n| {
        let mut docs = n.borrow_mut();
        while docs.len() >= NEW_KEPT {
            docs.pop_front();
        }
        docs.push_back((key.clone(), name.clone(), bytes));
    });
    format!("{HOST}new/{key}/{}", url_encode(&name))
}

// ---------- Installierte Schriften ----------

/// Schriften für „Text bearbeiten“: Liste für den Viewer (Familien mit ihren Schnitten) und erlaubte Dateien.
struct Fonts {
    list: Value,
    /// Dateiname (klein) → Pfad – nur diese Dateien gibt `font/<Datei>` heraus.
    files: HashMap<String, PathBuf>,
}

fn fonts() -> Rc<Fonts> {
    FONTS.with(|f| f.borrow_mut().get_or_insert_with(|| Rc::new(read_fonts())).clone())
}

/// TrueType- und OpenType-Schriften aus der Registry (für alle Benutzer und den eigenen), nach Familien geordnet.
fn read_fonts() -> Fonts {
    let windir = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let mut families: std::collections::BTreeMap<String, [Option<String>; 4]> = Default::default();
    let mut files = HashMap::new();
    for (name, file) in font_registry() {
        let path = PathBuf::from(&file);
        let path = if path.is_absolute() { path } else { windir.join("Fonts").join(path) };
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        // Sammlungen (.ttc) und Bitmap-Schriften kann pdf-lib nicht einbetten
        if ext != "ttf" && ext != "otf" {
            continue;
        }
        let Some((family, face)) = font_face(&name) else { continue };
        let Some(file_name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
        let slot = &mut families.entry(family).or_default()[face];
        if slot.is_none() {
            *slot = Some(file_name.clone());
            files.insert(file_name.to_lowercase(), path);
        }
    }
    let list = families
        .into_iter()
        .map(|(family, [regular, bold, italic, bold_italic])| {
            json!({ "family": family, "regular": regular, "bold": bold, "italic": italic, "boldItalic": bold_italic })
        })
        .collect();
    Fonts { list: Value::Array(list), files }
}

/// „Arial Bold Italic (TrueType)“ → („Arial“, 3): Familie und Schnitt (0 normal, 1 fett, 2 kursiv, 3 beides).
fn font_face(name: &str) -> Option<(String, usize)> {
    let name = name.split(" (").next()?.trim();
    // Mehrere Schriften in einem Eintrag („Cambria & Cambria Math“) passen zu keinem einzelnen Schnitt
    if name.is_empty() || name.contains(" & ") {
        return None;
    }
    for (suffix, face) in [(" Bold Italic", 3), (" Bold Oblique", 3), (" Italic", 2), (" Oblique", 2), (" Bold", 1)] {
        if let Some(family) = name.strip_suffix(suffix) {
            return Some((family.to_owned(), face));
        }
    }
    Some((name.to_owned(), 0))
}

/// Alle Einträge unter `…\Windows NT\CurrentVersion\Fonts` (Name, Datei).
fn font_registry() -> Vec<(String, String)> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, REG_SZ,
    };
    let key: Vec<u16> = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts".encode_utf16().chain([0]).collect();
    let mut out = Vec::new();
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let mut hkey: HKEY = std::ptr::null_mut();
        if unsafe { RegOpenKeyExW(root, key.as_ptr(), 0, KEY_READ, &mut hkey) } != 0 {
            continue;
        }
        for index in 0.. {
            let mut name = [0u16; 512];
            let mut name_len = name.len() as u32;
            let mut data = [0u16; 1024];
            let mut data_len = std::mem::size_of_val(&data) as u32;
            let mut kind = 0;
            let status = unsafe {
                RegEnumValueW(hkey, index, name.as_mut_ptr(), &mut name_len, std::ptr::null(), &mut kind, data.as_mut_ptr().cast(), &mut data_len)
            };
            if status == 259 {
                break; // ERROR_NO_MORE_ITEMS
            }
            if status != 0 || kind != REG_SZ {
                continue;
            }
            let chars = (data_len as usize / 2).min(data.len());
            let value = String::from_utf16_lossy(&data[..chars]).trim_end_matches('\0').to_owned();
            out.push((String::from_utf16_lossy(&name[..name_len as usize]), value));
        }
        unsafe { RegCloseKey(hkey) };
    }
    out
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
    let (password, pdf) = password_and_pdf(body)?;
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

/// `[Länge des Passworts, 4 Byte LE][Passwort UTF-8][PDF]` → Passwort und PDF.
fn password_and_pdf(body: &[u8]) -> Result<(&str, &[u8]), String> {
    let len = u32::from_le_bytes(body.get(..4).ok_or("kurz")?.try_into().map_err(|_| "kurz")?) as usize;
    let password = std::str::from_utf8(body.get(4..4 + len).ok_or("kurz")?).map_err(|e| e.to_string())?;
    Ok((password, body.get(4 + len..).ok_or("kurz")?))
}

/// Ein geschütztes PDF ohne Schutz (für die Bearbeitung im Viewer; beim Speichern schützt `encrypt` wieder).
fn decrypt(body: &[u8]) -> Result<Vec<u8>, String> {
    let (password, pdf) = password_and_pdf(body)?;
    let mut doc = lopdf::Document::load_mem_with_options(pdf, lopdf::LoadOptions::with_password(password)).map_err(|e| e.to_string())?;
    // Die Objekte sind beim Laden schon entschlüsselt – nur der Hinweis auf die Verschlüsselung muss weg
    if let Ok(id) = doc.trailer.get(b"Encrypt").and_then(lopdf::Object::as_reference) {
        doc.objects.remove(&id);
    }
    doc.trailer.remove(b"Encrypt");
    doc.encryption_state = None;
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
    crate::paths::data_dir().join("signatures.json")
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
    fn save_as_suggests_only_pdf_names() {
        assert_eq!(pdf_name("Rechnung.pdf"), "Rechnung.pdf");
        assert_eq!(pdf_name("Rechnung.hta"), "Rechnung.pdf");
        assert_eq!(pdf_name("Rechnung.pdf.exe. "), "Rechnung.pdf.pdf");
        assert_eq!(pdf_name(r"..\..\Autostart\x.bat"), "x.pdf");
        assert_eq!(pdf_name("Re\u{202E}fdp.exe"), "Refdp.pdf");
        assert_eq!(pdf_name(""), "PDF-Dokument.pdf");
    }

    #[test]
    fn save_as_result_only_for_the_tab_that_asked() {
        let (docs, other) = (Documents::default(), Documents::default());
        let Some(Post::SaveAs(ticket)) = post(&docs, &format!("{HOST}api/{}/save-as?name=a.pdf", docs.0.api), b"%PDF".to_vec()) else { panic!() };
        let poll = |d: &Documents| serve(d, &format!("{HOST}api/{}/saved/{ticket}", d.0.api), || None).unwrap();
        assert_eq!(poll(&docs).status, 204); // Dialog noch offen
        assert_eq!(poll(&other).status, 404);
        finish_save_as(&ticket, |_| None);
        assert_eq!(poll(&other).status, 404);
        let done = poll(&docs);
        assert_eq!(serde_json::from_slice::<Value>(&done.body).unwrap()["cancelled"], true);
        assert_eq!(poll(&docs).status, 404); // nur einmal abzuholen
    }

    #[test]
    fn only_viewer_documents_count_as_viewer() {
        let docs = Documents::default();
        assert!(docs.is_viewer(&format!("{HOST}file/abc/x.pdf")));
        assert!(!docs.is_viewer("https://evil.example/"));
        docs.0.viewers.borrow_mut().insert("https://a.de/x.pdf".into());
        assert!(docs.is_viewer("https://a.de/x.pdf#page=2"));
        assert!(!is_page(&format!("{HOST}doc/abc")) && is_page(&format!("{HOST}new/abc/x.pdf")));
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
    fn new_documents_open_in_a_tab() {
        let docs = Documents::default();
        let api = format!("{HOST}api/{}/", docs.0.api);
        let Some(Post::OpenTab(url)) = post(&docs, &format!("{api}open-new?name=Urlaub%20Fotos.pdf"), b"%PDF-1.7 neu".to_vec()) else { panic!() };
        assert!(url.starts_with(&format!("{HOST}new/")) && url.ends_with("/Urlaub%20Fotos.pdf"));
        assert_eq!(display_url(&url).as_deref(), Some("Urlaub Fotos.pdf"));
        // Neu laden zeigt es wieder
        for _ in 0..2 {
            let page = serve(&docs, &url, || None).unwrap();
            assert!(page.csp.is_some() && String::from_utf8_lossy(&page.body).contains("Urlaub Fotos.pdf"));
        }
        assert_eq!(post(&docs, &format!("{api}open-new?name=x.pdf"), b"<html>".to_vec()), Some(Post::Reply(Served::status(400))));
    }

    #[test]
    fn installed_fonts() {
        assert_eq!(font_face("Arial (TrueType)"), Some(("Arial".into(), 0)));
        assert_eq!(font_face("Arial Bold Italic (TrueType)"), Some(("Arial".into(), 3)));
        assert_eq!(font_face("Segoe UI Semibold (TrueType)"), Some(("Segoe UI Semibold".into(), 0)));
        assert_eq!(font_face("Times New Roman Italic (TrueType)"), Some(("Times New Roman".into(), 2)));
        assert_eq!(font_face("Cambria & Cambria Math (TrueType)"), None);
        let docs = Documents::default();
        let api = format!("{HOST}api/{}/", docs.0.api);
        let list = serve(&docs, &format!("{api}fonts"), || None).unwrap();
        let list: Value = serde_json::from_slice(&list.body).unwrap();
        let arial = list.as_array().unwrap().iter().find(|f| f["family"] == "Arial").expect("Arial ist installiert");
        let file = arial["regular"].as_str().unwrap();
        assert!(serve(&docs, &format!("{api}font/{file}"), || None).unwrap().body.len() > 10_000);
        // Nur Schriften aus der Liste
        assert_eq!(serve(&docs, &format!("{api}font/..%5C..%5Cwin.ini"), || None).unwrap().status, 404);
        assert_eq!(serve(&docs, &format!("{HOST}api/guess/font/{file}"), || None).unwrap().status, 404);
    }

    #[test]
    fn encrypts_with_aes256() {
        let pdf = b"%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >> endobj\ntrailer << /Root 1 0 R /Size 4 >>\n%%EOF";
        let mut body = 6u32.to_le_bytes().to_vec();
        body.extend_from_slice(b"geheim");
        body.extend_from_slice(pdf);
        let out = encrypt(&body).unwrap();
        assert!(String::from_utf8_lossy(&out).contains("/Encrypt"));
        assert!(lopdf::Document::load_mem_with_options(&out, lopdf::LoadOptions::with_password("geheim")).is_ok());
        // Und wieder ohne Schutz – für die Bearbeitung im Viewer
        let mut body = 6u32.to_le_bytes().to_vec();
        body.extend_from_slice(b"geheim");
        body.extend_from_slice(&out);
        let plain = decrypt(&body).unwrap();
        assert!(!String::from_utf8_lossy(&plain).contains("/Encrypt"));
        let doc = lopdf::Document::load_mem(&plain).unwrap();
        assert!(!doc.is_encrypted() && doc.get_pages().len() == 1);
        let mut wrong = 6u32.to_le_bytes().to_vec();
        wrong.extend_from_slice(b"falsch");
        wrong.extend_from_slice(&out);
        assert!(decrypt(&wrong).is_err());
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
