import { validateTeachingAssistantRequest, validateTeachingDraft, type TeachingInvocationView } from '@hon/contracts';
const base = '/api/v1/staff/teaching-assistant';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class TeachingAssistantUiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function endpoint(path: string) {
  const url = new URL(path, 'http://hon.invalid');
  const parts = url.pathname.slice(base.length).split('/').filter(Boolean);
  const allowed = url.pathname === base || url.pathname === `${base}/mine` || (parts.length === 1 && UUID.test(parts[0]!)) || (parts.length === 2 && UUID.test(parts[0]!) && ['retry', 'save-approved'].includes(parts[1]!));
  if (!path.startsWith(base) || url.origin !== 'http://hon.invalid' || url.search || url.hash || !allowed) throw new Error('Only fixed same-origin Claire endpoints are allowed.');
  return path;
}
export function verifyTeachingInvocation(value: unknown, curriculumId?: string, invocationId?: string): TeachingInvocationView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unverified teaching assistant result.');
  const item = value as Record<string, unknown>;
  const statuses = ['PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED', 'SENDING', 'UNKNOWN', 'FAILED', 'AWAITING_APPROVAL', 'SAVED', 'REJECTED'];
  if (!UUID.test(String(item.id)) || (invocationId !== undefined && item.id !== invocationId) || !UUID.test(String(item.schoolId)) || (curriculumId !== undefined && item.curriculumId !== curriculumId) || !UUID.test(String(item.curriculumId)) || !UUID.test(String(item.workItemId)) || !statuses.includes(String(item.status)) || (item.reason !== null && typeof item.reason !== 'string') || (item.actionRequestId !== null && !UUID.test(String(item.actionRequestId)))) throw new Error('Unverified teaching assistant scope or durable state.');
  if (item.draft !== null) validateTeachingDraft(item.draft);
  for (const key of ['inputTokens', 'outputTokens', 'providerCostMicrounits', 'customerCredits']) if (item[key] !== null && (!Number.isSafeInteger(item[key]) || Number(item[key]) < 0)) throw new Error('Unverified teaching usage.');
  return item as unknown as TeachingInvocationView;
}
export async function teachingAssistantRequest(path: string, body?: unknown, key?: string): Promise<unknown> {
  endpoint(path);
  if (body !== undefined && !key) throw new Error('A retained idempotency key is required.');
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'teaching-assistant', 'Idempotency-Key': key! }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new TeachingAssistantUiError(response.status === 401 ? 'Sign in with a verified human staff session.' : response.status === 403 ? 'Current direct staff scope, Complete entitlement, or exact permission is unavailable.' : response.status === 409 ? 'A durable state or retry conflict occurred. Refresh before retrying.' : 'No verified result. Reuse only the same saved request key for an unchanged request.', response.status);
  const payload = await response.json() as { data?: unknown };
  if (!payload || !Object.hasOwn(payload, 'data')) throw new Error('Unverified teaching assistant response.');
  return payload.data;
}
export function normalizedTeachingRequest(curriculumId: string, brief: string) { return validateTeachingAssistantRequest(brief.trim() ? { curriculumId, brief: brief.trim() } : { curriculumId }); }
