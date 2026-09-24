//! Google-Suchvorschläge über WinHTTP – ohne zusätzliche HTTP-Bibliothek, die Anfrage läuft in einem
//! Hintergrund-Thread. Die Oberfläche fragt `http://glass.localhost/suggest?q=…` ab.

use std::borrow::Cow;
use std::sync::OnceLock;
use windows_sys::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpReadData, WinHttpReceiveResponse,
    WinHttpSendRequest, WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE,
};
use wry::http::{header::CONTENT_TYPE, Response};

const HOST: &str = "suggestqueries.google.com";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

/// Eine Sitzung für alle Anfragen, damit die TLS-Verbindung wiederverwendet wird.
fn session() -> *mut core::ffi::c_void {
    static SESSION: OnceLock<usize> = OnceLock::new();
    *SESSION.get_or_init(|| unsafe {
        let s = WinHttpOpen(
            wide("Glass").as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        );
        if !s.is_null() {
            WinHttpSetTimeouts(s, 2000, 2000, 2000, 3000);
        }
        s as usize
    }) as _
}

/// Einfacher HTTPS-GET (auch für die Filterlisten des Werbeblockers).
pub fn https_get(host: &str, path: &str) -> Option<Vec<u8>> {
    unsafe {
        let session = session();
        if session.is_null() {
            return None;
        }
        let connect = WinHttpConnect(session, wide(host).as_ptr(), 443, 0);
        if connect.is_null() {
            return None;
        }
        let request = WinHttpOpenRequest(
            connect,
            wide("GET").as_ptr(),
            wide(path).as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        );
        let mut body = Vec::new();
        let ok = !request.is_null()
            && WinHttpSendRequest(request, std::ptr::null(), 0, std::ptr::null(), 0, 0, 0) != 0
            && WinHttpReceiveResponse(request, std::ptr::null_mut()) != 0;
        if ok {
            let mut chunk = [0u8; 8192];
            loop {
                let mut read = 0u32;
                if WinHttpReadData(request, chunk.as_mut_ptr() as _, chunk.len() as u32, &mut read) == 0 || read == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..read as usize]);
            }
        }
        if !request.is_null() {
            WinHttpCloseHandle(request);
        }
        WinHttpCloseHandle(connect);
        ok.then_some(body)
    }
}

/// Vorschläge für einen (bereits URL-kodierten) Suchbegriff.
fn fetch(encoded_query: &str) -> Vec<String> {
    let path = format!("/complete/search?client=firefox&hl=de&ie=utf-8&oe=utf-8&q={encoded_query}");
    // Antwortformat: ["begriff", ["vorschlag 1", "vorschlag 2", …], …]
    https_get(HOST, &path)
        .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).ok())
        .and_then(|json| {
            json.get(1)?.as_array().map(|list| list.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
        })
        .unwrap_or_default()
}

/// Antwort für `/suggest?q=…` – wird im Hintergrund-Thread aufgerufen.
pub fn respond(query: Option<&str>) -> Response<Cow<'static, [u8]>> {
    let q = query
        .and_then(|query| query.split('&').find_map(|p| p.strip_prefix("q=")))
        .unwrap_or_default();
    // Nur URL-kodierte Zeichen durchreichen, damit niemand weitere Parameter anhängen kann.
    let safe = !q.is_empty() && q.bytes().all(|b| b.is_ascii_alphanumeric() || b"%-_.~+*'()!".contains(&b));
    let list = if safe { fetch(q) } else { Vec::new() };
    Response::builder()
        .header(CONTENT_TYPE, "application/json")
        .body(Cow::Owned(serde_json::to_vec(&list).unwrap_or_default()))
        .unwrap()
}
