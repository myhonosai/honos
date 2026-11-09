import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// B-HQ-2b HQ school health (0233) proof, TEST MODE, disposable database only. It proves: only an HQ owner, an HQ operator
// with hq.billing.manage, or HQ staff with hq.support.manage read school health (lapsed owners, support without the
// permission, school owners and unknown subjects are refused); the runtime can execute only the two reads; counts follow
// the 30-day windows exactly; every signal follows from the counts; the needing-attention list holds only flagged active
// schools, most signals first; reads write nothing; a reader revoked meanwhile gets nothing.
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env);
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const {HqSupportService}=await import('../../../apps/api/dist/hq-support/hq-support.service.js');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),reads=new SaasSchoolBillingService(billing),support=new HqSupportService(billing);
const admin=new pg.Client(targets.owner),restricted=new pg.Client(targets.runtime);
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const ORG=randomUUID(),BUSY=randomUUID(),QUIET=randomUUID(),LAPSED=randomUUID(),CLOSED_SCHOOL=randomUUID(),PROGRAM=randomUUID(),PIPE=randomUUID(),STAGE=randomUUID();
const humans=Object.fromEntries(['owner','exowner','billingOp','supportAgent','plainSupport','stranger']
 .map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`hqhealth-${k}-${randomUUID()}`,name:`Fixture ${k}`}]));
const H=k=>humans[k].subject,P=k=>humans[k].id;
const owned=['outbox_delivery_attempts','outbox_events','audit_events','attendance_records','class_bookings','class_sessions','student_profiles','crm_lead_attributions','crm_leads','crm_pipeline_stages','crm_pipelines','people','programs'];
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  const sc=['hq_support_requests','hq_support_case_events','hq_support_cases'];
  for(const t of [...sc,'crm_lead_attributions'])await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  const ids=(await admin.query('SELECT id FROM hon.hq_support_cases WHERE organization_id=$1',[ORG])).rows.map(r=>r.id);
  for(const t of sc.slice(0,2))await admin.query(`DELETE FROM hon.${t} WHERE case_id=ANY($1::uuid[])`,[ids]);
  await admin.query('DELETE FROM hon.hq_support_cases WHERE id=ANY($1::uuid[])',[ids]);
  for(const t of owned)await admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`,[ORG]);
  for(const t of [...sc,'crm_lead_attributions'])await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('DELETE FROM hon.schools WHERE organization_id=$1',[ORG]);
  await admin.query('DELETE FROM hon.organizations WHERE id=$1',[ORG]);
  const ps=Object.values(humans).map(h=>h.id),us=Object.values(humans).map(h=>h.user);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[us]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const counts=async()=>(await admin.query(`SELECT (SELECT count(*) FROM hon.attendance_records WHERE organization_id=$1)::int a,
  (SELECT count(*) FROM hon.class_sessions WHERE organization_id=$1)::int s,(SELECT count(*) FROM hon.crm_leads WHERE organization_id=$1)::int l,
  (SELECT count(*) FROM hon.hq_support_cases WHERE organization_id=$1)::int c`,[ORG])).rows[0];
let sessionN=0;
async function session(school,offset,status='COMPLETED'){
 const id=randomUUID();sessionN++;
 await admin.query(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status,cancellation_reason)
  VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6::interval,clock_timestamp()+$6::interval+interval '1 hour',20,'WALK_IN',$7,$8)`,[id,ORG,school,PROGRAM,`Class ${sessionN}`,offset,status,status==='CANCELLED'?'Fixture':null]);
 return id;
}
async function student(school){
 const person=randomUUID(),id=randomUUID();
 await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Synthetic','Student')",[person,ORG,school]);
 await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)',[id,ORG,school,person]);
 return id;
}
async function visit(school,who,ago,status='PRESENT'){
 const s=await session(school,`-${ago}`);
 await admin.query("INSERT INTO hon.attendance_records(id,organization_id,school_id,class_session_id,student_profile_id,status,recorded_at,progression_credit_milli) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-$7::interval,$8)",[randomUUID(),ORG,school,s,who,status,ago,['PRESENT','LATE','MAKEUP'].includes(status)?1000:0]);
}
async function lead(school,ago,won=null){
 const person=randomUUID();
 await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Synthetic','Lead')",[person,ORG,school]);
 await admin.query(`INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,source_code,created_at,won_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,'HEALTH',clock_timestamp()-$8::interval,${won?`clock_timestamp()-'${won}'::interval`:'NULL'})`,[randomUUID(),ORG,school,person,PIPE,STAGE,won?'WON':'OPEN',ago]);
}

await Promise.all([admin.connect(),restricted.connect()]);
await verifyChampionsProofConnection(admin,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection(restricted,CHAMPIONS_RUNTIME_ROLE);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- 0. posture ----------
 for(const[sig,allowed]of [['read_hq_school_health(text,uuid)',true],['read_hq_schools_needing_attention(text,integer)',true],
  ['require_hq_health_actor(text)',false],['hq_school_health_facts(uuid,timestamptz)',false]])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
 await cleanup();

 // ---------- fixture ----------
 // Attendance rows are written directly (the staff recording path is proven elsewhere), so its actor trigger is off for the fixture.
 await admin.query('ALTER TABLE hon.attendance_records DISABLE TRIGGER USER');
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[h.user,h.subject,`${h.user}@example.test`,h.name]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,true)",[h.id,h.user,h.name]);}
 for(const[who,role,perms,until]of [['owner','HON_HQ_OWNER',[],null],['exowner','HON_HQ_OWNER',[],'1 minute'],['billingOp','HON_HQ_OPERATOR',['hq.billing.manage'],null],
  ['supportAgent','HON_HQ_SUPPORT',['hq.support.manage'],null],['plainSupport','HON_HQ_SUPPORT',['hq.billing.manage'],null]])
  await admin.query(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',${until?`clock_timestamp()-interval '${until}'`:'NULL'})`,[P(who),role,perms]);
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'HQH Fixture Dojo','HQH Fixture Dojo','ACTIVE',clock_timestamp())",[ORG]);
 for(const[s,name,status]of [[BUSY,'HQH Busy','ACTIVE'],[QUIET,'HQH Quiet','ACTIVE'],[LAPSED,'HQH Lapsed','ACTIVE'],[CLOSED_SCHOOL,'HQH Archived','ARCHIVED']])
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone,status) VALUES($1::uuid,$2,$3,$1::text,'UTC',$4)",[s,ORG,name,status]);
 await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$2,$3,'Fixture program')",[PROGRAM,ORG,BUSY]);
 await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Fixture pipeline')",[PIPE,ORG,BUSY]);
 await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)",[STAGE,ORG,BUSY,PIPE]);
 // Busy: 3 visits in the last 30 days (one an absence that does not count), 12 in the 30 before; one class ahead; leads.
 const kid=await student(BUSY);
 for(const ago of ['1 day','3 days','10 days'])await visit(BUSY,kid,ago);
 await visit(BUSY,kid,'2 days','UNEXCUSED_ABSENCE');
 for(let i=0;i<12;i++)await visit(BUSY,kid,`${32+i*2} days`);
 await visit(BUSY,kid,'61 days');
 await session(BUSY,'3 days','SCHEDULED'); await session(BUSY,'20 days','SCHEDULED'); await session(BUSY,'2 days','CANCELLED');
 await lead(BUSY,'5 days'); await lead(BUSY,'40 days','3 days'); await lead(BUSY,'45 days');
 // Lapsed: a student whose last visit was 20 days ago. Quiet: nothing at all.
 const old=await student(LAPSED);
 await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$2,$3,'Lapsed program')",[randomUUID(),ORG,LAPSED]);
 await admin.query('COMMIT');
 const lapsedProgram=(await admin.query('SELECT id FROM hon.programs WHERE school_id=$1',[LAPSED])).rows[0].id;
 { const s=randomUUID();
   await admin.query(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status)
    VALUES($1,$2,$3,$4,'Old class',clock_timestamp()-interval '20 days',clock_timestamp()-interval '20 days'+interval '1 hour',20,'WALK_IN','COMPLETED')`,[s,ORG,LAPSED,lapsedProgram]);
   await admin.query("INSERT INTO hon.attendance_records(id,organization_id,school_id,class_session_id,student_profile_id,status,recorded_at,progression_credit_milli) VALUES($1,$2,$3,$4,$5,'PRESENT',clock_timestamp()-interval '20 days',1000)",[randomUUID(),ORG,LAPSED,s,old]); }
 await admin.query('ALTER TABLE hon.attendance_records ENABLE TRIGGER USER');

 // ---------- 1. authority ----------
 for(const who of ['owner','billingOp','supportAgent'])assert.equal((await reads.readHqSchoolHealth(H(who),BUSY)).schoolId,BUSY,who);
 for(const who of ['exowner','plainSupport','stranger']){
  await deny(reads.readHqSchoolHealth(H(who),BUSY),403,'SAAS_FORBIDDEN');
  await deny(reads.readHqSchoolsNeedingAttention(H(who),{}),403,'SAAS_FORBIDDEN');
 }
 await deny(reads.readHqSchoolHealth(H('owner'),randomUUID()),404);
 for(const bad of ['nope','',null])await deny(reads.readHqSchoolHealth(H('owner'),bad),400,'INVALID_SAAS_INPUT');
 for(const bad of [{limit:'0'},{limit:'201'},{limit:'x'},{schoolId:BUSY}])await deny(reads.readHqSchoolsNeedingAttention(H('owner'),bad),400,'INVALID_SAAS_INPUT');

 // ---------- 2. counts and signals ----------
 const before=await counts();
 const busy=(await reads.readHqSchoolHealth(H('supportAgent'),BUSY)).health;
 assert.deepEqual(busy.attendance.last30Days,3); assert.equal(busy.attendance.previous30Days,12);
 assert(Date.now()-Date.parse(busy.attendance.lastRecordedAt) < 2*86400e3);
 assert.deepEqual(busy.classes,{heldLast30Days:4,scheduledNext14Days:1},'held = 4 past non-cancelled sessions in 30 days; only one scheduled within 14 days');
 assert.deepEqual(busy.leads,{newLast30Days:1,newPrevious30Days:2,wonLast30Days:1,open:2});
 assert.equal(busy.activeStudents,1); assert.equal(busy.openSupportCases,0); assert.equal(busy.bookingsLast30Days,0);
 assert.deepEqual(busy.signals,['ATTENDANCE_DOWN']);
 const quiet=(await reads.readHqSchoolHealth(H('owner'),QUIET)).health;
 assert.deepEqual(quiet.signals,['NO_ACTIVE_STUDENTS','NO_CLASSES_NEXT_14_DAYS','NO_NEW_LEADS_30_DAYS']);
 assert.equal(quiet.attendance.lastRecordedAt,null);
 const lapsed=(await reads.readHqSchoolHealth(H('billingOp'),LAPSED)).health;
 assert.deepEqual(lapsed.signals,['NO_ATTENDANCE_14_DAYS','NO_CLASSES_NEXT_14_DAYS','NO_NEW_LEADS_30_DAYS']);
 assert.equal(lapsed.attendance.last30Days,1);
 // An open support case for the school adds a signal; closing it removes it.
 const opened=await support.open(H('supportAgent'),{organizationId:ORG,schoolId:BUSY,subject:'Attendance dropped',category:'OTHER',priority:'NORMAL',note:'Checking in.'},randomUUID());
 assert.deepEqual((await reads.readHqSchoolHealth(H('owner'),BUSY)).health.signals,['ATTENDANCE_DOWN','OPEN_SUPPORT_CASES']);
 await support.change(H('supportAgent'),opened.case.caseId,{expectedVersion:1,status:'CLOSED'},randomUUID());
 assert.deepEqual((await reads.readHqSchoolHealth(H('owner'),BUSY)).health.signals,['ATTENDANCE_DOWN']);

 // ---------- 3. needing attention ----------
 const list=await reads.readHqSchoolsNeedingAttention(H('supportAgent'),{limit:'200'});
 const mine=list.schools.filter(s=>s.organizationId===ORG);
 assert.deepEqual(mine.map(s=>s.schoolId),[LAPSED,QUIET,BUSY],'3 signals (name order Lapsed, Quiet) before 1; archived school absent');
 assert(!list.schools.some(s=>s.schoolId===CLOSED_SCHOOL));
 assert.equal(mine.find(s=>s.schoolId===BUSY).schoolDisplayName,'HQH Busy');
 for(let i=1;i<list.schools.length;i++)assert(list.schools[i-1].health.signals.length>=list.schools[i].health.signals.length);
 const one=await reads.readHqSchoolsNeedingAttention(H('owner'),{limit:'1'});
 assert.equal(one.schools.length,1); assert.equal(one.truncated,one.flagged>1); assert(one.checked>=3);
 assert(!JSON.stringify(list).includes('Synthetic'),'no person names');
 const after=await counts(); assert.deepEqual({...after,c:before.c},before,'reads write nothing');

 // ---------- 4. a reader revoked meanwhile gets nothing ----------
 await admin.query("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1",[P('supportAgent')]);
 await deny(reads.readHqSchoolHealth(H('supportAgent'),BUSY),403,'SAAS_FORBIDDEN');
 await deny(reads.readHqSchoolsNeedingAttention(H('supportAgent'),{}),403,'SAAS_FORBIDDEN');
 console.log('HQ school health proof passed (posture, authority incl. support staff, 30-day windows, signals, support-case signal, needing-attention order/limit, archived excluded, no names, read-only, revocation).');
}finally{
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy?.()]);}
}
