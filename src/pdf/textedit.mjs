// Text bearbeiten wie in Acrobat: auf eine Textzeile klicken, ändern, Eingabe. Die alten Zeichen werden aus dem
// Content-Stream entfernt (nicht überdeckt), der neue Text an derselben Grundlinie gesetzt.
// Eingebettete Schriften enthalten meist nur die benutzten Zeichen – darum setzt Glass den neuen Text in einer ganzen
// Schrift: der installierten, die zum Original passt (Arial, Calibri …, eingebettet als Teilmenge), sonst in der
// passenden Standardschrift (Helvetica, Times oder Courier). Schrift, Größe, Fett, Kursiv und Farbe lassen sich ändern.
import { readPage, removeGlyphs, saveContent, centerIn, fillColor, standardFontFor } from './content.mjs';

const $ = (id) => document.getElementById(id);
const STANDARD = {
  Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};
const CSS_FAMILY = { Helvetica: 'Helvetica, Arial, sans-serif', Times: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace' };
const TEXT_COLORS = ['#000000', '#5a5a60', '#1f5fd6', '#d62f2f', '#1e8a4c', '#ff9f0a'];
const userError = (message) => Object.assign(new Error(message), { userMessage: message });

/**
 * Ersetzt auf Seite `index` den Text im Rechteck `rect` (PDF-Punkte) durch `text`.
 * `style` (sonst wie das Original in der passenden Standardschrift): `{ font, size, color }` –
 * `font`: `{ standard: 'Helvetica'|'Times'|'Courier', bold, italic }` oder `{ bytes }` (TrueType/OpenType, braucht `fontkit`),
 * `size` in Punkten, `color` [r, g, b] (0–1).
 */
export async function replaceText(lib, bytes, index, rect, text, style = null, fontkit = null) {
  const pdf = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const content = await readPage(lib, pdf, index);
  const hits = content.glyphs.filter((g) => centerIn(g.quad, rect));
  if (!hits.length) throw userError('Dieser Text liegt in einem eingebetteten Objekt und lässt sich hier nicht ändern.');
  const first = hits[0];
  removeGlyphs(content, hits);
  saveContent(lib, pdf, content);
  if (text.trim()) {
    let font;
    if (style?.font?.bytes) {
      pdf.registerFontkit(fontkit);
      font = await pdf.embedFont(style.font.bytes, { subset: true });
      const missing = [...text].find((ch) => ch.trim() && !font.embedder.font.hasGlyphForCodePoint(ch.codePointAt(0)));
      if (missing) throw userError(`„${missing}“ gibt es in dieser Schrift nicht.`);
    } else {
      const f = style?.font?.standard;
      font = await pdf.embedFont(f ? lib.StandardFonts[STANDARD[f][(style.font.bold ? 1 : 0) + (style.font.italic ? 2 : 0)]] : standardFontFor(lib, first.baseFont));
      try {
        font.encodeText(text);
      } catch {
        throw userError('Ein Zeichen lässt sich in der Standardschrift nicht darstellen – eine installierte Schrift wählen.');
      }
    }
    content.page.drawText(text, {
      x: first.origin[0], y: first.origin[1], size: style?.size || first.size, font,
      color: style?.color ? lib.rgb(...style.color) : fillColor(lib, first.fill), rotate: lib.degrees(first.angle * 180 / Math.PI),
    });
  }
  return pdf.save({ updateFieldAppearances: false });
}

// ---------- Passende Schrift zum Original ----------
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Schnitt einer installierten Familie, möglichst wie gewünscht (sonst der nächste vorhandene). */
const faceOf = (family, bold, italic) => {
  const order = bold && italic ? ['boldItalic', 'bold', 'italic', 'regular'] : bold ? ['bold', 'regular'] : italic ? ['italic', 'regular'] : ['regular', 'bold', 'italic', 'boldItalic'];
  return order.map((k) => family[k]).find(Boolean);
};
/** „ABCDEF+Arial-BoldMT“ → `{ font: 'sys:Arial', bold: true, italic: false }`; ohne passende installierte: Standardschrift. */
export function guessFont(baseFont, installed) {
  const name = (baseFont || '').replace(/^[A-Z]{6}\+/, '');
  const bold = /Bold|Black|Heavy|Semibold|Demi/i.test(name), italic = /Italic|Oblique/i.test(name);
  const key = squash(name.split(/[-,]/)[0].replace(/(PSMT|PS|MT)$/, ''));
  const match = key && installed.find((f) => squash(f.family) === key);
  if (match) return { font: `sys:${match.family}`, bold, italic };
  const std = /Courier|Mono/i.test(name) ? 'Courier' : /Times|Serif|Garamond|Georgia|Cambria|Roman/i.test(name) && !/Sans/i.test(name) ? 'Times' : 'Helvetica';
  return { font: `std:${std}`, bold, italic };
}
const hexOf = (fill) => {
  const v = (fill?.args || []).map((a) => a.v).filter((x) => typeof x === 'number');
  let rgb = [0, 0, 0];
  if (fill?.op === 'g' || v.length === 1) rgb = [v[0], v[0], v[0]];
  else if (fill?.op === 'k' || v.length === 4) rgb = [0, 1, 2].map((i) => (1 - v[i]) * (1 - v[3]));
  else if (v.length >= 3) rgb = v.slice(0, 3);
  return '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(1, c || 0)) * 255).toString(16).padStart(2, '0')).join('');
};

export function initTextEdit(app) {
  let active = false, editing = null;
  const format = $('text-format'), fontSelect = $('te-font'), sizeInput = $('te-size');
  const boldButton = $('te-bold'), italicButton = $('te-italic'), colors = $('te-colors'), hint = $('edit-hint');
  let installed = [];
  let fontsReady = null;
  const loadFonts = () => (fontsReady ||= app.fonts().then((list) => {
    installed = list;
    const group = (label, items) => {
      const g = document.createElement('optgroup');
      g.label = label;
      for (const [value, text] of items) g.append(new Option(text, value));
      return g;
    };
    fontSelect.replaceChildren(
      group('Standardschriften', Object.keys(STANDARD).map((f) => [`std:${f}`, f])),
      ...(list.length ? [group('Installiert', list.map((f) => [`sys:${f.family}`, f.family]))] : []),
    );
  }));

  for (const color of TEXT_COLORS) {
    const b = Object.assign(document.createElement('button'), { className: 'swatch', title: color });
    b.style.setProperty('--swatch', color);
    b.onclick = () => setStyle({ color });
    colors.append(b);
  }

  // ---------- Darstellung im Eingabefeld ----------
  function preview() {
    const { box, style, n } = editing;
    const [kind, family] = style.font.split(/:(.*)/s);
    box.style.fontFamily = kind === 'std' ? CSS_FAMILY[family] : `"${family}"`;
    box.style.fontWeight = style.bold ? '700' : '400';
    box.style.fontStyle = style.italic ? 'italic' : 'normal';
    box.style.color = style.color;
    if (style.size) box.style.fontSize = `${style.size * app.pageGeometry(n).viewport.scale}px`;
    fontSelect.value = style.font;
    sizeInput.value = style.size ? String(Math.round(style.size * 10) / 10) : '';
    boldButton.classList.toggle('on', style.bold);
    italicButton.classList.toggle('on', style.italic);
    for (const b of colors.children) b.classList.toggle('on', b.title === style.color);
  }
  function setStyle(patch, refocus = true) {
    if (!editing?.style) return;
    Object.assign(editing.style, patch);
    preview();
    if (refocus) editing.box.focus();
  }
  fontSelect.addEventListener('change', () => setStyle({ font: fontSelect.value }));
  sizeInput.addEventListener('input', () => { const v = parseFloat(sizeInput.value.replace(',', '.')); if (v >= 2 && v <= 400) setStyle({ size: v }, false); });
  sizeInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); editing?.box.focus(); } });
  boldButton.onclick = () => setStyle({ bold: !editing?.style?.bold });
  italicButton.onclick = () => setStyle({ italic: !editing?.style?.italic });

  function showFormat(on) {
    format.hidden = !on;
    if (hint) hint.hidden = on || !!app.imageEdit?.selected;
    app.placeWells();
  }

  function open(span) {
    const pageDiv = span.closest('#viewer .page');
    const n = +pageDiv.dataset.pageNumber, g = app.pageGeometry(n);
    const r = span.getBoundingClientRect();
    const [x1, y1] = g.eventToPdf({ clientX: r.left, clientY: r.bottom });
    const [x2, y2] = g.eventToPdf({ clientX: r.right, clientY: r.top });
    const rect = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
    const layer = app.glassLayer(n);
    const box = document.createElement('div');
    box.className = 'text-edit';
    box.contentEditable = 'plaintext-only';
    box.spellcheck = true;
    box.textContent = span.textContent;
    const page = pageDiv.getBoundingClientRect();
    Object.assign(box.style, {
      left: `${(r.left - page.left) / page.width * 100}%`, top: `${(r.top - page.top) / page.height * 100}%`,
      minWidth: `${r.width / page.width * 100}%`, height: `${r.height / page.height * 100}%`,
      fontSize: `${r.height * .86}px`, fontFamily: getComputedStyle(span).fontFamily,
    });
    span.classList.add('editing-source');
    layer.append(box);
    const session = editing = { box, span, n, rect, original: span.textContent, style: null, initial: null };
    box.focus();
    getSelection().selectAllChildren(box);
    showFormat(true);
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); boldButton.click(); }
      if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'i') { e.preventDefault(); italicButton.click(); }
    });
    // In die Einstellungen (Schrift, Größe …) wechseln heißt weiter bearbeiten
    box.addEventListener('blur', (e) => {
      if (e.relatedTarget?.closest?.('#tool-options')) return;
      setTimeout(() => editing?.box === box && !document.activeElement?.closest?.('#tool-options') && close(true), 0);
    });
    // Schrift, Größe und Farbe des Originals – sobald die Seite gelesen ist
    Promise.all([app.pageContent(n), loadFonts()]).then(([content]) => {
      if (editing !== session) return;
      const first = content.glyphs.find((gl) => centerIn(gl.quad, rect));
      const guess = guessFont(first?.baseFont, installed);
      session.style = { font: guess.font, bold: guess.bold, italic: guess.italic, size: first ? Math.round(first.size * 10) / 10 : null, color: hexOf(first?.fill) };
      session.initial = { ...session.style };
      preview();
    }).catch((err) => console.warn(err));
  }
  // Fokus wandert aus den Einstellungen anderswohin (nicht zurück ins Feld): übernehmen
  $('tool-options').addEventListener('focusout', (e) => {
    if (!editing || e.relatedTarget === editing.box || e.relatedTarget?.closest?.('#tool-options')) return;
    setTimeout(() => editing && document.activeElement !== editing.box && !document.activeElement?.closest?.('#tool-options') && close(true), 0);
  });

  async function close(commit) {
    if (!editing) return;
    const { box, span, n, rect, original, style, initial } = editing;
    editing = null;
    const text = box.textContent.replace(/\s+/g, ' ');
    box.remove();
    span.classList.remove('editing-source');
    showFormat(false);
    const restyled = !!style && JSON.stringify(style) !== JSON.stringify(initial);
    if (!commit || (text === original && !restyled)) return;
    try {
      // Unverändert Gebliebenes (Größe, Farbe) genau wie im Original; die Schrift ist die gewählte – ohne Wahl die
      // installierte, die zum Original passt
      let options = null, fontkit = null;
      if (style) {
        const [kind, family] = style.font.split(/:(.*)/s);
        let font = null;
        if (kind === 'sys') {
          const file = faceOf(installed.find((f) => f.family === family) || {}, style.bold, style.italic);
          if (file) [font, fontkit] = await Promise.all([app.fontFile(file).then((bytes) => ({ bytes })), app.loadFontkit()]);
        } else if (restyled) {
          font = { standard: family, bold: style.bold, italic: style.italic };
        }
        options = {
          font,
          size: style.size !== initial.size ? style.size : null,
          color: style.color !== initial.color ? [1, 3, 5].map((i) => parseInt(style.color.slice(i, i + 2), 16) / 255) : null,
        };
      }
      const label = !text.trim() ? 'Text entfernt' : text === original ? 'Schrift geändert' : 'Text geändert';
      await app.applyChange(label, async (bytes, lib) => {
        try {
          return await replaceText(lib, bytes, n - 1, rect, text, options, fontkit);
        } catch (err) {
          if (err.userMessage) { app.toast(err.userMessage); return null; }
          throw err;
        }
      });
    } catch (err) {
      console.error(err);
      app.toast('Die Schrift ließ sich nicht laden.');
    }
  }

  const click = (e) => {
    if (!active || e.button !== 0 || editing?.box.contains(e.target)) return;
    // Während eine Zeile offen ist, übernimmt ein Klick daneben die Änderung (und öffnet nichts Neues)
    if (editing) {
      if (e.target.closest?.('#tool-options')) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    const span = e.target.closest?.('#viewer .textLayer span:not(.markedContent):not(:has(span))');
    if (!span || !span.textContent.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    open(span);
  };

  return {
    replaceText, guessFont,
    get isEditing() { return !!editing; },
    /** Für Tests: die offene Zeile und ihre Einstellungen. */
    get session() { return editing; },
    setStyle,
    enter() {
      active = true;
      document.body.classList.add('text-editing');
      app.container.addEventListener('pointerdown', click, true);
      loadFonts().catch(() => {});
    },
    leave() {
      active = false;
      close(true);
      document.body.classList.remove('text-editing');
      app.container.removeEventListener('pointerdown', click, true);
    },
  };
}
