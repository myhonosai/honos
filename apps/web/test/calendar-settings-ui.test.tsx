import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarSettings, PublicShareCalendar, ShareCalendar } from '@hon/contracts';
import { CalendarSettingsView, SETTINGS_SECTIONS, draftOf, emptyShareDraft, shareInput, shareQrSvg, type CalendarSettingsViewProps } from '../src/components/school-calendar/settings';
import { calendarSettingsApi, readPublicShareCalendar } from '../src/components/school-calendar/settings-http';
import { CALENDAR_LANGUAGES } from '../src/components/school-calendar/copy';
import { settingsText } from '../src/components/school-calendar/settings-copy';
import { PublicCalendarView, timesByDay } from '../src/components/school-calendar/public-calendar';
import { CALENDAR_TABS, closedDays } from '../src/components/school-calendar/range';
import { CalendarViewPane, type CalendarViewProps } from '../src/components/school-calendar/view';
import { id, scope } from './account-status-fixtures';

const pid = (c: string) => c.repeat(48);
const kids = id(701), adults = id(702);
const share = (n: number, over: Partial<ShareCalendar> = {}): ShareCalendar => ({ shareCalendarId: id(900 + n), publicId: pid(String(n)), kind: 'PROGRAM', name: `Calendar ${n}`,
  description: '', programId: kids, programName: 'Kids Karate', memberIds: [], ageMin: 5, ageMax: 12, enabled: true, version: 1, upcomingCount: 8, ...over });
const settings = (over: Partial<CalendarSettings> = {}): CalendarSettings => ({ timezone: 'America/Los_Angeles', localToday: '2027-03-01', schoolName: 'Sample Dojo',
  settings: { address: '1 Sample Street', phone: '555-0100', version: 1 }, programs: [{ programId: kids, name: 'Kids Karate' }, { programId: adults, name: 'Adult Karate' }],
  blockOuts: [{ blockOutId: id(950), label: 'Spring break', firstDate: '2027-03-22', lastDate: '2027-03-26', version: 1 }],
  shareCalendars: [share(1), share(2, { name: 'Adults', programId: adults, programName: 'Adult Karate', ageMin: 16, ageMax: null, enabled: false }),
    share(3, { kind: 'GROUP', name: 'All classes', programId: null, programName: null, memberIds: [id(901), id(902)], ageMin: null, ageMax: null, upcomingCount: null })], ...over });
const view = (over: Partial<CalendarSettingsViewProps> = {}) => renderToStaticMarkup(<CalendarSettingsView language="en" read={{ state: 'READY', settings: settings() }}
  section="share" onSection={() => undefined} busy={false} message={null} origin="https://app.example.test" {...over}/>);

afterEach(() => { vi.unstubAllGlobals(); });

describe('calendar settings tab (0552)', () => {
  it('is the fourth tab of Classes > Calendar, with Programs, Block-out dates, Share links and QR codes', () => {
    expect(CALENDAR_TABS).toEqual(['calendar', 'timetable', 'events', 'settings']);
    expect(SETTINGS_SECTIONS).toEqual(['programs', 'blockOuts', 'share', 'qr']);
    const html = view();
    for (const label of ['>Programs</button>', '>Block-out dates</button>', '>Share links</button>', '>QR codes</button>']) expect(html).toContain(label);
  });
  it('shows each share link with its on/off switch, link, embed, open, edit and delete', () => {
    const html = view();
    expect((html.match(/data-testid="share-calendar"/g) ?? []).length).toBe(3);
    expect(html).toContain(`https://app.example.test/calendars/${pid('1')}`);
    expect((html.match(/role="switch"/g) ?? []).length).toBe(3);
    expect(html).toMatch(/role="switch" aria-label="Show Calendar 1 to families" checked=""/);
    expect(html).toMatch(/role="switch" aria-label="Show Adults to families"\/>/);
    expect(html).toContain('Copy link'); expect(html).toContain('Copy embed code'); expect(html).toContain('Edit'); expect(html).toContain('Delete');
    expect(html).toContain('Ages 5 to 12'); expect(html).toContain('Ages 16 and up');
    expect(html).toContain('Calendar 1, Adults');
    expect(html).toContain('value="1 Sample Street"'); expect(html).toContain('value="555-0100"');
  });
  it('lists block-out dates and the school programs', () => {
    expect(view({ section: 'blockOuts' })).toContain('Spring break');
    const programs = view({ section: 'programs' });
    expect(programs).toContain('Kids Karate'); expect(programs).toContain('Adult Karate');
  });
  it('draws a QR code only for enabled calendars, with an SVG download', () => {
    const html = view({ section: 'qr' });
    expect((html.match(/data-testid="share-qr"/g) ?? []).length).toBe(2);
    expect(html).toContain('download="calendar-1-qr.svg"');
    expect(shareQrSvg('https://app.example.test/calendars/x')).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"[^>]*><rect[^>]*\/><path d="M/);
  });
  it('builds a command body only from a complete draft', () => {
    expect(shareInput(emptyShareDraft())).toBeNull();
    expect(shareInput({ ...emptyShareDraft(), name: 'Kids', programId: kids, ageMinText: '12', ageMaxText: '5' })).toBeNull();
    expect(shareInput({ ...emptyShareDraft(), name: ' Kids ', programId: kids, ageMinText: '5' })).toEqual({ expectedVersion: null, kind: 'PROGRAM', name: 'Kids', description: '',
      programId: kids, memberIds: [], ageMin: 5, ageMax: null, enabled: true });
    expect(shareInput({ ...emptyShareDraft('GROUP'), name: 'All', memberIds: [id(901)] })).toBeNull();
    expect(shareInput({ ...draftOf(settings().shareCalendars[2]!), enabled: false })).toMatchObject({ expectedVersion: 1, kind: 'GROUP', programId: null, memberIds: [id(901), id(902)], enabled: false });
  });
  it('shows a plain notice when the settings cannot be read', () => {
    expect(view({ read: { state: 'DENIED' } })).toContain('role="alert"');
    expect(view({ read: { state: 'UNAVAILABLE' } })).toContain('Try again');
  });
  it('has every settings word in English, Korean and Spanish', () => {
    for (const language of Object.keys(CALENDAR_LANGUAGES)) for (const key of ['secShare', 'copyEmbed', 'pubChoose', 'pubCall', 'pubUpcoming'] as const) {
      expect(settingsText(language, key, { phone: '1', n: 1 })).not.toBe('');
    }
  });
});

describe('calendar settings HTTP (0552)', () => {
  it('reads block-outs for a checked range and refuses a range over 42 days before sending', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { blockOuts: [] }, meta: {} }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(calendarSettingsApi.blockOuts(scope, '2027-03-01', '2027-03-07', new AbortController().signal, () => true)).resolves.toEqual({ blockOuts: [] });
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/schedule/calendar/block-outs?from=2027-03-01&to=2027-03-07`);
    await expect(calendarSettingsApi.blockOuts(scope, '2027-03-01', '2027-05-01', new AbortController().signal, () => true)).rejects.toMatchObject({ kind: 'INVALID' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reads a public calendar without credentials, and treats a bad id as not found without sending', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    await expect(readPublicShareCalendar('nope', new AbortController().signal)).resolves.toBe('NOT_FOUND');
    expect(fetch).not.toHaveBeenCalled();
    await expect(readPublicShareCalendar(pid('a'), new AbortController().signal)).resolves.toBe('NOT_FOUND');
    expect(fetch.mock.calls[0]).toEqual([`/api/v1/public/calendars/${pid('a')}`, expect.objectContaining({ credentials: 'omit', cache: 'no-store' })]);
  });
});

describe('closed days on the calendar (0552)', () => {
  it('maps block-outs onto the visible dates only', () => {
    const map = closedDays([{ firstDate: '2027-02-27', lastDate: '2027-03-02', label: 'Winter' }, { firstDate: '2027-03-02', lastDate: '2027-03-02', label: 'Other' }], '2027-03-01', '2027-03-07');
    expect([...map]).toEqual([['2027-03-01', 'Winter'], ['2027-03-02', 'Winter']]);
  });
  it('shades and labels a closed day in the week view', () => {
    const props: CalendarViewProps = { language: 'en', waiting: false, concealed: false, hasScope: true, view: 'week', anchor: '2027-03-03',
      classes: { state: 'READY', range: { start: '2027-03-01', end: '2027-03-08' }, items: [], truncated: false, timezone: 'UTC', localToday: '2027-03-01' },
      events: { state: 'READY', events: [], timezone: 'UTC', localToday: '2027-03-01' }, selected: null, closed: new Map([['2027-03-03', 'Inspection']]) };
    const html = renderToStaticMarkup(<CalendarViewPane {...props}/>);
    expect((html.match(/data-closed="true"/g) ?? []).length).toBe(2);
    expect(html).toContain('Closed: Inspection');
  });
  it('asks before adding or moving a class onto a closed day, and never refuses it', () => {
    const source = readFileSync('src/components/school-calendar/calendar.tsx', 'utf8');
    expect(source).toContain('askIfClosed(date, () => setCreating(');
    expect(source).toContain('askIfClosed(date, onto)');
  });
});

describe('public shared calendar page (0552)', () => {
  const school = { name: 'Sample Dojo', address: '1 Sample Street', phone: '555-0100', logoUrl: null, accentColor: '#b91c1c', contactLine: null };
  const group: PublicShareCalendar = { publicId: pid('3'), kind: 'GROUP', name: 'All classes', description: 'Pick a class', timezone: 'America/Los_Angeles', school,
    ageMin: null, ageMax: null, times: [], calendars: [{ publicId: pid('1'), name: 'Kids', description: '', ageMin: 5, ageMax: 12, upcomingCount: 8 },
      { publicId: pid('2'), name: 'Adults', description: 'Evenings', ageMin: 16, ageMax: null, upcomingCount: 4 }] };
  const program: PublicShareCalendar = { ...group, publicId: pid('1'), kind: 'PROGRAM', name: 'Kids', calendars: [], ageMin: 5, ageMax: 12, times: [
    { name: 'Kids Karate', startsAt: '2027-03-02T01:00:00.000Z', endsAt: '2027-03-02T02:00:00.000Z', localDate: '2027-03-01', localStart: '17:00', localEnd: '18:00', room: 'Mat 1', spotsLeft: 3 },
    { name: 'Kids Karate', startsAt: '2027-03-03T01:00:00.000Z', endsAt: '2027-03-03T02:00:00.000Z', localDate: '2027-03-02', localStart: '17:00', localEnd: '18:00', room: '', spotsLeft: 0 }] };
  it('shows the school, then "Choose a calendar" cards with ages and upcoming counts', () => {
    const html = renderToStaticMarkup(<PublicCalendarView language="en" read={group}/>);
    expect(html).toContain('Sample Dojo'); expect(html).toContain('1 Sample Street'); expect(html).toContain('href="tel:5550100"');
    expect(html).toContain('Choose a calendar');
    expect((html.match(/data-testid="public-calendar-card"/g) ?? []).length).toBe(2);
    expect(html).toContain('Ages 5 to 12'); expect(html).toContain('8 upcoming class times');
    expect(html).toContain('--accent:#b91c1c');
  });
  it('shows a program’s class times by day with open spots and how to book', () => {
    const html = renderToStaticMarkup(<PublicCalendarView language="en" read={program} group={group} onBack={() => undefined}/>);
    expect((html.match(/data-testid="public-calendar-day"/g) ?? []).length).toBe(2);
    expect(html).toContain('3 spots left'); expect(html).toContain('>Full<');
    expect(html).toContain('To book, call 555-0100.');
    expect(html).toContain('All calendars');
    expect(timesByDay(program.times).map(([d]) => d)).toEqual(['2027-03-01', '2027-03-02']);
  });
  it('answers unknown, disabled and deleted links the same way', () => {
    expect(renderToStaticMarkup(<PublicCalendarView language="en" read="NOT_FOUND"/>)).toContain('This calendar is not available.');
  });
  it('is a public route that sends no session and is not indexed', () => {
    const page = readFileSync('src/app/calendars/[publicId]/page.tsx', 'utf8');
    expect(page).toContain('/^[a-f0-9]{48}$/'); expect(page).toContain('index: false'); expect(page).not.toContain('requireVerifiedWebSession');
  });
});
