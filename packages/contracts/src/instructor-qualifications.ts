import type { CommandContext } from './index.js';

export const INSTRUCTOR_QUALIFICATION_PERMISSIONS = [
  'staff.instructor_qualification.read',
  'staff.instructor_qualification.manage',
] as const;
export type InstructorQualificationPermission = (typeof INSTRUCTOR_QUALIFICATION_PERMISSIONS)[number];
export type InstructorQualificationKind = 'QUALIFICATION' | 'CERTIFICATION';
export type InstructorQualificationStatus = 'ACTIVE' | 'RETIRED';
export type InstructorEvidenceReviewStatus = 'RECORDED' | 'REVIEWED' | 'RETIRED';

export interface InstructorQualificationContext extends CommandContext {
  externalSubject: string;
  source: 'HUMAN_UI';
}

/** A bounded school-local definition. `courseProgramId` is an optional existing `programs` UUID, never a class assignment. */
export interface CreateInstructorQualificationInput {
  code: string;
  title: string;
  kind: InstructorQualificationKind;
  courseProgramId: string | null;
}

export interface RetireInstructorQualificationInput {
  expectedVersion: number;
}

/** Evidence is human-recorded internal metadata; opaque reference text is never returned by redacted projections. */
export interface RecordInstructorQualificationEvidenceInput {
  qualificationId: string;
  expectedQualificationVersion: number;
  attainedOn: string;
  expiresOn: string | null;
  evidenceReference: string;
}

/** Review is an internal human state record, not certification, eligibility, or legal verification. */
export interface ReviewInstructorQualificationEvidenceInput {
  expectedReviewVersion: number;
  status: Exclude<InstructorEvidenceReviewStatus, 'RECORDED'>;
  reviewNote: string;
}

export interface InstructorQualificationDefinition {
  id: string;
  code: string;
  title: string;
  kind: InstructorQualificationKind;
  courseProgramId: string | null;
  version: number;
  status: InstructorQualificationStatus;
  humanRecordedOnly: true;
  qualificationOnly: true;
}

/** Deliberately redacted: no employee directory/contact data and no raw evidence or review-note text. */
export interface InstructorQualificationEvidence {
  id: string;
  staffPrincipalId: string;
  qualificationId: string;
  qualificationVersion: number;
  courseProgramId: string | null;
  kind: InstructorQualificationKind;
  attainedOn: string;
  expiresOn: string | null;
  evidenceRecordedAt: string;
  evidenceRecorded: true;
  reviewVersion: number;
  reviewStatus: InstructorEvidenceReviewStatus;
  reviewedAt: string;
  expiredOnRead: boolean;
  humanRecordedOnly: true;
  qualificationOnly: true;
  notEligibility: true;
}

export interface InstructorQualificationAccess {
  canRead: boolean;
  canManage: boolean;
  humanRecordedOnly: true;
  qualificationOnly: true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff<>\[\]{}=`$]/;
function invalid(): never { throw new Error('Use only exact known UUIDs, bounded human-recorded qualification fields, and current expected versions.'); }
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
function text(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value || UNSAFE.test(value)) invalid();
}
export function validateInstructorQualificationUuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
export function validateInstructorQualificationDate(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) invalid();
}
function expected(value: unknown, zero = false): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1) || Number(value) > 999_999_999) invalid();
}
export function validateCreateInstructorQualification(value: unknown): asserts value is CreateInstructorQualificationInput {
  closed(value, ['code', 'title', 'kind', 'courseProgramId']);
  if (typeof value.code !== 'string' || !/^[A-Z][A-Z0-9_.-]{0,63}$/.test(value.code)) invalid();
  text(value.title, 120);
  if (!['QUALIFICATION', 'CERTIFICATION'].includes(String(value.kind))) invalid();
  if (value.courseProgramId !== null) validateInstructorQualificationUuid(value.courseProgramId);
}
export function validateRetireInstructorQualification(value: unknown): asserts value is RetireInstructorQualificationInput {
  closed(value, ['expectedVersion']); expected(value.expectedVersion);
}
export function validateRecordInstructorQualificationEvidence(value: unknown): asserts value is RecordInstructorQualificationEvidenceInput {
  closed(value, ['qualificationId', 'expectedQualificationVersion', 'attainedOn', 'expiresOn', 'evidenceReference']);
  validateInstructorQualificationUuid(value.qualificationId); expected(value.expectedQualificationVersion); validateInstructorQualificationDate(value.attainedOn);
  if (value.expiresOn !== null) { validateInstructorQualificationDate(value.expiresOn); if (Date.parse(value.expiresOn) < Date.parse(value.attainedOn)) invalid(); }
  text(value.evidenceReference, 160);
}
export function validateReviewInstructorQualificationEvidence(value: unknown): asserts value is ReviewInstructorQualificationEvidenceInput {
  closed(value, ['expectedReviewVersion', 'status', 'reviewNote']); expected(value.expectedReviewVersion);
  if (!['REVIEWED', 'RETIRED'].includes(String(value.status))) invalid(); text(value.reviewNote, 500);
}
