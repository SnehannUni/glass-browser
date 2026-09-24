//! Updates über GitHub-Releases: Jeder Push auf `main` baut per GitHub Actions eine neue `Browser.exe`
//! und veröffentlicht sie als Release `build-<Nummer>`. Glass vergleicht diese Nummer mit der eigenen
//! (`GLASS_BUILD`, beim Bauen in der CI gesetzt) und bietet neuere Versionen im Update-Modal an.
//!
//! Austausch der laufenden Exe: Windows erlaubt, eine laufende Exe umzubenennen. Die alte wird zu
//! `Browser.old.exe`, die neue nimmt ihren Platz ein und startet – sie wartet, bis die alte beendet ist,
//! weil beide sonst gleichzeitig denselben WebView2-Datenordner öffnen würden.

use std::path::PathBuf;

const API_HOST: &str = "api.github.com";
const LATEST: &str = "/repos/SnehannUni/glass-browser/releases/latest";
/// Name der Exe im Release. (Früher `Glass.exe` – den Namen kennt Discord als Spiel und blendet sein Overlay ein.)
const ASSET: &str = "Browser.exe";

/// Nur explizit gekennzeichnete Main-Releases nehmen am Auto-Update teil.
/// Eine Build-Nummer allein (z. B. in einem lokalen Dev-Build) reicht nicht aus.
pub fn current_build() -> Option<u32> {
    release_build(option_env!("GLASS_RELEASE_REF"), option_env!("GLASS_BUILD"))
}

fn release_build(reference: Option<&str>, build: Option<&str>) -> Option<u32> {
    if reference != Some("refs/heads/main") { return None; }
    build.and_then(|b| b.parse().ok()).filter(|b| *b > 0)
}

pub struct Release {
    pub build: u32,
    pub notes: String,
    pub url: String,
}

/// Neueres Release als die laufende Version? (Blockiert – im Hintergrund-Thread aufrufen.)
pub fn check() -> Option<Release> {
    let current = current_build()?;
    let body = crate::suggest::https_get(API_HOST, LATEST)?;
    let json: serde_json::Value = serde_json::from_slice(&body).ok()?;
    let build = json["tag_name"].as_str()?.strip_prefix("build-")?.parse().ok()?;
    if build <= current {
        return None;
    }
    let url = json["assets"].as_array()?.iter().find(|a| a["name"] == ASSET)?["browser_download_url"].as_str()?.to_owned();
    let notes = json["body"].as_str().unwrap_or_default().trim().to_owned();
    Some(Release { build, notes, url })
}

fn paths() -> std::io::Result<(PathBuf, PathBuf, PathBuf)> {
    let exe = std::env::current_exe()?;
    Ok((exe.clone(), exe.with_extension("old.exe"), exe.with_extension("new.exe")))
}

/// Neue Exe laden, prüfen, an die Stelle der laufenden setzen und starten.
/// Danach muss sich Glass beenden (die neue Instanz wartet darauf).
pub fn install(url: &str) -> Result<(), String> {
    if current_build().is_none() { return Err("Auto-Updates sind in Entwickler-Builds deaktiviert.".into()); }
    let rest = url.strip_prefix("https://").ok_or("Ungültige Download-Adresse")?;
    let (host, path) = rest.split_once('/').ok_or("Ungültige Download-Adresse")?;
    // GitHub leitet auf seinen Datei-Server um; WinHTTP folgt der Umleitung selbst.
    let bytes = crate::suggest::https_get(host, &format!("/{path}")).ok_or("Download fehlgeschlagen")?;
    if bytes.len() < 1_000_000 || !bytes.starts_with(b"MZ") {
        return Err("Die heruntergeladene Datei ist keine gültige Browser.exe".into());
    }
    let (exe, old, new) = paths().map_err(|e| e.to_string())?;
    std::fs::write(&new, &bytes).map_err(|e| format!("Konnte das Update nicht speichern: {e}"))?;
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|e| format!("Konnte Glass nicht ersetzen: {e}"))?;
    if let Err(e) = std::fs::rename(&new, &exe) {
        let _ = std::fs::rename(&old, &exe); // alte Version wiederherstellen
        return Err(format!("Konnte Glass nicht ersetzen: {e}"));
    }
    std::process::Command::new(&exe)
        .arg("--wait-pid")
        .arg(std::process::id().to_string())
        .spawn()
        .map_err(|e| format!("Konnte die neue Version nicht starten: {e}"))?;
    Ok(())
}

/// Beim Start: auf die alte Instanz warten (nach einem Update) und ihre Exe wegräumen.
/// Gibt die übrigen Argumente zurück (Adressen zum Öffnen).
pub fn startup(args: Vec<String>) -> Vec<String> {
    let mut rest = Vec::new();
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        if arg == "--wait-pid" {
            if let Some(pid) = it.next().and_then(|p| p.parse().ok()) {
                wait_for(pid);
            }
        } else {
            rest.push(arg);
        }
    }
    if let Ok((_, old, _)) = paths() {
        let _ = std::fs::remove_file(old);
    }
    rest
}

fn wait_for(pid: u32) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !handle.is_null() {
            WaitForSingleObject(handle, 15_000);
            CloseHandle(handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::release_build;

    #[test]
    fn only_main_releases_with_valid_build_numbers_receive_updates() {
        assert_eq!(release_build(Some("refs/heads/main"), Some("42")), Some(42));
        for reference in [None, Some("refs/heads/feature"), Some("refs/pull/1/merge"), Some("refs/tags/build-42")] {
            assert_eq!(release_build(reference, Some("42")), None);
        }
        for build in [None, Some(""), Some("invalid"), Some("0")] {
            assert_eq!(release_build(Some("refs/heads/main"), build), None);
        }
    }
}
