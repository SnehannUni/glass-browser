// Berechtigungsanfragen von Webseiten (Kamera, Mikrofon, Standort …): statt des WebView2-Dialogs fragt Glass in
// seiner eigenen Glas-Leiste über der Seite. Die Antwort merkt sich `sites.rs` je Website (private Tabs nicht).
// WebView2 wartet per Deferral, bis die Antwort da ist.

use std::{cell::RefCell, collections::HashMap, rc::Rc};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::core::{Interface, PWSTR};

pub struct Request {
    pub tab: u32,
    pub url: String,
    pub kind: &'static str,
    args: ICoreWebView2PermissionRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
}

#[derive(Default)]
pub struct Pending {
    next: u32,
    requests: HashMap<u32, Request>,
}

pub type Shared = Rc<RefCell<Pending>>;

/// Kurzname der Art (so steht sie in sites.json und in der Oberfläche); `None`: WebView2 entscheidet selbst.
fn kind_name(kind: COREWEBVIEW2_PERMISSION_KIND) -> Option<&'static str> {
    Some(match kind {
        COREWEBVIEW2_PERMISSION_KIND_CAMERA => "camera",
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => "microphone",
        COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION => "geolocation",
        COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => "notifications",
        COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => "clipboard",
        COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS => "downloads",
        COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES => "midi",
        COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT => "windows",
        COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS => "fonts",
        COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE => "files",
        COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS => "sensors",
        _ => return None, // Autoplay & Co.: Voreinstellung von WebView2
    })
}

/// Anfragen dieses Tabs abfangen; `notify(id)` meldet eine neue, wartende Anfrage.
pub fn watch(webview: &ICoreWebView2, tab: u32, shared: &Shared, notify: impl Fn(u32) + 'static) {
    let shared = shared.clone();
    let handler = webview2_com::PermissionRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        unsafe {
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            let Some(kind) = kind_name(kind) else { return Ok(()) };
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let url = webview2_com::take_pwstr(uri);
            // Glass merkt sich die Antwort selbst – so lässt sie sich in der Seiteninfo auch wieder zurücknehmen
            if let Ok(args3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                let _ = args3.SetSavesInProfile(false);
            }
            let deferral = args.GetDeferral()?;
            let id = {
                let mut p = shared.borrow_mut();
                p.next += 1;
                let id = p.next;
                p.requests.insert(id, Request { tab, url, kind, args: args.clone(), deferral });
                id
            };
            notify(id);
        }
        Ok(())
    }));
    let mut token = 0;
    let _ = unsafe { webview.add_PermissionRequested(&handler, &mut token) };
}

impl Pending {
    pub fn get(&self, id: u32) -> Option<&Request> {
        self.requests.get(&id)
    }

    /// Wartende Anfragen eines Tabs, älteste zuerst.
    pub fn of_tab(&self, tab: u32) -> Vec<u32> {
        let mut ids: Vec<u32> = self.requests.iter().filter(|(_, r)| r.tab == tab).map(|(id, _)| *id).collect();
        ids.sort();
        ids
    }

    /// Anfrage beantworten. `None`: ohne Entscheidung schließen (WebView2 lehnt dann ab).
    pub fn answer(&mut self, id: u32, allow: Option<bool>) -> Option<Request> {
        let request = self.requests.remove(&id)?;
        let state = match allow {
            Some(true) => COREWEBVIEW2_PERMISSION_STATE_ALLOW,
            Some(false) => COREWEBVIEW2_PERMISSION_STATE_DENY,
            None => COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
        };
        unsafe {
            let _ = request.args.SetState(state);
            let _ = request.deferral.Complete();
        }
        Some(request)
    }

    /// Tab geschlossen oder weiternavigiert: seine offenen Anfragen verfallen.
    pub fn drop_tab(&mut self, tab: u32) {
        for id in self.of_tab(tab) {
            self.answer(id, Some(false));
        }
    }
}
