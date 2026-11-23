import type { Metadata } from 'next';
import { AttendanceReportPage } from '../../../../components/attendance-report/report';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Attendance report', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function AttendanceReportRoute() { await requireVerifiedWebSession(); return <AttendanceReportPage />; }
