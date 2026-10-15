import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testingCertificateFunctions, testingCertificateTables, verifyTestingCertificateSecurity } from './testing-certificate-security.mjs';

const owner = new URL(process.env.DATABASE_URL ?? '');
const runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
if (owner.hostname !== 'localhost' || runtimeUrl.hostname !== 'localhost' || owner.port !== '5432' || runtimeUrl.port !== '5432'
  || owner.pathname !== '/hon_testing_certificate_validation' || runtimeUrl.pathname !== owner.pathname || owner.username !== 'hon_testing_certificate_owner' || runtimeUrl.username !== 'hon_testing_certificate_runtime') {
  throw new Error('Only the exact disposable localhost hon_testing_certificate_validation owner/runtime aliases may run certificate integrity tests. Never remote URLs.');
}
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false });
const runtime = new pg.Client({ connectionString: runtimeUrl.toString(), ssl: false });
const org = randomUUID(), otherOrg = randomUUID(), school = randomUUID(), otherSchool = randomUUID();
const curriculum = randomUUID(), rank = randomUUID(), enrollment = randomUUID(), event = randomUUID(), pendingEvent = randomUUID(), candidate = randomUUID(), pendingCandidate = randomUUID();
const student = randomUUID(), person = randomUUID(), family = randomUUID();
const permissions = ['testing.certificate.read', 'testing.certificate.issue'];
const actors = Object.fromEntries(['issuer', 'reader', 'parent', 'hq', 'ai', 'other'].map(name => [name, { id: randomUUID(), user: randomUUID(), role: randomUUID(), grant: randomUUID(), subject: `certificate-${name}-${randomUUID()}`, org: name === 'other' ? otherOrg : org, school: name === 'other' ? otherSchool : school }]));
const context = (name = 'issuer', patch = {}) => ({ organizationId: actors[name].org, schoolId: actors[name].school, principalId: actors[name].id, externalSubject: actors[name].subject, principalType: name === 'ai' ? 'AI_EMPLOYEE' : 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), ...patch });
const denied = (work, code = '42501') => assert.rejects(work, error => { assert.equal(error.code, code, error.stack); return true; });
async function direct(ctx, work) {
  await runtime.query('BEGIN');
  try {
    for (const [key, value] of Object.entries({ organization_id: ctx.organizationId, school_id: ctx.schoolId, principal_id: ctx.principalId, principal_type: ctx.principalType, source: ctx.source, request_id: ctx.requestId, action_request_id: ctx.actionRequestId ?? '', delegated_by_principal_id: ctx.delegatedByPrincipalId ?? '' })) {
      await runtime.query('SELECT set_config($1,$2,true)', [`app.hon_${key}`, value]);
    }
    const result = await work(); await runtime.query('COMMIT'); return result;
  } catch (error) { await runtime.query('ROLLBACK'); throw error; }
}
async function issue(ctx, id, input, key = randomUUID()) {
  return direct(ctx, () => runtime.query('SELECT hon.issue_testing_certificate($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data', [ctx.externalSubject, id, JSON.stringify(input), key, ctx.requestId, ctx.correlationId]));
}
async function read(ctx, id) { return direct(ctx, () => runtime.query('SELECT hon.read_testing_certificate($1,$2::uuid) AS data', [ctx.externalSubject, id])); }
async function counts() {
  return (await admin.query(`SELECT
    (SELECT count(*) FROM hon.testing_certificates) certificates,
    (SELECT count(*) FROM hon.testing_certificate_requests) receipts,
    (SELECT count(*) FROM hon.testing_certificate_outbox) certificate_outbox,
    (SELECT count(*) FROM hon.audit_events WHERE action_code='testing.certificate.issue') audit,
    (SELECT count(*) FROM hon.outbox_events) global_outbox,
    (SELECT count(*) FROM hon.testing_candidates) candidates,
    (SELECT count(*) FROM hon.promotion_decisions) promotions,
    (SELECT count(*) FROM hon.student_curriculum_enrollments) enrollments,
    (SELECT count(*) FROM hon.attendance_records) attendance,
    (SELECT count(*) FROM hon.action_requests) actions,
    (SELECT count(*) FROM hon.ai_usage_ledger) ai
  `)).rows[0];
}

await Promise.all([admin.connect(), runtime.connect()]);
try {
  for (const table of testingCertificateTables) assert.equal((await admin.query(`SELECT count(*) AS n FROM hon.${table}`)).rows[0].n, '0', 'fresh disposable certificate fixture is required');
  await verifyTestingCertificateSecurity(admin, runtimeUrl.username);
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Internal org','Internal org'),($2,'Other org','Other org')", [org, otherOrg]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$3,'Internal school','internal','UTC'),($2,$4,'Other school','other','UTC')", [school, otherSchool, org, otherOrg]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'ESSENTIAL','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [org, otherOrg]);
  for (const [name, actor] of Object.entries(actors)) {
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$2||'@example.test','Private human')", [actor.user, actor.subject]);
    await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,is_active,display_name) VALUES($1,'HUMAN_USER',$2,true,'Private principal')", [actor.id, actor.user]);
    const code = name === 'parent' ? 'PARENT' : name === 'hq' ? 'HQ_SUPPORT' : name === 'ai' ? 'AI_INSTRUCTOR' : `INSTRUCTOR_${name.toUpperCase()}`;
    await admin.query('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [actor.role, actor.org, code]);
    const grants = name === 'reader' ? ['testing.certificate.read'] : name === 'issuer' || name === 'parent' || name === 'hq' || name === 'ai' || name === 'other' ? permissions : [];
    for (const permission of grants) await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [actor.role, actor.org, permission]);
    await admin.query("INSERT INTO hon.principal_role_grants(id,principal_id,organization_id,school_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$2,clock_timestamp()-interval '1 day')", [actor.grant, actor.id, actor.org, actor.school, actor.role]);
  }
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Private family')", [family, org, school]);
  await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Private','Student')", [person, org, school]);
  await admin.query("INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id,status) VALUES($1,$2,$3,$4,$5,'ACTIVE')", [student, org, school, person, family]);
  await admin.query("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code) VALUES($1,$2,$3,'Internal curriculum','LINEAR')", [curriculum, org, school]);
  await admin.query("INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,'Blue Rank',1)", [rank, org, school, curriculum]);
  await admin.query("INSERT INTO hon.student_curriculum_enrollments(id,organization_id,school_id,student_profile_id,curriculum_id,current_rank_id) VALUES($1,$2,$3,$4,$5,$6)", [enrollment, org, school, student, curriculum, rank]);
  await admin.query("INSERT INTO hon.testing_events(id,organization_id,school_id,curriculum_id,name,starts_at) VALUES($1,$2,$3,$4,'Human test',clock_timestamp()),($5,$2,$3,$4,'Pending human test',clock_timestamp())", [event, org, school, curriculum, pendingEvent]);
  await admin.query("INSERT INTO hon.testing_candidates(id,organization_id,school_id,testing_event_id,student_curriculum_enrollment_id,target_rank_id,result,version) VALUES($1,$2,$3,$4,$5,$6,'PASSED',2),($7,$2,$3,$8,$5,$6,'PENDING',1)", [candidate, org, school, event, enrollment, rank, pendingCandidate, pendingEvent]);
  await admin.query("INSERT INTO hon.promotion_decisions(organization_id,school_id,testing_candidate_id,student_curriculum_enrollment_id,target_rank_id,status,instructor_principal_id,rationale,decided_at) VALUES($1,$2,$3,$4,$5,'PROMOTED',$6,'Deliberate human decision',clock_timestamp())", [org, school, candidate, enrollment, rank, actors.issuer.id]);
  await admin.query('COMMIT');

  for (const name of ['parent', 'hq', 'ai']) await denied(() => issue(context(name), candidate, { expectedCandidateVersion: 2, expectedCertificateVersion: 0, title: 'School testing certificate' }));
  await denied(() => issue(context('other'), candidate, { expectedCandidateVersion: 2, expectedCertificateVersion: 0, title: 'School testing certificate' }), 'P0002');
  await denied(() => issue(context('issuer', { source: 'AI' }), candidate, { expectedCandidateVersion: 2, expectedCertificateVersion: 0, title: 'School testing certificate' }));
  await denied(() => issue(context('issuer', { actionRequestId: randomUUID() }), candidate, { expectedCandidateVersion: 2, expectedCertificateVersion: 0, title: 'School testing certificate' }));
  await denied(() => issue(context('issuer', { delegatedByPrincipalId: randomUUID() }), candidate, { expectedCandidateVersion: 2, expectedCertificateVersion: 0, title: 'School testing certificate' }));
  await denied(() => issue(context(), pendingCandidate, { expectedCandidateVersion: 1, expectedCertificateVersion: 0, title: 'School testing certificate' }), '23514');
  await denied(() => issue(context(), candidate, { expectedCandidateVersion: 2, expectedCertificateVersion: 0, title: '<unsafe>' }), '22023');

  const before = await counts();
  const issueContext = context(); const key = 'certificate-issue-key';
  const first = await issue(issueContext, candidate, { expectedCandidateVersion: 2, expectedCertificateVersion: 0, title: 'School testing certificate' }, key);
  assert.equal(first.rows[0].data.replayed, false); assert.deepEqual(Object.keys(first.rows[0].data.certificate).sort(), ['id','issuedAt','status','targetRankId','targetRankName','title','version']);
  const replay = await issue(issueContext, candidate, { expectedCandidateVersion: 2, expectedCertificateVersion: 0, title: 'School testing certificate' }, key);
  assert.equal(replay.rows[0].data.replayed, true); assert.deepEqual(replay.rows[0].data.certificate, first.rows[0].data.certificate);
  await denied(() => issue(context(), candidate, { expectedCandidateVersion: 2, expectedCertificateVersion: 0, title: 'Different title' }, key), '23505');
  await denied(() => issue(context(), candidate, { expectedCandidateVersion: 1, expectedCertificateVersion: 0, title: 'School testing certificate' }), '40001');
  const projection = (await read(context('reader'), candidate)).rows[0].data;
  assert.deepEqual(Object.keys(projection).sort(), ['candidateVersion','certificate','status','targetRankId','testingCandidateId']); assert.equal(projection.status, 'ISSUED'); assert.equal(projection.certificate.id, first.rows[0].data.certificate.id);
  for (const name of ['parent', 'hq', 'ai']) await denied(() => read(context(name), candidate));
  await denied(() => read(context('other'), candidate), 'P0002');

  const after = await counts();
  assert.equal(after.certificates - before.certificates, 1); assert.equal(after.receipts - before.receipts, 1); assert.equal(after.certificate_outbox - before.certificate_outbox, 1); assert.equal(after.audit - before.audit, 1);
  for (const field of ['global_outbox','candidates','promotions','enrollments','attendance','actions','ai']) assert.equal(after[field], before[field], `certificate issuance must not mutate ${field}`);
  assert.equal((await admin.query("SELECT count(*) AS n FROM hon.testing_certificate_outbox WHERE status <> 'INERT' OR execution_allowed")).rows[0].n, '0');

  await denied(() => admin.query('UPDATE hon.testing_certificates SET title=title'), '42501');
  await denied(() => admin.query("UPDATE hon.testing_candidates SET result='DEFERRED' WHERE id=$1", [candidate]), '23514');
  for (const table of testingCertificateTables) {
    const directPrivilege = (await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS allowed", [`hon.${table}`])).rows[0].allowed;
    assert.equal(directPrivilege, false); await denied(() => runtime.query(`SELECT * FROM hon.${table}`));
  }
  for (const [signature, executable] of testingCertificateFunctions) assert.equal((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed, executable);
  await verifyTestingCertificateSecurity(admin, runtimeUrl.username);
  console.log('Testing certificate integrity passed: forced private RLS/ACLs, exact human scope/tier/permission, PASSED+PROMOTED prerequisite, immutable idempotent receipt/audit/inert evidence, redaction, and zero grade/promotion/rank/attendance/AI/action/provider effects.');
} finally {
  await admin.query('ROLLBACK'); await Promise.all([admin.end(), runtime.end()]);
}
