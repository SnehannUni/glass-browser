# Glass

Ein schlanker Browser für Windows im Stil von Apples Liquid Glass – geschrieben in Rust mit
[tao](https://github.com/tauri-apps/tao), [wry](https://github.com/tauri-apps/wry) und WebView2.

## Funktionen

- **Liquid-Glass-Oberfläche** – eigene Lichtbrechung (SVG-Displacement-Map über `backdrop-filter`),
  Farbsäume an den Kanten und eine Glanzkante, die dem Mauszeiger folgt; das Desktop-Hintergrundbild liegt
  deckungsgleich hinter dem Glas
- **Eine Zeile oben** – Tabs in der Fenstermitte, Suchfeld als kleine Kapsel, die beim Suchen ausfährt
- **Startbildschirm** mit großer Such-Kapsel, Google-Vorschlägen und lokalem Suchverlauf
- **Tabs** – ziehen zum Sortieren, geteilte Ansicht (zwei Seiten nebeneinander), Favoriten
- **Private Tabs** (Strg+Umschalt+N) – InPrivate-Profil nur im Arbeitsspeicher, strenger Tracking-Schutz
- **Werbeblocker** – Brave-Filter-Engine mit EasyList, EasyPrivacy, EasyList Germany und uBlock-Listen;
  blendet Werbeflächen aus, entfernt YouTube-Werbung und lässt sich pro Website abschalten

## Bauen

Voraussetzungen: Windows 10/11 mit WebView2-Runtime (bei Windows 11 vorinstalliert) und Rust.

```sh
cargo build --release
target/release/glass-browser.exe
```

Adressen lassen sich direkt mitgeben: `glass-browser.exe https://example.com github.com`

## Aufbau

| Datei | Inhalt |
|---|---|
| `src/main.rs` | Fenster, Tabs, WebView2-Steuerung, Anfragefilter |
| `src/ui.html` | Oberfläche (Glas, Tabs, Adressfeld, Vorschläge, Favoriten) |
| `src/content.js` | Skript in jeder Webseite: Tastenkürzel, Werbeflächen ausblenden, YouTube |
| `src/blocker.rs` | Werbeblocker: Filterlisten laden, Anfragen prüfen, Ausnahmen pro Website |
| `src/suggest.rs` | Google-Suchvorschläge über WinHTTP |
| `assets/icon.svg` | Logo (gläserner Planet mit Ring); daraus erzeugt: `assets/glass.ico` |
| `build.rs` | bettet das Icon und die Programminfos in die Exe ein |

Browserdaten, Filterlisten und die Ausnahmeliste des Werbeblockers liegen unter `%LOCALAPPDATA%\GlassBrowser`.
