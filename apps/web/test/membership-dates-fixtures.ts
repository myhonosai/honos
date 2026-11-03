import { MEMBERSHIP_DATE_REVISION_CONFIRMATION, MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED,
  type MembershipDateRevisionPreview, type MembershipDateRevisionReceipt, type MembershipDateHistory, type ConfirmMembershipDateRevisionInput,
  type SchoolMembershipStatusSummary } from '@hon/contracts';
export { id, scope, envelope, rejected } from './membership-activation-fixtures';
import { id, scope } from './membership-activation-fixtures';
export const period = { source: 'ACTIVATION' as const, periodVersion: 1, changeKind: 'INITIAL' as const, startDate: '2026-10-01', endDate: '2026-10-31', endDateInclusive: true as const, schoolTimezone: 'America/Los_Angeles', termStartedAt: '2026-10-01T07:00:00.000Z', termEndsAt: '2026-11-01T07:00:00.000Z' };
export function history(patch: Partial<MembershipDateHistory> = {}): MembershipDateHistory {
  return { membershipId: scope.membershipId, state: 'ACTIVE', version: 2, schoolTimezone: period.schoolTimezone, localToday: '2026-10-23', effectiveStatus: 'IN_EFFECT', datesConfirmed: true, currentPeriod: { ...period }, legacyStoredTerm: null,
    versions: [{ periodVersion: 1, changeKind: 'INITIAL', startDate: period.startDate, endDate: period.endDate, schoolTimezone: period.schoolTimezone, dateSource: 'SUGGESTED', reasonCode: 'ROUTINE_ENROLLMENT', reasonText: null, actorDisplayName: 'Synthetic Staff', recordedAt: '2026-10-01T12:00:00.000Z', retroactiveDays: null, acknowledgedWarnings: [] }], ...patch };
}
export function preview(patch: Partial<MembershipDateRevisionPreview> = {}): MembershipDateRevisionPreview {
  return { membershipId: scope.membershipId, state: 'ACTIVE', version: 2, participantPersonId: id('4'), participantDisplayName: 'Synthetic Student', planCode: 'JUNIOR-MONTHLY', plan: { membershipPlanId: id('5'), membershipPlanVersion: 1, terms: { displayName: 'Junior Monthly' } },
    schoolTimezone: period.schoolTimezone, localToday: '2026-10-23', changeKind: 'CORRECTION', currentPeriod: { ...period }, legacyStoredTerm: null,
    suggestedDates: { startDate: period.startDate, endDate: period.endDate, startBasis: 'CURRENT_START', endBasis: 'PLAN_FIXED_TERM' },
    proposedDates: { startDate: period.startDate, endDate: period.endDate, dateSource: 'STAFF_ENTERED' }, projection: { termStartedAt: period.termStartedAt, termEndsAt: period.termEndsAt },
    effectiveStatusNow: 'IN_EFFECT', effectiveStatusIfConfirmedNow: 'IN_EFFECT', retroactiveDays: { added: 0, removed: 0 }, financialFacts: { invoices: [], schedules: [], invoicesTruncated: false, schedulesTruncated: false }, warnings: [], blocks: [], requiredPermissions: ['billing.membership.dates.revise'], requirementsNotEvaluated: [...MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED], canConfirm: true, previewDigest: 'a'.repeat(64), confirmation: MEMBERSHIP_DATE_REVISION_CONFIRMATION, ...patch };
}
export function input(patch: Partial<ConfirmMembershipDateRevisionInput> = {}): ConfirmMembershipDateRevisionInput {
  return { expectedVersion: 2, expectedPeriodVersion: 1, previewDigest: 'a'.repeat(64), changeKind: 'CORRECTION', startDate: period.startDate, endDate: period.endDate, dateSource: 'STAFF_ENTERED', acknowledgedWarnings: [], reasonCode: 'DATA_ENTRY_ERROR', reasonText: 'School reviewed and confirmed the correct dates.', confirmation: MEMBERSHIP_DATE_REVISION_CONFIRMATION, ...patch };
}
export function receipt(patch: Partial<MembershipDateRevisionReceipt> = {}): MembershipDateRevisionReceipt {
  return { membershipId: scope.membershipId, state: 'ACTIVE', version: 3, previousVersion: 2, revisionId: id('7'), changeKind: 'CORRECTION', decisionBasis: 'STAFF_REVISION_PRE_POLICY', authorizingPermission: 'billing.membership.dates.revise', retroactivePermission: null,
    previousPeriod: { periodVersion: 1, startDate: period.startDate, endDate: period.endDate, legacyTermStartedAt: null, legacyTermEndsAt: null },
    effectivePeriod: { periodVersion: 2, startDate: period.startDate, endDate: period.endDate, endDateInclusive: true, schoolTimezone: period.schoolTimezone, dateSource: 'STAFF_ENTERED', termStartedAt: period.termStartedAt, termEndsAt: period.termEndsAt },
    effectiveStatusAtRevision: 'IN_EFFECT', retroactiveDays: { added: 0, removed: 0 }, acknowledgedWarnings: [], reasonCode: 'DATA_ENTRY_ERROR', financialEffects: [], followUps: [], requirementsNotEvaluated: [...MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED], approval: null, recordedAt: '2026-10-23T12:00:00.000Z', ...patch };
}
export function report(patch: Partial<SchoolMembershipStatusSummary> = {}): SchoolMembershipStatusSummary {
  return { organizationId: scope.organizationId, schoolId: scope.schoolId, generatedAt: '2026-10-23T12:00:00.000Z', schoolTimezone: period.schoolTimezone, localToday: '2026-10-23', windowEndDate: '2026-11-22', lifecycle: { DRAFT: 1, ACTIVE: 4, FROZEN: 0, CANCELLATION_PENDING: 0, CANCELLED: 1, EXPIRED: 0 }, activeByEffectiveStatus: { SCHEDULED: 1, IN_EFFECT: 1, ENDED: 1, UNDATED: 1 }, undatedHints: { storedTermInEffect: 0, storedTermEnded: 0, storedTermFuture: 0, noStoredStart: 1 }, confirmedStartingNext30Days: 1, confirmedEndingNext30Days: 1, ...patch };
}
