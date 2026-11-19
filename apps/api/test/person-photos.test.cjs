const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { SchoolPersonPhotoService } = require('../dist/people/school-person-photo.service.js');

// Mocked boundary tests for the 0390 contact photo API. Authority, school scope, storage, the database metadata refusal
// and removal are proven against PostgreSQL by test-person-photo-integrity.mjs.
const JPEG = readFileSync(resolve(__dirname, 'fixtures', 'paper-page.jpg'));
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const req = { honIdentity: { externalSubject: 'subject-1' } };
const school = randomUUID(), person = randomUUID();
const withExif = (jpeg) => {
  const payload = Buffer.from('Exif\0\0GPS 34.05N 118.24W camera', 'latin1');
  const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, payload, jpeg.subarray(2)]);
};
function fakeDatabase(answer) {
  const calls = [];
  return { calls, async callSchoolPersonPhoto(operation, params) { calls.push({ operation, params }); return typeof answer === 'function' ? answer(operation, params) : answer; } };
}
const summary = (version = 1) => ({ personId: person, mediaType: 'image/jpeg', bytes: 10, checksum: 'a'.repeat(64), version, updatedAt: '2026-11-16T03:00:00.000Z' });

test('a photo is stripped of EXIF before it reaches the database, with the session subject and the exact key', async () => {
  const db = fakeDatabase({ photo: summary(), replaced: false, replayed: false });
  const service = new SchoolPersonPhotoService(db);
  const key = randomUUID();
  const result = await service.set(req, { schoolId: school, personId: person, expectedVersion: null, mediaType: 'image/jpeg', data: withExif(JPEG).toString('base64') }, key);
  assert.equal(result.photo.version, 1);
  assert.equal(db.calls.length, 1); assert.equal(db.calls[0].operation, 'set');
  const [subject, body, k] = db.calls[0].params;
  assert.equal(subject, 'subject-1'); assert.equal(k, key);
  const sent = JSON.parse(body);
  assert.deepEqual(Object.keys(sent).sort(), ['data', 'expectedVersion', 'mediaType', 'personId', 'schoolId']);
  const bytes = Buffer.from(sent.data, 'base64');
  assert.equal(bytes.includes(Buffer.from('GPS')), false, 'location metadata never reaches the database');
  assert.equal(bytes.includes(Buffer.from('Exif')), false);
});

test('bad bodies, keys, image types and sizes are refused before the database', async () => {
  const db = fakeDatabase(null);
  const service = new SchoolPersonPhotoService(db);
  const ok = { schoolId: school, personId: person, expectedVersion: null, mediaType: 'image/jpeg', data: JPEG.toString('base64') };
  await assert.rejects(service.set(req, ok, 'not-a-uuid'), status(400, 'PERSON_PHOTO_INVALID'));
  await assert.rejects(service.set(req, { ...ok, extra: 1 }, randomUUID()), status(400, 'PERSON_PHOTO_INVALID'));
  await assert.rejects(service.set(req, { ...ok, mediaType: 'image/gif' }, randomUUID()), status(400, 'PERSON_PHOTO_INVALID'));
  await assert.rejects(service.set(req, { ...ok, mediaType: 'image/png' }, randomUUID()), status(400, 'PERSON_PHOTO_IMAGE_REFUSED'));
  await assert.rejects(service.set(req, { ...ok, data: Buffer.from('<svg onload=alert(1)>').toString('base64') }, randomUUID()), status(400, 'PERSON_PHOTO_IMAGE_REFUSED'));
  await assert.rejects(service.set(req, { ...ok, data: Buffer.alloc(400_001, 1).toString('base64') }, randomUUID()), status(400, 'PERSON_PHOTO_IMAGE_REFUSED'));
  await assert.rejects(service.set(req, { ...ok, data: Buffer.alloc(400_004, 1).toString('base64') }, randomUUID()), status(400, 'PERSON_PHOTO_INVALID'));
  await assert.rejects(service.set(req, { ...ok, expectedVersion: 0 }, randomUUID()), status(400, 'PERSON_PHOTO_INVALID'));
  await assert.rejects(service.remove(req, { schoolId: school, personId: person }, randomUUID()), status(400, 'PERSON_PHOTO_INVALID'));
  await assert.rejects(service.read(req, 'x', person), status(400, 'PERSON_PHOTO_INVALID'));
  assert.equal(db.calls.length, 0);
});

test('database refusals map to exact answers and anything else is an unknown outcome', async () => {
  const cases = [['42501', 'PERSON_PHOTO_FORBIDDEN', 403], ['P0002', 'PERSON_PHOTO_NOT_FOUND', 404], ['40001', 'PERSON_PHOTO_VERSION_CONFLICT', 409],
    ['23505', 'PERSON_PHOTO_KEY_REUSED', 409], ['55P03', 'PERSON_PHOTO_BUSY', 503], ['22023', 'PERSON_PHOTO_IMAGE_REFUSED', 400], ['57014', 'canceling statement', 503]];
  for (const [code, message, http] of cases) {
    const service = new SchoolPersonPhotoService({ async callSchoolPersonPhoto() { throw Object.assign(new Error(message), { code }); } });
    await assert.rejects(service.remove(req, { schoolId: school, personId: person, expectedVersion: 1 }, randomUUID()),
      status(http, http === 503 && code === '57014' ? 'PERSON_PHOTO_UNAVAILABLE' : message));
  }
});

test('reads and receipts are verified: another person, an extra field or a malformed photo is not shown', async () => {
  const good = { personId: person, photo: { mediaType: 'image/jpeg', data: JPEG.toString('base64'), checksum: 'b'.repeat(64), version: 2, updatedAt: '2026-11-16T03:00:00.000Z' } };
  assert.equal((await new SchoolPersonPhotoService(fakeDatabase(good)).read(req, school, person)).photo.version, 2);
  assert.equal((await new SchoolPersonPhotoService(fakeDatabase({ personId: person, photo: null })).read(req, school, person)).photo, null);
  await assert.rejects(new SchoolPersonPhotoService(fakeDatabase({ ...good, personId: randomUUID() })).read(req, school, person), status(503, 'PERSON_PHOTO_UNAVAILABLE'));
  await assert.rejects(new SchoolPersonPhotoService(fakeDatabase({ ...good, extra: true })).read(req, school, person), /PERSON_PHOTO_RESPONSE_INVALID/);
  await assert.rejects(new SchoolPersonPhotoService(fakeDatabase({ personId: person, photo: { ...good.photo, checksum: 'x' } })).read(req, school, person), /PERSON_PHOTO_RESPONSE_INVALID/);
  const removed = await new SchoolPersonPhotoService(fakeDatabase({ personId: person, removed: true, replayed: true })).remove(req, { schoolId: school, personId: person, expectedVersion: 3 }, randomUUID());
  assert.equal(removed.replayed, true);
});
