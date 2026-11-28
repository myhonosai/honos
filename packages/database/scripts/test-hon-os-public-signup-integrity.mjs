/** HON OS public sign-up (0241): real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL.
 *  No provider, no email, no payment. The sign-up program is opened to TEST_MODE by this proof's owner connection only. */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes,createHash} from 'node:crypto';
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
const {HonOsSignupService}=require('./dist/accounts/hon-os-signup.service.js');
const {HonOsSignupController,HonOsSignupHumanGuard}=require('./dist/accounts/hon-os-signup.controller.js');
const {HonOsAdmissionService}=require('./dist/hon-os-admission/hon-os-admission.service.js');
const {HonOsAdmissionHqController,HonOsAdmissionHumanGuard,HonOsProgramsHqController,HonOsProgramsHumanGuard}=require('./dist/hon-os-admission/hon-os-admission.controller.js');
const {SIGNUP_CONFIRMATION,SIGNUP_HUMAN_COMMAND,ADMISSION_LIMITS_COMMAND,SIGNUP_PROGRAMS_COMMAND}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),blocker=new pg.Client({connectionString:owner.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'signup-disposable',secret:randomBytes(32).toString('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS SIGNUP '+(++groups)+' '+name);
const hash=x=>createHash('sha256').update(x).digest('hex');
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=(label,verified=true)=>({externalSubject:'oidc:signup:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',...(verified?{emailVerified:true}:{})});
async function send(path,{identity,body,key=K(),method='POST',headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':SIGNUP_HUMAN_COMMAND,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;};
const tables=['users','principals','organizations','schools','organization_entitlements','roles','role_permissions','principal_role_grants','school_account_requests','hon_os_school_registrations','saas_access_states'];
const counts=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await q('SELECT count(*) n FROM hon.'+t))[0].n])));
async function denied(work,status,code){const before=await counts();const r=await work();assert.equal(r.status,status,JSON.stringify(r.body));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));assert.deepEqual(await counts(),before);assert.equal(r.headers['cache-control'],'private, no-store');assert(!JSON.stringify(r.body).match(/external_subject|SQLSTATE|SELECT |hon\./));return r;}
const setProgram=status=>q("UPDATE hon.hon_os_signup_program SET status=$1,recorded_at=clock_timestamp() WHERE program_id=1",[status]);
let terms;
const form=(extra={})=>({ownerName:'Synthetic Owner',schoolName:'Synthetic Dragon Martial Arts',legalName:'Synthetic Dragon LLC',timezone:'America/Los_Angeles',
 location:{country:'US',region:'IL',city:'Chicago',postalCode:'60601',addressLine1:null,addressLine2:null},termsVersionId:terms,confirmation:SIGNUP_CONFIRMATION,...extra});

try{
 await Promise.all([admin.connect(),restricted.connect(),blocker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody and exact runtime ACL.
 for(const t of ['hon_os_signup_program','hon_os_signup_terms_versions','hon_os_school_registrations']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const fns=await q("SELECT p.oid,p.proname,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname IN ('guard_hon_os_signup_program','hon_os_signup_open','hon_os_signup_terms_json','hon_os_registration_json','hon_os_signup_name_valid','hon_os_signup_slug','register_hon_os_school','read_hon_os_registration')");
 assert.equal(fns.length,8);
 for(const f of fns){const entry=['register_hon_os_school','read_hon_os_registration'].includes(f.proname);
  assert.equal(f.prosecdef,entry,f.proname);assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry,f.proname);}
 assert.equal((await q('SELECT has_function_privilege($1,$2,$3) ok',[runtime.username,'hon.initialize_saas_hon_os_school_account(text,jsonb,uuid,uuid,uuid)','EXECUTE']))[0].ok,false);
 assert.equal((await q("SELECT status FROM hon.hon_os_signup_program"))[0].status,'CLOSED');
 await assert.rejects(()=>q("UPDATE hon.hon_os_signup_program SET status='LIVE'"),e=>e.code==='23514');
 await assert.rejects(()=>q("DELETE FROM hon.hon_os_signup_program"),e=>/SIGNUP_PROGRAM_IMMUTABLE/.test(e.message));
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 pass('forced deny-all RLS on three new tables; runtime executes exactly two entry points; 0183 initializer stays private; program seeded CLOSED with no LIVE value');

 const module=await Test.createTestingModule({controllers:[HonOsSignupController,HonOsAdmissionHqController,HonOsProgramsHqController],providers:[HonOsSignupService,HonOsSignupHumanGuard,HonOsAdmissionService,HonOsAdmissionHumanGuard,HonOsProgramsHumanGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 const excluded=new Set([...tables,'hon_os_signup_program','hq_operator_grants','families','family_access_grants','hon_os_admission_limit_versions','hon_os_admission_refusals','school_locations','school_location_versions']);
 const others=(await q("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).map(r=>r.tablename).filter(t=>!excluded.has(t));
 const snapshot=async()=>{const out={};for(const t of others){assert.match(t,/^[a-z_0-9]+$/);out[t]=hash(JSON.stringify(await q('SELECT to_jsonb(t)::text r FROM hon.'+t+' t ORDER BY 1')));}return out;};const baseline=await snapshot();

 // 2. Closed program: read says CLOSED, sign-up refused with zero effects.
 const dana=person('dana');
 const closed=ok(await send('account/sign-up',{identity:dana,method:'GET'}));
 assert.deepEqual({...closed,terms:undefined},{signupStatus:'CLOSED',terms:undefined,eligibility:'ELIGIBLE',registration:null});assert.equal(closed.terms.termsVersionId,terms);assert.equal(closed.terms.status,'FINAL');assert.equal(closed.terms.version,2);
 await denied(()=>send('account/sign-up',{identity:dana,body:form()}),409,'SIGNUP_CLOSED');
 await setProgram('TEST_MODE');
 pass('CLOSED by default: the read reports it and sign-up is refused with no identity or school written');

 // 3. Input and identity refusals, all with zero effects.
 await denied(()=>send('account/sign-up',{identity:person('unverified',false),body:form()}),403,'VERIFIED_EMAIL_REQUIRED');
 await denied(()=>send('account/sign-up',{body:form()}),401);
 for(const patch of [{email:'evil@example.invalid'},{subject:'oidc:other'},{organizationId:K()},{role:'OWNER'},{plan:'COMPLETE'}])await denied(()=>send('account/sign-up',{identity:dana,body:form(patch)}),400);
 for(const patch of [{confirmation:'YES'},{timezone:'Mars/Olympus'},{timezone:'posix/UTC'},{ownerName:''},{schoolName:'x'.repeat(121)},{legalName:'a\tb'},{location:undefined},{location:null},{location:{country:'US',region:null,city:'Chicago',postalCode:null,addressLine1:null,addressLine2:null}}])await denied(()=>send('account/sign-up',{identity:dana,body:form(patch)}),400);
 await denied(()=>send('account/sign-up',{identity:dana,body:form(),headers:{'x-hon-human-command':'school-staff-account'}}),403);
 await denied(()=>send('account/sign-up',{identity:dana,body:form(),headers:{origin:'https://evil.invalid'}}),403);
 await assert.rejects(()=>restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4)',['manus:'+K(),'x@example.invalid',form(),K()]),e=>e.code==='22023');
 await assert.rejects(()=>restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4)',[dana.externalSubject,'Mixed@Example.invalid',form(),K()]),e=>e.code==='22023');
 await denied(()=>send('account/sign-up',{identity:dana,body:form({termsVersionId:K()})}),409,'SIGNUP_TERMS_CHANGED');
 pass('unverified email, no session, forged body authority, bad names/time zone/confirmation, wrong command or origin, non-OIDC subject and stale terms are refused atomically');

 // 4. Happy path: exactly one organization, school, OWNER role and grant; entitlement SUSPENDED; no access, billing or AI.
 const key=K(),before=await counts();
 const signed=ok(await send('account/sign-up',{identity:dana,body:form(),key})),reg=signed.registration;
 // 0392: the address is recorded with the account, and the answer carries the Illinois face check-in notice (information only).
 assert.deepEqual(Object.keys(signed).sort(),['faceCheckInNotice','location','registration']);
 assert.equal(signed.location.city,'Chicago');assert.equal(signed.location.version,1);assert.equal(signed.faceCheckInNotice.profile,'US_IL_BIPA');
 assert.equal(signed.faceCheckInNotice.status,'AVAILABLE_WITH_CONSENT');assert.equal(signed.faceCheckInNotice.reviewStatus,'TEST_ONLY_DRAFT');
 assert.equal(reg.lifecycle,'REGISTERED');assert.equal(reg.schoolName,'Synthetic Dragon Martial Arts');assert.equal(reg.timezone,'America/Los_Angeles');
 assert.equal(reg.accessGranted,false);assert.equal(reg.billingActivated,false);assert.equal(reg.aiCreditsGranted,false);
 const after=await counts();
 for(const t of ['users','principals','organizations','schools','organization_entitlements','roles','principal_role_grants','school_account_requests','hon_os_school_registrations'])assert.equal(Number(after[t])-Number(before[t]),1,t);
 assert.equal(after.saas_access_states,before.saas_access_states);
 const ent=(await q('SELECT tier,status FROM hon.organization_entitlements WHERE organization_id=$1',[reg.organizationId]))[0];assert.deepEqual(ent,{tier:'COMPLETE',status:'SUSPENDED'});
 const row=(await q('SELECT r.*,s.slug,o.legal_name FROM hon.hon_os_school_registrations r JOIN hon.schools s ON s.id=r.school_id JOIN hon.organizations o ON o.id=r.organization_id WHERE r.id=$1',[reg.registrationId]))[0];
 assert.equal(row.subject,dana.externalSubject);assert.equal(row.verified_email,dana.email);assert.equal(row.terms_version_id,terms);assert.equal(row.program_status,'TEST_MODE');assert.equal(row.slug,'synthetic-dragon-martial-arts');assert.equal(row.legal_name,'Synthetic Dragon LLC');
 const role=(await q("SELECT r.code,r.is_system_role,(SELECT count(*) FROM hon.role_permissions p WHERE p.role_id=r.id) n,(SELECT count(*) FROM hon.permissions) total FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id WHERE g.id=$1",[row.owner_grant_id]))[0];
 assert.equal(role.code,'OWNER');assert(role.is_system_role);assert.equal(role.n,role.total);
 assert.equal((await q('SELECT display_name FROM hon.users WHERE external_subject=$1',[dana.externalSubject]))[0].display_name,'Synthetic Owner');
 // The grant exists, but every entitlement-gated path refuses the SUSPENDED school (B6A 0172 resolvers, staff management).
 assert.equal((await restricted.query('SELECT * FROM hon.resolve_authorized_scope($1,$2,$3)',[dana.externalSubject,reg.schoolId,'school.view'])).rowCount,1);
 assert.equal((await q('SELECT * FROM hon.resolve_follow_up_scope($1)',[dana.externalSubject])).length,0);
 assert.equal((await q('SELECT hon.school_staff_manager($1,$2) m',[dana.externalSubject,reg.schoolId]))[0].m,null);
 for(const t of ['saas_subscriptions','saas_checkout_sessions','saas_credit_allowances','saas_access_exceptions'])assert.equal((await q('SELECT count(*) n FROM hon.'+t+' WHERE organization_id=$1',[reg.organizationId]))[0].n,'0',t);
 pass('sign-up creates one organization, school (slug from the name), full OWNER role and grant, SUSPENDED entitlement and an immutable registration; the owner holds no capability; no access state, subscription, checkout, allowance or exception');

 // 5. Replay, key reuse, second registration.
 assert.deepEqual(ok(await send('account/sign-up',{identity:dana,body:form(),key})),signed);
 await denied(()=>send('account/sign-up',{identity:dana,body:form({location:{country:'US',region:'TX',city:'Austin',postalCode:null,addressLine1:null,addressLine2:null}}),key}),409,'SIGNUP_KEY_REUSED');
 await denied(()=>send('account/sign-up',{identity:dana,body:form({schoolName:'Changed'}),key}),409,'SIGNUP_KEY_REUSED');
 await denied(()=>send('account/sign-up',{identity:dana,body:form({schoolName:'Second School'})}),409,'SIGNUP_ALREADY_REGISTERED');
 const mine=ok(await send('account/sign-up',{identity:dana,method:'GET'}));
 assert.equal(mine.signupStatus,'TEST_MODE');assert.equal(mine.eligibility,'ALREADY_REGISTERED');assert.deepEqual(mine.registration,reg);
 const stranger=ok(await send('account/sign-up',{identity:person('stranger'),method:'GET'}));assert.equal(stranger.registration,null);assert.equal(stranger.eligibility,'ELIGIBLE');
 pass('same key returns the same receipt; changed body under the key and a second school for the identity are refused; the read shows only the caller\'s own registration');

 // 6. Concurrency: five tabs, five keys, one school.
 const eve=person('eve'),burst=await Promise.all(Array.from({length:5},()=>send('account/sign-up',{identity:eve,body:form({schoolName:'Eve Karate'})})));
 const wins=burst.filter(r=>r.status===200);assert.equal(wins.length,1,JSON.stringify(burst.map(r=>[r.status,r.body.code])));
 assert(burst.filter(r=>r.status!==200).every(r=>(r.status===409&&r.body.code==='SIGNUP_ALREADY_REGISTERED')||(r.status===503&&r.body.code==='SIGNUP_BUSY')));
 assert.equal((await q('SELECT count(*) n FROM hon.hon_os_school_registrations WHERE subject=$1',[eve.externalSubject]))[0].n,'1');
 assert.equal((await q('SELECT count(*) n FROM hon.users WHERE external_subject=$1',[eve.externalSubject]))[0].n,'1');
 for(let i=0;i<20;i++){const r=await send('account/sign-up',{identity:eve,body:form({schoolName:'Eve Karate'})});if(r.status===409){assert.equal(r.body.code,'SIGNUP_ALREADY_REGISTERED');break;}assert.equal(r.status,503);}
 pass('five concurrent sign-ups by one identity with different keys create exactly one user and school; the others get already-registered or a recoverable busy');

 // 7. Busy envelope.
 await blocker.query('BEGIN');
 try{await blocker.query('LOCK TABLE hon.principal_role_grants IN SHARE ROW EXCLUSIVE MODE');await denied(()=>send('account/sign-up',{identity:person('busy'),body:form()}),503,'SIGNUP_BUSY');}
 finally{await blocker.query('ROLLBACK');}
 pass('a held IAM lock gives an explicit recoverable busy with no partial writes');

 // 8. Identity conflicts: never merge by email; existing staff/HQ/family identities are not eligible.
 const twin={...person('twin'),email:dana.email};
 await denied(()=>send('account/sign-up',{identity:twin,body:form()}),409,'SIGNUP_REVIEW_REQUIRED');
 const human=async(identity,label)=>{const user=K(),principal=K();await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[user,identity.externalSubject,identity.email,label]);await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER',$3)",[principal,user,label]);return principal;};
 const hqPerson=person('hq'),hqP=await human(hqPerson,'Synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '1 day')",[hqP]);
 await denied(()=>send('account/sign-up',{identity:hqPerson,body:form()}),409,'SIGNUP_OWNER_NOT_ELIGIBLE');
 assert.equal(ok(await send('account/sign-up',{identity:hqPerson,method:'GET'})).eligibility,'HAS_OTHER_ACCESS');
 const staffPerson=person('staff'),staffP=await human(staffPerson,'Synthetic staff');
 const danaRole=(await q("SELECT role_id FROM hon.principal_role_grants WHERE id=$1",[row.owner_grant_id]))[0].role_id;
 await q('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp())',[reg.organizationId,reg.schoolId,staffP,danaRole]);
 await denied(()=>send('account/sign-up',{identity:staffPerson,body:form()}),409,'SIGNUP_OWNER_NOT_ELIGIBLE');
 const fam=(await q("INSERT INTO hon.families(organization_id,school_id,display_name) VALUES($1,$2,'Synthetic family') RETURNING id",[reg.organizationId,reg.schoolId]))[0].id;
 const parent=person('parent'),parentP=await human(parent,'Synthetic parent');
 await q("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$5)",[reg.organizationId,reg.schoolId,fam,parentP,row.owner_principal_id]);
 await denied(()=>send('account/sign-up',{identity:parent,body:form()}),409,'SIGNUP_OWNER_NOT_ELIGIBLE');
 const mismatch={...person('mismatch')};await human({...mismatch,email:'other-'+K()+'@example.invalid'},'Synthetic mismatch');
 await denied(()=>send('account/sign-up',{identity:mismatch,body:form()}),409,'SIGNUP_REVIEW_REQUIRED');
 // A clean pre-existing identity (signed in before, never granted anything) may register.
 const clean=person('clean');await human(clean,'Synthetic clean');
 const cleanReg=ok(await send('account/sign-up',{identity:clean,body:form({schoolName:'Clean Dojo'})})).registration;assert.equal(cleanReg.lifecycle,'REGISTERED');
 assert.equal((await q("SELECT count(*) n FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=$1",[clean.externalSubject]))[0].n,'1');
 pass('an email already held by another identity goes to review (never merged); HQ, staff and family identities and an email mismatch are refused; a clean existing identity registers without a second principal');

 // 9. Program closed mid-request (after the identity writes) aborts everything; evidence is immutable.
 const late=person('late');
 await q("CREATE FUNCTION public.signup_close_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE hon.hon_os_signup_program SET status='CLOSED'; RETURN NEW; END $$");
 await q('CREATE TRIGGER signup_close_barrier AFTER INSERT ON hon.hon_os_school_registrations FOR EACH ROW EXECUTE FUNCTION public.signup_close_barrier()');
 try{await denied(()=>send('account/sign-up',{identity:late,body:form()}),409,'SIGNUP_CLOSED');}
 finally{await q('DROP TRIGGER signup_close_barrier ON hon.hon_os_school_registrations');await q('DROP FUNCTION public.signup_close_barrier()');}
 assert.equal((await q('SELECT status FROM hon.hon_os_signup_program'))[0].status,'TEST_MODE');
 for(const sql of ["UPDATE hon.hon_os_school_registrations SET verified_email='x@example.invalid'","DELETE FROM hon.hon_os_school_registrations","UPDATE hon.hon_os_signup_terms_versions SET title='x'","DELETE FROM hon.hon_os_signup_terms_versions"])
  await assert.rejects(()=>q(sql),e=>/ACCOUNT_EVIDENCE_IMMUTABLE/.test(e.message));
 await assert.rejects(()=>q("INSERT INTO hon.hon_os_signup_terms_versions(version,status,title,document_digest,recorded_at) VALUES(3,'OWNER_APPROVED','x',$1,clock_timestamp())",['a'.repeat(64)]),e=>e.code==='23514');
 pass('closing the program between the writes and commit aborts the whole sign-up; registrations and terms are append-only; no approved-terms status exists yet');

 // 10 (0273, limits versioned in 0274). Abuse protection held in the database: disposable email domains and global admission limits.
 for(const t of ['hon_os_admission_limit_versions','hon_os_admission_refusals','hon_os_signup_blocked_email_domains']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced,t);
  for(const p of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 assert.equal((await q("SELECT to_regclass('hon.hon_os_admission_limits') t"))[0].t,null);
 await assert.rejects(()=>q('DELETE FROM hon.hon_os_admission_limit_versions'),e=>e.code==='42501'||/IMMUTABLE/.test(e.message));
 await assert.rejects(()=>q('UPDATE hon.hon_os_admission_limit_versions SET signups_per_hour=1'),e=>e.code==='42501'||/IMMUTABLE/.test(e.message));
 const first=(await q('SELECT * FROM hon.hon_os_admission_limit_versions ORDER BY version'))[0];
 assert.deepEqual([first.version,first.signups_per_hour,first.signups_per_day,first.trials_per_hour,first.trials_per_day,first.actor_principal_id],[1,30,200,30,200,null]);
 const latest=async()=>(await q('SELECT * FROM hon.hon_os_admission_limit_versions ORDER BY version DESC LIMIT 1'))[0];
 const original=await latest();
 const at=(label,domain)=>({...person(label),email:label+'-'+K()+'@'+domain});
 for(const domain of ['mailinator.com','inbox.yopmail.com','MAILDROP.CC'])await denied(()=>send('account/sign-up',{identity:at('throwaway',domain),body:form()}),409,'SIGNUP_EMAIL_DOMAIN_NOT_ACCEPTED');
 assert.equal((await q("SELECT hon.hon_os_email_domain_blocked('owner@notmailinator.com') a,hon.hon_os_email_domain_blocked('owner@mailinator.com.example.invalid') b"))[0].a,false);
 // The migration owner may append an owner-recorded version (no actor); a version must be exactly the next one.
 const setLimits=async(hour,day)=>{const v=(await latest()).version+1;await q('INSERT INTO hon.hon_os_admission_limit_versions(version,signups_per_hour,signups_per_day,trials_per_hour,trials_per_day) VALUES($1,$2,$3,$4,$5)',[v,hour,day,original.trials_per_hour,original.trials_per_day]);};
 await assert.rejects(()=>q('INSERT INTO hon.hon_os_admission_limit_versions(version,signups_per_hour,signups_per_day,trials_per_hour,trials_per_day) VALUES($1,5,5,5,5)',[original.version+5]),e=>e.code==='40001');
 const recent=async span=>Number((await q(`SELECT count(*) n FROM hon.hon_os_school_registrations WHERE registered_at>clock_timestamp()-interval '${span}'`))[0].n);
 const refused=async()=>Number((await q("SELECT coalesce(sum(refused_count),0) n FROM hon.hon_os_admission_refusals WHERE kind='SIGNUP'"))[0].n);
 const refusedBefore=await refused();let capRefusals=0;
 try{
  await setLimits(Math.max(1,await recent('1 hour')),Math.max(1,await recent('1 day')));
  if(await recent('1 hour')>0){await denied(()=>send('account/sign-up',{identity:person('over-hour'),body:form()}),409,'SIGNUP_CAPACITY_REACHED');capRefusals++;}
  await setLimits(1,Math.max(1,await recent('1 day')));
  if(await recent('1 day')>0){await denied(()=>send('account/sign-up',{identity:person('over-day'),body:form()}),409,'SIGNUP_CAPACITY_REACHED');capRefusals++;}
  // 0274: every capacity refusal is counted for HQ, in its own transaction, under the hour it happened.
  assert(capRefusals>0);assert.equal(await refused(),refusedBefore+capRefusals);
  // A record while the limit is NOT reached is ignored, so a runtime caller cannot invent a cap hit.
  await setLimits(10000,100000);
  assert.equal((await restricted.query("SELECT hon.record_hon_os_admission_refusal('SIGNUP') r")).rows[0].r,false);assert.equal(await refused(),refusedBefore+capRefusals);
  await assert.rejects(()=>restricted.query("SELECT hon.record_hon_os_admission_refusal('OTHER')"),e=>e.code==='22023');
  // One seat left, five different people at once: exactly one school is created.
  const n=await recent('1 hour');await setLimits(n+1,Math.max(n+1,await recent('1 day')+1));
  const rush=await Promise.all(Array.from({length:5},(_,i)=>send('account/sign-up',{identity:person('rush'+i),body:form()})));
  assert.equal(rush.filter(r=>r.status===200).length,1,JSON.stringify(rush.map(r=>[r.status,r.body.code])));
  assert(rush.filter(r=>r.status!==200).every(r=>(r.status===409&&r.body.code==='SIGNUP_CAPACITY_REACHED')||(r.status===503&&r.body.code==='SIGNUP_BUSY')));
  assert.equal(await recent('1 hour'),n+1);
 }finally{await setLimits(original.signups_per_hour,original.signups_per_day);}
 pass('0273/0274: a verified email at a listed throwaway domain (or its subdomain) is refused with no effects; the latest limit version refuses new schools hourly and daily with no effects and each refusal is counted for HQ; a record is ignored while the limit is not reached; five people racing for the last seat create exactly one school; versions are append-only and in order');

 assert.deepEqual(await snapshot(),baseline);
 pass('no billing, access-state, credit, AI, CRM, trial or outbox table changed: identity, school, OWNER grant and registration only');

 // 12 (0274). HQ sees the limits, usage and cap hits; only the HQ owner changes the limits, idempotently, with history and audit.
 const hqSend=(identity,{body,key,method='POST'}={})=>send('hq/admission'+(method==='POST'?'/limits':''),{identity,body,key,method,headers:method==='POST'?{'x-hon-human-command':ADMISSION_LIMITS_COMMAND}:{}});
 // Refusals are counted per UTC hour, so a run that crosses an hour mark splits them across two buckets. Add one
 // earlier synthetic bucket so the view is always checked with several hours, then compare bucket by bucket.
 await q("INSERT INTO hon.hon_os_admission_refusals(kind,hour_start,refused_count,first_refused_at,last_refused_at) SELECT 'SIGNUP',h,3,h,h+interval '5 minutes' FROM (SELECT date_trunc('hour',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'-interval '3 hours' h) x ON CONFLICT DO NOTHING");
 const view=ok(await hqSend(hqPerson,{method:'GET'}));
 const buckets=(await q("SELECT hour_start,refused_count FROM hon.hon_os_admission_refusals WHERE kind='SIGNUP' AND hour_start>$1::timestamptz-interval '7 days' ORDER BY hour_start DESC",[view.asOf])).map(r=>[r.hour_start.toISOString(),r.refused_count]);
 const current=await latest();
 assert.equal(view.limits.version,current.version);assert.equal(view.limits.signupsPerHour,current.signups_per_hour);assert.equal(view.limits.recordedBy,'MIGRATION_OWNER');
 assert.equal(view.history[0].version,current.version);assert(view.history.length>=2&&view.history.length<=50);assert.equal(view.programs.signup,'TEST_MODE');
 assert.equal(view.usage.signups.lastHour,await recent('1 hour'));assert.equal(view.usage.signups.full,view.usage.signups.lastHour>=current.signups_per_hour||view.usage.signups.lastDay>=current.signups_per_day);
 // HQ sees every recorded SIGNUP hour exactly (this run's cap hits are in them: group 11 proved the table grew by capRefusals).
 assert.deepEqual(view.refusals.filter(r=>r.kind==='SIGNUP').map(r=>[r.hourStart,r.count]),buckets);assert(buckets.length>=2);
 assert(buckets.reduce((n,[,c])=>n+c,0)>=capRefusals);assert(view.blockedEmailDomains>=36);
 const operatorPerson=person('hq-billing'),operatorP=await human(operatorPerson,'Synthetic HQ billing');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OPERATOR',ARRAY['hq.billing.manage'],clock_timestamp()-interval '1 day')",[operatorP]);
 assert.equal(ok(await hqSend(operatorPerson,{method:'GET'})).limits.version,current.version);
 for(const who of [person('nobody'),staffPerson,dana])assert.equal((await hqSend(who,{method:'GET'})).status,403);
 const change={expectedVersion:current.version,signupsPerHour:12,signupsPerDay:150,trialsPerHour:8,trialsPerDay:90,reason:'Synthetic: tighten limits before opening'};
 const audits=async()=>Number((await q("SELECT count(*) n FROM hon.saas_audit WHERE action_code='saas.admission.limits_set'"))[0].n);
 const auditBefore=await audits();
 for(const who of [operatorPerson,staffPerson,person('nobody')]){const r=await hqSend(who,{body:change,key:K()});assert.equal(r.status,403,JSON.stringify(r.body));}
 for(const bad of [{...change,signupsPerHour:151},{...change,trialsPerDay:0},{...change,reason:'short'},{...change,extra:1},{...change,signupsPerHour:'12'}])assert.equal((await hqSend(hqPerson,{body:bad,key:K()})).status,400);
 assert.equal((await hqSend(hqPerson,{body:{...change,expectedVersion:current.version-1},key:K()})).status,409);
 const noHeader=await send('hq/admission/limits',{identity:hqPerson,body:change,key:K()});assert.equal(noHeader.status,403);
 assert.equal((await latest()).version,current.version);assert.equal(await audits(),auditBefore);
 const changeKey=K(),made=ok(await hqSend(hqPerson,{body:change,key:changeKey}));
 assert.equal(made.replayed,false);assert.equal(made.limits.version,current.version+1);assert.equal(made.limits.recordedBy,'HQ_OWNER');assert.equal(made.limits.actorPrincipalId,hqP);
 assert.deepEqual([made.limits.signupsPerHour,made.limits.signupsPerDay,made.limits.trialsPerHour,made.limits.trialsPerDay,made.limits.reason],[12,150,8,90,change.reason]);
 const again=ok(await hqSend(hqPerson,{body:change,key:changeKey}));assert.equal(again.replayed,true);assert.equal(again.limits.versionId,made.limits.versionId);
 assert.equal((await hqSend(hqPerson,{body:{...change,signupsPerHour:13},key:changeKey})).status,409);
 assert.equal(await audits(),auditBefore+1);
 assert.equal((await q("SELECT count(*) n FROM hon.saas_outbox o JOIN hon.saas_audit a ON a.id=o.audit_id WHERE a.action_code='saas.admission.limits_set' AND o.event_type='saas.admission.limits_set' AND a.entity_id=$1",[made.limits.versionId]))[0].n,'1');
 const changed=ok(await hqSend(hqPerson,{method:'GET'}));assert.equal(changed.limits.versionId,made.limits.versionId);assert.equal(changed.history[1].version,current.version);
 assert.equal(changed.usage.signups.perHour,12);assert.equal(changed.usage.trials.perDay,90);
 // The admission trigger uses the new version at once.
 const used=await recent('1 hour');
 if(used>=12)await denied(()=>send('account/sign-up',{identity:person('after-change'),body:form()}),409,'SIGNUP_CAPACITY_REACHED');
 // An HQ version can only come through the command: a direct insert naming an actor is refused without its request.
 await assert.rejects(()=>q('INSERT INTO hon.hon_os_admission_limit_versions(version,signups_per_hour,signups_per_day,trials_per_hour,trials_per_day,reason,actor_principal_id,idempotency_key) VALUES($1,1,1,1,1,$2,$3,$4)',[made.limits.version+1,'Synthetic forged change',hqP,K()]),e=>/ADMISSION_EVIDENCE_REQUIRED|foreign key/.test(e.message));
 // Runtime executes exactly the three entry points.
 for(const [f,want] of [['set_hon_os_admission_limits(text,jsonb,uuid,uuid,uuid)',true],['record_hon_os_admission_refusal(text)',true],['read_hon_os_admission_status(text)',true],['hon_os_admission_usage(text,timestamp with time zone)',false],['hon_os_admission_limits_now()',false],['guard_hon_os_admission_limit_insert()',false]])
  assert.equal((await q('SELECT has_function_privilege($1,$2,$3) ok',[runtime.username,'hon.'+f,'EXECUTE']))[0].ok,want,f);
 await setLimits(original.signups_per_hour,original.signups_per_day);
 pass('0274: HQ owner and HQ billing reader see limits, history, usage and cap hits; only the HQ owner changes limits (expected version, idempotent replay, key reuse refused, audit + outbox); the new version applies at once; no forged HQ version; runtime executes three entry points');
 // 13 (0710). The HQ owner opens and closes sign-up and trials; OPEN admits like TEST_MODE; terms v2 FINAL is required.
 const prog=(identity,{body,key=K(),method='POST',command=SIGNUP_PROGRAMS_COMMAND}={})=>send('hq/signup-programs',{identity,body,key,method,headers:method==='POST'?{'x-hon-human-command':command}:{}});
 const termsRows=await q('SELECT id,version,status,document_digest FROM hon.hon_os_signup_terms_versions ORDER BY version');
 assert.deepEqual(termsRows.map(t=>[t.version,t.status]),[[1,'TEST_ONLY_DRAFT'],[2,'FINAL']]);
 assert.equal(termsRows[1].document_digest,'1e7ad73b54f574e333071c37883f2eb313a05e4063860547df7575615a303fdb');assert.equal(terms,termsRows[1].id);
 // A draft added above FINAL never becomes the current terms.
 await admin.query('BEGIN');try{await q("INSERT INTO hon.hon_os_signup_terms_versions(version,status,title,document_digest,recorded_at) VALUES(3,'TEST_ONLY_DRAFT','Synthetic later draft',$1,clock_timestamp())",['c'.repeat(64)]);
  assert.equal((await q('SELECT (hon.hon_os_signup_terms_current()).version v'))[0].v,2);}finally{await admin.query('ROLLBACK');}
 const pv=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.hon_os_program_versions']))[0];assert(pv.rls&&pv.forced);
 for(const p of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.hon_os_program_versions',p]))[0].ok,false,p);
 for(const [f,want] of [['set_hon_os_programs(text,jsonb,uuid,uuid,uuid)',true],['read_hon_os_programs(text)',true],['hon_os_programs_now()',false],['hon_os_signup_status()',false],['hon_os_trial_status()',false],['guard_hon_os_program_version_insert()',false],['verify_hon_os_program_version_evidence()',false],['stamp_hon_os_signup_program_status()',false],['guard_hon_os_signup_current_terms()',false]])
  assert.equal((await q('SELECT has_function_privilege($1,$2,$3) ok',[runtime.username,'hon.'+f,'EXECUTE']))[0].ok,want,f);
 const first13=ok(await prog(hqPerson,{method:'GET'}));
 assert.equal(first13.programs.version,1);assert.equal(first13.programs.recordedBy,'MIGRATION_OWNER');assert.deepEqual([first13.programs.signup,first13.programs.trial],['CLOSED','CLOSED']);
 assert.deepEqual(first13.current,{signup:'TEST_MODE',trial:'CLOSED'});assert.equal(first13.terms.status,'FINAL');assert.equal(first13.terms.version,2);
 assert.equal(ok(await prog(operatorPerson,{method:'GET'})).programs.version,1);
 for(const who of [person('nobody'),staffPerson,dana])assert.equal((await prog(who,{method:'GET'})).status,403);
 const open13={expectedVersion:1,signup:'OPEN',trial:'OPEN',reason:'Synthetic: open sign-up and trials'};
 const progAudits=async()=>Number((await q("SELECT count(*) n FROM hon.saas_audit WHERE action_code='saas.signup_programs.set'"))[0].n);
 const pa=await progAudits();
 for(const who of [operatorPerson,staffPerson,person('nobody')])assert.equal((await prog(who,{body:open13})).status,403);
 for(const bad of [{...open13,signup:'TEST_MODE'},{...open13,trial:'LIVE'},{...open13,reason:'short'},{...open13,extra:1},{...open13,expectedVersion:'1'}])assert.equal((await prog(hqPerson,{body:bad})).status,400,JSON.stringify(bad));
 assert.equal((await prog(hqPerson,{body:open13,command:ADMISSION_LIMITS_COMMAND})).status,403);
 assert.equal((await send('hq/signup-programs',{identity:hqPerson,body:open13})).status,403);
 assert.equal((await prog(hqPerson,{body:{...open13,expectedVersion:2}})).status,409);
 // TEST_MODE can never be set at runtime, even calling the function directly as the HQ owner.
 await assert.rejects(()=>restricted.query('SELECT hon.set_hon_os_programs($1,$2::jsonb,$3,$4,$5)',[hqPerson.externalSubject,JSON.stringify({...open13,signup:'TEST_MODE'}),K(),K(),K()]),e=>e.code==='22023');
 assert.equal(await progAudits(),pa);assert.equal((await q('SELECT count(*) n FROM hon.hon_os_program_versions'))[0].n,'1');
 const k13=K(),opened=ok(await prog(hqPerson,{body:open13,key:k13}));
 assert.equal(opened.replayed,false);assert.equal(opened.programs.version,2);assert.equal(opened.programs.recordedBy,'HQ_OWNER');assert.equal(opened.programs.actorPrincipalId,hqP);
 assert.deepEqual([opened.programs.signup,opened.programs.trial,opened.programs.reason],['OPEN','OPEN',open13.reason]);
 const again13=ok(await prog(hqPerson,{body:open13,key:k13}));assert.equal(again13.replayed,true);assert.equal(again13.programs.versionId,opened.programs.versionId);
 assert.equal((await prog(hqPerson,{body:{...open13,reason:'Synthetic: a different reason'},key:k13})).status,409);
 assert.equal(await progAudits(),pa+1);
 assert.equal((await q("SELECT count(*) n FROM hon.saas_outbox o JOIN hon.saas_audit a ON a.id=o.audit_id WHERE a.action_code='saas.signup_programs.set' AND o.event_type='saas.signup_programs.set' AND a.entity_type='SIGNUP_PROGRAMS' AND a.entity_id=$1",[opened.programs.versionId]))[0].n,'1');
 assert.deepEqual((await q('SELECT (SELECT status FROM hon.hon_os_signup_program) s,(SELECT status FROM hon.hon_os_trial_program) t'))[0],{s:'OPEN',t:'OPEN'});
 const view13=ok(await prog(hqPerson,{method:'GET'}));assert.deepEqual(view13.current,{signup:'OPEN',trial:'OPEN'});assert.deepEqual(view13.history.map(h=>h.version),[2,1]);
 assert.deepEqual(ok(await hqSend(hqPerson,{method:'GET'})).programs,{signup:'OPEN',trial:'OPEN'});
 // OPEN admits a sign-up; the registration records OPEN and terms v2; v1 is refused.
 const olive=person('olive');
 const oread=ok(await send('account/sign-up',{identity:olive,method:'GET'}));assert.equal(oread.signupStatus,'OPEN');assert.equal(oread.terms.termsVersionId,termsRows[1].id);
 await denied(()=>send('account/sign-up',{identity:olive,body:form({termsVersionId:termsRows[0].id,schoolName:'Olive Taekwondo'})}),409,'SIGNUP_TERMS_CHANGED');
 const oreg=ok(await send('account/sign-up',{identity:olive,body:form({schoolName:'Olive Taekwondo'})})).registration;
 const orow=(await q('SELECT program_status,terms_version_id FROM hon.hon_os_school_registrations WHERE id=$1',[oreg.registrationId]))[0];
 assert.deepEqual(orow,{program_status:'OPEN',terms_version_id:termsRows[1].id});
 // A writer cannot stamp its own program status: the trigger takes it from the program row.
 assert.equal((await q('SELECT hon.hon_os_signup_open() s,hon.hon_os_trial_open() t'))[0].s,true);assert.equal((await q('SELECT hon.hon_os_trial_open() t'))[0].t,true);
 assert.equal((await restricted.query('SELECT hon.read_hon_os_trial($1) d',[olive.externalSubject])).rows[0].d.trialStatus,'OPEN');
 // The 0274 caps still apply while OPEN.
 const used13=await recent('1 hour');await setLimits(Math.max(1,used13),Math.max(1,await recent('1 day')));
 try{await denied(()=>send('account/sign-up',{identity:person('open-cap'),body:form()}),409,'SIGNUP_CAPACITY_REACHED');}finally{await setLimits(original.signups_per_hour,original.signups_per_day);}
 // Forged history is refused; history is append-only.
 await assert.rejects(()=>q("INSERT INTO hon.hon_os_program_versions(version,signup_status,trial_status,reason,actor_principal_id,idempotency_key) VALUES(3,'OPEN','OPEN','Synthetic forged change',$1,$2)",[hqP,K()]),e=>/PROGRAM_EVIDENCE_REQUIRED/.test(e.message));
 await assert.rejects(()=>q("INSERT INTO hon.hon_os_program_versions(version,signup_status,trial_status,reason) VALUES(9,'OPEN','OPEN','Synthetic skipped version')"),e=>e.code==='40001');
 await assert.rejects(()=>q("UPDATE hon.hon_os_program_versions SET reason='Synthetic rewrite here'"),e=>e.code==='42501'||/IMMUTABLE|EVIDENCE/.test(e.message));
 await assert.rejects(()=>q('DELETE FROM hon.hon_os_program_versions'),e=>e.code==='42501'||/IMMUTABLE|EVIDENCE/.test(e.message));
 // HQ closes both again: sign-up is refused at once.
 const shut=ok(await prog(hqPerson,{body:{expectedVersion:2,signup:'CLOSED',trial:'CLOSED',reason:'Synthetic: close sign-up and trials'}}));
 assert.equal(shut.programs.version,3);assert.equal(ok(await send('account/sign-up',{identity:person('late'),method:'GET'})).signupStatus,'CLOSED');
 await denied(()=>send('account/sign-up',{identity:person('late2'),body:form()}),409,'SIGNUP_CLOSED');
 assert.equal((await restricted.query('SELECT hon.read_hon_os_trial($1) d',[olive.externalSubject])).rows[0].d.trialStatus,'CLOSED');
 pass('0710: HQ owner alone opens/closes sign-up and trials (CLOSED or OPEN only, never TEST_MODE; expected version, idempotent replay, key reuse refused, own command header, audit + outbox, append-only history, no forged version); OPEN admits sign-up recording OPEN and terms v2 FINAL, v1 refused, a later draft never current; 0274 caps still apply; closing refuses at once; runtime executes two new entry points');
 console.log(`PASS: HON OS public sign-up (${groups} groups)`);
}finally{await setProgram('CLOSED').catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end(),blocker.end()]);}
