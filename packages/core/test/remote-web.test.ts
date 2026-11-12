import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkAccess, type AccessRequest } from '../src/dashboard.js';
import { controlsFrom } from '../src/remote/controls.js';
import { claimDevice, deviceByToken, keyCode, listDevices, removeDevice, setApprover, startDevicePairing } from '../src/remote/devices.js';
import { MagnusError } from '../src/types.js';
import { parseBridgeError } from '../src/xtraos.js';
import { fakeHome } from './helpers.js';

const cfg = {
  port: 4747,
  runToken: 'run-tok',
  remoteHosts: ['mypc.tail1234.ts.net', 'localhost:4747'],
  device: (t: string) => (t === 'dev-tok' ? 'd1' : null),
};
const req = (over: Partial<AccessRequest>): AccessRequest => ({ method: 'GET', host: '127.0.0.1:4747', origin: null, runToken: 'run-tok', deviceToken: null, ...over });

test('access: this PC with the run token; a remote host with a paired device; nothing else', () => {
  assert.deepEqual(checkAccess(req({}), cfg), { ok: true, who: 'local' });
  assert.equal(checkAccess(req({ runToken: 'x' }), cfg).ok, false);

  const ts = { host: 'mypc.tail1234.ts.net' };
  assert.deepEqual(checkAccess(req({ ...ts, deviceToken: 'dev-tok', runToken: null }), cfg), { ok: true, who: 'device', deviceId: 'd1' });
  assert.deepEqual(checkAccess(req({ ...ts, runToken: 'run-tok' }), cfg), { ok: false, status: 401, message: 'this device is not paired', remote: true }, 'the run token does not work remotely');
  assert.equal(checkAccess(req({ ...ts, deviceToken: 'stolen?' }), cfg).ok, false);
  assert.deepEqual(checkAccess(req({ host: 'localhost:4747', deviceToken: 'dev-tok' }), cfg), { ok: true, who: 'device', deviceId: 'd1' }, 'localhost listed as remote: a test "phone"');

  assert.equal((checkAccess(req({ host: 'evil.example' }), cfg) as { status: number }).status, 403, 'DNS rebinding');
  assert.equal((checkAccess(req({ host: '192.168.1.5:4747', deviceToken: 'dev-tok' }), cfg) as { status: number }).status, 403, 'an address that was not configured');

  const post = { method: 'POST', ...ts, deviceToken: 'dev-tok' };
  assert.equal(checkAccess(req({ ...post, origin: 'https://mypc.tail1234.ts.net' }), cfg).ok, true);
  assert.equal(checkAccess(req({ ...post, origin: 'http://mypc.tail1234.ts.net' }), cfg).ok, false, 'a remote host must use https');
  assert.equal(checkAccess(req({ ...post, origin: 'https://evil.example' }), cfg).ok, false, 'another web page');
  assert.equal(checkAccess(req({ ...post, origin: null }), cfg).ok, false);
  assert.equal(checkAccess(req({ method: 'POST', origin: 'http://127.0.0.1:4747' }), cfg).ok, true);
  assert.equal(checkAccess(req({ method: 'POST', host: 'localhost:4747', origin: 'http://localhost:4747', deviceToken: 'dev-tok' }), cfg).ok, true);
});

test('devices: a one-time code makes a device; only hashes are stored; removal works', () => {
  const env = fakeHome();
  assert.throws(() => claimDevice(env, 'ABCD2345', 'Phone'), (e) => e instanceof MagnusError && e.code === 'NO_PAIRING');
  const code = startDevicePairing(env, 0);
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/, 'no 0/O/1/I/L');
  assert.throws(() => claimDevice(env, code, '  ', 1), MagnusError);
  assert.throws(() => claimDevice(env, 'WRONG234', 'Phone', 1), (e) => e instanceof MagnusError && e.code === 'WRONG_CODE');
  const { id, token } = claimDevice(env, ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `, 'Om phone', 2);
  assert.throws(() => claimDevice(env, code, 'Again', 3), (e) => e instanceof MagnusError && e.code === 'NO_PAIRING', 'a code works once');
  const stored = fs.readFileSync(path.join(env.magnusHome, 'devices.json'), 'utf8');
  assert.ok(!stored.includes(token) && !stored.includes(code), 'neither the token nor the code is stored');
  assert.equal(deviceByToken(env, token)?.id, id);
  assert.equal(deviceByToken(env, token + 'x'), null);
  assert.equal(deviceByToken(env, null), null);
  setApprover(env, id, 'appr1');
  assert.equal(listDevices(env)[0]?.approverId, 'appr1');
  assert.equal(removeDevice(env, id)?.approverId, 'appr1');
  assert.equal(deviceByToken(env, token), null, 'a removed device is locked out');

  startDevicePairing(env, 0);
  assert.throws(() => claimDevice(env, code, 'Late', 11 * 60_000), (e) => e instanceof MagnusError && e.code === 'NO_PAIRING', 'expired');
  const c3 = startDevicePairing(env, 0);
  for (let i = 0; i < 5; i++) assert.throws(() => claimDevice(env, 'ZZZZ2222', 'x', 1));
  assert.throws(() => claimDevice(env, c3, 'x', 1), (e) => e instanceof MagnusError && e.code === 'NO_PAIRING', 'five wrong tries end the code');
  assert.match(keyCode(Buffer.alloc(65, 4)), /^[0-9A-F]{4}-[0-9A-F]{4}$/);
});

test('controls: buttons to tap, fields to type into, and the dialog line', () => {
  const v = controlsFrom(
    [
      'w1 "Claude" claude.exe 1920x1080',
      '!! dialog w9 "Allow tool?" (blocking): "Run xtraos__click?" — buttons: e4 "Allow", e5 "Deny".',
      'e2 Button "Allow"',
      'e3 Button "Deny" (off)',
      'e6 Edit "Reply" = "hello \\"x\\""',
      'e7 Document "Chat"',
      'e8 Text "label"',
      'e9 Button ""',
      'e10 MenuItem "File" (collapsed)',
    ].join('\n'),
  );
  assert.deepEqual(v.tap.map((c) => [c.ref, c.name, c.off]), [['e2', 'Allow', false], ['e3', 'Deny', true], ['e10', 'File', false]]);
  assert.deepEqual(v.type.map((c) => [c.ref, c.role, c.value]), [['e6', 'Edit', 'hello \\"x\\"'], ['e7', 'Document', undefined]]);
  assert.match(v.dialog ?? '', /^dialog w9 "Allow tool\?"/);
});

test('bridge errors: code, message and hint from XtraOS', () => {
  assert.deepEqual(parseBridgeError('ERROR WINDOW_NOT_FOUND: no window matches "x"\nhint: Call list_windows.\n'), { code: 'WINDOW_NOT_FOUND', message: 'no window matches "x"', hint: 'Call list_windows.' });
  assert.equal(parseBridgeError('something odd').code, 'XTRAOS');
});
