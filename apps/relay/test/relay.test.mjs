import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRelay, LIMITS } from '../server.mjs';

const ROOM = 'room-for-tests-1234567890';
const SECRET = 's'.repeat(43);

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magnus-relay-'));
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<!doctype html><title>Magnus</title>');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside');
  const server = createRelay({ publicDir: path.join(dir, 'public'), dataFile: path.join(dir, 'data', 'rooms.json') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, port, dir, close: () => new Promise((r) => server.close(r)) };
}

/** A socket whose incoming messages are queued. */
function connect(port, role, room = ROOM) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}&room=${room}`);
  const queue = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const v = e.data;
    if (waiters.length) waiters.shift()(v);
    else queue.push(v);
  });
  const closed = new Promise((r) => ws.addEventListener('close', (e) => r(e.code)));
  return {
    ws,
    closed,
    open: () => new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }),
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
    json: async function () { return JSON.parse(await this.next()); },
    send: (v) => ws.send(typeof v === 'string' ? v : JSON.stringify(v)),
  };
}

test('relay: a phone and the PC exchange messages through a room; the relay only forwards', async () => {
  const r = await start();
  try {
    const phone = connect(r.port, 'phone');
    await phone.open();
    assert.deepEqual(await phone.json(), { t: 'offline' }, 'no PC yet');

    const pc = connect(r.port, 'pc');
    await pc.open();
    pc.send({ t: 'auth', secret: SECRET });
    assert.deepEqual(await pc.json(), { t: 'ok' });
    const opened = await pc.json();
    assert.equal(opened.t, 'open');
    assert.deepEqual(await phone.json(), { t: 'online' });

    phone.send('ciphertext-from-phone');
    assert.deepEqual(await pc.json(), { t: 'from', cid: opened.cid, m: 'ciphertext-from-phone' });
    pc.send({ t: 'to', cid: opened.cid, m: 'ciphertext-from-pc' });
    assert.equal(await phone.next(), 'ciphertext-from-pc');

    phone.ws.close();
    assert.deepEqual(await pc.json(), { t: 'close', cid: opened.cid });
    pc.ws.close();
  } finally {
    await r.close();
  }
});

test('relay: the room secret — first PC owns the room; a wrong secret is refused; it survives restarts', async () => {
  const r = await start();
  try {
    const a = connect(r.port, 'pc');
    await a.open();
    a.send({ t: 'auth', secret: SECRET });
    assert.deepEqual(await a.json(), { t: 'ok' });

    const thief = connect(r.port, 'pc');
    await thief.open();
    thief.send({ t: 'auth', secret: 'x'.repeat(43) });
    assert.equal(await thief.closed, 4001, 'wrong secret');

    const again = connect(r.port, 'pc');
    await again.open();
    again.send({ t: 'auth', secret: SECRET });
    assert.deepEqual(await again.json(), { t: 'ok' });
    assert.equal(await a.closed, 4002, 'the older PC connection is replaced');

    const short = connect(r.port, 'pc', 'another-room-abcdefghij');
    await short.open();
    short.send({ t: 'auth', secret: 'short' });
    assert.equal(await short.closed, 4001, 'a weak secret cannot claim a room');
    again.ws.close();
    const stored = fs.readFileSync(path.join(r.dir, 'data', 'rooms.json'), 'utf8');
    assert.ok(!stored.includes(SECRET), 'only the hash is stored');
  } finally {
    await r.close();
  }
});

test('relay: bad rooms, too many phones, files outside the app, security headers', async () => {
  const r = await start();
  try {
    const bad = connect(r.port, 'phone', 'short');
    assert.equal(await bad.closed, 4000);
    const phones = [];
    for (let i = 0; i < LIMITS.phonesPerRoom; i++) {
      const p = connect(r.port, 'phone');
      await p.open();
      phones.push(p);
    }
    const extra = connect(r.port, 'phone');
    assert.equal(await extra.closed, 4003);
    for (const p of phones) p.ws.close();

    const home = await fetch(`http://127.0.0.1:${r.port}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
      assert.equal((await fetch(`http://127.0.0.1:${r.port}${p}`)).status, 404, p);
    }
    assert.equal(await (await fetch(`http://127.0.0.1:${r.port}/healthz`)).text(), 'ok');
  } finally {
    await r.close();
  }
});
