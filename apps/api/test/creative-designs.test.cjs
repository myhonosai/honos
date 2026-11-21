const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { CreativeDesignsService } = require('../dist/creative-studio/creative-designs.service.js');

// 0617 (D1) Creative Studio designs: closed document shapes, verified answers, error mapping, refusals before any database call.
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', P = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444', E = '55555555-5555-4555-8555-555555555555', F = '66666666-6666-4666-8666-666666666666';
const T = '2026-11-21T05:00:00.000Z', T2 = '2026-11-21T06:00:00.000Z';
const refused = (fn) => { try { fn(); return false; } catch { return true; } };
const base = { x: 36, y: 40, w: 300, h: 60, rotation: 0, opacity: 1, locked: false };
const text = (o = {}) => ({ id: 'title', kind: 'text', ...base, text: 'Free trial week!\nAges 4+', font: 'DISPLAY', size: 48, bold: true, italic: false,
  color: '#C8102E', align: 'center', lineHeight: 1.1, ...o });
const rect = (o = {}) => ({ id: 'band', kind: 'rect', ...base, fill: '#000000', stroke: null, strokeWidth: 0, radius: 8, ...o });
const doc = (elements = [text(), rect()], pages = 1) => ({ v: 1, pages: Array.from({ length: pages }, (_, i) => ({ background: '#FFFFFF', elements: i ? [] : elements })) });
const input = (o = {}) => ({ designId: null, expectedVersion: 0, name: 'Summer camp flyer', sizeCode: 'FLYER_LETTER', document: doc(), ...o });
const summary = (o = {}) => ({ designId: D, name: 'Summer camp flyer', sizeCode: 'FLYER_LETTER', status: 'ACTIVE', version: 1, createdAt: T, updatedAt: T, ...o });
const design = (o = {}) => ({ ...summary(), document: doc(), ...o });
const staff = { organizationId: A, schoolId: B, principalId: P, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: A, correlationId: A, idempotencyKey: 'key-1' };
// A real 1x1 PNG built with correct CRCs, optionally with a tEXt metadata chunk the API must strip.
const zlib = require('node:zlib');
const chunk = (type, data) => { const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0); return Buffer.concat([len, t, data, crc]); };
const png = (extra = []) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', Buffer.from('0000000100000001080600000000', 'hex').subarray(0, 13)),
  ...extra, chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
const PNG = png();

test('sizes are the approved print and screen list; blank documents have one page per side', () => {
  assert.deepEqual([...contracts.CREATIVE_DESIGN_SIZE_CODES], ['FLYER_LETTER', 'FLYER_HALF', 'POSTER_11X17', 'POSTER_18X24', 'POSTCARD_4X6', 'POSTCARD_5X7', 'SOCIAL_SQUARE', 'SOCIAL_STORY', 'EVENT_COVER']);
  assert.deepEqual([contracts.CREATIVE_DESIGN_SIZES.FLYER_LETTER.width / 72, contracts.CREATIVE_DESIGN_SIZES.FLYER_LETTER.height / 72], [8.5, 11]);
  assert.deepEqual([contracts.CREATIVE_DESIGN_SIZES.POSTCARD_4X6.width / 72, contracts.CREATIVE_DESIGN_SIZES.POSTCARD_4X6.height / 72, contracts.CREATIVE_DESIGN_SIZES.POSTCARD_4X6.sides], [6, 4, 2]);
  assert.equal(contracts.blankCreativeDesignDocument('POSTCARD_5X7').pages.length, 2);
  assert.deepEqual(contracts.validateCreativeDesignDocument(contracts.blankCreativeDesignDocument('SOCIAL_STORY'), 'SOCIAL_STORY'), { v: 1, pages: [{ background: '#FFFFFF', elements: [] }] });
});

test('documents are closed: element kinds and keys, ranges, colors, unique ids, page count, size cap', () => {
  const lines = { id: 'rule', kind: 'line', ...base, w: -200, h: 0, stroke: '#112233', strokeWidth: 2 };
  const photo = { id: 'hero', kind: 'image', ...base, imageId: E, fit: 'cover' };
  const circle = { id: 'dot', kind: 'ellipse', ...base, fill: null, stroke: '#FFFFFF', strokeWidth: 4 };
  const ok = contracts.validateCreativeDesignDocument(doc([text(), rect(), lines, photo, circle]), 'FLYER_LETTER');
  assert.equal(ok.pages[0].elements.length, 5);
  assert.deepEqual(contracts.creativeDesignPhotoIds(doc([photo, { ...photo, id: 'hero-2' }])), [E]);
  for (const bad of [doc([text(), text()]), doc([text({ kind: 'video' })]), doc([text({ extra: 1 })]), doc([text({ color: '#c8102e' })]), doc([text({ color: 'red' })]),
    doc([text({ font: 'COMIC' })]), doc([text({ size: 2 })]), doc([text({ text: '' })]), doc([text({ text: 'a\tb' })]), doc([text({ text: 'x'.repeat(2001) })]),
    doc([text({ w: 0 })]), doc([text({ x: 99999 })]), doc([text({ opacity: 1.5 })]), doc([text({ rotation: 400 })]), doc([text({ locked: 'no' })]),
    doc([text({ id: 'Title' })]), doc([text({ align: 'justify' })]), doc([rect({ radius: -1 })]), doc([rect({ fill: undefined })]),
    doc([{ ...lines, strokeWidth: 0 }]), doc([{ ...photo, imageId: 'x' }]), doc([{ ...photo, fit: 'fill' }]), doc([text({ x: Number.NaN })]),
    doc([], 2), { v: 2, pages: [] }, { v: 1, pages: [{ background: '#FFFFFF' }] }, doc(Array.from({ length: 151 }, (_, i) => rect({ id: 'r' + i })))])
    assert.ok(refused(() => contracts.validateCreativeDesignDocument(bad, 'FLYER_LETTER')), JSON.stringify(bad).slice(0, 120));
  assert.ok(refused(() => contracts.validateCreativeDesignDocument(doc([]), 'POSTCARD_4X6')), 'a postcard has a front and a back');
  assert.equal(contracts.validateCreativeDesignDocument(doc([], 2), 'POSTCARD_4X6').pages.length, 2);
  const big = doc(Array.from({ length: 150 }, (_, i) => text({ id: 't' + i, text: 'x'.repeat(2000) })));
  assert.ok(refused(() => contracts.validateCreativeDesignDocument(big, 'FLYER_LETTER')), 'over 300,000 characters');
});

test('inputs are closed: names, versions, sizes; photos are canonical base64 within the byte cap', () => {
  assert.equal(contracts.validateSaveCreativeDesignInput(input()).name, 'Summer camp flyer');
  assert.equal(contracts.validateSaveCreativeDesignInput(input({ designId: D, expectedVersion: 3 })).expectedVersion, 3);
  for (const bad of [input({ name: '' }), input({ name: ' x' }), input({ name: 'x'.repeat(81) }), input({ name: 'a‮b' }), input({ expectedVersion: 1 }),
    input({ designId: D }), input({ sizeCode: 'A4' }), input({ sizeCode: 'POSTCARD_4X6' }), { ...input(), schoolId: B }])
    assert.ok(refused(() => contracts.validateSaveCreativeDesignInput(bad)), JSON.stringify(bad).slice(0, 80));
  assert.deepEqual(contracts.validateSetCreativeDesignStatusInput({ designId: D, expectedVersion: 2, status: 'ARCHIVED' }), { designId: D, expectedVersion: 2, status: 'ARCHIVED' });
  assert.ok(refused(() => contracts.validateSetCreativeDesignStatusInput({ designId: D, expectedVersion: 0, status: 'ARCHIVED' })));
  assert.deepEqual(contracts.validateCreativeDesignsQuery({ status: 'ARCHIVED' }), { status: 'ARCHIVED' });
  assert.ok(refused(() => contracts.validateCreativeDesignsQuery({ limit: '5' })));
  assert.equal(contracts.validateAddCreativeDesignPhotoInput({ mediaType: 'image/png', data: PNG.toString('base64') }).mediaType, 'image/png');
  for (const bad of [{ mediaType: 'image/gif', data: PNG.toString('base64') }, { mediaType: 'image/png', data: '' }, { mediaType: 'image/png', data: 'abc' },
    { mediaType: 'image/png', data: PNG.toString('base64') + '\n' }, { mediaType: 'image/png', data: 'A'.repeat(1_866_668) }, { mediaType: 'image/png' }])
    assert.ok(refused(() => contracts.validateAddCreativeDesignPhotoInput(bad)), JSON.stringify(bad).slice(0, 80));
});

test('answers are verified: list order and status, duplicates, receipts for the exact design and version, photos', () => {
  assert.equal(contracts.verifyCreativeDesignList({ designs: [summary({ updatedAt: T2 }), summary({ designId: F })] }).designs.length, 2);
  assert.ok(refused(() => contracts.verifyCreativeDesignList({ designs: [summary(), summary({ designId: F, updatedAt: T2 })] })), 'newest first');
  assert.ok(refused(() => contracts.verifyCreativeDesignList({ designs: [summary(), summary()] })), 'duplicate');
  assert.ok(refused(() => contracts.verifyCreativeDesignList({ designs: [summary()] }, { status: 'ARCHIVED' })), 'status filter');
  assert.ok(refused(() => contracts.verifyCreativeDesignList({ designs: [design()] })), 'a list carries no documents');
  for (const bad of [design({ version: 0 }), design({ updatedAt: '2026-11-20T00:00:00.000Z' }), design({ document: doc([], 2) }), design({ extra: 1 })])
    assert.ok(refused(() => contracts.verifyCreativeDesign(bad)), JSON.stringify(bad).slice(0, 80));
  assert.equal(contracts.verifyCreativeDesignReceipt({ design: design({ version: 2 }), replayed: false }, { version: 2, designId: D }).design.version, 2);
  assert.ok(refused(() => contracts.verifyCreativeDesignReceipt({ design: design(), replayed: false }, { version: 2 })), 'wrong version');
  assert.ok(refused(() => contracts.verifyCreativeDesignReceipt({ design: design({ version: 2 }), replayed: false }, { version: 2, designId: F })), 'another design');
  assert.ok(refused(() => contracts.verifyCreativeDesignReceipt({ design: design(), replayed: false }, { version: 1, sizeCode: 'POSTER_11X17' })), 'another size');
  const photo = { photoId: E, mediaType: 'image/png', bytes: PNG.length, checksum: 'a'.repeat(64), createdAt: T };
  assert.equal(contracts.verifyCreativeDesignPhotoReceipt({ photo, replayed: true }, { mediaType: 'image/png' }).replayed, true);
  assert.ok(refused(() => contracts.verifyCreativeDesignPhotoReceipt({ photo, replayed: false }, { mediaType: 'image/jpeg' })));
  assert.equal(contracts.verifyCreativeDesignPhoto({ ...photo, data: PNG.toString('base64') }, E).bytes, PNG.length);
  assert.ok(refused(() => contracts.verifyCreativeDesignPhoto({ ...photo, bytes: 3, data: PNG.toString('base64') }, E)), 'byte count must match');
  assert.ok(refused(() => contracts.verifyCreativeDesignPhoto({ ...photo, data: PNG.toString('base64') }, F)), 'another photo');
});

test('the service refuses before any database call and maps database errors exactly', async () => {
  let calls = 0;
  const idle = new CreativeDesignsService({ withTenantTransaction: async () => { calls++; }, withTenantReadOnlyTransaction: async () => { calls++; } });
  await assert.rejects(idle.save({ ...staff, source: 'AI_AGENT' }, input()), e => e.getStatus() === 403);
  await assert.rejects(idle.save({ ...staff, actionRequestId: A }, input()), e => e.getStatus() === 403);
  await assert.rejects(idle.save({ ...staff, idempotencyKey: '' }, input()), e => e.getResponse().code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(idle.list(staff, {}), e => e.getResponse().code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(idle.get({ ...staff, idempotencyKey: '' }, 'not-a-uuid'), e => e.getStatus() === 400);
  await assert.rejects(idle.save(staff, input({ sizeCode: 'A4' })), e => e.getStatus() === 400);
  await assert.rejects(idle.setStatus(staff, { designId: D, expectedVersion: 1, status: 'GONE' }), e => e.getStatus() === 400);
  await assert.rejects(idle.addPhoto(staff, { mediaType: 'image/jpeg', data: PNG.toString('base64') }), e => e.getResponse().code === 'CREATIVE_DESIGN_PHOTO_REFUSED', 'bytes must match the type');
  assert.equal(calls, 0);
  const failing = (code, message) => new CreativeDesignsService({ withTenantTransaction: async () => { throw Object.assign(new Error(message), { code }); } });
  for (const [code, message, status, out] of [['23505', 'CREATIVE_DESIGN_NAME_TAKEN', 409, 'CREATIVE_DESIGN_NAME_TAKEN'], ['23505', 'IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['54000', 'CREATIVE_DESIGN_LIMIT', 413, 'CREATIVE_DESIGN_LIMIT'], ['55000', 'CREATIVE_DESIGN_ARCHIVED', 409, 'CREATIVE_DESIGN_ARCHIVED'], ['40001', 'VERSION_CONFLICT', 409, 'VERSION_CONFLICT'],
    ['P0002', 'CREATIVE_DESIGN_NOT_FOUND', 404, 'CREATIVE_DESIGN_NOT_FOUND'], ['P0002', 'CREATIVE_DESIGN_PHOTO_NOT_FOUND', 404, 'CREATIVE_DESIGN_PHOTO_NOT_FOUND'],
    ['42501', 'anything', 403, 'CREATIVE_DESIGN_FORBIDDEN'], ['XX000', 'boom', 503, 'CREATIVE_DESIGN_UNAVAILABLE'],
    ['23505', 'school_creative_designs_active_name', 409, 'CREATIVE_DESIGN_CONFLICT'], ['22023', 'CREATIVE_DESIGN_NAME_TAKEN', 400, 'VALIDATION_FAILED']])
    await assert.rejects(failing(code, message).save(staff, input()), e => e.getStatus() === status && e.getResponse().code === out, message);
});

test('the service sends one closed call, strips photo metadata, and refuses an unverified answer', async () => {
  const seen = [];
  const db = (answer) => ({
    withTenantTransaction: async (_c, fn) => fn({ query: async (sql, args) => { seen.push([sql, args]); return /^SELECT hon\./.test(sql) ? { rows: [{ data: answer }] } : { rows: [] }; } }),
    withTenantReadOnlyTransaction: async (_c, fn) => fn({ query: async (sql, args) => { seen.push([sql, args]); return /^SELECT hon\./.test(sql) ? { rows: [{ data: answer }] } : { rows: [] }; } }),
  });
  const saved = await new CreativeDesignsService(db({ design: design(), replayed: false })).save(staff, input());
  assert.equal(saved.design.designId, D);
  const call = seen.find(([sql]) => sql.includes('save_school_creative_design'));
  assert.deepEqual(call[1].slice(2), ['key-1', A, A]);
  await assert.rejects(new CreativeDesignsService(db({ design: design({ version: 2 }), replayed: false })).save(staff, input()), e => e.getStatus() === 503);
  // A PNG carrying a tEXt chunk: the database only ever sees the stripped bytes.
  const withText = png([chunk('tEXt', Buffer.from('Comment\0taken at 12 Main St', 'latin1'))]);
  assert.ok(withText.includes(Buffer.from('tEXt')));
  seen.length = 0;
  const photo = { photoId: E, mediaType: 'image/png', bytes: PNG.length, checksum: 'b'.repeat(64), createdAt: T };
  await new CreativeDesignsService(db({ photo, replayed: false })).addPhoto(staff, { mediaType: 'image/png', data: withText.toString('base64') });
  const sent = JSON.parse(seen.find(([sql]) => sql.includes('add_school_creative_design_photo'))[1][1]);
  assert.deepEqual(Object.keys(sent).sort(), ['data', 'mediaType']);
  assert.ok(!Buffer.from(sent.data, 'base64').includes(Buffer.from('tEXt')));
  seen.length = 0;
  await assert.rejects(new CreativeDesignsService(db(design({ designId: F }))).get({ ...staff, idempotencyKey: '' }, D), e => e.getStatus() === 503, 'another design');
});
