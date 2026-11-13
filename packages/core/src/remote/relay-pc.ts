/** The PC side of the relay (ADR 0010): setup, pairing invites, and the connection that answers phones. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  b64u,
  Channel,
  ecdhKeyPair,
  exportPrivateJwk,
  hmac,
  importPrivateJwk,
  inviteToFragment,
  pairText,
  publicRaw,
  randomBytes,
  sameMac,
  sessionKey,
  unb64u,
  type Sealed,
} from '../e2e.js';
import { readSecrets, removeSecret, secretNames, setSecret, type Protector } from '../secrets.js';
import { MagnusError, type Env } from '../types.js';
import { rpc, type RpcDeps } from './rpc.js';

export const PAIR_MINUTES = 10;
const KEY_SECRET = 'RELAY_PC_KEY';
const ROOM_SECRET = 'RELAY_ROOM_SECRET';
const PAIR_SECRET = 'RELAY_PAIRING';

export interface RelayDevice {
  id: string;
  name: string;
  /** The phone's ECDH public key, raw, base64url. */
  phoneKey: string;
  created: string;
  approverId?: string;
}

export interface RelayConfig {
  version: 1;
  /** The relay's WebSocket address, e.g. wss://relay.example/ws */
  url: string;
  room: string;
  /** The PC's ECDH public key, raw, base64url. */
  pcKey: string;
  devices: RelayDevice[];
}

function file(env: Env): string {
  return path.join(env.magnusHome, 'relay.json');
}

export function loadRelay(env: Env): RelayConfig | null {
  try {
    const c = JSON.parse(fs.readFileSync(file(env), 'utf8')) as RelayConfig;
    return c.version === 1 ? c : null;
  } catch {
    return null;
  }
}

function saveRelay(env: Env, c: RelayConfig): void {
  fs.mkdirSync(env.magnusHome, { recursive: true });
  fs.writeFileSync(file(env), JSON.stringify(c, null, 2) + '\n');
}

/** wss://host/ws from what the user typed (https://host, host, …). Plain ws only for this PC. */
export function relayWsUrl(input: string): string {
  const raw = /^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
  const u = new URL(raw);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (!local && (u.protocol === 'http:' || u.protocol === 'ws:')) throw new MagnusError('BAD_ARGS', 'the relay must use https (only localhost may use http)');
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  return `${secure ? 'wss' : 'ws'}://${u.host}/ws`;
}

/** The phone app's address on the relay (https://host/). */
export function relayAppUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  return `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/`;
}

/** First setup (or a new relay address): room, PC key and room secret. Keeps keys unless `fresh`. */
export async function relaySetup(env: Env, protector: () => Protector, url: string, fresh = false): Promise<RelayConfig> {
  const ws = relayWsUrl(url);
  const old = loadRelay(env);
  const have = secretNames(env);
  if (old && !fresh && have.includes(KEY_SECRET) && have.includes(ROOM_SECRET)) {
    const c = { ...old, url: ws };
    saveRelay(env, c);
    return c;
  }
  const p = protector();
  const pair = await ecdhKeyPair(true);
  const raw = await publicRaw(pair);
  setSecret(env, p, KEY_SECRET, JSON.stringify(await exportPrivateJwk(pair.privateKey)));
  setSecret(env, p, ROOM_SECRET, b64u(randomBytes(32)));
  const c: RelayConfig = { version: 1, url: ws, room: b64u(randomBytes(16)), pcKey: b64u(raw), devices: [] };
  saveRelay(env, c);
  return c;
}

/** A pairing invite: the link for the QR code (one use, 10 minutes). */
export function relayInvite(env: Env, protector: () => Protector, now = Date.now()): { link: string; expiresAt: number } {
  const c = loadRelay(env);
  if (!c) throw new MagnusError('NO_RELAY', 'the relay is not set up', 'Run: magnus relay setup <relay address>');
  const pairId = b64u(randomBytes(8));
  const secret = b64u(randomBytes(32));
  const expiresAt = now + PAIR_MINUTES * 60_000;
  setSecret(env, protector(), PAIR_SECRET, JSON.stringify({ pairId, secret, expiresAt }));
  return { link: `${relayAppUrl(c.url)}#p=${inviteToFragment({ room: c.room, pcKey: c.pcKey, pairId, secret })}`, expiresAt };
}

export function removeRelayDevice(env: Env, id: string): RelayDevice | null {
  const c = loadRelay(env);
  if (!c) return null;
  const d = c.devices.find((x) => x.id === id) ?? null;
  c.devices = c.devices.filter((x) => x.id !== id);
  saveRelay(env, c);
  return d;
}

/** Messages the phone sends in the clear (pairing and hello carry only public values and MACs). */
type PhoneMsg =
  | { t: 'pair'; pairId: string; phoneKey: string; name: string; mac: string }
  | { t: 'hello'; deviceId: string; nonce: string }
  | ({ t: 'msg' } & Sealed);

interface Session {
  device?: RelayDevice;
  channel?: Channel;
}

export interface RelayPcDeps {
  protector: () => Protector;
  rpc: Omit<RpcDeps, 'setApprover'>;
  log: (line: string) => void;
  /** WebSocket class (Node's global by default). */
  WebSocket?: typeof WebSocket;
  now?: () => number;
}

/** The PC's connection to the relay: answers paired phones, reconnects after a drop. */
export class RelayPc {
  private ws: WebSocket | null = null;
  private stopped = false;
  private readonly sessions = new Map<string, Session>();
  private key: CryptoKey | null = null;
  private retry = 1000;
  /** The task running now (one at a time), so a phone can stop it (ADR 0012). */
  private task: AbortController | null = null;
  /**
   * The running (or last finished) task, so a phone that lost its connection, reloaded or came
   * back later can follow it: its steps so far, then the live ones and the answer (ADR 0017).
   */
  private current: {
    task: string;
    chat: string | null;
    started: number;
    steps: unknown[];
    done?: { result?: unknown; error?: string };
    watchers: Set<(m: { progress?: unknown; done?: { result?: unknown; error?: string } }) => void>;
  } | null = null;

  constructor(
    private readonly env: Env,
    private readonly deps: RelayPcDeps,
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Connects and keeps connecting until `stop()`. Resolves once authenticated the first time. */
  async start(): Promise<void> {
    const c = loadRelay(this.env);
    if (!c) throw new MagnusError('NO_RELAY', 'the relay is not set up', 'Run: magnus relay setup <relay address>');
    const s = readSecrets(this.env, this.deps.protector(), [KEY_SECRET, ROOM_SECRET]);
    this.key = await importPrivateJwk(JSON.parse(s.get(KEY_SECRET) ?? '{}') as JsonWebKey);
    const roomSecret = s.get(ROOM_SECRET) ?? '';
    await new Promise<void>((resolve, reject) => {
      let first = true;
      const connect = (): void => {
        if (this.stopped) return;
        const WS = this.deps.WebSocket ?? WebSocket;
        const ws = new WS(`${c.url}?role=pc&room=${c.room}`);
        this.ws = ws;
        ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'auth', secret: roomSecret })));
        // Our own heartbeat (ADR 0017): no answer for 75 s means the line is dead; reconnect.
        let heard = Date.now();
        ws.addEventListener('message', () => (heard = Date.now()));
        const beat = setInterval(() => {
          if (ws.readyState !== 1) return;
          if (Date.now() - heard > 75_000) {
            this.deps.log('no answer from the relay for 75 s; reconnecting');
            ws.close();
            return;
          }
          try {
            ws.send(JSON.stringify({ t: 'ping' }));
          } catch {
            // the close event follows
          }
        }, 20_000);
        ws.addEventListener('close', () => clearInterval(beat));
        ws.addEventListener('message', (e) => void this.onRelay(String(e.data), () => {
          this.retry = 1000;
          this.deps.log(`connected to the relay (${new URL(c.url).host})`);
          if (first) {
            first = false;
            resolve();
          }
        }));
        ws.addEventListener('close', (e) => {
          this.sessions.clear();
          if (this.stopped) return;
          if (e.code === 4001) {
            const err = new MagnusError('RELAY_REFUSED', 'the relay refused this PC (the room belongs to another secret)', 'Run "magnus relay setup <address> --new", or reset the relay');
            if (first) reject(err);
            else this.deps.log(err.message);
            return;
          }
          this.deps.log(`relay connection closed (${e.code}); retrying in ${Math.round(this.retry / 1000)} s`);
          setTimeout(connect, this.retry);
          this.retry = Math.min(this.retry * 2, 60_000);
        });
        ws.addEventListener('error', () => {
          /* the close event follows */
        });
      };
      connect();
    });
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private send(cid: string, msg: unknown): void {
    this.ws?.send(JSON.stringify({ t: 'to', cid, m: JSON.stringify(msg) }));
  }

  private async onRelay(text: string, authed: () => void): Promise<void> {
    let m: { t?: string; cid?: string; m?: string };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    if (m.t === 'ok') return authed();
    if (typeof m.cid !== 'string') return;
    if (m.t === 'open') this.sessions.set(m.cid, {});
    else if (m.t === 'close') this.sessions.delete(m.cid);
    else if (m.t === 'from' && typeof m.m === 'string') {
      let phone: PhoneMsg;
      try {
        phone = JSON.parse(m.m) as PhoneMsg;
      } catch {
        return;
      }
      await this.onPhone(m.cid, phone).catch((e: unknown) => this.deps.log(`phone message dropped: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  private async onPhone(cid: string, m: PhoneMsg): Promise<void> {
    const s = this.sessions.get(cid) ?? {};
    this.sessions.set(cid, s);
    if (m.t === 'pair') return this.pair(cid, m);
    if (m.t === 'hello') {
      const c = loadRelay(this.env);
      const device = c?.devices.find((d) => d.id === m.deviceId);
      if (!device || this.key === null) return this.send(cid, { t: 'unknown-device' });
      const pcNonce = randomBytes(16);
      s.channel = new Channel(await sessionKey(this.key, unb64u(device.phoneKey), unb64u(m.nonce), pcNonce));
      s.device = device;
      this.send(cid, { t: 'hello', nonce: b64u(pcNonce) });
      return;
    }
    if (m.t === 'msg' && s.channel && s.device) {
      const body = (await s.channel.open(m)) as { id?: unknown; method?: unknown; params?: unknown };
      const device = s.device;
      const channel = s.channel;
      const reply = async (out: Record<string, unknown>): Promise<void> => {
        const sealed = await channel.seal({ id: body.id, ...out });
        this.send(cid, { t: 'msg', ...sealed });
      };
      try {
        if (typeof body.method !== 'string') throw new MagnusError('BAD_ARGS', 'no method');
        const params = (typeof body.params === 'object' && body.params !== null ? body.params : {}) as Record<string, unknown>;
        if (body.method === 'ask.stop') {
          const running = this.task !== null;
          this.task?.abort();
          return await reply({ result: { stopped: running } });
        }
        if (body.method === 'ask.current') {
          const c = this.current;
          return await reply({
            result: c === null ? { running: false } : { running: c.done === undefined, task: c.task, chat: c.chat, started: c.started, steps: c.steps.length, finishedOk: c.done !== undefined && c.done.error === undefined },
          });
        }
        if (body.method === 'ask.follow') {
          const c = this.current;
          if (c === null) return await reply({ result: { running: false } });
          const push = (progress: unknown): void =>
            void channel.seal({ id: body.id, progress }).then((x) => this.send(cid, { t: 'msg', ...x })).catch(() => undefined);
          for (const st of c.steps) push(st);
          const finish = (d: { result?: unknown; error?: string }): Promise<void> => (d.error !== undefined ? reply({ error: d.error, hint: '' }) : reply({ result: d.result }));
          if (c.done !== undefined) return await finish(c.done);
          await new Promise<void>((resolve) => {
            const w = (m: { progress?: unknown; done?: { result?: unknown; error?: string } }): void => {
              if (m.progress !== undefined) push(m.progress);
              if (m.done !== undefined) {
                c.watchers.delete(w);
                void finish(m.done).finally(resolve);
              }
            };
            c.watchers.add(w);
          });
          return;
        }
        let run = {};
        if (body.method === 'ask') {
          if (this.task !== null) throw new MagnusError('BUSY', 'another task is still running; stop it or wait');
          const ctl = new AbortController();
          this.task = ctl;
          const cur = { task: typeof params['task'] === 'string' ? params['task'] : '', chat: typeof params['chat'] === 'string' ? params['chat'] : null, started: this.now(), steps: [] as unknown[], watchers: new Set<(m: { progress?: unknown; done?: { result?: unknown; error?: string } }) => void>() };
          this.current = cur;
          run = {
            signal: ctl.signal,
            // Each step goes to the phone as it happens, encrypted like everything else; it is
            // also kept, so a phone that reconnects can catch up (ADR 0017).
            onProgress: (progress: unknown) => {
              if (cur.steps.length < 300) cur.steps.push(progress);
              for (const w of [...cur.watchers]) w({ progress });
              void channel
                .seal({ id: body.id, progress })
                .then((s) => this.send(cid, { t: 'msg', ...s }))
                .catch(() => undefined); // that phone may be gone; the steps are kept for it
            },
          };
        }
        const result = await rpc(body.method, params, device, {
          ...this.deps.rpc,
          setApprover: (id, approverId) => {
            const c = loadRelay(this.env);
            const d = c?.devices.find((x) => x.id === id);
            if (c && d) {
              d.approverId = approverId;
              saveRelay(this.env, c);
            }
          },
        }, run).then(
          (r) => {
            if (body.method === 'ask') this.finishCurrent({ result: r });
            return r;
          },
          (e: unknown) => {
            if (body.method === 'ask') this.finishCurrent({ error: e instanceof Error ? e.message : String(e) });
            throw e;
          },
        ).finally(() => {
          if (body.method === 'ask') this.task = null;
        });
        await reply({ result });
      } catch (e) {
        await reply({ error: e instanceof Error ? e.message : String(e), hint: e instanceof MagnusError ? e.hint : '' });
      }
    }
  }

  /** Records the task's answer and hands it to every phone following it. */
  private finishCurrent(done: { result?: unknown; error?: string }): void {
    const c = this.current;
    if (c === null || c.done !== undefined) return;
    c.done = done;
    for (const w of [...c.watchers]) w({ done });
  }

  private async pair(cid: string, m: Extract<PhoneMsg, { t: 'pair' }>): Promise<void> {
    const fail = (reason: string): void => {
      this.deps.log(`pairing refused: ${reason}`);
      this.send(cid, { t: 'pair-failed', reason });
    };
    if (!secretNames(this.env).includes(PAIR_SECRET)) return fail('no pairing code is open on the PC');
    const p = JSON.parse(readSecrets(this.env, this.deps.protector(), [PAIR_SECRET]).get(PAIR_SECRET) ?? '{}') as { pairId: string; secret: string; expiresAt: number };
    if (this.now() > p.expiresAt) {
      removeSecret(this.env, PAIR_SECRET);
      return fail('the QR code has expired; make a new one on the PC');
    }
    const name = String(m.name ?? '').trim().slice(0, 40) || 'phone';
    const secret = unb64u(p.secret);
    if (m.pairId !== p.pairId || !sameMac(m.mac, await hmac(secret, pairText.phone(m.pairId, m.phoneKey, String(m.name ?? ''))))) {
      return fail('this pairing code does not match');
    }
    unb64u(m.phoneKey); // valid base64url, or this throws
    removeSecret(this.env, PAIR_SECRET); // one use
    const c = loadRelay(this.env);
    if (!c) return fail('the relay is not set up');
    const device: RelayDevice = { id: crypto.randomBytes(6).toString('hex'), name, phoneKey: m.phoneKey, created: new Date(this.now()).toISOString() };
    c.devices.push(device);
    saveRelay(this.env, c);
    this.deps.log(`paired "${name}"`);
    this.send(cid, { t: 'paired', deviceId: device.id, mac: await hmac(secret, pairText.pc(m.pairId, device.id, m.phoneKey)) });
  }
}
