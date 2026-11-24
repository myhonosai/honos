import type { ParentClassBookingChoices, ParentClassSessionChoice } from '@hon/contracts/parent-class-booking';
import type { ParentWrite } from '../api/client';

/**
 * One Idempotency-Key per intended action, kept until HON gives a definite answer. A retry after an unknown result
 * reuses the same key, so a booking that did go through is replayed, never made twice.
 */
export function createCommandKeys(newKey: () => string) {
  const keys = new Map<string, string>();
  return {
    keyFor(action: string): string {
      let key = keys.get(action);
      if (!key) { key = newKey(); keys.set(action, key); }
      return key;
    },
    settle(action: string): void { keys.delete(action); },
    has(action: string): boolean { return keys.has(action); },
  };
}
export type CommandKeys = ReturnType<typeof createCommandKeys>;

/** One confirmed booking action whose answer was lost: the server ids it was for, as the server sent them. */
export type UnconfirmedBooking = Readonly<{ kind: 'book' | 'cancel'; childId: string; childName: string; session: ParentClassSessionChoice }>;
/**
 * Command keys plus the unconfirmed action, held above the booking screen. The action stays until the server
 * confirms it (directly, by a same-key retry, or by a re-read that shows it) or answers it definitely.
 */
export type BookingCustody = { keys: CommandKeys; unconfirmed: UnconfirmedBooking | null };
export const createBookingCustody = (newKey: () => string): BookingCustody => ({ keys: createCommandKeys(newKey), unconfirmed: null });

export const bookAction = (studentProfileId: string, sessionId: string) => `book:${studentProfileId}:${sessionId}`;
export const cancelAction = (bookingId: string, version: number) => `cancel:${bookingId}:${version}`;

/** What a parent can do with one session row, from the server's flags only. */
export function sessionAction(choices: ParentClassBookingChoices, session: ParentClassSessionChoice, nowMs: number): 'book' | 'cancel' | 'full' | 'none' {
  if (Date.parse(session.startsAt) <= nowMs) return 'none';
  if (session.booking) return session.booking.canCancel ? 'cancel' : 'none';
  if (!choices.canBook) return 'none';
  return session.spotsLeft > 0 ? 'book' : 'full';
}

const REFUSALS: Record<string, string> = {
  PARENT_CLASS_BOOKING_FULL: 'This class is full.',
  PARENT_CLASS_BOOKING_ALREADY_BOOKED: 'Your child is already booked into this class.',
  PARENT_CLASS_BOOKING_NOT_OFFERED: 'This class cannot be booked from the app right now.',
  PARENT_CLASS_BOOKING_NOT_CANCELLABLE: 'This booking can no longer be cancelled from the app. Please contact your school.',
  PARENT_CLASS_BOOKING_NOT_FOUND: 'That booking is no longer available.',
  PARENT_CLASS_BOOKING_CHILD_NOT_FOUND: 'That child is no longer on your family account at this school.',
  VERSION_CONFLICT: 'This class changed since you opened it. The list has been refreshed.',
  PARENT_CLASS_BOOKING_FORBIDDEN: 'Your family access does not allow booking from the app.',
};

export type ActionOutcome = { kind: 'done'; message: string; confirmedBooking: boolean } | { kind: 'refused'; message: string } | { kind: 'unknown' } | { kind: 'session' };

/** Turns a command result into what the parent is told. A waitlist place is never described as a booking. */
export function describeOutcome(result: ParentWrite<{ booking: { status: string } }>, action: 'book' | 'cancel'): ActionOutcome {
  if (result.ok) {
    if (action === 'cancel') return { kind: 'done', message: 'Booking cancelled.', confirmedBooking: false };
    const waitlisted = result.data.booking.status === 'WAITLISTED';
    return { kind: 'done', message: waitlisted ? 'Added to the waitlist. This is not a confirmed spot yet.' : 'Booked.', confirmedBooking: !waitlisted };
  }
  if (result.state === 'unknown' || result.state === 'offline' || result.state === 'unavailable') return { kind: 'unknown' };
  if (result.state === 'refused') return { kind: 'refused', message: (result.code && REFUSALS[result.code]) ?? 'HON could not do this. Nothing was changed.' };
  return { kind: 'session' };
}
