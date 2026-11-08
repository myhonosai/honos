import type { Metadata } from 'next';
import { MarketingHome } from '../../../components/marketing-home/marketing-home';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Marketing', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function MarketingHomePage() { await requireVerifiedWebSession(); return <MarketingHome />; }
