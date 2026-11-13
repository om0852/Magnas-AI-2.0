/** Tasks from Magnus and the AI tools (ADR 0013): list, and answer a question. */
import { answerQuestion, listTasks, MagnusError } from '@magnus/core';
import { api, env } from '@/lib/guard';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return api('GET', 'any', () => ({ tasks: listTasks(env(), 30) }));
}

export async function POST(request: Request): Promise<Response> {
  const b = (await request.json().catch(() => null)) as { task?: unknown; qid?: unknown; answer?: unknown } | null;
  return api('POST', 'any', (who) => {
    if (typeof b?.task !== 'string' || typeof b.qid !== 'string' || typeof b.answer !== 'string' || b.answer.trim() === '' || b.answer.length > 2000) {
      throw new MagnusError('BAD_ARGS', 'task, qid and an answer (1-2000 characters) are required');
    }
    answerQuestion(env(), b.task, b.qid, b.answer, who.who === 'device' ? 'phone' : 'dashboard');
    return { answered: true };
  });
}
