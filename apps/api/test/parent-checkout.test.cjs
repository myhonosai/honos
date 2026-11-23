const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { ParentCheckoutService } = require('../dist/family-checkout/parent-checkout.service.js');

// 0598 family checkout: the app input and the projections are verified exactly; the service refuses before any database call.
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const order = (patch = {}) => ({ checkoutId: U(1), expectedVersion: 1, optionKey: 'week', waiverAccepted: true, addOns: ['patch'],
  participants: [{ studentProfileId: U(2), answers: { size: 'M', photo: true } }], ...patch });
const page = { checkoutId: U(1), version: 1, group: 'events', title: 'Camp', description: null, currency: 'USD', maxParticipants: 2,
  blocks: [{ position: 'ABOVE', text: 'Bring water.' }], options: [{ key: 'week', label: 'Week', description: null, priceMinor: 5000, additionalParticipantMinor: null, mostPopular: false, placesLeft: 3 }],
  addOns: [{ key: 'patch', label: 'Patch', amountMinor: 500, required: true }], questions: [{ key: 'size', label: 'Size', kind: 'TEXT', required: true, options: [] }],
  waiver: 'Rules', thankYou: null };
const listed = { orderId: U(9), checkoutId: U(1), title: 'Camp - Week', optionKey: 'week', participantCount: 1, amountMinor: 5500, currency: 'USD', status: 'UNPAID', createdAt: '2026-11-19T10:00:00.000Z' };

test('0598 order input is closed', () => {
  assert.deepEqual(contracts.validateOpenParentCheckoutOrderInput(order()), order());
  for (const [label, bad] of [
    ['amount', { ...order(), amountMinor: 1 }],
    ['no child', order({ participants: [] })],
    ['same child twice', order({ participants: [order().participants[0], order().participants[0]] })],
    ['bad key', order({ optionKey: 'Week' })],
    ['duplicate add-on', order({ addOns: ['patch', 'patch'] })],
    ['answer type', order({ participants: [{ studentProfileId: U(2), answers: { size: 3 } }] })],
    ['control character', order({ participants: [{ studentProfileId: U(2), answers: { size: 'a\u0007' } }] })],
    ['school', { ...order(), schoolId: U(3) }],
  ]) assert.throws(() => contracts.validateOpenParentCheckoutOrderInput(bad), undefined, label);
});

test('0598 projections are verified exactly', () => {
  const view = { schoolName: 'Dojo', canBuy: true, canPay: true, testMode: true, pages: [page], children: [{ studentProfileId: U(2), displayName: 'Mina Park' }], orders: [listed] };
  assert.deepEqual(contracts.verifyParentCheckoutPages(view), view);
  assert.throws(() => contracts.verifyParentCheckoutPages({ ...view, providerCode: 'STRIPE_CONNECT' }));
  assert.throws(() => contracts.verifyParentCheckoutPages({ ...view, testMode: false }));
  assert.throws(() => contracts.verifyParentCheckoutPages({ ...view, pages: [{ ...page, options: [] }] }));
  const start = { orderId: U(9), status: 'OPEN', payState: 'OPEN', amountMinor: 5500, currency: 'USD', url: 'https://checkout.stripe.test/x', expiresAt: '2026-11-19T10:30:00.000Z' };
  assert.deepEqual(contracts.verifyParentCheckoutOrderStart(start), start);
  assert.throws(() => contracts.verifyParentCheckoutOrderStart({ ...start, payState: 'SUCCEEDED' }));
  assert.throws(() => contracts.verifyParentCheckoutOrderStart({ ...start, url: 'http://x.test' }));
  assert.throws(() => contracts.verifyParentCheckoutOrderStart({ ...start, paymentId: U(5) }));
});

test('0598 service refuses before any database call', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new ParentCheckoutService(database, {});
  process.env.HON_PUBLIC_ORIGIN = 'https://app.example.test';
  await assert.rejects(() => service.order('s', { ...order(), amountMinor: 1 }, 'k'), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.order('s', order(), ''), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.start('s', 'not-a-uuid'), (e) => e.response.code === 'VALIDATION_FAILED');
  delete process.env.HON_PUBLIC_ORIGIN;
  await assert.rejects(() => service.order('s', order(), 'k'), (e) => e.response.code === 'FAMILY_CHECKOUT_NOT_CONFIGURED');
  assert.equal(calls, 0);
});
