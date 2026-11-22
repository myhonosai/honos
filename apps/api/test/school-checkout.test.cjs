const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contracts = require('@hon/contracts');

// Checkout pages CP1 (0402): many named pages per school; the database validates the same rules again.
const PLAN = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const oneTime = (patch = {}) => ({ key: 'six_months', label: { en: '6 Months 1 time' }, description: null, planId: PLAN, billing: 'ONE_TIME', priceMinor: 121500,
  recurringMinor: null, installments: null, downPayment: null, collectionMethod: null, additionalParticipantMinor: null, capacity: 0, availableThrough: null,
  mostPopular: false, createsMembership: true, ...patch });
const monthly = (patch = {}) => oneTime({ key: 'monthly', billing: 'MONTHLY', priceMinor: null, recurringMinor: 22500, installments: 10, collectionMethod: 'AUTO_CHARGE',
  downPayment: { amountMinor: 45000, label: { en: 'First and Last Month' } }, ...patch });
const content = (patch = {}) => ({ currency: 'USD', title: { en: 'Green Belt', ko: '그린벨트' }, description: { en: 'Line one.\nLine two.' },
  blocks: [{ position: 'ABOVE', text: { en: 'Pick a plan.' } }], multiParticipant: { enabled: true, maxPerOrder: 4 },
  customFields: [{ key: 'size', label: { en: 'Size' }, kind: 'CHOICE', required: true, options: [{ en: 'S' }, { en: 'M' }] }],
  addOns: [{ key: 'uniform', label: { en: 'Uniform', ko: '도복' }, amountMinor: 4500, currency: 'USD', required: true }],
  options: [oneTime(), monthly({ mostPopular: true })], waiver: { text: { en: 'Risk.' } }, receiptNote: null, thankYou: { es: 'Gracias', en: 'Thanks' }, ...patch });
const save = (patch = {}) => ({ pageId: null, expectedVersion: 0, slug: 'green-belt', groupKey: 'membership', status: 'PUBLISHED', content: content(), ...patch });

test('0402 page save input is closed and keeps every allowed value exactly', () => {
  const input = contracts.validateSaveCheckoutPageInput(save());
  assert.deepEqual(input.content.thankYou, { en: 'Thanks', es: 'Gracias' });
  assert.equal(input.content.options[1].downPayment.amountMinor, 45000);
  assert.equal(contracts.checkoutOptionDueTodayMinor(input.content.options[1]), 45000);
  assert.equal(contracts.checkoutOptionDueTodayMinor(monthly({ downPayment: null })), 22500);
  assert.equal(contracts.validateSaveCheckoutPageInput(save({ pageId: PAGE, expectedVersion: 3, status: 'DRAFT', content: content({ options: [] }) })).content.options.length, 0);
  assert.equal(contracts.validateSaveCheckoutPageInput(save({ content: content({ options: [oneTime({ priceMinor: 0, planId: null, createsMembership: false })] }) })).content.options[0].priceMinor, 0);
  for (const bad of [
    save({ status: 'PUBLISHED', content: content({ options: [] }) }), save({ status: 'LIVE' }), save({ expectedVersion: 1 }), save({ pageId: PAGE, expectedVersion: 0 }),
    save({ slug: 'Green' }), save({ slug: 'a' }), save({ slug: 'a--b' }), save({ slug: 'ab-' }), save({ groupKey: 'Bad' }), { ...save(), fee: 1 },
    save({ content: content({ title: { en: '<b>x</b>' } }) }), save({ content: content({ title: { ko: 'x' } }) }), save({ content: content({ receiptNote: { en: 'a\tb' } }) }),
    save({ content: content({ addOns: [{ key: 'u', label: { en: 'U' }, amountMinor: 100, currency: 'KRW', required: true }] }) }),
    save({ content: content({ options: [oneTime({ recurringMinor: 1 })] }) }), save({ content: content({ options: [monthly({ priceMinor: 1 })] }) }),
    save({ content: content({ options: [monthly({ installments: 121 })] }) }), save({ content: content({ options: [monthly({ collectionMethod: 'STRIPE' })] }) }),
    save({ content: content({ options: [oneTime({ planId: null })] }) }), save({ content: content({ options: [oneTime(), oneTime()] }) }),
    save({ content: content({ options: [oneTime({ mostPopular: true }), monthly({ mostPopular: true })] }) }),
    save({ content: content({ options: [oneTime({ availableThrough: '2026-02-30' })] }) }), save({ content: content({ options: [oneTime({ priceMinor: 1.5 })] }) }),
    save({ content: content({ multiParticipant: { enabled: false, maxPerOrder: 2 } }) }), save({ content: { ...content(), extra: 1 } }),
  ]) assert.throws(() => contracts.validateSaveCheckoutPageInput(bad), undefined, JSON.stringify(bad).slice(0, 160));
});

test('0402 settings input and the read verifier', () => {
  const groups = [{ key: 'sales', label: { en: 'Sales' } }];
  assert.equal(contracts.validateSaveCheckoutSettingsInput({ expectedVersion: 0, groups, pageOrder: [PAGE] }).groups[0].key, 'sales');
  for (const bad of [{ expectedVersion: 0, groups: [], pageOrder: [] }, { expectedVersion: 0, groups: [...groups, ...groups], pageOrder: [] },
    { expectedVersion: 0, groups, pageOrder: [PAGE, PAGE] }, { expectedVersion: -1, groups, pageOrder: [] }]) assert.throws(() => contracts.validateSaveCheckoutSettingsInput(bad));
  const page = (patch = {}) => ({ pageId: PAGE, slug: 'green-belt', groupKey: 'membership', status: 'PUBLISHED', content: content(), version: 2, updatedAt: '2026-11-16T02:00:00.000Z', ...patch });
  const plans = [{ planId: PLAN, displayName: 'Kids monthly', priceMinor: 14900, currency: 'USD', billingFrequency: 'MONTHLY', available: true }];
  const settings = { version: 0, groups: contracts.DEFAULT_CHECKOUT_GROUPS, pageOrder: [] };
  assert.equal(contracts.verifySchoolCheckoutPages({ settings, pages: [page()], plans }).pages[0].slug, 'green-belt');
  assert.throws(() => contracts.verifySchoolCheckoutPages({ settings, pages: [page(), page()], plans }));
  assert.throws(() => contracts.verifySchoolCheckoutPages({ settings, pages: [page({ content: content({ options: [] }) })], plans }));
  assert.throws(() => contracts.verifySchoolCheckoutPages({ settings, pages: [], plans: [...plans, ...plans] }));
  assert.throws(() => contracts.verifyCheckoutPageReceipt({ page: page() }, { pageId: PAGE, slug: 'green-belt', version: 3 }));
  assert.throws(() => contracts.verifyCheckoutPageReceipt({ page: page() }, { pageId: PAGE, slug: 'other', version: 2 }));
  assert.equal(contracts.verifyCheckoutSettingsReceipt({ settings: { ...settings, version: 1 } }, { version: 1 }).settings.groups.length, 8);
});

test('0402 API: three routes (plus the 0598 orders read) under their own human-UI guards; no fee, no payment, no public route; 0269 entry points unused', () => {
  const dir = path.join(__dirname, '../src/school-checkout');
  const controller = fs.readFileSync(path.join(dir, 'school-checkout.controller.ts'), 'utf8');
  assert.match(controller, /@Controller\('organizations\/:organizationId\/schools\/:schoolId\/payments\/checkout-pages'\)/);
  assert.equal((controller.match(/@UseGuards\(SchoolCheckout[A-Za-z]+HumanUiGuard\)/g) ?? []).length, 4);
  assert.match(controller, /@Post\('settings'\)/);
  assert.match(controller, /@Get\('orders'\)[\s\S]*@UseGuards\(SchoolCheckoutOrdersReadHumanUiGuard\)/);
  const service = fs.readFileSync(path.join(dir, 'school-checkout.service.ts'), 'utf8');
  for (const fn of ['read_school_checkouts', 'save_school_checkout', 'save_school_checkout_settings']) assert.match(service, new RegExp(`hon\\.${fn}\\(`));
  assert.doesNotMatch(service, /read_school_checkout_pages|save_school_checkout_page\(/);
  const sources = ['school-checkout.service.ts', 'school-checkout.controller.ts'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /application_fee|app_fee_money|PAYMENT_PROVIDER_ADAPTER|STRIPE_|@Public|SCHOOL_PAYMENT_ADAPTERS/);
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  for (const name of ['SchoolCheckoutController', 'SchoolCheckoutService', 'SchoolCheckoutReadHumanUiGuard', 'SchoolCheckoutSaveHumanUiGuard', 'SchoolCheckoutSettingsSaveHumanUiGuard', 'SchoolCheckoutOrdersReadHumanUiGuard']) {
    assert.match(module, new RegExp(name));
  }
});
