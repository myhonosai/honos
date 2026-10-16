import { validateChadFollowUpAssistantRequest, validateFollowUpDraft, type ChadFollowUpAssistantRequest, type ChadFollowUpInvocationView } from '@hon/contracts';
export class ChadFollowUpUiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const base = '/api/v1/staff/leads/assistant';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function endpoint(path: string) {
  const url = new URL(path, 'http://hon.invalid');
  const parts = url.pathname.slice(base.length).split('/').filter(Boolean);
  const allowed = url.pathname === base || url.pathname === `${base}/mine` || (parts.length === 1 && UUID.test(parts[0]!)) || (parts.length === 2 && UUID.test(parts[0]!) && parts[1] === 'retry');
  if (!path.startsWith(base) || url.origin !== 'http://hon.invalid' || url.search || url.hash || !allowed) throw new Error('Only fixed same-origin Chad endpoints are allowed.');
  return path;
}
export async function chadFollowUpRequest(path: string, input?: unknown, key?: string): Promise<unknown> {
  endpoint(path);
  if (input !== undefined && !key) throw new Error('A retained idempotency key is required.');
  const response = await fetch(path, { method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', referrerPolicy: 'no-referrer', cache: 'no-store', headers: input === undefined ? {} : { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'chad-follow-up-assistant', 'Idempotency-Key': key! }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  if (!response.ok) throw new ChadFollowUpUiError(response.status === 400 ? 'Use only the known lead ID, observed version, and listed purpose.' : response.status === 401 ? 'Sign in with a verified direct staff session.' : response.status === 403 ? 'Current Complete entitlement, direct school scope, permission, or lead access is unavailable.' : response.status === 409 ? 'A durable lead/version or retry conflict occurred. Refresh before retrying.' : 'No verified result. Reuse only the same saved request key for an unchanged request.', response.status);
  const payload = await response.json() as { data?: unknown };
  if (!payload || !Object.hasOwn(payload, 'data')) throw new Error('Unverified Chad response.');
  return payload.data;
}
export { base };
export function normalizedChadFollowUpRequest(leadId: string, expectedLeadVersion: string, purpose: string): ChadFollowUpAssistantRequest { return validateChadFollowUpAssistantRequest({ leadId, expectedLeadVersion: Number(expectedLeadVersion), purpose }); }
export function verifyChadFollowUpInvocation(value: unknown, expectedLeadId?: string, invocationId?: string): ChadFollowUpInvocationView {
  const item = value as Record<string, unknown>;
  if (!item || typeof item !== 'object' || (expectedLeadId !== undefined && item.leadId !== expectedLeadId) || (invocationId !== undefined && item.id !== invocationId) || typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.schoolId !== 'string' || !UUID.test(item.schoolId) || typeof item.leadId !== 'string' || !UUID.test(item.leadId) || typeof item.workItemId !== 'string' || !UUID.test(item.workItemId) || typeof item.leadVersion !== 'number' || typeof item.purpose !== 'string' || typeof item.status !== 'string' || item.delivery !== 'NOT_CREATED_OR_SENT' || (item.draft !== null && item.draft !== undefined && (() => { try { validateFollowUpDraft(item.draft); return false; } catch { return true; } })())) throw new ChadFollowUpUiError('The durable response was withheld because it did not match the closed Chad contract.', 502);
  return item as unknown as ChadFollowUpInvocationView;
}
