import { TESTING_CANDIDATE_GRADE_RESULTS, type GradeTestingCandidateInput, type TestingCandidateGradeResult, type TestingCandidateSummary } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_MAX = 20_000;
export type TestingCandidateGradeIds = Readonly<{ organizationId: string; schoolId: string; candidateId: string }>;
export type PreparedTestingCandidateGrade = Readonly<{ path: string; ids: TestingCandidateGradeIds; key: string; body: string }>;
export type TestingCandidateGradeReceipt = Readonly<{ candidate: Readonly<TestingCandidateSummary & { result: TestingCandidateGradeResult }>; replayed: boolean }>;
export class TestingCandidateGradeRejectedError extends Error {}
export class TestingCandidateGradeUncertainError extends Error {}
export class TestingCandidateGradeAccessError extends Error {
  constructor(readonly status: 401 | 403) { super('Current verified human session or testing access is unavailable. Inputs, note, receipt and retry were cleared.'); }
}
function invalid(): never { throw new Error('Unverified exact testing candidate outcome contract. No outcome is assumed.'); }
function closed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) invalid();
}
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) invalid(); }
function timestamp(value: unknown): void {
  if (typeof value !== 'string') invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || match[0] !== value || !Number.isFinite(Date.parse(value))) invalid();
  const [, y, m, d, h, minute, s, zone, zh, zm] = match;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() + 1 !== Number(m) || date.getUTCDate() !== Number(d)
    || Number(h) > 23 || Number(minute) > 59 || Number(s) > 59 || (zone !== 'Z' && (Number(zh) > 14 || Number(zm) > 59 || (Number(zh) === 14 && Number(zm) !== 0)))) invalid();
}
/** Local syntax only; neither selectors nor an expected version confer authority or prove current facts. */
export function validateTestingCandidateGradeDraft(ids: TestingCandidateGradeIds, result: unknown, expectedVersion: unknown, note: unknown): GradeTestingCandidateInput {
  closed(ids, ['organizationId', 'schoolId', 'candidateId']); Object.values(ids).forEach(uuid);
  if (typeof result !== 'string' || !TESTING_CANDIDATE_GRADE_RESULTS.includes(result as TestingCandidateGradeResult)
    || typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !Number.isSafeInteger(expectedVersion + 1)
    || typeof note !== 'string' || note.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) invalid();
  const instructorNotes = note.trim();
  return { result: result as TestingCandidateGradeResult, ...(instructorNotes ? { instructorNotes } : {}), expectedVersion };
}
function candidatePath(ids: TestingCandidateGradeIds): string {
  return `/api/v1/organizations/${ids.organizationId}/schools/${ids.schoolId}/testing/candidates/${ids.candidateId}/grade`;
}
/** Only the valid, explicitly confirmed UI submit supplies its one generated v4 key. Preparation never sends. */
export function prepareTestingCandidateGrade(ids: TestingCandidateGradeIds, result: unknown, expectedVersion: unknown, note: string, key: string): PreparedTestingCandidateGrade {
  const input = validateTestingCandidateGradeDraft(ids, result, expectedVersion, note); uuid(key); if (key[14] !== '4' || key !== key.toLowerCase()) invalid();
  const normalized = Object.freeze(Object.fromEntries(Object.entries(ids).map(([field, value]) => [field, value.toLowerCase()])) as TestingCandidateGradeIds);
  return Object.freeze({ path: candidatePath(normalized), ids: normalized, key, body: JSON.stringify(input) });
}
function commandInput(command: PreparedTestingCandidateGrade): GradeTestingCandidateInput {
  closed(command, ['path', 'ids', 'key', 'body']); closed(command.ids, ['organizationId', 'schoolId', 'candidateId']); Object.values(command.ids).forEach(uuid); uuid(command.key);
  if (command.key[14] !== '4' || command.key !== command.key.toLowerCase() || Object.values(command.ids).some(value => value !== value.toLowerCase())
    || command.path !== candidatePath(command.ids) || typeof command.body !== 'string' || command.body.length > RESPONSE_MAX) invalid();
  const input: unknown = JSON.parse(command.body);
  const fields = ['result', 'expectedVersion'];
  if (input && typeof input === 'object' && Object.hasOwn(input, 'instructorNotes')) fields.push('instructorNotes');
  closed(input, fields);
  const expected = validateTestingCandidateGradeDraft(command.ids, input.result, input.expectedVersion, fields.length === 3 ? input.instructorNotes : '');
  if (command.body !== JSON.stringify(expected)) invalid();
  return expected;
}
export function parseTestingCandidateGrade(value: unknown, command: PreparedTestingCandidateGrade, status: number): TestingCandidateGradeReceipt {
  const input = commandInput(command);
  closed(value, ['data', 'meta']); closed(value.meta, ['requestId', 'correlationId', 'replayed']); uuid(value.meta.requestId); uuid(value.meta.correlationId);
  // The existing grade controller returns 200 for both first execution and replay.
  if (value.meta.requestId !== value.meta.correlationId || typeof value.meta.replayed !== 'boolean' || status !== 200) invalid();
  const fields = ['id', 'testingEventId', 'studentCurriculumEnrollmentId', 'targetRankId', 'result', 'version', 'createdAt'];
  if (input.instructorNotes !== undefined) fields.push('instructorNotes');
  closed(value.data, fields); const candidate = value.data;
  for (const field of ['id', 'testingEventId', 'studentCurriculumEnrollmentId', 'targetRankId']) uuid(candidate[field]);
  timestamp(candidate.createdAt);
  // A replay is the original command's snapshot, not the candidate's current version.
  if ((candidate.id as string).toLowerCase() !== command.ids.candidateId || candidate.result !== input.result
    || candidate.version !== input.expectedVersion + 1 || candidate.instructorNotes !== input.instructorNotes) invalid();
  return Object.freeze({ candidate: Object.freeze(candidate) as unknown as TestingCandidateGradeReceipt['candidate'], replayed: value.meta.replayed });
}
const posture = { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
async function json(response: Response): Promise<unknown> {
  if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const text = await response.text(); if (text.length > RESPONSE_MAX) invalid(); return JSON.parse(text);
}
/** No reads, discovery, alternative commands, automatic retries or browser storage. */
export async function submitTestingCandidateGrade(command: PreparedTestingCandidateGrade): Promise<TestingCandidateGradeReceipt> {
  commandInput(command); let response: Response;
  try { response = await fetch(command.path, { ...posture, method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'testing' }, body: command.body }); }
  catch { throw new TestingCandidateGradeUncertainError('Candidate outcome is uncertain. Only the exact in-memory command may be retried by a separate human action.'); }
  if (response.status === 401 || response.status === 403) throw new TestingCandidateGradeAccessError(response.status);
  if (response.redirected) throw new TestingCandidateGradeUncertainError('No verified candidate outcome receipt was returned. The unchanged command alone may be retried.');
  if (response.status === 409) {
    let problem: unknown;
    try { problem = await json(response); } catch { throw new TestingCandidateGradeUncertainError('The conflict response could not be verified. No success is assumed; only the unchanged command may be retried.'); }
    if (problem && typeof problem === 'object' && !Array.isArray(problem) && Object.keys(problem).length === 2 && Object.hasOwn(problem, 'code') && Object.hasOwn(problem, 'detail')
      && (problem as Record<string, unknown>).code === 'IDEMPOTENCY_IN_PROGRESS' && typeof (problem as Record<string, unknown>).detail === 'string') {
      throw new TestingCandidateGradeUncertainError('The matching candidate outcome command is still in progress. No success is assumed; only an explicit unchanged retry is available.');
    }
  }
  if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) throw new TestingCandidateGradeRejectedError('Candidate outcome was rejected or conflicted. No success or retry is retained. Obtain separately authorized current candidate/version information before a new confirmed command.');
  try {
    if (!response.ok || response.status !== 200) invalid();
    return parseTestingCandidateGrade(await json(response), command, response.status);
  } catch { throw new TestingCandidateGradeUncertainError('No verified exact candidate outcome receipt was returned. Outcome is uncertain; only the unchanged in-memory command may be retried.'); }
}
