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

const T = '2026-10-01T12:00:00.000Z', END = '2026-10-31T12:00:00.000Z', U = () => randomUUID();
const refund = (patch = {}) => ({ refundRequestId:U(), organizationId:U(), organizationName:'Fixture Dojo', subscriptionId:U(), invoiceId:U(),
  invoiceNumber:'HON-2026-000001', offerKind:'REGULAR_MONTHLY', firstPaidAt:T, windowEndsAt:END, requestReceivedAt:'2026-10-10T12:00:00.000Z',
  customerReference:'Email 2026-10-10', requestedAmountMinor:14900, approvedAmountMinor:null, evidenceStrength:'HQ_ATTESTED', status:'REQUESTED',
  statusReason:'REQUESTED', version:1, note:null, execution:'UNAVAILABLE', executionStatus:'NOT_EXECUTED', subscriptionConsequence:'BLOCKED_PENDING_TERMS',
  refundEvidencedMinor:0, createdAt:'2026-10-10T12:00:01.000Z', decidedAt:null, ...patch });
const application = (patch = {}) => ({ applicationId:U(), rewardEntryId:U(), organizationId:U(), subscriptionId:U(), applicationKind:'ACCOUNT_CREDIT',
  creditMinor:10000, freeMonths:null, firstPeriodIndex:null, lifetimeTier:null, status:'APPLIED', appliedAt:T, ...patch });
const entry = (patch = {}) => ({ rewardEntryId:U(), rewardKind:'REFERRER_CREDIT', beneficiaryRole:'REFERRER', beneficiaryOrganizationId:U(), milestoneCount:1,
  creditMinor:10000, freeMonths:null, lifetimeTier:null, aiAllowance:null, entryStatus:'APPROVED', entryVersion:2, fulfillmentForm:'AS_EARNED',
  applicationKind:'ACCOUNT_CREDIT', subscriptionId:U(), state:'READY', blocker:null, application:null, fulfilledNotice:'PREVIEW_IS_NOT_FULFILLMENT', ...patch });
const fulfillment = (patch = {}) => ({ status:'INACTIVE', version:1, authorizationReference:null, changedAt:T, prizes:'NOT_ISSUED', cashPayouts:'DISABLED', ...patch });
const alert = (patch = {}) => ({ alertId:U(), attributionId:U(), attributionState:'QUALIFIED', referredOrganizationId:U(), referredOrganizationName:'Referred Dojo',
  referrerSchoolId:U(), source:'PAYMENT_EVIDENCE', paymentEvidenceId:U(), refundRequestId:null, evidenceKind:'CHARGEBACK', referredRecordedNetMinor:0,
  status:'OPEN', resolution:null, resolutionReference:null, version:1, raisedAt:T, resolvedAt:null, affectedApplications:[], automaticReversal:'NONE',
  debtCreated:false, ...patch });

test('B4 inputs: refund intake, decisions, reward application and alert resolution are closed shapes', () => {
  const intake = { organizationId:U(), requestReceivedAt:'2026-10-10T12:00:00.000Z', customerReference:'Email', note:null };
  assert.doesNotThrow(() => contracts.validateSaasRefundRequestInput(intake));
  for (const bad of [{ ...intake, amountMinor:14900 }, { ...intake, requestReceivedAt:'2026-10-10' }, { ...intake, customerReference:' x' },
    { ...intake, organizationId:'school' }, { ...intake, execute:true }])
    assert.throws(() => contracts.validateSaasRefundRequestInput(bad));
  assert.doesNotThrow(() => contracts.validateSaasRefundDecisionInput({ decision:'APPROVE', reasonCode:'GUARANTEE_APPROVED', expectedVersion:1, note:null }));
  assert.doesNotThrow(() => contracts.validateSaasRefundDecisionInput({ decision:'DENY', reasonCode:'FRAUD_SUSPECTED', expectedVersion:1, note:'x' }));
  for (const bad of [{ decision:'APPROVE', reasonCode:'FRAUD_SUSPECTED', expectedVersion:1, note:null }, { decision:'EXECUTE', reasonCode:'GUARANTEE_APPROVED', expectedVersion:1, note:null },
    { decision:'DENY', reasonCode:'GUARANTEE_APPROVED', expectedVersion:1, note:null }, { decision:'APPROVE', reasonCode:'GUARANTEE_APPROVED', expectedVersion:0, note:null },
    { decision:'APPROVE', reasonCode:'GUARANTEE_APPROVED', expectedVersion:1, note:null, amountMinor:1 }])
    assert.throws(() => contracts.validateSaasRefundDecisionInput(bad));
  assert.doesNotThrow(() => contracts.validateSaasRewardApplyInput({ expectedEntryVersion:2, firstPeriodIndex:3 }));
  for (const bad of [{ expectedEntryVersion:2 }, { expectedEntryVersion:2, firstPeriodIndex:-1 }, { expectedEntryVersion:2, firstPeriodIndex:null, creditMinor:5 }])
    assert.throws(() => contracts.validateSaasRewardApplyInput(bad));
  assert.throws(() => contracts.validateSaasReferralAlertResolveInput({ expectedVersion:1, resolution:'REVERSE_REWARDS', reference:'x' }));
  assert.throws(() => contracts.validateSaasRewardFulfillmentInput({ action:'ISSUE_PRIZES', expectedVersion:1, authorizationReference:'x' }));
  assert.deepEqual(contracts.validateSaasRefundEligibilityQuery({}), { receivedAt:null });
  assert.throws(() => contracts.validateSaasRefundEligibilityQuery({ receivedAt:'now' }));
  assert.equal(contracts.SAAS_CHAMPIONS_LADDER.secondFreeMonthsTotal, 12);
  assert.equal(contracts.SAAS_POLICY_CODES.length, 21);
  assert.deepEqual([...contracts.SAAS_POLICY_CODES], [...contracts.SAAS_POLICY_CODES].sort());
});

test('B4 responses fail closed on executed refunds, prizes, payouts, debts or a preview passing as fulfillment', () => {
  assert.doesNotThrow(() => contracts.validateSaasRefundRequestReceipt({ refundRequest:refund(), replayed:false }));
  for (const bad of [refund({ executionStatus:'EXECUTED' }), refund({ execution:'AVAILABLE' }), refund({ subscriptionConsequence:'CANCELLED' }),
    refund({ windowEndsAt:'2026-11-01T12:00:00.000Z' }), refund({ requestReceivedAt:END }), refund({ requestReceivedAt:'2026-09-30T12:00:00.000Z' }),
    refund({ approvedAmountMinor:14900 })])
    assert.throws(() => contracts.validateSaasRefundRequestReceipt({ refundRequest:bad, replayed:false }));
  const approved = refund({ status:'APPROVED', statusReason:'GUARANTEE_APPROVED', approvedAmountMinor:14900, version:2, decidedAt:T });
  assert.doesNotThrow(() => contracts.validateSaasRefundDecisionReceipt({ refundRequest:approved, decision:'APPROVE', replayed:false }));
  assert.throws(() => contracts.validateSaasRefundDecisionReceipt({ refundRequest:approved, decision:'DENY', replayed:false }));
  assert.throws(() => contracts.validateSaasRefundDecisionReceipt({ refundRequest:{ ...approved, status:'REFUND_EVIDENCED', refundEvidencedMinor:100 },
    decision:'MARK_EVIDENCED', replayed:false }));
  assert.throws(() => contracts.validateSaasRewardFulfillmentReceipt({ fulfillment:fulfillment({ prizes:'ISSUED' }), replayed:false }));
  assert.throws(() => contracts.validateSaasRewardFulfillmentReceipt({ fulfillment:fulfillment({ cashPayouts:'ENABLED' }), replayed:false }));
  assert.throws(() => contracts.validateSaasRewardFulfillmentReceipt({ fulfillment:fulfillment({ status:'ACTIVE' }), replayed:false }));
  const org = U();
  const preview = (patch = {}) => ({ organizationId:org, fulfillment:fulfillment(), rewards:[entry({ beneficiaryOrganizationId:org })],
    accountCredit:{ grantedMinor:0, appliedMinor:0, availableMinor:0, blockedMinor:0 }, freePeriods:[], alerts:[alert()], currency:'USD', ...patch });
  assert.doesNotThrow(() => contracts.validateSaasRewardPreview(preview()));
  for (const bad of [preview({ rewards:[entry({ beneficiaryOrganizationId:org, fulfilledNotice:'FULFILLED' })] }),
    preview({ rewards:[entry({ beneficiaryOrganizationId:org, state:'APPLIED' })] }),
    preview({ rewards:[entry({ beneficiaryOrganizationId:org, state:'READY', blocker:'SAAS_REWARDS_NOT_ACTIVE' })] }),
    preview({ rewards:[entry()] }),
    preview({ rewards:[entry({ beneficiaryOrganizationId:org, rewardKind:'LIFETIME_MEMBERSHIP', applicationKind:'LIFETIME_CONVERSION', aiAllowance:null })] }),
    preview({ alerts:[alert({ debtCreated:true })] }), preview({ alerts:[alert({ automaticReversal:'CLAWBACK' })] }),
    preview({ accountCredit:{ grantedMinor:10000, appliedMinor:10000, availableMinor:10000, blockedMinor:0 } })])
    assert.throws(() => contracts.validateSaasRewardPreview(bad));
  const inv = U();
  const cp = { invoiceId:inv, invoiceStatus:'DRAFT', taxStatus:'UNRESOLVED', subtotalMinor:14900, availableCreditMinor:20000, wouldApplyMinor:14900,
    resultingSubtotalMinor:0, applicable:true, zeroTotalIssuable:false, fulfillment:'ACTIVE', previewOnly:true };
  assert.doesNotThrow(() => contracts.validateSaasCreditApplicationPreview(cp));
  for (const bad of [{ ...cp, wouldApplyMinor:20000, resultingSubtotalMinor:-5100 }, { ...cp, zeroTotalIssuable:true }, { ...cp, previewOnly:false }])
    assert.throws(() => contracts.validateSaasCreditApplicationPreview(bad));
  const applied = entry({ state:'APPLIED', application:null });
  assert.throws(() => contracts.validateSaasRewardApplyReceipt({ application:application(), reward:applied, replayed:false }));
  const app = application({ rewardEntryId:applied.rewardEntryId });
  assert.doesNotThrow(() => contracts.validateSaasRewardApplyReceipt({ application:app, reward:{ ...applied, application:app }, replayed:false }));
  assert.throws(() => contracts.validateSaasRewardApplyReceipt({ application:application({ applicationKind:'LIFETIME_CONVERSION', creditMinor:null, lifetimeTier:'CORE' }),
    reward:applied, replayed:false }));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const human = command => ({ 'content-type':'application/json', origin:'https://hon.example', 'x-hon-human-command':command, 'sec-fetch-site':'same-origin',
  'sec-fetch-mode':'same-origin', 'sec-fetch-dest':'empty', 'idempotency-key':randomUUID() });

test('HTTP: B4 routes are HQ-only, need exact human-command headers, and there is no refund execution, payout or prize route', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [];
  const responses = {
    readRefundRequests: { refundRequests:[refund()], limit:200, execution:'UNAVAILABLE' },
    createRefundRequest: { refundRequest:refund(), replayed:false },
    readReferralAlerts: { alerts:[alert()], limit:200 },
    setRewardFulfillment: { fulfillment:fulfillment({ status:'ACTIVE', version:2, authorizationReference:'Owner auth' }), replayed:false },
  };
  const module = await Test.createTestingModule({ controllers:[SaasBillingHqController, SaasCreditsSchoolController], providers:[SaasBillingService, SaasCommandGuard, SaasReadGuard,
    { provide:RuntimeDatabaseService, useValue:{ callSaasBilling:async (operation, params) => { calls.push([operation, params]); return responses[operation]; } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject:'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1`;
  try {
    const list = await send(`${base}/hq/saas/refunds?status=REQUESTED`); assert.equal(list.status, 200, list.body); assert.match(list.headers['cache-control'], /no-store/);
    assert.deepEqual(calls.at(-1), ['readRefundRequests', ['verified-human', 'REQUESTED']]);
    assert.equal((await send(`${base}/hq/saas/refunds?status=EXECUTED`)).status, 400);
    assert.equal((await send(`${base}/hq/saas/referral-alerts?organizationId=x`)).status, 400);
    const n = calls.length;
    for (const path of ['hq/saas/refunds/execute', `hq/saas/refunds/${U()}/execute`, 'hq/saas/rewards/prizes', 'hq/saas/rewards/payouts',
      `hq/saas/rewards/${U()}/reverse`, `hq/saas/referral-alerts/${U()}/clawback`, `schools/${U()}/ai-credits/refunds`])
      assert.equal((await send(`${base}/${path}`, { method:'POST', headers:human('saas-refund-request'), body:'{}' })).status, 404, path);
    const body = JSON.stringify({ organizationId:U(), requestReceivedAt:'2026-10-10T12:00:00.000Z', customerReference:'Email', note:null });
    assert.equal((await send(`${base}/hq/saas/refunds`, { method:'POST', headers:human('saas-refund-decide'), body })).status, 403);
    const noHeader = human('saas-refund-request'); delete noHeader['x-hon-human-command'];
    assert.equal((await send(`${base}/hq/saas/refunds`, { method:'POST', headers:noHeader, body })).status, 403);
    assert.equal(calls.length, n);
    const created = await send(`${base}/hq/saas/refunds`, { method:'POST', headers:human('saas-refund-request'), body }); assert.equal(created.status, 200, created.body);
    assert.equal(calls.at(-1)[0], 'createRefundRequest');
    const act = await send(`${base}/hq/saas/rewards/fulfillment`, { method:'POST', headers:human('saas-reward-fulfillment'),
      body:JSON.stringify({ action:'ACTIVATE', expectedVersion:1, authorizationReference:'Owner auth' }) });
    assert.equal(act.status, 200, act.body);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('B4 refusals map to stable 422 codes; invalid input never reaches the database', async () => {
  for (const code of ['SAAS_REFUND_WINDOW_EXPIRED','SAAS_REFUND_ALREADY_GRANTED','SAAS_REWARD_PAYMENT_ALERT_OPEN','SAAS_REWARDS_NOT_ACTIVE',
    'SAAS_REWARD_ALREADY_APPLIED','SAAS_PERIOD_FREE','SAAS_ALERT_ATTRIBUTION_UNDECIDED','SAAS_NO_ACCOUNT_CREDIT']) {
    const service = new SaasBillingService({ callSaasBilling:async () => { throw Object.assign(new Error(code), { code:'23514' }); } });
    await assert.rejects(service.readRefundReserve('verified-human'), e => e.getStatus() === 422 && e.getResponse().code === code);
  }
  const drift = new SaasBillingService({ callSaasBilling:async () => ({ refundRequests:[refund({ executionStatus:'EXECUTED' })], limit:200, execution:'UNAVAILABLE' }) });
  await assert.rejects(drift.readRefundRequests('verified-human', undefined), e => e.getStatus() === 503);
  const never = new SaasBillingService({ callSaasBilling:async () => { throw new Error('must not be called'); } });
  await assert.rejects(never.applyChampionsReward('verified-human', U(), { expectedEntryVersion:0, firstPeriodIndex:null }, U()), e => e.getStatus() === 400);
  await assert.rejects(never.applyAccountCredit('verified-human', U(), { expectedVersion:1, amountMinor:5000 }, U()), e => e.getStatus() === 400);
  await assert.rejects(never.createRefundRequest('verified-human', { organizationId:U(), requestReceivedAt:T, customerReference:'x', note:null }, 'not-a-key'), e => e.getStatus() === 400);
});
