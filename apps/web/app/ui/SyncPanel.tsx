'use client';

import type { Action } from '@magnus/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

const SIGN: Record<Action['op'], string> = { add: '+', update: '~', remove: '−', unchanged: '=', conflict: '!', skip: '?' };

function Row({ a }: { a: Action }) {
  return (
    <li className={`action op-${a.op}`}>
      <span className="sign" aria-hidden="true">{SIGN[a.op]}</span>
      <span className="kind">{a.kind}</span>
      <span className="what">{a.name}</span>
      <span className="op">{a.op}</span>
      {a.detail !== undefined && <span className="detail">{a.detail}</span>}
    </li>
  );
}

/** The sync plan grouped by tool, and the button that applies it. */
export function SyncPanel({ plan, toolNames }: { plan: Action[]; toolNames: Record<string, string> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const changes = plan.filter((a) => a.op === 'add' || a.op === 'update' || a.op === 'remove');
  const problems = plan.filter((a) => a.op === 'conflict' || a.op === 'skip');
  const tools = [...new Set(plan.map((a) => a.client))];

  async function apply() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      const body = (await res.json()) as { actions?: Action[]; error?: string; hint?: string };
      if (!res.ok || !body.actions) {
        setMessage({ ok: false, text: [body.error ?? `failed (${res.status})`, body.hint].filter(Boolean).join(' ') });
      } else {
        const done = body.actions.filter((a) => a.op === 'add' || a.op === 'update' || a.op === 'remove').length;
        const skipped = body.actions.filter((a) => a.op === 'conflict' || a.op === 'skip').length;
        setMessage({
          ok: true,
          text: `Applied ${done} change${done === 1 ? '' : 's'}${skipped > 0 ? `, ${skipped} skipped` : ''}. Restart the AI tools to load changed MCP servers.`,
        });
        router.refresh();
      }
    } catch {
      setMessage({ ok: false, text: 'The dashboard server did not answer.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="sync-h">
      <div className="card-head">
        <div>
          <h2 id="sync-h">Sync</h2>
          <p className="muted">
            {changes.length === 0
              ? 'Every tool already has what the registry says.'
              : `${changes.length} change${changes.length === 1 ? '' : 's'} waiting. Each file is backed up before it is changed.`}
            {problems.length > 0 && ` ${problems.length} item${problems.length === 1 ? ' is' : 's are'} left alone.`}
          </p>
        </div>
        <button className="primary" onClick={apply} disabled={busy || changes.length === 0}>
          {busy ? 'Applying…' : changes.length === 0 ? 'In sync' : `Apply ${changes.length} change${changes.length === 1 ? '' : 's'}`}
        </button>
      </div>
      {message && (
        <p className={message.ok ? 'notice ok' : 'notice bad'} role="status">
          {message.text}
        </p>
      )}
      <div className="plan">
        {tools.map((id) => {
          const mine = plan.filter((a) => a.client === id);
          const shown = mine.filter((a) => a.op !== 'unchanged');
          const same = mine.length - shown.length;
          return (
            <div className="plan-tool" key={id}>
              <h3>
                {toolNames[id] ?? id}
                <span className="muted small">{same > 0 ? ` · ${same} unchanged` : ''}</span>
              </h3>
              {shown.length > 0 ? (
                <ul>
                  {shown.map((a) => (
                    <Row a={a} key={`${a.kind}:${a.name}`} />
                  ))}
                </ul>
              ) : (
                <p className="muted small">Nothing to change.</p>
              )}
            </div>
          );
        })}
        {tools.length === 0 && <p className="muted">No installed AI tool, or the registry is empty.</p>}
      </div>
    </section>
  );
}
