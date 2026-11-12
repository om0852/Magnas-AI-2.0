/** Paired devices for the remote web app (ADR 0009): ~/.magnus/devices.json. Only hashes of their keys are stored. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MagnusError, type Env } from '../types.js';

export interface Device {
  id: string;
  name: string;
  /** SHA-256 of the device's cookie token. */
  tokenHash: string;
  created: string;
  lastSeen: string;
  /** The XtraOS approver id, once the device's signing key was allowed on the PC (ADR 0076). */
  approverId?: string;
}

interface Store {
  version: 1;
  devices: Device[];
  pairing?: { codeHash: string; expiresAt: number; triesLeft: number };
}

export const DEVICE_PAIR_MINUTES = 10;
const TRIES = 5;
/** Letters and digits that cannot be confused when typed on a phone. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

function file(env: Env): string {
  return path.join(env.magnusHome, 'devices.json');
}

function load(env: Env): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file(env), 'utf8')) as Store;
    if (raw.version === 1 && Array.isArray(raw.devices)) return raw;
  } catch {
    // No devices yet.
  }
  return { version: 1, devices: [] };
}

function save(env: Env, s: Store): void {
  fs.mkdirSync(env.magnusHome, { recursive: true });
  fs.writeFileSync(file(env), JSON.stringify(s, null, 2) + '\n');
}

/** A new one-time code (8 characters, 10 minutes, 5 tries); only its hash is kept. */
export function startDevicePairing(env: Env, now = Date.now()): string {
  let code = '';
  for (const b of crypto.randomBytes(8)) code += ALPHABET[b % ALPHABET.length];
  const s = load(env);
  s.pairing = { codeHash: sha(code), expiresAt: now + DEVICE_PAIR_MINUTES * 60_000, triesLeft: TRIES };
  save(env, s);
  return code;
}

/** Turns a valid code into a new device; returns its id and the token for its cookie. */
export function claimDevice(env: Env, code: string, name: string, now = Date.now()): { id: string; token: string } {
  const s = load(env);
  const p = s.pairing;
  const clean = name.trim().slice(0, 40);
  if (clean === '') throw new MagnusError('BAD_ARGS', 'give this device a name');
  if (!p || now > p.expiresAt) {
    if (p) {
      delete s.pairing;
      save(env, s);
    }
    throw new MagnusError('NO_PAIRING', 'no valid pairing code', 'Make a new code on the PC: Magnus dashboard → Phones → Pair a device');
  }
  const a = Buffer.from(sha(code.trim().toUpperCase().replace(/[\s-]/g, '')), 'hex');
  const b = Buffer.from(p.codeHash, 'hex');
  if (!crypto.timingSafeEqual(a, b)) {
    p.triesLeft -= 1;
    if (p.triesLeft <= 0) delete s.pairing;
    save(env, s);
    throw new MagnusError('WRONG_CODE', p.triesLeft > 0 ? 'wrong code' : 'wrong code; no tries left, make a new one on the PC');
  }
  const id = crypto.randomBytes(6).toString('hex');
  const token = crypto.randomBytes(32).toString('base64url');
  const at = new Date(now).toISOString();
  s.devices.push({ id, name: clean, tokenHash: sha(token), created: at, lastSeen: at });
  delete s.pairing;
  save(env, s);
  return { id, token };
}

/** The device a cookie token belongs to (constant-time compare); updates "last seen" at most once a minute. */
export function deviceByToken(env: Env, token: string | null, now = Date.now()): Device | null {
  if (token === null || token === '') return null;
  const h = Buffer.from(sha(token), 'hex');
  const s = load(env);
  const d = s.devices.find((x) => {
    const k = Buffer.from(x.tokenHash, 'hex');
    return k.length === h.length && crypto.timingSafeEqual(k, h);
  });
  if (d && now - Date.parse(d.lastSeen) > 60_000) {
    d.lastSeen = new Date(now).toISOString();
    save(env, s);
  }
  return d ?? null;
}

export function listDevices(env: Env): Device[] {
  return load(env).devices;
}

export function setApprover(env: Env, id: string, approverId: string): void {
  const s = load(env);
  const d = s.devices.find((x) => x.id === id);
  if (!d) throw new MagnusError('NOT_FOUND', 'no such device');
  d.approverId = approverId;
  save(env, s);
}

/** Removes a device; returns it (so its XtraOS approver can be removed too), or null. */
export function removeDevice(env: Env, id: string): Device | null {
  const s = load(env);
  const d = s.devices.find((x) => x.id === id) ?? null;
  s.devices = s.devices.filter((x) => x.id !== id);
  save(env, s);
  return d;
}

/** The code both screens show for a signing key: like XtraOS's (ADR 0076), from the raw key. */
export function keyCode(rawKey: Buffer): string {
  const h = crypto.createHash('sha256').update(rawKey).digest('hex');
  return `${h.slice(0, 4).toUpperCase()}-${h.slice(4, 8).toUpperCase()}`;
}
