// Magnus relay (ADR 0010): passes encrypted messages between one PC and its phones, and serves
// the phone app's static files. It stores only room-secret hashes and cannot read any message.
//
//   PC:    GET /ws?role=pc&room=<id>     first message {t:"auth", secret}; then {t:"to", cid, m}
//   phone: GET /ws?role=phone&room=<id>  sends any text; it reaches the PC as {t:"from", cid, m}
//   relay → PC: {t:"open"|"close", cid}   relay → phone: {t:"online"|"offline"}
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

export const LIMITS = { message: 1024 * 1024, phonesPerRoom: 5, rooms: 200, perMinute: 600 };
const ROOM = /^[A-Za-z0-9_-]{16,64}$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const HEADERS = {
  'content-security-policy': "default-src 'self'; connect-src 'self' wss: ws:; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Room ownership: the hash of each room's secret, kept across restarts. */
function roomStore(file) {
  let rooms = {};
  try {
    rooms = JSON.parse(fs.readFileSync(file, 'utf8')).rooms ?? {};
  } catch {
    // first start
  }
  return {
    /** First registration wins; afterwards the same secret is needed. */
    claim(room, secret) {
      if (typeof secret !== 'string' || secret.length < 32) return false;
      const h = sha(secret);
      if (rooms[room] === undefined) {
        if (Object.keys(rooms).length >= LIMITS.rooms) return false;
        rooms[room] = h;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ rooms }));
        return true;
      }
      return crypto.timingSafeEqual(Buffer.from(rooms[room], 'hex'), Buffer.from(h, 'hex'));
    },
  };
}

/** A small rate limiter per socket. */
function limiter() {
  let start = Date.now();
  let n = 0;
  return () => {
    const now = Date.now();
    if (now - start > 60_000) {
      start = now;
      n = 0;
    }
    return ++n <= LIMITS.perMinute;
  };
}

export function createRelay({ publicDir, dataFile, log = () => {} }) {
  const store = roomStore(dataFile);
  /** room → { pc: ws|null, phones: Map<cid, ws> } */
  const rooms = new Map();
  const room = (id) => rooms.get(id) ?? rooms.set(id, { pc: null, phones: new Map() }).get(id);
  const send = (ws, obj) => ws.readyState === 1 && ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(path.resolve(publicDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, HEADERS);
      res.end('not found');
      return;
    }
    res.writeHead(200, { ...HEADERS, 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: LIMITS.message });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    const role = url.searchParams.get('role');
    const id = url.searchParams.get('room') ?? '';
    if (!ROOM.test(id) || (role !== 'pc' && role !== 'phone')) {
      ws.close(4000, 'bad room or role');
      return;
    }
    const ok = limiter();
    const r = room(id);
    ws.missed = 0;
    // Any sign of life counts: a pong, or any message (a busy PC may answer pings late).
    ws.on('pong', () => (ws.missed = 0));
    ws.on('message', () => (ws.missed = 0));

    if (role === 'phone') {
      if (r.phones.size >= LIMITS.phonesPerRoom) {
        ws.close(4003, 'too many phones');
        return;
      }
      const cid = crypto.randomBytes(6).toString('hex');
      r.phones.set(cid, ws);
      send(ws, { t: r.pc ? 'online' : 'offline' });
      if (r.pc) send(r.pc, { t: 'open', cid });
      ws.on('message', (data, isBinary) => {
        if (isBinary || !ok()) return;
        if (r.pc) send(r.pc, { t: 'from', cid, m: data.toString() });
      });
      ws.on('close', () => {
        r.phones.delete(cid);
        if (r.pc) send(r.pc, { t: 'close', cid });
      });
      return;
    }

    // The PC: must prove the room secret first.
    let authed = false;
    const timer = setTimeout(() => !authed && ws.close(4001, 'no auth'), 10_000);
    ws.on('message', (data, isBinary) => {
      if (isBinary || !ok()) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!authed) {
        if (msg.t !== 'auth' || !store.claim(id, msg.secret)) {
          ws.close(4001, 'wrong room secret');
          return;
        }
        authed = true;
        clearTimeout(timer);
        if (r.pc && r.pc !== ws) r.pc.close(4002, 'replaced by a new connection');
        r.pc = ws;
        send(ws, { t: 'ok' });
        for (const [cid, phone] of r.phones) {
          send(phone, { t: 'online' });
          send(ws, { t: 'open', cid });
        }
        log(`pc online in room ${id.slice(0, 6)}…`);
        return;
      }
      if (msg.t === 'to' && typeof msg.m === 'string') {
        const phone = r.phones.get(msg.cid);
        if (phone) send(phone, msg.m);
      }
      // The PC's own heartbeat: it notices a dead connection quickly and reconnects.
      if (msg.t === 'ping') send(ws, { t: 'pong' });
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (r.pc === ws) {
        r.pc = null;
        for (const phone of r.phones.values()) send(phone, { t: 'offline' });
      }
    });
  });

  // Drop dead connections (mobile networks go away without closing), but only after 3 missed
  // beats (~90 s): a PC under heavy load can answer one ping late (ADR 0017).
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if ((ws.missed ?? 0) >= 3) ws.terminate();
      else {
        ws.missed = (ws.missed ?? 0) + 1;
        ws.ping();
      }
    }
  }, 30_000);
  // Stopping the relay ends every WebSocket too (an upgraded socket would keep close() waiting).
  const close = server.close.bind(server);
  server.close = (cb) => {
    clearInterval(beat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    return close(cb);
  };
  return server;
}

// Run as a program: PORT (default 8080), DATA_FILE (default ./data/rooms.json).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const port = Number(process.env.PORT ?? 8080);
  const server = createRelay({
    publicDir: process.env.PUBLIC_DIR ?? path.join(here, 'public'),
    dataFile: process.env.DATA_FILE ?? path.join(here, 'data', 'rooms.json'),
    log: (l) => console.log(new Date().toISOString(), l),
  });
  server.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log(`Magnus relay on :${port}`));
}
