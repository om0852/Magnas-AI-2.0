import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { planTomlMcp } from '../src/plan-toml.js';
import { readJsonServers, readTomlServers } from '../src/read-servers.js';
import { loadRegistry } from '../src/registry.js';
import { resolveCommand, runServer } from '../src/run.js';
import { dpapiProtector, secretRefs } from '../src/secrets.js';
import { sync } from '../src/sync.js';
import { MagnusError, type Env } from '../src/types.js';
import { fakeHome, fakeProtector, fakes, run } from './helpers.js';

/** Every file under the fake home, as one text (to prove a value is nowhere). */
function allText(dir: string): string {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile())
    .map((d) => fs.readFileSync(path.join(d.parentPath, d.name), 'utf8'))
    .join('\n');
}

const vscodeFile = (env: Env): string => path.join(env.appData, 'Code', 'User', 'mcp.json');
const readJson = (file: string): Record<string, Record<string, unknown>> => JSON.parse(fs.readFileSync(file, 'utf8'));

test('toml reader: plain tables, env, quoting, multi-line lists; anything else is not plain', () => {
  const found = readTomlServers(
    [
      'model = "x"',
      '[mcp_servers.a]  # mine',
      'command = "C:\\\\tools\\\\a.exe"',
      "args = ['--x', \"y z\"]",
      '[mcp_servers.a.env]',
      'KEY = "v"',
      '"odd key" = \'w\'',
      '[mcp_servers."b-2"]',
      'command = "node"',
      'args = [',
      '  "one",   # first',
      '  "two",',
      ']',
      '[mcp_servers.builtin]',
      'command = "x"',
      'startup_timeout_sec = 30',
      '[mcp_servers.remote]',
      'url = "https://example.test/mcp"',
      '[other]',
      'command = "ignored"',
    ].join('\r\n'),
  );
  assert.deepEqual(found[0], { name: 'a', server: { command: 'C:\\tools\\a.exe', args: ['--x', 'y z'], env: { KEY: 'v', 'odd key': 'w' } } });
  assert.deepEqual(found[1], { name: 'b-2', server: { command: 'node', args: ['one', 'two'], env: {} } });
  assert.deepEqual(found.slice(2).map((f) => [f.name, f.server === undefined]), [['builtin', true], ['remote', true]]);

  const json = readJsonServers('{"mcpServers":{"ok":{"type":"stdio","command":"n"},"http":{"type":"http","url":"u"},"x":{"command":"n","timeout":5}}}', 'mcpServers');
  assert.deepEqual(json.map((f) => [f.name, f.server !== undefined]), [['ok', true], ['http', false], ['x', false]]);
});

test('toml plan: an identical table the user wrote is unchanged, not a conflict (ADR 0004)', () => {
  const cur = '[mcp_servers.a]\ncommand = "node"\nargs = ["a.mjs"]\n';
  const same = planTomlMcp(cur, { a: { command: 'node', args: ['a.mjs'], env: {} } });
  assert.deepEqual(same.ops, [{ name: 'a', op: 'unchanged' }]);
  assert.equal(same.text, null);
  assert.equal(planTomlMcp(cur, { a: { command: 'node', args: ['other.mjs'], env: {} } }).ops[0]?.op, 'conflict');
});

test('claude code: servers go through `claude mcp`, never by writing its file', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  await run(env, f, 'add-mcp', 'demo', '--', 'node', 'demo.mjs');
  await run(env, f, 'sync', '--apply', '--client', 'claude-code');
  assert.deepEqual(f.claudeCalls, [['mcp', 'add-json', 'demo', '{"type":"stdio","command":"node","args":["demo.mjs"],"env":{}}', '-s', 'user']]);
  assert.ok(!fs.existsSync(path.join(env.home, '.claude.json.magnus-backup')), 'Magnus did not write the file itself');

  await run(env, f, 'add-mcp', 'demo', '--', 'node', 'v2.mjs');
  f.claudeCalls.length = 0;
  const upd = await run(env, f, 'sync', '--apply', '--client', 'claude-code');
  assert.match(upd.out, /~ mcp {3}demo {2}update/);
  assert.deepEqual(f.claudeCalls.map((c) => c[1]), ['remove', 'add-json'], 'an update is a remove and an add');

  await run(env, f, 'remove-mcp', 'demo');
  f.claudeCalls.length = 0;
  await run(env, f, 'sync', '--apply', '--client', 'claude-code');
  assert.deepEqual(f.claudeCalls, [['mcp', 'remove', 'demo', '-s', 'user']]);
  assert.deepEqual(readJson(path.join(env.home, '.claude.json'))['mcpServers'], {});
});

test('claude code: a missing or failing `claude` is reported and nothing is marked as done', async () => {
  const env = fakeHome();
  const missing = fakes(env, { claude: 'missing' });
  await run(env, missing, 'init');
  await run(env, missing, 'add-mcp', 'demo', '--', 'node', 'demo.mjs');
  const r = await run(env, missing, 'sync', '--apply', '--client', 'claude-code');
  assert.equal(r.code, 2);
  assert.match(r.out, /\? mcp {3}demo {2}skip — the "claude" command was not found/);

  const failing = fakes(env, { claude: 'fails' });
  const r2 = await run(env, failing, 'sync', '--apply', '--client', 'claude-code');
  assert.match(r2.out, /skip — claude mcp failed: boom/);
  const ok = fakes(env);
  const r3 = await run(env, ok, 'sync', '--apply', '--client', 'claude-code');
  assert.match(r3.out, /\+ mcp {3}demo {2}add/, 'the failed add is tried again');
});

test('secrets: stored encrypted, never printed, and the tools get a launcher instead of the value', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  const reg = loadRegistry(env);
  reg.mcpServers['api'] = { command: 'node', args: ['api.mjs', '--key=${secret:API_KEY}'], env: { TOKEN: 'Bearer ${secret:API_KEY}', MODE: 'dev' } };
  fs.writeFileSync(path.join(env.magnusHome, 'magnus.json'), JSON.stringify(reg));
  assert.deepEqual(secretRefs(reg.mcpServers['api']), ['API_KEY']);

  await assert.rejects(run(env, f, 'sync'), (e) => e instanceof MagnusError && e.code === 'NO_SECRET' && /API_KEY/.test(e.message));

  f.typed.value = 'tok-12345-fake';
  const set = await run(env, f, 'secret', 'set', 'API_KEY');
  assert.ok(!set.out.includes('tok-12345-fake'));
  assert.equal((await run(env, f, 'secret', 'list')).out, 'API_KEY');
  await assert.rejects(run(env, f, 'secret', 'set', 'bad-name'), MagnusError);

  const res = await run(env, f, 'sync', '--apply');
  assert.equal(res.code, 0);
  assert.deepEqual(readJson(vscodeFile(env))['servers']?.['api'], { type: 'stdio', command: 'node', args: ['C:\\magnus\\cli.js', 'run', 'api'] });
  assert.match(fs.readFileSync(path.join(env.home, '.codex', 'config.toml'), 'utf8'), /args = \["C:\\\\magnus\\\\cli\.js", "run", "api"\]/);
  assert.ok(!allText(env.home).includes('tok-12345-fake'), 'the value is in no file: not the store, not any tool config');

  assert.equal((await run(env, f, 'secret', 'remove', 'API_KEY')).code, 0);
  assert.equal((await run(env, f, 'secret', 'list')).out, 'No secrets stored.');
});

test('run: starts the server with its secrets filled in', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  const reg = loadRegistry(env);
  reg.mcpServers['echo'] = {
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.TOKEN + "|" + process.argv[1])', 'arg-${secret:S1}'],
    env: { TOKEN: 'Bearer ${secret:S1}' },
  };
  fs.writeFileSync(path.join(env.magnusHome, 'magnus.json'), JSON.stringify(reg));
  f.typed.value = 'v@lue with spaces';
  await run(env, f, 'secret', 'set', 'S1');
  const r = await runServer(env, 'echo', { protector: () => fakeProtector, stdio: ['ignore', 'pipe', 'inherit'] });
  assert.deepEqual(r, { code: 0, stdout: 'Bearer v@lue with spaces|arg-v@lue with spaces' });
  assert.throws(() => runServer(env, 'nope', { protector: () => fakeProtector }), (e) => e instanceof MagnusError && e.code === 'NOT_FOUND');
});

test('run: finds a command on PATH with PATHEXT, as Windows does', () => {
  const env = fakeHome();
  const bin = path.join(env.home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tool.CMD'), '');
  fs.writeFileSync(path.join(bin, 'other.exe'), '');
  const p = [path.join(env.home, 'nowhere'), bin].join(path.delimiter);
  assert.equal(resolveCommand('tool', p, '.EXE;.CMD')?.toLowerCase(), path.join(bin, 'tool.cmd').toLowerCase());
  assert.equal(resolveCommand('other', p, '.EXE;.CMD'), path.join(bin, 'other.EXE'));
  assert.equal(resolveCommand(path.join(bin, 'other.exe'), '', '.EXE'), path.join(bin, 'other.exe'));
  assert.equal(resolveCommand('missing', p, '.EXE;.CMD'), null);
});

/** Tools that already hold servers and a skill, as on a PC that was set up by hand. */
function handMade(env: Env): void {
  fs.writeFileSync(vscodeFile(env), JSON.stringify({ servers: { files: { type: 'stdio', command: 'node', args: ['files.mjs'] }, web: { type: 'http', url: 'https://example.test' } } }));
  fs.writeFileSync(
    path.join(env.home, '.claude.json'),
    JSON.stringify({ numStartups: 3, mcpServers: { files: { type: 'stdio', command: 'node', args: ['files.mjs'], env: {} }, api: { type: 'stdio', command: 'node', args: ['api.mjs'], env: { API_TOKEN: 'tok-98765-fake' } } } }),
  );
  fs.writeFileSync(path.join(env.home, '.codex', 'config.toml'), 'model = "x"\n\n[mcp_servers.files]\ncommand = "node"\nargs = ["OTHER.mjs"]\n\n[mcp_servers.builtin]\ncommand = "b"\nstartup_timeout_sec = 5\n');
  const skill = path.join(env.home, '.claude', 'skills', 'review');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Review\n');
}

test('import: a dry run shows the plan; apply takes servers and skills over without conflicts', async () => {
  const env = fakeHome();
  const f = fakes(env);
  handMade(env);
  await run(env, f, 'init');

  const dry = await run(env, f, 'import');
  assert.match(dry.out, /Would import 3 item\(s\); 3 left where they are\. Nothing was written\./);
  assert.deepEqual(loadRegistry(env).mcpServers, {});

  const res = await run(env, f, 'import', '--apply');
  const lines = res.out.split('\n');
  assert.ok(lines.includes('  + mcp   files  import') && lines.includes('  + mcp   api  import') && lines.includes('  + skill review  import'));
  assert.ok(lines.some((l) => l.startsWith('  ! mcp   files  differs')), "Codex's different table is reported");
  assert.ok(lines.some((l) => l.startsWith('  ? mcp   builtin  skip')) && lines.some((l) => l.startsWith('  ? mcp   web  skip')));
  assert.match(res.out, /env values in plain text in magnus\.json: api/);
  const reg = loadRegistry(env);
  assert.deepEqual(reg.mcpServers['files'], { command: 'node', args: ['files.mjs'], env: {} });
  assert.deepEqual(reg.mcpServers['api']?.env, { API_TOKEN: 'tok-98765-fake' }, 'imported as it was');
  assert.ok(fs.existsSync(path.join(env.magnusHome, 'skills', 'review', 'SKILL.md')));

  const plan = sync(env, { apply: false, force: false }, f.deps.sync);
  const ops = plan.actions.map((a) => `${a.client} ${a.kind} ${a.name} ${a.op}`);
  assert.deepEqual(ops, [
    'claude-code mcp api unchanged',
    'claude-code mcp files unchanged',
    'claude-code skill review unchanged',
    'claude-code hooks settings.json add',
    'codex mcp api add',
    'codex mcp files conflict',
    'codex skill review add',
    'vscode mcp api add',
    'vscode mcp files unchanged',
  ]);
  assert.match((await run(env, f, 'import')).out, /Would import 0 item/, 'a second import finds nothing new');
});

test('import --secrets: env values become secrets and leave the tool configs on the next sync', async () => {
  const env = fakeHome();
  const f = fakes(env);
  handMade(env);
  await run(env, f, 'init');
  await run(env, f, 'import', '--secrets', '--apply');
  assert.deepEqual(loadRegistry(env).mcpServers['api']?.env, { API_TOKEN: '${secret:API_API_TOKEN}' });
  assert.equal((await run(env, f, 'secret', 'list')).out, 'API_API_TOKEN');
  assert.ok(!fs.readFileSync(path.join(env.magnusHome, 'magnus.json'), 'utf8').includes('tok-98765-fake'));

  const res = await run(env, f, 'sync', '--apply', '--client', 'claude-code', '--client', 'vscode');
  assert.match(res.out, /claude-code:\n {2}~ mcp {3}api {2}update/, 'the taken-over entry is replaced by the launcher');
  assert.deepEqual(readJson(path.join(env.home, '.claude.json'))['mcpServers']?.['api'], { type: 'stdio', command: 'node', args: ['C:\\magnus\\cli.js', 'run', 'api'], env: {} });
  assert.ok(!allText(env.home).includes('tok-98765-fake'), 'the token is gone from every file');
});

test('dpapi: a real round trip on Windows', { skip: process.platform !== 'win32' }, () => {
  const p = dpapiProtector();
  const blob = p.protect('fake value: ünïcode "quotes" \\ end');
  assert.ok(!blob.includes('fake value'));
  assert.deepEqual(p.unprotect([blob, p.protect('second')]), ['fake value: ünïcode "quotes" \\ end', 'second']);
});
