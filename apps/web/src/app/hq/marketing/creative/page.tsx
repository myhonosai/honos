import type { Metadata } from 'next';
import { HqCreative } from '../../../../components/hq-creative/hq-creative';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Creative Studio', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the creative API decides HQ marketing authority on every read and command. */
export default function HqCreativePage(): React.ReactElement { return <HqCreative/>; }
