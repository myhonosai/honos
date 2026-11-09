import type { Metadata } from 'next';
import { HqSchoolDetail } from '../../../../components/hq-school-detail/hq-school-detail';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | School detail', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the school detail API decides HQ authority on every read. */
export default async function HqSchoolDetailPage({ params }: { params: Promise<{ schoolId: string }> }): Promise<React.ReactElement> {
  const { schoolId } = await params;
  return <HqSchoolDetail key={schoolId} schoolId={schoolId}/>;
}
