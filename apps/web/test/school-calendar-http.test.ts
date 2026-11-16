import { expect, it, vi } from 'vitest';
import type { CurrentSchoolClassSession } from '@hon/contracts';
import { RosterError, type RosterApi, type SessionPage } from '../src/components/class-roster/http';
import { CALENDAR_MAX_PAGES, groupByDay, loadCalendarClasses } from '../src/components/school-calendar/http';
import { id, scope } from './account-status-fixtures';

const s = (n: number, startsAt: string, over: Partial<CurrentSchoolClassSession> = {}): CurrentSchoolClassSession => ({ sessionId: id(300 + n), name: `Class ${n}`, startsAt,
  endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(), roomName: null, capacity: 10, bookingPolicy: 'OPTIONAL_BOOKING', status: 'SCHEDULED',
  createdAt: '2026-10-01T00:00:00.000Z', ...over } as CurrentSchoolClassSession);
const pageOf = (items: CurrentSchoolClassSession[], nextCursor: string | null, over: Partial<SessionPage> = {}): SessionPage =>
  ({ items, nextCursor, schoolTimezone: 'UTC', localToday: '2026-11-16', fromDate: '2026-11-15', ...over });
const apiOf = (pages: Array<SessionPage | Error>) => {
  const sessions = vi.fn(async () => { const next = pages.shift(); if (!next) throw new Error('no page'); if (next instanceof Error) throw next; return next; });
  return { api: { sessions } as unknown as Pick<RosterApi, 'sessions'>, sessions };
};
const signal = () => new AbortController().signal;
const range = { start: '2026-11-15', end: '2026-11-22' };

it('reads from the first visible day and stops once a class starts after the last visible day', async () => {
  const { api, sessions } = apiOf([pageOf([s(1, '2026-11-15T17:00:00.000Z'), s(2, '2026-11-21T17:00:00.000Z')], 'c2'), pageOf([s(3, '2026-11-21T20:00:00.000Z'), s(4, '2026-11-22T01:00:00.000Z')], 'c3')]);
  const result = await loadCalendarClasses(api, scope, range, signal(), () => true);
  expect(sessions.mock.calls.map((c) => [(c as unknown[])[1], (c as unknown[])[2]])).toEqual([['2026-11-15', null], ['2026-11-15', 'c2']]);
  expect(result.items.map((i) => i.name)).toEqual(['Class 1', 'Class 2', 'Class 3']);
  expect(result).toMatchObject({ truncated: false, timezone: 'UTC', localToday: '2026-11-16' });
});

it('stops at the page cap and says some classes are not shown', async () => {
  const pages = Array.from({ length: CALENDAR_MAX_PAGES + 2 }, (_, n) => pageOf([s(n, `2026-11-15T${String(n).padStart(2, '0')}:00:00.000Z`)], `c${n + 1}`));
  const { api, sessions } = apiOf(pages);
  const result = await loadCalendarClasses(api, scope, range, signal(), () => true);
  expect(sessions).toHaveBeenCalledTimes(CALENDAR_MAX_PAGES);
  expect(result.truncated).toBe(true);
});

it('reads again from the start once when the list moves while paging, then gives up', async () => {
  const a = s(1, '2026-11-15T17:00:00.000Z');
  const { api, sessions } = apiOf([pageOf([a], 'c2'), pageOf([a], null), pageOf([a], null)]);
  await expect(loadCalendarClasses(api, scope, range, signal(), () => true)).resolves.toMatchObject({ items: [a] });
  expect(sessions).toHaveBeenCalledTimes(3);
  const moved = apiOf([pageOf([a], 'c2'), new RosterError('CURSOR'), pageOf([a], 'c2'), pageOf([a], null)]);
  await expect(loadCalendarClasses(moved.api, scope, range, signal(), () => true)).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  const zone = apiOf([pageOf([a], 'c2'), pageOf([s(2, '2026-11-16T17:00:00.000Z')], null, { schoolTimezone: 'Asia/Seoul' }), pageOf([a], null)]);
  await expect(loadCalendarClasses(zone.api, scope, range, signal(), () => true)).resolves.toMatchObject({ items: [a] });
});

it('passes denial and time-zone errors through untouched', async () => {
  await expect(loadCalendarClasses(apiOf([new RosterError('DENIED')]).api, scope, range, signal(), () => true)).rejects.toMatchObject({ kind: 'DENIED' });
  await expect(loadCalendarClasses(apiOf([new RosterError('TIMEZONE')]).api, scope, range, signal(), () => true)).rejects.toMatchObject({ kind: 'TIMEZONE' });
});

it('groups classes and events by school-local day: events first, then classes by start time', () => {
  const late = s(1, '2026-11-16T03:00:00.000Z'), early = s(2, '2026-11-15T17:00:00.000Z');
  const event = { eventId: id(9), title: 'Black Friday sale', localDate: '2026-11-15', opensAt: '09:00', status: 'OPEN' };
  const days = groupByDay([late, early], [event as never], 'America/Los_Angeles', range);
  expect(days.get('2026-11-15')!.map((x) => x.kind === 'event' ? x.event.title : x.session.name)).toEqual(['Black Friday sale', 'Class 2', 'Class 1']);
  expect(days.get('2026-11-16')).toEqual([]);
  expect(days.size).toBe(7);
});
