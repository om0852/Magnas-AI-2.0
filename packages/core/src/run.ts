/** `magnus run <server>`: start a registered server with its secrets filled in, passing its input and output through. */
import { spawn, type StdioOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry } from './registry.js';
import { readSecrets, resolveServer, secretRefs, type Protector } from './secrets.js';
import { MagnusError, type Env } from './types.js';

/**
 * The file a command name means on Windows: itself when it is a path, else the first match on
 * PATH with one of the PATHEXT endings. Null when nothing is found.
 */
export function resolveCommand(command: string, pathVar: string, pathExt: string): string | null {
  const exts = ['', ...pathExt.split(';').filter((e) => e !== '')];
  const candidates = (base: string): string[] => exts.map((e) => base + e);
  const isFile = (f: string): boolean => fs.existsSync(f) && fs.statSync(f).isFile();
  if (/[\\/]/.test(command)) return candidates(command).find(isFile) ?? null;
  for (const dir of pathVar.split(path.delimiter).filter((d) => d !== '')) {
    const hit = candidates(path.join(dir, command)).find(isFile);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** One argument for a cmd.exe command line. */
function cmdQuote(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface RunOptions {
  protector: () => Protector;
  /** Default 'inherit': the server talks straight to the AI tool. */
  stdio?: StdioOptions;
  vars?: NodeJS.ProcessEnv;
}

/** Starts the server and resolves with its exit code. */
export function runServer(env: Env, name: string, opts: RunOptions): Promise<{ code: number; stdout: string }> {
  const reg = loadRegistry(env);
  const server = reg.mcpServers[name];
  if (!server) throw new MagnusError('NOT_FOUND', `no MCP server "${name}" in the registry`);
  const refs = secretRefs(server);
  const resolved = refs.length > 0 ? resolveServer(server, readSecrets(env, opts.protector(), refs)) : server;
  const vars = opts.vars ?? process.env;
  const win = process.platform === 'win32';
  const file = win
    ? resolveCommand(resolved.command, vars['PATH'] ?? vars['Path'] ?? '', vars['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    : resolved.command;
  if (file === null) throw new MagnusError('NOT_FOUND', `command not found: ${resolved.command}`);

  const childEnv = { ...vars, ...resolved.env };
  const stdio = opts.stdio ?? 'inherit';
  // A .cmd/.bat file (e.g. npx) cannot be started directly: it goes through cmd.exe.
  const child = /\.(cmd|bat)$/i.test(file)
    ? spawn(/* turbopackIgnore: true */ 'cmd.exe', ['/d', '/s', '/c', `"${[file, ...resolved.args].map(cmdQuote).join(' ')}"`], {
        env: childEnv,
        stdio,
        windowsVerbatimArguments: true,
        windowsHide: true,
      })
    : spawn(/* turbopackIgnore: true */ file, resolved.args, { env: childEnv, stdio, windowsHide: true });

  let stdout = '';
  child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  const stop = (): void => void child.kill();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new MagnusError('RUN', `could not start "${name}": ${e.message}`)));
    child.on('exit', (code) => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve({ code: code ?? 1, stdout });
    });
  });
}
