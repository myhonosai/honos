import React from 'react';
import { BillingAccountWorkbench } from '../../../../components/billing-account-workbench';

// The shared /staff layout verifies the signed session. Every lookup and
// command independently reauthorizes the direct current human and school.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human Billing Account Workbench', robots: { index: false, follow: false } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Props = { searchParams: Promise<{ sourceContactPersonId?: string | string[] }> };

/** A CRM source-contact selector is a reference only; it never selects a payer or starts I/O. */
function normalizeInitialSourceContactPersonId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 80 && UUID.test(value) ? value.toLowerCase() : undefined;
}

export default async function StaffBillingAccountsPage({ searchParams }: Props): Promise<React.ReactElement> {
  const initialSourceContactPersonId = normalizeInitialSourceContactPersonId((await searchParams).sourceContactPersonId);
  return <BillingAccountWorkbench key={initialSourceContactPersonId ?? 'empty'} {...(initialSourceContactPersonId === undefined ? {} : { initialSourceContactPersonId })} />;
}
