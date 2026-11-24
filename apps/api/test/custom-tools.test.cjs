const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { CustomToolService } = require('../dist/custom-tools/custom-tool.service.js');
const { customToolDefinitionProblems } = require('@hon/contracts');

// Mocked boundary tests for the 0415 custom tools API. Authority, validation, versions, records and isolation are proven
// against PostgreSQL by test-custom-tools-integrity.mjs.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'ct-key', externalSubject: 'verified-human', ...patch });
const read = (patch = {}) => context({ idempotencyKey: '', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const L = en => ({ en });
const def = { schemaVersion: 1, name: L('Leadership Points'), icon: 'star',
  entities: [{ key: 'award', label: L('Award'), fields: [{ key: 'student', label: L('Student'), type: 'STUDENT_REF', required: true }, { key: 'points', label: L('Points'), type: 'INTEGER', min: 1, max: 50, required: true }] }],
  views: [{ key: 'awards', label: L('Awards'), type: 'TABLE', entity: 'award', columns: ['student', 'points'] },
    { key: 'board', label: L('Board'), type: 'DASHBOARD', entity: 'award', cards: [{ key: 'top', label: L('Top'), kind: 'LEADERBOARD', field: 'points', groupBy: 'student' }] }],
  navigation: ['awards', 'board'], access: [] };
const toolId = randomUUID(), at = '2026-11-15T09:00:00.000Z';
const summary = (patch = {}) => ({ toolId, toolKey: 'leadership_points', status: 'ACTIVE', revision: 1, latestVersion: 1, publishedVersion: null, draftVersion: 1, name: def.name, icon: 'star',
  capabilities: ['VIEW', 'CREATE', 'EDIT', 'ARCHIVE'], navigation: [], updatedAt: at, ...patch });
const design = (patch = {}) => ({ tool: summary(), version: { versionNo: 1, status: 'DRAFT', origin: 'NEW', restoredFrom: null, createdAt: at, updatedAt: at, publishedAt: null, definition: def },
  versions: [{ versionNo: 1, status: 'DRAFT', origin: 'NEW', restoredFrom: null, createdAt: at, updatedAt: at, publishedAt: null }], roles: [], ...patch });
function fixture(options = {}) {
  const queries = [];
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/read_custom_tools\(/.test(sql)) return { rows: [{ data: options.list ?? { canDesign: true, tools: [summary()] } }] };
        if (/read_custom_tool\(/.test(sql)) return { rows: [{ data: options.design ?? design() }] };
        if (/save_custom_tool_draft|change_custom_tool/.test(sql)) return { rows: [{ data: options.save ?? { record: design(), replayed: false } }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries };
}
const draft = { toolId: null, toolKey: 'leadership_points', expectedRevision: 0, definition: def };

test('the shared definition rules accept a Leadership Points tool and name each problem in a broken one', () => {
  assert.deepEqual(customToolDefinitionProblems(def), []);
  assert.deepEqual(customToolDefinitionProblems({ ...def, code: 'x' }), ['definition']);
  assert.deepEqual(customToolDefinitionProblems({ ...def, icon: 'skull', navigation: ['nope'] }), ['icon', 'navigation']);
  const badField = structuredClone(def); badField.entities[0].fields[1].type = 'SQL';
  assert(customToolDefinitionProblems(badField).includes('entities[0].fields[1]'));
  const badCard = structuredClone(def); badCard.views[1].cards[0].groupBy = 'points';
  assert.equal(customToolDefinitionProblems(badCard)[0], 'views[1].cards');
  assert.deepEqual(customToolDefinitionProblems({ ...def, access: [{ roleId: randomUUID(), capabilities: ['EDIT'] }] }), ['access']);
});

test('reads are read-only calls; a draft save sends the exact body, key and request ids', async () => {
  const f = fixture(), svc = new CustomToolService(f.db);
  assert.equal((await svc.list(read())).tools.length, 1);
  assert.equal(f.queries.find(q => q.sql.includes('read_custom_tools(')).readOnly, true);
  await svc.tool(read(), toolId, 1);
  assert.deepEqual(f.queries.find(q => q.sql.includes('read_custom_tool(')).args.slice(1), [toolId, 1]);
  const c = context(); const out = await svc.saveDraft(c, draft);
  assert.equal(out.replayed, false);
  const call = f.queries.find(q => q.sql.includes('save_custom_tool_draft'));
  assert.deepEqual(JSON.parse(call.args[1]), draft); assert.deepEqual(call.args.slice(2), ['ct-key', c.requestId, c.correlationId]); assert.equal(call.readOnly, false);
});

test('bad bodies and non-human or keyless contexts never reach the database', async () => {
  for (const bad of [null, [], { ...draft, definition: { ...def, sql: 'x' } }, { ...draft, toolKey: 'Bad Key' }, { ...draft, expectedRevision: 1 }, { ...draft, extra: 1 }]) {
    const f = fixture();
    await assert.rejects(new CustomToolService(f.db).saveDraft(context(), bad), status(400)); assert.equal(f.queries.length, 0);
  }
  for (const bad of [{ operation: 'DROP', expectedRevision: 1, version: 1 }, { operation: 'PUBLISH', expectedRevision: 1, version: null }, { operation: 'ARCHIVE', expectedRevision: 1, version: 2 }]) {
    const f = fixture(); await assert.rejects(new CustomToolService(f.db).change(context(), toolId, bad), status(400, 'CUSTOM_TOOL_INVALID')); assert.equal(f.queries.length, 0);
  }
  for (const bad of [{ operation: 'CREATE', recordId: randomUUID(), entity: 'award', expectedVersion: 0, preview: false, data: {} }, { operation: 'UPDATE', recordId: null, entity: 'award', expectedVersion: 1, preview: false, data: {} },
    { operation: 'ARCHIVE', recordId: randomUUID(), entity: 'award', expectedVersion: 1, preview: false, data: {} }, { operation: 'CREATE', recordId: null, entity: 'Award', expectedVersion: 0, preview: false, data: {} }]) {
    const f = fixture(); await assert.rejects(new CustomToolService(f.db).writeRecord(context(), toolId, bad), status(400)); assert.equal(f.queries.length, 0);
  }
  const f = fixture(), svc = new CustomToolService(f.db);
  await assert.rejects(svc.list(read({ principalType: 'AI_AGENT' })), status(403));
  await assert.rejects(svc.list(context()), status(403));
  await assert.rejects(svc.saveDraft(context({ idempotencyKey: '' }), draft), status(403));
  assert.equal(f.queries.length, 0);
});

test('database refusals map to stable codes, a definition problem keeps its path, and unknown failures claim nothing', async () => {
  const cases = [[{ code: '42501', message: 'CUSTOM_TOOL_FORBIDDEN' }, 403, 'CUSTOM_TOOL_FORBIDDEN'], [{ code: '22023', message: 'CUSTOM_TOOL_DEFINITION_INVALID', hint: 'access' }, 400, 'CUSTOM_TOOL_DEFINITION_INVALID'],
    [{ code: '23505', message: 'IDEMPOTENCY_KEY_REUSED' }, 409, 'IDEMPOTENCY_KEY_REUSED'], [{ code: '23505', message: 'CUSTOM_TOOL_KEY_TAKEN' }, 409, 'CUSTOM_TOOL_KEY_TAKEN'],
    [{ code: '40001', message: 'CUSTOM_TOOL_VERSION_CONFLICT' }, 409, 'CUSTOM_TOOL_VERSION_CONFLICT'], [{ code: 'P0002', message: 'CUSTOM_TOOL_NOT_FOUND' }, 404, 'CUSTOM_TOOL_NOT_FOUND'],
    [{ code: '54000', message: 'CUSTOM_TOOL_LIMIT' }, 429, 'CUSTOM_TOOL_LIMIT'], [{ code: '23514', message: 'CUSTOM_TOOL_DRAFT_OPEN' }, 409, 'CUSTOM_TOOL_DRAFT_OPEN'],
    [{ code: 'XX000', message: 'boom' }, 503, 'CUSTOM_TOOL_UNAVAILABLE']];
  for (const [error, http, code] of cases) await assert.rejects(new CustomToolService(fixture({ error }).db).saveDraft(context(), draft), status(http, code));
  await assert.rejects(new CustomToolService(fixture({ error: { code: '22023', message: 'CUSTOM_TOOL_DEFINITION_INVALID', hint: 'access' } }).db).saveDraft(context(), draft),
    (e) => { assert.equal(e.getResponse().path, 'access'); return true; });
});

test('unverifiable reads and receipts, or a receipt for another tool, are refused', async () => {
  await assert.rejects(new CustomToolService(fixture({ list: { canDesign: true, tools: [summary({ toolKey: 'Bad' })] } }).db).list(read()), status(503));
  await assert.rejects(new CustomToolService(fixture({ design: design({ version: { ...design().version, definition: { ...def, extra: 1 } } }) }).db).tool(read(), toolId, null), status(503));
  await assert.rejects(new CustomToolService(fixture({ save: { record: design(), replayed: 'no' } }).db).saveDraft(context(), draft), status(503));
  await assert.rejects(new CustomToolService(fixture().db).change(context(), randomUUID(), { operation: 'PUBLISH', expectedRevision: 1, version: 1 }), status(503));
});
