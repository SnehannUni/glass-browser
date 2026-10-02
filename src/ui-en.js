// Englische Texte der Oberfläche (ui.html, autofill-ui.js), nach dem deutschen Text im Quelltext.
// Nur bei `<html lang="en">` benutzt (siehe t() in ui.html); fehlt ein Eintrag, bleibt der deutsche Text stehen.
// `{name}` sind Platzhalter, die t() einsetzt.
window.UI_EN = {
  // Leiste, Adressfeld, Tabs
  'Zurück (Alt+←)': 'Back (Alt+←)',
  'Vorwärts (Alt+→)': 'Forward (Alt+→)',
  'Suchen (Strg+L)': 'Search (Ctrl+L)',
  'Suche öffnen': 'Open search',
  'Tab schließen (Strg+W)': 'Close tab (Ctrl+W)',
  'Neuer Tab (Strg+T)': 'New tab (Ctrl+T)',
  'Neuer Tab': 'New tab',
  'Geteilte Ansicht beenden': 'Exit split view',
  'Neuer privater Tab (Strg+Umschalt+N)': 'New private tab (Ctrl+Shift+N)',
  'Privat surfen (Strg+Umschalt+N)': 'Browse privately (Ctrl+Shift+N)',
  'Privates Surfen beenden': 'Exit private browsing',
  'Favoriten': 'Favorites',
  'Minimieren': 'Minimize',
  'Maximieren': 'Maximize',
  'Wiederherstellen': 'Restore',
  'Schließen': 'Close',
  'Suchen oder Adresse eingeben (Strg+L)': 'Search or enter address (Ctrl+L)',
  'Laden stoppen': 'Stop loading',
  'Neu laden (F5)': 'Reload (F5)',
  'Ziehen: Aufteilung ändern · Doppelklick: 50 : 50': 'Drag: resize the split · Double-click: 50 : 50',

  // Suchanbieter
  'Suchbegriff oder Websitename eingeben': 'Search or enter a website name',
  'ChatGPT fragen oder Website eingeben': 'Ask ChatGPT or enter a website',
  'Claude fragen oder Website eingeben': 'Ask Claude or enter a website',
  'Gemini fragen oder Website eingeben': 'Ask Gemini or enter a website',
  'Kimi fragen oder Website eingeben': 'Ask Kimi or enter a website',
  'Z.ai fragen oder Website eingeben': 'Ask Z.ai or enter a website',
  'Grok fragen oder Website eingeben': 'Ask Grok or enter a website',
  'Auf YouTube suchen oder Website eingeben': 'Search YouTube or enter a website',
  'Auf Amazon suchen oder Website eingeben': 'Search Amazon or enter a website',
  'Privat: {hint}': 'Private: {hint}',
  'Suchen mit {name} – klicken zum Wechseln': 'Search with {name} – click to switch',
  'Im Uhrzeigersinn drehen': 'Rotate clockwise',
  'Gegen den Uhrzeigersinn drehen': 'Rotate counterclockwise',
  'Aus dem Verlauf entfernen': 'Remove from history',

  // Werbeblocker
  'Werbeblocker: 1 Anfrage blockiert – klicken, um ihn auf {host} auszuschalten': 'Ad blocker: 1 request blocked – click to turn it off on {host}',
  'Werbeblocker: {n} Anfragen blockiert – klicken, um ihn auf {host} auszuschalten': 'Ad blocker: {n} requests blocked – click to turn it off on {host}',
  'Werbeblocker ist auf {host} aus – klicken zum Einschalten': 'Ad blocker is off on {host} – click to turn it on',

  // Kontextmenü der Leiste
  'Leiste': 'Toolbar',
  'Leiste einklappen': 'Collapse toolbar',
  'Leiste links': 'Toolbar on the left',
  'Als Standardbrowser festlegen…': 'Set as default browser…',
  'Datenschutz': 'Privacy',

  // Privates Surfen, Standardbrowser
  'Privates Surfen': 'Private browsing',
  'Verlauf, Cookies und Anmeldungen bleiben nur, bis du den letzten privaten Tab schließt.': 'History, cookies and sign-ins are kept only until you close the last private tab.',
  'Winter Browser als Standardbrowser verwenden?': 'Make Winter Browser your default browser?',
  'Festlegen': 'Set as default',
  'Nicht mehr fragen': 'Don’t ask again',

  // Favoriten
  'Zu den Favoriten hinzufügen': 'Add to favorites',
  'Aus den Favoriten entfernen': 'Remove from favorites',
  'Noch keine Favoriten. Tippe auf den Stern in der Adresszeile, um eine Seite zu speichern.': 'No favorites yet. Click the star in the address bar to save a page.',

  // Downloads
  '{n} laufen': '{n} running',
  '{a} von {b}': '{a} of {b}',
  'Wartet auf Bestätigung – klicken': 'Waiting for confirmation – click',
  'Unterbrochen – zum Fortsetzen klicken': 'Interrupted – click to resume',
  'Fehlgeschlagen': 'Failed',
  'Datei nicht mehr vorhanden': 'File no longer exists',
  'Im Ordner zeigen': 'Show in folder',
  'Abbrechen': 'Cancel',
  'Aus der Liste entfernen': 'Remove from list',
  'Liste leeren': 'Clear list',
  'Noch keine Downloads.': 'No downloads yet.',

  // Mail
  'Postfach': 'Mailbox',
  'Du bleibst dort angemeldet': 'You stay signed in there',
  'Mail – {fresh} neu, {total} ungelesen': 'Mail – {fresh} new, {total} unread',
  'Mail – {total} ungelesen': 'Mail – {total} unread',
  'Postfächer neu laden (F5)': 'Reload mailboxes (F5)',
  'Gestern': 'Yesterday',
  '{name} trennen': 'Disconnect {name}',
  '{n} ungelesen': '{n} unread',
  'Alle': 'All',
  'Ungelesen': 'Unread',
  '{name} verbinden – rechts erscheint die Anmeldung': 'Connect {name} – the sign-in appears on the right',
  '{name}: nicht angemeldet – klicken, um dich rechts anzumelden': '{name}: not signed in – click to sign in on the right',
  '{name} – {n} ungelesen – nur {name} zeigen, rechts das Postfach (Rechtsklick: trennen)': '{name} – {n} unread – show only {name}, with the mailbox on the right (right-click: disconnect)',
  '{name} – nur {name} zeigen, rechts das Postfach (Rechtsklick: trennen)': '{name} – show only {name}, with the mailbox on the right (right-click: disconnect)',
  '(kein Betreff)': '(no subject)',
  'Tippe oben auf ein Postfach und melde dich rechts an. Danach stehen hier die Mails aus allen Postfächern zusammen.': 'Click a mailbox above and sign in on the right. Mail from all your mailboxes then shows up here together.',
  'Keine ungelesenen Mails in den geladenen Posteingängen.': 'No unread mail in the loaded inboxes.',
  'Hier ist gerade nichts.': 'Nothing here right now.',
  'Die Postfächer laden – gleich erscheinen hier die neuesten Mails. Falls rechts eine Anmeldung steht, melde dich dort an.': 'Your mailboxes are loading – the latest mail will show up here in a moment. If a sign-in appears on the right, sign in there.',
  'Keine Mail ausgewählt': 'No mail selected',
  'Wähle links eine Mail aus – oder ein Postfach, um es ganz zu sehen.': 'Pick a mail on the left – or a mailbox to see all of it.',
  'Deine Postfächer an einem Ort': 'All your mailboxes in one place',
  'Wähle links ein Postfach, um es zu verbinden. Die Anmeldung läuft direkt bei Apple bzw. Google – Winter Browser sieht dein Passwort nie.': 'Pick a mailbox on the left to connect it. You sign in directly with Apple or Google – Winter Browser never sees your password.',

  // Update
  'Neues Update verfügbar': 'New update available',
  'Build {build} ist da – du hast Build {current}.': 'Build {build} is available – you have build {current}.',
  'Später': 'Later',
  'Jetzt installieren': 'Install now',
  'Wird installiert …': 'Installing …',
  'Erneut versuchen': 'Try again',
  'Update fehlgeschlagen: {msg}': 'Update failed: {msg}',

  // Zeitlupe (animation-debug.js legt den Knopf vor ui.html an; die Übersetzung beim Start erfasst ihn mit)
  'Animationen ×0,05': 'Animations ×0.05',
  'Zeitlupe ausschalten (Strg+Umschalt+F8)': 'Turn off slow motion (Ctrl+Shift+F8)',

  // Passwörter (autofill-ui.js)
  'iCloud-Passwörter': 'iCloud Passwords',
  'Keine passenden Passwörter': 'No matching passwords',
};
