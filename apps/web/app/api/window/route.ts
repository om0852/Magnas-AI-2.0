/** One window as the phone shows it: its text, and the controls that can be tapped or typed into. */
import { controlsFrom, MagnusError } from '@magnus/core';
import { api, xtraos } from '@/lib/guard';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const ref = new URL(request.url).searchParams.get('w') ?? '';
  return api('GET', 'any', async () => {
    if (!/^w\d+$/.test(ref)) throw new MagnusError('BAD_ARGS', 'w must be a window ref like w123');
    const call = xtraos();
    const [text, seen] = await Promise.all([
      call('read_text', { window: ref, last_lines: 60 }).catch((e: unknown) => ({ text: `(could not read the text: ${e instanceof Error ? e.message : String(e)})` })),
      call('observe', { window: ref, full: true, max_elements: 200 }),
    ]);
    const lines = typeof seen === 'string' ? seen : String((seen as { text?: unknown }).text ?? '');
    return { text: String((text as { text?: unknown }).text ?? ''), ...controlsFrom(lines) };
  });
}
