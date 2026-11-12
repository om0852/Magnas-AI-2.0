'use client';
/**
 * The device's own signing key (ADR 0076): ECDSA P-256 made by the browser, private key NOT
 * extractable, kept in IndexedDB on this device only. It signs answers to XtraOS dialogs.
 */

const DB = 'magnus';
const STORE = 'keys';
const KEY = 'approval';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function get(): Promise<CryptoKeyPair | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(STORE).objectStore(STORE).get(KEY);
    r.onsuccess = () => resolve(r.result as CryptoKeyPair | undefined);
    r.onerror = () => reject(r.error);
  });
}

async function put(pair: CryptoKeyPair): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(pair, KEY);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** True where the browser can make keys (https, or localhost). */
export function canSign(): boolean {
  return typeof crypto !== 'undefined' && crypto.subtle !== undefined && typeof indexedDB !== 'undefined';
}

/** The device's key pair, made on first use. */
export async function deviceKey(): Promise<CryptoKeyPair> {
  const have = await get();
  if (have) return have;
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  await put(pair);
  return pair;
}

const b64 = (b: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(b)));

/** The public key, raw (0x04 ‖ X ‖ Y), base64 — what XtraOS stores. */
export async function publicKeyB64(): Promise<string> {
  return b64(await crypto.subtle.exportKey('raw', (await deviceKey()).publicKey));
}

/** The code both screens show: first 8 hex characters of SHA-256 of the raw key. */
export async function keyCode(): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', (await deviceKey()).publicKey);
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`.toUpperCase();
}

/** A signed answer, exactly as XtraOS checks it (ADR 0076). */
export async function signAnswer(device: string, uid: string, button: number): Promise<{ issued_ms: number; signature: string }> {
  const issued_ms = Date.now();
  const text = `xtraos-approval-v1\n${device}\n${uid}\n${button}\n${issued_ms}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (await deviceKey()).privateKey, new TextEncoder().encode(text));
  return { issued_ms, signature: b64(sig) };
}
