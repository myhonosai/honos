import { createParentApi } from '../src/api/client';
import { createCommandKeys, describeOutcome, sessionAction } from '../src/schedule/booking-model';
import { verifyParentClassBookingChoices } from '@hon/contracts/parent-class-booking';
import { BOOKING_1, CHILD_A, NOW, SESSION_1, booking, choicesBody, jsonResponse } from './fixtures';

const KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function api(fetchImpl: jest.Mock, token: string | null = 'tok') {
  return createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => token, fetchImpl, timeoutMs: 1000 });
}

describe('class booking commands', () => {
  it('books as a native client: bearer, JSON, exact command, Idempotency-Key, no Origin or cookie', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(201, { data: { booking: booking({ sessionId: SESSION_1, bookingId: BOOKING_1 }), spotsLeft: 2 }, meta: { replayed: false } }));
    const result = await api(fetchImpl).bookClass({ studentProfileId: CHILD_A, sessionId: SESSION_1 }, KEY);
    expect(result).toMatchObject({ ok: true, replayed: false, data: { spotsLeft: 2 } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/parent/class-bookings');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit' });
    expect(init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer tok',
      'x-hon-human-command': 'parent.class_booking.book', 'Idempotency-Key': KEY });
    expect(JSON.parse(init.body)).toEqual({ studentProfileId: CHILD_A, sessionId: SESSION_1 });
  });

  it('cancels with the booking id in the path and only expectedVersion in the body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: { booking: booking({ status: 'CANCELLED', canCancel: false, version: 2 }), spotsLeft: 6 }, meta: { replayed: true } }));
    const result = await api(fetchImpl).cancelBooking(BOOKING_1, 1, KEY);
    expect(result).toMatchObject({ ok: true, replayed: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.example.test/v1/parent/class-bookings/${BOOKING_1}/cancel`);
    expect(init.headers['x-hon-human-command']).toBe('parent.class_booking.cancel');
    expect(JSON.parse(init.body)).toEqual({ expectedVersion: 1 });
  });

  it('a receipt for a different session than requested is not success', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(201, { data: { booking: booking(), spotsLeft: 2 } }));
    expect(await api(fetchImpl).bookClass({ studentProfileId: CHILD_A, sessionId: SESSION_1 }, KEY)).toEqual({ ok: false, state: 'unknown' });
  });

  it.each([
    ['network failure', () => Promise.reject(new Error('net')), 'unknown'],
    ['server error', () => Promise.resolve(jsonResponse(503, { code: 'PARENT_CLASS_BOOKING_UNAVAILABLE' })), 'unknown'],
    ['still processing', () => Promise.resolve(jsonResponse(409, { code: 'IDEMPOTENCY_IN_PROGRESS' })), 'unknown'],
    ['signed out', () => Promise.resolve(jsonResponse(401, {})), 'signed-out'],
    ['scope changed', () => Promise.resolve(jsonResponse(403, { code: 'PARENT_SCOPE_CHANGED' })), 'access-denied'],
  ])('%s maps to %s', async (_name, impl, state) => {
    const fetchImpl = jest.fn().mockImplementation(impl);
    expect(await api(fetchImpl).bookClass({ studentProfileId: CHILD_A, sessionId: SESSION_1 }, KEY)).toMatchObject({ ok: false, state });
  });

  it('a definite refusal carries HON code', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(409, { code: 'PARENT_CLASS_BOOKING_FULL' }));
    expect(await api(fetchImpl).bookClass({ studentProfileId: CHILD_A, sessionId: SESSION_1 }, KEY)).toEqual({ ok: false, state: 'refused', code: 'PARENT_CLASS_BOOKING_FULL' });
  });

  it('refuses to send without a proper key or without a session', async () => {
    const fetchImpl = jest.fn();
    await expect(api(fetchImpl).bookClass({ studentProfileId: CHILD_A, sessionId: SESSION_1 }, '')).rejects.toThrow();
    expect(await api(fetchImpl, null).bookClass({ studentProfileId: CHILD_A, sessionId: SESSION_1 }, KEY)).toEqual({ ok: false, state: 'signed-out' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('booking model', () => {
  it('keeps one key per action until settled', () => {
    let n = 0;
    const keys = createCommandKeys(() => `key-${++n}-0000000000000`);
    expect(keys.keyFor('book:a:b')).toBe(keys.keyFor('book:a:b'));
    keys.settle('book:a:b');
    expect(keys.keyFor('book:a:b')).toBe('key-2-0000000000000');
    expect(keys.keyFor('cancel:x:1')).not.toBe(keys.keyFor('book:a:b'));
  });

  it('offers actions only from the server flags', () => {
    const choices = verifyParentClassBookingChoices(choicesBody().data);
    const [s1, s2] = choices.children[0]!.sessions;
    const now = Date.parse(NOW);
    expect(sessionAction(choices, s1!, now)).toBe('book');
    expect(sessionAction(choices, s2!, now)).toBe('cancel');
    expect(sessionAction(choices, { ...s1!, spotsLeft: 0 }, now)).toBe('full');
    expect(sessionAction({ ...choices, canBook: false }, s1!, now)).toBe('none');
    expect(sessionAction(choices, { ...s2!, booking: { ...s2!.booking!, canCancel: false } }, now)).toBe('none');
    expect(sessionAction(choices, s1!, Date.parse(s1!.startsAt))).toBe('none');
  });

  it('never calls a waitlist place a booking, and an unknown result is not done', () => {
    expect(describeOutcome({ ok: true, replayed: false, data: { booking: { status: 'WAITLISTED' } } }, 'book')).toEqual({ kind: 'done', message: expect.stringMatching(/waitlist.*not a confirmed spot/i) });
    expect(describeOutcome({ ok: true, replayed: false, data: { booking: { status: 'BOOKED' } } }, 'book')).toEqual({ kind: 'done', message: 'Booked.' });
    expect(describeOutcome({ ok: false, state: 'unknown' }, 'book')).toEqual({ kind: 'unknown' });
    expect(describeOutcome({ ok: false, state: 'refused', code: 'PARENT_CLASS_BOOKING_FULL' }, 'book')).toEqual({ kind: 'refused', message: 'This class is full.' });
    expect(describeOutcome({ ok: false, state: 'signed-out' }, 'cancel')).toEqual({ kind: 'session' });
  });
});
