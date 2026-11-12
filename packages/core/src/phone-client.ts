/**
 * The phone side of the relay (ADR 0010): pair with a QR invite, open an encrypted session, make
 * calls. Browser and Node (WebCrypto and WebSocket only, no Node imports).
 */
import { b64u, Channel, hmac, pairText, publicRaw, randomBytes, sameMac, sessionKey, unb64u, type PairInvite, type Sealed } from './e2e.js';

type Incoming = { t: string; [k: string]: unknown };

/** One WebSocket to the relay, with a queue of incoming messages. */
class Line {
  readonly ws: WebSocket;
  private readonly queue: Incoming[] = [];
  private readonly waiters: ((m: Incoming) => void)[] = [];
  onEvent: (m: Incoming) => void = () => {};
  readonly closed: Promise<number>;

  constructor(url: string, WS: typeof WebSocket) {
    this.ws = new WS(url);
    this.ws.addEventListener('message', (e) => {
      let m: Incoming;
      try {
        m = JSON.parse(String(e.data)) as Incoming;
      } catch {
        return;
      }
      this.onEvent(m);
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
    this.closed = new Promise((r) => this.ws.addEventListener('close', (e) => r(e.code)));
  }

  /** The next message whose type is one of `types` (others are skipped), or an error after `ms`. */
  async next(types: string[], ms: number): Promise<Incoming> {
    const deadline = Date.now() + ms;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(types.includes('online') ? 'the PC is offline (is "magnus relay run" running?)' : 'the PC did not answer in time');
      const m =
        this.queue.shift() ??
        (await Promise.race([
          new Promise<Incoming>((r) => this.waiters.push(r)),
          new Promise<Incoming>((r) => setTimeout(() => r({ t: '__timeout' }), left)),
          this.closed.then((code) => ({ t: '__closed', code }) as Incoming),
        ]));
      if (m.t === '__closed') throw new Error(`the relay closed the connection (${String(m['code'])})`);
      if (types.includes(m.t)) return m;
    }
  }

  send(v: unknown): void {
    this.ws.send(JSON.stringify(v));
  }

  async opened(): Promise<void> {
    if (this.ws.readyState === 1) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('could not reach the relay')));
    });
  }
}

export interface PhoneIdentity {
  /** The phone's ECDH key pair (private key not extractable in the browser). */
  keys: CryptoKeyPair;
  relayUrl: string;
  room: string;
  /** The PC's public key from the QR code, base64url. */
  pcKey: string;
  deviceId: string;
}

/** Pairs this phone using a QR invite. Returns the device id the PC gave it. */
export async function pairPhone(relayUrl: string, invite: PairInvite, keys: CryptoKeyPair, name: string, WS: typeof WebSocket = WebSocket): Promise<string> {
  const line = new Line(`${relayUrl}?role=phone&room=${invite.room}`, WS);
  try {
    await line.opened();
    await line.next(['online'], 15_000);
    const secret = unb64u(invite.secret);
    const phoneKey = b64u(await publicRaw(keys));
    line.send({ t: 'pair', pairId: invite.pairId, phoneKey, name, mac: await hmac(secret, pairText.phone(invite.pairId, phoneKey, name)) });
    const r = await line.next(['paired', 'pair-failed'], 20_000);
    if (r.t === 'pair-failed') throw new Error(String(r['reason'] ?? 'pairing failed'));
    const deviceId = String(r['deviceId']);
    // The answer must come from the PC in the QR code: only it knows the pairing secret.
    if (!sameMac(String(r['mac']), await hmac(secret, pairText.pc(invite.pairId, deviceId, phoneKey)))) {
      throw new Error('the answer did not come from your PC; pairing stopped');
    }
    return deviceId;
  } finally {
    line.ws.close();
  }
}

/** An encrypted session with the PC. */
export class PhoneSession {
  private channel: Channel | null = null;
  private line: Line | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Called when the PC goes offline or online, or the connection drops. */
  onStatus: (s: 'online' | 'offline' | 'closed') => void = () => {};

  constructor(
    private readonly id: PhoneIdentity,
    private readonly WS: typeof WebSocket = WebSocket,
  ) {}

  /** Connects, waits for the PC, and agrees the session key. */
  async open(): Promise<void> {
    const line = new Line(`${this.id.relayUrl}?role=phone&room=${this.id.room}`, this.WS);
    this.line = line;
    line.onEvent = (m) => {
      if (m.t === 'offline' || m.t === 'online') this.onStatus(m.t);
      if (m.t === 'msg') void this.receive(m as unknown as Sealed);
    };
    void line.closed.then(() => {
      for (const p of this.pending.values()) p.reject(new Error('connection lost'));
      this.pending.clear();
      this.onStatus('closed');
    });
    try {
      await line.opened();
      await line.next(['online'], 15_000);
      const nonce = randomBytes(16);
      line.send({ t: 'hello', deviceId: this.id.deviceId, nonce: b64u(nonce) });
      const r = await line.next(['hello', 'unknown-device'], 15_000);
      if (r.t === 'unknown-device') throw new Error('this phone is no longer paired with the PC');
      this.channel = new Channel(await sessionKey(this.id.keys.privateKey, unb64u(this.id.pcKey), nonce, unb64u(String(r['nonce']))));
    } catch (e) {
      line.ws.close(); // a failed attempt leaves nothing open
      throw e;
    }
  }

  private async receive(m: Sealed): Promise<void> {
    if (!this.channel) return;
    let body: { id?: number; result?: unknown; error?: string; hint?: string };
    try {
      body = (await this.channel.open(m)) as typeof body;
    } catch {
      return; // not from our PC, or replayed: ignored
    }
    const p = typeof body.id === 'number' ? this.pending.get(body.id) : undefined;
    if (!p) return;
    this.pending.delete(body.id as number);
    if (body.error !== undefined) p.reject(new Error([body.error, body.hint].filter(Boolean).join('. ')));
    else p.resolve(body.result);
  }

  /** One call to the PC (encrypted both ways). */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    if (!this.channel || !this.line) throw new Error('not connected');
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('the PC did not answer in time'));
      }, timeoutMs);
      const done = <A>(fn: (a: A) => void) => (a: A): void => {
        clearTimeout(timer);
        fn(a);
      };
      this.pending.set(id, { resolve: done(resolve as (v: unknown) => void), reject: done(reject) });
    });
    const sealed = await this.channel.seal({ id, method, params });
    this.line.send({ t: 'msg', ...sealed });
    return result;
  }

  close(): void {
    this.line?.ws.close();
  }
}
