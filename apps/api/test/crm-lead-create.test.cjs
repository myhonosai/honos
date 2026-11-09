const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
const { readFileSync } = require('node:fs');
const { Test } = require('@nestjs/testing');
const { UnauthorizedException, ValidationPipe } = require('@nestjs/common');
const { LeadController } = require('../dist/crm/lead.controller.js');
const { LeadService } = require('../dist/crm/lead.service.js');
const { LeadCreateHumanUiGuard } = require('../dist/crm/lead-create-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { validateCreateHumanCrmLeadInput } = require('@hon/contracts');
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const input = (patch = {}) => ({ pipelineId: randomUUID(), pipelineStageId: randomUUID(), primaryContact: { givenName: 'Ari', familyName: 'Stone' }, ...patch });
const summary = body => ({ id: randomUUID(), status: 'OPEN', pipelineStageId: body.pipelineStageId, primaryPersonId: randomUUID(), version: 1, createdAt: '2026-10-17T01:02:03.000Z' });
const status = n => error => { assert.equal(error.getStatus(), n); return true; };

test('human create input is closed minimal canonical data, never context, downstream claims or coercion', () => {
 const valid = input(); validateCreateHumanCrmLeadInput(valid);
 validateCreateHumanCrmLeadInput({ ...valid, primaryContact: { ...valid.primaryContact, email: 'ari@example.test', phoneE164: '+15551234567' } });
 for (const value of [null, [], {}, { ...valid, pipelineId: 'bad' }, { ...valid, pipelineStageId: 1 }, ...['sourceId', 'programInterestCode', 'campaignId', 'campaignCode', 'attribution', 'nextFollowUpAt', 'principalType', 'organizationId', 'schoolId', 'actionRequestId', 'delegatedByPrincipalId', 'send', 'enrollmentId'].map(key => ({ ...valid, [key]: 'x' }))]) assert.throws(() => validateCreateHumanCrmLeadInput(value));
 for (const contact of [null, [], {}, { givenName: '', familyName: 'Stone' }, { givenName: ' Ari', familyName: 'Stone' }, { givenName: 'x\u202e', familyName: 'Stone' }, { givenName: 'x'.repeat(121), familyName: 'Stone' }, { ...valid.primaryContact, email: null }, { ...valid.primaryContact, phoneE164: '5551234' }, { ...valid.primaryContact, personId: randomUUID() }]) assert.throws(() => validateCreateHumanCrmLeadInput({ ...valid, primaryContact: contact }));
});

test('existing create controller derives current exact scope and returns only canonical six-field creation facts', async () => {
 const body = input(), lead = summary(body), calls = [], res = { status(n) { this.code = n; } };
 const controller = new LeadController({ resolveAuthorizedScope: async (...args) => { calls.push(args); return scope; } }, { create: async (c, b) => { calls.push(c); assert.deepEqual(b, body); return { lead: { ...lead, privateContact: 'never returned', enrollmentId: randomUUID() }, replayed: false }; } });
 const result = await controller.create(scope.organizationId.toUpperCase(), scope.schoolId, randomUUID(), body, { honIdentity: { externalSubject: 'signed-subject' } }, res);
 assert.deepEqual(result.data, lead); assert.equal(res.code, 201);
 assert.deepEqual(calls[0], ['signed-subject', scope.schoolId, 'crm.lead.create']);
 assert.equal(calls[1].principalType, 'HUMAN_USER'); assert.equal(calls[1].source, 'HUMAN_UI'); assert.equal(calls[1].externalSubject, 'signed-subject'); assert.equal(calls[1].principalId, scope.principalId);
 assert.equal(calls[1].requestId, result.meta.requestId); assert.equal(result.meta.correlationId, result.meta.requestId);
 for (const req of [{}, { honIdentity: { externalSubject: 'signed-subject', principalType: 'AI_EMPLOYEE' } }, ...['honContext', 'honCommandContext', 'commandContext', 'actionContext', 'principalType', 'source', 'actionRequestId', 'delegatedByPrincipalId'].map(key => ({ honIdentity: { externalSubject: 'signed-subject' }, [key]: null }))]) await assert.rejects(() => controller.create(scope.organizationId, scope.schoolId, randomUUID(), body, req, res), status(403));
 await assert.rejects(() => controller.create(randomUUID(), scope.schoolId, randomUUID(), body, { honIdentity: { externalSubject: 'signed-subject' } }, res), status(403));
 const wrongSchool = new LeadController({ resolveAuthorizedScope: async () => ({ ...scope, schoolId: randomUUID() }) }, {});
 await assert.rejects(() => wrongSchool.create(scope.organizationId, scope.schoolId, randomUUID(), body, { honIdentity: { externalSubject: 'signed-subject' } }, res), status(403));
});

test('canonical create service keeps entitlement, scoped non-terminal stage, contact/lead/audit/outbox/idempotency and exact replay', async () => {
 const body = input(), lead = summary(body), calls = [], context = { ...scope, externalSubject: 'signed-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID() };
 let replay = false, fingerprint;
 const service = new LeadService({ withTenantTransaction: async (c, work) => { assert.equal(c, context); return work({ query: async (sql, args) => {
  calls.push({ sql, args });
  if (sql.includes('SELECT tier')) return { rows: [{ tier: 'CORE' }] };
  if (sql.includes('INSERT INTO hon.idempotency_records')) { fingerprint = args[4]; return { rows: [{ id: randomUUID() }], rowCount: replay ? 0 : 1 }; }
  if (sql.includes('SELECT request_fingerprint')) return { rows: [{ request_fingerprint: fingerprint, status: 'COMPLETED', response_body: lead }] };
  if (sql.includes('FROM hon.crm_pipeline_stages')) return { rows: [{ id: body.pipelineStageId }], rowCount: 1 };
  if (sql.includes('INSERT INTO hon.people')) return { rows: [{ id: lead.primaryPersonId }] };
  if (sql.includes('INSERT INTO hon.crm_leads')) return { rows: [lead] };
  return { rows: [], rowCount: 1 };
 } }); } });
 assert.deepEqual(await service.create(context, body), { lead, replayed: false });
 assert.match(calls.find(c => c.sql.includes('FROM hon.crm_pipeline_stages')).sql, /stage\.terminal_status IS NULL/);
 assert.deepEqual(calls.find(c => c.sql.includes('FROM hon.crm_pipeline_stages')).args, [body.pipelineStageId, body.pipelineId, scope.organizationId, scope.schoolId]);
 assert.deepEqual(calls.find(c => c.sql.includes('authorize_campaign_lead')).args, ['signed-subject', false]);
 for (const code of ['crm.lead.create', 'crm.lead.created', 'UPDATE hon.idempotency_records']) assert(calls.some(c => c.sql.includes(code)));
 calls.length = 0; replay = true;
 assert.deepEqual(await service.create(context, body), { lead, replayed: true });
 assert(!calls.some(c => /INSERT INTO hon\.(people|crm_leads|audit_events|outbox_events)/.test(c.sql)));
});

test('POST create guard closes origin/JSON/fetch metadata/marker/key/query/context and leaves GET independently authorized', async () => {
 const old = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
 const body = input(), lead = summary(body), creates = [], scopes = [];
 let authenticated = true, authorized = true, replayed = false, identityPatch = {};
 const db = { resolveAuthorizedScope: async (...args) => { scopes.push(args); return authorized ? scope : undefined; } };
 const leads = { create: async (c, b) => { creates.push({ c, b }); return { lead, replayed }; }, list: async () => ({ leads: [], access: { mode: 'FULL' } }) };
 const module = await Test.createTestingModule({ controllers: [LeadController], providers: [LeadCreateHumanUiGuard, { provide: RuntimeDatabaseService, useValue: db }, { provide: LeadService, useValue: leads }] })
  .overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { if (!authenticated) throw new UnauthorizedException(); c.switchToHttp().getRequest().honIdentity = { externalSubject: 'signed-subject', ...identityPatch }; return true; } }).compile();
 const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.listen(0, '127.0.0.1');
 const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/leads`;
 const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'crm-lead-create', 'Idempotency-Key': randomUUID(), 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty' };
 const post = (payload = body, patch = {}, suffix = '') => {
  const h = { ...headers, ...patch }; for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  const target = new URL(base);
  return new Promise((resolve, reject) => {
   const req = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname + suffix, method: 'POST', headers: h }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
   }); req.on('error', reject); req.end(JSON.stringify(payload));
  });
 };
 try {
  const first = await post(); assert.equal(first.status, 201); assert.equal(first.headers.get('cache-control'), 'private, no-store'); assert.deepEqual((await first.json()).data, lead);
  replayed = true; assert.equal((await post()).status, 200); assert.equal(creates.length, 2);
  for (const patch of [{ Origin: 'https://bad.test' }, { Origin: undefined }, { Origin: 'null' }, { 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json;other=1' }, { 'X-HON-Human-Command': undefined }, { 'X-HON-Human-Command': 'crm-lead-close' }, { 'Sec-Fetch-Site': undefined }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Mode': undefined }, { 'Sec-Fetch-Mode': 'cors' }, { 'Sec-Fetch-Mode': 'navigate' }, { 'Sec-Fetch-Dest': undefined }, { 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-User': '?1' }, ...['Source', 'Principal-Type', 'Action-Request-Id', 'Delegated-By-Principal-Id', 'Organization-Id', 'Unknown'].map(k => ({ ['X-HON-' + k]: 'x' }))]) assert.equal((await post(body, patch)).status, 403, JSON.stringify(patch));
  for (const key of [undefined, '', 'reused', 'x'.repeat(201), randomUUID() + ',' + randomUUID()]) assert.equal((await post(body, { 'Idempotency-Key': key })).status, 409);
  for (const suffix of ['?schoolId=' + scope.schoolId, '?', '?source=HUMAN_UI']) assert.equal((await post(body, {}, suffix)).status, 400);
  for (const payload of [{ ...body, primaryContact: {} }, { ...body, primaryContact: { ...body.primaryContact, email: null } }, ...['source', 'campaignId', 'attribution', 'nextFollowUpAt', 'organizationId', 'principalType', 'actionRequestId', 'send'].map(k => ({ ...body, [k]: 'x' }))]) assert.equal((await post(payload)).status, 400);
  for (const key of ['__proto__', 'constructor', 'prototype']) { assert.equal((await post({ ...body, [key]: 'x' })).status, 400); assert.equal((await post({ ...body, primaryContact: { ...body.primaryContact, [key]: 'x' } })).status, 400); }
  identityPatch = { principalType: 'AI_EMPLOYEE' }; assert.equal((await post()).status, 403); identityPatch = {};
  assert.equal(creates.length, 2); assert.equal(scopes.length, 2, 'All transport/body/context denial must precede scope lookup.');
  for (const email of ['ari..stone@example.test', 'ari@example..test']) assert.equal((await post({ ...body, primaryContact: { ...body.primaryContact, email } })).status, 400);
  authenticated = false; const anonymous = await post(); assert.equal(anonymous.status, 401); assert.equal(anonymous.headers.get('cache-control'), 'private, no-store'); authenticated = true;
  authorized = false; assert.equal((await post()).status, 403); authorized = true;
  assert.equal((await fetch(base, { headers: { Accept: 'application/json' } })).status, 200); assert.equal(scopes.at(-1)[2], 'crm.lead.read');
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal((await fetch(base, { method, headers, body: '{}' })).status, 404);
  delete process.env.HON_PUBLIC_ORIGIN; assert.equal((await post()).status, 503);
  process.env.HON_PUBLIC_ORIGIN = 'https://hon.test/path'; assert.equal((await post()).status, 503);
  assert.equal(creates.length, 2);
 } finally { await app.close(); if (old === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = old; }
});

test('HTTP create still invokes only canonical lead service, not a second CRM or command engine', () => {
 const source = readFileSync('src/crm/lead.controller.ts', 'utf8');
 assert.match(source, /this\.leads\.create\(command, input\)/);
 assert.doesNotMatch(source, /ActionEngineService|Ai\w*Service|Payment\w*Service|Communication\w*Service|WorkItemService|fetch\(/);
});
