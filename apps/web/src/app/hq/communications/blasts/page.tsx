import type { Metadata } from 'next';
import { HqBlasts } from '../../../../components/hq-blasts/hq-blasts';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Blasts to school owners', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the blasts API decides (HQ owner only) on every read and command. */
export default function HqBlastsRoute(): React.ReactElement {
  return <HqBlasts/>;
}
