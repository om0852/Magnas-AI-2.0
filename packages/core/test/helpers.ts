/** Test helpers: a throwaway home and fakes for the outside world. Never the real home. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, type CliDeps } from '../src/cli.js';
import type { Protector } from '../src/secrets.js';
import type { Env } from '../src/types.js';

/** A home with Codex, VS Code and Claude Code "installed". */
export function fakeHome(): Env {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magnus-test-'));
  const env: Env = { home, appData: path.join(home, 'AppData', 'Roaming'), magnusHome: path.join(home, '.magnus') };
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n');
  fs.mkdirSync(path.join(env.appData, 'Code', 'User'), { recursive: true });
  fs.writeFileSync(path.join(env.appData, 'Code', 'User', 'mcp.json'), '{"servers":{"mine":{"command":"m"}}}');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# Mine\n');
  return env;
}

/** Not encryption: just proves values go through the protector and never sit in the store as typed. */
export const fakeProtector: Protector = {
  protect: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
  unprotect: (blobs) => blobs.map((b) => Buffer.from(b, 'base64').toString().slice(4)),
};

export interface Fakes {
  deps: CliDeps;
  /** Every `claude …` call made. */
  claudeCalls: string[][];
  /** The value the next `secret set` reads. */
  typed: { value: string };
  /** Every `magnus ask` run: the servers it was given and the prompt the brain got. */
  brainCalls: { servers: string[]; prompt: string }[];
}

/** A fake `claude mcp` that edits the fake home's ~/.claude.json, as the real one edits the real file. */
export function fakes(env: Env, opts: { claude?: 'ok' | 'missing' | 'fails' } = {}): Fakes {
  const claudeCalls: string[][] = [];
  const brainCalls: { servers: string[]; prompt: string }[] = [];
  const typed = { value: '' };
  const file = path.join(env.home, '.claude.json');
  const runner = (args: readonly string[]): { ok: boolean; message: string } => {
    claudeCalls.push([...args]);
    if (opts.claude === 'fails') return { ok: false, message: 'boom' };
    const root = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> }) : {};
    const servers = (root.mcpServers ??= {});
    const name = args[2] as string;
    if (args[1] === 'add-json') servers[name] = JSON.parse(args[3] as string);
    else if (args[1] === 'remove') delete servers[name];
    fs.writeFileSync(file, JSON.stringify(root));
    return { ok: true, message: '' };
  };
  return {
    claudeCalls,
    typed,
    deps: {
      sync: {
        self: { command: 'node', args: ['C:\\magnus\\cli.js'] },
        claude: opts.claude === 'missing' ? { reason: 'the "claude" command was not found' } : { runner },
      },
      protector: () => fakeProtector,
      readSecret: () => Promise.resolve(typed.value),
      brains: (servers) => {
        brainCalls.push({ servers: [...servers], prompt: '' });
        return {
          codex: async (prompt) => {
            (brainCalls.at(-1) as { prompt: string }).prompt = prompt;
            return { ok: true, answer: 'fake: done', toolCalls: ['xtraos__status'], callsKnown: true, timedOut: false, ms: 5 };
          },
          antigravity: null,
        };
      },
    },
    brainCalls,
  };
}

/** Runs one CLI command against the fake home. */
export async function run(env: Env, f: Fakes, ...argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await main(argv, env, (l) => lines.push(l), f.deps);
  return { code, out: lines.join('\n') };
}
