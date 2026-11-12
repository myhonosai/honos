const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { CreativeStudioAvatarPhotosController } = require('../dist/creative-studio/creative-studio-avatars.controller.js');
const { CreativeStudioService } = require('../dist/creative-studio/creative-studio.service.js');
const { SyntheticCreativeProviderRuntime } = require('../dist/creative-studio/creative-provider-runtime.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { stripPhotoMetadata, PhotoMetadataError } = require('../dist/creative-studio/photo-metadata.js');
const contracts = require('@hon/contracts');

// Creative Studio photo avatars (A3, migration 0305): an adult staff member's own photo with signed likeness consent.
const U = () => randomUUID(), T = '2026-11-12T12:00:00.000Z';
const seg = (marker, body) => { const b = Buffer.from(body); const h = Buffer.alloc(4); h[0] = 0xff; h[1] = marker; h.writeUInt16BE(b.length + 2, 2); return Buffer.concat([h, b]); };
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
  seg(0xe1, Buffer.from('Exif\0\0GPS-SECRET', 'latin1')), seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01colour', 'latin1')), seg(0xed, Buffer.from('Photoshop IPTC-SECRET', 'latin1')),
  seg(0xfe, Buffer.from('COMMENT-SECRET', 'latin1')), seg(0xdb, Buffer.alloc(65, 7)), seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
  Buffer.from('scan-data-'.repeat(8), 'latin1'), Buffer.from([0xff, 0xd9])]);
const chunk = (type, data) => { const d = Buffer.from(data); const h = Buffer.alloc(8); h.writeUInt32BE(d.length, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, d, Buffer.alloc(4, 9)]); };
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13, 1)), chunk('eXIf', 'GPS-SECRET'),
  chunk('tEXt', 'Comment\0TEXT-SECRET'), chunk('iTXt', 'XML:com.adobe.xmp\0XMP-SECRET'), chunk('IDAT', 'pixels-'.repeat(8)), chunk('IEND', '')]);
const riff = (type, data) => { const d = Buffer.from(data); const h = Buffer.alloc(8); h.write(type, 0, 'latin1'); h.writeUInt32LE(d.length, 4); return Buffer.concat([h, d, d.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
const webp = () => { const body = Buffer.concat([riff('VP8X', Buffer.from([0x0c, 0, 0, 0, 9, 0, 0, 9, 0, 0])), riff('VP8L', 'pixels-'.repeat(8)), riff('EXIF', 'GPS-SECRET'), riff('XMP ', 'XMP-SECRET')]);
  const h = Buffer.alloc(12); h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(body.length + 4, 4); h.write('WEBP', 8, 'latin1'); return Buffer.concat([h, body]); };
const SECRETS = /GPS-SECRET|COMMENT-SECRET|IPTC-SECRET|TEXT-SECRET|XMP-SECRET/;
const consent = (patch = {}) => ({ consentVersion: 'HON-LIKENESS-2026-11-12', ownLikeness: true, adult: true, marketingUse: true, signatureName: 'Jordan Lee',
  contentType: 'image/jpeg', photo: jpeg().toString('base64'), ...patch });
const view = (school, patch = {}) => ({ consentId: U(), schoolId: school, mine: true, signatureName: 'Jordan Lee', consentVersion: 'HON-LIKENESS-2026-11-12', contentType: 'image/jpeg',
  byteSize: 200, status: 'ACTIVE', withdrawnReason: null, withdrawnAt: null, avatarIds: [], createdAt: T, ...patch });

test('A3 consent is closed: the three attestations must be true, the wording version current, a typed name, an image type and 64 B..1 MiB of base64', () => {
  assert.deepEqual(contracts.validateCreativePhotoUploadInput(consent()), consent());
  assert.equal(contracts.CREATIVE_PHOTO_CONSENT_VERSION, 'HON-LIKENESS-2026-11-12');
  assert.deepEqual([contracts.SAAS_COMMANDS.uploadCreativeAvatarPhoto, contracts.SAAS_COMMANDS.deleteCreativeAvatarPhoto, contracts.SAAS_COMMANDS.createCreativePhotoAvatar],
    ['saas-creative-avatar-photo-upload', 'saas-creative-avatar-photo-delete', 'saas-creative-photo-avatar-create']);
  for (const bad of [consent({ adult: false }), consent({ ownLikeness: 'yes' }), consent({ marketingUse: false }), consent({ consentVersion: 'v0' }), consent({ signatureName: 'J' }),
    consent({ signatureName: 'x'.repeat(81) }), consent({ signatureName: 'Line\nbreak' }), consent({ contentType: 'image/gif' }), consent({ photo: 'abc' }),
    consent({ photo: Buffer.alloc(10).toString('base64') }), consent({ photo: Buffer.alloc(1_048_577).toString('base64') }), consent({ subjectPrincipalId: U() }),
    consent({ schoolId: U() }), (({ adult, ...rest }) => rest)(consent()), null, []])
    assert.throws(() => contracts.validateCreativePhotoUploadInput(bad), JSON.stringify(bad)?.slice(0, 100));
  assert.deepEqual(contracts.validateCreativePhotoAvatarInput({ consentId: view(U()).consentId, name: 'Coach Jordan', style: 'CHIBI' }).style, 'CHIBI');
  for (const bad of [{ consentId: 'x', name: 'A', style: 'CHIBI' }, { consentId: U(), name: 'A', style: 'PHOTO' }, { consentId: U(), name: 'A', style: 'CHIBI', description: 'x' }])
    assert.throws(() => contracts.validateCreativePhotoAvatarInput(bad));
});

test('A3 consent view fails closed on drift and never carries the image', () => {
  const school = U();
  assert.doesNotThrow(() => contracts.validateCreativePhotoConsent(view(school)));
  assert.doesNotThrow(() => contracts.validateCreativePhotoConsent(view(school, { status: 'WITHDRAWN', withdrawnReason: 'DELETED_BY_OWNER', withdrawnAt: T })));
  for (const bad of [{ ...view(school), photo: 'AAAA' }, view(school, { status: 'ACTIVE', withdrawnReason: 'REPLACED', withdrawnAt: T }), view(school, { withdrawnAt: T }),
    view(school, { status: 'GONE' }), view(school, { consentVersion: 'v0' }), view(school, { avatarIds: ['nope'] }), view(school, { byteSize: 2_000_000 })])
    assert.throws(() => contracts.validateCreativePhotoConsent(bad), JSON.stringify(bad).slice(0, 120));
  assert.doesNotThrow(() => contracts.validateCreativePhotoRecords({ photos: [view(school), view(school, { mine: false })], canManageAll: true, limit: 50 }));
  assert.throws(() => contracts.validateCreativePhotoRecords({ photos: [view(school, { mine: false })], canManageAll: false, limit: 50 }), 'only an owner may see others');
  assert.throws(() => contracts.validateCreativePhotoRecords({ photos: [view(school), view(U())], canManageAll: true, limit: 50 }), 'one school');
  assert.throws(() => contracts.validateCreativePhotoDeleted({ photo: view(school) }), 'a deletion answers WITHDRAWN');
  assert.throws(() => contracts.validateCreativePhotoReceipt({ photo: view(school, { mine: false }), replayed: false }), 'an upload is always your own');
});

test('A3 metadata stripping removes EXIF, XMP, IPTC and text from JPEG, PNG and WebP, keeps the image data, and refuses a malformed file', () => {
  for (const [type, file, kept] of [['image/jpeg', jpeg(), ['JFIF', 'ICC_PROFILE', 'scan-data-']], ['image/png', png(), ['IHDR', 'IDAT', 'IEND']], ['image/webp', webp(), ['VP8X', 'VP8L']]]) {
    assert.match(file.toString('latin1'), SECRETS, `${type} fixture carries metadata`);
    const out = stripPhotoMetadata(type, file), text = out.toString('latin1');
    assert.doesNotMatch(text, SECRETS, type);
    for (const k of kept) assert.ok(text.includes(k), `${type} keeps ${k}`);
    assert.deepEqual(stripPhotoMetadata(type, out), out, `${type} is idempotent`);
  }
  const w = stripPhotoMetadata('image/webp', webp());
  assert.equal(w.readUInt32LE(4) + 8, w.length, 'RIFF size recomputed');
  assert.equal(w[20] & 0x0c, 0, 'VP8X EXIF/XMP flags cleared');
  for (const [type, bad] of [['image/jpeg', Buffer.from('not a jpeg at all')], ['image/jpeg', jpeg().subarray(0, 30)], ['image/png', png().subarray(0, 40)],
    ['image/png', jpeg()], ['image/webp', webp().subarray(0, 30)], ['image/webp', png()]])
    assert.throws(() => stripPhotoMetadata(type, bad), PhotoMetadataError, type);
});

/** A fake database that answers like 0305 and records every call. */
function fakeDatabase() {
  const calls = [];
  return { calls, callSaasBilling: async (operation, params) => {
    calls.push([operation, params]);
    if (operation === 'uploadCreativeAvatarPhoto') return { photo: view(params[1], { byteSize: Buffer.from(params[3], 'base64').length }), replayed: false };
    if (operation === 'deleteCreativeAvatarPhoto') return { photo: view(params[1], { consentId: params[2], status: 'WITHDRAWN', withdrawnReason: 'DELETED_BY_SUBJECT', withdrawnAt: T }) };
    if (operation === 'readCreativeAvatarPhotos') return { photos: [view(params[1])], canManageAll: false, limit: 50 };
    throw new Error(`unexpected ${operation}`);
  } };
}

test('A3 upload: the service strips metadata before the database, sends the signed fields without the photo, and refuses a file that is not its declared type', async () => {
  const db = fakeDatabase(), studio = new CreativeStudioService(new SaasBillingService(db), new SyntheticCreativeProviderRuntime('SUCCEED'));
  const school = U(), key = U(), out = await studio.uploadPhoto('subject-1', school, consent(), key);
  assert.equal(out.photo.status, 'ACTIVE');
  const [operation, params] = db.calls[0];
  assert.equal(operation, 'uploadCreativeAvatarPhoto');
  assert.deepEqual([params[0], params[1], params[4]], ['subject-1', school, key]);
  assert.deepEqual(JSON.parse(params[2]), (({ photo, ...rest }) => rest)(consent()), 'the consent fields only');
  const stored = Buffer.from(params[3], 'base64').toString('latin1');
  assert.doesNotMatch(stored, SECRETS); assert.ok(stored.includes('scan-data-'));
  await assert.rejects(studio.uploadPhoto('subject-1', school, consent({ contentType: 'image/png' }), U()), e => e.getStatus() === 400 && e.getResponse().code === 'INVALID_SAAS_INPUT');
  await assert.rejects(studio.uploadPhoto('subject-1', school, consent(), 'not-a-key'), e => e.getStatus() === 400);
  assert.equal(db.calls.length, 1, 'nothing else reached the database');
});

test('A3 routes: one controller under creative-studio/avatar-photos with POST commands for upload, photo avatar and delete; reads are GET', () => {
  assert.equal(Reflect.getMetadata('path', CreativeStudioAvatarPhotosController), 'schools/:schoolId/creative-studio/avatar-photos');
  const p = CreativeStudioAvatarPhotosController.prototype, route = name => [Reflect.getMetadata('path', p[name]), Reflect.getMetadata('method', p[name])];
  assert.deepEqual([route('list'), route('image'), route('upload'), route('createAvatar'), route('remove')],
    [['/', 0], [':consentId/image', 0], ['/', 1], ['avatars', 1], [':consentId/delete', 1]]);
});

test('A3 delete through the controller requires an empty body and answers the withdrawn consent', async () => {
  const db = fakeDatabase(), studio = new CreativeStudioService(new SaasBillingService(db), new SyntheticCreativeProviderRuntime('SUCCEED'));
  const controller = new CreativeStudioAvatarPhotosController(studio), req = { honIdentity: { externalSubject: 'subject-1' } }, school = U(), id = U();
  await assert.rejects(controller.remove(req, school, id, { reason: 'x' }), e => e.getStatus() === 400);
  const out = await controller.remove(req, school, id, {});
  assert.deepEqual([out.data.photo.status, out.data.photo.consentId], ['WITHDRAWN', id]);
  await assert.rejects(controller.remove({}, school, id, {}), e => e.getStatus() === 403);
});
