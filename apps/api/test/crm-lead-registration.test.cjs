const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe, ForbiddenException } = require('@nestjs/common');
const { LeadRegistrationController } = require('../dist/crm/lead-registration.controller.js');
const { LeadRegistrationService } = require('../dist/crm/lead-registration.service.js');
const { LeadRegistrationHumanUiGuard, RegisterCrmLeadDto } = require('../dist/crm/lead-registration.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const leadId = randomUUID();
const headers = (key = randomUUID()) => ({
  Origin: 'https://hon.test',
  'Content-Type': 'application/json',
  'X-HON-Human-Command': 'crm-lead-register',
  'Idempotency-Key': key,
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'same-origin',
  'Sec-Fetch-Dest': 'empty',
});
const adult = () => ({ registrationPath: 'ADULT', birthDate: '1990-01-02', confirmation: 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION' });
const guardianChild = () => ({ registrationPath: 'GUARDIAN_CHILD', childGivenName: 'Kai', childFamilyName: 'River', childBirthDate: '2017-03-04', confirmation: 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION' });

test('CRM registration actual global whitelist permits only the closed human DTO paths', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN;
  process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const calls = [];
  const database = { resolveCrmLeadRegistrationScope: async (subject, schoolId) => { assert.equal(subject, 'verified-human'); assert.equal(schoolId, scope.schoolId); return scope; } };
  const registrations = {
    register: async (context, id, input) => {
      calls.push({ context, id, input });
      return {
        result: input.registrationPath === 'ADULT'
          ? { outcome: 'REGISTERED', leadId: id, sourceContactPersonId: randomUUID(), registrationPath: 'ADULT', studentProfileId: randomUUID(), familyId: null, recordedAt: '2026-10-18T20:00:00.000Z' }
          : { outcome: 'REGISTERED', leadId: id, sourceContactPersonId: randomUUID(), registrationPath: 'GUARDIAN_CHILD', studentProfileId: randomUUID(), familyId: randomUUID(), recordedAt: '2026-10-18T20:00:00.000Z' },
        replayed: false,
      };
    },
  };
  const module = await Test.createTestingModule({
    controllers: [LeadRegistrationController],
    providers: [LeadRegistrationHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }, { provide: LeadRegistrationService, useValue: registrations }],
  }).overrideGuard(HonIdentityGuard).useValue({
    canActivate(context) {
      context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' };
      return true;
    },
  }).compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/leads/${leadId}/register`;
  const post = (body, headerPatch = {}) => new Promise((resolve, reject) => {
    const url = new URL(base);
    const payload = JSON.stringify(body);
    const request = http.request({ protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { ...headers(), ...headerPatch, 'Content-Length': Buffer.byteLength(payload) } }, response => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: { get(name) { const value = response.headers[String(name).toLowerCase()]; return Array.isArray(value) ? value[0] : value ?? null; } } }));
    });
    request.once('error', reject);
    request.end(payload);
  });
  try {
    const first = await post(adult());
    const second = await post(guardianChild());
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.headers.get('cache-control'), 'private, no-store');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.input.registrationPath), ['ADULT', 'GUARDIAN_CHILD']);
    for (const patch of [{ actorId: randomUUID() }, { enrollmentId: randomUUID() }, { membershipId: randomUUID() }, { payment: true }, { source: 'AI' }]) {
      assert.equal((await post({ ...adult(), ...patch })).status, 400);
    }
    assert.equal(calls.length, 2);
    assert.equal((await post(adult(), { 'X-HON-Action-Request-Id': randomUUID() })).status, 403);
    assert.equal((await fetch(base, { method: 'GET', headers: headers() })).status, 404);
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    await pipe.transform(adult(), { type: 'body', metatype: RegisterCrmLeadDto });
    await pipe.transform(guardianChild(), { type: 'body', metatype: RegisterCrmLeadDto });
    await assert.rejects(() => pipe.transform({ ...adult(), actorId: randomUUID() }, { type: 'body', metatype: RegisterCrmLeadDto }));
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous;
  }
});

test('CRM registration controller rejects missing identity before a scope read', async () => {
  const controller = new LeadRegistrationController({ resolveCrmLeadRegistrationScope: async () => { throw new Error('must not resolve'); } }, { register: async () => { throw new Error('must not register'); } });
  await assert.rejects(() => controller.register(scope.organizationId, scope.schoolId, leadId, randomUUID(), adult(), {}), error => error instanceof ForbiddenException && error.getStatus() === 403);
});

test('CRM registration is not registered as an Action Engine or automation execution path', () => {
  const config = require('@hon/config');
  assert.equal(config.ACTION_CATALOG.some(action => action.code === 'crm.lead.register'), false);
  assert.equal(config.AUTOMATION_RULE_TRIGGER_REGISTRY.some(trigger => trigger.eventType === 'crm.lead.registration_recorded'), false);
  for (const file of ['lead-registration.service.ts', 'lead-registration.controller.ts']) {
    assert.doesNotMatch(readFileSync(`src/crm/${file}`, 'utf8'), /ActionEngineService|Ai\w*Service|Payment\w*Service|Communication\w*Service|WorkItemService|fetch\(|invokeProvider/);
  }
  const migration = readFileSync('../../packages/database/migrations/0159_crm_lead_registration.sql', 'utf8');
  assert.doesNotMatch(migration, /(?:INSERT INTO|UPDATE|DELETE FROM) hon\.(?:memberships|billing_accounts|invoices|payment_attempts|communication_messages|communication_consents|work_items|action_requests|action_approvals|automation_rules|class_bookings|attendance_records|ai_usage_ledger|ai_invocation_plans)/);
  assert.match(migration, /'crm\.lead\.registration_recorded'/);
  assert.match(migration, /'executionAllowed',false,'humanOnly',true/);
});
