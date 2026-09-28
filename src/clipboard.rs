// Zwischenablage-Verlauf: Ein Hintergrund-Thread bemerkt jede neue Kopie (auch aus anderen Programmen) und meldet
// ihren Text. Die Liste selbst führt `History` im Browser; content.js blättert nach Strg+V mit ↑/↓ darin.
// Nur im Arbeitsspeicher – nach einem Neustart ist der Verlauf leer.

use std::collections::VecDeque;
use windows_sys::Win32::{
    Foundation::HGLOBAL,
    System::{
        DataExchange::{CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW},
        Memory::{GlobalLock, GlobalSize, GlobalUnlock},
    },
};

/// So viele Einträge merkt sich der Verlauf.
pub const MAX: usize = 10;
/// Längere Texte (ganze Dateien, Logs …) kommen nicht in den Verlauf.
const MAX_CHARS: usize = 100_000;
const CF_UNICODETEXT: u32 = 13;

#[derive(Default)]
pub struct History(VecDeque<String>);

impl History {
    /// Neuester Eintrag vorn; eine erneute Kopie desselben Texts rückt nur nach vorn.
    pub fn push(&mut self, text: String) {
        if text.trim().is_empty() || text.chars().count() > MAX_CHARS {
            return;
        }
        self.0.retain(|t| *t != text);
        self.0.push_front(text);
        self.0.truncate(MAX);
    }

    pub fn entries(&self) -> Vec<&str> {
        self.0.iter().map(String::as_str).collect()
    }
}

/// Startet die Überwachung; `send` bekommt den Text jeder neuen Kopie.
/// Abfrage der Sequenznummer alle 250 ms – das kostet praktisch nichts und braucht kein eigenes Fenster.
pub fn watch(send: impl Fn(String) -> bool + Send + 'static) {
    std::thread::spawn(move || {
        let mut seen = unsafe { GetClipboardSequenceNumber() };
        loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq == seen {
                continue;
            }
            seen = seq;
            if let Some(text) = read_text() {
                if !send(text) {
                    break;
                }
            }
        }
    });
}

fn format(name: &str) -> u32 {
    let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
    unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
}

fn read_text() -> Option<String> {
    // Kurz warten: Manche Programme füllen die Ablage in mehreren Schritten und halten sie dabei offen
    for _ in 0..5 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            let text = unsafe { text_while_open() };
            unsafe { CloseClipboard() };
            return text;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    None
}

unsafe fn text_while_open() -> Option<String> {
    // Passwort-Manager markieren Kopien, die in keinem Verlauf landen sollen (wie beim Windows-Verlauf Win+V)
    let excluded = ["ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore"];
    if excluded.iter().any(|f| IsClipboardFormatAvailable(format(f)) != 0) {
        return None;
    }
    let history_flag = format("CanIncludeInClipboardHistory");
    if IsClipboardFormatAvailable(history_flag) != 0 {
        let h = GetClipboardData(history_flag) as HGLOBAL;
        let p = GlobalLock(h) as *const u32;
        let allowed = p.is_null() || *p != 0;
        GlobalUnlock(h);
        if !allowed {
            return None;
        }
    }
    if IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 {
        return None;
    }
    let h = GetClipboardData(CF_UNICODETEXT) as HGLOBAL;
    let p = GlobalLock(h) as *const u16;
    if p.is_null() {
        return None;
    }
    let max = GlobalSize(h) / 2;
    let len = (0..max).find(|&i| *p.add(i) == 0).unwrap_or(max);
    let text = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
    GlobalUnlock(h);
    // Windows-Zeilenumbrüche wie beim Einfügen in Webseiten (dort kommen nur \n an)
    Some(text.replace("\r\n", "\n"))
}

/// Blättern nach Strg+V in einer Webseite. Die Einträge sehen nur Rust und die Oberfläche; die Seite bekommt
/// allein den Text, der gerade eingesetzt ist – und nur, wenn der Nutzer die Taste dazu wirklich drückt.
pub struct Session {
    pub tab: u32,
    items: Vec<String>,
    index: usize,
    /// Die Seite hat die Liste geschlossen (z. B. weil der Fokus zum Klick in die Liste wechselte).
    /// Ein Klick auf einen Eintrag gilt dann noch kurz.
    ended: Option<std::time::Instant>,
}

/// Ist die Taste gerade physisch gedrückt? So kann kein Skript der Seite den Verlauf durchblättern und mitlesen.
fn key_down(vk: u16) -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    (unsafe { GetAsyncKeyState(vk as i32) } as u16) & 0x8000 != 0
}

use tao::platform::windows::WindowExtWindows;

impl crate::Browser {
    pub fn foreground(&self) -> bool {
        let top = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
        top == self.window.hwnd() as *mut core::ffi::c_void
    }

    pub fn clip_page(&mut self, tab_id: u32, raw: &str) {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{VK_CONTROL, VK_DOWN, VK_ESCAPE, VK_UP};
        let msg: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
        let live = self.clip.as_ref().is_some_and(|s| s.tab == tab_id && s.ended.is_none());
        match msg["clip"].as_str() {
            Some("start") if self.foreground() && key_down(VK_CONTROL) => self.clip_start(tab_id, &msg["rect"]),
            Some("step") if live && self.foreground() => {
                let down = msg["dir"].as_i64() == Some(1);
                if key_down(if down { VK_DOWN } else { VK_UP }) {
                    let s = self.clip.as_ref().unwrap();
                    let index = if down { (s.index + 1).min(s.items.len() - 1) } else { s.index.saturating_sub(1) };
                    self.clip_select(index);
                }
            }
            Some("revert") if live => {
                if key_down(VK_ESCAPE) { self.clip_select(0); }
                self.clip_end(false);
            }
            Some("end") if live => {
                if let Some(s) = &mut self.clip { s.ended = Some(std::time::Instant::now()); }
                let _ = self.ui.evaluate_script("window.clipboardHistoryHide?.()");
            }
            _ => {}
        }
    }

    fn clip_start(&mut self, tab_id: u32, rect: &serde_json::Value) {
        self.clip_end(true);
        let r: Vec<f64> = rect.as_array().map(|a| a.iter().filter_map(serde_json::Value::as_f64).collect()).unwrap_or_default();
        if r.len() != 4 || r.iter().any(|v| !v.is_finite()) { return; }
        let Some((_, [px, py, w, h])) = self.panes().into_iter().find(|(i, _)| self.tabs[*i].id == tab_id) else { return };
        // Gerade eingefügt – steht das in der Ablage, auch wenn die 250-ms-Abfrage es noch nicht gemeldet hat
        // (oder es aus einem privaten Tab stammt und deshalb nicht im Verlauf ist): nur für diese Liste vorn ergänzen
        let mut items: Vec<String> = self.clips.entries().into_iter().map(str::to_owned).collect();
        // Kein Text lesbar (z. B. ein Passwort, das nicht in Verläufe darf): nicht blättern – Esc brächte sonst etwas
        // anderes zurück als das Eingefügte
        let Some(now) = read_text().filter(|t| !t.trim().is_empty()) else { return };
        items.retain(|t| *t != now);
        items.insert(0, now);
        items.truncate(MAX);
        if items.len() < 2 { return; }
        // Einfügestelle in Fensterkoordinaten, auf die Seite begrenzt
        let (x, top, bottom) = (px + r[0].clamp(0.0, w), py + r[1].clamp(0.0, h), py + (r[1] + r[3]).clamp(0.0, h));
        let previews: Vec<String> = items.iter().map(|t| t.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect()).collect();
        let data = serde_json::json!({ "x": x, "top": top, "bottom": bottom, "items": previews, "index": 0 });
        let _ = self.ui.evaluate_script(&format!("window.clipboardHistory?.({data})"));
        self.clip = Some(Session { tab: tab_id, items, index: 0, ended: None });
    }

    fn clip_select(&mut self, index: usize) {
        let Some(s) = self.clip.as_mut().filter(|s| index < s.items.len() && index != s.index) else { return };
        s.index = index;
        let script = format!("window.__glassClipInsert?.({})", serde_json::json!(s.items[index]));
        let tab = s.tab;
        if let Some(wv) = self.index_of(tab).and_then(|i| self.tabs[i].webview.as_ref()) {
            let _ = wv.evaluate_script(&script);
        }
        let _ = self.ui.evaluate_script(&format!("window.clipboardHistorySelect?.({index})"));
    }

    /// Klick auf einen Eintrag der Liste (in der Oberfläche).
    pub fn clip_pick(&mut self, msg: &serde_json::Value) {
        let recent = self.clip.as_ref().is_some_and(|s| s.ended.map_or(true, |t| t.elapsed().as_millis() < 1500));
        let Some(index) = msg["index"].as_u64().filter(|_| recent) else { return self.clip_end(false) };
        let tab = self.clip.as_ref().unwrap().tab;
        // Der Klick hat den Fokus in die Oberfläche geholt – zurück in die Seite, dann ersetzen
        if let Some(wv) = self.index_of(tab).and_then(|i| self.tabs[i].webview.as_ref()) {
            let _ = wv.focus();
        }
        self.clip_select(index as usize);
        self.clip_end(false);
    }

    /// Liste schließen; `tell_page`: auch der Seite Bescheid geben (wenn nicht sie selbst geschlossen hat).
    pub fn clip_end(&mut self, tell_page: bool) {
        let Some(s) = self.clip.take() else { return };
        let _ = self.ui.evaluate_script("window.clipboardHistoryHide?.()");
        if tell_page && s.ended.is_none() {
            if let Some(wv) = self.index_of(s.tab).and_then(|i| self.tabs[i].webview.as_ref()) {
                let _ = wv.evaluate_script("window.__glassClipEnd?.()");
            }
        }
    }
}
