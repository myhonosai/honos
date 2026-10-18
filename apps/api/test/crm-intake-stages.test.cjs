const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { ForbiddenException, UnauthorizedException } = require('@nestjs/common');
const { GUARDS_METADATA } = require('@nestjs/common/constants');
const { Test } = require('@nestjs/testing');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { CrmIntakeStagesController } = require('../dist/crm/crm-intake-stages.controller.js');
const { CrmIntakeStagesHumanUiGuard } = require('../dist/crm/crm-intake-stages-human-ui.guard.js');
const { CrmIntakeStagesService } = require('../dist/crm/crm-intake-stages.service.js');

const id = () => randomUUID(); const organizationId = id(), schoolId = id(), principalId = id();
const stage = { pipelineId: id(), pipelineName: 'Admissions', stageId: id(), stageName: 'New inquiry' };
const status = (code) => (error) => error.getStatus?.() === code;
function headers(patch = {}) { return { 'x-hon-human-read': 'crm-intake-stages', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', ...patch }; }

test('CRM intake-stage GET composes verified identity then strict direct-human read transport', () => {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, CrmIntakeStagesController), [HonIdentityGuard, CrmIntakeStagesHumanUiGuard]);
  const module = readFileSync('src/app.module.ts', 'utf8');
  for (const text of ["import { CrmIntakeStagesController } from './crm/crm-intake-stages.controller.js'", '    CrmIntakeStagesController,', '    CrmIntakeStagesService,', '    CrmIntakeStagesHumanUiGuard,']) assert(module.includes(text));
});

test('CRM intake-stage GET guard accepts the browser originless same-origin read but rejects selectors, bodies, authority injection and cross-origin metadata before scope resolution', () => {
  const prior = process.env.HON_PUBLIC_ORIGIN; const guard = new CrmIntakeStagesHumanUiGuard();
  const run = (patch = {}, requestPatch = {}) => guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ method: 'GET', headers: headers(patch), query: {}, originalUrl: '/v1/organizations/x/schools/y/crm/intake-stages', body: undefined, ...requestPatch }), getResponse: () => ({ setHeader() {} }) }) });
  try {
    process.env.HON_PUBLIC_ORIGIN = 'https://hon.test'; assert.equal(run(), true); assert.equal(run({ origin: 'https://hon.test' }), true);
    for (const patch of [{ origin: 'https://evil.test' }, { 'x-hon-human-read': undefined }, { 'x-hon-human-read': 'class-sessions' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-mode': 'cors' }, { 'sec-fetch-dest': 'document' }, { authorization: 'Bearer external' }, { 'x-principal-id': principalId }, { 'x-hon-source': 'AUTOMATION' }, { 'idempotency-key': randomUUID() }]) assert.throws(() => run(patch), status(403));
    for (const requestPatch of [{ query: { cursor: 'x' }, originalUrl: '/v1/x?cursor=x' }, { body: {} }, { headers: { ...headers(), 'content-length': '1' } }]) assert.throws(() => run({}, requestPatch), status(400));
  } finally { if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});

test('CRM intake-stage endpoint uses the exact canonical crm.lead.create scope before the only bounded service read', async () => {
  const calls = []; const db = { resolveAuthorizedScope: async (...args) => { calls.push(['scope', ...args]); return { organizationId, schoolId, principalId }; } };
  const service = { read: async (context) => { calls.push(['read', context]); return [stage]; } };
  const module = await Test.createTestingModule({ controllers: [CrmIntakeStagesController], providers: [CrmIntakeStagesHumanUiGuard, { provide: RuntimeDatabaseService, useValue: db }, { provide: CrmIntakeStagesService, useValue: service }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { const request = context.switchToHttp().getRequest(); if (request.headers.cookie !== 'test-human-session=verified') throw new UnauthorizedException(); request.honIdentity = { externalSubject: 'verified-subject' }; return true; } }).compile();
  const app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1');
  try {
    process.env.HON_PUBLIC_ORIGIN = 'https://hon.test'; await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    const path = `/v1/organizations/${organizationId}/schools/${schoolId}/crm/intake-stages`; const baseHeaders = { Cookie: 'test-human-session=verified', 'X-HON-Human-Read': 'crm-intake-stages', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty' };
    const get = (patch = {}, route = path) => fetch(base + route, { headers: { ...baseHeaders, ...patch }, cache: 'no-store', mode: 'same-origin' });
    assert.equal((await get({ Cookie: '' })).status, 401); assert.equal((await get({ Authorization: 'Bearer no' })).status, 403); assert.equal((await get({}, `${path}?search=x`)).status, 400); assert.equal((await get({}, path.replace(organizationId, id()))).status, 403);
    const response = await get(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow'); const envelope = await response.json(); assert.deepEqual(Object.keys(envelope), ['data', 'meta']); assert.deepEqual(envelope.data, [stage]); assert.equal(envelope.meta.requestId, envelope.meta.correlationId);
    assert.deepEqual(calls.at(-2), ['scope', 'verified-subject', schoolId, 'crm.lead.create']); const context = calls.at(-1)[1]; assert.equal(context.organizationId, organizationId); assert.equal(context.schoolId, schoolId); assert.equal(context.principalId, principalId); assert.equal(context.principalType, 'HUMAN_USER'); assert.equal(context.source, 'HUMAN_UI'); assert.equal(context.externalSubject, 'verified-subject');
  } finally { await app.close(); delete process.env.HON_PUBLIC_ORIGIN; }
});

test('CRM intake-stage service keeps a read-only tenant boundary, validates only closed stage choices, and rejects nonhuman/delegated contexts', async () => {
  const calls = []; const context = { organizationId, schoolId, principalId, externalSubject: 'verified-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id(), correlationId: id(), idempotencyKey: '' };
  const service = new CrmIntakeStagesService({ withTenantReadOnlyTransaction: async (received, work) => {
    assert.equal(received, context); return work({ query: async (sql, args) => { calls.push([sql, args]); if (sql.includes('read_current_school_crm_intake_stages')) return { rows: [{ data: [stage] }] }; return { rows: [] }; } });
  } });
  assert.deepEqual(await service.read(context), [stage]); assert(calls.some(([sql]) => sql.includes('read_current_school_crm_intake_stages'))); assert(calls.some(([sql]) => sql.includes("set_config('app.hon_external_subject'")));
  for (const patch of [{ principalType: 'AI_EMPLOYEE' }, { source: 'AUTOMATION' }, { actionRequestId: id() }, { delegatedByPrincipalId: id() }, { externalSubject: ' ' }]) await assert.rejects(() => service.read({ ...context, ...patch }), status(403));
  const malformed = new CrmIntakeStagesService({ withTenantReadOnlyTransaction: async (_, work) => work({ query: async (sql) => sql.includes('read_current_school_crm_intake_stages') ? { rows: [{ data: [{ ...stage, secret: 'never' }] }] } : { rows: [] } }) });
  await assert.rejects(() => malformed.read(context));
});

test('CRM intake-stage implementation has no write, directory, metric, status-history, source, automation, provider or AI path', () => {
  const source = ['crm-intake-stages.controller.ts', 'crm-intake-stages.service.ts', 'crm-intake-stages-human-ui.guard.ts'].map((file) => readFileSync(`src/crm/${file}`, 'utf8')).join('\n');
  assert.doesNotMatch(source, /@(?:Post|Patch|Put|Delete)\(|(?:INSERT|UPDATE|DELETE|TRUNCATE)\s/i);
  const migration = readFileSync('../../packages/database/migrations/0151_current_school_crm_intake_stages_read.sql', 'utf8');
  for (const text of ['LIMIT 25', "permission.code = 'crm.lead.create'", "tier IN ('ESSENTIAL','CORE','COMPLETE')", 'FORCE ROW LEVEL SECURITY', 'REVOKE SELECT ON TABLE hon.crm_pipelines, hon.crm_pipeline_stages', 'GRANT EXECUTE ON FUNCTION hon.read_current_school_crm_intake_stages(text) TO hon_runtime']) assert(migration.includes(text));
  assert.doesNotMatch(migration, /hon\.(?:crm_leads|people|crm_activities|audit_events|outbox_events|marketing_campaigns|ai_usage_records)\b/i);
});
