import React from 'react';
import { CrmGuardianChildPayerDesignationWorkbench } from '../../../../components/crm-guardian-child-payer-designation-workbench';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Guardian-child source-guardian payer designation', robots: { index: false, follow: false } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Props = { searchParams: Promise<{ studentProfileId?: string | string[] }> };

/** A CRM receipt may provide one untrusted scalar form prefill only. It never triggers I/O. */
function normalizeInitialStudentProfileId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 80 && UUID.test(value) ? value.toLowerCase() : undefined;
}

export default async function StaffCrmGuardianChildPayerDesignationsPage({ searchParams }: Props): Promise<React.ReactElement> {
  const initialStudentProfileId = normalizeInitialStudentProfileId((await searchParams).studentProfileId);
  return <CrmGuardianChildPayerDesignationWorkbench key={initialStudentProfileId ?? 'empty'} {...(initialStudentProfileId === undefined ? {} : { initialStudentProfileId })} />;
}
