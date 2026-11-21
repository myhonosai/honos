/**
 * Profile details on the contact card's Edit profile pop-up (0625) over signed HTTP (HON session cookie -> HonIdentityGuard + the
 * school-person-record human guard + HonExceptionFilter -> controller -> protected definer functions on the restricted runtime role
 * with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names and example.test addresses only; nothing is sent.
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
const { HttpAdapterHost } = apiRequire('@nestjs/core');
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const { PERSON_RECORD_HUMAN_COMMAND } = await import(pathToFileURL(apiRequire.resolve('@hon/contracts')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonExceptionFilter } = await load('observability/http-telemetry.js');
const { SchoolPersonRecordController, SchoolPersonRecordHumanGuard } = await load('people/school-person-record.controller.js');
const { SchoolPersonRecordService } = await load('people/school-person-record.service.js');

const admin = new pg.Client(targets.owner); await admin.connect(); await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime); await runtime.connect(); await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);
const session = { mode: 'OIDC', audience: 'hon-person-profile-details', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0, app, origin;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({ controllers: [SchoolPersonRecordController],
    providers: [SchoolPersonRecordHumanGuard, HonIdentityGuard, HonIdentityService, SchoolPersonRecordService, { provide: RuntimeDatabaseService, useValue: database }] }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1');
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1'); origin = `http://127.0.0.1:${app.getHttpServer().address().port}`; process.env.HON_PUBLIC_ORIGIN = origin;
}
function call(actor, method, path, { body, key = randomUUID(), headers = {} } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const sent = { Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`, Origin: origin, 'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Hon-Human-Command': PERSON_RECORD_HUMAN_COMMAND, ...(key ? { 'Idempotency-Key': key } : {}) } : {}), ...headers };
  return new Promise((done, fail) => {
    const request = http.request(new URL(`${origin}/v1/${path}`), { method, headers: sent }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (c) => { text += c; });
      response.on('end', () => { try { done({ status: response.statusCode, headers: response.headers, body: JSON.parse(text || '{}') }); } catch (e) { fail(e); } });
    });
    request.on('error', fail); if (payload !== undefined) request.write(payload); request.end();
  });
}
const read = (actor, personId, school = actor.school) => call(actor, 'GET', `school/schools/${school}/people/${personId}/details`);
const save = (actor, body, key) => call(actor, 'POST', 'school/people/details', { body, key });
async function success(run, label) {
  const { status, body, headers } = await run();
  assert.equal(status, 200, `${label}: ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  return body.data;
}
const tables = ['person_profile_details', 'audit_events', 'outbox_events', 'idempotency_records', 'people', 'communication_consents'];
const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await sql(`SELECT count(*)::int n FROM hon.${t} WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]])).rows[0].n])));
async function refused(run, status, code, label) {
  const before = await counts();
  const r = await run();
  assert.equal(r.status, status, `${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
  if (code) assert.equal(r.body.code, code, `${label}: ${JSON.stringify(r.body)}`);
  ok(!('data' in r.body) && !/SQLSTATE|SELECT |hon\.|external_subject/.test(JSON.stringify(r.body)), `${label}: plain refusal, no data`);
  assert.deepEqual(await counts(), before, `${label}: nothing written`); checks += 1;
  return r;
}

async function cleanup() {
  const tablesWithOrg = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    for (let pass = 0; pass < 10; pass += 1) {
      let failed = 0;
      for (const table of tablesWithOrg) {
        await sql('SAVEPOINT c');
        try { await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`); await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`); await sql('RELEASE SAVEPOINT c'); }
        catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT c'); }
      }
      if (!failed) break;
    }
    const like = `person-details-${ids.organization}-%`;
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [like]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [like]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [like]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}
async function role(org, permissions) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, `STAFF_${id.slice(0, 8)}`]);
  for (const p of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, p]);
  return id;
}
async function staff(label, permissions, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `person-details-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Details Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Details Staff')", [principal, user]);
  const grant = randomUUID();
  await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')",
    [grant, org, school, principal, await role(org, permissions)]);
  return { subject, principal, grant, org, school };
}
async function person(given, { school = ids.schoolA, org = ids.organization, email = null, phone = null } = {}) {
  const id = randomUUID();
  await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, org, school, given, 'Details', email, phone]);
  return id;
}
const body = (personId, expectedVersion, patch = {}) => ({ schoolId: ids.schoolA, personId, expectedVersion, gender: 'FEMALE', guardianName: 'Gale Details',
  notes: 'Prefers evening calls.\nAllergic to peanuts.', primaryPhoneLabel: 'MOBILE', primaryEmailLabel: 'PERSONAL',
  otherPhones: [{ phoneE164: '+15555550111', label: 'HOME' }, { phoneE164: '+15555550112', label: 'WORK' }],
  otherEmails: [{ email: 'Second@Example.test', label: 'WORK' }], ...patch });

let EDITOR, READER, NONE, OTHER_SCHOOL, OTHER_ORG;
const people = {};
try {
  await cleanup();
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Details Org','Details Org'),($2,'Details Other Org','Details Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']])
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'UTC')", [school, org, `Details ${slug}`, `details-${slug}-${school.slice(0, 8)}`]);
  EDITOR = await staff('editor', ['people.read', 'people.update']);
  READER = await staff('reader', ['people.read']);
  NONE = await staff('none', ['people.update', 'billing.membership.read']);
  OTHER_SCHOOL = await staff('other-school', ['people.read', 'people.update'], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', ['people.read', 'people.update'], { org: ids.otherOrganization, school: ids.otherSchool });
  people.ana = await person('Ana', { email: 'ana@example.test', phone: '+15555550100' });
  people.ben = await person('Ben');
  people.schoolB = await person('Bea', { school: ids.schoolB });
  await sql("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,'EMAIL','OPTED_IN','STAFF',clock_timestamp(),$4)", [ids.organization, ids.schoolA, people.ana, EDITOR.principal]);
  await startApp();

  // 1. Runtime ACL and the 011 exact verification section.
  const acl = (await sql(`SELECT p.oid::regprocedure::text sig, has_function_privilege($1,p.oid,'EXECUTE') can FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace
    AND p.proname IN ('read_school_person_details','update_school_person_details','person_profile_contact_list','person_profile_details_json') ORDER BY 1`, [CRM_CLOSE_RUNTIME_ROLE])).rows;
  ok(acl.length === 4 && acl.filter((x) => x.can).map((x) => x.sig).join() === 'hon.read_school_person_details(text,uuid,uuid),hon.update_school_person_details(text,jsonb,uuid)', `runtime runs only the two entry points: ${JSON.stringify(acl)}`);
  ok(!(await sql("SELECT has_table_privilege($1,'hon.person_profile_details','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') p", [CRM_CLOSE_RUNTIME_ROLE])).rows[0].p, 'the runtime has no table privilege');
  await runtime.query('BEGIN'); await assert.rejects(runtime.query('SELECT count(*) FROM hon.person_profile_details'), /permission denied/); await runtime.query('ROLLBACK'); checks += 1;
  await runtime.query('BEGIN'); await assert.rejects(runtime.query("SELECT hon.person_profile_contact_list('[]'::jsonb,'PHONE',NULL)"), /permission denied/); await runtime.query('ROLLBACK'); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const section = verify.split('-- Profile details exact verification (0625)')[1]?.split('-- End profile details exact verification.')[0];
    ok(section, '011 section present');
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 2. Read before anything was saved: version 0, empty lists, canEdit from live authority.
  const fresh = await success(() => read(EDITOR, people.ana), 'first read');
  ok(JSON.stringify(fresh) === JSON.stringify({ personId: people.ana, version: 0, gender: null, guardianName: null, notes: null, primaryPhoneLabel: null, primaryEmailLabel: null,
    otherPhones: [], otherEmails: [], canEdit: true }), `fresh read ${JSON.stringify(fresh)}`);
  ok((await success(() => read(READER, people.ana), 'reader read')).canEdit === false, 'a reader cannot edit');

  // 3. Refusals: no people.read, other school, other organization, a reader saving; nothing is written.
  await refused(() => read(NONE, people.ana), 403, 'PERSON_FORBIDDEN', 'no people.read');
  await refused(() => read(OTHER_SCHOOL, people.ana), 404, 'PERSON_UNAVAILABLE', 'another school of the org');
  await refused(() => read(EDITOR, people.schoolB), 404, 'PERSON_UNAVAILABLE', 'a person of another school');
  await refused(() => read(OTHER_ORG, people.ana, ids.schoolA), 403, 'PERSON_FORBIDDEN', 'another organization');
  await refused(() => save(READER, body(people.ana, 0)), 403, 'PERSON_FORBIDDEN', 'a reader saving');
  await refused(() => save(NONE, body(people.ana, 0)), 403, 'PERSON_FORBIDDEN', 'update without read');
  await refused(() => save(OTHER_SCHOOL, { ...body(people.ana, 0), schoolId: ids.schoolB }), 404, 'PERSON_UNAVAILABLE', 'saving a person of another school');

  // 4. Closed input: every bad shape is refused before anything is written.
  const bad = [
    { gender: 'OTHER' }, { gender: 'male' }, { primaryPhoneLabel: 'CELL' }, { primaryEmailLabel: 'HOME' }, { guardianName: 'Gale\u0007' }, { guardianName: 'x'.repeat(201) },
    { notes: 'x'.repeat(2001) }, { notes: 'bell\u0007' }, { otherPhones: [{ phoneE164: '5555550111', label: 'HOME' }] }, { otherPhones: [{ phoneE164: '+15555550111', label: 'CELL' }] },
    { otherPhones: [{ phoneE164: '+15555550111', label: 'HOME', extra: 1 }] }, { otherPhones: [{ phoneE164: '+15555550111', label: 'HOME' }, { phoneE164: '+15555550111', label: 'WORK' }] },
    { otherPhones: Array.from({ length: 6 }, (_, i) => ({ phoneE164: `+1555555012${i}`, label: 'OTHER' })) }, { otherPhones: [{ phoneE164: '+15555550100', label: 'HOME' }] },
    { otherEmails: [{ email: 'ANA@example.test', label: 'WORK' }] }, { otherEmails: [{ email: 'not-an-email', label: 'WORK' }] }, { otherEmails: [{ email: 'a@example.test', label: 'MOBILE' }] },
    { otherEmails: 'a@example.test' }, { expectedVersion: -1 }, { expectedVersion: 1.5 }, { extra: true }];
  for (const patch of bad) await refused(() => save(EDITOR, body(people.ana, 0, patch)), 400, 'PERSON_INPUT_INVALID', `bad input ${JSON.stringify(patch).slice(0, 80)}`);
  { const b = body(people.ana, 0); delete b.notes; await refused(() => save(EDITOR, b), 400, 'PERSON_INPUT_INVALID', 'missing key'); }
  // The primary-address rule is the server's own: the database refuses even a body the API shape accepts.
  await runtime.query('BEGIN');
  await assert.rejects(runtime.query('SELECT hon.update_school_person_details($1,$2::jsonb,$3::uuid)', [EDITOR.subject, JSON.stringify(body(people.ana, 0, { otherEmails: [{ email: 'ana@example.test', label: 'WORK' }] })), randomUUID()]), /PERSON_INPUT_INVALID/);
  await runtime.query('ROLLBACK'); checks += 1;

  // 5. First save inserts version 1, normalized; audit has the values, the outbox only ids and field names.
  const key = randomUUID(), first = body(people.ana, 0);
  const saved = await success(() => save(EDITOR, first, key), 'first save');
  ok(saved.details.version === 1 && saved.details.otherEmails[0].email === 'second@example.test' && saved.details.notes === 'Prefers evening calls.\nAllergic to peanuts.', `saved ${JSON.stringify(saved)}`);
  ok(JSON.stringify(saved.changedFields) === JSON.stringify(['gender', 'guardianName', 'notes', 'primaryPhoneLabel', 'primaryEmailLabel', 'otherPhones', 'otherEmails']), 'every field changed');
  const audit = (await sql("SELECT action_code,source,prior_state,next_state FROM hon.audit_events WHERE organization_id=$1 AND entity_id=$2 AND action_code='people.details.update'", [ids.organization, people.ana])).rows;
  ok(audit.length === 1 && audit[0].source === 'HUMAN_UI' && audit[0].prior_state === null && audit[0].next_state.gender === 'FEMALE', 'one audit row');
  const outbox = (await sql("SELECT payload FROM hon.outbox_events WHERE organization_id=$1 AND event_type='people.person.details_updated'", [ids.organization])).rows;
  ok(outbox.length === 1 && JSON.stringify(Object.keys(outbox[0].payload).sort()) === '["changedFields","personId","version"]' && !/example\.test|5555|Gale|peanut/.test(JSON.stringify(outbox[0].payload)), 'outbox carries no value');

  // 6. Exact replay returns the same answer and writes nothing; the same key with another body conflicts.
  const before = await counts();
  const replay = await success(() => save(EDITOR, first, key), 'replay');
  ok(JSON.stringify(replay) === JSON.stringify(saved), 'replay is identical'); assert.deepEqual(await counts(), before); checks += 1;
  await refused(() => save(EDITOR, { ...first, notes: 'Different' }, key), 409, 'PERSON_IDEMPOTENCY_CONFLICT', 'same key, other body');

  // 7. Version and unchanged rules; a second save updates in place.
  await refused(() => save(EDITOR, body(people.ana, 0, { gender: 'MALE' })), 409, 'PERSON_VERSION_CONFLICT', 'stale version');
  await refused(() => save(EDITOR, body(people.ana, 1)), 400, 'PERSON_UNCHANGED', 'unchanged');
  const second = await success(() => save(EDITOR, body(people.ana, 1, { gender: null, guardianName: '  ', notes: null, otherPhones: [], otherEmails: [] })), 'clear');
  ok(second.details.version === 2 && second.details.gender === null && second.details.guardianName === null && second.details.otherPhones.length === 0, 'cleared');
  ok(JSON.stringify(second.changedFields) === JSON.stringify(['gender', 'guardianName', 'notes', 'otherPhones', 'otherEmails']), `changed ${second.changedFields}`);
  ok((await sql('SELECT count(*)::int n FROM hon.person_profile_details WHERE person_id=$1', [people.ana])).rows[0].n === 1, 'one row per person');

  // 8. Saving details never touches the person, its primary contact or consent.
  const personRow = (await sql('SELECT email::text,phone_e164,version FROM hon.people WHERE id=$1', [people.ana])).rows[0];
  ok(personRow.email === 'ana@example.test' && personRow.phone_e164 === '+15555550100' && personRow.version === 1, 'person row unchanged');
  ok((await sql("SELECT status::text s FROM hon.communication_consents WHERE person_id=$1 AND channel='EMAIL'", [people.ana])).rows[0].s === 'OPTED_IN', 'consent unchanged');

  // 9. A person with no primary address may keep other addresses; another school's editor still cannot see them.
  const ben = await success(() => save(EDITOR, body(people.ben, 0, { otherEmails: [{ email: 'ana@example.test', label: 'OTHER' }] })), 'ben');
  ok(ben.details.otherEmails[0].email === 'ana@example.test', 'only the person’s own primary address is excluded');
  await refused(() => read(OTHER_SCHOOL, people.ben, ids.schoolB), 404, 'PERSON_UNAVAILABLE', 'other school cannot read');

  // 10. Paid access ending, or the grant being revoked, refuses reads and saves.
  await sql('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp() WHERE id=$1', [EDITOR.grant]);
  await refused(() => save(EDITOR, body(people.ana, 2, { gender: 'MALE' })), 403, 'PERSON_FORBIDDEN', 'expired grant');
  await sql('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1', [EDITOR.grant]);
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1", [ids.organization]);
  await refused(() => read(EDITOR, people.ana), 403, 'PERSON_FORBIDDEN', 'paid access ended');

  // 11. Table guards: constraint shapes hold even for the owner.
  await sql('BEGIN'); await assert.rejects(sql("UPDATE hon.person_profile_details SET gender='OTHER' WHERE person_id=$1", [people.ana])); await sql('ROLLBACK'); checks += 1;
  await sql('BEGIN'); await assert.rejects(sql(`UPDATE hon.person_profile_details SET other_phones='${JSON.stringify(Array.from({ length: 6 }, () => ({})))}' WHERE person_id=$1`, [people.ana])); await sql('ROLLBACK'); checks += 1;
  console.log(`PASS: person profile details (0625), ${checks} checks.`);
} finally {
  await app?.close();
  await cleanup().catch((error) => console.error('cleanup failed', error.message));
  await runtime.end(); await admin.end();
}
