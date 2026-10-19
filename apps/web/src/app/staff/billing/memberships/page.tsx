import React from 'react';
import { MembershipActivationWorkbench } from '../../../../components/membership-activation-workbench';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Membership activation | HON',
  description: 'Direct human activation of one known membership, without billing or agreement execution.',
  robots: { index: false, follow: false },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Props = { searchParams: Promise<{ membershipId?: string | string[] }> };

/** A returned DRAFT receipt may carry one untrusted initial form selector; this route performs no I/O. */
function normalizeInitialMembershipId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 80 && UUID.test(value) ? value.toLowerCase() : undefined;
}

export default async function MembershipActivationPage({ searchParams }: Props): Promise<React.ReactElement> {
  const initialMembershipId = normalizeInitialMembershipId((await searchParams).membershipId);
  return <MembershipActivationWorkbench key={initialMembershipId ?? 'empty'} {...(initialMembershipId === undefined ? {} : { initialMembershipId })} />;
}
