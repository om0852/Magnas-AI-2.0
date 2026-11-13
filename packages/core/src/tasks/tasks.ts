/**
 * The task log (ADR 0013): every task from Magnus or an AI tool, as append-only events in
 * ~/.magnus/tasks/events.jsonl. A task's state is the fold of its events.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MagnusError, type Env } from '../types.js';
import { safeText } from './scrub.js';

export type TaskStatus = 'working' | 'needs-you' | 'done' | 'failed' | 'stopped';

export interface TaskEvent {
  at: string;
  task: string;
  kind: 'created' | 'step' | 'status' | 'question' | 'answer' | 'done' | 'failed' | 'stopped';
  /** Who reported it: 'magnus', 'claude-code', 'mcp', 'phone', 'dashboard', … */
  source: string;
  title?: string;
  text?: string;
  status?: TaskStatus;
  /** created: the hash of the task's token. */
  tokenHash?: string;
  /** question/answer: which question. */
  qid?: string;
  options?: string[];
  cwd?: string;
}

export interface Task {
  id: string;
  title: string;
  source: string;
  status: TaskStatus;
  created: string;
  updated: string;
  cwd?: string;
  steps: { at: string; text: string }[];
  question?: { qid: string; text: string; options: string[] };
  result?: string;
}

/** Above this the log rotates: events.jsonl becomes events.1.jsonl, replacing the older one. */
const MAX_FILE = 1024 * 1024;
const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

function file(env: Env): string {
  return path.join(env.magnusHome, 'tasks', 'events.jsonl');
}
function older(env: Env): string {
  return path.join(env.magnusHome, 'tasks', 'events.1.jsonl');
}

function readEvents(env: Env): TaskEvent[] {
  let text = '';
  for (const f of [older(env), file(env)]) {
    try {
      text += fs.readFileSync(f, 'utf8') + '\n';
    } catch {
      // not there yet
    }
  }
  const out: TaskEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as TaskEvent);
    } catch {
      // a half-written last line: skipped
    }
  }
  return out;
}

/** Appends one event, with every text scrubbed and cut (ADR 0013). */
export function appendEvent(env: Env, ev: Omit<TaskEvent, 'at'> & { at?: string }): TaskEvent {
  const clean: TaskEvent = {
    at: ev.at ?? new Date().toISOString(),
    task: safeText(ev.task, 120, true),
    kind: ev.kind,
    source: safeText(ev.source, 40, true),
    ...(ev.title !== undefined ? { title: safeText(ev.title, 160, true) } : {}),
    ...(ev.text !== undefined ? { text: safeText(ev.text, 2000) } : {}),
    ...(ev.status !== undefined ? { status: ev.status } : {}),
    ...(ev.tokenHash !== undefined ? { tokenHash: ev.tokenHash } : {}),
    ...(ev.qid !== undefined ? { qid: safeText(ev.qid, 40, true) } : {}),
    ...(ev.options !== undefined ? { options: ev.options.slice(0, 6).map((o) => safeText(o, 60, true)) } : {}),
    ...(ev.cwd !== undefined ? { cwd: safeText(ev.cwd, 200, true) } : {}),
  };
  const f = file(env);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(clean) + '\n');
  if (fs.statSync(f).size > MAX_FILE) {
    // Rotation, not a rewrite: the rename is atomic and a writer after it starts a new file, so
    // no event is lost. On Windows it can fail while another process has the file open: then
    // it is tried again on the next write.
    try {
      fs.renameSync(f, older(env));
    } catch {
      // next time
    }
  }
  return clean;
}

/** Tasks from events, newest first (pure). */
export function fold(events: readonly TaskEvent[]): Task[] {
  const tasks = new Map<string, Task>();
  for (const e of events) {
    let t = tasks.get(e.task);
    if (!t) {
      t = { id: e.task, title: e.title ?? e.task, source: e.source, status: 'working', created: e.at, updated: e.at, steps: [] };
      tasks.set(e.task, t);
    }
    t.updated = e.at;
    if (e.cwd !== undefined) t.cwd = e.cwd;
    switch (e.kind) {
      case 'created':
        if (e.title !== undefined) t.title = e.title;
        t.status = 'working';
        delete t.result;
        delete t.question;
        break;
      case 'step':
        if (e.text !== undefined) t.steps.push({ at: e.at, text: e.text });
        if (t.steps.length > 40) t.steps.splice(0, t.steps.length - 40);
        if (t.status !== 'needs-you') t.status = 'working';
        break;
      case 'status':
        if (e.status !== undefined) t.status = e.status;
        if (e.text !== undefined) t.steps.push({ at: e.at, text: e.text });
        if (e.status !== 'needs-you') delete t.question;
        break;
      case 'question':
        t.status = 'needs-you';
        t.question = { qid: e.qid ?? '', text: e.text ?? '', options: e.options ?? [] };
        break;
      case 'answer':
        if (t.question && t.question.qid === e.qid) delete t.question;
        if (e.text !== undefined) t.steps.push({ at: e.at, text: `You answered: ${e.text}` });
        t.status = 'working';
        break;
      case 'done':
      case 'failed':
      case 'stopped':
        t.status = e.kind;
        if (e.text !== undefined) t.result = e.text;
        delete t.question;
        break;
    }
  }
  return [...tasks.values()].sort((a, b) => (a.updated < b.updated ? 1 : -1));
}

export function listTasks(env: Env, limit = 30): Task[] {
  return fold(readEvents(env)).slice(0, limit);
}

/** A new task with its own token (shown once to whoever started it). */
export function startTask(env: Env, title: string, source: string, cwd?: string): { id: string; token: string } {
  const id = `t_${crypto.randomBytes(6).toString('hex')}`;
  const token = crypto.randomBytes(18).toString('base64url');
  appendEvent(env, { task: id, kind: 'created', source, title, tokenHash: sha(token), ...(cwd !== undefined ? { cwd } : {}) });
  return { id, token };
}

/** Throws unless `token` belongs to task `id` (one tool cannot change another's task). */
export function checkToken(env: Env, id: string, token: unknown): void {
  const created = readEvents(env).find((e) => e.task === id && e.kind === 'created' && e.tokenHash !== undefined);
  if (!created?.tokenHash) throw new MagnusError('NOT_FOUND', `no task "${id}"`);
  const a = Buffer.from(sha(typeof token === 'string' ? token : ''), 'hex');
  const b = Buffer.from(created.tokenHash, 'hex');
  if (!crypto.timingSafeEqual(a, b)) throw new MagnusError('BAD_TOKEN', 'wrong token for this task');
}

/** Asks the owner a question on a task; returns its id. */
export function askOwner(env: Env, task: string, question: string, options: string[], source: string): string {
  const qid = `q_${crypto.randomBytes(4).toString('hex')}`;
  appendEvent(env, { task, kind: 'question', source, text: question, qid, options });
  return qid;
}

/** The owner's answer (from the phone or the dashboard). */
export function answerQuestion(env: Env, task: string, qid: string, answer: string, from: string): void {
  const t = listTasks(env, 1000).find((x) => x.id === task);
  if (!t?.question || t.question.qid !== qid) throw new MagnusError('NOT_FOUND', 'that question is no longer open');
  if (answer.trim() === '') throw new MagnusError('BAD_ARGS', 'the answer is empty');
  appendEvent(env, { task, kind: 'answer', source: from, qid, text: answer });
}

/** Waits for the owner's answer to a question (polling the log); null on timeout or `signal`. */
export async function waitForAnswer(env: Env, task: string, qid: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && signal?.aborted !== true) {
    const a = readEvents(env).find((e) => e.task === task && e.kind === 'answer' && e.qid === qid);
    if (a) return a.text ?? '';
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
