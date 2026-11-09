const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { StudentImportService, parseStudentCsv } = require('../dist/migration/student-import.service.js');

// Mocked boundary tests for the 0226 student CSV import API. The database behaviour itself (authority, revalidation,
// grouping, idempotency, exact selection, created records, no other effects) is proven against PostgreSQL by
// test-student-import-integrity.mjs.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const batchId = randomUUID();
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'import-key',
  externalSubject: 'verified-human', ...patch });
const readContext = (patch = {}) => context({ idempotencyKey: '', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const batch = (patch = {}) => ({ id: batchId, version: 1, status: 'STAGED', rowCount: 2, validCount: 2, importCount: 0, skipCount: 0, undecidedCount: 2, importedCount: 0,
  checksum: 'a'.repeat(64), schoolToday: '2026-11-09', createdAt: '2026-11-09T02:00:00.000Z', finalizedAt: null, ...patch });
const MAPPING = { First: 'studentGivenName', Last: 'studentFamilyName', DOB: 'birthDate' };
const CSV = 'First,Last,DOB\nAva,Stone,2016-04-02\nSam,Ortiz,1990-01-01\n';

function fixture(options = {}) {
  const queries = [];
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        assert.doesNotMatch(sql, /(INSERT|UPDATE|DELETE)\s|hon\.(?:people|families|family_members|student_profiles|student_import_\w+)\b/);
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/hon\.stage_student_import\(/.test(sql)) return { rows: [{ data: options.stage ?? { record: batch(), replayed: false } }] };
        if (/hon\.decide_student_import\(/.test(sql)) return { rows: [{ data: options.decide ?? { record: batch({ version: 2, importCount: 2, undecidedCount: 0 }), replayed: false } }] };
        if (/hon\.finalize_student_import\(/.test(sql)) return { rows: [{ data: options.finalize ?? { record: batch({ version: 3, status: 'FINALIZED', importCount: 2, undecidedCount: 0, importedCount: 2, finalizedAt: '2026-11-09T02:05:00.000Z' }), replayed: false } }] };
        if (/hon\.read_student_imports\(\$1\)/.test(sql)) return { rows: [{ data: options.list ?? { batches: [], fields: ['studentGivenName', 'studentFamilyName', 'birthDate', 'studentEmail', 'studentMobile', 'guardianGivenName', 'guardianFamilyName', 'guardianEmail', 'guardianMobile', 'familyKey'], maxBytes: 262144, maxRows: 1000, maxColumns: 24 } }] };
        if (/hon\.read_student_import\(\$1,\$2::uuid\)/.test(sql)) return { rows: [{ data: options.detail }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries, calls: (name) => queries.filter((q) => q.sql.includes(name)) };
}

test('stage parses the CSV and sends one protected write with the parsed rows, exact text and checked mapping', async () => {
  const f = fixture(), svc = new StudentImportService(f.db), c = context();
  const result = await svc.stage(c, { csv: CSV, mapping: MAPPING });
  assert.equal(result.batch.id, batchId);
  const [call] = f.calls('stage_student_import');
  assert.equal(call.readOnly, false);
  assert.deepEqual(call.args, [c.externalSubject, JSON.stringify({ csv: CSV, headers: ['First', 'Last', 'DOB'], mapping: MAPPING,
    rows: [['Ava', 'Stone', '2016-04-02'], ['Sam', 'Ortiz', '1990-01-01']] }), c.idempotencyKey, c.requestId, c.correlationId]);
});

test('strict CSV parse refuses broken files before any database call', () => {
  const bad = [
    undefined, null, [], {}, { csv: CSV }, { csv: CSV, mapping: MAPPING, x: 1 }, { csv: 1, mapping: MAPPING }, { csv: '', mapping: MAPPING },
    { csv: 'First,Last\n"Ava,Stone\n', mapping: MAPPING }, { csv: 'First,Last,DOB\nAva\n', mapping: MAPPING }, { csv: 'First,First\nA,B\n', mapping: { First: 'studentGivenName' } },
    { csv: '@x,Last\nA,B\n', mapping: { '@x': 'studentGivenName', Last: 'studentFamilyName' } }, { csv: 'First,Last,DOB\n', mapping: MAPPING },
    { csv: 'First,Last,DOB\nA\u0000,B,C\n', mapping: MAPPING }, { csv: 'First,Last,DOB\nA\uD800,B,C\n', mapping: MAPPING },
    { csv: 'First,Last,DOB\n' + 'A,B,2000-01-01\n'.repeat(1001), mapping: MAPPING }, { csv: 'x'.repeat(262145), mapping: MAPPING },
    { csv: CSV, mapping: { First: 'studentGivenName', Last: 'studentFamilyName' } }, { csv: CSV, mapping: { ...MAPPING, DOB: 'notes' } },
    { csv: CSV, mapping: { First: 'studentGivenName', Last: 'ignore', DOB: 'birthDate' } },
  ];
  for (const input of bad) assert.throws(() => parseStudentCsv(input), status(400, 'STUDENT_IMPORT_INVALID'), JSON.stringify(input)?.slice(0, 80));
  const withBom = parseStudentCsv({ csv: '﻿' + CSV.replaceAll('\n', '\r\n'), mapping: MAPPING });
  assert.deepEqual(withBom.headers, ['First', 'Last', 'DOB']);
  assert.equal(withBom.rows.length, 2);
});

test('decide and finalize are closed-validated and bound to the batch', async () => {
  const f = fixture(), svc = new StudentImportService(f.db), c = context();
  for (const body of [{}, { expectedVersion: 1, decisions: [] }, { expectedVersion: 1, decisions: [{ index: 1, choice: 'MERGE' }] },
    { expectedVersion: 0, decisions: [{ index: 1, choice: 'IMPORT' }] }, { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }, { index: 1, choice: 'SKIP' }] },
    { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT', note: 'x' }] }]) {
    await assert.rejects(svc.decide(c, batchId, body), status(400, 'STUDENT_IMPORT_INVALID'));
  }
  for (const body of [{}, { expectedVersion: 1 }, { expectedVersion: 1, selectedIndices: [1, 1] }, { expectedVersion: 1, selectedIndices: [0] }, { expectedVersion: 1, selectedIndices: [1], all: true }]) {
    await assert.rejects(svc.finalize(c, batchId, body), status(400, 'STUDENT_IMPORT_INVALID'));
  }
  assert.equal(f.queries.length, 0);
  await svc.decide(c, batchId.toUpperCase(), { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }, { index: 2, choice: 'IMPORT' }] });
  assert.deepEqual(JSON.parse(f.calls('decide_student_import')[0].args[1]), { batchId, expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }, { index: 2, choice: 'IMPORT' }] });
  const done = await svc.finalize(c, batchId, { expectedVersion: 2, selectedIndices: [2, 1] });
  assert.equal(done.batch.status, 'FINALIZED');
  // A receipt for another batch is never accepted as this one.
  const g = fixture({ decide: { record: batch({ id: randomUUID(), version: 2, importCount: 2, undecidedCount: 0 }), replayed: false } });
  await assert.rejects(new StudentImportService(g.db).decide(c, batchId, { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }] }), status(503, 'STUDENT_IMPORT_UNAVAILABLE'));
});

test('only direct human commands with a clean key reach the database; reads refuse a key', async () => {
  const f = fixture(), svc = new StudentImportService(f.db);
  for (const patch of [{ principalType: 'AI_AGENT' }, { source: 'AI_ACTION_ENGINE' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) {
    await assert.rejects(svc.stage(context(patch), { csv: CSV, mapping: MAPPING }), status(403, 'HUMAN_COMMAND_REQUIRED'));
    await assert.rejects(svc.list(readContext(patch)), status(403, 'HUMAN_COMMAND_REQUIRED'));
  }
  for (const key of ['', ' k', 'k\n', 'x'.repeat(201)]) await assert.rejects(svc.stage(context({ idempotencyKey: key }), { csv: CSV, mapping: MAPPING }), status(409, 'IDEMPOTENCY_KEY_REQUIRED'));
  await assert.rejects(svc.list(context()), status(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  await assert.rejects(svc.detail(readContext(), 'not-a-uuid'), status(400, 'STUDENT_IMPORT_INVALID'));
  assert.equal(f.queries.length, 0);
  const listed = await svc.list(readContext());
  assert.deepEqual(listed.batches, []);
  assert.ok(f.calls('read_student_imports').every((q) => q.readOnly));
});

test('database errors map to stable codes and unknown failures assume no success', async () => {
  const cases = [
    [{ code: '42501', message: 'STUDENT_IMPORT_FORBIDDEN' }, 403, 'STUDENT_IMPORT_FORBIDDEN'],
    [{ code: '22023', message: 'STUDENT_IMPORT_ROW_NOT_IMPORTABLE' }, 400, 'STUDENT_IMPORT_ROW_NOT_IMPORTABLE'],
    [{ code: '40001', message: 'STUDENT_IMPORT_SELECTION_REQUIRED' }, 409, 'STUDENT_IMPORT_SELECTION_REQUIRED'],
    [{ code: '40001', message: 'VERSION_CONFLICT' }, 409, 'VERSION_CONFLICT'],
    [{ code: '23505', message: 'IDEMPOTENCY_KEY_REUSED' }, 409, 'IDEMPOTENCY_KEY_REUSED'],
    [{ code: '55P03', message: 'STUDENT_IMPORT_BUSY' }, 409, 'STUDENT_IMPORT_BUSY'],
    [{ code: 'P0002', message: 'STUDENT_IMPORT_NOT_FOUND' }, 404, 'STUDENT_IMPORT_NOT_FOUND'],
    [{ code: '40P01', message: 'deadlock detected' }, 409, 'STUDENT_IMPORT_CONFLICT'],
    [{ code: '08006', message: 'connection failure' }, 503, 'STUDENT_IMPORT_UNAVAILABLE'],
    [{ code: '42501', message: 'IDEMPOTENCY_KEY_REUSED' }, 409, 'IDEMPOTENCY_KEY_REUSED'],
  ];
  for (const [error, httpStatus, code] of cases) {
    const svc = new StudentImportService(fixture({ error: Object.assign(new Error(error.message), error) }).db);
    await assert.rejects(svc.decide(context(), batchId, { expectedVersion: 1, decisions: [{ index: 1, choice: 'SKIP' }] }), status(httpStatus, code), error.message);
  }
  // A malformed receipt is never taken as success.
  for (const bad of [{ record: batch() }, { record: batch(), replayed: 'no' }, { record: batch({ importCount: 3 }), replayed: false }, { record: batch(), replayed: false, extra: 1 }]) {
    const svc = new StudentImportService(fixture({ stage: bad }).db);
    await assert.rejects(svc.stage(context(), { csv: CSV, mapping: MAPPING }), status(503, 'STUDENT_IMPORT_UNAVAILABLE'));
  }
});
