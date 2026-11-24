import type { Metadata } from 'next';
import { BillingImport } from '../../../../components/billing-import/billing-import';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Import memberships and balances', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The membership import API decides every permission for the verified school; this page only asks. */
export default async function BillingImportPage() { await requireVerifiedWebSession(); return <BillingImport />; }
