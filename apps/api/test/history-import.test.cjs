const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { HistoryImportService, parseHistoryCsv } = require('../dist/migration/history-import.service.js');

// Mocked boundary tests for the 0333 class and attendance-history import API. The database behaviour itself (authority,
// revalidation, matching, idempotency, exact selection, created records, no other effects) is proven against PostgreSQL by
// test-history-import-integrity.mjs.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const batchId = randomUUID();
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'import-key',
  externalSubject: 'verified-human', ...patch });
const readContext = (patch = {}) => context({ idempotencyKey: '', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const batch = (patch = {}) => ({ id: batchId, kind: 'ATTENDANCE', version: 1, status: 'STAGED', rowCount: 2, validCount: 2, importCount: 0, skipCount: 0, undecidedCount: 2, importedCount: 0,
  checksum: 'a'.repeat(64), schoolToday: '2026-11-09', createdAt: '2026-11-09T02:00:00.000Z', finalizedAt: null, ...patch });
const MAPPING = { First: 'studentGivenName', Last: 'studentFamilyName', Date: 'attendedOn' };
const CSV = 'First,Last,Date\nAva,Stone,2026-01-02\nSam,Ortiz,2026-01-03\n';
const UP = (patch = {}) => ({ kind: 'ATTENDANCE', csv: CSV, mapping: MAPPING, ...patch });

function fixture(options = {}) {
  const queries = [];
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        assert.doesNotMatch(sql, /(INSERT|UPDATE|DELETE)\s|hon\.(?:programs|class_series|class_sessions|attendance_records|history_import_\w+|imported_attendance_history)\b/);
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/hon\.stage_history_import\(/.test(sql)) return { rows: [{ data: options.stage ?? { record: batch(), replayed: false } }] };
        if (/hon\.decide_history_import\(/.test(sql)) return { rows: [{ data: options.decide ?? { record: batch({ version: 2, importCount: 2, undecidedCount: 0 }), replayed: false } }] };
        if (/hon\.finalize_history_import\(/.test(sql)) return { rows: [{ data: options.finalize ?? { record: batch({ version: 3, status: 'FINALIZED', importCount: 2, undecidedCount: 0, importedCount: 2, finalizedAt: '2026-11-09T02:05:00.000Z' }), replayed: false } }] };
        if (/hon\.read_history_imports\(\$1\)/.test(sql)) return { rows: [{ data: options.list ?? { batches: [], fields: { CLASSES: ['className', 'programName', 'weekdays', 'startTime', 'durationMinutes', 'capacity', 'roomName', 'bookingPolicy', 'startsOn'], ATTENDANCE: ['studentGivenName', 'studentFamilyName', 'birthDate', 'attendedOn', 'visits', 'className'] }, maxBytes: 262144, maxRows: 1000, maxColumns: 24 } }] };
        if (/hon\.read_history_import\(\$1,\$2::uuid\)/.test(sql)) return { rows: [{ data: options.detail }] };
        if (/hon\.read_imported_attendance\(\$1,\$2::uuid\)/.test(sql)) return { rows: [{ data: options.attendance }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries, calls: (name) => queries.filter((q) => q.sql.includes(name)) };
}

test('stage parses the CSV and sends one protected write with the parsed rows, exact text and checked mapping', async () => {
  const f = fixture(), svc = new HistoryImportService(f.db), c = context();
  const result = await svc.stage(c, UP());
  assert.equal(result.batch.id, batchId);
  const [call] = f.calls('stage_history_import');
  assert.equal(call.readOnly, false);
  assert.deepEqual(call.args, [c.externalSubject, JSON.stringify({ kind: 'ATTENDANCE', csv: CSV, headers: ['First', 'Last', 'Date'], mapping: MAPPING,
    rows: [['Ava', 'Stone', '2026-01-02'], ['Sam', 'Ortiz', '2026-01-03']] }), c.idempotencyKey, c.requestId, c.correlationId]);
});

test('strict CSV parse refuses broken files before any database call', () => {
  const bad = [
    undefined, null, [], {}, { csv: CSV, mapping: MAPPING }, UP({ x: 1 }), UP({ kind: 'STUDENTS' }), UP({ kind: 'classes' }), UP({ csv: 1 }), UP({ csv: '' }),
    UP({ csv: 'First,Last\n"Ava,Stone\n' }), UP({ csv: 'First,Last,Date\nAva\n' }), UP({ csv: 'First,First\nA,B\n', mapping: { First: 'studentGivenName' } }),
    UP({ csv: '@x,Last\nA,B\n', mapping: { '@x': 'studentGivenName', Last: 'studentFamilyName' } }), UP({ csv: 'First,Last,Date\n' }),
    UP({ csv: 'First,Last,Date\nA\u0000,B,C\n' }), UP({ csv: 'First,Last,Date\nA\uD800,B,C\n' }),
    UP({ csv: 'First,Last,Date\n' + 'A,B,2026-01-01\n'.repeat(1001) }), UP({ csv: 'x'.repeat(262145) }),
    UP({ mapping: { First: 'studentGivenName', Last: 'studentFamilyName' } }), UP({ mapping: { ...MAPPING, Date: 'notes' } }),
    UP({ mapping: { First: 'studentGivenName', Last: 'ignore', Date: 'attendedOn' } }),
    UP({ kind: 'CLASSES' }), UP({ mapping: { First: 'studentGivenName', Last: 'studentFamilyName', Date: 'weekdays' } }),
  ];
  for (const input of bad) assert.throws(() => parseHistoryCsv(input), status(400, 'HISTORY_IMPORT_INVALID'), JSON.stringify(input)?.slice(0, 80));
  const withBom = parseHistoryCsv(UP({ csv: '﻿' + CSV.replaceAll('\n', '\r\n') }));
  assert.deepEqual(withBom.headers, ['First', 'Last', 'Date']);
  const classes = parseHistoryCsv({ kind: 'CLASSES', csv: 'Class,Days,Time,Min\nKids,Mon,16:00,45\n', mapping: { Class: 'className', Days: 'weekdays', Time: 'startTime', Min: 'durationMinutes' } });
  assert.equal(classes.kind, 'CLASSES');
  assert.equal(withBom.rows.length, 2);
});

test('decide and finalize are closed-validated and bound to the batch', async () => {
  const f = fixture(), svc = new HistoryImportService(f.db), c = context();
  for (const body of [{}, { expectedVersion: 1, decisions: [] }, { expectedVersion: 1, decisions: [{ index: 1, choice: 'MERGE' }] },
    { expectedVersion: 0, decisions: [{ index: 1, choice: 'IMPORT' }] }, { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }, { index: 1, choice: 'SKIP' }] },
    { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT', note: 'x' }] }]) {
    await assert.rejects(svc.decide(c, batchId, body), status(400, 'HISTORY_IMPORT_INVALID'));
  }
  for (const body of [{}, { expectedVersion: 1 }, { expectedVersion: 1, selectedIndices: [1, 1] }, { expectedVersion: 1, selectedIndices: [0] }, { expectedVersion: 1, selectedIndices: [1], all: true }]) {
    await assert.rejects(svc.finalize(c, batchId, body), status(400, 'HISTORY_IMPORT_INVALID'));
  }
  assert.equal(f.queries.length, 0);
  await svc.decide(c, batchId.toUpperCase(), { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }, { index: 2, choice: 'IMPORT' }] });
  assert.deepEqual(JSON.parse(f.calls('decide_history_import')[0].args[1]), { batchId, expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }, { index: 2, choice: 'IMPORT' }] });
  const done = await svc.finalize(c, batchId, { expectedVersion: 2, selectedIndices: [2, 1] });
  assert.equal(done.batch.status, 'FINALIZED');
  // A receipt for another batch is never accepted as this one.
  const g = fixture({ decide: { record: batch({ id: randomUUID(), version: 2, importCount: 2, undecidedCount: 0 }), replayed: false } });
  await assert.rejects(new HistoryImportService(g.db).decide(c, batchId, { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }] }), status(503, 'HISTORY_IMPORT_UNAVAILABLE'));
});

test('only direct human commands with a clean key reach the database; reads refuse a key', async () => {
  const f = fixture(), svc = new HistoryImportService(f.db);
  for (const patch of [{ principalType: 'AI_AGENT' }, { source: 'AI_ACTION_ENGINE' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) {
    await assert.rejects(svc.stage(context(patch), UP()), status(403, 'HUMAN_COMMAND_REQUIRED'));
    await assert.rejects(svc.list(readContext(patch)), status(403, 'HUMAN_COMMAND_REQUIRED'));
  }
  for (const key of ['', ' k', 'k\n', 'x'.repeat(201)]) await assert.rejects(svc.stage(context({ idempotencyKey: key }), UP()), status(409, 'IDEMPOTENCY_KEY_REQUIRED'));
  await assert.rejects(svc.list(context()), status(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  await assert.rejects(svc.detail(readContext(), 'not-a-uuid'), status(400, 'HISTORY_IMPORT_INVALID'));
  assert.equal(f.queries.length, 0);
  const listed = await svc.list(readContext());
  assert.deepEqual(listed.batches, []);
  assert.ok(f.calls('read_history_imports').every((q) => q.readOnly));
});

test('database errors map to stable codes and unknown failures assume no success', async () => {
  const cases = [
    [{ code: '42501', message: 'HISTORY_IMPORT_FORBIDDEN' }, 403, 'HISTORY_IMPORT_FORBIDDEN'],
    [{ code: '22023', message: 'HISTORY_IMPORT_ROW_NOT_IMPORTABLE' }, 400, 'HISTORY_IMPORT_ROW_NOT_IMPORTABLE'],
    [{ code: '40001', message: 'HISTORY_IMPORT_SELECTION_REQUIRED' }, 409, 'HISTORY_IMPORT_SELECTION_REQUIRED'],
    [{ code: '40001', message: 'VERSION_CONFLICT' }, 409, 'VERSION_CONFLICT'],
    [{ code: '40001', message: 'HISTORY_IMPORT_STALE' }, 409, 'HISTORY_IMPORT_STALE'],
    [{ code: '23505', message: 'IDEMPOTENCY_KEY_REUSED' }, 409, 'IDEMPOTENCY_KEY_REUSED'],
    [{ code: '55P03', message: 'HISTORY_IMPORT_BUSY' }, 409, 'HISTORY_IMPORT_BUSY'],
    [{ code: 'P0002', message: 'HISTORY_IMPORT_NOT_FOUND' }, 404, 'HISTORY_IMPORT_NOT_FOUND'],
    [{ code: '40P01', message: 'deadlock detected' }, 409, 'HISTORY_IMPORT_CONFLICT'],
    [{ code: '08006', message: 'connection failure' }, 503, 'HISTORY_IMPORT_UNAVAILABLE'],
    [{ code: '42501', message: 'IDEMPOTENCY_KEY_REUSED' }, 409, 'IDEMPOTENCY_KEY_REUSED'],
  ];
  for (const [error, httpStatus, code] of cases) {
    const svc = new HistoryImportService(fixture({ error: Object.assign(new Error(error.message), error) }).db);
    await assert.rejects(svc.decide(context(), batchId, { expectedVersion: 1, decisions: [{ index: 1, choice: 'SKIP' }] }), status(httpStatus, code), error.message);
  }
  // A malformed receipt is never taken as success.
  for (const bad of [{ record: batch() }, { record: batch(), replayed: 'no' }, { record: batch({ importCount: 3 }), replayed: false }, { record: batch(), replayed: false, extra: 1 }]) {
    const svc = new HistoryImportService(fixture({ stage: bad }).db);
    await assert.rejects(svc.stage(context(), UP()), status(503, 'HISTORY_IMPORT_UNAVAILABLE'));
  }
});

test('the student attendance read is read-only, keyless and verified for that student', async () => {
  const profile = randomUUID();
  const f = fixture({ attendance: { studentProfileId: profile, totalVisits: 43, firstOn: '2025-12-31', lastOn: '2026-01-05',
    entries: [{ attendedOn: '2026-01-05', visits: 1, className: 'Kids', batchId }] } });
  const svc = new HistoryImportService(f.db);
  const read = await svc.attendance(readContext(), profile.toUpperCase());
  assert.equal(read.totalVisits, 43);
  assert.ok(f.calls('read_imported_attendance').every((q) => q.readOnly && q.args[1] === profile));
  await assert.rejects(svc.attendance(context(), profile), status(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  const g = fixture({ attendance: { studentProfileId: randomUUID(), totalVisits: 0, firstOn: null, lastOn: null, entries: [] } });
  await assert.rejects(new HistoryImportService(g.db).attendance(readContext(), profile), status(503, 'HISTORY_IMPORT_UNAVAILABLE'));
});
