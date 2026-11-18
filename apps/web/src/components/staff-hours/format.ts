import {
  TIME_REASON_MAX, TIME_REASON_MIN, csvCell, isLocalDateTime, localMinutesBetween, summarizeTimesheet,
  type SaveTimeEntryInput, type TimeEntry, type TimesheetWeek,
} from '@hon/contracts';
import type { HoursCopy } from './copy';

/** School-local YYYY-MM-DDTHH:MM of an instant (the value a datetime-local input holds). */
export function localDateTime(instant: string, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(instant)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
/** A school-local clock time for people to read. */
export function timeOf(instant: string, timeZone: string, language: string): string {
  try { return new Date(instant).toLocaleTimeString(language, { timeZone, hour: 'numeric', minute: '2-digit' }); } catch { return localDateTime(instant, timeZone).slice(11); }
}

/** The add/fix form, in memory only. Strings as typed; the server checks everything again. */
export type EntryDraft = Readonly<{
  entryId: string | null; expectedVersion: number; staffPrincipalId: string; clockIn: string; clockOut: string; reason: string;
}>;
export type EntryField = 'staffPrincipalId' | 'clockIn' | 'clockOut' | 'reason';
export function newEntryDraft(staffPrincipalId: string, date: string): EntryDraft {
  return { entryId: null, expectedVersion: 0, staffPrincipalId, clockIn: `${date}T09:00`, clockOut: `${date}T17:00`, reason: '' };
}
/** Fixing an open entry proposes a clock-out at its clock-in, which the manager then sets. */
export function entryDraftOf(entry: TimeEntry, timeZone: string): EntryDraft {
  const clockIn = localDateTime(entry.clockInAt, timeZone);
  return { entryId: entry.entryId, expectedVersion: entry.version, staffPrincipalId: entry.staffPrincipalId, clockIn,
    clockOut: entry.clockOutAt ? localDateTime(entry.clockOutAt, timeZone) : clockIn, reason: '' };
}
const UNSAFE = /[<>]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
export function entryProblems(d: EntryDraft, c: HoursCopy): string[] {
  const out: string[] = [];
  if (!d.staffPrincipalId) out.push(c.problems.person);
  if (!isLocalDateTime(d.clockIn) || !isLocalDateTime(d.clockOut) || localMinutesBetween(d.clockIn, d.clockOut) < 1 || localMinutesBetween(d.clockIn, d.clockOut) > 24 * 60) out.push(c.problems.times);
  const reason = d.reason.trim();
  if (reason.length < TIME_REASON_MIN || reason.length > TIME_REASON_MAX || UNSAFE.test(reason) || CONTROL.test(reason)) out.push(c.problems.reason);
  return out;
}
export function entryInput(d: EntryDraft): SaveTimeEntryInput {
  return { entryId: d.entryId, expectedVersion: d.expectedVersion, staffPrincipalId: d.staffPrincipalId, clockIn: d.clockIn, clockOut: d.clockOut,
    reason: d.reason.trim() };
}

const hours = (minutes: number) => (Math.round(minutes / 6) / 10).toFixed(1);
/** The shown week as CSV, built in the browser from the same verified read: one line per entry and a total line per person. Hours only. */
export function timesheetCsv(week: TimesheetWeek, c: HoursCopy): string {
  const rows: (string | number | null)[][] = [c.csv.header];
  for (const person of week.people) {
    for (const e of person.entries) {
      rows.push([person.displayName, e.localDate, localDateTime(e.clockInAt, week.timezone).slice(11), e.clockOutAt ? localDateTime(e.clockOutAt, week.timezone).slice(11) : null,
        e.workedMinutes === null ? null : hours(e.workedMinutes), null, e.origin === 'MANAGER' ? c.csv.manager : c.csv.clock]);
    }
    const s = summarizeTimesheet(person.entries);
    rows.push([person.displayName, c.csv.total, null, null, hours(s.workedMinutes), hours(person.scheduledMinutes),
      [person.approval?.status === 'APPROVED' ? c.approvedTag : null, ...s.flags.map(f => c.flags[f])].filter(Boolean).join('; ')]);
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
