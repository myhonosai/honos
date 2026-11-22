const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contracts = require('@hon/contracts');
const { publicCheckoutTransport, PublicSchoolCheckoutService } = require('../dist/school-checkout/public-school-checkout.js');

// Checkout page share links (0620): staff get each page's link; anyone with the link reads the live page only.
const PAGE = '22222222-2222-4222-8222-222222222222';
const PID = 'a1'.repeat(24);
const option = (patch = {}) => ({ key: 'week', label: { en: 'Week', ko: '주간' }, description: null, billing: 'ONE_TIME', priceMinor: 5000, recurringMinor: null,
  installments: null, downPayment: null, additionalParticipantMinor: 3000, mostPopular: true, placesLeft: 3, inFamilyApp: true, ...patch });
const monthly = (patch = {}) => option({ key: 'monthly', billing: 'MONTHLY', priceMinor: null, recurringMinor: 22500, installments: 12,
  downPayment: { amountMinor: 45000, label: { en: 'First and last month' } }, additionalParticipantMinor: null, mostPopular: false, placesLeft: null, inFamilyApp: false, ...patch });
const page = (patch = {}) => ({ publicId: PID, schoolName: 'Ideal Martial Arts', title: { en: 'Summer camp' }, description: { en: 'Line one.\nLine two.' }, currency: 'USD',
  maxParticipants: 3, blocks: [{ position: 'ABOVE', text: { en: 'Bring water.' } }], options: [option(), monthly()],
  addOns: [{ label: { en: 'Uniform' }, amountMinor: 2500, required: false }], hasWaiver: true, ...patch });

test('0620 link and public page verifiers are closed', () => {
  assert.equal(contracts.verifySchoolCheckoutLinks({ links: [{ pageId: PAGE, publicId: PID }] }).links[0].publicId, PID);
  for (const bad of [{ links: [{ pageId: PAGE, publicId: 'x' }] }, { links: [{ pageId: PAGE, publicId: PID }, { pageId: PAGE, publicId: 'b2'.repeat(24) }] },
    { links: [{ pageId: PAGE, publicId: PID, extra: 1 }] }, { links: [], more: 1 }]) assert.throws(() => contracts.verifySchoolCheckoutLinks(bad));
  const read = contracts.verifyPublicCheckoutPage(page(), PID);
  assert.equal(read.options[1].downPayment.amountMinor, 45000);
  assert.equal(read.title.en, 'Summer camp');
  for (const bad of [page({ publicId: 'b2'.repeat(24) }), page({ options: [option({ recurringMinor: 1 })] }), page({ options: [monthly({ inFamilyApp: true })] }),
    page({ options: [monthly({ priceMinor: 1 })] }), page({ options: [option(), option()] }), page({ title: { en: '<b>x</b>' } }), page({ collectionMethod: 'IN_HOUSE' }),
    page({ options: [{ ...option(), planId: PAGE }] }), page({ maxParticipants: 11 }), page({ schoolName: '' })]) {
    assert.throws(() => contracts.verifyPublicCheckoutPage(bad, PID), undefined, JSON.stringify(bad).slice(0, 120));
  }
  assert.throws(() => contracts.verifyPublicCheckoutPage(page(), 'b2'.repeat(24)));
});

function run(transport, req) {
  const headers = {}; let status = 0, body, nextCalled = false;
  const res = { setHeader: (k, v) => { headers[k] = v; }, status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  transport({ method: 'GET', headers: {}, originalUrl: req.path, ...req }, res, () => { nextCalled = true; });
  return { status, body, headers, nextCalled };
}
test('0620 public transport: one GET path, no query, no body, per-client read limit', () => {
  const clients = { admit: () => 0 };
  const t = publicCheckoutTransport(clients);
  assert.equal(run(t, { path: '/v1/public/events/x' }).nextCalled, true);
  const good = run(t, { path: `/v1/public/checkout-pages/${PID}` });
  assert.equal(good.nextCalled, true);
  assert.equal(good.headers['Cache-Control'], 'no-store');
  assert.equal(good.headers['Referrer-Policy'], 'no-referrer');
  for (const req of [{ path: `/v1/public/checkout-pages/${PID}`, method: 'POST' }, { path: `/v1/public/checkout-pages/${PID}`, originalUrl: `/v1/public/checkout-pages/${PID}?a=1` },
    { path: `/v1/public/checkout-pages/${PID.toUpperCase()}` }, { path: '/v1/public/checkout-pages/abc' }, { path: '/v1/public/checkout-pages' },
    { path: `/v1/public/checkout-pages/${PID}/orders`, method: 'POST' }, { path: `/v1/public/checkout-pages/${PID}`, headers: { 'content-length': '5' } }]) {
    const r = run(t, req);
    assert.equal(r.nextCalled, false, JSON.stringify(req)); assert.equal(r.status, 400);
  }
  const limited = run(publicCheckoutTransport({ admit: () => 30 }), { path: `/v1/public/checkout-pages/${PID}` });
  assert.equal(limited.status, 429); assert.equal(limited.headers['Retry-After'], '30');
});

test('0620 public service: one fixed call, NULL is not found, drift and errors are unavailable', async () => {
  const calls = [];
  const db = (answer) => ({ runPublicEventCall: async (statement, values) => { calls.push([statement, values]); if (answer instanceof Error) throw answer; return answer; } });
  assert.equal(await new PublicSchoolCheckoutService(db(null)).page('nope'), null);
  assert.equal(calls.length, 0);
  assert.equal(await new PublicSchoolCheckoutService(db(null)).page(PID), null);
  assert.deepEqual(calls[0], ['SELECT hon.read_public_school_checkout($1) AS data', [PID]]);
  assert.equal((await new PublicSchoolCheckoutService(db(page())).page(PID)).schoolName, 'Ideal Martial Arts');
  for (const answer of [page({ extra: 1 }), new Error('boom')]) {
    await assert.rejects(new PublicSchoolCheckoutService(db(answer)).page(PID), (error) => error.getStatus() === 503 && error.getResponse().result === 'UNAVAILABLE');
  }
});

test('0620 wiring: links route under its own guard without a key; public controller read only; transport mounted; fixed call allow-listed', () => {
  const dir = path.join(__dirname, '../src/school-checkout');
  const controller = fs.readFileSync(path.join(dir, 'school-checkout.controller.ts'), 'utf8');
  assert.match(controller, /@Post\('links'\)[\s\S]*?@UseGuards\(SchoolCheckoutLinksHumanUiGuard\)[\s\S]*?IDEMPOTENCY_KEY_NOT_ACCEPTED/);
  const guard = fs.readFileSync(path.join(dir, 'school-checkout-human-ui.guard.ts'), 'utf8');
  assert.match(guard, /SchoolCheckoutLinksHumanUiGuard[\s\S]*'school_checkout\.links\.issue'/);
  const service = fs.readFileSync(path.join(dir, 'school-checkout.service.ts'), 'utf8');
  assert.match(service, /async links[\s\S]*?withTenantTransaction[\s\S]*?hon\.issue_school_checkout_links\(\$1\)/);
  const pub = fs.readFileSync(path.join(dir, 'public-school-checkout.ts'), 'utf8');
  assert.match(pub, /@Controller\('public\/checkout-pages'\)/);
  assert.doesNotMatch(pub, /@Post|UseGuards|application_fee|school_pay_once|Idempotency/i);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8'), /app\.use\(publicCheckoutTransport\(\)\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/foundation/runtime-database.service.ts'), 'utf8'), /'SELECT hon\.read_public_school_checkout\(\$1\) AS data'/);
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  for (const name of ['PublicSchoolCheckoutController', 'PublicSchoolCheckoutService', 'SchoolCheckoutLinksHumanUiGuard']) assert.match(module, new RegExp(name));
});
