// Verlauf der besuchten Seiten: jede fertig geladene Seite aus einem normalen Tab (private nie). Liegt in
// `GlassBrowser\history.json`; das Adressfeld schlägt daraus Seiten vor, Strg+H zeigt die Liste.
// Die Oberfläche fragt über `http://glass.localhost/history?q=…` – deshalb teilen Tabs und Protokoll den Speicher.

use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
};

/// So viele Seiten merkt sich Glass (je Adresse ein Eintrag).
const KEEP: usize = 3000;

struct Visit {
    url: String,
    title: String,
    /// Letzter Besuch, ms seit 1970.
    time: u64,
    count: u32,
}

pub struct History {
    visits: Vec<Visit>,
    /// Geschrieben wird im Hintergrund, immer nur der neueste Stand.
    writer: mpsc::Sender<String>,
}

pub type Shared = Arc<Mutex<History>>;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Adresse ohne Sprungmarke – `seite#a` und `seite#b` sind derselbe Besuch.
fn key(url: &str) -> &str {
    url.split('#').next().unwrap_or(url)
}

fn host(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |r| r.1);
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    host.strip_prefix("www.").unwrap_or(host)
}

impl History {
    pub fn load(data_dir: &Path) -> Shared {
        let file: PathBuf = data_dir.join("history.json");
        let saved: Vec<Value> = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let visits = saved
            .iter()
            .filter_map(|v| {
                Some(Visit {
                    url: v["url"].as_str()?.to_owned(),
                    title: v["title"].as_str().unwrap_or_default().to_owned(),
                    time: v["time"].as_u64().unwrap_or_default(),
                    count: v["count"].as_u64().unwrap_or(1) as u32,
                })
            })
            .collect();
        let (writer, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            while let Ok(mut text) = rx.recv() {
                while let Ok(newer) = rx.try_recv() {
                    text = newer;
                }
                let _ = std::fs::write(&file, text);
            }
        });
        Arc::new(Mutex::new(History { visits, writer }))
    }

    fn save(&self) {
        let list: Vec<Value> = self.visits.iter().map(|v| json!({ "url": v.url, "title": v.title, "time": v.time, "count": v.count })).collect();
        let _ = self.writer.send(Value::Array(list).to_string());
    }

    /// Seite fertig geladen.
    pub fn visit(&mut self, url: &str, title: &str) {
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return;
        }
        let url = key(url);
        let (count, old_title) = match self.visits.iter().position(|v| v.url == url) {
            Some(i) => {
                let v = self.visits.remove(i);
                (v.count + 1, v.title)
            }
            None => (0, String::new()),
        };
        let title = if title.is_empty() { old_title } else { title.to_owned() };
        self.visits.insert(0, Visit { url: url.to_owned(), title, time: now_ms(), count: count.max(1) });
        self.visits.truncate(KEEP);
        self.save();
    }

    /// Titel kommt oft erst nach dem Laden.
    pub fn title(&mut self, url: &str, title: &str) {
        let url = key(url);
        if let Some(v) = self.visits.iter_mut().find(|v| v.url == url).filter(|v| v.title != title && !title.is_empty()) {
            v.title = title.to_owned();
            self.save();
        }
    }

    pub fn remove(&mut self, url: &str) {
        self.visits.retain(|v| v.url != url);
        self.save();
    }

    pub fn clear(&mut self) {
        self.visits.clear();
        self.save();
    }

    /// Antwort auf `/history?q=…&limit=…`. Ohne Suchtext: die letzten Besuche (für die Liste).
    /// Mit Suchtext: Seiten, deren Adresse oder Titel alle Wörter enthält – am besten zuerst: Treffer am Anfang
    /// des Hostnamens, dann oft und kürzlich Besuchtes.
    pub fn query(&self, q: &str, limit: usize) -> Value {
        let words: Vec<String> = q.to_lowercase().split_whitespace().map(str::to_owned).collect();
        let now = now_ms();
        let mut hits: Vec<(f64, &Visit)> = self
            .visits
            .iter()
            .filter_map(|v| {
                if words.is_empty() {
                    return Some((0.0, v));
                }
                let (url, title) = (v.url.to_lowercase(), v.title.to_lowercase());
                let bare = url.split_once("://").map_or(url.as_str(), |r| r.1).trim_start_matches("www.");
                if !words.iter().all(|w| bare.contains(w.as_str()) || title.contains(w.as_str())) {
                    return None;
                }
                let first = &words[0];
                let mut score = (v.count as f64).ln_1p();
                if host(&v.url).starts_with(first.as_str()) {
                    score += 6.0;
                } else if bare.starts_with(first.as_str()) || title.split_whitespace().any(|t| t.starts_with(first.as_str())) {
                    score += 3.0;
                }
                // Startseiten vor Unterseiten derselben Website
                score -= bare.trim_end_matches('/').matches('/').count() as f64 * 0.4;
                let days = (now.saturating_sub(v.time)) as f64 / 86_400_000.0;
                score -= (days + 1.0).ln() * 0.8;
                Some((score, v))
            })
            .collect();
        if !words.is_empty() {
            hits.sort_by(|a, b| b.0.total_cmp(&a.0));
        }
        Value::Array(hits.iter().take(limit).map(|(_, v)| json!({ "url": v.url, "title": v.title, "time": v.time })).collect())
    }
}

/// Anfrage der Oberfläche beantworten (`q` und `limit` aus der Adresse).
pub fn respond(history: &Shared, query: Option<&str>) -> wry::http::Response<std::borrow::Cow<'static, [u8]>> {
    let mut q = String::new();
    let mut limit = 8;
    for pair in query.unwrap_or_default().split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "q" => q = decode(v),
            "limit" => limit = v.parse().unwrap_or(8).min(KEEP),
            _ => {}
        }
    }
    let body = history.lock().map(|h| h.query(&q, limit).to_string()).unwrap_or_else(|_| "[]".into());
    wry::http::Response::builder()
        .header(wry::http::header::CONTENT_TYPE, "application/json")
        .body(std::borrow::Cow::Owned(body.into_bytes()))
        .unwrap()
}

/// `%XX` und `+` aus der Adresse zurückwandeln.
fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = |b: u8| (b as char).to_digit(16);
                match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                    (Some(h), Some(l)) => { out.push((h * 16 + l) as u8); i += 2; }
                    _ => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
