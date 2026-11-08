import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClassSessionRosterEntry, CurrentSchoolClassSession } from '@hon/contracts';
import { ROSTER_LANGUAGES, rosterText } from '../src/components/class-roster/copy';
import { RosterError, rosterApi, rosterCounts, verifyRosterPage } from '../src/components/class-roster/http';
import { RosterView, sessionsFor, type RosterViewProps } from '../src/components/class-roster/view';
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
const sessions = [session(1, 1), session(2, 26, { name: 'Adult class', roomName: null }), session(3, -48, { name: 'Past class', status: 'COMPLETED' })];
const props = (over: Partial<RosterViewProps> = {}): RosterViewProps => ({ language: 'en', timeZone: 'UTC', waiting: false, concealed: false, scope, now: NOW, tab: 'UPCOMING',
  list: { state: 'READY', items: sessions }, selectedId: null, roster: { state: 'NONE' }, ...over });
const ready = (entries: ClassSessionRosterEntry[], over: Record<string, unknown> = {}) => ({ state: 'READY', sessionId: id(71), entries, nextCursor: null,
  more: 'IDLE', restarted: false, ...over }) as RosterViewProps['roster'];
const render = (over: Partial<RosterViewProps> = {}) => renderToStaticMarkup(<RosterView {...props(over)}/>);

it('reads the session list with the human-read header and no query, and a roster page with only limit and cursor', async () => {
  const f = stub(json({ data: [], meta: { requestId: id(5), correlationId: id(5) } }));
  await expect(rosterApi.sessions(scope, signal(), () => true)).resolves.toEqual([]);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/schedule/sessions`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'X-HON-Human-Read': 'class-sessions' } });
  const g = stub(json(page([entry(1)], { nextCursor: 'abc.def' })));
  await expect(rosterApi.roster(scope, id(71).toUpperCase(), null, signal(), () => true)).resolves.toMatchObject({ nextCursor: 'abc.def' });
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/schedule/sessions/${id(71)}/roster?limit=50`);
  const h = stub(json(page([entry(2)])));
  await rosterApi.roster(scope, id(71), 'abc.def', signal(), () => true);
  expect((h.mock.calls[0] as unknown as [string])[0]).toMatch(/\/roster\?limit=50&cursor=abc.def$/);
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
  stub(json({}, 403));
  await expect(rosterApi.sessions(scope, signal(), () => true)).rejects.toMatchObject({ kind: 'DENIED' });
});

it('a 401 for a retired read never ends the session; a current one does', async () => {
  const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(rosterApi.roster(scope, id(71), null, signal(), () => false)).rejects.toBeInstanceOf(RosterError);
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(rosterApi.sessions(scope, signal(), () => false)).rejects.toMatchObject({ kind: 'SESSION' });
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

it('splits classes into upcoming and past locally, and shows list states', () => {
  expect(sessionsFor(sessions, 'UPCOMING', NOW).map((s) => s.name)).toEqual(['Kids class 1', 'Adult class']);
  expect(sessionsFor(sessions, 'PAST', NOW).map((s) => s.name)).toEqual(['Past class']);
  const html = render();
  expect(html).toContain('Kids class 1'); expect(html).not.toContain('Past class'); expect(html).toContain('2 shown'); expect(html).toContain('No room');
  expect(html).toContain('up to 50 classes starting from 30 days ago');
  expect(render({ list: { state: 'DENIED' } })).toContain('does not include the class schedule');
  expect(render({ list: { state: 'UNAVAILABLE' } })).toContain('Nothing is shown');
  expect(render({ list: { state: 'READY', items: [] } })).toContain('No classes here');
});

it('a selected class shows its own roster, counts, a partial note, and links that carry only verified selectors; no form', () => {
  const html = render({ selectedId: id(71), roster: ready([entry(1, { attendance: recorded() }), entry(2, { booking: null, attendance: recorded('LATE') })], { nextCursor: 'c' }) });
  expect(html).toContain('Ana1 Rivera'); expect(html).toContain('Present'); expect(html).toContain('Walk-in (no booking)'); expect(html).toContain('Late');
  expect(html).toContain('Counts cover the 2 students shown'); expect(html).toContain('>Show more</button>');
  expect(html).toContain(`href="/staff/attendance?organizationId=${scope.organizationId}&amp;schoolId=${scope.schoolId}"`);
  expect(html).toContain(`href="/staff/schedule/bookings?organizationId=${scope.organizationId}&amp;schoolId=${scope.schoolId}&amp;sessionId=${id(71)}"`);
  expect(html).not.toMatch(/<form|method="post"/i);
  expect(render({ selectedId: id(72), roster: ready([entry(1)]) })).not.toContain('Ana1');
  expect(render({ selectedId: id(73), tab: 'PAST' })).not.toContain('/staff/schedule/bookings');
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
