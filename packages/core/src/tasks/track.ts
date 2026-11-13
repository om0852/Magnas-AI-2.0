/** Magnus's own tasks (the brain) in the task log, with their live steps (ADR 0013). */
import { ask, type AskResult, type BrainConfig, type BrainSet } from '../brain/ask.js';
import type { Progress } from '../brain/progress.js';
import type { RunOptions } from '../brain/runners.js';
import type { Env } from '../types.js';
import { scrubSecrets } from './scrub.js';
import { appendEvent, startTask } from './tasks.js';

/** The note that lets the brain ask the owner through Magnus (pure). */
export function taskNote(id: string, token: string): string {
  return `\n\n(Magnus task ${id}, token ${token}. If you cannot go on without the user, use magnus__ask_user with this task_id and token; do not ask in your final answer.)`;
}

/** Runs `ask` as a logged task: created, steps (tools and messages), then done / failed / stopped. */
export async function trackedAsk(env: Env, task: string, cfg: BrainConfig, brains: BrainSet, source: string, opts: RunOptions = {}, title?: string): Promise<AskResult & { taskId: string }> {
  // `title`: what the task list shows (a chat message), when `task` carries more (ADR 0015).
  const t = startTask(env, title ?? task, source);
  const onProgress = (raw: Progress): void => {
    // Masked here, once, for every brain: model thoughts and tool text may contain secrets.
    const p: Progress = { ...raw, text: scrubSecrets(raw.text) };
    if (p.kind === 'tool' || p.kind === 'tool-failed' || p.kind === 'say') appendEvent(env, { task: t.id, kind: 'step', source: 'magnus', text: p.text });
    opts.onProgress?.(p);
  };
  try {
    const res = await ask(task + taskNote(t.id, t.token), cfg, brains, { ...opts, onProgress });
    const kind = res.ok ? 'done' : res.stoppedBecause === 'you pressed Stop' ? 'stopped' : 'failed';
    appendEvent(env, { task: t.id, kind, source: 'magnus', text: res.answer });
    return { ...res, taskId: t.id };
  } catch (e) {
    appendEvent(env, { task: t.id, kind: 'failed', source: 'magnus', text: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
