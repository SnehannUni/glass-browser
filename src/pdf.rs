//! Eigener PDF-Viewer statt des Edge-Viewers von WebView2.
//!
//! Jeder Tab lässt über die DevTools-Schnittstelle (`Fetch`) jede Dokument-Antwort kurz anhalten. Ist es ein PDF,
//! holt Glass die schon geladenen Bytes ab und antwortet stattdessen mit dem Viewer (viewer.html). Adresse, Verlauf
//! und Neu laden bleiben so die der PDF-Datei, und Cookies oder Logins spielen keine Rolle – nichts wird doppelt geladen.
//!
//! Der Viewer holt PDF.js und die Datei von `http://glass-pdf.localhost/`; diese Anfragen beantwortet
//! `watch_requests` in main.rs mit `serve`, sie gehen nie ins Netz.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::{borrow::Cow, cell::RefCell, collections::VecDeque, rc::Rc};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use windows::core::{HSTRING, PWSTR};

const HOST: &str = "http://glass-pdf.localhost/";
const VIEWER_HTML: &str = include_str!("pdf/viewer.html");
/// PDF.js aus src/pdf/vendor, Tabelle von build.rs.
const VENDOR: &[(&str, &[u8])] = include!(concat!(env!("OUT_DIR"), "/pdf_assets.rs"));
/// So viele PDFs hält ein Tab höchstens bereit, die sein Viewer noch nicht abgeholt hat.
const PENDING: usize = 2;

/// Was der Viewer eines Tabs von Glass abholt: PDFs (Schlüssel, Bytes; jedes genau einmal) und das Wallpaper.
#[derive(Clone)]
pub struct Documents(Rc<Inner>);

struct Inner {
    pending: RefCell<VecDeque<(String, Vec<u8>)>>,
    /// Geheime Adresse des Wallpapers für diesen Tab – andere Seiten sollen das Hintergrundbild nicht abrufen können.
    wall: String,
}

impl Default for Documents {
    fn default() -> Self {
        Self(Rc::new(Inner { pending: RefCell::default(), wall: token() }))
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
        let html = VIEWER_HTML
            .replace("{{TITLE}}", &escape_html(&name))
            .replace("{{DOC}}", &format!("{HOST}doc/{}", docs.add(bytes)))
            .replace("{{WALL}}", &format!("{HOST}wallpaper/{}", docs.0.wall));
        let fulfill = json!({
            "requestId": id,
            "responseCode": 200,
            "responseHeaders": [
                { "name": "Content-Type", "value": "text/html; charset=utf-8" },
                // Der Viewer läuft im Origin der PDF-Seite: Skripte nur von Glass, nichts Eingebettetes aus dem PDF.
                // wasm-unsafe-eval für die Bild-Decoder (JPEG 2000, JBIG2), blob: für den Worker von PDF.js.
                { "name": "Content-Security-Policy", "value": format!(
                    "default-src 'none'; script-src {HOST} blob: 'wasm-unsafe-eval'; worker-src {HOST} blob:; \
                     connect-src {HOST}; style-src {HOST} 'unsafe-inline'; img-src {HOST} blob: data:; \
                     font-src {HOST} blob: data:; base-uri 'none'; form-action 'none'") },
            ],
            "body": B64.encode(html),
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

/// Antwort auf eine Anfrage an `http://glass-pdf.localhost/…` (Status, MIME-Typ, Inhalt) – `None` für alle anderen Adressen.
/// `wallpaper` liest das Desktop-Hintergrundbild (nur für die geheime Adresse des Tabs).
pub fn serve(docs: &Documents, uri: &str, wallpaper: impl FnOnce() -> Option<Vec<u8>>) -> Option<(u16, &'static str, Cow<'static, [u8]>)> {
    let path = uri.strip_prefix(HOST)?.split(['?', '#']).next().unwrap_or_default();
    let wall = path.strip_prefix("wallpaper/").is_some_and(|key| key == docs.0.wall);
    let body: Option<Cow<'static, [u8]>> = match path {
        "viewer.mjs" => Some(Cow::Borrowed(include_bytes!("pdf/viewer.mjs"))),
        "viewer.css" => Some(Cow::Borrowed(include_bytes!("pdf/viewer.css"))),
        // Dieselben Glas-Bausteine wie die Oberfläche (ui.html)
        "glass-lens.js" => Some(Cow::Borrowed(include_bytes!("glass-lens.js"))),
        "glass-rim.js" => Some(Cow::Borrowed(include_bytes!("glass-rim.js"))),
        "group-hover.js" => Some(Cow::Borrowed(include_bytes!("group-hover.js"))),
        _ if wall => wallpaper().map(Cow::Owned),
        _ => match path.strip_prefix("doc/") {
            Some(key) => docs.take(key).map(Cow::Owned),
            None => VENDOR.iter().find(|(p, _)| *p == path).map(|(_, bytes)| Cow::Borrowed(*bytes)),
        },
    };
    let mime = match path.rsplit('.').next().unwrap_or_default() {
        _ if wall => match &body { Some(b) if b.starts_with(b"\x89PNG") => "image/png", _ => "image/jpeg" },
        _ if path.starts_with("doc/") => "application/pdf",
        "mjs" | "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    Some(match body {
        Some(body) => (200, mime, body),
        None => (404, "text/plain", Cow::Borrowed(b"")),
    })
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
        assert_eq!(serve(&docs, &uri, none).unwrap().0, 200);
        assert_eq!(serve(&docs, &uri, none).unwrap().0, 404);
        assert_eq!(serve(&docs, "https://example.com/", none), None);
        assert_eq!(serve(&docs, &format!("{HOST}pdf.min.mjs"), none).unwrap().0, 200);
    }

    #[test]
    fn wallpaper_only_with_the_tabs_key() {
        let docs = Documents::default();
        let wall = || Some(b"\x89PNG".to_vec());
        assert_eq!(serve(&docs, &format!("{HOST}wallpaper/{}", docs.0.wall), wall).unwrap().1, "image/png");
        assert_eq!(serve(&docs, &format!("{HOST}wallpaper/guess"), wall).unwrap().0, 404);
        assert_eq!(serve(&Documents::default(), &format!("{HOST}wallpaper/{}", docs.0.wall), wall).unwrap().0, 404);
    }
}
