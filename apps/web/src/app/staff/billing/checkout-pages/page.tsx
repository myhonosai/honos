import type { Metadata } from 'next';
import { SchoolCheckout } from '../../../../components/school-checkout/school-checkout';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Checkout pages', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The checkout settings API decides every permission for the verified school; this page only asks. */
export default async function CheckoutPagesPage() { await requireVerifiedWebSession(); return <SchoolCheckout />; }
