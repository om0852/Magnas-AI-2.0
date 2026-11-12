/** Server only: who may talk to the dashboard (the rules live in the core, ADR 0006). */
import { checkDashboardRequest, depsWithCli, envFromProcess, MagnusError, type DashboardRefusal, type Env, type SyncDeps } from '@magnus/core';
import { cookies, headers } from 'next/headers';

export const PORT = Number(process.env.MAGNUS_DASH_PORT ?? 4747);
export const TOKEN = process.env.MAGNUS_DASH_TOKEN ?? '';
export const COOKIE = 'magnus_dash';

export function env(): Env {
  return envFromProcess();
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

/** Null when the current request may proceed. */
export async function refusal(method: string, token?: string | null): Promise<DashboardRefusal | null> {
  const h = await headers();
  const c = await cookies();
  return checkDashboardRequest(
    { method, host: h.get('host'), origin: h.get('origin'), token: token !== undefined ? token : (c.get(COOKIE)?.value ?? null) },
    PORT,
    TOKEN,
  );
}

/** A JSON answer for an API route: the result, or the error in words the user can act on. */
export async function api<T>(method: string, work: () => T | Promise<T>): Promise<Response> {
  const bad = await refusal(method);
  if (bad) return Response.json({ error: bad.message }, { status: bad.status });
  try {
    return Response.json(await work());
  } catch (e) {
    if (e instanceof MagnusError) return Response.json({ error: e.message, hint: e.hint }, { status: 400 });
    throw e;
  }
}
