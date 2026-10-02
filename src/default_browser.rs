//! Winter Browser als Browser und PDF-Programm bei Windows anmelden, damit er unter „Standard-Apps“ und bei PDFs
//! unter „Öffnen mit“ erscheint.
//! Festlegen muss man es dort selbst – Windows lässt Apps den Standard nicht mehr ändern.
//! Alles unter HKCU, also ohne Admin-Rechte. Die Store-Version meldet sich stattdessen über ihr Paketmanifest an
//! (store/AppxManifest.xml) und schreibt nichts in die Registry.

use windows_sys::Win32::System::Registry::{RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ};

/// Name unter `RegisteredApplications` – so heißt der Browser auch in `ms-settings:defaultapps?registeredAppUser=`.
/// Bleibt „Glass“ (der frühere Name), damit bestehende Installationen keinen zweiten Eintrag bekommen.
const APP: &str = "Glass";
/// Name, den Windows unter „Standard-Apps“ und „Öffnen mit“ zeigt.
const NAME: &str = "Winter Browser";
const PROG_ID: &str = "GlassHTML";
const PDF_PROG_ID: &str = "GlassPDF";
const CLIENT: &str = r"Software\Clients\StartMenuInternet\Glass";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

fn read(key: &str, name: &str) -> Option<String> {
    let mut buf = [0u16; 1024];
    let mut len = std::mem::size_of_val(&buf) as u32;
    let ok = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, wide(key).as_ptr(), wide(name).as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr() as _, &mut len) == 0
    };
    ok.then(|| String::from_utf16_lossy(&buf[..(len as usize / 2).saturating_sub(1)]))
}

/// `name` leer = Standardwert des Schlüssels. Fehlende Schlüssel legt Windows selbst an.
fn write(key: &str, name: &str, value: &str) {
    let data = wide(value);
    let name = (!name.is_empty()).then(|| wide(name));
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            wide(key).as_ptr(),
            name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr()),
            REG_SZ,
            data.as_ptr() as _,
            (data.len() * 2) as u32,
        );
    }
}

/// Einträge (neu) schreiben, damit sie auf die laufende Exe zeigen – nach einem Umzug oder Update stimmt der Pfad sonst nicht.
pub fn register() {
    let Ok(exe) = std::env::current_exe() else { return };
    let exe = exe.display().to_string();
    let open = format!("\"{exe}\" \"%1\"");
    let current = |prog: &str| read(&format!(r"Software\Classes\{prog}\shell\open\command"), "").as_deref() == Some(open.as_str());
    // Auch neu schreiben, wenn noch der alte Name „Glass“ eingetragen ist
    let named = read(&format!(r"{CLIENT}\Capabilities"), "ApplicationName").as_deref() == Some(NAME);
    if current(PROG_ID) && current(PDF_PROG_ID) && named && read(r"Software\RegisteredApplications", APP).is_some() {
        return;
    }
    let icon = format!("{exe},0");

    // Dokumenttypen: Links und HTML-Dateien bzw. PDFs (öffnen im eigenen PDF-Viewer)
    for (id, name) in [(PROG_ID, "Winter Browser HTML-Dokument"), (PDF_PROG_ID, "Winter Browser PDF-Dokument")] {
        let prog = format!(r"Software\Classes\{id}");
        write(&prog, "", name);
        write(&format!(r"{prog}\DefaultIcon"), "", &icon);
        write(&format!(r"{prog}\Application"), "ApplicationName", NAME);
        write(&format!(r"{prog}\Application"), "ApplicationIcon", &icon);
        write(&format!(r"{prog}\shell\open\command"), "", &open);
    }

    // Browser-Eintrag mit den Fähigkeiten, die Windows in „Standard-Apps“ anbietet
    write(CLIENT, "", NAME);
    write(&format!(r"{CLIENT}\DefaultIcon"), "", &icon);
    write(&format!(r"{CLIENT}\shell\open\command"), "", &format!("\"{exe}\""));
    let caps = format!(r"{CLIENT}\Capabilities");
    write(&caps, "ApplicationName", NAME);
    write(&caps, "ApplicationDescription", "Ein schneller, klarer Browser");
    write(&caps, "ApplicationIcon", &icon);
    write(&format!(r"{caps}\StartMenu"), "StartMenuInternet", APP);
    for scheme in ["http", "https"] {
        write(&format!(r"{caps}\URLAssociations"), scheme, PROG_ID);
    }
    for (ext, id) in [(".htm", PROG_ID), (".html", PROG_ID), (".xhtml", PROG_ID), (".pdf", PDF_PROG_ID)] {
        write(&format!(r"{caps}\FileAssociations"), ext, id);
        write(&format!(r"Software\Classes\{ext}\OpenWithProgids"), id, "");
    }
    write(r"Software\RegisteredApplications", APP, &caps);

    unsafe {
        use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
        SHChangeNotify(SHCNE_ASSOCCHANGED as _, SHCNF_IDLIST, std::ptr::null(), std::ptr::null());
    }
}

/// App-ID des Store-Pakets: Paketfamilie und die Application-Id aus store/AppxManifest.xml.
fn package_app_id() -> Option<String> {
    crate::paths::package_family_name().map(|family| format!("{family}!App"))
}

/// Öffnen https-Links diesen Browser? (Windows 11 speichert die Wahl neuerdings unter `UserChoiceLatest\ProgId`.)
/// Store-Pakete bekommen von Windows eine eigene ProgId (`AppX…`); deren `Application\AppUserModelID` nennt das Paket.
pub fn is_default() -> bool {
    let base = r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https";
    let Some(id) = read(&format!(r"{base}\UserChoiceLatest\ProgId"), "ProgId").or_else(|| read(&format!(r"{base}\UserChoice"), "ProgId")) else {
        return false;
    };
    match package_app_id() {
        Some(app) => read(&format!(r"Software\Classes\{id}\Application"), "AppUserModelID").is_some_and(|a| a.eq_ignore_ascii_case(&app)),
        None => id == PROG_ID,
    }
}

/// Einstellungsseite des Browsers unter „Standard-Apps“ öffnen – dort legt man ihn mit einem Klick fest.
pub fn open_settings() {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let page = match package_app_id() {
        Some(app) => format!("registeredAUMID={app}"),
        None => format!("registeredAppUser={APP}"),
    };
    let uri = wide(&format!("ms-settings:defaultapps?{page}"));
    unsafe {
        ShellExecuteW(std::ptr::null_mut(), wide("open").as_ptr(), uri.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
    }
}
