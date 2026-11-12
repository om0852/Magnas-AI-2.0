/** Applies the sync plan: the same as `magnus sync --apply`. */
import { sync } from '@magnus/core';
import { api, env, syncDeps } from '@/lib/guard';

export const dynamic = 'force-dynamic';

export function POST(): Promise<Response> {
  return api('POST', () => {
    const e = env();
    const res = sync(e, { apply: true, force: false }, syncDeps(e));
    return { actions: res.actions, written: res.written.length };
  });
}
