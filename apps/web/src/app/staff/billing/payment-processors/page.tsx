import type { Metadata } from 'next';
import { PaymentProcessors } from '../../../../components/payment-processors/payment-processors';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
// no-referrer: the provider return carries a one-time state in the query until the page removes it.
export const metadata: Metadata = { title: 'HON | Payment processors', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The school payment API decides every permission for the verified school; this page only asks. */
export default async function PaymentProcessorsPage() { await requireVerifiedWebSession(); return <PaymentProcessors />; }
