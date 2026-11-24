/** Automation engine (AU-2, 0423): real signed HON sessions -> Nest/guard -> fixed runtime SQL for turning workflows on, pausing and reading
 *  history; the two engine functions are driven from this proof's owner connection exactly as the dedicated worker login calls them.
 *  Events are synthetic outbox rows about synthetic contacts. Messages are only QUEUED (the 0243 claim creates their delivery records);
 *  no provider, payment or AI is called. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point. */
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
const session={mode:'OIDC',audience:'automation-engine-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const AUTOMATION='00000000-0000-4000-8000-000000000368';
const pass=name=>console.log('PASS AUTOMATION ENGINE '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,...(key===null?{}:{'idempotency-key':key})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const identity=label=>({externalSubject:'oidc:automation-engine:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
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
async function contact(w,given,{sms=true,email=true}={}){
 const person=K(),lead=K();
 await q("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,'Synthetic',$5,'+15555550123')",[person,w.org,w.school,given,given.toLowerCase()+'-'+K().slice(0,8)+'@example.invalid']);
 for(const [on,ch] of [[sms,'SMS'],[email,'EMAIL']])if(on)await q("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,$4,'OPTED_IN','IMPORT',now(),$5)",[w.org,w.school,person,ch,AUTOMATION]);
 await q("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,source_code) VALUES($1,$2,$3,$4,$5,$6,'OPEN','AU2')",[lead,w.org,w.school,person,w.pipeline,w.stage]);
 return {person,lead};}
const event=async(w,type,aggregate,payload={},aggregateType='crm_lead')=>(await q("INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload) VALUES($1,$2,$3,1,$4,$5,1,$6,$7::jsonb) RETURNING id",[w.org,w.school,type,aggregateType,aggregate,K(),JSON.stringify(payload)]))[0].id;
const consume=async(n=100)=>(await q('SELECT hon.consume_automation_events($1) d',[n]))[0].d;
const runDue=async(n=100)=>(await q('SELECT hon.run_due_automation_steps($1) d',[n]))[0].d;
// Brings every waiting step of a run due now (the fixture's stand-in for the clock moving on).
const elapse=run=>q("UPDATE hon.automation_run_steps SET due_at=clock_timestamp()-interval '1 second',wait_until=clock_timestamp()-interval '1 second' WHERE run_id=$1 AND status='WAITING'",[run]);
const def=(trigger,steps,{reentry='EVERY_TIME',reentryDays=null,conditions=[],exitWhen=[]}={})=>({schemaVersion:1,trigger,entry:{reentry,reentryDays,conditions},exitWhen,steps});
const lead=()=>({kind:'LEAD_CREATED',config:{}});
const sms=(id,next,text='Hi {{first_name}}, welcome to {{school_name}}!')=>({id,type:'SEND_SMS',content:{mode:'FIXED',text},next});
async function create(w,name,definition){const r=await post(w,base(w),{name,definition},C.AUTOMATION_CREATE_COMMAND);return C.verifyAutomationWorkflowDetail(ok(r)).workflow;}
const activate=(w,wf,version=wf.latestVersion,key=K())=>post(w,base(w)+'/'+wf.workflowId+'/activate',{expectedRevision:wf.revision,version},C.AUTOMATION_ACTIVATE_COMMAND,key);
const pause=(w,wf,key=K())=>post(w,base(w)+'/'+wf.workflowId+'/pause',{expectedRevision:wf.revision},C.AUTOMATION_PAUSE_COMMAND,key);
async function on(w,name,definition){const wf=await create(w,name,definition);return C.verifyAutomationWorkflowDetail(ok(await activate(w,wf))).workflow;}
const wfRow=async id=>(await q('SELECT status,paused_reason,revision,active_version FROM hon.automation_workflows WHERE id=$1',[id]))[0];
const runsOf=(id,person)=>q('SELECT * FROM hon.automation_runs WHERE workflow_id=$1 AND ($2::uuid IS NULL OR person_id=$2) ORDER BY started_at,id',[id,person??null]);
const stepsOf=run=>q('SELECT * FROM hon.automation_run_steps WHERE run_id=$1 ORDER BY created_at,id',[run]);
const drain=async()=>{let t={ran:0,failed:0,exited:0,paused:0};for(let i=0;i<5;i++){const d=await runDue();for(const k of Object.keys(t))t[k]+=d[k];if(!d.ran&&!d.failed&&!d.exited&&!d.paused)break;}return t;};

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody: deny-all tables, runtime may only turn on, pause, archive and read; only the worker login may run the engine.
 for(const t of ['automation_event_receipts','automation_runs','automation_run_steps']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced,t);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const entry=['create_automation_workflow','save_automation_workflow_version','restore_automation_workflow_version','archive_automation_workflow','read_automation_workflows',
  'read_automation_workflow','read_automation_workflow_version','add_contact_tag','remove_contact_tag','read_school_contact_tags','read_person_contact_tags','lookup_contact_tags',
  'activate_automation_workflow','pause_automation_workflow','read_automation_runs','read_automation_run'];
 const mine=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE 'automation\\_%' OR p.proname LIKE '%automation\\_workflow%' OR p.proname LIKE '%automation\\_run%' OR p.proname LIKE '%contact\\_tag%' OR p.proname IN ('consume_automation_events','run_due_automation_steps','validate_automation_definition'))");
 assert(mine.some(f=>f.proname==='consume_automation_events')&&mine.some(f=>f.proname==='run_due_automation_steps'));
 for(const f of mine)assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry.includes(f.proname),f.proname);
 for(const f of ['consume_automation_events','run_due_automation_steps']){
  const r=(await q("SELECT prosecdef d,proconfig c FROM pg_proc WHERE oid=('hon.'||$1||'(integer)')::regprocedure",[f]))[0];assert.equal(r.d,true);assert.deepEqual(r.c,['search_path=pg_catalog, hon']);
  await assert.rejects(restricted.query(`SELECT hon.${f}(10)`),/permission denied/);
 }
 for(const n of [0,501,null])await assert.rejects(q('SELECT hon.consume_automation_events($1)',[n]),/AUTOMATION_INVALID/);
 assert.equal((await q("SELECT principal_type::text t,is_active a FROM hon.principals WHERE id=$1",[AUTOMATION]))[0].t,'AUTOMATION');
 pass('forced deny-all RLS on three engine tables; runtime executes the sixteen staff entry points only; the two definer engine functions are not runtime-callable and bound their batch');

 const module=await Test.createTestingModule({controllers:[AutomationWorkflowController,ContactTagController],providers:[AutomationService,...Object.values(guards),HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 // Anything already in the outbox from sign-up is older than every workflow; drain it so counts below are exact.
 await consume(500);

 // 2. Turning on: parts the engine does not run yet and foreign references are refused by name; exact replay; stale revision.
 let wf=await create(a,'Has approval',def(lead(),[{id:'ask',type:'REQUEST_APPROVAL',question:'Offer a make-up class?',yes:null,no:null}]));
 let r=await activate(a,wf);assert.equal(r.status,422);assert.equal(r.body.code,'AUTOMATION_NOT_AVAILABLE_YET');assert.equal(r.body.part,'step REQUEST_APPROVAL');
 wf=await create(a,'Has booking link',def(lead(),[sms('s',null,'Book here {{booking_link}}')]));
 r=await activate(a,wf);assert.equal(r.status,422);assert.equal(r.body.part,'merge field booking_link');
 wf=await create(a,'Has reply exit',def(lead(),[sms('s',null)],{exitWhen:['REPLIED']}));
 r=await activate(a,wf);assert.equal(r.status,422);assert.equal(r.body.part,'exit REPLIED');
 wf=await create(a,'Foreign stage',def(lead(),[{id:'m',type:'MOVE_STAGE',stageId:b.stage,next:null}]));
 r=await activate(a,wf);assert.equal(r.status,422);assert.equal(r.body.code,'AUTOMATION_REFERENCE_INVALID');
 assert.equal((await wfRow(wf.workflowId)).status,'DRAFT');
 const welcome=await create(a,'Welcome new leads',def(lead(),[
  sms('welcome','tag'),
  {id:'tag',type:'ADD_TAG',tag:'Evaluation lead',next:'wait'},
  {id:'wait',type:'WAIT',minutes:60,localTime:null,next:'check'},
  {id:'check',type:'IF',condition:{kind:'HAS_TAG',negate:false,tag:'evaluation LEAD'},yes:'task',no:null},
  {id:'task',type:'CREATE_TASK',title:'Call {{first_name}}',details:'They asked about classes.',dueInHours:24,assignTo:'SCHOOL_OWNERS',next:'mail'},
  {id:'mail',type:'SEND_EMAIL',content:{mode:'FIXED',subject:'Welcome to {{school_name}}',text:'Hello {{first_name}},\n\nSee you on the mat.'},next:null},
 ]));
 const before=await q("SELECT count(*) n FROM hon.automation_workflows WHERE organization_id=$1 AND status='ACTIVE'",[a.org]);
 const key=K();r=await activate(a,welcome,1,key);let live=C.verifyAutomationWorkflowDetail(ok(r)).workflow;
 assert.equal(live.status,'ACTIVE');assert.equal(live.activeVersion,1);assert.equal(r.body.meta.replayed,false);
 r=await activate(a,welcome,1,key);assert.equal(r.body.meta.replayed,true);assert.deepEqual(C.verifyAutomationWorkflowDetail(ok(r)).workflow,live);
 r=await activate(a,welcome,1);assert.equal(r.status,409);assert.equal(r.body.code,'AUTOMATION_STALE');
 r=await post(a,base(a)+'/'+welcome.workflowId+'/activate',{expectedRevision:live.revision,version:1,extra:true},C.AUTOMATION_ACTIVATE_COMMAND);assert.equal(r.status,400);
 r=await post(a,base(a)+'/'+welcome.workflowId+'/activate',{expectedRevision:live.revision,version:1},C.AUTOMATION_PAUSE_COMMAND);assert.equal(r.status,403);
 r=await post(b,base(b)+'/'+welcome.workflowId+'/activate',{expectedRevision:live.revision,version:1},C.AUTOMATION_ACTIVATE_COMMAND);assert.equal(r.status,404);
 assert.equal(Number(before[0].n),0);
 assert.equal((await q("SELECT count(*) n FROM hon.audit_events WHERE organization_id=$1 AND action_code='automation.workflow.activated'",[a.org]))[0].n,'1');
 // Turning on also needs communication.message.queue: automated sends act on the activator's authority.
 const bwf=await create(b,'Needs messaging',def(lead(),[{id:'stop',type:'STOP'}]));
 const queuePerm=await q("DELETE FROM hon.role_permissions rp USING hon.roles r WHERE r.id=rp.role_id AND r.organization_id=$1 AND r.code='OWNER' AND rp.permission_code='communication.message.queue' RETURNING rp.*",[b.org]);
 assert.equal(queuePerm.length,1);
 r=await activate(b,bwf);assert.equal(r.status,403);assert.equal((await wfRow(bwf.workflowId)).status,'DRAFT');
 await q('INSERT INTO hon.role_permissions SELECT * FROM jsonb_populate_record(NULL::hon.role_permissions,$1::jsonb)',[JSON.stringify(queuePerm[0])]);
 const bOn=C.verifyAutomationWorkflowDetail(ok(await activate(b,bwf))).workflow;ok(await pause(b,bOn));
 pass('turning on names the part HON does not run yet (approval step, booking link, reply exit) and refuses another school\'s stage and an activator without communication.message.queue; exact replay, stale revision, closed input, wrong command and other school refused; one activation record');

 // 3. A real lead event runs the workflow end to end: SMS queued with merge fields, tag, wait, condition, task, email; 0243 creates deliveries.
 const pat=await contact(a,'Pat');
 const e1=await event(a,'crm.lead.created',pat.lead);
 let c=await consume();assert.deepEqual(c,{consumed:1,runsStarted:1,failed:0});
 let [run]=await runsOf(welcome.workflowId);assert.equal(run.person_id,pat.person);assert.equal(run.trigger_key,'lead:'+pat.lead);assert.equal(run.trigger_event_id,e1);assert.equal(run.status,'RUNNING');
 assert.equal((await q('SELECT runs_started n FROM hon.automation_event_receipts WHERE outbox_event_id=$1',[e1]))[0].n,1);
 let d=await drain();assert.deepEqual(d,{ran:3,failed:0,exited:0,paused:0});
 let steps=await stepsOf(run.id);assert.deepEqual(steps.map(s=>s.step_id+':'+s.status),['welcome:DONE','tag:DONE','wait:WAITING']);
 const text=(await q('SELECT * FROM hon.communication_messages WHERE id=$1',[steps[0].message_id]))[0];
 assert.equal(text.content,'Hi Pat, welcome to Synthetic alpha Dojo!');assert.equal(text.channel,'SMS');assert.equal(text.lifecycle,'QUEUED');assert.equal(text.origin_kind,'AUTOMATION');
 assert.equal(text.origin_id,steps[0].id);assert.equal(text.created_by_principal_id,AUTOMATION);assert.equal(text.recipient_person_id,pat.person);assert.equal(text.email_subject,null);
 assert.equal(steps[0].outcome_code,'QUEUED');assert.equal(steps[1].outcome_code,'TAG_ADDED');
 const tagEvent=(await q("SELECT payload FROM hon.outbox_events WHERE organization_id=$1 AND event_type='contact.tag.added' AND aggregate_id=$2",[a.org,pat.person]))[0].payload;
 assert.equal(tagEvent.automationRunId,run.id);
 assert.equal((await q("SELECT source FROM hon.contact_tag_events WHERE person_id=$1",[pat.person]))[0].source,'AUTOMATION');
 assert(steps[2].due_at>new Date(Date.now()+59*60000));
 assert.deepEqual(await runDue(),{ran:0,failed:0,exited:0,paused:0});
 await elapse(run.id);d=await drain();assert.deepEqual(d,{ran:4,failed:0,exited:0,paused:0});
 steps=await stepsOf(run.id);assert.deepEqual(steps.map(s=>s.step_id+':'+s.status+':'+s.outcome_code),['welcome:DONE:QUEUED','tag:DONE:TAG_ADDED','wait:DONE:WAITED','check:DONE:CONDITION_YES','task:DONE:TASK_CREATED','mail:DONE:QUEUED']);
 const task=(await q('SELECT * FROM hon.work_items WHERE id=$1',[steps[4].work_item_id]))[0];
 assert.equal(task.title,'Call Pat');assert.equal(task.work_origin,'HUMAN_UI');assert.equal(task.status,'READY');assert.equal(task.created_by_principal_id,AUTOMATION);assert.equal(task.school_id,a.school);
 assert.equal((await q('SELECT count(*) n FROM hon.human_work_history WHERE work_item_id=$1',[task.id]))[0].n,'1');
 const mail=(await q('SELECT * FROM hon.communication_messages WHERE id=$1',[steps[5].message_id]))[0];
 assert.equal(mail.email_subject,'Welcome to Synthetic alpha Dojo');assert.equal(mail.content,'Hello Pat,\n\nSee you on the mat.');assert.equal(mail.channel,'EMAIL');
 [run]=await runsOf(welcome.workflowId);assert.equal(run.status,'COMPLETED');assert.equal(run.end_code,null);
 await q("SELECT * FROM hon.claim_communication_deliveries(ARRAY['SMS','EMAIL'],100,60)");
 assert.equal((await q('SELECT count(*) n FROM hon.communication_deliveries WHERE message_id=ANY($1)',[[text.id,mail.id]]))[0].n,'2');
 pass('a lead event starts one run; SMS queued as AUTOMATION with first name and school filled; tag added with run evidence; WAIT holds for an hour; IF, task (HUMAN_UI work item with history) and email with subject follow; run completes; the 0243 worker picks both messages up');

 // 4. Exactly once: replays, a second event about the same lead, and two engines racing on one event.
 // The tag the run added is itself an event; it matches no TAG_ADDED workflow and is receipted with zero runs.
 assert.deepEqual(await consume(),{consumed:1,runsStarted:0,failed:0});
 assert.deepEqual(await consume(),{consumed:0,runsStarted:0,failed:0});
 const e2=await event(a,'crm.lead.created',pat.lead);
 assert.deepEqual(await consume(),{consumed:1,runsStarted:0,failed:0});
 assert.equal((await q('SELECT runs_started n FROM hon.automation_event_receipts WHERE outbox_event_id=$1',[e2]))[0].n,0);
 const sam=await contact(a,'Sam');await event(a,'crm.lead.created',sam.lead);
 const racers=[new pg.Client({connectionString:owner.toString(),ssl:false}),new pg.Client({connectionString:owner.toString(),ssl:false})];
 await Promise.all(racers.map(x=>x.connect()));
 try{const both=await Promise.all(racers.map(x=>x.query('SELECT hon.consume_automation_events(100) d').then(v=>v.rows[0].d)));
  assert.equal(both[0].consumed+both[1].consumed,1);assert.equal(both[0].runsStarted+both[1].runsStarted,1);}
 finally{await Promise.allSettled(racers.map(x=>x.end()));}
 assert.equal((await runsOf(welcome.workflowId,sam.person)).length,1);
 pass('a consumed event is never read again; another event about the same lead starts no second run; two engines racing on one event start one run');

 // 5. Guards at send time: no consent, three automated messages a day, and the run still finishes.
 const quiet=await contact(a,'Quinn',{sms:false,email:false});
 const blast=await on(a,'Many texts',def({kind:'TAG_ADDED',config:{tag:'Many'}},[sms('one','two'),sms('two','three'),sms('three','four'),sms('four',null)]));
 for(const p of [quiet.person,sam.person])ok(await post(a,`organizations/${a.org}/schools/${a.school}/people/${p}/tags`,{tag:'many'},C.CONTACT_TAG_ADD_COMMAND));
 c=await consume();assert.equal(c.runsStarted,2);await drain();
 const [qRun]=await runsOf(blast.workflowId,quiet.person),[sRun]=await runsOf(blast.workflowId,sam.person);
 assert.deepEqual((await stepsOf(qRun.id)).map(s=>s.status+':'+s.outcome_code),Array(4).fill('SKIPPED:NO_CONSENT'));
 // Sam already has one automated text from the welcome workflow today.
 assert.deepEqual((await stepsOf(sRun.id)).map(s=>s.outcome_code),['QUEUED','QUEUED','DAILY_CAP','DAILY_CAP']);
 assert.equal((await q("SELECT count(*) n FROM hon.communication_messages WHERE recipient_person_id=$1 AND origin_kind='AUTOMATION'",[sam.person]))[0].n,'3');
 assert.equal((await q("SELECT count(*) n FROM hon.communication_messages WHERE recipient_person_id=$1",[quiet.person]))[0].n,'0');
 for(const x of await runsOf(blast.workflowId))assert.equal(x.status,'COMPLETED');
 pass('a contact without consent gets nothing (each send step skipped NO_CONSENT); at most three automated messages per contact per day; runs still finish');

 // 6. Exit rules: booking a trial or opting out ends a waiting run before its follow-up text.
 const nurture=await on(a,'Nurture until booked',def(lead(),[{id:'wait',type:'WAIT_FOR',event:'TRIAL_BOOKED',timeoutMinutes:1440,yes:null,no:'nudge'},sms('nudge',null)],{exitWhen:['TRIAL_BOOKED','OPTED_OUT']}));
 const lee=await contact(a,'Lee'),kim=await contact(a,'Kim');
 await event(a,'crm.lead.created',lee.lead);await event(a,'crm.lead.created',kim.lead);
 await consume();await drain();
 const [leeRun]=await runsOf(nurture.workflowId,lee.person),[kimRun]=await runsOf(nurture.workflowId,kim.person);
 assert.equal((await stepsOf(leeRun.id))[0].status,'WAITING');
 const owner0=(await q("SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.email=$1",[a.email]))[0]?.id
  ??(await q("SELECT created_by_principal_id id FROM hon.automation_workflows WHERE id=$1",[nurture.workflowId]))[0].id;
 await q("INSERT INTO hon.crm_appointments(organization_id,school_id,crm_lead_id,appointment_type,starts_at,ends_at,created_by_principal_id) VALUES($1,$2,$3,'TRIAL',now()+interval '1 day',now()+interval '25 hours',$4)",[a.org,a.school,lee.lead,owner0]);
 await q("UPDATE hon.communication_consents SET status='OPTED_OUT',version=version+1,updated_at=now() WHERE person_id=$1 AND channel='SMS'",[kim.person]);
 await elapse(leeRun.id);await elapse(kimRun.id);
 d=await drain();assert.equal(d.exited,2);
 for(const [x,code] of [[leeRun,'EXIT_TRIAL_BOOKED'],[kimRun,'EXIT_OPTED_OUT']]){const [now]=await q('SELECT * FROM hon.automation_runs WHERE id=$1',[x.id]);assert.equal(now.status,'EXITED');assert.equal(now.end_code,code);
  assert.deepEqual((await stepsOf(x.id)).map(s=>s.status+':'+s.outcome_code),['SKIPPED:RUN_EXITED']);}
 assert.equal((await q("SELECT count(*) n FROM hon.communication_messages WHERE recipient_person_id=ANY($1)",[[lee.person,kim.person]]))[0].n,'2');
 pass('booking a trial or opting out ends a waiting run before its next step; nothing more is sent');

 // 7. Pause and resume by staff; paused workflows start no runs and run no steps; pause twice refused.
 const ana=await contact(a,'Ana');
 const remind=await on(a,'Remind',def(lead(),[{id:'wait',type:'WAIT',minutes:30,localTime:null,next:'text'},sms('text',null)]));
 await event(a,'crm.lead.created',ana.lead);await consume();await drain();
 const [anaRun]=await runsOf(remind.workflowId,ana.person);
 let paused=C.verifyAutomationWorkflowDetail(ok(await pause(a,remind))).workflow;assert.equal(paused.status,'PAUSED');
 assert.equal((await wfRow(remind.workflowId)).paused_reason,'STAFF_PAUSED');
 r=await pause(a,paused);assert.equal(r.status,409);assert.equal(r.body.code,'AUTOMATION_NOT_ACTIVE');
 await elapse(anaRun.id);assert.equal((await runDue()).ran,0);assert.equal((await stepsOf(anaRun.id))[0].status,'WAITING');
 const ben=await contact(a,'Ben');await event(a,'crm.lead.created',ben.lead);await consume();
 assert.equal((await runsOf(remind.workflowId,ben.person)).length,0);
 const resumed=C.verifyAutomationWorkflowDetail(ok(await activate(a,paused))).workflow;assert.equal(resumed.status,'ACTIVE');
 await drain();assert.deepEqual((await stepsOf(anaRun.id)).map(s=>s.outcome_code),['WAITED','QUEUED']);
 assert.equal((await runsOf(remind.workflowId,ben.person)).length,0);
 pass('staff pause holds waiting steps and starts no runs for events while paused; turning it on again continues the held run; pausing twice is refused');

 // 8. The person who turned it on loses authority (HON OS access ends): the engine pauses the workflow, sends nothing.
 const gia=await contact(a,'Gia');await event(a,'crm.lead.created',gia.lead);await consume();
 const [giaRun]=await runsOf(remind.workflowId,gia.person);
 await q("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1",[a.org]);
 await elapse(giaRun.id);d=await runDue();assert(d.paused>=1,JSON.stringify(d));
 assert.deepEqual(await wfRow(remind.workflowId).then(x=>[x.status,x.paused_reason]),['PAUSED','AUTHORITY_LOST']);
 assert.equal((await q("SELECT count(*) n FROM hon.audit_events WHERE entity_id=$1 AND action_code='automation.workflow.paused' AND source='AUTOMATION'",[remind.workflowId]))[0].n,'1');
 assert.equal((await q("SELECT count(*) n FROM hon.communication_messages WHERE recipient_person_id=$1",[gia.person]))[0].n,'0');
 // A new event while access is gone starts no run: each matching workflow is paused instead.
 const ivy=await contact(a,'Ivy');await event(a,'crm.lead.created',ivy.lead);c=await consume();assert.equal(c.runsStarted,0);
 for(const id of [welcome.workflowId,nurture.workflowId])assert.deepEqual(await wfRow(id).then(x=>[x.status,x.paused_reason]),['PAUSED','AUTHORITY_LOST']);
 assert.equal((await q('SELECT count(*) n FROM hon.automation_runs WHERE person_id=$1',[ivy.person]))[0].n,'0');
 r=await send(base(a)+'/'+remind.workflowId+'/runs',{identity:a});assert.equal(r.status,403);
 r=await activate(a,{...remind,revision:(await wfRow(remind.workflowId)).revision},1);assert.equal(r.status,403);
 await complete(a);
 for(const id of [welcome.workflowId,nurture.workflowId,remind.workflowId]){const x=await wfRow(id);ok(await post(a,base(a)+'/'+id+'/activate',{expectedRevision:x.revision,version:x.active_version},C.AUTOMATION_ACTIVATE_COMMAND));}
 pass('when the activator no longer has HON OS COMPLETE the engine pauses a workflow (AUTHORITY_LOST, recorded as AUTOMATION) before a due step runs or a new run starts; it cannot be turned on again until access returns');

 // 9. Loops: a tag the workflow adds itself never restarts it; START_WORKFLOW chains stop at a repeat.
 const looper=await on(a,'Tag loop',def({kind:'TAG_ADDED',config:{tag:'loop'}},[{id:'off',type:'REMOVE_TAG',tag:'loop',next:'on'},{id:'on',type:'ADD_TAG',tag:'loop',next:null}]));
 const zed=await contact(a,'Zed');ok(await post(a,`organizations/${a.org}/schools/${a.school}/people/${zed.person}/tags`,{tag:'Loop'},C.CONTACT_TAG_ADD_COMMAND));
 for(let i=0;i<3;i++){await consume();await drain();}
 assert.equal((await runsOf(looper.workflowId,zed.person)).length,1);
 const child=await create(a,'Chain child',def({kind:'MEMBERSHIP_CANCELLED',config:{}},[{id:'stop',type:'STOP'}]));
 const parentWf=await create(a,'Chain parent',def({kind:'TAG_ADDED',config:{tag:'chain'}},[{id:'go',type:'START_WORKFLOW',workflowId:child.workflowId,next:null}]));
 const childV2=C.verifyAutomationWorkflowDetail(ok(await post(a,base(a)+'/'+child.workflowId+'/versions',{expectedRevision:child.revision,name:'Chain child',definition:def({kind:'MEMBERSHIP_CANCELLED',config:{}},[{id:'back',type:'START_WORKFLOW',workflowId:parentWf.workflowId,next:null}])},C.AUTOMATION_SAVE_COMMAND))).workflow;
 r=await post(a,base(a)+'/'+parentWf.workflowId+'/activate',{expectedRevision:parentWf.revision,version:1},C.AUTOMATION_ACTIVATE_COMMAND);ok(r);
 ok(await activate(a,childV2,2));
 ok(await post(a,`organizations/${a.org}/schools/${a.school}/people/${zed.person}/tags`,{tag:'chain'},C.CONTACT_TAG_ADD_COMMAND));
 await consume();await drain();
 const [pRun]=await runsOf(parentWf.workflowId,zed.person),[cRun]=await runsOf(child.workflowId,zed.person);
 assert.equal(cRun.parent_run_id,pRun.id);assert.equal(cRun.depth,1);assert.equal(cRun.trigger_key,'run:'+pRun.id);
 assert.deepEqual((await stepsOf(pRun.id)).map(s=>s.outcome_code),['WORKFLOW_STARTED']);assert.deepEqual((await stepsOf(cRun.id)).map(s=>s.outcome_code),['CHAIN_LIMIT']);
 assert.equal((await runsOf(parentWf.workflowId,zed.person)).length,1);
 const selfRef=await create(a,'Self',def(lead(),[{id:'stop',type:'STOP'}]));
 const selfV2=C.verifyAutomationWorkflowDetail(ok(await post(a,base(a)+'/'+selfRef.workflowId+'/versions',{expectedRevision:selfRef.revision,name:'Self',definition:def(lead(),[{id:'go',type:'START_WORKFLOW',workflowId:selfRef.workflowId,next:null}])},C.AUTOMATION_SAVE_COMMAND))).workflow;
 r=await activate(a,selfV2,2);assert.equal(r.status,422);assert.equal(r.body.code,'AUTOMATION_REFERENCE_INVALID');
 pass('a tag added by a workflow never restarts that workflow; a chain that would start a workflow already in it stops (CHAIN_LIMIT); a workflow cannot start itself');

 // 10. A step error fails only that run; at 20% of the last finished steps (with at least ten) the workflow pauses itself.
 const tasks=await on(a,'Tasks',def({kind:'TAG_ADDED',config:{tag:'task me'}},[{id:'task',type:'CREATE_TASK',title:'Follow up {{first_name}}',details:'',dueInHours:0,assignTo:'SCHOOL_OWNERS',next:null}]));
 // Fixture-only fault: refuse this workflow's work items so each run's one step errors.
 await q(`CREATE FUNCTION hon.au2_fixture_fault() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.title LIKE 'Follow up %' THEN RAISE EXCEPTION 'FIXTURE_FAULT'; END IF; RETURN NEW; END $f$`);
 await q('CREATE TRIGGER au2_fixture_fault BEFORE INSERT ON hon.work_items FOR EACH ROW EXECUTE FUNCTION hon.au2_fixture_fault()');
 try{
  for(let i=0;i<10;i++){const p=await contact(a,'Ten'+String.fromCharCode(97+i));ok(await post(a,`organizations/${a.org}/schools/${a.school}/people/${p.person}/tags`,{tag:'Task me'},C.CONTACT_TAG_ADD_COMMAND));}
  await consume();d=await drain();assert.equal(d.failed,10);assert.equal(d.paused,1);
 }finally{await q('DROP TRIGGER au2_fixture_fault ON hon.work_items');await q('DROP FUNCTION hon.au2_fixture_fault()');}
 assert.deepEqual(await wfRow(tasks.workflowId).then(x=>[x.status,x.paused_reason]),['PAUSED','FAILURE_RATE']);
 for(const x of await runsOf(tasks.workflowId)){assert.equal(x.status,'FAILED');assert.equal(x.end_code,'STEP_FAILED');assert.deepEqual((await stepsOf(x.id)).map(s=>s.status+':'+s.outcome_code),['FAILED:STEP_ERROR']);}
 assert.equal((await q("SELECT count(*) n FROM hon.work_items WHERE organization_id=$1 AND title LIKE 'Follow up %'",[a.org]))[0].n,'0');
 pass('an error in a step fails that run only (nothing it wrote is kept); ten failures out of ten finished steps pause the workflow (FAILURE_RATE)');

 // 10b. Stage moves are audited per lead; one event that cannot be processed is receipted as failed and blocks nothing behind it.
 const mover=await on(a,'Move stage',def({kind:'TAG_ADDED',config:{tag:'move me'}},[{id:'move',type:'MOVE_STAGE',stageId:a.stage2,next:null}]));
 const mo=await contact(a,'Mo'),bad=await contact(a,'Badevent');
 ok(await post(a,`organizations/${a.org}/schools/${a.school}/people/${bad.person}/tags`,{tag:'Move me'},C.CONTACT_TAG_ADD_COMMAND));
 ok(await post(a,`organizations/${a.org}/schools/${a.school}/people/${mo.person}/tags`,{tag:'Move me'},C.CONTACT_TAG_ADD_COMMAND));
 // Fixture-only fault: starting a run for this one contact errors.
 await q(`CREATE FUNCTION hon.au2_event_fault() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.person_id='${bad.person}' THEN RAISE EXCEPTION 'FIXTURE_FAULT'; END IF; RETURN NEW; END $f$`);
 await q('CREATE TRIGGER au2_event_fault BEFORE INSERT ON hon.automation_runs FOR EACH ROW EXECUTE FUNCTION hon.au2_event_fault()');
 try{c=await consume();}finally{await q('DROP TRIGGER au2_event_fault ON hon.automation_runs');await q('DROP FUNCTION hon.au2_event_fault()');}
 assert.equal(c.failed,1);assert.equal(c.runsStarted,1);
 const badReceipt=(await q("SELECT r.runs_started,r.failure_code FROM hon.automation_event_receipts r JOIN hon.outbox_events e ON e.id=r.outbox_event_id WHERE e.aggregate_id=$1 AND e.event_type='contact.tag.added'",[bad.person]))[0];
 assert.deepEqual(badReceipt,{runs_started:0,failure_code:'EVENT_ERROR'});
 assert.equal((await runsOf(mover.workflowId,bad.person)).length,0);
 await drain();
 assert.equal((await q('SELECT pipeline_stage_id s FROM hon.crm_leads WHERE id=$1',[mo.lead]))[0].s,a.stage2);
 const [moRun]=await runsOf(mover.workflowId,mo.person);
 const moved=await q("SELECT actor_principal_id a,source,entity_type,entity_id,prior_state,next_state FROM hon.audit_events WHERE action_code='crm.lead.stage_moved' AND entity_id=$1",[mo.lead]);
 assert.equal(moved.length,1);assert.equal(moved[0].a,AUTOMATION);assert.equal(moved[0].source,'AUTOMATION');assert.equal(moved[0].entity_type,'CRM_LEAD');
 assert.equal(moved[0].prior_state.stageId,a.stage);assert.equal(moved[0].next_state.stageId,a.stage2);assert.equal(moved[0].next_state.automationRunId,moRun.id);
 assert.equal(moved[0].next_state.workflowId,mover.workflowId);
 // A workflow locked by a staff command is skipped, never waited on (no lock-order deadlock with archive); its step stays due.
 const lockedWf=await on(a,'Locked',def({kind:'TAG_ADDED',config:{tag:'lock me'}},[{id:'stop',type:'STOP'}]));
 const lo=await contact(a,'Lo');ok(await post(a,`organizations/${a.org}/schools/${a.school}/people/${lo.person}/tags`,{tag:'lock me'},C.CONTACT_TAG_ADD_COMMAND));
 await consume();const [loRun]=await runsOf(lockedWf.workflowId,lo.person);
 const holder=new pg.Client({connectionString:owner.toString(),ssl:false});await holder.connect();
 try{await holder.query('BEGIN');await holder.query('SELECT 1 FROM hon.automation_workflows WHERE id=$1 FOR UPDATE',[lockedWf.workflowId]);
  await admin.query("SET statement_timeout='5s'");try{await runDue();}finally{await admin.query('RESET statement_timeout');}
  assert.equal((await stepsOf(loRun.id))[0].status,'PENDING');}
 finally{await holder.query('ROLLBACK').catch(()=>{});await holder.end();}
 await drain();assert.equal((await stepsOf(loRun.id))[0].outcome_code,'STOPPED');
 pass('each automated stage move writes one identifier-only audit row (prior and next stage, run and workflow); an event that errors is receipted EVENT_ERROR with nothing kept and the next event still starts its run; a workflow locked by a staff command is skipped without waiting');

 // 11. Other schools: events of school B never start school A's workflows; B cannot read A's runs; A's history reads through the API.
 const bob=await contact(b,'Bob');await event(b,'crm.lead.created',bob.lead);
 c=await consume();assert.equal(c.consumed,0);
 assert.equal((await q('SELECT count(*) n FROM hon.automation_runs WHERE person_id=$1',[bob.person]))[0].n,'0');
 const list=C.verifyAutomationRunList(ok(await send(base(a)+'/'+welcome.workflowId+'/runs',{identity:a})));
 const dbRuns=await runsOf(welcome.workflowId);assert.equal(list.runs.length,dbRuns.length);
 assert.deepEqual(list.counts,{running:dbRuns.filter(x=>x.status==='RUNNING').length,completed:1,exited:0,failed:0});assert(list.counts.running>=5);
 const patRun=list.runs.find(x=>x.personId===pat.person);assert.equal(patRun.contactFirstName,'Pat');
 const detail=C.verifyAutomationRunDetail(ok(await send(base(a)+'/runs/'+patRun.runId,{identity:a})));
 assert.deepEqual(detail.steps.map(s=>s.stepId+':'+s.outcome),['welcome:QUEUED','tag:TAG_ADDED','wait:WAITED','check:CONDITION_YES','task:TASK_CREATED','mail:QUEUED']);
 assert.equal(detail.steps[0].messageId,text.id);assert.notEqual(detail.steps[0].deliveryStatus,null);
 assert.equal(detail.steps[4].workItemId,task.id);assert.equal(detail.steps[2].branch,null);assert.equal(detail.steps[3].branch,'YES');
 assert(!/welcome to Synthetic|See you on the mat|Synthetic Pat|example\.invalid|\+1555/.test(JSON.stringify(detail)),'message text, surname or address leaked');
 for(const path of [base(b)+'/runs/'+patRun.runId,`organizations/${a.org}/schools/${b.school}/automations/runs/${patRun.runId}`])assert.notEqual((await send(path,{identity:b})).status,200);
 assert.equal((await send(base(b)+'/'+welcome.workflowId+'/runs',{identity:b})).status,404);
 assert.equal((await send(base(a)+'/runs/'+K(),{identity:a})).status,404);
 pass('another school\'s events start nothing here and it cannot read this school\'s runs; run list counts and step history (outcomes, branch, message and task ids, delivery status, first name only, no message text) read through the API');

 // 12. Archiving a paused workflow cancels its open runs and clears its activation.
 const hold=await on(a,'Hold',def(lead(),[{id:'wait',type:'WAIT',minutes:600,localTime:null,next:'text'},sms('text',null)]));
 const dee=await contact(a,'Dee');await event(a,'crm.lead.created',dee.lead);await consume();await drain();
 const [deeRun]=await runsOf(hold.workflowId,dee.person);
 let held=C.verifyAutomationWorkflowDetail(ok(await pause(a,hold))).workflow;
 const archived=C.verifyAutomationWorkflowDetail(ok(await post(a,base(a)+'/'+hold.workflowId+'/archive',{expectedRevision:held.revision},C.AUTOMATION_ARCHIVE_COMMAND))).workflow;
 assert.equal(archived.status,'ARCHIVED');assert.equal(archived.activeVersion,null);
 const [cancelled]=await q('SELECT * FROM hon.automation_runs WHERE id=$1',[deeRun.id]);assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.end_code,'WORKFLOW_ARCHIVED');
 assert.deepEqual((await stepsOf(deeRun.id)).map(s=>s.status+':'+s.outcome_code),['SKIPPED:WORKFLOW_ARCHIVED']);
 r=await post(a,base(a)+'/'+welcome.workflowId+'/archive',{expectedRevision:(await wfRow(welcome.workflowId)).revision},C.AUTOMATION_ARCHIVE_COMMAND);assert.equal(r.status,409);assert.equal(r.body.code,'AUTOMATION_NOT_DRAFT');
 r=await activate(a,archived,1);assert.equal(r.status,409);
 pass('archiving a paused workflow cancels its open runs (WORKFLOW_ARCHIVED) and clears activation; an ON workflow must be paused first; an archived one never turns on');

 // 13. Evidence guard: receipts, finished runs and finished steps never change or disappear.
 await assert.rejects(q('DELETE FROM hon.automation_event_receipts WHERE outbox_event_id=$1',[e1]),/AUTOMATION_HISTORY_IMMUTABLE/);
 await assert.rejects(q('UPDATE hon.automation_event_receipts SET runs_started=5 WHERE outbox_event_id=$1',[e1]),/AUTOMATION_HISTORY_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.automation_runs SET status='RUNNING',ended_at=NULL,version=version+1 WHERE id=$1",[run.id]),/AUTOMATION_HISTORY_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.automation_run_steps SET outcome_code='X' WHERE run_id=$1",[run.id]),/AUTOMATION_HISTORY_IMMUTABLE/);
 await assert.rejects(q('DELETE FROM hon.automation_runs WHERE id=$1',[run.id]),/AUTOMATION_HISTORY_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.automation_runs SET person_id=$2,version=version+1 WHERE id=$1",[anaRun.id,ben.person]),/AUTOMATION_HISTORY_IMMUTABLE/);
 for(const t of ['automation_event_receipts','automation_runs','automation_run_steps'])await assert.rejects(q(`TRUNCATE hon.${t} CASCADE`),/AUTOMATION_HISTORY_IMMUTABLE|cannot truncate/);
 pass('event receipts, finished runs and finished steps cannot be edited, reopened, moved or deleted');
 // 14. The canonical 011 exact verification for 0416 and 0423 passes on this database and refuses drift.
 const verify=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
 const section=(begin,end)=>{const x=verify.split(begin)[1]?.split(end)[0];assert(x,begin);return x.replace(/^[^\n]*\n/,'').replaceAll('hon_runtime',runtime.username);};
 const s367=section('-- Automation workflows and contact tags exact verification (AU-1 0416)','-- End automation workflows and contact tags exact verification.');
 const s368=section('-- Automation engine exact verification (AU-2 0423)','-- End automation engine exact verification.');
 await admin.query(s367);await admin.query(s368);
 for(const [drift,pattern] of [
  [`GRANT EXECUTE ON FUNCTION hon.consume_automation_events(integer) TO ${runtime.username}`,/Unsafe automation engine function/],
  ['ALTER TABLE hon.automation_runs DISABLE TRIGGER guarded',/guard triggers/],
  ['ALTER TABLE hon.automation_run_steps NO FORCE ROW LEVEL SECURITY',/Unsafe automation engine table/],
  [`GRANT SELECT ON hon.automation_event_receipts TO ${runtime.username}`,/Unsafe automation engine table/]]){
  await admin.query('BEGIN');try{await admin.query(drift);await assert.rejects(admin.query(s368),pattern);}finally{await admin.query('ROLLBACK');}
  await admin.query(s368);
 }
 pass('the canonical 011 exact verification for 0416 and 0423 passes here and refuses a runtime engine grant, a disabled guard, unforced RLS and a table grant');
 console.log('PASS: automation engine (0423), '+groups+' groups');
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end()]);}
