// Einstellungen je Website: Zoom (je Hostname, wie in Chrome) und die Antworten auf Berechtigungsanfragen
// (je Ursprung und Art, z. B. „https://meet.google.com“ + „camera“). Liegt in `GlassBrowser\sites.json`.
// Private Tabs lesen mit, schreiben aber nichts.

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub struct Sites {
    file: PathBuf,
    data: Value,
}

/// Hostname ohne „www.“ – so teilen sich www.spiegel.de und spiegel.de einen Zoom.
pub fn host(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |r| r.1);
    let host = rest.split(['/', '?', '#', ':']).next().unwrap_or_default();
    host.strip_prefix("www.").unwrap_or(host).to_ascii_lowercase()
}

/// Schema und Host (mit Port) einer Adresse.
pub fn origin(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return String::new() };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    format!("{scheme}://{host}").to_ascii_lowercase()
}

impl Sites {
    pub fn load(data_dir: &Path) -> Self {
        let file = data_dir.join("sites.json");
        let data = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
        Sites { file, data }
    }

    fn save(&self) {
        let _ = std::fs::write(&self.file, self.data.to_string());
    }

    fn section(&mut self, name: &str) -> &mut Map<String, Value> {
        if !self.data[name].is_object() {
            self.data[name] = json!({});
        }
        self.data[name].as_object_mut().unwrap()
    }

    /// Gemerkter Zoom der Website (1.0, wenn nie geändert).
    pub fn zoom(&self, url: &str) -> f64 {
        self.data["zoom"][host(url)].as_f64().unwrap_or(1.0)
    }

    pub fn set_zoom(&mut self, url: &str, factor: f64) {
        let host = host(url);
        if host.is_empty() || (self.zoom(url) - factor).abs() < 0.001 {
            return;
        }
        let zoom = self.section("zoom");
        if (factor - 1.0).abs() < 0.001 {
            zoom.remove(&host);
        } else {
            zoom.insert(host, json!(factor));
        }
        self.save();
    }

    /// Gespeicherte Antwort: Some(true) erlaubt, Some(false) blockiert, None noch nie gefragt.
    pub fn permission(&self, url: &str, kind: &str) -> Option<bool> {
        self.data["permissions"][origin(url)][kind].as_bool()
    }

    /// `None` vergisst die Antwort (beim nächsten Mal wird wieder gefragt).
    pub fn set_permission(&mut self, url: &str, kind: &str, allow: Option<bool>) {
        let origin = origin(url);
        let all = self.section("permissions");
        let site = all.entry(origin.clone()).or_insert_with(|| json!({}));
        match (site.as_object_mut(), allow) {
            (Some(site), Some(allow)) => { site.insert(kind.to_owned(), json!(allow)); }
            (Some(site), None) => { site.remove(kind); }
            (None, _) => {}
        }
        if all.get(&origin).and_then(Value::as_object).is_some_and(|s| s.is_empty()) {
            all.remove(&origin);
        }
        self.save();
    }

    /// Alle Antworten einer Website (für die Seiteninfo) oder aller Websites (für die Einstellungen).
    pub fn permissions(&self, url: Option<&str>) -> Value {
        let all = self.data["permissions"].as_object().cloned().unwrap_or_default();
        let list: Vec<Value> = all
            .iter()
            .filter(|(o, _)| url.map_or(true, |u| **o == origin(u)))
            .flat_map(|(o, kinds)| {
                kinds.as_object().into_iter().flatten().map(move |(k, v)| json!({ "origin": o, "kind": k, "allow": v }))
            })
            .collect();
        Value::Array(list)
    }

    pub fn clear_permissions(&mut self) {
        self.data["permissions"] = json!({});
        self.save();
    }
}
