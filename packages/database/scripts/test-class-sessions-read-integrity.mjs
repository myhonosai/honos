import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyClassSessionsReadSecurity } from './class-sessions-read-security.mjs';
import { requireClassSessionsReadLocalUrls } from './class-sessions-read-local-guard.mjs';

requireClassSessionsReadLocalUrls();
const owner = new URL(process.env.DATABASE_URL ?? ''), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { ClassSessionsReadService } = await import('../../../apps/api/dist/schedule/class-sessions-read.service.js');
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false });
const restricted = new pg.Client({ connectionString: runtime.toString(), ssl: false });
const ids = Object.fromEntries(['org','school','otherSchool','user','staff','role','grant','program','otherProgram','family','mixedRole','mixedGrant','extraPrincipal','session'].map((key) => [key, randomUUID()]));
const subject = `class-sessions-${randomUUID()}`;
const context = (patch = {}) => ({ organizationId: ids.org, schoolId: ids.school, principalId: ids.staff, externalSubject: subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: '', ...patch });
const denied = (status = 403) => (error) => error?.getStatus?.() === status || error?.code === '42501';
function fields(item) { return Object.keys(item).sort(); }
async function snapshot() { return (await admin.query("SELECT coalesce(jsonb_object_agg(table_name,n),'{}') counts FROM (SELECT table_name,(xpath('/row/n/text()',query_to_xml(format('SELECT count(*) n FROM hon.%I',table_name),false,true,'')))[1]::text::bigint n FROM information_schema.tables WHERE table_schema='hon' AND table_type='BASE TABLE') rows")).rows[0].counts; }
await admin.connect(); await restricted.connect();
const db = new RuntimeDatabaseService(), service = new ClassSessionsReadService(db);
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: 'hon_class_sessions_read_owner', marker: 'HON disposable class sessions read validation' });
  // Canonical source: the reconciliation must itself re-grant 0147's single named
  // read function after its blanket function revoke, and never the private helper.
  const reconciliation = await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const blanketRevoke = reconciliation.indexOf('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA hon FROM hon_runtime;');
  const namedGrant = reconciliation.lastIndexOf('GRANT EXECUTE ON FUNCTION hon.read_current_school_class_sessions(text) TO hon_runtime;');
  assert(blanketRevoke >= 0 && namedGrant > blanketRevoke, 'Canonical reconciliation must re-grant the 0147 named read function after its blanket revoke.');
  assert.doesNotMatch(reconciliation, /GRANT[^;]*require_current_school_class_sessions_read_actor/i, 'Private authority helper must never be granted.');
  assert.doesNotMatch(reconciliation, /GRANT[^;]*read_current_school_class_sessions[^;]*TO\s+(?:PUBLIC|anon|authenticated|service_role)\b/i, 'Named read must not be granted to PUBLIC or client roles.');
  assert.doesNotMatch(reconciliation, /GRANT[^;]*read_current_school_class_sessions[^;]*WITH GRANT OPTION/i);
  const verifierSource = (await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8'))
    .split('-- Class Sessions current-school read exact verification:')[1]?.split('-- End Class Sessions current-school read exact verification.')[0];
  assert(verifierSource, 'Canonical Class Sessions read verifier block is missing.');
  const canonicalVerify = verifierSource.replaceAll('hon_runtime', runtime.username);
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_ORG','PRIVATE_ORG')", [ids.org]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_SCHOOL',$3),($4,$2,'OTHER_SCHOOL',$5)", [ids.school,ids.org,`school-${ids.school}`,ids.otherSchool,`school-${ids.otherSchool}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',now()-interval '1 day')", [ids.org]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_PERSON')", [ids.user,subject,`${ids.user}@example.test`]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_STAFF')", [ids.staff,ids.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'SESSION_READER','PRIVATE_ROLE')", [ids.role,ids.org]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'schedule.session.read')", [ids.role,ids.org]);
  await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,now()-interval '1 day')", [ids.grant,ids.org,ids.school,ids.staff,ids.role]);
  await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'PRIVATE_PROGRAM','SCHEDULED'),($4,$2,$5,'OTHER_PROGRAM','SCHEDULED')", [ids.program,ids.org,ids.school,ids.otherProgram,ids.otherSchool]);
  const expected = [];
  for (let i = 0; i < 51; i += 1) { const id = randomUUID(); expected.push(id); await admin.query(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,room_name,starts_at,ends_at,capacity,booking_policy,status,created_at)
    VALUES($1,$2,$3,$4,$5,$6,(date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')-interval '30 days'+$7::integer*interval '1 minute') AT TIME ZONE 'UTC',(date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')-interval '30 days'+($7::integer+30)*interval '1 minute') AT TIME ZONE 'UTC',$8,$9,$10,(date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')-interval '31 days') AT TIME ZONE 'UTC')`, [id,ids.org,ids.school,ids.program,`Session ${String(i).padStart(2,'0')}`,i % 2 ? 'Room A' : null,i,12,['WALK_IN','OPTIONAL_BOOKING','REQUIRED_BOOKING'][i % 3],['DRAFT','SCHEDULED','COMPLETED','SCHEDULED'][i % 4]]); }
  await admin.query("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status) VALUES($1,$2,$3,$4,'CROSS_SCHOOL_SECRET',now(),now()+interval '1 hour',99,'REQUIRED_BOOKING','SCHEDULED')", [ids.session,ids.org,ids.otherSchool,ids.otherProgram]);
  await admin.query("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status) VALUES($1,$2,$3,$4,'OUTSIDE_WINDOW',now()-interval '31 days',now()-interval '30 days',8,'WALK_IN','SCHEDULED')", [randomUUID(),ids.org,ids.school,ids.program]);
  const before = await snapshot();
  // Legitimate direct-human exact-school signed read, with the grant supplied only
  // by the (twice-applied) canonical reconciliation. On the unfixed
  // reconciliation this rejects with 403 because runtime lacks EXECUTE.
  const returned = await service.read(context());
  await verifyClassSessionsReadSecurity(admin, runtime.username);
  await admin.query(canonicalVerify);
  assert.equal(returned.length,50); assert.deepEqual(returned.map((item) => item.sessionId), expected.slice(0,50)); assert.deepEqual(fields(returned[0]),['bookingPolicy','capacity','createdAt','endsAt','name','roomName','sessionId','startsAt','status']);
  assert(returned.every((item, index) => Date.parse(item.startsAt) >= Date.parse(returned[0].startsAt) && (index === 0 || Date.parse(item.startsAt) >= Date.parse(returned[index - 1].startsAt))));
  assert(!JSON.stringify(returned).includes('CROSS_SCHOOL_SECRET')); assert(!JSON.stringify(returned).includes('OUTSIDE_WINDOW')); assert.deepEqual(await snapshot(), before, 'Read projection must write no table.');
  await assert.rejects(restricted.query('SELECT * FROM hon.class_sessions'), (error) => error.code === '42501');
  await assert.rejects(restricted.query('SELECT hon.require_current_school_class_sessions_read_actor($1)', [subject]), (error) => error.code === '42501');
  await assert.rejects(restricted.query('SELECT hon.read_current_school_class_sessions($1)', [subject]), (error) => error.code === '42501');
  for (const patch of [{ principalType: 'AI_EMPLOYEE' }, { source: 'AUTOMATION' }, { source: 'INTEGRATION' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }, { schoolId: ids.otherSchool }, { principalId: randomUUID() }, { externalSubject: 'other-subject' }]) await assert.rejects(service.read(context(patch)), denied());
  await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.org]); await assert.rejects(service.read(context()), denied()); await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.org]);
  const forbidden = (error) => error?.getStatus?.() === 403;
  await admin.query("UPDATE hon.organization_entitlements SET effective_until=now()-interval '1 second' WHERE organization_id=$1", [ids.org]); await assert.rejects(service.read(context()), forbidden, 'Expired entitlement must deny.'); await admin.query('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.org]);
  await admin.query("UPDATE hon.principal_role_grants SET effective_until=now()-interval '1 second' WHERE id=$1", [ids.grant]); await assert.rejects(service.read(context()), forbidden, 'Expired role grant must deny.'); await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1', [ids.grant]);
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=now(),revoked_by_principal_id=principal_id WHERE id=$1', [ids.grant]); await assert.rejects(service.read(context()), forbidden, 'Revoked role grant must deny.'); await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1', [ids.grant]);
  await assert.rejects(service.read(context({ schoolId: ids.otherSchool })), forbidden, 'Cross-school request must deny with 403.');
  await assert.rejects(service.read(context({ externalSubject: `unknown-${randomUUID()}` })), forbidden, 'Unknown signed subject must deny with 403.');
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='schedule.session.read'", [ids.role]); await assert.rejects(service.read(context()), denied()); await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'schedule.session.read')", [ids.role,ids.org]);
  await admin.query("INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role) VALUES($1,$2,'HON_HQ_OWNER')", [randomUUID(),ids.staff]); await assert.rejects(service.read(context()), denied()); await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1', [ids.staff]);
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PRIVATE_FAMILY')", [ids.family,ids.org,ids.school]);
  await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,'VIEWER',now()-interval '1 day',$4)", [ids.org,ids.school,ids.family,ids.staff]); await assert.rejects(service.read(context()), denied()); await admin.query('DELETE FROM hon.family_access_grants WHERE principal_id=$1', [ids.staff]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'PARENT_MIXED','PRIVATE_MIXED')", [ids.mixedRole,ids.org]); await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,now()-interval '1 day')", [ids.mixedGrant,ids.org,ids.school,ids.staff,ids.mixedRole]); await assert.rejects(service.read(context()), denied()); await admin.query('DELETE FROM hon.principal_role_grants WHERE id=$1', [ids.mixedGrant]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'DUPLICATE')", [ids.extraPrincipal,ids.user]); await assert.rejects(service.read(context()), denied()); await admin.query('DELETE FROM hon.principals WHERE id=$1', [ids.extraPrincipal]);
  const beforeFinalRead = await snapshot();
  assert.equal((await service.read(context())).length,50); assert.deepEqual(await snapshot(), beforeFinalRead, 'Denied and permitted reads must have no write effect.');
  for (const sql of ["GRANT SELECT ON hon.class_sessions TO hon_class_sessions_read_runtime", "GRANT EXECUTE ON FUNCTION hon.require_current_school_class_sessions_read_actor(text) TO hon_class_sessions_read_runtime", "ALTER TABLE hon.class_sessions NO FORCE ROW LEVEL SECURITY"]) { await admin.query('BEGIN'); try { await admin.query(sql); await assert.rejects(verifyClassSessionsReadSecurity(admin, runtime.username)); } finally { await admin.query('ROLLBACK'); } }
  // Canonical ACL drift detection: each widening or loss of the named grant fails the verifier.
  const rt = runtime.username;
  for (const sql of [`REVOKE EXECUTE ON FUNCTION hon.read_current_school_class_sessions(text) FROM ${rt}`,
    `GRANT EXECUTE ON FUNCTION hon.read_current_school_class_sessions(text) TO ${rt} WITH GRANT OPTION`,
    'GRANT EXECUTE ON FUNCTION hon.read_current_school_class_sessions(text) TO PUBLIC',
    `GRANT EXECUTE ON FUNCTION hon.require_current_school_class_sessions_read_actor(text) TO ${rt}`,
    'GRANT EXECUTE ON FUNCTION hon.require_current_school_class_sessions_read_actor(text) TO PUBLIC',
    'ALTER TABLE hon.class_sessions NO FORCE ROW LEVEL SECURITY']) { await admin.query('BEGIN'); try { await admin.query(sql); await assert.rejects(admin.query(canonicalVerify), /Class Sessions|class_sessions/, sql); } finally { await admin.query('ROLLBACK'); } }
  await admin.query(canonicalVerify);
  await verifyClassSessionsReadSecurity(admin, runtime.username);
  console.log('PASS: canonical reconciliation (applied twice) grants only the 0147 named read EXECUTE; disposable localhost current-school Class Sessions projection is fixed to 50 deterministic 30-day-back/90-day-forward operational facts, direct-human exact school/permission/entitlement only, function-only forced-RLS ACL, cross-school/roster/booking/attendance/payment/AI exclusion, and no write effect.');
} finally { await db.onModuleDestroy(); await restricted.end(); await admin.end(); }
