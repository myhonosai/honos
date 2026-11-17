/** School Google ads (0453): real signed HON sessions -> Nest/guards -> fixed runtime SQL -> marked disposable
 *  PostgreSQL (the communication delivery fixture). Zernio is the deterministic in-process fake adapter only; nothing is
 *  created, turned on or spent anywhere, at Google or Meta. Schools are SYNTHETIC sign-ups made through the 0241 runtime
 *  entry point; the owner connection stands in for paid access and seeds connected accounts (0347 is proven
 *  separately). All names and ad text are synthetic. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??''),workerUrl=new URL(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_comm_delivery_owner'],[runtime,'hon_comm_delivery_runtime'],[workerUrl,'hon_comm_delivery_worker']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_comm_delivery_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|SENDGRID.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|META.*|FACEBOOK.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|ZERNIO).*)$/i.test(key),key);
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {SchoolSocialAdsController}=require('./dist/marketing/social/school-social-ads.controller.js');
const {SchoolSocialAdsService}=require('./dist/marketing/social/school-social-ads.service.js');
const {SOCIAL_HUMAN_SETTINGS}=require('./dist/marketing/social/school-social.service.js');
const G=require('./dist/marketing/social/school-social.guard.js');
const {FakeZernioSocialAdapter,ZERNIO_SOCIAL_ADAPTER}=require('./dist/marketing/social/zernio-social-adapter.js');
const C=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),worker=new pg.Client({connectionString:workerUrl.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'social-google-ads-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
// The fake adapter reads its switch from this object only; the proof turns ads on and off.
const fakeEnv={HON_DEPLOYMENT_ENVIRONMENT:'development'};const fake=new FakeZernioSocialAdapter(()=>fakeEnv);
const pass=name=>console.log('PASS GOOGLE ADS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command=C.SOCIAL_AD_OPERATION_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const refused=(r,status,code)=>{assert.equal(r.status,status,JSON.stringify(r.body));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));};
const person=label=>({externalSubject:'oidc:gads:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=person(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:C.SIGNUP_CONFIRMATION},K()])).rows[0].data;
 return {...p,org:r.organizationId,school:r.schoolId};}
const setAccess=(x,status)=>q("UPDATE hon.organization_entitlements SET status=$2,effective_from=clock_timestamp()-interval '1 day',effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1",[x.org,status]);
const base=x=>`organizations/${x.org}/schools/${x.school}/marketing/social/ads`;
const view=async x=>C.verifySocialAdsView(ok(await send(base(x),{identity:x})));
const budget=(x,body,extra={})=>send(base(x)+'/budget',{identity:x,method:'POST',command:C.SOCIAL_ADS_BUDGET_COMMAND,body,...extra});
const draft=(x,body,extra={})=>send(base(x),{identity:x,method:'POST',command:C.SOCIAL_AD_CREATE_COMMAND,body,...extra});
const operate=(x,id,body,extra={})=>send(base(x)+'/'+id+'/operation',{identity:x,method:'POST',command:C.SOCIAL_AD_OPERATION_COMMAND,body,...extra});
const cancel=(x,id,body,extra={})=>send(base(x)+'/'+id+'/cancel',{identity:x,method:'POST',command:C.SOCIAL_AD_CANCEL_COMMAND,body,...extra});
const settle=(x,id,body,extra={})=>send(base(x)+'/'+id+'/resolve',{identity:x,method:'POST',command:C.SOCIAL_AD_RESOLVE_COMMAND,body,...extra});
const adOf=r=>C.verifySocialAd(ok(r));
const op=async(x,ad,operation,extra)=>adOf(await operate(x,ad.adId,{operation,expectedVersion:ad.version},extra));
const principalOf=async x=>(await q('SELECT p.id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE u.external_subject=$1',[x.externalSubject]))[0].id;
async function seedAccounts(x,accounts){
 const ownerId=await principalOf(x);
 await q("INSERT INTO hon.school_social_profiles(organization_id,school_id,provider_profile_id,linked_by_principal_id) VALUES($1,$2,$3,$4)",[x.org,x.school,'prof_'+x.school.slice(0,8),ownerId]);
 const out={};
 for(const [name,platform,ads] of accounts){
  out[name]=(await q("INSERT INTO hon.school_social_accounts(organization_id,school_id,platform,provider_account_id,display_name,status,publish_enabled,ads_enabled,connected_by_principal_id) VALUES($1,$2,$3,$4,$5,'CONNECTED',true,$6,$7) RETURNING id,provider_account_id,platform",
   [x.org,x.school,platform,name+'_'+x.school.slice(0,8),'Synthetic '+name,ads,ownerId]))[0];
 }
 return out;
}
// A post HON already published (or failed to) on one account, as the 0348 worker would have left it.
let seq=0;
async function target(x,acct,status='PUBLISHED'){
 const ownerId=await principalOf(x);
 const post=(await q("INSERT INTO hon.school_social_posts(organization_id,school_id,body,account_ids,status,publish_at,drafted_by_principal_id,approved_by_principal_id,approved_at) VALUES($1,$2,'Synthetic open house this Saturday',ARRAY[$3::uuid],'APPROVED',clock_timestamp(),$4,$4,clock_timestamp()) RETURNING id",[x.org,x.school,acct.id,ownerId]))[0].id;
 const published=status==='PUBLISHED';
 return (await q(`INSERT INTO hon.school_social_post_targets(post_id,organization_id,school_id,account_id,status,due_at,lease_token,attempted_at,provider_post_id,failure_code,settled_at)
  VALUES($1,$2,$3,$4,$5,clock_timestamp(),gen_random_uuid(),clock_timestamp(),$6,$7,clock_timestamp()) RETURNING id`,[post,x.org,x.school,acct.id,status,published?'fbpost_'+(++seq)+'_'+K().slice(0,8):null,published?null:'PROVIDER_REJECTED']))[0].id;
}
const accountUpdate=(id,sets)=>q(`UPDATE hon.school_social_accounts SET ${sets},version=version+1,updated_at=clock_timestamp() WHERE id=$1`,[id]);
const row=async id=>(await q('SELECT * FROM hon.school_social_ads WHERE id=$1',[id]))[0];
const evidence=async x=>(await q("SELECT (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'marketing.social.ads%') a,(SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'marketing.social.ads%') o",[x.org]))[0];
const day=(d,n=0)=>new Date(Date.parse(d+'T00:00:00Z')+n*86_400_000).toISOString().slice(0,10);
const firstOfNextMonth=d=>{const t=new Date(d+'T00:00:00Z');return new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth()+1,1)).toISOString().slice(0,10);};
// Calls one runtime ads function directly as the verified person (for late answers the API never sends itself).
async function asPerson(x,sql,args,permission='marketing.social.ads'){
 const scope=await database.resolveAuthorizedScope(x.externalSubject,x.school,permission);assert(scope);
 const requestId=K();
 return database.withTenantTransaction({...scope,principalType:'HUMAN_USER',requestId,correlationId:requestId,idempotencyKey:'',source:'HUMAN_UI',externalSubject:x.externalSubject},
  async client=>{await client.query(SOCIAL_HUMAN_SETTINGS,[x.externalSubject]);return (await client.query(sql,args.map(a=>a==='$request'?requestId:a))).rows[0].data;});
}
const gbase=x=>base(x)+'/google';
const gdraft=(x,body,extra={})=>send(gbase(x),{identity:x,method:'POST',command:C.SOCIAL_GOOGLE_AD_CREATE_COMMAND,body,...extra});
const text={headlines:['Synthetic Kids Karate','Free Trial Week','Book A Class Today'],descriptions:['Synthetic classes for every age and level.','Your first week is free.'],
 finalUrl:'https://dojo.example.invalid/trial',keywords:['kids karate','martial arts classes']};
async function expireLease(adId){
 await q('ALTER TABLE hon.school_social_ads DISABLE TRIGGER guarded');
 try{await q("UPDATE hon.school_social_ads SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[adId]);}
 finally{await q('ALTER TABLE hon.school_social_ads ENABLE TRIGGER guarded');}
}
const startDirect=(x,ad,operation)=>asPerson(x,'SELECT hon.start_school_social_ad_operation($1,$2::uuid,$3::jsonb,$4,$5::uuid,$5::uuid) data',[x.externalSubject,ad.adId,JSON.stringify({operation,expectedVersion:ad.version}),K(),'$request']);

try{
 await Promise.all([admin.connect(),restricted.connect(),worker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable communication delivery validation');
 // 1. Exact ACLs: the runtime gains exactly one entry point (the Google draft); the text check and the worker get nothing.
 const draftFn=(await q("SELECT 'hon.create_school_social_google_ad(text,jsonb,text,uuid,uuid)'::regprocedure::oid o"))[0].o,textFn=(await q("SELECT 'hon.school_social_google_texts_ok(jsonb,integer,integer,integer,boolean)'::regprocedure::oid o"))[0].o;
 for(const [fn,runtimeOk] of [[draftFn,true],[textFn,false]]){
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,fn]))[0].ok,runtimeOk);
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[workerUrl.username,fn]))[0].ok,false);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[fn]))[0].ok,false);
 }
 assert.equal((await q("SELECT prosecdef d FROM pg_proc WHERE oid=$1",[draftFn]))[0].d,true);
 await assert.rejects(worker.query('SELECT hon.create_school_social_google_ad($1,$2::jsonb,$3,gen_random_uuid(),gen_random_uuid())',['x','{}','k']),/permission denied/);
 pass('the runtime executes exactly the one new Google draft entry point; the text check, the worker and PUBLIC execute nothing new');

 const module=await Test.createTestingModule({controllers:[SchoolSocialAdsController],providers:[SchoolSocialAdsService,G.SchoolSocialReadHumanUiGuard,G.SchoolSocialAdBudgetHumanUiGuard,G.SchoolSocialAdCreateHumanUiGuard,G.SchoolSocialGoogleAdCreateHumanUiGuard,G.SchoolSocialAdOperationHumanUiGuard,G.SchoolSocialAdCancelHumanUiGuard,G.SchoolSocialAdResolveHumanUiGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database},{provide:ZERNIO_SOCIAL_ADAPTER,useValue:fake}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 for(const x of [a,b])await setAccess(x,'ACTIVE');
 const A=await seedAccounts(a,[['fb','FACEBOOK',true]]),B=await seedAccounts(b,[['gB','FACEBOOK',false]]);
 const ownerA=await principalOf(a);
 const today=(await q("SELECT to_char(hon.school_social_today($1),'YYYY-MM-DD') d",[a.school]))[0].d;

 // 2. Connecting: GOOGLE_ADS is a connectable platform; a Google Ads account can only ever run ads.
 const intent=await asPerson(a,'SELECT hon.start_school_social_connect($1,$2::jsonb,$3,$4::uuid,$4::uuid) data',[a.externalSubject,JSON.stringify({platform:'GOOGLE_ADS'}),createHash('sha256').update(K()).digest('hex'),'$request'],'marketing.social.manage');
 assert.equal(intent.platform,'GOOGLE_ADS');
 await assert.rejects(asPerson(a,'SELECT hon.start_school_social_connect($1,$2::jsonb,$3,$4::uuid,$4::uuid) data',[a.externalSubject,JSON.stringify({platform:'TIKTOK'}),createHash('sha256').update(K()).digest('hex'),'$request'],'marketing.social.manage'),/SOCIAL_INVALID/);
 await assert.rejects(q("INSERT INTO hon.school_social_accounts(organization_id,school_id,platform,provider_account_id,display_name,status,publish_enabled,connected_by_principal_id) VALUES($1,$2,'GOOGLE_ADS','9990001111','Synthetic bad','CONNECTED',true,$3)",[a.org,a.school,ownerA]),/school_social_accounts_google_ads_only/);
 const gA=(await q("INSERT INTO hon.school_social_accounts(organization_id,school_id,platform,provider_account_id,display_name,status,connected_by_principal_id) VALUES($1,$2,'GOOGLE_ADS',$3,'Synthetic Dojo Google Ads','CONNECTED',$4) RETURNING *",[a.org,a.school,'1'+a.school.replace(/\D/g,'').slice(0,9),ownerA]))[0];
 const change=(input)=>asPerson(a,'SELECT hon.change_school_social_account($1,$2::uuid,$3::jsonb,$4,$5::uuid,$5::uuid) data',[a.externalSubject,gA.id,JSON.stringify(input),K(),'$request'],'marketing.social.manage');
 for(const bad of [{expectedVersion:1,publishEnabled:true,inboxEnabled:false,adsEnabled:true},{expectedVersion:1,publishEnabled:false,inboxEnabled:true,adsEnabled:false}])
  await assert.rejects(change(bad),/SOCIAL_INVALID/);
 assert.equal((await change({expectedVersion:1,publishEnabled:false,inboxEnabled:false,adsEnabled:false})).record.adsEnabled,false);
 const listed=await asPerson(a,'SELECT hon.read_school_social_accounts($1) data',[a.externalSubject],'marketing.social.read');
 assert.deepEqual(listed.accounts.filter(x=>x.platform==='GOOGLE_ADS').map(x=>C.verifySocialAccount(x)).map(x=>[x.accountId,x.publishEnabled,x.inboxEnabled]),[[gA.id,false,false]]);
 await assert.rejects(asPerson(a,'SELECT hon.create_school_social_post($1,$2::jsonb,$3,$4::uuid,$4::uuid) data',[a.externalSubject,JSON.stringify({text:'Synthetic post',accountIds:[gA.id]}),K(),'$request'],'marketing.social.post'),/SOCIAL_ACCOUNT_NOT_FOUND/);
 pass('GOOGLE_ADS can be connected; its publish and inbox switches stay off (table check and change command) and it is never a post target; other platforms are refused');

 // 3. Drafts: this school's connected Google Ads account with ads on, inside the cap, at least 1.00 a day, the school's own text.
 const good={accountId:gA.id,budgetCents:7000,startsOn:today,endsOn:day(today,6),...text};
 let r=await gdraft(a,good);refused(r,409,'SOCIAL_ADS_OFF');
 await change({expectedVersion:2,publishEnabled:false,inboxEnabled:false,adsEnabled:true});
 r=await gdraft(a,good);refused(r,409,'SOCIAL_AD_NO_BUDGET');
 ok(await budget(a,{monthlyCapCents:10000,currency:'USD'}));
 r=await gdraft(a,{...good,accountId:A.fb.id});refused(r,404,'SOCIAL_ACCOUNT_NOT_FOUND');
 r=await gdraft(a,{...good,accountId:B.gB.id});refused(r,404,'SOCIAL_ACCOUNT_NOT_FOUND');
 r=await gdraft(a,{...good,accountId:K()});refused(r,404,'SOCIAL_ACCOUNT_NOT_FOUND');
 r=await gdraft(a,{...good,budgetCents:10001,endsOn:day(today,6)});refused(r,409,'SOCIAL_AD_OVER_CAP');
 for(const bad of [{...good,budgetCents:699},{...good,headlines:['One','Two']},{...good,headlines:['Same','same','Third']},{...good,descriptions:['x'.repeat(91),'Two']},
  {...good,keywords:['[exact match]']},{...good,finalUrl:'http://dojo.example.invalid'},{...good,startsOn:day(today,-1)},{...good,endsOn:day(today,31)},{...good,status:'ACTIVE'}]){
  r=await gdraft(a,bad);refused(r,400,'SOCIAL_INVALID');}
 // Only the database's own checks: a body the API would pass through but the database refuses never writes anything.
 await assert.rejects(asPerson(a,'SELECT hon.create_school_social_google_ad($1,$2::jsonb,$3,$4::uuid,$4::uuid) data',[a.externalSubject,JSON.stringify({...good,keywords:['ok','OK']}),K(),'$request']),/SOCIAL_INVALID/);
 r=await draft(a,{targetId:K(),budgetCents:5000,startsOn:today,endsOn:today},{command:C.SOCIAL_GOOGLE_AD_CREATE_COMMAND});refused(r,403);
 r=await gdraft(a,good,{command:C.SOCIAL_AD_CREATE_COMMAND});refused(r,403);
 const gkey=K();
 let g1=adOf(r=await gdraft(a,good,{key:gkey}));
 assert.deepEqual([g1.channel,g1.status,g1.targetId,g1.postId,g1.accountId,g1.budgetCents,g1.currency,g1.google,r.body.meta.replayed],
  ['GOOGLE_SEARCH','DRAFT',null,null,gA.id,7000,'USD',text,false]);
 r=await gdraft(a,good,{key:gkey});assert.equal(r.body.meta.replayed,true);assert.equal(ok(r).adId,g1.adId);
 r=await gdraft(a,{...good,budgetCents:7100},{key:gkey});refused(r,409,'IDEMPOTENCY_KEY_REUSED');
 assert.equal((await view(a)).committedThisMonthCents,0,'a draft commits nothing');
 assert.equal(fake.googleAds.length+fake.boosts.length+fake.adStatusChanges.length,0);
 pass('a Google draft needs this school\'s connected Google Ads account with ads on, a cap that fits, at least 1.00 a day over 1 to 31 days and valid text; it is replayed exactly by key and commits nothing');

 // 4. Approve (created PAUSED once), turn on, pause: the same reviewed commands as Meta, with the Google text and total / days a day.
 r=await operate(a,g1.adId,{operation:'CREATE',expectedVersion:1});refused(r,503,'SOCIAL_ADS_NOT_ENABLED');
 fakeEnv.HON_ZERNIO_FAKE_PROVIDER='1';
 g1=await op(a,g1,'CREATE');
 assert.deepEqual([g1.status,fake.googleAds.length,fake.boosts.length,fake.adStatusChanges.length],['PAUSED',1,0,0]);
 assert.deepEqual({...fake.googleAds[0],providerAdId:undefined},{providerAccountId:gA.provider_account_id,dailyBudgetCents:1000,currency:'USD',startsOn:today,endsOn:day(today,6),
  timezone:'America/Chicago',...text,idempotencyKey:g1.adId,providerAdId:undefined});
 assert.equal((await row(g1.adId)).provider_ad_id,fake.googleAds[0].providerAdId);
 assert.equal((await view(a)).committedThisMonthCents,7000);
 g1=await op(a,g1,'ACTIVATE');assert.equal(g1.status,'ACTIVE');
 g1=await op(a,g1,'PAUSE');assert.equal(g1.status,'PAUSED');
 assert.deepEqual(fake.adStatusChanges.map(c=>[c.providerAdId,c.active]),[[fake.googleAds[0].providerAdId,true],[fake.googleAds[0].providerAdId,false]]);
 // A 10-day ad of 25.55 sends 2.55 a day (rounded down), never more than its total.
 const g2=adOf(await gdraft(a,{...good,budgetCents:2555,endsOn:day(today,9)}));
 const started=await startDirect(a,g2,'CREATE');
 assert.deepEqual([started.send.channel,started.send.dailyBudgetCents,started.send.providerPostId,started.send.google],['GOOGLE_SEARCH',255,null,text]);
 pass('approval creates one PAUSED Search ad at the fake with the approved text and total / days a day (rounded down); turning on and pausing use the reviewed lease path');

 // 5. One cap for both channels: Google and Meta ads that may spend count together in every month they touch.
 await expireLease(g2.adId);
 let gv=C.verifySocialAd((await view(a)).ads.find(x=>x.adId===g2.adId));assert.equal(gv.status,'UNKNOWN');
 assert.equal((await view(a)).committedThisMonthCents,7000+2555,'an unknown Google ad still counts');
 const post=(await q("INSERT INTO hon.school_social_posts(organization_id,school_id,body,account_ids,status,publish_at,drafted_by_principal_id,approved_by_principal_id,approved_at) VALUES($1,$2,'Synthetic open house',ARRAY[$3::uuid],'APPROVED',clock_timestamp(),$4,$4,clock_timestamp()) RETURNING id",[a.org,a.school,A.fb.id,ownerA]))[0].id;
 const tgt=(await q("INSERT INTO hon.school_social_post_targets(post_id,organization_id,school_id,account_id,status,due_at,lease_token,attempted_at,provider_post_id,settled_at) VALUES($1,$2,$3,$4,'PUBLISHED',clock_timestamp(),gen_random_uuid(),clock_timestamp(),$5,clock_timestamp()) RETURNING id",[post,a.org,a.school,A.fb.id,'fbpost_g_'+K().slice(0,8)]))[0].id;
 const m1=adOf(await draft(a,{targetId:tgt,budgetCents:500,startsOn:today,endsOn:today}));
 assert.deepEqual([m1.channel,m1.google],['META_BOOST',null]);
 r=await operate(a,m1.adId,{operation:'CREATE',expectedVersion:1});refused(r,409,'SOCIAL_AD_OVER_CAP');
 assert.equal(fake.boosts.length,0);
 // A person settles the unknown Google create; it stops counting and the Meta boost then fits.
 gv=adOf(await settle(a,g2.adId,{state:'NOT_CREATED',expectedVersion:gv.version}));assert.equal(gv.status,'FAILED');
 const m1a=await op(a,m1,'CREATE');assert.deepEqual([m1a.status,fake.boosts.length],['PAUSED',1]);
 assert.equal((await view(a)).committedThisMonthCents,7000+500);
 pass('one monthly cap covers Meta and Google together: an approved or unknown Google ad blocks a Meta approval that would go over, and settling it frees the room');

 // 6. A refused or lost Google create: a definite refusal is FAILED with nothing created; a lost answer is UNKNOWN and never resent.
 const g3=adOf(await gdraft(a,{...good,budgetCents:700,endsOn:day(today,6)}));
 fake.failNext.createGoogleSearchAd='REJECTED';
 assert.equal((await op(a,g3,'CREATE')).status,'FAILED');
 const g4=adOf(await gdraft(a,{...good,budgetCents:700,endsOn:day(today,6)}));
 fake.failNext.createGoogleSearchAd='UNKNOWN';
 const g4u=await op(a,g4,'CREATE');assert.equal(g4u.status,'UNKNOWN');
 r=await operate(a,g4.adId,{operation:'CREATE',expectedVersion:g4u.version});refused(r,409,'SOCIAL_AD_STATE');
 assert.equal(fake.googleAds.length,1,'refused and lost creates were never resent');
 // A Google ad cannot be activated through a Facebook account, or once its account's ads are off.
 const g5=adOf(await gdraft(a,{...good,budgetCents:700,endsOn:day(today,6)}));
 await change({expectedVersion:3,publishEnabled:false,inboxEnabled:false,adsEnabled:false});
 r=await operate(a,g5.adId,{operation:'CREATE',expectedVersion:1});refused(r,409,'SOCIAL_ADS_OFF');
 r=await operate(a,g1.adId,{operation:'ACTIVATE',expectedVersion:g1.version});refused(r,409,'SOCIAL_ADS_OFF');
 pass('a definite refusal is FAILED, a lost answer is UNKNOWN and never resent; with the account\'s ads off nothing is approved or turned on');

 // 7. Records: the channel and the Google text never change; the shape is enforced; evidence has no ad text.
 await assert.rejects(q("UPDATE hon.school_social_ads SET google_content='{}'::jsonb,version=version+1 WHERE id=$1",[g1.adId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_ads SET channel='META_BOOST',version=version+1 WHERE id=$1",[g1.adId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("INSERT INTO hon.school_social_ads(organization_id,school_id,account_id,target_id,channel,budget_cents,currency,starts_on,ends_on,status,created_by_principal_id) VALUES($1,$2,$3,NULL,'GOOGLE_SEARCH',700,'USD',current_date,current_date,'DRAFT',$4)",[a.org,a.school,gA.id,ownerA]),/school_social_ads_channel_shape/);
 await assert.rejects(q("INSERT INTO hon.school_social_ads(organization_id,school_id,account_id,target_id,budget_cents,currency,starts_on,ends_on,status,created_by_principal_id) VALUES($1,$2,$3,NULL,700,'USD',current_date,current_date,'DRAFT',$4)",[a.org,a.school,A.fb.id,ownerA]),/school_social_ads_channel_shape/);
 const trail=(await q("SELECT coalesce(next_state::text,'') s FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'marketing.social.ads%' UNION ALL SELECT payload::text FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'marketing.social.ads%'",[a.org])).map(x=>x.s).join();
 assert(!/Synthetic|Karate|Trial|dojo\.example|karate|fakegad_|fbpost_/.test(trail),trail.slice(0,300));
 assert(/GOOGLE_SEARCH/.test(trail),'the draft evidence names the channel');
 assert.equal((await evidence(b)).a,'0','the other school has no ads evidence');
 pass('an ad\'s channel and Google text never change, a Google ad needs text and no post (and a Meta boost a post), and audit and outbox carry no ad text, names or Google ids');
 console.log('PASS: school Google ads (0453), '+groups+' groups');
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end(),worker.end()]);}
