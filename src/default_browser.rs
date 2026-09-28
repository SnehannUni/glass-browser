//! Glass als Browser bei Windows anmelden, damit es unter „Standard-Apps“ erscheint.
//! Festlegen muss man es dort selbst – Windows lässt Apps den Standard nicht mehr ändern.
//! Alles unter HKCU, also ohne Admin-Rechte.

use windows_sys::Win32::System::Registry::{RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ};

/// Name unter `RegisteredApplications` – so heißt Glass auch in `ms-settings:defaultapps?registeredAppUser=`.
const APP: &str = "Glass";
const PROG_ID: &str = "GlassHTML";
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
    if read(&format!(r"Software\Classes\{PROG_ID}\shell\open\command"), "").as_deref() == Some(open.as_str())
        && read(r"Software\RegisteredApplications", APP).is_some()
    {
        return;
    }
    let icon = format!("{exe},0");

    // Dokumenttyp, auf den Links und HTML-Dateien zeigen
    let prog = format!(r"Software\Classes\{PROG_ID}");
    write(&prog, "", "Glass HTML-Dokument");
    write(&format!(r"{prog}\DefaultIcon"), "", &icon);
    write(&format!(r"{prog}\Application"), "ApplicationName", APP);
    write(&format!(r"{prog}\Application"), "ApplicationIcon", &icon);
    write(&format!(r"{prog}\shell\open\command"), "", &open);

    // Browser-Eintrag mit den Fähigkeiten, die Windows in „Standard-Apps“ anbietet
    write(CLIENT, "", APP);
    write(&format!(r"{CLIENT}\DefaultIcon"), "", &icon);
    write(&format!(r"{CLIENT}\shell\open\command"), "", &format!("\"{exe}\""));
    let caps = format!(r"{CLIENT}\Capabilities");
    write(&caps, "ApplicationName", APP);
    write(&caps, "ApplicationDescription", "Ein Browser aus Glas");
    write(&caps, "ApplicationIcon", &icon);
    write(&format!(r"{caps}\StartMenu"), "StartMenuInternet", APP);
    for scheme in ["http", "https"] {
        write(&format!(r"{caps}\URLAssociations"), scheme, PROG_ID);
    }
    for ext in [".htm", ".html", ".xhtml"] {
        write(&format!(r"{caps}\FileAssociations"), ext, PROG_ID);
        write(&format!(r"Software\Classes\{ext}\OpenWithProgids"), PROG_ID, "");
    }
    write(r"Software\RegisteredApplications", APP, &caps);

    unsafe {
        use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
        SHChangeNotify(SHCNE_ASSOCCHANGED as _, SHCNF_IDLIST, std::ptr::null(), std::ptr::null());
    }
}

/// Öffnen https-Links Glass? (Windows 11 speichert die Wahl neuerdings unter `UserChoiceLatest\ProgId`.)
pub fn is_default() -> bool {
    let base = r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https";
    read(&format!(r"{base}\UserChoiceLatest\ProgId"), "ProgId")
        .or_else(|| read(&format!(r"{base}\UserChoice"), "ProgId"))
        .is_some_and(|id| id == PROG_ID)
}

/// Einstellungsseite von Glass unter „Standard-Apps“ öffnen – dort legt man es mit einem Klick fest.
pub fn open_settings() {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let uri = wide(&format!("ms-settings:defaultapps?registeredAppUser={APP}"));
    unsafe {
        ShellExecuteW(std::ptr::null_mut(), wide("open").as_ptr(), uri.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
    }
}
