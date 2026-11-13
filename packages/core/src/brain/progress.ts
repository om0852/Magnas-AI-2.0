/**
 * Live progress of a brain run (ADR 0012): the steps the AI CLI reports while it works, turned
 * into short lines the phone and the dashboard show. Pure parsers of each CLI's JSON lines.
 */
import { scrubSecrets } from '../tasks/scrub.js';

export type ProgressKind = 'thinking' | 'tool' | 'tool-done' | 'tool-failed' | 'say' | 'note';

export interface Progress {
  kind: ProgressKind;
  text: string;
  /** Milliseconds since the run started. */
  ms: number;
}

/** What one JSON line tells: a step to show, a tool call to count, the final answer. */
export interface Parsed {
  step?: Omit<Progress, 'ms'>;
  toolCall?: string;
  answer?: string;
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** Argument names whose values are never shown in a step (ADR 0016): task tokens, secrets. */
const HIDDEN_ARG = /^(token|password|passwd|secret|api_?key|access_?key|otp|code|pin)$/i;

export function args(v: unknown): string {
  if (v === null || v === undefined) return '';
  let o: unknown = v;
  if (typeof v === 'string') {
    try {
      o = JSON.parse(v);
    } catch {
      o = v;
    }
  }
  const s = JSON.stringify(o, (k, x: unknown) => (k !== '' && HIDDEN_ARG.test(k) ? '…' : x));
  return s === '{}' || s === '""' ? '' : ` ${clip(scrubSecrets(s), 80)}`;
}

function firstText(result: unknown): string {
  const c = (result as { content?: { type?: string; text?: string }[] } | null)?.content;
  const t = Array.isArray(c) ? c.find((x) => x.type === 'text')?.text : undefined;
  return typeof t === 'string' ? clip(t.split('\n')[0] ?? '', 100) : '';
}

/** One line of `codex exec --json`. */
export function parseCodexLine(line: string): Parsed {
  let e: { type?: string; item?: Record<string, unknown> };
  try {
    e = JSON.parse(line) as typeof e;
  } catch {
    return {};
  }
  const it = e.item;
  if (!it) return {};
  const type = it['type'];
  if (type === 'mcp_tool_call') {
    const tool = String(it['tool'] ?? 'tool');
    if (e.type === 'item.started') return { step: { kind: 'tool', text: `${tool}${args(it['arguments'])}` }, toolCall: tool };
    if (e.type === 'item.completed') {
      const err = it['error'];
      if (err !== null && err !== undefined) return { step: { kind: 'tool-failed', text: `${tool}: ${clip(typeof err === 'string' ? err : JSON.stringify(err), 120)}` } };
      return { step: { kind: 'tool-done', text: `${tool}${firstText(it['result']) ? ` → ${firstText(it['result'])}` : ''}` } };
    }
  }
  if (e.type === 'item.completed' && type === 'agent_message' && typeof it['text'] === 'string') {
    return { step: { kind: 'say', text: clip(it['text'], 400) }, answer: it['text'] };
  }
  if (e.type === 'item.completed' && type === 'reasoning' && typeof it['text'] === 'string') {
    return { step: { kind: 'thinking', text: clip(it['text'], 300) } };
  }
  if (e.type === 'item.started' && type === 'command_execution') {
    return { step: { kind: 'note', text: `shell (blocked by the read-only sandbox): ${clip(String(it['command'] ?? ''), 100)}` } };
  }
  return {};
}

/** One line of `agy --output-format stream-json`. Text arrives in pieces; the caller joins them. */
export function parseAgyLine(line: string): Parsed & { textDelta?: string; responseDone?: boolean } {
  let e: { event?: string; step_update?: Record<string, unknown>; result?: Record<string, unknown> };
  try {
    e = JSON.parse(line) as typeof e;
  } catch {
    return {};
  }
  if (e.event === 'result' && e.result) {
    const r = e.result['response'];
    return typeof r === 'string' ? { answer: r.trim() } : {};
  }
  const s = e.step_update;
  if (e.event !== 'step_update' || !s) return {};
  const type = s['step_type'];
  const state = s['state'];
  if (type === 'tool') {
    const info = (s['tool_info'] ?? {}) as { name?: string; parameters?: Record<string, unknown> };
    const p = info.parameters ?? {};
    const name = typeof p['ToolName'] === 'string' ? `${String(p['ServerName'] ?? '')}${p['ServerName'] ? '/' : ''}${p['ToolName']}` : String(s['tool_name'] ?? info.name ?? 'tool');
    if (state === 'ACTIVE') return { step: { kind: 'tool', text: `${name}${args(p['Arguments'])}` }, toolCall: name };
    if (state === 'DONE') return { step: { kind: 'tool-done', text: name } };
    if (state === 'ERROR' || state === 'FAILED') return { step: { kind: 'tool-failed', text: name } };
  }
  if (type === 'thinking' && typeof s['text_delta'] === 'string') return { step: { kind: 'thinking', text: clip(s['text_delta'], 300) } };
  if (type === 'agent_response') {
    const d = typeof s['text_delta'] === 'string' ? s['text_delta'] : '';
    return { textDelta: d, responseDone: state === 'DONE' };
  }
  return {};
}
