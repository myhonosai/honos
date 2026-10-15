import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { SchoolCommandCenter } from '../../../components/school-command-center';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | School Command Center', description: 'Verified deterministic read-only school priorities.', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function SchoolCommandCenterPage() {
  let authenticated = false;
  try {
    const token = (await cookies()).get(HON_SESSION_COOKIE)?.value;
    if (token) { verifySession(token, sessionConfig()); authenticated = true; }
  } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login');
  return <SchoolCommandCenter />;
}
