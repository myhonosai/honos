import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { AttendanceWorkbench } from '../../../components/attendance-workbench';
import { attendanceScopePrefill } from '../../../components/attendance-scope-prefill';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human Attendance Workbench', robots: { index: false, follow: false } };

type StaffAttendancePageProps = { searchParams: Promise<{ organizationId?: unknown; schoolId?: unknown }> };

export default async function StaffAttendancePage({ searchParams }: StaffAttendancePageProps) {
  let authenticated = false;
  try {
    const token = (await cookies()).get(HON_SESSION_COOKIE)?.value;
    if (token) { verifySession(token, sessionConfig()); authenticated = true; }
  } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login');
  const query = await searchParams;
  return <AttendanceWorkbench initialScope={{ organizationId: attendanceScopePrefill(query.organizationId), schoolId: attendanceScopePrefill(query.schoolId) }} />;
}
