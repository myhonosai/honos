/**
 * 0551 calendar cards: create a class or a roster from the calendar, move or resize one class, and read each class's card kind,
 * program, roster, lead instructor and booked count. Spec: docs/architecture/CALENDAR_CARDS_DRAG_AND_DROP.md.
 */
import { CLASS_SERIES_BOOKING_POLICIES, classSeriesDate, type ClassSeriesBookingPolicy } from './class-series.js';

export const CALENDAR_CARD_KINDS = ['CLASS', 'PRIVATE_LESSON', 'TRIAL', 'EVENT'] as const;
export type CalendarCardKind = (typeof CALENDAR_CARD_KINDS)[number];
/** At most this many school-local days per card read (a month grid is 42 days). */
export const CALENDAR_CARDS_MAX_DAYS = 42;

export interface CreateCalendarCardInput {
  kind: CalendarCardKind; programId: string; name: string; roomName?: string | null; capacity: number; bookingPolicy: ClassSeriesBookingPolicy;
  instructorPrincipalId?: string | null; localDate: string; localStartTime: string; durationMinutes: number;
  /** ISO weekdays (1 = Monday). Present and non-null: a weekly roster that includes the date's own weekday. */
  repeatWeekdays?: number[] | null; repeatUntil?: string | null;
}
export interface MoveCalendarCardInput { expectedVersion: number; startsAt: string; endsAt: string }
export interface CalendarCardsQuery { from: string; to: string }

export interface CreateCalendarCardReceipt {
  repeats: boolean; sessionKind: CalendarCardKind; sessionId: string | null; seriesId: string | null; created: number; skippedDates: string[];
}
export interface MoveCalendarCardReceipt { sessionId: string; version: number; startsAt: string; endsAt: string; detachedFromRoster: boolean }
export interface CalendarCardPerson { principalId: string; displayName: string }
export interface CalendarCard {
  sessionId: string; version: number; kind: CalendarCardKind; programId: string; programName: string; seriesId: string | null;
  instructor: CalendarCardPerson | null; booked: number; attended: boolean;
}
export interface CalendarCards {
  timezone: string; localToday: string; from: string; to: string; truncated: boolean; canManage: boolean; cards: CalendarCard[];
  programs: { programId: string; name: string }[]; instructors: CalendarCardPerson[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/;

function invalid(): never { throw new Error('Invalid calendar card data.'); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !(key in row))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function count(value: unknown, minimum: number, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value || CONTROL.test(value)) invalid();
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function isoWeekday(date: string): number { const d = new Date(`${date}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; }
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// Input validators (the database checks the same rules again).
export function validateCreateCalendarCardInput(value: unknown): CreateCalendarCardInput {
  const row = record(value, ['kind', 'programId', 'name', 'capacity', 'bookingPolicy', 'localDate', 'localStartTime', 'durationMinutes'],
    ['roomName', 'instructorPrincipalId', 'repeatWeekdays', 'repeatUntil']);
  const input: CreateCalendarCardInput = {
    kind: oneOf(row.kind, CALENDAR_CARD_KINDS), programId: uuid(row.programId), name: text(row.name, 120), capacity: count(row.capacity, 1, 1000),
    bookingPolicy: oneOf(row.bookingPolicy, CLASS_SERIES_BOOKING_POLICIES), localDate: classSeriesDate(row.localDate),
    localStartTime: typeof row.localStartTime === 'string' && CLOCK.test(row.localStartTime) ? row.localStartTime : invalid(),
    durationMinutes: count(row.durationMinutes, 5, 600),
  };
  if ('roomName' in row) input.roomName = row.roomName === null ? null : text(row.roomName, 120);
  if ('instructorPrincipalId' in row) input.instructorPrincipalId = row.instructorPrincipalId === null ? null : uuid(row.instructorPrincipalId);
  if ('repeatWeekdays' in row && row.repeatWeekdays !== null) {
    if (!Array.isArray(row.repeatWeekdays) || row.repeatWeekdays.length < 1 || row.repeatWeekdays.length > 7) invalid();
    const days = row.repeatWeekdays.map(day => count(day, 1, 7));
    if (new Set(days).size !== days.length || !days.includes(isoWeekday(input.localDate))) invalid();
    input.repeatWeekdays = days;
    if ('repeatUntil' in row) {
      input.repeatUntil = row.repeatUntil === null ? null : classSeriesDate(row.repeatUntil);
      if (input.repeatUntil && input.repeatUntil < input.localDate) invalid();
    }
  } else {
    if ('repeatWeekdays' in row) input.repeatWeekdays = null;
    if ('repeatUntil' in row && row.repeatUntil !== null) invalid();
    if ('repeatUntil' in row) input.repeatUntil = null;
  }
  return input;
}
export function validateMoveCalendarCardInput(value: unknown): MoveCalendarCardInput {
  const row = record(value, ['expectedVersion', 'startsAt', 'endsAt']);
  const input = { expectedVersion: count(row.expectedVersion, 1), startsAt: instant(row.startsAt), endsAt: instant(row.endsAt) };
  const minutes = (Date.parse(input.endsAt) - Date.parse(input.startsAt)) / 60_000;
  if (minutes < 5 || minutes > 600) invalid();
  return input;
}
export function validateCalendarCardsQuery(value: unknown): CalendarCardsQuery {
  const row = record(value, ['from', 'to']);
  const query = { from: classSeriesDate(row.from), to: classSeriesDate(row.to) };
  const span = daysBetween(query.from, query.to);
  if (span < 0 || span > CALENDAR_CARDS_MAX_DAYS) invalid();
  return query;
}

// Output verifiers: every database response is checked strictly before it reaches a client.
export function verifyCreateCalendarCardReceipt(value: unknown): CreateCalendarCardReceipt {
  const row = record(value, ['repeats', 'sessionKind', 'sessionId', 'seriesId', 'created', 'skippedDates']);
  if (!Array.isArray(row.skippedDates) || row.skippedDates.length > 400) invalid();
  const receipt: CreateCalendarCardReceipt = {
    repeats: bool(row.repeats), sessionKind: oneOf(row.sessionKind, CALENDAR_CARD_KINDS), sessionId: row.sessionId === null ? null : uuid(row.sessionId),
    seriesId: row.seriesId === null ? null : uuid(row.seriesId), created: count(row.created, 0, 400), skippedDates: row.skippedDates.map(classSeriesDate),
  };
  if (receipt.repeats ? receipt.seriesId === null || (receipt.created > 0) !== (receipt.sessionId !== null)
    : receipt.seriesId !== null || receipt.sessionId === null || receipt.created !== 1 || receipt.skippedDates.length) invalid();
  return receipt;
}
export function verifyMoveCalendarCardReceipt(value: unknown, expect: { sessionId: string; input: MoveCalendarCardInput }): MoveCalendarCardReceipt {
  const row = record(value, ['sessionId', 'version', 'startsAt', 'endsAt', 'detachedFromRoster']);
  const receipt = { sessionId: uuid(row.sessionId), version: count(row.version, 2), startsAt: instant(row.startsAt), endsAt: instant(row.endsAt), detachedFromRoster: bool(row.detachedFromRoster) };
  if (receipt.sessionId !== expect.sessionId.toLowerCase() || receipt.version !== expect.input.expectedVersion + 1
    || Date.parse(receipt.startsAt) !== Date.parse(expect.input.startsAt) || Date.parse(receipt.endsAt) !== Date.parse(expect.input.endsAt)) invalid();
  return receipt;
}
function person(value: unknown): CalendarCardPerson {
  const row = record(value, ['principalId', 'displayName']);
  return { principalId: uuid(row.principalId), displayName: text(row.displayName, 120) };
}
export function verifyCalendarCards(value: unknown, query: CalendarCardsQuery): CalendarCards {
  const row = record(value, ['timezone', 'localToday', 'from', 'to', 'truncated', 'canManage', 'cards', 'programs', 'instructors']);
  if (typeof row.timezone !== 'string' || !ZONE.test(row.timezone) || row.timezone.length > 64) invalid();
  if (!Array.isArray(row.cards) || row.cards.length > 1000 || !Array.isArray(row.programs) || row.programs.length > 200
    || !Array.isArray(row.instructors) || row.instructors.length > 200) invalid();
  const canManage = bool(row.canManage);
  const out: CalendarCards = {
    timezone: row.timezone, localToday: classSeriesDate(row.localToday), from: classSeriesDate(row.from), to: classSeriesDate(row.to),
    truncated: bool(row.truncated), canManage,
    cards: row.cards.map((card) => {
      const c = record(card, ['sessionId', 'version', 'kind', 'programId', 'programName', 'seriesId', 'instructor', 'booked', 'attended']);
      return { sessionId: uuid(c.sessionId), version: count(c.version, 1), kind: oneOf(c.kind, CALENDAR_CARD_KINDS), programId: uuid(c.programId),
        programName: text(c.programName, 120), seriesId: c.seriesId === null ? null : uuid(c.seriesId), instructor: c.instructor === null ? null : person(c.instructor),
        booked: count(c.booked, 0, 100_000), attended: bool(c.attended) };
    }),
    programs: row.programs.map((program) => { const g = record(program, ['programId', 'name']); return { programId: uuid(g.programId), name: text(g.name, 120) }; }),
    instructors: row.instructors.map(person),
  };
  if (out.from !== query.from || out.to !== query.to || new Set(out.cards.map(c => c.sessionId)).size !== out.cards.length
    || (!canManage && (out.programs.length || out.instructors.length))) invalid();
  return out;
}
