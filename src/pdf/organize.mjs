// Seiten organisieren wie in Acrobat: alle Seiten als Raster – auswählen (Klick, Strg, Umschalt, Strg+A), ziehen,
// drehen, löschen, leere Seiten, andere PDFs oder Bilder einfügen, Auswahl als eigenes PDF speichern.
// Jede Änderung baut mit PDF.js (extractPages) ein neues PDF, Anmerkungen und Formularwerte inklusive, und lädt es
// im Viewer neu. Drehen und leere Seiten kann PDF.js nicht – das übernimmt pdf-lib.
import { prepareImage, pdfFromImages, isImageFile } from './images.mjs';

const $ = (id) => document.getElementById(id);
const THUMB = 150;
const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

export function initOrganize(app) {
  const root = $('organize'), grid = $('org-grid'), count = $('org-count');
  const buttons = {
    left: $('org-rotate-left'), right: $('org-rotate-right'), del: $('org-delete'),
    extract: $('org-extract'), insert: $('org-insert'), blank: $('org-blank'), undo: $('org-undo'), redo: $('org-redo'),
  };
  let selected = new Set(), anchor = null, busy = false;
  let observer = null, rendered = new WeakSet(), drawToken = 0;

  // ---------- Raster ----------
  function build() {
    const doc = app.doc, token = ++drawToken;
    observer?.disconnect();
    rendered = new WeakSet();
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) draw(entry.target, doc, token);
    }, { root: grid, rootMargin: '400px 0px' });
    const tiles = [];
    for (let i = 0; i < doc.numPages; i++) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.index = i;
      tile.draggable = true;
      tile.tabIndex = -1;
      tile.innerHTML = `<div class="sheet" style="width:${THUMB}px;height:${Math.round(THUMB * 1.3)}px"></div><span>${i + 1}</span>`;
      tiles.push(tile);
      observer.observe(tile);
    }
    // Fokus war auf einer der alten Kacheln: auf die (erste) ausgewählte, damit Tastenkürzel weiter wirken
    const hadFocus = grid.contains(document.activeElement) || document.activeElement === document.body;
    grid.replaceChildren(...tiles);
    selected = new Set([...selected].filter((i) => i < doc.numPages));
    if (selected.size) anchor = Math.min(...selected);
    mark();
    if (hadFocus && !root.hidden) (tiles[anchor] || grid).focus({ preventScroll: true });
  }

  async function draw(tile, doc, token) {
    if (rendered.has(tile)) return;
    rendered.add(tile);
    const page = await doc.getPage(+tile.dataset.index + 1);
    if (token !== drawToken) return;
    const base = page.getViewport({ scale: 1 });
    // Hochformat und Querformat passen in dieselbe Kachel
    const fit = Math.min(THUMB / base.width, THUMB * 1.3 / base.height);
    const viewport = page.getViewport({ scale: fit * devicePixelRatio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const sheet = tile.firstElementChild;
    sheet.style.width = `${Math.round(base.width * fit)}px`;
    sheet.style.height = `${Math.round(base.height * fit)}px`;
    // Anmerkungen und ausgefüllte Formulare mitzeichnen, wie sie gespeichert würden
    await page.render({
      canvasContext: canvas.getContext('2d'), viewport,
      annotationMode: app.pdfjsLib.AnnotationMode.ENABLE_STORAGE,
    }).promise.catch(() => {});
    if (token === drawToken) sheet.replaceChildren(canvas);
  }

  function mark() {
    for (const tile of grid.children) tile.classList.toggle('selected', selected.has(+tile.dataset.index));
    const n = selected.size, total = app.doc.numPages;
    count.textContent = n ? `${n} von ${total} ausgewählt` : `${total} ${total === 1 ? 'Seite' : 'Seiten'}`;
    for (const key of ['left', 'right', 'extract']) buttons[key].disabled = !n || busy;
    // Mindestens eine Seite muss bleiben
    buttons.del.disabled = !n || n >= total || busy;
    buttons.insert.disabled = buttons.blank.disabled = busy;
    buttons.undo.disabled = !app.canUndoChange || busy;
    buttons.redo.disabled = !app.canRedoChange || busy;
    app.placeWells();
  }

  // ---------- Auswahl ----------
  grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) { if (!e.ctrlKey && !e.shiftKey) { selected.clear(); mark(); } return; }
    const i = +tile.dataset.index;
    if (e.shiftKey && anchor !== null) {
      if (!e.ctrlKey) selected.clear();
      for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) selected.add(k);
    } else if (e.ctrlKey) {
      selected.has(i) ? selected.delete(i) : selected.add(i);
      anchor = i;
    } else {
      selected = new Set([i]);
      anchor = i;
    }
    tile.focus({ preventScroll: true });
    mark();
  });
  // Doppelklick: zu dieser Seite im Dokument
  grid.addEventListener('dblclick', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    close();
    app.viewer.currentPageNumber = +tile.dataset.index + 1;
  });

  // ---------- Ziehen: Seiten umsortieren, PDF-Dateien einfügen ----------
  let dragging = null;
  const marker = document.createElement('div');
  marker.className = 'drop-marker';
  /** Vor welcher Seite abgelegt wird (0 … Seitenzahl), aus der Lage des Mauszeigers über dem Raster. */
  function dropIndex(e) {
    const tiles = [...grid.querySelectorAll('.tile')];
    let best = tiles.length, bestDist = Infinity;
    for (const tile of tiles) {
      const r = tile.getBoundingClientRect();
      if (e.clientY < r.top - 12 || e.clientY > r.bottom + 12) continue;
      const mid = r.left + r.width / 2;
      const dist = Math.abs(e.clientX - mid);
      if (dist < bestDist) { bestDist = dist; best = +tile.dataset.index + (e.clientX > mid ? 1 : 0); }
    }
    if (bestDist === Infinity) {
      // Unter der letzten Zeile: ans Ende; darüber: an den Anfang
      const first = tiles[0]?.getBoundingClientRect();
      best = first && e.clientY < first.top ? 0 : tiles.length;
    }
    return best;
  }
  function showMarker(index) {
    const tiles = grid.querySelectorAll('.tile');
    const ref = tiles[Math.min(index, tiles.length - 1)];
    if (!ref) return;
    const r = ref.getBoundingClientRect(), g = grid.getBoundingClientRect();
    const x = index >= tiles.length ? r.right + 9 : r.left - 9;
    marker.style.transform = `translate(${x - g.left + grid.scrollLeft}px, ${r.top - g.top + grid.scrollTop}px)`;
    marker.style.height = `${r.height}px`;
    if (!marker.isConnected) grid.append(marker);
  }
  grid.addEventListener('dragstart', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile || busy) return e.preventDefault();
    const i = +tile.dataset.index;
    if (!selected.has(i)) { selected = new Set([i]); anchor = i; mark(); }
    dragging = [...selected].sort((a, b) => a - b);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging.map((k) => k + 1).join(','));
    requestAnimationFrame(() => { for (const k of dragging) grid.children[k]?.classList.add('dragging'); });
  });
  grid.addEventListener('dragover', (e) => {
    const files = [...e.dataTransfer.items].some((item) => item.kind === 'file');
    if (!dragging && !files) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragging ? 'move' : 'copy';
    showMarker(dropIndex(e));
  });
  grid.addEventListener('dragleave', (e) => { if (!grid.contains(e.relatedTarget)) marker.remove(); });
  grid.addEventListener('dragend', () => {
    dragging = null;
    marker.remove();
    for (const tile of grid.querySelectorAll('.dragging')) tile.classList.remove('dragging');
  });
  grid.addEventListener('drop', async (e) => {
    e.preventDefault();
    const at = dropIndex(e);
    marker.remove();
    if (dragging) {
      const moved = dragging;
      dragging = null;
      await move(moved, at);
    } else {
      const files = [...e.dataTransfer.files].filter((f) => isPdf(f) || isImageFile(f));
      if (files.length) await insert(files, at);
    }
  });

  // ---------- Änderungen ----------
  // Jede Änderung läuft über app.applyChange: Grundlage ist die Arbeitsfassung (mit Notizen und allen Anmerkungen),
  // Rückgängig teilt sich der Viewer mit Wasserzeichen, Schwärzen usw.
  /** `make(bytes, lib)` liefert das neue PDF, `select` die danach ausgewählten Seiten. */
  async function change(label, make, select) {
    if (busy) return;
    busy = true;
    root.classList.add('busy');
    mark();
    try {
      if (await app.applyChange(label, make, { toastUndo: false })) {
        selected = new Set(select || []);
        build();
      }
    } finally {
      busy = false;
      root.classList.remove('busy');
      mark();
    }
  }
  /** extractPages auf der Arbeitsfassung (damit Notizen mit ihrer Seite wandern). */
  const extractFrom = (bytes, infos) => app.withDocument(bytes, (doc) => doc.extractPages(infos));

  const all = () => [...Array(app.doc.numPages).keys()];
  // Ein Eintrag für das ganze Dokument; pageIndices legt fest, wo jede Seite im Ergebnis landet
  const reorder = (bytes, order) => {
    const position = new Array(order.length);
    order.forEach((old, at) => { position[old] = at; });
    return extractFrom(bytes, [{ document: null, includePages: all(), pageIndices: position }]);
  };

  function move(pages, before) {
    const rest = all().filter((i) => !pages.includes(i));
    const at = before - pages.filter((i) => i < before).length;
    const order = [...rest.slice(0, at), ...pages, ...rest.slice(at)];
    if (order.every((old, i) => old === i)) return;
    const n = pages.length;
    return change(n === 1 ? 'Seite verschoben' : `${n} Seiten verschoben`, (bytes) => reorder(bytes, order), pages.map((_, k) => at + k));
  }

  function remove() {
    const pages = [...selected];
    if (!pages.length || pages.length >= app.doc.numPages) return;
    const keep = all().filter((i) => !selected.has(i));
    const n = pages.length;
    const next = Math.min(Math.min(...pages), keep.length - 1);
    return change(n === 1 ? 'Seite gelöscht' : `${n} Seiten gelöscht`,
      (bytes) => extractFrom(bytes, [{ document: null, includePages: keep }]), [next]);
  }

  // Drehen kann PDF.js nicht speichern – pdf-lib setzt /Rotate (die Arbeitsfassung ist nie verschlüsselt)
  async function rotate(delta) {
    const pages = [...selected];
    if (!pages.length) return;
    return change(delta > 0 ? 'Nach rechts gedreht' : 'Nach links gedreht', async (bytes, { PDFDocument, degrees }) => {
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      for (const i of pages) {
        const page = pdf.getPage(i);
        page.setRotation(degrees((((page.getRotation().angle + delta) % 360) + 360) % 360));
      }
      return pdf.save({ updateFieldAppearances: false });
    }, pages);
  }

  /** Format der Seite, neben der eingefügt wird (wie man sie sieht, also mit Drehung). */
  async function neighbourSize(before) {
    const view = (await app.doc.getPage(Math.max(1, Math.min(before, app.doc.numPages)))).getViewport({ scale: 1 });
    return [view.width, view.height];
  }

  /** PDFs und Bilder vor Seite `before` (0-basiert) einfügen; Bilder werden Seiten im Format der Nachbarseite. */
  async function insert(files, before) {
    let datas;
    try {
      const size = files.some(isImageFile) ? await neighbourSize(before) : null;
      const lib = await app.loadPdfLib();
      datas = [];
      // Aufeinanderfolgende Bilder werden zusammen ein PDF
      for (let i = 0; i < files.length;) {
        if (isPdf(files[i])) { datas.push(new Uint8Array(await files[i++].arrayBuffer())); continue; }
        const images = [];
        while (i < files.length && !isPdf(files[i])) images.push(await prepareImage(files[i++]));
        datas.push(await pdfFromImages(lib, images, { size, margin: 0 }));
      }
    } catch (err) {
      app.toast(err.userMessage || 'Diese Datei lässt sich nicht einfügen.');
      return;
    }
    const insertAfter = before - 1;
    // Seitenzahlen der neuen Seiten für die Auswahl danach
    let added = 0;
    for (const data of datas) {
      try {
        added += await app.withDocument(data, (d) => d.numPages);
      } catch {
        app.toast('Diese Datei ist kein gültiges PDF.');
        return;
      }
    }
    const kinds = files.every(isPdf) ? 'PDFs' : files.every(isImageFile) ? 'Bilder' : 'Dateien';
    const label = files.length === 1 ? `„${files[0].name}“ eingefügt` : `${files.length} ${kinds} eingefügt`;
    return change(label, (bytes) => extractFrom(bytes, [
      { document: null },
      // Mehrere Dateien landen in ihrer Reihenfolge hintereinander an derselben Stelle
      ...datas.map((data) => ({ document: data, insertAfter })),
    ]), Array.from({ length: added }, (_, k) => before + k));
  }

  /** Leere Seite nach der Auswahl (sonst am Ende), im Format der Seite davor. */
  async function blank() {
    const at = selected.size ? Math.max(...selected) + 1 : app.doc.numPages;
    const size = await neighbourSize(at);
    return change('Leere Seite eingefügt', async (bytes, { PDFDocument }) => {
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      pdf.insertPage(at, size);
      return pdf.save({ updateFieldAppearances: false });
    }, [at]);
  }

  async function extract() {
    const pages = [...selected].sort((a, b) => a - b);
    if (!pages.length || busy) return;
    busy = true;
    mark();
    try {
      const bytes = await extractFrom(await app.workingBytes(), [{ document: null, includePages: pages }]);
      const stem = app.name.replace(/\.pdf$/i, '');
      const ranges = [];
      for (const i of pages) {
        const last = ranges.at(-1);
        if (last && last[1] === i - 1) last[1] = i; else ranges.push([i, i]);
      }
      const label = ranges.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}–${b + 1}`)).join(', ');
      const result = await app.writeFile(bytes, `${stem} (Seite${pages.length > 1 ? 'n' : ''} ${label}).pdf`, true);
      if (result.ok) app.toast(pages.length === 1 ? 'Seite als eigenes PDF gespeichert' : `${pages.length} Seiten als eigenes PDF gespeichert`);
    } catch (err) {
      console.error(err);
      app.toast('Das Extrahieren hat nicht geklappt.');
    } finally {
      busy = false;
      mark();
    }
  }

  /** Rückgängig (`redo` = false) oder Wiederholen über den gemeinsamen Verlauf des Viewers. */
  async function travel(redo = false) {
    if (busy || !(redo ? app.canRedoChange : app.canUndoChange)) return;
    busy = true;
    mark();
    try {
      if (await (redo ? app.redoChange() : app.undoChange())) {
        selected.clear();
        build();
      }
    } finally {
      busy = false;
      mark();
    }
  }
  const undoLast = () => travel(false);

  buttons.left.onclick = () => rotate(-90);
  buttons.right.onclick = () => rotate(90);
  buttons.del.onclick = remove;
  buttons.extract.onclick = extract;
  buttons.blank.onclick = blank;
  buttons.undo.onclick = undoLast;
  buttons.redo.onclick = () => travel(true);
  const fileInput = $('org-file');
  buttons.insert.onclick = () => { fileInput.value = ''; fileInput.click(); };
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    if (!files.length) return;
    const after = selected.size ? Math.max(...selected) + 1 : app.doc.numPages;
    insert(files, after);
  });
  $('org-done').onclick = () => close();

  root.addEventListener('keydown', (e) => {
    if (e.target.closest('input')) return;
    const key = e.key.toLowerCase();
    // Behandelte Tasten gehen nicht weiter an den Viewer (Pfeile blättern dort); Strg+S, Strg+P usw. schon
    const handled = (e.ctrlKey && (key === 'a' || key === 'z' || key === 'y')) || ['Delete', 'Backspace', 'Escape', 'ArrowLeft', 'ArrowRight'].includes(e.key);
    if (handled) e.stopPropagation();
    if (e.ctrlKey && key === 'a') { e.preventDefault(); selected = new Set(all()); mark(); }
    else if (e.ctrlKey && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); travel(true); }
    else if (e.ctrlKey && key === 'z') { e.preventDefault(); undoLast(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
    else if (e.key === 'Escape') { e.preventDefault(); selected.size ? (selected.clear(), mark()) : close(); }
    else if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selected.size) {
      // Strg+Pfeil: Auswahl um eine Stelle verschieben
      e.preventDefault();
      const pages = [...selected].sort((a, b) => a - b);
      const before = e.key === 'ArrowLeft' ? Math.max(0, pages[0] - 1) : Math.min(app.doc.numPages, pages.at(-1) + 2);
      move(pages, before);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const i = Math.max(0, Math.min(app.doc.numPages - 1, (anchor ?? -1) + (e.key === 'ArrowLeft' ? -1 : 1)));
      if (e.shiftKey && anchor !== null) selected.add(i); else selected = new Set([i]);
      anchor = i;
      grid.children[i]?.scrollIntoView({ block: 'nearest' });
      mark();
    }
  });

  // ---------- Öffnen / Schließen ----------
  function open() {
    if (!root.hidden) return;
    app.tools.setTool('none');
    document.body.classList.add('organizing');
    root.hidden = false;
    $('organize-open').classList.add('on');
    selected = new Set([app.viewer.currentPageNumber - 1]);
    anchor = app.viewer.currentPageNumber - 1;
    build();
    grid.focus({ preventScroll: true });
    requestAnimationFrame(() => grid.children[anchor]?.scrollIntoView({ block: 'center' }));
    app.placeWells();
    app.scheduleInk();
  }
  function close() {
    if (root.hidden) return;
    observer?.disconnect();
    drawToken++;
    root.hidden = true;
    document.body.classList.remove('organizing');
    $('organize-open').classList.remove('on');
    const first = Math.min(...selected);
    if (Number.isFinite(first)) app.viewer.currentPageNumber = first + 1;
    app.container.focus();
    app.placeWells();
    app.scheduleInk();
  }
  $('organize-open').onclick = () => (root.hidden ? open() : close());

  return { open, close, insert, blank, get isOpen() { return !root.hidden; }, get selected() { return [...selected]; } };
}
