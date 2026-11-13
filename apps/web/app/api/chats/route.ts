/** Conversations (ADR 0015): the list, newest first. */
import { listChats } from '@magnus/core';
import { api, env } from '@/lib/guard';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return api('GET', 'any', () => ({ chats: listChats(env()) }));
}
