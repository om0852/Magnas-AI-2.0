/**
 * Tap a control or type into a window, straight through XtraOS (no AI in between). XtraOS's own
 * rules apply: a send, a delete or a settings change opens an approval, which the phone sees.
 */
import { MagnusError } from '@magnus/core';
import { api, xtraos } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  const b = (await request.json().catch(() => null)) as { op?: unknown; window?: unknown; ref?: unknown; text?: unknown; submit?: unknown } | null;
  return api('POST', 'any', async () => {
    const window = typeof b?.window === 'string' && /^w\d+$/.test(b.window) ? b.window : null;
    const ref = typeof b?.ref === 'string' && /^e\d+$/.test(b.ref) ? b.ref : undefined;
    if (window === null) throw new MagnusError('BAD_ARGS', 'window ref is required');
    // Long enough for an XtraOS approval (60 s) answered on the phone.
    const call = xtraos();
    if (b?.op === 'click') {
      if (ref === undefined) throw new MagnusError('BAD_ARGS', 'ref of the control is required');
      return call('click', { window, ref }, 90_000);
    }
    if (b?.op === 'type') {
      if (typeof b.text !== 'string' || b.text === '' || b.text.length > 4000) throw new MagnusError('BAD_ARGS', 'text is 1-4000 characters');
      return call('type', { window, ...(ref !== undefined ? { ref } : {}), text: b.text, submit: b.submit === true }, 90_000);
    }
    throw new MagnusError('BAD_ARGS', 'op is click or type');
  });
}
