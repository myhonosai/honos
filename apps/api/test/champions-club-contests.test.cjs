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

const contestId = randomUUID(), school = randomUUID(), winnerId = randomUUID(), prizeId = randomUUID();
const at = '2026-10-18T05:00:00.000Z', later = '2026-11-18T05:00:00.000Z';
const config = (patch = {}) => ({ name:'Fall Referral Cup', description:'Fixture contest.', termsReference:'Terms v1', startsAt:at, endsAt:later, countBasis:'CAPTURED_AND_QUALIFIED_IN_WINDOW',
  minimumQualified:1, tieRule:'OWNER_RESOLVES', eligibility:{ scope:'ALL_ACTIVE_SCHOOLS', tiers:['CORE','COMPLETE'], schoolIds:[] }, budgetMinor:120000, giftCardCompliance:'UNDECIDED',
  prizes:[{ placeFrom:1, placeTo:1, kind:'ELECTRONICS', description:'Tablet', quantity:1, estimatedUnitCostMinor:50000 }], ...patch });
const contest = (patch = {}) => { const { prizes, ...rest } = config(); return { contestId, ...rest, status:'DRAFT', version:1, currency:'USD', schoolVisibility:'HIDDEN', publicListing:'DISABLED',
  financialActivation:'DISABLED', automaticTransitions:'NOT_CONFIGURED', prizes:prizes.map(p => ({ prizeId, ...p })), estimatedPrizeCostMinor:50000, due:'NONE', duplicatedFrom:null,
  createdAt:at, scheduledAt:null, activatedAt:null, endedAt:null, completedAt:null, cancelledAt:null, cancelReason:null, ...patch }; };

test('contest command contracts: one closed shape per action, valid windows and non-overlapping prizes', () => {
  assert.deepEqual(contracts.validateChampionsContestCommand({ action:'CREATE', ...config() }), { action:'CREATE', ...config() });
  for (const ok of [{ action:'SCHEDULE', expectedVersion:3, schoolVisibility:'ELIGIBLE_SCHOOLS' }, { action:'PAUSE', expectedVersion:2 }, { action:'CANCEL', expectedVersion:1, reasonCode:'LEGAL_REVIEW' },
    { action:'DUPLICATE', name:'Winter Cup', startsAt:at, endsAt:later }, { action:'RESOLVE_WINNER', expectedVersion:9, winnerId, schoolId:school },
    { action:'REJECT_WINNER', expectedVersion:9, winnerId, reasonCode:'FRAUD_CONFIRMED' }, { action:'DISPUTE_WINNER', expectedVersion:9, winnerId, reasonCode:'DISPUTE_RAISED' }])
    assert.deepEqual(contracts.validateChampionsContestCommand(ok), ok);
  for (const bad of [{ action:'CREATE', ...config(), financialActivation:true }, { action:'CREATE', ...config({ endsAt:at }) }, { action:'CREATE', ...config({ endsAt:'2027-12-01T00:00:00.000Z' }) },
    { action:'CREATE', ...config({ prizes:[{ placeFrom:1, placeTo:2, kind:'ELECTRONICS', description:'a', quantity:1, estimatedUnitCostMinor:1 }, { placeFrom:2, placeTo:3, kind:'ELECTRONICS', description:'b', quantity:1, estimatedUnitCostMinor:1 }] }) },
    { action:'CREATE', ...config({ prizes:[{ placeFrom:1, placeTo:1, kind:'CASH', description:'a', quantity:1, estimatedUnitCostMinor:1 }] }) },
    { action:'CREATE', ...config({ eligibility:{ scope:'SELECTED_SCHOOLS', tiers:['CORE'], schoolIds:[] } }) }, { action:'CREATE', ...config({ eligibility:{ scope:'ALL_ACTIVE_SCHOOLS', tiers:['CORE','CORE'], schoolIds:[] } }) },
    { action:'SCHEDULE', expectedVersion:1, schoolVisibility:'PUBLIC' }, { action:'SCHEDULE', expectedVersion:1 }, { action:'PAUSE', expectedVersion:0 }, { action:'PUBLISH', expectedVersion:1 },
    { action:'FULFILL_PRIZE', expectedVersion:1, winnerId }, { action:'APPROVE_WINNER', expectedVersion:1, winnerId:'x' }, { action:'REJECT_WINNER', expectedVersion:1, winnerId, reasonCode:'BORED' }])
    assert.throws(() => contracts.validateChampionsContestCommand(bad));
  assert.equal(contracts.validateChampionsContestStatusFilter(undefined), null);
  assert.throws(() => contracts.validateChampionsContestStatusFilter('LIVE'));
});

test('contest response contracts pin disabled public listing, financial activation and automatic transitions', () => {
  assert.doesNotThrow(() => contracts.validateChampionsContestReceipt({ contest:contest(), action:'CREATE', replayed:false }));
  for (const bad of [contest({ publicListing:'ENABLED' }), contest({ financialActivation:'ENABLED' }), contest({ automaticTransitions:'CRON' }), contest({ status:'LIVE' }), { ...contest(), secretNote:'x' }])
    assert.throws(() => contracts.validateChampionsContestReceipt({ contest:bad, action:'CREATE', replayed:false }));
  const detail = { contest:contest({ status:'PENDING_WINNER_APPROVAL' }), standings:[{ schoolId:school, schoolName:'Dojo', organizationId:randomUUID(), qualifiedReferrals:4, reachedAt:at, eligible:true, ineligibleReason:null, rank:1, position:1 },
    { schoolId:randomUUID(), schoolName:'Held Dojo', organizationId:randomUUID(), qualifiedReferrals:5, reachedAt:at, eligible:false, ineligibleReason:'LEADERBOARD_HOLD', rank:null, position:null }],
    standingsFrozen:true, pauses:[{ pausedAt:at, resumedAt:later }], winners:[{ winnerId, place:1, prizeId, schoolId:school, schoolName:'Dojo', status:'PROPOSED', reasonCode:null, estimatedCostMinor:50000, version:1, decidedAt:null }],
    liabilities:{ currency:'USD', budgetMinor:120000, estimatedPrizeCostMinor:50000, pendingWinnerCostMinor:50000, approvedWinnerCostMinor:0, financialActivation:'DISABLED' },
    history:[{ action:'CREATE', fromStatus:'NONE', toStatus:'DRAFT', contestVersion:1, detail:{}, occurredAt:at }], countsOnly:'QUALIFIED' };
  assert.deepEqual(contracts.validateChampionsContestDetail(detail), detail);
  for (const bad of [{ ...detail, standings:[{ ...detail.standings[1], rank:1 }] }, { ...detail, standings:[{ ...detail.standings[0], ineligibleReason:'LEADERBOARD_HOLD' }] },
    { ...detail, winners:[{ ...detail.winners[0], status:'FULFILLED' }] }, { ...detail, liabilities:{ ...detail.liabilities, financialActivation:'ENABLED' } }, { ...detail, countsOnly:'ALL' }])
    assert.throws(() => contracts.validateChampionsContestDetail(bad));
  const view = { schoolId:school, contests:[{ contestId, name:'Fall Referral Cup', description:'x', termsReference:null, status:'ACTIVE', startsAt:at, endsAt:later, minimumQualified:1,
    prizes:[{ placeFrom:1, placeTo:1, kind:'ELECTRONICS', description:'Tablet', quantity:1 }], standings:[{ rank:1, displayName:null, anonymous:true, qualifiedReferrals:5, isYou:false }],
    you:{ qualifiedReferrals:3, status:'RANKED', rank:2 }, won:false }], countsOnly:'QUALIFIED' };
  assert.deepEqual(contracts.validateChampionsSchoolContests(view), view);
  for (const bad of [{ ...view.contests[0], status:'DRAFT' }, { ...view.contests[0], prizes:[{ ...view.contests[0].prizes[0], estimatedUnitCostMinor:50000 }] },
    { ...view.contests[0], standings:[{ ...view.contests[0].standings[0], schoolId:school }] }, { ...view.contests[0], you:{ qualifiedReferrals:3, status:'NOT_RANKED', rank:2 } }])
    assert.throws(() => contracts.validateChampionsSchoolContests({ ...view, contests:[bad] }));
});

test('contest service: CREATE targets no contest, every other action exactly one; refusals map to fixed codes', async () => {
  const calls = [];
  const service = new ChampionsClubService({ callChampionsClub:async (...args) => { calls.push(args); return { contest:contest(), action:'CREATE', replayed:false }; } });
  const key = randomUUID();
  await service.commandContest('verified-human', undefined, { action:'CREATE', ...config() }, key);
  assert.deepEqual([calls[0][0], calls[0][1][0], calls[0][1][1], calls[0][1][3]], ['commandContest', 'verified-human', null, key]);
  for (const work of [() => service.commandContest('s', contestId, { action:'CREATE', ...config() }, key), () => service.commandContest('s', undefined, { action:'PAUSE', expectedVersion:1 }, key),
    () => service.commandContest('s', 'x', { action:'PAUSE', expectedVersion:1 }, key), () => service.readContests('s', 'LIVE'), () => service.readContest('s', 'x'), () => service.readSchoolContests('s', 'x')])
    await assert.rejects(work, error => error.getStatus() === 400);
  assert.equal(calls.length, 1);
  for (const code of ['CHAMPIONS_CONTEST_INCOMPLETE','CHAMPIONS_CONTEST_OVER_BUDGET','CHAMPIONS_GIFT_CARDS_NOT_PERMITTED','CHAMPIONS_CONTEST_NOT_STARTED','CHAMPIONS_CONTEST_WINDOW_PASSED',
    'CHAMPIONS_CONTEST_WINNER_NOT_ELIGIBLE','CHAMPIONS_CONTEST_WINNERS_UNRESOLVED','CHAMPIONS_CONTEST_PRIZES_OVERLAP']) {
    const failing = new ChampionsClubService({ callChampionsClub:async () => { throw Object.assign(new Error(code), { code:'23514' }); } });
    await assert.rejects(() => failing.commandContest('s', contestId, { action:'SCHEDULE', expectedVersion:1, schoolVisibility:'HIDDEN' }, key), error => error.getStatus() === 422 && error.getResponse().code === code);
  }
});

test('contest HTTP routes: exact command header, status filter only, no publish or fulfillment route', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [];
  const responses = { commandContest:{ contest:contest(), action:'CREATE', replayed:false }, readContests:{ contests:[contest()], limit:100 },
    readContest:{ contest:contest(), standings:[], standingsFrozen:false, pauses:[], winners:[], liabilities:{ currency:'USD', budgetMinor:120000, estimatedPrizeCostMinor:50000, pendingWinnerCostMinor:0, approvedWinnerCostMinor:0, financialActivation:'DISABLED' }, history:[], countsOnly:'QUALIFIED' },
    readSchoolContests:{ schoolId:school, contests:[], countsOnly:'QUALIFIED' } };
  const module = await Test.createTestingModule({ controllers:[ChampionsSchoolController, ChampionsHqController], providers:[ChampionsClubService, ChampionsCommandGuard, ChampionsReadGuard,
    { provide:RuntimeDatabaseService, useValue:{ callChampionsClub:async (operation, params) => { calls.push([operation, params]); return responses[operation]; } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject:'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1`;
  const send = (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status:res.statusCode, headers:res.headers, body:chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const human = () => ({ 'content-type':'application/json', origin:'https://hon.example', 'x-hon-human-command':'champions-contest-command', 'sec-fetch-site':'same-origin', 'sec-fetch-mode':'same-origin', 'sec-fetch-dest':'empty', 'idempotency-key':randomUUID() });
  try {
    for (const [path, operation, params] of [['/hq/champions/contests','readContests',['verified-human',null]],['/hq/champions/contests?status=ACTIVE','readContests',['verified-human','ACTIVE']],
      [`/hq/champions/contests/${contestId}`,'readContest',['verified-human',contestId]],[`/schools/${school}/champions/contests`,'readSchoolContests',['verified-human',school]]]) {
      const r = await send('GET', path); assert.equal(r.status, 200, path); assert.match(r.headers['cache-control'], /no-store/); assert.deepEqual(r.body, { data:responses[operation] }); assert.deepEqual(calls.at(-1), [operation, params]);
    }
    for (const path of ['/hq/champions/contests?status=LIVE', `/hq/champions/contests/${contestId}?status=ACTIVE`, `/schools/${school}/champions/contests?status=ACTIVE`, '/hq/champions/contests/x'])
      assert.equal((await send('GET', path)).status, 400, path);
    const before = calls.length;
    assert.equal((await send('POST', '/hq/champions/contests', { headers:human(), body:{ action:'CREATE', ...config() } })).status, 200);
    assert.equal((await send('POST', `/hq/champions/contests/${contestId}/commands`, { headers:human(), body:{ action:'PAUSE', expectedVersion:2 } })).status, 200);
    assert.deepEqual(calls.at(-1)[1].slice(0, 2), ['verified-human', contestId]);
    for (const extra of [{ origin:'https://attacker.example' }, { 'x-hon-human-command':'champions-reward-decide' }, { 'sec-fetch-site':'cross-site' }, { 'x-hon-delegated-by':'ai' }])
      assert.equal((await send('POST', `/hq/champions/contests/${contestId}/commands`, { headers:{ ...human(), ...extra }, body:{ action:'PAUSE', expectedVersion:2 } })).status, 403, JSON.stringify(extra));
    assert.equal((await send('POST', '/hq/champions/contests', { headers:human(), body:{ action:'PAUSE', expectedVersion:2 } })).status, 400);
    assert.equal((await send('POST', `/hq/champions/contests/${contestId}/commands`, { headers:human(), body:{ action:'CREATE', ...config() } })).status, 400);
    assert.equal((await send('POST', `/hq/champions/contests/${contestId}/commands?force=1`, { headers:human(), body:{ action:'PAUSE', expectedVersion:2 } })).status, 400);
    assert.equal(calls.length, before + 2);
    for (const path of [`/hq/champions/contests/${contestId}/publish`, `/hq/champions/contests/${contestId}/fulfill`, `/schools/${school}/champions/contests/${contestId}/enter`])
      assert.equal((await send('POST', path, { headers:human(), body:{} })).status, 404, path);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
