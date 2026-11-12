import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ecdhKeyPair, inviteFromFragment, publicRaw, b64u } from '../src/e2e.js';
import { pairPhone, PhoneSession } from '../src/phone-client.js';
import { loadRelay, RelayPc, relayAppUrl, relayInvite, relaySetup, relayWsUrl, removeRelayDevice } from '../src/remote/relay-pc.js';
import { MagnusError } from '../src/types.js';
import { fakeHome, fakeProtector } from './helpers.js';

// The real relay server (plain JS) from apps/relay.
const relayModule = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'apps', 'relay', 'server.mjs');

interface Relay {
  port: number;
  close: () => Promise<void>;
  /** Every frame the relay passed to the PC (to prove it never sees plain text). */
}

async function startRelay(): Promise<Relay> {
  const { createRelay } = (await import(new URL(`file:///${relayModule.replace(/\\/g, '/')}`).href)) as { createRelay: (o: object) => import('node:http').Server };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magnus-relay-e2e-'));
  fs.mkdirSync(path.join(dir, 'public'));
  const server = createRelay({ publicDir: path.join(dir, 'public'), dataFile: path.join(dir, 'rooms.json') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

test('relay urls: https only, except this PC', () => {
  assert.equal(relayWsUrl('relay.example.com'), 'wss://relay.example.com/ws');
  assert.equal(relayWsUrl('https://1.2.3.4.sslip.io/'), 'wss://1.2.3.4.sslip.io/ws');
  assert.equal(relayWsUrl('http://localhost:8080'), 'ws://localhost:8080/ws');
  assert.throws(() => relayWsUrl('http://relay.example.com'), MagnusError);
  assert.equal(relayAppUrl('wss://relay.example.com/ws'), 'https://relay.example.com/');
});

test('end to end: pair with a QR invite, then encrypted calls through a real relay', async () => {
  const relay = await startRelay();
  const env = fakeHome();
  const calls: string[] = [];
  const pc = new RelayPc(env, {
    protector: () => fakeProtector,
    log: () => {},
    rpc: {
      xtraos: async (method, params) => {
        calls.push(`${method} ${JSON.stringify(params)}`);
        if (method === 'list_windows') return { windows: [{ ref: 'w1', title: 'Claude', process: 'claude.exe', state: 'normal', focused: true, pid: 9 }] };
        if (method === 'approvals.answer') return { answered: true };
        if (method === 'approvers.add') return { id: 'appr9' };
        throw new MagnusError('NOPE', `unexpected ${method}`);
      },
      ask: async (task) => ({ ok: true, answer: `did: ${task}`, brain: 'codex' }),
    },
  });
  try {
    const cfg = await relaySetup(env, () => fakeProtector, `http://localhost:${relay.port}`);
    assert.equal(cfg.url, `ws://localhost:${relay.port}/ws`);
    await pc.start();

    const { link } = relayInvite(env, () => fakeProtector);
    const invite = inviteFromFragment(link.split('#p=')[1] ?? '');
    const keys = await ecdhKeyPair(false);
    const deviceId = await pairPhone(cfg.url, invite, keys, 'Om phone');
    assert.equal(loadRelay(env)?.devices[0]?.name, 'Om phone');
    await assert.rejects(pairPhone(cfg.url, invite, await ecdhKeyPair(false), 'Thief'), /no pairing code is open/, 'an invite works once');

    const s = new PhoneSession({ keys, relayUrl: cfg.url, room: invite.room, pcKey: invite.pcKey, deviceId });
    await s.open();
    assert.deepEqual(await s.call('ping'), { pong: true, device: 'Om phone' });
    const wins = await s.call<{ windows: { title: string }[] }>('windows');
    assert.equal(wins.windows[0]?.title, 'Claude');
    assert.ok(!('pid' in (wins.windows[0] as object)), 'only what the phone needs');
    await assert.rejects(s.call('approvals.answer', { uid: 'u', button: 0 }), /allow this device on the PC first/);
    assert.deepEqual(await s.call('approver.add', { publicKey: 'BAAA' }), { approverId: 'appr9' });
    assert.deepEqual(await s.call('approvals.answer', { uid: 'u1', button: 1, issued_ms: 5, signature: 'sig', device: 'forged' }), { answered: true });
    assert.equal(calls.at(-1), 'approvals.answer {"device":"appr9","uid":"u1","button":1,"issued_ms":5,"signature":"sig"}', 'the approver id comes from the pairing, never from the phone');
    // A quick call and a slow one at once both arrive (ordered encryption).
    const [a, b] = await Promise.all([s.call('ask', { task: 'open YouTube' }), s.call('ping')]);
    assert.deepEqual([a, b], [{ ok: true, answer: 'did: open YouTube', brain: 'codex' }, { pong: true, device: 'Om phone' }]);
    await assert.rejects(s.call('format_disk'), /unknown call/);
    s.close();

    // A phone that never paired, or was removed, gets nothing.
    const stranger = new PhoneSession({ keys: await ecdhKeyPair(false), relayUrl: cfg.url, room: invite.room, pcKey: invite.pcKey, deviceId: 'nope' });
    await assert.rejects(stranger.open(), /no longer paired/);
    removeRelayDevice(env, deviceId);
    const removed = new PhoneSession({ keys, relayUrl: cfg.url, room: invite.room, pcKey: invite.pcKey, deviceId });
    await assert.rejects(removed.open(), /no longer paired/);
  } finally {
    pc.stop();
    await relay.close();
  }
});

test('pairing: a wrong secret, an expired invite and a fake PC are refused', async () => {
  const relay = await startRelay();
  const env = fakeHome();
  let now = Date.now();
  const pc = new RelayPc(env, { protector: () => fakeProtector, log: () => {}, now: () => now, rpc: { xtraos: async () => ({}), ask: async () => ({ ok: true, answer: '', brain: null }) } });
  try {
    const cfg = await relaySetup(env, () => fakeProtector, `http://localhost:${relay.port}`);
    await pc.start();
    const invite = inviteFromFragment(relayInvite(env, () => fakeProtector).link.split('#p=')[1] ?? '');
    await assert.rejects(pairPhone(cfg.url, { ...invite, secret: b64u(new Uint8Array(32)) }, await ecdhKeyPair(false), 'x'), /does not match/, 'a guessed secret');

    const late = inviteFromFragment(relayInvite(env, () => fakeProtector).link.split('#p=')[1] ?? '');
    now += 11 * 60_000;
    await assert.rejects(pairPhone(cfg.url, late, await ecdhKeyPair(false), 'x'), /expired/);
    now = Date.now();

    // A session with the wrong PC key (a relay pretending to be the PC) cannot be opened.
    const good = inviteFromFragment(relayInvite(env, () => fakeProtector).link.split('#p=')[1] ?? '');
    const keys = await ecdhKeyPair(false);
    const deviceId = await pairPhone(cfg.url, good, keys, 'ok');
    const impostor = b64u(await publicRaw(await ecdhKeyPair(true)));
    const s = new PhoneSession({ keys, relayUrl: cfg.url, room: good.room, pcKey: impostor, deviceId });
    await s.open();
    await assert.rejects(s.call('ping', {}, 1500), /did not answer in time/, 'messages under a wrong key are dropped, not read');
    s.close();
  } finally {
    pc.stop();
    await relay.close();
  }
});
