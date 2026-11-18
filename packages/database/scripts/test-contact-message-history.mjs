/** Contact message history (0424, Conversation AI CA1b): real signed HON sessions -> Nest/guards -> fixed runtime SQL for one
 *  person's message history, the exact email view and "Resend to saved address", on the marked disposable communication delivery
 *  database. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point. Nothing is sent anywhere: a resend only
 *  queues a 0047 message, and the proof claims it as the 0243 worker to show the subject and body it would carry. */
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
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|SENDGRID.*|ZERNIO.*|OPENAI.*|OPENROUTER.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|ZERNIO|EMAIL).*)$/i.test(key),key);
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const MC=require('./dist/conversations/contact-messages.controller.js');
const {ContactMessagesService}=require('./dist/conversations/contact-messages.service.js');
const {CommunicationWorkerDatabase}=require('./dist/communication/delivery/communication-worker-database.js');
const {SendGridEmailProvider}=require('./dist/communication/delivery/sendgrid-email-provider.js');
const C=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),worker=new pg.Client({connectionString:workerUrl.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'contact-history-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const store=new CommunicationWorkerDatabase();
const pass=name=>console.log('PASS CONTACT HISTORY '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command=C.CONTACT_HISTORY_READ_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':command,...(method==='POST'?{'content-type':'application/json',...(key===null?{}:{'idempotency-key':key})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const human=label=>({externalSubject:'oidc:hist:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
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
 return {...p,org:x.org,school:x.school,principal,grant,role};}
const setAccess=(x,status)=>q("UPDATE hon.organization_entitlements SET status=$2,effective_from=clock_timestamp()-interval '1 day',effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1",[x.org,status]);
const sid=()=>'SM'+createHash('md5').update(K()).digest('hex');
const base=(x,person)=>`organizations/${x.org}/schools/${x.school}/people/${person}/messages`;
const history=async(x,person,params={})=>C.verifyContactHistory(ok(await send(base(x,person)+(Object.keys(params).length?'?'+new URLSearchParams(params):''),{identity:x})),person);
const email=async(x,person,id)=>C.verifyContactEmailView(ok(await send(base(x,person)+'/'+id+'/email',{identity:x})),{personId:person,messageId:id});
const resend=(x,person,id,extra={})=>send(base(x,person)+'/'+id+'/resend',{identity:x,method:'POST',command:C.CONTACT_EMAIL_RESEND_COMMAND,body:{},...extra});
const consent=(x,person,channel,status)=>q("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,$4,$5,'STAFF',clock_timestamp(),$6) ON CONFLICT (person_id,channel) DO UPDATE SET status=EXCLUDED.status,version=hon.communication_consents.version+1,updated_at=clock_timestamp()",[x.org,x.school,person,channel,status,x.principal]);
const message=async(x,person,{channel='EMAIL',content='Hello',subject=null,origin='STAFF',originId=null,lifecycle='QUEUED',at=null}={})=>(await q(
 `INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,lifecycle,created_by_principal_id,queued_by_principal_id,origin_kind,origin_id,email_subject,created_at)
  VALUES($1,$2,$3,$4,$5,$6::text::hon.communication_message_lifecycle,$7,CASE WHEN $6::text='DRAFT' THEN NULL ELSE $7::uuid END,$8,$9,$10,coalesce($11::timestamptz,now())) RETURNING id`,[x.org,x.school,person,channel,content,lifecycle,x.principal,origin,originId,subject,at]))[0].id;

try{
 await Promise.all([admin.connect(),restricted.connect(),worker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable communication delivery validation');
 // 1. Custody.
 {const c=(await q("SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid='hon.communication_message_resends'::regclass"))[0];assert(c.rls&&c.forced);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename='communication_message_resends'"))[0].n,'0');
  for(const role of [runtime.username,workerUrl.username])for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
   assert.equal((await q("SELECT has_table_privilege($1,'hon.communication_message_resends',$2) ok",[role,p]))[0].ok,false,role+':'+p);
  const entry=['read_contact_message_history','read_contact_message_email','resend_contact_message_email'];
  const fns=await q("SELECT p.oid,p.proname FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND (p.proname LIKE 'contact_message%' OR p.proname LIKE 'contact_email%' OR p.proname IN ('read_contact_message_history','read_contact_message_email','resend_contact_message_email','require_contact_resend_actor','communication_email_subject'))");
  assert.equal(fns.length,12,fns.map(f=>f.proname).join());
  for(const f of fns){
   assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry.includes(f.proname),'runtime '+f.proname);
   assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[workerUrl.username,f.oid]))[0].ok,f.proname==='communication_email_subject','worker '+f.proname);
  }
  await assert.rejects(restricted.query('SELECT hon.communication_email_subject($1,$2)',[K(),K()]),/permission denied/);
  await assert.rejects(worker.query('SELECT hon.read_contact_message_history($1,$2,$3::jsonb)',['x',K(),'{}']),/permission denied/);}
 pass('forced deny-all RLS on the resend table; the runtime executes exactly the three staff entry points and the worker only the subject lookup; neither has a table privilege');

 const module=await Test.createTestingModule({controllers:[MC.ContactMessagesController],providers:[ContactMessagesService,MC.ContactHistoryReadGuard,MC.ContactEmailResendGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 for(const x of [a,b])await setAccess(x,'ACTIVE');
 const numA='+15125550400';
 await q("INSERT INTO hon.school_text_senders(organization_id,school_id,phone_e164,messaging_service_sid,status,mms_converter_confirmed,set_by_principal_id) VALUES($1,$2,$3,$4,'ACTIVE',true,$5)",
  [a.org,a.school,numA,'MG'+createHash('md5').update(K()).digest('hex'),a.principal]);
 const ada=K(),ben=K(),other=K();
 await q("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,phone_e164,email) VALUES($1,$2,$3,'Ada','Parent','+15125552001','ada.parent@example.invalid'),($4,$2,$3,'Ben','NoEmail','+15125552002',NULL)",[ada,a.org,a.school,ben]);
 await q("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'Other','School','other@example.invalid')",[other,b.org,b.school]);
 const reader=await staff(a,'reader',['conversation.read']),manager=await staff(a,'manager',['conversation.read','conversation.manage']);
 const sender=await staff(a,'sender',['conversation.read','conversation.manage','communication.message.queue']);
 const familyStaff=await staff(a,'family',['conversation.read','family_messages.manage']);

 // 2. One person's rows from every source, labelled; drafts never appear; another school's person is not found.
 await consent(a,ada,'EMAIL','OPTED_IN');await consent(a,ada,'SMS','OPTED_IN');
 const day=86_400_000,now=Date.now();
 const eStaff=await message(a,ada,{content:'Welcome to the dojo!\nSee you Tuesday.',at:new Date(now-40*day).toISOString()});
 const eAuto=await message(a,ada,{content:'Your trial class is tomorrow.',subject:'Trial reminder',origin:'AUTOMATION',originId:K(),at:new Date(now-10*day).toISOString()});
 const sCampaign=await message(a,ada,{channel:'SMS',content:'Spring promo: 20% off',origin:'CAMPAIGN',originId:K(),at:new Date(now-3*day).toISOString()});
 const eCancelled=await message(a,ada,{content:'Cancelled note',lifecycle:'CANCELLED',at:new Date(now-2*day).toISOString()});
 await message(a,ada,{content:'Draft never sent',lifecycle:'DRAFT'});
 const r0=await store.recordInboundConversationText({to:numA,from:'+15125552001',body:'Hi! Is class on today?\u0007',mediaCount:0,providerMessageId:sid(),receivedAt:new Date().toISOString()});
 assert.equal(r0.outcome,'RECORDED');
 const conv=(await q('SELECT * FROM hon.school_conversations WHERE id=$1',[r0.conversationId]))[0];assert.equal(conv.person_id,ada);
 const inboundId=(await q("SELECT id FROM hon.school_conversation_messages WHERE conversation_id=$1 AND direction='INBOUND'",[conv.id]))[0].id;
 const sReply=await message(a,ada,{channel:'SMS',content:'Yes, 5pm!'});
 await q("INSERT INTO hon.school_conversation_messages(conversation_id,organization_id,school_id,direction,author_kind,body,communication_message_id,author_principal_id,occurred_at) VALUES($1,$2,$3,'OUTBOUND','STAFF','Yes, 5pm!',$4,$5,clock_timestamp())",[conv.id,a.org,a.school,sReply,a.principal]);
 const fam=K(),thread=K();
 await q("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Parent family')",[fam,a.org,a.school]);
 await q("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'GUARDIAN')",[a.org,a.school,fam,ada]);
 await q('INSERT INTO hon.family_message_threads(id,organization_id,school_id,family_id) VALUES($1,$2,$3,$4)',[thread,a.org,a.school,fam]);
 const fIn=(await q("INSERT INTO hon.family_messages(thread_id,organization_id,school_id,family_id,author_kind,author_principal_id,body) VALUES($1,$2,$3,$4,'FAMILY',$5,'Can we switch to Thursday?') RETURNING id",[thread,a.org,a.school,fam,a.principal]))[0].id;
 let h=await history(a,ada);
 const byId=Object.fromEntries(h.messages.map(m=>[m.messageId,m]));
 assert.equal(h.total,7);assert.equal(h.includesFamily,true,'the owner holds family_messages.manage');
 assert.deepEqual([byId[eStaff].origin,byId[eStaff].channel,byId[eStaff].direction,byId[eStaff].subject,byId[eStaff].delivery,byId[eStaff].preview],
  ['STAFF','EMAIL','SENT','A message from Synthetic alpha Dojo','QUEUED','Welcome to the dojo! See you Tuesday.']);
 assert.deepEqual([byId[eAuto].origin,byId[eAuto].subject],['AUTOMATION','Trial reminder']);
 assert.deepEqual([byId[sCampaign].origin,byId[sCampaign].channel,byId[sCampaign].subject],['CAMPAIGN','SMS',null]);
 assert.equal(byId[eCancelled].delivery,'CANCELLED');
 assert.deepEqual([byId[inboundId].source,byId[inboundId].direction,byId[inboundId].origin,byId[inboundId].delivery,byId[inboundId].preview],['CONVERSATION','RECEIVED','CONVERSATION',null,'Hi! Is class on today?']);
 assert.deepEqual([byId[sReply].origin,byId[sReply].direction],['CONVERSATION','SENT'],'a conversation reply is one row, labelled Conversation');
 assert.deepEqual([byId[fIn].source,byId[fIn].channel,byId[fIn].direction],['FAMILY','APP','RECEIVED']);
 assert(!h.messages.some(m=>m.preview==='Draft never sent'));
 assert.equal(h.nextCursor,null);
 const ordered=[...h.messages].sort((x,y)=>x.at<y.at?1:x.at>y.at?-1:x.messageId<y.messageId?1:-1);assert.deepEqual(h.messages,ordered);
 const r=await history(reader,ada);assert.equal(r.includesFamily,false);assert.equal(r.total,6);assert(!r.messages.some(m=>m.source==='FAMILY'));
 assert.equal((await history(familyStaff,ada)).total,7);
 assert.equal((await send(base(a,other),{identity:a})).status,404,'another school\'s person');
 assert.equal((await send(base(b,ada),{identity:b})).status,404);
 assert.equal((await send(base(a,ada),{identity:human('stranger')})).status,403);
 assert.equal((await send(base(b,other),{identity:a})).status,403,'route scope is never authority');
 assert.equal((await send(base(a,ada)+'?range=WEEK',{identity:a})).status,400);
 assert.equal((await send(base(a,ada)+'?beforeAt=2026-01-01T00:00:00.000Z',{identity:a})).status,400);
 assert.equal((await send(base(a,ada)+'?other=1',{identity:a})).status,400);
 pass('one person\'s texts, emails, conversation texts and family messages in one newest-first list with channel, Sent/Received, origin and delivery state; drafts never appear; family rows only for staff who may read them; other schools are not found');

 // 3. Search, ranges (school day for Today) and keyset pages with a total count.
 assert.deepEqual((await history(a,ada,{search:'thursday'})).messages.map(m=>m.messageId),[fIn]);
 assert.deepEqual((await history(a,ada,{search:'trial reminder'})).messages.map(m=>m.messageId),[eAuto],'the subject is searched');
 assert.deepEqual((await history(a,ada,{search:'20%'})).messages.map(m=>m.messageId),[sCampaign]);
 assert.equal((await history(a,ada,{search:'_'})).total,0,'search is plain text, not a pattern');
 assert.equal((await history(a,ada,{range:'DAYS_30'})).total,6);
 assert.equal((await history(a,ada,{range:'DAYS_7'})).total,5);
 const today=await history(a,ada,{range:'TODAY'});
 const startToday=(await q("SELECT (date_trunc('day',now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago') t"))[0].t;
 assert(today.messages.every(m=>new Date(m.at)>=startToday));assert(today.total>=3);
 const tim=K();await q("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'Tim','Many','tim@example.invalid')",[tim,a.org,a.school]);
 const same=new Date(now-day).toISOString();
 for(let i=0;i<120;i++)await message(a,tim,{channel:'SMS',content:'Note '+i,at:i<60?same:new Date(now-day-i*1000).toISOString()});
 let page=await history(a,tim),seen=[...page.messages];assert.equal(page.total,120);assert.equal(page.messages.length,50);
 while(page.nextCursor){page=await history(a,tim,{beforeAt:page.nextCursor.at,beforeId:page.nextCursor.id});seen.push(...page.messages);}
 assert.equal(seen.length,120);assert.equal(new Set(seen.map(m=>m.messageId)).size,120,'keyset pages never repeat or skip, even with 60 rows at the same millisecond');
 pass('search matches text and subject as plain text; All / Today (school time zone) / 7 / 30 days; total count and 50-row keyset pages that never skip rows at the same instant');

 // 4. The exact email view, delivery evidence, and the author's subject reaching the worker and SendGrid request.
 let v=await email(a,ada,eAuto);
 assert.deepEqual([v.message.subject,v.message.subjectStandard,v.message.body,v.message.origin,v.delivery.status,v.savedAddress,v.emailConsent,v.canResend,v.resendBlocked],
  ['Trial reminder',false,'Your trial class is tomorrow.','AUTOMATION','QUEUED','ada.parent@example.invalid','OPTED_IN',true,null]);
 v=await email(a,ada,eStaff);assert.deepEqual([v.message.subject,v.message.subjectStandard,v.message.body],['A message from Synthetic alpha Dojo',true,'Welcome to the dojo!\nSee you Tuesday.']);
 assert.equal((await send(base(a,ada)+'/'+sCampaign+'/email',{identity:a})).status,404,'a text has no email view');
 assert.equal((await send(base(a,tim)+'/'+eAuto+'/email',{identity:a})).status,404,'the email belongs to its person only');
 assert.equal((await send(base(a,ada)+'/'+eAuto+'/email?x=1',{identity:a})).status,400);
 assert.equal((await email(reader,ada,eAuto)).resendBlocked,'NOT_ALLOWED');
 assert.equal((await email(manager,ada,eAuto)).resendBlocked,'NOT_ALLOWED','conversation.manage alone cannot queue mail');
 assert.equal((await email(sender,ada,eAuto)).canResend,true);
 const claimed=(await worker.query("SELECT c.*, CASE WHEN c.channel='EMAIL' THEN hon.communication_email_subject(c.delivery_id,c.lease_token) END AS email_subject FROM hon.claim_communication_deliveries(ARRAY['EMAIL'],50,60) c")).rows.filter(x=>x.organization_id===a.org);
 const auto=claimed.find(x=>x.message_id===eAuto),plain=claimed.find(x=>x.message_id===eStaff);
 assert.equal(auto.email_subject,'Trial reminder');assert.equal(plain.email_subject,null);assert.equal(auto.recipient_address,'ada.parent@example.invalid');
 assert.equal((await worker.query('SELECT hon.communication_email_subject($1,$2) s',[auto.delivery_id,K()])).rows[0].s,null,'only the lease holder reads the subject');
 const sg=new SendGridEmailProvider(()=>({HON_EMAIL_FROM:'school@example.invalid'}));
 const reqBody=d=>sg.requestBody({deliveryId:d.delivery_id,messageId:d.message_id,organizationId:d.organization_id,schoolId:d.school_id,channel:'EMAIL',recipientAddress:d.recipient_address,content:d.content,schoolName:d.school_name,attempt:d.attempt,...(d.email_subject?{subject:d.email_subject}:{})});
 assert.equal(reqBody(auto).subject,'Trial reminder');assert.equal(reqBody(plain).subject,v.message.subject,'the standard subject shown is the one sent');
 assert.equal((await store.recordResult(auto.delivery_id,auto.lease_token,{outcome:'ACCEPTED',provider:'FAKE',providerMessageId:'fake-'+K(),sentAs:'EMAIL'})).status,'ACCEPTED');
 v=await email(a,ada,eAuto);assert.equal(v.delivery.status,'ACCEPTED');assert(v.delivery.acceptedAt);
 assert.equal((await history(a,ada,{search:'trial class'})).messages[0].delivery,'ACCEPTED');
 // Claimed leases for other rows are released by the reconcile path; record a retry for the plain one so it stays pending.
 for(const d of claimed.filter(x=>x.message_id!==eAuto))await store.recordResult(d.delivery_id,d.lease_token,{outcome:'RETRYABLE',provider:'FAKE',retryAfterSeconds:30});
 pass('the email view shows the subject that is sent (the author\'s subject, else the adapter\'s standard subject) and the plain-text body exactly as stored, with delivery evidence; the worker now gives SendGrid the author\'s subject, only to the lease holder');

 // 5. Resend: authority, consent, address, original state and limits; one queued copy, exact replay, audit and outbox ids only.
 assert.equal((await resend(reader,ada,eAuto)).status,403);
 assert.equal((await resend(manager,ada,eAuto)).status,403,'communication.message.queue is required');
 assert.equal((await resend(sender,ada,eAuto,{key:null})).status,409);
 assert.equal((await resend(sender,ada,eAuto,{body:{personId:ada}})).status,400,'the body names nothing');
 assert.equal((await resend(sender,ada,sCampaign)).status,404,'texts are not resent');
 assert.equal((await resend(sender,ada,eCancelled)).body.code,'CONTACT_RESEND_NOT_SENT');
 const eBen=await message(a,ben,{content:'For Ben'});assert.equal((await resend(sender,ben,eBen)).body.code,'CONTACT_RESEND_EMAIL_MISSING');
 await consent(a,ada,'EMAIL','OPTED_OUT');
 let x=await resend(sender,ada,eAuto);assert.equal(x.status,422);assert.equal(x.body.code,'CONTACT_RESEND_CONSENT_REQUIRED');
 assert.equal((await email(sender,ada,eAuto)).resendBlocked,'CONSENT_REQUIRED');
 await consent(a,ada,'EMAIL','OPTED_IN');
 const key=K(),before=(await q("SELECT count(*) n FROM hon.communication_messages WHERE recipient_person_id=$1",[ada]))[0].n;
 x=await resend(sender,ada,eAuto,{key});const receipt=C.verifyContactEmailResendReceipt(ok(x,201),{personId:ada,messageId:eAuto});assert.equal(x.body.meta.replayed,false);
 const copy=(await q('SELECT * FROM hon.communication_messages WHERE id=$1',[receipt.messageId]))[0];
 assert.deepEqual([copy.channel,copy.content,copy.email_subject,copy.lifecycle,copy.origin_kind,copy.origin_id,copy.recipient_person_id,copy.created_by_principal_id],
  ['EMAIL','Your trial class is tomorrow.','Trial reminder','QUEUED','STAFF',null,ada,sender.principal]);
 const again=await resend(sender,ada,eAuto,{key});assert.equal(again.status,200);assert.equal(again.body.meta.replayed,true);assert.deepEqual(again.body.data,x.body.data);
 assert.equal((await resend(sender,ada,eStaff,{key})).body.code,'IDEMPOTENCY_KEY_REUSED');
 assert.equal((await q("SELECT count(*) n FROM hon.communication_messages WHERE recipient_person_id=$1",[ada]))[0].n,String(Number(before)+1));
 const audit=(await q("SELECT * FROM hon.audit_events WHERE action_code='communication.message.resend' AND entity_id=$1",[receipt.messageId]));assert.equal(audit.length,1);
 assert.deepEqual([audit[0].source,audit[0].actor_principal_id,audit[0].prior_state],['HUMAN_UI',sender.principal,{messageId:eAuto}]);
 const ob=(await q("SELECT payload FROM hon.outbox_events WHERE event_type='communication.message.resent' AND aggregate_id=$1",[receipt.messageId]));
 assert.equal(ob.length,1);assert.deepEqual(Object.keys(ob[0].payload).sort(),['messageId','personId','resentFrom']);
 v=await email(sender,ada,eAuto);assert.deepEqual(v.resends.map(r=>r.messageId),[receipt.messageId]);
 assert.equal((await email(sender,ada,receipt.messageId)).resentFrom,eAuto);
 assert.equal((await history(a,ada)).messages.find(m=>m.messageId===receipt.messageId).resentFrom,eAuto);
 const w=(await worker.query("SELECT c.*, hon.communication_email_subject(c.delivery_id,c.lease_token) AS email_subject FROM hon.claim_communication_deliveries(ARRAY['EMAIL'],50,60) c")).rows.find(r=>r.message_id===receipt.messageId);
 assert.deepEqual([w.recipient_address,w.content,w.email_subject],['ada.parent@example.invalid','Your trial class is tomorrow.','Trial reminder'],'the copy goes to the saved address with the same subject and body');
 await store.recordResult(w.delivery_id,w.lease_token,{outcome:'RETRYABLE',provider:'FAKE',retryAfterSeconds:30});
 await q("UPDATE hon.people SET email='ada.new@example.invalid' WHERE id=$1",[ada]);
 assert.equal((await email(sender,ada,eAuto)).savedAddress,'ada.new@example.invalid','the current saved address is used, never a stored copy');
 for(let i=0;i<2;i++)ok(await resend(sender,ada,eAuto),201);
 x=await resend(sender,ada,eAuto);assert.equal(x.body.code,'CONTACT_RESEND_LIMIT_REACHED','3 resends of one email a day');
 const extra=[];for(let i=0;i<8;i++)extra.push(await message(a,ada,{content:'Extra '+i}));
 for(let i=0;i<7;i++)ok(await resend(sender,ada,extra[i]),201);
 assert.equal((await resend(sender,ada,extra[7])).body.code,'CONTACT_RESEND_LIMIT_REACHED','10 resends to one person a day');
 // Counted under the person lock: ten parallel resends to a fresh person store exactly ten, never more.
 const cara=K();await q("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'Cara','Busy','cara@example.invalid')",[cara,a.org,a.school]);
 await consent(a,cara,'EMAIL','OPTED_IN');const cm=[];for(let i=0;i<12;i++)cm.push(await message(a,cara,{content:'C '+i}));
 const results=await Promise.all(cm.map(id=>resend(sender,cara,id)));
 assert.equal(results.filter(r=>r.status===201).length,10,results.map(r=>r.status).join());
 assert.equal((await q('SELECT count(*) n FROM hon.communication_message_resends WHERE person_id=$1',[cara]))[0].n,'10');
 await assert.rejects(admin.query('UPDATE hon.communication_message_resends SET principal_id=principal_id'));
 await assert.rejects(admin.query('DELETE FROM hon.communication_message_resends'));
 await assert.rejects(admin.query('TRUNCATE hon.communication_message_resends'));
 pass('a resend needs conversation.manage and communication.message.queue, a queued email, a saved address and email consent; it queues one copy with the same subject and body to the current saved address, replays exactly, is audited with ids-only outbox, and is capped at 3 per email and 10 per person a day under a lock');

 // 6. Authority is decided again: a lapsed entitlement or a revoked grant refuses reads and resends.
 await setAccess(a,'SUSPENDED');
 assert.equal((await send(base(a,ada),{identity:a})).status,403);await setAccess(a,'ACTIVE');
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1',[sender.grant,a.principal]);
 assert.equal((await resend(sender,ada,extra[7])).status,403);
 assert.equal((await send(base(a,ada),{identity:sender})).status,403);
 pass('a suspended school or a revoked grant is refused at once for reading and resending');

 // 7. The canonical 011 exact verification section passes here with the fixture's roles, and catches drift.
 {const verify=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const section=verify.split('-- Contact message history exact verification (0424)')[1]?.split('-- End contact message history exact verification.')[0];
  assert(section,'011 section');
  const body=section.replace(/^[^\n]*\n[^\n]*\n/,'').replaceAll('hon_communication_worker',workerUrl.username).replaceAll('hon_runtime',runtime.username);
  await q(body);
  await q(`GRANT EXECUTE ON FUNCTION hon.contact_message_rows(uuid,boolean) TO ${runtime.username}`);
  await assert.rejects(q(body),/Unsafe contact message history function: hon.contact_message_rows/);
  await q(`REVOKE EXECUTE ON FUNCTION hon.contact_message_rows(uuid,boolean) FROM ${runtime.username}`);
  await q(`GRANT EXECUTE ON FUNCTION hon.resend_contact_message_email(text,jsonb,text,uuid,uuid) TO ${workerUrl.username}`);
  await assert.rejects(q(body),/Unsafe contact message history function: hon.resend_contact_message_email/);
  await q(`REVOKE EXECUTE ON FUNCTION hon.resend_contact_message_email(text,jsonb,text,uuid,uuid) FROM ${workerUrl.username}`);
  await q(body);}
 pass('the canonical 011 verification of the 0424 functions, ACLs and table passes and refuses an extra runtime or worker grant');
 console.log(`Contact message history (0424): ${groups} proof groups passed.`);
}finally{
 if(app)await app.close().catch(()=>{});else await database.onModuleDestroy?.()?.catch?.(()=>{});
 await Promise.resolve(store.onModuleDestroy?.()).catch(()=>{});
 await Promise.allSettled([admin.end(),restricted.end(),worker.end()]);
}
