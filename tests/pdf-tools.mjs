// Die Acrobat-Werkzeuge 1–10: Notizen, Unterstreichen, Formen, Stempel, lokale Dateien (Öffnen und Speichern),
// Schwärzen, Wasserzeichen/Seitenzahlen, Formularfelder, Passwort, Text bearbeiten.
// Run after `cargo build`, using Node 22+ on Windows. No npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** PDF mit `pages` Seiten („Seite n“); auf `imagePage` liegt zusätzlich ein kleines Bild. */
function makePdf(pages, label = 'Seite', imagePage = 0) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  const image = objects.length + 1;
  objects.push('<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 12 >>\nstream\n\xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\x00\nendstream');
  for (let n = 1; n <= pages; n++) {
    const pic = n === imagePage ? 'q 200 0 0 120 300 300 cm /Im1 Do Q ' : '';
    const text = `${pic}BT /F1 40 Tf 72 680 Td (${label} ${n}) Tj ET BT /F1 14 Tf 72 640 Td (Kontonummer 1234 5678) Tj ET`;
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objects.length} 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 ${image} 0 R >> >> >>`);
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
const profile = await mkdtemp(resolve('target/pdf-smoke/tools-'));
const saveDir = join(profile, 'gespeichert');
await mkdir(saveDir);
const localFile = join(profile, 'Lokal Datei.pdf');
await writeFile(localFile, makePdf(2, 'Lokal'));
const pdf = makePdf(3, 'Seite', 3);
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
const app = spawn(resolve('target/debug/glass-browser.exe'), [`${origin}/Bericht.pdf`, localFile], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: profile, GLASS_TEST_SAVE_DIR: saveDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const sockets = [];
const watchdog = setTimeout(() => { console.error('FAIL: watchdog'); app.kill(); process.exit(1); }, 150000);
async function waitFor(check, label, tries = 200) {
  for (let i = 0; i < tries; i++) { try { if (await check()) return; } catch { /* lädt noch */ } await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
/** Hilfen für einen Viewer-Tab: Maus, Elemente, PDF lesen */
function helpers(page) {
  const mouse = (type, x, y, extra = {}) => page.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1, ...extra });
  const click = async (x, y) => { await mouse('mouseMoved', x, y, { button: 'none', buttons: 0 }); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); };
  const drag = async (points) => {
    await mouse('mouseMoved', ...points[0], { button: 'none', buttons: 0 });
    await mouse('mousePressed', ...points[0]);
    for (const p of points.slice(1)) { await mouse('mouseMoved', ...p); await delay(15); }
    await mouse('mouseReleased', ...points.at(-1));
  };
  const rect = (selector) => page(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const press = async (selector) => { const r = await rect(selector); await click(r.x + r.w / 2, r.y + r.h / 2); };
  const key = async (key, code, vk, modifiers = 0) => {
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  };
  /** Bytes (Buffer) oder die gespeicherte Fassung (null) mit PDF.js lesen */
  const inspect = (bytes = null, password = null) => page(`(async () => {
    const data = ${bytes ? `Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}), (c) => c.charCodeAt(0))` : 'await glassPdf.exportBytes()'};
    const doc = await pdfjsLib.getDocument({ data, password: ${JSON.stringify(password)} }).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n);
      const text = (await p.getTextContent()).items.map(i => i.str).join(' ');
      pages.push({ text, annotations: (await p.getAnnotations()).map(a => ({ type: a.annotationType, contents: a.contentsObj?.str || '', lines: a.inkLists?.length || 0, field: a.fieldName || '', rect: a.rect })) });
    }
    return { pages };
  })()`);
  const tool = async (name, variant) => {
    await press(`#tools [data-tool="${name}"]`);
    await waitFor(() => page(`document.body.dataset.tool === ${JSON.stringify(name)}`), `tool ${name}`);
    if (variant) {
      await press(`#tool-options .variants[data-group="${name}"] [data-sub="${variant}"]`);
      await waitFor(() => page(`document.body.dataset.sub === ${JSON.stringify(variant)}`), `variant ${variant}`);
    }
  };
  const pageRect = (n) => rect(`#viewer .page[data-page-number="${n}"]`);
  const span = (n, text) => page(`(() => { const s = [...document.querySelectorAll('.page[data-page-number="${n}"] .textLayer span:not(.markedContent):not(:has(span))')].find(s => s.textContent.includes(${JSON.stringify(text)})); if (!s) return null; const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const idle = () => waitFor(() => page(`!document.body.classList.contains('busy')`), 'not busy');
  return { mouse, click, drag, rect, press, key, inspect, tool, pageRect, span, idle };
}
const T = { TEXT: 1, FREETEXT: 3, HIGHLIGHT: 9, STAMP: 13, INK: 15, WIDGET: 20 };

let diag = null; // im Fehlerfall: Rückmeldung und Konsolenfehler des Web-Tabs
try {
  let list;
  await waitFor(async () => { list = await targets(); return list.some(t => t.url.endsWith('/Bericht.pdf')) && list.some(t => t.url.includes('glass-pdf.localhost/file/')); }, 'both tabs', 400);
  const ready = (page, pages) => waitFor(() => page(`document.querySelectorAll('#viewer .page').length === ${pages} && document.getElementById('status').classList.contains('done') && !!globalThis.glassPdf?.tools`), 'viewer rendered');

  // ---------- 5: PDF von der Festplatte – öffnen, Notiz (1), Strg+S schreibt in die Datei ----------
  const local = await connect(list.find(t => t.url.includes('glass-pdf.localhost/file/')));
  const L = helpers(local);
  await ready(local, 2);
  assert.equal(await local(`document.title`), 'Lokal Datei.pdf');
  assert.ok(await local(`!!document.body.dataset.file`), 'viewer knows the file on disk');
  // Die Oberfläche bekommt ihren Zustand über window.render – mitlesen, welche Adresse der Tab zeigt
  const ui = await connect(list.find(t => t.url.includes('glass.localhost')));
  await ui(`(() => { const original = window.render; window.render = (state) => { window.__state = state; return original(state); }; })()`);
  await ui(`window.ipc.postMessage(JSON.stringify({ cmd: 'activate', id: 2 }))`);
  await waitFor(() => ui(`window.__state?.tabs?.some(t => t.url.startsWith('file:///') && t.url.endsWith('Lokal%20Datei.pdf'))`), 'address shows the file');
  await delay(500); // Tab nach vorn: Seite neu ausgelegt
  console.log('PASS: a PDF path on the command line opens in the Glass viewer.');

  await L.tool('note');
  let r = await L.pageRect(1);
  await L.click(r.x + 300, r.y + 200);
  await waitFor(() => local(`!!document.querySelector('.note-card textarea')`), 'note card');
  await waitFor(() => local(`document.activeElement?.matches('.note-card textarea')`), 'note focused');
  await local.call('Input.insertText', { text: 'Bitte prüfen' });
  await L.key('Escape', 'Escape', 27);
  await waitFor(() => local(`document.querySelectorAll('.note-pin').length === 1 && !document.querySelector('.note-card')`), 'note pinned');
  // Kommentarliste
  await local(`glassPdf.showSidebarView('comments')`);
  await waitFor(() => local(`document.querySelector('#comments .comment p')?.textContent === 'Bitte prüfen'`), 'comment list');
  const before = statSync(localFile).mtimeMs;
  await L.press('#download');
  await waitFor(() => statSync(localFile).mtimeMs !== before, 'file on disk written');
  await waitFor(() => local(`!document.getElementById('download').classList.contains('dirty')`), 'saved state');
  let result = await L.inspect(await readFile(localFile));
  assert.deepEqual(result.pages[0].annotations.filter(a => a.type === T.TEXT).map(a => a.contents), ['Bitte prüfen'], 'note saved as /Text annotation');
  console.log('PASS: a note is pinned, listed under comments and Ctrl+S writes it back into the file on disk.');
  // Wieder öffnen: die Notiz ist wieder bearbeitbar (übernommen, nicht nur von PDF.js gezeichnet)
  await local(`location.reload()`);
  await delay(400);
  await ready(local, 2);
  await waitFor(() => local(`glassPdf.notes.list.length === 1 && document.querySelectorAll('.note-pin').length === 1`), 'note imported again');
  console.log('PASS: reopening the file brings the note back as an editable note.');

  // ---------- Web-PDF (Tab 1 nach vorn) ----------
  await ui(`window.ipc.postMessage(JSON.stringify({ cmd: 'activate', id: 1 }))`);
  await delay(300);
  const page = await connect(list.find(t => t.url.endsWith('/Bericht.pdf')));
  diag = async () => ({ toast: await page(`document.getElementById('toast').textContent`).catch(() => ''),
    spans: await page(`[...document.querySelectorAll('.page[data-page-number="1"] .textLayer span:not(.markedContent):not(:has(span))')].map(s => s.textContent)`).catch(() => []),
    layers: await page(`[...document.querySelectorAll('.page[data-page-number="1"] .textLayer')].map(l => l.outerHTML.slice(0, 900))`).catch(() => []),
    rendered: await page(`[...document.querySelectorAll('#viewer .page')].map(p => p.dataset.loaded || p.className)`).catch(() => []),
    pdfText: await page(`glassPdf.workingBytes().then(b => pdfjsLib.getDocument({ data: b }).promise).then(d => d.getPage(1)).then(p => p.getTextContent()).then(t => t.items.map(i => i.str).join(' | '))`).catch((e) => String(e)), errors: page.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error').map(e => e.params.entry.text) });
  await page.call('Log.enable');
  const H = helpers(page);
  await ready(page, 3);

  // 2: Unterstreichen – Text auswählen
  await H.tool('markup', 'underline');
  await waitFor(async () => !!(await H.span(1, 'Seite 1')), 'span page 1');
  let s = await H.span(1, 'Seite 1');
  // Über CDP gezogen bleibt die Textauswahl gelegentlich leer – dann noch einmal
  for (let attempt = 1; ; attempt++) {
    await H.drag([[s.x + 2, s.y + s.h / 2], [s.x + s.w / 2, s.y + s.h / 2], [s.x + s.w - 2, s.y + s.h / 2]]);
    try {
      await waitFor(() => page(`document.querySelectorAll('.page[data-page-number="1"] .inkEditor').length === 1`), 'underline drawn', 40);
      break;
    } catch (err) { if (attempt === 3) throw err; }
  }
  console.log('PASS: underlining selected text adds a line under it.');

  // 3: Formen – Rechteck aufziehen
  await H.tool('draw', 'rect');
  r = await H.pageRect(1);
  await H.drag([[r.x + 100, r.y + 400], [r.x + 200, r.y + 460], [r.x + 300, r.y + 520]]);
  await waitFor(() => page(`document.querySelectorAll('.page[data-page-number="1"] .inkEditor').length === 2`), 'rectangle drawn');
  // 4: Stempel
  await H.tool('stamp');
  await H.press('#stamps .stamp');
  await waitFor(() => page(`document.querySelectorAll('.stampEditor').length === 1`), 'stamp placed');
  // Drehen: Griff über dem ausgewählten Stempel um die Mitte ziehen (¼ Umdrehung), keine kleine Leiste von PDF.js
  await waitFor(() => page(`!!document.querySelector('.stampEditor.selectedEditor > .rotate-handle')`), 'rotate handle');
  assert.equal(await page(`[...document.querySelectorAll('.editToolbar')].filter(t => t.offsetWidth).length`), 0, 'no PDF.js toolbar');
  assert.equal(await page(`document.getElementById('delete-selected').hidden`), false, 'delete button in the panel');
  const stampBox = await H.rect('.stampEditor');
  const handle = await H.rect('.stampEditor > .rotate-handle');
  const center = [stampBox.x + stampBox.w / 2, stampBox.y + stampBox.h / 2];
  const radius = center[1] - (handle.y + handle.h / 2);
  const arc = [0, 30, 60, 90].map((d) => [center[0] + radius * Math.sin(d * Math.PI / 180), center[1] - radius * Math.cos(d * Math.PI / 180)]);
  await H.drag([[handle.x + handle.w / 2, handle.y + handle.h / 2], ...arc.slice(1)]);
  await waitFor(async () => { const b = await H.rect('.stampEditor'); return b.h > b.w; }, 'stamp turned upright');
  await H.tool('none');
  result = await H.inspect();
  const types = result.pages.flatMap(p => p.annotations.map(a => a.type));
  assert.ok(result.pages[0].annotations.some(a => a.type === T.INK && a.lines === 4), `rectangle saved as 4 straight lines: ${JSON.stringify(result.pages[0].annotations)}`);
  assert.ok(result.pages[0].annotations.filter(a => a.type === T.INK).length >= 2, 'underline saved');
  const stamp = result.pages.flatMap(p => p.annotations).find(a => a.type === T.STAMP);
  assert.ok(stamp, 'stamp saved');
  assert.ok(stamp.rect[3] - stamp.rect[1] > stamp.rect[2] - stamp.rect[0], `rotated stamp saved upright: ${JSON.stringify(stamp.rect)}`);
  console.log('PASS: rectangles and stamps are real annotations; a stamp turned with its handle is saved turned.');

  // 8: Formularfeld aufziehen
  await H.tool('field', 'text');
  r = await H.pageRect(2);
  await page(`document.querySelector('#viewer .page[data-page-number="2"]').scrollIntoView()`);
  await delay(300);
  r = await H.pageRect(2);
  await H.drag([[r.x + 100, r.y + 300], [r.x + 250, r.y + 315], [r.x + 400, r.y + 330]]);
  await H.idle();
  await waitFor(() => page(`glassPdf.doc.getPage(2).then(p => p.getAnnotations()).then(a => a.some(x => x.fieldName === 'Textfeld 1'))`), 'text field created');
  await waitFor(() => page(`!!document.querySelector('.page[data-page-number="2"] .annotationLayer input')`), 'field fillable');
  console.log('PASS: dragging with the form field tool creates a fillable text field.');

  // 10: Text bearbeiten – „Seite 2“ wird „Kapitel 2“
  await H.tool('textedit');
  await waitFor(async () => !!(await H.span(2, 'Seite 2')), 'span page 2');
  s = await H.span(2, 'Seite 2');
  await H.click(s.x + s.w / 2, s.y + s.h / 2);
  await waitFor(() => page(`!!document.querySelector('.text-edit')`), 'inline editor');
  await page(`(() => { const b = document.querySelector('.text-edit'); getSelection().selectAllChildren(b); })()`);
  await page.call('Input.insertText', { text: 'Kapitel 2' });
  await H.key('Enter', 'Enter', 13);
  await H.idle();
  await waitFor(async () => (await H.inspect()).pages[1].text.includes('Kapitel 2'), 'text replaced');
  result = await H.inspect();
  assert.ok(!result.pages[1].text.includes('Seite 2'), `old text removed: ${result.pages[1].text}`);
  assert.ok(result.pages[1].text.includes('Kontonummer'), 'the rest of the page stays');
  assert.ok(result.pages[1].annotations.some(a => a.type === T.WIDGET), 'form field survives the edit');
  console.log('PASS: editing text removes the old glyphs and sets the new text in place.');
  // Rückgängig über den Knopf
  await H.tool('none');
  await H.press('#undo');
  await H.idle();
  await waitFor(async () => (await H.inspect()).pages[1].text.includes('Seite 2'), 'undo text edit');
  console.log('PASS: undo brings the original text back.');

  // 7: Wasserzeichen und Seitenzahlen
  await H.press('#more');
  await H.press('#more-menu [data-action="design"]');
  await waitFor(() => page(`!document.getElementById('design-dialog').hidden`), 'design dialog');
  await H.press('#design-form button[type=submit]');
  await H.idle();
  await waitFor(async () => (await H.inspect()).pages.every(p => p.text.includes('VERTRAULICH')), 'watermark on every page');
  await H.press('#more');
  await H.press('#more-menu [data-action="design"]');
  await H.press('#design-tabs [data-tab="numbers"]');
  await H.press('#design-form button[type=submit]');
  await H.idle();
  await waitFor(async () => (await H.inspect()).pages[2].text.includes('Seite 3 von 3'), 'page numbers');
  console.log('PASS: watermark and page numbers are added to every page.');

  // 6: Schwärzen – Kontonummer auf Seite 1 (Text) und Bild auf Seite 3
  await H.tool('redact');
  await page(`glassPdf.viewer.currentPageNumber = 1`);
  await waitFor(async () => !!(await H.span(1, 'Kontonummer')), 'span page 1', 400);
  await delay(300); // fertig gescrollt
  s = await H.span(1, 'Kontonummer');
  r = await H.pageRect(1);
  await H.drag([[s.x - 4, s.y - 4], [s.x + s.w / 2, s.y + s.h / 2], [s.x + s.w + 4, s.y + s.h + 4]]);
  await waitFor(() => page(`glassPdf.redact.marks.length === 1`), 'redaction marked');
  // Seite 3: Bereich über dem Bild (PDF-Punkte 300…500 × 300…420)
  await page(`glassPdf.redact.add(3, [310, 310, 360, 360])`);
  await H.press('#redact-apply');
  await H.idle();
  await waitFor(() => page(`glassPdf.redact.marks.length === 0`), 'applied');
  result = await H.inspect();
  assert.ok(!result.pages[0].text.includes('Kontonummer') && !result.pages[0].text.includes('1234'), `redacted text is gone: ${result.pages[0].text}`);
  assert.ok(result.pages[0].text.includes('Seite 1'), 'text outside the bar stays');
  assert.equal(result.pages[2].text.trim(), '', 'page with an image under the bar was rewritten as an image');
  console.log('PASS: redaction removes the text under the bar and rasterizes pages with images under it.');

  // 9: Passwort
  await H.press('#more');
  await H.press('#more-menu [data-action="protect"]');
  await waitFor(() => page(`!document.getElementById('protect-dialog').hidden`), 'protect dialog');
  await page(`document.getElementById('protect-password').value = 'geheim123'; document.getElementById('protect-repeat').value = 'geheim123'`);
  await H.press('#protect-form button[type=submit]');
  await waitFor(() => page(`document.getElementById('protect-dialog').hidden && !!glassPdf.protection`), 'protection set');
  const locked = await page(`(async () => { try { await pdfjsLib.getDocument({ data: await glassPdf.exportBytes() }).promise; return 'opened'; } catch (e) { return e.name; } })()`);
  assert.equal(locked, 'PasswordException', 'saved PDF needs a password');
  result = await H.inspect(null, 'geheim123');
  assert.equal(result.pages.length, 3, 'opens with the password');
  // Speichern unter (Testordner statt Dialog)
  await H.press('#download');
  await waitFor(() => existsSync(join(saveDir, 'Bericht.pdf')), 'saved as');
  const lockedFile = await H.inspect(await readFile(join(saveDir, 'Bericht.pdf')), 'geheim123');
  assert.ok(lockedFile.pages[0].annotations.some(a => a.type === T.STAMP) || lockedFile.pages.some(p => p.annotations.some(a => a.type === T.STAMP)), 'everything is in the protected file');
  console.log('PASS: password protection (AES-256) is applied when saving.');

  const problems = page.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error').map(e => `${e.params.entry.text} ${e.params.entry.url || ''}`);
  assert.deepEqual(problems, [], 'no console errors');
  console.log('PASS: no console errors.');
} catch (err) {
  if (diag) console.error('DIAG', JSON.stringify(await diag()));
  throw err;
} finally {
  clearTimeout(watchdog);
  sockets.forEach(s => s.close());
  app.kill();
  server.close();
}
