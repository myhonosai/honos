import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { CurrentSchoolClassSession } from '@hon/contracts';
import { CALENDAR_LANGUAGES, calendarText } from '../src/components/school-calendar/copy';
import { CalendarViewPane, MONTH_CELL_ITEMS, rangeLabel, visibleClasses, type CalendarViewProps } from '../src/components/school-calendar/view';
import { SchoolSchedulePage, scheduleTabHref } from '../src/components/school-calendar/schedule-page';
import { RosterSessionDetail } from '../src/components/class-roster/view';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { shellText } from '../src/components/school-shell/copy';
import { id, scope } from './account-status-fixtures';

const s = (n: number, startsAt: string, over: Partial<CurrentSchoolClassSession> = {}): CurrentSchoolClassSession => ({ sessionId: id(400 + n), name: `Class ${n}`, startsAt,
  endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(), roomName: 'Main mat', capacity: 12, bookingPolicy: 'OPTIONAL_BOOKING', status: 'SCHEDULED',
  createdAt: '2026-10-01T00:00:00.000Z', ...over } as CurrentSchoolClassSession);
const ev = (n: number, localDate: string, over: Record<string, unknown> = {}) => ({ eventId: id(500 + n), title: `Sale day ${n}`, localDate, opensAt: '09:00', closesAt: '13:00',
  status: 'PUBLISHED', place: 'Front desk', slotCount: 8, spotsPerSlot: 2, bookedCount: 5, ...over }) as never;
const week = { start: '2026-11-15', end: '2026-11-22' };
const props = (over: Partial<CalendarViewProps> = {}): CalendarViewProps => ({ language: 'en', waiting: false, concealed: false, hasScope: true, view: 'week', anchor: '2026-11-18',
  classes: { state: 'READY', range: week, items: [s(2, '2026-11-16T19:00:00.000Z'), s(1, '2026-11-16T17:00:00.000Z', { name: 'Little tigers' }), s(3, '2026-11-18T17:00:00.000Z', { status: 'CANCELLED' })],
    truncated: false, timezone: 'UTC', localToday: '2026-11-16' },
  events: { state: 'READY', events: [ev(1, '2026-11-16')], timezone: 'UTC', localToday: '2026-11-16' }, selected: null, ...over });
const render = (over: Partial<CalendarViewProps> = {}) => renderToStaticMarkup(<CalendarViewPane {...props(over)}/>);
const order = (html: string, ...parts: string[]) => parts.map((p) => html.indexOf(p)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]!));

it('shows a week of classes and sale days, events first and classes by start time, with empty days and the school zone', () => {
  const html = render();
  expect(html).toContain('data-testid="calendar-week"');
  expect(order(html.slice(html.indexOf('calendar-week')), 'Sale day 1', 'Little tigers', 'Class 2')).toBe(true);
  expect(html).toContain('Cancelled'); expect(html).toContain('data-status="CANCELLED"');
  expect((html.match(/Nothing scheduled\./g) ?? []).length).toBe(5);
  expect(html).toContain('Times are school time (UTC).');
  expect(html).toContain('data-today="true"');
  expect(rangeLabel('en', 'week', '2026-11-18')).toMatch(/Nov 16.*22, 2026/);
});

it('shows a month grid with at most three items a day and "+N more" that opens the day', () => {
  const busy = Array.from({ length: MONTH_CELL_ITEMS + 2 }, (_, n) => s(10 + n, `2026-11-16T${String(10 + n)}:00:00.000Z`));
  const html = render({ view: 'month', classes: { state: 'READY', range: { start: '2026-11-01', end: '2026-12-06' }, items: busy, truncated: false, timezone: 'UTC', localToday: '2026-11-16' } });
  expect(html).toContain('data-testid="calendar-month"');
  expect((html.match(/role="row"/g) ?? []).length).toBe(7);
  expect(html).toContain('+3 more');
  expect(html).toContain('data-out="true"');
  expect(rangeLabel('en', 'month', '2026-11-18')).toBe('November 2026');
});

it('shows one day with its full date', () => {
  const html = render({ view: 'day', anchor: '2026-11-16' });
  expect(html).toContain('data-testid="calendar-day"');
  expect(html).toContain('Monday, November 16');
  expect(html).not.toContain('Nothing scheduled.');
});

it('keeps showing events when classes are denied, and classes when events are denied', () => {
  const noClasses = render({ classes: { state: 'DENIED' } });
  expect(noClasses).toContain(calendarText('en', 'classesDenied')); expect(noClasses).toContain('Sale day 1'); expect(noClasses).not.toContain('Little tigers');
  const noEvents = render({ events: { state: 'DENIED' } });
  expect(noEvents).toContain(calendarText('en', 'eventsDenied')); expect(noEvents).toContain('Little tigers'); expect(noEvents).not.toContain('Sale day 1');
  expect(render({ classes: { state: 'READY', range: week, items: [], truncated: true, timezone: 'UTC', localToday: '2026-11-16' } })).toContain(calendarText('en', 'truncated'));
  expect(render({ classes: { state: 'TIMEZONE' } })).toContain('time zone is not set correctly, so classes cannot be shown.');
  expect(render({ classes: { state: 'LOADING' } })).toContain(calendarText('en', 'loading'));
});

it('shows nothing from the school before the shell verifies it', () => {
  for (const [over, key] of [[{ waiting: true }, 'waiting'], [{ concealed: true }, 'concealed'], [{ hasScope: false }, 'noSchool']] as const) {
    const html = render(over);
    expect(html).toContain(calendarText('en', key)); expect(html).not.toContain('Little tigers'); expect(html).not.toContain('Sale day 1');
  }
});

it('opens an event panel with its date, hours, place and booked spots, and a link to manage it', () => {
  const html = render({ selected: { kind: 'event', id: id(501) } });
  expect(html).toContain('data-testid="calendar-event-detail"');
  expect(html).toContain('Nov 16, 2026, 9:00 AM to 1:00 PM'); expect(html).toContain('Front desk'); expect(html).toContain('5 of 16');
  expect(html).toContain('Manage on Sale days &amp; events'); expect(html).toContain('Open for booking');
  expect(render({ selected: null })).not.toContain('data-testid="calendar-drawer"');
});

it('opens the page-built class panel in the side drawer for a selected class', () => {
  const html = render({ selected: { kind: 'class', id: id(401) }, classDetail: <p>roster panel</p> });
  expect(html).toContain('data-testid="calendar-drawer"'); expect(html).toContain('roster panel'); expect(html).toContain('>Close</button>');
});

it('puts week classes on an hour grid at their school time, as tall as they are long, overlapping ones side by side', () => {
  const html = render({ classes: { state: 'READY', range: week, items: [s(1, '2026-11-16T17:00:00.000Z'), s(2, '2026-11-16T17:30:00.000Z')], truncated: false, timezone: 'UTC', localToday: '2026-11-16' } });
  // 7 AM is the first hour: 17:00 is 10 hours down at 64px an hour; a one-hour class is 61px tall; two overlapping classes share the width.
  expect(html).toContain('top:640px;height:61px;left:calc(0% + 2px);width:calc(50% - 4px)');
  expect(html).toContain('top:672px;height:61px;left:calc(50% + 2px);width:calc(50% - 4px)');
  expect(html).toContain('>Events</div>');
});

it('filters the calendar by class name with one compact Filter menu, several names at once', () => {
  const all = render();
  expect(all).toContain('data-testid="calendar-filter"'); expect(all).toContain('aria-label="Show classes: All classes"');
  expect(all).toMatch(/<input type="checkbox"\/> <span>Little tigers<\/span>/); expect(all).not.toContain('aria-pressed="true">All classes');
  const only = render({ classFilter: ['Little tigers'] });
  expect(only).toContain('aria-label="Show classes: Little tigers"'); expect(only).toContain('>Show all</button>');
  expect(only.match(/<span class="[^"]*name[^"]*">Class 2<\/span>/)).toBeNull();
  expect(only).toContain('Sale day 1');
  // A name that is no longer on the calendar does not count as chosen.
  expect(render({ classFilter: ['Gone class'] })).toContain('aria-label="Show classes: All classes"');
});

it('shows only the chosen class names', () => {
  const items = [s(1, '2026-11-16T17:00:00.000Z'), s(2, '2026-11-16T18:00:00.000Z', { name: 'Little tigers' })];
  const ready = { state: 'READY', range: week, items, truncated: false, timezone: 'UTC', localToday: '2026-11-16' } as const;
  expect(visibleClasses(ready, [])).toHaveLength(2);
  expect(visibleClasses(ready, ['Little tigers']).map((c) => c.name)).toEqual(['Little tigers']);
  expect(visibleClasses({ state: 'LOADING' }, ['Little tigers'])).toEqual([]);
  // A chosen name with no class in this range (e.g. after moving to another week) shows every class, as the menu says.
  expect(visibleClasses(ready, ['Karate'])).toHaveLength(2);
  expect(visibleClasses(ready, ['Karate', 'Little tigers']).map((c) => c.name)).toEqual(['Little tigers']);
});

it('offers booking in place from the roster panel when the calendar asks, and never for a cancelled class', () => {
  const base = { language: 'en', scope, timeZone: 'UTC', roster: { state: 'NONE' } as const };
  const inPlace = renderToStaticMarkup(<RosterSessionDetail {...base} session={s(1, '2026-11-16T17:00:00.000Z')} onBook={() => {}}/>);
  expect(inPlace).toMatch(/<button type="button"[^>]*>Book a student on this class<\/button>/); expect(inPlace).not.toContain('/staff/schedule/bookings?');
  const link = renderToStaticMarkup(<RosterSessionDetail {...base} session={s(1, '2026-11-16T17:00:00.000Z')}/>);
  expect(link).toContain('/staff/schedule/bookings?');
  expect(renderToStaticMarkup(<RosterSessionDetail {...base} session={s(1, '2026-11-16T17:00:00.000Z', { status: 'CANCELLED' })} onBook={() => {}}/>)).not.toContain('Book a student');
});

it('is one page with Calendar, Weekly timetable and Sale days & events tabs', () => {
  const html = renderToStaticMarkup(<SchoolSchedulePage/>);
  expect(html).toContain('<h1 id="schedule-title">Calendar</h1>');
  expect(order(html, '>Calendar</button>', '>Weekly timetable</button>', '>Sale days &amp; events</button>')).toBe(true);
  expect(html).toMatch(/aria-selected="true"[^>]*>Calendar</);
  expect(html).toContain('href="/staff/schedule/sessions/create"');
  expect(scheduleTabHref('events')).toBe('/staff/schedule?tab=events'); expect(scheduleTabHref('calendar')).toBe('/staff/schedule');
});

it('is the one schedule entry in the Classes menu, and the old pages redirect into it', () => {
  const classes = SCHOOL_SHELL_NAV.find((n) => n.key === 'classes')!;
  expect(classes.routes[0]).toMatchObject({ href: '/staff/schedule', titleKey: 'routeCalendar' });
  for (const old of ['/staff/schedule/sessions', '/staff/schedule/timetable', '/staff/schedule/events', '/staff/schedule/bookings']) {
    expect(classes.routes.some((r) => r.href === old)).toBe(false);
    expect(schoolShellActiveRoute(old)?.href).toBe('/staff/schedule');
  }
  expect([shellText('en', 'routeCalendar'), shellText('ko', 'routeCalendar'), shellText('es', 'routeCalendar')]).toEqual(['Calendar', '캘린더', 'Calendario']);
  expect(readFileSync('src/app/staff/schedule/events/page.tsx', 'utf8')).toContain("redirect('/staff/schedule?tab=events')");
  expect(readFileSync('src/app/staff/schedule/sessions/page.tsx', 'utf8')).toContain("redirect('/staff/schedule')");
  const page = readFileSync('src/app/staff/schedule/page.tsx', 'utf8');
  expect(page).toContain('requireVerifiedWebSession'); expect(page).toContain("dynamic = 'force-dynamic'"); expect(page).toContain('parseCalendarTab(query.tab)');
  const source = ['calendar.tsx', 'view.tsx', 'http.ts', 'range.ts', 'schedule-page.tsx'].map((f) => readFileSync(`src/components/school-calendar/${f}`, 'utf8')).join('\n');
  expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|setInterval|dangerouslySetInnerHTML|fetch\(/);
});

it('has every phrase in Korean and Spanish with the same placeholders', () => {
  const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const keys = Object.keys(CALENDAR_LANGUAGES.en) as (keyof typeof CALENDAR_LANGUAGES.en)[];
  for (const lang of ['ko', 'es'] as const) {
    expect(Object.keys(CALENDAR_LANGUAGES[lang]).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(vars(CALENDAR_LANGUAGES[lang][k]), `${lang}.${k}`).toBe(vars(CALENDAR_LANGUAGES.en[k]));
  }
});
