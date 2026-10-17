import { plannedAbsenceReviewUuid, validatePlannedAbsenceReviewInput, verifyPlannedAbsenceDecisionReceipt, verifyPlannedAbsenceReviewQueue, type DecidePlannedAbsenceRequestInput, type PlannedAbsenceDecisionReceipt, type PlannedAbsenceReviewQueue, type PlannedAbsenceReviewQueueItem } from '@hon/contracts';

export class PlannedAbsenceReviewAccessError extends Error { constructor(readonly status: number) { super('Current human staff access or request state is unavailable. Reload the queue explicitly; no decision is assumed.'); } }
export type ReviewAttempt = { scope: { organizationId: string; schoolId: string }; item: PlannedAbsenceReviewQueueItem; input: DecidePlannedAbsenceRequestInput; key: string };
function invalid(): never { throw new Error('The planned-absence review result could not be verified. No decision is assumed. Retry only the exact retained request.'); }
async function request(path: string, attempt?: ReviewAttempt, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    method: attempt ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: signal ?? null,
    headers: { Accept: 'application/json', 'X-HON-Human-Command': 'planned-absence-review', ...(attempt ? { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key } : {}) },
    ...(attempt ? { body: JSON.stringify(attempt.input) } : {}),
  });
  if (!response.ok) {
    if ([400,401,403,404,409,422].includes(response.status)) throw new PlannedAbsenceReviewAccessError(response.status);
    throw new Error('No verified review result. Retry only the exact retained request; nothing is retried automatically.');
  }
  if (response.status !== 200) invalid();
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 2 || !Object.hasOwn(root, 'data') || !root.meta || typeof root.meta !== 'object' || Array.isArray(root.meta)) invalid();
  const meta = root.meta as Record<string, unknown>, keys = attempt ? ['requestId','correlationId','replayed'] : ['requestId','correlationId'];
  if (Object.keys(meta).length !== keys.length || keys.some(key => !Object.hasOwn(meta, key)) || plannedAbsenceReviewUuid(meta.requestId) !== meta.requestId || meta.correlationId !== meta.requestId || attempt && typeof meta.replayed !== 'boolean') invalid();
  return root.data;
}
export async function loadPlannedAbsenceReviewQueue(signal?: AbortSignal): Promise<PlannedAbsenceReviewQueue> {
  return verifyPlannedAbsenceReviewQueue(await request('/api/v1/staff/attendance/planned-absences', undefined, signal));
}
/** Snapshot only after explicit human selection. A changed scope/target/input must discard this attempt. */
export function createReviewAttempt(queue: PlannedAbsenceReviewQueue, item: PlannedAbsenceReviewQueueItem, input: DecidePlannedAbsenceRequestInput, key: string): ReviewAttempt {
  const verified = verifyPlannedAbsenceReviewQueue(queue);
  validatePlannedAbsenceReviewInput(input);
  if (!verified.items.some(candidate => JSON.stringify(candidate) === JSON.stringify(item)) || input.expectedVersion !== item.version || !key || key.trim() !== key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) invalid();
  return { scope: { organizationId: verified.organizationId, schoolId: verified.schoolId }, item: { ...item }, input: { ...input }, key };
}
export async function decidePlannedAbsence(attempt: ReviewAttempt, signal?: AbortSignal): Promise<PlannedAbsenceDecisionReceipt> {
  const organizationId = plannedAbsenceReviewUuid(attempt.scope.organizationId), schoolId = plannedAbsenceReviewUuid(attempt.scope.schoolId), id = plannedAbsenceReviewUuid(attempt.item.id);
  validatePlannedAbsenceReviewInput(attempt.input);
  if (attempt.input.expectedVersion !== attempt.item.version || !attempt.key || attempt.key.trim() !== attempt.key || attempt.key.length > 200 || /[\u0000-\u001f\u007f]/.test(attempt.key)) invalid();
  const data = verifyPlannedAbsenceDecisionReceipt(await request(`/api/v1/organizations/${organizationId}/schools/${schoolId}/planned-absence-requests/${id}/decision`, attempt, signal));
  if (data.id !== id || data.status !== attempt.input.decision || data.version !== attempt.input.expectedVersion + 1 || Date.parse(data.reviewedAt) < Date.parse(attempt.item.submittedAt)) invalid();
  return data;
}
