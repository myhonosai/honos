import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { RetentionReviewSignalsWorkbench } from '../../../../components/retention-review-signals';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Retention Review Signals', description: 'Human-controlled evidence-only known-membership retention review.', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function RetentionReviewSignalsPage() {
  let authenticated = false;
  try { const token = (await cookies()).get(HON_SESSION_COOKIE)?.value; if (token) { verifySession(token, sessionConfig()); authenticated = true; } } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login');
  return <RetentionReviewSignalsWorkbench />;
}
