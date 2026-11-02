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

test('trial reconciliation reads are GET-only, selector-free, never cached and resolve exact-school trial permission', async () => {
  const { TrialAppointmentReadController } = require('../dist/crm/trial-appointment-read.controller.js');
  const { TrialAppointmentReadGuard } = require('../dist/crm/trial-appointment-human-ui.guard.js');
  const granted = new Set(['crm.trial.manage']);
  let scopeOrg = scope.organizationId, lists = 0, reads = 0;
  const permissionsAsked = [];
  const db = { resolveAuthorizedScope: async (_subject, _school, permission) => { permissionsAsked.push(permission); return granted.has(permission) ? { ...scope, organizationId: scopeOrg } : null; } };
  const module = await Test.createTestingModule({
    controllers: [TrialAppointmentController, TrialAppointmentReadController],
    providers: [TrialAppointmentHumanUiGuard, TrialAppointmentReadGuard, { provide: RuntimeDatabaseService, useValue: db },
      { provide: TrialAppointmentService, useValue: {
        listForLead: async (context) => { lists++; assert.equal(context.source, 'HUMAN_UI'); assert.equal(context.principalType, 'HUMAN_USER'); return { result: { activeTrial: null, trials: [] }, access: { mode: 'FULL' } }; },
        readOne: async (_context, id) => { reads++; return { result: { id }, access: { mode: 'FULL' } }; } } }],
  }).overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: 'trusted' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1');
  await app.listen(0, '127.0.0.1');
  const root = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm`;
  const listPath = `${root}/leads/${leadId}/trials`, detailPath = `${root}/appointments/${appointmentId}`;
  const get = (path, headers = {}) => fetch(path, { headers });
  try {
    const list = await get(listPath); assert.equal(list.status, 200); assert.equal(list.headers.get('cache-control'), 'private, no-store');
    const listBody = await list.json();
    assert.deepEqual(listBody.data, { activeTrial: null, trials: [] }); assert.equal('crmAccess' in listBody.meta, false, 'full access keeps the existing response envelope');
    const detail = await get(detailPath, { 'Sec-Fetch-Site': 'same-origin' }); assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.id, appointmentId);
    // A principal with outcome permission but not scheduling permission may reconcile; schedule is asked first.
    assert.deepEqual(permissionsAsked.slice(0, 2), ['crm.trial.schedule', 'crm.trial.manage']);
    for (const headers of [{ 'X-HON-Source': 'HUMAN_UI' }, { 'X-HON-School-Id': randomUUID() }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
      assert.equal((await get(listPath, headers)).status, 403, JSON.stringify(headers));
      assert.equal((await get(detailPath, headers)).status, 403, JSON.stringify(headers));
    }
    assert.equal((await get(`${listPath}?schoolId=${randomUUID()}`)).status, 400);
    assert.equal((await get(`${detailPath}?leadId=${leadId}`)).status, 400);
    assert.deepEqual({ lists, reads }, { lists: 1, reads: 1 });
    scopeOrg = randomUUID();
    assert.equal((await get(listPath)).status, 403, 'route organization outside the resolved scope');
    scopeOrg = scope.organizationId; granted.clear();
    assert.equal((await get(listPath)).status, 403, 'no trial permission');
    assert.equal((await get(detailPath)).status, 403, 'no trial permission');
    assert.deepEqual({ lists, reads }, { lists: 1, reads: 1 });
  } finally {
    await app.close();
  }
});
