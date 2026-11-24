import type { Metadata } from 'next';
import { HqSchoolsAttention } from '../../../../components/hq-school-health/hq-schools-attention';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Schools needing attention', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the school health API decides HQ authority on every read. */
export default function HqSchoolsAttentionPage(): React.ReactElement {
  return <HqSchoolsAttention/>;
}
