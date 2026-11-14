/** School social inbox (0349): real signed HON sessions -> Nest/guards -> fixed runtime SQL, and inbound Zernio events as
 *  the 0243 worker role -> marked disposable PostgreSQL (the communication delivery fixture). Zernio is the deterministic
 *  in-process fake adapter only; nothing is sent anywhere. Schools are SYNTHETIC sign-ups made through the 0241 runtime
 *  entry point; the owner connection stands in for paid access and seeds connected accounts (0347 is proven separately).
 *  All names and texts are synthetic. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??''),workerUrl=new URL(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_comm_delivery_owner'],[runtime,'hon_comm_delivery_runtime'],[workerUrl,'hon_comm_delivery_worker']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_comm_delivery_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|SENDGRID.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|ZERNIO).*)$/i.test(key),key);
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {SchoolSocialInboxController}=require('./dist/marketing/social/school-social-inbox.controller.js');
const {SchoolSocialInboxService}=require('./dist/marketing/social/school-social-inbox.service.js');
const {SOCIAL_HUMAN_SETTINGS}=require('./dist/marketing/social/school-social.service.js');
const G=require('./dist/marketing/social/school-social.guard.js');
const {FakeZernioSocialAdapter,ZERNIO_SOCIAL_ADAPTER}=require('./dist/marketing/social/zernio-social-adapter.js');
const {CommunicationWorkerDatabase}=require('./dist/communication/delivery/communication-worker-database.js');
const C=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),worker=new pg.Client({connectionString:workerUrl.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'social-inbox-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
// The fake adapter reads its switch from this object only; the proof turns the inbox on and off.
const fakeEnv={HON_DEPLOYMENT_ENVIRONMENT:'development'};const fake=new FakeZernioSocialAdapter(()=>fakeEnv);
const store=new CommunicationWorkerDatabase();
const pass=name=>console.log('PASS INBOX '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command=C.SOCIAL_INBOX_CHANGE_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const person=label=>({externalSubject:'oidc:inbox:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=person(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:C.SIGNUP_CONFIRMATION},K()])).rows[0].data;
 return {...p,org:r.organizationId,school:r.schoolId};}
const setAccess=(x,status)=>q("UPDATE hon.organization_entitlements SET status=$2,effective_from=clock_timestamp()-interval '1 day',effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1",[x.org,status]);
const base=x=>`organizations/${x.org}/schools/${x.school}/marketing/social/inbox`;
const list=async(x,query='')=>C.verifySocialInboxList(ok(await send(base(x)+query,{identity:x})));
const detail=async(x,id)=>C.verifySocialConversationDetail(ok(await send(base(x)+'/conversations/'+id,{identity:x})));
const change=(x,id,body,extra={})=>send(base(x)+'/conversations/'+id,{identity:x,method:'POST',body,...extra});
const reply=(x,id,body,extra={})=>send(base(x)+'/conversations/'+id+'/reply',{identity:x,method:'POST',command:C.SOCIAL_INBOX_REPLY_COMMAND,body,...extra});
const comment=(x,id,body,extra={})=>send(base(x)+'/conversations/'+id+'/comment',{identity:x,method:'POST',command:C.SOCIAL_INBOX_COMMENT_COMMAND,body,...extra});
const resolve=(x,id,body,extra={})=>send(base(x)+'/messages/'+id+'/resolve',{identity:x,method:'POST',command:C.SOCIAL_INBOX_RESOLVE_COMMAND,body,...extra});
const principalOf=async x=>(await q('SELECT p.id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE u.external_subject=$1',[x.externalSubject]))[0].id;
async function seedAccounts(x,accounts){
 const ownerId=await principalOf(x);
 await q("INSERT INTO hon.school_social_profiles(organization_id,school_id,provider_profile_id,linked_by_principal_id) VALUES($1,$2,$3,$4)",[x.org,x.school,'prof_'+x.school.slice(0,8),ownerId]);
 const out={};
 for(const [name,platform,inbox] of accounts){
  out[name]=(await q("INSERT INTO hon.school_social_accounts(organization_id,school_id,platform,provider_account_id,display_name,status,inbox_enabled,connected_by_principal_id) VALUES($1,$2,$3,$4,$5,'CONNECTED',$6,$7) RETURNING id,provider_account_id,platform",
   [x.org,x.school,platform,name+'_'+x.school.slice(0,8),'Synthetic '+name,inbox,ownerId]))[0];
 }
 return out;
}
const accountUpdate=(id,sets)=>q(`UPDATE hon.school_social_accounts SET ${sets},version=version+1,updated_at=clock_timestamp() WHERE id=$1`,[id]);
const ago=minutes=>new Date(Date.now()-minutes*60_000).toISOString();
let seq=0;
const dm=(acct,conv,text='Do you have kids classes on Saturday?',patch={})=>({eventId:'evt_dm_'+(++seq),eventType:'message.received',platform:acct.platform,providerAccountId:acct.provider_account_id,
 providerConversationId:conv,providerMessageId:'mid_'+seq+'_'+K().slice(0,8),providerPostId:null,participantName:'Synthetic Parent',text,occurredAt:ago(1),...patch});
const cm=(acct,conv,text='How much is the trial?',patch={})=>({eventId:'evt_cm_'+(++seq),eventType:'comment.received',platform:acct.platform,providerAccountId:acct.provider_account_id,
 providerConversationId:conv,providerMessageId:'cmt_'+seq+'_'+K().slice(0,8),providerPostId:'post_1',participantName:'Synthetic Student',text,occurredAt:ago(1),...patch});
const inbound=e=>store.recordSocialInboxEvent(e).then(x=>x.outcome);
const conv=async(acct,id)=>(await q('SELECT * FROM hon.school_social_conversations WHERE account_id=$1 AND provider_conversation_id=$2',[acct.id,id]))[0];
const msg=async id=>(await q('SELECT * FROM hon.school_social_messages WHERE id=$1',[id]))[0];
const evidence=async x=>(await q("SELECT (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'marketing.social.inbox%') a,(SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'marketing.social.inbox%') o",[x.org]))[0];
// Calls one runtime inbox function directly as the verified person (for late answers the API never sends itself).
async function asPerson(x,sql,args){
 const scope=await database.resolveAuthorizedScope(x.externalSubject,x.school,'marketing.social.inbox');assert(scope);
 const requestId=K();
 return database.withTenantTransaction({...scope,principalType:'HUMAN_USER',requestId,correlationId:requestId,idempotencyKey:'',source:'HUMAN_UI',externalSubject:x.externalSubject},
  async client=>{await client.query(SOCIAL_HUMAN_SETTINGS,[x.externalSubject]);return (await client.query(sql,args.map(a=>a==='$request'?requestId:a))).rows[0].data;});
}

try{
 await Promise.all([admin.connect(),restricted.connect(),worker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable communication delivery validation');
 // 1. Custody and exact ACLs.
 const tables=['school_social_conversations','school_social_messages','school_social_comment_actions','school_social_inbox_receipts'];
 for(const t of tables){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const role of [runtime.username,workerUrl.username])for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
   assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[role,'hon.'+t,p]))[0].ok,false,role+':'+t+':'+p);
 }
 const inboxRuntime=['read_school_social_inbox','read_school_social_conversation','change_school_social_conversation','start_school_social_reply','record_school_social_reply_result','resolve_school_social_message','start_school_social_comment_action','record_school_social_comment_action_result'];
 const earlierRuntime=['read_school_social_accounts','start_school_social_connect','record_school_social_profile','claim_school_social_connect','record_school_social_accounts','change_school_social_account',
  'read_school_social_posts','create_school_social_post','edit_school_social_post','approve_school_social_post','cancel_school_social_post','resolve_school_social_post_target'];
 const workerEntry=['claim_school_social_post_targets','record_school_social_post_result','record_school_social_post_event','record_school_social_inbox_event'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%school_social%'");
 assert.equal(fns.length,12+16+14,fns.map(f=>f.proname).join());
 for(const f of fns){
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,[...earlierRuntime,...inboxRuntime].includes(f.proname),'runtime '+f.proname);
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[workerUrl.username,f.oid]))[0].ok,workerEntry.includes(f.proname),'worker '+f.proname);
 }
 await assert.rejects(worker.query("SELECT hon.read_school_social_inbox($1,'{\"view\":\"ALL\"}')",['x']),/permission denied/);
 await assert.rejects(restricted.query("SELECT * FROM hon.record_school_social_inbox_event('e','message.received','FACEBOOK','a','c','m',NULL,'n','t',now())"),/permission denied/);
 assert.equal((await q("SELECT count(*) n FROM hon.principals WHERE id='00000000-0000-4000-8000-00000000c349' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active"))[0].n,'1');
 pass('forced deny-all RLS on four new tables; runtime executes exactly eight inbox entry points and the worker exactly one; neither crosses over');

 const module=await Test.createTestingModule({controllers:[SchoolSocialInboxController],providers:[SchoolSocialInboxService,G.SchoolSocialReadHumanUiGuard,G.SchoolSocialInboxChangeHumanUiGuard,G.SchoolSocialInboxReplyHumanUiGuard,G.SchoolSocialInboxResolveHumanUiGuard,G.SchoolSocialInboxCommentHumanUiGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database},{provide:ZERNIO_SOCIAL_ADAPTER,useValue:fake}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 for(const x of [a,b]){await setAccess(x,'ACTIVE');
  assert.equal((await q("SELECT count(*) n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.code='OWNER' AND r.is_system_role AND rp.permission_code='marketing.social.inbox'",[x.org]))[0].n,'1');}
 const A=await seedAccounts(a,[['fb','FACEBOOK',true],['ig','INSTAGRAM',true],['fbOff','FACEBOOK',false]]),B=await seedAccounts(b,[['fbB','FACEBOOK',true]]);

 // 2. Inbound events (as the worker role): stored only for an account bound to a school with its inbox on; once per event id and message id.
 let e=dm(A.fb,'conv_1');
 assert.equal(await inbound(e),'APPLIED');assert.equal(await inbound(e),'REPLAYED');
 assert.equal(await inbound({...e,eventId:'evt_again_1'}),'DUPLICATE','the same provider message on the account is stored once');
 assert.equal(await inbound(dm(A.fb,'conv_1','Also, do you teach adults?')),'APPLIED');
 let c1=await conv(A.fb,'conv_1');assert.deepEqual([c1.kind,c1.unread,c1.provider_post_id,c1.participant_name],['DM',2,null,'Synthetic Parent']);
 assert.equal(await inbound(dm(A.fbOff,'conv_off')),'IGNORED');assert.equal(await conv(A.fbOff,'conv_off'),undefined,'nothing is kept while the inbox is off');
 assert.equal(await inbound(dm({platform:'FACEBOOK',provider_account_id:'nobody_here'},'conv_x')),'UNMATCHED');
 assert.equal(await inbound(cm(A.ig,'cmt_root')),'APPLIED');
 const c2=await conv(A.ig,'cmt_root');assert.deepEqual([c2.kind,c2.provider_post_id],['COMMENT','post_1']);
 assert.equal(await inbound(dm(A.ig,'cmt_root')),'IGNORED','a DM never lands in a comment conversation');
 assert.equal(await inbound(dm(B.fbB,'conv_b')),'APPLIED');
 // A provider time in the future or long past is replaced by the receipt time.
 assert.equal(await inbound(dm(A.fb,'conv_future','From the future',{occurredAt:new Date(Date.now()+86_400_000).toISOString()})),'APPLIED');
 assert(Date.parse((await conv(A.fb,'conv_future')).last_inbound_at)<=Date.now());
 // A DM whose last message is two days old: its reply window is closed.
 assert.equal(await inbound(dm(A.fb,'conv_old','Old question',{occurredAt:ago(48*60)})),'APPLIED');
 for(const bad of [{...dm(A.fb,'c'),eventId:'bad id!'},{...dm(A.fb,'c'),text:' '},{...dm(A.fb,'c'),text:'bell\u0007'},{...cm(A.fb,'c'),providerPostId:null},{...dm(A.fb,'c'),providerPostId:'p'},{...dm(A.fb,'c'),participantName:''}]){
  await assert.rejects(inbound(bad),/SOCIAL_INVALID/,JSON.stringify(bad).slice(0,80));}
 const receipts=(await q('SELECT outcome,count(*) n FROM hon.school_social_inbox_receipts GROUP BY outcome ORDER BY outcome')).map(r=>r.outcome+':'+r.n).join();
 assert.equal(receipts,'APPLIED:6,DUPLICATE:1,IGNORED:2,UNMATCHED:1');
 pass('inbound DMs and comments are stored only for a connected account with its inbox on, once per event id and per provider message id; a comment keeps its post; bad events are refused');

 // 3. Reads: newest first, views, cursor; each school sees only its own; one conversation with its messages.
 let L=await list(a);assert.deepEqual([L.conversations.length,L.inboxEnabled],[4,false]);
 assert(L.conversations.every(x=>x.accountId!==B.fbB.id));
 const D1=L.conversations.find(x=>x.participantName==='Synthetic Parent'&&x.preview==='Also, do you teach adults?');assert(D1);
 assert.deepEqual([D1.kind,D1.unread,D1.replyWindowOpen,D1.inboxOn,D1.platform],['DM',2,true,true,'FACEBOOK']);
 const Old=L.conversations.find(x=>x.preview==='Old question');assert.equal(Old.replyWindowOpen,false);
 const Cm=L.conversations.find(x=>x.kind==='COMMENT');assert.deepEqual([Cm.platform,Cm.replyWindowOpen,Cm.commentHidden],['INSTAGRAM',true,false]);
 assert.equal((await list(b)).conversations.length,1);
 assert.equal((await list(a,'?view=MINE')).conversations.length,0);
 assert.equal((await list(a,'?view=UNREAD')).conversations.length,4);
 const page=await list(a,'?before='+encodeURIComponent(L.conversations[1].lastMessageAt));assert(page.conversations.every(x=>Date.parse(x.lastMessageAt)<Date.parse(L.conversations[1].lastMessageAt)));
 let d=await detail(a,D1.conversationId);assert.deepEqual(d.messages.map(m=>[m.direction,m.status,m.text]),[['INBOUND','RECEIVED','Do you have kids classes on Saturday?'],['INBOUND','RECEIVED','Also, do you teach adults?']]);
 let r=await send(base(b)+'/conversations/'+D1.conversationId,{identity:b});assert.equal(r.status,404);
 r=await send(base(a)+'?view=SPAM',{identity:a});assert.equal(r.status,400);
 r=await send(base(a)+'/conversations/'+D1.conversationId+'?x=1',{identity:a});assert.equal(r.status,400);
 assert(!JSON.stringify(L).includes('conv_1')&&!JSON.stringify(d).includes('mid_'),'provider ids never leave through the API');
 pass('the inbox lists the school\'s own conversations newest first with ALL, UNREAD, MINE and a time cursor; a conversation shows its messages; another school sees none of it; provider ids stay inside');

 // 4. Change: mark read, assign to an eligible staff member, link a lead or person of this school; by version; replay.
 const me=await principalOf(a),bPerson=await principalOf(b);
 const key=K();
 let cv=C.verifySocialConversation(ok(r=await change(a,D1.conversationId,{expectedVersion:D1.version,read:true,assignedPrincipalId:me},{key})));
 assert.deepEqual([cv.unread,cv.assignedPrincipalId,cv.version,r.body.meta.replayed],[0,me,D1.version+1,false]);
 r=await change(a,D1.conversationId,{expectedVersion:D1.version,read:true,assignedPrincipalId:me},{key});assert.equal(r.body.meta.replayed,true);assert.equal(ok(r).version,cv.version);
 r=await change(a,D1.conversationId,{expectedVersion:D1.version,read:true},{key});assert.equal(r.status,409);assert.equal(r.body.code,'IDEMPOTENCY_KEY_REUSED');
 r=await change(a,D1.conversationId,{expectedVersion:D1.version,read:true});assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_VERSION_CONFLICT');
 r=await change(a,D1.conversationId,{expectedVersion:cv.version,assignedPrincipalId:bPerson});assert.equal(r.status,422);assert.equal(r.body.code,'SOCIAL_ASSIGNEE_INVALID');
 r=await change(a,D1.conversationId,{expectedVersion:cv.version,assignedPrincipalId:'00000000-0000-4000-8000-00000000c349'});assert.equal(r.status,422);
 const pA=K(),pB=K();
 await q('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5),($6,$7,$8,$4,$5)',[pA,a.org,a.school,'Synthetic','Parent',pB,b.org,b.school]);
 r=await change(a,D1.conversationId,{expectedVersion:cv.version,linkedPersonId:pB});assert.equal(r.status,422);assert.equal(r.body.code,'SOCIAL_LINK_NOT_FOUND');
 r=await change(a,D1.conversationId,{expectedVersion:cv.version,linkedLeadId:K()});assert.equal(r.status,422);assert.equal(r.body.code,'SOCIAL_LINK_NOT_FOUND');
 cv=C.verifySocialConversation(ok(await change(a,D1.conversationId,{expectedVersion:cv.version,linkedPersonId:pA})));assert.equal(cv.linkedPersonId,pA);
 const pipe={pipeline:K(),stage:K()},lead=K(),leadB=K(),pipeB={pipeline:K(),stage:K()};
 for(const [x,pp,pid,l] of [[a,pipe,pA,lead],[b,pipeB,pB,leadB]]){
  await q('INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,$4)',[pp.pipeline,x.org,x.school,'Synthetic pipeline']);
  await q('INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,$5,1)',[pp.stage,x.org,x.school,pp.pipeline,'New']);
  await q("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'OPEN')",[l,x.org,x.school,pid,pp.pipeline,pp.stage]);
 }
 r=await change(a,D1.conversationId,{expectedVersion:cv.version,linkedLeadId:leadB});assert.equal(r.status,422,'another school\'s lead');
 cv=C.verifySocialConversation(ok(await change(a,D1.conversationId,{expectedVersion:cv.version,linkedLeadId:lead})));assert.equal(cv.linkedLeadId,lead);
 cv=C.verifySocialConversation(ok(await change(a,D1.conversationId,{expectedVersion:cv.version,assignedPrincipalId:null,linkedPersonId:null})));assert.deepEqual([cv.assignedPrincipalId,cv.linkedPersonId],[null,null]);
 assert.equal((await list(a,'?view=UNREAD')).conversations.length,3);
 for(const bad of [{expectedVersion:cv.version},{expectedVersion:cv.version,read:false},{expectedVersion:cv.version,unread:5},{expectedVersion:cv.version,assignedPrincipalId:'me'}]){
  r=await change(a,D1.conversationId,bad);assert.equal(r.status,400,JSON.stringify(bad));}
 pass('a conversation is marked read, assigned only to an eligible staff member here, and linked only to this school\'s person or lead, by version, with exact replay and refused key reuse');

 // 5. Replies: nothing is recorded while replying is off; sent once with the message id as key; 24-hour DM window; account switch.
 const before=(await q('SELECT count(*) n FROM hon.school_social_messages WHERE organization_id=$1',[a.org]))[0].n;
 r=await reply(a,D1.conversationId,{text:'Yes! Saturdays at 10.'});assert.equal(r.status,503);assert.equal(r.body.code,'SOCIAL_INBOX_NOT_ENABLED');
 assert.equal((await q('SELECT count(*) n FROM hon.school_social_messages WHERE organization_id=$1',[a.org]))[0].n,before);
 fakeEnv.HON_ZERNIO_FAKE_PROVIDER='1';assert.equal((await list(a)).inboxEnabled,true);
 const rkey=K();
 let rep=C.verifySocialReplyResult(ok(r=await reply(a,D1.conversationId,{text:'Yes! Saturdays at 10.'},{key:rkey})));
 assert.deepEqual([rep.message.status,rep.message.direction,rep.message.sentByPerson,r.body.meta.replayed],['SENT','OUTBOUND',true,false]);
 assert.deepEqual(fake.replies.map(x=>[x.idempotencyKey,x.providerAccountId,x.kind,x.providerConversationId,x.text]),[[rep.message.messageId,A.fb.provider_account_id,'DM','conv_1','Yes! Saturdays at 10.']]);
 r=await reply(a,D1.conversationId,{text:'Yes! Saturdays at 10.'},{key:rkey});assert.equal(r.body.meta.replayed,true);assert.equal(fake.replies.length,1,'a replay never sends again');
 let m=await msg(rep.message.messageId);assert.match(m.provider_message_id,/^fakemsg_/);
 d=await detail(a,D1.conversationId);assert.deepEqual(d.messages.at(-1).text,'Yes! Saturdays at 10.');assert.equal(d.conversation.preview,'Yes! Saturdays at 10.');
 r=await reply(a,Old.conversationId,{text:'Sorry for the wait'});assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_REPLY_WINDOW_CLOSED');
 rep=C.verifySocialReplyResult(ok(await reply(a,Cm.conversationId,{text:'The trial week is free.'})));assert.equal(rep.message.status,'SENT');
 assert.deepEqual([fake.replies.at(-1).kind,fake.replies.at(-1).providerConversationId,fake.replies.at(-1).platform],['COMMENT','cmt_root','INSTAGRAM']);
 await accountUpdate(A.fb.id,'inbox_enabled=false');
 r=await reply(a,D1.conversationId,{text:'One more thing'});assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_INBOX_OFF');
 assert.equal((await detail(a,D1.conversationId)).conversation.inboxOn,false);
 await accountUpdate(A.fb.id,'inbox_enabled=true');
 for(const bad of [{text:''},{text:' '},{text:'x'.repeat(2001)},{text:'hi',to:'someone'}]){r=await reply(a,D1.conversationId,bad);assert.equal(r.status,400,JSON.stringify(bad).slice(0,40));}
 assert.equal(fake.replies.length,2);
 pass('replies are refused with nothing recorded while replying is off; each reply is sent exactly once with its own id as key; a DM needs the person\'s message within 24 hours; an account with its inbox off cannot reply');

 // 6. Unknown answers, an expired lease, late answers and a person's resolution; never resent.
 fake.failNext.sendReply='REJECTED';rep=C.verifySocialReplyResult(ok(await reply(a,D1.conversationId,{text:'Refused one'})));assert.equal(rep.message.status,'FAILED');
 fake.failNext.sendReply='UNKNOWN';rep=C.verifySocialReplyResult(ok(await reply(a,D1.conversationId,{text:'Lost answer'})));assert.equal(rep.message.status,'UNKNOWN');
 const lost=rep.message;
 r=await resolve(a,lost.messageId,{expectedVersion:lost.version,outcome:'SENT'});let rm=C.verifySocialMessage(ok(r));assert.deepEqual([rm.status,rm.resolvedByPerson],['SENT',true]);
 r=await resolve(a,lost.messageId,{expectedVersion:rm.version,outcome:'NOT_SENT'});assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_INBOX_STATE');
 // A send whose answer never arrives: started directly, then its lease runs out.
 const started=await asPerson(a,'SELECT hon.start_school_social_reply($1,$2::uuid,$3::jsonb,$4,$5::uuid,$5::uuid) data',[a.externalSubject,D1.conversationId,JSON.stringify({text:'Never answered'}),K(),'$request']);
 const sendInfo=started.send;assert.equal(started.record.message.status,'SENDING');
 await q('ALTER TABLE hon.school_social_messages DISABLE TRIGGER guarded');
 await q("UPDATE hon.school_social_messages SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[sendInfo.messageId]);
 await q('ALTER TABLE hon.school_social_messages ENABLE TRIGGER guarded');
 assert.equal((await detail(a,D1.conversationId)).messages.find(x=>x.messageId===sendInfo.messageId).status,'UNKNOWN','an expired lease reads as UNKNOWN');
 const late=(outcome,token,id)=>asPerson(a,'SELECT hon.record_school_social_reply_result($1,$2::uuid,$3::uuid,$4,$5,$6::uuid,$6::uuid) data',[a.externalSubject,sendInfo.messageId,token,outcome,id,'$request']);
 let lr=await late('SENT',K(),'mid_late_1');assert.equal(lr.accepted,false,'wrong lease token');
 lr=await late('SENT',sendInfo.leaseToken,'mid_late_1');assert.deepEqual([lr.message.status,lr.accepted],['SENT',true]);
 lr=await late('FAILED',sendInfo.leaseToken,null);assert.deepEqual([lr.message.status,lr.accepted],['SENT',false]);
 await assert.rejects(late('SENT',sendInfo.leaseToken,null),/SOCIAL_INVALID/);
 // A provider id another message holds is not trusted; a late answer never overrides a person.
 const s2=await asPerson(a,'SELECT hon.start_school_social_reply($1,$2::uuid,$3::jsonb,$4,$5::uuid,$5::uuid) data',[a.externalSubject,D1.conversationId,JSON.stringify({text:'Duplicate id'}),K(),'$request']);
 lr=await asPerson(a,'SELECT hon.record_school_social_reply_result($1,$2::uuid,$3::uuid,$4,$5,$6::uuid,$6::uuid) data',[a.externalSubject,s2.send.messageId,s2.send.leaseToken,'SENT','mid_late_1','$request']);
 assert.deepEqual([lr.message.status,lr.accepted],['UNKNOWN',true]);
 rm=C.verifySocialMessage(ok(await resolve(a,s2.send.messageId,{expectedVersion:lr.message.version,outcome:'NOT_SENT'})));assert.equal(rm.status,'FAILED');
 lr=await asPerson(a,'SELECT hon.record_school_social_reply_result($1,$2::uuid,$3::uuid,$4,$5,$6::uuid,$6::uuid) data',[a.externalSubject,s2.send.messageId,s2.send.leaseToken,'SENT','mid_late_2','$request']);
 assert.deepEqual([lr.message.status,lr.accepted],['FAILED',false]);
 r=await resolve(a,D1.conversationId,{expectedVersion:1,outcome:'SENT'});assert.equal(r.status,404);
 const inboundId=(await detail(a,D1.conversationId)).messages[0].messageId;r=await resolve(a,inboundId,{expectedVersion:1,outcome:'SENT'});assert.equal(r.status,409,'an inbound message cannot be resolved');
 assert.equal(fake.replies.length,2,'none of these were sent again');
 pass('only a definite refusal is FAILED; a lost answer or expired lease is UNKNOWN and never resent; a late answer counts only under its own lease; a reused provider id stays UNKNOWN; a person settles an UNKNOWN once');

 // 7. Comments: hide and unhide once per request, only on comment conversations.
 r=await comment(a,D1.conversationId,{action:'HIDE'});assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_INBOX_STATE');
 r=await comment(a,Cm.conversationId,{action:'UNHIDE'});assert.equal(r.status,409,'unhiding a visible comment');
 let ca=C.verifySocialCommentActionResult(ok(await comment(a,Cm.conversationId,{action:'HIDE'})));assert.deepEqual([ca.status,ca.conversation.commentHidden],['DONE',true]);
 assert.deepEqual(fake.commentActions.map(x=>[x.providerCommentId,x.hidden,x.idempotencyKey]),[['cmt_root',true,ca.actionId]]);
 r=await comment(a,Cm.conversationId,{action:'HIDE'});assert.equal(r.status,409);
 fake.failNext.setCommentHidden='UNKNOWN';ca=C.verifySocialCommentActionResult(ok(await comment(a,Cm.conversationId,{action:'UNHIDE'})));assert.deepEqual([ca.status,ca.conversation.commentHidden],['UNKNOWN',true]);
 fake.failNext.setCommentHidden='REJECTED';ca=C.verifySocialCommentActionResult(ok(await comment(a,Cm.conversationId,{action:'UNHIDE'})));assert.deepEqual([ca.status,ca.conversation.commentHidden],['FAILED',true]);
 ca=C.verifySocialCommentActionResult(ok(await comment(a,Cm.conversationId,{action:'UNHIDE'})));assert.deepEqual([ca.status,ca.conversation.commentHidden],['DONE',false]);
 // A request still in flight blocks a second one.
 const open=await asPerson(a,'SELECT hon.start_school_social_comment_action($1,$2::uuid,$3::jsonb,$4,$5::uuid,$5::uuid) data',[a.externalSubject,Cm.conversationId,'{"action":"HIDE"}',K(),'$request']);
 r=await comment(a,Cm.conversationId,{action:'HIDE'});assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_BUSY');
 const wrong=await asPerson(a,'SELECT hon.record_school_social_comment_action_result($1,$2::uuid,$3::uuid,$4,$5::uuid,$5::uuid) data',[a.externalSubject,open.send.actionId,K(),'DONE','$request']);
 assert.deepEqual([wrong.accepted,wrong.status,wrong.conversation.commentHidden],[false,'SENDING',false]);
 for(const bad of [{},{action:'DELETE'},{action:'HIDE',reason:'spam'}]){r=await comment(a,Cm.conversationId,bad);assert.equal(r.status,400);}
 assert.equal(fake.commentActions.length,2,'the fake records only the two requests it carried out');
 pass('hide and unhide work only on comments, each request is sent once under its own id; unknown and refused answers leave the shown state unchanged; a request in flight blocks another');

 // 8. Authority and isolation: another school, missing permission, wrong commands, query values, delegation, suspended access.
 const ev0=await evidence(a);
 r=await send(base(a),{identity:b});assert.equal(r.status,403);
 r=await change(b,D1.conversationId,{expectedVersion:cv.version,read:true});assert.equal(r.status,404);
 r=await reply(b,D1.conversationId,{text:'Not my school'});assert.equal(r.status,404);
 r=await send(`organizations/${a.org}/schools/${b.school}/marketing/social/inbox`,{identity:b});assert.equal(r.status,403);
 r=await change(a,D1.conversationId,{expectedVersion:cv.version,read:true},{command:C.SOCIAL_INBOX_REPLY_COMMAND});assert.equal(r.status,403);
 r=await reply(a,D1.conversationId,{text:'x'},{command:C.SOCIAL_INBOX_CHANGE_COMMAND});assert.equal(r.status,403);
 r=await reply(a,D1.conversationId,{text:'x'},{headers:{'x-hon-delegated-by-principal-id':K()}});assert.equal(r.status,403);
 r=await send(base(a)+'/conversations/'+D1.conversationId+'/reply?schoolId='+b.school,{identity:a,method:'POST',command:C.SOCIAL_INBOX_REPLY_COMMAND,body:{text:'x'}});assert.equal(r.status,400);
 r=await reply({...person('stranger'),org:a.org,school:a.school},D1.conversationId,{text:'x'});assert.equal(r.status,403);
 await q("DELETE FROM hon.role_permissions WHERE organization_id=$1 AND permission_code='marketing.social.inbox'",[a.org]);
 r=await send(base(a),{identity:a});assert.equal(r.status,403,'reading the inbox needs marketing.social.inbox');
 r=await reply(a,D1.conversationId,{text:'x'});assert.equal(r.status,403);
 await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT id,organization_id,'marketing.social.inbox' FROM hon.roles WHERE organization_id=$1 AND code='OWNER' AND is_system_role",[a.org]);
 await setAccess(a,'SUSPENDED');r=await reply(a,D1.conversationId,{text:'x'});assert.equal(r.status,403);await setAccess(a,'ACTIVE');
 assert.deepEqual(await evidence(a),ev0,'refusals write nothing');
 assert.equal(fake.replies.length,2);
 pass('another school, missing inbox permission, wrong browser commands, delegation, query values, an unknown person and suspended access are refused with nothing written or sent');

 // 9. Evidence is identifiers only, and the records cannot be rewritten.
 const ev=await evidence(a);assert(Number(ev.a)>=12);assert.equal(ev.a,ev.o);
 const trail=(await q("SELECT coalesce(next_state::text,'') s FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'marketing.social.inbox%' UNION ALL SELECT payload::text FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'marketing.social.inbox%'",[a.org])).map(x=>x.s).join();
 assert(!/Saturday|trial|Synthetic|fakemsg_|mid_|cmt_|conv_|fb_/.test(trail),trail.slice(0,300));
 assert.equal((await q("SELECT count(*) n FROM hon.audit_events WHERE organization_id=$1 AND action_code='marketing.social.inbox.received'",[a.org]))[0].n,'5');
 const sent=(await q("SELECT * FROM hon.school_social_messages WHERE organization_id=$1 AND send_status='SENT' AND resolved_by_principal_id IS NULL LIMIT 1",[a.org]))[0];
 await assert.rejects(q("UPDATE hon.school_social_messages SET body='rewritten',version=version+1 WHERE id=$1",[sent.id]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_messages SET send_status='FAILED',version=version+1 WHERE id=$1",[sent.id]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_messages SET body='rewritten',version=version+1 WHERE id=$1",[inboundId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_conversations SET school_id=$2,version=version+1 WHERE id=$1",[D1.conversationId,b.school]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q('DELETE FROM hon.school_social_messages WHERE id=$1',[inboundId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_comment_actions SET status='DONE',version=version+1 WHERE status='FAILED'"),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_inbox_receipts SET outcome='APPLIED'"),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q('TRUNCATE hon.school_social_inbox_receipts'),/SOCIAL_RECORD_IMMUTABLE/);
 pass('audit and outbox carry identifiers only (no message text, names or provider ids); messages, conversations, comment actions and receipts cannot be rewritten, moved, deleted or truncated');
 console.log('PASS: school social inbox (0349), '+groups+' groups');
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await store.onModuleDestroy();await Promise.allSettled([admin.end(),restricted.end(),worker.end()]);}
