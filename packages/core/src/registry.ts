/** The Magnus registry (~/.magnus): MCP servers, skills and rules. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MagnusError, type Env, type McpServer, type Registry } from './types.js';

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The name of the hub entry in the tools (ADR 0005); not allowed for a registered server. */
export const HUB_NAME = 'magnus';

/** The real user's environment; `MAGNUS_HOME` moves the registry. */
export function envFromProcess(vars: NodeJS.ProcessEnv = process.env): Env {
  const home = os.homedir();
  return {
    home,
    appData: vars['APPDATA'] ?? path.join(home, 'AppData', 'Roaming'),
    magnusHome: vars['MAGNUS_HOME'] ?? path.join(home, '.magnus'),
  };
}

export function registryFile(env: Env): string {
  return path.join(env.magnusHome, 'magnus.json');
}

/** True for a name usable as a server or skill name. */
export function validName(name: string): boolean {
  return NAME.test(name);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringList(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new MagnusError('BAD_REGISTRY', `${what} must be a list of strings`);
  }
  return v as string[];
}

/** Validates the text of magnus.json. */
export function parseRegistry(text: string): Registry {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new MagnusError('BAD_REGISTRY', `magnus.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw) || raw['version'] !== 1) {
    throw new MagnusError('BAD_REGISTRY', 'magnus.json must be an object with "version": 1');
  }
  const servers: Record<string, McpServer> = {};
  const rawServers = raw['mcpServers'] ?? {};
  if (!isRecord(rawServers)) throw new MagnusError('BAD_REGISTRY', '"mcpServers" must be an object');
  for (const [name, v] of Object.entries(rawServers)) {
    if (!validName(name)) {
      throw new MagnusError('BAD_REGISTRY', `server name "${name}": use letters, digits, _ and - (1-64)`);
    }
    if (name === HUB_NAME) throw new MagnusError('BAD_REGISTRY', `the server name "${HUB_NAME}" is reserved for the hub`);
    if (!isRecord(v) || typeof v['command'] !== 'string' || v['command'] === '') {
      throw new MagnusError('BAD_REGISTRY', `server "${name}" needs a "command"`);
    }
    const envVars = v['env'] ?? {};
    if (!isRecord(envVars) || Object.values(envVars).some((x) => typeof x !== 'string')) {
      throw new MagnusError('BAD_REGISTRY', `server "${name}": "env" must map names to strings`);
    }
    const server: McpServer = {
      command: v['command'],
      args: stringList(v['args'], `server "${name}": "args"`),
      env: envVars as Record<string, string>,
    };
    if (v['clients'] !== undefined) server.clients = stringList(v['clients'], `server "${name}": "clients"`);
    servers[name] = server;
  }
  const clients: Registry['clients'] = {};
  const rawClients = raw['clients'] ?? {};
  if (!isRecord(rawClients)) throw new MagnusError('BAD_REGISTRY', '"clients" must be an object');
  for (const [id, v] of Object.entries(rawClients)) {
    clients[id] = { enabled: !(isRecord(v) && v['enabled'] === false), ...(isRecord(v) && v['mode'] === 'hub' ? { mode: 'hub' as const } : {}) };
  }
  let brain: Registry['brain'];
  const rawBrain = raw['brain'];
  if (rawBrain !== undefined) {
    if (!isRecord(rawBrain)) throw new MagnusError('BAD_REGISTRY', '"brain" must be an object');
    brain = {};
    if (rawBrain['order'] !== undefined) {
      const order = stringList(rawBrain['order'], '"brain.order"');
      if (order.length === 0 || order.some((o) => o !== 'codex' && o !== 'antigravity')) {
        throw new MagnusError('BAD_REGISTRY', '"brain.order" lists "codex" and/or "antigravity"');
      }
      brain.order = order as ('codex' | 'antigravity')[];
    }
    if (rawBrain['servers'] !== undefined) {
      const list = stringList(rawBrain['servers'], '"brain.servers"');
      if (list.length === 0) throw new MagnusError('BAD_REGISTRY', '"brain.servers" needs at least one server');
      brain.servers = list;
    }
    if (rawBrain['timeoutSec'] !== undefined) {
      const t = rawBrain['timeoutSec'];
      if (typeof t !== 'number' || !Number.isInteger(t) || t < 30 || t > 3600) {
        throw new MagnusError('BAD_REGISTRY', '"brain.timeoutSec" is a whole number from 30 to 3600');
      }
      brain.timeoutSec = t;
    }
  }
  return { version: 1, mcpServers: servers, clients, ...(brain !== undefined ? { brain } : {}) };
}

export function loadRegistry(env: Env): Registry {
  const file = registryFile(env);
  if (!fs.existsSync(file)) {
    throw new MagnusError('NO_REGISTRY', `no registry at ${file}`, 'Run: magnus init');
  }
  return parseRegistry(fs.readFileSync(file, 'utf8'));
}

export function saveRegistry(env: Env, reg: Registry): void {
  fs.mkdirSync(env.magnusHome, { recursive: true });
  const servers: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(reg.mcpServers)) {
    servers[name] = {
      command: s.command,
      args: s.args,
      ...(Object.keys(s.env).length > 0 ? { env: s.env } : {}),
      ...(s.clients ? { clients: s.clients } : {}),
    };
  }
  const out = { version: 1, mcpServers: servers, clients: reg.clients, ...(reg.brain !== undefined ? { brain: reg.brain } : {}) };
  fs.writeFileSync(registryFile(env), JSON.stringify(out, null, 2) + '\n');
}

/** Creates the registry folders and an empty magnus.json; returns false when it already exists. */
export function initRegistry(env: Env): boolean {
  fs.mkdirSync(path.join(env.magnusHome, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(env.magnusHome, 'rules'), { recursive: true });
  if (fs.existsSync(registryFile(env))) return false;
  saveRegistry(env, { version: 1, mcpServers: {}, clients: {} });
  return true;
}

/** Skill names: folders in skills/ that contain SKILL.md. */
export function listSkills(env: Env): string[] {
  const dir = path.join(env.magnusHome, 'skills');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && validName(d.name) && fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

/** The rules for every tool: rules/*.md joined in file-name order ('' when there are none). */
export function rulesText(env: Env): string {
  const dir = path.join(env.magnusHome, 'rules');
  if (!fs.existsSync(dir)) return '';
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim())
    .filter((t) => t !== '')
    .join('\n\n');
}
