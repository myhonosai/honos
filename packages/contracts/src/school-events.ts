/**
 * B-SCH-3 (0261): one-day school events (holiday sale, open house, belt test, picture day) with bookable time slots.
 * Staff with schedule.session.manage create, publish, close and cancel events and see who is coming. Families book one
 * slot per family through a public link without an account and get a booking code they can cancel with.
 * No message, charge, CRM lead, student record or AI is involved.
 */
export const SCHOOL_EVENT_STATUSES = ['DRAFT', 'PUBLISHED', 'CLOSED', 'CANCELLED'] as const;
export type SchoolEventStatus = (typeof SCHOOL_EVENT_STATUSES)[number];
export const SCHOOL_EVENT_BOOKING_STATUSES = ['BOOKED', 'ARRIVED', 'CANCELLED'] as const;
export type SchoolEventBookingStatus = (typeof SCHOOL_EVENT_BOOKING_STATUSES)[number];
export const SCHOOL_EVENT_MAX_DAYS_AHEAD = 365;
export const SCHOOL_EVENT_MAX_SLOTS = 96;

export interface SaveSchoolEventInput {
  expectedVersion: number; title: string; description: string; place: string; localDate: string;
  opensAt: string; closesAt: string; slotMinutes: number; spotsPerSlot: number;
}
export interface SetSchoolEventStatusInput { expectedVersion: number; status: 'PUBLISHED' | 'CLOSED' | 'CANCELLED' }
export interface SetSchoolEventBookingStatusInput { expectedVersion: number; status: SchoolEventBookingStatus }

export interface SchoolEvent {
  eventId: string; publicId: string; title: string; description: string; place: string; localDate: string; opensAt: string; closesAt: string;
  slotMinutes: number; spotsPerSlot: number; status: SchoolEventStatus; version: number; slotCount: number; bookedCount: number; createdAt: string;
}
export interface SchoolEventBooking {
  bookingId: string; slotId: string; name: string; email: string | null; mobile: string | null; status: SchoolEventBookingStatus;
  cancelledBy: 'FAMILY' | 'STAFF' | null; version: number; createdAt: string;
}
export interface SchoolEventSlot { slotId: string; position: number; localStart: string; localEnd: string; startsAt: string; taken: number; bookings: SchoolEventBooking[] }
export interface SchoolEvents { localToday: string; timezone: string; events: SchoolEvent[] }
export interface SchoolEventDetail { event: SchoolEvent; timezone: string; slots: SchoolEventSlot[] }
export interface SchoolEventReceipt { event: SchoolEvent; skippedTimes: string[] }
export interface SchoolEventBookingReceipt { booking: SchoolEventBooking }

export interface PublicSchoolEventSlot { slotId: string; localStart: string; localEnd: string; spotsLeft: number }
export interface PublicSchoolEvent {
  publicId: string; schoolName: string; title: string; description: string; place: string; localDate: string; timezone: string;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED'; slots: PublicSchoolEventSlot[];
}
export interface PublicSchoolEventBookingInput { slotId: string; name: string; email: string; mobile: string; website: string }
export const PUBLIC_EVENT_BOOKING_RESULTS = ['BOOKED', 'INVALID', 'CLOSED', 'FULL', 'STARTED', 'ALREADY_BOOKED', 'RATE_LIMITED', 'UNAVAILABLE'] as const;
export type PublicEventBookingResult = (typeof PUBLIC_EVENT_BOOKING_RESULTS)[number];
export interface PublicEventBookingOutcome {
  result: PublicEventBookingResult; code?: string; slotId?: string; localStart?: string; localEnd?: string; status?: SchoolEventBookingStatus;
}
export const PUBLIC_EVENT_CANCEL_RESULTS = ['CANCELLED', 'INVALID', 'STARTED', 'RATE_LIMITED', 'UNAVAILABLE'] as const;
export type PublicEventCancelResult = (typeof PUBLIC_EVENT_CANCEL_RESULTS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const PUBLIC_ID = /^[a-f0-9]{48}$/;
const CODE = /^[A-F0-9]{12}$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/;
const MOBILE = /^\+[1-9][0-9]{6,14}$/;
// The database rule (hon.school_event_text_ok): trimmed, no control or invisible formatting characters, no formula start.
const EDGE_SPACE = /^[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]|[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]$/;
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;

function invalid(): never { throw new Error('Invalid school event data.'); }
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
function clock(value: unknown): string { if (typeof value !== 'string' || !CLOCK.test(value)) invalid(); return value; }
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid(); return value; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
export function schoolEventDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE.test(value)) invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}
/** Same rule as hon.school_event_text_ok (length in code points). */
export function isSchoolEventText(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  return length >= minimum && length <= maximum && !EDGE_SPACE.test(value) && !HIDDEN.test(value) && !/^[=+@-]/.test(value);
}
function eventText(value: unknown, minimum: number, maximum: number): string { if (!isSchoolEventText(value, minimum, maximum)) invalid(); return value; }
function minutes(value: string): number { return Number(value.slice(0, 2)) * 60 + Number(value.slice(3)); }
export function isPublicEventId(value: unknown): value is string { return typeof value === 'string' && PUBLIC_ID.test(value); }
/** Accepts XXXXXXXXXXXX or XXXX-XXXX-XXXX in any case; returns the 12 upper-case characters. */
export function normalizeEventBookingCode(value: unknown): string {
  if (typeof value !== 'string') invalid();
  const code = value.trim().replace(/-/g, '').toUpperCase();
  if (!CODE.test(code)) invalid();
  return code;
}
export function formatEventBookingCode(code: string): string { return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`; }

export function validateSaveSchoolEventInput(value: unknown): SaveSchoolEventInput {
  const row = record(value, ['expectedVersion', 'title', 'description', 'place', 'localDate', 'opensAt', 'closesAt', 'slotMinutes', 'spotsPerSlot']);
  const input: SaveSchoolEventInput = {
    expectedVersion: count(row.expectedVersion, 0, 999_999_998), title: eventText(row.title, 1, 120), description: eventText(row.description, 0, 500),
    place: eventText(row.place, 0, 120), localDate: schoolEventDate(row.localDate), opensAt: clock(row.opensAt), closesAt: clock(row.closesAt),
    slotMinutes: count(row.slotMinutes, 10, 240), spotsPerSlot: count(row.spotsPerSlot, 1, 500),
  };
  if (minutes(input.closesAt) - minutes(input.opensAt) < input.slotMinutes) invalid();
  return input;
}
export function validateSetSchoolEventStatusInput(value: unknown): SetSchoolEventStatusInput {
  const row = record(value, ['expectedVersion', 'status']);
  return { expectedVersion: count(row.expectedVersion, 1, 999_999_998), status: oneOf(row.status, ['PUBLISHED', 'CLOSED', 'CANCELLED'] as const) };
}
export function validateSetSchoolEventBookingStatusInput(value: unknown): SetSchoolEventBookingStatusInput {
  const row = record(value, ['expectedVersion', 'status']);
  return { expectedVersion: count(row.expectedVersion, 1, 999_999_998), status: oneOf(row.status, SCHOOL_EVENT_BOOKING_STATUSES) };
}
/** Public booking input. Name plus an email or a mobile number (E.164); website must stay empty. */
export function validatePublicEventBookingInput(value: unknown): PublicSchoolEventBookingInput {
  const row = record(value, ['slotId', 'name', 'email', 'mobile', 'website']);
  if (row.website !== '') invalid();
  const email = typeof row.email === 'string' ? row.email.toLowerCase() : invalid();
  const mobile = typeof row.mobile === 'string' ? row.mobile : invalid();
  if (email.length > 254 || (email && !EMAIL.test(email)) || (mobile && !MOBILE.test(mobile)) || (!email && !mobile)) invalid();
  return { slotId: uuid(row.slotId), name: eventText(row.name, 1, 120), email, mobile, website: '' };
}

export function verifySchoolEvent(value: unknown): SchoolEvent {
  const row = record(value, ['eventId', 'publicId', 'title', 'description', 'place', 'localDate', 'opensAt', 'closesAt', 'slotMinutes', 'spotsPerSlot',
    'status', 'version', 'slotCount', 'bookedCount', 'createdAt']);
  if (!isPublicEventId(row.publicId)) invalid();
  return {
    eventId: uuid(row.eventId), publicId: row.publicId, title: eventText(row.title, 1, 120), description: eventText(row.description, 0, 500),
    place: eventText(row.place, 0, 120), localDate: schoolEventDate(row.localDate), opensAt: clock(row.opensAt), closesAt: clock(row.closesAt),
    slotMinutes: count(row.slotMinutes, 10, 240), spotsPerSlot: count(row.spotsPerSlot, 1, 500), status: oneOf(row.status, SCHOOL_EVENT_STATUSES),
    version: count(row.version, 1), slotCount: count(row.slotCount, 0, SCHOOL_EVENT_MAX_SLOTS), bookedCount: count(row.bookedCount, 0), createdAt: instant(row.createdAt),
  };
}
export function verifySchoolEventBooking(value: unknown): SchoolEventBooking {
  const row = record(value, ['bookingId', 'slotId', 'name', 'email', 'mobile', 'status', 'cancelledBy', 'version', 'createdAt']);
  if (row.email !== null && (typeof row.email !== 'string' || !EMAIL.test(row.email))) invalid();
  if (row.mobile !== null && (typeof row.mobile !== 'string' || !MOBILE.test(row.mobile))) invalid();
  if (row.email === null && row.mobile === null) invalid();
  const status = oneOf(row.status, SCHOOL_EVENT_BOOKING_STATUSES);
  const cancelledBy = row.cancelledBy === null ? null : oneOf(row.cancelledBy, ['FAMILY', 'STAFF'] as const);
  if ((status === 'CANCELLED') !== (cancelledBy !== null)) invalid();
  return {
    bookingId: uuid(row.bookingId), slotId: uuid(row.slotId), name: eventText(row.name, 1, 120), email: row.email as string | null, mobile: row.mobile as string | null,
    status, cancelledBy, version: count(row.version, 1), createdAt: instant(row.createdAt),
  };
}
export function verifySchoolEvents(value: unknown): SchoolEvents {
  const row = record(value, ['localToday', 'timezone', 'events']);
  if (typeof row.timezone !== 'string' || !row.timezone || !Array.isArray(row.events) || row.events.length > 200) invalid();
  return { localToday: schoolEventDate(row.localToday), timezone: row.timezone, events: row.events.map(verifySchoolEvent) };
}
export function verifySchoolEventDetail(value: unknown, eventId: string): SchoolEventDetail {
  const row = record(value, ['event', 'timezone', 'slots']);
  const event = verifySchoolEvent(row.event);
  if (event.eventId !== eventId || typeof row.timezone !== 'string' || !row.timezone || !Array.isArray(row.slots) || row.slots.length !== event.slotCount) invalid();
  const slots = row.slots.map((slot, index): SchoolEventSlot => {
    const s = record(slot, ['slotId', 'position', 'localStart', 'localEnd', 'startsAt', 'taken', 'bookings']);
    if (s.position !== index || !Array.isArray(s.bookings)) invalid();
    const bookings = s.bookings.map(verifySchoolEventBooking);
    const slotId = uuid(s.slotId);
    if (bookings.some(b => b.slotId !== slotId) || bookings.filter(b => b.status !== 'CANCELLED').length !== s.taken) invalid();
    return { slotId, position: index, localStart: clock(s.localStart), localEnd: clock(s.localEnd), startsAt: instant(s.startsAt), taken: count(s.taken, 0), bookings };
  });
  return { event, timezone: row.timezone, slots };
}
export function verifySchoolEventReceipt(value: unknown, expected: { eventId?: string }): SchoolEventReceipt {
  const row = record(value, ['event', 'skippedTimes']);
  const event = verifySchoolEvent(row.event);
  if ((expected.eventId && event.eventId !== expected.eventId) || !Array.isArray(row.skippedTimes) || row.skippedTimes.length > 96) invalid();
  return { event, skippedTimes: row.skippedTimes.map(clock) };
}
export function verifySchoolEventBookingReceipt(value: unknown, expected: { bookingId: string }): SchoolEventBookingReceipt {
  const row = record(value, ['booking']);
  const booking = verifySchoolEventBooking(row.booking);
  if (booking.bookingId !== expected.bookingId) invalid();
  return { booking };
}
export function verifyPublicSchoolEvent(value: unknown, publicId: string): PublicSchoolEvent {
  const row = record(value, ['publicId', 'schoolName', 'title', 'description', 'place', 'localDate', 'timezone', 'status', 'slots']);
  if (row.publicId !== publicId || typeof row.schoolName !== 'string' || !row.schoolName || row.schoolName.length > 200 || typeof row.timezone !== 'string' || !row.timezone
    || !Array.isArray(row.slots) || row.slots.length > SCHOOL_EVENT_MAX_SLOTS) invalid();
  return {
    publicId, schoolName: row.schoolName, title: eventText(row.title, 1, 120), description: eventText(row.description, 0, 500), place: eventText(row.place, 0, 120),
    localDate: schoolEventDate(row.localDate), timezone: row.timezone, status: oneOf(row.status, ['OPEN', 'CLOSED', 'CANCELLED'] as const),
    slots: row.slots.map(slot => {
      const s = record(slot, ['slotId', 'localStart', 'localEnd', 'spotsLeft']);
      return { slotId: uuid(s.slotId), localStart: clock(s.localStart), localEnd: clock(s.localEnd), spotsLeft: count(s.spotsLeft, 0, 500) };
    }),
  };
}
export function verifyPublicEventBookingOutcome(value: unknown): PublicEventBookingOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  const result = oneOf(row.result, PUBLIC_EVENT_BOOKING_RESULTS);
  if (result !== 'BOOKED') { record(row, ['result']); return { result }; }
  record(row, ['result', 'code', 'slotId', 'localStart', 'localEnd', 'status']);
  if (typeof row.code !== 'string' || !CODE.test(row.code)) invalid();
  return { result, code: row.code, slotId: uuid(row.slotId), localStart: clock(row.localStart), localEnd: clock(row.localEnd), status: oneOf(row.status, SCHOOL_EVENT_BOOKING_STATUSES) };
}
export function verifyPublicEventCancelOutcome(value: unknown): PublicEventCancelResult {
  const row = record(value, ['result']);
  return oneOf(row.result, PUBLIC_EVENT_CANCEL_RESULTS);
}
