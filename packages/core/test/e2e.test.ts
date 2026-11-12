import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  b64u,
  Channel,
  ecdhKeyPair,
  exportPrivateJwk,
  hmac,
  importPrivateJwk,
  inviteFromFragment,
  inviteToFragment,
  pairText,
  publicRaw,
  randomBytes,
  sameMac,
  sessionKey,
  unb64u,
} from '../src/e2e.js';

async function session() {
  const phone = await ecdhKeyPair(false);
  const pc = await ecdhKeyPair(true);
  const pn = randomBytes(16);
  const cn = randomBytes(16);
  const kPhone = await sessionKey(phone.privateKey, await publicRaw(pc), pn, cn);
  const kPc = await sessionKey(pc.privateKey, await publicRaw(phone), pn, cn);
  return { phone, pc, pn, cn, kPhone, kPc };
}

test('e2e: both sides derive the same key; messages go both ways', async () => {
  const s = await session();
  const a = new Channel(s.kPhone);
  const b = new Channel(s.kPc);
  const m = await a.seal({ method: 'windows', id: 1 });
  assert.ok(!m.ct.includes('windows'), 'not readable on the relay');
  assert.deepEqual(await b.open(m), { method: 'windows', id: 1 });
  assert.deepEqual(await a.open(await b.seal({ id: 1, result: ['ok'] })), { id: 1, result: ['ok'] });
});

test('e2e: tampering, a wrong key, a replay and another session are refused', async () => {
  const s = await session();
  const a = new Channel(s.kPhone);
  const b = new Channel(s.kPc);
  const m1 = await a.seal('one');
  const m2 = await a.seal('two');

  const bytes = unb64u(m1.ct);
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  await assert.rejects(b.open({ iv: m1.iv, ct: b64u(bytes) }), 'tampered');
  assert.equal(await b.open(m1), 'one');
  await assert.rejects(b.open(m1), /replayed/, 'the same message twice');
  assert.equal(await b.open(m2), 'two');

  const other = await session();
  await assert.rejects(new Channel(other.kPc).open(await a.seal('x')), 'a key from another pair');
  // Same keys, new nonces: a recorded message does not open in a new session.
  const k2 = await sessionKey(s.pc.privateKey, await publicRaw(s.phone), randomBytes(16), s.cn);
  await assert.rejects(new Channel(k2).open(await a.seal('y')), 'another session');
});

test('e2e: the PC key survives storage; pairing MACs and the invite link', async () => {
  const s = await session();
  const restored = await importPrivateJwk(await exportPrivateJwk(s.pc.privateKey));
  const k = await sessionKey(restored, await publicRaw(s.phone), s.pn, s.cn);
  assert.equal(await new Channel(k).open(await new Channel(s.kPhone).seal('after restart')), 'after restart');

  const secret = randomBytes(32);
  const mac = await hmac(secret, pairText.phone('p1', 'KEY', 'Phone'));
  assert.ok(sameMac(mac, await hmac(secret, pairText.phone('p1', 'KEY', 'Phone'))));
  assert.ok(!sameMac(mac, await hmac(secret, pairText.phone('p1', 'KEY2', 'Phone'))), 'another key');
  assert.ok(!sameMac(mac, await hmac(randomBytes(32), pairText.phone('p1', 'KEY', 'Phone'))), 'another secret');
  assert.notEqual(pairText.phone('a', 'b', 'c'), pairText.pc('a', 'b', 'c'));

  const invite = { room: 'r'.repeat(22), pcKey: b64u(await publicRaw(s.pc)), pairId: 'p1', secret: b64u(secret) };
  const frag = inviteToFragment(invite);
  assert.match(frag, /^[A-Za-z0-9_-]+$/, 'safe in a URL');
  assert.deepEqual(inviteFromFragment(frag), invite);
  assert.throws(() => inviteFromFragment(b64u(new TextEncoder().encode('{"room":1}'))), /not a Magnus pairing link/);
});
