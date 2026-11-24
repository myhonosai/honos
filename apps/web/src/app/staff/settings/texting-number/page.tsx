import type { Metadata } from 'next';
import { SchoolTextingNumber } from '../../../../components/school-texting-number/texting-number';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Texting number', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The number API decides every permission, quotes every price and buys nothing; this page only asks. */
export default async function TextingNumberPage() { await requireVerifiedWebSession(); return <SchoolTextingNumber />; }
