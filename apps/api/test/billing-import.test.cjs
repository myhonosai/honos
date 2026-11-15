const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { BillingImportService, parseBillingCsv } = require('../dist/migration/billing-import.service.js');
const { BILLING_IMPORT_FIELDS, BILLING_IMPORT_REQUIRED } = require('@hon/contracts');

// Mocked boundary tests for the 0334 membership and opening-balance import API. The database behaviour itself (authority,
// revalidation, matching, idempotency, exact selection, created records, no charge or message) is proven against PostgreSQL by
// test-billing-import-integrity.mjs.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const batchId = randomUUID();
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'import-key',
  externalSubject: 'verified-human', ...patch });
const readContext = (patch = {}) => context({ idempotencyKey: '', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const batch = (patch = {}) => ({ id: batchId, kind: 'MEMBERSHIPS', version: 1, status: 'STAGED', rowCount: 2, validCount: 2, importCount: 0, skipCount: 0, undecidedCount: 2, importedCount: 0, balanceCount: 0,
  checksum: 'a'.repeat(64), schoolToday: '2026-11-09', schoolTimezone: 'America/Chicago', createdAt: '2026-11-09T02:00:00.000Z', finalizedAt: null, ...patch });
const MAPPING = { First: 'studentGivenName', Last: 'studentFamilyName', Plan: 'planName', Price: 'amount', Every: 'frequency', Start: 'startedOn', Next: 'nextChargeOn' };
const HEAD = 'First,Last,Plan,Price,Every,Start,Next';
const CSV = HEAD + '\nAva,Stone,Kids,149,monthly,2025-01-02,2026-12-01\nSam,Ortiz,Adult,99,weekly,2025-01-03,2026-12-01\n';
const UP = (patch = {}) => ({ csv: CSV, mapping: MAPPING, ...patch });

function fixture(options = {}) {
  const queries = [];
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        assert.doesNotMatch(sql, /(INSERT|UPDATE|DELETE)\s|hon\.(?:memberships|membership_payment_schedules|invoices|billing_accounts|billing_import_\w+)\b/);
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/hon\.stage_billing_import\(/.test(sql)) return { rows: [{ data: options.stage ?? { record: batch(), replayed: false } }] };
        if (/hon\.decide_billing_import\(/.test(sql)) return { rows: [{ data: options.decide ?? { record: batch({ version: 2, importCount: 2, undecidedCount: 0 }), replayed: false } }] };
        if (/hon\.finalize_billing_import\(/.test(sql)) return { rows: [{ data: options.finalize ?? { record: batch({ version: 3, status: 'FINALIZED', importCount: 2, undecidedCount: 0, importedCount: 2, finalizedAt: '2026-11-09T02:05:00.000Z' }), replayed: false } }] };
        if (/hon\.read_billing_imports\(\$1\)/.test(sql)) return { rows: [{ data: options.list ?? { batches: [], fields: BILLING_IMPORT_FIELDS, required: BILLING_IMPORT_REQUIRED, maxBytes: 262144, maxRows: 1000, maxColumns: 24 } }] };
        if (/hon\.read_billing_import\(\$1,\$2::uuid\)/.test(sql)) return { rows: [{ data: options.detail }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries, calls: (name) => queries.filter((q) => q.sql.includes(name)) };
}

test('stage parses the CSV and sends one protected write with the parsed rows, exact text and checked mapping', async () => {
  const f = fixture(), svc = new BillingImportService(f.db), c = context();
  const result = await svc.stage(c, UP());
  assert.equal(result.batch.id, batchId);
  const [call] = f.calls('stage_billing_import');
  assert.equal(call.readOnly, false);
  assert.deepEqual(call.args, [c.externalSubject, JSON.stringify({ csv: CSV, headers: HEAD.split(','), mapping: MAPPING,
    rows: [['Ava', 'Stone', 'Kids', '149', 'monthly', '2025-01-02', '2026-12-01'], ['Sam', 'Ortiz', 'Adult', '99', 'weekly', '2025-01-03', '2026-12-01']] }), c.idempotencyKey, c.requestId, c.correlationId]);
});

test('strict CSV parse refuses broken files before any database call', () => {
  const bad = [
    undefined, null, [], {}, { csv: CSV }, UP({ x: 1 }), UP({ kind: 'MEMBERSHIPS' }), UP({ csv: 1 }), UP({ csv: '' }),
    UP({ csv: HEAD + '\n"Ava,Stone\n' }), UP({ csv: HEAD + '\nAva\n' }), UP({ csv: 'First,First\nA,B\n', mapping: { First: 'studentGivenName' } }),
    UP({ csv: '@x,Last\nA,B\n', mapping: { '@x': 'studentGivenName', Last: 'studentFamilyName' } }), UP({ csv: HEAD + '\n' }),
    UP({ csv: HEAD + '\nA\u0000,B,C,1,monthly,2025-01-01,2026-12-01\n' }), UP({ csv: HEAD + '\nA\uD800,B,C,1,monthly,2025-01-01,2026-12-01\n' }),
    UP({ csv: HEAD + '\n' + 'A,B,C,1,monthly,2025-01-01,2026-12-01\n'.repeat(1001) }), UP({ csv: 'x'.repeat(262145) }),
    UP({ mapping: { ...MAPPING, Next: 'ignore' } }), UP({ mapping: { ...MAPPING, Next: 'attendedOn' } }), UP({ mapping: { ...MAPPING, Next: 'amount' } }),
  ];
  for (const input of bad) assert.throws(() => parseBillingCsv(input), status(400, 'BILLING_IMPORT_INVALID'), JSON.stringify(input)?.slice(0, 80));
  const withBom = parseBillingCsv(UP({ csv: '\ufeff' + CSV.replaceAll('\n', '\r\n') }));
  assert.deepEqual(withBom.headers, HEAD.split(','));
  assert.equal(withBom.rows.length, 2);
  const extra = parseBillingCsv({ csv: HEAD + ',Owes,Notes\nA,B,C,1,monthly,2025-01-01,2026-12-01,10,x\n', mapping: { ...MAPPING, Owes: 'balanceOwed', Notes: 'ignore' } });
  assert.equal(extra.mapping.Owes, 'balanceOwed');
});

test('decide and finalize are closed-validated and bound to the batch', async () => {
  const f = fixture(), svc = new BillingImportService(f.db), c = context();
  for (const body of [{}, { expectedVersion: 1, decisions: [] }, { expectedVersion: 1, decisions: [{ index: 1, choice: 'MERGE' }] },
    { expectedVersion: 0, decisions: [{ index: 1, choice: 'IMPORT' }] }, { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }, { index: 1, choice: 'SKIP' }] },
    { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT', note: 'x' }] }]) {
    await assert.rejects(svc.decide(c, batchId, body), status(400, 'BILLING_IMPORT_INVALID'));
  }
  for (const body of [{}, { expectedVersion: 1 }, { expectedVersion: 1, selectedIndices: [1, 1] }, { expectedVersion: 1, selectedIndices: [0] }, { expectedVersion: 1, selectedIndices: [1], all: true }]) {
    await assert.rejects(svc.finalize(c, batchId, body), status(400, 'BILLING_IMPORT_INVALID'));
  }
  assert.equal(f.queries.length, 0);
  await svc.decide(c, batchId.toUpperCase(), { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }, { index: 2, choice: 'IMPORT' }] });
  assert.deepEqual(JSON.parse(f.calls('decide_billing_import')[0].args[1]), { batchId, expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }, { index: 2, choice: 'IMPORT' }] });
  const done = await svc.finalize(c, batchId, { expectedVersion: 2, selectedIndices: [2, 1] });
  assert.equal(done.batch.status, 'FINALIZED');
  // A receipt for another batch is never accepted as this one.
  const g = fixture({ decide: { record: batch({ id: randomUUID(), version: 2, importCount: 2, undecidedCount: 0 }), replayed: false } });
  await assert.rejects(new BillingImportService(g.db).decide(c, batchId, { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }] }), status(503, 'BILLING_IMPORT_UNAVAILABLE'));
});

test('only direct human commands with a clean key reach the database; reads refuse a key', async () => {
  const f = fixture(), svc = new BillingImportService(f.db);
  for (const patch of [{ principalType: 'AI_AGENT' }, { source: 'AI_ACTION_ENGINE' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) {
    await assert.rejects(svc.stage(context(patch), UP()), status(403, 'HUMAN_COMMAND_REQUIRED'));
    await assert.rejects(svc.list(readContext(patch)), status(403, 'HUMAN_COMMAND_REQUIRED'));
  }
  for (const key of ['', ' k', 'k\n', 'x'.repeat(201)]) await assert.rejects(svc.stage(context({ idempotencyKey: key }), UP()), status(409, 'IDEMPOTENCY_KEY_REQUIRED'));
  await assert.rejects(svc.list(context()), status(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  await assert.rejects(svc.detail(readContext(), 'not-a-uuid'), status(400, 'BILLING_IMPORT_INVALID'));
  assert.equal(f.queries.length, 0);
  const listed = await svc.list(readContext());
  assert.deepEqual(listed.batches, []);
  assert.ok(f.calls('read_billing_imports').every((q) => q.readOnly));
});

test('database errors map to stable codes and unknown failures assume no success', async () => {
  const cases = [
    [{ code: '42501', message: 'BILLING_IMPORT_FORBIDDEN' }, 403, 'BILLING_IMPORT_FORBIDDEN'],
    [{ code: '22023', message: 'BILLING_IMPORT_ROW_NOT_IMPORTABLE' }, 400, 'BILLING_IMPORT_ROW_NOT_IMPORTABLE'],
    [{ code: '40001', message: 'BILLING_IMPORT_SELECTION_REQUIRED' }, 409, 'BILLING_IMPORT_SELECTION_REQUIRED'],
    [{ code: '40001', message: 'VERSION_CONFLICT' }, 409, 'VERSION_CONFLICT'],
    [{ code: '40001', message: 'BILLING_IMPORT_STALE' }, 409, 'BILLING_IMPORT_STALE'],
    [{ code: '23505', message: 'IDEMPOTENCY_KEY_REUSED' }, 409, 'IDEMPOTENCY_KEY_REUSED'],
    [{ code: '55P03', message: 'BILLING_IMPORT_BUSY' }, 409, 'BILLING_IMPORT_BUSY'],
    [{ code: 'P0002', message: 'BILLING_IMPORT_NOT_FOUND' }, 404, 'BILLING_IMPORT_NOT_FOUND'],
    [{ code: '40P01', message: 'deadlock detected' }, 409, 'BILLING_IMPORT_CONFLICT'],
    [{ code: '08006', message: 'connection failure' }, 503, 'BILLING_IMPORT_UNAVAILABLE'],
    [{ code: '42501', message: 'IDEMPOTENCY_KEY_REUSED' }, 409, 'IDEMPOTENCY_KEY_REUSED'],
  ];
  for (const [error, httpStatus, code] of cases) {
    const svc = new BillingImportService(fixture({ error: Object.assign(new Error(error.message), error) }).db);
    await assert.rejects(svc.decide(context(), batchId, { expectedVersion: 1, decisions: [{ index: 1, choice: 'SKIP' }] }), status(httpStatus, code), error.message);
  }
  // A malformed receipt is never taken as success.
  for (const bad of [{ record: batch() }, { record: batch(), replayed: 'no' }, { record: batch({ importCount: 3 }), replayed: false }, { record: batch(), replayed: false, extra: 1 }]) {
    const svc = new BillingImportService(fixture({ stage: bad }).db);
    await assert.rejects(svc.stage(context(), UP()), status(503, 'BILLING_IMPORT_UNAVAILABLE'));
  }
});
