/**
 * Parent class booking (0329): a signed-in guardian books their own child into an upcoming bookable class session of a
 * program the child is enrolled in, and cancels their own app bookings before the session starts. VIEWER grants read only.
 * Sessions show open spots, never other students. No message, charge or AI.
 */

export const PARENT_CLASS_BOOKING_STATUSES = ['BOOKED', 'WAITLISTED', 'CANCELLED', 'CHECKED_IN', 'NO_SHOW'] as const;
export type ParentClassBookingStatus = (typeof PARENT_CLASS_BOOKING_STATUSES)[number];
export const PARENT_CLASS_BOOKING_SOURCES = ['STAFF', 'PARENT_APP', 'AUTOMATION', 'INTEGRATION'] as const;
export type ParentClassBookingSource = (typeof PARENT_CLASS_BOOKING_SOURCES)[number];
export const PARENT_CLASS_BOOKING_LIMITS = { horizonDays: 14, children: 20, sessionsPerChild: 200 } as const;

export interface ParentClassBooking {
  bookingId: string; sessionId: string; studentProfileId: string; status: ParentClassBookingStatus; source: ParentClassBookingSource;
  version: number; canCancel: boolean;
}
export interface ParentClassSessionChoice {
  sessionId: string; name: string; programName: string; roomName: string | null; startsAt: string; endsAt: string; spotsLeft: number;
  booking: ParentClassBooking | null;
}
export interface ParentClassBookingChild { studentProfileId: string; displayName: string; sessions: ParentClassSessionChoice[] }
export interface ParentClassBookingChoices { canBook: boolean; timezone: string; horizonDays: number; children: ParentClassBookingChild[] }
export interface ParentClassBookingReceipt { booking: ParentClassBooking; spotsLeft: number }
export interface BookParentClassSessionInput { studentProfileId: string; sessionId: string }
export interface CancelParentClassBookingInput { bookingId: string; expectedVersion: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ZONE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

function invalid(): never { throw new Error('Invalid parent class booking data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !(key in row))) invalid();
  return row;
}
function count(value: unknown, minimum: number, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid(); return value; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function label(value: unknown, minimum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

export function validateBookParentClassSessionInput(value: unknown): BookParentClassSessionInput {
  const row = record(value, ['studentProfileId', 'sessionId']);
  return { studentProfileId: uuid(row.studentProfileId), sessionId: uuid(row.sessionId) };
}
export function validateCancelParentClassBookingInput(value: unknown): CancelParentClassBookingInput {
  const row = record(value, ['bookingId', 'expectedVersion']);
  return { bookingId: uuid(row.bookingId), expectedVersion: count(row.expectedVersion, 1) };
}

export function verifyParentClassBooking(value: unknown): ParentClassBooking {
  const row = record(value, ['bookingId', 'sessionId', 'studentProfileId', 'status', 'source', 'version', 'canCancel']);
  if (typeof row.canCancel !== 'boolean') invalid();
  const out: ParentClassBooking = { bookingId: uuid(row.bookingId), sessionId: uuid(row.sessionId), studentProfileId: uuid(row.studentProfileId),
    status: oneOf(row.status, PARENT_CLASS_BOOKING_STATUSES), source: oneOf(row.source, PARENT_CLASS_BOOKING_SOURCES), version: count(row.version, 1),
    canCancel: row.canCancel };
  if (out.canCancel && (out.source !== 'PARENT_APP' || !['BOOKED', 'WAITLISTED'].includes(out.status))) invalid();
  return out;
}
function session(value: unknown, child: string): ParentClassSessionChoice {
  const row = record(value, ['sessionId', 'name', 'programName', 'roomName', 'startsAt', 'endsAt', 'spotsLeft', 'booking']);
  const out: ParentClassSessionChoice = { sessionId: uuid(row.sessionId), name: label(row.name, 1), programName: label(row.programName, 1),
    roomName: row.roomName === null ? null : label(row.roomName, 0), startsAt: instant(row.startsAt), endsAt: instant(row.endsAt),
    spotsLeft: count(row.spotsLeft, 0), booking: row.booking === null ? null : verifyParentClassBooking(row.booking) };
  if (out.endsAt <= out.startsAt) invalid();
  if (out.booking && (out.booking.sessionId !== out.sessionId || out.booking.studentProfileId !== child || out.booking.status === 'CANCELLED')) invalid();
  return out;
}
export function verifyParentClassBookingChoices(value: unknown): ParentClassBookingChoices {
  const row = record(value, ['canBook', 'timezone', 'horizonDays', 'children']);
  if (typeof row.canBook !== 'boolean' || typeof row.timezone !== 'string' || !ZONE.test(row.timezone)) invalid();
  if (row.horizonDays !== PARENT_CLASS_BOOKING_LIMITS.horizonDays || !Array.isArray(row.children) || row.children.length > PARENT_CLASS_BOOKING_LIMITS.children) invalid();
  const seen = new Set<string>();
  const children = row.children.map(item => {
    const c = record(item, ['studentProfileId', 'displayName', 'sessions']);
    const id = uuid(c.studentProfileId);
    if (seen.has(id) || !Array.isArray(c.sessions) || c.sessions.length > PARENT_CLASS_BOOKING_LIMITS.sessionsPerChild) invalid();
    seen.add(id);
    const sessions = c.sessions.map(s => session(s, id));
    if (sessions.some((s, i) => i > 0 && s.startsAt < sessions[i - 1]!.startsAt)) invalid();
    return { studentProfileId: id, displayName: label(c.displayName, 0), sessions };
  });
  return { canBook: row.canBook, timezone: row.timezone, horizonDays: row.horizonDays, children };
}
export function verifyParentClassBookingReceipt(value: unknown, expected: Partial<BookParentClassSessionInput & { bookingId: string }>): ParentClassBookingReceipt {
  const row = record(value, ['booking', 'spotsLeft']);
  const booking = verifyParentClassBooking(row.booking);
  if (expected.sessionId && booking.sessionId !== expected.sessionId) invalid();
  if (expected.studentProfileId && booking.studentProfileId !== expected.studentProfileId) invalid();
  if (expected.bookingId && booking.bookingId !== expected.bookingId) invalid();
  return { booking, spotsLeft: count(row.spotsLeft, 0) };
}
