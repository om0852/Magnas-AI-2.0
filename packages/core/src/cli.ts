#!/usr/bin/env node
/** The `magnus` command: registry, sync, import, secrets, and the hub (stdio and HTTP). */
import { fileURLToPath } from 'node:url';
import {
  autostartOff,
  autostartOn,
  autostartStatus,
  fileLog,
  regRunList,
  relayLogFile,
  relayStartCommand,
  runningRelay,
  takeRelayLock,
  type AutostartState,
  type RunList,
} from './autostart.js';
import { ask, brainConfig, logAsk, realBrains, type BrainSet } from './brain/ask.js';
import { BRAIN_NAMES } from './brain/runners.js';
import { CLIENTS } from './clients/defs.js';
import { Bot } from './remote/bot.js';
import { loadRelay, RelayPc, relayAppUrl, relayInvite, relaySetup, removeRelayDevice } from './remote/relay-pc.js';
import { findXtraosCore, xtraosCaller } from './xtraos.js';
import { PHONE_SERVER, runPhoneMcp } from './remote/phone-mcp.js';
import { loadRemote, startPairing, TOKEN_SECRET, unpair, PAIR_MINUTES } from './remote/state.js';
import { Telegram } from './remote/telegram.js';
import { setClientMode } from './dashboard.js';
import { DEFAULT_PORT } from './hub/http.js';
import { keyHash, newKey } from './hub/key.js';
import { runHubStdio, startHubHttp } from './hub/start.js';
import { importFromTools } from './import.js';
import {
  RESERVED_NAMES,
  envFromProcess,
  initRegistry,
  listSkills,
  loadRegistry,
  registryFile,
  rulesText,
  saveRegistry,
  validName,
} from './registry.js';
import { runServer } from './run.js';
import { dpapiProtector, readSecrets, removeSecret, secretNames, secretRefs, setSecret, type Protector } from './secrets.js';
import { clientStatuses, defaultDeps, sync, type SyncDeps } from './sync.js';
import { MagnusError, type Action, type Env, type McpServer } from './types.js';

const HELP = `magnus — one hub for your MCP servers, skills and rules

  magnus init                         create the registry (~/.magnus)
  magnus status                       registry contents and installed AI tools
  magnus sync [--apply] [--force] [--client <id>]...
                                      show what would change; --apply writes it (with backups)
  magnus import [--client <id>]... [--secrets] [--apply]
                                      take the MCP servers and skills your tools already have
                                      into the registry; --secrets stores their env values as secrets
  magnus add-mcp <name> [--client <id>]... -- <command> [args...]
                                      register an MCP server
  magnus remove-mcp <name>            unregister it (the next sync removes it from the tools)
  magnus secret set <NAME>            store a secret (typed hidden, or piped in); use it in a
                                      server's env or args as \${secret:NAME}
  magnus secret list | remove <NAME>  names only; values are never shown
  magnus run <name>                   start a registered server with its secrets (used by the tools)
  magnus mode <tool> hub|direct       hub: the tool gets ONE entry (the Magnus hub) instead of every server
  magnus hub [--client <id>] [--servers a,b]
                                      the hub on stdin/stdout (what a hub-mode tool starts)
  magnus ask "<task>" [--brain codex|antigravity] [--servers a,b]
                                      do a task with an installed AI CLI and the brain's servers
  magnus remote pair | run | status | unpair
                                      control Magnus from your phone through your own Telegram bot
  magnus phone-mcp                    the phone tools as an MCP server (started by the hub)
  magnus relay setup <address> [--new] | pair | run [--log <file>] | devices | remove <id>
                                      your phone through your own encrypted relay (ADR 0010)
  magnus autostart on | off | status  start the relay connection and XtraOS when you sign in
  magnus key new | status             the Magnus key for the HTTP hub (shown once, never stored in plain)
  magnus serve [--port N]             the hub over HTTP on 127.0.0.1 (needs the key on every request)
`;

type Out = (line: string) => void;

/** What the commands need from outside; tests pass fakes. */
export interface CliDeps {
  /** The brains for `magnus ask`, given the servers they may use. */
  brains: (servers: readonly string[]) => BrainSet;
  sync: SyncDeps;
  protector: () => Protector;
  /** The secret value for `secret set` (hidden prompt or piped input). */
  readSecret: () => Promise<string>;
}

function valuesOf(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      const v = args[i + 1];
      if (v === undefined) throw new MagnusError('BAD_ARGS', `${flag} needs a value`);
      out.push(v);
      i++;
    }
  }
  return out;
}

function status(env: Env, out: Out): void {
  const reg = loadRegistry(env);
  const servers = Object.keys(reg.mcpServers).sort();
  out(`Registry: ${registryFile(env)}`);
  out(`  MCP servers (${servers.length}): ${servers.join(', ') || '-'}`);
  const skills = listSkills(env);
  out(`  Skills (${skills.length}): ${skills.join(', ') || '-'}`);
  out(`  Rules: ${rulesText(env) === '' ? '-' : `${rulesText(env).split('\n').length} line(s)`}`);
  out(`  Secrets: ${secretNames(env).length}`);
  out('AI tools:');
  for (const c of clientStatuses(env, reg)) {
    const state = !c.installed ? 'not installed' : c.enabled ? 'installed' : 'installed, switched off';
    const def = CLIENTS.find((d) => d.id === c.id);
    const covers = [def?.mcp ? 'MCP' : '', def?.skillsDir ? 'skills' : '', def?.rulesFile ? 'rules' : '']
      .filter((x) => x !== '')
      .join(' + ');
    const mode = reg.clients[c.id]?.mode === 'hub' ? '  [hub mode]' : '';
    out(`  ${c.id.padEnd(15)} ${state.padEnd(24)} ${covers}${mode}${c.note !== undefined ? `  (${c.note})` : ''}`);
  }
}

const SIGN: Record<Action['op'], string> = {
  add: '+',
  update: '~',
  remove: '-',
  unchanged: '=',
  conflict: '!',
  skip: '?',
};

function runSync(env: Env, args: string[], out: Out, deps: SyncDeps): number {
  const apply = args.includes('--apply');
  const only = valuesOf(args, '--client');
  const res = sync(env, { apply, force: args.includes('--force'), ...(only.length > 0 ? { only } : {}) }, deps);
  let client = '';
  for (const a of res.actions) {
    if (a.client !== client) {
      client = a.client;
      out(`${client}:`);
    }
    out(`  ${SIGN[a.op]} ${a.kind.padEnd(5)} ${a.name}${a.op === 'unchanged' ? '' : `  ${a.op}`}${a.detail !== undefined ? ` — ${a.detail}` : ''}`);
  }
  const count = (op: Action['op']): number => res.actions.filter((a) => a.op === op).length;
  const changes = count('add') + count('update') + count('remove');
  const problems = count('conflict') + count('skip');
  if (res.actions.length === 0) out('Nothing to sync: no installed AI tool, or the registry is empty.');
  out('');
  if (apply) {
    out(`Done: ${changes} change(s), ${problems} skipped.`);
    if (changes > 0) out('Restart the AI tools to load changed MCP servers.');
  } else {
    out(`Plan: ${changes} change(s), ${count('unchanged')} unchanged, ${problems} skipped. Nothing was written.`);
    if (changes > 0) out('Run "magnus sync --apply" to write it.');
  }
  return problems > 0 ? 2 : 0;
}

function runImport(env: Env, args: string[], out: Out, deps: CliDeps): number {
  const apply = args.includes('--apply');
  const only = valuesOf(args, '--client');
  const items = importFromTools(env, {
    apply,
    secrets: args.includes('--secrets'),
    protector: deps.protector,
    ...(only.length > 0 ? { only } : {}),
  });
  const sign = { import: '+', exists: '=', differs: '!', skip: '?' } as const;
  let from = '';
  for (const i of items) {
    if (i.from !== from) {
      from = i.from;
      out(`${from}:`);
    }
    out(`  ${sign[i.op]} ${i.kind.padEnd(5)} ${i.name}${i.op === 'exists' ? '' : `  ${i.op}`}${i.detail !== undefined ? ` — ${i.detail}` : ''}`);
  }
  const n = items.filter((i) => i.op === 'import').length;
  const left = items.filter((i) => i.op === 'differs' || i.op === 'skip').length;
  if (items.length === 0) out('Nothing found in the installed AI tools.');
  out('');
  out(
    apply
      ? `Imported ${n} item(s) into the registry; ${left} left where they are.`
      : `Would import ${n} item(s); ${left} left where they are. Nothing was written.`,
  );
  if (!apply && n > 0) out('Run "magnus import --apply" to take them over.');
  if (apply && n > 0) out('Run "magnus sync" to see what the other tools get.');
  if (apply && !args.includes('--secrets')) {
    const plain = Object.entries(loadRegistry(env).mcpServers)
      .filter(([, s]) => Object.keys(s.env).length > 0 && secretRefs(s).length === 0)
      .map(([name]) => name);
    if (plain.length > 0) {
      out(`These servers have env values in plain text in magnus.json: ${plain.join(', ')}.`);
      out('If one is a token: "magnus secret set NAME", then write ${secret:NAME} in its place.');
    }
  }
  return 0;
}

async function secret(env: Env, args: string[], out: Out, deps: CliDeps): Promise<number> {
  const [sub, name] = args;
  if (sub === 'list') {
    const names = secretNames(env);
    out(names.length > 0 ? names.join('\n') : 'No secrets stored.');
    return 0;
  }
  if (name === undefined || (sub !== 'set' && sub !== 'remove')) {
    throw new MagnusError('BAD_ARGS', 'usage: magnus secret set <NAME> | list | remove <NAME>');
  }
  if (sub === 'remove') {
    if (!removeSecret(env, name)) throw new MagnusError('NOT_FOUND', `no secret "${name}"`);
    out(`Removed secret ${name}.`);
    return 0;
  }
  setSecret(env, deps.protector(), name, await deps.readSecret());
  out(`Stored secret ${name}. Use it as \${secret:${name}} in a server's env or args.`);
  return 0;
}

function addMcp(env: Env, args: string[], out: Out): void {
  const sep = args.indexOf('--');
  const name = args[0];
  if (name === undefined || sep < 1 || args[sep + 1] === undefined) {
    throw new MagnusError('BAD_ARGS', 'usage: magnus add-mcp <name> [--client <id>]... -- <command> [args...]');
  }
  if (!validName(name)) throw new MagnusError('BAD_ARGS', `name "${name}": use letters, digits, _ and - (1-64)`);
  if (RESERVED_NAMES.includes(name)) throw new MagnusError('BAD_ARGS', `the name "${name}" is reserved for Magnus`);
  const reg = loadRegistry(env);
  const clients = valuesOf(args.slice(1, sep), '--client');
  const server: McpServer = { command: args[sep + 1] as string, args: args.slice(sep + 2), env: {} };
  if (clients.length > 0) server.clients = clients;
  const existed = Object.hasOwn(reg.mcpServers, name);
  reg.mcpServers[name] = server;
  saveRegistry(env, reg);
  out(`${existed ? 'Updated' : 'Added'} MCP server "${name}". Run "magnus sync" to see what changes in your AI tools.`);
}

function removeMcp(env: Env, args: string[], out: Out): void {
  const name = args[0];
  if (name === undefined) throw new MagnusError('BAD_ARGS', 'usage: magnus remove-mcp <name>');
  const reg = loadRegistry(env);
  if (!Object.hasOwn(reg.mcpServers, name)) throw new MagnusError('NOT_FOUND', `no MCP server "${name}" in the registry`);
  delete reg.mcpServers[name];
  saveRegistry(env, reg);
  out(`Removed "${name}" from the registry. Run "magnus sync --apply" to remove it from your AI tools.`);
}

function setMode(env: Env, args: string[], out: Out): void {
  const [id, mode] = args;
  if (id === undefined || (mode !== 'hub' && mode !== 'direct')) throw new MagnusError('BAD_ARGS', 'usage: magnus mode <tool> hub|direct');
  setClientMode(env, id, mode);
  out(`${id} is now in ${mode} mode. Run "magnus sync" to see what changes in it.`);
}

function key(env: Env, args: string[], out: Out): void {
  if (args[0] === 'status') {
    out(keyHash(env) === null ? 'No Magnus key yet. Run: magnus key new' : 'A Magnus key is set (it cannot be shown again; "magnus key new" replaces it).');
  } else if (args[0] === 'new') {
    const replaced = keyHash(env) !== null;
    out(newKey(env));
    out(`${replaced ? 'This replaces the old key. ' : ''}Shown once: keep it somewhere safe. Use it as "Authorization: Bearer <key>".`);
  } else throw new MagnusError('BAD_ARGS', 'usage: magnus key new | status');
}

async function serve(env: Env, args: string[], out: Out, deps: CliDeps): Promise<number> {
  const raw = valuesOf(args, '--port')[0];
  const port = raw === undefined ? DEFAULT_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new MagnusError('BAD_ARGS', `bad port "${raw ?? ''}"`);
  const hub = await startHubHttp(env, port, deps.protector);
  out(`Magnus hub: ${hub.url} (this PC only; every request needs the Magnus key). Ctrl+C stops it.`);
  await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
  await hub.close();
  return 0;
}

async function runAsk(env: Env, args: string[], out: Out, deps: CliDeps): Promise<number> {
  const flags = new Set(['--brain', '--servers']);
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (flags.has(args[i] as string)) i++;
    else words.push(args[i] as string);
  }
  const task = words.join(' ');
  const cfg = brainConfig(env);
  const brain = valuesOf(args, '--brain')[0];
  if (brain !== undefined) {
    if (brain !== 'codex' && brain !== 'antigravity') throw new MagnusError('BAD_ARGS', '--brain is codex or antigravity');
    cfg.order = [brain];
  }
  const servers = valuesOf(args, '--servers')[0];
  if (servers !== undefined) cfg.servers = servers.split(',').filter((s) => s !== '');
  const reg = loadRegistry(env);
  const unknown = cfg.servers.filter((s) => s !== PHONE_SERVER && !Object.hasOwn(reg.mcpServers, s));
  if (unknown.length > 0) throw new MagnusError('NOT_FOUND', `not in the registry: ${unknown.join(', ')}`, 'See: magnus status');
  out(`Asking ${cfg.order.map((b) => BRAIN_NAMES[b]).join(', then ')} (servers: ${cfg.servers.join(', ')}; up to ${cfg.timeoutSec} s)...`);
  const ctl = new AbortController();
  const onInt = (): void => ctl.abort();
  process.once('SIGINT', onInt);
  const icon: Record<string, string> = { thinking: '…', tool: '→', 'tool-done': '✓', 'tool-failed': '✗', say: '»', note: '·' };
  const res = await ask(task, cfg, deps.brains(cfg.servers), {
    signal: ctl.signal,
    onProgress: (p) => out(`  ${(p.ms / 1000).toFixed(0).padStart(3)}s ${icon[p.kind] ?? '·'} ${p.text}`),
  }).finally(() => process.off('SIGINT', onInt));
  logAsk(env, task, res);
  for (const a of res.attempts) {
    const t = a.run ? ` in ${(a.run.ms / 1000).toFixed(1)} s${a.run.callsKnown ? `, ${a.run.toolCalls.length} tool call(s)` : ''}` : '';
    out(`  ${BRAIN_NAMES[a.brain]}: ${a.outcome}${t}`);
  }
  if (res.stoppedBecause !== undefined) out(`  No other brain was tried: ${res.stoppedBecause}.`);
  out('');
  out(res.answer);
  return res.ok ? 0 : 1;
}

/** The bot token from the secret store, checked against Telegram. */
async function bot(env: Env, deps: CliDeps): Promise<{ telegram: Telegram; username: string }> {
  if (!secretNames(env).includes(TOKEN_SECRET)) {
    throw new MagnusError('NO_SECRET', 'no Telegram bot token yet', `Make a bot with @BotFather in Telegram, then run: magnus secret set ${TOKEN_SECRET}`);
  }
  const token = readSecrets(env, deps.protector(), [TOKEN_SECRET]).get(TOKEN_SECRET) ?? '';
  const telegram = new Telegram(token);
  const me = await telegram.getMe();
  return { telegram, username: me.username ?? me.first_name ?? 'your bot' };
}

async function remote(env: Env, args: string[], out: Out, deps: CliDeps): Promise<number> {
  const sub = args[0];
  if (sub === 'status') {
    const s = loadRemote(env);
    out(s.owner ? `Paired with Telegram user ${s.owner.name ?? s.owner.userId} since ${s.owner.pairedAt.slice(0, 10)}.` : 'No phone is paired. Run: magnus remote pair');
    out(secretNames(env).includes(TOKEN_SECRET) ? 'Bot token: stored (encrypted).' : `Bot token: not set (magnus secret set ${TOKEN_SECRET}).`);
    return 0;
  }
  if (sub === 'unpair') {
    out(unpair(env) ? 'Unpaired. The bot now ignores everyone until you pair again.' : 'No phone was paired.');
    return 0;
  }
  if (sub === 'pair') {
    const { username } = await bot(env, deps);
    const code = startPairing(env);
    out(`In Telegram, open @${username} and send:  /pair ${code}`);
    out(`The code works for ${PAIR_MINUTES} minutes, while "magnus remote run" is running.`);
    if (loadRemote(env).owner) out('This replaces the phone paired now once the new one pairs.');
    return 0;
  }
  if (sub === 'run') {
    const { telegram, username } = await bot(env, deps);
    const cfg = brainConfig(env);
    const servers = [...cfg.servers.filter((s) => s !== PHONE_SERVER), PHONE_SERVER];
    const b = new Bot(env, {
      telegram,
      runTask: (task) => ask(task, { ...cfg, servers }, deps.brains(servers)).then((res) => {
        logAsk(env, task, res);
        return res;
      }),
      log: (l) => out(`${new Date().toISOString().slice(11, 19)} ${l}`),
      startedAt: Math.floor(Date.now() / 1000),
    });
    let stopping = false;
    process.once('SIGINT', () => {
      stopping = true;
      out('Stopping after the current wait...');
    });
    const owner = loadRemote(env).owner;
    out(`Magnus remote is running as @${username}. ${owner ? `Paired with ${owner.name ?? owner.userId}.` : 'No phone paired yet: run "magnus remote pair" in another terminal.'} Ctrl+C stops it.`);
    await b.run(() => stopping);
    return 0;
  }
  throw new MagnusError('BAD_ARGS', 'usage: magnus remote pair | run | status | unpair');
}

async function relayCmd(env: Env, args: string[], out: Out, deps: CliDeps): Promise<number> {
  const sub = args[0];
  if (sub === 'setup') {
    const addr = args[1];
    if (addr === undefined || addr.startsWith('--')) throw new MagnusError('BAD_ARGS', 'usage: magnus relay setup <relay address> [--new]');
    const c = await relaySetup(env, deps.protector, addr, args.includes('--new'));
    out(`Relay set: ${relayAppUrl(c.url)} (room ${c.room.slice(0, 6)}…).`);
    out('Next: "magnus relay run" (keep it running), then "magnus relay pair" and scan the code on your phone.');
    return 0;
  }
  if (sub === 'pair') {
    const { link, expiresAt } = relayInvite(env, deps.protector);
    out('Open this on your phone (or scan the QR code on the PC dashboard). It works once, for 10 minutes:');
    out(link);
    out(`(valid until ${new Date(expiresAt).toLocaleTimeString()}; "magnus relay run" must be running)`);
    return 0;
  }
  if (sub === 'devices') {
    const c = loadRelay(env);
    if (!c) throw new MagnusError('NO_RELAY', 'the relay is not set up', 'Run: magnus relay setup <relay address>');
    out(`Relay: ${relayAppUrl(c.url)}`);
    out(c.devices.length === 0 ? 'No phone paired.' : c.devices.map((d) => `  ${d.id}  ${d.name}  paired ${d.created.slice(0, 10)}${d.approverId ? '  answers approvals' : ''}`).join('\n'));
    return 0;
  }
  if (sub === 'remove') {
    const d = args[1] === undefined ? null : removeRelayDevice(env, args[1]);
    if (!d) throw new MagnusError('NOT_FOUND', 'no such device', 'See: magnus relay devices');
    if (d.approverId !== undefined) await xtraosCaller()('approvers.remove', { id: d.approverId }).catch(() => out('Could not remove it from XtraOS approvers; do it there.'));
    out(`Removed ${d.name}.`);
    return 0;
  }
  if (sub === 'run') {
    // ADR 0011: one relay connection at a time (the sign-in start and a manual one must not race).
    if (!takeRelayLock(env)) {
      out(`The relay connection is already running (process ${runningRelay(env)}).`);
      return 0;
    }
    const logFile = valuesOf(args, '--log')[0];
    const say: Out = logFile !== undefined ? fileLog(logFile) : (l) => out(`${new Date().toISOString().slice(11, 19)} ${l}`);
    const cfg = brainConfig(env);
    const pc = new RelayPc(env, {
      protector: deps.protector,
      log: say,
      rpc: {
        xtraos: xtraosCaller(),
        ask: async (task, opts) => {
          const res = await ask(task, cfg, deps.brains(cfg.servers), opts);
          logAsk(env, task, res);
          return { ok: res.ok, answer: res.answer, brain: res.brain };
        },
      },
    });
    await pc.start();
    say('Magnus is reachable from your paired phones. Ctrl+C stops it.');
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    });
    pc.stop();
    return 0;
  }
  throw new MagnusError('BAD_ARGS', 'usage: magnus relay setup <address> [--new] | pair | run [--log <file>] | devices | remove <id>');
}

async function autostartCmd(env: Env, args: string[], out: Out, list: RunList = regRunList()): Promise<number> {
  const sub = args[0] ?? 'status';
  const show = (s: AutostartState): void => {
    out(`Relay connection at sign-in: ${s.relay !== null ? 'on' : 'off'}`);
    out(`XtraOS at sign-in:           ${s.xtraos !== null ? 'on' : 'off'}`);
    const pid = runningRelay(env);
    out(`Relay connection now:        ${pid !== null ? `running (process ${pid})` : 'not running'}`);
  };
  if (sub === 'status') {
    show(autostartStatus(list));
    return 0;
  }
  if (sub === 'on') {
    if (!loadRelay(env)) throw new MagnusError('NO_RELAY', 'the relay is not set up', 'Run: magnus relay setup <relay address>');
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
    const s = autostartOn(list, relayStartCommand(process.execPath, cli, relayLogFile(env)), findXtraosCore());
    show(s);
    out(`The relay connection logs to ${relayLogFile(env)}. Sign out and in (or restart) to check, or start it now with "magnus relay run".`);
    return 0;
  }
  if (sub === 'off') {
    show(autostartOff(list));
    out('Nothing starts at sign-in any more. A relay connection running now keeps running until you close it or sign out.');
    return 0;
  }
  throw new MagnusError('BAD_ARGS', 'usage: magnus autostart on | off | status');
}

/** Runs one command; returns the exit code (a promise for the commands that wait). */
export function main(argv: string[], env: Env, out: Out, deps: CliDeps = realDeps(env, false)): number | Promise<number> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'init':
      out(initRegistry(env) ? `Created ${registryFile(env)}` : `Already there: ${registryFile(env)}`);
      return 0;
    case 'status':
      status(env, out);
      return 0;
    case 'sync':
      return runSync(env, args, out, deps.sync);
    case 'import':
      return runImport(env, args, out, deps);
    case 'secret':
      return secret(env, args, out, deps);
    case 'run': {
      if (args[0] === undefined) throw new MagnusError('BAD_ARGS', 'usage: magnus run <name>');
      return runServer(env, args[0], { protector: deps.protector }).then((r) => r.code);
    }
    case 'mode':
      setMode(env, args, out);
      return 0;
    case 'hub': {
      const only = valuesOf(args, '--servers')[0]?.split(',').filter((s) => s !== '');
      return runHubStdio(env, valuesOf(args, '--client')[0], deps.protector, undefined, only);
    }
    case 'ask':
      return runAsk(env, args, out, deps);
    case 'remote':
      return remote(env, args, out, deps);
    case 'relay':
      return relayCmd(env, args, out, deps);
    case 'autostart':
      return autostartCmd(env, args, out);
    case 'phone-mcp':
      return runPhoneMcp(env, deps.protector);
    case 'key':
      key(env, args, out);
      return 0;
    case 'serve':
      return serve(env, args, out, deps);
    case 'add-mcp':
      addMcp(env, args, out);
      return 0;
    case 'remove-mcp':
      removeMcp(env, args, out);
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(HELP);
      return 0;
    default:
      throw new MagnusError('BAD_ARGS', `unknown command "${cmd}"`, 'Run: magnus help');
  }
}

/** Reads a secret: everything piped in, or one line typed without echo. */
function readSecretFromStdin(): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let buf = '';
    if (!stdin.isTTY) {
      stdin.setEncoding('utf8');
      stdin.on('data', (d: string) => (buf += d));
      stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
      stdin.on('error', reject);
      return;
    }
    process.stderr.write('Value (hidden): ');
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const onData = (d: string): void => {
      for (const ch of d) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(buf));
        if (ch === '\u0003') return done(() => reject(new MagnusError('CANCELLED', 'cancelled')));
        if (ch === '\u0008' || ch === '\u007f') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    const done = (fn: () => void): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      fn();
    };
    stdin.on('data', onData);
  });
}

/** `searchPath`: also look for `claude` on PATH (the real program only; tests never do). */
export function realDeps(env: Env, searchPath: boolean): CliDeps {
  const sync = defaultDeps(env, searchPath);
  const hub = { command: sync.self.command, args: sync.self.args };
  return { sync, protector: dpapiProtector, readSecret: readSecretFromStdin, brains: (servers) => realBrains(env, hub, servers) };
}

// Run only as a program, not when imported by tests.
if (process.argv[1] !== undefined && /cli\.js$/.test(process.argv[1])) {
  const fail = (e: unknown): void => {
    if (!(e instanceof MagnusError)) throw e;
    console.error(`magnus: ${e.message}${e.hint !== '' ? `\n${e.hint}` : ''}`);
    process.exitCode = 1;
  };
  try {
    const env = envFromProcess();
    const code = main(process.argv.slice(2), env, (l) => console.log(l), realDeps(env, true));
    if (typeof code === 'number') process.exitCode = code;
    else code.then((c) => (process.exitCode = c), fail);
  } catch (e) {
    fail(e);
  }
}
