const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { SaasBillingHqController, SaasCreditsSchoolController } = require('../dist/saas-billing/saas-billing.controller.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const T = '2026-10-18T12:00:00.000Z', U = () => randomUUID();
const balance = (patch = {}) => ({ allowanceCredits:5000, consumedCredits:30, heldCredits:20, expiredCredits:0, availableCredits:4950, usedPercent:1, ...patch });
const allowance = (patch = {}) => ({ allowanceId:U(), subscriptionId:U(), periodIndex:0, periodStart:T, periodEnd:'2026-11-18T12:00:00.000Z', planCode:'CORE',
  allowanceBasis:'REGULAR', status:'OPEN', version:1, balance:balance(), thresholds:[], rollover:'NONE', topUps:'UNAVAILABLE', openedAt:T, expiredAt:null, ...patch });
const reservation = (patch = {}) => ({ reservationId:U(), allowanceId:U(), organizationId:U(), schoolId:U(), subscriptionId:U(), operationCode:'image.generate',
  category:'IMAGE_GENERATION', creditsPerUnit:10, estimatedUnits:2, reservedCredits:20, status:'RESERVED', statusReason:'RESERVED', version:1, employeeKey:null,
  actionRequestId:null, workItemId:null, finalUnits:null, finalCredits:null, reservedAt:T, settledAt:null, ...patch });
const op = (patch = {}) => ({ operationCode:'image.generate', category:'IMAGE_GENERATION', displayName:'AI image', billingUnit:'IMAGE', creditsPerUnit:10,
  maxUnitsPerRequest:8, requiredCapability:'ai.premium_metered', ...patch });
const schoolView = (patch = {}) => ({ schoolId:U(), planCode:'CORE', subscriptionStatus:'IN_SERVICE', programStatus:'ACTIVE', currentAllowance:allowance(),
  operations:[op()], recentReservations:[reservation()], ordinaryUseConsumesCredits:false, topUps:'UNAVAILABLE', ...patch });

test('B3 inputs: no default prices, Complete-only work stays gated, settlement shapes are exact', () => {
  const draft = { termsReference:'Fixture', operations:[{ ...op(), costEvidenceId:U() }] };
  assert.deepEqual(contracts.validateSaasPricingDraftInput(draft).operations[0].creditsPerUnit, 10);
  for (const bad of [{ ...draft, operations:[] }, { ...draft, operations:[{ ...op() }] }, { ...draft, operations:[{ ...op(), creditsPerUnit:0, costEvidenceId:U() }] },
    { ...draft, operations:[{ ...op({ category:'AI_EMPLOYEE_TASK', requiredCapability:'ai.premium_metered' }), costEvidenceId:U() }] },
    { ...draft, operations:[{ ...op({ category:'CAMPAIGN_OPTIMIZATION' }), costEvidenceId:U() }] }])
    assert.throws(() => contracts.validateSaasPricingDraftInput(bad));
  const ev = { providerId:'HIGGSFIELD', modelCode:'fixture-image-1', costUnit:'IMAGE', measuredUnits:1000, billedCostMicrounits:40000000,
    fullyLoadedCostMicrounits:50000000, evidenceReference:'INV-1', periodStart:'2026-09-01T00:00:00.000Z', periodEnd:'2026-10-01T00:00:00.000Z', note:null };
  assert.doesNotThrow(() => contracts.validateSaasCostEvidenceInput(ev));
  for (const bad of [{ ...ev, fullyLoadedCostMicrounits:1 }, { ...ev, providerId:'FICTIONAL' }, { ...ev, evidenceReference:'' }, { ...ev, billedCostMicrounits:0 },
    { ...ev, periodEnd:ev.periodStart }, { ...ev, costPerCreditMicrounits:5000 }])
    assert.throws(() => contracts.validateSaasCostEvidenceInput(bad));
  assert.doesNotThrow(() => contracts.validateSaasCreditSettleInput({ outcome:'UNKNOWN', expectedVersion:1, finalUnits:null, providerCostMicrounits:null, inputUnits:null, outputUnits:null }));
  for (const bad of [{ outcome:'UNKNOWN', expectedVersion:1, finalUnits:1, providerCostMicrounits:null, inputUnits:null, outputUnits:null },
    { outcome:'SUCCEEDED', expectedVersion:1, finalUnits:1, providerCostMicrounits:null, inputUnits:null, outputUnits:null },
    { outcome:'RETRY', expectedVersion:1, finalUnits:null, providerCostMicrounits:null, inputUnits:null, outputUnits:null }])
    assert.throws(() => contracts.validateSaasCreditSettleInput(bad));
  assert.throws(() => contracts.validateSaasCreditProgramInput({ action:'ACTIVATE', expectedVersion:1, authorizationReference:'' }));
  assert.throws(() => contracts.validateSaasCreditProgramInput({ action:'ENABLE_TOP_UPS', expectedVersion:1, authorizationReference:'x' }));
  assert.deepEqual(contracts.SAAS_PLANNED_MONTHLY_CREDITS, { CORE:5000, COMPLETE:12000 });
});

test('B3 responses fail closed on overdrawn balances, top-ups, sent notifications or leaked provider cost', () => {
  assert.doesNotThrow(() => contracts.validateSaasSchoolCredits(schoolView()));
  for (const bad of [schoolView({ topUps:'AVAILABLE' }), schoolView({ ordinaryUseConsumesCredits:true }),
    schoolView({ currentAllowance:allowance({ balance:balance({ consumedCredits:4990, heldCredits:20, availableCredits:0 }) }) }),
    schoolView({ currentAllowance:allowance({ balance:balance({ availableCredits:5000 }) }) }),
    schoolView({ currentAllowance:allowance({ rollover:'CARRY_FORWARD' }) }),
    schoolView({ currentAllowance:allowance({ thresholds:[{ thresholdPercent:75, reachedAt:T, notification:'SENT' }] }) }),
    schoolView({ currentAllowance:allowance({ organizationId:U() }) }),
    schoolView({ operations:[{ ...op(), fullyLoadedCostMicrounitsPerUnit:50000 }] }),
    schoolView({ recentReservations:[{ ...reservation(), providerCostMicrounits:10 }] }),
    schoolView({ recentReservations:[reservation({ reservedCredits:999 })] }),
    schoolView({ recentReservations:[reservation({ status:'FINALIZED', finalUnits:3, finalCredits:30, settledAt:T })] })])
    assert.throws(() => contracts.validateSaasSchoolCredits(bad));
  const program = { status:'ACTIVE', version:2, authorizationReference:null, changedAt:T, topUps:'UNAVAILABLE', overage:'DISABLED', purchases:'DISABLED' };
  assert.throws(() => contracts.validateSaasCreditProgramReceipt({ program, replayed:false }));
  assert.throws(() => contracts.validateSaasCreditProgramReceipt({ program:{ ...program, authorizationReference:'x', overage:'ENABLED' }, replayed:false }));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const human = command => ({ 'content-type':'application/json', origin:'https://hon.example', 'x-hon-human-command':command, 'sec-fetch-site':'same-origin',
  'sec-fetch-mode':'same-origin', 'sec-fetch-dest':'empty', 'idempotency-key':randomUUID() });

test('HTTP: schools read and estimate only; no reserve, purchase or top-up route; HQ commands need exact headers', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [];
  const estimate = { operationCode:'image.generate', category:'IMAGE_GENERATION', units:5, creditsPerUnit:10, estimatedCredits:50, availableCredits:4950, allowed:true, refusal:null, estimateOnly:true };
  const module = await Test.createTestingModule({ controllers:[SaasBillingHqController, SaasCreditsSchoolController], providers:[SaasBillingService, SaasCommandGuard, SaasReadGuard,
    { provide:RuntimeDatabaseService, useValue:{ callSaasBilling:async (operation, params) => { calls.push([operation, params]);
      return operation === 'estimatePremiumOperation' ? estimate : operation === 'readSchoolCredits' ? schoolView()
        : { program:{ status:'ACTIVE', version:2, authorizationReference:'Owner auth', changedAt:T, topUps:'UNAVAILABLE', overage:'DISABLED', purchases:'DISABLED' }, replayed:false }; } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject:'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1`;
  try {
    const school = randomUUID();
    const read = await send(`${base}/schools/${school}/ai-credits`); assert.equal(read.status, 200, read.body); assert.match(read.headers['cache-control'], /no-store/);
    assert.deepEqual(calls.at(-1), ['readSchoolCredits', ['verified-human', school]]);
    assert.equal((await send(`${base}/schools/${school}/ai-credits/estimate?operation=image.generate&units=5`)).status, 200);
    assert.deepEqual(calls.at(-1), ['estimatePremiumOperation', ['verified-human', school, 'image.generate', '5']]);
    for (const q of ['?operation=image.generate', '?operation=Image&units=5', '?operation=image.generate&units=0', '?operation=image.generate&units=5&organizationId=x'])
      assert.equal((await send(`${base}/schools/${school}/ai-credits/estimate${q}`)).status, 400, q);
    const n = calls.length;
    for (const path of [`schools/${school}/ai-credits/reservations`, `schools/${school}/ai-credits/top-ups`, `schools/${school}/ai-credits/purchase`,
      'hq/saas/credits/grants', 'hq/saas/credits/top-ups', 'hq/saas/credits/reservations'])
      assert.equal((await send(`${base}/${path}`, { method:'POST', headers:human('saas-credit-program'), body:'{}' })).status, 404, path);
    const body = JSON.stringify({ action:'ACTIVATE', expectedVersion:1, authorizationReference:'Owner auth' });
    assert.equal((await send(`${base}/hq/saas/credits/program`, { method:'POST', headers:human('saas-pricing-publish'), body })).status, 403);
    assert.equal(calls.length, n);
    const okRes = await send(`${base}/hq/saas/credits/program`, { method:'POST', headers:human('saas-credit-program'), body }); assert.equal(okRes.status, 200, okRes.body);
    assert.equal(calls.at(-1)[0], 'setCreditProgram');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('B3 refusals map to stable 422 codes; runtime-only reserve and settle validate before the database', async () => {
  for (const code of ['SAAS_CREDITS_EXHAUSTED','SAAS_CREDITS_NOT_ACTIVE','SAAS_OPERATION_NOT_IN_PLAN','SAAS_FINAL_EXCEEDS_RESERVATION','SAAS_PRICING_COST_EVIDENCE_MISMATCH']) {
    const service = new SaasBillingService({ callSaasBilling:async () => { throw Object.assign(new Error(code), { code:'23514' }); } });
    await assert.rejects(service.readCreditProgram('verified-human'), e => e.getStatus() === 422 && e.getResponse().code === code);
  }
  const never = new SaasBillingService({ callSaasBilling:async () => { throw new Error('must not be called'); } });
  await assert.rejects(never.reservePremiumCredits('verified-human', randomUUID(), { operationCode:'image.generate', units:0, employeeKey:null, actionRequestId:null, workItemId:null }, randomUUID()), e => e.getStatus() === 400);
  await assert.rejects(never.settlePremiumCredits('verified-human', randomUUID(), { outcome:'SUCCEEDED', expectedVersion:1, finalUnits:-1, providerCostMicrounits:0, inputUnits:null, outputUnits:null }, randomUUID()), e => e.getStatus() === 400);
});
