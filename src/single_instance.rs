//! Links aus anderen Apps im schon offenen Glass öffnen statt in einem zweiten Fenster.
//! Die erste Instanz belegt gleich beim Start eine Named Pipe und lauscht daran; eine weitere, die mit Adressen
//! gestartet wird, schickt sie dorthin (eine pro Zeile) und beendet sich.

use std::io::Write;
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{ReadFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND},
    System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT},
};

/// Eine Pipe je Datenordner (je Benutzer, und Store- und GitHub-Version getrennt) – Named Pipes gelten für den
/// ganzen Rechner. Testinstanzen mit eigenem `LOCALAPPDATA` laufen so getrennt neben dem offenen Browser.
fn pipe_name() -> String {
    let dir = crate::paths::data_dir().display().to_string().to_lowercase();
    let hash = dir.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3)); // FNV-1a
    format!(r"\\.\pipe\GlassBrowser-{hash:016x}")
}

/// Die Pipe dieser Instanz; solange sie besteht, gehen weitere Starts mit Adressen an sie.
pub struct Listener(isize);

/// Pipe belegen, bevor das Fenster entsteht – sonst könnten zwei gleichzeitig geöffnete Links zwei Fenster starten.
/// `None` = ein anderes Glass hat sie schon.
pub fn claim() -> Option<Listener> {
    claim_name(&pipe_name())
}

fn claim_name(name: &str) -> Option<Listener> {
    let name: Vec<u16> = name.encode_utf16().chain([0]).collect();
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
    (pipe != INVALID_HANDLE_VALUE).then(|| Listener(pipe as isize))
}

/// An die laufende Instanz übergeben. `true` = erledigt, diese Instanz kann sich beenden.
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

impl Listener {
    /// Im Hintergrund auf weitergeleitete Adressen warten. Die Pipe bleibt dabei offen: Zwischen zwei Anfragen
    /// meldet sie „beschäftigt“, und der nächste Start wartet kurz, statt ein zweites Fenster zu öffnen.
    pub fn listen(self, on_args: impl Fn(Vec<String>) + Send + 'static) {
        let raw = self.0;
        std::thread::spawn(move || {
            let pipe = raw as windows_sys::Win32::Foundation::HANDLE;
            loop {
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
                unsafe { DisconnectNamedPipe(pipe) };
                let args: Vec<String> = String::from_utf8_lossy(&data).lines().filter(|l| !l.trim().is_empty()).map(str::to_owned).collect();
                if !args.is_empty() {
                    on_args(args);
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{claim_name, forward_to};

    #[test]
    fn second_instance_hands_its_addresses_to_the_first() {
        let name = format!(r"\\.\pipe\GlassBrowser-test-{}", std::process::id());
        assert!(!forward_to(&name, &["a.de".into()]), "ohne laufende Instanz selbst starten");

        let listener = claim_name(&name).expect("erste Instanz belegt die Pipe");
        assert!(claim_name(&name).is_none(), "eine zweite bekommt sie nicht");
        let (tx, rx) = std::sync::mpsc::channel();
        listener.listen(move |args| tx.send(args).unwrap());
        let args = vec!["https://example.com/a b".to_owned(), r"C:\Temp\x.html".to_owned()];
        assert!(forward_to(&name, &args));
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap(), args);
        // Die Pipe steht danach sofort wieder bereit – auch für schnell aufeinanderfolgende Links
        for i in 0..5 {
            assert!(forward_to(&name, &[format!("b{i}.de")]));
        }
        for i in 0..5 {
            assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap(), vec![format!("b{i}.de")]);
        }
        assert!(!forward_to(&name, &[]), "ohne Adressen normal starten");
    }
}
