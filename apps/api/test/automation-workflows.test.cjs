const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { AutomationService } = require('../dist/automations/automation.service.js');

// Mocked boundary tests for the 0367 automation API. Authority, validation parity with SQL, isolation and limits are
// proven against PostgreSQL by packages/database/scripts/test-automation-workflows-integrity.mjs.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'aut-key', externalSubject: 'verified-human', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const wid = randomUUID(), pid = randomUUID(), at = '2026-11-15T09:00:00.000Z';
const definition = { schemaVersion: 1, trigger: { kind: 'LEAD_CREATED', config: {} }, entry: { reentry: 'ONCE_EVER', reentryDays: null, conditions: [] }, exitWhen: [],
  steps: [{ id: 'hello', type: 'SEND_SMS', content: { mode: 'FIXED', text: 'Hi {{first_name}}!' }, next: null }] };
const summary = { workflowId: wid, name: 'Welcome', status: 'DRAFT', revision: 1, latestVersion: 1, activeVersion: null, triggerKind: 'LEAD_CREATED', pausedReason: null, stepCount: 1, activatedAt: null, createdAt: at, updatedAt: at };
const detail = (patch = {}) => ({ workflow: { ...summary, ...patch }, latest: { workflowId: wid, version: 1, name: 'Welcome', source: 'HUMAN_UI', restoredFromVersion: null, definition, recordedAt: at, author: 'Owner' },
  versions: [{ version: 1, name: 'Welcome', source: 'HUMAN_UI', restoredFromVersion: null, recordedAt: at }] });
function fixture(options = {}) {
  const queries = [];
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/read_automation_workflows/.test(sql)) return { rows: [{ data: { workflows: [summary], limits: { workflows: 100, versions: 500, steps: 50 }, checkedAt: at } }] };
        if (/read_automation_workflow\(/.test(sql)) return { rows: [{ data: options.detail ?? detail() }] };
        if (/create_automation_workflow|save_automation|restore_automation|archive_automation/.test(sql)) return { rows: [{ data: options.save ?? { record: detail(), replayed: false } }] };
        if (/add_contact_tag|remove_contact_tag/.test(sql)) return { rows: [{ data: { record: { personId: options.person ?? pid, tags: [{ tag: 'VIP', tagKey: 'vip', addedSource: 'HUMAN_UI', addedAt: at }], changed: true }, replayed: false } }] };
        if (/lookup_contact_tags/.test(sql)) return { rows: [{ data: { people: options.people ?? [{ personId: pid, tags: ['VIP'] }] } }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries };
}

test('reads are read-only single calls; create sends the validated body, key and request ids', async () => {
  const f = fixture(), svc = new AutomationService(f.db);
  assert.equal((await svc.listWorkflows(context({ idempotencyKey: '' }))).workflows.length, 1);
  assert.equal(f.queries.find(q => q.sql.includes('read_automation_workflows')).readOnly, true);
  const c = context(); const r = await svc.create(c, { name: 'Welcome', definition });
  assert.equal(r.replayed, false); assert.equal(r.record.workflow.workflowId, wid);
  const call = f.queries.find(q => q.sql.includes('create_automation_workflow'));
  assert.deepEqual(JSON.parse(call.args[1]), { name: 'Welcome', definition }); assert.deepEqual(call.args.slice(2), ['aut-key', c.requestId, c.correlationId]);
  assert.equal(call.readOnly, false);
});

test('invalid definitions, names and tags never reach the database', async () => {
  const f = fixture(), svc = new AutomationService(f.db);
  const loop = { ...definition, steps: [{ id: 'a', type: 'WAIT', minutes: 1, localTime: null, next: 'b' }, { id: 'b', type: 'WAIT', minutes: 1, localTime: null, next: 'a' }] };
  await assert.rejects(svc.create(context(), { name: 'Loop', definition: loop }), status(400, 'AUTOMATION_INVALID'));
  await assert.rejects(svc.create(context(), { name: ' padded', definition }), status(400, 'AUTOMATION_INVALID'));
  await assert.rejects(svc.create(context(), { name: 'Extra', definition, active: true }), status(400, 'AUTOMATION_INVALID'));
  await assert.rejects(svc.save(context(), wid, { expectedRevision: 0, name: 'x', definition }), status(400, 'AUTOMATION_INVALID'));
  await assert.rejects(svc.addTag(context(), pid, { tag: 'vip!' }), status(400, 'AUTOMATION_INVALID'));
  await assert.rejects(svc.lookupTags(context({ idempotencyKey: '' }), { personIds: [] }), status(400, 'AUTOMATION_INVALID'));
  assert.equal(f.queries.length, 0);
});

test('a receipt for another workflow, person or unasked person is refused', async () => {
  const other = randomUUID();
  await assert.rejects(new AutomationService(fixture({ detail: detail({ workflowId: other }) }).db).getWorkflow(context({ idempotencyKey: '' }), wid));
  await assert.rejects(new AutomationService(fixture({ person: other }).db).addTag(context(), pid, { tag: 'VIP' }));
  await assert.rejects(new AutomationService(fixture({ people: [{ personId: other, tags: [] }] }).db).lookupTags(context({ idempotencyKey: '' }), { personIds: [pid] }));
});

test('database errors translate to closed codes; unknown failures are 503 and claim nothing', async () => {
  const cases = [['AUTOMATION_FORBIDDEN', '42501', 403], ['AUTOMATION_STALE', '40001', 409], ['AUTOMATION_NOT_FOUND', 'P0002', 404], ['IDEMPOTENCY_KEY_REUSED', '23505', 409],
    ['CONTACT_TAG_LIMIT_REACHED', '54000', 422], ['AUTOMATION_ARCHIVED', '23514', 409], ['AUTOMATION_INVALID', '22023', 400]];
  for (const [message, code, http] of cases) {
    const svc = new AutomationService(fixture({ error: Object.assign(new Error(message), { code }) }).db);
    await assert.rejects(svc.save(context(), wid, { expectedRevision: 1, name: 'Welcome', definition }), status(http, message));
  }
  await assert.rejects(new AutomationService(fixture({ error: new Error('boom') }).db).listWorkflows(context({ idempotencyKey: '' })), status(503, 'AUTOMATION_UNAVAILABLE'));
});

test('only a direct human UI context with the right key shape is accepted', async () => {
  const svc = new AutomationService(fixture().db);
  await assert.rejects(svc.listWorkflows(context()), status(403));
  await assert.rejects(svc.create(context({ idempotencyKey: '' }), { name: 'Welcome', definition }), status(403));
  await assert.rejects(svc.create(context({ principalType: 'AI_EMPLOYEE' }), { name: 'Welcome', definition }), status(403));
  await assert.rejects(svc.schoolTags(context({ idempotencyKey: '', source: 'AUTOMATION' })), status(403));
});
