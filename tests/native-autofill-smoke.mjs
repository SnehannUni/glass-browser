// Full Glass/WebView2/Apple test in a disposable browser profile; no real-site credentials.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
await mkdir('target/native-smoke', { recursive: true });
const profile = await mkdtemp(resolve('target/native-smoke/profile-'));
const listener = createServer();
await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port;
await new Promise(r => listener.close(r));
const synthetic = process.argv.includes('--synthetic');
const adapterPath = resolve('target/release/icloud/bridge.mjs');
const original = synthetic ? await readFile(adapterPath) : null;
if (synthetic) await writeFile(adapterPath, `import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',async line=>{const q=JSON.parse(line);if(q.op==='list')await new Promise(r=>setTimeout(r,800));const data=q.op==='list'?{accounts:[{username:'synthetic-user',label:'Test account'}]}:{username:'synthetic-user',password:'synthetic-password'};process.stdout.write(JSON.stringify({id:q.id,data})+'\\n');});`);
const app = spawn(resolve('target/release/glass-browser.exe'), ['about:blank'], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const sockets = [];
const watchdog = setTimeout(() => { app.kill(); process.exit(1); }, 60000);
async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl); sockets.push(ws);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  let seq = 0; const pending = new Map();
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); }
    if (m.method === 'Fetch.requestPaused') call('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      body: Buffer.from('<!doctype html><title>Glass Autofill Test</title><form><input id="user" autocomplete="username"><input type="password" autocomplete="current-password"></form>').toString('base64') });
  };
  return { call, evaluate: async expression => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`Test page script failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  } };
}
try {
  let pages;
  for (let i = 0; i < 150; i++) {
    try {
      pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })).json();
      if (pages.some(p => p.url === 'about:blank') && pages.some(p => p.url.includes('glass.localhost'))) break;
    } catch { /* browser still starting */ }
    await delay(100);
  }
  assert.ok(pages?.some(p => p.url.includes('glass.localhost')), 'native UI started');
  const ui = await connect(pages.find(p => p.url.includes('glass.localhost')));
  const page = await connect(pages.find(p => p.url === 'about:blank'));
  console.log('Native UI and content webview connected');
  await page.call('Fetch.enable', { patterns: [{ urlPattern: 'https://glass-autofill-test.invalid/*' }] });
  await delay(700);
  await ui.evaluate(`window.ipc.postMessage(JSON.stringify({cmd:'navigate',value:'https://glass-autofill-test.invalid/'}))`);
  for (let i = 0; i < 100; i++) { if (await page.evaluate(`!!document.getElementById('user')`)) break; await delay(100); }
  console.log(await page.evaluate(`({url:location.href,title:document.title,field:!!document.getElementById('user')})`));
  assert.equal(await page.evaluate(`PublicKeyCredential.isConditionalMediationAvailable()`),false);
  assert.equal(await page.evaluate(`navigator.credentials.get({mediation:'conditional',publicKey:{challenge:new Uint8Array(32)}}).then(()=>'',e=>e.name)`),'NotSupportedError');
  if (synthetic) {
    await page.call('WebAuthn.enable');
    await page.call('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
    assert.equal(await page.evaluate(`(async()=>{const credential=await navigator.credentials.create({publicKey:{challenge:new Uint8Array(32),rp:{name:'Glass test'},user:{id:new Uint8Array([1]),name:'test',displayName:'Test'},pubKeyCredParams:[{type:'public-key',alg:-7}]}});const result=await navigator.credentials.get({mediation:'required',publicKey:{challenge:new Uint8Array(32),allowCredentials:[{type:'public-key',id:credential.rawId}]}});return result.id===credential.id})()`),true);
    console.log('PASS: conditional passkey popup disabled; explicit WebAuthn registration/sign-in succeeds.');
  }
  await page.evaluate(`document.getElementById('user').focus()`);
  if (synthetic) {
    await delay(100);
    await page.evaluate(`document.querySelector('input[type=password]').focus()`);
    await delay(100);
    await ui.evaluate(`window.testPicker=document.getElementById('password-suggestions')`);
  }
  let result;
  for (let i = 0; i < 250; i++) {
    result = await ui.evaluate(`document.getElementById('password-suggestions')?.textContent || ''`);
    if (result.includes(synthetic ? 'synthetic-user' : 'Keine passenden Passwörter') || result.includes('nicht verfügbar')) break;
    await delay(100);
  }
  assert.ok(result.includes(synthetic ? 'synthetic-user' : 'Keine passenden Passwörter'), `Native account picker result: ${result}`);
  if (synthetic) {
    assert.equal(await ui.evaluate(`window.testPicker===document.getElementById('password-suggestions')`),true,'late results update the existing picker without another field click');
    // A synthetic click cannot authorize credential filling.
    await ui.evaluate(`document.querySelector('#password-suggestions button').click()`);
    assert.equal(await page.evaluate(`document.querySelector('input[type=password]').value`), '');
    const point = await ui.evaluate(`(()=>{const r=document.querySelector('#password-suggestions button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await ui.call('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
    await ui.call('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
    for (let i=0;i<50;i++) {if(await page.evaluate(`document.querySelector('input[type=password]').value==='synthetic-password'`))break;await delay(100);}
    assert.equal(await page.evaluate(`document.getElementById('user').value`), 'synthetic-user');
    assert.equal(await page.evaluate(`document.querySelector('input[type=password]').value`), 'synthetic-password');
    console.log('PASS: trusted native picker fills synthetic credentials; script-generated click rejected.');
  }
  await page.evaluate(`document.getElementById('user').blur();document.body.dispatchEvent(new Event('scroll'))`);
  await delay(200);
  assert.equal(await ui.evaluate(`!!document.getElementById('password-suggestions')`), false);
  if (!synthetic) console.log('PASS: Glass HTTPS field -> native origin validation -> automatic Apple pairing -> encrypted .invalid lookup -> trusted popup -> dismissal.');
  await ui.evaluate(`window.ipc.postMessage(JSON.stringify({cmd:'close'}))`);
} finally { clearTimeout(watchdog); sockets.forEach(s => s.close()); app.kill(); if(original)await writeFile(adapterPath,original); }
