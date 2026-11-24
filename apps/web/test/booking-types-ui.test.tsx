import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { BookingTypeError, bookingTypeErrorFor, bookingTypesApi, keepBookingTypeForRetry, publicBookingTypeApi } from '../src/components/booking-types/http';
import { BOOKING_TYPES_COPY, bookingTypesText } from '../src/components/booking-types/copy';
import { BookingTypesView, bookingTypeFormBody, draftFor, embedSnippet, type BookingTypesViewProps } from '../src/components/booking-types/booking-types';
import { PublicBookingTypeView, emptyPublicTypeValues, publicTypeInput, type PublicBookingTypeViewProps } from '../src/components/booking-types/public-booking-type';
import { id } from './account-status-fixtures';

// 0286 PR 2: staff set up repeating booking types; families book through /book/t/<link id> without an account.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), typeId = id(40), bookingId = id(41), key = id(77), scope = { organizationId: org, schoolId: school };
const PUBLIC = 'b'.repeat(48), T = '2026-11-11T09:00:00.000Z', START = '2026-11-21T18:00:00.000Z';
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as BookingTypeError; } throw new Error('expected a failure'); };
const body = { name: 'Belt test reservation', description: 'Saturday testing', template: 'TEST_RESERVATION', durationMinutes: 30, spotsPerTime: 2,
  weeklyHours: [{ day: 6, start: '10:00', end: '12:00' }], horizonDays: 30, noticeHours: 12, audience: 'OPEN',
  questions: [{ label: 'Current belt', kind: 'TEXT', required: true }, { label: 'First test?', kind: 'YES_NO', required: false }], waiver: 'I accept the risks.', thankYou: 'See you there!' };
const type = (over: Record<string, unknown> = {}) => ({ typeId, publicId: PUBLIC, ...body, status: 'ACTIVE', version: 2, upcomingCount: 1, createdAt: T, ...over });
const booking = (over: Record<string, unknown> = {}) => ({ bookingId, startsAt: START, endsAt: '2026-11-21T18:30:00.000Z', localDate: '2026-11-21', localStart: '10:00',
  name: 'Kim Family', email: 'kim@example.test', mobile: null, questions: body.questions, answers: ['Yellow', true], waiverAcceptedAt: T, status: 'BOOKED', cancelledBy: null,
  version: 1, createdAt: T, ...over });
const list = (over: Record<string, unknown> = {}) => ({ localToday: '2026-11-11', timezone: 'America/Los_Angeles', bookingTypes: [type()], ...over });
const detail = (over: Record<string, unknown> = {}) => ({ bookingType: type(), timezone: 'America/Los_Angeles', bookings: [booking()], ...over });

it('reads booking types as plain same-origin GETs under settings, with no key and no x-hon header', async () => {
  const f = stub(json({ data: list(), meta }));
  await expect(bookingTypesApi.list({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true)).resolves.toMatchObject({ bookingTypes: [{ name: 'Belt test reservation' }] });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/settings/booking-types`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const g = stub(json({ data: detail(), meta }));
  await expect(bookingTypesApi.detail(scope, typeId, signal(), () => true)).resolves.toMatchObject({ bookings: [{ name: 'Kim Family' }] });
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/settings/booking-types/${typeId}`);
  stub(json({ data: detail({ bookingType: type({ typeId: id(99) }) }), meta }));
  expect((await fails(bookingTypesApi.detail(scope, typeId, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('each staff command sends its own human command name and an idempotency key, and verifies the receipt', async () => {
  const f = stub(json({ data: { bookingType: type({ status: 'DRAFT', version: 1, upcomingCount: 0 }) }, meta }));
  const input = { expectedVersion: 0, ...body };
  await bookingTypesApi.send(scope, { action: 'create', input: input as never }, key, signal(), () => true);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/settings/booking-types`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'Idempotency-Key': key, 'X-HON-Human-Command': 'schedule.booking_type.save' } });
  expect(JSON.parse(String(init.body))).toEqual(input);
  const e = stub(json({ data: { bookingType: type({ version: 3 }) }, meta }));
  await bookingTypesApi.send(scope, { action: 'edit', typeId, input: { ...input, expectedVersion: 2 } as never }, key, signal(), () => true);
  expect(e.mock.calls[0]).toMatchObject([`/api/v1/organizations/${org}/schools/${school}/settings/booking-types/${typeId}/edit`, { headers: { 'X-HON-Human-Command': 'schedule.booking_type.save' } }]);
  const g = stub(json({ data: { bookingType: type({ status: 'PAUSED', version: 3 }) }, meta }));
  await bookingTypesApi.send(scope, { action: 'status', typeId, input: { expectedVersion: 2, status: 'PAUSED' } }, key, signal(), () => true);
  expect(g.mock.calls[0]).toMatchObject([`/api/v1/organizations/${org}/schools/${school}/settings/booking-types/${typeId}/status`, { headers: { 'X-HON-Human-Command': 'schedule.booking_type.status' } }]);
  const h = stub(json({ data: { booking: booking({ status: 'ARRIVED', version: 2 }) }, meta }));
  await bookingTypesApi.bookingStatus(scope, bookingId, { expectedVersion: 1, status: 'ARRIVED' }, key, signal(), () => true);
  expect(h.mock.calls[0]).toMatchObject([`/api/v1/organizations/${org}/schools/${school}/settings/booking-types/bookings/${bookingId}/status`, { headers: { 'X-HON-Human-Command': 'schedule.booking_type.booking_status' } }]);
  const none = stub(json({}));
  expect((await fails(bookingTypesApi.send(scope, { action: 'create', input: { ...input, expectedVersion: 1 } as never }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(bookingTypesApi.send(scope, { action: 'create', input: input as never }, 'not-a-uuid', signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps refused answers to closed kinds, and only an unknown outcome is kept for an identical retry', async () => {
  expect(bookingTypeErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(bookingTypeErrorFor(409, 'SCHOOL_BOOKING_TYPE_LIMIT').kind).toBe('REFUSED');
  expect(bookingTypeErrorFor(409, 'SCHOOL_BOOKING_TYPE_SPOTS_BELOW_BOOKED').kind).toBe('REFUSED');
  expect(bookingTypeErrorFor(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('INVALID');
  expect(bookingTypeErrorFor(409, 'SOMETHING_ELSE').kind).toBe('UNKNOWN');
  expect(bookingTypeErrorFor(422, 'SCHOOL_BOOKING_TYPE_NO_TIMES').kind).toBe('NO_TIMES');
  expect(bookingTypeErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepBookingTypeForRetry(new BookingTypeError('UNKNOWN'))).toBe(true);
  expect(keepBookingTypeForRetry(new BookingTypeError('REFUSED'))).toBe(false);
  const events: Event[] = [];
  window.addEventListener(HON_SESSION_INVALIDATED_EVENT, (e) => events.push(e));
  stub(json({ code: 'UNAUTHENTICATED' }, 401));
  expect((await fails(bookingTypesApi.list(scope, signal(), () => true))).kind).toBe('SESSION');
  expect(events).toHaveLength(1);
});

it('builds the form body from the draft, with weekly hours and questions, and refuses what the server would refuse', () => {
  const read = list() as never;
  const draft = draftFor(type() as never);
  expect(bookingTypeFormBody({ kind: 'edit', typeId }, { ...draft, spotsPerTime: '4' }, read)).toEqual({ action: 'edit', typeId, input: { expectedVersion: 2, ...body, spotsPerTime: 4 } });
  const fresh = draftFor(null);
  expect(bookingTypeFormBody({ kind: 'create' }, { ...fresh, name: ' Parent meeting ', template: 'PARENT_MEETING' }, read)).toMatchObject({ action: 'create',
    input: { expectedVersion: 0, name: 'Parent meeting', template: 'PARENT_MEETING', weeklyHours: [{ day: 6, start: '10:00', end: '12:00' }], questions: [] } });
  const bad = (patch: Record<string, unknown>) => () => bookingTypeFormBody({ kind: 'create' }, { ...fresh, name: 'X', ...patch } as never, read);
  expect(bad({ durationMinutes: '5' })).toThrow(expect.objectContaining({ kind: 'INVALID' }));
  expect(bad({ weeklyHours: [] })).toThrow();
  expect(bad({ weeklyHours: [{ day: '1', start: '10:00', end: '11:00' }, { day: '1', start: '10:30', end: '12:00' }] })).toThrow();
  expect(bad({ weeklyHours: [{ day: '1', start: '10:00', end: '10:10' }] })).toThrow();
  expect(bad({ questions: [{ label: '', kind: 'TEXT', required: false }] })).toThrow();
  expect(() => bookingTypeFormBody({ kind: 'edit', typeId }, draft, list({ bookingTypes: [type({ status: 'ARCHIVED' })] }) as never)).toThrow();
});

const props = (over: Partial<BookingTypesViewProps> = {}): BookingTypesViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true, origin: 'https://app.example.test',
  list: { state: 'READY', read: list() as never }, selected: null, detail: null, form: null, outcome: null, locked: false, canRetry: false, ...over });

it('shows the list, an open type with its bookings, answers, link, embed and the actions its status allows', () => {
  const html = renderToStaticMarkup(<BookingTypesView {...props()}/>);
  expect(html).toContain('Belt test reservation');
  expect(html).toContain('Taking bookings');
  expect(html).toContain('30 minutes, 2 per time, 1 upcoming');
  expect(html).toContain('Saturday 10:00–12:00');
  const open = renderToStaticMarkup(<BookingTypesView {...props({ selected: typeId, detail: { state: 'READY', read: detail() as never } })}/>);
  expect(open).toContain(`https://app.example.test/book/t/${PUBLIC}`);
  expect(open).toContain('Kim Family');
  expect(open).toContain('Current belt: Yellow');
  expect(open).toContain('First test?: Yes');
  expect(open).toContain('Waiver accepted');
  expect(open).toContain('>Pause<');
  expect(open).toContain('>Archive<');
  expect(open).not.toContain('Start taking bookings');
  expect(open).toContain('&lt;a href=&quot;https://app.example.test/book/t/');
  const draft = renderToStaticMarkup(<BookingTypesView {...props({ list: { state: 'READY', read: list({ bookingTypes: [type({ status: 'DRAFT', version: 1 })] }) as never }, selected: typeId,
    detail: { state: 'READY', read: detail({ bookingType: type({ status: 'DRAFT', version: 1 }), bookings: [] }) as never } })}/>);
  expect(draft).toContain('Start taking bookings');
  expect(draft).not.toContain('type-link');
  expect(draft).toContain('No upcoming bookings.');
  const paused = renderToStaticMarkup(<BookingTypesView {...props({ list: { state: 'READY', read: list({ bookingTypes: [type({ status: 'PAUSED' })] }) as never }, selected: typeId })}/>);
  expect(paused).toContain('>Resume<');
  const archived = renderToStaticMarkup(<BookingTypesView {...props({ list: { state: 'READY', read: list({ bookingTypes: [type({ status: 'ARCHIVED' })] }) as never }, selected: typeId })}/>);
  expect(archived).not.toContain('>Edit<');
  expect(archived).not.toContain('>Archive<');
  const arrived = renderToStaticMarkup(<BookingTypesView {...props({ selected: typeId, detail: { state: 'READY', read: detail({ bookings: [booking({ status: 'ARRIVED', version: 2 }),
    booking({ bookingId: id(42), status: 'CANCELLED', cancelledBy: 'FAMILY' })] }) as never } })}/>);
  expect(arrived).toContain('Undo arrived');
  expect(arrived).toContain('cancelled by the family');
});

it('the form shows weekly hours and questions, and the page conceals, waits and reports outcomes', () => {
  const form = renderToStaticMarkup(<BookingTypesView {...props({ form: { kind: 'edit', typeId } })}/>);
  expect(form).toContain('Edit: Belt test reservation');
  expect(form.match(/data-testid="type-window"/g)).toHaveLength(1);
  expect(form.match(/data-testid="type-question"/g)).toHaveLength(2);
  expect(form).toContain('never cancels a booking');
  expect(renderToStaticMarkup(<BookingTypesView {...props({ concealed: true })}/>)).not.toContain('Belt test');
  expect(renderToStaticMarkup(<BookingTypesView {...props({ waiting: true })}/>)).toContain('Checking your school');
  expect(renderToStaticMarkup(<BookingTypesView {...props({ list: { state: 'DENIED' } })}/>)).toContain('class schedule manage permission');
  expect(renderToStaticMarkup(<BookingTypesView {...props({ outcome: { kind: 'UNKNOWN' }, canRetry: true })}/>)).toContain('Try again');
  expect(renderToStaticMarkup(<BookingTypesView {...props({ outcome: { kind: 'NO_TIMES' } })}/>)).toContain('no bookable times');
  expect(renderToStaticMarkup(<BookingTypesView {...props({ language: 'ko' })}/>)).toContain('예약 유형');
  expect(embedSnippet('https://x.test/book/t/1', 'A "B" <c>')).toBe('<a href="https://x.test/book/t/1" target="_blank" rel="noopener">A &quot;B&quot; &lt;c&gt;</a>');
});

const view = (over: Record<string, unknown> = {}) => ({ publicId: PUBLIC, schoolName: 'Apex Dojo',
  branding: { logoUrl: null, coverUrl: null, accentColor: '#aa0000', contactLine: 'Call 555-0100' }, name: 'Belt test reservation', description: 'Saturday testing',
  template: 'TEST_RESERVATION', durationMinutes: 30, audience: 'OPEN', questions: body.questions, waiver: 'I accept the risks.', timezone: 'America/Los_Angeles', status: 'OPEN',
  times: [{ startsAt: START, localDate: '2026-11-21', localStart: '10:00', localEnd: '10:30', spotsLeft: 2 },
    { startsAt: '2026-11-21T18:30:00.000Z', localDate: '2026-11-21', localStart: '10:30', localEnd: '11:00', spotsLeft: 0 }], ...over });

it('family side: reads with no cookie, books with the given key and the type rules, and treats anything unexpected as unavailable', async () => {
  const f = stub(json({ data: view() }));
  await expect(publicBookingTypeApi.read(PUBLIC, signal())).resolves.toMatchObject({ name: 'Belt test reservation' });
  expect(f.mock.calls[0]).toMatchObject([`/api/v1/public/booking-types/${PUBLIC}`, { method: 'GET', credentials: 'omit' }]);
  stub(json({ data: view(), meta }));
  await expect(publicBookingTypeApi.read(PUBLIC, signal())).resolves.toBe('UNAVAILABLE');
  stub(json({ result: 'INVALID' }, 404));
  await expect(publicBookingTypeApi.read(PUBLIC, signal())).resolves.toBe('NOT_FOUND');
  const read = view() as never;
  const values = { ...emptyPublicTypeValues(2), startsAt: START, name: ' Kim Family ', email: 'Kim@Example.test', answers: [' Yellow ', null], waiverAccepted: true };
  const input = publicTypeInput(read, values);
  expect(input).toEqual({ startsAt: START, name: 'Kim Family', email: 'Kim@Example.test', mobile: '', answers: ['Yellow', null], waiverAccepted: true, website: '' });
  const bookKey = 'k'.repeat(32);
  const g = stub(json({ result: 'BOOKED', code: 'ABCDEF012345', startsAt: START, localDate: '2026-11-21', localStart: '10:00', thankYou: 'See you there!', status: 'BOOKED' }, 201));
  await expect(publicBookingTypeApi.book(PUBLIC, read, input, bookKey, signal())).resolves.toMatchObject({ result: 'BOOKED', thankYou: 'See you there!' });
  expect(g.mock.calls[0]).toMatchObject([`/api/v1/public/booking-types/${PUBLIC}/bookings`, { method: 'POST', credentials: 'omit', headers: { 'Idempotency-Key': bookKey } }]);
  expect(JSON.parse(String((g.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ email: 'kim@example.test' });
  const none = stub(json({}));
  await expect(publicBookingTypeApi.book(PUBLIC, read, { ...input, answers: ['', null] }, bookKey, signal())).resolves.toEqual({ result: 'INVALID' });
  await expect(publicBookingTypeApi.book(PUBLIC, read, { ...input, waiverAccepted: false }, bookKey, signal())).resolves.toEqual({ result: 'INVALID' });
  await expect(publicBookingTypeApi.book(PUBLIC, read, { ...input, website: 'spam' }, bookKey, signal())).resolves.toEqual({ result: 'INVALID' });
  expect(none).not.toHaveBeenCalled();
  const h = stub(json({ result: 'CANCELLED' }));
  await expect(publicBookingTypeApi.cancel(PUBLIC, 'abcd-ef01-2345', signal())).resolves.toBe('CANCELLED');
  expect(h.mock.calls[0]).toMatchObject([`/api/v1/public/booking-types/${PUBLIC}/cancellations`, { method: 'POST', credentials: 'omit', body: '{"code":"ABCDEF012345"}' }]);
});

const pub = (over: Partial<PublicBookingTypeViewProps> = {}): PublicBookingTypeViewProps => ({ language: 'en', busy: false, booking: null, cancel: null, code: '',
  values: emptyPublicTypeValues(2), read: view() as never, ...over });

it('family page: branding, times by day with spots left only, questions and waiver, then the thank-you and the code', () => {
  const html = renderToStaticMarkup(<PublicBookingTypeView {...pub()}/>);
  expect(html).toContain('Apex Dojo');
  expect(html).toContain('Call 555-0100');
  expect(html).toContain('#aa0000');
  expect(html).toContain('Saturday, November 21');
  expect(html).toContain('10:00–10:30 (2 left)');
  expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="2026-11-21T18:30:00.000Z"/);
  expect(html).toContain('Current belt');
  expect(html).toContain('First test?');
  expect(html).toContain('I accept the risks.');
  expect(html).toContain('name="website"');
  const booked = renderToStaticMarkup(<PublicBookingTypeView {...pub({ booking: { result: 'BOOKED', code: 'ABCDEF012345', startsAt: START, localDate: '2026-11-21', localStart: '10:00',
    thankYou: 'See you there!', status: 'BOOKED' } })}/>);
  expect(booked).toContain('Keep this code to cancel: ABCD-EF01-2345');
  expect(booked).toContain('See you there!');
  expect(booked).not.toContain('public-type-form');
  const families = renderToStaticMarkup(<PublicBookingTypeView {...pub({ read: view({ audience: 'FAMILIES_ONLY', times: [] }) as never })}/>);
  expect(families).toContain('Sign in to the HON parent app');
  expect(families).not.toContain('public-type-form');
  expect(renderToStaticMarkup(<PublicBookingTypeView {...pub({ read: view({ status: 'PAUSED', times: [] }) as never })}/>)).toContain('not taking bookings right now');
  expect(renderToStaticMarkup(<PublicBookingTypeView {...pub({ read: view({ times: [] }) as never })}/>)).toContain('No times are open');
  expect(renderToStaticMarkup(<PublicBookingTypeView {...pub({ booking: { result: 'ALREADY_BOOKED' } })}/>)).toContain('already has an upcoming booking');
  expect(renderToStaticMarkup(<PublicBookingTypeView {...pub({ read: 'NOT_FOUND' })}/>)).toContain('This booking link is not available.');
  expect(renderToStaticMarkup(<PublicBookingTypeView {...pub({ cancel: 'STARTED' })}/>)).toContain('already started');
});

it('Booking types is in the settings nav and route list, and every wording key has the same {placeholders} in all three languages', () => {
  expect(SCHOOL_SHELL_NAV.flatMap((g) => g.routes.map((r) => r.href))).toContain('/staff/settings/booking-types');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.filter((r) => r.path === '/staff/settings/booking-types' || r.path === '/book/t/:publicId')).toHaveLength(2);
  const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const keys = Object.keys(BOOKING_TYPES_COPY.en) as (keyof typeof BOOKING_TYPES_COPY.en)[];
  for (const lang of ['ko', 'es'] as const) {
    expect(Object.keys(BOOKING_TYPES_COPY[lang]).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(vars(BOOKING_TYPES_COPY[lang][k]), `${lang}.${k}`).toBe(vars(BOOKING_TYPES_COPY.en[k]));
  }
  expect(bookingTypesText('fr', 'full')).toBe('Full');
});
