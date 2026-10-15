import type { ParentFamilyAccessLevel } from './index.js';

/** Deliberately display-only status values: no criterion, evaluator, rank, eligibility, or action data. */
export const PARENT_TESTING_CANDIDATE_STATUSES = ['PENDING', 'PASSED', 'DEFERRED', 'NOT_PASSED', 'WITHDRAWN'] as const;
export const PARENT_TESTING_INTEREST_STATUSES = ['SUBMITTED', 'ACCEPTED', 'DECLINED', 'WAITLISTED'] as const;
export type ParentTestingCandidateStatus = (typeof PARENT_TESTING_CANDIDATE_STATUSES)[number];
export type ParentTestingInterestStatus = (typeof PARENT_TESTING_INTEREST_STATUSES)[number];

export interface ParentTestingEventTiming { label: string; startsAt: string; endsAt: string | null }
export interface ParentTestingCandidateObservation { event: ParentTestingEventTiming; overallStatus: ParentTestingCandidateStatus }
export interface ParentTestingInterestObservation { event: ParentTestingEventTiming; status: ParentTestingInterestStatus; submittedAt: string; reviewedAt: string | null }
export type ParentTestingStatusList<T> = { status: 'AVAILABLE'; items: T[]; limited: boolean };
export type ParentTestingCertificateStatus =
  | { status: 'ISSUED' }
  | { status: 'NOT_ISSUED' }
  | { status: 'UNAVAILABLE'; reason: 'GUARDIAN_SCOPE_REQUIRED' | 'PAYER_LINK_UNVERIFIED' };

/** No identifiers, evaluator data, criteria, comments, ranks, decisions, payment, or download data. */
export interface ParentTestingChildStatus {
  displayName: string;
  upcomingEvent: ParentTestingEventTiming | null;
  candidates: ParentTestingStatusList<ParentTestingCandidateObservation>;
  registrationInterests: ParentTestingStatusList<ParentTestingInterestObservation>;
  certificate: ParentTestingCertificateStatus;
}
export interface ParentTestingStatusView {
  generatedAt: string;
  accessLevel: ParentFamilyAccessLevel;
  children: ParentTestingStatusList<ParentTestingChildStatus>;
}

function invalid(): never { throw new Error('Parent testing status response could not be verified.'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) invalid();
  return record;
}
function text(value: unknown, maximum = 400): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || [...value].length > maximum || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value)) invalid();
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) invalid();
  return new Date(result).toISOString();
}
function values<const T extends readonly string[]>(value: unknown, options: T): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) invalid();
  return value as T[number];
}
function timing(value: unknown): ParentTestingEventTiming {
  const record = object(value, ['label', 'startsAt', 'endsAt']);
  const startsAt = timestamp(record.startsAt), endsAt = record.endsAt === null ? null : timestamp(record.endsAt);
  if (endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) invalid();
  return { label: text(record.label, 200), startsAt, endsAt };
}
function list<T>(value: unknown, parse: (item: unknown) => T, maximum = 100): ParentTestingStatusList<T> {
  const record = object(value, ['status', 'items', 'limited']);
  if (record.status !== 'AVAILABLE' || typeof record.limited !== 'boolean' || !Array.isArray(record.items) || record.items.length > maximum) invalid();
  return { status: 'AVAILABLE', items: record.items.map(parse), limited: record.limited };
}
function candidate(value: unknown): ParentTestingCandidateObservation {
  const record = object(value, ['event', 'overallStatus']);
  return { event: timing(record.event), overallStatus: values(record.overallStatus, PARENT_TESTING_CANDIDATE_STATUSES) };
}
function interest(value: unknown): ParentTestingInterestObservation {
  const record = object(value, ['event', 'status', 'submittedAt', 'reviewedAt']);
  const status = values(record.status, PARENT_TESTING_INTEREST_STATUSES);
  const submittedAt = timestamp(record.submittedAt), reviewedAt = record.reviewedAt === null ? null : timestamp(record.reviewedAt);
  if ((status === 'SUBMITTED') !== (reviewedAt === null)) invalid();
  return { event: timing(record.event), status, submittedAt, reviewedAt };
}
function certificate(value: unknown): ParentTestingCertificateStatus {
  if (value && typeof value === 'object' && !Array.isArray(value) && (value as { status?: unknown }).status === 'UNAVAILABLE') {
    const record = object(value, ['status', 'reason']);
    return { status: 'UNAVAILABLE', reason: values(record.reason, ['GUARDIAN_SCOPE_REQUIRED', 'PAYER_LINK_UNVERIFIED']) };
  }
  const record = object(value, ['status']);
  return { status: values(record.status, ['ISSUED', 'NOT_ISSUED']) };
}
function child(value: unknown): ParentTestingChildStatus {
  const record = object(value, ['displayName', 'upcomingEvent', 'candidates', 'registrationInterests', 'certificate']);
  return {
    displayName: text(record.displayName, 400),
    upcomingEvent: record.upcomingEvent === null ? null : timing(record.upcomingEvent),
    candidates: list(record.candidates, candidate, 50),
    registrationInterests: list(record.registrationInterests, interest, 50),
    certificate: certificate(record.certificate),
  };
}

export function verifyParentTestingStatusView(value: unknown): ParentTestingStatusView {
  const record = object(value, ['generatedAt', 'accessLevel', 'children']);
  return {
    generatedAt: timestamp(record.generatedAt),
    accessLevel: values(record.accessLevel, ['PRIMARY_GUARDIAN', 'SECONDARY_GUARDIAN', 'VIEWER']),
    children: list(record.children, child, 100),
  };
}
