// Seiten übersetzen: translate-content.js schickt Stücke Fließtext (HTML mit <a i=N>-Platzhaltern), Rust holt die
// Übersetzung bei Google und gibt sie der Seite zurück. Der Endpunkt ist der des Google-Wörterbuchs für Chrome
// (`clients5.google.com/translate_a/t`) – ohne Schlüssel und nicht offiziell dokumentiert. Fällt er aus, meldet
// die Seite „nicht erreichbar“, statt halb übersetzt zu hängen. Später lässt sich hier eine offizielle API mit
// eigenem Schlüssel (Google Cloud, Microsoft Translator) einsetzen, ohne dass sich an der Seite etwas ändert.

use serde_json::Value;

const HOST: &str = "clients5.google.com";
/// Grenzen je Anfrage (die Seite schickt ohnehin höchstens 60 Stücke mit zusammen etwa 6000 Zeichen).
const MAX_TEXTS: usize = 128;
const MAX_CHARS: usize = 24_000;

/// Zielsprache wie „de“, „en“, „zh-CN“ – nichts anderes kommt in die Adresse.
pub fn valid_lang(lang: &str) -> bool {
    let mut parts = lang.split('-');
    let base = parts.next().unwrap_or_default();
    let region = parts.next();
    parts.next().is_none()
        && (2..=3).contains(&base.len())
        && base.bytes().all(|b| b.is_ascii_alphabetic())
        && region.map_or(true, |r| (2..=4).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_alphanumeric()))
}

fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Die Texte nach `lang` übersetzen. Ergebnis je Text: [Übersetzung, erkannte Ausgangssprache]; None bei Fehlern.
/// Läuft blockierend – nur aus einem Hintergrund-Thread aufrufen.
pub fn translate(texts: &[String], lang: &str) -> Option<Value> {
    if texts.is_empty() || texts.len() > MAX_TEXTS || texts.iter().map(String::len).sum::<usize>() > MAX_CHARS || !valid_lang(lang) {
        return None;
    }
    let form = texts.iter().map(|t| format!("q={}", form_encode(t))).collect::<Vec<_>>().join("&");
    let path = format!("/translate_a/t?client=dict-chrome-ex&sl=auto&tl={lang}&format=html");
    let body = crate::suggest::https_post_form(HOST, &path, &form)?;
    parse(&body, texts.len())
}

/// Antwort: je Text `["Übersetzung", "en"]`; bei manchen Anfragen nur die Zeichenkette. Immer als Paar zurückgeben.
fn parse(body: &[u8], count: usize) -> Option<Value> {
    let json: Value = serde_json::from_slice(body).ok()?;
    let list = json.as_array().filter(|l| l.len() == count)?;
    let pairs = list.iter().map(|item| match item {
        Value::String(s) => Some(serde_json::json!([s, ""])),
        Value::Array(a) => Some(serde_json::json!([a.first()?.as_str()?, a.get(1).and_then(Value::as_str).unwrap_or("")])),
        _ => None,
    });
    pairs.collect::<Option<Vec<_>>>().map(Value::Array)
}

impl crate::Browser {
    /// Nachricht aus translate-content.js: Stand melden, Fehler, oder Text zum Übersetzen.
    pub fn translate_page(&mut self, tab_id: u32, raw: &str) {
        let Some(i) = self.index_of(tab_id) else { return };
        let msg: Value = serde_json::from_str(raw).unwrap_or_default();
        match msg["tr"].as_str() {
            Some("state") => {
                let tab = &mut self.tabs[i];
                tab.translated = msg["lang"].as_str().filter(|l| valid_lang(l)).map(str::to_owned);
                tab.translating = tab.translated.is_some() && msg["busy"].as_bool().unwrap_or(false);
                // Aus (vom Nutzer, oder die Seite hat sich nach einem Fehler selbst abgeschaltet): nicht weiter übersetzen
                if tab.translated.is_none() { tab.translate_to = None; }
                self.sync_ui();
            }
            // Nicht erreichbar bzw. schon in der Zielsprache – die Leiste sagt, warum nichts passiert
            Some(kind @ ("error" | "same")) => {
                let _ = self.ui.evaluate_script(&format!("window.translateNotice?.({tab_id}, {})", serde_json::json!(kind)));
            }
            // Nur, solange der Nutzer das Übersetzen dieser Seite eingeschaltet hat – sonst könnte jede Seite
            // Glass als kostenlosen Übersetzungsdienst benutzen
            Some("batch") if self.tabs[i].translate_to.is_some() => {
                let (Some(id), Some(lang), Some(texts)) = (msg["id"].as_str(), msg["lang"].as_str(), msg["texts"].as_array()) else { return };
                let texts: Vec<String> = texts.iter().filter_map(|t| t.as_str().map(str::to_owned)).collect();
                let (id, lang, proxy) = (id.to_owned(), lang.to_owned(), self.proxy.clone());
                std::thread::spawn(move || {
                    let result = translate(&texts, &lang);
                    let _ = proxy.send_event(crate::UserEvent::Translated(tab_id, id, result));
                });
            }
            Some("batch") => {
                let Some(id) = msg["id"].as_str() else { return };
                let _ = self.proxy.send_event(crate::UserEvent::Translated(tab_id, id.to_owned(), None));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages() {
        for ok in ["de", "en", "zh-CN", "pt-BR", "fil"] { assert!(valid_lang(ok), "{ok}"); }
        for bad in ["", "d", "deutsch", "de&x=1", "de-", "zh-CN-x", "de/../"] { assert!(!valid_lang(bad), "{bad}"); }
    }

    #[test]
    fn encoding() {
        assert_eq!(form_encode("a b&c=ü<"), "a%20b%26c%3D%C3%BC%3C");
    }

    #[test]
    fn responses() {
        let v = parse(br#"[["Hallo","en"],"Welt"]"#, 2).unwrap();
        assert_eq!(v, serde_json::json!([["Hallo", "en"], ["Welt", ""]]));
        assert!(parse(br#"[["Hallo","en"]]"#, 2).is_none(), "count mismatch");
        assert!(parse(b"<html>Sorry</html>", 1).is_none());
    }
}
