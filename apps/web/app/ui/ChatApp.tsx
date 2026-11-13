'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MicButton } from './AskPanel';
import { setVoiceLang, voiceLang, VOICE_LANGS } from '@/lib/voice';

/** ChatGPT-style chat with memory (ADR 0015), on the PC dashboard. */

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  brain?: string | null;
  ok?: boolean;
  steps?: string[];
}
interface ChatSum {
  id: string;
  title: string;
  updated: string;
  preview: string;
}
interface Step {
  kind: string;
  text: string;
  ms: number;
}

const SUGGEST = ['What is open on my PC right now?', 'Is Claude Code waiting for me?', 'Play the latest episode in my Downloads'];
const ICON: Record<string, string> = { tool: '🔧', 'tool-done': '✓', 'tool-failed': '✗' };

/** Line icons (static SVG paths, never user text). */
const PATHS: Record<string, string> = {
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  newchat: '<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
  home: '<path d="m3 11 9-7 9 7"/><path d="M5 10v10h14V10"/>',
  send: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
};
function Ico({ n, s = 18 }: { n: string; s?: number }) {
  return (
    <span className="ico" aria-hidden="true">
      <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: PATHS[n] ?? '' }} />
    </span>
  );
}

async function json<T>(res: Response): Promise<T> {
  const b = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(b.error ?? `failed (${res.status})`);
  return b;
}

function Bubble({ m }: { m: Msg }) {
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">{m.text}</div>
      </div>
    );
  }
  const steps = m.steps ?? [];
  return (
    <div className="msg magnus">
      <span className="mark small-mark" aria-hidden="true">M</span>
      <div className="msg-body">
        <div className={m.ok === false ? 'reply failed' : 'reply'}>{m.text}</div>
        {steps.length > 0 && (
          <details className="used">
            <summary>
              {steps.length} step{steps.length === 1 ? '' : 's'}
              {m.brain ? ` · ${m.brain}` : ''}
            </summary>
            <ol>
              {steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </div>
  );
}

export function ChatApp() {
  const [chats, setChats] = useState<ChatSum[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [title, setTitle] = useState('New chat');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [live, setLive] = useState<Step[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // A question from the brain while it works (magnus__ask_user, ADR 0013), answered in the chat.
  const [ask, setAsk] = useState<{ task: string; qid: string; text: string; options: string[]; sent?: string } | null>(null);
  const [askText, setAskText] = useState('');
  const asking = useRef('');
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => {
    try {
      setChats((await json<{ chats: ChatSum[] }>(await fetch('/api/chats'))).chats);
    } catch {
      // the next action tries again
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [msgs, live]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    el.style.overflowY = el.scrollHeight > 200 ? 'auto' : 'hidden';
  }, [text]);

  useEffect(() => {
    if (!busy) {
      setAsk(null);
      return;
    }
    const norm = (x: string): string => x.replace(/\s+/g, ' ').trim().slice(0, 100);
    const t = setInterval(() => {
      void fetch('/api/tasks')
        .then((r) => r.json() as Promise<{ tasks?: { id: string; title: string; status: string; question?: { qid: string; text: string; options: string[] } }[] }>)
        .then((b) => {
          const q = (b.tasks ?? []).find((x) => x.status === 'needs-you' && x.question && norm(x.title) === norm(asking.current));
          if (q?.question) setAsk((a) => (a?.qid === q.question?.qid ? a : { task: q.id, qid: q.question!.qid, text: q.question!.text, options: q.question!.options }));
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [busy]);

  async function answer(a: string) {
    if (!ask || a.trim() === '') return;
    try {
      await json(await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: ask.task, qid: ask.qid, answer: a.trim() }) }));
      setAsk({ ...ask, sent: a.trim() });
      setAskText('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function openChat(id: string | null) {
    setOpen(false);
    setMenu(null);
    setErr(null);
    setLive(null);
    setCurrent(id);
    if (id === null) {
      setTitle('New chat');
      setMsgs([]);
      input.current?.focus();
      return;
    }
    try {
      const { chat } = await json<{ chat: { title: string; messages: Msg[] } }>(await fetch(`/api/chats/${id}`));
      setTitle(chat.title);
      setMsgs(chat.messages);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function rename(c: ChatSum) {
    const t = prompt('Rename the chat', c.title);
    if (t === null || t.trim() === '') return;
    try {
      await json(await fetch(`/api/chats/${c.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: t.trim().slice(0, 80) }) }));
      if (current === c.id) setTitle(t.trim());
      setMenu(null);
      void refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(c: ChatSum) {
    if (!confirm(`Delete "${c.title}"?`)) return;
    try {
      await json(await fetch(`/api/chats/${c.id}`, { method: 'DELETE' }));
      if (current === c.id) void openChat(null);
      void refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function send() {
    const t = text.trim();
    if (t === '' || busy) return;
    setText('');
    setErr(null);
    asking.current = t;
    setMsgs((m) => [...m, { role: 'user', text: t, at: '' }]);
    setLive([]);
    setBusy(true);
    const steps: string[] = [];
    let done: Msg | null = null;
    try {
      const res = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: t, chat: current ?? 'new' }) });
      if (!res.ok || !res.body) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const m = JSON.parse(line) as { progress?: Step; result?: { ok: boolean; answer: string; brain: string | null; chatId?: string; title?: string }; error?: string };
          if (m.progress && m.progress.kind in ICON) {
            if (m.progress.kind === 'tool') steps.push(m.progress.text);
            setLive((s) => [...(s ?? []), m.progress as Step]);
          }
          if (m.result) {
            done = { role: 'assistant', text: m.result.answer, at: '', ok: m.result.ok, brain: m.result.brain, steps: [...steps] };
            if (current === null && m.result.chatId) {
              setCurrent(m.result.chatId);
              setTitle(m.result.title ?? 'Chat');
            }
          }
          if (m.error !== undefined) throw new Error(m.error);
        }
      }
    } catch (e) {
      done = { role: 'assistant', text: e instanceof Error ? e.message : String(e), at: '', ok: false };
    } finally {
      const reply = done ?? { role: 'assistant' as const, text: 'No answer came back.', at: '', ok: false };
      setMsgs((m) => [...m, reply]);
      setLive(null);
      setBusy(false);
      void refresh();
    }
  }

  return (
    <main className={open ? 'shell open' : 'shell'}>
      <header className="bar">
        <button className="icon-btn menu-btn" aria-label="Open the menu" onClick={() => setOpen(true)}><Ico n="menu" s={22} /></button>
        <div className="bar-title">{title}</div>
        <a className="icon-btn" href="/manage" aria-label="Tools and settings" title="Tools & settings"><Ico n="home" s={20} /></a>
        <button className="icon-btn" aria-label="New chat" title="New chat" onClick={() => void openChat(null)}><Ico n="newchat" s={20} /></button>
      </header>
      <div className="view">
        <section className={msgs.length === 0 && live === null ? 'chat is-empty' : 'chat'}>
          <div className="chat-scroll" ref={scroller}>
            <div className="msgs" aria-live="polite">
              {msgs.length === 0 && live === null && (
                <div className="empty">
                  <h2>What should I do on your PC?</h2>
                  <div className="chips">
                    {SUGGEST.map((s) => (
                      <button key={s} className="chip" onClick={() => { setText(s); input.current?.focus(); }}>{s}</button>
                    ))}
                  </div>
                </div>
              )}
              {msgs.map((m, i) => (
                <Bubble key={i} m={m} />
              ))}
              {live !== null && (
                <div className="msg magnus">
                  <span className="mark small-mark" aria-hidden="true">M</span>
                  <div className="msg-body">
                    <div className="typing"><i /><i /><i /><span className="muted small">{live.length === 0 ? 'Starting the AI on your PC…' : 'Working…'}</span></div>
                    {ask && (
                      <div className="ask-inline">
                        <p className="ask-q">{ask.text}</p>
                        {ask.sent !== undefined ? (
                          <p className="muted small">You answered: {ask.sent}</p>
                        ) : (
                          <>
                            {ask.options.length > 0 && (
                              <div className="chips">
                                {ask.options.map((o) => (
                                  <button key={o} type="button" className="chip" onClick={() => void answer(o)}>{o}</button>
                                ))}
                              </div>
                            )}
                            <form className="ask-form" onSubmit={(e) => { e.preventDefault(); void answer(askText); }}>
                              <textarea rows={1} maxLength={2000} placeholder="Your answer" value={askText} onChange={(e) => setAskText(e.target.value)} />
                              <MicButton onText={(x) => setAskText((v) => (v.trim() === '' ? x : `${v.trimEnd()} ${x}`))} />
                              <button className="chip" type="submit">Send</button>
                            </form>
                          </>
                        )}
                      </div>
                    )}
                    <ol className="live-steps">
                      {live.map((s, i) => (
                        <li key={i} className={`k-${s.kind}`}><span aria-hidden="true">{ICON[s.kind]}</span> {s.text}</li>
                      ))}
                    </ol>
                  </div>
                </div>
              )}
              {err !== null && <p className="notice bad">{err}</p>}
            </div>
          </div>
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy) void fetch('/api/ask', { method: 'DELETE' }).catch(() => undefined);
              else void send();
            }}
          >
            <textarea
              ref={input}
              rows={1}
              maxLength={4000}
              placeholder="Message Magnus"
              aria-label="Message"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="composer-row">
              <MicButton onText={(t) => setText((v) => (v.trim() === '' ? t : `${v.trimEnd()} ${t}`))} />
              <button className={busy ? 'send stop' : text.trim() !== '' ? 'send ready' : 'send'} type="submit" aria-label={busy ? 'Stop' : 'Send'}><Ico n={busy ? 'stop' : 'send'} s={20} /></button>
            </div>
          </form>
        </section>
      </div>
      <aside className="drawer" aria-label="Chats">
        <div className="drawer-top"><strong className="brand-name">Magnus</strong></div>
        <button className="new-chat" onClick={() => void openChat(null)}><Ico n="newchat" />New chat</button>
        <p className="drawer-h">Chats</p>
        <ul className="chat-list">
          {chats.length === 0 && <li className="muted small empty-list">No chats yet.</li>}
          {chats.map((c) => (
            <li key={c.id} className={c.id === current ? 'chat-li active' : 'chat-li'}>
              <div className="chat-row">
                <button className="chat-item" title={c.preview} onClick={() => void openChat(c.id)}>{c.title}</button>
                <button className="icon-btn more" aria-label={`More for ${c.title}`} onClick={() => setMenu(menu === c.id ? null : c.id)}>⋯</button>
              </div>
              {menu === c.id && (
                <div className="chat-actions">
                  <button onClick={() => void rename(c)}>Rename</button>
                  <button className="bad-text" onClick={() => void remove(c)}>Delete</button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <nav className="drawer-nav" aria-label="Sections">
          <label className="voice-lang">
            <span>Voice</span>
            <select aria-label="Voice language" defaultValue={typeof window === 'undefined' ? 'en-IN' : voiceLang()} onChange={(e) => setVoiceLang(e.target.value)}>
              {VOICE_LANGS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          <a href="/manage"><Ico n="home" />Tools & settings</a>
        </nav>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} />
    </main>
  );
}
