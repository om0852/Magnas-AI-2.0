/** Server only: who may talk to Magnus, from this PC or from a paired device (ADR 0006, 0009). */
import {
  checkAccess,
  depsWithCli,
  deviceByToken,
  envFromProcess,
  MagnusError,
  xtraosCaller,
  type Access,
  type Env,
  type SyncDeps,
  type XtraosCall,
} from '@magnus/core';
import { cookies, headers } from 'next/headers';

export const PORT = Number(process.env.MAGNUS_DASH_PORT ?? 4747);
export const TOKEN = process.env.MAGNUS_DASH_TOKEN ?? '';
/** Hosts the app is reached by from other devices, e.g. "mypc.tail1234.ts.net". */
export const REMOTE_HOSTS = (process.env.MAGNUS_REMOTE_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter((h) => h !== '');
export const COOKIE = 'magnus_dash';
export const DEVICE_COOKIE = 'magnus_device';

export function env(): Env {
  return envFromProcess();
}

let caller: XtraosCall | undefined;
/** The XtraOS core, through its command line bridge. */
export function xtraos(): XtraosCall {
  return (caller ??= xtraosCaller());
}

/**
 * What sync needs. The path of the `magnus` command comes from the start script: this app is
 * bundled, so the core cannot locate itself here, and a wrong path would go into tool configs.
 */
export function syncDeps(e: Env): SyncDeps {
  const cli = process.env.MAGNUS_CLI;
  if (cli === undefined || cli === '') throw new MagnusError('NO_CLI', 'the dashboard was not started by its start script', 'Run: npm run dashboard');
  return depsWithCli(e, cli, true);
}

/** Who the current request comes from. `runToken` overrides the cookie (the enter link). */
export async function access(method: string, runToken?: string | null): Promise<Access> {
  const h = await headers();
  const c = await cookies();
  const e = env();
  return checkAccess(
    {
      method,
      host: h.get('host'),
      origin: h.get('origin'),
      runToken: runToken !== undefined ? runToken : (c.get(COOKIE)?.value ?? null),
      deviceToken: c.get(DEVICE_COOKIE)?.value ?? null,
    },
    { port: PORT, runToken: TOKEN, remoteHosts: REMOTE_HOSTS, device: (t) => deviceByToken(e, t)?.id ?? null },
  );
}

/** For the local dashboard page: null when the request may see it. */
export async function refusal(method: string, token?: string | null): Promise<{ status: number; message: string } | null> {
  const a = await access(method, token);
  if (!a.ok) return a;
  return a.who === 'local' ? null : { status: 403, message: 'the PC dashboard is for this PC; phones use /m' };
}

export type Allowed = 'local' | 'any';
export type Who = Extract<Access, { ok: true }>;

/** A JSON answer for an API route: the result, or the error in words the user can act on. */
export async function api<T>(method: string, allowed: Allowed, work: (who: Who) => T | Promise<T>): Promise<Response> {
  const a = await access(method);
  if (!a.ok) return Response.json({ error: a.message }, { status: a.status });
  if (allowed === 'local' && a.who !== 'local') return Response.json({ error: 'only from the PC dashboard' }, { status: 403 });
  try {
    return Response.json(await work(a));
  } catch (e) {
    if (e instanceof MagnusError) return Response.json({ error: e.message, hint: e.hint, code: e.code }, { status: 400 });
    throw e;
  }
}
