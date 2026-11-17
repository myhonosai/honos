/**
 * Parent account bookings of event slots and families-only booking types (0431, A4). A signed-in guardian books a 0261 event
 * slot or a 0286 FAMILIES_ONLY booking type time with the family's details from the account, and cancels those bookings before
 * they start. VIEWER grants read only. Open spots only, never other families. No message, charge or AI.
 */
import { isSchoolEventText, schoolEventDate } from './school-events.js';
import {
  BOOKING_TYPE_LIMITS, BOOKING_TYPE_QUESTION_KINDS, BOOKING_TYPE_TEMPLATES, isBookingTypeText,
  type BookingTypeAnswer, type BookingTypeQuestion, type BookingTypeTemplate, type PublicBookingTypeTime,
} from './school-booking-types.js';

export const PARENT_SCHOOL_BOOKING_KINDS = ['EVENT', 'BOOKING_TYPE'] as const;
export type ParentSchoolBookingKind = (typeof PARENT_SCHOOL_BOOKING_KINDS)[number];
export const PARENT_SCHOOL_BOOKING_STATUSES = ['BOOKED', 'ARRIVED', 'CANCELLED'] as const;
export type ParentSchoolBookingStatus = (typeof PARENT_SCHOOL_BOOKING_STATUSES)[number];
export const PARENT_SCHOOL_BOOKING_LIMITS = { events: 20, slots: 96, types: 20, times: 200, bookings: 50 } as const;

export interface ParentSchoolBooking {
  kind: ParentSchoolBookingKind; bookingId: string; parentId: string; title: string; localDate: string; localStart: string; localEnd: string;
  startsAt: string; status: ParentSchoolBookingStatus; version: number; canCancel: boolean;
}
export interface ParentSchoolEventSlot { slotId: string; localStart: string; localEnd: string; startsAt: string; spotsLeft: number }
export interface ParentSchoolEventChoice {
  eventId: string; title: string; description: string; place: string; localDate: string; bookingId: string | null; slots: ParentSchoolEventSlot[];
}
export interface ParentSchoolBookingTypeChoice {
  typeId: string; name: string; description: string; template: BookingTypeTemplate; durationMinutes: number; questions: BookingTypeQuestion[];
  waiver: string; bookingId: string | null; times: PublicBookingTypeTime[];
}
export interface ParentSchoolBookingContact { name: string; email: string }
export interface ParentSchoolBookings {
  canBook: boolean; timezone: string; contact: ParentSchoolBookingContact | null; events: ParentSchoolEventChoice[];
  bookingTypes: ParentSchoolBookingTypeChoice[]; bookings: ParentSchoolBooking[];
}
export interface ParentSchoolBookingReceipt { booking: ParentSchoolBooking; spotsLeft: number }
export interface BookParentSchoolEventSlotInput { slotId: string }
export interface BookParentSchoolBookingTypeInput { typeId: string; startsAt: string; answers: BookingTypeAnswer[]; waiverAccepted: boolean }
export interface CancelParentSchoolBookingInput { bookingId: string; expectedVersion: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MINUTE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const ZONE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/;

function invalid(): never { throw new Error('Invalid parent school booking data.'); }
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
function optionalUuid(value: unknown): string | null { return value === null ? null : uuid(value); }
function clock(value: unknown): string { if (typeof value !== 'string' || !CLOCK.test(value)) invalid(); return value; }
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid(); return value; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function line(value: unknown, minimum: number, maximum: number): string { if (!isSchoolEventText(value, minimum, maximum)) invalid(); return value; }
function text(value: unknown, maximum: number): string { if (!isBookingTypeText(value, maximum)) invalid(); return value; }
function ordered<T extends { startsAt: string }>(list: T[]): T[] { if (list.some((x, i) => i > 0 && x.startsAt < list[i - 1]!.startsAt)) invalid(); return list; }

export function validateBookParentSchoolEventSlotInput(value: unknown): BookParentSchoolEventSlotInput {
  const row = record(value, ['slotId']);
  return { slotId: uuid(row.slotId) };
}
export function validateBookParentSchoolBookingTypeInput(value: unknown): BookParentSchoolBookingTypeInput {
  const row = record(value, ['typeId', 'startsAt', 'answers', 'waiverAccepted']);
  if (typeof row.startsAt !== 'string' || !MINUTE_INSTANT.test(row.startsAt) || new Date(row.startsAt).toISOString() !== row.startsAt) invalid();
  if (typeof row.waiverAccepted !== 'boolean' || !Array.isArray(row.answers) || row.answers.length > BOOKING_TYPE_LIMITS.questions) invalid();
  const answers = row.answers.map((a): BookingTypeAnswer => {
    if (a === null || typeof a === 'boolean') return a;
    return line(a, 0, BOOKING_TYPE_LIMITS.answer);
  });
  return { typeId: uuid(row.typeId), startsAt: row.startsAt, answers, waiverAccepted: row.waiverAccepted };
}
export function validateCancelParentSchoolBookingInput(value: unknown): CancelParentSchoolBookingInput {
  const row = record(value, ['bookingId', 'expectedVersion']);
  return { bookingId: uuid(row.bookingId), expectedVersion: count(row.expectedVersion, 1, 999_999_999) };
}

export function verifyParentSchoolBooking(value: unknown): ParentSchoolBooking {
  const row = record(value, ['kind', 'bookingId', 'parentId', 'title', 'localDate', 'localStart', 'localEnd', 'startsAt', 'status', 'version', 'canCancel']);
  if (typeof row.canCancel !== 'boolean') invalid();
  const out: ParentSchoolBooking = {
    kind: oneOf(row.kind, PARENT_SCHOOL_BOOKING_KINDS), bookingId: uuid(row.bookingId), parentId: uuid(row.parentId), title: line(row.title, 1, 120),
    localDate: schoolEventDate(row.localDate), localStart: clock(row.localStart), localEnd: clock(row.localEnd), startsAt: instant(row.startsAt),
    status: oneOf(row.status, PARENT_SCHOOL_BOOKING_STATUSES), version: count(row.version, 1), canCancel: row.canCancel,
  };
  if (out.canCancel && out.status !== 'BOOKED') invalid();
  return out;
}
function question(value: unknown): BookingTypeQuestion {
  const q = record(value, ['label', 'kind', 'required']);
  if (typeof q.required !== 'boolean') invalid();
  return { label: line(q.label, 1, BOOKING_TYPE_LIMITS.questionLabel), kind: oneOf(q.kind, BOOKING_TYPE_QUESTION_KINDS), required: q.required };
}
function event(value: unknown): ParentSchoolEventChoice {
  const row = record(value, ['eventId', 'title', 'description', 'place', 'localDate', 'bookingId', 'slots']);
  if (!Array.isArray(row.slots) || row.slots.length > PARENT_SCHOOL_BOOKING_LIMITS.slots) invalid();
  return {
    eventId: uuid(row.eventId), title: line(row.title, 1, 120), description: line(row.description, 0, 500), place: line(row.place, 0, 120),
    localDate: schoolEventDate(row.localDate), bookingId: optionalUuid(row.bookingId),
    slots: ordered(row.slots.map(item => {
      const s = record(item, ['slotId', 'localStart', 'localEnd', 'startsAt', 'spotsLeft']);
      return { slotId: uuid(s.slotId), localStart: clock(s.localStart), localEnd: clock(s.localEnd), startsAt: instant(s.startsAt), spotsLeft: count(s.spotsLeft, 0, 500) };
    })),
  };
}
function bookingType(value: unknown): ParentSchoolBookingTypeChoice {
  const row = record(value, ['typeId', 'name', 'description', 'template', 'durationMinutes', 'questions', 'waiver', 'bookingId', 'times']);
  if (!Array.isArray(row.questions) || row.questions.length > BOOKING_TYPE_LIMITS.questions || !Array.isArray(row.times)
    || row.times.length > PARENT_SCHOOL_BOOKING_LIMITS.times) invalid();
  return {
    typeId: uuid(row.typeId), name: line(row.name, 1, BOOKING_TYPE_LIMITS.name), description: text(row.description, BOOKING_TYPE_LIMITS.description),
    template: oneOf(row.template, BOOKING_TYPE_TEMPLATES), durationMinutes: count(row.durationMinutes, BOOKING_TYPE_LIMITS.minDuration, BOOKING_TYPE_LIMITS.maxDuration),
    questions: row.questions.map(question), waiver: text(row.waiver, BOOKING_TYPE_LIMITS.waiver), bookingId: optionalUuid(row.bookingId),
    times: ordered(row.times.map(item => {
      const t = record(item, ['startsAt', 'localDate', 'localStart', 'localEnd', 'spotsLeft']);
      return { startsAt: instant(t.startsAt), localDate: schoolEventDate(t.localDate), localStart: clock(t.localStart), localEnd: clock(t.localEnd),
        spotsLeft: count(t.spotsLeft, 0, BOOKING_TYPE_LIMITS.maxSpots) };
    })),
  };
}
export function verifyParentSchoolBookings(value: unknown): ParentSchoolBookings {
  const row = record(value, ['canBook', 'timezone', 'contact', 'events', 'bookingTypes', 'bookings']);
  if (typeof row.canBook !== 'boolean' || typeof row.timezone !== 'string' || !ZONE.test(row.timezone)) invalid();
  if (!Array.isArray(row.events) || row.events.length > PARENT_SCHOOL_BOOKING_LIMITS.events || !Array.isArray(row.bookingTypes)
    || row.bookingTypes.length > PARENT_SCHOOL_BOOKING_LIMITS.types || !Array.isArray(row.bookings) || row.bookings.length > PARENT_SCHOOL_BOOKING_LIMITS.bookings) invalid();
  let contact: ParentSchoolBookingContact | null = null;
  if (row.contact !== null) {
    const c = record(row.contact, ['name', 'email']);
    if (typeof c.email !== 'string' || c.email.length > 254 || !EMAIL.test(c.email)) invalid();
    contact = { name: line(c.name, 1, 120), email: c.email };
  }
  if (row.canBook && !contact) invalid();
  const bookings = ordered(row.bookings.map(verifyParentSchoolBooking));
  if (bookings.some(b => b.status === 'CANCELLED')) invalid();
  return { canBook: row.canBook, timezone: row.timezone, contact, events: row.events.map(event), bookingTypes: row.bookingTypes.map(bookingType), bookings };
}
export function verifyParentSchoolBookingReceipt(value: unknown, expected: { kind?: ParentSchoolBookingKind; bookingId?: string }): ParentSchoolBookingReceipt {
  const row = record(value, ['booking', 'spotsLeft']);
  const booking = verifyParentSchoolBooking(row.booking);
  if ((expected.kind && booking.kind !== expected.kind) || (expected.bookingId && booking.bookingId !== expected.bookingId)) invalid();
  return { booking, spotsLeft: count(row.spotsLeft, 0, 500) };
}
