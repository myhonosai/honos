import { requireAttendanceLocalUrls } from './attendance-local-guard.mjs';
requireAttendanceLocalUrls();
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { AttendanceService } = await import('../../../apps/api/dist/schedule/attendance.service.js');
const { AttendancePolicyService } = await import('../../../apps/api/dist/schedule/attendance-policy.service.js');
const { AttendanceController } = await import('../../../apps/api/dist/schedule/attendance.controller.js');
const { AttendancePolicyController } = await import('../../../apps/api/dist/schedule/attendance-policy.controller.js');
const { ATTENDANCE_CATEGORIES, ATTENDANCE_STATUSES } = await import('../../contracts/dist/index.js');
let externalCalls = 0;
const forbidden = () => { externalCalls++; throw new Error('External/provider/HTTP execution forbidden'); };
globalThis.fetch = forbidden; http.request = forbidden; http.get = forbidden; https.request = forbidden; https.get = forbidden;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const local = typeof options === 'object' ? options.port === 5432 && options.host === 'localhost' : options === 5432 && args[1] === 'localhost';
  if (!local) return forbidden();
  return connect.apply(this, args);
};
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
const runtime = new pg.Client({ connectionString: process.env.HON_RUNTIME_DATABASE_URL, ssl: false });
const database = new RuntimeDatabaseService(), attendance = new AttendanceService(database), policies = new AttendancePolicyService(database);
const ids = Object.fromEntries(['org', 'school', 'otherSchool', 'user', 'principal', 'role', 'grant', 'program', 'otherProgram', 'session', 'otherSession', 'requiredSession', 'cancelledSession', 'ageProgram', 'ageSession', 'family'].map(k => [k, randomUUID()]));
const students = Array.from({ length: 22 }, () => ({ id: randomUUID(), person: randomUUID() }));
const subject = `attendance-local-${randomUUID()}`;
const ctx = (patch = {}) => { const requestId = randomUUID(); return { organizationId: ids.org, schoolId: ids.school, principalId: ids.principal, principalType: 'HUMAN_USER', externalSubject: subject, source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: randomUUID(), ...patch }; };
const baseRules = ATTENDANCE_CATEGORIES.map(category => ({ category, operationalAllowed: true, progressionEnabled: ['REGULAR_PARTICIPANT', 'MAKEUP_CLASS'].includes(category), weightMilli: ['REGULAR_PARTICIPANT', 'MAKEUP_CLASS'].includes(category) ? 1000 : 0 }));
const rules = (patch = {}) => baseRules.map(rule => ({ ...rule, ...(patch[rule.category] ?? {}) }));
const status = expected => error => error?.getStatus?.() === expected;
let groups = 0;
const checked = () => { groups++; };
const record = (student, input = {}, context = ctx(), session = ids.session) => attendance.record(context, session, { studentProfileId: students[student].id, status: 'PRESENT', ...input });
const configure = (expectedVersion, categories = rules(), context = ctx(), program = ids.program) => policies.configure(context, program, { expectedVersion, categories });
async function forbiddenEffects() {
  const tables = ['student_curriculum_enrollments', 'curriculum_progress_observations', 'promotion_decisions', 'testing_candidates', 'testing_events', 'memberships', 'membership_payment_schedules', 'billing_accounts', 'invoices', 'payment_attempts', 'class_bookings', 'action_requests', 'ai_usage_ledger', 'ai_invocation_plans', 'work_items', 'communication_messages', 'communication_consents'];
  return (await admin.query(`SELECT jsonb_build_object(${tables.map(t => `'${t}',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]'::jsonb) FROM hon.${t} x)`).join(',')}) data`)).rows[0].data;
}
async function evidence() {
  return (await admin.query('SELECT (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1)::int audit,(SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1)::int outbox,(SELECT count(*) FROM hon.attendance_records WHERE organization_id=$1)::int records,(SELECT count(*) FROM hon.attendance_progression_policies WHERE organization_id=$1)::int policies,(SELECT count(*) FROM hon.attendance_policy_requests WHERE organization_id=$1)::int requests,(SELECT count(*) FROM hon.idempotency_records WHERE organization_id=$1)::int receipts', [ids.org])).rows[0];
}
async function rawTransaction(context, work) {
  await runtime.query('BEGIN');
  try {
    await runtime.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),
      set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_source',$5,true),
      set_config('app.hon_external_subject',$6,true),set_config('app.hon_request_id',$7,true),set_config('app.hon_correlation_id',$8,true),
      set_config('app.hon_action_request_id',$9,true),set_config('app.hon_delegated_by_principal_id',$10,true)`,
      [context.organizationId,context.schoolId,context.principalId,context.principalType,context.source,context.externalSubject,
        context.requestId,context.correlationId,context.actionRequestId ?? '',context.delegatedByPrincipalId ?? '']);
    return await work(runtime);
  } finally { await runtime.query('ROLLBACK'); }
}
const rawCommand = (context, input = {studentProfileId:students[20].id,status:'PRESENT'}, request = context.requestId, correlation = context.correlationId, session = ids.session) => rawTransaction(context,
  client => client.query('SELECT hon.record_attendance($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) data', [context.externalSubject,session,JSON.stringify(input),context.idempotencyKey,request,correlation]));
async function matchingEvidence(context, command) {
  const a=command.attendance;
  const receipts=(await admin.query('SELECT status,response_status,response_body FROM hon.idempotency_records WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4', [context.organizationId,context.schoolId,context.principalId,context.idempotencyKey])).rows;
  assert.equal(receipts.length,1); assert.equal(receipts[0].status,'COMPLETED'); assert.equal(receipts[0].response_status,command.created?201:200); assert.deepEqual(receipts[0].response_body,a);
  const audits=(await admin.query("SELECT * FROM hon.audit_events WHERE organization_id=$1 AND action_code='attendance.record' AND entity_id=$2 AND (next_state->>'version')::int=$3", [ids.org,a.id,a.version])).rows;
  const outboxes=(await admin.query("SELECT * FROM hon.outbox_events WHERE organization_id=$1 AND event_type='attendance.recorded' AND aggregate_id=$2 AND aggregate_version=$3", [ids.org,a.id,a.version])).rows;
  assert.equal(audits.length,1); assert.equal(outboxes.length,1);
  const audit=audits[0], outbox=outboxes[0];
  assert.equal(audit.school_id,ids.school); assert.equal(audit.actor_principal_id,context.principalId); assert.equal(audit.source,'HUMAN_UI'); assert.equal(audit.request_id,context.requestId); assert.equal(audit.correlation_id,context.correlationId); assert.equal(audit.action_request_id,null); assert.equal(audit.delegated_by_principal_id,null);
  const {note,...safe}=a; assert.deepEqual(audit.next_state,safe); assert(!JSON.stringify(audit.prior_state).includes('Private note'));
  assert.equal(outbox.school_id,ids.school); assert.equal(outbox.schema_version,2); assert.equal(outbox.status,'PENDING'); assert.equal(outbox.attempt_count,0); assert.equal(outbox.published_at,null); assert.equal(outbox.correlation_id,context.correlationId); assert.equal(outbox.causation_id,context.requestId);
  assert.equal(outbox.payload.externalEffects,'NONE'); assert.equal(outbox.payload.attendanceRecordId,a.id); assert.equal(outbox.payload.version,a.version); assert.equal(outbox.payload.progressionCreditMilli,a.progressionCreditMilli); assert.equal(outbox.payload.operation,command.created?'CREATED':'UPDATED'); assert(!('note' in outbox.payload));
}
await admin.connect(); await runtime.connect();
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()" )).rows[0];
  assert.equal(marker.owner, 'hon_attendance_owner'); assert.equal(marker.marker, 'HON disposable attendance validation');
  const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const block = canonical.split('-- Advanced attendance exact verification:')[1].split('-- End advanced attendance exact verification.')[0];
  await admin.query(block.replaceAll('hon_runtime', 'hon_attendance_runtime')); checked();
  const role = (await runtime.query('SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.equal(role.rolcanlogin, true); for (const [k,v] of Object.entries(role)) if (k !== 'rolcanlogin') assert.equal(v, false);
  for (const table of ['attendance_progression_policies', 'attendance_policy_requests', 'users', 'principals', 'schools', 'role_permissions']) await assert.rejects(() => runtime.query(`SELECT * FROM hon.${table}`), e => e.code === '42501');
  await assert.rejects(() => runtime.query('SELECT hon.read_attendance_policy($1,$2)', [subject, ids.program]), e => e.code === '42501'); checked();
  for (const column of ['progression_policy_version','progression_enabled','progression_weight_milli','progression_credit_milli']) {
    assert.equal((await runtime.query("SELECT has_column_privilege(current_user,'hon.attendance_records',$1,'UPDATE') AS granted", [column])).rows[0].granted, false);
  }
  checked();

  await admin.query('BEGIN');
  await admin.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,\'Attendance Local\',\'Attendance Local\')', [ids.org]);
  await admin.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$3,\'School A\',$1::uuid::text),($2,$3,\'School B\',$2::uuid::text)', [ids.school, ids.otherSchool, ids.org]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'ESSENTIAL','ACTIVE')", [ids.org]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$1::uuid::text||'@example.test','Local Staff')", [ids.user, subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Local Staff')", [ids.principal, ids.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,management_school_id) VALUES($1,$2,$1::uuid::text,'Attendance Staff',$3)", [ids.role, ids.org, ids.school]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'attendance.record'),($1,$2,'attendance.policy.manage')", [ids.role, ids.org]);
  await admin.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)', [ids.grant, ids.org, ids.school, ids.principal, ids.role]);
  for (let i = 0; i < students.length; i++) {
    const s = students[i], school = i === 21 ? ids.otherSchool : ids.school;
    await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Local','Student')", [s.person, ids.org, school]);
    await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [s.id, ids.org, school, s.person]);
  }
  await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$3,$4,'Program A','SCHEDULED'),($2,$3,$5,'Program B','SCHEDULED'),($6,$3,$4,'Age evidence program','SCHEDULED')", [ids.program, ids.otherProgram, ids.org, ids.school, ids.otherSchool, ids.ageProgram]);
  await admin.query('UPDATE hon.programs SET minimum_age_months=60 WHERE id=$1', [ids.ageProgram]);
  for (const [session, program, school, booking, state, reason] of [
    [ids.session,ids.program,ids.school,'WALK_IN','SCHEDULED',null], [ids.otherSession,ids.otherProgram,ids.otherSchool,'WALK_IN','SCHEDULED',null],
    [ids.requiredSession,ids.program,ids.school,'REQUIRED_BOOKING','SCHEDULED',null], [ids.cancelledSession,ids.program,ids.school,'WALK_IN','CANCELLED','Closure'],
    [ids.ageSession,ids.ageProgram,ids.school,'WALK_IN','SCHEDULED',null],
  ]) await admin.query('INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status,cancellation_reason) VALUES($1,$2,$3,$4,\'Local Session\',now(),now()+interval \'1 hour\',30,$5,$6,$7)', [session,ids.org,school,program,booking,state,reason]);
  for (const [i,kind] of [[2,'TRIAL'],[3,'PRIVATE_LESSON'],[4,'EVENT'],[5,'MAKEUP']]) await admin.query("INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,status,source) VALUES($1,$2,$3,$4,$5,'BOOKED','STAFF')", [ids.org,ids.school,ids.session,students[i].id,kind]);
  await admin.query('COMMIT');
  const noEffects = await forbiddenEffects();
  const deniedBefore=await evidence();
  for (const sql of [
    'INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status) VALUES($1,$2,$3,$4,\'PRESENT\')',
    'UPDATE hon.attendance_records SET status=\'LATE\',category=\'OBSERVER\',note=\'forged\',version=version+1 WHERE organization_id=$1 AND school_id=$2 AND class_session_id=$3 AND student_profile_id=$4',
  ]) await assert.rejects(() => rawTransaction(ctx(),client => client.query(sql,[ids.org,ids.school,ids.session,students[0].id])),e=>e.code==='42501');
  assert.deepEqual(await evidence(),deniedBefore); checked();
  // Raw fixed calls cannot spoof request/correlation or evade the DB actor guard.
  const directContext=ctx();
  for (const [request,correlation] of [[randomUUID(),directContext.correlationId],[directContext.requestId,randomUUID()]]) await assert.rejects(() => rawCommand(directContext,undefined,request,correlation),e=>e.code==='22023');
  for (const patch of [{principalType:'AI_EMPLOYEE'},{source:'AI'},{delegatedByPrincipalId:randomUUID()},{actionRequestId:randomUUID()},{externalSubject:'not-verified'}]) await assert.rejects(() => rawCommand(ctx(patch)),e=>e.code==='42501');
  for (const input of [null,[],{}, {studentProfileId:students[20].id,status:'BAD'}, {studentProfileId:students[20].id,status:'PRESENT',category:null}, {studentProfileId:students[20].id,status:'PRESENT',expectedVersion:0}, {studentProfileId:students[20].id,status:'PRESENT',expectedVersion:1.1}, {studentProfileId:students[20].id,status:'PRESENT',note:' unsafe '}, {studentProfileId:students[20].id,status:'PRESENT',note:'private\ncontrol'}, {studentProfileId:students[20].id,status:'PRESENT',note:'x'.repeat(2001)}, {studentProfileId:students[20].id,status:'PRESENT',note:'😀'.repeat(1001)}, {studentProfileId:students[20].id,status:'PRESENT',progressionCreditMilli:9000}]) await assert.rejects(() => rawCommand(ctx(),input),e=>e.code==='22023');
  for (const idempotencyKey of ['', ' ', ' padded ', 'control\nkey']) await assert.rejects(() => rawCommand(ctx({idempotencyKey})),e=>e.code==='22023');
  assert.deepEqual(await evidence(),deniedBefore); checked();
  // A normal raw command succeeds, but this inspection rolls the whole command back.
  const rawSuccess=await rawCommand(ctx()); assert.equal(rawSuccess.rows[0].data.created,true); assert.equal(rawSuccess.rows[0].data.attendance.progressionCreditMilli,1000);
  assert.deepEqual(await evidence(),deniedBefore); checked();

  const initial = await policies.get(ctx(), ids.program); assert.equal(initial.version, 0); assert.deepEqual(initial.categories, baseRules); checked();

  for (const operation of [() => configure(0,rules(),ctx({schoolId:ids.otherSchool}),ids.otherProgram), () => policies.get(ctx(),ids.otherProgram), () => record(21), () => record(0,{},ctx(),ids.otherSession)]) await assert.rejects(operation, e => [403,404].includes(e.getStatus()));
  const hidden = await database.withTenantTransaction(ctx(), async client => (await client.query('SELECT id FROM hon.class_sessions WHERE id=$1',[ids.otherSession])).rows);
  assert.deepEqual(hidden, []); checked();

  const legacyContext=ctx();
  const legacy = await record(0, { note: 'Private note must not reach outbox' },legacyContext);
  await matchingEvidence(legacyContext,legacy);
  const existingBefore=await evidence();
  await assert.rejects(()=>rawTransaction(ctx(),client=>client.query("UPDATE hon.attendance_records SET status='LATE',note='forged',version=version+1 WHERE id=$1",[legacy.attendance.id])),e=>e.code==='42501');
  assert.deepEqual(await evidence(),existingBefore); assert.equal((await attendance.get(ctx(),ids.session,students[0].id)).version,1); checked();
  assert.equal(legacy.attendance.category,'REGULAR_PARTICIPANT'); assert.equal(legacy.attendance.progressionCreditMilli,1000); assert.equal(legacy.attendance.progressionPolicyVersion,0);
  const key = ctx(), input = {studentProfileId:students[1].id,status:'PRESENT',category:'OBSERVER'};
  const observation = await attendance.record(key,ids.session,input); assert.equal(observation.attendance.progressionCreditMilli,0);
  const beforeReplay = await evidence();
  assert.equal((await attendance.record(key,ids.session,input)).replayed,true);
  assert.equal((await record(1,{category:'OBSERVER'})).replayed,true);
  assert.deepEqual(await evidence(),{...beforeReplay,receipts:beforeReplay.receipts+1});
  await assert.rejects(() => attendance.record(key,ids.session,{...input,category:'GUEST_DROP_IN'}),status(409)); checked();
  const pendingContext=ctx(), pendingInput={studentProfileId:students[20].id,status:'PRESENT'};
  const pendingFingerprint=createHash('sha256').update(JSON.stringify({sessionId:ids.session,category:'REGULAR_PARTICIPANT',studentProfileId:students[20].id,status:'PRESENT',note:null})).digest('hex');
  await admin.query("INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at) VALUES($1,$2,$3,$4,$5,'IN_PROGRESS',now()+interval '24 hours')",[ids.org,ids.school,ids.principal,pendingContext.idempotencyKey,pendingFingerprint]);
  const pendingBefore=await evidence(); await assert.rejects(() => attendance.record(pendingContext,ids.session,pendingInput),status(409)); assert.deepEqual(await evidence(),pendingBefore);
  await admin.query('DELETE FROM hon.idempotency_records WHERE organization_id=$1 AND idempotency_key=$2',[ids.org,pendingContext.idempotencyKey]); checked();
  // The same key belongs to a different verified principal, never another actor's receipt.
  const secondUser=randomUUID(),secondPrincipal=randomUUID(),secondSubject=`attendance-local-second-${randomUUID()}`;
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$1::uuid::text||'@example.test','Second staff')",[secondUser,secondSubject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Second staff')",[secondPrincipal,secondUser]);
  await admin.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$3)',[ids.org,ids.school,secondPrincipal,ids.role]);
  const secondContext=ctx({principalId:secondPrincipal,externalSubject:secondSubject,idempotencyKey:key.idempotencyKey});
  const secondRecord=await record(19,{},secondContext); assert.equal(secondRecord.created,true); await matchingEvidence(secondContext,secondRecord);
  await assert.rejects(()=>record(19,{},ctx({idempotencyKey:key.idempotencyKey})),status(409));
  assert.equal((await record(19,{},secondContext)).replayed,true); checked();



  for (const [i, category] of [[2,'TRIAL_STUDENT'],[3,'PRIVATE_LESSON'],[4,'SPECIAL_EVENT'],[5,'MAKEUP_CLASS'],[6,'GUEST_DROP_IN']]) {
    const result=await record(i,{category}); assert.equal(result.attendance.category,category);
    const booking=(await admin.query('SELECT id FROM hon.class_bookings WHERE class_session_id=$1 AND student_profile_id=$2',[ids.session,students[i].id])).rows[0];
    assert.equal(result.attendance.classBookingId,booking?.id);
  }
  for (const category of ['TRIAL_STUDENT','PRIVATE_LESSON','SPECIAL_EVENT','MAKEUP_CLASS']) await assert.rejects(() => record(7,{category}),status(400));
  await assert.rejects(() => record(7,{},ctx(),ids.requiredSession),status(400));
  await assert.rejects(() => record(7,{},ctx(),ids.cancelledSession),status(400));
  await assert.rejects(() => record(7,{},ctx(),ids.ageSession),status(400)); checked();

  const pkey = ctx(), version1 = rules({REGULAR_PARTICIPANT:{weightMilli:1500},OBSERVER:{progressionEnabled:false,weightMilli:9000},GUEST_DROP_IN:{operationalAllowed:false}});
  const configured = await configure(0,version1,pkey); assert.equal(configured.policy.version,1);
  const afterPolicy = await evidence();
  assert.equal((await configure(0,version1,pkey)).replayed,true); assert.deepEqual(await evidence(),afterPolicy);
  await assert.rejects(() => configure(0,version1),status(409));
  await assert.rejects(() => configure(1,rules(),pkey),status(409));
  await assert.rejects(() => configure(1,rules().slice(1)),status(400));
  await assert.rejects(() => configure(1,rules({OBSERVER:{weightMilli:10001}})),status(400));
  await assert.rejects(() => configure(1,rules({OBSERVER:{weightMilli:0.1}})),status(400)); checked();
  const snap = await record(8); assert.equal(snap.attendance.progressionPolicyVersion,1); assert.equal(snap.attendance.progressionCreditMilli,1500);
  assert.equal((await attendance.get(ctx(),ids.session,students[0].id)).progressionCreditMilli,1000);
  const zero = await record(9,{category:'OBSERVER'}); assert.equal(zero.attendance.progressionWeightMilli,9000); assert.equal(zero.attendance.progressionCreditMilli,0);
  await assert.rejects(() => record(10,{category:'GUEST_DROP_IN'}),status(400)); checked();

  const concurrent = await Promise.all([record(11),record(11)]);
  assert.equal(concurrent.filter(x => x.created).length,1); assert.equal(concurrent.filter(x => x.replayed).length,1);
  const samePolicy = ctx(); const cp = await Promise.all([configure(1,rules(),samePolicy),configure(1,rules(),samePolicy)]);
  assert.equal(cp.filter(x => x.replayed).length,1); assert.equal(cp[0].policy.version,2); checked();
  // Duplicate attendance preserves the old snapshot even after policy changes.
  assert.equal((await record(8)).attendance.progressionCreditMilli,1500);
  await assert.rejects(() => record(8,{status:'LATE'}),status(409));
  await assert.rejects(() => record(8,{status:'LATE',expectedVersion:9}),status(409));
  const correctionContext=ctx(); const correction = await record(8,{status:'LATE',expectedVersion:1},correctionContext); await matchingEvidence(correctionContext,correction); assert.equal(correction.attendance.version,2); assert.equal(correction.attendance.progressionCreditMilli,1000); assert.equal(correction.attendance.progressionPolicyVersion,2);
  await assert.rejects(() => record(8,{status:'LATE',expectedVersion:1}),status(409));
  const race = await Promise.allSettled([record(8,{status:'EXCUSED_ABSENCE',expectedVersion:2}),record(8,{status:'UNEXCUSED_ABSENCE',expectedVersion:2})]);
  assert.equal(race.filter(x => x.status==='fulfilled').length,1); assert.equal(race.filter(x => x.status==='rejected').length,1);
  assert.equal((await attendance.get(ctx(),ids.session,students[8].id)).progressionCreditMilli,0); checked();

  // Legacy status semantics: omission maps MAKEUP only, not fabricated trials.
  for (let i=0;i<ATTENDANCE_STATUSES.length;i++) {
    const value=ATTENDANCE_STATUSES[i], result=await record(12+i,{status:value});
    assert.equal(result.attendance.category,value==='MAKEUP'?'MAKEUP_CLASS':'REGULAR_PARTICIPANT');
    assert.equal(result.attendance.progressionCreditMilli,['PRESENT','LATE','MAKEUP'].includes(value)?1000:0);
  }
  // Legacy idempotency receipts retain their historical status/version interpretation.
  await admin.query("UPDATE hon.idempotency_records SET response_body=response_body-'category'-'progressionPolicyVersion'-'progressionEnabled'-'progressionWeightMilli'-'progressionCreditMilli' WHERE organization_id=$1 AND idempotency_key=$2",[ids.org,key.idempotencyKey]);
  const oldReceipt = await attendance.record(key,ids.session,input); assert.equal(oldReceipt.attendance.progressionPolicyVersion,0); checked();

  // Live revocation blocks both new operations and successful old receipts.
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=now(),revoked_by_principal_id=principal_id WHERE id=$1',[ids.grant]);
  await assert.rejects(() => attendance.record(key,ids.session,input),status(403)); await assert.rejects(() => configure(0,version1,pkey),status(403));
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[ids.grant]);
  await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[ids.org]);
  await assert.rejects(() => record(17),status(403)); await assert.rejects(() => policies.get(ctx(),ids.program),status(403));
  await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[ids.org]);
  await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1',[ids.principal]); await assert.rejects(() => record(17),status(403));
  await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1',[ids.principal]); checked();
  for (const patch of [{principalType:'AI_EMPLOYEE'},{source:'AI'},{delegatedByPrincipalId:randomUUID()},{actionRequestId:randomUUID()},{externalSubject:'not-verified'}]) {
    await assert.rejects(() => record(17,{},ctx(patch)),status(403)); await assert.rejects(() => configure(2,rules(),ctx(patch)),status(403));
  }
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Local Family')",[ids.family,ids.org,ids.school]);
  await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4)",[ids.org,ids.school,ids.family,ids.principal]);
  await assert.rejects(() => policies.get(ctx(),ids.program),status(403));
  await admin.query('DELETE FROM hon.family_access_grants WHERE principal_id=$1',[ids.principal]); checked();

  // An independently committed role/entitlement change during a lock wait must
  // be observed by the command after the wait, including replay.
  await admin.query('BEGIN'); await admin.query('SELECT id FROM hon.organizations WHERE id=$1 FOR UPDATE',[ids.org]);
  const waiting = attendance.record(key,ids.session,input);
  await new Promise(resolve => setTimeout(resolve,100));
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='attendance.record'",[ids.role]); await admin.query('COMMIT');
  await assert.rejects(() => waiting,status(403));
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'attendance.record')",[ids.role,ids.org]); checked();

  // Evidence failure rolls the record/policy/replay receipt back atomically.
  for (const failingTable of ['audit_events','outbox_events']) {
    const before = await evidence();
    await admin.query(`CREATE FUNCTION hon.local_attendance_evidence_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${ids.org}'::uuid THEN RAISE EXCEPTION 'Injected local evidence failure'; END IF; RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER local_attendance_evidence_failure BEFORE INSERT ON hon.${failingTable} FOR EACH ROW EXECUTE FUNCTION hon.local_attendance_evidence_failure()`);
    try {
      await assert.rejects(() => record(18),/Injected local evidence failure/); assert.deepEqual(await evidence(),before);
      await assert.rejects(() => record(0,{status:'LATE',expectedVersion:1}),/Injected local evidence failure/); assert.deepEqual(await evidence(),before);
      assert.equal((await attendance.get(ctx(),ids.session,students[0].id)).version,1);
    } finally {
      await admin.query(`DROP TRIGGER local_attendance_evidence_failure ON hon.${failingTable}`);
      await admin.query('DROP FUNCTION hon.local_attendance_evidence_failure()');
    }
  }
  const policyBefore = await evidence();
  await admin.query(`CREATE FUNCTION hon.local_attendance_policy_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${ids.org}'::uuid AND NEW.action_code='attendance.policy.manage' THEN RAISE EXCEPTION 'Local policy audit failure'; END IF; RETURN NEW; END $$`);
  await admin.query('CREATE TRIGGER local_attendance_policy_audit_failure BEFORE INSERT ON hon.audit_events FOR EACH ROW EXECUTE FUNCTION hon.local_attendance_policy_audit_failure()');
  await assert.rejects(() => configure(2,rules()),/Local policy audit failure/); assert.deepEqual(await evidence(),policyBefore);
  await admin.query('DROP TRIGGER local_attendance_policy_audit_failure ON hon.audit_events');
  await admin.query('DROP FUNCTION hon.local_attendance_policy_audit_failure()');
  await admin.query(`CREATE FUNCTION hon.local_attendance_policy_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${ids.org}'::uuid AND NEW.aggregate_type='ATTENDANCE_PROGRESSION_POLICY' THEN RAISE EXCEPTION 'Local policy outbox failure'; END IF; RETURN NEW; END $$`);
  await admin.query('CREATE TRIGGER local_attendance_policy_outbox_failure BEFORE INSERT ON hon.outbox_events FOR EACH ROW EXECUTE FUNCTION hon.local_attendance_policy_outbox_failure()');
  await assert.rejects(() => configure(2,rules()),/Local policy outbox failure/); assert.deepEqual(await evidence(),policyBefore);
  await admin.query('DROP TRIGGER local_attendance_policy_outbox_failure ON hon.outbox_events');
  await admin.query('DROP FUNCTION hon.local_attendance_policy_outbox_failure()');
  checked();
  const events = (await admin.query("SELECT payload FROM hon.outbox_events WHERE organization_id=$1 AND event_type='attendance.recorded'",[ids.org])).rows;
  assert(events.length>0); for (const {payload} of events) { assert.equal(payload.externalEffects,'NONE'); assert(!('note' in payload)); assert.equal(typeof payload.progressionCreditMilli,'number'); }
  const audits=(await admin.query("SELECT prior_state,next_state FROM hon.audit_events WHERE organization_id=$1 AND action_code='attendance.record'",[ids.org])).rows;
  assert(!JSON.stringify(audits).includes('Private note')); assert.deepEqual(await forbiddenEffects(),noEffects); assert.equal(externalCalls,0); checked();

  // Actual controller API methods share the validated normal service vertical.
  const response={setHeader(){},status(){}}; const request={honIdentity:{externalSubject:subject}};
  const controller=new AttendanceController(database,attendance), policyController=new AttendancePolicyController(database,policies);
  assert.equal((await controller.get(ids.org,ids.school,ids.session,students[0].id,request,response)).data.id,legacy.attendance.id);
  assert.equal((await policyController.get(ids.org,ids.school,ids.program,request,response)).data.version,2);
  await assert.rejects(() => policyController.get(ids.org,ids.otherSchool,ids.otherProgram,request,response),status(403)); checked();
  console.log(`Advanced attendance local restricted-runtime proof passed (${groups} assertion groups); zero external/provider calls and zero unrelated domain mutations.`);
} finally {
  await database.onModuleDestroy(); await runtime.end(); await admin.end(); net.Socket.prototype.connect=connect;
}
