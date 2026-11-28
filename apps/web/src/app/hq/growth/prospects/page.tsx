import type { Metadata } from 'next';
import { HqProspectBoard } from '../../../../components/hq-prospects/board';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Prospects', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the prospects API decides HQ marketing authority on every read and command. Board first (0715), List inside. */
export default function HqProspectsPage(): React.ReactElement { return <HqProspectBoard/>; }
