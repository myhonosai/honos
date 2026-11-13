const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SchoolReportsController } = require('../dist/reports/school-reports.controller.js');
const { SchoolReportsService } = require('../dist/reports/school-reports.service.js');

// R1 (0331) and R2 (0332): the controller's closed query and the service's error mapping, without a database.
const ORG = '11111111-1111-4111-8111-111111111111';
const SCHOOL = '22222222-2222-4222-8222-222222222222';
const request = { honIdentity: { externalSubject: 'staff-subject' } };
const scopeDatabase = (scope = { organizationId: ORG, schoolId: SCHOOL, principalId: '33333333-3333-4333-8333-333333333333' }) => ({
  calls: [],
  async resolveAuthorizedScope(subject, schoolId, permission) { this.calls.push([subject, schoolId, permission]); return scope; },
});
const recordingReports = () => ({
  inputs: [],
  async read(context, input) { this.inputs.push(['read', context, input]); return { ok: true }; },
  async readLocations(context, input) { this.inputs.push(['locations', context, input]); return { ok: true }; },
});
const status = async (promise) => { try { await promise; return 200; } catch (error) { return error.getStatus(); } };
const code = async (promise) => { try { await promise; return null; } catch (error) { return error.getResponse().code; } };

test('school reports controller: only ?months passes, as a string, to the service; reporting.view is resolved from the session', async () => {
  for (const method of ['read', 'locations']) {
    const database = scopeDatabase(), reports = recordingReports();
    const controller = new SchoolReportsController(database, reports);
    await controller[method](ORG, SCHOOL, undefined, {}, request);
    await controller[method](ORG, SCHOOL, undefined, { months: '12' }, request);
    assert.deepEqual(reports.inputs.map((entry) => entry[2]), [{}, { months: '12' }]);
    assert.deepEqual(database.calls[0], ['staff-subject', SCHOOL, 'reporting.view']);
    const context = reports.inputs[0][1];
    assert.equal(context.source, 'HUMAN_UI'); assert.equal(context.principalType, 'HUMAN_USER'); assert.equal(context.externalSubject, 'staff-subject');

    for (const query of [{ months: '6', school: SCHOOL }, { from: '2026-01' }, { months: ['3', '4'] }]) {
      assert.equal(await code(controller[method](ORG, SCHOOL, undefined, query, request)), 'VALIDATION_FAILED', JSON.stringify(query));
    }
    assert.equal(await status(controller[method](ORG, SCHOOL, 'key-1', {}, request)), 409);
    assert.equal(await code(controller[method](ORG, SCHOOL, 'key-1', {}, request)), 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
    assert.equal(await status(controller[method](ORG, SCHOOL, undefined, {}, {})), 403);
    // A route organization or school that is not the resolved session scope is refused before any read.
    const other = new SchoolReportsController(scopeDatabase({ organizationId: '44444444-4444-4444-8444-444444444444', schoolId: SCHOOL, principalId: 'p' }), recordingReports());
    assert.equal(await code(other[method](ORG, SCHOOL, undefined, {}, request)), 'SCHOOL_REPORTS_FORBIDDEN');
    const none = new SchoolReportsController({ async resolveAuthorizedScope() { return undefined; } }, recordingReports());
    assert.equal(await code(none[method](ORG, SCHOOL, undefined, {}, request)), 'SCHOOL_REPORTS_FORBIDDEN');
  }
});

const context = { organizationId: ORG, schoolId: SCHOOL, principalId: 'p', principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'staff-subject',
  requestId: 'r', correlationId: 'r', idempotencyKey: '' };
const failingDatabase = (error) => ({
  async withTenantReadOnlyTransaction(_context, work) {
    return work({ async query(text) { if (/read_school_reports/.test(text)) throw error; return { rows: [] }; } });
  },
});
const pgError = (sqlState, message) => Object.assign(new Error(message), { code: sqlState });

test('school reports service: database errors map to fixed codes and statuses, never a database message', async () => {
  const cases = [
    [pgError('22023', 'SCHOOL_TIMEZONE_INVALID'), 409, 'SCHOOL_TIMEZONE_INVALID'],
    [pgError('42501', 'SCHOOL_REPORTS_FORBIDDEN'), 403, 'SCHOOL_REPORTS_FORBIDDEN'],
    [pgError('22023', 'VALIDATION_FAILED'), 400, 'VALIDATION_FAILED'],
    [pgError('22P02', 'invalid input syntax'), 400, 'VALIDATION_FAILED'],
    [pgError('57014', 'canceling statement due to statement timeout'), 503, 'SCHOOL_REPORTS_UNAVAILABLE'],
    [new Error('connection lost'), 503, 'SCHOOL_REPORTS_UNAVAILABLE'],
  ];
  for (const method of ['read', 'readLocations']) {
    for (const [error, expectedStatus, expectedCode] of cases) {
      const service = new SchoolReportsService(failingDatabase(error));
      try { await service[method](context, { months: '3' }); assert.fail('expected a refusal'); } catch (refusal) {
        assert.equal(refusal.getStatus(), expectedStatus, `${method} ${error.message}`);
        assert.equal(refusal.getResponse().code, expectedCode);
        assert.doesNotMatch(JSON.stringify(refusal.getResponse()), /canceling|connection|syntax/);
      }
    }
  }
  const tooMany = new SchoolReportsService(failingDatabase(pgError('22023', 'SCHOOL_REPORTS_TOO_MANY_LOCATIONS')));
  await assert.rejects(tooMany.readLocations(context, {}), (error) => error.getStatus() === 422 && error.getResponse().code === 'SCHOOL_REPORTS_TOO_MANY_LOCATIONS');
});

test('school reports service: months outside 3..12 and unknown keys are refused before the database', async () => {
  let touched = false;
  const service = new SchoolReportsService({ async withTenantReadOnlyTransaction() { touched = true; } });
  for (const value of [{ months: '2' }, { months: '13' }, { months: '6.5' }, { months: '06' }, { other: '1' }]) {
    await assert.rejects(service.read(context, value), (error) => error.getStatus() === 400, JSON.stringify(value));
  }
  const nonHuman = { ...context, source: 'AI_AGENT' };
  await assert.rejects(service.read(nonHuman, {}), (error) => error.getStatus() === 403);
  assert.equal(touched, false);
});
