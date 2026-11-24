/**
 * School media library proof (BL3a, 0628) over signed HTTP (HON session cookie -> raw upload transport -> HonIdentityGuard +
 * human UI guards + global ValidationPipe + HonExceptionFilter -> SchoolMediaController / PublicSchoolMediaController ->
 * protected definer functions on the restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture
 * only. Storage is the real MediaStorage client pointed at an in-memory stand-in (no network, nothing paid). Synthetic
 * pictures only.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CRM_CLOSE_OWNER_ROLE, CRM_CLOSE_RUNTIME_ROLE, crmCloseProofTargets, verifyCrmCloseProofConnection } from './crm-close-proof-target.mjs';

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
const { PublicClientLimit } = await load('schedule/public-client-limit.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-media', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// In-memory stand-in for the private bucket, behind the real storage client (its URLs, headers and checks).
const STORE = new Map();
const storageCalls = [];
const settings = { baseUrl: 'https://media.example.test', key: 'k'.repeat(40), bucket: 'hon-media' };
let storageFails = false;
const storage = MediaStorage.withSettings(settings, async (url, init) => {
  storageCalls.push({ url, method: init.method });
  if (storageFails && init.method === 'POST' && !url.includes('/sign/')) return new Response('{}', { status: 500 });
  const path = new URL(url).pathname;
  const sign = path.match(/^\/storage\/v1\/object\/sign\/hon-media\/(media\/[0-9a-f-]{36})$/);
  if (sign) return new Response(JSON.stringify({ signedURL: `/object/sign/hon-media/${sign[1]}?token=${'s'.repeat(32)}` }), { status: 200 });
  const put = path.match(/^\/storage\/v1\/object\/hon-media\/(media\/[0-9a-f-]{36})$/);
  if (put && init.method === 'POST') { STORE.set(put[1], { bytes: Buffer.from(init.body), type: init.headers['Content-Type'] }); return new Response('{}', { status: 200 }); }
  if (path === '/storage/v1/object/hon-media' && init.method === 'DELETE') { for (const key of JSON.parse(init.body).prefixes) STORE.delete(key); return new Response('[]', { status: 200 }); }
  return new Response('{}', { status: 400 });
});
const switchStorage = (on) => Object.assign(storage, { fixed: on ? settings : null });

let app, origin;
const database = new RuntimeDatabaseService();
async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [SchoolMediaController, PublicSchoolMediaController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolMediaService, { provide: MediaStorage, useValue: storage }, { provide: RuntimeDatabaseService, useValue: database }],
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
function call(actor, method, { body, raw, type, title, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org, query = '', path = '' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/marketing/media${path}${query}`);
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': type ?? 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...(title !== undefined ? { 'X-Hon-Media-Title': encodeURIComponent(title) } : {}),
    ...(payload !== undefined ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return request(target, method, sent, payload);
}
const list = (actor, options = {}) => call(actor, 'GET', options);
const upload = (actor, bytes, options = {}) => call(actor, 'POST', { path: '/upload', command: 'marketing_media.upload', raw: bytes, type: 'image/png', title: 'Open house', ...options });
const rename = (actor, body, options = {}) => call(actor, 'POST', { path: '/rename', command: 'marketing_media.rename', body, ...options });
const remove = (actor, body, options = {}) => call(actor, 'POST', { path: '/delete', command: 'marketing_media.delete', body, ...options });
const open = (token) => request(new URL(`${origin}/v1/public/media/${token}`), 'GET', {});
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

// Synthetic pictures: a PNG carrying an author and location text chunk, a GIF carrying a comment.
function pngChunk(chunkType, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(chunkType, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function png(width, height, seed = 0) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8;
  const rows = Buffer.alloc((width + 1) * height, seed);
  for (let r = 0; r < height; r++) rows[r * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from('Author\0Coach Dana at 34.05N 118.24W', 'latin1')), pngChunk('IDAT', zlib.deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}
const sub = (text) => Buffer.concat([Buffer.from([text.length]), Buffer.from(text, 'latin1'), Buffer.from([0])]);
const GIF = Buffer.concat([Buffer.from('474946383961' + '04000200' + '800000' + '000000ffffff', 'hex'), Buffer.from([0x21, 0xfe]), sub('Coach Dana 34N'),
  Buffer.from('21f90401000000002c0000000004000200000202440100', 'hex'), Buffer.from([0x3b])]);

// Disposable-fixture cleanup only (as in the 0478 proof).
async function cleanup(orgs = [ids.organization, ids.otherOrganization], subjects = `%media-${ids.organization}-%`) {
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
    if (left) throw new Error('fixture cleanup left a picture behind');
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
  const user = randomUUID(), principal = randomUUID(), subject = `media-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Media Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [principal, user, `Coach ${label}`]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school, label };
}

let OWN, MANAGER, READER, NONE, OWN_B, OTHER_ORG;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Media Org','Media Org'),($2,'Media Other Org','Media Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug, name] of [[ids.schoolA, ids.organization, 'a', 'Tiger Dojo'], [ids.schoolB, ids.organization, 'b', 'Crane Dojo'], [ids.otherSchool, ids.otherOrganization, 'o', 'Other Dojo']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, name, `media-${slug}-${school.slice(0, 8)}`]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  MANAGER = await staff('manager', [await role(ids.organization, ['marketing.media.manage', 'marketing.media.read'])]);
  READER = await staff('reader', [await role(ids.organization, ['marketing.media.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'marketing.blast.send'])]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['marketing.media.manage', 'marketing.media.read'])], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
}
const row = async (assetId) => (await sql('SELECT * FROM hon.school_media_assets WHERE id=$1', [assetId])).rows[0];
// Fixture-only bulk rows for the caps (triggers off inside one transaction, as in cleanup).
async function bulk(count, { state = 'PENDING', monthsAgo = 0, school = ids.schoolA } = {}) {
  await sql('BEGIN');
  await sql('ALTER TABLE hon.school_media_assets DISABLE TRIGGER USER');
  await sql(`INSERT INTO hon.school_media_assets(id,organization_id,school_id,kind,media_type,title,byte_size,sha256,width,height,object_key,link_token,state,
      created_by_principal_id,created_at,ready_at,deleted_at,deleted_by_principal_id,removed_at)
    SELECT n.id,$1,$2,'IMAGE','image/png','Bulk',26214400,repeat('a',64),1,1,'media/'||n.id,rtrim(translate(encode(gen_random_bytes(32),'base64'),'+/','-_'),'='),$4,$5,
      date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - make_interval(months=>$6) + interval '1 hour',
      CASE WHEN $4='REMOVED' THEN clock_timestamp() END, CASE WHEN $4='REMOVED' THEN clock_timestamp() END, CASE WHEN $4='REMOVED' THEN $5::uuid END, CASE WHEN $4='REMOVED' THEN clock_timestamp() END
    FROM (SELECT gen_random_uuid() id FROM generate_series(1,$3)) n`, [ids.organization, school, count, state, OWN.principal, monthsAgo]);
  await sql('ALTER TABLE hon.school_media_assets ENABLE TRIGGER USER');
  await sql('COMMIT');
}
async function unbulk() {
  await sql('BEGIN');
  await sql('ALTER TABLE hon.school_media_assets DISABLE TRIGGER USER');
  await sql("DELETE FROM hon.school_media_assets WHERE organization_id=$1 AND title='Bulk'", [ids.organization]);
  await sql('ALTER TABLE hon.school_media_assets ENABLE TRIGGER USER');
  await sql('COMMIT');
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 0. Permissions and OWNER grants.
  ok((await sql("SELECT count(*)::int n FROM hon.permissions WHERE (code='marketing.media.read' AND NOT is_sensitive AND is_staff_assignable) OR (code='marketing.media.manage' AND is_sensitive AND is_staff_assignable)")).rows[0].n === 2, 'two staff-assignable permissions');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r CROSS JOIN unnest(ARRAY['marketing.media.read','marketing.media.manage']) c WHERE r.is_system_role AND r.code='OWNER'
    AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code=c)`)).rows[0].n === 0, 'every system OWNER role holds both');

  // 1. Reads at exactly this school with marketing.media.read.
  const empty = (await success(() => list(READER), 'empty library')).data;
  ok(empty.assets.length === 0 && empty.usage.storedBytes === 0 && empty.usage.storedLimitBytes === 5368709120 && empty.usage.monthLimitBytes === 10737418240, 'empty library with the caps');
  await refused(() => list(NONE), 403, 'SCHOOL_MEDIA_FORBIDDEN', 'no media permission');
  await refused(() => list(OWN_B, { school: ids.schoolA }), 403, 'SCHOOL_MEDIA_FORBIDDEN', 'a grant at another school');
  await refused(() => list(OTHER_ORG, { school: ids.schoolA, organization: ids.organization }), 403, 'SCHOOL_MEDIA_FORBIDDEN', 'another organization');
  await refused(() => list(READER, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'reads take no key');
  await refused(() => list(READER, { query: '?all=1' }), 400, undefined, 'reads take no query');
  await refused(() => list(READER, { headers: { 'X-Hon-Source': 'AI_EMPLOYEE' } }), 403, 'HUMAN_UI_REQUIRED', 'AI source refused');

  // 2. Storage off: nothing reserved, nothing stored.
  switchStorage(false);
  await refused(() => upload(MANAGER, png(4, 3)), 503, 'MEDIA_STORAGE_OFF', 'storage off');
  ok((await sql('SELECT count(*)::int n FROM hon.school_media_assets WHERE organization_id=$1', [ids.organization])).rows[0].n === 0 && STORE.size === 0, 'storage off stores nothing');
  switchStorage(true);

  // 3. Upload: cleaned, stored under media/<id>, READY with a link token.
  const original = png(6, 4);
  const key1 = randomUUID();
  const up = await success(() => upload(MANAGER, original, { key: key1, title: 'Belt test — spring' }), 'upload');
  const asset = up.data;
  ok(asset.state === 'READY' && asset.version === 2 && asset.width === 6 && asset.height === 4 && asset.mediaType === 'image/png' && asset.title === 'Belt test — spring' && /^[A-Za-z0-9_-]{43}$/.test(asset.linkToken) && up.meta.replayed === false, 'READY picture');
  const stored = STORE.get(`media/${asset.assetId}`);
  ok(stored && stored.type === 'image/png' && !stored.bytes.includes(Buffer.from('Dana')) && !stored.bytes.includes(Buffer.from('34.05N')), 'stored without author or location');
  const r1 = await row(asset.assetId);
  ok(r1.object_key === `media/${asset.assetId}` && Number(r1.byte_size) === stored.bytes.length && r1.sha256 === sha(stored.bytes) && r1.created_by_principal_id === MANAGER.principal, 'row records exactly what was stored');
  ok(Number(r1.byte_size) < original.length, 'the stored picture is the cleaned one');
  const puts = () => storageCalls.filter((c) => c.method === 'POST' && !c.url.includes('/sign/')).length;
  const putsBefore = puts();
  const replay = await success(() => upload(MANAGER, original, { key: key1, title: 'Belt test — spring' }), 'upload replay');
  ok(replay.meta.replayed === true && replay.data.assetId === asset.assetId && puts() === putsBefore, 'a replay stores nothing again');
  await refused(() => upload(MANAGER, png(5, 5), { key: key1, title: 'Belt test — spring' }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another picture');
  const gif = (await success(() => upload(OWN, GIF, { type: 'image/gif', title: 'Kick loop' }), 'gif upload')).data;
  ok(gif.mediaType === 'image/gif' && gif.width === 4 && gif.height === 2 && !STORE.get(`media/${gif.assetId}`).bytes.includes(Buffer.from('Dana')), 'GIF cleaned of its comment');

  // 4. Upload refusals.
  await refused(() => upload(READER, png(2, 2)), 403, 'SCHOOL_MEDIA_FORBIDDEN', 'read-only staff cannot upload');
  await refused(() => upload(OWN_B, png(2, 2), { school: ids.schoolA }), 403, 'SCHOOL_MEDIA_FORBIDDEN', 'another school cannot upload here');
  await refused(() => upload(MANAGER, png(2, 2), { type: 'image/jpeg' }), 400, 'MEDIA_IMAGE_REFUSED', 'bytes that do not match the type');
  await refused(() => upload(MANAGER, Buffer.from('<svg onload=alert(1)/>'), { type: 'image/svg+xml' }), 400, 'VALIDATION_FAILED', 'SVG refused before reading');
  await refused(() => upload(MANAGER, png(2, 2), { command: 'marketing_media.rename' }), 403, 'HUMAN_UI_REQUIRED', 'wrong command');
  await refused(() => upload(MANAGER, png(2, 2), { headers: { Origin: 'https://evil.example' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-origin');
  await refused(() => upload(MANAGER, png(2, 2), { headers: { 'X-Hon-Delegated-By-Principal-Id': OWN.principal } }), 403, 'HUMAN_UI_REQUIRED', 'delegated');
  await refused(() => upload(MANAGER, png(2, 2), { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'no key');
  await refused(() => upload(MANAGER, png(2, 2), { title: ' padded' }), 400, 'VALIDATION_FAILED', 'untrimmed title');
  await refused(() => upload(MANAGER, png(2, 2), { title: 'x'.repeat(101) }), 400, 'VALIDATION_FAILED', 'long title');
  await refused(() => upload(MANAGER, png(2, 2), { headers: { 'X-Hon-Media-Title': '%E0%A4%A' } }), 400, 'VALIDATION_FAILED', 'undecodable title');
  storageFails = true;
  await refused(() => upload(MANAGER, png(3, 3, 7)), 503, 'MEDIA_STORAGE_FAILED', 'a storage failure is reported');
  storageFails = false;
  ok((await sql("SELECT count(*)::int n FROM hon.school_media_assets WHERE organization_id=$1 AND state='PENDING'", [ids.organization])).rows[0].n === 0, 'a failed store leaves no PENDING picture');
  ok((await sql("SELECT count(*)::int n FROM hon.school_media_assets WHERE organization_id=$1 AND state='DELETED'", [ids.organization])).rows[0].n === 0, 'and holds no storage (removed)');

  // 5. The library and its usage.
  const lib = (await success(() => list(READER), 'library')).data;
  ok(lib.assets.length === 2 && lib.assets[0].assetId === gif.assetId && lib.usage.storedBytes === Number(r1.byte_size) + gif.byteSize, 'newest first with the bytes held');
  ok(lib.usage.monthBytes >= lib.usage.storedBytes, 'month usage counts every upload');
  ok((await success(() => list(OWN_B), 'school B library')).data.assets.length === 0, 'school B sees none of school A');

  // 6. The public link.
  const link = await open(asset.linkToken);
  ok(link.status === 302 && link.headers.location === `https://media.example.test/storage/v1/object/sign/hon-media/media/${asset.assetId}?token=${'s'.repeat(32)}`
    && link.headers['cache-control'] === 'no-store' && link.headers['referrer-policy'] === 'no-referrer', 'the link redirects to a signed file link');
  ok((await open('B'.repeat(43))).status === 404, 'an unknown token opens nothing');
  ok((await open('short')).status === 400, 'a malformed token is refused');
  ok((await request(new URL(`${origin}/v1/public/media/${asset.linkToken}?x=1`), 'GET', {})).status === 400, 'no query string');
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.schoolA]);
  ok((await open(asset.linkToken)).status === 404, 'a suspended school serves no picture');
  await refused(() => list(READER), 403, undefined, 'suspended school');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.schoolA]);
  switchStorage(false);
  ok((await open(asset.linkToken)).status === 404, 'with storage off the link opens nothing');
  switchStorage(true);

  // 7. Rename.
  const renamed = await success(() => rename(MANAGER, { assetId: asset.assetId, expectedVersion: 2, title: 'Spring belt test' }), 'rename');
  ok(renamed.data.title === 'Spring belt test' && renamed.data.version === 3 && renamed.data.linkToken === asset.linkToken, 'renamed, same link');
  await refused(() => rename(MANAGER, { assetId: asset.assetId, expectedVersion: 2, title: 'Again' }), 409, 'VERSION_CONFLICT', 'stale version');
  await refused(() => rename(READER, { assetId: asset.assetId, expectedVersion: 3, title: 'Again' }), 403, 'SCHOOL_MEDIA_FORBIDDEN', 'reader cannot rename');
  await refused(() => rename(OWN_B, { assetId: asset.assetId, expectedVersion: 3, title: 'Again' }), 404, 'MEDIA_NOT_FOUND', 'another school cannot reach it from its own route');
  await refused(() => rename(MANAGER, { assetId: asset.assetId, expectedVersion: 3, title: 'Again', extra: 1 }), 400, undefined, 'unknown field');
  await refused(() => rename(MANAGER, { assetId: randomUUID(), expectedVersion: 1, title: 'Again' }), 404, 'MEDIA_NOT_FOUND', 'unknown picture');

  // 8. Delete: the link stops at once, the file goes, the row stays REMOVED.
  const delKey = randomUUID();
  const del = await success(() => remove(MANAGER, { assetId: asset.assetId, expectedVersion: 3 }, { key: delKey }), 'delete');
  ok(del.data.assetId === asset.assetId && del.data.removed === true && del.meta.replayed === false, 'deleted and removed');
  ok(!STORE.has(`media/${asset.assetId}`) && (await row(asset.assetId)).state === 'REMOVED', 'file gone, row REMOVED');
  ok((await open(asset.linkToken)).status === 404, 'a deleted picture opens nothing');
  const delReplay = await success(() => remove(MANAGER, { assetId: asset.assetId, expectedVersion: 3 }, { key: delKey }), 'delete replay');
  ok(delReplay.meta.replayed === true && delReplay.data.removed === true, 'delete replay');
  await refused(() => remove(MANAGER, { assetId: asset.assetId, expectedVersion: 4 }), 404, 'MEDIA_NOT_FOUND', 'deleting twice');
  await refused(() => upload(MANAGER, original, { key: key1, title: 'Belt test — spring' }), 409, 'MEDIA_DELETED', 'an old upload replay does not bring it back');
  ok((await success(() => list(READER), 'after delete')).data.assets.length === 1, 'the library no longer lists it');
  // Storage off at delete time: the link stops; the file waits.
  const later = (await success(() => upload(MANAGER, png(2, 2, 9), { title: 'Later' }), 'upload later')).data;
  switchStorage(false);
  const pendingRemoval = await success(() => remove(MANAGER, { assetId: later.assetId, expectedVersion: 2 }), 'delete with storage off');
  switchStorage(true);
  ok(pendingRemoval.data.removed === false && (await row(later.assetId)).state === 'DELETED' && (await open(later.linkToken)).status === 404, 'DELETED stops the link before the file is removed');
  const held = (await success(() => list(READER), 'usage counts DELETED')).data.usage.storedBytes;
  ok(held === gif.byteSize + later.byteSize, 'a deleted file still counts until removed');

  // 9. Caps under the per-school lock.
  await bulk(205);
  await refused(() => upload(MANAGER, png(2, 3, 1)), 409, 'MEDIA_STORAGE_FULL', '5 GB held');
  ok((await success(() => upload(OWN_B, png(2, 3, 1), { title: 'Other school' }), 'school B is not full')).data.state === 'READY', 'the cap is per school');
  await unbulk();
  await bulk(409, { state: 'REMOVED' });
  ok((await success(() => upload(MANAGER, png(2, 3, 2)), 'still under the month')).data.state === 'READY', 'just under 10 GB this month');
  await bulk(1, { state: 'REMOVED' });
  await refused(() => upload(MANAGER, png(2, 3, 3)), 409, 'MEDIA_MONTHLY_LIMIT', '10 GB uploaded this month');
  await unbulk();
  await bulk(410, { state: 'REMOVED', monthsAgo: 1 });
  ok((await success(() => upload(MANAGER, png(2, 3, 4)), 'last month does not count')).data.state === 'READY', 'the month resets');
  await unbulk();
  const racers = await Promise.all([1, 2, 3].map((n) => upload(MANAGER, png(3, n, n))));
  ok(racers.every((r) => r.status === 200), 'parallel uploads each succeed');

  // 10. Live authority: revoked grant, lapsed access.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', [MANAGER.grants[0]]);
  await refused(() => upload(MANAGER, png(2, 2)), 403, undefined, 'revoked grant');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1', [MANAGER.grants[0]]);
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1", [ids.organization]);
  await refused(() => list(READER), 403, undefined, 'lapsed access');
  await sql("UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1", [ids.organization]);

  // 11. Direct SQL: the functions decide, the guard holds.
  const setTenant = async (actor) => {
    await sql(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),
      set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$4,true),
      set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)`, [actor.org, actor.school, actor.principal, actor.subject]);
  };
  const ready = (await success(() => list(READER), 'for sql')).data.assets[0];
  await rejectsSql(async () => { await setTenant(MANAGER); await sql("SELECT hon.finish_school_media_upload($1,$2::jsonb,gen_random_uuid(),gen_random_uuid())", [MANAGER.subject, JSON.stringify({ assetId: ready.assetId, byteSize: ready.byteSize, sha256: 'b'.repeat(64) })]); }, /MEDIA_UPLOAD_MISMATCH/, 'a confirm must match the stored checksum');
  await rejectsSql(async () => { await setTenant(MANAGER); await sql("SELECT hon.begin_school_media_upload($1,$2::jsonb,'k',gen_random_uuid(),gen_random_uuid())", [MANAGER.subject, JSON.stringify({ title: 'x', mediaType: 'image/svg+xml', byteSize: 1, sha256: 'a'.repeat(64), width: 1, height: 1 })]); }, /VALIDATION_FAILED/, 'SVG refused by the database');
  await rejectsSql(async () => { await setTenant(MANAGER); await sql("SELECT hon.begin_school_media_upload($1,$2::jsonb,'k',gen_random_uuid(),gen_random_uuid())", [MANAGER.subject, JSON.stringify({ title: 'x', mediaType: 'image/png', byteSize: 26214401, sha256: 'a'.repeat(64), width: 1, height: 1 })]); }, /VALIDATION_FAILED/, 'over 25 MB refused by the database');
  await rejectsSql(async () => { await setTenant(MANAGER); await sql("SELECT hon.begin_school_media_upload($1,$2::jsonb,'k',gen_random_uuid(),gen_random_uuid())", [MANAGER.subject, JSON.stringify({ title: 'x', mediaType: 'image/png', byteSize: 1, sha256: 'a'.repeat(64), width: 1, height: 1, objectKey: 'media/x' })]); }, /VALIDATION_FAILED/, 'no caller-chosen key');
  await rejectsSql(async () => { await setTenant(READER); await sql("SELECT hon.begin_school_media_upload($1,$2::jsonb,'k',gen_random_uuid(),gen_random_uuid())", [READER.subject, JSON.stringify({ title: 'x', mediaType: 'image/png', byteSize: 1, sha256: 'a'.repeat(64), width: 1, height: 1 })]); }, /SCHOOL_MEDIA_FORBIDDEN/, 'read permission cannot upload');
  await rejectsSql(async () => { await setTenant(MANAGER); await sql("SELECT set_config('app.hon_source','AI_EMPLOYEE',true)"); await sql('SELECT hon.read_school_media($1)', [MANAGER.subject]); }, /SCHOOL_MEDIA_FORBIDDEN/, 'AI source refused by the database');
  await rejectsSql(async () => { await setTenant(MANAGER); await sql('SELECT hon.confirm_school_media_removed($1,$2::uuid,gen_random_uuid(),gen_random_uuid())', [MANAGER.subject, ready.assetId]); }, /MEDIA_NOT_DELETED/, 'only a deleted picture can be confirmed removed');
  await rejectsSql(() => sql('DELETE FROM hon.school_media_assets WHERE id=$1', [ready.assetId]), /SCHOOL_MEDIA_IMMUTABLE/, 'no delete');
  await rejectsSql(() => sql('TRUNCATE hon.school_media_assets'), /SCHOOL_MEDIA_IMMUTABLE/, 'no truncate');
  await rejectsSql(() => sql("UPDATE hon.school_media_assets SET state='PENDING',ready_at=NULL,version=version+1 WHERE id=$1", [ready.assetId]), /SCHOOL_MEDIA_IMMUTABLE|violates check/, 'no going back');
  await rejectsSql(() => sql("UPDATE hon.school_media_assets SET sha256=repeat('c',64),version=version+1 WHERE id=$1", [ready.assetId]), /SCHOOL_MEDIA_IMMUTABLE/, 'content is fixed');
  await rejectsSql(() => sql("UPDATE hon.school_media_assets SET link_token=$2,version=version+1 WHERE id=$1", [ready.assetId, 'C'.repeat(43)]), /SCHOOL_MEDIA_IMMUTABLE/, 'the link token is fixed');
  await rejectsSql(() => sql("UPDATE hon.school_media_assets SET state='REMOVED',removed_at=now(),version=version+1 WHERE id=$1", [ready.assetId]), /SCHOOL_MEDIA_IMMUTABLE|violates check/, 'READY cannot skip to REMOVED');
  ok((await runtime.query("SELECT hon.resolve_school_media_link('../x') AS data")).rows[0].data === null, 'the public resolver ignores a malformed token');

  // 12. Evidence without titles; runtime ACL; 011 section.
  const audits = (await sql("SELECT action_code,next_state::text s FROM hon.audit_events WHERE organization_id=$1 AND entity_type='SCHOOL_MEDIA_ASSET'", [ids.organization])).rows;
  const outbox = (await sql("SELECT event_type,payload::text s FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type='SCHOOL_MEDIA_ASSET'", [ids.organization])).rows;
  ok(['school_media.upload_started', 'school_media.ready', 'school_media.renamed', 'school_media.deleted', 'school_media.removed'].every((a) => audits.some((x) => x.action_code === a)) && outbox.length === audits.length, 'audit and outbox per change');
  ok(![...audits, ...outbox].some((r) => /belt|kick|later|open house|token|media\//i.test(r.s)), 'no title, token or key in audit or outbox');
  for (const fn of ['read_school_media(text)', 'begin_school_media_upload(text,jsonb,text,uuid,uuid)', 'finish_school_media_upload(text,jsonb,uuid,uuid)', 'rename_school_media(text,jsonb,text,uuid,uuid)',
    'delete_school_media(text,jsonb,text,uuid,uuid)', 'confirm_school_media_removed(text,uuid,uuid,uuid)', 'resolve_school_media_link(text)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['school_media_title_ok(jsonb)', 'school_media_new_token()', 'guard_school_media_asset()', 'require_school_media_actor(text,text)', 'school_media_json(hon.school_media_assets)',
    'school_media_usage(uuid,uuid)', 'school_media_begin(text,text,jsonb,text,uuid)', 'school_media_current(uuid,uuid,jsonb)', 'school_media_finish(text,text,uuid,text,hon.school_media_assets,jsonb,uuid,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  { const t = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid='hon.school_media_assets'::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
    ok(t.forced && !t.runtime, 'school_media_assets: forced RLS, no runtime privilege');
    await assert.rejects(runtime.query('SELECT * FROM hon.school_media_assets LIMIT 1'), /permission denied/); checks += 1; }
  await assert.rejects(runtime.query("SELECT hon.read_school_media('x')"), /SCHOOL_MEDIA_FORBIDDEN/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- School media library exact verification (0628)', end = '-- End school media library exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 13. Nothing paid and no other organization touched.
  ok((await sql("SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) n",
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no payment attempt or invoice');
  ok((await sql('SELECT count(*)::int n FROM hon.school_media_assets WHERE organization_id=$1', [ids.otherOrganization])).rows[0].n === 0, 'the other organization has no pictures');
  ok(storageCalls.every((c) => c.url.startsWith('https://media.example.test/storage/v1/object/')), 'storage was only the stand-in bucket');

  console.log(`PASS: school media library (0628): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
