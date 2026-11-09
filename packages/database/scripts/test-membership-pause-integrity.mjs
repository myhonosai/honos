/**
 * Membership pause, cancellation and manual refund records proof (0224) over signed HTTP (HON session cookie ->
 * HonIdentityGuard + human UI guards + global ValidationPipe + HonExceptionFilter -> controllers -> protected definer
 * functions on the restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture only.
 * Confirmed memberships come from the real two-step activation service. Synthetic names only; no money moves.
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
const { MembershipPauseController } = await load('billing/membership-pause.controller.js');
const { MembershipPauseService } = await load('billing/membership-pause.service.js');
const { MembershipController } = await load('billing/membership.controller.js');
const { BillingAccountService } = await load('billing/billing-account.service.js');
const { MembershipService } = await load('billing/membership.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-membership-pause', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();
const services = { accounts: new BillingAccountService(database), memberships: new MembershipService(database), pauses: new MembershipPauseService(database) };

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [MembershipPauseController, MembershipController],
    providers: [HonIdentityGuard, HonIdentityService, MembershipPauseService, MembershipService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

const COMMAND = { pause: 'billing.membership.pause', resume: 'billing.membership.resume', 'refund-records': 'billing.membership.refund.record',
  policy: 'billing.membership.pause_policy.set', cancel: 'billing.membership.cancel' };
function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/billing/${path}`);
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
const pausePolicy = (actor, body, options = {}) => call(actor, 'POST', 'membership-pause-policy', { body, command: COMMAND.policy, ...options });
const readPolicy = (actor, options = {}) => call(actor, 'GET', 'membership-pause-policy', options);
const pause = (actor, membershipId, body, options = {}) => call(actor, 'POST', `memberships/${membershipId}/pause`, { body, command: COMMAND.pause, ...options });
const resume = (actor, membershipId, body, options = {}) => call(actor, 'POST', `memberships/${membershipId}/resume`, { body, command: COMMAND.resume, ...options });
const refund = (actor, membershipId, body, options = {}) => call(actor, 'POST', `memberships/${membershipId}/refund-records`, { body, command: COMMAND['refund-records'], ...options });
const history = (actor, membershipId, options = {}) => call(actor, 'GET', `memberships/${membershipId}/pauses-and-refunds`, options);
const cancel = (actor, membershipId, body, options = {}) => call(actor, 'POST', `memberships/${membershipId}/cancel`, { body, command: COMMAND.cancel, ...options });

async function success(read, label, { noStore = true } = {}) {
  const { status, body, headers } = await read();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  // The 0057 cancel route predates the no-store header and is unchanged here.
  if (noStore) ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
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

// Disposable-fixture cleanup only (as in the U6 proof).
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
    const left = (await sql(`SELECT count(*)::int n FROM hon.memberships WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left memberships behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`membership-pause-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`membership-pause-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`membership-pause-${ids.organization}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

const allPermissions = (await sql('SELECT code FROM hon.permissions ORDER BY code')).rows.map((row) => row.code);
for (const code of ['billing.membership.pause', 'billing.membership.pause_policy.manage', 'billing.membership.refund.record']) {
  const row = (await sql('SELECT is_sensitive, is_staff_assignable FROM hon.permissions WHERE code=$1', [code])).rows[0];
  ok(row?.is_sensitive === true && row?.is_staff_assignable === true, `${code} exists, sensitive and staff-assignable`);
}
async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roles, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `membership-pause-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Membership Pause Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Membership Pause Staff')", [principal, user]);
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
async function person(school, givenName, org = ids.organization) {
  const id = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,'Pause')", [id, org, school, givenName]);
  return id;
}

let OWN, PAUSER, POLICY, REFUNDER, CANCELLER, READER, NONE, MIXED, OTHER_SCHOOL, OTHER_ORG;
const m = {};
let today;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

async function activeMembership(actor, label) {
  const participant = await person(actor.school, label, actor.org);
  const billingAccountId = (await services.accounts.create(actor.context(), { responsiblePersonId: participant, currency: 'USD' })).account.id;
  const { membership } = await services.memberships.createDraft(actor.context(), { billingAccountId, participantPersonId: participant, planCode: `PLAN-${label.toUpperCase()}` });
  const preview = await services.memberships.previewActivation(actor.read(), membership.id, { startDate: addDays(today, -60), endDate: addDays(today, 300) });
  await services.memberships.activate(actor.context(), membership.id, confirmationFor(preview));
  return membership.id;
}

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Membership Pause Org','Membership Pause Org'),($2,'Membership Pause Other Org','Membership Pause Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Membership Pause ${slug}`, `membership-pause-${slug}-${school.slice(0, 8)}`, LA]);
  }
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  PAUSER = await staff('pauser', [await role(ids.organization, ['billing.membership.pause'])]);
  POLICY = await staff('policy', [await role(ids.organization, ['billing.membership.pause_policy.manage'])]);
  REFUNDER = await staff('refunder', [await role(ids.organization, ['billing.membership.refund.record'])]);
  CANCELLER = await staff('canceller', [await role(ids.organization, ['billing.membership.cancel'])]);
  READER = await staff('reader', [await role(ids.organization, ['billing.membership.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'reporting.view', 'billing.membership.create', 'billing.membership.activate'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['billing.membership.pause']), await role(ids.organization, ['billing.membership.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
  const otherOwner = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
  OTHER_ORG = otherOwner;
  for (const label of ['One', 'Two', 'Three', 'Four', 'Five', 'Six']) m[label] = await activeMembership(OWN, label);
  m.schoolB = await activeMembership(OTHER_SCHOOL, 'SchoolB');
  m.otherOrg = await activeMembership(OTHER_ORG, 'OtherOrg');
  // Legacy FROZEN (paused outside HON before 0224): no pause row.
  const participant = await person(ids.schoolA, 'Legacy');
  const account = (await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4) RETURNING id', [randomUUID(), ids.organization, ids.schoolA, participant])).rows[0].id;
  m.legacy = randomUUID();
  await sql('BEGIN');
  await membershipFixtureStatement(admin, `INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
    VALUES($1,$2,$3,$4,$5,'LEGACY','FROZEN','2026-01-01T08:00:00Z','2026-12-31T08:00:00Z')`, [m.legacy, ids.organization, ids.schoolA, account, participant]);
  await sql('COMMIT');
  // Four has an ACTIVE payment schedule (would keep charging): pausing it must wait for a billing arrangement.
  await sql("INSERT INTO hon.membership_payment_schedules(organization_id,school_id,membership_id,frequency,amount_minor,currency,status) VALUES($1,$2,$3,'MONTHLY',9900,'USD','ACTIVE')",
    [ids.organization, ids.schoolA, m.Four]);
  // Five already used 15 paused days this year (fixture writer, closed pause row from an earlier policy-free era).
  await sql('BEGIN');
  await sql('ALTER TABLE hon.membership_pauses DISABLE TRIGGER USER');
  await sql("INSERT INTO hon.school_membership_pause_policies(organization_id,school_id,version,pauses_allowed,max_pause_days,max_paused_days_per_year,actor_principal_id) VALUES($1,$2,1,true,30,40,$3)",
    [ids.organization, ids.schoolA, OWN.principal]);
  await sql(`INSERT INTO hon.membership_pauses(organization_id,school_id,membership_id,policy_version,starts_on,planned_resume_on,pause_reason,paused_by_principal_id,
      pause_prior_version,pause_next_version,ended_kind,ended_on,ended_by_principal_id,ended_at,end_prior_version,end_next_version)
    VALUES($1,$2,$3,1,$4::date,$5::date,'Earlier injury',$6,90,91,'RESUMED',$5::date,$6,clock_timestamp(),91,92)`,
    [ids.organization, ids.schoolA, m.Five, addDays(today, -20), addDays(today, -5), OWN.principal]);
  await sql('ALTER TABLE hon.membership_pauses ENABLE TRIGGER USER');
  await sql('COMMIT');
}

const membership = async (id) => (await sql('SELECT state::text, version, term_started_at, term_ends_at FROM hon.memberships WHERE id=$1', [id])).rows[0];
const pausesOf = async (id) => (await sql('SELECT * FROM hon.membership_pauses WHERE membership_id=$1 ORDER BY paused_at, id', [id])).rows;
const money = async () => (await sql(`SELECT (SELECT count(*)::int FROM hon.invoices WHERE organization_id=$1) invoices,
  (SELECT count(*)::int FROM hon.payment_attempts WHERE organization_id=$1) attempts,
  (SELECT md5(string_agg(s::text,'|' ORDER BY s.id)) FROM hon.membership_payment_schedules s WHERE organization_id=$1) schedules`, [ids.organization])).rows[0];

try {
  await cleanup();
  await seed();
  // The seeded version-1 policy predates the HTTP flow; the flow starts from a school with no policy at all.
  await sql('BEGIN'); await sql('ALTER TABLE hon.school_membership_pause_policies DISABLE TRIGGER USER');
  await sql('ALTER TABLE hon.membership_pauses DISABLE TRIGGER USER');
  const earlier = (await sql('SELECT * FROM hon.membership_pauses WHERE membership_id=$1', [m.Five])).rows[0];
  await sql('DELETE FROM hon.membership_pauses WHERE membership_id=$1', [m.Five]);
  await sql('DELETE FROM hon.school_membership_pause_policies WHERE school_id=$1', [ids.schoolA]);
  await sql('ALTER TABLE hon.membership_pauses ENABLE TRIGGER USER'); await sql('ALTER TABLE hon.school_membership_pause_policies ENABLE TRIGGER USER'); await sql('COMMIT');
  await startApp();
  const moneyBefore = await money();

  // 1. No policy yet: reads say so, and pausing is not offered.
  const none = await success(() => readPolicy(PAUSER), 'policy read without a policy');
  ok(none.data.policy === null && none.data.localToday === today, 'no policy, school-local today');
  await refused(() => pause(PAUSER, m.One, { expectedVersion: 2, resumeOn: addDays(today, 5), pauseReason: 'Travel' }), 409, 'MEMBERSHIP_PAUSE_NOT_OFFERED', 'pause before any policy');

  // 2. Policy: only the policy manager sets it; closed validation; versioned with exact replay.
  const goodPolicy = { expectedVersion: 0, pausesAllowed: true, maxPauseDays: 30, maxPausedDaysPerYear: 40, holdFee: { amountMinor: 1500, currency: 'USD' } };
  for (const actor of [PAUSER, REFUNDER, READER, NONE, MIXED]) await refused(() => pausePolicy(actor, goodPolicy), 403, undefined, `policy set refused for ${actor.subject.split('-').pop()}`);
  for (const [label, patch] of [['per pause above per year', { maxPauseDays: 41 }], ['days above 365', { maxPauseDays: 400, maxPausedDaysPerYear: 400 }],
    ['zero days', { maxPauseDays: 0 }], ['limits while off', { pausesAllowed: false }], ['fee while off', { pausesAllowed: false, maxPauseDays: null, maxPausedDaysPerYear: null }],
    ['missing year cap', { maxPausedDaysPerYear: null }], ['bad currency', { holdFee: { amountMinor: 1, currency: 'usd' } }], ['negative fee', { holdFee: { amountMinor: -1, currency: 'USD' } }],
    ['extra key', { other: 1 }], ['string days', { maxPauseDays: '30' }]]) {
    await refused(() => pausePolicy(POLICY, { ...goodPolicy, ...patch }), 400, undefined, `policy validation: ${label}`);
  }
  await refused(() => pausePolicy(POLICY, { ...goodPolicy, expectedVersion: 1 }), 409, 'VERSION_CONFLICT', 'policy stale expected version');
  const policyKey = randomUUID();
  const set1 = await success(() => pausePolicy(POLICY, goodPolicy, { key: policyKey }), 'policy v1');
  ok(set1.data.version === 1 && set1.data.maxPauseDays === 30 && set1.data.maxPausedDaysPerYear === 40 && set1.data.holdFee.amountMinor === 1500 && set1.meta.replayed === false, 'policy v1 stored');
  const replay1 = await success(() => pausePolicy(POLICY, goodPolicy, { key: policyKey }), 'policy v1 replay');
  ok(replay1.meta.replayed === true && JSON.stringify(replay1.data) === JSON.stringify(set1.data), 'policy exact replay returns the stored receipt');
  await refused(() => pausePolicy(POLICY, { ...goodPolicy, maxPauseDays: 10 }, { key: policyKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'policy key reused for another body');
  ok((await sql('SELECT count(*)::int n FROM hon.school_membership_pause_policies WHERE school_id=$1', [ids.schoolA])).rows[0].n === 1, 'exactly one policy version after replay');
  const read1 = await success(() => readPolicy(READER), 'policy read by membership reader');
  ok(JSON.stringify(read1.data.policy) === JSON.stringify(set1.data), 'policy read equals the stored version');
  await refused(() => readPolicy(NONE), 403, undefined, 'policy read refused without an admitting permission');
  ok((await success(() => readPolicy(OTHER_SCHOOL), 'school B policy read')).data.policy === null, 'school B has its own (absent) policy');
  // Restore the earlier closed pause of Five (15 days in the last year) now that a policy version exists.
  await sql('BEGIN'); await sql('ALTER TABLE hon.membership_pauses DISABLE TRIGGER USER');
  await sql(`INSERT INTO hon.membership_pauses(id,organization_id,school_id,membership_id,policy_version,starts_on,planned_resume_on,pause_reason,paused_by_principal_id,paused_at,
      pause_prior_version,pause_next_version,ended_kind,ended_on,ended_by_principal_id,ended_at,end_prior_version,end_next_version)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [earlier.id, earlier.organization_id, earlier.school_id, earlier.membership_id, earlier.starts_on,
    earlier.planned_resume_on, earlier.pause_reason, earlier.paused_by_principal_id, earlier.paused_at, earlier.pause_prior_version, earlier.pause_next_version,
    earlier.ended_kind, earlier.ended_on, earlier.ended_by_principal_id, earlier.ended_at, earlier.end_prior_version, earlier.end_next_version]);
  await sql('ALTER TABLE hon.membership_pauses ENABLE TRIGGER USER'); await sql('COMMIT');

  // 3. Pause One: ACTIVE -> FROZEN with one open pause row, term dates unchanged, audit and inert outbox, exact replay.
  const before = await membership(m.One);
  for (const actor of [READER, NONE, MIXED, REFUNDER, CANCELLER, POLICY]) {
    await refused(() => pause(actor, m.One, { expectedVersion: before.version, resumeOn: addDays(today, 10), pauseReason: 'Travel' }), 403, undefined, `pause refused for ${actor.subject.split('-').pop()}`);
  }
  await refused(() => pause(OTHER_SCHOOL, m.One, { expectedVersion: before.version, resumeOn: addDays(today, 10), pauseReason: 'Travel' }, { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => pause(PAUSER, m.schoolB, { expectedVersion: 2, resumeOn: addDays(today, 10), pauseReason: 'Travel' }), 404, 'BILLING_MEMBERSHIP_NOT_FOUND', 'school-B membership through school A');
  await refused(() => pause(PAUSER, m.otherOrg, { expectedVersion: 2, resumeOn: addDays(today, 10), pauseReason: 'Travel' }), 404, 'BILLING_MEMBERSHIP_NOT_FOUND', 'other-organization membership');
  for (const [label, body] of [['missing reason', { expectedVersion: before.version, resumeOn: addDays(today, 10) }], ['blank reason', { expectedVersion: before.version, resumeOn: addDays(today, 10), pauseReason: ' x' }],
    ['impossible date', { expectedVersion: before.version, resumeOn: '2026-02-30', pauseReason: 'Travel' }], ['extra key', { expectedVersion: before.version, resumeOn: addDays(today, 10), pauseReason: 'Travel', holdFee: 0 }],
    ['control character', { expectedVersion: before.version, resumeOn: addDays(today, 10), pauseReason: 'Tra\u0007vel' }]]) {
    await refused(() => pause(PAUSER, m.One, body), 400, undefined, `pause validation: ${label}`);
  }
  await refused(() => pause(PAUSER, m.One, { expectedVersion: before.version, resumeOn: today, pauseReason: 'Travel' }), 422, 'MEMBERSHIP_PAUSE_TOO_LONG', 'resume date today');
  await refused(() => pause(PAUSER, m.One, { expectedVersion: before.version, resumeOn: addDays(today, 31), pauseReason: 'Travel' }), 422, 'MEMBERSHIP_PAUSE_TOO_LONG', 'longer than one pause may last');
  await refused(() => pause(PAUSER, m.One, { expectedVersion: before.version + 1, resumeOn: addDays(today, 10), pauseReason: 'Travel' }), 409, 'VERSION_CONFLICT', 'stale membership version');
  const pauseKey = randomUUID();
  const paused = await success(() => pause(PAUSER, m.One, { expectedVersion: before.version, resumeOn: addDays(today, 10), pauseReason: 'Travel' }, { key: pauseKey }), 'pause One');
  const afterPause = await membership(m.One);
  ok(paused.data.membershipState === 'FROZEN' && paused.data.membershipVersion === before.version + 1 && paused.data.startsOn === today
    && paused.data.plannedResumeOn === addDays(today, 10) && paused.data.endedKind === null && paused.data.holdFee.amountMinor === 1500 && paused.data.policyVersion === 1, 'pause receipt');
  ok(afterPause.state === 'FROZEN' && afterPause.version === before.version + 1 && +afterPause.term_started_at === +before.term_started_at && +afterPause.term_ends_at === +before.term_ends_at,
    'One is FROZEN at version+1 with unchanged term dates');
  const rowsOne = await pausesOf(m.One);
  ok(rowsOne.length === 1 && rowsOne[0].ended_kind === null && rowsOne[0].paused_by_principal_id === PAUSER.principal && rowsOne[0].pause_prior_version === before.version, 'one open pause row by the pauser');
  const audit = (await sql("SELECT prior_state, next_state FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.membership.pause'", [m.One])).rows;
  const outbox = (await sql("SELECT payload FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.membership.paused'", [m.One])).rows;
  ok(audit.length === 1 && audit[0].prior_state.state === 'ACTIVE' && outbox.length === 1 && outbox[0].payload.pauseId === paused.data.pauseId, 'one audit event and one inert outbox event');
  const replayPause = await success(() => pause(PAUSER, m.One, { expectedVersion: before.version, resumeOn: addDays(today, 10), pauseReason: 'Travel' }, { key: pauseKey }), 'pause One replay');
  ok(replayPause.meta.replayed === true && JSON.stringify(replayPause.data) === JSON.stringify(paused.data) && (await pausesOf(m.One)).length === 1, 'pause exact replay, no second row');
  await refused(() => pause(PAUSER, m.One, { expectedVersion: before.version, resumeOn: addDays(today, 11), pauseReason: 'Travel' }, { key: pauseKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'pause key reused');
  await refused(() => pause(PAUSER, m.One, { expectedVersion: afterPause.version, resumeOn: addDays(today, 10), pauseReason: 'Again' }), 409, 'MEMBERSHIP_NOT_ACTIVE', 'pausing a paused membership');

  // 4. Per-year limit (Five already used 15 days): 25 more is allowed, 26 is not; an ACTIVE payment schedule blocks.
  const five = await membership(m.Five);
  await refused(() => pause(PAUSER, m.Five, { expectedVersion: five.version, resumeOn: addDays(today, 26), pauseReason: 'Surgery' }), 422, 'MEMBERSHIP_PAUSE_YEARLY_LIMIT', 'over the paused days per year');
  await success(() => pause(PAUSER, m.Five, { expectedVersion: five.version, resumeOn: addDays(today, 25), pauseReason: 'Surgery' }), 'pause Five exactly to the yearly cap');
  const four = await membership(m.Four);
  await refused(() => pause(PAUSER, m.Four, { expectedVersion: four.version, resumeOn: addDays(today, 5), pauseReason: 'Exams' }), 409, 'MEMBERSHIP_PAUSE_REQUIRES_BILLING_ARRANGEMENT', 'active payment schedule');
  ok((await membership(m.Four)).state === 'ACTIVE' && (await pausesOf(m.Four)).length === 0, 'Four unchanged');

  // 5. Resume One: FROZEN -> ACTIVE, pause closed RESUMED today, dates unchanged; resume of an ACTIVE membership refused.
  await refused(() => resume(READER, m.One, { expectedVersion: afterPause.version }), 403, undefined, 'resume refused for reader');
  await refused(() => resume(PAUSER, m.One, { expectedVersion: afterPause.version }, { command: COMMAND.pause }), 403, 'HUMAN_UI_REQUIRED', 'pause command header on resume');
  const resumed = await success(() => resume(PAUSER, m.One, { expectedVersion: afterPause.version, resumeReason: 'Back early' }), 'resume One');
  const afterResume = await membership(m.One);
  ok(resumed.data.membershipState === 'ACTIVE' && resumed.data.endedKind === 'RESUMED' && resumed.data.endedOn === today && resumed.data.endReason === 'Back early', 'resume receipt');
  ok(afterResume.state === 'ACTIVE' && afterResume.version === afterPause.version + 1 && +afterResume.term_ends_at === +before.term_ends_at, 'One ACTIVE again, term dates unchanged');
  await refused(() => resume(PAUSER, m.One, { expectedVersion: afterResume.version }), 409, 'MEMBERSHIP_NOT_PAUSED', 'resume an ACTIVE membership');

  // 6. Immediate cancellation (P3): of a paused membership closes its pause as CANCELLED; ACTIVE cancellation unchanged.
  const paused2 = await success(() => pause(PAUSER, m.One, { expectedVersion: afterResume.version, resumeOn: addDays(today, 3), pauseReason: 'Second pause' }), 'pause One again');
  ok(paused2.data.pauseId !== paused.data.pauseId, 'a second pause is a new row');
  const frozen = await membership(m.One);
  const cancelled = await success(() => cancel(CANCELLER, m.One, { expectedVersion: frozen.version, cancellationReason: 'Moving away' }), 'cancel paused One', { noStore: false });
  const afterCancel = await membership(m.One);
  ok(cancelled.data.state === 'CANCELLED' && afterCancel.state === 'CANCELLED' && afterCancel.version === frozen.version + 1 && +afterCancel.term_ends_at === +before.term_ends_at, 'One CANCELLED immediately');
  const closed = (await pausesOf(m.One)).at(-1);
  ok(closed.ended_kind === 'CANCELLED' && closed.ended_by_principal_id === CANCELLER.principal && closed.end_reason === 'Moving away', 'its open pause closed as CANCELLED');
  const cancelAudit = (await sql("SELECT prior_state, next_state FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.membership.cancel'", [m.One])).rows;
  ok(cancelAudit.length === 1 && cancelAudit[0].prior_state.state === 'FROZEN' && cancelAudit[0].next_state.endedPauseId === closed.id, 'cancel audit records the paused prior state');
  const six = await membership(m.Six);
  await refused(() => cancel(CANCELLER, m.Six, { expectedVersion: six.version, cancellationReason: 'No marker' }, { command: null }), 403, 'HUMAN_UI_REQUIRED', 'cancel without its command header');
  await refused(() => cancel(CANCELLER, m.Six, { expectedVersion: six.version, cancellationReason: 'Wrong marker' }, { command: COMMAND.pause }), 403, 'HUMAN_UI_REQUIRED', 'pause command header on cancel');
  const cancelledSix = await success(() => cancel(CANCELLER, m.Six, { expectedVersion: six.version, cancellationReason: 'Schedule change' }), 'cancel ACTIVE Six', { noStore: false });
  ok(cancelledSix.data.state === 'CANCELLED' && Object.keys(cancelledSix.data).sort().join(',') === 'billingAccountId,cancellationReason,createdAt,id,participantPersonId,planCode,state,version', 'ACTIVE cancellation keeps its public contract');
  await refused(() => cancel(CANCELLER, m.Six, { expectedVersion: six.version + 1, cancellationReason: 'Again' }), 409, 'MEMBERSHIP_NOT_ACTIVE', 'cancel a cancelled membership');

  // 7. Legacy FROZEN (no pause record): resume and cancel both refuse rather than invent evidence.
  const legacy = await membership(m.legacy);
  await refused(() => resume(PAUSER, m.legacy, { expectedVersion: legacy.version }), 409, 'MEMBERSHIP_PAUSE_EVIDENCE_MISSING', 'resume legacy FROZEN');
  await refused(() => cancel(CANCELLER, m.legacy, { expectedVersion: legacy.version, cancellationReason: 'Legacy' }), 409, undefined, 'cancel legacy FROZEN');
  ok((await membership(m.legacy)).state === 'FROZEN', 'legacy membership unchanged');

  // 8. Manual refund records (P4): only for CANCELLED, evidence only, exact replay; no money record changes.
  const goodRefund = { amountMinor: 4500, currency: 'USD', refundedOn: today, method: 'CARD_TERMINAL', reason: 'Prorated goodwill refund' };
  await refused(() => refund(REFUNDER, m.Two, goodRefund), 409, 'MEMBERSHIP_NOT_CANCELLED', 'refund for an ACTIVE membership');
  for (const actor of [PAUSER, CANCELLER, READER, NONE]) await refused(() => refund(actor, m.One, goodRefund), 403, undefined, `refund record refused for ${actor.subject.split('-').pop()}`);
  for (const [label, patch] of [['zero amount', { amountMinor: 0 }], ['future date', { refundedOn: addDays(today, 1) }], ['before membership', { refundedOn: '2001-01-01' }],
    ['bad method', { method: 'STRIPE' }], ['bad currency', { currency: 'US' }], ['blank reason', { reason: '' }], ['extra key', { providerRefundId: 're_1' }]]) {
    await refused(() => refund(REFUNDER, m.One, { ...goodRefund, ...patch }), 400, undefined, `refund validation: ${label}`);
  }
  const refundKey = randomUUID();
  const recorded = await success(() => refund(REFUNDER, m.One, goodRefund, { key: refundKey }), 'record refund');
  ok(recorded.data.amountMinor === 4500 && recorded.data.method === 'CARD_TERMINAL' && recorded.data.refundedOn === today && recorded.meta.replayed === false, 'refund record receipt');
  ok((await success(() => refund(REFUNDER, m.One, goodRefund, { key: refundKey }), 'refund replay')).meta.replayed === true, 'refund exact replay');
  ok((await sql('SELECT count(*)::int n FROM hon.membership_refund_records WHERE membership_id=$1', [m.One])).rows[0].n === 1, 'one refund row');
  const hist = await success(() => history(READER, m.One), 'pause and refund history');
  ok(hist.data.state === 'CANCELLED' && hist.data.pauses.length === 2 && hist.data.pauses[0].pauseId === paused2.data.pauseId && hist.data.pauses[1].endedKind === 'RESUMED'
    && hist.data.refunds.length === 1 && hist.data.refunds[0].refundId === recorded.data.refundId, 'history: newest pause first, one refund');
  await refused(() => history(NONE, m.One), 403, undefined, 'history refused without an admitting permission');
  await refused(() => history(READER, m.schoolB), 404, 'BILLING_MEMBERSHIP_NOT_FOUND', 'history of another school');
  const moneyAfter = await money();
  ok(JSON.stringify(moneyAfter) === JSON.stringify(moneyBefore), `no invoice, payment attempt or schedule changed ${JSON.stringify([moneyBefore, moneyAfter])}`);

  // 9. Transport: browser human commands only.
  const two = await membership(m.Two);
  const body2 = { expectedVersion: two.version, resumeOn: addDays(today, 5), pauseReason: 'Travel' };
  await refused(() => pause(PAUSER, m.Two, body2, { command: null }), 403, 'HUMAN_UI_REQUIRED', 'missing command header');
  await refused(() => pause(PAUSER, m.Two, body2, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site');
  await refused(() => pause(PAUSER, m.Two, body2, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'source header');
  await refused(() => pause(PAUSER, m.Two, body2, { headers: { 'X-Hon-Delegated-By-Principal-Id': OWN.principal } }), 403, 'HUMAN_UI_REQUIRED', 'delegation header');
  await refused(() => pause(PAUSER, m.Two, body2, { headers: { Origin: 'https://evil.example' } }), 403, 'HUMAN_UI_REQUIRED', 'foreign origin');
  await refused(() => pause(PAUSER, m.Two, body2, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'missing idempotency key');
  await refused(() => call(PAUSER, 'POST', `memberships/${m.Two}/pause?x=1`, { body: body2, command: COMMAND.pause }), 400, 'VALIDATION_FAILED', 'query string');
  await refused(() => history(READER, m.One, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key');
  ok((await membership(m.Two)).state === 'ACTIVE', 'Two unchanged by refused transports');

  // 10. The database decides independently of the controller and the service.
  await assert.rejects(services.pauses.pause(PAUSER.context({ principalType: 'SERVICE' }), m.Two, body2), (error) => error?.response?.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(services.pauses.pause(PAUSER.context({ actionRequestId: randomUUID() }), m.Two, body2), (error) => error?.response?.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(services.pauses.pause(READER.context(), m.Two, body2), (error) => error?.status === 403);
  await assert.rejects(services.pauses.pause(PAUSER.context({ schoolId: ids.schoolB }), m.Two, body2), (error) => error?.status === 403 || error?.status === 404);
  await assert.rejects(services.pauses.setPolicy(PAUSER.context(), { ...goodPolicy, expectedVersion: 1 }), (error) => error?.status === 403);
  await assert.rejects(services.pauses.recordRefund(CANCELLER.context(), m.One, goodRefund), (error) => error?.status === 403);
  checks += 6;
  // Live loss: the pauser's grant revoked, then restored.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=$2 WHERE id=$1', [PAUSER.grants[0], OWN.principal]);
  await refused(() => pause(PAUSER, m.Two, body2), 403, undefined, 'pause after the grant is revoked');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1', [PAUSER.grants[0]]);
  for (const [label, suspend, restore] of [
    ['school suspended', "UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", "UPDATE hon.schools SET status='ACTIVE' WHERE id=$1"],
    ['entitlement suspended', "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=(SELECT organization_id FROM hon.schools WHERE id=$1)",
      "UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=(SELECT organization_id FROM hon.schools WHERE id=$1)"]]) {
    await sql(suspend, [ids.schoolA]);
    await refused(() => pause(PAUSER, m.Two, body2), 403, undefined, `pause refused: ${label}`);
    await sql(restore, [ids.schoolA]);
  }
  await success(() => pause(PAUSER, m.Two, body2), 'pause Two after access is restored');

  // 11. Settings-free triggers: no owner write can freeze, unfreeze or rewrite evidence outside the commands.
  await sql('BEGIN');
  const three = await membership(m.Three);
  await rejectsSql(() => sql("UPDATE hon.memberships SET state='FROZEN',version=version+1 WHERE id=$1", [m.Three]), /MEMBERSHIP_STATE_TRANSITION_DENIED/, 'ACTIVE -> FROZEN without a pause row');
  await rejectsSql(() => sql("UPDATE hon.memberships SET state='ACTIVE',version=version+1 WHERE id=$1", [m.legacy]), /MEMBERSHIP_STATE_TRANSITION_DENIED/, 'FROZEN -> ACTIVE without a closed pause');
  await rejectsSql(() => sql("UPDATE hon.memberships SET state='CANCELLED',version=version+1 WHERE id=$1", [m.legacy]), /MEMBERSHIP_STATE_TRANSITION_DENIED/, 'FROZEN -> CANCELLED without a closed pause');
  await rejectsSql(() => sql(`INSERT INTO hon.membership_pauses(organization_id,school_id,membership_id,policy_version,starts_on,planned_resume_on,pause_reason,paused_by_principal_id,pause_prior_version,pause_next_version)
    VALUES($1,$2,$3,1,current_date,current_date+5,'x',$4,$5,$6)`, [ids.organization, ids.schoolA, m.Three, OWN.principal, three.version + 3, three.version + 4]), /IMMUTABLE_MEMBERSHIP_PAUSE/, 'pause row at a wrong version');
  await rejectsSql(() => sql("UPDATE hon.membership_pauses SET pause_reason='rewritten' WHERE membership_id=$1", [m.One]), /IMMUTABLE_MEMBERSHIP_PAUSE/, 'closed pause rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.membership_pauses WHERE membership_id=$1', [m.One]), /IMMUTABLE_MEMBERSHIP_PAUSE/, 'pause row deleted');
  await rejectsSql(() => sql('UPDATE hon.school_membership_pause_policies SET max_pause_days=365 WHERE school_id=$1', [ids.schoolA]), /./, 'policy rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.membership_refund_records WHERE membership_id=$1', [m.One]), /./, 'refund record deleted');
  await rejectsSql(() => sql("INSERT INTO hon.school_membership_pause_policies(organization_id,school_id,version,pauses_allowed,actor_principal_id) VALUES($1,$2,5,false,$3)", [ids.organization, ids.schoolA, OWN.principal]), /IMMUTABLE_MEMBERSHIP_PAUSE_POLICY/, 'policy version gap');
  await sql('ROLLBACK');

  // 12. Runtime ACL: EXECUTE on the seven entry points only; no table privilege, no helper, nothing for PUBLIC.
  const entry = ['read_school_membership_pause_policy(text)', 'set_school_membership_pause_policy(text,jsonb,text,uuid,uuid)', 'pause_school_membership(text,uuid,jsonb,text,uuid,uuid)',
    'resume_school_membership(text,uuid,jsonb,text,uuid,uuid)', 'cancel_school_membership(text,uuid,jsonb,text,uuid,uuid)', 'record_membership_refund(text,uuid,jsonb,text,uuid,uuid)',
    'read_membership_pauses_and_refunds(text,uuid)'];
  const helpers = ['guard_school_membership_pause_policy_insert()', 'guard_membership_pause()', 'membership_pause_text_ok(jsonb,boolean)', 'membership_pause_date(jsonb)', 'membership_school_today()',
    'membership_pause_policy_json(uuid,uuid)', 'membership_pause_json(hon.membership_pauses)', 'membership_refund_json(hon.membership_refund_records)', 'membership_pause_begin(text,text,text,text)',
    'membership_pause_finish(text,text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,text,uuid,integer,uuid,uuid)', 'membership_command_args_ok(text,text,uuid,uuid)',
    'membership_lifecycle_permission(uuid,uuid,uuid,text)', 'require_membership_lifecycle_actor(text,text)', 'guard_membership_state_transition()'];
  for (const fn of entry) {
    const row = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(row.runtime && row.prosecdef && !row.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of helpers) {
    const row = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!row.runtime && !row.public, `helper ${fn} is private`);
  }
  for (const table of ['school_membership_pause_policies', 'membership_pauses', 'membership_refund_records']) {
    const row = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(row.forced && !row.runtime, `${table}: forced RLS, no runtime privilege`);
  }
  ok(!(await sql("SELECT has_any_column_privilege($1,'hon.memberships','UPDATE') u", [CRM_CLOSE_RUNTIME_ROLE])).rows[0].u, 'runtime still has no UPDATE on memberships');
  // The deployment verifier's 0177 and 0224 sections (infra/postgres/011) pass against this database with its runtime role.
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    for (const [start, end] of [['-- Membership activation gate exact verification (0177)', '-- End membership activation gate exact verification.'],
      ['-- Membership pause, cancellation and refund records exact verification (0224)', '-- End membership pause exact verification.']]) {
      const section = verify.split(start)[1]?.split(end)[0];
      ok(section, start);
      await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE));
    } }
  await assert.rejects(runtime.query('SELECT * FROM hon.membership_pauses LIMIT 1'), /permission denied/); checks += 1;
  await assert.rejects(runtime.query("SELECT hon.membership_pause_begin('x','billing.membership.pause','k','f')"), /permission denied/); checks += 1;

  console.log(`PASS: membership pause, cancellation and refund records (0224): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
