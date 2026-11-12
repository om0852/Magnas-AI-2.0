/** The Telegram bot loop: owner only, one task at a time, stale messages skipped (ADR 0008). */
import type { AskResult } from '../brain/ask.js';
import type { Env } from '../types.js';
import { PHONE_SERVER } from './phone-mcp.js';
import { loadRemote, tryPair } from './state.js';
import type { Telegram, TgMessage, TgUpdate } from './telegram.js';

/** Runs a task for the owner (the brain with the phone tools). Injected in tests. */
export type RunTask = (task: string) => Promise<AskResult>;

export interface BotDeps {
  telegram: Pick<Telegram, 'getUpdates' | 'sendMessage'>;
  runTask: RunTask;
  log: (line: string) => void;
  /** Unix seconds; messages sent before the bot started are skipped. */
  startedAt: number;
}

const HELP = [
  'Send me a task in plain words and I will do it on your PC. For example:',
  '• Open YouTube in Firefox',
  '• Find my resume and send it to me here',
  '',
  'Risky steps (sending, deleting, settings) still need your OK on the PC screen.',
  '/status — is Magnus running',
].join('\n');

/** The note a phone task carries for the brain. */
export function phoneTask(text: string): string {
  return `${text.trim()}\n\n(This task came from the user's phone. To give them a file, use the ${PHONE_SERVER}__send_file tool; it reaches only their own phone.)`;
}

export class Bot {
  private busy = false;
  private readonly pending: Promise<void>[] = [];

  constructor(
    private readonly env: Env,
    private readonly deps: BotDeps,
  ) {}

  /** True while a task is running. */
  get working(): boolean {
    return this.busy;
  }

  /** Waits for a running task (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all(this.pending);
  }

  /** Handles one update. Messages from anyone but the owner get no answer. */
  async handle(u: TgUpdate): Promise<void> {
    const m = u.message;
    if (!m || m.text === undefined || m.from === undefined || m.from.is_bot === true) return;
    if (m.date < this.deps.startedAt) return; // sent while Magnus was not running
    const text = m.text.trim();
    const owner = loadRemote(this.env).owner;

    const pair = /^\/pair(?:@\w+)?\s+(\d{6})$/.exec(text);
    if (pair) return this.pair(m, pair[1] as string);
    if (!owner || owner.userId !== m.from.id || owner.chatId !== m.chat.id) {
      if (owner === undefined || owner.userId !== m.from.id) this.deps.log(`ignored a message from Telegram user ${m.from.id}`);
      return;
    }
    if (/^\/(start|help)\b/.test(text)) return this.reply(m, HELP);
    if (/^\/status\b/.test(text)) return this.reply(m, this.busy ? 'Magnus is running on your PC and working on a task.' : 'Magnus is running on your PC and ready.');
    if (text.startsWith('/')) return this.reply(m, 'Unknown command. /help shows what I can do.');
    if (this.busy) return this.reply(m, 'Still working on the previous task. Send this again when it is done.');
    this.busy = true;
    const work = this.runTask(m, text).finally(() => {
      this.busy = false;
    });
    this.pending.push(work);
    await this.reply(m, 'Working on it…');
  }

  private async runTask(m: TgMessage, text: string): Promise<void> {
    this.deps.log(`task from the owner: ${text.slice(0, 80)}`);
    try {
      const res = await this.deps.runTask(phoneTask(text));
      const head = res.ok ? '' : res.stoppedBecause !== undefined ? `Not finished (${res.stoppedBecause}).\n\n` : 'Not finished.\n\n';
      await this.reply(m, head + res.answer);
    } catch (e) {
      await this.reply(m, `Magnus could not run the task: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async pair(m: TgMessage, code: string): Promise<void> {
    if (m.chat.type !== 'private') return; // only a private chat can become the owner
    const from = m.from as NonNullable<TgMessage['from']>;
    const r = tryPair(this.env, code, { userId: from.id, chatId: m.chat.id, ...(from.first_name !== undefined ? { name: from.first_name } : {}) });
    this.deps.log(`pairing attempt from Telegram user ${from.id}: ${r}`);
    const words: Record<typeof r, string> = {
      paired: 'Paired. This chat now controls Magnus on your PC. /help shows what I can do.',
      'no-pairing': '',
      expired: 'That code has expired. Run "magnus remote pair" on the PC for a new one.',
      wrong: 'Wrong code.',
      'no-tries-left': 'Wrong code, and no tries are left. Run "magnus remote pair" on the PC for a new one.',
    };
    if (words[r] !== '') await this.reply(m, words[r]);
  }

  private async reply(m: TgMessage, text: string): Promise<void> {
    try {
      await this.deps.telegram.sendMessage(m.chat.id, text);
    } catch (e) {
      this.deps.log(`could not answer on Telegram: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Polls until `stop()` returns true. */
  async run(stop: () => boolean, waitSec = 25): Promise<void> {
    let offset = 0;
    while (!stop()) {
      let updates: TgUpdate[];
      try {
        updates = await this.deps.telegram.getUpdates(offset, waitSec);
      } catch (e) {
        this.deps.log(e instanceof Error ? e.message : String(e));
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        await this.handle(u);
      }
    }
    await this.idle();
  }
}
