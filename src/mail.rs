// E-Mail an einem Ort: iCloud und Gmail als Web-Postfächer in einer gemeinsamen Mail-Ansicht (ein eigener Tab).
// Links zeigt die Oberfläche die neuesten Mails aller Postfächer zusammen, rechts steht das Postfach der gewählten
// Mail – die echte Webseite, mit Antworten, Anhängen und allem. Die Postfächer selbst sind unsichtbare WebViews, die
// nie in der Tab-Leiste stehen: Solange die Ansicht offen ist, bleiben alle wach; sonst schlafen sie und wachen alle
// 5 Minuten kurz auf, damit mail-content.js Ungelesene und Liste auffrischen kann.
// Anmeldung, Passwörter und Cookies bleiben bei den Webseiten selbst. Glass merkt sich nur, welche Postfächer
// verbunden sind (`GlassBrowser\mail.json`); Absender und Betreffzeilen liegen nur im Arbeitsspeicher.

use crate::{build_content_webview, set_adblock_flag, to_rect, Area, Browser, ScriptSlot, Tab, UserEvent};
use serde_json::{json, Value};
use std::{cell::Cell, path::PathBuf, time::{Duration, Instant}};
use tao::event_loop::EventLoopProxy;
use wry::{MemoryUsageLevel, WebView, WebViewExtWindows};

/// So oft wachen die Postfächer auf, solange die Mail-Ansicht zu ist …
pub const REFRESH_EVERY: Duration = Duration::from_secs(5 * 60);
/// … und so lange bleiben sie dann wach: genug, um neue Mails zu holen und die Liste neu aufzubauen.
const AWAKE_FOR: Duration = Duration::from_secs(60);
/// Breite der gemeinsamen Liste links in der Mail-Ansicht, solange die Oberfläche keine meldet (Leiste links), und
/// Abstand zum Postfach. Mit der Leiste oben reicht die Liste bis unter das rechte Ende der Such-Kapsel.
const LIST_WIDTH: f64 = 380.0;
const LIST_GAP: f64 = 6.0;

pub struct Provider {
    pub key: &'static str,
    pub name: &'static str,
    url: &'static str,
    hosts: &'static [&'static str],
    /// Erscheint in der Oberfläche. Outlook fehlt noch: Dessen Liste liest mail-content.js noch nicht aus.
    listed: bool,
    /// Die Anmeldung besteht nur aus Sitzungs-Cookies (Apple ohne „Angemeldet bleiben“) – siehe `keep_signed_in`.
    keep: &'static [&'static str],
}

/// Gleiche Hosts wie in mail-content.js.
pub const PROVIDERS: [Provider; 3] = [
    Provider { key: "icloud", name: "iCloud", url: "https://www.icloud.com/mail/", hosts: &["www.icloud.com", "icloud.com"], listed: true, keep: &["icloud.com", "apple.com"] },
    Provider {
        key: "outlook",
        name: "Outlook",
        url: "https://outlook.live.com/mail/",
        hosts: &["outlook.live.com", "outlook.office.com", "outlook.office365.com", "outlook.cloud.microsoft"],
        listed: false,
        keep: &[],
    },
    Provider { key: "gmail", name: "Gmail", url: "https://mail.google.com/mail/", hosts: &["mail.google.com"], listed: true, keep: &[] },
];

/// Welches Postfach gehört zu dieser Adresse (nur https)?
pub fn provider_of(url: &str) -> Option<usize> {
    let host = url.strip_prefix("https://")?.split(['/', '?', '#', ':']).next()?;
    PROVIDERS.iter().position(|p| p.hosts.contains(&host))
}

fn provider_by_key(key: &str) -> Option<usize> {
    PROVIDERS.iter().position(|p| p.key == key && p.listed)
}

#[derive(Default)]
struct Mailbox {
    /// Die Webseite des Postfachs – als Tab verpackt, damit Titel, Favicon und Werbeblocker wie sonst laufen.
    tab: Option<Tab>,
    unread: Option<u64>,
    /// Neueste Mails aus dem Posteingang, wie mail-content.js sie meldet.
    list: Value,
    /// Adresse, unter der das Postfach zuletzt lief. `None`: nicht verbunden.
    url: Option<String>,
    /// Zuletzt an die Seite gegebene Leseansicht (siehe `__glassMailReader` in mail-content.js).
    reader: Cell<bool>,
}

pub struct Mail {
    boxes: [Mailbox; 3],
    file: PathBuf,
    /// Postfach rechts in der Mail-Ansicht.
    shown: Option<usize>,
    /// Rechts nur die Mail, ohne die Leisten des Postfachs (nach Klick auf eine Mail) – oder das ganze Postfach
    /// (nach Klick auf seine Kapsel).
    reader: bool,
    /// Breite der Liste, wie die Oberfläche sie aus der Such-Kapsel ableitet (`None`: LIST_WIDTH).
    list_width: Option<f64>,
    /// Ist die Mail-Ansicht gerade zu sehen? (Dann schläft kein Postfach.)
    view_open: Cell<bool>,
    /// Zählt die Weckrunden – ein spätes „wieder schlafen“ einer früheren Runde wird ignoriert.
    round: Cell<u64>,
    /// Gerade in der Liste angeklickte Mail: Das Postfach (Tab-Id) darf bis dahin einmal melden, wo Glass für
    /// sie klicken soll (iCloud, siehe `__glassMailOpen`). Sonst darf keine Seite Klicks bestellen.
    click: Option<(u32, Instant)>,
    /// Wann `keep_signed_in` zuletzt lief.
    kept: Option<Instant>,
}

impl Mail {
    pub fn new(data_dir: &std::path::Path) -> Self {
        let file = data_dir.join("mail.json");
        let saved: Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let boxes = std::array::from_fn(|p| Mailbox {
            // Nur Adressen des eigenen Anbieters – die Datei könnte von Hand geändert sein
            url: saved[PROVIDERS[p].key]
                .as_str()
                .and_then(|u| u.split('#').next())
                .filter(|u| provider_of(u) == Some(p) && PROVIDERS[p].listed)
                .map(str::to_owned),
            list: json!([]),
            ..Default::default()
        });
        // Rechts ist zu Beginn nichts offen – erst ein Klick auf eine Mail (oder eine Kapsel) zeigt ein Postfach
        Mail { boxes, file, shown: None, reader: false, list_width: None, view_open: Cell::new(false), round: Cell::new(0), click: None, kept: None }
    }

    fn save(&self) {
        let map: serde_json::Map<String, Value> = self
            .boxes
            .iter()
            .zip(&PROVIDERS)
            .filter_map(|(b, p)| Some((p.key.to_owned(), json!(b.url.as_ref()?))))
            .collect();
        let _ = std::fs::write(&self.file, Value::Object(map).to_string());
    }

    /// Webseite eines Postfachs (für Titel, Favicon und Ladezustand, die wie bei Tabs gemeldet werden).
    pub fn tab_mut(&mut self, id: u32) -> Option<&mut Tab> {
        self.boxes.iter_mut().find_map(|b| b.tab.as_mut().filter(|t| t.id == id))
    }

    pub fn owns(&self, id: u32) -> bool {
        self.boxes.iter().any(|b| b.tab.as_ref().is_some_and(|t| t.id == id))
    }

    /// Alle Postfach-Webseiten (für die Mausabfrage in `poll_hover`).
    pub fn webviews(&self) -> impl Iterator<Item = &WebView> {
        self.boxes.iter().filter_map(|b| b.tab.as_ref()?.webview.as_ref())
    }

    /// Das Postfach, das gerade rechts in der Mail-Ansicht steht.
    pub fn shown_tab(&self) -> Option<&Tab> {
        self.boxes[self.shown?].tab.as_ref()
    }
}

/// WebView2 friert die Seite ein (Skripte und Timer stehen, Speicher wird frei) bzw. taut sie wieder auf.
fn suspend(tab: &Tab, on: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_3;
    use windows::core::Interface;
    let Some(wv3) = tab.webview.as_ref().and_then(|wv| wv.webview().cast::<ICoreWebView2_3>().ok()) else { return };
    unsafe {
        if on {
            let done = webview2_com::TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
            let _ = wv3.TrySuspend(&done);
        } else {
            let _ = wv3.Resume();
        }
    }
}

/// Echter Mausklick an (x, y) der Seite – für die Seite nicht von einem Klick des Nutzers zu unterscheiden.
fn click(wv: &WebView, x: f64, y: f64) {
    use windows::core::{w, HSTRING};
    let core = wv.webview();
    for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
        let params = json!({ "type": kind, "x": x, "y": y, "button": if kind == "mouseMoved" { "none" } else { "left" }, "clickCount": 1 });
        let done = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
        let _ = unsafe { core.CallDevToolsProtocolMethod(w!("Input.dispatchMouseEvent"), &HSTRING::from(params.to_string()), &done) };
    }
}

/// Angemeldet bleiben: Apple meldet ohne das Häkchen „Angemeldet bleiben“ (das es nicht bei jeder Anmeldeart gibt)
/// nur mit Sitzungs-Cookies an – nach jedem Neustart von Glass wäre iCloud wieder abgemeldet. Solange das Postfach
/// verbunden ist, bekommen diese Cookies deshalb ein Ablaufdatum, wie es Apple mit dem Häkchen selbst setzt.
/// Abmelden in iCloud löscht sie wie gewohnt; „Trennen“ in Glass lässt sie danach einfach auslaufen.
/// iCloud tauscht sein Anmelde-Token laufend aus (wieder als Sitzungs-Cookie) – deshalb jede Minute und noch einmal
/// beim Beenden (`exit`: danach UserEvent::ExitReady), sonst läge beim nächsten Start ein veraltetes Token bereit.
fn keep_signed_in(wv: &WebView, domains: &'static [&'static str], exit: Option<EventLoopProxy<UserEvent>>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
    use windows::core::{w, Interface};
    let exit_fallback = exit.clone();
    let Ok(manager) = (unsafe { wv.webview().cast::<ICoreWebView2_2>().and_then(|w| w.CookieManager()) }) else {
        if let Some(proxy) = exit {
            let _ = proxy.send_event(UserEvent::ExitReady);
        }
        return;
    };
    let until = (std::time::SystemTime::now() + Duration::from_secs(30 * 24 * 3600))
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64());
    let m = manager.clone();
    let done = webview2_com::GetCookiesCompletedHandler::create(Box::new(move |_, list| {
        let result = keep(&m, list, domains, until);
        if let Some(proxy) = exit {
            let _ = proxy.send_event(UserEvent::ExitReady);
        }
        result
    }));
    // Leere Adresse: alle Cookies des Profils (gefiltert wird unten nach Domain)
    if unsafe { manager.GetCookies(w!(""), &done) }.is_err() {
        if let Some(proxy) = exit_fallback {
            let _ = proxy.send_event(UserEvent::ExitReady);
        }
    }
}

fn keep(
    m: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CookieManager,
    list: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CookieList>,
    domains: &[&str],
    until: f64,
) -> windows::core::Result<()> {
    use windows::core::{BOOL, PWSTR};
    let Some(list) = list else { return Ok(()) };
    unsafe {
        let mut count = 0u32;
        list.Count(&mut count)?;
        for i in 0..count {
            let cookie = list.GetValueAtIndex(i)?;
            let mut session = BOOL::default();
            cookie.IsSession(&mut session)?;
            let mut domain = PWSTR::null();
            cookie.Domain(&mut domain)?;
            let domain = webview2_com::take_pwstr(domain);
            let domain = domain.trim_start_matches('.');
            if session.as_bool() && domains.iter().any(|d| domain == *d || domain.ends_with(&format!(".{d}"))) {
                cookie.SetExpires(until)?;
                m.AddOrUpdateCookie(&cookie)?;
            }
        }
    }
    Ok(())
}

impl Browser {
    /// Glass wird beendet: Anmeldungen, die nur aus Sitzungs-Cookies bestehen, noch mit dem neuesten Token sichern.
    /// `true`: Es läuft etwas – beenden erst mit UserEvent::ExitReady (oder nach kurzer Frist).
    pub fn mail_before_exit(&self) -> bool {
        let mut pending = false;
        for (b, p) in self.mail.boxes.iter().zip(&PROVIDERS) {
            let Some(wv) = b.tab.as_ref().and_then(|t| t.webview.as_ref()) else { continue };
            if !p.keep.is_empty() && b.unread.is_some() {
                keep_signed_in(wv, p.keep, Some(self.proxy.clone()));
                pending = true;
            }
        }
        pending
    }

    /// Ist der aktive Tab die Mail-Ansicht?
    pub fn mail_view_active(&self) -> bool {
        self.tabs.get(self.active).is_some_and(|t| t.mail_view)
    }

    /// Fläche des Postfachs rechts neben der Liste (innerhalb der Seitenfläche `area`).
    pub fn mail_pane(&self, [x, y, w, h]: Area) -> Area {
        let list = self.mail.list_width.unwrap_or(LIST_WIDTH).min(w / 2.0);
        [x + list + LIST_GAP, y, w - list - LIST_GAP, h]
    }

    /// Die Oberfläche meldet, wie breit die Liste sein soll (bis unter das Ende der Such-Kapsel), `None`: Standard.
    pub fn mail_list_width(&mut self, width: Option<f64>) {
        let width = width.map(|w| w.clamp(280.0, 720.0));
        let same = match (width, self.mail.list_width) {
            (Some(a), Some(b)) => (a - b).abs() < 0.5,
            (a, b) => a.is_none() && b.is_none(),
        };
        if !same {
            self.mail.list_width = width;
            if self.mail_view_active() {
                self.layout();
                self.sync_ui();
            }
        }
    }

    /// Zustand für den Mail-Knopf und die Mail-Ansicht.
    pub fn sync_mail(&self) {
        let boxes: Vec<Value> = self
            .mail
            .boxes
            .iter()
            .zip(&PROVIDERS)
            .enumerate()
            .filter(|(_, (_, p))| p.listed)
            .map(|(i, (b, p))| {
                let icon = b.tab.as_ref().map(|t| if t.page_favicon.is_empty() { &t.favicon } else { &t.page_favicon });
                json!({ "key": p.key, "name": p.name, "connected": b.url.is_some(), "unread": b.unread,
                        "list": b.list, "icon": icon, "shown": self.mail.shown == Some(i),
                        "loading": b.tab.as_ref().is_some_and(|t| t.loading) })
            })
            .collect();
        let _ = self.ui.evaluate_script(&format!("window.mailState?.({})", json!({ "boxes": boxes })));
    }

    /// Mail-Knopf: zur Mail-Ansicht, rechts noch ohne Mail – die zeigt erst ein Klick in der Liste.
    pub fn mail_view(&mut self) {
        self.mail.shown = None;
        self.mail_view_open();
    }

    /// Zur Mail-Ansicht (es gibt höchstens eine). Ein leerer Tab wird dazu, sonst ein neuer.
    fn mail_view_open(&mut self) {
        if let Some(i) = self.tabs.iter().position(|t| t.mail_view) {
            self.activate(i);
            self.sync_mail();
            return;
        }
        let blank = self.tabs.get(self.active).is_some_and(|t| t.webview.is_none() && t.url.is_empty() && !t.private);
        if !blank {
            self.new_tab(None, false);
        }
        let tab = &mut self.tabs[self.active];
        tab.mail_view = true;
        tab.title = "Mail".to_owned();
        self.layout();
        self.sync_ui();
        self.sync_mail();
    }

    /// Postfach rechts anzeigen (und dort `item` öffnen). Ein noch nicht verbundenes wird dabei geladen –
    /// rechts erscheint dann seine Anmeldeseite.
    pub fn mail_show(&mut self, key: &str, item: Option<&str>) {
        let Some(p) = provider_by_key(key) else { return };
        if self.mail.boxes[p].url.is_none() {
            self.mail.boxes[p].url = Some(PROVIDERS[p].url.to_owned());
            self.mail.save();
        }
        if self.mail.boxes[p].tab.is_none() {
            self.mail_load(p);
        }
        self.mail.shown = Some(p);
        self.mail.reader = item.is_some();
        if !self.mail_view_active() {
            self.mail_view_open();
        }
        self.layout();
        if let Some(tab) = &self.mail.boxes[p].tab {
            if let (Some(item), Some(wv)) = (item, &tab.webview) {
                self.mail.click = Some((tab.id, Instant::now() + Duration::from_secs(3)));
                let _ = wv.evaluate_script(&format!("window.__glassMailOpen?.({})", json!(item)));
            }
            if let Some(wv) = &tab.webview {
                let _ = wv.focus();
            }
        }
        self.sync_mail();
    }

    /// Postfach trennen: Glass vergisst es und schließt seine Webseite. Angemeldet bleibt man trotzdem
    /// (die Cookies gehören der Webseite) – beim nächsten Verbinden ist man sofort wieder drin.
    pub fn mail_forget(&mut self, key: &str) {
        let Some(p) = provider_by_key(key) else { return };
        self.mail.boxes[p] = Mailbox { list: json!([]), ..Default::default() };
        if self.mail.shown == Some(p) {
            self.mail.shown = None;
        }
        self.mail.save();
        self.layout();
        self.sync_mail();
    }

    /// Teil von `layout`: Das gewählte Postfach steht rechts in der Mail-Ansicht, alle anderen sind unsichtbar.
    /// Öffnet oder schließt sich die Ansicht, wachen die Postfächer auf bzw. schlafen bald wieder.
    pub fn mail_layout(&self) {
        let view = self.mail_view_active() && !self.fullscreen;
        let pane = self.mail_pane(self.content_area());
        for (p, b) in self.mail.boxes.iter().enumerate() {
            let Some(wv) = b.tab.as_ref().and_then(|t| t.webview.as_ref()) else { continue };
            // Leseansicht nur, solange es rechts zu sehen ist: Im Hintergrund braucht mail-content.js die Mail-Liste
            // des Postfachs (iCloud baut ausgeblendete Zeilen gar nicht erst auf)
            let reader = view && self.mail.shown == Some(p) && self.mail.reader;
            if b.reader.replace(reader) != reader {
                let _ = wv.evaluate_script(&format!("window.__glassMailReader?.({reader})"));
                // Rechts gerade weggewechselt: gleich zurück in den Posteingang, damit die Liste frisch bleibt
                if !(view && self.mail.shown == Some(p)) {
                    let _ = wv.evaluate_script("window.__glassMailHome?.()");
                }
            }
            if view && self.mail.shown == Some(p) {
                let _ = wv.set_bounds(to_rect(pane));
                let _ = wv.set_visible(true);
                let _ = wv.set_memory_usage_level(MemoryUsageLevel::Normal);
            } else {
                let _ = wv.set_visible(false);
                let _ = wv.set_memory_usage_level(MemoryUsageLevel::Low);
            }
        }
        if view != self.mail.view_open.replace(view) {
            if view {
                for tab in self.mail.boxes.iter().filter_map(|b| b.tab.as_ref()) {
                    suspend(tab, false);
                }
            } else {
                self.mail_sleep_later();
            }
        }
    }

    /// Alle 5 Minuten (und kurz nach dem Start): fehlende Postfächer unsichtbar laden, schlafende aufwecken.
    pub fn mail_tick(&mut self) {
        for p in 0..PROVIDERS.len() {
            if self.mail.boxes[p].url.is_none() {
                continue;
            }
            match &self.mail.boxes[p].tab {
                Some(tab) => {
                    suspend(tab, false);
                    // Nicht gerade angezeigt: zurück in den Posteingang, damit die Liste frisch wird
                    let shown = self.mail.view_open.get() && self.mail.shown == Some(p);
                    if let (false, Some(wv)) = (shown, &tab.webview) {
                        let _ = wv.evaluate_script("window.__glassMailHome?.()");
                    }
                }
                None => self.mail_load(p),
            }
        }
        if !self.mail.view_open.get() {
            self.mail_sleep_later();
        }
        self.mail_layout();
    }

    /// Postfach unsichtbar laden.
    fn mail_load(&mut self, p: usize) {
        let Some(url) = self.mail.boxes[p].url.clone() else { return };
        let id = self.next_id;
        self.next_id += 1;
        let bounds = to_rect(self.mail_pane(self.content_area()));
        let Ok(webview) = build_content_webview(&self.window, &self.ui, &self.proxy, id, false, &url, bounds, false) else { return };
        let _ = webview.set_memory_usage_level(MemoryUsageLevel::Low);
        let adblock_flag = ScriptSlot::default();
        set_adblock_flag(&webview, &adblock_flag);
        self.mail.boxes[p].tab = Some(Tab {
            id, title: String::new(), favicon: String::new(), page_favicon: String::new(), url, loading: true, private: false,
            blocked: 0, adblock_flag, webview: Some(webview), home: false, pending_prompt: None,
            hidden_since: Cell::new(Some(Instant::now())), drawing: false, mail_view: false,
        });
    }

    fn mail_sleep_later(&self) {
        let round = self.mail.round.get() + 1;
        self.mail.round.set(round);
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            std::thread::sleep(AWAKE_FOR);
            let _ = proxy.send_event(UserEvent::MailSleep(round));
        });
    }

    pub fn mail_sleep(&mut self, round: u64) {
        if round != self.mail.round.get() || self.mail.view_open.get() {
            return;
        }
        for tab in self.mail.boxes.iter().filter_map(|b| b.tab.as_ref()) {
            suspend(tab, true);
        }
    }

    /// Nachricht aus mail-content.js. `source`: Dokument, das sie geschickt hat (von WebView2, nicht fälschbar).
    /// Zählt nur aus der Webseite des Postfachs selbst – ein Gmail-Tab daneben (oder ein privater) bleibt außen vor.
    pub fn mail_report(&mut self, id: u32, source: &str, raw: &str) {
        let Some(p) = provider_of(source) else { return };
        let mb = &mut self.mail.boxes[p];
        if mb.url.is_none() || !mb.tab.as_ref().is_some_and(|t| t.id == id) {
            return;
        }
        let msg: Value = serde_json::from_str(raw).unwrap_or_default();
        if let Some([x, y]) = msg["mail"]["click"].as_array().and_then(|a| Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?])) {
            let allowed = self.mail.click.take().is_some_and(|(tab, until)| tab == id && Instant::now() < until);
            if let (true, Some(wv)) = (allowed && self.mail.shown == Some(p), mb.tab.as_ref().and_then(|t| t.webview.as_ref())) {
                click(wv, x, y);
            }
            return;
        }
        // Die Seite hat die Leseansicht verloren (neu geladen) oder behalten, obwohl sie nicht mehr gilt: nachziehen
        if let (Some(on), Some(wv)) = (msg["mail"]["reader"].as_bool(), mb.tab.as_ref().and_then(|t| t.webview.as_ref())) {
            if on != mb.reader.get() {
                let _ = wv.evaluate_script(&format!("window.__glassMailReader?.({})", mb.reader.get()));
            }
        }
        let unread = msg["mail"]["unread"].as_u64();
        let list = msg["mail"]["list"].clone();
        let changed = unread.is_some_and(|n| mb.unread != Some(n)) || (list.is_array() && mb.list != list);
        if let Some(n) = unread {
            mb.unread = Some(n);
            // Eine Zahl heißt: angemeldet. Dann (höchstens alle 10 Minuten) die Anmeldung dauerhaft machen
            let due = self.mail.kept.is_none_or(|t| t.elapsed() > Duration::from_secs(60));
            if let (true, false, Some(wv)) = (due, PROVIDERS[p].keep.is_empty(), mb.tab.as_ref().and_then(|t| t.webview.as_ref())) {
                keep_signed_in(wv, PROVIDERS[p].keep, None);
                self.mail.kept = Some(Instant::now());
            }
        }
        if list.is_array() {
            mb.list = list;
        }
        // Wo das Postfach nach der Anmeldung gelandet ist (z. B. /mail/u/1/), gilt beim nächsten Start
        // (ohne #…: Gmail schreibt dort die gerade offene Mail hin)
        let url = mb.tab.as_ref().map(|t| t.url.split('#').next().unwrap_or_default().to_owned()).filter(|u| provider_of(u) == Some(p));
        if url.is_some() && url != mb.url {
            mb.url = url;
            self.mail.save();
        }
        if changed {
            self.sync_mail();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_by_host() {
        assert_eq!(provider_of("https://mail.google.com/mail/u/0/#inbox"), Some(2));
        assert_eq!(provider_of("https://outlook.office.com/mail/"), Some(1));
        assert_eq!(provider_of("https://www.icloud.com/mail/"), Some(0));
        assert_eq!(provider_of("http://mail.google.com/"), None);
        assert_eq!(provider_of("https://mail.google.com.evil.de/"), None);
        assert_eq!(provider_of("https://accounts.google.com/"), None);
        // Outlook steht noch nicht in der Oberfläche
        assert_eq!(provider_by_key("outlook"), None);
        assert_eq!(provider_by_key("gmail"), Some(2));
    }
}
