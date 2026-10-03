// Formularfelder anlegen wie in Acrobat („Formular vorbereiten“): Rechteck auf der Seite aufziehen, schon ist ein
// Textfeld, Kontrollkästchen oder eine Auswahlliste da – danach direkt ausfüllbar (PDF.js zeigt AcroForm-Felder).
import { t } from './en.mjs';

const $ = (id) => document.getElementById(id);
const LABEL = { text: t('Textfeld'), checkbox: t('Kontrollkästchen'), dropdown: t('Auswahlliste') };

/** Legt ein Feld `kind` auf Seite `index` im Rechteck `rect` (PDF-Punkte) an; Name: „Textfeld 1“, „Textfeld 2“ … (englisch „Text field 1“) */
export async function addField(lib, bytes, { kind, index, rect, options = [] }) {
  const { PDFDocument, rgb, StandardFonts } = lib;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = pdf.getForm();
  // Freien Namen aus dem Formular selbst (PDF.js meldet neu angelegte Felder über getFieldObjects nicht zuverlässig)
  const taken = new Set(form.getFields().map((f) => f.getName()));
  let name = '';
  for (let i = 1; !name || taken.has(name); i++) name = `${LABEL[kind]} ${i}`;
  const page = pdf.getPage(index);
  const [x1, y1, x2, y2] = rect;
  const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
    borderColor: rgb(.55, .58, .64), borderWidth: 1, backgroundColor: rgb(.93, .95, 1) };
  if (kind === 'checkbox') {
    const s = Math.min(box.width, box.height);
    form.createCheckBox(name).addToPage(page, { ...box, width: s, height: s });
  } else if (kind === 'dropdown') {
    const field = form.createDropdown(name);
    field.addOptions(options.length ? options : [t('Auswahl')]);
    field.addToPage(page, box);
  } else {
    const field = form.createTextField(name);
    // Hohe Felder werden mehrzeilig
    if (box.height > 40) field.enableMultiline();
    field.addToPage(page, box);
  }
  form.updateFieldAppearances(await pdf.embedFont(StandardFonts.Helvetica));
  return pdf.save();
}

export function initFields(app) {
  let active = false, kind = 'text', drag = null;

  const down = (e) => {
    if (!active || e.button !== 0) return;
    const pageDiv = e.target.closest?.('#viewer .page');
    if (!pageDiv || e.target.closest('.note-pin, .note-card, .annotationLayer input, .annotationLayer textarea, .annotationLayer select')) return;
    e.preventDefault();
    e.stopPropagation();
    const n = +pageDiv.dataset.pageNumber, g = app.pageGeometry(n);
    const box = Object.assign(document.createElement('div'), { className: 'field-draft' });
    box.dataset.kind = LABEL[kind];
    app.glassLayer(n).append(box);
    drag = { n, g, start: g.eventToPdf(e), box };
  };
  const move = (e) => {
    if (!drag) return;
    const [x, y] = drag.g.eventToPdf(e);
    drag.rect = [drag.start[0], drag.start[1], x, y];
    Object.assign(drag.box.style, drag.g.rectStyle(drag.rect));
  };
  const up = async () => {
    if (!drag) return;
    const { n, start, box } = drag;
    let { rect } = drag;
    drag = null;
    box.remove();
    // Nur geklickt: Feld in Standardgröße an dieser Stelle
    if (!rect || (Math.abs(rect[2] - rect[0]) < 6 && Math.abs(rect[3] - rect[1]) < 6)) {
      const [w, h] = kind === 'checkbox' ? [14, 14] : kind === 'dropdown' ? [140, 20] : [180, 20];
      rect = [start[0], start[1] - h, start[0] + w, start[1]];
    }
    const options = $('field-options').value.split('\n').map((s) => s.trim()).filter(Boolean);
    await app.applyChange(t('{kind} angelegt', { kind: LABEL[kind] }), (bytes, lib) => addField(lib, bytes, { kind, index: n - 1, rect, options }));
  };

  return {
    addField,
    enter(variant) {
      kind = variant || 'text';
      active = true;
      document.body.classList.add('placing-field');
      app.container.addEventListener('pointerdown', down, true);
      addEventListener('pointermove', move, true);
      addEventListener('pointerup', up, true);
    },
    leave() {
      active = false;
      drag?.box.remove();
      drag = null;
      document.body.classList.remove('placing-field');
      app.container.removeEventListener('pointerdown', down, true);
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
    },
  };
}
