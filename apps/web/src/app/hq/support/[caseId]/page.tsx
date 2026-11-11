import type { Metadata } from 'next';
import { HqSupportCase } from '../../../../components/hq-support/hq-support-case';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Support case', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the support API decides HQ support authority on every read and command. */
export default async function HqSupportCasePage({ params }: { params: Promise<{ caseId: string }> }): Promise<React.ReactElement> {
  const { caseId } = await params;
  return <HqSupportCase key={caseId} caseId={caseId}/>;
}
