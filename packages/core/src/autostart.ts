/**
 * Start at sign-in (ADR 0011): Magnus's relay connection and XtraOS, through the user's own
 * startup list (HKCU\...\Run). No admin rights; `magnus autostart off` removes both.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Env } from './types.js';

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RELAY_VALUE = 'MagnusRelay';
export const XTRAOS_VALUE = 'XtraOSCore';

/** Reads and writes the startup list. Injected so tests never touch the real registry. */
export interface RunList {
  get(name: string): string | null;
  set(name: string, command: string): void;
  remove(name: string): void;
}

export function regRunList(): RunList {
  const reg = (args: string[]): { ok: boolean; out: string } => {
    const r = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
    return { ok: r.status === 0, out: r.stdout ?? '' };
  };
  return {
    get: (name) => {
      const r = reg(['query', RUN_KEY, '/v', name]);
      if (!r.ok) return null;
      const m = new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`).exec(r.out);
      return m ? (m[1] as string).trim() : null;
    },
    set: (name, command) => {
      if (!reg(['add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', command, '/f']).ok) throw new Error(`could not write the startup entry ${name}`);
    },
    remove: (name) => void reg(['delete', RUN_KEY, '/v', name, '/f']),
  };
}

/** A PowerShell single-quoted string. */
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * The startup command for the relay connection (pure). PowerShell keeps a hidden console, so
 * Node runs with no window; the output goes to a log file.
 */
export function relayStartCommand(node: string, cli: string, logFile: string): string {
  const inner = `& ${psq(node)} ${psq(cli)} relay run --log ${psq(logFile)}`;
  return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "${inner.replace(/"/g, '\\"')}"`;
}

export function relayLogFile(env: Env): string {
  return path.join(env.magnusHome, 'logs', 'relay.log');
}

// ---- One relay connection at a time --------------------------------------------------------

function lockFile(env: Env): string {
  return path.join(env.magnusHome, 'relay.lock');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid of a running relay connection, or null. */
export function runningRelay(env: Env): number | null {
  try {
    const pid = Number(fs.readFileSync(lockFile(env), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Takes the lock for this process; false when another relay connection is running. */
export function takeRelayLock(env: Env): boolean {
  if (runningRelay(env) !== null) return false;
  fs.mkdirSync(env.magnusHome, { recursive: true });
  fs.writeFileSync(lockFile(env), String(process.pid));
  const release = (): void => {
    try {
      if (fs.readFileSync(lockFile(env), 'utf8').trim() === String(process.pid)) fs.rmSync(lockFile(env));
    } catch {
      // already gone
    }
  };
  process.once('exit', release);
  return true;
}

/** A line logger to a file, kept under 1 MB (the old half is dropped). */
export function fileLog(file: string): (line: string) => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (line) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
        const keep = fs.readFileSync(file, 'utf8').slice(-512 * 1024);
        fs.writeFileSync(file, keep.slice(keep.indexOf('\n') + 1));
      }
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // logging must never stop the relay
    }
  };
}

export interface AutostartState {
  relay: string | null;
  xtraos: string | null;
}

export function autostartStatus(list: RunList): AutostartState {
  return { relay: list.get(RELAY_VALUE), xtraos: list.get(XTRAOS_VALUE) };
}

/** Turns both entries on. `xtraosCore`: its exe, or null when XtraOS is not installed. */
export function autostartOn(list: RunList, relayCommand: string, xtraosCore: string | null): AutostartState {
  list.set(RELAY_VALUE, relayCommand);
  if (xtraosCore !== null) list.set(XTRAOS_VALUE, `"${xtraosCore}"`);
  return autostartStatus(list);
}

export function autostartOff(list: RunList): AutostartState {
  list.remove(RELAY_VALUE);
  list.remove(XTRAOS_VALUE);
  return autostartStatus(list);
}
