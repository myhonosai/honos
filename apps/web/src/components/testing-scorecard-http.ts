export type TestingScorecardAssessment = 'OBSERVED' | 'NOT_OBSERVED' | 'NEEDS_FOLLOW_UP';
export interface TestingScorecardEvaluation { id: string; criterionCode: string; assessment: TestingScorecardAssessment; recordedAt: string; version: number; recordedByYou: boolean; }
export interface TestingScorecardView {
  testingCandidateId: string; testingEventId: string; candidateVersion: number; testingEventVersion: number;
  scorecardId: string | null; scorecardVersion: number; evaluations: TestingScorecardEvaluation[]; evaluationsLimited: boolean;
}
export interface TestingScorecardReceipt { scorecardId: string; scorecardVersion: number; evaluation: TestingScorecardEvaluation; }
export class TestingScorecardAccessError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const criterion = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_.-]{0,63}$/.test(value);
const assessments: TestingScorecardAssessment[] = ['OBSERVED', 'NOT_OBSERVED', 'NEEDS_FOLLOW_UP'];
const keys = (value: object, expected: string[]) => Object.keys(value).sort().join('|') === [...expected].sort().join('|');
function invalid(): never { throw new Error('The scorecard response was not a verified redacted record. No evaluation is assumed.'); }
function positive(value: unknown, zero = false): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= 999_999_999; }
function evaluation(value: unknown): TestingScorecardEvaluation {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !keys(value, ['id', 'criterionCode', 'assessment', 'recordedAt', 'version', 'recordedByYou'])) invalid();
  const row = value as Record<string, unknown>;
  if (!uuid(row.id) || !criterion(row.criterionCode) || !assessments.includes(row.assessment as TestingScorecardAssessment) || !positive(row.version) || typeof row.recordedByYou !== 'boolean' || typeof row.recordedAt !== 'string' || !Number.isFinite(Date.parse(row.recordedAt))) invalid();
  return { id: row.id, criterionCode: row.criterionCode, assessment: row.assessment as TestingScorecardAssessment, recordedAt: row.recordedAt, version: row.version, recordedByYou: row.recordedByYou };
}
function view(value: unknown, candidateId: string, eventId: string): TestingScorecardView {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !keys(value, ['testingCandidateId', 'testingEventId', 'candidateVersion', 'testingEventVersion', 'scorecardId', 'scorecardVersion', 'evaluations', 'evaluationsLimited'])) invalid();
  const row = value as Record<string, unknown>;
  if (!uuid(row.testingCandidateId) || !uuid(row.testingEventId) || row.testingCandidateId !== candidateId || row.testingEventId !== eventId || !positive(row.candidateVersion) || !positive(row.testingEventVersion) || !positive(row.scorecardVersion, true) || typeof row.evaluationsLimited !== 'boolean' || !Array.isArray(row.evaluations) || row.evaluations.length > 100) invalid();
  if (row.scorecardId === null ? row.scorecardVersion !== 0 || row.evaluations.length !== 0 : !uuid(row.scorecardId)) invalid();
  return { testingCandidateId: row.testingCandidateId, testingEventId: row.testingEventId, candidateVersion: row.candidateVersion, testingEventVersion: row.testingEventVersion, scorecardId: row.scorecardId as string | null, scorecardVersion: row.scorecardVersion, evaluations: row.evaluations.map(evaluation), evaluationsLimited: row.evaluationsLimited };
}
function receipt(value: unknown): TestingScorecardReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !keys(value, ['scorecardId', 'scorecardVersion', 'evaluation'])) invalid();
  const row = value as Record<string, unknown>; if (!uuid(row.scorecardId) || !positive(row.scorecardVersion)) invalid();
  return { scorecardId: row.scorecardId, scorecardVersion: row.scorecardVersion, evaluation: evaluation(row.evaluation) };
}
async function request(path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
  const url = new URL(path, 'https://hon.invalid');
  if (!path.startsWith('/api/v1/staff/testing/scorecards') || url.origin !== 'https://hon.invalid' || url.hash) invalid();
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'testing-scorecard', 'Idempotency-Key': idempotencyKey! } : { Accept: 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'Your session has ended. Sign in again.' : response.status === 403 ? 'Current direct human staff scorecard permission is unavailable. The record has been cleared.' : response.status === 404 ? 'That known candidate and testing event are unavailable together in your current school.' : response.status === 409 ? 'The candidate, event, scorecard, criterion, or retry key changed. Reload before recording.' : 'No verified scorecard result was returned. Nothing was recorded.';
    if ([401, 403].includes(response.status)) throw new TestingScorecardAccessError(message, response.status);
    throw new Error(message);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const envelope: unknown = await response.json();
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !Object.hasOwn(envelope, 'data')) invalid();
  return (envelope as { data: unknown }).data;
}
export async function loadTestingScorecard(schoolId: string, testingCandidateId: string, testingEventId: string): Promise<TestingScorecardView> {
  if (!uuid(schoolId) || !uuid(testingCandidateId) || !uuid(testingEventId)) invalid();
  const data = await request(`/api/v1/staff/testing/scorecards?schoolId=${encodeURIComponent(schoolId)}&testingCandidateId=${encodeURIComponent(testingCandidateId)}&testingEventId=${encodeURIComponent(testingEventId)}`);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !keys(data, ['scorecard'])) invalid();
  return view((data as { scorecard: unknown }).scorecard, testingCandidateId, testingEventId);
}
export async function recordTestingScorecardEvaluation(schoolId: string, input: { testingCandidateId: string; testingEventId: string; criterionCode: string; assessment: TestingScorecardAssessment; expectedCandidateVersion: number; expectedTestingEventVersion: number; expectedScorecardVersion: number }, idempotencyKey: string): Promise<TestingScorecardReceipt> {
  if (!uuid(schoolId) || !uuid(input.testingCandidateId) || !uuid(input.testingEventId) || !criterion(input.criterionCode) || !assessments.includes(input.assessment) || !positive(input.expectedCandidateVersion) || !positive(input.expectedTestingEventVersion) || !positive(input.expectedScorecardVersion, true) || !idempotencyKey || idempotencyKey.length > 200 || idempotencyKey.trim() !== idempotencyKey || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) invalid();
  const data = await request('/api/v1/staff/testing/scorecards', { schoolId, ...input }, idempotencyKey);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !keys(data, ['scorecard'])) invalid();
  return receipt((data as { scorecard: unknown }).scorecard);
}
