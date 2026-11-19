import { STAFF_SHIFT_NOTE_MAX, STAFF_SHIFT_POSITION_MAX, isStaffShiftDate, staffShiftMinutes, type SaveStaffShiftInput, type StaffShift } from '@hon/contracts';
import type { ShiftCopy } from './copy';

/** The add/change form, in memory only. Strings as typed; the server checks everything again. */
export type ShiftDraft = Readonly<{
  shiftId: string | null; expectedVersion: number; staffPrincipalId: string; date: string; start: string; end: string; position: string; note: string;
}>;
export type ShiftField = 'staffPrincipalId' | 'date' | 'start' | 'end' | 'position' | 'note';

export function newDraft(staffPrincipalId: string, date: string): ShiftDraft {
  return { shiftId: null, expectedVersion: 0, staffPrincipalId, date, start: '09:00', end: '13:00', position: '', note: '' };
}
export function draftOf(shift: StaffShift): ShiftDraft {
  return { shiftId: shift.shiftId, expectedVersion: shift.version, staffPrincipalId: shift.staffPrincipalId, date: shift.date, start: shift.start, end: shift.end,
    position: shift.position ?? '', note: shift.note ?? '' };
}
const UNSAFE = /[<>]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
export function draftProblems(d: ShiftDraft, c: ShiftCopy): string[] {
  const out: string[] = [];
  if (!d.staffPrincipalId) out.push(c.problems.person);
  if (!isStaffShiftDate(d.date)) out.push(c.problems.date);
  if (staffShiftMinutes(d.start, d.end) === null) out.push(c.problems.times);
  const position = d.position.trim(), note = d.note.trim();
  if (position.length > STAFF_SHIFT_POSITION_MAX || UNSAFE.test(position) || CONTROL.test(position)) out.push(c.problems.position);
  if (note.length > STAFF_SHIFT_NOTE_MAX || UNSAFE.test(note) || CONTROL.test(note)) out.push(c.problems.note);
  return out;
}
/** The exact save body for the draft, or the cancel body for an existing shift. */
export function saveInput(d: ShiftDraft, cancel = false): SaveStaffShiftInput {
  const position = d.position.trim(), note = d.note.trim();
  return { shiftId: d.shiftId, expectedVersion: d.expectedVersion, staffPrincipalId: d.staffPrincipalId, date: d.date, start: d.start, end: d.end,
    position: position || null, note: note || null, status: cancel ? 'CANCELLED' : 'SCHEDULED' };
}
