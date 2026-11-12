/** Secrets: `${secret:NAME}` references and the encrypted store (~/.magnus/secrets.json). */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MagnusError, type Env, type McpServer } from './types.js';

const REF = /\$\{secret:([A-Za-z0-9_]+)\}/g;
const NAME = /^[A-Za-z0-9_]{1,64}$/;

/** Encrypts and decrypts for the current user. Injected, so tests need no Windows. */
export interface Protector {
  protect(plain: string): string;
  /** Decrypts several values in one go (one process start). */
  unprotect(blobs: readonly string[]): string[];
}

export function validSecretName(name: string): boolean {
  return NAME.test(name);
}

/** The secret names a server refers to, in `env` values and `args`. */
export function secretRefs(s: McpServer): string[] {
  const out = new Set<string>();
  for (const text of [...s.args, ...Object.values(s.env)]) {
    for (const m of text.matchAll(REF)) out.add(m[1] as string);
  }
  return [...out].sort();
}

/** The server with every reference replaced by its value. */
export function resolveServer(s: McpServer, values: ReadonlyMap<string, string>): McpServer {
  const fill = (text: string): string => text.replace(REF, (_, name: string) => values.get(name) ?? '');
  return {
    command: s.command,
    args: s.args.map(fill),
    env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, fill(v)])),
  };
}

function storeFile(env: Env): string {
  return path.join(env.magnusHome, 'secrets.json');
}

function loadStore(env: Env): Record<string, string> {
  if (!fs.existsSync(storeFile(env))) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(env), 'utf8')) as { secrets?: Record<string, string> };
    return typeof raw.secrets === 'object' && raw.secrets !== null ? raw.secrets : {};
  } catch {
    throw new MagnusError('BAD_SECRETS', `${storeFile(env)} is damaged`, 'Delete it and set the secrets again.');
  }
}

function saveStore(env: Env, secrets: Record<string, string>): void {
  fs.mkdirSync(env.magnusHome, { recursive: true });
  fs.writeFileSync(storeFile(env), JSON.stringify({ version: 1, secrets }, null, 2) + '\n');
}

/** The names in the store (never the values). */
export function secretNames(env: Env): string[] {
  return Object.keys(loadStore(env)).sort();
}

export function setSecret(env: Env, protector: Protector, name: string, value: string): void {
  if (!validSecretName(name)) throw new MagnusError('BAD_ARGS', `secret name "${name}": use letters, digits and _ (1-64)`);
  if (value === '') throw new MagnusError('BAD_ARGS', 'the secret value is empty');
  const store = loadStore(env);
  store[name] = protector.protect(value);
  saveStore(env, store);
}

/** Returns false when there was no such secret. */
export function removeSecret(env: Env, name: string): boolean {
  const store = loadStore(env);
  if (!Object.hasOwn(store, name)) return false;
  delete store[name];
  saveStore(env, store);
  return true;
}

/** The decrypted values of `names`; a missing one is an error naming it (not its value). */
export function readSecrets(env: Env, protector: Protector, names: readonly string[]): Map<string, string> {
  const store = loadStore(env);
  const missing = names.filter((n) => !Object.hasOwn(store, n));
  if (missing.length > 0) {
    throw new MagnusError('NO_SECRET', `secret not set: ${missing.join(', ')}`, `Run: magnus secret set ${missing[0] ?? ''}`);
  }
  const plain = protector.unprotect(names.map((n) => store[n] as string));
  return new Map(names.map((n, i) => [n, plain[i] ?? '']));
}

// --- Windows DPAPI through PowerShell. Values travel on stdin as base64, never on a command line.

const PS_PROTECT = `Add-Type -AssemblyName System.Security
foreach ($l in ([Console]::In.ReadToEnd() -split "\`n")) { $l = $l.Trim(); if ($l) {
  [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($l), $null, 'CurrentUser')) } }`;
const PS_UNPROTECT = PS_PROTECT.replace('::Protect(', '::Unprotect(');

function powershell(script: string, lines: readonly string[]): string[] {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: lines.join('\n') + '\n', encoding: 'utf8', windowsHide: true },
  );
  const out = (r.stdout ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (r.status !== 0 || out.length !== lines.length) {
    throw new MagnusError('DPAPI', 'Windows could not encrypt or decrypt the secret for this user', 'Secrets set on another account or PC must be set again.');
  }
  return out;
}

/** The real protector: DPAPI for the current Windows user. */
export function dpapiProtector(): Protector {
  if (process.platform !== 'win32') {
    throw new MagnusError('UNSUPPORTED', 'secrets need Windows for now (DPAPI)');
  }
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
  return {
    protect: (plain) => powershell(PS_PROTECT, [b64(plain)])[0] as string,
    unprotect: (blobs) =>
      blobs.length === 0 ? [] : powershell(PS_UNPROTECT, blobs).map((l) => Buffer.from(l, 'base64').toString('utf8')),
  };
}
