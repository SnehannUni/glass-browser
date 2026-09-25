#![windows_subsystem = "windows"]

mod blocker;
mod suggest;
mod update;
mod window_frame;
mod autofill;
mod favicon;
mod resize_preview;
mod pdf;

use serde_json::{json, Value};
use std::{cell::{Cell, RefCell}, rc::Rc, time::Instant};
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    platform::windows::{IconExtWindows, WindowBuilderExtWindows, WindowExtWindows},
    window::{Icon, ResizeDirection, Theme, Window, WindowBuilder},
};
use wry::{
    dpi::{LogicalPosition, LogicalSize},
    MemoryUsageLevel, NewWindowResponse, PageLoadEvent, Rect, WebContext, WebView, WebViewBuilder,
    WebViewBuilderExtWindows, WebViewExtWindows,
};

const UI_HTML: &str = include_str!("ui.html");
const CONTENT_JS: &str = include_str!("content.js");
/// Die Oberfläche wird über ein eigenes Protokoll ausgeliefert (unter Windows `http://glass.localhost/`).
const UI_URL: &str = "http://glass.localhost/";

/// Die eine Zeile oben: Ampel, Vor/Zurück, Tabs, Adressfeld und Knöpfe.
const TOOLBAR_HEIGHT: f64 = 42.0;
/// Rand um den Seiteninhalt; bleibt gleichzeitig Greifzone zum Ändern der Fenstergröße.
const MARGIN: f64 = 4.0;
/// So lange gleiten die Seiten, wenn die Leiste oben aus- oder einfährt (gleich wie --chrome-slide in ui.html).
const CHROME_SLIDE: std::time::Duration = std::time::Duration::from_millis(380);
/// Konzentrisch zur Fensterecke (--radius = 8 px in ui.html, wie Windows 11): 8 − MARGIN.
const CONTENT_RADIUS: f64 = 4.0;
/// Abstand zwischen den beiden Seiten einer geteilten Ansicht – zugleich Griff zum Verschieben.
const SPLIT_GAP: f64 = 4.0;
/// So lange darf ein Tab unsichtbar sein, bevor er schlafen geht (`sleep_idle_tabs`).
const SLEEP_AFTER: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const PROMPT_JS: &str = include_str!("prompt.js");

/// Wie ein Suchanbieter den Text bekommt.
enum Search {
    /// Wird an die Adresse angehängt (`?q=…`); die Seite führt den Prompt selbst aus.
    Query(&'static str),
    /// Die Seite kennt keinen solchen Parameter: Glass öffnet sie und tippt den Prompt selbst ein (prompt.js).
    Typed(&'static str),
}

/// Suchanbieter im Adressfeld (Kennungen wie in ui.html).
const SEARCH_ENGINES: &[(&str, Search)] = &[
    ("google", Search::Query("https://www.google.com/search?q=")),
    ("chatgpt", Search::Query("https://chatgpt.com/?q=")),
    ("claude", Search::Query("https://claude.ai/new?q=")),
    ("gemini", Search::Typed("https://gemini.google.com/app")),
    ("kimi", Search::Typed("https://www.kimi.ai/")), // internationale Seite (kimi.com ist die chinesische)
    ("zai", Search::Typed("https://chat.z.ai/")),
];

fn search_engine(engine: &str) -> &'static Search {
    &SEARCH_ENGINES.iter().find(|(id, _)| *id == engine).unwrap_or(&SEARCH_ENGINES[0]).1
}

enum UserEvent {
    AutofillRequest(u32, String, String),
    AutofillReply(Value),
    Ui(String),
    Content(String),
    Title(u32, String),
    Favicon(u32, String),
    PageFavicon(u32, String, String),
    ResizeSnapshot(u64, u32, String),
    Load(u32, bool, String),
    /// Tab, aus dem das neue Fenster angefordert wurde, und dessen Adresse.
    NewWindow(u32, String),
    /// Eine Seite (z. B. ein Video) betritt oder verlässt den Vollbildmodus.
    Fullscreen(u32, bool),
    /// In eine Webseite wurde geklickt (sie hat den Tastaturfokus bekommen).
    Focus(u32),
    /// Der Werbeblocker hat in diesem Tab eine Anfrage verhindert.
    Blocked(u32),
    /// Eine Webseite fragt nach CSS zum Ausblenden von Werbeflächen (JSON aus content.js).
    Cosmetic(u32, String),
    /// Auf GitHub gibt es eine neuere Version (Build-Nummer, Änderungen, Download-Adresse).
    UpdateAvailable(u32, String, String),
    /// Update installiert (Glass beendet sich, die neue Version startet) oder Fehlermeldung.
    UpdateDone(Result<(), String>),
    /// Regelmäßiger Anstoß, lange unsichtbare Tabs schlafen zu legen.
    SleepTabs,
    /// Im Tab läuft der PDF-Viewer (pdf.rs) und möchte wissen, wo das Wallpaper hinter ihm liegt.
    PdfViewer(u32),
}

/// Id des Skripts, das den Webseiten die Seiten ohne Werbeblocker mitteilt (siehe `set_adblock_flag`).
type ScriptSlot = Rc<RefCell<Option<String>>>;

/// Zwei Tabs nebeneinander. Sichtbar, solange einer der beiden der aktive Tab ist.
struct Split {
    left: u32,
    right: u32,
    /// Anteil der linken Seite an der Breite.
    ratio: f64,
}

/// Logisches Rechteck (x, y, Breite, Höhe).
type Area = [f64; 4];

/// Kurve der Gleitbewegung, dieselbe wie `cubic-bezier(.4, 0, .2, 1)` für --chrome-slide in ui.html:
/// sanft anfahren, weich auslaufen. Zu Zeitanteil `t` den Weganteil suchen (Newton auf der x-Kurve).
fn chrome_ease(t: f64) -> f64 {
    let (x1, y1, x2, y2) = (0.4, 0.0, 0.2, 1.0);
    let bezier = |a: f64, b: f64, s: f64| 3.0 * a * s * (1.0 - s).powi(2) + 3.0 * b * s * s * (1.0 - s) + s.powi(3);
    let mut s = t;
    for _ in 0..8 {
        let dx = 3.0 * x1 * (1.0 - s).powi(2) + 6.0 * (x2 - x1) * s * (1.0 - s) + 3.0 * (1.0 - x2) * s * s;
        if dx.abs() < 1e-6 {
            break;
        }
        s = (s - (bezier(x1, x2, s) - t) / dx).clamp(0.0, 1.0);
    }
    bezier(y1, y2, s)
}

fn to_rect([x, y, w, h]: Area) -> Rect {
    Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(w.max(0.0), h.max(0.0)).into() }
}

struct Tab {
    id: u32,
    title: String,
    favicon: String,
    page_favicon: String,
    url: String,
    loading: bool,
    /// Privater Tab: eigenes InPrivate-Profil nur im Arbeitsspeicher (siehe `build_content_webview`).
    private: bool,
    /// Vom Werbeblocker verhinderte Anfragen seit dem letzten Seitenaufruf.
    blocked: u32,
    adblock_flag: ScriptSlot,
    /// Wird erst bei der ersten Navigation erzeugt – ein leerer neuer Tab kostet keinen Renderer.
    webview: Option<WebView>,
    /// Ganz an den Anfang zurückgegangen: der Tab zeigt den Startbildschirm, die Seite wartet
    /// ausgeblendet dahinter – „Vor“ holt sie zurück.
    home: bool,
    /// Prompt, den Glass nach dem Laden selbst eintippt (Anbieter ohne `?q=`, siehe `Search::Typed`).
    pending_prompt: Option<String>,
    /// Seit wann die Seite ausgeblendet ist (`None`: gerade sichtbar). Siehe `sleep_idle_tabs`.
    hidden_since: Cell<Option<Instant>>,
    /// Zeigt gerade den PDF-Viewer: bekommt die Lage des Wallpapers (`sync_pdf_walls`).
    pdf_viewer: bool,
}

impl Tab {
    /// Zeigt der Tab gerade eine Webseite (und nicht den Startbildschirm)?
    fn shows_page(&self) -> bool {
        self.webview.is_some() && !self.home
    }
}

struct Browser {
    icloud: std::sync::mpsc::Sender<Value>,
    autofill: Option<autofill::Pending>,
    autofill_seq: u64,
    window: Window,
    ui: WebView,
    tabs: Vec<Tab>,
    active: usize,
    next_id: u32,
    proxy: EventLoopProxy<UserEvent>,
    /// Die aktive Seite füllt gerade den ganzen Bildschirm.
    fullscreen: bool,
    /// War das Fenster vor dem Vollbild maximiert? Wird beim Verlassen wiederhergestellt.
    was_maximized: bool,
    /// Offenes Overlay der Oberfläche über der Webseite: x, y, Breite, Höhe, Eckradius (logische px).
    overlay: Option<[f64; 5]>,
    /// Zuletzt an die Oberfläche gemeldete Mausposition (siehe `poll_hover`).
    hover: Option<(i32, i32, bool)>,
    split: Option<Split>,
    resize_preview: Option<(u64, bool)>,
    /// Gefundenes Update (Build-Nummer, Änderungen, Download-Adresse) – wird im Modal angeboten.
    update: Option<(u32, String, String)>,
    /// Die Oberfläche hat die Leiste oben ausgeblendet: Webseiten reichen dann bis an den oberen Rand.
    chrome_hidden: bool,
    /// Die Seiten gleiten gerade nach oben oder unten: Beginn, Oberkante vorher und nachher.
    chrome_slide: Option<(std::time::Instant, f64, f64)>,
}

impl Browser {
    /// Tabs zeigt die Zeile oben, sobald etwas offen ist – nur bei einem einzigen leeren Tab fehlen sie.
    fn show_tabbar(&self) -> bool {
        self.tabs.len() > 1 || self.tabs.iter().any(|t| t.webview.is_some() || !t.url.is_empty())
    }

    fn chrome_height(&self) -> f64 {
        TOOLBAR_HEIGHT
    }

    /// Fläche für Webseiten unter der Toolbar. Ist die Leiste ausgeblendet, bleibt oben nur der Rand frei –
    /// fährt die Maus dorthin, holt die Oberfläche die Leiste zurück.
    fn resting_area(&self) -> Area {
        let size = self.window.inner_size().to_logical::<f64>(self.window.scale_factor());
        let top = if self.chrome_hidden { MARGIN } else { self.chrome_height() };
        [MARGIN, top, size.width - 2.0 * MARGIN, size.height - top - MARGIN]
    }

    /// Wie `resting_area`, nur mitten im Gleiten: Dann hat die Seite schon ihre volle Höhe und wird nur
    /// verschoben – so muss Chromium nicht in jedem Bild neu umbrechen. Was unten übersteht, schneidet das Fenster ab.
    fn content_area(&self) -> Area {
        let Some((start, from, to)) = self.chrome_slide else { return self.resting_area() };
        let size = self.window.inner_size().to_logical::<f64>(self.window.scale_factor());
        let t = (start.elapsed().as_secs_f64() / CHROME_SLIDE.as_secs_f64()).min(1.0);
        // Nicht auf ganze Pixel runden: wry rechnet in physische Pixel um, sonst wären die Schritte ungleich groß
        [MARGIN, from + (to - from) * chrome_ease(t), size.width - 2.0 * MARGIN, size.height - 2.0 * MARGIN]
    }

    /// Ein Bild der Gleitbewegung: die sichtbaren Seiten nur verschieben, am Ende regulär auslegen.
    /// Die Ereignisschleife läuft dabei ungebremst; DwmFlush wartet auf das nächste Bild des Bildschirms –
    /// so kommt genau eine Position pro Bild an (ein 16-ms-Timer träfe bei 15,6-ms-Auflösung oft nur jedes zweite).
    fn slide_chrome(&mut self) {
        let Some((start, ..)) = self.chrome_slide else { return };
        unsafe { windows_sys::Win32::Graphics::Dwm::DwmFlush() };
        if start.elapsed() >= CHROME_SLIDE {
            self.chrome_slide = None;
            self.layout();
            return;
        }
        if self.resize_preview.is_some() {
            return;
        }
        for (i, area) in self.panes() {
            if let Some(wv) = &self.tabs[i].webview {
                let _ = wv.set_bounds(to_rect(area));
            }
        }
        self.sync_pdf_walls();
    }

    /// Der PDF-Viewer legt das Wallpaper wie die Oberfläche deckungsgleich hinter sein Glas – dazu braucht er
    /// die Lage seiner Seite auf dem Bildschirm (Fensterposition + Platz der Seite im Fenster) und den Monitor.
    fn sync_pdf_walls(&self) {
        let scale = self.window.scale_factor();
        let pos = self.window.inner_position().unwrap_or_default().to_logical::<f64>(scale);
        let (mpos, msize) = self
            .window
            .current_monitor()
            .map(|m| (m.position().to_logical::<f64>(scale), m.size().to_logical::<f64>(scale)))
            .unwrap_or_default();
        for (i, [x, y, ..]) in self.panes() {
            let tab = &self.tabs[i];
            let Some(wv) = tab.webview.as_ref().filter(|_| tab.pdf_viewer) else { continue };
            let geo = json!({ "x": pos.x + x, "y": pos.y + y, "mx": mpos.x, "my": mpos.y, "mw": msize.width, "mh": msize.height });
            let _ = wv.evaluate_script(&format!("window.__glassWall?.({geo})"));
        }
    }

    fn split_of(&self, id: u32) -> Option<&Split> {
        self.split.as_ref().filter(|s| s.left == id || s.right == id)
    }

    /// Welche Tabs gerade sichtbar sind und wo: einer, oder zwei nebeneinander bei geteilter Ansicht.
    fn panes(&self) -> Vec<(usize, Area)> {
        self.panes_in(self.content_area())
    }

    fn panes_in(&self, [x, y, w, h]: Area) -> Vec<(usize, Area)> {
        let Some(active) = self.tabs.get(self.active) else { return Vec::new() };
        if active.home {
            return Vec::new();
        }
        if self.fullscreen {
            let size = self.window.inner_size().to_logical::<f64>(self.window.scale_factor());
            return vec![(self.active, [0.0, 0.0, size.width, size.height])];
        }
        if let Some(split) = self.split_of(active.id) {
            if let (Some(l), Some(r)) = (self.index_of(split.left), self.index_of(split.right)) {
                let lw = ((w - SPLIT_GAP) * split.ratio).round();
                return vec![(l, [x, y, lw, h]), (r, [x + lw + SPLIT_GAP, y, w - lw - SPLIT_GAP, h])];
            }
        }
        vec![(self.active, [x, y, w, h])]
    }

    /// Fenster- und Monitorposition, damit die Oberfläche das Wallpaper deckungsgleich hinter das Glas legen kann.
    fn sync_geometry(&self) {
        let floating = window_frame::sync(&self.window, self.fullscreen);
        let scale = self.window.scale_factor();
        let pos = self.window.inner_position().unwrap_or_default().to_logical::<f64>(scale);
        let (mpos, msize) = self
            .window
            .current_monitor()
            .map(|m| (m.position().to_logical::<f64>(scale), m.size().to_logical::<f64>(scale)))
            .unwrap_or_default();
        let geo = json!({ "x": pos.x, "y": pos.y, "mx": mpos.x, "my": mpos.y, "mw": msize.width, "mh": msize.height, "floating": floating });
        let _ = self.ui.evaluate_script(&format!("window.setGeometry({geo})"));
        self.sync_pdf_walls();
    }

    /// Positioniert alle Webseiten: sichtbare an ihren Platz, alle anderen ausgeblendet.
    fn layout(&self) {
        let _ = self.ui.set_bounds(full_bounds(&self.window));
        if let Some((_, hidden)) = self.resize_preview {
            if hidden {
                for tab in &self.tabs {
                    if let Some(wv) = &tab.webview { let _ = wv.set_visible(false); }
                }
            }
            return; // Keep both website viewports unchanged throughout the drag.
        }
        let panes = self.panes();
        for (i, tab) in self.tabs.iter().enumerate() {
            let Some(wv) = &tab.webview else { continue };
            match panes.iter().find(|(p, _)| *p == i) {
                Some((_, area)) => {
                    let _ = wv.set_bounds(to_rect(*area));
                    // Weckt einen schlafenden Tab automatisch wieder auf (WebView2: IsVisible = true).
                    let _ = wv.set_visible(true);
                    let _ = wv.set_memory_usage_level(MemoryUsageLevel::Normal);
                    tab.hidden_since.set(None);
                }
                None => {
                    let _ = wv.set_visible(false);
                    if tab.hidden_since.get().is_none() {
                        tab.hidden_since.set(Some(Instant::now()));
                    }
                    // Hintergrund-Tabs: Chromium darf Caches verwerfen und spart RAM.
                    let _ = wv.set_memory_usage_level(MemoryUsageLevel::Low);
                }
            }
        }
        self.round_content_views();
        self.sync_pdf_walls();
    }

    /// Legt Tabs schlafen, die seit `SLEEP_AFTER` unsichtbar sind: Skripte und Timer stehen still, der Renderer
    /// gibt Speicher frei und kostet keine CPU mehr. Die Seite bleibt erhalten und wacht beim Anzeigen sofort auf.
    /// Tabs, die gerade Ton abspielen (Musik, Video im Hintergrund), bleiben wach.
    fn sleep_idle_tabs(&self) {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_3, ICoreWebView2_8};
        use windows::core::Interface;
        for tab in &self.tabs {
            let (Some(wv), Some(since)) = (&tab.webview, tab.hidden_since.get()) else { continue };
            if since.elapsed() < SLEEP_AFTER {
                continue;
            }
            let core = wv.webview();
            let mut audio = windows::core::BOOL::default();
            if let Ok(wv8) = core.cast::<ICoreWebView2_8>() {
                let _ = unsafe { wv8.IsDocumentPlayingAudio(&mut audio) };
            }
            if audio.as_bool() {
                continue;
            }
            // Schläft der Tab schon, meldet TrySuspend einfach Erfolg – ein eigener Merker ist nicht nötig.
            if let Ok(wv3) = core.cast::<ICoreWebView2_3>() {
                let done = webview2_com::TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
                let _ = unsafe { wv3.TrySuspend(&done) };
            }
        }
    }

    /// Rundet die Webseiten-Ansichten ab (im Vollbild eckig). Jede WebView ist ein eigenes Kindfenster,
    /// das sich per CSS nicht beschneiden lässt – also bekommt es eine abgerundete Fensterregion.
    /// Ist ein Overlay der Oberfläche offen (z. B. die Suchvorschläge), wird es aus der Region
    /// ausgespart: Die Webseite liegt über der Oberfläche und würde es sonst verdecken.
    fn round_content_views(&self) {
        use windows_sys::Win32::{
            Foundation::RECT,
            Graphics::Gdi::{CombineRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF},
            UI::WindowsAndMessaging::GetClientRect,
        };
        let scale = self.window.scale_factor();
        let px = |v: f64| (v * scale).round() as i32;
        let radius = px(CONTENT_RADIUS);
        for (i, [left, top, ..]) in self.panes() {
            let Some(wv) = &self.tabs[i].webview else { continue };
            let mut hwnd = windows::Win32::Foundation::HWND::default();
            if unsafe { wv.controller().ParentWindow(&mut hwnd) }.is_err() {
                continue;
            }
            let hwnd = hwnd.0 as _;
            unsafe {
                if self.fullscreen {
                    SetWindowRgn(hwnd, std::ptr::null_mut(), 1);
                    continue;
                }
                let mut rc: RECT = std::mem::zeroed();
                GetClientRect(hwnd, &mut rc);
                let region = rounded_region(rc.right, rc.bottom, radius);
                if let Some([x, y, w, h, r]) = self.overlay {
                    // Overlay-Koordinaten sind Fensterkoordinaten, die Region zählt ab der Webseiten-Ecke.
                    let (x, y) = (x - left, y - top);
                    let hole = CreateRoundRectRgn(px(x), px(y), px(x + w) + 1, px(y + h) + 1, px(2.0 * r), px(2.0 * r));
                    CombineRgn(region, region, hole, RGN_DIFF);
                    DeleteObject(hole);
                }
                SetWindowRgn(hwnd, region, 1);
            }
        }
    }

    /// WebView2 liefert der Oberfläche keine Hover-Ereignisse, solange eine Webseite den Tastaturfokus hat –
    /// Klicks ja, Drüberfahren nicht. Deshalb schaut Rust selbst nach, wo der Mauszeiger steht, und meldet
    /// der Oberfläche die Position über dem ganzen Fenster. Der UI-Treffer wird getrennt übertragen:
    /// Webseiten bewegen das Glaslicht, dürfen aber keine verdeckten UI-Knöpfe hovern.
    fn poll_hover(&mut self) {
        use windows_sys::Win32::{
            Foundation::POINT,
            UI::WindowsAndMessaging::{GetAncestor, GetCursorPos, GetParent, WindowFromPoint, GA_ROOT},
        };
        let mut pt = POINT { x: 0, y: 0 };
        let top = self.window.hwnd() as *mut core::ffi::c_void;
        let mut over_ui = false;
        let over_window = unsafe {
            GetCursorPos(&mut pt) != 0 && {
                let hit = WindowFromPoint(pt);
                !hit.is_null() && GetAncestor(hit, GA_ROOT) == top && {
                    // Liegt eine Webseite unter dem Zeiger? Dann ist deren Container ein Vorfahr des Treffers.
                    let pages: Vec<_> = self
                        .tabs
                        .iter()
                        .filter_map(|t| t.webview.as_ref())
                        .filter_map(|wv| {
                            let mut h = windows::Win32::Foundation::HWND::default();
                            wv.controller().ParentWindow(&mut h).ok().map(|_| h.0 as *mut core::ffi::c_void)
                        })
                        .collect();
                    let mut n = hit;
                    while !n.is_null() && n != top && !pages.contains(&n) {
                        n = GetParent(n);
                    }
                    over_ui = !pages.contains(&n);
                    true
                }
            }
        };
        let pos = over_window.then(|| {
            let origin = self.window.inner_position().unwrap_or_default();
            let scale = self.window.scale_factor();
            (((pt.x - origin.x) as f64 / scale) as i32, ((pt.y - origin.y) as f64 / scale) as i32, over_ui)
        });
        if pos != self.hover {
            self.hover = pos;
            let js = match pos {
                Some((x, y, over_ui)) => format!("window.hoverAt({x}, {y}, {over_ui})"),
                None => "window.hoverAt(null)".to_owned(),
            };
            let _ = self.ui.evaluate_script(&js);
        }
    }

    fn set_fullscreen(&mut self, id: u32, on: bool) {
        // Nur eine sichtbare Seite darf das Fenster in den Vollbildmodus holen.
        let Some(idx) = self.index_of(id).filter(|i| self.panes().iter().any(|(p, _)| p == i)) else { return };
        if self.fullscreen == on {
            return;
        }
        self.active = idx;
        self.apply_fullscreen(on);
        self.layout();
    }

    /// Schaltet das Fenster in den Vollbildmodus und zurück. Ein maximiertes Fenster ohne Rahmen beschneidet
    /// tao (WM_NCCALCSIZE) auf den Arbeitsbereich – die Taskleiste bliebe sichtbar und die Seite bekäme nicht
    /// den ganzen Bildschirm. Darum vorher entmaximieren und danach wiederherstellen.
    fn apply_fullscreen(&mut self, on: bool) {
        self.fullscreen = on;
        if on {
            self.was_maximized = self.window.is_maximized();
            if self.was_maximized {
                self.window.set_maximized(false);
            }
            self.window.set_fullscreen(Some(tao::window::Fullscreen::Borderless(None)));
        } else {
            self.window.set_fullscreen(None);
            if std::mem::take(&mut self.was_maximized) {
                self.window.set_maximized(true);
            }
        }
        self.sync_geometry();
    }

    fn sync_ui(&self) {
        let tabs: Vec<Value> = self
            .tabs
            .iter()
            // Auf dem Startbildschirm (home) sieht die Oberfläche einen leeren Tab – mit „Vor“ zurück zur Seite
            .map(|t| {
                let (title, url) = if t.home { ("", "") } else { (t.title.as_str(), t.url.as_str()) };
                json!({
                    "id": t.id, "title": title, "url": url, "loading": t.loading && !t.home, "private": t.private,
                    "favicon": if t.home { "" } else if !t.page_favicon.is_empty() { &t.page_favicon } else { &t.favicon },
                    "page": t.shows_page(), "home": t.home, "blocked": t.blocked, "adblock": !blocker::is_allowed(&t.url),
                })
            })
            .collect();
        let state = json!({
            "tabs": tabs,
            "active": self.tabs.get(self.active).map(|t| t.id),
            "maximized": self.window.is_maximized(),
            "focused": self.window.is_focused(),
            "chromeHeight": self.chrome_height(),
            "chromeHidden": self.chrome_hidden,
            "tabbar": self.show_tabbar(),
            "split": self.split.as_ref().map(|s| json!({ "left": s.left, "right": s.right, "ratio": s.ratio })),
            // Zielposition auch mitten im Gleiten – die Oberfläche animiert ihre Rahmen selbst dorthin
            "panes": self.panes_in(self.resting_area()).iter().map(|(i, [x, y, w, h])| json!({ "id": self.tabs[*i].id, "x": x, "y": y, "w": w, "h": h })).collect::<Vec<_>>(),
        });
        let _ = self.ui.evaluate_script(&format!("window.render({state})"));
    }

    fn index_of(&self, id: u32) -> Option<usize> {
        self.tabs.iter().position(|t| t.id == id)
    }

    fn new_tab(&mut self, url: Option<String>, private: bool) {
        let id = self.next_id;
        self.next_id += 1;
        // URL gleich mitgeben: sonst hält die Oberfläche den Tab kurz für leer und fokussiert die Suche
        let loading = url.is_some();
        let url_text = url.clone().unwrap_or_default();
        let adblock_flag = ScriptSlot::default();
        self.tabs.push(Tab { id, title: String::new(), favicon: String::new(), page_favicon: String::new(), url: url_text, loading, private, blocked: 0, adblock_flag, webview: None, home: false, pending_prompt: None, hidden_since: Cell::new(None), pdf_viewer: false });
        self.activate(self.tabs.len() - 1);
        match url {
            Some(url) => self.navigate_to(url),
            None => self.focus_address(),
        }
    }

    fn close_tab(&mut self, id: u32) -> bool {
        let Some(idx) = self.index_of(id) else { return true };
        // Der letzte Tab schließt nicht das Fenster, sondern macht einem leeren Platz – zurück zum Startbildschirm.
        if self.tabs.len() == 1 {
            if !self.show_tabbar() {
                return true; // schon auf dem Startbildschirm
            }
            self.new_tab(None, false);
        }
        // Schließt man eine Seite der geteilten Ansicht, bleibt die andere allein stehen.
        if self.split_of(id).is_some() {
            self.split = None;
        }
        self.tabs.remove(idx);
        if idx < self.active || self.active >= self.tabs.len() {
            self.active = self.active.saturating_sub(1);
        }
        self.activate(self.active);
        true
    }

    /// Tab `id` neben Tab `target` legen (`side`: auf welche Seite der gezogene Tab kommt).
    fn split_tabs(&mut self, id: u32, target: u32, side: &str) {
        let has_page = |i: Option<usize>| i.is_some_and(|i| self.tabs[i].shows_page());
        if id == target || !has_page(self.index_of(id)) || !has_page(self.index_of(target)) {
            return;
        }
        // In der Tab-Leiste nebeneinander einsortieren, damit die Linse beide umfassen kann.
        let tab = self.tabs.remove(self.index_of(id).unwrap());
        let t = self.index_of(target).unwrap();
        let (left, right, at) = if side == "left" { (id, target, t) } else { (target, id, t + 1) };
        self.tabs.insert(at, tab);
        self.split = Some(Split { left, right, ratio: 0.5 });
        self.activate(self.index_of(id).unwrap());
    }

    /// Tab an eine andere Stelle der Tab-Leiste verschieben; aus einer geteilten Ansicht löst er sich dabei.
    fn move_tab(&mut self, id: u32, index: usize) {
        let Some(from) = self.index_of(id) else { return };
        if self.split_of(id).is_some() {
            self.split = None;
        }
        let tab = self.tabs.remove(from);
        self.tabs.insert(index.min(self.tabs.len()), tab);
        self.activate(self.index_of(id).unwrap());
    }

    fn activate(&mut self, idx: usize) {
        self.dismiss_autofill();
        // Tabwechsel beendet den Vollbildmodus der bisherigen Seite.
        if self.fullscreen {
            self.active_script("document.exitFullscreen?.()");
            self.apply_fullscreen(false);
        }
        self.active = idx.min(self.tabs.len() - 1);
        self.layout();
        if let Some(wv) = &self.tabs[self.active].webview {
            let _ = wv.focus();
        }
        self.sync_ui();
    }

    fn cycle(&mut self, step: isize) {
        let n = self.tabs.len() as isize;
        self.activate(((self.active as isize + step).rem_euclid(n)) as usize);
    }

    fn navigate_to(&mut self, url: String) {
        let bounds = to_rect(self.content_area());
        let tab = &mut self.tabs[self.active];
        tab.url = url.clone();
        tab.loading = true;
        // Vom Startbildschirm aus weitersurfen: die wartende Seite wird wieder sichtbar und lädt die neue Adresse
        let was_home = std::mem::take(&mut tab.home);
        match &tab.webview {
            Some(wv) => {
                let _ = wv.load_url(&url);
                if was_home {
                    self.layout();
                }
                let _ = self.tabs[self.active].webview.as_ref().map(|wv| wv.focus());
            }
            None => {
                let wv = build_content_webview(&self.window, &self.ui, &self.proxy, tab.id, tab.private, &url, bounds);
                tab.webview = wv.ok();
                if let Some(wv) = &tab.webview {
                    set_adblock_flag(wv, &tab.adblock_flag);
                }
                self.layout();
            }
        }
        self.sync_ui();
    }

    /// Zurück im Verlauf – steht die Seite schon am Anfang, geht es weiter zum Startbildschirm.
    fn go_back(&mut self) {
        let tab = &self.tabs[self.active];
        let Some(wv) = tab.webview.as_ref().filter(|_| !tab.home) else { return };
        let mut can = windows::core::BOOL::default();
        let _ = unsafe { wv.webview().CanGoBack(&mut can) };
        if can.as_bool() {
            self.active_script("history.back()");
            return;
        }
        if self.split_of(tab.id).is_some() {
            self.split = None;
        }
        if self.fullscreen {
            self.active_script("document.exitFullscreen?.()");
            self.apply_fullscreen(false);
        }
        self.tabs[self.active].home = true;
        self.layout();
        self.sync_ui();
        self.focus_address();
    }

    /// Vor im Verlauf – vom Startbildschirm aus zurück zur ausgeblendeten Seite.
    fn go_forward(&mut self) {
        let tab = &mut self.tabs[self.active];
        if !tab.home {
            self.active_script("history.forward()");
            return;
        }
        tab.home = false;
        self.layout();
        if let Some(wv) = &self.tabs[self.active].webview {
            let _ = wv.focus();
        }
        self.sync_ui();
    }

    /// Update-Modal anzeigen (die Oberfläche merkt sich selbst, welche Version schon weggeklickt wurde).
    fn show_update(&self) {
        if let Some((build, notes, _)) = &self.update {
            let info = json!({ "build": build, "current": update::current_build(), "notes": notes });
            let _ = self.ui.evaluate_script(&format!("window.showUpdate?.({info})"));
        }
    }

    fn focus_address(&self) {
        let _ = self.ui.focus();
        let _ = self.ui.evaluate_script("window.focusAddress()");
    }

    fn active_script(&self, js: &str) {
        if let Some(wv) = &self.tabs[self.active].webview {
            let _ = wv.evaluate_script(js);
        }
    }

    /// Gibt `false` zurück, wenn das Fenster geschlossen werden soll.
    fn command(&mut self, cmd: &str, msg: &Value) -> bool {
        if !matches!(cmd, "split_resize_start" | "split_resize_ready" | "split_resize_end" | "overlay" | "chrome_hidden") {
            if let Some((token, _)) = self.resize_preview.take() {
                self.layout();
                let _ = self.ui.evaluate_script(&format!("window.finishResizePreview?.({token})"));
            }
        }
        if cmd == "autofill_pick" { self.autofill_pick(msg); return true; }
        if cmd == "autofill_retry" { self.autofill_retry(msg); return true; }
        if cmd == "autofill_dismiss" { self.dismiss_autofill(); return true; }
        let id = msg["id"].as_u64().map(|v| v as u32);
        let value = msg["value"].as_str().unwrap_or_default();
        match cmd {
            "animation_debug" => { let _ = self.ui.evaluate_script("window.AnimationDebug?.toggle()"); }
            "ready" => {
                self.sync_ui();
                self.sync_geometry();
                self.show_update();
            }
            // Update-Modal: „Jetzt installieren“ – Download und Austausch laufen im Hintergrund
            "update_install" => {
                if let Some((_, _, url)) = self.update.clone() {
                    let proxy = self.proxy.clone();
                    std::thread::spawn(move || {
                        let _ = proxy.send_event(UserEvent::UpdateDone(update::install(&url)));
                    });
                }
            }
            "new_tab" => self.new_tab(None, false),
            // Schutzschild im Adressfeld: Werbeblocker für die Seite des aktiven Tabs an/aus, dann neu laden
            "adblock_toggle" => {
                let url = self.tabs[self.active].url.clone();
                blocker::toggle(&url);
                for tab in &self.tabs {
                    if let Some(wv) = &tab.webview {
                        set_adblock_flag(wv, &tab.adblock_flag);
                    }
                }
                let tab = &mut self.tabs[self.active];
                tab.blocked = 0;
                if let Some(wv) = &tab.webview {
                    let _ = wv.reload();
                }
                self.sync_ui();
            }
            // Ein noch leerer Tab wird einfach umgeschaltet, sonst öffnet sich ein neuer privater Tab.
            "private_tab" => {
                let tab = &mut self.tabs[self.active];
                if tab.webview.is_none() && tab.url.is_empty() {
                    tab.private = !tab.private;
                    self.sync_ui();
                    self.focus_address();
                } else {
                    self.new_tab(None, true);
                }
            }
            "close_tab" => return self.close_tab(id.unwrap_or(self.tabs[self.active].id)),
            "activate" => {
                if let Some(idx) = id.and_then(|id| self.index_of(id)) {
                    self.activate(idx);
                }
            }
            "next_tab" => self.cycle(1),
            "prev_tab" => self.cycle(-1),
            "navigate" if !value.trim().is_empty() => match (as_url(value), search_engine(msg["engine"].as_str().unwrap_or_default())) {
                (Some(url), _) => self.navigate_to(url),
                (None, Search::Query(prefix)) => self.navigate_to(format!("{prefix}{}", url_encode(value.trim()))),
                // Seite öffnen und den Prompt eintippen, sobald sie geladen ist (siehe UserEvent::Load)
                (None, Search::Typed(home)) => {
                    self.tabs[self.active].pending_prompt = Some(value.trim().to_owned());
                    self.navigate_to((*home).to_owned());
                }
            },
            "back" => self.go_back(),
            "forward" => self.go_forward(),
            "reload" => {
                if let Some(wv) = &self.tabs[self.active].webview {
                    let _ = wv.reload();
                }
            }
            "stop" => {
                if let Some(wv) = &self.tabs[self.active].webview {
                    // Stop the pending native navigation too, not just resource
                    // loading in the previously committed document.
                    let _ = unsafe { wv.webview().Stop() };
                }
            }
            "focus_address" => self.focus_address(),
            "minimize" => self.window.set_minimized(true),
            "maximize" => self.window.set_maximized(!self.window.is_maximized()),
            "close" => return false,
            "drag" => {
                let _ = self.window.drag_window();
            }
            "split" => {
                let active = self.tabs[self.active].id;
                let target = msg["target"].as_u64().map_or(active, |t| t as u32);
                if let Some(id) = id {
                    self.split_tabs(id, target, value);
                }
            }
            "move_tab" => {
                if let (Some(id), Some(index)) = (id, msg["index"].as_u64()) {
                    self.move_tab(id, index as usize);
                }
            }
            "unsplit" => {
                self.split = None;
                self.layout();
                self.sync_ui();
            }
            "split_resize_start" => {
                if self.panes().len() == 2 {
                    let token = msg["token"].as_u64().unwrap_or_default();
                    self.resize_preview = Some((token, false));
                    for (i, _) in self.panes() {
                        let tab = &self.tabs[i];
                        let (id, proxy) = (tab.id, self.proxy.clone());
                        let result = tab.webview.as_ref().map(|wv| resize_preview::capture(&wv.webview(), move |image| {
                            let _ = proxy.send_event(UserEvent::ResizeSnapshot(token, id, image));
                        }));
                        if !matches!(result, Some(Ok(()))) {
                            let _ = self.proxy.send_event(UserEvent::ResizeSnapshot(token, id, String::new()));
                        }
                    }
                }
            }
            "split_resize_ready" => {
                if self.resize_preview.map(|p| p.0) == msg["token"].as_u64() {
                    self.resize_preview = self.resize_preview.map(|(token, _)| (token, true));
                    self.layout();
                }
            }
            "split_resize_end" => {
                if self.resize_preview.map(|p| p.0) == msg["token"].as_u64() {
                    self.resize_preview = None;
                    if let (Some(split), Some(r)) = (self.split.as_mut(), msg["value"].as_f64()) {
                        split.ratio = r.clamp(0.2, 0.8);
                    }
                    self.layout();
                    let _ = self.ui.evaluate_script(&format!("window.finishResizePreview?.({})", msg["token"]));
                    self.sync_ui();
                }
            }
            "split_ratio" => {
                if let (Some(split), Some(r)) = (self.split.as_mut(), msg["value"].as_f64()) {
                    split.ratio = r.clamp(0.2, 0.8);
                    self.layout();
                    self.sync_ui();
                }
            }
            "chrome_hidden" => {
                let hidden = msg["value"].as_bool().unwrap_or(false);
                if hidden != self.chrome_hidden {
                    let from = self.content_area()[1]; // mitten in einer Gleitbewegung: von dort aus weiter
                    self.chrome_hidden = hidden;
                    self.chrome_slide = Some((std::time::Instant::now(), from, self.resting_area()[1]));
                    self.layout();
                    self.sync_ui();
                }
            }
            "overlay" => {
                let r = &msg["rect"];
                self.overlay = r.is_object().then(|| ["x", "y", "w", "h", "r"].map(|k| r[k].as_f64().unwrap_or_default()));
                self.round_content_views();
            }
            "resize" => {
                if let Some(dir) = resize_direction(value) {
                    let _ = self.window.drag_resize_window(dir);
                }
            }
            _ => {}
        }
        true
    }

    fn handle(&mut self, event: UserEvent) -> bool {
        match event {
            UserEvent::Ui(raw) => {
                let msg: Value = serde_json::from_str(&raw).unwrap_or_default();
                let cmd = msg["cmd"].as_str().unwrap_or_default().to_owned();
                return self.command(&cmd, &msg);
            }
            // Webseiten dürfen nur Tastenkürzel melden, sonst nichts steuern.
            UserEvent::Content(cmd) => {
                if matches!(cmd.as_str(), "new_tab" | "private_tab" | "close_tab" | "next_tab" | "prev_tab" | "focus_address" | "animation_debug") {
                    return self.command(&cmd, &Value::Null);
                }
            }
            UserEvent::UpdateAvailable(build, notes, url) => {
                self.update = Some((build, notes, url));
                self.show_update();
            }
            // Erfolgreich: beenden, die neue Version wartet schon darauf
            UserEvent::UpdateDone(Ok(())) => return false,
            UserEvent::UpdateDone(Err(msg)) => {
                let _ = self.ui.evaluate_script(&format!("window.updateFailed?.({})", json!(msg)));
            }
            UserEvent::SleepTabs => self.sleep_idle_tabs(),
            UserEvent::PdfViewer(id) => {
                if let Some(i) = self.index_of(id) {
                    self.tabs[i].pdf_viewer = true;
                    self.sync_pdf_walls();
                }
            }
            // Zähler nur im Schutzschild aktualisieren – ein komplettes sync_ui pro Anfrage wäre zu viel.
            UserEvent::Blocked(id) => {
                if let Some(tab) = self.index_of(id).map(|i| &mut self.tabs[i]) {
                    tab.blocked += 1;
                    let _ = self.ui.evaluate_script(&format!("window.setBlocked?.({id}, {})", tab.blocked));
                }
            }
            UserEvent::Cosmetic(id, raw) => {
                let Some(wv) = self.index_of(id).and_then(|i| self.tabs[i].webview.as_ref()) else { return true };
                let msg: Value = serde_json::from_str(&raw).unwrap_or_default();
                let list = |k: &str| -> Vec<String> {
                    msg[k].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
                };
                let url = msg["url"].as_str().unwrap_or_default();
                let css = blocker::hide_css(url, &list("classes"), &list("ids"), msg["first"].as_bool().unwrap_or(false));
                if !css.is_empty() {
                    let _ = wv.evaluate_script(&format!("window.__glassHide?.({})", json!(css)));
                }
            }
            UserEvent::ResizeSnapshot(token, id, image) => {
                if self.resize_preview.map(|p| p.0) == Some(token) {
                    let _ = self.ui.evaluate_script(&format!("window.setResizeSnapshot?.({token},{id},{})", json!(image)));
                }
            }
            UserEvent::PageFavicon(id, source, icon) => {
                if let Some(tab) = self.index_of(id).map(|i| &mut self.tabs[i]) {
                    if !tab.private && source == tab.url && favicon::valid_page_icon(&icon) {
                        tab.page_favicon = icon;
                        self.sync_ui();
                    }
                }
            }
            UserEvent::Favicon(id, icon) => {
                if let Some(tab) = self.index_of(id).map(|i| &mut self.tabs[i]) {
                    tab.favicon = icon;
                    self.sync_ui();
                }
            }
            UserEvent::Title(id, title) => {
                if let Some(tab) = self.index_of(id).map(|i| &mut self.tabs[i]) {
                    tab.title = title;
                    // Single-Page-Apps ändern die URL oft ohne echte Navigation.
                    if let Some(Ok(url)) = tab.webview.as_ref().map(|wv| wv.url()) {
                        tab.url = url;
                    }
                    self.sync_ui();
                }
            }
            UserEvent::Load(id, loading, url) => {
                if !loading {
                    if let Ok(uri) = url.parse::<wry::http::Uri>() {
                        if uri.scheme_str() == Some("https") {
                            if let Some(host) = uri.host() {
                                let _ = self.icloud.send(json!({"id": 0, "op": "list", "host": host}));
                            }
                        }
                    }
                }
                if loading && self.autofill.as_ref().is_some() { self.dismiss_autofill(); }
                if let Some(tab) = self.index_of(id).map(|i| &mut self.tabs[i]) {
                    if loading {
                        tab.blocked = 0;
                        tab.page_favicon.clear();
                        tab.pdf_viewer = false;
                    } else if let (Some(prompt), Some(wv)) = (tab.pending_prompt.take(), &tab.webview) {
                        let _ = wv.evaluate_script(&format!("({PROMPT_JS})({})", json!(prompt)));
                    }
                    tab.loading = loading;
                    if !url.is_empty() {
                        tab.url = url;
                    }
                    self.sync_ui();
                }
            }
            // Links aus einem privaten Tab öffnen sich wieder privat.
            UserEvent::NewWindow(from, url) => {
                let private = self.index_of(from).is_some_and(|i| self.tabs[i].private);
                self.new_tab(Some(url), private);
            }
            UserEvent::Fullscreen(id, on) => self.set_fullscreen(id, on),
            // Geteilte Ansicht: Adresszeile & Co. gehören zu der Seite, in die zuletzt geklickt wurde.
            UserEvent::Focus(id) => {
                if let Some(idx) = self.index_of(id) {
                    if idx != self.active && self.panes().iter().any(|(p, _)| *p == idx) {
                        self.active = idx;
                        self.sync_ui();
                    }
                }
            }
            UserEvent::AutofillRequest(id, source, raw) => self.autofill_request(id, &source, &raw),
            UserEvent::AutofillReply(reply) => self.autofill_reply(reply),
        }
        true
    }
}

/// Rechteck `w`×`h` mit Viertelkreis-Ecken (Radius `r`, alles in Gerätepixeln) als Fensterregion.
/// Selbst gebaut statt `CreateRoundRectRgn`: GDI rundet kleine Radien ungleichmäßig und lässt an einzelnen
/// Ecken einen Pixel-Stummel stehen. Hier fällt genau jedes Pixel weg, dessen Mitte außerhalb des Kreises liegt –
/// an allen vier Ecken gleich. (Regionen kennen keine Kantenglättung; feiner als Pixelstufen geht es so nicht.)
unsafe fn rounded_region(w: i32, h: i32, r: i32) -> windows_sys::Win32::Graphics::Gdi::HRGN {
    use windows_sys::Win32::Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, RGN_DIFF};
    let region = CreateRectRgn(0, 0, w, h);
    let r = r.min(w / 2).min(h / 2);
    for row in 0..r {
        let dy = r as f64 - row as f64 - 0.5;
        // Pixel dieser Zeile, die vom Rand her abgeschnitten werden
        let cut = (0..r).take_while(|&col| {
            let dx = r as f64 - col as f64 - 0.5;
            dx * dx + dy * dy > (r * r) as f64
        });
        let cut = cut.count() as i32;
        if cut == 0 {
            break;
        }
        for (x0, y0) in [(0, row), (w - cut, row), (0, h - 1 - row), (w - cut, h - 1 - row)] {
            let corner = CreateRectRgn(x0, y0, x0 + cut, y0 + 1);
            CombineRgn(region, region, corner, RGN_DIFF);
            DeleteObject(corner);
        }
    }
    region
}

fn full_bounds(window: &Window) -> Rect {
    let size = window.inner_size().to_logical::<f64>(window.scale_factor());
    Rect {
        position: LogicalPosition::new(0.0, 0.0).into(),
        size: LogicalSize::new(size.width, size.height).into(),
    }
}

fn build_content_webview(
    window: &Window,
    ui: &WebView,
    proxy: &EventLoopProxy<UserEvent>,
    id: u32,
    private: bool,
    url: &str,
    bounds: Rect,
) -> wry::Result<WebView> {
    let (p_ipc, p_title, p_load, p_new, p_nav) = (proxy.clone(), proxy.clone(), proxy.clone(), proxy.clone(), proxy.clone());
    // Ziel der laufenden Hauptnavigation: diese Anfrage darf der Werbeblocker nie sperren (iframes schon).
    let main_nav = Rc::new(RefCell::new(url.to_owned()));
    let nav = main_nav.clone();
    // Alle Tabs teilen die WebView2-Umgebung der UI: ein Browser-, GPU- und Netzwerkprozess für alles.
    // Private Tabs laufen darin im InPrivate-Profil: Cookies, Cache, Verlauf und Logins liegen nur im
    // Arbeitsspeicher, sind von den normalen Tabs getrennt und verschwinden mit dem letzten privaten Tab.
    let webview = WebViewBuilder::new()
        .with_environment(ui.environment())
        .with_incognito(private)
        // Keine Startadresse: die lädt erst `pdf::intercept`, sobald PDFs abgefangen werden
        .with_bounds(bounds)
        .with_devtools(true)
        .with_initialization_script(if private { "" } else { include_str!("favicon-content.js") })
        .with_initialization_script(CONTENT_JS)
        .with_initialization_script(include_str!("passkey-policy.js"))
        .with_initialization_script(include_str!("autofill-content.js"))
        .with_ipc_handler(move |req| {
            let body = req.body().clone();
            // JSON = Frage nach Ausblend-Regeln, sonst ein Tastenkürzel
            let event = if body.starts_with('{') {
                let msg = serde_json::from_str::<Value>(&body).unwrap_or_default();
                if let Some(icon) = msg.get("favicon").and_then(Value::as_str) {
                    UserEvent::PageFavicon(id, req.uri().to_string(), icon.to_owned())
                } else if msg.get("autofill").is_some() {
                    UserEvent::AutofillRequest(id, req.uri().to_string(), body)
                } else if msg.get("pdf").is_some() {
                    UserEvent::PdfViewer(id)
                } else { UserEvent::Cosmetic(id, body) }
            } else { UserEvent::Content(body) };
            let _ = p_ipc.send_event(event);
        })
        .with_navigation_handler(move |url| {
            // Wry's PageLoadEvent::Started maps to ContentLoading on Windows, after
            // the server responds. NavigationStarting also covers the wait after
            // in-page links, history navigation and reloads.
            let _ = p_nav.send_event(UserEvent::Load(id, true, url.clone()));
            *nav.borrow_mut() = url;
            true
        })
        .with_document_title_changed_handler(move |title| {
            let _ = p_title.send_event(UserEvent::Title(id, title));
        })
        .with_on_page_load_handler(move |event, url| {
            if matches!(event, PageLoadEvent::Finished) {
                let _ = p_load.send_event(UserEvent::Load(id, false, url));
            }
        })
        .with_new_window_req_handler(move |url, _| {
            let _ = p_new.send_event(UserEvent::NewWindow(id, url));
            NewWindowResponse::Deny
        })
        .build_as_child(window)?;

    if !private {
        let proxy = proxy.clone();
        let _ = favicon::watch(&webview.webview(), move |icon| {
            let _ = proxy.send_event(UserEvent::Favicon(id, icon));
        });
    }

    // Glass supplies its own login picker; suppress WebView2's overlapping autofill UI.
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
        use windows::core::Interface;
        unsafe {
            let settings = webview.webview().Settings()?.cast::<ICoreWebView2Settings4>()?;
            settings.SetIsGeneralAutofillEnabled(false)?;
            settings.SetIsPasswordAutosaveEnabled(false)?;
        }
    }

    // Privat zusätzlich mit strengem Tracking-Schutz (gilt nur für das InPrivate-Profil).
    if private {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Profile3, ICoreWebView2_13, COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_STRICT,
        };
        use windows::core::Interface;
        let _ = unsafe {
            webview
                .webview()
                .cast::<ICoreWebView2_13>()
                .and_then(|wv| wv.Profile())
                .and_then(|profile| profile.cast::<ICoreWebView2Profile3>())
                .and_then(|profile| profile.SetPreferredTrackingPreventionLevel(COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_STRICT))
        };
    }

    let docs = pdf::Documents::default();
    watch_requests(&webview, ui, proxy, id, main_nav, docs.clone());
    let (core, first) = (webview.webview(), windows::core::HSTRING::from(url));
    pdf::intercept(&webview.webview(), docs, move || {
        let _ = unsafe { core.Navigate(&first) };
    });

    // wry meldet Vollbild nicht weiter – also direkt am WebView2-Ereignis lauschen.
    let p_fs = proxy.clone();
    let handler = webview2_com::ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(sender) = sender {
            let mut on = windows::core::BOOL::default();
            unsafe { sender.ContainsFullScreenElement(&mut on)? };
            let _ = p_fs.send_event(UserEvent::Fullscreen(id, on.as_bool()));
        }
        Ok(())
    }));
    let mut token = 0;
    let _ = unsafe { webview.webview().add_ContainsFullScreenElementChanged(&handler, &mut token) };

    let p_focus = proxy.clone();
    let handler = webview2_com::FocusChangedEventHandler::create(Box::new(move |_, _| {
        let _ = p_focus.send_event(UserEvent::Focus(id));
        Ok(())
    }));
    let _ = unsafe { webview.controller().add_GotFocus(&handler, &mut token) };
    Ok(webview)
}

/// Werbeblocker: jede Anfrage der Seite (auch aus iframes und Service Workern) läuft durch die Filter-Engine;
/// gesperrte bekommen sofort eine leere 403-Antwort und gehen gar nicht erst ins Netz.
fn watch_requests(webview: &WebView, ui: &WebView, proxy: &EventLoopProxy<UserEvent>, id: u32, main_nav: Rc<RefCell<String>>, docs: pdf::Documents) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::{Interface, PWSTR};
    let wv = webview.webview();
    let all = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
    let filtered = unsafe {
        match wv.cast::<ICoreWebView2_22>() {
            Ok(wv22) => wv22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                windows::core::w!("*"),
                all,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            ),
            Err(_) => wv.AddWebResourceRequestedFilter(windows::core::w!("*"), all),
        }
    };
    if filtered.is_err() {
        return;
    }
    let env = ui.environment();
    let proxy = proxy.clone();
    let handler = webview2_com::WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
        let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
        unsafe {
            let mut uri = PWSTR::null();
            args.Request()?.Uri(&mut uri)?;
            let uri = webview2_com::take_pwstr(uri);
            // Der PDF-Viewer und seine Dateien kommen aus der Exe (siehe pdf.rs)
            if let Some((status, mime, body)) = pdf::serve(&docs, &uri, wallpaper) {
                let stream = windows::Win32::UI::Shell::SHCreateMemStream(Some(&body));
                let headers = format!("Content-Type: {mime}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store");
                let reason = if status == 200 { windows::core::w!("OK") } else { windows::core::w!("Not Found") };
                let response = env.CreateWebResourceResponse(stream.as_ref(), status as i32, reason, &windows::core::HSTRING::from(headers))?;
                args.SetResponse(&response)?;
                return Ok(());
            }
            let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
            args.ResourceContext(&mut context)?;
            let kind = match context {
                // Die Seite selbst nie sperren – nur Dokumente in iframes
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT if *main_nav.borrow() == uri => return Ok(()),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "sub_frame",
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "xhr",
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT => "csp_report",
                _ => "other",
            };
            let mut source = PWSTR::null();
            sender.Source(&mut source)?;
            let source = webview2_com::take_pwstr(source);
            if blocker::should_block(&uri, &source, kind) {
                let response = env.CreateWebResourceResponse(None, 403, windows::core::w!("Blocked"), windows::core::w!(""))?;
                args.SetResponse(&response)?;
                let _ = proxy.send_event(UserEvent::Blocked(id));
            }
        }
        Ok(())
    }));
    let mut token = 0;
    let _ = unsafe { wv.add_WebResourceRequested(&handler, &mut token) };
}

/// Teilt den Skripten in der Seite mit, wo der Werbeblocker aus ist (`window.__glassAdblockOff`).
/// Läuft bei jedem neuen Dokument vor den Skripten der Seite; das alte Skript wird dabei ersetzt.
fn set_adblock_flag(webview: &WebView, slot: &ScriptSlot) {
    use windows::core::HSTRING;
    let wv = webview.webview();
    if let Some(old) = slot.borrow_mut().take() {
        let _ = unsafe { wv.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(old)) };
    }
    let js = format!(
        "Object.defineProperty(window, '__glassAdblockOff', {{ value: Object.freeze({}), configurable: true }});",
        json!(blocker::allowed_sites())
    );
    let slot = slot.clone();
    let handler = webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, id| {
        if result.is_ok() {
            *slot.borrow_mut() = Some(id);
        }
        Ok(())
    }));
    let _ = unsafe { wv.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(js), &handler) };
}

/// Adresse, Hostname oder Suchbegriff → URL.
/// Eingabe als Webadresse, falls sie wie eine aussieht – sonst `None` (dann ist es ein Suchbegriff).
fn as_url(input: &str) -> Option<String> {
    let s = input.trim();
    if s.contains("://") || s.starts_with("about:") || s.starts_with("data:") {
        return Some(s.to_owned());
    }
    let host = s.split(['/', '?', '#']).next().unwrap_or_default();
    if !s.contains(char::is_whitespace) {
        if host.starts_with("localhost") || host.starts_with("127.0.0.1") {
            return Some(format!("http://{s}"));
        }
        if host.contains('.') && !host.starts_with('.') && !host.ends_with('.') {
            return Some(format!("https://{s}"));
        }
    }
    None
}

/// Adresse oder, wenn es keine ist, Google-Suche (für Adressen auf der Kommandozeile).
fn resolve_input(input: &str) -> String {
    as_url(input).unwrap_or_else(|| format!("https://www.google.com/search?q={}", url_encode(input.trim())))
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".to_owned(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn resize_direction(value: &str) -> Option<ResizeDirection> {
    Some(match value {
        "n" => ResizeDirection::North,
        "s" => ResizeDirection::South,
        "e" => ResizeDirection::East,
        "w" => ResizeDirection::West,
        "ne" => ResizeDirection::NorthEast,
        "nw" => ResizeDirection::NorthWest,
        "se" => ResizeDirection::SouthEast,
        "sw" => ResizeDirection::SouthWest,
        _ => return None,
    })
}

/// Aktuelles Desktop-Hintergrundbild – die Oberfläche legt es wie macOS hinter das Glas.
fn wallpaper() -> Option<Vec<u8>> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let mut buf = [0u16; 1024];
    let mut len = std::mem::size_of_val(&buf) as u32;
    let ok = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            wide(r"Control Panel\Desktop").as_ptr(),
            wide("WallPaper").as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as _,
            &mut len,
        ) == 0
    };
    let registry_path = ok.then(|| {
        let chars = (len as usize / 2).saturating_sub(1);
        std::path::PathBuf::from(String::from_utf16_lossy(&buf[..chars]))
    });
    // Fallback: die Kopie, die Windows selbst für den Desktop erzeugt.
    let transcoded = std::env::var_os("APPDATA")
        .map(|p| std::path::PathBuf::from(p).join(r"Microsoft\Windows\Themes\TranscodedWallpaper"));
    registry_path.into_iter().chain(transcoded).find_map(|p| std::fs::read(p).ok())
}

fn serve_ui(request: wry::http::Request<Vec<u8>>) -> wry::http::Response<std::borrow::Cow<'static, [u8]>> {
    use std::borrow::Cow;
    let (mime, body): (&str, Cow<'static, [u8]>) = match request.uri().path() {
        "/autofill-ui.js" => ("text/javascript; charset=utf-8", Cow::Borrowed(include_bytes!("autofill-ui.js"))),
        "/glass-rim.js" => ("text/javascript; charset=utf-8", Cow::Borrowed(include_bytes!("glass-rim.js"))),
        "/glass-lens.js" => ("text/javascript; charset=utf-8", Cow::Borrowed(include_bytes!("glass-lens.js"))),
        "/group-hover.js" => ("text/javascript; charset=utf-8", Cow::Borrowed(include_bytes!("group-hover.js"))),
        "/animation-debug.js" => ("text/javascript; charset=utf-8", Cow::Borrowed(include_bytes!("animation-debug.js"))),
        "/wallpaper" => match wallpaper() {
            Some(bytes) => {
                let mime = if bytes.starts_with(b"\x89PNG") { "image/png" } else { "image/jpeg" };
                (mime, Cow::Owned(bytes))
            }
            None => ("text/plain", Cow::Borrowed(b"")),
        },
        _ => ("text/html; charset=utf-8", Cow::Borrowed(UI_HTML.as_bytes())),
    };
    wry::http::Response::builder()
        .header(wry::http::header::CONTENT_TYPE, mime)
        .status(if body.is_empty() { 404 } else { 200 })
        .body(body)
        .unwrap()
}

/// Windows 11: echtes Acrylic-Glas im ganzen Fenster, dunkel und mit runden Ecken.
///
/// Der DWM-Rahmen wird über den gesamten Client-Bereich erweitert; dort, wo das Fenster
/// schwarz gemalt ist (siehe `with_background_color`), zeigt Windows das Backdrop.
fn style_frame(window: &Window) {
    use windows_sys::Win32::{
        Graphics::Dwm::{
            DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
        },
        UI::Controls::MARGINS,
    };
    let hwnd = window.hwnd() as _;
    let set = |attr: i32, value: i32| unsafe {
        DwmSetWindowAttribute(hwnd, attr as _, &value as *const _ as _, 4);
    };
    set(DWMWA_USE_IMMERSIVE_DARK_MODE as _, 1);
    window_frame::sync(window, false);
    // Die Web-Oberfläche zeichnet den Rahmen selbst, auch unter Windows 10.
    set(DWMWA_BORDER_COLOR as _, DWMWA_COLOR_NONE as _);
    let margins = MARGINS { cxLeftWidth: -1, cxRightWidth: -1, cyTopHeight: -1, cyBottomHeight: -1 };
    unsafe { DwmExtendFrameIntoClientArea(hwnd, &margins) };

    // Die Oberfläche zeichnet das Wallpaper selbst und rundet ihre Ecken wie Windows (8 px)
    // (siehe `--radius` in ui.html); außerhalb davon ist das Fenster durchsichtig. Acrylic nur als Ersatz.
    if wallpaper().is_none() && window_vibrancy::apply_acrylic(window, None).is_err() {
        let _ = window_vibrancy::apply_mica(window, Some(true));
    }
}


fn main() -> wry::Result<()> {
    // Nach einem Update zuerst auf die alte Instanz warten – beide dürfen WebView2 nicht gleichzeitig öffnen.
    let args = update::startup(std::env::args().skip(1).collect());
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // Icon aus der Exe (Ressource 1, eingebettet von build.rs) – Windows wählt je Stelle die passende Größe
    let icon = |px: u32| Icon::from_resource(1, Some(tao::dpi::PhysicalSize::new(px, px))).ok();
    let window = WindowBuilder::new()
        .with_title("Glass")
        .with_window_icon(icon(32))
        .with_taskbar_icon(icon(256))
        .with_inner_size(tao::dpi::LogicalSize::new(1280.0, 820.0))
        .with_min_inner_size(tao::dpi::LogicalSize::new(480.0, 320.0))
        .with_decorations(false)
        .with_transparent(true)
        .with_undecorated_shadow(true)
        .with_theme(Some(Theme::Dark))
        .with_background_color((0, 0, 0, 255))
        .build(&event_loop)
        .expect("Fenster konnte nicht erstellt werden");
    style_frame(&window);

    let data_dir = std::env::var_os("LOCALAPPDATA")
        .map(|p| std::path::PathBuf::from(p).join("GlassBrowser"))
        .unwrap_or_else(|| std::env::temp_dir().join("GlassBrowser"));
    blocker::init(data_dir.clone());
    let mut web_context = WebContext::new(Some(data_dir));

    let p_ui = proxy.clone();
    let ui = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_asynchronous_custom_protocol("glass".into(), |_, request, responder| {
            if request.uri().path() == "/suggest" {
                // Netzwerkabruf im Hintergrund, damit die Oberfläche nicht hängt
                let query = request.uri().query().map(str::to_owned);
                std::thread::spawn(move || responder.respond(suggest::respond(query.as_deref())));
            } else {
                responder.respond(serve_ui(request));
            }
        })
        .with_url(UI_URL)
        .with_transparent(true)
        .with_bounds(full_bounds(&window))
        .with_default_context_menus(false)
        .with_scroll_bar_style(wry::ScrollBarStyle::FluentOverlay)
        .with_browser_accelerator_keys(false)
        // Wrys Standard-Argumente beibehalten; zusätzlich immer das ganze Bild neu zeichnen: Bei Teil-Neuzeichnungen
        // liest die Glas-Linse (SVG-Filter im backdrop-filter) sonst ihr eigenes altes Bild ein → flackernde Geisterschrift.
        // Verbindungen und DNS-Cache nicht nach Webseite trennen: Nur so kann ein Tab die Verbindung nutzen, die die
        // Oberfläche beim Tippen vorgewärmt hat (warmUp in ui.html). Gemessen: DNS + TLS 0 statt ~60 ms. Cookies bleiben getrennt.
        .with_additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,PartitionConnectionsByNetworkIsolationKey,SplitHostCacheByNetworkIsolationKey --ui-disable-partial-swap",
        )
        .with_ipc_handler(move |req| {
            if req.uri().to_string() == UI_URL {
                let _ = p_ui.send_event(UserEvent::Ui(req.body().clone()));
            }
        })
        .build(&window)?;

    // Auf Updates prüfen: kurz nach dem Start, danach alle 6 Stunden (nur Builds aus GitHub Actions)
    if update::current_build().is_some() {
        let p_update = proxy.clone();
        std::thread::spawn(move || {
            let mut offered = 0;
            std::thread::sleep(std::time::Duration::from_secs(5));
            loop {
                if let Some(r) = update::check().filter(|r| r.build > offered) {
                    offered = r.build;
                    let _ = p_update.send_event(UserEvent::UpdateAvailable(r.build, r.notes, r.url));
                }
                std::thread::sleep(std::time::Duration::from_secs(6 * 3600));
            }
        });
    }

    // Jede Minute nachsehen, ob Hintergrund-Tabs schlafen gehen können (siehe `sleep_idle_tabs`)
    let p_sleep = proxy.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        if p_sleep.send_event(UserEvent::SleepTabs).is_err() {
            break;
        }
    });

    let icloud = autofill::start(proxy.clone());
    let _ = icloud.send(json!({"id": 0, "op": "probe"}));
    let mut browser = Browser {
        icloud, autofill: None, autofill_seq: 0,
        window, ui, tabs: Vec::new(), active: 0, next_id: 1, proxy,
        fullscreen: false, was_maximized: false, overlay: None, split: None, resize_preview: None, hover: None, update: None,
        chrome_hidden: false, chrome_slide: None,
    };
    // `glass-browser.exe https://a.de b.de` öffnet jede Adresse in einem eigenen Tab.
    let start_urls: Vec<String> = args.iter().map(|a| resolve_input(a)).collect();
    if start_urls.is_empty() {
        browser.new_tab(None, false);
    }
    for url in start_urls {
        browser.new_tab(Some(url), false);
    }

    event_loop.run(move |event, _, control_flow| {
        // Solange das Fenster aktiv ist, regelmäßig die Mausposition prüfen (siehe `poll_hover`)
        // (Vordergrund statt is_focused(): Hat eine Webseite den Fokus, gilt das Hauptfenster für tao als unfokussiert.)
        let foreground = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() }
            == browser.window.hwnd() as *mut core::ffi::c_void;
        // Gleitet die Leiste gerade, läuft die Schleife ohne Pause – den Takt gibt DwmFlush vor (`slide_chrome`).
        *control_flow = if browser.chrome_slide.is_some() {
            ControlFlow::Poll
        } else if foreground {
            ControlFlow::WaitUntil(std::time::Instant::now() + std::time::Duration::from_millis(16))
        } else {
            ControlFlow::Wait
        };
        match event {
            Event::NewEvents(tao::event::StartCause::ResumeTimeReached { .. } | tao::event::StartCause::Poll) => {
                browser.slide_chrome();
                browser.poll_hover();
            }
            Event::WindowEvent { event, .. } => match event {
                WindowEvent::CloseRequested => *control_flow = ControlFlow::Exit,
                WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                    browser.dismiss_autofill();
                    browser.layout();
                    browser.sync_ui();
                    browser.sync_geometry();
                }
                WindowEvent::Moved(_) => browser.sync_geometry(),
                WindowEvent::Focused(_) => browser.sync_ui(),
                _ => {}
            },
            Event::UserEvent(event) => {
                if !browser.handle(event) {
                    *control_flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }
    });
}
