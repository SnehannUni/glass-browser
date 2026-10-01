// Bearbeiten wie in Acrobat: Hervorheben, Text, Zeichnen, Bilder und Unterschriften.
// Die Werkzeuge selbst sind die Editoren von PDF.js (sie schreiben echte PDF-Anmerkungen, saveDocument speichert sie);
// hier sind Leiste, Einstellungen und der Dialog für Unterschriften – PDF.js bringt dafür nur die Schnittstelle mit.
const $ = (id) => document.getElementById(id);

/** Farben zum Hervorheben: Name=Farbe, wie PDF.js sie erwartet (annotationEditorHighlightColors). */
export const HIGHLIGHT_COLORS = 'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F';
const PEN_COLORS = ['#000000', '#1f5fd6', '#d62f2f', '#1e8a4c', '#ff9f0a', '#ffffff'];
/** So hoch wird eine neue Unterschrift auf der Seite (Anteil der Seitenhöhe wie in PDF.js, hier in PDF-Punkten). */
const SIGNATURE_HEIGHT = 40;
/** Rand um Unterschriften in ihrem Kasten (SignatureEditor._INNER_MARGIN in PDF.js). */
const INNER_MARGIN = 3;
const MAX_SAVED = 5;
const SCRIPT_FONT = '"Segoe Script", "Lucida Handwriting", "Brush Script MT", cursive';

const uuid = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Gespeicherte Unterschriften und der Dialog für neue. PDF.js ruft `getSignature`, sobald auf der Seite eine
 * Unterschrift ohne Daten entsteht; `renderEditButton` liefert den Knopf in der kleinen Leiste am Editor.
 */
export class Signatures {
  #pdfjs;
  #url;
  #list = null;
  #onChange;

  constructor(pdfjs, url, onChange) {
    this.#pdfjs = pdfjs;
    this.#url = url;
    this.#onChange = onChange;
  }

  get list() { return this.#list || []; }

  async loadSignatures() {
    if (this.#list) return;
    try {
      const res = await fetch(this.#url, { cache: 'no-store' });
      const list = res.ok ? await res.json() : [];
      this.#list = Array.isArray(list) ? list.filter((s) => s && typeof s.data === 'string').slice(0, MAX_SAVED) : [];
    } catch {
      this.#list = [];
    }
    this.#onChange();
  }

  async #store() {
    this.#onChange();
    try {
      await fetch(this.#url, { method: 'POST', body: JSON.stringify(this.#list), headers: { 'Content-Type': 'text/plain' } });
    } catch { /* bleibt dann nur für diese Sitzung */ }
  }

  async remove(id) {
    this.#list = this.list.filter((s) => s.uuid !== id);
    await this.#store();
  }

  /** Daten für einen neuen SignatureEditor mit einer gespeicherten Unterschrift (`switchannotationeditorparams` CREATE). */
  async editorData(saved) {
    const { areContours, thickness, outlines, width, height } = await this.#pdfjs.SignatureExtractor.decompressSignature(saved.data);
    return {
      signatureData: {
        lines: { curves: outlines.map((points) => ({ points })), thickness, width, height },
        mustSmooth: false, areContours, description: saved.description, uuid: saved.uuid, heightInPage: SIGNATURE_HEIGHT,
      },
    };
  }

  /** Vorschau einer gespeicherten Unterschrift als SVG (Linienzüge oder Umrisse). */
  async preview(saved) {
    const { areContours, thickness, outlines, width, height } = await this.#pdfjs.SignatureExtractor.decompressSignature(saved.data);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', outlines.map((p) => {
      let d = `M${p[0]} ${p[1]}`;
      for (let i = 2; i < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
      return areContours ? d + 'Z' : d;
    }).join(''));
    if (areContours) path.setAttribute('fill-rule', 'evenodd');
    else path.setAttribute('stroke-width', Math.max(1, thickness || 2));
    path.classList.add(areContours ? 'fill' : 'stroke');
    svg.append(path);
    return svg;
  }

  getSignature({ editor }) {
    dialog.open(editor, this);
  }

  async renderEditButton(editor) {
    const button = document.createElement('button');
    button.className = 'glass-edit-signature';
    button.title = 'Beschreibung bearbeiten';
    button.innerHTML = '<svg viewBox="0 0 16 16"><use href="#i-pen"/></svg>';
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = prompt('Beschreibung der Unterschrift', editor.description || '');
      if (text !== null) editor.description = text.trim() || 'Unterschrift';
    });
    return button;
  }

  /** Neue Unterschrift aus dem Dialog: in den Editor, und auf Wunsch für später merken. */
  async add(editor, data, description, save) {
    const id = save && this.list.length < MAX_SAVED ? uuid() : null;
    editor.addSignature(data, SIGNATURE_HEIGHT, description, id);
    if (!id) return;
    const { newCurves, areContours, thickness, width, height } = data;
    const packed = await this.#pdfjs.SignatureExtractor.compressSignature({ outlines: newCurves, areContours, thickness, width, height });
    this.#list = [...this.list, { uuid: id, description, data: packed }];
    await this.#store();
  }

  destroy() {}
}

// ---------- Dialog: zeichnen, tippen oder Bild ----------
const dialog = (() => {
  const root = $('sign-dialog'), pad = $('sign-draw'), typeInput = $('sign-type'), add = $('sign-add');
  const description = $('sign-description'), save = $('sign-save'), thickness = $('sign-thickness').querySelector('input');
  let editor = null, manager = null, tab = 'draw', curves = [], current = null, bitmap = null, done = false;
  let lastFocus = null;

  const ns = 'http://www.w3.org/2000/svg';
  function redraw() {
    pad.replaceChildren();
    for (const points of [...curves, ...(current ? [current] : [])]) {
      const path = document.createElementNS(ns, 'path');
      let d = `M${points[0]} ${points[1]}`;
      for (let i = 2; i < points.length; i += 2) d += `L${points[i]} ${points[i + 1]}`;
      if (points.length === 2) d += `l.01 0`;
      path.setAttribute('d', d);
      path.setAttribute('stroke-width', thickness.value * 1.4);
      pad.append(path);
    }
    pad.parentElement.classList.toggle('empty', !curves.length && !current);
    update();
  }
  function update() {
    const ready = tab === 'draw' ? curves.length > 0 : tab === 'type' ? typeInput.value.trim().length > 0 : !!bitmap;
    add.disabled = !ready;
    $('sign-thickness').hidden = tab !== 'draw';
    save.disabled = !!manager && manager.list.length >= 5;
    save.parentElement.title = save.disabled ? 'Es sind schon 5 Unterschriften gespeichert – zuerst eine entfernen.' : '';
  }
  const point = (e) => {
    const r = pad.getBoundingClientRect();
    return [Math.round((e.clientX - r.left) * 10) / 10, Math.round((e.clientY - r.top) * 10) / 10];
  };
  pad.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pad.setPointerCapture(e.pointerId);
    current = point(e);
    redraw();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!current) return;
    for (const ev of e.getCoalescedEvents?.() || [e]) current.push(...point(ev));
    redraw();
  });
  const finish = () => {
    if (!current) return;
    curves.push(current);
    current = null;
    redraw();
  };
  pad.addEventListener('pointerup', finish);
  pad.addEventListener('pointercancel', finish);
  thickness.addEventListener('input', redraw);
  $('sign-clear').onclick = () => { curves = []; current = null; redraw(); };

  typeInput.style.fontFamily = SCRIPT_FONT;
  typeInput.addEventListener('input', () => {
    if (!description.dataset.edited) description.value = typeInput.value.trim();
    update();
  });
  description.addEventListener('input', () => { description.dataset.edited = description.value ? '1' : ''; });

  async function useImage(file) {
    if (!file?.type.startsWith('image/')) return;
    bitmap = await createImageBitmap(file).catch(() => null);
    const img = $('sign-image');
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = bitmap ? URL.createObjectURL(file) : '';
    img.hidden = !bitmap;
    $('sign-drop').classList.toggle('filled', !!bitmap);
    update();
  }
  $('sign-file').addEventListener('change', (e) => useImage(e.target.files[0]));
  const drop = $('sign-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); useImage(e.dataTransfer.files[0]); });

  for (const button of document.querySelectorAll('#sign-tabs button')) {
    button.onclick = () => {
      tab = button.dataset.tab;
      for (const other of document.querySelectorAll('#sign-tabs button')) other.classList.toggle('on', other === button);
      for (const view of root.querySelectorAll('.sign-pad')) view.hidden = view.dataset.tab !== tab;
      if (tab === 'type') typeInput.focus();
      update();
    };
  }

  function close() {
    root.hidden = true;
    lastFocus?.focus?.();
    // Abgebrochen: der leere Editor auf der Seite verschwindet wieder
    if (!done) editor?.remove();
    editor = manager = null;
  }

  async function submit() {
    if (add.disabled || !editor) return;
    const { SignatureExtractor } = globalThis.pdfjsLib;
    const { rawDims: { pageWidth, pageHeight }, rotation } = editor.parent.viewport;
    let data = null;
    if (tab === 'draw') {
      const r = pad.getBoundingClientRect();
      data = SignatureExtractor.processDrawnLines({
        lines: { curves: curves.map((points) => ({ points })), thickness: +thickness.value, width: r.width, height: r.height },
        pageWidth, pageHeight, rotation, innerMargin: INNER_MARGIN, mustSmooth: false, areContours: false,
      });
    } else if (tab === 'type') {
      data = SignatureExtractor.extractContoursFromText(typeInput.value.trim(),
        { fontFamily: SCRIPT_FONT, fontStyle: 'normal', fontWeight: '400' }, pageWidth, pageHeight, rotation, INNER_MARGIN);
    } else if (bitmap) {
      data = SignatureExtractor.process(bitmap, pageWidth, pageHeight, rotation, INNER_MARGIN);
    }
    if (!data) {
      add.disabled = true;
      add.textContent = 'Nicht erkannt';
      setTimeout(() => { add.textContent = 'Hinzufügen'; update(); }, 1500);
      return;
    }
    done = true;
    const target = editor, owner = manager;
    const text = description.value.trim() || (tab === 'type' ? typeInput.value.trim() : '') || 'Unterschrift';
    close();
    await owner.add(target, data, text, save.checked && !save.disabled);
  }
  add.onclick = submit;
  $('sign-cancel').onclick = close;
  root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });
  root.addEventListener('keydown', (e) => {
    e.stopPropagation(); // nicht an PDF.js (Entf, Strg+Z …) oder die Tastenkürzel des Viewers
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && e.target !== description && !e.target.closest('button')) { e.preventDefault(); submit(); }
  });

  return {
    open(target, owner) {
      editor = target; manager = owner; done = false;
      lastFocus = document.activeElement;
      curves = []; current = null; bitmap = null;
      typeInput.value = ''; description.value = ''; description.dataset.edited = '';
      $('sign-image').hidden = true; $('sign-drop').classList.remove('filled');
      root.hidden = false;
      redraw();
      if (tab === 'type') typeInput.focus({ preventScroll: true });
      else root.querySelector('[role=dialog]').focus({ preventScroll: true });
    },
  };
})();

/**
 * Leiste rechts und Einstellungen. `app` kommt aus viewer.mjs (viewer, eventBus, pdfjsLib …).
 * Gibt `setTool` zurück, damit das Organisieren der Seiten die Werkzeuge abschalten kann.
 */
export function initTools(app) {
  const { viewer, eventBus, pdfjsLib: { AnnotationEditorType: T, AnnotationEditorParamsType: P } } = app;
  const MODES = { none: T.NONE, highlight: T.HIGHLIGHT, freetext: T.FREETEXT, ink: T.INK, stamp: T.STAMP, signature: T.SIGNATURE };
  const panel = $('tool-options');
  const buttons = [...document.querySelectorAll('#tools [data-tool]')];
  let tool = 'none';

  const param = (type, value) => eventBus.dispatch('switchannotationeditorparams', { source: null, type, value });
  const modeChanged = (mode) => new Promise((done) => {
    if (viewer.annotationEditorMode === mode) return done();
    const once = (e) => { if (e.mode === mode) { eventBus.off('annotationeditormodechanged', once); done(); } };
    eventBus.on('annotationeditormodechanged', once);
  });

  async function setTool(next) {
    if (!(next in MODES)) return;
    tool = next;
    for (const b of buttons) b.classList.toggle('on', b.dataset.tool === next);
    const mode = MODES[next];
    if (viewer.annotationEditorMode !== mode) {
      const changed = modeChanged(mode);
      viewer.annotationEditorMode = { mode };
      await changed;
    }
    document.body.dataset.tool = next;
    const section = panel.querySelector(`[data-for="${next}"]`);
    for (const s of panel.querySelectorAll('section')) s.hidden = s !== section;
    panel.hidden = !section;
    if (section) requestAnimationFrame(app.placeWells);
    if (next === 'signature') app.signatures.loadSignatures();
    app.scheduleInk();
  }
  for (const b of buttons) {
    b.onclick = () => {
      if (b.dataset.tool === 'stamp') return pickImage();
      setTool(tool === b.dataset.tool && tool !== 'none' ? 'none' : b.dataset.tool);
    };
  }

  // Bild: erst die Datei, dann landet es mittig auf der sichtbaren Seite – verschieben und skalieren wie in Acrobat
  const imageInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', hidden: true });
  document.body.append(imageInput);
  function pickImage() { imageInput.value = ''; imageInput.click(); }
  imageInput.addEventListener('change', async () => {
    const file = imageInput.files[0];
    if (!file) return;
    await setTool('stamp');
    param(P.CREATE, { bitmapFile: file });
  });

  // ---------- Farben und Stärken ----------
  function swatches(name, colors, apply, initial) {
    const box = panel.querySelector(`.swatches[data-param="${name}"]`);
    for (const color of colors) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.setProperty('--swatch', color);
      b.title = color;
      b.onclick = () => {
        for (const other of box.children) other.classList.toggle('on', other === b);
        apply(color);
      };
      if (color === initial) b.classList.add('on');
      box.append(b);
    }
  }
  const highlightColors = HIGHLIGHT_COLORS.split(',').map((pair) => pair.split('=')[1]);
  swatches('highlight', highlightColors, (c) => param(P.HIGHLIGHT_COLOR, c), highlightColors[0]);
  swatches('freetext', PEN_COLORS.slice(0, 5), (c) => param(P.FREETEXT_COLOR, c), PEN_COLORS[0]);
  swatches('ink', PEN_COLORS, (c) => param(P.INK_COLOR, c), PEN_COLORS[0]);
  const sliders = {
    'highlight-thickness': [P.HIGHLIGHT_THICKNESS, (v) => v, (v) => v],
    'freetext-size': [P.FREETEXT_SIZE, (v) => v, (v) => v],
    'ink-thickness': [P.INK_THICKNESS, (v) => v, (v) => v],
    'ink-opacity': [P.INK_OPACITY, (v) => v / 100, (v) => `${v} %`],
  };
  for (const input of panel.querySelectorAll('input[type=range]')) {
    const [type, value, label] = sliders[input.dataset.param];
    const out = input.parentElement.querySelector('output');
    input.addEventListener('input', () => {
      if (out) out.textContent = label(+input.value);
      param(type, value(+input.value));
    });
  }

  // ---------- Unterschriften ----------
  async function renderSaved() {
    const box = $('saved-signatures');
    box.replaceChildren();
    for (const saved of app.signatures.list) {
      const item = document.createElement('div');
      item.className = 'saved';
      const use = Object.assign(document.createElement('button'), { className: 'use', title: `${saved.description} einfügen` });
      use.append(await app.signatures.preview(saved).catch(() => document.createTextNode(saved.description)));
      use.onclick = async () => {
        await setTool('signature');
        param(P.CREATE, await app.signatures.editorData(saved));
      };
      const remove = Object.assign(document.createElement('button'), { className: 'remove', title: 'Gespeicherte Unterschrift entfernen' });
      remove.innerHTML = '<svg><use href="#i-close"/></svg>';
      remove.onclick = () => app.signatures.remove(saved.uuid);
      item.append(use, remove);
      box.append(item);
    }
    box.hidden = !app.signatures.list.length;
    app.placeWells();
  }
  app.onSignaturesChanged = renderSaved;
  $('new-signature').onclick = async () => {
    await setTool('signature');
    param(P.CREATE, {}); // leerer Editor → PDF.js fragt nach der Unterschrift (getSignature → Dialog)
  };

  // ---------- Rückgängig / Wiederholen ----------
  // PDF.js meldet den Stand nur, solange ein Werkzeug aktiv ist – rückgängig machen geht aber auch danach noch.
  // Darum: frei, sobald etwas geändert wurde (app.edited), ein Klick ohne Schritt bewirkt einfach nichts.
  const undo = $('undo'), redo = $('redo');
  let canUndo = false, canRedo = false;
  const show = () => {
    undo.disabled = !(canUndo || app.edited);
    redo.disabled = !canRedo;
  };
  eventBus.on('annotationeditorstateschanged', ({ details }) => {
    if (details.isEditing) {
      canUndo = !!details.hasSomethingToUndo;
      canRedo = !!details.hasSomethingToRedo;
    }
    show();
  });
  undo.onclick = () => { eventBus.dispatch('editingaction', { source: null, name: 'undo' }); canRedo = true; show(); };
  redo.onclick = () => { eventBus.dispatch('editingaction', { source: null, name: 'redo' }); show(); };
  addEventListener('glass-edited', show);

  // Tastenkürzel wie in Acrobat – nur wenn gerade nicht getippt wird
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
    if (e.target.closest?.('input, textarea, [contenteditable], .dialog, #organize')) return;
    const key = { h: 'highlight', t: 'freetext', d: 'ink', s: 'signature' }[e.key.toLowerCase()];
    if (key) { e.preventDefault(); setTool(key); }
    // Esc: erst PDF.js die Auswahl aufheben lassen, danach zurück zum Auswählen
    else if (e.key === 'Escape' && tool !== 'none' && !document.querySelector('.selectedEditor')) setTool('none');
  });

  return { setTool, get tool() { return tool; } };
}
