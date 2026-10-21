const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const contracts = require('@hon/contracts');
const { MembershipPlanController, CrmAdultMembershipDraftFromPlanController } = require('../dist/billing/membership-plan.controller.js');
const { MembershipPlanService } = require('../dist/billing/membership-plan.service.js');
const guards = require('../dist/billing/membership-plan.dto.js');
const { CrmAdultMembershipNoStoreGuard } = require('../dist/billing/crm-adult-membership-draft.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => { const id = randomUUID(); return { ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'verified-human', requestId: id, correlationId: id, idempotencyKey: randomUUID(), ...patch }; };
const read = (patch = {}) => context({ idempotencyKey: '', ...patch });
const CONFIRM = contracts.MEMBERSHIP_PLAN_CHANGE_CONFIRMATION;
const terms = (patch = {}) => ({ displayName: 'Adult Unlimited', availability: 'AVAILABLE', currency: 'USD', priceMinor: 14900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', ...patch });
const summary = (patch = {}) => ({ planId: randomUUID(), planCode: 'ADULT-MONTHLY', version: 1, displayName: 'Adult Unlimited', description: null, programId: null, availability: 'AVAILABLE',
  currency: 'USD', priceMinor: 14900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', termMonths: null, publishedAt: '2026-10-21T08:00:00.000Z', ...patch });
const receipt = (patch = {}) => ({ membershipId: randomUUID(), state: 'DRAFT', planCode: 'ADULT-MONTHLY', termStartedAt: null, termEndsAt: null, recordedAt: '2026-10-21T08:01:00.000Z', ...patch });

test('closed plan terms: exact frequencies, term rules, bounds and no discount, agreement or payment-start fields', () => {
  assert.deepEqual(contracts.validateCreateMembershipPlanInput({ planCode: 'ADULT-MONTHLY', ...terms(), confirmation: CONFIRM }), { planCode: 'ADULT-MONTHLY', ...terms(), confirmation: CONFIRM });
  const fixed = contracts.validateReviseMembershipPlanInput({ expectedVersion: 3, ...terms({ billingFrequency: 'PAID_IN_FULL', termKind: 'FIXED_MONTHS', termMonths: 12, description: null, programId: null }), confirmation: CONFIRM });
  assert.deepEqual([fixed.termMonths, fixed.description, fixed.programId, fixed.expectedVersion], [12, null, null, 3]);
  assert.equal(contracts.validateCreateMembershipPlanInput({ planCode: 'X', ...terms({ billingFrequency: 'ANNUAL', termKind: 'FIXED_MONTHS', termMonths: 24 }), confirmation: CONFIRM }).termMonths, 24);
  const rejects = [{ planCode: 'lower' }, { planCode: '-LEAD' }, { planCode: 'A'.repeat(41) }, { priceMinor: -1 }, { priceMinor: 1.5 }, { priceMinor: '100' }, { priceMinor: 100_000_001 },
    { currency: 'usd' }, { billingFrequency: 'QUARTERLY' }, { billingFrequency: 'PAID_IN_FULL' }, { termKind: 'FIXED_MONTHS' }, { termKind: 'FIXED_MONTHS', termMonths: 0 },
    { termKind: 'FIXED_MONTHS', termMonths: 61 }, { termMonths: 12 }, { billingFrequency: 'ANNUAL', termKind: 'FIXED_MONTHS', termMonths: 6 }, { availability: 'HIDDEN' },
    { displayName: '' }, { displayName: ' x' }, { displayName: 'a<b' }, { description: 'x'.repeat(501) }, { programId: 'kickboxing' },
    { discountMinor: 500 }, { agreementTemplateId: randomUUID() }, { paymentStartsAt: '2026-11-01T00:00:00.000Z' }, { registrationFeeMinor: 100 }, { organizationId: randomUUID() }, { confirmation: 'yes' }];
  for (const patch of rejects) assert.throws(() => contracts.validateCreateMembershipPlanInput({ planCode: 'ADULT-MONTHLY', ...terms(), confirmation: CONFIRM, ...patch }), JSON.stringify(patch));
  assert.throws(() => contracts.validateReviseMembershipPlanInput({ expectedVersion: 0, ...terms(), confirmation: CONFIRM }));
  assert.throws(() => contracts.validateReviseMembershipPlanInput({ expectedVersion: 1, planCode: 'RENAME', ...terms(), confirmation: CONFIRM }), 'a plan code never changes');
  assert.deepEqual(contracts.validateMembershipPlanReadInput({}), {});
  for (const body of [{ planId: randomUUID() }, { schoolId: randomUUID() }, null, []]) assert.throws(() => contracts.validateMembershipPlanReadInput(body));
});

test('closed verifiers: catalog, AVAILABLE-only options, version summaries and the plan-bound DRAFT receipt', () => {
  const plan = summary();
  assert.deepEqual(contracts.verifyMembershipPlanVersionSummary(plan), plan);
  for (const bad of [{ ...plan, extra: 1 }, { ...plan, version: 0 }, { ...plan, termMonths: 12 }, { ...plan, publishedAt: '2026-10-21' }, { ...plan, priceMinor: -1 }, { ...plan, planCode: 'x' }]) {
    assert.throws(() => contracts.verifyMembershipPlanVersionSummary(bad), JSON.stringify(bad));
  }
  const programId = randomUUID();
  const listing = { ...summary({ programId }), programName: 'Adult Kickboxing' };
  assert.deepEqual(contracts.verifyMembershipPlanCatalog({ plans: [listing], programs: [{ programId, name: 'Adult Kickboxing' }] }).plans[0].programName, 'Adult Kickboxing');
  assert.throws(() => contracts.verifyMembershipPlanCatalog({ plans: [{ ...listing, programName: null }], programs: [] }), 'a program-bound plan has a program name');
  assert.throws(() => contracts.verifyMembershipPlanCatalog({ plans: [listing, listing], programs: [] }), 'duplicate plans');
  assert.throws(() => contracts.verifyMembershipPlanCatalog({ plans: [] }), 'programs required');
  assert.throws(() => contracts.verifyCrmAdultMembershipPlanOptions({ plans: [{ ...summary({ availability: 'UNAVAILABLE' }), programName: null }] }), 'options never list hidden plans');
  assert.deepEqual(contracts.verifyCrmAdultMembershipPlanOptions({ plans: [] }), { plans: [] });
  // Fixed-term end derivation matches PostgreSQL timestamp + interval (end-of-month clamped, UTC).
  assert.equal(contracts.membershipPlanFixedTermEnd('2026-01-31T15:00:00.000Z', 1), '2026-02-28T15:00:00.000Z');
  assert.equal(contracts.membershipPlanFixedTermEnd('2027-12-31T00:00:00.000Z', 2), '2028-02-29T00:00:00.000Z');
  assert.equal(contracts.membershipPlanFixedTermEnd('2026-03-15T09:30:00.000Z', 12), '2027-03-15T09:30:00.000Z');
  const yearly = summary({ planCode: 'ADULT-12', billingFrequency: 'PAID_IN_FULL', termKind: 'FIXED_MONTHS', termMonths: 12 });
  const input = { studentProfileId: randomUUID(), membershipPlanId: yearly.planId, membershipPlanVersion: 1, termStartedAt: '2026-01-31T15:00:00.000Z', confirmation: contracts.CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION };
  assert.deepEqual(contracts.validateCrmAdultMembershipDraftFromPlanInput(input), input);
  const good = { receipt: receipt({ planCode: 'ADULT-12', termStartedAt: input.termStartedAt, termEndsAt: '2027-01-31T15:00:00.000Z' }), plan: yearly };
  assert.deepEqual(contracts.verifyCrmAdultMembershipDraftFromPlan(good, input), good);
  for (const bad of [{ ...good, receipt: { ...good.receipt, planCode: 'OTHER' } }, { ...good, receipt: { ...good.receipt, termEndsAt: null } }, { ...good, plan: { ...yearly, version: 2 } },
    { ...good, receipt: { ...good.receipt, state: 'ACTIVE' } }, { ...good, extra: true }]) assert.throws(() => contracts.verifyCrmAdultMembershipDraftFromPlan(bad, input), JSON.stringify(bad).slice(0, 80));
  for (const patch of [{ planCode: 'ADULT-12' }, { termEndsAt: '2027-01-31T15:00:00.000Z' }, { membershipPlanVersion: '1' }, { membershipPlanVersion: 0 }, { priceMinor: 1 },
    { discountMinor: 1 }, { billingAccountId: randomUUID() }, { confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT' }]) {
    assert.throws(() => contracts.validateCrmAdultMembershipDraftFromPlanInput({ ...input, ...patch }), JSON.stringify(patch));
  }
});

test('real Nest guards: one direct-human marker per route, keys only on commands, closed bodies, live scope per permission', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const calls = []; const permissions = []; let resolved = scope;
  const database = { resolveAuthorizedScope: async (subject, school, permission) => { assert.equal(subject, 'verified-human'); assert.equal(school, scope.schoolId); permissions.push(permission); return resolved; } };
  const plan = summary();
  const service = {
    catalog: async (c) => { calls.push(['catalog', c]); return { plans: [], programs: [] }; },
    create: async (c, input) => { calls.push(['create', c, input]); return { plan, replayed: false }; },
    revise: async (c, id, input) => { calls.push(['revise', c, id, input]); return { plan: { ...plan, version: 2 }, replayed: true }; },
    adultDraftPlanOptions: async (c) => { calls.push(['options', c]); return { plans: [] }; },
    draftAdultMembershipFromPlan: async (c, input) => { calls.push(['draft', c, input]); return { receipt: receipt(), plan, replayed: false }; },
  };
  const module = await Test.createTestingModule({ controllers: [MembershipPlanController, CrmAdultMembershipDraftFromPlanController],
    providers: [CrmAdultMembershipNoStoreGuard, guards.MembershipPlanCatalogHumanUiGuard, guards.MembershipPlanCreateHumanUiGuard, guards.MembershipPlanReviseHumanUiGuard,
      guards.CrmAdultMembershipPlanOptionsHumanUiGuard, guards.CrmAdultMembershipDraftFromPlanHumanUiGuard,
      { provide: RuntimeDatabaseService, useValue: database }, { provide: MembershipPlanService, useValue: service }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.listen(0, '127.0.0.1');
  const base = `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing`;
  const request = (path, command, body, patch = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': command, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty', ...patch, 'Content-Length': Buffer.byteLength(payload) };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const req = http.request({ hostname: '127.0.0.1', port: app.getHttpServer().address().port, path: `${base}${path}`, method: 'POST', headers }, res => { let data = ''; res.on('data', x => data += x); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null })); });
    req.on('error', reject); req.end(payload);
  });
  const planId = randomUUID();
  const routes = {
    catalog: ['/membership-plans/catalog', 'membership-plan-catalog-read', {}, false, 'billing.membership_plan.manage'],
    create: ['/membership-plans', 'membership-plan-create', { planCode: 'ADULT-MONTHLY', ...terms(), confirmation: CONFIRM }, true, 'billing.membership_plan.manage'],
    revise: [`/membership-plans/${planId}/revisions`, 'membership-plan-revise', { expectedVersion: 1, ...terms({ priceMinor: 15900 }), confirmation: CONFIRM }, true, 'billing.membership_plan.manage'],
    options: ['/crm-adult-membership-drafts/plan-options', 'crm-adult-membership-plan-options', {}, false, 'billing.membership.create'],
    draft: ['/crm-adult-membership-drafts/from-plan', 'crm-adult-membership-draft-from-plan', { studentProfileId: randomUUID(), membershipPlanId: plan.planId, membershipPlanVersion: 1, confirmation: contracts.CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION }, true, 'billing.membership.create'],
  };
  try {
    for (const [name, [path, command, body, keyed, permission]] of Object.entries(routes)) {
      const key = keyed ? { 'Idempotency-Key': randomUUID() } : {};
      const before = calls.length; permissions.length = 0;
      const ok = await request(path, command, body, key);
      assert.equal(ok.status, 200, `${name}: ${JSON.stringify(ok.body)}`);
      assert.equal(ok.headers['cache-control'], 'private, no-store'); assert.equal(ok.headers['referrer-policy'], 'no-referrer');
      assert.deepEqual(permissions, [permission], `${name} resolves live scope for ${permission}`);
      const [called, c] = calls[before]; assert.equal(called, name); assert.equal(c.source, 'HUMAN_UI'); assert.equal(c.principalId, scope.principalId);
      assert.equal(c.idempotencyKey, keyed ? key['Idempotency-Key'] : '');
      for (const patch of [{ Origin: 'https://evil.test' }, { 'X-HON-Human-Command': 'crm-adult-membership-draft' }, { 'X-HON-Human-Command': undefined }, { 'Sec-Fetch-Site': 'cross-site' },
        { 'Sec-Fetch-Mode': 'cors' }, { 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-User': '?1' }, { 'Content-Type': 'text/plain' }, { 'X-HON-Action-Request-Id': randomUUID() }]) {
        assert.equal((await request(path, command, body, { ...key, ...patch })).status, 403, `${name} ${JSON.stringify(patch)}`);
      }
      assert.equal((await request(path, command, body, keyed ? {} : { 'Idempotency-Key': randomUUID() })).status, 409, `${name} key ${keyed ? 'required' : 'refused'}`);
      if (keyed) assert.equal((await request(path, command, body, { 'Idempotency-Key': 'not-a-uuid' })).status, 409);
      for (const extra of [{ schoolId: randomUUID() }, { organizationId: randomUUID() }, { discountMinor: 100 }]) assert.equal((await request(path, command, { ...body, ...extra }, key)).status, 400, `${name} ${JSON.stringify(extra)}`);
      assert.equal((await request(`${path}?planId=${randomUUID()}`, command, body, key)).status, 400, `${name} query selector`);
      resolved = undefined; assert.equal((await request(path, command, body, key)).status, 403, `${name} no live scope`); resolved = scope;
      assert.equal(calls.length, before + 1, `${name}: no rejected request reached the service`);
    }
    assert.deepEqual(calls.find(([n]) => n === 'revise')[2], planId);
    const revised = await request(routes.revise[0], routes.revise[1], routes.revise[2], { 'Idempotency-Key': randomUUID() });
    assert.deepEqual([revised.body.data.version, revised.body.meta.replayed], [2, true]);
    const drafted = await request(routes.draft[0], routes.draft[1], routes.draft[2], { 'Idempotency-Key': randomUUID() });
    assert.deepEqual(Object.keys(drafted.body.data).sort(), ['plan', 'receipt']); assert.equal(drafted.body.meta.replayed, false);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('service rejects nonhuman, delegated and wrongly keyed context before any database work', async () => {
  const service = new MembershipPlanService({ withTenantTransaction: async () => { throw new Error('must not enter'); }, withTenantReadOnlyTransaction: async () => { throw new Error('must not enter'); } });
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { actionRequestId: '' }, { delegatedByPrincipalId: randomUUID() }, { externalSubject: '' }, { principalId: 'x' }]) {
    await assert.rejects(service.catalog(read(patch)), e => e.getStatus() === 403, JSON.stringify(patch));
    await assert.rejects(service.create(context(patch), { planCode: 'A', ...terms(), confirmation: CONFIRM }), e => e.getStatus() === 403);
    await assert.rejects(service.adultDraftPlanOptions(read(patch)), e => e.getStatus() === 403 && e.getResponse().code === 'CRM_ADULT_MEMBERSHIP_FORBIDDEN');
  }
  await assert.rejects(service.catalog(context()), e => e.getStatus() === 409, 'reads refuse a key');
  await assert.rejects(service.create(read(), { planCode: 'A', ...terms(), confirmation: CONFIRM }), e => e.getStatus() === 409, 'commands require a key');
  await assert.rejects(service.create(context(), { planCode: 'a', ...terms(), confirmation: CONFIRM }), e => e.getStatus() === 400);
  await assert.rejects(service.revise(context(), 'not-a-uuid', { expectedVersion: 1, ...terms(), confirmation: CONFIRM }), e => e.getStatus() === 400);
});

test('service runs one fixed function each, verifies the result against the request and maps named outcomes', async () => {
  const sql = []; let data; let failure;
  const client = { query: async (query, values) => { sql.push({ query, values }); if (/hon\.(?:read|create|revise|draft)_/.test(query)) { if (failure) throw failure; return { rows: [{ data }] }; } return { rows: [] }; } };
  const db = { withTenantTransaction: async (c, work) => work(client), withTenantReadOnlyTransaction: async (c, work) => work(client) };
  const service = new MembershipPlanService(db);
  const plan = summary();
  data = { plan, replayed: false };
  assert.deepEqual(await service.create(context(), { planCode: 'ADULT-MONTHLY', ...terms(), confirmation: CONFIRM }), { plan, replayed: false });
  assert.equal(sql.at(-1).query, 'SELECT hon.create_school_membership_plan($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data');
  await assert.rejects(service.create(context(), { planCode: 'OTHER', ...terms(), confirmation: CONFIRM }), e => e.getStatus() === 503, 'a different plan code is never reported as created');
  data = { plan: { ...plan, version: 3 }, replayed: false };
  await assert.rejects(service.revise(context(), plan.planId, { expectedVersion: 1, ...terms(), confirmation: CONFIRM }), e => e.getStatus() === 503, 'a revision must be exactly the next version');
  data = { plan: { ...plan, version: 2 }, replayed: false };
  assert.equal((await service.revise(context(), plan.planId.toUpperCase(), { expectedVersion: 1, ...terms(), confirmation: CONFIRM })).plan.version, 2);
  assert.deepEqual(sql.at(-1).values.slice(0, 2), ['verified-human', plan.planId]);
  data = { receipt: receipt(), plan, replayed: false };
  const input = { studentProfileId: randomUUID(), membershipPlanId: plan.planId, membershipPlanVersion: 1, confirmation: contracts.CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION };
  assert.equal((await service.draftAdultMembershipFromPlan(context(), input)).receipt.planCode, 'ADULT-MONTHLY');
  data = { receipt: receipt(), plan, replayed: false, extra: 1 };
  await assert.rejects(service.draftAdultMembershipFromPlan(context(), input), e => e.getStatus() === 503);
  for (const [message, code, status] of [['MEMBERSHIP_PLAN_VERSION_STALE', '40001', 409], ['MEMBERSHIP_PLAN_CODE_TAKEN', '23505', 409], ['IDEMPOTENCY_KEY_REUSED', '23505', 409],
    ['MEMBERSHIP_PLAN_CURRENCY_MISMATCH', '22023', 409], ['MEMBERSHIP_PLAN_UNCHANGED', '22023', 400], ['MEMBERSHIP_PLAN_UNAVAILABLE', 'P0002', 404], ['MEMBERSHIP_PLAN_LIMIT', '54000', 409],
    ['CRM_ADULT_MEMBERSHIP_UNAVAILABLE', 'P0002', 404], ['CRM_ADULT_MEMBERSHIP_FORBIDDEN', '42501', 403], ['x', '40P01', 409], ['x', '22023', 400], ['x', '57014', 503]]) {
    failure = Object.assign(new Error(message), { code });
    await assert.rejects(service.draftAdultMembershipFromPlan(context(), input), e => e.getStatus() === status && (message === 'x' || message.startsWith('CRM_') || e.getResponse().code === message), `${message}/${code}`);
  }
  for (const file of ['membership-plan.service.ts', 'membership-plan.controller.ts', 'membership-plan.dto.ts']) {
    assert.doesNotMatch(readFileSync(`src/billing/${file}`, 'utf8'), /OwnerLaunch|ActionEngine|fetch\(|stripe|PaymentService|InvoiceService|MembershipService|payment_schedules|hon\.invoices/i, `${file} has no payment, schedule or provider path`);
  }
});

test('0175 keeps the 0169 lock order, binds exact versions and never schedules, invoices or activates', () => {
  const migration = readFileSync('../../packages/database/migrations/0175_school_membership_plan_catalog.sql', 'utf8');
  const fn = (name) => migration.match(new RegExp(`CREATE FUNCTION hon\\.${name}\\([\\s\\S]*?\\nEND \\$\\$;`))[0];
  const iam = 'LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;';
  for (const name of ['create_school_membership_plan', 'revise_school_membership_plan']) {
    const body = fn(name);
    assert.deepEqual(body.match(/LOCK TABLE [^;]*;/g), [iam, 'LOCK TABLE hon.membership_plans,hon.membership_plan_versions IN SHARE ROW EXCLUSIVE MODE;']);
    assert.ok(body.indexOf('ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING') < body.indexOf(iam), `${name}: key reservation first`);
    assert.ok(body.indexOf('INSERT INTO hon.audit_events') > body.lastIndexOf('INSERT INTO hon.membership_plan_versions'), `${name}: evidence last`);
  }
  const draft = fn('draft_crm_adult_membership_from_plan');
  assert.deepEqual(draft.match(/LOCK TABLE [^;]*;/g), [iam,
    'LOCK TABLE hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts,hon.memberships,hon.crm_adult_membership_draft_sources IN SHARE ROW EXCLUSIVE MODE;',
    'LOCK TABLE hon.membership_plans,hon.membership_plan_versions IN SHARE MODE;'], 'the 0169 DRAFT set, then the catalog in SHARE');
  assert.match(draft, /IF plan\.current_version<>selected_version THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_VERSION_STALE'/);
  assert.match(draft, /terms\.currency::text IS DISTINCT FROM relation\.currency/);
  assert.match(draft, /plan_code,state,term_started_at,term_ends_at\)\s*VALUES\(org,school,relation\.account_id,relation\.person_id,plan\.plan_code,'DRAFT'/);
  assert.equal(draft.match(/hon\.require_crm_adult_membership_actor\(subject\)/g).length, 4, 'DRAFT authority before, after locks, on replay and before return');
  for (const name of ['create_school_membership_plan', 'revise_school_membership_plan', 'draft_crm_adult_membership_from_plan', 'read_school_membership_plan_catalog', 'read_crm_adult_membership_plan_options']) {
    assert.doesNotMatch(fn(name), /membership_payment_schedules\s*\(|INSERT INTO hon\.(?:invoices|payment|membership_payment)|state='ACTIVE'|activate/i, `${name}: no schedule, invoice, payment or activation`);
  }
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION/, 'no earlier body (0162, 0163, 0169, 0174) is replaced');
  assert.doesNotMatch(migration.split('CREATE FUNCTION')[0], /INSERT INTO hon\.membership_plan/, 'no school plan is seeded');
});
