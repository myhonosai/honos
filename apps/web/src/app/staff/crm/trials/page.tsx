import { TrialAppointmentWorkbench } from '../../../../components/trial-appointment-workbench';

export const dynamic = 'force-dynamic';

type TrialPageProps = { searchParams: Promise<{ organizationId?: string; schoolId?: string; leadId?: string }> };
function value(input: unknown): string | undefined { return typeof input === 'string' && input.length <= 80 ? input : undefined; }

export default async function TrialAppointmentsPage({ searchParams }: TrialPageProps) {
  const query = await searchParams;
  return <TrialAppointmentWorkbench initialScope={{ organizationId: value(query.organizationId), schoolId: value(query.schoolId), leadId: value(query.leadId) }} />;
}
