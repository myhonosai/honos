import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import pg from 'pg';
import { attendanceBackfillFixture, requireAttendanceBackfillLocalUrls } from './attendance-backfill-local-guard.mjs';

requireAttendanceBackfillLocalUrls();

const { database: fixtureDatabase, owner, runtime: runtimeRole, marker } = attendanceBackfillFixture;
const migrationStop = '0113_hq_ai_task_profiles.sql';
const migration114 = '0114_advanced_attendance_management.sql';
const migration115 = '0115_attendance_command_boundary.sql';
const legacyKey = randomUUID();
const urls = { DATABASE_URL: process.env.DATABASE_URL, HON_RUNTIME_DATABASE_URL: process.env.HON_RUNTIME_DATABASE_URL };
const secrets = Object.values(urls).map((url) => new URL(url).password);
const redact = (value) => secrets.reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), String(value));

function assertGuardedAliasesRejectRemoteAndUnmarkedTargets() {
  const saved = { DATABASE_URL: process.env.DATABASE_URL, HON_RUNTIME_DATABASE_URL: process.env.HON_RUNTIME_DATABASE_URL };
  try {
    process.env.DATABASE_URL = `postgresql://${owner}:fixture@remote.example:5432/${fixtureDatabase}`;
    assert.throws(requireAttendanceBackfillLocalUrls, /exact marked disposable localhost aliases/);
    process.env.DATABASE_URL = saved.DATABASE_URL;
    process.env.HON_RUNTIME_DATABASE_URL = `postgresql://${runtimeRole}:fixture@localhost:5432/unmarked_attendance_backfill`;
    assert.throws(requireAttendanceBackfillLocalUrls, /exact marked disposable localhost aliases/);
  } finally {
    process.env.DATABASE_URL = saved.DATABASE_URL;
    process.env.HON_RUNTIME_DATABASE_URL = saved.HON_RUNTIME_DATABASE_URL;
  }
}
assertGuardedAliasesRejectRemoteAndUnmarkedTargets();

let externalCalls = 0;
const forbidden = () => { externalCalls++; throw new Error('External/provider/HTTP execution forbidden'); };
const originalFetch = globalThis.fetch;
const originalHttpRequest = http.request, originalHttpGet = http.get, originalHttpsRequest = https.request, originalHttpsGet = https.get;
const originalConnect = net.Socket.prototype.connect;
globalThis.fetch = forbidden;
http.request = forbidden; http.get = forbidden; https.request = forbidden; https.get = forbidden;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const local = typeof options === 'object' ? options.port === 5432 && options.host === 'localhost' : options === 5432 && args[1] === 'localhost';
  if (!local) return forbidden();
  return originalConnect.apply(this, args);
};

function psql(sql, database = 'postgres') {
  const result = spawnSync('sudo', ['-u', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', database], { input: sql, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Local fixture administration failed (credentials redacted).');
}

function run(script, extraEnvironment = {}) {
  const environment = { ...process.env, ...urls, ...extraEnvironment };
  if (!Object.hasOwn(extraEnvironment, 'HON_MIGRATION_STOP_AFTER')) delete environment.HON_MIGRATION_STOP_AFTER;
  const result = spawnSync(process.execPath, [new URL(script, import.meta.url).pathname], {
    env: environment, encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Guarded local ${script} failed (credentials redacted): ${redact(result.stderr).slice(0, 1200)}`);
  return result.stdout;
}

function teardown() {
  psql(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='${fixtureDatabase}' AND pg_get_userbyid(datdba)='${owner}' AND shobj_description(oid,'pg_database')='${marker}') THEN RAISE EXCEPTION 'Refusing unmarked fixture database'; END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('${owner}','${runtimeRole}') AND shobj_description(oid,'pg_authid') IS DISTINCT FROM '${marker}') THEN RAISE EXCEPTION 'Refusing unmarked fixture roles'; END IF;
  END $$;
  DROP DATABASE ${fixtureDatabase} WITH (FORCE);
  DROP ROLE ${runtimeRole};
  DROP ROLE ${owner};`);
}

function assertPgDenied(operation) {
  return assert.rejects(operation, (error) => error?.code === '42501');
}

const ids = Object.fromEntries([
  'org', 'schoolA', 'schoolB', 'user', 'principal', 'role', 'grant', 'personA', 'personB', 'studentA', 'studentB', 'programA', 'programB',
].map((key) => [key, randomUUID()]));
const subject = `attendance-backfill-${randomUUID()}`;
const legacyStatuses = ['PRESENT', 'LATE', 'EXCUSED_ABSENCE', 'UNEXCUSED_ABSENCE', 'MAKEUP'];
const legacyFixture = legacyStatuses.map((status, index) => ({
  id: randomUUID(),
  session: randomUUID(),
  school: index < 3 ? ids.schoolA : ids.schoolB,
  student: index < 3 ? ids.studentA : ids.studentB,
  program: index < 3 ? ids.programA : ids.programB,
  status,
  version: index === 0 ? 7 : index + 1,
  note: `legacy ${status.toLowerCase()} note`,
}));
const unrelatedTables = [
  'action_requests', 'ai_usage_ledger', 'billing_accounts', 'communication_messages', 'curriculum_progress_observations',
  'invoices', 'membership_payment_schedules', 'payment_attempts', 'promotion_decisions', 'testing_candidates', 'work_items',
  'class_bookings', 'student_curriculum_enrollments', 'memberships', 'communication_consents',
];

let admin;
let rawRuntime;
let serviceDatabase;
try {
  run('./migrate.mjs', { HON_MIGRATION_STOP_AFTER: migrationStop });
  admin = new pg.Client({ connectionString: urls.DATABASE_URL, ssl: false });
  await admin.connect();

  const fixtureIdentity = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(fixtureIdentity, { owner, marker });
  const appliedBefore = (await admin.query('SELECT filename FROM hon.schema_migrations ORDER BY filename')).rows.map(({ filename }) => filename);
  assert(appliedBefore.includes(migrationStop));
  assert(!appliedBefore.includes(migration114));
  assert.deepEqual((await admin.query("SELECT enum_range(NULL::hon.attendance_status)::text[] statuses")).rows[0].statuses, legacyStatuses);
  const advancedColumnsBefore = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='hon' AND table_name='attendance_records' AND column_name=ANY($1::text[]) ORDER BY column_name", [['category', 'progression_policy_version', 'progression_enabled', 'progression_weight_milli', 'progression_credit_milli']])).rows;
  assert.equal(advancedColumnsBefore.length, 0, 'legacy fixture must use the actual pre-0114 table shape');

  const canonicalSource = await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const canonical = canonicalSource.replaceAll('hon_runtime', runtimeRole).replaceAll('FOR ROLE postgres', `FOR ROLE ${owner}`).replaceAll('DATABASE postgres', `DATABASE ${fixtureDatabase}`);
  const pre114Canonical = canonical.split('-- Advanced attendance:')[0];
  psql(pre114Canonical, fixtureDatabase);
  psql(pre114Canonical, fixtureDatabase);

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Attendance Backfill Local','Attendance Backfill Local')", [ids.org]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$3,'Backfill School A','backfill-a'),($2,$3,'Backfill School B','backfill-b')", [ids.schoolA, ids.schoolB, ids.org]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'ESSENTIAL','ACTIVE')", [ids.org]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,'backfill@example.test','Backfill Staff')", [ids.user, subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Backfill Staff')", [ids.principal, ids.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,management_school_id) VALUES($1,$2,'BACKFILL_ATTENDANCE','Backfill Attendance',$3)", [ids.role, ids.org, ids.schoolA]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'attendance.record')", [ids.role, ids.org]);
  await admin.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)', [ids.grant, ids.org, ids.schoolA, ids.principal, ids.role]);
  await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$3,$4,'Legacy','A'),($2,$3,$5,'Legacy','B')", [ids.personA, ids.personB, ids.org, ids.schoolA, ids.schoolB]);
  await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$3,$4,$2),($5,$3,$6,$7)', [ids.studentA, ids.personA, ids.org, ids.schoolA, ids.studentB, ids.schoolB, ids.personB]);
  await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$3,$4,'Legacy Program A','SCHEDULED'),($2,$3,$5,'Legacy Program B','SCHEDULED')", [ids.programA, ids.programB, ids.org, ids.schoolA, ids.schoolB]);
  for (const row of legacyFixture) {
    await admin.query("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status) VALUES($1,$2,$3,$4,'Legacy Session','2026-01-15T10:00:00Z','2026-01-15T11:00:00Z',20,'WALK_IN','SCHEDULED')", [row.session, ids.org, row.school, row.program]);
    await admin.query('INSERT INTO hon.attendance_records(id,organization_id,school_id,class_session_id,student_profile_id,status,recorded_by_principal_id,recorded_at,note,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6::hon.attendance_status,$7,\'2026-01-15T11:30:00Z\',$8,$9,\'2026-01-15T11:30:00Z\',\'2026-01-15T11:30:00Z\')', [row.id, ids.org, row.school, row.session, row.student, row.status, ids.principal, row.note, row.version]);
  }
  const historical=legacyFixture[0];
  const historicalBody={id:historical.id,classSessionId:historical.session,studentProfileId:historical.student,status:historical.status,recordedByPrincipalId:ids.principal,recordedAt:'2026-01-15T11:30:00.000Z',note:historical.note,version:historical.version,createdAt:'2026-01-15T11:30:00.000Z',updatedAt:'2026-01-15T11:30:00.000Z'};
  const legacyFingerprint=createHash('sha256').update(JSON.stringify({sessionId:historical.session,studentProfileId:historical.student,status:historical.status,note:historical.note,expectedVersion:historical.version})).digest('hex');
  await admin.query("INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,response_status,response_body,expires_at) VALUES($1,$2,$3,$4,$5,'COMPLETED',200,$6::jsonb,now()+interval '24 hours')",[ids.org,ids.schoolA,ids.principal,legacyKey,legacyFingerprint,JSON.stringify(historicalBody)]);
  await admin.query('COMMIT');

  const legacyBefore = (await admin.query("SELECT id,organization_id,school_id,class_session_id,student_profile_id,status::text,note,version,recorded_by_principal_id,recorded_at::text,created_at::text,updated_at::text FROM hon.attendance_records ORDER BY id")).rows;
  assert.equal(legacyBefore.length, legacyFixture.length);
  const unrelatedBefore = (await admin.query(`SELECT jsonb_build_object(${unrelatedTables.map((table) => `'${table}',(SELECT count(*)::int FROM hon.${table})`).join(',')}) data`)).rows[0].data;
  assert.deepEqual(unrelatedBefore, Object.fromEntries(unrelatedTables.map((table) => [table, 0])));

  await admin.end(); admin = undefined;
  run('./migrate.mjs');
  admin = new pg.Client({ connectionString: urls.DATABASE_URL, ssl: false });
  await admin.connect();
  const migrationRows = (await admin.query('SELECT filename FROM hon.schema_migrations WHERE filename=$1', [migration114])).rows;
  assert.equal(migrationRows.length, 1, '0114 must be applied once by the normal ordered migration runner');
  assert.equal((await admin.query('SELECT count(*)::int n FROM hon.schema_migrations WHERE filename=$1',[migration115])).rows[0].n,1,'0115 must close direct mutation after unchanged 0114 backfill');

  psql(canonical, fixtureDatabase);
  psql(canonical, fixtureDatabase);
  run('./verify-rls.mjs');

  const legacyAfter = (await admin.query("SELECT id,organization_id,school_id,class_session_id,student_profile_id,status::text,note,version,recorded_by_principal_id,recorded_at::text,created_at::text,updated_at::text FROM hon.attendance_records ORDER BY id")).rows;
  assert.deepEqual(legacyAfter, legacyBefore, '0114 must preserve legacy record identity, tenant, session, student, status, note, and version');
  const snapshots = (await admin.query("SELECT id,status::text,category,progression_policy_version,progression_enabled,progression_weight_milli,progression_credit_milli FROM hon.attendance_records ORDER BY id")).rows;
  for (const snapshot of snapshots) {
    assert.equal(snapshot.category, snapshot.status === 'MAKEUP' ? 'MAKEUP_CLASS' : 'REGULAR_PARTICIPANT');
    assert.equal(snapshot.progression_policy_version, 0);
    assert.equal(snapshot.progression_enabled, true);
    assert.equal(snapshot.progression_weight_milli, 1000);
    assert.equal(snapshot.progression_credit_milli, ['PRESENT', 'LATE', 'MAKEUP'].includes(snapshot.status) ? 1000 : 0);
  }
  const rls = (await admin.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace WHERE nspname='hon' AND relname=ANY($1::text[]) ORDER BY relname", [['attendance_progression_policies', 'attendance_policy_requests']])).rows;
  assert.deepEqual(rls.map((row) => [row.relname, row.relrowsecurity, row.relforcerowsecurity]), [['attendance_policy_requests', true, true], ['attendance_progression_policies', true, true]]);
  assert.equal((await admin.query("SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.attendance_records'::regclass AND tgname='attendance_credit_snapshot' AND tgfoid='hon.snapshot_attendance_credit()'::regprocedure AND tgenabled='O') active")).rows[0].active, true);

  rawRuntime = new pg.Client({ connectionString: urls.HON_RUNTIME_DATABASE_URL, ssl: false });
  await rawRuntime.connect();
  for (const table of ['attendance_progression_policies', 'attendance_policy_requests']) {
    assert.equal((await rawRuntime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [`hon.${table}`])).rows[0].allowed, false);
    await assertPgDenied(() => rawRuntime.query(`SELECT * FROM hon.${table}`));
  }
  assert.equal((await rawRuntime.query("SELECT has_table_privilege(current_user,'hon.attendance_records','SELECT') readable,has_table_privilege(current_user,'hon.attendance_records','INSERT,UPDATE') writable,has_any_column_privilege(current_user,'hon.attendance_records','INSERT,UPDATE') column_writable")).rows[0].writable,false);
  assert.equal((await rawRuntime.query("SELECT has_any_column_privilege(current_user,'hon.attendance_records','INSERT,UPDATE') allowed")).rows[0].allowed,false);
  async function raw(context,work) {
    await rawRuntime.query('BEGIN');
    try {
      await rawRuntime.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_source',$5,true),set_config('app.hon_external_subject',$6,true),set_config('app.hon_request_id',$7,true),set_config('app.hon_correlation_id',$8,true),set_config('app.hon_action_request_id',$9,true),set_config('app.hon_delegated_by_principal_id',$10,true)`,[context.organizationId,context.schoolId,context.principalId,context.principalType,context.source,context.externalSubject,context.requestId,context.correlationId,context.actionRequestId??'',context.delegatedByPrincipalId??'']);
      return await work(rawRuntime);
    } finally {await rawRuntime.query('ROLLBACK');}
  }
  const directContext={organizationId:ids.org,schoolId:ids.schoolA,principalId:ids.principal,principalType:'HUMAN_USER',externalSubject:subject,source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID()};
  for (const sql of [
    'UPDATE hon.attendance_records SET progression_credit_milli=9999 WHERE id=$1',
    "UPDATE hon.attendance_records SET status='LATE',category='OBSERVER',note='forged',version=version+1 WHERE id=$1",
    "INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status) SELECT organization_id,school_id,class_session_id,student_profile_id,'PRESENT' FROM hon.attendance_records WHERE id=$1",
  ]) await assertPgDenied(()=>raw(directContext,client=>client.query(sql,[legacyFixture[0].id])));
  const rawInput={studentProfileId:ids.studentA,status:'MAKEUP',expectedVersion:legacyFixture[0].version};
  const command=(context,request=context.requestId,correlation=context.correlationId)=>raw(context,client=>client.query('SELECT hon.record_attendance($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid)',[subject,legacyFixture[0].session,JSON.stringify(rawInput),context.idempotencyKey,request,correlation]));
  for (const [request,correlation] of [[randomUUID(),directContext.correlationId],[directContext.requestId,randomUUID()]]) await assert.rejects(()=>command(directContext,request,correlation),e=>e.code==='22023');
  for (const patch of [{principalType:'AI_EMPLOYEE'},{source:'AI'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]) await assertPgDenied(()=>command({...directContext,...patch}));
  assert.deepEqual((await admin.query("SELECT id,organization_id,school_id,class_session_id,student_profile_id,status::text,note,version,recorded_by_principal_id,recorded_at::text,created_at::text,updated_at::text FROM hon.attendance_records ORDER BY id")).rows,legacyBefore);

  const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
  const { AttendanceService } = await import('../../../apps/api/dist/schedule/attendance.service.js');
  serviceDatabase = new RuntimeDatabaseService();
  const attendance = new AttendanceService(serviceDatabase);
  const correctionContext = {
    organizationId: ids.org,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'HUMAN_USER',
    externalSubject: subject,
    source: 'HUMAN_UI',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: randomUUID(),
  };
  const corrected = await attendance.record(correctionContext, legacyFixture[0].session, {
    studentProfileId: ids.studentA,
    status: 'MAKEUP',
    expectedVersion: legacyFixture[0].version,
  });
  assert.equal(corrected.created, false);
  assert.equal(corrected.attendance.id, legacyFixture[0].id);
  assert.equal(corrected.attendance.version, legacyFixture[0].version + 1);
  assert.equal(corrected.attendance.category, 'MAKEUP_CLASS');
  assert.deepEqual([corrected.attendance.progressionPolicyVersion, corrected.attendance.progressionEnabled, corrected.attendance.progressionWeightMilli, corrected.attendance.progressionCreditMilli], [0, true, 1000, 1000]);
  // A real pre-0114 fingerprint/receipt replays history even after correction.
  const replayed=await attendance.record({...correctionContext,idempotencyKey:legacyKey},legacyFixture[0].session,{studentProfileId:ids.studentA,status:'PRESENT',note:legacyFixture[0].note,expectedVersion:legacyFixture[0].version});
  assert.equal(replayed.replayed,true); assert.equal(replayed.attendance.version,7); assert.equal(replayed.attendance.status,'PRESENT'); assert.equal(replayed.attendance.progressionPolicyVersion,0); assert.equal(replayed.attendance.category,'REGULAR_PARTICIPANT');
  await assert.rejects(()=>attendance.record({...correctionContext,idempotencyKey:legacyKey},legacyFixture[0].session,{studentProfileId:ids.studentA,status:'PRESENT',category:'OBSERVER',note:legacyFixture[0].note,expectedVersion:legacyFixture[0].version}),e=>e.getStatus()===409);
  assert.equal((await attendance.get(correctionContext,legacyFixture[0].session,ids.studentA)).version,8);
  const creationContext={...correctionContext,requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID()};
  const newSession=randomUUID();
  await admin.query("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status) VALUES($1,$2,$3,$4,'New Session',now(),now()+interval '1 hour',20,'WALK_IN','SCHEDULED')",[newSession,ids.org,ids.schoolA,ids.programA]);
  const created=await attendance.record(creationContext,newSession,{studentProfileId:ids.studentA,status:'PRESENT',note:'Private new note'});
  assert.equal(created.created,true);
  for (const [context,result] of [[correctionContext,corrected],[creationContext,created]]) {
    const a=result.attendance;
    const receipts=(await admin.query('SELECT status,response_status,response_body FROM hon.idempotency_records WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4',[ids.org,ids.schoolA,ids.principal,context.idempotencyKey])).rows;
    assert.equal(receipts.length,1); assert.equal(receipts[0].status,'COMPLETED'); assert.equal(receipts[0].response_status,result.created?201:200); assert.deepEqual(receipts[0].response_body,a);
    const audit=(await admin.query("SELECT request_id,correlation_id,next_state FROM hon.audit_events WHERE entity_id=$1 AND (next_state->>'version')::int=$2",[a.id,a.version])).rows;
    const outbox=(await admin.query("SELECT schema_version,status,attempt_count,correlation_id,causation_id,payload FROM hon.outbox_events WHERE aggregate_id=$1 AND aggregate_version=$2",[a.id,a.version])).rows;
    assert.equal(audit.length,1); assert.equal(outbox.length,1); assert.equal(audit[0].request_id,context.requestId); assert.equal(audit[0].correlation_id,context.correlationId); assert(!('note' in audit[0].next_state));
    assert.equal(outbox[0].schema_version,2); assert.equal(outbox[0].status,'PENDING'); assert.equal(outbox[0].attempt_count,0); assert.equal(outbox[0].correlation_id,context.correlationId); assert.equal(outbox[0].causation_id,context.requestId); assert.equal(outbox[0].payload.attendanceRecordId,a.id); assert.equal(outbox[0].payload.externalEffects,'NONE'); assert(!('note' in outbox[0].payload));
  }
  await assertPgDenied(() => rawRuntime.query("INSERT INTO hon.attendance_policy_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES($1,$2,$3,'forged','forged','{}')", [ids.org, ids.schoolA, ids.principal]));

  const unrelatedAfter = (await admin.query(`SELECT jsonb_build_object(${unrelatedTables.map((table) => `'${table}',(SELECT count(*)::int FROM hon.${table})`).join(',')}) data`)).rows[0].data;
  assert.deepEqual(unrelatedAfter, unrelatedBefore, 'backfill/correction must not mutate unrelated domain rows');
  const evidence = (await admin.query("SELECT (SELECT count(*)::int FROM hon.audit_events WHERE organization_id=$1 AND action_code='attendance.record') audit,(SELECT count(*)::int FROM hon.outbox_events WHERE organization_id=$1 AND event_type='attendance.recorded' AND payload->>'externalEffects'='NONE') outbox", [ids.org])).rows[0];
  assert.deepEqual(evidence, { audit: 2, outbox: 2 });
  assert.equal((await admin.query('SELECT count(*)::int n FROM hon.idempotency_records WHERE organization_id=$1',[ids.org])).rows[0].n,3);
  assert.equal(externalCalls, 0);
  console.log('Guarded attendance backfill/boundary proof passed: ordered 0001-0113 legacy seed, unchanged 0114 backfill plus 0115 command, canonical grants/RLS, historical receipt replay, create/correction atomic receipt/audit/inert outbox, direct runtime INSERT/UPDATE and forged command context denied, zero unrelated effects or external calls.');
} finally {
  await serviceDatabase?.onModuleDestroy();
  await rawRuntime?.end();
  await admin?.end();
  globalThis.fetch = originalFetch;
  http.request = originalHttpRequest; http.get = originalHttpGet; https.request = originalHttpsRequest; https.get = originalHttpsGet;
  net.Socket.prototype.connect = originalConnect;
  teardown();
}
