/**
 * School page branding proof (0285) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards + global
 * ValidationPipe + HonExceptionFilter -> SchoolBrandingController -> protected definer functions on the restricted runtime
 * role with forced RLS), plus the public display read on the runtime role, on the guarded disposable CRM-close fixture only.
 * Synthetic data; nothing uploads or fetches an image, takes a payment or sends a message.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
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
const { SchoolBrandingController } = await load('school-branding/school-branding.controller.js');
const { SchoolBrandingService } = await load('school-branding/school-branding.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-branding', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };


let app, origin;
const database = new RuntimeDatabaseService();
async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [SchoolBrandingController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolBrandingService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
const SAVE = 'school_branding.save';
function call(actor, method, { body, key = randomUUID(), command = SAVE, headers = {}, school = actor.school, organization = actor.org, query = '' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/settings/branding${query}`);
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
const read = (actor, options = {}) => call(actor, 'GET', options);
const save = (actor, body, options = {}) => call(actor, 'POST', { body, ...options });
async function success(run, label) {
  const { status, body, headers } = await run();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  return body;
}
async function refused(run, expectedStatus, expectedCode, label) {
  const { status, body } = await run();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
}
async function rejectsSql(run, pattern, label) {
  await sql('SAVEPOINT expected_failure');
  try { await run(); } catch (error) { await sql('ROLLBACK TO SAVEPOINT expected_failure'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK TO SAVEPOINT expected_failure');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0240 proof).
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
    const left = (await sql('SELECT count(*)::int n FROM hon.school_page_branding WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left branding behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`branding-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`branding-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`branding-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `branding-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Branding Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Branding Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}


const EMPTY = { logoUrl: null, coverUrl: null, accentColor: null, contactLine: null };
const LOOK = { logoUrl: 'https://cdn.example.com/schools/tiger/logo.png', coverUrl: 'https://images.example.com/cover.jpg?w=1600&fit=crop',
  accentColor: '#c81e1e', contactLine: '도장 Tiger Kim · (555) 010-0100 · 123 Main St' };
const body = (branding, expectedVersion) => ({ branding, expectedVersion });

let OWN, NONE, MIXED, OWN_B, OTHER_ORG, LOSER;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Branding Org','Branding Org'),($2,'Branding Other Org','Branding Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Branding ${slug}`, `branding-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  NONE = await staff('none', [await role(ids.organization, ['school_checkout.manage', 'schedule.session.manage', 'people.read'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['school_branding.manage']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['school_branding.manage'])], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
  LOSER = await staff('loser', [await role(ids.organization, ['school_branding.manage'])]);
}
const publicRead = async (school) => (await runtime.query('SELECT hon.read_public_school_branding($1::uuid) AS data', [school])).rows[0].data;

try {
  await cleanup();
  await seed();
  await startApp();

  // 0. Permission and OWNER grant.
  ok((await sql("SELECT count(*)::int n FROM hon.permissions WHERE code='school_branding.manage' AND is_sensitive AND is_staff_assignable")).rows[0].n === 1, 'school_branding.manage is sensitive and staff-assignable');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER' AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp
    WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code='school_branding.manage')`)).rows[0].n === 0, 'every system OWNER role holds it');

  // 1. Read: version 0 with nothing set; everyone else refused.
  const empty = (await success(() => read(OWN), 'owner read')).data.branding;
  ok(JSON.stringify(empty) === JSON.stringify({ ...EMPTY, version: 0, updatedAt: null }), `nothing set yet ${JSON.stringify(empty)}`);
  for (const actor of [NONE, MIXED]) await refused(() => read(actor), 403, undefined, `read refused for ${actor.subject.split('-').pop()}`);
  await refused(() => read(OWN_B, { school: ids.schoolA }), 403, undefined, 'school-B manager at the school-A route');
  await refused(() => read(OTHER_ORG, { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'other-organization owner at the school-A route');
  await refused(() => read(OWN, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key');
  await refused(() => read(OWN, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'read with a source header');
  await refused(() => read(OWN, { query: '?v=1' }), 400, 'VALIDATION_FAILED', 'read with a query');
  await refused(() => read(OWN, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site read');

  // 2. Save: refusals before anything is written.
  for (const actor of [NONE, MIXED]) await refused(() => save(actor, body(LOOK, 0)), 403, undefined, `save refused for ${actor.subject.split('-').pop()}`);
  await refused(() => save(OWN, body(LOOK, 0), { command: 'school_checkout.page.save' }), 403, 'HUMAN_UI_REQUIRED', 'save under another command header');
  await refused(() => save(OWN, body(LOOK, 0), { key: '' }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'save without a key');
  for (const [label, value] of [
    ['http logo', { ...LOOK, logoUrl: 'http://cdn.example.com/logo.png' }], ['data logo', { ...LOOK, logoUrl: 'data:image/png;base64,AAAA' }],
    ['javascript cover', { ...LOOK, coverUrl: 'javascript:alert(1)' }], ['upper-case host', { ...LOOK, logoUrl: 'https://CDN.example.com/logo.png' }],
    ['host without a dot', { ...LOOK, coverUrl: 'https://localhost/cover.jpg' }], ['quote in a URL', { ...LOOK, coverUrl: 'https://cdn.example.com/a"onload=x' }],
    ['space in a URL', { ...LOOK, coverUrl: 'https://cdn.example.com/a b.jpg' }], ['credentials in a URL', { ...LOOK, coverUrl: 'https://user:pw@cdn.example.com/a.jpg' }],
    ['URL over 500', { ...LOOK, coverUrl: `https://cdn.example.com/${'a'.repeat(480)}` }],
    ['named color', { ...LOOK, accentColor: 'red' }], ['upper-case color', { ...LOOK, accentColor: '#C81E1E' }], ['short color', { ...LOOK, accentColor: '#c81' }],
    ['html contact', { ...LOOK, contactLine: '<b>Call</b>' }], ['multi-line contact', { ...LOOK, contactLine: 'a\nb' }], ['padded contact', { ...LOOK, contactLine: ' a' }],
    ['empty contact', { ...LOOK, contactLine: '' }], ['long contact', { ...LOOK, contactLine: 'x'.repeat(161) }],
    ['missing key', { logoUrl: null, coverUrl: null, accentColor: null }], ['extra key', { ...LOOK, font: 'serif' }], ['number color', { ...LOOK, accentColor: 1 }]]) {
    await refused(() => save(OWN, body(value, 0)), 400, 'VALIDATION_FAILED', label);
  }
  for (const [label, version] of [['negative version', -1], ['fractional version', 0.5], ['string version', '0']]) await refused(() => save(OWN, body(LOOK, version)), 400, 'VALIDATION_FAILED', label);
  await refused(() => save(OWN, { ...body(LOOK, 0), fee: 1 }), 400, undefined, 'an extra top-level field (the global pipe refuses it)');
  await refused(() => save(OWN, body(LOOK, 3)), 409, 'VERSION_CONFLICT', 'a first save must expect version 0');
  ok((await sql('SELECT count(*)::int n FROM hon.school_page_branding WHERE organization_id=$1', [ids.organization])).rows[0].n === 0, 'no refusal wrote branding');

  // 3. Create, replay, key reuse, replace, clear.
  const key1 = randomUUID();
  const created = await success(() => save(OWN, body(LOOK, 0), { key: key1 }), 'create');
  const first = created.data.branding;
  ok(first.version === 1 && created.meta.replayed === false && first.logoUrl === LOOK.logoUrl && first.coverUrl === LOOK.coverUrl
    && first.accentColor === LOOK.accentColor && first.contactLine === LOOK.contactLine && /Z$/.test(first.updatedAt), 'created at version 1 with every value exactly');
  const replay = await success(() => save(OWN, body(LOOK, 0), { key: key1 }), 'replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(created.data), 'exact replay returns the first receipt');
  await refused(() => save(OWN, body({ ...LOOK, accentColor: '#000000' }, 0), { key: key1 }), 409, 'IDEMPOTENCY_KEY_REUSED', 'the same key with another body');
  await refused(() => save(OWN, body(LOOK, 0)), 409, 'VERSION_CONFLICT', 'a second create');
  const second = (await success(() => save(OWN, body({ ...LOOK, coverUrl: null, accentColor: '#1d4ed8' }, 1)), 'replace')).data.branding;
  ok(second.version === 2 && second.coverUrl === null && second.accentColor === '#1d4ed8' && second.logoUrl === LOOK.logoUrl, 'replaced at version 2');
  await refused(() => save(OWN, body(LOOK, 1)), 409, 'VERSION_CONFLICT', 'stale version');
  const cleared = (await success(() => save(OWN, body(EMPTY, 2)), 'clear')).data.branding;
  ok(cleared.version === 3 && cleared.logoUrl === null && cleared.contactLine === null, 'everything can be cleared (version 3)');
  const again = (await success(() => save(OWN, body(LOOK, 3)), 'set again')).data.branding;
  ok(again.version === 4, 'set again at version 4');
  ok(JSON.stringify((await success(() => read(OWN), 'read after saves')).data.branding) === JSON.stringify(again), 'read returns the saved branding');
  ok((await success(() => read(OWN_B), 'school-B read')).data.branding.version === 0, 'school B sees none of school A branding');

  // 4. Public display read on the runtime role: active school only, no ids, no people.
  const shown = await publicRead(ids.schoolA);
  ok(JSON.stringify(Object.keys(shown).sort()) === JSON.stringify(['accentColor', 'contactLine', 'coverUrl', 'logoUrl', 'schoolName', 'updatedAt', 'version']), `public keys ${Object.keys(shown)}`);
  ok(shown.schoolName === 'Branding a' && shown.logoUrl === LOOK.logoUrl && shown.version === 4, 'public read shows the saved branding and the school name');
  ok(!JSON.stringify(shown).includes(ids.schoolA) && !JSON.stringify(shown).includes(ids.organization) && !JSON.stringify(shown).includes(OWN.principal), 'public read carries no ids');
  const unset = await publicRead(ids.schoolB);
  ok(unset.schoolName === 'Branding b' && unset.version === 0 && unset.logoUrl === null, 'a school without branding shows its name only');
  ok(await publicRead(randomUUID()) === null && await publicRead(null) === null, 'unknown or missing school: null');
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.schoolA]);
  ok(await publicRead(ids.schoolA) === null, 'suspended school: null');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.schoolA]);
  await sql("UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1", [ids.organization]);
  ok(await publicRead(ids.schoolA) === null, 'suspended organization: null');
  await sql("UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1", [ids.organization]);

  // 5. Live authority loss: revoked grant, suspended entitlement, suspended school.
  await success(() => read(LOSER), 'loser read before');
  for (const [label, take, restore] of [
    ['grant revoked', 'UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', 'UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1'],
    ['entitlement suspended', "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)"],
    ['school suspended', "UPDATE hon.schools SET status='SUSPENDED' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.schools SET status='ACTIVE' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)"]]) {
    await sql(take, [LOSER.grants[0]]);
    await refused(() => read(LOSER), 403, undefined, `${label}: read`);
    await refused(() => save(LOSER, body(EMPTY, 4)), 403, undefined, `${label}: save`);
    await sql(restore, [LOSER.grants[0]]);
  }
  ok((await success(() => save(LOSER, body({ ...LOOK, contactLine: 'Front desk 555-0101' }, 4)), 'loser save after restore')).data.branding.version === 5, 'authority restored');

  // 6. Version history, audit and inert outbox for every save.
  const history = (await sql('SELECT version, branding FROM hon.school_page_branding_versions WHERE school_id=$1 ORDER BY version', [ids.schoolA])).rows;
  ok(history.map((h) => h.version).join() === '1,2,3,4,5' && history[2].branding.logoUrl === null && history[4].branding.contactLine === 'Front desk 555-0101', `history ${history.map((h) => h.version)}`);
  const audit = (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND entity_type='SCHOOL_PAGE_BRANDING' AND action_code='school_branding.save'", [ids.organization])).rows[0].n;
  const outbox = (await sql("SELECT count(*)::int n, bool_and(payload ? 'schoolId' AND payload ? 'version' AND NOT payload ? 'logoUrl') shape FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type='SCHOOL_PAGE_BRANDING' AND status='PENDING'", [ids.organization])).rows[0];
  ok(audit === 5 && outbox.n === 5 && outbox.shape, `one audit and one pending outbox event (ids and version only) per save (${audit}/${outbox.n})`);

  // 7. Guards, whoever writes (inside one rolled-back transaction).
  await sql('BEGIN');
  await rejectsSql(() => sql('UPDATE hon.school_page_branding SET organization_id=$2, version=version+1 WHERE school_id=$1', [ids.schoolA, ids.otherOrganization]), /fixed|foreign key/, 'organization changed');
  await rejectsSql(() => sql("UPDATE hon.school_page_branding SET accent_color='#000000' WHERE school_id=$1", [ids.schoolA]), /fixed/, 'update without a version bump');
  await rejectsSql(() => sql("UPDATE hon.school_page_branding SET accent_color='#000000', version=version+2 WHERE school_id=$1", [ids.schoolA]), /fixed/, 'version jump');
  await rejectsSql(() => sql('DELETE FROM hon.school_page_branding WHERE school_id=$1', [ids.schoolA]), /never deleted/, 'delete');
  await rejectsSql(() => sql('TRUNCATE hon.school_page_branding'), /./, 'truncate');
  await rejectsSql(() => sql("UPDATE hon.school_page_branding SET logo_url='javascript:alert(1)', version=version+1 WHERE school_id=$1", [ids.schoolA]), /check constraint/, 'unsafe logo stored directly');
  await rejectsSql(() => sql("UPDATE hon.school_page_branding SET accent_color='red', version=version+1 WHERE school_id=$1", [ids.schoolA]), /check constraint/, 'named color stored directly');
  await rejectsSql(() => sql("INSERT INTO hon.school_page_branding(school_id,organization_id,version,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,2,$3,$3)", [ids.schoolB, ids.organization, OWN.principal]), /version 1/, 'new row above version 1');
  await rejectsSql(() => sql("UPDATE hon.school_page_branding_versions SET branding='{}' WHERE school_id=$1", [ids.schoolA]), /./, 'history rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.school_page_branding_versions WHERE school_id=$1', [ids.schoolA]), /./, 'history deleted');
  await rejectsSql(() => sql('TRUNCATE hon.school_page_branding_versions'), /./, 'history truncated');
  await sql('ROLLBACK');

  // 8. Runtime ACL: three definer entry points only; helpers and tables private.
  for (const fn of ['read_school_page_branding(text)', 'save_school_page_branding(text,jsonb,text,uuid,uuid)', 'read_public_school_branding(uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['school_branding_image_ok(text)', 'school_branding_input_ok(jsonb)', 'guard_school_page_branding()', 'require_school_branding_actor(text)',
    'school_page_branding_json(hon.school_page_branding)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  for (const table of ['school_page_branding', 'school_page_branding_versions']) {
    const t = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(t.forced && !t.runtime, `${table}: forced RLS, no runtime privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  await assert.rejects(runtime.query("SELECT hon.read_school_page_branding('x')"), /SCHOOL_BRANDING_FORBIDDEN/); checks += 1;
  // The deployment verifier's 0285 section (infra/postgres/011) passes against this database with its runtime role.
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- School page branding exact verification (B-SCH-3 0285)', end = '-- End school page branding exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 9. No money, invoice or message effect.
  ok((await sql('SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) n',
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no payment attempt or invoice was created');

  console.log(`PASS: school page branding (0285): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
