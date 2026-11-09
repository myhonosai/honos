const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { HqOnboardingController } = require('../dist/hq/hq-onboarding.controller.js');
const { HqOnboardingService, verifyProvisioningReceipt, provisioningFailure } = require('../dist/hq/hq-onboarding.service.js');
const { HqSchoolProvisioningHumanGuard } = require('../dist/hq/hq-school-provisioning-human.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const principal = randomUUID();
const receipt = (extra = {}) => ({ organizationId: randomUUID(), schoolId: randomUUID(), ownerRoleId: randomUUID(), replayed: false, actorPrincipalId: principal, entitlementStatus: 'SUSPENDED', ...extra });
const body = { legalName: 'Synthetic Dojo LLC', displayName: 'Synthetic Dojo', schoolName: 'Synthetic Dojo Main', schoolSlug: 'synthetic-dojo', timezone: 'America/Los_Angeles', initialTier: 'COMPLETE' };
const status = expected => error => error.getStatus?.() === expected;

test('closed provisioning receipt: exact fields, actor echo bound to the expected principal, new schools SUSPENDED', () => {
  const ok = receipt();
  assert.deepEqual(verifyProvisioningReceipt(ok, principal.toUpperCase()), ok);
  assert.deepEqual(verifyProvisioningReceipt({ ...ok, replayed: true, entitlementStatus: 'ACTIVE' }, principal).entitlementStatus, 'ACTIVE');
  for (const bad of [null, [], 'x', { ...ok, extra: 1 }, { ...ok, tier: 'COMPLETE' }, (({ actorPrincipalId, ...rest }) => rest)(ok),
    { ...ok, actorPrincipalId: randomUUID() }, { ...ok, organizationId: 'nope' }, { ...ok, replayed: 'false' },
    { ...ok, entitlementStatus: 'PAID' }, { ...ok, entitlementStatus: 'ACTIVE' }]) {
    assert.throws(() => verifyProvisioningReceipt(bad, principal), status(503));
  }
});

test('database failures map to closed codes without detail', () => {
  const code = (c, m = 'private-school-SQL') => { try { provisioningFailure(Object.assign(new Error(m), { code: c })); } catch (e) { return [e.getStatus(), e.getResponse().code, JSON.stringify(e.getResponse()).includes('private')]; } };
  assert.deepEqual(code('42501', 'HQ_EXPECTED_PRINCIPAL_MISMATCH'), [409, 'HQ_EXPECTED_PRINCIPAL_MISMATCH', false]);
  for (const [c, http, out] of [['42501', 403, 'HQ_PROVISIONING_FORBIDDEN'], ['23505', 409, 'HQ_PROVISIONING_CONFLICT'], ['55P03', 409, 'HQ_PROVISIONING_IN_PROGRESS'],
    ['40001', 409, 'HQ_PROVISIONING_IN_PROGRESS'], ['P0001', 400, 'HQ_PROVISIONING_INPUT_INVALID'], ['22023', 400, 'HQ_PROVISIONING_INPUT_INVALID'], ['XX000', 503, 'HQ_PROVISIONING_UNAVAILABLE'], [undefined, 503, 'HQ_PROVISIONING_UNAVAILABLE']]) {
    assert.deepEqual(code(c), [http, out, false]);
  }
});

test('service passes the expected principal and a server fingerprint to the bound database function', async () => {
  const calls = [];
  const service = new HqOnboardingService({ provisionSchoolFromHq: async command => { calls.push(command); return receipt(); } });
  const key = randomUUID();
  await service.provisionInitialSchool({ externalSubject: 'verified-human' }, { ...body, schoolSlug: ' Synthetic-Dojo ', idempotencyKey: key, expectedPrincipalId: principal.toUpperCase() });
  assert.equal(calls[0].expectedPrincipalId, principal); assert.equal(calls[0].externalSubject, 'verified-human'); assert.equal(calls[0].schoolSlug, 'synthetic-dojo');
  assert.equal(calls[0].idempotencyKey, key); assert.match(calls[0].requestFingerprint, /^[0-9a-f]{64}$/);
  await assert.rejects(() => service.provisionInitialSchool({ externalSubject: 'verified-human' }, { ...body, idempotencyKey: key, expectedPrincipalId: 'nope' }), status(400));
  const drift = new HqOnboardingService({ provisionSchoolFromHq: async () => receipt({ actorPrincipalId: randomUUID() }) });
  await assert.rejects(() => drift.provisionInitialSchool({ externalSubject: 'verified-human' }, { ...body, idempotencyKey: key, expectedPrincipalId: principal }), status(503));
});

test('database path calls only the expected-principal-bound function', async () => {
  const database = new RuntimeDatabaseService(); database.assertRuntimePosture = async () => {};
  const seen = []; const data = receipt();
  database.getPool = () => ({ query: async (sql, args) => { seen.push([sql, args]); return { rows: [{ data }] }; } });
  assert.deepEqual(await database.provisionSchoolFromHq({ externalSubject: 's', expectedPrincipalId: principal, ...body, idempotencyKey: 'k', requestFingerprint: 'f', requestId: randomUUID(), correlationId: randomUUID() }), data);
  assert.equal(seen.length, 1); assert.match(seen[0][0], /^SELECT hon\.provision_school_from_hq_human\(\$1, \$2::uuid,/); assert.equal(seen[0][1].length, 12); assert.equal(seen[0][1][1], principal);
  assert.doesNotMatch(seen[0][0], /hon\.provision_school_from_hq\(/);
});

test('POST /hq/organizations requires the direct-human same-origin gate before identity and the database', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = []; let identityCalls = 0; let scope = true; let failure;
  const module = await Test.createTestingModule({ controllers: [HqOnboardingController], providers: [HqOnboardingService, HqSchoolProvisioningHumanGuard,
    { provide: RuntimeDatabaseService, useValue: { resolveHqOperatorScope: async () => scope ? { principalId: principal } : null,
      provisionSchoolFromHq: async command => { calls.push(command); if (failure) throw failure; return receipt({ replayed: calls.length === 2 }); } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { identityCalls++; context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/organizations`;
  const key = randomUUID();
  const headers = { 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': 'hq-school-provisioning', 'x-hon-expected-principal': principal,
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': key };
  const post = (extra = {}, payload = body, url = base, method = 'POST') => new Promise((resolve, reject) => {
    const h = { ...headers, ...extra }; for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const req = httpRequest(url, { method, headers: h }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null })); });
    req.on('error', reject); req.end(JSON.stringify(payload));
  });
  try {
    const created = await post(); assert.equal(created.status, 201); assert.match(created.headers['cache-control'], /no-store/);
    assert.equal(created.json.data.actorPrincipalId, principal); assert.equal(created.json.data.entitlementStatus, 'SUSPENDED'); assert.deepEqual(created.json.meta, { replayed: false });
    assert.equal(calls[0].expectedPrincipalId, principal);
    const replay = await post(); assert.equal(replay.status, 200); assert.deepEqual(replay.json.meta, { replayed: true });
    const before = calls.length; const identityBefore = identityCalls;
    for (const extra of [{ origin: 'https://attacker.example' }, { origin: undefined }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': undefined }, { 'sec-fetch-mode': 'cors' },
      { 'sec-fetch-dest': 'document' }, { 'sec-fetch-user': '?1' }, { 'x-hon-human-command': 'school-owner-account' }, { 'x-hon-human-command': undefined },
      { 'x-hon-principal-type': 'HUMAN_USER' }, { 'x-hon-action-request': randomUUID() }, { authorization: 'Bearer x' }, { 'content-type': 'text/plain' }]) {
      assert.equal((await post(extra)).status, 403, JSON.stringify(extra));
    }
    for (const extra of [{ 'x-hon-expected-principal': undefined }, { 'x-hon-expected-principal': 'not-a-uuid' }]) assert.equal((await post(extra)).status, 400);
    for (const extra of [{ 'idempotency-key': undefined }, { 'idempotency-key': 'free-text-key' }]) assert.equal((await post(extra)).status, 409);
    assert.equal((await post({}, body, base + '?tier=ACTIVE')).status, 400);
    assert.equal(calls.length, before); assert.equal(identityCalls, identityBefore, 'the human gate runs before identity resolution');
    for (const payload of [{ ...body, principalId: principal }, { ...body, schoolSlug: 'Bad Slug' }, { ...body, initialTier: 'PREMIUM' }]) assert.equal((await post({}, payload)).status, 400);
    assert.equal(calls.length, before);
    scope = false; assert.equal((await post()).status, 403); scope = true; assert.equal(calls.length, before);
    failure = Object.assign(new Error('HQ_EXPECTED_PRINCIPAL_MISMATCH'), { code: '42501' });
    const mismatch = await post(); assert.equal(mismatch.status, 409); assert.equal(mismatch.json.code, 'HQ_EXPECTED_PRINCIPAL_MISMATCH');
    failure = Object.assign(new Error('private'), { code: '42501' }); assert.equal((await post()).status, 403);
    failure = undefined;
    process.env.HON_PUBLIC_ORIGIN = ''; assert.equal((await post()).status, 503);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
