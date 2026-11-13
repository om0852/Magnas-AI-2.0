'use client';

import { useCallback, useEffect, useState } from 'react';
import { canSign, keyCode, publicKeyB64, signAnswer } from '@/lib/device-key';
import { AskPanel, MicButton } from '../ui/AskPanel';
import { TasksPanel } from '../ui/TasksPanel';

interface Dialog {
  uid: string;
  title: string;
  message: string;
  buttons: string[];
  cancel: number;
  age_ms: number;
}
interface Win {
  ref: string;
  title: string;
  process: string;
  state: string;
  focused: boolean;
}
interface Control {
  ref: string;
  role: string;
  name: string;
  value?: string;
  off: boolean;
}
interface WindowView {
  text: string;
  tap: Control[];
  type: Control[];
  dialog: string | null;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; hint?: string };
  if (!res.ok) throw new Error([body.error ?? `failed (${res.status})`, body.hint].filter(Boolean).join('. '));
  return body;
}
const post = (url: string, body: unknown) => getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** XtraOS dialogs waiting for an answer; polled every 2 s while this page is open. */
function Approvals({ isDevice }: { isDevice: boolean }) {
  const [dialogs, setDialogs] = useState<Dialog[]>([]);
  const [approverId, setApproverId] = useState<string | null>(null);
  const [canAnswer, setCanAnswer] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [setup, setSetup] = useState<{ busy: boolean; code: string | null }>({ busy: false, code: null });

  const load = useCallback(async () => {
    try {
      const r = await getJson<{ dialogs: Dialog[]; canAnswer: boolean; approverId: string | null }>('/api/approvals');
      setDialogs(r.dialogs);
      setCanAnswer(r.canAnswer);
      setApproverId(r.approverId);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load]);

  async function allowDevice() {
    setSetup({ busy: true, code: await keyCode() });
    setMsg(null);
    try {
      await post('/api/approver', { publicKey: await publicKeyB64() });
      setMsg({ ok: true, text: 'This device can now answer XtraOS dialogs.' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSetup((s) => ({ ...s, busy: false }));
    }
  }

  async function answer(d: Dialog, button: number) {
    if (approverId === null) return;
    setMsg(null);
    try {
      const signed = await signAnswer(approverId, d.uid, button);
      await post('/api/approvals', { uid: d.uid, button, ...signed });
      setMsg({ ok: true, text: `Answered: ${d.buttons[button]}` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <section className="card" aria-labelledby="ap-h">
      <h2 id="ap-h">Approvals {dialogs.length > 0 && <span className="badge warn">{dialogs.length} waiting</span>}</h2>
      {dialogs.length === 0 && <p className="muted">Nothing is waiting for you. This list updates by itself.</p>}
      {dialogs.map((d) => (
        <div className="dialog" key={d.uid}>
          <h3>{d.title}</h3>
          <p className="dialog-text">{d.message}</p>
          {canAnswer ? (
            <div className="row">
              {d.buttons.map((b, i) => (
                <button key={b} className={i === d.cancel ? 'secondary' : 'primary'} onClick={() => void answer(d, i)}>
                  {b}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted small">Answer this on the PC, or allow this device below.</p>
          )}
        </div>
      ))}
      {isDevice && !canAnswer && (
        <div className="setup">
          {canSign() ? (
            <>
              <p className="small">Let this device answer XtraOS dialogs. XtraOS will ask on the PC screen; check that it shows the same code.</p>
              {setup.code !== null && <p className="code-big">{setup.code}</p>}
              <button className="primary" disabled={setup.busy} onClick={() => void allowDevice()}>
                {setup.busy ? 'Waiting for Allow on the PC…' : 'Allow this device to answer'}
              </button>
            </>
          ) : (
            <p className="small">This browser cannot make a signing key here. Open Magnus through https (Tailscale), not plain http.</p>
          )}
        </div>
      )}
      {msg && <p className={msg.ok ? 'notice ok' : 'notice bad'} role="status">{msg.text}</p>}
    </section>
  );
}

/** The PC's windows; tap one to read it, tap its buttons, type into it. */
function Windows() {
  const [wins, setWins] = useState<Win[]>([]);
  const [open, setOpen] = useState<Win | null>(null);
  const [view, setView] = useState<WindowView | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [target, setTarget] = useState<string>('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const list = useCallback(async () => {
    try {
      setWins((await getJson<{ windows: Win[] }>('/api/windows')).windows);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }, []);
  useEffect(() => void list(), [list]);

  async function show(w: Win) {
    setOpen(w);
    setView(null);
    setMsg(null);
    setBusy(true);
    try {
      const v = await getJson<WindowView>(`/api/window?w=${w.ref}`);
      setView(v);
      setTarget(v.type.find((c) => !c.off)?.ref ?? '');
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function act(body: Record<string, unknown>, done: string) {
    if (!open) return;
    setBusy(true);
    setMsg(null);
    try {
      await post('/api/act', { window: open.ref, ...body });
      setMsg({ ok: true, text: done });
      await show(open);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
      setBusy(false);
    }
  }

  if (open) {
    return (
      <section className="card" aria-labelledby="win-h">
        <div className="row spread">
          <button className="secondary" onClick={() => { setOpen(null); setView(null); void list(); }}>← Windows</button>
          <button className="secondary" disabled={busy} onClick={() => void show(open)}>Refresh</button>
        </div>
        <h2 id="win-h" className="win-title">{open.title}</h2>
        {busy && !view && <p className="muted">Reading…</p>}
        {view && (
          <>
            {view.dialog !== null && <p className="notice bad">{view.dialog}</p>}
            <pre className="win-text">{view.text || '(no text)'}</pre>
            {view.tap.length > 0 && (
              <>
                <h3>Buttons</h3>
                <div className="chips">
                  {view.tap.slice(0, 60).map((c) => (
                    <button key={c.ref} className="chip-btn" disabled={busy || c.off} onClick={() => void act({ op: 'click', ref: c.ref }, `Tapped "${c.name}"`)}>
                      {c.name}
                    </button>
                  ))}
                </div>
              </>
            )}
            <h3>Type</h3>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void act({ op: 'type', text, submit: true, ...(target !== '' ? { ref: target } : {}) }, 'Typed and pressed Enter').then(() => setText(''));
              }}
            >
              {view.type.length > 0 && (
                <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Type into">
                  <option value="">The focused field</option>
                  {view.type.map((c) => (
                    <option key={c.ref} value={c.ref}>
                      {c.role}: {c.name || '(no name)'}
                    </option>
                  ))}
                </select>
              )}
              <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Text to type (or tap the mic and speak)" maxLength={4000} />
              <div className="row">
                <MicButton onText={(t) => setText((v) => (v.trim() === '' ? t : `${v.trimEnd()} ${t}`))} />
                <button className="primary" disabled={busy || text === ''}>Type and press Enter</button>
              </div>
            </form>
          </>
        )}
        {msg && <p className={msg.ok ? 'notice ok' : 'notice bad'} role="status">{msg.text}</p>}
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="wins-h">
      <div className="row spread">
        <h2 id="wins-h">Windows</h2>
        <button className="secondary" onClick={() => void list()}>Refresh</button>
      </div>
      <ul className="win-list">
        {wins.map((w) => (
          <li key={w.ref}>
            <button onClick={() => void show(w)}>
              <span className="win-name">{w.title || '(no title)'}</span>
              <span className="muted small">{w.process}{w.focused ? ' · in front' : ''}{w.state === 'minimized' ? ' · minimized' : ''}</span>
            </button>
          </li>
        ))}
      </ul>
      {msg && <p className={msg.ok ? 'notice ok' : 'notice bad'} role="status">{msg.text}</p>}
    </section>
  );
}

export function PhoneApp({ isDevice }: { isDevice: boolean }) {
  const [tab, setTab] = useState<'approvals' | 'tasks' | 'windows' | 'ask'>('approvals');
  return (
    <main className="phone">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true">M</span>
          <h1>Magnus</h1>
        </div>
        <span className="pill">{isDevice ? 'paired device' : 'this PC'}</span>
      </header>
      <nav className="tabs" aria-label="Sections">
        {(['approvals', 'tasks', 'windows', 'ask'] as const).map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t === 'approvals' ? 'Approvals' : t === 'tasks' ? 'Tasks' : t === 'windows' ? 'Windows' : 'Ask'}
          </button>
        ))}
      </nav>
      {tab === 'approvals' && <Approvals isDevice={isDevice} />}
      {tab === 'tasks' && <TasksPanel />}
      {tab === 'windows' && <Windows />}
      {tab === 'ask' && <AskPanel brains="Codex CLI, then Antigravity CLI" servers="the brain's servers" timeoutSec={300} />}
    </main>
  );
}
