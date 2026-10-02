//! Signatur der Releases fürs Auto-Update. Die CI signiert jede `Browser.exe` mit einem geheimen Ed25519-Schlüssel
//! (GitHub-Secret `GLASS_SIGNING_KEY`, siehe `examples/sign.rs`); Glass installiert nur, was zu dem hier fest
//! eingebauten öffentlichen Schlüssel passt. Ein ausgetauschtes oder nachträglich hochgeladenes Release-Asset reicht
//! so nicht, um fremden Code auf die Rechner zu bringen (die Actions der CI sind zusätzlich auf Commits festgelegt).
//!
//! Signiert wird die Build-Nummer mit: Ein altes, echt signiertes Release lässt sich nicht als neueres ausgeben.

/// Öffentlicher Schlüssel (Base64) zum Secret `GLASS_SIGNING_KEY`.
pub const PUBLIC_KEY: &str = "LvN2/+7EngKUfr93bapFL7PQ7/OsFSrCep6gLpcJya8=";

/// Die signierten Bytes: fester Vorspann, Build-Nummer, dann die Exe.
pub fn message(build: u32, exe: &[u8]) -> Vec<u8> {
    let mut msg = format!("Glass-Update\0build-{build}\0").into_bytes();
    msg.extend_from_slice(exe);
    msg
}
