// Native WebView2 regression: spinner must start before response headers arrive.
// Run after `cargo build`, using Node 22+ on Windows. No npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

await mkdir('target/navigation-smoke', { recursive: true });
const profile = await mkdtemp(resolve('target/navigation-smoke/profile-'));
let held;
const fixture = '<!doctype html><title>Navigation test</title><link rel="icon" href="/assets/icon.svg"><a id="next" href="/slow">Slow link</a><a id="redirect" href="/redirect">Redirect</a>';
const server = createServer((req, res) => {
  if (req.url.startsWith('/assets/')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${req.url.includes('second') ? 'blue' : 'red'}"/></svg>`); return;
  }
  if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; }
  if (req.url === '/slow') { held = res; return; }
  if (req.url === '/redirect') { res.writeHead(302, { Location: '/slow' }); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(fixture);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const portProbe = createServer();
await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const port = portProbe.address().port;
await new Promise(r => portProbe.close(r));
const app = spawn(resolve('target/debug/glass-browser.exe'), [origin], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const sockets = [];
const watchdog = setTimeout(() => { app.kill(); process.exit(1); }, 45000);
async function waitFor(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(50); }
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
try {
  let targets;
  await waitFor(async () => {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
    catch { return false; }
    return targets.some(t => t.url.startsWith(origin)) && targets.some(t => t.url.includes('glass.localhost'));
  }, 'browser startup');
  const ui = await connect(targets.find(t => t.url.includes('glass.localhost')));
  const page = await connect(targets.find(t => t.url.startsWith(origin)));
  await waitFor(() => ui(`!!document.getElementById('address') && !!document.querySelector('.tab')`), 'UI rendered');
  const loading = () => ui(`!!document.querySelector('.tab .spinner') && document.getElementById('address').classList.contains('loading') && document.getElementById('btn-reload').title === 'Laden stoppen'`);
  const idle = () => ui(`!document.querySelector('.tab .spinner') && !document.getElementById('address').classList.contains('loading')`);
  const command = cmd => ui(`window.ipc.postMessage(JSON.stringify({cmd:${JSON.stringify(cmd)}}))`);
  const release = () => { held.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); held.end(fixture); held = null; };
  await waitFor(idle, 'initial load completed');
  const icon = () => ui(`document.querySelector('.tab .fav img')?.getAttribute('src') || ''`);
  await waitFor(async () => (await icon()).startsWith('data:image/png;base64,'), 'declared SVG favicon reaches native UI as PNG');
  const initialIcon = await icon();
  await page(`document.querySelector('link[rel=icon]').href='/assets/second.svg'`);
  await waitFor(async () => { const current=await icon(); return current.startsWith('data:image/png;base64,') && current!==initialIcon; }, 'dynamic favicon update');
  console.log('PASS: declared SVG icon works without /favicon.ico; dynamic icon changes update the tab.');
  await page(`document.getElementById('next').click()`);
  await waitFor(() => !!held, 'link request received');
  await waitFor(loading, 'spinner while response headers are pending');
  release();
  await waitFor(idle, 'spinner stops after completion');
  console.log('PASS: in-page link shows spinner before server response and clears on completion.');
  await page(`document.getElementById('redirect').click()`);
  await waitFor(() => !!held, 'redirect target requested');
  await waitFor(loading, 'spinner survives redirect');
  release();
  await waitFor(idle, 'redirect completed');
  await command('reload');
  await waitFor(() => !!held, 'reload requested');
  await waitFor(loading, 'reload spinner');
  await command('stop');
  await waitFor(idle, 'stop clears spinner');
  held.destroy(); held = null;
  console.log('PASS: redirect and reload show loading; stopping clears it.');
  await ui(`{const original=window.render;window.render=next=>{window.testState=next;original(next)}}`);
  await command('new_tab');
  await waitFor(() => ui(`window.testState?.tabs.length===2`), 'second tab created');
  await ui(`window.ipc.postMessage(JSON.stringify({cmd:'navigate',value:${JSON.stringify(origin + '/second')}}))`);
  await waitFor(() => ui(`testState.tabs.length===2 && testState.tabs.every(t=>!t.loading)`), 'second page loaded');
  await ui(`window.ipc.postMessage(JSON.stringify({cmd:'split',id:testState.tabs[0].id,target:testState.tabs[1].id,value:'left'}))`);
  await waitFor(() => ui(`testState.panes.length===2`), 'split shown');
  targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const second = await connect(targets.find(t => t.url === origin + '/second'));
  await delay(150);
  const widths = [await page('innerWidth'), await second('innerWidth')];
  const point = await ui(`(()=>{const r=document.getElementById('divider').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const mouse = (type,x=point.x) => ui.call('Input.dispatchMouseEvent',{type,x,y:point.y,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1});
  await mouse('mousePressed');
  await waitFor(() => ui(`document.querySelectorAll('.resize-preview .snapshot[style]').length===2`), 'both native snapshots decoded');
  await mouse('mouseMoved',point.x+150);
  await delay(150);
  assert.deepEqual([await page('innerWidth'),await second('innerWidth')],widths,'websites retain their viewport while dragging');
  assert.equal(await ui(`document.querySelectorAll('.resize-preview .identity span').length`),2);
  assert.equal(await ui(`getComputedStyle(document.querySelector('.snapshot')).filter.includes('blur(30px)')`),true);
  await writeFile('target/navigation-smoke/split-preview.png', Buffer.from((await ui.call('Page.captureScreenshot',{})).data,'base64'));
  await mouse('mouseReleased',point.x+150);
  await waitFor(() => ui(`!document.querySelector('.resize-preview')`), 'preview removed after release');
  await waitFor(async () => await page('innerWidth')!==widths[0], 'native viewport resized at release');
  console.log('PASS: native snapshots, blurred identities, frozen viewports while dragging and final resize on release.');
  const nextPoint = await ui(`(()=>{const r=document.getElementById('divider').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await ui.call('Input.dispatchMouseEvent',{type:'mousePressed',...nextPoint,button:'left',buttons:1,clickCount:1});
  await waitFor(() => ui(`!!document.querySelector('.resize-preview')`), 'second drag starts');
  await ui(`window.dispatchEvent(new Event('blur'))`);
  await waitFor(() => ui(`!document.querySelector('.resize-preview')`), 'focus loss restores websites');
  await ui.call('Input.dispatchMouseEvent',{type:'mouseReleased',...nextPoint,button:'left',buttons:0,clickCount:1});
  await delay(200);
  assert.equal(await ui(`document.querySelectorAll('.resize-preview').length`),0,'late capture cannot reopen a finished preview');
  console.log('PASS: focus-loss cancellation clears preview and ignores late captures.');
} finally {
  clearTimeout(watchdog);
  for (const ws of sockets) ws.close();
  app.kill(); server.closeAllConnections(); server.close();
}
