/** What the dashboard shows, and the check every dashboard request must pass (ADR 0006). */
import crypto from 'node:crypto';
import path from 'node:path';
import { CLIENTS } from './clients/defs.js';
import { listSkills, loadRegistry, registryFile, rulesText, saveRegistry } from './registry.js';
import { secretNames, secretRefs } from './secrets.js';
import { clientStatuses } from './sync.js';
import { MagnusError, type Env } from './types.js';

export interface DashboardServer {
  name: string;
  /** The program's file name only (no folder). */
  command: string;
  argCount: number;
  /** Names of the env variables; never their values. */
  envKeys: string[];
  usesSecrets: boolean;
  /** Tool ids, or null for all tools. */
  clients: string[] | null;
}

export interface DashboardTool {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  mode: 'direct' | 'hub';
  gets: ('MCP' | 'skills' | 'rules')[];
  note?: string;
}

export interface DashboardState {
  registryFile: string;
  servers: DashboardServer[];
  skills: string[];
  rulesLines: number;
  secrets: string[];
  tools: DashboardTool[];
}

/** The registry and the tools, with nothing secret in it: safe to send to the browser. */
export function dashboardState(env: Env): DashboardState {
  const reg = loadRegistry(env);
  const rules = rulesText(env);
  return {
    registryFile: registryFile(env),
    servers: Object.entries(reg.mcpServers)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, s]) => ({
        name,
        command: path.win32.basename(s.command),
        argCount: s.args.length,
        envKeys: Object.keys(s.env).sort(),
        usesSecrets: secretRefs(s).length > 0,
        clients: s.clients ?? null,
      })),
    skills: listSkills(env),
    rulesLines: rules === '' ? 0 : rules.split('\n').length,
    secrets: secretNames(env),
    tools: clientStatuses(env, reg).map((c) => {
      const def = CLIENTS.find((d) => d.id === c.id);
      const gets: DashboardTool['gets'] = [];
      if (def?.mcp) gets.push('MCP');
      if (def?.skillsDir) gets.push('skills');
      if (def?.rulesFile) gets.push('rules');
      return {
        id: c.id,
        name: c.name,
        installed: c.installed,
        enabled: c.enabled,
        mode: reg.clients[c.id]?.mode === 'hub' ? 'hub' : 'direct',
        gets,
        ...(c.note !== undefined ? { note: c.note } : {}),
      };
    }),
  };
}

/** Sets how a tool gets its servers; the next sync applies it. */
export function setClientMode(env: Env, id: string, mode: 'direct' | 'hub'): void {
  if (!CLIENTS.some((c) => c.id === id)) {
    throw new MagnusError('UNKNOWN_CLIENT', `unknown tool "${id}"`, `Known: ${CLIENTS.map((c) => c.id).join(', ')}`);
  }
  const reg = loadRegistry(env);
  const enabled = reg.clients[id]?.enabled !== false;
  reg.clients[id] = mode === 'hub' ? { enabled, mode } : { enabled };
  saveRegistry(env, reg);
}

export interface DashboardRequest {
  method: string;
  host: string | null;
  origin: string | null;
  /** The token from the dashboard's cookie. */
  token: string | null;
}

export interface DashboardRefusal {
  status: number;
  message: string;
}

/**
 * The check for every dashboard request (pure). A loopback Host (DNS rebinding), the run's
 * token, and for anything but GET the dashboard's own Origin (no other web page may act).
 */
export function checkDashboardRequest(req: DashboardRequest, port: number, token: string): DashboardRefusal | null {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (req.host === null || !hosts.includes(req.host.toLowerCase())) return { status: 403, message: `Host must be 127.0.0.1:${port}` };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.origin === null || !hosts.map((h) => `http://${h}`).includes(req.origin.toLowerCase())) {
      return { status: 403, message: 'changes are accepted only from the dashboard itself' };
    }
  }
  const a = Buffer.from(req.token ?? '');
  const b = Buffer.from(token);
  if (token === '' || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { status: 401, message: 'open the link printed by "npm run dashboard"' };
  }
  return null;
}

/** Who a request comes from, after the checks (ADR 0009). */
export type Access =
  | { ok: true; who: 'local' }
  | { ok: true; who: 'device'; deviceId: string }
  | { ok: false; status: number; message: string; remote: boolean };

export interface AccessRequest {
  method: string;
  host: string | null;
  origin: string | null;
  /** The run token cookie (this PC's own browser). */
  runToken: string | null;
  /** The device cookie (a paired phone). */
  deviceToken: string | null;
}

export interface AccessConfig {
  port: number;
  runToken: string;
  /** Hosts the remote app is reached by, e.g. "mypc.tail1234.ts.net" (Tailscale serve). */
  remoteHosts: readonly string[];
  /** The device id for a cookie token, or null. */
  device: (token: string) => string | null;
}

/**
 * The check for every request when the app may also be used remotely (pure apart from
 * `device`). A remote host needs a paired device; this PC's loopback address needs the run
 * token; any other Host is refused (DNS rebinding). Changes need the app's own Origin.
 */
export function checkAccess(req: AccessRequest, cfg: AccessConfig): Access {
  const host = (req.host ?? '').toLowerCase();
  const remote = cfg.remoteHosts.map((h) => h.toLowerCase()).includes(host);
  const local = !remote && (host === `127.0.0.1:${cfg.port}` || host === `localhost:${cfg.port}`);
  if (!remote && !local) return { ok: false, status: 403, message: 'unknown host', remote: false };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // A plain-http origin only for this PC's own names; a remote host must use https.
    const plain = local || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    const allowed = [`https://${host}`, ...(plain ? [`http://${host}`] : [])];
    if (req.origin === null || !allowed.includes(req.origin.toLowerCase())) {
      return { ok: false, status: 403, message: 'changes are accepted only from the Magnus app itself', remote };
    }
  }
  if (remote) {
    const id = req.deviceToken !== null && req.deviceToken !== '' ? cfg.device(req.deviceToken) : null;
    return id !== null ? { ok: true, who: 'device', deviceId: id } : { ok: false, status: 401, message: 'this device is not paired', remote: true };
  }
  const a = Buffer.from(req.runToken ?? '');
  const b = Buffer.from(cfg.runToken);
  if (cfg.runToken === '' || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, message: 'open the link printed by "npm run dashboard"', remote: false };
  }
  return { ok: true, who: 'local' };
}
