const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { BookingTypeService } = require('../dist/schedule/booking-type.service.js');
const { publicBookingTypeTransport } = require('../dist/schedule/public-booking-type-transport.js');

// 0286 school booking types: the shared validators match the database rules, the service refuses before any database
// call, public failures never leak detail, and the public transport accepts only the three canonical paths.

const PUBLIC_ID = 'c'.repeat(48);
const ID = '11111111-1111-4111-8111-111111111111';
const T = '2026-11-20T17:00:00.000Z';
const good = {
  expectedVersion: 0, name: 'Belt test reservation', description: '', template: 'TEST_RESERVATION', durationMinutes: 30, spotsPerTime: 2,
  weeklyHours: [{ day: 6, start: '09:00', end: '12:00' }], horizonDays: 14, noticeHours: 12, audience: 'OPEN',
  questions: [{ label: 'Student name', kind: 'TEXT', required: true }, { label: 'First test?', kind: 'YES_NO', required: false }],
  waiver: 'I accept the rules.', thankYou: 'See you at the dojo.',
};

test('0286 type input: closed shape, hours, questions and limits', () => {
  assert.deepEqual(contracts.validateSaveBookingTypeInput(good), good);
  for (const patch of [{ name: '' }, { name: ' Test' }, { name: 'x'.repeat(81) }, { description: 'x'.repeat(501) }, { template: 'CLASS' }, { durationMinutes: 5 },
    { durationMinutes: 241 }, { spotsPerTime: 0 }, { spotsPerTime: 51 }, { weeklyHours: [] }, { weeklyHours: [{ day: 8, start: '09:00', end: '10:00' }] },
    { weeklyHours: [{ day: 1, start: '10:00', end: '09:00' }] }, { weeklyHours: [{ day: 1, start: '09:00', end: '11:00' }, { day: 1, start: '10:00', end: '12:00' }] },
    { horizonDays: 0 }, { horizonDays: 91 }, { noticeHours: 169 }, { audience: 'PUBLIC' }, { questions: Array(6).fill(good.questions[0]) },
    { questions: [{ label: 'Q', kind: 'NUMBER', required: true }] }, { waiver: 'x'.repeat(4001) }, { thankYou: 'x'.repeat(501) }, { extra: 1 }]) {
    assert.throws(() => contracts.validateSaveBookingTypeInput({ ...good, ...patch }), undefined, JSON.stringify(patch));
  }
  assert.deepEqual(contracts.validateSetBookingTypeStatusInput({ expectedVersion: 1, status: 'ACTIVE' }), { expectedVersion: 1, status: 'ACTIVE' });
  assert.throws(() => contracts.validateSetBookingTypeStatusInput({ expectedVersion: 1, status: 'DRAFT' }), undefined, 'never back to draft');
  assert.throws(() => contracts.validateSetBookingTypeBookingStatusInput({ expectedVersion: 0, status: 'ARRIVED' }));
});

test('0286 public booking input: contact, answers and waiver', () => {
  const view = { questions: good.questions, waiver: good.waiver };
  const base = { startsAt: T, name: 'Kim Family', email: 'Kim@Example.test', mobile: '', answers: ['Min-jun', true], waiverAccepted: true, website: '' };
  assert.equal(contracts.validatePublicBookingTypeInput(base, view).email, 'kim@example.test');
  assert.equal(contracts.validatePublicBookingTypeInput({ ...base, email: '', mobile: '+15555550101' }, view).mobile, '+15555550101');
  for (const patch of [{ email: '' }, { email: 'nope' }, { email: '', mobile: '5550101' }, { website: 'x' }, { name: '' }, { startsAt: '2026-11-20T17:00:30.000Z' },
    { answers: ['', null] }, { answers: ['Sam', 'yes'] }, { answers: ['Sam'] }, { waiverAccepted: false }, { note: 'hi' }]) {
    assert.throws(() => contracts.validatePublicBookingTypeInput({ ...base, ...patch }, view), undefined, JSON.stringify(patch));
  }
  assert.throws(() => contracts.validatePublicBookingTypeInput(base, { ...view, waiver: '' }), undefined, 'no waiver means nothing to accept');
  assert.equal(contracts.normalizeBookingTypeCode(' abcd-ef01-2345 '), 'ABCDEF012345');
  assert.deepEqual(contracts.verifyPublicBookingTypeOutcome({ result: 'FULL' }), { result: 'FULL' });
  assert.throws(() => contracts.verifyPublicBookingTypeOutcome({ result: 'FULL', code: 'ABCDEF012345' }), undefined, 'a refusal never carries a code');
  assert.equal(contracts.verifyPublicBookingTypeCancelOutcome({ result: 'STARTED' }), 'STARTED');
});

test('0286 public read projection is exact and carries no names', () => {
  const view = {
    publicId: PUBLIC_ID, schoolName: 'Apex Dojo', branding: { logoUrl: null, coverUrl: null, accentColor: '#1d4ed8', contactLine: null }, name: 'Belt test', description: '',
    template: 'TEST_RESERVATION', durationMinutes: 30, audience: 'OPEN', questions: good.questions, waiver: good.waiver, timezone: 'America/Los_Angeles', status: 'OPEN',
    times: [{ startsAt: T, localDate: '2026-11-20', localStart: '09:00', localEnd: '09:30', spotsLeft: 2 }],
  };
  assert.deepEqual(contracts.verifyPublicBookingType(view, PUBLIC_ID), view);
  assert.throws(() => contracts.verifyPublicBookingType({ ...view, times: [{ ...view.times[0], names: ['x'] }] }, PUBLIC_ID), undefined, 'no names');
  assert.throws(() => contracts.verifyPublicBookingType(view, 'd'.repeat(48)), undefined, 'bound to the requested link');
  assert.throws(() => contracts.verifyPublicBookingType({ ...view, audience: 'FAMILIES_ONLY' }, PUBLIC_ID), undefined, 'families-only links show no times');
});

test('0286 service refuses before any database call and hides failures', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new BookingTypeService(database);
  const human = { organizationId: ID, schoolId: ID, principalId: ID, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: ID, correlationId: ID, idempotencyKey: 'key-1' };
  await assert.rejects(() => service.save({ ...human, source: 'AI_AGENT' }, null, good), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.save({ ...human, actionRequestId: ID }, null, good), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.save({ ...human, idempotencyKey: '' }, null, good), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.save(human, null, { ...good, name: '' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.list(human), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => service.detail({ ...human, idempotencyKey: '' }, 'nope'), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.equal(await service.published('nope'), null);
  const family = { startsAt: T, name: 'A', email: 'a@example.test', mobile: '', answers: [], waiverAccepted: false, website: '' };
  assert.deepEqual(await service.book(PUBLIC_ID, { ...family, email: '' }, 'k'.repeat(20)), { result: 'INVALID' });
  assert.deepEqual(await service.book(PUBLIC_ID, family, 'short'), { result: 'INVALID' });
  assert.equal(await service.cancel(PUBLIC_ID, { code: 'nope' }), 'INVALID');
  assert.equal(await service.cancel(PUBLIC_ID, { code: 'ABCDEF012345', more: 1 }), 'INVALID');
  assert.equal(calls, 0);
  const failing = new BookingTypeService({ runPublicEventCall: async () => { throw Object.assign(new Error('boom detail kim@example.test'), { code: 'XX000' }); } });
  assert.deepEqual(await failing.book(PUBLIC_ID, family, 'k'.repeat(20)), { result: 'UNAVAILABLE' });
  assert.equal(await failing.cancel(PUBLIC_ID, { code: 'ABCDEF012345' }), 'UNAVAILABLE');
});

function run(middleware, req) {
  return new Promise((resolve) => {
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, headers: this.headers }); }, on() {}, once() {}, emit() {} };
    middleware({ headers: {}, originalUrl: req.path, ...req }, res, () => resolve({ next: true, headers: res.headers }));
  });
}
test('0286 public transport: canonical paths only', async () => {
  const mw = publicBookingTypeTransport();
  assert.equal((await run(mw, { method: 'GET', path: '/v1/other' })).next, true, 'other paths pass through untouched');
  const read = await run(mw, { method: 'GET', path: `/v1/public/booking-types/${PUBLIC_ID}` });
  assert.equal(read.next, true); assert.equal(read.headers['cache-control'], 'no-store');
  for (const req of [{ method: 'GET', path: `/v1/public/booking-types/${PUBLIC_ID.toUpperCase()}` },
    { method: 'GET', path: `/v1/public/booking-types/${PUBLIC_ID}`, originalUrl: `/v1/public/booking-types/${PUBLIC_ID}?x=1` },
    { method: 'DELETE', path: `/v1/public/booking-types/${PUBLIC_ID}` }, { method: 'POST', path: `/v1/public/booking-types/${PUBLIC_ID}/other` },
    { method: 'POST', path: `/v1/public/booking-types/${PUBLIC_ID}/bookings`, headers: { 'content-type': 'text/plain' } }]) {
    const out = await run(mw, req);
    assert.equal(out.status, 400, JSON.stringify(req)); assert.deepEqual(out.body, { result: 'INVALID' });
  }
});
