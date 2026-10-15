import type { CommandContext } from './index.js';

export const TESTING_REGISTRATION_INTEREST_STATUSES = ['SUBMITTED', 'ACCEPTED', 'DECLINED', 'WAITLISTED'] as const;
export type TestingRegistrationInterestStatus = (typeof TESTING_REGISTRATION_INTEREST_STATUSES)[number];
export const TESTING_REGISTRATION_REVIEW_DECISIONS = ['ACCEPT', 'DECLINE', 'WAITLIST'] as const;
export type TestingRegistrationReviewDecision = (typeof TESTING_REGISTRATION_REVIEW_DECISIONS)[number];

/** Server-derived family and staff context only; browser identifiers are selectors, never authority. */
export interface TestingRegistrationContext extends CommandContext { externalSubject: string }
export interface SubmitTestingRegistrationInterestInput { studentProfileId: string; testingEventId: string; note?: string | undefined }
export interface DecideTestingRegistrationInterestInput { decision: TestingRegistrationReviewDecision; expectedVersion: number }

/** Current verified-family options. They omit family, staff, curriculum, eligibility, rank, roster and payment data. */
export interface ParentTestingRegistrationChild { studentProfileId: string; displayName: string }
export interface ParentTestingRegistrationEvent { testingEventId: string; name: string; startsAt: string; endsAt: string | null }
/** Parent status is deliberately redacted: no registration ID, staff identity or review rationale. */
export interface ParentTestingRegistrationStatus { childName: string; eventName: string; startsAt: string; status: TestingRegistrationInterestStatus; submittedAt: string; reviewedAt: string | null }
export interface ParentTestingRegistrationView { children: ParentTestingRegistrationChild[]; events: ParentTestingRegistrationEvent[]; registrations: ParentTestingRegistrationStatus[] }
export interface ParentTestingInterestReceipt { status: 'SUBMITTED'; submittedAt: string; version: number }

/** Staff review projection is limited to the registration decision and current bounded parent note. */
export interface StaffTestingRegistration { id: string; childName: string; eventName: string; startsAt: string; status: TestingRegistrationInterestStatus; parentNote: string | null; submittedAt: string; reviewedAt: string | null; version: number }
export interface StaffTestingRegistrationView { registrations: StaffTestingRegistration[]; limited: boolean }
export interface StaffTestingRegistrationReviewReceipt { id: string; status: Exclude<TestingRegistrationInterestStatus, 'SUBMITTED'>; reviewedAt: string; version: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
function invalid(): never { throw new Error('Testing registration data could not be verified.'); }
function object(v: unknown, keys: readonly string[]): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) invalid(); return v as Record<string, unknown>; }
function text(v: unknown, max: number): string { if (typeof v !== 'string' || !v.trim() || v.trim() !== v || [...v].length > max || UNSAFE.test(v)) invalid(); return v; }
function nullableText(v: unknown, max: number): string | null { return v === null ? null : text(v, max); }
function uuid(v: unknown): string { const x = text(v, 36); if (!UUID.test(x)) invalid(); return x; }
function status(v: unknown): TestingRegistrationInterestStatus { if (typeof v !== 'string' || !TESTING_REGISTRATION_INTEREST_STATUSES.includes(v as TestingRegistrationInterestStatus)) invalid(); return v as TestingRegistrationInterestStatus; }
function timestamp(v: unknown): string { const x = text(v, 40); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(x) || !Number.isFinite(Date.parse(x))) invalid(); return new Date(x).toISOString(); }
function version(v: unknown): number { if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > 999999999) invalid(); return Number(v); }
function list<T>(v: unknown, item: (entry: unknown) => T, max: number): T[] { if (!Array.isArray(v) || v.length > max) invalid(); return v.map(item); }

export function validateTestingRegistrationInterestInput(v: unknown): asserts v is SubmitTestingRegistrationInterestInput {
  const r = object(v, Object.hasOwn(v as object, 'note') ? ['studentProfileId', 'testingEventId', 'note'] : ['studentProfileId', 'testingEventId']);
  uuid(r.studentProfileId); uuid(r.testingEventId);
  if (Object.hasOwn(r, 'note')) text(r.note, 500);
}
export function validateTestingRegistrationReviewInput(v: unknown): asserts v is DecideTestingRegistrationInterestInput {
  const r = object(v, ['decision', 'expectedVersion']);
  if (typeof r.decision !== 'string' || !TESTING_REGISTRATION_REVIEW_DECISIONS.includes(r.decision as TestingRegistrationReviewDecision)) invalid();
  if (!Number.isSafeInteger(r.expectedVersion) || Number(r.expectedVersion) < 1 || Number(r.expectedVersion) > 999999998) invalid();
}

export function verifyParentTestingRegistrationView(v: unknown): ParentTestingRegistrationView {
  const r = object(v, ['children', 'events', 'registrations']);
  const children = list(r.children, x => { const a = object(x, ['studentProfileId', 'displayName']); return { studentProfileId: uuid(a.studentProfileId), displayName: text(a.displayName, 400) }; }, 100);
  const events = list(r.events, x => { const a = object(x, ['testingEventId', 'name', 'startsAt', 'endsAt']); const startsAt = timestamp(a.startsAt), endsAt = a.endsAt === null ? null : timestamp(a.endsAt); if (endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) invalid(); return { testingEventId: uuid(a.testingEventId), name: text(a.name, 200), startsAt, endsAt }; }, 50);
  const registrations = list(r.registrations, x => { const a = object(x, ['childName', 'eventName', 'startsAt', 'status', 'submittedAt', 'reviewedAt']); const s = status(a.status), submittedAt = timestamp(a.submittedAt), reviewedAt = a.reviewedAt === null ? null : timestamp(a.reviewedAt); if ((s === 'SUBMITTED') !== (reviewedAt === null)) invalid(); return { childName: text(a.childName, 400), eventName: text(a.eventName, 200), startsAt: timestamp(a.startsAt), status: s, submittedAt, reviewedAt }; }, 100);
  return { children, events, registrations };
}
export function verifyParentTestingInterestReceipt(v: unknown): ParentTestingInterestReceipt {
  const r = object(v, ['status', 'submittedAt', 'version']); if (r.status !== 'SUBMITTED') invalid(); return { status: 'SUBMITTED', submittedAt: timestamp(r.submittedAt), version: version(r.version) };
}
export function verifyStaffTestingRegistrationView(v: unknown): StaffTestingRegistrationView {
  const r = object(v, ['registrations', 'limited']); if (typeof r.limited !== 'boolean') invalid();
  const registrations = list(r.registrations, x => { const a = object(x, ['id', 'childName', 'eventName', 'startsAt', 'status', 'parentNote', 'submittedAt', 'reviewedAt', 'version']); const s = status(a.status), reviewedAt = a.reviewedAt === null ? null : timestamp(a.reviewedAt); if ((s === 'SUBMITTED') !== (reviewedAt === null)) invalid(); return { id: uuid(a.id), childName: text(a.childName, 400), eventName: text(a.eventName, 200), startsAt: timestamp(a.startsAt), status: s, parentNote: nullableText(a.parentNote, 500), submittedAt: timestamp(a.submittedAt), reviewedAt, version: version(a.version) }; }, 100);
  return { registrations, limited: r.limited };
}
export function verifyStaffTestingRegistrationReviewReceipt(v: unknown): StaffTestingRegistrationReviewReceipt {
  const r = object(v, ['id', 'status', 'reviewedAt', 'version']); const s = status(r.status); if (s === 'SUBMITTED') invalid(); return { id: uuid(r.id), status: s, reviewedAt: timestamp(r.reviewedAt), version: version(r.version) };
}
