import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyPlannedAbsenceReviewSecurity } from './planned-absence-review-security.mjs';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_absence_review_validation'||owner.username!=='hon_absence_review_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_absence_review_runtime')throw new Error('Only exact disposable localhost planned absence review URLs permitted.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {PlannedAbsenceReviewService}=await import('../../../apps/api/dist/schedule/planned-absence-review.service.js');
const {PlannedAbsenceReviewQueueService}=await import('../../../apps/api/dist/schedule/planned-absence-review-queue.controller.js');
const {PlannedAbsenceReviewController}=await import('../../../apps/api/dist/schedule/planned-absence-review.controller.js');
const {ParentPlannedAbsenceHistoryService}=await import('../../../apps/api/dist/families/parent-planned-absence-history.service.js');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const db=new RuntimeDatabaseService(),review=new PlannedAbsenceReviewService(db),queue=new PlannedAbsenceReviewQueueService(db),controller=new PlannedAbsenceReviewController(db,review),history=new ParentPlannedAbsenceHistoryService(db);
const ids=Object.fromEntries(['org','school','otherSchool','staff','staffUser','parent','parentUser','viewer','viewerUser','role','grant','family','otherFamily','child','otherChild','profile','otherProfile'].map(key=>[key,randomUUID()]));
const subject='review-'+randomUUID(),parentSubject='parent-'+randomUUID(),viewerSubject='viewer-'+randomUUID();
const command=(patch={})=>({organizationId:ids.org,schoolId:ids.school,principalId:ids.staff,externalSubject:subject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),...patch});
const input=(patch={})=>({decision:'APPROVED',reviewNote:'PRIVATE_REVIEW_NOTE',expectedVersion:1,...patch});
const denied=code=>error=>error.getStatus?.()===code;
await admin.connect();await restricted.connect();
try {
 const marker=(await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];assert.deepEqual(marker,{owner:'hon_absence_review_owner',marker:'HON disposable planned absence review validation'});
 await verifyPlannedAbsenceReviewSecurity(admin,runtime.username);
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_ORG','PRIVATE_ORG')",[ids.org]);
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_SCHOOL',$3),($4,$2,'OTHER_SCHOOL',$5)",[ids.school,ids.org,'review-'+ids.school,ids.otherSchool,'review-'+ids.otherSchool]);
 await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'ESSENTIAL',now()-interval '1 day')",[ids.org]);
 for(const [user,principal,external]of[[ids.staffUser,ids.staff,subject],[ids.parentUser,ids.parent,parentSubject],[ids.viewerUser,ids.viewer,viewerSubject]]) {
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_PERSON')",[user,external,user+'@example.test']);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_PRINCIPAL')",[principal,user]);
 }
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'REVIEWER','PRIVATE_ROLE')",[ids.role,ids.org]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'schedule.planned_absence.review')",[ids.role,ids.org]);
 await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,now()-interval '1 day')",[ids.grant,ids.org,ids.school,ids.staff,ids.role]);
 for(const [family,school,child,profile]of[[ids.family,ids.school,ids.child,ids.profile],[ids.otherFamily,ids.otherSchool,ids.otherChild,ids.otherProfile]]) {
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PRIVATE_FAMILY')",[family,ids.org,school]);
  await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Visible','Child')",[child,ids.org,school]);
  await admin.query("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')",[ids.org,school,family,child]);
  await admin.query("INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id) VALUES($1,$2,$3,$4,$5)",[profile,ids.org,school,child,family]);
 }
 await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',now()-interval '1 day',$4),($1,$2,$3,$5,'VIEWER',now()-interval '1 day',$4)",[ids.org,ids.school,ids.family,ids.parent,ids.viewer]);
 const requests=[];
 for(let i=0;i<51;i++) {const id=randomUUID();requests.push(id);await admin.query("INSERT INTO hon.planned_absence_requests(id,organization_id,school_id,family_id,student_profile_id,requested_by_principal_id,starts_at,ends_at,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 day',now()+interval '2 days','PRIVATE_PARENT_REASON',now()-interval '1 hour'+$7::integer*interval '1 second')",[id,ids.org,ids.school,ids.family,ids.profile,ids.parent,i]);}
 const foreign=randomUUID();await admin.query("INSERT INTO hon.planned_absence_requests(id,organization_id,school_id,family_id,student_profile_id,requested_by_principal_id,starts_at,ends_at,reason) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 day',now()+interval '2 days','CROSS_SCHOOL_SECRET')",[foreign,ids.org,ids.otherSchool,ids.otherFamily,ids.otherProfile,ids.parent]);
 const snapshot=async()=>(await admin.query("SELECT coalesce(jsonb_object_agg(table_name,n),'{}') counts FROM (SELECT table_name,(xpath('/row/n/text()',query_to_xml(format('SELECT count(*) n FROM hon.%I',table_name),false,true,'')))[1]::text::bigint n FROM information_schema.tables WHERE table_schema='hon' AND table_type='BASE TABLE') rows")).rows[0].counts;
 const before=await snapshot();
 assert.deepEqual(await db.resolvePlannedAbsenceReviewScope(subject),{organizationId:ids.org,schoolId:ids.school,principalId:ids.staff});
 const loaded=(await queue.get(subject)).data;assert.equal(loaded.items.length,50);assert.deepEqual(loaded.items.map(item=>item.id),requests.slice(0,50));assert.equal(loaded.items[0].reason,'PRIVATE_PARENT_REASON');assert.deepEqual(Object.keys(loaded.items[0]).sort(),['endsAt','id','reason','startsAt','studentProfileId','submittedAt','version']);assert(!JSON.stringify(loaded).includes('CROSS_SCHOOL_SECRET'));assert.deepEqual(await snapshot(),before,'Queue must write no table.');
 for(const who of[parentSubject,viewerSubject,'unknown']){assert.equal(await db.resolvePlannedAbsenceReviewScope(who),undefined);await assert.rejects(queue.get(who),denied(403));}
 for(const patch of[{principalType:'AI_EMPLOYEE'},{source:'ACTION_ENGINE'},{source:'AUTOMATION'},{source:'INTEGRATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()},{externalSubject:parentSubject},{schoolId:ids.otherSchool},{principalId:ids.parent}])await assert.rejects(db.readPlannedAbsenceReviewQueue(command(patch)),error=>error.code==='42501');
 await assert.rejects(restricted.query('SELECT hon.read_staff_planned_absence_review_queue($1)',[subject]),error=>error.code==='42501');
 for(const table of['users','principals','roles','role_permissions','principal_role_grants','family_access_grants'])await assert.rejects(restricted.query(`SELECT * FROM hon.${table}`),error=>error.code==='42501');
 await assert.rejects(restricted.query('SELECT hon.require_planned_absence_review_actor($1)',[subject]),error=>error.code==='42501');
 assert.equal((await restricted.query('SELECT count(*) n FROM hon.planned_absence_requests')).rows[0].n,'0','RLS denies rows without tenant context');
 // Independent exact scope and all live authority dependencies are required.
 for(const [table,id,column,value,restore]of[['principals',ids.staff,'is_active',false,true],['schools',ids.school,'status','SUSPENDED','ACTIVE'],['organizations',ids.org,'status','SUSPENDED','ACTIVE'],['principal_role_grants',ids.grant,'effective_until',new Date(Date.now()-60000),null]]) {
  await admin.query(`UPDATE hon.${table} SET ${column}=$2 WHERE id=$1`,[id,value]);await assert.rejects(queue.get(subject),denied(403));await assert.rejects(review.decide(command(),requests[0],input()),error=>error.code==='42501');await admin.query(`UPDATE hon.${table} SET ${column}=$2 WHERE id=$1`,[id,restore]);
 }
 await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[ids.org]);await assert.rejects(queue.get(subject),denied(403));await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_until=now()-interval '1 minute' WHERE organization_id=$1",[ids.org]);await assert.rejects(queue.get(subject),denied(403));await admin.query('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1',[ids.org]);
 await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='schedule.planned_absence.review'",[ids.role]);await assert.rejects(queue.get(subject),denied(403));await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'schedule.planned_absence.review')",[ids.role,ids.org]);
 const extra=randomUUID();await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,now()-interval '1 day')",[extra,ids.org,ids.otherSchool,ids.staff,ids.role]);await assert.rejects(queue.get(subject),denied(403));await admin.query('DELETE FROM hon.principal_role_grants WHERE id=$1',[extra]);
 await admin.query("INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role) VALUES($1,$2,'HON_HQ_OWNER')",[extra,ids.staff]);await assert.rejects(queue.get(subject),denied(403));await admin.query('DELETE FROM hon.hq_operator_grants WHERE id=$1',[extra]);
 await admin.query("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,'VIEWER',now()-interval '1 day',$5)",[extra,ids.org,ids.school,ids.family,ids.staff]);await assert.rejects(queue.get(subject),denied(403));await admin.query('DELETE FROM hon.family_access_grants WHERE id=$1',[extra]);
 await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'DUPLICATE')",[extra,ids.staffUser]);await assert.rejects(queue.get(subject),denied(403));await admin.query('DELETE FROM hon.principals WHERE id=$1',[extra]);
 assert.deepEqual(await snapshot(),before,'Denied reads/decisions write no table.');
 await assert.rejects(review.decide(command(),foreign,input()),denied(404));await assert.rejects(review.decide(command(),requests[0],input({expectedVersion:2})),denied(409));await assert.rejects(review.decide(command(),requests[0],input({reviewNote:'   '})),denied(400));
 const key=randomUUID(),response={status(){return this;}};
 const result=await controller.decide(ids.org,ids.school,requests[0],key,input(),{method:'POST',query:{},headers:{},honIdentity:{externalSubject:subject}},response);
 assert.deepEqual(Object.keys(result.data).sort(),['id','reviewedAt','status','version']);assert.equal(result.data.status,'APPROVED');assert(!JSON.stringify(result.data).includes('PRIVATE_'));
 const after=await snapshot();for(const [table,count]of Object.entries(before))assert.equal(after[table]-count,['audit_events','outbox_events','idempotency_records'].includes(table)?1:0,`Unexpected decision effect on ${table}`);
 const stored=(await admin.query('SELECT * FROM hon.planned_absence_requests WHERE id=$1',[requests[0]])).rows[0];assert.equal(stored.reviewed_by_principal_id,ids.staff);assert.equal(stored.review_note,'PRIVATE_REVIEW_NOTE');assert.equal(stored.version,2);
 const replay=await controller.decide(ids.org,ids.school,requests[0],key,input(),{method:'POST',query:{},headers:{},honIdentity:{externalSubject:subject}},response);assert.deepEqual(replay.data,result.data);assert.equal(replay.meta.replayed,true);assert.deepEqual(await snapshot(),after);
 await assert.rejects(review.decide(command({idempotencyKey:key}),requests[0],input({decision:'DECLINED'})),denied(409));await assert.rejects(review.decide(command(),requests[0],input()),denied(409));
 // Replays also require live entitlement: a durable receipt is never authority.
 await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[ids.org]);await assert.rejects(controller.decide(ids.org,ids.school,requests[0],key,input(),{method:'POST',query:{},headers:{},honIdentity:{externalSubject:subject}},response),denied(403));await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[ids.org]);
 const parent=(await history.get(parentSubject)).data;assert(parent.requests.items.some(item=>item.status==='APPROVED'));assert(!/PRIVATE_|reason|reviewNote|reviewedBy|studentProfileId|principalId/.test(JSON.stringify(parent)));
 assert(!(await queue.get(subject)).data.items.some(item=>item.id===requests[0]));
 // Different keys on one version produce exactly one final decision.
 const contenders=await Promise.allSettled([review.decide(command(),requests[1],input()),review.decide(command(),requests[1],input({decision:'DECLINED'}))]);assert.equal(contenders.filter(value=>value.status==='fulfilled').length,1);assert.equal(contenders.filter(value=>value.status==='rejected'&&value.reason.getStatus()===409).length,1);
 // Evidence failure rolls back the only request transition and every receipt.
 const priorFailure=await snapshot();await admin.query("CREATE FUNCTION hon.review_proof_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected evidence failure'; END $$; CREATE TRIGGER review_proof_fail BEFORE INSERT ON hon.outbox_events FOR EACH ROW EXECUTE FUNCTION hon.review_proof_fail()");await assert.rejects(review.decide(command(),requests[2],input()));assert.deepEqual(await snapshot(),priorFailure);assert.equal((await admin.query('SELECT status::text FROM hon.planned_absence_requests WHERE id=$1',[requests[2]])).rows[0].status,'SUBMITTED');await admin.query('DROP TRIGGER review_proof_fail ON hon.outbox_events; DROP FUNCTION hon.review_proof_fail()');
 // Exact verifier rejects ACL and implementation weakening, then restoration.
 for(const sql of["GRANT EXECUTE ON FUNCTION hon.read_staff_planned_absence_review_queue(text) TO PUBLIC","GRANT EXECUTE ON FUNCTION hon.require_planned_absence_review_actor(text) TO hon_absence_review_runtime","CREATE OR REPLACE FUNCTION hon.read_staff_planned_absence_review_queue(p_subject text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$ BEGIN RETURN '{}'::jsonb; END $$","ALTER TABLE hon.planned_absence_requests NO FORCE ROW LEVEL SECURITY"]) {
  await admin.query('BEGIN');try{await admin.query(sql);await assert.rejects(verifyPlannedAbsenceReviewSecurity(admin,runtime.username));}finally{await admin.query('ROLLBACK');}
 }
 await verifyPlannedAbsenceReviewSecurity(admin,runtime.username);
 console.log('PASS: dedicated localhost canonical 0144 review queue capped at 50 current SUBMITTED minimum-fact records; exact direct-human/school/permission/entitlement, mixed/HQ/parent/viewer/duplicate/delegated/action/AI/automation/integration denial, cross-school RLS, atomic single decisions, concurrent version conflict, exact replay/revoked replay, evidence rollback, redacted parent status/history and exact ACL/body/FORCE-RLS tamper verification. All downstream tables unchanged.');
} finally {await db.onModuleDestroy();await restricted.end();await admin.end();}
