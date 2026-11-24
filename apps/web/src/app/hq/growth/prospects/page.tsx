import type { Metadata } from 'next';
import { HqProspects } from '../../../../components/hq-prospects/hq-prospects';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Prospects', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the prospects API decides HQ marketing authority on every read and command. */
export default function HqProspectsPage(): React.ReactElement { return <HqProspects/>; }
