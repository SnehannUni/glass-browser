// Werkzeuge ohne Server: PDF aus Bildern (neuer Tab, anhängen), leere Seite und Bilder beim Organisieren einfügen,
// Dateigröße verringern, vorhandene Bilder verschieben/skalieren/ersetzen/löschen, Schrift beim Text bearbeiten.
// Run after `cargo build`, using Node 22+ on Windows. No npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Testdokument: Seite 1 mit Text und kleinem Bild, Seite 2 mit großem ungepacktem Bild (800×800), Seite 3 nur Text. */
function makePdf() {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null), pages = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const small = add(Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 12 >>\nstream\n'), Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]), Buffer.from('\nendstream')]));
  const W = 800, pixels = Buffer.alloc(W * W * 3);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; const n = Math.random() * 90; pixels[i] = x * 160 / W + n; pixels[i + 1] = y * 160 / W + n; pixels[i + 2] = 90 + n; }
  const big = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${W} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`), pixels, Buffer.from('\nendstream')]));
  const kids = [];
  const contents = [
    'q 200 0 0 120 300 300 cm /Im1 Do Q BT /F1 40 Tf 72 680 Td (Seite 1) Tj ET BT /F1 14 Tf 72 640 Td (Kontonummer 1234 5678) Tj ET',
    'q 144 0 0 144 72 400 cm /Im2 Do Q BT /F1 40 Tf 72 680 Td (Seite 2) Tj ET',
    'BT /F1 40 Tf 72 680 Td (Seite 3) Tj ET',
  ];
  for (const text of contents) {
    const content = add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im1 ${small} 0 R /Im2 ${big} 0 R >> >> >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objects[pages - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const parts = [Buffer.from('%PDF-1.4\n')];
  let length = parts[0].length;
  const offsets = objects.map((body, i) => {
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n')]);
    const at = length;
    parts.push(chunk);
    length += chunk.length;
    return at;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

await mkdir('target/pdf-smoke', { recursive: true });
const profile = await mkdtemp(resolve('target/pdf-smoke/create-'));
const saveDir = join(profile, 'gespeichert');
await mkdir(saveDir);
const pdf = makePdf();
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length });
  res.end(pdf);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const portProbe = createServer();
await new Promise((r) => portProbe.listen(0, '127.0.0.1', r));
const port = portProbe.address().port;
await new Promise((r) => portProbe.close(r));
const app = spawn(resolve('target/debug/glass-browser.exe'), [`${origin}/Bericht.pdf`], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: profile, GLASS_TEST_SAVE_DIR: saveDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const sockets = [];
const watchdog = setTimeout(() => { console.error('FAIL: watchdog'); app.kill(); process.exit(1); }, 180000);
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
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  Object.assign(evaluate, { call, events });
  return evaluate;
}
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
  const tool = async (name) => {
    // Gleich nach dem Start nimmt das Fenster Klicks manchmal noch nicht an – dann noch einmal
    for (let attempt = 1; ; attempt++) {
      await press(`#tools [data-tool="${name}"]`);
      try {
        await waitFor(() => page(`document.body.dataset.tool === ${JSON.stringify(name)}`), `tool ${name}`, 40);
        return;
      } catch (err) { if (attempt === 4) throw err; }
    }
  };
  /** PDF-Punkt (x, y) auf Seite n → Bildschirm */
  const at = async (n, x, y) => {
    const r = await rect(`#viewer .page[data-page-number="${n}"]`);
    const k = r.w / 612;
    return [r.x + x * k, r.y + (792 - y) * k];
  };
  const span = (n, text) => page(`(() => { const s = [...document.querySelectorAll('.page[data-page-number="${n}"] .textLayer span:not(.markedContent):not(:has(span))')].find(s => s.textContent.includes(${JSON.stringify(text)})); if (!s) return null; const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const idle = () => waitFor(() => page(`!document.body.classList.contains('busy')`), 'not busy');
  /** Was in der Arbeitsfassung steht: Seitengrößen, Texte (mit Schriftgröße), Bilder je Seite, Schriften, Bildmaße, Bytes */
  const inspect = (file = null) => page(`(async () => {
    const bytes = ${file ? `Uint8Array.from(atob(${JSON.stringify(Buffer.from(file).toString('base64'))}), (c) => c.charCodeAt(0))` : 'await glassPdf.workingBytes()'};
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n), v = p.getViewport({ scale: 1 });
      const items = (await p.getTextContent()).items;
      const ops = await p.getOperatorList();
      const images = ops.fnArray.filter((f) => f === pdfjsLib.OPS.paintImageXObject || f === pdfjsLib.OPS.paintInlineImageXObject).length;
      pages.push({ size: [Math.round(v.width), Math.round(v.height)], text: items.map((i) => i.str).join(' '), sizes: items.map((i) => [i.str, Math.round(Math.hypot(i.transform[2], i.transform[3]))]), images });
    }
    const lib = await glassPdf.loadPdfLib();
    const pdf = await lib.PDFDocument.load(bytes);
    const fonts = [], imageSizes = [];
    for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
      const d = obj.dict || obj;
      if (!d.get) continue;
      if (d.get(lib.PDFName.of('Type'))?.toString() === '/Font') fonts.push(d.get(lib.PDFName.of('BaseFont'))?.toString() || '');
      if (d.get(lib.PDFName.of('Subtype'))?.toString() === '/Image') imageSizes.push([d.get(lib.PDFName.of('Width'))?.asNumber(), d.get(lib.PDFName.of('Height'))?.asNumber()]);
    }
    return { pages, fonts, imageSizes, bytes: bytes.length };
  })()`);
  return { mouse, click, drag, rect, press, key, tool, at, span, idle, inspect };
}

let diag = null;
try {
  let list;
  await waitFor(async () => { list = await targets(); return list.some((t) => t.url.endsWith('/Bericht.pdf')); }, 'tab', 400);
  const ready = (page, pages) => waitFor(() => page(`document.querySelectorAll('#viewer .page').length === ${pages} && document.getElementById('status').classList.contains('done') && !!globalThis.glassPdf?.tools`), 'viewer rendered');
  const ui = await connect(list.find((t) => t.url.includes('glass.localhost')));
  // Tab nach vorn – Tabs im Hintergrund bekommen keine Eingaben
  await waitFor(() => ui(`!!window.ipc && typeof window.render === "function"`), "ui ready", 400);
  await ui(`(() => { const original = window.render; window.render = (state) => { window.__state = state; return original(state); }; })()`);
  await ui(`window.ipc.postMessage(JSON.stringify({ cmd: 'activate', id: 1 }))`);
  await delay(300);
  const page = await connect(list.find((t) => t.url.endsWith('/Bericht.pdf')));
  await page.call('Log.enable');
  diag = async () => ({ toast: await page(`document.getElementById('toast').textContent`).catch(() => ''),
    images: await page(`glassPdf.imageEdit.imagesOf(1).then((l) => l.map((i) => i.rect))`).catch((e) => String(e)), errors: page.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error').map((e) => e.params.entry.text) });
  const H = helpers(page);
  await ready(page, 3);

  // ---------- Leiste von Glass gleitet: die Leisten unten im Viewer stehen dabei still ----------
  await delay(800);
  await page(`(() => { window.__rec = []; const orig = window.__glassWall; window.__glassWall = (g) => { window.__g = g; orig(g); };
    const loop = (time) => { const dock = document.getElementById('dock');
      if (window.__g) window.__rec.push([window.__g.y, dock.getBoundingClientRect().bottom, parseFloat(dock.style.getPropertyValue('--clip-bottom')) || 0, time]);
      if (window.__rec.length < 400) requestAnimationFrame(loop); };
    requestAnimationFrame(loop); })()`);
  for (const hide of [true, false]) {
    await page(`window.__rec.length = 0`);
    await ui(`window.pageScrolled(${hide})`);
    await delay(700);
    const rec = await page(`window.__rec`);
    const onScreen = rec.map(([y, bottom]) => y + bottom), moved = rec.map(([y]) => y);
    const span = (a) => Math.max(...a) - Math.min(...a);
    assert.ok(span(moved) > 30, `the page slid (${span(moved)} px)`);
    assert.ok(span(onScreen) < 8, `dock stays in place while the page slides: ${span(onScreen).toFixed(1)} px`);
    assert.equal(rec.at(-1)[2], 0, 'no offset left afterwards');
    // Flüssig: während des Gleitens (ohne das erste Bild, in dem die Seite einmal ihre Größe ändert) ein Bild je ~16 ms
    const sliding = rec.filter((r, i) => i > 1 && r[2] > 0).map((r) => r[3]);
    const gaps = sliding.slice(1).map((t, i) => t - sliding[i]).sort((a, b) => a - b);
    assert.ok(gaps[Math.floor(gaps.length / 2)] < 21, `smooth while sliding (median ${gaps[Math.floor(gaps.length / 2)]?.toFixed(1)} ms between frames)`);
  }
  console.log('PASS: the dock stays in place while the Glass toolbar slides in and out.');

  // Bilder als Dateien, im Viewer gezeichnet
  await page(`window.__image = async (w, h, color, type, name) => {
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
    x.fillStyle = color; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.fillRect(w / 4, h / 4, w / 2, h / 2);
    return new File([await c.convertToBlob({ type, quality: .9 })], name, { type });
  }`);

  // ---------- Vorhandene Bilder: verschieben, Größe ändern, ersetzen, löschen ----------
  await H.tool('textedit');
  await waitFor(() => page(`glassPdf.imageEdit.imagesOf(1).then((l) => l.length === 1)`), 'image found');
  let [x, y] = await H.at(1, 400, 360);
  await H.click(x, y);
  await waitFor(() => page(`!!glassPdf.imageEdit.selected && !document.getElementById('image-actions').hidden`), 'image selected');
  await waitFor(() => page(`!!document.querySelector('.image-box.selected .handle.se')`), 'handles');
  const k = (await H.rect('#viewer .page[data-page-number="1"]')).w / 612;
  await H.drag([[x, y], [x + 20, y], [x + 45, y], [x + 60, y]]);
  await H.idle();
  // Um etwa die gezogene Strecke nach rechts, in der Höhe unverändert
  await waitFor(() => page(`glassPdf.imageEdit.imagesOf(1).then((l) => l.length === 1 && Math.abs(l[0].rect[0] - ${300 + 60 / k}) < 10 && Math.abs(l[0].rect[1] - 300) < 1)`), "image moved");
  await waitFor(() => page(`!!glassPdf.imageEdit.selected`), 'still selected after the move');
  const handle = await H.rect('.image-box.selected .handle.se');
  await H.drag([[handle.x + handle.w / 2, handle.y + handle.h / 2], [handle.x + 30, handle.y + 20], [handle.x + 60, handle.y + 40]]);
  await H.idle();
  await waitFor(() => page(`glassPdf.imageEdit.imagesOf(1).then((l) => l[0].rect[2] - l[0].rect[0] > 230)`), 'image larger');
  const resized = await page(`glassPdf.imageEdit.imagesOf(1).then((l) => l[0].rect)`);
  assert.ok(Math.abs((resized[2] - resized[0]) / (resized[3] - resized[1]) - 200 / 120) < .02, `aspect ratio kept: ${resized}`);
  console.log('PASS: an image in the PDF can be moved and resized at a corner (aspect ratio kept).');
  await waitFor(() => page(`!!glassPdf.imageEdit.selected`), 'selected for replace');
  await page(`window.__image(300, 150, '#1f5fd6', 'image/png', 'Logo.png').then((f) => glassPdf.imageEdit.replace(f))`);
  await H.idle();
  await waitFor(() => page(`glassPdf.imageEdit.imagesOf(1).then((l) => l.length === 1 && Math.abs((l[0].rect[2] - l[0].rect[0]) / (l[0].rect[3] - l[0].rect[1]) - 2) < .02)`), 'image replaced, fitted 2:1');
  const replaced = await page(`glassPdf.imageEdit.imagesOf(1).then((l) => l[0].rect)`);
  assert.ok(Math.abs((replaced[2] - replaced[0]) - (resized[2] - resized[0])) < 1, 'replacement fills the old width');
  console.log('PASS: replacing an image fits the new one into the old frame.');
  await waitFor(() => page(`!!glassPdf.imageEdit.selected`), 'selected for delete');
  await H.key('Delete', 'Delete', 46);
  await H.idle();
  await waitFor(() => page(`glassPdf.imageEdit.imagesOf(1).then((l) => l.length === 0)`), 'image deleted');
  let result = await H.inspect();
  assert.equal(result.pages[0].images, 0, 'nothing drawn any more');
  assert.ok(!result.imageSizes.some(([w, h]) => w === 300 && h === 150), `deleted image is gone from the file: ${JSON.stringify(result.imageSizes)}`);
  assert.ok(result.pages[0].text.includes('Kontonummer'), 'text stays');
  await page(`glassPdf.undoChange()`);
  await H.idle();
  await waitFor(() => page(`glassPdf.imageEdit.imagesOf(1).then((l) => l.length === 1)`), 'undo brings it back');
  console.log('PASS: deleting an image removes it from the page and the file; undo brings it back.');

  // ---------- Schrift beim Text bearbeiten ----------
  await page(`glassPdf.imageEdit.selected && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await waitFor(async () => !!(await H.span(1, 'Kontonummer')), 'span');
  const s = await H.span(1, 'Kontonummer');
  await H.click(s.x + s.w / 2, s.y + s.h / 2);
  await waitFor(() => page(`!!glassPdf.textEdit.session?.style && !document.getElementById('text-format').hidden`), 'format shown');
  const style = await page(`glassPdf.textEdit.session.style`);
  assert.equal(style.font, 'std:Helvetica', 'Helvetica in the PDF → Helvetica');
  assert.equal(style.size, 14, 'size from the PDF');
  assert.ok(await page(`[...document.getElementById('te-font').options].some((o) => o.value === 'sys:Arial')`), 'installed fonts listed');
  await page(`glassPdf.textEdit.setStyle({ font: 'sys:Arial', size: 18, bold: true })`);
  await page(`(() => { const b = document.querySelector('.text-edit'); b.focus(); getSelection().selectAllChildren(b); })()`);
  await page.call('Input.insertText', { text: 'Kontonummer ÄÖÜ 9999' });
  await H.key('Enter', 'Enter', 13);
  await H.idle();
  await waitFor(async () => (await H.inspect()).pages[0].text.includes('ÄÖÜ 9999'), 'text in Arial');
  result = await H.inspect();
  assert.ok(result.fonts.some((f) => /Arial/.test(f) && /Bold/.test(f)), `Arial Bold embedded: ${result.fonts}`);
  const item = result.pages[0].sizes.find(([str]) => str.includes('9999'));
  assert.equal(item[1], 18, `new size: ${JSON.stringify(result.pages[0].sizes)}`);
  assert.ok(!result.pages[0].text.includes('1234'), 'old text removed');
  console.log('PASS: text edit can switch to an installed font (Arial Bold, umlauts) and another size.');
  await H.tool('none');

  // ---------- Organisieren: leere Seite, Bild als Seite ----------
  await H.press('#organize-open');
  await waitFor(() => page(`glassPdf.organize.isOpen && document.querySelectorAll('#org-grid .tile').length === 3`), 'organize open');
  await H.press('#org-grid .tile[data-index="0"]');
  await H.press('#org-blank');
  await waitFor(() => page(`glassPdf.doc.numPages === 4 && !document.getElementById('org-blank').disabled`), 'blank page');
  result = await H.inspect();
  assert.deepEqual(result.pages[1].size, [612, 792], 'same size as the page before');
  assert.equal(result.pages[1].text.trim(), '', 'empty');
  assert.ok(result.pages[2].text.includes('Seite 2'), 'inserted after the selection');
  await page(`window.__image(400, 200, '#d62f2f', 'image/jpeg', 'Quer.jpg').then((f) => glassPdf.organize.insert([f], 4))`);
  await waitFor(() => page(`glassPdf.doc.numPages === 5 && !document.getElementById('org-insert').disabled`), 'image inserted');
  result = await H.inspect();
  assert.deepEqual(result.pages[4].size, [792, 612], 'landscape image → landscape page in the document size');
  assert.equal(result.pages[4].images, 1, 'the image is on the page');
  await H.press('#org-done');
  console.log('PASS: organize inserts a blank page and images as pages.');

  // ---------- Dateigröße verringern ----------
  const before = (await H.inspect()).bytes;
  assert.ok(before > 1_500_000, `big test file: ${before}`);
  await H.press('#more');
  await H.press('#more-menu [data-action="compress"]');
  // Für jede Stufe steht da, wie groß die Datei wird
  await waitFor(() => page(`!document.getElementById('compress-dialog').hidden && [...document.querySelectorAll('#compress-level .size')].every((s) => /^etwa .*(KB|MB)/.test(s.textContent))`), 'estimates', 400);
  const estimate = await page(`document.querySelector('#compress-level [data-level="medium"] .size').textContent`);
  await page(`document.getElementById('compress-form').requestSubmit()`);
  const reduced = join(saveDir, 'Bericht (verkleinert).pdf');
  await waitFor(() => existsSync(reduced), 'saved as a new file', 400);
  await delay(200);
  const small = await readFile(reduced);
  assert.ok(small.length < before / 5, `much smaller: ${small.length}`);
  assert.equal(estimate.replace(/ \(.*/, ''), `etwa ${Math.max(1, Math.round(small.length / 1024))} KB`, 'the estimate is the size of the saved file');
  result = await H.inspect(small);
  assert.ok(result.imageSizes.some(([w]) => w > 250 && w < 300), `big image downscaled to 144 dpi: ${JSON.stringify(result.imageSizes)}`);
  assert.ok(result.pages[2].text.includes('Seite 2') && result.pages[2].images === 1, 'page with the image still shows it');
  assert.equal((await H.inspect()).bytes, before, 'the open PDF is unchanged');
  assert.match(await page(`document.getElementById('toast').textContent`), /verkleinert\)\.pdf“ gespeichert/);
  console.log(`PASS: reducing the file size saves a new file (${before} → ${small.length} bytes, as estimated) and leaves the PDF as it is.`);

  // ---------- PDF aus Bildern: anhängen, dann als neues PDF im neuen Tab ----------
  await page(`Promise.all([window.__image(300, 200, '#30d158', 'image/png', 'Eins.png'), window.__image(200, 300, '#ff9f0a', 'image/jpeg', 'Zwei.jpg')]).then((files) => glassPdf.images.open(files))`);
  await waitFor(() => page(`!document.getElementById('images-dialog').hidden && document.querySelectorAll('#images-list .image-tile[data-index]').length === 2`), 'images dialog');
  await page(`document.getElementById('images-append').click()`);
  await H.idle();
  await waitFor(() => page(`glassPdf.doc.numPages === 7`), 'appended');
  result = await H.inspect();
  assert.deepEqual(result.pages[5].size, [842, 595], 'landscape A4');
  assert.deepEqual(result.pages[6].size, [595, 842], 'portrait A4');
  console.log('PASS: images can be appended to the PDF as A4 pages.');

  // ---------- Geschütztes PDF: Seiten einfügen geht genauso (pdf.rs entschlüsselt mit dem Passwort vom Öffnen) ----------
  const locked = await page(`(async () => { const b = await glassPdf.workingBytes(); const pw = new TextEncoder().encode('1234');
    const body = new Uint8Array(4 + pw.length + b.length); new DataView(body.buffer).setUint32(0, pw.length, true); body.set(pw, 4); body.set(b, 4 + pw.length);
    const r = await fetch(glassPdf.API + 'encrypt', { method: 'POST', body }); const out = new Uint8Array(await r.arrayBuffer());
    let s = ''; for (const c of out) s += String.fromCharCode(c); return btoa(s); })()`);
  const reopened = page(`glassPdf.replaceDocument(Uint8Array.from(atob(${JSON.stringify(locked)}), (c) => c.charCodeAt(0))).then(() => true)`);
  await waitFor(() => page(`!document.getElementById('password').hidden`), 'password asked');
  await page(`document.getElementById('password-input').value = '1234'; document.getElementById('password').requestSubmit()`);
  await reopened;
  await waitFor(() => page(`glassPdf.isEncrypted()`), 'document is encrypted');
  await page(`glassPdf.organize.open()`);
  await page(`glassPdf.organize.blank()`);
  await waitFor(() => page(`glassPdf.doc.numPages === 8`), 'blank page in a protected PDF');
  await page(`glassPdf.loadPdfLib().then(async (lib) => { const d = await lib.PDFDocument.create(); d.addPage([300, 300]);
    const files = [new File([await d.save()], 'Extra.pdf', { type: 'application/pdf' }), await window.__image(200, 100, '#bf5af2', 'image/png', 'Bild.png')];
    return glassPdf.organize.insert(files, 0); })`);
  await waitFor(() => page(`glassPdf.doc.numPages === 10`), 'PDF and image inserted into a protected PDF');
  await page(`glassPdf.organize.close()`);
  assert.equal(await page(`glassPdf.protection?.password`), '1234', 'saved again with the same password');
  const saved = await page(`glassPdf.exportBytes().then((b) => pdfjsLib.getDocument({ data: b }).promise.then(() => 'open', (e) => e.name))`);
  assert.equal(saved, 'PasswordException', 'still protected when saved');
  console.log('PASS: a password-protected PDF gets blank pages, PDFs and images inserted and stays protected.');

  await page(`Promise.all([window.__image(300, 200, '#30d158', 'image/png', 'Eins.png'), window.__image(200, 300, '#ff9f0a', 'image/jpeg', 'Zwei.jpg')]).then((files) => glassPdf.images.open(files))`);
  await waitFor(() => page(`!document.getElementById('images-dialog').hidden`), 'images dialog again');
  await page(`document.getElementById('images-size').value = 'fit'`);
  await page(`document.getElementById('images-form').requestSubmit()`);
  let created;
  await waitFor(async () => { created = (await targets()).find((t) => t.url.includes('glass-pdf.localhost/new/')); return !!created; }, 'new tab', 400);
  const fresh = await connect(created);
  await ready(fresh, 2);
  assert.equal(await fresh(`document.title`), 'Bilder.pdf');
  const sizes = await fresh(`Promise.all([1, 2].map((n) => glassPdf.doc.getPage(n).then((p) => { const v = p.getViewport({ scale: 1 }); return [Math.round(v.width), Math.round(v.height)]; })))`);
  assert.deepEqual(sizes, [[842, 561], [561, 842]], 'pages as large as the images (long side like A4)');
  await waitFor(() => ui(`window.__state?.tabs?.some((t) => t.url === 'Bilder.pdf')`), 'address shows the name').catch(async (err) => { console.error('UI', JSON.stringify(await ui(`window.__state?.tabs`))); throw err; });
  // Strg+S fragt nach dem Ort (im Test: fester Ordner)
  await fresh(`glassPdf.save()`);
  await waitFor(() => existsSync(join(saveDir, 'Bilder.pdf')), 'saved');
  console.log('PASS: a new PDF from images opens in its own tab and saves with "save as".');

  for (const p of [page]) {
    const problems = p.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error').map((e) => `${e.params.entry.text} ${e.params.entry.url || ''}`);
    assert.deepEqual(problems, [], 'no console errors');
  }
  console.log('PASS: no console errors.');
} catch (err) {
  if (diag) console.error('DIAG', JSON.stringify(await diag()));
  throw err;
} finally {
  clearTimeout(watchdog);
  sockets.forEach((s) => s.close());
  app.kill();
  server.close();
}
