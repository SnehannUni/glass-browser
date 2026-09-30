// Run with Node 22+ on Windows. Uses the installed Edge; no npm dependencies.
// Prüft mail-content.js mit nachgebauten Posteingängen unter den echten Adressen (CDP Fetch liefert die Seiten,
// nichts geht ins Netz): Ungelesene aus dem Titel, die Liste der neuesten Mails (Absender, Betreff, Vorschau, Zeit,
// ungelesen), iCloud im iframe, Mail öffnen (Gmail über die Adresse, iCloud meldet nur, wohin Glass klicken soll)
// und dass das Skript auf anderen Seiten gar nicht erst läuft.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const watchdog = setTimeout(() => { console.error('mail test exceeded 60 seconds'); process.exit(1); }, 60_000);
const script = await readFile(new URL('../src/mail-content.js', import.meta.url), 'utf8');

const GMAIL = `<!doctype html><title>Posteingang (1.234) - test@example.invalid - Gmail</title>
<a href="https://mail.google.com/mail/u/0/#inbox">Posteingang</a>
<table><tbody>
<tr role="row" class="zA zE"><td role="gridcell"><div class="yW"><span email="anna@example.invalid" name="Anna">Anna</span></div></td>
  <td role="gridcell"><span class="bog"><span data-legacy-thread-id="t1">Betreff eins</span></span><span class="y2"> - Vorschau eins</span></td>
  <td role="gridcell"><span title="Di., 29. Sept. 2026, 09:05">29. Sept.</span></td></tr>
<tr role="row" class="zA yO"><td role="gridcell"><div class="yW"><span email="bob@example.invalid" name="Bob">Bob</span></div></td>
  <td role="gridcell"><span class="bog"><span data-legacy-thread-id="t2">Betreff zwei</span></span><span class="y2"> - Vorschau zwei</span></td>
  <td role="gridcell"><span title="Mo., 28. Sept. 2026, 18:14">28. Sept.</span></td></tr>
</tbody></table>`;
const ICLOUD_TOP = `<!doctype html><title>Eingang (5) | iCloud Mail</title><style>body{margin:0}</style>
<iframe src="/applications/mail/" style="position:absolute;left:100px;top:50px;width:600px;height:500px;border:0"></iframe>`;
const row = (from, subject, stamp, unread) => `<div role="treeitem" class="thread-list-item" style="height:60px">
  ${unread ? '<span data-testid="unread-glyph"></span>' : ''}<span class="thread-participants">${from}</span>
  <span class="thread-timestamp">${stamp}</span><div class="thread-subject"><span>${subject}</span></div>
  <div class="thread-preview"><span>Vorschau ${subject}</span></div></div>`;
const ICLOUD_APP = `<!doctype html><style>body{margin:0}</style>
<ul><li role="option" aria-label="Eingang"><p>Eingang</p><p>5</p></li></ul>
${row('Carla', 'Heute', '10:37', true)}${row('Dora', 'Gestern', 'Gestern', false)}${row('Emil', 'Alt', '28.9.2026', true)}`;

const olRow = (id, from, subject, stamp, unread) => `<div role="option" data-convid="${id}" aria-label="${unread ? 'Ungelesen ' : ''}${from} ${subject}">
  <div><span title="${from.toLowerCase()}@example.invalid">${from}</span></div>
  <div><span>${subject}</span><span title="${stamp}">${stamp.slice(-5)}</span></div>
  <div><span>Vorschau ${subject}</span></div></div>`;
const OUTLOOK = `<!doctype html><title>E-Mail – Test – Outlook</title>
<div role="tree"><div role="treeitem" title="Posteingang"><span>Posteingang</span><span>634</span><span>ungelesen</span></div></div>
<div id="MailList" role="listbox">${olRow('c1', 'Fritz', 'Neu', 'Mi, 30.09.2026 14:04', true)}${olRow('c2', 'Gabi', 'Alt', 'Di, 29.09.2026 09:46', false)}</div>
<div id="ReadingPaneContainerId"></div>`;

await mkdir('target/mail-test', { recursive: true });
const profile = await mkdtemp(resolve('target/mail-test/profile-'));
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
  const serve = (url) => (url.startsWith('https://mail.google.com/') ? GMAIL
    : url.startsWith('https://outlook.office.com/') ? OUTLOOK
    : url.startsWith('https://www.icloud.com/applications/') ? ICLOUD_APP
    : url.startsWith('https://www.icloud.com/') ? ICLOUD_TOP : '<!doctype html><title>Andere Seite</title><a href="#inbox">Posteingang 3</a>');
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    if (m.method === 'Fetch.requestPaused') {
      const body = Buffer.from(serve(m.params.request.url)).toString('base64');
      ws.send(JSON.stringify({ id: ++seq, method: 'Fetch.fulfillRequest', params: {
        requestId: m.params.requestId, responseCode: 200, body,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } }));
    }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const run = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Fetch.enable', { patterns: [{ urlPattern: 'https://*' }] });
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.ipc = { postMessage: (m) => (window.__sent ||= []).push(JSON.parse(m)) };\n${script}`,
  });
  const open = async (url) => { await call('Page.navigate', { url }); await delay(2800); }; // Skript zählt nach 2 s
  const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

  // 1. Gmail: Zahl aus dem Titel (mit Tausenderpunkt), Liste mit Zeiten aus den Tooltips
  await open('https://mail.google.com/mail/u/0/');
  let sent = await run('window.__sent');
  assert.equal(sent.length, 1, 'eine Meldung, solange sich nichts ändert');
  let { unread, list } = sent[0].mail;
  assert.equal(unread, 1234);
  assert.deepEqual(list.map((m) => [m.key, m.from, m.subject, m.snippet, m.unread, m.time]), [
    ['t1', 'Anna', 'Betreff eins', 'Vorschau eins', true, at(2026, 9, 29, 9, 5)],
    ['t2', 'Bob', 'Betreff zwei', 'Vorschau zwei', false, at(2026, 9, 28, 18, 14)],
  ]);
  // Mail öffnen: Gmail springt über die Adresse; eine gelesene Mail liefert keine Liste mehr …
  await run(`window.__glassMailOpen('t2')`);
  assert.equal(await run('location.hash'), '#inbox/t2');
  // … bis Glass das Postfach im Hintergrund zurück in den Posteingang schickt
  await run(`window.__glassMailHome()`);
  assert.equal(await run('location.hash'), '#inbox');
  // Leseansicht: Stil in der Seite, und die nächste Meldung sagt Glass, dass sie gilt
  await run(`window.__glassMailReader(true)`);
  await delay(2300);
  assert.match(await run(`document.getElementById('__glass-reader').textContent`), /header#gb/);
  assert.equal((await run('window.__sent')).at(-1).mail.reader, true);
  await run(`window.__glassMailReader(false)`);
  assert.equal(await run(`document.getElementById('__glass-reader')`), null);

  // 2. iCloud: Zahl aus dem Titel, Liste aus dem iframe, relative Zeiten
  await open('https://www.icloud.com/mail/');
  sent = await run('window.__sent');
  ({ unread, list } = sent.at(-1).mail);
  assert.equal(unread, 5);
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).getTime();
  assert.deepEqual(list.map((m) => [m.from, m.subject, m.snippet, m.unread, m.time]), [
    ['Carla', 'Heute', 'Vorschau Heute', true, at(now.getFullYear(), now.getMonth() + 1, now.getDate(), 10, 37)],
    ['Dora', 'Gestern', 'Vorschau Gestern', false, yesterday],
    ['Emil', 'Alt', 'Vorschau Alt', true, at(2026, 9, 28)],
  ]);
  // Öffnen: keine nachgemachten Klicks (die bringen iCloud Mail zum Absturz), nur die Stelle für Glass –
  // Zeile im iframe plus dessen Versatz (100/50)
  await run(`window.__clicks = 0; document.querySelector('iframe').contentDocument.addEventListener('pointerdown', () => window.__clicks++, true)`);
  await run(`window.__glassMailOpen(${JSON.stringify(list[1].key)}); new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)))`);
  const click = (await run('window.__sent')).at(-1).mail.click;
  assert.equal(await run('window.__clicks'), 0);
  const rowTop = await run(`document.querySelector('iframe').contentDocument.querySelectorAll('.thread-list-item')[1].getBoundingClientRect().top`);
  assert.deepEqual(click, [100 + 60, Math.round(50 + rowTop + 30)]);
  // Leseansicht bei iCloud: der Stil gehört in das iframe der Mail-App
  await run(`window.__glassMailReader(true)`);
  assert.match(await run(`document.querySelector('iframe').contentDocument.getElementById('__glass-reader').textContent`), /thread-detail-pane/);

  // 3. Outlook: Zahl aus der Ordnerliste („Posteingang634ungelesen“), Liste mit ungelesen aus der Beschriftung,
  // Öffnen per Klick-Stelle; die Leseansicht legt die Lesefläche über alles
  await open('https://outlook.office.com/mail/');
  ({ unread, list } = (await run('window.__sent')).at(-1).mail);
  assert.equal(unread, 634);
  assert.deepEqual(list.map((m) => [m.key, m.from, m.subject, m.snippet, m.unread, m.time]), [
    ['c1', 'Fritz', 'Neu', 'Vorschau Neu', true, at(2026, 9, 30, 14, 4)],
    ['c2', 'Gabi', 'Alt', 'Vorschau Alt', false, at(2026, 9, 29, 9, 46)],
  ]);
  await run(`window.__glassMailReader(true)`);
  assert.equal(await run(`getComputedStyle(document.getElementById('ReadingPaneContainerId')).position`), 'fixed');
  await run(`window.__glassMailOpen('c2'); new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)))`);
  assert.ok((await run('window.__sent')).at(-1).mail.click, 'Outlook meldet die Klick-Stelle');
  assert.ok(await run(`document.documentElement.classList.contains('glass-pick')`), 'Lesefläche lässt den Klick durch');

  // 4. Andere Seiten: kein Zählen, keine Funktionen
  await open('https://example.invalid/');
  assert.equal(await run('window.__sent'), undefined);
  assert.equal(await run('typeof window.__glassMailOpen'), 'undefined');

  assert.deepEqual(errors, []);
  console.log('mail content test passed');
} finally {
  ws?.close();
  edge.kill();
  clearTimeout(watchdog);
}
