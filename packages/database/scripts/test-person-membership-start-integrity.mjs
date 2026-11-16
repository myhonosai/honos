/**
 * New membership and Renew on the contact card (M-B, 0398) over signed HTTP (HON session cookie -> HonIdentityGuard + human
 * UI guards + HonExceptionFilter -> controller -> protected definer functions on the restricted runtime role with forced RLS),
 * on the guarded disposable CRM-close fixture only. Started memberships go through the real two-step 0177 activation service.
 * Synthetic names only; no money moves.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CRM_CLOSE_OWNER_ROLE, CRM_CLOSE_RUNTIME_ROLE, crmCloseProofTargets, verifyCrmCloseProofConnection } from './crm-close-proof-target.mjs';
import { confirmationFor, membershipFixtureStatement } from './membership-activation-test-support.mjs';

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
const { MembershipService } = await load('billing/membership.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-person-membership-start', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const CONFIRMATION = 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_FROM_PLAN';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();
const memberships = new MembershipService(database);

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [PersonMembershipStartController],
    providers: [HonIdentityGuard, HonIdentityService, PersonMembershipStartService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/billing/people/${path}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    'X-Hon-Human-Command': command,
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
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
const options = (actor, personId, extra = {}) => call(actor, 'GET', `${personId}/membership-start`, { command: 'billing.membership.start_options.read', ...extra });
const start = (actor, personId, body, extra = {}) => call(actor, 'POST', `${personId}/memberships/from-plan`, { body, command: 'billing.membership.start_from_plan', ...extra });

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
    const like = `person-membership-${ids.organization}-%`;
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
  const user = randomUUID(), principal = randomUUID(), subject = `person-membership-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Card Membership Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Card Membership Staff')", [principal, user]);
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
async function family(name, school = ids.schoolA) {
  return (await sql("INSERT INTO hon.families(organization_id,school_id,display_name) VALUES($1,$2,$3) RETURNING id", [ids.organization, school, name])).rows[0].id;
}
const member = (familyId, personId, roleName, billing = false) =>
  sql('INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES($1,$2,$3,$4,$5,$6)', [ids.organization, ids.schoolA, familyId, personId, roleName, billing]);
async function program(name, school = ids.schoolA, org = ids.organization) {
  return (await sql("INSERT INTO hon.programs(organization_id,school_id,name,status) VALUES($1,$2,$3,'SCHEDULED') RETURNING id", [org, school, name])).rows[0].id;
}
async function plan(code, { programId = null, termKind = 'FIXED_MONTHS', termMonths = 12, currency = 'USD', availability = 'AVAILABLE', school = ids.schoolA, org = ids.organization, by } = {}) {
  const id = randomUUID();
  await sql('INSERT INTO hon.membership_plans(id,organization_id,school_id,plan_code,current_version,created_by_principal_id) VALUES($1,$2,$3,$4,1,$5)', [id, org, school, code, by]);
  await sql(`INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,program_id,availability,currency,price_minor,billing_frequency,term_kind,term_months,actor_principal_id)
    VALUES($1,1,$2,$3,$4,$5,$6,$7,15000,'MONTHLY',$8,$9,$10)`, [id, org, school, `Plan ${code}`, programId, availability, currency, termKind, termKind === 'FIXED_MONTHS' ? termMonths : null, by]);
  return id;
}

let OWN, CREATOR, NONE, MIXED, OTHER_SCHOOL, today;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const addMonths = (date, months) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 10); };
const P = {}, plans = {}, people = {};
const body = (planId, patch = {}) => ({ membershipPlanId: planId, membershipPlanVersion: 1, kind: 'NEW', renewsMembershipId: null, startDate: today, payerPersonId: null,
  confirmation: CONFIRMATION, ...patch });

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Card Membership Org','Card Membership Org'),($2,'Card Membership Other Org','Card Membership Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Card Membership ${slug}`, `card-membership-${slug}-${school.slice(0, 8)}`, LA]);
  }
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  CREATOR = await staff('creator', [await role(ids.organization, ['billing.membership.create'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'billing.membership.read', 'billing.membership.activate'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['billing.membership.create']), await role(ids.organization, ['billing.membership.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, ['billing.membership.create'])], { school: ids.schoolB });
  P.taekwondo = await program('Taekwondo'); P.bjj = await program('Jiu-jitsu'); P.closed = await program('Closed');
  await sql("UPDATE hon.programs SET status='CANCELLED' WHERE id=$1", [P.closed]);
  plans.tkd12 = await plan('TKD-12', { programId: P.taekwondo, by: OWN.principal });
  plans.tkdOpen = await plan('TKD-OPEN', { programId: P.taekwondo, termKind: 'OPEN_ENDED', by: OWN.principal });
  plans.bjj6 = await plan('BJJ-6', { programId: P.bjj, termMonths: 6, by: OWN.principal });
  plans.general = await plan('GENERAL', { termKind: 'OPEN_ENDED', by: OWN.principal });
  plans.eur = await plan('EUR-12', { programId: P.bjj, currency: 'EUR', by: OWN.principal });
  plans.off = await plan('OFF', { programId: P.taekwondo, availability: 'UNAVAILABLE', by: OWN.principal });
  plans.closed = await plan('CLOSED', { programId: P.closed, by: OWN.principal });
  plans.schoolB = await plan('SB-12', { school: ids.schoolB, by: OWN.principal });
  people.adult = await person('Ada', { birthDate: '1990-04-02' });
  people.unknownAge = await person('Uma');
  people.noProfile = await person('Nora', { student: false });
  const fam = await family('Card family');
  people.guardianA = await person('Gale', { student: false }); people.guardianB = await person('Glen', { student: false });
  people.stranger = await person('Stan', { student: false });
  people.child = await person('Kit', { birthDate: addDays(today, -365 * 9), family: fam });
  await member(fam, people.child, 'STUDENT'); await member(fam, people.guardianA, 'GUARDIAN', false); await member(fam, people.guardianB, 'GUARDIAN', true);
  people.orphanMinor = await person('Ollie', { birthDate: addDays(today, -365 * 10) });
  people.archived = await person('Arlo', { birthDate: '1985-01-01' });
  await sql("INSERT INTO hon.school_contact_archives(organization_id,school_id,person_id,kind,archived_by_principal_id) VALUES($1,$2,$3,'ARCHIVED',$4)", [ids.organization, ids.schoolA, people.archived, OWN.principal]);
  people.euroPayer = await person('Eve', { birthDate: '1980-01-01' });
  await sql("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification) VALUES($1,$2,$3,'EUR','CANONICAL')", [ids.organization, ids.schoolA, people.euroPayer]);
  people.schoolB = await person('Bea', { school: ids.schoolB, birthDate: '1990-01-01' });
}

const count = async (text, values) => (await sql(text, values)).rows[0].n;
const money = async () => (await sql(`SELECT (SELECT count(*)::int FROM hon.invoices WHERE organization_id=$1) invoices,
  (SELECT count(*)::int FROM hon.payment_attempts WHERE organization_id=$1) attempts,
  (SELECT count(*)::int FROM hon.membership_payment_schedules WHERE organization_id=$1) schedules`, [ids.organization])).rows[0];
async function activate(actor, membershipId, dates = {}) {
  const preview = await memberships.previewActivation(actor.read(), membershipId, dates);
  return { preview, receipt: (await memberships.activate(actor.context(), membershipId, confirmationFor(preview))).membership };
}

try {
  await cleanup();
  await seed();
  await startApp();
  const moneyBefore = await money();

  // 1. Authority: billing.membership.create at the session school, direct humans only; ids from routes are never authority.
  for (const actor of [NONE, MIXED]) {
    await refused(() => options(actor, people.adult), 403, undefined, `options refused for ${actor.subject.split('-').pop()}`);
    await refused(() => start(actor, people.adult, body(plans.tkd12)), 403, undefined, `start refused for ${actor.subject.split('-').pop()}`);
  }
  await refused(() => options(OTHER_SCHOOL, people.adult, { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => options(CREATOR, people.schoolB), 404, 'PERSON_MEMBERSHIP_NOT_FOUND', 'a school-B person through school A');
  await refused(() => start(CREATOR, people.schoolB, body(plans.tkd12)), 404, 'PERSON_MEMBERSHIP_NOT_FOUND', 'start for a school-B person through school A');
  await refused(() => options(CREATOR, people.adult, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, undefined, 'cross-site read');
  await refused(() => options(CREATOR, people.adult, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with a key');

  // 2. Options: payers, default payer, memberships and blockers.
  const adult = (await success(() => options(CREATOR, people.adult), 'adult options')).data;
  ok(adult.personId === people.adult && adult.schoolToday === today && adult.schoolTimezone === LA && adult.minor === false && adult.blockers.length === 0
    && adult.payers.length === 1 && adult.payers[0].relation === 'SELF' && adult.defaultPayerPersonId === people.adult && adult.payerProblem === null
    && adult.memberships.length === 0, 'adult: pays for themselves by default, no memberships');
  const child = (await success(() => options(CREATOR, people.child), 'child options')).data;
  ok(child.minor === true && child.payers.length === 2 && child.payers.every((p) => p.relation === 'GUARDIAN') && child.defaultPayerPersonId === people.guardianB,
    'minor: only the guardians may pay; the one billing contact is the default');
  const orphan = (await success(() => options(CREATOR, people.orphanMinor), 'orphan minor options')).data;
  ok(orphan.payers.length === 0 && orphan.payerProblem === 'NO_GUARDIAN' && orphan.defaultPayerPersonId === null, 'minor without a guardian: no payer');
  const unknown = (await success(() => options(CREATOR, people.unknownAge), 'unknown-age options')).data;
  ok(unknown.minor === false && unknown.defaultPayerPersonId === people.unknownAge, 'unknown birth date: the student may pay');
  ok(JSON.stringify((await success(() => options(CREATOR, people.noProfile), 'no-profile options')).data.blockers) === '["NO_STUDENT_RECORD"]', 'a contact without a student record is blocked');
  ok(JSON.stringify((await success(() => options(CREATOR, people.archived), 'archived options')).data.blockers) === '["CONTACT_ARCHIVED"]', 'an archived contact is blocked');

  // 3. Closed request validation before any write.
  for (const [label, patch] of [['extra key', { other: 1 }], ['personId in body', { personId: people.adult }], ['impossible date', { startDate: '2026-02-30' }],
    ['bad kind', { kind: 'UPGRADE' }], ['renew without target', { kind: 'RENEW' }], ['new with target', { renewsMembershipId: randomUUID() }],
    ['string version', { membershipPlanVersion: '1' }], ['wrong confirmation', { confirmation: 'yes' }], ['bad payer id', { payerPersonId: 'x' }]]) {
    await refused(() => start(CREATOR, people.adult, body(plans.tkd12, patch)), 400, undefined, `start validation: ${label}`);
  }
  await refused(() => start(CREATOR, people.adult, body(plans.tkd12), { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'start without a key');
  await refused(() => start(CREATOR, people.adult, body(plans.tkd12), { command: 'billing.membership.start_options.read' }), 403, undefined, 'start with the read command header');
  ok(await count('SELECT count(*)::int n FROM hon.memberships WHERE organization_id=$1', [ids.organization]) === 0, 'no membership after refused requests');

  // 4. Blockers.
  await refused(() => start(CREATOR, people.noProfile, body(plans.tkd12)), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'no student record', ['NO_STUDENT_RECORD']);
  await refused(() => start(CREATOR, people.archived, body(plans.tkd12)), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'archived contact', ['CONTACT_ARCHIVED']);
  await refused(() => start(CREATOR, people.adult, body(plans.off)), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'unavailable plan', ['PLAN_UNAVAILABLE']);
  await refused(() => start(CREATOR, people.adult, body(plans.closed)), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'plan in a cancelled program', ['PLAN_UNAVAILABLE']);
  await refused(() => start(CREATOR, people.adult, body(plans.schoolB)), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'school-B plan through school A', ['PLAN_UNAVAILABLE']);
  await refused(() => start(CREATOR, people.adult, body(plans.tkd12, { membershipPlanVersion: 2 })), 409, 'MEMBERSHIP_PLAN_VERSION_STALE', 'stale plan version');
  await refused(() => start(CREATOR, people.adult, body(plans.tkd12, { startDate: addDays(today, 800) })), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'start too far ahead', ['START_DATE_OUT_OF_RANGE']);
  await refused(() => start(CREATOR, people.orphanMinor, body(plans.tkd12)), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'minor without a guardian', ['PAYER_NO_GUARDIAN']);
  await refused(() => start(CREATOR, people.child, body(plans.tkd12, { payerPersonId: people.child })), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'a minor paying', ['PAYER_NOT_ALLOWED']);
  await refused(() => start(CREATOR, people.child, body(plans.tkd12, { payerPersonId: people.stranger })), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'a payer outside the family', ['PAYER_NOT_ALLOWED']);
  await refused(() => start(CREATOR, people.euroPayer, body(plans.tkd12)), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'payer account in another currency', ['PLAN_CURRENCY_MISMATCH']);
  await refused(() => start(CREATOR, people.adult, body(plans.tkd12, { kind: 'RENEW', renewsMembershipId: randomUUID() })), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'renew of an unknown membership', ['RENEWAL_NOT_ALLOWED']);
  ok(await count('SELECT count(*)::int n FROM hon.memberships WHERE organization_id=$1', [ids.organization]) === 0
    && await count('SELECT count(*)::int n FROM hon.billing_accounts WHERE organization_id=$1', [ids.organization]) === 1, 'blocked starts write nothing (no membership, no account)');

  // 5. New membership: one DRAFT bound to the exact plan version, the plan's term, a CANONICAL account created in its currency.
  const key = randomUUID();
  const first = await success(() => start(CREATOR, people.adult, body(plans.tkd12), { key }), 'new Taekwondo membership', 201);
  const r = first.data;
  ok(first.meta.replayed === false && r.state === 'DRAFT' && r.kind === 'NEW' && r.renewsMembershipId === null && r.membershipPlanId === plans.tkd12 && r.membershipPlanVersion === 1
    && r.planCode === 'TKD-12' && r.programId === P.taekwondo && r.payerPersonId === people.adult && r.startDate === today && r.endDate === addDays(addMonths(today, 12), -1), 'new receipt');
  const row = (await sql(`SELECT m.*, a.responsible_person_id, a.currency::text currency, a.account_classification, (m.term_started_at AT TIME ZONE $2)::text local_start,
      (m.term_ends_at AT TIME ZONE $2)::text local_end FROM hon.memberships m JOIN hon.billing_accounts a ON a.id=m.billing_account_id WHERE m.id=$1`, [r.membershipId, LA])).rows[0];
  ok(row.state === 'DRAFT' && row.version === 1 && row.participant_person_id === people.adult && row.responsible_person_id === people.adult && row.currency === 'USD'
    && row.account_classification === 'CANONICAL' && row.billing_account_id === r.billingAccountId && row.local_start === `${today} 00:00:00`
    && row.local_end === `${addMonths(today, 12)} 00:00:00`, 'DRAFT row: school-timezone day bounds, CANONICAL USD account for the adult');
  ok(await count('SELECT count(*)::int n FROM hon.membership_plan_selections WHERE membership_id=$1 AND plan_id=$2 AND plan_version=1 AND actor_principal_id=$3', [r.membershipId, plans.tkd12, CREATOR.principal]) === 1,
    'plan selection binds the exact version');
  const startRow = (await sql('SELECT * FROM hon.person_membership_starts WHERE membership_id=$1', [r.membershipId])).rows[0];
  ok(startRow.kind === 'NEW' && startRow.program_id === P.taekwondo && startRow.actor_principal_id === CREATOR.principal && startRow.idempotency_key === key
    && isDeepStrictEqual(startRow.receipt, r), 'card start provenance row holds the receipt');
  const audit = (await sql("SELECT * FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.membership.create'", [r.membershipId])).rows;
  const outbox = (await sql("SELECT * FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.membership.drafted'", [r.membershipId])).rows;
  ok(audit.length === 1 && audit[0].source === 'HUMAN_UI' && audit[0].next_state.operation === 'CARD_MEMBERSHIP_START' && !JSON.stringify(audit[0].next_state).includes('Ada'), 'audit: ids and codes only');
  ok(outbox.length === 1 && outbox[0].payload.executionAllowed === false && outbox[0].payload.humanOnly === true && !JSON.stringify(outbox[0].payload).includes('Ada'), 'outbox: inert, ids only');
  const replay = await success(() => start(CREATOR, people.adult, body(plans.tkd12), { key }), 'exact replay');
  ok(replay.meta.replayed === true && isDeepStrictEqual(replay.data, r), 'exact replay returns the stored receipt');
  await refused(() => start(CREATOR, people.adult, body(plans.tkd12, { startDate: addDays(today, 1) }), { key }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another body');
  ok(await count('SELECT count(*)::int n FROM hon.memberships WHERE participant_person_id=$1', [people.adult]) === 1, 'still one membership after replay');

  // 6. One per program: a second DRAFT in Taekwondo is refused; Jiu-jitsu (another program) and a no-program plan are not.
  await refused(() => start(CREATOR, people.adult, body(plans.tkdOpen, { startDate: addDays(today, 400) })), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'second DRAFT in the same program', ['DRAFT_IN_PROGRAM']);
  const bjj = (await success(() => start(CREATOR, people.adult, body(plans.bjj6)), 'Jiu-jitsu membership', 201)).data;
  ok(bjj.programId === P.bjj && bjj.billingAccountId === r.billingAccountId && bjj.endDate === addDays(addMonths(today, 6), -1), 'second program reuses the CANONICAL account; 6-month term');
  const general = (await success(() => start(CREATOR, people.adult, body(plans.general)), 'no-program membership', 201)).data;
  ok(general.programId === null && general.endDate === null && general.termEndsAt === null, 'open-ended plan without a program');

  // 7. The DRAFT starts through the unchanged 0177 gate: plan bound (no free-text warning), source GENERIC_LEGACY.
  const { preview, receipt: activated } = await activate(OWN, r.membershipId);
  ok(!preview.warnings.some((w) => w.code === 'LEGACY_FREE_TEXT_PLAN') && preview.blocks.length === 0 && preview.proposedDates.startDate === today
    && preview.proposedDates.endDate === r.endDate, 'activation preview: bound plan, the card dates suggested');
  ok(activated.state === 'ACTIVE' && activated.membershipSource === 'GENERIC_LEGACY', 'started through 0177 as GENERIC_LEGACY');

  // 8. One per program against a current membership: overlapping Taekwondo is refused, also when open-ended.
  await refused(() => start(CREATOR, people.adult, body(plans.tkdOpen, { startDate: addDays(today, 30) })), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'overlaps the current Taekwondo membership',
    ['OVERLAPS_CURRENT_MEMBERSHIP']);

  // 9. Renew: offered for a membership with an end; starts on or after it, same program, once.
  let opts = (await success(() => options(CREATOR, people.adult), 'options after starting')).data;
  const tkdItem = opts.memberships.find((x) => x.membershipId === r.membershipId);
  ok(opts.memberships.length === 3 && tkdItem.state === 'ACTIVE' && tkdItem.programId === P.taekwondo && tkdItem.startDate === today && tkdItem.endDate === r.endDate
    && tkdItem.renewable === true && tkdItem.renewStartDate === addMonths(today, 12), 'the current Taekwondo membership is renewable from the day after it ends');
  ok(opts.memberships.find((x) => x.membershipId === general.membershipId).renewable === false, 'an open-ended membership has nothing to renew');
  const renewBody = (patch = {}) => body(plans.tkd12, { kind: 'RENEW', renewsMembershipId: r.membershipId, startDate: tkdItem.renewStartDate, ...patch });
  await refused(() => start(CREATOR, people.adult, renewBody({ startDate: addDays(tkdItem.renewStartDate, -1) })), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'renewal starting before the end',
    ['RENEWAL_NOT_ALLOWED', 'OVERLAPS_CURRENT_MEMBERSHIP']);
  await refused(() => start(CREATOR, people.adult, renewBody({ membershipPlanId: plans.general })), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'renewal into another program group',
    ['RENEWAL_NOT_ALLOWED', 'DRAFT_IN_PROGRAM']);
  await refused(() => start(CREATOR, people.unknownAge, renewBody()), 409, 'PERSON_MEMBERSHIP_BLOCKED', "renewal of someone else's membership", ['RENEWAL_NOT_ALLOWED']);
  const renewal = (await success(() => start(CREATOR, people.adult, renewBody()), 'renew Taekwondo', 201)).data;
  ok(renewal.kind === 'RENEW' && renewal.renewsMembershipId === r.membershipId && renewal.startDate === addMonths(today, 12) && renewal.programId === P.taekwondo, 'renewal receipt');
  ok((await sql('SELECT kind, renews_membership_id FROM hon.person_membership_starts WHERE membership_id=$1', [renewal.membershipId])).rows[0].renews_membership_id === r.membershipId, 'renewal link stored');
  opts = (await success(() => options(CREATOR, people.adult), 'options after renewing')).data;
  ok(opts.memberships.find((x) => x.membershipId === r.membershipId).renewable === false, 'a renewed membership is not offered again');
  await refused(() => start(CREATOR, people.adult, renewBody()), 409, 'PERSON_MEMBERSHIP_BLOCKED', 'a second renewal', ['RENEWAL_NOT_ALLOWED', 'DRAFT_IN_PROGRAM']);

  // 10. The trigger: starting the renewal on dates that overlap the current membership is refused and leaves the DRAFT unchanged.
  let overlapError = null;
  try { await activate(OWN, renewal.membershipId, { startDate: addDays(today, 100), endDate: addDays(today, 400) }); } catch (error) { overlapError = error; }
  ok(overlapError?.getResponse?.().code === 'MEMBERSHIP_PROGRAM_OVERLAP' && overlapError.getStatus() === 409, `activation onto overlapping dates refused by the one-per-program trigger (${JSON.stringify(overlapError?.getResponse?.())})`);
  ok((await sql('SELECT state::text s, version FROM hon.memberships WHERE id=$1', [renewal.membershipId])).rows[0].s === 'DRAFT', 'the renewal stays a DRAFT');
  const renewed = await activate(OWN, renewal.membershipId);
  ok(renewed.receipt.state === 'ACTIVE', 'the renewal starts on its own dates, right after the first membership ends');
  // Any other writer is caught too: with only the 0177 transition guard lifted (fixture writer), the trigger still refuses.
  await rejectsSql(admin, () => membershipFixtureStatement(admin, "UPDATE hon.memberships SET term_ends_at=term_ends_at+interval '30 days' WHERE id=$1", [r.membershipId]),
    /MEMBERSHIP_PROGRAM_OVERLAP/, 'extending the first membership into its renewal is refused');
  await rejectsSql(admin, () => membershipFixtureStatement(admin, "UPDATE hon.memberships SET term_started_at=term_started_at-interval '30 days' WHERE id=$1", [renewal.membershipId]),
    /MEMBERSHIP_PROGRAM_OVERLAP/, 'moving the renewal back into the first membership is refused');

  // 11. Guardians pay for a minor: the billing contact by default, or the guardian chosen.
  const kid = (await success(() => start(CREATOR, people.child, body(plans.tkd12)), 'child Taekwondo', 201)).data;
  const kidBjj = (await success(() => start(CREATOR, people.child, body(plans.bjj6, { payerPersonId: people.guardianA })), 'child Jiu-jitsu paid by the other guardian', 201)).data;
  ok(kid.payerPersonId === people.guardianB && kidBjj.payerPersonId === people.guardianA && kid.billingAccountId !== kidBjj.billingAccountId, 'each guardian pays from their own CANONICAL account');
  ok(await count("SELECT count(*)::int n FROM hon.billing_accounts WHERE responsible_person_id = ANY($1::uuid[]) AND account_classification='CANONICAL' AND currency='USD'",
    [[people.guardianA, people.guardianB]]) === 2, 'one CANONICAL account per guardian');
  const kidOptions = (await success(() => options(CREATOR, people.child), 'child options after starting')).data;
  ok(kidOptions.memberships.length === 2 && kidOptions.memberships.every((x) => x.state === 'DRAFT'), 'the card lists both DRAFTs');

  // 12. Live authority: a revoked grant is refused at once.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1', [CREATOR.grants[0], OWN.principal]);
  await refused(() => options(CREATOR, people.unknownAge), 403, undefined, 'options after the grant is revoked');
  await refused(() => start(CREATOR, people.unknownAge, body(plans.general)), 403, undefined, 'start after the grant is revoked');

  // 13. Runtime ACL and immutability.
  const acl = (await sql(`SELECT p.oid::regprocedure::text sig, has_function_privilege($1,p.oid,'EXECUTE') can FROM pg_proc p
    WHERE p.pronamespace='hon'::regnamespace AND p.proname IN ('read_person_membership_start','start_person_membership','require_person_membership_actor','person_membership_start_facts',
      'person_membership_start_item','membership_program_group','guard_person_membership_overlap','guard_person_membership_start') ORDER BY 1`, [CRM_CLOSE_RUNTIME_ROLE])).rows;
  ok(acl.length === 8 && acl.filter((x) => x.can).map((x) => x.sig).sort().join() === 'hon.read_person_membership_start(text,jsonb),hon.start_person_membership(text,jsonb,text,uuid,uuid)',
    `runtime executes only the two entry points: ${JSON.stringify(acl)}`);
  ok(!(await sql("SELECT has_table_privilege($1,'hon.person_membership_starts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') p", [CRM_CLOSE_RUNTIME_ROLE])).rows[0].p
    && (await sql("SELECT relrowsecurity AND relforcerowsecurity f FROM pg_class WHERE oid='hon.person_membership_starts'::regclass")).rows[0].f, 'private table with forced RLS');
  await rejectsSql(runtime, () => runtime.query('SELECT count(*) FROM hon.person_membership_starts'), /permission denied/, 'runtime cannot read the table');
  await rejectsSql(runtime, () => runtime.query('SELECT hon.membership_program_group($1)', [r.membershipId]), /permission denied/, 'runtime cannot call a private helper');
  await rejectsSql(admin, () => sql("UPDATE hon.person_membership_starts SET kind='NEW' WHERE membership_id=$1", [renewal.membershipId]), /IMMUTABLE_PERSON_MEMBERSHIP_START/, 'starts are immutable');
  await rejectsSql(admin, () => sql('DELETE FROM hon.person_membership_starts WHERE membership_id=$1', [renewal.membershipId]), /IMMUTABLE_PERSON_MEMBERSHIP_START/, 'starts are never deleted');

  // 14. No money moved.
  ok(JSON.stringify(await money()) === JSON.stringify(moneyBefore), 'no invoice, payment attempt or schedule was created');
  console.log(`PASS: person membership start (0398), ${checks} checks.`);
} finally {
  await app?.close();
  await cleanup().catch((error) => console.error('cleanup failed', error.message));
  await runtime.end();
  await admin.end();
}
