import type { Metadata } from 'next';
import { HqSupportList } from '../../../components/hq-support/hq-support-list';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Support', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the support API decides HQ support authority on every read and command. */
export default function Page(): React.ReactElement {
  return <HqSupportList/>;
}
