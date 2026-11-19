/** School social ads (0445): real signed HON sessions -> Nest/guards -> fixed runtime SQL -> marked disposable
 *  PostgreSQL (the communication delivery fixture). Zernio is the deterministic in-process fake adapter only; nothing is
 *  created, turned on or spent anywhere. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point; the
 *  owner connection stands in for paid access and seeds connected accounts and published posts (0347/0348 are proven
 *  separately). All names are synthetic. */
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
const session={mode:'OIDC',audience:'social-ads-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
// The fake adapter reads its switch from this object only; the proof turns ads on and off.
const fakeEnv={HON_DEPLOYMENT_ENVIRONMENT:'development'};const fake=new FakeZernioSocialAdapter(()=>fakeEnv);
const pass=name=>console.log('PASS ADS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command=C.SOCIAL_AD_OPERATION_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const refused=(r,status,code)=>{assert.equal(r.status,status,JSON.stringify(r.body));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));};
const person=label=>({externalSubject:'oidc:ads:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
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
async function asPerson(x,sql,args){
 const scope=await database.resolveAuthorizedScope(x.externalSubject,x.school,'marketing.social.ads');assert(scope);
 const requestId=K();
 return database.withTenantTransaction({...scope,principalType:'HUMAN_USER',requestId,correlationId:requestId,idempotencyKey:'',source:'HUMAN_UI',externalSubject:x.externalSubject},
  async client=>{await client.query(SOCIAL_HUMAN_SETTINGS,[x.externalSubject]);return (await client.query(sql,args.map(a=>a==='$request'?requestId:a))).rows[0].data;});
}
const startDirect=(x,ad,operation)=>asPerson(x,'SELECT hon.start_school_social_ad_operation($1,$2::uuid,$3::jsonb,$4,$5::uuid,$5::uuid) data',[x.externalSubject,ad.adId,JSON.stringify({operation,expectedVersion:ad.version}),K(),'$request']);
const recordDirect=(x,adId,token,outcome,providerAdId=null)=>asPerson(x,'SELECT hon.record_school_social_ad_result($1,$2::uuid,$3::uuid,$4,$5,$6::uuid,$6::uuid) data',[x.externalSubject,adId,token,outcome,providerAdId,'$request']);
async function expireLease(adId){
 await q('ALTER TABLE hon.school_social_ads DISABLE TRIGGER guarded');
 try{await q("UPDATE hon.school_social_ads SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[adId]);}
 finally{await q('ALTER TABLE hon.school_social_ads ENABLE TRIGGER guarded');}
}

try{
 await Promise.all([admin.connect(),restricted.connect(),worker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable communication delivery validation');
 // 1. Custody and exact ACLs.
 for(const t of ['school_social_ad_budgets','school_social_ads']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const role of [runtime.username,workerUrl.username])for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
   assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[role,'hon.'+t,p]))[0].ok,false,role+':'+t+':'+p);
 }
 const adsRuntime=['read_school_social_ads','set_school_social_ad_budget','create_school_social_ad','cancel_school_social_ad','start_school_social_ad_operation','record_school_social_ad_result','resolve_school_social_ad',
  // 0453 Google ads (proven in test-school-social-google-ads.mjs).
  'create_school_social_google_ad'];
 const earlierRuntime=['read_school_social_accounts','start_school_social_connect','record_school_social_profile','claim_school_social_connect','record_school_social_accounts','change_school_social_account',
  'read_school_social_posts','create_school_social_post','edit_school_social_post','approve_school_social_post','cancel_school_social_post','resolve_school_social_post_target',
  'read_school_social_inbox','read_school_social_conversation','change_school_social_conversation','start_school_social_reply','record_school_social_reply_result','resolve_school_social_message','start_school_social_comment_action','record_school_social_comment_action_result'];
 const workerEntry=['claim_school_social_post_targets','record_school_social_post_result','record_school_social_post_event','record_school_social_inbox_event'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%school_social%'");
 assert.equal(fns.length,12+16+14+12+2,fns.map(f=>f.proname).join());
 for(const f of fns){
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,[...earlierRuntime,...adsRuntime].includes(f.proname),'runtime '+f.proname);
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[workerUrl.username,f.oid]))[0].ok,workerEntry.includes(f.proname),'worker '+f.proname);
 }
 await assert.rejects(worker.query('SELECT hon.read_school_social_ads($1)',['x']),/permission denied/);
 await assert.rejects(restricted.query('SELECT hon.school_social_ad_committed(gen_random_uuid(),gen_random_uuid(),current_date)'),/permission denied/);
 assert.equal((await q("SELECT count(*) n FROM hon.permissions WHERE code IN ('marketing.social.ads','marketing.social.ads.budget') AND is_sensitive"))[0].n,'2');
 pass('forced deny-all RLS on two new tables; runtime executes exactly seven ads entry points and the worker none; both ads permissions are sensitive');

 const module=await Test.createTestingModule({controllers:[SchoolSocialAdsController],providers:[SchoolSocialAdsService,G.SchoolSocialReadHumanUiGuard,G.SchoolSocialAdBudgetHumanUiGuard,G.SchoolSocialAdCreateHumanUiGuard,G.SchoolSocialAdOperationHumanUiGuard,G.SchoolSocialAdCancelHumanUiGuard,G.SchoolSocialAdResolveHumanUiGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database},{provide:ZERNIO_SOCIAL_ADAPTER,useValue:fake}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 for(const x of [a,b]){await setAccess(x,'ACTIVE');
  assert.equal((await q("SELECT count(*) n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.code='OWNER' AND r.is_system_role AND rp.permission_code IN ('marketing.social.ads','marketing.social.ads.budget')",[x.org]))[0].n,'2');}
 const A=await seedAccounts(a,[['fb','FACEBOOK',true],['ig','INSTAGRAM',true],['fbOff','FACEBOOK',false]]),B=await seedAccounts(b,[['fbB','FACEBOOK',true]]);
 const T={p1:await target(a,A.fb),p2:await target(a,A.fb),p3:await target(a,A.fb),p4:await target(a,A.fb),p5:await target(a,A.fb),p6:await target(a,A.fb),
  failed:await target(a,A.fb,'FAILED'),ig:await target(a,A.ig),off:await target(a,A.fbOff),b:await target(b,B.fbB)};
 const today=(await q("SELECT to_char(hon.school_social_today($1),'YYYY-MM-DD') d",[a.school]))[0].d;
 assert.equal(today,new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago'}).format(new Date()),'today is the school\'s own date');
 const nm=firstOfNextMonth(today);

 // 2. The cap: none at first; set by version with exact replay; the currency stays fixed once ads exist.
 let V=await view(a);
 assert.deepEqual([V.budget,V.committedThisMonthCents,V.ads.length,V.adsEnabled,V.pauseEnabled,V.today],[null,0,0,false,false,today]);
 let r=await draft(a,{targetId:T.p1,budgetCents:5000,startsOn:today,endsOn:today});refused(r,409,'SOCIAL_AD_NO_BUDGET');
 const bkey=K();
 V=C.verifySocialAdsView(ok(r=await budget(a,{monthlyCapCents:10000,currency:'USD'},{key:bkey})));
 assert.deepEqual([V.budget.monthlyCapCents,V.budget.currency,V.budget.version,r.body.meta.replayed],[10000,'USD',1,false]);
 r=await budget(a,{monthlyCapCents:10000,currency:'USD'},{key:bkey});assert.equal(r.body.meta.replayed,true);
 r=await budget(a,{monthlyCapCents:20000,currency:'USD'},{key:bkey});refused(r,409,'IDEMPOTENCY_KEY_REUSED');
 r=await budget(a,{monthlyCapCents:20000,currency:'USD'});refused(r,409,'SOCIAL_VERSION_CONFLICT');
 r=await budget(a,{monthlyCapCents:20000,currency:'USD',expectedVersion:9});refused(r,409,'SOCIAL_VERSION_CONFLICT');
 V=C.verifySocialAdsView(ok(await budget(a,{monthlyCapCents:0,currency:'CAD',expectedVersion:1})));assert.deepEqual([V.budget.monthlyCapCents,V.budget.currency],[0,'CAD']);
 r=await draft(a,{targetId:T.p1,budgetCents:5000,startsOn:today,endsOn:today});refused(r,409,'SOCIAL_AD_NO_BUDGET');
 V=C.verifySocialAdsView(ok(await budget(a,{monthlyCapCents:10000,currency:'USD',expectedVersion:2})));assert.equal(V.budget.version,3);
 for(const bad of [{monthlyCapCents:1_000_001,currency:'USD',expectedVersion:3},{monthlyCapCents:-1,currency:'USD',expectedVersion:3},{monthlyCapCents:10,currency:'us',expectedVersion:3},{monthlyCapCents:'10',currency:'USD',expectedVersion:3}]){
  r=await budget(a,bad);refused(r,400,'SOCIAL_INVALID');}
 r=await draft(b,{targetId:T.b,budgetCents:5000,startsOn:today,endsOn:today});refused(r,409,'SOCIAL_AD_NO_BUDGET');
 pass('a person with the budget permission sets the school\'s monthly cap by version with exact replay and refused key reuse; no cap, or a cap of 0, allows no ad');

 // 3. Drafts: only a published Facebook post of this school on an account with ads on, inside the cap, from today for 1 to 31 days.
 r=await draft(a,{targetId:T.failed,budgetCents:5000,startsOn:today,endsOn:today});refused(r,409,'SOCIAL_AD_POST_NOT_PUBLISHED');
 r=await draft(a,{targetId:T.ig,budgetCents:5000,startsOn:today,endsOn:today});refused(r,409,'SOCIAL_ADS_OFF');
 r=await draft(a,{targetId:T.off,budgetCents:5000,startsOn:today,endsOn:today});refused(r,409,'SOCIAL_ADS_OFF');
 r=await draft(a,{targetId:T.b,budgetCents:5000,startsOn:today,endsOn:today});refused(r,404,'SOCIAL_POST_NOT_FOUND');
 r=await draft(a,{targetId:K(),budgetCents:5000,startsOn:today,endsOn:today});refused(r,404,'SOCIAL_POST_NOT_FOUND');
 r=await draft(a,{targetId:T.p1,budgetCents:10001,startsOn:today,endsOn:today});refused(r,409,'SOCIAL_AD_OVER_CAP');
 for(const [s,e] of [[day(today,-1),today],[today,day(today,31)],[day(today,2),day(today,1)],[day(today,91),day(today,92)]]){
  r=await draft(a,{targetId:T.p1,budgetCents:5000,startsOn:s,endsOn:e});refused(r,400,'SOCIAL_INVALID');}
 r=await draft(a,{targetId:T.p1,budgetCents:99,startsOn:today,endsOn:today});refused(r,400,'SOCIAL_INVALID');
 r=await draft(a,{targetId:T.p1,budgetCents:5000,startsOn:today,endsOn:today,status:'ACTIVE'});refused(r,400,'SOCIAL_INVALID');
 const dkey=K();
 let ad1=adOf(r=await draft(a,{targetId:T.p1,budgetCents:5000,startsOn:today,endsOn:today},{key:dkey}));
 assert.deepEqual([ad1.status,ad1.operation,ad1.currency,ad1.accountId,ad1.accountName,r.body.meta.replayed],['DRAFT',null,'USD',A.fb.id,'Synthetic fb',false]);
 r=await draft(a,{targetId:T.p1,budgetCents:5000,startsOn:today,endsOn:today},{key:dkey});assert.equal(r.body.meta.replayed,true);assert.equal(ok(r).adId,ad1.adId);
 const longest=adOf(await draft(a,{targetId:T.p2,budgetCents:100,startsOn:today,endsOn:day(today,30)}));assert.equal(longest.status,'DRAFT');
 const c1=adOf(await cancel(a,longest.adId,{expectedVersion:1}));assert.equal(c1.status,'CANCELLED');
 r=await cancel(a,longest.adId,{expectedVersion:2});refused(r,409,'SOCIAL_AD_STATE');
 V=await view(a);assert.equal(V.committedThisMonthCents,0,'drafts and cancelled ads commit nothing');
 r=await budget(a,{monthlyCapCents:10000,currency:'EUR',expectedVersion:3});refused(r,409,'SOCIAL_AD_CURRENCY_FIXED');
 assert.equal((await view(a)).budget.currency,'USD');
 assert.equal(fake.boosts.length+fake.adStatusChanges.length,0);
 pass('a draft needs a published Facebook post of this school, an account with ads on, a cap that fits and 1 to 31 days from today; it commits nothing, can be cancelled, and fixes the currency');

 // 4. Operations: nothing is recorded while ads are off; approval creates the ad PAUSED once; turning on and pausing are each one call.
 r=await operate(a,ad1.adId,{operation:'CREATE',expectedVersion:1});refused(r,503,'SOCIAL_ADS_NOT_ENABLED');
 assert.deepEqual([(await row(ad1.adId)).status,(await row(ad1.adId)).version],['DRAFT',1]);
 fakeEnv.HON_ZERNIO_FAKE_PROVIDER='1';{const W=await view(a);assert.deepEqual([W.adsEnabled,W.pauseEnabled],[true,true]);}
 // Owner decision (0453): every ad reaches people within 5 miles of the school's street address, so approval needs one.
 r=await operate(a,ad1.adId,{operation:'CREATE',expectedVersion:1});refused(r,409,'SOCIAL_AD_NO_ADDRESS');
 const ownerP=await principalOf(a);
 await q("INSERT INTO hon.school_locations(school_id,organization_id,country_code,region_code,city,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,'US','IL','Testville',$3,$3)",[a.school,a.org,ownerP]);
 r=await operate(a,ad1.adId,{operation:'CREATE',expectedVersion:1});refused(r,409,'SOCIAL_AD_NO_ADDRESS');
 await q("UPDATE hon.school_locations SET address_line1='100 Synthetic Way',postal_code='60000',version=version+1,updated_at=clock_timestamp() WHERE school_id=$1",[a.school]);
 assert.deepEqual([(await row(ad1.adId)).status,(await row(ad1.adId)).version,fake.boosts.length],['DRAFT',1,0],'a refusal for a missing address records nothing');
 // A budget whose currency no longer matches the ad (only possible outside the API) refuses approval.
 await q("UPDATE hon.school_social_ad_budgets SET currency='EUR',version=version+1 WHERE school_id=$1",[a.school]);
 r=await operate(a,ad1.adId,{operation:'CREATE',expectedVersion:1});refused(r,409,'SOCIAL_AD_STATE');
 await q("UPDATE hon.school_social_ad_budgets SET currency='USD',version=version+1 WHERE school_id=$1",[a.school]);
 const okey=K();
 ad1=adOf(r=await operate(a,ad1.adId,{operation:'CREATE',expectedVersion:1},{key:okey}));
 assert.deepEqual([ad1.status,ad1.operation,r.body.meta.replayed],['PAUSED','CREATE',false]);
 assert.equal(fake.boosts.length,1);
 assert.deepEqual({...fake.boosts[0],providerAdId:undefined},{providerAccountId:A.fb.provider_account_id,providerPostId:(await q('SELECT provider_post_id p FROM hon.school_social_post_targets WHERE id=$1',[T.p1]))[0].p,
  budgetCents:5000,currency:'USD',startsOn:today,endsOn:today,timezone:'America/Chicago',
  location:{addressLine1:'100 Synthetic Way',addressLine2:null,city:'Testville',region:'IL',postalCode:'60000',country:'US',radiusMiles:5},idempotencyKey:ad1.adId,providerAdId:undefined});
 assert.equal((await row(ad1.adId)).provider_ad_id,fake.boosts[0].providerAdId);
 r=await operate(a,ad1.adId,{operation:'CREATE',expectedVersion:1},{key:okey});assert.equal(r.body.meta.replayed,true);assert.equal(fake.boosts.length,1,'a replay never calls again');
 r=await operate(a,ad1.adId,{operation:'CREATE',expectedVersion:ad1.version});refused(r,409,'SOCIAL_AD_STATE');
 r=await operate(a,ad1.adId,{operation:'PAUSE',expectedVersion:ad1.version});refused(r,409,'SOCIAL_AD_STATE');
 r=await cancel(a,ad1.adId,{expectedVersion:ad1.version});refused(r,409,'SOCIAL_AD_STATE');
 assert.equal((await view(a)).committedThisMonthCents,5000,'an approved ad commits its whole budget while paused');
 assert.equal(fake.adStatusChanges.length,0,'approving never turns an ad on');
 ad1=await op(a,ad1,'ACTIVATE');assert.equal(ad1.status,'ACTIVE');
 assert.deepEqual(fake.adStatusChanges.map(x=>[x.providerAdId,x.active]),[[fake.boosts[0].providerAdId,true]]);
 assert.match(fake.adStatusChanges[0].idempotencyKey,new RegExp('^'+ad1.adId+':[0-9a-f-]{36}$'));
 r=await operate(a,ad1.adId,{operation:'ACTIVATE',expectedVersion:ad1.version});refused(r,409,'SOCIAL_AD_STATE');
 ad1=await op(a,ad1,'PAUSE');assert.equal(ad1.status,'PAUSED');
 assert.notEqual(fake.adStatusChanges[1].idempotencyKey,fake.adStatusChanges[0].idempotencyKey,'each operation has its own key');
 r=await operate(a,ad1.adId,{operation:'ACTIVATE',expectedVersion:1});refused(r,409,'SOCIAL_VERSION_CONFLICT');
 // Ads off on the account: turning on is refused, pausing is not.
 ad1=await op(a,ad1,'ACTIVATE');
 await accountUpdate(A.fb.id,'ads_enabled=false');
 r=await operate(a,ad1.adId,{operation:'PAUSE',expectedVersion:ad1.version});ad1=adOf(r);assert.equal(ad1.status,'PAUSED','pausing works with ads off');
 r=await operate(a,ad1.adId,{operation:'ACTIVATE',expectedVersion:ad1.version});refused(r,409,'SOCIAL_ADS_OFF');
 await accountUpdate(A.fb.id,'ads_enabled=true');
 pass('while ads are off nothing is recorded; approving creates the ad PAUSED exactly once with its own id as key; turning on and pausing are each one call under their own key; pausing always works');

 // 5. The cap across months: every committed ad counts its whole budget in each month it touches.
 const ad2=adOf(await draft(a,{targetId:T.p2,budgetCents:6000,startsOn:today,endsOn:today}));
 r=await operate(a,ad2.adId,{operation:'CREATE',expectedVersion:1});refused(r,409,'SOCIAL_AD_OVER_CAP');
 assert.equal((await row(ad2.adId)).status,'DRAFT');
 const cross=adOf(await draft(a,{targetId:T.p3,budgetCents:6000,startsOn:today<day(nm,-3)?day(nm,-3):today,endsOn:day(nm,3)}));
 r=await operate(a,cross.adId,{operation:'CREATE',expectedVersion:1});refused(r,409,'SOCIAL_AD_OVER_CAP');
 let later=adOf(await draft(a,{targetId:T.p4,budgetCents:6000,startsOn:day(nm,5),endsOn:day(nm,10)}));
 later=await op(a,later,'CREATE');assert.equal(later.status,'PAUSED','a later month has its own room');
 V=await view(a);assert.equal(V.committedThisMonthCents,5000);
 assert.equal((await q("SELECT hon.school_social_ad_committed($1,$2,$3::date) n",[a.org,a.school,nm]))[0].n,'6000');
 // Lowering the cap below what is committed stops turning on, never pausing.
 V=C.verifySocialAdsView(ok(await budget(a,{monthlyCapCents:4000,currency:'USD',expectedVersion:(await view(a)).budget.version})));
 r=await operate(a,ad1.adId,{operation:'ACTIVATE',expectedVersion:ad1.version});refused(r,409,'SOCIAL_AD_OVER_CAP');
 await budget(a,{monthlyCapCents:10000,currency:'USD',expectedVersion:V.budget.version});
 ad1=await op(a,ad1,'ACTIVATE');assert.equal(ad1.status,'ACTIVE');
 await budget(a,{monthlyCapCents:4000,currency:'USD',expectedVersion:(await view(a)).budget.version});
 ad1=await op(a,ad1,'PAUSE');assert.equal(ad1.status,'PAUSED');
 await budget(a,{monthlyCapCents:10000,currency:'USD',expectedVersion:(await view(a)).budget.version});
 pass('every committed ad counts its whole budget in each calendar month its dates touch, so an ad over the cap in any month is refused; a lower cap stops turning on but never pausing');

 // 6. Provider failures: only a definite refusal is FAILED; anything that may have reached Meta is UNKNOWN and still counts.
 const cancelAd2=adOf(await cancel(a,ad2.adId,{expectedVersion:1}));assert.equal(cancelAd2.status,'CANCELLED');
 let f1=adOf(await draft(a,{targetId:T.p5,budgetCents:2000,startsOn:today,endsOn:today}));
 fake.failNext.createBoost='REJECTED';f1=await op(a,f1,'CREATE');assert.equal(f1.status,'FAILED');
 assert.equal((await view(a)).committedThisMonthCents,5000,'a refused ad commits nothing');
 let u1=adOf(await draft(a,{targetId:T.p6,budgetCents:2000,startsOn:today,endsOn:today}));
 fake.failNext.createBoost='UNKNOWN';u1=await op(a,u1,'CREATE');assert.deepEqual([u1.status,u1.operation],['UNKNOWN','CREATE']);
 assert.equal((await view(a)).committedThisMonthCents,7000,'an UNKNOWN ad still counts');
 r=await operate(a,u1.adId,{operation:'PAUSE',expectedVersion:u1.version});refused(r,409,'SOCIAL_AD_STATE');
 r=await settle(a,u1.adId,{state:'PAUSED',expectedVersion:u1.version});refused(r,409,'SOCIAL_AD_STATE');
 const rkey=K();
 u1=adOf(r=await settle(a,u1.adId,{state:'NOT_CREATED',expectedVersion:u1.version},{key:rkey}));assert.deepEqual([u1.status,u1.resolvedByPerson],['FAILED',true]);
 r=await settle(a,u1.adId,{state:'NOT_CREATED',expectedVersion:u1.version-1},{key:rkey});assert.equal(r.body.meta.replayed,true);
 assert.equal((await view(a)).committedThisMonthCents,5000);
 fake.failNext.setAdActive='RATE_LIMITED';ad1=await op(a,ad1,'ACTIVATE');assert.equal(ad1.status,'PAUSED','a refused turn-on stays paused');
 ad1=await op(a,ad1,'ACTIVATE');assert.equal(ad1.status,'ACTIVE');
 fake.failNext.setAdActive='REJECTED';ad1=await op(a,ad1,'PAUSE');assert.equal(ad1.status,'ACTIVE','a refused pause leaves it on, and says so');
 fake.failNext.setAdActive='UNKNOWN';ad1=await op(a,ad1,'PAUSE');assert.deepEqual([ad1.status,ad1.operation],['UNKNOWN','PAUSE']);
 ad1=await op(a,ad1,'PAUSE');assert.equal(ad1.status,'PAUSED','an UNKNOWN ad with a Meta id can always be paused');
 fake.failNext.setAdActive='UNAVAILABLE';ad1=await op(a,ad1,'ACTIVATE');assert.equal(ad1.status,'UNKNOWN');
 r=await settle(a,ad1.adId,{state:'NOT_CREATED',expectedVersion:ad1.version});refused(r,409,'SOCIAL_AD_STATE');
 ad1=adOf(await settle(a,ad1.adId,{state:'ACTIVE',expectedVersion:ad1.version}));assert.deepEqual([ad1.status,ad1.resolvedByPerson],['ACTIVE',true]);
 ad1=await op(a,ad1,'PAUSE');assert.equal(ad1.status,'PAUSED');
 pass('only a definite refusal is FAILED (and commits nothing); a lost answer is UNKNOWN, still counts, and is never resent; a person settles it once; an ad with a Meta id can always be paused');

 // 7. Leases: an answer that never comes reads UNKNOWN; a late answer counts only under its own lease and never over a person.
 const callsBefore=fake.boosts.length+fake.adStatusChanges.length;
 let L=adOf(await draft(a,{targetId:T.p5,budgetCents:1000,startsOn:today,endsOn:today}));
 const s1=await startDirect(a,L,'CREATE');assert.equal(s1.record.status,'CREATING');assert.equal(s1.send.providerAdId,null);
 r=await operate(a,L.adId,{operation:'CREATE',expectedVersion:s1.record.version});refused(r,409,'SOCIAL_AD_STATE');
 r=await settle(a,L.adId,{state:'NOT_CREATED',expectedVersion:s1.record.version});refused(r,409,'SOCIAL_AD_STATE');
 await expireLease(L.adId);
 assert.equal((await view(a)).ads.find(x=>x.adId===L.adId).status,'UNKNOWN','an expired lease reads as UNKNOWN');
 let lr=await recordDirect(a,L.adId,K(),'DONE','late_ad_1');assert.equal(lr.accepted,false,'wrong lease token');
 await assert.rejects(recordDirect(a,L.adId,s1.send.leaseToken,'DONE',null),/SOCIAL_INVALID/);
 await assert.rejects(recordDirect(a,L.adId,s1.send.leaseToken,'FAILED','x'),/SOCIAL_INVALID/);
 lr=await recordDirect(a,L.adId,s1.send.leaseToken,'DONE','late_ad_1');assert.deepEqual([lr.ad.status,lr.accepted],['PAUSED',true]);
 lr=await recordDirect(a,L.adId,s1.send.leaseToken,'FAILED',null);assert.deepEqual([lr.ad.status,lr.accepted],['PAUSED',false],'a settled answer is final');
 // A provider ad id another ad already holds is not trusted.
 L=adOf(await cancel(a,(adOf(await draft(a,{targetId:T.p6,budgetCents:1000,startsOn:today,endsOn:today}))).adId,{expectedVersion:1}));
 let D=adOf(await draft(a,{targetId:T.p6,budgetCents:1000,startsOn:today,endsOn:today}));
 const s2=await startDirect(a,D,'CREATE');
 lr=await recordDirect(a,D.adId,s2.send.leaseToken,'DONE','late_ad_1');assert.deepEqual([lr.ad.status,lr.accepted],['UNKNOWN',true]);
 assert.equal((await row(D.adId)).provider_ad_id,null);
 // A person's answer stands over a late one.
 D=adOf(await settle(a,D.adId,{state:'NOT_CREATED',expectedVersion:lr.ad.version}));
 lr=await recordDirect(a,D.adId,s2.send.leaseToken,'DONE','late_ad_2');assert.deepEqual([lr.ad.status,lr.accepted],['FAILED',false]);
 // An expired turn-on: settled by a person who checked Ads Manager.
 const s3=await startDirect(a,ad1,'ACTIVATE');assert.equal(s3.send.providerAdId,(await row(ad1.adId)).provider_ad_id);
 await expireLease(ad1.adId);
 ad1=adOf(await settle(a,ad1.adId,{state:'PAUSED',expectedVersion:s3.record.version}));assert.deepEqual([ad1.status,ad1.resolvedByPerson],['PAUSED',true]);
 lr=await recordDirect(a,ad1.adId,s3.send.leaseToken,'DONE');assert.deepEqual([lr.ad.status,lr.accepted],['PAUSED',false]);
 assert.equal(fake.boosts.length+fake.adStatusChanges.length,callsBefore,'direct starts call nothing');
 pass('an operation whose answer never comes reads UNKNOWN; a late answer counts only under its own lease, only once, never with a Meta id another ad holds and never over a person');

 // 8. Authority and isolation.
 const ev0=await evidence(a),calls0=fake.boosts.length+fake.adStatusChanges.length;
 r=await send(base(a),{identity:b});refused(r,403);
 r=await operate(b,ad1.adId,{operation:'ACTIVATE',expectedVersion:ad1.version});refused(r,404,'SOCIAL_AD_NOT_FOUND');
 r=await cancel(b,f1.adId,{expectedVersion:f1.version});refused(r,404);
 r=await send(`organizations/${a.org}/schools/${b.school}/marketing/social/ads`,{identity:b});refused(r,403);
 r=await operate(a,ad1.adId,{operation:'ACTIVATE',expectedVersion:ad1.version},{command:C.SOCIAL_AD_CREATE_COMMAND});refused(r,403);
 r=await budget(a,{monthlyCapCents:99999,currency:'USD',expectedVersion:1},{command:C.SOCIAL_AD_OPERATION_COMMAND});refused(r,403);
 r=await operate(a,ad1.adId,{operation:'ACTIVATE',expectedVersion:ad1.version},{headers:{'x-hon-delegated-by-principal-id':K()}});refused(r,403);
 r=await send(base(a)+'/'+ad1.adId+'/operation?schoolId='+b.school,{identity:a,method:'POST',body:{operation:'ACTIVATE',expectedVersion:ad1.version}});refused(r,400);
 r=await send(base(a),{identity:a,headers:{'idempotency-key':K()}});refused(r,409,'IDEMPOTENCY_KEY_NOT_ACCEPTED');
 r=await operate({...person('stranger'),org:a.org,school:a.school},ad1.adId,{operation:'ACTIVATE',expectedVersion:ad1.version});refused(r,403);
 // The cap needs its own permission; the ads permission alone does not set it.
 await q("DELETE FROM hon.role_permissions WHERE organization_id=$1 AND permission_code='marketing.social.ads.budget'",[a.org]);
 r=await budget(a,{monthlyCapCents:99999,currency:'USD',expectedVersion:(await view(a)).budget.version});refused(r,403);
 await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT id,organization_id,'marketing.social.ads.budget' FROM hon.roles WHERE organization_id=$1 AND code='OWNER' AND is_system_role",[a.org]);
 await q("DELETE FROM hon.role_permissions WHERE organization_id=$1 AND permission_code='marketing.social.ads'",[a.org]);
 r=await send(base(a),{identity:a});refused(r,403);
 r=await operate(a,ad1.adId,{operation:'ACTIVATE',expectedVersion:ad1.version});refused(r,403);
 await assert.rejects(recordDirect(a,ad1.adId,K(),'UNKNOWN'),/./);
 await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT id,organization_id,'marketing.social.ads' FROM hon.roles WHERE organization_id=$1 AND code='OWNER' AND is_system_role",[a.org]);
 await setAccess(a,'SUSPENDED');r=await operate(a,ad1.adId,{operation:'ACTIVATE',expectedVersion:ad1.version});refused(r,403);await setAccess(a,'ACTIVE');
 assert.deepEqual(await evidence(a),ev0,'refusals write nothing');
 assert.equal(fake.boosts.length+fake.adStatusChanges.length,calls0,'refusals call nothing');
 pass('another school, missing ads or budget permission, wrong browser commands, delegation, query values, an unknown person and suspended access are refused with nothing written or called');

 // 9. Evidence is identifiers and amounts only, and the records cannot be rewritten.
 const ev=await evidence(a);assert(Number(ev.a)>=30);assert.equal(ev.a,ev.o);
 const trail=(await q("SELECT coalesce(next_state::text,'') s FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'marketing.social.ads%' UNION ALL SELECT payload::text FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'marketing.social.ads%'",[a.org])).map(x=>x.s).join();
 assert(!/Synthetic|fbpost_|fakead_|late_ad_|fb_|open house/.test(trail),trail.slice(0,300));
 assert.equal((await q("SELECT count(*) n FROM hon.audit_events WHERE organization_id=$1 AND action_code='marketing.social.ads.activate_started'",[a.org]))[0].n,'7');
 await assert.rejects(q('UPDATE hon.school_social_ads SET budget_cents=999999,version=version+1 WHERE id=$1',[ad1.adId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q('UPDATE hon.school_social_ads SET ends_on=ends_on+1,version=version+1 WHERE id=$1',[ad1.adId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_ads SET provider_ad_id='other',version=version+1 WHERE id=$1",[ad1.adId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_ads SET status='DRAFT',version=version+1 WHERE id=$1",[ad1.adId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_ads SET status='ACTIVE',version=version+1 WHERE id=$1",[f1.adId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q('UPDATE hon.school_social_ads SET school_id=$2,version=version+1 WHERE id=$1',[ad1.adId,b.school]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q('UPDATE hon.school_social_ad_budgets SET monthly_cap_cents=1 WHERE school_id=$1',[a.school]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q('DELETE FROM hon.school_social_ads WHERE id=$1',[ad1.adId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q('DELETE FROM hon.school_social_ad_budgets WHERE school_id=$1',[a.school]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q('TRUNCATE hon.school_social_ads'),/SOCIAL_RECORD_IMMUTABLE|cannot truncate/);
 await assert.rejects(q("INSERT INTO hon.school_social_ads(organization_id,school_id,account_id,target_id,budget_cents,currency,starts_on,ends_on,status,created_by_principal_id) VALUES($1,$2,$3,$4,100,'USD',current_date,current_date+31,'DRAFT',$5)",[a.org,a.school,A.fb.id,T.p1,await principalOf(a)]),/check constraint/);
 pass('audit and outbox carry identifiers and amounts only (no post text, names or Meta ids); an ad\'s school, budget, dates and Meta id cannot change, status moves only along reviewed paths, and nothing is deleted or truncated');
 console.log('PASS: school social ads (0445), '+groups+' groups');
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end(),worker.end()]);}
