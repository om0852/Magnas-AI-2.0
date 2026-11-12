'use client';

import { useCallback, useEffect, useState } from 'react';

interface Status {
  configured: boolean;
  app?: string;
  devices?: { id: string; name: string; created: string; approvals: boolean }[];
}

/** Phones through the owner's encrypted relay (ADR 0010): pairing QR and paired phones. */
export function RelayPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [qr, setQr] = useState<{ svg: string; link: string; expiresAt: number } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/relay');
    if (res.ok) setStatus((await res.json()) as Status);
  }, []);
  useEffect(() => void load(), [load]);

  async function pair() {
    setMsg(null);
    const res = await fetch('/api/relay', { method: 'POST' });
    const body = (await res.json()) as { svg?: string; link?: string; expiresAt?: number; error?: string; hint?: string };
    if (res.ok && body.svg && body.link && body.expiresAt) setQr({ svg: body.svg, link: body.link, expiresAt: body.expiresAt });
    else setMsg({ ok: false, text: [body.error, body.hint].filter(Boolean).join(' ') });
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Remove "${name}"? It will no longer reach this PC or answer XtraOS dialogs.`)) return;
    const res = await fetch(`/api/relay?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    setMsg(res.ok ? { ok: true, text: `Removed ${name}.` } : { ok: false, text: 'Could not remove it.' });
    await load();
  }

  if (!status) return null;
  return (
    <section className="card" aria-labelledby="relay-h">
      <div className="card-head">
        <div>
          <h2 id="relay-h">Phones over your relay</h2>
          <p className="muted">
            {status.configured
              ? `End-to-end encrypted through ${status.app}. Keep "magnus relay run" running.`
              : 'Not set up. Deploy the relay, then run: magnus relay setup <its address>'}
          </p>
        </div>
        <button className="primary" onClick={() => void pair()} disabled={!status.configured}>
          Pair over the relay
        </button>
      </div>
      {qr && (
        <div className="qr-box">
          {/* The SVG is made on this PC by the qrcode package from our own link; it holds no script. */}
          <div className="qr" dangerouslySetInnerHTML={{ __html: qr.svg }} />
          <p className="small">
            Scan with your phone&apos;s camera. Works once, until {new Date(qr.expiresAt).toLocaleTimeString()}. It holds a secret: don&apos;t share a photo of it.
          </p>
          <button className="secondary" onClick={() => setQr(null)}>Hide</button>
        </div>
      )}
      {status.devices && status.devices.length > 0 && (
        <ul className="win-list">
          {status.devices.map((d) => (
            <li key={d.id} className="row spread device-row">
              <span>
                <strong>{d.name}</strong>
                <span className="muted small"> · paired {d.created.slice(0, 10)}{d.approvals ? ' · answers approvals' : ''}</span>
              </span>
              <button className="secondary" onClick={() => void remove(d.id, d.name)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className={msg.ok ? 'notice ok' : 'notice bad'} role="status">{msg.text}</p>}
    </section>
  );
}
