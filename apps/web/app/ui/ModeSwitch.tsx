'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Direct (every server in the tool's config) or hub (one entry: the Magnus hub). */
export function ModeSwitch({ id, name, mode }: { id: string; name: string; mode: 'direct' | 'hub' }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function set(next: 'direct' | 'hub') {
    if (next === mode || busy) return;
    setBusy(true);
    try {
      await fetch('/api/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, mode: next }) });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="segmented" role="group" aria-label={`How ${name} gets its servers`}>
      {(['direct', 'hub'] as const).map((m) => (
        <button key={m} aria-pressed={mode === m} disabled={busy} onClick={() => set(m)}>
          {m === 'direct' ? 'Direct' : 'Hub'}
        </button>
      ))}
    </div>
  );
}
