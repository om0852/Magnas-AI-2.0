'use client';

import { useEffect, useRef, useState } from 'react';
import { useVoice } from '@/lib/voice';

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
interface Step {
  kind: 'thinking' | 'tool' | 'tool-done' | 'tool-failed' | 'say' | 'note';
  text: string;
  ms: number;
}

const NAMES = { codex: 'Codex CLI', antigravity: 'Antigravity CLI' } as const;
const ICON: Record<Step['kind'], string> = { thinking: '💭', tool: '🔧', 'tool-done': '✓', 'tool-failed': '✗', say: '💬', note: '·' };
const LABEL: Record<Step['kind'], string> = { thinking: 'Thinking', tool: 'Using', 'tool-done': 'Done', 'tool-failed': 'Failed', say: 'Says', note: 'Note' };

/** Mic button for a text box (ADR 0012). */
export function MicButton({ onText }: { onText: (t: string) => void }) {
  const v = useVoice(onText);
  if (!v.supported) return null;
  return (
    <span className="mic-wrap">
      <button type="button" className={v.listening ? 'mic on' : 'mic'} onClick={v.toggle} aria-pressed={v.listening} aria-label={v.listening ? 'Stop listening' : 'Speak instead of typing'} title={v.listening ? 'Stop listening' : 'Speak'}>
        {v.listening ? '■' : '🎤'}
      </button>
      {v.listening && <span className="small muted live">{v.interim || 'Listening…'}</span>}
      {v.error !== null && <span className="small bad-text">{v.error}</span>}
    </span>
  );
}

/** A task in plain words, done by the brain with Magnus's tools; each step shows live (ADR 0007, 0012). */
export function AskPanel({ brains, servers, timeoutSec }: { brains: string; servers: string; timeoutSec: number }) {
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [steps, setSteps] = useState<Step[]>([]);
  const [result, setResult] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const list = useRef<HTMLOListElement | null>(null);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [steps]);

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || task.trim() === '') return;
    setBusy(true);
    setResult(null);
    setError(null);
    setSteps([]);
    setSeconds(0);
    const t0 = Date.now();
    timer.current = setInterval(() => setSeconds(Math.floor((Date.now() - t0) / 1000)), 1000);
    try {
      const res = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task }) });
      if (!res.ok || !res.body) {
        const b = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
        setError([b.error ?? `failed (${res.status})`, b.hint].filter(Boolean).join(' '));
        return;
      }
      // Newline-delimited JSON: steps as they happen, then the result.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const m = JSON.parse(line) as { progress?: Step; result?: Answer; error?: string; hint?: string };
          if (m.progress) setSteps((s) => [...s, m.progress as Step]);
          if (m.result) {
            const answer = m.result.answer.replace(/\s+/g, ' ').trim();
            // The last "says" step is usually the answer itself: show it once.
            setSteps((s) => (s.at(-1)?.kind === 'say' && answer.startsWith((s.at(-1)?.text ?? '').replace(/…$/, '')) ? s.slice(0, -1) : s));
            setResult(m.result);
          }
          if (m.error !== undefined) setError([m.error, m.hint].filter(Boolean).join(' '));
        }
      }
    } catch {
      setError('The dashboard server did not answer.');
    } finally {
      if (timer.current) clearInterval(timer.current);
      setBusy(false);
    }
  }

  async function stop() {
    await fetch('/api/ask', { method: 'DELETE' }).catch(() => undefined);
  }

  return (
    <section className="card" aria-labelledby="ask-h">
      <h2 id="ask-h">Ask Magnus</h2>
      <p className="muted">
        A task in plain words, done on this PC by {brains} with: {servers}. You see each step as it happens and can stop it. Risky steps (sending, deleting, settings) still need your approval.
      </p>
      <form onSubmit={run} className="ask">
        <label htmlFor="task" className="sr-only">Task</label>
        <textarea
          id="task"
          rows={2}
          maxLength={4000}
          placeholder="e.g. Is Claude waiting for me? What does it ask?"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void run(e);
          }}
          disabled={busy}
        />
        <div className="row">
          <MicButton onText={(t) => setTask((v) => (v.trim() === '' ? t : `${v.trimEnd()} ${t}`))} />
          {busy ? (
            <button className="danger" type="button" onClick={() => void stop()}>
              Stop ({seconds} s)
            </button>
          ) : (
            <button className="primary" type="submit" disabled={task.trim() === ''}>Run</button>
          )}
        </div>
      </form>
      {busy && steps.length === 0 && <p className="muted small">Starting the AI (usually 5-15 s before the first step; a task takes 15-70 s, at most {timeoutSec} s).</p>}
      {steps.length > 0 && (
        <ol className="steps" ref={list} aria-live="polite">
          {steps.map((s, i) => (
            <li key={i} className={`step k-${s.kind}`}>
              <span className="step-t">{Math.round(s.ms / 1000)}s</span>
              <span className="step-i" aria-hidden="true">{ICON[s.kind]}</span>
              <span className="step-x"><span className="sr-only">{LABEL[s.kind]}: </span>{s.text}</span>
            </li>
          ))}
          {busy && <li className="step k-note"><span className="step-t" /><span className="step-i">⋯</span><span className="step-x muted">working</span></li>}
        </ol>
      )}
      {error !== null && <p className="notice bad" role="status">{error}</p>}
      {result && (
        <div className={result.ok ? 'answer' : 'answer failed'} role="status">
          <p className="small muted">
            {result.attempts
              .map((a) => `${NAMES[a.brain]}: ${a.outcome}${a.seconds !== null ? ` in ${a.seconds} s` : ''}${a.toolCalls !== null ? `, ${a.toolCalls} tool call${a.toolCalls === 1 ? '' : 's'}` : ''}`)
              .join(' · ')}
          </p>
          {result.stoppedBecause !== null && <p className="small">Not finished: {result.stoppedBecause}.</p>}
          <pre className="answer-text">{result.answer}</pre>
        </div>
      )}
    </section>
  );
}
