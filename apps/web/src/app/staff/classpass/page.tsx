import { ClassPassWorkbench } from '../../../components/classpass-workbench';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human ClassPass Workbench', robots: { index: false, follow: false } };

type ClassPassPageProps = { searchParams: Promise<{ organizationId?: string; schoolId?: string }> };

function value(input: unknown): string | undefined {
  return typeof input === 'string' && input.length <= 80 ? input : undefined;
}

export default async function StaffClassPassPage({ searchParams }: ClassPassPageProps) {
  const query = await searchParams;
  return <ClassPassWorkbench initialScope={{ organizationId: value(query.organizationId), schoolId: value(query.schoolId) }} />;
}
