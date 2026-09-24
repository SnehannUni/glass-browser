// Private local adapter: Apple protocol code is supplied by the local setup, not bundled in Glass.
// stdin/stdout are private pipes to Glass. Never log messages, codes, account names or passwords.
import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { promisify } from 'node:util';
import { AccountCache } from './account-cache.mjs';

const run = promisify(execFile);
const root = new URL('./', import.meta.url);
const context = vm.createContext({ self: { crypto: webcrypto }, atob, btoa });
vm.runInContext(await readFile(new URL('protocol.js', root), 'utf8'), context);
let helper, session, paired = false, pending = null, accounts = new Map();
const cache = new AccountCache();

function disconnect() {
  paired = false; session = null; accounts.clear(); cache.clear();
  helper?.kill(); helper = null;
  if (pending) { const { reject } = pending; pending = null; reject(new Error('iCloud-Verbindung beendet.')); }
}
async function connect() {
  if (paired) return;
  disconnect();
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-AppxPackage AppleInc.iCloud | Select-Object -First 1).InstallLocation'], { windowsHide: true, timeout: 10000 });
  const path = stdout.trim();
  if (!/^[A-Z]:\\Program Files\\WindowsApps\\AppleInc\.iCloud_[^\\]+$/i.test(path)) throw new Error('iCloud für Windows wurde nicht gefunden.');
  const host = spawn(`${path}\\iCloud\\iCloudPasswordsExtensionHelper.exe`, ['chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  helper = host;
  let buffer = Buffer.alloc(0);
  host.stderr.resume();
  host.on('error', () => { if (helper === host) disconnect(); });
  host.on('exit', () => { if (helper === host) disconnect(); });
  host.stdin.on('error', () => { if (helper === host) disconnect(); });
  host.stdout.on('data', data => {
    if (helper !== host) return;
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > 1024 * 1024) { disconnect(); return; }
      if (buffer.length < length + 4) return;
      let msg;
      try { msg = JSON.parse(buffer.subarray(4, length + 4).toString()); } catch { disconnect(); return; }
      buffer = buffer.subarray(length + 4);
      if (msg.cmd === 9 || msg.cmd === 10) { disconnect(); return; }
      if (pending?.cmd === msg.cmd) { const { resolve } = pending; pending = null; resolve(msg); }
    }
  });
  const caps = await request({ cmd: 14 });
  if (caps.capabilities?.secretSessionVersion !== 1) throw new Error('Diese iCloud-Protokollversion wird nicht unterstützt.');
  session = new context.Session(caps.capabilities);
  const first = await request({ cmd: 2, msg: JSON.stringify({ QID: 'm0', PAKE: session.initialMessage(), HSTBRSR: 'Glass Browser' }) });
  const code = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('read-code.ps1', root)), '-HelperProcessId', String(host.pid)], { windowsHide: true, timeout: 18000 });
  if (!/^\d{6}$/.test(code.stdout)) throw new Error('iCloud konnte nicht automatisch freigegeben werden.');
  session.setPin(code.stdout); code.stdout = '';
  const proof = session.processMessage(first.payload.PAKE);
  session.setPin('');
  const final = await request({ cmd: 2, msg: JSON.stringify({ QID: 'm2', PAKE: proof }) });
  if (!session.processMessage(final.payload.PAKE)) throw new Error('iCloud-Freigabe fehlgeschlagen.');
  paired = true;
}
function request(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { disconnect(); reject(new Error('iCloud antwortet nicht.')); }, 10000);
    pending = { cmd: message.cmd, resolve: msg => { clearTimeout(timer); resolve(msg); }, reject: error => { clearTimeout(timer); reject(error); } };
    const payload = Buffer.from(JSON.stringify(message)), size = Buffer.alloc(4);
    size.writeUInt32LE(payload.length);
    helper.stdin.write(Buffer.concat([size, payload]));
  });
}
function entries(data) {
  return data.Entries || Object.entries(data).filter(([key]) => key.startsWith('Entry_')).map(([, value]) => value);
}
async function handle(input) {
  if (!Number.isSafeInteger(input.id)) throw new Error('Ungültige Anfrage.');
  if (input.op === 'probe') { await connect(); return { paired: true }; }
  if (!['list', 'fill'].includes(input.op) || typeof input.host !== 'string' || !/^[a-z0-9.-]+$/i.test(input.host)) throw new Error('Ungültige Website.');
  await connect();
  const fill = input.op === 'fill';
  if (!fill) {
    const cached = cache.get(input.host);
    if (cached) return {accounts: cached};
  }
  if (fill && !accounts.get(input.host)?.includes(input.username)) throw new Error('Account erneut auswählen.');
  const query = { ACT: fill ? 2 : 5, URL: input.host, ...(fill ? { USR: input.username } : {}) };
  const response = await request({ cmd: fill ? 5 : 4, tabId: 1, frameId: 0, url: input.host,
    payload: JSON.stringify({ QID: fill ? 'CmdGetPassword4LoginName' : 'CmdGetLoginNames4URL', SMSG: session.createSMSG(JSON.stringify(query)) }) });
  const data = JSON.parse(session.parseSMSG(response.payload.SMSG));
  if (data.STATUS === 3) { accounts.delete(input.host); cache.set(input.host, []); return { accounts: [] }; }
  if (data.STATUS !== 0) throw new Error('iCloud ist gesperrt oder nicht verfügbar.');
  const matches = entries(data).filter(e => typeof e.USR === 'string' && e.sites?.includes(input.host));
  if (fill) {
    const entry = matches.find(e => e.USR === input.username && typeof e.PWD === 'string' && e.PWD !== 'Not Included');
    if (!entry) throw new Error('Kein passender Login gefunden.');
    return { username: entry.USR, password: entry.PWD };
  }
  const result = matches.map(e => ({ username: e.USR, label: e.customTitle || input.host }));
  accounts.delete(input.host);
  accounts.set(input.host, result.map(e => e.username));
  if (accounts.size > 128) accounts.delete(accounts.keys().next().value);
  cache.set(input.host, result);
  return { accounts: result };
}
let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  if (line.length > 16384) return;
  queue = queue.then(async () => {
    let input;
    try {
      input = JSON.parse(line);
      const data = await handle(input);
      process.stdout.write(JSON.stringify({ id: input.id, data }) + '\n');
    } catch {
      disconnect();
      process.stdout.write(JSON.stringify({ id: input?.id, error: 'iCloud-Passwörter sind gerade nicht verfügbar. Bitte iCloud für Windows prüfen.' }) + '\n');
    }
  });
});
lines.on('close', () => { disconnect(); process.exit(0); });
