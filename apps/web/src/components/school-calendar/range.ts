/**
 * School Calendar date maths. Every date is a school-local calendar date (YYYY-MM-DD) handled as a UTC midnight, so no
 * browser zone ever moves a day. Instants become school dates only through `localDateOf` with the zone the server reports.
 */
export const CALENDAR_VIEWS = ['day', 'week', 'month'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];
export const CALENDAR_TABS = ['calendar', 'timetable', 'events'] as const;
export type CalendarTab = (typeof CALENDAR_TABS)[number];
export type DateRange = Readonly<{ start: string; end: string }>;
export type GridDay = Readonly<{ date: string; inMonth: boolean }>;

const at = (date: string) => { const [y, m, d] = date.split('-').map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, d)); };
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(date: string, days: number): string { const d = at(date); d.setUTCDate(d.getUTCDate() + days); return iso(d); }
/** Weeks start on Monday, as in the scheduler David uses today. */
export function weekStart(date: string): string { return addDays(date, -((at(date).getUTCDay() + 6) % 7)); }
export function weekday(date: string): number { return at(date).getUTCDay(); }
function monthStart(date: string): string { return `${date.slice(0, 8)}01`; }
function nextMonthStart(date: string): string { const d = at(monthStart(date)); d.setUTCMonth(d.getUTCMonth() + 1); return iso(d); }

/** The visible days of a view, `end` exclusive. A month view covers the whole Monday-to-Sunday weeks that hold the month. */
export function calendarRange(view: CalendarView, anchor: string): DateRange {
  if (view === 'day') return { start: anchor, end: addDays(anchor, 1) };
  if (view === 'week') { const start = weekStart(anchor); return { start, end: addDays(start, 7) }; }
  const start = weekStart(monthStart(anchor)), last = addDays(nextMonthStart(anchor), -1);
  return { start, end: addDays(weekStart(last), 7) };
}

/** One step back or forward. A month step keeps the day of month where it exists, else the month's last day. */
export function shiftAnchor(view: CalendarView, anchor: string, step: 1 | -1): string {
  if (view === 'day') return addDays(anchor, step);
  if (view === 'week') return addDays(anchor, 7 * step);
  const d = at(monthStart(anchor)); d.setUTCMonth(d.getUTCMonth() + step);
  const target = iso(d), lastDay = Number(addDays(nextMonthStart(target), -1).slice(8));
  return `${target.slice(0, 8)}${String(Math.min(Number(anchor.slice(8)), lastDay)).padStart(2, '0')}`;
}

export function monthGrid(anchor: string): GridDay[][] {
  const { start, end } = calendarRange('month', anchor), month = anchor.slice(0, 7), weeks: GridDay[][] = [];
  let index = 0;
  for (let day = start; day < end; day = addDays(day, 1), index++) {
    if (index % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1]!.push({ date: day, inMonth: day.slice(0, 7) === month });
  }
  return weeks;
}

export function daysOf(range: DateRange): string[] {
  const days: string[] = [];
  for (let day = range.start; day < range.end; day = addDays(day, 1)) days.push(day);
  return days;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** The school-local calendar date of an instant, in the school's zone. */
export function localDateOf(instant: string, timeZone: string): string {
  let f = formatters.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); formatters.set(timeZone, f); }
  const parts = Object.fromEntries(f.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const clocks = new Map<string, Intl.DateTimeFormat>();
/** Minutes after the school's local midnight for an instant (0-1439). */
export function localMinutesOf(instant: string, timeZone: string): number {
  let f = clocks.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); clocks.set(timeZone, f); }
  const parts = Object.fromEntries(f.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export type Span = Readonly<{ start: number; end: number }>;
/**
 * Side-by-side lanes for one day's classes on the hour grid, in input order. Classes that overlap (directly or through a
 * chain) share a cluster and split its width; a class that overlaps nothing takes the full width.
 */
export function layoutLanes(spans: readonly Span[]): Array<{ lane: number; lanes: number }> {
  const order = spans.map((s, i) => ({ ...s, i })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Array<{ lane: number; lanes: number }> = spans.map(() => ({ lane: 0, lanes: 1 }));
  let cluster: number[] = [], laneEnds: number[] = [], clusterEnd = -1;
  const close = () => { for (const i of cluster) out[i]!.lanes = laneEnds.length; cluster = []; laneEnds = []; };
  for (const s of order) {
    if (s.start >= clusterEnd) close();
    let lane = laneEnds.findIndex((end) => end <= s.start);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(s.end); } else laneEnds[lane] = s.end;
    out[s.i]!.lane = lane; cluster.push(s.i); clusterEnd = Math.max(clusterEnd, s.end);
  }
  close();
  return out;
}

/** Whole hours the grid shows: 7 AM to 9 PM, widened to fit every class. */
export function hourBounds(spans: readonly Span[]): { first: number; last: number } {
  let first = 7, last = 21;
  for (const s of spans) { first = Math.min(first, Math.floor(s.start / 60)); last = Math.max(last, Math.ceil(s.end / 60)); }
  return { first, last: Math.min(24, last) };
}

/** URL values are untrusted: only the closed values are kept. */
export function parseCalendarTab(value: unknown): CalendarTab { return typeof value === 'string' && (CALENDAR_TABS as readonly string[]).includes(value) ? value as CalendarTab : 'calendar'; }
export function parseCalendarView(value: unknown): CalendarView { return typeof value === 'string' && (CALENDAR_VIEWS as readonly string[]).includes(value) ? value as CalendarView : 'week'; }
