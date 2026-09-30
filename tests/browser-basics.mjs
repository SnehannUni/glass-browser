// Grundfunktionen end to end: Sitzung wiederherstellen, geschlossenen Tab wieder öffnen, Verlauf (Vorschläge und
// Strg+H), Suchen auf der Seite, Zoom je Website, Tastenkürzel.
// Run after `cargo build`, using Node 22+ on Windows. No npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

await mkdir('target/basics-smoke', { recursive: true });
const profile = await mkdtemp(resolve('target/basics-smoke/profile-'));
const page = (title, body = '') => `<!doctype html><title>${title}</title><body style="font:16px sans-serif">${body}</body>`;
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/favicon.ico') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  if (path === '/alpha') res.end(page('Alpha Seite', '<p>Glasfenster und Glastür</p><p>noch ein Glas</p><p>kein Treffer hier</p>'));
  else if (path === '/beta') res.end(page('Beta Seite', '<p>beta</p><p><a id="link" href="/delta">Delta-Link</a></p>'));
  else res.end(page(`Seite ${path}`));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const origin2 = `http://localhost:${server.address().port}`; // anderer Host für den Zoom

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
  await delay(1500);
}
const watchdog = setTimeout(() => { app?.kill(); process.exit(1); }, 120000);
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
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  evaluate.rightClick = async selector => {
    const { x, y } = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x, y, button: 'right', clickCount: 1 });
  };
  evaluate.gesture = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result.value;
  evaluate.key = async (key, code, modifiers = 2) => {
    for (const type of ['rawKeyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
  };
  return evaluate;
}
async function attach(match, label) {
  let target;
  await waitFor(async () => (target = (await targets()).find(t => t.type === 'page' && match(t.url))), label);
  return connect(target);
}
const send = (cmd, extra = {}) => `window.ipc.postMessage(JSON.stringify(${JSON.stringify({ cmd, ...extra })}))`;
const tabs = `state.tabs.map(t => t.title + '|' + t.url)`;
const uiState = (expr) => `(() => { const state = window.__state?.() || { tabs: [] }; try { return ${expr}; } catch { return false; } })()`;

try {
  await launch([`${origin}/alpha`]);
  let ui = await attach(u => u.startsWith('http://glass.localhost/'), 'UI');
  await waitFor(() => ui(`typeof window.render === 'function'`), 'UI ready');
  // Zustand der Oberfläche von außen lesen
  await ui(`(() => { const r = window.render; window.render = (s) => { window.__s = s; r(s); }; window.__state = () => window.__s; })()`);
  await ui(send('ready'));
  await waitFor(() => ui(uiState(`state.tabs[0]?.title === 'Alpha Seite'`)), 'alpha loaded');

  // 1. Suchen auf der Seite
  await ui(`window.uiAction('find')`);
  await waitFor(() => ui(`document.getElementById('findbar').classList.contains('open')`), 'find bar open');
  await ui(`(() => { const i = document.getElementById('find-input'); i.value = 'glas'; i.dispatchEvent(new Event('input')); })()`);
  await waitFor(() => ui(`document.getElementById('find-count').textContent === '1 von 3'`), 'find count 1 von 3');
  await ui(`document.getElementById('find-next').click()`);
  await waitFor(() => ui(`document.getElementById('find-count').textContent === '2 von 3'`), 'find next');
  await ui(`(() => { const i = document.getElementById('find-input'); i.value = 'xyzzy'; i.dispatchEvent(new Event('input')); })()`);
  await waitFor(() => ui(`document.getElementById('find-count').textContent === 'Keine Treffer'`), 'no match');
  await ui(`document.getElementById('find-close').click()`);

  // 2. Zweiter Tab, Verlauf, Zoom je Website
  await ui(send('new_tab'));
  await ui(send('navigate', { value: `${origin}/beta` }));
  await waitFor(() => ui(uiState(`state.tabs[1]?.title === 'Beta Seite'`)), 'beta loaded');
  await ui(send('zoom_in'));
  await waitFor(() => ui(uiState(`Math.abs(state.tabs[1].zoom - 1.1) < .01`)), 'zoom 110');
  // Strg+= in der Seite zoomt weiter (WebView2 selbst), die Anzeige folgt
  { const b = await attach(u => u === `${origin}/beta`, 'beta'); await b.key('=', 'Equal'); }
  await waitFor(() => ui(uiState(`Math.abs(state.tabs[1].zoom - 1.25) < .01`)), 'ctrl+= zoom 125');
  await waitFor(() => ui(`document.getElementById('btn-zoom').textContent === '125 %' && !document.getElementById('btn-zoom').hidden`), 'zoom pill');
  await ui(send('navigate', { value: `${origin2}/gamma` }));
  await waitFor(() => ui(uiState(`state.tabs[1]?.url.startsWith('${origin2}') && Math.abs(state.tabs[1].zoom - 1) < .01`)), 'other host resets zoom');
  await ui(send('navigate', { value: `${origin}/beta` }));
  await waitFor(() => ui(uiState(`state.tabs[1]?.title === 'Beta Seite' && Math.abs(state.tabs[1].zoom - 1.25) < .01`)), 'zoom remembered per host');
  const hist = await ui(`fetch('/history?q=alpha&limit=5').then(r => r.json())`);
  assert.equal(hist[0]?.title, 'Alpha Seite', 'history finds alpha');
  // Vorschläge im Adressfeld
  await ui(`(() => { window.focusAddress(); const i = document.getElementById('addr-input'); i.value = 'alph'; i.dispatchEvent(new Event('input')); })()`);
  await waitFor(() => ui(`[...document.querySelectorAll('#suggest .sg-url')].some(e => e.textContent.includes('/alpha'))`), 'page suggestion');
  await ui(`document.getElementById('addr-input').blur()`);
  // Strg+H
  await ui(`window.uiAction('history')`);
  await waitFor(() => ui(`document.querySelectorAll('#hs-list .fv').length >= 3 && document.querySelector('#hs-list .hs-day')?.textContent === 'Heute'`), 'history panel');
  await ui(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

  // 3. Tab schließen und wieder öffnen (Strg+Umschalt+T)
  await ui(send('close_tab'));
  await waitFor(() => ui(uiState(`state.tabs.length === 1`)), 'closed');
  await ui(send('reopen_tab'));
  await waitFor(() => ui(uiState(`state.tabs.length === 2 && state.tabs[1].title === 'Beta Seite' && state.tabs[1].page`)), 'reopened at its place');
  // Strg+1 aus der Seite heraus
  const beta = await attach(u => u === `${origin}/beta`, 'beta target');
  await beta.key('1', 'Digit1');
  await waitFor(() => ui(uiState(`state.active === state.tabs[0].id`)), 'ctrl+1');

  // 5. Rechtsklick auf einen Link: Glas-Menü mit eigenen und WebView2-Einträgen
  await ui(send('tab_2'));
  await waitFor(() => ui(uiState(`state.active === state.tabs[1].id`)), 'back on beta');
  await beta.rightClick('#link');
  await waitFor(() => ui(`document.getElementById('ctx-menu').classList.contains('open')`), 'context menu open');
  const labels = await ui(`[...document.querySelectorAll('#ctx-menu .cm-item')].map(b => b.firstChild.textContent)`);
  console.log('menu', labels.join(' | '));
  assert.ok(labels.includes('Link in neuem Tab öffnen') && labels.includes('Link kopieren'), 'link entries');
  assert.ok(!labels.some(l => /fenster|window/i.test(l)), 'no new-window entry');
  await ui(`[...document.querySelectorAll('#ctx-menu .cm-item')].find(b => b.textContent.startsWith('Link in neuem Tab')).click()`);
  await waitFor(() => ui(uiState(`state.tabs.length === 3 && state.tabs[2].url.endsWith('/delta') && state.active === state.tabs[1].id`)), 'link opened in background tab');
  await ui(send('close_tab', { id: await ui(uiState('state.tabs[2].id')) }));
  await waitFor(() => ui(uiState(`state.tabs.length === 2`)), 'background tab closed');
  // Esc schließt ohne Auswahl, die Seite bleibt bedienbar
  await beta.rightClick('#link');
  await waitFor(() => ui(`document.getElementById('ctx-menu').classList.contains('open')`), 'menu again');
  await ui(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await waitFor(() => ui(`!document.getElementById('ctx-menu').classList.contains('open')`), 'menu closed');

  // 6. Berechtigungen: Glas-Leiste statt WebView2-Dialog, Antwort je Website gemerkt
  const asked = beta.gesture(`Notification.requestPermission()`);
  await waitFor(() => ui(`document.getElementById('perm').classList.contains('open')`), 'permission prompt');
  assert.match(await ui(`document.getElementById('perm-text').textContent`), /127\.0\.0\.1 möchte dir Mitteilungen senden/);
  await ui(`document.getElementById('perm-allow').click()`);
  assert.equal(await asked, 'granted');
  await waitFor(() => ui(`!document.getElementById('perm').classList.contains('open')`), 'prompt closed');
  const denied = beta.gesture(`new Promise(r => navigator.geolocation.getCurrentPosition(() => r('ok'), (e) => r('error ' + e.code)))`);
  await waitFor(() => ui(`document.getElementById('perm-text').textContent.includes('Standort')`), 'geolocation prompt');
  await ui(`document.getElementById('perm-deny').click()`);
  assert.equal(await denied, 'error 1', 'geolocation denied');
  const sites = JSON.parse(await readFile(resolve(profile, 'GlassBrowser/sites.json'), 'utf8'));
  assert.deepEqual(sites.permissions[origin], { notifications: true, geolocation: false });
  // Nach dem Neuladen fragt dieselbe Website nicht noch einmal
  await beta(`location.reload()`);
  await delay(800);
  const again = await attach(u => u === `${origin}/beta`, 'beta after reload');
  await waitFor(() => again(`document.readyState === 'complete'`), 'reloaded');
  assert.equal(await again.gesture(`new Promise(r => navigator.geolocation.getCurrentPosition(() => r('ok'), (e) => r('error ' + e.code)))`), 'error 1');
  assert.equal(await ui(`document.getElementById('perm').classList.contains('open')`), false, 'no second prompt');

  // 7. Seiteninfo: Verbindung, Zoom, Werbeblocker, gemerkte Berechtigungen – eine davon wieder vergessen
  await ui(`document.getElementById('btn-site').click()`);
  await waitFor(() => ui(`document.querySelector('#site-info.open .si-host')?.textContent === '127.0.0.1'`), 'site info open');
  const info = await ui(`[...document.querySelectorAll('#site-info .si-label')].map(e => e.textContent)`);
  assert.deepEqual(info.sort(), ['Mitteilungen', 'Standort', 'Werbeblocker', 'Zoom']);
  assert.match(await ui(`document.querySelector('#site-info .si-sub').textContent`), /nicht sicher/);
  await ui(`[...document.querySelectorAll('#site-info .si-row')].find(r => r.textContent.includes('Standort')).querySelector('.rm').click()`);
  await waitFor(async () => !(await ui(`document.getElementById('site-info').textContent`)).includes('Standort'), 'permission forgotten');
  await ui(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

  // 8. Einstellungen: Abschnitte da, „Tabs wiederherstellen“ landet in settings.json
  await ui(`window.uiAction('settings')`);
  await waitFor(() => ui(`document.querySelectorAll('#st-body .si-title').length >= 7`), 'settings rendered');
  console.log('settings', await ui(`[...document.querySelectorAll('#st-body .si-title')].map(e => e.textContent).join(' | ')`));
  assert.ok((await ui(`document.getElementById('st-body').textContent`)).includes('Downloads'), 'download dir shown');
  await ui(`document.querySelector('#st-body .switch').click()`);
  await waitFor(async () => {
    try { return JSON.parse(await readFile(resolve(profile, 'GlassBrowser/settings.json'), 'utf8')).restoreSession === false; } catch { return false; }
  }, 'restore setting saved');
  await ui(`document.querySelector('#st-body .switch').click()`); // wieder an – der Neustart unten braucht es
  await waitFor(async () => JSON.parse(await readFile(resolve(profile, 'GlassBrowser/settings.json'), 'utf8')).restoreSession === true, 'restore back on');
  await ui(`document.getElementById('st-close').click()`);
  assert.equal(await ui(`document.body.classList.contains('modal')`), false);

  // 4. Neustart: beide Tabs sind wieder da, der aktive lädt, der andere erst beim Anschauen
  const session = JSON.parse(await readFile(resolve(profile, 'GlassBrowser/session.json'), 'utf8'));
  assert.equal(session.tabs.length, 2);
  await quit();
  await launch([]);
  ui = await attach(u => u.startsWith('http://glass.localhost/'), 'UI after restart');
  await waitFor(() => ui(`typeof window.render === 'function'`), 'UI ready after restart');
  await ui(`(() => { const r = window.render; window.render = (s) => { window.__s = s; r(s); }; window.__state = () => window.__s; })()`);
  await ui(send('ready'));
  // Aktiv war zuletzt Beta: die lädt sofort, Alpha erst beim Anschauen
  await waitFor(() => ui(uiState(`state.tabs.length === 2 && state.active === state.tabs[1].id && state.tabs[1].page && state.tabs[1].title === 'Beta Seite'`)), 'session restored');
  assert.equal(await ui(uiState(`state.tabs[0].page`)), false, 'background tab not loaded yet');
  assert.equal(await ui(uiState(`state.tabs[0].title`)), 'Alpha Seite', 'title kept');
  assert.equal((await targets()).some(t => t.url === `${origin}/alpha`), false, 'no webview for lazy tab');
  await ui(send('prev_tab'));
  await waitFor(() => ui(uiState(`state.tabs[0].page && state.tabs[0].title === 'Alpha Seite'`)), 'lazy tab loads on activation');
  console.log('browser basics test passed');
} finally {
  clearTimeout(watchdog);
  sockets.forEach(ws => ws.close());
  app?.kill();
  server.close();
}
