const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const zlib = require('node:zlib');
const { MembershipAgreementService, familyPhotoClean, translateMembershipAgreementError } = require('../dist/membership-agreement/membership-agreement.service.js');
const { MembershipAgreementHumanGuard, FamilyMembershipAgreementSignGuard, FamilyPersonPhotoGuard } = require('../dist/membership-agreement/membership-agreement.controller.js');
const { MEMBERSHIP_AGREEMENT_HUMAN_COMMAND, FAMILY_MEMBERSHIP_AGREEMENT_SIGN_COMMAND, FAMILY_PERSON_PHOTO_COMMAND } = require('@hon/contracts');

// Mocked boundary tests for the 0463 membership agreement API. Authority, versions, the one-transaction signing with the
// face opt-in and parent photos are proven against PostgreSQL by test-membership-agreement-integrity.mjs.
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value, JSON.stringify(error.getResponse?.())); if (code) assert.equal(error.getResponse().code, code); return true; };
const req = { honIdentity: { externalSubject: 'subject-1' } };
const org = randomUUID(), school = randomUUID(), principal = randomUUID(), family = randomUUID();
const at = '2026-11-17T03:00:00.000Z', digest = 'a'.repeat(64);
function fakeDatabase(answer, { scope = { organizationId: org, schoolId: school, principalId: principal }, parents } = {}) {
  const calls = [], scopes = [];
  const client = context => ({ async query(sql, args) {
    if (/^SELECT set_config|^SET LOCAL/.test(sql)) return { rows: [] };
    calls.push({ context, sql, args });
    const data = typeof answer === 'function' ? answer(sql, args) : answer;
    if (data instanceof Error) throw data;
    return { rows: [{ data }] };
  } });
  return {
    calls, scopes,
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
  parts.push(chunk('IDAT', zlib.deflateSync(Buffer.from([0, 1, 2, 3]))), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
const child = randomUUID(), other = randomUUID(), version = randomUUID();
const signInput = { versionId: version, language: 'en', digest, signerName: 'Hana Park', eSignConsent: true, studentProfileIds: [child, other], faceOptIns: [{ studentProfileId: child, formId: 19, formDigest: 'b'.repeat(64) }] };
const consent = { consentId: randomUUID(), state: 'GIVEN', formId: 19, signerKind: 'GUARDIAN', method: 'PARENT_PORTAL', version: 1, signedAt: at, withdrawnAt: null };
const signed = (patch = {}) => ({ record: { signingId: randomUUID(), versionId: version, number: 1, language: 'en', digest, signedAt: at,
  children: [{ studentProfileId: child, signatureId: randomUUID(), faceConsent: consent }, { studentProfileId: other, signatureId: randomUUID(), faceConsent: null }], ...patch }, replayed: false });

test('each command header is its own: staff, parent signing and parent photo calls cannot replay as each other', () => {
  assert.deepEqual([MEMBERSHIP_AGREEMENT_HUMAN_COMMAND, FAMILY_MEMBERSHIP_AGREEMENT_SIGN_COMMAND, FAMILY_PERSON_PHOTO_COMMAND],
    ['membership-agreement', 'family-membership-agreement-sign', 'family-person-photo']);
  for (const Guard of [MembershipAgreementHumanGuard, FamilyMembershipAgreementSignGuard, FamilyPersonPhotoGuard]) assert.equal(typeof new Guard().canActivate, 'function');
});

test('staff calls resolve membership.agreement.manage for the selected school and never send the school to SQL', async () => {
  const db = fakeDatabase({ record: { language: 'en', title: 'Agreement', body: 'Text', version: 1, updatedAt: at }, replayed: false });
  const out = await new MembershipAgreementService(db).saveDraft(req, { schoolId: school, language: 'en', title: 'Agreement', body: 'Text', expectedVersion: 0 }, randomUUID());
  assert.equal(out.draft.version, 1);
  assert.deepEqual(db.scopes.map(s => s.permission), ['membership.agreement.manage']);
  assert.match(db.calls[0].sql, /hon\.save_membership_agreement_draft/);
  assert.deepEqual(Object.keys(JSON.parse(db.calls[0].args[1])).sort(), ['body', 'expectedVersion', 'language', 'title']);
  await assert.rejects(new MembershipAgreementService(fakeDatabase({}, { scope: null })).saveDraft(req, { schoolId: school, language: 'en', title: 'A', body: 'B', expectedVersion: 0 }, randomUUID()), status(403, 'MEMBERSHIP_AGREEMENT_FORBIDDEN'));
  await assert.rejects(new MembershipAgreementService(db).saveDraft(req, { schoolId: school, language: 'en', title: 'A', body: 'B', expectedVersion: 0, extra: 1 }, randomUUID()), status(400, 'MEMBERSHIP_AGREEMENT_INVALID'));
  await assert.rejects(new MembershipAgreementService(db).saveDraft(req, { schoolId: school, language: 'en', title: 'A', body: 'B', expectedVersion: 0 }, 'not-a-key'), status(400, 'MEMBERSHIP_AGREEMENT_INVALID'));
});

test('publish needs English and the school taking responsibility for its wording; the reply must match the request', async () => {
  const reply = { record: { versionId: version, number: 1, publishedAt: at, texts: [{ language: 'en', digest }] }, replayed: false };
  const svc = new MembershipAgreementService(fakeDatabase(reply));
  assert.equal((await svc.publish(req, { schoolId: school, expectedNumber: 0, drafts: [{ language: 'en', version: 2 }], schoolResponsible: true }, randomUUID())).number, 1);
  for (const bad of [{ drafts: [{ language: 'ko', version: 1 }], schoolResponsible: true }, { drafts: [{ language: 'en', version: 1 }], schoolResponsible: false },
    { drafts: [{ language: 'en', version: 1 }, { language: 'en', version: 2 }], schoolResponsible: true }])
    await assert.rejects(svc.publish(req, { schoolId: school, expectedNumber: 0, ...bad }, randomUUID()), status(400, 'MEMBERSHIP_AGREEMENT_INVALID'));
  await assert.rejects(svc.publish(req, { schoolId: school, expectedNumber: 0, drafts: [{ language: 'en', version: 2 }, { language: 'ko', version: 1 }], schoolResponsible: true }, randomUUID()), status(503, 'MEMBERSHIP_AGREEMENT_UNAVAILABLE'));
});

test('a signing reply that does not cover exactly the children and face boxes asked for is never shown as saved', async () => {
  const subject = 'subject-1';
  assert.equal((await new MembershipAgreementService(fakeDatabase(signed())).familySign(subject, signInput, randomUUID())).children.length, 2);
  await assert.rejects(new MembershipAgreementService(fakeDatabase(signed({ children: [signed().record.children[0]] }))).familySign(subject, signInput, randomUUID()), status(503));
  const noFace = signed(); noFace.record.children[0].faceConsent = null;
  await assert.rejects(new MembershipAgreementService(fakeDatabase(noFace)).familySign(subject, signInput, randomUUID()), status(503));
  await assert.rejects(new MembershipAgreementService(fakeDatabase(signed({ digest: 'c'.repeat(64) }))).familySign(subject, signInput, randomUUID()), status(503));
  for (const bad of [{ eSignConsent: false }, { signerName: ' Hana' }, { faceOptIns: [{ studentProfileId: randomUUID(), formId: 19, formDigest: digest }] }, { studentProfileIds: [] }, { studentProfileIds: [child, child] }])
    await assert.rejects(new MembershipAgreementService(fakeDatabase(signed())).familySign(subject, { ...signInput, ...bad }, randomUUID()), status(400, 'MEMBERSHIP_AGREEMENT_INVALID'));
  await assert.rejects(new MembershipAgreementService(fakeDatabase(signed(), { parents: [] })).familySign(subject, signInput, randomUUID()), status(403, 'MEMBERSHIP_AGREEMENT_FORBIDDEN'));
});

test('parent photos are stripped of metadata before the database sees them; wrong types and oversize images are refused', async () => {
  const tagged = png('GPS 41.88,-87.63');
  const clean = Buffer.from(familyPhotoClean('image/png', tagged.toString('base64')), 'base64');
  assert(!clean.includes(Buffer.from('GPS')));
  assert.throws(() => familyPhotoClean('image/jpeg', tagged.toString('base64')), status(400, 'MEMBERSHIP_AGREEMENT_IMAGE_REFUSED'));
  assert.throws(() => familyPhotoClean('image/png', Buffer.alloc(400_001).toString('base64')), status(400, 'MEMBERSHIP_AGREEMENT_IMAGE_REFUSED'));
  const db = fakeDatabase({ record: { studentProfileId: child, photo: { mediaType: 'image/png', bytes: clean.length, version: 1, updatedAt: at }, replaced: false, templatesDeleted: 0 }, replayed: false });
  await new MembershipAgreementService(db).familyPhotoSet('subject-1', { studentProfileId: child, expectedVersion: null, mediaType: 'image/png', data: tagged.toString('base64') }, randomUUID());
  assert.equal(JSON.parse(db.calls[0].args[1]).data, clean.toString('base64'));
});

test('database refusals map to stable codes; unknown failures are UNKNOWN_OR_RETRY_REQUIRED', () => {
  assert.throws(() => translateMembershipAgreementError(pgError('MEMBERSHIP_AGREEMENT_CHANGED', '40001')), status(409, 'MEMBERSHIP_AGREEMENT_CHANGED'));
  assert.throws(() => translateMembershipAgreementError(pgError('FACE_CHECKIN_OFF', '42501')), status(403, 'FACE_CHECKIN_OFF'));
  assert.throws(() => translateMembershipAgreementError(pgError('FACE_CHECKIN_ADULT_SIGNS', '22023')), status(400, 'MEMBERSHIP_AGREEMENT_ADULT_SIGNS'));
  assert.throws(() => translateMembershipAgreementError(pgError('FACE_CHECKIN_FORBIDDEN', '42501')), status(403, 'MEMBERSHIP_AGREEMENT_FORBIDDEN'));
  assert.throws(() => translateMembershipAgreementError(pgError('MEMBERSHIP_AGREEMENT_BUSY', '55P03')), status(503, 'MEMBERSHIP_AGREEMENT_BUSY'));
  assert.throws(() => translateMembershipAgreementError(pgError('anything', 'XX000')), e => e.getStatus() === 503 && e.getResponse().outcome === 'UNKNOWN_OR_RETRY_REQUIRED');
});
