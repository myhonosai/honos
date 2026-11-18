/** School conversations (0364, Conversation AI CA1): signed inbound texts through the 0243 worker login, then real signed HON
 *  sessions -> Nest/guards -> fixed runtime SQL for the staff inbox, on the marked disposable communication delivery database.
 *  Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point. Nothing is sent anywhere: a reply only queues a
 *  0047 message, and the proof claims it as the 0243 worker to show who it would go to. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??''),workerUrl=new URL(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_comm_delivery_owner'],[runtime,'hon_comm_delivery_runtime'],[workerUrl,'hon_comm_delivery_worker']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_comm_delivery_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|SENDGRID.*|ZERNIO.*|OPENAI.*|OPENROUTER.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|ZERNIO).*)$/i.test(key),key);
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const CC=require('./dist/conversations/school-conversations.controller.js');
const {SchoolConversationsService}=require('./dist/conversations/school-conversations.service.js');
const {CommunicationWorkerDatabase}=require('./dist/communication/delivery/communication-worker-database.js');
const C=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),worker=new pg.Client({connectionString:workerUrl.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'conversations-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const store=new CommunicationWorkerDatabase();
const pass=name=>console.log('PASS CONVERSATIONS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command=C.CONVERSATION_READ_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':command,...(method==='POST'?{'content-type':'application/json',...(key===null?{}:{'idempotency-key':key})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const human=label=>({externalSubject:'oidc:conv:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=human(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:C.SIGNUP_CONFIRMATION},K()])).rows[0].data;
 const principal=(await q('SELECT p.id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE u.external_subject=$1',[p.externalSubject]))[0].id;
 return {...p,org:r.organizationId,school:r.schoolId,principal};}
async function staff(x,label,permissions){const p=human(label);const user=K(),principal=K(),role=K();
 await q('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)',[user,p.externalSubject,p.email,'Coach '+label]);
 await q("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)",[principal,user,'Coach '+label]);
 await q('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)',[role,x.org,'STAFF_'+role.slice(0,8)]);
 for(const code of permissions)await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[role,x.org,code]);
 const grant=K();await q("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')",[grant,x.org,x.school,principal,role]);
 return {...p,org:x.org,school:x.school,principal,grant};}
const setAccess=(x,status)=>q("UPDATE hon.organization_entitlements SET status=$2,effective_from=clock_timestamp()-interval '1 day',effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1",[x.org,status]);
const sid=()=>'SM'+createHash('md5').update(K()).digest('hex');
const inbound=(to,from,body,{media=0,id=sid(),at=new Date().toISOString()}={})=>store.recordInboundConversationText({to,from,body,mediaCount:media,providerMessageId:id,receivedAt:at});
const base=x=>`organizations/${x.org}/schools/${x.school}/conversations`;
const list=async(x,params={})=>C.verifyConversationList(ok(await send(base(x)+(Object.keys(params).length?'?'+new URLSearchParams(params):''),{identity:x})));
const detail=async(x,id,before)=>C.verifyConversationDetail(ok(await send(base(x)+'/'+id+(before?'?before='+before:''),{identity:x})),id);
const cmd=(x,id,path,command,body,extra={})=>send(base(x)+'/'+id+'/'+path,{identity:x,method:'POST',command,body,...extra});
const reply=(x,id,body,extra)=>cmd(x,id,'replies',C.CONVERSATION_REPLY_COMMAND,body,extra);
const update=(x,id,body,extra)=>cmd(x,id,'update',C.CONVERSATION_UPDATE_COMMAND,body,extra);
const link=(x,id,body,extra)=>cmd(x,id,'link',C.CONVERSATION_LINK_COMMAND,body,extra);
const lead=(x,id,body,extra)=>cmd(x,id,'lead',C.CONVERSATION_CREATE_LEAD_COMMAND,body,extra);
const markRead=(x,id,body)=>cmd(x,id,'read',C.CONVERSATION_MARK_READ_COMMAND,body,{key:null});
const conv=async id=>(await q('SELECT * FROM hon.school_conversations WHERE id=$1',[id]))[0];

try{
 await Promise.all([admin.connect(),restricted.connect(),worker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable communication delivery validation');
 // 1. Custody: forced deny-all RLS, no table privilege, runtime exactly the seven staff entry points, worker exactly the intake.
 for(const t of ['school_conversations','school_conversation_messages']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const role of [runtime.username,workerUrl.username])for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
   assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[role,'hon.'+t,p]))[0].ok,false,role+':'+t+':'+p);
 }
 const runtimeEntry=['read_school_conversations','read_school_conversation','reply_school_conversation','update_school_conversation','mark_school_conversation_read','link_school_conversation','create_school_conversation_lead'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%conversation%' AND p.proname NOT LIKE '%hon_conversation%' AND p.proname NOT LIKE 'hq_%' AND p.proname NOT LIKE '%social%' AND p.proname NOT LIKE '%conversation_ai%') AND p.oid>=(SELECT oid FROM pg_proc WHERE proname='conversation_body_ok')");
 assert.equal(fns.length,22,fns.map(f=>f.proname).join());
 for(const f of fns){
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,runtimeEntry.includes(f.proname),'runtime '+f.proname);
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[workerUrl.username,f.oid]))[0].ok,f.proname==='record_inbound_conversation_text','worker '+f.proname);
 }
 await assert.rejects(restricted.query("SELECT * FROM hon.record_inbound_conversation_text('+15550000001','+15550000002','x',0,$1,now())",[sid()]),/permission denied/);
 await assert.rejects(worker.query('SELECT hon.read_school_conversations($1,$2::jsonb)',['x','{}']),/permission denied/);
 pass('forced deny-all RLS on both tables; the runtime executes exactly seven staff entry points and the worker only the intake; neither has a table privilege');

 const module=await Test.createTestingModule({controllers:[CC.SchoolConversationsController],providers:[SchoolConversationsService,CC.ConversationReadGuard,CC.ConversationReplyGuard,CC.ConversationUpdateGuard,CC.ConversationMarkReadGuard,CC.ConversationLinkGuard,CC.ConversationCreateLeadGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 for(const x of [a,b]){await setAccess(x,'ACTIVE');
  assert.equal((await q("SELECT count(*) n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.code='OWNER' AND r.is_system_role AND rp.permission_code IN ('conversation.read','conversation.manage')",[x.org]))[0].n,'2');}
 const numA='+15125550100',numB='+15125550200',numOff='+15125550300';
 const msid=()=>'MG'+createHash('md5').update(K()).digest('hex');
 await q("INSERT INTO hon.school_text_senders(organization_id,school_id,phone_e164,messaging_service_sid,status,mms_converter_confirmed,set_by_principal_id) VALUES($1,$2,$3,$4,'ACTIVE',true,$5),($6,$7,$8,$9,'ACTIVE',true,$10)",
  [a.org,a.school,numA,msid(),a.principal,b.org,b.school,numB,msid(),b.principal]);
 const c=await register('gamma');await setAccess(c,'ACTIVE');
 await q("INSERT INTO hon.school_text_senders(organization_id,school_id,phone_e164,messaging_service_sid,status,mms_converter_confirmed,set_by_principal_id) VALUES($1,$2,$3,$4,'DISABLED',true,$5)",[c.org,c.school,numOff,msid(),c.principal]);
 const pipeline=K(),stage=K(),won=K();
 await q("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Inquiries')",[pipeline,a.org,a.school]);
 await q("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)",[stage,a.org,a.school,pipeline]);
 await q("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',2,'WON')",[won,a.org,a.school,pipeline]);
 const ada=K(),twinA=K(),twinB=K(),adaLeadOld=K(),adaLead=K();
 await q("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,phone_e164) VALUES($1,$2,$3,'Ada','Parent','+15125551001'),($4,$2,$3,'Twin','One','+15125551002'),($5,$2,$3,'Twin','Two','+15125551002')",[ada,a.org,a.school,twinA,twinB]);
 await q("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,created_at) VALUES($1,$2,$3,$4,$5,$6,'OPEN',now()-interval '2 days'),($7,$2,$3,$4,$5,$6,'OPEN',now())",[adaLeadOld,a.org,a.school,ada,pipeline,stage,adaLead]);
 // Ada's mobile also belongs to someone at school B: matching never crosses schools.
 await q("INSERT INTO hon.people(organization_id,school_id,given_name,family_name,phone_e164) VALUES($1,$2,'Other','School','+15125551001')",[b.org,b.school]);

 // 2. Intake routing: unknown and disabled numbers and lapsed schools store nothing; keywords and blanks are not messages.
 const before=(await q('SELECT count(*) n FROM hon.school_conversation_messages'))[0].n;
 let r=await inbound('+15125559999','+15125551001','hello');assert.equal(r.outcome,'UNROUTED');
 r=await inbound(numOff,'+15125551001','hello');assert.equal(r.outcome,'UNROUTED');
 for(const word of ['STOP','stop.','HELP','Start!'])assert.equal((await inbound(numA,'+15125551001',word)).outcome,'KEYWORD',word);
 assert.equal((await inbound(numA,'+15125551001',' \n\t ')).outcome,'EMPTY');
 await setAccess(a,'SUSPENDED');assert.equal((await inbound(numA,'+15125551001','hello')).outcome,'UNROUTED');await setAccess(a,'ACTIVE');
 await q("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1",[b.school]);assert.equal((await inbound(numB,'+15125551001','hello')).outcome,'UNROUTED');
 await q("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1",[b.school]);
 assert.equal((await q('SELECT count(*) n FROM hon.school_conversation_messages'))[0].n,before);
 await assert.rejects(inbound(numA,'not-a-number','x'),/invalid/);
 await assert.rejects(inbound(numA,'+15125551001','x',{id:'SMnot'}),/invalid/);
 await assert.rejects(inbound(numA,'+15125551001','x'.repeat(1601)),/invalid/);
 await assert.rejects(inbound(numA,'+15125551001','x',{at:new Date(Date.now()-8*86_400_000).toISOString()}),/invalid/);
 pass('unknown or disabled numbers, suspended entitlement or school store nothing (UNROUTED); STOP/START/HELP stay keywords and blank texts are dropped; malformed intake is refused');

 // 3. Matching: one person links that person and their newest OPEN lead; two people link nobody; unknown numbers link nobody.
 const t0=Date.now();
 const sAda=sid();r=await inbound(numA,'+15125551001','Hi, my 5 year old wants karate. How much?\nThanks',{id:sAda});assert.equal(r.outcome,'RECORDED');
 const convAda=r.conversationId;
 assert.deepEqual(await inbound(numA,'+15125551001','Hi again',{id:sAda}),{outcome:'REPLAYED',conversationId:convAda});
 let row=await conv(convAda);assert.deepEqual([row.person_id,row.lead_id,row.unread,row.status,row.version],[ada,adaLead,1,'OPEN',2]);
 const convTwin=(await inbound(numA,'+15125551002','Do you have adult classes?')).conversationId;
 row=await conv(convTwin);assert.deepEqual([row.person_id,row.lead_id],[null,null]);
 const convNew=(await inbound(numA,'+15125557777','',{media:2})).conversationId;
 row=await conv(convNew);assert.deepEqual([row.person_id,row.lead_id,row.contact_address],[null,null,'+15125557777']);
 const convB=(await inbound(numB,'+15125551001','Hello B')).conversationId;
 row=await conv(convB);assert.notEqual(row.person_id,ada);assert.equal(row.school_id,b.school);
 assert.equal((await inbound(numA,'+15125551001','Second text\u0007')).conversationId,convAda);
 row=await conv(convAda);assert.equal(row.unread,2);
 assert.equal((await q("SELECT body FROM hon.school_conversation_messages WHERE conversation_id=$1 ORDER BY occurred_at DESC LIMIT 1",[convAda]))[0].body,'Second text','control characters are dropped');
 assert.equal((await q("SELECT count(*) n FROM hon.outbox_events WHERE event_type='conversation.message.received' AND aggregate_id=$1",[convAda]))[0].n,'2');
 const ev=(await q("SELECT payload FROM hon.outbox_events WHERE event_type='conversation.message.received' AND aggregate_id=$1 ORDER BY occurred_at LIMIT 1",[convAda]))[0].payload;
 assert.deepEqual(Object.keys(ev).sort(),['channel','conversationId','leadId','messageId','newConversation','personId']);
 assert.equal((await q("SELECT count(*) n FROM hon.audit_events WHERE action_code='conversation.message.receive' AND entity_id=$1 AND actor_principal_id='00000000-0000-4000-8000-00000000c364'",[convAda]))[0].n,'2');
 pass('one person with the number links that person and their newest open lead; two people or none link nobody; other schools never match; replays and control characters handled; ids-only outbox and audit');

 // 4. Staff inbox: list, filters, search, keyset pages, thread, contact panel; other schools see nothing.
 let L=await list(a);assert.equal(L.conversations.length,3);assert.equal(L.unreadConversations,3);assert.equal(L.canManage,true);
 assert.deepEqual(L.conversations.map(x=>x.conversationId).sort(),[convAda,convTwin,convNew].sort());
 const adaRow=L.conversations.find(x=>x.conversationId===convAda);
 assert.deepEqual([adaRow.contactName,adaRow.leadStage,adaRow.leadStatus,adaRow.unread,adaRow.lastMessage.preview,adaRow.lastMessage.direction],['Ada Parent','New','OPEN',2,'Second text','INBOUND']);
 assert.deepEqual((await list(a,{search:'ada'})).conversations.map(x=>x.conversationId),[convAda]);
 assert.deepEqual((await list(a,{search:'7777'})).conversations.map(x=>x.conversationId),[convNew]);
 assert.equal((await list(a,{status:'CLOSED'})).conversations.length,0);
 assert.equal((await list(b)).conversations.length,1);
 let D=await detail(a,convAda);
 assert.deepEqual(D.messages.map(m=>m.body),['Hi, my 5 year old wants karate. How much?\nThanks','Second text']);
 assert.deepEqual([D.contact.person.givenName,D.contact.person.smsConsent,D.contact.lead.leadId,D.contact.lead.stage,D.contact.peopleWithNumber,D.contact.schoolCanText],['Ada','NONE',adaLead,'New',1,true]);
 assert.equal((await detail(a,convNew)).messages[0].mediaCount,2);
 r=await send(base(a)+'/'+convB,{identity:a});assert.equal(r.status,404);
 r=await send(base(b)+'/'+convAda,{identity:a});assert.equal(r.status,403);
 r=await send(base(a)+'?status=WHATEVER',{identity:a});assert.equal(r.status,400);
 r=await send(base(a)+'?owner=me',{identity:a});assert.equal(r.status,400);
 r=await send(base(a)+'?beforeAt=2026-01-01T00:00:00.000Z',{identity:a});assert.equal(r.status,400);
 // Keyset paging: 55 more contacts; page two continues exactly after page one.
 for(let i=0;i<55;i++)await inbound(numA,'+1512556'+String(1000+i),'Hello '+i,{at:new Date(t0-60_000-i*1000).toISOString()});
 const p1=await list(a);assert.equal(p1.conversations.length,50);assert(p1.nextCursor);
 const p2=await list(a,{beforeAt:p1.nextCursor.at,beforeId:p1.nextCursor.id});assert.equal(p2.conversations.length,8);assert.equal(p2.nextCursor,null);
 assert.equal(new Set([...p1.conversations,...p2.conversations].map(x=>x.conversationId)).size,58);
 // All 58 within one millisecond (sub-millisecond writes): stored to whole milliseconds, and the pages still split exactly by id.
 await q("UPDATE hon.school_conversations x SET last_message_at=(date_trunc('second',statement_timestamp())+interval '1 hour')+(r.n*interval '7 microseconds'),version=x.version+1 FROM (SELECT id,row_number() OVER (ORDER BY id) n FROM hon.school_conversations WHERE school_id=$1) r WHERE r.id=x.id",[a.school]);
 assert.equal((await q("SELECT count(DISTINCT last_message_at) n, bool_and(last_message_at=date_trunc('milliseconds',last_message_at)) ms FROM hon.school_conversations WHERE school_id=$1",[a.school]))[0].n,'1');
 const s1=await list(a);assert.equal(s1.conversations.length,50);
 const s2=await list(a,{beforeAt:s1.nextCursor.at,beforeId:s1.nextCursor.id});assert.equal(s2.conversations.length,8,'no conversation in the anchor millisecond is skipped');
 assert.equal(new Set([...s1.conversations,...s2.conversations].map(x=>x.conversationId)).size,58);
 await q('ALTER TABLE hon.school_conversations DISABLE TRIGGER school_conversations_guard');
 try{await assert.rejects(q("UPDATE hon.school_conversations SET last_message_at=last_message_at+interval '3 microseconds' WHERE school_id=$1",[a.school]),/check constraint/);}
 finally{await q('ALTER TABLE hon.school_conversations ENABLE TRIGGER school_conversations_guard');}
 pass('staff list newest first with unread counts, filters and search by name, digits or tag, exact keyset pages; thread oldest first with media counts and contact panel; other schools 404/403; strict queries');

 // 5. Permission split: read-only staff read but cannot change; no permission sees nothing; revoked and lapsed refused.
 const reader=await staff(a,'reader',['conversation.read']);const nobody=await staff(a,'nobody',['crm.lead.read']);
 assert.equal((await list(reader)).canManage,false);
 r=await update(reader,convAda,{expectedVersion:3,status:'CLOSED'});assert.equal(r.status,403);
 r=await send(base(nobody),{identity:nobody});assert.equal(r.status,403);
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[reader.grant]);
 r=await send(base(reader),{identity:reader});assert.equal(r.status,403);
 await q('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[reader.grant]);
 await setAccess(a,'SUSPENDED');r=await send(base(a),{identity:a});assert.equal(r.status,403);await setAccess(a,'ACTIVE');
 r=await send(base(a),{identity:a,headers:{'sec-fetch-site':'cross-site'}});assert.equal(r.status,403);
 r=await send(base(a),{identity:a,headers:{'x-hon-delegated-by-principal-id':K()}});assert.equal(r.status,403);
 pass('conversation.read reads only; conversation.manage needed to change; staff without either, revoked grants, suspended schools, cross-site and delegated calls refused');

 // 6. Assign, tag, close/reopen by version; replay and key reuse; inbound reopens a closed conversation.
 let v=(await conv(convAda)).version;
 const key=K();r=await update(a,convAda,{expectedVersion:v,assignedPrincipalId:reader.principal,tags:['trial','Kids 4-6']},{key});
 let U=C.verifyConversationUpdateReceipt(ok(r),convAda);assert.deepEqual([U.conversation.assignedTo.principalId,U.conversation.tags,U.conversation.version],[reader.principal,['trial','Kids 4-6'],v+1]);
 r=await update(a,convAda,{expectedVersion:v,assignedPrincipalId:reader.principal,tags:['trial','Kids 4-6']},{key});assert.equal(r.status,200);assert.equal(r.body.meta.replayed,true);
 r=await update(a,convAda,{expectedVersion:v,status:'CLOSED'},{key});assert.equal(r.status,409);assert.equal(r.body.code,'IDEMPOTENCY_KEY_REUSED');
 r=await update(a,convAda,{expectedVersion:v,status:'CLOSED'});assert.equal(r.status,409);assert.equal(r.body.code,'CONVERSATION_VERSION_CONFLICT');
 r=await update(a,convAda,{expectedVersion:v+1,assignedPrincipalId:nobody.principal});assert.equal(r.status,422);assert.equal(r.body.code,'CONVERSATION_ASSIGNEE_INVALID');
 r=await update(a,convAda,{expectedVersion:v+1,assignedPrincipalId:b.principal});assert.equal(r.status,422);
 for(const bad of [{expectedVersion:v+1},{expectedVersion:v+1,tags:['a','A']},{expectedVersion:v+1,tags:['x'.repeat(33)]},{expectedVersion:v+1,tags:[' lead']},{expectedVersion:v+1,status:'DELETED'},{expectedVersion:v+1,status:'OPEN',conversationId:convTwin}])
  {r=await update(a,convAda,bad);assert.equal(r.status,400,JSON.stringify(bad));}
 assert.deepEqual((await list(a,{tag:'kids 4-6'})).conversations.map(x=>x.conversationId),[convAda]);
 assert.deepEqual((await list(reader,{assigned:'ME'})).conversations.map(x=>x.conversationId),[convAda]);
 U=C.verifyConversationUpdateReceipt(ok(await update(a,convAda,{expectedVersion:v+1,status:'CLOSED',assignedPrincipalId:null})),convAda);
 assert.deepEqual([U.conversation.status,U.conversation.assignedTo],['CLOSED',null]);
 assert.equal((await list(a)).conversations.some(x=>x.conversationId===convAda),false);
 await inbound(numA,'+15125551001','Are you open Saturday?');assert.equal((await conv(convAda)).status,'OPEN');
 pass('assign to staff who can read (never outside staff or other schools), tags, close and reopen by version; exact replay, refused key reuse, strict bodies; a new text reopens a closed conversation');

 // 7. Mark read moves up to the loaded message only.
 D=await detail(a,convAda);const unread=D.conversation.unread;assert(unread>=3);
 const first=D.messages[0].messageId,last=D.messages.at(-1).messageId;
 let M=C.verifyConversationReadMark(ok(await markRead(reader,convAda,{throughMessageId:first})),convAda);assert.equal(M.unread,D.messages.length-1);
 await inbound(numA,'+15125551001','One more question');
 M=C.verifyConversationReadMark(ok(await markRead(a,convAda,{throughMessageId:last})),convAda);assert.equal(M.unread,1,'a text after the loaded message stays unread');
 r=await markRead(a,convAda,{throughMessageId:(await detail(a,convTwin)).messages[0].messageId});assert.equal(r.status,404);
 pass('mark read moves the unread count to the loaded message, never past it; a message of another conversation is refused');

 // 8. Reply: needs a linked person at this number with SMS consent and an active sender; queues exactly one 0047 SMS.
 v=(await conv(convTwin)).version;
 r=await reply(a,convTwin,{expectedVersion:v,body:'Yes! Adults train Mon/Wed 7pm.'});assert.equal(r.status,422);assert.equal(r.body.code,'CONVERSATION_NOT_LINKED');
 v=(await conv(convAda)).version;
 r=await reply(a,convAda,{expectedVersion:v,body:'Hi Ada! Kids classes are Tue/Thu 5pm.'});assert.equal(r.status,422);assert.equal(r.body.code,'CONVERSATION_CONSENT_REQUIRED');
 await q("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,'SMS','OPTED_IN','STAFF',now(),$4)",[a.org,a.school,ada,a.principal]);
 await q("UPDATE hon.school_text_senders SET status='DISABLED',version=version+1 WHERE school_id=$1",[a.school]);
 r=await reply(a,convAda,{expectedVersion:v,body:'Hi Ada! Kids classes are Tue/Thu 5pm.'});assert.equal(r.status,422);assert.equal(r.body.code,'CONVERSATION_NO_SENDER');
 await q("UPDATE hon.school_text_senders SET status='ACTIVE',version=version+1 WHERE school_id=$1",[a.school]);
 r=await reply(reader,convAda,{expectedVersion:v,body:'Hi Ada! Kids classes are Tue/Thu 5pm.'});assert.equal(r.status,403);
 const rk=K();r=await reply(a,convAda,{expectedVersion:v,body:'Hi Ada! Kids classes are Tue/Thu 5pm.'},{key:rk});
 const R=C.verifyConversationReplyReceipt(ok(r,201),{conversationId:convAda,body:'Hi Ada! Kids classes are Tue/Thu 5pm.'});
 assert.deepEqual([R.message.delivery,R.message.author,R.message.staffName,R.conversation.unread,R.conversation.version],['QUEUED','STAFF','Synthetic alpha',0,v+1]);
 r=await reply(a,convAda,{expectedVersion:v,body:'Hi Ada! Kids classes are Tue/Thu 5pm.'},{key:rk});assert.equal(r.status,200);assert.equal(r.body.meta.replayed,true);
 const queued=await q("SELECT recipient_person_id,channel::text,content,lifecycle::text,queued_by_principal_id FROM hon.communication_messages WHERE organization_id=$1",[a.org]);
 assert.equal(queued.length,1);assert.deepEqual(Object.values(queued[0]),[ada,'SMS','Hi Ada! Kids classes are Tue/Thu 5pm.','QUEUED',a.principal]);
 r=await reply(a,convAda,{expectedVersion:v,body:'Again'});assert.equal(r.status,409);
 for(const bad of [{expectedVersion:v+1,body:''},{expectedVersion:v+1,body:'x'.repeat(1601)},{expectedVersion:v+1,body:'bad\u0007'},{expectedVersion:v+1,body:'x',to:'+15550001111'}]){r=await reply(a,convAda,bad);assert.equal(r.status,400);}
 // The 0243 worker would send it to Ada's number with the reply text.
 const claimed=(await worker.query("SELECT * FROM hon.claim_communication_deliveries(ARRAY['SMS'],10,60)")).rows.filter(x=>x.organization_id===a.org);
 if(claimed.length){assert.equal(claimed.length,1);assert.equal(claimed[0].recipient_address,'+15125551001');assert.equal(claimed[0].content,'Hi Ada! Kids classes are Tue/Thu 5pm.');}
 D=await detail(a,convAda);assert.notEqual(D.messages.at(-1).delivery,null);
 assert.equal((await q("SELECT count(*) n FROM hon.outbox_events WHERE event_type='conversation.reply.queued' AND aggregate_id=$1",[convAda]))[0].n,'1');
 pass('a reply needs a link, SMS consent and an active sender (clear 422 codes); it queues exactly one SMS to the linked person with the staff text, replays exactly, refuses stale versions and bad text; the worker claims it for that number');

 // 9. Link and create lead.
 v=(await conv(convTwin)).version;
 r=await link(a,convTwin,{expectedVersion:v,personId:ada,leadId:null});assert.equal(r.status,422);assert.equal(r.body.code,'CONVERSATION_LINK_INVALID');
 r=await link(a,convTwin,{expectedVersion:v,personId:twinA,leadId:adaLead});assert.equal(r.status,422);
 let Lk=C.verifyConversationLinkReceipt(ok(await link(a,convTwin,{expectedVersion:v,personId:twinB,leadId:null})),convTwin);
 assert.deepEqual([Lk.conversation.personId,Lk.contact.person.familyName,Lk.contact.peopleWithNumber],[twinB,'Two',2]);
 v=(await conv(convNew)).version;
 const leadBody={expectedVersion:v,givenName:'Sam',familyName:'Lee',pipelineId:pipeline,stageId:stage};
 r=await lead(reader,convNew,leadBody);assert.equal(r.status,403);
 const noCrm=await staff(a,'manager-no-crm',['conversation.read','conversation.manage']);r=await lead(noCrm,convNew,leadBody);assert.equal(r.status,403,'creating a lead also needs crm.lead.create');
 r=await lead(a,convNew,{...leadBody,stageId:won});assert.equal(r.status,422);assert.equal(r.body.code,'CONVERSATION_PIPELINE_INVALID');
 Lk=C.verifyConversationLinkReceipt(ok(await lead(a,convNew,leadBody),201),convNew);
 assert.deepEqual([Lk.contact.person.givenName,Lk.contact.person.phone,Lk.contact.lead.source,Lk.contact.lead.stage],['Sam','+15125557777','CONVERSATION_SMS','New']);
 const newLead=(await q('SELECT attribution,source_code FROM hon.crm_leads WHERE id=$1',[Lk.conversation.leadId]))[0];
 assert.deepEqual(newLead.attribution,{source:'CONVERSATION',channel:'SMS',conversationId:convNew});
 assert.equal((await q("SELECT count(*) n FROM hon.outbox_events WHERE event_type='crm.lead.created' AND aggregate_id=$1",[Lk.conversation.leadId]))[0].n,'1');
 r=await lead(a,convNew,{...leadBody,expectedVersion:v+1});assert.equal(r.status,422);assert.equal(r.body.code,'CONVERSATION_ALREADY_LINKED');
 pass('link only a person of this school with this number (and their own lead); create a person and an OPEN CONVERSATION_SMS lead (needs crm.lead.create, open stage) with crm.lead.created; never twice');

 // 10. Evidence guards and rate limits.
 await assert.rejects(admin.query("UPDATE hon.school_conversation_messages SET body='changed' WHERE conversation_id=$1",[convAda]));
 await assert.rejects(admin.query('DELETE FROM hon.school_conversation_messages WHERE conversation_id=$1',[convAda]));
 await assert.rejects(admin.query('DELETE FROM hon.school_conversations WHERE id=$1',[convAda]),/never deleted/);
 await assert.rejects(admin.query("UPDATE hon.school_conversations SET contact_address='+15550009999',version=version+1 WHERE id=$1",[convAda]),/fixed/);
 await assert.rejects(admin.query('UPDATE hon.school_conversations SET person_id=NULL,lead_id=NULL,version=version+1 WHERE id=$1',[convAda]),/fixed/);
 await assert.rejects(admin.query('TRUNCATE hon.school_conversation_messages'));
 let limited=0;for(let i=0;i<35;i++)if((await inbound(numA,'+15125558888','spam '+i)).outcome==='RATE_LIMITED')limited++;
 assert.equal(limited,5,'30 per conversation an hour');
 const convSpam=(await q("SELECT id FROM hon.school_conversations WHERE contact_address='+15125558888'"))[0].id;
 assert.equal((await q("SELECT count(*) n FROM hon.school_conversation_messages WHERE conversation_id=$1",[convSpam]))[0].n,'30');
 pass('messages are append-only, conversations never deleted and keep their address and link, no truncation; 30 texts per conversation an hour are stored and the rest refused');
 // 11. The canonical 011 exact verification section passes here with the fixture's runtime and worker roles, and catches drift.
 {const verify=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const section=verify.split('-- School conversations exact verification (0364)')[1]?.split('-- End school conversations exact verification.')[0];
  assert(section,'011 section');
  const body=section.replace(/^[^\n]*\n[^\n]*\n/,'').replaceAll('hon_communication_worker',workerUrl.username).replaceAll('hon_runtime',runtime.username);
  await q(body);
  await q(`GRANT EXECUTE ON FUNCTION hon.conversation_lock(uuid,integer) TO ${runtime.username}`);
  await assert.rejects(q(body),/Unsafe school conversation function: hon.conversation_lock/);
  await q(`REVOKE EXECUTE ON FUNCTION hon.conversation_lock(uuid,integer) FROM ${runtime.username}`);
  await q(`GRANT EXECUTE ON FUNCTION hon.reply_school_conversation(text,jsonb,text,uuid,uuid) TO ${workerUrl.username}`);
  await assert.rejects(q(body),/Unsafe school conversation function: hon.reply_school_conversation/);
  await q(`REVOKE EXECUTE ON FUNCTION hon.reply_school_conversation(text,jsonb,text,uuid,uuid) FROM ${workerUrl.username}`);
  await q(body);}
 pass('the canonical 011 verification of the 0364 functions, ACLs and tables passes and refuses an extra runtime or worker grant');
 console.log(`School conversations (0364): ${groups} proof groups passed.`);
}finally{
 if(app)await app.close().catch(()=>{});else await database.onModuleDestroy?.()?.catch?.(()=>{});
 await Promise.resolve(store.onModuleDestroy?.()).catch(()=>{});
 await Promise.allSettled([admin.end(),restricted.end(),worker.end()]);
}
