import type { Metadata } from 'next';
import { StaffCalls } from '../../../components/calls/staff-calls';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Calls', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The calling API decides every permission for the verified school; this page only asks. */
export default async function CallsPage() { await requireVerifiedWebSession(); return <StaffCalls />; }
