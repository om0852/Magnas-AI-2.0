/** The relay from the PC dashboard (ADR 0010): status, a pairing QR code, remove a phone. */
import { dpapiProtector, loadRelay, MagnusError, relayAppUrl, relayInvite, removeRelayDevice } from '@magnus/core';
import QRCode from 'qrcode';
import { api, env, xtraos } from '@/lib/guard';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return api('GET', 'local', () => {
    const c = loadRelay(env());
    return c
      ? { configured: true, app: relayAppUrl(c.url), devices: c.devices.map((d) => ({ id: d.id, name: d.name, created: d.created, approvals: d.approverId !== undefined })) }
      : { configured: false };
  });
}

export function POST(): Promise<Response> {
  return api('POST', 'local', async () => {
    const { link, expiresAt } = relayInvite(env(), dpapiProtector);
    // The QR code holds the pairing secret: it is made here and shown only on this PC's screen.
    const svg = await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    return { link, expiresAt, svg };
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  return api('DELETE', 'local', async () => {
    const d = removeRelayDevice(env(), id);
    if (!d) throw new MagnusError('NOT_FOUND', 'no such phone');
    if (d.approverId !== undefined) await xtraos()('approvers.remove', { id: d.approverId }).catch(() => undefined);
    return { removed: d.name };
  });
}
