// Schwärzen wie in Acrobat: Bereiche markieren (aufziehen oder Text auswählen), dann „Anwenden“ – der Text darunter
// wird aus dem Content-Stream entfernt (nicht nur überdeckt), Anmerkungen dort ebenso. Liegt ein Bild oder ein
// eingebettetes Objekt darunter, wird die ganze Seite sicherheitshalber als Bild neu geschrieben.
import { readPage, removeGlyphs, saveContent, intersects } from './content.mjs';

const $ = (id) => document.getElementById(id);

/** Schwärzt `marks` ({ page (1-basiert), rect [x1,y1,x2,y2] }) in `bytes`; `render(pageIndex)` liefert ein Bild der Seite. */
export async function redactBytes(lib, bytes, marks, render) {
  const { PDFDocument } = lib;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const byPage = new Map();
  for (const m of marks) {
    const rect = [Math.min(m.rect[0], m.rect[2]), Math.min(m.rect[1], m.rect[3]), Math.max(m.rect[0], m.rect[2]), Math.max(m.rect[1], m.rect[3])];
    if (!byPage.has(m.page - 1)) byPage.set(m.page - 1, []);
    byPage.get(m.page - 1).push(rect);
  }
  const rasterized = [];
  for (const [index, rects] of byPage) {
    const content = await readPage(lib, pdf, index);
    // Bild oder Formular-Objekt unter einem Balken: dessen Inhalt kann hier nicht gezielt entfernt werden
    if (content.objects.some((o) => rects.some((r) => intersects(o.quad, r)))) {
      rasterized.push([index, rects]);
      continue;
    }
    removeGlyphs(content, content.glyphs.filter((g) => rects.some((r) => intersects(g.quad, r, .2))));
    const boxes = rects.map(([x1, y1, x2, y2]) => `${x1} ${y1} ${x2 - x1} ${y2 - y1} re`).join('\n');
    saveContent(lib, pdf, content, `0 0 0 rg\n${boxes}\nf`);
    dropAnnotations(lib, pdf, content.node, rects);
  }
  for (const [index, rects] of rasterized) {
    const old = pdf.getPage(index);
    const box = old.getMediaBox(), rotation = old.getRotation().angle;
    const image = await render(index, rects);
    const embedded = await pdf.embedPng(image);
    const page = pdf.insertPage(index, [box.width, box.height]);
    page.setMediaBox(box.x, box.y, box.width, box.height);
    page.drawImage(embedded, { x: box.x, y: box.y, width: box.width, height: box.height });
    page.setRotation(lib.degrees(rotation));
    pdf.removePage(index + 1);
  }
  return { bytes: await pdf.save({ updateFieldAppearances: false }), rasterized: rasterized.map(([i]) => i + 1) };
}

/** Anmerkungen (auch Links und Formularfelder), die einen Balken berühren, verschwinden mit. */
function dropAnnotations(lib, pdf, node, rects) {
  const { PDFName, PDFArray } = lib;
  const annots = node.lookup(PDFName.of('Annots'));
  if (!(annots instanceof PDFArray)) return;
  const keep = annots.asArray().filter((ref) => {
    const rect = pdf.context.lookup(pdf.context.lookup(ref)?.get?.(PDFName.of('Rect')));
    if (!(rect instanceof PDFArray)) return true;
    const [x1, y1, x2, y2] = rect.asArray().map((n) => n.asNumber());
    const quad = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    return !rects.some((r) => intersects(quad, r));
  });
  node.set(PDFName.of('Annots'), pdf.context.obj(keep));
}

export function initRedact(app) {
  let marks = []; // { id, page, rect }
  let active = false, drag = null, seq = 0;
  const count = $('redact-count'), applyButton = $('redact-apply'), clearButton = $('redact-clear');

  function update() {
    const n = marks.length;
    count.textContent = n ? `${n} ${n === 1 ? 'Bereich' : 'Bereiche'} markiert` : 'Noch nichts markiert';
    applyButton.disabled = clearButton.disabled = !n;
  }
  function render(n, layer) {
    for (const el of layer.querySelectorAll('.redact-mark')) el.remove();
    const g = app.pageGeometry(n);
    for (const m of marks.filter((x) => x.page === n)) {
      const el = document.createElement('div');
      el.className = 'redact-mark';
      Object.assign(el.style, g.rectStyle(m.rect));
      const x = Object.assign(document.createElement('button'), { className: 'remove', title: 'Markierung entfernen' });
      x.innerHTML = '<svg><use href="#i-close"/></svg>';
      x.onpointerdown = (e) => e.stopPropagation();
      x.onclick = () => { marks = marks.filter((o) => o !== m); app.refreshLayers(n); update(); };
      el.append(x);
      layer.append(el);
    }
  }
  const add = (page, rect) => { marks.push({ id: ++seq, page, rect }); app.refreshLayers(page); update(); };

  // Aufziehen auf freier Fläche; auf Text: normal auswählen, beim Loslassen wird daraus eine Markierung
  const down = (e) => {
    if (!active || e.button !== 0) return;
    const pageDiv = e.target.closest?.('#viewer .page');
    if (!pageDiv || e.target.closest('.redact-mark, .note-pin, .note-card')) return;
    if (e.target.closest('.textLayer span, .textLayer br')) return; // Textauswahl
    e.preventDefault();
    e.stopPropagation();
    const n = +pageDiv.dataset.pageNumber, g = app.pageGeometry(n);
    const layer = app.glassLayer(n);
    const box = Object.assign(document.createElement('div'), { className: 'redact-mark drawing' });
    layer.append(box);
    drag = { n, g, start: g.eventToPdf(e), box };
  };
  const move = (e) => {
    if (!drag) return;
    const [x, y] = drag.g.eventToPdf(e);
    drag.rect = [drag.start[0], drag.start[1], x, y];
    Object.assign(drag.box.style, drag.g.rectStyle(drag.rect));
  };
  const up = () => {
    if (drag) {
      const { n, rect, box } = drag;
      drag = null;
      box.remove();
      if (rect && Math.abs(rect[2] - rect[0]) > 2 && Math.abs(rect[3] - rect[1]) > 2) add(n, rect);
      return;
    }
    if (!active) return;
    setTimeout(() => {
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      for (const r of sel.getRangeAt(0).getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        const at = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).find((el) => el.matches?.('#viewer .page'));
        if (!at) continue;
        const n = +at.dataset.pageNumber, g = app.pageGeometry(n);
        const [x1, y1] = g.eventToPdf({ clientX: r.left, clientY: r.bottom });
        const [x2, y2] = g.eventToPdf({ clientX: r.right, clientY: r.top });
        marks.push({ id: ++seq, page: n, rect: [x1 - .5, y1 - .5, x2 + .5, y2 + .5] });
      }
      sel.removeAllRanges();
      app.refreshLayers();
      update();
    }, 0);
  };

  // Seite als Bild (200 dpi, mit Anmerkungen) mit schwarzen Balken – für Seiten mit Bildern unter einem Balken
  const renderPage = (bytes) => (index, rects) => app.withDocument(bytes, async (doc) => {
    const page = await doc.getPage(index + 1);
    const viewport = page.getViewport({ scale: 200 / 72, rotation: 0 });
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport, annotationMode: app.pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;
    ctx.fillStyle = '#000';
    for (const r of rects) {
      const [a, b] = viewport.convertToViewportPoint(r[0], r[1]), [c, d] = viewport.convertToViewportPoint(r[2], r[3]);
      ctx.fillRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
    }
    const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  });

  applyButton.onclick = async () => {
    if (!marks.length) return;
    const todo = marks.slice();
    let rasterized = [];
    const ok = await app.applyChange(`${todo.length === 1 ? 'Bereich' : `${todo.length} Bereiche`} geschwärzt`, async (bytes, lib) => {
      const result = await redactBytes(lib, bytes, todo, renderPage(bytes));
      rasterized = result.rasterized;
      return result.bytes;
    });
    if (ok) {
      marks = [];
      update();
      app.refreshLayers();
      if (rasterized.length) {
        app.toast(`Seite ${rasterized.join(', ')} enthielt Bilder unter einem Balken und wurde als Bild gespeichert.`);
      }
    }
  };
  clearButton.onclick = () => { marks = []; app.refreshLayers(); update(); };

  app.layerRenderers.push(render);
  // Seiten neu zusammengesetzt (Organisieren, Rückgängig …): Markierungen gehörten zur alten Fassung
  app.onDocument(() => { marks = []; update(); });
  update();

  return {
    get marks() { return marks; },
    add,
    enter() {
      active = true;
      document.body.classList.add('redacting');
      app.container.addEventListener('pointerdown', down, true);
      addEventListener('pointermove', move, true);
      addEventListener('pointerup', up, true);
    },
    leave() {
      active = false;
      drag?.box.remove();
      drag = null;
      document.body.classList.remove('redacting');
      app.container.removeEventListener('pointerdown', down, true);
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
    },
  };
}
