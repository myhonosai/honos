const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { JourneyRecommendationsService, translateJourneyRecommendationError } = require('../dist/journey-recommendations/journey-recommendations.service.js');

// 0603 journey recommendations: inputs and projections are verified exactly and the service refuses before any database call.
const id = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const input = (patch = {}) => ({ recommendationId: null, expectedVersion: null, curriculumId: id(1), triggerKind: 'RANK_REACHED', rankId: id(2), threshold: null,
  title: 'Sparring club', message: 'Open to Yellow belts.', targetKind: 'ASK_SCHOOL', targetCheckoutId: null, targetEventId: null, skipEnrolled: false, ...patch });
const family = (patch = {}) => ({ recommendationId: id(9), program: 'Kids Karate', rank: 'Yellow Belt', triggerKind: 'RANK_REACHED', threshold: null,
  title: 'Sparring club', message: 'Open to Yellow belts.', targetKind: 'ASK_SCHOOL', checkoutId: null, eventId: null, targetLabel: null, ...patch });

test('0603 save input follows the trigger and target rules the database enforces', () => {
  assert.deepEqual(contracts.validateSaveJourneyRecommendationInput(input()), input());
  assert.equal(contracts.validateSaveJourneyRecommendationInput(input({ triggerKind: 'CLASSES_ATTENDED', rankId: null, threshold: 20 })).threshold, 20);
  assert.equal(contracts.validateSaveJourneyRecommendationInput(input({ targetKind: 'CHECKOUT', targetCheckoutId: id(3), skipEnrolled: true })).skipEnrolled, true);
  for (const [label, bad] of [
    ['rank trigger without rank', input({ rankId: null })], ['rank trigger with threshold', input({ threshold: 3 })],
    ['requirements over 100', input({ triggerKind: 'REQUIREMENTS_MET', threshold: 101 })], ['classes over 1000', input({ triggerKind: 'CLASSES_ATTENDED', threshold: 1001 })],
    ['checkout without page', input({ targetKind: 'CHECKOUT' })], ['skip for an event', input({ targetKind: 'EVENT', targetEventId: id(4), skipEnrolled: true })],
    ['id without version', input({ recommendationId: id(5) })], ['extra key', { ...input(), schoolId: id(6) }], ['title newline', input({ title: 'a\nb' })],
    ['long message', input({ message: 'x'.repeat(401) })], ['unknown trigger', input({ triggerKind: 'BIRTHDAY' })],
  ]) assert.throws(() => contracts.validateSaveJourneyRecommendationInput(bad), undefined, label);
  assert.throws(() => contracts.validateSetJourneyRecommendationStatusInput({ recommendationId: id(1), expectedVersion: 1, status: 'GONE' }));
});

test('0603 family projection is display fields only', () => {
  const view = { children: [{ name: 'Mia Kim', recommendations: [family(), family({ recommendationId: id(10), targetKind: 'CHECKOUT', checkoutId: id(3), targetLabel: 'Summer camp' })] }] };
  assert.deepEqual(contracts.verifyParentJourneyRecommendations(view), view);
  for (const [label, bad] of [
    ['staff id', { children: [{ name: 'Mia', recommendations: [{ ...family(), createdBy: id(1) }] }] }],
    ['checkout without label', { children: [{ name: 'Mia', recommendations: [family({ targetKind: 'CHECKOUT', checkoutId: id(3) })] }] }],
    ['label on ask school', { children: [{ name: 'Mia', recommendations: [family({ targetLabel: 'x' })] }] }],
    ['duplicate', { children: [{ name: 'Mia', recommendations: [family(), family()] }] }],
    ['too many', { children: [{ name: 'Mia', recommendations: Array.from({ length: 11 }, (_, i) => family({ recommendationId: id(20 + i) })) }] }],
  ]) assert.throws(() => contracts.verifyParentJourneyRecommendations(bad), undefined, label);
});

test('0603 service refuses before any database call and maps errors to closed codes', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new JourneyRecommendationsService(database);
  await assert.rejects(() => service.parentRead(''), (e) => e.response.code === 'JOURNEY_RECOMMENDATIONS_FORBIDDEN');
  const staff = { principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'staff', idempotencyKey: 'key-1', requestId: id(1), correlationId: id(1) };
  await assert.rejects(() => service.save({ ...staff, source: 'AI_AGENT' }, input()), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.save({ ...staff, idempotencyKey: '' }, input()), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.save(staff, { ...input(), title: '' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.setStatus(staff, 'nope', { expectedVersion: 1, status: 'OFF' }), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.equal(calls, 0);
  const code = (sqlState, message = 'x') => { try { translateJourneyRecommendationError(Object.assign(new Error(message), { code: sqlState })); } catch (e) { return [e.getStatus(), e.response.code]; } };
  assert.deepEqual(code('42501'), [403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN']);
  assert.deepEqual(code('P0002', 'JOURNEY_RECOMMENDATIONS_NOT_FOUND'), [404, 'JOURNEY_RECOMMENDATIONS_NOT_FOUND']);
  assert.deepEqual(code('53400', 'JOURNEY_RECOMMENDATIONS_LIMIT'), [422, 'JOURNEY_RECOMMENDATIONS_LIMIT']);
  assert.deepEqual(code('40001', 'VERSION_CONFLICT'), [409, 'VERSION_CONFLICT']);
  assert.deepEqual(code('53400', 'JOURNEY_SIBLING_LIMIT'), [422, 'JOURNEY_SIBLING_LIMIT']);
  assert.deepEqual(code('08006'), [503, 'JOURNEY_RECOMMENDATIONS_UNAVAILABLE']);
});

test('0608 family answers and the staff interest list are verified exactly', async () => {
  const want = { kind: 'INTERESTED', childName: 'Mia Park', sibling: false };
  assert.deepEqual(contracts.validateParentJourneyResponseInput({ kind: 'HIDDEN' }), { kind: 'HIDDEN' });
  assert.deepEqual(contracts.validateParentJourneyResponseInput(want), want);
  assert.deepEqual(contracts.validateParentJourneyResponseInput({ ...want, childName: 'Sam', sibling: true }), { ...want, childName: 'Sam', sibling: true });
  for (const bad of [{}, { kind: 'hidden' }, { kind: 'LIKED' }, { kind: 'HIDDEN', familyId: id(1) }, { kind: 'HIDDEN', childName: 'Mia' }, null, 'HIDDEN',
    { kind: 'INTERESTED' }, { kind: 'INTERESTED', childName: 'Mia Park' }, { ...want, childName: ' ' }, { ...want, childName: 'a\nb' }, { ...want, sibling: 'yes' },
    { ...want, childName: 'Sam ', sibling: true }, { ...want, childName: 'x'.repeat(81), sibling: true }, { ...want, familyId: id(1) }])
    assert.throws(() => contracts.validateParentJourneyResponseInput(bad), undefined, JSON.stringify(bad));
  const receipt = { recommendationId: id(9), kind: 'INTERESTED', childName: 'Mia Park', recordedAt: '2026-11-20T10:00:00.000Z', replayed: false };
  assert.deepEqual(contracts.verifyParentJourneyResponseReceipt(receipt, { recommendationId: id(9), ...want }), receipt);
  assert.deepEqual(contracts.verifyParentJourneyResponseReceipt(receipt, { recommendationId: id(9), ...want, childName: 'mia park' }), receipt, 'a replay keeps the first spelling');
  assert.throws(() => contracts.verifyParentJourneyResponseReceipt(receipt, { recommendationId: id(8), ...want }), undefined, 'another recommendation');
  assert.throws(() => contracts.verifyParentJourneyResponseReceipt(receipt, { recommendationId: id(9), ...want, childName: 'Leo Park' }), undefined, 'another child');
  assert.throws(() => contracts.verifyParentJourneyResponseReceipt(receipt, { recommendationId: id(9), kind: 'HIDDEN' }), undefined, 'another answer');
  assert.throws(() => contracts.verifyParentJourneyResponseReceipt({ ...receipt, leadId: id(1) }, { recommendationId: id(9), ...want }), undefined, 'extra key');
  const hidden = { ...receipt, kind: 'HIDDEN', childName: null };
  assert.deepEqual(contracts.verifyParentJourneyResponseReceipt(hidden, { recommendationId: id(9), kind: 'HIDDEN' }), hidden);
  const row = { recommendationId: id(9), familyId: id(2), familyName: 'Park Family', childName: 'Mia Park', sibling: false, leadId: id(3), recordedAt: '2026-11-20T10:00:00.000Z' };
  const list = { interest: [row, { ...row, childName: 'Sam', sibling: true, leadId: null }] };
  assert.deepEqual(contracts.verifyJourneyRecommendationInterest(list), list);
  for (const [label, bad] of [['email', { interest: [{ ...row, email: 'x@example.test' }] }], ['no child', { interest: [{ ...row, childName: '' }] }],
    ['duplicate', { interest: [row, { ...row, childName: 'MIA PARK' }] }], ['bad date', { interest: [{ ...row, recordedAt: 'yesterday' }] }], ['bad lead', { interest: [{ ...row, leadId: 'x' }] }]])
    assert.throws(() => contracts.verifyJourneyRecommendationInterest(bad), undefined, label);

  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new JourneyRecommendationsService(database);
  await assert.rejects(() => service.parentRespond('', id(9), { kind: 'HIDDEN' }), (e) => e.response.code === 'JOURNEY_RECOMMENDATIONS_FORBIDDEN');
  await assert.rejects(() => service.parentRespond('parent', 'nope', { kind: 'HIDDEN' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.parentRespond('parent', id(9), { kind: 'INTERESTED' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.interest({ principalType: 'HUMAN_USER', source: 'AI_AGENT', externalSubject: 'staff', idempotencyKey: '', requestId: id(1), correlationId: id(1) }),
    (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  assert.equal(calls, 0);
});
