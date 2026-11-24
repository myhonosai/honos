const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { ParentReferralsService, translateParentReferralsError } = require('../dist/referrals/parent-referrals.service.js');
const { SchoolReferralsService, translateSchoolReferralsError } = require('../dist/referrals/school-referrals.service.js');
const { PublicReferralService } = require('../dist/referrals/public-referral.controller.js');
const { publicReferralTransport } = require('../dist/referrals/public-referral-transport.js');

// 0604 family referrals: closed projections, a share link built only from a configured origin, refusals before any database
// call, and a strict public transport.
const record = (patch = {}) => ({ schoolName: 'Dojo', on: true, referrerReward: 'One free month', friendOffer: 'Free week', rules: 'After joining.\nOne per friend.',
  shareMessage: 'Come train!', code: '0123456789abcdef', canShare: true, counts: { referred: 1, joined: 0, rewarded: 0 },
  referrals: [{ referredAt: '2026-11-20T18:00:00.123456+00:00', status: 'INTERESTED', reward: 'PENDING' }], ...patch });
const off = { schoolName: 'Dojo', on: false, referrerReward: null, friendOffer: null, rules: null, shareMessage: null, code: null, canShare: false, counts: { referred: 0, joined: 0, rewarded: 0 }, referrals: [] };

test('0604 family record is verified exactly', () => {
  assert.deepEqual(contracts.verifyParentReferralsRecord(record()), record());
  assert.deepEqual(contracts.verifyParentReferralsRecord(off), off);
  for (const [label, bad] of [
    ['friend name', record({ referrals: [{ referredAt: '2026-11-20T18:00:00Z', status: 'JOINED', reward: 'GIVEN', friendName: 'X' }] })],
    ['code while off', { ...off, code: '0123456789abcdef' }],
    ['texts while off', { ...off, referrerReward: 'x' }],
    ['share while off', { ...off, canShare: true }],
    ['bad code', record({ code: 'ABC' })],
    ['empty reward', record({ referrerReward: ' ' })],
    ['joined above referred', record({ counts: { referred: 1, joined: 2, rewarded: 0 } })],
    ['more rows than referred', record({ counts: { referred: 0, joined: 0, rewarded: 0 } })],
    ['status', record({ referrals: [{ referredAt: '2026-11-20T18:00:00Z', status: 'WON', reward: 'PENDING' }] })],
    ['extra key', { ...record(), familyId: 'x' }],
    ['control char', record({ shareMessage: 'a\u0007b' })],
    ['viewer with code', record({ canShare: false })],
  ]) assert.throws(() => contracts.verifyParentReferralsRecord(bad), undefined, label);
});

test('0604 share link is the HON origin plus /refer/<code> only', () => {
  assert.equal(contracts.familyReferralShareUrl('https://app.hon.example', '0123456789abcdef'), 'https://app.hon.example/refer/0123456789abcdef');
  assert.equal(contracts.familyReferralShareUrl('http://localhost:3000', '0123456789abcdef'), 'http://localhost:3000/refer/0123456789abcdef');
  for (const [origin, code] of [['http://evil.example', '0123456789abcdef'], ['https://a.example/path', '0123456789abcdef'], ['https://a.example', '../x'], ['javascript:alert(1)', '0123456789abcdef']]) {
    assert.throws(() => contracts.familyReferralShareUrl(origin, code));
  }
  assert.throws(() => contracts.verifyParentReferralLink({ shareUrl: 'https://a.example/refer/0123456789abcdef?x=1' }));
});

test('0604 family service builds the link from the configured origin, never the bare code', async () => {
  const database = {
    resolveParentJourneyScopes: async () => [{ organizationId: 'o', schoolId: 's', principalId: 'p' }],
    withTenantReadOnlyTransaction: async (_c, work) => work({ query: async (sql) => (/read_parent_referrals/.test(sql) ? { rows: [{ data: record() }] } : { rows: [] }) }),
    withTenantTransaction: async (_c, work) => work({ query: async (sql) => (/issue_parent_referral_link/.test(sql) ? { rows: [{ data: { code: '0123456789abcdef' } }] } : { rows: [] }) }),
  };
  const service = new ParentReferralsService(database);
  const saved = process.env.HON_PUBLIC_ORIGIN;
  try {
    process.env.HON_PUBLIC_ORIGIN = 'https://app.hon.example';
    const view = await service.read('subject-1');
    assert.equal(view.shareUrl, 'https://app.hon.example/refer/0123456789abcdef');
    assert.equal('code' in view, false);
    assert.deepEqual(await service.link('subject-1'), { shareUrl: 'https://app.hon.example/refer/0123456789abcdef' });
    delete process.env.HON_PUBLIC_ORIGIN;
    assert.equal((await service.read('subject-1')).shareUrl, null);
    await assert.rejects(() => service.link('subject-1'), (e) => e.response.code === 'PARENT_REFERRALS_NOT_CONFIGURED');
  } finally { if (saved === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = saved; }
});

test('0604 services refuse before any database call and map errors to closed codes', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const parent = new ParentReferralsService(database);
  await assert.rejects(() => parent.read(''), (e) => e.response.code === 'PARENT_REFERRALS_FORBIDDEN');
  await assert.rejects(() => parent.read(' x'), (e) => e.response.code === 'PARENT_REFERRALS_FORBIDDEN');
  const school = new SchoolReferralsService(database);
  const ctx = { organizationId: 'o', schoolId: 's', principalId: 'p', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: 'r', correlationId: 'r', idempotencyKey: 'k'.repeat(20), externalSubject: 'x' };
  await assert.rejects(() => school.read({ ...ctx, source: 'AI_AGENT' }), (e) => e.response.code === 'SCHOOL_REFERRAL_FORBIDDEN');
  await assert.rejects(() => school.configure({ ...ctx, idempotencyKey: '' }, {}), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => school.configure(ctx, { status: 'ON' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => school.reward(ctx, 'not-a-uuid', { expectedVersion: 1, decision: 'GIVEN', note: '' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => school.reward(ctx, '00000000-0000-4000-8000-000000000001', { expectedVersion: 1, decision: 'PAID', note: '' }), (e) => e.response.code === 'VALIDATION_FAILED');
  const pub = new PublicReferralService(database);
  assert.equal(await pub.read('XYZ'), null);
  assert.equal(await pub.submit('0123456789abcdef', { name: 'A' }, 'short'), 'invalid');
  assert.equal(calls, 0);
  const parentCode = (sqlState, message = 'x') => { try { translateParentReferralsError(Object.assign(new Error(message), { code: sqlState })); } catch (e) { return [e.getStatus(), e.response.code]; } };
  assert.deepEqual(parentCode('42501'), [403, 'PARENT_REFERRALS_FORBIDDEN']);
  assert.deepEqual(parentCode('22023', 'REFERRALS_NOT_AVAILABLE'), [422, 'PARENT_REFERRALS_NOT_AVAILABLE']);
  assert.deepEqual(parentCode('08006'), [503, 'PARENT_REFERRALS_UNAVAILABLE']);
  const schoolCode = (sqlState, message = 'x') => { try { translateSchoolReferralsError(Object.assign(new Error(message), { code: sqlState })); } catch (e) { return [e.getStatus(), e.response.code]; } };
  assert.deepEqual(schoolCode('40001', 'VERSION_CONFLICT'), [409, 'VERSION_CONFLICT']);
  assert.deepEqual(schoolCode('22023', 'REFERRAL_FORM_UNAVAILABLE'), [422, 'REFERRAL_FORM_UNAVAILABLE']);
  assert.deepEqual(schoolCode('22023', 'SOMETHING_ELSE'), [400, 'VALIDATION_FAILED']);
  assert.deepEqual(schoolCode('XX000'), [503, 'SCHOOL_REFERRAL_UNAVAILABLE']);
});

test('0604 public submission never leaks database detail', async () => {
  const failing = new PublicReferralService({ runPublicEventCall: async () => { throw Object.assign(new Error('boom detail kim@example.test'), { code: 'XX000' }); } });
  const body = { name: 'Friend', email: 'f@example.test', mobile: '', interest: '', source: '', website: '', acknowledged: true };
  assert.equal(await failing.submit('0123456789abcdef', body, 'k'.repeat(20)), 'unavailable');
  const seen = [];
  const ok = new PublicReferralService({ runPublicEventCall: async (statement, values) => { seen.push([statement, values]); return 'ACCEPTED'; } });
  assert.equal(await ok.submit('0123456789abcdef', body, 'k'.repeat(20)), 'accepted');
  assert.equal(seen[0][0], 'SELECT hon.submit_family_referral($1,$2::jsonb,$3) AS data');
});

test('0604 public transport admits only canonical paths', () => {
  const transport = publicReferralTransport({ admit: () => 0 });
  const run = (method, path, headers = {}, originalUrl = path) => {
    const res = { code: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json() { return this; } };
    let passed = false;
    transport({ method, path, originalUrl, headers }, res, () => { passed = true; });
    return passed ? 'next' : res.code;
  };
  assert.equal(run('GET', '/v1/other'), 'next');
  assert.equal(run('GET', '/v1/public/referrals/0123456789abcdef'), 'next');
  assert.equal(run('GET', '/v1/public/referrals/0123456789ABCDEF'), 400);
  assert.equal(run('GET', '/v1/public/referrals/0123456789abcdef', {}, '/v1/public/referrals/0123456789abcdef?x=1'), 400);
  assert.equal(run('DELETE', '/v1/public/referrals/0123456789abcdef'), 400);
  assert.equal(run('POST', '/v1/public/referrals/0123456789abcdef/submissions', { 'content-type': 'text/plain' }), 400);
  assert.equal(run('POST', '/v1/Public/Referrals/0123456789abcdef/submissions', { 'content-type': 'application/json' }), 400);
});

test('0604 review fixes: viewer link, pending note, staff counts', () => {
  const { code: _c, ...shown } = record({ canShare: false, code: null });
  assert.throws(() => contracts.verifyParentReferrals({ ...shown, shareUrl: 'https://a.example/refer/0123456789abcdef' }), undefined, 'viewer share link');
  assert.equal(contracts.verifyParentReferrals({ ...shown, shareUrl: null }).shareUrl, null);
  assert.throws(() => contracts.validateFamilyReferralRewardInput({ expectedVersion: 1, decision: 'PENDING', note: 'waiting' }), undefined, 'pending note');
  assert.equal(contracts.validateFamilyReferralRewardInput({ expectedVersion: 1, decision: 'PENDING', note: '' }).decision, 'PENDING');
  const staff = (counts) => ({ program: { version: 0, status: 'OFF', formId: null, referrerReward: '', friendOffer: '', rules: '', shareMessage: '', updatedAt: null },
    forms: [], counts, referrals: [], canManage: true });
  assert.equal(contracts.verifySchoolReferrals(staff({ referred: 2, joined: 1, rewarded: 1, awaitingDecision: 1 })).counts.referred, 2);
  for (const bad of [{ referred: 0, joined: 0, rewarded: 1, awaitingDecision: 0 }, { referred: 1, joined: 0, rewarded: 0, awaitingDecision: 1 }]) {
    assert.throws(() => contracts.verifySchoolReferrals(staff(bad)));
  }
});
