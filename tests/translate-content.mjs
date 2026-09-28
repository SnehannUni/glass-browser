// Run with Node 22+ on Windows. Uses the installed Edge; no npm dependencies.
// Prüft translate-content.js: Einheiten mit Platzhaltern, Einsetzen samt Umsortieren (dieselben Element-Knoten),
// Original wiederherstellen, nachgeladene Inhalte, „schon in der Zielsprache“ und Fehler. Google ersetzt hier ein
// Übersetzer im Test: Großbuchstaben, und das erste Element wandert ans Satzende – wie bei anderer Wortstellung.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const watchdog = setTimeout(() => { console.error('translate test exceeded 60 seconds'); process.exit(1); }, 60_000);
const script = await readFile(new URL('../src/translate-content.js', import.meta.url), 'utf8');
const page = `<!doctype html><title>Hello page</title><body>
  <p id=p1>Hello <a href="#" id=l>dear world</a> and <b>good friends</b>!</p>
  <pre id=code>let hello = "world";</pre>
  <p id=p2>Use <code>npm install</code> to start.</p>
  <a id=card href="#"><div>Card title</div><div>Card text</div></a>
  <div id=box>Before block<div>Inner block</div>after block</div>
  <p translate="no" id=keep>Brand Name</p>
  <input id=field placeholder="Search here">`;
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "require-trusted-types-for 'script'" });
  res.end(page);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// Übersetzer im Test: Text außerhalb der Tags groß, erstes <a i=N>…</a> ans Ende
let mode = 'ok'; // 'ok' | 'same' | 'error' | 'broken'
function fakeTranslate(html) {
  const upper = html.replace(/(^|>)([^<]*)/g, (m, a, t) => a + t.toUpperCase().replace(/&AMP;/g, '&amp;').replace(/&LT;/g, '&lt;').replace(/&GT;/g, '&gt;'));
  const m = upper.match(/<a i=(\d+)>(?:[^<]|<a i=\d+><\/a>)*<\/a>/);
  if (mode === 'broken') return upper.replace(/<a i=\d+>|<\/a>/g, '');
  return m ? upper.replace(m[0], '').trimEnd() + ' ' + m[0] : upper;
}

await mkdir('target/translate-test', { recursive: true });
const profile = await mkdtemp(resolve('target/translate-test/profile-'));
const edge = spawn(process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
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
  let seq = 0, run;
  const pending = new Map(), errors = [], sent = [];
  ws.onmessage = async ({ data }) => {
    const m = JSON.parse(data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    if (m.method === 'Runtime.bindingCalled' && m.params.name === '__ipc') {
      const msg = JSON.parse(m.params.payload);
      sent.push(msg);
      if (msg.tr === 'batch') {
        const result = mode === 'error' ? null
          : msg.texts.map((t) => mode === 'same' ? [t, 'de'] : [fakeTranslate(t), 'en']);
        setTimeout(() => run(`window.__glassTranslated(${JSON.stringify(msg.id)}, ${JSON.stringify(result)})`).catch(() => {}), 20);
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
  const text = (id) => run(`document.getElementById(${JSON.stringify(id)}).textContent.replace(/\\s+/g, ' ').trim()`);
  const lastState = () => sent.filter((m) => m.tr === 'state').at(-1);

  await call('Runtime.enable');
  await call('Page.enable');
  await call('Runtime.addBinding', { name: '__ipc' });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.ipc = { postMessage: (m) => window.__ipc(m) };\n${script}` });
  await call('Page.navigate', { url: `${origin}/seite` });
  await delay(500);
  const original = await run('document.body.innerHTML');
  await run(`window.__link = document.getElementById('l'); window.__link.addEventListener('click', (e) => { e.preventDefault(); window.__clicks = (window.__clicks || 0) + 1; })`);

  // 1. Übersetzen: ganze Sätze, Link wandert ans Ende und ist derselbe Knoten, Code und translate=no bleiben
  await run(`window.__glassTranslate.on('de')`);
  await delay(300);
  assert.equal(await text('p1'), 'HELLO AND GOOD FRIENDS! DEAR WORLD');
  assert.equal(await run(`document.querySelector('#p1 > :last-child') === window.__link`), true, 'link moved, same node');
  await run(`window.__link.click()`);
  assert.equal(await run('window.__clicks'), 1, 'click handler survived');
  assert.equal(await text('code'), 'let hello = "world";');
  assert.equal(await run(`document.querySelector('#p2 code').textContent`), 'npm install', 'inline code untouched');
  assert.match(await text('p2'), /^USE TO START\. npm install$/);
  assert.equal(await text('keep'), 'Brand Name');
  assert.equal(await text('card'), 'CARD TITLECARD TEXT', 'blocks inside a link are separate units');
  assert.equal(await text('box'), 'BEFORE BLOCKINNER BLOCKAFTER BLOCK');
  assert.equal(await run('document.title'), 'HELLO PAGE');
  assert.deepEqual({ ...lastState(), tr: undefined }, { tr: undefined, lang: 'de', busy: false });
  // Batches sind HTML mit Platzhaltern
  const batch = sent.find((m) => m.tr === 'batch' && m.texts.some((t) => t.includes('dear world')));
  assert.ok(batch.texts.includes('Hello <a i=0>dear world</a> and <a i=1>good friends</a>!'), batch.texts.join(' | '));

  // 2. Nachgeladener Inhalt wird mitübersetzt
  await run(`document.body.insertAdjacentElement('beforeend', Object.assign(document.createElement('p'), { id: 'late', textContent: 'Loaded later' }))`);
  await delay(700);
  assert.equal(await text('late'), 'LOADED LATER');
  // Die Seite ändert einen übersetzten Text selbst → wird neu übersetzt
  await run(`document.getElementById('late').firstChild.data = 'Changed text'`);
  await delay(700);
  assert.equal(await text('late'), 'CHANGED TEXT');

  // 3. Original: exakt das alte DOM (bis auf den nachgeladenen Absatz, den es vorher nicht gab)
  await run(`window.__glassTranslate.off()`);
  await run(`document.getElementById('late').remove()`);
  assert.equal(await run('document.body.innerHTML'), original, 'original restored exactly');
  assert.equal(await run('document.title'), 'Hello page');
  assert.equal(lastState().lang, null);

  // 4. Google verschluckt Platzhalter: Textknoten einzeln übersetzt, Links bleiben an ihrem Platz
  mode = 'broken';
  await run(`window.__glassTranslate.on('de')`);
  await delay(400);
  assert.equal(await text('p1'), 'HELLO DEAR WORLD AND GOOD FRIENDS!');
  assert.equal(await run(`document.querySelector('#p1 a') === window.__link`), true);
  await run(`window.__glassTranslate.off()`);
  assert.equal(await run('document.body.innerHTML'), original);

  // 5. Schon in der Zielsprache: Hinweis, und der Knopf geht wieder aus
  mode = 'same';
  sent.length = 0;
  await run(`window.__glassTranslate.on('de')`);
  await delay(300);
  assert.ok(sent.some((m) => m.tr === 'same'));
  assert.equal(lastState().lang, null);
  assert.equal(await run('document.body.innerHTML'), original);

  // 6. Dienst nicht erreichbar: Fehler melden, nichts halb übersetzt lassen
  mode = 'error';
  sent.length = 0;
  await run(`window.__glassTranslate.on('de')`);
  await delay(300);
  assert.equal(sent.filter((m) => m.tr === 'error').length, 1);
  assert.equal(lastState().lang, null);
  assert.equal(await run('document.body.innerHTML'), original);

  // 7. Ungültige Sprache wird ignoriert, Seitenskripte können die Funktionen nicht ersetzen
  sent.length = 0;
  await run(`window.__glassTranslate.on('de&tl=x')`);
  assert.equal(sent.length, 0);
  await run('window.__glassTranslate = null');
  assert.equal(await run('typeof window.__glassTranslate?.on'), 'function');

  assert.deepEqual(errors, []);
  console.log('translate content test passed');
} finally {
  ws?.close();
  edge.kill();
  server.close();
  clearTimeout(watchdog);
}
