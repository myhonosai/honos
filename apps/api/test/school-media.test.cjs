const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const zlib = require('node:zlib');
const { prepareMediaImage, stripGif, jpegOrientation, MediaImageRefused } = require('../dist/school-media/media-image.js');
const { MediaStorage, mediaStorageSettings, MediaStorageOff } = require('../dist/school-media/media-storage.js');
const { schoolMediaUploadTransport, publicMediaTransport, MEDIA_UPLOADS_IN_FLIGHT } = require('../dist/school-media/school-media-transport.js');
const { SchoolMediaService, PUBLIC_MEDIA_LINK } = require('../dist/school-media/school-media.service.js');
const { PublicClientLimit } = require('../dist/schedule/public-client-limit.js');

// Mocked boundary tests for the 0628 media library API. Authority, caps, states, idempotency and links are proven against
// PostgreSQL by packages/database/scripts/test-school-media-library-integrity.mjs.
const fixture = (name) => readFileSync(resolve(__dirname, 'fixtures', name));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const ASSET = '3f0c8d0e-4b8a-4c1e-9b7a-2d6f5e4c3b2a';
const TOKEN = 'A'.repeat(43);

function exifJpeg(jpeg, orientation) {
  // An EXIF block (big-endian) with orientation, a GPS pointer and a camera string.
  const tiff = Buffer.alloc(8 + 2 + 3 * 12 + 4 + 16);
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4); tiff.writeUInt16BE(3, 8);
  const entry = (i, tag, type, count, value) => { const at = 10 + i * 12; tiff.writeUInt16BE(tag, at); tiff.writeUInt16BE(type, at + 2); tiff.writeUInt32BE(count, at + 4); tiff.writeUInt32BE(value, at + 8); };
  entry(0, 0x010f, 2, 16, 50); // Make -> offset 50
  tiff.writeUInt16BE(0x0112, 10 + 12); tiff.writeUInt16BE(3, 12 + 12); tiff.writeUInt32BE(1, 14 + 12); tiff.writeUInt16BE(orientation, 18 + 12);
  entry(2, 0x8825, 4, 1, 50); // GPS IFD pointer
  tiff.write('CameraCo GPS 34N', 50, 'latin1');
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(payload.length + 2, 2);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x0c]), Buffer.from('owner name', 'latin1')]);
  return Buffer.concat([jpeg.subarray(0, 2), seg, payload, com, jpeg.subarray(2)]);
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function png(width, height) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  const rows = Buffer.alloc((width + 1) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from('Author\0Dana GPS', 'latin1')), pngChunk('IDAT', zlib.deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}
const GIF_HEAD = Buffer.from('474946383961' + '02000300' + '800000' + '000000ffffff', 'hex'); // 2x3, two-colour global table
const GIF_FRAME = Buffer.from('21f90401000000002c00000000020003000002024401' + '00', 'hex');
function gif(...middle) { return Buffer.concat([GIF_HEAD, ...middle, GIF_FRAME, Buffer.from([0x3b])]); }
const sub = (text) => Buffer.concat([Buffer.from([text.length]), Buffer.from(text, 'latin1'), Buffer.from([0])]);
const COMMENT = Buffer.concat([Buffer.from([0x21, 0xfe]), sub('shot at 34N by Dana')]);
const XMP = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from('XMP DataXMP', 'latin1'), sub('<gps>34N</gps>')]);
const LOOP = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([3, 1, 0, 0, 0])]);

test('pictures are checked by their bytes, cleaned of location and camera data, and measured', () => {
  const jpeg = fixture('paper-page.jpg');
  const dirty = exifJpeg(jpeg, 6);
  assert.equal(jpegOrientation(dirty), 6);
  const cleanJpeg = prepareMediaImage('image/jpeg', dirty);
  for (const text of ['CameraCo', 'GPS', 'owner name']) assert.equal(cleanJpeg.bytes.includes(Buffer.from(text, 'latin1')), false, `${text} removed`);
  assert.equal(jpegOrientation(cleanJpeg.bytes), 6, 'orientation alone is kept');
  assert.equal(prepareMediaImage('image/jpeg', jpeg).bytes.includes(Buffer.from('Exif', 'latin1')), false, 'no EXIF block when upright');
  assert.ok(cleanJpeg.width > 0 && cleanJpeg.height > 0);
  assert.equal(cleanJpeg.sha256, sha(cleanJpeg.bytes)); assert.equal(cleanJpeg.byteSize, cleanJpeg.bytes.length);

  const p = prepareMediaImage('image/png', png(7, 5));
  assert.deepEqual([p.width, p.height, p.mediaType], [7, 5, 'image/png']);
  assert.equal(p.bytes.includes(Buffer.from('Dana', 'latin1')), false);

  const g = prepareMediaImage('image/gif', gif(LOOP, COMMENT, XMP));
  assert.deepEqual([g.width, g.height], [2, 3]);
  for (const text of ['Dana', 'gps', 'XMP']) assert.equal(g.bytes.includes(Buffer.from(text, 'latin1')), false, `${text} removed`);
  assert.equal(g.bytes.includes(Buffer.from('NETSCAPE2.0', 'latin1')), true, 'loop setting kept');
  assert.deepEqual(stripGif(Buffer.concat([gif(), Buffer.from('trailing secret')])), gif(), 'anything after the trailer goes');
});

test('a picture whose bytes do not match its type, or that is malformed, is refused', () => {
  const jpeg = fixture('paper-page.jpg');
  for (const [type, bytes] of [['image/png', jpeg], ['image/gif', png(2, 2)], ['image/jpeg', Buffer.from('not a picture')], ['image/webp', fixture('paper-page.webp')],
    ['image/gif', Buffer.concat([GIF_HEAD, Buffer.from([0x3b])])], ['image/gif', GIF_HEAD], ['image/jpeg', jpeg.subarray(0, 200)], ['image/svg+xml', Buffer.from('<svg/>')]]) {
    assert.throws(() => prepareMediaImage(type, bytes), MediaImageRefused, `${type} refused`);
  }
});

test('media storage stays off unless it is switched on with a valid https project, key and bucket', () => {
  const on = { HON_MEDIA_STORAGE_APPROVED: 'true', HON_MEDIA_STORAGE_URL: 'https://example.supabase.co', HON_MEDIA_STORAGE_KEY: 'k'.repeat(40), HON_MEDIA_STORAGE_BUCKET: 'hon-media' };
  assert.deepEqual(mediaStorageSettings(on), { baseUrl: 'https://example.supabase.co', key: 'k'.repeat(40), bucket: 'hon-media' });
  assert.equal(mediaStorageSettings({}), null);
  for (const patch of [{ HON_MEDIA_STORAGE_APPROVED: '1' }, { HON_MEDIA_STORAGE_URL: 'http://example.supabase.co' }, { HON_MEDIA_STORAGE_URL: 'https://u:p@example.supabase.co' },
    { HON_MEDIA_STORAGE_URL: 'https://example.supabase.co/x' }, { HON_MEDIA_STORAGE_KEY: 'short' }, { HON_MEDIA_STORAGE_BUCKET: 'Bad Bucket' }, { HON_MEDIA_STORAGE_BUCKET: undefined }]) {
    assert.equal(mediaStorageSettings({ ...on, ...patch }), null, JSON.stringify(patch));
  }
  assert.equal(mediaStorageSettings({ ...on, HON_MEDIA_STORAGE_URL: 'http://127.0.0.1:9999', NODE_ENV: 'production' }), null, 'no plain http in production');
});

test('the storage client stores, signs five-minute links and removes only fixed media keys', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/object/sign/')) return new Response(JSON.stringify({ signedURL: `/object/sign/hon-media/media/${ASSET}?token=${'t'.repeat(40)}` }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const storage = MediaStorage.withSettings({ baseUrl: 'https://example.supabase.co', key: 'k'.repeat(40), bucket: 'hon-media' }, fetcher);
  await storage.put(`media/${ASSET}`, Buffer.from('x'), 'image/png');
  assert.equal(calls[0].url, `https://example.supabase.co/storage/v1/object/hon-media/media/${ASSET}`);
  assert.equal(calls[0].init.headers['x-upsert'], 'true'); assert.equal(calls[0].init.headers['Content-Type'], 'image/png'); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(await storage.signedUrl(`media/${ASSET}`), `https://example.supabase.co/storage/v1/object/sign/hon-media/media/${ASSET}?token=${'t'.repeat(40)}`);
  assert.deepEqual(JSON.parse(calls[1].init.body), { expiresIn: 300 });
  await storage.remove(`media/${ASSET}`);
  assert.deepEqual(JSON.parse(calls[2].init.body), { prefixes: [`media/${ASSET}`] });
  await assert.rejects(storage.put('media/../other', Buffer.from('x'), 'image/png'), /MEDIA_STORAGE_FAILED/);
  const evil = MediaStorage.withSettings({ baseUrl: 'https://example.supabase.co', key: 'k'.repeat(40), bucket: 'hon-media' },
    async () => new Response(JSON.stringify({ signedURL: 'https://evil.test/x' }), { status: 200 }));
  await assert.rejects(evil.signedUrl(`media/${ASSET}`), /MEDIA_STORAGE_FAILED/, 'a signed link must point at the same file');
  await assert.rejects(MediaStorage.withSettings(null, fetcher).put(`media/${ASSET}`, Buffer.from('x'), 'image/png'), MediaStorageOff);
});

function run(middleware, req) {
  return new Promise((resolvePromise) => {
    const headers = {};
    const listeners = {};
    const res = {
      statusCode: 200, setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, on: (event, fn) => { listeners[event] = fn; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolvePromise({ status: this.statusCode, body, headers, next: false }); listeners.finish?.(); },
    };
    middleware({ originalUrl: req.path, headers: {}, ...req }, res, () => resolvePromise({ status: res.statusCode, headers, next: true }));
  });
}

test('the upload transport admits only one exact path, picture types and sizes up to 25 MB', async () => {
  const mw = schoolMediaUploadTransport();
  const path = `/v1/organizations/${randomUUID()}/schools/${randomUUID()}/marketing/media/upload`;
  assert.equal((await run(mw, { method: 'GET', path: '/v1/health' })).next, true, 'other paths pass through');
  for (const req of [{ method: 'GET', path }, { method: 'POST', path, headers: { 'content-type': 'image/svg+xml', 'content-length': '4' } },
    { method: 'POST', path, originalUrl: `${path}?x=1`, headers: { 'content-type': 'image/png', 'content-length': '4' } },
    { method: 'POST', path, headers: { 'content-type': 'image/png', 'content-length': '4', 'content-encoding': 'gzip' } },
    { method: 'POST', path, headers: { 'content-type': 'image/png', 'transfer-encoding': 'chunked' } },
    { method: 'POST', path: `/v1/organizations/x/schools/y/marketing/media/upload`, headers: { 'content-type': 'image/png', 'content-length': '4' } }]) {
    assert.equal((await run(mw, req)).status, 400, JSON.stringify(req));
  }
  const big = await run(mw, { method: 'POST', path, headers: { 'content-type': 'image/png', 'content-length': String(26_214_401) } });
  assert.deepEqual([big.status, big.body.code], [413, 'MEDIA_TOO_LARGE']);
  assert.equal(MEDIA_UPLOADS_IN_FLIGHT, 4);
});

test('the public picture link admits one GET path with a 43-character token and limits each client', async () => {
  const limit = new PublicClientLimit(1, () => 0);
  const mw = publicMediaTransport(limit);
  const ok = await run(mw, { method: 'GET', path: `/v1/public/media/${TOKEN}`, headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(ok.next, true); assert.equal(ok.headers['cache-control'], 'no-store'); assert.equal(ok.headers['referrer-policy'], 'no-referrer');
  for (const req of [{ method: 'POST', path: `/v1/public/media/${TOKEN}` }, { method: 'GET', path: '/v1/public/media/short' },
    { method: 'GET', path: `/v1/public/media/${TOKEN}`, originalUrl: `/v1/public/media/${TOKEN}?a=1` }]) {
    assert.equal((await run(mw, req)).status, 400);
  }
  for (let i = 1; i < 600; i++) await run(mw, { method: 'GET', path: `/v1/public/media/${TOKEN}`, headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal((await run(mw, { method: 'GET', path: `/v1/public/media/${TOKEN}`, headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 429);
});

function service({ storage = MediaStorage.withSettings(null, async () => new Response('{}')), answers = [] } = {}) {
  const calls = [];
  const client = { query: async (sql, values) => { calls.push([sql, values]); if (sql.startsWith('SELECT hon.')) return { rows: [{ data: answers.shift() }] }; return { rows: [] }; } };
  const database = {
    withTenantTransaction: async (_c, fn) => fn(client), withTenantReadOnlyTransaction: async (_c, fn) => fn(client),
    runPublicEventCall: async (sql, values) => { calls.push([sql, values]); return answers.shift(); },
  };
  return { media: new SchoolMediaService(database, storage), calls };
}
const context = (patch = {}) => ({ organizationId: randomUUID(), schoolId: randomUUID(), principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(),
  correlationId: randomUUID(), idempotencyKey: 'key-1', externalSubject: 'subject', ...patch });

test('uploads store nothing while media storage is off, and refuse non-human or keyless commands', async () => {
  const { media, calls } = service();
  await assert.rejects(media.upload(context(), { title: 'Open house', mediaType: 'image/png', bytes: png(2, 2) }), status(503, 'MEDIA_STORAGE_OFF'));
  assert.equal(calls.length, 0, 'no database call and nothing stored');
  await assert.rejects(media.upload(context({ source: 'AI_EMPLOYEE' }), { title: 'x', mediaType: 'image/png', bytes: png(2, 2) }), status(403, 'HUMAN_COMMAND_REQUIRED'));
  await assert.rejects(media.upload(context({ idempotencyKey: '' }), { title: 'x', mediaType: 'image/png', bytes: png(2, 2) }), status(409, 'IDEMPOTENCY_KEY_REQUIRED'));
  await assert.rejects(media.upload(context(), { title: ' x', mediaType: 'image/png', bytes: png(2, 2) }), status(400, 'VALIDATION_FAILED'));
  await assert.rejects(media.library(context()), status(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
});

test('an upload stores the cleaned bytes under the database key and only then confirms it', async () => {
  const stored = [];
  const storage = MediaStorage.withSettings({ baseUrl: 'https://example.supabase.co', key: 'k'.repeat(40), bucket: 'hon-media' }, async (url, init) => { stored.push({ url, body: init.body }); return new Response('{}'); });
  const pending = { assetId: ASSET, kind: 'IMAGE', mediaType: 'image/png', title: 'Open house', byteSize: 1, width: 2, height: 2, state: 'PENDING', version: 1, linkToken: null,
    createdAt: '2026-11-22T10:00:00.000Z', readyAt: null, updatedAt: '2026-11-22T10:00:00.000Z' };
  const image = png(2, 2);
  const { media, calls } = service({ storage, answers: [{ ...pending, objectKey: `media/${ASSET}` }, { ...pending, state: 'READY', version: 2, linkToken: TOKEN, readyAt: '2026-11-22T10:00:01.000Z' }] });
  const result = await media.upload(context(), { title: 'Open house', mediaType: 'image/png', bytes: image });
  assert.equal(result.asset.state, 'READY'); assert.equal(result.replayed, false);
  assert.equal(stored.length, 1); assert.equal(stored[0].url, `https://example.supabase.co/storage/v1/object/hon-media/media/${ASSET}`);
  assert.equal(Buffer.from(stored[0].body).includes(Buffer.from('Dana')), false, 'stored bytes are the cleaned ones');
  const fns = calls.filter(([sql]) => sql.startsWith('SELECT hon.'));
  assert.match(fns[0][0], /begin_school_media_upload/); assert.match(fns[1][0], /finish_school_media_upload/);
  const begin = JSON.parse(fns[0][1][1]);
  assert.deepEqual(Object.keys(begin).sort(), ['byteSize', 'height', 'mediaType', 'sha256', 'title', 'width']);
  assert.equal(begin.sha256, sha(Buffer.from(stored[0].body)));

  // A replay of a READY picture stores nothing again.
  const again = service({ storage, answers: [{ ...pending, state: 'READY', version: 2, linkToken: TOKEN, readyAt: '2026-11-22T10:00:01.000Z', objectKey: `media/${ASSET}`, replayed: true }] });
  const replay = await again.media.upload(context(), { title: 'Open house', mediaType: 'image/png', bytes: image });
  assert.equal(replay.replayed, true); assert.equal(stored.length, 1);

  // A key that is not the asset's fixed key is never used.
  const bad = service({ storage, answers: [{ ...pending, objectKey: 'media/other' }] });
  await assert.rejects(bad.media.upload(context(), { title: 'Open house', mediaType: 'image/png', bytes: image }), status(503, 'SCHOOL_MEDIA_UNAVAILABLE'));
  assert.equal(stored.length, 1);
});

test('the public link signs only what the database names, and answers nothing for an unknown token', async () => {
  const storage = MediaStorage.withSettings({ baseUrl: 'https://example.supabase.co', key: 'k'.repeat(40), bucket: 'hon-media' },
    async () => new Response(JSON.stringify({ signedURL: `/object/sign/hon-media/media/${ASSET}?token=${'t'.repeat(40)}` })));
  const { media, calls } = service({ storage, answers: [{ objectKey: `media/${ASSET}`, mediaType: 'image/png' }, null] });
  assert.match(await media.publicLink(TOKEN), /\/storage\/v1\/object\/sign\/hon-media\/media\//);
  assert.deepEqual(calls[0], [PUBLIC_MEDIA_LINK, [TOKEN]]);
  assert.equal(await media.publicLink(TOKEN), null);
  assert.equal(await media.publicLink('../../etc'), null); assert.equal(calls.length, 2, 'a malformed token never reaches the database');
  assert.match(readFileSync(resolve(__dirname, '../src/foundation/runtime-database.service.ts'), 'utf8'), /'SELECT hon\.resolve_school_media_link\(\$1\) AS data'/);
});
