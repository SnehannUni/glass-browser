// Run with Node 22+ on Windows. Uses the installed Edge; no npm dependencies.
// Prüft drawing-content.js: Zeichenmodus, Striche mit echten Mausereignissen, Radierer, Rückgängig, Speichern
// und Wiederherstellen nach dem Neuladen. Rust (drawing.rs) ersetzt hier ein kleiner Speicher im Test selbst.
// Das Shadow-DOM ist im Test offen, damit er die Striche zählen kann.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const watchdog = setTimeout(() => { console.error('drawing test exceeded 60 seconds'); process.exit(1); }, 60_000);

let script = await readFile(new URL('../src/drawing-content.js', import.meta.url), 'utf8');
assert.ok(script.includes("mode: 'closed'"), 'closed shadow root found');
script = script.replace("mode: 'closed'", "mode: 'open'");
const page = `<!doctype html><body style="margin:0;height:3000px;background:#fff"><h1>Test</h1>
  <input id=field><button id=b onclick="window.__clicked=(window.__clicked||0)+1" style="position:absolute;left:300px;top:300px">Knopf</button>`;
const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

await mkdir('target/drawing-test', { recursive: true });
const profile = await mkdtemp(resolve('target/drawing-test/profile-'));
const edge = spawn(process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1000,700',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
    catch { await delay(100); }
  }
  assert.ok(port, 'Edge started');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map(), errors = [];
  // Speicher wie drawing.rs: je Adresse ohne #
  const store = new Map();
  const sent = [];
  let run;
  ws.onmessage = async ({ data }) => {
    const m = JSON.parse(data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    if (m.method === 'Runtime.bindingCalled' && m.params.name === '__ipc') {
      const msg = JSON.parse(m.params.payload);
      sent.push(msg);
      if (msg.draw === 'save') store.set(msg.url, msg.strokes);
      if (msg.draw === 'load') {
        const reply = { url: msg.url, strokes: store.get(msg.url) ?? [] };
        run(`window.__glassDrawLoad(${JSON.stringify(reply)})`).catch(() => {});
      }
    }
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  run = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const mouse = (type, x, y) => call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const stroke = async (points) => {
    await mouse('mousePressed', ...points[0]);
    for (const p of points.slice(1)) await mouse('mouseMoved', ...p);
    await mouse('mouseReleased', ...points.at(-1));
  };
  const key = async (key, code, vk, text, modifiers = 0) => {
    await call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, text, modifiers });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const paths = () => run(`document.querySelector('glass-draw')?.shadowRoot.querySelectorAll('svg.ink path').length ?? 0`);
  const saved = () => store.get(`${origin}/seite`) ?? [];
  const waitSave = () => delay(600);

  await call('Runtime.enable');
  await call('Page.enable');
  await call('Runtime.addBinding', { name: '__ipc' });
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.ipc = { postMessage: (m) => window.__ipc(m) };\n${script}`,
  });
  await call('Page.navigate', { url: `${origin}/seite#oben` });
  await delay(600);

  // 1. Beim Laden fragt die Seite nach ihren Strichen (ohne #), nichts ist eingeblendet
  assert.deepEqual(sent[0], { draw: 'load', url: `${origin}/seite`, on: false });
  assert.equal(await paths(), 0);

  // 2. Ohne Zeichenmodus gehen Klicks an die Seite
  await mouse('mousePressed', 320, 310); await mouse('mouseReleased', 320, 310);
  assert.equal(await run('window.__clicked'), 1);

  // 3. Zeichenmodus an: Striche statt Klicks, der Stand geht an die Leiste
  await run('window.__glassDraw.toggle()');
  assert.deepEqual(sent.at(-1), { draw: 'state', url: `${origin}/seite`, on: true });
  await stroke([[300, 300], [330, 310], [360, 330], [400, 360]]);
  assert.equal(await run('window.__clicked'), 1, 'click did not reach the page');
  assert.equal(await paths(), 1);
  await waitSave();
  assert.equal(saved().length, 1);
  assert.equal(saved()[0].t, 'pen');
  assert.ok(saved()[0].p.length >= 8, 'points recorded');

  // 4. Nach dem Scrollen liegen Striche in Dokumentkoordinaten
  await run('scrollTo(0, 500)');
  await delay(50);
  await key('m', 'KeyM', 77, 'm'); // Textmarker
  await stroke([[100, 100], [200, 100]]);
  await waitSave();
  assert.equal(saved().length, 2);
  assert.equal(saved()[1].t, 'marker');
  assert.equal(saved()[1].p[1], 600, 'y includes scroll offset');

  // 5. Radierer entfernt den getroffenen Strich, Strg+Z holt ihn zurück
  await key('e', 'KeyE', 69, 'e');
  await stroke([[150, 90], [150, 110]]);
  await waitSave();
  assert.equal(saved().length, 1);
  assert.equal(saved()[0].t, 'pen');
  await key('z', 'KeyZ', 90, '', 2);
  await waitSave();
  assert.equal(saved().length, 2, 'undo restored the erased stroke');

  // 6. Esc beendet den Zeichenmodus, Klicks gehen wieder an die Seite, die Striche bleiben sichtbar
  await key('Escape', 'Escape', 27);
  assert.equal(sent.at(-1).on, false);
  await run('scrollTo(0, 0)');
  await delay(50);
  await mouse('mousePressed', 320, 310); await mouse('mouseReleased', 320, 310);
  assert.equal(await run('window.__clicked'), 2);
  assert.equal(await paths(), 2);

  // 7. Neu laden: Die gespeicherten Striche erscheinen wieder
  await call('Page.reload');
  await delay(800);
  assert.equal(await paths(), 2, 'drawing restored after reload');
  assert.equal(await run('window.__clicked ?? 0'), 0);

  // 8. Andere Adresse per pushState: eigene (leere) Zeichnung, zurück: wieder da
  await run(`history.pushState(null, '', '/andere')`);
  await delay(300);
  assert.equal(await paths(), 0);
  await run(`history.back()`);
  await delay(300);
  assert.equal(await paths(), 2);

  // 9. Alles löschen speichert eine leere Liste (Rust löscht dann die Datei)
  await run('window.__glassDraw.toggle()');
  await run(`document.querySelector('glass-draw').shadowRoot.querySelector('[data-act=clear]').click()`);
  await waitSave();
  assert.deepEqual(saved(), []);

  // 10. Seitenskripte können die Funktionen nicht überschreiben, fehlerhafte Daten werden ignoriert
  await run(`window.__glassDraw = null`);
  assert.equal(await run('typeof window.__glassDraw?.toggle'), 'function');
  await run(`window.__glassDrawLoad({ url: location.href.replace(/#.*$/, ''), strokes: [{ t: 'pen', c: 'red"/><script>', w: 3, p: [1, 2] }, { t: 'x' }] })`);
  assert.equal(await paths(), 0);

  assert.deepEqual(errors, []);
  console.log('drawing content test passed');
} finally {
  ws?.close();
  edge.kill();
  server.close();
  clearTimeout(watchdog);
}
