// Eine lokal geöffnete HTML-Datei (file:///…, etwa per Doppelklick oder „Öffnen mit“) darf den Browser nicht beenden.
// Früher las wry jede Nachricht einer Seite mit ihrer Adresse als http::Uri ein – `file:///` lässt sich so nicht
// lesen, und die erste window.ipc-Nachricht der Seite (Scrollen, Favicon, Ausblend-Regeln) brach das Programm ab.
// Run after `cargo build`, using Node 22+ on Windows. No npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

await mkdir('target/local-file-smoke', { recursive: true });
const profile = await mkdtemp(resolve('target/local-file-smoke/run-'));
// Mit Leerzeichen im Namen, wie Windows ihn nach `--single-argument` übergibt
const page = join(profile, 'Lokale Seite.html');
await writeFile(page, '<!doctype html><title>Lokal</title><h1>Lokale Seite</h1>');

const probe = createServer();
await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port;
await new Promise(r => probe.close(r));
let exited = null;
const app = spawn(resolve('target/debug/glass-browser.exe'), ['--single-argument', page], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: profile, GLASS_LANG: 'de',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
app.on('exit', (code) => { exited = code; });
const watchdog = setTimeout(() => { app.kill(); process.exit(1); }, 60000);
let ws;
try {
  let target;
  for (let i = 0; i < 300 && !target; i++) {
    await delay(100);
    assert.equal(exited, null, `Browser hat sich beim Start mit Code ${exited} beendet`);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = targets.find(t => t.url.startsWith('file:///') && t.url.endsWith('Lokale%20Seite.html'));
    } catch {}
  }
  assert.ok(target, 'die lokale Datei ist als Tab geladen');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  // Eine Nachricht, wie sie content.js beim Scrollen schickt
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `window.ipc.postMessage('scrolled'); true` } }));
  await delay(3000);
  assert.equal(exited, null, `Browser hat sich nach einer Nachricht der Seite mit Code ${exited} beendet`);
  console.log('PASS: a local HTML file opens as a tab and its window.ipc messages do not end the browser.');
} finally {
  clearTimeout(watchdog);
  ws?.close();
  app.kill();
}
