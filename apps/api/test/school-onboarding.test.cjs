const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SchoolOnboardingService } = require('../dist/onboarding/school-onboarding.service.js');
const { verifySchoolOnboarding, validateOnboardingSaveInput } = require('@hon/contracts');

// Mocked boundary tests for the 0323 onboarding API. Authority, recomputed progress, idempotency and the D3 pre-access rule
// are proven against PostgreSQL by test-school-onboarding-integrity.mjs.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'onb-key', externalSubject: 'verified-human', ...patch });
const readContext = (patch = {}) => context({ idempotencyKey: '', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const answers = { situation: 'NEW_SCHOOL', disciplines: ['KARATE'], customDiscipline: null, goals: ['MORE_STUDENTS'], path: 'NEW', previousSoftware: null, previousSoftwareOther: null, importWishes: [], skippedSteps: [] };
const profile = (patch = {}) => ({ ...answers, version: 1, updatedAt: '2026-11-13T07:00:00.000Z', ...patch });
const step = (key, status = 'NOT_STARTED', patch = {}) => ({ key, status, count: 0, firstAt: null, optional: false, skipped: false, ...patch });
const onboarding = (patch = {}) => ({ schoolName: 'Synthetic Dojo', timezone: 'America/Chicago', profile: null,
  access: { state: 'NOT_STARTED', trialStatus: null, trialEndsAt: null },
  steps: [step('SCHOOL_DETAILS', 'COMPLETE', { count: 1, firstAt: '2026-11-13T06:00:00.000Z' }), step('WELCOME'), step('INTERFACE'), step('PROGRAM', 'UNAVAILABLE')],
  checkedAt: '2026-11-13T07:00:00.000Z', ...patch });

function fixture(options = {}) {
  const queries = [];
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/hon\.read_school_onboarding\(\$1\)/.test(sql)) return { rows: [{ data: options.read ?? onboarding() }] };
        if (/hon\.save_school_onboarding\(/.test(sql)) return { rows: [{ data: options.save ?? { record: profile(), replayed: false } }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries };
}

test('read runs one read-only protected call and returns the verified onboarding', async () => {
  const f = fixture(), result = await new SchoolOnboardingService(f.db).read(readContext());
  assert.equal(result.access.state, 'NOT_STARTED');
  const call = f.queries.find(q => q.sql.includes('read_school_onboarding'));
  assert.equal(call.readOnly, true); assert.deepEqual(call.args, ['verified-human']);
});

test('save validates the closed body, sends the exact key and request ids, and verifies the receipt', async () => {
  const f = fixture(), c = context(), result = await new SchoolOnboardingService(f.db).save(c, { expectedVersion: 0, ...answers });
  assert.equal(result.profile.version, 1); assert.equal(result.replayed, false);
  const call = f.queries.find(q => q.sql.includes('save_school_onboarding'));
  assert.equal(call.readOnly, false); assert.deepEqual(call.args.slice(2), ['onb-key', c.requestId, c.correlationId]);
  assert.deepEqual(JSON.parse(call.args[1]), { expectedVersion: 0, ...answers });
});

test('save refuses bad bodies before any database call', async () => {
  for (const bad of [null, [], { ...answers }, { expectedVersion: -1, ...answers }, { expectedVersion: 0, ...answers, extra: 1 }, { expectedVersion: 0, ...answers, goals: ['BOSS'] },
    { expectedVersion: 0, ...answers, customDiscipline: 'Yudo' }, { expectedVersion: 0, ...answers, disciplines: ['KARATE', 'KARATE'] }, { expectedVersion: 1.5, ...answers }]) {
    const f = fixture();
    await assert.rejects(new SchoolOnboardingService(f.db).save(context(), bad), status(400, 'ONBOARDING_INVALID'));
    assert.equal(f.queries.length, 0);
  }
});

test('non-human, delegated-style or keyless contexts are refused', async () => {
  const f = fixture(), svc = new SchoolOnboardingService(f.db);
  await assert.rejects(svc.read(readContext({ principalType: 'AI_AGENT' })), status(403));
  await assert.rejects(svc.read(readContext({ source: 'AI_ACTION' })), status(403));
  await assert.rejects(svc.read(context()), status(403));
  await assert.rejects(svc.save(context({ idempotencyKey: '' }), { expectedVersion: 0, ...answers }), status(403));
  assert.equal(f.queries.length, 0);
});

test('database refusals map to stable codes and unknown failures claim nothing', async () => {
  const cases = [[{ code: '42501', message: 'ONBOARDING_FORBIDDEN' }, 403, 'ONBOARDING_FORBIDDEN'], [{ code: '40001', message: 'VERSION_CONFLICT' }, 409, 'VERSION_CONFLICT'],
    [{ code: '23505', message: 'IDEMPOTENCY_KEY_REUSED' }, 409, 'IDEMPOTENCY_KEY_REUSED'], [{ code: '55P03', message: 'ONBOARDING_BUSY' }, 409, 'ONBOARDING_BUSY'],
    [{ code: '22023', message: 'ONBOARDING_INVALID' }, 400, 'ONBOARDING_INVALID'], [{ code: 'XX000', message: 'boom' }, 503, 'ONBOARDING_UNAVAILABLE']];
  for (const [error, http, code] of cases) await assert.rejects(new SchoolOnboardingService(fixture({ error }).db).save(context(), { expectedVersion: 0, ...answers }), status(http, code));
});

test('unverifiable reads and receipts are refused', async () => {
  const bad = [onboarding({ steps: [step('WELCOME'), step('SCHOOL_DETAILS', 'COMPLETE', { count: 1, firstAt: '2026-11-13T06:00:00.000Z' })] }),
    onboarding({ steps: [step('SCHOOL_DETAILS', 'COMPLETE'), step('WELCOME')] }),
    onboarding({ steps: [step('SCHOOL_DETAILS', 'COMPLETE', { count: 1, firstAt: '2026-11-13T06:00:00.000Z' }), step('WELCOME'), step('PROGRAM', 'COMPLETE', { count: 1, firstAt: '2026-11-13T06:00:00.000Z' })] }),
    onboarding({ access: { state: 'ACTIVE', trialStatus: 'TRIAL_ACTIVE', trialEndsAt: null } }), onboarding({ secret: 1 })];
  for (const read of bad) await assert.rejects(new SchoolOnboardingService(fixture({ read }).db).read(readContext()), status(503));
  await assert.rejects(new SchoolOnboardingService(fixture({ save: { record: profile({ version: 0 }), replayed: false } }).db).save(context(), { expectedVersion: 0, ...answers }), status(503));
  await assert.rejects(new SchoolOnboardingService(fixture({ save: { record: profile(), replayed: 'no' } }).db).save(context(), { expectedVersion: 0, ...answers }), status(503));
});

test('contract verifiers accept a full active read and the documented save shape', () => {
  const active = verifySchoolOnboarding(onboarding({ profile: profile(), access: { state: 'ACTIVE', trialStatus: 'TRIAL_ACTIVE', trialEndsAt: '2026-11-27T07:00:00.000Z' },
    steps: [step('SCHOOL_DETAILS', 'COMPLETE', { count: 1, firstAt: '2026-11-13T06:00:00.000Z' }), step('WELCOME', 'COMPLETE', { count: 1, firstAt: '2026-11-13T06:00:00.000Z' }), step('PROGRAM', 'NEEDS_REVIEW'), step('STAFF', 'NOT_STARTED', { optional: true, skipped: true })] }));
  assert.equal(active.steps.length, 4);
  assert.deepEqual(validateOnboardingSaveInput({ expectedVersion: 2, ...answers, disciplines: ['OTHER'], customDiscipline: 'Yudo' }).customDiscipline, 'Yudo');
});
