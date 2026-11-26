import type { Metadata } from 'next';
import { HqAdReturn } from '../../../../../components/hq-marketing/ad-accounts';

export const dynamic = 'force-dynamic';
// no-referrer: the address briefly holds the single-use connection state.
export const metadata: Metadata = { title: 'HON HQ | Finishing connection', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the API decides that only a current HQ owner finishes a connection. */
export default function HqAdReturnPage(): React.ReactElement { return <HqAdReturn/>; }
