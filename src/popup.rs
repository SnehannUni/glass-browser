//! Popups mit Größe (`window.open` mit width/height, z. B. „Mit Google anmelden“) als eigene Glass-Fenster:
//! Glas wie das Hauptfenster, oben eine schmale Leiste mit Adresse (popup.html), darunter die Seite.
//!
//! Die Seite muss WebView2 sofort im NewWindowRequested-Handler bekommen – nur dann bleibt `window.opener` erhalten,
//! über den die Anmeldung ihr Ergebnis an die Seite zurückgibt. Ein tao-Fenster lässt sich dort aber nicht bauen
//! (dafür braucht es die Ereignisschleife). Deshalb entsteht die Seite zuerst unsichtbar im Hauptfenster und zieht
//! gleich darauf in ihr eigenes Fenster um (`UserEvent::PopupOpen` → `Browser::open_popups`).

use crate::{rounded_region, UserEvent, CONTENT_RADIUS, MARGIN};
use serde_json::json;
use std::{cell::RefCell, num::NonZeroIsize, rc::Rc};
use tao::{
    dpi::{PhysicalPosition, PhysicalSize},
    event_loop::{EventLoopProxy, EventLoopWindowTarget},
    platform::windows::{IconExtWindows, WindowBuilderExtWindows, WindowExtWindows},
    window::{Icon, Theme, Window, WindowBuilder, WindowId},
};
use wry::{
    dpi::{LogicalPosition, LogicalSize},
    raw_window_handle as rwh, NewWindowFeatures, NewWindowResponse, PageLoadEvent, Rect, WebView, WebViewBuilder,
    WebViewBuilderExtWindows, WebViewExtWindows,
};

/// Höhe der Leiste über der Seite (= --bar in popup.html).
const BAR: f64 = 36.0;
/// Größe der Seite, wenn das Popup keine nennt, und Mindestgröße des Fensters (logische px).
const DEFAULT_SIZE: (f64, f64) = (500.0, 600.0);
const MIN_SIZE: (f64, f64) = (320.0, 240.0);
const POPUP_HTML: &str = include_str!("popup.html");

/// Seite, die schon geladen wird, aber noch auf ihr Fenster wartet.
struct Pending {
    key: u32,
    page: WebView,
    size: Option<LogicalSize<f64>>,
    position: Option<LogicalPosition<f64>>,
}

#[derive(Default)]
struct Shared {
    next: u32,
    pending: Vec<Pending>,
}

/// Öffnet Popups für Tabs, Postfächer und andere Popups – alle auf dem Hauptthread, daher `Rc`.
#[derive(Clone)]
pub struct Opener {
    shared: Rc<RefCell<Shared>>,
    /// Hauptfenster: Dort wartet die Seite unsichtbar, bis ihr Fenster steht.
    parent: isize,
    proxy: EventLoopProxy<UserEvent>,
}

/// Fenster-Handle für wry, wenn nur die Nummer des Fensters bekannt ist.
struct Parent(isize);

impl rwh::HasWindowHandle for Parent {
    fn window_handle(&self) -> Result<rwh::WindowHandle<'_>, rwh::HandleError> {
        let hwnd = NonZeroIsize::new(self.0).ok_or(rwh::HandleError::Unavailable)?;
        // Das Hauptfenster lebt so lange wie Glass
        Ok(unsafe { rwh::WindowHandle::borrow_raw(rwh::RawWindowHandle::Win32(rwh::Win32WindowHandle::new(hwnd))) })
    }
}

impl Opener {
    pub fn new(parent: &Window, proxy: EventLoopProxy<UserEvent>) -> Self {
        Opener { shared: Rc::default(), parent: parent.hwnd(), proxy }
    }

    /// `window.open` einer Seite. Mit Größe ein eigenes Fenster (wie Chrome), sonst ein neuer Tab im Hauptfenster
    /// (`tab`: der Tab, aus dem es kam – bei Popups der Tab, der das erste Popup geöffnet hat).
    pub fn request(&self, tab: u32, private: bool, url: String, features: NewWindowFeatures) -> NewWindowResponse {
        if features.size.is_none() {
            let _ = self.proxy.send_event(UserEvent::NewWindow(tab, url));
            return NewWindowResponse::Deny;
        }
        let key = {
            let mut shared = self.shared.borrow_mut();
            shared.next += 1;
            shared.next
        };
        match self.build_page(key, tab, private, &features) {
            Ok(page) => {
                let webview = page.webview();
                self.shared.borrow_mut().pending.push(Pending { key, page, size: features.size, position: features.position });
                let _ = self.proxy.send_event(UserEvent::PopupOpen);
                NewWindowResponse::Create { webview }
            }
            // Notfalls das schlichte Fenster von WebView2 – Hauptsache, die Anmeldung klappt
            Err(_) => NewWindowResponse::Allow,
        }
    }

    fn build_page(&self, key: u32, tab: u32, private: bool, features: &NewWindowFeatures) -> wry::Result<WebView> {
        let (p_title, p_nav, p_load, p_close) = (self.proxy.clone(), self.proxy.clone(), self.proxy.clone(), self.proxy.clone());
        let opener = self.clone();
        // Gleiche Umgebung und gleiches Profil wie die Seite, die es öffnet – sonst lehnt WebView2 das Fenster ab.
        // Keine Startadresse: Die setzt WebView2 selbst.
        let page = WebViewBuilder::new()
            .with_environment(features.opener.environment.clone())
            .with_incognito(private)
            .with_bounds(Rect { position: LogicalPosition::new(0.0, 0.0).into(), size: LogicalSize::new(1.0, 1.0).into() })
            .with_visible(false)
            .with_devtools(true)
            .with_document_title_changed_handler(move |title| {
                let _ = p_title.send_event(UserEvent::PopupTitle(key, title));
            })
            .with_navigation_handler(move |url| {
                let _ = p_nav.send_event(UserEvent::PopupUrl(key, url));
                true
            })
            .with_on_page_load_handler(move |event, url| {
                if matches!(event, PageLoadEvent::Finished) {
                    let _ = p_load.send_event(UserEvent::PopupUrl(key, url));
                }
            })
            .with_new_window_req_handler(move |url, features| opener.request(tab, private, url, features))
            .build_as_child(&Parent(self.parent))?;
        // window.close() der Seite (die Anmeldung ist fertig)
        let handler = webview2_com::WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
            let _ = p_close.send_event(UserEvent::PopupClose(key));
            Ok(())
        }));
        let mut token = 0;
        unsafe { page.webview().add_WindowCloseRequested(&handler, &mut token) }?;
        Ok(page)
    }

    /// Wartende Seiten bekommen ihr Fenster (aus der Ereignisschleife, siehe `UserEvent::PopupOpen`).
    pub fn open_pending(&self, target: &EventLoopWindowTarget<UserEvent>, main: &Window, ui: &WebView) -> Vec<Popup> {
        let pending = std::mem::take(&mut self.shared.borrow_mut().pending);
        pending.into_iter().filter_map(|p| Popup::new(p, target, main, ui, &self.proxy)).collect()
    }
}

pub struct Popup {
    key: u32,
    pub window: Window,
    bar: WebView,
    page: WebView,
    url: String,
    title: String,
}

impl Popup {
    fn new(p: Pending, target: &EventLoopWindowTarget<UserEvent>, main: &Window, ui: &WebView, proxy: &EventLoopProxy<UserEvent>) -> Option<Popup> {
        let scale = main.scale_factor();
        let (w, h) = p.size.map_or(DEFAULT_SIZE, |s| (s.width, s.height));
        let logical = (
            (w + 2.0 * MARGIN).max(MIN_SIZE.0),
            (h + BAR + MARGIN).max(MIN_SIZE.1),
        );
        let icon = |px: u32| Icon::from_resource(1, Some(PhysicalSize::new(px, px))).ok();
        let window = WindowBuilder::new()
            .with_title("Glass")
            .with_window_icon(icon(32))
            .with_inner_size(LogicalSize::new(logical.0, logical.1))
            .with_min_inner_size(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1))
            .with_decorations(false)
            .with_transparent(true)
            .with_undecorated_shadow(true)
            .with_theme(Some(Theme::Dark))
            .with_background_color((0, 0, 0, 255))
            // Gehört zum Hauptfenster: bleibt davor und hat keinen eigenen Eintrag in der Taskleiste
            .with_owner_window(main.hwnd())
            .with_visible(false)
            .build(target)
            .ok()?;
        place(&window, main, p.position.map(|pos| PhysicalPosition::new(pos.x * scale, pos.y * scale)));
        style(&window);

        let key = p.key;
        let p_ui = proxy.clone();
        let bar = WebViewBuilder::new()
            .with_environment(ui.environment())
            .with_html(POPUP_HTML)
            .with_transparent(true)
            .with_bounds(crate::full_bounds(&window))
            .with_default_context_menus(false)
            .with_browser_accelerator_keys(false)
            .with_ipc_handler(move |req| {
                let _ = p_ui.send_event(UserEvent::PopupUi(key, req.body().clone()));
            })
            .build(&window)
            .ok()?;
        p.page.reparent(window.hwnd()).ok()?;
        let popup = Popup { key, window, bar, page: p.page, url: String::new(), title: String::new() };
        popup.layout();
        let _ = popup.page.set_visible(true);
        popup.window.set_visible(true);
        let _ = popup.page.focus();
        Some(popup)
    }

    pub fn key(&self) -> u32 {
        self.key
    }

    pub fn id(&self) -> WindowId {
        self.window.id()
    }

    /// Seite unter die Leiste, mit runden Ecken wie die Tabs im Hauptfenster.
    pub fn layout(&self) {
        let _ = self.bar.set_bounds(crate::full_bounds(&self.window));
        let size = self.window.inner_size().to_logical::<f64>(self.window.scale_factor());
        let area = [MARGIN, BAR, (size.width - 2.0 * MARGIN).max(1.0), (size.height - BAR - MARGIN).max(1.0)];
        let _ = self.page.set_bounds(crate::to_rect(area));
        crate::window_frame::sync(&self.window, false);
        let mut hwnd = windows::Win32::Foundation::HWND::default();
        if unsafe { self.page.controller().ParentWindow(&mut hwnd) }.is_err() {
            return;
        }
        let scale = self.window.scale_factor();
        let px = |v: f64| (v * scale).round() as i32;
        unsafe {
            use windows_sys::Win32::{Foundation::RECT, Graphics::Gdi::SetWindowRgn, UI::WindowsAndMessaging::GetClientRect};
            let mut rc: RECT = std::mem::zeroed();
            GetClientRect(hwnd.0 as _, &mut rc);
            SetWindowRgn(hwnd.0 as _, rounded_region(rc.right, rc.bottom, px(CONTENT_RADIUS)), 1);
        }
        self.sync();
    }

    /// Adresse, Titel und Fensterzustand an die Leiste.
    pub fn sync(&self) {
        let state = json!({
            "url": self.url, "title": self.title,
            "focused": self.window.is_focused(), "maximized": self.window.is_maximized(),
        });
        let _ = self.bar.evaluate_script(&format!("window.popupState?.({state})"));
    }

    pub fn set_url(&mut self, url: String) {
        if !url.is_empty() && url != self.url {
            self.url = url;
            self.sync();
        }
    }

    pub fn set_title(&mut self, title: String) {
        self.title = title;
        self.window.set_title(if self.title.is_empty() { "Glass" } else { &self.title });
        self.sync();
    }

    /// Befehl der Leiste. `false`: Das Popup soll zu.
    pub fn command(&mut self, raw: &str) -> bool {
        let msg: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
        match msg["cmd"].as_str().unwrap_or_default() {
            "close" => return false,
            "ready" => self.sync(),
            "drag" => { let _ = self.window.drag_window(); }
            "maximize" => self.window.set_maximized(!self.window.is_maximized()),
            "resize" => {
                if let Some(dir) = crate::resize_direction(msg["value"].as_str().unwrap_or_default()) {
                    let _ = self.window.drag_resize_window(dir);
                }
            }
            _ => {}
        }
        true
    }
}

/// Wo das Popup hin soll: an die Stelle, die die Seite nennt, sonst mittig über das Hauptfenster –
/// in jedem Fall ganz auf dem Bildschirm des Hauptfensters.
fn place(window: &Window, main: &Window, wanted: Option<PhysicalPosition<f64>>) {
    let size = window.outer_size();
    let (w, h) = (size.width as i32, size.height as i32);
    let pos = match (wanted, main.outer_position()) {
        (Some(p), _) => (p.x as i32, p.y as i32),
        (None, Ok(m)) => {
            let ms = main.outer_size();
            (m.x + (ms.width as i32 - w) / 2, m.y + (ms.height as i32 - h) / 3)
        }
        (None, Err(_)) => (100, 100),
    };
    let pos = match main.current_monitor() {
        Some(monitor) => {
            let (mp, ms) = (monitor.position(), monitor.size());
            (
                pos.0.clamp(mp.x, (mp.x + ms.width as i32 - w).max(mp.x)),
                pos.1.clamp(mp.y, (mp.y + ms.height as i32 - h).max(mp.y)),
            )
        }
        None => pos,
    };
    window.set_outer_position(PhysicalPosition::new(pos.0, pos.1));
}

/// Dunkles Acrylic im ganzen Fenster wie beim Hauptfenster (dort nur Ersatz für das Wallpaper).
fn style(window: &Window) {
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
    crate::window_frame::sync(window, false);
    // Den Rahmen zeichnet popup.html selbst
    set(DWMWA_BORDER_COLOR as _, DWMWA_COLOR_NONE as _);
    let margins = MARGINS { cxLeftWidth: -1, cxRightWidth: -1, cyTopHeight: -1, cyBottomHeight: -1 };
    unsafe { DwmExtendFrameIntoClientArea(hwnd, &margins) };
    if window_vibrancy::apply_acrylic(window, None).is_err() {
        let _ = window_vibrancy::apply_mica(window, Some(true));
    }
}
