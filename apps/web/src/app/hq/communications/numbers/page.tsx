import type { Metadata } from 'next';
import { HqSchoolNumbersPage } from '../../../../components/hq-school-numbers/hq-school-numbers';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | School texting numbers', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the number order API decides HQ authority on every read and command. */
export default function HqSchoolNumbersRoute(): React.ReactElement {
  return <HqSchoolNumbersPage/>;
}
