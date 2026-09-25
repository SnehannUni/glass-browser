// Native WebView2 favicon resolution regression: SVG, bitmap selection, fallback and DPI.
// Run after `cargo build`, using Node 22+ on Windows. No npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

await mkdir('target/favicon-smoke', { recursive: true });
const profile = await mkdtemp(resolve('target/favicon-smoke/profile-'));
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
  await waitFor(idle, 'initial load completed');
  const icon = () => ui(`document.querySelector('.tab .fav img')?.getAttribute('src') || ''`);
  await waitFor(async () => (await icon()).startsWith('data:image/png;base64,'), 'declared SVG favicon reaches native UI as PNG');
  // Inspect the PNG delivered to chrome, not just the declaration in the document.
  const dimensions = () => ui(`document.querySelector('.tab .fav img')?.naturalWidth || 0`);
  await waitFor(async () => await dimensions() === await page('Math.ceil(40 * devicePixelRatio - 1e-5)'), 'SVG rasterized for actual display density');
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 2, mobile: false });
  // WebView2 CDP emulation changes DPR without reliably emitting a native resize event.
  await page(`dispatchEvent(new Event('resize'))`);
  await waitFor(async () => await dimensions() === 80, 'DPR change rerasterizes SVG to 80px');
  console.log('PASS: scalable favicon tracks device pixel ratio.');

  await page(`(() => {
    document.querySelectorAll('link[rel=icon]').forEach(n => n.remove());
    for (const size of [16, 64, 128, 256]) {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const ctx = c.getContext('2d'); ctx.fillStyle = size === 128 ? '#00ff00' : '#ff0000'; ctx.fillRect(0,0,size,size);
      const link = document.createElement('link'); link.rel = 'icon'; link.sizes = size+'x'+size;
      link.href = c.toDataURL(); document.head.append(link);
    }
  })()`);
  const color = () => ui(`(() => {
    const img=document.querySelector('.tab .fav img'); if (!img?.complete || !img.naturalWidth) return '';
    const c=document.createElement('canvas'); c.width=c.height=1;
    const ctx=c.getContext('2d'); ctx.drawImage(img,0,0,1,1); return [...ctx.getImageData(0,0,1,1).data].join(',');
  })()`);
  await waitFor(async () => await dimensions() === 80 && await color() === '0,255,0,255', 'smallest adequate bitmap: 128px for 80px target');
  console.log('PASS: 128px bitmap selected over undersized 64px and oversized 256px.');

  await page(`document.querySelector('link[sizes="128x128"]').href='/broken.png'`);
  await waitFor(async () => await dimensions() === 80 && await color() === '255,0,0,255', 'broken best candidate falls back to next adequate bitmap');
  await page(`document.querySelectorAll('link[rel=icon]').forEach(n => { if (n.sizes.value !== '16x16') n.remove(); })`);
  await waitFor(async () => await dimensions() === 16, 'small bitmap is not artificially enlarged');
  console.log('PASS: failed candidates fall back; tiny source is not upscaled in the payload.');

  await page(`document.querySelectorAll('link[rel=icon]').forEach(n=>n.remove()); const l=document.createElement('link'); l.rel='icon'; l.href='/assets/second.svg'; document.head.append(l)`);
  await waitFor(async () => await dimensions() === 80 && await color() === '0,0,255,255', 'dynamic replacement restores scalable icon');
  await page.call('Emulation.clearDeviceMetricsOverride', {});
  await page(`dispatchEvent(new Event('resize'))`);
  await waitFor(async () => await dimensions() === await page('Math.ceil(40 * devicePixelRatio - 1e-5)'), 'return to monitor density');
  console.log('PASS: dynamic replacement and density reset update output.');
} finally {
  clearTimeout(watchdog);
  for (const ws of sockets) ws.close();
  app.kill(); server.closeAllConnections(); server.close();
}
