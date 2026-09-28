// Auf Webseiten zeichnen: Der Stift in der Leiste schaltet drawing-content.js in der Seite ein. Die Striche einer
// Seite (Adresse ohne #…) liegen als JSON in `GlassBrowser\drawings` und erscheinen beim nächsten Besuch wieder.
// Private Tabs speichern nichts – dort verschwinden die Striche mit der Seite.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Größere Zeichnungen nimmt Glass nicht an (eine Seite voller Striche braucht nur einen Bruchteil davon).
const MAX_BYTES: usize = 4 * 1024 * 1024;

/// Schlüssel einer Seite: Adresse ohne Sprungmarke. Nur http(s) – andere Seiten zeichnen, speichern aber nicht.
fn page_key(url: &str) -> Option<&str> {
    let key = url.split('#').next()?;
    (key.starts_with("https://") || key.starts_with("http://")).then_some(key)
}

fn origin(url: &str) -> Option<&str> {
    let rest = url.split_once("://")?.1;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some(&url[..url.len() - rest.len() + end])
}

/// FNV-1a: stabil über Programmversionen hinweg (anders als `DefaultHasher`), also taugt es als Dateiname.
fn file_for(dir: &Path, key: &str) -> PathBuf {
    let hash = key.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    dir.join(format!("{hash:016x}.json"))
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(data_dir: &Path) -> Self {
        Store { dir: data_dir.join("drawings") }
    }

    /// Nachricht aus drawing-content.js. `source`: Dokument, das sie geschickt hat (von WebView2, nicht fälschbar).
    /// Die Seite nennt selbst, für welche Adresse sie speichert (nach pushState kann `source` hinterherhinken),
    /// darf aber nur Adressen ihres eigenen Ursprungs anfassen. Antwort: Skript für die Seite.
    pub fn handle(&self, source: &str, msg: &Value, private: bool) -> Option<String> {
        let url = msg["url"].as_str()?;
        let key = page_key(url).filter(|k| origin(k).is_some() && origin(k) == origin(source))?;
        match msg["draw"].as_str()? {
            "load" => {
                let strokes = if private { None } else { self.load(key) };
                let reply = json!({ "url": key, "strokes": strokes.unwrap_or_else(|| json!([])) });
                Some(format!("window.__glassDrawLoad?.({reply})"))
            }
            "save" if !private => {
                self.save(key, &msg["strokes"]);
                None
            }
            _ => None,
        }
    }

    fn load(&self, key: &str) -> Option<Value> {
        let text = std::fs::read_to_string(file_for(&self.dir, key)).ok()?;
        let file: Value = serde_json::from_str(&text).ok()?;
        // Zwei Adressen mit gleichem Hash: die Datei gehört der anderen
        (file["url"].as_str() == Some(key)).then(|| file["strokes"].clone()).filter(Value::is_array)
    }

    fn save(&self, key: &str, strokes: &Value) {
        let path = file_for(&self.dir, key);
        let Some(list) = strokes.as_array() else { return };
        if list.is_empty() {
            let _ = std::fs::remove_file(path);
            return;
        }
        let text = json!({ "url": key, "strokes": strokes }).to_string();
        if text.len() > MAX_BYTES {
            return;
        }
        let _ = std::fs::create_dir_all(&self.dir);
        // Erst in eine Nebendatei, dann umbenennen: Ein Absturz mittendrin hinterlässt keine halbe Zeichnung
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_origins() {
        assert_eq!(page_key("https://a.de/x?y=1#z"), Some("https://a.de/x?y=1"));
        assert_eq!(page_key("about:blank"), None);
        assert_eq!(origin("https://a.de/x?y"), Some("https://a.de"));
        assert_eq!(origin("https://a.de?y"), Some("https://a.de"));
        assert_eq!(origin("https://a.de"), Some("https://a.de"));
    }

    #[test]
    fn only_own_origin() {
        let dir = std::env::temp_dir().join(format!("glass-draw-test-{}", std::process::id()));
        let store = Store::new(&dir);
        let strokes = json!([{ "t": "pen", "c": "#ff3b30", "w": 3, "p": [1, 2, 3, 4] }]);
        let save = json!({ "draw": "save", "url": "https://a.de/seite#oben", "strokes": strokes });
        // Fremder Ursprung darf nicht speichern
        store.handle("https://b.de/", &save, false);
        assert_eq!(store.load("https://a.de/seite"), None);
        store.handle("https://a.de/anders", &save, false);
        assert_eq!(store.load("https://a.de/seite"), Some(strokes.clone()));
        // Privat: nichts laden
        let load = json!({ "draw": "load", "url": "https://a.de/seite" });
        assert!(store.handle("https://a.de/seite", &load, true).unwrap().contains("\"strokes\":[]"));
        assert!(store.handle("https://a.de/seite", &load, false).unwrap().contains("ff3b30"));
        // Leer speichern löscht die Datei
        store.handle("https://a.de/seite", &json!({ "draw": "save", "url": "https://a.de/seite", "strokes": [] }), false);
        assert_eq!(store.load("https://a.de/seite"), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
