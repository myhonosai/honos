const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { SaasAccessReadinessHqController, SaasAccessRetryHqController, SaasOrganizationAccessHqController, SaasSchoolBillingController } = require('../dist/school-billing/saas-school-billing.controller.js');
const { SaasSchoolBillingService } = require('../dist/school-billing/saas-school-billing.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const U = () => randomUUID(), T = '2026-10-19T00:00:00.000Z', T2 = '2026-11-19T00:00:00.000Z';
const settlement = (patch = {}) => ({ receivedMinor: 14900, refundedMinor: 0, chargedBackMinor: 0, netMinor: 14900, verifiedNetMinor: 14900, balanceMinor: 0, state: 'PAID_VERIFIED', ...patch });
const invoice = (patch = {}) => ({ invoiceId: U(), invoiceNumber: 'HON-2026-000001', subscriptionId: U(), kind: 'SUBSCRIPTION_PERIOD', periodIndex: 0,
  servicePeriod: { startsAt: T, endsAt: T2 }, planCode: 'CORE', offerKind: 'REGULAR_MONTHLY', description: 'HON Core — monthly', currency: 'USD', status: 'ISSUED',
  subtotalMinor: 14900, taxStatus: 'NO_TAX_APPLICABLE', taxMinor: 0, totalMinor: 14900, settlement: settlement(), paymentVerification: 'PROVIDER_VERIFIED',
  collection: 'DISABLED', issuedAt: T, voidedAt: null, voidReason: null, ...patch });
const facts = (n = 1) => ({ firstPaidAt: n ? T : null, paidThroughAt: n ? T2 : null, lifetimePaid: false, paidInvoiceCount: n, refundedInvoiceCount: 0, chargebackInvoiceCount: 0 });
const account = (patch = {}) => ({ schoolId: U(), organizationId: U(), organizationName: 'Fixture Dojo', billingScope: 'ORGANIZATION', schoolCount: 2,
  entitlement: { tier: 'CORE', status: 'ACTIVE', effectiveFrom: T, effectiveUntil: null, version: 1, inEffect: true },
  access: { source: 'PROVISIONED', paymentActivated: false, state: 'PROVISIONED', paidAccessProgram: 'INACTIVE', activation: 'READY', alignment: 'NO_SUBSCRIPTION' },
  subscription: null, subscriptionHistory: [], subscriptions: [],
  payment: { status: 'NOT_BILLED', verification: 'NONE', paidThroughAt: null, unpaidSince: null, verified: facts(0), recorded: facts(0),
    evidenceCounts: { hqAttested: 0, providerVerified: 0 }, providerVerification: 'NOT_CONFIGURED' },
  allowance: { state: 'NO_SUBSCRIPTION', programStatus: 'INACTIVE', plannedMonthlyCredits: null, period: null, basis: null, grantedCredits: null, consumedCredits: null,
    reservedCredits: null, remainingCredits: null, usedPercent: null, suspensionPolicy: 'UNDECIDED', topUps: 'UNAVAILABLE' },
  refunds: [], cardDataStored: false, asOf: T, ...patch });

test('contracts: invoice query is closed; the cursor round-trips', () => {
  const id = U();
  assert.deepEqual(contracts.validateSaasSchoolInvoiceQuery({}), { status: null, kind: null, cursor: null, limit: 25 });
  const cursor = contracts.encodeSaasSchoolInvoiceCursor({ issuedAt: T, invoiceId: id });
  assert.deepEqual(contracts.validateSaasSchoolInvoiceQuery({ cursor, limit: '100', status: 'VOID', kind: 'LIFETIME_PURCHASE' }),
    { status: 'VOID', kind: 'LIFETIME_PURCHASE', cursor: { issuedAt: T, invoiceId: id }, limit: 100 });
  for (const bad of [{ limit: '0' }, { limit: '101' }, { limit: '05' }, { status: 'DRAFT' }, { kind: 'X' }, { cursor: 'x' }, { cursor: `${T}~${id}~1` },
    { cursor: `${T}` }, { status: ['ISSUED'] }, { organizationId: U() }])
    assert.throws(() => contracts.validateSaasSchoolInvoiceQuery(bad), JSON.stringify(bad));
});

test('contracts: invoice summaries and detail never carry HQ-only fields; verification matches settlement', () => {
  const page = { schoolId: U(), organizationId: U(), billingScope: 'ORGANIZATION', invoices: [invoice()], limit: 25, nextCursor: null };
  assert.equal(contracts.validateSaasSchoolInvoicePage(page).invoices.length, 1);
  for (const extra of ['organizationName','taxVerificationReference','version','delivery','note','reference'])
    assert.throws(() => contracts.validateSaasSchoolInvoicePage({ ...page, invoices: [{ ...invoice(), [extra]: 'x' }] }), extra);
  // An HQ-recorded payment is never presented as provider-verified.
  assert.throws(() => contracts.validateSaasSchoolInvoicePage({ ...page, invoices: [invoice({ settlement: settlement({ verifiedNetMinor: 0, state: 'PAID_ATTESTED' }) })] }));
  assert.equal(contracts.validateSaasSchoolInvoicePage({ ...page, invoices: [invoice({ settlement: settlement({ verifiedNetMinor: 0, state: 'PAID_ATTESTED' }), paymentVerification: 'HQ_RECORDED' })] }).invoices[0].paymentVerification, 'HQ_RECORDED');
  assert.throws(() => contracts.validateSaasSchoolInvoicePage({ ...page, invoices: [invoice({ status: 'DRAFT' })] }), 'drafts are never shown');
  // Order and cursor consistency.
  const a = invoice({ issuedAt: T2 }), b = invoice({ issuedAt: T });
  assert.equal(contracts.validateSaasSchoolInvoicePage({ ...page, invoices: [a, b], limit: 2, nextCursor: { issuedAt: T, invoiceId: b.invoiceId } }).invoices.length, 2);
  assert.throws(() => contracts.validateSaasSchoolInvoicePage({ ...page, invoices: [b, a], limit: 2, nextCursor: null }));
  assert.throws(() => contracts.validateSaasSchoolInvoicePage({ ...page, invoices: [a, b], limit: 2, nextCursor: { issuedAt: T2, invoiceId: a.invoiceId } }));
  const detail = { schoolId: U(), organizationId: U(), ...invoice(), lines: [{ lineNumber: 1, lineKind: 'PLAN_FEE', description: 'HON Core', amountMinor: 14900 }],
    evidence: [{ evidenceId: U(), kind: 'PAYMENT_RECEIVED', source: 'PROVIDER_VERIFIED', providerVerified: true, providerMode: 'TEST', amountMinor: 14900, currency: 'USD',
      occurredAt: T, relatedEvidenceId: null, recordedAt: T }], refunds: [] };
  assert.equal(contracts.validateSaasSchoolInvoiceDetail(detail).lines.length, 1);
  assert.throws(() => contracts.validateSaasSchoolInvoiceDetail({ ...detail, evidence: [{ ...detail.evidence[0], note: 'HQ note' }] }));
  assert.throws(() => contracts.validateSaasSchoolInvoiceDetail({ ...detail, evidence: [{ ...detail.evidence[0], providerMode: 'LIVE' }] }));
  assert.throws(() => contracts.validateSaasSchoolInvoiceDetail({ ...detail, lines: [{ ...detail.lines[0], reference: 'internal' }] }));
});

test('contracts: account readiness is read from the entitlement, never from payment', () => {
  assert.equal(contracts.validateSaasSchoolBillingAccount(account()).access.activation, 'READY');
  // Payment-activated only with the B6A access state; never claimed by a provisioned or awaiting school.
  assert.throws(() => contracts.validateSaasSchoolBillingAccount(account({ access: { ...account().access, paymentActivated: true } })));
  assert.throws(() => contracts.validateSaasSchoolBillingAccount(account({ access: { ...account().access, source: 'PAYMENT_ACTIVATED' } })));
  assert.throws(() => contracts.validateSaasSchoolBillingAccount(account({ access: { ...account().access, state: 'AWAITING_FIRST_PAYMENT', paymentActivated: true } })));
  assert.equal(contracts.validateSaasSchoolBillingAccount(account({ access: { ...account().access, state: 'PAYMENT_ACTIVE', source: 'PAYMENT_ACTIVATED', paymentActivated: true,
    paidAccessProgram: 'ACTIVE' } })).access.paymentActivated, true);
  assert.throws(() => contracts.validateSaasSchoolBillingAccount(account({ access: { ...account().access, state: 'NONE' } })), 'NONE only without an entitlement');
  assert.throws(() => contracts.validateSaasSchoolBillingAccount(account({ access: { ...account().access, paidAccessProgram: 'LIVE' } })));
  const suspended = { ...account().entitlement, status: 'SUSPENDED', inEffect: false };
  // A suspended entitlement can never read READY, whatever the payment says.
  assert.throws(() => contracts.validateSaasSchoolBillingAccount(account({ entitlement: suspended, allowance: { ...account().allowance, state: 'ACCESS_NOT_ACTIVE' } })));
  assert.equal(contracts.validateSaasSchoolBillingAccount(account({ entitlement: suspended, access: { ...account().access, activation: 'UNAVAILABLE' },
    allowance: { ...account().allowance, state: 'ACCESS_NOT_ACTIVE' } })).access.activation, 'UNAVAILABLE');
  assert.throws(() => contracts.validateSaasSchoolBillingAccount(account({ cardDataStored: true })));
  assert.throws(() => contracts.validateSaasSchoolBillingAccount({ ...account(), invoices: [] }));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [SaasSchoolBillingController, SaasAccessReadinessHqController, SaasOrganizationAccessHqController, SaasAccessRetryHqController],
    providers: [SaasSchoolBillingService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}

test('HTTP: school billing reads are fixed GETs bound to the verified subject; refusals are opaque', async () => {
  const calls = [], school = U(), inv = U(), cursorId = U();
  const { app, base } = await appWith(async (operation, params) => {
    calls.push([operation, params]);
    if (operation === 'readSchoolBillingAccount') return account({ schoolId: params[1] });
    if (operation === 'readSchoolInvoices') return { schoolId: params[1], organizationId: U(), billingScope: 'ORGANIZATION', invoices: [], limit: Number(params[6]), nextCursor: null };
    if (params[2] === inv) { const e = new Error('SAAS_UNAVAILABLE'); e.code = 'P0002'; throw e; }
    const e = new Error('SAAS_FORBIDDEN'); e.code = '42501'; throw e;
  });
  try {
    const acc = await send(`${base}/schools/${school}/hon-billing`);
    assert.equal(acc.status, 200, acc.body); assert.match(acc.headers['cache-control'], /no-store/);
    assert.deepEqual(calls.at(-1), ['readSchoolBillingAccount', ['verified-human', school]]);
    const cursor = encodeURIComponent(contracts.encodeSaasSchoolInvoiceCursor({ issuedAt: T, invoiceId: cursorId }));
    assert.equal((await send(`${base}/schools/${school}/hon-billing/invoices?limit=10&status=ISSUED&cursor=${cursor}`)).status, 200);
    assert.deepEqual(calls.at(-1), ['readSchoolInvoices', ['verified-human', school, 'ISSUED', null, T, cursorId, '10']]);
    const n = calls.length;
    for (const q of ['?limit=500', '?status=DRAFT', '?organizationId=x', '?cursor=bad', '?subject=other'])
      assert.equal((await send(`${base}/schools/${school}/hon-billing/invoices${q}`)).status, 400, q);
    assert.equal((await send(`${base}/schools/${school}/hon-billing?x=1`)).status, 400);
    assert.equal((await send(`${base}/schools/not-a-uuid/hon-billing`)).status, 400);
    assert.equal((await send(`${base}/schools/${school}/hon-billing`, { method: 'GET', headers: { 'content-type': 'application/json', 'content-length': '7' }, body: '{"a":1}' })).status, 400);
    assert.equal(calls.length, n, 'invalid requests never reach the database');
    // Another organization's invoice and a missing one are indistinguishable (404); refusal is 403.
    assert.equal((await send(`${base}/schools/${school}/hon-billing/invoices/${inv}`)).status, 404);
    assert.equal((await send(`${base}/schools/${school}/hon-billing/invoices/${U()}`)).status, 403);
    assert.equal((await send(`${base}/hq/saas/access/${U()}`)).status, 403);
    // Reads only: no command route exists here.
    for (const [method, path] of [['POST', `schools/${school}/hon-billing`], ['POST', `schools/${school}/hon-billing/invoices`], ['PATCH', `hq/saas/access/${U()}`],
      ['POST', `hq/saas/access/${U()}/activate`]])
      assert.equal((await send(`${base}/${path}`, { method, headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404, path);
  } finally { await app.close(); }
});

const orgAccess = (patch = {}) => ({ organizationId: U(), state: 'PROVISIONED', source: 'PROVISIONED',
  entitlement: { tier: 'CORE', status: 'ACTIVE', effectiveFrom: T, effectiveUntil: null, version: 1, inEffect: true },
  capabilities: [...contracts.SAAS_CORE_CAPABILITIES], paidAccessProgram: 'INACTIVE', ...patch });
const awaiting = () => orgAccess({ state: 'AWAITING_FIRST_PAYMENT', source: 'NONE', capabilities: [],
  entitlement: { tier: 'CORE', status: 'SUSPENDED', effectiveFrom: T, effectiveUntil: null, version: 2, inEffect: false } });
const activated = (tier = 'COMPLETE') => orgAccess({ state: 'PAYMENT_ACTIVE', source: 'PAYMENT_ACTIVATED', paidAccessProgram: 'ACTIVE',
  entitlement: { tier, status: 'ACTIVE', effectiveFrom: T, effectiveUntil: null, version: 3, inEffect: true }, capabilities: [...contracts.SAAS_PLAN_CAPABILITIES[tier]] });

test('contracts: B6A access is derived from the entitlement; capabilities follow the tier exactly', () => {
  assert.equal(contracts.validateSaasOrganizationAccess(orgAccess()).source, 'PROVISIONED');
  assert.equal(contracts.validateSaasOrganizationAccess(awaiting()).capabilities.length, 0);
  assert.equal(contracts.validateSaasOrganizationAccess(activated()).capabilities.length, contracts.SAAS_CORE_CAPABILITIES.length + contracts.SAAS_COMPLETE_ONLY_CAPABILITIES.length);
  // Core and Complete differ functionally, not only in allowance.
  assert.throws(() => contracts.validateSaasOrganizationAccess({ ...orgAccess(), capabilities: [...contracts.SAAS_PLAN_CAPABILITIES.COMPLETE] }));
  assert.throws(() => contracts.validateSaasOrganizationAccess({ ...awaiting(), capabilities: [...contracts.SAAS_CORE_CAPABILITIES] }), 'no access before payment');
  assert.throws(() => contracts.validateSaasOrganizationAccess({ ...awaiting(), source: 'PROVISIONED' }));
  assert.throws(() => contracts.validateSaasOrganizationAccess({ ...awaiting(), entitlement: orgAccess().entitlement }), 'awaiting never has access in effect');
  assert.throws(() => contracts.validateSaasOrganizationAccess({ ...orgAccess(), source: 'PAYMENT_ACTIVATED' }));
  assert.throws(() => contracts.validateSaasOrganizationAccess({ ...activated(), schoolId: U() }));
  const t = { transitionId: U(), kind: 'FIRST_PAYMENT_ACTIVATION', outcome: 'APPLIED', reason: 'FIRST_PAYMENT_VERIFIED', checkoutId: U(), subscriptionId: U(),
    allowanceId: U(), providerEventId: 'evt_fixture1', priorEntitlement: awaiting().entitlement, nextEntitlement: activated().entitlement, occurredAt: T };
  assert.equal(contracts.validateSaasOrganizationAccessView({ ...activated(), transitions: [t], asOf: T }).transitions.length, 1);
  assert.throws(() => contracts.validateSaasOrganizationAccessView({ ...activated(), transitions: [{ ...t, nextEntitlement: null }], asOf: T }), 'applied carries the next entitlement');
  assert.throws(() => contracts.validateSaasOrganizationAccessView({ ...activated(), transitions: [{ ...t, checkoutId: null }], asOf: T }), 'activation names its checkout');
  // A retry reports activation only when the access state really is payment-active.
  const receipt = { outcome: 'APPLIED', detail: 'ACCESS_ACTIVATED', checkoutId: U(), access: activated(), replayed: false };
  assert.equal(contracts.validateSaasAccessRetryReceipt(receipt).outcome, 'APPLIED');
  assert.throws(() => contracts.validateSaasAccessRetryReceipt({ ...receipt, access: awaiting() }));
  assert.equal(contracts.validateSaasAccessRetryReceipt({ ...receipt, outcome: 'NEEDS_REVIEW', detail: 'SAAS_ACCESS_PAYMENT_UNVERIFIED', access: awaiting() }).outcome, 'NEEDS_REVIEW');
  for (const bad of [{}, { expectedEntitlementVersion: 0 }, { expectedEntitlementVersion: 1.5 }, { expectedEntitlementVersion: 1, tier: 'COMPLETE' }, { expectedEntitlementVersion: 1, priceMinor: 100 }])
    assert.throws(() => contracts.validateSaasAccessAwaitInput(bad), JSON.stringify(bad));
  assert.throws(() => contracts.validateSaasAccessRetryInput({ expectedCheckoutVersion: 1, schoolId: U() }));
  // Awaiting schools see both plans; otherwise only the entitled tier.
  const offer = plan => ({ offerId: U(), planCode: plan, offerKind: 'REGULAR_MONTHLY', billingInterval: 'MONTHLY', priceMinor: 14900, currency: 'USD', monthlyPremiumCredits: 5000, founderSlotsRemaining: null });
  const opts = { schoolId: U(), entitlementTier: null, payments: { status: 'TEST_MODE', mode: 'TEST' }, offers: [offer('CORE'), offer('COMPLETE')], subscription: null,
    paymentVerification: 'NONE', checkout: null, annualBilling: 'UNAVAILABLE', planChanges: 'UNAVAILABLE', cardDataStored: false };
  assert.equal(contracts.validateSaasSchoolPlanOptions(opts).offers.length, 2);
  assert.throws(() => contracts.validateSaasSchoolPlanOptions({ ...opts, offers: [offer('ESSENTIAL')] }));
  assert.throws(() => contracts.validateSaasSchoolPlanOptions({ ...opts, entitlementTier: 'CORE' }));
});

test('HTTP: B6A HQ access commands are exact human commands; the browser supplies no tier, price or school', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [], org = U(), checkout = U();
  const human = command => ({ 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': command, 'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() });
  const { app, base } = await appWith(async (operation, params) => {
    calls.push([operation, params]);
    if (operation === 'readOrganizationAccess') return { ...orgAccess({ organizationId: params[1] }), transitions: [], asOf: T };
    if (operation === 'awaitFirstPayment') { const e = new Error('SAAS_ACCESS_NOT_ACTIVE'); e.code = '23514'; throw e; }
    if (operation === 'retryFirstPaymentActivation') return { outcome: 'APPLIED', detail: 'ACCESS_ACTIVATED', checkoutId: params[1], access: activated(), replayed: false };
    throw new Error('unexpected');
  });
  try {
    const read = await send(`${base}/hq/saas/organizations/${org}/access`);
    assert.equal(read.status, 200, read.body); assert.deepEqual(calls.at(-1), ['readOrganizationAccess', ['verified-human', org]]);
    const body = JSON.stringify({ expectedEntitlementVersion: 1 });
    const placed = await send(`${base}/hq/saas/organizations/${org}/access/await-first-payment`, { method: 'POST', headers: human(contracts.SAAS_COMMANDS.awaitFirstPayment), body });
    assert.deepEqual([placed.status, JSON.parse(placed.body).code], [422, 'SAAS_ACCESS_NOT_ACTIVE']);
    assert.deepEqual(calls.at(-1).slice(0, 1), ['awaitFirstPayment']);
    assert.deepEqual(calls.at(-1)[1].slice(0, 3), ['verified-human', org, body]);
    const retried = await send(`${base}/hq/saas/payments/checkouts/${checkout}/access-retry`, { method: 'POST', headers: human(contracts.SAAS_COMMANDS.retryFirstPaymentActivation),
      body: JSON.stringify({ expectedCheckoutVersion: 2 }) });
    assert.equal(retried.status, 200, retried.body); assert.equal(calls.at(-1)[1][1], checkout);
    const n = calls.length;
    for (const [path, command, payload] of [
      [`hq/saas/organizations/${org}/access/await-first-payment`, contracts.SAAS_COMMANDS.retryFirstPaymentActivation, body], // wrong command header
      [`hq/saas/organizations/${org}/access/await-first-payment`, contracts.SAAS_COMMANDS.awaitFirstPayment, JSON.stringify({ expectedEntitlementVersion: 1, tier: 'COMPLETE' })],
      [`hq/saas/payments/checkouts/${checkout}/access-retry`, contracts.SAAS_COMMANDS.retryFirstPaymentActivation, JSON.stringify({ expectedCheckoutVersion: 2, priceMinor: 1 })],
      [`hq/saas/payments/checkouts/not-a-uuid/access-retry`, contracts.SAAS_COMMANDS.retryFirstPaymentActivation, JSON.stringify({ expectedCheckoutVersion: 2 })]])
      assert.ok([400, 403].includes((await send(`${base}/${path}`, { method: 'POST', headers: human(command), body: payload })).status), path);
    assert.equal((await send(`${base}/hq/saas/organizations/${org}/access/await-first-payment`, { method: 'POST', headers: { ...human(contracts.SAAS_COMMANDS.awaitFirstPayment), origin: 'https://evil.example' }, body })).status, 403);
    assert.equal(calls.length, n, 'refused requests never reach the database');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
