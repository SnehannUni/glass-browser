//! Signiert ein Release fürs Auto-Update (Prüfung in src/update.rs, Format in src/signature.rs).
//!
//! In der CI:            cargo run --release --locked --example sign -- <Browser.exe> <Build-Nummer> <Browser.exe.sig>
//!                       (geheimer Schlüssel als Base64 in der Umgebungsvariable GLASS_SIGNING_KEY)
//! Neuen Schlüssel anlegen: cargo run --example sign -- --generate <Datei>
//!                       schreibt den geheimen Schlüssel in <Datei> und gibt den öffentlichen für signature.rs aus.

#[path = "../src/signature.rs"]
mod signature;

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};

fn main() {
    if let Err(e) = run(std::env::args().skip(1).collect()) {
        eprintln!("sign: {e}");
        std::process::exit(1);
    }
}

fn run(args: Vec<String>) -> Result<(), String> {
    match args.as_slice() {
        [flag, file] if flag == "--generate" => {
            let mut seed = [0u8; 32];
            getrandom::fill(&mut seed).map_err(|e| e.to_string())?;
            std::fs::write(file, STANDARD.encode(seed)).map_err(|e| e.to_string())?;
            println!("{}", STANDARD.encode(SigningKey::from_bytes(&seed).verifying_key().as_bytes()));
            Ok(())
        }
        [exe, build, out] => {
            let secret = std::env::var("GLASS_SIGNING_KEY").map_err(|_| "GLASS_SIGNING_KEY fehlt")?;
            let seed: [u8; 32] = STANDARD.decode(secret.trim()).ok().and_then(|s| s.try_into().ok()).ok_or("GLASS_SIGNING_KEY ist ungültig")?;
            let key = SigningKey::from_bytes(&seed);
            if STANDARD.encode(key.verifying_key().as_bytes()) != signature::PUBLIC_KEY {
                return Err("GLASS_SIGNING_KEY passt nicht zum öffentlichen Schlüssel in src/signature.rs".into());
            }
            let build: u32 = build.parse().map_err(|_| "Ungültige Build-Nummer")?;
            let bytes = std::fs::read(exe).map_err(|e| format!("{exe}: {e}"))?;
            let sig = key.sign(&signature::message(build, &bytes));
            std::fs::write(out, STANDARD.encode(sig.to_bytes())).map_err(|e| format!("{out}: {e}"))?;
            Ok(())
        }
        _ => Err("Aufruf: sign <exe> <build> <ausgabe.sig> | sign --generate <datei>".into()),
    }
}
