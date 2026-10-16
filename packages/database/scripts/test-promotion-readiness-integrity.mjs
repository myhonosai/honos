import { requirePromotionReadinessLocalUrls } from './promotion-readiness-local-guard.mjs';
requirePromotionReadinessLocalUrls();
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { verifyPromotionReadinessSecurity } from './promotion-readiness-security.mjs';
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { PromotionReadinessService } = await import('../../../apps/api/dist/testing/promotion-readiness.service.js');
const { PromotionReadinessController } = await import('../../../apps/api/dist/testing/promotion-readiness.controller.js');
const { CurriculumProgressService } = await import('../../../apps/api/dist/curriculum/curriculum-progress.service.js');
const { AttendanceService } = await import('../../../apps/api/dist/schedule/attendance.service.js');
const { parsePromotionReadiness } = await import('../../contracts/dist/index.js');
let externalCalls=0, groups=0, verifiedReads=0;
const forbidden=()=>{externalCalls++;throw new Error('External/provider/payment/message/network effect forbidden');};
globalThis.fetch=forbidden;http.request=forbidden;http.get=forbidden;https.request=forbidden;https.get=forbidden;
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const o=Array.isArray(args[0])?args[0][0]:args[0];if(!(typeof o==='object'?o.port===5432&&o.host==='localhost':o===5432&&args[1]==='localhost'))return forbidden();return connect.apply(this,args);};
const admin=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false}),runtime=new pg.Client({connectionString:process.env.HON_RUNTIME_DATABASE_URL,ssl:false});
const db=new RuntimeDatabaseService(),service=new PromotionReadinessService(db),progress=new CurriculumProgressService(db),attendance=new AttendanceService(db);
const ids=Object.fromEntries(['org','otherOrg','school','otherSchool','user','principal','role','grant','person','student','curriculum','otherCurriculum','rank','next','last','requirement','recommendation','enrollment','history','program','session'].map(k=>[k,randomUUID()]));
const subject=`readiness-local-${randomUUID()}`;
const fixture={database:'hon_promotion_readiness_validation',owner:'hon_promotion_readiness_owner',runtime:'hon_promotion_readiness_runtime',marker:'HON disposable promotion_readiness validation'};
function postgres(args,input) {
 const result=spawnSync('sudo',['-u','postgres',...args],{input,encoding:'utf8',env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:process.env.HOME??'/home/ubuntu',LANG:process.env.LANG??'C.UTF-8'}});
 if(result.status!==0)throw new Error('Marked promotion readiness fixture teardown failed.');
}
function teardownFixture() {
 postgres(['psql','-X','-q','-v','ON_ERROR_STOP=1','-d','postgres'],`DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='${fixture.database}' AND pg_get_userbyid(datdba)='${fixture.owner}' AND shobj_description(oid,'pg_database')='${fixture.marker}') THEN RAISE EXCEPTION 'Refusing unmarked fixture database'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('${fixture.owner}','${fixture.runtime}') AND shobj_description(oid,'pg_authid') IS DISTINCT FROM '${fixture.marker}') THEN RAISE EXCEPTION 'Refusing unmarked fixture roles'; END IF;
 END $$;`);
 postgres(['dropdb','--force',fixture.database]);
 postgres(['psql','-X','-q','-v','ON_ERROR_STOP=1','-d','postgres'],`DROP ROLE ${fixture.runtime}; DROP ROLE ${fixture.owner};`);
}
function context(patch={}){const id=randomUUID();return {organizationId:ids.org,schoolId:ids.school,principalId:ids.principal,principalType:'HUMAN_USER',source:'HUMAN_UI',externalSubject:subject,requestId:id,correlationId:id,idempotencyKey:randomUUID(),...patch};}
const policy={minAttendanceCreditMilli:1000,minDaysInCurrentRank:30,requiredRequirementIds:[ids.requirement],instructorRecommendationRequirementIds:[ids.recommendation],documentTemplateIds:[],documentAcknowledgementRule:'CURRENT_CALLER_STAFF_CURRENT_PUBLICATION',requireOpenTestingWindow:true};
const check=()=>{groups++;};
const status=n=>e=>e?.getStatus?.()===n;
let tables;
async function snapshot(){const result={};for(const table of tables){assert(/^[a-z_]+$/.test(table));result[table]=(await admin.query(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) hash FROM hon.${table} t`)).rows[0].hash;}return result;}
async function read(enrollment=ids.enrollment,curriculum=ids.curriculum,c=context()) {const before=await snapshot();try {const result=await service.read(c,curriculum,enrollment);verifiedReads++;assert.deepEqual(await snapshot(),before);assert(!JSON.stringify(result).includes('PRIVATE_SECRET'));return result;}catch(error){assert.deepEqual(await snapshot(),before);throw error;}}
async function raw(c=context(),work=client=>client.query('SELECT hon.read_promotion_readiness($1,$2,$3) data',[c.externalSubject,ids.curriculum,ids.enrollment])){
 await runtime.query('BEGIN READ ONLY');try{await runtime.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_source',$5,true),set_config('app.hon_external_subject',$6,true),set_config('app.hon_action_request_id',$7,true),set_config('app.hon_delegated_by_principal_id',$8,true)`,[c.organizationId,c.schoolId,c.principalId,c.principalType,c.source,c.externalSubject,c.actionRequestId??'',c.delegatedByPrincipalId??'']);return await work(runtime);}finally{await runtime.query('ROLLBACK');}}
async function setPolicy(value){await admin.query('UPDATE hon.curriculum_ranks SET promotion_requirement=$1 WHERE id=$2',[JSON.stringify(value),ids.rank]);}
async function observe(requirement,statusValue,version=1){return progress.observe(context(),ids.curriculum,ids.enrollment,{requirementId:requirement,expectedEnrollmentVersion:1,expectedRequirementVersion:version,expectedProgressVersion:Number((await admin.query('SELECT coalesce(max(version),0) v FROM hon.curriculum_progress_observations WHERE enrollment_id=$1 AND requirement_id=$2',[ids.enrollment,requirement])).rows[0].v),status:statusValue,instructorNote:'PRIVATE_SECRET'});}
async function event(patch={}){const id=patch.id??randomUUID();await admin.query(`INSERT INTO hon.testing_events(id,organization_id,school_id,curriculum_id,name,starts_at,registration_opens_at,registration_closes_at,status) VALUES($1,$2,$3,$4,'PRIVATE_SECRET',now()+interval '2 days',$5,$6,$7)`,[id,ids.org,ids.school,ids.curriculum,patch.opens??new Date(Date.now()-86400000),patch.closes??new Date(Date.now()+86400000),patch.status??'OPEN']);return id;}
async function candidate(result='PENDING',patch={}){const ev=await event({status:'CLOSED'}),id=patch.id??randomUUID();await admin.query(`INSERT INTO hon.testing_candidates(id,organization_id,school_id,testing_event_id,student_curriculum_enrollment_id,target_rank_id,result,instructor_notes,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'PRIVATE_SECRET',$8,$9)`,[id,ids.org,ids.school,ev,patch.enrollment??ids.enrollment,patch.target??ids.next,result,patch.created??new Date(Date.now()-3600000),patch.updated??new Date(Date.now()-1000)]);return id;}
async function enrollment(rank,statusValue='ACTIVE',history=false){const person=randomUUID(),student=randomUUID(),id=randomUUID();await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Private','PRIVATE_SECRET')",[person,ids.org,ids.school]);await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)',[student,ids.org,ids.school,person]);await admin.query('INSERT INTO hon.student_curriculum_enrollments(id,organization_id,school_id,student_profile_id,curriculum_id,current_rank_id,status) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,ids.org,ids.school,student,ids.curriculum,rank,statusValue]);if(history)await admin.query(`INSERT INTO hon.curriculum_enrollment_history(organization_id,school_id,enrollment_id,curriculum_id,current_rank_id,enrollment_version,actor_principal_id,source,operation,request_id,recorded_at) VALUES($1,$2,$3,$4,$5,1,$6,'HUMAN_UI','ENROLL',$7,now()-interval '45 days')`,[ids.org,ids.school,id,ids.curriculum,rank,ids.principal,randomUUID()]);return id;}
await admin.connect();await runtime.connect();
try {
 const marker=(await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];assert.equal(marker.owner,'hon_promotion_readiness_owner');assert.equal(marker.marker,'HON disposable promotion_readiness validation');
 await verifyPromotionReadinessSecurity(admin,'hon_promotion_readiness_runtime');
 const posture=(await runtime.query('SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(posture.rolcanlogin,true);for(const [k,v]of Object.entries(posture))if(k!=='rolcanlogin')assert.equal(v,false);
 for(const table of ['users','principals','roles','curriculum_enrollment_history','curriculum_progress_observations','document_templates','document_publications','document_acknowledgements'])await assert.rejects(()=>runtime.query(`SELECT * FROM hon.${table}`),e=>e.code==='42501');
 await assert.rejects(()=>runtime.query('SELECT hon.read_promotion_readiness($1,$2,$3)',[subject,ids.curriculum,ids.enrollment]),e=>e.code==='42501');check();
 await admin.query('BEGIN');
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Local Readiness','Local Readiness'),($2,'Other','Other')",[ids.org,ids.otherOrg]);
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$3,'School',$1::uuid::text),($2,$4,'Other',$2::uuid::text)",[ids.school,ids.otherSchool,ids.org,ids.otherOrg]);
 await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'ESSENTIAL','ACTIVE'),($2,'ESSENTIAL','ACTIVE')",[ids.org,ids.otherOrg]);
 await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$1::uuid::text||'@example.test','Local Staff')",[ids.user,subject]);
 await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Staff')",[ids.principal,ids.user]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,management_school_id) VALUES($1,$2,$1::uuid::text,'Readiness proof',$3)",[ids.role,ids.org,ids.school]);
 for(const permission of ['testing.promotion.readiness.read','curriculum.progress.record','attendance.record','document.template.create','document.template.version','document.publish','document.acknowledge'])await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[ids.role,ids.org,permission]);
 await admin.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)',[ids.grant,ids.org,ids.school,ids.principal,ids.role]);
 await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Private','PRIVATE_SECRET')",[ids.person,ids.org,ids.school]);
 await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)',[ids.student,ids.org,ids.school,ids.person]);
 await admin.query("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code,lifecycle) VALUES($1,$3,$4,'PRIVATE_SECRET','LINEAR','PUBLISHED'),($2,$5,$6,'Other','LINEAR','PUBLISHED')",[ids.curriculum,ids.otherCurriculum,ids.org,ids.school,ids.otherOrg,ids.otherSchool]);
 for(const [id,order]of [[ids.rank,1],[ids.next,2],[ids.last,3]])await admin.query("INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,$1::uuid::text,$5)",[id,ids.org,ids.school,ids.curriculum,order]);
 for(const [id,kind]of [[ids.requirement,'TECHNIQUE'],[ids.recommendation,'INSTRUCTOR_JUDGMENT']])await admin.query("INSERT INTO hon.curriculum_requirements(id,organization_id,school_id,curriculum_rank_id,requirement_code,requirement_kind,definition) VALUES($1,$2,$3,$4,$1::uuid::text,$5,'{\"label\":\"PRIVATE_SECRET\"}')",[id,ids.org,ids.school,ids.rank,kind]);
 await admin.query('INSERT INTO hon.student_curriculum_enrollments(id,organization_id,school_id,student_profile_id,curriculum_id,current_rank_id) VALUES($1,$2,$3,$4,$5,$6)',[ids.enrollment,ids.org,ids.school,ids.student,ids.curriculum,ids.rank]);
 await admin.query(`INSERT INTO hon.curriculum_enrollment_history(id,organization_id,school_id,enrollment_id,curriculum_id,current_rank_id,enrollment_version,actor_principal_id,source,operation,request_id,recorded_at) VALUES($1,$2,$3,$4,$5,$6,1,$7,'HUMAN_UI','ENROLL',$8,now()-interval '45 days')`,[ids.history,ids.org,ids.school,ids.enrollment,ids.curriculum,ids.rank,ids.principal,randomUUID()]);
 await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Local Program','SCHEDULED')",[ids.program,ids.org,ids.school]);
 await admin.query("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status) VALUES($1,$2,$3,$4,'Session',now()-interval '1 day',now()-interval '23 hours',30,'WALK_IN','SCHEDULED')",[ids.session,ids.org,ids.school,ids.program]);
 await admin.query('COMMIT');
 tables=(await admin.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hon' AND relkind='r' ORDER BY relname")).rows.map(r=>r.relname);
 assert.equal((await read()).status,'NOT_ELIGIBLE');check();
 // Exact current context denials, including subject/actor, actions and delegation.
 const beforeDenials=await snapshot();
 for(const patch of [{principalType:'AI_EMPLOYEE'},{source:'AI'},{source:'API'},{principalId:randomUUID()},{externalSubject:'unverified'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()},{schoolId:ids.otherSchool},{organizationId:ids.otherOrg}])await assert.rejects(()=>raw(context(patch)),e=>e.code==='42501');
	 await assert.rejects(()=>raw(context(),c=>c.query('SELECT hon.read_promotion_readiness($1,$2,$3)',[subject+'spoof',ids.curriculum,ids.enrollment])),e=>e.code==='42501');
	 assert.deepEqual(await snapshot(),beforeDenials);check();
	 const duplicatePrincipal=randomUUID();
	 await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Ambiguous Staff')",[duplicatePrincipal,ids.user]);
	 const ambiguityBefore=await snapshot();
	 await assert.rejects(()=>read(),status(403));
	 assert.deepEqual(await snapshot(),ambiguityBefore);
	 await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1',[duplicatePrincipal]);check();
	 for(const [sql,restore]of [
  ["UPDATE hon.principal_role_grants SET effective_from=now()-interval '2 days',effective_until=now()-interval '1 second' WHERE id=$1","UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1"],
  ['UPDATE hon.principal_role_grants SET revoked_at=now(),revoked_by_principal_id=principal_id WHERE id=$1','UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1'],
 ]){await admin.query(sql,[ids.grant]);await assert.rejects(()=>read(),status(403));await admin.query(restore,[ids.grant]);}
 await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[ids.org]);await assert.rejects(()=>read(),status(403));await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[ids.org]);
 await admin.query("UPDATE hon.organization_entitlements SET effective_from=now()-interval '2 days',effective_until=now()-interval '1 second' WHERE organization_id=$1",[ids.org]);await assert.rejects(()=>read(),status(403));await admin.query('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1',[ids.org]);
 await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1',[ids.principal]);await assert.rejects(()=>read(),status(403));await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1',[ids.principal]);
 await admin.query('UPDATE hon.roles SET management_school_id=$1 WHERE id=$2',[ids.otherSchool,ids.role]).then(()=>{throw new Error('Cross-org role school should fail');},e=>assert.equal(e.code,'23503'));
 await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='testing.promotion.readiness.read'",[ids.role]);await assert.rejects(()=>read(),status(403));await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'testing.promotion.readiness.read')",[ids.role,ids.org]);
 for(const table of ['schools','organizations']) {await admin.query(`UPDATE hon.${table} SET status='SUSPENDED' WHERE id=$1`,[table==='schools'?ids.school:ids.org]);await assert.rejects(()=>read(),status(403));await admin.query(`UPDATE hon.${table} SET status='ACTIVE' WHERE id=$1`,[table==='schools'?ids.school:ids.org]);}check();
 await assert.rejects(()=>read(ids.enrollment,ids.otherCurriculum),status(404));
 await raw(context(),async c=>{assert.equal((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');assert.deepEqual((await c.query('SELECT id FROM hon.curricula WHERE id=$1',[ids.otherCurriculum])).rows,[]);await assert.rejects(()=>c.query("INSERT INTO hon.curricula(organization_id,school_id,name,model_code) VALUES($1,$2,'no','LINEAR')",[ids.org,ids.school]),e=>['25006','42501'].includes(e.code));});
 assert.equal((await runtime.query("SELECT nullif(current_setting('app.hon_school_id',true),'') context")).rows[0].context,null);check();
 // Unknown/missing/malformed historical policy never guesses defaults.
 const malformed=[null,[],{},'historical',{attendance:20},{promotionReadinessV1:null},{promotionReadinessV1:[]},{promotionReadinessV1:{...policy,unknown:true}},{promotionReadinessV1:{...policy,minDaysInCurrentRank:null}},{promotionReadinessV1:{...policy,minAttendanceCreditMilli:-1}},{promotionReadinessV1:{...policy,minAttendanceCreditMilli:1.5}},{promotionReadinessV1:{...policy,requiredRequirementIds:['bad']}},{promotionReadinessV1:{...policy,requiredRequirementIds:[ids.requirement,ids.requirement]}},{promotionReadinessV1:{...policy,instructorRecommendationRequirementIds:[ids.requirement]}},{promotionReadinessV1:{...policy,requiredRequirementIds:[randomUUID()]}},{promotionReadinessV1:{...policy,documentTemplateIds:[randomUUID()]}},{promotionReadinessV1:{...policy,documentAcknowledgementRule:'ANY_PARENT'}},{promotionReadinessV1:{...policy,requireOpenTestingWindow:'true'}},{promotionReadinessV1:policy,other:1},{promotionReadinessV1:{...policy,minAttendanceCreditMilli:0,minDaysInCurrentRank:0,requiredRequirementIds:[],instructorRecommendationRequirementIds:[],requireOpenTestingWindow:false}}];
 for(const value of malformed){await setPolicy(value);const r=await read();assert.equal(r.status,'NOT_ELIGIBLE');assert.equal(r.policyVersion,null);assert(r.blockers.some(c=>c.code==='POLICY'&&c.outcome==='CONFIGURATION_BLOCKER'));}
 for(const key of Object.keys(policy)){const value={...policy};delete value[key];await setPolicy({promotionReadinessV1:value});assert.equal((await read()).policyVersion,null);}check();
 await setPolicy({promotionReadinessV1:policy});let r=await read();assert.equal(r.status,'APPROACHING');assert.equal(r.criteria.find(c=>c.code==='TIME_IN_RANK').observed,45);assert.equal(r.criteria.find(c=>c.code==='TIME_IN_RANK').sourceId,ids.history);assert.equal(r.policyFingerprint.length,64);assert(!('promotion_requirement'in r));check();
 // No required evidence: missing immutable rank history never uses enrolled_at.
 const noHistory=await enrollment(ids.rank);r=await read(noHistory);assert.equal(r.status,'NOT_ELIGIBLE');assert.equal(r.evidenceCount,0);assert.equal(r.criteria.find(c=>c.code==='TIME_IN_RANK').recordedAt,null);
 for(const [rank,statusValue]of [[null,'ACTIVE'],[ids.last,'ACTIVE'],[ids.rank,'SUSPENDED']]){const id=await enrollment(rank,statusValue,true);assert.equal((await read(id)).status,'NOT_ELIGIBLE');}check();
 const promotedEnrollment=await enrollment(ids.rank),promotionCandidate=await candidate('PASSED',{enrollment:promotedEnrollment,target:ids.rank}),decision=randomUUID();
 await admin.query("INSERT INTO hon.promotion_decisions(id,organization_id,school_id,testing_candidate_id,student_curriculum_enrollment_id,target_rank_id,status,instructor_principal_id,rationale,decided_at) VALUES($1,$2,$3,$4,$5,$6,'PROMOTED',$7,'PRIVATE_SECRET',now()-interval '40 days')",[decision,ids.org,ids.school,promotionCandidate,promotedEnrollment,ids.rank,ids.principal]);r=await read(promotedEnrollment);assert.equal(r.criteria.find(c=>c.code==='TIME_IN_RANK').sourceId,decision);assert.equal(r.criteria.find(c=>c.code==='TIME_IN_RANK').observed,40);assert.equal(r.candidate,null);check();
 await observe(ids.requirement,'MET');await observe(ids.recommendation,'NOT_MET');assert.equal((await read()).status,'NOT_ELIGIBLE');
 await observe(ids.recommendation,'MET');assert.equal((await read()).status,'APPROACHING');
 await admin.query('UPDATE hon.curriculum_requirements SET version=version+1 WHERE id=$1',[ids.requirement]);r=await read();assert.equal(r.criteria.find(c=>c.sourceId===ids.requirement).outcome,'MISSING');
 await observe(ids.requirement,'MET',2);check();
 const attendanceReceipt=await attendance.record(context(),ids.session,{studentProfileId:ids.student,status:'PRESENT',note:'PRIVATE_SECRET'});assert.equal(attendanceReceipt.attendance.progressionCreditMilli,1000);
 r=await read();assert.equal(r.attendanceRecordCount,1);assert.equal(r.criteria.find(c=>c.code==='ATTENDANCE').observed,1000);assert.equal(r.status,'APPROACHING');check();
 // Noncredit observer, pre-rank and future sessions cannot add progression credit.
 for(const [delta,category]of [[-60,'REGULAR_PARTICIPANT'],[1,'REGULAR_PARTICIPANT'],[-2,'OBSERVER']]){const session=randomUUID();await admin.query(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status) VALUES($1,$2,$3,$4,'Session',now()+$5*interval '1 day',now()+$5*interval '1 day'+interval '1 hour',30,'WALK_IN','SCHEDULED')`,[session,ids.org,ids.school,ids.program,delta]);await attendance.record(context(),session,{studentProfileId:ids.student,status:'PRESENT',category});}
 assert.equal((await read()).criteria.find(c=>c.code==='ATTENDANCE').observed,1000);check();
 const open=await event();r=await read();assert.equal(r.status,'ELIGIBLE_INSTRUCTOR_REVIEW');assert.equal(r.criteria.find(c=>c.code==='TESTING_WINDOW').sourceId,open);
 // Opens inclusive, closes exclusive; future/null/past-start windows fail closed.
 for(const [column,value]of [['registration_opens_at',new Date(Date.now()+3600000)],['registration_closes_at',new Date(Date.now()-1000)]]){if(column==='registration_closes_at')await admin.query("UPDATE hon.testing_events SET registration_opens_at=now()-interval '1 day' WHERE id=$1",[open]);await admin.query(`UPDATE hon.testing_events SET ${column}=$1 WHERE id=$2`,[value,open]);assert.equal((await read()).status,'APPROACHING');}
 await admin.query("UPDATE hon.testing_events SET registration_opens_at=NULL,registration_closes_at=NULL WHERE id=$1",[open]);assert.equal((await read()).status,'APPROACHING');
 await admin.query("UPDATE hon.testing_events SET registration_opens_at=now()-interval '1 day',registration_closes_at=now()+interval '1 day',starts_at=now()-interval '1 hour' WHERE id=$1",[open]);assert.equal((await read()).status,'APPROACHING');
 await admin.query("UPDATE hon.testing_events SET registration_opens_at=now()-interval '1 day',registration_closes_at=now()+interval '1 day',starts_at=now()+interval '2 days' WHERE id=$1",[open]);check();
 // Optional document absence is a criterion, not guessed acknowledgement. Use
 // the existing human document command for immutable private content/publication.
 async function documentCommand(action,id,input){const c=context();return db.withTenantTransaction(c,async client=>{await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");return (await client.query('SELECT hon.mutate_document($1,$2,$3,$4,$5::jsonb,$6,$7,$8) data',[subject,'STAFF',action,id,JSON.stringify(input),c.idempotencyKey,c.requestId,c.correlationId])).rows[0].data;});}
 const created=await documentCommand('document.template.create',null,{audience:'STAFF',title:'PRIVATE_SECRET',content:'PRIVATE_SECRET'});const template=created.record.id;
 await setPolicy({promotionReadinessV1:{...policy,documentTemplateIds:[template]}});r=await read();assert.equal(r.status,'APPROACHING');assert.equal(r.criteria.find(c=>c.code==='DOCUMENT').outcome,'MISSING');
 const published=await documentCommand('document.publish',template,{expectedVersion:1,versionId:created.record.versionId});const publication=published.record.currentPublicationId;
 await documentCommand('document.acknowledge',publication,{choice:'ACKNOWLEDGE',contentHash:published.record.contentHash});r=await read();assert.equal(r.status,'ELIGIBLE_INSTRUCTOR_REVIEW');assert.equal(r.criteria.find(c=>c.code==='DOCUMENT').outcome,'MET');check();
 // Superseded publications never reuse the old acknowledgement.
 const revised=await documentCommand('document.template.version',template,{expectedVersion:2,title:'PRIVATE_SECRET revised',content:'PRIVATE_SECRET revised'});
 const republished=await documentCommand('document.publish',template,{expectedVersion:3,versionId:revised.record.versionId});r=await read();assert.equal(r.criteria.find(c=>c.code==='DOCUMENT').outcome,'MISSING');assert.equal(r.status,'APPROACHING');
 await documentCommand('document.acknowledge',republished.record.currentPublicationId,{choice:'ACKNOWLEDGE',contentHash:republished.record.contentHash});assert.equal((await read()).status,'ELIGIBLE_INSTRUCTOR_REVIEW');check();
 // Latest exact target only; notes never leak, final result is not promotion.
 await candidate('PASSED',{target:ids.last});assert.equal((await read()).status,'ELIGIBLE_INSTRUCTOR_REVIEW');
 const low='11111111-1111-4111-8111-111111111111',high='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',tie=new Date(Date.now()-1000);
 await candidate('PASSED',{id:low,created:tie,updated:tie});await candidate('PENDING',{id:high,created:tie,updated:tie});
 r=await read();assert.equal(r.status,'APPROVED_FOR_TESTING');assert.equal(r.candidate.id,high);assert.equal(r.candidate.result,'PENDING');
 await setPolicy({});assert.equal((await read()).status,'APPROVED_FOR_TESTING');
 await admin.query("UPDATE hon.testing_candidates SET result='DEFERRED',updated_at=now() WHERE id=$1",[high]);r=await read();assert.equal(r.status,'TESTING_COMPLETED');assert.equal(r.candidate.result,'DEFERRED');assert.equal(r.policyVersion,null);check();
 // Validate no enrollment-version stale progress survives a human placement.
 await setPolicy({promotionReadinessV1:policy});await progress.setRank(context(),ids.curriculum,ids.enrollment,{currentRankId:ids.rank,expectedEnrollmentVersion:1});
 r=await read();assert.equal(r.status,'TESTING_COMPLETED');assert.equal(r.criteria.find(c=>c.sourceId===ids.requirement).outcome,'MISSING');assert.equal(r.criteria.find(c=>c.code==='TIME_IN_RANK').observed,0);check();
 const controller=new PromotionReadinessController(db,service),request={honIdentity:{externalSubject:subject},headers:{},query:{}};
 const beforeController=await snapshot();const envelope=await controller.read(ids.org,ids.school,ids.curriculum,ids.enrollment,request);parsePromotionReadiness(envelope.data,{organizationId:ids.org,schoolId:ids.school,curriculumId:ids.curriculum,enrollmentId:ids.enrollment});await assert.rejects(()=>controller.read(ids.otherOrg,ids.school,ids.curriculum,ids.enrollment,request),status(403));assert.deepEqual(await snapshot(),beforeController);check();
 await verifyPromotionReadinessSecurity(admin,'hon_promotion_readiness_runtime');assert.equal(externalCalls,0);
 console.log(`Promotion readiness integrity passed: ${groups} assertion groups, ${verifiedReads} verified reads; all ${tables.length} hon tables unchanged across each read; external calls 0.`);
} finally {await admin.query('ROLLBACK');await runtime.query('ROLLBACK');await db.onModuleDestroy();await admin.end();await runtime.end();teardownFixture();}
