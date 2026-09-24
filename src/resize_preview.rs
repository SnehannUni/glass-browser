use base64::Engine;
use webview2_com::{CapturePreviewCompletedHandler, Microsoft::Web::WebView2::Win32::*};
use windows::Win32::{
    Foundation::HGLOBAL,
    System::Com::{StructuredStorage::CreateStreamOnHGlobal, STREAM_SEEK_SET},
};

// One capture per pane at drag start, held only in memory (including private tabs).
pub fn capture(web: &ICoreWebView2, done: impl Fn(String) + 'static) -> windows::core::Result<()> {
    let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true)? };
    let output = stream.clone();
    let callback = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        let mut bytes = Vec::new();
        if result.is_ok() && unsafe { output.Seek(0, STREAM_SEEK_SET, None) }.is_ok() {
            loop {
                let mut chunk = [0u8; 16384];
                let mut read = 0;
                if unsafe {
                    output.Read(
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
                if bytes.len() > 20 * 1024 * 1024 {
                    bytes.clear();
                    break;
                }
            }
        }
        done(if bytes.is_empty() {
            String::new()
        } else {
            format!(
                "data:image/jpeg;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        });
        Ok(())
    }));
    unsafe {
        web.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
            &stream,
            &callback,
        )
    }
}
