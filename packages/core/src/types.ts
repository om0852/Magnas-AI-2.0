/** Shared types and the error type of the Magnus core. */

/** Where things live for the current user. Built once at the edge; tests build their own. */
export interface Env {
  /** The user's home folder. */
  home: string;
  /** %APPDATA% (Roaming). */
  appData: string;
  /** The Magnus registry folder (default ~/.magnus). */
  magnusHome: string;
}

/** One MCP server as stored in the registry. */
export interface McpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Only these tools get the server; undefined = all. */
  clients?: string[];
}

export interface Registry {
  version: 1;
  mcpServers: Record<string, McpServer>;
  /** Per tool: switched off, and how it gets its servers (default direct; ADR 0005). */
  clients: Record<string, { enabled: boolean; mode?: 'direct' | 'hub'; hooks?: boolean }>;
  /** Brain settings (ADR 0007); omitted = defaults. */
  brain?: { order?: ('codex' | 'antigravity')[]; servers?: string[]; timeoutSec?: number; codexModel?: string; codexEffort?: Effort; agyModel?: string };
}

export type Op = 'add' | 'update' | 'remove' | 'unchanged' | 'conflict' | 'skip';

/** One planned or applied change in one tool. */
export interface Action {
  client: string;
  kind: 'mcp' | 'skill' | 'rules' | 'hooks';
  name: string;
  op: Op;
  detail?: string;
}

/** A change to one named item, before it is tied to a tool. */
export interface ItemOp {
  name: string;
  op: Op;
  detail?: string;
}

/** An error the user can fix: the CLI prints message and hint, never a stack trace. */
export class MagnusError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint = '',
  ) {
    super(message);
    this.name = 'MagnusError';
  }
}

/** Codex reasoning effort (ADR 0014). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
