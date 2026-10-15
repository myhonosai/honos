import { StaffSearchRecord } from '../../../../../../../components/staff-search-record';
export const metadata = { title: 'HON | Scoped Search Record', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default async function StaffSearchResultPage({ params }: { params: Promise<{ organizationId: string; schoolId: string; kind: string; entityId: string }> }): Promise<React.ReactElement> {
  return <StaffSearchRecord {...await params} />;
}
