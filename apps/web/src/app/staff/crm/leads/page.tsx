import { CrmLeadsWorkbench } from '../../../../components/crm-leads-workbench';

export const dynamic = 'force-dynamic';

type CrmLeadsPageProps = { searchParams: Promise<{ organizationId?: string; schoolId?: string }> };

function value(input: unknown): string | undefined {
  return typeof input === 'string' && input.length <= 80 ? input : undefined;
}

export default async function CrmLeadsPage({ searchParams }: CrmLeadsPageProps) {
  const query = await searchParams;
  return <CrmLeadsWorkbench initialScope={{ organizationId: value(query.organizationId), schoolId: value(query.schoolId) }} />;
}
