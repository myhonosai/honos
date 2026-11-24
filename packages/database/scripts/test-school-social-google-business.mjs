/** School Google Business Profile (0455): real signed HON sessions -> Nest/guards -> fixed runtime SQL and the worker
 *  role -> marked disposable PostgreSQL (the communication delivery fixture). Zernio is the deterministic in-process fake
 *  adapter only; nothing is posted anywhere. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point;
 *  the owner connection stands in for paid access and seeds connected accounts (0347 is proven separately). All names
 *  and post text are synthetic. */
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
const {SchoolSocialPostsController}=require('./dist/marketing/social/school-social-posts.controller.js');
const {SchoolSocialPostsService}=require('./dist/marketing/social/school-social-posts.service.js');
const {SOCIAL_HUMAN_SETTINGS}=require('./dist/marketing/social/school-social.service.js');
const G=require('./dist/marketing/social/school-social.guard.js');
const {FakeZernioSocialAdapter,ZERNIO_SOCIAL_ADAPTER}=require('./dist/marketing/social/zernio-social-adapter.js');
const {SocialPostDispatcher}=require('./dist/marketing/social/social-post-dispatcher.js');
const {CommunicationWorkerDatabase}=require('./dist/communication/delivery/communication-worker-database.js');
const C=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),worker=new pg.Client({connectionString:workerUrl.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'social-gbp-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
// The fake adapter reads its switch from this object only; the proof turns publishing on and off.
const fakeEnv={HON_DEPLOYMENT_ENVIRONMENT:'development'};const fake=new FakeZernioSocialAdapter(()=>fakeEnv);
const store=new CommunicationWorkerDatabase();const dispatcher=new SocialPostDispatcher(store,fake);
const pass=name=>console.log('PASS GOOGLE BUSINESS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const w=async(sql,args=[])=>(await worker.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command=C.SOCIAL_POST_CREATE_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const person=label=>({externalSubject:'oidc:gbp:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=person(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:C.SIGNUP_CONFIRMATION},K()])).rows[0].data;
 return {...p,org:r.organizationId,school:r.schoolId};}
const setAccess=(x,status)=>q("UPDATE hon.organization_entitlements SET status=$2,effective_from=clock_timestamp()-interval '1 day',effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1",[x.org,status]);
const base=x=>`organizations/${x.org}/schools/${x.school}/marketing/social`;
const create=(x,body,extra={})=>send(base(x)+'/posts',{identity:x,method:'POST',body,...extra});
const edit=(x,id,body,extra={})=>send(base(x)+'/posts/'+id,{identity:x,method:'POST',command:C.SOCIAL_POST_EDIT_COMMAND,body,...extra});
const approve=(x,id,body,extra={})=>send(base(x)+'/posts/'+id+'/approve',{identity:x,method:'POST',command:C.SOCIAL_POST_APPROVE_COMMAND,body,...extra});
const cancel=(x,id,body,extra={})=>send(base(x)+'/posts/'+id+'/cancel',{identity:x,method:'POST',command:C.SOCIAL_POST_CANCEL_COMMAND,body,...extra});
const resolve=(x,id,body,extra={})=>send(base(x)+'/post-targets/'+id+'/resolve',{identity:x,method:'POST',command:C.SOCIAL_POST_RESOLVE_COMMAND,body,...extra});
const calendar=async(x,from=new Date(Date.now()-86_400_000),to=new Date(Date.now()+95*86_400_000))=>C.verifySocialPostList(ok(await send(base(x)+`/posts?${new URLSearchParams({from:from.toISOString(),to:to.toISOString()})}`,{identity:x})));
const target=async id=>(await q('SELECT * FROM hon.school_social_post_targets WHERE id=$1',[id]))[0];
// Seed a school's Zernio profile and connected accounts directly (connecting itself is the 0347 proof).
async function seedAccounts(x,accounts){
 const ownerId=(await q('SELECT p.id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE u.external_subject=$1',[x.externalSubject]))[0].id;
 await q("INSERT INTO hon.school_social_profiles(organization_id,school_id,provider_profile_id,linked_by_principal_id) VALUES($1,$2,$3,$4)",[x.org,x.school,'prof_'+x.school.slice(0,8),ownerId]);
 const out={};
 for(const [name,platform,publish] of accounts){
  out[name]=(await q("INSERT INTO hon.school_social_accounts(organization_id,school_id,platform,provider_account_id,display_name,status,publish_enabled,connected_by_principal_id) VALUES($1,$2,$3,$4,$5,'CONNECTED',$6,$7) RETURNING id,provider_account_id",
   [x.org,x.school,platform,name+'_'+x.school.slice(0,8),'Synthetic '+name,publish,ownerId]))[0];
 }
 return out;
}
const accountUpdate=(id,sets)=>q(`UPDATE hon.school_social_accounts SET ${sets},version=version+1,updated_at=clock_timestamp() WHERE id=$1`,[id]);
const evidence=async x=>(await q("SELECT (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'marketing.social.post%') a,(SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'marketing.social.post%') o",[x.org]))[0];
const asPerson=async(x,sql,args,permission='marketing.social.manage')=>{
 const scope=await database.resolveAuthorizedScope(x.externalSubject,x.school,permission);assert(scope);
 const requestId=K();
 return database.withTenantTransaction({...scope,principalType:'HUMAN_USER',requestId,correlationId:requestId,idempotencyKey:'',source:'HUMAN_UI',externalSubject:x.externalSubject},
  async client=>{await client.query(SOCIAL_HUMAN_SETTINGS,[x.externalSubject]);return (await client.query(sql,args.map(v=>v==='$request'?requestId:v))).rows[0].data;});
};
const platforms=[];const publishPost=fake.publishPost.bind(fake);fake.publishPost=async input=>{platforms.push(input.platform);return publishPost(input);};

try{
 await Promise.all([admin.connect(),restricted.connect(),worker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable communication delivery validation');
 // 1. No new entry points: 0455 only replaces five reviewed functions, which keep their exact grants.
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%school_social%'");
 assert.equal(fns.length,12+16+14+12+2,fns.map(f=>f.proname).join());
 for(const [fn,rt,wk] of [['start_school_social_connect(text,jsonb,text,uuid,uuid)',true,false],['change_school_social_account(text,uuid,jsonb,text,uuid,uuid)',true,false],
  ['school_social_post_fields(uuid,uuid,jsonb,boolean)',false,false],['claim_school_social_post_targets(integer,integer)',false,true],['record_school_social_post_event(text,text,text,text,text)',false,true]]){
  const oid=(await q('SELECT $1::regprocedure::oid o',['hon.'+fn]))[0].o;
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,oid]))[0].ok,rt,'runtime '+fn);
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[workerUrl.username,oid]))[0].ok,wk,'worker '+fn);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[oid]))[0].ok,false,'public '+fn);
 }
 pass('no new entry points: the five replaced functions keep exactly their reviewed runtime and worker grants, and PUBLIC executes none');

 const module=await Test.createTestingModule({controllers:[SchoolSocialPostsController],providers:[SchoolSocialPostsService,G.SchoolSocialReadHumanUiGuard,G.SchoolSocialPostCreateHumanUiGuard,G.SchoolSocialPostEditHumanUiGuard,G.SchoolSocialPostApproveHumanUiGuard,G.SchoolSocialPostCancelHumanUiGuard,G.SchoolSocialPostResolveHumanUiGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database},{provide:ZERNIO_SOCIAL_ADAPTER,useValue:fake}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 for(const x of [a,b])await setAccess(x,'ACTIVE');
 const A=await seedAccounts(a,[['fb','FACEBOOK',true],['gads','GOOGLE_ADS',false]]),B=await seedAccounts(b,[['gbpB','GOOGLE_BUSINESS',true]]);
 const ownerA=(await q('SELECT p.id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE u.external_subject=$1',[a.externalSubject]))[0].id;

 // 2. Connecting: GOOGLE_BUSINESS is a connectable platform; a Google Business Profile only ever publishes.
 const hash=()=>createHash('sha256').update(K()).digest('hex');
 const intent=await asPerson(a,'SELECT hon.start_school_social_connect($1,$2::jsonb,$3,$4::uuid,$4::uuid) data',[a.externalSubject,JSON.stringify({platform:'GOOGLE_BUSINESS'}),hash(),'$request']);
 assert.equal(intent.platform,'GOOGLE_BUSINESS');
 for(const bad of [{inbox_enabled:true},{ads_enabled:true}])
  await assert.rejects(q(`INSERT INTO hon.school_social_accounts(organization_id,school_id,platform,provider_account_id,display_name,status,${Object.keys(bad)[0]},connected_by_principal_id) VALUES($1,$2,'GOOGLE_BUSINESS',$3,'Synthetic bad','CONNECTED',true,$4)`,[a.org,a.school,'gbp_bad_'+K().slice(0,8),ownerA]),/school_social_accounts_google_business_only/);
 const gbp=(await q("INSERT INTO hon.school_social_accounts(organization_id,school_id,platform,provider_account_id,display_name,status,connected_by_principal_id) VALUES($1,$2,'GOOGLE_BUSINESS',$3,'Synthetic Dojo (Google)','CONNECTED',$4) RETURNING *",[a.org,a.school,'gbp_'+a.school.slice(0,8),ownerA]))[0];
 const change=input=>asPerson(a,'SELECT hon.change_school_social_account($1,$2::uuid,$3::jsonb,$4,$5::uuid,$5::uuid) data',[a.externalSubject,gbp.id,JSON.stringify(input),K(),'$request']);
 for(const bad of [{expectedVersion:1,publishEnabled:true,inboxEnabled:true,adsEnabled:false},{expectedVersion:1,publishEnabled:true,inboxEnabled:false,adsEnabled:true}])
  await assert.rejects(change(bad),/SOCIAL_INVALID/,JSON.stringify(bad));
 assert.equal((await q('SELECT version v FROM hon.school_social_accounts WHERE id=$1',[gbp.id]))[0].v,1,'a refused change writes nothing');
 let acct=C.verifySocialAccount((await change({expectedVersion:1,publishEnabled:true,inboxEnabled:false,adsEnabled:false})).record);
 assert.deepEqual([acct.platform,acct.publishEnabled,acct.inboxEnabled,acct.adsEnabled],['GOOGLE_BUSINESS',true,false,false]);
 assert.throws(()=>C.verifySocialAccount({...acct,inboxEnabled:true}),/account/);
 pass('GOOGLE_BUSINESS can be connected; its inbox and ads switches stay off (table check, change command and contract) and posting can be turned on');

 // 3. Drafts: a Google Business Profile is a post target for text up to 1,500 characters; Google Ads never is.
 const long='Synthetic open house. '.repeat(70).slice(0,1501);
 let r=await create(a,{text:long,accountIds:[gbp.id]});assert.equal(r.status,400);assert.equal(r.body.code,'SOCIAL_TEXT_TOO_LONG');
 r=await create(a,{text:long,accountIds:[A.fb.id,gbp.id]});assert.equal(r.body.code,'SOCIAL_TEXT_TOO_LONG');
 assert.equal(C.verifySocialPost(ok(await create(a,{text:long,accountIds:[A.fb.id]}))).status,'DRAFT','Facebook alone keeps the 2,200 limit');
 r=await create(a,{text:'Synthetic trial week',accountIds:[A.gads.id]});assert.equal(r.status,404);
 r=await create(a,{text:'Synthetic trial week',accountIds:[B.gbpB.id]});assert.equal(r.status,404,'another school\'s profile is not a target');
 let p=C.verifySocialPost(ok(await create(a,{text:long.slice(0,1500),accountIds:[A.fb.id,gbp.id],linkUrl:'https://dojo.example.invalid/trial'})));
 r=await edit(a,p.postId,{text:long,accountIds:[A.fb.id,gbp.id],expectedVersion:1});assert.equal(r.body.code,'SOCIAL_TEXT_TOO_LONG','an edit is held to the same limit');
 pass('a Google Business Profile is a post target for text up to 1,500 characters (create and edit); a Google Ads account or another school\'s profile never is');

 // 4. Approval and publishing: the reviewed lease path, once per target, with the Google profile as its own target.
 await accountUpdate(gbp.id,'publish_enabled=false');
 p=C.verifySocialPost((await calendar(a)).posts.find(x=>x.postId===p.postId));
 r=await approve(a,p.postId,{expectedVersion:p.version});assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_PUBLISH_OFF');
 await accountUpdate(gbp.id,'publish_enabled=true');
 fakeEnv.HON_ZERNIO_FAKE_PROVIDER='1';
 p=C.verifySocialPost(ok(await approve(a,p.postId,{expectedVersion:p.version})));
 assert.deepEqual(p.targets.map(t=>t.platform).sort(),['FACEBOOK','GOOGLE_BUSINESS']);
 const gTarget=p.targets.find(t=>t.platform==='GOOGLE_BUSINESS').targetId;
 for(let i=0;i<5&&(await target(gTarget)).status==='PENDING';i++)await dispatcher.runOnce();
 let t=await target(gTarget);assert.equal(t.status,'PUBLISHED');assert.match(t.provider_post_id,/^fakepost_/);
 const sent=fake.published.filter(x=>x.idempotencyKey===gTarget);
 assert.deepEqual(sent.map(x=>[x.providerAccountId,x.text,x.linkUrl]),[[gbp.provider_account_id,long.slice(0,1500),'https://dojo.example.invalid/trial']]);
 assert(platforms.includes('GOOGLE_BUSINESS'));
 await dispatcher.runOnce();assert.equal(fake.published.filter(x=>x.idempotencyKey===gTarget).length,1,'never sent twice');
 // A due target whose profile has posting turned off is skipped, not sent.
 let off=C.verifySocialPost(ok(await create(a,{text:'Synthetic belt test Friday',accountIds:[gbp.id]})));
 off=C.verifySocialPost(ok(await approve(a,off.postId,{expectedVersion:1})));
 await accountUpdate(gbp.id,'publish_enabled=false');
 for(let i=0;i<5&&(await target(off.targets[0].targetId)).status==='PENDING';i++)await dispatcher.runOnce();
 t=await target(off.targets[0].targetId);assert.deepEqual([t.status,t.skip_reason],['SKIPPED','ACCOUNT_OFF']);
 assert.equal(fake.published.filter(x=>x.idempotencyKey===t.id).length,0);
 await accountUpdate(gbp.id,'publish_enabled=true');
 pass('approval needs posting on; the worker publishes a Google Business Profile target once through the fake with its text and link, and skips it when posting is off');

 // 5. Signed Zernio receipts (worker role) settle Google Business Profile targets and disconnect the profile.
 const event=(id,type,platform,acctId,post)=>w('SELECT * FROM hon.record_school_social_post_event($1,$2,$3,$4,$5)',[id,type,platform,acctId,post]).then(x=>x[0].outcome);
 const pubId=(await target(gTarget)).provider_post_id,ev=()=>'evt_gbp_'+K().slice(0,12);
 assert.equal(await event(ev(),'post.failed','FACEBOOK',gbp.provider_account_id,pubId),'UNMATCHED','the platform must match the account');
 assert.equal(await event(ev(),'post.failed','GOOGLE_BUSINESS',B.gbpB.provider_account_id,pubId),'UNMATCHED','another school\'s profile never settles this post');
 assert.equal(await event(ev(),'post.failed','GOOGLE_BUSINESS',gbp.provider_account_id,pubId),'APPLIED');
 t=await target(gTarget);assert.deepEqual([t.status,t.failure_code],['FAILED','PROVIDER_REPORTED_FAILED']);
 await assert.rejects(event(ev(),'post.failed','GOOGLE_ADS',A.gads.provider_account_id,pubId),/SOCIAL_INVALID/);
 assert.equal(await event(ev(),'account.disconnected','GOOGLE_BUSINESS',gbp.provider_account_id,null),'APPLIED');
 const gone=(await q('SELECT status,publish_enabled FROM hon.school_social_accounts WHERE id=$1',[gbp.id]))[0];assert.deepEqual([gone.status,gone.publish_enabled],['DISCONNECTED',false]);
 r=await create(a,{text:'Synthetic after disconnect',accountIds:[gbp.id]});assert.equal(r.status,409);
 pass('signed receipts settle a Google Business Profile target only on its own platform and account; a disconnect turns the profile off and it can no longer be a target');
 console.log('PASS: school Google Business Profile (0455), '+groups+' groups');
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await store.onModuleDestroy();await Promise.allSettled([admin.end(),restricted.end(),worker.end()]);}
