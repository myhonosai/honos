import type { Metadata } from 'next';
import { HqContest } from '../../../../../components/hq-contests/hq-contest';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Contest', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the Champions contest API decides HQ authority on every read and command. */
export default async function Page({ params }: { params: Promise<{ contestId: string }> }): Promise<React.ReactElement> {
  const { contestId } = await params;
  return <HqContest key={contestId} contestId={contestId}/>;
}
