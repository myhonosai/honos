/**
 * School location and face check-in notice proof (0392) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI
 * guards + global ValidationPipe + HonExceptionFilter -> SchoolLocationController -> protected definer functions on the
 * restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic addresses only;
 * nothing turns face check-in on, stores face data, calls a provider, takes a payment or sends a message.
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
const { SchoolLocationController } = await load('school-location/school-location.controller.js');
const { SchoolLocationService } = await load('school-location/school-location.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-location', secret: randomBytes(32).toString('hex') };
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
    controllers: [SchoolLocationController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolLocationService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
const SAVE = 'school_location.save';
function call(actor, method, { body, key = randomUUID(), command = SAVE, headers = {}, school = actor.school, organization = actor.org, query = '' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/settings/location${query}`);
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
    const left = (await sql('SELECT count(*)::int n FROM hon.school_locations WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left a location behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`location-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`location-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`location-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `location-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Location Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Location Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}


const loc = (patch = {}) => ({ country: 'US', region: 'IL', city: 'Chicago', postalCode: '60601', addressLine1: '1 Synthetic Way', addressLine2: null, ...patch });
const body = (location, expectedVersion) => ({ location, expectedVersion });

let OWN, NONE, MIXED, OWN_B, OTHER_ORG, LOSER;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Location Org','Location Org'),($2,'Location Other Org','Location Other Org')", [ids.organization, ids.otherOrganization]);
  // A newly registered school has no paid access (SUSPENDED); its owner must still be able to give the address.
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','SUSPENDED',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Location ${slug}`, `location-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  NONE = await staff('none', [await role(ids.organization, ['school_branding.manage', 'schedule.session.manage', 'people.read'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['school_location.manage']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['school_location.manage'])], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
  LOSER = await staff('loser', [await role(ids.organization, ['school_location.manage'])]);
}
const profileFor = async (country, region, city) => (await sql('SELECT hon.biometric_profile_for($1,$2,$3) p', [country, region, city])).rows[0].p;

try {
  await cleanup();
  await seed();
  await startApp();

  // 0. Permission and OWNER grant.
  ok((await sql("SELECT count(*)::int n FROM hon.permissions WHERE code='school_location.manage' AND is_sensitive AND is_staff_assignable")).rows[0].n === 1, 'school_location.manage is sensitive and staff-assignable');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER' AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp
    WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code='school_location.manage')`)).rows[0].n === 0, 'every system OWNER role holds it');

  // 1. Jurisdiction rules: the most specific rule wins; unknown places are not reviewed; every profile is a lawyer-review draft.
  for (const [country, region, city, expected] of [
    ['US', 'IL', 'Chicago', 'US_IL_BIPA'], ['US', 'IL', 'Springfield', 'US_IL_BIPA'], ['US', 'TX', 'Austin', 'US_TX_CUBI'], ['US', 'WA', 'Seattle', 'US_WA_BIOMETRIC'],
    ['US', 'CA', 'Los Angeles', 'US_CA_CCPA'], ['US', 'CO', 'Denver', 'US_CO_CPA'], ['US', 'NY', 'Brooklyn', 'US_NYC'], ['US', 'NY', 'New York', 'US_NYC'],
    ['US', 'NY', 'Staten  Island', 'US_NYC'], ['US', 'NY', 'Buffalo', 'US_GENERAL'], ['US', 'OR', 'Portland', 'US_PORTLAND_BAN'], ['US', 'OR', 'PORTLAND.', 'US_PORTLAND_BAN'],
    ['US', 'ME', 'Portland', 'US_GENERAL'], ['US', 'OR', 'Salem', 'US_GENERAL'], ['US', 'FL', 'Miami', 'US_GENERAL'], ['DE', null, 'Berlin', 'EU_GDPR'],
    ['NO', null, 'Oslo', 'EU_GDPR'], ['GB', null, 'London', 'UK_GDPR'], ['KR', null, 'Seoul', 'KR_PIPA'], ['KR', '11', 'Seoul', 'KR_PIPA'],
    ['CA', 'QC', 'Montreal', 'NOT_REVIEWED'], ['CA', 'ON', 'Toronto', 'NOT_REVIEWED'], ['JP', null, 'Tokyo', 'NOT_REVIEWED'], ['CH', null, 'Zurich', 'NOT_REVIEWED']]) {
    ok(await profileFor(country, region, city) === expected, `${country}/${region}/${city} -> ${expected}`);
  }
  const profiles = (await sql('SELECT code,status,review_status,cardinality(laws) n FROM hon.biometric_jurisdiction_profiles ORDER BY code')).rows;
  ok(profiles.length === 12 && profiles.every((p) => p.review_status === 'TEST_ONLY_DRAFT'), 'twelve profiles, all lawyer-review drafts');
  ok(profiles.find((p) => p.code === 'US_PORTLAND_BAN').status === 'BLOCKED' && profiles.find((p) => p.code === 'NOT_REVIEWED').status === 'NOT_REVIEWED'
    && profiles.filter((p) => p.status === 'AVAILABLE_WITH_CONSENT').every((p) => p.n > 0), 'Portland blocked, unreviewed unavailable, every available profile names its laws');

  // 2. Read: no address yet -> LOCATION_REQUIRED; everyone else refused.
  const empty = (await success(() => read(OWN), 'owner read')).data;
  ok(empty.location === null && empty.faceCheckInNotice.status === 'LOCATION_REQUIRED' && empty.faceCheckInNotice.profile === null, `nothing set yet ${JSON.stringify(empty)}`);
  for (const actor of [NONE, MIXED]) await refused(() => read(actor), 403, undefined, `read refused for ${actor.subject.split('-').pop()}`);
  await refused(() => read(OWN_B, { school: ids.schoolA }), 403, undefined, 'school-B manager at the school-A route');
  await refused(() => read(OTHER_ORG, { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'other-organization owner at the school-A route');
  await refused(() => read(OWN, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key');
  await refused(() => read(OWN, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'read with a source header');
  await refused(() => read(OWN, { query: '?v=1' }), 400, 'VALIDATION_FAILED', 'read with a query');
  await refused(() => read(OWN, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site read');

  // 3. Save refusals before anything is written.
  for (const actor of [NONE, MIXED]) await refused(() => save(actor, body(loc(), 0)), 403, undefined, `save refused for ${actor.subject.split('-').pop()}`);
  await refused(() => save(OWN, body(loc(), 0), { command: 'school_branding.save' }), 403, 'HUMAN_UI_REQUIRED', 'save under another command header');
  await refused(() => save(OWN, body(loc(), 0), { key: '' }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'save without a key');
  for (const [label, value] of [
    ['US without a state', loc({ region: null })], ['unknown US state', loc({ region: 'ZZ' })], ['Canada with a US state', loc({ country: 'CA', region: 'IL' })],
    ['lower-case country', loc({ country: 'us' })], ['three-letter country', loc({ country: 'USA' })], ['empty city', loc({ city: '' })],
    ['padded city', loc({ city: ' Chicago' })], ['html city', loc({ city: '<b>Chicago</b>' })], ['long city', loc({ city: 'x'.repeat(101) })],
    ['multi-line street', loc({ addressLine1: 'a\nb' })], ['second line without first', loc({ addressLine1: null, addressLine2: 'Suite 2' })],
    ['long postal code', loc({ postalCode: 'x'.repeat(21) })], ['number city', loc({ city: 1 })], ['extra key', { ...loc(), street: '1 Main' }],
    ['missing key', (({ city, ...rest }) => rest)(loc())]]) {
    await refused(() => save(OWN, body(value, 0)), 400, 'VALIDATION_FAILED', label);
  }
  for (const [label, version] of [['negative version', -1], ['fractional version', 0.5], ['string version', '0']]) await refused(() => save(OWN, body(loc(), version)), 400, 'VALIDATION_FAILED', label);
  await refused(() => save(OWN, { ...body(loc(), 0), notice: 'x' }), 400, undefined, 'an extra top-level field (the global pipe refuses it)');
  await refused(() => save(OWN, body(loc(), 3)), 409, 'VERSION_CONFLICT', 'a first save must expect version 0');
  ok((await sql('SELECT count(*)::int n FROM hon.school_locations WHERE organization_id=$1', [ids.organization])).rows[0].n === 0, 'no refusal wrote a location');

  // 4. Create (Illinois), replay, key reuse, move cities (notice follows the address).
  const key1 = randomUUID();
  const created = await success(() => save(OWN, body(loc(), 0), { key: key1 }), 'create');
  const first = created.data;
  ok(first.location.version === 1 && first.location.city === 'Chicago' && first.location.region === 'IL' && /Z$/.test(first.location.updatedAt) && created.meta.replayed === false, 'created at version 1');
  ok(first.faceCheckInNotice.profile === 'US_IL_BIPA' && first.faceCheckInNotice.status === 'AVAILABLE_WITH_CONSENT'
    && first.faceCheckInNotice.addOns.includes('WRITTEN_RELEASE') && first.faceCheckInNotice.laws[0].includes('740 ILCS 14'), 'Illinois notice names BIPA and the written release');
  const replay = await success(() => save(OWN, body(loc(), 0), { key: key1 }), 'replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(created.data), 'exact replay returns the first receipt');
  await refused(() => save(OWN, body(loc({ city: 'Evanston' }), 0), { key: key1 }), 409, 'IDEMPOTENCY_KEY_REUSED', 'the same key with another body');
  await refused(() => save(OWN, body(loc(), 0)), 409, 'VERSION_CONFLICT', 'a second create');
  let version = 1;
  for (const [patch, profile, status] of [
    [{ region: 'OR', city: 'Portland', postalCode: '97201' }, 'US_PORTLAND_BAN', 'BLOCKED'],
    [{ region: 'NY', city: 'Brooklyn', postalCode: '11201' }, 'US_NYC', 'AVAILABLE_WITH_CONSENT'],
    [{ country: 'JP', region: null, city: 'Tokyo', postalCode: null }, 'NOT_REVIEWED', 'NOT_REVIEWED'],
    [{ country: 'KR', region: null, city: '서울', postalCode: '04524', addressLine1: '세종대로 110' }, 'KR_PIPA', 'AVAILABLE_WITH_CONSENT'],
    [{ country: 'DE', region: null, city: 'Berlin', postalCode: '10115', addressLine1: null }, 'EU_GDPR', 'AVAILABLE_WITH_CONSENT']]) {
    const moved = (await success(() => save(OWN, body(loc(patch), version)), `move to ${profile}`)).data;
    version += 1;
    ok(moved.location.version === version && moved.faceCheckInNotice.profile === profile && moved.faceCheckInNotice.status === status, `${profile}: ${status} at version ${version}`);
  }
  ok((await success(() => read(OWN), 'read after moves')).data.faceCheckInNotice.addOns.includes('IMPACT_ASSESSMENT'), 'GDPR notice asks for an impact assessment');
  await refused(() => save(OWN, body(loc(), 1)), 409, 'VERSION_CONFLICT', 'stale version');
  ok((await success(() => read(OWN_B), 'school-B read')).data.location === null, 'school B sees none of school A');

  // 5. Live authority loss: revoked grant or suspended school refuse; paid access is not required.
  await success(() => read(LOSER), 'loser read before');
  for (const [label, take, restore] of [
    ['grant revoked', 'UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', 'UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1'],
    ['school suspended', "UPDATE hon.schools SET status='SUSPENDED' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.schools SET status='ACTIVE' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)"]]) {
    await sql(take, [LOSER.grants[0]]);
    await refused(() => read(LOSER), 403, undefined, `${label}: read`);
    await refused(() => save(LOSER, body(loc(), version)), 403, undefined, `${label}: save`);
    await sql(restore, [LOSER.grants[0]]);
  }
  ok((await success(() => save(LOSER, body(loc(), version)), 'loser save after restore')).data.location.version === version + 1, 'authority restored (school still has no paid access)');
  version += 1;

  // 6. History, audit and inert outbox for every settings save.
  const history = (await sql('SELECT version, profile_code, source FROM hon.school_location_versions WHERE school_id=$1 ORDER BY version', [ids.schoolA])).rows;
  ok(history.map((h) => h.version).join() === '1,2,3,4,5,6,7' && history.every((h) => h.source === 'SETTINGS') && history[1].profile_code === 'US_PORTLAND_BAN', `history ${history.map((h) => h.profile_code)}`);
  const audit = (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND entity_type='SCHOOL_LOCATION' AND action_code='school_location.save'", [ids.organization])).rows[0].n;
  const outbox = (await sql("SELECT count(*)::int n, bool_and(payload ? 'profile' AND NOT payload ? 'city' AND NOT payload ? 'addressLine1') shape FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type='SCHOOL_LOCATION' AND status='PENDING'", [ids.organization])).rows[0];
  ok(audit === 7 && outbox.n === 7 && outbox.shape, `one audit and one pending outbox event (no address in the event) per save (${audit}/${outbox.n})`);

  // 7. Guards, whoever writes (inside one rolled-back transaction).
  await sql('BEGIN');
  await rejectsSql(() => sql('UPDATE hon.school_locations SET organization_id=$2, version=version+1 WHERE school_id=$1', [ids.schoolA, ids.otherOrganization]), /IMMUTABLE|foreign key/, 'organization changed');
  await rejectsSql(() => sql("UPDATE hon.school_locations SET city='Elsewhere' WHERE school_id=$1", [ids.schoolA]), /IMMUTABLE/, 'update without a version bump');
  await rejectsSql(() => sql("UPDATE hon.school_locations SET city='Elsewhere', version=version+2 WHERE school_id=$1", [ids.schoolA]), /IMMUTABLE/, 'version jump');
  await rejectsSql(() => sql('DELETE FROM hon.school_locations WHERE school_id=$1', [ids.schoolA]), /IMMUTABLE/, 'delete');
  await rejectsSql(() => sql('TRUNCATE hon.school_locations CASCADE'), /IMMUTABLE/, 'truncate');
  await rejectsSql(() => sql("UPDATE hon.school_locations SET region_code=NULL, version=version+1 WHERE school_id=$1 AND country_code='US'", [ids.schoolA]).then((r) => { if (!r.rowCount) throw new Error('check constraint (not US)'); }), /check constraint/, 'invalid address stored directly');
  await rejectsSql(() => sql("INSERT INTO hon.school_locations(school_id,organization_id,country_code,city,version,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,'JP','Tokyo',2,$3,$3)", [ids.schoolB, ids.organization, OWN.principal]), /IMMUTABLE/, 'new row above version 1');
  await rejectsSql(() => sql("UPDATE hon.school_location_versions SET profile_code='NOT_REVIEWED' WHERE school_id=$1", [ids.schoolA]), /IMMUTABLE/, 'history rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.school_location_versions WHERE school_id=$1', [ids.schoolA]), /IMMUTABLE/, 'history deleted');
  await rejectsSql(() => sql("UPDATE hon.biometric_jurisdiction_profiles SET status='AVAILABLE_WITH_CONSENT' WHERE code='US_PORTLAND_BAN'"), /IMMUTABLE/, 'a profile edited in place');
  await rejectsSql(() => sql("DELETE FROM hon.biometric_jurisdiction_rules WHERE locality='portland'"), /IMMUTABLE/, 'a rule deleted');
  await rejectsSql(() => sql("INSERT INTO hon.biometric_jurisdiction_profiles VALUES('US_XX','AVAILABLE_WITH_CONSENT',ARRAY['x'],ARRAY[]::text[],'LAWYER_APPROVED',1)"), /check constraint/, 'a lawyer-approved profile is not insertable yet');
  await sql('ROLLBACK');

  // 8. Sign-up with the address (the 0241 program opened to TEST_MODE by the owner connection only, then closed again).
  const terms = (await sql('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1')).rows[0].id;
  const signupSubject = `oidc:location-${ids.organization}-signup`, signupEmail = `signup-${ids.organization}@example.test`;
  const form = (patch = {}) => ({ ownerName: 'Location Owner', schoolName: 'Location Signup Dojo', legalName: 'Location Signup LLC', timezone: LA,
    location: loc({ region: 'TX', city: 'Austin', postalCode: '73301' }), termsVersionId: terms, confirmation: 'CREATE_HON_OS_SCHOOL_ACCOUNT', ...patch });
  const register = (input, key) => runtime.query('SELECT hon.register_hon_os_school_with_location($1,$2,$3::jsonb,$4::uuid) data', [signupSubject, signupEmail, JSON.stringify(input), key]);
  const program = (await sql('SELECT status FROM hon.hon_os_signup_program')).rows[0].status;
  await sql("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp()");
  let signupOrg;
  try {
    for (const bad of [(({ location, ...rest }) => rest)(form()), form({ location: null }), form({ location: loc({ region: null }) }), form({ location: { ...loc(), extra: 1 } })]) {
      await assert.rejects(register(bad, randomUUID()), (e) => e.code === '22023'); checks += 1;
    }
    ok((await sql('SELECT count(*)::int n FROM hon.hon_os_school_registrations WHERE subject=$1', [signupSubject])).rows[0].n === 0, 'an address refusal creates no account');
    const key = randomUUID();
    const signed = (await register(form(), key)).rows[0].data;
    signupOrg = signed.registration.organizationId;
    ok(signed.location.city === 'Austin' && signed.location.version === 1 && signed.faceCheckInNotice.profile === 'US_TX_CUBI', 'sign-up records the address and returns the Texas notice');
    ok(JSON.stringify((await register(form(), key)).rows[0].data) === JSON.stringify(signed), 'exact sign-up replay returns the same answer');
    await assert.rejects(register(form({ location: loc({ region: 'IL', city: 'Chicago' }) }), key), /SIGNUP_KEY_REUSED/); checks += 1;
    const v = (await sql("SELECT source, profile_code, actor_principal_id=(SELECT owner_principal_id FROM hon.hon_os_school_registrations WHERE subject=$2) own FROM hon.school_location_versions WHERE school_id=$1", [signed.registration.schoolId, signupSubject])).rows;
    ok(v.length === 1 && v[0].source === 'SIGNUP' && v[0].profile_code === 'US_TX_CUBI' && v[0].own, 'one SIGNUP version by the new owner');
    ok((await sql("SELECT (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1)+(SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1) n", [signupOrg])).rows[0].n === '0', 'sign-up keeps its shape: no audit or outbox event');
  } finally {
    await sql('UPDATE hon.hon_os_signup_program SET status=$1,recorded_at=clock_timestamp()', [program]);
    if (signupOrg) {
      await sql('BEGIN');
      for (const t of (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r'`)).rows.map((r) => r.relname)) {
        await sql('SAVEPOINT s'); try { await sql(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`); await sql(`DELETE FROM hon.${t} WHERE organization_id=$1`, [signupOrg]); await sql(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`); await sql('RELEASE SAVEPOINT s'); } catch { await sql('ROLLBACK TO SAVEPOINT s'); }
      }
      await sql('COMMIT');
    }
  }

  // 9. Runtime ACL: three definer entry points only; helpers and tables private.
  for (const fn of ['read_school_location(text)', 'save_school_location(text,jsonb,text,uuid,uuid)', 'register_hon_os_school_with_location(text,text,jsonb,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['guard_biometric_jurisdiction_data()', 'school_location_region_ok(text,text)', 'school_location_text_ok(jsonb,integer,boolean)', 'school_location_input_ok(jsonb)',
    'guard_school_location()', 'biometric_locality(text)', 'biometric_profile_for(text,text,text)', 'biometric_notice_json(text)', 'school_location_json(hon.school_locations)',
    'school_location_view(hon.school_locations)', 'require_school_location_actor(text)', 'school_location_write(uuid,uuid,uuid,jsonb,integer,text,uuid,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  for (const table of ['school_locations', 'school_location_versions', 'biometric_jurisdiction_profiles', 'biometric_jurisdiction_rules']) {
    const t = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(t.forced && !t.runtime, `${table}: forced RLS, no runtime privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  await assert.rejects(runtime.query("SELECT hon.read_school_location('x')"), /SCHOOL_LOCATION_FORBIDDEN/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- School location exact verification (0392)', end = '-- End school location exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 10. Information only: no face data, payment, invoice or message.
  ok((await sql('SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) n',
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no payment attempt or invoice was created');

  console.log(`PASS: school location and face check-in notice (0392): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
