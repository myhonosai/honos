import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { RuntimeDatabaseService } from '../../../apps/api/dist/foundation/runtime-database.service.js';
import { InstructorQualificationsService } from '../../../apps/api/dist/instructor-qualifications/instructor-qualifications.service.js';
import { InstructorQualificationsController } from '../../../apps/api/dist/instructor-qualifications/instructor-qualifications.controller.js';

const databaseName = 'hon_instructor_qualification_validation';
const ownerRole = 'hon_instructor_qualification_owner';
const runtimeRole = 'hon_instructor_qualification_runtime';
const ownerUrl = new URL(process.env.DATABASE_URL ?? '');
const runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
for (const [url, role] of [[ownerUrl, ownerRole], [runtimeUrl, runtimeRole]]) {
  if (url.hostname !== 'localhost' || url.port !== '5432' || url.pathname !== `/${databaseName}` || url.username !== role) {
    throw new Error('Only exact disposable localhost instructor-qualification owner/runtime aliases may run this test. Remote targets are refused.');
  }
}

const admin = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const runtime = new pg.Client({ connectionString: runtimeUrl.toString(), ssl: false });
const database = new RuntimeDatabaseService();
const service = new InstructorQualificationsService(database);
const controller = new InstructorQualificationsController(database, service);
const ids = Object.fromEntries(['org', 'otherOrg', 'school', 'siblingSchool', 'otherSchool', 'program', 'otherProgram', 'managerRole', 'readerRole', 'staffRole', 'parentRole', 'hqRole', 'otherRole', 'family'].map(name => [name, randomUUID()]));
const actors = Object.fromEntries(['manager', 'reader', 'staff', 'parent', 'hq', 'inactive', 'other'].map(name => [name, { id: randomUUID(), user: randomUUID(), subject: `qualification-${name}-${randomUUID()}` }]));
const ai = { id: randomUUID(), subject: `qualification-ai-${randomUUID()}` };
const privateTables = ['instructor_qualifications', 'instructor_qualification_revisions', 'instructor_qualification_evidence', 'instructor_qualification_evidence_reviews', 'instructor_qualification_requests', 'instructor_qualification_outbox'];
const forbiddenTables = ['programs', 'class_templates', 'class_sessions', 'class_session_instructors', 'class_bookings', 'attendance_records', 'testing_events', 'testing_candidates', 'promotion_decisions', 'memberships', 'membership_payment_schedules', 'invoices', 'payment_attempts', 'communication_messages', 'action_requests', 'action_approvals', 'ai_usage_ledger', 'ai_invocation_plans', 'outbox_events'];

const context = (actor = 'manager', patch = {}) => ({
  organizationId: actor === 'other' ? ids.otherOrg : ids.org,
  schoolId: actor === 'other' ? ids.otherSchool : ids.school,
  principalId: actors[actor]?.id ?? actors.manager.id,
  externalSubject: actors[actor]?.subject ?? actors.manager.subject,
  principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), ...patch,
});
const definitionInput = (patch = {}) => ({ code: 'FIRST_AID', title: 'First aid training', kind: 'QUALIFICATION', courseProgramId: ids.program, ...patch });
const evidenceInput = (qualificationId, patch = {}) => ({ qualificationId, expectedQualificationVersion: 1, attainedOn: '2026-01-10', expiresOn: '2028-01-10', evidenceReference: 'Internal first aid ledger', ...patch });
const reviewInput = (expectedReviewVersion, patch = {}) => ({ expectedReviewVersion, status: 'REVIEWED', reviewNote: 'Human internal review recorded', ...patch });
const status = expected => error => { assert.equal(error.getStatus?.(), expected, error.stack); return true; };
const sqlDenied = (work, code = '42501') => assert.rejects(work, error => { assert.equal(error.code, code, error.stack); return true; });

async function direct(ctx, work) {
  await runtime.query('BEGIN');
  try {
    for (const [key, value] of Object.entries({
      organization_id: ctx.organizationId, school_id: ctx.schoolId, principal_id: ctx.principalId,
      principal_type: ctx.principalType, source: ctx.source, request_id: ctx.requestId,
      action_request_id: ctx.actionRequestId ?? '', delegated_by_principal_id: ctx.delegatedByPrincipalId ?? '',
    })) await runtime.query('SELECT set_config($1,$2,true)', [`app.hon_${key}`, value]);
    const value = await work(); await runtime.query('COMMIT'); return value;
  } catch (error) { await runtime.query('ROLLBACK'); throw error; }
}
async function directRollback(ctx, work) {
  await runtime.query('BEGIN');
  try {
    for (const [key, value] of Object.entries({
      organization_id: ctx.organizationId, school_id: ctx.schoolId, principal_id: ctx.principalId,
      principal_type: ctx.principalType, source: ctx.source, request_id: ctx.requestId,
      action_request_id: ctx.actionRequestId ?? '', delegated_by_principal_id: ctx.delegatedByPrincipalId ?? '',
    })) await runtime.query('SELECT set_config($1,$2,true)', [`app.hon_${key}`, value]);
    return await work();
  } finally { await runtime.query('ROLLBACK'); }
}
async function snapshot(tables) {
  const snapshot = {};
  for (const table of tables) snapshot[table] = (await admin.query(`SELECT to_jsonb(t) record FROM hon.${table} t WHERE organization_id=$1 ORDER BY to_jsonb(t)::text`, [ids.org])).rows;
  return snapshot;
}

await Promise.all([admin.connect(), runtime.connect()]);
try {
  const posture = (await runtime.query('SELECT rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert(Object.values(posture).every(value => value === false), 'runtime role must remain least privilege');
  for (const table of privateTables) {
    const allowed = (await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') allowed", [`hon.${table}`])).rows[0].allowed;
    assert.equal(allowed, false, `runtime must not directly access ${table}`);
    await sqlDenied(() => runtime.query(`SELECT * FROM hon.${table}`));
    const rls = (await admin.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [`hon.${table}`])).rows[0];
    assert.equal(rls.relrowsecurity, true); assert.equal(rls.relforcerowsecurity, true);
  }
  const boundaries = [
    ['hon.resolve_instructor_qualification_scope(text)', true],
    ['hon.read_instructor_qualification(text,text,uuid,uuid)', true],
    ['hon.mutate_instructor_qualification(text,text,uuid,uuid,jsonb,text,uuid,uuid)', true],
    ['hon.instructor_qualification_safe_text(text,integer)', false],
    ['hon.guard_instructor_qualification_history()', false],
    ['hon.instructor_qualification_permission(uuid,uuid,uuid,text)', false],
    ['hon.require_instructor_qualification_actor(text,text)', false],
    ['hon.lock_instructor_qualification_actor(text,text,boolean)', false],
    ['hon.instructor_qualification_definition_projection(uuid)', false],
    ['hon.instructor_qualification_evidence_projection(uuid,uuid)', false],
  ];
  for (const [signature, allowed] of boundaries) assert.equal((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed", [signature])).rows[0].allowed, allowed, signature);

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Qualification fixture','Qualification fixture'),($2,'Other qualification fixture','Other qualification fixture')", [ids.org, ids.otherOrg]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'ESSENTIAL','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.org, ids.otherOrg]);
  for (const [school, org] of [[ids.school, ids.org], [ids.siblingSchool, ids.org], [ids.otherSchool, ids.otherOrg]]) {
    await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'Fixture school',$3,'UTC')", [school, org, `qualification-${school.slice(0, 8)}`]);
  }
  for (const [name, actor] of Object.entries(actors)) {
    const active = name !== 'inactive';
    const org = name === 'other' ? ids.otherOrg : ids.org;
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$2||'@example.test','Private human')", [actor.user, actor.subject]);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,is_active,display_name) VALUES($1,$2,'HUMAN_USER',$3,'Private principal')", [actor.id, actor.user, active]);
  }
  await admin.query("INSERT INTO hon.principals(id,principal_type,is_active,display_name) VALUES($1,'AI_EMPLOYEE',true,'Private automation')", [ai.id]);
  for (const [role, org, code] of [[ids.managerRole, ids.org, 'MANAGER'], [ids.readerRole, ids.org, 'READER'], [ids.staffRole, ids.org, 'INSTRUCTOR'], [ids.parentRole, ids.org, 'PARENT'], [ids.hqRole, ids.org, 'HQ_SUPPORT'], [ids.otherRole, ids.otherOrg, 'MANAGER']]) {
    await admin.query('INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,$3)', [role, org, code]);
  }
  for (const [role, org, permissions] of [
    [ids.managerRole, ids.org, ['staff.instructor_qualification.read', 'staff.instructor_qualification.manage']],
    [ids.readerRole, ids.org, ['staff.instructor_qualification.read']],
    [ids.staffRole, ids.org, ['staff.instructor_qualification.read']],
    [ids.parentRole, ids.org, ['staff.instructor_qualification.read', 'staff.instructor_qualification.manage']],
    [ids.hqRole, ids.org, ['staff.instructor_qualification.read', 'staff.instructor_qualification.manage']],
    [ids.otherRole, ids.otherOrg, ['staff.instructor_qualification.read', 'staff.instructor_qualification.manage']],
  ]) for (const permission of permissions) await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, org, permission]);
  for (const [name, role, org, school] of [
    ['manager', ids.managerRole, ids.org, ids.school], ['reader', ids.readerRole, ids.org, ids.school], ['staff', ids.staffRole, ids.org, ids.school],
    ['parent', ids.parentRole, ids.org, ids.school], ['hq', ids.hqRole, ids.org, ids.school], ['inactive', ids.staffRole, ids.org, ids.school], ['other', ids.otherRole, ids.otherOrg, ids.otherSchool],
  ]) await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')", [org, school, actors[name].id, role, actors.manager.id]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes) VALUES($1,'HON_HQ_OWNER',ARRAY['staff.instructor_qualification.manage'])", [actors.hq.id]);
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Private family')", [ids.family, ids.org, ids.school]);
  await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$5)", [ids.org, ids.school, ids.family, actors.parent.id, actors.manager.id]);
  await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Unchanged local program','SCHEDULED'),($4,$2,$5,'Unchanged sibling program','SCHEDULED'),($6,$7,$8,'Unchanged other program','SCHEDULED')", [ids.program, ids.org, ids.school, randomUUID(), ids.siblingSchool, ids.otherProgram, ids.otherOrg, ids.otherSchool]);
  await admin.query('COMMIT');

  const before = await snapshot(forbiddenTables);
  const directAccess = await direct(context('reader'), () => runtime.query("SELECT hon.read_instructor_qualification($1,'ACCESS',NULL,NULL) data", [actors.reader.subject]));
  assert.deepEqual(directAccess.rows[0]?.data, { canRead: true, canManage: false, humanRecordedOnly: true, qualificationOnly: true });
  const transactionAccess = await database.withTenantTransaction(context('reader'), async client => {
    await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", ['HUMAN_UI']);
    return client.query("SELECT hon.read_instructor_qualification($1,'ACCESS',NULL,NULL) data", [actors.reader.subject]);
  });
  assert.deepEqual(transactionAccess.rows[0]?.data, { canRead: true, canManage: false, humanRecordedOnly: true, qualificationOnly: true });
  const readOnlyAccess = await database.withTenantReadOnlyTransaction(context('reader'), async client => {
    await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", ['HUMAN_UI']);
    await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
    return client.query("SELECT hon.read_instructor_qualification($1,'ACCESS',NULL,NULL) data", [actors.reader.subject]);
  });
  assert.deepEqual(readOnlyAccess.rows[0]?.data, { canRead: true, canManage: false, humanRecordedOnly: true, qualificationOnly: true });
  const access = await service.access(context('reader'));
  assert.deepEqual(access, { canRead: true, canManage: false, humanRecordedOnly: true, qualificationOnly: true });
  assert.equal((await controller.access({ honIdentity: { externalSubject: actors.manager.subject } })).data.canManage, true);
  assert.equal((await database.resolveInstructorQualificationScope(actors.manager.subject)).schoolId, ids.school);

  const createContext = context('manager', { idempotencyKey: 'definition-create' });
  const created = await service.create(createContext, definitionInput());
  assert.equal(created.replayed, false); assert.equal(created.record.version, 1); assert.equal(created.record.courseProgramId, ids.program);
  const replay = await service.create(createContext, definitionInput());
  assert.equal(replay.replayed, true); assert.deepEqual(replay.record, created.record);
  await assert.rejects(() => service.create(context('manager', { idempotencyKey: 'definition-create' }), definitionInput({ title: 'Changed definition' })), status(409));
  await assert.rejects(() => service.retire(context(), created.record.id, { expectedVersion: 9 }), status(409));

  const recorded = await service.record(context('manager', { idempotencyKey: 'evidence-record' }), actors.staff.id, evidenceInput(created.record.id));
  assert.equal(recorded.replayed, false); assert.equal(recorded.record.reviewStatus, 'RECORDED'); assert.equal(recorded.record.courseProgramId, ids.program);
  const evidenceReplay = await service.record(context('manager', { idempotencyKey: 'evidence-record' }), actors.staff.id, evidenceInput(created.record.id));
  assert.equal(evidenceReplay.replayed, true); assert.deepEqual(evidenceReplay.record, recorded.record);
  await assert.rejects(() => service.record(context('manager'), actors.staff.id, evidenceInput(created.record.id, { expectedQualificationVersion: 2 })), status(409));
  const reviewed = await service.review(context('manager'), actors.staff.id, recorded.record.id, reviewInput(1));
  assert.equal(reviewed.record.reviewStatus, 'REVIEWED'); assert.equal(reviewed.record.reviewVersion, 2);
  const racing = await Promise.allSettled([
    service.review(context('manager'), actors.staff.id, recorded.record.id, reviewInput(2, { reviewNote: 'Concurrent human review A' })),
    service.review(context('manager'), actors.staff.id, recorded.record.id, reviewInput(2, { reviewNote: 'Concurrent human review B' })),
  ]);
  assert.equal(racing.filter(result => result.status === 'fulfilled').length, 1, 'one version writer must win');
  assert.equal(racing.filter(result => result.status === 'rejected').length, 1, 'one stale expected version must lose');
  assert.equal(racing.find(result => result.status === 'rejected').reason.getStatus(), 409);
  const current = racing.find(result => result.status === 'fulfilled').value.record;
  assert.equal(current.reviewVersion, 3);
  const retiredEvidence = await service.review(context('manager'), actors.staff.id, recorded.record.id, reviewInput(3, { status: 'RETIRED', reviewNote: 'Human evidence retired' }));
  assert.equal(retiredEvidence.record.reviewStatus, 'RETIRED'); assert.equal(retiredEvidence.record.reviewVersion, 4);
  const retirementProbe = context('manager', { idempotencyKey: 'definition-retire-probe' });
  await directRollback(retirementProbe, () => runtime.query(
    'SELECT hon.mutate_instructor_qualification($1,$2,NULL,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid)',
    [retirementProbe.externalSubject, 'QUALIFICATION_RETIRE', created.record.id, JSON.stringify({ expectedVersion: 1 }), retirementProbe.idempotencyKey, retirementProbe.requestId, retirementProbe.correlationId],
  ));
  const retiredDefinition = await service.retire(context('manager'), created.record.id, { expectedVersion: 1 });
  assert.equal(retiredDefinition.record.status, 'RETIRED'); assert.equal(retiredDefinition.record.version, 2);

  // Composite tenant/school FKs reject a qualification or program relationship from another scope.
  await sqlDenied(() => admin.query(`INSERT INTO hon.instructor_qualification_evidence(id,organization_id,school_id,staff_principal_id,qualification_id,qualification_version,course_program_id,kind,attained_on,evidence_reference,recorded_by_principal_id,request_id)
    VALUES($1,$2,$3,$4,$5,1,$6,'QUALIFICATION','2026-01-01','Bad cross-school reference',$4,$7)`, [randomUUID(), ids.otherOrg, ids.otherSchool, actors.staff.id, created.record.id, ids.otherProgram, randomUUID()]), '23503');
  await sqlDenied(() => admin.query(`INSERT INTO hon.instructor_qualifications(id,organization_id,school_id,code,title,kind,course_program_id,created_by_principal_id)
    VALUES($1,$2,$3,'BAD_RELATION','Bad relation','QUALIFICATION',$4,$5)`, [randomUUID(), ids.org, ids.school, ids.otherProgram, actors.manager.id]), '23503');

  for (const bad of [
    context('manager', { schoolId: ids.siblingSchool }), context('manager', { organizationId: ids.otherOrg, schoolId: ids.otherSchool }), context('parent'), context('hq'),
    context('manager', { principalType: 'AI_EMPLOYEE' }), context('manager', { source: 'AI' }), context('manager', { actionRequestId: randomUUID() }), context('manager', { delegatedByPrincipalId: randomUUID() }),
  ]) await assert.rejects(() => service.access(bad), status(403));
  assert.deepEqual(await service.access(context('other')), { canRead: true, canManage: true, humanRecordedOnly: true, qualificationOnly: true });
  for (const actor of ['inactive']) await assert.rejects(() => service.access(context(actor)), status(403));
  await sqlDenied(() => direct(context('manager', { principalType: 'AI_EMPLOYEE' }), () => runtime.query("SELECT hon.read_instructor_qualification($1,'ACCESS',NULL,NULL)", [actors.manager.subject])));
  await sqlDenied(() => direct(context('manager', { actionRequestId: randomUUID() }), () => runtime.query("SELECT hon.read_instructor_qualification($1,'ACCESS',NULL,NULL)", [actors.manager.subject])));

  // Permission, actor/target eligibility, and tier are rechecked as live state rather than captured in a receipt.
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='staff.instructor_qualification.manage'", [ids.managerRole]);
  assert.equal((await service.access(context())).canManage, false);
  await assert.rejects(() => service.create(context('manager', { idempotencyKey: 'definition-create' }), definitionInput()), status(403));
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'staff.instructor_qualification.manage')", [ids.managerRole, ids.org]);
  await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1', [actors.manager.id]);
  await assert.rejects(() => service.access(context()), status(403));
  await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1', [actors.manager.id]);
  await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1', [actors.staff.id]);
  await assert.rejects(() => service.evidence(context(), actors.staff.id, recorded.record.id), status(403));
  await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1', [actors.staff.id]);
  await admin.query("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1", [ids.org]);
  await assert.rejects(() => service.access(context()), status(403));
  await admin.query('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.org]);
  for (const tier of ['ESSENTIAL', 'CORE', 'COMPLETE']) {
    await admin.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1', [ids.org, tier]);
    assert.equal((await service.access(context())).canRead, true);
  }

  for (const table of privateTables) {
    await sqlDenied(() => admin.query(`UPDATE hon.${table} SET organization_id=organization_id WHERE organization_id=$1`, [ids.org]));
    await sqlDenied(() => admin.query(`DELETE FROM hon.${table} WHERE organization_id=$1`, [ids.org]));
  }
  const evidenceRows = (await admin.query("SELECT status,execution_allowed,event_type FROM hon.instructor_qualification_outbox WHERE organization_id=$1 ORDER BY review_version", [ids.org])).rows;
  assert.deepEqual(evidenceRows.map(row => row.status), ['INERT', 'INERT', 'INERT', 'INERT']);
  assert(evidenceRows.every(row => row.execution_allowed === false));
  assert.deepEqual(evidenceRows.map(row => row.event_type), ['staff.instructor_qualification.recorded', 'staff.instructor_qualification.reviewed', 'staff.instructor_qualification.reviewed', 'staff.instructor_qualification.retired']);
  const audits = (await admin.query("SELECT source,action_code,next_state FROM hon.audit_events WHERE organization_id=$1 AND action_code='staff.instructor_qualification.manage' ORDER BY occurred_at", [ids.org])).rows;
  assert.equal(audits.length, 6); assert(audits.every(row => row.source === 'HUMAN_UI'));
  assert.doesNotMatch(JSON.stringify([...audits, ...evidenceRows]), /Internal first aid ledger|Human internal review|Private human|@example\.test/);
  assert.deepEqual(await snapshot(forbiddenTables), before, 'Qualification evidence must not change scheduling/class assignment/testing/promotion/payroll/employment/AI/Action Engine/provider/payment/message records.');
  console.log('Instructor qualification integrity passed: guarded human create/evidence/review/retire; expected-version/replay/concurrency; live permission/principal/tier revocation; cross-scope/HQ/parent/nonhuman/delegated/action denial; forced-RLS direct ACL denial; composite relationships; redacted audit/inert outbox; and zero scheduling/testing/promotion/payroll/AI/action/provider/payment/message effects.');
} finally {
  await Promise.all([admin.end(), runtime.end(), database.onModuleDestroy()]);
}
