'use client';

import { useCallback, useEffect, useState } from 'react';
import { MicButton } from './AskPanel';

interface Task {
  id: string;
  title: string;
  source: string;
  status: 'working' | 'needs-you' | 'done' | 'failed' | 'stopped';
  updated: string;
  cwd?: string;
  steps: { at: string; text: string }[];
  question?: { qid: string; text: string; options: string[] };
  result?: string;
}

const BADGE: Record<Task['status'], [string, string]> = {
  working: ['working', 'badge'],
  'needs-you': ['needs you', 'badge warn'],
  done: ['done', 'badge ok'],
  failed: ['failed', 'badge bad'],
  stopped: ['stopped', 'badge'],
};

const ago = (iso: string): string => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

function Answer({ task, onDone }: { task: Task; onDone: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const q = task.question;
  if (!q) return null;
  const send = async (answer: string) => {
    setErr(null);
    try {
      const res = await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: task.id, qid: q.qid, answer }) });
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setText('');
        onDone();
      } else setErr(b.error ?? 'could not send the answer');
    } catch {
      setErr('could not reach Magnus; check that the dashboard is still running');
    }
  };
  return (
    <div className="dialog">
      <p className="dialog-text">{q.text}</p>
      {q.options.length > 0 && (
        <div className="row">
          {q.options.map((o) => (
            <button key={o} className="primary" onClick={() => void send(o)}>{o}</button>
          ))}
        </div>
      )}
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void send(text); }}>
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer (or tap the mic)" maxLength={2000} />
        <div className="row">
          <MicButton onText={(t) => setText((v) => (v.trim() === '' ? t : `${v.trimEnd()} ${t}`))} />
          <button className="primary" disabled={text.trim() === ''}>Send answer</button>
        </div>
      </form>
      {err !== null && <p className="notice bad">{err}</p>}
    </div>
  );
}

/** Every task from Magnus and the AI tools, refreshed every 3 s (ADR 0013). */
export function TasksPanel() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks');
      if (res.ok) setTasks(((await res.json()) as { tasks: Task[] }).tasks);
    } catch {
      // offline for a moment: the next refresh tries again
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  if (tasks === null) return null;
  const waiting = tasks.filter((t) => t.status === 'needs-you').length;
  return (
    <section className="card" aria-labelledby="tasks-h">
      <h2 id="tasks-h">
        Tasks {waiting > 0 && <span className="badge warn">{waiting} need you</span>}
      </h2>
      <p className="muted small">From Magnus and your AI tools (Claude Code reports through its hooks; any MCP tool through the magnus__task tools). Updates by itself.</p>
      {tasks.length === 0 && <p className="muted">No tasks yet.</p>}
      <ul className="task-list">
        {tasks.map((t) => (
          <li key={t.id} className={`task s-${t.status}`}>
            <button className="task-head" onClick={() => setOpen(open === t.id ? null : t.id)} aria-expanded={open === t.id}>
              <span className={BADGE[t.status][1]}>{BADGE[t.status][0]}</span>
              <span className="task-title">{t.title}</span>
              <span className="muted small">{t.source} · {ago(t.updated)}</span>
            </button>
            {t.status === 'needs-you' && !t.question && t.steps.length > 0 && <p className="small warn-text">{t.steps.at(-1)?.text}</p>}
            {t.question && <Answer task={t} onDone={() => void load()} />}
            {open === t.id && (
              <div className="task-body">
                {t.cwd !== undefined && <p className="muted small">in {t.cwd}</p>}
                {t.steps.length > 0 && (
                  <ol className="steps">
                    {t.steps.slice(-15).map((s, i) => (
                      <li key={i} className="step"><span className="step-t">{s.at.slice(11, 16)}</span><span className="step-i">·</span><span className="step-x">{s.text}</span></li>
                    ))}
                  </ol>
                )}
                {t.result !== undefined && <pre className="answer-text">{t.result}</pre>}
              </div>
            )}
            {open !== t.id && t.result !== undefined && t.status !== 'working' && <p className="small muted task-result">{t.result.replace(/\s+/g, ' ').slice(0, 160)}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
