//! Sprache der Oberfläche: Deutsch bei deutschem Windows, sonst Englisch. `GLASS_LANG=de` bzw. `en` erzwingt eine
//! (Tests, Ausprobieren). Die Seiten (ui.html, popup.html, PDF-Viewer) bekommen sie als `<html lang>` und übersetzen
//! sich selbst; hier stehen nur die Texte, die Rust selbst zeigt.

use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    De,
    En,
}

impl Lang {
    /// Für `<html lang>`.
    pub fn code(self) -> &'static str {
        match self {
            Lang::De => "de",
            Lang::En => "en",
        }
    }
}

pub fn lang() -> Lang {
    static LANG: OnceLock<Lang> = OnceLock::new();
    *LANG.get_or_init(|| from(std::env::var("GLASS_LANG").ok().as_deref(), unsafe {
        windows_sys::Win32::Globalization::GetUserDefaultUILanguage()
    }))
}

/// `forced`: Wert von `GLASS_LANG`; `ui_language`: Windows-Sprach-ID (die unteren 10 Bit sind die Sprache, 0x07 = Deutsch).
fn from(forced: Option<&str>, ui_language: u16) -> Lang {
    match forced {
        Some("de") => Lang::De,
        Some("en") => Lang::En,
        _ if ui_language & 0x3ff == 0x07 => Lang::De,
        _ => Lang::En,
    }
}

/// Text in der Sprache der Oberfläche.
pub fn tr(de: &'static str, en: &'static str) -> &'static str {
    match lang() {
        Lang::De => de,
        Lang::En => en,
    }
}

/// Seite mit `<html lang="de">` in der Sprache der Oberfläche.
pub fn localize_page(html: &str) -> String {
    html.replacen(r#"<html lang="de">"#, &format!(r#"<html lang="{}">"#, lang().code()), 1)
}

#[cfg(test)]
mod tests {
    use super::{from, Lang};

    #[test]
    fn german_windows_gets_german_everything_else_english() {
        assert_eq!(from(None, 0x0407), Lang::De); // Deutsch (Deutschland)
        assert_eq!(from(None, 0x0807), Lang::De); // Deutsch (Schweiz)
        assert_eq!(from(None, 0x0C07), Lang::De); // Deutsch (Österreich)
        assert_eq!(from(None, 0x0409), Lang::En); // Englisch (USA)
        assert_eq!(from(None, 0x040C), Lang::En); // Französisch → Englisch
        assert_eq!(from(Some("en"), 0x0407), Lang::En);
        assert_eq!(from(Some("de"), 0x0409), Lang::De);
        assert_eq!(from(Some("fr"), 0x0409), Lang::En);
    }
}
