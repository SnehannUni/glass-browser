// PDF bearbeiten wie in Acrobat: Zeichnen, Text, Hervorheben, Unterschreiben, Seiten organisieren – und alles
// landet beim Speichern im PDF. Run after `cargo build`, using Node 22+ on Windows. No npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Kleines PDF mit `pages` Seiten; auf jeder steht groß `Seite n`. */
function makePdf(pages, label = 'Seite') {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let n = 1; n <= pages; n++) {
    const text = `BT /F1 40 Tf 72 680 Td (${label} ${n}) Tj ET`;
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objects.length} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

await mkdir('target/pdf-smoke', { recursive: true });
const profile = await mkdtemp(resolve('target/pdf-smoke/editor-'));
const extra = join(profile, 'Anhang.pdf');
const saveDir = join(profile, 'gespeichert');
await mkdir(saveDir);
await writeFile(extra, makePdf(2, 'Anhang'));
const pdf = makePdf(3);
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length });
  res.end(pdf);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const portProbe = createServer();
await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const port = portProbe.address().port;
await new Promise(r => portProbe.close(r));
const app = spawn(resolve('target/debug/glass-browser.exe'), [`${origin}/Vertrag.pdf`], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, GLASS_TEST_SAVE_DIR: saveDir },
});
const sockets = [];
const watchdog = setTimeout(() => { console.error('FAIL: watchdog'); app.kill(); process.exit(1); }, 120000);
async function waitFor(check, label, tries = 200) {
  for (let i = 0; i < tries; i++) { try { if (await check()) return; } catch { /* lädt noch */ } await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl); sockets.push(ws);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  let seq = 0; const pending = new Map(); const events = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data), p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } else if (m.method) events.push(m);
  };
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  Object.assign(evaluate, { call, events });
  return evaluate;
}

try {
  let target;
  await waitFor(async () => {
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.url.endsWith('/Vertrag.pdf'));
    return !!target;
  }, 'browser startup', 400); // WebView2 braucht nach einem vorigen Lauf manchmal länger
  const page = await connect(target);
  await page.call('Log.enable');
  await waitFor(() => page(`document.querySelectorAll('#viewer .page').length === 3 && document.getElementById('status').classList.contains('done')`), 'viewer rendered');

  const mouse = async (type, x, y, extra = {}) => page.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1, ...extra });
  const click = async (x, y) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); };
  const drag = async (points) => {
    await mouse('mousePressed', ...points[0]);
    for (const p of points.slice(1)) { await mouse('mouseMoved', ...p); await delay(10); }
    await mouse('mouseReleased', ...points.at(-1));
  };
  const rect = (selector) => page(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const pressButton = async (selector) => { const r = await rect(selector); await click(r.x + r.w / 2, r.y + r.h / 2); };
  /** Ein PDF (Bytes) im Viewer mit PDF.js lesen: Text, Drehung und Anmerkungen je Seite. */
  const inspect = (bytes) => page(`(async () => {
    const data = Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}), (c) => c.charCodeAt(0));
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n);
      const text = (await p.getTextContent()).items.map(i => i.str).join(' ');
      pages.push({ text, rotate: p.rotate, annotations: (await p.getAnnotations()).map(a => ({ type: a.annotationType, contents: a.contentsObj?.str || '', subtype: a.subtype })) });
    }
    return { pages };
  })()`);
  /** Speichern über den Knopf und die geschriebene Datei lesen. */
  const saved = async (button = '#download', file = 'Vertrag.pdf') => {
    const path = join(saveDir, file);
    const before = existsSync(path) ? statSync(path).mtimeMs : 0;
    await page(`document.querySelector(${JSON.stringify(button)}).click()`);
    await waitFor(() => existsSync(path) && statSync(path).mtimeMs !== before, `saved ${file}`);
    // „Speichern unter“: Der Viewer holt das Ergebnis alle 250 ms ab (pdf.rs, saved/)
    await delay(400);
    return { fileName: file, ...(await inspect(await readFile(path))) };
  };
  const pageRect = (n) => rect(`#viewer .page[data-page-number="${n}"]`);
  const T = { FREETEXT: 3, HIGHLIGHT: 9, INK: 15, STAMP: 13 };

  // Werkzeugleiste und deutsche Texte
  assert.equal(await page(`document.querySelectorAll('#tools [data-tool]').length`), 10, 'ten tools in the rail');
  await waitFor(() => page(`document.querySelector('#tools .glass').style.backdropFilter.startsWith('url(#lens-')`), 'lens on tool rail');
  console.log('PASS: the tool rail is there and uses the glass lens.');

  // ---------- Zeichnen ----------
  await pressButton('#tools [data-tool="draw"]');
  await waitFor(() => page(`document.body.dataset.tool === 'draw' && !document.getElementById('tool-options').hidden`), 'ink tool with options');
  let r = await pageRect(1);
  await drag([[r.x + 120, r.y + 300], [r.x + 180, r.y + 330], [r.x + 240, r.y + 290], [r.x + 300, r.y + 340]]);
  await drag([[r.x + 120, r.y + 360], [r.x + 300, r.y + 360]]);
  await waitFor(() => page(`document.querySelectorAll('.page[data-page-number="1"] .canvasWrapper svg.draw').length >= 1`), 'strokes drawn');
  // Alle Striche einer Sitzung werden eine Zeichnung, sobald das Werkzeug wechselt (wie in PDF.js/Firefox)
  await pressButton('#tools [data-tool="freetext"]');
  await waitFor(() => page(`document.body.dataset.tool === 'freetext' && document.querySelectorAll('.inkEditor').length === 1`), 'ink editor on page');
  await waitFor(() => page(`document.getElementById('download').classList.contains('dirty') && !document.getElementById('undo').disabled`), 'unsaved dot, undo available');
  // Rückgängig nimmt die Zeichnung weg, Wiederholen holt sie zurück
  await pressButton('#undo');
  await waitFor(() => page(`document.querySelectorAll('.inkEditor').length === 0`), 'ink undone');
  await waitFor(() => page(`!document.getElementById('redo').disabled`), 'redo available');
  await pressButton('#redo');
  await waitFor(() => page(`document.querySelectorAll('.inkEditor').length === 1`), 'ink redone');
  console.log('PASS: drawing with the pen creates an ink annotation; undo and redo work on it.');

  // ---------- Text ----------
  await waitFor(() => page(`!!document.querySelector('.page[data-page-number="1"] .annotationEditorLayer.freetextEditing')`), 'text layer ready');
  r = await pageRect(1);
  await click(r.x + 120, r.y + 450);
  await waitFor(() => page(`!!document.querySelector('.freeTextEditor .internal[contenteditable=true]')`), 'text box');
  await page.call('Input.insertText', { text: 'Gelesen und geprüft' });
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(() => page(`[...document.querySelectorAll('.freeTextEditor')].some(e => e.textContent.includes('Gelesen'))`), 'text committed');
  console.log('PASS: the text tool writes text onto the page.');

  // ---------- Hervorheben: Text auf Seite 2 markieren ----------
  await pressButton('#tools [data-tool="markup"]');
  await waitFor(() => page(`document.body.dataset.tool === 'markup'`), 'highlight tool');
  await page(`document.querySelector('#viewer .page[data-page-number="2"]').scrollIntoView({ block: 'start' })`);
  await waitFor(() => page(`[...document.querySelectorAll('.page[data-page-number="2"] .textLayer span')].some(s => s.textContent.includes('Seite 2'))
    && !!document.querySelector('.page[data-page-number="2"] .annotationEditorLayer.highlightEditing')`), 'text and editor layer page 2');
  await delay(300); // Seite fertig gescrollt und gezeichnet
  const span = await page(`(() => { const s = [...document.querySelectorAll('.page[data-page-number="2"] .textLayer span')].find(s => s.textContent.includes('Seite 2')); const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  // Über CDP gezogen bleibt die Textauswahl gelegentlich leer – dann noch einmal ziehen
  for (let attempt = 1; ; attempt++) {
    await drag([[span.x + 1, span.y + span.h / 2], [span.x + span.w / 2, span.y + span.h / 2], [span.x + span.w - 1, span.y + span.h / 2]]);
    try {
      await waitFor(() => page(`!!document.querySelector('.page[data-page-number="2"] .highlightEditor')`), 'highlight created', 40);
      break;
    } catch (err) {
      if (attempt === 3) throw err;
    }
  }
  // Und sie ist zu sehen: die Farbe kommt an (eine CSS-Regel für Symbole hatte fill auf none gesetzt)
  const look = await page(`(() => { const s = document.querySelector('.page[data-page-number="2"] .canvasWrapper svg.highlight'); return s && { fill: getComputedStyle(s).fill, attr: s.getAttribute('fill') }; })()`);
  assert.ok(look && look.fill !== 'none' && look.fill.startsWith('rgb'), `highlight is painted: ${JSON.stringify(look)}`);
  const ink = await page(`(() => { const s = document.querySelector('.canvasWrapper svg.draw'); return s && getComputedStyle(s).stroke; })()`);
  assert.equal(ink, 'rgb(0, 0, 0)', 'pen keeps its chosen colour (black)');
  // Umfärben über die Farben in den Einstellungen rechts – an der Markierung selbst gibt es keinen Farbwähler
  await waitFor(() => page(`!!document.querySelector('.highlightEditor.selectedEditor')`), 'new highlight selected');
  assert.equal(await page(`[...document.querySelectorAll('.editToolbar .colorPicker')].filter(b => b.offsetWidth).length`), 0, 'no second colour picker on the highlight');
  await pressButton('#tool-options .swatches[data-param="highlight"] .swatch:nth-child(3)');
  await waitFor(() => page(`getComputedStyle(document.querySelector('.page[data-page-number="2"] .canvasWrapper svg.highlight')).fill === 'rgb(128, 235, 255)'`), 'highlight recoloured from the panel');
  console.log('PASS: selecting text with the highlighter highlights it in colour; the panel recolours it.');

  // ---------- Unterschreiben ----------
  await pressButton('#tools [data-tool="signature"]');
  await waitFor(() => page(`document.body.dataset.tool === 'signature'`), 'signature tool');
  await pressButton('#new-signature');
  await waitFor(() => page(`!document.getElementById('sign-dialog').hidden`), 'signature dialog');
  const pad = await rect('#sign-draw');
  await drag([[pad.x + 40, pad.y + 110], [pad.x + 90, pad.y + 50], [pad.x + 140, pad.y + 120], [pad.x + 200, pad.y + 60], [pad.x + 260, pad.y + 115]]);
  await drag([[pad.x + 300, pad.y + 80], [pad.x + 360, pad.y + 90]]);
  assert.equal(await page(`document.getElementById('sign-add').disabled`), false, 'signature can be added');
  await page(`document.getElementById('sign-description').value = 'Max Muster'`);
  await pressButton('#sign-add');
  await waitFor(() => page(`document.getElementById('sign-dialog').hidden && !!document.querySelector('.signatureEditor:not([hidden])')`), 'signature placed');
  await waitFor(() => page(`document.querySelectorAll('#saved-signatures .saved').length === 1`), 'signature saved for later');
  let stored = [];
  await waitFor(async () => { stored = JSON.parse(await readFile(join(profile, 'GlassBrowser', 'signatures.json'), 'utf8')); return stored.length; }, 'signatures.json written');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].description, 'Max Muster');
  // Gespeicherte Unterschrift noch einmal einsetzen
  await pressButton('#saved-signatures .saved .use');
  await waitFor(() => page(`document.querySelectorAll('.signatureEditor:not([hidden])').length === 2`), 'saved signature placed again');
  console.log('PASS: a drawn signature is placed, stored in GlassBrowser\\signatures.json and can be reused.');

  // Zurück zum Auswählen, dann speichern: alles steckt im PDF
  await pressButton('#tools [data-tool="none"]');
  await waitFor(() => page(`document.body.dataset.tool === 'none'`), 'select tool');
  let result = await saved();
  assert.equal(result.fileName, 'Vertrag.pdf');
  const types = result.pages.map(p => p.annotations.map(a => a.type));
  assert.ok(types[0].includes(T.INK), `ink annotation saved on page 1: ${JSON.stringify(types)}`);
  assert.ok(types[0].includes(T.FREETEXT), 'free text saved on page 1');
  assert.ok(types[1].includes(T.HIGHLIGHT), 'highlight saved on page 2');
  assert.ok(types.flat().filter(t => t === T.INK || t === T.STAMP).length >= 3, 'both signatures saved');
  assert.equal(await page(`document.getElementById('download').classList.contains('dirty')`), false, 'saved: dot gone');
  console.log('PASS: saving writes ink, text, highlight and signatures into the PDF.');

  // ---------- Seiten organisieren ----------
  await pressButton('#organize-open');
  await waitFor(() => page(`!document.getElementById('organize').hidden && document.querySelectorAll('#org-grid .tile canvas').length === 3`), 'organize grid');
  const tile = (n) => rect(`#org-grid .tile:nth-child(${n}) .sheet`);
  let t = await tile(3);
  await click(t.x + t.w / 2, t.y + t.h / 2);
  assert.equal(await page(`document.getElementById('org-count').textContent`), '1 von 3 ausgewählt');
  await pressButton('#org-rotate-right');
  await waitFor(() => page(`!document.getElementById('organize').classList.contains('busy') && document.querySelectorAll('#org-grid .tile canvas').length === 3`), 'rotated');
  // Gedreht: die Kachel ist jetzt quer
  await waitFor(async () => { const s = await tile(3); return s.w > s.h; }, 'page 3 shown in landscape');
  console.log('PASS: rotating a page in the grid rotates it in the document.');

  // Seite 1 (mit Zeichnung und Text) ans Ende ziehen
  t = await tile(1);
  await click(t.x + t.w / 2, t.y + t.h / 2);
  // Ziehen per Tastatur (Strg+Pfeil) – echtes HTML-Drag&Drop lässt sich über CDP nicht zuverlässig auslösen
  for (let i = 0; i < 2; i++) {
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 2 });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 2 });
    await waitFor(() => page(`!document.getElementById('organize').classList.contains('busy')`), 'moved');
    await delay(100);
  }
  assert.equal(await page(`document.querySelector('#org-grid .tile.selected')?.dataset.index`), '2', 'moved page stays selected at the end');

  // Löschen der (jetzt) ersten Seite, dann rückgängig
  t = await tile(1);
  await click(t.x + t.w / 2, t.y + t.h / 2);
  await pressButton('#org-delete');
  await waitFor(() => page(`!document.getElementById('organize').classList.contains('busy') && document.querySelectorAll('#org-grid .tile').length === 2`), 'deleted');
  await pressButton('#org-undo');
  await waitFor(() => page(`!document.getElementById('organize').classList.contains('busy') && document.querySelectorAll('#org-grid .tile').length === 3`), 'undo delete');
  console.log('PASS: moving, deleting and undoing pages work.');

  // Anderes PDF einfügen (am Ende)
  await page(`document.getElementById('org-grid').click()`); // nichts ausgewählt: ans Ende
  const { root } = await page.call('DOM.getDocument', { depth: -1 });
  const { nodeId } = await page.call('DOM.querySelector', { nodeId: root.nodeId, selector: '#org-file' });
  await page.call('DOM.setFileInputFiles', { nodeId, files: [extra] });
  await waitFor(() => page(`!document.getElementById('organize').classList.contains('busy') && document.querySelectorAll('#org-grid .tile').length === 5`), 'inserted');
  console.log('PASS: inserting another PDF adds its pages.');

  // Auswahl als eigenes PDF
  t = await tile(4);
  await click(t.x + t.w / 2, t.y + t.h / 2);
  t = await tile(5);
  await mouse('mousePressed', t.x + t.w / 2, t.y + t.h / 2, { modifiers: 8 });
  await mouse('mouseReleased', t.x + t.w / 2, t.y + t.h / 2, { modifiers: 8 });
  assert.equal(await page(`document.getElementById('org-count').textContent`), '2 von 5 ausgewählt');
  const part = await saved('#org-extract', 'Vertrag (Seiten 4–5).pdf');
  assert.equal(part.fileName, 'Vertrag (Seiten 4–5).pdf');
  assert.deepEqual(part.pages.map(p => p.text.trim()), ['Anhang 1', 'Anhang 2']);
  console.log('PASS: extracting the selection saves those pages as their own PDF.');

  await pressButton('#org-done');
  await waitFor(() => page(`document.getElementById('organize').hidden`), 'organize closed');
  result = await saved();
  assert.deepEqual(result.pages.map(p => p.text.trim()), ['Seite 2', 'Seite 3', 'Seite 1', 'Anhang 1', 'Anhang 2'], 'page order');
  assert.equal(result.pages[1].rotate, 90, 'rotation kept');
  const moved = result.pages[2].annotations.map(a => a.type);
  assert.ok(moved.includes(T.INK) && moved.includes(T.FREETEXT), `annotations moved with their page: ${JSON.stringify(moved)}`);
  assert.ok(result.pages[0].annotations.some(a => a.type === T.HIGHLIGHT), 'highlight moved with page 2');
  console.log('PASS: the saved PDF has the new order, the rotation and every annotation on its page.');

  const problems = page.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error').map(e => `${e.params.entry.text} ${e.params.entry.url || ''}`);
  assert.deepEqual(problems, [], 'no console errors');
  console.log('PASS: no console errors.');
} finally {
  clearTimeout(watchdog);
  sockets.forEach(s => s.close());
  app.kill();
  server.close();
}
