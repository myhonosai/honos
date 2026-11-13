const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { ParentClassBookingService } = require('../dist/families/parent-class-booking.service.js');

// 0329 parent class booking: closed inputs, verified projections, and the service refuses before any database call.
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const T1 = '2026-11-20T17:00:00.000Z', T2 = '2026-11-20T18:00:00.000Z';
const booking = { bookingId: C, sessionId: B, studentProfileId: A, status: 'BOOKED', source: 'PARENT_APP', version: 1, canCancel: true };

test('0329 inputs are closed', () => {
  assert.deepEqual(contracts.validateBookParentClassSessionInput({ studentProfileId: A, sessionId: B }), { studentProfileId: A, sessionId: B });
  for (const value of [{ studentProfileId: A }, { studentProfileId: A, sessionId: B, schoolId: C }, { studentProfileId: 'x', sessionId: B }, { studentProfileId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', sessionId: B }, null, []]) {
    assert.throws(() => contracts.validateBookParentClassSessionInput(value), undefined, JSON.stringify(value));
  }
  assert.deepEqual(contracts.validateCancelParentClassBookingInput({ bookingId: C, expectedVersion: 2 }), { bookingId: C, expectedVersion: 2 });
  for (const value of [{ bookingId: C, expectedVersion: 0 }, { bookingId: C, expectedVersion: 1.5 }, { bookingId: C }, { bookingId: C, expectedVersion: 1, reason: 'x' }]) {
    assert.throws(() => contracts.validateCancelParentClassBookingInput(value), undefined, JSON.stringify(value));
  }
});

test('0329 choices and receipts are verified exactly', () => {
  const view = { canBook: true, timezone: 'America/Los_Angeles', horizonDays: 14, children: [{ studentProfileId: A, displayName: 'Min-jun Kim', sessions: [
    { sessionId: B, name: 'Kids Karate', programName: 'Kids', roomName: null, startsAt: T1, endsAt: T2, spotsLeft: 3, booking }] }] };
  assert.deepEqual(contracts.verifyParentClassBookingChoices(view), view);
  const bad = (patch) => ({ ...view, children: [{ ...view.children[0], sessions: [{ ...view.children[0].sessions[0], ...patch }] }] });
  assert.throws(() => contracts.verifyParentClassBookingChoices(bad({ students: ['x'] })), undefined, 'no extra keys such as other students');
  assert.throws(() => contracts.verifyParentClassBookingChoices(bad({ booking: { ...booking, studentProfileId: C } })), undefined, 'a booking belongs to that child');
  assert.throws(() => contracts.verifyParentClassBookingChoices(bad({ endsAt: T1 })), undefined, 'ends after it starts');
  assert.throws(() => contracts.verifyParentClassBookingChoices({ ...view, horizonDays: 30 }));
  assert.throws(() => contracts.verifyParentClassBooking({ ...booking, source: 'STAFF' }), undefined, 'only app bookings can be cancelled by a parent');
  assert.equal(contracts.verifyParentClassBookingReceipt({ booking, spotsLeft: 0 }, { sessionId: B, studentProfileId: A }).spotsLeft, 0);
  assert.throws(() => contracts.verifyParentClassBookingReceipt({ booking, spotsLeft: 0 }, { bookingId: A }), undefined, 'bound to the requested booking');
});

test('0329 service refuses before any database call', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new ParentClassBookingService(database);
  await assert.rejects(() => service.choices(''), (e) => e.response.code === 'PARENT_CLASS_BOOKING_FORBIDDEN');
  await assert.rejects(() => service.choices(' padded'), (e) => e.response.code === 'PARENT_CLASS_BOOKING_FORBIDDEN');
  await assert.rejects(() => service.book('subject', { studentProfileId: A }, 'key'), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.book('subject', { studentProfileId: A, sessionId: B }, ''), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.book('subject', { studentProfileId: A, sessionId: B }, 'k\u0007'), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.cancel('subject', 'nope', { expectedVersion: 1 }, 'key'), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.cancel('subject', C, { expectedVersion: 1, bookingId: A }, 'key'), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.equal(calls, 0);
  const ambiguous = new ParentClassBookingService({ resolveParentJourneyScopes: async () => [{}, {}] });
  await assert.rejects(() => ambiguous.choices('subject'), (e) => e.response.code === 'PARENT_CLASS_BOOKING_FORBIDDEN');
  const failing = new ParentClassBookingService({ resolveParentJourneyScopes: async () => { throw Object.assign(new Error('boom kim@example.test'), { code: 'XX000' }); } });
  await assert.rejects(() => failing.choices('subject'), (e) => e.response.code === 'PARENT_CLASS_BOOKING_UNAVAILABLE' && !JSON.stringify(e.response).includes('kim'));
});
