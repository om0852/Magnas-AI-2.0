import { redirect } from 'next/navigation';
import { access } from '@/lib/guard';
import { PhoneApp } from './PhoneApp';

export const dynamic = 'force-dynamic';

/** The remote app on a phone (ADR 0009). Unpaired devices go to /pair. */
export default async function Phone() {
  const a = await access('GET');
  if (!a.ok) {
    if (a.remote && a.status === 401) redirect('/pair');
    return (
      <main className="phone">
        <section className="card">
          <h2>Not available</h2>
          <p>{a.message}</p>
        </section>
      </main>
    );
  }
  return <PhoneApp isDevice={a.who === 'device'} />;
}
