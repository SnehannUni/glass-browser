// Text bearbeiten wie in Acrobat: auf eine Textzeile klicken, ändern, Eingabe. Die alten Zeichen werden aus dem
// Content-Stream entfernt (nicht überdeckt), der neue Text an derselben Grundlinie in gleicher Größe und Farbe gesetzt.
// Eingebettete Schriften enthalten meist nur die benutzten Zeichen – darum setzt Glass den neuen Text in der
// passenden Standardschrift (Helvetica, Times oder Courier, fett/kursiv wie das Original).
import { readPage, removeGlyphs, saveContent, centerIn, fillColor, standardFontFor } from './content.mjs';

/** Ersetzt auf Seite `index` den Text im Rechteck `rect` (PDF-Punkte) durch `text`. */
export async function replaceText(lib, bytes, index, rect, text) {
  const pdf = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const content = await readPage(lib, pdf, index);
  const hits = content.glyphs.filter((g) => centerIn(g.quad, rect));
  if (!hits.length) throw Object.assign(new Error('Kein Text gefunden'), { userMessage: 'Dieser Text liegt in einem eingebetteten Objekt und lässt sich hier nicht ändern.' });
  const first = hits[0];
  removeGlyphs(content, hits);
  saveContent(lib, pdf, content);
  if (text.trim()) {
    const font = await pdf.embedFont(standardFontFor(lib, first.baseFont));
    try {
      font.encodeText(text);
    } catch {
      throw Object.assign(new Error('Zeichen fehlt'), { userMessage: 'Ein Zeichen lässt sich in der Standardschrift nicht darstellen.' });
    }
    content.page.drawText(text, {
      x: first.origin[0], y: first.origin[1], size: first.size, font,
      color: fillColor(lib, first.fill), rotate: lib.degrees(first.angle * 180 / Math.PI),
    });
  }
  return pdf.save({ updateFieldAppearances: false });
}

export function initTextEdit(app) {
  let active = false, editing = null;

  function open(span) {
    close(false);
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
    editing = { box, span, n, rect, original: span.textContent };
    box.focus();
    getSelection().selectAllChildren(box);
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
    });
    box.addEventListener('blur', () => setTimeout(() => editing?.box === box && close(true), 0));
  }

  async function close(commit) {
    if (!editing) return;
    const { box, span, n, rect, original } = editing;
    editing = null;
    const text = box.textContent.replace(/\s+/g, ' ');
    box.remove();
    span.classList.remove('editing-source');
    if (!commit || text === original) return;
    try {
      await app.applyChange(text.trim() ? 'Text geändert' : 'Text entfernt', async (bytes, lib) => {
        try {
          return await replaceText(lib, bytes, n - 1, rect, text);
        } catch (err) {
          if (err.userMessage) { app.toast(err.userMessage); return null; }
          throw err;
        }
      });
    } catch (err) {
      console.error(err);
    }
  }

  const click = (e) => {
    if (!active || e.button !== 0 || editing?.box.contains(e.target)) return;
    const span = e.target.closest?.('#viewer .textLayer span:not(.markedContent):not(:has(span))');
    if (!span || !span.textContent.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    open(span);
  };

  return {
    replaceText,
    enter() {
      active = true;
      document.body.classList.add('text-editing');
      app.container.addEventListener('pointerdown', click, true);
    },
    leave() {
      active = false;
      close(true);
      document.body.classList.remove('text-editing');
      app.container.removeEventListener('pointerdown', click, true);
    },
  };
}
