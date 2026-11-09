/**
 * B-SCH-1 (0239): recurring weekly classes in school time and the school's weekly timetable. Sessions are created only when
 * a staff member fills a series through a date (at most 12 weeks ahead); revising or ending a series changes only future
 * sessions with no booking or attendance.
 */
export const CLASS_SERIES_BOOKING_POLICIES = ['WALK_IN', 'OPTIONAL_BOOKING', 'REQUIRED_BOOKING'] as const;
export type ClassSeriesBookingPolicy = (typeof CLASS_SERIES_BOOKING_POLICIES)[number];
export const CLASS_SERIES_FILL_DAYS = 84;

export interface ClassSeriesPattern {
  name: string; roomName?: string | null; capacity: number; bookingPolicy: ClassSeriesBookingPolicy; weekdays: number[];
  localStartTime: string; durationMinutes: number; endsOn?: string | null;
}
export interface CreateClassSeriesInput extends ClassSeriesPattern { programId: string; startsOn: string }
export interface ReviseClassSeriesInput extends ClassSeriesPattern { expectedVersion: number }
export interface EndClassSeriesInput { expectedVersion: number; lastDate: string; reason: string }
export interface FillClassSeriesInput { expectedVersion: number; throughDate: string }
export interface TimetableQuery { weekOf?: string }

export interface ClassSeries {
  seriesId: string; programId: string; name: string; roomName: string | null; capacity: number; bookingPolicy: ClassSeriesBookingPolicy;
  weekdays: number[]; localStartTime: string; durationMinutes: number; startsOn: string; endsOn: string | null; generatedThrough: string | null;
  status: 'ACTIVE' | 'ENDED'; endReason: string | null; version: number; futureSessions: number; createdAt: string;
}
export interface ClassSeriesSessionEffect { created: number; updated: number; cancelled: number; keptBooked: number; skippedDates: string[] }
export interface ClassSeriesReceipt { series: ClassSeries; sessions: ClassSeriesSessionEffect }
export interface SchoolClassSeries { localToday: string; timezone: string; fillLimit: string; series: ClassSeries[]; programs: { programId: string; name: string }[] }
export interface TimetableSession {
  sessionId: string; seriesId: string | null; name: string; roomName: string | null; startsAt: string; endsAt: string; localDate: string;
  localStart: string; localEnd: string; capacity: number; bookingPolicy: ClassSeriesBookingPolicy; status: 'DRAFT' | 'SCHEDULED' | 'CANCELLED' | 'COMPLETED'; booked: number;
}
export interface WeeklyTimetable { timezone: string; localToday: string; weekStart: string; weekEnd: string; truncated: boolean; sessions: TimetableSession[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid class series data.'); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !(key in row))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function count(value: unknown, minimum: number, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
export function classSeriesDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE.test(value)) invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function text(value: unknown, maximum = 1000): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value || CONTROL.test(value)) invalid();
  return value;
}
function clock(value: unknown): string { if (typeof value !== 'string' || !CLOCK.test(value)) invalid(); return value; }
function nullable<T>(value: unknown, read: (value: unknown) => T): T | null { return value === null ? null : read(value); }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function weekdays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) invalid();
  const days = value.map(day => count(day, 1, 7));
  if (new Set(days).size !== days.length) invalid();
  return days;
}
function pattern(row: Record<string, unknown>): ClassSeriesPattern {
  const out: ClassSeriesPattern = { name: text(row.name, 120), capacity: count(row.capacity, 1, 1000), bookingPolicy: oneOf(row.bookingPolicy, CLASS_SERIES_BOOKING_POLICIES),
    weekdays: weekdays(row.weekdays), localStartTime: clock(row.localStartTime), durationMinutes: count(row.durationMinutes, 5, 600) };
  if ('roomName' in row) out.roomName = nullable(row.roomName, v => text(v, 120));
  if ('endsOn' in row) out.endsOn = nullable(row.endsOn, classSeriesDate);
  return out;
}
const PATTERN = ['name', 'capacity', 'bookingPolicy', 'weekdays', 'localStartTime', 'durationMinutes'];

// Input validators (the database validates the same rules again).
export function validateCreateClassSeriesInput(value: unknown): CreateClassSeriesInput {
  const row = record(value, ['programId', 'startsOn', ...PATTERN], ['roomName', 'endsOn']);
  const input: CreateClassSeriesInput = { programId: uuid(row.programId).toLowerCase(), startsOn: classSeriesDate(row.startsOn), ...pattern(row) };
  if (input.endsOn && input.endsOn < input.startsOn) invalid();
  return input;
}
export function validateReviseClassSeriesInput(value: unknown): ReviseClassSeriesInput {
  const row = record(value, ['expectedVersion', ...PATTERN], ['roomName', 'endsOn']);
  return { expectedVersion: count(row.expectedVersion, 1), ...pattern(row) };
}
export function validateEndClassSeriesInput(value: unknown): EndClassSeriesInput {
  const row = record(value, ['expectedVersion', 'lastDate', 'reason']);
  return { expectedVersion: count(row.expectedVersion, 1), lastDate: classSeriesDate(row.lastDate), reason: text(row.reason) };
}
export function validateFillClassSeriesInput(value: unknown): FillClassSeriesInput {
  const row = record(value, ['expectedVersion', 'throughDate']);
  return { expectedVersion: count(row.expectedVersion, 1), throughDate: classSeriesDate(row.throughDate) };
}
export function validateTimetableQuery(value: unknown): TimetableQuery {
  const row = record(value, [], ['weekOf']);
  return 'weekOf' in row ? { weekOf: classSeriesDate(row.weekOf) } : {};
}

// Output verifiers: every database response is checked strictly before it reaches a client.
export function verifyClassSeries(value: unknown): ClassSeries {
  const row = record(value, ['seriesId', 'programId', 'name', 'roomName', 'capacity', 'bookingPolicy', 'weekdays', 'localStartTime', 'durationMinutes',
    'startsOn', 'endsOn', 'generatedThrough', 'status', 'endReason', 'version', 'futureSessions', 'createdAt']);
  const series: ClassSeries = {
    seriesId: uuid(row.seriesId), programId: uuid(row.programId), name: text(row.name, 120), roomName: nullable(row.roomName, v => text(v, 120)),
    capacity: count(row.capacity, 1, 1000), bookingPolicy: oneOf(row.bookingPolicy, CLASS_SERIES_BOOKING_POLICIES), weekdays: weekdays(row.weekdays),
    localStartTime: clock(row.localStartTime), durationMinutes: count(row.durationMinutes, 5, 600), startsOn: classSeriesDate(row.startsOn),
    endsOn: nullable(row.endsOn, classSeriesDate), generatedThrough: nullable(row.generatedThrough, classSeriesDate), status: oneOf(row.status, ['ACTIVE', 'ENDED'] as const),
    endReason: nullable(row.endReason, v => text(v)), version: count(row.version, 1), futureSessions: count(row.futureSessions, 0), createdAt: instant(row.createdAt),
  };
  if ((series.status === 'ENDED') !== (series.endReason !== null) || (series.status === 'ENDED' && series.endsOn === null)
    || (series.endsOn !== null && series.endsOn < series.startsOn) || series.weekdays.some((d, n) => n > 0 && d <= series.weekdays[n - 1]!)) invalid();
  return series;
}
export function verifyClassSeriesReceipt(value: unknown, expect: { seriesId?: string }): ClassSeriesReceipt {
  const row = record(value, ['series', 'sessions']);
  const series = verifyClassSeries(row.series);
  const s = record(row.sessions, ['created', 'updated', 'cancelled', 'keptBooked', 'skippedDates']);
  if (!Array.isArray(s.skippedDates) || s.skippedDates.length > 100) invalid();
  const sessions = { created: count(s.created, 0, 100), updated: count(s.updated, 0), cancelled: count(s.cancelled, 0), keptBooked: count(s.keptBooked, 0),
    skippedDates: s.skippedDates.map(classSeriesDate) };
  if (expect.seriesId !== undefined && series.seriesId !== expect.seriesId.toLowerCase()) invalid();
  return { series, sessions };
}
export function verifySchoolClassSeries(value: unknown): SchoolClassSeries {
  const row = record(value, ['localToday', 'timezone', 'fillLimit', 'series', 'programs']);
  if (!Array.isArray(row.series) || row.series.length > 200 || !Array.isArray(row.programs) || row.programs.length > 200) invalid();
  const series = row.series.map(verifyClassSeries);
  const programs = row.programs.map(entry => { const p = record(entry, ['programId', 'name']); return { programId: uuid(p.programId), name: text(p.name, 500) }; });
  if (new Set(series.map(s => s.seriesId)).size !== series.length || typeof row.timezone !== 'string' || !row.timezone || row.timezone.length > 64) invalid();
  return { localToday: classSeriesDate(row.localToday), timezone: row.timezone, fillLimit: classSeriesDate(row.fillLimit), series, programs };
}
export function verifyWeeklyTimetable(value: unknown, query: TimetableQuery): WeeklyTimetable {
  const row = record(value, ['timezone', 'localToday', 'weekStart', 'weekEnd', 'truncated', 'sessions']);
  if (!Array.isArray(row.sessions) || row.sessions.length > 500 || typeof row.truncated !== 'boolean' || typeof row.timezone !== 'string' || !row.timezone) invalid();
  const weekStart = classSeriesDate(row.weekStart), weekEnd = classSeriesDate(row.weekEnd), localToday = classSeriesDate(row.localToday);
  const startDay = new Date(`${weekStart}T00:00:00.000Z`);
  if (startDay.getUTCDay() !== 1 || new Date(startDay.getTime() + 6 * 86400000).toISOString().slice(0, 10) !== weekEnd) invalid();
  const anchor = query.weekOf ?? localToday;
  if (anchor < weekStart || anchor > weekEnd) invalid();
  const sessions = row.sessions.map(entry => {
    const s = record(entry, ['sessionId', 'seriesId', 'name', 'roomName', 'startsAt', 'endsAt', 'localDate', 'localStart', 'localEnd', 'capacity', 'bookingPolicy', 'status', 'booked']);
    const out: TimetableSession = { sessionId: uuid(s.sessionId), seriesId: nullable(s.seriesId, uuid), name: text(s.name, 500), roomName: nullable(s.roomName, v => text(v, 500)),
      startsAt: instant(s.startsAt), endsAt: instant(s.endsAt), localDate: classSeriesDate(s.localDate), localStart: clock(s.localStart), localEnd: clock(s.localEnd),
      capacity: count(s.capacity, 1), bookingPolicy: oneOf(s.bookingPolicy, CLASS_SERIES_BOOKING_POLICIES), status: oneOf(s.status, ['DRAFT', 'SCHEDULED', 'CANCELLED', 'COMPLETED'] as const),
      booked: count(s.booked, 0) };
    if (out.localDate < weekStart || out.localDate > weekEnd || out.endsAt <= out.startsAt) invalid();
    return out;
  });
  if (new Set(sessions.map(s => s.sessionId)).size !== sessions.length
    || sessions.some((s, n) => n > 0 && (s.startsAt < sessions[n - 1]!.startsAt || (s.startsAt === sessions[n - 1]!.startsAt && s.sessionId <= sessions[n - 1]!.sessionId)))) invalid();
  return { timezone: row.timezone, localToday, weekStart, weekEnd, truncated: row.truncated, sessions };
}
