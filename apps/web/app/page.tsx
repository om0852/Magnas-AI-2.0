import { refusal } from '@/lib/guard';
import { ChatApp } from './ui/ChatApp';

export const dynamic = 'force-dynamic';

/** The home page: ChatGPT-style chat with memory (ADR 0015, 0018). Tools & settings are at /manage. */
export default async function Home() {
  const r = await refusal('GET');
  if (r) {
    return (
      <main>
        <section className="card">
          <h2>Open the dashboard from its link</h2>
          <p>{r.message}</p>
          <p className="muted small">Start it on this PC with <code>npm run dashboard</code> and open the link it prints.</p>
        </section>
      </main>
    );
  }
  return <ChatApp />;
}
