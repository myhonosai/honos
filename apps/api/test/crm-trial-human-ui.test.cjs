const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { TrialAppointmentController } = require('../dist/crm/trial-appointment.controller.js');
const { TrialAppointmentOutcomeController } = require('../dist/crm/trial-appointment-outcome.controller.js');
const { TrialAppointmentService } = require('../dist/crm/trial-appointment.service.js');
const { TrialAppointmentOutcomeService } = require('../dist/crm/trial-appointment-outcome.service.js');
const { TrialAppointmentHumanUiGuard } = require('../dist/crm/trial-appointment-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const leadId = randomUUID(), appointmentId = randomUUID();

test('trial schedule and outcome accept only same-origin human-UI JSON commands with the fixed marker', async () => {
  const old = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  let scopeReads = 0, schedules = 0, outcomes = 0;
  const db = { resolveAuthorizedScope: async () => { scopeReads++; return scope; } };
  const module = await Test.createTestingModule({
    controllers: [TrialAppointmentController, TrialAppointmentOutcomeController],
    providers: [TrialAppointmentHumanUiGuard, { provide: RuntimeDatabaseService, useValue: db },
      { provide: TrialAppointmentService, useValue: { schedule: async () => { schedules++; return { appointment: { id: appointmentId }, replayed: false }; } } },
      { provide: TrialAppointmentOutcomeService, useValue: { record: async () => { outcomes++; return { appointment: { id: appointmentId }, replayed: false }; } } }],
  }).overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: 'trusted' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const root = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm`;
  const schedulePath = `${root}/leads/${leadId}/trials`, outcomePath = `${root}/appointments/${appointmentId}/outcome`;
  const headers = () => ({ Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'crm-trial-appointment', 'Idempotency-Key': randomUUID(), 'Sec-Fetch-Site': 'same-origin' });
  const scheduleBody = { startsAt: '2026-11-20T17:00:00.000Z', endsAt: '2026-11-20T18:00:00.000Z' };
  const outcomeBody = { status: 'COMPLETED', expectedVersion: 1 };
  const post = (path, body, patch = {}) => fetch(path, { method: 'POST', headers: { ...headers(), ...patch }, body: JSON.stringify(body) });
  const rejected = [{ Origin: 'https://bad.test' }, { Origin: '' }, { 'X-HON-Human-Command': '' }, { 'X-HON-Human-Command': 'crm-lead-close' },
    { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Content-Type': 'text/plain' },
    { 'X-HON-Source': 'HUMAN_UI' }, { 'X-HON-Action-Request-Id': randomUUID() }, { 'X-HON-Delegated-By-Principal-Id': randomUUID() }];
  try {
    const s = await post(schedulePath, scheduleBody); assert.equal(s.status, 201); assert.equal(s.headers.get('cache-control'), 'private, no-store');
    const o = await post(outcomePath, outcomeBody); assert.equal(o.status, 200);
    assert.deepEqual({ scopeReads, schedules, outcomes }, { scopeReads: 2, schedules: 1, outcomes: 1 });
    // A missing Sec-Fetch-Site (older or non-browser same-origin client) is allowed; the origin and marker still apply.
    const noFetchMeta = headers(); delete noFetchMeta['Sec-Fetch-Site'];
    assert.equal((await fetch(schedulePath, { method: 'POST', headers: noFetchMeta, body: JSON.stringify(scheduleBody) })).status, 201);
    for (const patch of rejected) {
      assert.equal((await post(schedulePath, scheduleBody, patch)).status, 403, `schedule ${JSON.stringify(patch)}`);
      assert.equal((await post(outcomePath, outcomeBody, patch)).status, 403, `outcome ${JSON.stringify(patch)}`);
    }
    assert.equal((await post(`${schedulePath}?schoolId=${scope.schoolId}`, scheduleBody)).status, 400);
    assert.equal((await post(`${outcomePath}?leadId=${leadId}`, outcomeBody)).status, 400);
    // Refused requests never reach scope resolution or a service.
    assert.deepEqual({ scopeReads, schedules, outcomes }, { scopeReads: 3, schedules: 2, outcomes: 1 });
    delete process.env.HON_PUBLIC_ORIGIN;
    assert.equal((await post(schedulePath, scheduleBody)).status, 503);
    assert.equal((await post(outcomePath, outcomeBody)).status, 503);
  } finally {
    await app.close();
    if (old === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = old;
  }
});
