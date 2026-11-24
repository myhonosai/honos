const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { inspectCreativeMedia, CreativeMediaRejected } = require('../dist/creative-studio/media/creative-media-inspect.js');
const {
  SupabaseCreativeMediaStore, UnconfiguredCreativeMediaStore, CreativeMediaIngest, CreativeDownloadRetry, downloadCreativeFile, CREATIVE_MEDIA_LIMITS,
} = require('../dist/creative-studio/media/creative-media-store.js');
const { CreativeMediaService } = require('../dist/creative-studio/media/creative-media.controller.js');
const { CreativeJobWorker } = require('../dist/creative-studio/creative-job-worker.js');
const { SyntheticAsyncCreativeProviderRuntime } = require('../dist/creative-studio/creative-provider-runtime.js');

const U = () => randomUUID();
// ---------- tiny media builders ----------
function crc() { return Buffer.alloc(4); } // the inspector does not trust or need CRCs; it never decodes pixels
function pngChunk(type, data = Buffer.alloc(0)) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), data, crc()]); }
function png(w = 640, h = 480, extra = []) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), ...extra, pngChunk('IDAT', Buffer.from([1, 2, 3, 4])), pngChunk('IEND')]);
}
function riffChunk(type, data) { const h = Buffer.alloc(8); h.write(type, 0, 'latin1'); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); }
function webp(chunks) { const body = Buffer.concat(chunks); const h = Buffer.alloc(12); h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(body.length + 4, 4); h.write('WEBP', 8, 'latin1'); return Buffer.concat([h, body]); }
function vp8l(w, h) { const d = Buffer.alloc(10); d[0] = 0x2f; d.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1); return riffChunk('VP8L', d); }
function vp8x(w, h, flags) { const d = Buffer.alloc(10); d[0] = flags; d.writeUIntLE(w - 1, 4, 3); d.writeUIntLE(h - 1, 7, 3); return riffChunk('VP8X', d); }
function box(type, ...parts) { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(body.length + 8); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); }
function mp4({ w = 1080, h = 1920, timescale = 1000, duration = 9400, udta = true } = {}) {
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(timescale, 12); mvhd.writeUInt32BE(duration, 16);
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(w << 16, 76); tkhd.writeUInt32BE(h << 16, 80);
  const hdlr = Buffer.alloc(24); hdlr.write('vide', 8, 'latin1');
  const meta = box('udta', box('\xa9too', Buffer.from('Lavf provider-secret-tool')));
  return Buffer.concat([box('ftyp', Buffer.from('isom0000isomiso2', 'latin1')),
    box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd), box('mdia', box('hdlr', hdlr))), ...(udta ? [meta] : [])), box('mdat', Buffer.alloc(64, 7))]);
}
const rejects = (fn, why) => assert.throws(fn, e => e instanceof CreativeMediaRejected && (!why || e.why.includes(why)));

test('inspect: PNG and WebP sizes come from the bytes, metadata is removed, anything else is refused', () => {
  const p = inspectCreativeMedia(png(640, 480, [pngChunk('tEXt', Buffer.from('Comment\0provider secret')), pngChunk('eXIf', Buffer.from('exif')), pngChunk('pHYs', Buffer.alloc(9))]), 'IMAGE');
  assert.deepEqual([p.mediaType, p.width, p.height, p.durationSeconds], ['image/png', 640, 480, null]);
  assert.ok(!p.bytes.includes(Buffer.from('provider secret')) && !p.bytes.includes(Buffer.from('eXIf')) && p.bytes.includes(Buffer.from('pHYs')));
  const lossless = inspectCreativeMedia(webp([vp8l(300, 200)]), 'IMAGE');
  assert.deepEqual([lossless.mediaType, lossless.width, lossless.height], ['image/webp', 300, 200]);
  const withExif = inspectCreativeMedia(webp([vp8x(300, 200, 0x0c), vp8l(300, 200), riffChunk('EXIF', Buffer.from('gps secret')), riffChunk('XMP ', Buffer.from('<x/>'))]), 'IMAGE');
  assert.ok(!withExif.bytes.includes(Buffer.from('gps secret')) && !withExif.bytes.includes(Buffer.from('XMP ')));
  assert.equal(withExif.bytes[20] & 0x0c, 0, 'EXIF and XMP flags cleared');
  assert.equal(withExif.bytes.readUInt32LE(4) + 8, withExif.bytes.length, 'RIFF size rewritten');
  assert.equal(inspectCreativeMedia(withExif.bytes, 'IMAGE').width, 300, 'the stored file is itself valid');
  rejects(() => inspectCreativeMedia(Buffer.from('\xff\xd8\xff\xe0 jpeg data here', 'latin1'), 'IMAGE'), 'not a PNG or WebP');
  rejects(() => inspectCreativeMedia(png().subarray(0, 40), 'IMAGE'));
  rejects(() => inspectCreativeMedia(Buffer.concat([png(), Buffer.from('trailing junk')]), 'IMAGE'), 'IEND');
  rejects(() => inspectCreativeMedia(png(0, 10), 'IMAGE'), 'dimensions');
  rejects(() => inspectCreativeMedia(png(9000, 10), 'IMAGE'), 'dimensions');
  rejects(() => inspectCreativeMedia(webp([vp8x(10, 10, 0x02), riffChunk('ANIM', Buffer.alloc(6)), vp8l(10, 10)]), 'IMAGE'), 'animated');
  rejects(() => inspectCreativeMedia(webp([vp8x(20, 20, 0), vp8l(10, 10)]), 'IMAGE'), 'canvas');
  rejects(() => inspectCreativeMedia(png(), 'VIDEO'));
  rejects(() => inspectCreativeMedia(mp4(), 'IMAGE'));
});

test('inspect: MP4 size and length come from the boxes; metadata boxes become same-size free space', () => {
  const source = mp4();
  const v = inspectCreativeMedia(source, 'VIDEO');
  assert.deepEqual([v.mediaType, v.width, v.height, v.durationSeconds], ['video/mp4', 1080, 1920, 10], '9.4 s is 10 whole seconds');
  assert.equal(v.bytes.length, source.length, 'no sample offset moves');
  assert.ok(!v.bytes.includes(Buffer.from('provider-secret-tool')) && !v.bytes.includes(Buffer.from('udta')) && v.bytes.includes(Buffer.from('free')));
  assert.ok(source.includes(Buffer.from('provider-secret-tool')), 'the input buffer is not modified');
  rejects(() => inspectCreativeMedia(mp4({ duration: 0 }), 'VIDEO'), 'duration');
  rejects(() => inspectCreativeMedia(mp4({ duration: 601_000 }), 'VIDEO'), 'duration');
  rejects(() => inspectCreativeMedia(mp4({ w: 0 }), 'VIDEO'), 'video track');
  rejects(() => inspectCreativeMedia(Buffer.concat([box('ftyp', Buffer.alloc(8)), box('mdat', Buffer.alloc(8))]), 'VIDEO'), 'moov');
  rejects(() => inspectCreativeMedia(Buffer.concat([box('free', Buffer.alloc(8)), mp4()]), 'VIDEO'), 'not an MP4');
  const broken = Buffer.from(source); broken.writeUInt32BE(0xffffff, 0); rejects(() => inspectCreativeMedia(broken, 'VIDEO'));
});

/** A scripted fetch: each call answers from the list (a function gets the URL and init). */
function scripted(...answers) {
  const calls = [];
  const send = async (url, init) => { calls.push({ url, init }); const a = answers.shift(); if (!a) throw new Error('unexpected call');
    return typeof a === 'function' ? a(url, init) : a; };
  return { send, calls };
}
const ok = (bytes, headers = {}) => new Response(bytes, { status: 200, headers });
const HOSTS = ['cdn.example.test'];
const dl = (url = 'https://cdn.example.test/a.png') => ({ url, mediaType: 'image/png', allowedHosts: HOSTS });

test('download: host rule on every redirect hop, size cap, retry only for answers that may work later', async () => {
  const one = scripted(ok(png()));
  assert.deepEqual(await downloadCreativeFile(one.send, dl(), 1000), png());
  assert.deepEqual([one.calls[0].init.redirect, one.calls[0].init.credentials, one.calls[0].init.headers], ['manual', 'omit', undefined], 'no HON credential or header is sent');
  const hop = scripted(new Response(null, { status: 302, headers: { location: 'https://files.cdn.example.test/b.png?sig=1' } }), ok(png()));
  await downloadCreativeFile(hop.send, dl(), 1000);
  assert.equal(hop.calls[1].url, 'https://files.cdn.example.test/b.png?sig=1');
  for (const location of ['https://evil.test/x', 'http://cdn.example.test/x', 'https://cdn.example.test:8443/x', 'https://u:p@cdn.example.test/x', '']) {
    const s = scripted(new Response(null, { status: 302, headers: location ? { location } : {} }));
    await assert.rejects(downloadCreativeFile(s.send, dl(), 1000), CreativeMediaRejected, location);
    assert.equal(s.calls.length, 1, 'a bad hop is never followed');
  }
  const loop = scripted(...Array.from({ length: 4 }, () => new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/again' } })));
  await assert.rejects(downloadCreativeFile(loop.send, dl(), 1000), e => e instanceof CreativeMediaRejected && /redirects/.test(e.why));
  await assert.rejects(downloadCreativeFile(scripted(new Response('x', { status: 503 })).send, dl(), 1000), CreativeDownloadRetry);
  await assert.rejects(downloadCreativeFile(scripted(new Response('x', { status: 429 })).send, dl(), 1000), CreativeDownloadRetry);
  await assert.rejects(downloadCreativeFile(async () => { throw new Error('ECONNRESET'); }, dl(), 1000), CreativeDownloadRetry);
  await assert.rejects(downloadCreativeFile(scripted(new Response('x', { status: 404 })).send, dl(), 1000), CreativeMediaRejected);
  await assert.rejects(downloadCreativeFile(scripted(ok('x', { 'content-length': '5000' })).send, dl(), 1000), e => /too large/.test(e.why));
  await assert.rejects(downloadCreativeFile(scripted(ok(Buffer.alloc(1500))).send, dl(), 1000), e => /too large/.test(e.why), 'streamed bytes are capped too');
  await assert.rejects(downloadCreativeFile(scripted().send, dl('https://evil.test/a.png'), 1000), CreativeMediaRejected);
  assert.deepEqual([CREATIVE_MEDIA_LIMITS.imageBytes, CREATIVE_MEDIA_LIMITS.videoBytes, CREATIVE_MEDIA_LIMITS.signedReadSeconds], [26214400, 209715200, 300]);
});

const STORE_ENV = { HON_CREATIVE_MEDIA_STORAGE_APPROVED: 'true', HON_CREATIVE_MEDIA_STORAGE_URL: 'https://project.supabase.example', HON_CREATIVE_MEDIA_STORAGE_KEY: 'service-key-0123456789abcdef' };
const KEY = `creative/${U()}/1`;

test('storage: READY only when approved and configured; private bucket calls never leak the key', async () => {
  assert.equal(new SupabaseCreativeMediaStore(() => STORE_ENV).readiness(), 'READY');
  for (const env of [{}, { ...STORE_ENV, HON_CREATIVE_MEDIA_STORAGE_APPROVED: 'TRUE' }, { ...STORE_ENV, HON_CREATIVE_MEDIA_STORAGE_URL: 'http://project.supabase.example' },
    { ...STORE_ENV, HON_CREATIVE_MEDIA_STORAGE_URL: 'https://project.supabase.example/storage' }, { ...STORE_ENV, HON_CREATIVE_MEDIA_STORAGE_KEY: 'short' },
    { ...STORE_ENV, HON_CREATIVE_MEDIA_BUCKET: '../public' }]) assert.equal(new SupabaseCreativeMediaStore(() => env).readiness(), 'CONFIGURATION_REQUIRED');
  assert.equal(new UnconfiguredCreativeMediaStore().readiness(), 'CONFIGURATION_REQUIRED');
  const s = scripted(new Response('{}', { status: 200 }), new Response(JSON.stringify({ signedURL: `/object/sign/creative-media/${KEY}?token=t` }), { status: 200 }), new Response('[]', { status: 200 }));
  const store = new SupabaseCreativeMediaStore(() => STORE_ENV, { send: s.send });
  await store.put(KEY, Buffer.from('abc'), 'image/png');
  assert.equal(s.calls[0].url, `https://project.supabase.example/storage/v1/object/creative-media/${KEY}`);
  assert.deepEqual([s.calls[0].init.method, s.calls[0].init.headers['x-upsert'], s.calls[0].init.headers['Content-Type'], s.calls[0].init.headers.Authorization, s.calls[0].init.redirect],
    ['POST', 'true', 'image/png', 'Bearer service-key-0123456789abcdef', 'error']);
  assert.equal(await store.signedReadUrl(KEY, 300), `https://project.supabase.example/storage/v1/object/sign/creative-media/${KEY}?token=t`);
  assert.deepEqual(JSON.parse(s.calls[1].init.body), { expiresIn: 300 });
  await store.remove(KEY);
  assert.deepEqual([s.calls[2].url, s.calls[2].init.method, JSON.parse(s.calls[2].init.body)], ['https://project.supabase.example/storage/v1/object/creative-media', 'DELETE', { prefixes: [KEY] }]);
  const none = scripted();
  const guarded = new SupabaseCreativeMediaStore(() => STORE_ENV, { send: none.send });
  for (const bad of ['../etc/passwd', `creative/${U()}/9`, 'creative/x/1', `school/${U()}/1`]) await assert.rejects(guarded.put(bad, Buffer.from('a'), 'image/png'));
  await assert.rejects(guarded.signedReadUrl(KEY, 3600)); await assert.rejects(guarded.signedReadUrl(KEY, 0));
  assert.equal(none.calls.length, 0, 'bad keys and lifetimes never reach storage');
  for (const answer of [new Response('{"error":"service-key-0123456789abcdef"}', { status: 403 }), () => { throw new Error('connect service-key-0123456789abcdef'); }]) {
    await assert.rejects(new SupabaseCreativeMediaStore(() => STORE_ENV, { send: scripted(answer).send }).put(KEY, Buffer.from('a'), 'image/png'),
      e => !String(e.message + e.stack).includes('service-key'));
  }
  await assert.rejects(new SupabaseCreativeMediaStore(() => STORE_ENV, { send: scripted(new Response(JSON.stringify({ signedURL: 'https://evil.test/x' }))).send }).signedReadUrl(KEY, 300));
});

/** A store that keeps what it was given. */
function memoryStore(failPut = false) {
  const objects = new Map();
  return { objects, readiness: () => 'READY', put: async (k, b, t) => { if (failPut) throw new Error('down'); objects.set(k, [b, t]); },
    signedReadUrl: async k => `https://project.supabase.example/storage/v1/object/sign/creative-media/${k}?token=t`, remove: async k => { objects.delete(k); } };
}

test('ingest: files stored under the job key with measured facts and the hash of the stored (stripped) bytes', async () => {
  const store = memoryStore(), jobId = U();
  const file = png(800, 600, [pngChunk('tEXt', Buffer.from('secret'))]);
  const ingest = new CreativeMediaIngest(store, { send: scripted(ok(file), ok(png(10, 20))).send });
  const claimed = [{ mediaType: 'image/png', width: 1024, height: 1024, durationSeconds: null, providerAssetReference: 'hf:req:1' },
    { mediaType: 'image/webp', width: 1024, height: 1024, durationSeconds: null, providerAssetReference: 'hf:req:2' }];
  const out = await ingest.ingest({ jobId, mediaKind: 'IMAGE' }, [dl(), dl('https://cdn.example.test/b.png')], claimed);
  assert.deepEqual(out.assets.map(a => [a.mediaType, a.width, a.height, a.providerAssetReference]), [['image/png', 800, 600, 'hf:req:1'], ['image/png', 10, 20, 'hf:req:2']]);
  const [stored] = store.objects.get(`creative/${jobId}/1`);
  assert.ok(!stored.includes(Buffer.from('secret')));
  assert.deepEqual(out.objects[0], { byteSize: stored.length, sha256: createHash('sha256').update(stored).digest('hex') });
  assert.deepEqual([...store.objects.keys()], [`creative/${jobId}/1`, `creative/${jobId}/2`]);
  await assert.rejects(ingest.ingest({ jobId, mediaKind: 'IMAGE' }, [dl()], claimed), CreativeMediaRejected, 'file count must match');
});

function workerStore(j) {
  const calls = [];
  return { calls, isConfigured: () => true, claim: async () => [j], recordPoll: async (...a) => { calls.push(['poll', ...a]); return { status: 'SUBMITTED' }; },
    recordResult: async (...a) => { calls.push(['result', ...a]); return { status: 'RECORDED' }; },
    recordStoredResult: async (...a) => { calls.push(['stored', ...a]); return { status: 'RECORDED' }; } };
}
const claimedJob = (patch = {}) => ({ jobId: U(), leaseToken: U(), providerId: 'HIGGSFIELD', providerJobId: `job-${U()}`, modelCode: 'async-image-1', operationCode: 'image.generate',
  mediaKind: 'IMAGE', units: 1, format: 'SQUARE', pollCount: 0, deadlineAt: new Date(Date.now() + 600_000).toISOString(), ...patch });

test('worker + storage: a success is recorded only with stored, measured files; bad files go to HQ, transient trouble waits', async () => {
  const run = async (j, answers, { store = memoryStore(), ingest } = {}) => {
    const s = workerStore(j);
    const media = ingest === null ? undefined : (ingest ?? new CreativeMediaIngest(store, { send: scripted(...answers).send }));
    const summary = await new CreativeJobWorker(s, new SyntheticAsyncCreativeProviderRuntime('ACCEPT', ['SUCCEED']), media).runOnce();
    return { summary, calls: s.calls, store };
  };
  const good = await run(claimedJob(), [ok(png(512, 256))]);
  assert.deepEqual(good.summary, { claimed: 1, recorded: 1, heldForHq: 0, pending: 0, errors: 0 });
  const [kind, , , outcome, objects] = good.calls[0];
  assert.equal(kind, 'stored');
  assert.deepEqual([outcome.outcome, outcome.assets[0].width, outcome.assets[0].height, objects.length], ['SUCCEEDED', 512, 256, 1], 'measured, not claimed (1024x1024)');
  const bad = await run(claimedJob(), [ok(Buffer.from('<html>not an image</html>'))]);
  assert.deepEqual([bad.calls[0][0], bad.calls[0][3].outcome, bad.calls[0][3].failureReason], ['result', 'UNKNOWN', 'UNVERIFIED_RESULT']);
  for (const answers of [[new Response('x', { status: 502 })], [() => { throw new Error('reset'); }]]) {
    const later = await run(claimedJob(), answers);
    assert.deepEqual(later.calls.map(c => c[0]), ['poll'], 'downloads that may work later wait for the next poll');
  }
  const storeDown = await run(claimedJob(), [ok(png())], { store: memoryStore(true) });
  assert.deepEqual(storeDown.calls.map(c => c[0]), ['poll']);
  const noStorage = await run(claimedJob(), [], { ingest: null });
  assert.deepEqual(noStorage.calls.map(c => c[0]), ['poll'], 'no storage: never recorded');
  const notReady = await run(claimedJob(), [], { ingest: { readiness: () => 'CONFIGURATION_REQUIRED', ingest: async () => assert.fail('never ingests') } });
  assert.deepEqual(notReady.calls.map(c => c[0]), ['poll']);
  const vid = (units, seconds) => run(claimedJob({ mediaKind: 'VIDEO', operationCode: 'video.generate', units, format: 'PORTRAIT' }), [ok(mp4({ duration: seconds * 1000 }))]);
  const exact = await vid(10, 9.4);
  assert.deepEqual([exact.calls[0][0], exact.calls[0][3].assets[0].durationSeconds], ['stored', 10]);
  const slightlyOver = await vid(10, 10.6);
  assert.deepEqual([slightlyOver.calls[0][0], slightlyOver.calls[0][3].assets[0].durationSeconds], ['stored', 10], 'under a second over is recorded at the reserved length');
  const tooLong = await vid(10, 12.5);
  assert.deepEqual([tooLong.calls[0][0], tooLong.calls[0][3].outcome], ['result', 'UNKNOWN'], 'longer than reserved is held for HQ');
});

/** Fake billing answering the three 0671 runtime calls. */
function fakeBilling({ grant, deletion, confirm, refuse } = {}) {
  const calls = [];
  return { calls, call: async (operation, params, validate) => { calls.push([operation, params]);
    if (refuse) throw refuse;
    const answer = operation === 'authorizeCreativeAssetRead' ? grant : operation === 'deleteCreativeAsset' ? deletion : confirm;
    return validate(answer); } };
}

test('views and deletes: the database authorizes, the browser gets a 5-minute signed URL and never a storage key', async () => {
  const school = U(), asset = U(), key = `creative/${U()}/1`;
  const grant = { assetId: asset, storageKey: key, mediaType: 'image/png', byteSize: 1234 };
  const billing = fakeBilling({ grant });
  const view = await new CreativeMediaService(billing, memoryStore()).view('subject-1', school, asset);
  assert.deepEqual(Object.keys(view).sort(), ['assetId', 'expiresAt', 'mediaType', 'url']);
  assert.equal(view.assetId, asset); assert.ok(view.url.startsWith('https://project.supabase.example/storage/v1/object/sign/'));
  const ttl = Date.parse(view.expiresAt) - Date.now(); assert.ok(ttl > 290_000 && ttl <= 300_000);
  assert.deepEqual(billing.calls, [['authorizeCreativeAssetRead', ['subject-1', school, asset]]]);
  await assert.rejects(new CreativeMediaService(fakeBilling({ grant }), new UnconfiguredCreativeMediaStore()).view('s', school, asset), e => e.getResponse().code === 'CREATIVE_STORAGE_NOT_CONNECTED');
  await assert.rejects(new CreativeMediaService(fakeBilling({ grant: { ...grant, assetId: U() } }), memoryStore()).view('s', school, asset), e => e.getStatus() === 503);
  await assert.rejects(new CreativeMediaService(fakeBilling({ grant: { ...grant, storageKey: '../x' } }), memoryStore()).view('s', school, asset));
  await assert.rejects(new CreativeMediaService(fakeBilling({ grant }), memoryStore()).view('s', 'not-a-uuid', asset), e => e.getStatus() === 400);
  const failingSign = { ...memoryStore(), signedReadUrl: async () => { throw new Error('down'); } };
  await assert.rejects(new CreativeMediaService(fakeBilling({ grant }), failingSign).view('s', school, asset), e => e.getResponse().code === 'CREATIVE_STORAGE_UNAVAILABLE');

  const deletedAt = new Date().toISOString();
  const store = memoryStore(); store.objects.set(key, [Buffer.from('x'), 'image/png']);
  const del = fakeBilling({ deletion: { assetId: asset, storageKey: key, deletedAt, removed: false }, confirm: { assetId: asset, storageKey: null, deletedAt, removed: true } });
  assert.deepEqual(await new CreativeMediaService(del, store).remove('s', school, asset, {}), { assetId: asset, deletedAt, fileRemoved: true });
  assert.deepEqual(del.calls.map(c => c[0]), ['deleteCreativeAsset', 'confirmCreativeAssetRemoved']); assert.equal(store.objects.size, 0);
  const stuck = fakeBilling({ deletion: { assetId: asset, storageKey: key, deletedAt, removed: false } });
  const down = { ...memoryStore(), remove: async () => { throw new Error('down'); } };
  assert.deepEqual(await new CreativeMediaService(stuck, down).remove('s', school, asset, {}), { assetId: asset, deletedAt, fileRemoved: false });
  assert.deepEqual(stuck.calls.map(c => c[0]), ['deleteCreativeAsset'], 'removal not confirmed when the file was not removed');
  const already = fakeBilling({ deletion: { assetId: asset, storageKey: null, deletedAt, removed: true } });
  const never = { ...memoryStore(), remove: async () => assert.fail('already removed') };
  assert.equal((await new CreativeMediaService(already, never).remove('s', school, asset, {})).fileRemoved, true);
  await assert.rejects(new CreativeMediaService(fakeBilling(), memoryStore()).remove('s', school, asset, { force: true }), e => e.getStatus() === 400);
  await assert.rejects(new CreativeMediaService(fakeBilling({ deletion: { assetId: asset, storageKey: key, deletedAt, removed: true } }), memoryStore()).remove('s', school, asset, {}),
    'a removed record must not carry a key');

  const source = readFileSync(join(__dirname, '../src/creative-studio/media/creative-media.controller.ts'), 'utf8');
  assert.match(source, /@Get\(':assetId\/view'\) @UseGuards\(SaasReadGuard\)/);
  assert.match(source, /@Post\(':assetId\/delete'\) @HttpCode\(200\) @UseGuards\(SaasCommandGuard\) @SaasCommandName\(SAAS_COMMANDS\.deleteCreativeAsset\)/);
  const wiring = readFileSync(join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(wiring, /provide: CREATIVE_MEDIA_STORE, useFactory: \(\) => new SupabaseCreativeMediaStore\(\)/);
  assert.match(wiring, /CreativeMediaController/);
});
