// E1b-1 membership date revisions (migration 0178). Closed request validators and response verifiers shared by the
// API and its callers. A preview digest only binds a confirmation to the facts the operator reviewed; it is never
// proof of authorization, which the database re-checks live on every call. Dates are school-local and the end date
// is inclusive; `termEndsAt` is the exclusive instant (the start of the next school-local day) and is never an end date.

import { isSchoolLocalDate, MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED, type SchoolLocalDate } from './membership-activation.js';

export const MEMBERSHIP_DATE_REVISION_CONFIRMATION = 'I_CONFIRM_MEMBERSHIP_DATE_CHANGE_NO_PAYMENT_INVOICE_REFUND_OR_AGREEMENT_CHANGE' as const;
export const MEMBERSHIP_DATE_CHANGE_KINDS = ['INITIAL_CONFIRMATION', 'CORRECTION', 'EXTENSION', 'EARLY_END'] as const;
export const MEMBERSHIP_DATE_REVISION_REASON_CODES = {
  INITIAL_CONFIRMATION: ['LEGACY_RECORDS_REVIEWED', 'PAPER_RECORDS_HELD_BY_SCHOOL', 'MEMBER_CONFIRMED_DATES', 'OTHER'],
  CORRECTION: ['DATA_ENTRY_ERROR', 'ACTUAL_START_DIFFERED', 'PLAN_TERM_MISAPPLIED', 'OTHER'],
  EXTENSION: ['MEMBER_REQUESTED', 'SCHOOL_COURTESY', 'SCHOOL_CLOSURE_MAKEUP', 'PERSONAL_CIRCUMSTANCES', 'OTHER'],
  EARLY_END: ['MEMBER_REQUESTED', 'MOVED_AWAY', 'PERSONAL_CIRCUMSTANCES', 'SCHOOL_DECISION', 'OTHER'],
} as const;
export const MEMBERSHIP_DATE_REVISION_WARNING_CODES = ['DRAFT_INVOICE_UNCHANGED', 'EFFECTIVE_STATUS_CHANGES', 'END_DATE_PASSED', 'EXTENDS_ENDED_MEMBERSHIP',
  'FIXED_TERM_DIFFERS_FROM_PLAN', 'LEGACY_STORED_TERM_REPLACED', 'LEGACY_TERM_INTERPRETATION', 'LEGACY_TERM_NOT_STORED', 'OPEN_ENDED_PLAN_HAS_END_DATE',
  'OPEN_INVOICE_UNCHANGED', 'PAID_INVOICE_NOT_REFUNDED_OR_CREDITED', 'PAYMENT_SCHEDULE_UNCHANGED', 'RENEWAL_REVIEW_FACTS_OUTDATED', 'RETROACTIVE_CHANGE',
  'SCHOOL_TIMEZONE_CHANGED', 'START_DATE_CHANGED', 'START_DATE_IN_FUTURE'] as const;
export const MEMBERSHIP_DATE_REVISION_BLOCK_CODES = ['CHANGE_KIND_NOT_APPLICABLE', 'CHANGE_KIND_SHAPE_MISMATCH', 'DATE_CHANGE_CONFLICTS_WITH_OPEN_INVOICE',
  'DATE_CHANGE_CONFLICTS_WITH_PAYMENT_SCHEDULE', 'DATES_UNCHANGED', 'END_DATE_BEFORE_START', 'END_DATE_OUT_OF_RANGE', 'FINANCIAL_FACTS_TOO_MANY_TO_EVALUATE',
  'FIXED_TERM_END_DATE_REQUIRED', 'MEMBERSHIP_NOT_ACTIVE', 'PLAN_BINDING_INVALID', 'REVISION_LIMIT_REACHED', 'START_DATE_OUT_OF_RANGE'] as const;
export const MEMBERSHIP_LIFECYCLE_STATES = ['DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED'] as const;
/** ACTIVE rows report SCHEDULED/IN_EFFECT/ENDED from a confirmed period, or UNDATED without one; other states as stored. */
export const MEMBERSHIP_REPORTING_STATUSES = ['SCHEDULED', 'IN_EFFECT', 'ENDED', 'UNDATED', 'DRAFT', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED'] as const;
export const MEMBERSHIP_DATE_PERMISSIONS = ['billing.membership.dates.revise', 'billing.membership.dates.retroactive'] as const;

export type MembershipDateChangeKind = typeof MEMBERSHIP_DATE_CHANGE_KINDS[number];
export type MembershipDateRevisionWarningCode = typeof MEMBERSHIP_DATE_REVISION_WARNING_CODES[number];
export type MembershipDateRevisionBlockCode = typeof MEMBERSHIP_DATE_REVISION_BLOCK_CODES[number];
export type MembershipLifecycleState = typeof MEMBERSHIP_LIFECYCLE_STATES[number];
export type MembershipReportingStatus = typeof MEMBERSHIP_REPORTING_STATUSES[number];
export type MembershipDateSource = 'SUGGESTED' | 'STAFF_ADJUSTED' | 'STAFF_ENTERED';

/** `{changeKind}` previews the suggested dates (when HON has a suggestion); a date pair previews exactly those dates. */
export type MembershipDateRevisionPreviewInput =
  | { changeKind: MembershipDateChangeKind }
  | { changeKind: MembershipDateChangeKind; startDate: SchoolLocalDate; endDate: SchoolLocalDate | null };

export interface MembershipDateRevisionWarning {
  code: MembershipDateRevisionWarningCode;
  added?: number; removed?: number; days?: number; count?: number;
  fromDate?: SchoolLocalDate; toDate?: SchoolLocalDate; planEndDate?: SchoolLocalDate | null;
  from?: string; to?: string; storedStart?: string; storedEnd?: string | null;
}

/** The current confirmed period: the 0177 activation period or the latest 0178 revision. */
export interface MembershipConfirmedPeriod {
  source: 'ACTIVATION' | 'REVISION';
  periodVersion: number;
  changeKind: 'INITIAL' | MembershipDateChangeKind;
  startDate: SchoolLocalDate;
  endDate: SchoolLocalDate | null;
  endDateInclusive: true;
  schoolTimezone: string;
  termStartedAt: string;
  termEndsAt: string | null;
}
export interface MembershipLegacyStoredTerm { termStartedAt: string | null; termEndsAt: string | null }
export interface MembershipRetroactiveDays { added: number; removed: number }

export interface MembershipDateRevisionPreview {
  membershipId: string;
  state: MembershipLifecycleState;
  version: number;
  participantPersonId: string;
  participantDisplayName: string | null;
  planCode: string;
  plan: null | { membershipPlanId: string; membershipPlanVersion: number; terms: Record<string, unknown> | null };
  schoolTimezone: string;
  localToday: SchoolLocalDate;
  changeKind: MembershipDateChangeKind;
  currentPeriod: MembershipConfirmedPeriod | null;
  /** Present only while no period is confirmed: pre-0177 instants, shown as unconfirmed hints. */
  legacyStoredTerm: MembershipLegacyStoredTerm | null;
  suggestedDates: null | { startDate: SchoolLocalDate; endDate: SchoolLocalDate | null;
    startBasis: 'LEGACY_STORED_START' | 'CURRENT_START'; endBasis: 'LEGACY_STORED_END' | 'PLAN_FIXED_TERM' | 'NO_END_DATE' | 'PLAN_FIXED_TERM_ANCHORED' };
  proposedDates: { startDate: SchoolLocalDate | null; endDate: SchoolLocalDate | null; dateSource: MembershipDateSource };
  projection: null | { termStartedAt: string; termEndsAt: string | null };
  effectiveStatusNow: MembershipReportingStatus;
  effectiveStatusIfConfirmedNow: MembershipReportingStatus | null;
  retroactiveDays: MembershipRetroactiveDays;
  financialFacts: {
    schedules: { scheduleId: string; status: 'ACTIVE' | 'PAUSED' | 'CANCELLED'; frequency: string; nextChargeDate: SchoolLocalDate | null; autoRenew: boolean }[];
    schedulesTruncated: boolean;
    invoices: { invoiceId: string; status: 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE'; dueDate: SchoolLocalDate | null }[];
    invoicesTruncated: boolean;
  };
  warnings: MembershipDateRevisionWarning[];
  blocks: { code: MembershipDateRevisionBlockCode }[];
  requiredPermissions: typeof MEMBERSHIP_DATE_PERMISSIONS[number][];
  requirementsNotEvaluated: typeof MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED[number][];
  /** False when blocked or when the retroactive permission is required and missing. */
  canConfirm: boolean;
  previewDigest: string;
  confirmation: typeof MEMBERSHIP_DATE_REVISION_CONFIRMATION;
}

export interface ConfirmMembershipDateRevisionInput {
  expectedVersion: number;
  /** null exactly for INITIAL_CONFIRMATION (no confirmed period yet). */
  expectedPeriodVersion: number | null;
  previewDigest: string;
  changeKind: MembershipDateChangeKind;
  startDate: SchoolLocalDate;
  endDate: SchoolLocalDate | null;
  dateSource: MembershipDateSource;
  /** Required exactly when dateSource is STAFF_ADJUSTED. */
  dateAdjustmentReason?: string;
  /** Exactly the warning codes the preview listed. */
  acknowledgedWarnings: MembershipDateRevisionWarningCode[];
  reasonCode: string;
  /** Always required, 10-500 characters. */
  reasonText: string;
  confirmation: typeof MEMBERSHIP_DATE_REVISION_CONFIRMATION;
}

export interface MembershipDateRevisionReceipt {
  membershipId: string;
  state: 'ACTIVE';
  version: number;
  previousVersion: number;
  revisionId: string;
  changeKind: MembershipDateChangeKind;
  decisionBasis: 'STAFF_REVISION_PRE_POLICY';
  authorizingPermission: 'billing.membership.dates.revise';
  retroactivePermission: 'billing.membership.dates.retroactive' | null;
  previousPeriod: { periodVersion: number | null; startDate: SchoolLocalDate | null; endDate: SchoolLocalDate | null;
    legacyTermStartedAt: string | null; legacyTermEndsAt: string | null };
  effectivePeriod: { periodVersion: number; startDate: SchoolLocalDate; endDate: SchoolLocalDate | null; endDateInclusive: true; schoolTimezone: string;
    dateSource: MembershipDateSource; termStartedAt: string; termEndsAt: string | null };
  effectiveStatusAtRevision: 'SCHEDULED' | 'IN_EFFECT' | 'ENDED';
  retroactiveDays: MembershipRetroactiveDays;
  acknowledgedWarnings: MembershipDateRevisionWarningCode[];
  reasonCode: string;
  /** Always empty: a date revision never changes money, schedules, invoices or agreements. */
  financialEffects: [];
  followUps: { kind: 'BILLING_REVIEW'; workItemId: string }[];
  requirementsNotEvaluated: typeof MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED[number][];
  approval: null;
  recordedAt: string;
}

export interface MembershipDateHistoryVersion {
  periodVersion: number;
  changeKind: 'INITIAL' | MembershipDateChangeKind;
  startDate: SchoolLocalDate;
  endDate: SchoolLocalDate | null;
  schoolTimezone: string;
  dateSource: MembershipDateSource;
  reasonCode: string;
  reasonText: string | null;
  actorDisplayName: string | null;
  recordedAt: string;
  /** null for the activation period (0177 did not count past days). */
  retroactiveDays: MembershipRetroactiveDays | null;
  acknowledgedWarnings: string[];
}

export interface MembershipDateHistory {
  membershipId: string;
  state: MembershipLifecycleState;
  version: number;
  schoolTimezone: string;
  localToday: SchoolLocalDate;
  effectiveStatus: MembershipReportingStatus;
  datesConfirmed: boolean;
  currentPeriod: MembershipConfirmedPeriod | null;
  legacyStoredTerm: MembershipLegacyStoredTerm | null;
  /** Newest first. */
  versions: MembershipDateHistoryVersion[];
}

export interface MembershipDateConfirmationQueueInput { after?: string; limit?: number }
export interface MembershipDateConfirmationQueue {
  items: { membershipId: string; participantDisplayName: string | null; planCode: string; legacyStoredTerm: MembershipLegacyStoredTerm; createdAt: string }[];
  next: string | null;
}

/** `GET …/reports/membership-status`. Lifecycle totals are unchanged; ACTIVE is split so no membership disappears. */
export interface SchoolMembershipStatusSummary {
  organizationId: string;
  schoolId: string;
  generatedAt: string;
  schoolTimezone: string;
  localToday: SchoolLocalDate;
  windowEndDate: SchoolLocalDate;
  lifecycle: Record<MembershipLifecycleState, number>;
  activeByEffectiveStatus: { SCHEDULED: number; IN_EFFECT: number; ENDED: number; UNDATED: number };
  /** Unconfirmed hints only, derived from stored pre-0177 instants. Sum equals activeByEffectiveStatus.UNDATED. */
  undatedHints: { storedTermInEffect: number; storedTermEnded: number; storedTermFuture: number; noStoredStart: number };
  confirmedStartingNext30Days: number;
  confirmedEndingNext30Days: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const CODE = /^[A-Z][A-Z_]{0,63}$/;
function invalid(): never { throw new Error('Unverified membership date data.'); }
function record(value: unknown, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function count(value: unknown, min = 0, max = 999_999_999): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid(); return value as number; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid(); return value; }
function nullableInstant(value: unknown): string | null { return value === null ? null : instant(value); }
function date(value: unknown): SchoolLocalDate { if (!isSchoolLocalDate(value)) invalid(); return value; }
function nullableDate(value: unknown): SchoolLocalDate | null { return value === null ? null : date(value); }
function zone(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 64) invalid(); return value; }
/** Same rule as the database: min..max characters, no surrounding whitespace, no control or invisible formatting characters. */
function text(value: unknown, max: number, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '') !== value
    || /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/u.test(value)) invalid();
  return value;
}
function nullableText(value: unknown, max: number): string | null { return value === null ? null : text(value, max); }
function codes<T extends string>(value: unknown, allowed: readonly T[], max = 30): T[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  const out = value.map(item => oneOf(item, allowed));
  if (new Set(out).size !== out.length) invalid();
  return out;
}
function retroactive(value: unknown): MembershipRetroactiveDays {
  const r = record(value, ['added', 'removed']);
  return { added: count(r.added), removed: count(r.removed) };
}
function legacy(value: unknown): MembershipLegacyStoredTerm {
  const l = record(value, ['termStartedAt', 'termEndsAt']);
  return { termStartedAt: nullableInstant(l.termStartedAt), termEndsAt: nullableInstant(l.termEndsAt) };
}
function period(value: unknown): MembershipConfirmedPeriod {
  const p = record(value, ['source', 'periodVersion', 'changeKind', 'startDate', 'endDate', 'endDateInclusive', 'schoolTimezone', 'termStartedAt', 'termEndsAt']);
  if (p.endDateInclusive !== true) invalid();
  const startDate = date(p.startDate), endDate = nullableDate(p.endDate);
  if (endDate !== null && endDate < startDate) invalid();
  return { source: oneOf(p.source, ['ACTIVATION', 'REVISION'] as const), periodVersion: count(p.periodVersion, 1, 200),
    changeKind: oneOf(p.changeKind, ['INITIAL', ...MEMBERSHIP_DATE_CHANGE_KINDS] as const), startDate, endDate, endDateInclusive: true,
    schoolTimezone: zone(p.schoolTimezone), termStartedAt: instant(p.termStartedAt), termEndsAt: nullableInstant(p.termEndsAt) };
}

export function validateMembershipDateRevisionPreviewInput(value: unknown): MembershipDateRevisionPreviewInput {
  const row = record(value, ['changeKind', 'startDate', 'endDate'], ['changeKind']);
  const changeKind = oneOf(row.changeKind, MEMBERSHIP_DATE_CHANGE_KINDS);
  if (Object.hasOwn(row, 'startDate') !== Object.hasOwn(row, 'endDate')) invalid();
  if (!Object.hasOwn(row, 'startDate')) return { changeKind };
  const startDate = date(row.startDate), endDate = nullableDate(row.endDate);
  if (endDate !== null && endDate < startDate) invalid();
  return { changeKind, startDate, endDate };
}

export function validateConfirmMembershipDateRevisionInput(value: unknown): ConfirmMembershipDateRevisionInput {
  const row = record(value, ['expectedVersion', 'expectedPeriodVersion', 'previewDigest', 'changeKind', 'startDate', 'endDate', 'dateSource',
    'dateAdjustmentReason', 'acknowledgedWarnings', 'reasonCode', 'reasonText', 'confirmation'],
  ['expectedVersion', 'expectedPeriodVersion', 'previewDigest', 'changeKind', 'startDate', 'endDate', 'dateSource', 'acknowledgedWarnings', 'reasonCode',
    'reasonText', 'confirmation']);
  if (row.confirmation !== MEMBERSHIP_DATE_REVISION_CONFIRMATION || typeof row.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.previewDigest)) invalid();
  const changeKind = oneOf(row.changeKind, MEMBERSHIP_DATE_CHANGE_KINDS);
  const expectedPeriodVersion = row.expectedPeriodVersion === null ? null : count(row.expectedPeriodVersion, 1, 200);
  if ((changeKind === 'INITIAL_CONFIRMATION') !== (expectedPeriodVersion === null)) invalid();
  const dateSource = oneOf(row.dateSource, ['SUGGESTED', 'STAFF_ADJUSTED', 'STAFF_ENTERED'] as const);
  if ((dateSource === 'STAFF_ADJUSTED') !== Object.hasOwn(row, 'dateAdjustmentReason')) invalid();
  const startDate = date(row.startDate), endDate = nullableDate(row.endDate);
  if (endDate !== null && endDate < startDate) invalid();
  const out: ConfirmMembershipDateRevisionInput = {
    expectedVersion: count(row.expectedVersion, 1),
    expectedPeriodVersion,
    previewDigest: row.previewDigest,
    changeKind,
    startDate,
    endDate,
    dateSource,
    acknowledgedWarnings: codes(row.acknowledgedWarnings, MEMBERSHIP_DATE_REVISION_WARNING_CODES),
    reasonCode: oneOf(row.reasonCode, MEMBERSHIP_DATE_REVISION_REASON_CODES[changeKind]),
    reasonText: text(row.reasonText, 500, 10),
    confirmation: MEMBERSHIP_DATE_REVISION_CONFIRMATION,
  };
  if (Object.hasOwn(row, 'dateAdjustmentReason')) out.dateAdjustmentReason = text(row.dateAdjustmentReason, 500);
  return out;
}

export function validateMembershipDateHistoryInput(value: unknown): Record<string, never> {
  record(value, []);
  return {};
}

export function validateMembershipDateConfirmationQueueInput(value: unknown): MembershipDateConfirmationQueueInput {
  const row = record(value, ['after', 'limit'], []);
  const out: MembershipDateConfirmationQueueInput = {};
  if (Object.hasOwn(row, 'after')) out.after = uuid(row.after);
  if (Object.hasOwn(row, 'limit')) out.limit = count(row.limit, 1, 50);
  return out;
}

function warnings(value: unknown): MembershipDateRevisionWarning[] {
  if (!Array.isArray(value) || value.length > 30) invalid();
  return value.map(entry => {
    const w = record(entry, ['code', 'added', 'removed', 'days', 'count', 'fromDate', 'toDate', 'planEndDate', 'from', 'to', 'storedStart', 'storedEnd'], ['code']);
    const out: MembershipDateRevisionWarning = { code: oneOf(w.code, MEMBERSHIP_DATE_REVISION_WARNING_CODES) };
    if (Object.hasOwn(w, 'added')) out.added = count(w.added);
    if (Object.hasOwn(w, 'removed')) out.removed = count(w.removed);
    if (Object.hasOwn(w, 'days')) out.days = count(w.days, 1);
    if (Object.hasOwn(w, 'count')) out.count = count(w.count, 1);
    if (Object.hasOwn(w, 'fromDate')) out.fromDate = date(w.fromDate);
    if (Object.hasOwn(w, 'toDate')) out.toDate = date(w.toDate);
    if (Object.hasOwn(w, 'planEndDate')) out.planEndDate = nullableDate(w.planEndDate);
    if (Object.hasOwn(w, 'from')) out.from = oneOf(w.from, [...MEMBERSHIP_REPORTING_STATUSES]);
    if (Object.hasOwn(w, 'to')) out.to = oneOf(w.to, [...MEMBERSHIP_REPORTING_STATUSES]);
    if (Object.hasOwn(w, 'storedStart')) out.storedStart = instant(w.storedStart);
    if (Object.hasOwn(w, 'storedEnd')) out.storedEnd = nullableInstant(w.storedEnd);
    return out;
  });
}

export function verifyMembershipDateRevisionPreview(value: unknown): MembershipDateRevisionPreview {
  const row = record(value, ['membershipId', 'state', 'version', 'participantPersonId', 'participantDisplayName', 'planCode', 'plan', 'schoolTimezone', 'localToday',
    'changeKind', 'currentPeriod', 'legacyStoredTerm', 'suggestedDates', 'proposedDates', 'projection', 'effectiveStatusNow', 'effectiveStatusIfConfirmedNow',
    'retroactiveDays', 'financialFacts', 'warnings', 'blocks', 'requiredPermissions', 'requirementsNotEvaluated', 'canConfirm', 'previewDigest', 'confirmation']);
  if (typeof row.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.previewDigest) || row.confirmation !== MEMBERSHIP_DATE_REVISION_CONFIRMATION
    || JSON.stringify(row.requirementsNotEvaluated) !== JSON.stringify(MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED) || typeof row.planCode !== 'string') invalid();
  let plan: MembershipDateRevisionPreview['plan'] = null;
  if (row.plan !== null) {
    const p = record(row.plan, ['membershipPlanId', 'membershipPlanVersion', 'terms']);
    if (p.terms !== null && (typeof p.terms !== 'object' || Array.isArray(p.terms))) invalid();
    plan = { membershipPlanId: uuid(p.membershipPlanId), membershipPlanVersion: count(p.membershipPlanVersion, 1), terms: p.terms as Record<string, unknown> | null };
  }
  let suggestedDates: MembershipDateRevisionPreview['suggestedDates'] = null;
  if (row.suggestedDates !== null) {
    const s = record(row.suggestedDates, ['startDate', 'endDate', 'startBasis', 'endBasis']);
    suggestedDates = { startDate: date(s.startDate), endDate: nullableDate(s.endDate), startBasis: oneOf(s.startBasis, ['LEGACY_STORED_START', 'CURRENT_START'] as const),
      endBasis: oneOf(s.endBasis, ['LEGACY_STORED_END', 'PLAN_FIXED_TERM', 'NO_END_DATE', 'PLAN_FIXED_TERM_ANCHORED'] as const) };
  }
  const proposed = record(row.proposedDates, ['startDate', 'endDate', 'dateSource']);
  let projection: MembershipDateRevisionPreview['projection'] = null;
  if (row.projection !== null) {
    const p = record(row.projection, ['termStartedAt', 'termEndsAt']);
    projection = { termStartedAt: instant(p.termStartedAt), termEndsAt: nullableInstant(p.termEndsAt) };
  }
  const f = record(row.financialFacts, ['schedules', 'schedulesTruncated', 'invoices', 'invoicesTruncated']);
  if (!Array.isArray(f.schedules) || f.schedules.length > 20 || !Array.isArray(f.invoices) || f.invoices.length > 20 || !Array.isArray(row.blocks)) invalid();
  const requiredPermissions = codes(row.requiredPermissions, MEMBERSHIP_DATE_PERMISSIONS, 2);
  if (requiredPermissions[0] !== 'billing.membership.dates.revise') invalid();
  const currentPeriod = row.currentPeriod === null ? null : period(row.currentPeriod);
  const legacyStoredTerm = row.legacyStoredTerm === null ? null : legacy(row.legacyStoredTerm);
  if ((currentPeriod === null) === (legacyStoredTerm === null)) invalid();
  return {
    membershipId: uuid(row.membershipId),
    state: oneOf(row.state, MEMBERSHIP_LIFECYCLE_STATES),
    version: count(row.version, 1),
    participantPersonId: uuid(row.participantPersonId),
    participantDisplayName: nullableText(row.participantDisplayName, 201),
    planCode: row.planCode,
    plan,
    schoolTimezone: zone(row.schoolTimezone),
    localToday: date(row.localToday),
    changeKind: oneOf(row.changeKind, MEMBERSHIP_DATE_CHANGE_KINDS),
    currentPeriod,
    legacyStoredTerm,
    suggestedDates,
    proposedDates: { startDate: nullableDate(proposed.startDate), endDate: nullableDate(proposed.endDate),
      dateSource: oneOf(proposed.dateSource, ['SUGGESTED', 'STAFF_ADJUSTED', 'STAFF_ENTERED'] as const) },
    projection,
    effectiveStatusNow: oneOf(row.effectiveStatusNow, MEMBERSHIP_REPORTING_STATUSES),
    effectiveStatusIfConfirmedNow: row.effectiveStatusIfConfirmedNow === null ? null : oneOf(row.effectiveStatusIfConfirmedNow, MEMBERSHIP_REPORTING_STATUSES),
    retroactiveDays: retroactive(row.retroactiveDays),
    financialFacts: {
      schedules: f.schedules.map(entry => {
        const s = record(entry, ['scheduleId', 'status', 'frequency', 'nextChargeDate', 'autoRenew']);
        return { scheduleId: uuid(s.scheduleId), status: oneOf(s.status, ['ACTIVE', 'PAUSED', 'CANCELLED'] as const),
          frequency: oneOf(s.frequency, ['WEEKLY', 'MONTHLY', 'ANNUAL', 'CUSTOM'] as const), nextChargeDate: nullableDate(s.nextChargeDate), autoRenew: bool(s.autoRenew) };
      }),
      schedulesTruncated: bool(f.schedulesTruncated),
      invoices: f.invoices.map(entry => {
        const i = record(entry, ['invoiceId', 'status', 'dueDate']);
        return { invoiceId: uuid(i.invoiceId), status: oneOf(i.status, ['DRAFT', 'ISSUED', 'PAID', 'VOID', 'UNCOLLECTIBLE'] as const), dueDate: nullableDate(i.dueDate) };
      }),
      invoicesTruncated: bool(f.invoicesTruncated),
    },
    warnings: warnings(row.warnings),
    blocks: row.blocks.map(entry => ({ code: oneOf(record(entry, ['code']).code, MEMBERSHIP_DATE_REVISION_BLOCK_CODES) })),
    requiredPermissions,
    requirementsNotEvaluated: [...MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED],
    canConfirm: bool(row.canConfirm),
    previewDigest: row.previewDigest,
    confirmation: MEMBERSHIP_DATE_REVISION_CONFIRMATION,
  };
}

export function verifyMembershipDateRevisionReceipt(value: unknown, membershipId?: string): MembershipDateRevisionReceipt {
  const row = record(value, ['membershipId', 'state', 'version', 'previousVersion', 'revisionId', 'changeKind', 'decisionBasis', 'authorizingPermission',
    'retroactivePermission', 'previousPeriod', 'effectivePeriod', 'effectiveStatusAtRevision', 'retroactiveDays', 'acknowledgedWarnings', 'reasonCode',
    'financialEffects', 'followUps', 'requirementsNotEvaluated', 'approval', 'recordedAt']);
  if (row.state !== 'ACTIVE' || row.decisionBasis !== 'STAFF_REVISION_PRE_POLICY' || row.authorizingPermission !== 'billing.membership.dates.revise'
    || (row.retroactivePermission !== null && row.retroactivePermission !== 'billing.membership.dates.retroactive') || row.approval !== null
    || !Array.isArray(row.financialEffects) || row.financialEffects.length !== 0 || !Array.isArray(row.followUps) || row.followUps.length > 1
    || JSON.stringify(row.requirementsNotEvaluated) !== JSON.stringify(MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED)) invalid();
  const version = count(row.version, 2);
  if (count(row.previousVersion, 1) !== version - 1) invalid();
  const changeKind = oneOf(row.changeKind, MEMBERSHIP_DATE_CHANGE_KINDS);
  const prior = record(row.previousPeriod, ['periodVersion', 'startDate', 'endDate', 'legacyTermStartedAt', 'legacyTermEndsAt']);
  const previousPeriod = { periodVersion: prior.periodVersion === null ? null : count(prior.periodVersion, 1, 199), startDate: nullableDate(prior.startDate),
    endDate: nullableDate(prior.endDate), legacyTermStartedAt: nullableInstant(prior.legacyTermStartedAt), legacyTermEndsAt: nullableInstant(prior.legacyTermEndsAt) };
  if ((changeKind === 'INITIAL_CONFIRMATION') !== (previousPeriod.periodVersion === null)) invalid();
  const p = record(row.effectivePeriod, ['periodVersion', 'startDate', 'endDate', 'endDateInclusive', 'schoolTimezone', 'dateSource', 'termStartedAt', 'termEndsAt']);
  if (p.endDateInclusive !== true) invalid();
  const effectivePeriod = { periodVersion: count(p.periodVersion, 1, 200), startDate: date(p.startDate), endDate: nullableDate(p.endDate), endDateInclusive: true as const,
    schoolTimezone: zone(p.schoolTimezone), dateSource: oneOf(p.dateSource, ['SUGGESTED', 'STAFF_ADJUSTED', 'STAFF_ENTERED'] as const),
    termStartedAt: instant(p.termStartedAt), termEndsAt: nullableInstant(p.termEndsAt) };
  if (effectivePeriod.periodVersion !== (previousPeriod.periodVersion ?? 0) + 1
    || (effectivePeriod.endDate !== null && effectivePeriod.endDate < effectivePeriod.startDate)
    || (effectivePeriod.endDate === null) !== (effectivePeriod.termEndsAt === null)
    || (effectivePeriod.termEndsAt !== null && Date.parse(effectivePeriod.termEndsAt) <= Date.parse(effectivePeriod.termStartedAt))) invalid();
  const retroactiveDays = retroactive(row.retroactiveDays);
  if ((row.retroactivePermission === null) !== (retroactiveDays.added === 0 && retroactiveDays.removed === 0)) invalid();
  const receipt: MembershipDateRevisionReceipt = {
    membershipId: uuid(row.membershipId),
    state: 'ACTIVE',
    version,
    previousVersion: version - 1,
    revisionId: uuid(row.revisionId),
    changeKind,
    decisionBasis: 'STAFF_REVISION_PRE_POLICY',
    authorizingPermission: 'billing.membership.dates.revise',
    retroactivePermission: row.retroactivePermission === null ? null : 'billing.membership.dates.retroactive',
    previousPeriod,
    effectivePeriod,
    effectiveStatusAtRevision: oneOf(row.effectiveStatusAtRevision, ['SCHEDULED', 'IN_EFFECT', 'ENDED'] as const),
    retroactiveDays,
    acknowledgedWarnings: codes(row.acknowledgedWarnings, MEMBERSHIP_DATE_REVISION_WARNING_CODES),
    reasonCode: oneOf(row.reasonCode, MEMBERSHIP_DATE_REVISION_REASON_CODES[changeKind]),
    financialEffects: [],
    followUps: row.followUps.map(entry => {
      const f = record(entry, ['kind', 'workItemId']);
      if (f.kind !== 'BILLING_REVIEW') invalid();
      return { kind: 'BILLING_REVIEW' as const, workItemId: uuid(f.workItemId) };
    }),
    requirementsNotEvaluated: [...MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED],
    approval: null,
    recordedAt: instant(row.recordedAt),
  };
  if (membershipId !== undefined && receipt.membershipId !== membershipId.toLowerCase()) invalid();
  return receipt;
}

export function verifyMembershipDateHistory(value: unknown, membershipId?: string): MembershipDateHistory {
  const row = record(value, ['membershipId', 'state', 'version', 'schoolTimezone', 'localToday', 'effectiveStatus', 'datesConfirmed', 'currentPeriod',
    'legacyStoredTerm', 'versions']);
  if (!Array.isArray(row.versions) || row.versions.length > 200) invalid();
  const datesConfirmed = bool(row.datesConfirmed);
  const currentPeriod = row.currentPeriod === null ? null : period(row.currentPeriod);
  const legacyStoredTerm = row.legacyStoredTerm === null ? null : legacy(row.legacyStoredTerm);
  if (datesConfirmed !== (currentPeriod !== null) || (currentPeriod === null) === (legacyStoredTerm === null)) invalid();
  const versions = row.versions.map(entry => {
    const v = record(entry, ['periodVersion', 'changeKind', 'startDate', 'endDate', 'schoolTimezone', 'dateSource', 'reasonCode', 'reasonText', 'actorDisplayName',
      'recordedAt', 'retroactiveDays', 'acknowledgedWarnings']);
    if (!Array.isArray(v.acknowledgedWarnings) || v.acknowledgedWarnings.length > 30
      || v.acknowledgedWarnings.some(code => typeof code !== 'string' || !CODE.test(code)) || typeof v.reasonCode !== 'string' || !CODE.test(v.reasonCode)) invalid();
    return { periodVersion: count(v.periodVersion, 1, 200), changeKind: oneOf(v.changeKind, ['INITIAL', ...MEMBERSHIP_DATE_CHANGE_KINDS] as const),
      startDate: date(v.startDate), endDate: nullableDate(v.endDate), schoolTimezone: zone(v.schoolTimezone),
      dateSource: oneOf(v.dateSource, ['SUGGESTED', 'STAFF_ADJUSTED', 'STAFF_ENTERED'] as const), reasonCode: v.reasonCode,
      reasonText: nullableText(v.reasonText, 1000), actorDisplayName: nullableText(v.actorDisplayName, 200), recordedAt: instant(v.recordedAt),
      retroactiveDays: v.retroactiveDays === null ? null : retroactive(v.retroactiveDays), acknowledgedWarnings: v.acknowledgedWarnings as string[] };
  });
  if (versions.some((v, i) => i > 0 && v.periodVersion >= versions[i - 1]!.periodVersion) || (currentPeriod?.periodVersion ?? null) !== (versions[0]?.periodVersion ?? null)) invalid();
  const history: MembershipDateHistory = {
    membershipId: uuid(row.membershipId),
    state: oneOf(row.state, MEMBERSHIP_LIFECYCLE_STATES),
    version: count(row.version, 1),
    schoolTimezone: zone(row.schoolTimezone),
    localToday: date(row.localToday),
    effectiveStatus: oneOf(row.effectiveStatus, MEMBERSHIP_REPORTING_STATUSES),
    datesConfirmed,
    currentPeriod,
    legacyStoredTerm,
    versions,
  };
  if (membershipId !== undefined && history.membershipId !== membershipId.toLowerCase()) invalid();
  return history;
}

export function verifyMembershipDateConfirmationQueue(value: unknown): MembershipDateConfirmationQueue {
  const row = record(value, ['items', 'next']);
  if (!Array.isArray(row.items) || row.items.length > 50) invalid();
  const items = row.items.map(entry => {
    const i = record(entry, ['membershipId', 'participantDisplayName', 'planCode', 'legacyStoredTerm', 'createdAt']);
    if (typeof i.planCode !== 'string') invalid();
    return { membershipId: uuid(i.membershipId), participantDisplayName: nullableText(i.participantDisplayName, 201), planCode: i.planCode,
      legacyStoredTerm: legacy(i.legacyStoredTerm), createdAt: instant(i.createdAt) };
  });
  const next = row.next === null ? null : uuid(row.next);
  if (next !== null && next !== items[items.length - 1]?.membershipId) invalid();
  return { items, next };
}

export function verifySchoolMembershipStatusSummary(value: unknown, scope?: { organizationId: string; schoolId: string }): SchoolMembershipStatusSummary {
  const row = record(value, ['organizationId', 'schoolId', 'generatedAt', 'schoolTimezone', 'localToday', 'windowEndDate', 'lifecycle', 'activeByEffectiveStatus',
    'undatedHints', 'confirmedStartingNext30Days', 'confirmedEndingNext30Days']);
  const l = record(row.lifecycle, MEMBERSHIP_LIFECYCLE_STATES);
  const a = record(row.activeByEffectiveStatus, ['SCHEDULED', 'IN_EFFECT', 'ENDED', 'UNDATED']);
  const h = record(row.undatedHints, ['storedTermInEffect', 'storedTermEnded', 'storedTermFuture', 'noStoredStart']);
  const lifecycle = Object.fromEntries(MEMBERSHIP_LIFECYCLE_STATES.map(state => [state, count(l[state])])) as Record<MembershipLifecycleState, number>;
  const activeByEffectiveStatus = { SCHEDULED: count(a.SCHEDULED), IN_EFFECT: count(a.IN_EFFECT), ENDED: count(a.ENDED), UNDATED: count(a.UNDATED) };
  const undatedHints = { storedTermInEffect: count(h.storedTermInEffect), storedTermEnded: count(h.storedTermEnded), storedTermFuture: count(h.storedTermFuture),
    noStoredStart: count(h.noStoredStart) };
  // No membership disappears: the ACTIVE split and the undated hints add up exactly.
  if (activeByEffectiveStatus.SCHEDULED + activeByEffectiveStatus.IN_EFFECT + activeByEffectiveStatus.ENDED + activeByEffectiveStatus.UNDATED !== lifecycle.ACTIVE
    || undatedHints.storedTermInEffect + undatedHints.storedTermEnded + undatedHints.storedTermFuture + undatedHints.noStoredStart !== activeByEffectiveStatus.UNDATED) invalid();
  const summary: SchoolMembershipStatusSummary = {
    organizationId: uuid(row.organizationId),
    schoolId: uuid(row.schoolId),
    generatedAt: instant(row.generatedAt),
    schoolTimezone: zone(row.schoolTimezone),
    localToday: date(row.localToday),
    windowEndDate: date(row.windowEndDate),
    lifecycle,
    activeByEffectiveStatus,
    undatedHints,
    confirmedStartingNext30Days: count(row.confirmedStartingNext30Days),
    confirmedEndingNext30Days: count(row.confirmedEndingNext30Days),
  };
  if (summary.confirmedStartingNext30Days > activeByEffectiveStatus.SCHEDULED
    || summary.confirmedEndingNext30Days > activeByEffectiveStatus.SCHEDULED + activeByEffectiveStatus.IN_EFFECT) invalid();
  if (scope && (summary.organizationId !== scope.organizationId.toLowerCase() || summary.schoolId !== scope.schoolId.toLowerCase())) invalid();
  return summary;
}
