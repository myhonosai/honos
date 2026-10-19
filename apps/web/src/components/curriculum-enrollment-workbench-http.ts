import type { EnrollStudentCurriculumInput, StudentCurriculumEnrollmentSummary } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_MAX = 999_999_999;
const RESPONSE_MAX = 12_000;

export type CurriculumEnrollmentKnownIds = Readonly<{
  organizationId: string;
  schoolId: string;
  curriculumId: string;
  studentProfileId: string;
  /** Blank is the deliberate browser representation of an unranked enrollment. */
  currentRankId: string;
}>;
export type PreparedCurriculumEnrollment = Readonly<{
  path: string;
  ids: CurriculumEnrollmentKnownIds;
  key: string;
  body: string;
}>;
export type CurriculumEnrollmentReceipt = {
  enrollment: StudentCurriculumEnrollmentSummary;
  replayed: boolean;
};
export class CurriculumEnrollmentRejectedError extends Error {}
export class CurriculumEnrollmentUncertainError extends Error {}
export class CurriculumEnrollmentAccessError extends CurriculumEnrollmentRejectedError {
  constructor(readonly status: 401 | 403) {
    super('Current verified human session or exact school curriculum permission is unavailable. Inputs, receipt and retry were cleared.');
  }
}

function invalid(): never {
  throw new Error('Unverified exact curriculum enrollment contract. No enrollment outcome is assumed.');
}
function closed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) invalid();
}
function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
}
function version(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > VERSION_MAX) invalid();
}
// PostgreSQL JSON timestamps may have microseconds and a UTC offset, not JS's .000Z shape.
function timestamp(value: unknown): void {
  if (typeof value !== 'string') invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) invalid();
  const [, year, month, day, hour, minute, second, zone, zoneHour, zoneMinute] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (zone !== 'Z' && (Number(zoneHour) > 14 || Number(zoneMinute) > 59 || (Number(zoneHour) === 14 && Number(zoneMinute) !== 0)))) invalid();
}

/** Local syntax only: IDs select records but never establish a human's authority. */
export function validateCurriculumEnrollmentDraft(ids: CurriculumEnrollmentKnownIds): void {
  closed(ids, ['organizationId', 'schoolId', 'curriculumId', 'studentProfileId', 'currentRankId']);
  for (const field of ['organizationId', 'schoolId', 'curriculumId', 'studentProfileId'] as const) uuid(ids[field]);
  if (ids.currentRankId !== '') uuid(ids.currentRankId);
}
export function curriculumEnrollmentCommandPath(ids: CurriculumEnrollmentKnownIds): string {
  validateCurriculumEnrollmentDraft(ids);
  return `/api/v1/organizations/${ids.organizationId.toLowerCase()}/schools/${ids.schoolId.toLowerCase()}/curricula/${ids.curriculumId.toLowerCase()}/enrollments`;
}
function normalizedIds(ids: CurriculumEnrollmentKnownIds): CurriculumEnrollmentKnownIds {
  return Object.freeze({
    organizationId: ids.organizationId.toLowerCase(), schoolId: ids.schoolId.toLowerCase(), curriculumId: ids.curriculumId.toLowerCase(),
    studentProfileId: ids.studentProfileId.toLowerCase(), currentRankId: ids.currentRankId === '' ? '' : ids.currentRankId.toLowerCase(),
  });
}
function inputFor(ids: CurriculumEnrollmentKnownIds): EnrollStudentCurriculumInput {
  return { studentProfileId: ids.studentProfileId, currentRankId: ids.currentRankId === '' ? null : ids.currentRankId };
}

/** Only the explicit confirmed submit handler allocates a UUID key; this function never sends. */
export function prepareCurriculumEnrollment(ids: CurriculumEnrollmentKnownIds, key: string): PreparedCurriculumEnrollment {
  validateCurriculumEnrollmentDraft(ids); uuid(key); if (key[14] !== '4') invalid();
  const normalized = normalizedIds(ids);
  return Object.freeze({ path: curriculumEnrollmentCommandPath(normalized), ids: normalized, key, body: JSON.stringify(inputFor(normalized)) });
}
function commandInput(command: PreparedCurriculumEnrollment): EnrollStudentCurriculumInput {
  closed(command, ['path', 'ids', 'key', 'body']); validateCurriculumEnrollmentDraft(command.ids); uuid(command.key);
  if (command.key[14] !== '4' || command.path !== curriculumEnrollmentCommandPath(command.ids)
    || typeof command.body !== 'string' || command.body.length > 200) invalid();
  const input: unknown = JSON.parse(command.body);
  closed(input, ['studentProfileId', 'currentRankId']); uuid(input.studentProfileId);
  if (input.currentRankId !== null) uuid(input.currentRankId);
  if (command.body !== JSON.stringify({ studentProfileId: input.studentProfileId.toLowerCase(), currentRankId: input.currentRankId === null ? null : input.currentRankId.toLowerCase() })) invalid();
  if (input.studentProfileId.toLowerCase() !== command.ids.studentProfileId || input.currentRankId !== (command.ids.currentRankId === '' ? null : command.ids.currentRankId)) invalid();
  return input as unknown as EnrollStudentCurriculumInput;
}

/** Accept only the canonical redacted enrollment receipt for this exact input and an ACTIVE enrollment. */
export function parseCurriculumEnrollmentReceipt(value: unknown, command: PreparedCurriculumEnrollment): CurriculumEnrollmentReceipt {
  const input = commandInput(command);
  closed(value, ['data', 'meta']); closed(value.meta, ['requestId', 'correlationId', 'replayed']);
  uuid(value.meta.requestId); uuid(value.meta.correlationId);
  if (value.meta.requestId !== value.meta.correlationId || typeof value.meta.replayed !== 'boolean') invalid();
  closed(value.data, ['id', 'studentProfileId', 'currentRankId', 'curriculumId', 'version', 'status', 'enrolledAt']);
  const enrollment = value.data;
  for (const field of ['id', 'studentProfileId', 'curriculumId']) uuid(enrollment[field]);
  if (enrollment.currentRankId !== null) uuid(enrollment.currentRankId);
  version(enrollment.version); timestamp(enrollment.enrolledAt);
  if ((enrollment.studentProfileId as string).toLowerCase() !== input.studentProfileId
    || (enrollment.curriculumId as string).toLowerCase() !== command.ids.curriculumId
    || enrollment.currentRankId !== input.currentRankId || enrollment.status !== 'ACTIVE') invalid();
  return { enrollment: Object.freeze(enrollment) as unknown as StudentCurriculumEnrollmentSummary, replayed: value.meta.replayed };
}

const posture = { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
async function json(response: Response): Promise<unknown> {
  if (response.status !== 200 || !response.ok || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const text = await response.text(); if (text.length > RESPONSE_MAX) invalid(); return JSON.parse(text);
}

/** POST only. No discovery/read path and no automatic retry. */
export async function submitCurriculumEnrollment(command: PreparedCurriculumEnrollment): Promise<CurriculumEnrollmentReceipt> {
  commandInput(command); let response: Response;
  try {
    response = await fetch(command.path, {
      ...posture, method: 'POST', headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'curriculum-progress',
      }, body: command.body,
    });
  } catch {
    throw new CurriculumEnrollmentUncertainError('Enrollment outcome is uncertain. No receipt is assumed; only the exact retained command may be retried.');
  }
  if (response.status === 401 || response.status === 403) throw new CurriculumEnrollmentAccessError(response.status);
  if ([400, 404, 409, 413, 415, 422].includes(response.status)) {
    throw new CurriculumEnrollmentRejectedError('Curriculum enrollment command rejected. No verified receipt; review the exact known IDs before a new explicit submit.');
  }
  try {
    return parseCurriculumEnrollmentReceipt(await json(response), command);
  } catch {
    throw new CurriculumEnrollmentUncertainError('No verified exact ACTIVE enrollment receipt was returned. Outcome is uncertain; only the unchanged retained command may be retried.');
  }
}
