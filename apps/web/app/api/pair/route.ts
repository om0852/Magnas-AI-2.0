/** A device pairs with the one-time code made on the PC, and gets its own cookie (ADR 0009). */
import { claimDevice, MagnusError } from '@magnus/core';
import { cookies } from 'next/headers';
import { access, DEVICE_COOKIE, env } from '@/lib/guard';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const a = await access('POST');
  // Allowed: a remote host without a device yet (401). Never another host or Origin.
  if (!a.ok && !(a.remote && a.status === 401)) return Response.json({ error: a.message }, { status: a.status });
  if (a.ok && a.who === 'local') return Response.json({ error: 'pair from the phone, not from this PC' }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { code?: unknown; name?: unknown } | null;
  try {
    if (typeof body?.code !== 'string' || typeof body.name !== 'string') throw new MagnusError('BAD_ARGS', 'code and device name are required');
    const { token } = claimDevice(env(), body.code, body.name);
    const secure = new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
    (await cookies()).set(DEVICE_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: 180 * 24 * 3600 });
    return Response.json({ paired: true });
  } catch (e) {
    if (e instanceof MagnusError) return Response.json({ error: e.message, hint: e.hint }, { status: 400 });
    throw e;
  }
}
