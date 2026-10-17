import type { RegisterTestingCandidateInput, TestingCandidateSummary } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_MAX = 20_000;
export type TestingCandidateKnownIds = Readonly<{ organizationId: string; schoolId: string; testingEventId: string; studentCurriculumEnrollmentId: string; targetRankId: string }>;
export type PreparedTestingCandidateRegistration = Readonly<{ path: string; ids: TestingCandidateKnownIds; key: string; body: string }>;
export type TestingCandidateRegistrationReceipt = Readonly<{ candidate: Readonly<TestingCandidateSummary & { result: 'PENDING'; version: 1 }>; replayed: boolean }>;
export class TestingCandidateRejectedError extends Error {}
export class TestingCandidateUncertainError extends Error {}
export class TestingCandidateAccessError extends Error {
  constructor(readonly status: 401 | 403) { super('Current verified human session or testing access is unavailable. Inputs, note, receipt and retry were cleared.'); }
}
function invalid(): never { throw new Error('Unverified exact testing candidate registration contract. No candidate outcome is assumed.'); }
function closed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) invalid();
}
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function timestamp(value: unknown): void {
  if (typeof value !== 'string') invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) invalid();
  const [, y, m, d, h, minute, s, zone, zh, zm] = match;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() + 1 !== Number(m) || date.getUTCDate() !== Number(d)
    || Number(h) > 23 || Number(minute) > 59 || Number(s) > 59 || (zone !== 'Z' && (Number(zh) > 14 || Number(zm) > 59 || (Number(zh) === 14 && Number(zm) !== 0)))) invalid();
}
export function validateTestingCandidateDraft(ids: TestingCandidateKnownIds, note: unknown): RegisterTestingCandidateInput {
  closed(ids, ['organizationId', 'schoolId', 'testingEventId', 'studentCurriculumEnrollmentId', 'targetRankId']); Object.values(ids).forEach(uuid);
  if (typeof note !== 'string' || note.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) invalid();
  const instructorNotes = note.trim();
  return { studentCurriculumEnrollmentId: ids.studentCurriculumEnrollmentId.toLowerCase(), targetRankId: ids.targetRankId.toLowerCase(), ...(instructorNotes ? { instructorNotes } : {}) };
}
function candidatePath(ids: TestingCandidateKnownIds): string {
  return `/api/v1/organizations/${ids.organizationId}/schools/${ids.schoolId}/testing/events/${ids.testingEventId}/candidates`;
}
/** Only the locally valid, explicitly confirmed UI submit allocates a key; preparation never sends. */
export function prepareTestingCandidateRegistration(ids: TestingCandidateKnownIds, note: string, key: string): PreparedTestingCandidateRegistration {
  const input = validateTestingCandidateDraft(ids, note); uuid(key); if (key[14] !== '4' || key !== key.toLowerCase()) invalid();
  const normalized = Object.freeze(Object.fromEntries(Object.entries(ids).map(([field, value]) => [field, value.toLowerCase()])) as TestingCandidateKnownIds);
  return Object.freeze({ path: candidatePath(normalized), ids: normalized, key, body: JSON.stringify(input) });
}
function commandInput(command: PreparedTestingCandidateRegistration): RegisterTestingCandidateInput {
  closed(command, ['path', 'ids', 'key', 'body']); validateTestingCandidateDraft(command.ids, ''); uuid(command.key);
  if (command.key[14] !== '4' || command.key !== command.key.toLowerCase() || Object.values(command.ids).some(value => value !== value.toLowerCase())
    || command.path !== candidatePath(command.ids) || typeof command.body !== 'string' || command.body.length > RESPONSE_MAX) invalid();
  const input: unknown = JSON.parse(command.body);
  const fields = ['studentCurriculumEnrollmentId', 'targetRankId'];
  if (input && typeof input === 'object' && Object.hasOwn(input, 'instructorNotes')) fields.push('instructorNotes');
  closed(input, fields);
  const expected = validateTestingCandidateDraft(command.ids, fields.length === 3 ? input.instructorNotes : '');
  if (command.body !== JSON.stringify(expected)) invalid();
  return expected;
}
export function parseTestingCandidateRegistration(value: unknown, command: PreparedTestingCandidateRegistration, status: number): TestingCandidateRegistrationReceipt {
  const input = commandInput(command);
  closed(value, ['data', 'meta']); closed(value.meta, ['requestId', 'correlationId', 'replayed']);
  uuid(value.meta.requestId); uuid(value.meta.correlationId);
  if (value.meta.requestId !== value.meta.correlationId || typeof value.meta.replayed !== 'boolean' || status !== (value.meta.replayed ? 200 : 201)) invalid();
  const fields = ['id', 'testingEventId', 'studentCurriculumEnrollmentId', 'targetRankId', 'result', 'version', 'createdAt'];
  if (input.instructorNotes !== undefined) fields.push('instructorNotes');
  closed(value.data, fields); const candidate = value.data;
  for (const field of ['id', 'testingEventId', 'studentCurriculumEnrollmentId', 'targetRankId']) uuid(candidate[field]);
  timestamp(candidate.createdAt);
  if ((candidate.testingEventId as string).toLowerCase() !== command.ids.testingEventId || (candidate.studentCurriculumEnrollmentId as string).toLowerCase() !== input.studentCurriculumEnrollmentId
    || (candidate.targetRankId as string).toLowerCase() !== input.targetRankId || candidate.result !== 'PENDING' || candidate.version !== 1
    || candidate.instructorNotes !== input.instructorNotes) invalid();
  // Notes are verified against the canonical trimmed command, but are not displayed by the UI.
  return Object.freeze({ candidate: Object.freeze(candidate) as unknown as TestingCandidateRegistrationReceipt['candidate'], replayed: value.meta.replayed });
}
const posture = { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
async function json(response: Response): Promise<unknown> {
  if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const text = await response.text(); if (text.length > RESPONSE_MAX) invalid(); return JSON.parse(text);
}
/** No read, alternate route, automatic retry or storage. Every explicit replay re-enters server authorization. */
export async function submitTestingCandidateRegistration(command: PreparedTestingCandidateRegistration): Promise<TestingCandidateRegistrationReceipt> {
  commandInput(command); let response: Response;
  try { response = await fetch(command.path, { ...posture, method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'testing' }, body: command.body }); }
  catch { throw new TestingCandidateUncertainError('Candidate outcome is uncertain. Only the exact in-memory command may be retried by a separate human action.'); }
  if (response.status === 401 || response.status === 403) throw new TestingCandidateAccessError(response.status);
  if (response.redirected) throw new TestingCandidateUncertainError('No verified candidate receipt was returned. The unchanged command alone may be retried.');
  if (response.status === 409) {
    // The existing service distinguishes an in-progress key from a definite duplicate/reused-key conflict.
    let problem: unknown;
    try { problem = await json(response); } catch { throw new TestingCandidateUncertainError('The conflict response could not be verified. No success is assumed; only the unchanged command may be retried.'); }
    if (problem && typeof problem === 'object' && !Array.isArray(problem) && Object.keys(problem).length === 2 && Object.hasOwn(problem, 'code') && Object.hasOwn(problem, 'detail')
      && (problem as Record<string, unknown>).code === 'IDEMPOTENCY_IN_PROGRESS' && typeof (problem as Record<string, unknown>).detail === 'string') {
      throw new TestingCandidateUncertainError('The matching candidate command is still in progress. No success is assumed; only an explicit unchanged retry is available.');
    }
  }
  if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) throw new TestingCandidateRejectedError('Candidate registration was rejected or conflicted. No success or retry is retained. Review the known IDs before a new confirmed command.');
  try {
    if (!response.ok || ![200, 201].includes(response.status)) invalid();
    return parseTestingCandidateRegistration(await json(response), command, response.status);
  } catch { throw new TestingCandidateUncertainError('No verified exact PENDING candidate receipt was returned. Outcome is uncertain; only the unchanged in-memory command may be retried.'); }
}
