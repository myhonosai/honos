/**
 * The digital membership agreement (M-E, 0410) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards +
 * HonExceptionFilter -> controller -> protected definer functions on the restricted runtime role with forced RLS), and the
 * family's public signing link over plain HTTP with no account, on the guarded disposable CRM-close fixture only. Memberships
 * are made through the real card start (0398) and started through the real two-step 0177 activation service. Synthetic names
 * only; no money moves and nothing is sent.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CRM_CLOSE_OWNER_ROLE, CRM_CLOSE_RUNTIME_ROLE, crmCloseProofTargets, verifyCrmCloseProofConnection } from './crm-close-proof-target.mjs';
import { confirmationFor, membershipFixtureQuery, membershipFixtureStatement } from './membership-activation-test-support.mjs';

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
const { PersonMembershipStartController } = await load('billing/person-membership-start.controller.js');
const { PersonMembershipStartService } = await load('billing/person-membership-start.service.js');
const { MembershipAgreementController, PublicMembershipAgreementController } = await load('billing/membership-agreement.controller.js');
const { MembershipAgreementService } = await load('billing/membership-agreement.service.js');
const { MembershipService } = await load('billing/membership.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-membership-agreement', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const SVC = '00000000-0000-4000-8000-000000000410';
const TEXT_CONFIRMATION = 'I_CONFIRM_MEMBERSHIP_AGREEMENT_TEXT';
const SEND_CONFIRMATION = 'I_CONFIRM_SEND_MEMBERSHIP_AGREEMENT';
const SIGN_CONFIRMATION = 'I_AGREE_AND_SIGN_THIS_MEMBERSHIP_AGREEMENT';
const START_CONFIRMATION = 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_FROM_PLAN';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();
const memberships = new MembershipService(database);

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [PersonMembershipStartController, MembershipAgreementController, PublicMembershipAgreementController],
    providers: [HonIdentityGuard, HonIdentityService, PersonMembershipStartService, MembershipAgreementService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

function send(method, target, headers, payload) {
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method, headers }, (response) => {
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
function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/billing/${path}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    'X-Hon-Human-Command': command,
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(method, target, sent, payload);
}
const publicCall = (method, token, body) => send(method, new URL(`${origin}/v1/public/agreements/${token}${method === 'POST' ? '/signature' : ''}`),
  { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body === undefined ? undefined : JSON.stringify(body));

const template = (actor, extra = {}) => call(actor, 'GET', 'membership-agreement', { command: 'billing.membership_agreement.read', ...extra });
const save = (actor, body, extra = {}) => call(actor, 'POST', 'membership-agreement', { body, command: 'billing.membership_agreement.save', ...extra });
const card = (actor, membershipId, extra = {}) => call(actor, 'GET', `memberships/${membershipId}/agreement`, { command: 'billing.membership_agreement.card_read', ...extra });
const sendLink = (actor, membershipId, body, extra = {}) => call(actor, 'POST', `memberships/${membershipId}/agreement/send`, { body, command: 'billing.membership_agreement.send', ...extra });
const startCard = (actor, personId, body) => call(actor, 'POST', `people/${personId}/memberships/from-plan`, { body, command: 'billing.membership.start_from_plan' });

async function success(read, label, expected = 200) {
  const { status, body, headers } = await read();
  assert.equal(status, expected, `${label}: expected ${expected}, got ${status} ${JSON.stringify(body).slice(0, 500)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label, expectedBlockers) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 500)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 500)}`);
  if (expectedBlockers) assert.deepEqual([...body.blockers].sort(), [...expectedBlockers].sort(), `${label}: blockers ${JSON.stringify(body.blockers)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
  return body;
}
async function rejectsSql(client, run, pattern, label) {
  await client.query('BEGIN');
  try { await run(); } catch (error) { await client.query('ROLLBACK'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await client.query('ROLLBACK');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0224 proof).
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    for (let pass = 0; pass < 10; pass += 1) {
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
    const left = (await sql('SELECT count(*)::int n FROM hon.memberships WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left memberships behind');
    const like = `membership-agreement-${ids.organization}-%`;
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [like]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [like]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [like]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

const allPermissions = (await sql('SELECT code FROM hon.permissions WHERE is_staff_assignable ORDER BY code')).rows.map((row) => row.code);
async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roles, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `membership-agreement-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Agreement Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Agreement Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  const context = (patch = {}) => { const requestId = randomUUID(); return { organizationId: org, schoolId: school, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI',
    externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: randomUUID(), ...patch }; };
  return { subject, principal, grants, org, school, context, read: (patch = {}) => context({ idempotencyKey: '', ...patch }) };
}
async function person(givenName, { school = ids.schoolA, org = ids.organization, birthDate, family = null, student = true } = {}) {
  const id = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,'Card')", [id, org, school, givenName]);
  if (student) await sql('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES($1,$2,$3,$4,$5)', [org, school, id, family, birthDate ?? null]);
  return id;
}
const member = (familyId, personId, roleName, billing = false) =>
  sql('INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES($1,$2,$3,$4,$5,$6)', [ids.organization, ids.schoolA, familyId, personId, roleName, billing]);

let OWN, CREATOR, READER, NONE, OTHER_SCHOOL, today, planId, programId;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const people = {};
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const token = () => randomBytes(32).toString('base64url');
const EN = { title: 'Membership agreement', body: 'I agree to the class rules and the membership terms shown below.\n\nSigned digitally.' };
const KO = { title: '회원 약정서', body: '아래에 표시된 수업 규칙과 회원 조건에 동의합니다.' };
const saveBody = (patch = {}) => ({ expectedVersion: null, texts: { en: EN }, signatureRequired: false, confirmation: TEXT_CONFIRMATION, ...patch });
const sendBody = (signerPersonId, t, patch = {}) => ({ signerPersonId, token: t, confirmation: SEND_CONFIRMATION, ...patch });
const STROKES = [[10, 10, 40, 30, 80, 20], [90, 40, 120, 60]];
const signBody = (link, patch = {}) => ({ language: 'en', documentHash: link.languages.en.documentHash, signerName: 'Ada Card', relationship: 'SELF', strokes: STROKES,
  confirmation: SIGN_CONFIRMATION, ...patch });

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Agreement Org','Agreement Org'),($2,'Agreement Other Org','Agreement Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Agreement School ${slug}`, `agreement-${slug}-${school.slice(0, 8)}`, LA]);
  }
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  CREATOR = await staff('creator', [await role(ids.organization, ['billing.membership.create', 'billing.membership.read'])]);
  READER = await staff('reader', [await role(ids.organization, ['billing.membership.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'billing.membership.activate'])]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, ['billing.membership.create', 'billing.membership.read', 'billing.membership_agreement.manage'])], { school: ids.schoolB });
  programId = (await sql("INSERT INTO hon.programs(organization_id,school_id,name,status) VALUES($1,$2,'Taekwondo','SCHEDULED') RETURNING id", [ids.organization, ids.schoolA])).rows[0].id;
  planId = randomUUID();
  await sql('INSERT INTO hon.membership_plans(id,organization_id,school_id,plan_code,current_version,created_by_principal_id) VALUES($1,$2,$3,$4,1,$5)', [planId, ids.organization, ids.schoolA, 'TKD-12', OWN.principal]);
  await sql(`INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,program_id,availability,currency,price_minor,billing_frequency,term_kind,term_months,actor_principal_id)
    VALUES($1,1,$2,$3,'Taekwondo 12 months',$4,'AVAILABLE','USD',15000,'MONTHLY','FIXED_MONTHS',12,$5)`, [planId, ids.organization, ids.schoolA, programId, OWN.principal]);
  for (const name of ['Ada', 'Uma', 'Eli', 'Ivy', 'Jo']) people[name] = await person(name, { birthDate: '1990-04-02' });
  const fam = (await sql("INSERT INTO hon.families(organization_id,school_id,display_name) VALUES($1,$2,'Card family') RETURNING id", [ids.organization, ids.schoolA])).rows[0].id;
  people.guardianA = await person('Gale', { student: false }); people.guardianB = await person('Glen', { student: false });
  people.stranger = await person('Stan', { student: false });
  people.kit = await person('Kit', { birthDate: addDays(today, -365 * 9), family: fam });
  await member(fam, people.kit, 'STUDENT'); await member(fam, people.guardianA, 'GUARDIAN', false); await member(fam, people.guardianB, 'GUARDIAN', true);
}

const count = async (text, values) => (await sql(text, values)).rows[0].n;
const money = async () => (await sql(`SELECT (SELECT count(*)::int FROM hon.invoices WHERE organization_id=$1) invoices,
  (SELECT count(*)::int FROM hon.payment_attempts WHERE organization_id=$1) attempts,
  (SELECT count(*)::int FROM hon.membership_payment_schedules WHERE organization_id=$1) schedules`, [ids.organization])).rows[0];
async function draft(personId) {
  return (await success(() => startCard(CREATOR, personId, { membershipPlanId: planId, membershipPlanVersion: 1, kind: 'NEW', renewsMembershipId: null, startDate: today,
    payerPersonId: null, confirmation: START_CONFIRMATION }), 'card start', 201)).data.membershipId;
}
async function activate(membershipId) {
  const preview = await memberships.previewActivation(OWN.read(), membershipId, {});
  return (await memberships.activate(OWN.context(), membershipId, confirmationFor(preview))).membership;
}
async function activationRefused(membershipId, label) {
  let error = null;
  try { await activate(membershipId); } catch (caught) { error = caught; }
  ok(error?.getStatus?.() === 409 && error.getResponse().code === 'MEMBERSHIP_AGREEMENT_REQUIRED', `${label}: ${JSON.stringify(error?.getResponse?.() ?? error?.message)}`);
  ok((await sql('SELECT state::text s FROM hon.memberships WHERE id=$1', [membershipId])).rows[0].s === 'DRAFT', `${label}: stays a DRAFT`);
}
const state = async (membershipId) => (await sql('SELECT state::text s FROM hon.memberships WHERE id=$1', [membershipId])).rows[0].s;

try {
  await cleanup();
  await seed();
  await startApp();
  const moneyBefore = await money();
  const M = {};
  M.ada = await draft(people.Ada);

  // 1. Before any agreement: nothing to read, nothing to send, and a membership starts as before.
  const empty = (await success(() => template(READER), 'template before the first save')).data;
  ok(empty.textVersion === null && empty.signatureRequired === false && empty.texts === null && empty.updatedAt === null, 'no agreement yet');
  await refused(() => sendLink(CREATOR, M.ada, sendBody(people.Ada, token())), 409, 'MEMBERSHIP_AGREEMENT_BLOCKED', 'send before any agreement', ['NO_AGREEMENT']);

  // 2. Authority: reads need billing.membership.read, the agreement text needs billing.membership_agreement.manage, sending
  // needs billing.membership.create, all at the session school; route ids are never authority.
  await refused(() => template(NONE), 403, undefined, 'template read without billing.membership.read');
  await refused(() => save(CREATOR, saveBody()), 403, undefined, 'save without billing.membership_agreement.manage');
  await refused(() => save(OTHER_SCHOOL, saveBody(), { school: ids.schoolA }), 403, undefined, 'school-B manager at the school-A route');
  await refused(() => card(NONE, M.ada), 403, undefined, 'card read without billing.membership.read');
  await refused(() => card(OTHER_SCHOOL, M.ada, { school: ids.schoolA }), 403, undefined, 'school-B staff reads a school-A card');
  await refused(() => card(OTHER_SCHOOL, M.ada), 404, 'MEMBERSHIP_AGREEMENT_NOT_FOUND', 'a school-A membership through the school-B route');
  await refused(() => sendLink(READER, M.ada, sendBody(people.Ada, token())), 403, undefined, 'send without billing.membership.create');
  await refused(() => template(READER, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, undefined, 'cross-site read');
  await refused(() => template(READER, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with a key');
  await refused(() => save(OWN, saveBody(), { command: 'billing.membership_agreement.read' }), 403, undefined, 'save with the read command header');
  await refused(() => save(OWN, saveBody(), { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'save without a key');

  // 3. Closed validation of the agreement text.
  for (const [label, patch] of [['no English', { texts: { ko: KO } }], ['unknown language', { texts: { en: EN, fr: EN } }], ['empty body', { texts: { en: { title: 'T', body: '   ' } } }],
    ['title with a newline', { texts: { en: { title: 'A\nB', body: 'x' } } }], ['extra key', { other: 1 }], ['wrong confirmation', { confirmation: 'yes' }],
    ['string version', { expectedVersion: '1' }], ['string flag', { signatureRequired: 'true' }]]) {
    await refused(() => save(OWN, saveBody(patch)), 400, undefined, `save validation: ${label}`);
  }
  ok(await count('SELECT count(*)::int n FROM hon.membership_agreement_texts WHERE organization_id=$1', [ids.organization]) === 0, 'refused saves write nothing');

  // 4. Version 1 without a signature requirement: saved, replayed, stale and reused keys refused.
  const k1 = randomUUID();
  const v1 = await success(() => save(OWN, saveBody(), { key: k1 }), 'save version 1', 201);
  ok(v1.meta.replayed === false && v1.data.textVersion === 1 && v1.data.signatureRequired === false && v1.data.texts.en.body === EN.body, 'version 1 receipt');
  ok((await success(() => save(OWN, saveBody(), { key: k1 }), 'replay version 1')).meta.replayed === true, 'exact replay');
  await refused(() => save(OWN, saveBody({ signatureRequired: true }), { key: k1 }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another body');
  await refused(() => save(OWN, saveBody()), 409, 'MEMBERSHIP_AGREEMENT_STALE', 'a second first-save is stale');
  await refused(() => save(OWN, saveBody({ expectedVersion: 7 })), 409, 'MEMBERSHIP_AGREEMENT_STALE', 'a wrong version is stale');
  const audit1 = (await sql("SELECT * FROM hon.audit_events WHERE organization_id=$1 AND action_code='billing.membership_agreement.manage'", [ids.organization])).rows;
  ok(audit1.length === 1 && audit1[0].source === 'HUMAN_UI' && audit1[0].actor_principal_id === OWN.principal && !JSON.stringify(audit1[0].next_state).includes('class rules'),
    'audit: version and languages only, never the text');

  // 5. Not required: an unsigned membership still starts.
  M.uma = await draft(people.Uma);
  ok((await activate(M.uma)).state === 'ACTIVE', 'without the requirement a membership starts unsigned');

  // 6. Version 2 in English and Korean, signature required.
  const v2 = (await success(() => save(OWN, saveBody({ expectedVersion: 1, texts: { en: EN, ko: KO }, signatureRequired: true })), 'save version 2', 201)).data;
  ok(v2.textVersion === 2 && v2.signatureRequired === true && v2.texts.ko.title === KO.title, 'version 2 receipt');
  const read2 = (await success(() => template(READER), 'template read')).data;
  ok(read2.textVersion === 2 && read2.signatureRequired === true && Object.keys(read2.texts).sort().join() === 'en,ko', 'the current agreement is version 2');
  ok(await count('SELECT count(*)::int n FROM hon.membership_agreement_texts WHERE school_id=$1', [ids.schoolA]) === 2, 'version 1 is kept');
  ok((await success(() => template(OTHER_SCHOOL), 'school B template')).data.textVersion === null, 'school B has its own (no) agreement');

  // 7. The card panel and the gate: required and unsigned, the 0177 start is refused.
  const panel = (await success(() => card(CREATOR, M.ada), 'card panel')).data;
  ok(panel.membershipId === M.ada && panel.membershipState === 'DRAFT' && panel.agreementVersion === 2 && panel.signatureRequired === true && panel.signed === false
    && panel.requests.length === 0 && panel.signers.length === 1 && panel.signers[0].personId === people.Ada && panel.signers[0].relation === 'SELF', 'adult: signs for themselves');
  await activationRefused(M.ada, 'unsigned start refused');

  // 8. Send: closed validation, allowed signers only.
  for (const [label, patch] of [['extra key', { other: 1 }], ['membershipId in body', { membershipId: M.ada }], ['short token', { token: 'abc' }],
    ['token with a bad character', { token: `${token().slice(0, 42)}=` }], ['wrong confirmation', { confirmation: 'yes' }], ['bad signer id', { signerPersonId: 'x' }]]) {
    await refused(() => sendLink(CREATOR, M.ada, sendBody(people.Ada, token(), patch)), 400, undefined, `send validation: ${label}`);
  }
  await refused(() => sendLink(CREATOR, M.ada, sendBody(people.Ada, token()), { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'send without a key');
  await refused(() => sendLink(CREATOR, M.ada, sendBody(people.stranger, token())), 409, 'MEMBERSHIP_AGREEMENT_BLOCKED', 'a signer who is not the student or a guardian', ['SIGNER_NOT_ALLOWED']);
  await refused(() => sendLink(CREATOR, randomUUID(), sendBody(people.Ada, token())), 404, 'MEMBERSHIP_AGREEMENT_NOT_FOUND', 'an unknown membership');
  ok(await count('SELECT count(*)::int n FROM hon.membership_agreement_requests WHERE organization_id=$1', [ids.organization]) === 0, 'refused sends write nothing');

  // 9. A link: only the token's SHA-256 is kept; replay returns the same receipt.
  const t1 = token(), sk1 = randomUUID();
  const sent1 = await success(() => sendLink(CREATOR, M.ada, sendBody(people.Ada, t1), { key: sk1 }), 'send link 1', 201);
  ok(sent1.meta.replayed === false && sent1.data.state === 'OPEN' && sent1.data.membershipId === M.ada && sent1.data.signerPersonId === people.Ada && sent1.data.signerRelation === 'SELF'
    && sent1.data.textVersion === 2 && sent1.data.signature === null, 'link 1 receipt');
  const replay1 = await success(() => sendLink(CREATOR, M.ada, sendBody(people.Ada, t1), { key: sk1 }), 'replay link 1');
  ok(replay1.meta.replayed === true && JSON.stringify(replay1.data) === JSON.stringify(sent1.data), 'replay returns the stored receipt');
  await refused(() => sendLink(CREATOR, M.ada, sendBody(people.Ada, token()), { key: sk1 }), 409, 'IDEMPOTENCY_KEY_REUSED', 'send key reused for another token');
  const row1 = (await sql('SELECT * FROM hon.membership_agreement_requests WHERE id=$1', [sent1.data.requestId])).rows[0];
  ok(row1.token_hash === sha(t1) && row1.state === 'OPEN' && row1.actor_principal_id === CREATOR.principal
    && Math.abs(new Date(row1.expires_at) - new Date(row1.created_at) - 14 * 86400000) < 1000, 'stored: token hash, 14-day expiry');
  const everywhere = (await sql(`SELECT (SELECT string_agg(r::text,'') FROM hon.membership_agreement_requests r WHERE organization_id=$1)
    ||coalesce((SELECT string_agg(a::text,'') FROM hon.audit_events a WHERE organization_id=$1),'')||coalesce((SELECT string_agg(o::text,'') FROM hon.outbox_events o WHERE organization_id=$1),'') t`, [ids.organization])).rows[0].t;
  ok(!everywhere.includes(t1), 'the token itself is stored nowhere');
  const sentAudit = (await sql("SELECT * FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.membership_agreement.send'", [M.ada])).rows;
  const sentOutbox = (await sql("SELECT * FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.membership_agreement.sent'", [M.ada])).rows;
  ok(sentAudit.length === 1 && sentAudit[0].source === 'HUMAN_UI' && !JSON.stringify(sentAudit[0].next_state).includes('Ada'), 'send audit: ids only');
  ok(sentOutbox.length === 1 && sentOutbox[0].payload.executionAllowed === false && sentOutbox[0].payload.humanOnly === true, 'send outbox: inert');

  // 10. The public link: no account, never cached or indexed, shows the snapshot.
  const open1 = await publicCall('GET', t1);
  ok(open1.status === 200 && open1.headers['cache-control'] === 'no-store' && open1.headers['referrer-policy'] === 'no-referrer' && open1.headers['x-robots-tag'] === 'noindex',
    `public link headers (${open1.status})`);
  const link1 = open1.body.data;
  ok(link1.state === 'OPEN' && link1.schoolName === 'Agreement School a' && link1.signerRelation === 'SELF' && link1.signerGivenName === 'Ada'
    && Object.keys(link1.languages).sort().join() === 'en,ko' && link1.languages.ko.body === KO.body && link1.terms.studentName === 'Ada Card' && link1.terms.payerName === 'Ada Card'
    && link1.terms.planCode === 'TKD-12' && link1.terms.planName === 'Taekwondo 12 months' && link1.terms.priceMinor === 15000 && link1.terms.currency === 'USD'
    && link1.terms.startDate === today, `the link shows the agreement and the membership terms: ${JSON.stringify(link1.terms)}`);
  ok(link1.languages.en.documentHash !== link1.languages.ko.documentHash && link1.languages.en.documentHash === row1.document.languages.en.documentHash, 'one hash per language');
  ok(!JSON.stringify(open1.body).includes(people.Ada) && !JSON.stringify(open1.body).includes(ids.organization), 'the public link carries no ids');
  for (const bad of [token(), 'short', `${t1.slice(0, 42)}!`]) {
    const r = await publicCall('GET', encodeURIComponent(bad));
    ok(r.status === 404 && !('data' in r.body), `an unknown or malformed token shows nothing (${r.status})`);
  }

  // 11. A new send replaces the open link.
  const t2 = token();
  const sent2 = (await success(() => sendLink(CREATOR, M.ada, sendBody(people.Ada, t2)), 'send link 2', 201)).data;
  const replaced = await publicCall('GET', t1);
  ok(replaced.status === 200 && JSON.stringify(replaced.body.data) === JSON.stringify({ state: 'REPLACED', schoolName: 'Agreement School a' }), 'the old link shows only that it was replaced');
  const replacedSign = await publicCall('POST', t1, signBody(link1));
  ok(replacedSign.status === 410 && replacedSign.body.result === 'gone', 'a replaced link cannot sign');
  ok(await count("SELECT count(*)::int n FROM hon.membership_agreement_requests WHERE membership_id=$1 AND state='OPEN'", [M.ada]) === 1, 'one open link per membership');
  const link2 = (await publicCall('GET', t2)).body.data;

  // 12. Signing: it must match exactly what the link shows.
  for (const [label, patch] of [['another document hash', { documentHash: link1.languages.ko.documentHash }], ['a language the agreement lacks', { language: 'es', documentHash: link2.languages.en.documentHash }],
    ['a guardian relationship for an adult', { relationship: 'PARENT' }], ['no strokes', { strokes: [] }], ['a one-number stroke', { strokes: [[1]] }],
    ['an out-of-range point', { strokes: [[1, 20000]] }], ['an empty name', { signerName: '' }], ['wrong confirmation', { confirmation: 'yes' }], ['extra key', { other: 1 }]]) {
    const r = await publicCall('POST', t2, signBody(link2, patch));
    ok(r.status === 400 && r.body.result === 'invalid', `sign refused: ${label} (${r.status} ${JSON.stringify(r.body)})`);
  }
  ok(await count('SELECT count(*)::int n FROM hon.membership_agreement_signatures WHERE membership_id=$1', [M.ada]) === 0, 'refused signatures write nothing');
  const signed = await publicCall('POST', t2, signBody(link2));
  ok(signed.status === 201 && signed.body.result === 'signed' && signed.headers['cache-control'] === 'no-store', `signed (${signed.status})`);
  const again = await publicCall('POST', t2, signBody(link2));
  ok(again.status === 410 && again.body.result === 'gone', 'a link signs once');
  ok(JSON.stringify((await publicCall('GET', t2)).body.data) === JSON.stringify({ state: 'SIGNED', schoolName: 'Agreement School a' }), 'a signed link shows only that it was signed');
  const signature = (await sql('SELECT * FROM hon.membership_agreement_signatures WHERE membership_id=$1', [M.ada])).rows;
  ok(signature.length === 1 && signature[0].request_id === sent2.requestId && signature[0].document_hash === link2.languages.en.documentHash && signature[0].language === 'en'
    && signature[0].text_version === 2 && signature[0].signer_person_id === people.Ada && signature[0].signer_name === 'Ada Card'
    && JSON.stringify(signature[0].strokes) === JSON.stringify(STROKES), 'the signature is bound to the exact document shown');
  const signAudit = (await sql("SELECT * FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.membership_agreement.sign'", [M.ada])).rows;
  ok(signAudit.length === 1 && signAudit[0].actor_principal_id === SVC && signAudit[0].source === 'PUBLIC_API' && !JSON.stringify(signAudit[0]).includes('Ada Card')
    && !JSON.stringify(signAudit[0]).includes('[10,'), 'sign audit: the code-owned link principal, no name or strokes');
  ok(await count("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.membership_agreement.signed' AND payload->>'executionAllowed'='false'", [M.ada]) === 1,
    'sign outbox: inert');
  const signedPanel = (await success(() => card(READER, M.ada), 'card after signing')).data;
  ok(signedPanel.signed === true && signedPanel.requests.length === 2 && signedPanel.requests[0].state === 'SIGNED' && signedPanel.requests[0].signature.signedName === 'Ada Card'
    && signedPanel.requests[0].signature.relationship === 'SELF' && signedPanel.requests[1].state === 'REPLACED' && signedPanel.requests[1].signature === null, 'the card shows the signature');
  await refused(() => sendLink(CREATOR, M.ada, sendBody(people.Ada, token())), 409, 'MEMBERSHIP_AGREEMENT_BLOCKED', 'send after signing', ['ALREADY_SIGNED']);

  // 13. Signed: the 0177 start goes through; a started membership takes no new link.
  ok((await activate(M.ada)).state === 'ACTIVE', 'the signed membership starts');
  await refused(() => sendLink(CREATOR, M.ada, sendBody(people.Ada, token())), 409, 'MEMBERSHIP_AGREEMENT_BLOCKED', 'send after starting', ['MEMBERSHIP_STARTED']);
  ok((await success(() => card(READER, M.ada), 'card after starting')).data.signers.length === 0, 'a started membership offers no signers');

  // 14. A minor: a guardian of the primary family signs, as parent or legal guardian, in Korean.
  M.kit = await draft(people.kit);
  const kitPanel = (await success(() => card(CREATOR, M.kit), 'child card')).data;
  ok(kitPanel.signers.length === 2 && kitPanel.signers.every((s) => s.relation === 'GUARDIAN') && kitPanel.signers.map((s) => s.personId).sort().join() === [people.guardianA, people.guardianB].sort().join(),
    'a minor: only the guardians may sign');
  await refused(() => sendLink(CREATOR, M.kit, sendBody(people.kit, token())), 409, 'MEMBERSHIP_AGREEMENT_BLOCKED', 'a minor cannot sign', ['SIGNER_NOT_ALLOWED']);
  const tk = token();
  ok((await success(() => sendLink(CREATOR, M.kit, sendBody(people.guardianA, tk)), 'send to a guardian', 201)).data.signerRelation === 'GUARDIAN', 'guardian link');
  const kitLink = (await publicCall('GET', tk)).body.data;
  ok(kitLink.signerRelation === 'GUARDIAN' && kitLink.signerGivenName === 'Gale' && kitLink.terms.studentName === 'Kit Card' && kitLink.terms.payerName === 'Glen Card',
    'the guardian sees the student and the payer');
  const asSelf = await publicCall('POST', tk, signBody(kitLink, { language: 'ko', documentHash: kitLink.languages.ko.documentHash, signerName: 'Gale Card', relationship: 'SELF' }));
  ok(asSelf.status === 400 && asSelf.body.result === 'invalid', 'a guardian cannot sign as the student');
  await activationRefused(M.kit, 'the child membership waits for the signature');
  const kitSigned = await publicCall('POST', tk, signBody(kitLink, { language: 'ko', documentHash: kitLink.languages.ko.documentHash, signerName: 'Gale Card', relationship: 'LEGAL_GUARDIAN' }));
  ok(kitSigned.status === 201, 'the guardian signs in Korean');
  ok((await activate(M.kit)).state === 'ACTIVE', 'the child membership starts once signed');

  // 15. Expiry: an expired link shows only that, cannot sign, and a new send replaces it.
  M.eli = await draft(people.Eli);
  const te = token();
  const sentE = (await success(() => sendLink(CREATOR, M.eli, sendBody(people.Eli, te)), 'send link to expire', 201)).data;
  const eliLink = (await publicCall('GET', te)).body.data;
  await sql('BEGIN');
  await sql('ALTER TABLE hon.membership_agreement_requests DISABLE TRIGGER membership_agreement_requests_guard');
  await sql("UPDATE hon.membership_agreement_requests SET created_at=created_at-interval '15 days',expires_at=expires_at-interval '15 days' WHERE id=$1", [sentE.requestId]);
  await sql('ALTER TABLE hon.membership_agreement_requests ENABLE TRIGGER membership_agreement_requests_guard');
  await sql('COMMIT');
  ok(JSON.stringify((await publicCall('GET', te)).body.data) === JSON.stringify({ state: 'EXPIRED', schoolName: 'Agreement School a' }), 'an expired link shows only that');
  const expiredSign = await publicCall('POST', te, signBody(eliLink, { signerName: 'Eli Card' }));
  ok(expiredSign.status === 410 && expiredSign.body.result === 'gone', 'an expired link cannot sign');
  ok((await success(() => card(READER, M.eli), 'card with an expired link')).data.requests[0].state === 'EXPIRED', 'the card shows the link expired');
  const tr = token();
  await success(() => sendLink(CREATOR, M.eli, sendBody(people.Eli, tr)), 'resend after expiry', 201);
  ok((await sql('SELECT state FROM hon.membership_agreement_requests WHERE id=$1', [sentE.requestId])).rows[0].state === 'REPLACED', 'the resend replaces the expired link');
  ok((await publicCall('GET', tr)).body.data.state === 'OPEN', 'the new link is open');

  // 16. Every other writer is gated too, and a reviewed billing import is exempt.
  await rejectsSql(admin, () => membershipFixtureStatement(admin, "UPDATE hon.memberships SET state='ACTIVE',version=version+1 WHERE id=$1", [M.eli]),
    /MEMBERSHIP_AGREEMENT_REQUIRED/, 'a direct start of an unsigned membership is refused');
  ok(await state(M.eli) === 'DRAFT', 'still a DRAFT');
  M.ivy = await draft(people.Ivy);
  const facts = { origin: 'BILLING_IMPORT', requirementsNotEvaluated: ['AGREEMENT', 'PAYMENT', 'RECURRING_PAYMENT_AUTHORIZATION', 'FINANCIAL_RESPONSIBILITY', 'SCHOOL_ACTIVATION_POLICY'] };
  await sql(`INSERT INTO hon.membership_activation_decisions(organization_id,school_id,membership_id,prior_membership_version,next_membership_version,decision_basis,
      membership_source,actor_principal_id,authorizing_permission,reason_code,reason_text,acknowledged_warnings,overrides,preview_digest,evaluated_facts,requirements_not_evaluated,
      idempotency_key,request_fingerprint,request_id,correlation_id,receipt)
    VALUES($1,$2,$3,1,2,'STAFF_ACTIVATION_PRE_POLICY','GENERIC_LEGACY',$4,'billing.membership.activate','LEGACY_MEMBERSHIP','Imported in a reviewed billing import.','[]','[]',
      $5,$6::jsonb,$6::jsonb->'requirementsNotEvaluated',$7,$5,$8,$8,'{}')`,
    [ids.organization, ids.schoolA, M.ivy, OWN.principal, sha(JSON.stringify(facts)), JSON.stringify(facts), `billing-import:${randomUUID()}:1`, randomUUID()]);
  await membershipFixtureQuery(admin, "UPDATE hon.memberships SET state='ACTIVE',version=version+1 WHERE id=$1", [M.ivy]);
  ok(await state(M.ivy) === 'ACTIVE', 'an imported membership starts without a signature');
  M.jo = await draft(people.Jo);
  await sql(`INSERT INTO hon.membership_activation_decisions(organization_id,school_id,membership_id,prior_membership_version,next_membership_version,decision_basis,
      membership_source,actor_principal_id,authorizing_permission,reason_code,acknowledged_warnings,overrides,preview_digest,evaluated_facts,requirements_not_evaluated,
      idempotency_key,request_fingerprint,request_id,correlation_id,receipt)
    VALUES($1,$2,$3,1,2,'STAFF_ACTIVATION_PRE_POLICY','GENERIC_LEGACY',$4,'billing.membership.activate','ROUTINE_ENROLLMENT','[]','[]',
      $5,'{"origin":"STAFF"}',$6::jsonb,$7,$5,$8,$8,'{}')`,
    [ids.organization, ids.schoolA, M.jo, OWN.principal, sha('jo'), JSON.stringify(facts.requirementsNotEvaluated), `staff:${randomUUID()}`, randomUUID()]);
  await rejectsSql(admin, () => membershipFixtureStatement(admin, "UPDATE hon.memberships SET state='ACTIVE',version=version+1 WHERE id=$1", [M.jo]),
    /MEMBERSHIP_AGREEMENT_REQUIRED/, 'any other decision is not an import');

  // 17. Live authority: a revoked grant is refused at once.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1', [CREATOR.grants[0], OWN.principal]);
  await refused(() => sendLink(CREATOR, M.eli, sendBody(people.Eli, token())), 403, undefined, 'send after the grant is revoked');
  await refused(() => card(CREATOR, M.eli), 403, undefined, 'card read after the grant is revoked');

  // 18. Runtime ACL, forced RLS and immutability.
  const acl = (await sql(`SELECT p.oid::regprocedure::text sig, has_function_privilege($1,p.oid,'EXECUTE') can FROM pg_proc p
    WHERE p.pronamespace='hon'::regnamespace AND (p.proname LIKE '%membership_agreement%') ORDER BY 1`, [CRM_CLOSE_RUNTIME_ROLE])).rows;
  ok(acl.length === 13 && acl.filter((x) => x.can).map((x) => x.sig).sort().join() === ['hon.read_membership_agreement(text,jsonb)', 'hon.read_membership_agreement_link(text)',
    'hon.read_membership_agreement_template(text)', 'hon.save_membership_agreement_template(text,jsonb,text,uuid,uuid)', 'hon.send_membership_agreement(text,jsonb,text,uuid,uuid)',
    'hon.sign_membership_agreement(text,jsonb,uuid)'].join(), `runtime executes only the six entry points: ${JSON.stringify(acl)}`);
  for (const table of ['membership_agreement_texts', 'membership_agreement_requests', 'membership_agreement_signatures']) {
    ok(!(await sql(`SELECT has_table_privilege($1,'hon.${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') p`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0].p
      && (await sql(`SELECT relrowsecurity AND relforcerowsecurity f FROM pg_class WHERE oid='hon.${table}'::regclass`)).rows[0].f, `${table}: private, forced RLS`);
    await rejectsSql(runtime, () => runtime.query(`SELECT count(*) FROM hon.${table}`), /permission denied/, `runtime cannot read ${table}`);
  }
  await rejectsSql(runtime, () => runtime.query('SELECT hon.membership_agreement_current($1,$2)', [ids.organization, ids.schoolA]), /permission denied/, 'runtime cannot call a private helper');
  await rejectsSql(admin, () => sql("UPDATE hon.membership_agreement_texts SET signature_required=false WHERE school_id=$1", [ids.schoolA]), /IMMUTABLE_MEMBERSHIP_AGREEMENT/, 'agreement texts are immutable');
  await rejectsSql(admin, () => sql('DELETE FROM hon.membership_agreement_signatures WHERE membership_id=$1', [M.ada]), /IMMUTABLE_MEMBERSHIP_AGREEMENT/, 'signatures are never deleted');
  await rejectsSql(admin, () => sql("UPDATE hon.membership_agreement_signatures SET signer_name='Other' WHERE membership_id=$1", [M.ada]), /IMMUTABLE_MEMBERSHIP_AGREEMENT/, 'signatures never change');
  await rejectsSql(admin, () => sql("UPDATE hon.membership_agreement_requests SET state='OPEN',closed_at=NULL WHERE id=$1", [sent2.requestId]), /IMMUTABLE_MEMBERSHIP_AGREEMENT/, 'a signed link never reopens');
  await rejectsSql(admin, () => sql("UPDATE hon.membership_agreement_requests SET document='{}' WHERE membership_id=$1 AND state='OPEN'", [M.eli]), /IMMUTABLE_MEMBERSHIP_AGREEMENT/,
    'an open link keeps its document');
  await rejectsSql(admin, () => sql('TRUNCATE hon.membership_agreement_signatures'), /IMMUTABLE_MEMBERSHIP_AGREEMENT/, 'no truncate');

  // 19. No money moved.
  ok(JSON.stringify(await money()) === JSON.stringify(moneyBefore), 'no invoice, payment attempt or schedule was created');
  console.log(`PASS: membership agreement (0410), ${checks} checks.`);
} finally {
  await app?.close();
  await cleanup().catch((error) => console.error('cleanup failed', error.message));
  await runtime.end();
  await admin.end();
}
