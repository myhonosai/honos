const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { MediaStorage, videoObjectKeys } = require('../dist/school-media/media-storage.js');
const { videoSignatureOk, videoDemuxer } = require('../dist/school-media/media-video.js');
const { publicMediaTransport } = require('../dist/school-media/school-media-transport.js');
const { SchoolMediaService, PUBLIC_VIDEO_POSTER, PUBLIC_VIDEO_PAGE } = require('../dist/school-media/school-media.service.js');
const { SchoolVideoCopyWorker, verifyVideoCopyJob, VIDEO_COPY_CLAIM, VIDEO_COPY_FINISH, VIDEO_COPY_FAIL } = require('../dist/school-media/school-video-copy.js');
const { renderEmailWithPictures, verifyEmailPictures } = require('../dist/communication/delivery/email-pictures.js');

// Mocked boundary tests for 0654 video. Authority, caps, states, leases and links are proven against PostgreSQL by
// packages/database/scripts/test-school-media-video-integrity.mjs. The copy test runs the real ffmpeg when it is installed.
const ASSET = '3f0c8d0e-4b8a-4c1e-9b7a-2d6f5e4c3b2a';
const TOKEN = 'V'.repeat(43);
const SETTINGS = { baseUrl: 'https://store.example.test', key: 'k'.repeat(40), bucket: 'hon-media' };
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value, error.message); if (code) assert.equal(error.getResponse().code, code); return true; };
const iso = (type) => { const b = Buffer.alloc(32); b.writeUInt32BE(24, 0); b.write(type, 4, 'latin1'); b.write('isom', 8, 'latin1'); return b; };
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(28)]);
const video = (over = {}) => ({ assetId: ASSET, kind: 'VIDEO', mediaType: 'video/mp4', title: 'Open house', byteSize: 5000, width: null, height: null,
  state: 'PENDING', version: 1, linkToken: null, copyState: null, durationMs: null, createdAt: '2026-11-23T10:00:00.000Z', readyAt: null, updatedAt: '2026-11-23T10:00:00.000Z', ...over });
const ready = (over = {}) => video({ state: 'READY', version: 2, copyState: 'QUEUED', readyAt: '2026-11-23T10:00:01.000Z', ...over });
const library = (...assets) => ({ assets, usage: { storedBytes: 0, storedLimitBytes: 5368709120, monthBytes: 0, monthLimitBytes: 10737418240 } });
const context = (patch = {}) => ({ organizationId: randomUUID(), schoolId: randomUUID(), principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(),
  correlationId: randomUUID(), idempotencyKey: 'key-1', externalSubject: 'subject', ...patch });

function service({ storage = MediaStorage.withSettings(null, async () => new Response('{}')), answers = [] } = {}) {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push([sql, values]);
    if (!sql.startsWith('SELECT hon.')) return { rows: [] };
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return { rows: [{ data: answer }] };
  } };
  const database = {
    withTenantTransaction: async (_c, fn) => fn(client), withTenantReadOnlyTransaction: async (_c, fn) => fn(client),
    runPublicEventCall: async (sql, values) => { calls.push([sql, values]); return answers.shift(); },
  };
  return { media: new SchoolMediaService(database, storage), calls };
}
/** A storage stand-in that records requests and answers by URL. */
function fakeStorage(handler) {
  const requests = [];
  const storage = MediaStorage.withSettings(SETTINGS, async (url, init) => { requests.push({ url, init }); return handler(url, init); });
  return { storage, requests };
}

test('video files are recognised by their first bytes, and each type has a fixed demuxer', () => {
  for (const box of ['ftyp', 'moov', 'mdat', 'wide', 'free']) assert.equal(videoSignatureOk('video/mp4', iso(box)), true, box);
  assert.equal(videoSignatureOk('video/quicktime', iso('ftyp')), true);
  assert.equal(videoSignatureOk('video/webm', WEBM), true);
  assert.equal(videoSignatureOk('video/mp4', WEBM), false);
  assert.equal(videoSignatureOk('video/webm', iso('ftyp')), false);
  assert.equal(videoSignatureOk('video/mp4', Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\nfile:///etc/passwd\n')), false, 'a playlist is not a video');
  assert.equal(videoSignatureOk('video/mp4', Buffer.from('<html><body>x</body></html>')), false);
  assert.equal(videoSignatureOk('video/mp4', iso('ftyp').subarray(0, 8)), false, 'too short');
  assert.equal(videoDemuxer('video/webm'), 'matroska');
  assert.equal(videoDemuxer('video/quicktime'), 'mov');
  assert.deepEqual(videoObjectKeys(`media/${ASSET}`), [`media/${ASSET}`, `media/${ASSET}.720.mp4`, `media/${ASSET}.poster.jpg`]);
});

test('storage signs one-time uploads only for an original key, reads a stored file head by range, and removes all three files', async () => {
  const { storage, requests } = fakeStorage((url) => {
    if (url.includes('/upload/sign/')) return Response.json({ url: `/object/upload/sign/hon-media/media/${ASSET}?token=${'t'.repeat(40)}` });
    if (url.includes('/object/authenticated/')) return new Response(iso('ftyp'), { status: 206, headers: { 'content-range': 'bytes 0-31/5000' } });
    return new Response('{}');
  });
  assert.equal(await storage.signedUploadUrl(`media/${ASSET}`), `https://store.example.test/storage/v1/object/upload/sign/hon-media/media/${ASSET}?token=${'t'.repeat(40)}`);
  await assert.rejects(storage.signedUploadUrl(`media/${ASSET}.720.mp4`), /MEDIA_STORAGE_FAILED/, 'never a copy or poster key');
  await assert.rejects(storage.signedUploadUrl(`media/../${ASSET}`), /MEDIA_STORAGE_FAILED/);
  const head = await storage.head(`media/${ASSET}`);
  assert.equal(head.totalBytes, 5000); assert.equal(head.head.length, 32);
  assert.equal(requests.at(-1).init.headers.Range, 'bytes=0-4095');
  assert.equal(requests.at(-1).init.redirect, 'error');
  await storage.remove(videoObjectKeys(`media/${ASSET}`));
  assert.deepEqual(JSON.parse(requests.at(-1).init.body).prefixes, videoObjectKeys(`media/${ASSET}`));
  await assert.rejects(storage.remove([`media/${ASSET}`, 'other/thing']), /MEDIA_STORAGE_FAILED/);

  const wrongLink = fakeStorage(() => Response.json({ url: `/object/upload/sign/hon-media/media/${randomUUID()}?token=${'t'.repeat(40)}` }));
  await assert.rejects(wrongLink.storage.signedUploadUrl(`media/${ASSET}`), /MEDIA_STORAGE_FAILED/, 'a link for another key is refused');
  const missing = fakeStorage(() => new Response('{"error":"not_found"}', { status: 404 }));
  assert.equal(await missing.storage.head(`media/${ASSET}`), null);
  const badRange = fakeStorage(() => new Response(iso('ftyp'), { status: 206, headers: { 'content-range': 'bytes 0-99/5000' } }));
  await assert.rejects(badRange.storage.head(`media/${ASSET}`), /MEDIA_STORAGE_FAILED/, 'a range that does not match the bytes is refused');
});

test('starting a video reserves it and answers a one-time upload link; nothing happens while storage is off', async () => {
  const off = service();
  await assert.rejects(off.media.beginVideo(context(), { title: 'Open house', mediaType: 'video/mp4', byteSize: 5000 }), status(503, 'MEDIA_STORAGE_OFF'));
  assert.equal(off.calls.length, 0);
  await assert.rejects(off.media.beginVideo(context(), { title: 'Open house', mediaType: 'video/x-msvideo', byteSize: 5000 }), status(400, 'VALIDATION_FAILED'));
  await assert.rejects(off.media.beginVideo(context(), { title: 'Open house', mediaType: 'video/mp4', byteSize: 5368709121 }), status(400, 'VALIDATION_FAILED'));
  await assert.rejects(off.media.beginVideo(context({ source: 'AI_EMPLOYEE' }), { title: 'x', mediaType: 'video/mp4', byteSize: 1 }), status(403, 'HUMAN_COMMAND_REQUIRED'));

  const { storage } = fakeStorage(() => Response.json({ url: `/object/upload/sign/hon-media/media/${ASSET}?token=${'t'.repeat(40)}` }));
  const { media, calls } = service({ storage, answers: [{ ...video(), objectKey: `media/${ASSET}` }] });
  const ticket = await media.beginVideo(context(), { title: 'Open house', mediaType: 'video/mp4', byteSize: 5000 });
  assert.equal(ticket.asset.state, 'PENDING');
  assert.match(ticket.uploadUrl, /\/storage\/v1\/object\/upload\/sign\/hon-media\/media\//);
  const begin = calls.find(([sql]) => sql.includes('begin_school_video_upload'));
  assert.deepEqual(JSON.parse(begin[1][1]), { title: 'Open house', mediaType: 'video/mp4', byteSize: 5000 });

  const replay = service({ storage, answers: [{ ...ready(), objectKey: `media/${ASSET}`, replayed: true }] });
  const again = await replay.media.beginVideo(context(), { title: 'Open house', mediaType: 'video/mp4', byteSize: 5000 });
  assert.equal(again.uploadUrl, null, 'a READY video gets no new upload link'); assert.equal(again.replayed, true);
  const otherKey = service({ storage, answers: [{ ...video(), objectKey: `media/${randomUUID()}` }] });
  await assert.rejects(otherKey.media.beginVideo(context(), { title: 'Open house', mediaType: 'video/mp4', byteSize: 5000 }), status(503, 'SCHOOL_MEDIA_UNAVAILABLE'));
});

test('finishing a video checks the stored size and file signature before the database confirms it', async () => {
  const head = (bytes, total) => () => new Response(bytes, { status: 206, headers: { 'content-range': `bytes 0-${bytes.length - 1}/${total}` } });
  const missing = service({ storage: fakeStorage(() => new Response('', { status: 404 })).storage, answers: [library(video())] });
  await assert.rejects(missing.media.finishVideo(context(), { assetId: ASSET }), status(409, 'MEDIA_UPLOAD_MISSING'));
  const short = service({ storage: fakeStorage(head(iso('ftyp'), 4999)).storage, answers: [library(video())] });
  await assert.rejects(short.media.finishVideo(context(), { assetId: ASSET }), status(409, 'MEDIA_UPLOAD_MISMATCH'));
  assert.equal(short.calls.some(([sql]) => sql.includes('finish_school_video_upload')), false);

  const { storage: htmlStore, requests } = fakeStorage((url, init) => (init.method === 'GET' ? head(Buffer.from('<html>'.padEnd(32, ' ')), 5000)() : new Response('{}')));
  const html = service({ storage: htmlStore, answers: [library(video()), { ...video({ state: 'DELETED', version: 2 }), objectKey: `media/${ASSET}` }, { assetId: ASSET, state: 'REMOVED' }] });
  await assert.rejects(html.media.finishVideo(context(), { assetId: ASSET }), status(400, 'MEDIA_VIDEO_REFUSED'));
  assert.ok(html.calls.some(([sql]) => sql.includes('delete_school_media')), 'a file that is not a video is deleted at once');
  assert.deepEqual(JSON.parse(requests.find(r => r.init.method === 'DELETE').init.body).prefixes, videoObjectKeys(`media/${ASSET}`));

  const good = service({ storage: fakeStorage(head(iso('ftyp'), 5000)).storage, answers: [library(video()), ready()] });
  const receipt = await good.media.finishVideo(context(), { assetId: ASSET });
  assert.equal(receipt.asset.copyState, 'QUEUED');
  assert.deepEqual(JSON.parse(good.calls.find(([sql]) => sql.includes('finish_school_video_upload'))[1][1]), { assetId: ASSET, byteSize: 5000 });
  const picture = service({ storage: fakeStorage(head(iso('ftyp'), 5000)).storage,
    answers: [library({ ...video(), kind: 'IMAGE', mediaType: 'image/png', width: 2, height: 2, byteSize: 9 })] });
  await assert.rejects(picture.media.finishVideo(context(), { assetId: ASSET }), status(404, 'MEDIA_NOT_FOUND'), 'a picture is never finished as a video');
});

test('video links open only HON copies: the copy, the poster, and the page facts', async () => {
  const { storage } = fakeStorage((url) => Response.json({ signedURL: `/object/sign/hon-media/${decodeURIComponent(url.split('/hon-media/')[1])}?token=${'s'.repeat(40)}` }));
  const copy = service({ storage, answers: [{ objectKey: `media/${ASSET}.720.mp4`, mediaType: 'video/mp4' }] });
  assert.match(await copy.media.publicLink(TOKEN), /\.720\.mp4\?token=/);
  const original = service({ storage, answers: [{ objectKey: `media/${ASSET}`, mediaType: 'video/mp4' }] });
  await assert.rejects(original.media.publicLink(TOKEN), status(503), 'an original video is never linked');
  const poster = service({ storage, answers: [{ objectKey: `media/${ASSET}.poster.jpg`, mediaType: 'image/jpeg' }] });
  assert.match(await poster.media.publicPoster(TOKEN), /\.poster\.jpg\?token=/);
  assert.equal(poster.calls[0][0], PUBLIC_VIDEO_POSTER);
  const wrongPoster = service({ storage, answers: [{ objectKey: `media/${ASSET}.720.mp4`, mediaType: 'video/mp4' }] });
  await assert.rejects(wrongPoster.media.publicPoster(TOKEN), status(503));
  const page = service({ answers: [{ schoolName: 'Day School', title: 'Open house', width: 1280, height: 720, durationMs: 42000 }] });
  assert.deepEqual(await page.media.videoPage(TOKEN), { schoolName: 'Day School', title: 'Open house', width: 1280, height: 720, durationMs: 42000 });
  assert.equal(page.calls[0][0], PUBLIC_VIDEO_PAGE);
  const none = service({ answers: [null] });
  assert.equal(await none.media.videoPage(TOKEN), null);
  assert.equal(await none.media.videoPage('short'), null);
  const extra = service({ answers: [{ schoolName: 'Day School', title: 'Open house', width: 1280, height: 720, durationMs: 42000, objectKey: 'media/x' }] });
  await assert.rejects(extra.media.videoPage(TOKEN), status(503));
});

test('the public media transport admits the poster and page paths and nothing else', () => {
  const run = (path, method = 'GET') => {
    let code = 0, nextCalled = false;
    const res = { setHeader() {}, status(c) { code = c; return this; }, json() { return this; } };
    publicMediaTransport({ admit: () => 0 })({ path, method, originalUrl: path, headers: {} }, res, () => { nextCalled = true; });
    return nextCalled ? 'next' : code;
  };
  assert.equal(run(`/v1/public/media/${TOKEN}`), 'next');
  assert.equal(run(`/v1/public/media/${TOKEN}/poster`), 'next');
  assert.equal(run(`/v1/public/media/${TOKEN}/page`), 'next');
  assert.equal(run(`/v1/public/media/${TOKEN}/original`), 400);
  assert.equal(run(`/v1/public/media/${TOKEN}/poster`, 'POST'), 400);
});

test('the copy job claim answer is checked exactly', () => {
  const job = { assetId: ASSET, lease: randomUUID(), mediaType: 'video/mp4', byteSize: 5000, attempt: 1,
    sourceKey: `media/${ASSET}`, copyKey: `media/${ASSET}.720.mp4`, posterKey: `media/${ASSET}.poster.jpg` };
  assert.deepEqual(verifyVideoCopyJob(job), job);
  assert.equal(verifyVideoCopyJob(null), null);
  for (const bad of [{ ...job, sourceKey: `media/${randomUUID()}` }, { ...job, copyKey: `media/${ASSET}.mp4` }, { ...job, mediaType: 'application/x-mpegurl' },
    { ...job, attempt: 4 }, { ...job, extra: 1 }, { ...job, byteSize: 0 }]) assert.throws(() => verifyVideoCopyJob(bad), /UNVERIFIED_CLAIM/);
});

test('the copy job does nothing unless the 720p copy switch and storage are on', async () => {
  const before = process.env.HON_MEDIA_VIDEO_COPIES_APPROVED;
  delete process.env.HON_MEDIA_VIDEO_COPIES_APPROVED;
  const calls = [];
  const database = { runSchoolVideoCopyCall: async (sql) => { calls.push(sql); return null; } };
  const worker = new SchoolVideoCopyWorker(database, MediaStorage.withSettings(SETTINGS, async () => new Response('{}'))).withTools({ run: async () => 'ffmpeg version x' });
  assert.equal(await worker.runOnce(), 'NONE'); assert.equal(calls.length, 0);
  process.env.HON_MEDIA_VIDEO_COPIES_APPROVED = 'true';
  const offStorage = new SchoolVideoCopyWorker(database, MediaStorage.withSettings(null, async () => new Response('{}')));
  assert.equal(await offStorage.runOnce(), 'NONE'); assert.equal(calls.length, 0);
  assert.equal(await worker.runOnce(), 'NONE'); assert.deepEqual(calls, [VIDEO_COPY_CLAIM]);
  // Without ffmpeg and ffprobe on the host nothing is claimed, so no video spends its tries.
  const noTools = new SchoolVideoCopyWorker(database, MediaStorage.withSettings(SETTINGS, async () => new Response('{}'))).withTools({ run: async () => { throw new Error('ENOENT'); } });
  assert.equal(await noTools.runOnce(), 'NONE'); assert.equal(await noTools.runOnce(), 'NONE'); assert.deepEqual(calls, [VIDEO_COPY_CLAIM]);
  if (before === undefined) delete process.env.HON_MEDIA_VIDEO_COPIES_APPROVED; else process.env.HON_MEDIA_VIDEO_COPIES_APPROVED = before;
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
test('the copy job makes a 720p copy and a poster with no location or camera metadata, then records the facts', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hon-video-test-'));
  const before = process.env.HON_MEDIA_VIDEO_COPIES_APPROVED;
  process.env.HON_MEDIA_VIDEO_COPIES_APPROVED = 'true';
  const source = join(dir, 'phone.mov');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2',
    '-c:v', 'libx264', '-c:a', 'aac', '-metadata', 'location=+34.0522-118.2437/', '-metadata', 'make=CameraCo', '-metadata', 'title=Dana at home', '-f', 'mov', '-y', source]);
  // Like the bucket's signed links: byte ranges are served, so ffmpeg can seek to an index stored at the end of a phone file.
  const server = createServer((req, res) => {
    if (req.url !== '/original') { res.writeHead(404); res.end(); return; }
    const bytes = readFileSync(source), range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (!range) { res.writeHead(200, { 'content-type': 'video/quicktime', 'content-length': bytes.length, 'accept-ranges': 'bytes' }); res.end(bytes); return; }
    const from = Number(range[1]), to = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    res.writeHead(206, { 'content-type': 'video/quicktime', 'content-length': to - from + 1, 'content-range': `bytes ${from}-${to}/${bytes.length}`, 'accept-ranges': 'bytes' });
    res.end(bytes.subarray(from, to + 1));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const stored = {};
  const storage = MediaStorage.withSettings(SETTINGS, async () => new Response('{}'));
  storage.signedUrl = async (key) => { assert.equal(key, `media/${ASSET}`); return `http://127.0.0.1:${port}/original`; };
  const sourceBytes = readFileSync(source);
  storage.head = async (key) => { assert.equal(key, `media/${ASSET}`); return { totalBytes: sourceBytes.length, head: sourceBytes.subarray(0, 4096) }; };
  storage.putFile = async (key, path, size, type) => { stored[key] = { bytes: readFileSync(path), size, type }; };
  storage.put = async (key, bytes, type) => { stored[key] = { bytes, size: bytes.length, type }; };
  storage.remove = async () => { throw new Error('nothing should be removed'); };
  const lease = randomUUID(), calls = [];
  const database = { runSchoolVideoCopyCall: async (sql, values) => {
    calls.push([sql, values]);
    if (sql === VIDEO_COPY_CLAIM) return { assetId: ASSET, lease, mediaType: 'video/quicktime', byteSize: sourceBytes.length, attempt: 1, sourceKey: `media/${ASSET}`, copyKey: `media/${ASSET}.720.mp4`, posterKey: `media/${ASSET}.poster.jpg` };
    if (sql === VIDEO_COPY_FINISH) return { assetId: ASSET, copyState: 'DONE' };
    throw new Error(`unexpected ${sql} ${JSON.stringify(values)}`);
  } };
  try {
    assert.equal(await new SchoolVideoCopyWorker(database, storage).runOnce(), 'DONE');
    const facts = JSON.parse(calls.find(([sql]) => sql === VIDEO_COPY_FINISH)[1][2]);
    assert.deepEqual(calls.find(([sql]) => sql === VIDEO_COPY_FINISH)[1].slice(0, 2), [ASSET, lease]);
    assert.equal(facts.width, 1280); assert.equal(facts.height, 720);
    assert.ok(facts.durationMs >= 1900 && facts.durationMs <= 2200, String(facts.durationMs));
    const copy = stored[`media/${ASSET}.720.mp4`];
    assert.equal(copy.type, 'video/mp4'); assert.equal(copy.size, facts.copyBytes); assert.equal(copy.bytes.length, facts.copyBytes);
    assert.equal(stored[`media/${ASSET}.poster.jpg`].type, 'image/jpeg'); assert.equal(stored[`media/${ASSET}.poster.jpg`].size, facts.posterBytes);
    const copyPath = join(dir, 'check.mp4'); writeFileSync(copyPath, copy.bytes);
    const tags = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', copyPath]).toString();
    for (const secret of ['34.0522', 'CameraCo', 'Dana', 'location']) assert.equal(tags.includes(secret), false, `${secret} removed from the copy`);
    for (const secret of ['34.0522', 'CameraCo', 'Dana']) assert.equal(copy.bytes.includes(Buffer.from(secret)), false, `${secret} not in the copy bytes`);
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true });
    if (before === undefined) delete process.env.HON_MEDIA_VIDEO_COPIES_APPROVED; else process.env.HON_MEDIA_VIDEO_COPIES_APPROVED = before;
  }
});

test('a copy that cannot be made goes back to the database, and a video deleted meanwhile has its new files removed', async () => {
  const before = process.env.HON_MEDIA_VIDEO_COPIES_APPROVED;
  process.env.HON_MEDIA_VIDEO_COPIES_APPROVED = 'true';
  const job = { assetId: ASSET, lease: randomUUID(), mediaType: 'video/mp4', byteSize: 5000, attempt: 2, sourceKey: `media/${ASSET}`, copyKey: `media/${ASSET}.720.mp4`, posterKey: `media/${ASSET}.poster.jpg` };
  const removed = [];
  const storage = MediaStorage.withSettings(SETTINGS, async () => new Response('{}'));
  storage.signedUrl = async () => 'https://store.example.test/x';
  storage.remove = async (keys) => { removed.push(keys); };
  storage.putFile = async () => undefined; storage.put = async () => undefined;
  storage.head = async () => ({ totalBytes: 5000, head: iso('ftyp') });
  const calls = [];
  const database = { runSchoolVideoCopyCall: async (sql, values) => { calls.push([sql, values]); return sql === VIDEO_COPY_CLAIM ? job : { assetId: ASSET, copyState: 'QUEUED' }; } };
  const failing = new SchoolVideoCopyWorker(database, storage).withTools({ run: async (_command, args) => { if (args[0] === '-version') return 'ffmpeg version x'; throw new Error('PROCESS_FAILED'); } });
  try {
    assert.equal(await failing.runOnce(), 'RETRY');
    assert.deepEqual(calls.at(-1), [VIDEO_COPY_FAIL, [ASSET, job.lease, 'COPY_FAILED']]);
    assert.deepEqual(removed.at(-1), [job.copyKey, job.posterKey]);
  } finally { if (before === undefined) delete process.env.HON_MEDIA_VIDEO_COPIES_APPROVED; else process.env.HON_MEDIA_VIDEO_COPIES_APPROVED = before; }
});

test('an original rewritten after finish (another size or not a video) is never copied', async () => {
  const before = process.env.HON_MEDIA_VIDEO_COPIES_APPROVED;
  process.env.HON_MEDIA_VIDEO_COPIES_APPROVED = 'true';
  const job = { assetId: ASSET, lease: randomUUID(), mediaType: 'video/mp4', byteSize: 5000, attempt: 1, sourceKey: `media/${ASSET}`, copyKey: `media/${ASSET}.720.mp4`, posterKey: `media/${ASSET}.poster.jpg` };
  try {
    for (const original of [{ totalBytes: 9000, head: iso('ftyp') }, { totalBytes: 5000, head: Buffer.from('<html>'.padEnd(32, ' ')) }, null]) {
      const storage = MediaStorage.withSettings(SETTINGS, async () => new Response('{}'));
      const ran = [], calls = [];
      storage.head = async () => original;
      storage.signedUrl = async () => { throw new Error('no link should be signed'); };
      storage.remove = async () => undefined;
      const database = { runSchoolVideoCopyCall: async (sql, values) => { calls.push([sql, values]); return sql === VIDEO_COPY_CLAIM ? job : { assetId: ASSET, copyState: 'QUEUED' }; } };
      const worker = new SchoolVideoCopyWorker(database, storage).withTools({ run: async (_command, args) => { ran.push(args[0]); return 'ffmpeg version x'; } });
      assert.equal(await worker.runOnce(), 'RETRY');
      assert.deepEqual(calls.at(-1), [VIDEO_COPY_FAIL, [ASSET, job.lease, 'SIZE_CHANGED']]);
      assert.deepEqual(ran.filter(a => a !== '-version'), [], 'ffmpeg never ran');
    }
  } finally { if (before === undefined) delete process.env.HON_MEDIA_VIDEO_COPIES_APPROVED; else process.env.HON_MEDIA_VIDEO_COPIES_APPROVED = before; }
});

test('email blasts show a video as its poster linking to the video page, and as the page link in the text part', () => {
  const B = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
  const items = verifyEmailPictures([{ assetId: ASSET, kind: 'VIDEO', token: TOKEN, title: 'Belt test <highlights>', width: 1280, height: 720 },
    { assetId: B, kind: 'IMAGE', token: 'P'.repeat(43), title: 'Poster', width: 300, height: 200 }]);
  assert.equal(items.length, 2);
  const { text, html } = renderEmailWithPictures(`Watch:\n{{video:${ASSET}}}\n{{picture:${B}}}\n{{picture:${ASSET}}}\n{{video:${B}}}`, items, 'https://app.example.test');
  assert.equal(text, `Watch:\nBelt test <highlights>: https://app.example.test/v/${TOKEN}\nhttps://app.example.test/m/${'P'.repeat(43)}`,
    'a line whose kind does not match its item is dropped');
  assert.match(html, new RegExp(`<a href="https://app.example.test/v/${TOKEN}"><img src="https://app.example.test/m/${TOKEN}/poster" alt="Belt test &lt;highlights&gt;" width="600" height="338"`));
  assert.equal(html.includes('<highlights>'), false, 'titles are escaped');
  assert.deepEqual(verifyEmailPictures([{ assetId: ASSET, kind: 'AUDIO', token: TOKEN, title: 'x', width: 1, height: 1 }]), []);
  assert.deepEqual(verifyEmailPictures([{ assetId: ASSET, token: TOKEN, title: 'x', width: 1, height: 1 }]), [], 'an item without a kind lists nothing');
});
