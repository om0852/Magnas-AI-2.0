/**
 * End-to-end encryption between the phone and the PC through the relay (ADR 0010).
 * Runs in Node and in the browser: WebCrypto only, no Node imports.
 *   session key = HKDF-SHA-256(ECDH-P256(own private, peer public), salt = phone nonce ‖ PC nonce, info "magnus-e2e-v1")
 *   message     = AES-256-GCM(random 12-byte IV, JSON {seq, body}); seq must grow.
 */

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
export const PROTOCOL = 'magnus-e2e-v1';

export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** An ECDH key pair; `extractable` only for the PC, which keeps its private key in the secret store. */
export async function ecdhKeyPair(extractable: boolean): Promise<CryptoKeyPair> {
  return (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, extractable, ['deriveBits'])) as CryptoKeyPair;
}

/** The raw public key (65 bytes, 0x04 ‖ X ‖ Y). */
export async function publicRaw(pair: CryptoKeyPair): Promise<Uint8Array> {
  return new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
}

export async function importPublic(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('not a raw P-256 public key');
  return subtle().importKey('raw', raw as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

/** The PC's private key as JWK (stored encrypted) and back. */
export async function exportPrivateJwk(key: CryptoKey): Promise<JsonWebKey> {
  return subtle().exportKey('jwk', key);
}
export async function importPrivateJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

/** The AES key for one session. Both sides pass the nonces in the same order: phone, then PC. */
export async function sessionKey(own: CryptoKey, peerRaw: Uint8Array, phoneNonce: Uint8Array, pcNonce: Uint8Array): Promise<CryptoKey> {
  const shared = await subtle().deriveBits({ name: 'ECDH', public: await importPublic(peerRaw) }, own, 256);
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const salt = new Uint8Array([...phoneNonce, ...pcNonce]);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(PROTOCOL) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** HMAC-SHA-256 with the pairing secret, base64url. */
export async function hmac(secret: Uint8Array, text: string): Promise<string> {
  const k = await subtle().importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(new Uint8Array(await subtle().sign('HMAC', k, enc.encode(text))));
}

/** Constant-time compare of two base64url strings. */
export function sameMac(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The text each side MACs during pairing (both sides build it the same way). */
export const pairText = {
  phone: (pairId: string, phoneKey: string, name: string): string => `${PROTOCOL}|pair-phone|${pairId}|${phoneKey}|${name}`,
  pc: (pairId: string, deviceId: string, phoneKey: string): string => `${PROTOCOL}|pair-pc|${pairId}|${deviceId}|${phoneKey}`,
};

/** What a QR code carries (after `#p=` in the link; never sent to a server). */
export interface PairInvite {
  room: string;
  pcKey: string;
  pairId: string;
  secret: string;
}

export function inviteToFragment(i: PairInvite): string {
  return b64u(enc.encode(JSON.stringify(i)));
}

export function inviteFromFragment(f: string): PairInvite {
  const v = JSON.parse(dec.decode(unb64u(f))) as Partial<PairInvite>;
  if (typeof v.room !== 'string' || typeof v.pcKey !== 'string' || typeof v.pairId !== 'string' || typeof v.secret !== 'string') {
    throw new Error('not a Magnus pairing link');
  }
  return { room: v.room, pcKey: v.pcKey, pairId: v.pairId, secret: v.secret };
}

export interface Sealed {
  iv: string;
  ct: string;
}

/** One encrypted session: sealing numbers messages; opening refuses old or repeated numbers. */
export class Channel {
  private sendSeq = 0;
  private recvSeq = 0;
  // Sealing and opening each run one at a time, so numbers leave and arrive in order even when
  // several answers are sealed at once (e.g. a slow task and a quick list).
  private sealing: Promise<unknown> = Promise.resolve();
  private opening: Promise<unknown> = Promise.resolve();

  constructor(private readonly key: CryptoKey) {}

  /** Seals a message; the caller sends it as soon as this resolves (results resolve in call order). */
  seal(body: unknown): Promise<Sealed> {
    const next = this.sealing.then(async () => {
      const iv = randomBytes(12);
      const plain = enc.encode(JSON.stringify({ seq: ++this.sendSeq, body }));
      const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, this.key, plain));
      return { iv: b64u(iv), ct: b64u(ct) };
    });
    this.sealing = next.catch(() => {});
    return next;
  }

  /** Throws on tampering, a wrong key, or a replayed / out-of-order message. */
  open(m: Sealed): Promise<unknown> {
    const next = this.opening.then(async () => {
      const plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64u(m.iv) as BufferSource }, this.key, unb64u(m.ct) as BufferSource);
      const { seq, body } = JSON.parse(dec.decode(plain)) as { seq: number; body: unknown };
      if (!Number.isInteger(seq) || seq <= this.recvSeq) throw new Error('replayed or out-of-order message');
      this.recvSeq = seq;
      return body;
    });
    this.opening = next.catch(() => {});
    return next;
  }
}
