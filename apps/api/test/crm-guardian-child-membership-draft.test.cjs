const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const contracts = require('@hon/contracts');
const controllers = require('../dist/billing/crm-guardian-child-membership-draft.controller.js');
const { CrmGuardianChildMembershipDraftService } = require('../dist/billing/crm-guardian-child-membership-draft.service.js');
const guards = require('../dist/billing/crm-guardian-child-membership-draft.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const studentProfileId = randomUUID();
const payerInput = (patch = {}) => ({ studentProfileId, confirmation: contracts.CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION, ...patch });
const draftInput = (patch = {}) => ({ studentProfileId, planCode: 'STAFF-OPAQUE', confirmation: contracts.CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION, ...patch });
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'verified-human', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), ...patch });
const payerPreparation = (patch = {}) => ({ studentDisplayName: 'Ada Student', guardianDisplayName: 'Grace Guardian', currency: 'USD', readiness: 'READY_FOR_PAYER_DESIGNATION', ...patch });
const payerReceipt = (patch = {}) => ({ studentDisplayName: 'Ada Student', guardianDisplayName: 'Grace Guardian', currency: 'USD', state: 'PAYER_DESIGNATED', recordedAt: '2026-10-18T20:00:00.000Z', ...patch });
const draftPreparation = (patch = {}) => ({ studentDisplayName: 'Ada Student', guardianDisplayName: 'Grace Guardian', currency: 'USD', readiness: 'READY_FOR_DRAFT', ...patch });
const receipt = (patch = {}) => ({ membershipId: randomUUID(), state: 'DRAFT', planCode: 'STAFF-OPAQUE', termStartedAt: null, termEndsAt: null, recordedAt: '2026-10-18T20:00:00.000Z', ...patch });
const confirmation = (patch = {}) => ({ state: 'RECORDED_DRAFT', receipt: receipt(), ...patch });

function assertNoPayerOrSourceLeak(value) {
  assert.doesNotMatch(JSON.stringify(value), /(?:accountId|billingAccountId|payerId|guardianId|personId|familyId|conversionId|scope|authority|payment|provider)/i);
}

test('closed guardian-child contracts validate exact requests, receipts, and API envelopes without source or payer leakage', () => {
  assert.deepEqual(contracts.validateCrmGuardianChildPayerDesignationPreparationInput({ studentProfileId }), { studentProfileId });
  assert.deepEqual(contracts.validateCrmGuardianChildPayerDesignationInput(payerInput()), payerInput());
  assert.deepEqual(contracts.validateCrmGuardianChildMembershipPreparationInput({ studentProfileId }), { studentProfileId });
  assert.deepEqual(contracts.validateCrmGuardianChildMembershipDraftConfirmationInput({ studentProfileId }), { studentProfileId });
  assert.deepEqual(contracts.validateCrmGuardianChildMembershipDraftInput(draftInput()), draftInput());
  for (const key of ['guardianId', 'payerId', 'personId', 'familyId', 'conversionId', 'accountId', 'billingAccountId', 'currency', 'price', 'amount', 'payment', 'provider', 'schedule', 'authority', 'source', 'actionRequestId', 'idempotencyKey']) {
    assert.throws(() => contracts.validateCrmGuardianChildPayerDesignationInput(payerInput({ [key]: randomUUID() })));
    assert.throws(() => contracts.validateCrmGuardianChildMembershipDraftInput(draftInput({ [key]: randomUUID() })));
    assert.throws(() => contracts.validateCrmGuardianChildMembershipDraftConfirmationInput({ studentProfileId, [key]: randomUUID() }));
  }
  for (const invalid of [
    () => contracts.validateCrmGuardianChildPayerDesignationInput({ studentProfileId }),
    () => contracts.validateCrmGuardianChildMembershipDraftInput(draftInput({ planCode: ' x ' })),
    () => contracts.validateCrmGuardianChildMembershipDraftInput(draftInput({ termStartedAt: '2026-02-30T00:00:00.000Z' })),
    () => contracts.validateCrmGuardianChildMembershipDraftInput(draftInput({ termStartedAt: '2027-01-01T00:00:00.000Z', termEndsAt: '2026-01-01T00:00:00.000Z' })),
    () => contracts.verifyCrmGuardianChildPayerDesignationPreparation(payerPreparation({ accountId: randomUUID() })),
    () => contracts.verifyCrmGuardianChildPayerDesignationReceipt(payerReceipt({ guardianId: randomUUID() })),
    () => contracts.verifyCrmGuardianChildMembershipPreparation(draftPreparation({ currency: 'usd' })),
    () => contracts.verifyCrmGuardianChildMembershipDraftReceipt(receipt({ personId: randomUUID() }), draftInput()),
    () => contracts.verifyCrmGuardianChildMembershipDraftReceipt(receipt({ planCode: 'OTHER' }), draftInput()),
  ]) assert.throws(invalid);
  const meta = { requestId: randomUUID(), correlationId: randomUUID(), replayed: false };
  const payerEnvelope = { data: payerReceipt(), meta: { ...meta, replayed: true } };
  const currentEnvelope = { data: confirmation(), meta };
  assert.deepEqual(contracts.verifyCrmGuardianChildPayerDesignationApiResponse(payerEnvelope), payerEnvelope);
  assert.deepEqual(contracts.verifyCrmGuardianChildMembershipDraftConfirmationApiResponse(currentEnvelope), currentEnvelope);
  assert.throws(() => contracts.verifyCrmGuardianChildMembershipPreparationApiResponse({ data: draftPreparation(), meta: { ...meta, extra: true } }));
  assert.throws(() => contracts.verifyCrmGuardianChildMembershipDraftApiResponse({ data: receipt(), meta: { ...meta, replayed: 'false' } }, draftInput()));
  assertNoPayerOrSourceLeak(payerEnvelope); assertNoPayerOrSourceLeak(currentEnvelope);
});

test('real Nest guards expose only the exact same-origin guardian-child payer and DRAFT POST surfaces', async () => {
  const previousOrigin = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  let calls = 0; let mixed = false;
  const database = { resolveAuthorizedScope: async (subject, school, permission) => {
    assert.equal(subject, 'verified-human'); assert.equal(school, scope.schoolId); assert.equal(permission, 'billing.membership.create'); return scope;
  } };
  const service = {
    preparePayerDesignation: async (c, input) => { calls++; assert.equal(c.idempotencyKey, ''); assert.deepEqual(Object.keys(input), ['studentProfileId']); return payerPreparation(); },
    designatePayer: async (c, input) => { calls++; assert.equal(c.source, 'HUMAN_UI'); assert.deepEqual(Object.keys(input).sort(), ['confirmation', 'studentProfileId']); return { receipt: payerReceipt(), replayed: false }; },
    prepareMembershipDraft: async (c, input) => { calls++; assert.equal(c.idempotencyKey, ''); assert.deepEqual(Object.keys(input), ['studentProfileId']); return draftPreparation(); },
    confirmCurrentMembershipDraft: async (c, input) => { calls++; assert.equal(c.idempotencyKey, ''); assert.deepEqual(Object.keys(input), ['studentProfileId']); return confirmation(); },
    draftMembership: async (c, input) => { calls++; assert.equal(c.source, 'HUMAN_UI'); assert.deepEqual(Object.keys(input).sort(), ['confirmation', 'planCode', 'studentProfileId']); return { receipt: receipt(), replayed: true }; },
  };
  const module = await Test.createTestingModule({
    controllers: [controllers.CrmGuardianChildPayerDesignationController, controllers.CrmGuardianChildMembershipDraftController],
    providers: [
      guards.CrmGuardianChildMembershipNoStoreGuard,
      guards.CrmGuardianChildMembershipHumanUiGuard,
      guards.CrmGuardianChildPayerDesignationHumanUiGuard,
      guards.CrmGuardianChildPayerDesignationPreparationHumanUiGuard,
      guards.CrmGuardianChildMembershipPreparationHumanUiGuard,
      guards.CrmGuardianChildMembershipConfirmationHumanUiGuard,
      { provide: RuntimeDatabaseService, useValue: database },
      { provide: CrmGuardianChildMembershipDraftService, useValue: service },
    ],
  }).overrideGuard(HonIdentityGuard).useValue({ canActivate(c) {
    c.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human', ...(mixed ? { source: 'AI' } : {}) }; return true;
  } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.listen(0, '127.0.0.1');
  const payerBase = `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/crm-guardian-child-payer-designations`;
  const draftBase = `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/crm-guardian-child-membership-drafts`;
  const request = (base, suffix, body, patch = {}, method = 'POST') => new Promise((resolve, reject) => {
    const isRead = suffix === '/preparation' || suffix === '/confirmation';
    const marker = base === payerBase ? (suffix === '/preparation' ? 'crm-guardian-child-payer-designation-prepare' : 'crm-guardian-child-payer-designation') : (suffix === '/preparation' ? 'crm-guardian-child-membership-prepare' : suffix === '/confirmation' ? 'crm-guardian-child-membership-confirmation' : 'crm-guardian-child-membership-draft');
    const payload = JSON.stringify(body);
    const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': marker, ...(isRead ? {} : { 'Idempotency-Key': randomUUID() }), 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty', ...patch, 'Content-Length': Buffer.byteLength(payload) };
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
    const req = http.request({ hostname: '127.0.0.1', port: app.getHttpServer().address().port, path: base + suffix, method, headers }, res => { let data = ''; res.on('data', part => data += part); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) })); });
    req.on('error', reject); req.end(payload);
  });
  try {
    for (const [base, suffix, body] of [[payerBase, '/preparation', { studentProfileId }], [payerBase, '', payerInput()], [draftBase, '/preparation', { studentProfileId }], [draftBase, '/confirmation', { studentProfileId }], [draftBase, '', draftInput()]]) {
      const result = await request(base, suffix, body); assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'private, no-store'); assertNoPayerOrSourceLeak(result.body.data);
    }
    assert.equal(calls, 5);
    for (const patch of [{ Origin: 'https://evil.test' }, { 'X-HON-Human-Command': 'billing.membership.create' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Mode': 'cors' }, { 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-User': '?1' }, { 'Content-Type': 'text/plain' }, { 'X-HON-Action-Request-Id': randomUUID() }]) {
      assert.equal((await request(draftBase, '/confirmation', { studentProfileId }, patch)).status, 403);
    }
    assert.equal((await request(payerBase, '/preparation', { studentProfileId }, { 'Idempotency-Key': randomUUID() })).status, 409);
    assert.equal((await request(draftBase, '/confirmation', { studentProfileId }, { 'Idempotency-Key': randomUUID() })).status, 409);
    assert.equal((await request(payerBase, '', payerInput(), { 'Idempotency-Key': undefined })).status, 409);
    assert.equal((await request(draftBase, '', draftInput(), { 'Idempotency-Key': 'not-a-uuid' })).status, 409);
    assert.equal((await request(draftBase, '/confirmation', { studentProfileId, guardianId: randomUUID() })).status, 400);
    assert.equal((await request(draftBase, '/confirmation?studentProfileId=' + studentProfileId, { studentProfileId })).status, 400);
    mixed = true; assert.equal((await request(payerBase, '/preparation', { studentProfileId })).status, 403); mixed = false;
    assert.equal((await request(draftBase, '/confirmation', { studentProfileId }, {}, 'GET')).status, 404);
    assert.equal(calls, 5);
  } finally { await app.close(); if (previousOrigin === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previousOrigin; }
});

test('service uses only exact source-bound functions and independently closes contexts, receipt leaks, and database errors', async () => {
  const sql = [];
  const client = { query: async (query) => {
    sql.push(query);
    if (query.includes('payer_designation_preparation')) return { rows: [{ data: payerPreparation() }] };
    if (query.includes('designate_crm_guardian_child_payer')) return { rows: [{ data: { receipt: payerReceipt(), replayed: false } }] };
    if (query.includes('membership_preparation')) return { rows: [{ data: draftPreparation() }] };
    if (query.includes('membership_draft_confirmation')) return { rows: [{ data: confirmation() }] };
    if (query.includes('draft_crm_guardian_child_membership')) return { rows: [{ data: { receipt: receipt(), replayed: true } }] };
    return { rows: [] };
  } };
  const service = new CrmGuardianChildMembershipDraftService({ withTenantReadOnlyTransaction: async (c, work) => work(client), withTenantTransaction: async (c, work) => work(client) });
  assert.equal((await service.preparePayerDesignation(context({ idempotencyKey: '' }), { studentProfileId })).readiness, 'READY_FOR_PAYER_DESIGNATION');
  assert.equal((await service.designatePayer(context(), payerInput())).receipt.state, 'PAYER_DESIGNATED');
  assert.equal((await service.prepareMembershipDraft(context({ idempotencyKey: '' }), { studentProfileId })).readiness, 'READY_FOR_DRAFT');
  assert.equal((await service.confirmCurrentMembershipDraft(context({ idempotencyKey: '' }), { studentProfileId })).state, 'RECORDED_DRAFT');
  assert.equal((await service.draftMembership(context(), draftInput())).replayed, true);
  for (const functionName of ['read_crm_guardian_child_payer_designation_preparation', 'designate_crm_guardian_child_payer', 'read_crm_guardian_child_membership_preparation', 'draft_crm_guardian_child_membership', 'read_crm_guardian_child_membership_draft_confirmation']) assert(sql.some(query => query.includes(functionName)));
  assert(sql.some(query => query.includes("set_config('app.hon_source','HUMAN_UI',true)")));
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { actionRequestId: '' }, { delegatedByPrincipalId: randomUUID() }, { authorization: true }, { externalSubject: '' }]) {
    await assert.rejects(service.draftMembership(context(patch), draftInput()), error => error.getStatus() === 403);
    await assert.rejects(service.confirmCurrentMembershipDraft(context({ ...patch, idempotencyKey: '' }), { studentProfileId }), error => error.getStatus() === 403);
  }
  await assert.rejects(service.prepareMembershipDraft(context({ idempotencyKey: '' }), { studentProfileId, payerId: randomUUID() }), error => error.getStatus() === 400);
  const failing = code => new CrmGuardianChildMembershipDraftService({ withTenantReadOnlyTransaction: async () => { throw { code }; }, withTenantTransaction: async () => { throw { code }; } });
  await assert.rejects(failing('P0002').prepareMembershipDraft(context({ idempotencyKey: '' }), { studentProfileId }), error => error.getStatus() === 404);
  await assert.rejects(failing('42501').draftMembership(context(), draftInput()), error => error.getStatus() === 403);
  await assert.rejects(failing('23505').draftMembership(context(), draftInput()), error => error.getStatus() === 409);
  await assert.rejects(failing('22023').draftMembership(context(), draftInput()), error => error.getStatus() === 400);
  await assert.rejects(failing('XX000').draftMembership(context(), draftInput()), error => error.getStatus() === 503);
  const source = readFileSync('src/billing/crm-guardian-child-membership-draft.service.ts', 'utf8');
  assert.doesNotMatch(source, /(?:MembershipService|BillingAccountService|OwnerLaunch|ActionEngine|PaymentService|createDraft\()/);
  assert.match(readFileSync('src/billing/crm-adult-membership-draft.controller.ts', 'utf8'), /crm-adult-membership-drafts/);
  assert.match(readFileSync('src/billing/membership.controller.ts', 'utf8'), /@Controller\('organizations\/:organizationId\/schools\/:schoolId\/billing\/memberships'\)/);
});
