const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contracts = require('@hon/contracts');

// B-TUI-2 piece 9a (0269): per-school checkout page settings; the database validates the same rules again.
const PLAN = '11111111-1111-4111-8111-111111111111';
const content = (patch = {}) => ({ planIds: [PLAN], addOns: [{ key: 'uniform', label: { en: 'Uniform', ko: '도복' }, amountMinor: 4500, currency: 'USD', required: true }],
  customFields: [{ key: 'size', label: { en: 'Size' }, kind: 'CHOICE', required: true, options: [{ en: 'S' }, { en: 'M' }] }],
  waiver: { text: { en: 'Line one.\nLine two.' } }, receiptNote: null, thankYou: { es: 'Gracias', en: 'Thanks' }, ...patch });

test('0269 save input is closed and keeps every allowed value exactly', () => {
  const input = contracts.validateSaveCheckoutPageInput({ kind: 'ENROLLMENT', expectedVersion: 0, status: 'PUBLISHED', content: content() });
  assert.deepEqual(input.content.thankYou, { en: 'Thanks', es: 'Gracias' });
  assert.equal(input.content.waiver.text.en, 'Line one.\nLine two.');
  assert.equal(contracts.validateSaveCheckoutPageInput({ kind: 'TUITION', expectedVersion: 3, status: 'PUBLISHED', content: content({ planIds: [] }) }).content.planIds.length, 0);
  for (const bad of [
    { kind: 'ENROLLMENT', expectedVersion: 0, status: 'PUBLISHED', content: content({ planIds: [] }) },
    { kind: 'BOOKING', expectedVersion: 0, status: 'DRAFT', content: content() },
    { kind: 'ENROLLMENT', expectedVersion: -1, status: 'DRAFT', content: content() },
    { kind: 'ENROLLMENT', expectedVersion: 0, status: 'DRAFT', content: content(), fee: 1 },
    { kind: 'ENROLLMENT', expectedVersion: 0, status: 'DRAFT', content: content({ receiptNote: { en: '<b>x</b>' } }) },
    { kind: 'ENROLLMENT', expectedVersion: 0, status: 'DRAFT', content: content({ receiptNote: { ko: 'x' } }) },
    { kind: 'ENROLLMENT', expectedVersion: 0, status: 'DRAFT', content: content({ thankYou: { en: 'a\tb' } }) },
    { kind: 'ENROLLMENT', expectedVersion: 0, status: 'DRAFT', content: content({ addOns: [{ key: 'u', label: { en: 'U' }, amountMinor: 0, currency: 'USD', required: true }] }) },
    { kind: 'ENROLLMENT', expectedVersion: 0, status: 'DRAFT', content: content({ customFields: [{ key: 'a', label: { en: 'A' }, kind: 'TEXT', required: true, options: [{ en: 'x' }] }] }) },
    { kind: 'ENROLLMENT', expectedVersion: 0, status: 'DRAFT', content: content({ planIds: [PLAN, PLAN] }) },
    { kind: 'ENROLLMENT', expectedVersion: 0, status: 'DRAFT', content: { ...content(), extra: 1 } },
  ]) assert.throws(() => contracts.validateSaveCheckoutPageInput(bad), undefined, JSON.stringify(bad).slice(0, 120));
});

test('0269 read verifier checks both pages, their kinds and the plan list', () => {
  const page = (kind, patch = {}) => ({ pageId: '22222222-2222-4222-8222-222222222222', kind, status: 'DRAFT', content: content(), version: 1, updatedAt: '2026-11-12T02:00:00.000Z', ...patch });
  const plans = [{ planId: PLAN, displayName: 'Kids monthly', priceMinor: 14900, currency: 'USD', billingFrequency: 'MONTHLY', available: true }];
  assert.equal(contracts.verifySchoolCheckoutPages({ enrollment: page('ENROLLMENT'), tuition: null, plans }).plans[0].displayName, 'Kids monthly');
  assert.throws(() => contracts.verifySchoolCheckoutPages({ enrollment: page('TUITION'), tuition: null, plans }));
  assert.throws(() => contracts.verifySchoolCheckoutPages({ enrollment: page('ENROLLMENT', { status: 'PUBLISHED', content: content({ planIds: [] }) }), tuition: null, plans }));
  assert.throws(() => contracts.verifySchoolCheckoutPages({ enrollment: null, tuition: null, plans: [...plans, ...plans] }));
  assert.throws(() => contracts.verifyCheckoutPageReceipt({ page: page('ENROLLMENT', { version: 2 }) }, { kind: 'ENROLLMENT', version: 1 }));
});

test('0269 API: two routes under their own human-UI guards; no fee, no payment, no public route', () => {
  const dir = path.join(__dirname, '../src/school-checkout');
  const controller = fs.readFileSync(path.join(dir, 'school-checkout.controller.ts'), 'utf8');
  assert.match(controller, /@Controller\('organizations\/:organizationId\/schools\/:schoolId\/payments\/checkout-pages'\)/);
  assert.equal((controller.match(/@UseGuards\(SchoolCheckout[A-Za-z]+HumanUiGuard\)/g) ?? []).length, 2);
  const service = fs.readFileSync(path.join(dir, 'school-checkout.service.ts'), 'utf8');
  for (const fn of ['read_school_checkout_pages', 'save_school_checkout_page']) assert.match(service, new RegExp(`hon\\.${fn}\\(`));
  const sources = ['school-checkout.service.ts', 'school-checkout.controller.ts'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /application_fee|app_fee_money|PAYMENT_PROVIDER_ADAPTER|STRIPE_|@Public|SCHOOL_PAYMENT_ADAPTERS/);
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  for (const name of ['SchoolCheckoutController', 'SchoolCheckoutService', 'SchoolCheckoutReadHumanUiGuard', 'SchoolCheckoutSaveHumanUiGuard']) assert.match(module, new RegExp(name));
});
