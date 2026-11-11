const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { request: httpRequest } = require('node:http');
const { PipelineController } = require('../dist/crm/pipeline.controller.js');
const { PipelineService, STARTER_PIPELINE } = require('../dist/crm/pipeline.service.js');
const { StarterPipelineHumanUiGuard } = require('../dist/crm/starter-pipeline-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const status = n => error => { assert.equal(error.getStatus(), n); return true; };
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), ...patch });

function fakeDatabase({ pipelines = [], tier = 'CORE', authorized = true, replay } = {}) {
 const calls = []; let fingerprint;
 const client = { query: async (sql, args) => {
  calls.push({ sql, args });
  if (sql.includes('resolve_authorized_scope')) return { rows: authorized ? [{ principal_id: scope.principalId, organization_id: scope.organizationId, school_id: scope.schoolId }] : [] };
  if (sql.includes('SELECT tier')) return { rows: tier ? [{ tier }] : [] };
  if (sql.includes('INSERT INTO hon.idempotency_records')) { fingerprint = args[4]; return { rows: replay ? [] : [{ id: randomUUID() }], rowCount: replay ? 0 : 1 }; }
  if (sql.includes('SELECT request_fingerprint')) return { rows: [{ request_fingerprint: fingerprint, status: 'COMPLETED', response_body: replay }] };
  if (sql.includes('FROM hon.crm_pipelines')) return { rows: pipelines };
  if (sql.includes('INSERT INTO hon.crm_pipelines')) return { rows: [{ id: randomUUID(), name: args[2], version: 1, createdAt: '2026-11-11T00:00:00.000Z' }] };
  if (sql.includes('INSERT INTO hon.crm_pipeline_stages')) return { rows: [{ id: randomUUID(), name: args[3], position: args[4], terminalStatus: args[5] }] };
  return { rows: [], rowCount: 1 };
 } };
 return { calls, database: { withTenantTransaction: async (c, work) => work(client) } };
}

test('starter pipeline is the plain four-stage school funnel with one open entry stage', () => {
 assert.equal(STARTER_PIPELINE.name, 'New students');
 assert.deepEqual(STARTER_PIPELINE.stages.map(s => [s.name, s.terminalStatus ?? null]), [['New lead', null], ['Trial booked', null], ['Enrolled', 'WON'], ['Not now', 'LOST']]);
});

test('list returns school pipelines with ordered stages after re-checking authority and entitlement', async () => {
 const pipelineId = randomUUID();
 const rows = [{ id: pipelineId, name: 'New students', version: 1, createdAt: '2026-11-11T00:00:00.000Z', stages: [{ id: randomUUID(), name: 'New lead', position: 1, terminalStatus: null }, { id: randomUUID(), name: 'Enrolled', position: 3, terminalStatus: 'WON' }] }];
 const { calls, database } = fakeDatabase({ pipelines: rows });
 const result = await new PipelineService(database).list(context(), { externalSubject: 'signed-subject', permission: 'crm.lead.create' });
 assert.equal(result.length, 1); assert.equal(result[0].id, pipelineId);
 assert.deepEqual(result[0].stages.map(s => s.terminalStatus), [undefined, 'WON']);
 const order = calls.map(c => c.sql.includes('resolve_authorized_scope') ? 'auth' : c.sql.includes('SELECT tier') ? 'tier' : c.sql.includes('FROM hon.crm_pipelines') ? 'read' : 'other');
 assert.deepEqual(order.filter(x => x !== 'other'), ['auth', 'tier', 'read']);
 const read = calls.find(c => c.sql.includes('FROM hon.crm_pipelines'));
 assert.match(read.sql, /organization_id = \$1/); assert.match(read.sql, /school_id = \$2/); assert.match(read.sql, /ORDER BY/);
 assert.deepEqual(read.args, [scope.organizationId, scope.schoolId]);
 await assert.rejects(() => new PipelineService(fakeDatabase({ tier: null }).database).list(context(), { externalSubject: 's', permission: 'crm.lead.read' }), status(403));
 await assert.rejects(() => new PipelineService(fakeDatabase({ authorized: false }).database).list(context(), { externalSubject: 's', permission: 'crm.lead.read' }), status(403));
});

test('starter creates the starter funnel only when the school has none, under a per-school lock', async () => {
 const { calls, database } = fakeDatabase();
 const result = await new PipelineService(database).createStarter(context(), { externalSubject: 'signed-subject' });
 assert.equal(result.created, true); assert.equal(result.replayed, false);
 assert.equal(result.pipeline.name, 'New students'); assert.equal(result.pipeline.stages.length, 4);
 const lockAt = calls.findIndex(c => c.sql.includes('pg_advisory_xact_lock'));
 const readAt = calls.findIndex(c => c.sql.includes('FROM hon.crm_pipelines'));
 const insertAt = calls.findIndex(c => c.sql.includes('INSERT INTO hon.crm_pipelines'));
 assert(lockAt >= 0 && lockAt < readAt && readAt < insertAt);
 assert.deepEqual(calls[lockAt].args, [scope.schoolId]);
 for (const code of ["'crm.pipeline.create'", "'crm.pipeline.created'", 'UPDATE hon.idempotency_records']) assert(calls.some(c => c.sql.includes(code)), code);
 assert(calls.some(c => c.sql.includes('resolve_authorized_scope') && c.args[2] === 'crm.pipeline.manage'));
});

test('starter never adds a second pipeline: an existing one is returned unchanged', async () => {
 const existing = { id: randomUUID(), name: 'Owner made', version: 2, createdAt: '2026-11-01T00:00:00.000Z', stages: [{ id: randomUUID(), name: 'Inquiry', position: 1, terminalStatus: null }] };
 const { calls, database } = fakeDatabase({ pipelines: [existing] });
 const result = await new PipelineService(database).createStarter(context(), { externalSubject: 'signed-subject' });
 assert.equal(result.created, false); assert.equal(result.pipeline.id, existing.id);
 assert(!calls.some(c => /INSERT INTO hon\.(crm_pipelines|crm_pipeline_stages|audit_events|outbox_events)/.test(c.sql)));
});

test('starter replays the completed response for the same key without writing again', async () => {
 const prior = { id: randomUUID(), name: 'New students', version: 1, createdAt: '2026-11-11T00:00:00.000Z', stages: [] };
 const { calls, database } = fakeDatabase({ replay: { pipeline: prior, created: true } });
 const result = await new PipelineService(database).createStarter(context(), { externalSubject: 'signed-subject' });
 assert.equal(result.replayed, true); assert.equal(result.pipeline.id, prior.id);
 assert(!calls.some(c => /INSERT INTO hon\.crm_pipelines/.test(c.sql)));
});

test('HTTP: GET list accepts lead creators or readers; POST starter needs the human UI command and pipeline management', async () => {
 const old = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
 const asked = []; let grant = new Set(['crm.lead.read', 'crm.pipeline.manage']);
 const db = { resolveAuthorizedScope: async (subject, school, permission) => { asked.push(permission); return grant.has(permission) ? scope : undefined; } };
 const pipelines = { list: async (c, a) => [{ id: 'p', permission: a.permission }], createStarter: async () => ({ pipeline: { id: 'p' }, created: true, replayed: false }) };
 const module = await Test.createTestingModule({ controllers: [PipelineController], providers: [StarterPipelineHumanUiGuard, { provide: RuntimeDatabaseService, useValue: db }, { provide: PipelineService, useValue: pipelines }] })
  .overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: 'signed-subject' }; return true; } }).compile();
 const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.listen(0, '127.0.0.1');
 const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/pipelines`;
 const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'crm-pipeline-starter', 'Idempotency-Key': randomUUID(), 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty' };
 const fetch = (url, { method = 'GET', headers: h = {}, body } = {}) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const req = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname, method, headers: h }, res => {
   const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
  }); req.on('error', reject); req.end(body);
 });
 try {
  let res = await fetch(base); assert.equal(res.status, 200); assert.equal((await res.json()).data[0].permission, 'crm.lead.read');
  grant = new Set(); res = await fetch(base); assert.equal(res.status, 403);
  grant = new Set(['crm.pipeline.manage']);
  res = await fetch(`${base}/starter`, { method: 'POST', headers, body: '{}' }); assert.equal(res.status, 201); assert.equal((await res.json()).meta.created, true);
  for (const patch of [{ 'X-HON-Human-Command': 'crm-lead-create' }, { Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
   res = await fetch(`${base}/starter`, { method: 'POST', headers: { ...headers, ...patch, 'Idempotency-Key': randomUUID() }, body: '{}' }); assert.equal(res.status, 403, JSON.stringify(patch));
  }
  res = await fetch(`${base}/starter`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'nope' }, body: '{}' }); assert.equal(res.status, 409);
  res = await fetch(`${base}/starter`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() }, body: '{"name":"x"}' }); assert.equal(res.status, 400);
  grant = new Set(['crm.lead.create']);
  res = await fetch(`${base}/starter`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() }, body: '{}' }); assert.equal(res.status, 403);
 } finally { await app.close(); process.env.HON_PUBLIC_ORIGIN = old; }
});
