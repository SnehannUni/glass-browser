use base64::Engine;
use std::{cell::Cell, rc::Rc};
use webview2_com::{
    FaviconChangedEventHandler, GetFaviconCompletedHandler, Microsoft::Web::WebView2::Win32::*,
};
use windows::core::Interface;

// Let Chromium resolve HTML icon declarations, redirects, cookies and image formats.
// Only the decoded PNG crosses into the UI; it never refetches a site's icon.
pub fn watch(web: &ICoreWebView2, changed: impl Fn(String) + 'static) -> windows::core::Result<()> {
    let view = web.cast::<ICoreWebView2_15>()?;
    let changed = Rc::new(changed);
    let generation = Rc::new(Cell::new(0u64));
    let handler = FaviconChangedEventHandler::create(Box::new(move |sender, _| {
        let Some(sender) = sender else { return Ok(()) };
        let view = sender.cast::<ICoreWebView2_15>()?;
        let seq = generation.get().wrapping_add(1);
        generation.set(seq);
        let (generation, changed) = (generation.clone(), changed.clone());
        let callback = GetFaviconCompletedHandler::create(Box::new(move |result, stream| {
            if generation.get() != seq {
                return Ok(());
            }
            let mut bytes = Vec::new();
            if result.is_ok() {
                if let Some(stream) = stream {
                    loop {
                        let mut chunk = [0u8; 4096];
                        let mut read = 0;
                        if unsafe {
                            stream.Read(
                                chunk.as_mut_ptr().cast(),
                                chunk.len() as u32,
                                Some(&mut read),
                            )
                        }
                        .is_err()
                        {
                            bytes.clear();
                            break;
                        }
                        if read == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&chunk[..read as usize]);
                        if bytes.len() > 1024 * 1024 {
                            bytes.clear();
                            break;
                        }
                    }
                }
            }
            changed(if bytes.is_empty() {
                String::new()
            } else {
                format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )
            });
            Ok(())
        }));
        unsafe {
            view.GetFavicon(COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG, &callback)?;
        }
        Ok(())
    }));
    let mut token = 0;
    unsafe { view.add_FaviconChanged(&handler, &mut token) }
}

// Content is untrusted. Only bounded decoded PNGs may cross into browser chrome.
pub fn valid_page_icon(icon: &str) -> bool {
    if icon.is_empty() { return true; }
    let Some(data) = icon.strip_prefix("data:image/png;base64,") else { return false; };
    if data.len() > 512 * 1024 { return false; }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else { return false; };
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" { return false; }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    (1..=256).contains(&width) && (1..=256).contains(&height)
}
