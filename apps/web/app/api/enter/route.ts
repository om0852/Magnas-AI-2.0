/** The link from `npm run dashboard`: checks the run's token, stores it in a cookie, goes to the page. */
import { cookies } from 'next/headers';
import { COOKIE, PORT, refusal } from '@/lib/guard';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token');
  const bad = await refusal('GET', token);
  if (bad) return new Response(bad.message, { status: bad.status });
  (await cookies()).set(COOKIE, token ?? '', { httpOnly: true, sameSite: 'strict', path: '/' });
  return new Response(null, { status: 303, headers: { location: `http://127.0.0.1:${PORT}/` } });
}
