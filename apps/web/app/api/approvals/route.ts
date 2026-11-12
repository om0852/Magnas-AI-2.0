/** XtraOS dialogs waiting for the owner; a paired device answers with a signed answer (ADR 0076). */
import { listDevices, MagnusError } from '@magnus/core';
import { api, env, xtraos } from '@/lib/guard';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return api('GET', 'any', async (who) => {
    const d = who.who === 'device' ? listDevices(env()).find((x) => x.id === who.deviceId) : undefined;
    const list = (await xtraos()('approvals.list', {}, 10_000)) as { dialogs: unknown[] };
    return { dialogs: list.dialogs, canAnswer: d?.approverId !== undefined, approverId: d?.approverId ?? null };
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  return api('POST', 'any', async (who) => {
    if (who.who !== 'device') throw new MagnusError('BAD_ARGS', 'answer on the PC screen');
    const d = listDevices(env()).find((x) => x.id === who.deviceId);
    if (d?.approverId === undefined) throw new MagnusError('NOT_APPROVER', 'this device may not answer yet', 'Allow its key on the PC first (Magnus app → Approvals → Allow this device).');
    const { uid, button, issued_ms, signature } = body ?? {};
    // XtraOS checks everything again, including the signature; Magnus only passes it on.
    return xtraos()('approvals.answer', { device: d.approverId, uid, button, issued_ms, signature }, 15_000);
  });
}
