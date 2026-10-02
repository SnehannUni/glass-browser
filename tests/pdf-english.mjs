// PDF-Viewer auf Englisch (GLASS_LANG=en): feste Texte, Meldungen, Suche, Editor-Texte von PDF.js, Platzhalter.
// Run after `cargo build`, using Node 22+ on Windows. No npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Kleines PDF mit `pages` Seiten; auf jeder steht `Page n`, auf Seite 2 zusätzlich das Suchwort. */
function makePdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let n = 1; n <= pages; n++) {
    const text = `BT /F1 28 Tf 72 720 Td (Page ${n}) Tj ${n === 2 ? '0 -40 Td (Crystal clear keyword) Tj ' : ''}ET`;
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objects.length} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

await mkdir('target/pdf-smoke', { recursive: true });
const profile = await mkdtemp(resolve('target/pdf-smoke/profile-en-'));
const pdf = makePdf(3);
const server = createServer((req, res) => {
  if (req.url === '/Report.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length }); res.end(pdf); return; }
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const portProbe = createServer();
await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const port = portProbe.address().port;
await new Promise(r => portProbe.close(r));
const app = spawn(resolve('target/debug/glass-browser.exe'), [`${origin}/Report.pdf`], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: profile, GLASS_LANG: 'en',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const sockets = [];
const watchdog = setTimeout(() => { console.error('FAIL: watchdog'); app.kill(); process.exit(1); }, 60000);
async function waitFor(check, label) {
  for (let i = 0; i < 200; i++) { try { if (await check()) return; } catch { /* Seite lädt noch */ } await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
  return async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
}
const $ = (id, prop = 'textContent') => `document.getElementById(${JSON.stringify(id)}).${prop}`;
/** Alle Texte und Beschriftungen der Oberfläche (ohne die Seiten des PDFs selbst), auch die verborgener Dialoge. */
const uiTexts = `(() => {
  const out = [];
  const skip = (el) => el.closest('#viewer, #thumbs, script, style');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.trim() && !skip(n.parentElement)) out.push(n.data.trim());
  for (const el of document.body.querySelectorAll('[title], [aria-label], [placeholder], [alt], input, textarea, option')) {
    if (skip(el)) continue;
    for (const a of ['title', 'aria-label', 'placeholder', 'alt']) if (el.getAttribute(a)) out.push(el.getAttribute(a));
    if (el.value && el.type !== 'range' && el.type !== 'number') out.push(el.value);
    if (el.label) out.push(el.label);
  }
  return out;
})()`;
// Deutsche Wörter und Zeichen, die auf Englisch nirgends stehen dürfen
const GERMAN = /[äöüÄÖÜß„]|\b(Seite|Seiten|Speichern|Abbrechen|Hinzufügen|Schwärzen|Unterschrift|Notiz|Bild|Bilder|Strg|Umschalt|Rückgängig|Wiederholen|Löschen|Größe|Datei|und|oder|nicht|Kein|Keine|VERTRAULICH|Genehmigt|Entwurf|seite|seiten|datum|datei)\b/;

try {
  let list;
  await waitFor(async () => { list = await targets(); return list.some(t => t.url.endsWith('/Report.pdf')); }, 'browser startup');
  const page = await connect(list.find(t => t.url.endsWith('/Report.pdf')));
  await waitFor(() => page(`document.querySelectorAll('#viewer .page').length === 3 && document.getElementById('status').classList.contains('done')`), 'viewer rendered');

  assert.equal(await page(`document.documentElement.lang`), 'en');
  assert.equal(await page($('search', 'title')), 'Find (Ctrl F)');
  assert.equal(await page($('download', 'title')), 'Save (Ctrl S)');
  assert.equal(await page(`document.querySelector('[data-tool="redact"]').title`), 'Redact (R)');
  assert.equal(await page($('zoom-value')), '100%');
  assert.equal(await page($('wm-text', 'value')), 'CONFIDENTIAL');
  assert.equal(await page($('field-options', 'value')), 'Yes\nNo');
  assert.equal(await page(`document.querySelector('#protect-form .field:nth-of-type(2) span').textContent`), 'Confirm');
  assert.deepEqual(await page(`[...document.querySelectorAll('#stamps .stamp')].map(b => b.textContent)`), ['Approved', 'Reviewed', 'Completed', 'Draft', 'Confidential', 'Rejected']);
  console.log('PASS: html lang, toolbar titles, zoom, default values and stamps are English.');

  // Suche: Treffer zählen und „keine Treffer“
  await page(`(() => { const i = document.getElementById('find-input'); i.value = 'keyword'; i.dispatchEvent(new Event('input')); })()`);
  await waitFor(async () => (await page($('find-count'))) === '1 of 1', 'search count');
  await page(`(() => { const i = document.getElementById('find-input'); i.value = 'zzzz'; i.dispatchEvent(new Event('input')); })()`);
  await waitFor(async () => (await page($('find-count'))) === 'No matches', 'no matches');
  console.log('PASS: find shows "1 of 1" and "No matches".');

  // Editoren von PDF.js: eingebaute englische Texte statt de.ftl
  const l10n = await page(`(async () => ({ lang: glassPdf.viewer.l10n.getLanguage(), ink: await glassPdf.viewer.l10n.get('pdfjs-editor-ink-button-label'), typing: await glassPdf.viewer.l10n.get('pdfjs-editor-add-signature-type-button') }))()`);
  assert.deepEqual(l10n, { lang: 'en-us', ink: 'Draw', typing: 'Type' });
  console.log('PASS: PDF.js editor strings come from its built-in English bundle.');

  // Dynamische Texte: Organisieren, Kommentare, Dateigröße
  await page(`glassPdf.organize.open()`);
  await waitFor(async () => (await page($('org-count'))) === '1 of 3 selected', 'organize count');
  await page(`glassPdf.organize.close()`);
  await page(`glassPdf.showSidebarView('comments')`);
  await waitFor(async () => (await page(`document.querySelector('#comments .empty')?.textContent`)) === 'No comments yet. Pin a note with the Note tool (N).', 'empty comments');
  await page(`glassPdf.showSidebarView('thumbs')`);
  await page(`glassPdf.compress.open()`);
  await waitFor(async () => /^Currently \d+ KB\. The reduced version is saved as a new file/.test(await page($('compress-size'))), 'compress size');
  console.log('PASS: organize, comments and compress texts are English.');

  // Keine deutschen Wörter in der ganzen Oberfläche, auch nicht in verborgenen Dialogen
  const texts = await page(uiTexts);
  assert.ok(texts.length > 200, `UI texts found: ${texts.length}`);
  const german = texts.filter(s => GERMAN.test(s));
  assert.deepEqual(german, [], 'German text left in the English UI');
  await page(`document.getElementById('compress-cancel').dispatchEvent(new Event('click'))`);
  console.log(`PASS: no German words in ${texts.length} viewer UI texts.`);

  // Seitenzahlen: englische Platzhalter im Format, die deutschen gelten weiterhin
  const numbers = await page(`(async () => {
    const lib = await glassPdf.loadPdfLib();
    const format = document.getElementById('num-format').value;
    const text = async (slot) => {
      const bytes = await glassPdf.design.decorate(lib, await glassPdf.workingBytes(), { kind: 'numbers', pages: '', slots: { 'footer-center': slot }, size: 9, start: 1 });
      const d = await pdfjsLib.getDocument({ data: bytes }).promise;
      return (await (await d.getPage(3)).getTextContent()).items.map(i => i.str).join(' ');
    };
    return { format, english: await text(format), german: await text('{seite}/{seiten}') };
  })()`);
  assert.equal(numbers.format, 'Page {page} of {pages}');
  assert.ok(numbers.english.includes('Page 3 of 3'), numbers.english);
  assert.ok(numbers.german.includes('3/3'), numbers.german);
  console.log('PASS: page numbers use {page}/{pages}, the German placeholders still work.');
} finally {
  clearTimeout(watchdog);
  sockets.forEach(s => s.close());
  app.kill();
  server.close();
}
