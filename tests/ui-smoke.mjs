// Run with Node 22+ on Windows. Uses the installed Edge; no npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const watchdog = setTimeout(() => { console.error('UI smoke test exceeded 60 seconds'); process.exit(1); }, 60_000);

const html = await readFile(new URL('../src/ui.html', import.meta.url));
const autofillUI = await readFile(new URL('../src/autofill-ui.js', import.meta.url));
const groupHover = await readFile(new URL('../src/group-hover.js', import.meta.url));
const animationDebug = await readFile(new URL('../src/animation-debug.js', import.meta.url));
const glassRim = await readFile(new URL('../src/glass-rim.js', import.meta.url));
const glassLens = await readFile(new URL('../src/glass-lens.js', import.meta.url));
const server = createServer((req, res) => {
  if (req.url === '/animation-debug.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.end(animationDebug);
  } else if (req.url === '/group-hover.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.end(groupHover);
  } else if (req.url === '/glass-lens.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.end(glassLens);
  } else if (req.url === '/glass-rim.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.end(glassRim);
  } else if (req.url === '/autofill-ui.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.end(autofillUI);
  } else if (req.url.startsWith('/suggest')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(['alpha one', 'alpha two']));
  } else if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html'); res.end(html);
  } else { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
await mkdir('target/ui-smoke', { recursive: true });
const profile = await mkdtemp(resolve('target/ui-smoke/profile-'));
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
  let seq = 0;
  const pending = new Map(), errors = [];
  let intercept;
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.method === 'Fetch.requestPaused') { intercept?.(m.params); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(50); }
    throw new Error(`Timed out: ${expression}`);
  };
  const key = async (key, code, modifiers = 0) => {
    const windowsVirtualKeyCode = { Tab: 9, Enter: 13, Escape: 27, ArrowUp: 38, ArrowDown: 40 }[key];
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode });
  };
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['https://*'] });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.messages=[];window.ipc={postMessage:m=>messages.push(JSON.parse(m))};' });
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await waitFor('typeof window.render === "function"');
  await evaluate(`document.body.style.background='linear-gradient(135deg, #3d5367, #322840)'`);
  console.log('UI loaded');
  await evaluate(`window.testState={tabs:[{id:1,title:'Example',url:'https://example.com',page:true,adblock:true},{id:2,title:'Second tab',url:'https://example.org',page:true}],active:1,focused:true,chromeHeight:42,tabbar:true,panes:[]};render(structuredClone(testState));setGeometry({x:0,y:0,mx:0,my:0,mw:1280,mh:820,floating:true})`);
  await delay(700);
  const geometry = await evaluate(`(() => {const rect=id=>document.querySelector(id).getBoundingClientRect();const a=rect('#address'),s=rect('#btn-star'),r=rect('#btn-reload'),t=rect('.tab:not(.active)'),c=rect('.tab:not(.active) .close');return {right:a.right-r.right,gap:r.left-s.right,close:[c.left-t.left,c.top-t.top,t.bottom-c.bottom],slot:document.querySelector('#addr-tab .title').textContent,listed:[...document.querySelectorAll('.tab')].filter(t=>t.offsetWidth).map(t=>t.dataset.id)}})()`);
  assert.equal(geometry.right, 5); assert.equal(geometry.gap, 0);
  assert.equal(geometry.slot, 'Example', 'active tab sits in the address field');
  assert.deepEqual(geometry.listed, ['2'], 'active tab leaves the tab list');
  assert.equal(await evaluate(`document.getElementById('btn-private').offsetWidth`), 0, 'private button hidden on a web page');
  assert.deepEqual(geometry.close, [3, 3, 3]);
  await writeFile('target/ui-smoke/toolbar.png', Buffer.from((await call('Page.captureScreenshot')).data, 'base64'));
  console.log('Spacing verified');
  await evaluate(`document.getElementById('btn-reload').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
  assert.equal(await evaluate(`document.getElementById('toolbar-menu').hidden`), true, 'controls keep their context behavior');
  const openToolbarMenu = () => evaluate(`document.getElementById('toolbar').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:1250,clientY:20}))`);
  await openToolbarMenu();
  assert.equal(await evaluate(`document.getElementById('toolbar-menu').hidden`), false);
  assert.ok(await evaluate(`document.getElementById('toolbar-menu').getBoundingClientRect().right <= innerWidth`));
  await evaluate(`document.getElementById('toolbar-pin').click();hoverAt(500,500,false)`);
  assert.equal(await evaluate(`localStorage.getItem('glass.toolbarPinned')`), 'true');
  await delay(3800);
  assert.equal(await evaluate(`document.body.classList.contains('chrome-hidden')`), false, 'pinned toolbar survives idle timeout');
  await openToolbarMenu();
  assert.equal(await evaluate(`document.getElementById('toolbar-pin').getAttribute('aria-checked')`), 'true');
  await evaluate(`document.getElementById('toolbar-pin').click();hoverAt(500,500,false)`);
  await waitFor(`document.body.classList.contains('chrome-hidden')`);
  assert.equal(await evaluate(`localStorage.getItem('glass.toolbarPinned')`), 'false');
  await evaluate(`hoverAt(500,0,true)`);
  await openToolbarMenu();
  await key('Escape','Escape');
  assert.equal(await evaluate(`document.getElementById('toolbar-menu').hidden`), true);
  console.log('PASS: toolbar context menu, persisted pin toggle, idle prevention and unpin verified.');
  const swapped = await evaluate(`(()=>{render({...structuredClone(testState),active:2});const r={slot:document.querySelector('#addr-tab .title').textContent,listed:[...document.querySelectorAll('.tab')].filter(t=>t.offsetWidth).map(t=>t.dataset.id)};render(structuredClone(testState));return r})()`);
  assert.deepEqual(swapped, { slot: 'Second tab', listed: ['1'] }, 'previous tab returns to the list, new one moves to the field');
  const paired = await evaluate(`(async()=>{const s=structuredClone(testState);s.tabs.push({id:3,title:'Third',url:'https://example.net',page:true});s.split={left:1,right:2};render(s);await new Promise(r=>setTimeout(r,600));const d=document.querySelector('.tab.docked'),a=document.getElementById('address').getBoundingClientRect();const pair=()=>({slot:document.querySelector('#addr-tab .title').textContent,docked:d&&d.dataset.id,gap:d&&Math.round(a.right-d.getBoundingClientRect().right),listed:[...document.querySelectorAll('#tabs .tab')].filter(t=>t.offsetWidth).map(t=>t.dataset.id),lens:!document.getElementById('lens').classList.contains('off')});const r=[pair()];s.active=2;render(s);await new Promise(r=>setTimeout(r,600));r.push((({gap,...x})=>x)({...pair(),docked:document.querySelector('.tab.docked')?.dataset.id}));render(structuredClone(testState));await new Promise(r=>setTimeout(r,50));r.push(document.querySelectorAll('.tab.docked').length);return r})()`);
  assert.deepEqual(paired, [
    { slot: 'Example', docked: '2', gap: 0, listed: ['3'], lens: false },
    { slot: 'Second tab', docked: '1', listed: ['3'], lens: false },
    0,
  ], 'split: active tab in the field, partner inside the same capsule on its right, no tab shown twice; unsplit undocks');
  // Another tab active: the pair stays combined in the bar (left, right – even if not adjacent in tab order)
  const grouped = await evaluate(`(async()=>{const s=structuredClone(testState);s.tabs.push({id:3,title:'Third',url:'https://example.net',page:true});s.split={left:3,right:1};s.active=2;render(s);await new Promise(r=>setTimeout(r,600));const t=[...document.querySelectorAll('#tabs .tab')].filter(t=>t.offsetWidth);const [a,b]=[document.querySelector('.pair-left'),document.querySelector('.pair-right')].map(e=>e?.getBoundingClientRect());return {order:t.map(t=>t.dataset.id),touch:!!a&&!!b&&Math.round(b.left-a.right)}})()`);
  await writeFile('target/ui-smoke/pair-inactive.png', Buffer.from((await call('Page.captureScreenshot', { clip: { x: 0, y: 0, width: 1280, height: 60, scale: 1 } })).data, 'base64'));
  assert.deepEqual(grouped, { order: ['3', '1'], touch: 0 }, 'inactive pair shown combined as one capsule');
  // Only one combined pair: "+" moves right next to the field
  const pairSolo = await evaluate(`(async()=>{const s=structuredClone(testState);s.split={left:1,right:2};render(s);await new Promise(r=>setTimeout(r,1200));const a=document.getElementById('address').getBoundingClientRect(),n=document.getElementById('btn-new').getBoundingClientRect();return {inLeft:!!document.querySelector('.side.left > #btn-new'),gap:Math.round(n.left-a.right)}})()`);
  assert.deepEqual(pairSolo, { inLeft: true, gap: 6 }, 'single combined pair: "+" sits right next to the field');
  // Dragging either half of the pair into the middle separates it; the other one stays in the field
  const drag = async (selector) => {
    const [x, y] = await evaluate(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
    await evaluate(`messages.length=0`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i++) await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (900 - x) * i / 8, y, button: 'left', buttons: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 900, y, button: 'left', buttons: 0, clickCount: 1 });
    return evaluate(`messages.filter(m=>['move_tab','activate','split'].includes(m.cmd)).map(m=>[m.cmd,m.id,m.index])`);
  };
  const three = `(()=>{const s=structuredClone(testState);s.tabs.push({id:3,title:'Third',url:'https://example.net',page:true});s.split={left:1,right:2};render(s)})()`;
  await evaluate(three); await delay(700);
  assert.deepEqual(await drag('.tab.docked'), [['move_tab', 2, 1], ['activate', 1, null]], 'partner dragged into the middle: separated, field keeps the active tab');
  await evaluate(three); await delay(700);
  assert.deepEqual(await drag('#addr-tab'), [['move_tab', 1, 0], ['activate', 2, null]], 'field tab dragged out: separated, partner moves into the field');
  await evaluate(`render(structuredClone(testState))`);
  await delay(700);
  {
    await evaluate(`hoverAt(300,2,true)`); await delay(450); // Leiste ist nach 3,5 s Ruhe ausgeblendet
    const [x, y] = await evaluate(`(()=>{const r=document.querySelector('#addr-tab .title').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    assert.equal(await evaluate('document.activeElement.id'), 'addr-input', 'click on the tab in the field opens the search');
    await evaluate(`document.activeElement.blur()`);
    await delay(700);
  }
  // Tabs stay centred in the window, even when the address field makes the left side wider than the right
  for (const [count, active] of [[5, 1], [5, 5]]) {
    const offset = await evaluate(`(async()=>{const s=structuredClone(testState);s.tabs=Array.from({length:${count}},(_,i)=>({id:i+1,title:'Tab '+(i+1),url:${active}===i+1?'':'https://example.com/'+i,page:${active}!==i+1}));s.active=${active};render(s);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const t=document.getElementById('tabs').getBoundingClientRect(),n=document.getElementById('btn-new').getBoundingClientRect();return (t.left+n.right)/2-innerWidth/2})()`);
    assert.ok(Math.abs(offset) <= 4, `tabs centred with ${count} tabs, active ${active}: offset ${offset}`);
  }
  const solo = await evaluate(`(async()=>{document.activeElement.blur();const s=structuredClone(testState);s.tabs=s.tabs.slice(0,1);render(s);await new Promise(r=>setTimeout(r,1200));const a=document.getElementById('address').getBoundingClientRect(),n=document.getElementById('btn-new').getBoundingClientRect();return {inLeft:!!document.querySelector('.side.left > #btn-new'),gap:Math.round(n.left-a.right)}})()`);
  assert.deepEqual(solo, { inLeft: true, gap: 6 }, 'single tab: "+" sits right next to the address field');
  await evaluate(`render(structuredClone(testState))`);
  assert.equal(await evaluate(`document.getElementById('btn-new').parentElement.id`), 'tabbar', 'second tab: "+" returns to the tab bar');
  await delay(800); // Startbildschirm → Leiste: das Adressfeld gleitet zurück
  await delay(500);
  await evaluate(`{
    const style=document.createElement('style');style.id='debug-test-style';
    style.textContent='@keyframes debug-spin {to {transform:rotate(360deg)}} #debug-probe {opacity:1;transition:opacity 10s} #debug-probe::before {content:"test";animation:debug-spin 10s linear infinite}';document.head.append(style);
    window.debugProbe=document.createElement('div');debugProbe.id='debug-probe';document.body.append(debugProbe);
    window.debugAnimation=debugProbe.animate([{translate:'0px'},{translate:'100px'}],{duration:10000});
    getComputedStyle(debugProbe).opacity;
    debugProbe.style.opacity='.2';
    window.debugBefore=debugAnimation.currentTime;
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'F8',ctrlKey:true,shiftKey:true,bubbles:true}));
  }`);
  await delay(120);
  assert.equal(await evaluate('AnimationDebug.enabled'),true);
  assert.ok(await evaluate(`debugAnimation.currentTime-debugBefore < 80`),'enabling preserves animation position and slows its clock');
  assert.ok(await evaluate(`debugProbe.getAnimations({subtree:true}).length>=3 && debugProbe.getAnimations({subtree:true}).every(a=>a.playbackRate===.05)`),'CSS transition, pseudo animation and WAAPI all slowed');
  await evaluate(`window.debugLate=debugProbe.animate([{color:'red'},{color:'blue'}],{duration:10000})`);
  await delay(60);
  assert.equal(await evaluate('debugLate.playbackRate'),.05,'new animations inherit slow mode');
  await evaluate(`document.getElementById('animation-debug').click()`);
  await delay(50);
  assert.equal(await evaluate('AnimationDebug.enabled'),false);
  assert.ok(await evaluate(`debugProbe.getAnimations({subtree:true}).every(a=>a.playbackRate===1)`),'disabling restores original speed');
  await evaluate(`debugProbe.getAnimations({subtree:true}).forEach(a=>a.cancel());debugProbe.remove();document.getElementById('debug-test-style').remove()`);
  console.log('PASS: animation debug slows CSS/WAAPI, picks up new animations and restores live playback.');
  const compact = await evaluate(`(()=>{const a=document.getElementById('address'),s=document.querySelector('#btn-star svg').getBoundingClientRect(),r=document.querySelector('#btn-reload svg').getBoundingClientRect(),box=a.getBoundingClientRect();const b=document.getElementById('btn-star').getBoundingClientRect();hoverAt(b.x+b.width/2,b.y+b.height/2,true);return {gap:r.left-s.right,right:box.right-r.right,clearance:r.left-(b.right+2)};})()`);
  assert.ok(Math.abs(compact.right-compact.gap)<=1,'even optical icon spacing');
  assert.ok(compact.clearance>=2,`hover leaves clearance to neighbouring icon: ${JSON.stringify(compact)}`);
  await delay(140);
  const hoverX=()=>evaluate(`new DOMMatrix(getComputedStyle(document.getElementById('address'),'::before').transform).m41`);
  const from=await hoverX();
  await evaluate(`{const r=document.getElementById('btn-reload').getBoundingClientRect();hoverAt(r.x+r.width/2,r.y+r.height/2,true)}`);
  await delay(45);
  const during=await hoverX();
  assert.ok(during>from && during<from+24,'shared hover travels between buttons');
  await delay(110); assert.equal(await hoverX(),from+24);
  await evaluate(`hoverAt(800,600,false)`);
  await waitFor(`getComputedStyle(document.getElementById('address'),'::before').opacity==='0'`);
  console.log('PASS: compact icon spacing, neighbour clearance and snappy shared hover motion.');
  // Native cursor updates must move the light over child webviews without hovering the UI behind them.
  await evaluate(`hoverAt(300, 400, false)`);
  await delay(40);
  const firstLight = await evaluate(`document.getElementById('address').style.getPropertyValue('--lx')`);
  await evaluate(`hoverAt(1200, 700, false)`);
  await delay(40);
  assert.notEqual(await evaluate(`document.getElementById('address').style.getPropertyValue('--lx')`), firstLight);
  assert.equal(await evaluate(`document.querySelectorAll('.vh').length`), 0);
  await evaluate(`{const r=document.getElementById('btn-new').getBoundingClientRect();hoverAt(r.x+r.width/2,r.y+r.height/2,true)}`);
  assert.equal(await evaluate(`document.getElementById('btn-new').classList.contains('vh')`), true);
  await evaluate(`{const r=document.getElementById('btn-new').getBoundingClientRect();hoverAt(r.x+r.width/2,r.y+r.height/2,false)}`);
  assert.equal(await evaluate(`document.getElementById('btn-new').classList.contains('vh')`), false);
  await delay(40);
  const lastLight = await evaluate(`document.getElementById('address').style.getPropertyValue('--lx')`);
  await evaluate(`hoverAt(null)`);
  await delay(40);
  assert.equal(await evaluate(`document.getElementById('address').style.getPropertyValue('--lx')`), lastLight);
  console.log('Light follows native page coordinates; UI hover remains separate');
  for (const id of ['btn-private', 'btn-favs', 'btn-new']) {
    await evaluate(`document.getElementById('${id}').classList.add('vh')`);
    await delay(220);
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('${id}')).backgroundColor`), 'rgba(255, 255, 255, 0.12)', id);
    await evaluate(`document.getElementById('${id}').classList.remove('vh')`);
  }
  await evaluate(`document.body.classList.add('private');document.getElementById('btn-private').classList.add('vh')`);
  await delay(220);
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('btn-private')).backgroundColor`), 'rgba(255, 255, 255, 0.12)');
  await evaluate(`document.body.classList.remove('private');document.getElementById('btn-private').classList.remove('vh');document.querySelector('.tab').classList.add('vh')`);
  for (let i = 0; i < 5; i++) {
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.close')).transform`), 'none');
    await delay(50);
  }
  await evaluate(`document.getElementById('addr-search').click()`);
  assert.equal(await evaluate('document.activeElement.id'), 'addr-input');
  await evaluate(`document.getElementById('addr-input').value='alpha';document.getElementById('addr-input').dispatchEvent(new Event('input'))`);
  await waitFor(`document.querySelectorAll('#suggest.open .sg').length===2`);
  const value = () => evaluate(`document.getElementById('addr-input').value`);
  await key('Tab', 'Tab'); assert.equal(await value(), 'alpha one');
  assert.equal(await evaluate('document.activeElement.id'), 'addr-input');
  await key('Tab', 'Tab'); assert.equal(await value(), 'alpha two');
  await key('Tab', 'Tab'); assert.equal(await value(), 'alpha');
  await key('Tab', 'Tab', 8); assert.equal(await value(), 'alpha two');
  await key('ArrowUp', 'ArrowUp'); assert.equal(await value(), 'alpha one');
  await key('Tab', 'Tab', 2); assert.equal(await value(), 'alpha one');
  assert.equal(await evaluate('messages.at(-1).cmd'), 'next_tab');
  await key('Enter', 'Enter');
  assert.ok(await evaluate(`messages.some(m=>m.cmd==='navigate'&&m.value==='alpha one')`));
  // New-tab search shares the same keyboard controller.
  await evaluate(`testState.tabs.push({id:3,title:'',url:'',page:false});testState.active=3;render(structuredClone(testState));document.getElementById('addr-input').value='alpha';document.getElementById('addr-input').dispatchEvent(new Event('input'))`);
  await waitFor(`document.querySelectorAll('#suggest.open .sg').length===2`);
  await key('Tab', 'Tab'); assert.equal(await value(), 'alpha one');
  await key('Escape', 'Escape'); assert.equal(await value(), 'alpha');
  await evaluate(`document.getElementById('btn-engine').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}))`);
  assert.equal(await evaluate(`document.getElementById('wheel').classList.contains('open')`),true);
  await key('Escape','Escape');
  await waitFor(`!document.getElementById('wheel').classList.contains('open')`);
  // Arrival pulse must not relayout or move the settled glass circle by fractional pixels.
  await evaluate(`document.getElementById('btn-engine').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}))`);
  await delay(800);
  const pulseGeometry = await evaluate(`(() => {
    const wheel = document.getElementById('wheel');
    const slots = [...wheel.querySelectorAll('.slot')];
    const selected = slots.findIndex(s => s.classList.contains('on'));
    const incoming = slots[(selected + slots.length - 1) % slots.length];
    incoming.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true }));
    const animations = wheel.getAnimations({subtree:true});
    animations.forEach(a => { a.pause(); const t=a.effect.getTiming(); a.currentTime=t.delay+Number(t.duration)*.99; });
    const pulse = incoming.getAnimations().find(a => a.effect.getKeyframes().some(k => '--arrival-scale' in k));
    const timing = pulse.effect.getTiming();
    const samples = [0, .15, .38, .6, .85, .99].map(f => {
      pulse.currentTime = timing.delay + Number(timing.duration) * f;
      const r = incoming.getBoundingClientRect();
      return { x:r.x+r.width/2, y:r.y+r.height/2, width:r.width, layout:incoming.offsetWidth };
    });
    animations.forEach(a => a.play());
    return samples;
  })()`);
  assert.ok(Math.max(...pulseGeometry.map(r=>r.width)) > pulseGeometry[0].width + 2, 'glass pulse is visible');
  for (const r of pulseGeometry) {
    assert.equal(r.layout, pulseGeometry[0].layout, 'glass pulse does not relayout');
    assert.ok(Math.abs(r.x-pulseGeometry[0].x)<.02 && Math.abs(r.y-pulseGeometry[0].y)<.02, 'glass centre remains fixed throughout pulse');
  }
  await waitFor(`!document.getElementById('wheel').classList.contains('open')`);
  console.log('PASS: glass arrival pulse keeps its centre and layout size fixed.');
  assert.equal(await value(),'alpha');
  assert.equal(await evaluate('document.activeElement.id'),'addr-input');
  await waitFor(`document.querySelectorAll('#suggest.open .sg').length===2`);
  await delay(450);
  await writeFile('target/ui-smoke/start-suggestions.png', Buffer.from((await call('Page.captureScreenshot')).data, 'base64'));
  await key('Escape','Escape');
  await key('Tab', 'Tab'); assert.notEqual(await evaluate('document.activeElement.id'), 'addr-input');
  for (const floating of [false, true]) {
    await evaluate(`setGeometry({x:0,y:0,mx:0,my:0,mw:1280,mh:820,floating:${floating}})`);
    assert.equal(await evaluate(`getComputedStyle(document.body,'::after').display`), floating ? 'block' : 'none');
    assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--radius')`), floating ? '8px' : '0px');
  }
  await delay(700);
  const screenshot = await call('Page.captureScreenshot');
  await writeFile('target/ui-smoke/start.png', Buffer.from(screenshot.data, 'base64'));
  assert.ok(await evaluate(`document.getElementById('btn-private').offsetWidth > 0`), 'private button visible on the start screen');
  const startGeometry = await evaluate(`(()=>{const input=document.getElementById('addr-input'),icon=document.querySelector('#addr-search svg'),box=document.getElementById('address').getBoundingClientRect(),a=icon.getBoundingClientRect(),b=input.getBoundingClientRect();return {left:a.left-box.left,gap:b.left-a.right,iconCenter:a.top+a.height/2,inputCenter:b.top+b.height/2}})()`);
  assert.equal(startGeometry.left,startGeometry.gap,'equal spacing on both sides of the search icon');
  assert.equal(startGeometry.inputCenter,startGeometry.iconCenter-1,'optical text alignment');
  assert.deepEqual(errors, [], 'no JavaScript exceptions');
  // Measure coverage of the rendered ring. Average a corner arc: one diagonal
  // scanline is biased by pixel phase at 1x. Allow raster AA, not geometric scaling.
  await evaluate(`document.body.style.background='#000';const rim=document.createElement('div');rim.id='rim-test';rim.className='glass';Object.assign(rim.style,{position:'fixed',left:'100px',top:'100px',background:'none',boxShadow:'none',backdropFilter:'none',zIndex:90});document.body.append(rim);const style=document.createElement('style');style.id='rim-test-style';style.textContent='#rim-test .glass-rim{opacity:1!important;transition:none!important}#rim-test .glass-rim path{display:none}#rim-test .glass-outline{display:inline!important;stroke-opacity:1;stroke-dasharray:none}';document.head.append(style)`);
  for (const dpr of [1, 1.25, 1.5, 2]) {
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: dpr, mobile: false });
    for (const [w, h] of [[66, 30], [240, 60]]) {
      await evaluate(`Object.assign(document.getElementById('rim-test').style,{width:'${w}px',height:'${h}px',borderRadius:'${h/2}px'})`);
      await delay(60);
      const rendered = await call('Page.captureScreenshot', { clip: { x: 100, y: 100, width: w, height: h, scale: 1 } });
      await writeFile(`target/ui-smoke/rim-${w}-${dpr}.png`, Buffer.from(rendered.data, 'base64'));
      const widths = await evaluate(`(async()=>{const img=new Image();img.src='data:image/png;base64,${rendered.data}';await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;const sx=c.width/${w},sy=c.height/${h};const px=(x,y)=>x<0||y<0||x>=c.width||y>=c.height?0:data[(y*c.width+x)*4]/255;const sample=(x,y)=>{let u=x*sx-.5,v=y*sy-.5,a=Math.floor(u),b=Math.floor(v),dx=u-a,dy=v-b;return px(a,b)*(1-dx)*(1-dy)+px(a+1,b)*dx*(1-dy)+px(a,b+1)*(1-dx)*dy+px(a+1,b+1)*dx*dy};let top=0,side=0,corner=0;for(let t=-2;t<4;t+=.025){top+=sample(${w/2},t)*.025;side+=sample(t,${h/2})*.025;const radius=${h/2};for(let a=25;a<=65;a+=2){const angle=a*Math.PI/180;corner+=sample(radius-(radius-t)*Math.cos(angle),radius-(radius-t)*Math.sin(angle))*.025/21;}}return{top,side,corner};})()`);
      for (const [edge, width] of Object.entries(widths)) assert.ok(Math.abs(width - 1) < .28, `rim ${w}px @${dpr}: ${edge} is ${width.toFixed(3)} CSS pixels`);
      console.log(`Rendered rim ${w}px @${dpr}: top ${widths.top.toFixed(2)}, side ${widths.side.toFixed(2)}, corner ${widths.corner.toFixed(2)} CSS px`);
    }
  }
  // Compare actual highlight footprints along the contour, including round ends.
  await evaluate(`document.getElementById('rim-test-style').textContent='#rim-test .glass-rim,#rim-test .glass-highlights{transition:none!important}';`);
  const footprints = [];
  for (const width of [240, 720]) {
    for (const side of ['bottom', 'right']) {
      await evaluate(`(()=>{const el=document.getElementById('rim-test');el.style.width='${width}px';el.style.height='60px';el.style.borderRadius='30px';window.GlassRim.move(el,${side === 'bottom' ? 100 + width/2 : 100 + width},${side === 'bottom' ? 160 : 130});})()`);
      await delay(60);
      const rendered = await call('Page.captureScreenshot', {clip:{x:100,y:100,width,height:60,scale:1}});
      await writeFile(`target/ui-smoke/highlight-${width}-${side}.png`,Buffer.from(rendered.data,'base64'));
      const footprint = await evaluate(`(async()=>{const img=new Image();img.src='data:image/png;base64,${rendered.data}';await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;const scale=c.width/${width};const pixel=(x,y)=>x<0||y<0||x>=c.width||y>=c.height?0:data[(y*c.width+x)*4]/255;const sample=(x,y)=>{const u=x*scale-.5,v=y*scale-.5,a=Math.floor(u),b=Math.floor(v),dx=u-a,dy=v-b;return pixel(a,b)*(1-dx)*(1-dy)+pixel(a+1,b)*dx*(1-dy)+pixel(a,b+1)*(1-dx)*dy+pixel(a+1,b+1)*dx*dy};const path=document.querySelector('#rim-test .glass-rim path'),p=path.getTotalLength(),values=[];for(let s=0;s<p;s+=.5){const point=path.getPointAtLength(s),before=path.getPointAtLength((s-.2+p)%p),after=path.getPointAtLength((s+.2)%p),dx=after.x-before.x,dy=after.y-before.y,len=Math.hypot(dx,dy);let intensity=0;for(let t=-2;t<=2;t+=.1)intensity+=sample(point.x+.5-dy/len*t,point.y+.5+dx/len*t)*.1;values.push(intensity);}const peak=Math.max(...values);return {peak,width:values.filter(v=>v>=peak/2).length*.5};})()`);
      assert.ok(footprint.peak > .5, 'highlight is visibly rendered');
      assert.ok(footprint.width > 35 && footprint.width < 52, `highlight footprint: ${JSON.stringify(footprint)}`);
      footprints.push(footprint.width);
      console.log(`Highlight ${width}px ${side}: ${footprint.width.toFixed(1)} CSS px at half brightness`);
    }
  }
  assert.ok(Math.max(...footprints)-Math.min(...footprints)<6,'highlight width stays consistent across aspect ratio and edge');
  const proximity = await evaluate(`(()=>{const el=document.getElementById('rim-test'),svg=el.querySelector('.glass-highlights'),r=el.getBoundingClientRect();const read=(x,y)=>{GlassRim.move(el,x,y);return Number(getComputedStyle(svg).opacity)};const values=[0,24,100,200,280,600].map(d=>read(r.left+r.width/2,r.bottom+d));const end=read(r.right+100,r.top+r.height/2);const center=read(r.left+r.width/2,r.top+r.height/2);GlassRim.leave();return {values,end,center,leftWindow:Number(getComputedStyle(svg).opacity)};})()`);
  assert.equal(proximity.values[0],1);
  assert.equal(proximity.values[1],1);
  assert.ok(proximity.values[2] < 1 && proximity.values[2] > proximity.values[3]);
  assert.equal(proximity.values[4],0);
  assert.equal(proximity.values[5],0);
  assert.equal(proximity.end,proximity.values[2], 'same distance from long edge or rounded end gives same intensity');
  assert.equal(proximity.center,1);
  assert.equal(proximity.leftWindow,0);
  console.log('PASS: proximity fades smoothly to zero; equal edge distances, centre and window leave verified.');
  const anchors = await evaluate(`(()=>{const el=document.getElementById('rim-test'),r=el.getBoundingClientRect();return [[120,-40],[120,-120],[600,110],[760,-40],[120,10]].map(([x,y])=>{GlassRim.move(el,r.left+x,r.top+y);const lobe=[...el.querySelectorAll('.glass-lobe')].sort((a,b)=>Number(b.getAttribute('opacity'))-Number(a.getAttribute('opacity')))[0];const path=lobe.querySelector('path'),half=Number(path.getAttribute('stroke-dasharray').split(' ')[0])/2,offset=Number(path.getAttribute('stroke-dashoffset'));const point=path.getPointAtLength(half-offset);return {x:point.x+.5,y:point.y+.5};});})()`);
  for (const i of [0,1,4]) {
    assert.ok(Math.abs(anchors[i].x-120)<.6, 'top highlight aligns with cursor, including inside the field');
    assert.ok(Math.abs(anchors[i].y-.5)<.6);
  }
  assert.ok(Math.abs(anchors[2].x-600)<.6 && Math.abs(anchors[2].y-59.5)<.6, 'bottom highlight aligns with cursor');
  assert.ok(Math.abs(anchors[3].x-(690+29.5/Math.SQRT2))<.6 && Math.abs(anchors[3].y-(30-29.5/Math.SQRT2))<.6, 'corner projects to nearest point on the arc');
  console.log('PASS: highlight anchors follow nearest edge and rounded corner, independent of cursor distance.');
  const blend = await evaluate(`(()=>{const el=document.getElementById('rim-test'),r=el.getBoundingClientRect();return [0,15,29.9,30,30.1,45,60].map(y=>{GlassRim.move(el,r.left+120,r.top+y);return [...el.querySelectorAll('.glass-lobe')].map(g=>Number(g.getAttribute('opacity')));});})()`);
  assert.deepEqual(blend[0],[1,0]); assert.deepEqual(blend.at(-1),[0,1]);
  for(let i=0;i<blend.length;i++) {
    assert.ok(Math.abs(blend[i][0]+blend[i][1]-1)<.0001);
    if(i) assert.ok(blend[i][1]>=blend[i-1][1]);
  }
  assert.ok(Math.abs(blend[3][0]-.5)<.001);
  assert.ok(Math.abs(blend[4][1]-blend[2][1])<.01,'no midline jump');
  console.log('PASS: top/bottom highlights crossfade continuously across the field height.');
  await evaluate(`document.getElementById('rim-test').remove();document.getElementById('rim-test-style').remove()`);
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  // Test field detection and filling with synthetic data only, on an intercepted HTTPS page.
  const contentScript = await readFile(new URL('../src/autofill-content.js', import.meta.url), 'utf8');
  const fixture = `<form><input id="user" autocomplete="username"><input id="pass" type="password" autocomplete="current-password"></form><form><input id="signup" autocomplete="username"><input type="password" autocomplete="new-password"></form><input id="search" type="search"><input id="otp" autocomplete="one-time-code"><input id="hidden" type="password" style="display:none">`;
  intercept = p => call('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from(fixture).toString('base64') });
  await call('Fetch.enable', { patterns: [{ urlPattern: 'https://glass-autofill.test/*' }] });
  await call('Network.setBlockedURLs', { urls: [] });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: contentScript });
  await call('Page.navigate', { url: 'https://glass-autofill.test/' });
  await waitFor(`!!document.getElementById('user')`);
  await evaluate(`document.getElementById('user').focus()`);
  await waitFor(`messages.some(m=>m.autofill==='focus')`);
  const token = await evaluate(`messages.find(m=>m.autofill==='focus').token`);
  await evaluate(`__glassAutofillFill('wrong-token',location.origin,'test-user','test-password')`);
  assert.equal(await evaluate(`document.getElementById('pass').value`), '');
  await evaluate(`__glassAutofillFill(${JSON.stringify(token)},'https://other.test','test-user','test-password')`);
  assert.equal(await evaluate(`document.getElementById('pass').value`), '');
  await evaluate(`__glassAutofillFill(${JSON.stringify(token)},location.origin,'test-user','test-password')`);
  assert.equal(await evaluate(`document.getElementById('user').value`), 'test-user');
  assert.equal(await evaluate(`document.getElementById('pass').value`), 'test-password');
  await evaluate(`messages.length=0;document.getElementById('signup').focus();document.getElementById('search').focus();document.getElementById('otp').focus()`);
  assert.equal(await evaluate(`messages.filter(m=>m.autofill==='focus').length`), 0);
  await evaluate(`document.getElementById('pass').focus()`);
  assert.equal(await evaluate(`messages.filter(m=>m.autofill==='focus').length`), 1);
  await evaluate(`document.getElementById('search').focus()`);
  const stale = await evaluate(`messages.find(m=>m.autofill==='focus').token`);
  await evaluate(`__glassAutofillFill(${JSON.stringify(stale)},location.origin,'changed','changed')`);
  assert.equal(await evaluate(`document.getElementById('pass').value`), 'test-password');
  console.log('PASS: login detection, signup/OTP exclusion, token/origin checks, stale-focus rejection and synthetic filling.');
  console.log('PASS: spacing, shared hovers, stable close icon, toolbar/new-tab suggestions, shortcuts, frame states.');
  await call('Browser.close');
} finally {
  clearTimeout(watchdog); ws?.close(); edge.kill(); server.closeAllConnections(); server.close();
}
