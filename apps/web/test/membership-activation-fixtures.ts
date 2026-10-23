import {
  MEMBERSHIP_ACTIVATION_CONFIRMATION, MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED,
  type MembershipActivationPreview, type MembershipActivationReceipt, type ConfirmMembershipActivationInput,
} from '@hon/contracts';
export const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
export const scope = { organizationId: id('1'), schoolId: id('2'), membershipId: id('3') };
export const current = { ...scope, state: 'DRAFT' as const, version: 1 };
export function preview(patch: Partial<MembershipActivationPreview> = {}): MembershipActivationPreview {
  return { membershipId: scope.membershipId, state: 'DRAFT', version: 1, billingAccountId: id('4'), participantPersonId: id('5'), participantDisplayName: 'Synthetic Student', planCode: 'JUNIOR-MONTHLY', source: 'CRM_GUARDIAN_CHILD_PLAN',
    plan: { membershipPlanId: id('7'), membershipPlanVersion: 2, terms: { displayName: 'Junior Monthly' } }, existingTerm: { termStartedAt: null, termEndsAt: null },
    schoolTimezone: 'America/Los_Angeles', localToday: '2026-10-22', birthDateRecorded: true, knownMinor: false,
    suggestedDates: { startDate: '2026-10-22', endDate: null, startBasis: 'TODAY_IN_SCHOOL_TIMEZONE', endBasis: 'PLAN_OPEN_ENDED' },
    proposedDates: { startDate: '2026-10-22', endDate: null, dateSource: 'SUGGESTED' }, projection: { termStartedAt: '2026-10-22T07:00:00.000Z', termEndsAt: null },
    effectiveStatusIfConfirmedNow: 'IN_EFFECT', warnings: [], overridableWarnings: [], availableOverrides: [], blocks: [], canConfirm: true,
    requirementsNotEvaluated: [...MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED], previewDigest: 'a'.repeat(64), confirmation: MEMBERSHIP_ACTIVATION_CONFIRMATION, ...patch };
}
export function input(patch: Partial<ConfirmMembershipActivationInput> = {}): ConfirmMembershipActivationInput {
  return { expectedVersion: 1, previewDigest: 'a'.repeat(64), startDate: '2026-10-22', endDate: null, dateSource: 'SUGGESTED', acknowledgedWarnings: [], overrides: [], reasonCode: 'ROUTINE_ENROLLMENT', confirmation: MEMBERSHIP_ACTIVATION_CONFIRMATION, ...patch };
}
export function receipt(patch: Partial<MembershipActivationReceipt> = {}): MembershipActivationReceipt {
  return { membershipId: scope.membershipId, state: 'ACTIVE', version: 2, previousVersion: 1, decisionId: id('8'), decisionBasis: 'STAFF_ACTIVATION_PRE_POLICY', membershipSource: 'CRM_GUARDIAN_CHILD_PLAN', authorizingPermission: 'billing.membership.activate', overridePermission: null,
    effectivePeriod: { periodVersion: 1, startDate: '2026-10-22', endDate: null, endDateInclusive: true, schoolTimezone: 'America/Los_Angeles', dateSource: 'SUGGESTED', termStartedAt: '2026-10-22T07:00:00.000Z', termEndsAt: null }, effectiveStatusAtActivation: 'IN_EFFECT', acknowledgedWarnings: [], overridesUsed: [], followUps: [], adultVerification: null, reasonCode: 'ROUTINE_ENROLLMENT', requirementsNotEvaluated: [...MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED], recordedAt: '2026-10-22T12:00:00.000Z', ...patch };
}
export function envelope(data: unknown, replayed = false, contextRead = false): Response {
  return Response.json({ data, meta: { requestId: id('6'), correlationId: id('6'), ...(contextRead ? {} : { replayed }) } }, { headers: { 'Cache-Control': 'private, no-store' } });
}
export const rejected = (status: number, code: string) => Response.json({ code, detail: 'PRIVATE_CANARY' }, { status, headers: { 'Cache-Control': 'private, no-store' } });
