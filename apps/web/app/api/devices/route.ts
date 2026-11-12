/** Paired devices, from the PC dashboard only: list, make a pairing code, remove (ADR 0009). */
import { DEVICE_PAIR_MINUTES, listDevices, MagnusError, removeDevice, startDevicePairing } from '@magnus/core';
import { api, env, REMOTE_HOSTS, xtraos } from '@/lib/guard';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return api('GET', 'local', () => ({
    remoteHosts: REMOTE_HOSTS,
    devices: listDevices(env()).map((d) => ({ id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen, approvals: d.approverId !== undefined })),
  }));
}

export function POST(): Promise<Response> {
  return api('POST', 'local', () => {
    if (REMOTE_HOSTS.length === 0) {
      throw new MagnusError('NO_REMOTE', 'remote access is off', 'Start Magnus with MAGNUS_REMOTE_HOSTS set to the address your phone uses (see docs/03, "The remote app").');
    }
    return { code: startDevicePairing(env()), minutes: DEVICE_PAIR_MINUTES, urls: REMOTE_HOSTS.map((h) => `${/^(localhost|127\.0\.0\.1)/.test(h) ? 'http' : 'https'}://${h}/pair`) };
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  return api('DELETE', 'local', async () => {
    const d = removeDevice(env(), id);
    if (!d) throw new MagnusError('NOT_FOUND', 'no such device');
    let approver = 'none';
    if (d.approverId !== undefined) {
      // The device must stop being able to answer XtraOS dialogs too.
      await xtraos()('approvers.remove', { id: d.approverId })
        .then(() => (approver = 'removed'))
        .catch((e: unknown) => (approver = `could not remove from XtraOS: ${e instanceof Error ? e.message : String(e)}`));
    }
    return { removed: d.name, approver };
  });
}
