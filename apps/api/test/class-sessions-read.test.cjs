const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { ForbiddenException, UnauthorizedException } = require('@nestjs/common');
const { GUARDS_METADATA } = require('@nestjs/common/constants');
const { Test } = require('@nestjs/testing');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { ClassSessionsReadController } = require('../dist/schedule/class-sessions-read.controller.js');
const { ClassSessionsReadHumanUiGuard } = require('../dist/schedule/class-sessions-read-human-ui.guard.js');
const { ClassSessionsReadService } = require('../dist/schedule/class-sessions-read.service.js');
const id = () => randomUUID(); const organizationId = id(), schoolId = id(), principalId = id();
const item = { sessionId: id(), name: 'Morning fundamentals', startsAt: '2026-10-16T12:00:00.000Z', endsAt: '2026-10-16T13:00:00.000Z', roomName: null, capacity: 12, bookingPolicy: 'REQUIRED_BOOKING', status: 'SCHEDULED', createdAt: '2026-10-10T12:00:00.000Z' };
const status = (code) => (error) => error.getStatus?.() === code;
function headers(patch = {}) { return { origin: 'https://hon.test', 'x-hon-human-read': 'class-sessions', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', ...patch }; }

test('Class Sessions read composes identity then strict direct-human read transport', () => {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, ClassSessionsReadController), [HonIdentityGuard, ClassSessionsReadHumanUiGuard]);
  const module = readFileSync('src/app.module.ts', 'utf8');
  assert(module.includes("import { ClassSessionsReadController } from './schedule/class-sessions-read.controller.js'"));
  assert(module.includes('    ClassSessionsReadController,')); assert(module.includes('    ClassSessionsReadHumanUiGuard,'));
});

test('Class Sessions GET guard fails closed for selectors, bodies, cross-origin metadata and authority injection', () => {
  const prior = process.env.HON_PUBLIC_ORIGIN; const guard = new ClassSessionsReadHumanUiGuard();
  const run = (patch = {}, requestPatch = {}) => guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ method: 'GET', headers: headers(patch), query: {}, originalUrl: '/v1/organizations/x/schools/y/schedule/sessions', body: undefined, ...requestPatch }), getResponse: () => ({ setHeader() {} }) }) });
  try {
    process.env.HON_PUBLIC_ORIGIN = 'https://hon.test'; assert.equal(run(), true);
    for (const patch of [{ origin: undefined }, { origin: 'https://evil.test' }, { 'x-hon-human-read': undefined }, { 'x-hon-human-read': 'class-bookings' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-mode': 'cors' }, { 'sec-fetch-dest': 'document' }, { authorization: 'Bearer external' }, { 'x-principal-id': principalId }, { 'x-hon-source': 'AUTOMATION' }, { 'idempotency-key': randomUUID() }]) assert.throws(() => run(patch), status(403));
    for (const requestPatch of [{ query: { range: 'all' }, originalUrl: '/v1/x?range=all' }, { body: {} }, { headers: { ...headers(), 'content-length': '1' } }]) assert.throws(() => run({}, requestPatch), status(400));
  } finally { if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});

test('Class Sessions endpoint independently resolves exact read scope before invoking only the fixed read service', async () => {
  const calls = []; const db = { resolveAuthorizedScope: async (...args) => { calls.push(['scope', ...args]); return { organizationId, schoolId, principalId }; } };
  const service = { read: async (context) => { calls.push(['read', context]); return [item]; } };
  const module = await Test.createTestingModule({ controllers: [ClassSessionsReadController], providers: [ClassSessionsReadHumanUiGuard, { provide: RuntimeDatabaseService, useValue: db }, { provide: ClassSessionsReadService, useValue: service }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { const request = context.switchToHttp().getRequest(); if (request.headers.cookie !== 'test-human-session=verified') throw new UnauthorizedException(); request.honIdentity = { externalSubject: 'verified-subject' }; return true; } }).compile();
  const app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1');
  try {
    process.env.HON_PUBLIC_ORIGIN = 'https://hon.test'; await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    const path = `/v1/organizations/${organizationId}/schools/${schoolId}/schedule/sessions`; const baseHeaders = { Cookie: 'test-human-session=verified', Origin: 'https://hon.test', 'X-HON-Human-Read': 'class-sessions', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty' };
    const get = (patch = {}, route = path) => fetch(base + route, { headers: { ...baseHeaders, ...patch }, cache: 'no-store', mode: 'same-origin' });
    assert.equal((await get({ Cookie: '' })).status, 401); assert.equal((await get({ Authorization: 'Bearer no' })).status, 403); assert.equal((await get({}, `${path}?search=x`)).status, 400); assert.equal((await get({}, path.replace(organizationId, id()))).status, 403);
    const response = await get(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow'); const envelope = await response.json(); assert.deepEqual(Object.keys(envelope), ['data', 'meta']); assert.deepEqual(envelope.data, [item]); assert.equal(envelope.meta.requestId, envelope.meta.correlationId);
    assert.deepEqual(calls.at(-2), ['scope', 'verified-subject', schoolId, 'schedule.session.read']); const context = calls.at(-1)[1]; assert.equal(context.organizationId, organizationId); assert.equal(context.schoolId, schoolId); assert.equal(context.principalId, principalId); assert.equal(context.principalType, 'HUMAN_USER'); assert.equal(context.source, 'HUMAN_UI'); assert.equal(context.externalSubject, 'verified-subject');
  } finally { await app.close(); delete process.env.HON_PUBLIC_ORIGIN; }
});

test('Class Sessions read source carries no mutation, generic search, roster, booking, attendance, payment, AI or action dependency', () => {
  const source = ['class-sessions-read.controller.ts','class-sessions-read.service.ts','class-sessions-read-human-ui.guard.ts'].map((file) => readFileSync(`src/schedule/${file}`, 'utf8')).join('\n');
  assert.doesNotMatch(source, /@(?:Post|Patch|Put|Delete)\(|(?:INSERT|UPDATE|DELETE|TRUNCATE)\s/i);
  const migration = readFileSync('../../packages/database/migrations/0147_current_school_class_sessions_read.sql', 'utf8');
  assert.match(migration, /LIMIT 50/); assert.match(migration, /schedule\.session\.read/); assert.match(migration, /FORCE ROW LEVEL SECURITY/); assert.match(migration, /REVOKE SELECT ON TABLE hon\.class_sessions/); assert.doesNotMatch(migration, /INSERT INTO hon\.(?:audit_events|outbox_events|class_bookings|attendance_records)/i);
});
