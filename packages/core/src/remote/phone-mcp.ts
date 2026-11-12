/** The `phone` MCP server: send a file or a message to the paired owner's Telegram chat, and nowhere else (ADR 0008). */
import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readSecrets, type Protector } from '../secrets.js';
import { MagnusError, type Env } from '../types.js';
import { loadRemote, TOKEN_SECRET } from './state.js';
import { MAX_FILE_BYTES, Telegram } from './telegram.js';

export const PHONE_SERVER = 'phone';

/** Where a send goes: the owner's chat. */
export interface PhoneTarget {
  telegram: Pick<Telegram, 'sendDocument' | 'sendMessage'>;
  chatId: number;
}

function text(t: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
}

/** Checks a file before sending (pure apart from reading its size). Null when it may go. */
export function fileProblem(file: string): string | null {
  if (!path.isAbsolute(file)) return 'give the full path of the file';
  if (!fs.existsSync(file)) return `no such file: ${file}`;
  const st = fs.statSync(file);
  if (!st.isFile()) return 'that is a folder, not a file';
  if (st.size > MAX_FILE_BYTES) return `the file is ${(st.size / 1024 / 1024).toFixed(1)} MB; Telegram takes at most 50 MB`;
  if (st.size === 0) return 'the file is empty';
  return null;
}

/** The phone server's tools, given where they send. */
export function makePhoneServer(target: () => PhoneTarget): Server {
  const server = new Server(
    { name: PHONE_SERVER, version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: "Sends to the user's own phone (their Telegram chat with Magnus). There is no other recipient." },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'send_file',
        description: "Send a file from this PC to the user's phone (their Telegram chat with Magnus). Full path; at most 50 MB.",
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Full path of the file' }, caption: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        name: 'send_message',
        description: "Send a short text to the user's phone (their Telegram chat with Magnus).",
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    let t: PhoneTarget;
    try {
      t = target();
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
    try {
      if (req.params.name === 'send_file') {
        if (typeof args['path'] !== 'string') return text('"path" is required', true);
        const bad = fileProblem(args['path']);
        if (bad !== null) return text(bad, true);
        const caption = typeof args['caption'] === 'string' ? args['caption'] : undefined;
        await t.telegram.sendDocument(t.chatId, args['path'], caption);
        return text(`sent ${path.basename(args['path'])} to the user's phone`);
      }
      if (req.params.name === 'send_message') {
        if (typeof args['text'] !== 'string' || args['text'].trim() === '') return text('"text" is required', true);
        await t.telegram.sendMessage(t.chatId, args['text']);
        return text("sent to the user's phone");
      }
      return text(`unknown tool "${req.params.name}"`, true);
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  });
  return server;
}

/** The real target: the paired owner and the bot token from the secret store. */
export function ownerTarget(env: Env, protector: () => Protector): PhoneTarget {
  const owner = loadRemote(env).owner;
  if (!owner) throw new MagnusError('NOT_PAIRED', 'no phone is paired', 'Run: magnus remote pair');
  const token = readSecrets(env, protector(), [TOKEN_SECRET]).get(TOKEN_SECRET) ?? '';
  return { telegram: new Telegram(token), chatId: owner.chatId };
}

/** `magnus phone-mcp`: the phone server on stdin/stdout (started by the hub). */
export async function runPhoneMcp(env: Env, protector: () => Protector): Promise<number> {
  let cached: PhoneTarget | undefined;
  const server = makePhoneServer(() => (cached ??= ownerTarget(env, protector)));
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    process.stdin.once('end', () => resolve());
  });
  await server.connect(new StdioServerTransport());
  await closed;
  return 0;
}
