const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
require('reflect-metadata');
const { ForbiddenException, UnauthorizedException, ValidationPipe } = require('@nestjs/common');
const { GUARDS_METADATA } = require('@nestjs/common/constants');
const { Test } = require('@nestjs/testing');
const { CLASS_SESSION_BOOKING_POLICIES } = require('@hon/contracts');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { ClassSessionController } = require('../dist/schedule/class-session.controller.js');
const { ClassSessionHumanUiGuard } = require('../dist/schedule/class-session-human-ui.guard.js');
const { ClassSessionService } = require('../dist/schedule/class-session.service.js');
const { CreateClassSessionDto } = require('../dist/schedule/create-class-session.dto.js');
const status = n => error => error.getStatus?.() === n;
const organizationId = randomUUID(), schoolId = randomUUID(), programId = randomUUID(), principalId = randomUUID();
const input = { programId, name: 'Morning fundamentals', roomName: 'Dojo A', startsAt: '2026-10-16T12:00:00.000Z', endsAt: '2026-10-16T13:00:00.000Z', capacity: 12, bookingPolicy: 'REQUIRED_BOOKING' };
const browserKey = randomUUID();

function headers(patch = {}) {
  return { origin: 'https://hon.test', 'content-type': 'application/json', 'idempotency-key': browserKey, 'x-hon-human-command': 'class-session', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', ...patch };
}

test('class-session controller composes identity then the strict direct-human browser command guard', () => {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, ClassSessionController), [HonIdentityGuard, ClassSessionHumanUiGuard]);
  const module = readFileSync(join(__dirname, '../src/app.module.ts'), 'utf8');
  assert(module.includes("import { ClassSessionHumanUiGuard } from './schedule/class-session-human-ui.guard.js'"));
  assert(module.includes('    ClassSessionHumanUiGuard,'));
});

test('class-session browser command guard fails closed for missing/wrong marker, unsafe Fetch Metadata, non-JSON, origin, UUID key and external authority headers', () => {
  const prior = process.env.HON_PUBLIC_ORIGIN;
  const guard = new ClassSessionHumanUiGuard();
  const run = (patch = {}) => guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ method: 'POST', headers: headers(patch), query: {}, originalUrl: '/v1/organizations/x/schools/y/schedule/sessions' }), getResponse: () => ({ setHeader() {} }) }) });
  try {
    process.env.HON_PUBLIC_ORIGIN = 'https://hon.test'; assert.equal(run(), true);
    // Next's rewrite proxy sets X-Forwarded-Host to the public host; POST still requires an exact Origin.
    assert.equal(run({ 'x-forwarded-host': 'hon.test' }), true);
    for (const patch of [
      { origin: undefined }, { origin: undefined, 'x-forwarded-host': 'hon.test' }, { 'x-forwarded-host': 'hon.test, evil.test' }, { 'x-forwarded-for': '203.0.113.9' }, { 'x-forwarded-proto': 'http' }, { origin: 'https://evil.test' }, { 'x-hon-human-command': undefined }, { 'x-hon-human-command': 'class-booking' },
      { 'content-type': 'text/plain' }, { 'idempotency-key': 'legacy-key' }, { 'sec-fetch-site': undefined }, { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-mode': undefined }, { 'sec-fetch-mode': 'cors' }, { 'sec-fetch-dest': undefined }, { 'sec-fetch-dest': 'document' },
      { 'x-hon-source': 'AUTOMATION' }, { authorization: 'Bearer external' }, { 'x-principal-id': principalId }, { forwarded: 'host=evil.test' }, { 'x-forwarded-host': 'evil.test' },
    ]) assert.throws(() => run(patch), status(403));
    const selector = { switchToHttp: () => ({ getRequest: () => ({ method: 'POST', headers: headers(), query: { programId }, originalUrl: '/v1/organizations/x?programId=y' }), getResponse: () => ({ setHeader() {} }) }) };
    assert.throws(() => guard.canActivate(selector), status(400));
    process.env.HON_PUBLIC_ORIGIN = 'https://hon.test/path'; assert.throws(() => run(), status(503));
  } finally { if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});

test('canonical session DTO remains closed to authority, status and unrecognized fields while retaining canonical limits and policies', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  for (const bookingPolicy of CLASS_SESSION_BOOKING_POLICIES) {
    const result = await pipe.transform({ ...input, bookingPolicy }, { type: 'body', metatype: CreateClassSessionDto });
    assert.equal(result.bookingPolicy, bookingPolicy);
  }
  for (const patch of [{ programId: 'not-a-uuid' }, { name: '' }, { roomName: 'x'.repeat(161) }, { capacity: 0 }, { bookingPolicy: 'OPEN' }, { status: 'SCHEDULED' }, { principalId }, { organizationId }, { schoolId }, { source: 'HUMAN_UI' }, { actionRequestId: randomUUID() }, { instructorId: randomUUID() }]) {
    await assert.rejects(() => pipe.transform({ ...input, ...patch }, { type: 'body', metatype: CreateClassSessionDto }), status(400));
  }
});

test('old direct session API path cannot bypass strict transport, unknown-field or independent exact-scope checks before canonical create', async () => {
  const prior = process.env.HON_PUBLIC_ORIGIN; const calls = []; const scopes = [];
  const database = { resolveAuthorizedScope: async (...args) => { scopes.push(args); return { organizationId, schoolId, principalId }; } };
  const service = { create: async (context, body) => { calls.push({ context, body }); return { classSession: { id: randomUUID(), ...body, status: 'SCHEDULED', version: 1, createdAt: '2026-10-16T10:00:00.000Z' }, replayed: false }; } };
  const module = await Test.createTestingModule({ controllers: [ClassSessionController], providers: [ClassSessionHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }, { provide: ClassSessionService, useValue: service }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate: context => { const req = context.switchToHttp().getRequest(); if (req.headers.cookie !== 'test-human-session=verified') throw new UnauthorizedException(); req.honIdentity = { externalSubject: 'verified-human-subject' }; return true; } }).compile();
  const app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  try {
    process.env.HON_PUBLIC_ORIGIN = 'https://hon.test'; await app.listen(0, '127.0.0.1'); const origin = await app.getUrl();
    const path = `/v1/organizations/${organizationId}/schools/${schoolId}/schedule/sessions`;
    const baseHeaders = { Cookie: 'test-human-session=verified', Origin: 'https://hon.test', 'Content-Type': 'application/json', 'Idempotency-Key': browserKey, 'X-HON-Human-Command': 'class-session', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty' };
    const post = (patch = {}, body = input, route = path) => fetch(origin + route, { method: 'POST', mode: 'same-origin', cache: 'no-store', headers: { ...baseHeaders, ...patch }, body: JSON.stringify(body) });
    assert.equal((await post({ Cookie: '' })).status, 401);
    for (const patch of [{ 'X-HON-Human-Command': '' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-Site': undefined }, { 'X-HON-Source': 'AUTOMATION' }, { Authorization: 'Bearer external' }, { 'X-Forwarded-Host': 'evil.test' }]) assert.equal((await post(patch)).status, 403);
    assert.equal((await post({}, { ...input, status: 'SCHEDULED' })).status, 400);
    assert.equal((await post({}, { ...input, instructorId: randomUUID() })).status, 400);
    assert.equal((await post({}, input, path.replace(organizationId, randomUUID()))).status, 403);
    assert.equal(calls.length, 0);
    const created = await post(); assert.equal(created.status, 201); const envelope = await created.json();
    assert.deepEqual(Object.keys(envelope), ['data', 'meta']); assert.equal(envelope.data.status, 'SCHEDULED'); assert.equal(envelope.meta.replayed, false); assert.equal(envelope.meta.requestId, envelope.meta.correlationId);
    assert.deepEqual(scopes.at(-1), ['verified-human-subject', schoolId, 'schedule.session.manage']); assert.deepEqual({ ...calls[0].body }, input); assert.equal(calls[0].context.source, 'HUMAN_UI'); assert.equal(calls[0].context.principalType, 'HUMAN_USER'); assert.equal(calls[0].context.principalId, principalId); assert.equal(calls[0].context.idempotencyKey, browserKey);
  } finally { await app.close(); if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});
