//! Gemeinsamer Fensterzustand für native Ecken und den Rahmen der Web-Oberfläche.

use tao::{platform::windows::WindowExtWindows, window::Window};
use windows_sys::Win32::{
    Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
        DWMWCP_ROUND,
    },
    UI::WindowsAndMessaging::IsWindowArranged,
};

/// Windows kennt Snap als eigenen Zustand, auch bei Vierteln und benutzerdefinierten Layouts.
/// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-iswindowarranged
pub fn sync(window: &Window, fullscreen: bool) -> bool {
    let hwnd = window.hwnd() as _;
    let floating = !fullscreen && !window.is_maximized() && unsafe { IsWindowArranged(hwnd) == 0 };
    let corner: i32 = if floating { DWMWCP_ROUND } else { DWMWCP_DONOTROUND };
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as _,
            &corner as *const _ as _,
            std::mem::size_of_val(&corner) as _,
        );
    }
    floating
}
