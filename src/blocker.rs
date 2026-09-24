//! Werbe- und Trackerblocker: die Filter-Engine von Brave (`adblock`) mit EasyList, EasyPrivacy,
//! EasyList Germany und den uBlock-Origin-Listen. Die Listen liegen im Datenordner und werden alle paar
//! Tage im Hintergrund erneuert; bis die Engine fertig ist, läuft alles ungefiltert.
//! Pro Website lässt sich der Blocker abschalten (Datei `adblock-aus.txt`).

use adblock::{lists::ParseOptions, request::Request, Engine, FilterSet};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, SystemTime};

/// Dateiname im Cache, Host und Pfad der Liste.
const LISTS: &[(&str, &str, &str)] = &[
    ("easylist.txt", "easylist.to", "/easylist/easylist.txt"),
    ("easyprivacy.txt", "easylist.to", "/easylist/easyprivacy.txt"),
    ("easylistgermany.txt", "easylist.to", "/easylistgermany/easylistgermany.txt"),
    ("ublock-filters.txt", "ublockorigin.github.io", "/uAssets/filters/filters.txt"),
    ("ublock-privacy.txt", "ublockorigin.github.io", "/uAssets/filters/privacy.txt"),
    // Ausnahmen, die von den anderen Listen kaputt gemachte Seiten reparieren
    ("ublock-unbreak.txt", "ublockorigin.github.io", "/uAssets/filters/unbreak.txt"),
];
const MAX_AGE: Duration = Duration::from_secs(4 * 24 * 3600);
const ALLOW_FILE: &str = "adblock-aus.txt";

struct State {
    dir: PathBuf,
    engine: RwLock<Option<Engine>>,
    /// Websites (ohne „www.“), auf denen nichts blockiert wird.
    allowed: RwLock<HashSet<String>>,
}

static STATE: OnceLock<State> = OnceLock::new();

/// Lädt Ausnahmen sofort und die Listen im Hintergrund.
pub fn init(data_dir: PathBuf) {
    let dir = data_dir.join("adblock");
    let _ = std::fs::create_dir_all(&dir);
    let allowed = std::fs::read_to_string(dir.join(ALLOW_FILE))
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect();
    let state = STATE.get_or_init(|| State { dir, engine: RwLock::new(None), allowed: RwLock::new(allowed) });

    std::thread::spawn(move || {
        // Erst mit dem, was schon da ist, loslegen – dann veraltete Listen nachladen und neu bauen.
        if let Some(engine) = build(&state.dir) {
            *state.engine.write().unwrap() = Some(engine);
        }
        if update(&state.dir) {
            if let Some(engine) = build(&state.dir) {
                *state.engine.write().unwrap() = Some(engine);
            }
        }
    });
}

/// Lädt fehlende oder veraltete Listen herunter. `true`, wenn sich etwas geändert hat.
fn update(dir: &std::path::Path) -> bool {
    let mut changed = false;
    for (file, host, path) in LISTS {
        let target = dir.join(file);
        let fresh = std::fs::metadata(&target)
            .and_then(|m| m.modified())
            .is_ok_and(|t| SystemTime::now().duration_since(t).unwrap_or_default() < MAX_AGE);
        if fresh {
            continue;
        }
        // Nur echte Filterlisten übernehmen – keine Fehlerseite, keine abgebrochene Übertragung.
        let Some(body) = crate::suggest::https_get(host, path) else { continue };
        let text = String::from_utf8_lossy(&body);
        if body.len() > 10_000 && (text.starts_with('!') || text.starts_with("[Adblock")) {
            changed |= std::fs::write(&target, &body).is_ok();
        }
    }
    changed
}

fn build(dir: &std::path::Path) -> Option<Engine> {
    let mut set = FilterSet::new(false);
    let mut any = false;
    for (file, ..) in LISTS {
        if let Ok(text) = std::fs::read_to_string(dir.join(file)) {
            set.add_filter_list(text, ParseOptions::default());
            any = true;
        }
    }
    any.then(|| Engine::new_with_filter_set(set))
}

fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    host.split(':').next().unwrap_or_default()
}

/// Schlüssel für die Ausnahmeliste: Hostname ohne „www.“.
pub fn site_of(url: &str) -> String {
    let host = host_of(url).to_ascii_lowercase();
    host.strip_prefix("www.").map(str::to_owned).unwrap_or(host)
}

/// Ist der Blocker für diese Seite abgeschaltet? (Gilt auch für alle Subdomains.)
pub fn is_allowed(url: &str) -> bool {
    let Some(state) = STATE.get() else { return false };
    let host = site_of(url);
    let allowed = state.allowed.read().unwrap();
    allowed.iter().any(|a| host == *a || host.ends_with(&format!(".{a}")))
}

/// Alle Seiten mit abgeschaltetem Blocker (für das Skript in den Webseiten).
pub fn allowed_sites() -> Vec<String> {
    STATE.get().map(|s| s.allowed.read().unwrap().iter().cloned().collect()).unwrap_or_default()
}

/// Blocker für die Seite von `url` an- bzw. ausschalten und speichern.
pub fn toggle(url: &str) {
    let Some(state) = STATE.get() else { return };
    let site = site_of(url);
    if site.is_empty() {
        return;
    }
    let mut allowed = state.allowed.write().unwrap();
    // Auch eine übergeordnete Ausnahme aufheben (z. B. „youtube.com“, wenn man auf „m.youtube.com“ ist).
    let before = allowed.len();
    allowed.retain(|a| !(site == *a || site.ends_with(&format!(".{a}"))));
    if allowed.len() == before {
        allowed.insert(site);
    }
    let mut list: Vec<_> = allowed.iter().cloned().collect();
    list.sort();
    let _ = std::fs::write(state.dir.join(ALLOW_FILE), list.join("\n"));
}

/// Soll die Anfrage `url` (Typ wie in ABP: script, image, xhr, sub_frame …) auf der Seite `source` fallen?
pub fn should_block(url: &str, source: &str, kind: &str) -> bool {
    let Some(state) = STATE.get() else { return false };
    if !url.starts_with("http") || is_allowed(source) {
        return false;
    }
    let engine = state.engine.read().unwrap();
    let Some(engine) = engine.as_ref() else { return false };
    Request::new(url, source, kind, "get").is_ok_and(|req| engine.check_network_request(&req).should_block())
}

/// CSS, das Werbeflächen auf `url` ausblendet. `first`: auch die seitenspezifischen Regeln (einmal pro Seite),
/// sonst nur die allgemeinen Regeln, die zu den gemeldeten Klassen und IDs passen.
pub fn hide_css(url: &str, classes: &[String], ids: &[String], first: bool) -> String {
    let Some(state) = STATE.get() else { return String::new() };
    if is_allowed(url) {
        return String::new();
    }
    let engine = state.engine.read().unwrap();
    let Some(engine) = engine.as_ref() else { return String::new() };
    let resources = engine.url_cosmetic_resources(url);
    let mut selectors: Vec<String> = if first { resources.hide_selectors.into_iter().collect() } else { Vec::new() };
    if !resources.generichide && !(classes.is_empty() && ids.is_empty()) {
        selectors.extend(engine.hidden_class_id_selectors(classes, ids, &resources.exceptions));
    }
    // Eine Regel pro Selektor: ein einziger ungültiger Selektor würde sonst die ganze Regel verwerfen.
    selectors.iter().map(|s| format!("{s}{{display:none!important}}\n")).collect()
}
