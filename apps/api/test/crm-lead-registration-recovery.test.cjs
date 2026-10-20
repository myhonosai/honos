const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const contracts = require('@hon/contracts');
const { LeadRegistrationRecoveryController } = require('../dist/crm/lead-registration-recovery.controller.js');
const { LeadRegistrationRecoveryService } = require('../dist/crm/lead-registration-recovery.service.js');
const { LeadRegistrationRecoveryHumanUiGuard } = require('../dist/crm/lead-registration-recovery.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const leadId = randomUUID();
const context = (patch = {}) => { const id = randomUUID(); return { ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'verified-human', requestId: id, correlationId: id, idempotencyKey: '', ...patch }; };
const registration = (patch = {}) => ({ outcome: 'REGISTERED', leadId, sourceContactPersonId: randomUUID(), registrationPath: 'ADULT', studentProfileId: randomUUID(), familyId: null, recordedAt: '2026-10-20T20:00:00.000Z', ...patch });
const draft = (patch = {}) => ({ membershipId: randomUUID(), state: 'DRAFT', planCode: 'STAFF-OPAQUE', termStartedAt: null, termEndsAt: null, recordedAt: '2026-10-20T20:01:00.000Z', ...patch });
const account = { classification: 'CANONICAL', currency: 'USD' };
const states = () => [
  { leadId, workflowState: 'NOT_REGISTERED' },
  { leadId, workflowState: 'NEEDS_STAFF_REVIEW' },
  { leadId, workflowState: 'BILLING_ACCOUNT_REQUIRED', historicalRegistrationReceipt: registration() },
  { leadId, workflowState: 'READY_FOR_DRAFT', historicalRegistrationReceipt: registration(), billingAccount: account },
  { leadId, workflowState: 'CURRENT_DRAFT', historicalRegistrationReceipt: registration(), billingAccount: account, currentMembershipDraft: { state: 'RECORDED_DRAFT', receipt: draft() } },
];

test('closed recovery contract: exact states, historical receipt distinct from current DRAFT, no extra identifiers', () => {
  for (const value of states()) assert.deepEqual(contracts.verifyCrmLeadRegistrationRecovery(value, leadId), value);
  assert.deepEqual(contracts.validateCrmLeadRegistrationRecoveryInput({}), {});
  for (const body of [{ studentProfileId: randomUUID() }, { receiptId: randomUUID() }, { leadId }, { membershipId: randomUUID() }, null, [], 'x']) assert.throws(() => contracts.validateCrmLeadRegistrationRecoveryInput(body));
  const [, review, required, ready, current] = states();
  const rejects = [
    { ...review, leadId: randomUUID() },
    { ...review, historicalRegistrationReceipt: registration() },
    { leadId, workflowState: 'ACTIVE' },
    { leadId, workflowState: 'DRAFT' },
    { ...required, historicalRegistrationReceipt: registration({ leadId: randomUUID() }) },
    { ...required, historicalRegistrationReceipt: registration({ registrationPath: 'GUARDIAN_CHILD', familyId: randomUUID() }) },
    { ...required, historicalRegistrationReceipt: { outcome: 'NEEDS_STAFF_REVIEW' } },
    { ...required, historicalRegistrationReceipt: { ...registration(), extra: true } },
    { ...required, billingAccount: account },
    { ...ready, billingAccount: { ...account, id: randomUUID() } },
    { ...ready, billingAccount: { classification: 'ADDITIONAL', currency: 'USD' } },
    { ...ready, currentMembershipDraft: current.currentMembershipDraft },
    { ...current, currentMembershipDraft: { state: 'RECORDED_DRAFT', receipt: draft({ state: 'ACTIVE' }) } },
    { ...current, currentMembershipDraft: draft() },
    { ...current, currentMembershipDraft: undefined },
    { ...current, membershipId: randomUUID() },
  ];
  for (const value of rejects) assert.throws(() => contracts.verifyCrmLeadRegistrationRecovery(JSON.parse(JSON.stringify(value)), leadId));
  assert.throws(() => contracts.verifyCrmLeadRegistrationRecovery(states()[0], 'not-a-uuid'));
});

test('real Nest guard and global whitelist expose one direct-human read with no selectors or key', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const calls = []; let mixed = false; let resolved = scope;
  const database = { resolveCrmLeadRegistrationScope: async (subject, school) => { assert.equal(subject, 'verified-human'); assert.equal(school, scope.schoolId); return resolved; } };
  const service = { recover: async (c, id) => { calls.push({ c, id }); return states()[4]; } };
  const module = await Test.createTestingModule({ controllers: [LeadRegistrationRecoveryController], providers: [LeadRegistrationRecoveryHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }, { provide: LeadRegistrationRecoveryService, useValue: service }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human', ...(mixed ? { source: 'AI' } : {}) }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.listen(0, '127.0.0.1');
  const request = (body = {}, patch = {}, path = `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/leads/${leadId}/registration-recovery`, method = 'POST') => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'crm-lead-registration-recovery', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty', ...patch, 'Content-Length': Buffer.byteLength(payload) };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const req = http.request({ hostname: '127.0.0.1', port: app.getHttpServer().address().port, path, method, headers }, res => { let data = ''; res.on('data', x => data += x); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null })); });
    req.on('error', reject); req.end(payload);
  });
  try {
    const ok = await request();
    assert.equal(ok.status, 200); assert.equal(ok.headers['cache-control'], 'private, no-store'); assert.equal(ok.headers['referrer-policy'], 'no-referrer'); assert.equal(ok.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(ok.body.data.workflowState, 'CURRENT_DRAFT'); assert.equal(ok.body.meta.replayed, false); assert.equal(ok.body.meta.requestId, ok.body.meta.correlationId);
    assert.equal(calls.length, 1); assert.equal(calls[0].id, leadId); assert.equal(calls[0].c.idempotencyKey, ''); assert.equal(calls[0].c.principalId, scope.principalId); assert.equal(calls[0].c.source, 'HUMAN_UI');
    for (const patch of [{ Origin: 'https://evil.test' }, { 'X-HON-Human-Command': 'crm-lead-register' }, { 'X-HON-Human-Command': undefined }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Mode': 'cors' }, { 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-User': '?1' }, { 'Content-Type': 'text/plain' }, { 'X-HON-Action-Request-Id': randomUUID() }]) {
      assert.equal((await request({}, patch)).status, 403, JSON.stringify(patch));
    }
    assert.equal((await request({}, { 'Idempotency-Key': randomUUID() })).status, 409);
    for (const body of [{ studentProfileId: randomUUID() }, { receiptId: randomUUID() }, { leadId }, { membershipId: randomUUID() }, { schoolId: randomUUID() }]) assert.equal((await request(body)).status, 400, JSON.stringify(body));
    assert.equal((await request({}, {}, `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/leads/${leadId}/registration-recovery?studentProfileId=${randomUUID()}`)).status, 400);
    assert.equal((await request({}, {}, `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/leads/not-a-uuid/registration-recovery`)).status, 400);
    assert.equal((await request({}, {}, `/v1/organizations/${randomUUID()}/schools/${scope.schoolId}/crm/leads/${leadId}/registration-recovery`)).status, 403, 'URL organization differs from resolved scope');
    resolved = undefined; assert.equal((await request()).status, 403, 'no live scope'); resolved = scope;
    mixed = true; assert.equal((await request()).status, 403); mixed = false;
    assert.equal((await request({}, {}, undefined, 'GET')).status, 404);
    assert.equal(calls.length, 1, 'no rejected request reached the service');
    delete process.env.HON_PUBLIC_ORIGIN; assert.equal((await request()).status, 503);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('service rejects nonhuman, delegated, keyed and malformed context before any database work', async () => {
  const service = new LeadRegistrationRecoveryService({ withTenantTransaction: async () => { throw new Error('must not enter'); } });
  for (const patch of [{ source: 'AI' }, { source: 'AUTOMATION' }, { principalType: 'AI_EMPLOYEE' }, { actionRequestId: '' }, { delegatedByPrincipalId: randomUUID() }, { authorization: true }, { externalSubject: '' }, { principalId: 'x' }]) {
    await assert.rejects(service.recover(context(patch), leadId), e => e.getStatus() === 403, JSON.stringify(patch));
  }
  await assert.rejects(service.recover(context({ idempotencyKey: randomUUID() }), leadId), e => e.getStatus() === 409);
  await assert.rejects(service.recover(context(), 'not-a-uuid'), e => e.getStatus() === 400);
});

test('service runs one fixed function in a scoped transaction, verifies the row and maps database outcomes closed', async () => {
  let sql = []; let data = states()[3]; let failure;
  const client = { query: async (query, values) => { sql.push({ query, values }); if (failure && query.includes('read_crm_lead_registration_recovery')) throw failure; return { rows: query.includes('read_crm_lead_registration_recovery') ? [{ data }] : [] }; } };
  const service = new LeadRegistrationRecoveryService({ withTenantTransaction: async (c, work) => work(client) });
  assert.deepEqual(await service.recover(context(), leadId), data);
  assert(sql.some(x => x.query.includes("set_config('app.hon_source','HUMAN_UI',true)") && x.query.includes("set_config('app.hon_action_request_id','',true)")));
  const call = sql.find(x => x.query.includes('read_crm_lead_registration_recovery'));
  assert.equal(call.query, 'SELECT hon.read_crm_lead_registration_recovery($1,$2::uuid) AS data'); assert.deepEqual(call.values, ['verified-human', leadId]);
  data = { ...states()[3], leadId: randomUUID() }; await assert.rejects(service.recover(context(), leadId), e => e.getStatus() === 503, 'another lead');
  data = { ...states()[3], billingAccount: { ...account, id: randomUUID() } }; await assert.rejects(service.recover(context(), leadId), e => e.getStatus() === 503, 'extra field');
  data = states()[0];
  for (const [code, status] of [['42501', 403], ['P0002', 404], ['40P01', 409], ['55P03', 409], ['40001', 409], ['22023', 400], ['57014', 503], ['XX000', 503]]) {
    failure = Object.assign(new Error('db'), { code });
    await assert.rejects(service.recover(context(), leadId), e => e.getStatus() === status, code);
  }
  for (const file of ['lead-registration-recovery.service.ts', 'lead-registration-recovery.controller.ts', 'lead-registration-recovery.dto.ts']) {
    assert.doesNotMatch(readFileSync(`src/crm/${file}`, 'utf8'), /OwnerLaunch|MembershipService|BillingAccountService|ActionEngine|fetch\(|Payment|createDraft\(|register\(/);
  }
});

test('0174 is read-only, uses the canonical SHARE lock order and reuses the 0160/0162/0163 authorities', () => {
  const migration = readFileSync('../../packages/database/migrations/0174_crm_lead_registration_recovery.sql', 'utf8');
  const body = migration.match(/CREATE FUNCTION hon\.read_crm_lead_registration_recovery\([\s\S]*?\nEND \$\$;/)[0];
  assert.doesNotMatch(body, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/);
  assert.doesNotMatch(body, /idempotency_records|audit_events|outbox_events/);
  const locks = body.match(/LOCK TABLE [^;]*;/g); assert.equal(locks.length, 1);
  assert.match(locks[0], /^LOCK TABLE hon\.users,hon\.principals,hon\.principal_role_grants,hon\.roles,hon\.role_permissions,hon\.permissions,hon\.family_access_grants,hon\.hq_operator_grants,hon\.organizations,hon\.schools,hon\.organization_entitlements,hon\.people,hon\.student_profiles,hon\.families,hon\.family_members,hon\.crm_lead_registration_conversions,hon\.crm_leads,hon\.billing_accounts,hon\.memberships,hon\.crm_adult_membership_draft_sources,hon\.membership_payment_schedules,hon\.invoices IN SHARE MODE;$/);
  assert.equal(body.match(/hon\.require_crm_lead_registration_actor\(subject,'ADULT'\)/g).length, 3, 'registration authority before, after locks and before return');
  assert.equal(body.match(/hon\.require_crm_adult_membership_actor\(subject\)/g).length, 3, 'DRAFT authority before, after locks and before return');
  assert.match(body, /hon\.crm_adult_membership_relation\(c\.resulting_student_profile_id\)/);
  assert.match(body, /hon\.read_crm_adult_membership_draft_confirmation\(subject,c\.resulting_student_profile_id\)/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION hon\.read_crm_lead_registration_recovery\(text,uuid\) TO hon_runtime;/);
});
