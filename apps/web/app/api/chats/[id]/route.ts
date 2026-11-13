/** One conversation (ADR 0015): read, rename, delete (moved to chats/deleted, undoable). */
import { deleteChat, getChat, MagnusError, renameChat } from '@magnus/core';
import { api, env } from '@/lib/guard';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  return api('GET', 'any', () => ({ chat: getChat(env(), id) }));
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => null)) as { title?: unknown } | null;
  return api('PATCH', 'any', () => {
    if (typeof b?.title !== 'string' || b.title.trim() === '' || b.title.length > 80) throw new MagnusError('BAD_ARGS', 'a title of 1-80 characters is required');
    return { chat: renameChat(env(), id, b.title) };
  });
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  return api('DELETE', 'any', () => {
    deleteChat(env(), id);
    return { deleted: true };
  });
}
