/**
 * Antigravity through the Agent Client Protocol (ADR 0018): `agy acp` gets the Magnus hub as its
 * only MCP server for this one session (its own configured servers are not used), so it has the
 * same tools and limits as Codex: the hub's servers, the desktop tools, magnus__ask_user.
 * JSON-RPC 2.0 over stdio, one request per line.
 */
import { spawn } from 'node:child_process';
import type { Env } from '../types.js';
import { args as argText, type Progress } from './progress.js';
import { removeWorkDir, workDir, type BrainRun, type BrainRunner, type Launcher } from './runners.js';

type Msg = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };

/** The tool name inside an ACP tool call: "mcp_magnus_xtraos__drag" or a title like "xtraos__drag" (pure). */
export function acpToolName(update: Record<string, unknown>): string {
  // Antigravity puts the real names in rawInput: {ServerName, ToolName, Arguments}.
  const ri = (update['rawInput'] ?? {}) as Record<string, unknown>;
  if (typeof ri['ToolName'] === 'string' && ri['ToolName'] !== '') {
    const tool = ri['ToolName'];
    const server = typeof ri['ServerName'] === 'string' ? ri['ServerName'] : '';
    return server === '' || server === 'magnus' || tool.includes('__') ? tool : `${server}__${tool}`;
  }
  const raw = [update['title'], (update['_meta'] as Record<string, unknown> | undefined)?.['toolName'], update['kind']].find((v) => typeof v === 'string' && v !== '') as string | undefined;
  const t = (raw ?? 'tool').trim();
  const m = /([a-z0-9-]+__[A-Za-z0-9_]+)/.exec(t);
  return m ? (m[1] as string) : t.replace(/^mcp_magnus_/, '').slice(0, 60);
}

/** Which permission option to pick: allow once for tools of the Magnus hub, otherwise reject (pure). */
export function pickPermission(params: Record<string, unknown>): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  const options = (Array.isArray(params['options']) ? params['options'] : []) as { optionId?: string; kind?: string }[];
  const call = (params['toolCall'] ?? {}) as Record<string, unknown>;
  // Only a call that names the Magnus server is ours: its rawInput says ServerName "magnus", or
  // its title is Antigravity's "mcp_magnus_…". Anything else (its own servers, shell, files) is refused.
  const ri = (call['rawInput'] ?? {}) as Record<string, unknown>;
  const ours = ri['ServerName'] === 'magnus' || /^mcp_magnus_/.test(String(call['title'] ?? ''));
  const want = ours ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const o = options.find((x) => want.includes(String(x.kind)));
  return o?.optionId ? { outcome: 'selected', optionId: o.optionId } : { outcome: 'cancelled' };
}

/** How Antigravity must address the hub's tools (it once split "xtraos__status" into server and tool). */
export const ACP_NOTE =
  'How to call tools: you have one MCP server, named "magnus". Every tool belongs to it: call it with ServerName "magnus" and ToolName exactly as listed, double underscore included, e.g. ToolName "xtraos__observe", "xtradevpilot__navigate" or "magnus__arrange_desktop_icons". There is no server called "xtraos" or "xtradevpilot" of its own.';

export interface AcpOptions {
  /** e.g. "claude-opus-4-6-thinking"; skipped if the agent does not offer it. */
  model?: string;
  /** Tried when `model` is not offered. */
  fallbackModel?: string;
}

export function acpRunner(agy: Launcher, hub: Launcher, servers: readonly string[], env: Env, o: AcpOptions = {}): BrainRunner {
  return async (prompt, timeoutMs, opts = {}) => {
    const cwd = workDir();
    const t0 = Date.now();
    const calls: string[] = [];
    const say = (p: Omit<Progress, 'ms'>): void => opts.onProgress?.({ ...p, ms: Date.now() - t0 });
    const child = spawn(agy.command, [...agy.args, 'acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    let nextId = 0;
    const waiting = new Map<number, (m: Msg) => void>();
    let answer = '';
    let thought = '';
    let sessionId = '';
    let timedOut = false;
    let stopped = false;
    let exited = false;
    const write = (m: Msg): void => {
      if (!exited) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    };
    const request = (method: string, params: Record<string, unknown>): Promise<Msg> =>
      new Promise((resolve) => {
        const id = ++nextId;
        waiting.set(id, resolve);
        write({ id, method, params });
      });
    const gone = new Promise<void>((resolve) =>
      child.on('exit', () => {
        exited = true;
        for (const r of waiting.values()) r({ error: { message: 'Antigravity stopped' } });
        waiting.clear();
        resolve();
      }),
    );
    child.on('error', () => undefined);
    child.stderr.on('data', () => undefined);
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === '') continue;
        let m: Msg;
        try {
          m = JSON.parse(line) as Msg;
        } catch {
          continue;
        }
        if (typeof m.id === 'number' && m.method === undefined && waiting.has(m.id)) {
          (waiting.get(m.id) as (m: Msg) => void)(m);
          waiting.delete(m.id);
          continue;
        }
        const p = m.params ?? {};
        if (m.method === 'session/update') {
          const u = (p['update'] ?? {}) as Record<string, unknown>;
          const kind = u['sessionUpdate'];
          const content = u['content'] as { type?: string; text?: string } | undefined;
          if (kind === 'agent_message_chunk' && content?.type === 'text') answer += content.text ?? '';
          else if (kind === 'agent_thought_chunk' && content?.type === 'text') {
            thought += content.text ?? '';
            if (thought.length > 160 || /\n/.test(thought)) {
              say({ kind: 'thinking', text: thought.replace(/\s+/g, ' ').trim().slice(0, 300) });
              thought = '';
            }
          } else if (kind === 'tool_call') {
            const name = acpToolName(u);
            calls.push(name);
            const ri = (u['rawInput'] ?? {}) as Record<string, unknown>;
            say({ kind: 'tool', text: `${name}${argText(ri['Arguments'] ?? u['rawInput'])}` });
          } else if (kind === 'tool_call_update' && (u['status'] === 'failed' || u['status'] === 'completed')) {
            const name = acpToolName(u);
            if (u['status'] === 'failed') say({ kind: 'tool-failed', text: name });
          }
        } else if (m.method === 'session/request_permission' && m.id !== undefined) {
          write({ id: m.id, result: { outcome: pickPermission(p) } });
        } else if (m.method !== undefined && m.id !== undefined) {
          // fs / terminal requests: this client offers neither.
          write({ id: m.id, error: { message: 'not supported by Magnus' } as never });
        }
      }
    });

    const cancel = (): void => {
      if (sessionId !== '') write({ method: 'session/cancel', params: { sessionId } });
      setTimeout(() => {
        if (!exited) child.kill();
      }, 3000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, timeoutMs);
    const onAbort = (): void => {
      stopped = true;
      cancel();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let ok = false;
    let error = '';
    try {
      const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (init.error) throw new Error(init.error.message ?? 'Antigravity did not start');
      const s = await request('session/new', {
        cwd,
        mcpServers: [{ name: 'magnus', command: hub.command, args: [...hub.args, 'hub', '--quick', '--servers', servers.join(',')], env: [{ name: 'MAGNUS_HOME', value: env.magnusHome }] }],
      });
      if (s.error) throw new Error(s.error.message ?? 'Antigravity refused the session');
      const res = (s.result ?? {}) as { sessionId?: string; models?: { availableModels?: { modelId?: string }[] } };
      sessionId = res.sessionId ?? '';
      const offered = (res.models?.availableModels ?? []).map((x) => x.modelId);
      const model = [o.model, o.fallbackModel].find((x) => x !== undefined && offered.includes(x));
      if (model !== undefined) {
        const set = await request('session/set_model', { sessionId, modelId: model });
        say({ kind: 'note', text: set.error ? `model ${model} not set: ${set.error.message ?? ''}` : `model: ${model}` });
      }
      const r = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `${prompt}\n\n${ACP_NOTE}` }] });
      if (r.error) throw new Error(r.error.message ?? 'Antigravity failed');
      const stop = (r.result as { stopReason?: string } | undefined)?.stopReason;
      ok = stop === 'end_turn' && !timedOut && !stopped && answer.trim() !== '';
      if (stop === 'cancelled' && !timedOut) stopped = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (!exited) {
        child.stdin.end();
        child.kill();
      }
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
      removeWorkDir(cwd);
    }
    const text = answer.trim() !== '' ? answer.trim() : error !== '' ? `Antigravity: ${error}` : timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'no answer';
    const run: BrainRun = { ok, answer: text, toolCalls: calls, callsKnown: true, timedOut, ms: Date.now() - t0, ...(stopped ? { stopped: true } : {}) };
    return run;
  };
}
