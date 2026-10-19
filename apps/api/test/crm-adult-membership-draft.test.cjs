const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const contracts = require('@hon/contracts');
const { CrmAdultMembershipDraftController } = require('../dist/billing/crm-adult-membership-draft.controller.js');
const { CrmAdultMembershipDraftService } = require('../dist/billing/crm-adult-membership-draft.service.js');
const guards = require('../dist/billing/crm-adult-membership-draft.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const studentProfileId = randomUUID();
const input = (patch = {}) => ({ studentProfileId, planCode: 'STAFF-OPAQUE', confirmation: contracts.CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION, ...patch });
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'verified-human', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), ...patch });
const receipt = (patch = {}) => ({ membershipId: randomUUID(), state: 'DRAFT', planCode: 'STAFF-OPAQUE', termStartedAt: null, termEndsAt: null, recordedAt: '2026-10-18T20:00:00.000Z', ...patch });

test('closed adult CRM contracts reject financial/authority selectors and invalid bounds', () => {
  assert.deepEqual(contracts.validateCrmAdultMembershipDraftInput(input()), input());
  for (const key of ['accountId','billingAccountId','personId','familyId','conversionId','currency','paymentSchedule','amount','autoRenew','invoice','payment','charge','provider','agreement','discount','authorization','source','actionRequestId','idempotencyKey']) assert.throws(() => contracts.validateCrmAdultMembershipDraftInput(input({ [key]: randomUUID() })));
  for (const patch of [{ planCode: '' },{ planCode: ' x ' },{ planCode: 'x'.repeat(81) },{ planCode: 'x\n' },{ confirmation: true },{ studentProfileId: 'bad' },{ termStartedAt: null },{ termStartedAt: '2027-02-30T00:00:00.000Z' },{ termStartedAt: '2027-01-01' },{ termStartedAt: '2027-01-01T00:00:00.000Z', termEndsAt: '2026-01-01T00:00:00.000Z' }]) assert.throws(() => contracts.validateCrmAdultMembershipDraftInput(input(patch)));
  assert.throws(() => contracts.validateCrmAdultMembershipPreparationInput({ studentProfileId, search: 'Ada' }));
  assert.throws(() => contracts.verifyCrmAdultMembershipPreparation({ studentDisplayName: 'Ada', currency: 'USD', readiness: 'READY_FOR_DRAFT', accountId: randomUUID() }));
  assert.throws(() => contracts.verifyCrmAdultMembershipDraftReceipt(receipt({ state: 'ACTIVE' }), input()));
  assert.throws(() => contracts.verifyCrmAdultMembershipDraftReceipt(receipt({ planCode: 'OTHER' }), input()));
});

test('real Nest guards and global whitelist expose only separate direct-human preparation/draft endpoints', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  let calls = 0; let mixed = false;
  const database = { resolveAuthorizedScope: async (subject, school, permission) => { assert.equal(subject, 'verified-human'); assert.equal(school, scope.schoolId); assert.equal(permission, 'billing.membership.create'); return scope; } };
  const service = { prepare: async (c, p) => { calls++; assert.equal(c.idempotencyKey, ''); assert.deepEqual(Object.keys(p), ['studentProfileId']); return { studentDisplayName: 'Ada Student', currency: 'USD', readiness: 'READY_FOR_DRAFT' }; }, draft: async (c, p) => { calls++; assert.equal(c.source, 'HUMAN_UI'); return { receipt: receipt(), replayed: false }; } };
  const module = await Test.createTestingModule({ controllers: [CrmAdultMembershipDraftController], providers: [guards.CrmAdultMembershipNoStoreGuard, guards.CrmAdultMembershipDraftHumanUiGuard, guards.CrmAdultMembershipPreparationHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }, { provide: CrmAdultMembershipDraftService, useValue: service }] }).overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human', ...(mixed ? { source: 'AI' } : {}) }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.listen(0, '127.0.0.1');
  const base = `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/crm-adult-membership-drafts`;
  const request = (body, patch = {}, suffix = '', method = 'POST') => new Promise((resolve,reject) => {
    const payload = JSON.stringify(body); const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': suffix === '/preparation' ? 'crm-adult-membership-prepare' : 'crm-adult-membership-draft', ...(suffix === '/preparation' ? {} : { 'Idempotency-Key': randomUUID() }), 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty', ...patch, 'Content-Length': Buffer.byteLength(payload) };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const req = http.request({ hostname: '127.0.0.1', port: app.getHttpServer().address().port, path: base+suffix, method, headers }, res => { let data=''; res.on('data', x => data+=x); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) })); }); req.on('error',reject); req.end(payload);
  });
  try {
    assert.equal((await request({ studentProfileId }, {}, '/preparation')).status, 200);
    const result = await request(input()); assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'private, no-store'); assert.equal(result.body.data.state, 'DRAFT'); assert.equal(calls,2);
    for (const patch of [{ Origin: 'https://evil.test' },{ 'X-HON-Human-Command': 'billing.membership.create' },{ 'Sec-Fetch-Site': 'cross-site' },{ 'Sec-Fetch-Mode': 'cors' },{ 'Sec-Fetch-Dest': 'document' },{ 'Sec-Fetch-User': '?1' },{ 'Content-Type': 'text/plain' },{ 'X-HON-Action-Request-Id': randomUUID() }]) assert.equal((await request(input(), patch)).status,403);
    assert.equal((await request(input(), { 'Idempotency-Key': undefined })).status,409);
    assert.equal((await request(input(), { 'Idempotency-Key': 'not-a-uuid' })).status,409);
    assert.equal((await request(input({ currency: 'USD' }))).status,400);
    assert.equal((await request(input(), {}, '?studentProfileId='+studentProfileId)).status,400);
    mixed=true; assert.equal((await request(input())).status,403); mixed=false;
    assert.equal((await request(input(), {}, '', 'GET')).status,404); assert.equal(calls,2);
    delete process.env.HON_PUBLIC_ORIGIN; assert.equal((await request(input())).status,503);
  } finally { await app.close(); if(previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN=previous; }
});

test('service independently rejects mixed/delegated/nonhuman context before any database work', async () => {
  const service = new CrmAdultMembershipDraftService({ withTenantTransaction: async () => { throw new Error('must not enter'); }, withTenantReadOnlyTransaction: async () => { throw new Error('must not enter'); } });
  for (const patch of [{ source: 'AI' },{ source: 'AUTOMATION' },{ source: 'INTEGRATION' },{ principalType: 'AI_EMPLOYEE' },{ actionRequestId: '' },{ delegatedByPrincipalId: randomUUID() },{ authorization: true },{ externalSubject: '' }]) await assert.rejects(service.draft(context(patch),input()), e => e.getStatus()===403);
  await assert.rejects(service.draft(context({ idempotencyKey: 'bad' }),input()), e => e.getStatus()===409);
  await assert.rejects(service.prepare(context({ idempotencyKey: '' }),{ studentProfileId, accountId: randomUUID() }), e => e.getStatus()===400);
});

test('service verifies stored receipts inside the transaction and never calls generic/owner-launch billing', async () => {
  let sql=[]; let data={ receipt: receipt(), replayed: true };
  const client={ query: async (query) => { sql.push(query); return { rows: query.includes('draft_crm_adult_membership') ? [{ data }] : [] }; } };
  const service=new CrmAdultMembershipDraftService({ withTenantTransaction: async (c,work) => work(client) });
  assert.equal((await service.draft(context(),input())).replayed,true);
  assert(sql.some(x=>x.includes("set_config('app.hon_source','HUMAN_UI',true)")));
  data={ receipt: receipt({ billingAccountId: randomUUID() }), replayed: false };
  await assert.rejects(service.draft(context(),input()), e=>e.getStatus()===503);
  for(const file of ['crm-adult-membership-draft.service.ts','crm-adult-membership-draft.controller.ts']) assert.doesNotMatch(readFileSync(`src/billing/${file}`,'utf8'), /OwnerLaunch|MembershipService|ActionEngine|fetch\(|PaymentService|createDraft\(/);
  const migration=readFileSync('../../packages/database/migrations/0155_crm_adult_membership_draft.sql','utf8');
  assert.doesNotMatch(migration, /(?:INSERT INTO|UPDATE|DELETE FROM) hon\.(?:billing_accounts|membership_payment_schedules|invoices|payment_attempts|family_members|student_curriculum_enrollments|communication_messages|action_requests|ai_usage_ledger)/);
  assert.match(migration, /'executionAllowed',false,'humanOnly',true/);
});
