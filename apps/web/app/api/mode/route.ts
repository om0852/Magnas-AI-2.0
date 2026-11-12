/** Switches a tool between direct and hub mode; the next sync applies it. */
import { MagnusError, setClientMode } from '@magnus/core';
import { api, env } from '@/lib/guard';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { id?: unknown; mode?: unknown } | null;
  return api('POST', 'local', () => {
    if (typeof body?.id !== 'string' || (body.mode !== 'hub' && body.mode !== 'direct')) {
      throw new MagnusError('BAD_ARGS', 'expected { id, mode: "hub" | "direct" }');
    }
    setClientMode(env(), body.id, body.mode);
    return { ok: true };
  });
}
