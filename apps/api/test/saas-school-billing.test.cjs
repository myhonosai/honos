const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { SaasAccessReadinessHqController, SaasSchoolBillingController } = require('../dist/school-billing/saas-school-billing.controller.js');
const { SaasSchoolBillingService } = require('../dist/school-billing/saas-school-billing.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
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
  access: { source: 'PROVISIONED', paymentActivated: false, paidAccessProgram: 'INACTIVE', activation: 'READY', alignment: 'NO_SUBSCRIPTION' },
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
  assert.throws(() => contracts.validateSaasSchoolBillingAccount(account({ access: { ...account().access, paymentActivated: true } })));
  assert.throws(() => contracts.validateSaasSchoolBillingAccount(account({ access: { ...account().access, paidAccessProgram: 'ACTIVE' } })));
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
  const module = await Test.createTestingModule({ controllers: [SaasSchoolBillingController, SaasAccessReadinessHqController],
    providers: [SaasSchoolBillingService, SaasBillingService, SaasReadGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
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
