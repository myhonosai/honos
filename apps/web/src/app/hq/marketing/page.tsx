import type { Metadata } from 'next';
import { HqMarketing } from '../../../components/hq-marketing/hq-marketing';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Marketing & Creative', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the marketing API decides HQ marketing authority on every read and command. */
export default function HqMarketingPage(): React.ReactElement { return <HqMarketing/>; }
