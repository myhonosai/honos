import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const owner = new URL(process.env.DATABASE_URL ?? ''), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_parent_journey_validation' || owner.username !== 'hon_parent_journey_owner'
  || runtime.hostname !== owner.hostname || runtime.port !== owner.port || runtime.pathname !== owner.pathname || runtime.username !== 'hon_parent_journey_runtime') throw new Error('Only the exact isolated localhost Journey validation database is permitted.');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { ParentJourneyViewService } = await import('../../../apps/api/dist/families/parent-journey-view.service.js');
const { ParentStudentJourneyService } = await import('../../../apps/api/dist/families/parent-student-journey.service.js');
const { ParentFamilyScheduleService } = await import('../../../apps/api/dist/families/parent-family-schedule.service.js');
const { AchievementsService } = await import('../../../apps/api/dist/achievements/achievements.service.js');
const { DocumentService } = await import('../../../apps/api/dist/documents/document.service.js');
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false });
const db = new RuntimeDatabaseService();
const view = new ParentJourneyViewService(db, new ParentStudentJourneyService(db), new ParentFamilyScheduleService(db), new AchievementsService(db), new DocumentService(db));
const ids = Object.fromEntries(['organization', 'school', 'otherSchool', 'user', 'principal', 'coUser', 'coPrincipal', 'family', 'otherFamily', 'person', 'sibling', 'outsider', 'profile', 'siblingProfile', 'outsideProfile', 'grant', 'coGrant', 'program', 'session', 'siblingSession', 'outsideSession', 'staffUser', 'staffPrincipal', 'staffRole', 'curriculum', 'rank'].map(k => [k, randomUUID()]));
const subject = `journey-parent-${randomUUID()}`, coSubject = `journey-coparent-${randomUUID()}`, staffSubject = `journey-staff-${randomUUID()}`;
await admin.connect();
try {
  // Isolated new database only; fixtures remain for inspection and are removed
  // by the explicitly opt-in setup reset, never by a deployed-data cleanup.
  await admin.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)', [ids.organization, 'PRIVATE_ORGANIZATION']);
  await admin.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,$3,$4),($5,$2,$3,$6)', [ids.school, ids.organization, 'PRIVATE_SCHOOL', `journey-${ids.school}`, ids.otherSchool, `journey-${ids.otherSchool}`]);
  await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4),($5,$6,$7,$8)', [ids.user, subject, `${ids.user}@example.test`, 'PRIVATE_PARENT', ids.coUser, coSubject, `${ids.coUser}@example.test`, 'PRIVATE_COPARENT']);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3),($4,'HUMAN_USER',$5,$6)", [ids.principal, ids.user, 'PRIVATE_PARENT', ids.coPrincipal, ids.coUser, 'PRIVATE_COPARENT']);
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PRIVATE_FAMILY'),($4,$2,$3,'PRIVATE_OTHER_FAMILY')", [ids.family, ids.organization, ids.school, ids.otherFamily]);
  await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Avery','Allowed'),($4,$2,$3,'Blair','Allowed'),($5,$2,$3,'PRIVATE_OUTSIDER','Denied')", [ids.person, ids.organization, ids.school, ids.sibling, ids.outsider]);
  for (const [person, profile, family] of [[ids.person, ids.profile, ids.family], [ids.sibling, ids.siblingProfile, ids.family], [ids.outsider, ids.outsideProfile, ids.otherFamily]]) {
    await admin.query("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')", [ids.organization, ids.school, family, person]);
    await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id) VALUES($1,$2,$3,$4,$5)', [profile, ids.organization, ids.school, person, family]);
  }
  await admin.query("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,'PRIMARY_GUARDIAN',now()-interval '1 day',$5),($6,$2,$3,$4,$7,'SECONDARY_GUARDIAN',now()-interval '1 day',$5)", [ids.grant, ids.organization, ids.school, ids.family, ids.principal, ids.coGrant, ids.coPrincipal]);
  await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Actual program','SCHEDULED')", [ids.program, ids.organization, ids.school]);
  for (const [session, student, name] of [[ids.session, ids.profile, 'Avery class'], [ids.siblingSession, ids.siblingProfile, 'Blair class'], [ids.outsideSession, ids.outsideProfile, 'PRIVATE_OTHER_FAMILY_CLASS']]) {
    await admin.query("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status) VALUES($1,$2,$3,$4,$5,now()+interval '1 day',now()+interval '1 day 1 hour',10,'REQUIRED_BOOKING','SCHEDULED')", [session, ids.organization, ids.school, ids.program, name]);
    await admin.query("INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,status,source) VALUES($1,$2,$3,$4,'REGULAR','BOOKED','PARENT_APP')", [ids.organization, ids.school, session, student]);
  }
  // Explicit existing staff commands create disposable test data; the Journey
  // itself still imports/calls only read functions. Staff without a family
  // grant must never acquire parent authority from these permissions.
  const { CurriculumProgressService } = await import('../../../apps/api/dist/curriculum/curriculum-progress.service.js');
  const curriculum = new CurriculumProgressService(db), achievement = new AchievementsService(db), document = new DocumentService(db);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_STAFF')", [ids.staffUser, staffSubject, `${ids.staffUser}@example.test`]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_STAFF')", [ids.staffPrincipal, ids.staffUser]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'INSTRUCTOR_JOURNEY_FIXTURE','PRIVATE_STAFF_ROLE')", [ids.staffRole, ids.organization]);
  for (const permission of ['curriculum.manage','curriculum.progress.record','achievement.definition.manage','achievement.award.record','document.template.create','document.publish','document.read']) {
    await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [ids.staffRole, ids.organization, permission]);
  }
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,now()-interval '1 day')", [ids.organization, ids.school, ids.staffPrincipal, ids.staffRole]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'ESSENTIAL',now()-interval '1 day')", [ids.organization]);
  await admin.query("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code) VALUES($1,$2,$3,'Actual current curriculum','LINEAR')", [ids.curriculum, ids.organization, ids.school]);
  await admin.query("INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,'Actual current rank',1)", [ids.rank, ids.organization, ids.school, ids.curriculum]);
  await admin.query("UPDATE hon.student_profiles SET birth_date='2017-01-01' WHERE id IN($1,$2,$3)", [ids.profile, ids.siblingProfile, ids.outsideProfile]);
  const staff = () => ({ organizationId: ids.organization, schoolId: ids.school, principalId: ids.staffPrincipal, externalSubject: staffSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID() });
  const requirement = (await curriculum.createRequirement(staff(), ids.curriculum, ids.rank, { code: 'ACTUAL_FORM', kind: 'TECHNIQUE', definition: { label: 'Actual form practice', description: 'PRIVATE_REQUIREMENT_DESCRIPTION' }, required: true })).record;
  const enrollment = (await curriculum.enroll(staff(), ids.curriculum, { studentProfileId: ids.profile, currentRankId: ids.rank })).record;
  await curriculum.observe(staff(), ids.curriculum, enrollment.id, { requirementId: requirement.id, expectedRequirementVersion: requirement.version, expectedEnrollmentVersion: enrollment.version, expectedProgressVersion: 0, status: 'PRACTICING', instructorNote: 'PRIVATE_PROGRESS_NOTE' });
  const definition = (await achievement.saveDefinition(staff(), null, { expectedVersion: 0, name: 'Actual shared achievement', description: 'Human-recorded careful practice.', category: 'EFFORT', ageBand: 'CHILD', visualToken: null, status: 'ACTIVE' })).result;
  const awardInput = visibleToFamily => ({ expectedVersion: 0, definitionId: definition.id, definitionVersion: definition.version, reason: 'PRIVATE_AWARD_REASON', awardedOn: '2026-01-10', visibleToFamily, status: 'AWARDED' });
  const award = (await achievement.saveAward(staff(), ids.profile, null, awardInput(true))).result;
  await achievement.saveAward(staff(), ids.profile, null, awardInput(false));
  await achievement.saveAward(staff(), ids.outsideProfile, null, awardInput(true));
  const draft = (await document.create({ ...staff(), audienceMode: 'STAFF' }, { audience: 'PARENT', familyId: ids.family, title: 'Actual family document', content: 'PRIVATE_DOCUMENT_CONTENT' })).record;
  const publication = (await document.publish({ ...staff(), audienceMode: 'STAFF' }, draft.id, { expectedVersion: draft.version, versionId: draft.versionId })).record;
  // Another parent's own receipt is never part of the Journey projection.
  await document.acknowledge({ organizationId: ids.organization, schoolId: ids.school, principalId: ids.coPrincipal, externalSubject: coSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), audienceMode: 'PARENT' }, publication.currentPublicationId, { contentHash: publication.contentHash, choice: 'ACKNOWLEDGE', attestationText: 'PRIVATE_COPARENT_ATTESTATION' });
  await assert.rejects(view.get(staffSubject), e => e.getStatus() === 403);
  const snapshot = async () => (await admin.query(`SELECT coalesce(jsonb_object_agg(table_name,n),'{}') counts FROM (SELECT table_name,(xpath('/row/n/text()',query_to_xml(format('SELECT count(*) n FROM hon.%I',table_name),false,true,'')))[1]::text::bigint n FROM information_schema.tables WHERE table_schema='hon' AND table_type='BASE TABLE') rows`)).rows[0].counts;
  const effectsBefore = await snapshot();
  const first = await view.get(subject);
  assert.equal(first.data.children.length, 2); assert.equal(first.data.children[0].schedule.items[0].name, 'Avery class'); assert.equal(first.data.children[1].schedule.items[0].name, 'Blair class');
  assert.equal(first.data.children[0].achievements.status, 'AVAILABLE'); assert.equal(first.data.children[0].achievements.items.length, 1);
  assert.equal(first.data.children[0].achievements.items[0].name, 'Actual shared achievement');
  assert.equal(first.data.children[0].programs[0].name, 'Actual current curriculum');
  assert.equal(first.data.children[0].programs[0].rank, 'Actual current rank');
  assert.equal(first.data.children[0].programs[0].requirements.items[0].status, 'PRACTICING');
  assert.equal(first.data.documents.items[0].title, 'Actual family document');
  assert.equal(first.data.documentReceipts.status, 'UNAVAILABLE'); assert.equal(first.data.plannedAbsences.status, 'UNAVAILABLE');
  assert(!/PRIVATE_|familyId|studentProfileId|principalId|schoolId|organizationId|payment|invoice|staffNote|rationale/.test(JSON.stringify(first.data)));
  assert.deepEqual(await snapshot(), effectsBefore, 'Journey reads must leave every domain/audit/outbox/provider/action/payment/communication table count unchanged');
  await achievement.saveAward(staff(), ids.profile, award.id, { ...awardInput(false), expectedVersion: award.version, status: 'WITHDRAWN' });
  const withdrawn = await view.get(subject); assert.equal(withdrawn.data.children[0].achievements.items.length, 0);
  const co = await view.get(coSubject); assert.equal(co.data.accessLevel, 'SECONDARY_GUARDIAN'); assert(!JSON.stringify(co.data).includes('PRIVATE_PARENT'));
  await assert.rejects(view.get(`unknown-${randomUUID()}`), e => e.getStatus() === 403);
  // Current family ambiguity does not pick the first authorized family.
  const extraGrant = randomUUID(); await admin.query("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,'VIEWER',now()-interval '1 day',$5)", [extraGrant, ids.organization, ids.school, ids.otherFamily, ids.principal]);
  await assert.rejects(view.get(subject), e => e.getStatus() === 409); await admin.query('DELETE FROM hon.family_access_grants WHERE id=$1', [extraGrant]);
  // Expiry, disabled identity and topology revoke existing cached authority.
  await admin.query("UPDATE hon.family_access_grants SET effective_until=now()-interval '1 minute' WHERE id=$1", [ids.grant]);
  await assert.rejects(view.get(subject), e => e.getStatus() === 403);
  await admin.query('UPDATE hon.family_access_grants SET effective_until=NULL WHERE id=$1', [ids.grant]);
  await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1', [ids.principal]); await assert.rejects(view.get(subject), e => e.getStatus() === 403);
  await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1', [ids.principal]);
  await admin.query("UPDATE hon.families SET status='ARCHIVED' WHERE id=$1", [ids.family]); await assert.rejects(view.get(subject), e => e.getStatus() === 403);
  await admin.query("UPDATE hon.families SET status='ACTIVE' WHERE id=$1", [ids.family]);
  await admin.query("UPDATE hon.schools SET status='ARCHIVED' WHERE id=$1", [ids.school]); await assert.rejects(view.get(subject), e => e.getStatus() === 403);
  await admin.query("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.school]);
  await admin.query("UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1", [ids.organization]); await assert.rejects(view.get(subject), e => e.getStatus() === 403);
  await admin.query("UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1", [ids.organization]);
  const ambiguousHuman = randomUUID(); await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_AMBIGUOUS')", [ambiguousHuman, ids.user]);
  await assert.rejects(view.get(subject), e => e.getStatus() === 403); await admin.query('DELETE FROM hon.principals WHERE id=$1', [ambiguousHuman]);
  // Sibling with identical display name cannot receive guessed name-only data.
  await admin.query("UPDATE hon.people SET given_name='Avery' WHERE id=$1", [ids.sibling]); const duplicate = await view.get(subject);
  assert(duplicate.data.children.every(c => c.schedule.status === 'UNAVAILABLE' && c.schedule.reason === 'CHILD_MATCH_UNAVAILABLE'));
  await admin.query("UPDATE hon.people SET given_name='Blair' WHERE id=$1", [ids.sibling]);
  await admin.query('DELETE FROM hon.family_members WHERE family_id=$1 AND person_id=$2', [ids.family, ids.sibling]);
  const removed = await view.get(subject); assert.equal(removed.data.children.length, 1); assert(!JSON.stringify(removed.data).includes('Blair'));
  const posture = (await admin.query(`SELECT p.prosecdef,p.proconfig,has_function_privilege($1,p.oid,'EXECUTE') runtime_execute,NOT EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname=$1)) OR a.is_grantable) closed FROM pg_proc p WHERE p.oid='hon.resolve_parent_journey_scopes(text)'::regprocedure`, [runtime.username])).rows[0];
  assert.equal(posture.prosecdef, true); assert.deepEqual(posture.proconfig, ['search_path=pg_catalog, hon']); assert.equal(posture.runtime_execute, true); assert.equal(posture.closed, true);
  const restricted = new pg.Client({ connectionString: runtime.toString(), ssl: false }); await restricted.connect();
  try { for (const table of ['users', 'principals', 'family_access_grants']) await assert.rejects(restricted.query(`SELECT * FROM hon.${table}`), e => e.code === '42501'); } finally { await restricted.end(); }
  // Run the canonical posture verifier with this isolated runtime alias only.
  await admin.query((await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8')).replaceAll('hon_runtime', runtime.username));
  console.log('PASS: live exact parent discovery, family/sibling/identity/topology revocation, closed ACLs, redaction and zero table-write effects.');
} finally { await db.onModuleDestroy(); await admin.end(); }
