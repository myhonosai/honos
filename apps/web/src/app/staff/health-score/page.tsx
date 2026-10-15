import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { SchoolHealthScore } from '../../../components/school-health-score';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | School Health Score', description: 'Verified deterministic read-only school operational indicator.', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function SchoolHealthScorePage() {
  let authenticated = false;
  try {
    const token = (await cookies()).get(HON_SESSION_COOKIE)?.value;
    if (token) { verifySession(token, sessionConfig()); authenticated = true; }
  } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login');
  return <SchoolHealthScore />;
}
