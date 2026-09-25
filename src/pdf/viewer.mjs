// Glass-PDF-Viewer: PDF.js rendert, Oberfläche und Bedienung sind eigen.
// Läuft mit isoliertem Sandbox-Origin (pdf.rs); Skripte und Daten kommen von glass-pdf.localhost aus der Exe.
const BASE = 'http://glass-pdf.localhost/';
const $ = (id) => document.getElementById(id);
const name = document.body.dataset.name;

const pdfjsLib = await import(BASE + 'pdf.min.mjs');
globalThis.pdfjsLib = pdfjsLib; // pdf_viewer.mjs erwartet die Bibliothek global
const { EventBus, PDFLinkService, PDFFindController, PDFViewer, LinkTarget, FindState } = await import(BASE + 'pdf_viewer.mjs');
// A data-URL module worker supports the viewer's opaque sandbox origin. PDF.js's URL-based
// origin check uses location.href, which still displays the original PDF URL.
const workerUrl = 'data:text/javascript,' + encodeURIComponent(`import "${BASE}pdf.worker.min.mjs";`);
pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: 'module' });

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
const viewer = new PDFViewer({
  container, viewer: $('viewer'), eventBus, linkService, findController,
  annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
});
linkService.setViewer(viewer);

// ---------- Laden ----------
const status = $('status');
function showStatus(text, kind = '') {
  $('status-text').textContent = text;
  status.className = 'glass ' + kind;
}

let doc;
try {
  const res = await fetch(document.body.dataset.doc);
  // Die Bytes gibt es nur einmal – etwa nach „Seite wiederherstellen“ fehlen sie: dann einfach neu laden lassen.
  if (!res.ok) throw new Error('gone');
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(await res.arrayBuffer()),
    cMapUrl: BASE + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    wasmUrl: BASE + 'wasm/', iccUrl: BASE + 'iccs/',
  });
  task.onPassword = (answer, reason) => askPassword(answer, reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
  doc = await task.promise;
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

viewer.setDocument(doc);
linkService.setDocument(doc, null);
$('page-count').textContent = `/ ${doc.numPages}`;
// Titel aus den Dokumentdaten, wenn er aussagekräftiger ist als der Dateiname
doc.getMetadata().then(({ info }) => {
  const title = info?.Title?.trim();
  if (title && title.length > 2 && !/^(untitled|microsoft word|dokument\d*)\b/i.test(title)) document.title = title;
}).catch(() => {});

eventBus.on('pagesinit', () => {
  viewer.currentScaleValue = '1'; // Originalgröße
  status.classList.add('done');
  container.focus();
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

// ---------- Seitenleiste: Vorschaubilder und Inhaltsverzeichnis ----------
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

async function buildThumbs() {
  if (thumbsBuilt) return;
  thumbsBuilt = true;
  // Platzhalter im Seitenformat der ersten Seite – beim Zeichnen bekommt jede ihr eigenes
  const first = (await doc.getPage(1)).getViewport({ scale: 1 });
  const observer = new IntersectionObserver((entries) => {
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
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: THUMB_WIDTH * devicePixelRatio / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const sheet = item.firstElementChild;
  sheet.style.height = `${Math.round(THUMB_WIDTH * base.height / base.width)}px`;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  sheet.append(canvas);
}

function markThumb(n) {
  thumbs.querySelector('.current')?.classList.remove('current');
  const item = thumbs.querySelector(`[data-page="${n}"]`);
  if (!item) return;
  item.classList.add('current');
  if (document.body.classList.contains('sidebar-open')) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Inhaltsverzeichnis nur, wenn das PDF eines hat
doc.getOutline().then((outline) => {
  if (!outline?.length) return;
  const build = (items) => {
    const list = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      const link = Object.assign(document.createElement('button'), { textContent: item.title, title: item.title });
      link.onclick = () => item.dest ? linkService.goToDestination(item.dest) : item.url && window.top.location.assign(item.url);
      li.append(link);
      if (item.items?.length) li.append(build(item.items));
      list.append(li);
    }
    return list;
  };
  $('outline').append(build(outline));
  $('sidebar-tabs').hidden = false;
}).catch(() => {});

for (const tab of document.querySelectorAll('#sidebar-tabs button')) {
  tab.onclick = () => {
    for (const other of document.querySelectorAll('#sidebar-tabs button')) other.classList.toggle('on', other === tab);
    $('thumbs').hidden = tab.dataset.view !== 'thumbs';
    $('outline').hidden = tab.dataset.view !== 'outline';
  };
}

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

// ---------- Dunkle Seiten, Drucken, Herunterladen ----------
$('theme').onclick = () => {
  const dark = document.body.classList.toggle('dark');
  $('theme').querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('theme').title = dark ? 'Helle Seiten' : 'Dunkle Seiten';
  $('theme').classList.toggle('on', dark);
  scheduleInk();
};

async function download() {
  const url = URL.createObjectURL(new Blob([await doc.saveDocument()], { type: 'application/pdf' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
$('download').onclick = download;

// Drucken: jede Seite einmal als Bild mit 150 dpi, dann der Druckdialog von Chromium
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
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, intent: 'print' }).promise;
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
  const typing = e.target instanceof HTMLInputElement;
  if (e.ctrlKey && !e.altKey) {
    const key = e.key.toLowerCase();
    const action =
      key === 'f' ? openFind :
      key === 'p' ? print :
      key === 's' ? download :
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
  // Links/Rechts blättern, solange die Seite nicht seitlich scrollen kann
  const wide = container.scrollWidth > container.clientWidth;
  if (!wide && e.key === 'ArrowRight') { e.preventDefault(); viewer.nextPage(); }
  if (!wide && e.key === 'ArrowLeft') { e.preventDefault(); viewer.previousPage(); }
});
