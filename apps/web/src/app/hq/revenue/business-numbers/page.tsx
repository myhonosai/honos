import type { Metadata } from 'next';
import { HqBusinessNumbersPage } from '../../../../components/hq-business-numbers/hq-business-numbers';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Business numbers', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the business numbers API decides HQ authority on every read. This page changes nothing. */
export default function HqBusinessNumbersRoute(): React.ReactElement {
  return <HqBusinessNumbersPage/>;
}
