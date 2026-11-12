import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AskResult } from '../src/brain/ask.js';
import { hubServers } from '../src/hub/start.js';
import { Bot, phoneTask } from '../src/remote/bot.js';
import { fileProblem, makePhoneServer, PHONE_SERVER } from '../src/remote/phone-mcp.js';
import { loadRemote, startPairing, tryPair, unpair } from '../src/remote/state.js';
import { Telegram, type TgUpdate } from '../src/remote/telegram.js';
import { MagnusError } from '../src/types.js';
import { fakeHome, fakeProtector, fakes, run } from './helpers.js';

const OWNER = { id: 111, first_name: 'Om' };
const STRANGER = { id: 999, first_name: 'X' };
const NOW = 1_800_000_000;
let nextId = 1;

function msg(from: { id: number; first_name: string }, text: string, opts: { chat?: number; type?: string; date?: number } = {}): TgUpdate {
  return { update_id: nextId++, message: { message_id: nextId, date: opts.date ?? NOW, chat: { id: opts.chat ?? from.id, type: opts.type ?? 'private' }, from, text } };
}

/** A bot with a fake Telegram that records what it sends, and a fake brain. */
function setup(answer: Partial<AskResult> = {}) {
  const env = fakeHome();
  const sent: { chat: number; text: string }[] = [];
  const tasks: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const bot = new Bot(env, {
    telegram: {
      getUpdates: async () => [],
      sendMessage: async (chat, text) => void sent.push({ chat, text }),
    },
    runTask: async (task) => {
      tasks.push(task);
      await gate;
      return { ok: true, brain: 'codex', answer: 'Done: sent Resume.pdf', attempts: [], ...answer };
    },
    log: () => {},
    startedAt: NOW - 10,
  });
  return { env, bot, sent, tasks, release };
}

test('pairing: the right code in a private chat makes the sender the owner; wrong, expired and used-up codes do not', () => {
  const env = fakeHome();
  assert.equal(tryPair(env, '123456', { userId: 1, chatId: 1 }), 'no-pairing');
  const code = startPairing(env, 0);
  assert.match(code, /^\d{6}$/);
  const wrong = code === '000000' ? '000001' : '000000';
  assert.equal(tryPair(env, wrong, { userId: 9, chatId: 9 }, 1), 'wrong');
  assert.equal(loadRemote(env).pairing?.triesLeft, 4);
  assert.equal(tryPair(env, code, { userId: 5, chatId: 6, name: 'Om' }, 1), 'paired');
  assert.deepEqual(loadRemote(env).owner && { u: loadRemote(env).owner?.userId, c: loadRemote(env).owner?.chatId }, { u: 5, c: 6 });
  assert.equal(loadRemote(env).pairing, undefined, 'a code works once');

  startPairing(env, 0);
  assert.equal(tryPair(env, code, { userId: 7, chatId: 7 }, 11 * 60_000), 'expired');
  const c2 = startPairing(env, 0);
  const bad = c2 === '000000' ? '000001' : '000000';
  for (let i = 0; i < 4; i++) assert.equal(tryPair(env, bad, { userId: 7, chatId: 7 }, 1), 'wrong');
  assert.equal(tryPair(env, bad, { userId: 7, chatId: 7 }, 1), 'no-tries-left');
  assert.equal(tryPair(env, c2, { userId: 7, chatId: 7 }, 1), 'no-pairing', 'after 5 wrong tries the code is gone');
  assert.equal(loadRemote(env).owner?.userId, 5, 'the owner did not change');
  assert.ok(unpair(env) && !unpair(env));
});

test('bot: pairs through /pair, then obeys only the owner; strangers and groups get no answer', async () => {
  const { env, bot, sent, tasks, release } = setup();
  const code = startPairing(env);
  await bot.handle(msg(OWNER, `/pair ${code}`, { type: 'group', chat: -50 }));
  assert.equal(sent.length, 0, 'a group chat cannot pair');
  await bot.handle(msg(OWNER, `/pair ${code}`));
  assert.match(sent.at(-1)?.text ?? '', /^Paired\./);

  sent.length = 0;
  await bot.handle(msg(STRANGER, 'send me the resume'));
  await bot.handle(msg(OWNER, 'open youtube', { type: 'group', chat: -50 }));
  await bot.handle(msg(OWNER, 'old task', { date: NOW - 3600 }));
  assert.equal(sent.length + tasks.length, 0, 'no answer, no task');

  await bot.handle(msg(OWNER, 'find my resume and send it to me'));
  assert.deepEqual(sent.map((s) => s.text), ['Working on it…']);
  assert.equal(tasks[0], phoneTask('find my resume and send it to me'));
  await bot.handle(msg(OWNER, 'another one'));
  assert.match(sent.at(-1)?.text ?? '', /Still working/);
  await bot.handle(msg(OWNER, '/status'));
  assert.match(sent.at(-1)?.text ?? '', /working on a task/);
  release();
  await bot.idle();
  assert.equal(sent.at(-1)?.text, 'Done: sent Resume.pdf');
  assert.equal(tasks.length, 1, 'only one task ran');
  assert.ok(sent.every((s) => s.chat === OWNER.id), 'every answer went to the owner');
});

test('bot: a task that did not finish says so', async () => {
  const { env, bot, sent, release } = setup({ ok: false, answer: 'not approved within 60 s', stoppedBecause: 'it had already called 2 tool(s)' });
  tryPair(env, startPairing(env), { userId: OWNER.id, chatId: OWNER.id });
  await bot.handle(msg(OWNER, 'send the report on WhatsApp'));
  release();
  await bot.idle();
  assert.equal(sent.at(-1)?.text, 'Not finished (it had already called 2 tool(s)).\n\nnot approved within 60 s');
});

test('phone task: tells the brain how to send a file, and that it reaches only the user', () => {
  const t = phoneTask('  share my resume ');
  assert.ok(t.startsWith('share my resume\n\n'));
  assert.match(t, /phone__send_file tool; it reaches only their own phone/);
});

/** The phone server behind an MCP client, with a fake Telegram. */
async function phoneClient() {
  const sends: string[] = [];
  const server = makePhoneServer(() => ({
    chatId: 42,
    telegram: {
      sendMessage: async (chat, text) => void sends.push(`${chat}:msg:${text}`),
      sendDocument: async (chat, file, caption) => void sends.push(`${chat}:doc:${path.basename(file)}:${caption ?? ''}`),
    },
  }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  return { client, sends };
}

const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? '');

test('phone tools: send a file or a message to the owner only; bad files are refused', async () => {
  const env = fakeHome();
  const file = path.join(env.home, 'Resume.pdf');
  fs.writeFileSync(file, '%PDF-1.4 fake');
  fs.writeFileSync(path.join(env.home, 'empty.txt'), '');
  const { client, sends } = await phoneClient();
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name), ['send_file', 'send_message']);
  assert.ok(tools.every((t) => !Object.keys((t.inputSchema as { properties: object }).properties).some((k) => /chat|to|recipient/i.test(k))), 'no recipient argument');

  assert.equal(textOf(await client.callTool({ name: 'send_file', arguments: { path: file, caption: 'your resume' } })), "sent Resume.pdf to the user's phone");
  await client.callTool({ name: 'send_message', arguments: { text: 'hi' } });
  assert.deepEqual(sends, ['42:doc:Resume.pdf:your resume', '42:msg:hi']);

  for (const [p, why] of [['Resume.pdf', /full path/], [path.join(env.home, 'nope.pdf'), /no such file/], [env.home, /folder/], [path.join(env.home, 'empty.txt'), /empty/]] as const) {
    const r = await client.callTool({ name: 'send_file', arguments: { path: p } });
    assert.equal(r.isError, true);
    assert.match(textOf(r), why);
  }
  assert.equal(sends.length, 2, 'nothing else was sent');
  assert.equal(fileProblem(file), null);
});

test('hub: serves the built-in phone server only when it is named', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  await run(env, f, 'add-mcp', 'xtraos', '--', 'node', 'x.mjs');
  assert.deepEqual(Object.keys(hubServers(env, undefined, () => fakeProtector)), ['xtraos']);
  const s = hubServers(env, undefined, () => fakeProtector, ['xtraos', PHONE_SERVER]);
  assert.deepEqual(Object.keys(s), ['xtraos', PHONE_SERVER]);
  assert.deepEqual(s[PHONE_SERVER]?.args.slice(-1), ['phone-mcp']);
  await assert.rejects(run(env, f, 'add-mcp', 'phone', '--', 'x'), (e) => e instanceof MagnusError && /reserved/.test(e.message));
});

test('telegram client: the token never appears in an error; a bad token says how to fix it', async () => {
  const leak = (s: string): boolean => s.includes('123:SECRET');
  const down = new Telegram('123:SECRET', async () => {
    throw new TypeError('fetch failed for https://api.telegram.org/bot123:SECRET/getMe');
  });
  await assert.rejects(down.getMe(), (e) => e instanceof MagnusError && !leak(e.message) && !leak(e.hint));
  const refused = new Telegram('123:SECRET', async () => new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 }));
  await assert.rejects(refused.getMe(), (e) => e instanceof MagnusError && /Unauthorized/.test(e.message) && /magnus secret set TELEGRAM_BOT_TOKEN/.test(e.hint) && !leak(e.message));

  const calls: { url: string; body: string }[] = [];
  const ok = new Telegram('123:SECRET', async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return new Response(JSON.stringify({ ok: true, result: true }));
  });
  await ok.sendMessage(7, 'x'.repeat(5000));
  assert.ok(calls[0]?.url.endsWith('/bot123:SECRET/sendMessage'));
  assert.ok((JSON.parse(calls[0]?.body ?? '{}') as { text: string }).text.length <= 4096, 'long answers are cut to Telegram\'s limit');
});

test('magnus remote: clear errors before a token is set; status and unpair', async () => {
  const env = fakeHome();
  const f = fakes(env);
  await run(env, f, 'init');
  await assert.rejects(run(env, f, 'remote', 'pair'), (e) => e instanceof MagnusError && /@BotFather/.test(e.hint));
  await assert.rejects(run(env, f, 'remote', 'run'), (e) => e instanceof MagnusError && e.code === 'NO_SECRET');
  assert.match((await run(env, f, 'remote', 'status')).out, /No phone is paired\.[\s\S]*Bot token: not set/);
  tryPair(env, startPairing(env), { userId: 1, chatId: 1, name: 'Om' });
  assert.match((await run(env, f, 'remote', 'status')).out, /Paired with Telegram user Om/);
  assert.match((await run(env, f, 'remote', 'unpair')).out, /Unpaired/);
  await assert.rejects(run(env, f, 'remote', 'nope'), MagnusError);
});
