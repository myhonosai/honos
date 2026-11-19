import type { Metadata } from 'next';
import { HqCalls } from '../../../../components/calls/hq-calls';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Calls', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the HQ calling API decides HQ authority on every read and command. */
export default function HqCallsRoute(): React.ReactElement {
  return <HqCalls/>;
}
