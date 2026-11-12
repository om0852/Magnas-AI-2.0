/**
 * Runs one task through the brain (ADR 0007), streaming each step as it happens and stoppable
 * (ADR 0012). The answer is newline-delimited JSON: {"progress": …} lines, then {"result": …}.
 * DELETE stops the task that is running. One task at a time.
 */
import { ask, brainConfig, logAsk, MagnusError, realBrains, type Progress } from '@magnus/core';
import { access, api, env, syncDeps } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;

let running: AbortController | null = null;

export async function POST(request: Request): Promise<Response> {
  const a = await access('POST');
  if (!a.ok) return Response.json({ error: a.message }, { status: a.status });
  const body = (await request.json().catch(() => null)) as { task?: unknown } | null;
  const task = typeof body?.task === 'string' ? body.task : '';
  if (task.trim() === '') return Response.json({ error: 'write a task first' }, { status: 400 });
  if (task.length > 4000) return Response.json({ error: 'the task is over 4,000 characters' }, { status: 400 });
  if (running) return Response.json({ error: 'another task is still running; stop it or wait for it to finish' }, { status: 409 });

  const ctl = new AbortController();
  running = ctl;
  // Closing the page or pressing Stop ends the brain too.
  request.signal.addEventListener('abort', () => ctl.abort(), { once: true });
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (v: unknown): void => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(v) + '\n'));
        } catch {
          // the reader went away
        }
      };
      try {
        const e = env();
        const cfg = brainConfig(e);
        const self = syncDeps(e).self;
        const res = await ask(task, cfg, realBrains(e, { command: self.command, args: self.args }, cfg.servers), {
          signal: ctl.signal,
          onProgress: (progress: Progress) => send({ progress }),
        });
        logAsk(e, task, res);
        send({
          result: {
            ok: res.ok,
            brain: res.brain,
            answer: res.answer,
            stoppedBecause: res.stoppedBecause ?? null,
            attempts: res.attempts.map((x) => ({
              brain: x.brain,
              outcome: x.outcome,
              seconds: x.run ? Math.round(x.run.ms / 100) / 10 : null,
              toolCalls: x.run?.callsKnown ? x.run.toolCalls.length : null,
            })),
          },
        });
      } catch (err) {
        send({ error: err instanceof Error ? err.message : String(err), hint: err instanceof MagnusError ? err.hint : '' });
      } finally {
        if (running === ctl) running = null;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Stops the running task. */
export function DELETE(): Promise<Response> {
  return api('DELETE', 'any', () => {
    const was = running !== null;
    running?.abort();
    return { stopped: was };
  });
}
