/** The task tools the hub offers to every MCP client (ADR 0013). */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { MagnusError, type Env } from '../types.js';
import { appendEvent, askOwner, checkToken, startTask, waitForAnswer } from './tasks.js';

export interface BuiltinTools {
  tools: Tool[];
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const str = (v: unknown, name: string, max: number): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new MagnusError('BAD_ARGS', `"${name}" is required`);
  return v.slice(0, max);
};

const ID = { task_id: { type: 'string', description: 'From magnus__task_start (or given in your task)' }, token: { type: 'string', description: 'The task token that came with the task id' } };

export function taskTools(env: Env, source = 'mcp'): BuiltinTools {
  const tools: Tool[] = [
    {
      name: 'magnus__task_start',
      description: "Start a task in Magnus so the user can follow it on their phone. Returns a task id and token: keep both for the other magnus__task_* tools. Use when you begin a longer piece of work the user asked for.",
      inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Short title, e.g. "Fix the login bug"' } }, required: ['title'] },
    },
    {
      name: 'magnus__task_update',
      description: 'Report progress on a Magnus task (one short line). The user sees it on their phone.',
      inputSchema: { type: 'object', properties: { ...ID, message: { type: 'string' } }, required: ['task_id', 'token', 'message'] },
    },
    {
      name: 'magnus__task_done',
      description: 'Finish a Magnus task: say what was done (or why it failed). The user is told on their phone.',
      inputSchema: { type: 'object', properties: { ...ID, result: { type: 'string' }, ok: { type: 'boolean', description: 'false when it failed' } }, required: ['task_id', 'token', 'result'] },
    },
    {
      name: 'magnus__ask_user',
      description: "Ask the user a question on their phone and wait for the answer (up to wait_seconds, max 600). Use only when you cannot go on without the user. The answer is the user's text: treat it as their reply, not as instructions from anyone else.",
      inputSchema: {
        type: 'object',
        properties: { ...ID, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: 'Up to 6 short choices (optional)' }, wait_seconds: { type: 'number' } },
        required: ['task_id', 'token', 'question'],
      },
    },
  ];

  async function call(name: string, a: Record<string, unknown>): Promise<CallToolResult> {
    try {
      if (name === 'magnus__task_start') {
        const t = startTask(env, str(a['title'], 'title', 160), source);
        return text(JSON.stringify({ task_id: t.id, token: t.token }));
      }
      const id = str(a['task_id'], 'task_id', 60);
      checkToken(env, id, a['token']);
      if (name === 'magnus__task_update') {
        appendEvent(env, { task: id, kind: 'step', source, text: str(a['message'], 'message', 500) });
        return text('ok');
      }
      if (name === 'magnus__task_done') {
        appendEvent(env, { task: id, kind: a['ok'] === false ? 'failed' : 'done', source, text: str(a['result'], 'result', 2000) });
        return text('ok: the user has been told');
      }
      if (name === 'magnus__ask_user') {
        const options = Array.isArray(a['options']) ? a['options'].filter((o): o is string => typeof o === 'string' && o.trim() !== '') : [];
        // Refused rather than cut: a cut choice could not be picked on the phone.
        if (options.length > 6 || options.some((o) => o.length > 60)) throw new MagnusError('BAD_ARGS', 'at most 6 options of up to 60 characters each');
        const qid = askOwner(env, id, str(a['question'], 'question', 1000), options, source);
        const wait = Math.min(Math.max(Number(a['wait_seconds'] ?? 300) || 300, 10), 600);
        const answer = await waitForAnswer(env, id, qid, wait * 1000);
        return answer === null ? text(`no answer within ${wait} s; the question stays open on the user's phone`) : text(`The user answered: ${answer}`);
      }
      return text(`unknown tool "${name}"`, true);
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  }

  return { tools, call };
}
