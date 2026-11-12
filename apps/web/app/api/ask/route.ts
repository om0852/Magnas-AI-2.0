/** Runs one task through the brain (ADR 0007): the same as `magnus ask`. One at a time. */
import { ask, brainConfig, logAsk, MagnusError, realBrains } from '@magnus/core';
import { api, env, syncDeps } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;

let running = false;

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { task?: unknown } | null;
  return api('POST', 'any', async () => {
    if (typeof body?.task !== 'string' || body.task.trim() === '') throw new MagnusError('BAD_ARGS', 'write a task first');
    if (body.task.length > 4000) throw new MagnusError('BAD_ARGS', 'the task is over 4,000 characters');
    if (running) throw new MagnusError('BUSY', 'another task is still running; wait for it to finish');
    running = true;
    try {
      const e = env();
      const cfg = brainConfig(e);
      const self = syncDeps(e).self;
      const res = await ask(body.task, cfg, realBrains(e, { command: self.command, args: self.args }, cfg.servers));
      logAsk(e, body.task, res);
      return {
        ok: res.ok,
        brain: res.brain,
        answer: res.answer,
        stoppedBecause: res.stoppedBecause ?? null,
        attempts: res.attempts.map((a) => ({
          brain: a.brain,
          outcome: a.outcome,
          seconds: a.run ? Math.round(a.run.ms / 100) / 10 : null,
          toolCalls: a.run?.callsKnown ? a.run.toolCalls.length : null,
        })),
      };
    } finally {
      running = false;
    }
  });
}
