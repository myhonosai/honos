const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { SaasBillingHqController } = require('../dist/saas-billing/saas-billing.controller.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const T = '2026-10-18T12:00:00.000Z', U = () => randomUUID();
const settlement = (patch = {}) => ({ receivedMinor:0, refundedMinor:0, chargedBackMinor:0, netMinor:0, verifiedNetMinor:0, balanceMinor:14900, state:'UNPAID', ...patch });
const invoice = (patch = {}) => ({ invoiceId:U(), invoiceNumber:'HON-2026-000001', organizationId:U(), organizationName:'Fixture Dojo', subscriptionId:U(),
  kind:'SUBSCRIPTION_PERIOD', periodIndex:0, servicePeriod:{ startsAt:T, endsAt:'2026-11-18T12:00:00.000Z' }, planCode:'CORE', offerKind:'REGULAR_MONTHLY',
  description:'HON Core — monthly — service period 2026-10-18 to 2026-11-18', currency:'USD', status:'ISSUED', version:3, subtotalMinor:14900,
  taxStatus:'NO_TAX_APPLICABLE', taxMinor:0, taxVerificationReference:'TR-1', totalMinor:14900, settlement:settlement(), delivery:'NOT_SENT', collection:'DISABLED',
  createdAt:T, issuedAt:T, voidedAt:null, voidReason:null, updatedAt:T, ...patch });
const detail = (patch = {}) => invoice({ lines:[{ lineNumber:1, lineKind:'PLAN_FEE', description:'HON Core — monthly', amountMinor:14900, reference:null }], evidence:[], ...patch });
const evidence = (patch = {}) => ({ evidenceId:U(), invoiceId:U(), kind:'PAYMENT_RECEIVED', source:'HQ_ATTESTATION', providerVerified:false, amountMinor:14900, currency:'USD',
  occurredAt:T, reference:'RCPT-1', relatedEvidenceId:null, note:null, recordedAt:T, ...patch });
const facts = (patch = {}) => ({ firstPaidAt:null, paidThroughAt:null, lifetimePaid:false, paidInvoiceCount:0, refundedInvoiceCount:0, chargebackInvoiceCount:0, ...patch });
const standing = (patch = {}) => ({ organizationId:U(), subscriptionId:U(), verified:facts(), recorded:facts({ firstPaidAt:T, paidThroughAt:T, paidInvoiceCount:1 }),
  evidence:{ hqAttested:1, providerVerified:0 }, championsPaymentSource:'NOT_CONNECTED', providerVerification:'NOT_CONFIGURED', ...patch });

test('invoice inputs: tax has no default, evidence has no source field, adjustments are bounded', () => {
  assert.deepEqual(contracts.validateSaasInvoiceDraftInput({ subscriptionId:'A'.repeat(8) + '-0000-4000-8000-000000000000', periodIndex:0 }).periodIndex, 0);
  const ok = { action:'SET_TAX', expectedVersion:2, treatment:'TAX_LINES', taxLines:[{ jurisdiction:'Fixture State', amountMinor:1234 }], verificationReference:'TR-2' };
  assert.deepEqual(contracts.validateSaasInvoiceCommand(ok), ok);
  for (const bad of [{ ...ok, treatment:'UNRESOLVED' }, { ...ok, taxLines:[] }, { ...ok, treatment:'NO_TAX_APPLICABLE' }, { ...ok, verificationReference:'' },
    { action:'ADD_ADJUSTMENT', expectedVersion:1, adjustment:{ kind:'DISCOUNT', amountMinor:500, description:'Positive discount', reference:null } },
    { action:'ADD_ADJUSTMENT', expectedVersion:1, adjustment:{ kind:'CHAMPIONS_CREDIT', amountMinor:-10000, description:'Not in B2', reference:null } },
    { action:'SEND', expectedVersion:1 }, { action:'COLLECT', expectedVersion:1 }, { action:'ISSUE', expectedVersion:1, sendEmail:true }])
    assert.throws(() => contracts.validateSaasInvoiceCommand(bad));
  const pay = { kind:'PAYMENT_RECEIVED', amountMinor:100, occurredAt:T, reference:'RCPT-1', relatedEvidenceId:null, note:null };
  assert.deepEqual(contracts.validateSaasPaymentEvidenceInput(pay), pay);
  for (const bad of [{ ...pay, source:'PROVIDER_VERIFIED' }, { ...pay, providerVerified:true }, { ...pay, kind:'REFUND' }, { ...pay, relatedEvidenceId:U() },
    { ...pay, amountMinor:0 }, { ...pay, occurredAt:'yesterday' }, { ...pay, currency:'EUR' }])
    assert.throws(() => contracts.validateSaasPaymentEvidenceInput(bad));
});

test('response contracts fail closed on delivery, collection, provider verification or inconsistent totals', () => {
  assert.doesNotThrow(() => contracts.validateSaasInvoiceDetail(detail()));
  assert.doesNotThrow(() => contracts.validateSaasPaymentStanding(standing()));
  assert.doesNotThrow(() => contracts.validateSaasInvoiceDetail(detail({ status:'DRAFT', invoiceNumber:null, issuedAt:null, taxStatus:'UNRESOLVED', taxMinor:null,
    taxVerificationReference:null, totalMinor:null, settlement:settlement({ state:'NOT_ISSUED', balanceMinor:null }) })));
  for (const bad of [detail({ delivery:'SENT' }), detail({ collection:'ENABLED' }), detail({ settlement:settlement({ state:'PAID_VERIFIED' }) }),
    detail({ settlement:settlement({ verifiedNetMinor:14900 }) }), detail({ totalMinor:15000 }), detail({ taxStatus:'UNRESOLVED' }),
    detail({ status:'DRAFT' }), detail({ subtotalMinor:15000, totalMinor:15000 }), detail({ evidence:[evidence({ source:'PROVIDER_VERIFIED' })] }),
    detail({ evidence:[evidence({ providerVerified:true })] }), detail({ invoiceNumber:'INV-1' }), { ...detail(), paymentUrl:'https://pay.example' }])
    assert.throws(() => contracts.validateSaasInvoiceDetail(bad));
  for (const bad of [standing({ verified:facts({ firstPaidAt:T, paidInvoiceCount:1 }) }), standing({ verified:facts({ lifetimePaid:true }) }),
    standing({ verified:facts({ firstPaidAt:T, paidInvoiceCount:1 }) }), standing({ verified:facts({ firstPaidAt:T, paidInvoiceCount:2 }), evidence:{ hqAttested:1, providerVerified:2 } }), standing({ championsPaymentSource:'HON_BILLING' }), standing({ providerVerification:'STRIPE' }),
    standing({ recorded:facts({ paidInvoiceCount:1 }) })])
    assert.throws(() => contracts.validateSaasPaymentStanding(bad));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const human = command => ({ 'content-type':'application/json', origin:'https://hon.example', 'x-hon-human-command':command, 'sec-fetch-site':'same-origin',
  'sec-fetch-mode':'same-origin', 'sec-fetch-dest':'empty', 'idempotency-key':randomUUID() });

test('HTTP routes: invoice and evidence commands need their exact header; no send, collect or provider routes', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [];
  const module = await Test.createTestingModule({ controllers:[SaasBillingHqController], providers:[SaasBillingService, SaasCommandGuard, SaasReadGuard,
    { provide:RuntimeDatabaseService, useValue:{ callSaasBilling:async (operation, params) => { calls.push([operation, params]);
      return operation === 'readPaymentStanding' ? standing() : operation === 'recordPaymentEvidence' ? { evidence:evidence(), invoice:invoice(), replayed:false }
        : operation === 'readInvoices' ? { invoices:[invoice()], limit:200, collection:'DISABLED' } : detail(); } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject:'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/saas`;
  try {
    const org = randomUUID(), inv = randomUUID();
    const read = await send(`${base}/organizations/${org}/payment-standing`); assert.equal(read.status, 200, read.body); assert.match(read.headers['cache-control'], /no-store/);
    assert.deepEqual(calls.at(-1), ['readPaymentStanding', ['verified-human', org]]);
    assert.equal((await send(`${base}/invoices?status=ISSUED`)).status, 200); assert.deepEqual(calls.at(-1), ['readInvoices', ['verified-human', 'ISSUED']]);
    assert.equal((await send(`${base}/invoices?status=PAID`)).status, 400);
    const body = JSON.stringify({ kind:'PAYMENT_RECEIVED', amountMinor:14900, occurredAt:T, reference:'RCPT-1', relatedEvidenceId:null, note:null });
    const recorded = await send(`${base}/invoices/${inv}/payment-evidence`, { method:'POST', headers:human('saas-payment-evidence'), body });
    assert.equal(recorded.status, 200, recorded.body);
    assert.equal(calls.at(-1)[0], 'recordPaymentEvidence'); assert.equal(calls.at(-1)[1][1], inv); assert.equal(JSON.parse(calls.at(-1)[1][2]).source, undefined);
    const n = calls.length;
    assert.equal((await send(`${base}/invoices/${inv}/payment-evidence`, { method:'POST', headers:human('saas-invoice-command'), body })).status, 403);
    assert.equal((await send(`${base}/invoices/${inv}/payment-evidence`, { method:'POST', headers:human('saas-payment-evidence'),
      body:JSON.stringify({ ...JSON.parse(body), source:'PROVIDER_VERIFIED' }) })).status, 400);
    for (const path of [`invoices/${inv}/send`, `invoices/${inv}/collect`, `invoices/${inv}/checkout`, `invoices/${inv}/refunds`, 'provider/webhooks', 'payments'])
      assert.equal((await send(`${base}/${path}`, { method:'POST', headers:human('saas-invoice-command'), body:'{}' })).status, 404, path);
    assert.equal(calls.length, n);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('B2 refusals map to stable 422 codes', async () => {
  for (const code of ['SAAS_INVOICE_TAX_UNRESOLVED','SAAS_PAYMENT_EXCEEDS_BALANCE','SAAS_EVIDENCE_DUPLICATE_REFERENCE','SAAS_INVOICE_HAS_EVIDENCE','SAAS_REVERSAL_EXCEEDS_PAYMENT']) {
    const service = new SaasBillingService({ callSaasBilling:async () => { throw Object.assign(new Error(code), { code:'23514' }); } });
    await assert.rejects(service.readInvoices('verified-human', undefined), e => e.getStatus() === 422 && e.getResponse().code === code);
  }
});
