import { validateParentPlannedAbsenceRequestInput, verifyParentPlannedAbsenceRequestContext, verifyParentPlannedAbsenceSubmittedReceipt, type CreatePlannedAbsenceRequestInput, type ParentPlannedAbsenceRequestContext, type ParentPlannedAbsenceSubmittedReceipt } from '@hon/contracts';

export class ParentPlannedAbsenceRequestAccessError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function invalid(): never { throw new Error('The planned-absence response could not be verified. No submission is assumed. Retry only the unchanged request.'); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function request(submit: boolean, input?: CreatePlannedAbsenceRequestInput, key?: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(submit ? '/api/v1/parent/planned-absences' : '/api/v1/parent/planned-absences/context', {
    method: submit ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: signal ?? null,
    headers: submit ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'parent-planned-absence', 'Idempotency-Key': key! } : { Accept: 'application/json' },
    ...(submit ? { body: JSON.stringify(input) } : {}),
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'Your session has ended. Sign in again.' : response.status === 403 ? 'Current guardian family or child access is unavailable. Content has been cleared.' : response.status === 409 ? 'Family scope or retry conflict. No submission is assumed; retry only the unchanged uncertain request.' : 'No verified planned-absence result. Check the future time window and bounded fields. Retry only the unchanged request.';
    if ([401, 403].includes(response.status)) throw new ParentPlannedAbsenceRequestAccessError(message, response.status);
    throw new Error(message);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 2 || !Object.hasOwn(root, 'data') || !root.meta || typeof root.meta !== 'object' || Array.isArray(root.meta)) invalid();
  const meta = root.meta as Record<string, unknown>, keys = submit ? ['requestId', 'correlationId', 'replayed'] : ['requestId', 'correlationId'];
  if (Object.keys(meta).length !== keys.length || keys.some(key => !Object.hasOwn(meta, key)) || typeof meta.requestId !== 'string' || !uuid.test(meta.requestId) || meta.correlationId !== meta.requestId || submit && typeof meta.replayed !== 'boolean') invalid();
  return root.data;
}
export async function loadParentPlannedAbsenceRequestContext(signal?: AbortSignal): Promise<ParentPlannedAbsenceRequestContext> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return verifyParentPlannedAbsenceRequestContext(await request(false, undefined, undefined, signal));
}
export async function submitParentPlannedAbsence(input: CreatePlannedAbsenceRequestInput, key: string): Promise<ParentPlannedAbsenceSubmittedReceipt> {
  validateParentPlannedAbsenceRequestInput(input);
  if (!key || key.length > 200 || key.trim() !== key || /[\u0000-\u001f\u007f]/.test(key)) invalid();
  return verifyParentPlannedAbsenceSubmittedReceipt(await request(true, input, key));
}
/** In-memory exact retry only: never refresh, submit, persist, or change key automatically. */
export function plannedAbsenceAttempt(input: CreatePlannedAbsenceRequestInput, previous: { fingerprint: string; key: string; input: CreatePlannedAbsenceRequestInput } | null, key: () => string) {
  validateParentPlannedAbsenceRequestInput(input);
  const fingerprint = JSON.stringify(input);
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, key: key(), input: { ...input } };
}
