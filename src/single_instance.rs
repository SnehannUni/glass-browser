//! Links aus anderen Apps im schon offenen Glass öffnen statt in einem zweiten Fenster.
//! Die erste Instanz lauscht an einer Named Pipe; eine weitere, die mit Adressen gestartet wird,
//! schickt sie dorthin (eine pro Zeile) und beendet sich.

use std::io::Write;
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{ReadFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND},
    System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT},
};

/// Je Benutzer eine Pipe – Named Pipes gelten für den ganzen Rechner.
fn pipe_name() -> String {
    format!(r"\\.\pipe\GlassBrowser-{}", std::env::var("USERNAME").unwrap_or_default())
}

/// An eine laufende Instanz übergeben. `true` = erledigt, diese Instanz kann sich beenden.
pub fn forward(args: &[String]) -> bool {
    forward_to(&pipe_name(), args)
}

fn forward_to(name: &str, args: &[String]) -> bool {
    if args.is_empty() {
        return false;
    }
    for _ in 0..40 {
        match std::fs::OpenOptions::new().write(true).open(name) {
            Ok(mut pipe) => {
                // Die andere Instanz darf ihr Fenster nach vorne holen (das darf sonst nur, wer gerade vorne ist).
                unsafe { windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(u32::MAX) };
                return pipe.write_all(args.join("\n").as_bytes()).is_ok();
            }
            // Gerade bedient sie eine andere Anfrage
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(_) => return false, // keine Instanz offen
        }
    }
    false
}

/// Im Hintergrund auf weitergeleitete Adressen warten. Läuft schon eine Instanz, die lauscht, passiert nichts.
pub fn listen(on_args: impl Fn(Vec<String>) + Send + 'static) {
    listen_on(pipe_name(), on_args);
}

fn listen_on(name: String, on_args: impl Fn(Vec<String>) + Send + 'static) {
    std::thread::spawn(move || {
        let name: Vec<u16> = name.encode_utf16().chain([0]).collect();
        loop {
            let pipe = unsafe {
                CreateNamedPipeW(
                    name.as_ptr(),
                    PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    0,
                    64 * 1024,
                    0,
                    std::ptr::null(),
                )
            };
            if pipe == INVALID_HANDLE_VALUE {
                return;
            }
            let connected = unsafe { ConnectNamedPipe(pipe, std::ptr::null_mut()) != 0 || GetLastError() == ERROR_PIPE_CONNECTED };
            let mut data = Vec::new();
            if connected {
                let mut buf = [0u8; 4096];
                loop {
                    let mut read = 0;
                    let ok = unsafe { ReadFile(pipe, buf.as_mut_ptr(), buf.len() as u32, &mut read, std::ptr::null_mut()) != 0 };
                    if !ok || read == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..read as usize]);
                }
            }
            unsafe {
                DisconnectNamedPipe(pipe);
                CloseHandle(pipe);
            }
            let args: Vec<String> = String::from_utf8_lossy(&data).lines().filter(|l| !l.trim().is_empty()).map(str::to_owned).collect();
            if !args.is_empty() {
                on_args(args);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{forward_to, listen_on};

    #[test]
    fn second_instance_hands_its_addresses_to_the_first() {
        let name = format!(r"\\.\pipe\GlassBrowser-test-{}", std::process::id());
        assert!(!forward_to(&name, &["a.de".into()]), "ohne laufende Instanz selbst starten");

        let (tx, rx) = std::sync::mpsc::channel();
        listen_on(name.clone(), move |args| tx.send(args).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(100));
        let args = vec!["https://example.com/a b".to_owned(), r"C:\Temp\x.html".to_owned()];
        assert!(forward_to(&name, &args));
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap(), args);
        // Die Pipe steht danach wieder bereit
        assert!(forward_to(&name, &["b.de".into()]));
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap(), vec!["b.de".to_owned()]);
        assert!(!forward_to(&name, &[]), "ohne Adressen normal starten");
    }
}
