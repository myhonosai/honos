import type { CurrentSchoolClassSession, SchoolEvent } from '@hon/contracts';
import { RosterError, type Owned, type RosterApi, type RosterScope } from '../class-roster/http';
import { daysOf, localDateOf, type DateRange } from './range';

/**
 * School Calendar reads. Classes come from the existing forward-paging session list (0221, schedule.session.read) from the
 * first visible school-local day, page by page, until a class starts after the last visible day. Nothing here writes.
 */
export const CALENDAR_MAX_PAGES = 10;
export type CalendarClasses = Readonly<{ items: readonly CurrentSchoolClassSession[]; truncated: boolean; timezone: string; localToday: string }>;

class Moved extends Error {}

async function readOnce(api: Pick<RosterApi, 'sessions'>, scope: RosterScope, range: DateRange, signal: AbortSignal, owned: Owned): Promise<CalendarClasses> {
  const items: CurrentSchoolClassSession[] = [], seen = new Set<string>();
  let cursor: string | null = null, timezone: string | null = null, localToday = '';
  for (let page = 0; page < CALENDAR_MAX_PAGES; page++) {
    let read;
    try { read = await api.sessions(scope, range.start, cursor, signal, owned); }
    catch (error) { if (page > 0 && error instanceof RosterError && error.kind === 'CURSOR') throw new Moved(); throw error; }
    if (timezone !== null && read.schoolTimezone !== timezone) throw new Moved();
    if (timezone === null) { timezone = read.schoolTimezone; localToday = read.localToday; }
    for (const session of read.items) {
      const last = items[items.length - 1];
      // A repeated class or one before the last one shown means the list moved under the cursor.
      if (seen.has(session.sessionId) || (last && Date.parse(session.startsAt) < Date.parse(last.startsAt))) throw new Moved();
      if (localDateOf(session.startsAt, timezone) >= range.end) return { items, truncated: false, timezone, localToday };
      seen.add(session.sessionId); items.push(session);
    }
    if (read.nextCursor === null) return { items, truncated: false, timezone, localToday };
    cursor = read.nextCursor;
  }
  return { items, truncated: true, timezone: timezone ?? 'UTC', localToday };
}

/** The classes in the visible days. A list that moves while it is read is read again from the start once; then it is unavailable. */
export async function loadCalendarClasses(api: Pick<RosterApi, 'sessions'>, scope: RosterScope, range: DateRange, signal: AbortSignal, owned: Owned): Promise<CalendarClasses> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await readOnce(api, scope, range, signal, owned); }
    catch (error) { if (!(error instanceof Moved)) throw error; }
  }
  throw new RosterError('UNAVAILABLE');
}

export type CalendarEvent = Pick<SchoolEvent, 'eventId' | 'title' | 'localDate' | 'opensAt' | 'status'> & Partial<SchoolEvent>;
export type CalendarItem = Readonly<{ kind: 'class'; session: CurrentSchoolClassSession }> | Readonly<{ kind: 'event'; event: CalendarEvent }>;

/** Every visible day, each with its events (by opening time) first and then its classes in start order. */
export function groupByDay(sessions: readonly CurrentSchoolClassSession[], events: readonly CalendarEvent[], timezone: string, range: DateRange): Map<string, CalendarItem[]> {
  const days = new Map<string, CalendarItem[]>(daysOf(range).map((d) => [d, []]));
  for (const event of [...events].sort((a, b) => a.opensAt.localeCompare(b.opensAt))) days.get(event.localDate)?.push({ kind: 'event', event });
  for (const session of [...sessions].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))) days.get(localDateOf(session.startsAt, timezone))?.push({ kind: 'class', session });
  return days;
}
