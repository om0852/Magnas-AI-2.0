/**
 * Claude Code lifecycle hooks (ADR 0013): what Claude Code sends on stdin becomes task events,
 * and the hook entries `magnus sync` keeps in ~/.claude/settings.json.
 * Hook input (Claude Code 2.1, docs/hooks): session_id, cwd, hook_event_name, and
 *   UserPromptSubmit: prompt · Notification: message, title, notification_type ·
 *   Stop: last_assistant_message, stop_hook_active.
 */
import crypto from 'node:crypto';
import type { Env, ItemOp } from '../types.js';
import { appendEvent } from './tasks.js';

/** Notification types that mean "Claude is waiting for you". */
const WAITING = new Set(['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);

/** The task id for a Claude Code session (pure). */
export function claudeTaskId(sessionId: string): string {
  // Claude Code's ids are UUIDs. Anything else is hashed, so two odd ids never share a task.
  const plain = /^[A-Za-z0-9_-]{1,64}$/.test(sessionId);
  return `claude-code:${plain ? sessionId : crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`;
}

/** Records one hook call; returns what it did (for tests and the log). Never throws. */
export function handleClaudeHook(env: Env, input: unknown): string {
  const h = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const session = typeof h['session_id'] === 'string' ? h['session_id'] : '';
  if (session === '') return 'ignored: no session';
  const task = claudeTaskId(session);
  const cwd = typeof h['cwd'] === 'string' ? h['cwd'] : undefined;
  const base = { task, source: 'claude-code', ...(cwd !== undefined ? { cwd } : {}) };
  switch (h['hook_event_name']) {
    case 'UserPromptSubmit': {
      const prompt = typeof h['prompt'] === 'string' ? h['prompt'] : 'Claude Code';
      appendEvent(env, { ...base, kind: 'created', title: prompt });
      return 'created';
    }
    case 'Notification': {
      const type = typeof h['notification_type'] === 'string' ? h['notification_type'] : '';
      const message = typeof h['message'] === 'string' ? h['message'] : 'Claude Code needs you';
      if (WAITING.has(type) || type === '') {
        appendEvent(env, { ...base, kind: 'status', status: 'needs-you', text: message });
        return 'needs-you';
      }
      appendEvent(env, { ...base, kind: 'step', text: message });
      return 'step';
    }
    case 'Stop': {
      if (h['stop_hook_active'] === true) return 'ignored: continuing';
      const last = typeof h['last_assistant_message'] === 'string' ? h['last_assistant_message'] : 'Claude Code finished.';
      appendEvent(env, { ...base, kind: 'done', text: last });
      return 'done';
    }
    default:
      return 'ignored: other event';
  }
}

// ---- The hook entries in ~/.claude/settings.json --------------------------------------------

export const HOOK_EVENTS = ['UserPromptSubmit', 'Notification', 'Stop'] as const;

interface HookHandler {
  type: string;
  command?: string;
  args?: string[];
  async?: boolean;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookHandler[];
}

/** One of Magnus's hook handlers: `node cli.js event claude-code`, run in the background. */
function ours(h: HookHandler): boolean {
  return Array.isArray(h.args) && h.args.length >= 3 && h.args.at(-2) === 'event' && h.args.at(-1) === 'claude-code';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Plans Claude Code's settings.json: Magnus's three hooks present (`enabled`) or absent. Other
 * hooks and settings are kept as they are (pure).
 */
export function planClaudeHooks(current: string | null, node: string, cli: string, enabled: boolean): { text: string | null; op: ItemOp } {
  let root: Record<string, unknown> = {};
  if (current !== null && current.trim() !== '') {
    try {
      const v = JSON.parse(current) as unknown;
      if (!isRecord(v)) throw new Error('not an object');
      root = v;
    } catch {
      return { text: null, op: { name: 'settings.json', op: 'skip', detail: 'settings.json is not plain JSON: left untouched' } };
    }
  }
  const hooks = isRecord(root['hooks']) ? { ...root['hooks'] } : {};
  const want: HookHandler = { type: 'command', command: node, args: [cli, 'event', 'claude-code'], async: true, timeout: 30 };
  let changed = false;
  let had = 0;
  for (const event of HOOK_EVENTS) {
    const groups: HookGroup[] = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
    const mine = groups.filter((g) => (g.hooks ?? []).some(ours));
    if (mine.length > 0) had++;
    const same = mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify({ hooks: [want] });
    if (enabled && same) continue;
    const others = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((x) => !ours(x)) }))
      .filter((g) => g.hooks.length > 0);
    if (!enabled && mine.length === 0) continue;
    const next = enabled ? [...others, { hooks: [want] }] : others;
    if (next.length > 0) hooks[event] = next;
    else delete hooks[event];
    changed = true;
  }
  if (!changed) return { text: null, op: { name: 'settings.json', op: 'unchanged' } };
  if (Object.keys(hooks).length > 0) root['hooks'] = hooks;
  else delete root['hooks'];
  const op = !enabled ? 'remove' : had === 0 ? 'add' : 'update';
  return { text: JSON.stringify(root, null, 2) + '\n', op: { name: 'settings.json', op, detail: 'prompt, waiting and finish reported to Magnus' } };
}
