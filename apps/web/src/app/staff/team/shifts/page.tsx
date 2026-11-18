import type { Metadata } from 'next';
import { StaffShifts } from '../../../../components/staff-shifts/staff-shifts';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Shifts', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The shift API decides every permission for the verified school; this page only asks. */
export default async function StaffShiftsPage() { await requireVerifiedWebSession(); return <StaffShifts />; }
