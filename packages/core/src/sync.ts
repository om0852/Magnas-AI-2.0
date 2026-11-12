/** `magnus sync`: plan (and with `apply`, write) MCP servers, skills and rules for every installed tool. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addArgs, findClaude, removeArgs, type ClaudeLookup } from './claude.js';
import { CLIENTS, type ClientDef } from './clients/defs.js';
import { planJsonMcp } from './plan-json.js';
import { planRules } from './plan-rules.js';
import { planTomlMcp } from './plan-toml.js';
import { HUB_NAME, listSkills, loadRegistry, rulesText } from './registry.js';
import { secretNames, secretRefs } from './secrets.js';
import { applySkills, planSkills } from './skills.js';
import { MagnusError, type Action, type Env, type ItemOp, type McpServer, type Registry } from './types.js';

export interface SyncOptions {
  apply: boolean;
  force: boolean;
  /** Only these tool ids; undefined = all installed. */
  only?: readonly string[];
}

/** The outside world sync needs; tests pass their own. */
export interface SyncDeps {
  /** How a tool starts `magnus` (for servers that use secrets): command and leading args. */
  self: { command: string; args: string[] };
  claude: ClaudeLookup;
}

export interface ClientStatus {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  note?: string;
}

export interface SyncResult {
  actions: Action[];
  clients: ClientStatus[];
  /** Files written (apply only). */
  written: string[];
}

export interface State {
  version: 1;
  clients: Record<string, { mcp: string[]; skills: string[] }>;
}

function stateFile(env: Env): string {
  return path.join(env.magnusHome, 'state.json');
}

/** What Magnus wrote where (empty when there is no state yet). */
export function loadState(env: Env): State {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(env), 'utf8')) as State;
    if (raw.version === 1 && typeof raw.clients === 'object' && raw.clients !== null) return raw;
  } catch {
    // No state yet (or unreadable): Magnus manages nothing so far.
  }
  return { version: 1, clients: {} };
}

export function saveState(env: Env, state: State): void {
  fs.mkdirSync(env.magnusHome, { recursive: true });
  fs.writeFileSync(stateFile(env), JSON.stringify(state, null, 2) + '\n');
}

export function readText(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** Backup once, then write through a temporary file. */
function writeSafe(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.magnus-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const tmp = `${file}.magnus-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Which tools exist on this PC and whether the registry switched them off. */
export function clientStatuses(env: Env, reg: Registry | null): ClientStatus[] {
  return CLIENTS.map((c) => ({
    id: c.id,
    name: c.name,
    installed: fs.existsSync(c.detect(env)),
    enabled: reg?.clients[c.id]?.enabled !== false,
    ...(c.note !== undefined ? { note: c.note } : {}),
  }));
}

/** The defaults for a real run: this install of Magnus, and Claude Code's native install. */
export function defaultDeps(env: Env, searchPath: boolean): SyncDeps {
  return depsWithCli(env, fileURLToPath(new URL('./cli.js', import.meta.url)), searchPath);
}

/** As `defaultDeps`, for a caller that knows where the `magnus` command is (a bundled app cannot locate it). */
export function depsWithCli(env: Env, cliPath: string, searchPath: boolean): SyncDeps {
  return { self: { command: process.execPath, args: [cliPath] }, claude: findClaude(env, searchPath) };
}

/**
 * What a tool's config gets for a server: the server itself, or (when it uses secrets) a
 * launcher `magnus run <name>`, so the secret is in no tool's config (ADR 0004).
 */
export function entryFor(name: string, s: McpServer, self: SyncDeps['self']): McpServer {
  if (secretRefs(s).length === 0) return { command: s.command, args: s.args, env: s.env };
  return { command: self.command, args: [...self.args, 'run', name], env: {} };
}

function serversFor(reg: Registry, clientId: string, self: SyncDeps['self']): Record<string, McpServer> {
  // Hub mode (ADR 0005): the tool gets one entry that starts the gateway for it.
  if (reg.clients[clientId]?.mode === 'hub') {
    return { [HUB_NAME]: { command: self.command, args: [...self.args, 'hub', '--client', clientId], env: {} } };
  }
  const out: Record<string, McpServer> = {};
  for (const [name, s] of Object.entries(reg.mcpServers)) {
    if (s.clients === undefined || s.clients.includes(clientId)) out[name] = entryFor(name, s, self);
  }
  return out;
}

const CHANGES: readonly string[] = ['add', 'update', 'remove'];

export function sync(env: Env, opts: SyncOptions, deps: SyncDeps = defaultDeps(env, false)): SyncResult {
  const reg = loadRegistry(env);
  const known = CLIENTS.map((c) => c.id);
  for (const id of opts.only ?? []) {
    if (!known.includes(id)) {
      throw new MagnusError('UNKNOWN_CLIENT', `unknown tool "${id}"`, `Known: ${known.join(', ')}`);
    }
  }
  // A server whose secret is not set would not start: stop before anything is written.
  const have = secretNames(env);
  for (const [name, s] of Object.entries(reg.mcpServers)) {
    const missing = secretRefs(s).filter((n) => !have.includes(n));
    if (missing.length > 0) {
      throw new MagnusError('NO_SECRET', `server "${name}" needs the secret ${missing.join(', ')}`, `Run: magnus secret set ${missing[0] ?? ''}`);
    }
  }
  const state = loadState(env);
  const skills = listSkills(env);
  const rules = rulesText(env);
  const skillsSource = path.join(env.magnusHome, 'skills');
  const statuses = clientStatuses(env, reg);
  const actions: Action[] = [];
  const written: string[] = [];

  const add = (c: ClientDef, kind: Action['kind'], ops: readonly ItemOp[]): void => {
    for (const o of ops) actions.push({ client: c.id, kind, ...o });
  };

  for (const c of CLIENTS) {
    const st = statuses.find((s) => s.id === c.id);
    if (!st?.installed || !st.enabled) continue;
    if (opts.only !== undefined && !opts.only.includes(c.id)) continue;
    const mine = state.clients[c.id] ?? { mcp: [], skills: [] };

    if (c.mcp) {
      const file = c.mcp.file(env);
      const wanted = serversFor(reg, c.id, deps.self);
      if (c.mcp.format === 'claude-cli') {
        const plan = planJsonMcp(readText(file), wanted, mine.mcp, { key: 'mcpServers', stdioType: true }, opts.force);
        const claude = deps.claude;
        const ops = plan.ops.map((o): ItemOp => {
          if (!CHANGES.includes(o.op)) return o;
          if ('reason' in claude) return { name: o.name, op: 'skip', detail: claude.reason };
          if (!opts.apply) return o;
          // Through Claude Code's own command; an update is a remove and an add.
          let r = o.op === 'add' ? { ok: true, message: '' } : claude.runner(removeArgs(o.name));
          if (r.ok && o.op !== 'remove') r = claude.runner(addArgs(o.name, wanted[o.name] as McpServer));
          return r.ok ? o : { name: o.name, op: 'skip', detail: `claude mcp failed: ${r.message}` };
        });
        add(c, 'mcp', ops);
        if (opts.apply) {
          const failed = ops.filter((o) => o.op === 'skip').map((o) => o.name);
          // A failed add is not managed; a failed remove still is.
          mine.mcp = [...plan.managed.filter((n) => !failed.includes(n)), ...mine.mcp.filter((n) => failed.includes(n) && !(n in wanted))];
        }
      } else {
        const plan =
          c.mcp.format === 'json'
            ? planJsonMcp(readText(file), wanted, mine.mcp, c.mcp.shape, opts.force)
            : planTomlMcp(readText(file), wanted);
        add(c, 'mcp', plan.ops);
        if (opts.apply) {
          if (plan.text !== null) {
            writeSafe(file, plan.text);
            written.push(file);
          }
          mine.mcp = plan.managed;
        }
      }
    }

    if (c.skillsDir) {
      const dir = c.skillsDir(env);
      const ops = planSkills(skillsSource, dir, skills, mine.skills);
      add(c, 'skill', ops);
      if (opts.apply) {
        applySkills(skillsSource, dir, ops);
        mine.skills = ops.filter((o) => o.op === 'add' || o.op === 'update' || o.op === 'unchanged').map((o) => o.name);
      }
    }

    if (c.rulesFile) {
      const file = c.rulesFile(env);
      const plan = planRules(readText(file), rules);
      // Nothing to say when there are no rules and no block.
      if (!(plan.op === 'unchanged' && rules === '')) {
        add(c, 'rules', [{ name: path.basename(file), op: plan.op, ...(plan.detail !== undefined ? { detail: plan.detail } : {}) }]);
      }
      if (opts.apply && plan.text !== null) {
        writeSafe(file, plan.text);
        written.push(file);
      }
    }

    if (opts.apply) state.clients[c.id] = mine;
  }

  if (opts.apply) saveState(env, state);
  return { actions, clients: statuses, written };
}
