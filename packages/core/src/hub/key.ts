/** The Magnus key for the HTTP way in: shown once, only its hash is stored (ADR 0005). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../types.js';

function file(env: Env): string {
  return path.join(env.magnusHome, 'hub.json');
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Makes a new key (replacing any old one) and returns it; it cannot be read back later. */
export function newKey(env: Env): string {
  const key = `mgn_${crypto.randomBytes(32).toString('base64url')}`;
  fs.mkdirSync(env.magnusHome, { recursive: true });
  fs.writeFileSync(file(env), JSON.stringify({ version: 1, keyHash: sha256(key), created: new Date().toISOString() }, null, 2) + '\n');
  return key;
}

/** The stored hash, or null when no key was made yet. */
export function keyHash(env: Env): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file(env), 'utf8')) as { keyHash?: unknown };
    return typeof raw.keyHash === 'string' && /^[0-9a-f]{64}$/.test(raw.keyHash) ? raw.keyHash : null;
  } catch {
    return null;
  }
}

/** True when `presented` is the key whose hash is `hash` (constant-time compare). */
export function keyMatches(hash: string, presented: string): boolean {
  const a = Buffer.from(sha256(presented), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
