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
| `assets/icon.svg` | Logo („B“ aus Klarglas, Bookman Old Style Bold Italic als Pfad); daraus erzeugt: `assets/glass.ico` |
| `build.rs` | bettet das Icon und die Programminfos in die Exe ein |

Browserdaten, Filterlisten und die Ausnahmeliste des Werbeblockers liegen unter `%LOCALAPPDATA%\GlassBrowser`.

## Updates

Jeder Push auf `main` baut über GitHub Actions (`.github/workflows/release.yml`) die fertige `Browser.exe` und
veröffentlicht sie als Release `build-<Nummer>`. Glass prüft beim Start und danach alle 6 Stunden das neueste
Release und bietet neuere Versionen in einem Update-Modal an; „Jetzt installieren“ tauscht die Exe aus und
startet Glass neu. Lokal gebaute Versionen haben keine Build-Nummer und prüfen nicht auf Updates.

## Lizenz

MIT – siehe `LICENSE`. Die Lizenzen der verwendeten Bibliotheken liegen jedem Release als
`THIRD_PARTY_LICENSES.html` bei (erzeugt mit `cargo about`).
