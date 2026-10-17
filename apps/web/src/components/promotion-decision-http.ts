import { PROMOTION_DECISION_STATUSES, type PromotionDecisionStatus } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_MAX = 20_000;
export type PromotionDecisionIds = Readonly<{ organizationId: string; schoolId: string; candidateId: string }>;
type PromotionDecisionInput = Readonly<{ expectedVersion: number; status: PromotionDecisionStatus; rationale: string }>;
export type PreparedPromotionDecision = Readonly<{ path: string; ids: PromotionDecisionIds; key: string; body: string }>;
export type PromotionDecisionReceipt = Readonly<{ decision: Readonly<{ id: string; testingCandidateId: string; studentCurriculumEnrollmentId: string; priorRankId?: string; targetRankId: string; status: PromotionDecisionStatus; decidedAt: string; version: 1; createdAt: string }>; replayed: boolean }>;
export class PromotionDecisionRejectedError extends Error {}
export class PromotionDecisionUncertainError extends Error {}
export class PromotionDecisionAccessError extends Error {
  constructor(readonly status: 401 | 403) { super('Current verified human session or promotion-decision access is unavailable. Inputs, rationale, receipt and retry were cleared.'); }
}
function invalid(): never { throw new Error('Unverified exact promotion-decision contract. No decision is assumed.'); }
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
/** Local syntax only; entered IDs and candidate version never establish current facts or authority. */
export function validatePromotionDecisionDraft(ids: PromotionDecisionIds, expectedVersion: unknown, status: unknown, rationale: unknown): PromotionDecisionInput {
  closed(ids, ['organizationId', 'schoolId', 'candidateId']); Object.values(ids).forEach(uuid);
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !Number.isSafeInteger(expectedVersion + 1)
    || typeof status !== 'string' || !PROMOTION_DECISION_STATUSES.includes(status as PromotionDecisionStatus)
    || typeof rationale !== 'string' || rationale.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(rationale)) invalid();
  const normalizedRationale = rationale.trim();
  if (!normalizedRationale) invalid();
  return { expectedVersion, status: status as PromotionDecisionStatus, rationale: normalizedRationale };
}
function decisionPath(ids: PromotionDecisionIds): string {
  return `/api/v1/organizations/${ids.organizationId}/schools/${ids.schoolId}/testing/candidates/${ids.candidateId}/promotion-decision`;
}
/** Preparation never sends; only a confirmed submit provides one freshly generated v4 idempotency key. */
export function preparePromotionDecision(ids: PromotionDecisionIds, expectedVersion: unknown, status: unknown, rationale: string, key: string): PreparedPromotionDecision {
  const input = validatePromotionDecisionDraft(ids, expectedVersion, status, rationale); uuid(key); if (key[14] !== '4' || key !== key.toLowerCase()) invalid();
  const normalized = Object.freeze(Object.fromEntries(Object.entries(ids).map(([field, value]) => [field, value.toLowerCase()])) as PromotionDecisionIds);
  return Object.freeze({ path: decisionPath(normalized), ids: normalized, key, body: JSON.stringify(input) });
}
function commandInput(command: PreparedPromotionDecision): PromotionDecisionInput {
  closed(command, ['path', 'ids', 'key', 'body']); closed(command.ids, ['organizationId', 'schoolId', 'candidateId']); Object.values(command.ids).forEach(uuid); uuid(command.key);
  if (command.key[14] !== '4' || command.key !== command.key.toLowerCase() || Object.values(command.ids).some(value => value !== value.toLowerCase())
    || command.path !== decisionPath(command.ids) || typeof command.body !== 'string' || command.body.length > RESPONSE_MAX) invalid();
  const input: unknown = JSON.parse(command.body);
  closed(input, ['expectedVersion', 'status', 'rationale']);
  const expected = validatePromotionDecisionDraft(command.ids, input.expectedVersion, input.status, input.rationale);
  if (command.body !== JSON.stringify(expected)) invalid();
  return expected;
}
/** Parses the canonical wire projection but deliberately strips actor and rationale from the public receipt. */
export function parsePromotionDecision(value: unknown, command: PreparedPromotionDecision, status: number): PromotionDecisionReceipt {
  const input = commandInput(command);
  closed(value, ['data', 'meta']); closed(value.meta, ['requestId', 'correlationId', 'replayed']); uuid(value.meta.requestId); uuid(value.meta.correlationId);
  if (value.meta.requestId !== value.meta.correlationId || typeof value.meta.replayed !== 'boolean' || (status !== 201 && status !== 200) || (status === 201 && value.meta.replayed) || (status === 200 && !value.meta.replayed)) invalid();
  const fields = ['id', 'testingCandidateId', 'studentCurriculumEnrollmentId', 'targetRankId', 'status', 'instructorPrincipalId', 'rationale', 'decidedAt', 'version', 'createdAt'];
  if (value.data && typeof value.data === 'object' && !Array.isArray(value.data) && Object.hasOwn(value.data, 'priorRankId')) fields.push('priorRankId');
  closed(value.data, fields); const decision = value.data;
  for (const field of ['id', 'testingCandidateId', 'studentCurriculumEnrollmentId', 'targetRankId', 'instructorPrincipalId']) uuid(decision[field]);
  if (Object.hasOwn(decision, 'priorRankId')) uuid(decision.priorRankId);
  timestamp(decision.decidedAt); timestamp(decision.createdAt);
  // Decisions are insert-only; an accepted fresh/replay snapshot is the immutable initial record, never a later decision update.
  if (decision.testingCandidateId !== command.ids.candidateId || decision.status !== input.status || decision.rationale !== input.rationale || decision.version !== 1) invalid();
  const publicDecision = Object.freeze({ id: decision.id as string, testingCandidateId: decision.testingCandidateId as string,
    studentCurriculumEnrollmentId: decision.studentCurriculumEnrollmentId as string, ...(Object.hasOwn(decision, 'priorRankId') ? { priorRankId: decision.priorRankId as string } : {}),
    targetRankId: decision.targetRankId as string, status: decision.status as PromotionDecisionStatus, decidedAt: decision.decidedAt as string, version: 1 as const, createdAt: decision.createdAt as string });
  return Object.freeze({ decision: publicDecision, replayed: value.meta.replayed });
}
const posture = { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
async function json(response: Response): Promise<unknown> {
  if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const text = await response.text(); if (text.length > RESPONSE_MAX) invalid(); return JSON.parse(text);
}
/** No reads, discovery, alternate commands, automatic retries, browser storage, or navigation. */
export async function submitPromotionDecision(command: PreparedPromotionDecision): Promise<PromotionDecisionReceipt> {
  commandInput(command); let response: Response;
  try {
    response = await fetch(command.path, { ...posture, method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'testing' }, body: command.body });
  } catch { throw new PromotionDecisionUncertainError('Promotion-decision outcome is uncertain. Only the exact in-memory command may be retried by a separate human action.'); }
  if (response.status === 401 || response.status === 403) throw new PromotionDecisionAccessError(response.status);
  if (response.redirected) throw new PromotionDecisionUncertainError('No verified promotion-decision receipt was returned. The unchanged command alone may be retried.');
  if (response.status === 409) {
    let problem: unknown;
    try { problem = await json(response); } catch { throw new PromotionDecisionUncertainError('The conflict response could not be verified. No success is assumed; only the unchanged command may be retried.'); }
    if (problem && typeof problem === 'object' && !Array.isArray(problem) && Object.keys(problem).length === 2 && Object.hasOwn(problem, 'code') && Object.hasOwn(problem, 'detail')
      && (problem as Record<string, unknown>).code === 'IDEMPOTENCY_IN_PROGRESS' && typeof (problem as Record<string, unknown>).detail === 'string') {
      throw new PromotionDecisionUncertainError('The matching promotion-decision command is still in progress. No success is assumed; only an explicit unchanged retry is available.');
    }
  }
  if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) throw new PromotionDecisionRejectedError('Promotion decision was rejected or conflicted. No success or retry is retained. Obtain separately authorized current candidate/version information before a new confirmed command.');
  try {
    if (!response.ok || (response.status !== 201 && response.status !== 200)) invalid();
    return parsePromotionDecision(await json(response), command, response.status);
  } catch { throw new PromotionDecisionUncertainError('No verified exact promotion-decision receipt was returned. Outcome is uncertain; only the unchanged in-memory command may be retried.'); }
}
