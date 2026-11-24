import type { Metadata } from 'next';
import { CheckoutOrders } from '../../../../components/checkout-orders/checkout-orders';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Checkout orders', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The checkout orders API decides every permission for the verified school; this page only asks. */
export default async function CheckoutOrdersPage() { await requireVerifiedWebSession(); return <CheckoutOrders />; }
