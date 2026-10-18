const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ChampionsHqController } = require('../dist/champions/champions-club.controller.js');
const { ChampionsClubService } = require('../dist/champions/champions-club.service.js');
const { ChampionsCommandGuard, ChampionsReadGuard } = require('../dist/champions/champions-club.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const overview = (patch = {}) => ({ program:{ status:'PUBLISHED', policyVersion:1, paymentVerificationSource:'HQ_OWNER_ATTESTATION' }, rewardProgram:{ status:'POLICY_UNDECIDED', policyVersion:null, clawbackRule:null },
  referralCodes:{ active:3, schoolsWithCode:3 }, attributions:{ pending:1, qualified:2, rejected:0, refunded:0, reversed:1 }, rankedSchools:2, leaderboardHolds:0,
  rewardLiabilities:{ entries:4, creditMinor:40000, freeMonths:0, prizes:0, lifetimeMemberships:0, inReview:1, approved:0 },
  contests:{ draft:1, scheduled:0, active:1, paused:0, ended:0, pendingWinnerApproval:0, completed:0, cancelled:0, startDue:0, endDue:1 },
  contestLiabilities:{ pendingWinnerCostMinor:0, approvedWinnerCostMinor:0 }, currency:'USD', financialActivation:'DISABLED', automaticTransitions:'NOT_CONFIGURED', ...patch });

test('overview contract: aggregates only, activation pinned disabled, undecided policies carry no values', () => {
  assert.deepEqual(contracts.validateChampionsOverview(overview()), overview());
  for (const bad of [overview({ financialActivation:'ENABLED' }), overview({ automaticTransitions:'CRON' }), overview({ rankedSchools:-1 }),
    overview({ rewardProgram:{ status:'POLICY_UNDECIDED', policyVersion:2, clawbackRule:null } }), overview({ program:{ status:'PUBLISHED', policyVersion:1, paymentVerificationSource:null } }),
    { ...overview(), topSchools:[{ name:'Private Dojo' }] }, overview({ attributions:{ pending:1, qualified:2, rejected:0, refunded:0, reversed:1, fraud:0 } })])
    assert.throws(() => contracts.validateChampionsOverview(bad));
});

test('GET /v1/hq/champions/overview: identity only, no selectors, no-store', async () => {
  const calls = [];
  const module = await Test.createTestingModule({ controllers:[ChampionsHqController], providers:[ChampionsClubService, ChampionsCommandGuard, ChampionsReadGuard,
    { provide:RuntimeDatabaseService, useValue:{ callChampionsClub:async (operation, params) => { calls.push([operation, params]); return overview(); } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject:'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/champions/overview`;
  try {
    const ok = await fetch(base); assert.equal(ok.status, 200); assert.match(ok.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await ok.json(), { data:overview() }); assert.deepEqual(calls, [['readOverview', ['verified-human']]]);
    assert.equal((await fetch(base + '?schoolId=x')).status, 400);
    assert.equal((await fetch(base, { method:'POST', headers:{ 'content-type':'application/json' }, body:'{}' })).status, 404);
    assert.equal(calls.length, 1);
  } finally { await app.close(); }
});
