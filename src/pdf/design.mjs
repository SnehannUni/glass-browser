// Seiten gestalten wie in Acrobat: Wasserzeichen, Kopf- und Fußzeile, Seitenzahlen – als echter Seiteninhalt
// (pdf-lib drawText), auf allen oder ausgewählten Seiten. Gedrehte Seiten bekommen alles in Leserichtung.
import { t, EN, LOCALE, percent } from './en.mjs';

const $ = (id) => document.getElementById(id);
const MARGIN = 28;
const WM_COLORS = ['#8e8e93', '#d62f2f', '#1f5fd6', '#1e8a4c'];

/** „1-3, 5“ → Seitenindizes (0-basiert); leer = alle. */
export function parsePages(spec, count) {
  const all = Array.from({ length: count }, (_, i) => i);
  if (!spec.trim()) return all;
  const out = new Set();
  for (const part of spec.split(/[,;]+/)) {
    const m = /^\s*(\d+)\s*(?:[-–]\s*(\d*)\s*)?$/.exec(part);
    if (!m) continue;
    const a = +m[1], b = m[2] === undefined ? a : m[2] === '' ? count : +m[2];
    for (let p = Math.max(1, Math.min(a, b)); p <= Math.min(count, Math.max(a, b)); p++) out.add(p - 1);
  }
  return [...out].sort((x, y) => x - y);
}

/** Sichtbare Seite (wie angezeigt, y nach unten) → PDF-Punkte, je nach /Rotate; dazu der Winkel für Text. */
function visual(page) {
  const box = page.getCropBox(), r = ((page.getRotation().angle % 360) + 360) % 360;
  const [w, h] = r % 180 ? [box.height, box.width] : [box.width, box.height];
  const at = (vx, vy) => {
    switch (r) {
      case 90: return [box.x + vy, box.y + vx];
      case 180: return [box.x + box.width - vx, box.y + vy];
      case 270: return [box.x + box.width - vy, box.y + box.height - vx];
      default: return [box.x + vx, box.y + box.height - vy];
    }
  };
  return { w, h, at, angle: r };
}

const hex = (lib, c) => lib.rgb(...[1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255));

/** Text so setzen, dass sein Bezugspunkt (links/Mitte/rechts, Grundlinie) an der sichtbaren Stelle (vx, vy) liegt. */
function place(lib, page, text, font, size, vx, vy, align, { color, opacity = 1, extraAngle = 0 } = {}) {
  const v = visual(page);
  const width = font.widthOfTextAtSize(text, size);
  const dx = align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
  // Grundlinienpunkt in sichtbaren Koordinaten, dann in PDF-Punkte; Textrichtung = Seitendrehung + extra
  const a = (extraAngle * Math.PI) / 180;
  const sx = vx + dx * Math.cos(a), sy = vy - dx * Math.sin(a);
  const [x, y] = v.at(sx, sy);
  page.drawText(text, { x, y, size, font, color, opacity, rotate: lib.degrees(v.angle + extraAngle) });
}

export async function decorate(lib, bytes, options) {
  const { PDFDocument, StandardFonts } = lib;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdf.getPages();
  const targets = parsePages(options.pages || '', pages.length);
  // Platzhalter deutsch und englisch – gilt beides, egal in welcher Sprache die Oberfläche ist
  const start = options.start ?? 1, date = new Date().toLocaleDateString(LOCALE);
  const fill = (s, i) => s.replace(/\{(seiten|seite|pages|page|datum|date|datei|file)\}/g, (_, key) => String({
    seite: i + start, page: i + start, seiten: pages.length + start - 1, pages: pages.length + start - 1,
    datum: date, date, datei: options.fileName || '', file: options.fileName || '',
  }[key]));
  if (options.kind === 'watermark') {
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const { text, size, opacity, angle, color } = options;
    for (const i of targets) {
      const page = pages[i], v = visual(page);
      const width = font.widthOfTextAtSize(text, size), cap = size * .7;
      // Mitte des Textes auf die Mitte der Seite: Grundlinien-Anfang um halbe Breite/Höhe zurück (gedreht)
      const a = (angle * Math.PI) / 180;
      const vx = v.w / 2 - (width / 2) * Math.cos(a) + (cap / 2) * Math.sin(a);
      const vy = v.h / 2 + (width / 2) * Math.sin(a) + (cap / 2) * Math.cos(a);
      place(lib, page, text, font, size, vx, vy, 'left', { color: hex(lib, color), opacity, extraAngle: angle });
    }
  } else {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const size = options.size || 9;
    for (const i of targets) {
      const page = pages[i], v = visual(page);
      for (const [slot, raw] of Object.entries(options.slots)) {
        const text = fill(raw, i);
        if (!text.trim()) continue;
        const [where, align] = slot.split('-');
        const vy = where === 'header' ? MARGIN + size : v.h - MARGIN;
        const vx = align === 'left' ? MARGIN + 8 : align === 'right' ? v.w - MARGIN - 8 : v.w / 2;
        place(lib, page, text, font, size, vx, vy, align === 'center' ? 'center' : align, { color: lib.rgb(.25, .25, .28) });
      }
    }
  }
  return pdf.save({ updateFieldAppearances: false });
}

export function initDesign(app) {
  const dialog = $('design-dialog');
  let tab = 'watermark', color = WM_COLORS[0];
  for (const c of WM_COLORS) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'swatch', title: c });
    b.style.setProperty('--swatch', c);
    if (c === color) b.classList.add('on');
    b.onclick = () => { color = c; for (const o of $('wm-colors').children) o.classList.toggle('on', o === b); };
    $('wm-colors').append(b);
  }
  for (const input of dialog.querySelectorAll('input[type=range]')) {
    const out = input.parentElement.querySelector('output');
    const show = () => { out.textContent = input.id === 'wm-opacity' ? percent(input.value) : input.id === 'wm-angle' ? `${input.value}°` : input.value; };
    input.addEventListener('input', show);
  }
  // Englisch: Formate der Seitenzahlen mit {page}/{pages} (Texte der Auswahl übersetzt viewer.mjs mit dem Rest)
  if (EN) for (const option of $('num-format').options) option.value = t(option.value);
  for (const b of dialog.querySelectorAll('#design-tabs button')) {
    b.onclick = () => {
      tab = b.dataset.tab;
      for (const o of dialog.querySelectorAll('#design-tabs button')) o.classList.toggle('on', o === b);
      for (const p of dialog.querySelectorAll('.design-pane')) p.hidden = p.dataset.tab !== tab;
    };
  }
  const close = () => { dialog.hidden = true; app.container.focus(); };
  $('design-cancel').onclick = close;
  dialog.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
  dialog.addEventListener('pointerdown', (e) => { if (e.target === dialog) close(); });

  function options() {
    const pages = $('design-pages').value;
    if (tab === 'watermark') {
      return { kind: 'watermark', pages, text: $('wm-text').value.trim(), size: +$('wm-size').value, opacity: +$('wm-opacity').value / 100, angle: +$('wm-angle').value, color };
    }
    if (tab === 'header') {
      const slots = {};
      for (const input of dialog.querySelectorAll('[data-slot]')) slots[input.dataset.slot] = input.value;
      return { kind: 'header', pages, slots, size: +$('hf-size').value, fileName: app.name };
    }
    return { kind: 'numbers', pages, slots: { [$('num-position').value]: $('num-format').value }, size: 9, start: +$('num-start').value || 1 };
  }
  $('design-form').onsubmit = async (e) => {
    e.preventDefault();
    const o = options();
    if (o.kind === 'watermark' && !o.text) { $('wm-text').focus(); return; }
    if (o.kind === 'header' && !Object.values(o.slots).some((s) => s.trim())) { dialog.querySelector('[data-slot]').focus(); return; }
    close();
    const label = t({ watermark: 'Wasserzeichen hinzugefügt', header: 'Kopf- und Fußzeile hinzugefügt', numbers: 'Seitenzahlen hinzugefügt' }[o.kind]);
    await app.applyChange(label, (bytes, lib) => {
      try {
        return decorate(lib, bytes, o);
      } catch (err) {
        app.toast(t('Ein Zeichen lässt sich in der Standardschrift nicht darstellen.'));
        throw err;
      }
    });
  };

  return {
    decorate,
    open() {
      dialog.hidden = false;
      dialog.querySelector('form').focus();
    },
  };
}
