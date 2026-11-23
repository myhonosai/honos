import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarCard, CurrentSchoolClassSession } from '@hon/contracts';
import { CALENDAR_LANGUAGES } from '../src/components/school-calendar/copy';
import { CalendarViewPane, NO_INSTRUCTOR, canDrag, filterOptions, filteredClasses, type CalendarViewProps, type CardsState } from '../src/components/school-calendar/view';
import { CalendarCardForm, cardFormInput, firstRosterDate, initialCardForm, startHasPassed } from '../src/components/school-calendar/card-form';
import { CardError, calendarCardsApi, cardErrorFor } from '../src/components/school-calendar/cards-http';
import { nextWholeHour } from '../src/components/school-calendar/calendar';
import { id, scope } from './account-status-fixtures';

const s = (n: number, startsAt: string, over: Partial<CurrentSchoolClassSession> = {}): CurrentSchoolClassSession => ({ sessionId: id(600 + n), name: `Class ${n}`, startsAt,
  endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(), roomName: null, capacity: 12, bookingPolicy: 'OPTIONAL_BOOKING', status: 'SCHEDULED',
  createdAt: '2026-10-01T00:00:00.000Z', ...over } as CurrentSchoolClassSession);
const kids = id(701), adults = id(702), coach = id(801);
const card = (n: number, over: Partial<CalendarCard> = {}): CalendarCard => ({ sessionId: id(600 + n), version: 1, kind: 'CLASS', programId: kids, programName: 'Kids Karate',
  seriesId: null, instructor: { principalId: coach, displayName: 'Coach Kim' }, booked: 0, attended: false, ...over });
// A week in 2027, so every class is in the future.
const week = { start: '2027-03-01', end: '2027-03-08' };
const items = [s(1, '2027-03-01T17:00:00.000Z'), s(2, '2027-03-02T18:00:00.000Z', { name: 'Adults' }), s(3, '2027-03-03T17:00:00.000Z', { name: 'Private' })];
const cardsReady = (canManage: boolean, over: CalendarCard[] = [card(1), card(2, { programId: adults, programName: 'Adult Karate', instructor: null, booked: 3 }),
  card(3, { kind: 'PRIVATE_LESSON', attended: true })]): CardsState => ({ state: 'READY', byId: new Map(over.map((c) => [c.sessionId, c])), canManage,
  programs: canManage ? [{ programId: kids, name: 'Kids Karate' }, { programId: adults, name: 'Adult Karate' }] : [], instructors: canManage ? [{ principalId: coach, displayName: 'Coach Kim' }] : [] });
const classes = { state: 'READY' as const, range: week, items, truncated: false, timezone: 'UTC', localToday: '2027-03-01' };
const props = (over: Partial<CalendarViewProps> = {}): CalendarViewProps => ({ language: 'en', waiting: false, concealed: false, hasScope: true, view: 'week', anchor: '2027-03-03',
  classes, events: { state: 'READY', events: [], timezone: 'UTC', localToday: '2027-03-01' }, selected: null, cards: cardsReady(true),
  onCreateAt: () => undefined, onDrop: () => undefined, ...over });
const render = (over: Partial<CalendarViewProps> = {}) => renderToStaticMarkup(<CalendarViewPane {...props(over)}/>);

describe('calendar cards on the board (0567)', () => {
  it('lets a manager click empty times and drag future, unattended classes only', () => {
    const html = render();
    expect((html.match(/data-testid="calendar-slot"/g) ?? []).length).toBe(7 * 14);
    expect(html).toContain('aria-label="Add a class on Mar 1, 2027 at 7:00 AM"');
    expect((html.match(/data-draggable="true"/g) ?? []).length).toBe(2);
    expect((html.match(/data-testid="calendar-resize"/g) ?? []).length).toBe(2);
    expect(html).toContain('Drag a class to move it');
  });
  it('shows the kind, instructor and booked count, coloured by kind', () => {
    const html = render();
    expect(html).toContain('data-card-kind="PRIVATE_LESSON"');
    expect(html).toContain('Private lesson');
    expect(html).toContain('Coach Kim');
    expect(html).toContain('3 booked');
  });
  it('a reader gets no slots, no drag and a plain notice', () => {
    const html = render({ cards: cardsReady(false), onCreateAt: undefined, onDrop: undefined });
    expect(html).not.toContain('calendar-slot');
    expect(html).not.toContain('data-draggable');
    expect(html).toContain('does not include adding or moving classes');
  });
  it('shows a ghost at the pending time and the create panel in the drawer', () => {
    const html = render({ pending: { sessionId: id(601), date: '2027-03-02', start: 9 * 60, end: 10 * 60, saving: true }, createPanel: <p>FORM</p> });
    expect(html).toContain('data-testid="calendar-ghost"');
    expect(html).toContain('9:00 AM – 10:00 AM');
    expect(html).toContain('Saving the new time…');
    expect(html).toContain('data-testid="calendar-create-drawer"');
    expect(html).toContain('data-dragging="true"');
  });
  it('canDrag: manager, scheduled, future, not attended', () => {
    const c = card(1), now = Date.parse('2027-02-01T00:00:00Z');
    expect(canDrag(items[0]!, c, true, now)).toBe(true);
    expect(canDrag(items[0]!, c, false, now)).toBe(false);
    expect(canDrag(items[0]!, undefined, true, now)).toBe(false);
    expect(canDrag({ ...items[0]!, status: 'CANCELLED' } as CurrentSchoolClassSession, c, true, now)).toBe(false);
    expect(canDrag(items[0]!, { ...c, attended: true }, true, now)).toBe(false);
    expect(canDrag(items[0]!, c, true, Date.parse('2027-03-01T17:00:00Z'))).toBe(false);
  });
});

describe('Program and Instructor filters', () => {
  const cards = cardsReady(true);
  it('offers the programs and instructors of the loaded classes, with No instructor last', () => {
    const o = filterOptions(classes, cards);
    expect(o.programs.map((p) => p.name)).toEqual(['Adult Karate', 'Kids Karate']);
    expect(o.instructors.map((p) => p.id)).toEqual([coach, NO_INSTRUCTOR]);
  });
  it('combines groups with AND and choices in a group with OR', () => {
    const names = (f: Parameters<typeof filteredClasses>[2]) => filteredClasses(classes, cards, f).map((c) => c.name);
    expect(names({})).toEqual(['Class 1', 'Adults', 'Private']);
    expect(names({ programs: [kids] })).toEqual(['Class 1', 'Private']);
    expect(names({ programs: [kids, adults] })).toEqual(['Class 1', 'Adults', 'Private']);
    expect(names({ instructors: [NO_INSTRUCTOR] })).toEqual(['Adults']);
    expect(names({ programs: [kids], instructors: [NO_INSTRUCTOR] })).toEqual([]);
    expect(names({ programs: [kids], names: ['Private'] })).toEqual(['Private']);
    // A choice that matches nothing loaded here is ignored.
    expect(names({ programs: [id(799)] })).toEqual(['Class 1', 'Adults', 'Private']);
    expect(filteredClasses(classes, { state: 'LOADING' }, { programs: [kids] })).toHaveLength(3);
  });
  it('renders Program and Instructor groups in the Filter menu and counts every choice', () => {
    const html = render({ programFilter: [kids], instructorFilter: [NO_INSTRUCTOR] });
    expect(html).toContain('<legend>Programs</legend>'); expect(html).toContain('<legend>Instructors</legend>');
    expect(html).toContain('No instructor');
    expect(html).toContain('aria-label="Show classes: 2 chosen"');
    expect(render({ programFilter: [adults] })).toContain('aria-label="Show classes: Adult Karate"');
  });
});

describe('a class just added', () => {
  it('is marked so the page can scroll to it, and the message sits above the board', () => {
    const html = render({ fresh: id(602), message: <p>DONE</p> });
    expect((html.match(/data-new="true"/g) ?? []).length).toBe(1);
    expect(html.indexOf('DONE')).toBeLessThan(html.indexOf('data-testid="calendar-week"'));
  });
});

describe('create form', () => {
  const programs = [{ programId: kids, name: 'Kids Karate' }];
  it('starts at the clicked time, 60 minutes, with the only program chosen', () => {
    const f = initialCardForm('2027-03-03', 18 * 60 + 15, programs);
    expect(f).toMatchObject({ localDate: '2027-03-03', localStartTime: '18:15', durationMinutes: '60', programId: kids, kind: 'CLASS', repeatWeekdays: [] });
    expect(initialCardForm('2027-03-03', 600, [...programs, { programId: adults }]).programId).toBe('');
  });
  it('builds a one-off or weekly body, always including the date’s own weekday', () => {
    const f = { ...initialCardForm('2027-03-03', 600, programs), name: ' Trial night ', kind: 'TRIAL' as const, instructorPrincipalId: coach };
    expect(cardFormInput(f)).toEqual({ kind: 'TRIAL', programId: kids, name: 'Trial night', capacity: 20, bookingPolicy: 'OPTIONAL_BOOKING', localDate: '2027-03-03',
      localStartTime: '10:00', durationMinutes: 60, instructorPrincipalId: coach, roomName: null });
    expect(cardFormInput({ ...f, repeats: true, repeatWeekdays: [5, 1], repeatUntil: '2027-05-01' })).toMatchObject({ repeatWeekdays: [1, 3, 5], repeatUntil: '2027-05-01' });
    expect(cardFormInput({ ...f, name: '  ' })).toBeNull();
    expect(cardFormInput({ ...f, programId: '' })).toBeNull();
  });
  it('renders every kind, program, instructor and the repeat days', () => {
    const html = renderToStaticMarkup(<CalendarCardForm language="en" programs={programs} instructors={[{ principalId: coach, displayName: 'Coach Kim' }]}
      initial={{ ...initialCardForm('2027-03-03', 600, programs), repeats: true }} busy={false} error={null} onCancel={() => undefined} onSubmit={() => undefined}/>);
    for (const label of ['Class', 'Private lesson', 'Trial class', 'Event', 'Kids Karate', 'Coach Kim', 'No instructor', 'Repeats every week', 'Wed', 'Add to calendar']) expect(html).toContain(label);
    expect(html).toMatch(/<input type="checkbox" disabled="" checked=""\/><span>Wed/);
  });
  // David's report: a weekly roster made today at a time that had already passed got its first class next week, so the week
  // shown stayed empty. The form says so first, and the page jumps to the first class.
  const LA = 'America/Los_Angeles', saturday1125 = Date.parse('2026-11-21T19:25:00.000Z'); // Sat 21 Nov 2026, 11:25 AM in LA
  const base = { kind: 'CLASS' as const, programId: kids, name: 'test', capacity: 20, bookingPolicy: 'OPTIONAL_BOOKING' as const, durationMinutes: 60, localDate: '2026-11-21' };
  it('knows when a start time today has already passed in school time', () => {
    expect(startHasPassed('2026-11-21', '10:00', LA, saturday1125)).toBe(true);
    expect(startHasPassed('2026-11-21', '11:25', LA, saturday1125)).toBe(true);
    expect(startHasPassed('2026-11-21', '12:00', LA, saturday1125)).toBe(false);
    expect(startHasPassed('2026-11-22', '06:00', LA, saturday1125)).toBe(false);
  });
  it('finds the date of a new roster’s first class', () => {
    expect(firstRosterDate({ ...base, localStartTime: '10:00', repeatWeekdays: [6] }, LA, saturday1125)).toBe('2026-11-28');
    expect(firstRosterDate({ ...base, localStartTime: '17:00', repeatWeekdays: [6] }, LA, saturday1125)).toBe('2026-11-21');
    expect(firstRosterDate({ ...base, localStartTime: '10:00', repeatWeekdays: [1, 6] }, LA, saturday1125)).toBe('2026-11-23');
    expect(firstRosterDate({ ...base, localStartTime: '10:00', repeatWeekdays: [6], repeatUntil: '2026-11-21' }, LA, saturday1125)).toBeNull();
    // 2:30 AM does not exist in LA on 14 March 2027: that date is skipped, as the server does.
    expect(firstRosterDate({ ...base, localDate: '2027-03-14', localStartTime: '02:30', repeatWeekdays: [7] }, LA, saturday1125)).toBe('2027-03-21');
  });
  it('warns before saving a time that has already passed today', () => {
    const programsOne = [{ programId: kids, name: 'Kids Karate' }];
    const form = (repeats: boolean, language = 'en') => renderToStaticMarkup(<CalendarCardForm language={language} programs={programsOne} instructors={[]} timeZone={LA} now={saturday1125}
      initial={{ ...initialCardForm('2026-11-21', 600, programsOne), repeats }} busy={false} error={null} onCancel={() => undefined} onSubmit={() => undefined}/>);
    expect(form(true)).toContain('10:00 AM today has already passed, so the first class will be on Saturday, November 28.');
    expect(form(false)).toContain('10:00 AM today has already passed. Choose a later time.');
    expect(form(true, 'ko')).toContain('11월 28일');
    expect(form(true, 'es')).toContain('28 de noviembre');
    const later = renderToStaticMarkup(<CalendarCardForm language="en" programs={programsOne} instructors={[]} timeZone={LA} now={saturday1125}
      initial={{ ...initialCardForm('2026-11-21', 17 * 60, programsOne), repeats: true }} busy={false} error={null} onCancel={() => undefined} onSubmit={() => undefined}/>);
    expect(later).not.toContain('already passed');
  });
  it('tells the school it has no program yet', () => {
    const html = renderToStaticMarkup(<CalendarCardForm language="ko" programs={[]} instructors={[]} initial={initialCardForm('2027-03-03', 600, [])} busy={false} error={null}
      onCancel={() => undefined} onSubmit={() => undefined}/>);
    expect(html).toContain('아직 프로그램이 없습니다'); expect(html).toMatch(/type="submit"[^>]*disabled=""/);
  });
});

describe('cards http', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('maps every refusal to one meaning', () => {
    expect(cardErrorFor(403, 'CLASS_SERIES_FORBIDDEN').kind).toBe('DENIED');
    expect(cardErrorFor(404, 'INSTRUCTOR_NOT_FOUND').kind).toBe('GONE');
    expect(cardErrorFor(400, 'CALENDAR_CARD_NOT_IN_FUTURE').kind).toBe('PAST');
    expect(cardErrorFor(400, 'VALIDATION_FAILED').kind).toBe('INVALID');
    expect(cardErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
    expect(cardErrorFor(409, 'CALENDAR_CARD_LOCKED').kind).toBe('LOCKED');
    expect(cardErrorFor(409, 'CALENDAR_CARD_CONFLICT').kind).toBe('UNKNOWN');
    expect(cardErrorFor(503, null).kind).toBe('UNKNOWN');
  });
  it('sends a move as its own human command with an idempotency key and verifies the receipt', async () => {
    const input = { expectedVersion: 2, startsAt: '2027-03-01T18:00:00.000Z', endsAt: '2027-03-01T19:30:00.000Z' };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { sessionId: id(601), version: 3, startsAt: input.startsAt, endsAt: input.endsAt, detachedFromRoster: true }, meta: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const key = id(900);
    const receipt = await calendarCardsApi.move(scope, id(601), input, key, new AbortController().signal, () => true);
    expect(receipt.detachedFromRoster).toBe(true);
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/schedule/calendar/cards/${id(601)}/move`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'schedule.calendar.move', 'Idempotency-Key': key });
    expect(JSON.parse(String(init.body))).toEqual(input);
  });
  it('never trusts a receipt for another time, and refuses a bad body before sending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { sessionId: id(601), version: 3, startsAt: '2027-03-01T18:15:00.000Z',
      endsAt: '2027-03-01T19:30:00.000Z', detachedFromRoster: false }, meta: {} }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(calendarCardsApi.move(scope, id(601), { expectedVersion: 2, startsAt: '2027-03-01T18:00:00.000Z', endsAt: '2027-03-01T19:30:00.000Z' }, id(900),
      new AbortController().signal, () => true)).rejects.toMatchObject({ kind: 'UNKNOWN' });
    await expect(calendarCardsApi.move(scope, id(601), { expectedVersion: 2, startsAt: '2027-03-01T18:00:00.000Z', endsAt: '2027-03-01T18:02:00.000Z' }, id(900),
      new AbortController().signal, () => true)).rejects.toBeInstanceOf(CardError);
  });
  it('reads one range with no idempotency key', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { timezone: 'UTC', localToday: '2027-03-01', from: '2027-03-01', to: '2027-03-07', truncated: false,
      canManage: false, cards: [card(1)], programs: [], instructors: [] }, meta: {} }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const read = await calendarCardsApi.read(scope, '2027-03-01', '2027-03-07', new AbortController().signal, () => true);
    expect(read.cards).toHaveLength(1);
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toMatch(/\/schedule\/calendar\/cards\?from=2027-03-01&to=2027-03-07$/);
    expect(init.method).toBe('GET'); expect(init.headers).not.toHaveProperty('Idempotency-Key');
  });
});

it('Add a class opens at the next whole hour, or 9 AM tomorrow late at night', () => {
  expect(nextWholeHour('2027-03-01', 14 * 60 + 5)).toEqual({ date: '2027-03-01', minutes: 15 * 60 });
  expect(nextWholeHour('2027-03-01', 15 * 60)).toEqual({ date: '2027-03-01', minutes: 16 * 60 });
  expect(nextWholeHour('2027-03-01', 23 * 60 + 10)).toEqual({ date: '2027-03-02', minutes: 9 * 60 });
});

it('has every new label in Korean and Spanish', () => {
  const keys = Object.keys(CALENDAR_LANGUAGES.en);
  for (const language of ['ko', 'es'] as const) for (const key of keys) expect(CALENDAR_LANGUAGES[language][key as keyof typeof CALENDAR_LANGUAGES.en], `${language}.${key}`).toBeTruthy();
});
