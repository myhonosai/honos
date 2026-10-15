import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testingScorecardFunctions, testingScorecardTables, verifyTestingScorecardSecurity } from './testing-scorecard-security.mjs';

const owner = new URL(process.env.DATABASE_URL ?? '');
const runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
if (owner.hostname !== 'localhost' || runtimeUrl.hostname !== 'localhost' || owner.port !== '5432' || runtimeUrl.port !== '5432'
  || owner.pathname !== '/hon_testing_scorecard_validation' || runtimeUrl.pathname !== owner.pathname || owner.username !== 'hon_testing_scorecard_owner' || runtimeUrl.username !== 'hon_testing_scorecard_runtime') {
  throw new Error('Only the exact disposable localhost hon_testing_scorecard_validation owner/runtime aliases may run scorecard integrity tests. Never remote URLs.');
}
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false });
const runtime = new pg.Client({ connectionString: runtimeUrl.toString(), ssl: false });
const org = randomUUID(), otherOrg = randomUUID(), school = randomUUID(), otherSchool = randomUUID();
const curriculum = randomUUID(), rank = randomUUID(), student = randomUUID(), person = randomUUID(), family = randomUUID(), enrollment = randomUUID();
const event = randomUUID(), otherEvent = randomUUID(), candidate = randomUUID();
const permissions = ['testing.scorecard.read', 'testing.scorecard.record'];
const actors = Object.fromEntries(['recorder', 'second', 'reader', 'parent', 'hq', 'ai', 'other'].map(name => [name, { id: randomUUID(), user: randomUUID(), role: randomUUID(), grant: randomUUID(), subject: `scorecard-${name}-${randomUUID()}`, org: name === 'other' ? otherOrg : org, school: name === 'other' ? otherSchool : school }]));
const context = (name = 'recorder', patch = {}) => ({ organizationId: actors[name].org, schoolId: actors[name].school, principalId: actors[name].id, externalSubject: actors[name].subject, principalType: name === 'ai' ? 'AI_EMPLOYEE' : 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), ...patch });
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
async function record(ctx, candidateId, eventId, input, key = randomUUID()) {
  return direct(ctx, () => runtime.query('SELECT hon.record_testing_scorecard_evaluation($1,$2::uuid,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid) AS data', [ctx.externalSubject, candidateId, eventId, JSON.stringify(input), key, ctx.requestId, ctx.correlationId]));
}
async function read(ctx, candidateId, eventId) { return direct(ctx, () => runtime.query('SELECT hon.read_testing_scorecard($1,$2::uuid,$3::uuid) AS data', [ctx.externalSubject, candidateId, eventId])); }
const input = (patch = {}) => ({ criterionCode: 'TECHNIQUE.BALANCE', assessment: 'OBSERVED', expectedCandidateVersion: 1, expectedTestingEventVersion: 1, expectedScorecardVersion: 0, ...patch });
async function counts() {
  return (await admin.query(`SELECT
    (SELECT count(*) FROM hon.testing_scorecards) scorecards,
    (SELECT count(*) FROM hon.testing_scorecard_evaluations) evaluations,
    (SELECT count(*) FROM hon.testing_scorecard_requests) receipts,
    (SELECT count(*) FROM hon.testing_scorecard_outbox) scorecard_outbox,
    (SELECT count(*) FROM hon.audit_events WHERE action_code='testing.scorecard.evaluation.record') audit,
    (SELECT count(*) FROM hon.outbox_events) global_outbox,
    (SELECT count(*) FROM hon.testing_candidates) candidates,
    (SELECT count(*) FROM hon.promotion_decisions) promotions,
    (SELECT count(*) FROM hon.student_curriculum_enrollments) enrollments,
    (SELECT count(*) FROM hon.testing_certificates) certificates,
    (SELECT count(*) FROM hon.attendance_records) attendance,
    (SELECT count(*) FROM hon.action_requests) actions,
    (SELECT count(*) FROM hon.ai_usage_ledger) ai,
    (SELECT count(*) FROM hon.communication_messages) messages
  `)).rows[0];
}

await Promise.all([admin.connect(), runtime.connect()]);
try {
  for (const table of testingScorecardTables) assert.equal((await admin.query(`SELECT count(*) AS n FROM hon.${table}`)).rows[0].n, '0', 'fresh disposable scorecard fixture is required');
  await verifyTestingScorecardSecurity(admin, runtimeUrl.username);
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Scorecard org','Scorecard org'),($2,'Other org','Other org')", [org, otherOrg]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$3,'Scorecard school','scorecard','UTC'),($2,$4,'Other school','other-scorecard','UTC')", [school, otherSchool, org, otherOrg]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'ESSENTIAL','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [org, otherOrg]);
  for (const [name, actor] of Object.entries(actors)) {
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$2||'@example.test','Private human')", [actor.user, actor.subject]);
    await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,is_active,display_name) VALUES($1,'HUMAN_USER',$2,true,'Private principal')", [actor.id, actor.user]);
    const code = name === 'parent' ? 'PARENT' : name === 'hq' ? 'HQ_SUPPORT' : name === 'ai' ? 'AI_INSTRUCTOR' : `INSTRUCTOR_${name.toUpperCase()}`;
    await admin.query('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [actor.role, actor.org, code]);
    const grants = name === 'reader' ? ['testing.scorecard.read'] : name === 'recorder' || name === 'second' || name === 'parent' || name === 'hq' || name === 'ai' || name === 'other' ? permissions : [];
    for (const permission of grants) await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [actor.role, actor.org, permission]);
    await admin.query("INSERT INTO hon.principal_role_grants(id,principal_id,organization_id,school_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$2,clock_timestamp()-interval '1 day')", [actor.grant, actor.id, actor.org, actor.school, actor.role]);
  }
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Private family')", [family, org, school]);
  await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Private','Student')", [person, org, school]);
  await admin.query("INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id,status) VALUES($1,$2,$3,$4,$5,'ACTIVE')", [student, org, school, person, family]);
  await admin.query("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code) VALUES($1,$2,$3,'Scorecard curriculum','LINEAR')", [curriculum, org, school]);
  await admin.query("INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,'Blue Rank',1)", [rank, org, school, curriculum]);
  await admin.query("INSERT INTO hon.student_curriculum_enrollments(id,organization_id,school_id,student_profile_id,curriculum_id,current_rank_id) VALUES($1,$2,$3,$4,$5,$6)", [enrollment, org, school, student, curriculum, rank]);
  await admin.query("INSERT INTO hon.testing_events(id,organization_id,school_id,curriculum_id,name,starts_at) VALUES($1,$2,$3,$4,'Scorecard test',clock_timestamp()),($5,$2,$3,$4,'Other test',clock_timestamp())", [event, org, school, curriculum, otherEvent]);
  await admin.query("INSERT INTO hon.testing_candidates(id,organization_id,school_id,testing_event_id,student_curriculum_enrollment_id,target_rank_id,result,version) VALUES($1,$2,$3,$4,$5,$6,'PENDING',1)", [candidate, org, school, event, enrollment, rank]);
  await admin.query('COMMIT');

  for (const name of ['parent', 'hq', 'ai']) await denied(() => record(context(name), candidate, event, input()));
  await denied(() => record(context('other'), candidate, event, input()), 'P0002');
  await denied(() => record(context('recorder', { source: 'AI' }), candidate, event, input()));
  await denied(() => record(context('recorder', { actionRequestId: randomUUID() }), candidate, event, input()));
  await denied(() => record(context('recorder', { delegatedByPrincipalId: randomUUID() }), candidate, event, input()));
  await denied(() => record(context(), candidate, otherEvent, input()), 'P0002');
  await denied(() => record(context(), candidate, event, input({ criterionCode: 'not-safe' })), '22023');

  const before = await counts();
  const firstContext = context(); const firstKey = 'scorecard-recorder-key';
  const first = await record(firstContext, candidate, event, input(), firstKey);
  assert.equal(first.rows[0].data.replayed, false); assert.deepEqual(Object.keys(first.rows[0].data.record).sort(), ['evaluation', 'scorecardId', 'scorecardVersion']);
  assert.deepEqual(Object.keys(first.rows[0].data.record.evaluation).sort(), ['assessment', 'criterionCode', 'id', 'recordedAt', 'recordedByYou', 'version']);
  assert.equal(first.rows[0].data.record.scorecardVersion, 1); assert.equal(first.rows[0].data.record.evaluation.recordedByYou, true);
  const replay = await record(firstContext, candidate, event, input(), firstKey);
  assert.equal(replay.rows[0].data.replayed, true); assert.deepEqual(replay.rows[0].data.record, first.rows[0].data.record);
  await denied(() => record(context(), candidate, event, input({ assessment: 'NOT_OBSERVED' }), firstKey), '23505');
  await denied(() => record(context(), candidate, event, input({ expectedScorecardVersion: 0, criterionCode: 'TECHNIQUE.POSTURE' })), '40001');

  const second = await record(context('second'), candidate, event, input({ assessment: 'NEEDS_FOLLOW_UP', expectedScorecardVersion: 1 }), 'scorecard-second-key');
  assert.equal(second.rows[0].data.record.scorecardVersion, 2, 'a second qualified examiner may independently observe the same criterion');
  await denied(() => record(context(), candidate, event, input({ criterionCode: 'TECHNIQUE.BALANCE', expectedScorecardVersion: 2 })), '23505');
  await denied(() => record(context(), candidate, event, input({ criterionCode: 'TECHNIQUE.KICKS', expectedTestingEventVersion: 2, expectedScorecardVersion: 2 })), '40001');

  const recorderView = (await read(context(), candidate, event)).rows[0].data;
  assert.deepEqual(Object.keys(recorderView).sort(), ['candidateVersion', 'evaluations', 'evaluationsLimited', 'scorecardId', 'scorecardVersion', 'testingCandidateId', 'testingEventId', 'testingEventVersion']);
  assert.equal(recorderView.evaluations.length, 2); assert.equal(recorderView.evaluations.filter(item => item.recordedByYou).length, 1);
  assert.equal(JSON.stringify(recorderView).includes('evaluatorPrincipalId'), false);
  const readerView = (await read(context('reader'), candidate, event)).rows[0].data;
  assert.equal(readerView.evaluations.every(item => item.recordedByYou === false), true);
  for (const name of ['parent', 'hq', 'ai']) await denied(() => read(context(name), candidate, event));
  await denied(() => read(context('other'), candidate, event), 'P0002');

  const after = await counts();
  assert.equal(after.scorecards - before.scorecards, 1); assert.equal(after.evaluations - before.evaluations, 2); assert.equal(after.receipts - before.receipts, 2); assert.equal(after.scorecard_outbox - before.scorecard_outbox, 2); assert.equal(after.audit - before.audit, 2);
  for (const field of ['global_outbox', 'candidates', 'promotions', 'enrollments', 'certificates', 'attendance', 'actions', 'ai', 'messages']) assert.equal(after[field], before[field], `scorecard evaluation must not mutate ${field}`);
  assert.equal((await admin.query("SELECT count(*) AS n FROM hon.testing_scorecard_outbox WHERE status <> 'INERT' OR execution_allowed OR event_type <> 'testing.scorecard.evaluation.recorded'")).rows[0].n, '0');

  await denied(() => admin.query('UPDATE hon.testing_scorecards SET version=version+1 WHERE id=$1', [first.rows[0].data.record.scorecardId]), '42501');
  await denied(() => admin.query('UPDATE hon.testing_scorecard_evaluations SET assessment=assessment'), '42501');
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', [actors.recorder.grant]);
  await denied(() => read(context(), candidate, event));
  await denied(() => record(context(), candidate, event, input({ criterionCode: 'TECHNIQUE.KICKS', expectedScorecardVersion: 2 })));
  for (const table of testingScorecardTables) {
    const directPrivilege = (await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS allowed", [`hon.${table}`])).rows[0].allowed;
    assert.equal(directPrivilege, false); await denied(() => runtime.query(`SELECT * FROM hon.${table}`));
  }
  for (const [signature, executable] of testingScorecardFunctions) assert.equal((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed, executable);
  await verifyTestingScorecardSecurity(admin, runtimeUrl.username);
  console.log('Testing scorecard integrity passed: forced private RLS/ACLs, exact direct human scope/tier/permission, candidate-event composite integrity, independent examiner attribution, version/idempotency/immutable evidence, redaction, and zero grade/promotion/rank/certificate/parent/Action Engine/AI/provider effects.');
} finally {
  await admin.query('ROLLBACK'); await Promise.all([admin.end(), runtime.end()]);
}
