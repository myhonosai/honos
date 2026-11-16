const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const zlib = require('node:zlib');
const { FaceCheckInService, faceCheckInPictureDigest, translateFaceCheckInError } = require('../dist/face-checkin/face-checkin.service.js');
const { FaceCheckInHumanGuard, FaceCheckInScanHumanGuard, FamilyFaceCheckInSignGuard, FamilyFaceCheckInWithdrawGuard } = require('../dist/face-checkin/face-checkin.controller.js');
const { FACE_CHECKIN_HUMAN_COMMAND, FACE_CHECKIN_SCAN_COMMAND, FAMILY_FACE_CHECKIN_COMMAND, FAMILY_FACE_CHECKIN_WITHDRAW_COMMAND } = require('@hon/contracts');

// Mocked boundary tests for the 0409 face check-in API. Authority, consent, templates, matching, retention and the
// attendance write are proven against PostgreSQL by test-face-checkin-integrity.mjs.
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value, JSON.stringify(error.getResponse?.())); if (code) assert.equal(error.getResponse().code, code); return true; };
const req = { honIdentity: { externalSubject: 'subject-1' } };
const org = randomUUID(), school = randomUUID(), principal = randomUUID(), family = randomUUID();
const at = '2026-11-16T03:00:00.000Z';
function fakeDatabase(answer, { scope = { organizationId: org, schoolId: school, principalId: principal }, parents } = {}) {
  const calls = [], scopes = [], settings = [];
  const client = context => ({ async query(sql, args) {
    if (/^SELECT set_config|^SET LOCAL/.test(sql)) { settings.push({ sql, args }); return { rows: [] }; }
    calls.push({ context, sql, args });
    const data = typeof answer === 'function' ? answer(sql, args) : answer;
    if (data instanceof Error) throw data;
    return { rows: [{ data }] };
  } });
  return {
    calls, scopes, settings,
    async resolveAuthorizedScope(subject, schoolId, permission) { scopes.push({ subject, schoolId, permission }); return scope; },
    async resolveParentJourneyScopes() { return parents ?? [{ organizationId: org, schoolId: school, principalId: principal, familyId: family, accessLevel: 'PRIMARY_GUARDIAN' }]; },
    async withTenantTransaction(context, work) { return work(client(context)); },
    async withTenantReadOnlyTransaction(context, work) { return work(client({ ...context, readOnly: true })); },
  };
}
const pgError = (message, code) => Object.assign(new Error(message), { code });
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function png(text) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (text) parts.push(chunk('tEXt', Buffer.from('Comment\0' + text, 'latin1')));
  parts.push(chunk('IDAT', zlib.deflateSync(Buffer.from([0, 10, 20, 30]))), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
const consent = (state = 'GIVEN') => ({ consentId: randomUUID(), state, formId: 19, signerKind: 'GUARDIAN', method: 'PARENT_PORTAL', version: state === 'WITHDRAWN' ? 2 : 1, signedAt: at, withdrawnAt: state === 'WITHDRAWN' ? at : null });

test('a camera picture is stripped of metadata before hashing, and only the digest is sent', async () => {
  const clean = png(), tagged = png('home address 1 Example St');
  assert.equal(faceCheckInPictureDigest('image/png', tagged.toString('base64')), createHash('sha256').update(clean).digest('hex'));
  assert.throws(() => faceCheckInPictureDigest('image/jpeg', clean.toString('base64')), status(400, 'FACE_CHECKIN_IMAGE_REFUSED'));
  assert.throws(() => faceCheckInPictureDigest('image/png', 'AAAA'), status(400, 'FACE_CHECKIN_IMAGE_REFUSED'));
  const session = randomUUID(), key = randomUUID();
  const db = fakeDatabase((sql, args) => ({ record: { matchId: randomUUID(), sessionId: args[1], outcome: 'NO_MATCH', student: null, proposedAt: at }, replayed: false }));
  const out = await new FaceCheckInService(db).match(req, { schoolId: school, sessionId: session, mediaType: 'image/png', data: tagged.toString('base64') }, key);
  assert.equal(out.outcome, 'NO_MATCH');
  assert.equal(db.scopes[0].permission, 'attendance.record');
  const [subject, sentSession, body, k] = db.calls[0].args;
  assert.equal(subject, 'subject-1'); assert.equal(sentSession, session); assert.equal(k, key);
  assert.deepEqual(JSON.parse(body), { pictureDigest: createHash('sha256').update(clean).digest('hex') });
  assert.equal(JSON.stringify(db.calls).includes(tagged.toString('base64')), false, 'the picture never reaches the database');
});

test('managing needs face_checkin.manage at the named school; scanning needs attendance.record', async () => {
  const db = fakeDatabase({ record: { studentProfileId: randomUUID(), outcome: 'ENROLLED', enrolledAt: at, matcher: 'SYNTHETIC' }, replayed: false });
  const svc = new FaceCheckInService(db);
  await assert.rejects(svc.enroll(req, { schoolId: school, studentProfileId: randomUUID() }, randomUUID()), status(503, 'FACE_CHECKIN_UNAVAILABLE'), 'a different student in the answer is refused');
  assert.equal(db.scopes[0].permission, 'face_checkin.manage');
  const other = fakeDatabase({}, { scope: { organizationId: org, schoolId: randomUUID(), principalId: principal } });
  await assert.rejects(new FaceCheckInService(other).read(req, school), status(403, 'FACE_CHECKIN_FORBIDDEN'));
  assert.equal(other.calls.length, 0);
  const none = fakeDatabase({}, { scope: null });
  await assert.rejects(new FaceCheckInService(none).confirm(req, { schoolId: school, matchId: randomUUID(), accept: true, status: 'PRESENT' }, randomUUID()), status(403));
  assert.equal(none.scopes[0].permission, 'attendance.record');
  await assert.rejects(new FaceCheckInService(db).read({}, school), status(403));
});

test('inputs are closed and an idempotency key is a UUID', async () => {
  const db = fakeDatabase({});
  const svc = new FaceCheckInService(db);
  await assert.rejects(svc.saveSettings(req, { schoolId: school, expectedVersion: 0, enabled: true, cityLimits: null, acknowledgements: [] }, 'not-a-uuid'), status(400, 'FACE_CHECKIN_INVALID'));
  await assert.rejects(svc.saveSettings(req, { schoolId: school, expectedVersion: 0, enabled: false, cityLimits: 'NYC', acknowledgements: [] }, randomUUID()), status(400));
  await assert.rejects(svc.recordConsent(req, { schoolId: school, studentProfileId: randomUUID(), formId: 1, formDigest: 'a'.repeat(64), signerKind: 'GUARDIAN', signerName: 'Pat Example', witnessAttested: false }, randomUUID()), status(400));
  await assert.rejects(svc.recordConsent(req, { schoolId: school, studentProfileId: randomUUID(), formId: 1, formDigest: 'a'.repeat(64), signerKind: 'GUARDIAN', signerName: '<b>x</b>', witnessAttested: true }, randomUUID()), status(400));
  await assert.rejects(svc.enroll(req, { schoolId: school, studentProfileId: randomUUID(), extra: 1 }, randomUUID()), status(400));
  await assert.rejects(svc.familySign('subject-1', { studentProfileId: randomUUID(), formId: 1, formDigest: 'a'.repeat(64), signerName: 'Pat Example', schoolId: school }, randomUUID()), status(400));
  assert.equal(db.calls.length, 0);
});

test('settings send everything except the school selector', async () => {
  const db = fakeDatabase({ record: { status: 'ON', profile: 'US_IL', cityLimits: null, acknowledgements: ['ALTERNATIVE_CHECK_IN_OFFERED', 'RETENTION_POLICY_PUBLISHED'], offReason: null, version: 1, updatedAt: at, templatesDeleted: 0 }, replayed: false });
  const out = await new FaceCheckInService(db).saveSettings(req, { schoolId: school, expectedVersion: 0, enabled: true, cityLimits: null, acknowledgements: ['ALTERNATIVE_CHECK_IN_OFFERED', 'RETENTION_POLICY_PUBLISHED'] }, randomUUID());
  assert.equal(out.settings.profile, 'US_IL'); assert.equal(out.templatesDeleted, 0);
  assert.deepEqual(Object.keys(JSON.parse(db.calls[0].args[1])).sort(), ['acknowledgements', 'cityLimits', 'enabled', 'expectedVersion']);
  assert.match(db.calls[0].sql, /hon\.save_face_checkin_settings/);
  assert.equal(db.calls[0].args[3], db.calls[0].context.requestId);
});

test('a confirmation that disagrees with what was asked is not trusted', async () => {
  const match = randomUUID();
  const db = fakeDatabase({ record: { matchId: match, sessionId: randomUUID(), studentProfileId: randomUUID(), outcome: 'REJECTED', checkIn: null }, replayed: false });
  await assert.rejects(new FaceCheckInService(db).confirm(req, { schoolId: school, matchId: match, accept: true, status: 'PRESENT' }, randomUUID()), status(503));
  const ok = await new FaceCheckInService(db).confirm(req, { schoolId: school, matchId: match, accept: false, status: 'PRESENT' }, randomUUID());
  assert.equal(ok.outcome, 'REJECTED');
});

test('parents: one live family grant decides the tenant; read is read-only', async () => {
  const db = fakeDatabase({ program: 'CLOSED', schoolStatus: 'OFF', canSign: false, canWithdraw: true, forms: [], children: [{ studentProfileId: randomUUID(), givenName: 'Sam', familyName: 'Example', consent: consent('WITHDRAWN'), enrolled: false }] });
  const svc = new FaceCheckInService(db);
  const out = await svc.familyRead('subject-1');
  assert.equal(out.children.length, 1);
  assert.equal(db.calls[0].context.readOnly, true);
  assert.equal(db.calls[0].context.schoolId, school);
  assert.deepEqual(db.calls[0].args, ['subject-1']);
  await assert.rejects(new FaceCheckInService(fakeDatabase({}, { parents: [] })).familyRead('subject-1'), status(403));
  const two = [1, 2].map(() => ({ organizationId: org, schoolId: randomUUID(), principalId: principal, familyId: family, accessLevel: 'PRIMARY_GUARDIAN' }));
  await assert.rejects(new FaceCheckInService(fakeDatabase({}, { parents: two })).familyRead('subject-1'), status(403));
  await assert.rejects(svc.familyRead(' subject-1'), status(403));
});

test('a parent signature and withdrawal are checked against the answer', async () => {
  const student = randomUUID(), c = consent();
  const db = fakeDatabase((sql) => ({ record: { studentProfileId: student, consent: /withdraw/.test(sql) ? { ...c, state: 'WITHDRAWN', version: 2, withdrawnAt: at } : c }, replayed: false }));
  const svc = new FaceCheckInService(db);
  const signed = await svc.familySign('subject-1', { studentProfileId: student, formId: 19, formDigest: 'b'.repeat(64), signerName: 'Pat Example' }, randomUUID());
  assert.equal(signed.consent.state, 'GIVEN');
  assert.match(db.calls[0].sql, /hon\.sign_family_face_checkin_consent/);
  await assert.rejects(svc.familySign('subject-1', { studentProfileId: randomUUID(), formId: 19, formDigest: 'b'.repeat(64), signerName: 'Pat Example' }, randomUUID()), status(503));
  const gone = await svc.familyWithdraw('subject-1', { consentId: c.consentId, expectedVersion: 1 }, randomUUID());
  assert.equal(gone.consent.state, 'WITHDRAWN');
  await assert.rejects(svc.familyWithdraw('subject-1', { consentId: randomUUID(), expectedVersion: 1 }, randomUUID()), status(503));
});

test('database refusals become specific answers; anything unknown is UNKNOWN_OR_RETRY_REQUIRED', () => {
  const cases = [
    ['FACE_CHECKIN_CLOSED', '42501', 403], ['FACE_CHECKIN_OFF', '42501', 403], ['FACE_CHECKIN_NOT_AVAILABLE', '42501', 403],
    ['FACE_CHECKIN_CITY_LIMITS_REQUIRED', '22023', 400], ['FACE_CHECKIN_ACKNOWLEDGEMENTS_REQUIRED', '22023', 400], ['FACE_CHECKIN_GUARDIAN_REQUIRED', '22023', 400],
    ['FACE_CHECKIN_FORM_CHANGED', '40001', 409], ['FACE_CHECKIN_CONSENT_EXISTS', '40001', 409], ['VERSION_CONFLICT', '40001', 409, 'FACE_CHECKIN_VERSION_CONFLICT'],
    ['IDEMPOTENCY_KEY_REUSED', '23505', 409, 'FACE_CHECKIN_KEY_REUSED'], ['FACE_TEMPLATE_DUPLICATE', '23505', 409], ['FACE_CHECKIN_BUSY', '55P03', 503],
    ['FACE_CHECKIN_MATCH_NOT_FOUND', 'P0002', 404], ['SESSION_NOT_FOUND', 'P0002', 404, 'FACE_CHECKIN_SESSION_NOT_FOUND'],
    ['HUMAN_COMMAND_REQUIRED', '42501', 403, 'FACE_CHECKIN_FORBIDDEN'], ['ATTENDANCE_FORBIDDEN', '42501', 403, 'FACE_CHECKIN_FORBIDDEN'],
  ];
  for (const [message, code, http, out] of cases) assert.throws(() => translateFaceCheckInError(pgError(message, code)), status(http, out ?? message), message);
  assert.throws(() => translateFaceCheckInError(pgError('FACE_CHECKIN_CLOSED', 'XX000')), status(503, 'FACE_CHECKIN_UNAVAILABLE'), 'a known message with an unexpected state is not trusted');
  assert.throws(() => translateFaceCheckInError(new Error('boom')), e => e.getStatus() === 503 && e.getResponse().outcome === 'UNKNOWN_OR_RETRY_REQUIRED');
});

test('each route family has its own command header', () => {
  assert.notEqual(FACE_CHECKIN_HUMAN_COMMAND, FACE_CHECKIN_SCAN_COMMAND);
  assert.notEqual(FAMILY_FACE_CHECKIN_COMMAND, FAMILY_FACE_CHECKIN_WITHDRAW_COMMAND);
  assert.equal(new FamilyFaceCheckInSignGuard().command, FAMILY_FACE_CHECKIN_COMMAND);
  assert.equal(new FamilyFaceCheckInWithdrawGuard().command, FAMILY_FACE_CHECKIN_WITHDRAW_COMMAND);
  const ctx = (headers, method = 'POST') => {
    const res = { setHeader() {} };
    return { switchToHttp: () => ({ getRequest: () => ({ method, headers, query: {}, originalUrl: '/x' }), getResponse: () => res }) };
  };
  const prior = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://app.example.test';
  try {
    const h = { origin: 'https://app.example.test', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'content-type': 'application/json', 'x-hon-human-command': FACE_CHECKIN_HUMAN_COMMAND };
    assert.throws(() => new FaceCheckInScanHumanGuard().canActivate(ctx(h)), status(403, 'HUMAN_UI_REQUIRED'));
    assert.throws(() => new FaceCheckInHumanGuard().canActivate(ctx({ ...h, 'x-hon-human-command': FACE_CHECKIN_SCAN_COMMAND })), status(403, 'HUMAN_UI_REQUIRED'));
  } finally { if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});
