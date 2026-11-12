import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { SeriesError, classSeriesApi, keepForRetry, seriesErrorFor } from '../src/components/class-series/http';
import { seriesBody } from '../src/components/class-series/class-series';
import { ClassSeriesView, effectText, type ClassSeriesViewProps } from '../src/components/class-series/view';
import { id } from './account-status-fixtures';

// B-SCH-1 (0239): the staff weekly timetable reads one school week; managers also create, change, end and fill class series.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), seriesId = id(30), programId = id(31), sessionId = id(40), key = id(77), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as SeriesError; } throw new Error('expected a failure'); };
const series = (over: Record<string, unknown> = {}) => ({ seriesId, programId, name: 'Adult Karate', roomName: 'Main mat', capacity: 20, bookingPolicy: 'OPTIONAL_BOOKING',
  weekdays: [1, 3], localStartTime: '18:00', durationMinutes: 60, startsOn: '2026-11-09', endsOn: null, generatedThrough: '2026-12-06', status: 'ACTIVE', endReason: null,
  version: 2, ongoing: false, futureSessions: 8, createdAt: '2026-11-09T08:00:00.000Z', ...over });
const listRaw = (over: Record<string, unknown> = {}) => ({ localToday: '2026-11-09', timezone: 'America/Los_Angeles', fillLimit: '2027-02-01', topUpDue: false, series: [series()],
  programs: [{ programId, name: 'Adult Karate' }], ...over });
const session = (over: Record<string, unknown> = {}) => ({ sessionId, seriesId, name: 'Adult Karate', roomName: 'Main mat', startsAt: '2026-11-12T02:00:00.000Z',
  endsAt: '2026-11-12T03:00:00.000Z', localDate: '2026-11-11', localStart: '18:00', localEnd: '19:00', capacity: 20, bookingPolicy: 'OPTIONAL_BOOKING', status: 'SCHEDULED', booked: 3, ...over });
const weekRaw = (over: Record<string, unknown> = {}) => ({ timezone: 'America/Los_Angeles', localToday: '2026-11-09', weekStart: '2026-11-09', weekEnd: '2026-11-15',
  truncated: false, sessions: [session()], ...over });
const effect = { created: 8, updated: 0, cancelled: 0, keptBooked: 0, skippedDates: [] };

it('reads the timetable and the series as plain same-origin GETs with no key and no x-hon header', async () => {
  const f = stub(json({ data: weekRaw(), meta }));
  const week = await classSeriesApi.timetable({ organizationId: org.toUpperCase(), schoolId: school }, null, signal(), () => true);
  expect(week.sessions[0]?.booked).toBe(3);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/schedule/timetable`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const g = stub(json({ data: weekRaw({ weekStart: '2026-11-16', weekEnd: '2026-11-22', sessions: [] }), meta }));
  await classSeriesApi.timetable(scope, '2026-11-18', signal(), () => true);
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/schedule/timetable?weekOf=2026-11-18`);
  const h = stub(json({ data: listRaw(), meta }));
  await expect(classSeriesApi.list(scope, signal(), () => true)).resolves.toMatchObject({ series: [{ name: 'Adult Karate' }] });
  expect((h.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/schedule/class-series`);
});

it('refuses drifted reads: a week that is not Monday to Sunday, another week, a session outside it, an ended series without a reason', async () => {
  stub(json({ data: weekRaw({ weekStart: '2026-11-10', weekEnd: '2026-11-16' }), meta }));
  expect((await fails(classSeriesApi.timetable(scope, null, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: weekRaw(), meta }));
  expect((await fails(classSeriesApi.timetable(scope, '2026-11-20', signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: weekRaw({ sessions: [session({ localDate: '2026-11-16' })] }), meta }));
  expect((await fails(classSeriesApi.timetable(scope, null, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: listRaw({ series: [series({ status: 'ENDED', endsOn: '2026-11-20' })] }), meta }));
  expect((await fails(classSeriesApi.list(scope, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: listRaw({ extra: 1 }), meta }));
  expect((await fails(classSeriesApi.list(scope, signal(), () => true))).kind).toBe('UNKNOWN');
  await expect(fails(classSeriesApi.timetable(scope, '2026-02-30', signal(), () => true))).resolves.toMatchObject({ kind: 'INVALID' });
});

it('sends each command with its own human-command header, key and path, and verifies the receipt', async () => {
  const create = { programId, startsOn: '2026-11-09', name: 'Kids', roomName: null, capacity: 12, bookingPolicy: 'WALK_IN' as const, weekdays: [2, 4], localStartTime: '16:30', durationMinutes: 45, endsOn: null };
  const f = stub(json({ data: { series: series({ version: 1, generatedThrough: null, futureSessions: 0 }), sessions: { ...effect, created: 0 } }, meta: { ...meta, replayed: false } }));
  await expect(classSeriesApi.send(scope, { action: 'create', input: create }, key, signal(), () => true)).resolves.toMatchObject({ series: { version: 1 } });
  let [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/schedule/class-series`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'schedule.series.create', 'Idempotency-Key': key, 'Content-Type': 'application/json' } });
  expect(JSON.parse(String(init.body))).toEqual(create);
  for (const [action, input, header] of [['fill', { expectedVersion: 2, throughDate: '2026-12-06' }, 'schedule.series.fill'],
    ['end', { expectedVersion: 2, lastDate: '2026-11-30', reason: 'Term ends' }, 'schedule.series.end']] as const) {
    const g = stub(json({ data: { series: series(), sessions: effect }, meta }));
    await classSeriesApi.send(scope, { action, seriesId, input } as never, key, signal(), () => true);
    [path, init] = g.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/schedule/class-series/${seriesId}/${action}`);
    expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': header, 'Idempotency-Key': key } });
    expect(JSON.parse(String(init.body))).toEqual(input);
  }
  // A receipt for another series is never accepted as success.
  stub(json({ data: { series: series({ seriesId: id(33) }), sessions: effect }, meta }));
  expect((await fails(classSeriesApi.send(scope, { action: 'fill', seriesId, input: { expectedVersion: 2, throughDate: '2026-12-06' } }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  // Bad input or key never reaches the network.
  const none = stub(json({}, 500));
  expect((await fails(classSeriesApi.send(scope, { action: 'create', input: { ...create, weekdays: [] } }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(classSeriesApi.send(scope, { action: 'fill', seriesId, input: { expectedVersion: 2, throughDate: '2026-12-06' } }, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps only exact refusals to definite kinds; anything else keeps the key for an identical retry', async () => {
  expect(seriesErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(seriesErrorFor(409, 'CLASS_SERIES_ENDED').kind).toBe('ENDED');
  expect(seriesErrorFor(422, 'CLASS_SERIES_FILL_TOO_FAR').kind).toBe('TOO_FAR');
  expect(seriesErrorFor(409, 'SCHOOL_TIMEZONE_INVALID').kind).toBe('TIMEZONE');
  expect(seriesErrorFor(403, null).kind).toBe('DENIED');
  expect(seriesErrorFor(404, 'PROGRAM_NOT_FOUND').kind).toBe('GONE');
  expect(seriesErrorFor(409, 'CLASS_SERIES_CONFLICT').kind).toBe('UNKNOWN');
  expect(seriesErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new SeriesError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new SeriesError('CHANGED'))).toBe(false);
  const events: string[] = []; (globalThis.window as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, () => events.push('ended'));
  stub(json({}, 401));
  expect((await fails(classSeriesApi.list(scope, signal(), () => true))).kind).toBe('SESSION');
  stub(json({}, 401));
  expect((await fails(classSeriesApi.list(scope, signal(), () => false))).kind).toBe('SESSION');
  expect(events).toEqual(['ended']);
});

it('builds bodies from the verified series only: its version, school-local dates and the 12-week limit', () => {
  const read = listRaw() as never;
  const fields = { programId, startsOn: '2026-11-09', name: ' Kids ', roomName: '', weekdays: '4,2', localStartTime: '16:30', durationMinutes: '45', capacity: '12', bookingPolicy: 'WALK_IN', endsOn: '' };
  expect(seriesBody('create', fields, read, null)).toEqual({ action: 'create', input: { programId, startsOn: '2026-11-09', name: 'Kids', roomName: null, capacity: 12,
    bookingPolicy: 'WALK_IN', weekdays: [2, 4], localStartTime: '16:30', durationMinutes: 45, endsOn: null } });
  expect(() => seriesBody('create', { ...fields, startsOn: '2026-11-01' }, read, null)).toThrow();
  expect(() => seriesBody('create', { ...fields, weekdays: '' }, read, null)).toThrow();
  expect(() => seriesBody('create', { ...fields, durationMinutes: '4' }, read, null)).toThrow();
  expect(seriesBody('fill', { throughDate: '2026-12-06' }, read, seriesId)).toEqual({ action: 'fill', seriesId, input: { expectedVersion: 2, throughDate: '2026-12-06' } });
  expect(() => seriesBody('fill', { throughDate: '2027-02-02' }, read, seriesId)).toThrow();
  expect(() => seriesBody('fill', { throughDate: '2026-11-08' }, read, seriesId)).toThrow();
  expect(seriesBody('end', { lastDate: '2026-11-30', reason: ' Term ends ' }, read, seriesId)).toEqual({ action: 'end', seriesId, input: { expectedVersion: 2, lastDate: '2026-11-30', reason: 'Term ends' } });
  expect(() => seriesBody('end', { lastDate: '2026-11-07', reason: 'x' }, read, seriesId)).toThrow();
  expect(seriesBody('revise', { ...fields, weekdays: '1' }, read, seriesId)).toMatchObject({ action: 'revise', seriesId, input: { expectedVersion: 2, weekdays: [1] } });
  expect(() => seriesBody('fill', { throughDate: '2026-12-06' }, listRaw({ series: [series({ status: 'ENDED', endsOn: '2026-11-20', endReason: 'Done' })] }) as never, seriesId)).toThrow();
  expect(() => seriesBody('fill', { throughDate: '2026-12-06' }, read, id(99))).toThrow();
});

const props = (over: Partial<ClassSeriesViewProps> = {}): ClassSeriesViewProps => ({ language: 'en-US', waiting: false, concealed: false, hasSchool: true,
  week: { state: 'READY', read: weekRaw() as never }, series: { state: 'READY', read: listRaw() as never }, form: null, outcome: null, locked: false, canRetry: false, ...over });

it('shows the school week day by day, the series with their actions, and each form', () => {
  const page = renderToStaticMarkup(<ClassSeriesView {...props()}/>);
  expect(page).toContain('Monday, Nov 9 (today)');
  expect(page).toContain('18:00–19:00 Adult Karate · Main mat · 3/20 booked');
  expect(page).toContain('No classes.');
  expect(page).toContain('Mon, Wed at 18:00 for 60 min');
  expect(page).toContain('8 upcoming sessions');
  expect(page).toContain('Create sessions');
  expect(page).toContain('never moves or cancels a session that already has bookings');
  const fill = renderToStaticMarkup(<ClassSeriesView {...props({ form: { kind: 'fill', seriesId } })}/>);
  expect(fill).toContain('data-testid="series-form"'); expect(fill).toContain('max="2027-02-01"'); expect(fill).toContain('min="2026-11-09"');
  const create = renderToStaticMarkup(<ClassSeriesView {...props({ form: { kind: 'create' } })}/>);
  expect(create).toContain('Choose a program'); expect(create).toContain('min="2026-11-02"');
  const revise = renderToStaticMarkup(<ClassSeriesView {...props({ form: { kind: 'revise', seriesId } })}/>);
  expect(revise).toContain('value="Adult Karate"'); expect(revise).toContain('Sessions with bookings or attendance stay as they are');
  const ended = renderToStaticMarkup(<ClassSeriesView {...props({ series: { state: 'READY', read: listRaw({ series: [series({ status: 'ENDED', endsOn: '2026-11-20', endReason: 'Term ends' })] }) as never } })}/>);
  expect(ended).toContain('ended (Term ends)'); expect(ended).not.toContain('>End<');
  const reader = renderToStaticMarkup(<ClassSeriesView {...props({ series: { state: 'DENIED' } })}/>);
  expect(reader).toContain('18:00–19:00'); expect(reader).toContain('needs the class schedule manage permission'); expect(reader).not.toContain('New class series');
});

it('shows each outcome plainly and offers Try again only for a kept request', () => {
  expect(effectText('revise', { created: 0, updated: 3, cancelled: 2, keptBooked: 1, skippedDates: [] }, 'en-US'))
    .toBe('Saved. 3 sessions updated; 2 unbooked sessions cancelled; 1 booked session kept as it was. The page was read again from the server.');
  expect(effectText('fill', { created: 0, updated: 0, cancelled: 0, keptBooked: 0, skippedDates: [] }, 'en-US')).toContain('No new sessions were needed');
  expect(effectText('fill', { created: 3, updated: 0, cancelled: 0, keptBooked: 0, skippedDates: ['2027-03-14'] }, 'en-US')).toContain('start time does not exist that day: Mar 14, 2027');
  expect(renderToStaticMarkup(<ClassSeriesView {...props({ concealed: true })}/>)).not.toContain('Adult Karate');
  expect(renderToStaticMarkup(<ClassSeriesView {...props({ hasSchool: false })}/>)).toContain('Choose a school');
  expect(renderToStaticMarkup(<ClassSeriesView {...props({ week: { state: 'DENIED' } })}/>)).toContain('class schedule read permission');
  const unknown = renderToStaticMarkup(<ClassSeriesView {...props({ outcome: { kind: 'UNKNOWN', action: 'fill' }, canRetry: true })}/>);
  expect(unknown).toContain('never be applied twice'); expect(unknown).toContain('Try again');
  const far = renderToStaticMarkup(<ClassSeriesView {...props({ outcome: { kind: 'TOO_FAR', action: 'fill' } })}/>);
  expect(far).toContain('up to 12 weeks ahead'); expect(far).not.toContain('Try again');
});

it('is a protected dynamic noindex page in the classes menu and the route manifest', () => {
  const page = readFileSync('src/app/staff/schedule/timetable/page.tsx', 'utf8');
  expect(page).toContain("export const dynamic = 'force-dynamic'"); expect(page).toContain('requireVerifiedWebSession'); expect(page).toContain('index: false');
  expect(page).not.toMatch(/searchParams|organizationId|schoolId|fetch\(/);
  expect(schoolShellActiveRoute('/staff/schedule/timetable')?.href).toBe('/staff/schedule/timetable');
  expect(SCHOOL_SHELL_NAV.find((n) => n.key === 'classes')?.routes.some((r) => r.href === '/staff/schedule/timetable')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/schedule/timetable')).toEqual([{ path: '/staff/schedule/timetable', title: 'HON | Weekly timetable' }]);
});

it('shows the timetable and series page in Korean and Spanish, with dates in that language and no English left behind', () => {
  const ko = renderToStaticMarkup(<ClassSeriesView {...props({ language: 'ko' })}/>);
  expect(ko).toContain('주간 시간표');
  expect(ko).toContain('(오늘)');
  expect(ko).toContain('3/20명 예약');
  expect(ko).toContain('월, 수 18:00, 60분');
  expect(ko).toContain('최대 12주 후');
  expect(ko).toContain('예정된 수업 8개');
  expect(ko).not.toMatch(/Weekly timetable|booked|upcoming|No classes|Refresh/);
  const es = renderToStaticMarkup(<ClassSeriesView {...props({ language: 'es-MX', form: { kind: 'fill', seriesId } })}/>);
  expect(es).toContain('Horario semanal');
  expect(es).toContain('(hoy)');
  expect(es).toContain('3/20 reservadas');
  expect(es).toContain('lun, mié a las 18:00 durante 60 min');
  expect(es).toContain('como máximo 12 semanas por adelantado');
  expect(es).not.toMatch(/Weekly timetable|booked|upcoming|Create through|Refresh/);
  expect(effectText('revise', { created: 0, updated: 1, cancelled: 2, keptBooked: 1, skippedDates: [] }, 'es'))
    .toBe('Guardado. 1 sesión actualizada; 2 sesiones sin reservas canceladas; 1 sesión con reservas se mantuvo igual. La página se volvió a leer del servidor.');
  expect(effectText('fill', { created: 0, updated: 0, cancelled: 0, keptBooked: 0, skippedDates: [] }, 'ko')).toBe('저장했습니다. 새로 만들 수업이 없었습니다. 서버에서 페이지를 다시 읽었습니다.');
  const unknownKo = renderToStaticMarkup(<ClassSeriesView {...props({ language: 'ko', outcome: { kind: 'TOO_FAR', action: 'fill' } })}/>);
  expect(unknownKo).toContain('최대 12주 후까지');
});

it('ongoing series (0251): the switch and the top-up are their own commands, and the page shows both plainly', async () => {
  const f = stub(json({ data: { series: series({ ongoing: true, version: 3 }), sessions: { ...effect, created: 24 } }, meta: { ...meta, replayed: false } }));
  await expect(classSeriesApi.send(scope, { action: 'ongoing', seriesId, input: { expectedVersion: 2, ongoing: true } }, key, signal(), () => true))
    .resolves.toMatchObject({ series: { ongoing: true }, sessions: { created: 24 } });
  let [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/schedule/class-series/${seriesId}/ongoing`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'schedule.series.ongoing', 'Idempotency-Key': key } });
  expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 2, ongoing: true });
  const g = stub(json({ data: { series: 1, created: 2, skippedDates: [] }, meta: { ...meta, replayed: false } }));
  await expect(classSeriesApi.topUp(scope, key, signal(), () => true)).resolves.toEqual({ series: 1, created: 2, skippedDates: [] });
  [path, init] = g.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/schedule/class-series/top-up`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'schedule.series.top_up', 'Idempotency-Key': key } });
  expect(JSON.parse(String(init.body))).toEqual({});
  stub(json({ data: { series: 1, created: 2, skippedDates: [], extra: true }, meta }));
  expect((await fails(classSeriesApi.topUp(scope, key, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: listRaw({ topUpDue: 'yes' }), meta }));
  expect((await fails(classSeriesApi.list(scope, signal(), () => true))).kind).toBe('UNKNOWN');

  // The switch flips what the verified read showed, at its version.
  expect(seriesBody('ongoing', {}, listRaw() as never, seriesId)).toEqual({ action: 'ongoing', seriesId, input: { expectedVersion: 2, ongoing: true } });
  expect(seriesBody('ongoing', {}, listRaw({ series: [series({ ongoing: true })] }) as never, seriesId)).toEqual({ action: 'ongoing', seriesId, input: { expectedVersion: 2, ongoing: false } });

  const off = renderToStaticMarkup(<ClassSeriesView {...props()}/>);
  expect(off).toContain('Make ongoing');
  expect(off).toContain('An ongoing series fills itself');
  expect(off).not.toContain('Adult Karate</strong> · ongoing');
  const on = renderToStaticMarkup(<ClassSeriesView {...props({ series: { state: 'READY', read: listRaw({ series: [series({ ongoing: true })] }) as never } })}/>);
  expect(on).toContain('Adult Karate</strong> · ongoing');
  expect(on).toContain('Stop ongoing');
  const form = renderToStaticMarkup(<ClassSeriesView {...props({ form: { kind: 'ongoing', seriesId } })}/>);
  expect(form).toContain('Make the series ongoing: Adult Karate');
  expect(form).toContain('up to 12 weeks ahead now');
  expect(form).toContain('Nothing contacts families or charges anyone');
  const stop = renderToStaticMarkup(<ClassSeriesView {...props({ form: { kind: 'ongoing', seriesId }, series: { state: 'READY', read: listRaw({ series: [series({ ongoing: true })] }) as never } })}/>);
  expect(stop).toContain('Every session already created stays as it is');
  expect(renderToStaticMarkup(<ClassSeriesView {...props({ topUp: { state: 'SENDING' } })}/>)).toContain('Creating the next sessions of ongoing classes');
  expect(renderToStaticMarkup(<ClassSeriesView {...props({ topUp: { state: 'DONE', created: 3 } })}/>)).toContain('3 new sessions were created for ongoing classes.');
  expect(renderToStaticMarkup(<ClassSeriesView {...props({ topUp: { state: 'DONE', created: 0 } })}/>)).not.toContain('series-top-up');
  expect(renderToStaticMarkup(<ClassSeriesView {...props({ topUp: { state: 'FAILED' } })}/>)).toContain('tried again the next time this page opens');
  expect(renderToStaticMarkup(<ClassSeriesView {...props({ language: 'ko', topUp: { state: 'DONE', created: 1 } })}/>)).toContain('새 수업 1개를 만들었습니다');
  expect(renderToStaticMarkup(<ClassSeriesView {...props({ language: 'es', topUp: { state: 'DONE', created: 1 } })}/>)).toContain('Se creó 1 sesión nueva');
});

it('every copy key has the same {placeholders} in English, Korean and Spanish', () => {
  const source = readFileSync(new URL('../src/components/class-series/copy.ts', import.meta.url), 'utf8');
  const block = (name: string) => source.split(`const ${name}`)[1]!.split('\n};')[0]!;
  const keys = (text: string) => new Map([...text.matchAll(/(\w+): '((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1]!, [...m[2]!.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(',')]));
  const en = keys(block('en')), ko = keys(block('ko')), es = keys(block('es'));
  expect(en.size).toBeGreaterThan(100);
  expect([...ko.keys()].sort()).toEqual([...en.keys()].sort());
  expect([...es.keys()].sort()).toEqual([...en.keys()].sort());
  for (const [key, vars] of en) { expect(ko.get(key), key).toBe(vars); expect(es.get(key), key).toBe(vars); }
});
