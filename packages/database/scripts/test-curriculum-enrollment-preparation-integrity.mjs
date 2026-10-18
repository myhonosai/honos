import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { requireCurriculumEnrollmentPreparationLocalUrls } from './curriculum-enrollment-preparation-local-guard.mjs';
import { verifyCurriculumEnrollmentPreparationSecurity } from './curriculum-enrollment-preparation-security.mjs';

requireCurriculumEnrollmentPreparationLocalUrls();
const ownerUrl = new URL(process.env.DATABASE_URL ?? '');
const runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { CurriculumEnrollmentPreparationService } = await import('../../../apps/api/dist/curriculum/curriculum-enrollment-preparation.service.js');
const admin = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const runtime = new pg.Client({ connectionString: runtimeUrl.toString(), ssl: false });
const ids = Object.fromEntries(['org','otherOrg','school','otherSchool','foreignSchool','user','staff','secondPrincipal','progressRole','mixedRole','grant','mixedGrant','student','inactiveStudent','otherStudent','foreignStudent','person','inactivePerson','otherPerson','foreignPerson','curriculumA','curriculumB','otherCurriculum','rankA1','rankA2','rankB1','rankB2','otherRank','family'].map((key) => [key, randomUUID()]));
const subject = `enrollment-preparation-${randomUUID()}`;
const context = (patch = {}) => ({ organizationId: ids.org, schoolId: ids.school, principalId: ids.staff, externalSubject: subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: '', ...patch });
const denied = (status = 403) => (error) => error?.getStatus?.() === status || error?.code === '42501';
const notFound = (error) => error?.getStatus?.() === 404 || error?.code === 'P0002';
const immutableTables = ['people','student_profiles','curricula','curriculum_ranks','student_curriculum_enrollments','audit_events','outbox_events','idempotency_records','billing_accounts','memberships','membership_payment_schedules','invoices','payment_attempts','communication_messages','ai_usage_ledger','ai_invocation_plans','action_requests','action_approvals'];
async function snapshot() {
  const out = {};
  for (const table of immutableTables) out[table] = (await admin.query(`SELECT to_jsonb(row) AS data FROM hon.${table} AS row WHERE organization_id=ANY($1::uuid[]) ORDER BY to_jsonb(row)::text`, [[ids.org, ids.otherOrg]])).rows.map((row) => row.data);
  return out;
}
async function raw(patch = {}, studentId = ids.student) {
  const c = context(patch);
  await runtime.query('BEGIN READ ONLY');
  try {
    await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_request_id',$5,true),set_config('app.hon_source',$6,true),set_config('app.hon_external_subject',$7,true),set_config('app.hon_action_request_id',$8,true),set_config('app.hon_delegated_by_principal_id',$9,true)", [c.organizationId,c.schoolId,c.principalId,c.principalType,c.requestId,c.source,c.externalSubject,c.actionRequestId ?? '',c.delegatedByPrincipalId ?? '']);
    return await runtime.query('SELECT hon.read_staff_curriculum_enrollment_preparation($1,$2::uuid) AS data', [c.externalSubject, studentId]);
  } finally { await runtime.query('ROLLBACK'); }
}

await admin.connect();
await runtime.connect();
const db = new RuntimeDatabaseService();
const service = new CurriculumEnrollmentPreparationService(db);
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: 'hon_curriculum_enrollment_preparation_owner', marker: 'HON disposable curriculum enrollment preparation validation' });
  await verifyCurriculumEnrollmentPreparationSecurity(admin, runtimeUrl.username);
  await assert.rejects(runtime.query('SELECT hon.require_staff_curriculum_enrollment_preparation_actor($1)', [subject]), (error) => error.code === '42501');
  await assert.rejects(runtime.query('SELECT hon.read_staff_curriculum_enrollment_preparation($1,$2::uuid)', [subject, ids.student]), (error) => error.code === '42501');

  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_ORG','PRIVATE_ORG'),($2,'PRIVATE_FOREIGN_ORG','PRIVATE_FOREIGN_ORG')", [ids.org,ids.otherOrg]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_SCHOOL',$3),($4,$2,'PRIVATE_OTHER_SCHOOL',$5),($6,$7,'PRIVATE_FOREIGN_SCHOOL',$8)", [ids.school,ids.org,`school-${ids.school}`,ids.otherSchool,`school-${ids.otherSchool}`,ids.foreignSchool,ids.otherOrg,`school-${ids.foreignSchool}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'ESSENTIAL',clock_timestamp()-interval '1 day')", [ids.org,ids.otherOrg]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,'private.staff@example.test','PRIVATE_STAFF_DIRECTORY')", [ids.user,subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','PRIVATE_STAFF_DIRECTORY')", [ids.staff,ids.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'CURRICULUM_PROGRESS_STAFF','PRIVATE_ROLE'),($3,$2,'PARENT_MIXED','PRIVATE_MIXED_ROLE')", [ids.progressRole,ids.org,ids.mixedRole]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'curriculum.progress.record')", [ids.progressRole,ids.org]);
  await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [ids.grant,ids.org,ids.school,ids.staff,ids.progressRole]);
  await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'Ada','Student','private.student@example.test'),($4,$2,$3,'Inactive','Student','inactive@example.test'),($5,$2,$6,'Other','School','other@example.test'),($7,$8,$9,'Foreign','School','foreign@example.test')", [ids.person,ids.org,ids.school,ids.inactivePerson,ids.otherPerson,ids.otherSchool,ids.foreignPerson,ids.otherOrg,ids.foreignSchool]);
  await admin.query("INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,status) VALUES($1,$2,$3,$4,'ACTIVE'),($5,$2,$3,$6,'SUSPENDED'),($7,$2,$8,$9,'ACTIVE'),($10,$11,$12,$13,'ACTIVE')", [ids.student,ids.org,ids.school,ids.person,ids.inactiveStudent,ids.inactivePerson,ids.otherStudent,ids.otherSchool,ids.otherPerson,ids.foreignStudent,ids.otherOrg,ids.foreignSchool,ids.foreignPerson]);
  await admin.query("INSERT INTO hon.curricula(id,organization_id,school_id,name,description,model_code,lifecycle) VALUES($1,$2,$3,'Alpha Curriculum','PRIVATE_DESCRIPTION','LINEAR','DRAFT'),($4,$2,$3,'Beta Curriculum','PRIVATE_DESCRIPTION','LINEAR','ARCHIVED'),($5,$2,$6,'Other School Curriculum','PRIVATE_DESCRIPTION','LINEAR','PUBLISHED')", [ids.curriculumA,ids.org,ids.school,ids.curriculumB,ids.otherCurriculum,ids.otherSchool]);
  await admin.query("INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,'White',1),($5,$2,$3,$4,'Blue',2),($6,$2,$3,$7,'First',1),($8,$2,$3,$7,'Second',2),($9,$2,$10,$11,'Other',1)", [ids.rankA1,ids.org,ids.school,ids.curriculumA,ids.rankA2,ids.rankB1,ids.curriculumB,ids.rankB2,ids.otherRank,ids.otherSchool,ids.otherCurriculum]);

  const before = await snapshot();
  const projection = await service.prepare(context(), { studentProfileId: ids.student });
  assert.deepEqual(Object.keys(projection).sort(), ['curricula','student']);
  assert.deepEqual(Object.keys(projection.student).sort(), ['displayName','id']);
  assert.equal(projection.student.id, ids.student);
  assert.equal(projection.student.displayName, 'Ada Student');
  assert.deepEqual(projection.curricula.map((curriculum) => curriculum.name), ['Alpha Curriculum','Beta Curriculum']);
  assert.deepEqual(projection.curricula[0].ranks.map((rank) => [rank.name,rank.progressionOrder]), [['White',1],['Blue',2]]);
  assert.deepEqual(projection.curricula[1].ranks.map((rank) => [rank.name,rank.progressionOrder]), [['First',1],['Second',2]]);
  assert(projection.curricula.every((curriculum) => Object.keys(curriculum).sort().join(',') === 'id,name,ranks' && curriculum.ranks.every((rank) => Object.keys(rank).sort().join(',') === 'id,name,progressionOrder')));
  assert.doesNotMatch(JSON.stringify(projection), /PRIVATE_|email|organization|school|permission|principal|enrollment|audit|outbox|billing|provider|payment|family/i);
  assert.deepEqual(await snapshot(), before, 'the projection must not create or alter audit/outbox/idempotency/billing/provider or domain records');

  for (const studentId of [ids.inactiveStudent,ids.otherStudent,ids.foreignStudent]) await assert.rejects(service.prepare(context(), { studentProfileId: studentId }), notFound);
  await assert.rejects(service.prepare(context({ principalType: 'AI_EMPLOYEE' }), { studentProfileId: ids.student }), denied());
  await assert.rejects(service.prepare(context({ source: 'AUTOMATION' }), { studentProfileId: ids.student }), denied());
  for (const patch of [{ principalType: 'AI_EMPLOYEE' }, { source: 'AI' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }, { schoolId: ids.otherSchool }, { principalId: randomUUID() }]) await assert.rejects(raw(patch), (error) => error.code === '42501');
  await admin.query("INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role) VALUES($1,$2,'HON_HQ_OWNER')", [randomUUID(),ids.staff]);
  await assert.rejects(service.prepare(context(), { studentProfileId: ids.student }), denied());
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1', [ids.staff]);
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PRIVATE_FAMILY')", [ids.family,ids.org,ids.school]);
  await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,'VIEWER',$4,clock_timestamp()-interval '1 day')", [ids.org,ids.school,ids.family,ids.staff]);
  await assert.rejects(service.prepare(context(), { studentProfileId: ids.student }), denied());
  await admin.query('DELETE FROM hon.family_access_grants WHERE principal_id=$1', [ids.staff]);
  await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [ids.mixedGrant,ids.org,ids.school,ids.staff,ids.mixedRole]);
  await assert.rejects(service.prepare(context(), { studentProfileId: ids.student }), denied());
  await admin.query('DELETE FROM hon.principal_role_grants WHERE id=$1', [ids.mixedGrant]);
  // The schema permits user linkage only for HUMAN_USER principals. A second
  // active human principal for the same subject still exercises the strict
  // exactly-one-active-principal condition in the projection helper.
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','PRIVATE_SECOND_PRINCIPAL')", [ids.secondPrincipal,ids.user]);
  await assert.rejects(service.prepare(context(), { studentProfileId: ids.student }), denied());
  await admin.query('DELETE FROM hon.principals WHERE id=$1', [ids.secondPrincipal]);
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='curriculum.progress.record'", [ids.progressRole]);
  await assert.rejects(service.prepare(context(), { studentProfileId: ids.student }), denied());
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'curriculum.progress.record')", [ids.progressRole,ids.org]);
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1', [ids.grant]);
  await assert.rejects(service.prepare(context(), { studentProfileId: ids.student }), denied());
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1', [ids.grant]);
  await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.org]);
  await assert.rejects(service.prepare(context(), { studentProfileId: ids.student }), denied());
  await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.org]);
  assert.deepEqual(await snapshot(), before, 'permitted and denied projection calls have zero database mutation effect');
  for (const sql of [
    'GRANT SELECT ON hon.people TO PUBLIC',
    `GRANT EXECUTE ON FUNCTION hon.require_staff_curriculum_enrollment_preparation_actor(text) TO ${runtimeUrl.username}`,
    'ALTER TABLE hon.curricula NO FORCE ROW LEVEL SECURITY',
  ]) { await admin.query('BEGIN'); try { await admin.query(sql); await assert.rejects(verifyCurriculumEnrollmentPreparationSecurity(admin, runtimeUrl.username)); } finally { await admin.query('ROLLBACK'); } }
  await verifyCurriculumEnrollmentPreparationSecurity(admin, runtimeUrl.username);
  console.log('PASS: curriculum enrollment preparation is a deterministic exact-student/current-school direct-human fixed-function projection with no directory/list/search, no newly granted source-table access, no enrollments or downstream mutations, forced RLS, and live denial for cross-school, nonhuman, delegated/action, HQ, family, mixed-role, revoked permission/grant, and entitlement loss.');
} finally {
  await db.onModuleDestroy();
  await runtime.end();
  await admin.end();
}
