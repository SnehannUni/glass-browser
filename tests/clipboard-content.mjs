// Run with Node 22+ on Windows. Uses the installed Edge; no npm dependencies.
// Prüft clipboard-content.js: Einfügen erkennen, eingefügten Text tauschen, Pfeiltasten abfangen.
// Das echte Einfügen braucht die Zwischenablage des Systems – der Test ahmt es nach (paste-Ereignis + insertText)
// und lässt dafür die isTrusted-Prüfung beim Einfügen weg. Die Tastenprüfung in Rust ist hier nicht abgedeckt.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const watchdog = setTimeout(() => { console.error('clipboard test exceeded 60 seconds'); process.exit(1); }, 60_000);

let script = await readFile(new URL('../src/clipboard-content.js', import.meta.url), 'utf8');
assert.ok(script.includes('!e.isTrusted || !text'), 'paste guard found');
script = script.replace('!e.isTrusted || !text', '!text');
const page = `<!doctype html><input id=i value="ab"><textarea id=t>eins\nzwei</textarea>
<div id=c contenteditable>Hallo Welt</div><input id=x value="">`;

await mkdir('target/clipboard-test', { recursive: true });
const profile = await mkdtemp(resolve('target/clipboard-test/profile-'));
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
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const run = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const key = async (key, code, vk, text) => {
    await call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, text });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  };
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.ipc = { postMessage: (m) => (window.__sent ||= []).push(JSON.parse(m)) };\n${script}`,
  });
  await call('Page.navigate', { url: `data:text/html,${encodeURIComponent(page)}` });
  await delay(500);

  // Einfügen wie Chromium: paste-Ereignis, dann (ohne preventDefault) den Text an der Auswahl einsetzen
  const paste = (sel, text, setup) => run(`(async () => {
    window.__sent = [];
    const el = document.querySelector(${JSON.stringify(sel)});
    el.focus();
    ${setup}
    const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    if (!ev.defaultPrevented) document.execCommand('insertText', false, ${JSON.stringify(text)});
    await new Promise((r) => setTimeout(r, 30));
    return window.__sent;
  })()`);
  const sent = () => run('window.__sent');

  // 1. Eingabefeld: Einfügen in der Mitte, tauschen, Pfeile, andere Taste
  let msgs = await paste('#i', 'XYZ', 'el.setSelectionRange(1, 1);');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].clip, 'start');
  assert.equal(msgs[0].rect.length, 4);
  assert.equal(await run('i.value'), 'aXYZb');
  await run(`window.__glassClipInsert('längerer Text')`);
  assert.equal(await run('i.value'), 'alängerer Textb');
  assert.equal(await run('i.selectionEnd'), 14);
  await run(`window.__glassClipInsert('Q')`);
  assert.equal(await run('i.value'), 'aQb');
  await key('ArrowDown', 'ArrowDown', 40);
  await key('ArrowUp', 'ArrowUp', 38);
  assert.deepEqual((await sent()).slice(1), [{ clip: 'step', dir: 1 }, { clip: 'step', dir: -1 }]);
  assert.equal(await run('i.selectionEnd'), 2, 'arrows did not move the caret');
  // Strg allein beendet nichts (Nutzer hält Strg noch nach Strg+V)
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
  assert.equal((await sent()).length, 3);
  await key('k', 'KeyK', 75, 'k');
  assert.deepEqual((await sent()).at(-1), { clip: 'end' });
  assert.equal(await run('i.value'), 'aQkb', 'other keys type normally');
  await key('ArrowDown', 'ArrowDown', 40);
  assert.equal((await sent()).length, 4, 'arrows are normal again after the list closed');

  // 2. Mehrzeilig in einer Textarea, Esc meldet „zurück“
  msgs = await paste('#t', 'neu\nzeilig', 'el.setSelectionRange(4, 4);');
  assert.equal(msgs[0]?.clip, 'start');
  assert.equal(await run('t.value'), 'einsneu\nzeilig\nzwei');
  await run(`window.__glassClipInsert('A\\nB\\nC')`);
  assert.equal(await run('t.value'), 'einsA\nB\nC\nzwei');
  await key('Escape', 'Escape', 27);
  assert.deepEqual((await sent()).at(-1), { clip: 'revert' });
  await run(`window.__glassClipInsert('neu\\nzeilig')`); // das macht Rust bei Esc
  assert.equal(await run('t.value'), 'einsneu\nzeilig\nzwei');

  // 3. contenteditable, Ersetzen mit markiertem Text
  msgs = await paste('#c', 'XYZ', `const r = document.createRange(); r.setStart(el.firstChild, 6); r.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(r);`);
  assert.equal(msgs[0]?.clip, 'start');
  assert.equal(await run('c.textContent'), 'Hallo XYZWelt');
  await run(`window.__glassClipInsert('schöne ')`);
  assert.equal(await run('c.textContent'), 'Hallo schöne Welt');
  await run(`window.__glassClipInsert('Q')`);
  assert.equal(await run('c.textContent'), 'Hallo QWelt');
  await run('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))');
  assert.deepEqual((await sent()).at(-1), { clip: 'end' });

  // 4. Enter nach dem Blättern schluckt Glass, ohne Blättern geht es an die Seite
  await run(`x.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.__enter = (window.__enter || 0) + 1; })`);
  await paste('#x', 'eins', '');
  await key('Enter', 'Enter', 13, '\r');
  assert.equal(await run('window.__enter'), 1);
  await paste('#x', 'zwei', '');
  await key('ArrowDown', 'ArrowDown', 40);
  await key('Enter', 'Enter', 13, '\r');
  assert.equal(await run('window.__enter'), 1, 'Enter after cycling only confirms');

  // 5. Seite fängt das Einfügen ab und setzt etwas anderes ein → keine Liste
  await run(`x.value = ''; x.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, 'anders'); }, { once: true })`);
  msgs = await paste('#x', 'Original', '');
  assert.deepEqual(msgs, []);

  // 6. Seitenskripte können die Funktionen nicht überschreiben
  await run(`window.__glassClipInsert = () => 'gekapert'`);
  assert.notEqual(await run('String(window.__glassClipInsert)'), "() => 'gekapert'");

  assert.deepEqual(errors, []);
  console.log('clipboard content test passed');
} finally {
  ws?.close();
  edge.kill();
  clearTimeout(watchdog);
}
