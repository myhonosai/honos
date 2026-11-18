/** Automation date triggers (AU-3, 0498): real signed HON sessions -> Nest/guard -> fixed runtime SQL turn date-triggered workflows on;
 *  the date scan and step runner are driven from this proof's owner connection exactly as the dedicated worker login calls them.
 *  Students, memberships and attendance are SYNTHETIC rows in SYNTHETIC schools made through the 0241 runtime entry point. Messages
 *  are only QUEUED; no provider, payment or AI is called. School time zones are set so one school is past 09:00 and one is not. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|SENDGRID.*|OPENAI.*|OPENROUTER.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER|AUTOMATION|COMMUNICATION).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {AutomationWorkflowController,ContactTagController}=require('./dist/automations/automation.controller.js');
const {AutomationService}=require('./dist/automations/automation.service.js');
const guards=require('./dist/automations/automation.guard.js');
const C=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'automation-date-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const AUTOMATION='00000000-0000-4000-8000-000000000368';
const pass=name=>console.log('PASS AUTOMATION DATE TRIGGERS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,...(key===null?{}:{'idempotency-key':key})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const identity=label=>({externalSubject:'oidc:automation-date:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=identity(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:C.SIGNUP_CONFIRMATION},K()])).rows[0].data;
 const w={...p,org:r.organizationId,school:r.schoolId,label};
 await complete(w);
 w.pipeline=K();w.stage=K();w.stage2=K();
 await q("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Synthetic pipeline')",[w.pipeline,w.org,w.school]);
 await q("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1),($5,$2,$3,$4,'Contacted',2)",[w.stage,w.org,w.school,w.pipeline,w.stage2]);
 return w;}
const complete=w=>q("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day') ON CONFLICT(organization_id) DO UPDATE SET tier='COMPLETE',status='ACTIVE',effective_from=excluded.effective_from,effective_until=NULL",[w.org]);
const base=w=>`organizations/${w.org}/schools/${w.school}/automations`;
const post=(w,path,body,command,key=K())=>send(path,{identity:w,method:'POST',key,body,command});
// A synthetic contact with an open lead; consent and addresses as asked.
import {membershipFixtureQuery} from './membership-activation-test-support.mjs';
const scan=async(n=100,client=admin)=>(await client.query('SELECT hon.scan_automation_schedules($1) d',[n])).rows[0].d;
const runDue=async(n=100)=>(await q('SELECT hon.run_due_automation_steps($1) d',[n]))[0].d;
const def=(trigger,steps,{reentry='EVERY_TIME',reentryDays=null,conditions=[],exitWhen=[]}={})=>({schemaVersion:1,trigger,entry:{reentry,reentryDays,conditions},exitWhen,steps});
const sms=(id,next,text='Hi {{first_name}}, we miss you at {{school_name}}!')=>({id,type:'SEND_SMS',content:{mode:'FIXED',text},next});
async function create(w,name,definition){const r=await post(w,base(w),{name,definition},C.AUTOMATION_CREATE_COMMAND);return C.verifyAutomationWorkflowDetail(ok(r)).workflow;}
const activate=(w,wf,version=wf.latestVersion)=>post(w,base(w)+'/'+wf.workflowId+'/activate',{expectedRevision:wf.revision,version},C.AUTOMATION_ACTIVATE_COMMAND);
async function on(w,name,trigger){const wf=await create(w,name,def(trigger,[sms('hi',null)]));return C.verifyAutomationWorkflowDetail(ok(await activate(w,wf))).workflow;}
const wfRow=async id=>(await q('SELECT status,paused_reason,revision,active_version FROM hon.automation_workflows WHERE id=$1',[id]))[0];
const runsOf=id=>q('SELECT * FROM hon.automation_runs WHERE workflow_id=$1 ORDER BY person_id',[id]);
const scansOf=id=>q("SELECT *,to_char(local_date,'YYYY-MM-DD') ld FROM hon.automation_schedule_scans WHERE workflow_id=$1 ORDER BY local_date",[id]);
const candidates=async(id,today,zone)=>q('SELECT c.* FROM hon.automation_workflows w JOIN hon.automation_workflow_versions v ON v.workflow_id=w.id AND v.version=w.active_version, hon.automation_date_candidates(w,v.definition,$2::date,$3) c WHERE w.id=$1 ORDER BY c.person_id',[id,today,zone]);
// An Etc zone where it is now between the given local hours (offsets span 26 hours, so one always exists).
const zoneAt=async(from,to)=>(await q("SELECT name FROM pg_timezone_names WHERE name ~ '^Etc/GMT[+-][0-9]+$' AND (clock_timestamp() AT TIME ZONE name)::time BETWEEN $1::time AND $2::time ORDER BY name LIMIT 1",[from,to]))[0].name;
const localToday=async zone=>(await q("SELECT to_char((clock_timestamp() AT TIME ZONE $1)::date,'YYYY-MM-DD') d",[zone]))[0].d;
const md5uuid=s=>{const h=createHash('md5').update(s).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
async function setZone(w,zone){await q('UPDATE hon.schools SET timezone=$2 WHERE id=$1',[w.school,zone]);w.zone=zone;w.today=await localToday(zone);}
// A synthetic active student: SMS consent, an ACTIVE membership (term started 90 days ago), an ACTIVE student profile, optional
// birth date and optional attendance some days ago.
async function student(w,given,{attendedDaysAgo=null,birthDate=null,endsInDays=365,membership=true}={}){
 const person=K(),student=K(),billing=K(),membershipId=K();
 await q("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,'Synthetic',$5,'+15555550123')",[person,w.org,w.school,given,given.toLowerCase()+'-'+K().slice(0,8)+'@example.invalid']);
 await q("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,'SMS','OPTED_IN','IMPORT',now(),$4)",[w.org,w.school,person,AUTOMATION]);
 if(membership){
  await q('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)',[billing,w.org,w.school,person]);
  await membershipFixtureQuery(admin,"INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at) VALUES($1,$2,$3,$4,$5,'FIXTURE','ACTIVE',clock_timestamp()-interval '90 days',clock_timestamp()+make_interval(days=>$6::integer))",[membershipId,w.org,w.school,billing,person,endsInDays]);
 }
 await q('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,birth_date) VALUES($1,$2,$3,$4,$5)',[student,w.org,w.school,person,birthDate]);
 const s={person,student,membership:membershipId,given};
 if(attendedDaysAgo!==null)s.attendance=await attend(w,s,attendedDaysAgo);
 return s;}
async function attend(w,s,daysAgo){
 if(!w.program){w.program=K();await q("INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$2,$3,'Synthetic program')",[w.program,w.org,w.school]);}
 const session=K(),id=K();
 await q("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy) VALUES($1,$2,$3,$4,'Synthetic class',clock_timestamp()-make_interval(days=>$5::integer)-interval '1 hour',clock_timestamp()-make_interval(days=>$5::integer),20,'WALK_IN')",[session,w.org,w.school,w.program,daysAgo]);
 // Fixture-only: past attendance written directly by the disposable owner, without the 0114 staff-command credit snapshot.
 await admin.query('BEGIN');
 try{await admin.query('ALTER TABLE hon.attendance_records DISABLE TRIGGER attendance_credit_snapshot');
  await admin.query("INSERT INTO hon.attendance_records(id,organization_id,school_id,class_session_id,student_profile_id,status,recorded_at,category,progression_enabled,progression_weight_milli,progression_credit_milli) VALUES($1,$2,$3,$4,$5,'PRESENT',clock_timestamp()-make_interval(days=>$6::integer),'REGULAR_PARTICIPANT',true,1000,1000)",[id,w.org,w.school,session,s.student,daysAgo]);
  await admin.query('ALTER TABLE hon.attendance_records ENABLE TRIGGER attendance_credit_snapshot');await admin.query('COMMIT');}
 catch(e){await admin.query('ROLLBACK');throw e;}
 return id;}
// A birth date whose next birthday is the given number of days after the school's local today.
const bornDaysAhead=async(w,days)=>(await q("SELECT to_char(($1::date+$2::integer)-interval '20 years','YYYY-MM-DD') d",[w.today,days]))[0].d;
const mine=[];

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody: a deny-all receipt table; the scan is a definer function the runtime cannot call; helpers are private.
 const c=(await q("SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid='hon.automation_schedule_scans'::regclass"))[0];assert(c.rls&&c.forced);
 assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename='automation_schedule_scans'"))[0].n,'0');
 for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q("SELECT has_table_privilege($1,'hon.automation_schedule_scans',$2) ok",[runtime.username,p]))[0].ok,false,p);
 for(const f of ['hon.scan_automation_schedules(integer)','hon.automation_next_birthday(date,date)','hon.automation_date_subject_open(uuid,uuid,text)','hon.automation_date_candidates(hon.automation_workflows,jsonb,date,text)','hon.automation_unavailable(jsonb)'])
  assert.equal((await q("SELECT has_function_privilege($1,$2::regprocedure,'EXECUTE') ok",[runtime.username,f]))[0].ok,false,f);
 const sc=(await q("SELECT prosecdef d,proconfig c FROM pg_proc WHERE oid='hon.scan_automation_schedules(integer)'::regprocedure"))[0];assert.equal(sc.d,true);assert.deepEqual(sc.c,['search_path=pg_catalog, hon']);
 await assert.rejects(restricted.query('SELECT hon.scan_automation_schedules(10)'),/permission denied/);
 for(const n of [0,501,null])await assert.rejects(q('SELECT hon.scan_automation_schedules($1)',[n]),/AUTOMATION_INVALID/);
 pass('forced deny-all RLS on the scan receipts; the definer date scan, candidate and birthday helpers are not runtime-callable; the batch is bounded');

 const module=await Test.createTestingModule({controllers:[AutomationWorkflowController,ContactTagController],providers:[AutomationService,...Object.values(guards),HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta'),late=await register('gamma');
 const after9=await zoneAt('10:00','22:00'),before9=await zoneAt('01:00','08:00');
 await setZone(a,after9);await setZone(b,after9);await setZone(late,before9);

 // 2. Turning on: the three date triggers now run; SCHEDULE and CUSTOM_TOOL_RECORD are still refused by name.
 const mia=await on(a,'Missing in action',{kind:'ABSENT_DAYS',config:{days:14}});mine.push(mia.workflowId);
 assert.equal(mia.status,'ACTIVE');
 for(const kind of ['SCHEDULE','CUSTOM_TOOL_RECORD'])assert.equal((await q("SELECT hon.automation_unavailable(jsonb_build_object('trigger',jsonb_build_object('kind',$1::text))) p",[kind]))[0].p,'trigger '+kind);
 for(const kind of ['ABSENT_DAYS','BIRTHDAY','MEMBERSHIP_ENDS_IN_DAYS'])assert.equal((await q("SELECT hon.automation_unavailable($1::jsonb) p",[JSON.stringify(def({kind,config:{}},[sms('hi',null)]))]))[0].p,null);
 pass('ABSENT_DAYS, BIRTHDAY and MEMBERSHIP_ENDS_IN_DAYS workflows turn on; SCHEDULE and CUSTOM_TOOL_RECORD stay refused by name');

 // 3. MIA: an active student absent 14+ days (or never attended since a term that began 90 days ago) starts one run per absence
 // episode; a student who came 2 days ago does not; one scan per workflow per school day; the run queues the SMS as AUTOMATION.
 const gone=await student(a,'Gone',{attendedDaysAgo:20}),never=await student(a,'Never'),here=await student(a,'Here',{attendedDaysAgo:2});
 const lapsed=await student(a,'Lapsed',{attendedDaysAgo:30,membership:false});
 let d=await scan();assert(d.scanned>=1&&d.failed===0,JSON.stringify(d));
 let runs=await runsOf(mia.workflowId);
 assert.deepEqual(runs.map(r=>r.person_id).sort(),[gone.person,never.person].sort());
 assert.equal(runs.find(r=>r.person_id===gone.person).trigger_key,'abs:'+gone.attendance);
 assert.equal(runs.find(r=>r.person_id===never.person).trigger_key,'abs:'+never.membership);
 assert(runs.every(r=>r.trigger_event_id===null&&r.depth===0&&r.organization_id===a.org&&r.school_id===a.school));
 let scans=await scansOf(mia.workflowId);assert.equal(scans.length,1);
 assert.deepEqual([scans[0].trigger_kind,scans[0].runs_started,scans[0].failure_code,scans[0].ld],['ABSENT_DAYS',2,null,a.today]);
 d=await scan();assert.equal((await scansOf(mia.workflowId)).length,1);assert.equal((await runsOf(mia.workflowId)).length,2);
 const steps=await runDue();assert(steps.ran>=2,JSON.stringify(steps));
 const text=(await q("SELECT m.* FROM hon.communication_messages m JOIN hon.automation_run_steps s ON s.message_id=m.id JOIN hon.automation_runs r ON r.id=s.run_id WHERE r.workflow_id=$1 AND r.person_id=$2",[mia.workflowId,gone.person]))[0];
 assert.equal(text.origin_kind,'AUTOMATION');assert.equal(text.channel,'SMS');assert.equal(text.content,'Hi Gone, we miss you at Synthetic alpha Dojo!');assert.equal(text.lifecycle,'QUEUED');assert.equal(text.created_by_principal_id,AUTOMATION);
 // A new absence episode is a new subject: coming back and going missing again gives a new key.
 const back=await attend(a,gone,16);
 assert.deepEqual((await candidates(mia.workflowId,a.today,a.zone)).find(x=>x.person_id===gone.person).trigger_key,'abs:'+back);
 assert.equal((await candidates(mia.workflowId,a.today,a.zone)).some(x=>x.person_id===here.person||x.person_id===lapsed.person),false);
 // A subject that already started is dropped before the 1000 cap, so a long backlog is reached day by day.
 assert.equal((await candidates(mia.workflowId,a.today,a.zone)).some(x=>x.person_id===never.person),false);
 pass('MIA: active students absent 14+ days (or never since their term began) start one run per absence episode, not someone who came 2 days ago or has no active membership; one scan per workflow and school day; the SMS is queued as AUTOMATION with the first name');

 // 4. Birthdays: a student whose birthday is 3 days away starts one run keyed to that birthday year; 10 days away does not;
 // 29 February is kept on 28 February in other years.
 const soon=await student(a,'Soon',{birthDate:await bornDaysAhead(a,3)}),later=await student(a,'Later',{birthDate:await bornDaysAhead(a,10)});
 const bday=await on(a,'Birthday wishes',{kind:'BIRTHDAY',config:{daysBefore:3}});mine.push(bday.workflowId);
 d=await scan();runs=await runsOf(bday.workflowId);
 assert.deepEqual(runs.map(r=>r.person_id),[soon.person]);
 const year=(await q("SELECT extract(year FROM $1::date+3)::integer y",[a.today]))[0].y;
 assert.equal(runs[0].trigger_key,'bday:'+md5uuid(soon.person+':'+year));
 assert.equal((await candidates(bday.workflowId,a.today,a.zone)).some(x=>x.person_id===later.person),false);
 for(const [born,today,next] of [['2016-02-29','2027-02-01','2027-02-28'],['2016-02-29','2028-02-01','2028-02-29'],['2016-02-29','2027-03-01','2028-02-29'],
   ['2000-05-01','2026-05-02','2027-05-01'],['2000-05-01','2026-05-01','2026-05-01'],['2000-12-31','2026-12-31','2026-12-31']])
  assert.equal((await q("SELECT to_char(hon.automation_next_birthday($1::date,$2::date),'YYYY-MM-DD') n",[born,today]))[0].n,next,born+' '+today);
 pass('birthdays: a student whose birthday is within 3 days starts one run keyed to that birthday year, not one 10 days away; leap-day birthdays fall on 28 February in other years');

 // 5. Memberships ending: an active term ending in 5 days starts one run; 30 days away does not; a renewed term is a new subject.
 const ending=await student(a,'Ending',{endsInDays:5}),renewing=await student(a,'Renewing',{endsInDays:30});
 const mend=await on(a,'Renewal reminder',{kind:'MEMBERSHIP_ENDS_IN_DAYS',config:{days:7}});mine.push(mend.workflowId);
 d=await scan();runs=await runsOf(mend.workflowId);
 assert.deepEqual(runs.map(r=>r.person_id),[ending.person]);
 const before=runs[0].trigger_key;assert.match(before,/^mend:[0-9a-f-]{36}$/);
 // While that run is open the contact is not a candidate; once it ends a changed term end is.
 assert.equal((await candidates(mend.workflowId,a.today,a.zone)).some(x=>x.person_id===ending.person),false);
 await runDue();assert.equal((await runsOf(mend.workflowId))[0].status,'COMPLETED');
 await membershipFixtureQuery(admin,"UPDATE hon.memberships SET term_ends_at=term_ends_at+interval '1 day',version=version+1 WHERE id=$1",[ending.membership]);
 const after=(await candidates(mend.workflowId,a.today,a.zone)).find(x=>x.person_id===ending.person).trigger_key;
 assert.notEqual(after,before);
 assert.equal((await candidates(mend.workflowId,a.today,a.zone)).some(x=>x.person_id===renewing.person),false);
 pass('memberships ending: an active term ending within 7 days starts one run, not one ending in 30 days; a changed term end is a new subject');

 // 6. School time: a school where it is not yet 09:00 is not scanned; once it is, it is.
 const early=await student(late,'Early',{attendedDaysAgo:20});
 const lateMia=await on(late,'MIA before nine',{kind:'ABSENT_DAYS',config:{days:14}});mine.push(lateMia.workflowId);
 d=await scan();assert.equal((await scansOf(lateMia.workflowId)).length,0);assert.equal((await runsOf(lateMia.workflowId)).length,0);
 await setZone(late,after9);d=await scan();
 assert.equal((await scansOf(lateMia.workflowId)).length,1);assert.deepEqual((await runsOf(lateMia.workflowId)).map(r=>r.person_id),[early.person]);
 pass('a school is scanned only once its local time reaches 09:00, then once that local day');

 // 7. Authority: when the activator no longer has HON OS COMPLETE the scan pauses the workflow (AUTHORITY_LOST) and starts nothing.
 const bGone=await student(b,'Bgone',{attendedDaysAgo:40});
 const bMia=await create(b,'Beta MIA',def({kind:'ABSENT_DAYS',config:{days:14}},[sms('hi',null)]));
 const bOn=C.verifyAutomationWorkflowDetail(ok(await activate(b,bMia))).workflow;mine.push(bOn.workflowId);
 await q("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1",[b.org]);
 d=await scan();assert(d.paused>=1,JSON.stringify(d));
 assert.deepEqual(await wfRow(bOn.workflowId).then(x=>[x.status,x.paused_reason]),['PAUSED','AUTHORITY_LOST']);
 assert.equal((await scansOf(bOn.workflowId)).length,0);assert.equal((await runsOf(bOn.workflowId)).length,0);
 assert.equal((await q("SELECT count(*) n FROM hon.audit_events WHERE entity_id=$1 AND action_code='automation.workflow.paused' AND source='AUTOMATION'",[bOn.workflowId]))[0].n,'1');
 await complete(b);
 let x=await wfRow(bOn.workflowId);ok(await post(b,base(b)+'/'+bOn.workflowId+'/activate',{expectedRevision:x.revision,version:x.active_version},C.AUTOMATION_ACTIVATE_COMMAND));
 // 8. Isolation: the other school's workflow starts runs only for its own students.
 d=await scan();runs=await runsOf(bOn.workflowId);
 assert.deepEqual(runs.map(r=>r.person_id),[bGone.person]);assert(runs.every(r=>r.organization_id===b.org&&r.school_id===b.school));
 for(const id of [mia.workflowId,bday.workflowId,mend.workflowId])assert.equal((await runsOf(id)).some(r=>r.person_id===bGone.person),false);
 pass('a lost activator pauses a date workflow (AUTHORITY_LOST, recorded as AUTOMATION) before any run or receipt; once restored and turned on again it starts runs only for its own school\'s students');

 // 9. A scan that fails is receipted SCAN_ERROR, keeps none of its runs and does not stop the other workflows.
 const fault=await student(a,'Fault',{endsInDays:3,attendedDaysAgo:1}),fine=await student(a,'Fine',{attendedDaysAgo:25});
 await q(`CREATE FUNCTION hon.au3_scan_fault() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.person_id='${fault.person}' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $f$`);
 await q('CREATE TRIGGER au3_scan_fault BEFORE INSERT ON hon.automation_runs FOR EACH ROW EXECUTE FUNCTION hon.au3_scan_fault()');
 const mend2=await on(a,'Renewal reminder two',{kind:'MEMBERSHIP_ENDS_IN_DAYS',config:{days:7}});mine.push(mend2.workflowId);
 const mia2=await on(a,'MIA two',{kind:'ABSENT_DAYS',config:{days:21}});mine.push(mia2.workflowId);
 try{d=await scan();}finally{await q('DROP TRIGGER au3_scan_fault ON hon.automation_runs');await q('DROP FUNCTION hon.au3_scan_fault()');}
 assert.equal(d.failed,1,JSON.stringify(d));
 scans=await scansOf(mend2.workflowId);assert.deepEqual([scans.length,scans[0].failure_code,scans[0].runs_started],[1,'SCAN_ERROR',0]);
 assert.equal((await runsOf(mend2.workflowId)).length,0);
 assert.equal((await scansOf(mia2.workflowId))[0].failure_code,null);
 assert((await runsOf(mia2.workflowId)).some(r=>r.person_id===fine.person));
 pass('a failing scan is receipted SCAN_ERROR with none of its runs kept, and the next workflow in the batch is still scanned');

 // 10. Two engines scanning at once: each workflow is scanned once and each subject starts one run.
 const second=new pg.Client({connectionString:owner.toString(),ssl:false});await second.connect();
 try{
  for(let i=0;i<3;i++)await student(b,'Race'+i,{attendedDaysAgo:50});
  const race=await on(b,'Race MIA',{kind:'ABSENT_DAYS',config:{days:30}});mine.push(race.workflowId);
  const [r1,r2]=await Promise.all([scan(100,admin),scan(100,second)]);
  assert.equal((await scansOf(race.workflowId)).length,1);
  const raced=await runsOf(race.workflowId);assert.equal(raced.length,4);assert.equal(new Set(raced.map(r=>r.person_id)).size,4);
  assert.equal(r1.failed+r2.failed,0);
 }finally{await second.end();}
 pass('two engines scanning at once scan each workflow once and start one run per subject');

 // 11. Receipts never change.
 await assert.rejects(q('UPDATE hon.automation_schedule_scans SET runs_started=0 WHERE workflow_id=$1',[mia.workflowId]),/AUTOMATION_HISTORY_IMMUTABLE/);
 await assert.rejects(q('DELETE FROM hon.automation_schedule_scans WHERE workflow_id=$1',[mia.workflowId]),/AUTOMATION_HISTORY_IMMUTABLE/);
 await assert.rejects(q('TRUNCATE hon.automation_schedule_scans'),/AUTOMATION_HISTORY_IMMUTABLE/);
 pass('scan receipts cannot be edited, deleted or truncated');

 // 12. The canonical 011 exact verification for 0423 (with the 0498 body) and 0498 passes on this database and refuses drift.
 const verify=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
 const section=(begin,end)=>{const x=verify.split(begin)[1]?.split(end)[0];assert(x,begin);return x.replace(/^[^\n]*\n/,'').replaceAll('hon_runtime',runtime.username);};
 const s423=section('-- Automation engine exact verification (AU-2 0423)','-- End automation engine exact verification.');
 const s475=section('-- Automation date triggers exact verification (AU-3 0498)','-- End automation date triggers exact verification.');
 await admin.query(s423);await admin.query(s475);
 for(const [drift,pattern] of [
  [`GRANT EXECUTE ON FUNCTION hon.scan_automation_schedules(integer) TO ${runtime.username}`,/Unsafe automation date trigger function/],
  [`GRANT EXECUTE ON FUNCTION hon.automation_next_birthday(date,date) TO ${runtime.username}`,/Unsafe automation date trigger function/],
  ['ALTER TABLE hon.automation_schedule_scans DISABLE TRIGGER guarded',/guard triggers/],
  ['ALTER TABLE hon.automation_schedule_scans NO FORCE ROW LEVEL SECURITY',/Unsafe automation date trigger table/],
  [`GRANT SELECT ON hon.automation_schedule_scans TO ${runtime.username}`,/Unsafe automation date trigger table/]]){
  await admin.query('BEGIN');try{await admin.query(drift);await assert.rejects(admin.query(s475),pattern);}finally{await admin.query('ROLLBACK');}
  await admin.query(s475);
 }
 pass('the canonical 011 exact verification for 0423 and 0498 passes here and refuses a runtime grant, a disabled guard, unforced RLS and a table grant');
 console.log('PASS: automation date triggers (0498), '+groups+' groups');
}finally{
 // Leave nothing running for other proofs that share this fixture.
 for(const id of mine)await q("SELECT hon.automation_engine_pause($1,'FIXTURE_DONE')",[id]).catch(()=>{});
 await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end()]);}
