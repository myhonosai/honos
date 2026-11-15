import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Read-only pick lists for the school the shell verified (owner decision 2026-11-15). Choosing a row only fills a
 * screen's own fields; every command still re-checks the record, school and permission on the server.
 */
export type PickerScope = Readonly<{ organizationId: string; schoolId: string }>;
export type EnrollmentPurpose = 'progress' | 'readiness' | 'testing';
export type CandidatePurpose = 'grade' | 'decision';
export type PickerEnrollment = Readonly<{ enrollmentId: string; curriculumId: string; curriculumName: string; studentProfileId: string; givenName: string; familyName: string;
  currentRankId: string | null; currentRankName: string | null; nextRankId: string | null; nextRankName: string | null; version: number }>;
export type PickerTestingEvent = Readonly<{ testingEventId: string; name: string; curriculumId: string; curriculumName: string; startsAt: string; status: string }>;
export type PickerCandidate = Readonly<{ candidateId: string; version: number; result: string; testingEventId: string; testingEventName: string; startsAt: string;
  studentProfileId: string; givenName: string; familyName: string; curriculumName: string; targetRankId: string; targetRankName: string }>;
export type PickerErrorKind = 'DENIED' | 'UNAVAILABLE';
export class PickerError extends Error { constructor(readonly kind: PickerErrorKind) { super(kind); } }
export const PICKER_LIMIT = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (): never => { throw new PickerError('UNAVAILABLE'); };
const uuid = (v: unknown) => typeof v === 'string' && UUID.test(v);
const text = (v: unknown) => typeof v === 'string' && v.length >= 1 && v.length <= 500;
const textOrNull = (v: unknown) => v === null || text(v);
const uuidOrNull = (v: unknown) => v === null || uuid(v);
const instant = (v: unknown) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const version = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1;
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const own = Object.keys(value as object);
  if (own.length !== keys.length || keys.some((k) => !own.includes(k))) fail();
  return value as Record<string, unknown>;
}
function rows(value: unknown): unknown[] {
  const body = closed(value, ['data', 'meta']); const meta = closed(body.meta, ['requestId', 'correlationId', 'limit']);
  if (!uuid(meta.requestId) || meta.correlationId !== meta.requestId || meta.limit !== PICKER_LIMIT || !Array.isArray(body.data) || body.data.length > PICKER_LIMIT) fail();
  return body.data as unknown[];
}
const unique = <T,>(items: T[], key: (item: T) => string): T[] => { if (new Set(items.map((i) => key(i).toLowerCase())).size !== items.length) fail(); return items; };

export function verifyEnrollments(value: unknown): PickerEnrollment[] {
  return unique(rows(value).map((item) => {
    const r = closed(item, ['enrollmentId', 'curriculumId', 'curriculumName', 'studentProfileId', 'givenName', 'familyName', 'currentRankId', 'currentRankName', 'nextRankId', 'nextRankName', 'version']);
    if (!uuid(r.enrollmentId) || !uuid(r.curriculumId) || !text(r.curriculumName) || !uuid(r.studentProfileId) || !text(r.givenName) || !text(r.familyName)
      || !uuidOrNull(r.currentRankId) || !textOrNull(r.currentRankName) || (r.currentRankId === null) !== (r.currentRankName === null)
      || !uuidOrNull(r.nextRankId) || !textOrNull(r.nextRankName) || (r.nextRankId === null) !== (r.nextRankName === null) || !version(r.version)) fail();
    return Object.freeze(r as unknown as PickerEnrollment);
  }), (r) => r.enrollmentId);
}
export function verifyTestingEvents(value: unknown): PickerTestingEvent[] {
  return unique(rows(value).map((item) => {
    const r = closed(item, ['testingEventId', 'name', 'curriculumId', 'curriculumName', 'startsAt', 'status']);
    if (!uuid(r.testingEventId) || !text(r.name) || !uuid(r.curriculumId) || !text(r.curriculumName) || !instant(r.startsAt) || !['DRAFT', 'OPEN', 'CLOSED'].includes(r.status as string)) fail();
    return Object.freeze(r as unknown as PickerTestingEvent);
  }), (r) => r.testingEventId);
}
export function verifyCandidates(value: unknown, purpose: CandidatePurpose): PickerCandidate[] {
  const allowed = purpose === 'grade' ? ['PENDING'] : ['PASSED', 'DEFERRED', 'NOT_PASSED'];
  return unique(rows(value).map((item) => {
    const r = closed(item, ['candidateId', 'version', 'result', 'testingEventId', 'testingEventName', 'startsAt', 'studentProfileId', 'givenName', 'familyName', 'curriculumName', 'targetRankId', 'targetRankName']);
    if (!uuid(r.candidateId) || !version(r.version) || !allowed.includes(r.result as string) || !uuid(r.testingEventId) || !text(r.testingEventName) || !instant(r.startsAt)
      || !uuid(r.studentProfileId) || !text(r.givenName) || !text(r.familyName) || !text(r.curriculumName) || !uuid(r.targetRankId) || !text(r.targetRankName)) fail();
    return Object.freeze(r as unknown as PickerCandidate);
  }), (r) => r.candidateId);
}

async function read(scope: PickerScope, list: string, query: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  if (!uuid(scope.organizationId) || !uuid(scope.schoolId)) fail();
  const params = new URLSearchParams(query);
  const path = `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/pickers/${list}${params.size ? `?${params}` : ''}`;
  let response: Response;
  try { response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal }); }
  catch (error) { if (signal.aborted) throw error; return fail(); }
  signal.throwIfAborted();
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new PickerError('DENIED'); }
  if (response.status === 403) throw new PickerError('DENIED');
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) fail();
  try { return await response.json(); } catch (error) { if (signal.aborted) throw error; return fail(); }
}
const search = (value: string) => { const s = value.trim().slice(0, 120); return s ? { search: s } : {}; };

export const pickerApi = {
  async enrollments(scope: PickerScope, purpose: EnrollmentPurpose, find: string, signal: AbortSignal, curriculumId = ''): Promise<PickerEnrollment[]> {
    if (curriculumId && !uuid(curriculumId)) fail();
    const rows = verifyEnrollments(await read(scope, 'enrollments', { for: purpose, ...(curriculumId ? { curriculumId: curriculumId.toLowerCase() } : {}), ...search(find) }, signal));
    if (curriculumId && rows.some((r) => r.curriculumId.toLowerCase() !== curriculumId.toLowerCase())) fail();
    return rows;
  },
  async testingEvents(scope: PickerScope, signal: AbortSignal): Promise<PickerTestingEvent[]> {
    return verifyTestingEvents(await read(scope, 'testing-events', {}, signal));
  },
  async candidates(scope: PickerScope, purpose: CandidatePurpose, find: string, signal: AbortSignal): Promise<PickerCandidate[]> {
    return verifyCandidates(await read(scope, 'testing-candidates', { for: purpose, ...search(find) }, signal), purpose);
  },
};
