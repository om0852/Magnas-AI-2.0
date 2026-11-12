/** Calls the XtraOS core through its command line bridge (`xtraos-core call <method> - --json`). */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MagnusError } from './types.js';

/** The installed XtraOS core, or `XTRAOS_CORE`. Null when XtraOS is not installed. */
export function findXtraosCore(vars: NodeJS.ProcessEnv = process.env): string | null {
  const own = vars['XTRAOS_CORE'];
  if (own !== undefined && own !== '') return fs.existsSync(own) ? own : null;
  const local = vars['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  const exe = path.join(local, 'Programs', 'XtraOS', 'bin', 'xtraos-core.exe');
  return fs.existsSync(exe) ? exe : null;
}

/** Splits the bridge's error text ("ERROR CODE: message\nhint: …") (pure). */
export function parseBridgeError(stderr: string): { code: string; message: string; hint: string } {
  const m = /ERROR ([A-Z_]+): ([^\n]*)/.exec(stderr);
  const hint = /hint: ([^\n]*)/.exec(stderr)?.[1] ?? '';
  return m ? { code: m[1] as string, message: m[2] as string, hint } : { code: 'XTRAOS', message: stderr.trim().slice(0, 300) || 'XtraOS did not answer', hint };
}

export type XtraosCall = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

/** A caller bound to an XtraOS core exe. */
export function xtraosCaller(exe: string | null = findXtraosCore()): XtraosCall {
  return (method, params, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      if (exe === null) {
        reject(new MagnusError('NO_XTRAOS', 'XtraOS Agent is not installed on this PC'));
        return;
      }
      const child = spawn(/* turbopackIgnore: true */ exe, ['call', method, '-', '--json'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new MagnusError('NO_XTRAOS', `could not start XtraOS: ${e.message}`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve(out.trim());
          }
        } else {
          const e = parseBridgeError(err);
          reject(new MagnusError(e.code, e.message, e.hint));
        }
      });
      child.stdin.end(JSON.stringify(params));
    });
}
