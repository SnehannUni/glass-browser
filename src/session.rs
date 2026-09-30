// Offene Tabs überstehen Neustart und Update: Glass schreibt sie bei jeder Änderung nach `GlassBrowser\session.json`
// und öffnet sie beim nächsten Start wieder. Geladen wird ein Tab erst, wenn man ihn anschaut.
// Private Tabs bleiben draußen – sie sollen mit dem Fenster verschwinden.

use serde_json::{json, Value};
use std::{cell::RefCell, path::{Path, PathBuf}};

/// Ein gemerkter Tab (auch für „Geschlossenen Tab wieder öffnen“).
#[derive(Clone, Default)]
pub struct Entry {
    pub url: String,
    pub title: String,
    pub favicon: String,
}

pub struct Session {
    file: PathBuf,
    /// Zuletzt geschriebener Stand – unverändert wird nicht erneut geschrieben.
    written: RefCell<String>,
}

impl Session {
    pub fn new(data_dir: &Path) -> Self {
        Session { file: data_dir.join("session.json"), written: RefCell::default() }
    }

    /// Tabs der letzten Sitzung und welcher davon aktiv war.
    pub fn load(&self) -> (Vec<Entry>, usize) {
        let text = std::fs::read_to_string(&self.file).unwrap_or_default();
        *self.written.borrow_mut() = text.clone();
        let v: Value = serde_json::from_str(&text).unwrap_or_default();
        let tabs: Vec<Entry> = v["tabs"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|t| {
                        let url = t["url"].as_str().filter(|u| !u.is_empty())?.to_owned();
                        let s = |k: &str| t[k].as_str().unwrap_or_default().to_owned();
                        Some(Entry { url, title: s("title"), favicon: s("favicon") })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let active = (v["active"].as_u64().unwrap_or_default() as usize).min(tabs.len().saturating_sub(1));
        (tabs, active)
    }

    pub fn save(&self, tabs: &[Entry], active: usize) {
        let list: Vec<Value> = tabs.iter().map(|t| json!({ "url": t.url, "title": t.title, "favicon": t.favicon })).collect();
        let text = json!({ "active": active, "tabs": list }).to_string();
        if *self.written.borrow() == text {
            return;
        }
        if std::fs::write(&self.file, &text).is_ok() {
            *self.written.borrow_mut() = text;
        }
    }
}
