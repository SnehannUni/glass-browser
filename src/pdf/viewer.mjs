// Glass-PDF-Viewer: PDF.js rendert, Oberfläche und Bedienung sind eigen.
// Läuft mit isoliertem Sandbox-Origin (pdf.rs); Skripte und Daten kommen von glass-pdf.localhost aus der Exe.
const BASE = 'http://glass-pdf.localhost/';
const $ = (id) => document.getElementById(id);
const name = document.body.dataset.name;

const pdfjsLib = await import(BASE + 'pdf.min.mjs');
globalThis.pdfjsLib = pdfjsLib; // pdf_viewer.mjs erwartet die Bibliothek global
const { EventBus, PDFLinkService, PDFFindController, PDFViewer, LinkTarget, FindState, GenericL10n } = await import(BASE + 'pdf_viewer.mjs');
const { initTools, Signatures, HIGHLIGHT_COLORS } = await import(BASE + 'editor.mjs');
const { initOrganize } = await import(BASE + 'organize.mjs');
const { initNotes } = await import(BASE + 'notes.mjs');
const { initRedact } = await import(BASE + 'redact.mjs');
const { initTextEdit } = await import(BASE + 'textedit.mjs');
const { initFields } = await import(BASE + 'fields.mjs');
const { initDesign } = await import(BASE + 'design.mjs');
const { initImages } = await import(BASE + 'images.mjs');
const { initCompress } = await import(BASE + 'compress.mjs');
const { initImageEdit } = await import(BASE + 'imageedit.mjs');
const { readPage } = await import(BASE + 'content.mjs');
// A data-URL module worker supports the viewer's opaque sandbox origin. PDF.js's URL-based
// origin check uses location.href, which still displays the original PDF URL.
const workerUrl = 'data:text/javascript,' + encodeURIComponent(`import "${BASE}pdf.worker.min.mjs";`);
pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: 'module' });
// Ein Worker für alle Dokumente, ausdrücklich übergeben: loadingTask.destroy() eines kurzlebigen Dokuments
// (Seiten organisieren, Notizen übernehmen) reißt ihn dann nicht mit
const pdfWorker = pdfjsLib.PDFWorker.create({ port: pdfjsLib.GlobalWorkerOptions.workerPort });

// ---------- Glas: Linse, Glanzkante, Wallpaper, Schriftfarbe (wie ui.html) ----------
window.GlassLens.watch();

let pointer = null, lightFrame = 0;
document.addEventListener('pointermove', (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  if (!lightFrame) lightFrame = requestAnimationFrame(() => {
    lightFrame = 0;
    for (const el of document.querySelectorAll('.glass')) if (el.offsetWidth) window.GlassRim.move(el, pointer.x, pointer.y);
  });
});
document.documentElement.addEventListener('pointerleave', () => window.GlassRim.leave());

// Wallpaper: einmal in Monitorgröße verschwommen gebacken, dann nur verschoben – genau wie hinter der Leiste oben,
// damit Tab und Fensterrand nahtlos ineinander übergehen. Die Lage schickt main.rs (sync_pdf_walls).
const wall = $('wall');
const wallImg = new Image();
wallImg.crossOrigin = 'anonymous'; // sonst ist das Canvas für die Helligkeitsmessung gesperrt
let geo = null, bakedFor = '', wellImage = '';
wallImg.onload = () => { bakeWall(); placeWall(); };
wallImg.src = document.body.dataset.wall;
function bakeWall() {
  if (!geo || !wallImg.naturalWidth) return;
  const dpr = devicePixelRatio, key = `${geo.mw}x${geo.mh}@${dpr}`;
  if (key === bakedFor) return;
  bakedFor = key;
  const W = Math.round(geo.mw * dpr), H = Math.round(geo.mh * dpr);
  wall.width = W; wall.height = H;
  wall.style.width = `${geo.mw}px`; wall.style.height = `${geo.mh}px`;
  const s = Math.max(W / wallImg.naturalWidth, H / wallImg.naturalHeight);
  const iw = wallImg.naturalWidth * s, ih = wallImg.naturalHeight * s, pad = 10 * dpr;
  const ctx = wall.getContext('2d');
  ctx.filter = `blur(${4 * dpr}px) saturate(1.05) brightness(.72)`; // wie bakeWall in ui.html
  ctx.drawImage(wallImg, (W - iw) / 2 - pad, (H - ih) / 2 - pad, iw + 2 * pad, ih + 2 * pad);
  wall.classList.add('ready');
  // Dasselbe Bild als Unterlage der schwebenden Kapseln
  wall.toBlob((blob) => {
    if (!blob) return;
    const root = document.documentElement.style;
    if (wellImage) URL.revokeObjectURL(wellImage);
    wellImage = URL.createObjectURL(blob);
    root.setProperty('--wall-image', `url("${wellImage}")`);
    root.setProperty('--wall-size', `${geo.mw}px ${geo.mh}px`);
    placeWells();
  });
  scheduleInk();
}
// Jede Unterlage zeigt den Ausschnitt des Wallpapers an ihrer eigenen Stelle
function placeWells() {
  if (!geo) return;
  const ox = geo.mx - geo.x, oy = geo.my - geo.y;
  for (const well of document.querySelectorAll('.well')) {
    const r = well.getBoundingClientRect();
    if (r.width) well.style.backgroundPosition = `${ox - r.left}px ${oy - r.top}px`;
  }
}
// Solange sich eine Kapsel bewegt (Aufspringen, Seitenleiste auf/zu), folgt ihre Unterlage in jedem Bild
const moving = new Set();
let wellFrame = 0;
const followWells = () => { placeWells(); wellFrame = moving.size ? requestAnimationFrame(followWells) : 0; };
for (const [start, end] of [['transitionrun', 'transitionend'], ['animationstart', 'animationend']]) {
  document.addEventListener(start, (e) => {
    if (!e.target.closest?.('#dock, #find')) return;
    moving.add(e.target);
    if (!wellFrame) followWells();
  });
  document.addEventListener(end, (e) => { moving.delete(e.target); placeWells(); });
}
addEventListener('resize', placeWells);
function placeWall() {
  if (geo) wall.style.transform = `translate3d(${geo.mx - geo.x}px, ${geo.my - geo.y}px, 0)`;
  placeWells();
}
window.__glassWall = (g) => { geo = g; bakeWall(); placeWall(); scheduleInk(); };
const askWall = () => window.ipc?.postMessage(JSON.stringify({ pdf: 'wall' }));
askWall();
// Aus dem Zurück-Cache wiederhergestellt: main.rs hat den Tab inzwischen vergessen
addEventListener('pageshow', (e) => { if (e.persisted) askWall(); });

// Dunkle oder helle Schrift je nach Untergrund: über einer hellen Seite dunkel, über dem Wallpaper gemessen wie in ui.html
const probe = document.createElement('canvas');
probe.width = 24; probe.height = 8;
const probeCtx = probe.getContext('2d', { willReadFrequently: true });
const linear = (v) => (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
function wallLuminance(r) {
  const c = wall.getBoundingClientRect();
  if (!wall.classList.contains('ready') || !c.width) return .03;
  const k = wall.width / c.width;
  probeCtx.clearRect(0, 0, probe.width, probe.height);
  probeCtx.drawImage(wall, (r.left - c.left) * k, (r.top - c.top) * k, r.width * k, r.height * k, 0, 0, probe.width, probe.height);
  const d = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const [R, G, B] = [d[i], d[i + 1], d[i + 2]].map((v) => linear((v * .82 * .92 + 255 * .08) / 255));
    sum += .2126 * R + .7152 * G + .0722 * B;
  }
  return sum / (d.length / 4);
}
// Anteil der Fläche, unter dem eine PDF-Seite liegt
function pageShare(r) {
  let hits = 0, n = 0;
  for (const fx of [.08, .3, .5, .7, .92]) for (const fy of [.3, .7]) {
    n++;
    if (document.elementsFromPoint(r.left + r.width * fx, r.top + r.height * fy).some((e) => e.classList.contains('page'))) hits++;
  }
  return hits / n;
}
function updateInk() {
  const pageLum = document.body.classList.contains('dark') ? .012 : .83;
  for (const el of document.querySelectorAll('.well > .glass, #sidebar, #status')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // Auf einer Unterlage liegt immer das Wallpaper darunter, nie eine Seite
    const share = el.closest('.well') ? 0 : pageShare(r);
    const lum = share * pageLum + (1 - share) * wallLuminance(r);
    // Umschaltpunkte auseinander, damit beim Scrollen über Seitenränder nichts flackert
    el.classList.toggle('ink-dark', el.classList.contains('ink-dark') ? lum > .17 : lum > .22);
  }
}
let inkFrame = 0;
function scheduleInk() {
  if (!inkFrame) inkFrame = requestAnimationFrame(() => { inkFrame = 0; updateInk(); });
}
addEventListener('resize', scheduleInk);
document.addEventListener('transitionend', scheduleInk);

const container = $('container');
container.addEventListener('scroll', scheduleInk, { passive: true });
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.TOP });
const findController = new PDFFindController({ eventBus, linkService });
// Was nur der Viewer dieses Tabs darf (Unterschriften, Speichern, Verschlüsseln): geheime Adresse aus pdf.rs
const API = document.body.dataset.api;
// Bearbeiten (editor.mjs): die Editoren von PDF.js, deutsch beschriftet, mit eigenem Dialog für Unterschriften
const signatures = new Signatures(pdfjsLib, API + 'signatures', () => app.onSignaturesChanged?.());
const viewer = new PDFViewer({
  container, viewer: $('viewer'), eventBus, linkService, findController,
  annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
  annotationEditorMode: pdfjsLib.AnnotationEditorType.NONE,
  annotationEditorHighlightColors: HIGHLIGHT_COLORS,
  signatureManager: signatures,
  l10n: new GenericL10n('de'),
  imageResourcesPath: BASE + 'images/',
});
linkService.setViewer(viewer);

// ---------- Laden ----------
const status = $('status');
function showStatus(text, kind = '') {
  $('status-text').textContent = text;
  status.className = 'glass ' + kind;
}

// Passwort, mit dem das PDF geöffnet wurde – es schützt auch die gespeicherte Fassung wieder (siehe exportBytes)
let openedWith = null;
/** Schutz beim Speichern: `{ password, original }` – original: das Passwort, mit dem die Datei schon geschützt war. */
let protection = null;
// PDF.js übernimmt die Bytes (sie wandern in den Worker) – wer sie noch braucht, gibt eine Kopie.
const openDocument = (data) => {
  const task = pdfjsLib.getDocument({
    data, worker: pdfWorker,
    cMapUrl: BASE + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    wasmUrl: BASE + 'wasm/', iccUrl: BASE + 'iccs/',
  });
  task.onPassword = (answer, reason) => askPassword((password) => {
    openedWith = password;
    // Mit Passwort geöffnet: gespeichert wird wieder geschützt
    protection = { password, original: true };
    answer(password);
  },
    reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
  return task.promise;
};

let doc;
try {
  const res = await fetch(document.body.dataset.doc);
  // Die Bytes gibt es nur einmal – etwa nach „Seite wiederherstellen“ fehlen sie: dann einfach neu laden lassen.
  if (!res.ok) throw new Error('gone');
  doc = await openDocument(new Uint8Array(await res.arrayBuffer()));
} catch (err) {
  if (err.message === 'gone') {
    showStatus('Das Dokument ist nicht mehr im Speicher.', 'error');
    const again = Object.assign(document.createElement('button'), { textContent: 'Neu laden', className: 'again' });
    again.onclick = () => location.reload();
    status.append(again);
  } else {
    showStatus(err.name === 'InvalidPDFException' ? 'Diese Datei ist kein gültiges PDF.' : 'Das PDF ließ sich nicht öffnen.', 'error');
  }
  throw err;
}

function askPassword(answer, wrong) {
  const form = $('password'), input = $('password-input');
  showStatus(wrong ? 'Falsches Passwort – noch einmal versuchen.' : 'Dieses PDF ist mit einem Passwort geschützt.', 'asking');
  form.hidden = false;
  input.value = '';
  input.focus();
  form.onsubmit = (e) => {
    e.preventDefault();
    form.hidden = true;
    showStatus('PDF wird geöffnet …');
    answer(input.value);
  };
}

// ---------- Änderungen merken ----------
let dirty = false, edited = false;
function setDirty(on) {
  dirty = on;
  $('download').classList.toggle('dirty', on);
  $('download').title = on ? 'Änderungen speichern (Strg S)' : 'Speichern (Strg S)';
}
// Ungespeicherte Änderungen: vor Neu laden oder Wegnavigieren nachfragen
addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

/** Setzt ein (neues) Dokument in den Viewer; Seite und Zoom bleiben, wo es geht. */
let restore = null;
let encrypted = false;
const documentListeners = [];
/** Wo die Ansicht gerade steht: Seite und der Punkt oben links im Fenster in PDF-Koordinaten (bleibt beim Neuladen gültig). */
function viewPosition() {
  const page = viewer.currentPageNumber, view = viewer.getPageView(page - 1);
  const position = { page, scale: viewer.currentScaleValue, x: null, y: null };
  if (view?.div) {
    const r = view.div.getBoundingClientRect(), box = container.getBoundingClientRect();
    [position.x, position.y] = view.viewport.convertToPdfPoint(box.left - r.left, box.top - r.top);
  }
  return position;
}
function useDocument(next) {
  const old = doc;
  if (old && old !== next) restore = viewPosition();
  doc = next;
  viewer.setDocument(doc);
  linkService.setDocument(doc, null);
  $('page-count').textContent = `/ ${doc.numPages}`;
  // edited: seit dem Laden dieses Dokuments etwas geändert (Rückgängig-Knopf, editor.mjs)
  edited = false;
  doc.annotationStorage.onSetModified = () => { setDirty(true); edited = true; dispatchEvent(new Event('glass-edited')); };
  dispatchEvent(new Event('glass-edited'));
  encrypted = false;
  doc.getMetadata().then(({ info }) => { if (next === doc) encrypted = !!info?.EncryptFilterName; }).catch(() => {});
  if (old && old !== next) {
    resetThumbs();
    buildOutline();
    old.loadingTask.destroy();
  }
  for (const fn of documentListeners) fn(doc);
}
// Titel aus den Dokumentdaten, wenn er aussagekräftiger ist als der Dateiname
doc.getMetadata().then(({ info }) => {
  const title = info?.Title?.trim();
  if (title && title.length > 2 && !/^(untitled|microsoft word|dokument\d*)\b/i.test(title)) document.title = title;
}).catch(() => {});

eventBus.on('pagesinit', () => {
  if (restore) {
    // Nach einer Änderung (Formularfeld, Text bearbeiten, Wasserzeichen …) genau dort weiter, wo man war
    const { page, scale, x, y } = restore;
    restore = null;
    viewer.currentScaleValue = scale;
    const pageNumber = Math.min(page, doc.numPages);
    if (x === null || page > doc.numPages) viewer.currentPageNumber = pageNumber;
    else viewer.scrollPageIntoView({ pageNumber, destArray: [null, { name: 'XYZ' }, x, y, null], allowNegativeOffset: true });
  } else {
    viewer.currentScaleValue = '1'; // Originalgröße
    container.focus();
  }
  status.classList.add('done');
  scheduleInk();
});
eventBus.on('scalechanging', scheduleInk);

// ---------- Seiten ----------
const pageInput = $('page');
eventBus.on('pagechanging', ({ pageNumber }) => {
  if (document.activeElement !== pageInput) pageInput.value = pageNumber;
  markThumb(pageNumber);
});
pageInput.addEventListener('focus', () => pageInput.select());
pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const n = parseInt(pageInput.value, 10);
    if (n >= 1 && n <= doc.numPages) viewer.currentPageNumber = n;
    pageInput.blur();
    container.focus();
  } else if (e.key === 'Escape') {
    pageInput.blur();
    container.focus();
  }
});
pageInput.addEventListener('blur', () => { pageInput.value = viewer.currentPageNumber; });
$('prev-page').onclick = () => viewer.previousPage();
$('next-page').onclick = () => viewer.nextPage();

// ---------- Zoom ----------
const zoomValue = $('zoom-value'), fit = $('fit');
eventBus.on('scalechanging', ({ scale, presetValue }) => {
  zoomValue.textContent = `${Math.round(scale * 100)} %`;
  // Der Knopf zeigt, wohin er als Nächstes umschaltet
  const width = presetValue === 'page-width';
  fit.querySelector('use').setAttribute('href', width ? '#i-fit-page' : '#i-fit-width');
  fit.title = width ? 'Ganze Seite zeigen' : 'An Breite anpassen';
});
$('zoom-in').onclick = () => viewer.increaseScale();
$('zoom-out').onclick = () => viewer.decreaseScale();
zoomValue.onclick = () => { viewer.currentScaleValue = '1'; };
fit.onclick = () => { viewer.currentScaleValue = viewer.currentScaleValue === 'page-width' ? 'page-fit' : 'page-width'; };

// Strg + Mausrad und Zwei-Finger-Zoom auf dem Touchpad (kommt ebenfalls als Strg + Rad): um den Mauszeiger herum
let wheelZoom = 0;
container.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  wheelZoom += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  const origin = [e.clientX, e.clientY];
  requestAnimationFrame(() => {
    if (!wheelZoom) return;
    const factor = Math.exp(-wheelZoom / 240);
    wheelZoom = 0;
    viewer.updateScale({ scaleFactor: factor, origin, drawingDelay: 250 });
  });
}, { passive: false });

// ---------- Seitenleiste: Vorschaubilder, Inhaltsverzeichnis, Kommentare ----------
const thumbs = $('thumbs');
const THUMB_WIDTH = 120;
let thumbsBuilt = false;
const drawn = new Set();

function toggleSidebar(open = !document.body.classList.contains('sidebar-open')) {
  document.body.classList.toggle('sidebar-open', open);
  $('toggle-sidebar').classList.toggle('on', open);
  if (open) buildThumbs();
}
$('toggle-sidebar').onclick = () => toggleSidebar();
toggleSidebar(true); // Seitenleiste ist beim Öffnen da

let thumbObserver = null;
function resetThumbs() {
  thumbObserver?.disconnect();
  thumbs.replaceChildren();
  drawn.clear();
  thumbsBuilt = false;
  if (document.body.classList.contains('sidebar-open')) buildThumbs();
}

async function buildThumbs() {
  if (thumbsBuilt) return;
  thumbsBuilt = true;
  const source = doc;
  // Platzhalter im Seitenformat der ersten Seite – beim Zeichnen bekommt jede ihr eigenes
  const first = (await source.getPage(1)).getViewport({ scale: 1 });
  if (source !== doc) return;
  const observer = thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) drawThumb(entry.target);
  }, { root: thumbs, rootMargin: '300px 0px' });
  for (let n = 1; n <= doc.numPages; n++) {
    const item = document.createElement('button');
    item.className = 'thumb';
    item.dataset.page = n;
    item.innerHTML = `<div class="sheet" style="height:${Math.round(THUMB_WIDTH * first.height / first.width)}px"></div><span>${n}</span>`;
    item.onclick = () => { viewer.currentPageNumber = n; };
    thumbs.append(item);
    observer.observe(item);
  }
  markThumb(viewer.currentPageNumber);
}

async function drawThumb(item) {
  const n = +item.dataset.page;
  if (drawn.has(n)) return;
  drawn.add(n);
  const source = doc;
  const page = await source.getPage(n);
  if (source !== doc) return;
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: THUMB_WIDTH * devicePixelRatio / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const sheet = item.firstElementChild;
  sheet.style.height = `${Math.round(THUMB_WIDTH * base.height / base.width)}px`;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise.catch(() => {});
  if (source === doc) sheet.append(canvas);
}

function markThumb(n) {
  thumbs.querySelector('.current')?.classList.remove('current');
  const item = thumbs.querySelector(`[data-page="${n}"]`);
  if (!item) return;
  item.classList.add('current');
  if (document.body.classList.contains('sidebar-open')) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Inhaltsverzeichnis nur, wenn das PDF eines hat
const buildList = (items) => {
  const list = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    const link = Object.assign(document.createElement('button'), { textContent: item.title, title: item.title });
    link.onclick = () => item.dest ? linkService.goToDestination(item.dest) : item.url && window.top.location.assign(item.url);
    li.append(link);
    if (item.items?.length) li.append(buildList(item.items));
    list.append(li);
  }
  return list;
};
let hasOutline = false;
async function buildOutline() {
  const source = doc;
  const outline = await source.getOutline().catch(() => null);
  if (source !== doc) return;
  hasOutline = !!outline?.length;
  $('outline').replaceChildren(...(hasOutline ? [buildList(outline)] : []));
  $('sidebar-tabs').querySelector('[data-view="outline"]').hidden = !hasOutline;
  // Neues Dokument ohne Inhaltsverzeichnis: zurück zu den Seiten
  if (!hasOutline && !$('outline').hidden) showSidebarView('thumbs');
}
buildOutline();

function showSidebarView(view) {
  for (const other of document.querySelectorAll('#sidebar-tabs button')) other.classList.toggle('on', other.dataset.view === view);
  for (const pane of document.querySelectorAll('.sidebar-view')) pane.hidden = pane.id !== view;
  if (view === 'comments') app.notes?.refreshList();
}
for (const tab of document.querySelectorAll('#sidebar-tabs button')) tab.onclick = () => showSidebarView(tab.dataset.view);

// ---------- Suche ----------
const find = $('find'), findInput = $('find-input'), findCount = $('find-count');
function search(type, findPrevious = false) {
  eventBus.dispatch('find', {
    source: null, type, query: findInput.value, findPrevious,
    caseSensitive: false, entireWord: false, highlightAll: true, matchDiacritics: false,
  });
}
function openFind() {
  find.hidden = false;
  placeWells();
  $('search').classList.add('on');
  findInput.select();
  findInput.focus();
  scheduleInk();
  if (findInput.value) search('again');
}
function closeFind() {
  find.hidden = true;
  $('search').classList.remove('on');
  eventBus.dispatch('findbarclose', { source: null });
  container.focus();
}
$('search').onclick = () => (find.hidden ? openFind() : closeFind());
$('find-close').onclick = closeFind;
$('find-next').onclick = () => search('again');
$('find-prev').onclick = () => search('again', true);
findInput.addEventListener('input', () => search(''));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); search('again', e.shiftKey); }
  if (e.key === 'Escape') closeFind();
});
const showCount = ({ current, total }) => {
  findCount.textContent = !findInput.value ? '' : total ? `${current} von ${total}` : 'Keine Treffer';
};
eventBus.on('updatefindmatchescount', ({ matchesCount }) => showCount(matchesCount));
eventBus.on('updatefindcontrolstate', ({ state, matchesCount }) => {
  find.classList.toggle('missing', state === FindState.NOT_FOUND && !!findInput.value);
  if (state !== FindState.PENDING) showCount(matchesCount);
});

// ---------- Dunkle Seiten ----------
$('theme').onclick = () => {
  const dark = document.body.classList.toggle('dark');
  $('theme').querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('theme').title = dark ? 'Helle Seiten' : 'Dunkle Seiten';
  $('theme').classList.toggle('on', dark);
  scheduleInk();
};

// ---------- Kurze Rückmeldung (optional mit Knopf, etwa „Rückgängig“) ----------
let toastTimer = 0;
function toast(text, action = null) {
  const box = $('toast');
  box.replaceChildren(document.createTextNode(text));
  if (action) {
    const button = Object.assign(document.createElement('button'), { textContent: action.label });
    button.onclick = () => { hide(); action.run(); };
    box.append(button);
  }
  box.hidden = false;
  box.classList.remove('out');
  clearTimeout(toastTimer);
  const hide = () => {
    box.classList.add('out');
    toastTimer = setTimeout(() => { box.hidden = true; }, 300);
  };
  toastTimer = setTimeout(hide, action ? 5000 : 2200);
  scheduleInk();
}

// ---------- Bytes: Arbeitsfassung, gespeicherte Fassung ----------
let pdfLib = null;
const loadPdfLib = async () => (pdfLib ||= await import(BASE + 'pdf-lib/pdf-lib.esm.min.js'));
// Ohne Änderungen sind das einfach die Originalbytes (saveDocument warnt dann)
const currentBytes = () => (doc.annotationStorage.size ? doc.saveDocument() : doc.getData());
/** Erweiterungen, die beim Speichern in die Bytes schreiben (Notizen) – sie melden mit `active()`, ob nötig. */
const exportHooks = [];
/**
 * Arbeitsfassung: alle Änderungen, unverschlüsselt (pdf-lib kann verschlüsselte PDFs nicht lesen). Grundlage für
 * Seitenänderungen und das Speichern.
 */
async function workingBytes() {
  let bytes = encrypted ? await decryptBytes(await currentBytes()) : await currentBytes();
  for (const hook of exportHooks) if (hook.active()) bytes = await hook.apply(bytes);
  return bytes;
}
/** Passwort und PDF an pdf.rs: `encrypt` schützt, `decrypt` hebt den Schutz auf. */
async function withPassword(call, bytes, password) {
  const pw = new TextEncoder().encode(password);
  const body = new Uint8Array(4 + pw.length + bytes.length);
  new DataView(body.buffer).setUint32(0, pw.length, true);
  body.set(pw, 4);
  body.set(bytes, 4 + pw.length);
  const res = await fetch(API + call, { method: 'POST', body });
  if (!res.ok) throw new Error(call === 'encrypt' ? 'Verschlüsseln fehlgeschlagen' : 'Entschlüsseln fehlgeschlagen');
  return new Uint8Array(await res.arrayBuffer());
}
const encryptBytes = (bytes, password) => withPassword('encrypt', bytes, password);
/**
 * Geschütztes PDF ohne Schutz, mit dem Passwort vom Öffnen (pdf-lib und neue PDF.js-Dokumente brauchen das;
 * extractPages von PDF.js behielte die Verschlüsselung). Beim Speichern schützt `protection` es wieder.
 */
const decryptBytes = (bytes) => withPassword('decrypt', bytes, openedWith ?? '');
/** Die Fassung, die gespeichert wird: Arbeitsfassung, bei Bedarf mit Passwort. */
async function exportBytes() {
  const hooks = exportHooks.some((h) => h.active());
  // Schon so geschützt wie gewünscht und nichts umzuschreiben: PDF.js speichert inkrementell (bleibt verschlüsselt)
  if (encrypted && protection?.original && !hooks) return currentBytes();
  const bytes = await workingBytes();
  return protection ? encryptBytes(bytes, protection.password) : bytes;
}

// ---------- Verlauf der Dokument-Änderungen (Seiten, Wasserzeichen, Schwärzen …) ----------
const UNDO_STEPS = 12;
const history = [];
// Zurückgenommene Fassungen für „Wiederholen“ – eine neue Änderung verwirft sie
const future = [];
let changing = false;
/**
 * Baut ein neues PDF und setzt es ein: `make(bytes, lib)` bekommt die Arbeitsfassung und pdf-lib und liefert die
 * neuen Bytes (oder null = nichts zu tun). Rückgängig über `undoChange` oder den Knopf in der Rückmeldung.
 */
async function applyChange(label, make, { toastUndo = true } = {}) {
  if (changing) return false;
  changing = true;
  document.body.classList.add('busy');
  try {
    const before = await workingBytes();
    const bytes = await make(before.slice(), await loadPdfLib());
    if (!bytes) return false;
    await replaceDocument(bytes);
    history.push(before);
    if (history.length > UNDO_STEPS) history.shift();
    future.length = 0;
    setDirty(true);
    dispatchEvent(new CustomEvent('glass-history', { detail: 'new' }));
    // Die Meldung darf vom Ergebnis abhängen (etwa die neue Dateigröße)
    if (label) toast(typeof label === 'function' ? label() : label, toastUndo ? { label: 'Rückgängig', run: undoChange } : null);
    return true;
  } catch (err) {
    console.error(err);
    toast('Das hat nicht geklappt – das PDF ist unverändert.');
    return false;
  } finally {
    changing = false;
    document.body.classList.remove('busy');
  }
}
/** Eine Fassung aus `from` einsetzen, die jetzige kommt nach `to` (Rückgängig ↔ Wiederholen). */
async function travel(from, to, label, again, kind) {
  if (changing || !from.length) return false;
  changing = true;
  document.body.classList.add('busy');
  try {
    const now = await workingBytes();
    await replaceDocument(from.pop());
    to.push(now);
    if (to.length > UNDO_STEPS) to.shift();
    setDirty(true);
    dispatchEvent(new CustomEvent('glass-history', { detail: kind }));
    toast(label, again);
    return true;
  } catch (err) {
    console.error(err);
    toast('Das hat nicht geklappt – das PDF ist unverändert.');
    return false;
  } finally {
    changing = false;
    document.body.classList.remove('busy');
  }
}
const undoChange = () => travel(history, future, 'Rückgängig gemacht', { label: 'Wiederholen', run: () => redoChange() }, 'undo');
const redoChange = () => {
  // Inzwischen etwas Neues gemacht (Anmerkung, Notiz …): Wiederholen würde das überschreiben – wie in jedem Editor verfällt es
  if (edited && future.length) {
    future.length = 0;
    dispatchEvent(new CustomEvent('glass-history', { detail: 'new' }));
    return Promise.resolve(false);
  }
  return travel(future, history, 'Wiederholt', { label: 'Rückgängig', run: () => undoChange() }, 'redo');
};

/** Erweiterungen, die beim Öffnen Bytes übernehmen (Notizen): `async (doc) => strippedBytes | null`. */
const importHooks = [];
/** Neues PDF (Bytes) statt des offenen; Erweiterungen dürfen vorher übernehmen, was sie selbst zeigen. */
async function replaceDocument(bytes) {
  let next = await openDocument(bytes.slice());
  for (const hook of importHooks) {
    const stripped = await hook(next);
    if (stripped) {
      next.loadingTask.destroy();
      next = await openDocument(stripped);
    }
  }
  const shown = new Promise((done) => eventBus.on('pagesinit', done, { once: true }));
  useDocument(next);
  await shown;
}

// ---------- Speichern, Speichern unter, Öffnen ----------
let fileKey = document.body.dataset.file || ''; // Datei auf der Festplatte, in die Strg+S schreibt
let savedResolve = null;
window.__glassSaved = (result) => savedResolve?.(result);
function download(bytes, fileName) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  Object.assign(document.createElement('a'), { href: url, download: fileName }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
/** Bytes in eine Datei: `as` = Dialog „Speichern unter“ (Vorschlag `fileName`). Fällt notfalls auf einen Download zurück. */
async function writeFile(bytes, fileName, as) {
  try {
    if (!as && fileKey) {
      const res = await fetch(API + 'save?file=' + encodeURIComponent(fileKey), { method: 'POST', body: bytes });
      if (res.ok) return { ok: true };
      throw new Error('save ' + res.status);
    }
    const result = new Promise((done) => { savedResolve = done; });
    const res = await fetch(API + 'save-as?name=' + encodeURIComponent(fileName), { method: 'POST', body: bytes });
    if (res.status !== 202) throw new Error('save-as ' + res.status);
    return await result;
  } catch (err) {
    console.warn(err);
    download(bytes, fileName);
    return { ok: true, downloaded: true };
  } finally {
    savedResolve = null;
  }
}
let saving = false;
async function save(as = false) {
  if (saving) return;
  saving = true;
  try {
    const bytes = await exportBytes();
    const result = await writeFile(bytes, name, as || !fileKey);
    if (!result.ok) {
      if (!result.cancelled) toast('Speichern hat nicht geklappt' + (result.error ? `: ${result.error}` : '.'));
      return;
    }
    if (result.file) fileKey = result.file;
    setDirty(false);
    toast(result.downloaded ? 'Als Download gespeichert' : result.name ? `Gespeichert unter „${result.name}“` : 'Gespeichert');
  } catch (err) {
    console.error(err);
    toast('Speichern hat nicht geklappt.');
  } finally {
    saving = false;
  }
}
$('download').onclick = () => save();
const openFile = () => window.ipc?.postMessage(JSON.stringify({ pdf: 'open' }));
/** Ein neu gebautes PDF (etwa aus Bildern) in einem neuen Tab zeigen – ohne Glass als Download. */
async function openNew(bytes, fileName) {
  try {
    const res = await fetch(API + 'open-new?name=' + encodeURIComponent(fileName), { method: 'POST', body: bytes });
    if (!res.ok) throw new Error('open-new ' + res.status);
    toast(`„${fileName}“ ist in einem neuen Tab geöffnet`);
  } catch (err) {
    console.warn(err);
    download(bytes, fileName);
  }
}

// ---------- Inhalt der Seiten (Text bearbeiten, Bilder bearbeiten): einmal pro Dokument gelesen ----------
let contentCache = null;
/** Operatoren, Glyphen und Bilder der Seite `n` (1-basiert) im angezeigten Dokument (content.mjs `readPage`). */
function pageContent(n) {
  const source = doc;
  if (contentCache?.doc !== source) {
    const pdf = (async () => {
      const lib = await loadPdfLib();
      // pdf-lib kann verschlüsselte PDFs nicht lesen – dann die entschlüsselte Fassung
      const bytes = encrypted ? await decryptBytes(await source.getData()) : await source.getData();
      return lib.PDFDocument.load(bytes, { updateMetadata: false });
    })();
    contentCache = { doc: source, pdf, pages: new Map() };
  }
  const cache = contentCache;
  if (!cache.pages.has(n)) cache.pages.set(n, cache.pdf.then(async (pdf) => readPage(await loadPdfLib(), pdf, n - 1)));
  return cache.pages.get(n);
}

// ---------- Installierte Schriften (pdf.rs liest sie aus der Registry) ----------
let fontList = null, fontkitModule = null;
const fonts = () => (fontList ||= fetch(API + 'fonts').then((r) => (r.ok ? r.json() : [])).catch(() => []));
const fontFiles = new Map();
const fontFile = (file) => {
  if (!fontFiles.has(file)) {
    fontFiles.set(file, fetch(API + 'font/' + encodeURIComponent(file)).then(async (r) => {
      if (!r.ok) throw new Error('font ' + r.status);
      return new Uint8Array(await r.arrayBuffer());
    }));
    fontFiles.get(file).catch(() => fontFiles.delete(file));
  }
  return fontFiles.get(file);
};
const loadFontkit = async () => (fontkitModule ||= (await import(BASE + 'fontkit/fontkit.mjs')).default);

// ---------- Mehr: Öffnen, Speichern unter, Seiten gestalten, Schützen ----------
const more = $('more-menu');
function toggleMore(open = more.hidden) {
  more.hidden = !open;
  $('more').classList.toggle('on', open);
  if (!open) return;
  // Über dem Knopf, rechtsbündig mit ihm
  const r = $('more').getBoundingClientRect();
  more.style.right = `${Math.max(8, innerWidth - r.right - 8)}px`;
  more.style.bottom = `${innerHeight - r.top + 14}px`;
  placeWells();
  scheduleInk();
}
$('more').onclick = (e) => { e.stopPropagation(); toggleMore(); };
document.addEventListener('pointerdown', (e) => { if (!more.hidden && !e.target.closest('#more-menu, #more')) toggleMore(false); });
for (const item of more.querySelectorAll('[data-action]')) {
  item.onclick = () => {
    toggleMore(false);
    ({
      open: openFile,
      'save-as': () => save(true),
      design: () => app.design.open(),
      images: () => app.images.open(),
      compress: () => app.compress.open(),
      protect: () => openProtect(),
      print: () => print(),
    })[item.dataset.action]?.();
  };
}

// Mit Passwort schützen (wirkt beim Speichern, wie in Acrobat)
const protectDialog = $('protect-dialog');
function openProtect() {
  $('protect-state').textContent = protection
    ? 'Das PDF ist mit einem Passwort geschützt. Ein neues Passwort ersetzt es.'
    : 'Wer das PDF öffnen will, braucht dann dieses Passwort.';
  $('protect-remove').hidden = !protection;
  $('protect-password').value = $('protect-repeat').value = '';
  $('protect-error').textContent = '';
  protectDialog.hidden = false;
  $('protect-password').focus();
}
const closeProtect = () => { protectDialog.hidden = true; container.focus(); };
$('protect-cancel').onclick = closeProtect;
$('protect-remove').onclick = () => {
  protection = null;
  setDirty(true);
  closeProtect();
  toast('Passwortschutz wird beim Speichern entfernt');
};
$('protect-form').onsubmit = (e) => {
  e.preventDefault();
  const pw = $('protect-password').value, again = $('protect-repeat').value;
  if (pw.length < 4) { $('protect-error').textContent = 'Mindestens 4 Zeichen.'; return; }
  if (pw !== again) { $('protect-error').textContent = 'Die Passwörter stimmen nicht überein.'; return; }
  protection = { password: pw, original: false };
  setDirty(true);
  closeProtect();
  toast('Wird beim Speichern mit Passwort geschützt (AES-256)');
};
protectDialog.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') closeProtect(); });
protectDialog.addEventListener('pointerdown', (e) => { if (e.target === protectDialog) closeProtect(); });

// ---------- Eigene Ebene auf jeder Seite (Notizen, Schwärzen, Formularfelder, Text bearbeiten) ----------
const layerRenderers = [];
/** Ebene über der Seite `n` (1-basiert); PDF.js baut Seiten beim Zoomen neu – dann wird sie neu angelegt. */
function glassLayer(n) {
  const view = viewer.getPageView(n - 1);
  if (!view?.div) return null;
  let layer = view.div.querySelector(':scope > .glass-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'glass-layer';
    layer.dataset.page = n;
    view.div.append(layer);
  }
  return layer;
}
/** Umrechnung PDF-Punkte ↔ Prozent der Seite (bleibt beim Zoomen gültig). */
function pageGeometry(n) {
  const view = viewer.getPageView(n - 1);
  const vp = view.viewport;
  return {
    view, viewport: vp,
    toPercent: (x, y) => { const [vx, vy] = vp.convertToViewportPoint(x, y); return [vx / vp.width * 100, vy / vp.height * 100]; },
    toPdf: (px, py) => vp.convertToPdfPoint(px / 100 * vp.width, py / 100 * vp.height),
    /** Position eines Zeigerereignisses (clientX/Y) in PDF-Punkten */
    eventToPdf: (e) => { const r = view.div.getBoundingClientRect(); return vp.convertToPdfPoint((e.clientX - r.left) / r.width * vp.width, (e.clientY - r.top) / r.height * vp.height); },
    /** PDF-Rechteck [x1,y1,x2,y2] → CSS in Prozent */
    rectStyle: (rect) => {
      const [a, b] = vp.convertToViewportPoint(rect[0], rect[1]), [c, d] = vp.convertToViewportPoint(rect[2], rect[3]);
      const left = Math.min(a, c), top = Math.min(b, d);
      return { left: `${left / vp.width * 100}%`, top: `${top / vp.height * 100}%`, width: `${Math.abs(c - a) / vp.width * 100}%`, height: `${Math.abs(d - b) / vp.height * 100}%` };
    },
  };
}
const refreshLayers = (n) => {
  const pages = n ? [n] : Array.from({ length: doc.numPages }, (_, i) => i + 1);
  for (const page of pages) {
    const layer = glassLayer(page);
    if (layer) for (const render of layerRenderers) render(page, layer);
  }
};
eventBus.on('pagerendered', ({ pageNumber }) => refreshLayers(pageNumber));

// ---------- Erweiterungen ----------
const app = {
  BASE, API, pdfjsLib, viewer, eventBus, container, name, signatures,
  get doc() { return doc; },
  get edited() { return edited; },
  /** Eigene Änderungen außerhalb von PDF.js (Notizen) zählen wie Anmerkungen */
  markEdited() { edited = true; },
  get dirty() { return dirty; },
  get canUndoChange() { return history.length > 0; },
  get canRedoChange() { return future.length > 0; },
  get protection() { return protection; },
  get fileKey() { return fileKey; },
  placeWells, scheduleInk, toast, setDirty, currentBytes, workingBytes, exportBytes, save, writeFile, download, openNew, encryptBytes,
  pageContent, fonts, fontFile, loadFontkit,
  loadPdfLib, applyChange, undoChange, redoChange, replaceDocument, glassLayer, pageGeometry, refreshLayers, showSidebarView,
  exportHooks, importHooks, layerRenderers,
  onDocument: (fn) => documentListeners.push(fn),
  /** Bytes kurz als eigenes PDF.js-Dokument öffnen (etwa für extractPages auf der Arbeitsfassung). */
  async withDocument(bytes, fn) {
    const task = pdfjsLib.getDocument({ data: bytes.slice(), worker: pdfWorker, cMapUrl: BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'standard_fonts/', wasmUrl: BASE + 'wasm/', iccUrl: BASE + 'iccs/' });
    try { return await fn(await task.promise); } finally { task.destroy(); }
  },
  async isEncrypted() { return encrypted; },
};
// Für Tests (tests/pdf-editor.mjs) und DevTools; im Viewer-Dokument läuft kein Skript der Website
globalThis.glassPdf = app;
app.tools = initTools(app);
app.organize = initOrganize(app);
app.notes = initNotes(app);
app.redact = initRedact(app);
app.textEdit = initTextEdit(app);
app.imageEdit = initImageEdit(app);
// Ein Werkzeug für beides: Text anklicken bearbeitet die Zeile, ein Bild anklicken wählt das Bild
app.contentEdit = {
  enter() { app.textEdit.enter(); app.imageEdit.enter(); },
  leave() { app.imageEdit.leave(); app.textEdit.leave(); },
};
app.fields = initFields(app);
app.design = initDesign(app);
app.images = initImages(app);
app.compress = initCompress(app);

// Erstes Dokument: Notizen übernehmen, dann anzeigen (so wie nach jeder Änderung)
{
  let first = doc;
  for (const hook of importHooks) {
    const stripped = await hook(first);
    if (stripped) {
      first.loadingTask.destroy();
      first = await openDocument(stripped);
    }
  }
  const original = doc;
  doc = null;
  useDocument(first);
  if (first !== original) {
    // Vorschaubilder und Inhaltsverzeichnis stammen noch vom übernommenen Original
    resetThumbs();
    buildOutline();
  }
  // Mit Passwort geöffnet: gespeichert wird wieder geschützt
  if (openedWith !== null) protection = { password: openedWith, original: true };
}

// Drucken: jede Seite einmal als Bild mit 150 dpi (mit allen Anmerkungen), dann der Druckdialog von Chromium
let printing = false;
async function print() {
  if (printing) return;
  printing = true;
  const box = $('print-pages');
  const button = $('print');
  button.disabled = true;
  try {
    box.replaceChildren();
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 150 / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({
        canvasContext: canvas.getContext('2d'), viewport, intent: 'print',
        annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE,
      }).promise;
      const blob = await new Promise((done) => canvas.toBlob(done));
      const img = new Image();
      img.src = URL.createObjectURL(blob);
      await img.decode();
      box.append(img);
    }
    window.print();
  } finally {
    for (const img of box.querySelectorAll('img')) URL.revokeObjectURL(img.src);
    box.replaceChildren();
    button.disabled = false;
    printing = false;
  }
}
$('print').onclick = print;

// ---------- Tastatur ----------
window.addEventListener('keydown', (e) => {
  // Auch Textfelder der Werkzeuge (contenteditable) und Dialoge
  const typing = !!e.target.closest?.('input, textarea, select, [contenteditable=true], .dialog');
  if (e.ctrlKey && !e.altKey && !document.querySelector('.dialog:not([hidden])')) {
    const key = e.key.toLowerCase();
    const action =
      key === 'f' ? openFind :
      key === 'p' ? print :
      key === 's' ? () => save(e.shiftKey) :
      key === 'o' ? openFile :
      key === '+' || key === '=' ? () => viewer.increaseScale() :
      key === '-' ? () => viewer.decreaseScale() :
      key === '0' ? () => { viewer.currentScaleValue = '1'; } :
      key === 'g' ? () => search('again', e.shiftKey) : null;
    if (action) { e.preventDefault(); action(); }
    return;
  }
  if (e.key === 'F3') { e.preventDefault(); find.hidden ? openFind() : search('again', e.shiftKey); return; }
  if (typing || e.altKey || e.metaKey) return;
  if (e.key === 'Escape' && !find.hidden) closeFind();
  // Links/Rechts blättern, solange die Seite nicht seitlich scrollen kann – und keine Anmerkung gewählt ist
  // (die verschiebt PDF.js mit den Pfeilen)
  if (document.querySelector('.selectedEditor, .glass-layer .selected')) return;
  const wide = container.scrollWidth > container.clientWidth;
  if (!wide && e.key === 'ArrowRight') { e.preventDefault(); viewer.nextPage(); }
  if (!wide && e.key === 'ArrowLeft') { e.preventDefault(); viewer.previousPage(); }
});

// Formular wie in Acrobat ankündigen: Felder lassen sich direkt ausfüllen, Speichern behält die Werte
doc.getFieldObjects().then((fields) => {
  if (fields && Object.keys(fields).length) toast('Formular – Felder direkt ausfüllen, dann speichern (Strg S)');
}).catch(() => {});
