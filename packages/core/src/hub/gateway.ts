/** The gateway: many MCP servers behind one, tools named `<server>__<tool>` (ADR 0005). */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { ARRANGE_ICONS, arrangeIcons, type Layout } from './arrange.js';
import { DESKTOP_TOOLS, DesktopHelper, RESTORE_WINDOWS, SHOW_DESKTOP } from './desktop.js';
import type { BuiltinTools } from '../tasks/mcp-tools.js';
import type { McpServer } from '../types.js';

export const SEP = '__';
export const STATUS_TOOL = `magnus${SEP}status`;

/** Timing (ADR 0005): the hub answers fast and adds slow servers when they are up. */
export interface Timing {
  /** A server that has not answered by then is given up (first `npx` downloads are slow). */
  startMs: number;
  /** How long the first tool list waits for servers still starting. */
  listMs: number;
  /** How long the hub's instructions wait for the servers' own. */
  instructionsMs: number;
}
export const TIMING: Timing = { startMs: 60_000, listMs: 8_000, instructionsMs: 3_000 };
/** Long: a tool may wait for the user (e.g. an XtraOS approval). */
const CALL_TIMEOUT_MS = 10 * 60_000;

/** Starts one registered server and returns a connected MCP client. */
export type Connect = (name: string, server: McpServer) => Promise<Client>;

interface Downstream {
  name: string;
  client?: Client;
  tools: Tool[];
  instructions?: string;
  error?: string;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Gateway {
  private readonly names: string[];
  private readonly starting = new Map<string, Promise<Downstream>>();
  private readonly up = new Map<string, Downstream>();
  private readonly t0 = Date.now();
  private listeners: (() => void)[] = [];
  /** Desktop helpers (ADR 0016), offered when XtraOS is behind the hub. */
  private readonly desktop = new DesktopHelper((n, a) => this.callTool(n, a));

  /** Starts every server at once; one that fails is kept with its error, the rest work. */
  constructor(
    servers: Record<string, McpServer>,
    connect: Connect,
    private readonly log: (line: string) => void = () => {},
    private readonly timing: Timing = TIMING,
    /** Magnus's own tools (the task tools, ADR 0013), named magnus__… */
    private readonly builtins?: BuiltinTools,
  ) {
    this.names = Object.keys(servers).sort();
    for (const name of this.names) {
      const start = (async (): Promise<Downstream> => {
        try {
          const started = (async () => {
            const client = await connect(name, servers[name] as McpServer);
            const { tools } = await client.listTools();
            return { client, tools };
          })();
          const { client, tools } = await withTimeout(started, timing.startMs, `server "${name}"`);
          const instructions = client.getInstructions();
          return { name, client, tools, ...(instructions !== undefined && instructions !== '' ? { instructions } : {}) };
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          this.log(`magnus hub: server "${name}" is not available: ${error}`);
          return { name, tools: [], error };
        }
      })().then((d) => {
        this.up.set(name, d);
        for (const fn of this.listeners) fn();
        return d;
      });
      this.starting.set(name, start);
    }
  }

  /** Calls `fn` each time a server finishes starting (so a client can be told the list changed). */
  onServerUp(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Waits until every server is up or `ms` have passed since the gateway started. */
  private async settle(ms: number): Promise<void> {
    const left = ms - (Date.now() - this.t0);
    if (left > 0 && this.up.size < this.names.length) await Promise.race([Promise.all(this.starting.values()), sleep(left)]);
  }

  /** The tools of the servers that are up, under `<server>__<tool>`, plus the status tool. */
  async listTools(): Promise<Tool[]> {
    await this.settle(this.timing.listMs);
    const tools: Tool[] = [
      {
        name: STATUS_TOOL,
        description: 'Magnus hub: the servers behind this hub, how many tools each has, any still starting or failed.',
        inputSchema: { type: 'object', properties: {} },
      },
      ...(this.builtins?.tools ?? []),
      ...(this.up.get('xtraos')?.client ? DESKTOP_TOOLS : []),
    ];
    for (const name of this.names) {
      for (const t of this.up.get(name)?.tools ?? []) tools.push({ ...t, name: `${name}${SEP}${t.name}` });
    }
    return tools;
  }

  private status(): string {
    const line = (name: string): string => {
      const d = this.up.get(name);
      if (!d) return `${name}: starting…`;
      return `${name}: ${d.error !== undefined ? `NOT AVAILABLE — ${d.error}` : `${d.tools.length} tool(s)`}`;
    };
    return this.names.map(line).join('\n') || 'no servers registered';
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    if (name === STATUS_TOOL) return textResult(this.status());
    if (this.builtins?.tools.some((t) => t.name === name)) return this.builtins.call(name, args ?? {});
    if (name === SHOW_DESKTOP) return this.desktop.show();
    if (name === RESTORE_WINDOWS) return this.desktop.restore();
    if (name === ARRANGE_ICONS) {
      const l = args?.['layout'];
      const layout: Layout = l === 'left' || l === 'right' ? l : 'left-right';
      const before = this.desktop.pending;
      await this.desktop.show();
      const res = await arrangeIcons((n, a) => this.callTool(n, a), layout, this.log);
      if (before === 0) await this.desktop.restore(); // put back what this call minimised
      return res;
    }
    // A drag on the desktop that is covered: clear the desktop once and try again (ADR 0016).
    if (name === 'xtraos__drag' && args?.['window'] === 'desktop') {
      const first = await this.forward(name, args);
      const t = first.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ');
      if (!t.includes('TARGET_OBSCURED')) return first;
      const shown = await this.desktop.show();
      const again = await this.forward(name, args);
      const note = shown.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ');
      return { ...again, content: [{ type: 'text', text: `(Magnus: the desktop was covered. ${note})` }, ...again.content] };
    }
    return this.forward(name, args);
  }

  /** Calls a tool of a downstream server. */
  private async forward(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const at = name.indexOf(SEP);
    const server = at > 0 ? name.slice(0, at) : '';
    // A call for a server that is still starting waits for it.
    const d = this.up.get(server) ?? (await this.starting.get(server));
    const tool = name.slice(at + SEP.length);
    if (!d?.client || !d.tools.some((t) => t.name === tool)) {
      return textResult(`unknown tool "${name}" (call ${STATUS_TOOL} to see the servers)`, true);
    }
    try {
      const res = await d.client.callTool({ name: tool, ...(args !== undefined ? { arguments: args } : {}) }, undefined, { timeout: CALL_TIMEOUT_MS });
      return res as CallToolResult;
    } catch (e) {
      return textResult(`${d.name}: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  /** The instructions of the servers that are up in time, one heading each. */
  async instructions(): Promise<string> {
    await this.settle(this.timing.instructionsMs);
    const parts = this.names
      .map((n) => this.up.get(n))
      .filter((d) => d?.instructions !== undefined)
      .map((d) => `## ${d?.name} (tools: ${d?.name}${SEP}…)\n${d?.instructions}`);
    const head = `Magnus hub: tools are named <server>${SEP}<tool>. ${STATUS_TOOL} lists the servers; one that is still starting adds its tools when it is up.`;
    return [head, ...parts].join('\n\n');
  }

  async close(): Promise<void> {
    // Windows minimised for desktop work come back even if the brain forgot (ADR 0016).
    if (this.desktop.pending > 0) await this.desktop.restore().catch(() => undefined);
    // Servers still starting are closed when they arrive; closing does not wait for them.
    for (const n of this.names) if (!this.up.has(n)) void this.starting.get(n)?.then((d) => d.client?.close());
    await Promise.allSettled(this.names.map((n) => this.up.get(n)?.client?.close()));
  }
}

/**
 * An MCP server that speaks for the gateway (one per connection; HTTP makes one per request).
 * `notify`: tell the client when a late server adds tools (not for one-request HTTP servers).
 */
export async function makeHubServer(gateway: Gateway, version: string, notify = true): Promise<Server> {
  const server = new Server(
    { name: 'magnus', version },
    { capabilities: { tools: notify ? { listChanged: true } : {} }, instructions: await gateway.instructions() },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await gateway.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => gateway.callTool(req.params.name, req.params.arguments));
  if (notify) gateway.onServerUp(() => void server.sendToolListChanged().catch(() => {}));
  return server;
}
