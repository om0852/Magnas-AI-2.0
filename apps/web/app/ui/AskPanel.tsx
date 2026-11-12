'use client';

import { useEffect, useRef, useState } from 'react';

interface Attempt {
  brain: 'codex' | 'antigravity';
  outcome: 'not-installed' | 'ok' | 'failed';
  seconds: number | null;
  toolCalls: number | null;
}

interface Answer {
  ok: boolean;
  answer: string;
  stoppedBecause: string | null;
  attempts: Attempt[];
}

const NAMES = { codex: 'Codex CLI', antigravity: 'Antigravity CLI' } as const;

/** A task in plain words, done by the brain with Magnus's tools (ADR 0007). */
export function AskPanel({ brains, servers, timeoutSec }: { brains: string; servers: string; timeoutSec: number }) {
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [result, setResult] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (busy || task.trim() === '') return;
    setBusy(true);
    setResult(null);
    setError(null);
    setSeconds(0);
    const t0 = Date.now();
    timer.current = setInterval(() => setSeconds(Math.floor((Date.now() - t0) / 1000)), 1000);
    try {
      const res = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task }) });
      const body = (await res.json()) as Answer & { error?: string; hint?: string };
      if (!res.ok) setError([body.error ?? `failed (${res.status})`, body.hint].filter(Boolean).join(' '));
      else setResult(body);
    } catch {
      setError('The dashboard server did not answer.');
    } finally {
      if (timer.current) clearInterval(timer.current);
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="ask-h">
      <h2 id="ask-h">Ask Magnus</h2>
      <p className="muted">
        A task in plain words, done on this PC by {brains} with: {servers}. Risky steps (sending, deleting, settings) still show you an XtraOS approval on this PC.
      </p>
      <form onSubmit={run} className="ask">
        <label htmlFor="task" className="sr-only">Task</label>
        <textarea
          id="task"
          rows={2}
          maxLength={4000}
          placeholder="e.g. Open YouTube in Firefox"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void run(e);
          }}
          disabled={busy}
        />
        <button className="primary" type="submit" disabled={busy || task.trim() === ''}>
          {busy ? `Working… ${seconds} s` : 'Run'}
        </button>
      </form>
      {busy && <p className="muted small">This usually takes 15–70 seconds (up to {timeoutSec} s).</p>}
      {error !== null && <p className="notice bad" role="status">{error}</p>}
      {result && (
        <div className={result.ok ? 'answer' : 'answer failed'} role="status">
          <p className="small muted">
            {result.attempts
              .map((a) => `${NAMES[a.brain]}: ${a.outcome}${a.seconds !== null ? ` in ${a.seconds} s` : ''}${a.toolCalls !== null ? `, ${a.toolCalls} tool call${a.toolCalls === 1 ? '' : 's'}` : ''}`)
              .join(' · ')}
          </p>
          {result.stoppedBecause !== null && <p className="small">No other brain was tried: {result.stoppedBecause}.</p>}
          <pre className="answer-text">{result.answer}</pre>
        </div>
      )}
    </section>
  );
}
