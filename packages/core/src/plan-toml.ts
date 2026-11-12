/** Plans MCP server changes for Codex's config.toml: one managed block, the rest untouched (pure). */
import { eolOf, joinBlock, sameBody, splitBlock, type Markers } from './blocks.js';
import { readTomlServers, sameServer } from './read-servers.js';
import type { ItemOp, McpServer } from './types.js';

export const TOML_MARKERS: Markers = {
  beginPrefix: '# >>> magnus',
  beginLine: '# >>> magnus (managed: edit ~/.magnus/magnus.json, then run "magnus sync")',
  endLine: '# <<< magnus',
};

export interface TomlPlan {
  /** The new file text, or null when nothing changes. */
  text: string | null;
  ops: ItemOp[];
  managed: string[];
}

/** A TOML basic string (JSON's escapes are a subset of TOML's). */
function str(s: string): string {
  return JSON.stringify(s);
}

function key(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : str(k);
}

function table(name: string, s: McpServer): string {
  const lines = [`[mcp_servers.${name}]`, `command = ${str(s.command)}`, `args = [${s.args.map(str).join(', ')}]`];
  const env = Object.entries(s.env);
  if (env.length > 0) {
    lines.push('', `[mcp_servers.${name}.env]`, ...env.map(([k, v]) => `${key(k)} = ${str(v)}`));
  }
  return lines.join('\n');
}

/** The tables of a managed block, by server name. */
function tablesIn(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (name !== null) out.set(name, buf.join('\n').trim());
  };
  for (const raw of body.replace(/\r/g, '').split('\n')) {
    const m = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/.exec(raw);
    if (m) {
      flush();
      name = m[1] as string;
      buf = [];
    }
    buf.push(raw);
  }
  flush();
  return out;
}

/** `current`: the file's text (null = no file). */
export function planTomlMcp(current: string | null, wanted: Record<string, McpServer>): TomlPlan {
  const names = Object.keys(wanted).sort();
  const split = splitBlock(current ?? '', TOML_MARKERS);
  if (split.malformed) {
    const detail = 'the magnus block in the file has no end marker: left untouched';
    return { text: null, ops: names.map((name) => ({ name, op: 'skip', detail })), managed: [] };
  }
  // The user's own tables, outside the managed block.
  const theirs = new Map(readTomlServers(split.before + '\n' + split.after).map((f) => [f.name, f]));
  const old = tablesIn(split.body ?? '');

  const ops: ItemOp[] = [];
  const tables: string[] = [];
  const managed: string[] = [];
  for (const name of names) {
    const want = wanted[name] as McpServer;
    const own = theirs.get(name);
    if (own) {
      // ADR 0004: an identical table the user wrote is fine where it is; a different one is a
      // conflict (two tables with one name would break the file).
      if (own.server && sameServer(own.server, want)) {
        ops.push({ name, op: 'unchanged' });
      } else {
        ops.push({
          name,
          op: 'conflict',
          detail: `[mcp_servers.${name}] already exists in the file and differs; remove it there to let Magnus manage it`,
        });
      }
      continue;
    }
    const t = table(name, want);
    const before = old.get(name);
    ops.push({ name, op: before === undefined ? 'add' : sameBody(before, t) ? 'unchanged' : 'update' });
    tables.push(t);
    managed.push(name);
  }
  for (const name of old.keys()) {
    if (!managed.includes(name)) ops.push({ name, op: 'remove' });
  }

  const changed = ops.some((o) => o.op === 'add' || o.op === 'update' || o.op === 'remove');
  if (!changed) return { text: null, ops, managed };
  const body = tables.length > 0 ? tables.join('\n\n') : null;
  return { text: joinBlock(split, body, TOML_MARKERS, eolOf(current)), ops, managed };
}
