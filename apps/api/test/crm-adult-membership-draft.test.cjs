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
const confirmation = (patch = {}) => ({ state: 'RECORDED_DRAFT', receipt: receipt(), ...patch });

test('closed adult CRM contracts reject financial, authority, and confirmation selectors', () => {
  assert.deepEqual(contracts.validateCrmAdultMembershipDraftInput(input()), input());
  assert.deepEqual(contracts.validateCrmAdultMembershipDraftConfirmationInput({ studentProfileId }), { studentProfileId });
  for (const key of ['accountId','billingAccountId','membershipId','personId','familyId','conversionId','currency','membershipVersion','paymentSchedule','amount','autoRenew','invoice','payment','charge','provider','agreement','discount','authorization','source','actionRequestId','idempotencyKey']) {
    assert.throws(() => contracts.validateCrmAdultMembershipDraftInput(input({ [key]: randomUUID() })));
    assert.throws(() => contracts.validateCrmAdultMembershipDraftConfirmationInput({ studentProfileId, [key]: randomUUID() }));
  }
  for (const patch of [{ planCode: '' },{ planCode: ' x ' },{ planCode: 'x'.repeat(81) },{ planCode: 'x\n' },{ confirmation: true },{ studentProfileId: 'bad' },{ termStartedAt: null },{ termStartedAt: '2027-02-30T00:00:00.000Z' },{ termStartedAt: '2027-01-01' },{ termStartedAt: '2027-01-01T00:00:00.000Z', termEndsAt: '2026-01-01T00:00:00.000Z' }]) assert.throws(() => contracts.validateCrmAdultMembershipDraftInput(input(patch)));
  assert.throws(() => contracts.validateCrmAdultMembershipPreparationInput({ studentProfileId, search: 'Ada' }));
  assert.throws(() => contracts.verifyCrmAdultMembershipPreparation({ studentDisplayName: 'Ada', currency: 'USD', readiness: 'READY_FOR_DRAFT', accountId: randomUUID() }));
  const current = confirmation(); assert.deepEqual(contracts.verifyCrmAdultMembershipDraftConfirmation(current), current);
  assert.throws(() => contracts.verifyCrmAdultMembershipDraftConfirmation({ state: 'ACTIVE', receipt: receipt() }));
  assert.throws(() => contracts.verifyCrmAdultMembershipDraftConfirmation({ state: 'RECORDED_DRAFT', receipt: { ...receipt(), accountId: randomUUID() } }));
  assert.throws(() => contracts.verifyCrmAdultMembershipDraftReceipt(receipt({ state: 'ACTIVE' }), input()));
  assert.throws(() => contracts.verifyCrmAdultMembershipDraftReceipt(receipt({ planCode: 'OTHER' }), input()));
});

test('real Nest guards and global whitelist expose only separate direct-human preparation, confirmation, and draft endpoints', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  let calls = 0; let mixed = false;
  const database = { resolveAuthorizedScope: async (subject, school, permission) => { assert.equal(subject, 'verified-human'); assert.equal(school, scope.schoolId); assert.equal(permission, 'billing.membership.create'); return scope; } };
  const service = {
    prepare: async (c, p) => { calls++; assert.equal(c.idempotencyKey, ''); assert.deepEqual(Object.keys(p), ['studentProfileId']); return { studentDisplayName: 'Ada Student', currency: 'USD', readiness: 'READY_FOR_DRAFT' }; },
    confirmCurrentDraft: async (c, p) => { calls++; assert.equal(c.idempotencyKey, ''); assert.deepEqual(Object.keys(p), ['studentProfileId']); return confirmation(); },
    draft: async (c, p) => { calls++; assert.equal(c.source, 'HUMAN_UI'); return { receipt: receipt(), replayed: false }; },
  };
  const module = await Test.createTestingModule({ controllers: [CrmAdultMembershipDraftController], providers: [guards.CrmAdultMembershipNoStoreGuard, guards.CrmAdultMembershipDraftHumanUiGuard, guards.CrmAdultMembershipPreparationHumanUiGuard, guards.CrmAdultMembershipConfirmationHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }, { provide: CrmAdultMembershipDraftService, useValue: service }] }).overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human', ...(mixed ? { source: 'AI' } : {}) }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.listen(0, '127.0.0.1');
  const base = `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/crm-adult-membership-drafts`;
  const request = (body, patch = {}, suffix = '', method = 'POST') => new Promise((resolve,reject) => {
    const payload = JSON.stringify(body); const read = suffix === '/preparation' || suffix === '/confirmation';
    const marker = suffix === '/preparation' ? 'crm-adult-membership-prepare' : suffix === '/confirmation' ? 'crm-adult-membership-draft-confirmation' : 'crm-adult-membership-draft';
    const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': marker, ...(read ? {} : { 'Idempotency-Key': randomUUID() }), 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty', ...patch, 'Content-Length': Buffer.byteLength(payload) };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const req = http.request({ hostname: '127.0.0.1', port: app.getHttpServer().address().port, path: base+suffix, method, headers }, res => { let data=''; res.on('data', x => data+=x); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) })); }); req.on('error',reject); req.end(payload);
  });
  try {
    assert.equal((await request({ studentProfileId }, {}, '/preparation')).status, 200);
    const current = await request({ studentProfileId }, {}, '/confirmation'); assert.equal(current.status, 200); assert.equal(current.headers['cache-control'], 'private, no-store'); assert.equal(current.body.data.state, 'RECORDED_DRAFT'); assert.equal(current.body.meta.replayed, false);
    const result = await request(input()); assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'private, no-store'); assert.equal(result.body.data.state, 'DRAFT'); assert.equal(calls,3);
    for (const patch of [{ Origin: 'https://evil.test' },{ 'X-HON-Human-Command': 'billing.membership.create' },{ 'Sec-Fetch-Site': 'cross-site' },{ 'Sec-Fetch-Mode': 'cors' },{ 'Sec-Fetch-Dest': 'document' },{ 'Sec-Fetch-User': '?1' },{ 'Content-Type': 'text/plain' },{ 'X-HON-Action-Request-Id': randomUUID() }]) assert.equal((await request({ studentProfileId }, patch, '/confirmation')).status,403);
    assert.equal((await request({ studentProfileId }, { 'Idempotency-Key': randomUUID() }, '/confirmation')).status,409);
    assert.equal((await request(input(), { 'Idempotency-Key': undefined })).status,409);
    assert.equal((await request(input(), { 'Idempotency-Key': 'not-a-uuid' })).status,409);
    assert.equal((await request({ studentProfileId, currency: 'USD' }, {}, '/confirmation')).status,400);
    assert.equal((await request({ studentProfileId }, {}, `/confirmation?studentProfileId=${studentProfileId}`)).status,400);
    mixed=true; assert.equal((await request({ studentProfileId }, {}, '/confirmation')).status,403); mixed=false;
    assert.equal((await request({ studentProfileId }, {}, '/confirmation', 'GET')).status,404); assert.equal(calls,3);
    delete process.env.HON_PUBLIC_ORIGIN; assert.equal((await request({ studentProfileId }, {}, '/confirmation')).status,503);
  } finally { await app.close(); if(previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN=previous; }
});

test('service independently rejects mixed, delegated, nonhuman, malformed, and idempotency-invalid context before database work', async () => {
  const service = new CrmAdultMembershipDraftService({ withTenantTransaction: async () => { throw new Error('must not enter'); }, withTenantReadOnlyTransaction: async () => { throw new Error('must not enter'); } });
  for (const patch of [{ source: 'AI' },{ source: 'AUTOMATION' },{ source: 'INTEGRATION' },{ principalType: 'AI_EMPLOYEE' },{ actionRequestId: '' },{ delegatedByPrincipalId: randomUUID() },{ authorization: true },{ externalSubject: '' }]) {
    await assert.rejects(service.draft(context(patch),input()), e => e.getStatus()===403);
    await assert.rejects(service.confirmCurrentDraft(context({ ...patch, idempotencyKey: '' }),{ studentProfileId }), e => e.getStatus()===403);
  }
  await assert.rejects(service.draft(context({ idempotencyKey: 'bad' }),input()), e => e.getStatus()===409);
  await assert.rejects(service.prepare(context({ idempotencyKey: '' }),{ studentProfileId, accountId: randomUUID() }), e => e.getStatus()===400);
  await assert.rejects(service.confirmCurrentDraft(context({ idempotencyKey: '' }),{ studentProfileId, membershipId: randomUUID() }), e => e.getStatus()===400);
});

test('service verifies current confirmation and stored creation receipts inside scoped transactions without generic or owner-launch billing', async () => {
  let sql=[]; let draftData={ receipt: receipt(), replayed: true }; let currentData=confirmation();
  const client={ query: async (query) => { sql.push(query); return { rows: query.includes('read_crm_adult_membership_draft_confirmation') ? [{ data: currentData }] : query.includes('draft_crm_adult_membership') ? [{ data: draftData }] : [] }; } };
  const service=new CrmAdultMembershipDraftService({ withTenantTransaction: async (c,work) => work(client) });
  assert.equal((await service.draft(context(),input())).replayed,true);
  assert.equal((await service.confirmCurrentDraft(context({ idempotencyKey: '' }),{ studentProfileId })).state,'RECORDED_DRAFT');
  assert(sql.some(x=>x.includes("set_config('app.hon_source','HUMAN_UI',true)"))); assert(sql.some(x=>x.includes('read_crm_adult_membership_draft_confirmation')));
  draftData={ receipt: receipt({ billingAccountId: randomUUID() }), replayed: false }; currentData={ state: 'RECORDED_DRAFT', receipt: { ...receipt(), personId: randomUUID() } };
  await assert.rejects(service.draft(context(),input()), e=>e.getStatus()===503);
  await assert.rejects(service.confirmCurrentDraft(context({ idempotencyKey: '' }),{ studentProfileId }), e=>e.getStatus()===503);
  for(const file of ['crm-adult-membership-draft.service.ts','crm-adult-membership-draft.controller.ts']) assert.doesNotMatch(readFileSync(`src/billing/${file}`,'utf8'), /OwnerLaunch|MembershipService|ActionEngine|fetch\(|PaymentService|createDraft\(/);
  const migrations=[readFileSync('../../packages/database/migrations/0162_crm_adult_membership_draft.sql','utf8'),readFileSync('../../packages/database/migrations/0163_crm_adult_membership_draft_confirmation.sql','utf8'),readFileSync('../../packages/database/migrations/0168_crm_adult_membership_draft_lock_order.sql','utf8')];
  for(const migration of migrations) assert.doesNotMatch(migration, /(?:INSERT INTO|UPDATE|DELETE FROM) hon\.(?:billing_accounts|membership_payment_schedules|invoices|payment_attempts|family_members|student_curriculum_enrollments|communication_messages|action_requests|ai_usage_ledger)/);
  assert.match(migrations[0], /'executionAllowed',false,'humanOnly',true/); assert.match(migrations[2], /'executionAllowed',false,'humanOnly',true/); assert.match(migrations[2], /LOCK TABLE hon\.idempotency_records IN SHARE ROW EXCLUSIVE MODE;\s*LOCK TABLE hon\.users,/); assert.match(migrations[1], /read_crm_adult_membership_draft_confirmation/);
});
