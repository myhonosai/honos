import type { Metadata } from 'next';
import { HqCreativeLimits } from '../../../components/hq-creative-limits/hq-creative-limits';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Creative Spend Limits', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the database decides who may read the limits and that only a human HQ owner may change them. */
export default function HqCreativeLimitsPage(): React.ReactElement { return <HqCreativeLimits/>; }
