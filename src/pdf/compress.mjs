// Dateigröße verringern wie „PDF optimieren“ in Acrobat, ganz lokal: Bilder auf die Auflösung herunterrechnen, mit der
// sie auf der Seite erscheinen, und als JPEG neu speichern (nur wenn sie dadurch deutlich kleiner werden); nicht mehr
// benutzte Objekte weglassen, ungepackte Daten packen, eingebettete Vorschaubilder und private Daten anderer Programme
// (PieceInfo) entfernen, Objekte in Objekt-Streams bündeln. Text, Schriften, Formulare und Anmerkungen bleiben.
import { readPage } from './content.mjs';
import { jpegOrientation } from './images.mjs';

const $ = (id) => document.getElementById(id);

export const LEVELS = {
  high: { dpi: 200, quality: .85, hint: 'Bilder höchstens 200 dpi – kaum ein sichtbarer Unterschied, auch im Druck.' },
  medium: { dpi: 144, quality: .72, hint: 'Bilder höchstens 144 dpi – gut für Bildschirm und Bürodrucker.' },
  low: { dpi: 96, quality: .55, hint: 'Bilder höchstens 96 dpi – die kleinste Datei, für den Bildschirm.' },
};

export const formatSize = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);

/** Entfernt alle Objekte, die vom Dokument aus nicht mehr erreichbar sind. Liefert, wie viele es waren. */
export function dropUnused(lib, pdf) {
  const { PDFRef, PDFDict, PDFArray, PDFStream } = lib;
  const ctx = pdf.context, seen = new Set();
  const { Root, Info, Encrypt } = ctx.trailerInfo;
  const stack = [Root, Info, Encrypt].filter(Boolean);
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFRef) {
      const key = o.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      const target = ctx.lookup(o);
      if (target) stack.push(target);
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) stack.push(v);
    }
  }
  let dropped = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.toString())) { ctx.delete(ref); dropped++; }
  }
  return dropped;
}

/** Farbraum eines Bildes, den Glass neu kodieren kann: Komponenten und ob er so bleiben darf (RGB). */
function colorSpace(lib, ctx, cs) {
  const { PDFName, PDFArray, PDFNumber } = lib;
  const o = ctx.lookup(cs);
  if (o instanceof PDFName) {
    const n = o.toString();
    return n === '/DeviceRGB' ? { comps: 3, keep: true } : n === '/DeviceGray' ? { comps: 1, keep: false } : null;
  }
  if (o instanceof PDFArray && ctx.lookup(o.get(0))?.toString() === '/ICCBased') {
    const n = ctx.lookup(o.get(1))?.dict?.lookup(PDFName.of('N'));
    const comps = n instanceof PDFNumber ? n.asNumber() : 0;
    return comps === 3 ? { comps, keep: true } : comps === 1 ? { comps, keep: false } : null;
  }
  return null;
}

/** PNG-Prädiktoren (Predictor 10–15) aus Flate-Daten entfernen. */
function unpredict(data, width, comps, rows) {
  const stride = width * comps, out = new Uint8Array(stride * rows);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < rows; y++) {
    const at = y * (stride + 1);
    if (at + stride + 1 > data.length) return null;
    const type = data[at], row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const raw = data[at + 1 + x], a = x >= comps ? row[x - comps] : 0, b = prev[x], c = x >= comps ? prev[x - comps] : 0;
      let v;
      switch (type) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return null;
      }
      row[x] = v & 255;
    }
    prev = row;
  }
  return out;
}

/**
 * Ein Bild neu kodieren: `shown` – größte Darstellung auf einer Seite in Punkten [Breite, Höhe] (unbekannt: Auflösung
 * bleibt). Liefert den neuen Stream oder `null`, wenn es sich nicht lohnt oder das Bild anders aufgebaut ist.
 */
async function recompress(lib, pdf, stream, shown, { dpi, quality }) {
  const { PDFName, PDFArray, PDFNumber, PDFRawStream, decodePDFRawStream } = lib;
  const ctx = pdf.context, dict = stream.dict;
  const get = (k) => ctx.lookup(dict.get(PDFName.of(k)));
  const num = (k) => { const v = get(k); return v instanceof PDFNumber ? v.asNumber() : 0; };
  const W = num('Width'), H = num('Height');
  if (!W || !H || stream.contents.length < 12 * 1024) return null;
  // Masken, eigene Decode-Bereiche, Farbmasken und andere Bittiefen: so lassen
  if (get('ImageMask')?.toString() === 'true' || get('Decode') || get('Mask') instanceof PDFArray || num('BitsPerComponent') !== 8) return null;
  if (get('SMask')?.dict?.has(PDFName.of('Matte'))) return null;
  let filter = get('Filter');
  if (filter instanceof PDFArray) {
    if (filter.size() !== 1) return null;
    filter = ctx.lookup(filter.get(0));
  }
  const f = filter?.toString() || '';
  if (f && f !== '/DCTDecode' && f !== '/FlateDecode') return null;
  const cs = colorSpace(lib, ctx, dict.get(PDFName.of('ColorSpace')));
  if (!cs) return null;

  // So viele Pixel, wie das Bild bei `dpi` braucht – in beiden Richtungen
  const scale = shown ? Math.min(1, Math.max(shown[0] / 72 * dpi / W, shown[1] / 72 * dpi / H)) : 1;
  // Schon ein JPEG in passender Auflösung: neu kodieren brächte bei hoher Qualität nur Verluste
  if (f === '/DCTDecode' && scale > .9 && quality >= .85) return null;
  const tw = Math.max(1, Math.round(W * scale)), th = Math.max(1, Math.round(H * scale));

  let source;
  if (f === '/DCTDecode') {
    if (jpegOrientation(stream.contents) !== 1) return null;
    source = await createImageBitmap(new Blob([stream.contents], { type: 'image/jpeg' }));
    if (source.width !== W || source.height !== H) { source.close(); return null; }
  } else {
    let data = f ? decodePDFRawStream(stream).decode() : stream.contents;
    let parms = get('DecodeParms');
    if (parms instanceof PDFArray) parms = ctx.lookup(parms.get(0));
    const predictor = parms?.lookup?.(PDFName.of('Predictor'));
    const p = predictor instanceof PDFNumber ? predictor.asNumber() : 1;
    if (p >= 10) data = unpredict(data, W, cs.comps, H);
    else if (p !== 1) return null;
    if (!data || data.length < W * H * cs.comps) return null;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0, j = 0; i < W * H; i++, j += cs.comps) {
      const r = data[j], g = cs.comps === 3 ? data[j + 1] : r, b = cs.comps === 3 ? data[j + 2] : r;
      rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
    }
    source = await createImageBitmap(new ImageData(rgba, W, H));
  }
  const resized = await createImageBitmap(source, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
  source.close();
  const canvas = new OffscreenCanvas(tw, th);
  canvas.getContext('2d').drawImage(resized, 0, 0);
  resized.close();
  const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
  // Nur wenn es sich lohnt – ein schon gutes JPEG bleibt, wie es ist
  if (jpeg.length >= stream.contents.length * (f === '/DCTDecode' ? .8 : .9)) return null;
  const next = dict.clone(ctx);
  for (const k of ['Filter', 'DecodeParms', 'Length', 'DL']) next.delete(PDFName.of(k));
  next.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
  next.set(PDFName.of('Width'), PDFNumber.of(tw));
  next.set(PDFName.of('Height'), PDFNumber.of(th));
  // Das Canvas schreibt immer RGB
  if (!cs.keep) next.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
  return PDFRawStream.of(next, jpeg);
}

/** Verkleinert `bytes`; `level` aus LEVELS. Liefert `{ bytes, images }` (wie viele Bilder neu kodiert wurden). */
export async function compressBytes(lib, bytes, level) {
  const { PDFDocument, PDFName, PDFDict, PDFRef, PDFRawStream } = lib;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = pdf.context;

  // Wie groß jedes Bild höchstens auf einer Seite erscheint
  const shown = new Map();
  for (let i = 0; i < pdf.getPageCount(); i++) {
    let content;
    try { content = await readPage(lib, pdf, i); } catch { continue; }
    const xobjects = content.node.Resources()?.lookup(PDFName.of('XObject'));
    if (!(xobjects instanceof PDFDict)) continue;
    for (const o of content.objects) {
      const ref = o.kind === 'image' && o.name ? xobjects.get(PDFName.of(o.name)) : null;
      if (!(ref instanceof PDFRef)) continue;
      const [a, b, , d] = o.quad;
      const w = Math.hypot(b[0] - a[0], b[1] - a[1]), h = Math.hypot(d[0] - a[0], d[1] - a[1]);
      const old = shown.get(ref.toString()) || [0, 0];
      shown.set(ref.toString(), [Math.max(old[0], w), Math.max(old[1], h)]);
    }
  }

  // Bilder; Masken anderer Bilder bleiben, wie sie sind
  const images = [], masks = new Set();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    images.push([ref, obj]);
    for (const k of ['SMask', 'Mask']) {
      const m = obj.dict.get(PDFName.of(k));
      if (m instanceof PDFRef) masks.add(m.toString());
    }
  }
  let recoded = 0;
  for (const [ref, stream] of images) {
    if (masks.has(ref.toString())) continue;
    try {
      const next = await recompress(lib, pdf, stream, shown.get(ref.toString()), level);
      if (next) { ctx.assign(ref, next); recoded++; }
    } catch (err) {
      console.warn('Bild bleibt unverändert', err);
    }
  }

  // Vorschaubilder der Seiten und private Daten anderer Programme
  for (const page of pdf.getPages()) {
    page.node.delete(PDFName.of('Thumb'));
    page.node.delete(PDFName.of('PieceInfo'));
  }
  pdf.catalog.delete(PDFName.of('PieceInfo'));

  await pdf.flush();
  dropUnused(lib, pdf);

  // Ungepackte Streams packen (Inhalte, Schriften …)
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.has(PDFName.of('Filter')) || obj.contents.length < 256) continue;
    const type = obj.dict.get(PDFName.of('Type'))?.toString();
    if (type === '/Metadata' || type === '/XRef' || type === '/ObjStm') continue;
    const packed = ctx.flateStream(obj.contents);
    for (const [k, v] of obj.dict.entries()) if (k.toString() !== '/Length') packed.dict.set(k, v);
    if (packed.contents.length < obj.contents.length * .9) ctx.assign(ref, packed);
  }
  return { bytes: await pdf.save({ useObjectStreams: true, updateFieldAppearances: false }), images: recoded };
}

/**
 * Dialog: zeigt für jede Stufe, wie groß die verkleinerte Fassung wird (gleich beim Öffnen im Hintergrund
 * berechnet), und speichert sie als neue Datei – das offene PDF bleibt, wie es ist.
 */
export function initCompress(app) {
  const dialog = $('compress-dialog'), submit = $('compress-save');
  const buttons = [...dialog.querySelectorAll('#compress-level button')];
  let level = 'medium';
  let session = null; // { base, results: { Stufe → Promise<Uint8Array|null> } }

  let noImages = false;
  const showLevel = () => {
    for (const b of buttons) b.classList.toggle('on', b.dataset.level === level);
    // Ohne Bilder ergeben alle Stufen dasselbe – dann das sagen statt der Bild-Auflösung
    $('compress-hint').textContent = noImages
      ? 'Dieses PDF enthält keine Bilder, die sich verkleinern lassen – darum ist jede Stufe gleich groß. Kleiner wird es durch gepackte Daten und weggelassene alte Fassungen.'
      : LEVELS[level].hint;
  };
  for (const b of buttons) b.onclick = () => { level = b.dataset.level; showLevel(); };
  const close = () => { dialog.hidden = true; session = null; app.container.focus(); };
  $('compress-cancel').onclick = close;
  dialog.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
  dialog.addEventListener('pointerdown', (e) => { if (e.target === dialog) close(); });

  const sizeLabel = (which, text) => { const el = dialog.querySelector(`[data-level="${which}"] .size`); if (el) el.textContent = text; };

  /** Alle Stufen nacheinander berechnen – die gewählte zuerst. */
  function estimate(current) {
    const results = {};
    let chain = Promise.resolve();
    for (const which of [level, ...Object.keys(LEVELS).filter((l) => l !== level)]) {
      sizeLabel(which, 'wird berechnet …');
      results[which] = chain = chain.then(async () => {
        if (session !== current) return null;
        try {
          const { bytes, images } = await compressBytes(await app.loadPdfLib(), current.base.slice(), LEVELS[which]);
          current.recoded = (current.recoded || 0) + images;
          const kept = bytes.length < current.base.length * .97;
          if (session === current) sizeLabel(which, kept ? `etwa ${formatSize(bytes.length)} (−${Math.round((1 - bytes.length / current.base.length) * 100)} %)` : 'kaum kleiner');
          return kept ? bytes : null;
        } catch (err) {
          console.error(err);
          if (session === current) sizeLabel(which, 'geht nicht');
          return null;
        }
      });
    }
    return results;
  }

  /** Verkleinerte Fassung der Stufe als neue Datei speichern („Speichern unter“); mit Passwort, wenn das PDF eins hat. */
  async function save(which = level) {
    const current = session;
    if (!current) return false;
    submit.disabled = true;
    submit.textContent = 'Wird berechnet …';
    try {
      let bytes = await current.results[which];
      if (session !== current) return false;
      if (!bytes) { app.toast('Das PDF ist schon kompakt – kleiner geht es kaum.'); return false; }
      const size = bytes.length;
      if (app.protection) bytes = await app.encryptBytes(bytes, app.protection.password);
      close();
      const result = await app.writeFile(bytes, `${app.name.replace(/\.pdf$/i, '')} (verkleinert).pdf`, true);
      if (!result.ok) {
        if (!result.cancelled) app.toast('Speichern hat nicht geklappt' + (result.error ? `: ${result.error}` : '.'));
        return false;
      }
      app.toast(`${result.name ? `„${result.name}“` : 'Verkleinerte Fassung'} gespeichert – ${formatSize(size)} statt ${formatSize(current.base.length)}`);
      return true;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Speichern unter …';
    }
  }
  $('compress-form').onsubmit = (e) => { e.preventDefault(); save(); };

  return {
    compressBytes, save,
    async open() {
      level = 'medium';
      noImages = false;
      showLevel();
      const current = session = { base: null, results: {} };
      $('compress-size').textContent = 'Größe wird ermittelt …';
      for (const which of Object.keys(LEVELS)) sizeLabel(which, '');
      dialog.hidden = false;
      dialog.querySelector('form').focus();
      try {
        current.base = await app.workingBytes();
      } catch {
        $('compress-size').textContent = 'Das PDF ließ sich nicht lesen.';
        return;
      }
      if (session !== current) return;
      $('compress-size').textContent = `Jetzt ${formatSize(current.base.length)}. Die verkleinerte Fassung wird als neue Datei gespeichert, dieses PDF bleibt unverändert.`;
      current.results = estimate(current);
      // Alle Stufen fertig und nirgends ein Bild neu kodiert: Hinweis statt Bild-Auflösung
      Promise.all(Object.values(current.results)).then(() => {
        if (session !== current) return;
        noImages = !current.recoded;
        showLevel();
      });
    },
  };
}
