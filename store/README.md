# Microsoft Store

Winter Browser erscheint kostenlos im Microsoft Store als MSIX-Paket. Die Store-Version entsteht aus demselben Code
mit `--features store`:

- **Kein Selbst-Update.** Der Store aktualisiert die App. Der Paketordner ist ohnehin schreibgeschützt.
- **Keine Registry-Anmeldung als Browser.** Links (http/https), `.htm`/`.html`/`.xhtml` und `.pdf` meldet `AppxManifest.xml` an. „Als Standardbrowser festlegen…“ öffnet die Seite des Pakets unter „Standard-Apps“.
- **Keine iCloud-Passwörter.** Die Anbindung braucht ein eigenes node.exe und Apples Erweiterungscode, beides gehört nicht in ein Store-Paket. Die Mail-Ansicht mit iCloud, Outlook und Gmail bleibt.
- **Eigener Datenordner.** Die Daten liegen unter `%LOCALAPPDATA%\Packages\<Paket>\LocalState\GlassBrowser` (`src/paths.rs`). Store- und GitHub-Version laufen getrennt nebeneinander.

Jeder Push auf `main` legt das Paket als `WinterBrowser-Store-build-<N>.msix` zum GitHub-Release
(`.github/workflows/release.yml`). Version: `1.0.<N>.0`.

## Einmalig: Partner Center

1. Unter <https://partner.microsoft.com/dashboard/registration> ein Entwicklerkonto als **Einzelperson** anlegen. Das ist kostenlos.
2. Unter *Apps und Spiele → Neues Produkt → MSIX- oder PWA-App* den Namen **Winter Browser** reservieren.
3. Unter *Produktverwaltung → Produktidentität* die drei Werte als Repository-Variablen eintragen (*GitHub → Settings → Secrets and variables → Actions → Variables*). Es sind keine Geheimnisse.
   - `STORE_IDENTITY_NAME` = `Package/Identity/Name` (z. B. `12345Name.WinterBrowser`)
   - `STORE_PUBLISHER` = `Package/Identity/Publisher` (`CN=…`)
   - `STORE_PUBLISHER_NAME` = `Package/Properties/PublisherDisplayName`

   Alternativ per Kommandozeile:
   ```
   gh variable set STORE_IDENTITY_NAME --body "…"
   ```
   Ohne diese Variablen baut die CI ein Testpaket (`WinterBrowser.Dev`), das das Partner Center ablehnt.
4. Nach dem nächsten Push auf `main` das `.msix` aus dem Release laden und eine **Einreichung** anlegen:
   - **Preise und Verfügbarkeit:** *Kostenlos*, alle Märkte.
   - **Eigenschaften:**
     - Kategorie *Produktivität* (Unterkategorie *Browser*, sofern angeboten)
     - Datenschutzrichtlinie: <https://github.com/SnehannUni/glass-browser/blob/main/PRIVACY.md>
     - Website: <https://github.com/SnehannUni/glass-browser>
   - **Altersfreigaben:** den IARC-Fragebogen ausfüllen, Antworten in `listing.md`.
   - **Pakete:** das `.msix` hochladen.
   - **Store-Einträge** (Deutsch und Englisch):
     - Texte aus `listing.md`
     - mindestens ein Screenshot (1366×768 oder größer, PNG)
     - Logo `Assets/StoreListing300.png`
   - **Einreichungsoptionen, Hinweise für die Zertifizierung:** den Text aus `listing.md` einfügen. Er erklärt `runFullTrust`.
5. Einreichen. Die Prüfung dauert meist ein bis drei Werktage.

**Updates:** das neue `WinterBrowser-Store-build-<N>.msix` aus dem Release in einer neuen Einreichung hochladen.

## Lokal bauen und testen

```
cargo build --release --features store --target-dir target-store
powershell -File store/build-msix.ps1 -Exe target-store/release/glass-browser.exe -Build 1 -Out target-store/Winter.msix
```

Ein unsigniertes Paket installiert Windows nicht. Es gibt zwei Wege:

- **Ohne Signatur:** Entwicklermodus einschalten (*Einstellungen → System → Für Entwickler*). Das Paket mit `makeappx unpack` entpacken und mit `Add-AppxPackage -Register <Ordner>\AppxManifest.xml` registrieren.
- **Mit Testzertifikat:** ein eigenes Zertifikat mit `New-SelfSignedCertificate` erzeugen, Subject = Publisher des Pakets. Das Paket mit `signtool sign /fd SHA256` signieren, das Zertifikat unter *Vertrauenswürdige Personen* importieren, dann `Add-AppxPackage`.

Vor dem Einreichen das Windows App Certification Kit laufen lassen:

```
& "${env:ProgramFiles(x86)}\Windows Kits\10\App Certification Kit\appcert.exe" test -appxpackagepath target-store\Winter.msix -reportoutputpath target-store\wack.xml
```

Logos neu erzeugen, z. B. nach einer Icon-Änderung:

```
py -3 tools/make-icon.py --store
```
