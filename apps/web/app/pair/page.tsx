'use client';

import { useState } from 'react';

/** Pair this phone with the code shown on the PC (ADR 0009). */
export default function PairPage() {
  const [code, setCode] = useState('');
  const [name, setName] = useState('My phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pair(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }) });
      const body = (await res.json()) as { error?: string; hint?: string };
      if (res.ok) window.location.href = '/m';
      else setError([body.error, body.hint].filter(Boolean).join('. '));
    } catch {
      setError('Magnus did not answer.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="phone">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true">M</span>
          <h1>Pair this device</h1>
        </div>
      </header>
      <section className="card">
        <p>On the PC, open the Magnus dashboard → <strong>Phones</strong> → <strong>Pair a device</strong>, and type the code here.</p>
        <form onSubmit={pair} className="stack">
          <label>
            Code
            <input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="one-time-code" inputMode="text" maxLength={12} required placeholder="ABCD2345" />
          </label>
          <label>
            Name for this device
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
          </label>
          <button className="primary" disabled={busy || code.trim() === ''}>{busy ? 'Pairing…' : 'Pair'}</button>
        </form>
        {error !== null && <p className="notice bad" role="status">{error}</p>}
      </section>
    </main>
  );
}
