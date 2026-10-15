import {
  validateTestingRegistrationInterestInput,
  validateTestingRegistrationReviewInput,
  verifyParentTestingInterestReceipt,
  verifyParentTestingRegistrationView,
  verifyStaffTestingRegistrationReviewReceipt,
  verifyStaffTestingRegistrationView,
  type DecideTestingRegistrationInterestInput,
  type ParentTestingInterestReceipt,
  type ParentTestingRegistrationView,
  type StaffTestingRegistrationReviewReceipt,
  type StaffTestingRegistrationView,
  type SubmitTestingRegistrationInterestInput,
} from '@hon/contracts';

export class TestingRegistrationAccessError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function invalid(): never { throw new Error('Testing registration response could not be verified. No success is assumed.'); }
async function request(url: string, body?: unknown, key?: string, signal?: AbortSignal): Promise<unknown> {
  if (!url.startsWith('/api/v1/') || new URL(url, 'https://hon.invalid').origin !== 'https://hon.invalid' || new URL(url, 'https://hon.invalid').search || new URL(url, 'https://hon.invalid').hash) invalid();
  const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'testing-registration', 'Idempotency-Key': key! } : { Accept: 'application/json' }, signal: signal ?? null, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    const message = response.status === 401 ? 'Your session has ended. Sign in again.' : response.status === 403 ? 'Current family or exact staff review permission is unavailable. Content has been cleared.' : response.status === 404 ? 'That existing event, child, or registration is no longer available.' : response.status === 409 ? 'The registration changed or the retry key conflicts. Reload, or retry an unchanged uncertain request with its retained key.' : 'No verified result was returned. No interest or decision is assumed.';
    if ([401, 403].includes(response.status)) throw new TestingRegistrationAccessError(message, response.status);
    throw new Error(message);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const envelope: unknown = await response.json();
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !Object.hasOwn(envelope, 'data')) invalid();
  return (envelope as { data: unknown }).data;
}
function key(value: string): void { if (!value || value.length > 200 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) invalid(); }

export async function loadParentTestingRegistrations(signal?: AbortSignal): Promise<ParentTestingRegistrationView> {
  // Fixed scope discovery uses only the authenticated server session. No family or child URL/query selector is accepted.
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return verifyParentTestingRegistrationView(await request('/api/v1/parent/testing', undefined, undefined, signal));
}
export async function submitParentTestingInterest(input: SubmitTestingRegistrationInterestInput, idempotencyKey: string): Promise<ParentTestingInterestReceipt> {
  validateTestingRegistrationInterestInput(input); key(idempotencyKey);
  return verifyParentTestingInterestReceipt(await request('/api/v1/parent/testing/interests', input, idempotencyKey));
}
export async function loadStaffTestingRegistrations(): Promise<StaffTestingRegistrationView> {
  return verifyStaffTestingRegistrationView(await request('/api/v1/staff/testing/registrations'));
}
export async function reviewStaffTestingRegistration(id: string, input: DecideTestingRegistrationInterestInput, idempotencyKey: string): Promise<StaffTestingRegistrationReviewReceipt> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) invalid();
  validateTestingRegistrationReviewInput(input); key(idempotencyKey);
  return verifyStaffTestingRegistrationReviewReceipt(await request(`/api/v1/staff/testing/registrations/${id}/decision`, input, idempotencyKey));
}
