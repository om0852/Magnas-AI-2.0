import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planJsonMcp, type JsonShape } from '../src/plan-json.js';
import { planRules } from '../src/plan-rules.js';
import { planTomlMcp } from '../src/plan-toml.js';
import type { McpServer } from '../src/types.js';

const STD: JsonShape = { key: 'mcpServers', stdioType: false };
const A: McpServer = { command: 'node', args: ['a.mjs'], env: {} };
const B: McpServer = { command: 'C:\\tools\\b.exe', args: ['--x', 'y z'], env: { MODE: 'dev' } };
const opsOf = (ops: { name: string; op: string }[]): string => ops.map((o) => `${o.name}:${o.op}`).join(' ');

test('json: adds to a missing file and keeps other keys of an existing one', () => {
  const fresh = planJsonMcp(null, { a: A }, [], STD, false);
  assert.deepEqual(JSON.parse(fresh.text ?? ''), { mcpServers: { a: { command: 'node', args: ['a.mjs'] } } });

  const cur = JSON.stringify({ theme: 'dark', mcpServers: { mine: { command: 'x' } } });
  const p = planJsonMcp(cur, { a: A, b: B }, [], STD, false);
  const out = JSON.parse(p.text ?? '');
  assert.equal(out.theme, 'dark');
  assert.deepEqual(out.mcpServers.mine, { command: 'x' }, "the user's own server is untouched");
  assert.deepEqual(out.mcpServers.b, { command: 'C:\\tools\\b.exe', args: ['--x', 'y z'], env: { MODE: 'dev' } });
  assert.equal(opsOf(p.ops), 'a:add b:add');
  assert.deepEqual(p.managed, ['a', 'b']);
});

test('json: an equal entry is adopted, a different one is a conflict unless managed or forced', () => {
  const cur = JSON.stringify({ mcpServers: { a: { type: 'stdio', command: 'node', args: ['a.mjs'] }, b: { command: 'other' } } });
  const p = planJsonMcp(cur, { a: A, b: B }, [], STD, false);
  assert.equal(opsOf(p.ops), 'a:unchanged b:conflict');
  assert.equal(p.text, null, 'nothing to write');
  assert.deepEqual(p.managed, ['a'], 'the equal entry is managed from now on, the conflict is not');

  assert.equal(opsOf(planJsonMcp(cur, { b: B }, ['b'], STD, false).ops), 'b:update', 'Magnus wrote it before');
  assert.equal(opsOf(planJsonMcp(cur, { b: B }, [], STD, true).ops), 'b:update', '--force');
});

test('json: removes only what Magnus wrote and is idempotent', () => {
  const first = planJsonMcp(null, { a: A, b: B }, [], STD, false);
  const again = planJsonMcp(first.text, { a: A, b: B }, first.managed, STD, false);
  assert.equal(again.text, null);
  assert.equal(opsOf(again.ops), 'a:unchanged b:unchanged');

  const withMine = JSON.stringify({ mcpServers: { ...JSON.parse(first.text ?? '').mcpServers, mine: { command: 'x' } } });
  const p = planJsonMcp(withMine, { a: A }, ['a', 'b'], STD, false);
  assert.equal(opsOf(p.ops), 'a:unchanged b:remove');
  assert.deepEqual(Object.keys(JSON.parse(p.text ?? '').mcpServers).sort(), ['a', 'mine']);
});

test('json: VS Code shape, and a file that is not plain JSON is left alone', () => {
  const p = planJsonMcp('{"servers":{}}', { a: A }, [], { key: 'servers', stdioType: true }, false);
  assert.deepEqual(JSON.parse(p.text ?? '').servers.a, { type: 'stdio', command: 'node', args: ['a.mjs'] });

  const bad = planJsonMcp('{ // comment\n "mcpServers": {} }', { a: A }, [], STD, false);
  assert.equal(bad.text, null);
  assert.equal(opsOf(bad.ops), 'a:skip');
  assert.equal(opsOf(planJsonMcp('{"mcpServers": []}', { a: A }, [], STD, false).ops), 'a:skip');
});

test('toml: appends one managed block and leaves the rest byte for byte', () => {
  const cur = 'model = "x"\r\n\r\n[mcp_servers.mine]\r\ncommand = "m"\r\n';
  const p = planTomlMcp(cur, { a: A, b: B });
  assert.equal(opsOf(p.ops), 'a:add b:add');
  const text = p.text ?? '';
  assert.ok(text.startsWith(cur.trimEnd()), 'the user part is unchanged');
  assert.ok(!/[^\r]\n/.test(text), 'CRLF kept everywhere');
  assert.ok(text.includes('[mcp_servers.b]\r\ncommand = "C:\\\\tools\\\\b.exe"\r\nargs = ["--x", "y z"]'));
  assert.ok(text.includes('[mcp_servers.b.env]\r\nMODE = "dev"'));

  const again = planTomlMcp(text, { a: A, b: B });
  assert.equal(again.text, null, 'idempotent');
  assert.equal(opsOf(again.ops), 'a:unchanged b:unchanged');
});

test('toml: update, remove, and removing the last server removes the block', () => {
  const first = planTomlMcp('x = 1\n', { a: A, b: B }).text ?? '';
  const p = planTomlMcp(first, { a: { ...A, args: ['new.mjs'] } });
  assert.equal(opsOf(p.ops), 'a:update b:remove');
  assert.ok((p.text ?? '').includes('args = ["new.mjs"]'));
  assert.ok(!(p.text ?? '').includes('mcp_servers.b'));

  const none = planTomlMcp(first, {});
  assert.equal(none.text, 'x = 1\n', 'back to the original file');
});

test('toml: a table the user wrote with the same name is a conflict and is not duplicated', () => {
  const cur = '[mcp_servers.a]\ncommand = "theirs"\n\n[mcp_servers.a.env]\nK = "v"\n';
  const p = planTomlMcp(cur, { a: A, b: B });
  assert.equal(opsOf(p.ops), 'a:conflict b:add');
  assert.equal((p.text ?? '').match(/\[mcp_servers\.a\]/g)?.length, 1);
  assert.deepEqual(p.managed, ['b']);

  const broken = planTomlMcp('# >>> magnus\n[mcp_servers.a]\n', { a: A });
  assert.equal(opsOf(broken.ops), 'a:skip', 'a block without its end marker is left alone');
  assert.equal(broken.text, null);
});

test('rules: one managed block; the user text around it stays', () => {
  const add = planRules('# My rules\n\nBe brief.\n', 'Rule one.\n\nRule two.');
  assert.equal(add.op, 'add');
  const text = add.text ?? '';
  assert.ok(text.startsWith('# My rules\n\nBe brief.\n\n<!-- >>> magnus rules'));
  assert.ok(text.endsWith('Rule two.\n<!-- <<< magnus rules -->\n'));

  assert.equal(planRules(text, 'Rule one.\n\nRule two.').op, 'unchanged');
  assert.equal(planRules(text, 'Rule one.\n\nRule two.').text, null);

  const edited = text + '\nMore of mine.\n';
  const upd = planRules(edited, 'Rule three.');
  assert.equal(upd.op, 'update');
  assert.ok((upd.text ?? '').includes('Rule three.') && !(upd.text ?? '').includes('Rule one.'));
  assert.ok((upd.text ?? '').startsWith('# My rules') && (upd.text ?? '').trimEnd().endsWith('More of mine.'));

  const gone = planRules(edited, '');
  assert.equal(gone.op, 'remove');
  assert.equal(gone.text, '# My rules\n\nBe brief.\n\nMore of mine.\n');
  assert.equal(planRules(null, '').op, 'unchanged');
  assert.equal(planRules(null, 'R.').text, '<!-- >>> magnus rules (managed: edit ~/.magnus/rules, then run "magnus sync") -->\nR.\n<!-- <<< magnus rules -->\n');
});
