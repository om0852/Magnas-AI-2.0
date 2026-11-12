import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  autostartOff,
  autostartOn,
  autostartStatus,
  fileLog,
  RELAY_VALUE,
  relayStartCommand,
  runningRelay,
  takeRelayLock,
  XTRAOS_VALUE,
  type RunList,
} from '../src/autostart.js';
import { fakeHome } from './helpers.js';

function fakeList(): RunList & { values: Map<string, string> } {
  const values = new Map<string, string>([['OneDrive', '"C:\\OneDrive.exe" /background']]);
  return { values, get: (n) => values.get(n) ?? null, set: (n, c) => void values.set(n, c), remove: (n) => void values.delete(n) };
}

test('autostart: the relay command runs Node hidden with paths quoted for PowerShell', () => {
  const cmd = relayStartCommand('C:\\Program Files\\nodejs\\node.exe', "C:\\Users\\o'brien\\D folder\\cli.js", 'C:\\Users\\me\\.magnus\\logs\\relay.log');
  assert.ok(cmd.startsWith('powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "'));
  assert.ok(cmd.includes(`& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\o''brien\\D folder\\cli.js' relay run --log 'C:\\Users\\me\\.magnus\\logs\\relay.log'`), cmd);
  assert.ok(cmd.endsWith('"'));
});

test('autostart: on adds both entries, off removes only ours', () => {
  const list = fakeList();
  assert.deepEqual(autostartStatus(list), { relay: null, xtraos: null });
  const on = autostartOn(list, 'RELAY-CMD', 'C:\\XtraOS\\bin\\xtraos-core.exe');
  assert.deepEqual(on, { relay: 'RELAY-CMD', xtraos: '"C:\\XtraOS\\bin\\xtraos-core.exe"' });
  assert.deepEqual(autostartOn(fakeList(), 'R', null).xtraos, null, 'no XtraOS installed: no entry for it');
  const off = autostartOff(list);
  assert.deepEqual(off, { relay: null, xtraos: null });
  assert.deepEqual([...list.values.keys()], ['OneDrive'], 'other programs are untouched');
  assert.ok(![...list.values.keys()].includes(RELAY_VALUE) && ![...list.values.keys()].includes(XTRAOS_VALUE));
});

test('relay lock: a second relay connection does not start while one runs', async () => {
  const env = fakeHome();
  assert.equal(runningRelay(env), null);
  // Another process holds the lock.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(env.magnusHome, { recursive: true });
    fs.writeFileSync(path.join(env.magnusHome, 'relay.lock'), String(other.pid));
    assert.equal(runningRelay(env), other.pid);
    assert.equal(takeRelayLock(env), false);
  } finally {
    other.kill();
    await new Promise((r) => other.once('exit', r));
  }
  assert.equal(runningRelay(env), null, 'a lock left by a dead process does not count');
  assert.equal(takeRelayLock(env), true);
  assert.equal(fs.readFileSync(path.join(env.magnusHome, 'relay.lock'), 'utf8'), String(process.pid));
});

test('relay log: lines go to the file, which stays under about 1 MB', () => {
  const env = fakeHome();
  const file = path.join(env.magnusHome, 'logs', 'relay.log');
  const log = fileLog(file);
  log('connected');
  assert.match(fs.readFileSync(file, 'utf8'), /^\d{4}-\d{2}-\d{2}T.* connected\n$/);
  const line = 'x'.repeat(1000);
  for (let i = 0; i < 1200; i++) log(line);
  assert.ok(fs.statSync(file).size < 1.1 * 1024 * 1024);
  log('latest');
  assert.ok(fs.readFileSync(file, 'utf8').trimEnd().endsWith('latest'));
});
