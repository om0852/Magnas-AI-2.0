/**
 * A paired device registers its signing key with XtraOS (ADR 0076). XtraOS shows a dialog on the
 * PC with the key's code; only a real click there makes the device an approver.
 */
import { keyCode, listDevices, MagnusError, setApprover } from '@magnus/core';
import { api, env, xtraos } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 180;

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { publicKey?: unknown } | null;
  return api('POST', 'any', async (who) => {
    if (who.who !== 'device') throw new MagnusError('BAD_ARGS', 'only a paired device has a signing key');
    if (typeof body?.publicKey !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(body.publicKey)) throw new MagnusError('BAD_ARGS', 'publicKey (base64) is required');
    const device = listDevices(env()).find((d) => d.id === who.deviceId);
    const res = (await xtraos()('approvers.add', { name: device?.name ?? 'phone', public_key: body.publicKey }, 150_000)) as { id?: string; code?: string };
    if (typeof res.id !== 'string') throw new MagnusError('XTRAOS', 'XtraOS did not return an approver id');
    setApprover(env(), who.deviceId, res.id);
    return { approverId: res.id, code: keyCode(Buffer.from(body.publicKey, 'base64')) };
  });
}
