/** What a paired phone may ask the PC to do (ADR 0009/0010). Shared by the relay connector. */
import type { RunOptions } from '../brain/runners.js';
import { MagnusError } from '../types.js';
import type { XtraosCall } from '../xtraos.js';
import { controlsFrom } from './controls.js';

export interface RpcDevice {
  id: string;
  name: string;
  approverId?: string;
}

export interface RpcDeps {
  xtraos: XtraosCall;
  /** Runs a task through the brain; the answer text. Progress and Stop: ADR 0012. */
  ask: (task: string, opts?: RunOptions, chat?: { id?: string }) => Promise<{ ok: boolean; answer: string; brain: string | null; chatId?: string; title?: string }>;
  /** Conversations (ADR 0015). */
  chats?: { list: () => unknown; get: (id: string) => unknown; rename: (id: string, title: string) => unknown; remove: (id: string) => void };
  /** Remembers the device's XtraOS approver id. */
  setApprover: (deviceId: string, approverId: string) => void;
  /** The task log (ADR 0013). */
  tasks?: { list: () => unknown; answer: (task: string, qid: string, answer: string) => void };
}

const isRef = (v: unknown, k: 'w' | 'e'): v is string => typeof v === 'string' && new RegExp(`^${k}\\d+$`).test(v);

/** Runs one call from a phone. Throws MagnusError for things the phone should show. */
export async function rpc(method: string, p: Record<string, unknown>, device: RpcDevice, deps: RpcDeps, run: RunOptions = {}): Promise<unknown> {
  const x = deps.xtraos;
  switch (method) {
    case 'ping':
      return { pong: true, device: device.name };
    case 'approvals.list': {
      const r = (await x('approvals.list', {}, 10_000)) as { dialogs: unknown[] };
      return { dialogs: r.dialogs, canAnswer: device.approverId !== undefined, approverId: device.approverId ?? null };
    }
    case 'approvals.answer': {
      if (device.approverId === undefined) throw new MagnusError('NOT_APPROVER', 'allow this device on the PC first');
      // XtraOS checks the signature; the device id comes from the pairing, not from the phone.
      return x('approvals.answer', { device: device.approverId, uid: p['uid'], button: p['button'], issued_ms: p['issued_ms'], signature: p['signature'] }, 15_000);
    }
    case 'approver.add': {
      if (typeof p['publicKey'] !== 'string') throw new MagnusError('BAD_ARGS', 'publicKey is required');
      const r = (await x('approvers.add', { name: device.name, public_key: p['publicKey'] }, 150_000)) as { id?: string };
      if (typeof r.id !== 'string') throw new MagnusError('XTRAOS', 'XtraOS did not return an approver id');
      deps.setApprover(device.id, r.id);
      device.approverId = r.id;
      return { approverId: r.id };
    }
    case 'windows': {
      const r = (await x('list_windows', {})) as { windows: { ref: string; title: string; process: string; state: string; focused: boolean }[] };
      return { windows: r.windows.map((w) => ({ ref: w.ref, title: w.title, process: w.process, state: w.state, focused: w.focused })) };
    }
    case 'window': {
      if (!isRef(p['w'], 'w')) throw new MagnusError('BAD_ARGS', 'w must be a window ref');
      const [text, seen] = await Promise.all([
        x('read_text', { window: p['w'], last_lines: 60 }).catch((e: unknown) => ({ text: `(could not read the text: ${e instanceof Error ? e.message : String(e)})` })),
        x('observe', { window: p['w'], full: true, max_elements: 200 }),
      ]);
      const lines = typeof seen === 'string' ? seen : String((seen as { text?: unknown }).text ?? '');
      return { text: String((text as { text?: unknown }).text ?? ''), ...controlsFrom(lines) };
    }
    case 'act': {
      if (!isRef(p['window'], 'w')) throw new MagnusError('BAD_ARGS', 'window ref is required');
      const ref = isRef(p['ref'], 'e') ? p['ref'] : undefined;
      if (p['op'] === 'click') {
        if (ref === undefined) throw new MagnusError('BAD_ARGS', 'ref is required');
        return x('click', { window: p['window'], ref }, 90_000);
      }
      if (p['op'] === 'type') {
        const text = p['text'];
        if (typeof text !== 'string' || text === '' || text.length > 4000) throw new MagnusError('BAD_ARGS', 'text is 1-4000 characters');
        return x('type', { window: p['window'], ...(ref !== undefined ? { ref } : {}), text, submit: p['submit'] === true }, 90_000);
      }
      throw new MagnusError('BAD_ARGS', 'op is click or type');
    }
    case 'ask': {
      const task = p['task'];
      if (typeof task !== 'string' || task.trim() === '' || task.length > 4000) throw new MagnusError('BAD_ARGS', 'task is 1-4000 characters');
      // chat: "new" starts a conversation, a chat id continues one (ADR 0015); absent: a one-off task.
      const chat = p['chat'];
      if (chat === undefined) return deps.ask(task, run);
      if (chat !== 'new' && (typeof chat !== 'string' || !/^c_[0-9a-f]{16}$/.test(chat))) throw new MagnusError('BAD_ARGS', 'chat is "new" or a chat id');
      return deps.ask(task, run, chat === 'new' ? {} : { id: chat });
    }
    case 'chats.list':
    case 'chats.get':
    case 'chats.rename':
    case 'chats.delete': {
      const c = deps.chats;
      if (!c) throw new MagnusError('BAD_ARGS', 'chats are not available here');
      if (method === 'chats.list') return { chats: c.list() };
      const id = p['id'];
      if (typeof id !== 'string' || !/^c_[0-9a-f]{16}$/.test(id)) throw new MagnusError('BAD_ARGS', 'a chat id is required');
      if (method === 'chats.get') return { chat: c.get(id) };
      if (method === 'chats.delete') {
        c.remove(id);
        return { deleted: true };
      }
      const title = p['title'];
      if (typeof title !== 'string' || title.trim() === '' || title.length > 80) throw new MagnusError('BAD_ARGS', 'a title of 1-80 characters is required');
      return { chat: c.rename(id, title) };
    }
    case 'tasks.list':
      if (!deps.tasks) throw new MagnusError('BAD_ARGS', 'tasks are not available here');
      return { tasks: deps.tasks.list() };
    case 'tasks.answer': {
      if (!deps.tasks) throw new MagnusError('BAD_ARGS', 'tasks are not available here');
      const answer = p['answer'];
      if (typeof p['task'] !== 'string' || typeof p['qid'] !== 'string' || typeof answer !== 'string' || answer.trim() === '' || answer.length > 2000) {
        throw new MagnusError('BAD_ARGS', 'task, qid and an answer (1-2000 characters) are required');
      }
      deps.tasks.answer(p['task'], p['qid'], answer);
      return { answered: true };
    }
    default:
      throw new MagnusError('BAD_ARGS', `unknown call "${method}"`);
  }
}
