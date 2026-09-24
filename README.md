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

## Private iCloud-Anbindung

Glass kann lokal mit dem installierten iCloud für Windows kommunizieren. Das persönliche Setup
`tools/setup-icloud.ps1 -NodePath <Pfad-zu-node.exe>` legt eine eigene Node-Laufzeit und den Adapter
neben der installierten EXE ab. Apples Protokollcode wird dafür lokal aus der offiziellen Erweiterung
gewonnen; im Browser wird keine Erweiterung installiert. Die Dateien gehören nicht ins Git-Repository.

Beim Fokus auf ein Loginfeld einer HTTPS-Seite zeigt Glass passende iCloud-Accounts in seiner eigenen
Oberfläche. Erst eine Auswahl füllt den Login aus. Es gibt keinen eigenen Passwortspeicher und kein
Toolbar-Icon. Die Freigabe übernimmt ausschließlich den Code aus dem selbst gestarteten iCloud-Helfer;
das Apple-Fenster kann kurz sichtbar werden. Windows-/iCloud-Entsperrungen werden nicht ersetzt.
Die Verbindung bleibt während der Browsersitzung im Speicher und wird bei Bedarf neu aufgebaut.
Glass bereitet sie beim Start vor und lädt Kontonamen für besuchte HTTPS-Websites im Hintergrund.
Diese Vorschläge werden bis zu 60 Sekunden für maximal 128 Hosts im Arbeitsspeicher gehalten;
Passwörter werden weiterhin erst bei der Auswahl angefordert. Ein Verbindungsabbruch leert den Cache.
Das offene Vorschlagsfenster aktualisiert sich direkt; bei Fehlern lässt sich der Abruf dort wiederholen.
WebView2s allgemeines Autofill und Passwort-Speicherangebote sind deaktiviert. Ein Startskript
unterdrückt außerdem bedingte WebAuthn-Vorschläge im Eingabefeld; ausdrücklich gestartete
Passkey-Anmeldungen bleiben verfügbar. Diese Kompatibilitätsanpassung ist kein nativer WebView2-Schalter.

Die Anbindung ist auf das private Setup ausgelegt und hängt von Apples internem Protokoll und dessen
Windows-Steuerelementen ab. Unterstützt werden derzeit Loginfelder im Hauptdokument, auch in offenen
Shadow Roots; Logins in iframes werden nicht ausgefüllt. Automatisches Absenden und Speichern neuer
Passwörter sind nicht enthalten.

Prüfen: `node tests/ui-smoke.mjs` (synthetische Logins) und `node tests/icloud-smoke.mjs`
(echte Freigabe, ausschließlich eine reservierte `.invalid`-Testdomain).

## Glasdarstellung

Die gemeinsame `.glass`-Darstellung verwendet eine einzelne, 1 CSS-Pixel breite SVG-Kontur
aus `src/glass-rim.js`. Ein gerichteter Lichtverlauf beleuchtet nur Teile dieser Kontur;
seine Breite wird entlang des Umfangs in CSS-Pixeln gemessen, unabhängig vom Seitenverhältnis.
Die Position ist der nächstgelegene Punkt auf der Kontur: auf geraden Kanten senkrecht zum Cursor,
an Rundungen auf dem jeweiligen Kreisbogen, statt auf einem Strahl vom Elementmittelpunkt.
Innerhalb der Elementhöhe blenden oberes und unteres Highlight räumlich weich ineinander über,
damit beim Überqueren der Mitte kein abrupter Kantenwechsel sichtbar ist.
Auf sehr kleinen Elementen wird er begrenzt, damit Hauptlicht und Gegenlicht getrennt bleiben.
Die Intensität hängt vom Cursorabstand zur abgerundeten Fläche ab: volle Stärke bis 24 CSS-Pixel,
danach ein weicher Verlauf bis null bei 280 CSS-Pixeln. Beim Verlassen des Fensters blendet sie aus.
Diese Abstände sind eine eigene Abstimmung, keine dokumentierten Apple-Parameter.
Eine durchgehende weiße Grundkontur mit 8 % Deckkraft bleibt unabhängig vom Cursor sichtbar.
Sie nutzt dieselbe Geometrie wie die Highlights. ResizeObserver passt die Kontur bei Größenänderungen an.
Die Renderprüfung in `tests/ui-smoke.mjs` misst gerade Kanten und Rundungen bei 100–200 % Skalierung.
Pixelglättung verursacht bei niedriger Auflösung weiterhin kleine Helligkeitsunterschiede.

Referenzen: [Apple: Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/),
[Liquid Glass React](https://github.com/rdev/liquid-glass-react) und
[Liquid Glass Studio](https://github.com/iyinchao/liquid-glass-studio).
Es handelt sich um eine eigene Annäherung mit SVG-Brechung und CSS, nicht um Apples Renderer.
Der Hintergrund innerhalb der UI kann gebrochen werden; separat gerenderte Webseiten-WebViews
oder andere Windows-Fenster stehen dem CSS-Filter nicht als Hintergrund zur Verfügung.
Ein WebGL-/WebGPU-Shader wäre eine mögliche Weiterentwicklung; Live-Webseiten als Textur würden
zusätzlich eine andere Komposition oder laufende Aufnahme der Inhalte erfordern.

## Updates

Jeder Push auf `main` baut über GitHub Actions (`.github/workflows/release.yml`) die fertige `Browser.exe` und
veröffentlicht sie als Release `build-<Nummer>`. Glass prüft beim Start und danach alle 6 Stunden das neueste
Release und bietet neuere Versionen in einem Update-Modal an; „Jetzt installieren“ tauscht die Exe aus und
startet Glass neu. Lokal gebaute Versionen haben keine Build-Nummer und prüfen nicht auf Updates.

## Lizenz

MIT – siehe `LICENSE`. Die Lizenzen der verwendeten Bibliotheken liegen jedem Release als
`THIRD_PARTY_LICENSES.html` bei (erzeugt mit `cargo about`).
