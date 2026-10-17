import { CrmFollowUpsWorkbench } from '../../../../components/crm-follow-ups-workbench';
import { crmFollowUpLeadId } from '../../../../components/crm-follow-up-handoff';

export const dynamic = 'force-dynamic';

type FollowUpsPageProps = { searchParams: Promise<{ leadId?: unknown }> };

export default async function FollowUpsPage({ searchParams }: FollowUpsPageProps) {
  const query = await searchParams;
  return <CrmFollowUpsWorkbench initialLeadId={crmFollowUpLeadId(query.leadId)} />;
}
