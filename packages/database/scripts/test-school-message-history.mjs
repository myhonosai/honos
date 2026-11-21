/** School message history and opted-out list (0585, Texts and Email pages TE1): real signed HON sessions -> Nest/guards -> the two
 *  read-only runtime entry points, on the marked disposable communication delivery database. Schools are SYNTHETIC sign-ups made
 *  through the 0241 runtime entry point; people use example.invalid addresses. Nothing is sent, queued or changed by the reads. */
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
const SC=require('./dist/communication/school-messages.controller.js');
const {SchoolMessagesService}=require('./dist/communication/school-messages.service.js');
const C=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),worker=new pg.Client({connectionString:workerUrl.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'school-history-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS SCHOOL MESSAGE HISTORY '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,command=C.SCHOOL_MESSAGE_HISTORY_READ_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method:'GET',headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':command,...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end();});
}
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const human=label=>({externalSubject:'oidc:schoolhist:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
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
const base=x=>`organizations/${x.org}/schools/${x.school}/communications`;
const qs=params=>Object.keys(params).length?'?'+new URLSearchParams(params):'';
const history=async(x,params={})=>{const query={};for(const [k,v]of Object.entries(params))if(k!=='beforeAt'&&k!=='beforeId')query[k]=v;if(params.beforeAt)query.before={at:params.beforeAt,id:params.beforeId};
 return C.verifySchoolMessageHistory(ok(await send(base(x)+'/history'+qs(params),{identity:x})),query);};
const optedOut=async(x,params={})=>C.verifySchoolOptedOut(ok(await send(base(x)+'/opted-out'+qs(params),{identity:x,command:C.SCHOOL_OPTED_OUT_READ_COMMAND})),
 params.channel?{channel:params.channel}:{});
const person=async(x,given,family,phone,email)=>(await q('INSERT INTO hon.people(organization_id,school_id,given_name,family_name,phone_e164,email) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[x.org,x.school,given,family,phone,email]))[0].id;
const consent=(x,who,channel,status,source='STAFF',at=null)=>q("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,coalesce($8::timestamptz,clock_timestamp()),$7,coalesce($8::timestamptz,clock_timestamp())) ON CONFLICT (person_id,channel) DO UPDATE SET status=EXCLUDED.status,source=EXCLUDED.source,captured_at=EXCLUDED.captured_at,version=hon.communication_consents.version+1,updated_at=EXCLUDED.updated_at",[x.org,x.school,who,channel,status,source,x.principal,at]);
const message=async(x,who,{channel='SMS',content='Hello',subject=null,origin='STAFF',lifecycle='QUEUED',at=null,by=x.principal}={})=>(await q(
 `INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,lifecycle,created_by_principal_id,queued_by_principal_id,origin_kind,origin_id,email_subject,created_at)
  VALUES($1,$2,$3,$4,$5,$6::text::hon.communication_message_lifecycle,$7,CASE WHEN $6::text='DRAFT' THEN NULL ELSE $7::uuid END,$8,CASE WHEN $8='STAFF' THEN NULL ELSE gen_random_uuid() END,$9,coalesce($10::timestamptz,now())) RETURNING id`,
 [x.org,x.school,who,channel,content,lifecycle,by,origin,subject,at]))[0].id;
const deliver=(x,m,status)=>q(`INSERT INTO hon.communication_deliveries(organization_id,school_id,message_id,channel,status,provider,provider_message_id,accepted_at,final_at,failure_code)
 SELECT organization_id,school_id,id,channel,$2::hon.communication_delivery_status,'FAKE','fake-'||id,CASE WHEN $2 IN ('ACCEPTED','DELIVERED') THEN clock_timestamp() END,
  CASE WHEN $2 IN ('DELIVERED','FAILED','BOUNCED','SUPPRESSED') THEN clock_timestamp() END,CASE WHEN $2 IN ('FAILED','BOUNCED','SUPPRESSED','UNKNOWN') THEN 'PROVIDER_FAILED' END
 FROM hon.communication_messages WHERE id=$1`,[m,status]);

try{
 await Promise.all([admin.connect(),restricted.connect(),worker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable communication delivery validation');
 // 1. Custody.
 {const entry=['read_school_message_history','read_school_opted_out_contacts'];
  const fns=await q("SELECT p.oid,p.proname,p.prosecdef FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname IN ('read_school_message_history','read_school_opted_out_contacts','require_school_messages_actor','school_messages_args_ok','school_message_outcome')");
  assert.equal(fns.length,5,fns.map(f=>f.proname).join());
  for(const f of fns){
   assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry.includes(f.proname),'runtime '+f.proname);
   assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[workerUrl.username,f.oid]))[0].ok,false,'worker '+f.proname);
   assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,'public '+f.proname);
  }
  await assert.rejects(restricted.query("SELECT hon.require_school_messages_actor('x','communication.message.read')"),/permission denied/);
  await assert.rejects(worker.query("SELECT hon.read_school_message_history('x','{}'::jsonb)"),/permission denied/);
  for(const t of ['communication_messages','communication_consents','people'])
   assert.equal((await q("SELECT has_table_privilege($1,'hon.'||$2,'DELETE') ok",[runtime.username,t]))[0].ok,false,'no delete on '+t);
  assert.equal((await q("SELECT count(*) n FROM pg_indexes WHERE schemaname='hon' AND indexname='communication_messages_school_history'"))[0].n,'1');}
 {const verify=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const start=verify.indexOf('-- School message history exact verification');
  assert(start>=0,'the 011 section exists');
  const section=verify.slice(start,verify.indexOf('-- End school message history exact verification',start));
  assert(section.includes('DO $$'));
  await admin.query(section.replaceAll('hon_runtime',runtime.username));
  // The section refuses a helper the runtime can run.
  await admin.query('BEGIN');
  try{await admin.query(`GRANT EXECUTE ON FUNCTION hon.school_message_outcome(text) TO ${runtime.username}`);
   await assert.rejects(admin.query(section.replaceAll('hon_runtime',runtime.username)),/Unsafe school message history helper/);}finally{await admin.query('ROLLBACK');}}
 pass('the runtime executes exactly the two read entry points; helpers are private; the worker and PUBLIC execute none of them; the 011 section passes and catches a leaked helper');

 const module=await Test.createTestingModule({controllers:[SC.SchoolMessagesController],providers:[SchoolMessagesService,SC.SchoolMessageHistoryReadGuard,SC.SchoolOptedOutReadGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 for(const x of [a,b])await setAccess(x,'ACTIVE');
 const ada=await person(a,'Ada','Parent','+15125552001','ada.parent@example.invalid');
 const ben=await person(a,'Ben','Lee_100%','+15125552002',null);
 const demo=await person(a,'Demo','Student','+15125552099','demo@example.invalid');
 const other=await person(b,'Other','School','+15125553001','other@example.invalid');
 // A demo person can no longer be sent anything (0459); a message from before they were marked demo still never shows.
 const day=86_400_000,now=Date.now(),ago=d=>new Date(now-d).toISOString();
 await message(a,demo,{content:'Demo text',at:ago(60_000)});
 {const set=(await q("INSERT INTO hon.school_demo_data_sets(organization_id,school_id,status,counts,loaded_by_principal_id) VALUES($1,$2,'LOADED','{}'::jsonb,$3) RETURNING id",[a.org,a.school,a.principal]))[0].id;
  await q("INSERT INTO hon.school_demo_data_rows(table_name,row_id,set_id,organization_id,school_id,origin) VALUES('people',$1,$2,$3,$4,'LOADED')",[demo,set,a.org,a.school]);}

 // 2. The school's sent texts and emails, newest first, with who, where and the delivery result.
 const eStaff=await message(a,ada,{channel:'EMAIL',content:'Welcome to the dojo!\nSee you Tuesday.',at:ago(40*day)});
 const eAuto=await message(a,ada,{channel:'EMAIL',content:'Your trial class is tomorrow.',subject:'Trial reminder',origin:'AUTOMATION',at:ago(10*day)});
 const sCampaign=await message(a,ben,{content:'Spring promo: 20% off',origin:'CAMPAIGN',at:ago(3*day)});
 const sAi=await message(a,ada,{content:'Class is at 5pm.',origin:'CONVERSATION_AI',at:ago(2*day)});
 const sCancelled=await message(a,ben,{content:'Cancelled note',lifecycle:'CANCELLED',at:ago(day+1000)});
 const sFailed=await message(a,ben,{content:'Belt test Saturday',at:ago(5*60_000)});
 await message(a,ada,{content:'Draft never sent',lifecycle:'DRAFT'});
 await message(b,other,{content:'Other school text',at:ago(60_000)});
 await deliver(a,eStaff,'DELIVERED');await deliver(a,eAuto,'BOUNCED');await deliver(a,sCampaign,'ACCEPTED');await deliver(a,sFailed,'FAILED');
 let h=await history(a);
 assert.deepEqual(h.messages.map(m=>m.messageId),[sFailed,sCancelled,sAi,sCampaign,eAuto,eStaff]);
 const by=Object.fromEntries(h.messages.map(m=>[m.messageId,m]));
 assert.deepEqual([by[eStaff].channel,by[eStaff].subject,by[eStaff].delivery,by[eStaff].outcome,by[eStaff].preview,by[eStaff].address,by[eStaff].personName,by[eStaff].by],
  ['EMAIL','A message from Synthetic alpha Dojo','DELIVERED','DELIVERED','Welcome to the dojo! See you Tuesday.','ada.parent@example.invalid','Ada Parent','Synthetic alpha']);
 assert.deepEqual([by[eAuto].origin,by[eAuto].subject,by[eAuto].outcome],['AUTOMATION','Trial reminder','FAILED']);
 assert.deepEqual([by[sCampaign].origin,by[sCampaign].subject,by[sCampaign].outcome,by[sCampaign].address],['CAMPAIGN',null,'DELIVERED','+15125552002']);
 assert.deepEqual([by[sAi].origin,by[sAi].delivery,by[sAi].outcome],['CONVERSATION','QUEUED','IN_PROGRESS']);
 assert.deepEqual([by[sCancelled].delivery,by[sCancelled].outcome],['CANCELLED','CANCELLED']);
 assert.equal(by[sFailed].outcome,'FAILED');
 assert(!h.messages.some(m=>/Draft|Demo|Other school/.test(m.preview)),'drafts, demo people and other schools never appear');
 assert.equal(h.nextCursor,null);
 assert.deepEqual((await history(b)).messages.map(m=>m.preview),['Other school text']);
 pass('every sent (non-draft) text and email of the school only, newest first, with name, address on file, subject, preview, origin, delivery state and outcome; drafts and demo people left out');

 // 3. Filters and search (literal, including % and _), each answer re-checked by the contract verifier.
 assert.deepEqual((await history(a,{channel:'EMAIL'})).messages.map(m=>m.messageId),[eAuto,eStaff]);
 assert.deepEqual((await history(a,{outcome:'FAILED'})).messages.map(m=>m.messageId),[sFailed,eAuto]);
 assert.deepEqual((await history(a,{outcome:'IN_PROGRESS'})).messages.map(m=>m.messageId),[sAi]);
 assert.deepEqual((await history(a,{origin:'CAMPAIGN'})).messages.map(m=>m.messageId),[sCampaign]);
 assert.deepEqual((await history(a,{origin:'CONVERSATION'})).messages.map(m=>m.messageId),[sAi]);
 assert.deepEqual((await history(a,{range:'DAYS_7'})).messages.map(m=>m.messageId),[sFailed,sCancelled,sAi,sCampaign]);
 assert.deepEqual((await history(a,{range:'DAYS_30'})).messages.length,5);
 assert.deepEqual((await history(a,{search:'ada'})).messages.map(m=>m.messageId),[sAi,eAuto,eStaff],'by name');
 assert.deepEqual((await history(a,{search:'5552002'})).messages.map(m=>m.messageId),[sFailed,sCancelled,sCampaign],'by phone');
 assert.deepEqual((await history(a,{search:'parent@example'})).messages.length,3,'by email');
 assert.deepEqual((await history(a,{search:'trial reminder'})).messages.map(m=>m.messageId),[eAuto],'by subject');
 assert.deepEqual((await history(a,{search:'belt test'})).messages.map(m=>m.messageId),[sFailed],'by text');
 assert.deepEqual((await history(a,{search:'_100%'})).messages.length,3,'% and _ are literal');
 assert.deepEqual((await history(a,{search:'%'})).messages.map(m=>m.messageId),[sFailed,sCancelled,sCampaign],'only rows holding a literal %');
 assert.deepEqual((await history(a,{search:'zzz'})).messages,[]);
 assert.deepEqual((await history(a,{channel:'SMS',outcome:'DELIVERED',origin:'CAMPAIGN',search:'promo'})).messages.map(m=>m.messageId),[sCampaign]);
 for(const bad of ['?channel=PUSH','?outcome=SENT','?origin=FAMILY','?range=WEEK','?search=','?search=%20a','?search='+'x'.repeat(61),'?beforeAt=2026-01-01T00:00:00.000Z','?schoolId='+a.school,'?channel=SMS&channel=EMAIL'])
  assert.equal((await send(base(a)+'/history'+bad,{identity:a})).status,400,bad);
 pass('channel, outcome, origin, range and search (name, phone, email, subject and text; % and _ literal) filter exactly; unknown, repeated or malformed parameters are refused');

 // 4. Keyset pages of 50 with no gaps or repeats, including rows sharing a millisecond.
 {const same=new Date(now-20*day).toISOString(),made=[];
  for(let i=0;i<53;i++)made.push(await message(a,ada,{content:'Bulk '+i,at:i<10?same:new Date(now-20*day-(i+1)*1000).toISOString()}));
  const seen=[];let cursor=null,pages=0;
  do{const page=await history(a,{search:'bulk',...(cursor?{beforeAt:cursor.at,beforeId:cursor.id}:{})});seen.push(...page.messages.map(m=>m.messageId));cursor=page.nextCursor;pages++;
   if(cursor)assert.equal(page.messages.length,50);}while(cursor);
  assert.equal(pages,2);assert.equal(seen.length,53);assert.equal(new Set(seen).size,53);assert.deepEqual(new Set(seen),new Set(made));}
 pass('keyset pages of 50 cover every row once, in order, across rows that share a millisecond');

 // 5. Opted out: OPTED_OUT consents only, newest first, by channel and search; demo people and other schools left out.
 await consent(a,ada,'SMS','OPTED_IN');
 await consent(a,ada,'EMAIL','OPTED_OUT','RECIPIENT',ago(2*day));
 await consent(a,ben,'SMS','OPTED_OUT','RECIPIENT',ago(day));
 await consent(a,demo,'SMS','OPTED_OUT');
 await consent(b,other,'SMS','OPTED_OUT');
 let o=await optedOut(a);
 assert.deepEqual(o.contacts.map(c=>[c.personName,c.channel,c.source,c.address]),[['Ben Lee_100%','SMS','RECIPIENT','+15125552002'],['Ada Parent','EMAIL','RECIPIENT','ada.parent@example.invalid']]);
 assert.deepEqual((await optedOut(a,{channel:'SMS'})).contacts.map(c=>c.personName),['Ben Lee_100%']);
 assert.deepEqual((await optedOut(a,{search:'ada'})).contacts.map(c=>c.channel),['EMAIL']);
 assert.deepEqual((await optedOut(b)).contacts.map(c=>c.personName),['Other School']);
 await consent(a,ben,'SMS','OPTED_IN');
 assert.deepEqual((await optedOut(a)).contacts.map(c=>c.personName),['Ada Parent'],'opting back in leaves the list');
 for(const bad of ['?outcome=FAILED','?channel=APP','?range=ALL','?beforeId='+K()])
  assert.equal((await send(base(a)+'/opted-out'+bad,{identity:a,command:C.SCHOOL_OPTED_OUT_READ_COMMAND})).status,400,bad);
 {const many=[];for(let i=0;i<52;i++){const p=await person(a,'Out'+i,'Sample','+1512556'+String(1000+i),null);many.push(p);await consent(a,p,'SMS','OPTED_OUT','STAFF',ago(30*day+i*1000));}
  const first=await optedOut(a,{search:'sample'});assert.equal(first.contacts.length,50);assert(first.nextCursor);
  const second=await optedOut(a,{search:'sample',beforeAt:first.nextCursor.at,beforeId:first.nextCursor.id});
  assert.equal(second.contacts.length,2);assert.equal(second.nextCursor,null);
  assert.deepEqual(new Set([...first.contacts,...second.contacts].map(c=>c.personId)),new Set(many));}
 pass('opted out lists only current OPTED_OUT consents, newest first, with how they opted out; channel and search filter; keyset pages; demo people and other schools left out');

 // 6. Authority: the permission for each list, the exact school, a live grant; route scope is never authority.
 const reader=await staff(a,'reader',['communication.message.read']),consentReader=await staff(a,'consent',['communication.consent.read']),none=await staff(a,'none',['conversation.read']);
 assert.equal((await history(reader)).messages.length>0,true);
 assert.equal((await send(base(reader)+'/opted-out',{identity:reader,command:C.SCHOOL_OPTED_OUT_READ_COMMAND})).status,403,'history permission does not open the opted-out list');
 assert.equal((await optedOut(consentReader)).contacts.length>0,true);
 assert.equal((await send(base(consentReader)+'/history',{identity:consentReader})).status,403);
 assert.equal((await send(base(none)+'/history',{identity:none})).status,403);
 assert.equal((await send(base(b)+'/history',{identity:a})).status,403,'another school in the route');
 assert.equal((await send(base(a)+'/history',{identity:human('stranger')})).status,403);
 assert.equal((await send(base(a)+'/history')).status,401);
 assert.equal((await send(base(a)+'/history',{identity:a,headers:{'sec-fetch-site':'cross-site'}})).status,403,'a cross-site fetch');
 assert.equal((await send(base(a)+'/history',{identity:a,headers:{'x-hon-source':'AI_AGENT'}})).status,403,'a source selector header');
 assert.equal((await send(base(a)+'/history',{identity:a,headers:{'idempotency-key':'k'}})).status,409);
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[reader.grant]);
 assert.equal((await send(base(reader)+'/history',{identity:reader})).status,403,'a revoked grant');
 pass('history needs communication.message.read and opted out needs communication.consent.read at the exact school; others, revoked grants, strangers, signed-out callers and other schools in the route are refused');

 // 7. Direct calls: the session actor is decided by the database, not by arguments. Each try runs in its own rolled-back transaction.
 {const direct=async(settings,sql,subject)=>{await restricted.query('BEGIN');
   try{if(settings){await restricted.query("SELECT set_config('app.hon_external_subject',$1,true),set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source',$5,true),set_config('app.hon_principal_id',$2,true),set_config('app.hon_organization_id',$3,true),set_config('app.hon_school_id',$4,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)",[a.externalSubject,a.principal,a.org,a.school,settings.source??'HUMAN_UI']);}
    return (await restricted.query(sql,[subject])).rows[0];}finally{await restricted.query('ROLLBACK');}};
  await assert.rejects(direct(null,"SELECT hon.read_school_message_history($1,'{}'::jsonb)",a.externalSubject),/SCHOOL_MESSAGES_FORBIDDEN/,'no session context');
  await assert.rejects(direct({},"SELECT hon.read_school_message_history($1,'{\"limit\":500}'::jsonb)",a.externalSubject),/VALIDATION_FAILED/,'unknown key');
  await assert.rejects(direct({},"SELECT hon.read_school_message_history($1,'{}'::jsonb)",b.externalSubject),/SCHOOL_MESSAGES_FORBIDDEN/,'another subject');
  await assert.rejects(direct({source:'AI_AGENT'},"SELECT hon.read_school_opted_out_contacts($1,'{}'::jsonb)",a.externalSubject),/SCHOOL_MESSAGES_FORBIDDEN/,'not a human UI call');
  assert.ok((await direct({},"SELECT hon.read_school_message_history($1,'{}'::jsonb) d",a.externalSubject)).d.messages.length>0,'the same call with the right context reads');}
 pass('direct runtime calls without the human session context, with another subject, from a non-human source or with unknown keys are refused');

 // 8. Read only: nothing changed.
 {const before=(await q("SELECT (SELECT count(*) FROM hon.communication_messages) m,(SELECT count(*) FROM hon.communication_consents) c,(SELECT count(*) FROM hon.audit_events) a,(SELECT count(*) FROM hon.outbox_events) o"))[0];
  await history(a);await optedOut(a);await history(a,{search:'ada',channel:'EMAIL'});
  assert.deepEqual((await q("SELECT (SELECT count(*) FROM hon.communication_messages) m,(SELECT count(*) FROM hon.communication_consents) c,(SELECT count(*) FROM hon.audit_events) a,(SELECT count(*) FROM hon.outbox_events) o"))[0],before);}
 pass('the reads write nothing: no message, consent, audit or outbox row');
 console.log(`PASS SCHOOL MESSAGE HISTORY: ${groups} groups`);
}finally{await app?.close();await Promise.allSettled([admin.end(),restricted.end(),worker.end(),database.onModuleDestroy?.()]);}
