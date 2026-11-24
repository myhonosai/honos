const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const contracts = require('@hon/contracts');
const { MembershipPlanController } = require('../dist/billing/membership-plan.controller.js');
const { MembershipPlanService } = require('../dist/billing/membership-plan.service.js');
const guards = require('../dist/billing/membership-plan.dto.js');
const { CrmAdultMembershipNoStoreGuard } = require('../dist/billing/crm-adult-membership-draft.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

// 0642 membership plan payment options: contracts, real Nest guards and the service's result checks.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => { const id = randomUUID(); return { ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'verified-human', requestId: id, correlationId: id, idempotencyKey: randomUUID(), ...patch }; };
const read = (patch = {}) => context({ idempotencyKey: '', ...patch });
const CONFIRM = contracts.MEMBERSHIP_PLAN_CHANGE_CONFIRMATION;
const options = [{ label: 'Monthly', priceMinor: 15900, billingFrequency: 'MONTHLY', checkoutEnabled: true },
  { label: '1 year paid in full', priceMinor: 159000, billingFrequency: 'PAID_IN_FULL', termMonths: 12, downPaymentMinor: 5000, checkoutEnabled: false }];
const fields = (patch = {}) => ({ displayName: 'Little Tigers', availability: 'AVAILABLE', currency: 'USD', classesPerWeek: 2, features: ['Belt testing included'], paymentOptions: options, confirmation: CONFIRM, ...patch });
const summary = (patch = {}) => ({ planId: randomUUID(), planCode: 'LITTLE-TIGERS', version: 1, displayName: 'Little Tigers', description: null, programId: null, availability: 'AVAILABLE',
  currency: 'USD', priceMinor: 15900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', termMonths: null, publishedAt: '2026-11-22T08:00:00.000Z', ...patch });
const option = (n, o) => ({ optionNo: n, label: o.label, priceMinor: o.priceMinor, billingFrequency: o.billingFrequency, payments: o.payments ?? null, termMonths: o.termMonths ?? null,
  downPaymentMinor: o.downPaymentMinor ?? null, checkoutEnabled: o.checkoutEnabled });
const setup = (plan, patch = {}) => ({ planId: plan.planId, version: plan.version, derived: false, classesPerWeek: 2, features: ['Belt testing included'], paymentOptions: options.map((o, i) => option(i + 1, o)), ...patch });

test('closed option rules: 1-6 options, unique labels, paid in full needs a length, option 1 never quarterly', () => {
  const input = contracts.validateCreateMembershipPlanWithOptionsInput({ planCode: 'LITTLE-TIGERS', ...fields() });
  assert.deepEqual(input.paymentOptions, options);
  assert.equal(contracts.validateReviseMembershipPlanWithOptionsInput({ expectedVersion: 2, ...fields({ features: [], classesPerWeek: null }) }).expectedVersion, 2);
  const one = (patch) => fields({ paymentOptions: [{ ...options[0], ...patch }] });
  for (const bad of [one({ billingFrequency: 'QUARTERLY' }), one({ billingFrequency: 'PAID_IN_FULL' }), one({ billingFrequency: 'PAID_IN_FULL', termMonths: 12, payments: 1 }),
    one({ billingFrequency: 'ANNUAL', termMonths: 18 }), one({ termMonths: 0 }), one({ payments: 121 }), one({ downPaymentMinor: 0 }), one({ label: '' }), one({ label: 'x'.repeat(81) }),
    one({ checkoutEnabled: 1 }), one({ discountMinor: 1 }), fields({ paymentOptions: [] }), fields({ paymentOptions: Array(7).fill(options[0]).map((o, i) => ({ ...o, label: `O${i}` })) }),
    fields({ paymentOptions: [options[0], { ...options[0], label: 'monthly' }] }), fields({ paymentOptions: [options[0], { ...options[0], label: 'Q', billingFrequency: 'QUARTERLY', termMonths: 4 }] }),
    fields({ classesPerWeek: 0 }), fields({ features: Array(13).fill('x') }), fields({ priceMinor: 1 }), fields({ billingFrequency: 'MONTHLY' }), fields({ confirmation: 'yes' })]) {
    assert.throws(() => contracts.validateCreateMembershipPlanWithOptionsInput({ planCode: 'LITTLE-TIGERS', ...bad }), JSON.stringify(bad).slice(0, 120));
  }
  assert.doesNotThrow(() => contracts.validateCreateMembershipPlanWithOptionsInput({ planCode: 'X', ...fields({ paymentOptions: [options[0], { ...options[0], label: 'Q', billingFrequency: 'QUARTERLY', termMonths: 12 }] }) }));
  assert.equal(contracts.membershipPaymentOptionProblem({ billingFrequency: 'QUARTERLY', payments: null, termMonths: null }, 1), 'FIRST_NOT_QUARTERLY');
  assert.equal(contracts.membershipPaymentOptionProblem({ billingFrequency: 'PAID_IN_FULL', payments: null, termMonths: null }, 2), 'PAID_IN_FULL_NEEDS_LENGTH');
});

test('results: option 1 must be the version price, frequency and term; derived setups carry exactly one unlabelled option', () => {
  const plan = summary();
  assert.deepEqual(contracts.verifyMembershipPlanWithOptions({ plan, setup: setup(plan) }).setup.paymentOptions.length, 2);
  for (const bad of [setup(plan, { version: 2 }), setup(plan, { planId: randomUUID() }), setup(plan, { derived: true }),
    setup(plan, { paymentOptions: [option(1, { ...options[0], priceMinor: 1 })] }), setup(plan, { paymentOptions: [option(2, options[0])] })]) {
    assert.throws(() => contracts.verifyMembershipPlanWithOptions({ plan, setup: bad }), JSON.stringify(bad).slice(0, 120));
  }
  const derived = { planId: plan.planId, version: 1, derived: true, classesPerWeek: null, features: [], paymentOptions: [{ ...option(1, options[0]), label: null }] };
  assert.equal(contracts.verifyMembershipPlanSetups({ setups: [derived] }).setups[0].paymentOptions[0].label, null);
  assert.throws(() => contracts.verifyMembershipPlanSetups({ setups: [{ ...derived, derived: false }] }), 'a published option always has a label');
  assert.throws(() => contracts.verifyMembershipPlanSetups({ setups: [derived, derived] }), 'one setup per plan');
});

test('real Nest guards: one direct-human marker per new route, keys only on commands, closed bodies, live plan-manage scope', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const calls = []; const permissions = []; let resolved = scope;
  const database = { resolveAuthorizedScope: async (subject, school, permission) => { assert.equal(subject, 'verified-human'); permissions.push(permission); return resolved; } };
  const plan = summary();
  const service = {
    setups: async (c) => { calls.push(['setups', c]); return { setups: [] }; },
    createWithOptions: async (c, input) => { calls.push(['create', c, input]); return { plan, setup: setup(plan), replayed: false }; },
    reviseWithOptions: async (c, id, input) => { calls.push(['revise', c, id, input]); return { plan: { ...plan, version: 2 }, setup: setup({ ...plan, version: 2 }), replayed: true }; },
  };
  const module = await Test.createTestingModule({ controllers: [MembershipPlanController],
    providers: [CrmAdultMembershipNoStoreGuard, guards.MembershipPlanCatalogHumanUiGuard, guards.MembershipPlanCreateHumanUiGuard, guards.MembershipPlanReviseHumanUiGuard,
      guards.MembershipPlanSetupsHumanUiGuard, guards.MembershipPlanCreateWithOptionsHumanUiGuard, guards.MembershipPlanReviseWithOptionsHumanUiGuard,
      { provide: RuntimeDatabaseService, useValue: database }, { provide: MembershipPlanService, useValue: service }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.listen(0, '127.0.0.1');
  const base = `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/membership-plans`;
  const request = (path, command, body, patch = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': command, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty', ...patch, 'Content-Length': Buffer.byteLength(payload) };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const req = http.request({ hostname: '127.0.0.1', port: app.getHttpServer().address().port, path: `${base}${path}`, method: 'POST', headers }, res => { let data = ''; res.on('data', x => data += x); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null })); });
    req.on('error', reject); req.end(payload);
  });
  const planId = randomUUID();
  const routes = {
    setups: ['/setups', 'membership-plan-setups-read', {}, false],
    create: ['/with-options', 'membership-plan-create-with-options', { planCode: 'LITTLE-TIGERS', ...fields() }, true],
    revise: [`/${planId}/option-revisions`, 'membership-plan-revise-with-options', { expectedVersion: 1, ...fields() }, true],
  };
  try {
    for (const [name, [path, command, body, keyed]] of Object.entries(routes)) {
      const key = keyed ? { 'Idempotency-Key': randomUUID() } : {};
      const before = calls.length; permissions.length = 0;
      const ok = await request(path, command, body, key);
      assert.equal(ok.status, 200, `${name}: ${JSON.stringify(ok.body)}`);
      assert.equal(ok.headers['cache-control'], 'private, no-store');
      assert.deepEqual(permissions, ['billing.membership_plan.manage']);
      const [called, c] = calls[before]; assert.equal(called, name); assert.equal(c.source, 'HUMAN_UI'); assert.equal(c.idempotencyKey, keyed ? key['Idempotency-Key'] : '');
      for (const patch of [{ Origin: 'https://evil.test' }, { 'X-HON-Human-Command': 'membership-plan-create' }, { 'X-HON-Human-Command': undefined }, { 'Sec-Fetch-Site': 'cross-site' },
        { 'Content-Type': 'text/plain' }, { 'X-HON-Action-Request-Id': randomUUID() }]) {
        assert.equal((await request(path, command, body, { ...key, ...patch })).status, 403, `${name} ${JSON.stringify(patch)}`);
      }
      assert.equal((await request(path, command, body, keyed ? {} : { 'Idempotency-Key': randomUUID() })).status, 409, `${name} key ${keyed ? 'required' : 'refused'}`);
      for (const extra of [{ schoolId: randomUUID() }, { priceMinor: 100 }]) assert.equal((await request(path, command, { ...body, ...extra }, key)).status, 400, `${name} ${JSON.stringify(extra)}`);
      assert.equal((await request(`${path}?x=1`, command, body, key)).status, 400, `${name} query selector`);
      resolved = undefined; assert.equal((await request(path, command, body, key)).status, 403, `${name} no live scope`); resolved = scope;
      assert.equal(calls.length, before + 1, `${name}: no rejected request reached the service`);
    }
    assert.equal(calls.find(([n]) => n === 'revise')[2], planId);
    const revised = await request(routes.revise[0], routes.revise[1], routes.revise[2], { 'Idempotency-Key': randomUUID() });
    assert.deepEqual([Object.keys(revised.body.data).sort(), revised.body.data.plan.version, revised.body.meta.replayed], [['plan', 'setup'], 2, true]);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('service runs one fixed function each and never reports an unverified publish', async () => {
  const sql = []; let data;
  const client = { query: async (query, values) => { sql.push({ query, values }); return /hon\.(?:read|create|revise)_/.test(query) ? { rows: [{ data }] } : { rows: [] }; } };
  const service = new MembershipPlanService({ withTenantTransaction: async (c, work) => work(client), withTenantReadOnlyTransaction: async (c, work) => work(client) });
  const plan = summary();
  data = { plan, setup: setup(plan), replayed: false };
  assert.equal((await service.createWithOptions(context(), { planCode: 'LITTLE-TIGERS', ...fields() })).setup.paymentOptions.length, 2);
  assert.equal(sql.at(-1).query, 'SELECT hon.create_school_membership_plan_with_options($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data');
  await assert.rejects(service.createWithOptions(context(), { planCode: 'OTHER', ...fields() }), e => e.getStatus() === 503, 'another plan code is never reported as created');
  data = { plan, setup: setup(plan, { paymentOptions: [option(1, options[0])] }), replayed: false };
  await assert.rejects(service.createWithOptions(context(), { planCode: 'LITTLE-TIGERS', ...fields() }), e => e.getStatus() === 503, 'option count must match the request');
  data = { plan: { ...plan, version: 2 }, setup: setup({ ...plan, version: 2 }), replayed: false, extra: 1 };
  await assert.rejects(service.reviseWithOptions(context(), plan.planId, { expectedVersion: 1, ...fields() }), e => e.getStatus() === 503, 'closed result');
  data = { plan: { ...plan, version: 2 }, setup: setup({ ...plan, version: 2 }), replayed: true };
  assert.equal((await service.reviseWithOptions(context(), plan.planId.toUpperCase(), { expectedVersion: 1, ...fields() })).replayed, true);
  assert.deepEqual(sql.at(-1).values.slice(0, 2), ['verified-human', plan.planId]);
  data = { setups: [setup(plan)] };
  assert.equal((await service.setups(read())).setups.length, 1);
  await assert.rejects(service.setups(context()), e => e.getStatus() === 409, 'reads refuse a key');
  await assert.rejects(service.createWithOptions(read(), { planCode: 'X', ...fields() }), e => e.getStatus() === 409, 'commands need a key');
  await assert.rejects(service.createWithOptions(context({ source: 'AI' }), { planCode: 'X', ...fields() }), e => e.getStatus() === 403);
});

test('0642 keeps the 0175 lock order and never schedules, invoices, charges or activates', () => {
  const migration = readFileSync('../../packages/database/migrations/0642_membership_plan_payment_options.sql', 'utf8');
  const fn = (name) => migration.match(new RegExp(`CREATE FUNCTION hon\\.${name}\\([\\s\\S]*?\\nEND \\$\\$;`))[0];
  const iam = 'LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;';
  for (const name of ['create_school_membership_plan_with_options', 'revise_school_membership_plan_with_options']) {
    const body = fn(name);
    assert.deepEqual(body.match(/LOCK TABLE [^;]*;/g), [iam, 'LOCK TABLE hon.membership_plans,hon.membership_plan_versions IN SHARE ROW EXCLUSIVE MODE;']);
    assert.ok(body.indexOf('DO NOTHING') < body.indexOf(iam), `${name}: key reservation first`);
    assert.ok(body.indexOf('INSERT INTO hon.audit_events') > body.indexOf('hon.membership_plan_insert_setup('), `${name}: evidence last`);
    assert.equal(body.match(/hon\.require_membership_plan_manager\(subject\)/g).length, 4, `${name}: authority before, after locks, on replay and before return`);
  }
  assert.doesNotMatch(migration, /membership_payment_schedules|hon\.invoices|payment_attempts|hon\.memberships\b|activate/i, 'no schedule, invoice, payment, membership or activation');
});
