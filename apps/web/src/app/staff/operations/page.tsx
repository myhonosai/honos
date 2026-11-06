import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { StaffDashboard } from '../../../components/staff-dashboard';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Operations Report', description: 'Verified aggregate-only school operations report.', referrer: 'no-referrer', robots: { index: false, follow: false } };

type StaffDashboardPageProps = { searchParams: Promise<{ organizationId?: string; schoolId?: string }> };
function prefill(value: unknown): string | undefined { return typeof value === 'string' && value.length <= 80 ? value : undefined; }

export default async function StaffOperationsReportPage({ searchParams }: StaffDashboardPageProps) {
  let authenticated = false;
  try {
    const token = (await cookies()).get(HON_SESSION_COOKIE)?.value;
    if (token) { verifySession(token, sessionConfig()); authenticated = true; }
  } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login');
  const query = await searchParams;
  return <StaffDashboard initialScope={{ organizationId: prefill(query.organizationId), schoolId: prefill(query.schoolId) }} />;
}
