import {
  validateBookParentSchoolBookingTypeInput, validateBookParentSchoolEventSlotInput, validateCancelParentSchoolBookingInput, verifyParentSchoolBookingReceipt,
  verifyParentSchoolBookings, type BookParentSchoolBookingTypeInput, type ParentSchoolBookingReceipt, type ParentSchoolBookings,
} from '@hon/contracts';

/** 0360 parent school bookings: same-origin browser commands only; no school, family, name or contact is ever sent. */
export class ParentSchoolBookingAccessError extends Error { constructor(message: string, readonly status: number) { super(message); } }
/** A definite refusal: nothing changed, so a retry is a new action with a new key. Other failures keep the key for an exact retry. */
export class ParentSchoolBookingRefusal extends Error {}
function invalid(): never { throw new Error('The booking answer could not be checked. Nothing is assumed. Refresh to see the current state.'); }
const MESSAGES: Record<string, string> = {
  PARENT_SCHOOL_BOOKING_FULL: 'That time is full. Please pick another.',
  PARENT_SCHOOL_BOOKING_ALREADY_BOOKED: 'Your family already has a booking here.',
  PARENT_SCHOOL_BOOKING_NOT_OFFERED: 'That time can no longer be booked here. Refresh to see what is open.',
  PARENT_SCHOOL_BOOKING_NOT_CANCELLABLE: 'This booking can no longer be cancelled here. Please contact the school.',
  PARENT_SCHOOL_BOOKING_NOT_FOUND: 'That booking is not available.',
  PARENT_SCHOOL_BOOKING_NO_CONTACT: 'Your account has no email the school can use for a booking. Please contact the school.',
  VALIDATION_FAILED: 'Check your answers and the waiver, then try again.',
  VERSION_CONFLICT: 'This booking changed. Refresh and try again.',
};
async function call(method: 'GET' | 'POST', path: string, command?: string, body?: unknown, key?: string): Promise<{ data: unknown; meta?: unknown }> {
  const response = await fetch(`/api/v1/parent/school-bookings${path}`, {
    method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: method === 'POST' ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': command!, 'Idempotency-Key': key! } : { Accept: 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json().catch(() => invalid());
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) throw new ParentSchoolBookingAccessError('Your session has ended. Sign in again.', 401);
    if (response.status === 403) throw new ParentSchoolBookingAccessError('Booking is not available on this account right now.', 403);
    if (MESSAGES[String(root.code)]) throw new ParentSchoolBookingRefusal(MESSAGES[String(root.code)]!);
    // Another tab is still sending with this key: the outcome is unknown, so the key is kept for an exact retry.
    if (root.code === 'IDEMPOTENCY_IN_PROGRESS') throw new Error('This request is still being processed. Wait a moment, then refresh to check.');
    if (response.status < 500) throw new ParentSchoolBookingRefusal('This request was not accepted. Nothing was changed. Refresh and try again.');
    throw new Error('Booking is unavailable right now. Nothing was changed that we know of. Try again sends the same request.');
  }
  if (!Object.hasOwn(root, 'data')) invalid();
  return root as { data: unknown; meta?: unknown };
}
function replayed(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || typeof (meta as { replayed?: unknown }).replayed !== 'boolean') invalid();
  return (meta as { replayed: boolean }).replayed;
}
export async function loadParentSchoolBookings(): Promise<ParentSchoolBookings> {
  return verifyParentSchoolBookings((await call('GET', '')).data);
}
export async function bookParentEventSlot(slotId: string, key: string): Promise<{ receipt: ParentSchoolBookingReceipt; replayed: boolean }> {
  const body = validateBookParentSchoolEventSlotInput({ slotId });
  const out = await call('POST', '/event-slots', 'parent.school_booking.book', body, key);
  return { receipt: verifyParentSchoolBookingReceipt(out.data, { kind: 'EVENT' }), replayed: replayed(out.meta) };
}
export async function bookParentBookingType(input: BookParentSchoolBookingTypeInput, key: string): Promise<{ receipt: ParentSchoolBookingReceipt; replayed: boolean }> {
  const body = validateBookParentSchoolBookingTypeInput(input);
  const out = await call('POST', '/booking-types', 'parent.school_booking.book', body, key);
  return { receipt: verifyParentSchoolBookingReceipt(out.data, { kind: 'BOOKING_TYPE' }), replayed: replayed(out.meta) };
}
export async function cancelParentSchoolBooking(bookingId: string, expectedVersion: number, key: string): Promise<{ receipt: ParentSchoolBookingReceipt; replayed: boolean }> {
  const input = validateCancelParentSchoolBookingInput({ bookingId, expectedVersion });
  const out = await call('POST', `/${input.bookingId}/cancel`, 'parent.school_booking.cancel', { expectedVersion: input.expectedVersion }, key);
  return { receipt: verifyParentSchoolBookingReceipt(out.data, { bookingId: input.bookingId }), replayed: replayed(out.meta) };
}
/** Exact retry keeps the same key for the same action; any other action gets a new key. */
export function schoolBookingAttempt(action: string, previous: { action: string; key: string } | null, key: () => string) {
  return previous?.action === action ? previous : { action, key: key() };
}
