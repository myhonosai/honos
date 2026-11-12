import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { EventError, eventErrorFor, keepEventForRetry, publicEventApi, schoolEventsApi } from '../src/components/school-events/http';
import { EVENTS_COPY, eventsText } from '../src/components/school-events/copy';
import { SchoolEventsView, eventFormBody, type SchoolEventsViewProps } from '../src/components/school-events/school-events';
import { PublicEventView, type PublicEventViewProps } from '../src/components/school-events/public-event';
import { id } from './account-status-fixtures';

// B-SCH-3 (0261): staff run one-day events with bookable slots; families book through a public link without an account.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), eventId = id(30), slotId = id(31), bookingId = id(32), key = id(77), scope = { organizationId: org, schoolId: school };
const PUBLIC = 'a'.repeat(48), T = '2026-11-11T09:00:00.000Z';
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as EventError; } throw new Error('expected a failure'); };
const event = (over: Record<string, unknown> = {}) => ({ eventId, publicId: PUBLIC, title: 'Black Friday Sale', description: 'Gear 30% off', place: 'Lobby', localDate: '2026-11-27',
  opensAt: '09:00', closesAt: '10:00', slotMinutes: 30, spotsPerSlot: 2, status: 'PUBLISHED', version: 2, slotCount: 2, bookedCount: 1, createdAt: T, ...over });
const booking = (over: Record<string, unknown> = {}) => ({ bookingId, slotId, name: 'Kim Family', email: 'kim@example.test', mobile: null, status: 'BOOKED', cancelledBy: null, version: 1, createdAt: T, ...over });
const detail = (over: Record<string, unknown> = {}) => ({ event: event(), timezone: 'America/Los_Angeles', slots: [
  { slotId, position: 0, localStart: '09:00', localEnd: '09:30', startsAt: T, taken: 1, bookings: [booking()] },
  { slotId: id(33), position: 1, localStart: '09:30', localEnd: '10:00', startsAt: '2026-11-11T09:30:00.000Z', taken: 0, bookings: [] }], ...over });
const list = (over: Record<string, unknown> = {}) => ({ localToday: '2026-11-11', timezone: 'America/Los_Angeles', events: [event()], ...over });
const fields = { title: 'Open House', description: '', place: '', localDate: '2026-12-05', opensAt: '10:00', closesAt: '12:00', slotMinutes: '20', spotsPerSlot: '3' };

it('reads events as plain same-origin GETs with no key and no x-hon header', async () => {
  const f = stub(json({ data: list(), meta }));
  await expect(schoolEventsApi.list({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true)).resolves.toMatchObject({ events: [{ title: 'Black Friday Sale' }] });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/schedule/events`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const g = stub(json({ data: detail(), meta }));
  await expect(schoolEventsApi.detail(scope, eventId, signal(), () => true)).resolves.toMatchObject({ slots: [{ taken: 1 }, { taken: 0 }] });
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/schedule/events/${eventId}`);
  stub(json({ data: detail({ event: event({ eventId: id(99) }) }), meta }));
  expect((await fails(schoolEventsApi.detail(scope, eventId, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: list({ extra: 1 }), meta }));
  expect((await fails(schoolEventsApi.list(scope, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('each staff command sends its own human command name and an idempotency key, and verifies the receipt', async () => {
  const f = stub(json({ data: { event: event({ status: 'DRAFT', version: 1, slotCount: 0, bookedCount: 0 }), skippedTimes: [] }, meta }));
  const input = { expectedVersion: 0, title: 'Open House', description: '', place: '', localDate: '2026-12-05', opensAt: '10:00', closesAt: '12:00', slotMinutes: 20, spotsPerSlot: 3 };
  await schoolEventsApi.send(scope, { action: 'create', input }, key, signal(), () => true);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/schedule/events`);
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Idempotency-Key': key, 'X-HON-Human-Command': 'schedule.event.save' } });
  expect(JSON.parse(String(init.body))).toEqual(input);
  const g = stub(json({ data: { event: event({ version: 3 }), skippedTimes: ['02:00'] }, meta }));
  await expect(schoolEventsApi.send(scope, { action: 'status', eventId, input: { expectedVersion: 2, status: 'CLOSED' } }, key, signal(), () => true)).resolves.toMatchObject({ skippedTimes: ['02:00'] });
  expect(g.mock.calls[0]).toMatchObject([`/api/v1/organizations/${org}/schools/${school}/schedule/events/${eventId}/status`, { headers: { 'X-HON-Human-Command': 'schedule.event.status' } }]);
  const h = stub(json({ data: { booking: booking({ status: 'ARRIVED', version: 2 }) }, meta }));
  await schoolEventsApi.bookingStatus(scope, bookingId, { expectedVersion: 1, status: 'ARRIVED' }, key, signal(), () => true);
  expect(h.mock.calls[0]).toMatchObject([`/api/v1/organizations/${org}/schools/${school}/schedule/events/bookings/${bookingId}/status`, { headers: { 'X-HON-Human-Command': 'schedule.event.booking_status' } }]);
  stub(json({ data: { booking: booking({ bookingId: id(98) }) }, meta }));
  expect((await fails(schoolEventsApi.bookingStatus(scope, bookingId, { expectedVersion: 1, status: 'ARRIVED' }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const none = stub(json({}));
  expect((await fails(schoolEventsApi.send(scope, { action: 'create', input: { ...input, expectedVersion: 1 } }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(schoolEventsApi.send(scope, { action: 'create', input }, 'not-a-uuid', signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps refused answers to closed kinds, and only an unknown outcome is kept for an identical retry', async () => {
  expect(eventErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(eventErrorFor(409, 'SCHOOL_EVENT_SPOTS_BELOW_BOOKED').kind).toBe('REFUSED');
  expect(eventErrorFor(409, 'SOMETHING_ELSE').kind).toBe('UNKNOWN');
  expect(eventErrorFor(422, 'SCHOOL_EVENT_DATE_OUT_OF_RANGE').kind).toBe('DATE');
  expect(eventErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepEventForRetry(new EventError('UNKNOWN'))).toBe(true);
  expect(keepEventForRetry(new EventError('CHANGED'))).toBe(false);
  const events: Event[] = [];
  window.addEventListener(HON_SESSION_INVALIDATED_EVENT, (e) => events.push(e));
  stub(json({ code: 'UNAUTHENTICATED' }, 401));
  expect((await fails(schoolEventsApi.list(scope, signal(), () => true))).kind).toBe('SESSION');
  expect(events).toHaveLength(1);
  stub(json({ code: 'UNAUTHENTICATED' }, 401));
  await fails(schoolEventsApi.list(scope, signal(), () => false));
  expect(events).toHaveLength(1);
});

it('builds the form body from the fields, and keeps published date and times from the last read', () => {
  const read = list();
  expect(eventFormBody({ kind: 'create' }, fields, read as never)).toEqual({ action: 'create', input: { expectedVersion: 0, title: 'Open House', description: '', place: '',
    localDate: '2026-12-05', opensAt: '10:00', closesAt: '12:00', slotMinutes: 20, spotsPerSlot: 3 } });
  expect(() => eventFormBody({ kind: 'create' }, { ...fields, localDate: '2026-11-10' }, read as never)).toThrow(expect.objectContaining({ kind: 'DATE' }));
  expect(() => eventFormBody({ kind: 'create' }, { ...fields, closesAt: '10:10' }, read as never)).toThrow();
  // A published event: the disabled date and time inputs send nothing, so the verified values go instead.
  const edit = eventFormBody({ kind: 'edit', eventId }, { title: 'Black Friday Sale', description: 'More gear', place: 'Lobby', spotsPerSlot: '5' }, read as never);
  expect(edit).toEqual({ action: 'edit', eventId, input: { expectedVersion: 2, title: 'Black Friday Sale', description: 'More gear', place: 'Lobby', localDate: '2026-11-27',
    opensAt: '09:00', closesAt: '10:00', slotMinutes: 30, spotsPerSlot: 5 } });
  expect(() => eventFormBody({ kind: 'edit', eventId }, fields, list({ events: [event({ status: 'CANCELLED' })] }) as never)).toThrow();
  expect(() => eventFormBody({ kind: 'edit', eventId: id(99) }, fields, read as never)).toThrow();
});

const props = (over: Partial<SchoolEventsViewProps> = {}): SchoolEventsViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true, origin: 'https://app.example.test',
  list: { state: 'READY', read: list() as never }, selected: null, detail: null, form: null, outcome: null, locked: false, canRetry: false, ...over });

it('shows the list, an open event with its slots, bookings, link and the actions its status allows', () => {
  const html = renderToStaticMarkup(<SchoolEventsView {...props()}/>);
  expect(html).toContain('Black Friday Sale');
  expect(html).toContain('Open for booking');
  expect(html).toContain('2 slots of 30 minutes, 2 spots each');
  expect(html).not.toContain('event-detail');
  const open = renderToStaticMarkup(<SchoolEventsView {...props({ selected: eventId, detail: { state: 'READY', read: detail() as never } })}/>);
  expect(open).toContain(`https://app.example.test/book/${PUBLIC}`);
  expect(open).toContain('09:00–09:30: 1 of 2 booked');
  expect(open).toContain('Kim Family');
  expect(open).toContain('Close booking');
  expect(open).toContain('Cancel the event');
  expect(open).not.toContain('Publish and open booking');
  expect(open).toContain('>Arrived<');
  const draft = renderToStaticMarkup(<SchoolEventsView {...props({ list: { state: 'READY', read: list({ events: [event({ status: 'DRAFT', version: 1, slotCount: 0, bookedCount: 0 })] }) as never },
    selected: eventId, detail: { state: 'READY', read: { event: event({ status: 'DRAFT', version: 1, slotCount: 0, bookedCount: 0 }), timezone: 'UTC', slots: [] } as never } })}/>);
  expect(draft).toContain('Publish and open booking');
  expect(draft).not.toContain('event-link');
  const cancelled = renderToStaticMarkup(<SchoolEventsView {...props({ list: { state: 'READY', read: list({ events: [event({ status: 'CANCELLED' })] }) as never }, selected: eventId,
    detail: { state: 'READY', read: detail({ event: event({ status: 'CANCELLED' }) }) as never } })}/>);
  expect(cancelled).not.toContain('>Edit<');
  expect(cancelled).not.toContain('Cancel the event');
  const arrived = renderToStaticMarkup(<SchoolEventsView {...props({ selected: eventId, detail: { state: 'READY', read: detail({ slots: [
    { slotId, position: 0, localStart: '09:00', localEnd: '09:30', startsAt: T, taken: 1, bookings: [booking({ status: 'ARRIVED', version: 2 })] },
    { slotId: id(33), position: 1, localStart: '09:30', localEnd: '10:00', startsAt: T, taken: 1, bookings: [booking({ bookingId: id(34), slotId: id(33), status: 'CANCELLED', cancelledBy: 'FAMILY' })] }] }) as never } })}/>);
  expect(arrived).toContain('Undo arrived');
  expect(arrived).toContain('cancelled by the family');
});

it('locks the date and times on a published event form, and conceals, waits and reports outcomes', () => {
  const form = renderToStaticMarkup(<SchoolEventsView {...props({ form: { kind: 'edit', eventId } })}/>);
  expect(form).toContain('The date and times are fixed');
  const tag = (name: string, html: string) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';
  expect(tag('localDate', form)).toContain('disabled');
  expect(tag('spotsPerSlot', form)).not.toContain('disabled');
  expect(renderToStaticMarkup(<SchoolEventsView {...props({ concealed: true })}/>)).not.toContain('Black Friday');
  expect(renderToStaticMarkup(<SchoolEventsView {...props({ waiting: true })}/>)).toContain('Checking your school');
  expect(renderToStaticMarkup(<SchoolEventsView {...props({ list: { state: 'DENIED' } })}/>)).toContain('class schedule manage permission');
  const unknown = renderToStaticMarkup(<SchoolEventsView {...props({ outcome: { kind: 'UNKNOWN' }, canRetry: true })}/>);
  expect(unknown).toContain('Try again');
  expect(renderToStaticMarkup(<SchoolEventsView {...props({ outcome: { kind: 'DONE', skippedTimes: ['02:00', '02:30'] } })}/>)).toContain('does not exist that day: 02:00, 02:30');
  expect(renderToStaticMarkup(<SchoolEventsView {...props({ language: 'ko' })}/>)).toContain('세일 데이 및 행사');
  expect(renderToStaticMarkup(<SchoolEventsView {...props({ language: 'es' })}/>)).toContain('Días de venta y eventos');
});

it('family side: reads with no cookie, books with the given key, and treats anything unexpected as unavailable', async () => {
  const view = { publicId: PUBLIC, schoolName: 'Apex Dojo', title: 'Black Friday Sale', description: '', place: 'Lobby', localDate: '2026-11-27', timezone: 'America/Los_Angeles',
    status: 'OPEN', slots: [{ slotId, localStart: '09:00', localEnd: '09:30', spotsLeft: 2 }] };
  const f = stub(json({ data: view }));
  await expect(publicEventApi.read(PUBLIC, signal())).resolves.toEqual(view);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/public/events/${PUBLIC}`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'omit' });
  stub(json({ data: view, meta }));
  await expect(publicEventApi.read(PUBLIC, signal())).resolves.toBe('UNAVAILABLE');
  stub(json({ result: 'INVALID' }, 400));
  await expect(publicEventApi.read(PUBLIC, signal())).resolves.toBe('NOT_FOUND');
  await expect(publicEventApi.read('nope', signal())).resolves.toBe('NOT_FOUND');
  const input = { slotId, name: 'Kim Family', email: 'kim@example.test', mobile: '', website: '' }, bookKey = 'k'.repeat(32);
  const g = stub(json({ result: 'BOOKED', code: 'ABCDEF012345', slotId, localStart: '09:00', localEnd: '09:30', status: 'BOOKED' }, 201));
  await expect(publicEventApi.book(PUBLIC, input, bookKey, signal())).resolves.toMatchObject({ result: 'BOOKED', code: 'ABCDEF012345' });
  expect(g.mock.calls[0]).toMatchObject([`/api/v1/public/events/${PUBLIC}/bookings`, { method: 'POST', credentials: 'omit', headers: { 'Idempotency-Key': bookKey } }]);
  expect(Object.keys((g.mock.calls[0] as unknown as [string, RequestInit])[1].headers as object).some(k => /^x-hon/i.test(k))).toBe(false);
  stub(json({ result: 'FULL', code: 'ABCDEF012345' }, 409));
  await expect(publicEventApi.book(PUBLIC, input, bookKey, signal())).resolves.toEqual({ result: 'UNAVAILABLE' });
  const none = stub(json({}));
  await expect(publicEventApi.book(PUBLIC, { ...input, website: 'spam' }, bookKey, signal())).resolves.toEqual({ result: 'INVALID' });
  await expect(publicEventApi.cancel(PUBLIC, 'nope', signal())).resolves.toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
  const h = stub(json({ result: 'CANCELLED' }));
  await expect(publicEventApi.cancel(PUBLIC, 'abcd-ef01-2345', signal())).resolves.toBe('CANCELLED');
  expect(JSON.parse(String((h.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ code: 'ABCDEF012345' });
});

const pub = (over: Partial<PublicEventViewProps> = {}): PublicEventViewProps => ({ language: 'en', busy: false, booking: null, cancel: null, code: '',
  values: { slotId: '', name: '', email: '', mobile: '', website: '' },
  read: { publicId: PUBLIC, schoolName: 'Apex Dojo', title: 'Black Friday Sale', description: 'Gear 30% off', place: 'Lobby', localDate: '2026-11-27', timezone: 'America/Los_Angeles',
    status: 'OPEN', slots: [{ slotId, localStart: '09:00', localEnd: '09:30', spotsLeft: 2 }, { slotId: id(33), localStart: '09:30', localEnd: '10:00', spotsLeft: 0 }] }, ...over });

it('family page: spots left only, a full slot cannot be picked, the code is shown after booking', () => {
  const html = renderToStaticMarkup(<PublicEventView {...pub()}/>);
  expect(html).toContain('Apex Dojo');
  expect(html).toContain('Friday, November 27, 2026');
  expect(html).toContain('09:00–09:30 (2 left)');
  expect(html).toMatch(new RegExp(`<input[^>]*disabled=""[^>]*value="${id(33)}"`));
  expect(html).not.toMatch(new RegExp(`<input[^>]*disabled=""[^>]*value="${slotId}"`));
  expect(html).toContain('name="website"');
  expect(html).not.toContain('Kim');
  const booked = renderToStaticMarkup(<PublicEventView {...pub({ booking: { result: 'BOOKED', code: 'ABCDEF012345', slotId, localStart: '09:00', localEnd: '09:30', status: 'BOOKED' } })}/>);
  expect(booked).toContain('You are booked for 09:00–09:30. Keep this code to cancel: ABCD-EF01-2345');
  expect(booked).not.toContain('public-booking-form');
  expect(renderToStaticMarkup(<PublicEventView {...pub({ booking: { result: 'FULL' } })}/>)).toContain('That time just filled up');
  expect(renderToStaticMarkup(<PublicEventView {...pub({ booking: { result: 'UNAVAILABLE' } })}/>)).toContain('you will not be booked twice');
  expect(renderToStaticMarkup(<PublicEventView {...pub({ read: { ...(pub().read as object), status: 'CANCELLED' } as never })}/>)).toContain('This event was cancelled.');
  expect(renderToStaticMarkup(<PublicEventView {...pub({ read: 'NOT_FOUND' })}/>)).toContain('This booking link is not available.');
  expect(renderToStaticMarkup(<PublicEventView {...pub({ cancel: 'CANCELLED' })}/>)).toContain('Your booking is cancelled.');
  expect(renderToStaticMarkup(<PublicEventView {...pub({ language: 'ko' })}/>)).toContain('2자리 남음');
});

it('the Events page is in the classes nav, and every wording key has the same {placeholders} in all three languages', () => {
  expect(SCHOOL_SHELL_NAV.flatMap((g) => g.routes.map((r) => r.href))).toContain('/staff/schedule/events');
  const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const keys = Object.keys(EVENTS_COPY.en) as (keyof typeof EVENTS_COPY.en)[];
  expect(keys.length).toBeGreaterThan(90);
  for (const lang of ['ko', 'es'] as const) {
    expect(Object.keys(EVENTS_COPY[lang]).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(vars(EVENTS_COPY[lang][k]), `${lang}.${k}`).toBe(vars(EVENTS_COPY.en[k]));
  }
  expect(eventsText('es-MX', 'left', { n: 3 })).toBe('quedan 3');
  expect(eventsText('fr', 'full')).toBe('Full');
});
