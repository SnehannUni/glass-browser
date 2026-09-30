// Downloads end to end: symbol appears only after a download, progress ring, list, cancel, popup tabs close again,
// history survives a restart while the symbol stays hidden until the next download.
// Run after `cargo build`, using Node 22+ on Windows. No npm dependencies.
// The files land in the real Downloads folder (WebView2's default); the test deletes the ones it created.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

await mkdir('target/downloads-smoke', { recursive: true });
const profile = await mkdtemp(resolve('target/downloads-smoke/profile-'));
const tag = `glass-download-test-${Date.now().toString(36)}`;
const fixture = `<!doctype html><title>Downloads</title>
  <a id="slow" href="/slow.bin">slow</a> <a id="nolen" href="/nolen.zip">nolen</a>
  <a id="cancel" href="/cancel.bin">cancel</a> <a id="popup" href="/popup.pdf" target="_blank">popup</a>`;
const attach = (name, extra = {}) => ({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${tag}-${name}"`, ...extra });
// Schickt `total` Bytes in Stücken von `chunk` alle `every` ms
function trickle(res, total, chunk, every) {
  let sent = 0;
  const timer = setInterval(() => {
    if (res.destroyed) { clearInterval(timer); return; }
    const n = Math.min(chunk, total - sent);
    res.write(Buffer.alloc(n, 7)); sent += n;
    if (sent >= total) { clearInterval(timer); res.end(); }
  }, every);
}
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/slow.bin') { res.writeHead(200, attach('slow.bin', { 'Content-Length': 1_500_000 })); trickle(res, 1_500_000, 100_000, 120); return; }
  if (path === '/nolen.zip') { res.writeHead(200, attach('nolen.zip')); trickle(res, 300_000, 100_000, 300); return; }
  if (path === '/cancel.bin') { res.writeHead(200, attach('cancel.bin', { 'Content-Length': 5_000_000 })); trickle(res, 5_000_000, 20_000, 200); return; }
  if (/^\/popup\d?\.pdf$/.test(path)) { res.writeHead(200, attach(path.slice(1), { 'Content-Length': 2048 })); res.end(Buffer.alloc(2048, 1)); return; }
  if (path === '/favicon.ico') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(fixture);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const sockets = [];
let app, port;
async function launch(args) {
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  port = probe.address().port;
  await new Promise(r => probe.close(r));
  app = spawn(resolve('target/debug/glass-browser.exe'), args, {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  });
}
async function quit() {
  sockets.splice(0).forEach(ws => ws.close());
  const done = new Promise(r => app.once('exit', r));
  app.kill();
  await done;
  await delay(1500); // WebView2 gibt den Datenordner erst etwas später frei
}
const watchdog = setTimeout(() => { app?.kill(); process.exit(1); }, 90000);
async function waitFor(check, label, tries = 200) {
  for (let i = 0; i < tries; i++) { if (await check()) return; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return []; }
}
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl); sockets.push(ws);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  let seq = 0; const pending = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data), p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); }
  };
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  // Echter Mausklick: Chromium lässt weitere Downloads einer Seite nur nach einer Nutzer-Geste zu
  evaluate.click = async selector => {
    const { x, y } = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  return evaluate;
}
async function attach2(match, label) {
  let target;
  await waitFor(async () => (target = (await targets()).find(t => t.type === 'page' && match(t.url))), label);
  return connect(target);
}
const rows = `[...document.querySelectorAll('#downloads .dlr')].map(r => ({ name: r.querySelector('.dl-name').textContent, cls: r.className, meta: r.querySelector('.dl-meta').textContent }))`;
const created = new Set(); // tatsächliche Pfade (der Downloads-Ordner kann verlegt sein)
const saved = async () => {
  const list = JSON.parse(await readFile(resolve(profile, 'GlassBrowser/downloads.json'), 'utf8').catch(() => '[]'));
  list.forEach(d => { if (basename(d.path).startsWith(tag)) created.add(d.path); });
  return list;
};

try {
  await launch([origin]);
  const ui = await attach2(u => u.startsWith('http://glass.localhost/'), 'UI target');
  const page = await attach2(u => u.startsWith(origin), 'page target');
  await waitFor(() => page(`document.readyState === 'complete' && !!document.getElementById('slow')`), 'fixture loaded');
  await waitFor(() => ui(`typeof window.setDownloads === 'function'`), 'UI ready');
  assert.equal(await ui(`document.getElementById('btn-downloads').hidden`), true, 'symbol hidden before any download');

  // 1. Download mit bekannter Größe: Symbol erscheint, der Ring füllt sich, die Liste zeigt den Fortschritt
  await page.click('#slow');
  await waitFor(() => ui(`!document.getElementById('btn-downloads').hidden && document.getElementById('btn-downloads').classList.contains('busy')`), 'symbol busy');
  await ui(`document.getElementById('btn-downloads').click()`);
  await waitFor(() => ui(`document.getElementById('downloads').classList.contains('open')`), 'panel open');
  await waitFor(async () => (await ui(rows)).some(r => r.cls.includes('progress') && / von /.test(r.meta)), 'progress row');
  await waitFor(() => ui(`parseFloat(document.querySelector('#btn-downloads .dl-ring').style.strokeDasharray) > 5`), 'ring fills');
  await waitFor(async () => (await ui(rows)).some(r => r.name === `${tag}-slow.bin` && r.cls.includes('done')), 'slow done', 300);
  assert.equal(await ui(`document.getElementById('btn-downloads').classList.contains('busy')`), false, 'ring gone after completion');
  console.log('rows after first download', await ui(rows));

  // 2. Ohne Content-Length: kreisender Bogen
  await page.click('#nolen');
  await waitFor(() => ui(`document.getElementById('btn-downloads').classList.contains('unknown')`), 'unknown size');
  await waitFor(async () => (await ui(rows)).some(r => r.name === `${tag}-nolen.zip` && r.cls.includes('done')), 'nolen done', 300);

  // 3. Abbrechen: Eintrag verschwindet
  await page.click('#cancel');
  await waitFor(async () => (await ui(rows)).some(r => r.name === `${tag}-cancel.bin` && r.cls.includes('progress')), 'cancel running');
  await ui(`[...document.querySelectorAll('#downloads .dlr.progress')].find(r => r.textContent.includes('cancel.bin')).querySelector('.dl-act').click()`);
  await waitFor(async () => !(await ui(rows)).some(r => r.name.includes('cancel.bin')), 'canceled row removed');

  // 4. Download aus einem neuen Tab: der Tab schließt wieder, die Seite bleibt
  const tabs = `document.querySelectorAll('#tabs .tab').length`;
  assert.equal(await ui(tabs), 1);
  await page.click('#popup');
  await waitFor(async () => (await ui(rows)).some(r => r.name === `${tag}-popup.pdf` && r.cls.includes('done')), 'popup done');
  await waitFor(async () => (await ui(tabs)) === 1, 'popup tab closed');
  assert.equal(await page(`location.href`), `${origin}/`, 'page stays');

  // 5. Tab schließen, während ein Download läuft: der Download lädt weiter
  await page.click('#cancel');
  const received = async () => (await ui(rows)).find(r => r.name === `${tag}-cancel.bin` && r.cls.includes('progress'))?.meta;
  await waitFor(async () => !!(await received()), 'second cancel running');
  await ui(`window.ipc.postMessage(JSON.stringify({ cmd: 'close_tab' }))`);
  await waitFor(() => ui(`document.body.classList.contains('start')`), 'tab closed');
  const before = await received();
  await delay(1200);
  const after = await received();
  assert.ok(after && after !== before, `download continues after closing its tab (${before} → ${after})`);
  await ui(`document.getElementById('downloads').classList.contains('open') || document.getElementById('btn-downloads').click()`);
  await waitFor(() => ui(`!!document.querySelector('#downloads.open .dlr.progress .dl-act')`), 'cancel button');
  await ui(`document.querySelector('#downloads .dlr.progress .dl-act').click()`);
  await waitFor(async () => !(await ui(rows)).some(r => r.name.includes('cancel.bin')), 'parked download canceled');

  const list = await saved();
  assert.deepEqual(list.map(d => basename(d.path)).sort(), [`${tag}-nolen.zip`, `${tag}-popup.pdf`, `${tag}-slow.bin`].sort(), 'history saved');
  await quit();

  // 6. Neustart: Symbol weg, bis wieder etwas heruntergeladen wird – dann steht die ganze Liste darunter
  await launch([]);
  const ui2 = await attach2(u => u.startsWith('http://glass.localhost/'), 'UI target after restart');
  await waitFor(() => ui2(`typeof window.setDownloads === 'function' && document.body.classList.contains('start')`), 'UI ready after restart');
  await delay(500);
  assert.equal(await ui2(`document.getElementById('btn-downloads').hidden`), true, 'symbol hidden after restart');
  // Eingetippte Adresse, die nur ein Download ist: der Tab wird wieder leer (Startbildschirm)
  await ui2(`window.ipc.postMessage(JSON.stringify({ cmd: 'navigate', value: ${JSON.stringify(`${origin}/popup2.pdf`)} }))`);
  await waitFor(() => ui2(`!document.getElementById('btn-downloads').hidden`), 'symbol back after new download');
  await waitFor(() => ui2(`document.body.classList.contains('start')`), 'tab empty again');
  await ui2(`document.getElementById('btn-downloads').click()`);
  await waitFor(async () => (await ui2(rows)).filter(r => r.cls.includes('done')).length === 4, 'old and new downloads listed');
  console.log('rows after restart', await ui2(rows));
  // Liste leeren
  await saved();
  await ui2(`document.querySelector('#downloads .dl-clear').click()`);
  await waitFor(async () => (await ui2(rows)).length === 0, 'list cleared');
  assert.equal((await saved()).length, 0, 'history cleared on disk');
  console.log('downloads test passed');
} finally {
  clearTimeout(watchdog);
  sockets.forEach(ws => ws.close());
  app?.kill();
  server.close();
  // Nur die eigenen Testdateien entfernen
  const home = process.env.USERPROFILE;
  for (const name of ['slow.bin', 'nolen.zip', 'popup.pdf', 'popup2.pdf', 'cancel.bin']) created.add(resolve(home, 'Downloads', `${tag}-${name}`));
  for (const path of created) await rm(path, { force: true });
}
