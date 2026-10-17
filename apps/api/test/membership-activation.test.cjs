const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { readFileSync } = require('node:fs');
const { MembershipService } = require('../dist/billing/membership.service.js');
const { MembershipController } = require('../dist/billing/membership.controller.js');
const { MembershipActivationHumanUiGuard } = require('../dist/billing/membership-activation-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const id = randomUUID();
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'activation-key', ...patch });
const status = value => error => { assert.equal(error.getStatus(), value); return true; };
const response = () => ({ status() {} });

function fixture(options = {}) {
  let state = { membership: { id, billingAccountId: randomUUID(), participantPersonId: randomUUID(), planCode: 'KNOWN_DRAFT', state: 'DRAFT', version: 1, createdAt: '2026-10-16T00:00:00.000Z' }, records: {}, audits: [], outbox: [] };
  const queries = [];
  let checks = 0;
  const db = {
    resolveAuthorizedScope: async () => scope,
    async transaction(c, work, readOnly) {
      const before = structuredClone(state);
      try { return await work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        assert.doesNotMatch(sql, /hon\.(?:agreements|document_\w+|payment_\w+|membership_payment_schedules|invoices|communication_\w+|action_requests|ai_\w+|billing_accounts|class_bookings|attendance_records)/);
        if (/principal_has_school_permission/.test(sql)) {
          checks++;
          assert.deepEqual(args, [c.principalId, c.organizationId, c.schoolId]);
          return { rows: [{ authorized: options.authorized !== false && !(options.revokeAfterWait && checks > 1), tier: options.tier === undefined ? 'ESSENTIAL' : options.tier }] };
        }
        if (/^SET LOCAL/.test(sql)) return { rows: [] };
        if (/FROM hon.memberships/.test(sql)) return { rows: args[0] === id && !options.hidden ? [structuredClone(state.membership)] : [] };
        if (/INSERT INTO hon.idempotency_records/.test(sql)) {
          assert.equal(readOnly, false);
          if (state.records[args[3]]) return { rows: [], rowCount: 0 };
          state.records[args[3]] = { request_fingerprint: args[4], status: 'IN_PROGRESS', response_body: null };
          return { rows: [{ id: randomUUID() }], rowCount: 1 };
        }
        if (/FROM hon.idempotency_records/.test(sql)) return { rows: [state.records[args[3]]] };
        if (/UPDATE hon.memberships/.test(sql)) {
          assert.equal(readOnly, false);
          if (state.membership.state !== 'DRAFT' || state.membership.version !== args[1]) return { rows: [] };
          state.membership.state = 'ACTIVE'; state.membership.version++;
          return { rows: [structuredClone(state.membership)] };
        }
        if (/INSERT INTO hon.audit_events/.test(sql)) { if (options.fail === 'audit') throw new Error('fixture evidence failure'); state.audits.push(args); return { rows: [] }; }
        if (/INSERT INTO hon.outbox_events/.test(sql)) { if (options.fail === 'outbox') throw new Error('fixture evidence failure'); state.outbox.push(args); return { rows: [] }; }
        if (/UPDATE hon.idempotency_records/.test(sql)) { if (options.fail === 'idempotency') throw new Error('fixture evidence failure'); Object.assign(state.records[args[3]], { status: 'COMPLETED', response_body: JSON.parse(args[4]) }); return { rows: [] }; }
        throw new Error('Unexpected SQL: ' + sql);
      } }); } catch (e) { state = before; throw e; }
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries, get state() { return state; } };
}

test('unsigned/no agreement evidence and no payment action: canonical activation only; replay retains one evidence pair', async () => {
  const f = fixture(), svc = new MembershipService(f.db), c = context(), before = structuredClone(f.state.membership);
  const result = await svc.activate(c, id, { expectedVersion: 1 });
  assert.equal(result.membership.state, 'ACTIVE'); assert.equal(result.membership.version, 2);
  assert.deepEqual(f.state.membership, { ...before, state: 'ACTIVE', version: 2 });
  assert.equal(f.state.audits.length, 1); assert.equal(f.state.outbox.length, 1);
  assert.deepEqual(JSON.parse(f.state.audits[0][4]), { state: 'DRAFT', version: 1 });
  assert.deepEqual(JSON.parse(f.state.audits[0][5]), { membershipId: id, state: 'ACTIVE', version: 2 });
  assert.deepEqual(await svc.activate(c, id, { expectedVersion: 1 }), { membership: result.membership, replayed: true });
  assert.equal(f.state.audits.length, 1); assert.equal(f.state.outbox.length, 1);
  await assert.rejects(() => svc.activate(c, id, { expectedVersion: 2 }), status(409));
  await assert.rejects(() => svc.activate(context({ idempotencyKey: 'new-key' }), id, { expectedVersion: 2 }), status(409));
});

test('known-ID read is read-only, exact activate permission, bounded and redacted, with no evidence writes', async () => {
  const f = fixture(), svc = new MembershipService(f.db), before = structuredClone(f.state);
  const observed = await svc.readActivationContext(context({ idempotencyKey: '' }), id);
  assert.deepEqual(observed, { organizationId: scope.organizationId, schoolId: scope.schoolId, membershipId: id, state: 'DRAFT', version: 1 });
  assert.deepEqual(f.state, before); assert.equal(f.queries.length, 3);
  assert.ok(f.queries.every(q => q.readOnly)); assert.match(f.queries[2].sql, /LIMIT 1/);
  assert.deepEqual(f.queries[2].args, [id, scope.organizationId, scope.schoolId]);
  const foreign = fixture({ hidden: true });
  await assert.rejects(() => new MembershipService(foreign.db).readActivationContext(context(), id), status(404));
  await assert.rejects(() => new MembershipService(foreign.db).activate(context(), id, { expectedVersion: 1 }), status(404));
  assert.deepEqual(foreign.state.records, {});
});

test('all existing billing tiers accepted, absent/live denied tiers and permissions fail closed, including after waits and replay', async () => {
  for (const tier of ['ESSENTIAL', 'CORE', 'COMPLETE']) {
    const f = fixture({ tier }); assert.equal((await new MembershipService(f.db).activate(context(), id, { expectedVersion: 1 })).membership.state, 'ACTIVE');
  }
  for (const options of [{ tier: null }, { authorized: false }, { revokeAfterWait: true }]) {
    const f = fixture(options), svc = new MembershipService(f.db), before = structuredClone(f.state);
    await assert.rejects(() => svc.activate(context(), id, { expectedVersion: 1 }), status(403)); assert.deepEqual(f.state, before);
  }
  const options = {}, f = fixture(options), svc = new MembershipService(f.db), c = context();
  await svc.activate(c, id, { expectedVersion: 1 }); options.authorized = false;
  await assert.rejects(() => svc.activate(c, id, { expectedVersion: 1 }), status(403));
  await assert.rejects(() => svc.readActivationContext(c, id), status(403));
});

test('stale version and evidence failures roll back membership, idempotency, audit and outbox', async () => {
  const f = fixture(), before = structuredClone(f.state);
  await assert.rejects(() => new MembershipService(f.db).activate(context(), id, { expectedVersion: 2 }), status(409)); assert.deepEqual(f.state, before);
  for (const fail of ['audit', 'outbox', 'idempotency']) {
    const tx = fixture({ fail }), initial = structuredClone(tx.state);
    await assert.rejects(() => new MembershipService(tx.db).activate(context(), id, { expectedVersion: 1 }), /fixture evidence failure/); assert.deepEqual(tx.state, initial);
  }
});

test('nonhuman, delegated, automated, financial and agreement command fields are rejected before SQL', async () => {
  const f = fixture(), svc = new MembershipService(f.db);
  for (const patch of [{ source: 'AI' }, { source: 'PUBLIC_API' }, { source: 'PARENT_APP' }, { principalType: 'AI_EMPLOYEE' }, { principalType: 'SYSTEM_SERVICE' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) {
    await assert.rejects(() => svc.activate(context(patch), id, { expectedVersion: 1 }), status(403));
    await assert.rejects(() => svc.readActivationContext(context(patch), id), status(403));
  }
  for (const key of ['signature', 'agreementStatus', 'paymentSchedule', 'paymentMethod', 'invoice', 'discount', 'authorizePayment', 'autoRenew', 'sendAgreement', 'source', 'principalId']) await assert.rejects(() => svc.activate(context(), id, { expectedVersion: 1, [key]: true }), status(400));
  for (const expectedVersion of [0, -1, 1.5, '1']) await assert.rejects(() => svc.activate(context(), id, { expectedVersion }), status(400));
  await assert.rejects(() => svc.activate(context({ idempotencyKey: '' }), id, { expectedVersion: 1 }), status(409));
  assert.equal(f.queries.length, 0);
});

test('controller derives human attribution and exact scope, with no unauthorized or cross-tenant fallback', async () => {
  const f = fixture(), c = new MembershipController(f.db, new MembershipService(f.db)), req = { honIdentity: { externalSubject: 'verified-human' } };
  assert.equal((await c.activationContext(scope.organizationId, scope.schoolId, id, {}, req)).data.state, 'DRAFT');
  for (const method of [() => c.activationContext(randomUUID(), scope.schoolId, id, {}, req), () => c.activate(randomUUID(), scope.schoolId, id, 'key', { expectedVersion: 1 }, req, response()), () => c.activationContext(scope.organizationId, scope.schoolId, id, {}, {})]) await assert.rejects(method, status(403));
  await assert.rejects(() => c.activationContext(scope.organizationId, scope.schoolId, id, { limit: 100 }, req), status(400));
  f.db.resolveAuthorizedScope = async () => undefined;
  await assert.rejects(() => c.activate(scope.organizationId, scope.schoolId, id, 'key', { expectedVersion: 1 }, req, response()), status(403));
});

test('real HTTP path requires same-origin human marker, exact body and no selectors; redacted read and no new financial endpoints', async () => {
  const oldOrigin = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const f = fixture();
  const module = await Test.createTestingModule({ controllers: [MembershipController], providers: [MembershipService, MembershipActivationHumanUiGuard, { provide: RuntimeDatabaseService, useValue: f.db }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/memberships`,
    headers = { origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'billing.membership.activate', 'Idempotency-Key': 'retained', 'Sec-Fetch-Site': 'same-origin' };
  try {
    const read = await fetch(`${base}/${id}/activation-context`); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual((await read.json()).data, { organizationId: scope.organizationId, schoolId: scope.schoolId, membershipId: id, state: 'DRAFT', version: 1 });
    for (const patch of [{ origin: 'https://other.test' }, { 'X-HON-Human-Command': 'owner-launch-membership-draft' }, { 'X-HON-Human-Command': '' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Content-Type': 'text/plain' }, { 'X-HON-Source': 'AI' }, { 'X-HON-Action-Request-Id': randomUUID() }]) assert.equal((await fetch(`${base}/${id}/activate`, { method: 'POST', headers: { ...headers, ...patch }, body: '{"expectedVersion":1}' })).status, 403);
    for (const patch of [{ signature: 'SIGNED' }, { paymentSchedule: {} }, { initiatePayment: true }, { expectedVersion: 0 }, { expectedVersion: '1' }]) assert.equal((await fetch(`${base}/${id}/activate`, { method: 'POST', headers, body: JSON.stringify({ expectedVersion: 1, ...patch }) })).status, 400);
    assert.equal((await fetch(`${base}/${id}/activation-context?list=all`)).status, 400);
    assert.equal((await fetch(`${base}/${id}/activate?source=AI`, { method: 'POST', headers, body: '{"expectedVersion":1}' })).status, 400);
    assert.equal((await fetch(`${base}`)).status, 404);
    for (const endpoint of ['charge', 'invoice', 'send-agreement', 'schedule', 'authorize']) assert.equal((await fetch(`${base}/${id}/${endpoint}`, { method: 'POST', headers, body: '{}' })).status, 404);
    const activated = await fetch(`${base}/${id}/activate`, { method: 'POST', headers, body: '{"expectedVersion":1}' }); assert.equal(activated.status, 200); assert.equal(activated.headers.get('cache-control'), 'private, no-store');
    assert.equal((await activated.json()).data.state, 'ACTIVE');
  } finally { await app.close(); if (oldOrigin === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = oldOrigin; }
});

test('activation has no agreement/payment/provider/execution dependency or SQL, and no owner-launch activation shortcut', () => {
  const source = readFileSync('src/billing/membership.service.ts', 'utf8').split('async activate(')[1].split('async cancel(')[0];
  assert.doesNotMatch(source, /hon\.(?:document_\w+|agreements|payment_\w+|membership_payment_schedules|invoices|billing_accounts|communication_\w+|action_requests|ai_\w+)|fetch\(|invokeProvider|sendAgreement/);
  assert.doesNotMatch(readFileSync('src/owner-launch/owner-launch.controller.ts', 'utf8'), /memberships\.activate|MembershipService|membership.*\/activate/);
});
