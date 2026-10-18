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

const school = randomUUID(), other = randomUUID(), org = randomUUID();
const at = '2026-10-18T05:00:00.000Z';
const standing = (patch = {}) => ({ rank:1, position:1, schoolId:school, schoolName:'Fixture Dojo', organizationId:org, organizationName:'Fixture LLC', qualifiedReferrals:5, pendingReferrals:2, reachedAt:at, displayMode:'ANONYMOUS', ...patch });
const hqBoard = (patch = {}) => ({ period:'ALL_TIME', month:null, standings:[standing()], totalRanked:1, limit:100, held:[], countsOnly:'QUALIFIED', timeZone:'UTC', ...patch });
const schoolBoard = (patch = {}) => ({ period:'ALL_TIME', month:null, standings:[{ rank:1, displayName:null, anonymous:true, qualifiedReferrals:6, isYou:false }, { rank:2, displayName:'Fixture Dojo', anonymous:false, qualifiedReferrals:5, isYou:true }],
  limit:25, you:{ schoolId:school, status:'RANKED', rank:2, qualifiedReferrals:5, displayMode:'ANONYMOUS' }, countsOnly:'QUALIFIED', timeZone:'UTC', ...patch });
const months = Array.from({ length:12 }, (_, i) => ({ month:`2025-${String(i + 1).padStart(2, '0')}`, qualified:i === 11 ? 3 : 0 }));
const stats = (patch = {}) => ({ schoolId:school, referrals:{ pending:2, qualified:5, rejected:1, refunded:0, reversed:0 }, monthlyQualified:months,
  milestones:{ program:{ status:'PUBLISHED', policyVersion:1 }, reached:[{ rewardKind:'FREE_MONTHS', milestoneCount:5 }], nextMilestone:{ rewardKind:'FREE_MONTHS', milestoneCount:10, remaining:5 }, qualifiedReferrals:5 },
  allTimeRank:2, history:[{ occurredAt:at, fromState:'PENDING', toState:'QUALIFIED', reason:'QUALIFICATION_VERIFIED' }], historyLimit:50, displayMode:'ANONYMOUS', ...patch });

test('leaderboard query and command contracts are closed', () => {
  assert.deepEqual(contracts.validateChampionsLeaderboardQuery({}), { period:'ALL_TIME', month:null });
  assert.deepEqual(contracts.validateChampionsLeaderboardQuery(undefined), { period:'ALL_TIME', month:null });
  assert.deepEqual(contracts.validateChampionsLeaderboardQuery({ period:'MONTH', month:'2026-10' }), { period:'MONTH', month:'2026-10' });
  for (const bad of [{ period:'MONTH' }, { period:'ALL_TIME', month:'2026-10' }, { period:'WEEK' }, { period:'MONTH', month:'2026-13' }, { period:'MONTH', month:['2026-10'] }, { schoolId:school }, { includePending:'true' }])
    assert.throws(() => contracts.validateChampionsLeaderboardQuery(bad));
  assert.deepEqual(contracts.validateChampionsHoldInput({ action:'PLACE', schoolId:school.toUpperCase(), reasonCode:'FRAUD_REVIEW' }), { action:'PLACE', schoolId:school, reasonCode:'FRAUD_REVIEW' });
  for (const bad of [{ action:'PLACE', schoolId:school }, { action:'RELEASE', schoolId:school, reasonCode:'FRAUD_REVIEW' }, { action:'DELETE', schoolId:school }, { action:'PLACE', schoolId:'x', reasonCode:'FRAUD_REVIEW' }])
    assert.throws(() => contracts.validateChampionsHoldInput(bad));
  assert.deepEqual(contracts.validateChampionsPreferenceInput({ displayMode:'SCHOOL_NAME' }), { displayMode:'SCHOOL_NAME' });
  for (const bad of [{ displayMode:'CUSTOM' }, { displayMode:'SCHOOL_NAME', displayName:'Best Dojo' }, {}]) assert.throws(() => contracts.validateChampionsPreferenceInput(bad));
});

test('leaderboard responses enforce ordering, privacy and qualified-only counts', () => {
  assert.doesNotThrow(() => contracts.validateChampionsHqLeaderboard(hqBoard({ standings:[standing(), standing({ position:2, schoolId:other, qualifiedReferrals:5 }), standing({ position:3, rank:3, schoolId:randomUUID(), qualifiedReferrals:3 })], totalRanked:3 })));
  for (const bad of [hqBoard({ countsOnly:'ALL' }), hqBoard({ standings:[standing({ qualifiedReferrals:0 })] }), hqBoard({ standings:[standing({ position:2 })] }),
    hqBoard({ standings:[standing(), standing({ position:2, rank:2, qualifiedReferrals:5 })] }), hqBoard({ standings:[standing(), standing({ position:2, rank:1, qualifiedReferrals:6 })] }),
    hqBoard({ standings:[{ ...standing(), ownerEmail:'x@example.test' }] }), hqBoard({ timeZone:'America/New_York' })])
    assert.throws(() => contracts.validateChampionsHqLeaderboard(bad));
  assert.doesNotThrow(() => contracts.validateChampionsSchoolLeaderboard(schoolBoard()));
  for (const bad of [schoolBoard({ standings:[{ rank:1, displayName:'Hidden Dojo', anonymous:true, qualifiedReferrals:6, isYou:false }] }),
    schoolBoard({ standings:[{ rank:1, displayName:null, anonymous:true, qualifiedReferrals:6, isYou:false, schoolId:other }] }),
    schoolBoard({ standings:[{ rank:1, displayName:null, anonymous:true, qualifiedReferrals:6, isYou:false, pendingReferrals:3 }] }),
    schoolBoard({ you:{ schoolId:school, status:'NOT_RANKED', rank:2, qualifiedReferrals:5, displayMode:'ANONYMOUS' } }),
    schoolBoard({ you:{ schoolId:school, status:'HELD', rank:null, qualifiedReferrals:5, displayMode:'ANONYMOUS' } })])
    assert.throws(() => contracts.validateChampionsSchoolLeaderboard(bad));
  assert.deepEqual(contracts.validateChampionsSchoolStatistics(stats()), stats());
  for (const bad of [stats({ monthlyQualified:months.slice(1) }), stats({ history:[{ ...stats().history[0], referredOrganizationId:org }] }), { ...stats(), hold:null },
    stats({ milestones:{ ...stats().milestones, qualifiedReferrals:6 } })])
    assert.throws(() => contracts.validateChampionsSchoolStatistics(bad));
  const hqStats = { ...stats({ history:[{ ...stats().history[0], attributionId:randomUUID(), referredOrganizationId:org, referredOrganizationName:'Referred Dojo' }] }), schoolName:'Fixture Dojo', organizationId:org, hold:{ reasonCode:'FRAUD_REVIEW', placedAt:at } };
  assert.deepEqual(contracts.validateChampionsHqSchoolStatistics(hqStats), hqStats);
});

test('leaderboard routes: allowed selectors only, exact command headers, refusals never reach the database', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [];
  const responses = { readHqLeaderboard:hqBoard(), readHqSchoolStatistics:{ ...stats({ history:[] }), schoolName:'Fixture Dojo', organizationId:org, hold:null },
    setLeaderboardHold:{ schoolId:school, status:'ACTIVE', reasonCode:'FRAUD_REVIEW', placedAt:at, releasedAt:null, replayed:false },
    readSchoolLeaderboard:schoolBoard(), readSchoolStatistics:stats(), setLeaderboardPreference:{ schoolId:school, displayMode:'SCHOOL_NAME', version:1, updatedAt:at, replayed:false } };
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
    for (const [path, operation, params] of [['/hq/champions/leaderboard','readHqLeaderboard',['verified-human','ALL_TIME',null]],['/hq/champions/leaderboard?period=MONTH&month=2026-10','readHqLeaderboard',['verified-human','MONTH','2026-10']],
      [`/hq/champions/schools/${school}/statistics`,'readHqSchoolStatistics',['verified-human',school]],[`/schools/${school}/champions/leaderboard?period=MONTH&month=2026-09`,'readSchoolLeaderboard',['verified-human',school,'MONTH','2026-09']],
      [`/schools/${school}/champions/statistics`,'readSchoolStatistics',['verified-human',school]]]) {
      const response = await send('GET', path); assert.equal(response.status, 200, path); assert.match(response.headers['cache-control'], /no-store/);
      assert.deepEqual(response.body, { data:responses[operation] }); assert.deepEqual(calls.at(-1), [operation, params]);
    }
    const reads = calls.length;
    for (const path of ['/hq/champions/leaderboard?period=MONTH', '/hq/champions/leaderboard?includePending=true', `/hq/champions/leaderboard?schoolId=${school}`, '/hq/champions/leaderboard?period=MONTH&month=2026-10&month=2026-09',
      `/hq/champions/schools/${school}/statistics?period=MONTH`, `/schools/${school}/champions/statistics?schoolId=${other}`, `/schools/${school}/champions/leaderboard?period=ALL_TIME&month=2026-10`, '/hq/champions/schools/x/statistics'])
      assert.equal((await send('GET', path)).status, 400, path);
    assert.equal(calls.length, reads);
    for (const [path, command, body, operation] of [['/hq/champions/leaderboard/holds', 'champions-leaderboard-hold', { action:'PLACE', schoolId:school, reasonCode:'FRAUD_REVIEW' }, 'setLeaderboardHold'],
      [`/schools/${school}/champions/leaderboard-preference`, 'champions-leaderboard-preference', { displayMode:'SCHOOL_NAME' }, 'setLeaderboardPreference']]) {
      const before = calls.length;
      const ok = await send('POST', path, { headers:human(command), body }); assert.equal(ok.status, 200, path); assert.deepEqual(ok.body, { data:responses[operation] });
      for (const extra of [{ origin:'https://attacker.example' }, { 'x-hon-human-command':'champions-reward-decide' }, { 'sec-fetch-mode':'cors' }, { 'content-type':'text/plain' }])
        assert.equal((await send('POST', path, { headers:{ ...human(command), ...extra }, body })).status, 403, `${path} ${JSON.stringify(extra)}`);
      assert.equal((await send('POST', path, { headers:{ ...human(command), 'idempotency-key':'nope' }, body })).status, 400);
      assert.equal(calls.length, before + 1);
    }
    assert.equal((await send('POST', '/hq/champions/leaderboard/holds', { headers:human('champions-leaderboard-hold'), body:{ action:'PLACE', schoolId:school, reasonCode:'FRAUD_REVIEW', qualifiedCount:0 } })).status, 400);
    assert.equal((await send('POST', `/hq/champions/leaderboard`, { headers:human('champions-leaderboard-hold'), body:{} })).status, 404, 'Standings are computed, never written.');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
