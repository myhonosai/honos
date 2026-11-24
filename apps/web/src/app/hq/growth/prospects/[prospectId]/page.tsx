import type { Metadata } from 'next';
import { HqProspect } from '../../../../../components/hq-prospects/hq-prospects';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Prospect', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The id is checked again by the client and the API; an invalid one shows "not valid" without a request. */
export default async function HqProspectPage({ params }: { params: Promise<{ prospectId: string }> }): Promise<React.ReactElement> {
  const { prospectId } = await params;
  return <HqProspect key={prospectId} prospectId={prospectId}/>;
}
