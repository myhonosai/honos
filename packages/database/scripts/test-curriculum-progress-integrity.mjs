import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CurriculumProgressService } from '../../../apps/api/dist/curriculum/curriculum-progress.service.js';
import { CurriculumProgressController } from '../../../apps/api/dist/curriculum/curriculum-progress.controller.js';
import { TestingCandidateService } from '../../../apps/api/dist/testing/testing-candidate.service.js';
import { PromotionDecisionService } from '../../../apps/api/dist/testing/promotion-decision.service.js';
import { ParentStudentJourneyService } from '../../../apps/api/dist/families/parent-student-journey.service.js';
import { ParentStudentJourneyController } from '../../../apps/api/dist/families/parent-student-journey.controller.js';
import { RuntimeDatabaseService } from '../../../apps/api/dist/foundation/runtime-database.service.js';
if(!process.env.DATABASE_URL||!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Protected administrator and restricted runtime URLs required.');
for (const key of ['DATABASE_URL','HON_RUNTIME_DATABASE_URL']) {
 const u=new URL(process.env[key]);
 if(u.hostname!=='localhost'||u.pathname!=='/hon_curriculum_validation') throw new Error('This committed-fixture test requires the disposable local hon_curriculum_validation database; remote databases are forbidden.');
}
const opts=connectionString=>({connectionString,ssl:connectionString.includes('localhost')?false:{rejectUnauthorized:false}});
const admin=new pg.Client(opts(process.env.DATABASE_URL)),runtime=new pg.Client(opts(process.env.HON_RUNTIME_DATABASE_URL));
const db=new RuntimeDatabaseService(),svc=new CurriculumProgressService(db),controller=new CurriculumProgressController(db,svc),journeys=new ParentStudentJourneyService(db),parents=new ParentStudentJourneyController(db,journeys);
const ids=Object.fromEntries(['org','foreignOrg','school','sibling','foreignSchool','manageRole','progressRole','legacyRole','foreignRole','curriculum','otherCurriculum','siblingCurriculum','foreignCurriculum','rank','otherRank','nextRank','siblingRank','foreignRank','family','otherFamily','student','otherStudent','siblingStudent','foreignStudent','test','candidate','pending'].map(k=>[k,randomUUID()]));
const humans=Object.fromEntries(['manager','instructor','legacy','sibling','foreign','parent','outsider'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`curriculum-${k}-${randomUUID()}`} ]));
const orgs=[ids.org,ids.foreignOrg];
const privateTables=['curriculum_progress_observations','curriculum_enrollment_history','curriculum_requirement_versions','curriculum_command_requests'];
const context=(who='instructor',school=ids.school,key=randomUUID())=>({organizationId:school===ids.foreignSchool?ids.foreignOrg:ids.org,schoolId:school,principalId:humans[who].id,externalSubject:humans[who].subject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:key});
const deny=(fn,status=403)=>assert.rejects(async()=>fn(),e=>{assert.equal(e.getStatus?.(),status,e.stack);return true;});
const sqlDeny=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.stack);return true;});
const req=(code='BASICS')=>({code,kind:'TECHNIQUE',definition:{label:'Foundation technique',description:'INTERNAL_DEFINITION_DESCRIPTION'},required:true});
const enroll=(student=ids.student,rank=ids.rank,c=context(),curriculum=ids.curriculum)=>svc.enroll(c,curriculum,{studentProfileId:student,currentRankId:rank});
const observe=(e,r,status='PRACTICING',version=0,c=context())=>svc.observe(c,ids.curriculum,e.id,{requirementId:r.id,expectedRequirementVersion:r.version,expectedEnrollmentVersion:e.version,expectedProgressVersion:version,status,instructorNote:'PRIVATE_INSTRUCTOR_NOTE'});
const count=async t=>Number((await admin.query(`SELECT count(*) n FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs])).rows[0].n);
const snapshot=async tables=>{const out={};for(const t of tables)out[t]=(await admin.query(`SELECT * FROM hon.${t} WHERE organization_id=ANY($1::uuid[]) ORDER BY to_jsonb(${t})::text`,[orgs])).rows;return out;};
let failure=false;const rlsRole=`curriculum_rls_${randomUUID().replaceAll('-','')}`;
async function cleanup(){
 await admin.query('ROLLBACK');
 if(failure){await admin.query('DROP TRIGGER IF EXISTS curriculum_fixture_failure ON hon.outbox_events');await admin.query('DROP TRIGGER IF EXISTS curriculum_fixture_failure ON hon.audit_events');await admin.query('DROP FUNCTION IF EXISTS hon.curriculum_fixture_failure()');}
 await admin.query('BEGIN');try{
  for(const t of [...privateTables,'curriculum_requirements'])await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  for(const t of [...privateTables,'promotion_decisions','testing_candidates','testing_events','curriculum_requirements','student_curriculum_enrollments','curriculum_ranks','curricula','outbox_delivery_attempts','outbox_events','audit_events','idempotency_records','family_access_grants','family_members','student_profiles','families','people','principal_role_grants','role_permissions','organization_entitlements','roles'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs]);
  for(const t of [...privateTables,'curriculum_requirements'])await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
  await admin.query('DELETE FROM hon.schools WHERE organization_id=ANY($1::uuid[])',[orgs]);await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs]);await admin.query('COMMIT');
  await admin.query(`DROP OWNED BY ${rlsRole}`);await admin.query(`DROP ROLE ${rlsRole}`);
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
await Promise.all([admin.connect(),runtime.connect()]);
try{
 await admin.query(`CREATE ROLE ${rlsRole} NOSUPERUSER NOBYPASSRLS NOLOGIN`);
 for(const t of [...privateTables,'curriculum_requirements','users','principals','permissions','roles','role_permissions','principal_role_grants','family_access_grants']){
  assert.equal((await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed",[`hon.${t}`])).rows[0].allowed,false,t);
  await sqlDeny(()=>runtime.query(`SELECT * FROM hon.${t}`));
 }
 assert.equal((await runtime.query("SELECT has_table_privilege(current_user,'hon.student_curriculum_enrollments','INSERT') allowed")).rows[0].allowed,false);
 for(const sig of ['hon.require_curriculum_actor(text,text)','hon.guard_curriculum_history()','hon.guard_curriculum_requirement()','hon.snapshot_curriculum_requirement()','hon.guard_curriculum_enrollment_identity()','hon.validate_curriculum_observation()'])assert.equal((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",[sig])).rows[0].allowed,false,sig);
 const boundaries=['hon.mutate_curriculum_progress(text,text,uuid,uuid,jsonb,text,uuid,uuid)','hon.read_staff_curriculum_progress(text,text,uuid,uuid)','hon.read_parent_curriculum_progress(text,uuid)'];
 for(const sig of boundaries){const acl=(await admin.query("SELECT p.prosecdef,p.proconfig,r.rolsuper OR r.rolbypassrls trusted,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) broad FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure",[sig])).rows[0];assert.equal(acl.prosecdef,true);assert.equal(acl.trusted,true);assert.equal(acl.broad,false);assert.deepEqual(acl.proconfig,['search_path=pg_catalog, hon']);}
 await admin.query('BEGIN');
 for(const org of orgs){await admin.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)',[org,'Curriculum synthetic fixture']);await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'ESSENTIAL',clock_timestamp()-interval '1 day')",[org]);}
 for(const [school,org] of [[ids.school,ids.org],[ids.sibling,ids.org],[ids.foreignSchool,ids.foreignOrg]])await admin.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1::uuid,$2,$3,$1::text)',[school,org,'Fixture school']);
 for(const h of Object.values(humans)){await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)',[h.user,h.subject,`${h.user}@example.test`,'PRIVATE_DIRECTORY']);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY')",[h.id,h.user]);}
 for(const [role,org,code,permissions] of [[ids.manageRole,ids.org,'CURRICULUM_MANAGER',['curriculum.manage']],[ids.progressRole,ids.org,'CURRICULUM_INSTRUCTOR',['curriculum.progress.record']],[ids.legacyRole,ids.org,'LEGACY',['curriculum.rank.manage','people.create','attendance.record','testing.manage']],[ids.foreignRole,ids.foreignOrg,'FOREIGN',['curriculum.manage','curriculum.progress.record']]]){
  await admin.query('INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,$3)',[role,org,code]);for(const permission of permissions)await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[role,org,permission]);
 }
 for(const [who,role,org,school] of [['manager',ids.manageRole,ids.org,ids.school],['instructor',ids.progressRole,ids.org,ids.school],['legacy',ids.legacyRole,ids.org,ids.school],['sibling',ids.progressRole,ids.org,ids.sibling],['foreign',ids.foreignRole,ids.foreignOrg,ids.foreignSchool]])await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')",[org,school,humans[who].id,role]);
 for(const [curriculum,rank,org,school,name] of [[ids.curriculum,ids.rank,ids.org,ids.school,'Main'],[ids.otherCurriculum,ids.otherRank,ids.org,ids.school,'Other'],[ids.siblingCurriculum,ids.siblingRank,ids.org,ids.sibling,'Sibling'],[ids.foreignCurriculum,ids.foreignRank,ids.foreignOrg,ids.foreignSchool,'Foreign']]){
  await admin.query("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code) VALUES($1,$2,$3,$4,'LINEAR')",[curriculum,org,school,name]);await admin.query("INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,'White',1)",[rank,org,school,curriculum]);
 }
 await admin.query("INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,'Next',2)",[ids.nextRank,ids.org,ids.school,ids.curriculum]);
 for(const [family,student,school,org] of [[ids.family,ids.student,ids.school,ids.org],[ids.otherFamily,ids.otherStudent,ids.school,ids.org],[null,ids.siblingStudent,ids.sibling,ids.org],[null,ids.foreignStudent,ids.foreignSchool,ids.foreignOrg]]){
  const person=randomUUID();if(family)await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Family')",[family,org,school]);await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Child','Safe')",[person,org,school]);await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id) VALUES($1,$2,$3,$4,$5)',[student,org,school,person,family]);if(family)await admin.query("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')",[org,school,family,person]);
 }
 await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4,clock_timestamp()-interval '1 day')",[ids.org,ids.school,ids.family,humans.parent.id]);await admin.query('COMMIT');
 const prohibited=['people','student_profiles','family_members','families','family_access_grants','communication_messages','communication_consents','payment_attempts','invoices','memberships','membership_payment_schedules','billing_accounts','action_requests','action_approvals','ai_usage_ledger','ai_invocation_plans','work_items','crm_leads','crm_activities','class_bookings','attendance_records'];const before=await snapshot(prohibited);
 const mc=context('manager'),r=(await svc.createRequirement(mc,ids.curriculum,ids.rank,req())).record;assert.equal(r.version,1);assert.equal((await svc.createRequirement(mc,ids.curriculum,ids.rank,req())).replayed,true);
 await deny(()=>svc.createRequirement(mc,ids.curriculum,ids.rank,req('CHANGED')),409);
 await deny(()=>svc.createRequirement(context('instructor'),ids.curriculum,ids.rank,req('DENIED')));await deny(()=>svc.createRequirement(context('legacy'),ids.curriculum,ids.rank,req('DENIED')));
 for(const rank of [ids.otherRank,ids.foreignRank,ids.siblingRank])await deny(()=>svc.createRequirement(context('manager'),ids.curriculum,rank,req('WRONG')),400);
 await deny(()=>svc.createRequirement(context('manager'),ids.foreignCurriculum,ids.foreignRank,req()),404);
 const r2=(await svc.createRequirement(context('manager'),ids.curriculum,ids.rank,req('JUDGMENT'))).record;
 const e=(await enroll()).record;assert.equal(e.currentRankId,ids.rank);assert.equal(e.version,1);
 for(const who of ['manager','legacy','parent','outsider'])await deny(()=>enroll(ids.otherStudent,ids.rank,context(who)));
 for(const type of ['AI_EMPLOYEE','AUTOMATION','INTEGRATION','SYSTEM_SERVICE'])await deny(()=>enroll(ids.otherStudent,ids.rank,{...context(),principalType:type}));
 for(const source of ['AI','AUTOMATION','INTEGRATION','PUBLIC_API','MIGRATION','HQ_SUPPORT'])await deny(()=>observe(e,r,'MET',0,{...context(),source}));
 await deny(()=>observe(e,r,'MET',0,{...context(),actionRequestId:randomUUID()}));await deny(()=>observe(e,r,'MET',0,{...context(),delegatedByPrincipalId:randomUUID()}));await deny(()=>observe(e,r,'MET',0,{...context(),externalSubject:humans.manager.subject}));
 await deny(()=>enroll(ids.foreignStudent),404);await deny(()=>enroll(ids.siblingStudent),404);await deny(()=>enroll(ids.otherStudent,ids.otherRank),400);
 await deny(()=>enroll(ids.student),409);
 await deny(()=>svc.setRank(context(),ids.otherCurriculum,e.id,{currentRankId:ids.otherRank,expectedEnrollmentVersion:e.version}),404);
 await deny(()=>svc.setRank(context(),ids.curriculum,e.id,{currentRankId:ids.foreignRank,expectedEnrollmentVersion:e.version}),400);
 await deny(()=>svc.observe(context('sibling',ids.sibling),ids.siblingCurriculum,e.id,{requirementId:r.id,expectedEnrollmentVersion:1,expectedRequirementVersion:1,expectedProgressVersion:0,status:'MET'}),404);
 const unrelated=(await svc.createRequirement(context('manager'),ids.otherCurriculum,ids.otherRank,req())).record;
 await deny(()=>observe(e,unrelated),400);
 const parentRequest={honIdentity:{externalSubject:humans.parent.subject}};
 let parent=(await parents.getStudentJourney(ids.school,ids.family,parentRequest)).data;assert.equal(parent.students.length,1);assert.equal(parent.students[0].curriculumEnrollments[0].requirementProgress[0].status,null);
 await deny(()=>parents.getStudentJourney(ids.school,ids.otherFamily,parentRequest));await deny(()=>parents.getStudentJourney(ids.foreignSchool,ids.family,parentRequest));
 const parentScope=(await db.resolveParentFamilyScopes(humans.parent.subject,ids.school))[0];await deny(()=>journeys.get(parentScope,ids.otherFamily,randomUUID(),humans.parent.subject));
 // Existing testing records remain byte-for-byte unchanged by observations.
 await admin.query("INSERT INTO hon.testing_events(id,organization_id,school_id,curriculum_id,name,starts_at,status) VALUES($1,$2,$3,$4,'Existing test',clock_timestamp()+interval '1 day','OPEN')",[ids.test,ids.org,ids.school,ids.curriculum]);await admin.query("INSERT INTO hon.testing_candidates(id,organization_id,school_id,testing_event_id,student_curriculum_enrollment_id,target_rank_id,instructor_notes) VALUES($1,$2,$3,$4,$5,$6,'PRIVATE_TEST_NOTE')",[ids.candidate,ids.org,ids.school,ids.test,e.id,ids.nextRank]);await admin.query('INSERT INTO hon.promotion_decisions(id,organization_id,school_id,testing_candidate_id,student_curriculum_enrollment_id,prior_rank_id,target_rank_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[ids.pending,ids.org,ids.school,ids.candidate,e.id,ids.rank,ids.nextRank]);
 const testingBefore=await snapshot(['testing_events','testing_candidates','promotion_decisions']);const enrollmentBefore=(await admin.query('SELECT * FROM hon.student_curriculum_enrollments WHERE id=$1',[e.id])).rows[0];
 const oc=context(),concurrent=await Promise.all([observe(e,r,'MET',0,oc),observe(e,r,'MET',0,oc)]);assert.equal(concurrent.filter(x=>!x.replayed).length,1);assert.equal(concurrent[0].record.status,'MET');
 await deny(()=>observe(e,r,'NOT_MET',0,oc),409);await deny(()=>observe(e,r,'MET',0),409);
 const races=await Promise.allSettled([observe(e,r2,'MET'),observe(e,r2,'MET')]);assert.equal(races.filter(x=>x.status==='fulfilled').length,1);assert.equal(races.find(x=>x.status==='rejected').reason.getStatus(),409);
 assert.deepEqual((await admin.query('SELECT * FROM hon.student_curriculum_enrollments WHERE id=$1',[e.id])).rows[0],enrollmentBefore,'All requirements MET must not change rank/version/status');assert.deepEqual(await snapshot(['testing_events','testing_candidates','promotion_decisions']),testingBefore);
 parent=(await parents.getStudentJourney(ids.school,ids.family,parentRequest)).data;assert(parent.students[0].curriculumEnrollments[0].requirementProgress.every(x=>x.status==='MET'));assert.doesNotMatch(JSON.stringify(parent),/PRIVATE_|INTERNAL_|"[^"]*(instructor|rationale|description|evidence|principal)[^"]*":/i);
 const stored=(await admin.query('SELECT * FROM hon.curriculum_progress_observations WHERE enrollment_id=$1 ORDER BY requirement_id',[e.id])).rows;assert.equal(stored.length,2);assert(stored.every(x=>x.actor_principal_id===humans.instructor.id&&x.source==='HUMAN_UI'&&x.instructor_note==='PRIVATE_INSTRUCTOR_NOTE'));
 // History is retained and revisions invalidate a current assessment until re-recorded.
 const updated=(await svc.updateRequirement(context('manager'),ids.curriculum,r.id,{...req(),definition:{label:'Revised label'},expectedVersion:1})).record;assert.equal(updated.version,2);
 assert.equal(await count('curriculum_requirement_versions'),4);await deny(()=>svc.updateRequirement(context('manager'),ids.curriculum,r.id,{...req(),expectedVersion:1}),409);
 await deny(()=>svc.updateRequirement(context('manager'),ids.curriculum,r.id,{...req('RENAMED'),expectedVersion:2}),400);await deny(()=>svc.updateRequirement(context('manager'),ids.otherCurriculum,r.id,{...req(),expectedVersion:2}),400);
 assert.equal((await svc.read(context(), 'ENROLLMENT',ids.curriculum,e.id)).requirements.find(x=>x.id===r.id).status,null);assert.equal((await svc.read(context(), 'ENROLLMENT',ids.curriculum,e.id)).requirements.find(x=>x.id===r.id).progressVersion,1);
 assert.equal((await parents.getStudentJourney(ids.school,ids.family,parentRequest)).data.students[0].curriculumEnrollments[0].requirementProgress.find(x=>x.requirementId===r.id).status,null);
 await deny(()=>observe(e,r,'MET',1),409);const negative=(await observe(e,updated,'NOT_MET',1)).record;assert.equal(negative.version,2);assert.equal(await count('curriculum_progress_observations'),3);
 const unranked=(await enroll(ids.otherStudent,null)).record;assert.equal(unranked.currentRankId,null);await deny(()=>observe(unranked,updated),400);
 const placed=(await svc.setRank(context(),ids.curriculum,unranked.id,{currentRankId:ids.rank,expectedEnrollmentVersion:1})).record;assert.equal(placed.version,2);assert.equal(placed.currentRankId,ids.rank);await observe(placed,updated,'NOT_STARTED');
 const cleared=(await svc.setRank(context(),ids.curriculum,placed.id,{currentRankId:null,expectedEnrollmentVersion:2})).record;assert.equal(cleared.currentRankId,null);assert.equal((await svc.read(context(),'ENROLLMENT',ids.curriculum,cleared.id)).requirements.length,0);
 await deny(()=>svc.setRank(context(),ids.curriculum,placed.id,{currentRankId:ids.rank,expectedEnrollmentVersion:2}),409);
 // No client authority fields or inferred/computed status.
 for(const input of [{...req(),actorPrincipalId:humans.parent.id},{...req(),definition:{label:'Safe',notes:'INTERNAL'}},{...req(),required:'true'},{...req(),definition:{label:'x'.repeat(161)}}])await deny(()=>svc.createRequirement(context('manager'),ids.curriculum,ids.rank,input),400);
 for(const status of ['READY','PROMOTED','AUTO_MET'])await deny(()=>observe(e,updated,status,2),400);
 await deny(()=>svc.observe(context(),ids.curriculum,e.id,{requirementId:r.id,expectedRequirementVersion:2,expectedEnrollmentVersion:1,expectedProgressVersion:2,status:'MET',instructorPrincipalId:humans.manager.id}),400);
 // Owner/direct SQL cannot destructively rewrite requirement/observation history.
 for(const t of privateTables)await sqlDeny(()=>admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`,[ids.org]));
 await sqlDeny(()=>admin.query('UPDATE hon.curriculum_progress_observations SET status=\'MET\' WHERE id=$1',[negative.id]));await sqlDeny(()=>admin.query('UPDATE hon.curriculum_requirement_versions SET definition=\'{}\' WHERE requirement_id=$1',[r.id]));await sqlDeny(()=>admin.query('DELETE FROM hon.curriculum_requirements WHERE id=$1',[r.id]));
 await sqlDeny(()=>admin.query('UPDATE hon.curriculum_requirements SET curriculum_rank_id=$2,version=version+1 WHERE id=$1',[r.id,ids.otherRank]));await sqlDeny(()=>admin.query('UPDATE hon.student_curriculum_enrollments SET curriculum_id=$2 WHERE id=$1',[e.id,ids.otherCurriculum]));await sqlDeny(()=>admin.query('UPDATE hon.student_curriculum_enrollments SET current_rank_id=$2 WHERE id=$1',[e.id,ids.otherRank]),'23503');
 // A mistakenly granted SELECT still sees zero private rows under forced RLS.
 await admin.query(`GRANT USAGE ON SCHEMA hon TO ${rlsRole}`);for(const t of privateTables)await admin.query(`GRANT SELECT ON hon.${t} TO ${rlsRole}`);await admin.query('BEGIN');await admin.query(`SET LOCAL ROLE ${rlsRole}`);for(const t of privateTables)assert.equal((await admin.query(`SELECT count(*) n FROM hon.${t}`)).rows[0].n,'0');await admin.query('ROLLBACK');
 // Raw runtime function calls cannot choose a different actor/source or no scope.
 await sqlDeny(()=>runtime.query('SELECT hon.read_staff_curriculum_progress($1,\'ENROLLMENT\',$2,$3)',[humans.instructor.subject,ids.curriculum,e.id]));
 await runtime.query('BEGIN');await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source','AI',true)",[ids.org,ids.school,humans.instructor.id]);await runtime.query('SAVEPOINT denied');await sqlDeny(()=>runtime.query('SELECT hon.read_staff_curriculum_progress($1,\'ENROLLMENT\',$2,$3)',[humans.instructor.subject,ids.curriculum,e.id]));await runtime.query('ROLLBACK TO SAVEPOINT denied');await runtime.query('COMMIT');assert.equal((await runtime.query('SELECT hon.current_school_id() id')).rows[0].id,null);
 // Atomic injected audit and outbox failure: history/projection/replay all roll back.
 for(const table of ['audit_events','outbox_events']){
  await admin.query(`CREATE FUNCTION hon.curriculum_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${ids.org}'::uuid THEN RAISE EXCEPTION 'curriculum fixture rollback'; END IF; RETURN NEW; END $$`);await admin.query(`CREATE TRIGGER curriculum_fixture_failure BEFORE INSERT ON hon.${table} FOR EACH ROW EXECUTE FUNCTION hon.curriculum_fixture_failure()`);failure=true;
  const atomicTables=[...privateTables,'curriculum_requirements','student_curriculum_enrollments','audit_events','outbox_events'],prior=await snapshot(atomicTables),ac=context();await assert.rejects(()=>observe(e,updated,'MET',2,ac),/curriculum fixture rollback/);assert.deepEqual(await snapshot(atomicTables),prior);
  await admin.query(`DROP TRIGGER curriculum_fixture_failure ON hon.${table}`);await admin.query('DROP FUNCTION hon.curriculum_fixture_failure()');failure=false;
 }
 // Permission removal, principal disable, grant revocation, expiry and tier removal
 // deny already completed idempotent retries, not only new writes.
 await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1',[humans.instructor.id]);await deny(()=>observe(e,r,'MET',0,oc));await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1',[humans.instructor.id]);
 await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='curriculum.progress.record'",[ids.progressRole]);await deny(()=>observe(e,r,'MET',0,oc));await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'curriculum.progress.record')",[ids.progressRole,ids.org]);
 await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE principal_id=$1',[humans.instructor.id]);await deny(()=>observe(e,r,'MET',0,oc));await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE principal_id=$1',[humans.instructor.id]);
 await admin.query("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()+interval '300 milliseconds' WHERE principal_id=$1",[humans.instructor.id]);await admin.query('BEGIN');await admin.query('SELECT 1 FROM hon.organizations WHERE id=$1 FOR UPDATE',[ids.org]);const waited=observe(e,r,'MET',0,oc);await new Promise(r=>setTimeout(r,450));await admin.query('COMMIT');await deny(()=>waited);await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE principal_id=$1',[humans.instructor.id]);
 await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[ids.org]);await deny(()=>observe(e,r,'MET',0,oc));await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[ids.org]);
 await admin.query("UPDATE hon.family_access_grants SET effective_until=clock_timestamp()-interval '1 second' WHERE principal_id=$1",[humans.parent.id]);await deny(()=>parents.getStudentJourney(ids.school,ids.family,parentRequest));await deny(()=>journeys.get(parentScope,ids.family,randomUUID(),humans.parent.subject));await admin.query('UPDATE hon.family_access_grants SET effective_until=NULL WHERE principal_id=$1',[humans.parent.id]);
 await admin.query("UPDATE hon.family_members SET member_role='OTHER' WHERE family_id=$1",[ids.family]);assert.equal((await parents.getStudentJourney(ids.school,ids.family,parentRequest)).data.students.length,0);await admin.query("UPDATE hon.family_members SET member_role='STUDENT' WHERE family_id=$1",[ids.family]);
 // Controller/session derivation is exact even if request carries forged selectors.
 const response=await controller.enrollment(ids.org,ids.school,ids.curriculum,e.id,{honIdentity:{externalSubject:humans.instructor.subject},body:{principalId:humans.parent.id,source:'AI'}});assert.equal(response.data.enrollment.id,e.id);await deny(()=>controller.enrollment(ids.foreignOrg,ids.school,ids.curriculum,e.id,{honIdentity:{externalSubject:humans.instructor.subject}}));
 assert.deepEqual(await snapshot(prohibited),before,'No students, families, billing, testing, messages, AI, Action Engine or external-domain writes');assert.deepEqual(await snapshot(['testing_events','testing_candidates','promotion_decisions']),testingBefore);
 const requests=(await admin.query('SELECT * FROM hon.curriculum_command_requests WHERE organization_id=ANY($1::uuid[])',[orgs])).rows;assert.equal(await count('audit_events'),requests.length);assert.equal(await count('outbox_events'),requests.length);
 const outbox=(await admin.query('SELECT * FROM hon.outbox_events WHERE organization_id=ANY($1::uuid[])',[orgs])).rows;assert(outbox.every(x=>x.event_type==='curriculum.human_recorded'&&x.payload.internalOnly===true));assert.doesNotMatch(JSON.stringify(outbox),/PRIVATE_|INTERNAL_DEFINITION|notes|instructor/i);
 // Guardian denial includes deleted grants, disabled/ambiguous humans and inactive topology.
 await deny(()=>journeys.get(parentScope,ids.family,randomUUID()));
 for(const [table,id] of [['families',ids.family],['schools',ids.school],['organizations',ids.org]]) {
  await admin.query(`UPDATE hon.${table} SET status='SUSPENDED' WHERE id=$1`,[id]);
  await deny(()=>parents.getStudentJourney(ids.school,ids.family,parentRequest));
  await deny(()=>journeys.get(parentScope,ids.family,randomUUID(),humans.parent.subject));
  await admin.query(`UPDATE hon.${table} SET status='ACTIVE' WHERE id=$1`,[id]);
 }
 await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1',[humans.parent.id]);
 await deny(()=>parents.getStudentJourney(ids.school,ids.family,parentRequest));
 await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1',[humans.parent.id]);
 const guardianGrant=(await admin.query('DELETE FROM hon.family_access_grants WHERE principal_id=$1 RETURNING *',[humans.parent.id])).rows[0];
 await deny(()=>parents.getStudentJourney(ids.school,ids.family,parentRequest));await deny(()=>journeys.get(parentScope,ids.family,randomUUID(),humans.parent.subject));
 await admin.query('INSERT INTO hon.family_access_grants SELECT * FROM jsonb_populate_record(NULL::hon.family_access_grants,$1::jsonb)',[JSON.stringify(guardianGrant)]);
 for(const who of ['parent','instructor']) {
  const duplicate={id:randomUUID(),user:humans[who].user};humans[`${who}Duplicate`]=duplicate;
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Duplicate fixture')",[duplicate.id,duplicate.user]);
  if(who==='parent')await deny(()=>parents.getStudentJourney(ids.school,ids.family,parentRequest));else await deny(()=>observe(e,updated,'MET',2));
  await admin.query('DELETE FROM hon.principals WHERE id=$1',[duplicate.id]);
 }
 // Start a parent transaction before expiry, wait on a topology lock, then check
 // that clock_timestamp denies both the stale scope and direct safe projection.
 await admin.query("UPDATE hon.family_access_grants SET effective_until=clock_timestamp()+interval '300 milliseconds' WHERE principal_id=$1",[humans.parent.id]);
 await admin.query('BEGIN');await admin.query('SELECT 1 FROM hon.organizations WHERE id=$1 FOR UPDATE',[ids.org]);
 const expiredJourney=journeys.get(parentScope,ids.family,randomUUID(),humans.parent.subject).then(()=>({allowed:true}),error=>({error}));
 await new Promise(r=>setTimeout(r,450));await admin.query('COMMIT');const expired=await expiredJourney;assert.equal(expired.error?.getStatus(),403);
 await admin.query('UPDATE hon.family_access_grants SET effective_until=NULL WHERE principal_id=$1',[humans.parent.id]);
 // Exactly three enrollment columns are granted, never a table UPDATE grant.
 assert.equal((await runtime.query("SELECT has_table_privilege(current_user,'hon.student_curriculum_enrollments','UPDATE') allowed")).rows[0].allowed,false);
 for(const column of ['current_rank_id','version','updated_at'])assert.equal((await runtime.query("SELECT has_column_privilege(current_user,'hon.student_curriculum_enrollments',$1,'UPDATE') allowed",[column])).rows[0].allowed,true);
 for(const column of ['status','enrolled_at','student_profile_id','curriculum_id','school_id','organization_id'])assert.equal((await runtime.query("SELECT has_column_privilege(current_user,'hon.student_curriculum_enrollments',$1,'UPDATE') allowed",[column])).rows[0].allowed,false);
 for(const sig of ['hon.guard_curriculum_structure_identity()','hon.verify_curriculum_enrollment_evidence()'])assert.equal((await runtime.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') allowed',[sig])).rows[0].allowed,false);
 for(const table of privateTables)await sqlDeny(()=>admin.query(`TRUNCATE hon.${table} CASCADE`));
 // Exercise the pre-existing register/grade/decision services on hon_runtime,
 // whose canonical setup has no rank/event UPDATE rights or helper wide grants.
 for(const permission of ['testing.manage','testing.promotion.decide'])await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[ids.manageRole,ids.org,permission]);
 const testing=new TestingCandidateService(db),promotions=new PromotionDecisionService(db),compatTest=randomUUID();
 await admin.query("INSERT INTO hon.testing_events(id,organization_id,school_id,curriculum_id,name,starts_at,status) VALUES($1,$2,$3,$4,'Human compatibility test',clock_timestamp()+interval '1 day','OPEN')",[compatTest,ids.org,ids.school,ids.curriculum]);
 const registerInput={studentCurriculumEnrollmentId:e.id,targetRankId:ids.nextRank},tc=context('manager');
 const registered=await Promise.all([testing.register(tc,compatTest,registerInput),testing.register(tc,compatTest,registerInput)]);assert.equal(registered.filter(x=>!x.replayed).length,1);
 const candidate=registered[0].candidate;assert.equal(candidate.result,'PENDING');
 await deny(()=>testing.register(context('instructor'),compatTest,registerInput));
 const gc=context('manager'),gradeInput={result:'PASSED',expectedVersion:1,instructorNotes:'PRIVATE_COMPATIBILITY_NOTE'};
 const graded=await testing.grade(gc,candidate.id,gradeInput);assert.equal(graded.candidate.result,'PASSED');assert.equal((await testing.grade(gc,candidate.id,gradeInput)).replayed,true);
 assert.equal((await admin.query('SELECT current_rank_id FROM hon.student_curriculum_enrollments WHERE id=$1',[e.id])).rows[0].current_rank_id,ids.rank);
 // A promotion-authorized principal still cannot use raw UPDATE without newly
 // recorded matching decision, audit and outbox in the very same transaction.
 await runtime.query('BEGIN');await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_request_id',$4,true)",[ids.org,ids.school,humans.manager.id,randomUUID()]);
 await runtime.query('UPDATE hon.student_curriculum_enrollments SET current_rank_id=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1',[e.id,ids.nextRank]);
 await sqlDeny(()=>runtime.query('COMMIT'));await runtime.query('ROLLBACK');
 assert.equal((await admin.query('SELECT current_rank_id FROM hon.student_curriculum_enrollments WHERE id=$1',[e.id])).rows[0].current_rank_id,ids.rank);
 const pc=context('manager'),decisionInput={status:'PROMOTED',rationale:'Explicit human instructor decision'};
 // Injected evidence failure also rolls back a genuine promotion's rank update.
 await admin.query(`CREATE FUNCTION hon.curriculum_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${ids.org}'::uuid THEN RAISE EXCEPTION 'curriculum fixture rollback'; END IF; RETURN NEW; END $$`);
 await admin.query('CREATE TRIGGER curriculum_fixture_failure BEFORE INSERT ON hon.outbox_events FOR EACH ROW EXECUTE FUNCTION hon.curriculum_fixture_failure()');failure=true;
 const promotionAtomic=['student_curriculum_enrollments','promotion_decisions','audit_events','outbox_events','idempotency_records'],beforeDecision=await snapshot(promotionAtomic);
 await assert.rejects(()=>promotions.decide(pc,candidate.id,decisionInput),/curriculum fixture rollback/);assert.deepEqual(await snapshot(promotionAtomic),beforeDecision);
 await admin.query('DROP TRIGGER curriculum_fixture_failure ON hon.outbox_events');await admin.query('DROP FUNCTION hon.curriculum_fixture_failure()');failure=false;
 const promoted=await Promise.all([promotions.decide(pc,candidate.id,decisionInput),promotions.decide(pc,candidate.id,decisionInput)]);assert.equal(promoted.filter(x=>!x.replayed).length,1);
 assert(promoted.every(x=>x.decision.instructorPrincipalId===humans.manager.id&&x.decision.status==='PROMOTED'));
 const afterEnrollment=(await admin.query('SELECT * FROM hon.student_curriculum_enrollments WHERE id=$1',[e.id])).rows[0];assert.equal(afterEnrollment.current_rank_id,ids.nextRank);assert.equal(afterEnrollment.version,e.version+1);assert.equal(afterEnrollment.status,'ACTIVE');
 await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE principal_id=$1',[humans.manager.id]);
 await deny(()=>testing.grade(gc,candidate.id,gradeInput));await deny(()=>promotions.decide(pc,candidate.id,decisionInput));
 await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE principal_id=$1',[humans.manager.id]);
 assert.deepEqual(await snapshot(prohibited),before,'Even explicit human testing commands have zero provider, payments, membership, messaging, AI or Action Engine effects.');
 console.log('Verified human curriculum requirements/enrollment/progress: exact live authority, append-only versions/history, concurrency/replay, parent redaction, RLS/ACL denial, atomic evidence and MET/no-promotion/zero downstream effects.');
}finally{try{await cleanup();}finally{await Promise.all([admin.end(),runtime.end(),db.onModuleDestroy()]);}}
