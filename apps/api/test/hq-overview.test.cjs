const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { HqController } = require('../dist/hq/hq.controller.js');
const { HqOverviewService } = require('../dist/hq/hq-overview.service.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const status = n => error => error.getStatus?.() === n;

const overview = (callerHqRole = 'OWNER') => ({
  asOf: '2026-10-16T08:00:00.000Z', callerHqRole, organizationCount: 2, schoolCount: 3,
  onboarding: { availability: 'AVAILABLE', requestCount: 4, inProgressRequestCount: 1, completedRequestCount: 3 },
  configuredProviderStates: { disabled: 1, configured: 2, healthy: 3, degraded: 0, unavailable: 1 }, taskProfileCount: 5,
  financialMetrics: { availability: 'UNAVAILABLE', reason: 'No authoritative HQ financial MRR, ARR, cash, or gross-margin projection is available.' },
  aiUsage: { availability: 'UNAVAILABLE', reason: 'No authoritative HQ AI usage or cost projection is available.' },
  durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'No durable HQ executive work is recorded or active in HQ-1.' },
});

test('HQ overview service accepts only live owner/operator scopes, independently reads the projection, and maps failures without leakage', async () => {
  let role = 'HON_HQ_OWNER'; const calls = [];
  const database = {
    resolveHqOperatorScope: async (...args) => { calls.push(['scope', ...args]); return role === 'REVOKED' ? null : { principalId: 'private-principal', hqRole: role }; },
    readHqPlatformOverview: async (...args) => { calls.push(['projection', ...args]); return overview(role === 'HON_HQ_OPERATOR' ? 'OPERATOR' : 'OWNER'); },
  };
  const service = new HqOverviewService(database);
  assert.equal((await service.read('verified-subject')).callerHqRole, 'OWNER');
  role = 'HON_HQ_OPERATOR'; assert.equal((await service.read('verified-subject')).callerHqRole, 'OPERATOR');
  for (const denied of ['HON_HQ_SUPPORT', 'REVOKED']) { role = denied; await assert.rejects(() => service.read('verified-subject'), status(403)); }
  assert.deepEqual(calls.filter(call => call[0] === 'projection'), [['projection', 'verified-subject'], ['projection', 'verified-subject']]);
  const invalid = new HqOverviewService({ resolveHqOperatorScope: async () => ({ hqRole: 'HON_HQ_OWNER' }), readHqPlatformOverview: async () => ({ ...overview(), mrr: 99 }) });
  await assert.rejects(() => invalid.read('verified-subject'), error => status(503)(error) && !JSON.stringify(error.getResponse()).match(/mrr|99|private/i));
  const SQL = new HqOverviewService({ resolveHqOperatorScope: async () => ({ hqRole: 'HON_HQ_OWNER' }), readHqPlatformOverview: async () => { throw Object.assign(new Error('private SQL table'), { code: '42501' }); } });
  await assert.rejects(() => SQL.read('verified-subject'), error => status(403)(error) && !JSON.stringify(error.getResponse()).includes('private SQL table'));
});

test('HQ overview endpoint permits no selector or execution route and returns only the closed read model', async () => {
  let role = 'HON_HQ_OWNER'; const calls = [];
  const database = {
    resolveHqOperatorScope: async (subject, permission) => { calls.push(['scope', subject, permission]); return role === 'REVOKED' ? null : { principalId: 'private-principal', hqRole: role }; },
    readHqPlatformOverview: async (subject) => { calls.push(['projection', subject]); return overview(role === 'HON_HQ_OPERATOR' ? 'OPERATOR' : 'OWNER'); },
  };
  const module = await Test.createTestingModule({ controllers: [HqController], providers: [HqOverviewService, { provide: RuntimeDatabaseService, useValue: database }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-subject' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/overview`;
  try {
    let response = await fetch(base); assert.equal(response.status, 200); const body = await response.json(); assert.deepEqual(Object.keys(body), ['data']); assert.deepEqual(Object.keys(body.data), ['overview']); assert.equal(body.data.overview.callerHqRole, 'OWNER');
    role = 'HON_HQ_OPERATOR'; response = await fetch(base); assert.equal(response.status, 200); assert.equal((await response.json()).data.overview.callerHqRole, 'OPERATOR');
    for (const query of ['?role=HON_HQ_OWNER', '?permission=hq.dashboard.view', '?tier=COMPLETE', '?organizationId=private', '?schoolId=private', '?from=2026-01-01', '?authority=AUTO']) assert.equal((await fetch(base + query)).status, 400);
    role = 'HON_HQ_SUPPORT'; assert.equal((await fetch(base)).status, 403);
    role = 'REVOKED'; assert.equal((await fetch(base)).status, 403);
    assert.equal((await fetch(`${base}/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    assert(calls.every(call => call.slice(1).includes('verified-subject') || call[0] !== 'scope'));
    assert.equal(calls.filter(call => call[0] === 'projection').length, 2);
  } finally { await app.close(); }
});

test('runtime database uses a repeatable-read transaction and the one fixed parameterized function without direct private reads', async () => {
  const database = new RuntimeDatabaseService(); const seen = [];
  database.assertRuntimePosture = async () => {};
  database.getPool = () => ({ connect: async () => ({
    query: async (sql, parameters) => { seen.push([sql, parameters]); return /read_hq_platform_overview/.test(sql) ? { rows: [{ data: overview() }] } : { rows: [] }; },
    release() {},
  }) });
  await database.readHqPlatformOverview('verified-subject');
  assert.equal(seen[0][0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.match(seen[1][0], /statement_timeout/);
  assert.equal(seen[2][0], 'SELECT hon.read_hq_platform_overview($1) AS data'); assert.deepEqual(seen[2][1], ['verified-subject']);
  assert.equal(seen[3][0], 'COMMIT');
  assert(seen.every(([sql]) => !/FROM hon\.(organizations|schools|users|hq_onboarding_requests|hq_ai_provider_connections|hq_ai_task_profiles|work_items|billing_accounts|ai_usage_ledger)/i.test(sql)));
});
