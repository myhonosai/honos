import { communityUuid } from './community.js';

/** A versioned observed-facts projection; this is never a score or prediction. */
export const RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION = 'RETENTION_REVIEW_SIGNALS_V1' as const;
export const RETENTION_REVIEW_PERMISSION = 'retention.review.read' as const;
export type RetentionReviewAvailability = 'AVAILABLE' | 'UNAVAILABLE' | 'INSUFFICIENT_DATA';
export type RetentionReviewTermObservation = 'TERM_END_NOT_RECORDED' | 'TERM_ENDED' | 'ENDING_WITHIN_30_DAYS' | 'ENDING_AFTER_30_DAYS';
export type RetentionReviewMembershipState = 'DRAFT' | 'ACTIVE' | 'FROZEN' | 'CANCELLATION_PENDING' | 'CANCELLED' | 'EXPIRED';
export type RetentionReviewRenewalState = 'OPEN' | 'REVIEWED' | 'DEFERRED' | 'CLOSED';
export type RetentionReviewProgressAvailability = 'AVAILABLE' | 'UNAVAILABLE';

export interface RetentionReviewSignalsContext {
  organizationId: string;
  schoolId: string;
  principalId: string;
  externalSubject: string;
  principalType: string;
  source: string;
  requestId: string;
  correlationId: string;
  actionRequestId?: string;
  delegatedByPrincipalId?: string;
}

export interface RetentionReviewMembershipTerm {
  status: 'AVAILABLE' | 'UNAVAILABLE';
  membershipState: RetentionReviewMembershipState;
  termStartedAt: string | null;
  termEndsAt: string | null;
  endingObservation: RetentionReviewTermObservation;
  reason: 'TERM_DATES_NOT_RECORDED' | null;
}
export interface RetentionReviewRenewalReview {
  status: 'AVAILABLE' | 'UNAVAILABLE';
  latestReviewState: RetentionReviewRenewalState | null;
  recordedAt: string | null;
  reason: 'NO_EXPLICIT_RENEWAL_REVIEW_RECORDED' | null;
}
export interface RetentionReviewFollowUp {
  status: 'UNAVAILABLE';
  reason: 'NO_UNAMBIGUOUS_MEMBERSHIP_TO_FOLLOW_UP_RELATION';
}
export interface RetentionReviewAttendance {
  status: RetentionReviewAvailability;
  windowFrom: string;
  windowTo: string;
  recordedAttendanceCount: number;
  presentCount: number;
  lateCount: number;
  makeupCount: number;
  excusedAbsenceCount: number;
  unexcusedAbsenceCount: number;
  reason: 'NO_MATCHING_STUDENT_PROFILE' | 'AMBIGUOUS_STUDENT_PROFILE_LINK' | 'NO_RECORDED_ATTENDANCE_IN_WINDOW' | null;
}
export interface RetentionReviewProgression {
  status: 'AVAILABLE' | 'UNAVAILABLE';
  curriculumEnrollmentCount: number;
  progressObservationCount: number;
  testingRecordCount: number;
  progressObservationAvailability: RetentionReviewProgressAvailability;
  testingObservationAvailability: RetentionReviewProgressAvailability;
  reason: 'NO_MATCHING_STUDENT_PROFILE' | 'AMBIGUOUS_STUDENT_PROFILE_LINK' | 'NO_CURRICULUM_ENROLLMENT_RECORDED' | null;
}

/** Deliberately redacted: it has no person, student, staff, family, payer, payment, note, or provider fields. */
export interface RetentionReviewSignals {
  schemaVersion: typeof RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION;
  membershipId: string;
  observedAt: string;
  humanOnly: true;
  readOnly: true;
  evidenceOnly: true;
  predictionOrAutomaticAction: false;
  membershipTerm: RetentionReviewMembershipTerm;
  renewalReview: RetentionReviewRenewalReview;
  followUp: RetentionReviewFollowUp;
  attendance: RetentionReviewAttendance;
  progression: RetentionReviewProgression;
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
type Row = Record<string, unknown>;
function invalid(): never { throw new Error('Retention Review Signals response was not a verified redacted observed-facts projection.'); }
function row(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const source = value as Row;
  if (Object.keys(source).length !== keys.length || keys.some(key => !Object.hasOwn(source, key))) invalid();
  return source;
}
function timestamp(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !UTC.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function count(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(); return value; }
function oneOf<T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(); return value as T; }
function exactReason<T extends string>(value: unknown, expected: T | null): T | null { if (value !== expected) invalid(); return expected; }
function scopedId(value: unknown, expected?: string): string {
  try { communityUuid(value); } catch { invalid(); }
  const id = value as string;
  if (expected && id !== expected) invalid();
  return id;
}

function membershipTerm(value: unknown): RetentionReviewMembershipTerm {
  const source = row(value, ['status','membershipState','termStartedAt','termEndsAt','endingObservation','reason']);
  const status = oneOf(source.status, ['AVAILABLE','UNAVAILABLE'] as const);
  const started = timestamp(source.termStartedAt, true); const ends = timestamp(source.termEndsAt, true);
  const endingObservation = oneOf(source.endingObservation, ['TERM_END_NOT_RECORDED','TERM_ENDED','ENDING_WITHIN_30_DAYS','ENDING_AFTER_30_DAYS'] as const);
  const membershipState = oneOf(source.membershipState, ['DRAFT','ACTIVE','FROZEN','CANCELLATION_PENDING','CANCELLED','EXPIRED'] as const);
  const expected = status === 'UNAVAILABLE' ? 'TERM_DATES_NOT_RECORDED' : null;
  if ((status === 'AVAILABLE') !== (started !== null && ends !== null) || (ends === null) !== (endingObservation === 'TERM_END_NOT_RECORDED')) invalid();
  return { status, membershipState, termStartedAt: started, termEndsAt: ends, endingObservation, reason: exactReason(source.reason, expected) };
}
function renewalReview(value: unknown): RetentionReviewRenewalReview {
  const source = row(value, ['status','latestReviewState','recordedAt','reason']);
  const status = oneOf(source.status, ['AVAILABLE','UNAVAILABLE'] as const);
  const state = source.latestReviewState === null ? null : oneOf(source.latestReviewState, ['OPEN','REVIEWED','DEFERRED','CLOSED'] as const);
  const recordedAt = timestamp(source.recordedAt, true);
  const expected = status === 'UNAVAILABLE' ? 'NO_EXPLICIT_RENEWAL_REVIEW_RECORDED' : null;
  if ((status === 'AVAILABLE') !== (state !== null && recordedAt !== null)) invalid();
  return { status, latestReviewState: state, recordedAt, reason: exactReason(source.reason, expected) };
}
function attendance(value: unknown, observedAt: string): RetentionReviewAttendance {
  const source = row(value, ['status','windowFrom','windowTo','recordedAttendanceCount','presentCount','lateCount','makeupCount','excusedAbsenceCount','unexcusedAbsenceCount','reason']);
  const status = oneOf(source.status, ['AVAILABLE','UNAVAILABLE','INSUFFICIENT_DATA'] as const);
  const windowFrom = timestamp(source.windowFrom)!; const windowTo = timestamp(source.windowTo)!;
  const recordedAttendanceCount = count(source.recordedAttendanceCount); const presentCount = count(source.presentCount); const lateCount = count(source.lateCount); const makeupCount = count(source.makeupCount); const excusedAbsenceCount = count(source.excusedAbsenceCount); const unexcusedAbsenceCount = count(source.unexcusedAbsenceCount);
  if (windowTo !== observedAt || Date.parse(windowTo) - Date.parse(windowFrom) !== 28 * 86_400_000 || presentCount + lateCount + makeupCount + excusedAbsenceCount + unexcusedAbsenceCount !== recordedAttendanceCount) invalid();
  const expected = status === 'AVAILABLE' ? null : status === 'INSUFFICIENT_DATA' ? 'NO_RECORDED_ATTENDANCE_IN_WINDOW' : oneOf(source.reason, ['NO_MATCHING_STUDENT_PROFILE','AMBIGUOUS_STUDENT_PROFILE_LINK'] as const);
  if ((status === 'AVAILABLE') !== (recordedAttendanceCount > 0) || (status === 'INSUFFICIENT_DATA' && recordedAttendanceCount !== 0) || (status === 'UNAVAILABLE' && recordedAttendanceCount !== 0)) invalid();
  return { status, windowFrom, windowTo, recordedAttendanceCount, presentCount, lateCount, makeupCount, excusedAbsenceCount, unexcusedAbsenceCount, reason: exactReason(source.reason, expected) };
}
function progression(value: unknown): RetentionReviewProgression {
  const source = row(value, ['status','curriculumEnrollmentCount','progressObservationCount','testingRecordCount','progressObservationAvailability','testingObservationAvailability','reason']);
  const status = oneOf(source.status, ['AVAILABLE','UNAVAILABLE'] as const);
  const curriculumEnrollmentCount = count(source.curriculumEnrollmentCount); const progressObservationCount = count(source.progressObservationCount); const testingRecordCount = count(source.testingRecordCount);
  const progressObservationAvailability = oneOf(source.progressObservationAvailability, ['AVAILABLE','UNAVAILABLE'] as const); const testingObservationAvailability = oneOf(source.testingObservationAvailability, ['AVAILABLE','UNAVAILABLE'] as const);
  if ((status === 'AVAILABLE') !== (curriculumEnrollmentCount > 0) || (progressObservationAvailability === 'AVAILABLE') !== (progressObservationCount > 0) || (testingObservationAvailability === 'AVAILABLE') !== (testingRecordCount > 0)) invalid();
  const expected = status === 'AVAILABLE' ? null : oneOf(source.reason, ['NO_MATCHING_STUDENT_PROFILE','AMBIGUOUS_STUDENT_PROFILE_LINK','NO_CURRICULUM_ENROLLMENT_RECORDED'] as const);
  return { status, curriculumEnrollmentCount, progressObservationCount, testingRecordCount, progressObservationAvailability, testingObservationAvailability, reason: exactReason(source.reason, expected) };
}

export function verifyRetentionReviewSignals(value: unknown, expectedMembershipId?: string): RetentionReviewSignals {
  const source = row(value, ['schemaVersion','membershipId','observedAt','humanOnly','readOnly','evidenceOnly','predictionOrAutomaticAction','membershipTerm','renewalReview','followUp','attendance','progression']);
  if (source.schemaVersion !== RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION || source.humanOnly !== true || source.readOnly !== true || source.evidenceOnly !== true || source.predictionOrAutomaticAction !== false) invalid();
  const membershipId = scopedId(source.membershipId, expectedMembershipId); const observedAt = timestamp(source.observedAt)!;
  const followUp = row(source.followUp, ['status','reason']);
  if (followUp.status !== 'UNAVAILABLE' || followUp.reason !== 'NO_UNAMBIGUOUS_MEMBERSHIP_TO_FOLLOW_UP_RELATION') invalid();
  return { schemaVersion: RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION, membershipId, observedAt, humanOnly: true, readOnly: true, evidenceOnly: true, predictionOrAutomaticAction: false, membershipTerm: membershipTerm(source.membershipTerm), renewalReview: renewalReview(source.renewalReview), followUp: { status: 'UNAVAILABLE', reason: 'NO_UNAMBIGUOUS_MEMBERSHIP_TO_FOLLOW_UP_RELATION' }, attendance: attendance(source.attendance, observedAt), progression: progression(source.progression) };
}

/** Acknowledgement records review only; the underlying signals remain read-only. */
export const RETENTION_REVIEW_ACKNOWLEDGE_PERMISSION = 'retention.review.acknowledge' as const;
export interface RetentionReviewAcknowledgementEvidence {
  signals: RetentionReviewSignals;
  evidenceVersion: typeof RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION;
  evidenceFingerprint: string;
}
export interface RetentionReviewAcknowledgementInput {
  evidenceVersion: typeof RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION;
  evidenceFingerprint: string;
  observedAt: string;
  idempotencyKey: string;
}
export interface RetentionReviewAcknowledgement {
  schemaVersion: 'RETENTION_REVIEW_ACKNOWLEDGEMENT_V1';
  membershipId: string;
  acknowledgementId: string;
  evidenceVersion: typeof RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION;
  evidenceFingerprint: string;
  observedAt: string;
  recordedAt: string;
  state: 'EVIDENCE_REVIEWED';
  humanOnly: true;
  evidenceOnly: true;
  noDownstreamEffect: true;
}
function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid();
  return value;
}
export function verifyRetentionReviewAcknowledgementEvidence(value: unknown, membershipId?: string): RetentionReviewAcknowledgementEvidence {
  const source = row(value, ['signals','evidenceVersion','evidenceFingerprint']);
  if (source.evidenceVersion !== RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION) invalid();
  return { signals: verifyRetentionReviewSignals(source.signals, membershipId), evidenceVersion: RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION, evidenceFingerprint: fingerprint(source.evidenceFingerprint) };
}
export function verifyRetentionReviewAcknowledgementInput(value: unknown): RetentionReviewAcknowledgementInput {
  const source = row(value, ['evidenceVersion','evidenceFingerprint','observedAt','idempotencyKey']);
  if (source.evidenceVersion !== RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION) invalid();
  return { evidenceVersion: RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION, evidenceFingerprint: fingerprint(source.evidenceFingerprint), observedAt: timestamp(source.observedAt)!, idempotencyKey: scopedId(source.idempotencyKey) };
}
export function verifyRetentionReviewAcknowledgement(value: unknown, membershipId: string, expected: Omit<RetentionReviewAcknowledgementInput,'idempotencyKey'>): RetentionReviewAcknowledgement {
  const source = row(value, ['schemaVersion','membershipId','acknowledgementId','evidenceVersion','evidenceFingerprint','observedAt','recordedAt','state','humanOnly','evidenceOnly','noDownstreamEffect']);
  if (source.schemaVersion !== 'RETENTION_REVIEW_ACKNOWLEDGEMENT_V1' || source.state !== 'EVIDENCE_REVIEWED' || source.humanOnly !== true || source.evidenceOnly !== true || source.noDownstreamEffect !== true
    || source.evidenceVersion !== RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION || source.evidenceVersion !== expected.evidenceVersion || source.evidenceFingerprint !== expected.evidenceFingerprint || source.observedAt !== expected.observedAt) invalid();
  const observedAt = timestamp(source.observedAt)!; const recordedAt = timestamp(source.recordedAt)!;
  if (Date.parse(recordedAt) < Date.parse(observedAt) || Date.parse(recordedAt) - Date.parse(observedAt) > 5 * 60_000) invalid();
  return { schemaVersion: 'RETENTION_REVIEW_ACKNOWLEDGEMENT_V1', membershipId: scopedId(source.membershipId, membershipId), acknowledgementId: scopedId(source.acknowledgementId), evidenceVersion: RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION, evidenceFingerprint: fingerprint(source.evidenceFingerprint), observedAt, recordedAt, state: 'EVIDENCE_REVIEWED', humanOnly: true, evidenceOnly: true, noDownstreamEffect: true };
}
