/** School social posts (0348): real signed HON sessions -> Nest/guards -> fixed runtime SQL, and the publish worker as the
 *  0243 worker role -> marked disposable PostgreSQL (the communication delivery fixture). Zernio is the deterministic
 *  in-process fake adapter only; nothing is posted anywhere. Schools are SYNTHETIC sign-ups made through the 0241 runtime
 *  entry point; the owner connection stands in for paid access and seeds connected accounts (0347 is proven separately). */
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
const G=require('./dist/marketing/social/school-social.guard.js');
const {FakeZernioSocialAdapter,ZERNIO_SOCIAL_ADAPTER}=require('./dist/marketing/social/zernio-social-adapter.js');
const {SocialPostDispatcher}=require('./dist/marketing/social/social-post-dispatcher.js');
const {CommunicationWorkerDatabase}=require('./dist/communication/delivery/communication-worker-database.js');
const C=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),worker=new pg.Client({connectionString:workerUrl.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'social-posts-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
// The fake adapter reads its switch from this object only; the proof turns publishing on and off.
const fakeEnv={HON_DEPLOYMENT_ENVIRONMENT:'development'};const fake=new FakeZernioSocialAdapter(()=>fakeEnv);
const store=new CommunicationWorkerDatabase();const dispatcher=new SocialPostDispatcher(store,fake);
const pass=name=>console.log('PASS POSTS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const w=async(sql,args=[])=>(await worker.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command=C.SOCIAL_POST_CREATE_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const person=label=>({externalSubject:'oidc:posts:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
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
const TEXT='Free trial week at the dojo!\nBring a friend.';

try{
 await Promise.all([admin.connect(),restricted.connect(),worker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable communication delivery validation');
 // 1. Custody and exact ACLs: runtime gets six entry points, the worker three, neither any table.
 const tables=['school_social_posts','school_social_post_targets','school_social_post_receipts'];
 for(const t of tables){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const role of [runtime.username,workerUrl.username])for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
   assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[role,'hon.'+t,p]))[0].ok,false,role+':'+t+':'+p);
 }
 const runtimeEntry=['read_school_social_posts','create_school_social_post','edit_school_social_post','approve_school_social_post','cancel_school_social_post','resolve_school_social_post_target'];
 const workerEntry=['claim_school_social_post_targets','record_school_social_post_result','record_school_social_post_event'];
 const s1Entry=['read_school_social_accounts','start_school_social_connect','record_school_social_profile','claim_school_social_connect','record_school_social_accounts','change_school_social_account'];
 // 0349 inbox entry points (proven in test-school-social-inbox.mjs).
 const inboxEntry=['read_school_social_inbox','read_school_social_conversation','change_school_social_conversation','start_school_social_reply','record_school_social_reply_result','resolve_school_social_message','start_school_social_comment_action','record_school_social_comment_action_result'],inboxWorker=['record_school_social_inbox_event'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%school_social%'");
 assert.equal(fns.length,12+16+14,fns.map(f=>f.proname).join());
 for(const f of fns){
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,[...s1Entry,...runtimeEntry,...inboxEntry].includes(f.proname),'runtime '+f.proname);
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[workerUrl.username,f.oid]))[0].ok,[...workerEntry,...inboxWorker].includes(f.proname),'worker '+f.proname);
 }
 await assert.rejects(worker.query('SELECT hon.read_school_social_posts($1,now(),now())',['x']),/permission denied/);
 await assert.rejects(restricted.query('SELECT * FROM hon.claim_school_social_post_targets(1,60)'),/permission denied/);
 pass('forced deny-all RLS on three new tables; runtime executes exactly six post entry points and the worker exactly three; neither crosses over');

 const module=await Test.createTestingModule({controllers:[SchoolSocialPostsController],providers:[SchoolSocialPostsService,G.SchoolSocialReadHumanUiGuard,G.SchoolSocialPostCreateHumanUiGuard,G.SchoolSocialPostEditHumanUiGuard,G.SchoolSocialPostApproveHumanUiGuard,G.SchoolSocialPostCancelHumanUiGuard,G.SchoolSocialPostResolveHumanUiGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database},{provide:ZERNIO_SOCIAL_ADAPTER,useValue:fake}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 for(const x of [a,b]){await setAccess(x,'ACTIVE');
  assert.equal((await q("SELECT count(*) n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.code='OWNER' AND r.is_system_role AND rp.permission_code='marketing.social.post'",[x.org]))[0].n,'1');}
 const A=await seedAccounts(a,[['fbOn','FACEBOOK',true],['fbOff','FACEBOOK',false],['ig','INSTAGRAM',true]]),B=await seedAccounts(b,[['fbB','FACEBOOK',true]]);

 // 2. Drafts: Facebook accounts of this exact school only; Instagram needs media; replay and key reuse.
 const key=K();let r=await create(a,{text:TEXT,accountIds:[A.fbOn.id,A.fbOff.id],linkUrl:'https://dojo.example.test/trial'},{key});
 let p=C.verifySocialPost(ok(r));assert.equal(r.body.meta.replayed,false);
 assert.deepEqual([p.status,p.text,p.linkUrl,p.accountIds.length,p.targets.length,p.version],['DRAFT',TEXT,'https://dojo.example.test/trial',2,0,1]);
 r=await create(a,{text:TEXT,accountIds:[A.fbOn.id,A.fbOff.id],linkUrl:'https://dojo.example.test/trial'},{key});assert.equal(r.body.meta.replayed,true);assert.equal(ok(r).postId,p.postId);
 r=await create(a,{text:'Different',accountIds:[A.fbOn.id]},{key});assert.equal(r.status,409);assert.equal(r.body.code,'IDEMPOTENCY_KEY_REUSED');
 r=await create(a,{text:TEXT,accountIds:[A.ig.id]});assert.equal(r.status,422);assert.equal(r.body.code,'SOCIAL_MEDIA_REQUIRED');
 r=await create(a,{text:TEXT,accountIds:[B.fbB.id]});assert.equal(r.status,404);assert.equal(r.body.code,'SOCIAL_ACCOUNT_NOT_FOUND');
 r=await create(a,{text:TEXT,accountIds:[A.fbOn.id,B.fbB.id]});assert.equal(r.status,404);
 for(const bad of [{text:' ',accountIds:[A.fbOn.id]},{text:'x'.repeat(2201),accountIds:[A.fbOn.id]},{text:TEXT,accountIds:[A.fbOn.id],linkUrl:'http://x.test'},{text:TEXT,accountIds:[A.fbOn.id],status:'APPROVED'}]){
  r=await create(a,bad);assert.equal(r.status,400,JSON.stringify(bad).slice(0,60));}
 assert.equal((await q('SELECT count(*) n FROM hon.school_social_posts WHERE organization_id=$1',[a.org]))[0].n,'1');
 pass('a draft takes 1 to 4 connected Facebook accounts of this exact school; Instagram is refused as needing media; exact replay, refused key reuse, strict bodies');

 // 3. Edit by version; approval needs every account still connected with publishing on; frozen after approval.
 r=await edit(a,p.postId,{text:TEXT,accountIds:[A.fbOn.id,A.fbOff.id],expectedVersion:2});assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_VERSION_CONFLICT');
 r=await approve(a,p.postId,{expectedVersion:1});assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_PUBLISH_OFF');
 assert.equal((await q('SELECT count(*) n FROM hon.school_social_post_targets WHERE post_id=$1',[p.postId]))[0].n,'0','a refused approval writes no target');
 p=C.verifySocialPost(ok(await edit(a,p.postId,{text:TEXT+' Edited.',accountIds:[A.fbOn.id],expectedVersion:1})));assert.equal(p.version,2);assert.equal(p.linkUrl,null);
 const later=new Date(Date.now()+2*3_600_000).toISOString();
 r=await approve(a,p.postId,{expectedVersion:2,publishAt:new Date(Date.now()+91*86_400_000).toISOString()});assert.equal(r.status,400);
 r=await approve(a,p.postId,{expectedVersion:2,publishAt:new Date(Date.now()-10*60_000).toISOString()});assert.equal(r.status,400);
 p=C.verifySocialPost(ok(await approve(a,p.postId,{expectedVersion:2,publishAt:later})));
 assert.deepEqual([p.status,p.targets.length,p.targets[0].status,p.version],['APPROVED',1,'PENDING',3]);assert.equal(Date.parse(p.publishAt),Date.parse(later));
 r=await edit(a,p.postId,{text:'Changed after approval',accountIds:[A.fbOn.id],expectedVersion:3});assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_POST_STATE');
 r=await approve(a,p.postId,{expectedVersion:3});assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_POST_STATE');
 const scheduled=p;
 pass('edits go by version; approval is refused with nothing written while an account has publishing off, schedules up to 90 days ahead, and freezes the post');

 // 4. The worker claims nothing while publishing is off, and nothing that is not due.
 let s=await dispatcher.runOnce();assert.deepEqual([s.ready,s.claimed],[false,0]);
 fakeEnv.HON_ZERNIO_FAKE_PROVIDER='1';
 s=await dispatcher.runOnce();assert.deepEqual([s.ready,s.claimed],[true,0],'a post due in two hours is not claimed');
 assert.equal((await calendar(a)).publishEnabled,true);
 // Publish now: one target, published once with HON's target id as the idempotency key; never sent twice.
 let now=C.verifySocialPost(ok(await create(a,{text:'Open mat tonight',accountIds:[A.fbOn.id]})));
 now=C.verifySocialPost(ok(await approve(a,now.postId,{expectedVersion:1})));
 s=await dispatcher.runOnce();assert.deepEqual([s.claimed,s.published,s.unknown],[1,1,0]);
 let t=await target(now.targets[0].targetId);assert.equal(t.status,'PUBLISHED');assert.match(t.provider_post_id,/^fakepost_/);
 assert.deepEqual(fake.published.map(x=>[x.idempotencyKey,x.providerAccountId,x.text]),[[t.id,A.fbOn.provider_account_id,'Open mat tonight']]);
 s=await dispatcher.runOnce();assert.equal(s.claimed,0);assert.equal(fake.published.length,1);
 const published=C.verifySocialPost((await calendar(a)).posts.find(x=>x.postId===now.postId));assert.equal(published.targets[0].status,'PUBLISHED');
 assert(!JSON.stringify(published).includes('fakepost_'),'the provider post id never leaves through the API');
 pass('nothing is claimed while publishing is off or before the publish time; a due target is published exactly once with its own id as the idempotency key');

 // 5. Claim-time checks: account off or school access lapsed -> SKIPPED, nothing sent.
 let off=C.verifySocialPost(ok(await approve(a,(C.verifySocialPost(ok(await create(a,{text:'Skipped one',accountIds:[A.fbOn.id]})))).postId,{expectedVersion:1})));
 await accountUpdate(A.fbOn.id,'publish_enabled=false');
 s=await dispatcher.runOnce();assert.equal(s.claimed,0);
 t=await target(off.targets[0].targetId);assert.deepEqual([t.status,t.skip_reason],['SKIPPED','ACCOUNT_OFF']);
 await accountUpdate(A.fbOn.id,'publish_enabled=true');
 off=C.verifySocialPost(ok(await approve(a,(C.verifySocialPost(ok(await create(a,{text:'Lapsed one',accountIds:[A.fbOn.id]})))).postId,{expectedVersion:1})));
 await setAccess(a,'SUSPENDED');s=await dispatcher.runOnce();await setAccess(a,'ACTIVE');
 t=await target(off.targets[0].targetId);assert.deepEqual([t.status,t.skip_reason],['SKIPPED','SCHOOL_INACTIVE']);
 assert.equal(fake.published.length,1);
 pass('at claim time an account with publishing off, or a school whose access lapsed, is SKIPPED and nothing is sent');

 // 6. Unknown answers, lease expiry, late results and a person's resolution; never resent.
 let u=C.verifySocialPost(ok(await approve(a,(C.verifySocialPost(ok(await create(a,{text:'Lost answer',accountIds:[A.fbOn.id]})))).postId,{expectedVersion:1})));
 fake.failNext.publishPost='UNKNOWN';s=await dispatcher.runOnce();assert.deepEqual([s.claimed,s.unknown],[1,1]);
 t=await target(u.targets[0].targetId);assert.deepEqual([t.status,t.provider_post_id],['UNKNOWN',null]);
 s=await dispatcher.runOnce();assert.equal(s.claimed,0,'an UNKNOWN target is never claimed again');
 r=await resolve(a,t.id,{expectedVersion:t.version,outcome:'NOT_PUBLISHED'});u=C.verifySocialPost(ok(r));
 assert.deepEqual([u.targets[0].status,u.targets[0].failureCode,u.targets[0].resolvedByPerson],['FAILED','CONFIRMED_NOT_PUBLISHED',true]);
 r=await resolve(a,t.id,{expectedVersion:t.version+1,outcome:'PUBLISHED'});assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_POST_STATE');
 // Lease expiry: claimed by a worker that never answers.
 let lease=C.verifySocialPost(ok(await approve(a,(C.verifySocialPost(ok(await create(a,{text:'Lease runs out',accountIds:[A.fbOn.id]})))).postId,{expectedVersion:1})));
 const [claim]=await w('SELECT * FROM hon.claim_school_social_post_targets(1,30)');assert.equal(claim.target_id,lease.targets[0].targetId);assert.equal(claim.body,'Lease runs out');
 r=await resolve(a,claim.target_id,{expectedVersion:2,outcome:'PUBLISHED'});assert.equal(r.status,409,'a PUBLISHING target cannot be resolved by a person');
 await q('ALTER TABLE hon.school_social_post_targets DISABLE TRIGGER guarded');
 await q("UPDATE hon.school_social_post_targets SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[claim.target_id]);
 await q('ALTER TABLE hon.school_social_post_targets ENABLE TRIGGER guarded');
 assert.equal((await w('SELECT * FROM hon.claim_school_social_post_targets(5,60)')).length,0);
 assert.equal((await target(claim.target_id)).status,'UNKNOWN');
 let late=(await w("SELECT * FROM hon.record_school_social_post_result($1,$2,'PUBLISHED','zpost_late_1',NULL)",[claim.target_id,K()]))[0];assert.equal(late.accepted,false,'wrong lease token');
 late=(await w("SELECT * FROM hon.record_school_social_post_result($1,$2,'UNKNOWN',NULL,NULL)",[claim.target_id,claim.lease_token]))[0];assert.equal(late.accepted,false);
 late=(await w("SELECT * FROM hon.record_school_social_post_result($1,$2,'PUBLISHED','zpost_late_1',NULL)",[claim.target_id,claim.lease_token]))[0];assert.deepEqual([late.status,late.accepted],['PUBLISHED',true]);
 late=(await w("SELECT * FROM hon.record_school_social_post_result($1,$2,'FAILED',NULL,'PROVIDER_REJECTED')",[claim.target_id,claim.lease_token]))[0];assert.deepEqual([late.status,late.accepted],['PUBLISHED',false]);
 await assert.rejects(w("SELECT * FROM hon.record_school_social_post_result($1,$2,'PUBLISHED',NULL,NULL)",[claim.target_id,claim.lease_token]),/SOCIAL_INVALID/);
 // A provider post id another target holds is not trusted.
 let dup=C.verifySocialPost(ok(await approve(a,(C.verifySocialPost(ok(await create(a,{text:'Duplicate id',accountIds:[A.fbOn.id]})))).postId,{expectedVersion:1})));
 const [dupClaim]=await w('SELECT * FROM hon.claim_school_social_post_targets(1,60)');assert.equal(dupClaim.target_id,dup.targets[0].targetId);
 late=(await w("SELECT * FROM hon.record_school_social_post_result($1,$2,'PUBLISHED','zpost_late_1',NULL)",[dupClaim.target_id,dupClaim.lease_token]))[0];assert.deepEqual([late.status,late.accepted],['UNKNOWN',true]);
 assert.equal(fake.published.length,1,'none of these were sent by the fake');
 pass('a lost answer or expired lease is UNKNOWN and never claimed again; a late answer counts only under its own lease; a reused provider id stays UNKNOWN; a person settles an UNKNOWN once');

 // 7. Signed Zernio receipts (as the worker role): settle by provider post id and account, once per event id.
 const event=(id,type,platform,acct,post)=>w('SELECT * FROM hon.record_school_social_post_event($1,$2,$3,$4,$5)',[id,type,platform,acct,post]).then(x=>x[0].outcome);
 const pubId=(await target(now.targets[0].targetId)).provider_post_id;
 assert.equal(await event('evt_1','post.published','FACEBOOK',A.fbOn.provider_account_id,pubId),'IGNORED');
 assert.equal(await event('evt_1','post.failed','FACEBOOK',A.fbOn.provider_account_id,pubId),'REPLAYED');
 assert.equal(await event('evt_2','post.failed','FACEBOOK',B.fbB.provider_account_id,pubId),'UNMATCHED','another school\'s account never settles this post');
 assert.equal(await event('evt_3','post.failed','FACEBOOK',A.fbOn.provider_account_id,pubId),'APPLIED');
 t=await target(now.targets[0].targetId);assert.deepEqual([t.status,t.failure_code],['FAILED','PROVIDER_REPORTED_FAILED']);
 assert.equal(await event('evt_4','post.published','FACEBOOK',A.fbOn.provider_account_id,pubId),'IGNORED','nothing moves back from FAILED');
 assert.equal(await event('evt_5','post.failed','FACEBOOK',A.fbOn.provider_account_id,'zpost_late_1'),'APPLIED');
 assert.equal(await event('evt_6','post.published','FACEBOOK','nobody','zpost_x'),'UNMATCHED');
 assert.equal(await event('evt_7','account.disconnected','FACEBOOK',B.fbB.provider_account_id,null),'APPLIED');
 const gone=(await q('SELECT * FROM hon.school_social_accounts WHERE id=$1',[B.fbB.id]))[0];
 assert.deepEqual([gone.status,gone.publish_enabled,gone.inbox_enabled,gone.ads_enabled],['DISCONNECTED',false,false,false]);
 assert.equal(await event('evt_8','account.disconnected','FACEBOOK',B.fbB.provider_account_id,null),'IGNORED');
 await assert.rejects(event('evt bad','post.failed','FACEBOOK',A.fbOn.provider_account_id,pubId),/SOCIAL_INVALID/);
 await assert.rejects(event('evt_9','account.disconnected','FACEBOOK',A.fbOn.provider_account_id,pubId),/SOCIAL_INVALID/);
 assert.equal((await q('SELECT count(*) n FROM hon.school_social_post_receipts'))[0].n,'8');
 pass('receipts settle only the target holding that post id on that school\'s account, once per event id; a later platform refusal turns PUBLISHED into FAILED, never back; account.disconnected forces every switch off');

 // 8. Cancel: a draft with marketing.social.post, an approved post only with manage and only while nothing was sent.
 let d=C.verifySocialPost(ok(await create(a,{text:'Never mind',accountIds:[A.fbOn.id]})));
 d=C.verifySocialPost(ok(await cancel(a,d.postId,{expectedVersion:1})));assert.deepEqual([d.status,d.targets.length],['CANCELLED',0]);
 r=await cancel(a,d.postId,{expectedVersion:2});assert.equal(r.status,409);
 d=C.verifySocialPost(ok(await cancel(a,scheduled.postId,{expectedVersion:3})));assert.deepEqual([d.status,d.targets[0].status],['CANCELLED','CANCELLED']);
 r=await cancel(a,u.postId,{expectedVersion:u.version});assert.equal(r.status,409,'an approved post with a sent target cannot be cancelled');
 pass('drafts and untouched approved posts cancel (pending targets CANCELLED); a post with any sent target cannot be cancelled');

 // 9. Permission split: without marketing.social.manage a person may draft and edit but never approve, cancel an approved post or resolve.
 await q("DELETE FROM hon.role_permissions WHERE organization_id=$1 AND permission_code='marketing.social.manage'",[a.org]);
 const staffDraft=C.verifySocialPost(ok(await create(a,{text:'Drafted by staff',accountIds:[A.fbOn.id]})));
 r=await approve(a,staffDraft.postId,{expectedVersion:1});assert.equal(r.status,403);
 let pending=(await q("SELECT p.id,p.version FROM hon.school_social_posts p JOIN hon.school_social_post_targets t ON t.post_id=p.id WHERE p.organization_id=$1 AND p.status='APPROVED' AND t.status='PENDING' LIMIT 1",[a.org]))[0];
 if(!pending){await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT id,organization_id,'marketing.social.manage' FROM hon.roles WHERE organization_id=$1 AND code='OWNER' AND is_system_role",[a.org]);
  const x=C.verifySocialPost(ok(await approve(a,(C.verifySocialPost(ok(await create(a,{text:'Pending for cancel test',accountIds:[A.fbOn.id]})))).postId,{expectedVersion:1,publishAt:later})));pending={id:x.postId,version:x.version};
  await q("DELETE FROM hon.role_permissions WHERE organization_id=$1 AND permission_code='marketing.social.manage'",[a.org]);}
 r=await cancel(a,pending.id,{expectedVersion:pending.version});assert.equal(r.status,403);
 r=await resolve(a,dupClaim.target_id,{expectedVersion:3,outcome:'PUBLISHED'});assert.equal(r.status,403);
 ok(await cancel(a,staffDraft.postId,{expectedVersion:1}));
 await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT id,organization_id,'marketing.social.manage' FROM hon.roles WHERE organization_id=$1 AND code='OWNER' AND is_system_role",[a.org]);
 pass('marketing.social.post drafts, edits and cancels drafts; approving, cancelling an approved post and resolving need marketing.social.manage');

 // 10. Authority and isolation: another school, wrong ids, delegation, wrong commands, query values, suspended access.
 const before=await evidence(a);
 r=await send(base(a)+`/posts?from=${new Date().toISOString()}&to=${new Date(Date.now()+86_400_000).toISOString()}`,{identity:b});assert.equal(r.status,403);
 r=await approve(b,staffDraft.postId,{expectedVersion:2});assert.equal(r.status,404);
 r=await send(`organizations/${a.org}/schools/${b.school}/marketing/social/posts`,{identity:b,method:'POST',body:{text:TEXT,accountIds:[B.fbB.id]}});assert.equal(r.status,403);
 r=await create(a,{text:TEXT,accountIds:[A.fbOn.id]},{headers:{'x-hon-delegated-by-principal-id':K()}});assert.equal(r.status,403);
 r=await create(a,{text:TEXT,accountIds:[A.fbOn.id]},{command:C.SOCIAL_POST_APPROVE_COMMAND});assert.equal(r.status,403);
 r=await approve(a,staffDraft.postId,{expectedVersion:2},{command:C.SOCIAL_POST_CREATE_COMMAND});assert.equal(r.status,403);
 r=await send(base(a)+'/posts?schoolId='+b.school,{identity:a,method:'POST',body:{text:TEXT,accountIds:[A.fbOn.id]}});assert.equal(r.status,400);
 r=await create({...person('stranger'),org:a.org,school:a.school},{text:TEXT,accountIds:[A.fbOn.id]});assert.equal(r.status,403);
 await setAccess(a,'SUSPENDED');r=await create(a,{text:TEXT,accountIds:[A.fbOn.id]});assert.equal(r.status,403);await setAccess(a,'ACTIVE');
 assert.deepEqual(await evidence(a),before,'refusals write nothing');
 const calA=await calendar(a),calB=await calendar(b);
 assert(calA.posts.length>=8);assert.equal(calB.posts.length,0);assert(calA.posts.every(x=>x.accountIds.every(id=>[A.fbOn.id,A.fbOff.id].includes(id))));
 assert.equal((await calendar(a,new Date(Date.now()+3_600_000),new Date(Date.now()+3*3_600_000))).posts.length,2,'the range filter uses the publish time');
 pass('another school, wrong ids, delegation, wrong browser commands, query values, unknown person and suspended access are refused with nothing written; each school reads only its own posts');

 // 11. Evidence is identifiers only, and the records cannot be rewritten.
 const ev=await evidence(a);assert(Number(ev.a)>=20);assert.equal(ev.a,ev.o);
 const trail=(await q("SELECT coalesce(next_state::text,'') s FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'marketing.social.post%' UNION ALL SELECT payload::text FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'marketing.social.post%'",[a.org])).map(x=>x.s).join();
 assert(!/Free trial|Open mat|dojo\.example|fakepost_|zpost_|fbOn_|Synthetic/.test(trail),trail.slice(0,300));
 await assert.rejects(q("UPDATE hon.school_social_posts SET body='rewritten',version=version+1 WHERE id=$1",[now.postId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_posts SET school_id=$2,version=version+1 WHERE id=$1",[staffDraft.postId,b.school]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_post_targets SET status='PENDING',lease_token=NULL,attempted_at=NULL,settled_at=NULL,version=version+1 WHERE id=$1",[now.targets[0].targetId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_post_targets SET status='PUBLISHED',failure_code=NULL,version=version+1 WHERE id=$1",[now.targets[0].targetId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q('DELETE FROM hon.school_social_post_targets WHERE id=$1',[now.targets[0].targetId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_post_receipts SET outcome='APPLIED'"),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q('TRUNCATE hon.school_social_post_receipts'),/SOCIAL_RECORD_IMMUTABLE/);
 pass('audit and outbox carry identifiers only (no post text, links or provider ids); posts, targets and receipts cannot be rewritten, moved back, deleted or truncated');
 console.log('PASS: school social posts (0348), '+groups+' groups');
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await store.onModuleDestroy();await Promise.allSettled([admin.end(),restricted.end(),worker.end()]);}
