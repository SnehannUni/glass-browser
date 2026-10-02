//! Wo Winter Browser seine Daten ablegt. Als Store-Paket (MSIX) gehört der Datenordner in den Ordner des Pakets
//! (`%LOCALAPPDATA%\Packages\<Paket>\LocalState`) – den räumt Windows beim Deinstallieren weg, und WebView2
//! bekommt einen echten Pfad statt eines virtualisierten.

use std::path::PathBuf;

/// Familienname des MSIX-Pakets, in dem die Exe läuft – `None` ohne Paket (GitHub-Version, lokale Builds).
pub fn package_family_name() -> Option<String> {
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFamilyName;
    let mut buf = [0u16; 256];
    let mut len = buf.len() as u32;
    let ok = unsafe { GetCurrentPackageFamilyName(&mut len, buf.as_mut_ptr()) == 0 };
    ok.then(|| String::from_utf16_lossy(&buf[..(len as usize).saturating_sub(1)]))
}

/// Datenordner: WebView2-Profil, Werbeblocker-Listen, Mail- und Download-Liste, PDF-Unterschriften.
pub fn data_dir() -> PathBuf {
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return std::env::temp_dir().join("GlassBrowser");
    };
    match package_family_name() {
        Some(family) => local.join("Packages").join(family).join("LocalState").join("GlassBrowser"),
        None => local.join("GlassBrowser"),
    }
}
