/** Reads the MCP servers a tool already has, from its JSON or TOML config text (pure). */
import type { McpServer } from './types.js';

/** A server entry found in a tool: usable (`server`) or not, with the reason. */
export interface Found {
  name: string;
  server?: McpServer;
  reason?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Same command, args and env. */
export function sameServer(a: McpServer, b: McpServer): boolean {
  const env = (s: McpServer): string => JSON.stringify(Object.entries(s.env).sort());
  return a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args) && env(a) === env(b);
}

const NOT_PLAIN = 'has settings Magnus does not carry (not a plain command server): left where it is';

/** One JSON entry as a plain stdio server, or the reason it is not one. */
export function serverFromJson(name: string, v: unknown): Found {
  if (!isRecord(v)) return { name, reason: 'not an object' };
  const extra = Object.keys(v).filter((k) => !['type', 'command', 'args', 'env'].includes(k));
  const env = v['env'] ?? {};
  const args = v['args'] ?? [];
  if (
    extra.length > 0 ||
    (v['type'] !== undefined && v['type'] !== 'stdio') ||
    typeof v['command'] !== 'string' ||
    v['command'] === '' ||
    !isStrings(args) ||
    !isRecord(env) ||
    Object.values(env).some((x) => typeof x !== 'string')
  ) {
    return { name, reason: NOT_PLAIN };
  }
  return { name, server: { command: v['command'], args, env: env as Record<string, string> } };
}

/** The servers under `key` of a JSON config ('' or unparsable text: none). */
export function readJsonServers(text: string | null, key: 'mcpServers' | 'servers'): Found[] {
  if (text === null || text.trim() === '') return [];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return [];
  }
  const holder = isRecord(root) ? root[key] : undefined;
  if (!isRecord(holder)) return [];
  return Object.entries(holder).map(([name, v]) => serverFromJson(name, v));
}

// --- A small TOML reader: only what `[mcp_servers.<name>]` tables need. -------------------

/** Splits `a.b."c d"` into its parts; null when it is not a simple dotted key. */
function keyParts(src: string): string[] | null {
  const parts: string[] = [];
  let rest = src.trim();
  while (rest !== '') {
    let m = /^([A-Za-z0-9_-]+)\s*/.exec(rest);
    let part: string;
    if (m) {
      part = m[1] as string;
    } else if ((m = /^"((?:[^"\\]|\\.)*)"\s*/.exec(rest))) {
      try {
        part = JSON.parse(`"${m[1] as string}"`) as string;
      } catch {
        return null;
      }
    } else if ((m = /^'([^']*)'\s*/.exec(rest))) {
      part = m[1] as string;
    } else {
      return null;
    }
    parts.push(part);
    rest = rest.slice(m[0].length);
    if (rest === '') break;
    if (!rest.startsWith('.')) return null;
    rest = rest.slice(1).trimStart();
  }
  return parts.length > 0 ? parts : null;
}

/** Reads one string at the start of `src`; returns it and the text after it. */
function readString(src: string): { value: string; rest: string } | null {
  let m = /^"((?:[^"\\]|\\.)*)"/.exec(src);
  if (m && !src.startsWith('"""')) {
    try {
      return { value: JSON.parse(m[0]) as string, rest: src.slice(m[0].length) };
    } catch {
      return null;
    }
  }
  m = /^'([^']*)'/.exec(src);
  if (m && !src.startsWith("'''")) return { value: m[1] as string, rest: src.slice(m[0].length) };
  return null;
}

const onlyComment = (s: string): boolean => /^\s*(#.*)?$/.test(s);

/** A string or a list of strings; 'more' = a list that continues on the next line; null = other. */
function readValue(src: string): { value: string | string[] } | 'more' | null {
  const s = src.trimStart();
  if (!s.startsWith('[')) {
    const one = readString(s);
    return one && onlyComment(one.rest) ? { value: one.value } : null;
  }
  const items: string[] = [];
  let rest = s.slice(1);
  for (;;) {
    rest = rest.replace(/^(\s|#[^\n]*(\n|$))+/, '');
    if (rest === '') return 'more';
    if (rest.startsWith(']')) return onlyComment(rest.slice(1)) ? { value: items } : null;
    const one = readString(rest);
    if (!one) return null;
    items.push(one.value);
    rest = one.rest.replace(/^(\s|#[^\n]*(\n|$))+/, '');
    if (rest.startsWith(',')) rest = rest.slice(1);
    else if (rest !== '' && !rest.startsWith(']')) return null;
  }
}

/** The `[mcp_servers.<name>]` tables of a TOML text. */
export function readTomlServers(text: string | null): Found[] {
  if (text === null) return [];
  interface Draft {
    command?: string;
    args?: string[];
    env: Record<string, string>;
    plain: boolean;
  }
  const drafts = new Map<string, Draft>();
  const draft = (name: string): Draft => {
    let d = drafts.get(name);
    if (!d) drafts.set(name, (d = { env: {}, plain: true }));
    return d;
  };
  let current: { d: Draft; inEnv: boolean } | null = null;
  const lines = text.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (onlyComment(line)) continue;
    const header = /^\s*\[\[?([^\[\]]+)\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      const parts = keyParts(header[1] as string);
      current = null;
      if (parts && parts[0] === 'mcp_servers' && parts[1] !== undefined) {
        const d = draft(parts[1]);
        if (parts.length === 2) current = { d, inEnv: false };
        else if (parts.length === 3 && parts[2] === 'env') current = { d, inEnv: true };
        else d.plain = false; // another sub-table: not a plain server
      }
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    const parts = eq > 0 ? keyParts(line.slice(0, eq)) : null;
    if (!parts || parts.length !== 1) {
      current.d.plain = false;
      continue;
    }
    const k = parts[0] as string;
    let src = line.slice(eq + 1);
    let v = readValue(src);
    while (v === 'more' && i + 1 < lines.length) {
      src += '\n' + (lines[++i] as string);
      v = readValue(src);
    }
    if (v === null || v === 'more') {
      current.d.plain = false;
    } else if (current.inEnv) {
      if (typeof v.value === 'string') current.d.env[k] = v.value;
      else current.d.plain = false;
    } else if (k === 'command' && typeof v.value === 'string') {
      current.d.command = v.value;
    } else if (k === 'args' && Array.isArray(v.value)) {
      current.d.args = v.value;
    } else {
      current.d.plain = false;
    }
  }
  return [...drafts.entries()].map(([name, d]) =>
    d.plain && d.command !== undefined && d.command !== ''
      ? { name, server: { command: d.command, args: d.args ?? [], env: d.env } }
      : { name, reason: NOT_PLAIN },
  );
}
