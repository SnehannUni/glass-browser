// Exercises the installed private adapter, without requesting any real-site credentials.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = join(process.env.LOCALAPPDATA, 'Programs', 'GlassBrowser', 'icloud');
const child = spawn(join(root, 'node.exe'), [join(root, 'bridge.mjs')], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
const timer = setTimeout(() => { child.kill(); throw new Error('iCloud smoke test timed out'); }, 45000);
try {
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(JSON.stringify({ id: 1, op: 'probe' }) + '\n');
  const paired = JSON.parse((await lines.next()).value);
  assert.equal(paired.data?.paired, true, paired.error || 'automatic pairing');
  child.stdin.write(JSON.stringify({ id: 2, op: 'list', host: 'glass-autofill-test.invalid' }) + '\n');
  const list = JSON.parse((await lines.next()).value);
  assert.deepEqual(list.data?.accounts, [], list.error || 'empty account list for reserved .invalid domain');
  console.log('PASS: automatic iCloud pairing and encrypted empty-account query. No real-site passwords requested.');
} finally { clearTimeout(timer); child.stdin.end(); }
