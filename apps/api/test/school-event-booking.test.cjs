const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { SchoolEventService } = require('../dist/schedule/school-event.service.js');
const { publicEventTransport } = require('../dist/schedule/public-event-transport.js');

// B-SCH-3 (0261) sale-day and event slot booking: the shared validators match the database rules, the service refuses
// before any database call, and the public transport accepts only the three canonical paths.

const PUBLIC_ID = 'a'.repeat(48);
const SLOT = '11111111-1111-4111-8111-111111111111';
const T = '2026-11-11T09:00:00.000Z';
const good = { expectedVersion: 0, title: 'Black Friday Sale', description: '', place: 'Lobby', localDate: '2026-11-27', opensAt: '09:00', closesAt: '15:00', slotMinutes: 30, spotsPerSlot: 4 };

test('0261 event input: closed shape, text rule, times and slot length', () => {
  assert.deepEqual(contracts.validateSaveSchoolEventInput(good), good);
  for (const patch of [{ title: '' }, { title: ' Sale' }, { title: '+Sale' }, { place: 'Lobby\u200B' }, { description: 'x'.repeat(501) }, { closesAt: '09:00' },
    { closesAt: '09:20' }, { slotMinutes: 5 }, { spotsPerSlot: 0 }, { opensAt: '9:00' }, { localDate: '2026-02-30' }, { extra: 1 }]) {
    assert.throws(() => contracts.validateSaveSchoolEventInput({ ...good, ...patch }), undefined, JSON.stringify(patch));
  }
  assert.equal(contracts.isSchoolEventText('\uD83E\uDD4B'.repeat(120), 1, 120), true, 'length counts code points like the database');
  assert.deepEqual(contracts.validateSetSchoolEventStatusInput({ expectedVersion: 2, status: 'PUBLISHED' }), { expectedVersion: 2, status: 'PUBLISHED' });
  assert.throws(() => contracts.validateSetSchoolEventStatusInput({ expectedVersion: 2, status: 'DRAFT' }));
  assert.throws(() => contracts.validateSetSchoolEventBookingStatusInput({ expectedVersion: 0, status: 'ARRIVED' }));
});

test('0261 public booking input and outcomes', () => {
  const base = { slotId: SLOT, name: 'Kim Family', email: 'Kim@Example.test', mobile: '', website: '' };
  assert.equal(contracts.validatePublicEventBookingInput(base).email, 'kim@example.test');
  assert.equal(contracts.validatePublicEventBookingInput({ ...base, email: '', mobile: '+15555550101' }).mobile, '+15555550101');
  for (const patch of [{ email: '' }, { email: 'nope' }, { email: '', mobile: '5550101' }, { website: 'x' }, { name: '' }, { slotId: 'x' }, { note: 'hi' }]) {
    assert.throws(() => contracts.validatePublicEventBookingInput({ ...base, ...patch }), undefined, JSON.stringify(patch));
  }
  assert.equal(contracts.normalizeEventBookingCode(' abcd-ef01-2345 '), 'ABCDEF012345');
  assert.equal(contracts.formatEventBookingCode('ABCDEF012345'), 'ABCD-EF01-2345');
  assert.throws(() => contracts.normalizeEventBookingCode('ABCD-EF01-234Z'));
  assert.deepEqual(contracts.verifyPublicEventBookingOutcome({ result: 'FULL' }), { result: 'FULL' });
  assert.throws(() => contracts.verifyPublicEventBookingOutcome({ result: 'FULL', code: 'ABCDEF012345' }), undefined, 'a refusal never carries a code');
  assert.equal(contracts.verifyPublicEventBookingOutcome({ result: 'BOOKED', code: 'ABCDEF012345', slotId: SLOT, localStart: '09:00', localEnd: '09:30', status: 'BOOKED' }).code, 'ABCDEF012345');
  assert.equal(contracts.verifyPublicEventCancelOutcome({ result: 'CANCELLED' }), 'CANCELLED');
});

test('0261 public read projection is exact', () => {
  const view = { publicId: PUBLIC_ID, schoolName: 'Apex Dojo', title: 'Sale', description: '', place: '', localDate: '2026-11-27', timezone: 'America/Los_Angeles', status: 'OPEN',
    slots: [{ slotId: SLOT, localStart: '09:00', localEnd: '09:30', spotsLeft: 4 }] };
  assert.deepEqual(contracts.verifyPublicSchoolEvent(view, PUBLIC_ID), view);
  assert.throws(() => contracts.verifyPublicSchoolEvent({ ...view, slots: [{ ...view.slots[0], names: ['x'] }] }, PUBLIC_ID), undefined, 'no names');
  assert.throws(() => contracts.verifyPublicSchoolEvent(view, 'b'.repeat(48)), undefined, 'bound to the requested link');
  const event = { eventId: SLOT, publicId: PUBLIC_ID, title: 'Sale', description: '', place: '', localDate: '2026-11-27', opensAt: '09:00', closesAt: '10:00', slotMinutes: 30,
    spotsPerSlot: 2, status: 'PUBLISHED', version: 2, slotCount: 1, bookedCount: 1, createdAt: T };
  const booking = { bookingId: '22222222-2222-4222-8222-222222222222', slotId: SLOT, name: 'Kim', email: 'kim@example.test', mobile: null, status: 'BOOKED', cancelledBy: null, version: 1, createdAt: T };
  const detail = { event, timezone: 'America/Los_Angeles', slots: [{ slotId: SLOT, position: 0, localStart: '09:00', localEnd: '09:30', startsAt: T, taken: 1, bookings: [booking] }] };
  assert.equal(contracts.verifySchoolEventDetail(detail, SLOT).slots[0].bookings[0].name, 'Kim');
  assert.throws(() => contracts.verifySchoolEventDetail({ ...detail, slots: [{ ...detail.slots[0], taken: 2 }] }, SLOT), undefined, 'taken matches live bookings');
  assert.throws(() => contracts.verifySchoolEventBooking({ ...booking, status: 'CANCELLED' }), undefined, 'cancelled needs who cancelled');
});

test('0261 service refuses before any database call', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new SchoolEventService(database);
  const human = { organizationId: SLOT, schoolId: SLOT, principalId: SLOT, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: SLOT, correlationId: SLOT, idempotencyKey: 'key-1' };
  await assert.rejects(() => service.save({ ...human, source: 'AI_AGENT' }, null, good), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.save({ ...human, actionRequestId: SLOT }, null, good), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.save({ ...human, idempotencyKey: '' }, null, good), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.save(human, SLOT, good), (e) => e.response.code === 'VALIDATION_FAILED', 'an edit needs a version');
  await assert.rejects(() => service.save(human, null, { ...good, title: '' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.list(human), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => service.detail({ ...human, idempotencyKey: '' }, 'nope'), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.equal(await service.published('nope'), null);
  assert.deepEqual(await service.book(PUBLIC_ID, { slotId: SLOT, name: 'A', email: '', mobile: '', website: '' }, 'k'.repeat(20)), { result: 'INVALID' });
  assert.deepEqual(await service.book(PUBLIC_ID, { slotId: SLOT, name: 'A', email: 'a@example.test', mobile: '', website: '' }, 'short'), { result: 'INVALID' });
  assert.equal(await service.cancel(PUBLIC_ID, { code: 'nope' }), 'INVALID');
  assert.equal(await service.cancel(PUBLIC_ID, { code: 'ABCDEF012345', more: 1 }), 'INVALID');
  assert.equal(calls, 0);
  const failing = new SchoolEventService({ runPublicEventCall: async () => { throw Object.assign(new Error('boom detail kim@example.test'), { code: 'XX000' }); } });
  assert.deepEqual(await failing.book(PUBLIC_ID, { slotId: SLOT, name: 'A', email: 'a@example.test', mobile: '', website: '' }, 'k'.repeat(20)), { result: 'UNAVAILABLE' });
  assert.equal(await failing.cancel(PUBLIC_ID, { code: 'ABCDEF012345' }), 'UNAVAILABLE');
});

function run(middleware, req) {
  return new Promise((resolve) => {
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, headers: this.headers }); }, on() {}, once() {}, emit() {} };
    middleware({ headers: {}, originalUrl: req.path, ...req }, res, () => resolve({ next: true, headers: res.headers }));
  });
}
test('0261 public transport: canonical paths only', async () => {
  const mw = publicEventTransport();
  assert.equal((await run(mw, { method: 'GET', path: '/v1/other' })).next, true, 'other paths pass through untouched');
  const read = await run(mw, { method: 'GET', path: `/v1/public/events/${PUBLIC_ID}` });
  assert.equal(read.next, true); assert.equal(read.headers['cache-control'], 'no-store');
  for (const req of [{ method: 'GET', path: `/v1/public/events/${PUBLIC_ID.toUpperCase()}` }, { method: 'GET', path: `/v1/public/events/${PUBLIC_ID}`, originalUrl: `/v1/public/events/${PUBLIC_ID}?x=1` },
    { method: 'DELETE', path: `/v1/public/events/${PUBLIC_ID}` }, { method: 'POST', path: `/v1/public/events/${PUBLIC_ID}/other` },
    { method: 'POST', path: `/v1/PUBLIC/events/${PUBLIC_ID}/bookings` }, { method: 'POST', path: `/v1/public/events/${PUBLIC_ID}/bookings`, headers: { 'content-type': 'text/plain' } }]) {
    const out = await run(mw, req);
    assert.equal(out.status, 400, JSON.stringify(req)); assert.deepEqual(out.body, { result: 'INVALID' });
  }
});
