import type { Metadata } from 'next';
import { AttendanceScan } from '../../../../components/attendance-cards/scan';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Scan check-in', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function AttendanceScanPage() { await requireVerifiedWebSession(); return <AttendanceScan />; }
