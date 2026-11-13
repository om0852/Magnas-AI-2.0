import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Gateway } from '../src/hub/gateway.js';
import { claudeTaskId, handleClaudeHook, HOOK_EVENTS, planClaudeHooks } from '../src/tasks/hooks.js';
import { taskTools } from '../src/tasks/mcp-tools.js';
import { scrubSecrets } from '../src/tasks/scrub.js';
import { answerQuestion, appendEvent, askOwner, checkToken, fold, listTasks, startTask, waitForAnswer, type TaskEvent } from '../src/tasks/tasks.js';
import { fakeHome } from './helpers.js';

const textOf = (r: CallToolResult): string => (r.content[0] as { text: string }).text;
// Built at run time so no secret-shaped literal sits in the repo.
const rnd = (n: number): string => 'a1B2c3D4e5'.repeat(10).slice(0, n);

test('scrub: known secret shapes and secret-named values are hidden; normal text is kept', () => {
  const cases = [
    `sk-${rnd(40)}`,
    `sk-proj-${rnd(40)}`,
    `ghp_${rnd(36)}`,
    `github_pat_${rnd(40)}`,
    `xoxb-${rnd(30)}`,
    `AIza${rnd(35)}`,
    `AKIA${'ABCDEFGHIJKLMNOP'}`,
    `123456789:AA${rnd(33)}`,
    `mgn_${rnd(30)}`,
    `eyJ${rnd(20)}.${rnd(20)}.${rnd(20)}`,
  ];
  for (const c of cases) {
    const out = scrubSecrets(`before ${c} after`);
    assert.ok(!out.includes(c), c);
    assert.match(out, /^before \[hidden[^\]]*\] after$/, c);
  }
  assert.equal(scrubSecrets(`-----BEGIN RSA PRIVATE KEY-----\n${rnd(60)}\n-----END RSA PRIVATE KEY-----`), '[hidden private key]');
  assert.equal(scrubSecrets(`git clone https://me:${rnd(20)}@github.com/x`), 'git clone https://me:[hidden]@github.com/x');
  assert.equal(scrubSecrets(`Authorization: Bearer ${rnd(30)}`), 'Authorization: Bearer [hidden]');
  assert.equal(scrubSecrets(`API_KEY=${rnd(20)} and password: "${rnd(10)}"`), 'API_KEY=[hidden] and password: "[hidden]"');
  const plain = 'Fixed the login bug in src/auth.ts; 12 tests pass. See https://github.com/om/x/pull/3';
  assert.equal(scrubSecrets(plain), plain);
});

test('tasks: events fold into tasks; text is scrubbed and cut before it is stored', () => {
  const env = fakeHome();
  appendEvent(env, { task: 'a', kind: 'created', source: 'cli', title: 'First' });
  appendEvent(env, { task: 'a', kind: 'step', source: 'cli', text: `used token=${rnd(20)}` });
  appendEvent(env, { task: 'a', kind: 'done', source: 'cli', text: 'x'.repeat(5000) });
  const raw = fs.readFileSync(path.join(env.magnusHome, 'tasks', 'events.jsonl'), 'utf8');
  assert.ok(!raw.includes(rnd(20)), 'the secret never reaches the file');
  const [t] = listTasks(env);
  assert.equal(t?.title, 'First');
  assert.equal(t?.status, 'done');
  assert.equal(t?.steps[0]?.text, 'used token=[hidden]');
  assert.ok((t?.result?.length ?? 0) <= 2001);

  // fold is pure: question → needs-you, answer → working, done clears the question.
  const ev = (kind: TaskEvent['kind'], more: Partial<TaskEvent> = {}): TaskEvent => ({ at: `2026-11-12T10:00:0${n++}Z`, task: 'b', kind, source: 's', ...more });
  let n = 0;
  const q = fold([ev('created', { title: 'B' }), ev('question', { qid: 'q1', text: 'Which?', options: ['x', 'y'] })])[0];
  assert.equal(q?.status, 'needs-you');
  assert.deepEqual(q?.question, { qid: 'q1', text: 'Which?', options: ['x', 'y'] });
  n = 0;
  const a = fold([ev('created'), ev('question', { qid: 'q1', text: '?' }), ev('answer', { qid: 'q1', text: 'x' })])[0];
  assert.equal(a?.status, 'working');
  assert.equal(a?.question, undefined);
  assert.equal(a?.steps.at(-1)?.text, 'You answered: x');
});

test('tasks: each task has its own token; another token or task id is refused', () => {
  const env = fakeHome();
  const one = startTask(env, 'One', 'mcp');
  const two = startTask(env, 'Two', 'mcp');
  checkToken(env, one.id, one.token);
  assert.throws(() => checkToken(env, one.id, two.token), /wrong token/);
  assert.throws(() => checkToken(env, one.id, undefined), /wrong token/);
  assert.throws(() => checkToken(env, 't_nope', one.token), /no task/);
  const raw = fs.readFileSync(path.join(env.magnusHome, 'tasks', 'events.jsonl'), 'utf8');
  assert.ok(!raw.includes(one.token) && !raw.includes(two.token), 'only token hashes are stored');
});

test('tasks: a question is answered once; waitForAnswer returns it, or null on timeout', async () => {
  const env = fakeHome();
  const t = startTask(env, 'Q', 'mcp');
  const qid = askOwner(env, t.id, 'Deploy now?', ['yes', 'no'], 'mcp');
  assert.equal(await waitForAnswer(env, t.id, qid, 50), null);
  assert.throws(() => answerQuestion(env, t.id, 'q_other', 'yes', 'phone'), /no longer open/);
  assert.throws(() => answerQuestion(env, t.id, qid, '  ', 'phone'), /empty/);
  answerQuestion(env, t.id, qid, 'yes', 'phone');
  assert.equal(await waitForAnswer(env, t.id, qid, 50), 'yes');
  assert.throws(() => answerQuestion(env, t.id, qid, 'no', 'phone'), /no longer open/, 'a second answer is refused');
});

test('hub: the magnus__task tools start, update, ask and finish a task', async () => {
  const env = fakeHome();
  const g = new Gateway({}, async () => { throw new Error('no servers'); }, () => {}, undefined, taskTools(env, 'codex'));
  const names = (await g.listTools()).map((t) => t.name);
  for (const n of ['magnus__task_start', 'magnus__task_update', 'magnus__task_done', 'magnus__ask_user']) assert.ok(names.includes(n), n);
  const { task_id, token } = JSON.parse(textOf(await g.callTool('magnus__task_start', { title: 'Refactor' }))) as { task_id: string; token: string };
  assert.equal(textOf(await g.callTool('magnus__task_update', { task_id, token, message: 'half way' })), 'ok');
  const bad = await g.callTool('magnus__task_update', { task_id, token: 'guess', message: 'x' });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /wrong token/);

  const asking = g.callTool('magnus__ask_user', { task_id, token, question: 'Keep the old API?', options: ['keep', 'drop'], wait_seconds: 10 });
  let open: string | undefined;
  for (let i = 0; i < 50 && open === undefined; i++) {
    await new Promise((r) => setTimeout(r, 20));
    open = listTasks(env).find((t) => t.id === task_id)?.question?.qid;
  }
  assert.ok(open, 'the question shows on the task');
  assert.equal(listTasks(env)[0]?.status, 'needs-you');
  answerQuestion(env, task_id, open, 'keep', 'phone');
  assert.equal(textOf(await asking), 'The user answered: keep');

  assert.match(textOf(await g.callTool('magnus__task_done', { task_id, token, result: 'Done, 3 files' })), /told/);
  const t = listTasks(env)[0];
  assert.equal(t?.status, 'done');
  assert.equal(t?.source, 'codex');
  assert.deepEqual(t?.steps.map((s) => s.text), ['half way', 'You answered: keep']);
  await g.close();
});

test('claude hooks: prompt, waiting and stop become one task per session', () => {
  const env = fakeHome();
  const base = { session_id: 'abc-123', cwd: 'C:\\code\\app' };
  assert.equal(handleClaudeHook(env, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Fix the tests' }), 'created');
  assert.equal(handleClaudeHook(env, { ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs permission to use Bash' }), 'needs-you');
  let t = listTasks(env)[0];
  assert.equal(t?.id, claudeTaskId('abc-123'));
  assert.equal(t?.status, 'needs-you');
  assert.equal(t?.cwd, 'C:\\code\\app');
  assert.equal(handleClaudeHook(env, { ...base, hook_event_name: 'Notification', notification_type: 'auth_success', message: 'Signed in' }), 'step');
  assert.equal(handleClaudeHook(env, { ...base, hook_event_name: 'Stop', stop_hook_active: true }), 'ignored: continuing');
  assert.equal(handleClaudeHook(env, { ...base, hook_event_name: 'Stop', last_assistant_message: 'All 40 tests pass.' }), 'done');
  t = listTasks(env)[0];
  assert.equal(t?.status, 'done');
  assert.equal(t?.result, 'All 40 tests pass.');
  assert.equal(t?.title, 'Fix the tests');
  assert.equal(handleClaudeHook(env, { hook_event_name: 'Stop' }), 'ignored: no session');
  assert.equal(handleClaudeHook(env, 'not json'), 'ignored: no session');
  assert.equal(handleClaudeHook(env, { ...base, hook_event_name: 'PreToolUse' }), 'ignored: other event');
  assert.equal(claudeTaskId('3f1c2a9e-1b2c-4d5e-8f90-123456789abc'), 'claude-code:3f1c2a9e-1b2c-4d5e-8f90-123456789abc');
  assert.match(claudeTaskId('../../x y'), /^claude-code:[0-9a-f]{32}$/);
  assert.notEqual(claudeTaskId('a/b'), claudeTaskId('ab'), 'odd ids never share a task');
});

test('claude hooks: settings.json gets our three hooks; other hooks and settings stay', () => {
  const mine = { hooks: [{ type: 'command', command: 'echo hi' }] };
  const current = JSON.stringify({ model: 'opus', hooks: { Stop: [mine], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] } });
  const add = planClaudeHooks(current, 'node', 'C:\\m\\cli.js', true);
  assert.equal(add.op.op, 'add');
  const root = JSON.parse(add.text ?? '') as { model: string; hooks: Record<string, { hooks: { args?: string[]; async?: boolean }[] }[]> };
  assert.equal(root.model, 'opus');
  for (const e of HOOK_EVENTS) {
    const ours = root.hooks[e]?.flatMap((g) => g.hooks).filter((h) => h.args?.join(' ') === 'C:\\m\\cli.js event claude-code');
    assert.equal(ours?.length, 1, e);
    assert.equal(ours?.[0]?.async, true, 'never blocks Claude Code');
  }
  assert.deepEqual(root.hooks['Stop']?.[0], mine, "the user's own Stop hook is kept");
  assert.equal(root.hooks['PreToolUse']?.length, 1);

  assert.equal(planClaudeHooks(add.text, 'node', 'C:\\m\\cli.js', true).op.op, 'unchanged');
  assert.equal(planClaudeHooks(add.text, 'node', 'D:\\new\\cli.js', true).op.op, 'update', 'a moved Magnus is updated, not added twice');

  const off = planClaudeHooks(add.text, 'node', 'C:\\m\\cli.js', false);
  assert.equal(off.op.op, 'remove');
  assert.deepEqual(JSON.parse(off.text ?? ''), JSON.parse(current), 'removing gives back exactly what was there');
  assert.equal(planClaudeHooks(current, 'node', 'x', false).op.op, 'unchanged');

  assert.equal(planClaudeHooks('{ // a comment\n}', 'node', 'x', true).op.op, 'skip', 'JSON with comments is left alone');
  assert.equal(planClaudeHooks(null, 'node', 'x', true).op.op, 'add', 'no file yet: created');
});

test('tasks: the log rotates at 1 MB without losing an event; the older file is still read', () => {
  const env = fakeHome();
  const t = startTask(env, 'Long', 'mcp');
  for (let i = 0; i < 700; i++) appendEvent(env, { task: `bulk${i % 50}`, kind: 'step', source: 'x', text: `${i} ${'y'.repeat(1500)}` });
  const dir = path.join(env.magnusHome, 'tasks');
  assert.ok(fs.existsSync(path.join(dir, 'events.1.jsonl')), 'rotated');
  assert.ok(fs.statSync(path.join(dir, 'events.jsonl')).size < 1024 * 1024);
  appendEvent(env, { task: t.id, kind: 'done', source: 'mcp', text: 'finished' });
  assert.equal(listTasks(env, 1000).find((x) => x.id === t.id)?.status, 'done', 'the newest event is there');
});

test('hub: ask_user refuses choices the phone could not show whole', async () => {
  const env = fakeHome();
  const tools = taskTools(env, 'codex');
  const { task_id, token } = JSON.parse(textOf(await tools.call('magnus__task_start', { title: 'X' }))) as { task_id: string; token: string };
  const many = await tools.call('magnus__ask_user', { task_id, token, question: '?', options: ['1', '2', '3', '4', '5', '6', '7'] });
  assert.equal(many.isError, true);
  assert.match(textOf(many), /at most 6 options/);
  const long = await tools.call('magnus__ask_user', { task_id, token, question: '?', options: ['z'.repeat(61)] });
  assert.equal(long.isError, true);
  assert.equal(listTasks(env)[0]?.question, undefined, 'no question was opened');
});

test('track: live steps are masked before they are logged or sent to a phone', async () => {
  const { trackedAsk } = await import('../src/tasks/track.js');
  const { DEFAULT_BRAIN } = await import('../src/brain/ask.js');
  const env = fakeHome();
  const seen: string[] = [];
  const secret = `sk-${rnd(40)}`;
  await trackedAsk(env, 'x', DEFAULT_BRAIN, {
    antigravity: async (_p, _t, opts) => {
      opts?.onProgress?.({ kind: 'thinking', text: `the key is ${secret}`, ms: 1 });
      opts?.onProgress?.({ kind: 'say', text: `using ${secret}`, ms: 2 });
      return { ok: true, answer: 'ok', toolCalls: [], callsKnown: true, timedOut: false, ms: 3 };
    },
    codex: null,
  }, 'phone', { onProgress: (p) => seen.push(p.text) });
  assert.equal(seen.length, 2);
  assert.ok(seen.every((t) => !t.includes(secret)), seen.join(' | '));
  assert.ok(!fs.readFileSync(path.join(env.magnusHome, 'tasks', 'events.jsonl'), 'utf8').includes(secret));
});
