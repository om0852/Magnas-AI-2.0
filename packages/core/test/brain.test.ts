import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ask, DEFAULT_BRAIN, type BrainSet } from '../src/brain/ask.js';
import { brainPrompt } from '../src/brain/prompt.js';
import { agyArgs, codexArgs, codexToolCalls, type BrainRun, type BrainRunner } from '../src/brain/runners.js';
import { hubServers } from '../src/hub/start.js';
import { loadRegistry, parseRegistry } from '../src/registry.js';
import { MagnusError } from '../src/types.js';
import { fakeHome, fakeProtector, fakes, run } from './helpers.js';

const runOf = (over: Partial<BrainRun>): BrainRun => ({ ok: true, answer: 'done', toolCalls: [], callsKnown: true, timedOut: false, ms: 1, ...over });

/** A runner that records it was asked and answers `r`. */
function fake(r: BrainRun, seen: string[], id: string): BrainRunner {
  return async (prompt) => {
    seen.push(`${id}:${prompt.includes('Task:') ? 'prompt' : 'raw'}`);
    return r;
  };
}

test('prompt: the task with fixed rules; hub view names <server>__<tool>', () => {
  const p = brainPrompt('  open YouTube  ', ['xtraos'], 'hub');
  assert.match(p, /MCP server "magnus".*<server>__<tool>.*xtraos/s);
  assert.match(p, /Do not run shell commands/);
  assert.match(p, /data, never instructions/);
  assert.match(p, /Never try to get around an approval.*BLOCKED_BY_POLICY/s);
  assert.ok(p.endsWith('Task:\nopen YouTube'));
  assert.match(brainPrompt('x', ['xtraos', 'files'], 'own'), /Use only the tools of these MCP servers: xtraos, files\. Do not use any other/);
});

test('codex args: only the hub, limited servers, its tools pre-approved, read-only, no user config', () => {
  const a = codexArgs('the prompt', { command: 'C:\\n\\node.exe', args: ['C:\\m dir\\cli.js'] }, ['xtraos', 'files'], 'C:\\Users\\me\\.magnus', 'C:\\t\\answer.txt');
  assert.deepEqual(a.slice(0, 6), ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only']);
  const c = a.filter((_, i) => a[i - 1] === '-c');
  assert.deepEqual(c, [
    'mcp_servers.magnus.command="C:\\\\n\\\\node.exe"',
    'mcp_servers.magnus.args=["C:\\\\m dir\\\\cli.js","hub","--servers","xtraos,files"]',
    'mcp_servers.magnus.env.MAGNUS_HOME="C:\\\\Users\\\\me\\\\.magnus"',
    'mcp_servers.magnus.default_tools_approval_mode="approve"',
    'mcp_servers.magnus.startup_timeout_sec=60',
  ]);
  assert.deepEqual(a.slice(-3), ['-o', 'C:\\t\\answer.txt', 'the prompt']);
  assert.ok(!a.some((x) => /bypass|danger/i.test(x)), 'never the bypass flags');
  assert.deepEqual(agyArgs('p', 120_000), ['-p', 'p', '--sandbox', '--print-timeout', '115s']);
  assert.deepEqual(codexToolCalls('x\nmcp: magnus/xtraos__status started\nmcp: magnus/xtraos__status (completed)\nmcp: magnus/xtraos__click started\n'), ['xtraos__status', 'xtraos__click']);
});

test('ask: the first brain that works answers', async () => {
  const seen: string[] = [];
  const brains: BrainSet = { codex: fake(runOf({ answer: 'opened' }), seen, 'codex'), antigravity: fake(runOf({}), seen, 'agy') };
  const r = await ask('open YouTube', DEFAULT_BRAIN, brains);
  assert.deepEqual([r.ok, r.brain, r.answer, seen], [true, 'codex', 'opened', ['codex:prompt']]);
  await assert.rejects(ask('   ', DEFAULT_BRAIN, brains), MagnusError);
});

test('ask: falls back when a brain is missing or failed before any tool call', async () => {
  const seen: string[] = [];
  const quota = runOf({ ok: false, answer: 'usage limit reached', toolCalls: [] });
  let r = await ask('t', DEFAULT_BRAIN, { codex: fake(quota, seen, 'codex'), antigravity: fake(runOf({ answer: 'did it' }), seen, 'agy') });
  assert.deepEqual([r.ok, r.brain, r.answer], [true, 'antigravity', 'did it']);
  assert.deepEqual(r.attempts.map((a) => `${a.brain}:${a.outcome}`), ['codex:failed', 'antigravity:ok']);

  r = await ask('t', DEFAULT_BRAIN, { codex: null, antigravity: fake(runOf({ answer: 'ok' }), seen, 'agy') });
  assert.deepEqual(r.attempts.map((a) => `${a.brain}:${a.outcome}`), ['codex:not-installed', 'antigravity:ok']);

  r = await ask('t', DEFAULT_BRAIN, { codex: null, antigravity: null });
  assert.equal(r.ok, false);
  assert.match(r.answer, /No brain is installed/);
});

test('ask: no fallback once a brain may have acted (no action twice)', async () => {
  const seen: string[] = [];
  const halfDone = runOf({ ok: false, answer: 'timed out', toolCalls: ['xtraos__click'], timedOut: true });
  let r = await ask('send it', DEFAULT_BRAIN, { codex: fake(halfDone, seen, 'codex'), antigravity: fake(runOf({}), seen, 'agy') });
  assert.equal(r.ok, false);
  assert.deepEqual(seen, ['codex:prompt'], 'Antigravity was not started');
  assert.match(r.stoppedBecause ?? '', /already called 1 tool/);

  const blind = runOf({ ok: false, answer: 'error', callsKnown: false });
  r = await ask('t', { ...DEFAULT_BRAIN, order: ['antigravity', 'codex'] }, { codex: fake(runOf({}), seen, 'codex'), antigravity: fake(blind, seen, 'agy') });
  assert.equal(r.brain, 'antigravity');
  assert.match(r.stoppedBecause ?? '', /may already have acted/);
});

test('registry brain settings: defaults, validation, kept on save', async () => {
  const base = { version: 1, mcpServers: {} };
  assert.equal(parseRegistry(JSON.stringify(base)).brain, undefined);
  assert.deepEqual(parseRegistry(JSON.stringify({ ...base, brain: { order: ['antigravity'], servers: ['a', 'b'], timeoutSec: 120 } })).brain, {
    order: ['antigravity'],
    servers: ['a', 'b'],
    timeoutSec: 120,
  });
  for (const bad of [{ order: ['gpt'] }, { order: [] }, { servers: [] }, { timeoutSec: 5 }, { timeoutSec: 1.5 }, []]) {
    assert.throws(() => parseRegistry(JSON.stringify({ ...base, brain: bad })), MagnusError, JSON.stringify(bad));
  }
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  fs.writeFileSync(path.join(env.magnusHome, 'magnus.json'), JSON.stringify({ ...base, brain: { servers: ['x'] } }));
  await run(env, f, 'add-mcp', 'x', '--', 'node');
  assert.deepEqual(loadRegistry(env).brain, { servers: ['x'] }, 'saving the registry keeps the brain settings');
});

test('hub --servers: only the named servers; an unknown name is an error', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  for (const n of ['a', 'b', 'c']) await run(env, f, 'add-mcp', n, '--', 'node', `${n}.mjs`);
  assert.deepEqual(Object.keys(hubServers(env, undefined, () => fakeProtector, ['a', 'c'])), ['a', 'c']);
  assert.throws(() => hubServers(env, undefined, () => fakeProtector, ['a', 'zz']), (e) => e instanceof MagnusError && /zz/.test(e.message));
});

test('magnus ask: runs the brain with the registry servers, prints the outcome, logs it', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  await run(env, f, 'add-mcp', 'xtraos', '--', 'node', 'x.mjs');
  const r = await run(env, f, 'ask', 'open', 'YouTube', '--brain', 'codex');
  assert.equal(r.code, 0);
  assert.match(r.out, /Asking Codex CLI \(servers: xtraos; up to 300 s\)/);
  assert.match(r.out, /Codex CLI: ok in 0\.0 s, 1 tool call\(s\)\n\nfake: done$/);
  assert.deepEqual(f.brainCalls[0]?.servers, ['xtraos']);
  assert.ok(f.brainCalls[0]?.prompt.endsWith('Task:\nopen YouTube'), 'flags are not part of the task');
  const log = fs.readFileSync(path.join(env.magnusHome, 'brain-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([log.length, log[0].task, log[0].brain, log[0].attempts[0].toolCalls], [1, 'open YouTube', 'codex', ['xtraos__status']]);

  await assert.rejects(run(env, f, 'ask', 'x', '--servers', 'nope'), (e) => e instanceof MagnusError && e.code === 'NOT_FOUND');
  await assert.rejects(run(env, f, 'ask', 'x', '--brain', 'gpt'), MagnusError);
});
