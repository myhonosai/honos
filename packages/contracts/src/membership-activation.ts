// E1a two-step membership activation (migration 0177). Closed request validators and response verifiers shared by
// the API and its callers. A preview digest only binds a confirmation to the facts the operator reviewed; it is never
// proof of authorization, which the database re-checks live on every call.

export const MEMBERSHIP_ACTIVATION_CONFIRMATION = 'I_CONFIRM_MEMBERSHIP_ACTIVATION_AND_DATES_NO_AGREEMENT_CONSENT_OR_PAYMENT_RECORDED' as const;
export const MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION = 'I_ACKNOWLEDGE_THE_REVIEW_REMAINS_UNRESOLVED' as const;
export const MEMBERSHIP_ADULT_VERIFICATION_ATTESTATION = 'I_ATTEST_STAFF_VERIFIED_THE_PARTICIPANT_IS_AN_ADULT' as const;
export const MEMBERSHIP_ACTIVATION_REASON_CODES = ['ROUTINE_ENROLLMENT', 'DOCUMENTS_PENDING', 'PAPER_RECORDS_HELD_BY_SCHOOL', 'PAYMENT_HANDLED_OUTSIDE_HON',
  'LEGACY_MEMBERSHIP', 'SCHOLARSHIP_OR_COMP', 'STAFF_FAMILY', 'OTHER'] as const;
export const MEMBERSHIP_ADULT_VERIFICATION_METHODS = ['ID_CHECKED_IN_PERSON', 'DOCUMENT_REVIEWED', 'SELF_DECLARED_TO_STAFF'] as const;
export const MEMBERSHIP_ACTIVATION_WARNING_CODES = ['BIRTH_DATE_MISSING', 'CRM_IDENTITY_REVIEW_PENDING', 'END_DATE_PASSED', 'EXISTING_INVOICE_NOT_EVALUATED',
  'EXISTING_PAYMENT_SCHEDULE_NOT_EVALUATED', 'FIXED_TERM_DIFFERS_FROM_PLAN', 'LEGACY_FREE_TEXT_PLAN', 'OPEN_ENDED_PLAN_HAS_END_DATE',
  'START_DATE_BACKDATED', 'START_DATE_IN_FUTURE'] as const;
export const MEMBERSHIP_ACTIVATION_BLOCK_CODES = ['CRM_DRAFT_CHANGED', 'END_DATE_BEFORE_START', 'END_DATE_OUT_OF_RANGE', 'FIXED_TERM_END_DATE_REQUIRED',
  'MEMBERSHIP_NOT_DRAFT', 'MINOR_GUARDIAN_OF_RECORD_REQUIRED', 'PLAN_BINDING_INVALID', 'PLAN_CURRENCY_MISMATCH', 'START_DATE_OUT_OF_RANGE'] as const;
export const MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED = ['AGREEMENT', 'PAYMENT', 'RECURRING_PAYMENT_AUTHORIZATION', 'FINANCIAL_RESPONSIBILITY', 'SCHOOL_ACTIVATION_POLICY'] as const;
export const MEMBERSHIP_ACTIVATION_SOURCES = ['GENERIC_LEGACY', 'OWNER_LAUNCH', 'CRM_ADULT_FREE_TEXT', 'CRM_ADULT_PLAN', 'CRM_GUARDIAN_CHILD_PLAN'] as const;
export const MEMBERSHIP_EFFECTIVE_STATUSES = ['SCHEDULED', 'IN_EFFECT', 'ENDED'] as const;
/** Returned for a pre-0177 `{ expectedVersion }` activation body: old clients fail closed and must preview first. */
export const MEMBERSHIP_ACTIVATION_TWO_STEP_REQUIRED = 'ACTIVATION_TWO_STEP_CONFIRMATION_REQUIRED' as const;

export type MembershipActivationReasonCode = typeof MEMBERSHIP_ACTIVATION_REASON_CODES[number];
export type MembershipActivationWarningCode = typeof MEMBERSHIP_ACTIVATION_WARNING_CODES[number];
export type MembershipActivationBlockCode = typeof MEMBERSHIP_ACTIVATION_BLOCK_CODES[number];
export type MembershipEffectiveStatus = typeof MEMBERSHIP_EFFECTIVE_STATUSES[number];
export type MembershipActivationSource = typeof MEMBERSHIP_ACTIVATION_SOURCES[number];

/** School-local calendar date, YYYY-MM-DD. The end date is inclusive (the last day of membership). */
export type SchoolLocalDate = string;

/** `{}` previews the suggested dates; a date pair previews exactly those dates (endDate null = open-ended). */
export type MembershipActivationPreviewInput = Record<string, never> | { startDate: SchoolLocalDate; endDate: SchoolLocalDate | null };

export interface MembershipActivationWarning { code: MembershipActivationWarningCode; days?: number; planEndDate?: SchoolLocalDate }
export interface MembershipActivationBlock { code: MembershipActivationBlockCode }

export interface MembershipActivationPreview {
  membershipId: string;
  state: 'DRAFT' | 'ACTIVE' | 'FROZEN' | 'CANCELLATION_PENDING' | 'CANCELLED' | 'EXPIRED';
  version: number;
  billingAccountId: string;
  participantPersonId: string;
  participantDisplayName: string | null;
  planCode: string;
  source: MembershipActivationSource;
  plan: null | { membershipPlanId: string; membershipPlanVersion: number; terms: Record<string, unknown> | null };
  existingTerm: { termStartedAt: string | null; termEndsAt: string | null };
  schoolTimezone: string;
  localToday: SchoolLocalDate;
  birthDateRecorded: boolean;
  knownMinor: boolean;
  suggestedDates: { startDate: SchoolLocalDate; endDate: SchoolLocalDate | null; startBasis: 'DRAFT_START_DATE' | 'TODAY_IN_SCHOOL_TIMEZONE';
    endBasis: 'PLAN_FIXED_TERM' | 'PLAN_OPEN_ENDED' | 'DRAFT_END_DATE' | 'NO_END_DATE' };
  proposedDates: { startDate: SchoolLocalDate | null; endDate: SchoolLocalDate | null; dateSource: 'SUGGESTED' | 'STAFF_ADJUSTED' };
  projection: null | { termStartedAt: string; termEndsAt: string | null };
  effectiveStatusIfConfirmedNow: MembershipEffectiveStatus | null;
  warnings: MembershipActivationWarning[];
  overridableWarnings: MembershipActivationWarningCode[];
  availableOverrides: MembershipActivationWarningCode[];
  blocks: MembershipActivationBlock[];
  canConfirm: boolean;
  requirementsNotEvaluated: typeof MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED[number][];
  previewDigest: string;
  confirmation: typeof MEMBERSHIP_ACTIVATION_CONFIRMATION;
}

export interface MembershipActivationOverrideInput { code: MembershipActivationWarningCode; reason: string; confirmation: typeof MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION }

export interface ConfirmMembershipActivationInput {
  expectedVersion: number;
  previewDigest: string;
  startDate: SchoolLocalDate;
  endDate: SchoolLocalDate | null;
  dateSource: 'SUGGESTED' | 'STAFF_ADJUSTED';
  /** Required exactly when dateSource is STAFF_ADJUSTED. */
  dateAdjustmentReason?: string;
  /** Exactly the warning codes the preview listed. */
  acknowledgedWarnings: MembershipActivationWarningCode[];
  /** Exactly the preview's overridable warnings; needs billing.membership.activation.override. */
  overrides: MembershipActivationOverrideInput[];
  /** Optional staff attestation, only when the birth date is missing (D3). Never a birth date. */
  adultVerification?: { method: typeof MEMBERSHIP_ADULT_VERIFICATION_METHODS[number]; attestation: typeof MEMBERSHIP_ADULT_VERIFICATION_ATTESTATION };
  reasonCode: MembershipActivationReasonCode;
  /** Required for OTHER and for a backdated start. */
  reasonText?: string;
  confirmation: typeof MEMBERSHIP_ACTIVATION_CONFIRMATION;
}

export interface MembershipActivationReceipt {
  membershipId: string;
  state: 'ACTIVE';
  version: number;
  previousVersion: number;
  decisionId: string;
  decisionBasis: 'STAFF_ACTIVATION_PRE_POLICY';
  membershipSource: MembershipActivationSource;
  authorizingPermission: 'billing.membership.activate';
  overridePermission: 'billing.membership.activation.override' | null;
  effectivePeriod: { periodVersion: 1; startDate: SchoolLocalDate; endDate: SchoolLocalDate | null; endDateInclusive: true; schoolTimezone: string;
    dateSource: 'SUGGESTED' | 'STAFF_ADJUSTED'; termStartedAt: string; termEndsAt: string | null };
  /** ACTIVE is the confirmed lifecycle state; benefits start only when this is IN_EFFECT. */
  effectiveStatusAtActivation: MembershipEffectiveStatus;
  acknowledgedWarnings: MembershipActivationWarningCode[];
  overridesUsed: { code: MembershipActivationWarningCode; resolved: false }[];
  followUps: { kind: 'BIRTH_DATE_MISSING' | 'IDENTITY_REVIEW_UNRESOLVED'; workItemId: string }[];
  adultVerification: null | { kind: 'STAFF_ATTESTATION'; method: typeof MEMBERSHIP_ADULT_VERIFICATION_METHODS[number] };
  reasonCode: MembershipActivationReasonCode;
  requirementsNotEvaluated: typeof MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED[number][];
  recordedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
function invalid(): never { throw new Error('Unverified membership activation data.'); }
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
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid();
  return value;
}
/** Real calendar date YYYY-MM-DD. */
export function isSchoolLocalDate(value: unknown): value is SchoolLocalDate {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function date(value: unknown): SchoolLocalDate { if (!isSchoolLocalDate(value)) invalid(); return value; }
function nullableDate(value: unknown): SchoolLocalDate | null { return value === null ? null : date(value); }
/** Same rule as the database: 1..max characters, no surrounding whitespace, no control or invisible formatting characters. */
function text(value: unknown, max: number, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '') !== value
    || /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/u.test(value)) invalid();
  return value;
}
function codes<T extends string>(value: unknown, allowed: readonly T[], max = 20): T[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  const out = value.map(item => oneOf(item, allowed));
  if (new Set(out).size !== out.length) invalid();
  return out;
}

export function validateMembershipActivationPreviewInput(value: unknown): MembershipActivationPreviewInput {
  const row = record(value, ['startDate', 'endDate'], []);
  const keys = Object.keys(row);
  if (keys.length === 0) return {};
  if (keys.length !== 2) invalid();
  return { startDate: date(row.startDate), endDate: nullableDate(row.endDate) };
}

/** True for the pre-0177 activation body, which must fail closed with MEMBERSHIP_ACTIVATION_TWO_STEP_REQUIRED. */
export function isLegacyMembershipActivationInput(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length > 0 && Object.keys(value).every(key => key === 'expectedVersion');
}

export function validateConfirmMembershipActivationInput(value: unknown): ConfirmMembershipActivationInput {
  const row = record(value, ['expectedVersion', 'previewDigest', 'startDate', 'endDate', 'dateSource', 'dateAdjustmentReason', 'acknowledgedWarnings',
    'overrides', 'adultVerification', 'reasonCode', 'reasonText', 'confirmation'],
  ['expectedVersion', 'previewDigest', 'startDate', 'endDate', 'dateSource', 'acknowledgedWarnings', 'overrides', 'reasonCode', 'confirmation']);
  if (row.confirmation !== MEMBERSHIP_ACTIVATION_CONFIRMATION || typeof row.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.previewDigest)) invalid();
  const dateSource = oneOf(row.dateSource, ['SUGGESTED', 'STAFF_ADJUSTED'] as const);
  if ((dateSource === 'STAFF_ADJUSTED') !== Object.hasOwn(row, 'dateAdjustmentReason')) invalid();
  const startDate = date(row.startDate);
  const endDate = nullableDate(row.endDate);
  if (endDate !== null && endDate < startDate) invalid();
  if (!Array.isArray(row.overrides) || row.overrides.length > 5) invalid();
  const overrides = row.overrides.map(entry => {
    const o = record(entry, ['code', 'reason', 'confirmation']);
    if (o.confirmation !== MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION) invalid();
    return { code: oneOf(o.code, MEMBERSHIP_ACTIVATION_WARNING_CODES), reason: text(o.reason, 500, 10), confirmation: MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION };
  });
  if (new Set(overrides.map(o => o.code)).size !== overrides.length) invalid();
  const reasonCode = oneOf(row.reasonCode, MEMBERSHIP_ACTIVATION_REASON_CODES);
  if (reasonCode === 'OTHER' && !Object.hasOwn(row, 'reasonText')) invalid();
  const out: ConfirmMembershipActivationInput = {
    expectedVersion: count(row.expectedVersion, 1),
    previewDigest: row.previewDigest,
    startDate,
    endDate,
    dateSource,
    acknowledgedWarnings: codes(row.acknowledgedWarnings, MEMBERSHIP_ACTIVATION_WARNING_CODES),
    overrides,
    reasonCode,
    confirmation: MEMBERSHIP_ACTIVATION_CONFIRMATION,
  };
  if (Object.hasOwn(row, 'dateAdjustmentReason')) out.dateAdjustmentReason = text(row.dateAdjustmentReason, 500);
  if (Object.hasOwn(row, 'reasonText')) out.reasonText = text(row.reasonText, 500);
  if (Object.hasOwn(row, 'adultVerification')) {
    const a = record(row.adultVerification, ['method', 'attestation']);
    if (a.attestation !== MEMBERSHIP_ADULT_VERIFICATION_ATTESTATION) invalid();
    out.adultVerification = { method: oneOf(a.method, MEMBERSHIP_ADULT_VERIFICATION_METHODS), attestation: MEMBERSHIP_ADULT_VERIFICATION_ATTESTATION };
  }
  return out;
}

function warnings(value: unknown): MembershipActivationWarning[] {
  if (!Array.isArray(value) || value.length > 20) invalid();
  return value.map(entry => {
    const w = record(entry, ['code', 'days', 'planEndDate'], ['code']);
    const out: MembershipActivationWarning = { code: oneOf(w.code, MEMBERSHIP_ACTIVATION_WARNING_CODES) };
    if (Object.hasOwn(w, 'days')) out.days = count(w.days, 1);
    if (Object.hasOwn(w, 'planEndDate')) out.planEndDate = date(w.planEndDate);
    return out;
  });
}

export function verifyMembershipActivationPreview(value: unknown): MembershipActivationPreview {
  const row = record(value, ['membershipId', 'state', 'version', 'billingAccountId', 'participantPersonId', 'participantDisplayName', 'planCode', 'source', 'plan',
    'existingTerm', 'schoolTimezone', 'localToday', 'birthDateRecorded', 'knownMinor', 'suggestedDates', 'proposedDates', 'projection',
    'effectiveStatusIfConfirmedNow', 'warnings', 'overridableWarnings', 'availableOverrides', 'blocks', 'canConfirm', 'requirementsNotEvaluated',
    'previewDigest', 'confirmation']);
  if (typeof row.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.previewDigest) || row.confirmation !== MEMBERSHIP_ACTIVATION_CONFIRMATION
    || JSON.stringify(row.requirementsNotEvaluated) !== JSON.stringify(MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED)
    || typeof row.schoolTimezone !== 'string' || !row.schoolTimezone || row.schoolTimezone.length > 64 || typeof row.planCode !== 'string') invalid();
  const existing = record(row.existingTerm, ['termStartedAt', 'termEndsAt']);
  const suggested = record(row.suggestedDates, ['startDate', 'endDate', 'startBasis', 'endBasis']);
  const proposed = record(row.proposedDates, ['startDate', 'endDate', 'dateSource']);
  let plan: MembershipActivationPreview['plan'] = null;
  if (row.plan !== null) {
    const p = record(row.plan, ['membershipPlanId', 'membershipPlanVersion', 'terms']);
    if (p.terms !== null && (typeof p.terms !== 'object' || Array.isArray(p.terms))) invalid();
    plan = { membershipPlanId: uuid(p.membershipPlanId), membershipPlanVersion: count(p.membershipPlanVersion, 1), terms: p.terms as Record<string, unknown> | null };
  }
  let projection: MembershipActivationPreview['projection'] = null;
  if (row.projection !== null) {
    const p = record(row.projection, ['termStartedAt', 'termEndsAt']);
    projection = { termStartedAt: instant(p.termStartedAt), termEndsAt: p.termEndsAt === null ? null : instant(p.termEndsAt) };
  }
  if (!Array.isArray(row.blocks)) invalid();
  return {
    membershipId: uuid(row.membershipId),
    state: oneOf(row.state, ['DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED'] as const),
    version: count(row.version, 1),
    billingAccountId: uuid(row.billingAccountId),
    participantPersonId: uuid(row.participantPersonId),
    participantDisplayName: row.participantDisplayName === null ? null : text(row.participantDisplayName, 201),
    planCode: row.planCode,
    source: oneOf(row.source, MEMBERSHIP_ACTIVATION_SOURCES),
    plan,
    existingTerm: { termStartedAt: existing.termStartedAt === null ? null : instant(existing.termStartedAt), termEndsAt: existing.termEndsAt === null ? null : instant(existing.termEndsAt) },
    schoolTimezone: row.schoolTimezone,
    localToday: date(row.localToday),
    birthDateRecorded: bool(row.birthDateRecorded),
    knownMinor: bool(row.knownMinor),
    suggestedDates: { startDate: date(suggested.startDate), endDate: nullableDate(suggested.endDate),
      startBasis: oneOf(suggested.startBasis, ['DRAFT_START_DATE', 'TODAY_IN_SCHOOL_TIMEZONE'] as const),
      endBasis: oneOf(suggested.endBasis, ['PLAN_FIXED_TERM', 'PLAN_OPEN_ENDED', 'DRAFT_END_DATE', 'NO_END_DATE'] as const) },
    proposedDates: { startDate: proposed.startDate === null ? null : date(proposed.startDate), endDate: nullableDate(proposed.endDate),
      dateSource: oneOf(proposed.dateSource, ['SUGGESTED', 'STAFF_ADJUSTED'] as const) },
    projection,
    effectiveStatusIfConfirmedNow: row.effectiveStatusIfConfirmedNow === null ? null : oneOf(row.effectiveStatusIfConfirmedNow, MEMBERSHIP_EFFECTIVE_STATUSES),
    warnings: warnings(row.warnings),
    overridableWarnings: codes(row.overridableWarnings, MEMBERSHIP_ACTIVATION_WARNING_CODES),
    availableOverrides: codes(row.availableOverrides, MEMBERSHIP_ACTIVATION_WARNING_CODES),
    blocks: row.blocks.map(entry => ({ code: oneOf(record(entry, ['code']).code, MEMBERSHIP_ACTIVATION_BLOCK_CODES) })),
    canConfirm: bool(row.canConfirm),
    requirementsNotEvaluated: [...MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED],
    previewDigest: row.previewDigest,
    confirmation: MEMBERSHIP_ACTIVATION_CONFIRMATION,
  };
}

export function verifyMembershipActivationReceipt(value: unknown, membershipId?: string): MembershipActivationReceipt {
  const row = record(value, ['membershipId', 'state', 'version', 'previousVersion', 'decisionId', 'decisionBasis', 'membershipSource', 'authorizingPermission',
    'overridePermission', 'effectivePeriod', 'effectiveStatusAtActivation', 'acknowledgedWarnings', 'overridesUsed', 'followUps', 'adultVerification',
    'reasonCode', 'requirementsNotEvaluated', 'recordedAt']);
  const period = record(row.effectivePeriod, ['periodVersion', 'startDate', 'endDate', 'endDateInclusive', 'schoolTimezone', 'dateSource', 'termStartedAt', 'termEndsAt']);
  if (row.state !== 'ACTIVE' || row.decisionBasis !== 'STAFF_ACTIVATION_PRE_POLICY' || row.authorizingPermission !== 'billing.membership.activate'
    || (row.overridePermission !== null && row.overridePermission !== 'billing.membership.activation.override')
    || period.periodVersion !== 1 || period.endDateInclusive !== true || typeof period.schoolTimezone !== 'string' || !period.schoolTimezone
    || JSON.stringify(row.requirementsNotEvaluated) !== JSON.stringify(MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED)
    || !Array.isArray(row.overridesUsed) || !Array.isArray(row.followUps)) invalid();
  const version = count(row.version, 2);
  if (count(row.previousVersion, 1) !== version - 1) invalid();
  const startDate = date(period.startDate);
  const endDate = nullableDate(period.endDate);
  if (endDate !== null && endDate < startDate) invalid();
  const overridesUsed = row.overridesUsed.map(entry => {
    const o = record(entry, ['code', 'resolved']);
    if (o.resolved !== false) invalid();
    return { code: oneOf(o.code, MEMBERSHIP_ACTIVATION_WARNING_CODES), resolved: false as const };
  });
  if ((row.overridePermission === null) !== (overridesUsed.length === 0)) invalid();
  let adultVerification: MembershipActivationReceipt['adultVerification'] = null;
  if (row.adultVerification !== null) {
    const a = record(row.adultVerification, ['kind', 'method']);
    if (a.kind !== 'STAFF_ATTESTATION') invalid();
    adultVerification = { kind: 'STAFF_ATTESTATION', method: oneOf(a.method, MEMBERSHIP_ADULT_VERIFICATION_METHODS) };
  }
  const receipt: MembershipActivationReceipt = {
    membershipId: uuid(row.membershipId),
    state: 'ACTIVE',
    version,
    previousVersion: version - 1,
    decisionId: uuid(row.decisionId),
    decisionBasis: 'STAFF_ACTIVATION_PRE_POLICY',
    membershipSource: oneOf(row.membershipSource, MEMBERSHIP_ACTIVATION_SOURCES),
    authorizingPermission: 'billing.membership.activate',
    overridePermission: row.overridePermission === null ? null : 'billing.membership.activation.override',
    effectivePeriod: { periodVersion: 1, startDate, endDate, endDateInclusive: true, schoolTimezone: period.schoolTimezone as string,
      dateSource: oneOf(period.dateSource, ['SUGGESTED', 'STAFF_ADJUSTED'] as const), termStartedAt: instant(period.termStartedAt),
      termEndsAt: period.termEndsAt === null ? null : instant(period.termEndsAt) },
    effectiveStatusAtActivation: oneOf(row.effectiveStatusAtActivation, MEMBERSHIP_EFFECTIVE_STATUSES),
    acknowledgedWarnings: codes(row.acknowledgedWarnings, MEMBERSHIP_ACTIVATION_WARNING_CODES),
    overridesUsed,
    followUps: row.followUps.map(entry => {
      const f = record(entry, ['kind', 'workItemId']);
      return { kind: oneOf(f.kind, ['BIRTH_DATE_MISSING', 'IDENTITY_REVIEW_UNRESOLVED'] as const), workItemId: uuid(f.workItemId) };
    }),
    adultVerification,
    reasonCode: oneOf(row.reasonCode, MEMBERSHIP_ACTIVATION_REASON_CODES),
    requirementsNotEvaluated: [...MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED],
    recordedAt: instant(row.recordedAt),
  };
  if (membershipId !== undefined && receipt.membershipId !== membershipId.toLowerCase()) invalid();
  if (receipt.effectivePeriod.termEndsAt !== null && Date.parse(receipt.effectivePeriod.termEndsAt) <= Date.parse(receipt.effectivePeriod.termStartedAt)) invalid();
  return receipt;
}
