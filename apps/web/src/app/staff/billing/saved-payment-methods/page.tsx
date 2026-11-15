import type { Metadata } from 'next';
import { SavedMethods } from '../../../../components/saved-methods/saved-methods';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
// no-referrer: the provider return carries a one-time setup state in the query until the page removes it.
export const metadata: Metadata = { title: 'HON | Saved payment methods', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The school payment API decides every permission for the verified school; this page only asks. */
export default async function SavedPaymentMethodsPage() { await requireVerifiedWebSession(); return <SavedMethods />; }
