/** School social connections (0347): real signed HON sessions -> Nest/guards -> fixed runtime SQL -> marked disposable PostgreSQL.
 *  Zernio is the deterministic in-process fake adapter only; no provider, message, post, ad or payment. Schools are SYNTHETIC sign-ups made
 *  through the 0241 runtime entry point (TEST_MODE opened by this proof's owner connection); the owner connection stands in for paid access. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER|ZERNIO).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {SchoolSocialController}=require('./dist/marketing/social/school-social.controller.js');
const {SchoolSocialService}=require('./dist/marketing/social/school-social.service.js');
const {SchoolSocialReadHumanUiGuard,SchoolSocialConnectHumanUiGuard,SchoolSocialCompleteHumanUiGuard,SchoolSocialChangeHumanUiGuard}=require('./dist/marketing/social/school-social.guard.js');
const {FakeZernioSocialAdapter,ZERNIO_SOCIAL_ADAPTER}=require('./dist/marketing/social/zernio-social-adapter.js');
const {SIGNUP_CONFIRMATION,SOCIAL_CONNECT_COMMAND,SOCIAL_CONNECT_COMPLETE_COMMAND,SOCIAL_ACCOUNT_CHANGE_COMMAND,verifySocialAccountList}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'social-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
// The fake adapter reads its switch from this object only; the proof turns it on and off.
const fakeEnv={HON_DEPLOYMENT_ENVIRONMENT:'development'};const fake=new FakeZernioSocialAdapter(()=>fakeEnv);
const pass=name=>console.log('PASS SOCIAL '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command=SOCIAL_CONNECT_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const person=label=>({externalSubject:'oidc:social:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=person(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:SIGNUP_CONFIRMATION},K()])).rows[0].data;
 return {...p,org:r.organizationId,school:r.schoolId};}
const setAccess=(w,status)=>q("UPDATE hon.organization_entitlements SET status=$2,effective_from=clock_timestamp()-interval '1 day',effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1",[w.org,status]);
const base=w=>`organizations/${w.org}/schools/${w.school}/marketing/social`;
const list=async w=>verifySocialAccountList(ok(await send(base(w)+'/accounts',{identity:w})));
const connect=(w,platform,extra={})=>send(base(w)+'/connect',{identity:w,method:'POST',body:{platform},...extra});
const complete=(w,state,extra={})=>send(base(w)+'/connect/complete',{identity:w,method:'POST',command:SOCIAL_CONNECT_COMPLETE_COMMAND,body:{state},...extra});
const change=(w,id,body,key=K(),extra={})=>send(base(w)+'/accounts/'+id,{identity:w,method:'POST',command:SOCIAL_ACCOUNT_CHANGE_COMMAND,key,body,...extra});
const stateOf=r=>new URL(ok(r).authUrl).searchParams.get('state');
const sha=s=>createHash('sha256').update(s).digest('hex');
const evidence=async w=>(await q("SELECT (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'marketing.social.%') a,(SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'marketing.social.%') o",[w.org]))[0];

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody and exact runtime ACL.
 const tables=['school_social_profiles','school_social_accounts','school_social_connect_intents','school_social_commands'];
 for(const t of tables){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const entry=['read_school_social_accounts','start_school_social_connect','record_school_social_profile','claim_school_social_connect','record_school_social_accounts','change_school_social_account'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%school_social%')");
 assert.equal(fns.length,12,fns.map(f=>f.proname).join());
 for(const f of fns)assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry.includes(f.proname),f.proname);
 pass('forced deny-all RLS on four new tables; runtime executes exactly six entry points');

 const module=await Test.createTestingModule({controllers:[SchoolSocialController],providers:[SchoolSocialService,SchoolSocialReadHumanUiGuard,SchoolSocialConnectHumanUiGuard,SchoolSocialCompleteHumanUiGuard,SchoolSocialChangeHumanUiGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database},{provide:ZERNIO_SOCIAL_ADAPTER,useValue:fake}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta'),c=await register('gamma');
 for(const w of [a,b,c])assert.equal((await q("SELECT count(*) n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.code='OWNER' AND r.is_system_role AND rp.permission_code IN ('marketing.social.manage','marketing.social.read')",[w.org]))[0].n,'2');

 // 2. Paid or trial access is required, and connecting is refused while the switch is off, before anything is written.
 let r=await send(base(a)+'/accounts',{identity:a});assert.equal(r.status,403);
 for(const w of [a,b,c])await setAccess(w,'ACTIVE');
 let l=await list(a);assert.deepEqual([l.profileLinked,l.connectEnabled,l.accounts.length],[false,false,0]);
 r=await connect(a,'FACEBOOK');assert.equal(r.status,503);assert.equal(r.body.code,'SOCIAL_CONNECT_NOT_ENABLED');
 assert.equal((await q('SELECT count(*) n FROM hon.school_social_connect_intents WHERE organization_id=$1',[a.org]))[0].n,'0');
 fakeEnv.HON_ZERNIO_FAKE_PROVIDER='1';
 assert.equal((await list(a)).connectEnabled,true);
 pass('no access, no read; with connecting off the read says so and a connect writes nothing');

 // 3. Connect Facebook: single-use hashed state, profile by HON's own name, accounts only from the school's own profile.
 r=await connect(a,'FACEBOOK');const startA=ok(r);const stateA=stateOf(r);
 assert.match(stateA,/^[A-Za-z0-9_-]{43}$/);assert.equal(new URL(startA.authUrl).pathname,'/staff/marketing/social/return');
 const intent=(await q('SELECT * FROM hon.school_social_connect_intents WHERE organization_id=$1',[a.org]))[0];
 assert.equal(intent.state_hash,sha(stateA));assert.equal(intent.platform,'FACEBOOK');assert.equal(intent.consumed_at,null);
 assert(!JSON.stringify(await q("SELECT row_to_json(x)::text t FROM hon.audit_events x WHERE organization_id=$1",[a.org])).includes(stateA));
 const profileA=(await q('SELECT provider_profile_id p FROM hon.school_social_profiles WHERE school_id=$1',[a.school]))[0].p;
 assert.equal(fake.profiles.get('hon-school-'+a.school),profileA);
 r=await complete(a,stateA);let done=ok(r);
 assert.deepEqual([done.platform,done.connected,done.conflicts,done.accounts.length],['FACEBOOK',1,0,1]);
 const fbA=done.accounts[0];assert.deepEqual([fbA.status,fbA.publishEnabled,fbA.inboxEnabled,fbA.adsEnabled,fbA.version,fbA.displayName],['CONNECTED',false,false,false,1,'Synthetic Dojo Page']);
 assert(!JSON.stringify(done).includes('fbpage_'),'the provider account id never leaves through the API');
 r=await complete(a,stateA);assert.equal(r.status,400);assert.equal(r.body.code,'SOCIAL_CONNECT_STATE_INVALID');
 r=await connect(a,'INSTAGRAM');done=ok(await complete(a,stateOf(r)));assert.equal(done.connected,1);assert.equal(done.accounts.length,2);
 l=await list(a);assert.equal(l.profileLinked,true);assert.deepEqual(l.accounts.map(x=>x.platform).sort(),['FACEBOOK','INSTAGRAM']);
 assert.equal(fake.profiles.size,1,'the second connect reused the linked profile');
 let ev=await evidence(a);assert.deepEqual([Number(ev.a),Number(ev.o)],[7,7]);
 const trail=(await q("SELECT next_state::text s FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'marketing.social.%'",[a.org])).map(x=>x.s).join();
 assert(!/Synthetic Dojo|synthetic\.dojo|fbpage_|igbiz_|fakeprofile_/.test(trail),trail);
 pass('connect stores only the state hash, links one profile by HON\'s name, records accounts with every switch off, refuses a used state, identifier-only audit and outbox');

 // 4. A state is bound to its school, person and 10 minutes; a rejected claim leaves it usable by its owner.
 r=await connect(b,'FACEBOOK');const stateB=stateOf(r);
 r=await complete(a,stateB);assert.equal(r.status,400);assert.equal(r.body.code,'SOCIAL_CONNECT_STATE_INVALID');
 r=await complete({...person('stranger'),org:b.org,school:b.school},stateB);assert.equal(r.status,403,JSON.stringify(r.body));
 r=await complete(b,'x'.repeat(43));assert.equal(r.status,400);
 r=await connect(b,'INSTAGRAM');const staleB=stateOf(r);
 await q('ALTER TABLE hon.school_social_connect_intents DISABLE TRIGGER guarded');
 await q("UPDATE hon.school_social_connect_intents SET created_at=created_at-interval '11 minutes',expires_at=expires_at-interval '11 minutes' WHERE state_hash=$1",[sha(staleB)]);
 await q('ALTER TABLE hon.school_social_connect_intents ENABLE TRIGGER guarded');
 r=await complete(b,staleB);assert.equal(r.status,400);assert.equal(r.body.code,'SOCIAL_CONNECT_STATE_EXPIRED');
 // 5. Conflict: B's profile also reports A's Facebook Page; B keeps its own account and A's is untouched.
 const profileB=(await q('SELECT provider_profile_id p FROM hon.school_social_profiles WHERE school_id=$1',[b.school]))[0].p;
 const fbIdA=(await q("SELECT provider_account_id p FROM hon.school_social_accounts WHERE school_id=$1 AND platform='FACEBOOK'",[a.school]))[0].p;
 fake.extra.set(profileB,[{providerAccountId:fbIdA,platform:'FACEBOOK',displayName:'Stolen Page'}]);
 done=ok(await complete(b,stateB));assert.deepEqual([done.connected,done.conflicts,done.accounts.length],[1,1,1]);
 const stillA=(await q('SELECT school_id,display_name FROM hon.school_social_accounts WHERE provider_account_id=$1',[fbIdA]))[0];
 assert.equal(stillA.school_id,a.school);assert.equal(stillA.display_name,'Synthetic Dojo Page');
 assert(!JSON.stringify(done).includes('Stolen'));fake.extra.clear();
 pass('a state works only for its own school and person within 10 minutes; an account another school holds is skipped as a conflict, never moved');

 // 6. Switches, idempotency, versions, disconnect and reconnect.
 const key=K();const on={expectedVersion:1,publishEnabled:true,inboxEnabled:true,adsEnabled:false};
 r=await change(a,fbA.accountId,on,key);let ch=ok(r);
 assert.equal(r.body.meta.replayed,false);assert.deepEqual([ch.account.publishEnabled,ch.account.inboxEnabled,ch.account.adsEnabled,ch.account.version,ch.providerRemoval],[true,true,false,2,'NOT_ATTEMPTED']);
 r=await change(a,fbA.accountId,on,key);assert.deepEqual(ok(r).account,ch.account);assert.equal(r.body.meta.replayed,true);
 r=await change(a,fbA.accountId,{...on,adsEnabled:true},key);assert.equal(r.status,409);assert.equal(r.body.code,'IDEMPOTENCY_KEY_REUSED');
 r=await change(a,fbA.accountId,on);assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_VERSION_CONFLICT');
 for(const bad of [{expectedVersion:2,publishEnabled:true},{expectedVersion:2,disconnect:false},{expectedVersion:'2',disconnect:true},{expectedVersion:2,publishEnabled:1,inboxEnabled:true,adsEnabled:false}]){
  r=await change(a,fbA.accountId,bad);assert.equal(r.status,400,JSON.stringify(bad));}
 r=await change(a,fbA.accountId,{expectedVersion:2,disconnect:true});ch=ok(r);
 assert.deepEqual([ch.account.status,ch.account.publishEnabled,ch.account.inboxEnabled,ch.account.adsEnabled,ch.providerRemoval],['DISCONNECTED',false,false,false,'REMOVED']);
 assert.deepEqual(fake.removed,[fbIdA]);assert(!JSON.stringify(r.body).includes(fbIdA));
 r=await change(a,fbA.accountId,{expectedVersion:3,publishEnabled:true,inboxEnabled:false,adsEnabled:false});assert.equal(r.status,409);assert.equal(r.body.code,'SOCIAL_ACCOUNT_DISCONNECTED');
 r=await change(a,K(),{expectedVersion:1,disconnect:true});assert.equal(r.status,404);
 done=ok(await complete(a,stateOf(await connect(a,'FACEBOOK'))));
 const back=done.accounts.find(x=>x.accountId===fbA.accountId);
 assert.deepEqual([back.status,back.publishEnabled,back.inboxEnabled,back.adsEnabled,back.version,back.disconnectedAt],['CONNECTED',false,false,false,4,null]);
 pass('switches change by version with exact replay and refused key reuse; disconnect forces every switch off and removes it from Zernio; reconnect returns the same account with switches off');

 // 7. Authority: another school, wrong ids, delegation, wrong commands, unknown person, revoked grant.
 r=await send(base(a)+'/accounts',{identity:b});assert.equal(r.status,403);
 r=await send(`organizations/${a.org}/schools/${b.school}/marketing/social/accounts`,{identity:b});assert.equal(r.status,403);
 r=await change(b,fbA.accountId,{expectedVersion:4,disconnect:true});assert.equal(r.status,404);
 r=await send(base(a)+'/accounts',{identity:a,headers:{'x-hon-delegated-by-principal-id':K()}});assert.equal(r.status,403);
 r=await connect(a,'FACEBOOK',{command:SOCIAL_ACCOUNT_CHANGE_COMMAND});assert.equal(r.status,403);
 r=await change(a,fbA.accountId,{expectedVersion:4,disconnect:true},K(),{command:SOCIAL_CONNECT_COMMAND});assert.equal(r.status,403);
 r=await connect({...person('stranger'),org:a.org,school:a.school},'FACEBOOK');assert.equal(r.status,403);
 r=await send(base(a)+'/accounts?platform=FACEBOOK',{identity:a});assert.equal(r.status,400);
 const grant=(await q('SELECT owner_grant_id g FROM hon.hon_os_school_registrations WHERE organization_id=$1',[b.org]))[0].g;
 const before=Number((await evidence(b)).a);
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[grant]);
 r=await send(base(b)+'/accounts',{identity:b});assert.equal(r.status,403);r=await connect(b,'FACEBOOK');assert.equal(r.status,403);
 assert.equal(Number((await evidence(b)).a),before);
 await setAccess(a,'SUSPENDED');r=await send(base(a)+'/accounts',{identity:a});assert.equal(r.status,403);await setAccess(a,'ACTIVE');
 pass('another school, wrong ids, another school\'s account, delegation, wrong browser commands, query values, unknown person, revoked grant and suspended access are refused with nothing written');

 // 8. At most ten connect attempts per school per hour, counted under a per-school lock.
 const results=await Promise.all(Array.from({length:12},()=>connect(c,'FACEBOOK')));
 assert.equal(results.filter(x=>x.status===200).length,10);assert(results.filter(x=>x.status!==200).every(x=>x.status===429&&x.body.code==='SOCIAL_RATE_LIMITED'));
 assert.equal((await q('SELECT count(*) n FROM hon.school_social_connect_intents WHERE organization_id=$1',[c.org]))[0].n,'10');
 assert.equal((await q('SELECT count(*) n FROM hon.school_social_profiles WHERE organization_id=$1',[c.org]))[0].n,'1');
 pass('concurrent connects stop at ten per school per hour with SOCIAL_RATE_LIMITED and link exactly one profile');

 // 9. Evidence guard.
 await assert.rejects(q("UPDATE hon.school_social_profiles SET provider_profile_id='moved' WHERE school_id=$1",[a.school]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_accounts SET school_id=$2,version=version+1 WHERE id=$1",[fbA.accountId,b.school]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.school_social_accounts SET provider_account_id='other',version=version+1 WHERE id=$1",[fbA.accountId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q('DELETE FROM hon.school_social_accounts WHERE id=$1',[fbA.accountId]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q('UPDATE hon.school_social_connect_intents SET consumed_at=NULL WHERE organization_id=$1 AND consumed_at IS NOT NULL',[a.org]),/SOCIAL_RECORD_IMMUTABLE/);
 await assert.rejects(q('TRUNCATE hon.school_social_commands CASCADE'),/SOCIAL_RECORD_IMMUTABLE|cannot truncate/);
 await assert.rejects(q("UPDATE hon.school_social_accounts SET status='DISCONNECTED',disconnected_at=clock_timestamp(),publish_enabled=true,version=version+1 WHERE id=$1",[fbA.accountId]),/check constraint/);
 pass('profiles, account identity, used states and command receipts cannot be edited, deleted or truncated; a disconnected account cannot hold a switch');
 console.log('PASS: school social connections (0347), '+groups+' groups');
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end()]);}
