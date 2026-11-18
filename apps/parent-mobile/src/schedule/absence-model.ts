/**
 * Planned absence (parent request) helpers. A request is a reviewable record for the school, not an attendance change.
 * Days are whole calendar days in the school's time zone (or the phone's when the school zone is unknown).
 */

/** Minutes east of UTC for `timeZone` at `instant`, from Intl (no time zone library). */
export function zoneOffsetMinutes(timeZone: string | null, instant: Date): number {
  if (!timeZone) return -instant.getTimezoneOffset();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(instant);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** The calendar date (YYYY-MM-DD) of `instant` in `timeZone`. */
export function localDate(timeZone: string | null, instant: Date): string {
  const shifted = new Date(instant.getTime() + zoneOffsetMinutes(timeZone, instant) * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** UTC instant of local midnight starting `date` in `timeZone` (two passes handle DST changes). */
export function localMidnight(timeZone: string | null, date: string): Date {
  const naive = Date.parse(`${date}T00:00:00.000Z`);
  let guess = naive - zoneOffsetMinutes(timeZone, new Date(naive)) * 60_000;
  guess = naive - zoneOffsetMinutes(timeZone, new Date(guess)) * 60_000;
  return new Date(guess);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The next `count` calendar days starting today, as YYYY-MM-DD in the school's zone. */
export function upcomingDays(timeZone: string | null, now: Date, count = 14): string[] {
  const today = localDate(timeZone, now);
  return Array.from({ length: count }, (_, i) => addDays(today, i));
}

/**
 * The request window for one whole local day. Today starts one minute from now, because HON only accepts
 * requests that start in the future. Returns null when the day is already over.
 */
export function absenceWindow(timeZone: string | null, date: string, now: Date): { startsAt: string; endsAt: string } | null {
  const start = localMidnight(timeZone, date).getTime();
  const end = localMidnight(timeZone, addDays(date, 1)).getTime();
  const earliest = Math.ceil((now.getTime() + 60_000) / 60_000) * 60_000;
  const from = Math.max(start, earliest);
  if (from >= end) return null;
  return { startsAt: new Date(from).toISOString(), endsAt: new Date(end).toISOString() };
}

export function dayLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

export const ABSENCE_REFUSALS: Record<string, string> = {
  VALIDATION_FAILED: 'HON could not accept that day. Absences must be in the next 90 days and not already over.',
  PARENT_ABSENCE_CHILD_UNAVAILABLE: 'That child is no longer on your family account at this school.',
  PARENT_ABSENCE_GUARDIAN_REQUIRED: 'Only a parent or guardian on the account can report an absence.',
  PARENT_ABSENCE_SCOPE_DENIED: 'Your family access does not allow reporting absences.',
  PARENT_ABSENCE_SCOPE_CHANGED: 'Your family access changed. Please try again.',
  PARENT_ABSENCE_SCOPE_AMBIGUOUS: 'Your account is linked to more than one family. Choose your family on the HON parent website, then try again.',
  IDEMPOTENCY_KEY_REUSED: 'This request could not be matched to the earlier one. Please start again.',
};
