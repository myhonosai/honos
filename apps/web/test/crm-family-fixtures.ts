import type { CrmGuardianChildEnrollment, CrmGuardianChildFamilyState, CrmGuardianChildChildState, MembershipPlanListing } from '@hon/contracts';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const scope = { organizationId: id(1), schoolId: id(2) }, date = '2026-10-21T09:00:00.000Z';
export const row = { id: id(3), primaryPersonId: id(4), status: 'WON' as const, pipelineStageId: id(8), version: 1, createdAt: date, givenName: 'Ari', familyName: 'Stone' };
export const registration = { outcome: 'REGISTERED' as const, leadId: id(3), sourceContactPersonId: id(4), registrationPath: 'GUARDIAN_CHILD' as const, studentProfileId: id(5), familyId: id(6), recordedAt: date };
export const plan = { planId: id(30), planCode: 'CHILD-MONTHLY', version: 1, displayName: 'Junior Monthly', description: 'Junior martial arts', programId: null, availability: 'AVAILABLE' as const, currency: 'USD', priceMinor: 9900, billingFrequency: 'MONTHLY' as const, termKind: 'OPEN_ENDED' as const, termMonths: null, publishedAt: date };
export const listing: MembershipPlanListing = { ...plan, programName: null };
export const receipt = { membershipId: id(7), state: 'DRAFT' as const, planCode: plan.planCode, termStartedAt: null, termEndsAt: null, recordedAt: date };
export const payer = { state: 'PAYER_DESIGNATED' as const, guardianDisplayName: 'Ari Stone', currency: 'USD', recordedAt: date };
export const fields = { childGivenName: 'Kai', childFamilyName: 'Stone', childBirthDate: '2016-02-03' };
export function family(state: CrmGuardianChildFamilyState = 'PAYER_DESIGNATED', childState?: CrmGuardianChildChildState): CrmGuardianChildEnrollment {
  if (['NOT_REGISTERED','NEEDS_STAFF_REVIEW','ADULT_REGISTRATION'].includes(state)) return { leadId: id(3), workflowState: state } as CrmGuardianChildEnrollment;
  const workflowState = childState ?? (state === 'PAYER_DESIGNATED' ? 'READY_FOR_DRAFT' : 'AWAITING_PAYER_DESIGNATION');
  const draft = workflowState === 'CURRENT_DRAFT' ? { currentMembershipDraft: { state: 'RECORDED_DRAFT' as const, receipt, plan } }
    : workflowState === 'CURRENT_DRAFT_BY_OTHER_STAFF' ? { currentMembershipDraft: { state: 'RECORDED_DRAFT' as const } } : {};
  return { leadId: id(3), workflowState: state, historicalRegistrationReceipt: registration, guardian: { displayName: 'Ari Stone' },
    ...(state !== 'BILLING_ACCOUNT_REQUIRED' ? { billingAccount: { classification: 'CANONICAL' as const, currency: 'USD' } } : {}),
    ...(state === 'PAYER_DESIGNATED' ? { payerDesignation: payer } : {}), children: [{ studentProfileId: id(5), displayName: 'Kai Stone', origin: 'CRM_REGISTRATION', workflowState, ...draft }] } as CrmGuardianChildEnrollment;
}
export const response = (data: unknown, status = 200, replayed = false) => new Response(JSON.stringify(status === 200 || status === 201 ? { data, meta: { requestId: id(9), correlationId: id(9), replayed } } : data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
