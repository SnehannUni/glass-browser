// Einstellungen, die Rust schon beim Start braucht (Tabs wiederherstellen, Download-Ordner) – in
// `GlassBrowser\settings.json`. Was nur die Oberfläche betrifft (Leiste links, Leiste anheften), bleibt dort.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub struct Settings {
    file: PathBuf,
    /// Beim Start die Tabs der letzten Sitzung öffnen.
    pub restore_session: bool,
    /// Eigener Download-Ordner; `None`: der von Windows.
    pub download_dir: Option<String>,
}

impl Settings {
    pub fn load(data_dir: &Path) -> Self {
        let file = data_dir.join("settings.json");
        let v: Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Settings {
            file,
            restore_session: v["restoreSession"].as_bool().unwrap_or(true),
            download_dir: v["downloadDir"].as_str().filter(|d| Path::new(d).is_dir()).map(str::to_owned),
        }
    }

    pub fn save(&self) {
        let v = json!({ "restoreSession": self.restore_session, "downloadDir": self.download_dir });
        let _ = std::fs::write(&self.file, v.to_string());
    }
}

/// Windows-Dialog „Ordner auswählen“, beginnend bei `start`. `None`, wenn abgebrochen.
pub fn pick_folder(owner: isize, start: &str) -> Option<String> {
    use windows::{
        core::HSTRING,
        Win32::{
            Foundation::HWND,
            System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER},
            UI::Shell::{FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName, FOS_PICKFOLDERS, SIGDN_FILESYSPATH},
        },
    };
    unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let options = dialog.GetOptions().ok()?;
        dialog.SetOptions(options | FOS_PICKFOLDERS).ok()?;
        let _ = dialog.SetTitle(&HSTRING::from("Download-Ordner wählen"));
        if let Ok(folder) = SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(start), None) {
            let _ = dialog.SetFolder(&folder);
        }
        dialog.Show(Some(HWND(owner as _))).ok()?;
        let item = dialog.GetResult().ok()?;
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = name.to_string().ok();
        CoTaskMemFree(Some(name.0 as _));
        path
    }
}
