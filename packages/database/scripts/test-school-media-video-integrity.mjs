/**
 * School videos proof (BL3c, 0654) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards + global
 * ValidationPipe + HonExceptionFilter -> SchoolMediaController / PublicSchoolMediaController / SchoolBlastController ->
 * protected definer functions on the restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture
 * only. Storage is the real MediaStorage client pointed at an in-memory stand-in, and the copy job is the real
 * SchoolVideoCopyWorker on the runtime role with a stand-in for ffmpeg (no network, no program run, nothing paid).
 * Synthetic videos, contacts and rows only.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CRM_CLOSE_OWNER_ROLE, CRM_CLOSE_RUNTIME_ROLE, crmCloseProofTargets, verifyCrmCloseProofConnection } from './crm-close-proof-target.mjs';
import { membershipFixtureStatement } from './membership-activation-test-support.mjs';

await import('./test-crm-close-proof-target.mjs');
const targets = crmCloseProofTargets(process.env);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(resolve(repo, 'apps/api/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing');
const { ValidationPipe } = apiRequire('@nestjs/common');
const { HttpAdapterHost } = apiRequire('@nestjs/core');
const express = apiRequire('express');
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonExceptionFilter } = await load('observability/http-telemetry.js');
const { SchoolMediaController, PublicSchoolMediaController } = await load('school-media/school-media.controller.js');
const { SchoolMediaService } = await load('school-media/school-media.service.js');
const { MediaStorage } = await load('school-media/media-storage.js');
const { schoolMediaUploadTransport, publicMediaTransport } = await load('school-media/school-media-transport.js');
const { SchoolVideoCopyWorker } = await load('school-media/school-video-copy.js');
const { SchoolBlastController } = await load('school-blasts/school-blast.controller.js');
const { SchoolBlastService } = await load('school-blasts/school-blast.service.js');
const { PublicClientLimit } = await load('schedule/public-client-limit.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-video', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
const SERVICE = '00000000-0000-4000-8000-000000000654';

// In-memory stand-in for the private bucket, behind the real storage client (its URLs, headers and checks).
const STORE = new Map();
const calls = [];
const settings = { baseUrl: 'https://media.example.test', key: 'k'.repeat(40), bucket: 'hon-media' };
const KEY = '(media\\/[0-9a-f-]{36}(?:\\.720\\.mp4|\\.poster\\.jpg)?)';
const storage = MediaStorage.withSettings(settings, async (url, init) => {
  const path = new URL(url).pathname;
  calls.push({ path, method: init.method, range: init.headers?.Range });
  let m;
  if ((m = path.match(new RegExp(`^/storage/v1/object/upload/sign/hon-media/${KEY}$`))) && init.method === 'POST') {
    return new Response(JSON.stringify({ url: `/object/upload/sign/hon-media/${m[1]}?token=${'u'.repeat(32)}` }), { status: 200 });
  }
  if ((m = path.match(new RegExp(`^/storage/v1/object/sign/hon-media/${KEY}$`))) && init.method === 'POST') {
    return new Response(JSON.stringify({ signedURL: `/object/sign/hon-media/${m[1]}?token=${'s'.repeat(32)}` }), { status: 200 });
  }
  if ((m = path.match(new RegExp(`^/storage/v1/object/authenticated/hon-media/${KEY}$`))) && init.method === 'GET') {
    const file = STORE.get(m[1]);
    if (!file) return new Response('{"statusCode":"404"}', { status: 400 });
    const r = /^bytes=0-(\d+)$/.exec(init.headers.Range ?? '');
    const end = Math.min(Number(r[1]), file.bytes.length - 1);
    return new Response(file.bytes.subarray(0, end + 1), { status: 206, headers: { 'content-range': `bytes 0-${end}/${file.bytes.length}` } });
  }
  if ((m = path.match(new RegExp(`^/storage/v1/object/hon-media/${KEY}$`))) && init.method === 'POST') {
    STORE.set(m[1], { bytes: Buffer.from(await new Response(init.body).arrayBuffer()), type: init.headers['Content-Type'] });
    return new Response('{}', { status: 200 });
  }
  if (path === '/storage/v1/object/hon-media' && init.method === 'DELETE') { for (const key of JSON.parse(init.body).prefixes) STORE.delete(key); return new Response('[]', { status: 200 }); }
  return new Response('{}', { status: 400 });
});
const switchStorage = (on) => Object.assign(storage, { fixed: on ? settings : null });

let app, origin;
const database = new RuntimeDatabaseService();
async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [SchoolMediaController, PublicSchoolMediaController, SchoolBlastController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolMediaService, SchoolBlastService, { provide: MediaStorage, useValue: storage }, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  app.use(publicMediaTransport(new PublicClientLimit(null)));
  app.use(schoolMediaUploadTransport());
  app.use(express.json({ limit: '2mb', strict: true }));
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
function request(target, method, headers, payload) {
  return new Promise((resolvePromise, reject) => {
    const sent = http.request(target, { method, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; } resolvePromise({ status: response.statusCode, headers: response.headers, body }); });
    });
    sent.on('error', reject);
    if (payload !== undefined) sent.write(payload);
    sent.end();
  });
}
function call(actor, method, area, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org, path = '' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/marketing/${area}${path}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...(payload !== undefined ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return request(target, method, sent, payload);
}
const list = (actor, options = {}) => call(actor, 'GET', 'media', options);
const begin = (actor, body, options = {}) => call(actor, 'POST', 'media', { path: '/video/begin', command: 'marketing_media.video_begin', body, ...options });
const finish = (actor, body, options = {}) => call(actor, 'POST', 'media', { path: '/video/finish', command: 'marketing_media.video_finish', body, ...options });
const remove = (actor, body, options = {}) => call(actor, 'POST', 'media', { path: '/delete', command: 'marketing_media.delete', body, ...options });
const save = (actor, body, options = {}) => call(actor, 'POST', 'blasts', { command: 'marketing_blast.save', body, ...options });
const send = (actor, body, options = {}) => call(actor, 'POST', 'blasts', { path: '/send', command: 'marketing_blast.send', body, ...options });
const open = (token, suffix = '') => request(new URL(`${origin}/v1/public/media/${token}${suffix}`), 'GET', {});
async function success(run, label) {
  const { status, body, headers } = await run();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  return body;
}
async function refused(run, expectedStatus, expectedCode, label) {
  const { status, body } = await run();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body?.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!body || !('data' in body), `${label}: a refusal returns no data`);
}
async function rejectsSql(run, pattern, label) {
  await sql('BEGIN');
  try { await run(); } catch (error) { await sql('ROLLBACK'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK');
  assert.fail(`${label}: expected a refusal`);
}

/** A synthetic phone video: an ISO base media ftyp box, then padding. A WebM starts with the EBML magic. */
const mp4 = (size) => { const b = Buffer.alloc(size); b.writeUInt32BE(24, 0); b.write('ftypqt  ', 4, 'latin1'); b.write('Coach Dana at 34.05N', 40, 'latin1'); return b; };
const notVideo = (size) => { const b = Buffer.alloc(size, 0x41); b.write('<html><script>', 0, 'latin1'); return b; };
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAIABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAFF/f//Z', 'base64');

// The copy job's programs, stood in: the copy is written, probed and given a poster frame; each call is recorded.
const runs = [];
let failTools = false;
const tools = {
  ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', allowHttp: false,
  run: async (command, args) => {
    runs.push({ command, args: [...args] });
    if (args[0] === '-version') return `${command} version stand-in`;
    if (failTools) throw new Error('PROCESS_FAILED');
    if (command === 'ffprobe') return JSON.stringify({ streams: [{ width: 1280, height: 720 }], format: { duration: '65.4' } });
    if (args.includes('-movflags')) { await writeFile(args.at(-1), Buffer.alloc(7000, 7)); return ''; }
    if (args.includes('-frames:v')) { await writeFile(args.at(-1), JPEG); return ''; }
    throw new Error('unexpected program call');
  },
};
const worker = new SchoolVideoCopyWorker(database, storage).withTools(tools);

// Disposable-fixture cleanup only (as in the 0478 proof).
async function cleanup(orgs = [ids.organization, ids.otherOrganization], subjects = `%video-${ids.organization}-%`) {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  await sql('SET CONSTRAINTS ALL IMMEDIATE');
  try {
    for (let pass = 0; pass < 10; pass += 1) {
      let failed = 0;
      for (const table of tables) {
        await sql('SAVEPOINT cleanup_table');
        try {
          await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [orgs]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    const left = (await sql('SELECT count(*)::int n FROM hon.school_media_assets WHERE organization_id = ANY($1::uuid[])', [orgs])).rows[0].n;
    if (left) throw new Error('fixture cleanup left a video behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [subjects]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [subjects]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [subjects]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [orgs]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

const allPermissions = (await sql('SELECT code FROM hon.permissions ORDER BY code')).rows.map((row) => row.code);
async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roles, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `video-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Video Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [principal, user, `Coach ${label}`]);
  for (const roleId of roles) {
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [randomUUID(), org, school, principal, roleId]);
  }
  return { subject, principal, org, school, label };
}
async function person(given, { school = ids.schoolA, org = ids.organization } = {}) {
  const id = randomUUID();
  await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,$4,$5,$6)', [id, org, school, given, 'Lee', `${given.toLowerCase()}@example.test`]);
  await sql("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,'EMAIL','OPTED_IN','STAFF',clock_timestamp(),$4)", [org, school, id, OWN.principal]);
  const billing = randomUUID();
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [billing, org, school, id]);
  await sql('BEGIN');
  await membershipFixtureStatement(admin, "INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state) VALUES($1,$2,$3,$4,'FIXTURE','ACTIVE')", [org, school, billing, id]);
  await sql('COMMIT');
  return id;
}

let OWN, MANAGER, READER, OWN_B, SENDER;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Video Org','Video Org'),($2,'Video Other Org','Video Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug, name] of [[ids.schoolA, ids.organization, 'a', 'Tiger Dojo'], [ids.schoolB, ids.organization, 'b', 'Crane Dojo'], [ids.otherSchool, ids.otherOrganization, 'o', 'Other Dojo']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, name, `video-${slug}-${school.slice(0, 8)}`]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  MANAGER = await staff('manager', [await role(ids.organization, ['marketing.media.manage', 'marketing.media.read'])]);
  READER = await staff('reader', [await role(ids.organization, ['marketing.media.read'])]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['marketing.media.manage', 'marketing.media.read', 'marketing.blast.send', 'marketing.blast.read'])], { school: ids.schoolB });
  SENDER = await staff('sender', [await role(ids.organization, ['marketing.blast.send', 'marketing.blast.read'])]);
}
/** Fixture-only time travel on one row (triggers off inside one transaction, as in cleanup). */
async function fixture(text, values) {
  await sql('BEGIN');
  await sql('ALTER TABLE hon.school_media_assets DISABLE TRIGGER USER');
  await sql(text, values);
  await sql('ALTER TABLE hon.school_media_assets ENABLE TRIGGER USER');
  await sql('COMMIT');
}
const row = async (assetId) => (await sql('SELECT * FROM hon.school_media_assets WHERE id=$1', [assetId])).rows[0];
const VIDEO = { title: 'Belt test highlights', mediaType: 'video/quicktime', byteSize: 6000 };
/** Begin, the browser's PUT (into the stand-in bucket), and finish: a READY video with its copy QUEUED. */
async function uploaded(actor = MANAGER, input = VIDEO, bytes = mp4(input.byteSize)) {
  const started = (await success(() => begin(actor, input), 'begin')).data;
  STORE.set(`media/${started.asset.assetId}`, { bytes, type: input.mediaType });
  return (await success(() => finish(actor, { assetId: started.asset.assetId }), 'finish')).data;
}
const sweep = async () => { const out = []; for (let i = 0; i < 10; i += 1) { const r = await worker.runOnce(); if (r === 'NONE') break; out.push(r); } return out; };

try {
  await cleanup();
  await seed();
  await startApp();
  process.env.HON_MEDIA_VIDEO_COPIES_APPROVED = 'true';

  // 0. The code-owned copy service principal, and the table rules.
  ok((await sql("SELECT count(*)::int n FROM hon.principals WHERE id=$1 AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL", [SERVICE])).rows[0].n === 1, 'the 0654 service principal exists');

  // 1. Begin: a PENDING video with the fixed key and a one-time upload link for exactly that key.
  const beginKey = randomUUID();
  const started = await success(() => begin(MANAGER, VIDEO, { key: beginKey }), 'begin');
  const v1 = started.data.asset;
  ok(v1.kind === 'VIDEO' && v1.state === 'PENDING' && v1.linkToken === null && v1.copyState === null && v1.byteSize === 6000 && started.meta.replayed === false, 'PENDING video, no link');
  ok(started.data.uploadUrl === `https://media.example.test/storage/v1/object/upload/sign/hon-media/media/${v1.assetId}?token=${'u'.repeat(32)}`, 'the upload link names media/<id> only');
  const r1 = await row(v1.assetId);
  ok(r1.object_key === `media/${v1.assetId}` && r1.sha256 === null && r1.width === null && r1.copy_state === null, 'row: fixed key, no checksum or size yet');
  const again = await success(() => begin(MANAGER, VIDEO, { key: beginKey }), 'begin replay');
  ok(again.meta.replayed === true && again.data.asset.assetId === v1.assetId && again.data.uploadUrl, 'a replay signs a fresh link for the same video');
  await refused(() => begin(MANAGER, { ...VIDEO, byteSize: 7000 }, { key: beginKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another video');
  await refused(() => begin(READER, VIDEO), 403, 'SCHOOL_MEDIA_FORBIDDEN', 'read-only staff cannot upload');
  await refused(() => begin(OWN_B, VIDEO, { school: ids.schoolA }), 403, 'SCHOOL_MEDIA_FORBIDDEN', 'another school cannot upload here');
  await refused(() => begin(MANAGER, { ...VIDEO, mediaType: 'application/x-mpegurl' }), 400, 'VALIDATION_FAILED', 'a playlist type is refused');
  await refused(() => begin(MANAGER, { ...VIDEO, byteSize: 5368709121 }), 400, 'VALIDATION_FAILED', 'over 5 GB refused');
  await refused(() => begin(MANAGER, { ...VIDEO, objectKey: 'media/x' }), 400, undefined, 'no caller-chosen key');
  await refused(() => begin(MANAGER, VIDEO, { command: 'marketing_media.upload' }), 403, 'HUMAN_UI_REQUIRED', 'wrong command');
  await refused(() => begin(MANAGER, VIDEO, { headers: { Origin: 'https://evil.example' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-origin');
  switchStorage(false);
  await refused(() => begin(MANAGER, { ...VIDEO, title: 'Off' }), 503, 'MEDIA_STORAGE_OFF', 'storage off');
  switchStorage(true);
  ok((await sql("SELECT count(*)::int n FROM hon.school_media_assets WHERE organization_id=$1 AND title='Off'", [ids.organization])).rows[0].n === 0, 'storage off reserves nothing');

  // 2. Finish: the stored file must be there, of the started size, and look like a video.
  await refused(() => finish(MANAGER, { assetId: v1.assetId }), 409, 'MEDIA_UPLOAD_MISSING', 'nothing uploaded yet');
  STORE.set(`media/${v1.assetId}`, { bytes: mp4(5999), type: 'video/quicktime' });
  await refused(() => finish(MANAGER, { assetId: v1.assetId }), 409, 'MEDIA_UPLOAD_MISMATCH', 'a file of another size');
  ok(calls.filter((c) => c.method === 'GET').every((c) => c.range === 'bytes=0-4095'), 'the check reads only the first 4 KiB');
  STORE.set(`media/${v1.assetId}`, { bytes: mp4(6000), type: 'video/quicktime' });
  await refused(() => finish(READER, { assetId: v1.assetId }), 403, 'SCHOOL_MEDIA_FORBIDDEN', 'read-only staff cannot finish');
  await refused(() => finish(MANAGER, { assetId: v1.assetId, byteSize: 6000 }), 400, undefined, 'finish takes only the id');
  const done1 = await success(() => finish(MANAGER, { assetId: v1.assetId }), 'finish');
  ok(done1.data.state === 'READY' && done1.data.copyState === 'QUEUED' && done1.data.linkToken === null && done1.data.version === 2, 'READY with the copy QUEUED and still no link');
  ok((await success(() => finish(MANAGER, { assetId: v1.assetId }), 'finish again')).data.state === 'READY', 'a repeated finish answers as it is');
  ok((await open(r1.link_token)).status === 404 && (await open(r1.link_token, '/poster')).status === 404 && (await open(r1.link_token, '/page')).status === 404,
    'nothing public before the copy is done (never the original)');
  // A file that is not a video: refused, abandoned, every file removed.
  const fake = (await success(() => begin(MANAGER, { ...VIDEO, title: 'Not a video', mediaType: 'video/mp4' }), 'begin fake')).data.asset;
  STORE.set(`media/${fake.assetId}`, { bytes: notVideo(6000), type: 'video/mp4' });
  await refused(() => finish(MANAGER, { assetId: fake.assetId }), 400, 'MEDIA_VIDEO_REFUSED', 'a page posing as a video');
  ok(!STORE.has(`media/${fake.assetId}`) && ['DELETED', 'REMOVED'].includes((await row(fake.assetId)).state), 'the posing file is removed and the video abandoned');
  const webm = Buffer.alloc(3000); webm.writeUInt32BE(0x1a45dfa3, 0);
  const w = await uploaded(MANAGER, { title: 'Sparring', mediaType: 'video/webm', byteSize: 3000 }, webm);
  ok(w.copyState === 'QUEUED', 'a WebM is accepted by its EBML header');

  // 3. The copy job on the runtime role: claim, copy, poster, record.
  const outcomes = await sweep();
  ok(outcomes.length === 2 && outcomes.every((o) => o === 'DONE'), `both copies made ${outcomes}`);
  const copyRun = runs.find((r) => r.command === 'ffmpeg' && r.args.includes('-movflags'));
  ok(copyRun.args[copyRun.args.indexOf('-f') + 1] === 'mov' && copyRun.args[copyRun.args.indexOf('-protocol_whitelist') + 1] === 'https,tls,tcp', 'a fixed demuxer and https only');
  ok(copyRun.args[copyRun.args.indexOf('-i') + 1] === `https://media.example.test/storage/v1/object/sign/hon-media/media/${v1.assetId}?token=${'s'.repeat(32)}`, 'the original is read through a short signed link');
  ok(['-map_metadata', '-map_chapters'].every((f) => copyRun.args[copyRun.args.indexOf(f) + 1] === '-1'), 'no metadata or chapters carried over');
  ok(runs.some((r) => r.command === 'ffmpeg' && r.args.includes('webm') === false && r.args[r.args.indexOf('-f') + 1] === 'matroska'), 'WebM is read as matroska');
  const r2 = await row(v1.assetId);
  ok(r2.copy_state === 'DONE' && r2.width === 1280 && r2.height === 720 && r2.duration_ms === 65400 && Number(r2.copy_bytes) === 7000 && r2.copy_lease === null && r2.copy_done_at, 'the facts are recorded');
  const copy = STORE.get(`media/${v1.assetId}.720.mp4`), poster = STORE.get(`media/${v1.assetId}.poster.jpg`);
  ok(copy?.type === 'video/mp4' && copy.bytes.length === 7000 && poster?.type === 'image/jpeg' && Number(r2.poster_bytes) === poster.bytes.length, 'copy and poster stored under their fixed keys');
  ok(!poster.bytes.includes(Buffer.from('Lavc')), 'the poster is cleaned like any picture');
  const lib = (await success(() => list(READER), 'library')).data;
  const listed = lib.assets.find((a) => a.assetId === v1.assetId);
  ok(listed.linkToken === r1.link_token && listed.durationMs === 65400 && listed.width === 1280 && !('objectKey' in listed), 'the library shows the copy facts and the link');
  ok(lib.usage.storedBytes >= 6000 + 7000 + poster.bytes.length + 3000, `usage counts original, copy and poster ${lib.usage.storedBytes}`);

  // 4. Public: the 720p copy, its poster and the page; never the original.
  const link = await open(r1.link_token);
  ok(link.status === 302 && link.headers.location === `https://media.example.test/storage/v1/object/sign/hon-media/media/${v1.assetId}.720.mp4?token=${'s'.repeat(32)}`, 'the link opens the copy');
  const posterLink = await open(r1.link_token, '/poster');
  ok(posterLink.status === 302 && posterLink.headers.location.includes(`media/${v1.assetId}.poster.jpg?`), 'the poster link');
  const page = await open(r1.link_token, '/page');
  ok(page.status === 200 && JSON.stringify(page.body) === JSON.stringify({ data: { schoolName: 'Tiger Dojo', title: 'Belt test highlights', width: 1280, height: 720, durationMs: 65400 } }), `the page shows only name, title and size ${JSON.stringify(page.body)}`);
  ok(page.headers['cache-control'] === 'no-store', 'the page answer is never cached');
  { const a = (await open(r1.link_token, '/original')).status, b = (await open('B'.repeat(43), '/page')).status; ok([400, 404].includes(a) && b === 404, `nothing else is reachable ${a} ${b}`); }
  const picture = (await sql(`INSERT INTO hon.school_media_assets(id,organization_id,school_id,kind,media_type,title,byte_size,sha256,width,height,object_key,link_token,created_by_principal_id)
    SELECT n.id,$1,$2,'IMAGE','image/png','Pic',10,repeat('a',64),2,2,'media/'||n.id,rtrim(translate(encode(gen_random_bytes(32),'base64'),'+/','-_'),'='),$3 FROM (SELECT gen_random_uuid() id) n RETURNING id,link_token`,
    [ids.organization, ids.schoolA, OWN.principal])).rows[0];
  await sql("UPDATE hon.school_media_assets SET state='READY',ready_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1", [picture.id]);
  ok((await open(picture.link_token, '/poster')).status === 404 && (await open(picture.link_token, '/page')).status === 404 && (await open(picture.link_token)).status === 302, 'a picture has no poster or page');
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.schoolA]);
  ok((await open(r1.link_token)).status === 404 && (await open(r1.link_token, '/page')).status === 404, 'a suspended school serves nothing');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.schoolA]);

  // 5. Retries, failure after the third try, a lost lease and a video deleted mid-copy.
  const v3 = await uploaded(MANAGER, { ...VIDEO, title: 'Will fail' });
  failTools = true;
  for (let i = 1; i <= 3; i += 1) {
    ok(await worker.runOnce() === 'RETRY', `try ${i} goes back`);
    ok((await row(v3.assetId)).copy_state === (i < 3 ? 'QUEUED' : 'FAILED') && (await row(v3.assetId)).copy_attempts === i, `after try ${i}`);
  }
  failTools = false;
  ok(await worker.runOnce() === 'NONE' && !STORE.has(`media/${v3.assetId}.720.mp4`), 'a FAILED copy is not taken again and stored nothing');
  ok((await success(() => list(READER), 'failed listed')).data.assets.find((a) => a.assetId === v3.assetId).copyState === 'FAILED', 'staff see it failed');
  const v4 = await uploaded(MANAGER, { ...VIDEO, title: 'Lease' });
  const claim = (await runtime.query('SELECT hon.claim_school_video_copy() v')).rows[0].v;
  ok(claim.assetId === v4.assetId && claim.attempt === 1 && claim.sourceKey === `media/${v4.assetId}`, 'the runtime role claims the oldest QUEUED video');
  const facts = { copyBytes: 10, posterBytes: 10, copySha256: 'c'.repeat(64), width: 1280, height: 720, durationMs: 1000 };
  await assert.rejects(runtime.query('SELECT hon.finish_school_video_copy($1,$2,$3)', [v4.assetId, randomUUID(), JSON.stringify(facts)]), /MEDIA_COPY_LEASE_LOST/); checks += 1;
  await assert.rejects(runtime.query('SELECT hon.finish_school_video_copy($1,$2,$3)', [v4.assetId, claim.lease, JSON.stringify({ ...facts, width: 1920 })]), /VALIDATION_FAILED/); checks += 1;
  await assert.rejects(runtime.query('SELECT hon.fail_school_video_copy($1,$2,$3)', [v4.assetId, claim.lease, 'bad code']), /VALIDATION_FAILED/); checks += 1;
  ok((await runtime.query('SELECT hon.claim_school_video_copy() v')).rows[0].v === null, 'a leased video is not claimed twice');
  // The lease runs out: taken again with a new lease; the old one can no longer finish.
  await fixture("UPDATE hon.school_media_assets SET copy_lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [v4.assetId]);
  const reclaim = (await runtime.query('SELECT hon.claim_school_video_copy() v')).rows[0].v;
  ok(reclaim.assetId === v4.assetId && reclaim.attempt === 2 && reclaim.lease !== claim.lease, 'an expired lease is taken again');
  await assert.rejects(runtime.query('SELECT hon.finish_school_video_copy($1,$2,$3)', [v4.assetId, claim.lease, JSON.stringify(facts)]), /MEDIA_COPY_LEASE_LOST/); checks += 1;
  // Deleted while copying: the finish says discard and leaves no link.
  const v4Version = (await row(v4.assetId)).version;
  const deleted = await success(() => remove(MANAGER, { assetId: v4.assetId, expectedVersion: v4Version }), 'delete during copy');
  ok(deleted.data.removed === true, 'deleted and its files removed');
  ok(JSON.stringify((await runtime.query('SELECT hon.finish_school_video_copy($1,$2,$3) v', [v4.assetId, reclaim.lease, JSON.stringify(facts)])).rows[0].v) === JSON.stringify({ assetId: v4.assetId, discard: true }), 'a deleted video discards the copy');
  // An expired third lease becomes FAILED on the next claim.
  const v5 = await uploaded(MANAGER, { ...VIDEO, title: 'Stuck' });
  await fixture("UPDATE hon.school_media_assets SET copy_state='WORKING',copy_attempts=3,copy_lease=gen_random_uuid(),copy_lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [v5.assetId]);
  ok((await runtime.query('SELECT hon.claim_school_video_copy() v')).rows[0].v === null && (await row(v5.assetId)).copy_state === 'FAILED', 'an expired third lease fails');

  // 6. Delete a finished video: all three files go and every link stops.
  const callsBefore = calls.length;
  const wVersion = (await row(w.assetId)).version;
  const del = await success(() => remove(MANAGER, { assetId: w.assetId, expectedVersion: wVersion }), 'delete finished');
  ok(del.data.removed === true && ['', '.720.mp4', '.poster.jpg'].every((s) => !STORE.has(`media/${w.assetId}${s}`)), 'original, copy and poster removed');
  ok(calls.slice(callsBefore).filter((c) => c.method === 'DELETE').length === 1, 'in one storage call');
  const wToken = (await row(w.assetId)).link_token;
  ok((await open(wToken)).status === 404 && (await open(wToken, '/poster')).status === 404 && (await open(wToken, '/page')).status === 404, 'every link stops');

  // 7. Blasts: a video line takes only a READY video of this school whose copy is done; the worker reads its token and kind.
  const vline = (id) => `{{video:${id}}}`;
  const draft = (body, patch = {}) => ({ blastId: null, expectedVersion: 0, name: 'Highlights', channel: 'EMAIL', subject: 'Watch', body, audience: { groups: ['ACTIVE_STUDENTS'], tags: [] }, ...patch });
  const ana = await person('Ana');
  const v6 = await uploaded(MANAGER, { ...VIDEO, title: 'Queued' });
  for (const [id, label] of [[v6.assetId, 'a video still being prepared'], [v3.assetId, 'a failed video'], [v4.assetId, 'a deleted video'], [randomUUID(), 'an unknown id']]) {
    await refused(() => save(SENDER, draft(`Hi\n${vline(id)}`)), 409, 'BLAST_VIDEO_NOT_READY', `save refuses ${label}`);
  }
  await refused(() => save(SENDER, draft(`Hi\n${vline(picture.id)}`)), 409, 'BLAST_VIDEO_NOT_READY', 'a picture is not a video');
  await refused(() => save(SENDER, draft(`Hi\n{{picture:${v1.assetId}}}`)), 409, 'BLAST_PICTURE_NOT_READY', 'a video is not a picture');
  await refused(() => save(SENDER, draft(`Hi\n${vline(v1.assetId)}`, { channel: 'SMS', subject: null })), 400, 'VALIDATION_FAILED', 'a text holds no video line');
  const bodyOk = async (body) => (await sql("SELECT hon.school_blast_body_ok(to_jsonb($1::text),'EMAIL') v", [body])).rows[0].v;
  ok(await bodyOk([...Array(5).fill(`{{picture:${picture.id}}}`), ...Array(5).fill(vline(v1.assetId)), 'x'].join('\n')), 'ten media lines');
  ok(!(await bodyOk([...Array(5).fill(`{{picture:${picture.id}}}`), ...Array(6).fill(vline(v1.assetId)), 'x'].join('\n'))), 'eleven media lines refused');
  ok(!(await bodyOk(`Hi ${vline(v1.assetId)}`)), 'a video inside a line is a stray tag');
  const saved = (await success(() => save(SENDER, draft(`Hello {{first_name}},\n${vline(v1.assetId)}\n{{picture:${picture.id}}}`)), 'save with a video')).data;
  await refused(() => save(OWN_B, draft(`Hi\n${vline(v1.assetId)}`), { school: ids.schoolB }), 409, 'BLAST_VIDEO_NOT_READY', 'another school cannot use it');
  const sent = (await success(() => send(SENDER, { blastId: saved.blastId, expectedVersion: 1, sendAt: null }), 'send with a video')).data;
  ok(sent.recipientCount === 1, 'queued to one');
  const message = (await sql('SELECT id FROM hon.communication_messages WHERE origin_id=$1', [saved.blastId])).rows[0];
  const claimed = (await sql("SELECT * FROM hon.claim_communication_deliveries(ARRAY['EMAIL'],100,60) c WHERE c.message_id=$1", [message.id])).rows[0];
  const items = (await sql('SELECT hon.communication_email_pictures($1,$2) v', [claimed.delivery_id, claimed.lease_token])).rows[0].v;
  const item = items.find((x) => x.assetId === v1.assetId);
  ok(items.length === 2 && item.kind === 'VIDEO' && item.token === r1.link_token && item.width === 1280 && item.height === 720
    && items.find((x) => x.assetId === picture.id).kind === 'IMAGE' && items.every((x) => Object.keys(x).sort().join() === 'assetId,height,kind,title,token,width'), `the worker reads kind and token, never a key ${JSON.stringify(items)}`);
  // A video deleted after sending is left out of emails not yet delivered.
  const v1Version = (await row(v1.assetId)).version;
  await success(() => remove(MANAGER, { assetId: v1.assetId, expectedVersion: v1Version }), 'delete the sent video');
  ok((await sql('SELECT hon.communication_email_pictures($1,$2) v', [claimed.delivery_id, claimed.lease_token])).rows[0].v.map((x) => x.assetId).join() === picture.id, 'a deleted video is left out');
  ok(ana, 'a recipient');

  // 8. Direct SQL: the functions decide, the guard holds.
  const setTenant = async (actor) => {
    await sql(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),
      set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$4,true),
      set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)`, [actor.org, actor.school, actor.principal, actor.subject]);
  };
  await rejectsSql(async () => { await setTenant(MANAGER); await sql('SELECT hon.finish_school_video_upload($1,$2::jsonb,gen_random_uuid(),gen_random_uuid())', [MANAGER.subject, JSON.stringify({ assetId: v6.assetId, byteSize: 1 })]); }, /MEDIA_UPLOAD_MISMATCH/, 'finish must match the started size');
  await rejectsSql(async () => { await setTenant(OWN_B); await sql('SELECT hon.finish_school_video_upload($1,$2::jsonb,gen_random_uuid(),gen_random_uuid())', [OWN_B.subject, JSON.stringify({ assetId: v6.assetId, byteSize: 6000 })]); }, /MEDIA_NOT_FOUND/, 'another school cannot finish it');
  await rejectsSql(async () => { await setTenant(MANAGER); await sql('SELECT hon.finish_school_media_upload($1,$2::jsonb,gen_random_uuid(),gen_random_uuid())', [MANAGER.subject, JSON.stringify({ assetId: v6.assetId, byteSize: 6000, sha256: 'a'.repeat(64) })]); }, /MEDIA_NOT_FOUND|MEDIA_UPLOAD_MISMATCH|MEDIA_NOT_PENDING/, 'the picture finish never takes a video');
  await rejectsSql(() => sql("UPDATE hon.school_media_assets SET copy_state='DONE' WHERE id=$1", [v6.assetId]), /SCHOOL_MEDIA_IMMUTABLE|check constraint/, 'a copy cannot be marked done without its facts');
  await rejectsSql(() => sql("UPDATE hon.school_media_assets SET object_key='media/x.720.mp4' WHERE id=$1", [v6.assetId]), /SCHOOL_MEDIA_IMMUTABLE|check constraint/, 'the key is fixed');
  await rejectsSql(() => sql("UPDATE hon.school_media_assets SET copy_state='QUEUED' WHERE id=$1", [v1.assetId]), /SCHOOL_MEDIA_IMMUTABLE|check constraint/, 'a DONE copy does not go back');
  for (const table of ['school_media_assets']) {
    await assert.rejects(runtime.query(`SELECT 1 FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }

  // 9. Grants: seven runtime entry points, private helpers, and the 010/011 sections.
  const entry = ['begin_school_video_upload(text,jsonb,text,uuid,uuid)', 'finish_school_video_upload(text,jsonb,uuid,uuid)', 'claim_school_video_copy()',
    'finish_school_video_copy(uuid,uuid,jsonb)', 'fail_school_video_copy(uuid,uuid,text)', 'resolve_school_video_poster(text)', 'resolve_school_video_page(text)'];
  const helpers = ['school_video_copy_record(hon.school_media_assets,text,jsonb)', 'school_blast_video_ids(text)'];
  for (const fn of [...entry, ...helpers]) {
    const r = (await sql(`SELECT has_function_privilege($1,p.oid,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public,
      p.prosecdef, (SELECT array_agg(a.grantee::regrole::text) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner) grantees
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.public && (r.prosecdef || fn.startsWith('school_blast_')), `${fn}: definer, not PUBLIC`);
    ok(entry.includes(fn) ? r.runtime && (r.grantees ?? []).every((g) => g === CRM_CLOSE_RUNTIME_ROLE || g === 'hon_runtime') : !r.runtime && !(r.grantees ?? []).length, `${fn}: ${entry.includes(fn) ? 'runtime only' : 'no grants'} ${r.grantees}`);
  }
  await assert.rejects(runtime.query('SELECT hon.school_blast_video_ids($1)', ['x']), /permission denied/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const section = verify.split('-- School videos exact verification (0654)')[1]?.split('-- End school videos exact verification.')[0];
    ok(section, 'the 011 section');
    await sql(section.replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1;
    const grants = await readFile(resolve(repo, 'infra/postgres/010_supabase_hon_runtime.sql'), 'utf8');
    ok(entry.every((fn) => grants.includes(`hon.${fn.split('(')[0]}`)), 'the 010 block names every entry point'); }

  // 10. Evidence carries ids, sizes and states only; the service is the actor; nothing paid; the other organization untouched.
  const evidence = (await sql("SELECT next_state::text s FROM hon.audit_events WHERE organization_id=$1 UNION ALL SELECT payload::text FROM hon.outbox_events WHERE organization_id=$1", [ids.organization])).rows;
  ok(!evidence.some((r) => r.s.includes(r1.link_token) || r.s.includes('token=') || r.s.includes('media/')), 'no token, link or key in audit or outbox');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND action_code='school_media.copy_done' AND actor_principal_id=$2 AND source='SYSTEM_SERVICE'", [ids.organization, SERVICE])).rows[0].n === 2, 'the copy service records each finished copy');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND action_code='school_media.copy_failed'", [ids.organization])).rows[0].n === 2, 'and each failure');
  ok((await sql("SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) n",
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no payment attempt or invoice');
  ok((await sql('SELECT count(*)::int n FROM hon.school_media_assets WHERE organization_id=$1', [ids.otherOrganization])).rows[0].n === 0, 'the other organization untouched');
  ok(calls.every((c) => c.path.startsWith('/storage/v1/')), 'only the storage stand-in was called');

  console.log(`PASS: school videos (0654): ${checks} checks.`);
} finally {
  delete process.env.HON_MEDIA_VIDEO_COPIES_APPROVED;
  if (app) await app.close();
  await database.onModuleDestroy?.().catch(() => undefined);
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
