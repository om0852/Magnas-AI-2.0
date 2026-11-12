'use client';

import { useCallback, useEffect, useState } from 'react';

interface DeviceRow {
  id: string;
  name: string;
  created: string;
  lastSeen: string;
  approvals: boolean;
}

/** Phones and other devices that may use Magnus remotely (ADR 0009). PC dashboard only. */
export function DevicesPanel() {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);
  const [pairing, setPairing] = useState<{ code: string; minutes: number; urls: string[] } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/devices');
    if (!res.ok) return;
    const body = (await res.json()) as { devices: DeviceRow[]; remoteHosts: string[] };
    setDevices(body.devices);
    setHosts(body.remoteHosts);
  }, []);
  useEffect(() => void load(), [load]);

  async function pair() {
    setMsg(null);
    const res = await fetch('/api/devices', { method: 'POST' });
    const body = (await res.json()) as { code?: string; minutes?: number; urls?: string[]; error?: string; hint?: string };
    if (res.ok && body.code !== undefined) setPairing({ code: body.code, minutes: body.minutes ?? 10, urls: body.urls ?? [] });
    else setMsg({ ok: false, text: [body.error, body.hint].filter(Boolean).join(' ') });
  }

  async function remove(d: DeviceRow) {
    if (!window.confirm(`Remove "${d.name}"? It will no longer reach Magnus or answer XtraOS dialogs.`)) return;
    const res = await fetch(`/api/devices?id=${encodeURIComponent(d.id)}`, { method: 'DELETE' });
    const body = (await res.json()) as { removed?: string; approver?: string; error?: string };
    setMsg(res.ok ? { ok: true, text: `Removed ${body.removed}${body.approver === 'removed' ? ' (and its XtraOS approvals)' : ''}.` } : { ok: false, text: body.error ?? 'failed' });
    await load();
  }

  return (
    <section className="card" aria-labelledby="dev-h">
      <div className="card-head">
        <div>
          <h2 id="dev-h">Phones</h2>
          <p className="muted">
            {hosts.length > 0 ? `Paired devices reach Magnus at ${hosts.join(', ')}.` : 'Remote access is off: start Magnus with MAGNUS_REMOTE_HOSTS (docs/03, "The remote app").'}
          </p>
        </div>
        <button className="primary" onClick={() => void pair()} disabled={hosts.length === 0}>
          Pair a device
        </button>
      </div>
      {pairing && (
        <div className="notice ok">
          On the phone open {pairing.urls.join(' or ')} and enter <strong className="code-big">{pairing.code}</strong>
          <div className="small">Works once, for {pairing.minutes} minutes.</div>
        </div>
      )}
      {devices.length === 0 ? (
        <p className="muted small">No device paired.</p>
      ) : (
        <ul className="win-list">
          {devices.map((d) => (
            <li key={d.id} className="row spread device-row">
              <span>
                <strong>{d.name}</strong>
                <span className="muted small"> · last seen {d.lastSeen.slice(0, 16).replace('T', ' ')} UTC{d.approvals ? ' · answers approvals' : ''}</span>
              </span>
              <button className="secondary" onClick={() => void remove(d)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className={msg.ok ? 'notice ok' : 'notice bad'} role="status">{msg.text}</p>}
    </section>
  );
}
