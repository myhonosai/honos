const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { SaasCreativeWalletHqController, SaasCreativeWalletSchoolController } = require('../dist/saas-billing/saas-creative-wallet.controller.js');
const { SaasCreativeWalletService } = require('../dist/saas-billing/saas-creative-wallet.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const T = '2026-11-03T12:00:00.000Z', E = '2026-12-03T12:00:00.000Z', U = () => randomUUID();
const kinds = ['INCLUDED_MONTHLY','ADJUSTMENT','PROMOTIONAL','PURCHASED_TOPUP'];
const lot = (patch = {}) => ({ lotId:U(), kind:'INCLUDED_MONTHLY', credits:12000, baseCredits:null, bonusCredits:null, window:{ index:0, startsAt:T, endsAt:E },
  purchaseId:null, adjustmentId:null, expiresAt:E, expired:false, availableCredits:9000, heldCredits:1000, consumedCredits:2000, expiredCredits:0, debitedCredits:0,
  grantedAt:T, ...patch });
const balance = (available = 9000, held = 1000) => ({ availableCredits:available, heldCredits:held, byKind:kinds.map((kind, i) => ({ kind, grantedCredits:i ? 0 : 12000,
  availableCredits:i ? 0 : available, heldCredits:i ? 0 : held, consumedCredits:i ? 0 : 2000, expiredCredits:0, debitedCredits:0 })) });
const reservation = (patch = {}) => ({ reservationId:U(), schoolId:U(), operationCode:'video.generate', mediaKind:'VIDEO', rateBasis:'PROVISIONAL', creditsPerUnit:50,
  units:20, reservedCredits:1000, status:'RESERVED', statusReason:'RESERVED', version:1, finalUnits:null, finalCredits:null, lots:[{ lotId:U(), reservedCredits:1000 }],
  reservedAt:T, settledAt:null, ...patch });
const packages = () => [['STARTER',3000,0,3000],['GROWTH',6000,1200,6000],['CREATOR',12000,4800,12000]].map(([packageCode, baseCredits, bonusCredits, priceMinor]) =>
  ({ packageCode, packageVersion:1, baseCredits, bonusCredits, totalCredits:baseCredits + bonusCredits, priceMinor, currency:'usd' }));
const purchase = (patch = {}) => ({ purchaseId:U(), schoolId:U(), packageCode:'GROWTH', packageVersion:1, baseCredits:6000, bonusCredits:1200, priceMinor:6000, currency:'usd',
  status:'PENDING_PAYMENT', statusReason:'AWAITING_VERIFIED_PAYMENT', version:1, lotId:null, payment:'NOT_CONNECTED', createdAt:T, fulfilledAt:null, ...patch });
const schoolWallet = (patch = {}) => { const schoolId = patch.schoolId ?? U(); return { schoolId, walletVersion:3, program:{ status:'ACTIVE', monthlyIncludedCredits:12000 },
  eligibility:{ eligible:true, reason:null, window:{ index:0, startsAt:T, endsAt:E } }, balance:balance(), lots:[lot()], history:[], reservations:[reservation({ schoolId })],
  adjustments:[], purchases:[purchase({ schoolId })], rates:null, packages:packages(), agentConversationsDeductCredits:false, paymentsActive:false, ...patch }; };

test('CW1 inputs: closed shapes, approved packages only, no price or payment fields, settle/resolve shapes exact', () => {
  assert.equal(contracts.SAAS_CREATIVE_MONTHLY_INCLUDED_CREDITS, 12000);
  assert.deepEqual(contracts.SAAS_CREATIVE_TOPUP_PACKAGES.GROWTH, { priceMinor:6000, baseCredits:6000, bonusCredits:1200 });
  assert.deepEqual(contracts.validateSaasCreativePurchaseInput({ packageCode:'CREATOR' }), { packageCode:'CREATOR' });
  for (const bad of [{ packageCode:'CUSTOM' }, { packageCode:'GROWTH', priceMinor:1 }, { packageCode:'GROWTH', credits:999999 }, {}])
    assert.throws(() => contracts.validateSaasCreativePurchaseInput(bad));
  const grant = { kind:'PROMOTIONAL', credits:1_000_000_000, reasonCode:'PROMOTION', note:'Launch' };
  assert.doesNotThrow(() => contracts.validateSaasCreativeGrantInput(grant));
  for (const bad of [{ ...grant, credits:0 }, { ...grant, kind:'PURCHASED_TOPUP' }, { ...grant, note:'' }, { ...grant, reasonCode:'RECORDED_IN_ERROR' }, { ...grant, organizationId:U() }])
    assert.throws(() => contracts.validateSaasCreativeGrantInput(bad));
  const rates = { termsReference:'Provisional v1', rates:[{ operationCode:'image.generate', mediaKind:'IMAGE', displayName:'AI image', billingUnit:'IMAGE', creditsPerUnit:10, maxUnitsPerRequest:8, costEvidenceId:null }] };
  assert.doesNotThrow(() => contracts.validateSaasCreativeRatesInput(rates));
  for (const bad of [{ ...rates, rates:[] }, { ...rates, rates:[{ ...rates.rates[0], billingUnit:'VIDEO_SECOND' }] }, { ...rates, rates:[rates.rates[0], rates.rates[0]] },
    { ...rates, rates:[{ ...rates.rates[0], mediaKind:'CHAT' }] }])
    assert.throws(() => contracts.validateSaasCreativeRatesInput(bad));
  assert.doesNotThrow(() => contracts.validateSaasCreativeSettleInput({ outcome:'FAILED', expectedVersion:1, finalUnits:null, providerCostMicrounits:500 }));
  for (const bad of [{ outcome:'UNKNOWN', expectedVersion:1, finalUnits:null, providerCostMicrounits:1 }, { outcome:'SUCCEEDED', expectedVersion:1, finalUnits:1, providerCostMicrounits:null },
    { outcome:'SUCCEEDED', expectedVersion:1, finalUnits:1001, providerCostMicrounits:0 }])
    assert.throws(() => contracts.validateSaasCreativeSettleInput(bad));
  assert.throws(() => contracts.validateSaasCreativeResolveInput({ resolution:'NOT_CHARGED', expectedVersion:1, finalUnits:3, providerCostMicrounits:0, evidenceReference:'x' }));
});

test('CW1 school views fail closed on provider cost, other schools, payment or agent deduction claims, and broken balances', () => {
  assert.doesNotThrow(() => contracts.validateSaasCreativeSchoolWallet(schoolWallet()));
  for (const bad of [schoolWallet({ paymentsActive:true }), schoolWallet({ agentConversationsDeductCredits:true }), schoolWallet({ providerExpense:{} }),
    schoolWallet({ reservations:[{ ...reservation(), providerCostMicrounits:10 }] }), schoolWallet({ reservations:[reservation()] }),
    schoolWallet({ purchases:[purchase({ payment:'CONNECTED' })] }), schoolWallet({ purchases:[purchase({ status:'FULFILLED', fulfilledAt:T })] }),
    schoolWallet({ balance:{ ...balance(), availableCredits:9001 } }), schoolWallet({ lots:[lot({ availableCredits:12000 })] }),
    schoolWallet({ lots:[lot({ expired:true })] }), schoolWallet({ program:{ status:'ACTIVE', monthlyIncludedCredits:13000 } }),
    schoolWallet({ adjustments:[{ adjustmentId:U(), kind:'PROMOTIONAL_GRANT', credits:1, lotId:U(), reasonCode:'PROMOTION', occurredAt:T, note:'internal' }] }),
    schoolWallet({ eligibility:{ eligible:false, reason:null, window:null } })])
    assert.throws(() => contracts.validateSaasCreativeSchoolWallet(bad));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const human = command => ({ 'content-type':'application/json', origin:'https://hon.example', 'x-hon-human-command':command, 'sec-fetch-site':'same-origin',
  'sec-fetch-mode':'same-origin', 'sec-fetch-dest':'empty', 'idempotency-key':randomUUID() });

test('HTTP: school reads, opens a window and records a purchase intent; no reserve, settle, fulfill or pay route; exact command headers', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [], school = randomUUID();
  const module = await Test.createTestingModule({ controllers:[SaasCreativeWalletHqController, SaasCreativeWalletSchoolController],
    providers:[SaasCreativeWalletService, SaasBillingService, SaasCommandGuard, SaasReadGuard,
      { provide:RuntimeDatabaseService, useValue:{ callSaasBilling:async (operation, params) => { calls.push([operation, params]);
        if (operation === 'readSchoolCreativeWallet') return schoolWallet({ schoolId:school });
        if (operation === 'createCreativeTopupPurchase') return { purchase:purchase({ schoolId:school }), replayed:false };
        return { lot:lot(), balance:balance(), replayed:false }; } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject:'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1`;
  try {
    const read = await send(`${base}/schools/${school}/creative-credits`); assert.equal(read.status, 200, read.body); assert.match(read.headers['cache-control'], /no-store/);
    assert.deepEqual(calls.at(-1), ['readSchoolCreativeWallet', ['verified-human', school]]);
    assert.equal((await send(`${base}/schools/${school}/creative-credits?organizationId=x`)).status, 400);
    const win = await send(`${base}/schools/${school}/creative-credits/window`, { method:'POST', headers:human('saas-creative-window-open'), body:'{}' });
    assert.equal(win.status, 200, win.body); assert.equal(calls.at(-1)[0], 'openCreativeWindow');
    const n = calls.length;
    assert.equal((await send(`${base}/schools/${school}/creative-credits/window`, { method:'POST', headers:human('saas-creative-topup-purchase'), body:'{}' })).status, 403);
    assert.equal((await send(`${base}/schools/${school}/creative-credits/top-up-purchases`, { method:'POST', headers:human('saas-creative-topup-purchase'), body:JSON.stringify({ packageCode:'GROWTH', priceMinor:1 }) })).status, 400);
    for (const path of [`schools/${school}/creative-credits/reservations`, `schools/${school}/creative-credits/settle`, `schools/${school}/creative-credits/top-up-purchases/x/pay`,
      'hq/saas/creative-credits/fulfill', 'hq/saas/creative-credits/top-up-purchases'])
      assert.equal((await send(`${base}/${path}`, { method:'POST', headers:human('saas-creative-grant'), body:'{}' })).status, 404, path);
    assert.equal(calls.length, n);
    const buy = await send(`${base}/schools/${school}/creative-credits/top-up-purchases`, { method:'POST', headers:human('saas-creative-topup-purchase'), body:JSON.stringify({ packageCode:'GROWTH' }) });
    assert.equal(buy.status, 200, buy.body); assert.equal(JSON.parse(buy.body).data.purchase.payment, 'NOT_CONNECTED');
    assert.deepEqual(calls.at(-1).slice(0, 1).concat([calls.at(-1)[1].slice(0, 3)]), ['createCreativeTopupPurchase', ['verified-human', school, '{"packageCode":"GROWTH"}']]);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('CW1 refusals map to stable 422 codes; runtime reserve/settle validate before the database', async () => {
  for (const code of ['SAAS_CREATIVE_PROGRAM_INACTIVE','SAAS_CREATIVE_PAID_ACCESS_REQUIRED','SAAS_CREDITS_EXHAUSTED','SAAS_CREATIVE_PURCHASED_LOT_PROTECTED','SAAS_CREATIVE_DEBIT_EXCEEDS_AVAILABLE']) {
    const service = new SaasCreativeWalletService(new SaasBillingService({ callSaasBilling:async () => { throw Object.assign(new Error(code), { code:'23514' }); } }));
    await assert.rejects(service.readWallets('verified-human'), e => e.getStatus() === 422 && e.getResponse().code === code);
  }
  const never = new SaasCreativeWalletService(new SaasBillingService({ callSaasBilling:async () => { throw new Error('must not be called'); } }));
  await assert.rejects(never.reserveCredits('verified-human', randomUUID(), { operationCode:'video.generate', units:0, providerId:'HIGGSFIELD', modelCode:'m' }, randomUUID()), e => e.getStatus() === 400);
  await assert.rejects(never.settleCredits('verified-human', randomUUID(), { outcome:'SUCCEEDED', expectedVersion:1, finalUnits:-1, providerCostMicrounits:0 }, randomUUID()), e => e.getStatus() === 400);
  await assert.rejects(never.grantCredits('verified-human', 'not-a-uuid', { kind:'PROMOTIONAL', credits:1, reasonCode:'PROMOTION', note:'x' }, randomUUID()), e => e.getStatus() === 400);
});

// ---------- CW1 independent-review corrections (school-owned wallets, unknown cost, CREATIVE_MEDIA) ----------
const internalReservation = (schoolId, organizationId, patch = {}) => ({ ...reservation({ schoolId }), organizationId, providerId:'HIGGSFIELD', modelCode:'fixture-video-1',
  costStatus:'PENDING', providerCostMicrounits:null, costReference:null, costRecordedAt:null, usageId:null, resolutionReference:null, ...patch });
const expense = (patch = {}) => ({ actualProviderCostMicrounits:0, finalizedProviderCostMicrounits:0, failedOrNotChargedProviderCostMicrounits:0, consumedCredits:0,
  unknownCostGenerations:0, pendingCostGenerations:1, spendClass:'CREATIVE_MEDIA', generations:{ finalized:0, released:0, reserved:1, outcomeUnknown:0 }, ...patch });
const hqWallet = (patch = {}) => { const schoolId = patch.schoolId ?? U(), organizationId = patch.organizationId ?? U();
  return { ...schoolWallet({ schoolId }), organizationId, reservations:[internalReservation(schoolId, organizationId)], purchases:[{ ...purchase({ schoolId }), paymentProvider:null,
    providerPaymentRef:null, paidAmountMinor:null, paidCurrency:null }], providerExpense:expense(), ...patch }; };
const released = (s, o, patch) => internalReservation(s, o, { status:'RELEASED', statusReason:'PROVIDER_FAILED', version:2, settledAt:T, ...patch });

test('CW1 review: HQ wallets are one school; unknown provider cost is never a verified zero; creative expense is CREATIVE_MEDIA', () => {
  const ok = hqWallet();
  assert.doesNotThrow(() => contracts.validateSaasCreativeHqWallet(ok));
  // P1-A/P1-B: a reservation or purchase of another school (even in the same organization) is drift, as is a missing school id.
  for (const bad of [{ ...ok, reservations:[internalReservation(U(), ok.organizationId)] }, { ...ok, reservations:[internalReservation(ok.schoolId, U())] },
    { ...ok, purchases:[{ ...ok.purchases[0], schoolId:U() }] }, (({ schoolId, ...rest }) => rest)(ok)])
    assert.throws(() => contracts.validateSaasCreativeHqWallet(bad));
  // P2-A: creative expense must say CREATIVE_MEDIA.
  assert.throws(() => contracts.validateSaasCreativeHqWallet({ ...ok, providerExpense:expense({ spendClass:'AGENT_INFERENCE' }) }));
  // P2-B: cost status is consistent with the cost; an UNKNOWN cost has no amount; an open generation is always PENDING.
  const s = ok.schoolId, o = ok.organizationId;
  assert.doesNotThrow(() => contracts.validateSaasCreativeHqWallet({ ...ok, reservations:[released(s, o, { costStatus:'UNKNOWN' })] }));
  for (const r of [released(s, o, { costStatus:'UNKNOWN', providerCostMicrounits:0 }), released(s, o, { costStatus:'RECORDED', providerCostMicrounits:null, costRecordedAt:T }),
    released(s, o, { costStatus:'PENDING' }), internalReservation(s, o, { costStatus:'UNKNOWN' }), released(s, o, { costStatus:'UNKNOWN', usageId:U() })])
    assert.throws(() => contracts.validateSaasCreativeHqWallet({ ...ok, reservations:[r] }), JSON.stringify(r));
  // Inputs: NOT_CHARGED may leave the cost unknown; SUCCEEDED may not; the HQ cost record is closed.
  assert.doesNotThrow(() => contracts.validateSaasCreativeResolveInput({ resolution:'NOT_CHARGED', expectedVersion:1, finalUnits:null, providerCostMicrounits:null, evidenceReference:'case-1' }));
  assert.throws(() => contracts.validateSaasCreativeResolveInput({ resolution:'SUCCEEDED', expectedVersion:1, finalUnits:1, providerCostMicrounits:null, evidenceReference:'case-1' }));
  assert.doesNotThrow(() => contracts.validateSaasCreativeCostInput({ expectedVersion:2, providerCostMicrounits:42000, evidenceReference:'invoice line 7' }));
  for (const bad of [{ expectedVersion:2, providerCostMicrounits:null, evidenceReference:'x' }, { expectedVersion:2, providerCostMicrounits:1, evidenceReference:'' },
    { expectedVersion:2, providerCostMicrounits:1, evidenceReference:'x', schoolId:U() }, { expectedVersion:0, providerCostMicrounits:1, evidenceReference:'x' }])
    assert.throws(() => contracts.validateSaasCreativeCostInput(bad));
  const applied = released(s, o, { costStatus:'RECORDED', providerCostMicrounits:42000, costReference:'invoice line 7', costRecordedAt:T, usageId:U(), version:3 });
  assert.doesNotThrow(() => contracts.validateSaasCreativeCostReceipt({ reservation:applied, outcome:'APPLIED', replayed:false }));
  assert.throws(() => contracts.validateSaasCreativeCostReceipt({ reservation:released(s, o, { costStatus:'UNKNOWN' }), outcome:'APPLIED', replayed:false }));
  // HQ list: one row per school, never a merged organization row.
  const row = (schoolId, organizationId) => ({ schoolId, schoolName:'Dojo', organizationId, organizationName:'Org', availableCredits:1, heldCredits:0, consumedCredits:0,
    actualProviderCostMicrounits:0, outcomeUnknown:0, unknownCostGenerations:0, updatedAt:T });
  const list = wallets => ({ program:{ status:'ACTIVE', version:2, monthlyIncludedCredits:12000 }, rates:null, packages:packages(), wallets });
  const org = U(), a = U();
  assert.doesNotThrow(() => contracts.validateSaasCreativeHqWalletList(list([row(a, org), row(U(), org)])));
  assert.throws(() => contracts.validateSaasCreativeHqWalletList(list([row(a, org), row(a, org)])));
});

test('CW1 review HTTP: HQ routes are per school; organization routes are gone; provider cost has its own owner command', async () => {
  const calls = [], school = U(), org = U(), reservationId = U();
  const module = await Test.createTestingModule({ controllers:[SaasCreativeWalletHqController],
    providers:[SaasCreativeWalletService, SaasBillingService, SaasCommandGuard, SaasReadGuard,
      { provide:RuntimeDatabaseService, useValue:{ callSaasBilling:async (operation, params) => { calls.push([operation, params]);
        if (operation === 'readCreativeWalletFromHq') return hqWallet({ schoolId:school, organizationId:org });
        if (operation === 'recordCreativeCost') return { reservation:released(school, org, { costStatus:'RECORDED', providerCostMicrounits:42000, costReference:'invoice line 7',
          costRecordedAt:T, usageId:U(), version:3 }), outcome:'APPLIED', replayed:false };
        return { adjustment:{ adjustmentId:U(), schoolId:school, lot:lot({ kind:'PROMOTIONAL', window:null, expiresAt:null, adjustmentId:U(), availableCredits:500, heldCredits:0,
          consumedCredits:0, credits:500 }), reasonCode:'PROMOTION', note:'x' }, balance:balance(), replayed:false }; } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject:'verified-human' }; return true; } }).compile();
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/saas/creative-credits`;
  try {
    assert.equal((await send(`${base}/schools/${school}`)).status, 200);
    assert.deepEqual(calls.at(-1), ['readCreativeWalletFromHq', ['verified-human', school]]);
    const g = await send(`${base}/schools/${school}/grants`, { method:'POST', headers:human('saas-creative-grant'), body:JSON.stringify({ kind:'PROMOTIONAL', credits:500, reasonCode:'PROMOTION', note:'x' }) });
    assert.equal(g.status, 200, g.body); assert.deepEqual(calls.at(-1)[1].slice(0, 2), ['verified-human', school]);
    const c = await send(`${base}/reservations/${reservationId}/provider-cost`, { method:'POST', headers:human('saas-creative-cost-record'),
      body:JSON.stringify({ expectedVersion:2, providerCostMicrounits:42000, evidenceReference:'invoice line 7' }) });
    assert.equal(c.status, 200, c.body); assert.deepEqual(calls.at(-1)[0], 'recordCreativeCost');
    const n = calls.length;
    assert.equal((await send(`${base}/reservations/${reservationId}/provider-cost`, { method:'POST', headers:human('saas-creative-resolve'),
      body:JSON.stringify({ expectedVersion:2, providerCostMicrounits:42000, evidenceReference:'invoice line 7' }) })).status, 403, 'the command header must match');
    assert.equal((await send(`${base}/organizations/${org}`)).status, 404, 'no organization wallet');
    assert.equal((await send(`${base}/organizations/${org}/grants`, { method:'POST', headers:human('saas-creative-grant'), body:'{}' })).status, 404);
    assert.equal(calls.length, n);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('CW1 review refusals: S4 pause, access and school state refuse with stable codes; a cost for an open outcome is a retryable conflict', async () => {
  for (const code of ['SAAS_CREATIVE_AI_PAUSED_BY_HQ','SAAS_CREATIVE_AI_EXCEPTION_NO_AI','SAAS_CREATIVE_AI_ACCESS_SUSPENDED','SAAS_CREATIVE_SCHOOL_NOT_ACTIVE']) {
    const service = new SaasCreativeWalletService(new SaasBillingService({ callSaasBilling:async () => { throw Object.assign(new Error(code), { code:'23514' }); } }));
    await assert.rejects(service.readWallets('verified-human'), e => e.getStatus() === 422 && e.getResponse().code === code);
  }
  const pending = new SaasCreativeWalletService(new SaasBillingService({ callSaasBilling:async () => { throw Object.assign(new Error('SAAS_CREATIVE_OUTCOME_PENDING'), { code:'40001' }); } }));
  await assert.rejects(pending.readWallets('verified-human'), e => e.getStatus() === 409 && e.getResponse().code === 'SAAS_CREATIVE_OUTCOME_PENDING');
});
