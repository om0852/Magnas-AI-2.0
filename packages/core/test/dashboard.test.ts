import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkDashboardRequest, dashboardState, setClientMode } from '../src/dashboard.js';
import { loadRegistry } from '../src/registry.js';
import { MagnusError } from '../src/types.js';
import { fakeHome, fakes, run } from './helpers.js';

test('dashboard state: names and counts only; no env value or secret reaches the browser', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  const reg = loadRegistry(env);
  reg.mcpServers['api'] = { command: ['C:', 'Program Files', 'node', 'node.exe'].join(String.fromCharCode(92)), args: ['api.mjs', '--key=plain-arg-value'], env: { TOKEN: '${secret:API_KEY}', URL: 'https://plain.example/value' }, clients: ['codex'] };
  reg.mcpServers['files'] = { command: 'npx', args: [], env: {} };
  fs.writeFileSync(path.join(env.magnusHome, 'magnus.json'), JSON.stringify(reg));
  f.typed.value = 'tok-secret-value';
  await run(env, f, 'secret', 'set', 'API_KEY');
  fs.writeFileSync(path.join(env.magnusHome, 'rules', 'a.md'), 'one\ntwo\n');
  setClientMode(env, 'codex', 'hub');

  const s = dashboardState(env);
  assert.deepEqual(s.servers, [
    { name: 'api', command: 'node.exe', argCount: 2, envKeys: ['TOKEN', 'URL'], usesSecrets: true, clients: ['codex'] },
    { name: 'files', command: 'npx', argCount: 0, envKeys: [], usesSecrets: false, clients: null },
  ]);
  assert.deepEqual([s.rulesLines, s.secrets, s.skills], [2, ['API_KEY'], []]);
  const codex = s.tools.find((t) => t.id === 'codex');
  assert.deepEqual([codex?.installed, codex?.mode, codex?.gets], [true, 'hub', ['MCP', 'skills', 'rules']]);
  assert.equal(s.tools.find((t) => t.id === 'cursor')?.installed, false);
  const sent = JSON.stringify(s);
  for (const hidden of ['tok-secret-value', 'plain.example', 'plain-arg-value', 'Program Files']) assert.ok(!sent.includes(hidden), hidden);

  setClientMode(env, 'codex', 'direct');
  assert.equal(dashboardState(env).tools.find((t) => t.id === 'codex')?.mode, 'direct');
  assert.throws(() => setClientMode(env, 'nope', 'hub'), MagnusError);
});

test('dashboard guard: loopback host, the run token, and its own origin for changes', () => {
  const ok = { method: 'GET', host: '127.0.0.1:4747', origin: null, token: 'tok' };
  const check = (over: object) => checkDashboardRequest({ ...ok, ...over }, 4747, 'tok')?.status ?? 0;
  assert.equal(check({}), 0);
  assert.equal(check({ host: 'localhost:4747' }), 0);
  assert.equal(check({ host: 'evil.example:4747' }), 403, 'DNS rebinding');
  assert.equal(check({ host: '127.0.0.1:9999' }), 403);
  assert.equal(check({ host: null }), 403);
  assert.equal(check({ token: null }), 401);
  assert.equal(check({ token: 'tok2' }), 401);
  assert.equal(check({ method: 'POST' }), 403, 'a change needs an Origin');
  assert.equal(check({ method: 'POST', origin: 'https://evil.example' }), 403, 'another web page');
  assert.equal(check({ method: 'POST', origin: 'http://127.0.0.1:4747' }), 0);
  assert.equal(check({ method: 'POST', origin: 'http://localhost:4747' }), 0);
  assert.equal(checkDashboardRequest(ok, 4747, '')?.status, 401, 'no token configured: nothing is allowed');
});
