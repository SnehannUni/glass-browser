// Sprache der Oberfläche: pdf.rs setzt <html lang="{{LANG}}"> (Deutsch, wenn Windows deutsch ist, sonst Englisch).
// Im Code steht der deutsche Text; `t()` liefert auf Englisch den Eintrag aus EN_TEXT (Schlüssel = genau der deutsche
// Text), fehlt einer, bleibt es deutsch. `{name}`-Platzhalter füllt `vars`.
export const LANG = document.documentElement.lang === 'en' ? 'en' : 'de';
export const EN = LANG === 'en';
/** Für toLocaleString & Co. */
export const LOCALE = EN ? 'en-US' : 'de-DE';

/** Deutsch → Englisch. „Text@id“: nur im Element mit dieser ID (gleiches deutsches Wort, andere Bedeutung). */
const EN_TEXT = {
  // ---------- viewer.html: Seitenleiste, Suche, Werkzeugleiste ----------
  'Seitenleiste': 'Sidebar',
  'Seiten': 'Pages',
  'Inhalt': 'Contents',
  'Kommentare': 'Comments',
  'Im Dokument suchen': 'Find in document',
  'Vorheriger Treffer (Umschalt+Eingabe)': 'Previous match (Shift+Enter)',
  'Nächster Treffer (Eingabe)': 'Next match (Enter)',
  'Schließen (Esc)': 'Close (Esc)',
  'Bearbeiten': 'Edit',
  'Auswählen (Esc)': 'Select (Esc)',
  'Text und Bilder bearbeiten (E)': 'Edit text and images (E)',
  'Markieren: Hervorheben, Unterstreichen, Durchstreichen (H)': 'Markup: highlight, underline, strikethrough (H)',
  'Notiz (N)': 'Note (N)',
  'Text hinzufügen (T)': 'Add text (T)',
  'Zeichnen und Formen (D)': 'Draw and shapes (D)',
  'Bild und Stempel (B)': 'Image and stamp (B)',
  'Unterschreiben (S)': 'Sign (S)',
  'Formularfeld anlegen (F)': 'Add form field (F)',
  'Schwärzen (R)': 'Redact (R)',
  'Rückgängig (Strg Z)': 'Undo (Ctrl Z)',
  'Wiederholen (Strg Y)': 'Redo (Ctrl Y)',
  'Seiten organisieren': 'Organize pages',

  // ---------- Einstellungen der Werkzeuge ----------
  'Text und Bilder bearbeiten': 'Edit text and images',
  'Auf eine Textzeile klicken und ändern; Eingabe übernimmt, Esc bricht ab. Ein Bild anklicken, um es zu verschieben, an einer Ecke die Größe zu ändern, es zu ersetzen oder zu löschen.':
    'Click a line of text and change it; Enter applies, Esc cancels. Click an image to move it, drag a corner to resize it, or replace or delete it.',
  'Schrift': 'Font',
  'Größe (pt)': 'Size (pt)',
  'Fett (Strg B)': 'Bold (Ctrl B)',
  'Kursiv (Strg I)': 'Italic (Ctrl I)',
  // Die Knöpfe Fett/Kursiv zeigen den Anfangsbuchstaben
  'F': 'B',
  'K': 'I',
  'Ziehen verschiebt das Bild, die Ecken ändern die Größe. Eine Bilddatei darauf ziehen ersetzt es.':
    'Drag to move the image, drag a corner to resize it. Drop an image file on it to replace it.',
  'Bild ersetzen …': 'Replace image…',
  'Bild löschen': 'Delete image',
  'Markieren': 'Markup',
  'Hervorheben': 'Highlight',
  'Unterstreichen': 'Underline',
  'Durchstreichen': 'Strikethrough',
  'Text auswählen – die Markierung erscheint beim Loslassen.': 'Select text – the markup appears when you let go.',
  'Stärke (frei)': 'Thickness (freehand)',
  'Notiz': 'Note',
  'Auf die Seite klicken, um eine Notiz anzuheften. Alle Notizen stehen unter „Kommentare“ in der Seitenleiste.':
    'Click the page to pin a note. All notes are listed under “Comments” in the sidebar.',
  'Autor': 'Author',
  'Ihr Name': 'Your name',
  'Auf die Seite klicken und tippen.': 'Click the page and start typing.',
  'Größe': 'Size',
  'Zeichnen': 'Draw',
  'Stift': 'Pen',
  'Rechteck': 'Rectangle',
  'Linie': 'Line',
  'Pfeil': 'Arrow',
  'Auf der Seite aufziehen; Umschalt hält Quadrat, Kreis oder 45°.': 'Drag on the page; hold Shift for a square, circle or 45°.',
  'Stärke': 'Thickness',
  'Deckkraft': 'Opacity',
  'Bild und Stempel': 'Image and stamp',
  'Bild einfügen …': 'Insert image…',
  'Eigener Stempel': 'Custom stamp',
  'z. B. Bezahlt': 'e.g. Paid',
  'Datum und Name dazu': 'Add date and name',
  'Stempel einsetzen': 'Place stamp',
  'Unterschreiben': 'Sign',
  'Neue Unterschrift': 'New signature',
  'Gespeicherte Unterschrift wählen, dann an die richtige Stelle ziehen – oder auf die Seite klicken.':
    'Choose a saved signature, then drag it into place – or click the page.',
  'Formularfeld': 'Form field',
  'Textfeld': 'Text field',
  'Kontrollkästchen': 'Checkbox',
  'Auswahlliste': 'Dropdown list',
  'Kästchen': 'Checkbox',
  'Liste': 'List',
  'Rechteck auf der Seite aufziehen. Das Feld lässt sich danach direkt ausfüllen.':
    'Drag a rectangle on the page. You can fill in the field right away.',
  'Einträge (einer pro Zeile)': 'Options (one per line)',
  'Ja\nNein': 'Yes\nNo',
  'Schwärzen': 'Redact',
  'Bereiche aufziehen oder Text auswählen. Erst „Anwenden“ entfernt Text und Bilder darunter endgültig.':
    'Drag over areas or select text. Text and images underneath are only removed for good when you apply.',
  'Noch nichts markiert': 'Nothing marked yet',
  'Schwärzen anwenden': 'Apply redaction',
  'Markierungen verwerfen': 'Discard marks',
  'Ausgewählte Anmerkung löschen (Entf)': 'Delete selected annotation (Del)',
  'Auswahl löschen': 'Delete selection',

  // ---------- Seiten organisieren ----------
  'Nach links drehen': 'Rotate left',
  'Nach rechts drehen': 'Rotate right',
  'Löschen (Entf)': 'Delete (Del)',
  'Auswahl als neues PDF speichern': 'Save selection as a new PDF',
  'Leere Seite einfügen (nach der Auswahl, sonst am Ende)': 'Insert blank page (after the selection, otherwise at the end)',
  'PDF oder Bilder einfügen (nach der Auswahl, sonst am Ende)': 'Insert PDF or images (after the selection, otherwise at the end)',
  'Zurück zum Dokument (Esc)': 'Back to the document (Esc)',
  'Fertig': 'Done',

  // ---------- Unterschrift hinzufügen ----------
  'Unterschrift hinzufügen': 'Add signature',
  'Tippen': 'Type',
  'Bild': 'Image',
  'Hier unterschreiben': 'Sign here',
  'Neu beginnen': 'Start over',
  'Bild hierher ziehen oder': 'Drag an image here or',
  'auswählen': 'browse',
  'Beschreibung': 'Description',
  'Unterschrift': 'Signature',
  'Für später speichern': 'Save for later',
  'Abbrechen': 'Cancel',
  'Hinzufügen': 'Add',

  // ---------- Leiste unten, Mehr ----------
  'PDF-Werkzeuge': 'PDF tools',
  'Vorherige Seite (←)': 'Previous page (←)',
  'Seite': 'Page',
  'Nächste Seite (→)': 'Next page (→)',
  'Verkleinern (Strg −)': 'Zoom out (Ctrl −)',
  'Auf 100 %': 'Reset to 100%',
  'Vergrößern (Strg +)': 'Zoom in (Ctrl +)',
  'An Breite anpassen': 'Fit to width',
  'Ganze Seite zeigen': 'Fit whole page',
  'Suchen (Strg F)': 'Find (Ctrl F)',
  'Dunkle Seiten': 'Dark pages',
  'Helle Seiten': 'Light pages',
  'Drucken (Strg P)': 'Print (Ctrl P)',
  'Speichern (Strg S)': 'Save (Ctrl S)',
  'Änderungen speichern (Strg S)': 'Save changes (Ctrl S)',
  'Mehr': 'More',
  'Öffnen …': 'Open…',
  'Strg O': 'Ctrl O',
  'Speichern unter …': 'Save as…',
  'Strg ⇧ S': 'Ctrl ⇧ S',
  'Drucken': 'Print',
  'Strg P': 'Ctrl P',
  'PDF aus Bildern …': 'PDF from images…',
  'Wasserzeichen, Kopf- und Fußzeile …': 'Watermark, header and footer…',
  'Dateigröße verringern …': 'Reduce file size…',
  'Mit Passwort schützen …': 'Protect with password…',

  // ---------- PDF aus Bildern ----------
  'PDF aus Bildern': 'PDF from images',
  'PDF aus einem Bild': 'PDF from one image',
  'PDF aus {n} Bildern': 'PDF from {n} images',
  'Bilder in Seitenreihenfolge': 'Images in page order',
  'Jedes Bild wird eine Seite. Ziehen ändert die Reihenfolge, weitere Bilder lassen sich hierher ziehen.':
    'Each image becomes a page. Drag to change the order, or drop more images here.',
  'Seitengröße': 'Page size',
  'Wie das Bild': 'Same as image',
  'Rand': 'Margin',
  'Kein Rand': 'No margin',
  'Schmal': 'Narrow',
  'Breit': 'Wide',
  'An dieses PDF anhängen': 'Append to this PDF',
  'Neues PDF erstellen': 'Create new PDF',
  'Entfernen': 'Remove',
  'Weitere Bilder …': 'More images…',
  '„{name}“ ist kein Bild, das sich öffnen lässt.': '“{name}” is not an image that can be opened.',
  'Datei': 'File',
  'Ein Bild ließ sich nicht lesen.': 'An image could not be read.',
  'Bilder.pdf': 'Images.pdf',
  'Das PDF ließ sich nicht erstellen.': 'The PDF could not be created.',
  'Bild als Seite angehängt': 'Image appended as a page',
  '{n} Bilder als Seiten angehängt': '{n} images appended as pages',

  // ---------- Dateigröße verringern ----------
  'Dateigröße verringern': 'Reduce file size',
  'Hohe Qualität': 'High quality',
  'Ausgewogen': 'Balanced',
  'Kleinste Datei': 'Smallest file',
  'Bilder höchstens 200 dpi – kaum ein sichtbarer Unterschied, auch im Druck.': 'Images at most 200 dpi – barely a visible difference, even in print.',
  'Bilder höchstens 144 dpi – gut für Bildschirm und Bürodrucker.': 'Images at most 144 dpi – good for screens and office printers.',
  'Bilder höchstens 96 dpi – die kleinste Datei, für den Bildschirm.': 'Images at most 96 dpi – the smallest file, for on-screen viewing.',
  'Dieses PDF enthält keine Bilder, die sich verkleinern lassen – darum ist jede Stufe gleich groß. Kleiner wird es durch gepackte Daten und weggelassene alte Fassungen.':
    'This PDF has no images that can be reduced, so every level gives the same size. It gets smaller through compressed data and by dropping old revisions.',
  'wird berechnet …': 'calculating…',
  'Wird berechnet …': 'Calculating…',
  'etwa {size} (−{percent} %)': 'about {size} (−{percent}%)',
  'kaum kleiner': 'barely smaller',
  'geht nicht': 'not possible',
  'Das PDF ist schon kompakt – kleiner geht es kaum.': 'The PDF is already compact – it can hardly get any smaller.',
  '{stem} (verkleinert).pdf': '{stem} (reduced).pdf',
  '„{name}“': '“{name}”',
  'Verkleinerte Fassung': 'Reduced version',
  '{what} gespeichert – {size} statt {before}': '{what} saved – {size} instead of {before}',
  'Größe wird ermittelt …': 'Determining size…',
  'Das PDF ließ sich nicht lesen.': 'The PDF could not be read.',
  'Jetzt {size}. Die verkleinerte Fassung wird als neue Datei gespeichert, dieses PDF bleibt unverändert.':
    'Currently {size}. The reduced version is saved as a new file; this PDF stays unchanged.',

  // ---------- Mit Passwort schützen ----------
  'Mit Passwort schützen': 'Protect with password',
  'Passwort': 'Password',
  // „Wiederholen“ heißt im Passwort-Dialog „noch einmal eingeben“, sonst wie Strg+Y
  'Wiederholen@protect-form': 'Confirm',
  'Wiederholen': 'Redo',
  'Schutz entfernen': 'Remove protection',
  'Schützen': 'Protect',
  'Das PDF ist mit einem Passwort geschützt. Ein neues Passwort ersetzt es.': 'The PDF is password protected. A new password replaces the current one.',
  'Wer das PDF öffnen will, braucht dann dieses Passwort.': 'Anyone who wants to open the PDF will then need this password.',
  'Passwortschutz wird beim Speichern entfernt': 'Password protection will be removed when you save',
  'Mindestens 4 Zeichen.': 'At least 4 characters.',
  'Die Passwörter stimmen nicht überein.': 'The passwords do not match.',
  'Wird beim Speichern mit Passwort geschützt (AES-256)': 'Will be password protected (AES-256) when you save',

  // ---------- Seiten gestalten ----------
  'Seiten gestalten': 'Page design',
  'Wasserzeichen': 'Watermark',
  'Kopf- und Fußzeile': 'Header and footer',
  'Seitenzahlen': 'Page numbers',
  'VERTRAULICH': 'CONFIDENTIAL',
  'Drehung': 'Rotation',
  'Platzhalter: {seite}, {seiten}, {datum}, {datei}': 'Placeholders: {page}, {pages}, {date}, {file}',
  'Kopf links': 'Header left',
  'Kopf Mitte': 'Header center',
  'Kopf rechts': 'Header right',
  'Fuß links': 'Footer left',
  'Fuß Mitte': 'Footer center',
  'Fuß rechts': 'Footer right',
  'Schriftgröße': 'Font size',
  'Seite 1': 'Page 1',
  'Seite 1 von 3': 'Page 1 of 3',
  // Werte der Auswahl „Format“ (Seitenzahlen, design.mjs)
  '{seite}': '{page}',
  'Seite {seite}': 'Page {page}',
  'Seite {seite} von {seiten}': 'Page {page} of {pages}',
  '{seite} / {seiten}': '{page} / {pages}',
  'Unten Mitte': 'Bottom center',
  'Unten rechts': 'Bottom right',
  'Unten links': 'Bottom left',
  'Oben Mitte': 'Top center',
  'Oben rechts': 'Top right',
  'Oben links': 'Top left',
  'Beginnt bei': 'Start at',
  'Alle (oder z. B. 1-3, 5)': 'All (or e.g. 1-3, 5)',
  'Wasserzeichen hinzugefügt': 'Watermark added',
  'Kopf- und Fußzeile hinzugefügt': 'Header and footer added',
  'Seitenzahlen hinzugefügt': 'Page numbers added',
  'Ein Zeichen lässt sich in der Standardschrift nicht darstellen.': 'A character cannot be shown in the standard font.',

  // ---------- Laden, Speichern, Meldungen (viewer.mjs) ----------
  'PDF wird geöffnet …': 'Opening PDF…',
  'Öffnen': 'Open',
  'Das Dokument ist nicht mehr im Speicher.': 'The document is no longer in memory.',
  'Neu laden': 'Reload',
  'Diese Datei ist kein gültiges PDF.': 'This file is not a valid PDF.',
  'Das PDF ließ sich nicht öffnen.': 'The PDF could not be opened.',
  'Falsches Passwort – noch einmal versuchen.': 'Wrong password – please try again.',
  'Dieses PDF ist mit einem Passwort geschützt.': 'This PDF is password protected.',
  '{current} von {total}': '{current} of {total}',
  'Keine Treffer': 'No matches',
  'Rückgängig': 'Undo',
  'Rückgängig gemacht': 'Undone',
  'Wiederholt': 'Redone',
  'Das hat nicht geklappt – das PDF ist unverändert.': 'That didn’t work – the PDF is unchanged.',
  'Speichern hat nicht geklappt': 'Saving failed',
  'Speichern hat nicht geklappt.': 'Saving failed.',
  'Als Download gespeichert': 'Saved as a download',
  'Gespeichert unter „{name}“': 'Saved as “{name}”',
  'Gespeichert': 'Saved',
  '„{name}“ ist in einem neuen Tab geöffnet': '“{name}” is open in a new tab',
  'Formular – Felder direkt ausfüllen, dann speichern (Strg S)': 'Form – fill in the fields directly, then save (Ctrl S)',

  // ---------- Bearbeiten (editor.mjs) ----------
  'Beschreibung bearbeiten': 'Edit description',
  'Beschreibung der Unterschrift': 'Signature description',
  'Es sind schon 5 Unterschriften gespeichert – zuerst eine entfernen.': '5 signatures are already saved – remove one first.',
  'Nicht erkannt': 'Not recognized',
  'Stempel: {text}': 'Stamp: {text}',
  'Die Seite ist noch nicht bereit – bitte noch einmal.': 'The page isn’t ready yet – please try again.',
  'Dieses Bild lässt sich nicht lesen.': 'This image cannot be read.',
  'Dieses Bild lässt sich nicht drehen.': 'This image cannot be rotated.',
  // Stempel: der Text kommt so ins PDF
  'Genehmigt': 'Approved',
  'Geprüft': 'Reviewed',
  'Erledigt': 'Completed',
  'Entwurf': 'Draft',
  'Vertraulich': 'Confidential',
  'Abgelehnt': 'Rejected',
  '„{text}“ einsetzen': 'Place “{text}”',
  'Drehen (Umschalt: in 15°-Schritten)': 'Rotate (Shift: in 15° steps)',
  '{description} einfügen': 'Insert {description}',
  'Gespeicherte Unterschrift entfernen': 'Remove saved signature',

  // ---------- Organisieren (organize.mjs) ----------
  '{n} von {total} ausgewählt': '{n} of {total} selected',
  '1 Seite': '1 page',
  '{n} Seiten': '{n} pages',
  'Seite verschoben': 'Page moved',
  '{n} Seiten verschoben': '{n} pages moved',
  'Seite gelöscht': 'Page deleted',
  '{n} Seiten gelöscht': '{n} pages deleted',
  'Nach rechts gedreht': 'Rotated right',
  'Nach links gedreht': 'Rotated left',
  'Diese Datei lässt sich nicht einfügen.': 'This file cannot be inserted.',
  '„{name}“ eingefügt': '“{name}” inserted',
  '{n} PDFs eingefügt': '{n} PDFs inserted',
  '{n} Bilder eingefügt': '{n} images inserted',
  '{n} Dateien eingefügt': '{n} files inserted',
  'Leere Seite eingefügt': 'Blank page inserted',
  '{stem} (Seite {pages}).pdf': '{stem} (page {pages}).pdf',
  '{stem} (Seiten {pages}).pdf': '{stem} (pages {pages}).pdf',
  'Seite als eigenes PDF gespeichert': 'Page saved as a separate PDF',
  '{n} Seiten als eigenes PDF gespeichert': '{n} pages saved as a separate PDF',
  'Das Extrahieren hat nicht geklappt.': 'Extracting the pages failed.',

  // ---------- Notizen und Kommentare (notes.mjs); Arten von Anmerkungen ----------
  'Vieleck': 'Polygon',
  'Linienzug': 'Polyline',
  'Hervorhebung': 'Highlight',
  'Unterstrichen': 'Underline',
  'Gewellt': 'Squiggly',
  'Durchgestrichen': 'Strikethrough',
  'Stempel': 'Stamp',
  'Einfügen': 'Insertion',
  'Zeichnung': 'Drawing',
  'Anmerkung': 'Annotation',
  'Zuklappen': 'Collapse',
  'Notiz schreiben …': 'Write a note…',
  'Notiz löschen': 'Delete note',
  'Löschen': 'Delete',
  'Notiz gelöscht': 'Note deleted',
  'Noch keine Kommentare. Mit dem Notiz-Werkzeug (N) eine Notiz anheften.': 'No comments yet. Pin a note with the Note tool (N).',
  'Seite {n}': 'Page {n}',
  'Leere Notiz': 'Empty note',

  // ---------- Schwärzen (redact.mjs) ----------
  '1 Bereich markiert': '1 area marked',
  '{n} Bereiche markiert': '{n} areas marked',
  'Markierung entfernen': 'Remove mark',
  'Bereich geschwärzt': 'Area redacted',
  '{n} Bereiche geschwärzt': '{n} areas redacted',
  'Seite {pages} enthielt Bilder unter einem Balken und wurde als Bild gespeichert.':
    'Images were under a bar, so page {pages} was saved as an image.',

  // ---------- Text bearbeiten (textedit.mjs) ----------
  'Dieser Text liegt in einem eingebetteten Objekt und lässt sich hier nicht ändern.': 'This text is inside an embedded object and cannot be changed here.',
  '„{char}“ gibt es in dieser Schrift nicht.': '“{char}” is not available in this font.',
  'Ein Zeichen lässt sich in der Standardschrift nicht darstellen – eine installierte Schrift wählen.':
    'A character cannot be shown in the standard font – choose an installed font.',
  'Standardschriften': 'Standard fonts',
  'Installiert': 'Installed',
  'Text entfernt': 'Text removed',
  'Schrift geändert': 'Font changed',
  'Text geändert': 'Text changed',
  'Die Schrift ließ sich nicht laden.': 'The font could not be loaded.',

  // ---------- Formularfelder (fields.mjs) ----------
  'Auswahl': 'Option',
  '{kind} angelegt': '{kind} added',

  // ---------- Bilder bearbeiten (imageedit.mjs) ----------
  'Das Bild wurde auf der Seite nicht mehr gefunden.': 'The image could no longer be found on the page.',
  'Bild verschoben': 'Image moved',
  'Bildgröße geändert': 'Image resized',
  'Bild gelöscht': 'Image deleted',
  'Das Bild ließ sich nicht lesen.': 'The image could not be read.',
  'Bild ersetzt': 'Image replaced',
};
export default EN_TEXT;

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);
/** Text in der Sprache der Oberfläche; `de` ist der deutsche Text (und Schlüssel), `vars` füllt `{name}`. */
export function t(de, vars = null) {
  return fill(EN ? EN_TEXT[de] ?? de : de, vars);
}
/** Prozent wie üblich: „20 %“ bzw. „20%“. */
export const percent = (n) => (EN ? `${n}%` : `${n} %`);

/** Englisch für einen Text aus viewer.html; `el`: das Element, in dem er steht (für „Text@id“). */
function lookup(text, el) {
  const context = el?.closest('[id]')?.id;
  const english = (context && EN_TEXT[`${text}@${context}`]) ?? EN_TEXT[text];
  if (english !== undefined) return english;
  // Anfangswerte der Regler und des Zooms: „100 %“
  const pct = /^(\d+) %$/.exec(text);
  return pct ? percent(pct[1]) : text;
}

/** Übersetzt die festen Texte von viewer.html einmal beim Start: Textknoten, Titel, Platzhalter, Vorgabewerte. */
export function translatePage(root = document.body) {
  if (!EN) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.data.trim();
    if (!text || node.parentElement?.closest('script, style')) continue;
    const english = lookup(text, node.parentElement);
    if (english !== text) node.data = node.data.replace(text, () => english);
  }
  for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      const text = el.getAttribute(attr).trim();
      const english = text && lookup(text, el);
      if (english && english !== text) el.setAttribute(attr, english);
    }
  }
  // Sichtbare Vorgabewerte von Textfeldern (Wasserzeichen „VERTRAULICH“)
  for (const el of root.querySelectorAll('input[value]:not([type]), input[type=text][value]')) {
    const english = EN_TEXT[el.getAttribute('value')];
    if (english !== undefined) el.setAttribute('value', english);
  }
}
