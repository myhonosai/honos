const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { AttendanceCardsService, newAttendanceCardCode, attendanceCardDigest } = require('../dist/schedule/attendance-cards.service.js');
const { isAttendanceCardCode, normalizeAttendanceCardCode, attendanceCardCheckDigits } = require('@hon/contracts');

// Mocked boundary tests for the 0394 card and scan API. Authority, school scope, card replacement and the attendance
// write are proven against PostgreSQL by test-attendance-cards-integrity.mjs.
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const req = { honIdentity: { externalSubject: 'subject-1' } };
const org = randomUUID(), school = randomUUID(), principal = randomUUID();
const at = '2026-11-16T03:00:00.000Z';
function fakeDatabase(answer, scope = { organizationId: org, schoolId: school, principalId: principal }) {
  const calls = [], scopes = [];
  return {
    calls, scopes,
    async resolveAuthorizedScope(subject, schoolId, permission) { scopes.push({ subject, schoolId, permission }); return scope; },
    async withTenantTransaction(context, work) {
      const client = { async query(sql, args) { if (/^SELECT set_config|^SET LOCAL/.test(sql)) return { rows: [] }; calls.push({ context, sql, args }); return { rows: [{ data: typeof answer === 'function' ? answer(sql, args) : answer }] }; } };
      return work(client);
    },
  };
}
const card = (studentProfileId, last4, status = 'ACTIVE') => ({ cardId: randomUUID(), studentProfileId, last4, status, version: status === 'ACTIVE' ? 1 : 2, issuedAt: at, endedAt: status === 'ACTIVE' ? null : at });

test('card codes are 26 digits with mod 97 check digits; one wrong digit is refused', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const c = newAttendanceCardCode(); assert.match(c, /^\d{26}$/); assert(isAttendanceCardCode(c)); seen.add(c); }
  assert.equal(seen.size, 200);
  const c = newAttendanceCardCode();
  for (let i = 0; i < 26; i++) { const d = (Number(c[i]) + 1) % 10; assert.equal(isAttendanceCardCode(c.slice(0, i) + d + c.slice(i + 1)), false); }
  assert.equal(normalizeAttendanceCardCode(c.replace(/(\d{4})/g, '$1 ')), c);
  assert.equal(normalizeAttendanceCardCode('https://example.invalid/' + c), null);
  assert.equal(attendanceCardCheckDigits('000000000000000000000000').length, 2);
  assert.equal(attendanceCardDigest(c), createHash('sha256').update(c).digest('hex'));
});

test('a print sends only digests and last four digits, and returns each code once', async () => {
  const a = randomUUID(), b = randomUUID();
  const db = fakeDatabase((sql, args) => {
    const sent = JSON.parse(args[1]);
    return { record: { printId: randomUUID(), replaced: 0, cards: sent.cards.map(x => ({ ...card(x.studentProfileId, x.last4), printPhoto: false })) }, replayed: false };
  });
  const key = randomUUID();
  const out = await new AttendanceCardsService(db).issue(req, { schoolId: school, studentProfileIds: [a, b] }, key);
  assert.equal(db.scopes[0].permission, 'attendance.cards.manage');
  const [subject, body, k] = db.calls[0].args;
  assert.equal(subject, 'subject-1'); assert.equal(k, key);
  const sent = JSON.parse(body);
  assert.deepEqual(Object.keys(sent), ['cards']);
  for (const x of sent.cards) { assert.deepEqual(Object.keys(x).sort(), ['codeDigest', 'last4', 'studentProfileId']); assert.match(x.codeDigest, /^[0-9a-f]{64}$/); }
  assert.equal(out.cards.length, 2); assert(out.cards.every(c => c.printPhoto === false));
  for (const c of out.cards) {
    assert(isAttendanceCardCode(c.code)); assert.equal(c.code.slice(-4), c.last4);
    assert.equal(body.includes(c.code), false, 'the code itself never reaches the database');
    assert.equal(sent.cards.find(x => x.studentProfileId === c.studentProfileId).codeDigest, attendanceCardDigest(c.code));
  }
});

test('a replayed print has no codes', async () => {
  const a = randomUUID();
  const db = fakeDatabase({ record: { printId: randomUUID(), replaced: 1, cards: [{ ...card(a, '1234'), printPhoto: true }] }, replayed: true });
  const out = await new AttendanceCardsService(db).issue(req, { schoolId: school, studentProfileIds: [a] }, randomUUID());
  assert.equal(out.replayed, true); assert.equal(out.cards[0].code, null); assert.equal(out.cards[0].printPhoto, true);
});

test('photo consent: closed input with attendance.cards.manage scope, checked reply, withdraw-before-given never reaches the database', async () => {
  const a = randomUUID();
  const db = fakeDatabase({ record: { studentProfileId: a, photoConsent: 'GIVEN', photoConsentVersion: 1, recordedAt: '2026-11-16T05:00:00.000Z' }, replayed: false });
  const service = new AttendanceCardsService(db);
  await assert.rejects(service.photoConsent(req, { schoolId: school, studentProfileId: a, given: false, expectedVersion: 0 }, randomUUID()), status(400, 'ATTENDANCE_CARDS_INVALID'));
  await assert.rejects(service.photoConsent(req, { schoolId: school, studentProfileId: a, given: true, expectedVersion: 0, name: 'x' }, randomUUID()), status(400, 'ATTENDANCE_CARDS_INVALID'));
  assert.equal(db.calls.length, 0);
  const out = await service.photoConsent(req, { schoolId: school, studentProfileId: a, given: true, expectedVersion: 0 }, randomUUID());
  assert.equal(db.scopes[0].permission, 'attendance.cards.manage');
  assert.match(db.calls[0].sql, /hon\.set_student_photo_consent/);
  assert.deepEqual(JSON.parse(db.calls[0].args[1]), { studentProfileId: a, given: true, expectedVersion: 0 });
  assert.equal(out.photoConsent, 'GIVEN'); assert.equal(out.replayed, false);
});

test('card look: parent photo approval is a required closed field, and the reply must agree with the school rule', async () => {
  const saved = (approval, rule) => ({ record: { codeType: 'QR', showPhoto: true, showLogo: true, design: 'CLASSIC', photoApprovalRequired: approval, version: 1, updatedAt: at,
    schoolName: 'Synthetic Dojo', logoUrl: null, accentColor: null, photoConsent: rule }, replayed: false });
  const look = { schoolId: school, expectedVersion: 0, codeType: 'QR', showPhoto: true, showLogo: true, design: 'CLASSIC' };
  let db = fakeDatabase(saved(true, { required: true, profile: null, reason: 'SCHOOL_POLICY' }));
  let service = new AttendanceCardsService(db);
  await assert.rejects(service.configure(req, look, randomUUID()), status(400, 'ATTENDANCE_CARDS_INVALID'));
  assert.equal(db.calls.length, 0);
  const out = await service.configure(req, { ...look, photoApprovalRequired: true }, randomUUID());
  assert.deepEqual(JSON.parse(db.calls[0].args[1]), { expectedVersion: 0, codeType: 'QR', showPhoto: true, showLogo: true, design: 'CLASSIC', photoApprovalRequired: true });
  assert.equal(out.settings.photoConsent.required, true);
  for (const rule of [{ required: false, profile: null, reason: 'OFF' }, { required: true, profile: 'EU_GDPR', reason: 'PROFILE' }]) {
    service = new AttendanceCardsService(fakeDatabase(saved(true, rule)));
    await assert.rejects(service.configure(req, { ...look, photoApprovalRequired: true }, randomUUID()), status(503));
  }
});

test('a scan with wrong check digits never reaches the database; a good one sends only the digest with attendance.record scope', async () => {
  const db = fakeDatabase({ outcome: 'NOT_RECOGNIZED', student: null, card: null, attendance: null });
  const service = new AttendanceCardsService(db);
  const code = newAttendanceCardCode(), session = randomUUID();
  const bad = code.slice(0, 25) + String((Number(code[25]) + 1) % 10);
  await assert.rejects(service.checkIn(req, { schoolId: school, sessionId: session, code: bad, status: 'PRESENT' }, randomUUID()), status(400, 'ATTENDANCE_CARDS_INVALID'));
  assert.equal(db.calls.length, 0); assert.equal(db.scopes.length, 0);
  const out = await service.checkIn(req, { schoolId: school, sessionId: session, code, status: 'LATE' }, randomUUID());
  assert.equal(out.outcome, 'NOT_RECOGNIZED');
  assert.equal(db.scopes[0].permission, 'attendance.record');
  const [, s, body] = db.calls[0].args;
  assert.equal(s, session);
  assert.deepEqual(JSON.parse(body), { codeDigest: attendanceCardDigest(code), status: 'LATE' });
});

test('no scope for the named school is refused before the database is asked', async () => {
  const db = fakeDatabase({}, null);
  await assert.rejects(new AttendanceCardsService(db).read(req, school), status(403, 'ATTENDANCE_CARDS_FORBIDDEN'));
  assert.equal(db.calls.length, 0);
  await assert.rejects(new AttendanceCardsService(db).read(req, 'not-a-school'), status(400, 'ATTENDANCE_CARDS_INVALID'));
});

test('database refusals map to exact answers; anything else is unknown', async () => {
  const fail = (code, message) => { const e = new Error(message); e.code = code; return e; };
  const cases = [[fail('42501', 'ATTENDANCE_CARDS_FORBIDDEN'), 403, 'ATTENDANCE_CARDS_FORBIDDEN'], [fail('40001', 'VERSION_CONFLICT'), 409, 'ATTENDANCE_CARD_VERSION_CONFLICT'],
    [fail('23505', 'IDEMPOTENCY_KEY_REUSED'), 409, 'ATTENDANCE_CARD_KEY_REUSED'], [fail('55P03', 'ATTENDANCE_CARDS_BUSY'), 503, 'ATTENDANCE_CARDS_BUSY'],
    [fail('23505', 'ATTENDANCE_CARD_CODE_TAKEN'), 503, 'ATTENDANCE_CARDS_BUSY'], [fail('P0002', 'ATTENDANCE_CARD_NOT_FOUND'), 404, 'ATTENDANCE_CARD_NOT_FOUND'],
    [fail('XX000', 'boom'), 503, 'ATTENDANCE_CARDS_UNAVAILABLE']];
  for (const [error, code, name] of cases) {
    const db = fakeDatabase(() => { throw error; });
    await assert.rejects(new AttendanceCardsService(db).revoke(req, { schoolId: school, cardId: randomUUID(), expectedVersion: 1 }, randomUUID()), status(code, name));
  }
  await assert.rejects(new AttendanceCardsService(fakeDatabase({})).revoke(req, { schoolId: school, cardId: randomUUID(), expectedVersion: 1 }, 'not-a-key'), status(400));
});
