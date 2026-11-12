/** Claude Code's own `claude mcp` command: Magnus never writes ~/.claude.json itself (ADR 0004). */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCommand } from './run.js';
import type { Env, McpServer } from './types.js';

/** Runs `claude <args>`; `message` is the first line of its output on failure. */
export type ClaudeRunner = (args: readonly string[]) => { ok: boolean; message: string };

export type ClaudeLookup = { runner: ClaudeRunner } | { reason: string };

/**
 * Finds the `claude` program: the native install in the user's home, then (when `searchPath`)
 * PATH. Tests pass their own runner and never reach the real one.
 */
export function findClaude(env: Env, searchPath: boolean, vars: NodeJS.ProcessEnv = process.env): ClaudeLookup {
  const home = ['claude.exe', 'claude'].map((f) => path.join(env.home, '.local', 'bin', f)).find((f) => fs.existsSync(f));
  const file =
    home ?? (searchPath ? resolveCommand('claude', vars['PATH'] ?? vars['Path'] ?? '', vars['PATHEXT'] ?? '.COM;.EXE') : null);
  if (file === null || file === undefined) return { reason: 'the "claude" command was not found' };
  if (/\.(cmd|bat)$/i.test(file)) {
    return { reason: 'this "claude" is a .cmd shim, which Magnus does not drive yet: add the servers with "claude mcp add"' };
  }
  return {
    runner: (args) => {
      const r = spawnSync(file, [...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
      const text = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.trim();
      return { ok: r.status === 0, message: (text.split(/\r?\n/)[0] ?? '').slice(0, 200) };
    },
  };
}

/** The arguments that add a user-scope stdio server. */
export function addArgs(name: string, s: McpServer): string[] {
  const json = JSON.stringify({ type: 'stdio', command: s.command, args: s.args, env: s.env });
  return ['mcp', 'add-json', name, json, '-s', 'user'];
}

export function removeArgs(name: string): string[] {
  return ['mcp', 'remove', name, '-s', 'user'];
}
