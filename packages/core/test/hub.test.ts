import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { Gateway, makeHubServer, STATUS_TOOL, TIMING, type Connect } from '../src/hub/gateway.js';
import { checkRequest } from '../src/hub/http.js';
import { keyHash, keyMatches, newKey } from '../src/hub/key.js';
import { hubServers, startHubHttp } from '../src/hub/start.js';
import { loadRegistry } from '../src/registry.js';
import { sync } from '../src/sync.js';
import { MagnusError, type McpServer } from '../src/types.js';
import { fakeHome, fakeProtector, fakes, run } from './helpers.js';

const S: McpServer = { command: 'x', args: [], env: {} };
const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? '');

/** An in-memory MCP server with one tool, and a client connected to it. */
async function fakeServer(name: string, tool: string, instructions?: string): Promise<Client> {
  const server = new Server({ name, version: '1' }, { capabilities: { tools: {} }, ...(instructions !== undefined ? { instructions } : {}) });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: tool, description: `${name} ${tool}`, inputSchema: { type: 'object', properties: { n: { type: 'number' } } } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({ content: [{ type: 'text', text: `${name}.${req.params.name}(${JSON.stringify(req.params.arguments ?? {})})` }] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return client;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const connect: Connect = async (name) => {
  if (name === 'broken') throw new Error('cannot start');
  if (name === 'late') await sleep(400);
  if (name === 'slow') return new Promise(() => {});
  return fakeServer(name, name === 'files' ? 'read' : 'click', name === 'desk' ? 'Observe before you click.' : undefined);
};

test('gateway: tools are named <server>__<tool>, calls are routed, results pass through', async () => {
  const g = new Gateway({ files: S, desk: S }, connect);
  const tools = await g.listTools();
  assert.deepEqual(tools.map((t) => t.name), [STATUS_TOOL, 'desk__click', 'files__read']);
  assert.equal(tools[1]?.description, 'desk click');
  assert.deepEqual(tools[1]?.inputSchema, { type: 'object', properties: { n: { type: 'number' } } }, 'the schema is unchanged');
  assert.equal(textOf(await g.callTool('desk__click', { n: 2 })), 'desk.click({"n":2})');
  assert.equal(textOf(await g.callTool('files__read', undefined)), 'files.read({})');
  for (const bad of ['nope__x', 'desk__nope', 'noseparator', '__click']) {
    const r = await g.callTool(bad, {});
    assert.equal(r.isError, true, bad);
    assert.match(textOf(r), /unknown tool/);
  }
  assert.match(await g.instructions(), /## desk \(tools: desk__…\)\nObserve before you click\./);
  assert.ok(!(await g.instructions()).includes('## files'), 'a server without instructions adds nothing');
  await g.close();
});

test('gateway: a server that fails or hangs is reported; the others still work', async () => {
  const logs: string[] = [];
  const g = new Gateway({ files: S, broken: S, slow: S }, connect, (l) => logs.push(l), { ...TIMING, startMs: 200 });
  assert.deepEqual((await g.listTools()).map((t) => t.name), [STATUS_TOOL, 'files__read']);
  const status = textOf(await g.callTool(STATUS_TOOL, {}));
  assert.match(status, /^broken: NOT AVAILABLE — cannot start\nfiles: 1 tool\(s\)\nslow: NOT AVAILABLE — server "slow" did not answer within 0\.2 s$/);
  assert.equal(logs.length, 2);
  assert.equal(textOf(await g.callTool('files__read', {})), 'files.read({})');
});

test('gateway: answers at once; a slow server adds its tools when it is up and the client is told', async () => {
  const g = new Gateway({ files: S, late: S }, connect, () => {}, { startMs: 5000, listMs: 100, instructionsMs: 50 });
  const server = await makeHubServer(g, '0.0.0');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  let told = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => void told++);
  await client.connect(b);

  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), [STATUS_TOOL, 'files__read'], 'the list does not wait for the slow one');
  assert.match(textOf(await client.callTool({ name: STATUS_TOOL, arguments: {} })), /late: starting…/);
  assert.equal(textOf(await client.callTool({ name: 'late__click', arguments: {} })), 'late.click({})', 'a call for a starting server waits for it');
  await sleep(50);
  assert.ok(told >= 1, 'tools/list_changed was sent');
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), [STATUS_TOOL, 'files__read', 'late__click']);
  await g.close();
});

test('hub servers: only the tool\'s servers, secrets decrypted once for all of them', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  const reg = loadRegistry(env);
  reg.mcpServers['a'] = { command: 'node', args: ['--k=${secret:K1}'], env: { T: '${secret:K2}' } };
  reg.mcpServers['b'] = { command: 'node', args: [], env: { T: '${secret:K1}' }, clients: ['codex'] };
  fs.writeFileSync(path.join(env.magnusHome, 'magnus.json'), JSON.stringify(reg));
  for (const [name, value] of [['K1', 'one'], ['K2', 'two']] as const) {
    f.typed.value = value;
    await run(env, f, 'secret', 'set', name);
  }
  let decrypts = 0;
  const counting = () => ({ ...fakeProtector, unprotect: (b: readonly string[]) => (decrypts++, fakeProtector.unprotect(b)) });
  assert.deepEqual(hubServers(env, 'codex', counting), {
    a: { command: 'node', args: ['--k=one'], env: { T: 'two' } },
    b: { command: 'node', args: [], env: { T: 'one' } },
  });
  assert.equal(decrypts, 1, 'one decryption for the whole hub');
  assert.deepEqual(Object.keys(hubServers(env, 'vscode', counting)), ['a']);
});

test('key: shown once, only its hash is stored, a new one replaces it', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  assert.match((await run(env, f, 'key', 'status')).out, /No Magnus key yet/);
  const key = (await run(env, f, 'key', 'new')).out.split('\n')[0] ?? '';
  assert.match(key, /^mgn_[A-Za-z0-9_-]{43}$/);
  assert.ok(!fs.readFileSync(path.join(env.magnusHome, 'hub.json'), 'utf8').includes(key));
  const hash = keyHash(env) ?? '';
  assert.ok(keyMatches(hash, key) && !keyMatches(hash, key + 'x') && !keyMatches(hash, ''));
  const second = (await run(env, f, 'key', 'new')).out;
  assert.match(second, /replaces the old key/);
  assert.ok(!keyMatches(keyHash(env) ?? '', key), 'the old key no longer works');
});

test('http: refuses web pages, other hosts, other paths and a wrong key (pure)', () => {
  const env = fakeHome();
  const key = newKey(env);
  const hash = keyHash(env) ?? '';
  const req = (h: Record<string, string>, url = '/mcp') => checkRequest({ url, headers: { host: '127.0.0.1:8787', authorization: `Bearer ${key}`, ...h } }, hash, 8787);
  assert.equal(req({}), null);
  assert.equal(req({ host: 'localhost:8787' }), null);
  assert.equal(req({ origin: 'https://evil.example' })?.status, 403);
  assert.equal(req({ host: 'evil.example:8787' })?.status, 403);
  assert.equal(req({ host: '127.0.0.1:9999' })?.status, 403);
  assert.equal(req({}, '/other')?.status, 404);
  assert.equal(req({ authorization: 'Bearer mgn_wrong' })?.status, 401);
  assert.equal(req({ authorization: '' })?.status, 401);
});

test('http: a real round trip with the key; without it, 401', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  await run(env, f, 'add-mcp', 'desk', '--', 'x');
  await assert.rejects(startHubHttp(env, 0, () => fakeProtector, connect), (e) => e instanceof MagnusError && e.code === 'NO_KEY');
  const key = newKey(env);
  const hub = await startHubHttp(env, 0, () => fakeProtector, connect);
  try {
    const noKey = await fetch(hub.url, { method: 'POST', body: '{}' });
    assert.equal(noKey.status, 401);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(hub.url), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), [STATUS_TOOL, 'magnus__task_start', 'magnus__task_update', 'magnus__task_done', 'magnus__ask_user', 'desk__click'], 'the task tools come with every hub');
    assert.equal(textOf(await client.callTool({ name: 'desk__click', arguments: { n: 1 } })), 'desk.click({"n":1})');
    assert.match(client.getInstructions() ?? '', /Magnus hub/);
    await client.close();
  } finally {
    await hub.close();
  }
});

test('hub server over a transport: instructions and tools reach an MCP client', async () => {
  const g = new Gateway({ desk: S }, connect);
  const server = await makeHubServer(g, '0.0.0');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  assert.equal(client.getServerVersion()?.name, 'magnus');
  assert.match(client.getInstructions() ?? '', /Observe before you click/);
  assert.equal(textOf(await client.callTool({ name: STATUS_TOOL, arguments: {} })), 'desk: 1 tool(s)');
});

test('end to end: `magnus hub` as a real process in front of two real MCP servers', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  const fixture = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'echo-server.mjs');
  const reg = loadRegistry(env);
  reg.mcpServers['one'] = { command: process.execPath, args: [fixture], env: { ECHO_LABEL: 'first' } };
  reg.mcpServers['two'] = { command: process.execPath, args: [fixture], env: { ECHO_LABEL: 'second' }, clients: ['codex'] };
  reg.mcpServers['dead'] = { command: process.execPath, args: ['-e', 'process.exit(3)'], env: {} };
  fs.writeFileSync(path.join(env.magnusHome, 'magnus.json'), JSON.stringify(reg));

  const cli = path.resolve(import.meta.dirname, '..', 'src', 'cli.js');
  const vars: Record<string, string> = { MAGNUS_HOME: env.magnusHome };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'MAGNUS_HOME') vars[k] = v;
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'hub', '--client', 'codex'], env: vars, stderr: 'ignore' }));
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), [STATUS_TOOL, 'magnus__task_start', 'magnus__task_update', 'magnus__task_done', 'magnus__ask_user', 'one__say', 'two__say']);
    assert.equal(textOf(await client.callTool({ name: 'one__say', arguments: { text: 'hi' } })), 'first: hi');
    assert.equal(textOf(await client.callTool({ name: 'two__say', arguments: { text: 'yo' } })), 'second: yo');
    assert.match(textOf(await client.callTool({ name: STATUS_TOOL, arguments: {} })), /^dead: NOT AVAILABLE — .+\none: 1 tool\(s\)\ntwo: 1 tool\(s\)$/);
    assert.match(client.getInstructions() ?? '', /## one \(tools: one__…\)\nUse say to echo \(first\)\./);
  } finally {
    await client.close();
  }
});

test('sync in hub mode: the tool gets one entry and loses the direct ones Magnus wrote', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  await run(env, f, 'add-mcp', 'a', '--', 'node', 'a.mjs');
  await run(env, f, 'add-mcp', 'b', '--', 'node', 'b.mjs');
  await run(env, f, 'sync', '--apply');
  const vscode = path.join(env.appData, 'Code', 'User', 'mcp.json');
  const toml = path.join(env.home, '.codex', 'config.toml');

  assert.match((await run(env, f, 'mode', 'vscode', 'hub')).out, /vscode is now in hub mode/);
  await run(env, f, 'mode', 'codex', 'hub');
  assert.match((await run(env, f, 'status')).out, /vscode .*\[hub mode\]/);
  const res = sync(env, { apply: true, force: false, only: ['vscode', 'codex'] }, f.deps.sync);
  assert.deepEqual(res.actions.filter((a) => a.kind === 'mcp').map((a) => `${a.client} ${a.name} ${a.op}`), [
    'codex magnus add', 'codex a remove', 'codex b remove',
    'vscode magnus add', 'vscode a remove', 'vscode b remove',
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(vscode, 'utf8')).servers, {
    mine: { command: 'm' },
    magnus: { type: 'stdio', command: 'node', args: ['C:\\magnus\\cli.js', 'hub', '--client', 'vscode'] },
  });
  const text = fs.readFileSync(toml, 'utf8');
  assert.ok(text.includes('[mcp_servers.magnus]') && text.includes('"hub", "--client", "codex"') && !text.includes('mcp_servers.a]'));

  await run(env, f, 'mode', 'vscode', 'direct');
  const back = sync(env, { apply: true, force: false, only: ['vscode'] }, f.deps.sync);
  assert.deepEqual(back.actions.map((a) => `${a.name} ${a.op}`), ['a add', 'b add', 'magnus remove']);

  await assert.rejects(run(env, f, 'add-mcp', 'magnus', '--', 'x'), MagnusError);
  await assert.rejects(run(env, f, 'mode', 'nope', 'hub'), (e) => e instanceof MagnusError && e.code === 'UNKNOWN_CLIENT');
});
