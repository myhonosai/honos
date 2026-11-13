/** Onboarding answers and setup progress (0323): real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL.
 *  No provider, payment, message or AI. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point; the sign-up program is opened
 *  to TEST_MODE by this proof's owner connection only. Entitlements are changed by the owner connection to stand in for a trial or paid access. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {SchoolOnboardingController}=require('./dist/onboarding/school-onboarding.controller.js');
const {SchoolOnboardingService}=require('./dist/onboarding/school-onboarding.service.js');
const {SchoolOnboardingReadHumanUiGuard,SchoolOnboardingSaveHumanUiGuard}=require('./dist/onboarding/school-onboarding.guard.js');
const {SIGNUP_CONFIRMATION,ONBOARDING_HUMAN_COMMAND,verifySchoolOnboarding}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'onboarding-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS ONBOARDING '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command=ONBOARDING_HUMAN_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const person=label=>({externalSubject:'oidc:onboarding:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=person(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:SIGNUP_CONFIRMATION},K()])).rows[0].data;
 return {...p,org:r.organizationId,school:r.schoolId};}
const path=w=>`organizations/${w.org}/schools/${w.school}/onboarding`;
const get=async w=>verifySchoolOnboarding(ok(await send(path(w),{identity:w})));
const step=(o,key)=>o.steps.find(s=>s.key===key);
const blank={situation:null,disciplines:[],customDiscipline:null,goals:[],path:null,previousSoftware:null,previousSoftwareOther:null,importWishes:[],skippedSteps:[]};
const save=(w,answers,expectedVersion,key=K(),extra={})=>send(path(w)+'/profile',{identity:w,method:'POST',key,body:{expectedVersion,...blank,...answers},...extra});
const evidence=async w=>(await q("SELECT (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1 AND action_code='onboarding.profile.saved') a,(SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1 AND event_type='onboarding.profile.saved') o",[w.org]))[0];
const setAccess=(w,status,until)=>q("UPDATE hon.organization_entitlements SET status=$2,effective_until=$3,updated_at=clock_timestamp() WHERE organization_id=$1",[w.org,status,until]);

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody and exact runtime ACL.
 for(const t of ['school_onboarding_profiles','school_onboarding_requests']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname IN ('guard_school_onboarding','require_onboarding_actor','school_onboarding_profile_json','onboarding_codes','onboarding_choice','onboarding_text','save_school_onboarding','onboarding_step','read_school_onboarding')");
 assert.equal(fns.length,9);
 for(const f of fns)assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,['save_school_onboarding','read_school_onboarding'].includes(f.proname),f.proname);
 pass('forced deny-all RLS on two new tables; runtime executes exactly two entry points');

 const module=await Test.createTestingModule({controllers:[SchoolOnboardingController],providers:[SchoolOnboardingService,SchoolOnboardingReadHumanUiGuard,SchoolOnboardingSaveHumanUiGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 // Owners of new sign-ups hold onboarding.manage (registration copies every permission; the migration backfills older OWNER roles).
 for(const w of [a,b])assert.equal((await q("SELECT count(*) n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.code='OWNER' AND r.is_system_role AND rp.permission_code='onboarding.manage'",[w.org]))[0].n,'1');

 // 2. D3: a signed-up school with no trial or paid access sees its welcome and school details; school-data steps are UNAVAILABLE.
 let o=await get(a);
 assert.equal(o.access.state,'NOT_STARTED');assert.equal(o.access.trialStatus,null);assert.equal(o.profile,null);assert.equal(o.schoolName,'Synthetic alpha Dojo');assert.equal(o.timezone,'America/Chicago');
 assert.equal(step(o,'SCHOOL_DETAILS').status,'COMPLETE');assert.equal(step(o,'WELCOME').status,'NOT_STARTED');assert.equal(step(o,'INTERFACE').status,'NOT_STARTED');
 for(const k of ['PROGRAM','CLASS_SCHEDULE','MEMBERSHIP_PLAN','FIRST_LEAD','TRIAL_BOOKED','FIRST_STUDENT','STAFF','IMPORT'])assert.equal(step(o,k).status,'UNAVAILABLE',k);
 pass('pre-trial owner reads onboarding without an active entitlement; every school-data step is UNAVAILABLE');

 // 3. Save, exact replay, key reuse, stale version, closed validation; identifier-only evidence.
 const first={situation:'EXISTING_SCHOOL',disciplines:['TAEKWONDO','OTHER'],customDiscipline:'Hapkido-Yudo',goals:['MORE_STUDENTS','RETENTION']};
 const key=K();let r=await save(a,first,0,key);let p=ok(r);
 assert.equal(p.version,1);assert.equal(r.body.meta.replayed,false);assert.deepEqual(p.disciplines,['OTHER','TAEKWONDO']);
 r=await save(a,first,0,key);assert.deepEqual(ok(r),p);assert.equal(r.body.meta.replayed,true);
 r=await save(a,{...first,goals:['REPORTING']},0,key);assert.equal(r.status,409);assert.equal(r.body.code,'IDEMPOTENCY_KEY_REUSED');
 r=await save(a,first,0);assert.equal(r.status,409);assert.equal(r.body.code,'VERSION_CONFLICT');
 for(const bad of [{situation:'BOSS'},{goals:['MORE_STUDENTS','MORE_STUDENTS']},{disciplines:['KARATE'],customDiscipline:'x'},{previousSoftware:'SPARK',previousSoftwareOther:'x'},{customDiscipline:'<b>'}]){
  r=await save(a,bad,1);assert.equal(r.status,400,JSON.stringify([bad,r.body]));}
 r=await send(path(a)+'/profile',{identity:a,method:'POST',body:{...blank,expectedVersion:1,extra:1}});assert.equal(r.status,400);
 let ev=await evidence(a);assert.deepEqual([Number(ev.a),Number(ev.o)],[1,1]);
 const audit=(await q("SELECT next_state::text s FROM hon.audit_events WHERE organization_id=$1 AND action_code='onboarding.profile.saved'",[a.org]))[0].s;
 assert(!/TAEKWONDO|Hapkido|MORE_STUDENTS/.test(audit),audit);
 o=await get(a);assert.equal(step(o,'WELCOME').status,'IN_PROGRESS');
 p=ok(await save(a,{...first,path:'SWITCHING',previousSoftware:'OTHER',previousSoftwareOther:'Old Dojo App',importWishes:['STUDENTS','BALANCES'],skippedSteps:['STAFF']},1));
 assert.equal(p.version,2);o=await get(a);assert.equal(step(o,'WELCOME').status,'COMPLETE');assert.equal(o.profile.previousSoftwareOther,'Old Dojo App');
 assert.equal(step(o,'STAFF').status,'UNAVAILABLE');assert.equal(step(o,'STAFF').skipped,true);
 pass('answers save with exact replay, refused key reuse and stale versions, closed validation, and identifier-only audit and outbox');

 // 4. Isolation and authority: another school, a delegation header, a missing command, a revoked grant.
 r=await send(path(a),{identity:b});assert.equal(r.status,403);
 r=await send(`organizations/${a.org}/schools/${b.school}/onboarding`,{identity:b});assert.equal(r.status,403);
 r=await send(path(a),{identity:a,headers:{'x-hon-delegated-by-principal-id':K()}});assert.equal(r.status,403);
 r=await save(a,first,2,K(),{command:'students.import.stage'});assert.equal(r.status,403);
 r=await send(path(a),{identity:person('stranger')});assert.equal(r.status,403);
 const grant=(await q('SELECT owner_grant_id g FROM hon.hon_os_school_registrations WHERE organization_id=$1',[b.org]))[0].g;
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[grant]);
 r=await send(path(b),{identity:b});assert.equal(r.status,403);r=await save(b,first,0);assert.equal(r.status,403);
 ev=await evidence(a);assert.deepEqual([Number(ev.a),Number(ev.o)],[2,2]);
 assert.equal((await q('SELECT count(*) n FROM hon.school_onboarding_profiles WHERE organization_id=$1',[b.org]))[0].n,'0');
 pass('another school, wrong school ids, delegation, wrong browser command, unknown person and a revoked grant are all refused with nothing written');

 // 5. With access, progress comes from real records and goes back when the records do.
 await setAccess(a,'ACTIVE',null);
 o=await get(a);assert.equal(o.access.state,'ACTIVE');
 for(const k of ['PROGRAM','CLASS_SCHEDULE','MEMBERSHIP_PLAN','FIRST_LEAD','FIRST_STUDENT','STAFF','IMPORT'])assert.equal(step(o,k).status,'NOT_STARTED',k);
 const program=(await q("INSERT INTO hon.programs(organization_id,school_id,name,status) VALUES($1,$2,'Little Tigers','SCHEDULED') RETURNING id",[a.org,a.school]))[0].id;
 const cls=(await q("INSERT INTO hon.class_sessions(organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy) VALUES($1,$2,$3,'Little Tigers',clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day 1 hour',12,'WALK_IN') RETURNING id",[a.org,a.school,program]))[0].id;
 o=await get(a);assert.equal(step(o,'PROGRAM').status,'COMPLETE');assert.equal(step(o,'PROGRAM').count,1);assert.equal(step(o,'CLASS_SCHEDULE').status,'COMPLETE');
 await q("UPDATE hon.class_sessions SET status='CANCELLED',cancellation_reason='synthetic' WHERE id=$1",[cls]);
 await q("UPDATE hon.programs SET status='CANCELLED' WHERE id=$1",[program]);
 o=await get(a);assert.equal(step(o,'PROGRAM').status,'NOT_STARTED');assert.equal(step(o,'CLASS_SCHEDULE').status,'NOT_STARTED');
 assert.equal(step(o,'STAFF').status,'NOT_STARTED');assert.equal(step(o,'STAFF').skipped,true);assert.equal(step(o,'IMPORT').status,'NOT_STARTED');
 p=ok(await save(a,{...first,path:'NEW'},2));o=await get(a);assert.equal(step(o,'IMPORT'),undefined);
 pass('with access each step reads live records: a program and a class turn COMPLETE, then back to NOT_STARTED once cancelled; the switching-only import step follows the path; skips are kept');

 // 6. Access that ended: school-data steps close again, answers stay.
 await q("UPDATE hon.organization_entitlements SET effective_from=clock_timestamp()-interval '2 days',effective_until=clock_timestamp()-interval '1 day',updated_at=clock_timestamp() WHERE organization_id=$1",[a.org]);
 o=await get(a);assert.equal(o.access.state,'ENDED');assert.equal(step(o,'PROGRAM').status,'UNAVAILABLE');assert.equal(o.profile.version,3);
 pass('ended access closes school-data steps again and keeps the saved answers');

 // 7. Evidence rows cannot be changed or removed outside the entry points.
 await assert.rejects(()=>q('DELETE FROM hon.school_onboarding_profiles WHERE organization_id=$1',[a.org]),/ONBOARDING_IMMUTABLE/);
 await assert.rejects(()=>q('UPDATE hon.school_onboarding_profiles SET version=version+5 WHERE organization_id=$1',[a.org]),/ONBOARDING_IMMUTABLE/);
 await assert.rejects(()=>q('UPDATE hon.school_onboarding_requests SET response=$2 WHERE organization_id=$1',[a.org,'{}']),/ONBOARDING_IMMUTABLE/);
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.school_onboarding_profiles'),e=>e.code==='42501');
 pass('profiles and requests refuse delete, version jumps and response rewrites; the runtime role cannot read the tables');
 console.log('PASS: school onboarding answers and computed setup progress (0323), '+groups+' groups');
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end()]);}
