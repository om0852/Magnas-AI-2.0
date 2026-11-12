/** The PC's open windows, through XtraOS. */
import { api, xtraos } from '@/lib/guard';

export const dynamic = 'force-dynamic';

interface Win {
  ref: string;
  title: string;
  process: string;
  state: string;
  focused: boolean;
}

export function GET(): Promise<Response> {
  return api('GET', 'any', async () => {
    const res = (await xtraos()('list_windows', {})) as { windows: Win[] };
    return { windows: res.windows.map((w) => ({ ref: w.ref, title: w.title, process: w.process, state: w.state, focused: w.focused })) };
  });
}
