//! Updates über GitHub-Releases: Jeder Push auf `main` baut per GitHub Actions eine neue `Browser.exe`
//! und veröffentlicht sie als Release `build-<Nummer>`. Glass vergleicht diese Nummer mit der eigenen
//! (`GLASS_BUILD`, beim Bauen in der CI gesetzt) und bietet neuere Versionen im Update-Modal an.
//! Installiert wird nur eine Exe mit gültiger Signatur (`signature.rs`).
//!
//! Austausch der laufenden Exe: Windows erlaubt, eine laufende Exe umzubenennen. Die alte wird zu
//! `Browser.old.exe`, die neue nimmt ihren Platz ein und startet – sie wartet, bis die alte beendet ist,
//! weil beide sonst gleichzeitig denselben WebView2-Datenordner öffnen würden.

use crate::i18n::tr;
use std::path::PathBuf;

const API_HOST: &str = "api.github.com";
const LATEST: &str = "/repos/SnehannUni/glass-browser/releases/latest";
/// Name der Exe im Release. (Früher `Glass.exe` – den Namen kennt Discord als Spiel und blendet sein Overlay ein.)
const ASSET: &str = "Browser.exe";
/// Ed25519-Signatur der Exe (Base64, siehe `signature.rs`). Releases ohne sie werden nicht angeboten.
const SIGNATURE_ASSET: &str = "Browser.exe.sig";

/// Nur explizit gekennzeichnete Main-Releases nehmen am Auto-Update teil.
/// Eine Build-Nummer allein (z. B. in einem lokalen Dev-Build) reicht nicht aus.
/// Die Store-Version aktualisiert der Microsoft Store – ihr Paketordner ist ohnehin schreibgeschützt.
pub fn current_build() -> Option<u32> {
    if cfg!(feature = "store") { return None; }
    release_build(option_env!("GLASS_RELEASE_REF"), option_env!("GLASS_BUILD"))
}

fn release_build(reference: Option<&str>, build: Option<&str>) -> Option<u32> {
    if reference != Some("refs/heads/main") { return None; }
    build.and_then(|b| b.parse().ok()).filter(|b| *b > 0)
}

#[derive(Clone)]
pub struct Release {
    pub build: u32,
    pub notes: String,
    pub url: String,
    pub signature_url: String,
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
    let asset = |name: &str| -> Option<String> {
        Some(json["assets"].as_array()?.iter().find(|a| a["name"] == name)?["browser_download_url"].as_str()?.to_owned())
    };
    let (url, signature_url) = (asset(ASSET)?, asset(SIGNATURE_ASSET)?);
    let notes = json["body"].as_str().unwrap_or_default().trim().to_owned();
    Some(Release { build, notes, url, signature_url })
}

fn paths() -> std::io::Result<(PathBuf, PathBuf, PathBuf)> {
    let exe = std::env::current_exe()?;
    Ok((exe.clone(), exe.with_extension("old.exe"), exe.with_extension("new.exe")))
}

/// Datei aus einem Release laden (GitHub leitet auf seinen Datei-Server um; WinHTTP folgt der Umleitung selbst).
fn download(url: &str) -> Result<Vec<u8>, String> {
    let rest = url.strip_prefix("https://github.com/").ok_or("Ungültige Download-Adresse")?;
    crate::suggest::https_get("github.com", &format!("/{rest}")).ok_or_else(|| tr("Download fehlgeschlagen", "Download failed").into())
}

/// Stammt die Exe von uns und gehört sie zu genau diesem Build? (Siehe `signature.rs`.)
fn verify(build: u32, exe: &[u8], signature: &[u8]) -> bool {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let key = STANDARD.decode(crate::signature::PUBLIC_KEY).ok().and_then(|k| <[u8; 32]>::try_from(k).ok());
    let sig = STANDARD.decode(signature.trim_ascii()).ok().and_then(|s| <[u8; 64]>::try_from(s).ok());
    let (Some(key), Some(sig)) = (key, sig) else { return false };
    let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&key) else { return false };
    key.verify_strict(&crate::signature::message(build, exe), &ed25519_dalek::Signature::from_bytes(&sig)).is_ok()
}

/// Neue Exe laden, Signatur prüfen, an die Stelle der laufenden setzen und starten.
/// Danach muss sich Glass beenden (die neue Instanz wartet darauf).
pub fn install(release: &Release) -> Result<(), String> {
    if current_build().is_none() { return Err(tr("Auto-Updates sind in Entwickler-Builds deaktiviert.", "Auto-updates are disabled in developer builds.").into()); }
    let signature = download(&release.signature_url)?;
    let bytes = download(&release.url)?;
    if bytes.len() < 1_000_000 || !bytes.starts_with(b"MZ") {
        return Err(tr("Die heruntergeladene Datei ist keine gültige Browser.exe", "The downloaded file is not a valid Browser.exe").into());
    }
    if !verify(release.build, &bytes, &signature) {
        return Err(tr("Die Signatur des Updates stimmt nicht – es wird nicht installiert.", "The update's signature does not match – it will not be installed.").into());
    }
    let (exe, old, new) = paths().map_err(|e| e.to_string())?;
    std::fs::write(&new, &bytes).map_err(|e| format!("{}: {e}", tr("Konnte das Update nicht speichern", "Could not save the update")))?;
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|e| format!("{}: {e}", tr("Konnte den Browser nicht ersetzen", "Could not replace the browser")))?;
    if let Err(e) = std::fs::rename(&new, &exe) {
        let _ = std::fs::rename(&old, &exe); // alte Version wiederherstellen
        return Err(format!("{}: {e}", tr("Konnte den Browser nicht ersetzen", "Could not replace the browser")));
    }
    std::process::Command::new(&exe)
        .arg("--wait-pid")
        .arg(std::process::id().to_string())
        .spawn()
        .map_err(|e| format!("{}: {e}", tr("Konnte die neue Version nicht starten", "Could not start the new version")))?;
    Ok(())
}

/// Beim Start: auf die alte Instanz warten (nach einem Update) und ihre Exe wegräumen.
/// Gibt die übrigen Argumente zurück (Adressen zum Öffnen).
pub fn startup(args: Vec<String>) -> Vec<String> {
    let mut rest = Vec::new();
    let mut updated = false;
    let mut it = args.into_iter().enumerate();
    while let Some((i, arg)) = it.next() {
        // Nur so, wie `install` die neue Version startet: als erstes Argument
        if i == 0 && arg == "--wait-pid" {
            updated = true;
            if let Some(pid) = it.next().and_then(|(_, p)| p.parse().ok()) {
                wait_for(pid);
            }
        } else {
            rest.push(arg);
        }
    }
    if cfg!(feature = "store") { return rest; }
    if let Ok((exe, old, _)) = paths() {
        let _ = std::fs::remove_file(old);
        if updated { std::thread::spawn(move || refresh_shell_icons(&exe)); }
    }
    rest
}

/// Die Exe wurde am selben Pfad ausgetauscht. Windows merkt sich Icons pro Pfad und Icon-Index und liest
/// sie dann nicht neu – Desktop, Startmenü und Taskleiste zeigen sonst weiter das alte Icon, auch nach
/// `SHChangeNotify`. Darum bekommen die Glass-Verknüpfungen einen anderen, gleichwertigen Icon-Verweis:
/// Index 0 und Ressource 1 (`-1`) sind dasselbe Icon (die Exe hat nur eins), für den Cache aber ein neuer
/// Eintrag. Bei jedem Update wird gewechselt.
fn refresh_shell_icons(exe: &std::path::Path) {
    use windows::core::{Interface, HSTRING, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READWRITE,
    };
    use windows::Win32::UI::Shell::{
        FOLDERID_Desktop, FOLDERID_Programs, FOLDERID_RoamingAppData, IShellLinkW, SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT,
    };
    use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNE_UPDATEITEM, SHCNF_IDLIST, SHCNF_PATHW};
    let notify = |path: &std::path::Path| {
        let wide: Vec<u16> = path.to_string_lossy().encode_utf16().chain([0]).collect();
        unsafe { SHChangeNotify(SHCNE_UPDATEITEM as i32, SHCNF_PATHW, wide.as_ptr().cast(), std::ptr::null()) };
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let known = |id| {
            let raw = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
            let path = raw.to_string().ok();
            CoTaskMemFree(Some(raw.0 as _));
            path.map(std::path::PathBuf::from)
        };
        // Desktop, Startmenü und an die Taskleiste angeheftete Verknüpfungen
        let dirs = [
            known(&FOLDERID_Desktop),
            known(&FOLDERID_Programs),
            known(&FOLDERID_RoamingAppData).map(|d| d.join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")),
        ];
        let exe_name = exe.to_string_lossy().to_lowercase();
        for dir in dirs.into_iter().flatten() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for lnk in entries.flatten().map(|e| e.path()) {
                if !lnk.extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk")) { continue; }
                let Ok(link) = CoCreateInstance::<_, IShellLinkW>(&ShellLink, None, CLSCTX_INPROC_SERVER) else { continue };
                let Ok(file) = link.cast::<IPersistFile>() else { continue };
                if file.Load(&HSTRING::from(lnk.as_path()), STGM_READWRITE).is_err() { continue; }
                let mut target = [0u16; 1024];
                if link.GetPath(&mut target, std::ptr::null_mut(), 0).is_err() { continue; }
                let target = String::from_utf16_lossy(&target[..target.iter().position(|&c| c == 0).unwrap_or(0)]);
                if target.to_lowercase() != exe_name { continue; }
                let mut icon = [0u16; 1024];
                let mut index = 0;
                let _ = link.GetIconLocation(&mut icon, &mut index);
                if link.SetIconLocation(&HSTRING::from(exe), if index == 0 { -1 } else { 0 }).is_ok()
                    && file.Save(PCWSTR::null(), true).is_ok()
                {
                    notify(&lnk);
                }
            }
        }
        notify(exe);
        // Icon-Liste des Explorers verwerfen, damit alle Ansichten neu laden
        SHChangeNotify(SHCNE_ASSOCCHANGED as i32, SHCNF_IDLIST, std::ptr::null(), std::ptr::null());
    }
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
    use super::{release_build, verify};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn only_signatures_from_the_release_key_for_the_same_build_pass() {
        let exe = b"MZ fake exe".as_slice();
        // Mit einem fremden Schlüssel signiert: passt nicht zum eingebauten öffentlichen Schlüssel
        let foreign = SigningKey::from_bytes(&[7; 32]);
        let sig = STANDARD.encode(foreign.sign(&crate::signature::message(5, exe)).to_bytes());
        assert!(!verify(5, exe, sig.as_bytes()));
        for junk in [b"".as_slice(), b"kein base64!", b"AAAA"] {
            assert!(!verify(5, exe, junk));
        }
        // Die Build-Nummer steckt in der Signatur: dieselbe Exe als anderer Build zählt nicht
        assert_ne!(crate::signature::message(5, exe), crate::signature::message(6, exe));
    }

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
