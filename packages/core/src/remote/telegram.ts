/** A small Telegram Bot API client (https://core.telegram.org/bots/api). `fetch` is injected for tests. */
import fs from 'node:fs';
import path from 'node:path';
import { MagnusError } from '../types.js';

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export type Fetch = typeof fetch;

/** Telegram's limit for a file a bot sends. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Telegram's limit for one message. */
export const MAX_TEXT = 4096;

export class Telegram {
  constructor(
    private readonly token: string,
    private readonly http: Fetch = fetch,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown> | FormData, timeoutMs = 30_000): Promise<T> {
    const isForm = body instanceof FormData;
    let res: Response;
    try {
      res = await this.http(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        ...(isForm ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Never put the URL (it holds the token) into a message.
      throw new MagnusError('TELEGRAM', `could not reach Telegram (${method}): ${e instanceof Error ? e.name : 'error'}`);
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
    if (!data?.ok) {
      const hint = res.status === 401 || res.status === 404 ? 'Check the bot token: magnus secret set TELEGRAM_BOT_TOKEN' : '';
      throw new MagnusError('TELEGRAM', `Telegram refused ${method}: ${data?.description ?? res.status}`, hint);
    }
    return data.result as T;
  }

  /** The bot's own account (checks the token). */
  getMe(): Promise<TgUser & { username?: string }> {
    return this.call('getMe', {});
  }

  /** Waits up to `waitSec` for new updates after `offset`. */
  getUpdates(offset: number, waitSec: number): Promise<TgUpdate[]> {
    return this.call('getUpdates', { offset, timeout: waitSec, allowed_updates: ['message'] }, (waitSec + 15) * 1000);
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const body = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 20) + '\n…(cut)' : text;
    await this.call('sendMessage', { chat_id: chatId, text: body === '' ? '(empty)' : body });
  }

  /** Sends a file from disk as a document. */
  async sendDocument(chatId: number, file: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption !== undefined && caption !== '') form.set('caption', caption.slice(0, 1024));
    form.set('document', await fs.openAsBlob(file), path.basename(file));
    await this.call('sendDocument', form, 120_000);
  }
}
