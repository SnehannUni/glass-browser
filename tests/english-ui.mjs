// English UI: with GLASS_LANG=en the native UI (ui.html + ui-en.js) shows English text and no German is left.
// Run after `cargo build`, using Node 22+ on Windows. No npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

await mkdir('target/english-smoke', { recursive: true });
const profile = await mkdtemp(resolve('target/english-smoke/profile-'));
const fixture = '<!doctype html><title>English test</title><p>Hello</p>';
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(fixture);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const portProbe = createServer();
await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const port = portProbe.address().port;
await new Promise(r => portProbe.close(r));
const app = spawn(resolve('target/debug/glass-browser.exe'), [origin], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: profile, GLASS_LANG: 'en',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const sockets = [];
const watchdog = setTimeout(() => { app.kill(); process.exit(1); }, 60000);
async function waitFor(check, label, tries = 100) {
  for (let i = 0; i < tries; i++) { if (await check()) return; await delay(50); }
  throw new Error(`Timed out: ${label}`);
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
    const result = await call('Runtime.evaluate', {expression, returnByValue:true});
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  evaluate.call = call;
  return evaluate;
}
// All text of the UI, hidden parts included (menus, dialogs), plus the attributes that show up as tooltips or hints
const uiText = `(() => {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) if (!n.parentElement.closest('script, style')) out.push(n.nodeValue);
  document.querySelectorAll('[title], [aria-label], [placeholder]').forEach((el) =>
    out.push(el.getAttribute('title') || '', el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || ''));
  return out.join('\\n');
})()`;
const GERMAN = /[äöüÄÖÜß]|\b(Neuer|Schließen|Favoriten|Zurück|Vorwärts|Suchen|Laden|Leiste|Privat|Wiederherstellen|Maximieren|Minimieren|Festlegen|Später|installieren|Datenschutz|Verlauf|und|oder|eingeben|Strg|Umschalt|Noch|keine)\b/;
const assertEnglish = async (ui, where) => {
  const text = await ui(uiText);
  const line = text.split('\n').find((l) => GERMAN.test(l));
  assert.equal(line, undefined, `German text left ${where}: ${line}`);
};
try {
  let targets;
  await waitFor(async () => {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
    catch { return false; }
    return targets.some(t => t.url.startsWith(origin)) && targets.some(t => t.url.includes('glass.localhost'));
  }, 'browser startup');
  const ui = await connect(targets.find(t => t.url.includes('glass.localhost')));
  await waitFor(() => ui(`!!document.getElementById('address') && !!document.querySelector('.tab')`), 'UI rendered');
  await waitFor(() => ui(`!document.getElementById('address').classList.contains('loading')`), 'page loaded');
  assert.equal(await ui(`document.documentElement.lang`), 'en');
  const title = (id) => ui(`document.getElementById(${JSON.stringify(id)}).title`);
  assert.equal(await title('btn-reload'), 'Reload (F5)');
  assert.equal(await title('btn-new'), 'New tab (Ctrl+T)');
  assert.equal(await title('btn-back'), 'Back (Alt+←)');
  assert.equal(await title('win-close'), 'Close');
  assert.equal(await title('btn-favs'), 'Favorites');
  assert.equal(await title('btn-private'), 'New private tab (Ctrl+Shift+N)');
  assert.match(await title('btn-shield'), /^Ad blocker(: \d+ requests? blocked – click to turn it off| is off) on 127\.0\.0\.1/);
  assert.equal(await ui(`document.getElementById('toolbar-side').textContent.trim()`), '✓Toolbar on the left');
  assert.equal(await ui(`document.getElementById('up-later').textContent`), 'Later');
  await assertEnglish(ui, 'with a website open');
  console.log('PASS: html lang is en; toolbar, menus and dialogs are in English.');

  // Favorites: moving the mouse over the button opens the list (real mouse input, no .click())
  const fav = await ui(`(() => { const r = document.getElementById('btn-favs').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await ui.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fav.x, y: fav.y });
  await waitFor(() => ui(`document.getElementById('favs').classList.contains('open')`), 'favorites open on hover');
  assert.match(await ui(`document.getElementById('favs').textContent`), /^FavoritesNo favorites yet\. Click the star/);
  await assertEnglish(ui, 'in the favorites');
  await ui.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 300 });
  console.log('PASS: favorites list is in English.');

  // New tab: start screen with "New tab" and the English hint in the search field
  await ui(`window.ipc.postMessage(JSON.stringify({cmd:'new_tab'}))`);
  await waitFor(() => ui(`document.body.classList.contains('start')`), 'start screen');
  await waitFor(async () => (await ui(`[...document.querySelectorAll('.tab .title')].map(e => e.textContent).join('|')`)).includes('New tab'), 'new tab named "New tab"');
  assert.equal(await ui(`document.getElementById('addr-input').placeholder`), 'Search or enter a website name');
  assert.equal(await title('btn-private'), 'Browse privately (Ctrl+Shift+N)');
  assert.equal(await ui(`document.getElementById('btn-engine').title`), 'Search with Google – click to switch');
  await assertEnglish(ui, 'on the start screen');
  console.log('PASS: new tab, start screen and search hint are in English.');
} finally {
  clearTimeout(watchdog);
  for (const ws of sockets) ws.close();
  app.kill(); server.closeAllConnections(); server.close();
}
