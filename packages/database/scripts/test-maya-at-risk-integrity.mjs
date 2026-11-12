/**
 * Maya at-risk students proof (M1, 0259) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guard +
 * MayaAtRiskController -> protected definer read on the restricted runtime role with forced RLS), on the guarded
 * disposable CRM-close fixture only. Synthetic names only; no AI provider is reachable and nothing is written.
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
const { MayaAtRiskController, MayaAtRiskReadHumanUiGuard } = await load('maya/maya-at-risk.controller.js');
const { MayaAtRiskService } = await load('maya/maya-at-risk.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-maya-at-risk', secret: randomBytes(32).toString('hex') };
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
    controllers: [MayaAtRiskController],
    providers: [HonIdentityGuard, HonIdentityService, MayaAtRiskService, MayaAtRiskReadHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

function call(actor, query = '', { headers = {}, school = actor.school, organization = actor.org, method = 'GET' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/retention/at-risk${query ? `?${query}` : ''}`);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json', ...headers,
  };
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method, headers: sent }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.end();
  });
}
async function success(actor, query, label, options) {
  const { status, body, headers } = await call(actor, query, options);
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  return body.data;
}
async function refused(actor, query, expectedStatus, expectedCode, label, options) {
  const { status, body } = await call(actor, query, options);
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
}

const FIXTURE_TABLES = ['memberships', 'attendance_records', 'student_curriculum_enrollments', 'testing_candidates', 'promotion_decisions', 'class_sessions', 'invoices'];
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
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`maya-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`maya-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`maya-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `maya-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Maya Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Maya Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}

const programs = {}, curricula = {};
let rankOrder = 0;
async function schoolFixtures(school, org) {
  programs[school] = randomUUID(); curricula[school] = randomUUID();
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Maya Program','SCHEDULED')", [programs[school], org, school]);
  await sql("INSERT INTO hon.curricula(id,organization_id,school_id,name,lifecycle,model_code) VALUES($1,$2,$3,'Maya Curriculum','PUBLISHED','LINEAR')", [curricula[school], org, school]);
}
async function student(givenName, { state = 'ACTIVE', started = '4800 hours', ends = '4800 hours', school = ids.schoolA, org = ids.organization } = {}) {
  const person = randomUUID(), profile = randomUUID(), account = randomUUID(), membership = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,'Synthetic','x@example.test','+15550000000')", [person, org, school, givenName]);
  await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [profile, org, school, person]);
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [account, org, school, person]);
  await sql(`INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
    VALUES($1,$2,$3,$4,$5,'MONTHLY',$6,clock_timestamp()-$7::interval,CASE WHEN $8::text IS NULL THEN NULL ELSE clock_timestamp()+$8::interval END)`,
  [membership, org, school, account, person, state, started, ends]);
  return { person, profile, account, membership, school, org, givenName };
}
async function secondMembership(who, { state = 'ACTIVE', ends = '4800 hours' } = {}) {
  const membership = randomUUID();
  await sql(`INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
    VALUES($1,$2,$3,$4,$5,'ADDON',$6,clock_timestamp()-interval '4800 hours',clock_timestamp()+$7::interval)`, [membership, who.org, who.school, who.account, who.person, state, ends]);
  return { ...who, membership };
}
async function attended(who, daysAgo, status = 'PRESENT') {
  const session = randomUUID();
  await sql(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status)
    VALUES($1,$2,$3,$4,'Maya Class',clock_timestamp()-$5::interval,clock_timestamp()-$5::interval+interval '1 hour',20,'WALK_IN','COMPLETED')`,
  [session, who.org, who.school, programs[who.school], `${daysAgo * 24} hours`]);
  await sql('INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,progression_enabled,progression_credit_milli) VALUES($1,$2,$3,$4,$5,false,0)', [who.org, who.school, session, who.profile, status]);
}
async function enrolled(who, daysAgo, promotedDaysAgo = null) {
  const enrollment = randomUUID();
  await sql("INSERT INTO hon.student_curriculum_enrollments(id,organization_id,school_id,student_profile_id,curriculum_id,enrolled_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()-$6::interval)",
    [enrollment, who.org, who.school, who.profile, curricula[who.school], `${daysAgo * 24} hours`]);
  if (promotedDaysAgo !== null) {
    const rank = randomUUID(), event = randomUUID(), candidate = randomUUID();
    await sql("INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,'Maya Rank',$5)", [rank, who.org, who.school, curricula[who.school], ++rankOrder]);
    await sql("INSERT INTO hon.testing_events(id,organization_id,school_id,curriculum_id,name,starts_at) VALUES($1,$2,$3,$4,'Maya Test',clock_timestamp()-$5::interval)", [event, who.org, who.school, curricula[who.school], `${promotedDaysAgo * 24} hours`]);
    await sql('INSERT INTO hon.testing_candidates(id,organization_id,school_id,testing_event_id,student_curriculum_enrollment_id,target_rank_id) VALUES($1,$2,$3,$4,$5,$6)', [candidate, who.org, who.school, event, enrollment, rank]);
    await sql("INSERT INTO hon.promotion_decisions(organization_id,school_id,testing_candidate_id,student_curriculum_enrollment_id,target_rank_id,status,decided_at) VALUES($1,$2,$3,$4,$5,'PROMOTED',clock_timestamp()-$6::interval)",
      [who.org, who.school, candidate, enrollment, rank, `${promotedDaysAgo * 24} hours`]);
  }
}
async function invoice(who, { total, due, paid = 0, status = 'ISSUED', accountOnly = false }) {
  const id = randomUUID();
  await sql(`INSERT INTO hon.invoices(id,organization_id,school_id,billing_account_id,membership_id,status,currency,subtotal_minor,total_minor,due_at)
    VALUES($1,$2,$3,$4,$5,$6,'USD',$7,$7,clock_timestamp()+$8::interval)`, [id, who.org, who.school, who.account, accountOnly ? null : who.membership, status, total, due]);
  if (paid) {
    await sql(`INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,actor_principal_id)
      VALUES($1,$2,$3,$4,'USD',current_date-1,'CASH',$5)`, [who.org, who.school, id, paid, OWN.principal]);
  }
  return id;
}

let OWN, READER, BILLING_READER, BILLING_ONLY, MIXED, OTHER_SCHOOL, OTHER_ORG, REVOKED;
const s = {};
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Maya Org','Maya Org'),($2,'Maya Other Org','Maya Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'COMPLETE',clock_timestamp()-interval '1 day'),($2,'COMPLETE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Maya ${slug}`, `maya-${slug}-${school.slice(0, 8)}`, LA]);
    await schoolFixtures(school, org);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  READER = await staff('reader', [await role(ids.organization, ['retention.review.read'])]);
  BILLING_READER = await staff('billing-reader', [await role(ids.organization, ['retention.review.read']), await role(ids.organization, ['billing.invoice.issue'])]);
  BILLING_ONLY = await staff('billing-only', [await role(ids.organization, ['billing.invoice.issue', 'billing.invoice.payment.record', 'people.read', 'reporting.view'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['retention.review.read']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  REVOKED = await staff('revoked', [await role(ids.organization, ['retention.review.read'])]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });

  for (const table of FIXTURE_TABLES) await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
  s.absent20 = await student('Avery'); await attended(s.absent20, 20); await attended(s.absent20, 25);
  s.absent40 = await student('Blake'); for (const d of [35, 38, 41, 44, 50]) await attended(s.absent40, d);
  s.drop = await student('Casey'); for (const d of [30, 33, 36, 40, 44, 50]) await attended(s.drop, d); await attended(s.drop, 3, 'LATE'); await attended(s.drop, 10, 'MAKEUP');
  s.never = await student('Devon', { started: '480 hours' });
  s.newbie = await student('Ellis', { started: '120 hours' }); // never attended, but joined 5 days ago: not at risk
  s.frozen = await student('Finley', { state: 'FROZEN', ends: '240 hours' }); // frozen: no attendance factors; term ending
  s.frozenQuiet = await student('Gray', { state: 'FROZEN' }); // frozen, nothing else: not listed
  s.pending = await student('Harper', { state: 'CANCELLATION_PENDING', ends: null }); await attended(s.pending, 2);
  s.owing = await student('Indy'); await attended(s.owing, 2);
  await invoice(s.owing, { total: 1000, due: '-72 hours', paid: 400 }); // overdue with a balance
  await invoice(s.owing, { total: 500, due: '-72 hours', paid: 500 }); // paid in full by records
  s.notDue = await student('Jules'); await attended(s.notDue, 2); await invoice(s.notDue, { total: 900, due: '120 hours' });
  s.draftInvoice = await student('Kai'); await attended(s.draftInvoice, 2); await invoice(s.draftInvoice, { total: 900, due: '-120 hours', status: 'DRAFT' });
  s.rank = await student('Logan'); await attended(s.rank, 2); await enrolled(s.rank, 200);
  s.rankOk = await student('Morgan'); await attended(s.rankOk, 2); await enrolled(s.rankOk, 200, 30);
  s.rankNew = await student('Noel'); await attended(s.rankNew, 2); await enrolled(s.rankNew, 100);
  s.healthy = await student('Oakley'); await attended(s.healthy, 2); await attended(s.healthy, 5, 'EXCUSED_ABSENCE');
  s.absentExcused = await student('Parker'); await attended(s.absentExcused, 20); await attended(s.absentExcused, 3, 'UNEXCUSED_ABSENCE');
  s.cancelled = await student('Quinn', { state: 'CANCELLED' }); await attended(s.cancelled, 40);
  s.many = await student('Rowan', { ends: '168 hours' }); for (const d of [31, 34, 37, 40, 43]) await attended(s.many, d); await enrolled(s.many, 300);
  await invoice(s.many, { total: 100, due: '-24 hours' });
  s.twice = await student('Uma'); await attended(s.twice, 20); s.twiceAddon = await secondMembership(s.twice, { state: 'CANCELLATION_PENDING' });
  s.account = await student('Vic'); await attended(s.account, 2); await invoice(s.account, { total: 800, due: '-48 hours', accountOnly: true });
  s.schoolB = await student('Sage', { school: ids.schoolB }); await attended(s.schoolB, 40);
  s.other = await student('Tatum', { school: ids.otherSchool, org: ids.otherOrganization }); await attended(s.other, 40);
  for (const table of FIXTURE_TABLES) await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
}

const snapshot = async () => (await sql(`SELECT md5(string_agg(t::text,'|' ORDER BY t::text)) h FROM (
  SELECT m::text t FROM hon.memberships m WHERE organization_id=$1 UNION ALL SELECT i::text FROM hon.invoices i WHERE organization_id=$1
  UNION ALL SELECT a::text FROM hon.attendance_records a WHERE organization_id=$1 UNION ALL SELECT x::text FROM hon.audit_events x WHERE organization_id=$1
  UNION ALL SELECT o::text FROM hon.outbox_events o WHERE organization_id=$1) z`, [ids.organization])).rows[0].h;
const byName = (list) => Object.fromEntries(list.items.map((item) => [item.givenName, item]));
const codes = (item) => item.factors.map((f) => f.code).join(',');

try {
  await cleanup();
  await seed();
  await startApp();
  const before = await snapshot();

  // 1. The billing reader sees every factor, scored, ordered and explained.
  const full = await success(BILLING_READER, '', 'billing reader list');
  const seen = byName(full);
  ok(full.schemaVersion === 'MAYA_AT_RISK_V1' && full.tuitionChecked === true && full.nextAfter === null, 'header: schema, tuition checked, one page');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(full.localToday) && !Number.isNaN(Date.parse(full.asOf)), 'header: local today and as-of');
  const listed = Object.keys(seen).sort().join(',');
  ok(listed === ['Avery', 'Blake', 'Casey', 'Devon', 'Finley', 'Harper', 'Indy', 'Logan', 'Parker', 'Rowan', 'Uma', 'Vic'].join(','), `exactly the at-risk students are listed (got ${listed})`);
  ok(seen.Avery.score === 30 && seen.Avery.level === 'MEDIUM' && seen.Avery.suggestedNextStep === 'CALL_TO_CHECK_IN'
    && JSON.stringify(seen.Avery.factors) === JSON.stringify([{ code: 'LONG_ABSENCE', points: 30, daysSinceLastAttendance: 20, neverAttended: false }]), 'Avery: 20 days absent');
  ok(seen.Blake.score === 70 && seen.Blake.level === 'HIGH' && codes(seen.Blake) === 'LONG_ABSENCE,ATTENDANCE_DROP'
    && seen.Blake.factors[0].points === 45 && seen.Blake.factors[0].daysSinceLastAttendance === 35
    && seen.Blake.factors[1].last28Days === 0 && seen.Blake.factors[1].previous28Days === 5, 'Blake: 35 days absent after 5 classes');
  ok(seen.Casey.score === 25 && seen.Casey.level === 'WATCH' && seen.Casey.suggestedNextStep === 'INVITE_BACK_TO_CLASS'
    && JSON.stringify(seen.Casey.factors) === JSON.stringify([{ code: 'ATTENDANCE_DROP', points: 25, last28Days: 2, previous28Days: 6 }]), 'Casey: 2 of 6 (late and makeup count)');
  ok(JSON.stringify(seen.Devon.factors) === JSON.stringify([{ code: 'LONG_ABSENCE', points: 30, daysSinceLastAttendance: null, neverAttended: true }]), 'Devon: never attended in 20 days');
  ok(seen.Finley.membershipState === 'FROZEN' && codes(seen.Finley) === 'TERM_ENDING' && seen.Finley.factors[0].cancellationPending === false
    && /^\d{4}-\d{2}-\d{2}$/.test(seen.Finley.factors[0].termEndsOn) && seen.Finley.suggestedNextStep === 'DISCUSS_RENEWAL', 'Finley: frozen, only the term ending counts');
  ok(seen.Harper.membershipState === 'CANCELLATION_PENDING' && JSON.stringify(seen.Harper.factors) === JSON.stringify([{ code: 'TERM_ENDING', points: 20, cancellationPending: true, termEndsOn: null }]), 'Harper: cancellation pending');
  ok(JSON.stringify(seen.Indy.factors) === JSON.stringify([{ code: 'TUITION_OVERDUE', points: 20, overdueInvoiceCount: 1 }]) && seen.Indy.suggestedNextStep === 'REVIEW_TUITION_BALANCE', 'Indy: one overdue balance (paid invoice ignored)');
  ok(full.items.filter((item) => item.givenName === 'Uma').length === 1 && seen.Uma.membershipId === s.twiceAddon.membership && seen.Uma.score === 50
    && codes(seen.Uma) === 'LONG_ABSENCE,TERM_ENDING', 'Uma: two memberships, one row, the higher-scoring membership');
  ok(JSON.stringify(seen.Vic.factors) === JSON.stringify([{ code: 'TUITION_OVERDUE', points: 20, overdueInvoiceCount: 1 }]), 'Vic: an overdue invoice on the billing account with no membership counts');
  ok(codes(seen.Parker) === 'LONG_ABSENCE' && seen.Parker.factors[0].daysSinceLastAttendance === 20, 'Parker: an unexcused absence is not attendance');
  ok(JSON.stringify(seen.Logan.factors) === JSON.stringify([{ code: 'NO_RANK_PROGRESS', points: 15, daysSinceProgress: 200 }]) && seen.Logan.suggestedNextStep === 'PLAN_PROGRESS_TALK', 'Logan: no promotion in 200 days');
  ok(seen.Rowan.score === 100 && codes(seen.Rowan) === 'LONG_ABSENCE,ATTENDANCE_DROP,TUITION_OVERDUE,TERM_ENDING,NO_RANK_PROGRESS'
    && seen.Rowan.factors[0].points === 45, 'Rowan: every factor, score capped at 100, ties ordered tuition before term');
  for (const item of full.items) ok(Object.keys(item).sort().join() === 'factors,familyName,givenName,level,membershipId,membershipState,score,suggestedNextStep', `${item.givenName}: no contact or family data`);
  ok(!JSON.stringify(full).includes('example.test') && !JSON.stringify(full).includes('+1555'), 'no email or phone anywhere');
  const scores = full.items.map((item) => item.score);
  ok(JSON.stringify(scores) === JSON.stringify([...scores].sort((a, b) => b - a)), 'ordered by score, highest first');
  ok(JSON.stringify(full.counts) === JSON.stringify({ HIGH: 3, MEDIUM: 3, WATCH: 6 }), `level counts (got ${JSON.stringify(full.counts)})`);

  // 2. Without billing read, tuition is never evaluated or shown.
  const plain = await success(READER, '', 'retention-only reader list');
  ok(plain.tuitionChecked === false && !JSON.stringify(plain).includes('TUITION_OVERDUE'), 'no tuition factor without billing read');
  ok(!byName(plain).Indy && byName(plain).Rowan.score === 100 && codes(byName(plain).Rowan) === 'LONG_ABSENCE,ATTENDANCE_DROP,TERM_ENDING,NO_RANK_PROGRESS', 'Indy hidden; Rowan without tuition');
  ok((await success(OWN, '', 'owner list')).tuitionChecked === true, 'the owner holds billing read');

  // 3. Paging: cursor is score:membershipId, stable order.
  const first = full.items[2];
  const after = await success(BILLING_READER, `after=${first.score}:${first.membershipId}`, 'list after a cursor');
  ok(JSON.stringify(after.items.map((item) => item.membershipId)) === JSON.stringify(full.items.slice(3).map((item) => item.membershipId)), 'cursor continues after the third row');
  ok(JSON.stringify(after.counts) === JSON.stringify(full.counts), 'counts cover the whole school on every page');

  // 4. School and organization isolation.
  const b = await success(OTHER_SCHOOL, '', 'school B list');
  ok(b.items.length === 1 && b.items[0].givenName === 'Sage', 'school B sees only its own student');
  await refused(OTHER_SCHOOL, '', 403, 'MAYA_AT_RISK_FORBIDDEN', 'school-B staff at the school-A route', { school: ids.schoolA });
  await refused(OTHER_ORG, '', 403, 'MAYA_AT_RISK_FORBIDDEN', 'other-organization owner at the school-A route', { school: ids.schoolA, organization: ids.organization });
  ok((await success(OTHER_ORG, '', 'other org list')).items.map((item) => item.givenName).join() === 'Tatum', 'other organization sees only its own');

  // 5. Who may read.
  await refused(BILLING_ONLY, '', 403, 'MAYA_AT_RISK_FORBIDDEN', 'billing without retention.review.read');
  await refused(MIXED, '', 403, 'MAYA_AT_RISK_FORBIDDEN', 'a family-type role alongside');
  await sql('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp() WHERE id=$1', [REVOKED.grants[0]]);
  await refused(REVOKED, '', 403, 'MAYA_AT_RISK_FORBIDDEN', 'expired grant');
  for (const [label, query] of [['extra key', 'x=1'], ['bad cursor', 'after=nope'], ['cursor score over 100', `after=101:${first.membershipId}`], ['repeated after', `after=1:${first.membershipId}&after=2:${first.membershipId}`]]) {
    await refused(READER, query, 400, 'VALIDATION_FAILED', `validation: ${label}`);
  }
  await refused(READER, '', 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key', { headers: { 'Idempotency-Key': 'x' } });
  await refused(READER, '', 403, 'HUMAN_UI_REQUIRED', 'AI source header', { headers: { 'X-Hon-Source': 'AI_AGENT' } });
  await refused(READER, '', 403, 'HUMAN_UI_REQUIRED', 'Action Engine header', { headers: { 'X-Hon-Action-Request-Id': randomUUID() } });
  await refused(READER, '', 403, 'HUMAN_UI_REQUIRED', 'cross-site browser', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.schoolA]);
  await refused(READER, '', 403, undefined, 'suspended school');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.schoolA]);
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1", [ids.organization]);
  await refused(READER, '', 403, undefined, 'no paid entitlement');
  // Maya is part of the included AI team: a legacy Core-only school (no active COMPLETE / HON OS entitlement) is refused.
  await sql("UPDATE hon.organization_entitlements SET effective_until=NULL, tier='CORE' WHERE organization_id=$1", [ids.organization]);
  await refused(READER, '', 403, undefined, 'Core-only entitlement (AI team needs COMPLETE)');
  await sql("UPDATE hon.organization_entitlements SET effective_until=NULL, tier='COMPLETE' WHERE organization_id=$1", [ids.organization]);
  ok((await success(READER, '', 'restored reader')).items.length === plain.items.length, 'access restored once the entitlement is back');

  // 6. Direct database calls: only the direct human with the session settings.
  await assert.rejects(runtime.query("SELECT hon.read_maya_at_risk_students('x','{}'::jsonb)"), /MAYA_AT_RISK_FORBIDDEN|tenant|permission/); checks += 1;
  await assert.rejects(runtime.query("SELECT hon.require_maya_actor('x','retention.review.read')"), /permission denied/); checks += 1;
  await assert.rejects(runtime.query("SELECT hon.maya_reader_sees_tuition('x')"), /permission denied/); checks += 1;

  // 7. Nothing was written: memberships, invoices, attendance, audit and outbox unchanged.
  ok(await snapshot() === before, 'no membership, invoice, attendance, audit or outbox change');

  // 8. Runtime ACL and the deployment verifier's 0259 section.
  const entry = (await sql(`SELECT has_function_privilege($1,'hon.read_maya_at_risk_students(text,jsonb)','EXECUTE') runtime, p.prosecdef,
    EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public, p.provolatile FROM pg_proc p WHERE p.oid='hon.read_maya_at_risk_students(text,jsonb)'::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
  ok(entry.runtime && entry.prosecdef && !entry.public, 'runtime may execute the definer read; PUBLIC may not');
  for (const fn of ['require_maya_actor(text,text)', 'maya_reader_sees_tuition(text)']) {
    const row = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!row.runtime && !row.public, `helper ${fn} is private`);
  }
  ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test((await sql("SELECT prosrc FROM pg_proc WHERE oid='hon.read_maya_at_risk_students(text,jsonb)'::regprocedure")).rows[0].prosrc), 'the read contains no DML');
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const start = '-- Maya at-risk students exact verification (M1 0259)', end = '-- End Maya at-risk students exact verification.';
    const section = verify.split(start)[1]?.split(end)[0];
    ok(section, start);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: Maya at-risk students (0259): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
