const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { ParentSchoolBookingService } = require('../dist/families/parent-school-bookings.service.js');

// 0360 parent school bookings: closed inputs, verified projections, and the service refuses before any database call.
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const T1 = '2026-11-20T17:00:00.000Z', T2 = '2026-11-20T17:30:00.000Z';
const booking = { kind: 'EVENT', bookingId: C, parentId: B, title: 'Black Friday Sale', localDate: '2026-11-20', localStart: '09:00', localEnd: '09:30',
  startsAt: T1, status: 'BOOKED', version: 1, canCancel: true };

test('0360 inputs are closed: no name, contact, school or family is accepted from the parent', () => {
  assert.deepEqual(contracts.validateBookParentSchoolEventSlotInput({ slotId: A }), { slotId: A });
  for (const value of [{}, { slotId: A, email: 'x@example.test' }, { slotId: 'x' }, { slotId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, null]) {
    assert.throws(() => contracts.validateBookParentSchoolEventSlotInput(value), undefined, JSON.stringify(value));
  }
  const good = { typeId: A, startsAt: T1, answers: ['Yellow', true, null], waiverAccepted: true };
  assert.deepEqual(contracts.validateBookParentSchoolBookingTypeInput(good), good);
  for (const value of [{ ...good, name: 'Kim' }, { ...good, startsAt: '2026-11-20T17:00:30.000Z' }, { ...good, answers: [1] }, { ...good, answers: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { ...good, waiverAccepted: 'yes' }, { ...good, answers: ['=SUM(A1)'] }]) {
    assert.throws(() => contracts.validateBookParentSchoolBookingTypeInput(value), undefined, JSON.stringify(value));
  }
  assert.deepEqual(contracts.validateCancelParentSchoolBookingInput({ bookingId: C, expectedVersion: 2 }), { bookingId: C, expectedVersion: 2 });
  assert.throws(() => contracts.validateCancelParentSchoolBookingInput({ bookingId: C, expectedVersion: 0 }));
});

test('0360 choices and receipts are verified exactly', () => {
  const view = { canBook: true, timezone: 'America/Los_Angeles', contact: { name: 'Kim Family', email: 'kim@example.test' },
    events: [{ eventId: B, title: 'Black Friday Sale', description: '', place: 'Lobby', localDate: '2026-11-20', bookingId: C,
      slots: [{ slotId: A, localStart: '09:00', localEnd: '09:30', startsAt: T1, spotsLeft: 1 }, { slotId: C, localStart: '09:30', localEnd: '10:00', startsAt: T2, spotsLeft: 0 }] }],
    bookingTypes: [{ typeId: A, name: 'Belt test', description: '', template: 'TEST_RESERVATION', durationMinutes: 30, questions: [{ label: 'Belt', kind: 'TEXT', required: true }],
      waiver: '', bookingId: null, times: [{ startsAt: T1, localDate: '2026-11-20', localStart: '09:00', localEnd: '09:30', spotsLeft: 2 }] }],
    bookings: [booking] };
  assert.deepEqual(contracts.verifyParentSchoolBookings(view), view);
  assert.throws(() => contracts.verifyParentSchoolBookings({ ...view, contact: null }), undefined, 'booking needs a contact');
  assert.equal(contracts.verifyParentSchoolBookings({ ...view, canBook: false, contact: null }).contact, null);
  assert.throws(() => contracts.verifyParentSchoolBookings({ ...view, events: [{ ...view.events[0], slots: [...view.events[0].slots].reverse() }] }), undefined, 'slots in time order');
  assert.throws(() => contracts.verifyParentSchoolBookings({ ...view, events: [{ ...view.events[0], families: ['x'] }] }), undefined, 'no extra keys such as other families');
  assert.throws(() => contracts.verifyParentSchoolBookings({ ...view, bookings: [{ ...booking, status: 'CANCELLED', canCancel: false }] }), undefined, 'only live bookings are listed');
  assert.throws(() => contracts.verifyParentSchoolBooking({ ...booking, status: 'ARRIVED' }), undefined, 'only BOOKED can be cancelled');
  assert.equal(contracts.verifyParentSchoolBookingReceipt({ booking, spotsLeft: 0 }, { kind: 'EVENT' }).spotsLeft, 0);
  assert.throws(() => contracts.verifyParentSchoolBookingReceipt({ booking, spotsLeft: 0 }, { kind: 'BOOKING_TYPE' }), undefined, 'bound to the requested kind');
  assert.throws(() => contracts.verifyParentSchoolBookingReceipt({ booking, spotsLeft: 0 }, { bookingId: A }), undefined, 'bound to the requested booking');
});

test('0360 service refuses before any database call', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new ParentSchoolBookingService(database);
  await assert.rejects(() => service.choices(''), (e) => e.response.code === 'PARENT_SCHOOL_BOOKING_FORBIDDEN');
  await assert.rejects(() => service.bookEventSlot('subject', { slotId: A, name: 'Kim' }, 'key'), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.bookEventSlot('subject', { slotId: A }, ''), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.bookBookingType('subject', { typeId: A }, 'key'), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.cancel('subject', 'nope', { expectedVersion: 1 }, 'key'), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.equal(calls, 0);
  const ambiguous = new ParentSchoolBookingService({ resolveParentJourneyScopes: async () => [{}, {}] });
  await assert.rejects(() => ambiguous.choices('subject'), (e) => e.response.code === 'PARENT_SCHOOL_BOOKING_FORBIDDEN');
  const failing = new ParentSchoolBookingService({ resolveParentJourneyScopes: async () => { throw Object.assign(new Error('boom kim@example.test'), { code: 'XX000' }); } });
  await assert.rejects(() => failing.choices('subject'), (e) => e.response.code === 'PARENT_SCHOOL_BOOKING_UNAVAILABLE' && !JSON.stringify(e.response).includes('kim'));
});
