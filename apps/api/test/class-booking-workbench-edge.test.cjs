const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
require('reflect-metadata');
const { ValidationPipe, UnauthorizedException } = require('@nestjs/common');
const { GUARDS_METADATA } = require('@nestjs/common/constants');
const { Test } = require('@nestjs/testing');
const { CLASS_BOOKING_KINDS } = require('@hon/contracts');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { ClassBookingController } = require('../dist/schedule/class-booking.controller.js');
const { ClassBookingService } = require('../dist/schedule/class-booking.service.js');
const { ClassBookingHumanUiGuard } = require('../dist/schedule/class-booking-human-ui.guard.js');
const { CreateClassBookingDto } = require('../dist/schedule/create-class-booking.dto.js');
const status = n => e => e.getStatus?.() === n;
const organizationId = randomUUID(), schoolId = randomUUID(), sessionId = randomUUID(), studentProfileId = randomUUID(), principalId = randomUUID();
const input = { studentProfileId, bookingKind: 'REGULAR' };

test('booking controller adds only the existing trusted-human transport convention and keeps identity first', () => {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, ClassBookingController), [HonIdentityGuard, ClassBookingHumanUiGuard]);
  const module = readFileSync(join(__dirname, '../src/app.module.ts'), 'utf8');
  assert(module.includes("import { ClassBookingHumanUiGuard } from './schedule/class-booking-human-ui.guard.js'"));
  assert(module.includes('    ClassBookingHumanUiGuard,'));
});

test('booking HTTP guard fails closed for missing/malformed origin, non-JSON, wrong/missing command and cross-site transport', () => {
  const before = process.env.HON_PUBLIC_ORIGIN;
  const guard = new ClassBookingHumanUiGuard();
  const run = headers => guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ method: 'POST', headers }) }) });
  try {
    process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
    const headers = { origin: 'https://hon.test', 'x-hon-human-command': 'class-booking', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
    assert.equal(run(headers), true);
    assert.equal(run({ ...headers, 'content-type': 'application/json; charset=utf-8' }), true);
    for (const patch of [{ origin: undefined }, { origin: 'null' }, { origin: 'https://other.hon.test' }, { origin: 'https://hon.test/anything' }, { origin: ['https://hon.test'] }, { 'x-hon-human-command': undefined }, { 'x-hon-human-command': 'attendance' }, { 'x-hon-human-command': 'AUTOMATION' }, { 'content-type': undefined }, { 'content-type': 'text/plain' }, { 'content-type': 'application/json-malformed' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.throws(() => run({ ...headers, ...patch }), status(403));
    }
    for (const method of ['PATCH', 'DELETE', 'PUT']) assert.throws(() => guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ method, headers }) }) }), status(403));
    for (const value of [undefined, '', 'https://hon.test/path', 'https://user:secret@hon.test']) {
      if (value === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = value;
      assert.throws(() => run(headers), status(503));
    }
  } finally { if (before === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = before; }
});

test('canonical booking DTO remains closed to CLASS_PASS, authority and capacity/policy/body additions', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  for (const bookingKind of CLASS_BOOKING_KINDS) {
    const result = await pipe.transform({ studentProfileId, bookingKind }, { type: 'body', metatype: CreateClassBookingDto });
    assert.equal(result.bookingKind, bookingKind);
  }
  for (const patch of [{ bookingKind: 'CLASS_PASS' }, { bookingKind: 'PRIVATE' }, { studentProfileId: 'a name' }, { source: 'HUMAN_UI' }, { principalId }, { organizationId }, { schoolId }, { sessionId }, { status: 'BOOKED' }, { capacity: 100 }, { bookingPolicy: 'WALK_IN' }, { expectedVersion: 1 }, { actionRequestId: randomUUID() }]) {
    await assert.rejects(() => pipe.transform({ ...input, ...patch }, { type: 'body', metatype: CreateClassBookingDto }), status(400));
  }
});

test('real local HTTP route runs identity + human guard + exact scope/DTO before the sole canonical create; BOOKED/WAITLISTED/replay semantics stay unchanged', async () => {
  const before = process.env.HON_PUBLIC_ORIGIN;
  const calls = [], resolutions = [];
  let replayed = false, returnedStatus = 'WAITLISTED';
  const database = { resolveAuthorizedScope: async (...args) => { resolutions.push(args); return { organizationId, schoolId, principalId }; } };
  const bookings = { create: async (context, session, body) => {
    calls.push({ context, session, body });
    return { booking: { id: randomUUID(), classSessionId: session, studentProfileId: body.studentProfileId, bookingKind: body.bookingKind, status: returnedStatus, source: 'STAFF', bookedAt: '2026-10-16T00:00:00.000Z', version: 1, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', sessionCapacity: 1, activeSeatCount: 1, bookingPolicy: 'REQUIRED_BOOKING' }, replayed, created: !replayed };
  } };
  const module = await Test.createTestingModule({ controllers: [ClassBookingController], providers: [ClassBookingHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }, { provide: ClassBookingService, useValue: bookings }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate: context => {
      const request = context.switchToHttp().getRequest();
      if (request.headers.cookie !== 'test-human-session=verified') throw new UnauthorizedException();
      request.honIdentity = { externalSubject: 'verified-human-subject' }; return true;
    } }).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  try {
    process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const path = `/v1/organizations/${organizationId}/schools/${schoolId}/schedule/sessions/${sessionId}/bookings`;
    const headers = { Cookie: 'test-human-session=verified', Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'class-booking', 'Idempotency-Key': 'legacy-human-key' };
    const post = (patch = {}, body = input, route = path) => fetch(origin + route, { method: 'POST', headers: { ...headers, ...patch }, body: JSON.stringify(body) });
    assert.equal((await post({ Cookie: '' })).status, 401);
    assert.equal((await post({ 'X-HON-Human-Command': '' })).status, 403);
    assert.equal((await post({ Origin: 'https://evil.test' })).status, 403);
    assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post({}, { ...input, bookingKind: 'CLASS_PASS' })).status, 400);
    assert.equal((await post({}, { ...input, capacity: 100 })).status, 400);
    assert.equal((await post({}, input, path.replace(organizationId, randomUUID()))).status, 403);
    assert.equal((await post({ 'Idempotency-Key': '' })).status, 409);
    assert.equal(calls.length, 0);
    const result = await post(); assert.equal(result.status, 201);
    const envelope = await result.json(); assert.equal(envelope.data.status, 'WAITLISTED'); assert.equal(envelope.meta.replayed, false);
    assert.deepEqual(Object.keys(envelope), ['data', 'meta']);
    assert.equal(envelope.meta.requestId, envelope.meta.correlationId);
    assert.deepEqual(resolutions.at(-1), ['verified-human-subject', schoolId, 'schedule.booking.manage']);
    assert.deepEqual({ ...calls[0].body }, input); assert.equal(calls[0].session, sessionId);
    assert.equal(calls[0].context.source, 'HUMAN_UI'); assert.equal(calls[0].context.principalType, 'HUMAN_USER');
    assert.equal(calls[0].context.principalId, principalId); assert.equal(calls[0].context.idempotencyKey, 'legacy-human-key');
    assert.equal(calls[0].context.externalSubject, 'verified-human-subject');
    assert(!calls[0].context.actionRequestId && !calls[0].context.delegatedByPrincipalId);
    replayed = true; returnedStatus = 'BOOKED';
    const replay = await post(); assert.equal(replay.status, 200); assert.equal((await replay.json()).data.status, 'BOOKED');
    assert.equal((await fetch(origin + path, { headers })).status, 404);
    assert.equal(calls.length, 2);
    delete process.env.HON_PUBLIC_ORIGIN; assert.equal((await post()).status, 503); assert.equal(calls.length, 2);
  } finally {
    await app.close();
    if (before === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = before;
  }
});
