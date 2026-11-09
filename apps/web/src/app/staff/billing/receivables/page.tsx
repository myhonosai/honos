import type { Metadata } from 'next';
import { TuitionPayments } from '../../../../components/tuition-payments/tuition-payments';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Tuition balances', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The tuition payment API decides every permission for the verified school; this page only asks. */
export default async function TuitionBalancesPage() { await requireVerifiedWebSession(); return <TuitionPayments />; }
