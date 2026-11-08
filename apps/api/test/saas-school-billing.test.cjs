const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { SaasExceptionPolicyHqController, SaasAccessExceptionCommandsHqController, SaasAccessExceptionsHqController, SaasAccessReadinessHqController, SaasAccessRetryHqController,
  SaasOrganizationAccessHqController, SaasSchoolBillingController } = require('../dist/school-billing/saas-school-billing.controller.js');
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
  const module = await Test.createTestingModule({ controllers: [SaasExceptionPolicyHqController, SaasSchoolBillingController, SaasAccessReadinessHqController, SaasOrganizationAccessHqController, SaasAccessRetryHqController,
    SaasAccessExceptionsHqController, SaasAccessExceptionCommandsHqController],
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

// ---------- D9: HQ-owner access exceptions ----------
const X_START = '2026-10-24T00:00:00.000Z', X_END = '2026-11-23T00:00:00.000Z';
const grantedEnt = (patch = {}) => ({ tier: 'COMPLETE', status: 'ACTIVE', effectiveFrom: X_START, effectiveUntil: X_END, version: 2, inEffect: true, ...patch });
const accessException = (patch = {}) => ({ exceptionId: U(), organizationId: U(), schoolId: U(), purpose: 'APPROVED_PILOT', reason: 'Approved pilot for a fixture partner',
  scopeTier: 'COMPLETE', capabilities: [...contracts.SAAS_PLAN_CAPABILITIES.COMPLETE], aiCredits: 'NONE', startsAt: X_START, expiresAt: X_END, policyVersion: 1, maxDays: 90,
  status: 'GRANTED', lifecycle: 'IN_EFFECT', grantedByPrincipalId: U(), grantedAt: X_START,
  priorEntitlement: { tier: 'COMPLETE', status: 'SUSPENDED', effectiveFrom: T, effectiveUntil: null, version: 1, inEffect: false }, grantedEntitlement: grantedEnt(),
  endReason: null, endNote: null, endEntitlement: null, endedByPrincipalId: null, endedAt: null, ...patch });
const grantInput = (patch = {}) => ({ schoolId: U(), purpose: 'PRODUCT_DEMONSTRATION', reason: 'Demonstration for an approved prospect', scopeTier: 'COMPLETE',
  startsAt: X_START, expiresAt: X_END, expectedEntitlementVersion: 1, ...patch });

test('contracts: D9 exception inputs are closed; views never carry credits and stay inside the scope and window', () => {
  assert.equal(contracts.validateSaasAccessExceptionGrantInput(grantInput()).scopeTier, 'COMPLETE');
  for (const bad of [{ purpose: 'FREE' }, { reason: 'short' }, { reason: ' padded fixture reason ' }, { scopeTier: 'ESSENTIAL' }, { startsAt: '2026-10-24' },
    { expiresAt: X_START }, { expectedEntitlementVersion: 0 }, { schoolId: 'x' }, { approvedByPrincipalId: U() }, { grantedByPrincipalId: U() }, { aiCredits: 5000 },
    { organizationId: U() }, { tier: 'COMPLETE' }])
    assert.throws(() => contracts.validateSaasAccessExceptionGrantInput(grantInput(bad)), JSON.stringify(bad));
  assert.throws(() => contracts.validateSaasAccessExceptionRevokeInput({ reason: 'Fixture revocation reason', exceptionId: U() }));
  assert.throws(() => contracts.validateSaasAccessExceptionCloseInput({ organizationId: U() }));
  const x = accessException();
  assert.equal(contracts.validateSaasAccessExceptionGrantReceipt({ exception: x, access: { organizationId: x.organizationId, state: 'PROVISIONED', source: 'PROVISIONED',
    entitlement: grantedEnt(), capabilities: [...contracts.SAAS_PLAN_CAPABILITIES.COMPLETE], paidAccessProgram: 'INACTIVE' }, replayed: false }).exception.lifecycle, 'IN_EFFECT');
  for (const bad of [{ aiCredits: 12000 }, { capabilities: [...contracts.SAAS_PLAN_CAPABILITIES.CORE] }, { maxDays: 91 }, { expiresAt: '2027-02-01T00:00:00.000Z' },
    { grantedEntitlement: grantedEnt({ tier: 'CORE' }) }, { grantedEntitlement: grantedEnt({ effectiveUntil: null }) }, { lifecycle: 'REVOKED' }, { endReason: 'REVOKED' },
    { status: 'ENDED' }, { purpose: 'FREE_FOREVER' }])
    assert.throws(() => contracts.validateSaasAccessExceptionsView({ organizationId: x.organizationId, access: orgAccess({ organizationId: x.organizationId }),
      exceptions: [{ ...x, ...bad }], asOf: T }), JSON.stringify(bad));
  const ended = accessException({ status: 'ENDED', lifecycle: 'REVOKED', endReason: 'REVOKED', endNote: 'Demonstration finished early', endedByPrincipalId: U(), endedAt: T2,
    endEntitlement: grantedEnt({ status: 'SUSPENDED', version: 3, inEffect: false }) });
  const susp = orgAccess({ organizationId: ended.organizationId, source: 'NONE', capabilities: [], entitlement: grantedEnt({ status: 'SUSPENDED', version: 3, inEffect: false }) });
  assert.equal(contracts.validateSaasAccessExceptionRevokeReceipt({ exception: ended, entitlementSuspended: true, access: susp, replayed: false }).entitlementSuspended, true);
  assert.throws(() => contracts.validateSaasAccessExceptionRevokeReceipt({ exception: ended, entitlementSuspended: true,
    access: orgAccess({ organizationId: ended.organizationId }), replayed: false }), 'a suspended revocation leaves no access in effect');
  assert.throws(() => contracts.validateSaasAccessExceptionRevokeReceipt({ exception: { ...ended, endNote: null }, entitlementSuspended: true, access: susp, replayed: false }));
  assert.throws(() => contracts.validateSaasAccessExceptionsView({ organizationId: x.organizationId, access: orgAccess({ organizationId: x.organizationId }),
    exceptions: [x, { ...accessException(), organizationId: x.organizationId }], asOf: T }), 'one open exception per organization');
  assert.throws(() => contracts.validateSaasAccessExceptionCloseReceipt({ closed: [ended], asOf: T, replayed: false }), 'closing never reports a revocation');
});

test('HTTP: D9 exception commands are exact HQ human commands; the browser never names the grantor, credits or price', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [], org = U(), exceptionId = U();
  const human = command => ({ 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': command, 'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() });
  const { app, base } = await appWith(async (operation, params) => {
    calls.push([operation, params]);
    if (operation === 'readAccessExceptions') return { organizationId: params[1], access: orgAccess({ organizationId: params[1] }), exceptions: [], asOf: T };
    if (operation === 'grantAccessException') { const e = new Error('SAAS_FORBIDDEN'); e.code = '42501'; throw e; }
    if (operation === 'revokeAccessException') { const e = new Error('SAAS_EXCEPTION_ENDED'); e.code = '23514'; throw e; }
    if (operation === 'closeExpiredAccessExceptions') return { closed: [], asOf: T, replayed: false };
    throw new Error('unexpected');
  });
  try {
    const read = await send(`${base}/hq/saas/organizations/${org}/access-exceptions`);
    assert.equal(read.status, 200, read.body); assert.deepEqual(calls.at(-1), ['readAccessExceptions', ['verified-human', org]]);
    const body = JSON.stringify(grantInput());
    const granted = await send(`${base}/hq/saas/organizations/${org}/access-exceptions`, { method: 'POST', headers: human(contracts.SAAS_COMMANDS.grantAccessException), body });
    assert.deepEqual([granted.status, JSON.parse(granted.body).code], [403, 'SAAS_FORBIDDEN'], 'the database decides who is an HQ owner');
    assert.deepEqual(calls.at(-1)[1].slice(0, 3), ['verified-human', org, body]);
    const revoked = await send(`${base}/hq/saas/access-exceptions/${exceptionId}/revoke`, { method: 'POST', headers: human(contracts.SAAS_COMMANDS.revokeAccessException),
      body: JSON.stringify({ reason: 'Fixture revocation reason' }) });
    assert.deepEqual([revoked.status, JSON.parse(revoked.body).code], [422, 'SAAS_EXCEPTION_ENDED']);
    const closed = await send(`${base}/hq/saas/access-exceptions/close-expired`, { method: 'POST', headers: human(contracts.SAAS_COMMANDS.closeExpiredAccessExceptions), body: '{}' });
    assert.equal(closed.status, 200, closed.body); assert.equal(calls.at(-1)[0], 'closeExpiredAccessExceptions');
    const n = calls.length;
    for (const [path, command, payload] of [
      [`hq/saas/organizations/${org}/access-exceptions`, contracts.SAAS_COMMANDS.awaitFirstPayment, body], // wrong command header
      [`hq/saas/organizations/${org}/access-exceptions`, contracts.SAAS_COMMANDS.grantAccessException, JSON.stringify(grantInput({ approvedByPrincipalId: U() }))],
      [`hq/saas/organizations/${org}/access-exceptions`, contracts.SAAS_COMMANDS.grantAccessException, JSON.stringify(grantInput({ priceMinor: 0 }))],
      [`hq/saas/organizations/not-a-uuid/access-exceptions`, contracts.SAAS_COMMANDS.grantAccessException, body],
      [`hq/saas/access-exceptions/${exceptionId}/revoke`, contracts.SAAS_COMMANDS.revokeAccessException, JSON.stringify({ reason: 'x' })],
      [`hq/saas/access-exceptions/close-expired`, contracts.SAAS_COMMANDS.closeExpiredAccessExceptions, JSON.stringify({ organizationId: org })]])
      assert.ok([400, 403].includes((await send(`${base}/${path}`, { method: 'POST', headers: human(command), body: payload })).status), path);
    assert.equal((await send(`${base}/hq/saas/organizations/${org}/access-exceptions`, { method: 'POST', headers: { ...human(contracts.SAAS_COMMANDS.grantAccessException), origin: 'https://evil.example' }, body })).status, 403);
    assert.equal(calls.length, n, 'refused requests never reach the database');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

// D10 exception-only governance; no full PAID_ACCESS approval or activation endpoint.
const validateException = x => contracts.validateSaasAccessExceptionGrantReceipt({exception:x,access:orgAccess({organizationId:x.organizationId,entitlement:x.grantedEntitlement,capabilities:[...contracts.SAAS_PLAN_CAPABILITIES.COMPLETE]}),replayed:false}).exception;
const policy = patch => ({ approvalId: U(), revision: 1, status: 'APPROVED', termsVersion: 1, maxDays: 30,
  validFrom: T, validUntil: T2, reason: 'Synthetic independently confirmed policy', actorPrincipalId: U(), recordedAt: T, ...patch });
const decisionInput = patch => ({ expectedRevision: 0, decision: 'APPROVED', termsVersion: 1, maxDays: 30,
  validFrom: T, validUntil: T2, reason: 'Synthetic independently confirmed policy', confirmation: contracts.SAAS_EXCEPTION_POLICY_CONFIRMATION, ...patch });
test('D10 contracts: closed explicit decisions, bounded dates/duration and no automatic approval', () => {
  assert.equal(contracts.validateSaasExceptionPolicyDecisionInput(decisionInput()).decision, 'APPROVED');
  for (const patch of [{ confirmation: undefined }, { confirmation: 'yes' }, { maxDays: 91 }, { maxDays: 0 }, { validUntil: T },
    { reason: 'short' }, { expectedRevision: -1 }, { termsVersion: 0 }, { decision: 'ACTIVE' }, { organizationId: U() }, { approvePaidAccess: true }])
    assert.throws(() => contracts.validateSaasExceptionPolicyDecisionInput(decisionInput(patch)));
  const { confirmation, ...proposed } = decisionInput({ decision: 'PROPOSED' });
  assert.equal(contracts.validateSaasExceptionPolicyDecisionInput(proposed).decision, 'PROPOSED');
  assert.throws(() => contracts.validateSaasExceptionPolicyDecisionInput({ ...proposed, confirmation }));
  for (const decision of ['WITHDRAWN','REVOKED']) {
    const minimal = { expectedRevision: 1, decision, reason: 'Explicit exception-only withdrawal' };
    assert.equal(contracts.validateSaasExceptionPolicyDecisionInput(minimal).decision, decision);
    assert.throws(() => contracts.validateSaasExceptionPolicyDecisionInput({ ...minimal, maxDays: 90 }));
  }
});
test('D10 response contracts: coherent history and historical pre-D10 receipt compatibility', () => {
  const p = policy(), view = { scope: 'ACCESS_EXCEPTIONS_ONLY', current: p, effectiveStatus: 'ACTIVE', history: [p], historyLimit: 100,
    asOf: T, termsStatus: 'PROPOSED', terms: { policyVersion: p.termsVersion, exceptionMaxDays: 90, exceptionAuthority: 'HQ_OWNER' },
    viewer: { canDecide: true }, paidAccessProgram: 'INACTIVE', aiCreditProgram: 'INACTIVE' };
  assert.equal(contracts.validateSaasExceptionPolicyView(view).current.approvalId,p.approvalId);
  const newer = { ...view.terms, policyVersion: p.termsVersion + 1 };
  assert.equal(contracts.validateSaasExceptionPolicyView({ ...view, terms: newer, effectiveStatus: 'SUPERSEDED' }).effectiveStatus, 'SUPERSEDED');
  for (const patch of [{ current: null }, { effectiveStatus: 'PROPOSED' }, { termsStatus: 'APPROVED' }, { history: [p,p] }, { scope: 'PAID_ACCESS' },
    { effectiveStatus: 'SUPERSEDED' }, { terms: newer }, { terms: { ...view.terms, policyVersion: p.termsVersion - 1 } }, { terms: undefined },
    { terms: { ...view.terms, exceptionMaxDays: 91 } }, { terms: { ...view.terms, exceptionAuthority: 'HQ_OPERATOR' } }, { viewer: { canDecide: 'yes' } },
    { viewer: { canDecide: true, role: 'OWNER' } }])
    assert.throws(() => contracts.validateSaasExceptionPolicyView({ ...view,...patch }));
  const x=accessException();
  assert.equal(validateException(x).governingPolicy,undefined,'old stored exact receipt is not rewritten');
  const binding={approvalId:p.approvalId,revision:1,termsVersion:x.policyVersion,maxDays:x.maxDays};
  assert.equal(validateException({...x,governingPolicy:binding}).governingPolicy.approvalId,p.approvalId);
  assert.throws(()=>validateException({...x,governingPolicy:{...binding,maxDays:1}}));
});
test('D10 HTTP: explicit human command, origin, closed body, fixed subject and safe refusals', async () => {
  const previous=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example';
  const calls=[],p=policy();
  const {app,base}=await appWith(async(operation,params)=>{
    calls.push([operation,params]);
    if(operation==='readExceptionPolicy')return {scope:'ACCESS_EXCEPTIONS_ONLY',current:null,effectiveStatus:'ABSENT',history:[],historyLimit:100,
      asOf:T,termsStatus:'PROPOSED',terms:{policyVersion:1,exceptionMaxDays:90,exceptionAuthority:'HQ_OWNER'},viewer:{canDecide:true},
      paidAccessProgram:'INACTIVE',aiCreditProgram:'INACTIVE'};
    if(operation==='decideExceptionPolicy'){
      const input=JSON.parse(params[1]);
      if(input.reason==='Denied synthetic policy attempt'){const e=new Error('SAAS_FORBIDDEN');e.code='42501';throw e;}
      return {policy:p,replayed:false};
    }
    throw new Error('unexpected');
  });
  const headers=()=>({'content-type':'application/json',origin:'https://hon.example','x-hon-human-command':contracts.SAAS_COMMANDS.decideExceptionPolicy,
    'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','idempotency-key':U()});
  try{
    const path=`${base}/hq/saas/access-exception-policy`;
    assert.equal((await send(path)).status,200);
    assert.deepEqual(calls[0],['readExceptionPolicy',['verified-human']]);
    const input=decisionInput(),key=U();
    assert.equal((await send(path,{method:'POST',headers:{...headers(),'idempotency-key':key},body:JSON.stringify(input)})).status,200);
    assert.deepEqual(calls.at(-1)[1].slice(0,3),['verified-human',JSON.stringify(input),key]);
    const n=calls.length;
    for(const [h,body] of [[{...headers(),origin:'https://evil.example'},input],[{...headers(),'x-hon-human-command':'saas-access-exception-grant'},input],
      [{...headers(),'idempotency-key':'invalid'},input],[headers(),{...input,organizationId:U()}],[headers(),{...input,confirmation:'yes'}]])
      assert([400,403].includes((await send(path,{method:'POST',headers:h,body:JSON.stringify(body)})).status));
    assert.equal((await send(path+'?schoolId='+U())).status,400);
    assert.equal(calls.length,n,'invalid/forged commands never call the database');
    assert.equal((await send(path,{method:'POST',headers:headers(),body:JSON.stringify(decisionInput({reason:'Denied synthetic policy attempt'}))})).status,403);
  }finally{await app.close();if(previous===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=previous;}
});
