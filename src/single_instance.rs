//! Links aus anderen Apps im schon offenen Glass öffnen statt in einem zweiten Fenster.
//! Die erste Instanz belegt gleich beim Start eine Named Pipe und lauscht daran; eine weitere, die mit Adressen
//! gestartet wird, schickt sie dorthin (eine pro Zeile) und beendet sich.
//!
//! Named Pipes gelten für den ganzen Rechner: Die Pipe lässt nur das eigene Benutzerkonto zu, und wer Adressen
//! schickt, prüft vorher, dass am anderen Ende wirklich ein Prozess desselben Kontos sitzt – sonst könnte ein anderes
//! Konto die Pipe zuerst belegen, alle Links abgreifen und sich (Impersonation) als dieser Benutzer ausgeben.

use std::io::Write;
use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, LocalFree, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE},
    Security::{
        Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        EqualSid, GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{ReadFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND, SECURITY_IDENTIFICATION},
    System::{
        Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT},
        Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION},
    },
};

/// So viel nimmt die Pipe pro Anfrage an, und so viele Tabs öffnet eine Anfrage höchstens.
const MAX_BYTES: usize = 64 * 1024;
const MAX_URLS: usize = 20;

/// Benutzer-SID eines Prozesses (Inhalt von `TOKEN_USER`, mit der SID dahinter).
fn process_user(process: HANDLE) -> Option<Vec<u8>> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut buf = vec![0u8; 256];
        let mut len = 0;
        let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), buf.len() as u32, &mut len) != 0;
        CloseHandle(token);
        ok.then_some(buf)
    }
}

fn sid_of(user: &[u8]) -> *mut core::ffi::c_void {
    unsafe { (*(user.as_ptr() as *const TOKEN_USER)).User.Sid }
}

/// Läuft der Prozess `pid` unter demselben Benutzerkonto wie Glass?
fn same_user(pid: u32) -> bool {
    unsafe {
        let Some(me) = process_user(GetCurrentProcess()) else { return false };
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let other = process_user(process);
        CloseHandle(process);
        other.is_some_and(|other| EqualSid(sid_of(&me), sid_of(&other)) != 0)
    }
}

/// Zugriff nur für das eigene Benutzerkonto (SDDL `D:P(A;;GA;;;<SID>)`); `None`, wenn sich das nicht bauen lässt.
fn own_user_only() -> Option<*mut core::ffi::c_void> {
    unsafe {
        let me = process_user(GetCurrentProcess())?;
        let mut text = std::ptr::null_mut();
        if ConvertSidToStringSidW(sid_of(&me), &mut text) == 0 {
            return None;
        }
        let len = (0..).take_while(|&i| *text.add(i) != 0).count();
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
        LocalFree(text.cast());
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})").encode_utf16().chain([0]).collect();
        let mut sd = std::ptr::null_mut();
        (ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) != 0).then_some(sd)
    }
}

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
    let descriptor = own_user_only()?;
    let attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
    let pipe = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            0,
            64 * 1024,
            0,
            &attributes,
        )
    };
    unsafe { LocalFree(descriptor) };
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
        // SECURITY_IDENTIFICATION: Die Gegenseite darf sehen, wer schreibt, aber nicht in seinem Namen handeln
        match std::fs::OpenOptions::new().write(true).security_qos_flags(SECURITY_IDENTIFICATION).open(name) {
            Ok(mut pipe) => {
                let mut pid = 0;
                if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } == 0 || !same_user(pid) {
                    return false; // fremde Pipe: nichts verraten, selbst starten
                }
                // Die andere Instanz darf ihr Fenster nach vorne holen (das darf sonst nur, wer gerade vorne ist).
                unsafe { windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(pid) };
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
                        if !ok || read == 0 || data.len() + read as usize > MAX_BYTES {
                            break;
                        }
                        data.extend_from_slice(&buf[..read as usize]);
                    }
                }
                unsafe { DisconnectNamedPipe(pipe) };
                let args: Vec<String> =
                    String::from_utf8_lossy(&data).lines().filter(|l| !l.trim().is_empty()).take(MAX_URLS).map(str::to_owned).collect();
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
