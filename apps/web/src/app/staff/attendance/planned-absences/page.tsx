import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { PlannedAbsenceReviewWorkbench } from '../../../../components/planned-absence-review-workbench';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human Planned Absence Review', robots: { index: false, follow: false } };
export default async function StaffPlannedAbsenceReviewPage() {
  let authenticated = false;
  try {
    const token = (await cookies()).get(HON_SESSION_COOKIE)?.value;
    if (token) { verifySession(token, sessionConfig()); authenticated = true; }
  } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login');
  return <PlannedAbsenceReviewWorkbench />;
}
