import type { Metadata } from 'next';
import { StaffHours } from '../../../../components/staff-hours/staff-hours';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Hours', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The time API decides every permission for the verified school; this page only asks. */
export default async function StaffHoursPage() { await requireVerifiedWebSession(); return <StaffHours />; }
