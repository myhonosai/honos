import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLASS_BOOKING_KINDS } from '@hon/contracts';
import {
  ClassBookingAccessError, ClassBookingRejectedError, ClassBookingUncertainError, MANUAL_CLASS_BOOKING_KINDS,
  classBookingPath, parseClassBookingResult, prepareClassBooking, submitClassBooking, validateClassBookingDraft,
  type PreparedClassBooking,
} from '../src/components/class-booking-workbench-http';

const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { organizationId: id('1'), schoolId: id('2'), sessionId: id('3'), studentProfileId: id('4') };
const command = prepareClassBooking(ids, 'REGULAR', id('5'));
const booking = { id: id('6'), classSessionId: ids.sessionId, studentProfileId: ids.studentProfileId, bookingKind: 'REGULAR', status: 'BOOKED', source: 'STAFF', bookedAt: '2026-10-16T12:00:00.000Z', version: 2, createdAt: '2026-10-16T12:00:00.000Z', updatedAt: '2026-10-16T12:00:00.000Z', sessionCapacity: 1, activeSeatCount: 3, bookingPolicy: 'WALK_IN' };
const envelope = (data: unknown = booking, replayed = false) => ({ data, meta: { requestId: id('7'), correlationId: id('7'), replayed } });
const response = (data: unknown = booking, status = 201) => Response.json(envelope(data, status === 200), { status });
afterEach(() => vi.restoreAllMocks());

describe('canonical manual class-booking closed browser transport', () => {
  it('uses only canonical generic kinds, an immutable command, exact JSON body and a relative same-origin POST', async () => {
    expect(MANUAL_CLASS_BOOKING_KINDS).toEqual(CLASS_BOOKING_KINDS);
    expect(MANUAL_CLASS_BOOKING_KINDS).not.toContain('CLASS_PASS');
    expect(Object.isFrozen(MANUAL_CLASS_BOOKING_KINDS)).toBe(true);
    expect(Object.isFrozen(command)).toBe(true);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    const allocate = vi.spyOn(crypto, 'randomUUID');
    expect(await submitClassBooking(command)).toEqual({ booking, replayed: false });
    expect(fetcher.mock.calls).toEqual([[classBookingPath(ids.organizationId, ids.schoolId, ids.sessionId), {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': id('5'), 'X-HON-Human-Command': 'class-booking' },
      body: JSON.stringify({ studentProfileId: ids.studentProfileId, bookingKind: 'REGULAR' }),
    }]]);
    expect(allocate).not.toHaveBeenCalled();
  });

  it('rejects all non-exact IDs, broader kinds, body fields, methods and endpoint substitutions before fetch', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const field of Object.keys(ids)) for (const unsafe of ['', 'Student Name', `${id('1')}?extra=1`, `https://evil.test/${id('1')}`, ` ${id('1')}`, id('1') + '/', ['BOOKED'], null]) {
      expect(() => validateClassBookingDraft({ ...ids, [field]: unsafe } as typeof ids, 'REGULAR')).toThrow();
    }
    for (const unsafe of ['CLASS_PASS', '', 'PRIVATE', 'regular', null, ['REGULAR']]) expect(() => validateClassBookingDraft(ids, unsafe)).toThrow();
    expect(() => validateClassBookingDraft({ ...ids, principalId: id('6') } as typeof ids, 'REGULAR')).toThrow();
    expect(() => prepareClassBooking(ids, 'REGULAR', 'retained-string')).toThrow();
    for (const path of ['https://evil.test' + command.path, '//evil.test' + command.path, 'https://hon.test' + command.path, command.path + '?studentProfileId=' + ids.studentProfileId, command.path + '#fragment', command.path + '/', command.path.replace('/bookings', '/attendance'), command.path.replace('/schedule/', '/schedule/../schedule/')]) {
      await expect(submitClassBooking({ ...command, path })).rejects.toThrow();
    }
    for (const body of [JSON.stringify({ studentProfileId: ids.studentProfileId, bookingKind: 'CLASS_PASS' }), JSON.stringify({ studentProfileId: ids.studentProfileId, bookingKind: 'REGULAR', source: 'HUMAN_UI' }), JSON.stringify({ studentProfileId: ids.studentProfileId, bookingKind: 'REGULAR', capacity: 100 }), '{invalid', ' ' + command.body, JSON.stringify({ bookingKind: 'REGULAR', studentProfileId: ids.studentProfileId }), JSON.stringify({ studentProfileId: ids.studentProfileId + '?x=1', bookingKind: 'REGULAR' })]) {
      await expect(submitClassBooking({ ...command, body })).rejects.toThrow();
    }
    await expect(submitClassBooking({ ...command, method: 'GET' } as PreparedClassBooking)).rejects.toThrow();
    await expect(submitClassBooking({ ...command, schoolId: id('9') })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts both response-backed BOOKED and WAITLISTED and never infers capacity outcomes', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const bookingKind of CLASS_BOOKING_KINDS) for (const status of ['BOOKED', 'WAITLISTED']) {
      const exact = prepareClassBooking(ids, bookingKind, id('5'));
      const data = { ...booking, bookingKind, status, bookingPolicy: 'REQUIRED_BOOKING', activeSeatCount: 3 };
      fetcher.mockResolvedValue(response(data, 200));
      expect(await submitClassBooking(exact)).toEqual({ booking: data, replayed: true });
    }
    const upper = prepareClassBooking({ ...ids, studentProfileId: ids.studentProfileId.toUpperCase() }, 'REGULAR', id('5'));
    expect(upper).toEqual(command);
  });

  it('verifies exact session/student/kind and every closed timestamp/version/capacity/policy/source fact', () => {
    for (const patch of [
      { classSessionId: id('8') }, { studentProfileId: id('8') }, { bookingKind: 'TRIAL' }, { bookingKind: 'CLASS_PASS' },
      { status: 'CHECKED_IN' }, { status: 'CANCELLED' }, { status: 'NO_SHOW' }, { status: ['BOOKED'] }, { source: 'AUTOMATION' }, { source: 'PARENT_APP' },
      { bookedAt: 'yesterday' }, { bookedAt: '2026-02-30T12:00:00.000Z' }, { createdAt: null }, { updatedAt: '2026-10-16' },
      { version: 0 }, { version: 1.5 }, { version: '2' }, { version: 2147483648 }, { sessionCapacity: -1 }, { sessionCapacity: '1' },
      { activeSeatCount: -1 }, { activeSeatCount: 1.1 }, { bookingPolicy: 'UNLIMITED' }, { bookingPolicy: { capacity: 100 } },
      { payment: 'PAID' }, { capacityPolicy: { raw: 'SECRET' } }, { organizationId: id('1') },
    ]) expect(() => parseClassBookingResult(envelope({ ...booking, ...patch }), command)).toThrow();
    for (const field of Object.keys(booking)) { const data: Record<string, unknown> = { ...booking }; delete data[field]; expect(() => parseClassBookingResult(envelope(data), command)).toThrow(); }
    for (const value of [null, [envelope()], { ...envelope(), extra: true }, { data: booking }, { ...envelope(), meta: { requestId: id('7'), correlationId: id('8'), replayed: false } }, { ...envelope(), meta: { requestId: id('7'), correlationId: id('7'), replayed: 'false' } }, { ...envelope(), meta: { ...envelope().meta, policy: 'SECRET' } }]) expect(() => parseClassBookingResult(value, command)).toThrow();
  });

  it('classifies access and definite rejections without echoing problem details; in-progress alone remains uncertain', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403]) {
      fetcher.mockResolvedValue(Response.json({ detail: 'SQL_SECRET' }, { status }));
      await expect(submitClassBooking(command)).rejects.toMatchObject({ status });
      await expect(submitClassBooking(command)).rejects.toBeInstanceOf(ClassBookingAccessError);
    }
    for (const status of [400, 404, 409, 413, 415, 422]) {
      fetcher.mockResolvedValue(Response.json({ code: 'BOOKING_ALREADY_EXISTS', detail: 'SQL_SECRET' }, { status }));
      await expect(submitClassBooking(command)).rejects.toBeInstanceOf(ClassBookingRejectedError);
      await expect(submitClassBooking(command)).rejects.not.toThrow('SQL_SECRET');
    }
    fetcher.mockResolvedValue(Response.json({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'SQL_SECRET' }, { status: 409 }));
    await expect(submitClassBooking(command)).rejects.toBeInstanceOf(ClassBookingUncertainError);
  });

  it('treats network loss, unverified/oversized receipts, wrong content type, redirects and server errors as uncertain without retrying', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('NETWORK_SECRET'));
    await expect(submitClassBooking(command)).rejects.toBeInstanceOf(ClassBookingUncertainError);
    const candidates = [
      new Response('bad JSON', { status: 201, headers: { 'Content-Type': 'application/json' } }),
      new Response('x'.repeat(4001), { status: 201, headers: { 'Content-Type': 'application/json' } }),
      new Response(JSON.stringify(envelope()), { status: 201, headers: { 'Content-Type': 'text/html' } }),
      Response.json(envelope(), { status: 200 }), Response.json(envelope(booking, true), { status: 201 }),
      response({ ...booking, status: 'NO_SHOW' }), new Response(null, { status: 202 }), new Response(null, { status: 302 }), new Response(null, { status: 503 }),
    ];
    const redirected = response(); Object.defineProperty(redirected, 'redirected', { value: true }); candidates.push(redirected);
    for (const candidate of candidates) {
      fetcher.mockResolvedValueOnce(candidate);
      await expect(submitClassBooking(command)).rejects.toBeInstanceOf(ClassBookingUncertainError);
    }
    expect(fetcher).toHaveBeenCalledTimes(candidates.length + 1);
  });
});
