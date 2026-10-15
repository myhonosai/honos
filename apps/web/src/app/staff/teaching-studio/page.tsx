import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { TeachingStudioWorkbench } from '../../../components/teaching-studio-workbench';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human Teaching Studio', description: 'Human staff instructional planning and private observation workbench.', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function TeachingStudioPage() {
  let authenticated = false;
  try { const token = (await cookies()).get(HON_SESSION_COOKIE)?.value; if (token) { verifySession(token, sessionConfig()); authenticated = true; } } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login');
  return <TeachingStudioWorkbench />;
}
