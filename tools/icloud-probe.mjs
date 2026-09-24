// Local capability probe. Does not request usernames or passwords.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const host = process.argv[2];
if (!host) throw new Error('Usage: node tools/icloud-probe.mjs <Apple helper path>');
const child = spawn(host, ['chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/'], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
let buffer = Buffer.alloc(0), replied = false;
const pair = process.argv.includes('--pair');
let session;
if (pair) {
  const source = readFileSync(new URL('../target/icloud-research/extension/background.js', import.meta.url), 'utf8');
  const context = vm.createContext({ self: { crypto: webcrypto }, atob, btoa });
  vm.runInContext(source.slice(0, source.indexOf('const ContextState=')) + ';globalThis.Session=SecretSession;', context);
  session = capabilities => new context.Session(capabilities);
}
function send(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const size = Buffer.alloc(4); size.writeUInt32LE(payload.length);
  child.stdin.write(Buffer.concat([size, payload]));
}
const timeout = setTimeout(() => { console.log('No capability response within 10 seconds'); child.kill(); }, 10000);
child.on('error', e => { clearTimeout(timeout); console.error(e.message); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timeout); console.log(`Helper exited (${code}); capability response: ${replied}`); });
child.stderr.on('data', () => {}); // Never print arbitrary host output.
child.stdout.on('data', data => {
  buffer = Buffer.concat([buffer, data]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (length > 1024 * 1024) { child.kill(); throw new Error('Oversized native message'); }
    if (buffer.length < length + 4) return;
    const msg = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
    buffer = buffer.subarray(length + 4);
    console.log(JSON.stringify({ command: msg.cmd, status: msg.STATUS, capabilities: msg.cmd === 14 ? msg.capabilities : undefined }));
    if (msg.cmd === 2 && msg.payload?.PAKE) {
      const handshake = JSON.parse(Buffer.from(msg.payload.PAKE, 'base64').toString());
      console.log(JSON.stringify({ handshake: msg.payload.QID, fields: Object.keys(handshake), error: handshake.ErrCode }));
      if (msg.payload.QID === 'm0') {
        console.log(`Reading only helper process ${child.pid}`);
        const reader = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../src/icloud/read-code.ps1', import.meta.url)), '-HelperProcessId', String(child.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        reader.stderr.on('data', chunk => console.error(chunk.toString().replace(/\d/g, 'x')));
        let code = '';
        reader.stdout.on('data', chunk => { code += chunk.toString(); });
        reader.on('exit', exit => {
          if (exit !== 0 || !/^\d{6}$/.test(code)) { console.log('Automatic code acquisition failed'); child.kill(); return; }
          session.setPin(code); code = '';
          send({ cmd: 2, msg: JSON.stringify({ QID: 'm2', PAKE: session.processMessage(msg.payload.PAKE) }) });
        });
      } else if (msg.payload.QID === 'm2') {
        const verified = session.processMessage(msg.payload.PAKE);
        console.log(`Automatic pairing verified: ${verified}`);
        child.stdin.end(); child.kill();
      }
    }
    if (msg.cmd === 14) {
      replied = true; clearTimeout(timeout);
      if (pair) {
        session = session(msg.capabilities);
        send({ cmd: 2, msg: JSON.stringify({ QID: 'm0', PAKE: session.initialMessage(), HSTBRSR: 'Glass Browser' }) });
        setTimeout(() => { child.stdin.end(); child.kill(); }, 60000).unref();
      } else { child.stdin.end(); child.kill(); }
    }
  }
});
child.stdin.on('error', () => {});
send({ cmd: 14 });
