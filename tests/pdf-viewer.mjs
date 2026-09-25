// PDF-Viewer: PDFs öffnen sich im eigenen Viewer (src/pdf), auch in neuen Tabs und nach Neu laden.
// Run after `cargo build`, using Node 22+ on Windows. No npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Kleines, gültiges PDF mit `pages` Seiten; auf jeder steht `Seite n` und auf Seite 2 zusätzlich das Suchwort. */
function makePdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = [];
  objects.push(null); // Seitenbaum, unten gefüllt
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let n = 1; n <= pages; n++) {
    const text = `BT /F1 28 Tf 72 720 Td (Seite ${n}) Tj ${n === 2 ? '0 -40 Td (Glasklar Suchwort) Tj ' : ''}ET`;
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
const profile = await mkdtemp(resolve('target/pdf-smoke/profile-'));
const pdf = makePdf(3);
let pdfRequests = 0;
const server = createServer((req, res) => {
  if (req.url.startsWith('/docs/')) {
    pdfRequests++;
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length });
    res.end(pdf); return;
  }
  if (req.url === '/links') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Links</title><a id="pdf" href="/docs/Zweites%20Dokument.pdf" target="_blank">PDF</a>'); return;
  }
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const portProbe = createServer();
await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const port = portProbe.address().port;
await new Promise(r => portProbe.close(r));
const app = spawn(resolve('target/debug/glass-browser.exe'), [`${origin}/docs/Bericht.pdf`], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const sockets = [];
const watchdog = setTimeout(() => { console.error('FAIL: watchdog'); app.kill(); process.exit(1); }, 60000);
async function waitFor(check, label) {
  for (let i = 0; i < 200; i++) { try { if (await check()) return; } catch { /* Seite lädt noch */ } await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl); sockets.push(ws);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  let seq = 0; const pending = new Map(); const events = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data), p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); } else if (m.method) events.push(m);
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
const viewerReady = page => waitFor(() => page(`document.querySelectorAll('#viewer .page').length === 3 && document.getElementById('status').classList.contains('done')`), 'viewer rendered');

try {
  let list;
  await waitFor(async () => { list = await targets(); return list.some(t => t.url.endsWith('/docs/Bericht.pdf')) && list.some(t => t.url.includes('glass.localhost')); }, 'browser startup');
  const ui = await connect(list.find(t => t.url.includes('glass.localhost')));
  const page = await connect(list.find(t => t.url.endsWith('/docs/Bericht.pdf')));
  await page.call('Log.enable');
  await viewerReady(page);

  assert.equal(await page(`document.title`), 'Bericht.pdf');
  assert.equal(await page(`location.href`), `${origin}/docs/Bericht.pdf`, 'address stays the PDF');
  assert.equal(await page(`document.getElementById('page-count').textContent`), '/ 3');
  await waitFor(() => page(`[...document.querySelectorAll('.textLayer')].some(l => l.textContent.includes('Seite 1'))`), 'selectable text layer');
  await waitFor(() => ui(`document.querySelector('#addr-tab .title')?.textContent === 'Bericht.pdf'`), 'UI shows PDF tab');
  assert.equal(pdfRequests, 1, 'PDF downloaded exactly once');
  console.log('PASS: PDF opens in the Glass viewer, keeps its address and is downloaded once.');

  // Liquid Glass wie in der Oberfläche: Linse auf jeder Kapsel, Glanzkante, Wallpaper deckungsgleich mit dem Desktop
  await waitFor(() => page(`[...document.querySelectorAll('#dock .glass')].every(el => el.style.backdropFilter.startsWith('url(#lens-'))`), 'lens on dock capsules');
  assert.ok(await page(`document.querySelectorAll('#dock svg.glass-rim').length === 4 && [...document.querySelectorAll('#dock .well')].every(w => w.style.backgroundPosition)`), 'glass rims');
  await waitFor(() => page(`!!document.getElementById('wall').style.transform`), 'wallpaper geometry from main.rs');
  const wallOffset = await page(`document.getElementById('wall').style.transform`);
  assert.ok(wallOffset.startsWith('translate3d('), 'wallpaper is positioned');
  await page(`document.getElementById('container').scrollTop = 0`);
  // Sichtbar: nichts Deckendes zwischen Wallpaper und Seiten (ein Hintergrund auf body läge darüber)
  if (await page(`!!document.body.dataset.wall && document.getElementById('wall').width > 0`)) {
    await waitFor(() => page(`document.getElementById('wall').classList.contains('ready')`), 'wallpaper baked');
  }
  assert.equal(await page(`getComputedStyle(document.body).backgroundImage + getComputedStyle(document.body).backgroundColor`), 'nonergba(0, 0, 0, 0)', 'body stays transparent over the wallpaper');
  console.log(`PASS: dock capsules use the shared lens and rim; wallpaper placed at ${wallOffset}.`);

  // Suche
  await page(`document.getElementById('search').click(); const i = document.getElementById('find-input'); i.value = 'suchwort'; i.dispatchEvent(new Event('input'));`);
  await waitFor(async () => (await page(`document.getElementById('find-count').textContent`)) === '1 von 1', 'search result');
  await waitFor(() => page(`!!document.querySelector('.textLayer .highlight')`), 'search highlight');
  assert.equal(await page(`document.getElementById('page').value`), '2', 'search jumps to page 2');
  console.log('PASS: search finds the word, highlights it and jumps to its page.');

  // Seitenleiste, Zoom, dunkle Seiten
  // Beim Öffnen: Seitenleiste offen, Originalgröße
  assert.ok(await page(`document.body.classList.contains('sidebar-open')`), 'sidebar open by default');
  assert.equal(await page(`document.getElementById('zoom-value').textContent`), '100 %', 'opens at 100 %');
  await waitFor(() => page(`document.querySelectorAll('#thumbs .thumb canvas').length === 3`), 'thumbnails');
  const before = await page(`document.getElementById('zoom-value').textContent`);
  await page(`document.getElementById('zoom-in').click()`);
  await waitFor(async () => (await page(`document.getElementById('zoom-value').textContent`)) !== before, 'zoom in');
  await page(`document.getElementById('theme').click()`);
  assert.ok(await page(`document.body.classList.contains('dark')`));
  console.log('PASS: thumbnails, zoom and dark pages work.');

  // Neu laden: wieder der Viewer (die Bytes gibt es nur einmal – die Antwort wird erneut abgefangen)
  await page(`location.reload()`);
  await delay(300);
  await viewerReady(page);
  console.log('PASS: reload opens the viewer again.');

  // Link mit target=_blank auf ein PDF: neuer Tab, auch dort der Viewer
  await page(`location.href = ${JSON.stringify(origin + '/links')}`);
  await waitFor(() => page(`!!document.getElementById('pdf')`), 'link page');
  await page(`document.getElementById('pdf').click()`);
  let second;
  await waitFor(async () => { second = (await targets()).find(t => t.url.endsWith('/Zweites%20Dokument.pdf')); return !!second; }, 'new tab');
  const tab2 = await connect(second);
  await viewerReady(tab2);
  assert.equal(await tab2(`document.title`), 'Zweites Dokument.pdf');
  console.log('PASS: a PDF opened in a new tab uses the viewer too.');

  const problems = page.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !e.params.entry.url?.endsWith('/favicon.ico')).map(e => `${e.params.entry.text} ${e.params.entry.url || ''}`);
  assert.deepEqual(problems, [], 'no console errors (CSP, loading)');
  console.log('PASS: no CSP or loading errors.');
} finally {
  clearTimeout(watchdog);
  sockets.forEach(s => s.close());
  app.kill();
  server.close();
}
