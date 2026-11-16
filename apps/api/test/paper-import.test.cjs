const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const zlib = require('node:zlib');
const { stripImageMetadata, sniffImageType } = require('../dist/paper-import/image-metadata.js');
const { SyntheticPaperReader, PAPER_IMPORT_SAMPLES } = require('../dist/paper-import/paper-reader.js');
const { PaperImportService } = require('../dist/paper-import/paper-import.service.js');

// Mocked boundary tests for the 0388 paper import API. Authority, storage, erasure, expiry, the AI spend decision and
// sending through the existing imports are proven against PostgreSQL by test-paper-import-integrity.mjs.
const fixture = (name) => readFileSync(resolve(__dirname, 'fixtures', name));
const sample = (name) => readFileSync(resolve(__dirname, '../../web/public/paper-import-samples', name));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };

function withJpegApp1(jpeg) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('GPS 34.05N 118.24W camera', 'latin1')]);
  const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(payload.length + 2, 2);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x0c]), Buffer.from('owner name', 'latin1')]);
  return Buffer.concat([jpeg.subarray(0, 2), seg, payload, com, jpeg.subarray(2), Buffer.from('trailing preview with Exif', 'latin1')]);
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function withPngText(png) {
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, ihdrEnd), pngChunk('tEXt', Buffer.from('Author\0Grace Park', 'latin1')), pngChunk('eXIf', Buffer.from('MM\0*', 'latin1')), png.subarray(ihdrEnd)]);
}
function withWebpExif(webp) {
  const data = Buffer.from('Exif GPS data!', 'latin1');
  const head = Buffer.alloc(8); head.write('EXIF', 0, 'latin1'); head.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([webp.subarray(12), head, data]);
  const riff = Buffer.alloc(12); riff.write('RIFF', 0, 'latin1'); riff.writeUInt32LE(body.length + 4, 4); riff.write('WEBP', 8, 'latin1');
  return Buffer.concat([riff, body]);
}

test('metadata is stripped from JPEG, PNG and WebP pages and clean pages are kept byte for byte', () => {
  const jpeg = fixture('paper-page.jpg'), png = sample('student-card.png'), webp = fixture('paper-page.webp');
  const dirtyJpeg = withJpegApp1(jpeg), cleanJpeg = stripImageMetadata('image/jpeg', dirtyJpeg);
  assert.equal(cleanJpeg.includes(Buffer.from('Exif')), false); assert.equal(cleanJpeg.includes(Buffer.from('owner name')), false);
  assert.deepEqual(cleanJpeg.subarray(-2), Buffer.from([0xff, 0xd9]));
  assert.deepEqual(stripImageMetadata('image/jpeg', jpeg), jpeg.subarray(0, jpeg.lastIndexOf(Buffer.from([0xff, 0xd9])) + 2));
  const cleanPng = stripImageMetadata('image/png', withPngText(png));
  assert.equal(cleanPng.includes(Buffer.from('Grace Park')), false); assert.deepEqual(cleanPng, png);
  const cleanWebp = stripImageMetadata('image/webp', withWebpExif(webp));
  assert.equal(cleanWebp.includes(Buffer.from('GPS')), false); assert.equal(cleanWebp.readUInt32LE(4) + 8, cleanWebp.length);
  assert.equal(sniffImageType(cleanWebp), 'image/webp');
  for (const name of ['attendance-sheet.png', 'student-card.png', 'contract.png']) {
    const bytes = sample(name); assert.ok(PAPER_IMPORT_SAMPLES[sha(stripImageMetadata('image/png', bytes))], `${name} is a known sample after stripping`);
  }
});

test('pages that are not the declared image, or are truncated, are refused', () => {
  const jpeg = fixture('paper-page.jpg'), png = sample('contract.png'), webp = fixture('paper-page.webp');
  const cases = [['image/png', jpeg], ['image/jpeg', png], ['image/webp', png], ['image/jpeg', jpeg.subarray(0, 200)], ['image/png', png.subarray(0, png.length - 12)],
    ['image/webp', webp.subarray(0, 40)], ['image/jpeg', Buffer.from('<svg onload=alert(1)>')], ['image/png', Buffer.from('%PDF-1.7')], ['image/jpeg', Buffer.alloc(0)]];
  for (const [type, bytes] of cases) assert.throws(() => stripImageMetadata(type, bytes), /PAPER_IMPORT_IMAGE_REFUSED/, `${type} ${bytes.length}`);
});

test('the stand-in reader reads only built-in samples of the chosen kind and never guesses', async () => {
  const reader = new SyntheticPaperReader();
  const card = sha(sample('student-card.png')), sheet = sha(sample('attendance-sheet.png'));
  const read = await reader.read({ kind: 'STUDENT_CARDS', checksums: [card] });
  assert.equal(read.reader, 'SYNTHETIC'); assert.equal(read.outcome, 'SAMPLE_READ'); assert.equal(read.rows.length, 1);
  assert.deepEqual(read.rows[0].slice(0, 3), ['Mina', 'Park', '2017-03-14']); assert.equal(read.rows[0].length, 10);
  assert.equal(read.unsure[0][8], true, 'the handwritten phone is marked unsure');
  const sheetRead = await reader.read({ kind: 'ATTENDANCE_SHEETS', checksums: [sheet, sheet.replace(/^./, '0')] });
  assert.equal(sheetRead.rows.length, 4); assert.equal(sheetRead.rows[0].length, 6);
  for (const input of [{ kind: 'STUDENT_CARDS', checksums: ['a'.repeat(64)] }, { kind: 'CONTRACTS', checksums: [card] }, { kind: 'ATTENDANCE_SHEETS', checksums: [card] }]) {
    const none = await reader.read(input);
    assert.deepEqual(none, { reader: 'SYNTHETIC', outcome: 'NOT_READABLE', rows: [], unsure: [] });
  }
});

const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const setId = randomUUID();
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'paper-key', externalSubject: 'verified-human', ...patch });
const summary = (patch = {}) => ({ id: setId, kind: 'STUDENT_CARDS', target: 'STUDENTS', version: 1, status: 'OPEN', pageCount: 0, reader: null, readOutcome: null, sentBatchId: null,
  createdAt: '2026-11-15T22:00:00.000Z', expiresAt: '2026-12-15T22:00:00.000Z', readAt: null, sentAt: null, deletedAt: null, deleteReason: null, ...patch });
const detail = (patch = {}, rest = {}) => ({ set: summary(patch), columns: ['studentGivenName', 'studentFamilyName', 'birthDate', 'studentEmail', 'studentMobile', 'guardianGivenName', 'guardianFamilyName', 'guardianEmail', 'guardianMobile', 'familyKey'],
  rows: [], unsure: [], pages: [], ...rest });

function db(options = {}) {
  const queries = [];
  return { queries, calls: (name) => queries.filter((q) => q.sql.includes(name)),
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        assert.doesNotMatch(sql, /(INSERT|UPDATE|DELETE)\s|hon\.paper_import_(sets|pages|requests)\b/);
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error && options.errorOn?.test(sql) !== false) throw options.error;
        for (const [pattern, data] of options.answers ?? []) if (pattern.test(sql)) return { rows: [{ data: typeof data === 'function' ? data(args) : data }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); } };
}
const noReader = { read: async () => assert.fail('the reader must not be called') };

test('adding a page strips metadata before the one protected write', async () => {
  const f = db({ answers: [[/add_paper_import_page/, { record: summary({ version: 2, pageCount: 1 }), replayed: false }]] });
  const svc = new PaperImportService(f, noReader), c = context();
  const dirty = withJpegApp1(fixture('paper-page.jpg'));
  const result = await svc.addPage(c, setId, { expectedVersion: 1, mediaType: 'image/jpeg', data: dirty.toString('base64') });
  assert.equal(result.set.pageCount, 1);
  const [call] = f.calls('add_paper_import_page');
  const sent = JSON.parse(call.args[1]);
  assert.equal(call.args[5], setId); assert.equal(call.readOnly, false);
  assert.equal(Buffer.from(sent.data, 'base64').includes(Buffer.from('Exif')), false);
  for (const body of [{}, { expectedVersion: 1, mediaType: 'image/gif', data: 'R0lG' }, { expectedVersion: 1, mediaType: 'image/jpeg', data: 'not base64!' },
    { expectedVersion: 0, mediaType: 'image/jpeg', data: dirty.toString('base64') }, { expectedVersion: 1, mediaType: 'image/jpeg', data: dirty.toString('base64'), name: 'x.jpg' }]) {
    await assert.rejects(svc.addPage(c, setId, body), status(400, 'PAPER_IMPORT_INVALID'));
  }
  await assert.rejects(svc.addPage(c, setId, { expectedVersion: 1, mediaType: 'image/png', data: dirty.toString('base64') }), status(400, 'PAPER_IMPORT_IMAGE_REFUSED'));
  await assert.rejects(svc.addPage(context({ idempotencyKey: '' }), setId, { expectedVersion: 1, mediaType: 'image/jpeg', data: dirty.toString('base64') }), status(409, 'IDEMPOTENCY_KEY_REQUIRED'));
  await assert.rejects(svc.addPage(context({ source: 'AI_AGENT' }), setId, { expectedVersion: 1, mediaType: 'image/jpeg', data: dirty.toString('base64') }), status(403, 'HUMAN_COMMAND_REQUIRED'));
  assert.equal(f.calls('add_paper_import_page').length, 1, 'refused input never reaches the database');
});

test('reading: start, stand-in read, record for that reading only; an already read set is not read again', async () => {
  const readingId = randomUUID(), card = sha(sample('student-card.png'));
  const read = detail({ version: 4, status: 'READ', pageCount: 1, reader: 'SYNTHETIC', readOutcome: 'SAMPLE_READ', readAt: '2026-11-15T22:01:00.000Z' },
    { rows: [['Mina', 'Park', '2017-03-14', '', '', 'Grace', 'Park', 'grace.park@example.com', '+12135550142', 'park']], unsure: [[false, false, false, false, false, false, false, false, true, false]],
      pages: [{ pageNo: 1, mediaType: 'image/png', bytes: 43285, checksum: card }] });
  const f = db({ answers: [[/begin_paper_reading/, { done: false, readingId, kind: 'STUDENT_CARDS', checksums: [card] }], [/record_paper_reading/, read]] });
  const svc = new PaperImportService(f, new SyntheticPaperReader());
  const out = await svc.readPages(context({ idempotencyKey: '' }), setId, { expectedVersion: 3 });
  assert.equal(out.set.status, 'READ');
  const recorded = JSON.parse(f.calls('record_paper_reading')[0].args[2]);
  assert.equal(recorded.readingId, readingId); assert.equal(recorded.reader, 'SYNTHETIC'); assert.equal(recorded.outcome, 'SAMPLE_READ'); assert.equal(recorded.rows[0][0], 'Mina');
  const again = db({ answers: [[/begin_paper_reading/, { done: true }], [/read_paper_import\(/, read]] });
  const svc2 = new PaperImportService(again, noReader);
  assert.equal((await svc2.readPages(context({ idempotencyKey: '' }), setId, { expectedVersion: 3 })).set.status, 'READ');
  assert.equal(again.calls('record_paper_reading').length, 0);
});

test('an AI spend refusal is reported with its reason and nothing is read', async () => {
  const error = Object.assign(new Error('PAPER_IMPORT_AI_BLOCKED'), { code: '42501', detail: 'AI_PAUSED_BY_HQ' });
  const f = db({ error, errorOn: /begin_paper_reading/ });
  const svc = new PaperImportService(f, noReader);
  await assert.rejects(svc.readPages(context({ idempotencyKey: '' }), setId, { expectedVersion: 1 }), (e) => {
    assert.equal(e.getStatus(), 403); assert.equal(e.getResponse().code, 'PAPER_IMPORT_AI_BLOCKED'); assert.equal(e.getResponse().reason, 'AI_PAUSED_BY_HQ'); return true; });
  const odd = new PaperImportService(db({ error: Object.assign(new Error('PAPER_IMPORT_AI_BLOCKED'), { code: '42501', detail: 'x; DROP' }), errorOn: /begin/ }), noReader);
  await assert.rejects(odd.readPages(context({ idempotencyKey: '' }), setId, { expectedVersion: 1 }), (e) => e.getResponse().reason === 'AI_NOT_AVAILABLE');
});

test('save, send and delete are closed-validated and bound to the set', async () => {
  const f = db({ answers: [[/save_paper_import_table/, { record: summary({ version: 5, status: 'READ', pageCount: 1, reader: 'SYNTHETIC', readOutcome: 'NOT_READABLE', readAt: '2026-11-15T22:01:00.000Z' }), replayed: false }],
    [/send_paper_import/, { record: summary({ id: randomUUID() }), replayed: false }]] });
  const svc = new PaperImportService(f, noReader), c = context();
  const row = ['Ava', 'Stone', '', '', '', '', '', '', '', ''], flags = row.map(() => false);
  assert.equal((await svc.save(c, setId, { expectedVersion: 4, rows: [row], unsure: [flags] })).set.version, 5);
  for (const body of [{ expectedVersion: 4, rows: [row] }, { expectedVersion: 4, rows: [row.slice(1)], unsure: [flags.slice(1)] }, { expectedVersion: 4, rows: [row, ['a', 'b', 'c', 'd', 'e', 'f']], unsure: [flags, flags.slice(0, 6)] },
    { expectedVersion: 4, rows: [[' Ava', ...row.slice(1)]], unsure: [flags] }, { expectedVersion: 4, rows: [['A‮va', ...row.slice(1)]], unsure: [flags] },
    { expectedVersion: 4, rows: [['x'.repeat(201), ...row.slice(1)]], unsure: [flags] }, { expectedVersion: 4, rows: Array(201).fill(row), unsure: Array(201).fill(flags) },
    { expectedVersion: 4, rows: [row], unsure: [flags.map(() => 1)] }]) {
    await assert.rejects(svc.save(c, setId, body), status(400, 'PAPER_IMPORT_INVALID'), JSON.stringify(body).slice(0, 80));
  }
  // A receipt for another set is never accepted as this set's send.
  await assert.rejects(svc.send(c, setId, { expectedVersion: 5 }), status(503, 'PAPER_IMPORT_UNAVAILABLE'));
  assert.equal(JSON.parse(f.calls('send_paper_import')[0].args[1]).expectedVersion, 5);
  await assert.rejects(svc.remove(c, setId, { force: true }), status(400, 'PAPER_IMPORT_INVALID'));
  await assert.rejects(svc.detail(context({ idempotencyKey: '' }), 'not-a-uuid'), status(400, 'PAPER_IMPORT_INVALID'));
  await assert.rejects(svc.page(context({ idempotencyKey: '' }), setId, '11'), status(400, 'PAPER_IMPORT_INVALID'));
});
