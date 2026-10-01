// Bearbeiten wie in Acrobat: Hervorheben, Text, Zeichnen, Bilder und Unterschriften.
// Die Werkzeuge selbst sind die Editoren von PDF.js (sie schreiben echte PDF-Anmerkungen, saveDocument speichert sie);
// hier sind Leiste, Einstellungen und der Dialog für Unterschriften – PDF.js bringt dafür nur die Schnittstelle mit.
const $ = (id) => document.getElementById(id);

/** Farben zum Hervorheben: Name=Farbe, wie PDF.js sie erwartet (annotationEditorHighlightColors). */
export const HIGHLIGHT_COLORS = 'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F';
const PEN_COLORS = ['#000000', '#1f5fd6', '#d62f2f', '#1e8a4c', '#ff9f0a', '#ffffff'];
/** Unterstreichen, Durchstreichen: wie in Acrobat zuerst Grün bzw. Rot */
const LINE_COLORS = ['#1e8a4c', '#d62f2f', '#1f5fd6', '#000000'];
export const NOTE_COLORS = ['#ffd60a', '#ff9f0a', '#ff6b6b', '#64d2ff', '#30d158', '#bf5af2'];
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
 * Werkzeuge sind Gruppen (Markieren, Zeichnen, Formularfeld …) mit Varianten in den Einstellungen. Ein Werkzeug ist
 * entweder ein Editor von PDF.js (`mode`) oder ein eigenes (`custom`: enter/leave, etwa Notizen oder Schwärzen).
 */
export function initTools(app) {
  const { viewer, eventBus, pdfjsLib: { AnnotationEditorType: T, AnnotationEditorParamsType: P } } = app;
  const panel = $('tool-options');
  const buttons = [...document.querySelectorAll('#tools [data-tool]')];
  const shape = (kind) => ({ mode: T.INK, custom: () => shapes(kind) });
  const markupLine = (kind) => ({ mode: T.NONE, custom: () => markLines(kind) });
  const GROUPS = {
    none: { mode: T.NONE },
    textedit: { mode: T.NONE, custom: () => app.textEdit },
    markup: { subs: { highlight: { mode: T.HIGHLIGHT }, underline: markupLine('underline'), strike: markupLine('strike') } },
    note: { mode: T.NONE, custom: () => app.notes },
    freetext: { mode: T.FREETEXT },
    draw: { subs: { pen: { mode: T.INK }, rect: shape('rect'), ellipse: shape('ellipse'), line: shape('line'), arrow: shape('arrow') } },
    stamp: { mode: T.NONE },
    signature: { mode: T.SIGNATURE },
    field: { subs: { text: { mode: T.NONE, custom: () => app.fields }, checkbox: { mode: T.NONE, custom: () => app.fields }, dropdown: { mode: T.NONE, custom: () => app.fields } } },
    redact: { mode: T.NONE, custom: () => app.redact },
  };
  const sub = Object.fromEntries(Object.entries(GROUPS).filter(([, g]) => g.subs).map(([k, g]) => [k, Object.keys(g.subs)[0]]));
  let tool = 'none', active = null;
  const spec = (group = tool) => (GROUPS[group].subs ? GROUPS[group].subs[sub[group]] : GROUPS[group]);

  const param = (type, value) => eventBus.dispatch('switchannotationeditorparams', { source: null, type, value });
  const modeChanged = (mode) => new Promise((done) => {
    if (viewer.annotationEditorMode === mode) return done();
    const once = (e) => { if (e.mode === mode) { eventBus.off('annotationeditormodechanged', once); done(); } };
    eventBus.on('annotationeditormodechanged', once);
  });
  async function setMode(mode) {
    if (viewer.annotationEditorMode === mode) return;
    const changed = modeChanged(mode);
    viewer.annotationEditorMode = { mode };
    await changed;
  }

  async function setTool(next, variant) {
    if (!(next in GROUPS)) return;
    if (variant && GROUPS[next].subs?.[variant]) sub[next] = variant;
    active?.leave?.();
    active = null;
    tool = next;
    for (const b of buttons) b.classList.toggle('on', b.dataset.tool === next);
    const { mode, custom } = spec();
    await setMode(mode);
    if (tool !== next) return; // inzwischen anderes Werkzeug gewählt
    document.body.dataset.tool = next;
    document.body.dataset.sub = sub[next] || '';
    const section = panel.querySelector(`[data-for="${next}"]`);
    for (const s of panel.querySelectorAll('section')) s.hidden = s !== section;
    // Varianten: Knopf markieren, nur passende Einstellungen zeigen
    for (const b of panel.querySelectorAll(`.variants[data-group="${next}"] button`)) b.classList.toggle('on', b.dataset.sub === sub[next]);
    for (const el of section?.querySelectorAll('[data-sub-only]') || []) el.hidden = !el.dataset.subOnly.split(' ').includes(sub[next]);
    panel.hidden = !section;
    active = custom?.() || null;
    active?.enter?.(sub[next]);
    if (section) requestAnimationFrame(app.placeWells);
    if (next === 'signature') app.signatures.loadSignatures();
    app.scheduleInk();
  }
  for (const b of buttons) b.onclick = () => setTool(tool === b.dataset.tool && tool !== 'none' ? 'none' : b.dataset.tool);
  for (const b of panel.querySelectorAll('.variants button')) b.onclick = () => setTool(b.closest('.variants').dataset.group, b.dataset.sub);

  // ---------- Editoren aus Daten (Formen, Linien, Stempel): wie Einfügen in PDF.js, mit Rückgängig ----------
  /** Neuer Editor aus `data` auf Seite `pageNumber`; `replace`: ersetzt diesen Editor (ein Schritt fürs Rückgängig). */
  async function addEditor(pageNumber, data, { replace = null } = {}) {
    const view = viewer.getPageView(pageNumber - 1);
    const layer = view?.annotationEditorLayer?.annotationEditorLayer;
    if (!layer) return null;
    // Drehung der Seite (/Rotate): PDF.js rechnet die Punkte damit in die Ansicht um
    const editor = await layer.deserialize({ pageIndex: pageNumber - 1, rotation: view.viewport.rotation, structTreeParentId: null, ...data });
    if (!editor) return null;
    editor._uiManager.addCommands({
      cmd: () => { replace?.remove(); layer.addOrRebuild(editor); },
      undo: () => { editor.remove(); if (replace) layer.addOrRebuild(replace); },
      mustExec: true,
    });
    return editor;
  }
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  /** Linienzüge (PDF-Punkte, je [x0,y0,x1,y1,…]) als Zeichnung von PDF.js – verschieben, umfärben, löschen wie mit dem Stift. */
  function addInk(pageNumber, lines, { color = inkColor, thickness = inkThickness, opacity = inkOpacity } = {}) {
    const xs = lines.flatMap((l) => l.filter((_, i) => i % 2 === 0)), ys = lines.flatMap((l) => l.filter((_, i) => i % 2 === 1));
    const pad = thickness;
    return addEditor(pageNumber, {
      annotationType: T.INK, color: rgb(color), thickness, opacity,
      paths: { points: lines.map((l) => Float32Array.from(l)) }, boxes: null,
      rect: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad],
    });
  }
  app.addEditor = addEditor;
  app.addInk = addInk;

  // ---------- Formen: aufziehen auf der Seite (Zeichnen-Modus von PDF.js bleibt an, damit sie sich gleich anpassen lassen) ----------
  let inkColor = PEN_COLORS[0], inkThickness = 2, inkOpacity = 1;
  function shapes(kind) {
    let drag = null;
    const geometry = (a, b, square) => {
      let [x0, y0] = a, [x1, y1] = b;
      if (square) {
        const dx = x1 - x0, dy = y1 - y0;
        if (kind === 'line' || kind === 'arrow') {
          // auf 45°-Schritte einrasten
          const len = Math.hypot(dx, dy), angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
          x1 = x0 + Math.cos(angle) * len; y1 = y0 + Math.sin(angle) * len;
        } else {
          const s = Math.max(Math.abs(dx), Math.abs(dy));
          x1 = x0 + Math.sign(dx || 1) * s; y1 = y0 + Math.sign(dy || 1) * s;
        }
      }
      if (kind === 'rect') return [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
      if (kind === 'ellipse') {
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2, pts = [];
        for (let i = 0; i <= 72; i++) { const t = i / 72 * Math.PI * 2; pts.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t)); }
        return [pts];
      }
      if (kind === 'line') return [[x0, y0, x1, y1]];
      // Pfeil: Spitze am Ende, Schenkel ~ 4× Strichstärke
      const angle = Math.atan2(y1 - y0, x1 - x0), head = Math.max(8, inkThickness * 4), spread = Math.PI / 7;
      return [[x0, y0, x1, y1],
        [x1, y1, x1 - head * Math.cos(angle - spread), y1 - head * Math.sin(angle - spread)],
        [x1, y1, x1 - head * Math.cos(angle + spread), y1 - head * Math.sin(angle + spread)]];
    };
    const preview = (layer, lines, g) => {
      let svg = layer.querySelector('svg.shape-preview');
      if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('shape-preview');
        layer.append(svg);
      }
      const vp = g.viewport;
      svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
      svg.innerHTML = lines.map((l) => {
        const pts = [];
        for (let i = 0; i < l.length; i += 2) pts.push(vp.convertToViewportPoint(l[i], l[i + 1]).join(','));
        return `<polyline points="${pts.join(' ')}"/>`;
      }).join('');
      svg.style.setProperty('--stroke', inkColor);
      svg.style.setProperty('--width', inkThickness * vp.scale);
      svg.style.opacity = inkOpacity;
    };
    const down = (e) => {
      if (e.button !== 0) return;
      const pageDiv = e.target.closest?.('#viewer .page');
      // Auf eine vorhandene Zeichnung geklickt: PDF.js wählt sie aus (verschieben, Größe, Farbe)
      if (!pageDiv || e.target.closest('.inkEditor, .editToolbar')) return;
      e.preventDefault();
      e.stopPropagation();
      const n = +pageDiv.dataset.pageNumber, g = app.pageGeometry(n);
      drag = { n, g, start: g.eventToPdf(e), layer: app.glassLayer(n), id: e.pointerId };
      pageDiv.setPointerCapture?.(e.pointerId);
    };
    const move = (e) => {
      if (!drag) return;
      e.stopPropagation();
      drag.lines = geometry(drag.start, drag.g.eventToPdf(e), e.shiftKey);
      preview(drag.layer, drag.lines, drag.g);
    };
    const up = async (e) => {
      if (!drag) return;
      e.stopPropagation();
      const { n, lines, layer } = drag;
      drag = null;
      layer.querySelector('svg.shape-preview')?.remove();
      // Nur geklickt, nicht gezogen: nichts anlegen
      if (!lines) return;
      const xs = lines.flat().filter((_, i) => i % 2 === 0), ys = lines.flat().filter((_, i) => i % 2 === 1);
      if (Math.max(...xs) - Math.min(...xs) < 3 && Math.max(...ys) - Math.min(...ys) < 3) return;
      await addInk(n, lines);
    };
    const opts = { capture: true };
    return {
      enter() {
        app.container.addEventListener('pointerdown', down, opts);
        app.container.addEventListener('pointermove', move, opts);
        app.container.addEventListener('pointerup', up, opts);
        document.body.classList.add('shaping');
      },
      leave() {
        app.container.removeEventListener('pointerdown', down, opts);
        app.container.removeEventListener('pointermove', move, opts);
        app.container.removeEventListener('pointerup', up, opts);
        document.body.classList.remove('shaping');
      },
    };
  }

  // ---------- Unterstreichen, Durchstreichen: Text auswählen, beim Loslassen wird die Linie gesetzt ----------
  let lineColor = LINE_COLORS[0];
  function markLines(kind) {
    const up = () => setTimeout(async () => {
      const selection = getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!range.commonAncestorContainer.parentElement?.closest('#viewer')) return;
      // Ein Rechteck pro Zeile (die Textebene liefert oft mehrere pro Wort)
      const lines = [];
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        const same = lines.find((l) => Math.abs(l.top - r.top) < r.height * .5 && Math.abs(l.bottom - r.bottom) < r.height * .5);
        if (same) { same.left = Math.min(same.left, r.left); same.right = Math.max(same.right, r.right); }
        else lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      }
      const byPage = new Map();
      for (const l of lines) {
        const at = document.elementsFromPoint((l.left + l.right) / 2, (l.top + l.bottom) / 2).find((el) => el.matches?.('#viewer .page'));
        if (!at) continue;
        const n = +at.dataset.pageNumber, g = app.pageGeometry(n);
        const y = kind === 'underline' ? l.bottom - (l.bottom - l.top) * .06 : l.top + (l.bottom - l.top) * .56;
        const [x0, py] = g.eventToPdf({ clientX: l.left, clientY: y });
        const [x1] = g.eventToPdf({ clientX: l.right, clientY: y });
        const [, top] = g.eventToPdf({ clientX: l.left, clientY: l.top }), [, bottom] = g.eventToPdf({ clientX: l.left, clientY: l.bottom });
        const height = Math.abs(top - bottom);
        if (!byPage.has(n)) byPage.set(n, { lines: [], height });
        byPage.get(n).lines.push([x0, py, x1, py]);
      }
      selection.removeAllRanges();
      for (const [n, { lines: segs, height }] of byPage) {
        await addInk(n, segs, { color: lineColor, thickness: Math.min(3, Math.max(.8, height * .08)), opacity: 1 });
      }
    }, 0);
    return {
      enter() { app.container.addEventListener('pointerup', up); document.body.classList.add('marking'); },
      leave() { app.container.removeEventListener('pointerup', up); document.body.classList.remove('marking'); },
    };
  }

  // ---------- Bild und Stempel: Glass setzt sie selbst, damit sie sich drehen lassen ----------
  // PDF.js kann Bilder nicht frei drehen. Glass merkt sich darum die Quelle (Stempeltext oder Bild) und zeichnet beim
  // Drehen das Bild gedreht neu; ein neuer Bild-Editor ersetzt den alten (ein Schritt fürs Rückgängig).
  const rotatable = new Map(); // Editor-ID → { editor, n, source, w0, h0, angle } – w0/h0: ungedrehte Größe in PDF-Punkten
  const author = () => $('note-author').value.trim();
  const today = () => new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  /** Stempel als Bild (dreifache Auflösung, damit er beim Zoomen scharf bleibt); Größe in PDF-Punkten. */
  function stampImage(text, color, second) {
    const scale = 3, lines = [text.toUpperCase(), ...(second ? [second] : [])];
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `700 ${20 * scale}px "Segoe UI", system-ui, sans-serif`;
    const w1 = ctx.measureText(lines[0]).width;
    ctx.font = `500 ${9 * scale}px "Segoe UI", system-ui, sans-serif`;
    const w2 = lines[1] ? ctx.measureText(lines[1]).width : 0;
    const width = Math.ceil(Math.max(w1, w2) + 28 * scale), height = Math.ceil((lines[1] ? 50 : 36) * scale);
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    const c = canvas.getContext('2d');
    c.strokeStyle = c.fillStyle = color;
    c.lineWidth = 2.2 * scale;
    c.beginPath();
    c.roundRect(c.lineWidth, c.lineWidth, width - 2 * c.lineWidth, height - 2 * c.lineWidth, 7 * scale);
    c.globalAlpha = .08; c.fill(); c.globalAlpha = 1; c.stroke();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `700 ${20 * scale}px "Segoe UI", system-ui, sans-serif`;
    c.fillText(lines[0], width / 2, (lines[1] ? 20 : 18.5) * scale);
    if (lines[1]) {
      c.font = `500 ${9 * scale}px "Segoe UI", system-ui, sans-serif`;
      c.fillText(lines[1], width / 2, 38 * scale);
    }
    return { canvas, width: width / scale, height: height / scale };
  }
  /** Die ungedrehte Vorlage als Canvas: Stempel neu zeichnen, Bild (Datei oder Kopie) laden. */
  async function sourceCanvas(source) {
    if (source.kind === 'stamp') return stampImage(source.text, source.color, source.second).canvas;
    const bitmap = await createImageBitmap(source.blob);
    // Sehr große Fotos auf eine handliche Auflösung begrenzen
    const k = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * k), height: Math.round(bitmap.height * k) });
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
  /** Canvas um `angle` Grad (im Uhrzeigersinn, wie auf dem Bildschirm) gedreht, mit passendem Rahmen. */
  function rotateCanvas(canvas, angle) {
    const a = angle * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const out = Object.assign(document.createElement('canvas'), {
      width: Math.ceil(canvas.width * c + canvas.height * s), height: Math.ceil(canvas.width * s + canvas.height * c),
    });
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(a);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return out;
  }
  /** Setzt Bild oder Stempel `source` mit Mitte `[x, y]` (PDF-Punkte), Größe w0×h0 und Drehung auf Seite `n`. */
  async function placeImage(n, [x, y], source, w0, h0, angle = 0, replace = null) {
    const base = await sourceCanvas(source);
    const image = angle ? rotateCanvas(base, angle) : base;
    const a = angle * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const w = w0 * c + h0 * s, h = w0 * s + h0 * c;
    const blob = await new Promise((done) => image.toBlob(done));
    await setMode(T.STAMP);
    const editor = await addEditor(n, {
      annotationType: T.STAMP, bitmapUrl: URL.createObjectURL(blob), isSvg: false,
      rect: [x - w / 2, y - h / 2, x + w / 2, y + h / 2],
      accessibilityData: { decorative: false, altText: source.kind === 'stamp' ? `Stempel: ${source.text}` : 'Bild' },
    }, { replace });
    if (!editor) { app.toast('Die Seite ist noch nicht bereit – bitte noch einmal.'); return null; }
    rotatable.set(editor.id, { editor, n, source, w0, h0, angle });
    // Gleich ausgewählt, damit Verschieben, Größe und Drehgriff bereitstehen
    requestAnimationFrame(() => { editor._uiManager.setSelected?.(editor); syncHandles(); });
    return editor;
  }
  /** Mitte des sichtbaren Teils der aktuellen Seite in PDF-Punkten. */
  function visibleCenter(n) {
    const r = viewer.getPageView(n - 1).div.getBoundingClientRect(), box = app.container.getBoundingClientRect();
    const cx = (Math.max(r.left, box.left) + Math.min(r.right, box.right)) / 2, cy = (Math.max(r.top, box.top) + Math.min(r.bottom, box.bottom)) / 2;
    return app.pageGeometry(n).eventToPdf({ clientX: cx, clientY: cy });
  }
  async function placeStamp(text, color, withDate) {
    const source = { kind: 'stamp', text, color, second: withDate ? [author(), today()].filter(Boolean).join(' · ') : '' };
    const { width, height } = stampImage(text, color, source.second);
    const n = viewer.currentPageNumber;
    return placeImage(n, visibleCenter(n), source, width, height);
  }
  async function placePicture(file) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) { app.toast('Dieses Bild lässt sich nicht lesen.'); return null; }
    const n = viewer.currentPageNumber;
    const [pw, ph] = viewer.getPageView(n - 1).viewport.rawDims ? [viewer.getPageView(n - 1).viewport.rawDims.pageWidth, viewer.getPageView(n - 1).viewport.rawDims.pageHeight] : [612, 792];
    // 96 dpi → Punkte, höchstens knapp die halbe Seite
    let w = bitmap.width * .75, h = bitmap.height * .75;
    const k = Math.min(1, pw * .45 / w, ph * .45 / h);
    w *= k; h *= k;
    return placeImage(n, visibleCenter(n), { kind: 'image', blob: file }, w, h);
  }

  const imageInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', hidden: true });
  document.body.append(imageInput);
  $('pick-image').onclick = () => { imageInput.value = ''; imageInput.click(); };
  imageInput.addEventListener('change', () => { if (imageInput.files[0]) placePicture(imageInput.files[0]); });
  const STAMPS = [
    ['Genehmigt', '#1e8a4c'], ['Geprüft', '#1f5fd6'], ['Erledigt', '#1e8a4c'],
    ['Entwurf', '#5e5ce6'], ['Vertraulich', '#d62f2f'], ['Abgelehnt', '#d62f2f'],
  ];
  for (const [text, color] of STAMPS) {
    const b = Object.assign(document.createElement('button'), { className: 'stamp', textContent: text, title: `„${text}“ einsetzen` });
    b.style.setProperty('--stamp', color);
    b.onclick = () => placeStamp(text, color, $('stamp-date').checked);
    $('stamps').append(b);
  }
  $('stamp-custom').onclick = () => {
    const text = $('stamp-text').value.trim();
    if (!text) { $('stamp-text').focus(); return; }
    placeStamp(text, inkColor === '#ffffff' || inkColor === '#000000' ? '#d62f2f' : inkColor, $('stamp-date').checked);
  };
  app.placeStamp = placeStamp;
  app.placePicture = placePicture;

  // ---------- Drehgriff über dem ausgewählten Bild oder Stempel ----------
  const snap = (deg, coarse) => {
    if (coarse) return Math.round(deg / 15) * 15;
    // in die Waagerechte/Senkrechte einrasten
    const right = Math.round(deg / 90) * 90;
    return Math.abs(deg - right) < 4 ? right : deg;
  };
  function syncHandles() {
    // „Auswahl löschen“ nach der tatsächlichen Auswahl – PDF.js meldet sie nicht in jedem Fall per Ereignis
    $('delete-selected').hidden = !document.querySelector('#viewer .selectedEditor');
    for (const h of document.querySelectorAll('#viewer .rotate-handle')) if (!h.parentElement?.classList.contains('selectedEditor')) h.remove();
    const el = document.querySelector('#viewer .stampEditor.selectedEditor');
    if (!el || el.querySelector(':scope > .rotate-handle')) return;
    const handle = document.createElement('div');
    handle.className = 'rotate-handle';
    handle.title = 'Drehen (Umschalt: in 15°-Schritten)';
    handle.innerHTML = '<svg viewBox="0 0 16 16"><use href="#i-rotate-right"/></svg>';
    handle.addEventListener('pointerdown', (e) => rotate(e, el, handle));
    el.append(handle);
  }
  /** Ein Bild-Editor, den Glass nicht selbst gesetzt hat (etwa nach dem Speichern neu geladen): sein Bild als Vorlage. */
  async function adopt(el, r = el.getBoundingClientRect()) {
    const canvas = el.querySelector('canvas');
    const editor = [...rotatable.values()].find((i) => i.editor.div === el)?.editor;
    if (editor) return rotatable.get(editor.id);
    if (!canvas) return null;
    const n = +el.closest('.page').dataset.pageNumber, g = app.pageGeometry(n);
    const [x1, y1] = g.eventToPdf({ clientX: r.left, clientY: r.top }), [x2, y2] = g.eventToPdf({ clientX: r.right, clientY: r.bottom });
    const blob = await new Promise((done) => canvas.toBlob(done));
    // Den Editor selbst führt der uiManager von PDF.js nach seiner ID (= ID des Elements)
    const found = uiManager?.getEditor(el.id);
    if (!found) return null;
    const info = { editor: found, n, source: { kind: 'image', blob }, w0: Math.abs(x2 - x1), h0: Math.abs(y2 - y1), angle: 0 };
    rotatable.set(found.id, info);
    return info;
  }
  function rotate(e, el, handle) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const start = Math.atan2(e.clientY - cy, e.clientX - cx);
    const info = rotatable.get(el.id) || null;
    const from = info?.angle || 0;
    let delta = 0;
    handle.setPointerCapture(e.pointerId);
    el.classList.add('rotating');
    handle.onpointermove = (ev) => {
      ev.stopPropagation();
      const raw = from + (Math.atan2(ev.clientY - cy, ev.clientX - cx) - start) * 180 / Math.PI;
      delta = snap(raw, ev.shiftKey) - from;
      el.style.rotate = `${delta}deg`;
    };
    // Vorschau bleibt stehen, bis das gedreht neu gezeichnete Bild den Editor ersetzt hat (kein Zurückspringen)
    const reset = () => { el.classList.remove('rotating'); el.style.rotate = ''; };
    handle.onpointerup = async (ev) => {
      ev.stopPropagation();
      handle.onpointermove = handle.onpointerup = null;
      if (Math.abs(delta) < .5) { reset(); return; }
      try { await commit(); } finally { reset(); }
    };
    const commit = async () => {
      const current = rotatable.get(el.id) || (await adopt(el, r));
      if (!current) { app.toast('Dieses Bild lässt sich nicht drehen.'); return; }
      // Mitte und Maßstab aus der jetzigen Lage – das Bild kann inzwischen verschoben oder skaliert sein
      const g = app.pageGeometry(current.n);
      const [x, y] = g.eventToPdf({ clientX: cx, clientY: cy });
      const [ax, ay] = g.eventToPdf({ clientX: r.left, clientY: cy }), [bx, by] = g.eventToPdf({ clientX: r.right, clientY: cy });
      const a = current.angle * Math.PI / 180;
      const expected = current.w0 * Math.abs(Math.cos(a)) + current.h0 * Math.abs(Math.sin(a));
      const scale = Math.hypot(bx - ax, by - ay) / expected || 1;
      const angle = ((current.angle + delta) % 360 + 360) % 360;
      await placeImage(current.n, [x, y], current.source, current.w0 * scale, current.h0 * scale, angle, current.editor);
    };
  }
  // Absender der Zustandsmeldung ist der uiManager von PDF.js (für getEditor in adopt)
  let uiManager = null;
  eventBus.on('annotationeditorstateschanged', ({ source, details }) => {
    uiManager = source || uiManager;
    requestAnimationFrame(syncHandles);
    // Stempel oder Bild abgewählt: zurück in den Auswahlmodus, sonst öffnete ein Klick auf die Seite den Bildauswahldialog
    if (tool === 'stamp' && details.hasSelectedEditor === false && viewer.annotationEditorMode === T.STAMP) setMode(T.NONE);
  });
  document.addEventListener('pointerup', () => requestAnimationFrame(syncHandles));

  // Löschen ohne die kleine Leiste von PDF.js: Knopf in den Einstellungen, sobald etwas ausgewählt ist (syncHandles)
  $('delete-selected').onclick = () => {
    eventBus.dispatch('editingaction', { source: null, name: 'delete' });
    requestAnimationFrame(syncHandles);
  };
  document.addEventListener('keyup', () => requestAnimationFrame(syncHandles));

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
  swatches('line', LINE_COLORS, (c) => { lineColor = c; }, LINE_COLORS[0]);
  swatches('freetext', PEN_COLORS.slice(0, 5), (c) => param(P.FREETEXT_COLOR, c), PEN_COLORS[0]);
  swatches('ink', PEN_COLORS, (c) => { inkColor = c; param(P.INK_COLOR, c); }, PEN_COLORS[0]);
  swatches('note', NOTE_COLORS, (c) => { app.notes.color = c; }, NOTE_COLORS[0]);
  const sliders = {
    'highlight-thickness': [P.HIGHLIGHT_THICKNESS, (v) => v, (v) => v],
    'freetext-size': [P.FREETEXT_SIZE, (v) => v, (v) => v],
    'ink-thickness': [P.INK_THICKNESS, (v) => { inkThickness = v; return v; }, (v) => v],
    'ink-opacity': [P.INK_OPACITY, (v) => { inkOpacity = v / 100; return v / 100; }, (v) => `${v} %`],
  };
  for (const input of panel.querySelectorAll('input[type=range][data-param]')) {
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
  // Seitenänderungen (Drehen, Wasserzeichen, Schwärzen …) haben einen eigenen Verlauf; der jüngere Schritt gewinnt.
  // Wiederholen nimmt in umgekehrter Reihenfolge zurück, was Rückgängig gemacht hat: 'change' (Dokument) oder 'editor'
  const undo = $('undo'), redo = $('redo');
  let canUndo = false, canRedo = false, lastEdit = 0, lastChange = 0;
  const redoOrder = [];
  const show = () => {
    undo.disabled = !(canUndo || app.edited || app.canUndoChange);
    redo.disabled = !(canRedo || app.canRedoChange || redoOrder.length);
  };
  eventBus.on('annotationeditorstateschanged', ({ details }) => {
    if (details.isEditing) {
      canUndo = !!details.hasSomethingToUndo;
      canRedo = !!details.hasSomethingToRedo;
    }
    show();
  });
  addEventListener('glass-edited', () => { lastEdit = performance.now(); show(); });
  addEventListener('glass-history', (e) => {
    lastChange = performance.now();
    // Neue Dokument-Änderung: nichts mehr zu wiederholen (auch PDF.js hat seinen Verlauf mit dem Neuladen verloren)
    if (e.detail === 'new') { redoOrder.length = 0; canRedo = false; }
    show();
  });
  /** Ist der jüngste Schritt eine Dokument-Änderung (Formularfeld, Seiten, Wasserzeichen …)? */
  const changeIsNewest = () => app.canUndoChange && (lastChange > lastEdit || !(canUndo || app.edited));
  const undoStep = async () => {
    if (changeIsNewest()) {
      if (await app.undoChange()) redoOrder.push('change');
    } else {
      eventBus.dispatch('editingaction', { source: null, name: 'undo' });
      redoOrder.push('editor');
      canRedo = true;
    }
    show();
  };
  const redoStep = async () => {
    const kind = redoOrder.pop() || (app.canRedoChange ? 'change' : 'editor');
    if (kind === 'change') await app.redoChange();
    else eventBus.dispatch('editingaction', { source: null, name: 'redo' });
    show();
  };
  undo.onclick = undoStep;
  redo.onclick = redoStep;
  app.undoStep = undoStep;
  app.redoStep = redoStep;

  // Tastenkürzel wie in Acrobat – nur wenn gerade nicht getippt wird
  const KEYS = { e: 'textedit', h: 'markup', n: 'note', t: 'freetext', d: 'draw', b: 'stamp', s: 'signature', f: 'field', r: 'redact' };
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable], .dialog, #organize')) return;
    const key = KEYS[e.key.toLowerCase()];
    if (key) { e.preventDefault(); setTool(key); }
    // Esc: erst PDF.js die Auswahl aufheben lassen, danach zurück zum Auswählen
    else if (e.key === 'Escape' && tool !== 'none' && !document.querySelector('.selectedEditor, .glass-layer .selected')) setTool('none');
  });
  // Strg+Z / Strg+Y (oder Strg+Umschalt+Z): ohne Werkzeug immer über den gemeinsamen Verlauf; mit Werkzeug macht
  // PDF.js seine Anmerkungen selbst – nur Dokument-Änderungen übernimmt Glass dann (vor PDF.js, daher capture)
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, [contenteditable], .dialog, #organize')) return;
    const key = e.key.toLowerCase();
    const isUndo = key === 'z' && !e.shiftKey, isRedo = key === 'y' || (key === 'z' && e.shiftKey);
    if (!isUndo && !isRedo) return;
    const editing = viewer.annotationEditorMode !== T.NONE;
    const mine = !editing || (isUndo ? changeIsNewest() : redoOrder.at(-1) === 'change' || (!canRedo && app.canRedoChange));
    if (!mine) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (isUndo) undoStep(); else redoStep();
  }, true);

  return { setTool, setMode, get tool() { return tool; }, get variant() { return sub[tool]; } };
}
