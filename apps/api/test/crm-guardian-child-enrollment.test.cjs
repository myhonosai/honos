const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const contracts = require('@hon/contracts');
const { GuardianChildEnrollmentController, GuardianChildMembershipDraftController } = require('../dist/crm/guardian-child-enrollment.controller.js');
const { GuardianChildEnrollmentService } = require('../dist/crm/guardian-child-enrollment.service.js');
const guards = require('../dist/crm/guardian-child-enrollment.dto.js');
const { CrmAdultMembershipNoStoreGuard } = require('../dist/billing/crm-adult-membership-draft.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => { const id = randomUUID(); return { ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'verified-human', requestId: id, correlationId: id, idempotencyKey: randomUUID(), ...patch }; };
const read = (patch = {}) => context({ idempotencyKey: '', ...patch });
const DESIGNATE = { confirmation: contracts.CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION };
const child = (patch = {}) => ({ childGivenName: 'Mia', childFamilyName: 'Lopez', childBirthDate: '2016-04-05', confirmation: contracts.CRM_GUARDIAN_CHILD_ADDITION_CONFIRMATION, ...patch });
const plan = (patch = {}) => ({ planId: randomUUID(), planCode: 'KIDS-MONTHLY', version: 1, displayName: 'Kids Monthly', description: null, programId: null, availability: 'AVAILABLE',
  currency: 'USD', priceMinor: 12900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', termMonths: null, publishedAt: '2026-10-21T08:00:00.000Z', ...patch });
const draftReceipt = (patch = {}) => ({ membershipId: randomUUID(), state: 'DRAFT', planCode: 'KIDS-MONTHLY', termStartedAt: null, termEndsAt: null, recordedAt: '2026-10-21T08:01:00.000Z', ...patch });
const designation = (patch = {}) => ({ state: 'PAYER_DESIGNATED', guardianDisplayName: 'Ana Lopez', currency: 'USD', recordedAt: '2026-10-21T08:00:30.000Z', ...patch });
function family(leadId, patch = {}) {
  const studentProfileId = randomUUID();
  return { leadId, workflowState: 'PAYER_DESIGNATED',
    historicalRegistrationReceipt: { outcome: 'REGISTERED', leadId, sourceContactPersonId: randomUUID(), registrationPath: 'GUARDIAN_CHILD', studentProfileId, familyId: randomUUID(), recordedAt: '2026-10-21T08:00:00.000Z' },
    guardian: { displayName: 'Ana Lopez' }, billingAccount: { classification: 'CANONICAL', currency: 'USD' }, payerDesignation: designation(),
    children: [{ studentProfileId, displayName: 'Mia Lopez', origin: 'CRM_REGISTRATION', workflowState: 'READY_FOR_DRAFT' }], ...patch };
}

test('closed inputs: one confirmation per command, no payer, account, relationship or price selectors', () => {
  assert.deepEqual(contracts.validateCrmGuardianChildEnrollmentReadInput({}), {});
  for (const body of [{ leadId: randomUUID() }, null, []]) assert.throws(() => contracts.validateCrmGuardianChildEnrollmentReadInput(body));
  assert.deepEqual(contracts.validateCrmGuardianChildPayerDesignationInput(DESIGNATE), DESIGNATE);
  for (const patch of [{ confirmation: 'yes' }, { billingAccountId: randomUUID() }, { guardianPersonId: randomUUID() }, { payerPersonId: randomUUID() }, { relationship: 'MOTHER' }]) {
    assert.throws(() => contracts.validateCrmGuardianChildPayerDesignationInput({ ...DESIGNATE, ...patch }), JSON.stringify(patch));
  }
  assert.deepEqual(contracts.validateCrmGuardianChildAdditionInput(child()), child());
  for (const patch of [{ childGivenName: '' }, { childGivenName: ' Mia' }, { childGivenName: 'a<b' }, { childBirthDate: '2016-02-30' }, { childBirthDate: '1899-12-31' }, { childBirthDate: '2999-01-01' },
    { personId: randomUUID() }, { familyId: randomUUID() }, { guardianPersonId: randomUUID() }, { mergeWith: randomUUID() }, { confirmation: contracts.CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION }]) {
    assert.throws(() => contracts.validateCrmGuardianChildAdditionInput(child(patch)), JSON.stringify(patch));
  }
  const draft = { studentProfileId: randomUUID(), membershipPlanId: randomUUID(), membershipPlanVersion: 2, confirmation: contracts.CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION };
  assert.deepEqual(contracts.validateCrmGuardianChildMembershipDraftFromPlanInput(draft), draft);
  for (const patch of [{ planCode: 'KIDS' }, { billingAccountId: randomUUID() }, { priceMinor: 1 }, { membershipPlanVersion: 0 }, { membershipPlanVersion: '2' }, { termEndsAt: '2027-01-01T00:00:00.000Z' },
    { confirmation: contracts.CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION }]) {
    assert.throws(() => contracts.validateCrmGuardianChildMembershipDraftFromPlanInput({ ...draft, ...patch }), JSON.stringify(patch));
  }
});

test('closed verifiers: family and child states, creator-only DRAFT detail, exact addition and DRAFT receipts', () => {
  const lead = randomUUID();
  const good = family(lead);
  assert.deepEqual(contracts.verifyCrmGuardianChildEnrollment(good, lead.toUpperCase()), good);
  for (const state of ['NOT_REGISTERED', 'NEEDS_STAFF_REVIEW', 'ADULT_REGISTRATION']) {
    assert.deepEqual(contracts.verifyCrmGuardianChildEnrollment({ leadId: lead, workflowState: state }, lead), { leadId: lead, workflowState: state });
    assert.throws(() => contracts.verifyCrmGuardianChildEnrollment({ leadId: lead, workflowState: state, children: [] }, lead), 'short states disclose nothing else');
  }
  const { billingAccount, payerDesignation, ...bare } = good;
  assert.equal(contracts.verifyCrmGuardianChildEnrollment({ ...bare, workflowState: 'BILLING_ACCOUNT_REQUIRED', children: [{ ...good.children[0], workflowState: 'AWAITING_PAYER_DESIGNATION' }] }, lead).workflowState, 'BILLING_ACCOUNT_REQUIRED');
  assert.equal(contracts.verifyCrmGuardianChildEnrollment({ ...bare, billingAccount, workflowState: 'PAYER_DESIGNATION_REQUIRED', children: [{ ...good.children[0], workflowState: 'AWAITING_PAYER_DESIGNATION' }] }, lead).workflowState, 'PAYER_DESIGNATION_REQUIRED');
  const p = plan(); const r = draftReceipt();
  const creator = { ...good.children[0], workflowState: 'CURRENT_DRAFT', currentMembershipDraft: { state: 'RECORDED_DRAFT', receipt: r, plan: p } };
  assert.deepEqual(contracts.verifyCrmGuardianChildEnrollment({ ...good, children: [creator] }, lead).children[0].currentMembershipDraft.receipt, r);
  const other = { ...good.children[0], workflowState: 'CURRENT_DRAFT_BY_OTHER_STAFF', currentMembershipDraft: { state: 'RECORDED_DRAFT' } };
  assert.deepEqual(contracts.verifyCrmGuardianChildEnrollment({ ...good, children: [other] }, lead).children[0].currentMembershipDraft, { state: 'RECORDED_DRAFT' });
  const extra = { ...good.children[0], studentProfileId: randomUUID(), displayName: 'Leo Lopez', origin: 'ADDITIONAL_CHILD', workflowState: 'NEEDS_STAFF_REVIEW' };
  assert.equal(contracts.verifyCrmGuardianChildEnrollment({ ...good, children: [good.children[0], extra] }, lead).children.length, 2);
  for (const bad of [
    { ...good, leadId: randomUUID() }, { ...good, extra: 1 }, { ...good, payerDesignation: undefined }, { ...good, billingAccount: { classification: 'ADDITIONAL', currency: 'USD' } },
    { ...good, billingAccount: { classification: 'CANONICAL', currency: 'USD', id: randomUUID() } }, { ...good, payerDesignation: designation({ currency: 'EUR' }) },
    { ...good, workflowState: 'PAYER_DESIGNATION_REQUIRED' }, { ...good, children: [] }, { ...good, children: [{ ...good.children[0], workflowState: 'AWAITING_PAYER_DESIGNATION' }] },
    { ...good, children: [{ ...other, currentMembershipDraft: { state: 'RECORDED_DRAFT', receipt: r, plan: p } }] }, { ...good, children: [{ ...creator, currentMembershipDraft: { state: 'RECORDED_DRAFT' } }] },
    { ...good, children: [good.children[0], { ...extra, origin: 'CRM_REGISTRATION' }] }, { ...good, children: [good.children[0], good.children[0]] },
    { ...good, children: [{ ...good.children[0], studentProfileId: randomUUID() }] }, { ...good, children: Array.from({ length: 11 }, (_, i) => i ? { ...extra, studentProfileId: randomUUID() } : good.children[0]) },
    { ...good, guardian: { displayName: 'Ana', personId: randomUUID() } }, { ...good, historicalRegistrationReceipt: { ...good.historicalRegistrationReceipt, registrationPath: 'ADULT' } },
  ]) assert.throws(() => contracts.verifyCrmGuardianChildEnrollment(JSON.parse(JSON.stringify(bad)), lead), JSON.stringify(bad).slice(0, 120));
  const added = { outcome: 'CHILD_ADDED', leadId: lead, studentProfileId: randomUUID(), childDisplayName: 'Mia Lopez', recordedAt: '2026-10-21T08:02:00.000Z' };
  assert.deepEqual(contracts.verifyCrmGuardianChildAdditionResult(added, lead, child()), added);
  assert.deepEqual(contracts.verifyCrmGuardianChildAdditionResult({ outcome: 'NEEDS_STAFF_REVIEW' }, lead), { outcome: 'NEEDS_STAFF_REVIEW' });
  for (const bad of [{ ...added, leadId: randomUUID() }, { ...added, childDisplayName: 'Other Name' }, { ...added, personId: randomUUID() }, { outcome: 'NEEDS_STAFF_REVIEW', candidates: [] }]) {
    assert.throws(() => contracts.verifyCrmGuardianChildAdditionResult(bad, lead, child()), JSON.stringify(bad));
  }
  const input = { studentProfileId: randomUUID(), membershipPlanId: p.planId, membershipPlanVersion: 1, confirmation: contracts.CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION };
  assert.deepEqual(contracts.verifyCrmGuardianChildMembershipDraftFromPlan({ receipt: r, plan: p }, input), { receipt: r, plan: p });
  for (const bad of [{ receipt: { ...r, planCode: 'OTHER' }, plan: p }, { receipt: r, plan: { ...p, version: 2 } }, { receipt: { ...r, state: 'ACTIVE' }, plan: p }, { receipt: r, plan: p, schedule: [] }]) {
    assert.throws(() => contracts.verifyCrmGuardianChildMembershipDraftFromPlan(bad, input), JSON.stringify(bad).slice(0, 80));
  }
});

test('real Nest guards: one direct-human marker per route, keys only on commands, closed bodies, live registration scope', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const calls = []; let resolved = scope; const lead = randomUUID(); const p = plan();
  const database = { resolveCrmLeadRegistrationScope: async (subject, school) => { assert.equal(subject, 'verified-human'); assert.equal(school, scope.schoolId); return resolved; } };
  const service = {
    read: async (c, leadId) => { calls.push(['read', c, leadId]); return family(leadId); },
    designatePayer: async (c, leadId, input) => { calls.push(['designate', c, leadId, input]); return { receipt: designation(), replayed: false }; },
    addChild: async (c, leadId, input) => { calls.push(['add', c, leadId, input]); return { result: { outcome: 'NEEDS_STAFF_REVIEW' }, replayed: false }; },
    draftMembershipFromPlan: async (c, input) => { calls.push(['draft', c, input]); return { receipt: draftReceipt(), plan: p, replayed: true }; },
  };
  const module = await Test.createTestingModule({ controllers: [GuardianChildEnrollmentController, GuardianChildMembershipDraftController],
    providers: [CrmAdultMembershipNoStoreGuard, guards.CrmGuardianChildEnrollmentReadHumanUiGuard, guards.CrmGuardianChildPayerDesignationHumanUiGuard, guards.CrmGuardianChildAdditionHumanUiGuard,
      guards.CrmGuardianChildMembershipDraftFromPlanHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }, { provide: GuardianChildEnrollmentService, useValue: service }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.listen(0, '127.0.0.1');
  const base = `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}`;
  const request = (path, command, body, patch = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': command, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty', ...patch, 'Content-Length': Buffer.byteLength(payload) };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const req = http.request({ hostname: '127.0.0.1', port: app.getHttpServer().address().port, path: `${base}${path}`, method: 'POST', headers }, res => { let data = ''; res.on('data', x => data += x); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null })); });
    req.on('error', reject); req.end(payload);
  });
  const enrollment = `/crm/leads/${lead}/guardian-child-enrollment`;
  const routes = {
    read: [enrollment, contracts.CRM_GUARDIAN_CHILD_ENROLLMENT_READ_COMMAND, {}, false],
    designate: [`${enrollment}/payer-designation`, contracts.CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_COMMAND, DESIGNATE, true],
    add: [`${enrollment}/children`, contracts.CRM_GUARDIAN_CHILD_ADDITION_COMMAND, child(), true],
    draft: ['/billing/crm-guardian-child-membership-drafts/from-plan', contracts.CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_COMMAND,
      { studentProfileId: randomUUID(), membershipPlanId: p.planId, membershipPlanVersion: 1, confirmation: contracts.CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION }, true],
  };
  try {
    for (const [name, [path, command, body, keyed]] of Object.entries(routes)) {
      const key = keyed ? { 'Idempotency-Key': randomUUID() } : {};
      const before = calls.length;
      const ok = await request(path, command, body, key);
      assert.equal(ok.status, 200, `${name}: ${JSON.stringify(ok.body)}`);
      assert.equal(ok.headers['cache-control'], 'private, no-store'); assert.equal(ok.headers['referrer-policy'], 'no-referrer');
      const [called, c] = calls[before]; assert.equal(called, name); assert.equal(c.source, 'HUMAN_UI'); assert.equal(c.principalId, scope.principalId);
      assert.equal(c.idempotencyKey, keyed ? key['Idempotency-Key'] : '');
      if (name !== 'draft') assert.equal(calls[before][2], lead);
      for (const patch of [{ Origin: 'https://evil.test' }, { 'X-HON-Human-Command': 'crm-adult-membership-draft' }, { 'X-HON-Human-Command': undefined }, { 'Sec-Fetch-Site': 'cross-site' },
        { 'Sec-Fetch-Mode': 'cors' }, { 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-User': '?1' }, { 'Content-Type': 'text/plain' }, { 'X-HON-Action-Request-Id': randomUUID() }]) {
        assert.equal((await request(path, command, body, { ...key, ...patch })).status, 403, `${name} ${JSON.stringify(patch)}`);
      }
      assert.equal((await request(path, command, body, keyed ? {} : { 'Idempotency-Key': randomUUID() })).status, 409, `${name} key ${keyed ? 'required' : 'refused'}`);
      if (keyed) assert.equal((await request(path, command, body, { 'Idempotency-Key': 'not-a-uuid' })).status, 409);
      for (const extra of [{ schoolId: randomUUID() }, { billingAccountId: randomUUID() }, { guardianPersonId: randomUUID() }]) assert.equal((await request(path, command, { ...body, ...extra }, key)).status, 400, `${name} ${JSON.stringify(extra)}`);
      assert.equal((await request(`${path}?leadId=${randomUUID()}`, command, body, key)).status, 400, `${name} query selector`);
      resolved = undefined; assert.equal((await request(path, command, body, key)).status, 403, `${name} no live scope`);
      resolved = { ...scope, schoolId: randomUUID() }; assert.equal((await request(path, command, body, key)).status, 403, `${name} other school`); resolved = scope;
      assert.equal(calls.length, before + 1, `${name}: no rejected request reached the service`);
    }
    const added = await request(routes.add[0], routes.add[1], routes.add[2], { 'Idempotency-Key': randomUUID() });
    assert.deepEqual(added.body.data, { outcome: 'NEEDS_STAFF_REVIEW' });
    const drafted = await request(routes.draft[0], routes.draft[1], routes.draft[2], { 'Idempotency-Key': randomUUID() });
    assert.deepEqual(Object.keys(drafted.body.data).sort(), ['plan', 'receipt']); assert.equal(drafted.body.meta.replayed, true);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('service rejects nonhuman, delegated and wrongly keyed context before any database work', async () => {
  const service = new GuardianChildEnrollmentService({ withTenantTransaction: async () => { throw new Error('must not enter'); } });
  const lead = randomUUID();
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { actionRequestId: '' }, { delegatedByPrincipalId: randomUUID() }, { externalSubject: '' }, { principalId: 'x' }]) {
    await assert.rejects(service.read(read(patch), lead), e => e.getStatus() === 403, JSON.stringify(patch));
    await assert.rejects(service.designatePayer(context(patch), lead, DESIGNATE), e => e.getStatus() === 403);
    await assert.rejects(service.addChild(context(patch), lead, child()), e => e.getStatus() === 403);
  }
  await assert.rejects(service.read(context(), lead), e => e.getStatus() === 409, 'reads refuse a key');
  await assert.rejects(service.designatePayer(read(), lead, DESIGNATE), e => e.getStatus() === 409, 'commands require a key');
  await assert.rejects(service.read(read(), 'not-a-uuid'), e => e.getStatus() === 400);
  await assert.rejects(service.addChild(context(), lead, child({ childBirthDate: 'yesterday' })), e => e.getStatus() === 400);
});

test('service runs one fixed function each, verifies results against the request and maps named outcomes', async () => {
  const sql = []; let data; let failure;
  const client = { query: async (query, values) => { sql.push({ query, values }); if (/hon\.(?:read|designate|add|draft)_crm_guardian/.test(query)) { if (failure) throw failure; return { rows: [{ data }] }; } return { rows: [] }; } };
  const service = new GuardianChildEnrollmentService({ withTenantTransaction: async (c, work) => work(client) });
  const lead = randomUUID();
  data = family(lead);
  assert.equal((await service.read(read(), lead.toUpperCase())).workflowState, 'PAYER_DESIGNATED');
  assert.equal(sql.at(-1).query, 'SELECT hon.read_crm_guardian_child_enrollment($1,$2::uuid) AS data');
  assert.deepEqual(sql.at(-1).values, ['verified-human', lead]);
  data = family(randomUUID());
  await assert.rejects(service.read(read(), lead), e => e.getStatus() === 503, 'another lead is never shown');
  data = { receipt: designation(), replayed: true };
  assert.equal((await service.designatePayer(context(), lead, DESIGNATE)).replayed, true);
  assert.equal(sql.at(-1).query, 'SELECT hon.designate_crm_guardian_child_payer($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data');
  data = { result: { outcome: 'CHILD_ADDED', leadId: lead, studentProfileId: randomUUID(), childDisplayName: 'Mia Lopez', recordedAt: '2026-10-21T08:02:00.000Z' }, replayed: false };
  assert.equal((await service.addChild(context(), lead, child())).result.outcome, 'CHILD_ADDED');
  await assert.rejects(service.addChild(context(), lead, child({ childGivenName: 'Leo' })), e => e.getStatus() === 503, 'a different child is never reported as added');
  failure = Object.assign(new Error('CRM_GUARDIAN_CHILD_NEEDS_STAFF_REVIEW'), { code: 'P0001' });
  assert.deepEqual(await service.addChild(context(), lead, child()), { result: { outcome: 'NEEDS_STAFF_REVIEW' }, replayed: false });
  failure = undefined;
  const p = plan();
  const input = { studentProfileId: randomUUID(), membershipPlanId: p.planId, membershipPlanVersion: 1, confirmation: contracts.CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION };
  data = { receipt: draftReceipt(), plan: p, replayed: false };
  assert.equal((await service.draftMembershipFromPlan(context(), input)).receipt.state, 'DRAFT');
  assert.equal(sql.at(-1).query, 'SELECT hon.draft_crm_guardian_child_membership_from_plan($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data');
  data = { receipt: draftReceipt(), plan: p, replayed: false, schedule: [] };
  await assert.rejects(service.draftMembershipFromPlan(context(), input), e => e.getStatus() === 503);
  for (const [message, code, status, named] of [['CRM_GUARDIAN_CHILD_BILLING_ACCOUNT_REQUIRED', 'P0002', 409, true], ['CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_REQUIRED', 'P0002', 409, true],
    ['CRM_GUARDIAN_CHILD_LIMIT', '54000', 409, true], ['MEMBERSHIP_PLAN_VERSION_STALE', '40001', 409, true], ['MEMBERSHIP_PLAN_CURRENCY_MISMATCH', '22023', 409, true],
    ['MEMBERSHIP_PLAN_UNAVAILABLE', 'P0002', 404, true], ['IDEMPOTENCY_KEY_REUSED', '23505', 409, true], ['CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE', 'P0002', 404, false],
    ['x', '42501', 403, false], ['x', '40P01', 409, false], ['x', '22023', 400, false], ['x', '57014', 503, false]]) {
    failure = Object.assign(new Error(message), { code });
    await assert.rejects(service.draftMembershipFromPlan(context(), input), e => e.getStatus() === status && (!named || e.getResponse().code === message), `${message}/${code}`);
  }
  for (const file of ['guardian-child-enrollment.service.ts', 'guardian-child-enrollment.controller.ts', 'guardian-child-enrollment.dto.ts']) {
    assert.doesNotMatch(readFileSync(`src/crm/${file}`, 'utf8'), /OwnerLaunch|ActionEngine|fetch\(|stripe|PaymentService|InvoiceService|MembershipService|payment_schedules|hon\.invoices/i, `${file} has no payment, schedule or provider path`);
  }
});

test('0176 keeps the canonical lock order, never infers a payer and never schedules, invoices or activates', () => {
  const migration = readFileSync('../../packages/database/migrations/0176_crm_guardian_child_enrollment.sql', 'utf8');
  const fn = (name) => migration.match(new RegExp(`CREATE FUNCTION hon\\.${name}\\([\\s\\S]*?\\nEND \\$\\$;`))[0];
  const iam = 'LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;';
  const reserve = 'ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING';
  const people = 'hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads';
  assert.deepEqual(fn('designate_crm_guardian_child_payer').match(/LOCK TABLE [^;]*;/g), [iam, `LOCK TABLE ${people},hon.billing_accounts,hon.crm_guardian_child_payer_designations IN SHARE ROW EXCLUSIVE MODE;`]);
  // Exactly the 0169 registration set, so an added child serializes with registration's existing-record check.
  assert.deepEqual(fn('add_crm_guardian_child_additional_child').match(/LOCK TABLE [^;]*;/g), [iam,
    'LOCK TABLE hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_guardian_child_enrolled_children IN SHARE ROW EXCLUSIVE MODE;']);
  assert.deepEqual(fn('draft_crm_guardian_child_membership_from_plan').match(/LOCK TABLE [^;]*;/g), [iam,
    `LOCK TABLE ${people},hon.billing_accounts,hon.memberships IN SHARE ROW EXCLUSIVE MODE;`,
    'LOCK TABLE hon.crm_guardian_child_enrolled_children,hon.crm_guardian_child_payer_designations IN SHARE MODE;',
    'LOCK TABLE hon.crm_guardian_child_membership_draft_sources IN SHARE ROW EXCLUSIVE MODE;',
    'LOCK TABLE hon.membership_plans,hon.membership_plan_versions IN SHARE MODE;']);
  assert.equal(fn('read_crm_guardian_child_enrollment').match(/LOCK TABLE [^;]*;/g).length, 1, 'the read takes one SHARE set');
  assert.match(fn('read_crm_guardian_child_enrollment'), /IN SHARE MODE;/);
  for (const name of ['designate_crm_guardian_child_payer', 'add_crm_guardian_child_additional_child', 'draft_crm_guardian_child_membership_from_plan']) {
    const body = fn(name);
    assert.ok(body.indexOf(reserve) < body.indexOf(iam), `${name}: key reservation first`);
    assert.ok(body.indexOf('IDEMPOTENCY_KEY_REUSED') < body.indexOf('_relation('), `${name}: a reused key is refused before domain facts`);
    assert.ok(body.indexOf('INSERT INTO hon.audit_events') > body.lastIndexOf('INSERT INTO hon.crm_guardian_child'), `${name}: evidence last`);
    assert.doesNotMatch(body, /LOCK TABLE hon\.idempotency_records/, `${name}: never locks the idempotency table`);
  }
  assert.doesNotMatch(fn('designate_crm_guardian_child_payer'), /INSERT INTO hon\.billing_accounts/, 'no account is created by designation');
  for (const name of ['read_crm_guardian_child_enrollment', 'designate_crm_guardian_child_payer', 'add_crm_guardian_child_additional_child', 'draft_crm_guardian_child_membership_from_plan']) {
    assert.doesNotMatch(fn(name), /membership_payment_schedules\s*\(|INSERT INTO hon\.(?:invoices|payment|membership_payment)|state='ACTIVE'|activate/i, `${name}: no schedule, invoice, payment or activation`);
  }
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION|ALTER FUNCTION/, 'no earlier body (0160, 0162, 0163, 0169, 0174, 0175) is replaced');
  assert.doesNotMatch(migration, /INSERT INTO hon\.crm_guardian_child_enrolled_children\([^)]*\)\s*SELECT/, 'no backfill of earlier registrations');
});
