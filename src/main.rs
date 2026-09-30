#![windows_subsystem = "windows"]

mod blocker;
mod suggest;
mod update;
mod window_frame;
mod autofill;
mod favicon;
mod resize_preview;
mod clipboard;
mod drawing;
mod downloads;
mod session;
mod history;
mod sites;
mod page_menu;
mod permissions;
mod settings;

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
/// Breite der Leiste, wenn sie links statt oben steht (Rechtsklick auf die Leiste → „Leiste links“).
const SIDEBAR_WIDTH: f64 = 240.0;
/// Eingeklappte Leiste links (Rechtsklick → „Leiste einklappen“): nur noch die Logos der Tabs.
const SIDEBAR_COLLAPSED_WIDTH: f64 = 56.0;
/// Rand um den Seiteninhalt; bleibt gleichzeitig Greifzone zum Ändern der Fenstergröße.
const MARGIN: f64 = 4.0;
/// Kleinste Fenstergröße: Startbildschirm mit allen Vorschlägen unter dem Suchfeld und dem Anbieter-Rad daneben
/// (ui.html: body.start .address). Mit Leiste links kommt deren Breite hinzu.
const MIN_WIDTH: f64 = 760.0;
const MIN_HEIGHT: f64 = 640.0;
fn min_size(chrome_left: bool) -> LogicalSize<f64> {
    LogicalSize::new(MIN_WIDTH + if chrome_left { SIDEBAR_WIDTH } else { 0.0 }, MIN_HEIGHT)
}
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
    /// Neuer Text in der Zwischenablage (aus Glass oder einem anderen Programm).
    Clipboard(String),
    /// Eine Webseite meldet Einfügen, Pfeiltaste oder Ende beim Blättern im Verlauf (JSON aus clipboard-content.js).
    ClipboardPage(u32, String),
    /// Bild der Seite hinter der Liste (Nummer der Liste, JPEG als data:-URL), siehe `clipboard::Session`.
    ClipboardBackdrop(u64, String),
    /// Zeichnen auf einer Webseite: Tab, Adresse des sendenden Dokuments, JSON aus drawing-content.js.
    Drawing(u32, String, String),
    /// Ein Download dieses Tabs hat begonnen oder ist weitergekommen (siehe downloads.rs).
    Download(u32, downloads::Change),
    /// Suche auf der Seite: aktiver Treffer (ab 1, 0 = keiner) und Anzahl.
    Found(u32, i32, i32),
    /// Zoom der Seite hat sich geändert (Strg+Mausrad, Strg +/−, Glass selbst).
    Zoom(u32, f64),
    /// Ton: spielt gerade etwas, ist der Tab stumm?
    Audio(u32, bool, bool),
    /// Rechtsklick in einer Webseite (Beschreibung aus page_menu.rs).
    ContextMenu(u32, Value),
    /// Eine Webseite fragt nach einer Berechtigung (Nummer der Anfrage, siehe permissions.rs).
    Permission(u32),
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
    /// Die Seite ist im Zeichenmodus (Stift in der Leiste, siehe drawing-content.js).
    drawing: bool,
    /// Von einer Webseite geöffnet (Link in neuem Tab): War darin nur ein Download, schließt Glass ihn wieder.
    popup: bool,
    /// Aus der letzten Sitzung oder wieder geöffnet: Die Seite lädt erst, wenn der Tab angezeigt wird.
    lazy: bool,
    /// Zoom der Seite (1.0 = 100 %) und die Website, zu der er gehört.
    zoom: f64,
    zoom_host: String,
    /// Die Seite spielt Ton ab / ist stummgeschaltet (Lautsprecher am Tab).
    audio: bool,
    muted: bool,
}

impl Tab {
    fn blank(id: u32, private: bool) -> Tab {
        Tab {
            id, title: String::new(), favicon: String::new(), page_favicon: String::new(), url: String::new(), loading: false,
            private, blocked: 0, adblock_flag: ScriptSlot::default(), webview: None, home: false, pending_prompt: None,
            hidden_since: Cell::new(None), drawing: false, popup: false, lazy: false, zoom: 1.0, zoom_host: String::new(),
            audio: false, muted: false,
        }
    }

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
    /// Offene Overlays der Oberfläche über der Webseite, je Quelle (`key`, sonst „main“): x, y, Breite, Höhe,
    /// Eckradius (logische px). Die ausgeklappte Leiste links kann z. B. zugleich mit den Vorschlägen offen sein.
    overlay: Vec<(String, [f64; 5])>,
    /// Zuletzt an die Oberfläche gemeldete Mausposition (siehe `poll_hover`).
    hover: Option<(i32, i32, bool)>,
    split: Option<Split>,
    resize_preview: Option<(u64, bool)>,
    /// Gefundenes Update (Build-Nummer, Änderungen, Download-Adresse) – wird im Modal angeboten.
    update: Option<(u32, String, String)>,
    /// Die Oberfläche hat die Leiste ausgeblendet: Webseiten reichen dann bis an den Rand.
    chrome_hidden: bool,
    /// Die Leiste steht links statt oben (Einstellung der Oberfläche, dort gespeichert).
    chrome_left: bool,
    /// Leiste links ist eingeklappt (nur die Logos der Tabs).
    chrome_collapsed: bool,
    /// Die Seiten gleiten gerade: Beginn, linke obere Ecke vorher und nachher.
    chrome_slide: Option<(std::time::Instant, [f64; 2], [f64; 2])>,
    /// Tempo der Animationen: 1, in der Zeitlupe der Oberfläche (Strg+Umschalt+F8) 0,05 – sonst glitte die Seite
    /// in normalem Tempo, während die Leiste in Zeitlupe hinterherkriecht.
    animation_rate: f64,
    /// Die letzten kopierten Texte, neuester zuerst.
    clips: clipboard::History,
    /// Gerade offene Liste nach Strg+V.
    clip: Option<clipboard::Session>,
    /// Gespeicherte Zeichnungen auf Webseiten.
    drawings: drawing::Store,
    /// Laufende und letzte Downloads (Symbol rechts oben).
    downloads: downloads::Shared,
    /// WebViews geschlossener Tabs, deren Downloads noch laufen – mit der WebView endete sonst auch der Download.
    parked: Vec<(u32, WebView)>,
    /// Offene Tabs für den nächsten Start.
    session: session::Session,
    /// Zuletzt geschlossene Tabs (Platz in der Leiste, Adresse) für Strg+Umschalt+T, neuester zuletzt.
    closed: Vec<(usize, session::Entry)>,
    /// Besuchte Seiten (Vorschläge im Adressfeld, Strg+H).
    history: history::Shared,
    /// Zoom und Berechtigungen je Website.
    sites: sites::Sites,
    /// Tabs, deren Suche schon an Glass meldet (siehe `find`).
    find_hooked: std::collections::HashSet<u32>,
    /// Offenes Rechtsklick-Menü einer Webseite.
    menus: page_menu::Shared,
    /// Wartende Berechtigungsanfragen.
    permissions: permissions::Shared,
    settings: settings::Settings,
}

impl Browser {
    /// Tabs zeigt die Zeile oben, sobald etwas offen ist – nur bei einem einzigen leeren Tab fehlen sie.
    fn show_tabbar(&self) -> bool {
        self.tabs.len() > 1 || self.tabs.iter().any(|t| t.webview.is_some() || !t.url.is_empty())
    }

    /// Breite der Leiste links, eingeklappt oder nicht.
    fn sidebar_width(&self) -> f64 {
        if self.chrome_collapsed { SIDEBAR_COLLAPSED_WIDTH } else { SIDEBAR_WIDTH }
    }

    /// Dauer der Gleitbewegung in Sekunden (in der Zeitlupe entsprechend länger).
    fn chrome_slide_duration(&self) -> f64 {
        CHROME_SLIDE.as_secs_f64() / self.animation_rate
    }

    fn chrome_height(&self) -> f64 {
        TOOLBAR_HEIGHT
    }

    /// Fläche für Webseiten unter (bzw. rechts neben) der Leiste. Ist die Leiste ausgeblendet, bleibt nur der Rand
    /// frei – fährt die Maus dorthin, holt die Oberfläche die Leiste zurück.
    fn resting_area(&self) -> Area {
        let size = self.window.inner_size().to_logical::<f64>(self.window.scale_factor());
        let (left, top) = match (self.chrome_hidden, self.chrome_left) {
            (true, _) => (MARGIN, MARGIN),
            (false, true) => (self.sidebar_width(), MARGIN),
            (false, false) => (MARGIN, self.chrome_height()),
        };
        [left, top, size.width - left - MARGIN, size.height - top - MARGIN]
    }

    /// Wie `resting_area`, nur mitten im Gleiten: Dann hat die Seite schon ihre volle Höhe und wird nur
    /// verschoben – so muss Chromium nicht in jedem Bild neu umbrechen. Was unten übersteht, schneidet das Fenster ab.
    fn content_area(&self) -> Area {
        let Some((start, from, to)) = self.chrome_slide else { return self.resting_area() };
        let size = self.window.inner_size().to_logical::<f64>(self.window.scale_factor());
        let e = chrome_ease((start.elapsed().as_secs_f64() / self.chrome_slide_duration()).min(1.0));
        // Nicht auf ganze Pixel runden: wry rechnet in physische Pixel um, sonst wären die Schritte ungleich groß
        let [x, y] = [0, 1].map(|k| from[k] + (to[k] - from[k]) * e);
        [x, y, size.width - 2.0 * MARGIN, size.height - 2.0 * MARGIN]
    }

    /// Ein Bild der Gleitbewegung: die sichtbaren Seiten nur verschieben, am Ende regulär auslegen.
    /// Die Ereignisschleife läuft dabei ungebremst; DwmFlush wartet auf das nächste Bild des Bildschirms –
    /// so kommt genau eine Position pro Bild an (ein 16-ms-Timer träfe bei 15,6-ms-Auflösung oft nur jedes zweite).
    fn slide_chrome(&mut self) {
        let Some((start, ..)) = self.chrome_slide else { return };
        unsafe { windows_sys::Win32::Graphics::Dwm::DwmFlush() };
        if start.elapsed().as_secs_f64() >= self.chrome_slide_duration() {
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
                for &(_, [x, y, w, h, r]) in &self.overlay {
                    // Overlay-Koordinaten sind Fensterkoordinaten, die Region zählt ab der Webseiten-Ecke.
                    let (x, y) = (x - left, y - top);
                    let hole = CreateRoundRectRgn(px(x), px(y), px(x + w) + 1, px(y + h) + 1, px(2.0 * r), px(2.0 * r));
                    CombineRgn(region, region, hole, RGN_DIFF);
                    DeleteObject(hole);
                }
                // Die Zwischenablage-Liste gleitet mit ihrer Seite mit – ihre Aussparung zählt deshalb ab der Seite
                if let Some([x, y, w, h, r]) = self.clip.as_ref().filter(|s| s.tab == self.tabs[i].id).and_then(|s| s.hole) {
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
                    "drawing": t.drawing && t.shows_page(),
                    "zoom": t.zoom, "audio": t.audio, "muted": t.muted,
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
            "chromeLeft": self.chrome_left,
            "chromeWidth": self.sidebar_width(),
            "tabbar": self.show_tabbar(),
            "split": self.split.as_ref().map(|s| json!({ "left": s.left, "right": s.right, "ratio": s.ratio })),
            // Zielposition auch mitten im Gleiten – die Oberfläche animiert ihre Rahmen selbst dorthin
            "panes": self.panes_in(self.resting_area()).iter().map(|(i, [x, y, w, h])| json!({ "id": self.tabs[*i].id, "x": x, "y": y, "w": w, "h": h })).collect::<Vec<_>>(),
        });
        let _ = self.ui.evaluate_script(&format!("window.render({state})"));
        self.save_session();
    }

    /// Was von einem Tab für später bleibt: Adresse, Titel und Symbol (private und leere Tabs nichts).
    fn entry_of(tab: &Tab) -> Option<session::Entry> {
        let favicon = if tab.page_favicon.is_empty() { &tab.favicon } else { &tab.page_favicon };
        (!tab.private && !tab.home && !tab.url.is_empty())
            .then(|| session::Entry { url: tab.url.clone(), title: tab.title.clone(), favicon: favicon.clone() })
    }

    fn save_session(&self) {
        let mut active = 0;
        let mut entries = Vec::new();
        for (i, tab) in self.tabs.iter().enumerate() {
            if let Some(entry) = Self::entry_of(tab) {
                if i <= self.active {
                    active = entries.len();
                }
                entries.push(entry);
            }
        }
        self.session.save(&entries, active.min(entries.len().saturating_sub(1)));
    }

    /// Gemerkten Tab an Stelle `index` einfügen, ohne ihn schon zu laden (siehe `Tab::lazy`).
    fn insert_lazy(&mut self, index: usize, entry: session::Entry) -> usize {
        let id = self.next_id;
        self.next_id += 1;
        let index = index.min(self.tabs.len());
        self.tabs.insert(index, Tab { title: entry.title, favicon: entry.favicon, url: entry.url, lazy: true, ..Tab::blank(id, false) });
        index
    }

    /// Strg+Umschalt+T: den zuletzt geschlossenen Tab an seinem alten Platz wieder öffnen. Steht nur ein leerer Tab
    /// da (Startbildschirm), tritt der wieder geöffnete an seine Stelle.
    fn reopen_tab(&mut self) {
        let Some((index, entry)) = self.closed.pop() else { return };
        let lone_empty = self.tabs.len() == 1 && self.tabs[0].webview.is_none() && self.tabs[0].url.is_empty();
        if lone_empty {
            self.tabs.clear();
        }
        let at = self.insert_lazy(index, entry);
        self.activate(at);
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
        self.tabs.push(Tab { url: url_text, loading, ..Tab::blank(id, private) });
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
        let tab = self.tabs.remove(idx);
        self.permissions.borrow_mut().drop_tab(tab.id);
        if let Some(entry) = Self::entry_of(&tab) {
            self.closed.push((idx, entry));
            if self.closed.len() > 25 {
                self.closed.remove(0);
            }
        }
        self.park(tab.id, tab.webview);
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
        // Gemerkter Tab: erst jetzt laden (navigate_to legt die Seite gleich richtig aus)
        if std::mem::take(&mut self.tabs[self.active].lazy) {
            let url = self.tabs[self.active].url.clone();
            self.navigate_to(url);
        }
        self.layout();
        if let Some(wv) = &self.tabs[self.active].webview {
            let _ = wv.focus();
        }
        self.sync_ui();
        self.show_permission();
    }

    /// Älteste wartende Berechtigungsanfrage des aktiven Tabs in der Oberfläche zeigen (oder die Leiste schließen).
    fn show_permission(&self) {
        let pending = self.permissions.borrow();
        let tab = self.tabs.get(self.active).map(|t| t.id).unwrap_or_default();
        let info = pending.of_tab(tab).first().and_then(|id| pending.get(*id).map(|r| (id, r))).map(|(id, r)| {
            json!({ "id": id, "host": sites::host(&r.url), "kind": r.kind })
        });
        let _ = self.ui.evaluate_script(&format!("window.showPermission?.({})", info.unwrap_or(Value::Null)));
    }

    /// Antwort auf eine Berechtigungsanfrage; normale Tabs merken sie sich für die Website.
    fn answer_permission(&mut self, id: u32, allow: bool) {
        let request = self.permissions.borrow_mut().answer(id, Some(allow));
        if let Some(r) = request {
            if self.index_of(r.tab).is_some_and(|i| !self.tabs[i].private) {
                self.sites.set_permission(&r.url, r.kind, Some(allow));
            }
        }
        self.show_permission();
    }

    /// Werbeblocker-Ausnahmen haben sich geändert: allen Seiten die neue Liste geben.
    fn refresh_adblock_flags(&self) {
        for tab in &self.tabs {
            if let Some(wv) = &tab.webview {
                set_adblock_flag(wv, &tab.adblock_flag);
            }
        }
    }

    /// Seiteninfo (Schloss rechts oben): Verbindung, Zoom, Werbeblocker und Berechtigungen der aktiven Seite.
    fn site_info(&self) {
        let Some(tab) = self.tabs.get(self.active).filter(|t| t.shows_page()) else { return };
        let info = json!({
            "host": sites::host(&tab.url), "origin": sites::origin(&tab.url), "secure": tab.url.starts_with("https://"),
            "zoom": tab.zoom, "adblock": !blocker::is_allowed(&tab.url), "blocked": tab.blocked, "private": tab.private,
            "permissions": self.sites.permissions(Some(&tab.url)),
        });
        let _ = self.ui.evaluate_script(&format!("window.setSiteInfo?.({info})"));
    }

    /// Stand für das Einstellungsfenster.
    fn settings_info(&self) {
        let download_dir = self.settings.download_dir.clone().unwrap_or_else(|| profile_download_dir(&self.ui.webview()));
        let info = json!({
            "restore": self.settings.restore_session, "downloadDir": download_dir, "customDir": self.settings.download_dir.is_some(),
            "adblockOff": blocker::allowed_sites(), "permissions": self.sites.permissions(None),
            "build": update::current_build(),
        });
        let _ = self.ui.evaluate_script(&format!("window.setSettings?.({info})"));
    }

    /// Rechtsklick-Menü einer Webseite an die Oberfläche: Stelle in Fensterkoordinaten umrechnen.
    fn show_context_menu(&mut self, id: u32, mut menu: Value) {
        let menu_id = menu["menu"].as_u64().unwrap_or_default() as u32;
        let Some((_, [x, y, ..])) = self.panes().into_iter().find(|(i, _)| self.tabs[*i].id == id) else {
            page_menu::pick(&self.menus, menu_id, -1);
            return;
        };
        let scale = self.window.scale_factor();
        menu["x"] = json!(x + menu["x"].as_f64().unwrap_or_default() / scale);
        menu["y"] = json!(y + menu["y"].as_f64().unwrap_or_default() / scale);
        menu["private"] = json!(self.index_of(id).is_some_and(|i| self.tabs[i].private));
        let _ = self.ui.focus();
        let _ = self.ui.evaluate_script(&format!("window.showContextMenu?.({menu})"));
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
                    let (id, proxy) = (tab.id, self.proxy.clone());
                    let notify: downloads::Notify = Rc::new(move |change| { let _ = proxy.send_event(UserEvent::Download(id, change)); });
                    downloads::watch(&wv.webview(), tab.id, tab.private, &self.downloads, notify);
                    watch_zoom_and_audio(wv, tab.id, &self.proxy);
                    let proxy = self.proxy.clone();
                    page_menu::watch(&wv.webview(), &self.menus, move |menu| { let _ = proxy.send_event(UserEvent::ContextMenu(id, menu)); });
                    let proxy = self.proxy.clone();
                    permissions::watch(&wv.webview(), id, &self.permissions, move |request| { let _ = proxy.send_event(UserEvent::Permission(request)); });
                    // Private Tabs haben ein eigenes Profil – auch dort gilt der gewählte Download-Ordner
                    if tab.private {
                        set_download_dir(&wv.webview(), self.settings.download_dir.as_deref());
                    }
                    tab.zoom = self.sites.zoom(&url);
                    tab.zoom_host = sites::host(&url);
                    let _ = wv.zoom(tab.zoom);
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

    /// Die WebView eines Tabs, der verschwindet: Laufen darin noch Downloads, bleibt sie unsichtbar bestehen, bis sie fertig sind.
    fn park(&mut self, tab: u32, webview: Option<WebView>) {
        if let Some(wv) = webview.filter(|_| self.downloads.borrow().busy(tab)) {
            let _ = wv.set_visible(false);
            self.parked.push((tab, wv));
        }
    }

    /// Stand der Downloads an die Oberfläche (`started`: gerade kam einer dazu).
    fn sync_downloads(&self, started: bool) {
        let list = self.downloads.borrow().to_json();
        let _ = self.ui.evaluate_script(&format!("window.setDownloads?.({list}, {started})"));
    }

    /// Ein Download begann in einem Tab ohne eigene Seite: Von einer Webseite geöffnet, schließt der Tab wieder;
    /// sonst (Adresse eingetippt) wird er wieder leer. Die WebView lädt unsichtbar zu Ende (`park`).
    fn drop_download_tab(&mut self, id: u32) {
        let Some(i) = self.index_of(id) else { return };
        if self.tabs[i].popup {
            self.close_tab(id);
            return;
        }
        let webview = self.tabs[i].webview.take();
        self.park(id, webview);
        // Neue Nummer: Späte Meldungen der alten WebView (Titel, Laden fertig) dürfen den leeren Tab nicht füllen
        let tab = &mut self.tabs[i];
        tab.id = self.next_id;
        self.next_id += 1;
        tab.url.clear();
        tab.title.clear();
        tab.favicon.clear();
        tab.page_favicon.clear();
        tab.loading = false;
        tab.home = false;
        tab.pending_prompt = None;
        self.layout();
        self.sync_ui();
        if i == self.active {
            self.focus_address();
        }
    }

    /// Suche auf der Seite (Leiste der Oberfläche, Strg+F): WebView2 sucht und markiert, Glass zeigt nur das Feld.
    fn find(&mut self, what: &str, term: &str) {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment15, ICoreWebView2_28};
        use windows::core::{Interface, HSTRING};
        let Some(tab) = self.tabs.get(self.active).filter(|t| t.shows_page()) else { return };
        let (id, Some(wv)) = (tab.id, tab.webview.as_ref()) else { return };
        let Ok(find) = (unsafe { wv.webview().cast::<ICoreWebView2_28>().and_then(|w| w.Find()) }) else { return };
        if self.find_hooked.insert(id) {
            let report = |proxy: EventLoopProxy<UserEvent>| {
                move |find: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Find>, _| {
                    if let Some(find) = find {
                        let (mut active, mut count) = (0, 0);
                        unsafe {
                            let _ = find.ActiveMatchIndex(&mut active);
                            let _ = find.MatchCount(&mut count);
                        }
                        let _ = proxy.send_event(UserEvent::Found(id, active, count));
                    }
                    Ok(())
                }
            };
            let mut token = 0;
            unsafe {
                let h = webview2_com::FindActiveMatchIndexChangedEventHandler::create(Box::new(report(self.proxy.clone())));
                let _ = find.add_ActiveMatchIndexChanged(&h, &mut token);
                let h = webview2_com::FindMatchCountChangedEventHandler::create(Box::new(report(self.proxy.clone())));
                let _ = find.add_MatchCountChanged(&h, &mut token);
            }
        }
        unsafe {
            match what {
                "start" if !term.is_empty() => {
                    let Ok(env) = self.ui.environment().cast::<ICoreWebView2Environment15>() else { return };
                    let Ok(options) = env.CreateFindOptions() else { return };
                    let _ = options.SetFindTerm(&HSTRING::from(term));
                    let _ = options.SetSuppressDefaultFindDialog(true);
                    let _ = options.SetShouldHighlightAllMatches(true);
                    let done = webview2_com::FindStartCompletedHandler::create(Box::new(|_| Ok(())));
                    let _ = find.Start(&options, &done);
                }
                "next" => { let _ = find.FindNext(); }
                "prev" => { let _ = find.FindPrevious(); }
                _ => {
                    let _ = find.Stop();
                    let _ = self.ui.evaluate_script("window.setFound?.(0, 0)");
                }
            }
        }
    }

    /// Zoom des aktiven Tabs: Stufen wie in Chrome, `0` = zurück auf 100 %.
    fn zoom_step(&mut self, step: i32) {
        const LEVELS: [f64; 15] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
        let Some(tab) = self.tabs.get(self.active).filter(|t| t.shows_page()) else { return };
        let now = tab.zoom;
        let next = match step {
            0 => 1.0,
            s if s > 0 => LEVELS.iter().copied().find(|l| *l > now + 0.001).unwrap_or(now),
            _ => LEVELS.iter().rev().copied().find(|l| *l < now - 0.001).unwrap_or(now),
        };
        if let Some(wv) = &tab.webview {
            let _ = wv.zoom(next);
        }
        // Eigene Änderungen meldet WebView2 nicht zuverlässig über ZoomFactorChanged
        let id = tab.id;
        let _ = self.proxy.send_event(UserEvent::Zoom(id, next));
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
        if !matches!(cmd, "split_resize_start" | "split_resize_ready" | "split_resize_end" | "overlay" | "chrome_hidden" | "chrome_side" | "animation_rate") {
            if let Some((token, _)) = self.resize_preview.take() {
                self.layout();
                let _ = self.ui.evaluate_script(&format!("window.finishResizePreview?.({token})"));
            }
        }
        if cmd == "autofill_pick" { self.autofill_pick(msg); return true; }
        if cmd == "autofill_retry" { self.autofill_retry(msg); return true; }
        if cmd == "autofill_dismiss" { self.dismiss_autofill(); return true; }
        if cmd == "clip_pick" { self.clip_pick(msg); return true; }
        let id = msg["id"].as_u64().map(|v| v as u32);
        if let Some(what) = cmd.strip_prefix("download_") {
            self.download_command(what, id);
            return true;
        }
        let value = msg["value"].as_str().unwrap_or_default();
        match cmd {
            "animation_debug" => { let _ = self.ui.evaluate_script("window.AnimationDebug?.toggle()"); }
            "ready" => {
                self.sync_ui();
                self.sync_geometry();
                self.show_update();
                self.sync_downloads(false);
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
            "reopen_tab" => self.reopen_tab(),
            // Rechtsklick-Menü: Eintrag gewählt (-1: nur geschlossen); danach bekommt die Seite den Fokus zurück
            "menu_pick" => {
                page_menu::pick(&self.menus, id.unwrap_or_default(), msg["value"].as_i64().unwrap_or(-1) as i32);
                if let Some(wv) = self.tabs.get(self.active).and_then(|t| t.webview.as_ref()) {
                    let _ = wv.focus();
                }
            }
            // Link oder Bild aus dem Menü: neuer Tab (im Hintergrund lädt er erst beim Anschauen)
            "open_tab" if value.starts_with("https://") || value.starts_with("http://") => {
                let private = msg["private"].as_bool().unwrap_or(false);
                if msg["background"].as_bool().unwrap_or(false) && !private {
                    let entry = session::Entry { url: value.to_owned(), title: String::new(), favicon: String::new() };
                    self.insert_lazy(self.active + 1, entry);
                    self.sync_ui();
                } else {
                    self.new_tab(Some(value.to_owned()), private);
                }
            }
            "print" => {
                use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER};
                use windows::core::Interface;
                if let Some(wv) = self.tabs.get(self.active).filter(|t| t.shows_page()).and_then(|t| t.webview.as_ref()) {
                    if let Ok(wv16) = wv.webview().cast::<ICoreWebView2_16>() {
                        let _ = unsafe { wv16.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER) };
                    }
                }
            }
            // ---- Seiteninfo ----
            "site_info" => self.site_info(),
            // Antwort ändern (`allow`: true/false) oder vergessen (null); ohne `origin` für die aktive Seite
            "site_permission" => {
                let url = msg["origin"].as_str().map(str::to_owned).or_else(|| self.tabs.get(self.active).map(|t| t.url.clone()));
                if let Some(url) = url {
                    self.sites.set_permission(&url, value, msg["allow"].as_bool());
                }
                if msg["origin"].is_string() { self.settings_info() } else { self.site_info() }
            }
            // Cookies und gespeicherte Daten der aktiven Website löschen, dann neu laden
            "site_clear_data" => {
                if let Some(tab) = self.tabs.get(self.active).filter(|t| t.shows_page()) {
                    let params = json!({ "origin": sites::origin(&tab.url), "storageTypes": "all" }).to_string();
                    if let Some(wv) = &tab.webview {
                        let done = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
                        unsafe {
                            let _ = wv.webview().CallDevToolsProtocolMethod(
                                &windows::core::HSTRING::from("Storage.clearDataForOrigin"), &windows::core::HSTRING::from(params), &done);
                        }
                        let _ = wv.reload();
                    }
                }
            }
            // ---- Einstellungen ----
            "settings" => {
                let _ = self.ui.focus();
                let _ = self.ui.evaluate_script("window.uiAction?.('settings')");
            }
            "settings_get" => self.settings_info(),
            "settings_restore" => {
                self.settings.restore_session = msg["on"].as_bool().unwrap_or(true);
                self.settings.save();
            }
            "settings_download_dir" => {
                let current = self.settings.download_dir.clone().unwrap_or_else(|| profile_download_dir(&self.ui.webview()));
                if let Some(dir) = settings::pick_folder(self.window.hwnd() as isize, &current) {
                    self.settings.download_dir = Some(dir);
                    self.settings.save();
                    self.apply_download_dir();
                }
                self.settings_info();
            }
            "settings_download_default" => {
                self.settings.download_dir = None;
                self.settings.save();
                self.apply_download_dir();
                self.settings_info();
            }
            "adblock_site" => {
                blocker::toggle(&format!("https://{value}/"));
                self.refresh_adblock_flags();
                self.settings_info();
                self.sync_ui();
            }
            "permissions_clear" => {
                self.sites.clear_permissions();
                self.settings_info();
            }
            // Cookies, Cache und gespeicherte Daten aller Websites (normales Profil), dazu der Verlauf
            "clear_browsing_data" => {
                use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Profile2, ICoreWebView2_13};
                use windows::core::Interface;
                let profile = unsafe { self.ui.webview().cast::<ICoreWebView2_13>().and_then(|w| w.Profile()) };
                if let Ok(p2) = profile.and_then(|p| p.cast::<ICoreWebView2Profile2>()) {
                    let done = webview2_com::ClearBrowsingDataCompletedHandler::create(Box::new(|_| Ok(())));
                    let _ = unsafe { p2.ClearBrowsingDataAll(&done) };
                }
                if let Ok(mut h) = self.history.lock() {
                    h.clear();
                }
            }
            // F11: ganzes Fenster über den Bildschirm, ohne Leiste
            "window_fullscreen" => {
                if self.fullscreen {
                    self.active_script("document.exitFullscreen?.()");
                }
                self.apply_fullscreen(!self.fullscreen);
                self.layout();
                self.sync_ui();
            }
            "permission" => {
                if let Some(request) = id {
                    self.answer_permission(request, value == "allow");
                }
            }
            "find_start" => self.find("start", value),
            "find_next" => self.find("next", ""),
            "find_prev" => self.find("prev", ""),
            "find_stop" => self.find("stop", ""),
            "zoom_in" => self.zoom_step(1),
            "zoom_out" => self.zoom_step(-1),
            "zoom_reset" => self.zoom_step(0),
            "mute" => {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
                use windows::core::Interface;
                let tab = id.and_then(|id| self.index_of(id)).map(|i| &self.tabs[i]);
                if let Some(wv8) = tab.and_then(|t| t.webview.as_ref()).and_then(|wv| wv.webview().cast::<ICoreWebView2_8>().ok()) {
                    let _ = unsafe { wv8.SetIsMuted(!tab.unwrap().muted) };
                }
            }
            "history_remove" => { if let Ok(mut h) = self.history.lock() { h.remove(value) } }
            "history_clear" => { if let Ok(mut h) = self.history.lock() { h.clear() } }
            // Tastenkürzel aus einer Webseite, die Tafeln der Oberfläche öffnen (Verlauf, Downloads …)
            "history" | "downloads" | "favorite" | "find" => {
                let _ = self.ui.focus();
                let _ = self.ui.evaluate_script(&format!("window.uiAction?.('{cmd}')"));
            }
            // Strg+1 … Strg+8: dieser Tab, Strg+9: der letzte
            tab if tab.starts_with("tab_") => {
                if let Ok(n) = tab[4..].parse::<usize>() {
                    let last = self.tabs.len() - 1;
                    self.activate(if n >= 9 { last } else { (n - 1).min(last) });
                }
            }
            // Schutzschild im Adressfeld: Werbeblocker für die Seite des aktiven Tabs an/aus, dann neu laden
            // Stift in der Leiste: Zeichenmodus der aktiven Seite an/aus (die Seite meldet den neuen Stand zurück)
            "draw" => {
                if let Some(wv) = self.tabs.get(self.active).filter(|t| t.shows_page()).and_then(|t| t.webview.as_ref()) {
                    let _ = wv.evaluate_script("window.__glassDraw?.toggle()");
                    let _ = wv.focus();
                }
            }
            "adblock_toggle" => {
                let url = self.tabs[self.active].url.clone();
                blocker::toggle(&url);
                self.refresh_adblock_flags();
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
                    let [x, y, ..] = self.content_area(); // mitten in einer Gleitbewegung: von dort aus weiter
                    self.chrome_hidden = hidden;
                    let [tx, ty, ..] = self.resting_area();
                    self.chrome_slide = Some((std::time::Instant::now(), [x, y], [tx, ty]));
                    self.layout();
                    self.sync_ui();
                }
            }
            // Zeitlupe der Oberfläche an/aus: gilt auch für das Gleiten der Seiten
            "animation_rate" => {
                self.animation_rate = msg["value"].as_f64().filter(|r| *r > 0.0).unwrap_or(1.0);
            }
            // Leiste oben oder links: Die Seiten springen sofort an ihren Platz – die Leiste baut sich ja auch um
            "chrome_side" => {
                let left = value == "left";
                let collapsed = msg["collapsed"].as_bool().unwrap_or(false);
                if left != self.chrome_left || collapsed != self.chrome_collapsed {
                    self.chrome_left = left;
                    self.chrome_collapsed = collapsed;
                    self.chrome_slide = None;
                    self.window.set_min_inner_size(Some(min_size(left)));
                    self.layout();
                    self.sync_ui();
                }
            }
            "overlay" => {
                let r = &msg["rect"];
                let key = msg["key"].as_str().unwrap_or("main");
                self.overlay.retain(|(k, _)| k != key);
                if key == "clipboard" {
                    self.clip_hole(r);
                } else if r.is_object() {
                    self.overlay.push((key.to_owned(), ["x", "y", "w", "h", "r"].map(|k| r[k].as_f64().unwrap_or_default())));
                }
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

    /// Bedienung der Download-Liste; die Oberfläche nennt nur die Nummer, Pfade kennt allein Rust.
    fn download_command(&mut self, what: &str, id: Option<u32>) {
        // Erst die Liste loslassen, dann WebView2 aufrufen: Abbrechen meldet sich sofort über `refresh` zurück
        let op = id.and_then(|id| self.downloads.borrow().operation(id));
        let path = id.and_then(|id| self.downloads.borrow().file(id));
        match what {
            "cancel" => { let _ = op.map(|o| unsafe { o.Cancel() }); }
            "resume" => { let _ = op.map(|o| unsafe { o.Resume() }); }
            "open" => { if let Some(p) = path { downloads::open(&p) } }
            "show" => { if let Some(p) = path { downloads::reveal(&p) } }
            "remove" if id.is_some() => self.downloads.borrow_mut().remove(id),
            "clear" => self.downloads.borrow_mut().remove(None),
            _ => return,
        }
        self.sync_downloads(false);
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
                // Leiste links oder oben ausgeblendet: Oben fehlt die Titelleiste – leere Stellen am oberen Rand der
                // Webseite ersetzen sie (content.js meldet nur Ziehen bzw. Doppelklick dort, wo nichts anklickbar ist)
                if (self.chrome_left || self.chrome_hidden) && !self.fullscreen {
                    match cmd.as_str() {
                        "window_drag" => { let _ = self.window.drag_window(); }
                        "window_maximize" => self.window.set_maximized(!self.window.is_maximized()),
                        _ => {}
                    }
                }
                let tab_number = cmd.len() == 5 && cmd.starts_with("tab_") && cmd.as_bytes()[4].is_ascii_digit() && cmd.as_bytes()[4] != b'0';
                if tab_number || matches!(cmd.as_str(), "new_tab" | "private_tab" | "close_tab" | "next_tab" | "prev_tab" | "focus_address" | "animation_debug" | "reopen_tab"
                    | "history" | "downloads" | "favorite" | "find" | "zoom_in" | "zoom_out" | "zoom_reset" | "settings" | "window_fullscreen") {
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
            UserEvent::Clipboard(text) => {
                // Kopien aus einem privaten Tab bleiben aus dem Verlauf
                if !(self.foreground() && self.tabs.get(self.active).is_some_and(|t| t.private)) {
                    self.clips.push(text);
                }
            }
            UserEvent::ClipboardPage(id, raw) => self.clip_page(id, &raw),
            UserEvent::Drawing(id, source, raw) => {
                let Some(i) = self.index_of(id) else { return true };
                let msg: Value = serde_json::from_str(&raw).unwrap_or_default();
                // Jede Nachricht sagt, ob die Seite gerade im Zeichenmodus ist (ein neues Dokument beginnt ohne)
                if let Some(on) = msg["on"].as_bool().filter(|on| *on != self.tabs[i].drawing) {
                    self.tabs[i].drawing = on;
                    self.sync_ui();
                }
                if let (Some(script), Some(wv)) = (self.drawings.handle(&source, &msg, self.tabs[i].private), &self.tabs[i].webview) {
                    let _ = wv.evaluate_script(&script);
                }
            }
            UserEvent::ClipboardBackdrop(seq, image) => self.clip_backdrop(seq, image),
            UserEvent::ContextMenu(id, menu) => self.show_context_menu(id, menu),
            UserEvent::Permission(request) => {
                let found = self.permissions.borrow().get(request).map(|r| (r.tab, r.url.clone(), r.kind));
                let Some((tab, url, kind)) = found else { return true };
                let private = self.index_of(tab).is_some_and(|i| self.tabs[i].private);
                // Schon entschieden? Private Tabs übernehmen nur Sperren, keine Freigaben
                match self.sites.permission(&url, kind) {
                    Some(allow) if !private || !allow => { self.permissions.borrow_mut().answer(request, Some(allow)); }
                    _ => self.show_permission(),
                }
            }
            UserEvent::Found(id, active, count) => {
                if self.tabs.get(self.active).is_some_and(|t| t.id == id) {
                    let _ = self.ui.evaluate_script(&format!("window.setFound?.({active}, {count})"));
                }
            }
            UserEvent::Zoom(id, factor) => {
                if let Some(i) = self.index_of(id) {
                    let tab = &mut self.tabs[i];
                    tab.zoom = factor;
                    if !tab.private && tab.shows_page() {
                        self.sites.set_zoom(&tab.url, factor);
                    }
                    self.sync_ui();
                }
            }
            UserEvent::Audio(id, audio, muted) => {
                if let Some(i) = self.index_of(id) {
                    let tab = &mut self.tabs[i];
                    if (tab.audio, tab.muted) != (audio, muted) {
                        (tab.audio, tab.muted) = (audio, muted);
                        self.sync_ui();
                    }
                }
            }
            UserEvent::Download(id, change) => {
                let started = matches!(change, downloads::Change::Started { .. });
                if let downloads::Change::Started { fresh: true } = change {
                    self.drop_download_tab(id);
                }
                // Fertig: WebViews geschlossener Tabs gehen jetzt wirklich zu
                let downloads = self.downloads.clone();
                self.parked.retain(|(tab, _)| downloads.borrow().busy(*tab));
                self.sync_downloads(started);
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
                    // Single-Page-Apps ändern die URL oft ohne echte Navigation – das ist dann auch ein Besuch.
                    let before = tab.url.clone();
                    if let Some(Ok(url)) = tab.webview.as_ref().map(|wv| wv.url()) {
                        tab.url = url;
                    }
                    if !tab.private && !tab.loading {
                        if let Ok(mut h) = self.history.lock() {
                            if tab.url != before { h.visit(&tab.url, &tab.title) } else { h.title(&tab.url, &tab.title) }
                        }
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
                if loading && self.clip.as_ref().is_some_and(|s| s.tab == id) { self.clip_end(true); }
                // Neue Seite: Anfragen der alten gelten nicht mehr
                if loading && !self.permissions.borrow().of_tab(id).is_empty() {
                    self.permissions.borrow_mut().drop_tab(id);
                    self.show_permission();
                }
                if let Some(tab) = self.index_of(id).map(|i| &mut self.tabs[i]) {
                    // Andere Website: deren gemerkten Zoom übernehmen
                    if loading && !url.is_empty() && sites::host(&url) != tab.zoom_host {
                        tab.zoom_host = sites::host(&url);
                        let zoom = self.sites.zoom(&url);
                        if let Some(wv) = tab.webview.as_ref().filter(|_| (zoom - tab.zoom).abs() > 0.001) {
                            tab.zoom = zoom;
                            let _ = wv.zoom(zoom);
                        }
                    }
                    if loading {
                        tab.blocked = 0;
                        tab.page_favicon.clear();
                    } else if let (Some(prompt), Some(wv)) = (tab.pending_prompt.take(), &tab.webview) {
                        let _ = wv.evaluate_script(&format!("({PROMPT_JS})({})", json!(prompt)));
                    }
                    tab.loading = loading;
                    if !url.is_empty() {
                        tab.url = url;
                    }
                    if !loading && !tab.private {
                        if let Ok(mut h) = self.history.lock() {
                            h.visit(&tab.url, &tab.title);
                        }
                    }
                    self.sync_ui();
                }
            }
            // Links aus einem privaten Tab öffnen sich wieder privat.
            UserEvent::NewWindow(from, url) => {
                let private = self.index_of(from).is_some_and(|i| self.tabs[i].private);
                self.new_tab(Some(url), private);
                self.tabs[self.active].popup = true;
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
        .with_url(url)
        .with_bounds(bounds)
        .with_devtools(true)
        // Strg+Mausrad und Strg +/−/0 zoomen die Seite (wry schaltet das sonst ab)
        .with_hotkeys_zoom(true)
        .with_initialization_script(if private { "" } else { include_str!("favicon-content.js") })
        .with_initialization_script(CONTENT_JS)
        .with_initialization_script(include_str!("passkey-policy.js"))
        .with_initialization_script(include_str!("autofill-content.js"))
        .with_initialization_script(include_str!("clipboard-content.js"))
        .with_initialization_script(include_str!("drawing-content.js"))
        .with_ipc_handler(move |req| {
            let body = req.body().clone();
            // JSON = Frage nach Ausblend-Regeln, sonst ein Tastenkürzel
            let event = if body.starts_with('{') {
                let msg = serde_json::from_str::<Value>(&body).unwrap_or_default();
                if let Some(icon) = msg.get("favicon").and_then(Value::as_str) {
                    UserEvent::PageFavicon(id, req.uri().to_string(), icon.to_owned())
                } else if msg.get("draw").is_some() {
                    UserEvent::Drawing(id, req.uri().to_string(), body)
                } else if msg.get("clip").is_some() {
                    UserEvent::ClipboardPage(id, body)
                } else if msg.get("autofill").is_some() {
                    UserEvent::AutofillRequest(id, req.uri().to_string(), body)
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

    watch_requests(&webview, ui, proxy, id, main_nav);

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

/// Download-Ordner eines Profils setzen (`None`: der von Windows, also „Downloads“).
fn set_download_dir(webview: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2, dir: Option<&str>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_13;
    use windows::core::{Interface, HSTRING};
    let dir = dir.map(str::to_owned).or_else(windows_downloads).unwrap_or_default();
    if dir.is_empty() {
        return;
    }
    if let Ok(profile) = unsafe { webview.cast::<ICoreWebView2_13>().and_then(|w| w.Profile()) } {
        let _ = unsafe { profile.SetDefaultDownloadFolderPath(&HSTRING::from(dir)) };
    }
}

/// Aktueller Download-Ordner eines Profils.
fn profile_download_dir(webview: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) -> String {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_13;
    use windows::core::{Interface, PWSTR};
    let mut path = PWSTR::null();
    let ok = unsafe { webview.cast::<ICoreWebView2_13>().and_then(|w| w.Profile()).and_then(|p| p.DefaultDownloadFolderPath(&mut path)) };
    if ok.is_ok() { webview2_com::take_pwstr(path) } else { windows_downloads().unwrap_or_default() }
}

/// Der Downloads-Ordner von Windows (kann vom Nutzer verlegt worden sein).
fn windows_downloads() -> Option<String> {
    use windows::Win32::UI::Shell::{FOLDERID_Downloads, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    unsafe {
        let path = SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, None).ok()?;
        let s = path.to_string().ok();
        windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as _));
        s
    }
}

impl Browser {
    /// Gewählten Download-Ordner an alle Profile geben (normales und die privater Tabs).
    fn apply_download_dir(&self) {
        let dir = self.settings.download_dir.as_deref();
        set_download_dir(&self.ui.webview(), dir);
        for tab in self.tabs.iter().filter(|t| t.private) {
            if let Some(wv) = &tab.webview {
                set_download_dir(&wv.webview(), dir);
            }
        }
    }
}

/// Zoom und Ton eines Tabs an Glass melden (Prozentanzeige im Adressfeld, Lautsprecher am Tab).
fn watch_zoom_and_audio(webview: &WebView, id: u32, proxy: &EventLoopProxy<UserEvent>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    use windows::core::Interface;
    let mut token = 0;
    let p = proxy.clone();
    let zoom = webview2_com::ZoomFactorChangedEventHandler::create(Box::new(move |controller, _| {
        if let Some(c) = controller {
            let mut factor = 1.0;
            unsafe { c.ZoomFactor(&mut factor)? };
            let _ = p.send_event(UserEvent::Zoom(id, factor));
        }
        Ok(())
    }));
    let _ = unsafe { webview.controller().add_ZoomFactorChanged(&zoom, &mut token) };
    let Ok(wv8) = webview.webview().cast::<ICoreWebView2_8>() else { return };
    let audio = |p: EventLoopProxy<UserEvent>| {
        move |sender: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2>, _| {
            if let Some(wv8) = sender.and_then(|s| s.cast::<ICoreWebView2_8>().ok()) {
                let (mut playing, mut muted) = (windows::core::BOOL::default(), windows::core::BOOL::default());
                unsafe {
                    let _ = wv8.IsDocumentPlayingAudio(&mut playing);
                    let _ = wv8.IsMuted(&mut muted);
                }
                let _ = p.send_event(UserEvent::Audio(id, playing.as_bool(), muted.as_bool()));
            }
            Ok(())
        }
    };
    unsafe {
        let h = webview2_com::IsDocumentPlayingAudioChangedEventHandler::create(Box::new(audio(proxy.clone())));
        let _ = wv8.add_IsDocumentPlayingAudioChanged(&h, &mut token);
        let h = webview2_com::IsMutedChangedEventHandler::create(Box::new(audio(proxy.clone())));
        let _ = wv8.add_IsMutedChanged(&h, &mut token);
    }
}

/// Werbeblocker: jede Anfrage der Seite (auch aus iframes und Service Workern) läuft durch die Filter-Engine;
/// gesperrte bekommen sofort eine leere 403-Antwort und gehen gar nicht erst ins Netz.
fn watch_requests(webview: &WebView, ui: &WebView, proxy: &EventLoopProxy<UserEvent>, id: u32, main_nav: Rc<RefCell<String>>) {
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
        "/clipboard-ui.js" => ("text/javascript; charset=utf-8", Cow::Borrowed(include_bytes!("clipboard-ui.js"))),
        "/glass-rim.js" => ("text/javascript; charset=utf-8", Cow::Borrowed(include_bytes!("glass-rim.js"))),
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
        .with_min_inner_size(min_size(false))
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
    let drawings = drawing::Store::new(&data_dir);
    let downloads = downloads::Downloads::load(&data_dir);
    let session = session::Session::new(&data_dir);
    let history = history::History::load(&data_dir);
    let sites = sites::Sites::load(&data_dir);
    let settings = settings::Settings::load(&data_dir);
    let h_protocol = history.clone();
    let mut web_context = WebContext::new(Some(data_dir));

    let p_ui = proxy.clone();
    let ui = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_asynchronous_custom_protocol("glass".into(), move |_, request, responder| {
            if request.uri().path() == "/history" {
                responder.respond(history::respond(&h_protocol, request.uri().query()));
            } else if request.uri().path() == "/suggest" {
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

    let p_clip = proxy.clone();
    clipboard::watch(move |text| p_clip.send_event(UserEvent::Clipboard(text)).is_ok());

    let icloud = autofill::start(proxy.clone());
    let _ = icloud.send(json!({"id": 0, "op": "probe"}));
    let mut browser = Browser {
        icloud, autofill: None, autofill_seq: 0,
        window, ui, tabs: Vec::new(), active: 0, next_id: 1, proxy,
        fullscreen: false, was_maximized: false, overlay: Vec::new(), split: None, resize_preview: None, hover: None, update: None,
        chrome_hidden: false, chrome_left: false, chrome_collapsed: false, chrome_slide: None, animation_rate: 1.0,
        clips: clipboard::History::default(), clip: None, drawings, downloads, parked: Vec::new(),
        session, closed: Vec::new(), history, sites, find_hooked: Default::default(),
        menus: Default::default(), permissions: Default::default(), settings,
    };
    if browser.settings.download_dir.is_some() {
        browser.apply_download_dir();
    }
    // `glass-browser.exe https://a.de b.de` öffnet jede Adresse in einem eigenen Tab.
    let start_urls: Vec<String> = args.iter().map(|a| resolve_input(a)).collect();
    // Tabs der letzten Sitzung zurückholen (falls gewünscht); nur der aktive lädt sofort
    let (mut restored, active) = browser.session.load();
    if !browser.settings.restore_session {
        restored.clear();
    }
    for entry in restored {
        browser.insert_lazy(usize::MAX, entry);
    }
    if !browser.tabs.is_empty() && start_urls.is_empty() {
        browser.activate(active);
    }
    if browser.tabs.is_empty() && start_urls.is_empty() {
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
                    browser.clip_end(true);
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
