// Downloads: WebView2 lädt wie gewohnt in den Downloads-Ordner, nur ohne sein eigenes Fenster. Stattdessen steht rechts
// oben ein Knopf – erst ab dem ersten Download dieser Sitzung – mit einer Glas-Liste der letzten Downloads (wie die Favoriten).
// Fertige Downloads aus normalen Tabs merkt sich `GlassBrowser\downloads.json`; private Tabs hinterlassen dort nichts.

use serde_json::{json, Value};
use std::{cell::RefCell, path::{Path, PathBuf}, rc::Rc, time::{Duration, Instant}};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::core::{Interface, PWSTR};

/// So viele Downloads zeigt die Liste (und speichert sie).
const KEEP: usize = 30;
/// Fortschritt meldet WebView2 sehr oft – die Oberfläche bekommt ihn höchstens so oft.
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

#[derive(Clone, Copy, PartialEq)]
enum State {
    Progress,
    Done,
    Failed,
}

struct Item {
    id: u32,
    /// Tab, aus dem der Download kam (0: aus einer früheren Sitzung).
    tab: u32,
    name: String,
    path: String,
    url: String,
    received: i64,
    /// Gesamtgröße; 0, solange der Server sie nicht nennt.
    total: i64,
    state: State,
    private: bool,
    /// Beginn in ms seit 1970.
    time: u64,
    /// Nur solange er läuft oder sich fortsetzen lässt; danach braucht Glass ihn nicht mehr.
    op: Option<ICoreWebView2DownloadOperation>,
    notified: Instant,
}

/// Was die Oberfläche erfahren muss.
pub enum Change {
    /// Neuer Download. `fresh`: Der Tab hatte davor keine Seite (Link in neuem Tab, eingetippte Adresse) –
    /// Glass räumt ihn dann wieder ab.
    Started { fresh: bool },
    Updated,
}

pub type Shared = Rc<RefCell<Downloads>>;
pub type Notify = Rc<dyn Fn(Change)>;

pub struct Downloads {
    file: PathBuf,
    /// Neueste zuerst.
    items: Vec<Item>,
    next_id: u32,
    /// In dieser Sitzung wurde schon etwas heruntergeladen – erst dann steht der Knopf rechts oben.
    session: bool,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn file_name(path: &str) -> String {
    Path::new(path).file_name().map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned())
}

impl Downloads {
    pub fn load(data_dir: &Path) -> Shared {
        let file = data_dir.join("downloads.json");
        let saved: Vec<Value> = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let mut next_id = 1;
        let items = saved
            .iter()
            .filter_map(|v| {
                let path = v["path"].as_str()?.to_owned();
                let size = v["size"].as_i64().unwrap_or_default();
                next_id += 1;
                Some(Item {
                    id: next_id - 1, tab: 0, name: file_name(&path), path, url: v["url"].as_str().unwrap_or_default().to_owned(),
                    received: size, total: size, state: State::Done, private: false, time: v["time"].as_u64().unwrap_or_default(),
                    op: None, notified: Instant::now(),
                })
            })
            .take(KEEP)
            .collect();
        Rc::new(RefCell::new(Downloads { file, items, next_id, session: false }))
    }

    fn save(&self) {
        let list: Vec<Value> = self
            .items
            .iter()
            .filter(|i| i.state == State::Done && !i.private)
            .map(|i| json!({ "path": i.path, "url": i.url, "size": i.total.max(i.received), "time": i.time }))
            .collect();
        let _ = std::fs::write(&self.file, Value::Array(list).to_string());
    }

    /// Stand für die Oberfläche (`window.setDownloads`).
    pub fn to_json(&self) -> Value {
        let items: Vec<Value> = self
            .items
            .iter()
            .map(|i| {
                let state = match i.state {
                    State::Progress => "progress",
                    State::Done if !Path::new(&i.path).exists() => "missing",
                    State::Done => "done",
                    State::Failed => "failed",
                };
                json!({
                    "id": i.id, "name": i.name, "url": i.url, "received": i.received, "total": i.total, "state": state,
                    "time": i.time, "resumable": i.state == State::Failed && i.op.is_some(),
                })
            })
            .collect();
        json!({ "visible": self.session, "items": items })
    }

    /// Hängt an Downloads aus diesem Tab noch etwas, das seine WebView braucht (laufend oder fortsetzbar)?
    pub fn busy(&self, tab: u32) -> bool {
        self.items.iter().any(|i| i.tab == tab && i.op.is_some())
    }

    /// Laufender bzw. fortsetzbarer Download (zum Abbrechen/Fortsetzen – erst aufrufen, wenn `self` nicht mehr geliehen ist).
    pub fn operation(&self, id: u32) -> Option<ICoreWebView2DownloadOperation> {
        self.items.iter().find(|i| i.id == id).and_then(|i| i.op.clone())
    }

    /// Fertige Datei, die es noch gibt.
    pub fn file(&self, id: u32) -> Option<String> {
        self.items.iter().find(|i| i.id == id && i.state == State::Done).map(|i| i.path.clone()).filter(|p| Path::new(p).exists())
    }

    /// Einen Eintrag (`Some`) oder alle (`None`) aus der Liste nehmen – laufende bleiben stehen.
    pub fn remove(&mut self, id: Option<u32>) {
        self.items.retain(|i| i.state == State::Progress || id.is_some_and(|id| i.id != id));
        self.save();
    }

    /// Stand aus WebView2 übernehmen. `true`, wenn die Oberfläche davon erfahren soll.
    fn refresh(&mut self, id: u32, op: &ICoreWebView2DownloadOperation, progress_only: bool) -> bool {
        let Some(at) = self.items.iter().position(|i| i.id == id) else { return false };
        let item = &mut self.items[at];
        let (mut received, mut total, mut state) = (0i64, 0i64, COREWEBVIEW2_DOWNLOAD_STATE::default());
        unsafe {
            let _ = op.BytesReceived(&mut received);
            let _ = op.TotalBytesToReceive(&mut total);
            let _ = op.State(&mut state);
        }
        item.received = received;
        item.total = total.max(0);
        if progress_only {
            if item.notified.elapsed() < PROGRESS_EVERY {
                return false;
            }
            item.notified = Instant::now();
            return true;
        }
        // Der endgültige Name kann vom vorgeschlagenen abweichen („datei (1).pdf“)
        let mut path = PWSTR::null();
        if unsafe { op.ResultFilePath(&mut path) }.is_ok() {
            let path = webview2_com::take_pwstr(path);
            if !path.is_empty() {
                item.name = file_name(&path);
                item.path = path;
            }
        }
        match state {
            COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED => {
                item.state = State::Done;
                item.total = item.total.max(item.received);
                item.op = None;
            }
            COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED => {
                let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();
                let mut resumable = windows::core::BOOL::default();
                unsafe {
                    let _ = op.InterruptReason(&mut reason);
                    let _ = op.CanResume(&mut resumable);
                }
                if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED {
                    self.items.remove(at); // selbst abgebrochen: gehört nicht mehr in die Liste
                } else {
                    item.state = State::Failed;
                    if !resumable.as_bool() {
                        item.op = None;
                    }
                }
            }
            _ => item.state = State::Progress,
        }
        self.save();
        true
    }
}

/// Downloads dieses Tabs übernehmen: WebView2 zeigt dafür kein eigenes Fenster mehr, Glass meldet sie über `notify`.
pub fn watch(webview: &ICoreWebView2, tab: u32, private: bool, shared: &Shared, notify: Notify) {
    let Ok(wv4) = webview.cast::<ICoreWebView2_4>() else { return };
    let shared = shared.clone();
    let handler = webview2_com::DownloadStartingEventHandler::create(Box::new(move |sender, args| {
        let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
        unsafe {
            let op = args.DownloadOperation()?;
            args.SetHandled(true)?; // kein Download-Fenster von WebView2
            let mut path = PWSTR::null();
            args.ResultFilePath(&mut path)?;
            let path = webview2_com::take_pwstr(path);
            let mut uri = PWSTR::null();
            op.Uri(&mut uri)?;
            let url = webview2_com::take_pwstr(uri);
            let mut total = 0i64;
            let _ = op.TotalBytesToReceive(&mut total);

            // Ohne eigene Seite: noch auf about:blank (bzw. der Download-Adresse) und nichts zum Zurückgehen
            let mut source = PWSTR::null();
            let _ = sender.Source(&mut source);
            let source = webview2_com::take_pwstr(source);
            let mut back = windows::core::BOOL::default();
            let _ = sender.CanGoBack(&mut back);
            let fresh = !back.as_bool() && (source.is_empty() || source == "about:blank" || source == url);

            let id = {
                let mut d = shared.borrow_mut();
                let id = d.next_id;
                d.next_id += 1;
                d.session = true;
                let item = Item {
                    id, tab, name: file_name(&path), path, url, received: 0, total: total.max(0), state: State::Progress,
                    private, time: now_ms(), op: Some(op.clone()), notified: Instant::now(),
                };
                d.items.insert(0, item);
                // Ältere fertige fallen hinten heraus
                while d.items.len() > KEEP {
                    match d.items.iter().rposition(|i| i.state != State::Progress) {
                        Some(i) => { d.items.remove(i); }
                        None => break,
                    }
                }
                id
            };

            let mut token = 0;
            let (s, n) = (shared.clone(), notify.clone());
            let progress = webview2_com::BytesReceivedChangedEventHandler::create(Box::new(move |op, _| {
                if let Some(op) = op {
                    if s.borrow_mut().refresh(id, &op, true) {
                        n(Change::Updated);
                    }
                }
                Ok(())
            }));
            op.add_BytesReceivedChanged(&progress, &mut token)?;
            let (s, n) = (shared.clone(), notify.clone());
            let state = webview2_com::StateChangedEventHandler::create(Box::new(move |op, _| {
                if let Some(op) = op {
                    if s.borrow_mut().refresh(id, &op, false) {
                        n(Change::Updated);
                    }
                }
                Ok(())
            }));
            op.add_StateChanged(&state, &mut token)?;
            notify(Change::Started { fresh });
        }
        Ok(())
    }));
    let mut token = 0;
    let _ = unsafe { wv4.add_DownloadStarting(&handler, &mut token) };
}

/// Datei mit dem zugehörigen Programm öffnen.
pub fn open(path: &str) {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
    unsafe { ShellExecuteW(std::ptr::null_mut(), windows_sys::w!("open"), wide.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
}

/// Explorer mit markierter Datei öffnen.
pub fn reveal(path: &str) {
    use windows_sys::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems};
    let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
    unsafe {
        let pidl = ILCreateFromPathW(wide.as_ptr());
        if !pidl.is_null() {
            SHOpenFolderAndSelectItems(pidl, 0, std::ptr::null(), 0);
            ILFree(pidl);
        }
    }
}
