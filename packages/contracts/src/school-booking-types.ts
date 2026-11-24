/**
 * School booking types (0286): a school's own repeating kinds of booking (a test reservation, a 2nd trial, a parent meeting)
 * with weekly hours, questions, an optional waiver and a thank-you message. Each type is an open link or for current families
 * only (owner decision "Owner picks per type"); the public page carries the 0285 school branding. Staff with
 * schedule.session.manage manage types and see bookings. No message, charge, CRM lead, student record or AI.
 */
import { isPublicEventId, isSchoolEventText, normalizeEventBookingCode, schoolEventDate } from './school-events.js';
import { validateSchoolBrandingInput, type SchoolBrandingInput } from './school-branding.js';

export const BOOKING_TYPE_TEMPLATES = ['TEST_RESERVATION', 'SECOND_TRIAL', 'PARENT_MEETING', 'OTHER'] as const;
export type BookingTypeTemplate = (typeof BOOKING_TYPE_TEMPLATES)[number];
export const BOOKING_TYPE_AUDIENCES = ['OPEN', 'FAMILIES_ONLY'] as const;
export type BookingTypeAudience = (typeof BOOKING_TYPE_AUDIENCES)[number];
export const BOOKING_TYPE_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export type BookingTypeStatus = (typeof BOOKING_TYPE_STATUSES)[number];
export const BOOKING_TYPE_BOOKING_STATUSES = ['BOOKED', 'ARRIVED', 'CANCELLED'] as const;
export type BookingTypeBookingStatus = (typeof BOOKING_TYPE_BOOKING_STATUSES)[number];
export const BOOKING_TYPE_QUESTION_KINDS = ['TEXT', 'YES_NO'] as const;
export type BookingTypeQuestionKind = (typeof BOOKING_TYPE_QUESTION_KINDS)[number];
export const BOOKING_TYPE_LIMITS = {
  name: 80, description: 500, waiver: 4000, thankYou: 500, questionLabel: 120, answer: 300, questions: 5, windows: 14,
  minDuration: 10, maxDuration: 240, maxSpots: 50, maxHorizonDays: 90, maxNoticeHours: 168, maxTypes: 20, maxPublicTimes: 400, maxStaffBookings: 500,
} as const;

/** One weekly window: ISO weekday (1 Monday .. 7 Sunday) and local start/end in school time. */
export interface BookingTypeWindow { day: number; start: string; end: string }
export interface BookingTypeQuestion { label: string; kind: BookingTypeQuestionKind; required: boolean }
export interface SaveBookingTypeInput {
  expectedVersion: number; name: string; description: string; template: BookingTypeTemplate; durationMinutes: number; spotsPerTime: number;
  weeklyHours: BookingTypeWindow[]; horizonDays: number; noticeHours: number; audience: BookingTypeAudience; questions: BookingTypeQuestion[];
  waiver: string; thankYou: string;
}
export interface SetBookingTypeStatusInput { expectedVersion: number; status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' }
export interface SetBookingTypeBookingStatusInput { expectedVersion: number; status: BookingTypeBookingStatus }

export interface BookingType extends Omit<SaveBookingTypeInput, 'expectedVersion'> {
  typeId: string; publicId: string; status: BookingTypeStatus; version: number; upcomingCount: number; createdAt: string;
}
export type BookingTypeAnswer = string | boolean | null;
export interface BookingTypeBooking {
  bookingId: string; startsAt: string; endsAt: string; localDate: string; localStart: string; name: string; email: string | null; mobile: string | null;
  questions: BookingTypeQuestion[]; answers: BookingTypeAnswer[]; waiverAcceptedAt: string | null; status: BookingTypeBookingStatus;
  cancelledBy: 'FAMILY' | 'STAFF' | null; version: number; createdAt: string;
}
export interface BookingTypes { localToday: string; timezone: string; bookingTypes: BookingType[] }
export interface BookingTypeDetail { bookingType: BookingType; timezone: string; bookings: BookingTypeBooking[] }
export interface BookingTypeReceipt { bookingType: BookingType }
export interface BookingTypeBookingReceipt { booking: BookingTypeBooking }

export interface PublicBookingTypeTime { startsAt: string; localDate: string; localStart: string; localEnd: string; spotsLeft: number }
export interface PublicBookingType {
  publicId: string; schoolName: string; branding: SchoolBrandingInput; name: string; description: string; template: BookingTypeTemplate;
  durationMinutes: number; audience: BookingTypeAudience; questions: BookingTypeQuestion[]; waiver: string; timezone: string;
  status: 'OPEN' | 'PAUSED' | 'CLOSED'; times: PublicBookingTypeTime[];
}
export interface PublicBookingTypeBookingInput {
  startsAt: string; name: string; email: string; mobile: string; answers: BookingTypeAnswer[]; waiverAccepted: boolean; website: string;
}
export const PUBLIC_BOOKING_TYPE_RESULTS = ['BOOKED', 'INVALID', 'CLOSED', 'FAMILIES_ONLY', 'FULL', 'TIME_NOT_OFFERED', 'ALREADY_BOOKED', 'RATE_LIMITED', 'UNAVAILABLE'] as const;
export type PublicBookingTypeResult = (typeof PUBLIC_BOOKING_TYPE_RESULTS)[number];
export interface PublicBookingTypeOutcome {
  result: PublicBookingTypeResult; code?: string; startsAt?: string; localDate?: string; localStart?: string; thankYou?: string; status?: BookingTypeBookingStatus;
}
export const PUBLIC_BOOKING_TYPE_CANCEL_RESULTS = ['CANCELLED', 'INVALID', 'STARTED', 'RATE_LIMITED', 'UNAVAILABLE'] as const;
export type PublicBookingTypeCancelResult = (typeof PUBLIC_BOOKING_TYPE_CANCEL_RESULTS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MINUTE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const CODE = /^[A-F0-9]{12}$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/;
const MOBILE = /^\+[1-9][0-9]{6,14}$/;

function invalid(): never { throw new Error('Invalid booking type data.'); }
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
function line(value: unknown, minimum: number, maximum: number): string { if (!isSchoolEventText(value, minimum, maximum)) invalid(); return value; }
function minutes(value: string): number { return Number(value.slice(0, 2)) * 60 + Number(value.slice(3)); }

/** Same rule as hon.school_booking_text_ok: the one-line rule with line breaks allowed inside. */
export function isBookingTypeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && [...value].length <= maximum && isSchoolEventText(value.replace(/\n/g, ' '), 0, maximum);
}
function text(value: unknown, maximum: number): string { if (!isBookingTypeText(value, maximum)) invalid(); return value; }
export function isPublicBookingTypeId(value: unknown): value is string { return isPublicEventId(value); }
export { normalizeEventBookingCode as normalizeBookingTypeCode };

function windows(value: unknown, duration: number): BookingTypeWindow[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > BOOKING_TYPE_LIMITS.windows) invalid();
  const list = value.map((item): BookingTypeWindow => {
    const w = record(item, ['day', 'start', 'end']);
    const out = { day: count(w.day, 1, 7), start: clock(w.start), end: clock(w.end) };
    if (minutes(out.end) - minutes(out.start) < duration) invalid();
    return out;
  });
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i]!, b = list[j]!;
    if (a.day === b.day && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end)) invalid();
  }
  return list.sort((a, b) => a.day - b.day || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}
function questions(value: unknown): BookingTypeQuestion[] {
  if (!Array.isArray(value) || value.length > BOOKING_TYPE_LIMITS.questions) invalid();
  return value.map(item => {
    const q = record(item, ['label', 'kind', 'required']);
    if (typeof q.required !== 'boolean') invalid();
    return { label: line(q.label, 1, BOOKING_TYPE_LIMITS.questionLabel), kind: oneOf(q.kind, BOOKING_TYPE_QUESTION_KINDS), required: q.required };
  });
}
function body(row: Record<string, unknown>): Omit<SaveBookingTypeInput, 'expectedVersion'> {
  const durationMinutes = count(row.durationMinutes, BOOKING_TYPE_LIMITS.minDuration, BOOKING_TYPE_LIMITS.maxDuration);
  return {
    name: line(row.name, 1, BOOKING_TYPE_LIMITS.name), description: text(row.description, BOOKING_TYPE_LIMITS.description),
    template: oneOf(row.template, BOOKING_TYPE_TEMPLATES), durationMinutes, spotsPerTime: count(row.spotsPerTime, 1, BOOKING_TYPE_LIMITS.maxSpots),
    weeklyHours: windows(row.weeklyHours, durationMinutes), horizonDays: count(row.horizonDays, 1, BOOKING_TYPE_LIMITS.maxHorizonDays),
    noticeHours: count(row.noticeHours, 0, BOOKING_TYPE_LIMITS.maxNoticeHours), audience: oneOf(row.audience, BOOKING_TYPE_AUDIENCES),
    questions: questions(row.questions), waiver: text(row.waiver, BOOKING_TYPE_LIMITS.waiver), thankYou: text(row.thankYou, BOOKING_TYPE_LIMITS.thankYou),
  };
}
const BODY_KEYS = ['name', 'description', 'template', 'durationMinutes', 'spotsPerTime', 'weeklyHours', 'horizonDays', 'noticeHours', 'audience',
  'questions', 'waiver', 'thankYou'] as const;

export function validateSaveBookingTypeInput(value: unknown): SaveBookingTypeInput {
  const row = record(value, ['expectedVersion', ...BODY_KEYS]);
  return { expectedVersion: count(row.expectedVersion, 0, 999_999_998), ...body(row) };
}
export function validateSetBookingTypeStatusInput(value: unknown): SetBookingTypeStatusInput {
  const row = record(value, ['expectedVersion', 'status']);
  return { expectedVersion: count(row.expectedVersion, 1, 999_999_998), status: oneOf(row.status, ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const) };
}
export function validateSetBookingTypeBookingStatusInput(value: unknown): SetBookingTypeBookingStatusInput {
  const row = record(value, ['expectedVersion', 'status']);
  return { expectedVersion: count(row.expectedVersion, 1, 999_999_998), status: oneOf(row.status, BOOKING_TYPE_BOOKING_STATUSES) };
}
function answersFor(value: unknown, list: readonly BookingTypeQuestion[]): BookingTypeAnswer[] {
  if (!Array.isArray(value) || value.length !== list.length) invalid();
  return value.map((answer, i) => {
    const q = list[i]!;
    if (q.kind === 'TEXT') return line(answer, q.required ? 1 : 0, BOOKING_TYPE_LIMITS.answer);
    if (typeof answer === 'boolean' || (answer === null && !q.required)) return answer;
    return invalid();
  });
}
/** Public booking input for one type. Name plus an email or a mobile number (E.164); website must stay empty. */
export function validatePublicBookingTypeInput(value: unknown, type: Pick<PublicBookingType, 'questions' | 'waiver'>): PublicBookingTypeBookingInput {
  const row = record(value, ['startsAt', 'name', 'email', 'mobile', 'answers', 'waiverAccepted', 'website']);
  if (row.website !== '' || typeof row.startsAt !== 'string' || !MINUTE_INSTANT.test(row.startsAt) || new Date(row.startsAt).toISOString() !== row.startsAt) invalid();
  if (row.waiverAccepted !== (type.waiver !== '')) invalid();
  const email = typeof row.email === 'string' ? row.email.toLowerCase() : invalid();
  const mobile = typeof row.mobile === 'string' ? row.mobile : invalid();
  if (email.length > 254 || (email && !EMAIL.test(email)) || (mobile && !MOBILE.test(mobile)) || (!email && !mobile)) invalid();
  return { startsAt: row.startsAt, name: line(row.name, 1, 120), email, mobile, answers: answersFor(row.answers, type.questions), waiverAccepted: row.waiverAccepted as boolean, website: '' };
}
/** Server-side shape check before the database applies the type's own questions and waiver. */
export function validatePublicBookingTypeShape(value: unknown): PublicBookingTypeBookingInput {
  const row = record(value, ['startsAt', 'name', 'email', 'mobile', 'answers', 'waiverAccepted', 'website']);
  if (!Array.isArray(row.answers) || row.answers.length > BOOKING_TYPE_LIMITS.questions || typeof row.waiverAccepted !== 'boolean') invalid();
  const loose = row.answers.map(a => (typeof a === 'string' ? { label: 'x', kind: 'TEXT' as const, required: false } : { label: 'x', kind: 'YES_NO' as const, required: false }));
  return validatePublicBookingTypeInput(value, { questions: loose, waiver: row.waiverAccepted ? 'x' : '' });
}

export function verifyBookingType(value: unknown): BookingType {
  const row = record(value, ['typeId', 'publicId', ...BODY_KEYS, 'status', 'version', 'upcomingCount', 'createdAt']);
  if (!isPublicEventId(row.publicId)) invalid();
  return {
    typeId: uuid(row.typeId), publicId: row.publicId, ...body(row), status: oneOf(row.status, BOOKING_TYPE_STATUSES), version: count(row.version, 1),
    upcomingCount: count(row.upcomingCount, 0), createdAt: instant(row.createdAt),
  };
}
export function verifyBookingTypeBooking(value: unknown): BookingTypeBooking {
  const row = record(value, ['bookingId', 'startsAt', 'endsAt', 'localDate', 'localStart', 'name', 'email', 'mobile', 'questions', 'answers',
    'waiverAcceptedAt', 'status', 'cancelledBy', 'version', 'createdAt']);
  if (row.email !== null && (typeof row.email !== 'string' || !EMAIL.test(row.email))) invalid();
  if (row.mobile !== null && (typeof row.mobile !== 'string' || !MOBILE.test(row.mobile))) invalid();
  if (row.email === null && row.mobile === null) invalid();
  const status = oneOf(row.status, BOOKING_TYPE_BOOKING_STATUSES);
  const cancelledBy = row.cancelledBy === null ? null : oneOf(row.cancelledBy, ['FAMILY', 'STAFF'] as const);
  if ((status === 'CANCELLED') !== (cancelledBy !== null)) invalid();
  const asked = questions(row.questions);
  const startsAt = instant(row.startsAt), endsAt = instant(row.endsAt);
  if (endsAt <= startsAt) invalid();
  return {
    bookingId: uuid(row.bookingId), startsAt, endsAt, localDate: schoolEventDate(row.localDate), localStart: clock(row.localStart), name: line(row.name, 1, 120),
    email: row.email as string | null, mobile: row.mobile as string | null, questions: asked, answers: answersFor(row.answers, asked.map(q => ({ ...q, required: false }))),
    waiverAcceptedAt: row.waiverAcceptedAt === null ? null : instant(row.waiverAcceptedAt), status, cancelledBy, version: count(row.version, 1), createdAt: instant(row.createdAt),
  };
}
export function verifyBookingTypes(value: unknown): BookingTypes {
  const row = record(value, ['localToday', 'timezone', 'bookingTypes']);
  if (typeof row.timezone !== 'string' || !row.timezone || !Array.isArray(row.bookingTypes) || row.bookingTypes.length > 100) invalid();
  return { localToday: schoolEventDate(row.localToday), timezone: row.timezone, bookingTypes: row.bookingTypes.map(verifyBookingType) };
}
export function verifyBookingTypeDetail(value: unknown, typeId: string): BookingTypeDetail {
  const row = record(value, ['bookingType', 'timezone', 'bookings']);
  const bookingType = verifyBookingType(row.bookingType);
  if (bookingType.typeId !== typeId || typeof row.timezone !== 'string' || !row.timezone || !Array.isArray(row.bookings)
    || row.bookings.length > BOOKING_TYPE_LIMITS.maxStaffBookings) invalid();
  return { bookingType, timezone: row.timezone, bookings: row.bookings.map(verifyBookingTypeBooking) };
}
export function verifyBookingTypeReceipt(value: unknown, expected: { typeId?: string }): BookingTypeReceipt {
  const row = record(value, ['bookingType']);
  const bookingType = verifyBookingType(row.bookingType);
  if (expected.typeId && bookingType.typeId !== expected.typeId) invalid();
  return { bookingType };
}
export function verifyBookingTypeBookingReceipt(value: unknown, expected: { bookingId: string }): BookingTypeBookingReceipt {
  const row = record(value, ['booking']);
  const booking = verifyBookingTypeBooking(row.booking);
  if (booking.bookingId !== expected.bookingId) invalid();
  return { booking };
}
export function verifyPublicBookingType(value: unknown, publicId: string): PublicBookingType {
  const row = record(value, ['publicId', 'schoolName', 'branding', 'name', 'description', 'template', 'durationMinutes', 'audience', 'questions', 'waiver',
    'timezone', 'status', 'times']);
  if (row.publicId !== publicId || typeof row.schoolName !== 'string' || !row.schoolName || row.schoolName.length > 200 || typeof row.timezone !== 'string' || !row.timezone
    || !Array.isArray(row.times) || row.times.length > BOOKING_TYPE_LIMITS.maxPublicTimes) invalid();
  let branding: SchoolBrandingInput;
  try { branding = validateSchoolBrandingInput(row.branding); } catch { invalid(); }
  const status = oneOf(row.status, ['OPEN', 'PAUSED', 'CLOSED'] as const);
  const audience = oneOf(row.audience, BOOKING_TYPE_AUDIENCES);
  if (row.times.length > 0 && (status !== 'OPEN' || audience !== 'OPEN')) invalid();
  return {
    publicId, schoolName: row.schoolName, branding, name: line(row.name, 1, BOOKING_TYPE_LIMITS.name), description: text(row.description, BOOKING_TYPE_LIMITS.description),
    template: oneOf(row.template, BOOKING_TYPE_TEMPLATES), durationMinutes: count(row.durationMinutes, BOOKING_TYPE_LIMITS.minDuration, BOOKING_TYPE_LIMITS.maxDuration),
    audience, questions: questions(row.questions), waiver: text(row.waiver, BOOKING_TYPE_LIMITS.waiver), timezone: row.timezone, status,
    times: row.times.map(item => {
      const t = record(item, ['startsAt', 'localDate', 'localStart', 'localEnd', 'spotsLeft']);
      return { startsAt: instant(t.startsAt), localDate: schoolEventDate(t.localDate), localStart: clock(t.localStart), localEnd: clock(t.localEnd),
        spotsLeft: count(t.spotsLeft, 0, BOOKING_TYPE_LIMITS.maxSpots) };
    }),
  };
}
export function verifyPublicBookingTypeOutcome(value: unknown): PublicBookingTypeOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  const result = oneOf(row.result, PUBLIC_BOOKING_TYPE_RESULTS);
  if (result !== 'BOOKED') { record(row, ['result']); return { result }; }
  record(row, ['result', 'code', 'startsAt', 'localDate', 'localStart', 'thankYou', 'status']);
  if (typeof row.code !== 'string' || !CODE.test(row.code)) invalid();
  return { result, code: row.code, startsAt: instant(row.startsAt), localDate: schoolEventDate(row.localDate), localStart: clock(row.localStart),
    thankYou: text(row.thankYou, BOOKING_TYPE_LIMITS.thankYou), status: oneOf(row.status, BOOKING_TYPE_BOOKING_STATUSES) };
}
export function verifyPublicBookingTypeCancelOutcome(value: unknown): PublicBookingTypeCancelResult {
  const row = record(value, ['result']);
  return oneOf(row.result, PUBLIC_BOOKING_TYPE_CANCEL_RESULTS);
}
