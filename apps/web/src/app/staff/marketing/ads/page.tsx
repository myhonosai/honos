import type { Metadata } from 'next';
import { SchoolAds } from '../../../../components/school-ads/ads';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Ads', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The social API decides every permission and whether connecting is turned on; this page only asks. */
export default async function AdsPage() { await requireVerifiedWebSession(); return <SchoolAds />; }
