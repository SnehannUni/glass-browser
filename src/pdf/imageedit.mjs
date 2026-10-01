// Bilder, die schon im PDF stehen, bearbeiten (Werkzeug „Text und Bilder bearbeiten“): anklicken, verschieben, an
// einer Ecke größer oder kleiner ziehen, ersetzen oder löschen. Geändert wird der Content-Stream selbst: das Bild
// bekommt eine zusätzliche Matrix (cm), beim Ersetzen zeichnet derselbe Befehl ein neues Bild, beim Löschen
// verschwindet er – und mit ihm das Bild aus der Datei, wenn nichts anderes es braucht.
import { readPage, saveContent, quadBounds } from './content.mjs';
import { prepareImage, isImageFile } from './images.mjs';
import { dropUnused } from './compress.mjs';

const $ = (id) => document.getElementById(id);
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const inverse = ([a, b, c, d, e, f]) => {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};
const userError = (message) => Object.assign(new Error(message), { userMessage: message });
const near = (q1, q2, tolerance = 1) => q1.every((p, i) => Math.hypot(p[0] - q2[i][0], p[1] - q2[i][1]) < tolerance);

/** Liegt der Punkt im (konvexen) Viereck? */
function inQuad([x, y], quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i], [bx, by] = quad[(i + 1) % 4];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

/**
 * Ändert das Bild `target` (`{ op, quad }` aus readPage) auf Seite `index`:
 * `{ matrix }` – Abbildung in Seitenkoordinaten (verschieben, skalieren), `{ remove: true }` oder
 * `{ replace: image }` (aus prepareImage; passt sich ins bisherige Rechteck ein, Seitenverhältnis bleibt).
 */
export async function editImage(lib, bytes, index, target, edit) {
  const { PDFDocument, PDFName, PDFDict } = lib;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const content = await readPage(lib, pdf, index);
  const images = content.objects.filter((o) => o.kind === 'image');
  const obj = images.find((o) => o.op === target.op && near(o.quad, target.quad)) || images.find((o) => near(o.quad, target.quad));
  if (!obj) throw userError('Das Bild wurde auf der Seite nicht mehr gefunden.');
  const draw = content.ops[obj.op];
  const nums = (m) => m.map((v) => ({ t: 'num', v }));
  let replacement;
  if (edit.matrix) {
    // Neue CTM = alte · Abbildung; davor gesetzt (cm) heißt das: N · alte = alte · Abbildung
    const n = mul(mul(obj.ctm, edit.matrix), inverse(obj.ctm));
    replacement = [{ op: 'q', args: [] }, { op: 'cm', args: nums(n) }, draw, { op: 'Q', args: [] }];
  } else if (edit.replace) {
    const image = edit.replace;
    const embedded = image.kind === 'png' ? await pdf.embedPng(image.bytes) : await pdf.embedJpg(image.bytes);
    const name = content.node.newXObject('GlassImage', embedded.ref);
    // Ins bisherige Rechteck einpassen (in Bildkoordinaten, also auch für gedrehte Bilder)
    const [p0, p1, , p3] = obj.quad;
    const W = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), H = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    const ratio = image.width / image.height;
    let w = W, h = W / ratio;
    if (h > H) { h = H; w = H * ratio; }
    const sx = w / W, sy = h / H;
    replacement = [
      { op: 'q', args: [] }, { op: 'cm', args: nums([sx, 0, 0, sy, (1 - sx) / 2, (1 - sy) / 2]) },
      { op: 'Do', args: [{ t: 'name', v: name.toString().slice(1) }] }, { op: 'Q', args: [] },
    ];
  } else if (edit.remove) {
    replacement = [];
  } else {
    return null;
  }
  content.ops.splice(obj.op, 1, ...replacement);
  saveContent(lib, pdf, content);

  // Gelöscht und auf dieser Seite sonst nicht mehr benutzt: aus den Ressourcen, wenn die nur dieser Seite gehören –
  // dann ist das Bild auch wirklich aus der Datei
  if (edit.remove && obj.name && !content.ops.some((o) => o.op === 'Do' && o.args[0]?.v === obj.name)) {
    const resources = content.node.Resources();
    const xobjects = resources?.lookup(PDFName.of('XObject'));
    const shared = pdf.getPages().some((p) => p.node !== content.node && (p.node.Resources() === resources || p.node.Resources()?.lookup(PDFName.of('XObject')) === xobjects));
    if (xobjects instanceof PDFDict && !shared) {
      xobjects.delete(PDFName.of(obj.name));
      await pdf.flush();
      dropUnused(lib, pdf);
    }
  }
  return pdf.save({ updateFieldAppearances: false });
}

export function initImageEdit(app) {
  let active = false;
  let selected = null; // { page, op, quad, rect }
  let pending = null; // nach einer Änderung wieder auswählen: { page, rect }
  let drag = null;
  const lists = new Map(); // Seite → Promise der Bilder (für das aktuelle Dokument)
  const loaded = new Map(); // Seite → Bilder, sobald gelesen – der Zeiger fragt nur hier
  const actions = $('image-actions'), hint = $('edit-hint');
  const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', hidden: true });
  document.body.append(fileInput);

  function imagesOf(n) {
    if (!lists.has(n)) {
      const source = app.doc;
      lists.set(n, app.pageContent(n).then((c) => {
        const images = c.objects.filter((o) => o.kind === 'image').map((o) => ({ ...o, page: n, rect: quadBounds(o.quad) }));
        if (source === app.doc) loaded.set(n, images);
        return images;
      }).catch(() => []));
    }
    return lists.get(n);
  }
  app.onDocument(() => { lists.clear(); loaded.clear(); selected = null; showActions(); });

  function showActions() {
    actions.hidden = !selected;
    if (hint) hint.hidden = !!selected || !!app.textEdit?.isEditing;
    app.placeWells();
  }
  function select(image) {
    selected = image ? { page: image.page, op: image.op, quad: image.quad, rect: image.rect } : null;
    showActions();
    app.refreshLayers();
  }
  const isSelected = (image) => selected && selected.page === image.page && selected.op === image.op;

  // ---------- Rahmen auf der Seite ----------
  async function render(n, layer) {
    for (const el of layer.querySelectorAll('.image-box')) el.remove();
    // Nur gezeichnete Seiten lesen (nach dem Zeichnen kommt ohnehin pagerendered)
    if (!active || !layer.parentElement?.querySelector('.canvasWrapper canvas')) return;
    const images = await imagesOf(n);
    if (!active) return;
    for (const el of layer.querySelectorAll('.image-box')) el.remove();
    // Nach einer Änderung: das Bild an der erwarteten Stelle wieder auswählen
    if (pending?.page === n) {
      const center = (r) => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
      const [px, py] = center(pending.rect);
      const best = images.map((img) => [img, Math.hypot(center(img.rect)[0] - px, center(img.rect)[1] - py)]).sort((a, b) => a[1] - b[1])[0];
      pending = null;
      if (best && best[1] < 8) { selected = { page: n, op: best[0].op, quad: best[0].quad, rect: best[0].rect }; showActions(); }
    }
    const g = app.pageGeometry(n);
    for (const image of images) {
      const box = document.createElement('div');
      box.className = 'image-box';
      box.dataset.op = image.op;
      Object.assign(box.style, g.rectStyle(image.rect));
      if (isSelected(image)) {
        box.classList.add('selected');
        for (const corner of ['nw', 'ne', 'sw', 'se']) {
          const handle = Object.assign(document.createElement('span'), { className: `handle ${corner}` });
          handle.dataset.corner = corner;
          box.append(handle);
        }
      }
      layer.append(box);
    }
  }
  app.layerRenderers.push(render);

  /** Oberstes Bild unter dem Zeiger (zuletzt gezeichnet = oben) – nur aus schon gelesenen Seiten. */
  function hit(e) {
    const pageDiv = e.target.closest?.('#viewer .page');
    if (!pageDiv) return null;
    const n = +pageDiv.dataset.pageNumber, g = app.pageGeometry(n);
    const point = g.eventToPdf(e);
    return { n, g, point, image: loaded.get(n)?.findLast((img) => inQuad(point, img.quad)) || null };
  }
  const onText = (e) => {
    const span = e.target.closest?.('#viewer .textLayer span:not(.markedContent):not(:has(span))');
    return !!span?.textContent.trim();
  };

  // ---------- Zeiger: auswählen, verschieben, Größe ändern ----------
  const down = (e) => {
    if (!active || e.button !== 0 || app.textEdit?.isEditing) return;
    const handle = e.target.closest?.('.image-box.selected .handle');
    if (handle && selected) {
      e.preventDefault();
      e.stopPropagation();
      const g = app.pageGeometry(selected.page), r = selected.rect, start = g.eventToPdf(e);
      // Fest bleibt die gegenüberliegende Ecke – die am weitesten vom Griff (so auch auf gedrehten Seiten)
      const corners = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
      const anchor = corners.sort((a, b) => Math.hypot(b[0] - start[0], b[1] - start[1]) - Math.hypot(a[0] - start[0], a[1] - start[1]))[0];
      drag = { kind: 'resize', g, anchor, start, box: handle.parentElement, image: selected };
      return;
    }
    if (onText(e) || e.target.closest?.('.text-edit, .note-pin, .note-card')) return;
    const found = hit(e);
    if (!found) return;
    if (!found.image) { if (selected) select(null); return; }
    e.preventDefault();
    e.stopPropagation();
    select(found.image);
    const box = () => app.glassLayer(found.n)?.querySelector(`.image-box[data-op="${found.image.op}"]`);
    drag = { kind: 'move', g: found.g, start: found.point, box, image: selected };
  };
  const move = (e) => {
    if (drag) {
      const [x, y] = drag.g.eventToPdf(e);
      const r = drag.image.rect;
      let rect;
      if (drag.kind === 'move') {
        drag.delta = [x - drag.start[0], y - drag.start[1]];
        rect = [r[0] + drag.delta[0], r[1] + drag.delta[1], r[2] + drag.delta[0], r[3] + drag.delta[1]];
      } else {
        const [ax, ay] = drag.anchor;
        const w = r[2] - r[0], h = r[3] - r[1];
        // Seitenverhältnis bleibt: der größere der beiden Anteile zählt
        drag.scale = Math.max(4 / Math.min(w, h), Math.abs(x - ax) / w, Math.abs(y - ay) / h);
        const sw = w * drag.scale, sh = h * drag.scale;
        const left = ax === r[0] ? ax : ax - sw, bottom = ay === r[1] ? ay : ay - sh;
        rect = [left, bottom, left + sw, bottom + sh];
      }
      drag.rect = rect;
      const el = typeof drag.box === 'function' ? drag.box() : drag.box;
      if (el) Object.assign(el.style, drag.g.rectStyle(rect));
      return;
    }
    if (!active || e.buttons) return;
    // Zeiger über einem Bild: Rahmen zeigen
    const over = onText(e) ? null : hit(e)?.image;
    const box = over && app.glassLayer(over.page)?.querySelector(`.image-box[data-op="${over.op}"]`);
    for (const el of document.querySelectorAll('.image-box.hover')) if (el !== box) el.classList.remove('hover');
    box?.classList.add('hover');
    document.body.classList.toggle('over-image', !!over);
  };
  const up = () => {
    if (!drag) return;
    const { kind, image, rect, delta, scale, anchor } = drag;
    drag = null;
    if (!rect) return;
    if (kind === 'move' && Math.hypot(...delta) > .5) {
      change('Bild verschoben', image, { matrix: [1, 0, 0, 1, delta[0], delta[1]] }, rect);
    } else if (kind === 'resize' && Math.abs(scale - 1) > .005) {
      const [ax, ay] = anchor;
      change('Bildgröße geändert', image, { matrix: [scale, 0, 0, scale, ax - scale * ax, ay - scale * ay] }, rect);
    } else {
      app.refreshLayers(image.page);
    }
  };

  /** Änderung am Bild anwenden; danach ist es (an `rect`) wieder ausgewählt. */
  async function change(label, image, edit, rect = image.rect) {
    pending = edit.remove ? null : { page: image.page, rect };
    const ok = await app.applyChange(label, async (bytes, lib) => {
      try {
        return await editImage(lib, bytes, image.page - 1, image, edit);
      } catch (err) {
        if (err.userMessage) { app.toast(err.userMessage); return null; }
        throw err;
      }
    });
    if (!ok) { pending = null; app.refreshLayers(image.page); }
    return ok;
  }
  const remove = () => selected && change('Bild gelöscht', selected, { remove: true });
  async function replace(file) {
    if (!selected || !file) return;
    const image = selected;
    let prepared;
    try {
      prepared = await prepareImage(file);
    } catch (err) {
      app.toast(err.userMessage || 'Das Bild ließ sich nicht lesen.');
      return;
    }
    return change('Bild ersetzt', image, { replace: prepared });
  }
  $('image-delete').onclick = remove;
  $('image-replace').onclick = () => { fileInput.value = ''; fileInput.click(); };
  fileInput.addEventListener('change', () => replace(fileInput.files[0]));

  // Bilddatei auf ein ausgewähltes Bild ziehen: ersetzen
  const dragover = (e) => { if (active && selected && [...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault(); };
  const drop = (e) => {
    const file = [...e.dataTransfer.files].find(isImageFile);
    if (!active || !selected || !file) return;
    e.preventDefault();
    replace(file);
  };

  const keydown = (e) => {
    if (!active || !selected || e.target.closest?.('input, textarea, select, [contenteditable], .dialog')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
    if (e.key === 'Escape') { e.preventDefault(); select(null); }
  };

  return {
    editImage, imagesOf, replace, remove,
    get selected() { return selected; },
    /** Für Tests: Bild auswählen wie mit einem Klick. */
    async selectAt(n, index) { const images = await imagesOf(n); select(images[index] || null); return selected; },
    change: (label, edit) => selected && change(label, selected, edit),
    enter() {
      active = true;
      app.container.addEventListener('pointerdown', down, true);
      addEventListener('pointermove', move, true);
      addEventListener('pointerup', up, true);
      addEventListener('keydown', keydown);
      app.container.addEventListener('dragover', dragover);
      app.container.addEventListener('drop', drop);
      app.refreshLayers();
    },
    leave() {
      active = false;
      drag = null;
      selected = null;
      showActions();
      document.body.classList.remove('over-image');
      app.container.removeEventListener('pointerdown', down, true);
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      removeEventListener('keydown', keydown);
      app.container.removeEventListener('dragover', dragover);
      app.container.removeEventListener('drop', drop);
      app.refreshLayers();
    },
  };
}
