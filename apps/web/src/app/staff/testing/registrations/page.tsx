import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { StaffTestingRegistrationWorkbench } from '../../../../components/staff-testing-registration-workbench';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human testing registration reviews', robots: { index: false, follow: false } };
export default async function StaffTestingRegistrationsPage() {
  let authenticated = false;
  try { const value = (await cookies()).get(HON_SESSION_COOKIE)?.value; authenticated = Boolean(value && verifySession(value, sessionConfig(process.env))); } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login');
  return <StaffTestingRegistrationWorkbench/>;
}
