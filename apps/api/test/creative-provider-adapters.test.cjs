const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { HiggsfieldCreativeRuntime, HIGGSFIELD_API } = require('../dist/creative-studio/providers/higgsfield-runtime.js');
const { HeyGenCreativeRuntime } = require('../dist/creative-studio/providers/heygen-runtime.js');
const { CreativeProviderRouter, createCreativeProviderRuntime } = require('../dist/creative-studio/providers/creative-provider-router.js');
const { allowedDownloadUrl } = require('../dist/creative-studio/providers/creative-provider-http.js');
const { CreativeProviderRuntimeError, UnconfiguredCreativeProviderRuntime, isAsyncCreativeProviderRuntime } = require('../dist/creative-studio/creative-provider-runtime.js');
const { verifiedOutcome, thrownOutcome } = require('../dist/creative-studio/creative-outcome.js');
const { CreativeJobWorker } = require('../dist/creative-studio/creative-job-worker.js');

const HF_ENV = { HIGGSFIELD_API_KEY_ID: 'hf_key_id_0001', HIGGSFIELD_API_SECRET: 'hf_secret_value_0001', HON_CREATIVE_HIGGSFIELD_APPROVED: 'true' };
const HG_ENV = { HEYGEN_API_KEY: 'heygen_test_key_0000000001', HON_CREATIVE_HEYGEN_VOICE_ID: 'voice_1', HON_CREATIVE_HEYGEN_AVATAR_REALISTIC: 'avatar_real_1', HON_CREATIVE_HEYGEN_APPROVED: 'true' };
const HOSTS = ['cdn.example.test'];

/** A fake provider over real HTTP on 127.0.0.1: answers from a script and records every request. */
async function fakeProvider(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      requests.push(entry);
      const answer = handler(entry, requests.length);
      if (answer === 'HANG') return; // never answers (timeout)
      if (answer === 'DROP') { req.socket.destroy(); return; }
      res.writeHead(answer.status ?? 200, { 'content-type': answer.type ?? 'application/json', ...(answer.headers ?? {}) });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, requests, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}
const invocation = (patch = {}) => ({ providerId: 'HIGGSFIELD', modelCode: 'hf-image-soul-1', providerRequestId: randomUUID(), operationCode: 'image.generate',
  mediaKind: 'IMAGE', units: 2, format: 'SQUARE', prompt: 'A bright poster for our spring kids karate camp', ...patch });
const jobOf = (inv, providerJobId) => ({ providerId: inv.providerId, modelCode: inv.modelCode, providerJobId, operationCode: inv.operationCode,
  mediaKind: inv.mediaKind, units: inv.units, format: inv.format });
const rejects = (promise, outcome, reason) => assert.rejects(promise, e => e instanceof CreativeProviderRuntimeError && e.outcome === outcome && (!reason || e.reason === reason));
const plain = promise => assert.rejects(promise, e => !(e instanceof CreativeProviderRuntimeError));
const hf = (fake, env = HF_ENV, extra = {}) => new HiggsfieldCreativeRuntime(() => env, { baseUrl: fake?.baseUrl, downloadHosts: HOSTS, ...extra });
const hg = (fake, env = HG_ENV, extra = {}) => new HeyGenCreativeRuntime(() => env, { baseUrl: fake?.baseUrl, downloadHosts: HOSTS, ...extra });

test('readiness needs well-formed keys and the switch exactly "true"; routes are server-chosen', () => {
  assert.equal(hf(null).readiness(), 'READY');
  for (const env of [{}, { ...HF_ENV, HON_CREATIVE_HIGGSFIELD_APPROVED: 'TRUE' }, { ...HF_ENV, HON_CREATIVE_HIGGSFIELD_APPROVED: '1' },
    { ...HF_ENV, HIGGSFIELD_API_SECRET: undefined }, { ...HF_ENV, HIGGSFIELD_API_KEY_ID: 'bad key with spaces' }]) {
    const r = hf(null, env); assert.equal(r.readiness(), 'CONFIGURATION_REQUIRED'); assert.equal(r.route('image.generate'), null);
  }
  assert.deepEqual(hf(null).route('image.generate'), { providerId: 'HIGGSFIELD', modelCode: 'hf-image-soul-1' });
  assert.deepEqual(hf(null).route('avatar.create'), { providerId: 'HIGGSFIELD', modelCode: 'hf-image-soul-1' });
  assert.deepEqual(hf(null).route('video.generate'), { providerId: 'HIGGSFIELD', modelCode: 'hf-video-kling-1' });
  assert.equal(hf(null).route('avatar.video'), null);
  assert.equal(hg(null).readiness(), 'READY');
  assert.deepEqual(hg(null).route('avatar.video'), { providerId: 'HEYGEN', modelCode: 'heygen-avatar-iv-1' });
  assert.equal(hg(null).route('image.generate'), null);
  for (const drop of ['HEYGEN_API_KEY', 'HON_CREATIVE_HEYGEN_VOICE_ID', 'HON_CREATIVE_HEYGEN_AVATAR_REALISTIC', 'HON_CREATIVE_HEYGEN_APPROVED'])
    assert.equal(hg(null, { ...HG_ENV, [drop]: undefined }).readiness(), 'CONFIGURATION_REQUIRED', drop);
  assert.equal(hg(null, { ...HG_ENV, HON_CREATIVE_HEYGEN_AVATAR_REALISTIC: '../x' }).readiness(), 'CONFIGURATION_REQUIRED');
  assert.ok(isAsyncCreativeProviderRuntime(hf(null)) && isAsyncCreativeProviderRuntime(hg(null)));
});

test('Higgsfield image: one submit with only the prompt and fixed parameters, then poll to a verified result with downloads', async () => {
  const fake = await fakeProvider((r, n) => n === 1 ? { body: { request_id: 'req_abc123', status: 'queued' } }
    : n === 2 ? { body: { status: 'in_progress' } }
    : { body: { status: 'completed', images: [{ url: 'https://cdn.example.test/a.png' }, { url: 'https://img.cdn.example.test/b.png' }] } });
  try {
    const r = hf(fake), inv = invocation();
    assert.deepEqual(await r.submit(inv), { providerJobId: 'req_abc123' });
    const sent = fake.requests[0];
    assert.equal(sent.method, 'POST'); assert.equal(sent.url, HIGGSFIELD_API.models['hf-image-soul-1']);
    assert.equal(sent.headers.authorization, 'Key hf_key_id_0001:hf_secret_value_0001');
    assert.deepEqual(sent.body, { prompt: inv.prompt, aspect_ratio: '1:1', batch_size: 2 });
    assert.ok(!JSON.stringify(sent.body).includes(inv.providerRequestId), 'no HON identifier reaches the provider');
    const job = jobOf(inv, 'req_abc123');
    assert.deepEqual(await r.poll(job), { state: 'PENDING' });
    const done = await r.poll(job);
    assert.equal(fake.requests[2].url, '/requests/req_abc123/status'); assert.equal(fake.requests[2].method, 'GET');
    assert.equal(done.state, 'DONE');
    assert.deepEqual(done.downloads, [{ url: 'https://cdn.example.test/a.png', mediaType: 'image/png' }, { url: 'https://img.cdn.example.test/b.png', mediaType: 'image/png' }]);
    assert.equal(done.result.finalUnits, 2); assert.equal(done.result.providerCostMicrounits, 32000);
    assert.ok(!JSON.stringify(done.result).includes('cdn.example.test'), 'the provider URL is never part of the recorded result');
    const outcome = verifiedOutcome(done.result, { mediaKind: 'IMAGE', units: 2 });
    assert.equal(outcome.outcome, 'SUCCEEDED');
    assert.deepEqual(outcome.assets.map(a => a.providerAssetReference), ['hf:req_abc123:1', 'hf:req_abc123:2']);
  } finally { await fake.close(); }
});

test('Higgsfield video and avatar look: duration, aspect and the look style; never the avatar name', async () => {
  const fake = await fakeProvider((r, n) => n % 2 === 1 ? { status: 202, body: { request_id: `req_${n}` } }
    : { body: { status: 'completed', ...(r.url.includes('req_1') ? { video: { url: 'https://cdn.example.test/v.mp4' } } : { images: [{ url: 'https://cdn.example.test/p.png' }] }) } });
  try {
    const r = hf(fake);
    const video = invocation({ operationCode: 'video.generate', modelCode: 'hf-video-kling-1', mediaKind: 'VIDEO', units: 5, format: 'PORTRAIT' });
    await r.submit(video);
    assert.equal(fake.requests[0].url, HIGGSFIELD_API.models['hf-video-kling-1']);
    assert.deepEqual(fake.requests[0].body, { prompt: video.prompt, aspect_ratio: '9:16', duration: 5 });
    const v = await r.poll(jobOf(video, 'req_1'));
    assert.equal(verifiedOutcome(v.result, { mediaKind: 'VIDEO', units: 5 }).outcome, 'SUCCEEDED');
    assert.equal(v.result.providerCostMicrounits, 600000); assert.equal(v.result.assets[0].durationSeconds, 5);
    const look = invocation({ operationCode: 'avatar.create', units: 1, format: 'PORTRAIT', prompt: 'Calm, smiling, wears a black belt',
      avatar: { name: 'Coach Kim Secret Name', style: 'CHIBI' } });
    await r.submit(look);
    const body = fake.requests[2].body;
    assert.equal(body.aspect_ratio, '1:1'); assert.equal(body.batch_size, 1);
    assert.match(body.prompt, /^Cute chibi-style .*Calm, smiling, wears a black belt$/);
    assert.ok(!JSON.stringify(body).includes('Secret Name'));
    await rejects(r.submit(invocation({ operationCode: 'avatar.create', units: 1 })), 'PRE_SEND', 'INVALID_REQUEST');
  } finally { await fake.close(); }
});

test('submit answers: clear refusals FAILED, anything that may have been accepted UNKNOWN, misconfiguration never sent', async () => {
  const script = [];
  const fake = await fakeProvider(() => script.shift());
  try {
    const r = hf(fake, HF_ENV, { timeoutMs: 150 });
    for (const status of [400, 401, 402, 403, 422, 429]) { script.push({ status, body: { detail: 'no' } }); await rejects(r.submit(invocation()), 'FAILED', 'PROVIDER_REJECTED'); }
    for (const answer of [{ status: 500, body: {} }, { status: 503, body: {} }, { status: 409, body: {} }, { body: { request_id: '../evil id' } }, { body: {} },
      { body: 'not json', type: 'text/html' }, { body: 'x'.repeat(20_000) }, { status: 302, headers: { location: 'https://elsewhere.test/' }, body: {} }, 'HANG', 'DROP'])
    { script.push(answer); await rejects(r.submit(invocation()), 'UNKNOWN', 'PROVIDER_UNKNOWN'); }
    const sentBefore = fake.requests.length;
    await rejects(hf(fake, { ...HF_ENV, HON_CREATIVE_HIGGSFIELD_APPROVED: 'false' }).submit(invocation()), 'PRE_SEND', 'CONFIGURATION_REQUIRED');
    await rejects(r.submit(invocation({ modelCode: 'hf-video-kling-1' })), 'PRE_SEND', 'INVALID_REQUEST');
    await rejects(r.submit(invocation({ providerId: 'HEYGEN' })), 'PRE_SEND', 'INVALID_REQUEST');
    assert.equal(fake.requests.length, sentBefore, 'nothing is sent when not configured or mismatched');
    const unreachable = new HiggsfieldCreativeRuntime(() => HF_ENV, { baseUrl: 'http://127.0.0.1:1' });
    await rejects(unreachable.submit(invocation()), 'UNKNOWN');
    script.push({ status: 401, body: { detail: 'bad key hf_secret_value_0001' } });
    await assert.rejects(r.submit(invocation()), e => !String(e.message).includes('hf_secret_value_0001') && !String(e.stack).includes('hf_secret_value_0001'));
  } finally { await fake.close(); }
});

test('poll answers: only explicit final answers close a job; download URLs must be https on an allowed host', async () => {
  const script = [];
  const fake = await fakeProvider(() => script.shift());
  try {
    const r = hf(fake, HF_ENV, { timeoutMs: 150 }), job = jobOf(invocation(), 'req_1');
    for (const answer of [{ status: 500, body: {} }, { status: 404, body: {} }, { body: 'x', type: 'text/plain' }, { body: {} }, 'HANG']) { script.push(answer); await plain(r.poll(job)); }
    for (const status of ['failed', 'nsfw', 'canceled']) { script.push({ body: { status } }); await rejects(r.poll(job), 'FAILED', 'PROVIDER_REJECTED'); }
    script.push({ body: { status: 'exploded' } }); await rejects(r.poll(job), 'UNKNOWN');
    for (const images of [[], [{ url: 'http://cdn.example.test/a.png' }], [{ url: 'https://evil.test/a.png' }], [{ url: 'https://cdn.example.test.evil.test/a.png' }],
      [{ url: 'https://user:pw@cdn.example.test/a.png' }], [{ url: 'https://cdn.example.test:8443/a.png' }], [{}],
      [{ url: 'https://cdn.example.test/1.png' }, { url: 'https://cdn.example.test/2.png' }, { url: 'https://cdn.example.test/3.png' }]])
    { script.push({ body: { status: 'completed', images } }); await rejects(r.poll(job), 'UNKNOWN', 'PROVIDER_UNKNOWN'); }
    script.push({ body: { status: 'queued' } });
    assert.deepEqual(await hf(fake, { ...HF_ENV, HON_CREATIVE_HIGGSFIELD_APPROVED: 'false' }).poll(job), { state: 'PENDING' }, 'a submitted job is followed after the switch is off');
    const before = fake.requests.length;
    await plain(hf(fake, {}).poll(job)); await plain(r.poll({ ...job, providerJobId: '../x' })); await plain(r.poll({ ...job, providerId: 'HEYGEN' }));
    assert.equal(fake.requests.length, before);
    assert.equal(allowedDownloadUrl('https://cdn.example.test/a.png?sig=1', HOSTS), 'https://cdn.example.test/a.png?sig=1');
    assert.equal(allowedDownloadUrl('javascript:alert(1)', HOSTS), null);
  } finally { await fake.close(); }
});

test('HeyGen: stock avatar per look style and stock voice, X-Api-Key, charged by the second generated', async () => {
  const script = [];
  const fake = await fakeProvider(() => script.shift());
  try {
    const r = hg(fake, HG_ENV, { timeoutMs: 150 });
    const inv = invocation({ providerId: 'HEYGEN', modelCode: 'heygen-avatar-iv-1', operationCode: 'avatar.video', mediaKind: 'VIDEO', units: 30, format: 'PORTRAIT',
      prompt: 'Welcome to our dojo! Spring camp starts Monday.', avatar: { name: 'Coach Private Name', style: 'REALISTIC', description: 'calm' } });
    script.push({ body: { error: null, data: { video_id: 'vid_123' } } });
    assert.deepEqual(await r.submit(inv), { providerJobId: 'vid_123' });
    const sent = fake.requests[0];
    assert.equal(sent.url, '/v2/video/generate'); assert.equal(sent.headers['x-api-key'], HG_ENV.HEYGEN_API_KEY); assert.equal(sent.headers.authorization, undefined);
    assert.deepEqual(sent.body, { video_inputs: [{ character: { type: 'avatar', avatar_id: 'avatar_real_1', avatar_style: 'normal' },
      voice: { type: 'text', input_text: inv.prompt, voice_id: 'voice_1' } }], dimension: { width: 1080, height: 1920 } });
    assert.ok(!JSON.stringify(sent.body).includes('Private Name'));
    const job = jobOf(inv, 'vid_123');
    script.push({ body: { code: 100, data: { status: 'processing' } } });
    assert.deepEqual(await r.poll(job), { state: 'PENDING' });
    assert.equal(fake.requests[1].url, '/v1/video_status.get?video_id=vid_123');
    script.push({ body: { code: 100, data: { status: 'completed', video_url: 'https://cdn.example.test/v.mp4', duration: 28.4 } } });
    const done = await r.poll(job);
    assert.deepEqual(done.downloads, [{ url: 'https://cdn.example.test/v.mp4', mediaType: 'video/mp4' }]);
    assert.equal(done.result.finalUnits, 29); assert.equal(done.result.providerCostMicrounits, 29 * 80500);
    const ok = verifiedOutcome(done.result, { mediaKind: 'VIDEO', units: 30 });
    assert.equal(ok.outcome, 'SUCCEEDED'); assert.equal(ok.assets[0].providerAssetReference, 'heygen:vid_123:1');
    script.push({ body: { data: { status: 'completed', video_url: 'https://cdn.example.test/v.mp4', duration: 31.2 } } });
    assert.equal(verifiedOutcome((await r.poll(job)).result, { mediaKind: 'VIDEO', units: 30 }).outcome, 'UNKNOWN', 'longer than reserved is held for HQ, never charged silently');
    script.push({ body: { data: { status: 'failed', error: { message: 'policy' } } } }); await rejects(r.poll(job), 'FAILED', 'PROVIDER_REJECTED');
    for (const data of [{ status: 'completed', duration: 10 }, { status: 'completed', video_url: 'https://evil.test/v.mp4', duration: 10 }, { status: 'completed', video_url: 'https://cdn.example.test/v.mp4' }])
    { script.push({ body: { data } }); await rejects(r.poll(job), 'UNKNOWN'); }
    script.push({ status: 500, body: {} }); await plain(r.poll(job));
    const before = fake.requests.length;
    await rejects(r.submit({ ...inv, avatar: { ...inv.avatar, style: 'CHIBI' } }), 'PRE_SEND', 'CONFIGURATION_REQUIRED');
    await rejects(r.submit({ ...inv, operationCode: 'image.generate' }), 'PRE_SEND', 'INVALID_REQUEST');
    assert.equal(fake.requests.length, before, 'an unconfigured look style is never sent');
    for (const status of [401, 402, 429]) { script.push({ status, body: {} }); await rejects(r.submit(inv), 'FAILED'); }
    for (const answer of [{ status: 500, body: {} }, { body: { data: {} } }, { body: { data: { video_id: 'a b' } } }, 'HANG']) { script.push(answer); await rejects(r.submit(inv), 'UNKNOWN'); }
  } finally { await fake.close(); }
});

test('router: server picks the adapter per operation, jobs go only to the provider named on them', async () => {
  const router = new CreativeProviderRouter({ HIGGSFIELD: hf(null), HEYGEN: hg(null) });
  assert.equal(router.readiness(), 'READY');
  assert.equal(router.route('image.generate').providerId, 'HIGGSFIELD');
  assert.equal(router.route('avatar.video').providerId, 'HEYGEN');
  assert.equal(router.route('audio.generate'), null);
  const partly = new CreativeProviderRouter({ HIGGSFIELD: hf(null, {}), HEYGEN: hg(null) });
  assert.equal(partly.route('image.generate'), null); assert.equal(partly.route('avatar.video').providerId, 'HEYGEN');
  assert.equal(new CreativeProviderRouter({ HIGGSFIELD: hf(null, {}), HEYGEN: hg(null, {}) }).readiness(), 'CONFIGURATION_REQUIRED');
  await rejects(router.submit(invocation({ providerId: 'OTHER' })), 'PRE_SEND', 'CONFIGURATION_REQUIRED');
  await rejects(router.submit(invocation({ providerId: '__proto__' })), 'PRE_SEND');
  await plain(router.poll(jobOf(invocation({ providerId: 'toString' }), 'x1')));
  await rejects(router.generate(), 'PRE_SEND');
});

test('production wiring stays NOT_CONNECTED until HON storage exists, whatever keys and switches are set', () => {
  const all = () => ({ ...HF_ENV, ...HG_ENV });
  const off = createCreativeProviderRuntime({ mediaStorageReady: false, environment: all });
  assert.ok(off instanceof UnconfiguredCreativeProviderRuntime); assert.equal(off.readiness(), 'CONFIGURATION_REQUIRED');
  assert.ok(createCreativeProviderRuntime({ mediaStorageReady: 'yes', environment: all }) instanceof UnconfiguredCreativeProviderRuntime);
  const on = createCreativeProviderRuntime({ mediaStorageReady: true, environment: all });
  assert.ok(on instanceof CreativeProviderRouter); assert.equal(on.readiness(), 'READY');
  assert.equal(createCreativeProviderRuntime({ mediaStorageReady: true, environment: () => ({}) }).readiness(), 'CONFIGURATION_REQUIRED');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(source, /provide: CREATIVE_PROVIDER_RUNTIME, useFactory: \(\) => createCreativeProviderRuntime\(\{ mediaStorageReady: false \}\)/);
  const adapters = ['higgsfield-runtime.ts', 'heygen-runtime.ts', 'creative-provider-router.ts', 'creative-provider-http.ts']
    .map(f => require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/creative-studio/providers', f), 'utf8')).join('\n');
  assert.doesNotMatch(adapters, /console\.|emitTelemetry|process\.env\.HON_CREATIVE_[A-Z_]*BASE_URL/, 'no logging of provider traffic, no environment-set base URL');
});

test('worker: a real result with downloads is never recorded before HON storage exists (job stays open)', async () => {
  const fake = await fakeProvider(() => ({ body: { status: 'completed', images: [{ url: 'https://cdn.example.test/a.png' }] } }));
  try {
    const calls = [];
    const j = { jobId: randomUUID(), leaseToken: randomUUID(), providerId: 'HIGGSFIELD', providerJobId: 'req_1', modelCode: 'hf-image-soul-1', operationCode: 'image.generate',
      mediaKind: 'IMAGE', units: 1, format: 'SQUARE', pollCount: 0, deadlineAt: new Date(Date.now() + 60000).toISOString() };
    const store = { isConfigured: () => true, claim: async () => [j], recordPoll: async (...a) => { calls.push(['poll', ...a]); return { status: 'SUBMITTED' }; },
      recordResult: async (...a) => { calls.push(['result', ...a]); return { status: 'RECORDED' }; } };
    const summary = await new CreativeJobWorker(store, new CreativeProviderRouter({ HIGGSFIELD: hf(fake) })).runOnce();
    assert.deepEqual(summary, { claimed: 1, recorded: 0, heldForHq: 0, pending: 1, errors: 0 });
    assert.deepEqual(calls, [['poll', j.jobId, j.leaseToken]]);
    assert.equal(fake.requests.length, 1);
    assert.equal(thrownOutcome(new Error('x')).outcome, 'UNKNOWN');
  } finally { await fake.close(); }
});
