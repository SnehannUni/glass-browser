# Datenschutzerklärung – Winter Browser

*Stand: 2. Oktober 2026* · [English version below](#privacy-policy--winter-browser)

Winter Browser ist ein kostenloser Open-Source-Webbrowser für Windows (Quellcode: <https://github.com/SnehannUni/glass-browser>).
Er hat kein Benutzerkonto und keine eigenen Server. Wir erheben, speichern und verkaufen keine personenbezogenen Daten.

## Was auf deinem Gerät bleibt
Alles, was der Browser speichert, liegt nur lokal in deinem Windows-Benutzerprofil:
- Verlauf, Cookies, Anmeldungen und zwischengespeicherte Seiten (das WebView2-Profil des Browsers)
- Favoriten, Such- und Eingabeverlauf sowie Einstellungen
- welche Postfächer in der Mail-Ansicht verbunden sind (`mail.json`) und die Liste der Downloads (`downloads.json`)
- im PDF-Editor gezeichnete Unterschriften (`signatures.json`) und die Ausnahmeliste des Werbeblockers

Ordner: in der Store-Version `%LOCALAPPDATA%\Packages\<Paket>\LocalState\GlassBrowser`, sonst `%LOCALAPPDATA%\GlassBrowser`.
Beim Deinstallieren der Store-Version löscht Windows diesen Ordner. Private Tabs hinterlassen nichts, sobald der letzte
private Tab geschlossen ist. Passwörter speichert der Browser nicht.

## Was den Browser verlässt
Der Browser enthält keine Telemetrie, keine Analyse und keine Werbung. Außer den Webseiten, die du selbst öffnest,
spricht er nur mit diesen Diensten:

| Dienst | Wann | Was übertragen wird |
|---|---|---|
| Google-Suchvorschläge (`suggestqueries.google.com`) | während du in die Adress-/Suchleiste tippst | der eingegebene Text |
| Google-Favicon-Dienst (`www.google.com/s2/favicons`) | für die Symbole der Suchmaschinen auf dem Startbildschirm | der Domainname der jeweiligen Suchmaschine |
| Filterlisten des Werbeblockers (`easylist.to`, `ublockorigin.github.io`) | höchstens alle 4 Tage | nur der Abruf der öffentlichen Listen |
| GitHub (`api.github.com`) – **nur die Version von GitHub, nicht die Store-Version** | beim Start und alle 6 Stunden | Abfrage, ob es ein Update gibt |

Dabei sehen diese Dienste wie jeder Webserver deine IP-Adresse. Es gelten deren Datenschutzbestimmungen.

## Mail-Ansicht
Die Mail-Ansicht zeigt die normalen Webseiten von iCloud Mail, Outlook und Gmail. Du meldest dich dort direkt beim
Anbieter an; der Browser sieht dein Passwort nicht. Er liest aus dem Posteingang nur Zahl, Absender, Betreff, Vorschau
und Zeit, um sie anzuzeigen. Diese Angaben bleiben im Arbeitsspeicher und werden nirgends hin übertragen.

## Webseiten
Webseiten, die du aufrufst, können selbst Daten erheben (z. B. Cookies). Dafür gelten die Bestimmungen der jeweiligen Seite.
Der eingebaute Werbeblocker verhindert dabei viele Tracker.

## Kinder
Der Browser richtet sich nicht gezielt an Kinder und erhebt keine Daten von ihnen.

## Kontakt
Fragen zum Datenschutz: bitte als Issue unter <https://github.com/SnehannUni/glass-browser/issues>.
Änderungen an dieser Erklärung stehen in der Versionsgeschichte dieser Datei.

---

# Privacy Policy – Winter Browser

*Last updated: October 2, 2026*

Winter Browser is a free, open-source web browser for Windows (source code: <https://github.com/SnehannUni/glass-browser>).
It has no user accounts and no servers of its own. We do not collect, store or sell any personal data.

## What stays on your device
Everything the browser stores is kept locally in your Windows user profile only:
- history, cookies, sign-ins and cached pages (the browser's WebView2 profile)
- favorites, search and input history, and settings
- which mailboxes are connected in the mail view (`mail.json`) and the download list (`downloads.json`)
- signatures drawn in the PDF editor (`signatures.json`) and the ad blocker's exception list

Folder: `%LOCALAPPDATA%\Packages\<package>\LocalState\GlassBrowser` for the Store version, otherwise `%LOCALAPPDATA%\GlassBrowser`.
Uninstalling the Store version deletes this folder. Private tabs leave nothing behind once the last private tab is closed.
The browser does not store passwords.

## What leaves the browser
The browser contains no telemetry, analytics or ads. Apart from the websites you open yourself, it only contacts:

| Service | When | What is sent |
|---|---|---|
| Google search suggestions (`suggestqueries.google.com`) | while you type into the address/search bar | the typed text |
| Google favicon service (`www.google.com/s2/favicons`) | for the search engine icons on the start screen | the domain name of each search engine |
| Ad blocker filter lists (`easylist.to`, `ublockorigin.github.io`) | at most every 4 days | only the download of the public lists |
| GitHub (`api.github.com`) – **GitHub version only, not the Store version** | at startup and every 6 hours | a check for updates |

Like any web server, these services see your IP address. Their own privacy policies apply.

## Mail view
The mail view shows the regular web pages of iCloud Mail, Outlook and Gmail. You sign in directly with the provider;
the browser never sees your password. It only reads the count, sender, subject, preview and time of inbox messages to
display them. This information stays in memory and is not sent anywhere.

## Websites
Websites you visit may collect data themselves (e.g. cookies); their own policies apply. The built-in ad blocker
prevents many trackers.

## Children
The browser is not directed at children and does not collect data from them.

## Contact
Privacy questions: please open an issue at <https://github.com/SnehannUni/glass-browser/issues>.
Changes to this policy are recorded in this file's version history.
