/** Starting the installed AI CLIs headless (ADR 0007). Argument building is pure; running is not. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCommand } from '../run.js';
import type { Env } from '../types.js';
import { parseAgyLine, parseCodexLine, type Progress } from './progress.js';
import type { BrainId } from './prompt.js';

/** How to start a brain: a program and its leading arguments. */
export interface Launcher {
  command: string;
  args: string[];
}

export interface BrainRun {
  ok: boolean;
  /** The brain's final answer (or the error it printed). */
  answer: string;
  /** MCP tool calls it made, as far as the CLI tells (Codex prints them; Antigravity does not). */
  toolCalls: string[];
  /** True when the CLI reports tool calls; false means toolCalls is unknown, not empty. */
  callsKnown: boolean;
  timedOut: boolean;
  /** The user pressed Stop (ADR 0012). */
  stopped?: boolean;
  ms: number;
}

/** Live progress and the Stop button (ADR 0012). */
export interface RunOptions {
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

/** Runs one brain on a prompt. Injected so tests need no real CLI. */
export type BrainRunner = (prompt: string, timeoutMs: number, opts?: RunOptions) => Promise<BrainRun>;

/**
 * The Codex launcher: `codex.js` started with Node (the npm `codex` is a .cmd shim, which would
 * need cmd.exe and its quoting), or a real codex.exe. Null when Codex is not installed.
 */
export function findCodex(vars: NodeJS.ProcessEnv = process.env): Launcher | null {
  const found = resolveCommand('codex', vars['PATH'] ?? vars['Path'] ?? '', vars['PATHEXT'] ?? '.COM;.EXE;.CMD');
  if (found === null) return null;
  if (/\.exe$/i.test(found)) return { command: found, args: [] };
  const js = path.join(path.dirname(found), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return fs.existsSync(js) ? { command: process.execPath, args: [js] } : null;
}

/** The Antigravity CLI: its own install folder, then PATH. */
export function findAgy(vars: NodeJS.ProcessEnv = process.env): Launcher | null {
  const own = path.join(vars['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe');
  if (fs.existsSync(own)) return { command: own, args: [] };
  const found = resolveCommand('agy', vars['PATH'] ?? vars['Path'] ?? '', '.EXE');
  return found === null ? null : { command: found, args: [] };
}

/** `codex exec` with only the Magnus hub (pure). `hub`: how to start `magnus hub`. */
export function codexArgs(prompt: string, hub: Launcher, servers: readonly string[], magnusHome: string, lastFile: string): string[] {
  const toml = (v: unknown): string => JSON.stringify(v);
  return [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '--json',
    '-c',
    `mcp_servers.magnus.command=${toml(hub.command)}`,
    '-c',
    `mcp_servers.magnus.args=${toml([...hub.args, 'hub', '--servers', servers.join(',')])}`,
    '-c',
    `mcp_servers.magnus.env.MAGNUS_HOME=${toml(magnusHome)}`,
    '-c',
    'mcp_servers.magnus.default_tools_approval_mode="approve"',
    '-c',
    'mcp_servers.magnus.startup_timeout_sec=60',
    '-o',
    lastFile,
    prompt,
  ];
}

/** `agy -p` (pure). */
export function agyArgs(prompt: string, timeoutMs: number): string[] {
  return ['-p', prompt, '--sandbox', '--output-format', 'stream-json', '--print-timeout', `${Math.max(10, Math.floor(timeoutMs / 1000) - 5)}s`];
}

/** The MCP calls Codex printed on stderr ("mcp: magnus/<tool> started"). Pure. */
export function codexToolCalls(stderr: string): string[] {
  return [...stderr.matchAll(/^mcp: magnus\/(\S+) started$/gm)].map((m) => m[1] as string);
}

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stopped: boolean;
  ms: number;
}

/**
 * Runs a program with no input in an empty folder, stopping it after `timeoutMs` or when
 * `signal` aborts. `onLine` gets each stdout line as it arrives.
 */
function runIn(cwd: string, l: Launcher, args: string[], timeoutMs: number, onLine?: (line: string) => void, signal?: AbortSignal): Promise<Spawned> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(/* turbopackIgnore: true */ l.command, [...l.args, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let stopped = false;
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stdout += s;
      pending += s;
      let i: number;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i).trim();
        pending = pending.slice(i + 1);
        if (line !== '') onLine?.(line);
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const stop = (): void => {
      stopped = true;
      child.kill();
    };
    if (signal?.aborted === true) stop();
    signal?.addEventListener('abort', stop, { once: true });
    const done = (code: number | null): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (pending.trim() !== '') onLine?.(pending.trim());
      resolve({ code, stdout, stderr, timedOut, stopped, ms: Date.now() - t0 });
    };
    child.on('error', (e) => {
      stderr += e.message;
      done(null);
    });
    child.on('exit', done);
  });
}

function workDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magnus-brain-'));
}

/** The Codex brain with the hub limited to `servers`. */
export function codexRunner(codex: Launcher, hub: Launcher, servers: readonly string[], env: Env): BrainRunner {
  return async (prompt, timeoutMs, opts = {}) => {
    const cwd = workDir();
    const last = path.join(cwd, 'answer.txt');
    const t0 = Date.now();
    const calls: string[] = [];
    let said = '';
    const r = await runIn(
      cwd,
      codex,
      codexArgs(prompt, hub, servers, env.magnusHome, last),
      timeoutMs,
      (line) => {
        const p = parseCodexLine(line);
        if (p.toolCall !== undefined) calls.push(p.toolCall);
        if (p.answer !== undefined) said = p.answer;
        if (p.step) opts.onProgress?.({ ...p.step, ms: Date.now() - t0 });
      },
      opts.signal,
    );
    const file = fs.existsSync(last) ? fs.readFileSync(last, 'utf8').trim() : '';
    const answer = file !== '' ? file : said.trim();
    fs.rmSync(cwd, { recursive: true, force: true });
    const tail = r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    const toolCalls = calls.length > 0 ? calls : codexToolCalls(r.stderr);
    return {
      ok: r.code === 0 && !r.timedOut && !r.stopped && answer !== '',
      answer: r.stopped ? 'Stopped by you.' : answer !== '' ? answer : r.timedOut ? 'stopped: time limit reached' : tail,
      toolCalls,
      callsKnown: true,
      timedOut: r.timedOut,
      stopped: r.stopped,
      ms: r.ms,
    };
  };
}

/** The Antigravity brain (its own MCP servers; the prompt names the allowed ones). */
export function agyRunner(agy: Launcher): BrainRunner {
  return async (prompt, timeoutMs, opts = {}) => {
    const cwd = workDir();
    const t0 = Date.now();
    const calls: string[] = [];
    let answer = '';
    let text = '';
    let parsedAny = false;
    const r = await runIn(
      cwd,
      agy,
      agyArgs(prompt, timeoutMs),
      timeoutMs,
      (line) => {
        const p = parseAgyLine(line);
        if (p.step || p.toolCall !== undefined || p.answer !== undefined || p.textDelta !== undefined) parsedAny = true;
        if (p.toolCall !== undefined) calls.push(p.toolCall);
        if (p.step) opts.onProgress?.({ ...p.step, ms: Date.now() - t0 });
        if (p.textDelta !== undefined) text += p.textDelta;
        if (p.responseDone === true && text.trim() !== '') {
          opts.onProgress?.({ kind: 'say', text: text.trim().slice(0, 400), ms: Date.now() - t0 });
          text = '';
        }
        if (p.answer !== undefined) answer = p.answer;
      },
      opts.signal,
    );
    fs.rmSync(cwd, { recursive: true, force: true });
    return {
      ok: r.code === 0 && !r.timedOut && !r.stopped && answer !== '',
      answer: r.stopped ? 'Stopped by you.' : answer !== '' ? answer : r.timedOut ? 'stopped: time limit reached' : r.stderr.trim().slice(0, 300),
      toolCalls: calls,
      // Its JSON stream names every tool call (ADR 0012); without a stream nothing is known.
      callsKnown: parsedAny,
      timedOut: r.timedOut,
      stopped: r.stopped,
      ms: r.ms,
    };
  };
}

export const BRAIN_NAMES: Record<BrainId, string> = { codex: 'Codex CLI', antigravity: 'Antigravity CLI' };
