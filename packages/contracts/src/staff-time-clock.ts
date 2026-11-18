/**
 * Staff time clock and timesheets (0478). Owner request (David, 2026-11-17): "staff doesn't have scheduler for shifts and
 * hour tracking". Owner decisions (2026-11-17): staff clock in and out from their own signed-in phone or computer, and
 * timesheets are hours only (no breaks, no overtime rules). Staff with staff.time.clock clock in and out at the server's
 * clock; managers with staff.timesheet.manage review a week, fix entries with a reason, approve or reopen a person's week,
 * and export CSV. HON never calculates pay. Spec: docs/architecture/STAFF_SHIFTS_AND_TIME_CLOCK.md.
 */
import { isStaffShiftWeekStart, verifyStaffShift, type StaffShift } from './staff-shifts.js';

export const TIME_CLOCK_ACTIONS = ['CLOCK_IN', 'CLOCK_OUT'] as const;
export type TimeClockAction = typeof TIME_CLOCK_ACTIONS[number];
export const TIME_ENTRY_ORIGINS = ['CLOCK', 'MANAGER'] as const;
export type TimeEntryOrigin = typeof TIME_ENTRY_ORIGINS[number];
export const TIME_ENTRY_MAX_MINUTES = 24 * 60;
export const TIME_ENTRY_WEEK_LIMIT = 1000;
export const TIME_REASON_MIN = 3;
export const TIME_REASON_MAX = 300;
/** An entry this long usually means a missed clock-out (a data check, not an overtime rule). */
export const LONG_ENTRY_MINUTES = 16 * 60;

export interface TimeEntry {
  entryId: string; staffPrincipalId: string; localDate: string; clockInAt: string; clockOutAt: string | null;
  origin: TimeEntryOrigin; version: number; workedMinutes: number | null; updatedAt: string;
}
export interface WeekApproval { status: 'APPROVED' | 'OPEN'; version: number; decidedAt: string }
export interface MyTimeClock {
  timezone: string; now: string; weekStart: string; open: TimeEntry | null; todayShifts: StaffShift[]; entries: TimeEntry[]; approval: WeekApproval | null;
}
export interface TimesheetPerson {
  principalId: string; displayName: string; scheduledMinutes: number; approval: WeekApproval | null; entries: TimeEntry[];
}
export interface TimesheetWeek { weekStart: string; timezone: string; people: TimesheetPerson[] }
export interface TimeClockPunchInput { action: TimeClockAction; expectedVersion: number }
/** School-local date and time, YYYY-MM-DDTHH:MM. */
export type LocalDateTime = string;
export interface SaveTimeEntryInput {
  entryId: string | null; expectedVersion: number; staffPrincipalId: string; clockIn: LocalDateTime; clockOut: LocalDateTime; reason: string;
}
export interface TimesheetDecisionInput { staffPrincipalId: string; weekStart: string; action: 'APPROVE' | 'REOPEN'; expectedVersion: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOCAL = /^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
// eslint-disable-next-line no-control-regex
const UNSAFE = /[<>\u0000-\u001f\u007f​-‏‪-‮⁠-⁯﻿]/;

function invalid(): never { throw new Error('Invalid staff time data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value))) invalid(); return value; }
function count(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid();
  return value;
}
function realDate(value: string): boolean {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}
export function isLocalDateTime(value: unknown): value is LocalDateTime { return typeof value === 'string' && LOCAL.test(value) && realDate(value); }
/** Minutes between two school-local times as wall-clock minutes (the database measures real minutes in the zone). */
export function localMinutesBetween(a: LocalDateTime, b: LocalDateTime): number {
  const t = (v: string) => Date.UTC(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, Number(v.slice(8, 10)), Number(v.slice(11, 13)), Number(v.slice(14, 16)));
  return (t(b) - t(a)) / 60_000;
}

export function validateTimeClockPunch(value: unknown): TimeClockPunchInput {
  const row = record(value, ['action', 'expectedVersion']);
  if (!(TIME_CLOCK_ACTIONS as readonly unknown[]).includes(row.action)) invalid();
  const expectedVersion = count(row.expectedVersion, 0, 999_999_999);
  if ((row.action === 'CLOCK_IN') !== (expectedVersion === 0)) invalid();
  return Object.freeze({ action: row.action as TimeClockAction, expectedVersion });
}

export function validateSaveTimeEntry(value: unknown): SaveTimeEntryInput {
  const row = record(value, ['clockIn', 'clockOut', 'entryId', 'expectedVersion', 'reason', 'staffPrincipalId']);
  const entryId = row.entryId === null ? null : uuid(row.entryId);
  const expectedVersion = count(row.expectedVersion, 0, 999_999_999);
  if ((entryId === null) !== (expectedVersion === 0)) invalid();
  if (!isLocalDateTime(row.clockIn) || !isLocalDateTime(row.clockOut)) invalid();
  const length = localMinutesBetween(row.clockIn, row.clockOut);
  if (length < 1 || length > TIME_ENTRY_MAX_MINUTES) invalid();
  if (typeof row.reason !== 'string' || row.reason.length < TIME_REASON_MIN || row.reason.length > TIME_REASON_MAX || row.reason.trim() !== row.reason || UNSAFE.test(row.reason)) invalid();
  return Object.freeze({ entryId, expectedVersion, staffPrincipalId: uuid(row.staffPrincipalId), clockIn: row.clockIn, clockOut: row.clockOut, reason: row.reason });
}

export function validateTimesheetDecision(value: unknown): TimesheetDecisionInput {
  const row = record(value, ['action', 'expectedVersion', 'staffPrincipalId', 'weekStart']);
  if (row.action !== 'APPROVE' && row.action !== 'REOPEN') invalid();
  if (!isStaffShiftWeekStart(row.weekStart)) invalid();
  const expectedVersion = count(row.expectedVersion, 0, 999_999_999);
  if (row.action === 'REOPEN' && expectedVersion < 1) invalid();
  return Object.freeze({ staffPrincipalId: uuid(row.staffPrincipalId), weekStart: row.weekStart, action: row.action, expectedVersion });
}

export function verifyTimeEntry(value: unknown): TimeEntry {
  const row = record(value, ['clockInAt', 'clockOutAt', 'entryId', 'localDate', 'origin', 'staffPrincipalId', 'updatedAt', 'version', 'workedMinutes']);
  const clockInAt = instant(row.clockInAt), clockOutAt = row.clockOutAt === null ? null : instant(row.clockOutAt);
  if (clockOutAt !== null && !(Date.parse(clockOutAt) > Date.parse(clockInAt))) invalid();
  if (typeof row.localDate !== 'string' || !DATE.test(row.localDate) || !realDate(row.localDate)) invalid();
  if (!(TIME_ENTRY_ORIGINS as readonly unknown[]).includes(row.origin)) invalid();
  const workedMinutes = row.workedMinutes === null ? null : count(row.workedMinutes, 0, TIME_ENTRY_MAX_MINUTES);
  if ((workedMinutes === null) !== (clockOutAt === null)) invalid();
  return Object.freeze({
    entryId: uuid(row.entryId), staffPrincipalId: uuid(row.staffPrincipalId), localDate: row.localDate, clockInAt, clockOutAt,
    origin: row.origin as TimeEntryOrigin, version: count(row.version, 1, 999_999_999), workedMinutes, updatedAt: instant(row.updatedAt),
  });
}
function verifyApproval(value: unknown): WeekApproval | null {
  if (value === null) return null;
  const row = record(value, ['decidedAt', 'status', 'version']);
  if (row.status !== 'APPROVED' && row.status !== 'OPEN') invalid();
  return Object.freeze({ status: row.status, version: count(row.version, 1, 999_999_999), decidedAt: instant(row.decidedAt) });
}
function weekEnd(weekStart: string): string {
  const [y, m, d] = weekStart.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
}
function entriesOfWeek(value: unknown, weekStart: string, principal: string | null): TimeEntry[] {
  if (!Array.isArray(value) || value.length > TIME_ENTRY_WEEK_LIMIT) invalid();
  const end = weekEnd(weekStart), ids = new Set<string>();
  return value.map(item => {
    const e = verifyTimeEntry(item);
    if (ids.has(e.entryId) || e.localDate < weekStart || e.localDate >= end || (principal !== null && e.staffPrincipalId !== principal)) invalid();
    ids.add(e.entryId);
    return e;
  });
}

export function verifyMyTimeClock(value: unknown): MyTimeClock {
  const row = record(value, ['approval', 'entries', 'now', 'open', 'timezone', 'todayShifts', 'weekStart']);
  if (typeof row.timezone !== 'string' || !ZONE.test(row.timezone) || !isStaffShiftWeekStart(row.weekStart)) invalid();
  const open = row.open === null ? null : verifyTimeEntry(row.open);
  if (open && open.clockOutAt !== null) invalid();
  if (!Array.isArray(row.todayShifts) || row.todayShifts.length > 10) invalid();
  const entries = entriesOfWeek(row.entries, row.weekStart as string, null);
  if (new Set(entries.map(e => e.staffPrincipalId)).size > 1 || (open && entries.length && entries[0]!.staffPrincipalId !== open.staffPrincipalId)) invalid();
  return Object.freeze({ timezone: row.timezone, now: instant(row.now), weekStart: row.weekStart as string, open,
    todayShifts: row.todayShifts.map(verifyStaffShift), entries, approval: verifyApproval(row.approval) });
}

export function verifyTimesheetWeek(value: unknown, expected?: { weekStart: string }): TimesheetWeek {
  const row = record(value, ['people', 'timezone', 'weekStart']);
  if (!isStaffShiftWeekStart(row.weekStart) || (expected && row.weekStart !== expected.weekStart)) invalid();
  if (typeof row.timezone !== 'string' || !ZONE.test(row.timezone)) invalid();
  if (!Array.isArray(row.people) || row.people.length > 200) invalid();
  const seen = new Set<string>();
  const people = row.people.map(item => {
    const p = record(item, ['approval', 'displayName', 'entries', 'principalId', 'scheduledMinutes']);
    const principalId = uuid(p.principalId);
    if (seen.has(principalId) || typeof p.displayName !== 'string' || !p.displayName.trim() || p.displayName.length > 120) invalid();
    seen.add(principalId);
    return Object.freeze({ principalId, displayName: p.displayName, scheduledMinutes: count(p.scheduledMinutes, 0, 7 * 24 * 60 * 3),
      approval: verifyApproval(p.approval), entries: entriesOfWeek(p.entries, row.weekStart as string, principalId) });
  });
  return Object.freeze({ weekStart: row.weekStart as string, timezone: row.timezone, people });
}

export type TimesheetFlag = 'STILL_CLOCKED_IN' | 'LONG_ENTRY';
export interface TimesheetSummary {
  workedMinutes: number;
  days: { date: string; workedMinutes: number }[];
  flags: TimesheetFlag[];
}
/**
 * One person's week: worked minutes per school-local day (the day the entry started), the week total, and data checks
 * (still clocked in; an entry over 16 h, usually a missed clock-out). Hours only: no breaks, no overtime rules, no pay.
 */
export function summarizeTimesheet(entries: readonly TimeEntry[]): TimesheetSummary {
  const byDay = new Map<string, number>();
  let worked = 0, open = false, long = false;
  for (const e of entries) {
    if (e.workedMinutes === null) { open = true; continue; }
    worked += e.workedMinutes;
    byDay.set(e.localDate, (byDay.get(e.localDate) ?? 0) + e.workedMinutes);
    if (e.workedMinutes > LONG_ENTRY_MINUTES) long = true;
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, minutes]) => ({ date, workedMinutes: minutes }));
  const flags: TimesheetFlag[] = [];
  if (open) flags.push('STILL_CLOCKED_IN');
  if (long) flags.push('LONG_ENTRY');
  return { workedMinutes: worked, days, flags };
}

/** A spreadsheet cell: quoted, and a leading = + - @ (or tab/return) is prefixed with ' so it never runs as a formula. */
export function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export interface TimeEntryReceipt { entry: TimeEntry; replayed: boolean }
/** A punch or fix returns the next version of the entry; a CLOCK_OUT or manager fix is closed, a CLOCK_IN is open. */
export function verifyTimeEntryReceipt(value: unknown, expected: { version: number; closed: boolean; entryId?: string | null; staffPrincipalId?: string }): TimeEntryReceipt {
  const row = record(value, ['entry', 'replayed']);
  if (typeof row.replayed !== 'boolean') invalid();
  const entry = verifyTimeEntry(row.entry);
  if (entry.version !== expected.version || (entry.clockOutAt !== null) !== expected.closed) invalid();
  if (expected.entryId && entry.entryId !== expected.entryId.toLowerCase()) invalid();
  if (expected.staffPrincipalId && entry.staffPrincipalId !== expected.staffPrincipalId.toLowerCase()) invalid();
  return Object.freeze({ entry, replayed: row.replayed });
}
export interface TimesheetDecisionReceipt { approval: WeekApproval; replayed: boolean }
export function verifyTimesheetDecisionReceipt(value: unknown, input: TimesheetDecisionInput): TimesheetDecisionReceipt {
  const row = record(value, ['approval', 'replayed']);
  if (typeof row.replayed !== 'boolean') invalid();
  const approval = verifyApproval(row.approval);
  if (!approval || approval.version !== input.expectedVersion + 1 || approval.status !== (input.action === 'APPROVE' ? 'APPROVED' : 'OPEN')) invalid();
  return Object.freeze({ approval, replayed: row.replayed });
}
