/** Who the phone remote obeys, and pairing (ADR 0008). Stored in ~/.magnus/remote.json. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../types.js';

export interface RemoteState {
  version: 1;
  owner?: { userId: number; chatId: number; name?: string; pairedAt: string };
  pairing?: { code: string; expiresAt: number; triesLeft: number };
}

export const PAIR_MINUTES = 10;
export const PAIR_TRIES = 5;
export const TOKEN_SECRET = 'TELEGRAM_BOT_TOKEN';

function file(env: Env): string {
  return path.join(env.magnusHome, 'remote.json');
}

export function loadRemote(env: Env): RemoteState {
  try {
    const raw = JSON.parse(fs.readFileSync(file(env), 'utf8')) as RemoteState;
    if (raw.version === 1) return raw;
  } catch {
    // Not paired yet.
  }
  return { version: 1 };
}

export function saveRemote(env: Env, s: RemoteState): void {
  fs.mkdirSync(env.magnusHome, { recursive: true });
  fs.writeFileSync(file(env), JSON.stringify(s, null, 2) + '\n');
}

/** A new 6-digit pairing code (replaces any old one). */
export function startPairing(env: Env, now = Date.now()): string {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const s = loadRemote(env);
  s.pairing = { code, expiresAt: now + PAIR_MINUTES * 60_000, triesLeft: PAIR_TRIES };
  saveRemote(env, s);
  return code;
}

export type PairResult = 'paired' | 'no-pairing' | 'expired' | 'wrong' | 'no-tries-left';

/** Checks a code sent from a private chat; on success the sender becomes the owner. */
export function tryPair(env: Env, code: string, who: { userId: number; chatId: number; name?: string }, now = Date.now()): PairResult {
  const s = loadRemote(env);
  const p = s.pairing;
  if (!p) return 'no-pairing';
  if (now > p.expiresAt) {
    delete s.pairing;
    saveRemote(env, s);
    return 'expired';
  }
  const a = Buffer.from(code.trim());
  const b = Buffer.from(p.code);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    p.triesLeft -= 1;
    if (p.triesLeft <= 0) delete s.pairing;
    saveRemote(env, s);
    return p.triesLeft <= 0 ? 'no-tries-left' : 'wrong';
  }
  s.owner = { userId: who.userId, chatId: who.chatId, ...(who.name !== undefined ? { name: who.name } : {}), pairedAt: new Date(now).toISOString() };
  delete s.pairing;
  saveRemote(env, s);
  return 'paired';
}

/** Forgets the owner; returns false when there was none. */
export function unpair(env: Env): boolean {
  const s = loadRemote(env);
  if (!s.owner) return false;
  delete s.owner;
  saveRemote(env, s);
  return true;
}
