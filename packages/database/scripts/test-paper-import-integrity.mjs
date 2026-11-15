/**
 * Paper import proof (0388) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards + global
 * ValidationPipe + HonExceptionFilter -> controller -> stand-in reader -> protected definer functions on the restricted
 * runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names and sample pages only.
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
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonExceptionFilter } = await load('observability/http-telemetry.js');
const { PaperImportController } = await load('paper-import/paper-import.controller.js');
const { PaperImportService } = await load('paper-import/paper-import.service.js');
const { PAPER_READER_RUNTIME, SyntheticPaperReader } = await load('paper-import/paper-reader.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-paper-import', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();
let readerCalls = 0;
const reader = new SyntheticPaperReader();
const countingReader = { read: (input) => { readerCalls += 1; return reader.read(input); } };

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [PaperImportController],
    providers: [HonIdentityGuard, HonIdentityService, PaperImportService, { provide: RuntimeDatabaseService, useValue: database }, { provide: PAPER_READER_RUNTIME, useValue: countingReader }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.useBodyParser('json', { limit: '2mb' });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org, base = 'paper-imports' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/${base}${path}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method, headers: sent }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}
const list = (actor, o = {}) => call(actor, 'GET', '', o);
const detail = (actor, id, o = {}) => call(actor, 'GET', `/${id}`, o);
const pageImage = (actor, id, n, o = {}) => call(actor, 'GET', `/${id}/pages/${n}`, o);
const create = (actor, body, o = {}) => call(actor, 'POST', '', { body, command: 'students.paper_import.create', ...o });
const addPage = (actor, id, body, o = {}) => call(actor, 'POST', `/${id}/pages`, { body, command: 'students.paper_import.page', ...o });
const readSet = (actor, id, body, o = {}) => call(actor, 'POST', `/${id}/reading`, { body, command: 'students.paper_import.reading', key: null, ...o });
const save = (actor, id, body, o = {}) => call(actor, 'POST', `/${id}/table`, { body, command: 'students.paper_import.save', ...o });
const send = (actor, id, body, o = {}) => call(actor, 'POST', `/${id}/send`, { body, command: 'students.paper_import.send', ...o });
const remove = (actor, id, o = {}) => call(actor, 'POST', `/${id}/delete`, { body: {}, command: 'students.paper_import.delete', ...o });

async function success(read, label) {
  const { status, body, headers } = await read();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
  return body;
}
async function rejectsSql(run, pattern, label) {
  await sql('SAVEPOINT expected_failure');
  try { await run(); } catch (error) { await sql('ROLLBACK TO SAVEPOINT expected_failure'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK TO SAVEPOINT expected_failure');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0226 proof).
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    for (let pass = 0; pass < 8; pass += 1) {
      let failed = 0;
      for (const table of tables) {
        await sql('SAVEPOINT cleanup_table');
        try {
          await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`paper-import-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`paper-import-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`paper-import-${ids.organization}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `paper-import-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Paper Import Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Paper Import Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}

let OWN, IMPORTER, NONE, MIXED, OTHER_SCHOOL, OTHER_ORG;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Paper Import Org','Paper Import Org'),($2,'Paper Import Other Org','Paper Import Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Paper Import ${slug}`, `paper-import-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  IMPORTER = await staff('importer', [await role(ids.organization, ['students.import'])]);
  NONE = await staff('none', [await role(ids.organization, allPermissions.filter((code) => code !== 'students.import'))]);
  MIXED = await staff('mixed', [await role(ids.organization, ['people.read']), await role(ids.organization, ['students.import'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('school-b', [await role(ids.organization, ['students.import'])], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
}

// Pages: the three built-in samples, a JPEG photo fixture with EXIF/comment/trailing data added, and a PNG with text.
const sample = async (name) => readFile(resolve(repo, 'apps/web/public/paper-import-samples', name));
const fixture = async (name) => readFile(resolve(repo, 'apps/api/test/fixtures', name));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
const CARD = await sample('student-card.png'), CONTRACT = await sample('contract.png'), SHEET = await sample('attendance-sheet.png');
const PHOTO = await fixture('paper-page.jpg');
const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x1e]), Buffer.from('Exif\0\0GPS 34.05N 118.24W cam', 'latin1')]);
const DIRTY_JPEG = Buffer.concat([PHOTO.subarray(0, 2), exif, PHOTO.subarray(2), Buffer.from('trailing Exif preview', 'latin1')]);
const seg = (marker, body) => { const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(body.length + 2, 2); return Buffer.concat([head, body]); };
const APP12_JPEG = Buffer.concat([PHOTO.subarray(0, 2), seg(0xec, Buffer.from('Ducky\0Owner: Grace Park', 'latin1')), PHOTO.subarray(2)]);
const ICC_JPEG = Buffer.concat([PHOTO.subarray(0, 2), seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01profile', 'latin1')), PHOTO.subarray(2)]);
const LATE_EXIF_JPEG = Buffer.concat([PHOTO.subarray(0, -2), exif, Buffer.from([0xff, 0xd9])]);
const ihdrEnd = 8 + 12 + CARD.readUInt32BE(8);
const DIRTY_CARD = Buffer.concat([CARD.subarray(0, ihdrEnd), pngChunk('tEXt', Buffer.from('Author\0Grace Park', 'latin1')), CARD.subarray(ihdrEnd)]);
const pageBody = (bytes, type, version) => ({ expectedVersion: version, mediaType: type, data: bytes.toString('base64') });
const sideEffects = async () => (await sql(`SELECT
  (SELECT count(*)::int FROM hon.people WHERE organization_id=$1) people,
  (SELECT count(*)::int FROM hon.student_import_batches WHERE organization_id=$1) student_batches,
  (SELECT count(*)::int FROM hon.history_import_batches WHERE organization_id=$1) history_batches,
  (SELECT count(*)::int FROM hon.imported_attendance_history WHERE organization_id=$1) attendance,
  (SELECT count(*)::int FROM hon.memberships WHERE organization_id=$1) memberships,
  (SELECT count(*)::int FROM hon.invoices WHERE organization_id=$1) invoices,
  (SELECT count(*)::int FROM hon.crm_leads WHERE organization_id=$1) leads`, [ids.organization])).rows[0];

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Empty list and published limits.
  const empty = await success(() => list(IMPORTER), 'empty list');
  ok(empty.data.sets.length === 0 && empty.data.maxPages === 10 && empty.data.maxPageBytes === 1400000 && empty.data.maxRows === 200 && empty.data.retentionDays === 30, 'limits are published');
  const before = await sideEffects();

  // 2. Authority: permission, family-type role, other school and organization, suspended paid access, transport.
  for (const [actor, label] of [[NONE, 'every other permission'], [MIXED, 'students.import only through a PARENT_PORTAL role']]) {
    await refused(() => list(actor), 403, undefined, `list refused: ${label}`);
    await refused(() => create(actor, { kind: 'STUDENT_CARDS' }), 403, undefined, `create refused: ${label}`);
  }
  await refused(() => create(IMPORTER, { kind: 'STUDENT_CARDS' }, { school: ids.schoolB }), 403, undefined, 'another school of the same organization');
  await refused(() => create(IMPORTER, { kind: 'STUDENT_CARDS' }, { org: ids.otherOrganization, school: ids.otherSchool }), 403, undefined, 'another organization');
  await refused(() => create(IMPORTER, { kind: 'STUDENT_CARDS' }, { command: 'students.paper_import.send' }), 403, 'HUMAN_UI_REQUIRED', 'another command name');
  await refused(() => create(IMPORTER, { kind: 'STUDENT_CARDS' }, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'a delegated source header');
  await refused(() => create(IMPORTER, { kind: 'STUDENT_CARDS' }, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'create without a key');
  for (const body of [{}, { kind: 'PASSPORTS' }, { kind: 'STUDENT_CARDS', extra: 1 }]) await refused(() => create(IMPORTER, body), 400, 'PAPER_IMPORT_INVALID', `create refused: ${JSON.stringify(body)}`);
  await sql("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.organization]);
  await refused(() => create(OWN, { kind: 'STUDENT_CARDS' }), 403, undefined, 'create refused while paid access is suspended');
  await sql("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.organization]);
  ok((await sql('SELECT count(*)::int n FROM hon.paper_import_requests WHERE organization_id=$1', [ids.organization])).rows[0].n === 0, 'refused calls reserved no key');

  // 3. Create with exact replay; pages: metadata stripped, checked by structure, duplicates and wrong types refused.
  const createKey = randomUUID();
  const cards = (await success(() => create(IMPORTER, { kind: 'STUDENT_CARDS' }, { key: createKey }), 'create student cards')).data;
  ok(cards.status === 'OPEN' && cards.target === 'STUDENTS' && cards.version === 1 && cards.pageCount === 0, 'a new set is OPEN with no pages');
  ok(Date.parse(cards.expiresAt) - Date.parse(cards.createdAt) === 30 * 86400000, 'a set expires 30 days after it is made');
  const replay = await success(() => create(IMPORTER, { kind: 'STUDENT_CARDS' }, { key: createKey }), 'create replay');
  ok(replay.meta.replayed === true && replay.data.id === cards.id, 'the same key returns the same set');
  await refused(() => create(IMPORTER, { kind: 'CONTRACTS' }, { key: createKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'a key reused for another kind');
  await refused(() => detail(OTHER_SCHOOL, cards.id), 404, 'PAPER_IMPORT_NOT_FOUND', 'another school cannot see the set');
  await refused(() => detail(OTHER_ORG, cards.id), 404, 'PAPER_IMPORT_NOT_FOUND', 'another organization cannot see the set');

  let v = 1;
  const first = (await success(() => addPage(IMPORTER, cards.id, pageBody(DIRTY_CARD, 'image/png', v)), 'add the card page with a text chunk')).data; v = first.version;
  ok(first.pageCount === 1 && v === 2, 'page 1 added');
  const photo = (await success(() => addPage(IMPORTER, cards.id, pageBody(DIRTY_JPEG, 'image/jpeg', v)), 'add a JPEG photo with EXIF')).data; v = photo.version;
  const stored = (await sql('SELECT page_no,media_type,content,checksum FROM hon.paper_import_pages WHERE set_id=$1 ORDER BY page_no', [cards.id])).rows;
  ok(stored.length === 2 && stored[0].checksum === sha(CARD) && Buffer.compare(stored[0].content, CARD) === 0, 'the PNG is stored without its text chunk (equal to the clean sample)');
  ok(!stored[1].content.includes(Buffer.from('Exif')) && !stored[1].content.includes(Buffer.from('GPS')) && stored[1].content.subarray(-2).equals(Buffer.from([0xff, 0xd9])), 'the JPEG is stored without EXIF or trailing data');
  await refused(() => addPage(IMPORTER, cards.id, pageBody(CARD, 'image/png', v)), 409, 'PAPER_IMPORT_PAGE_DUPLICATE', 'the same page twice');
  await refused(() => addPage(IMPORTER, cards.id, pageBody(PHOTO, 'image/png', v)), 400, 'PAPER_IMPORT_IMAGE_REFUSED', 'a JPEG declared as PNG');
  await refused(() => addPage(IMPORTER, cards.id, pageBody(Buffer.from('%PDF-1.7 not an image'), 'image/jpeg', v)), 400, 'PAPER_IMPORT_IMAGE_REFUSED', 'a PDF');
  await refused(() => addPage(IMPORTER, cards.id, pageBody(CONTRACT, 'image/png', 1)), 409, 'VERSION_CONFLICT', 'a stale version');
  await refused(() => addPage(OTHER_SCHOOL, cards.id, pageBody(CONTRACT, 'image/png', v)), 404, 'PAPER_IMPORT_NOT_FOUND', 'a page from another school');
  for (const [bytes, label] of [[APP12_JPEG, 'an APP12 comment'], [LATE_EXIF_JPEG, 'EXIF placed after the image data']]) {
    const scratch = (await success(() => create(IMPORTER, { kind: 'STUDENT_CARDS' }), `a set for ${label}`)).data;
    await success(() => addPage(IMPORTER, scratch.id, pageBody(bytes, 'image/jpeg', 1)), `a JPEG with ${label} is cleaned`);
    const kept = (await sql('SELECT content FROM hon.paper_import_pages WHERE set_id=$1', [scratch.id])).rows[0].content;
    ok(!kept.includes(Buffer.from('Grace')) && !kept.includes(Buffer.from('GPS')) && kept.equals(stored[1].content), `${label} is removed before storage`);
  }
  // The database refuses metadata and malformed images itself, even past the API.
  await sql('BEGIN');
  ok((await sql("SELECT hon.paper_import_image_clean('image/png',$1) a, hon.paper_import_image_clean('image/jpeg',$2) b, hon.paper_import_image_clean('image/png',$3) c, hon.paper_import_image_clean('image/jpeg',$4) d, hon.paper_import_image_clean('image/webp',$5) e",
    [DIRTY_CARD, DIRTY_JPEG, CARD, stored[1].content, await fixture('paper-page.webp')])).rows.every((r) => r.a === false && r.b === false && r.c === true && r.d === true && r.e === true), 'the database structure check refuses metadata and accepts clean pages');
  ok((await sql("SELECT hon.paper_import_image_clean('image/jpeg',$1) a, hon.paper_import_image_clean('image/jpeg',$2) b, hon.paper_import_image_clean('image/jpeg',$3) c",
    [APP12_JPEG, LATE_EXIF_JPEG, ICC_JPEG])).rows.every((r) => r.a === false && r.b === false && r.c === true), 'the database refuses any other APPn segment and metadata after the first scan, and keeps an ICC profile');
  await sql('ROLLBACK');

  // 4. The page image is returned only to import staff at that school, never cached.
  const img = (await success(() => pageImage(IMPORTER, cards.id, 1), 'page image')).data;
  ok(img.mediaType === 'image/png' && Buffer.from(img.data, 'base64').equals(CARD), 'page 1 comes back exactly');
  await refused(() => pageImage(OTHER_SCHOOL, cards.id, 1), 404, 'PAPER_IMPORT_NOT_FOUND', 'page image from another school');
  await refused(() => pageImage(NONE, cards.id, 1), 403, undefined, 'page image without permission');
  await refused(() => pageImage(IMPORTER, cards.id, 3), 404, 'PAPER_IMPORT_NOT_FOUND', 'a page that does not exist');

  // 5. Reading: the AI spend decision comes first; an HQ pause refuses before anything is read.
  const pause = randomUUID();
  await sql("INSERT INTO hon.ai_spend_pauses(id,organization_id,spend_class,reason,pause_key,pause_fingerprint,paused_by_principal_id) VALUES($1,$2,'AGENT_INFERENCE','Proof: emergency pause for paper import',$3,$4,$5)",
    [pause, ids.organization, randomUUID(), 'a'.repeat(64), OWN.principal]);
  const blocked = await refused(() => readSet(IMPORTER, cards.id, { expectedVersion: v }), 403, 'PAPER_IMPORT_AI_BLOCKED', 'reading refused during an HQ AI pause');
  ok(blocked.reason === 'AI_PAUSED_BY_HQ', 'the refusal names the HQ pause');
  ok(readerCalls === 0 && (await sql('SELECT reading_id FROM hon.paper_import_sets WHERE id=$1', [cards.id])).rows[0].reading_id === null, 'nothing was read or started');
  await sql('ALTER TABLE hon.ai_spend_pauses DISABLE TRIGGER USER'); await sql('DELETE FROM hon.ai_spend_pauses WHERE id=$1', [pause]); await sql('ALTER TABLE hon.ai_spend_pauses ENABLE TRIGGER USER');
  await refused(() => readSet(IMPORTER, cards.id, { expectedVersion: v }, { key: randomUUID() }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'reading takes no key');
  // A reading that began (and did not finish) fixes the pages: none may be added, and Read begins it again.
  await sql('ALTER TABLE hon.paper_import_sets DISABLE TRIGGER USER');
  await sql('UPDATE hon.paper_import_sets SET reading_id=gen_random_uuid(), reading_started_at=clock_timestamp() WHERE id=$1', [cards.id]);
  await sql('ALTER TABLE hon.paper_import_sets ENABLE TRIGGER USER');
  await refused(() => addPage(IMPORTER, cards.id, pageBody(CONTRACT, 'image/png', v)), 409, 'PAPER_IMPORT_ALREADY_READ', 'no page once a reading has begun');
  const read = (await success(() => readSet(IMPORTER, cards.id, { expectedVersion: v }), 'read the student cards')).data;
  ok(readerCalls === 1 && read.set.status === 'READ' && read.set.reader === 'SYNTHETIC' && read.set.readOutcome === 'SAMPLE_READ', 'the stand-in read the sample');
  ok(read.rows.length === 1 && read.rows[0][0] === 'Mina' && read.rows[0][8] === '+12135550142' && read.unsure[0][8] === true, 'the sample card became one row, its phone marked unsure');
  ok(read.columns.length === 10 && read.pages.length === 2, 'columns and pages are listed');
  const readAgain = (await success(() => readSet(IMPORTER, cards.id, { expectedVersion: 1 }), 'read again')).data;
  ok(readerCalls === 1 && readAgain.set.version === read.set.version, 'a set is read once: a repeat returns the same table');
  await refused(() => addPage(IMPORTER, cards.id, pageBody(CONTRACT, 'image/png', read.set.version)), 409, 'PAPER_IMPORT_ALREADY_READ', 'no page after reading');
  // A stale reading result can never be recorded (database-level).
  await assert.rejects(runtime.query("SELECT hon.record_paper_reading('x',$1,'{}'::jsonb,gen_random_uuid(),gen_random_uuid())", [cards.id]), /PAPER_IMPORT_INVALID|PAPER_IMPORT_FORBIDDEN/); checks += 1;

  // 6. Staff correct the table: exact shape only; invalid cells refused.
  v = read.set.version;
  const row = (given, family, birth, gGiven, gFamily, gEmail, gMobile, key) => [given, family, birth, '', '', gGiven, gFamily, gEmail, gMobile, key];
  const rows = [row('Mina', 'Park', '2017-03-14', 'Grace', 'Park', 'grace.park@example.com', '+12135550142', 'park'),
    row('Jun', 'Park', '2019-06-01', '', '', '', '', 'park'), row('', '', '', '', '', '', '', ''), row('Kid', 'Alone', '2019-01-01', '', '', '', '', '')];
  const unsure = rows.map((r) => r.map(() => false));
  await refused(() => save(IMPORTER, cards.id, { expectedVersion: v, rows: [['a', 'b', 'c', 'd', 'e', 'f']], unsure: [[false, false, false, false, false, false]] }), 400, 'PAPER_IMPORT_INVALID', 'attendance-width rows on a student set');
  await refused(() => save(IMPORTER, cards.id, { expectedVersion: v, rows: [row('A\u0007', 'B', '', '', '', '', '', '')], unsure: [unsure[0]] }), 400, 'PAPER_IMPORT_INVALID', 'a control character');
  const saved = (await success(() => save(IMPORTER, cards.id, { expectedVersion: v, rows, unsure }), 'save the corrected table')).data;
  ok(saved.version === v + 1 && saved.status === 'READ', 'the table saved');
  ok(!JSON.stringify((await sql("SELECT response FROM hon.paper_import_requests WHERE organization_id=$1", [ids.organization])).rows).includes('Mina'), 'request receipts never hold a name');
  ok(!JSON.stringify((await sql("SELECT next_state FROM hon.audit_events WHERE entity_type='PAPER_IMPORT_SET' AND organization_id=$1", [ids.organization])).rows).includes('Mina'), 'audit is identifier-only');
  ok(JSON.stringify(await sideEffects()) === JSON.stringify(before), 'nothing outside the paper import changed before sending');

  // 7. Send: blank rows dropped; the existing student import stages exactly the saved rows; staff decide them there.
  const sendKey = randomUUID();
  const sent = (await success(() => send(IMPORTER, cards.id, { expectedVersion: saved.version }, { key: sendKey }), 'send to review')).data;
  ok(sent.status === 'SENT' && sent.sentBatchId, 'the set is SENT and names its batch');
  const batch = (await sql('SELECT * FROM hon.student_import_batches WHERE id=$1', [sent.sentBatchId])).rows[0];
  const batchRows = (await sql('SELECT row_index,normalized,validation_errors,choice FROM hon.student_import_rows WHERE batch_id=$1 ORDER BY row_index', [batch.id])).rows;
  ok(batch.school_id === ids.schoolA && batch.status === 'STAGED' && batch.row_count === 3 && batch.created_by_principal_id === IMPORTER.principal, 'a STAGED student batch at the same school with the 3 non-blank rows');
  ok(batchRows.every((r) => r.choice === null), 'no row is decided: staff decide every row in the existing review');
  ok(batchRows[1].normalized.guardian?.givenName === 'Grace' && batchRows[2].validation_errors.includes('guardian:REQUIRED_FOR_MINOR'), 'the existing checks ran (family key guardian, minor rule)');
  const after = await sideEffects();
  ok(after.people === before.people && after.student_batches === before.student_batches + 1 && after.memberships === before.memberships && after.leads === before.leads, 'sending creates a staged batch only: no person, membership or lead');
  const sendReplay = await success(() => send(IMPORTER, cards.id, { expectedVersion: saved.version }, { key: sendKey }), 'send replay');
  ok(sendReplay.meta.replayed && sendReplay.data.sentBatchId === sent.sentBatchId && (await sideEffects()).student_batches === after.student_batches, 'an exact replay returns the same batch, no second batch');
  await refused(() => send(IMPORTER, cards.id, { expectedVersion: sent.version }), 409, 'PAPER_IMPORT_NOT_EDITABLE', 'a set is sent once');
  await refused(() => save(IMPORTER, cards.id, { expectedVersion: sent.version, rows, unsure }), 409, 'PAPER_IMPORT_NOT_EDITABLE', 'no edits after sending');

  // 8. Attendance sheet: unknown photo reads as an empty table; staff type rows; sent to the attendance-history import.
  const sheet = (await success(() => create(IMPORTER, { kind: 'ATTENDANCE_SHEETS' }), 'create attendance set')).data;
  await refused(() => readSet(IMPORTER, sheet.id, { expectedVersion: 1 }), 400, 'PAPER_IMPORT_NO_PAGES', 'reading needs a page');
  let s2 = (await success(() => addPage(IMPORTER, sheet.id, pageBody(PHOTO, 'image/jpeg', 1)), 'add a non-sample photo')).data;
  const blank = (await success(() => readSet(IMPORTER, sheet.id, { expectedVersion: s2.version }), 'read a non-sample photo')).data;
  ok(blank.set.readOutcome === 'NOT_READABLE' && blank.rows.length === 0 && blank.columns.join() === 'studentGivenName,studentFamilyName,birthDate,attendedOn,visits,className', 'a real photo is never guessed: empty table, attendance columns');
  await refused(() => send(IMPORTER, sheet.id, { expectedVersion: blank.set.version }), 400, 'PAPER_IMPORT_TABLE_EMPTY', 'an empty table is not sent');
  s2 = (await success(() => save(IMPORTER, sheet.id, { expectedVersion: blank.set.version, rows: [['Mina', 'Park', '', '2026-11-02', '1', 'Kids'], ['=cmd()', 'X', '', '2026-11-02', '', '']], unsure: [Array(6).fill(false), Array(6).fill(false)] }), 'type the attendance rows')).data;
  const sheetSent = (await success(() => send(IMPORTER, sheet.id, { expectedVersion: s2.version }), 'send attendance')).data;
  const hb = (await sql('SELECT kind,row_count,status FROM hon.history_import_batches WHERE id=$1', [sheetSent.sentBatchId])).rows[0];
  const hr = (await sql('SELECT validation_errors FROM hon.history_import_rows WHERE batch_id=$1 ORDER BY row_index', [sheetSent.sentBatchId])).rows;
  ok(hb?.kind === 'ATTENDANCE' && hb.row_count === 2 && hb.status === 'STAGED', 'an ATTENDANCE history batch was staged');
  ok(JSON.stringify(hr[1].validation_errors).includes('FORMULA'), 'a typed formula is caught by the existing import checks');
  ok((await sideEffects()).attendance === before.attendance, 'no attendance history exists until staff finalize there');

  // 9. Delete: pages and table erased at once, any state; the set record stays without names.
  const contract = (await success(() => create(IMPORTER, { kind: 'CONTRACTS' }), 'create contract set')).data;
  const c2 = (await success(() => addPage(IMPORTER, contract.id, pageBody(CONTRACT, 'image/png', 1)), 'add contract page')).data;
  const cRead = (await success(() => readSet(IMPORTER, contract.id, { expectedVersion: c2.version }), 'read contract')).data;
  ok(cRead.rows[0][0] === 'Leo' && cRead.unsure[0][7] === true, 'the sample contract was read');
  const delKey = randomUUID();
  const gone = (await success(() => remove(IMPORTER, contract.id, { key: delKey }), 'delete the contract set')).data;
  ok(gone.status === 'DELETED' && gone.deleteReason === 'STAFF' && gone.pageCount === 0, 'deleted by staff');
  const row0 = (await sql('SELECT table_rows,table_unsure,page_checksums,deleted_by_principal_id FROM hon.paper_import_sets WHERE id=$1', [contract.id])).rows[0];
  ok(row0.table_rows === null && row0.table_unsure === null && row0.page_checksums.length === 1 && row0.deleted_by_principal_id === IMPORTER.principal, 'table erased; checksums and who deleted it kept');
  ok((await sql('SELECT count(*)::int n FROM hon.paper_import_pages WHERE set_id=$1', [contract.id])).rows[0].n === 0, 'image bytes erased');
  await refused(() => pageImage(IMPORTER, contract.id, 1), 404, 'PAPER_IMPORT_NOT_FOUND', 'a deleted page is never returned');
  const gd = (await success(() => detail(IMPORTER, contract.id), 'deleted detail')).data;
  ok(gd.rows.length === 0 && gd.pages.length === 0, 'the deleted set shows no table or page');
  ok((await success(() => remove(IMPORTER, contract.id, { key: delKey }), 'delete replay')).meta.replayed, 'delete replays');
  await refused(() => readSet(IMPORTER, contract.id, { expectedVersion: gone.version }), 404, 'PAPER_IMPORT_GONE', 'a deleted set cannot be read');
  const sentGone = (await success(() => remove(IMPORTER, cards.id), 'delete the sent set')).data;
  ok(sentGone.status === 'DELETED' && sentGone.sentBatchId === sent.sentBatchId, 'a sent set can be deleted and keeps its batch link');
  ok((await sql('SELECT count(*)::int n FROM hon.student_import_batches WHERE id=$1', [sent.sentBatchId])).rows[0].n === 1, 'the staged batch is the import\'s own record and stays');

  // 10. Expiry: 30 days after upload the set reads as erased, and the next command at the school erases it.
  const old = (await success(() => create(IMPORTER, { kind: 'STUDENT_CARDS' }), 'create a set to expire')).data;
  await success(() => addPage(IMPORTER, old.id, pageBody(CARD, 'image/png', 1)), 'add a page to expire');
  await sql('BEGIN'); await sql('ALTER TABLE hon.paper_import_sets DISABLE TRIGGER USER');
  await sql("UPDATE hon.paper_import_sets s SET created_at=x.t,expires_at=x.t+interval '30 days' FROM (SELECT clock_timestamp()-interval '31 days' t) x WHERE s.id=$1", [old.id]);
  await sql('ALTER TABLE hon.paper_import_sets ENABLE TRIGGER USER'); await sql('COMMIT');
  const expired = (await success(() => detail(IMPORTER, old.id), 'expired detail')).data;
  ok(expired.set.status === 'DELETED' && expired.set.deleteReason === 'EXPIRED' && expired.pages.length === 0, 'an expired set already reads as erased');
  await refused(() => pageImage(IMPORTER, old.id, 1), 404, 'PAPER_IMPORT_NOT_FOUND', 'an expired page is never returned');
  ok((await sql('SELECT count(*)::int n FROM hon.paper_import_pages WHERE set_id=$1', [old.id])).rows[0].n === 1, 'bytes still there until the next command');
  await success(() => create(OTHER_SCHOOL, { kind: 'STUDENT_CARDS' }, { school: ids.schoolB }), 'a command at another school');
  ok((await sql('SELECT count(*)::int n FROM hon.paper_import_pages WHERE set_id=$1', [old.id])).rows[0].n === 1, 'another school\'s command does not touch this school');
  await success(() => create(IMPORTER, { kind: 'STUDENT_CARDS' }), 'a command at the same school');
  const purged = (await sql('SELECT status,delete_reason,deleted_by_principal_id FROM hon.paper_import_sets WHERE id=$1', [old.id])).rows[0];
  ok(purged.status === 'DELETED' && purged.delete_reason === 'EXPIRED' && purged.deleted_by_principal_id === null, 'the set was erased as EXPIRED');
  ok((await sql('SELECT count(*)::int n FROM hon.paper_import_pages WHERE set_id=$1', [old.id])).rows[0].n === 0, 'its bytes are gone');
  ok(typeof (await sql('SELECT hon.purge_expired_paper_imports() n')).rows[0].n === 'number', 'the owner-only school-wide purge runs');

  // 11. Live permission loss is seen; list scoping.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=$2 WHERE id=$1', [IMPORTER.grants[0], OWN.principal]);
  await refused(() => detail(IMPORTER, sheet.id), 403, undefined, 'a revoked grant cannot read');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1', [IMPORTER.grants[0]]);
  const mine = (await success(() => list(OWN), 'owner list')).data.sets;
  ok(mine.length === 7 && mine.every((x) => x.id !== undefined), 'the school list holds this school\'s seven sets only (two hold the cleaned JPEGs)');

  // 12. Evidence guards (settings-free).
  await sql('BEGIN');
  await rejectsSql(() => sql('DELETE FROM hon.paper_import_sets WHERE id=$1', [sheet.id]), /PAPER_IMPORT_IMMUTABLE/, 'a set is never deleted');
  await rejectsSql(() => sql('DELETE FROM hon.paper_import_pages WHERE set_id=$1', [sheet.id]), /PAPER_IMPORT_IMMUTABLE/, 'a page of a live set is never deleted directly');
  await rejectsSql(() => sql("UPDATE hon.paper_import_pages SET media_type='image/png' WHERE set_id=$1", [sheet.id]), /PAPER_IMPORT_IMMUTABLE/, 'a page never changes');
  await rejectsSql(() => sql("UPDATE hon.paper_import_sets SET kind='CONTRACTS',target='STUDENTS',version=version+1 WHERE id=$1", [sheet.id]), /PAPER_IMPORT_IMMUTABLE/, 'the kind never changes');
  await rejectsSql(() => sql("UPDATE hon.paper_import_sets SET status='OPEN',version=version+1 WHERE id=$1", [sheet.id]), /PAPER_IMPORT_IMMUTABLE|violates check/, 'a sent set never reopens');
  await rejectsSql(() => sql("UPDATE hon.paper_import_sets SET reader='OPENROUTER',version=version+1 WHERE id=$1", [sheet.id]), /check constraint|PAPER_IMPORT_IMMUTABLE/, 'no reader but SYNTHETIC can be recorded');
  await rejectsSql(() => sql("UPDATE hon.paper_import_sets SET version=version+1 WHERE id=$1", [contract.id]), /PAPER_IMPORT_IMMUTABLE/, 'a deleted set is final');
  await rejectsSql(() => sql('TRUNCATE hon.paper_import_requests'), /PAPER_IMPORT_IMMUTABLE/, 'requests are never truncated');
  await sql('ROLLBACK');

  // 13. Runtime ACL: EXECUTE on the ten entry points only; no table privilege, no helper, nothing for PUBLIC.
  const entry = ['create_paper_import(text,jsonb,text,uuid,uuid)', 'add_paper_import_page(text,uuid,jsonb,text,uuid,uuid)', 'begin_paper_reading(text,uuid,jsonb,uuid,uuid)',
    'record_paper_reading(text,uuid,jsonb,uuid,uuid)', 'save_paper_import_table(text,uuid,jsonb,text,uuid,uuid)', 'send_paper_import(text,uuid,jsonb,text,uuid,uuid)',
    'delete_paper_import(text,uuid,jsonb,text,uuid,uuid)', 'read_paper_imports(text)', 'read_paper_import(text,uuid)', 'read_paper_import_page(text,uuid,integer)'];
  const helpers = ['guard_paper_import()', 'paper_import_columns(text)', 'paper_import_cell_ok(jsonb)', 'paper_import_table_ok(text,jsonb,jsonb)', 'paper_import_image_clean(text,bytea)',
    'paper_import_summary(hon.paper_import_sets)', 'paper_import_detail(hon.paper_import_sets)', 'paper_import_erase(uuid,text,uuid)', 'paper_import_purge_school(uuid,uuid)',
    'purge_expired_paper_imports()', 'paper_import_begin(text,text,jsonb,text,uuid,uuid)', 'require_paper_import_actor(text)', 'paper_import_finish(text,uuid,text,uuid,text,uuid,uuid,jsonb)',
    'paper_import_lock(uuid,jsonb)', 'paper_import_csv_field(text)'];
  for (const fn of entry) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of helpers) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  for (const table of ['paper_import_sets', 'paper_import_pages', 'paper_import_requests']) {
    const r = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(r.forced && !r.runtime, `${table}: forced RLS, no runtime privilege`);
  }
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const start = '-- Paper import exact verification (0388)', end = '-- End paper import exact verification.';
    const section = verify.split(start)[1]?.split(end)[0];
    ok(section, start);
    await sql(section.replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }
  await assert.rejects(runtime.query('SELECT * FROM hon.paper_import_pages LIMIT 1'), /permission denied/); checks += 1;
  await assert.rejects(runtime.query('SELECT hon.purge_expired_paper_imports()'), /permission denied/); checks += 1;
  await assert.rejects(runtime.query('SELECT hon.read_paper_imports($1)', [IMPORTER.subject]), /PAPER_IMPORT_FORBIDDEN/); checks += 1;

  console.log(`PASS: paper import (0388): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
