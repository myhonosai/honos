/**
 * Staff shift schedule (0464). Owner request (David, 2026-11-17): "staff doesn't have scheduler for shifts and hour
 * tracking". Managers (staff.shift.manage) put eligible staff on shifts in a Monday-to-Sunday week; staff with
 * staff.shift.view_own see only their own row. Times are school-local (date + HH:MM) and the database converts them with
 * the school's time zone. The database checks every rule here again. Spec: docs/architecture/STAFF_SHIFTS_AND_TIME_CLOCK.md.
 */
export const STAFF_SHIFT_STATUSES = ['SCHEDULED', 'CANCELLED'] as const;
export type StaffShiftStatus = typeof STAFF_SHIFT_STATUSES[number];
export const STAFF_SHIFT_MIN_MINUTES = 15;
export const STAFF_SHIFT_MAX_MINUTES = 16 * 60;
export const STAFF_SHIFT_WEEK_LIMIT = 500;
export const STAFF_SHIFT_STAFF_LIMIT = 200;
export const STAFF_SHIFT_POSITION_MAX = 40;
export const STAFF_SHIFT_NOTE_MAX = 300;

export interface StaffShift {
  shiftId: string; staffPrincipalId: string; date: string; start: string; end: string; startsAt: string; endsAt: string;
  position: string | null; note: string | null; status: StaffShiftStatus; version: number; updatedAt: string;
}
export interface StaffShiftPerson { principalId: string; displayName: string }
export interface StaffAvailabilityWindow { weekday: number; start: string; end: string }
export interface StaffShiftWeek {
  mode: 'MANAGE' | 'OWN'; weekStart: string; timezone: string;
  staff: StaffShiftPerson[]; shifts: StaffShift[];
  /** Saved weekly availability (0077) of the people shown; only in MANAGE mode, empty when none was saved. */
  availability: { principalId: string; windows: StaffAvailabilityWindow[] }[];
}
export interface SaveStaffShiftInput {
  shiftId: string | null; expectedVersion: number; staffPrincipalId: string; date: string; start: string; end: string;
  position: string | null; note: string | null; status: StaffShiftStatus;
}
export interface StaffShiftReceipt { shift: StaffShift; replayed: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
// eslint-disable-next-line no-control-regex
const UNSAFE = /[<>\u0000-\u001f\u007f​-‏‪-‮⁠-⁯﻿]/;

function invalid(): never { throw new Error('Invalid staff shift data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function optionalText(value: unknown, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value || UNSAFE.test(value)) invalid();
  return value;
}
function version(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 999_999_999) invalid();
  return value;
}

/** A real calendar date (YYYY-MM-DD, 2000-2099). */
export function isStaffShiftDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}
/** Monday of an ISO week. */
export function isStaffShiftWeekStart(value: unknown): value is string {
  if (!isStaffShiftDate(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 1;
}
export function minutesOfDay(time: string): number { return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)); }
/** Length of a same-day shift in minutes, or null when the times are not a valid start/end pair. */
export function staffShiftMinutes(start: unknown, end: unknown): number | null {
  if (typeof start !== 'string' || typeof end !== 'string' || !TIME.test(start) || !END_TIME.test(end)) return null;
  const length = minutesOfDay(end) - minutesOfDay(start);
  return length >= STAFF_SHIFT_MIN_MINUTES && length <= STAFF_SHIFT_MAX_MINUTES ? length : null;
}

export function validateSaveStaffShiftInput(value: unknown): SaveStaffShiftInput {
  const row = record(value, ['date', 'end', 'expectedVersion', 'note', 'position', 'shiftId', 'staffPrincipalId', 'start', 'status']);
  const shiftId = row.shiftId === null ? null : uuid(row.shiftId);
  const expectedVersion = version(row.expectedVersion, 0);
  if (!(STAFF_SHIFT_STATUSES as readonly unknown[]).includes(row.status)) invalid();
  const status = row.status as StaffShiftStatus;
  // A new shift starts at version 0 and is scheduled; an existing shift names its current version.
  if (shiftId === null ? expectedVersion !== 0 || status !== 'SCHEDULED' : expectedVersion < 1) invalid();
  if (!isStaffShiftDate(row.date) || staffShiftMinutes(row.start, row.end) === null) invalid();
  return Object.freeze({
    shiftId, expectedVersion, staffPrincipalId: uuid(row.staffPrincipalId), date: row.date, start: row.start as string, end: row.end as string,
    position: optionalText(row.position, STAFF_SHIFT_POSITION_MAX), note: optionalText(row.note, STAFF_SHIFT_NOTE_MAX), status,
  });
}

export function verifyStaffShift(value: unknown): StaffShift {
  const row = record(value, ['date', 'end', 'endsAt', 'note', 'position', 'shiftId', 'staffPrincipalId', 'start', 'startsAt', 'status', 'updatedAt', 'version']);
  if (!isStaffShiftDate(row.date) || staffShiftMinutes(row.start, row.end) === null) invalid();
  for (const k of ['startsAt', 'endsAt', 'updatedAt'] as const) if (typeof row[k] !== 'string' || !INSTANT.test(row[k] as string)) invalid();
  const startsAt = Date.parse(row.startsAt as string), endsAt = Date.parse(row.endsAt as string);
  if (!(endsAt > startsAt) || endsAt - startsAt > STAFF_SHIFT_MAX_MINUTES * 60_000 + 3_600_000) invalid();
  if (!(STAFF_SHIFT_STATUSES as readonly unknown[]).includes(row.status)) invalid();
  return Object.freeze({
    shiftId: uuid(row.shiftId), staffPrincipalId: uuid(row.staffPrincipalId), date: row.date, start: row.start as string, end: row.end as string,
    startsAt: row.startsAt as string, endsAt: row.endsAt as string, position: optionalText(row.position, STAFF_SHIFT_POSITION_MAX),
    note: optionalText(row.note, STAFF_SHIFT_NOTE_MAX), status: row.status as StaffShiftStatus, version: version(row.version, 1), updatedAt: row.updatedAt as string,
  });
}

function verifyWindows(value: unknown): StaffAvailabilityWindow[] {
  if (!Array.isArray(value) || value.length > 28) invalid();
  return value.map(item => {
    const w = record(item, ['end', 'start', 'weekday']);
    if (typeof w.weekday !== 'number' || !Number.isInteger(w.weekday) || w.weekday < 1 || w.weekday > 7) invalid();
    if (typeof w.start !== 'string' || !TIME.test(w.start) || typeof w.end !== 'string' || !END_TIME.test(w.end) || minutesOfDay(w.end) <= minutesOfDay(w.start)) invalid();
    return Object.freeze({ weekday: w.weekday, start: w.start, end: w.end });
  });
}

/** A week read. `expected` pins the week asked for. Every shift must belong to a listed person and fall in the week. */
export function verifyStaffShiftWeek(value: unknown, expected?: { weekStart: string }): StaffShiftWeek {
  const row = record(value, ['availability', 'mode', 'shifts', 'staff', 'timezone', 'weekStart']);
  if (row.mode !== 'MANAGE' && row.mode !== 'OWN') invalid();
  if (!isStaffShiftWeekStart(row.weekStart) || (expected && row.weekStart !== expected.weekStart)) invalid();
  if (typeof row.timezone !== 'string' || !ZONE.test(row.timezone)) invalid();
  if (!Array.isArray(row.staff) || row.staff.length > STAFF_SHIFT_STAFF_LIMIT || (row.mode === 'OWN' && row.staff.length !== 1)) invalid();
  const seen = new Set<string>();
  const staff = row.staff.map(item => {
    const p = record(item, ['displayName', 'principalId']);
    const principalId = uuid(p.principalId);
    if (seen.has(principalId) || typeof p.displayName !== 'string' || !p.displayName.trim() || p.displayName.length > 120) invalid();
    seen.add(principalId);
    return Object.freeze({ principalId, displayName: p.displayName });
  });
  if (!Array.isArray(row.shifts) || row.shifts.length > STAFF_SHIFT_WEEK_LIMIT) invalid();
  const [y, m, d] = (row.weekStart as string).split('-').map(Number) as [number, number, number];
  const weekEnd = new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  const ids = new Set<string>();
  const shifts = row.shifts.map(item => {
    const s = verifyStaffShift(item);
    if (ids.has(s.shiftId) || !seen.has(s.staffPrincipalId) || s.date < (row.weekStart as string) || s.date >= weekEnd) invalid();
    ids.add(s.shiftId);
    return s;
  });
  if (!Array.isArray(row.availability) || (row.mode === 'OWN' && row.availability.length)) invalid();
  const availability = row.availability.map(item => {
    const a = record(item, ['principalId', 'windows']);
    const principalId = uuid(a.principalId);
    if (!seen.has(principalId)) invalid();
    return Object.freeze({ principalId, windows: verifyWindows(a.windows) });
  });
  return Object.freeze({ mode: row.mode, weekStart: row.weekStart as string, timezone: row.timezone, staff, shifts, availability });
}

/** A save receipt. `expected` pins the version the save must produce. */
export function verifyStaffShiftReceipt(value: unknown, expected?: { version: number; staffPrincipalId: string }): StaffShiftReceipt {
  const row = record(value, ['replayed', 'shift']);
  if (typeof row.replayed !== 'boolean') invalid();
  const shift = verifyStaffShift(row.shift);
  if (expected && (shift.version !== expected.version || shift.staffPrincipalId !== expected.staffPrincipalId.toLowerCase())) invalid();
  return Object.freeze({ shift, replayed: row.replayed });
}

/** Whether a shift sits inside one of the person's saved weekly windows (ISO weekday 1 = Monday). No windows saved = true. */
export function shiftWithinAvailability(shift: Pick<StaffShift, 'date' | 'start' | 'end'>, windows: readonly StaffAvailabilityWindow[] | undefined): boolean {
  if (!windows || windows.length === 0) return true;
  const [y, m, d] = shift.date.split('-').map(Number) as [number, number, number];
  const weekday = ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
  const start = minutesOfDay(shift.start), end = minutesOfDay(shift.end);
  return windows.some(w => w.weekday === weekday && minutesOfDay(w.start) <= start && minutesOfDay(w.end) >= end);
}
