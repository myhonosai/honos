const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ChampionsHqController, ChampionsSchoolController } = require('../dist/champions/champions-club.controller.js');
const { ChampionsClubService } = require('../dist/champions/champions-club.service.js');
const { ChampionsCommandGuard, ChampionsReadGuard } = require('../dist/champions/champions-club.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const school = randomUUID(), org = randomUUID(), policyId = randomUUID(), entryId = randomUUID();
const at = '2026-10-18T05:00:00.000Z';
const terms = (patch = {}) => ({ referrerCreditMinor:10000, referrerCreditMaxRank:4, welcomeCreditMinor:10000, firstFreeMonthsCount:5, firstFreeMonthsTotal:6,
  secondFreeMonthsCount:10, secondFreeMonthsTotal:12, prizeCount:20, prizeBudgetMinor:null, lifetimeCount:30, clawbackRule:'UNDECIDED',
  monthlyRule:'AS_EARNED', annualRule:'AS_EARNED', founderRule:'UNDECIDED', paidLifetimeRule:'OWNER_SUBSTITUTE', termsReference:'Reward terms v1', ...patch });
const policy = (patch = {}) => ({ ...terms(), policyId, policyVersion:1, status:'DRAFT', aiAllowance:'FULL_PLAN_ALLOWANCE', currency:'USD', financialActivation:'DISABLED', createdAt:at, publishedAt:null, ...patch });
const entry = (patch = {}) => ({ entryId, rewardKind:'FREE_MONTHS', beneficiaryRole:'REFERRER', beneficiaryOrganizationId:org, referrerOrganizationId:org, referrerSchoolId:school,
  attributionId:null, milestoneOrdinal:1, milestoneCount:5, creditMinor:null, freeMonths:6, lifetimeTier:null, aiAllowance:'FULL_PLAN_ALLOWANCE', basisQualifiedCount:5,
  status:'ACCRUED', retained:false, version:1, policyVersion:1, planBasis:null, fulfillmentForm:null, substitute:null, prize:null, voidReason:null, accruedAt:at, approvedAt:null, voidedAt:null, ...patch });
const approve = (patch = {}) => ({ decision:'APPROVE', expectedVersion:1, planBasis:'MONTHLY', substitute:null, prize:null, ...patch });

test('reward contracts: complete closed terms, ordered ladder, paid-lifetime substitute only, no activation field', () => {
  assert.deepEqual(contracts.validateChampionsRewardPolicyDraftInput(terms()), terms());
  assert.deepEqual(contracts.validateChampionsRewardPolicyDraftInput(terms({ lifetimeCount:null, prizeBudgetMinor:null })), terms({ lifetimeCount:null }));
  for (const bad of [{ ...terms(), financialActivation:true }, { ...terms(), issueNow:true }, (({ prizeCount, ...rest }) => rest)(terms()), terms({ firstFreeMonthsCount:4 }),
    terms({ secondFreeMonthsTotal:5 }), terms({ prizeCount:10 }), terms({ lifetimeCount:20 }), terms({ paidLifetimeRule:'AS_EARNED' }), terms({ clawbackRule:'CLAW' }),
    terms({ referrerCreditMinor:100001 }), terms({ referrerCreditMinor:'10000' }), terms({ termsReference:' x' })])
    assert.throws(() => contracts.validateChampionsRewardPolicyDraftInput(bad));
  for (const ok of [approve(), approve({ planBasis:'PAID_LIFETIME', substitute:{ description:'Account credit', valueMinor:10000 } }), approve({ prize:{ kind:'EXPERIENCE', description:'Seminar trip', costMinor:90000 } }),
    { decision:'VOID', expectedVersion:2, reasonCode:'FRAUD_CONFIRMED' }, { decision:'RETAIN', expectedVersion:3 }])
    assert.deepEqual(contracts.validateChampionsRewardDecisionInput(ok), ok);
  for (const bad of [approve({ planBasis:'PAID_LIFETIME' }), approve({ planBasis:'WEEKLY' }), approve({ substitute:{ description:'x' } }), approve({ prize:{ kind:'CAR', description:'x', costMinor:1 } }),
    { decision:'FULFILL', expectedVersion:1 }, { decision:'ISSUE', expectedVersion:1 }, { decision:'VOID', expectedVersion:1, reasonCode:'BORED' }, { decision:'RETAIN', expectedVersion:1, note:'x' },
    approve({ expectedVersion:0 }), (({ prize, ...rest }) => rest)(approve())])
    assert.throws(() => contracts.validateChampionsRewardDecisionInput(bad));
  assert.equal(contracts.validateChampionsRewardStatusFilter(undefined), null);
  for (const bad of ['FULFILLED', 'accrued', ['ACCRUED']]) assert.throws(() => contracts.validateChampionsRewardStatusFilter(bad));
});

test('reward response contracts fail closed on activation, private fields or shape drift', () => {
  assert.doesNotThrow(() => contracts.validateChampionsRewardProgram({ published:policy({ status:'PUBLISHED', publishedAt:at }), drafts:[], financialActivation:'DISABLED' }));
  assert.throws(() => contracts.validateChampionsRewardProgram({ published:null, drafts:[], financialActivation:'ENABLED' }));
  assert.throws(() => contracts.validateChampionsRewardPolicyDraftReceipt({ policy:{ ...policy(), financialActivation:'ENABLED' }, replayed:false }));
  assert.doesNotThrow(() => contracts.validateChampionsRewardDecisionReceipt({ entry:entry(), replayed:false }));
  for (const bad of [entry({ status:'FULFILLED' }), entry({ aiAllowance:null }), entry({ rewardKind:'REFERRER_CREDIT', aiAllowance:'FULL_PLAN_ALLOWANCE' }), entry({ planBasis:'MONTHLY' }),
    entry({ status:'VOIDED' }), { ...entry(), paymentReference:'pi_123' }, entry({ prize:{ kind:'ELECTRONICS', description:'x', costMinor:1, sku:'1' } })])
    assert.throws(() => contracts.validateChampionsRewardDecisionReceipt({ entry:bad, replayed:false }));
  const liability = { status:'ACCRUED', rewardKind:'FREE_MONTHS', entries:2, creditMinor:0, freeMonths:12, prizeCostMinor:0, substituteValueMinor:0 };
  assert.doesNotThrow(() => contracts.validateChampionsRewardLedger({ entries:[entry()], limit:200, liabilities:[liability], currency:'USD', financialActivation:'DISABLED' }));
  assert.throws(() => contracts.validateChampionsRewardLedger({ entries:[], limit:200, liabilities:[{ ...liability, status:'VOIDED' }], currency:'USD', financialActivation:'DISABLED' }));
  const view = { schoolId:school, qualifiedReferrals:5, program:{ status:'PUBLISHED', policyVersion:1 }, nextMilestone:{ rewardKind:'FREE_MONTHS', milestoneCount:10, remaining:5 },
    rewards:[{ rewardKind:'FREE_MONTHS', beneficiaryRole:'REFERRER', milestoneCount:5, creditMinor:null, freeMonths:6, lifetimeTier:null, aiAllowance:'FULL_PLAN_ALLOWANCE', status:'ACCRUED', accruedAt:at }], financialActivation:'DISABLED' };
  assert.deepEqual(contracts.validateChampionsSchoolRewards(view), view);
  assert.throws(() => contracts.validateChampionsSchoolRewards({ ...view, rewards:[{ ...view.rewards[0], referredOrganizationId:org }] }));
  assert.throws(() => contracts.validateChampionsSchoolRewards({ ...view, rewards:[{ ...view.rewards[0], status:'VOIDED' }] }));
});

test('reward service validates before the database and maps reward refusals to fixed codes', async () => {
  const calls = [];
  const service = new ChampionsClubService({ callChampionsClub:async (...args) => { calls.push(args); return { entry:entry({ status:'APPROVED', version:2, planBasis:'MONTHLY', fulfillmentForm:'AS_EARNED', approvedAt:at }), replayed:false }; } });
  const key = randomUUID();
  await service.decideReward('verified-human', entryId.toUpperCase(), approve(), key);
  assert.deepEqual([calls[0][0], calls[0][1][0], calls[0][1][1], JSON.parse(calls[0][1][2]), calls[0][1][3]], ['decideReward', 'verified-human', entryId, approve(), key]);
  for (const work of [() => service.decideReward('s', entryId, { decision:'FULFILL', expectedVersion:1 }, key), () => service.reconcileRewards('s', 'x', key),
    () => service.createRewardPolicyDraft('s', terms({ lifetimeCount:20 }), key), () => service.readRewardLedger('s', 'FULFILLED'), () => service.publishRewardPolicy('s', policyId, undefined)])
    await assert.rejects(work, error => error.getStatus() === 400);
  assert.equal(calls.length, 1);
  for (const code of ['CHAMPIONS_REWARD_RULE_UNDECIDED','CHAMPIONS_REWARD_SUBSTITUTE_MISMATCH','CHAMPIONS_PRIZE_OVER_BUDGET','CHAMPIONS_CLAWBACK_NOT_PERMITTED','CHAMPIONS_POLICY_UNDECIDED']) {
    const failing = new ChampionsClubService({ callChampionsClub:async () => { throw Object.assign(new Error(code), { code:'23514' }); } });
    await assert.rejects(() => failing.decideReward('s', entryId, approve(), key), error => error.getStatus() === 422 && error.getResponse().code === code);
  }
  const drift = new ChampionsClubService({ callChampionsClub:async () => ({ entry:entry({ status:'FULFILLED' }), replayed:false }) });
  await assert.rejects(() => drift.decideReward('s', entryId, approve(), key), error => error.getStatus() === 503);
});

test('reward HTTP routes: exact command headers, status filter only, school view, no fulfillment route', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [];
  const responses = {
    readRewardProgram:{ published:null, drafts:[], financialActivation:'DISABLED' }, createRewardPolicyDraft:{ policy:policy(), replayed:false },
    publishRewardPolicy:{ policy:policy({ status:'PUBLISHED', publishedAt:at }), retiredPolicyId:null, replayed:false },
    reconcileRewards:{ schoolId:school, qualifiedCount:5, policyVersion:1, accrued:1, flaggedForReview:0, restored:0, entries:[entry()], financialActivation:'DISABLED', replayed:false },
    decideReward:{ entry:entry({ status:'VOIDED', version:2, voidReason:'FRAUD_CONFIRMED', voidedAt:at }), replayed:false },
    readRewardLedger:{ entries:[entry()], limit:200, liabilities:[], currency:'USD', financialActivation:'DISABLED' },
    readSchoolRewards:{ schoolId:school, qualifiedReferrals:0, program:{ status:'POLICY_UNDECIDED', policyVersion:null }, nextMilestone:null, rewards:[], financialActivation:'DISABLED' },
  };
  const module = await Test.createTestingModule({ controllers:[ChampionsSchoolController, ChampionsHqController], providers:[ChampionsClubService, ChampionsCommandGuard, ChampionsReadGuard,
    { provide:RuntimeDatabaseService, useValue:{ callChampionsClub:async (operation, params) => { calls.push([operation, params]); return responses[operation]; } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject:'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1`;
  const send = (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status:res.statusCode, headers:res.headers, body:chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const human = command => ({ 'content-type':'application/json', origin:'https://hon.example', 'x-hon-human-command':command, 'sec-fetch-site':'same-origin', 'sec-fetch-mode':'same-origin', 'sec-fetch-dest':'empty', 'idempotency-key':randomUUID() });
  try {
    for (const [path, operation] of [['/hq/champions/rewards/program','readRewardProgram'],['/hq/champions/rewards/ledger','readRewardLedger'],['/hq/champions/rewards/ledger?status=APPROVED','readRewardLedger'],[`/schools/${school}/champions/rewards`,'readSchoolRewards']]) {
      const response = await send('GET', path); assert.equal(response.status, 200, path); assert.match(response.headers['cache-control'], /no-store/); assert.deepEqual(response.body, { data:responses[operation] });
    }
    assert.deepEqual(calls.at(-2), ['readRewardLedger', ['verified-human', 'APPROVED']]);
    for (const path of ['/hq/champions/rewards/ledger?status=FULFILLED', `/hq/champions/rewards/ledger?schoolId=${school}`, '/hq/champions/rewards/program?status=ACCRUED', `/schools/${school}/champions/rewards?status=ACCRUED`])
      assert.equal((await send('GET', path)).status, 400, path);
    const commands = [
      ['/hq/champions/rewards/policy-drafts', 'champions-reward-policy-draft', terms(), 'createRewardPolicyDraft'],
      [`/hq/champions/rewards/policy-drafts/${policyId}/publish`, 'champions-reward-policy-publish', {}, 'publishRewardPolicy'],
      [`/hq/champions/rewards/schools/${school}/reconcile`, 'champions-rewards-reconcile', {}, 'reconcileRewards'],
      [`/hq/champions/rewards/entries/${entryId}/decisions`, 'champions-reward-decide', { decision:'VOID', expectedVersion:1, reasonCode:'FRAUD_CONFIRMED' }, 'decideReward'],
    ];
    for (const [path, command, body, operation] of commands) {
      const before = calls.length;
      const ok = await send('POST', path, { headers:human(command), body });
      assert.equal(ok.status, 200, path); assert.deepEqual(ok.body, { data:responses[operation] }); assert.equal(calls.at(-1)[0], operation);
      for (const extra of [{ origin:'https://attacker.example' }, { 'x-hon-human-command':'champions-attribution-decide' }, { 'sec-fetch-site':'cross-site' }, { 'x-hon-source':'AI' }])
        assert.equal((await send('POST', path, { headers:{ ...human(command), ...extra }, body })).status, 403, `${path} ${JSON.stringify(extra)}`);
      assert.equal((await send('POST', path + '?force=true', { headers:human(command), body })).status, 400);
      assert.equal(calls.length, before + 1, `${path}: refused requests never reach the database`);
    }
    assert.equal((await send('POST', `/hq/champions/rewards/schools/${school}/reconcile`, { headers:human('champions-rewards-reconcile'), body:{ qualifiedCount:30 } })).status, 400);
    for (const path of [`/hq/champions/rewards/entries/${entryId}/fulfill`, `/hq/champions/rewards/entries/${entryId}/issue`, `/schools/${school}/champions/rewards/claim`])
      assert.equal((await send('POST', path, { headers:human('champions-reward-decide'), body:{} })).status, 404, path);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
