import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MARKER } from '../src/skills.js';
import { sync } from '../src/sync.js';
import { MagnusError, type Env } from '../src/types.js';
import { fakeHome, fakes, run, type Fakes } from './helpers.js';

async function seed(env: Env, f: Fakes): Promise<void> {
  await run(env, f, 'init');
  await run(env, f, 'add-mcp', 'demo', '--', 'node', 'demo.mjs');
  const skill = path.join(env.magnusHome, 'skills', 'review');
  fs.mkdirSync(path.join(skill, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Review\n');
  fs.writeFileSync(path.join(skill, 'refs', 'a.md'), 'a\n');
  fs.writeFileSync(path.join(env.magnusHome, 'rules', '10-style.md'), 'Be brief.\n');
}

test('sync: a dry run writes nothing; apply writes MCP servers, skills and rules with backups', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await seed(env, f);
  const toml = path.join(env.home, '.codex', 'config.toml');
  const vscode = path.join(env.appData, 'Code', 'User', 'mcp.json');
  const claudeMd = path.join(env.home, '.claude', 'CLAUDE.md');

  const dry = await run(env, f, 'sync');
  assert.equal(dry.code, 0);
  assert.match(dry.out, /Nothing was written/);
  assert.equal(fs.readFileSync(toml, 'utf8'), 'model = "x"\n');
  assert.ok(!fs.existsSync(path.join(env.home, '.codex', 'skills', 'review')));
  assert.ok(!fs.existsSync(path.join(env.magnusHome, 'state.json')));
  assert.deepEqual(f.claudeCalls, [], 'a dry run does not call claude');

  const res = sync(env, { apply: true, force: false }, f.deps.sync);
  assert.deepEqual(
    res.actions.map((a) => `${a.client} ${a.kind} ${a.name} ${a.op}`),
    [
      'claude-code mcp demo add',
      'claude-code skill review add',
      'claude-code hooks settings.json add',
      'claude-code rules CLAUDE.md add',
      'codex mcp demo add',
      'codex skill review add',
      'codex rules AGENTS.md add',
      'vscode mcp demo add',
    ],
    'only installed tools, in a fixed order',
  );
  assert.match(fs.readFileSync(toml, 'utf8'), /^model = "x"\n\n# >>> magnus[^\n]*\n\[mcp_servers\.demo\]\ncommand = "node"\nargs = \["demo\.mjs"\]\n# <<< magnus\n$/);
  assert.equal(fs.readFileSync(`${toml}.magnus-backup`, 'utf8'), 'model = "x"\n');
  const servers = JSON.parse(fs.readFileSync(vscode, 'utf8')).servers;
  assert.deepEqual(servers, { mine: { command: 'm' }, demo: { type: 'stdio', command: 'node', args: ['demo.mjs'] } });
  assert.ok(fs.existsSync(path.join(env.home, '.codex', 'skills', 'review', 'refs', 'a.md')));
  assert.ok(fs.existsSync(path.join(env.home, '.claude', 'skills', 'review', MARKER)));
  assert.match(fs.readFileSync(claudeMd, 'utf8'), /^# Mine\n\n<!-- >>> magnus rules[^\n]*\nBe brief\.\n<!-- <<< magnus rules -->\n$/);
  assert.match(fs.readFileSync(path.join(env.home, '.codex', 'AGENTS.md'), 'utf8'), /Be brief\./);

  const again = sync(env, { apply: true, force: false }, f.deps.sync);
  assert.ok(again.actions.every((a) => a.op === 'unchanged'), 'a second sync changes nothing');
  assert.deepEqual(again.written, []);
});

test("sync: changes and removals follow the registry; the user's own things are never touched", async () => {
  const env = fakeHome();
  const f = fakes(env);
  await seed(env, f);
  // The user already has a skill called "review" in Claude Code.
  const own = path.join(env.home, '.claude', 'skills', 'review');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), 'my own\n');

  const first = await run(env, f, 'sync', '--apply');
  assert.equal(first.code, 2, 'a conflict gives exit code 2');
  assert.match(first.out, /! skill review {2}conflict/);
  assert.equal(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), 'my own\n');

  // Edit the skill, drop the server and the rules.
  fs.writeFileSync(path.join(env.magnusHome, 'skills', 'review', 'SKILL.md'), '# Review v2\n');
  await run(env, f, 'remove-mcp', 'demo');
  fs.rmSync(path.join(env.magnusHome, 'rules', '10-style.md'));
  const res = sync(env, { apply: true, force: false }, f.deps.sync);
  const ops = res.actions.map((a) => `${a.client} ${a.kind} ${a.name} ${a.op}`);
  assert.ok(ops.includes('codex skill review update'));
  assert.ok(ops.includes('codex mcp demo remove'));
  assert.ok(ops.includes('vscode mcp demo remove'));
  assert.ok(ops.includes('claude-code mcp demo remove'));
  assert.ok(ops.includes('codex rules AGENTS.md remove'));
  assert.equal(fs.readFileSync(path.join(env.home, '.codex', 'skills', 'review', 'SKILL.md'), 'utf8'), '# Review v2\n');
  assert.equal(fs.readFileSync(path.join(env.home, '.codex', 'config.toml'), 'utf8'), 'model = "x"\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.appData, 'Code', 'User', 'mcp.json'), 'utf8')).servers, { mine: { command: 'm' } });
  assert.equal(fs.readFileSync(path.join(env.home, '.claude', 'CLAUDE.md'), 'utf8'), '# Mine\n');

  // The skill leaves the registry: the managed copy goes, the user's own stays.
  fs.rmSync(path.join(env.magnusHome, 'skills', 'review'), { recursive: true });
  sync(env, { apply: true, force: false }, f.deps.sync);
  assert.ok(!fs.existsSync(path.join(env.home, '.codex', 'skills', 'review')));
  assert.ok(fs.existsSync(path.join(own, 'SKILL.md')));
});

test('sync: per-server tools, a switched-off tool, --client, and clear errors', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  await run(env, f, 'add-mcp', 'only-code', '--client', 'vscode', '--', 'node', 'x.mjs');
  const res = sync(env, { apply: false, force: false }, f.deps.sync);
  assert.deepEqual(res.actions.map((a) => `${a.client} ${a.name}`), ['claude-code settings.json', 'vscode only-code']);

  const reg = JSON.parse(fs.readFileSync(path.join(env.magnusHome, 'magnus.json'), 'utf8'));
  reg.clients = { vscode: { enabled: false }, 'claude-code': { hooks: false } }; // hooks: false opts out of the Claude Code hooks
  fs.writeFileSync(path.join(env.magnusHome, 'magnus.json'), JSON.stringify(reg));
  assert.deepEqual(sync(env, { apply: false, force: false }, f.deps.sync).actions, []);
  assert.match((await run(env, f, 'status')).out, /vscode\s+installed, switched off/);
  assert.match((await run(env, f, 'status')).out, /cursor\s+not installed/);

  assert.throws(() => sync(env, { apply: false, force: false, only: ['nope'] }, f.deps.sync), (e) => e instanceof MagnusError && e.code === 'UNKNOWN_CLIENT');
  await assert.rejects(run(env, f, 'add-mcp', 'bad name', '--', 'x'), MagnusError);
  const empty = fakeHome();
  await assert.rejects(run(empty, fakes(empty), 'sync'), (e) => e instanceof MagnusError && e.code === 'NO_REGISTRY');
});
