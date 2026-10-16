const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { HqController } = require('../dist/hq/hq.controller.js');
const { HqOverviewService } = require('../dist/hq/hq-overview.service.js');
const { HqSchoolDirectoryService } = require('../dist/hq/hq-school-directory.service.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const status = n => error => error.getStatus?.() === n;

const directory = () => ({ schools: [
  { schoolId: '00000000-0000-4000-8000-000000000001', organizationDisplayName: 'Harbor Organization', schoolDisplayName: 'Harbor School', organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: 'CORE', createdAt: '2026-10-16T08:00:00.000Z' },
  { schoolId: '00000000-0000-4000-8000-000000000002', organizationDisplayName: 'Summit Organization', schoolDisplayName: 'Summit School', organizationOperationalStatus: 'SUSPENDED', schoolOperationalStatus: 'ARCHIVED', entitlementTier: null, createdAt: '2026-10-16T08:01:00.000Z' },
] });

test('HQ school-directory service allows only live owner/operator scopes, validates a closed projection, and redacts failures', async () => {
  let role = 'HON_HQ_OWNER'; const calls = [];
  const database = {
    resolveHqOperatorScope: async (...args) => { calls.push(['scope', ...args]); return role === 'REVOKED' ? null : { principalId: 'private-principal', hqRole: role }; },
    readHqSchoolDirectory: async (...args) => { calls.push(['projection', ...args]); return directory(); },
  };
  const service = new HqSchoolDirectoryService(database);
  assert.deepEqual(await service.read('verified-subject'), directory());
  role = 'HON_HQ_OPERATOR'; assert.deepEqual(await service.read('verified-subject'), directory());
  for (const denied of ['HON_HQ_SUPPORT', 'REVOKED']) { role = denied; await assert.rejects(() => service.read('verified-subject'), status(403)); }
  assert.deepEqual(calls.filter(call => call[0] === 'projection'), [['projection', 'verified-subject'], ['projection', 'verified-subject']]);
  const invalid = new HqSchoolDirectoryService({ resolveHqOperatorScope: async () => ({ hqRole: 'HON_HQ_OWNER' }), readHqSchoolDirectory: async () => ({ schools: [{ ...directory().schools[0], email: 'private@example.test' }] }) });
  await assert.rejects(() => invalid.read('verified-subject'), error => status(503)(error) && !JSON.stringify(error.getResponse()).match(/email|private/i));
  const SQL = new HqSchoolDirectoryService({ resolveHqOperatorScope: async () => ({ hqRole: 'HON_HQ_OWNER' }), readHqSchoolDirectory: async () => { throw Object.assign(new Error('private SQL table'), { code: '42501' }); } });
  await assert.rejects(() => SQL.read('verified-subject'), error => status(403)(error) && !JSON.stringify(error.getResponse()).includes('private SQL table'));
});

test('HQ schools endpoint permits no selector, returns a closed envelope, and exposes no execution route', async () => {
  let role = 'HON_HQ_OWNER'; const calls = [];
  const database = {
    resolveHqOperatorScope: async (subject, permission) => { calls.push(['scope', subject, permission]); return role === 'REVOKED' ? null : { principalId: 'private-principal', hqRole: role }; },
    readHqSchoolDirectory: async (subject) => { calls.push(['projection', subject]); return directory(); },
  };
  const module = await Test.createTestingModule({ controllers: [HqController], providers: [HqOverviewService, HqSchoolDirectoryService, { provide: RuntimeDatabaseService, useValue: database }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-subject' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/schools`;
  try {
    let response = await fetch(base); assert.equal(response.status, 200); const body = await response.json(); assert.deepEqual(Object.keys(body), ['data']); assert.deepEqual(Object.keys(body.data), ['directory']); assert.deepEqual(body.data.directory, directory());
    for (const query of ['?role=HON_HQ_OWNER', '?organizationId=private', '?schoolId=private', '?q=private', '?tier=COMPLETE', '?source=AI', '?actionRequestId=private']) assert.equal((await fetch(base + query)).status, 400);
    role = 'HON_HQ_SUPPORT'; assert.equal((await fetch(base)).status, 403);
    role = 'REVOKED'; assert.equal((await fetch(base)).status, 403);
    assert.equal((await fetch(`${base}/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal(calls.filter(call => call[0] === 'projection').length, 1);
  } finally { await app.close(); }
});

test('runtime database uses one repeatable-read fixed read-only function call without source-table access', async () => {
  const database = new RuntimeDatabaseService(); const seen = [];
  database.assertRuntimePosture = async () => {};
  database.getPool = () => ({ connect: async () => ({
    query: async (sql, parameters) => { seen.push([sql, parameters]); return /read_hq_school_directory/.test(sql) ? { rows: [{ data: directory() }] } : { rows: [] }; },
    release() {},
  }) });
  await database.readHqSchoolDirectory('verified-subject');
  assert.equal(seen[0][0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.match(seen[1][0], /statement_timeout/);
  assert.equal(seen[2][0], 'SELECT hon.read_hq_school_directory($1) AS data'); assert.deepEqual(seen[2][1], ['verified-subject']);
  assert.equal(seen[3][0], 'COMMIT');
  assert(seen.every(([sql]) => !/FROM hon\.(organizations|schools|organization_entitlements|users|principals|hq_operator_grants|audit_events|outbox_events)/i.test(sql)));
});
