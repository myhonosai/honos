/**
 * Weekly attendance streaks (0602). For each ACTIVE child of the signed-in family: the number of consecutive weeks (Monday to
 * Sunday in the school's time zone) with at least one attended class, ending this week or last week, at most 104. Shown as
 * the flame count on the HON Family app's Home screen. Name and number only: no dates, sessions, statuses or identifiers.
 */
export const PARENT_ATTENDANCE_STREAK_LIMITS = { children: 20, weeks: 104, name: 400 } as const;

export interface ParentAttendanceStreak { name: string; weeks: number }
export interface ParentAttendanceStreaks { children: ParentAttendanceStreak[] }

function invalid(): never { throw new Error('Invalid attendance streak data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function streak(value: unknown): ParentAttendanceStreak {
  const row = record(value, ['name', 'weeks']);
  const { name, weeks } = row;
  if (typeof name !== 'string' || !name.trim() || [...name].length > PARENT_ATTENDANCE_STREAK_LIMITS.name || /[\u0000-\u001f\u007f]/.test(name)) invalid();
  if (typeof weeks !== 'number' || !Number.isInteger(weeks) || weeks < 0 || weeks > PARENT_ATTENDANCE_STREAK_LIMITS.weeks) invalid();
  return { name, weeks };
}
export function verifyParentAttendanceStreaks(value: unknown): ParentAttendanceStreaks {
  const row = record(value, ['children']);
  if (!Array.isArray(row.children) || row.children.length > PARENT_ATTENDANCE_STREAK_LIMITS.children) invalid();
  return { children: row.children.map(streak) };
}
