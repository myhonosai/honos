const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { AutomationService } = require('../dist/automations/automation.service.js');
const { AutomationWorkerDatabase, AutomationEngineScheduler } = require('../dist/automations/automation-engine.js');
const { validateDeploymentConfiguration } = require('../dist/foundation/production-config.js');

// Mocked boundary tests for the 0423 engine API and worker. The engine itself (events, runs, guards, isolation) is proven
// against PostgreSQL by packages/database/scripts/test-automation-engine-integrity.mjs.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'eng-key', externalSubject: 'verified-human', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const wid = randomUUID(), rid = randomUUID(), pid = randomUUID(), at = '2026-11-15T09:00:00.000Z';
const definition = { schemaVersion: 1, trigger: { kind: 'LEAD_CREATED', config: {} }, entry: { reentry: 'ONCE_EVER', reentryDays: null, conditions: [] }, exitWhen: [],
  steps: [{ id: 'hello', type: 'SEND_SMS', content: { mode: 'FIXED', text: 'Hi {{first_name}}!' }, next: null }] };
const summary = { workflowId: wid, name: 'Welcome', status: 'ACTIVE', revision: 2, latestVersion: 1, activeVersion: 1, triggerKind: 'LEAD_CREATED', pausedReason: null, stepCount: 1, activatedAt: at, createdAt: at, updatedAt: at };
const detail = { workflow: summary, latest: { workflowId: wid, version: 1, name: 'Welcome', source: 'HUMAN_UI', restoredFromVersion: null, definition, recordedAt: at, author: 'Owner' },
  versions: [{ version: 1, name: 'Welcome', source: 'HUMAN_UI', restoredFromVersion: null, recordedAt: at }] };
const run = { runId: rid, workflowId: wid, workflowVersion: 1, personId: pid, contactFirstName: 'Pat', status: 'COMPLETED', endCode: null, depth: 0, parentRunId: null, startedAt: at, endedAt: at };
const step = { stepId: 'hello', type: 'SEND_SMS', status: 'DONE', outcome: 'QUEUED', branch: null, messageId: randomUUID(), deliveryStatus: 'PENDING', workItemId: null, startedRunId: null, dueAt: at, createdAt: at, finishedAt: at };
function fixture(options = {}) {
  const queries = [];
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/activate_automation_workflow|pause_automation_workflow/.test(sql)) return { rows: [{ data: { record: detail, replayed: false } }] };
        if (/read_automation_runs/.test(sql)) return { rows: [{ data: options.runs ?? { workflowId: wid, runs: [run], counts: { running: 0, completed: 1, exited: 0, failed: 0 }, checkedAt: at } }] };
        if (/read_automation_run\(/.test(sql)) return { rows: [{ data: options.run ?? { run, steps: [step], checkedAt: at } }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries };
}
const pgError = (message, code, detailText) => Object.assign(new Error(message), { code, detail: detailText });

test('turn on and pause send the closed body, key and request ids; bad input never reaches the database', async () => {
  const f = fixture(), svc = new AutomationService(f.db), c = context();
  const r = await svc.activate(c, wid, { expectedRevision: 1, version: 1 });
  assert.equal(r.record.workflow.status, 'ACTIVE');
  const call = f.queries.find(q => q.sql.includes('activate_automation_workflow'));
  assert.deepEqual(JSON.parse(call.args[1]), { expectedRevision: 1, version: 1 }); assert.deepEqual(call.args.slice(2), ['eng-key', c.requestId, c.correlationId, wid]); assert.equal(call.readOnly, false);
  await svc.pause(context(), wid, { expectedRevision: 2 });
  assert.ok(f.queries.some(q => q.sql.includes('pause_automation_workflow')));
  const before = f.queries.length;
  for (const bad of [{}, { expectedRevision: 1 }, { expectedRevision: 1, version: 0 }, { expectedRevision: 1, version: 501 }, { expectedRevision: 1, version: 1, extra: 1 }, null, 'x'])
    await assert.rejects(svc.activate(context(), wid, bad), status(400, 'AUTOMATION_INVALID'));
  for (const bad of [{}, { expectedRevision: 0 }, { expectedRevision: 1, version: 1 }]) await assert.rejects(svc.pause(context(), wid, bad), status(400, 'AUTOMATION_INVALID'));
  assert.equal(f.queries.length, before);
});

test('database refusals map to named answers; the unavailable part is passed on only in its closed shape', async () => {
  const cases = [
    [pgError('AUTOMATION_NOT_AVAILABLE_YET', '0A000', 'step REQUEST_APPROVAL'), 422, 'AUTOMATION_NOT_AVAILABLE_YET', 'step REQUEST_APPROVAL'],
    [pgError('AUTOMATION_NOT_AVAILABLE_YET', '0A000', 'merge field booking_link'), 422, 'AUTOMATION_NOT_AVAILABLE_YET', 'merge field booking_link'],
    [pgError('AUTOMATION_NOT_AVAILABLE_YET', '0A000', 'Hi <script>{{x}}</script> 555-0100'), 422, 'AUTOMATION_NOT_AVAILABLE_YET', undefined],
    [pgError('AUTOMATION_REFERENCE_INVALID', '23503'), 422, 'AUTOMATION_REFERENCE_INVALID'],
    [pgError('AUTOMATION_NOT_ACTIVE', '23514'), 409, 'AUTOMATION_NOT_ACTIVE'],
    [pgError('AUTOMATION_STALE', '40001'), 409, 'AUTOMATION_STALE'],
    [pgError('AUTOMATION_FORBIDDEN', '42501'), 403, 'AUTOMATION_FORBIDDEN'],
    [pgError('something else', 'XX000'), 503, 'AUTOMATION_UNAVAILABLE'],
  ];
  for (const [error, http, code, part] of cases) {
    const svc = new AutomationService(fixture({ error }).db);
    await assert.rejects(svc.activate(context(), wid, { expectedRevision: 1, version: 1 }), (e) => {
      assert.equal(e.getStatus(), http); assert.equal(e.getResponse().code, code); assert.equal(e.getResponse().part, part); return true; });
  }
  const svc = new AutomationService(fixture({ error: pgError('AUTOMATION_RUN_NOT_FOUND', 'P0002') }).db);
  await assert.rejects(svc.run(context({ idempotencyKey: '' }), rid), status(404, 'AUTOMATION_RUN_NOT_FOUND'));
});

test('run history reads are read-only and verified; another workflow or run, or message text, is refused', async () => {
  const f = fixture(), svc = new AutomationService(f.db);
  const list = await svc.runs(context({ idempotencyKey: '' }), wid.toUpperCase());
  assert.equal(list.runs[0].contactFirstName, 'Pat'); assert.equal(f.queries.find(q => q.sql.includes('read_automation_runs')).readOnly, true);
  const one = await svc.run(context({ idempotencyKey: '' }), rid);
  assert.equal(one.steps[0].outcome, 'QUEUED');
  const other = randomUUID();
  await assert.rejects(new AutomationService(fixture({ runs: { workflowId: other, runs: [], counts: { running: 0, completed: 0, exited: 0, failed: 0 }, checkedAt: at } }).db).runs(context({ idempotencyKey: '' }), wid));
  await assert.rejects(new AutomationService(fixture({ runs: { workflowId: wid, runs: [{ ...run, workflowId: other }], counts: { running: 0, completed: 1, exited: 0, failed: 0 }, checkedAt: at } }).db).runs(context({ idempotencyKey: '' }), wid));
  await assert.rejects(new AutomationService(fixture({ run: { run: { ...run, runId: other }, steps: [], checkedAt: at } }).db).run(context({ idempotencyKey: '' }), rid));
  await assert.rejects(new AutomationService(fixture({ run: { run, steps: [{ ...step, content: 'Hi Pat' }], checkedAt: at } }).db).run(context({ idempotencyKey: '' }), rid));
  await assert.rejects(new AutomationService(fixture({ run: { run: { ...run, status: 'RUNNING' }, steps: [], checkedAt: at } }).db).run(context({ idempotencyKey: '' }), rid));
});

function withEnv(patch, fn) {
  const keys = ['HON_AUTOMATION_WORKER_DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL', 'HON_AUTOMATION_ENGINE_INTERVAL_SECONDS'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, patch);
  return Promise.resolve().then(fn).finally(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
}
const fakePool = (role, answers) => { const calls = []; return { calls, async query(sql, args) { calls.push({ sql, args });
  if (sql.includes('pg_roles')) return { rows: role ? [role] : [] };
  const fn = /hon\.(\w+)\(/.exec(sql)[1]; return { rows: answers[fn] === undefined ? [] : [{ data: answers[fn] }] }; }, async end() {} }; };
const safeRole = { rolsuper: false, rolbypassrls: false, rolinherit: false };
const good = { consume_automation_events: { consumed: 2, runsStarted: 1, failed: 0 }, scan_automation_schedules: { scanned: 2, runsStarted: 4, failed: 1, paused: 1 },
  run_due_automation_steps: { ran: 3, failed: 0, exited: 1, paused: 0 } };

test('the engine worker refuses another login, an unsafe role and unverified counts; it calls only the three engine functions', async () => {
  const url = 'postgresql://hon_automation_worker:x@db.example.test:5432/postgres?sslmode=verify-full';
  for (const reused of ['HON_RUNTIME_DATABASE_URL', 'DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL']) await withEnv({ HON_AUTOMATION_WORKER_DATABASE_URL: url, [reused]: url }, async () => {
    await assert.rejects(new AutomationWorkerDatabase().runOnce(), /AUTOMATION_WORKER_ROLE_UNSAFE/); });
  await withEnv({}, async () => { const w = new AutomationWorkerDatabase(); assert.equal(w.isConfigured(), false); await assert.rejects(w.runOnce(), /AUTOMATION_WORKER_NOT_CONFIGURED/); });
  await withEnv({ HON_AUTOMATION_WORKER_DATABASE_URL: url }, async () => {
    for (const role of [null, { ...safeRole, rolsuper: true }, { ...safeRole, rolbypassrls: true }, { ...safeRole, rolinherit: true }]) {
      const w = new AutomationWorkerDatabase(); const pool = fakePool(role, good); w.pool = pool;
      await assert.rejects(w.runOnce(), /AUTOMATION_WORKER_ROLE_UNSAFE/); assert.equal(pool.calls.some(c => c.sql.includes('hon.')), false);
    }
    const w = new AutomationWorkerDatabase(), pool = fakePool(safeRole, good); w.pool = pool;
    assert.deepEqual(await w.runOnce(50), { consumed: 2, runsStarted: 1, eventsFailed: 0, scanned: 2, scheduledRunsStarted: 4, scansFailed: 1, ran: 3, failed: 0, exited: 1, paused: 1 });
    assert.deepEqual(pool.calls.filter(c => c.sql.includes('hon.')).map(c => [c.sql, c.args]),
      [['SELECT hon.consume_automation_events($1::integer) AS data', [50]], ['SELECT hon.scan_automation_schedules($1::integer) AS data', [50]],
        ['SELECT hon.run_due_automation_steps($1::integer) AS data', [50]]]);
    for (const bad of [{ ...good, consume_automation_events: { consumed: -1, runsStarted: 0, failed: 0 } }, { ...good, run_due_automation_steps: { ran: 1.5, failed: 0, exited: 0, paused: 0 } },
      { ...good, run_due_automation_steps: { ran: '1', failed: 0, exited: 0, paused: 0 } }, { ...good, consume_automation_events: undefined },
      { ...good, scan_automation_schedules: { scanned: 1, runsStarted: -2, failed: 0, paused: 0 } }, { ...good, scan_automation_schedules: undefined }]) {
      const x = new AutomationWorkerDatabase(); x.pool = fakePool(safeRole, bad); await assert.rejects(x.runOnce(), /AUTOMATION_ENGINE_UNVERIFIED/);
    }
  });
});

test('the in-process loop is off unless configured with a 15-3600 second interval and never overlaps a tick', async () => {
  const worker = { configured: true, isConfigured() { return this.configured; }, calls: 0, release: undefined,
    runOnce() { this.calls += 1; return new Promise(resolve => { this.release = () => resolve({ consumed: 0, runsStarted: 0, ran: 0, failed: 0, exited: 0, paused: 0 }); }); } };
  for (const raw of [undefined, '14', '3601', 'abc', '20.5']) await withEnv(raw ? { HON_AUTOMATION_ENGINE_INTERVAL_SECONDS: raw } : {}, () => {
    const s = new AutomationEngineScheduler(worker); s.onModuleInit(); assert.equal(s.timer, undefined); s.onModuleDestroy(); });
  await withEnv({ HON_AUTOMATION_ENGINE_INTERVAL_SECONDS: '60' }, () => {
    worker.configured = false; const off = new AutomationEngineScheduler(worker); off.onModuleInit(); assert.equal(off.timer, undefined);
    worker.configured = true; const on = new AutomationEngineScheduler(worker); on.onModuleInit(); assert.ok(on.timer); on.onModuleDestroy(); assert.equal(on.timer, undefined); });
  const s = new AutomationEngineScheduler(worker);
  const first = s.tick(); assert.equal(await s.tick(), undefined); assert.equal(worker.calls, 1);
  worker.release(); assert.equal((await first).ran, 0);
  const failing = new AutomationEngineScheduler({ runOnce: async () => { throw new Error('AUTOMATION_WORKER_ROLE_UNSAFE'); } });
  assert.equal(await failing.tick(), undefined); assert.equal(failing.running, false);
});

test('deployment configuration refuses an engine login reused from the runtime, migration or communication worker role', () => {
  const base = { NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'production', HON_AUTH_MODE: 'OIDC',
    HON_RUNTIME_DATABASE_URL: 'postgresql://runtime:x@db.example.test:5432/postgres?sslmode=verify-full',
    HON_COMMUNICATION_WORKER_DATABASE_URL: 'postgresql://comms:x@db.example.test:5432/postgres?sslmode=verify-full' };
  for (const user of ['runtime', 'comms']) {
    const r = validateDeploymentConfiguration({ ...base, HON_AUTOMATION_WORKER_DATABASE_URL: `postgresql://${user}:y@db.example.test:5432/postgres?sslmode=verify-full` });
    assert.ok(r.failures.includes('AUTOMATION_WORKER_ROLE_REUSED'), user);
  }
  const own = validateDeploymentConfiguration({ ...base, HON_AUTOMATION_WORKER_DATABASE_URL: 'postgresql://hon_automation_worker:y@db.example.test:5432/postgres?sslmode=verify-full' });
  assert.equal(own.failures.includes('AUTOMATION_WORKER_ROLE_REUSED'), false);
  const plain = validateDeploymentConfiguration({ ...base, HON_AUTOMATION_WORKER_DATABASE_URL: 'postgresql://hon_automation_worker:y@db.example.test:5432/postgres' });
  assert.ok(plain.failures.includes('AUTOMATION_WORKER_DATABASE_TLS_INVALID'));
});
