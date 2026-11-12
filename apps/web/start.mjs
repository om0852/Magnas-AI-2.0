// Starts the dashboard on 127.0.0.1 with a fresh token for this run, and prints the link (ADR 0006).
//   node start.mjs        the built app (run `npm run build` first)
//   node start.mjs dev    development mode
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] === 'dev' ? 'dev' : 'start';
const port = Number(process.env.MAGNUS_DASH_PORT ?? 4747);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad MAGNUS_DASH_PORT "${process.env.MAGNUS_DASH_PORT}"`);
const token = process.env.MAGNUS_DASH_TOKEN ?? crypto.randomBytes(24).toString('base64url');
const require = createRequire(import.meta.url);
const next = require.resolve('next/dist/bin/next');
// Where the `magnus` command really is: the app is bundled, so it cannot find this itself.
const cli = path.join(path.dirname(require.resolve('@magnus/core')), 'cli.js');

console.log(`Magnus dashboard (this PC only). Open:\n  http://127.0.0.1:${port}/api/enter?token=${token}\n`);
// ADR 0009: addresses paired phones use (e.g. the Tailscale name); empty = remote access off.
const remote = (process.env.MAGNUS_REMOTE_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
const scheme = (h) => (/^(localhost|127\.0\.0\.1)(:|$)/.test(h) ? 'http' : 'https');
if (remote.length > 0) console.log(`Paired phones open: ${remote.map((h) => `${scheme(h)}://${h}/m`).join(', ')}\n`);
const child = spawn(process.execPath, [next, mode, '-H', '127.0.0.1', '-p', String(port)], {
  cwd: here,
  stdio: 'inherit',
  env: { ...process.env, MAGNUS_DASH_PORT: String(port), MAGNUS_DASH_TOKEN: token, MAGNUS_CLI: cli },
});
child.on('exit', (code) => process.exit(code ?? 0));
