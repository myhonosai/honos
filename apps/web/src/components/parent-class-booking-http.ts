import {
  validateBookParentClassSessionInput, validateCancelParentClassBookingInput, verifyParentClassBookingChoices, verifyParentClassBookingReceipt,
  type BookParentClassSessionInput, type ParentClassBookingChoices, type ParentClassBookingReceipt,
} from '@hon/contracts';

/** 0329 parent class booking: same-origin browser commands only; no school, family or child selector is ever sent in the URL. */
export class ParentClassBookingAccessError extends Error { constructor(message: string, readonly status: number) { super(message); } }
/** A definite refusal: nothing changed, so a retry is a new action with a new key. Other failures keep the key for an exact retry. */
export class ParentClassBookingRefusal extends Error {}
function invalid(): never { throw new Error('The booking answer could not be checked. Nothing is assumed. Refresh to see the current state.'); }
const MESSAGES: Record<string, string> = {
  PARENT_CLASS_BOOKING_FULL: 'This class is full.',
  PARENT_CLASS_BOOKING_ALREADY_BOOKED: 'Your child is already booked into this class.',
  PARENT_CLASS_BOOKING_NOT_OFFERED: 'This class can no longer be booked here. Refresh to see what is open.',
  PARENT_CLASS_BOOKING_NOT_CANCELLABLE: 'This booking can no longer be cancelled here. Please contact the school.',
  PARENT_CLASS_BOOKING_CHILD_NOT_FOUND: 'That child is not available on your account.',
  PARENT_CLASS_BOOKING_NOT_FOUND: 'That booking is not available.',
  VERSION_CONFLICT: 'This booking changed. Refresh and try again.',
};
async function call(method: 'GET' | 'POST', path: string, command?: string, body?: unknown, key?: string): Promise<{ data: unknown; meta?: unknown }> {
  const response = await fetch(`/api/v1/parent/class-bookings${path}`, {
    method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: method === 'POST' ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': command!, 'Idempotency-Key': key! } : { Accept: 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json().catch(() => invalid());
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) throw new ParentClassBookingAccessError('Your session has ended. Sign in again.', 401);
    if (response.status === 403) throw new ParentClassBookingAccessError('Booking is not available on this account right now.', 403);
    if (MESSAGES[String(root.code)]) throw new ParentClassBookingRefusal(MESSAGES[String(root.code)]!);
    // Another tab is still sending with this key: the outcome is unknown, so the key is kept for an exact retry.
    if (root.code === 'IDEMPOTENCY_IN_PROGRESS') throw new Error('This request is still being processed. Wait a moment, then refresh to check.');
    if (response.status < 500) throw new ParentClassBookingRefusal('This request was not accepted. Nothing was changed. Refresh and try again.');
    throw new Error('Booking is unavailable right now. Nothing was changed that we know of. Refresh and try again.');
  }
  if (!Object.hasOwn(root, 'data')) invalid();
  return root as { data: unknown; meta?: unknown };
}
function replayed(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || typeof (meta as { replayed?: unknown }).replayed !== 'boolean') invalid();
  return (meta as { replayed: boolean }).replayed;
}
export async function loadParentClassBookingChoices(): Promise<ParentClassBookingChoices> {
  return verifyParentClassBookingChoices((await call('GET', '')).data);
}
export async function bookParentClass(input: BookParentClassSessionInput, key: string): Promise<{ receipt: ParentClassBookingReceipt; replayed: boolean }> {
  const body = validateBookParentClassSessionInput(input);
  const out = await call('POST', '', 'parent.class_booking.book', body, key);
  return { receipt: verifyParentClassBookingReceipt(out.data, body), replayed: replayed(out.meta) };
}
export async function cancelParentClass(bookingId: string, expectedVersion: number, key: string): Promise<{ receipt: ParentClassBookingReceipt; replayed: boolean }> {
  const input = validateCancelParentClassBookingInput({ bookingId, expectedVersion });
  const out = await call('POST', `/${input.bookingId}/cancel`, 'parent.class_booking.cancel', { expectedVersion: input.expectedVersion }, key);
  return { receipt: verifyParentClassBookingReceipt(out.data, { bookingId: input.bookingId }), replayed: replayed(out.meta) };
}
/** Exact retry keeps the same key for the same action; any other action gets a new key. */
export function bookingAttempt(action: string, previous: { action: string; key: string } | null, key: () => string) {
  return previous?.action === action ? previous : { action, key: key() };
}
