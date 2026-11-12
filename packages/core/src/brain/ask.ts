/** `magnus ask`: one task, the brains in order, fallback only when nothing was done yet (ADR 0007). */
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry } from '../registry.js';
import { MagnusError, type Env } from '../types.js';
import { brainPrompt, type BrainId } from './prompt.js';
import { agyRunner, codexRunner, findAgy, findCodex, type BrainRun, type BrainRunner, type Launcher } from './runners.js';

export interface BrainConfig {
  order: BrainId[];
  servers: string[];
  timeoutSec: number;
}

export const DEFAULT_BRAIN: BrainConfig = { order: ['codex', 'antigravity'], servers: ['xtraos'], timeoutSec: 300 };

export interface Attempt {
  brain: BrainId;
  /** not-installed | ok | failed */
  outcome: 'not-installed' | 'ok' | 'failed';
  run?: BrainRun;
}

export interface AskResult {
  ok: boolean;
  /** The brain whose answer this is (null when none could run). */
  brain: BrainId | null;
  answer: string;
  attempts: Attempt[];
  /** Why no further brain was tried after a failure, when that applies. */
  stoppedBecause?: string;
}

/** Brains Magnus can start, by id; a missing one is null. Injected in tests. */
export type BrainSet = Record<BrainId, BrainRunner | null>;

/** The brain settings from the registry, with defaults. */
export function brainConfig(env: Env): BrainConfig {
  const b = loadRegistry(env).brain;
  return { ...DEFAULT_BRAIN, ...(b ?? {}) };
}

/**
 * Runs the task. A brain that is not installed, or failed before calling any tool, hands over
 * to the next. A brain that called tools and failed (or whose calls cannot be seen) stops the
 * run: trying again could do an action twice.
 */
export async function ask(task: string, cfg: BrainConfig, brains: BrainSet): Promise<AskResult> {
  if (task.trim() === '') throw new MagnusError('BAD_ARGS', 'the task is empty');
  const attempts: Attempt[] = [];
  for (const id of cfg.order) {
    const runner = brains[id];
    if (!runner) {
      attempts.push({ brain: id, outcome: 'not-installed' });
      continue;
    }
    const view = id === 'codex' ? 'hub' : 'own';
    const run = await runner(brainPrompt(task, cfg.servers, view), cfg.timeoutSec * 1000);
    attempts.push({ brain: id, outcome: run.ok ? 'ok' : 'failed', run });
    if (run.ok) return { ok: true, brain: id, answer: run.answer, attempts };
    if (!run.callsKnown || run.toolCalls.length > 0) {
      return {
        ok: false,
        brain: id,
        answer: run.answer,
        attempts,
        stoppedBecause: run.callsKnown
          ? `it had already called ${run.toolCalls.length} tool(s); another brain could repeat an action`
          : 'it may already have acted; another brain could repeat an action',
      };
    }
  }
  const last = [...attempts].reverse().find((a) => a.run);
  return {
    ok: false,
    brain: last?.brain ?? null,
    answer: last?.run?.answer ?? 'No brain is installed: install Codex CLI or Antigravity CLI.',
    attempts,
  };
}

/** The real brains on this PC. `hub`: how to start `magnus hub` (node + cli.js). */
export function realBrains(env: Env, hub: Launcher, servers: readonly string[]): BrainSet {
  const codex = findCodex();
  const agy = findAgy();
  return {
    codex: codex ? codexRunner(codex, hub, servers, env) : null,
    antigravity: agy ? agyRunner(agy) : null,
  };
}

/** Appends one run to ~/.magnus/brain-log.jsonl (local only). */
export function logAsk(env: Env, task: string, res: AskResult): void {
  const line = {
    at: new Date().toISOString(),
    task,
    ok: res.ok,
    brain: res.brain,
    answer: res.answer.slice(0, 4000),
    attempts: res.attempts.map((a) => ({
      brain: a.brain,
      outcome: a.outcome,
      ...(a.run ? { ms: a.run.ms, toolCalls: a.run.toolCalls, timedOut: a.run.timedOut } : {}),
    })),
    ...(res.stoppedBecause !== undefined ? { stoppedBecause: res.stoppedBecause } : {}),
  };
  fs.mkdirSync(env.magnusHome, { recursive: true });
  fs.appendFileSync(path.join(env.magnusHome, 'brain-log.jsonl'), JSON.stringify(line) + '\n');
}
