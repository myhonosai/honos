/**
 * Student and guardian CSV import proof (0226) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI
 * guards + global ValidationPipe + HonExceptionFilter -> controller -> protected definer functions on the restricted
 * runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names only.
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
const { StudentImportController } = await load('migration/student-import.controller.js');
const { StudentImportService } = await load('migration/student-import.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-student-import', secret: randomBytes(32).toString('hex') };
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
    controllers: [StudentImportController],
    providers: [HonIdentityGuard, HonIdentityService, StudentImportService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org, query = '' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/student-imports${path}${query}`);
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
const list = (actor, options = {}) => call(actor, 'GET', '', options);
const detail = (actor, batchId, options = {}) => call(actor, 'GET', `/${batchId}`, options);
const stage = (actor, body, options = {}) => call(actor, 'POST', '', { body, command: 'students.import.stage', ...options });
const decide = (actor, batchId, body, options = {}) => call(actor, 'POST', `/${batchId}/decisions`, { body, command: 'students.import.decide', ...options });
const finalize = (actor, batchId, body, options = {}) => call(actor, 'POST', `/${batchId}/finalize`, { body, command: 'students.import.finalize', ...options });

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
}
async function rejectsSql(run, pattern, label) {
  await sql('SAVEPOINT expected_failure');
  try { await run(); } catch (error) { await sql('ROLLBACK TO SAVEPOINT expected_failure'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK TO SAVEPOINT expected_failure');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0224 proof).
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
    const left = (await sql(`SELECT count(*)::int n FROM hon.people WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left people behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`student-import-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`student-import-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`student-import-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `student-import-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Student Import Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Student Import Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}

let OWN, IMPORTER, NONE, MIXED, OTHER_SCHOOL, OTHER_ORG;
let existingPerson;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Student Import Org','Student Import Org'),($2,'Student Import Other Org','Student Import Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Student Import ${slug}`, `student-import-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  IMPORTER = await staff('importer', [await role(ids.organization, ['students.import'])]);
  NONE = await staff('none', [await role(ids.organization, allPermissions.filter((code) => code !== 'students.import'))]);
  MIXED = await staff('mixed', [await role(ids.organization, ['people.read']), await role(ids.organization, ['students.import'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('school-b', [await role(ids.organization, ['students.import'])], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
  // An existing student at school A, and one with the same contact at school B (must never be suggested at A).
  existingPerson = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'Pre','Existing','existing@example.test')", [existingPerson, ids.organization, ids.schoolA]);
  await sql("INSERT INTO hon.student_profiles(organization_id,school_id,person_id,birth_date) VALUES($1,$2,$3,'2000-03-03')", [ids.organization, ids.schoolA, existingPerson]);
  await sql("INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email) VALUES($1,$2,'Elsewhere','Person','existing@example.test')", [ids.organization, ids.schoolB]);
}

const csvOf = (rows) => rows.map((row) => row.map((cell) => /[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell).join(',')).join('\n') + '\n';
const HEADERS = ['First', 'Last', 'DOB', 'Email', 'Parent First', 'Parent Last', 'Parent Email', 'Parent Phone', 'Family', 'Notes'];
const MAPPING = { First: 'studentGivenName', Last: 'studentFamilyName', DOB: 'birthDate', Email: 'studentEmail', 'Parent First': 'guardianGivenName',
  'Parent Last': 'guardianFamilyName', 'Parent Email': 'guardianEmail', 'Parent Phone': 'guardianMobile', Family: 'familyKey', Notes: 'ignore' };
const ROWS = [
  ['Ava', 'Stone', '2016-04-02', '', 'Mia', 'Stone', 'Mia@Example.test', '+1 555 123 4567', 'STONE', 'private note'], // 1 valid minor with guardian
  ['Leo', 'Stone', '2018-09-10', '', '', '', '', '', 'stone', ''], //                                                   2 valid: guardian from family key
  ['Sam', 'Ortiz', '1990-01-01', 'Sam@Example.test', '', '', '', '', '', ''], //                                      3 valid adult
  ['Kid', 'Alone', '2019-01-01', '', '', '', '', '', '', ''], //                                                      4 minor without guardian
  ['Unknown', 'Age', '', '', '', '', '', '', '', ''], //                                                              5 no guardian and no birth date
  ['Bad', 'Email', '1985-02-02', 'not-an-email', '', '', '', '', '', ''], //                                          6 bad email
  ['=HYPERLINK("x")', 'Formula', '1985-02-02', '', '', '', '', '', '', ''], //                                        7 formula injection
  ['Ana', 'Diaz', '2015-05-05', '', 'Pat', 'Diaz', '', '', 'DIAZ', ''], //                                            8 family key mismatch
  ['Ben', 'Diaz', '2014-01-01', '', 'Lee', 'Diaz', '', '', 'DIAZ', ''], //                                            9 family key mismatch
  ['Ava', 'Stone', '2016-04-02', '', 'Mia', 'Stone', 'mia@example.test', '+15551234567', 'STONE', ''], //             10 repeat of row 1 (valid)
  ['Zed', 'Future', '2099-01-01', '', 'Kim', 'Future', '', '', '', ''], //                                            11 birth date in the future
  ['Pre', 'Existing', '2000-03-03', 'existing@example.test', '', '', '', '', '', ''], //                              12 valid; existing person suggestions
  ['Nia', 'Park', '2017-07-07', '', 'Jo', '', '', '', '', ''], //                                                     13 guardian name incomplete
  ['Ola', 'Moe', '2001-02-30', '', '', '', '', '', '', ''], //                                                        14 impossible date
];
const csv = csvOf([HEADERS, ...ROWS]);
const people = async (school = ids.schoolA) => (await sql('SELECT count(*)::int n FROM hon.people WHERE school_id=$1', [school])).rows[0].n;
const sideEffects = async () => (await sql(`SELECT
  (SELECT count(*)::int FROM hon.memberships WHERE organization_id=$1) memberships,
  (SELECT count(*)::int FROM hon.billing_accounts WHERE organization_id=$1) accounts,
  (SELECT count(*)::int FROM hon.invoices WHERE organization_id=$1) invoices,
  (SELECT count(*)::int FROM hon.payment_attempts WHERE organization_id=$1) attempts,
  (SELECT count(*)::int FROM hon.membership_payment_schedules WHERE organization_id=$1) schedules,
  (SELECT count(*)::int FROM hon.student_curriculum_enrollments WHERE organization_id=$1) enrollments,
  (SELECT count(*)::int FROM hon.class_bookings WHERE organization_id=$1) bookings,
  (SELECT count(*)::int FROM hon.family_access_grants WHERE organization_id=$1) family_access,
  (SELECT count(*)::int FROM hon.crm_leads WHERE organization_id=$1) leads`, [ids.organization])).rows[0];

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Permission and the empty list.
  const permission = (await sql("SELECT is_sensitive, is_staff_assignable FROM hon.permissions WHERE code='students.import'")).rows[0];
  ok(permission?.is_sensitive === true && permission?.is_staff_assignable === true, 'students.import exists, sensitive and staff-assignable');
  ok((await sql("SELECT count(*)::int n FROM hon.roles r WHERE r.code='OWNER' AND r.is_system_role AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=r.id AND rp.permission_code='students.import')")).rows[0].n === 0,
    'every system OWNER role holds students.import');
  const empty = await success(() => list(IMPORTER), 'empty list');
  ok(Array.isArray(empty.data.batches) && empty.data.batches.length === 0, 'no batches yet');
  ok(empty.data.maxRows === 1000 && empty.data.maxBytes === 262144 && empty.data.maxColumns === 24 && empty.data.fields.length === 10, 'limits and fields are published');
  const before = await sideEffects();
  const peopleBefore = await people();

  // 2. API-side closed input: nothing reaches the database.
  const bad = [
    [{ csv }, 'mapping missing'],
    [{ csv, mapping: MAPPING, extra: 1 }, 'extra key'],
    [{ csv: '', mapping: MAPPING }, 'empty csv'],
    [{ csv: 'First,Last\n"Ava,Stone\n', mapping: { First: 'studentGivenName', Last: 'studentFamilyName' } }, 'broken quoting'],
    [{ csv: 'First,Last\nAva\n', mapping: { First: 'studentGivenName', Last: 'studentFamilyName' } }, 'uneven columns'],
    [{ csv: 'First,First\nAva,Stone\n', mapping: { First: 'studentGivenName' } }, 'duplicate header'],
    [{ csv: '=cmd,Last\nAva,Stone\n', mapping: { '=cmd': 'studentGivenName', Last: 'studentFamilyName' } }, 'formula header'],
    [{ csv: 'First,Last\n', mapping: { First: 'studentGivenName', Last: 'studentFamilyName' } }, 'no data rows'],
    [{ csv: 'First,Email\nAva,a@example.test\n', mapping: { First: 'studentGivenName', Email: 'studentEmail' } }, 'student family name not mapped'],
    [{ csv: 'First,Last,PE\nAva,Stone,p@example.test\n', mapping: { First: 'studentGivenName', Last: 'studentFamilyName', PE: 'guardianEmail' } }, 'guardian email without guardian name'],
    [{ csv: 'First,Last\nAva,Stone\n', mapping: { First: 'studentGivenName', Last: 'studentGivenName' } }, 'field mapped twice'],
    [{ csv: 'First,Last\nAva,Stone\n', mapping: { First: 'studentGivenName', Last: 'password' } }, 'unknown field'],
    [{ csv: 'First,Last\nAva,Stone\n', mapping: { First: 'studentGivenName' } }, 'column left unmapped'],
    [{ csv: `First,Last\n${'Ava,Stone\n'.repeat(1001)}`, mapping: { First: 'studentGivenName', Last: 'studentFamilyName' } }, 'over 1,000 rows'],
    [{ csv: 'First,Last\nA\u0000va,Stone\n', mapping: { First: 'studentGivenName', Last: 'studentFamilyName' } }, 'NUL byte'],
  ];
  for (const [body, label] of bad) await refused(() => stage(IMPORTER, body), 400, 'STUDENT_IMPORT_INVALID', `stage refused: ${label}`);
  await refused(() => stage(IMPORTER, { csv, mapping: MAPPING }, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'stage without a key');
  await refused(() => stage(IMPORTER, { csv, mapping: MAPPING }, { command: 'students.import.finalize' }), 403, 'HUMAN_UI_REQUIRED', 'stage under another command name');
  await refused(() => stage(IMPORTER, { csv, mapping: MAPPING }, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'stage with a delegated source header');
  await refused(() => stage(IMPORTER, { csv, mapping: MAPPING }, { query: '?school=x' }), 400, 'STUDENT_IMPORT_INVALID', 'stage with a query string');
  await refused(() => list(IMPORTER, { headers: { 'Idempotency-Key': 'k' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'list with a key');
  ok((await sql('SELECT count(*)::int n FROM hon.student_import_requests WHERE organization_id=$1', [ids.organization])).rows[0].n === 0, 'refused input reserved no key');

  // 3. Authority: no permission, a family-type role, another school, another organization, paid access.
  for (const [actor, label] of [[NONE, 'every other permission'], [MIXED, 'students.import only through a PARENT_PORTAL role']]) {
    await refused(() => stage(actor, { csv, mapping: MAPPING }), 403, undefined, `stage refused: ${label}`);
    await refused(() => list(actor), 403, undefined, `list refused: ${label}`);
  }
  await refused(() => stage(OTHER_SCHOOL, { csv, mapping: MAPPING }, { school: ids.schoolA }), 403, undefined, 'school-B importer at the school-A route');
  await refused(() => stage(OTHER_ORG, { csv, mapping: MAPPING }, { organization: ids.organization, school: ids.schoolA }), 403, undefined, 'other organization at the school-A route');
  await sql("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.organization]);
  await refused(() => stage(OWN, { csv, mapping: MAPPING }), 403, undefined, 'stage refused while paid access is suspended');
  await sql("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.organization]);
  ok(await people() === peopleBefore, 'refusals created nobody');

  // 4. Stage: every rule is decided in the database.
  const key = randomUUID();
  const staged = (await success(() => stage(IMPORTER, { csv, mapping: MAPPING }, { key }), 'stage')).data;
  ok(staged.status === 'STAGED' && staged.version === 1 && staged.rowCount === 14 && staged.validCount === 5 && staged.undecidedCount === 14 && staged.importedCount === 0, `staged summary ${JSON.stringify(staged)}`);
  ok(staged.checksum === (await sql("SELECT encode(sha256(convert_to($1,'UTF8')),'hex') h", [csv])).rows[0].h, 'checksum is the SHA-256 of the exact CSV text');
  const replay = await success(() => stage(IMPORTER, { csv, mapping: MAPPING }, { key }), 'stage replay');
  ok(replay.meta.replayed === true && replay.data.id === staged.id, 'same key and body replays the same batch');
  await refused(() => stage(IMPORTER, { csv: csv + 'Extra,Row,2010-01-01,,Al,Row,,,,\n', mapping: MAPPING }, { key }), 409, 'IDEMPOTENCY_KEY_REUSED', 'same key, different CSV');
  ok((await sql('SELECT count(*)::int n FROM hon.student_import_batches WHERE organization_id=$1', [ids.organization])).rows[0].n === 1, 'one batch only');
  ok(await people() === peopleBefore, 'staging creates no person');

  const view = (await success(() => detail(IMPORTER, staged.id), 'detail')).data;
  const row = (index) => view.rows.find((r) => r.index === index);
  const errors = (index) => row(index).errors;
  ok(view.headers.length === 10 && view.mapping.Notes === 'ignore', 'headers and mapping are returned');
  ok(row(1).raw[9] === '' && !JSON.stringify(view).includes('private note'), 'ignored columns are never stored');
  ok(row(1).errors.length === 0 && row(1).normalized.guardianEmail === 'mia@example.test' && row(1).normalized.guardianMobile === '+15551234567', 'contacts are normalized');
  ok(row(2).errors.length === 0 && row(2).normalized.guardian?.givenName === 'Mia', 'family key (any case) supplies the guardian');
  ok(row(3).errors.length === 0 && row(3).normalized.guardian === null, 'an adult needs no guardian');
  ok(errors(4).includes('guardian:REQUIRED_FOR_MINOR'), 'a minor without a guardian is refused');
  ok(errors(5).includes('birthDate:REQUIRED_WITHOUT_GUARDIAN'), 'no guardian and no birth date: an adult is never assumed');
  ok(errors(6).includes('studentEmail:INVALID'), 'bad email');
  ok(errors(7).includes('studentGivenName:FORMULA_INJECTION'), 'spreadsheet formula');
  ok(errors(8).includes('familyKey:GUARDIAN_MISMATCH') && errors(9).includes('familyKey:GUARDIAN_MISMATCH'), 'two guardians under one family key');
  ok(errors(10).length === 0, 'a consistent repeat of the guardian is fine');
  ok(errors(11).includes('birthDate:OUT_OF_RANGE'), 'future birth date');
  ok(errors(13).includes('guardian:NAME_REQUIRED'), 'guardian needs both names');
  ok(errors(14).includes('birthDate:USE_YYYY_MM_DD'), 'impossible calendar date');
  ok(row(1).suggestions.some((s) => s.reason === 'SAME_STUDENT_IN_FILE' && s.rowIndex === 10) && row(10).suggestions.some((s) => s.rowIndex === 1), 'in-file repeats are suggested both ways');
  const reasons12 = row(12).suggestions.filter((s) => s.personId === existingPerson).map((s) => s.reason).sort().join(',');
  ok(reasons12 === 'STUDENT_EMAIL,STUDENT_NAME_AND_BIRTH_DATE', `existing student suggested by email and name+birth date (${reasons12})`);
  ok(row(12).suggestions.every((s) => s.personId === undefined || s.personId === existingPerson), 'no suggestion from another school');
  ok(view.rows.every((r) => r.choice === null && r.created === null), 'nothing decided or created');
  await refused(() => detail(OTHER_SCHOOL, staged.id), 404, 'STUDENT_IMPORT_NOT_FOUND', 'school B cannot read a school-A batch');
  await refused(() => detail(OTHER_ORG, staged.id), 404, 'STUDENT_IMPORT_NOT_FOUND', 'another organization cannot read the batch');
  await refused(() => detail(NONE, staged.id), 403, undefined, 'detail needs the import permission');

  // 5. Decide.
  await refused(() => decide(IMPORTER, staged.id, { expectedVersion: 1, decisions: [{ index: 4, choice: 'IMPORT' }] }), 400, 'STUDENT_IMPORT_ROW_NOT_IMPORTABLE', 'a row with problems cannot be imported');
  await refused(() => decide(IMPORTER, staged.id, { expectedVersion: 2, decisions: [{ index: 1, choice: 'IMPORT' }] }), 409, 'VERSION_CONFLICT', 'stale version');
  await refused(() => decide(IMPORTER, staged.id, { expectedVersion: 1, decisions: [{ index: 99, choice: 'IMPORT' }] }), 400, 'STUDENT_IMPORT_ROW_NOT_IMPORTABLE', 'unknown row');
  await refused(() => decide(IMPORTER, staged.id, { expectedVersion: 1, decisions: [{ index: 1, choice: 'MERGE' }] }), 400, 'STUDENT_IMPORT_INVALID', 'unknown choice');
  await refused(() => decide(IMPORTER, staged.id, { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }, { index: 1, choice: 'SKIP' }] }), 400, 'STUDENT_IMPORT_INVALID', 'row decided twice in one call');
  await refused(() => decide(OTHER_SCHOOL, staged.id, { expectedVersion: 1, decisions: [{ index: 1, choice: 'IMPORT' }] }), 404, 'STUDENT_IMPORT_NOT_FOUND', 'school B cannot decide');
  const first = (await success(() => decide(IMPORTER, staged.id, { expectedVersion: 1, decisions: [1, 2, 3, 12].map((index) => ({ index, choice: 'IMPORT' })) }), 'decide imports')).data;
  ok(first.version === 2 && first.importCount === 4 && first.undecidedCount === 10, 'four rows marked to import');
  await refused(() => finalize(IMPORTER, staged.id, { expectedVersion: 2, selectedIndices: [1, 2, 3, 12] }), 409, 'STUDENT_IMPORT_SELECTION_REQUIRED', 'finalize with undecided rows');
  const second = (await success(() => decide(IMPORTER, staged.id, { expectedVersion: 2, decisions: [4, 5, 6, 7, 8, 9, 10, 11, 13, 14].map((index) => ({ index, choice: 'SKIP' })) }), 'decide skips')).data;
  ok(second.version === 3 && second.skipCount === 10 && second.undecidedCount === 0, 'every row decided');

  // 6. Finalize: exactly the chosen rows, on this version.
  await refused(() => finalize(IMPORTER, staged.id, { expectedVersion: 3, selectedIndices: [1, 2, 3] }), 409, 'STUDENT_IMPORT_SELECTION_REQUIRED', 'selection missing a row');
  await refused(() => finalize(IMPORTER, staged.id, { expectedVersion: 3, selectedIndices: [1, 2, 3, 10, 12] }), 409, 'STUDENT_IMPORT_SELECTION_REQUIRED', 'selection with a skipped row');
  await refused(() => finalize(IMPORTER, staged.id, { expectedVersion: 2, selectedIndices: [1, 2, 3, 12] }), 409, 'VERSION_CONFLICT', 'finalize on an old version');
  ok(await people() === peopleBefore, 'refused finalizes created nobody');
  // Live loss while the command waits is the same check as here: the grant ends, the finalize is refused, nothing is written.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=$2 WHERE id=$1', [IMPORTER.grants[0], OWN.principal]);
  await refused(() => finalize(IMPORTER, staged.id, { expectedVersion: 3, selectedIndices: [12, 3, 2, 1] }), 403, undefined, 'finalize after the grant is revoked');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1', [IMPORTER.grants[0]]);
  ok(await people() === peopleBefore, 'the revoked finalize created nobody');
  const fkey = randomUUID();
  const done = (await success(() => finalize(IMPORTER, staged.id, { expectedVersion: 3, selectedIndices: [12, 3, 2, 1] }, { key: fkey }), 'finalize')).data;
  ok(done.status === 'FINALIZED' && done.version === 4 && done.importedCount === 4 && done.finalizedAt, 'finalized with four rows imported');
  const again = await success(() => finalize(IMPORTER, staged.id, { expectedVersion: 3, selectedIndices: [12, 3, 2, 1] }, { key: fkey }), 'finalize replay');
  ok(again.meta.replayed === true && again.data.version === 4, 'finalize replays without writing again');
  await refused(() => decide(IMPORTER, staged.id, { expectedVersion: 4, decisions: [{ index: 4, choice: 'SKIP' }] }), 409, 'VERSION_CONFLICT', 'a finalized batch cannot change');
  await refused(() => finalize(IMPORTER, staged.id, { expectedVersion: 4, selectedIndices: [12, 3, 2, 1] }), 409, 'VERSION_CONFLICT', 'a finalized batch cannot finalize again');

  // 7. What was created: people, families, family links and student profiles only.
  ok(await people() === peopleBefore + 5, 'four students and one guardian');
  const created = (await success(() => detail(IMPORTER, staged.id), 'detail after finalize')).data;
  const c = (index) => created.rows.find((r) => r.index === index).created;
  ok(c(1) && c(2) && c(3) && c(12) && created.rows.filter((r) => r.created).length === 4, 'created ids on exactly the imported rows');
  ok(c(1).familyId === c(2).familyId && c(1).guardianPersonId === c(2).guardianPersonId && c(1).guardianPersonId, 'siblings share one family and one guardian');
  ok(c(3).guardianPersonId === null && c(3).familyId !== c(1).familyId && c(12).familyId !== c(3).familyId, 'others get their own family');
  ok(c(12).studentPersonId !== existingPerson, 'a suggestion is never merged');
  const stone = (await sql(`SELECT f.display_name, array_agg(fm.member_role::text||':'||p.given_name ORDER BY fm.member_role::text, p.given_name) members
    FROM hon.families f JOIN hon.family_members fm ON fm.family_id=f.id JOIN hon.people p ON p.id=fm.person_id WHERE f.id=$1 GROUP BY f.display_name`, [c(1).familyId])).rows[0];
  ok(stone.display_name === 'Stone family' && stone.members.join(',') === 'GUARDIAN:Mia,STUDENT:Ava,STUDENT:Leo', `family links ${JSON.stringify(stone)}`);
  const mia = (await sql('SELECT email::text, phone_e164 FROM hon.people WHERE id=$1', [c(1).guardianPersonId])).rows[0];
  ok(mia.email === 'mia@example.test' && mia.phone_e164 === '+15551234567', 'guardian contact stored normalized');
  const profiles = (await sql('SELECT sp.person_id, sp.primary_family_id, sp.birth_date::text bd FROM hon.student_profiles sp WHERE sp.id = ANY($1::uuid[]) ORDER BY bd', [[c(1).studentProfileId, c(2).studentProfileId, c(3).studentProfileId, c(12).studentProfileId]])).rows;
  ok(profiles.map((p) => p.bd).join(',') === '1990-01-01,2000-03-03,2016-04-02,2018-09-10', 'student profiles carry birth dates');
  ok(profiles.every((p) => [c(1), c(2), c(3), c(12)].some((x) => x.studentPersonId === p.person_id && x.familyId === p.primary_family_id)), 'profile primary family is the import family');
  const after = await sideEffects();
  ok(JSON.stringify(after) === JSON.stringify(before), `no membership, account, invoice, payment, schedule, enrollment, portal access or lead: ${JSON.stringify(after)}`);
  const events = (await sql("SELECT event_type, count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 GROUP BY 1 ORDER BY 1", [ids.organization])).rows;
  ok(events.map((e) => `${e.event_type}:${e.n}`).join(',') === 'students.import.decide:2,students.import.finalize:1,students.import.row_applied:4,students.import.stage:1', `only inert import events ${JSON.stringify(events)}`);
  const evidence = JSON.stringify((await sql("SELECT payload FROM hon.outbox_events WHERE organization_id=$1 UNION ALL SELECT next_state FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'students.import.%'", [ids.organization])).rows);
  ok(!/Ava|Stone|Mia|example\.test|2016-04-02|\+1555/.test(evidence), 'audit and outbox carry identifiers only');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'students.import.%'", [ids.organization])).rows[0].n === 8, 'one audit event per command and per imported row');
  const listed = (await success(() => list(IMPORTER), 'list after finalize')).data;
  ok(listed.batches.length === 1 && listed.batches[0].id === staged.id && listed.batches[0].status === 'FINALIZED', 'list shows the finalized batch');
  ok((await success(() => list(OTHER_SCHOOL), 'school B list')).data.batches.length === 0, 'school B sees no school-A batch');

  // 8. Evidence triggers: no owner write can rewrite, delete or reopen an import outside the commands.
  await sql('BEGIN');
  await rejectsSql(() => sql("UPDATE hon.student_import_rows SET normalized='{}' WHERE batch_id=$1 AND row_index=4", [staged.id]), /STUDENT_IMPORT_IMMUTABLE/, 'row content rewritten');
  await rejectsSql(() => sql("UPDATE hon.student_import_rows SET choice='IMPORT' WHERE batch_id=$1 AND row_index=10", [staged.id]), /STUDENT_IMPORT_IMMUTABLE/, 'row of a finalized batch re-decided');
  await rejectsSql(() => sql("UPDATE hon.student_import_batches SET version=version+1 WHERE id=$1", [staged.id]), /STUDENT_IMPORT_IMMUTABLE/, 'finalized batch changed');
  await rejectsSql(() => sql('DELETE FROM hon.student_import_rows WHERE batch_id=$1', [staged.id]), /STUDENT_IMPORT_IMMUTABLE/, 'rows deleted');
  await rejectsSql(() => sql('DELETE FROM hon.student_import_batches WHERE id=$1', [staged.id]), /STUDENT_IMPORT_IMMUTABLE/, 'batch deleted');
  await rejectsSql(() => sql('TRUNCATE hon.student_import_requests'), /STUDENT_IMPORT_IMMUTABLE/, 'requests truncated');
  await rejectsSql(() => sql("UPDATE hon.student_import_requests SET response='{}' WHERE organization_id=$1", [ids.organization]), /STUDENT_IMPORT_IMMUTABLE/, 'stored response rewritten');
  await sql('ROLLBACK');
  // A staged batch: content stays fixed and only the version may advance by one.
  const other = (await success(() => stage(OWN, { csv: 'First,Last,DOB\nTia,Gray,1999-09-09\n', mapping: { First: 'studentGivenName', Last: 'studentFamilyName', DOB: 'birthDate' } }), 'second stage')).data;
  ok(other.validCount === 1, 'second batch staged');
  await sql('BEGIN');
  await rejectsSql(() => sql('UPDATE hon.student_import_batches SET version=version+2 WHERE id=$1', [other.id]), /STUDENT_IMPORT_IMMUTABLE/, 'version skipped');
  await rejectsSql(() => sql('UPDATE hon.student_import_batches SET valid_count=0,version=version+1 WHERE id=$1', [other.id]), /STUDENT_IMPORT_IMMUTABLE/, 'staged counts rewritten');
  await rejectsSql(() => sql("UPDATE hon.student_import_rows SET choice='IMPORT' WHERE batch_id=$1", [other.id]).then(() => sql('UPDATE hon.student_import_rows SET choice=NULL WHERE batch_id=$1', [other.id])), /STUDENT_IMPORT_IMMUTABLE/, 'a decision cannot be undone to undecided');
  await sql('ROLLBACK');

  // 9. Runtime ACL: EXECUTE on the five entry points only; no table privilege, no helper, nothing for PUBLIC.
  const entry = ['stage_student_import(text,jsonb,text,uuid,uuid)', 'decide_student_import(text,jsonb,text,uuid,uuid)', 'finalize_student_import(text,jsonb,text,uuid,uuid)',
    'read_student_imports(text)', 'read_student_import(text,uuid)'];
  const helpers = ['guard_student_import()', 'require_student_import_actor(text)', 'student_import_fields()', 'student_import_check_row(jsonb,jsonb,jsonb,date)',
    'student_import_guardian(jsonb)', 'student_import_summary(uuid)', 'student_import_detail(uuid)', 'student_import_begin(text,text,jsonb,text,uuid,uuid)',
    'student_import_finish(text,uuid,text,uuid,text,uuid,uuid,jsonb)', 'apply_student_import_row(uuid,integer,uuid,uuid,uuid)'];
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
  for (const table of ['student_import_batches', 'student_import_rows', 'student_import_requests']) {
    const r = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(r.forced && !r.runtime, `${table}: forced RLS, no runtime privilege`);
  }
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const start = '-- Student CSV import exact verification (0226)', end = '-- End student CSV import exact verification.';
    const section = verify.split(start)[1]?.split(end)[0];
    ok(section, start);
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); }
  await assert.rejects(runtime.query('SELECT * FROM hon.student_import_rows LIMIT 1'), /permission denied/); checks += 1;
  await assert.rejects(runtime.query("SELECT hon.apply_student_import_row(gen_random_uuid(),1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid())"), /permission denied/); checks += 1;
  // Direct runtime call without the session settings is refused before any write.
  await assert.rejects(runtime.query("SELECT hon.read_student_imports($1)", [IMPORTER.subject]), /STUDENT_IMPORT_FORBIDDEN/); checks += 1;

  console.log(`PASS: student CSV import (0226): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
