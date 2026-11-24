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
const page = (patch = {}) => ({ publicId: PID, schoolName: 'Ideal Martial Arts', version: 2, title: { en: 'Summer camp' }, description: { en: 'Line one.\nLine two.' }, currency: 'USD',
  maxParticipants: 3, blocks: [{ position: 'ABOVE', text: { en: 'Bring water.' } }], options: [option(), monthly()],
  addOns: [{ key: 'uniform', label: { en: 'Uniform' }, amountMinor: 2500, required: false }], questions: [], hasWaiver: true, waiver: { en: 'I accept.' },
  thankYou: null, canPay: false, testMode: true, ...patch });
// The database row has providerCode in place of canPay/testMode; the API decides those.
const dbPage = (patch = {}) => { const { canPay, testMode, ...rest } = page(); return { ...rest, providerCode: null, ...patch }; };
const noPay = { supports: () => false };

test('0620 link and public page verifiers are closed', () => {
  assert.equal(contracts.verifySchoolCheckoutLinks({ links: [{ pageId: PAGE, publicId: PID }] }).links[0].publicId, PID);
  for (const bad of [{ links: [{ pageId: PAGE, publicId: 'x' }] }, { links: [{ pageId: PAGE, publicId: PID }, { pageId: PAGE, publicId: 'b2'.repeat(24) }] },
    { links: [{ pageId: PAGE, publicId: PID, extra: 1 }] }, { links: [], more: 1 }]) assert.throws(() => contracts.verifySchoolCheckoutLinks(bad));
  const read = contracts.verifyPublicCheckoutPage(page(), PID);
  assert.equal(read.options[1].downPayment.amountMinor, 45000);
  assert.equal(read.title.en, 'Summer camp');
  for (const bad of [page({ publicId: 'b2'.repeat(24) }), page({ options: [option({ recurringMinor: 1 })] }), page({ options: [monthly({ inFamilyApp: true })] }),
    page({ options: [monthly({ priceMinor: 1 })] }), page({ options: [option(), option()] }), page({ title: { en: '<b>x</b>' } }), page({ collectionMethod: 'IN_HOUSE' }),
    page({ options: [{ ...option(), planId: PAGE }] }), page({ maxParticipants: 11 }), page({ schoolName: '' }),
    page({ testMode: false }), page({ hasWaiver: false }), page({ waiver: null }), page({ providerCode: 'STRIPE_CONNECT' }),
    page({ questions: [{ key: 'belt', label: { en: 'Belt' }, kind: 'CHOICE', required: true, options: [{ en: 'White' }] }] })]) {
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
    { path: `/v1/public/checkout-pages/${PID}/orders`, method: 'POST' }, { path: `/v1/public/checkout-pages/${PID}/orders`, method: 'POST', headers: { 'content-type': 'text/plain' } },
    { path: `/v1/public/checkout-pages/${PID}/orders/refund`, method: 'POST', headers: { 'content-type': 'application/json' } },
    { path: `/v1/public/checkout-pages/${PID}/orders`, method: 'PUT', headers: { 'content-type': 'application/json' } },
    { path: `/v1/public/checkout-pages/${PID}/orders`, method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } },
    { path: `/v1/public/checkout-pages/${PID}`, headers: { 'content-length': '5' } }]) {
    const r = run(t, req);
    assert.equal(r.nextCalled, false, JSON.stringify(req)); assert.equal(r.status, 400);
  }
  const limited = run(publicCheckoutTransport({ admit: () => 30 }), { path: `/v1/public/checkout-pages/${PID}` });
  assert.equal(limited.status, 429); assert.equal(limited.headers['Retry-After'], '30');
});

test('0620 public service: one fixed call, NULL is not found, drift and errors are unavailable', async () => {
  const calls = [];
  const db = (answer) => ({ runPublicEventCall: async (statement, values) => { calls.push([statement, values]); if (answer instanceof Error) throw answer; return answer; } });
  assert.equal(await new PublicSchoolCheckoutService(db(null), noPay).page('nope'), null);
  assert.equal(calls.length, 0);
  assert.equal(await new PublicSchoolCheckoutService(db(null), noPay).page(PID), null);
  assert.deepEqual(calls[0], ['SELECT hon.read_public_school_checkout($1) AS data', [PID]]);
  const read = await new PublicSchoolCheckoutService(db(dbPage({ providerCode: 'STRIPE_CONNECT' })), noPay).page(PID);
  assert.equal(read.schoolName, 'Ideal Martial Arts'); assert.equal(read.canPay, false); assert.equal(read.testMode, true); assert.equal('providerCode' in read, false);
  for (const answer of [dbPage({ extra: 1 }), dbPage({ providerCode: 'PAYPAL' }), dbPage({ canPay: true }), new Error('boom')]) {
    await assert.rejects(new PublicSchoolCheckoutService(db(answer), noPay).page(PID), (error) => error.getStatus() === 503 && error.getResponse().result === 'UNAVAILABLE');
  }
});

// 0627: sign-up and pay from the link. A fake database answers each fixed call; a fake processor records what was asked of it.
const KEY = 'k'.repeat(40), ORDER = '33333333-3333-4333-8333-333333333333', PAY = '44444444-4444-4444-8444-444444444444';
const input = () => ({ expectedVersion: 2, optionKey: 'week', waiverAccepted: true, addOns: [], buyer: { name: 'Jo Kim', email: 'jo@example.com', mobile: '' },
  participants: [{ name: 'Ana Kim', answers: {} }], website: '' });
const orderRow = (status = 'OPEN') => ({ orderId: ORDER, title: 'Summer camp', optionKey: 'week', participantCount: 1, amountMinor: 5000, currency: 'USD', status,
  createdAt: '2026-11-21T10:00:00.000Z' });
const found = (patch = {}) => ({ result: 'FOUND', order: orderRow(), paymentId: PAY, paymentState: 'OPEN', providerCode: 'STRIPE_CONNECT', ...patch });
function harness({ open = { result: 'OPEN', orderId: ORDER }, latest = [found()], hosted = true, confirm = 'OPEN', cancel = 'CANCELED' } = {}) {
  const calls = [], asked = [];
  const queue = [...latest];
  const database = { runPublicEventCall: async (statement, values) => {
    calls.push([statement, values]);
    if (statement.includes('read_public_school_checkout')) return dbPage({ providerCode: 'STRIPE_CONNECT' });
    if (statement.includes('open_public_checkout_order')) return open;
    if (statement.includes('read_public_checkout_order')) return queue.length > 1 ? queue.shift() : queue[0];
    throw new Error('unexpected ' + statement);
  } };
  const once = {
    supports: (provider, surface) => hosted && provider === 'STRIPE_CONNECT' && surface === 'HOSTED',
    confirm: async (id) => { asked.push(['confirm', id]); return { paymentId: id, state: confirm, amountMinor: 5000, currency: 'USD', settledAt: null }; },
    cancel: async (id) => { asked.push(['cancel', id]); return { paymentId: id, state: cancel, amountMinor: 5000, currency: 'USD', settledAt: null }; },
    start: async (id, opts) => { asked.push(['start', id, opts]); return { paymentId: id, providerCode: 'STRIPE_CONNECT', surface: 'HOSTED', clientSecret: null,
      url: 'https://checkout.stripe.com/c/pay/cs_test_1', accountRef: null, expiresAt: '2026-11-21T10:30:00.000Z' }; },
  };
  return { service: new PublicSchoolCheckoutService(database, once), calls, asked };
}
async function withOrigin(run) {
  const saved = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://app.myhonos.com';
  try { return await run(); } finally { if (saved === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = saved; }
}

test('0627 order: refuses a bad body with no call, maps refusals, and opens the processor page back to the link', () => withOrigin(async () => {
  const h = harness();
  for (const body of [null, [], {}, { key: KEY }, { key: 'short', order: input() }, { key: KEY, order: { ...input(), extra: 1 } }, { key: KEY, order: input(), more: 1 },
    { key: KEY, order: { ...input(), buyer: { name: 'Jo', email: 'nope', mobile: '' } } }]) {
    assert.deepEqual(await h.service.order(PID, body), { result: 'INVALID', order: null, payState: 'NONE', url: null, expiresAt: null }, JSON.stringify(body));
  }
  assert.equal((await h.service.order('nope', { key: KEY, order: input() })).result, 'INVALID');
  assert.equal(h.calls.length, 0);
  const done = await h.service.order(PID, { key: KEY, order: input() });
  assert.equal(done.result, 'ORDER'); assert.equal(done.url, 'https://checkout.stripe.com/c/pay/cs_test_1'); assert.equal(done.payState, 'OPEN');
  const open = h.calls.find(c => c[0].includes('open_public_checkout_order'));
  assert.equal(open[0], 'SELECT hon.open_public_checkout_order($1,$2::jsonb,$3,$4::boolean) AS data');
  assert.deepEqual([open[1][0], JSON.parse(open[1][1]).buyer.email, open[1][2], open[1][3]], [PID, 'jo@example.com', KEY, true]);
  assert.deepEqual(h.asked.map(a => a[0]), ['confirm', 'start']);
  assert.deepEqual(h.asked[1][2], { surface: 'HOSTED', returnUrl: `https://app.myhonos.com/checkout/${PID}` });
  assert.equal(JSON.stringify(done).includes(PAY), false, 'the payment id never leaves the API');
  for (const [db, page] of [['UNAVAILABLE', 'OPTION_UNAVAILABLE'], ['FULL', 'FULL'], ['CHANGED', 'CHANGED'], ['WAIVER_REQUIRED', 'WAIVER_REQUIRED'],
    ['NOT_AVAILABLE', 'NOT_AVAILABLE'], ['RATE_LIMITED', 'RATE_LIMITED'], ['INVALID', 'INVALID']]) {
    assert.equal((await harness({ open: { result: db } }).service.order(PID, { key: KEY, order: input() })).result, page);
  }
  await assert.rejects(harness({ open: { result: 'SURPRISE' } }).service.order(PID, { key: KEY, order: input() }), (e) => e.getStatus() === 503);
  await assert.rejects(harness({ open: { result: 'OPEN', orderId: 'x' } }).service.order(PID, { key: KEY, order: input() }), (e) => e.getStatus() === 503);
  // Another order under the key than the one just opened is never shown.
  await assert.rejects(harness({ latest: [found({ order: { ...orderRow(), orderId: PAY } })] }).service.order(PID, { key: KEY, order: input() }), (e) => e.getStatus() === 503);
  // No processor that can show a hosted page: the database is told can_pay=false (it refuses a priced order itself).
  const nopay = harness({ hosted: false, open: { result: 'NOT_AVAILABLE' } });
  assert.equal((await nopay.service.order(PID, { key: KEY, order: input() })).result, 'NOT_AVAILABLE');
  assert.equal(nopay.calls.find(c => c[0].includes('open_public')) [1][3], false);
  // A free order is PAID with no payment.
  const free = harness({ open: { result: 'PAID', orderId: ORDER }, latest: [found({ order: orderRow('PAID'), paymentId: null, paymentState: null, providerCode: null })] });
  const freeDone = await free.service.order(PID, { key: KEY, order: input() });
  assert.deepEqual([freeDone.order.status, freeDone.payState, freeDone.url, free.asked.length], ['PAID', 'NONE', null, 0]);
}));

test('0627 pay, status, cancel: one key only; processor answers recorded; unknown key is not found', () => withOrigin(async () => {
  for (const step of ['start', 'status', 'cancel']) {
    const h = harness();
    for (const body of [null, {}, { key: KEY, order: {} }, { key: 'bad key' }]) assert.equal((await h.service[step](PID, body)).result, 'INVALID');
    assert.equal(h.calls.length, 0);
    assert.equal((await harness({ latest: [{ result: 'INVALID' }] }).service[step](PID, { key: KEY })).result, 'NOT_FOUND');
    assert.equal((await harness({ latest: [{ result: 'RATE_LIMITED' }] }).service[step](PID, { key: KEY })).result, 'RATE_LIMITED');
    await assert.rejects(harness({ latest: [found({ extra: 1 })] }).service[step](PID, { key: KEY }), (e) => e.getStatus() === 503);
    await assert.rejects(harness({ latest: [found({ paymentState: 'NONE' })] }).service[step](PID, { key: KEY }), (e) => e.getStatus() === 503);
  }
  const paid = harness({ confirm: 'SUCCEEDED', latest: [found(), found({ order: orderRow('PAID'), paymentState: 'SUCCEEDED' })] });
  const s = await paid.service.status(PID, { key: KEY });
  assert.deepEqual([s.order.status, s.payState, s.url], ['PAID', 'SUCCEEDED', null]);
  assert.deepEqual(paid.asked, [['confirm', PAY]]);
  // Pay on an order the processor already took: no new page.
  const already = harness({ confirm: 'SUCCEEDED', latest: [found(), found({ order: orderRow('PAID'), paymentState: 'SUCCEEDED' })] });
  const p = await already.service.start(PID, { key: KEY });
  assert.deepEqual([p.payState, p.url, already.asked.map(a => a[0]).join()], ['SUCCEEDED', null, 'confirm']);
  const canceled = harness({ latest: [found(), found({ order: orderRow('CANCELED'), paymentState: 'CANCELED' })] });
  const c = await canceled.service.cancel(PID, { key: KEY });
  assert.deepEqual([c.order.status, c.payState, canceled.asked.map(a => a[0]).join()], ['CANCELED', 'CANCELED', 'cancel']);
  // A settled payment is never cancelled or confirmed again.
  const settled = harness({ latest: [found({ order: orderRow('PAID'), paymentState: 'SUCCEEDED' })] });
  assert.equal((await settled.service.cancel(PID, { key: KEY })).payState, 'SUCCEEDED'); assert.equal(settled.asked.length, 0);
  // A processor failure is unavailable, never its detail.
  const broken = harness(); broken.service.once.confirm = async () => { throw new Error('stripe said sk_test_secret'); };
  await assert.rejects(broken.service.status(PID, { key: KEY }), (e) => e.getStatus() === 503 && JSON.stringify(e.getResponse()) === '{"result":"UNAVAILABLE"}');
}));

function post(transport, step, body, headers = { 'content-type': 'application/json' }) {
  const { Readable } = require('node:stream');
  const buffer = Buffer.from(body);
  const req = Object.assign(Readable.from([buffer]), { method: 'POST', path: `/v1/public/checkout-pages/${PID}/${step}`, originalUrl: `/v1/public/checkout-pages/${PID}/${step}`,
    headers: { 'content-length': String(buffer.length), ...headers } });
  return new Promise((resolve) => {
    const out = { headers: {}, status: 0 };
    const res = { setHeader: (k, v) => { out.headers[k] = v; }, status(s) { out.status = s; return this; }, json(b) { out.body = b; resolve(out); return this; } };
    transport(req, res, () => { out.next = true; out.parsed = req.body; resolve(out); });
  });
}
test('0627 transport: order steps are JSON POSTs of at most 8 KiB with their own per-client limits', async () => {
  const seen = [];
  const t = publicCheckoutTransport({ admit: (action) => { seen.push(action); return 0; } });
  for (const step of ['orders', 'orders/pay', 'orders/status', 'orders/cancel']) {
    const r = await post(t, step, JSON.stringify({ key: KEY }));
    assert.equal(r.next, true, step); assert.deepEqual(r.parsed, { key: KEY }); assert.equal(r.headers['Cache-Control'], 'no-store');
  }
  assert.deepEqual(seen, ['book', 'book', 'read', 'cancel']);
  assert.equal((await post(t, 'orders', JSON.stringify({ key: 'x'.repeat(9000) }))).status, 400);
  assert.equal((await post(t, 'orders', '{not json')).status, 400);
  assert.equal((await post(t, 'orders', '{}', { 'content-type': 'text/plain' })).status, 400);
  const limited = await post(publicCheckoutTransport({ admit: () => 9 }), 'orders', '{}');
  assert.equal(limited.status, 429); assert.equal(limited.headers['Retry-After'], '9');
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
  assert.doesNotMatch(pub, /UseGuards|application_fee|Idempotency|clientSecret|req\.cookies|organizationId/);
  assert.deepEqual(pub.match(/@Post\('[^']+'\)/g), ["@Post(':publicId/orders')", "@Post(':publicId/orders/pay')", "@Post(':publicId/orders/status')", "@Post(':publicId/orders/cancel')"]);
  assert.match(pub, /surface: 'HOSTED', returnUrl: back/);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8'), /app\.use\(publicCheckoutTransport\(\)\)/);
  const runtime = fs.readFileSync(path.join(__dirname, '../src/foundation/runtime-database.service.ts'), 'utf8');
  for (const call of ["'SELECT hon.read_public_school_checkout($1) AS data'", "'SELECT hon.open_public_checkout_order($1,$2::jsonb,$3,$4::boolean) AS data'",
    "'SELECT hon.read_public_checkout_order($1,$2) AS data'"]) assert.ok(runtime.includes(call), call);
  assert.match(controller, /@Get\('public-orders'\)[\s\S]*?@UseGuards\(SchoolCheckoutOrdersReadHumanUiGuard\)/);
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  for (const name of ['PublicSchoolCheckoutController', 'PublicSchoolCheckoutService', 'SchoolCheckoutLinksHumanUiGuard']) assert.match(module, new RegExp(name));
});
