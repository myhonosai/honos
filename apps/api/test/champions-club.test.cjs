const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ChampionsHqController, ChampionsSchoolController } = require('../dist/champions/champions-club.controller.js');
const { ChampionsClubService } = require('../dist/champions/champions-club.service.js');
const { ChampionsCommandGuard, ChampionsReadGuard, assertChampionsHumanRequest } = require('../dist/champions/champions-club.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const school = randomUUID(), org = randomUUID(), referred = '7c9e6679-7425-40de-944b-e07fc1f90ae7', policyId = randomUUID(), attributionId = randomUUID();
const at = '2026-10-18T05:00:00.000Z';
const status = expected => error => error.getStatus?.() === expected;
const terms = (patch = {}) => ({ attributionWindowDays:90, refundWindowDays:30, minimumPaidDays:30, minimumPaidInvoices:1, paymentVerificationSource:'HQ_OWNER_ATTESTATION', welcomeCreditMinor:10000, termsReference:'Program terms v1', ...patch });
const policy = (patch = {}) => ({ ...terms(), policyId, policyVersion:1, status:'DRAFT', currency:'USD', financialRewards:'DISABLED', createdAt:at, publishedAt:null, ...patch });
const attribution = (patch = {}) => ({ attributionId, state:'PENDING', stateReason:'CAPTURED', version:1, referrerOrganizationId:org, referrerSchoolId:school, referrerSchoolName:'Fixture Dojo',
  referredOrganizationId:referred, referredOrganizationName:'Referred Dojo', capturedAt:at, qualifiedPolicyVersion:null, qualifiedAt:null, decidedAt:null, ...patch });
const view = (patch = {}) => ({ schoolId:school, referralCode:{ code:'ABCDEFGH23', status:'ACTIVE', issuedAt:at }, program:{ status:'POLICY_UNDECIDED', policyVersion:null, financialRewards:'DISABLED' }, referrals:{ pending:1, qualified:0, rejected:0, refunded:0, reversed:0 }, ...patch });
const codeReceipt = () => ({ schoolId:school, code:'ABCDEFGH23', status:'ACTIVE', issuedAt:at, created:true, replayed:false });
const qualify = (patch = {}) => ({ decision:'QUALIFY', reasonCode:'QUALIFICATION_VERIFIED', expectedVersion:1, evidence:{ firstPaidAt:at, paidInvoiceCount:1, reference:'Owner attestation #1' }, ...patch });

test('closed input contracts: complete terms, exact capture and decision shapes, no reward or authority fields', () => {
  assert.deepEqual(contracts.validateChampionsPolicyDraftInput(terms()), terms());
  const undecided = terms({ attributionWindowDays:null, paymentVerificationSource:'UNDECIDED', termsReference:null });
  assert.deepEqual(contracts.validateChampionsPolicyDraftInput(undecided), undecided);
  for (const bad of [{...terms(), financialRewardsEnabled:true}, {...terms(), rewardAmount:100}, {...terms(), schoolId:school}, (({ termsReference, ...rest }) => rest)(terms()),
    terms({ attributionWindowDays:0 }), terms({ attributionWindowDays:731 }), terms({ refundWindowDays:-1 }), terms({ minimumPaidInvoices:1.5 }), terms({ welcomeCreditMinor:100001 }),
    terms({ welcomeCreditMinor:'10000' }), terms({ paymentVerificationSource:'STRIPE' }), terms({ paymentVerificationSource:null }), terms({ termsReference:' padded ' }), terms({ termsReference:'' }), null, [], 'x'])
    assert.throws(() => contracts.validateChampionsPolicyDraftInput(bad));
  assert.deepEqual(contracts.validateChampionsAttributionCaptureInput({ referralCode:'ABCDEFGH23', referredOrganizationId:referred.toUpperCase() }), { referralCode:'ABCDEFGH23', referredOrganizationId:referred });
  for (const bad of [{ referralCode:'abcdefgh23', referredOrganizationId:referred }, { referralCode:'ABCDEFGHI1', referredOrganizationId:referred }, { referralCode:'ABCDEFGH23' },
    { referralCode:'ABCDEFGH23', referredOrganizationId:referred, referrerSchoolId:school }, { referralCode:'ABCDEFGH23', referredOrganizationId:'00000000-0000-0000-0000-000000000000' }])
    assert.throws(() => contracts.validateChampionsAttributionCaptureInput(bad));
  assert.deepEqual(contracts.validateChampionsDecisionInput(qualify()), qualify());
  for (const ok of [{ decision:'REJECT', reasonCode:'FRAUD_SUSPECTED', expectedVersion:1 }, { decision:'REFUND', reasonCode:'REFUND_ISSUED', expectedVersion:3 }, { decision:'REVERSE', reasonCode:'SUBSCRIPTION_CANCELLED', expectedVersion:2 }])
    assert.deepEqual(contracts.validateChampionsDecisionInput(ok), ok);
  for (const bad of [qualify({ reasonCode:'REFUND_ISSUED' }), qualify({ expectedVersion:0 }), qualify({ expectedVersion:'1' }), qualify({ evidence:{ firstPaidAt:'2026-10-18', paidInvoiceCount:1, reference:'x' } }),
    qualify({ evidence:{ firstPaidAt:at, paidInvoiceCount:-1, reference:'x' } }), qualify({ evidence:{ firstPaidAt:at, paidInvoiceCount:1, reference:'x', amount:149 } }), qualify({ rewardMinor:10000 }),
    (({ evidence, ...rest }) => rest)(qualify()), { decision:'REJECT', reasonCode:'REFUND_ISSUED', expectedVersion:1 }, { decision:'REFUND', reasonCode:'REFUND_ISSUED', expectedVersion:1, evidence:{} },
    { decision:'REVERSE', reasonCode:'NOT_ELIGIBLE', expectedVersion:1 }, { decision:'APPROVE', reasonCode:'QUALIFICATION_VERIFIED', expectedVersion:1 }, { decision:'GRANT_LIFETIME', reasonCode:'QUALIFICATION_VERIFIED', expectedVersion:1 }])
    assert.throws(() => contracts.validateChampionsDecisionInput(bad));
  assert.equal(contracts.validateChampionsAttributionStateFilter(undefined), null);
  assert.equal(contracts.validateChampionsAttributionStateFilter('QUALIFIED'), 'QUALIFIED');
  for (const bad of ['qualified', ['PENDING','QUALIFIED'], '', 'PAID']) assert.throws(() => contracts.validateChampionsAttributionStateFilter(bad));
});

test('closed response contracts keep financial rewards disabled and reject drift or private fields', () => {
  assert.deepEqual(contracts.validateChampionsSchoolView(view()), view());
  assert.deepEqual(contracts.validateChampionsSchoolView(view({ referralCode:null })), view({ referralCode:null }));
  for (const bad of [view({ program:{ status:'PUBLISHED', policyVersion:1, financialRewards:'ENABLED' } }), view({ program:{ status:'POLICY_UNDECIDED', policyVersion:1, financialRewards:'DISABLED' } }),
    view({ referrals:{ pending:1, qualified:0, rejected:0, refunded:0, reversed:0, credits:100 } }), { ...view(), referredOrganizations:[referred] }, view({ referralCode:{ code:'ABCDEFGH23', status:'REVOKED', issuedAt:at } })])
    assert.throws(() => contracts.validateChampionsSchoolView(bad));
  assert.deepEqual(contracts.validateChampionsReferralCodeReceipt(codeReceipt()), codeReceipt());
  assert.throws(() => contracts.validateChampionsReferralCodeReceipt({ ...codeReceipt(), principalId:randomUUID() }));
  const program = { published:policy({ status:'PUBLISHED', publishedAt:at }), drafts:[policy({ policyId:randomUUID(), policyVersion:2 })], financialRewards:'DISABLED' };
  assert.deepEqual(contracts.validateChampionsProgram(program), program);
  for (const bad of [{ ...program, financialRewards:'ENABLED' }, { ...program, published:policy() }, { ...program, drafts:[policy({ status:'PUBLISHED', publishedAt:at })] }, { ...program, drafts:[{ ...policy(), financialRewards:'ENABLED' }] }])
    assert.throws(() => contracts.validateChampionsProgram(bad));
  assert.doesNotThrow(() => contracts.validateChampionsPolicyDraftReceipt({ policy:policy(), replayed:false }));
  assert.throws(() => contracts.validateChampionsPolicyDraftReceipt({ policy:policy({ status:'PUBLISHED', publishedAt:at }), replayed:false }));
  assert.doesNotThrow(() => contracts.validateChampionsPolicyPublishReceipt({ policy:policy({ status:'PUBLISHED', publishedAt:at }), retiredPolicyId:null, replayed:true }));
  assert.throws(() => contracts.validateChampionsPolicyPublishReceipt({ policy:policy(), retiredPolicyId:null, replayed:false }));
  assert.doesNotThrow(() => contracts.validateChampionsAttributionReceipt({ attribution:attribution(), replayed:false }));
  assert.doesNotThrow(() => contracts.validateChampionsAttributionReceipt({ attribution:attribution({ state:'QUALIFIED', stateReason:'QUALIFICATION_VERIFIED', version:2, qualifiedPolicyVersion:1, qualifiedAt:at, decidedAt:at }), replayed:false }));
  for (const bad of [attribution({ state:'QUALIFIED', decidedAt:at }), attribution({ decidedAt:at }), attribution({ qualifiedAt:at }), attribution({ state:'PAID' }), { ...attribution(), referredOwnerEmail:'private@example.test' }])
    assert.throws(() => contracts.validateChampionsAttributionReceipt({ attribution:bad, replayed:false }));
  assert.doesNotThrow(() => contracts.validateChampionsAttributionList({ attributions:[attribution()], limit:100 }));
  assert.throws(() => contracts.validateChampionsAttributionList({ attributions:[attribution()], limit:500 }));
});

test('service validates before the database, uses opaque server request IDs, maps refusals and redacts SQL detail', async () => {
  const calls = [];
  const db = result => ({ callChampionsClub:async (...args) => { calls.push(args); return result; } });
  const key = randomUUID();
  const service = new ChampionsClubService(db(codeReceipt()));
  assert.deepEqual(await service.issueReferralCode('verified-human', school.toUpperCase(), key), codeReceipt());
  await service.issueReferralCode('verified-human', school, key);
  assert.deepEqual(calls[0][0], 'issueReferralCode'); assert.deepEqual(calls[0][1].slice(0,3), ['verified-human', school, key]);
  assert.notEqual(calls[0][1][3], calls[1][1][3]); assert.notEqual(calls[0][1][4], calls[1][1][4]);
  for (const work of [() => service.issueReferralCode('s', 'not-a-uuid', key), () => service.issueReferralCode('s', school, undefined), () => service.createPolicyDraft('s', { ...terms(), extra:1 }, key),
    () => service.captureAttribution('s', { referralCode:'bad' }, key), () => service.decideAttribution('s', attributionId, { decision:'GRANT' }, key), () => service.readAttributions('s', 'paid'), () => service.publishPolicy('s', 'x', key)])
    await assert.rejects(work, status(400));
  assert.equal(calls.length, 2, 'Invalid input never reaches the database.');
  const draftCalls = []; await new ChampionsClubService({ callChampionsClub:async (...a) => { draftCalls.push(a); return { policy:policy(), replayed:false }; } }).createPolicyDraft('s', terms(), key);
  assert.deepEqual(JSON.parse(draftCalls[0][1][1]), terms());
  for (const [code, message, http, exposed] of [['42501','CHAMPIONS_FORBIDDEN',403,'CHAMPIONS_FORBIDDEN'],['P0002','private',404,'CHAMPIONS_UNAVAILABLE'],['40001','CHAMPIONS_TRANSITION_NOT_ALLOWED',409,'CHAMPIONS_TRANSITION_NOT_ALLOWED'],
    ['40001','could not serialize access',409,'CHAMPIONS_VERSION_CONFLICT'],['23505','CHAMPIONS_KEY_REUSED',409,'IDEMPOTENCY_KEY_REUSED'],['23P01','CHAMPIONS_DUPLICATE_ATTRIBUTION',409,'CHAMPIONS_DUPLICATE_ATTRIBUTION'],
    ['55P03','lock',409,'CHAMPIONS_OUTCOME_UNKNOWN'],['57014','timeout',409,'CHAMPIONS_OUTCOME_UNKNOWN'],['23514','CHAMPIONS_POLICY_UNDECIDED',422,'CHAMPIONS_POLICY_UNDECIDED'],
    ['23514','CHAMPIONS_SELF_REFERRAL',422,'CHAMPIONS_SELF_REFERRAL'],['23514','new row violates check constraint "private_school_secret"',400,'INVALID_CHAMPIONS_INPUT'],['22023','INVALID_CHAMPIONS_INPUT',400,'INVALID_CHAMPIONS_INPUT'],['XX000','private-school-SQL',503,'CHAMPIONS_UNAVAILABLE']]) {
    const failing = new ChampionsClubService({ callChampionsClub:async () => { throw Object.assign(new Error(message), { code }); } });
    await assert.rejects(() => failing.decideAttribution('s', attributionId, qualify(), key), error => {
      assert.equal(error.getStatus(), http); assert.equal(error.getResponse().code, exposed);
      assert.equal(JSON.stringify(error.getResponse()).includes('private'), false); return true;
    });
  }
  await assert.rejects(() => new ChampionsClubService(db({ ...view(), referredOrganizations:[referred] })).readSchoolView('s', school), status(503));
});

test('direct-human request posture refuses tenant, family, delegated and action context', () => {
  for (const field of ['honContext','honCommandContext','commandContext','actionContext','principalType','source','actionRequestId','delegatedByPrincipalId','organizationId','schoolId','familyId'])
    assert.throws(() => assertChampionsHumanRequest({ headers:{}, [field]:null }), status(403));
  for (const field of ['principalId','principalType','source','organizationId','schoolId','familyId'])
    assert.throws(() => assertChampionsHumanRequest({ headers:{}, honIdentity:{ externalSubject:'verified', [field]:'untrusted' } }), status(403));
  assert.doesNotThrow(() => assertChampionsHumanRequest({ headers:{}, honIdentity:{ externalSubject:'verified', displayName:'Owner', email:'owner@example.test' } }));
});

test('HTTP routes: identity, exact command headers, same-origin JSON, no selectors, no-store', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [];
  const responses = { readSchoolView:view(), issueReferralCode:codeReceipt(), readProgram:{ published:null, drafts:[], financialRewards:'DISABLED' }, createPolicyDraft:{ policy:policy(), replayed:false },
    publishPolicy:{ policy:policy({ status:'PUBLISHED', publishedAt:at }), retiredPolicyId:null, replayed:false }, readAttributions:{ attributions:[attribution()], limit:100 },
    captureAttribution:{ attribution:attribution(), replayed:false }, decideAttribution:{ attribution:attribution({ state:'REJECTED', stateReason:'FRAUD_SUSPECTED', version:2, decidedAt:at }), replayed:false } };
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
    // Reads.
    for (const [path, operation] of [[`/schools/${school}/champions/summary`,'readSchoolView'],[`/hq/champions/program`,'readProgram'],[`/hq/champions/attributions`,'readAttributions'],[`/hq/champions/attributions?state=PENDING`,'readAttributions']]) {
      const response = await send('GET', path); assert.equal(response.status, 200, path); assert.match(response.headers['cache-control'], /no-store/);
      assert.deepEqual(response.body, { data:responses[operation] });
    }
    assert.deepEqual(calls.at(-1), ['readAttributions', ['verified-human', 'PENDING']]);
    assert.deepEqual((await send('GET', `/schools/${school}/champions/referral-code`)).body, { data:{ schoolId:school, referralCode:view().referralCode } });
    for (const path of [`/schools/${school}/champions/summary?schoolId=${school}`, `/hq/champions/program?state=PENDING`, `/hq/champions/attributions?state=PENDING&state=QUALIFIED`, `/hq/champions/attributions?organizationId=${org}`, `/hq/champions/attributions?state=paid`, `/schools/not-a-uuid/champions/summary`])
      assert.equal((await send('GET', path)).status, 400, path);
    // Commands.
    const commands = [
      ['POST', `/schools/${school}/champions/referral-code`, 'champions-referral-code-issue', undefined, 'issueReferralCode'],
      ['POST', `/hq/champions/policy-drafts`, 'champions-policy-draft', terms(), 'createPolicyDraft'],
      ['POST', `/hq/champions/policy-drafts/${policyId}/publish`, 'champions-policy-publish', {}, 'publishPolicy'],
      ['POST', `/hq/champions/attributions`, 'champions-attribution-capture', { referralCode:'ABCDEFGH23', referredOrganizationId:referred }, 'captureAttribution'],
      ['POST', `/hq/champions/attributions/${attributionId}/decisions`, 'champions-attribution-decide', { decision:'REJECT', reasonCode:'FRAUD_SUSPECTED', expectedVersion:1 }, 'decideAttribution'],
    ];
    for (const [method, path, command, body, operation] of commands) {
      const before = calls.length;
      const ok = await send(method, path, { headers:human(command), body:body ?? {} });
      assert.equal(ok.status, 200, path); assert.match(ok.headers['cache-control'], /no-store/); assert.deepEqual(ok.body, { data:responses[operation] });
      assert.equal(calls.at(-1)[0], operation); assert.equal(calls.at(-1)[1][0], 'verified-human');
      for (const extra of [{ origin:'https://attacker.example' }, { 'sec-fetch-site':'cross-site' }, { 'sec-fetch-mode':'cors' }, { 'sec-fetch-dest':'document' }, { 'sec-fetch-user':'?1' },
        { 'x-hon-human-command':'hq-entitlement-transition' }, { 'x-hon-human-command':commands.find(c => c[2] !== command)[2] }, { 'x-hon-principal-type':'HUMAN_USER' }, { 'content-type':'text/plain' }])
        assert.equal((await send(method, path, { headers:{ ...human(command), ...extra }, body:body ?? {} })).status, 403, `${path} ${JSON.stringify(extra)}`);
      assert.equal((await send(method, path + '?source=HUMAN_UI', { headers:human(command), body:body ?? {} })).status, 400);
      assert.equal((await send(method, path, { headers:{ ...human(command), 'idempotency-key':'not-a-uuid' }, body:body ?? {} })).status, 400);
      assert.equal(calls.length, before + 1, `${path}: refused requests never reach the database`);
    }
    assert.equal((await send('POST', `/hq/champions/policy-drafts/${policyId}/publish`, { headers:human('champions-policy-publish'), body:{ status:'PUBLISHED' } })).status, 400);
    assert.equal((await send('POST', `/hq/champions/policy-drafts`, { headers:human('champions-policy-draft'), body:{ ...terms(), financialRewardsEnabled:true } })).status, 400);
    assert.equal((await send('GET', `/hq/champions/policy-drafts`)).status, 404);
    assert.equal((await send('PATCH', `/hq/champions/attributions/${attributionId}/decisions`, { headers:human('champions-attribution-decide'), body:{} })).status, 404);
    assert.equal((await send('DELETE', `/schools/${school}/champions/referral-code`)).status, 404);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('command routes fail closed when the public origin is not configured', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; delete process.env.HON_PUBLIC_ORIGIN;
  const module = await Test.createTestingModule({ controllers:[ChampionsHqController], providers:[ChampionsClubService, ChampionsCommandGuard, ChampionsReadGuard,
    { provide:RuntimeDatabaseService, useValue:{ callChampionsClub:async () => { throw new Error('must not be called'); } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject:'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  try {
    const response = await fetch(`http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/champions/policy-drafts`, { method:'POST', headers:{ 'content-type':'application/json', 'x-hon-human-command':'champions-policy-draft', 'idempotency-key':randomUUID() }, body:JSON.stringify(terms()) });
    assert.equal(response.status, 503);
  } finally { await app.close(); if (previous !== undefined) process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('database path: one fixed function per operation, read-only snapshot for reads, no tenant context, rollback on failure', async () => {
  const database = new RuntimeDatabaseService(); database.assertRuntimePosture = async () => {};
  let fail = false; const seen = [];
  database.getPool = () => ({ connect:async () => ({ query:async (sql, args) => { seen.push([sql, args]); if (sql.startsWith('SELECT hon.')) { if (fail) throw Object.assign(new Error('fail'), { code:'40001' }); return { rows:[{ data:{ ok:true } }] }; } return { rows:[] }; }, release() { seen.push(['release']); } }) });
  assert.deepEqual(await database.callChampionsClub('readSchoolView', ['subject', school]), { ok:true });
  assert.deepEqual(seen.map(s => s[0]), ['BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', "SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '3s'; SET LOCAL log_parameter_max_length_on_error = 0", 'SELECT hon.read_champions_school_view($1,$2::uuid) AS data', 'COMMIT', 'release']);
  seen.length = 0;
  await database.callChampionsClub('decideAttribution', ['subject', attributionId, '{}', randomUUID(), randomUUID(), randomUUID()]);
  assert.equal(seen[0][0], 'BEGIN'); assert.equal(seen[2][0], 'SELECT hon.decide_champions_attribution($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data');
  assert.equal(seen.some(([sql]) => /set_config|app\.hon_/.test(sql)), false);
  seen.length = 0; fail = true;
  await assert.rejects(() => database.callChampionsClub('publishPolicy', ['subject', policyId, randomUUID(), randomUUID(), randomUUID()]), { code:'40001' });
  assert.deepEqual(seen.slice(-2).map(s => s[0]), ['ROLLBACK', 'release']);
  await assert.rejects(() => database.callChampionsClub('readSchoolView', ['only-one']), /CHAMPIONS_UNAVAILABLE/);
  await assert.rejects(() => database.callChampionsClub('dropEverything', []), /CHAMPIONS_UNAVAILABLE/);
});
