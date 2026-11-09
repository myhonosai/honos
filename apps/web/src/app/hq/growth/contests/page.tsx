import type { Metadata } from 'next';
import { HqContestsList } from '../../../../components/hq-contests/hq-contests-list';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Contests', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the Champions contest API decides HQ authority on every read and command. */
export default function Page(): React.ReactElement {
  return <HqContestsList/>;
}
