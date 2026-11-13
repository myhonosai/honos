/**
 * Campaign windows are UTC calendar days by contract: a start day begins at 00:00:00.000Z and a last day is
 * inclusive, so the stored exclusive end is the following midnight. Staff pick days, never type instants.
 */
const DAY = /^(20\d{2})-(\d{2})-(\d{2})$/;
const MS_DAY = 86_400_000;

function dayMs(date: string): number | null {
  const m = DAY.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === date ? ms : null;
}

/** The UTC instant a start day begins, or '' when the day is not a real calendar day. */
export function campaignStartFromDay(date: string): string {
  const ms = dayMs(date);
  return ms === null ? '' : new Date(ms).toISOString();
}

/** The exclusive end instant for an inclusive last day, or '' when the day is not a real calendar day. */
export function campaignEndFromLastDay(date: string): string {
  const ms = dayMs(date);
  return ms === null ? '' : new Date(ms + MS_DAY).toISOString();
}

/** The UTC day an instant falls on, for showing a saved start. */
export function dayOfInstant(instant: string): string {
  const ms = Date.parse(instant);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

/** The inclusive last UTC day of an exclusive end instant. */
export function lastDayOfEnd(instant: string): string {
  const ms = Date.parse(instant);
  return Number.isFinite(ms) ? new Date(ms - 1).toISOString().slice(0, 10) : '';
}

/** A cohort end for an inclusive last day that is never in the future: the following midnight, or now if that is later than now. */
export function cohortEndFromLastDay(date: string, now: number): string {
  const ms = dayMs(date);
  if (ms === null) return '';
  return new Date(Math.min(ms + MS_DAY, now)).toISOString();
}

/** A plain-language reason the planned window cannot be saved, or null when the window is usable. */
export function campaignWindowProblem(startsAt: string, endsAt: string): string | null {
  if (!startsAt || !endsAt) return 'Choose a start day and a last day.';
  const days = (Date.parse(endsAt) - Date.parse(startsAt)) / MS_DAY;
  if (days < 1) return 'The last day must be on or after the start day.';
  if (days > 366) return 'A campaign can run at most 366 days.';
  return null;
}
