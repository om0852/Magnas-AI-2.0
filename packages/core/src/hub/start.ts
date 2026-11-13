/** Starts the gateway for real: `magnus hub` (stdio) and `magnus serve` (HTTP). */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PHONE_SERVER } from '../remote/phone-mcp.js';
import { loadRegistry } from '../registry.js';
import { readSecrets, resolveServer, secretRefs, type Protector } from '../secrets.js';
import { MagnusError, type Env, type McpServer } from '../types.js';
import { taskTools } from '../tasks/mcp-tools.js';
import { Gateway, type Timing, makeHubServer, TIMING, type Connect } from './gateway.js';
import { serveHttp, HTTP_PATH } from './http.js';
import { keyHash } from './key.js';

export const VERSION = '0.1.0';

/** This install's cli.js (the hub runs as `node cli.js hub`). */
function selfCli(): string {
  return fileURLToPath(new URL('../cli.js', import.meta.url));
}

/**
 * The registry's servers for one tool (`clientId` undefined = all), with secrets filled in.
 * All secrets are decrypted in one go, so the cost is paid once per gateway start.
 */
export function hubServers(
  env: Env,
  clientId: string | undefined,
  protector: () => Protector,
  only?: readonly string[],
): Record<string, McpServer> {
  const reg = loadRegistry(env);
  if (only !== undefined) {
    const unknown = only.filter((n) => n !== PHONE_SERVER && !Object.hasOwn(reg.mcpServers, n));
    if (unknown.length > 0) throw new MagnusError('NOT_FOUND', `not in the registry: ${unknown.join(', ')}`);
  }
  const mine = Object.entries(reg.mcpServers).filter(
    ([name, s]) => (only === undefined || only.includes(name)) && (clientId === undefined || s.clients === undefined || s.clients.includes(clientId)),
  );
  const refs = [...new Set(mine.flatMap(([, s]) => secretRefs(s)))];
  const values = refs.length > 0 ? readSecrets(env, protector(), refs) : new Map<string, string>();
  const out: Record<string, McpServer> = Object.fromEntries(mine.map(([name, s]) => [name, resolveServer(s, values)]));
  // ADR 0008: the built-in phone server, only when named (the brain on a phone task).
  if (only?.includes(PHONE_SERVER) === true) out[PHONE_SERVER] = { command: process.execPath, args: [selfCli(), 'phone-mcp'], env: {} };
  return out;
}

/** Starts a registered server as a child process and connects to it. */
export const stdioConnect: Connect = async (name, s) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const transport = new StdioClientTransport({ command: s.command, args: s.args, env: { ...env, ...s.env }, stderr: 'inherit' });
  const client = new Client({ name: `magnus-hub/${name}`, version: VERSION });
  await client.connect(transport);
  return client;
};

/** `magnus hub`: the gateway on this process's stdin and stdout, until the tool closes it. */
export async function runHubStdio(
  env: Env,
  clientId: string | undefined,
  protector: () => Protector,
  connect: Connect = stdioConnect,
  only?: readonly string[],
  timing: Timing = TIMING,
): Promise<number> {
  const gateway = new Gateway(hubServers(env, clientId, protector, only), connect, (l) => process.stderr.write(l + '\n'), timing, taskTools(env, clientId ?? 'mcp'));
  const server = await makeHubServer(gateway, VERSION);
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    process.stdin.once('end', () => resolve());
  });
  await server.connect(new StdioServerTransport());
  await closed;
  await gateway.close();
  return 0;
}

/** `magnus serve`: the gateway over HTTP on 127.0.0.1; returns once it listens. */
export async function startHubHttp(
  env: Env,
  port: number,
  protector: () => Protector,
  connect: Connect = stdioConnect,
): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  const hash = keyHash(env);
  if (hash === null) throw new MagnusError('NO_KEY', 'no Magnus key yet', 'Run: magnus key new');
  const gateway = new Gateway(hubServers(env, undefined, protector), connect, (l) => process.stderr.write(l + '\n'), TIMING, taskTools(env, 'http'));
  const srv = await serveHttp(() => makeHubServer(gateway, VERSION, false), port, hash);
  const actual = (srv.address() as AddressInfo).port;
  return {
    port: actual,
    url: `http://127.0.0.1:${actual}${HTTP_PATH}`,
    close: async () => {
      await new Promise<void>((r) => srv.close(() => r()));
      await gateway.close();
    },
  };
}
