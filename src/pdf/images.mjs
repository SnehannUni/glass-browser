// Bilder als PDF-Seiten: „PDF aus Bildern“ (neues PDF in einem neuen Tab oder an dieses anhängen) und Bilder beim
// Organisieren einfügen. JPEG und PNG gehen unverändert ins PDF; andere Formate (WebP, GIF, BMP …) und gedrehte
// Handyfotos (EXIF) werden über ein Canvas neu kodiert.
import { t } from './en.mjs';

const $ = (id) => document.getElementById(id);

export const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
/** „Wie das Bild“: die längere Seite so lang wie bei A4. */
const LONG_SIDE = 841.89;

const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8;
const isPng = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** Drehung eines JPEG laut EXIF (1 = keine, wie gespeichert). */
export function jpegOrientation(b) {
  if (!isJpeg(b)) return 1;
  let i = 2;
  while (i + 10 < b.length && b[i] === 0xff) {
    const marker = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xda) break; // Bilddaten beginnen
    // APP1 „Exif\0\0“, danach ein TIFF-Kopf
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const t = i + 10, le = b[t] === 0x49;
      const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
      const ifd = t + u32(t + 4);
      if (ifd + 2 > b.length) return 1;
      for (let k = 0, n = u16(ifd); k < n; k++) {
        const entry = ifd + 2 + k * 12;
        if (entry + 10 > b.length) break;
        if (u16(entry) === 0x0112) return u16(entry + 8) || 1;
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

/** Hat das Bild durchsichtige Stellen? (an einer verkleinerten Kopie geprüft) */
function hasAlpha(bitmap) {
  const s = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s)), h = Math.max(1, Math.round(bitmap.height * s));
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

/** Bilddatei (File/Blob) → `{ kind: 'jpg'|'png', bytes, width, height }` zum Einbetten mit pdf-lib. */
export async function prepareImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bitmap;
  try {
    // Dreht laut EXIF – Breite und Höhe sind so, wie man das Foto sieht
    bitmap = await createImageBitmap(new Blob([bytes], { type: file.type || '' }));
  } catch {
    throw Object.assign(new Error('Kein Bild'), { userMessage: t('„{name}“ ist kein Bild, das sich öffnen lässt.', { name: file.name || t('Datei') }) });
  }
  const { width, height } = bitmap;
  try {
    if (isPng(bytes)) return { kind: 'png', bytes, width, height };
    if (isJpeg(bytes) && jpegOrientation(bytes) === 1) return { kind: 'jpg', bytes, width, height };
    // Neu kodieren: Transparenz bleibt als PNG, sonst JPEG
    const alpha = hasAlpha(bitmap);
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob(alpha ? { type: 'image/png' } : { type: 'image/jpeg', quality: .92 });
    return { kind: alpha ? 'png' : 'jpg', bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
  } finally {
    bitmap.close();
  }
}

/**
 * Seite für ein Bild: `size` 'a4' | 'letter' | 'fit' (wie das Bild) | [Breite, Höhe] in Punkten; Hoch- oder Querformat
 * folgt dem Bild. `margin`: Rand in Punkten. Liefert Seitenmaße und das Rechteck, in das das Bild mittig passt.
 */
export function pageFor(image, size = 'a4', margin = 0) {
  const ratio = image.width / image.height;
  let w, h;
  if (size === 'fit') {
    [w, h] = ratio >= 1 ? [LONG_SIDE, LONG_SIDE / ratio] : [LONG_SIDE * ratio, LONG_SIDE];
    w += 2 * margin;
    h += 2 * margin;
  } else {
    [w, h] = Array.isArray(size) ? size : PAGE_SIZES[size] || PAGE_SIZES.a4;
    if ((ratio > 1) !== (w > h) && Math.abs(ratio - 1) > .02) [w, h] = [h, w];
  }
  const s = Math.min((w - 2 * margin) / image.width, (h - 2 * margin) / image.height);
  const iw = image.width * s, ih = image.height * s;
  return { page: [w, h], rect: { x: (w - iw) / 2, y: (h - ih) / 2, width: iw, height: ih } };
}

/** Bilder (aus `prepareImage`) als Seiten in `pdf` (pdf-lib) einfügen, ab Seite `at` (0-basiert; Standard: ans Ende). */
export async function addImagePages(pdf, images, { size = 'a4', margin = 0, at = pdf.getPageCount() } = {}) {
  for (const [k, image] of images.entries()) {
    const embedded = image.kind === 'png' ? await pdf.embedPng(image.bytes) : await pdf.embedJpg(image.bytes);
    const { page: dims, rect } = pageFor(image, size, margin);
    pdf.insertPage(at + k, dims).drawImage(embedded, rect);
  }
}

/** Ein neues PDF aus den Bildern. */
export async function pdfFromImages(lib, images, options) {
  const pdf = await lib.PDFDocument.create();
  pdf.setCreator('Winter Browser');
  pdf.setProducer('Winter Browser');
  await addImagePages(pdf, images, options);
  return pdf.save();
}

export const isImageFile = (file) => file.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|avif|ico)$/i.test(file.name);

// ---------- Dialog „PDF aus Bildern“ ----------
export function initImages(app) {
  const dialog = $('images-dialog'), list = $('images-list'), fileInput = $('images-file');
  let items = []; // { file, url, image: Promise }
  let dragging = null;

  function add(files) {
    for (const file of files.filter(isImageFile)) {
      const image = prepareImage(file);
      image.catch(() => {}); // Meldung erst beim Erstellen
      items.push({ file, url: URL.createObjectURL(file), image });
    }
    render();
  }
  function clear() {
    for (const item of items) URL.revokeObjectURL(item.url);
    items = [];
  }

  function render() {
    const tiles = items.map((item, i) => {
      const tile = document.createElement('div');
      tile.className = 'image-tile';
      tile.draggable = true;
      tile.dataset.index = i;
      tile.title = item.file.name;
      const img = Object.assign(document.createElement('img'), { src: item.url, alt: item.file.name, draggable: false });
      const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'remove', title: t('Entfernen') });
      remove.innerHTML = '<svg><use href="#i-close"/></svg>';
      remove.onclick = () => { URL.revokeObjectURL(item.url); items.splice(i, 1); render(); };
      const number = Object.assign(document.createElement('span'), { textContent: i + 1 });
      tile.append(img, remove, number);
      return tile;
    });
    const more = Object.assign(document.createElement('button'), { type: 'button', className: 'image-tile add', title: t('Weitere Bilder …') });
    more.innerHTML = '<svg><use href="#i-plus"/></svg>';
    more.onclick = pick;
    list.replaceChildren(...tiles, more);
    const none = !items.length;
    $('images-create').disabled = $('images-append').disabled = none;
    $('images-title').textContent = none ? t('PDF aus Bildern') : items.length === 1 ? t('PDF aus einem Bild') : t('PDF aus {n} Bildern', { n: items.length });
  }

  // Reihenfolge ziehen; Dateien von außen kommen dazu
  list.addEventListener('dragstart', (e) => {
    const tile = e.target.closest('.image-tile[data-index]');
    if (!tile) return;
    dragging = +tile.dataset.index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragging));
    requestAnimationFrame(() => tile.classList.add('dragging'));
  });
  list.addEventListener('dragend', () => { dragging = null; render(); });
  /** Vor welches Bild abgelegt wird (0 … Anzahl). */
  const target = (e) => {
    const tiles = [...list.querySelectorAll('.image-tile[data-index]')];
    let best = tiles.length, dist = Infinity;
    for (const tile of tiles) {
      const r = tile.getBoundingClientRect();
      const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
      if (d < dist) { dist = d; best = +tile.dataset.index + (e.clientX > r.left + r.width / 2 ? 1 : 0); }
    }
    return best;
  };
  dialog.addEventListener('dragover', (e) => {
    if (dragging === null && ![...e.dataTransfer.items].some((i) => i.kind === 'file')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragging === null ? 'copy' : 'move';
    for (const tile of list.querySelectorAll('.image-tile')) tile.classList.remove('before', 'after');
    if (dragging !== null) {
      const at = target(e), tiles = list.querySelectorAll('.image-tile[data-index]');
      if (tiles[at]) tiles[at].classList.add('before'); else tiles[tiles.length - 1]?.classList.add('after');
    }
  });
  dialog.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragging !== null) {
      const from = dragging, at = target(e);
      dragging = null;
      const [item] = items.splice(from, 1);
      items.splice(at > from ? at - 1 : at, 0, item);
      render();
    } else {
      add([...e.dataTransfer.files]);
    }
  });

  function pick() { fileInput.value = ''; fileInput.click(); }
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    if (!files.length) return;
    add(files);
    if (dialog.hidden) show();
  });

  function show() {
    dialog.hidden = false;
    render();
    dialog.querySelector('form').focus();
  }
  function close() {
    dialog.hidden = true;
    clear();
    app.container.focus();
  }
  $('images-cancel').onclick = close;
  dialog.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
  dialog.addEventListener('pointerdown', (e) => { if (e.target === dialog) close(); });

  const options = () => ({ size: $('images-size').value, margin: +$('images-margin').value });
  /** Alle Bilder vorbereitet – oder `null` mit Meldung, wenn eines nicht geht. */
  async function prepared() {
    try {
      return await Promise.all(items.map((item) => item.image));
    } catch (err) {
      app.toast(err.userMessage || t('Ein Bild ließ sich nicht lesen.'));
      return null;
    }
  }
  const stem = (name) => name.replace(/\.[^.]+$/, '');

  $('images-form').onsubmit = async (e) => {
    e.preventDefault();
    const images = await prepared();
    if (!images?.length) return;
    const name = items.length === 1 ? `${stem(items[0].file.name)}.pdf` : t('Bilder.pdf');
    const opts = options();
    close();
    try {
      const bytes = await pdfFromImages(await app.loadPdfLib(), images, opts);
      await app.openNew(bytes, name);
    } catch (err) {
      console.error(err);
      app.toast(t('Das PDF ließ sich nicht erstellen.'));
    }
  };
  $('images-append').onclick = async () => {
    const images = await prepared();
    if (!images?.length) return;
    const opts = options(), first = app.doc.numPages + 1;
    close();
    const ok = await app.applyChange(images.length === 1 ? t('Bild als Seite angehängt') : t('{n} Bilder als Seiten angehängt', { n: images.length }), async (bytes, lib) => {
      const pdf = await lib.PDFDocument.load(bytes, { updateMetadata: false });
      await addImagePages(pdf, images, opts);
      return pdf.save({ updateFieldAppearances: false });
    });
    if (ok) app.viewer.currentPageNumber = first;
  };

  return {
    prepareImage, pdfFromImages, addImagePages, pageFor,
    /** Dialog öffnen – mit `files`, sonst erst die Dateiauswahl. */
    open(files) {
      clear();
      if (files?.length) { add(files); show(); } else pick();
    },
    add,
  };
}
