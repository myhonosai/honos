import type { Metadata } from 'next';
import { AttendanceCards } from '../../../../components/attendance-cards/cards';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Attendance cards', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function AttendanceCardsPage() { await requireVerifiedWebSession(); return <AttendanceCards />; }
