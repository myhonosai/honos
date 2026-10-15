import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { OperationsSummaryController } from '../../../apps/api/dist/reports/operations-summary.controller.js';
import { OperationsSummaryService } from '../../../apps/api/dist/reports/operations-summary.service.js';
import { RuntimeDatabaseService } from '../../../apps/api/dist/foundation/runtime-database.service.js';
import { AppModule } from '../../../apps/api/dist/app.module.js';

if (!process.env.DATABASE_URL || !process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Both migration and restricted runtime database URLs are required.');
const options = (connectionString) => ({ connectionString, ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false } });
const admin = new pg.Client(options(process.env.DATABASE_URL));
const runtime = new pg.Client(options(process.env.HON_RUNTIME_DATABASE_URL));
const db = new RuntimeDatabaseService();
const controller = new OperationsSummaryController(new OperationsSummaryService(db));
const ids = Object.fromEntries(['org', 'foreignOrg', 'a', 'b', 'hidden', 'empty', 'foreign', 'user', 'principal', 'role', 'weakRole', 'grantB'].map((key) => [key, randomUUID()]));
const subject = `operations-summary-${randomUUID()}`;
const now = Date.now();
const from = new Date(now - 86400000).toISOString();
const to = new Date(now + 86400000).toISOString();
const past = new Date(now - 3600000).toISOString();
const future = new Date(now + 3600000).toISOString();
const outside = new Date(now - 10 * 86400000).toISOString();
const request = { honIdentity: { externalSubject: subject } };
const query = { from, to };
const read = async (organizationId = ids.org, req = request) => (await controller.read(organizationId, query, req)).data.operationsSummary;
const status = (expected, code) => (error) => { assert.equal(error.getStatus(), expected); if (code) assert.equal(error.getResponse().code, code); return true; };
const deny = (operation, code = 'OPERATIONS_SUMMARY_FORBIDDEN') => assert.rejects(operation, status(403, code));
const sqlDenied = (operation, code = '42501') => assert.rejects(operation, (error) => error.code === code);
const amounts = (metrics, currency) => metrics.invoices.amountsByCurrency.find((entry) => entry.currency === currency)?.totalMinorByStatus;

async function cleanup() {
  await admin.query('BEGIN');
  try {
    for (const table of ['attendance_records', 'crm_activities', 'invoices', 'billing_accounts', 'crm_leads', 'crm_pipeline_stages', 'crm_pipelines', 'student_profiles', 'class_sessions', 'programs', 'people', 'principal_role_grants', 'organization_entitlements']) {
      await admin.query(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [[ids.org, ids.foreignOrg]]);
    }
    await admin.query('DELETE FROM hon.roles WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.principals WHERE user_id = $1', [ids.user]);
    await admin.query('DELETE FROM hon.users WHERE id = $1', [ids.user]);
    await admin.query('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.org, ids.foreignOrg]]);
    await admin.query('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.org, ids.foreignOrg]]);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

await Promise.all([admin.connect(), runtime.connect()]);
try {
  await admin.query('BEGIN');
  try {
    for (const id of [ids.org, ids.foreignOrg]) await admin.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)', [id, 'PRIVATE_ORGANIZATION_NAME']);
    for (const key of ['a', 'b', 'hidden', 'empty', 'foreign']) await admin.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1::uuid,$2,$3,$1::text)', [ids[key], key === 'foreign' ? ids.foreignOrg : ids.org, 'PRIVATE_SCHOOL_DIRECTORY']);
    await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [ids.user, subject, 'PRIVATE_EMAIL@example.test', 'PRIVATE_STAFF_NAME']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','PRIVATE_PRINCIPAL_NAME')", [ids.principal, ids.user]);
    for (const [id, code, permission] of [[ids.role, 'SUMMARY', 'reporting.view'], [ids.weakRole, 'WEAK', 'school.view']]) {
      await admin.query('INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,$3)', [id, ids.org, code]);
      await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, ids.org, permission]);
    }
    for (const [school, role, grantId, effectiveFrom, effectiveUntil] of [
      [ids.a, ids.role, randomUUID(), outside, null], [ids.a, ids.role, randomUUID(), outside, null],
      [ids.b, ids.role, ids.grantB, outside, null], [ids.empty, ids.role, randomUUID(), outside, null],
      [ids.hidden, ids.weakRole, randomUUID(), outside, null],
      [ids.hidden, ids.role, randomUUID(), future, null], [ids.hidden, ids.role, randomUUID(), outside, past],
    ]) await admin.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from,effective_until) VALUES($1,$2,$3,$4,$5,$4,$6,$7)', [grantId, ids.org, school, ids.principal, role, effectiveFrom, effectiveUntil]);
    await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',$2),($3,'COMPLETE',$2)", [ids.org, outside, ids.foreignOrg]);

    for (const key of ['a', 'b', 'hidden', 'foreign']) {
      const organization = key === 'foreign' ? ids.foreignOrg : ids.org;
      const school = ids[key];
      const people = []; const students = [];
      for (let i = 0; i < (key === 'a' ? 2 : 1); i++) {
        const person = randomUUID(); const student = randomUUID(); people.push(person); students.push(student);
        await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,'PRIVATE_GIVEN','PRIVATE_FAMILY','PRIVATE_PERSON_EMAIL@example.test','+15555550123')", [person, organization, school]);
        await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,status) VALUES($1,$2,$3,$4,$5)', [student, organization, school, person, i === 1 ? 'ARCHIVED' : 'ACTIVE']);
      }
      const pipeline = randomUUID(); const stage = randomUUID(); const lead = randomUUID();
      await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_PIPELINE')", [pipeline, organization, school]);
      await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'PRIVATE_STAGE',1)", [stage, organization, school, pipeline]);
      await admin.query('INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,attribution) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [lead, organization, school, people[0], pipeline, stage, key === 'a' ? 'OPEN' : key === 'b' ? 'WON' : 'LOST', { private: 'PRIVATE_ATTRIBUTION' }]);
      for (const occurredAt of [from, to, outside]) await admin.query("INSERT INTO hon.crm_activities(organization_id,school_id,lead_id,activity_type,occurred_at,details) VALUES($1,$2,$3,'NOTE',$4,'{\"note\":\"PRIVATE_ACTIVITY\"}')", [organization, school, lead, occurredAt]);
      const program = randomUUID();
      await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_PROGRAM')", [program, organization, school]);
      const specs = key === 'a' ? [['SCHEDULED', from], ['SCHEDULED', future], ['COMPLETED', past], ['CANCELLED', past], ['DRAFT', past], ['SCHEDULED', to], ['SCHEDULED', outside]] : [['COMPLETED', past]];
      for (let i = 0; i < specs.length; i++) {
        const [state, startsAt] = specs[i]; const session = randomUUID();
        await admin.query("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status,cancellation_reason) VALUES($1,$2,$3,$4,'PRIVATE_SESSION',$5,$6,10,'WALK_IN',$7,$8)", [session, organization, school, program, startsAt, new Date(Date.parse(startsAt) + 1800000).toISOString(), state, state === 'CANCELLED' ? 'PRIVATE_REASON' : null]);
        if (i === 0 || (key === 'a' && i === 6)) await admin.query("INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,recorded_at,note) VALUES($1,$2,$3,$4,$5,$6,'PRIVATE_ATTENDANCE')", [organization, school, session, students[0], key === 'a' ? 'PRESENT' : 'LATE', from]);
      }
      const account = randomUUID();
      await admin.query('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [account, organization, school, people[0]]);
      const invoiceSpecs = key === 'a' ? [['ISSUED', 'USD', 120, from], ['PAID', 'USD', 80, past], ['DRAFT', 'EUR', 70, past], ['VOID', 'USD', 20, past], ['UNCOLLECTIBLE', 'EUR', 30, past], ['PAID', 'USD', 999, to], ['PAID', 'USD', 999, outside]] : [['ISSUED', 'USD', key === 'b' ? 250 : 999999, past]];
      for (const [state, currency, total, createdAt] of invoiceSpecs) await admin.query('INSERT INTO hon.invoices(organization_id,school_id,billing_account_id,status,currency,subtotal_minor,total_minor,created_at) VALUES($1,$2,$3,$4,$5,$6,$6,$7)', [organization, school, account, state, currency, total, createdAt]);
    }
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }

  const before = (await admin.query(`SELECT
    (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1) AS audit,
    (SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1) AS outbox,
    (SELECT count(*) FROM hon.action_requests WHERE organization_id=$1) AS actions,
    (SELECT count(*) FROM hon.ai_usage_ledger WHERE organization_id=$1) AS ai,
    (SELECT sum(version) FROM hon.invoices WHERE organization_id=$1) AS invoices,
    (SELECT sum(version) FROM hon.crm_leads WHERE organization_id=$1) AS leads`, [ids.org])).rows[0];
  const summary = await read();
  assert.equal(summary.entitlementTier, 'CORE'); assert.equal(summary.scope, 'AUTHORIZED_SCHOOLS_ONLY');
  assert.equal(summary.schoolCount, 3); assert.deepEqual(summary.schools.map((row) => row.schoolId).sort(), [ids.a, ids.b, ids.empty].sort());
  assert.equal(summary.from, from); assert.equal(summary.to, to); assert(Number.isFinite(Date.parse(summary.generatedAt)));
  assert.deepEqual(summary.aggregate.studentProfiles, { total: 3, active: 2 });
  assert.deepEqual(summary.aggregate.leads.byStatus, { OPEN: 1, WON: 1, LOST: 0, ARCHIVED: 0 });
  assert.deepEqual(summary.aggregate.classSessions.inRange, { draft: 1, scheduled: 2, completed: 2, cancelled: 1 });
  assert.equal(summary.aggregate.classSessions.scheduledDueInRange, 1);
  assert.deepEqual(summary.aggregate.attendance.inRangeByStatus, { PRESENT: 1, LATE: 1, EXCUSED_ABSENCE: 0, UNEXCUSED_ABSENCE: 0, MAKEUP: 0 });
  assert.deepEqual(summary.aggregate.recentActivity, { crmActivitiesInRange: 2, attendanceEntriesRecordedInRange: 3 });
  assert.deepEqual(summary.aggregate.invoices.inRangeByStatus, { DRAFT: 1, ISSUED: 2, PAID: 1, VOID: 1, UNCOLLECTIBLE: 1 });
  assert.deepEqual(amounts(summary.aggregate, 'USD'), { DRAFT: 0, ISSUED: 370, PAID: 80, VOID: 20, UNCOLLECTIBLE: 0 });
  assert.deepEqual(amounts(summary.aggregate, 'EUR'), { DRAFT: 70, ISSUED: 0, PAID: 0, VOID: 0, UNCOLLECTIBLE: 30 });
  assert.deepEqual(summary.schools.find((row) => row.schoolId === ids.empty).metrics.invoices.amountsByCurrency, []);
  assert.equal(summary.schools.find((row) => row.schoolId === ids.a).metrics.studentProfiles.total, 2);
  assert.equal(amounts(summary.schools.find((row) => row.schoolId === ids.b).metrics, 'USD').ISSUED, 250);
  const serialized = JSON.stringify(summary);
  assert(!serialized.includes(ids.hidden) && !serialized.includes(ids.foreign) && !serialized.includes(ids.principal) && !serialized.includes(ids.user));
  assert.doesNotMatch(serialized, /PRIVATE_|personId|membershipId|principalId|provider|contacts|email|phone|rawInvoices|staff/i);

  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [ids.org]);
  assert.equal((await read()).entitlementTier, 'COMPLETE');
  for (const change of ["tier='ESSENTIAL'", "tier='CORE',status='SUSPENDED'", "status='ACTIVE',effective_from=now()+interval '1 hour'", "effective_from=now()-interval '2 days',effective_until=now()-interval '1 hour'"]) {
    await admin.query(`UPDATE hon.organization_entitlements SET ${change} WHERE organization_id=$1`, [ids.org]);
    await deny(() => read(), 'TIER_ENTITLEMENT_REQUIRED');
  }
  await admin.query('DELETE FROM hon.organization_entitlements WHERE organization_id=$1', [ids.org]);
  await deny(() => read(), 'TIER_ENTITLEMENT_REQUIRED');
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',$2)", [ids.org, outside]);
  await deny(() => read(ids.foreignOrg)); await deny(() => read(randomUUID()));
  await deny(() => read(ids.org, {})); await deny(() => read(ids.org, { honIdentity: { externalSubject: 'unknown' } }));
  await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1', [ids.principal]);
  await deny(() => read());
  await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1', [ids.principal]);
  for (const change of ["effective_until=now()-interval '1 minute'", "effective_until=NULL,effective_from=now()+interval '1 hour'"]) {
    await admin.query(`UPDATE hon.principal_role_grants SET ${change} WHERE id=$1`, [ids.grantB]);
    const restricted = await read(); assert.equal(restricted.schoolCount, 2); assert.equal(restricted.aggregate.studentProfiles.total, 2);
    assert(!JSON.stringify(restricted).includes(ids.b)); assert.equal(amounts(restricted.aggregate, 'USD').ISSUED, 120);
  }
  await admin.query('DELETE FROM hon.principal_role_grants WHERE id=$1', [ids.grantB]);
  assert.equal((await read()).schoolCount, 2);
  await admin.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,$6)', [ids.grantB, ids.org, ids.b, ids.principal, ids.role, outside]);
  await admin.query("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.b]);
  assert.equal((await read()).schoolCount, 2);
  await admin.query("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.b]);
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='reporting.view'", [ids.role]);
  await deny(() => read());
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'reporting.view')", [ids.role, ids.org]);
  await admin.query("UPDATE hon.organizations SET status='ARCHIVED' WHERE id=$1", [ids.org]);
  await deny(() => read());
  await admin.query("UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1", [ids.org]);
  const ambiguous = randomUUID();
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Ambiguous')", [ambiguous, ids.user]);
  await deny(() => read());
  await admin.query('DELETE FROM hon.principals WHERE id=$1', [ambiguous]);
  // The same grants held by an AI/integration-style principal are not a human
  // identity bridge; the verified subject cannot authorize that principal.
  await admin.query("UPDATE hon.principals SET principal_type='AI_EMPLOYEE',user_id=NULL WHERE id=$1", [ids.principal]);
  await deny(() => read());
  await admin.query("UPDATE hon.principals SET principal_type='HUMAN_USER',user_id=$2 WHERE id=$1", [ids.principal, ids.user]);

  // Actual hon_runtime connection: fixed projection is executable, all directory
  // and HQ SELECT/DML remain denied even with forged transaction-local scope.
  const signature = 'hon.read_organization_operations_summary(text,uuid,timestamptz,timestamptz)';
  const posture = (await admin.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolsuper,r.rolbypassrls,
    has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS execute,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) AS acl
      WHERE acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS broad_acl
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure`, [signature])).rows[0];
  assert(posture.prosecdef && posture.provolatile === 's' && posture.execute && !posture.broad_acl && (posture.rolsuper || posture.rolbypassrls));
  assert.deepEqual(posture.proconfig, ['search_path=pg_catalog, hon']);
  const forbidden = ['users','principals','roles','permissions','role_permissions','principal_role_grants','family_access_grants','organizations','schools','hq_operator_grants','hq_onboarding_requests','hq_ai_provider_connections','hq_ai_model_catalog','hq_ai_routing_policies','hq_ai_routing_candidates','hq_ai_control_requests','hq_ai_control_audit','hq_ai_control_outbox','crm_activities'];
  for (const table of forbidden) {
    assert.equal((await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed", [`hon.${table}`])).rows[0].allowed, false, table);
    await sqlDenied(() => runtime.query(`SELECT * FROM hon.${table} LIMIT 1`));
  }
  await runtime.query('BEGIN READ ONLY');
  try {
    await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true)", [ids.foreignOrg, ids.foreign, randomUUID()]);
    const projected = (await runtime.query('SELECT hon.read_organization_operations_summary($1,$2,$3,$4) AS data', [subject, ids.org, from, to])).rows[0].data;
    assert.deepEqual(projected.aggregate, summary.aggregate); assert.equal(projected.schoolCount, 3);
    assert.equal((await runtime.query('SELECT hon.current_school_id() AS school')).rows[0].school, ids.foreign, 'Projection changed caller scope.');
    const foreignSchool = (await runtime.query('SELECT count(*) AS total FROM hon.student_profiles WHERE organization_id=$1 AND school_id=$2', [ids.org, ids.hidden])).rows[0];
    assert.equal(foreignSchool.total, '0');
    for (const table of ['users', 'schools', 'hq_ai_provider_connections']) {
      await runtime.query('SAVEPOINT forbidden_directory');
      await sqlDenied(() => runtime.query(`SELECT * FROM hon.${table} LIMIT 1`));
      await runtime.query('ROLLBACK TO SAVEPOINT forbidden_directory');
    }
    await runtime.query('ROLLBACK');
  } catch (error) { await runtime.query('ROLLBACK'); throw error; }
  const direct = (start, end) => runtime.query('SELECT hon.read_organization_operations_summary($1,$2,$3,$4)', [subject, ids.org, start, end]);
  for (const bounds of [[null, to], [from, null], [to, from], ['-infinity', to], [from, 'infinity'], [from, new Date(Date.parse(from) + 93 * 86400000).toISOString()]]) await sqlDenied(() => direct(...bounds), '22023');
  await direct(from, new Date(Date.parse(from) + 92 * 86400000).toISOString());
  assert.deepEqual((await runtime.query('SELECT hon.current_organization_id() AS organization, hon.current_school_id() AS school')).rows[0], { organization: null, school: null });

  // Real HTTP composition, not just direct controller calls: the same production
  // identity guard, UUID pipes, global query validation and restricted DB service.
  const apiRequire = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
  const { NestFactory } = apiRequire('@nestjs/core');
  const { ValidationPipe } = apiRequire('@nestjs/common');
  const { issueSession, sessionConfig, HON_SESSION_COOKIE } = apiRequire('@hon/auth');
  const savedEnvironment = { ...process.env };
  Object.assign(process.env, { HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_SUMMARY_SESSION_SECRET_1234567890', HON_SESSION_AUDIENCE: 'summary-integration-test' });
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '0.0.0.0');
    const port = app.getHttpServer().address().port;
    const url = `http://127.0.0.1:${port}/v1/organizations/${ids.org}/operations/summary?${new URLSearchParams(query)}`;
    const token = issueSession({ externalSubject: subject, displayName: 'PRIVATE_SESSION_NAME', email: 'PRIVATE_SESSION_EMAIL@example.test' }, sessionConfig());
    const headers = { cookie: `${HON_SESSION_COOKIE}=${token}` };
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { cookie: `${HON_SESSION_COOKIE}=invalid` } })).status, 401);
    const success = await fetch(url, { headers }); assert.equal(success.status, 200);
    const payload = await success.json(); assert.deepEqual(payload.data.operationsSummary.aggregate, summary.aggregate);
    assert.equal(payload.data.operationsSummary.schoolCount, 3);
    assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_|personId|principalId|membershipId|provider|contacts|email|phone|staff/i);
    for (const injection of ['tier=COMPLETE', `schoolId=${ids.hidden}`, `principalId=${ids.principal}`, 'from=invalid']) {
      assert.equal((await fetch(`${url}&${injection}`, { headers })).status, 400);
    }
    assert.equal((await fetch(url.replace(ids.org, 'invalid-uuid'), { headers })).status, 400);
    assert.equal((await fetch(url.replace(ids.org, ids.foreignOrg), { headers })).status, 403);
    await admin.query("UPDATE hon.organization_entitlements SET tier='ESSENTIAL' WHERE organization_id=$1", [ids.org]);
    const essential = await fetch(url, { headers }); assert.equal(essential.status, 403);
    assert.equal((await essential.json()).code, 'TIER_ENTITLEMENT_REQUIRED');
    await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [ids.org]);
  } finally { await app.close(); process.env = savedEnvironment; }

  const after = (await admin.query(`SELECT
    (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1) AS audit,
    (SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1) AS outbox,
    (SELECT count(*) FROM hon.action_requests WHERE organization_id=$1) AS actions,
    (SELECT count(*) FROM hon.ai_usage_ledger WHERE organization_id=$1) AS ai,
    (SELECT sum(version) FROM hon.invoices WHERE organization_id=$1) AS invoices,
    (SELECT sum(version) FROM hon.crm_leads WHERE organization_id=$1) AS leads`, [ids.org])).rows[0];
  assert.deepEqual(after, before, 'Summary read wrote operational or execution evidence.');
  console.log('Verified Core/Complete-only live entitlement, active unambiguous human/effective reporting.view grants, exact authorized-school totals and per-school rows, revocation, same/cross-org isolation, half-open windows, separate currency totals, no raw/PII/provider data, runtime directory/HQ denial, read-only transaction success, real guarded HTTP/session/query validation and no side effects.');
} finally {
  try { await db.onModuleDestroy(); } finally { try { await cleanup(); } finally { await Promise.all([admin.end(), runtime.end()]); } }
}
