import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClassSessionRosterEntry, CurrentSchoolClassSession } from '@hon/contracts';
import { ROSTER_LANGUAGES, rosterText } from '../src/components/class-roster/copy';
import { RosterError, rosterApi, rosterCounts, validFromDate, verifyRosterPage, verifySessionPage } from '../src/components/class-roster/http';
import { RosterView, type RosterViewProps } from '../src/components/class-roster/view';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const session = (n: number, hours: number, over: Partial<CurrentSchoolClassSession> = {}): CurrentSchoolClassSession => ({ sessionId: id(70 + n), name: `Kids class ${n}`,
  startsAt: new Date(NOW + hours * 3_600_000).toISOString(), endsAt: new Date(NOW + (hours + 1) * 3_600_000).toISOString(), roomName: 'Main mat', capacity: 20,
  bookingPolicy: 'OPTIONAL_BOOKING', status: 'SCHEDULED', createdAt: '2026-10-01T00:00:00.000Z', ...over } as CurrentSchoolClassSession);
const booking = (status = 'BOOKED', kind = 'REGULAR') => ({ id: id(90), kind, status, source: 'STAFF', bookedAt: '2026-11-01T00:00:00.000Z',
  cancelledAt: status === 'CANCELLED' ? '2026-11-02T00:00:00.000Z' : null, version: 1 });
const recorded = (status = 'PRESENT') => ({ id: id(95), status, category: 'REGULAR_PARTICIPANT', recordedAt: '2026-11-08T12:10:00.000Z', version: 1 });
const entry = (n: number, over: Record<string, unknown> = {}): ClassSessionRosterEntry => ({ studentProfileId: id(100 + n), personId: id(200 + n), givenName: `Ana${n}`, familyName: 'Rivera',
  studentStatus: 'ACTIVE', booking: booking(), attendance: null, ...over } as ClassSessionRosterEntry);
const meta = (over: Record<string, unknown> = {}) => ({ requestId: id(5), correlationId: id(5), limit: 50, nextCursor: null, ...over });
const page = (data: unknown[], over: Record<string, unknown> = {}) => ({ data, meta: meta(over) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const sessions = [session(3, -48, { name: 'Past class', status: 'COMPLETED' }), session(1, 1), session(2, 26, { name: 'Adult class', roomName: null })];
const listMeta = (over: Record<string, unknown> = {}) => ({ requestId: id(6), correlationId: id(6), limit: 50, nextCursor: null, schoolTimezone: 'America/Los_Angeles', localToday: '2026-11-08', fromDate: '2026-11-08', ...over });
const listReady = (items: CurrentSchoolClassSession[], over: Record<string, unknown> = {}) => ({ state: 'READY', from: null, items, nextCursor: null, schoolTimezone: 'UTC',
  localToday: '2026-11-08', fromDate: '2026-11-08', more: 'IDLE', restarted: false, ...over }) as RosterViewProps['list'];
const props = (over: Partial<RosterViewProps> = {}): RosterViewProps => ({ language: 'en', waiting: false, concealed: false, scope, from: null,
  list: listReady(sessions.slice(1)), selectedId: null, roster: { state: 'NONE' }, ...over });
const ready = (entries: ClassSessionRosterEntry[], over: Record<string, unknown> = {}) => ({ state: 'READY', sessionId: id(71), entries, nextCursor: null,
  more: 'IDLE', restarted: false, ...over }) as RosterViewProps['roster'];
const render = (over: Partial<RosterViewProps> = {}) => renderToStaticMarkup(<RosterView {...props(over)}/>);

it('reads the class list from a date with the human-read header, and a roster page with only limit and cursor', async () => {
  const f = stub(json({ data: [], meta: listMeta() }));
  await expect(rosterApi.sessions(scope, null, null, signal(), () => true)).resolves.toMatchObject({ items: [], fromDate: '2026-11-08', schoolTimezone: 'America/Los_Angeles' });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/schedule/sessions/list?limit=50`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'X-HON-Human-Read': 'class-sessions' } });
  const full = Array.from({ length: 50 }, (_, n) => session(10 + n, n));
  const g = stub(json({ data: full, meta: listMeta({ fromDate: '2026-10-01', nextCursor: 'p2' }) }));
  await expect(rosterApi.sessions(scope, '2026-10-01', 'c1', signal(), () => true)).resolves.toMatchObject({ nextCursor: 'p2' });
  expect((g.mock.calls[0] as unknown as [string])[0]).toMatch(/\/schedule\/sessions\/list\?from=2026-10-01&limit=50&cursor=c1$/);
  await expect(rosterApi.sessions(scope, '2026-02-30', null, signal(), () => true)).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  expect(validFromDate('2026-02-28')).toBe(true); expect(validFromDate('2026-02-30')).toBe(false); expect(validFromDate('1999-12-31')).toBe(false);
  const h = stub(json(page([entry(1)], { nextCursor: 'abc.def' })));
  await expect(rosterApi.roster(scope, id(71).toUpperCase(), null, signal(), () => true)).resolves.toMatchObject({ nextCursor: 'abc.def' });
  expect((h.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/schedule/sessions/${id(71)}/roster?limit=50`);
  const k = stub(json(page([entry(2)])));
  await rosterApi.roster(scope, id(71), 'abc.def', signal(), () => true);
  expect((k.mock.calls[0] as unknown as [string])[0]).toMatch(/\/roster\?limit=50&cursor=abc.def$/);
});

it('verifies a class-list page strictly; drift is unavailable', async () => {
  for (const bad of [{ data: [], meta: listMeta({ extra: 1 }) }, { data: [], meta: listMeta({ fromDate: '2026-11-09' }) }, { data: [session(1, 1)], meta: listMeta({ nextCursor: 'x' }) },
    { data: [session(2, 26), session(1, 1)], meta: listMeta() }, { data: [], meta: listMeta({ limit: 100 }) }, { data: [], meta: listMeta({ localToday: '2026-13-01' }) }]) {
    expect(() => verifySessionPage(bad, null)).toThrow();
  }
  expect(() => verifySessionPage({ data: [], meta: listMeta() }, '2026-10-01')).toThrow();
  expect(verifySessionPage({ data: [session(1, 1)], meta: listMeta({ fromDate: '2026-10-01' }) }, '2026-10-01').items).toHaveLength(1);
  for (const [response, kind] of [[json({ code: 'CLASS_SESSIONS_READ_FORBIDDEN' }, 403), 'DENIED'], [json({ code: 'INVALID_CURSOR' }, 400), 'CURSOR'],
    [json({ code: 'SCHOOL_TIMEZONE_INVALID' }, 409), 'TIMEZONE'], [json({ code: 'VALIDATION_FAILED' }, 400), 'UNAVAILABLE'], [json({ code: 'CLASS_SESSIONS_READ_TIMEOUT' }, 503), 'UNAVAILABLE']] as const) {
    stub(response);
    await expect(rosterApi.sessions(scope, null, 'c', signal(), () => true)).rejects.toMatchObject({ kind });
  }
});

it('maps refusals exactly; drift is unavailable, never an empty roster', async () => {
  for (const [response, kind] of [[json({ code: 'ATTENDANCE_FORBIDDEN' }, 403), 'DENIED'], [json({ code: 'CLASS_SESSION_NOT_FOUND' }, 404), 'UNAVAILABLE'],
    [json({ code: 'INVALID_CURSOR' }, 400), 'CURSOR'], [json({ code: 'OTHER' }, 400), 'UNAVAILABLE'], [json({}, 500), 'UNAVAILABLE'], [json({ data: [] }), 'UNAVAILABLE']] as const) {
    stub(response);
    await expect(rosterApi.roster(scope, id(71), null, signal(), () => true)).rejects.toMatchObject({ kind });
  }
  for (const bad of [page([entry(1)], { session: { id: id(71) } }), page([entry(1), entry(1)]), page([entry(1, { extra: 1 })]),
    page([entry(1, { booking: null, attendance: null })]), page([entry(1, { booking: { ...booking('CANCELLED'), cancelledAt: null } })]), page([entry(1, { booking: booking('BOOKED', 'GIFT') })]),
    page([entry(1, { attendance: { ...recorded(), status: 'MAYBE' } })]), page([], { nextCursor: 'x' }), page([entry(1)], { limit: 100 }), page(Array.from({ length: 51 }, (_, n) => entry(n)))]) {
    expect(() => verifyRosterPage(bad)).toThrow();
  }
  expect(verifyRosterPage(page([entry(1, { booking: null, attendance: recorded() }), entry(2, { booking: booking('BOOKED', 'CLASS_PASS') })])).entries).toHaveLength(2);
  // An unknown or other-school session is an empty roster, not an error.
  expect(verifyRosterPage(page([])).entries).toEqual([]);

});

it('a 401 for a retired read never ends the session; a current one does', async () => {
  const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(rosterApi.roster(scope, id(71), null, signal(), () => false)).rejects.toBeInstanceOf(RosterError);
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(rosterApi.sessions(scope, null, null, signal(), () => false)).rejects.toMatchObject({ kind: 'SESSION' });
  expect(seen).not.toHaveBeenCalled();
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(rosterApi.roster(scope, id(71), null, signal(), () => true)).rejects.toMatchObject({ kind: 'SESSION' });
  expect(seen).toHaveBeenCalledTimes(1);
});

it('counts only the rows read, by booking and attendance', () => {
  expect(rosterCounts([entry(1), entry(2, { booking: booking('WAITLISTED') }), entry(3, { booking: booking('CANCELLED') }), entry(4, { booking: null, attendance: recorded() }),
    entry(5, { booking: booking('CHECKED_IN'), attendance: recorded('LATE') })])).toEqual({ booked: 2, waitlisted: 1, cancelled: 1, walkIns: 1, recorded: 2 });
});

it('shows nothing private before the shell verifies the school, while concealed, or with no school', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { scope: null }]) {
    const html = render({ ...over, selectedId: id(71), roster: ready([entry(1)]) });
    expect(html).not.toContain('Kids class'); expect(html).not.toContain('Ana1'); expect(html).not.toContain('roster-table');
  }
  expect(render({ concealed: true })).toContain('Rosters are hidden');
});

it('shows the classes from the chosen date in school time, more classes, and honest list states', () => {
  const html = render({ list: listReady(sessions, { schoolTimezone: 'America/Los_Angeles', nextCursor: 'p2' }) });
  expect(html).toContain('Past class'); expect(html).toContain('Kids class 1'); expect(html).toContain('3 shown'); expect(html).toContain('No room');
  expect(html).toContain('Classes from Nov 8, 2026 on, in start order. Times are school time (America/Los_Angeles).');
  expect(html).toContain('>Show more classes</button>'); expect(html).toContain('type="date"'); expect(html).toMatch(/aria-pressed="true"[^>]*>Today</);
  expect(render({ from: '2026-10-01', list: listReady(sessions) })).not.toContain('Kids class 1');
  expect(render({ list: listReady(sessions, { restarted: true }) })).toContain('class list changed while it was being read');
  expect(render({ list: { state: 'DENIED' } })).toContain('does not include the class schedule');
  expect(render({ list: { state: 'TIMEZONE' } })).toContain('time zone is not set correctly');
  expect(render({ list: { state: 'UNAVAILABLE' } })).toContain('Nothing is shown');
  expect(render({ list: listReady([]) })).toContain('No classes here');
});

it('a selected class shows its own roster, counts, a partial note, and links that carry only verified selectors; no form', () => {
  const html = render({ selectedId: id(71), roster: ready([entry(1, { attendance: recorded() }), entry(2, { booking: null, attendance: recorded('LATE') })], { nextCursor: 'c' }) });
  expect(html).toContain('Ana1 Rivera'); expect(html).toContain('Present'); expect(html).toContain('Walk-in (no booking)'); expect(html).toContain('Late');
  expect(html).toContain('Counts cover the 2 students shown'); expect(html).toContain('>Show more</button>');
  expect(html).toContain(`href="/staff/attendance?organizationId=${scope.organizationId}&amp;schoolId=${scope.schoolId}"`);
  expect(html).toContain(`href="/staff/schedule/bookings?organizationId=${scope.organizationId}&amp;schoolId=${scope.schoolId}&amp;sessionId=${id(71)}"`);
  expect(html).not.toMatch(/<form|method="post"/i);
  expect(render({ selectedId: id(72), roster: ready([entry(1)]) })).not.toContain('Ana1');
  expect(render({ selectedId: id(73), list: listReady(sessions) })).not.toContain('/staff/schedule/bookings');
  expect(render({ selectedId: id(71), roster: ready([]) })).toContain('Nobody is booked');
  expect(render({ selectedId: id(71), roster: ready([entry(1)], { restarted: true }) })).toContain('read again from the start');
  expect(render({ selectedId: id(71), roster: { state: 'DENIED' } })).toContain('who can record attendance');
});

it('has every phrase in Korean and Spanish; the page is first in the Classes group and in the route manifest', () => {
  for (const language of ['ko', 'es'] as const) expect(Object.keys(ROSTER_LANGUAGES[language]).sort()).toEqual(Object.keys(ROSTER_LANGUAGES.en).sort());
  expect(rosterText('ko', 'title')).toBe('수업 명단'); expect(rosterText('es', 'title')).toBe('Listas de clase');
  expect(SCHOOL_SHELL_NAV.find((g) => g.key === 'classes')?.routes[0]?.href).toBe('/staff/schedule');
  expect(schoolShellActiveRoute('/staff/schedule/sessions')?.href).toBe('/staff/schedule/sessions');
  const manifest = JSON.parse(readFileSync(new URL('../public/manus-routes.json', import.meta.url), 'utf8')) as { routes: { path: string; title: string }[] };
  expect(manifest.routes).toContainEqual({ path: '/staff/schedule', title: 'HON | Class rosters' });
});
