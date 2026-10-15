import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { RuntimeDatabaseService } from '../../../apps/api/dist/foundation/runtime-database.service.js';
import { AchievementsService } from '../../../apps/api/dist/achievements/achievements.service.js';
import { achievementTables, achievementFunctions, verifyAchievementSecurity } from './achievement-security.mjs';
for (const [key, role] of [['DATABASE_URL', 'hon_achievement_owner'], ['HON_RUNTIME_DATABASE_URL', 'hon_achievement_runtime']]) {
  const u = new URL(process.env[key] ?? '');
  if (u.hostname !== 'localhost' || u.port !== '5432' || u.pathname !== '/hon_achievement_validation' || u.username !== role) throw new Error('Only exact disposable localhost achievement database and roles allowed. Never remote URLs.');
}
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
const runtime = new pg.Client({ connectionString: process.env.HON_RUNTIME_DATABASE_URL, ssl: false });
const database = new RuntimeDatabaseService(), svc = new AchievementsService(database);
const org = randomUUID(), otherOrg = randomUUID(), school = randomUUID(), siblingSchool = randomUUID(), otherSchool = randomUUID();
const family = randomUUID(), otherFamily = randomUUID(), sibling = randomUUID(), student = randomUUID(), outsider = randomUUID(), unknownAge = randomUUID(), inactiveStudent = randomUUID();
const people = new Map([student, sibling, outsider, unknownAge, inactiveStudent].map(id => [id, randomUUID()]));
const parentGrant = randomUUID();
const actors = Object.fromEntries(['owner', 'instructor', 'reader', 'recorder', 'definitionManager', 'noPermission', 'parent', 'hq', 'inactive', 'future', 'expired', 'wrongRoleSchool', 'other', 'siblingSchool'].map(k => [k, { id: randomUUID(), user: randomUUID(), role: randomUUID(), grant: randomUUID(), subject: `achievement-${k}-${randomUUID()}`, org: k === 'other' ? otherOrg : org, school: k === 'other' ? otherSchool : k === 'siblingSchool' ? siblingSchool : school }]));
const codes = ['achievement.definition.read', 'achievement.definition.manage', 'achievement.award.read', 'achievement.award.record'];
const c = (who = 'owner', patch = {}) => ({ organizationId: actors[who].org, schoolId: actors[who].school, principalId: actors[who].id, externalSubject: actors[who].subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), ...patch });
const definitionInput = (patch = {}) => ({ expectedVersion: 0, name: 'Careful practice', description: 'Recognition of sustained effort during practice.', category: 'EFFORT', ageBand: 'CHILD', visualToken: 'RIBBON', status: 'ACTIVE', ...patch });
const awardInput = (d, patch = {}) => ({ expectedVersion: 0, definitionId: d.id, definitionVersion: d.version, reason: 'PRIVATE instructor observation', awardedOn: '2026-01-10', visibleToFamily: true, status: 'AWARDED', ...patch });
const definitionRevision = (d, patch = {}) => { const { id, version, ...fields } = d; return { expectedVersion: version, ...fields, ...patch }; };
const awardRevision = (a, patch = {}) => { const { id, version, studentProfileId, definition, recordedAt, awardedByPrincipalId, recordedByPrincipalId, ...fields } = a; return { expectedVersion: version, ...fields, ...patch }; };
const deny = (work, status = 403) => assert.rejects(async () => work(), e => { assert.equal(e.getStatus?.(), status, e.stack); return true; });
const sqlDeny = (work, code = '42501') => assert.rejects(async () => work(), e => { assert.equal(e.code, code, e.stack); return true; });
async function direct(ctx, work) {
  await runtime.query('BEGIN');
  try {
    for (const [k, v] of Object.entries({ organization_id: ctx.organizationId, school_id: ctx.schoolId, principal_id: ctx.principalId, principal_type: ctx.principalType, source: ctx.source, request_id: ctx.requestId, action_request_id: ctx.actionRequestId ?? '', delegated_by_principal_id: ctx.delegatedByPrincipalId ?? '' })) await runtime.query('SELECT set_config($1,$2,true)', [`app.hon_${k}`, v]);
    const r = await work(); await runtime.query('COMMIT'); return r;
  } catch (e) { await runtime.query('ROLLBACK'); throw e; }
}
const rawWrite = (ctx, op, child, id, input) => direct(ctx, () => runtime.query('SELECT hon.mutate_achievements($1,$2,$3::uuid,$4::uuid,$5::jsonb,$6,$7::uuid,$8::uuid)', [ctx.externalSubject, op, child, id, JSON.stringify(input), ctx.idempotencyKey, ctx.requestId, ctx.correlationId]));
async function snapshot(tables) { const data = {}; for (const t of tables) data[t] = (await admin.query(`SELECT to_jsonb(t) record FROM hon.${t} t ORDER BY to_jsonb(t)::text`)).rows; return data; }
async function waiting(work, update, expectedStatus) {
  await admin.query('BEGIN'); await update(); const pending = work().then(() => ({ allowed: true }), e => ({ status: e.getStatus?.() }));
  let blocked = false;
  for (let i = 0; i < 100; i++) { if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE usename='hon_achievement_runtime' AND wait_event_type='Lock'")).rows.length) { blocked = true; break; } await new Promise(resolve => setTimeout(resolve, 20)); }
  assert(blocked, 'Expected a real live dependency lock wait'); await admin.query('COMMIT'); assert.equal((await pending).status, expectedStatus);
}
await Promise.all([admin.connect(), runtime.connect()]);
try {
  for (const t of achievementTables) assert.equal((await admin.query(`SELECT count(*) n FROM hon.${t}`)).rows[0].n, '0', 'Fresh disposable fixture database required');
  await verifyAchievementSecurity(admin, 'hon_achievement_runtime');
  await admin.query('BEGIN');
  for (const id of [org, otherOrg]) await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE legal name','PRIVATE organization')", [id]);
  for (const [id, o] of [[school, org], [siblingSchool, org], [otherSchool, otherOrg]]) await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'PRIVATE school',$1::text,'America/New_York')", [id, o]);
  // Essential recognition is not restricted by any entitlement/tier. Test no entitlement row at all first.
  for (const [who, h] of Object.entries(actors)) {
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE human')", [h.user, h.subject, h.subject + '@example.test']);
    await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,is_active,display_name) VALUES($1,'HUMAN_USER',$2,$3,'PRIVATE human')", [h.id, h.user, who !== 'inactive']);
    const roleCode = who === 'parent' ? 'PARENT' : who === 'hq' ? 'HQ_SUPPORT' : who === 'owner' ? 'OWNER' : 'INSTRUCTOR_' + who.toUpperCase();
    await admin.query('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role,management_school_id) VALUES($1,$2,$3,$3,$4,$5)', [h.role, h.org, roleCode, who === 'owner', who === 'wrongRoleSchool' ? siblingSchool : null]);
    const permissions = who === 'reader' ? ['achievement.award.read'] : who === 'recorder' ? ['achievement.award.record'] : who === 'definitionManager' ? ['achievement.definition.manage'] : who === 'noPermission' ? [] : codes;
    for (const code of permissions) await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [h.role, h.org, code]);
    await admin.query("INSERT INTO hon.principal_role_grants(id,principal_id,organization_id,school_id,role_id,granted_by_principal_id,effective_from,effective_until) VALUES($1,$2,$3,$4,$5,$2,clock_timestamp()+$6::interval,CASE WHEN $7 THEN clock_timestamp()-interval '1 day' ELSE NULL END)", [h.grant, h.id, h.org, h.school, h.role, who === 'future' ? '1 day' : who === 'expired' ? '-2 days' : '-1 day', who === 'expired']);
  }
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$3,$4,'PRIVATE family'),($2,$3,$4,'PRIVATE other family')", [family, otherFamily, org, school]);
  for (const [id, person] of people) {
    const f = id === outsider ? otherFamily : family;
    await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'PRIVATE child','PRIVATE surname','private@example.test')", [person, org, school]);
    await admin.query("INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id,birth_date,status) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, org, school, person, f, id === unknownAge ? null : '2017-01-01', id === inactiveStudent ? 'SUSPENDED' : 'ACTIVE']);
    await admin.query("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')", [org, school, f, person]);
  }
  await admin.query("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,'PRIMARY_GUARDIAN',$6)", [parentGrant, org, school, family, actors.parent.id, actors.owner.id]);
  const curriculumId = randomUUID(), rankId = randomUUID(), enrollmentId = randomUUID(), testingId = randomUUID(), programId = randomUUID(), sessionId = randomUUID();
  await admin.query("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code) VALUES($1,$2,$3,'Existing curriculum','LINEAR')", [curriculumId, org, school]);
  await admin.query("INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,'Existing rank',1)", [rankId, org, school, curriculumId]);
  await admin.query("INSERT INTO hon.student_curriculum_enrollments(id,organization_id,school_id,student_profile_id,curriculum_id,current_rank_id) VALUES($1,$2,$3,$4,$5,$6)", [enrollmentId, org, school, student, curriculumId, rankId]);
  await admin.query("INSERT INTO hon.testing_events(id,organization_id,school_id,curriculum_id,name,starts_at) VALUES($1,$2,$3,$4,'Existing human testing event',clock_timestamp()+interval '30 days')", [testingId, org, school, curriculumId]);
  await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$2,$3,'Existing program')", [programId, org, school]);
  await admin.query("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy) VALUES($1,$2,$3,$4,'Existing class',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',20,'WALK_IN')", [sessionId, org, school, programId]);
  await admin.query("INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,recorded_by_principal_id,note) VALUES($1,$2,$3,$4,'PRESENT',$5,'Existing human attendance')", [org, school, sessionId, student, actors.instructor.id]);
  await admin.query('COMMIT');
  for (const who of ['parent', 'hq', 'inactive', 'future', 'expired', 'wrongRoleSchool', 'noPermission']) {
    assert.equal(await database.resolveAchievementScope(actors[who].subject, actors[who].school), undefined, who);
    await deny(() => svc.access(c(who))); await deny(() => svc.saveDefinition(c(who), null, definitionInput()));
  }
  for (const patch of [{ source: 'AI_TOOL' }, { source: 'PUBLIC_API' }, { principalType: 'AI_EMPLOYEE' }, { principalType: 'AUTOMATION' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) {
    await deny(() => svc.access(c('owner', patch))); const ctx = c('owner', patch);
    await sqlDeny(() => direct(ctx, () => runtime.query("SELECT hon.read_achievements($1,'ACCESS')", [ctx.externalSubject])));
    await sqlDeny(() => rawWrite(ctx, 'DEFINITION', null, null, definitionInput()));
  }
  for (const patch of [{ principalId: actors.instructor.id }, { externalSubject: actors.instructor.subject }, { organizationId: otherOrg }, { schoolId: siblingSchool }]) await deny(() => svc.access(c('owner', patch)));
  assert.deepEqual(await svc.access(c('reader')), { canReadDefinitions: false, canManageDefinitions: false, canReadAwards: true, canRecordAwards: false });
  assert.deepEqual(await svc.access(c('recorder')), { canReadDefinitions: false, canManageDefinitions: false, canReadAwards: false, canRecordAwards: true });
  await deny(() => svc.definitions(c('definitionManager'))); await deny(() => svc.definitions(c('reader')));
  await deny(() => svc.awards(c('recorder'), student)); await deny(() => svc.saveDefinition(c('reader'), null, definitionInput()));
  // Snapshot every nonachievement operational/domain/provider table. Test-specific IAM/topology changes excluded.
  const operationalTables = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='hon' AND tablename NOT LIKE 'achievement_%' AND tablename NOT IN('roles','role_permissions','principal_role_grants','principals','users','student_profiles','family_members','family_access_grants','families','schools','organizations','organization_entitlements') ORDER BY tablename")).rows.map(x => x.tablename);
  const baseline = await snapshot(operationalTables);
  let d = (await svc.saveDefinition(c(), null, definitionInput())).result;
  assert.equal((await svc.definitions(c('other'))).items.length, 0); assert.equal((await svc.definitions(c('siblingSchool'))).items.length, 0);
  await deny(() => svc.history(c('other'), 'DEFINITION', d.id), 404); await deny(() => svc.saveDefinition(c('siblingSchool'), d.id, definitionRevision(d)), 404);
  const invalidDefinitions = [{ name: '' }, { name: ' ' }, { name: 'a'.repeat(101) }, { name: 'Test ready' }, { description: 'Guaranteed promotion' }, { name: '<script>' }, { name: 'hidden\u200bname' }, { description: 'a'.repeat(601) }, { category: 'RANK' }, { ageBand: 'ALL_AGES' }, { visualToken: 'https://evil.test' }, { visualToken: {} }, { status: 'ARCHIVED' }, { expectedVersion: 1.5 }, { rules: {} }, { score: 100 }, { script: 'x' }, { name: null }];
  for (const patch of invalidDefinitions) { await deny(() => svc.saveDefinition(c(), null, definitionInput(patch)), 400); await sqlDeny(() => rawWrite(c(), 'DEFINITION', null, null, definitionInput(patch)), '22023'); }
  for (const [child, status] of [[unknownAge, 400], [inactiveStudent, 404], [randomUUID(), 404]]) await deny(() => svc.saveAward(c(), child, null, awardInput(d)), status);
  for (const patch of [{ definitionVersion: 9 }, { definitionId: randomUUID() }]) await deny(() => svc.saveAward(c(), student, null, awardInput(d, patch)), 404);
  for (const patch of [{ awardedOn: '2099-01-01' }, { awardedOn: '2026-02-30' }, { awardedOn: '2026-01-10T00:00:00Z' }, { awardedOn: '2016-01-01' }, { visibleToFamily: 'true' }, { reason: 'x'.repeat(1001) }, { reason: '' }, { reason: '<script>' }, { status: 'WITHDRAWN' }, { studentProfileId: sibling }, { points: 1 }, { eligibility: true }]) {
    await deny(() => svc.saveAward(c(), student, null, awardInput(d, patch)), 400);
    await assert.rejects(() => rawWrite(c(), 'AWARD', student, null, awardInput(d, patch)), e => ['22023', '22008'].includes(e.code));
  }
  for (const ageBand of ['EARLY_CHILDHOOD', 'TEEN', 'ADULT']) { const ageDef = (await svc.saveDefinition(c(), null, definitionInput({ ageBand }))).result; await deny(() => svc.saveAward(c(), student, null, awardInput(ageDef)), 400); }
  let a = (await svc.saveAward(c('instructor'), student, null, awardInput(d))).result;
  assert.equal(a.awardedByPrincipalId, actors.instructor.id); assert.equal(a.recordedByPrincipalId, actors.instructor.id);
  const privateAward = (await svc.saveAward(c(), student, null, awardInput(d, { visibleToFamily: false, reason: null }))).result;
  const siblingAward = (await svc.saveAward(c(), sibling, null, awardInput(d))).result;
  const outsideAward = (await svc.saveAward(c(), outsider, null, awardInput(d))).result;
  const parent = () => svc.parent(c('parent'), family, student);
  let p = await parent(); assert.equal(p.studentProfileId, student); assert.deepEqual(p.items.map(x => x.id), [a.id]);
  assert.deepEqual(Object.keys(p.items[0]).sort(), ['awardedOn', 'definition', 'id']);
  const serialized = JSON.stringify(p); for (const secret of ['PRIVATE', 'reason', 'actor', 'schoolId', 'familyId', 'versionHistory', siblingAward.id, outsideAward.id, privateAward.id]) assert(!serialized.includes(secret), secret);
  await deny(() => svc.parent(c('parent'), family, outsider)); await deny(() => svc.parent(c('parent'), otherFamily, student));
  await deny(() => svc.parent(c('owner'), family, student)); await deny(() => svc.history(c('parent'), 'AWARD', a.id, student)); await deny(() => svc.saveAward(c('parent'), student, null, awardInput(d)));
  await deny(() => svc.history(c(), 'AWARD', a.id, sibling), 404); await deny(() => svc.saveAward(c(), sibling, a.id, awardRevision(a)), 404);
  await deny(() => svc.saveAward(c('other'), student, null, awardInput(d)), 404);
  // Pinned definitions never silently rewrite recognition after school metadata edits/archive.
  const createContext = c(); const replayInput = awardInput(d); const created = await svc.saveAward(createContext, student, null, replayInput);
  const stateBeforeReplay = await snapshot(achievementTables); const replay = await svc.saveAward(createContext, student, null, replayInput);
  assert(replay.replayed); assert.deepEqual(replay.result, created.result); assert.deepEqual(await snapshot(achievementTables), stateBeforeReplay);
  await deny(() => svc.saveAward(createContext, student, null, awardInput(d, { reason: 'Different intent' })), 409);
  d = (await svc.saveDefinition(c('definitionManager'), d.id, definitionRevision(d, { name: 'Steady practice' }))).result;
  assert.equal((await svc.awards(c('reader'), student)).items.find(x => x.id === a.id).definition.name, 'Careful practice');
  await deny(() => svc.saveAward(c(), student, null, awardInput({ ...d, version: 1 })), 404);
  await deny(() => svc.saveAward(c(), student, a.id, awardRevision(a, { definitionVersion: 2 })), 409);
  a = (await svc.saveAward(c('recorder'), student, a.id, awardRevision(a, { visibleToFamily: false, reason: 'Private corrected reason' }))).result;
  assert.equal(a.awardedByPrincipalId, actors.instructor.id, 'original award attribution is immutable across corrections'); assert.equal(a.recordedByPrincipalId, actors.recorder.id, 'revision attribution reflects the correcting human');
  assert(!(await parent()).items.some(x => x.id === a.id));
  assert.deepEqual((await svc.history(c('reader'), 'AWARD', a.id, student)).items.map(x => x.version), [2, 1]);
  a = (await svc.saveAward(c(), student, a.id, awardRevision(a, { visibleToFamily: true }))).result;
  d = (await svc.saveDefinition(c(), d.id, definitionRevision(d, { status: 'ARCHIVED' }))).result;
  await deny(() => svc.saveAward(c(), student, null, awardInput(d)), 404); await deny(() => svc.saveDefinition(c(), d.id, definitionRevision(d)), 409);
  assert((await parent()).items.some(x => x.id === a.id));
  a = (await svc.saveAward(c(), student, a.id, awardRevision(a, { status: 'WITHDRAWN', visibleToFamily: false }))).result;
  assert(!(await parent()).items.some(x => x.id === a.id)); await deny(() => svc.saveAward(c(), student, a.id, awardRevision(a)), 409);
  assert((await svc.history(c(), 'AWARD', a.id, student)).items.some(x => x.version === 1 && x.visibleToFamily));
  // Staff role/permission/principal revocation blocks reads, mutations and unchanged replay.
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$1 WHERE id=$2', [actors.owner.id, actors.owner.grant]);
  await deny(() => svc.saveAward(createContext, student, null, replayInput)); await deny(() => svc.awards(c(), student));
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1', [actors.owner.grant]);
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='achievement.award.record'", [actors.owner.role]); await deny(() => svc.saveAward(createContext, student, null, replayInput));
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'achievement.award.record')", [actors.owner.role, org]);
  await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1', [actors.owner.id]); await deny(() => svc.saveAward(createContext, student, null, replayInput)); await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1', [actors.owner.id]);
  // Staff authority is rechecked after actual permission lock waits, including replay.
  await waiting(() => svc.saveAward(createContext, student, null, replayInput), () => admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$1 WHERE id=$2', [actors.owner.id, actors.owner.grant]), 403);
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1', [actors.owner.grant]);
  await waiting(parent, () => admin.query("UPDATE hon.family_access_grants SET effective_until=clock_timestamp() WHERE id=$1", [parentGrant]), 403);
  await admin.query('UPDATE hon.family_access_grants SET effective_until=NULL WHERE id=$1', [parentGrant]);
  await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1', [actors.parent.id]); await deny(parent); await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1', [actors.parent.id]);
  await waiting(parent, () => admin.query("UPDATE hon.family_members SET member_role='OTHER' WHERE family_id=$1 AND person_id=$2", [family, people.get(student)]), 403);
  await admin.query("UPDATE hon.family_members SET member_role='STUDENT' WHERE family_id=$1 AND person_id=$2", [family, people.get(student)]);
  await admin.query('UPDATE hon.student_profiles SET primary_family_id=$1 WHERE id=$2', [otherFamily, student]); await deny(parent); await admin.query('UPDATE hon.student_profiles SET primary_family_id=$1 WHERE id=$2', [family, student]);
  for (const [table, id] of [['families', family], ['schools', school], ['organizations', org]]) { await admin.query(`UPDATE hon.${table} SET status='SUSPENDED' WHERE id=$1`, [id]); await deny(parent); if (table !== 'families') await deny(() => svc.access(c())); await admin.query(`UPDATE hon.${table} SET status='ACTIVE' WHERE id=$1`, [id]); }
  // No tier restriction including Essential/Core/Complete; these rows do not grant authority.
  for (const tier of ['ESSENTIAL', 'CORE', 'COMPLETE']) { await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,$2,'ACTIVE',clock_timestamp()-interval '1 day') ON CONFLICT(organization_id) DO UPDATE SET tier=excluded.tier", [org, tier]); assert((await svc.access(c())).canRecordAwards); }
  const activeDefinition = (await svc.saveDefinition(c(), null, definitionInput())).result;
  const sameContext = c(); const concurrent = await Promise.all([svc.saveAward(sameContext, student, null, awardInput(activeDefinition)), svc.saveAward(sameContext, student, null, awardInput(activeDefinition))]);
  assert.deepEqual(concurrent.map(x => x.replayed).sort(), [false, true]); assert.equal(concurrent[0].result.id, concurrent[1].result.id);
  let raceAward = concurrent[0].result;
  const competing = await Promise.allSettled([svc.saveAward(c(), student, raceAward.id, awardRevision(raceAward)), svc.saveAward(c('instructor'), student, raceAward.id, awardRevision(raceAward))]);
  assert.equal(competing.filter(x => x.status === 'fulfilled').length, 1); assert.equal(competing.find(x => x.status === 'rejected').reason.getStatus(), 409);
  raceAward = (await svc.awards(c(), student)).items.find(x => x.id === raceAward.id);
  for (let i = 0; i < 31; i++) raceAward = (await svc.saveAward(c(), student, raceAward.id, awardRevision(raceAward))).result;
  const h = await svc.history(c(), 'AWARD', raceAward.id, student); assert.equal(h.items.length, 30); assert.equal((await svc.history(c(), 'AWARD', raceAward.id, student, h.nextBefore)).items.length, 3);
  for (let i = 0; i < 31; i++) await svc.saveAward(c(), student, null, awardInput(activeDefinition));
  const page = await svc.awards(c(), student); assert.equal(page.items.length, 30); assert((await svc.awards(c(), student, page.nextAfter)).items.every(x => x.id > page.nextAfter));
  const parentPage = await parent(); assert.equal(parentPage.items.length, 30); assert((await svc.parent(c('parent'), family, student, parentPage.nextAfter)).items.every(x => x.id > parentPage.nextAfter));
  // Failure at EACH transaction evidence stage rolls back identity, revision, audit, outbox and receipt.
  for (const stage of ['achievement_events', 'achievement_outbox', 'achievement_requests']) {
    const before = await snapshot(achievementTables);
    await admin.query(`CREATE FUNCTION hon.achievement_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$; CREATE TRIGGER achievement_fixture_failure BEFORE INSERT ON hon.${stage} FOR EACH ROW EXECUTE FUNCTION hon.achievement_fixture_failure()`);
    await deny(() => svc.saveAward(c(), student, null, awardInput(activeDefinition)), 503); assert.deepEqual(await snapshot(achievementTables), before);
    await admin.query(`DROP TRIGGER achievement_fixture_failure ON hon.${stage}; DROP FUNCTION hon.achievement_fixture_failure()`);
  }
  for (const t of achievementTables) {
    assert.equal((await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') allowed", [`hon.${t}`])).rows[0].allowed, false);
    await sqlDeny(() => runtime.query(`SELECT * FROM hon.${t}`)); await sqlDeny(() => runtime.query(`TRUNCATE hon.${t}`));
    await sqlDeny(() => admin.query(`UPDATE hon.${t} SET ${t === 'achievement_outbox' ? 'status=status' : t === 'achievement_definition_versions' ? 'name=name' : t === 'achievement_award_versions' ? 'reason=reason' : t === 'achievement_requests' ? 'fingerprint=fingerprint' : 'id=id'}`));
    await sqlDeny(() => admin.query(`DELETE FROM hon.${t}`));
  }
  for (const [signature, allowed] of achievementFunctions) assert.equal((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed", [signature])).rows[0].allowed, allowed);
  await admin.query('GRANT SELECT ON hon.achievement_award_versions TO hon_achievement_runtime'); assert.equal((await direct(c(), () => runtime.query('SELECT * FROM hon.achievement_award_versions'))).rows.length, 0); await admin.query('REVOKE SELECT ON hon.achievement_award_versions FROM hon_achievement_runtime');
  await admin.query('CREATE ROLE achievement_rls_probe NOSUPERUSER NOBYPASSRLS NOLOGIN; GRANT USAGE ON SCHEMA hon TO achievement_rls_probe; ALTER TABLE hon.achievement_award_versions OWNER TO achievement_rls_probe; SET ROLE achievement_rls_probe'); assert.equal((await admin.query('SELECT * FROM hon.achievement_award_versions')).rows.length, 0); await admin.query('RESET ROLE; ALTER TABLE hon.achievement_award_versions OWNER TO hon_achievement_owner; DROP OWNED BY achievement_rls_probe; DROP ROLE achievement_rls_probe');
  const canonical = (await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8')).replaceAll('hon_runtime', 'hon_achievement_runtime');
  const sql = () => execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', 'hon_achievement_validation', '-v', 'ON_ERROR_STOP=1'], { input: canonical, stdio: ['pipe', 'pipe', 'pipe'] });
  const js = () => execFileSync('node', ['scripts/verify-rls.mjs'], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] }); sql(); js();
  const drifts = [
    ['inert outbox', 'ALTER TABLE hon.achievement_outbox DROP CONSTRAINT achievement_outbox_status_check', "ALTER TABLE hon.achievement_outbox ADD CONSTRAINT achievement_outbox_status_check CHECK(status='INERT')"],
    ['table SELECT', 'GRANT SELECT ON hon.achievement_award_versions TO hon_achievement_runtime', 'REVOKE SELECT ON hon.achievement_award_versions FROM hon_achievement_runtime'],
    ['column SELECT', 'GRANT SELECT(reason) ON hon.achievement_award_versions TO hon_achievement_runtime', 'REVOKE SELECT(reason) ON hon.achievement_award_versions FROM hon_achievement_runtime'],
    ['PUBLIC execute', 'GRANT EXECUTE ON FUNCTION hon.read_parent_achievements(text,uuid,uuid,uuid) TO PUBLIC', 'REVOKE EXECUTE ON FUNCTION hon.read_parent_achievements(text,uuid,uuid,uuid) FROM PUBLIC'],
    ['helper execute', 'GRANT EXECUTE ON FUNCTION hon.achievement_award_projection(uuid,integer,boolean) TO hon_achievement_runtime', 'REVOKE EXECUTE ON FUNCTION hon.achievement_award_projection(uuid,integer,boolean) FROM hon_achievement_runtime'],
    ['grant option', 'GRANT EXECUTE ON FUNCTION hon.resolve_achievement_scope(text,uuid) TO hon_achievement_runtime WITH GRANT OPTION', 'REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION hon.resolve_achievement_scope(text,uuid) FROM hon_achievement_runtime'],
    ['search path', 'ALTER FUNCTION hon.read_parent_achievements(text,uuid,uuid,uuid) SET search_path=public,hon', 'ALTER FUNCTION hon.read_parent_achievements(text,uuid,uuid,uuid) SET search_path=pg_catalog,hon'],
    ['definer', 'ALTER FUNCTION hon.read_achievements(text,text,uuid,uuid,uuid,integer) SECURITY INVOKER', 'ALTER FUNCTION hon.read_achievements(text,text,uuid,uuid,uuid,integer) SECURITY DEFINER'],
    ['FORCE RLS', 'ALTER TABLE hon.achievement_awards NO FORCE ROW LEVEL SECURITY', 'ALTER TABLE hon.achievement_awards FORCE ROW LEVEL SECURITY'],
    ['RLS', 'ALTER TABLE hon.achievement_definitions DISABLE ROW LEVEL SECURITY', 'ALTER TABLE hon.achievement_definitions ENABLE ROW LEVEL SECURITY'],
    ['policy', 'CREATE POLICY achievement_probe ON hon.achievement_award_versions USING(true)', 'DROP POLICY achievement_probe ON hon.achievement_award_versions'],
    ['immutable trigger', 'ALTER TABLE hon.achievement_awards DISABLE TRIGGER achievement_immutable', 'ALTER TABLE hon.achievement_awards ENABLE TRIGGER achievement_immutable'],
    ['truncate trigger', 'ALTER TABLE hon.achievement_requests DISABLE TRIGGER achievement_no_truncate', 'ALTER TABLE hon.achievement_requests ENABLE TRIGGER achievement_no_truncate'],
  ];
  for (const [name, drift, restore] of drifts) { await admin.query(drift); try { assert.throws(js, name + ': JS accepted drift'); assert.throws(sql, name + ': canonical accepted drift'); console.log('Denied achievement drift: ' + name); } finally { await admin.query(restore); } }
  assert.deepEqual(await snapshot(operationalTables), baseline, 'No rank/testing/attendance/observations/points/AI/provider/action/communication/payments/domain effects');
  assert.equal((await admin.query("SELECT count(*) n FROM hon.achievement_outbox WHERE status<>'INERT' OR execution_allowed")).rows[0].n, '0');
  assert.equal((await admin.query('SELECT count(*) n FROM hon.achievement_outbox')).rows[0].n, (await admin.query('SELECT count(*) n FROM hon.achievement_events')).rows[0].n);
  await verifyAchievementSecurity(admin, 'hon_achievement_runtime');
  console.log('Achievement integrity passed: exact human staff permissions; private known-school definitions; age/date/category/title validation; immutable pinned awards/history; parent exact-child redaction/latest visibility; live revocation/replay/real lock waits; concurrency and bounded pages; RLS/ACL and dual drift verifiers; atomic rollback and zero operational/provider/AI/action/communication/payment effects.');
} finally {
  await admin.query('ROLLBACK'); await database.onModuleDestroy(); await Promise.all([admin.end(), runtime.end()]);
}
