/** `magnus import`: take what the installed tools already have into the registry (ADR 0004). */
import fs from 'node:fs';
import path from 'node:path';
import { splitBlock } from './blocks.js';
import { CLIENTS, type ClientDef } from './clients/defs.js';
import { TOML_MARKERS } from './plan-toml.js';
import { readJsonServers, readTomlServers, sameServer, type Found } from './read-servers.js';
import { listSkills, loadRegistry, saveRegistry, validName } from './registry.js';
import { secretRefs, setSecret, type Protector } from './secrets.js';
import { hashDir, MARKER } from './skills.js';
import { clientStatuses, loadState, readText, saveState } from './sync.js';
import { MagnusError, type Env, type McpServer } from './types.js';

export interface ImportOptions {
  apply: boolean;
  /** Store imported `env` values as secrets and put references in the registry. */
  secrets: boolean;
  only?: readonly string[];
  /** Needed only with `secrets` and `apply`. */
  protector?: () => Protector;
}

export interface ImportItem {
  kind: 'mcp' | 'skill';
  name: string;
  /** The tool it was found in. */
  from: string;
  /** import = goes into the registry; exists = already there and equal; differs / skip = left alone. */
  op: 'import' | 'exists' | 'differs' | 'skip';
  detail?: string;
}

/** The servers a tool has that Magnus did not put in its managed block. */
function serversOf(c: ClientDef, env: Env): Found[] {
  if (!c.mcp) return [];
  const text = readText(c.mcp.file(env));
  if (c.mcp.format === 'toml') {
    const split = splitBlock(text ?? '', TOML_MARKERS);
    return readTomlServers(split.before + '\n' + split.after);
  }
  return readJsonServers(text, c.mcp.format === 'json' ? c.mcp.shape.key : 'mcpServers');
}

/** The secret name for an imported env value: SERVER_KEY in capitals. */
export function secretNameFor(server: string, key: string): string {
  return `${server}_${key}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64);
}

export function importFromTools(env: Env, opts: ImportOptions): ImportItem[] {
  const reg = loadRegistry(env);
  const known = CLIENTS.map((c) => c.id);
  for (const id of opts.only ?? []) {
    if (!known.includes(id)) throw new MagnusError('UNKNOWN_CLIENT', `unknown tool "${id}"`, `Known: ${known.join(', ')}`);
  }
  const tools = CLIENTS.filter((c) => {
    const st = clientStatuses(env, reg).find((s) => s.id === c.id);
    return st?.installed === true && (opts.only === undefined || opts.only.includes(c.id));
  });
  const items: ImportItem[] = [];
  const skillsHome = path.join(env.magnusHome, 'skills');
  const registrySkills = listSkills(env);

  // Chosen for the registry, and every tool that holds an identical copy (for the take-over).
  const servers = new Map<string, { server: McpServer; holders: string[] }>();
  const skills = new Map<string, { source: string; hash: string; holders: string[] }>();

  for (const c of tools) {
    for (const f of serversOf(c, env)) {
      const item = (op: ImportItem['op'], detail?: string): void => {
        items.push({ kind: 'mcp', name: f.name, from: c.id, op, ...(detail !== undefined ? { detail } : {}) });
      };
      if (!f.server) item('skip', f.reason);
      else if (!validName(f.name)) item('skip', 'the name has characters Magnus does not allow');
      else if (Object.hasOwn(reg.mcpServers, f.name)) {
        const mine = reg.mcpServers[f.name] as McpServer;
        // A registry server that uses secrets is in the tools as a launcher: nothing to compare.
        if (secretRefs(mine).length > 0 || sameServer(mine, f.server)) item('exists');
        else item('differs', 'the registry has a different server with this name');
      } else {
        const chosen = servers.get(f.name);
        if (!chosen) {
          servers.set(f.name, { server: f.server, holders: [c.id] });
          item('import');
        } else if (sameServer(chosen.server, f.server)) {
          chosen.holders.push(c.id);
          item('exists', 'same as the one being imported');
        } else item('differs', 'another tool defines this name differently; the first one is imported');
      }
    }

    const dir = c.skillsDir?.(env);
    if (dir === undefined || !fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const folder = path.join(dir, d.name);
      if (!d.isDirectory() || !fs.existsSync(path.join(folder, 'SKILL.md')) || fs.existsSync(path.join(folder, MARKER))) continue;
      const item = (op: ImportItem['op'], detail?: string): void => {
        items.push({ kind: 'skill', name: d.name, from: c.id, op, ...(detail !== undefined ? { detail } : {}) });
      };
      if (!validName(d.name)) {
        item('skip', 'the name has characters Magnus does not allow');
        continue;
      }
      const hash = hashDir(folder);
      const chosen =
        skills.get(d.name) ??
        (registrySkills.includes(d.name)
          ? { source: '', hash: hashDir(path.join(skillsHome, d.name)), holders: [] as string[] }
          : undefined);
      if (!chosen) {
        skills.set(d.name, { source: folder, hash, holders: [c.id] });
        item('import');
      } else if (chosen.hash === hash) {
        if (!skills.has(d.name)) skills.set(d.name, chosen);
        chosen.holders.push(c.id);
        item('exists', chosen.source === '' ? undefined : 'same as the one being imported');
      } else item('differs', 'a different skill with this name is in the registry or another tool');
    }
  }

  if (!opts.apply) return items;

  // --- Apply: the registry first, then the take-over marks. ---
  const takeSecrets = opts.secrets ? opts.protector?.() : undefined;
  if (opts.secrets && !takeSecrets) throw new MagnusError('BAD_ARGS', 'no way to store secrets was given');
  for (const [name, { server }] of servers) {
    const stored: McpServer = { command: server.command, args: server.args, env: { ...server.env } };
    if (takeSecrets) {
      for (const [k, v] of Object.entries(server.env)) {
        if (v === '') continue;
        const secret = secretNameFor(name, k);
        setSecret(env, takeSecrets, secret, v);
        stored.env[k] = `\${secret:${secret}}`;
      }
    }
    reg.mcpServers[name] = stored;
  }
  saveRegistry(env, reg);

  const state = loadState(env);
  for (const [name, { holders }] of servers) {
    for (const id of holders) {
      // Codex tables outside the managed block stay the user's; JSON entries become managed.
      if (CLIENTS.find((c) => c.id === id)?.mcp?.format === 'toml') continue;
      const mine = (state.clients[id] ??= { mcp: [], skills: [] });
      if (!mine.mcp.includes(name)) mine.mcp.push(name);
    }
  }
  for (const [name, s] of skills) {
    if (s.source !== '') fs.cpSync(s.source, path.join(skillsHome, name), { recursive: true });
    for (const id of s.holders) {
      const dir = CLIENTS.find((c) => c.id === id)?.skillsDir?.(env);
      if (dir === undefined) continue;
      fs.writeFileSync(path.join(dir, name, MARKER), 'Taken over by Magnus (magnus import). Edit the skill in ~/.magnus/skills, then run "magnus sync".\n');
      const mine = (state.clients[id] ??= { mcp: [], skills: [] });
      if (!mine.skills.includes(name)) mine.skills.push(name);
    }
  }
  saveState(env, state);
  return items;
}
