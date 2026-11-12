/** Plans MCP server changes for tools that keep them in a JSON file (pure: text in, text out). */
import type { ItemOp, McpServer } from './types.js';

export interface JsonShape {
  /** The object that holds the servers: "mcpServers" (most tools) or "servers" (VS Code). */
  key: 'mcpServers' | 'servers';
  /** Write `"type": "stdio"` on each entry. */
  stdioType: boolean;
}

export interface JsonPlan {
  /** The new file text, or null when nothing changes. */
  text: string | null;
  ops: ItemOp[];
  /** Server names Magnus manages in this file after the plan. */
  managed: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function entryFor(s: McpServer, shape: JsonShape): Record<string, unknown> {
  return {
    ...(shape.stdioType ? { type: 'stdio' } : {}),
    command: s.command,
    args: s.args,
    ...(Object.keys(s.env).length > 0 ? { env: s.env } : {}),
  };
}

/** Same command, args and env (the entry's other fields, e.g. "type", do not matter). */
function sameServer(existing: unknown, s: McpServer): boolean {
  if (!isRecord(existing)) return false;
  const args = existing['args'] ?? [];
  const env = existing['env'] ?? {};
  return (
    existing['command'] === s.command &&
    JSON.stringify(args) === JSON.stringify(s.args) &&
    isRecord(env) &&
    JSON.stringify(Object.entries(env).sort()) === JSON.stringify(Object.entries(s.env).sort())
  );
}

/**
 * `current`: the file's text (null = no file). `managed`: names Magnus wrote before.
 * Entries Magnus did not write are never changed unless `force`.
 */
export function planJsonMcp(
  current: string | null,
  wanted: Record<string, McpServer>,
  managed: readonly string[],
  shape: JsonShape,
  force: boolean,
): JsonPlan {
  const names = Object.keys(wanted).sort();
  const skipAll = (detail: string): JsonPlan => ({
    text: null,
    ops: names.map((name) => ({ name, op: 'skip', detail })),
    managed: [...managed],
  });

  let root: Record<string, unknown> = {};
  if (current !== null && current.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      return skipAll('the file is not plain JSON (comments?): left untouched');
    }
    if (!isRecord(parsed)) return skipAll('the file is not a JSON object: left untouched');
    root = parsed;
  }
  const holder = root[shape.key] ?? {};
  if (!isRecord(holder)) return skipAll(`"${shape.key}" is not an object: left untouched`);
  const servers: Record<string, unknown> = { ...holder };

  const ops: ItemOp[] = [];
  const nowManaged: string[] = [];
  for (const name of names) {
    const want = wanted[name] as McpServer;
    const has = Object.hasOwn(servers, name);
    if (!has) {
      servers[name] = entryFor(want, shape);
      ops.push({ name, op: 'add' });
      nowManaged.push(name);
    } else if (sameServer(servers[name], want)) {
      ops.push({ name, op: 'unchanged' });
      nowManaged.push(name);
    } else if (managed.includes(name) || force) {
      servers[name] = entryFor(want, shape);
      ops.push({ name, op: 'update' });
      nowManaged.push(name);
    } else {
      ops.push({ name, op: 'conflict', detail: 'an entry with this name exists and differs (use --force to replace it)' });
    }
  }
  for (const name of managed) {
    if (names.includes(name)) continue;
    if (Object.hasOwn(servers, name)) {
      delete servers[name];
      ops.push({ name, op: 'remove' });
    }
  }

  const changed = ops.some((o) => o.op === 'add' || o.op === 'update' || o.op === 'remove');
  if (!changed) return { text: null, ops, managed: nowManaged };
  root[shape.key] = servers;
  return { text: JSON.stringify(root, null, 2) + '\n', ops, managed: nowManaged };
}
