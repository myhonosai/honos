const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const contracts = require('@hon/contracts');
const { CreativeMediaService } = require('../dist/creative-studio/media/creative-media.controller.js');
const { inspectCreativeMedia, CreativeMediaRejected } = require('../dist/creative-studio/media/creative-media-inspect.js');
const { CreativeMediaIngest } = require('../dist/creative-studio/media/creative-media-store.js');

const U = () => randomUUID();
const T = '2026-11-15T04:00:00.000Z';

test('C4 prompt check: martial arts marketing passes; contact details, blocked terms and realistic children are refused', () => {
  const { checkCreativePrompt: check } = contracts;
  for (const ok of ['Adult kickboxing class sparring at sunset, energetic poster', 'Illustrated kids karate class celebrating new belts',
    '어린이 태권도 수업, 귀여운 일러스트', '무술 기술 연습하는 성인 수련생 사진', 'Clase de karate para adultos, foto dinámica', 'Bo staff and nunchaku forms demo, photo',
    'A kid-friendly chibi mascot doing a front kick', 'Photo of the dojo at sunrise, 2026 open house'])
    assert.deepEqual(check(ok), { allowed: true, reason: null }, ok);
  for (const [text, reason] of [['Visit www.example.com for a free class', 'CONTACT_OR_LINK'], ['Call 555-123-4567 today', 'CONTACT_OR_LINK'],
    ['email coach@school.test', 'CONTACT_OR_LINK'], ['https://evil.test/x.png', 'CONTACT_OR_LINK'],
    ['sexy fighter poster', 'BLOCKED_TERM'], ['bloody knockout', 'BLOCKED_TERM'], ['Fighter holding a gun', 'BLOCKED_TERM'], ['Nike logo on the mat', 'BLOCKED_TERM'],
    ['Bruce Lee teaching a class', 'BLOCKED_TERM'], ['선정적인 포스터', 'BLOCKED_TERM'], ['맥주 광고', 'BLOCKED_TERM'], ['cerveza y karate', 'BLOCKED_TERM'],
    ['NUDE', 'BLOCKED_TERM'], ['ｎｕｄｅ', 'BLOCKED_TERM'],
    ['Realistic photo of a child doing karate', 'REALISTIC_CHILD'], ['photorealistic kids class', 'REALISTIC_CHILD'], ['어린이 태권도 실사 사진', 'REALISTIC_CHILD'],
    ['Foto realista de niños en clase', 'REALISTIC_CHILD']])
    assert.deepEqual(check(text), { allowed: false, reason }, text);
  assert.equal(check('A cheerful boy instructor mascot', { realisticStyle: true }).reason, 'REALISTIC_CHILD');
  assert.equal(check('A cheerful boy instructor mascot', { realisticStyle: false }).allowed, true);
});

test('C4 contracts: review input, review answer and queue are closed; assets carry their review status', () => {
  const { validateCreativeAssetReviewInput: input, validateCreativeAssetReview: review, validateCreativeReviewQueue: queue } = contracts;
  assert.deepEqual(input({ decision: 'APPROVED' }), { decision: 'APPROVED' });
  for (const bad of [null, [], {}, { decision: 'approved' }, { decision: 'PENDING_REVIEW' }, { decision: 'REJECTED', note: 'x' }]) assert.throws(() => input(bad));
  const ok = { assetId: U(), review: 'REJECTED', reviewedAt: T, reviewedBySelf: true };
  assert.deepEqual(review(ok), ok);
  for (const bad of [{ ...ok, review: 'PENDING_REVIEW' }, { ...ok, reviewedBy: U() }, { ...ok, reviewedBySelf: 1 }]) assert.throws(() => review(bad));
  const item = (storedAt, patch = {}) => ({ assetId: U(), generationId: U(), ordinal: 1, mediaType: 'image/png', width: 1024, height: 1024, durationSeconds: null, storedAt, requestedBySelf: false, ...patch });
  const a = item(T), b = item('2026-11-15T04:01:00.000Z', { mediaType: 'video/mp4', durationSeconds: 5 });
  assert.doesNotThrow(() => queue({ limit: 50, assets: [a, b] }));
  for (const bad of [{ limit: 50, assets: [b, a] }, { limit: 1, assets: [a, b] }, { limit: 51, assets: [] }, { limit: 50, assets: [a, a] },
    { limit: 50, assets: [{ ...a, storageKey: 'creative/x/1' }] }, { limit: 50, assets: [{ ...a, prompt: 'x' }] }, { limit: 50, assets: [item(T, { mediaType: 'video/mp4' })] }])
    assert.throws(() => queue(bad), JSON.stringify(bad));
});

function service(answer) {
  const calls = [];
  const billing = { async call(operation, params, validate) { calls.push({ operation, params }); return validate(await answer(operation, params)); } };
  const store = { readiness: () => 'READY', async signedReadUrl() { return 'https://storage.example/x'; }, async remove() {} };
  return { svc: new CreativeMediaService(billing, store), calls };
}

test('C4 API: review passes the decision through the database command; bad input never reaches the database', async () => {
  const school = U(), asset = U();
  const { svc, calls } = service(async (op, p) => ({ assetId: p[2], review: p[3], reviewedAt: T, reviewedBySelf: false }));
  assert.deepEqual(await svc.review('sub', school, asset, { decision: 'APPROVED' }), { assetId: asset, review: 'APPROVED', reviewedAt: T, reviewedBySelf: false });
  assert.deepEqual(calls, [{ operation: 'reviewCreativeAsset', params: ['sub', school, asset, 'APPROVED'] }]);
  for (const body of [{}, { decision: 'OK' }, { decision: 'APPROVED', by: 'ai' }]) await assert.rejects(svc.review('sub', school, asset, body), e => e.getStatus() === 400);
  await assert.rejects(svc.review('sub', 'x', asset, { decision: 'APPROVED' }), e => e.getStatus() === 400);
  assert.equal(calls.length, 1);
  const wrong = service(async () => ({ assetId: U(), review: 'APPROVED', reviewedAt: T, reviewedBySelf: false }));
  await assert.rejects(wrong.svc.review('sub', school, asset, { decision: 'APPROVED' }), e => e.getStatus() === 503);
});

test('C4 API: the review queue limit is bounded and echoed', async () => {
  const school = U();
  const { svc, calls } = service(async (op, p) => ({ limit: Number(p[2]), assets: [] }));
  assert.deepEqual(await svc.queue('sub', school, undefined), { limit: 50, assets: [] });
  assert.deepEqual(await svc.queue('sub', school, '10'), { limit: 10, assets: [] });
  for (const limit of ['0', '51', '1.5', 'abc', '010', ['5']]) await assert.rejects(svc.queue('sub', school, limit), e => e.getStatus() === 400, String(limit));
  assert.deepEqual(calls.map(c => c.params[2]), ['50', '10']);
});

function box(type, ...parts) { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(body.length + 8); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); }
test('C3 follow-ups: a truncated MP4 box is a rejection (never a retry); uuid boxes and unknown WebP chunks are removed', () => {
  const ftyp = box('ftyp', Buffer.from('isom0000isomiso2', 'latin1')), mdat = box('mdat', Buffer.alloc(16));
  assert.throws(() => inspectCreativeMedia(Buffer.concat([ftyp, box('moov', box('mvhd', Buffer.alloc(8))), mdat]), 'VIDEO'), e => e instanceof CreativeMediaRejected);
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(5000, 16);
  assert.throws(() => inspectCreativeMedia(Buffer.concat([ftyp, box('moov', box('mvhd', mvhd), box('trak', box('mdia', box('hdlr', Buffer.alloc(4))))), mdat]), 'VIDEO'),
    e => e instanceof CreativeMediaRejected);
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(640 << 16, 76); tkhd.writeUInt32BE(360 << 16, 80);
  const hdlr = Buffer.alloc(24); hdlr.write('vide', 8, 'latin1');
  const xmp = box('uuid', Buffer.from('be7acfcb97a942e89c71999491e3afac<x:xmpmeta>provider-secret</x:xmpmeta>', 'latin1'));
  const out = inspectCreativeMedia(Buffer.concat([ftyp, xmp, box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd), box('mdia', box('hdlr', hdlr)))), mdat]), 'VIDEO');
  assert.ok(!out.bytes.includes(Buffer.from('provider-secret')) && out.width === 640 && out.durationSeconds === 5);
  const riff = (type, data) => { const h = Buffer.alloc(8); h.write(type, 0, 'latin1'); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const vp8l = Buffer.alloc(10); vp8l[0] = 0x2f; vp8l.writeUInt32LE(((320 - 1) & 0x3fff) | (((240 - 1) & 0x3fff) << 14), 1);
  const body = Buffer.concat([riff('VP8L', vp8l), riff('C2PA', Buffer.from('provider-claim'))]);
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  const w = inspectCreativeMedia(Buffer.concat([head, body]), 'IMAGE');
  assert.ok(!w.bytes.includes(Buffer.from('provider-claim')) && w.width === 320 && w.bytes.readUInt32LE(4) + 8 === w.bytes.length);
});

test('C3 follow-up: a result rejected part-way removes the files it already stored', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    (() => { const d = Buffer.alloc(13); d.writeUInt32BE(64, 0); d.writeUInt32BE(64, 4); const l = Buffer.alloc(4); l.writeUInt32BE(13); return Buffer.concat([l, Buffer.from('IHDR'), d, Buffer.alloc(4)]); })(),
    Buffer.from([0, 0, 0, 1]), Buffer.from('IDAT'), Buffer.from([1]), Buffer.alloc(4), Buffer.from([0, 0, 0, 0]), Buffer.from('IEND'), Buffer.alloc(4)]);
  const bodies = [png, Buffer.from('not an image at all, just text')];
  let n = 0;
  const send = async () => new Response(bodies[n++], { status: 200 });
  const puts = [], removes = [];
  const store = { readiness: () => 'READY', async put(k) { puts.push(k); }, async remove(k) { removes.push(k); }, async signedReadUrl() { return ''; } };
  const ingest = new CreativeMediaIngest(store, { send });
  const job = { jobId: U(), mediaKind: 'IMAGE' };
  const dl = { url: 'https://files.example/a', mediaType: 'image/png', allowedHosts: ['files.example'] };
  const claimed = { mediaType: 'image/png', width: 64, height: 64, durationSeconds: null, providerAssetReference: 'p1' };
  await assert.rejects(ingest.ingest(job, [dl, dl], [claimed, claimed]), e => e instanceof CreativeMediaRejected);
  assert.deepEqual(puts, [`creative/${job.jobId}/1`]);
  assert.deepEqual(removes, puts);
});

test('C4 API: a refused prompt, avatar description or script is refused before anything is reserved', async () => {
  const { CreativeStudioService } = require('../dist/creative-studio/creative-studio.service.js');
  const { SyntheticCreativeProviderRuntime } = require('../dist/creative-studio/creative-provider-runtime.js');
  const calls = [];
  const billing = { async call(operation) { calls.push(operation); throw new Error(`unexpected ${operation}`); } };
  const svc = new CreativeStudioService(billing, new SyntheticCreativeProviderRuntime());
  const code = e => e.getStatus() === 400 && e.getResponse().code === 'CREATIVE_PROMPT_NOT_ALLOWED';
  await assert.rejects(svc.create('sub', U(), { operationCode: 'image.generate', units: 1, format: 'SQUARE', prompt: 'Realistic photo of kids sparring' }, U()), code);
  await assert.rejects(svc.createAvatar('sub', U(), { name: 'Coach', style: 'REALISTIC', description: 'A friendly teenage girl coach' }, U()), code);
  await assert.rejects(svc.createAvatarVideo('sub', U(), { avatarId: U(), script: 'Call 555 123 4567 to book', seconds: 10, format: 'PORTRAIT' }, U()), code);
  assert.deepEqual(calls, []);
});
