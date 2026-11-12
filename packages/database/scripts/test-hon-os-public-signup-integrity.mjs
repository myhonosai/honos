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
const {SIGNUP_CONFIRMATION,SIGNUP_HUMAN_COMMAND}=require('@hon/contracts');
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
const form=(extra={})=>({ownerName:'Synthetic Owner',schoolName:'Synthetic Dragon Martial Arts',legalName:'Synthetic Dragon LLC',timezone:'America/Los_Angeles',termsVersionId:terms,confirmation:SIGNUP_CONFIRMATION,...extra});

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

 const module=await Test.createTestingModule({controllers:[HonOsSignupController],providers:[HonOsSignupService,HonOsSignupHumanGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 const excluded=new Set([...tables,'hon_os_signup_program','hq_operator_grants','families','family_access_grants']);
 const others=(await q("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).map(r=>r.tablename).filter(t=>!excluded.has(t));
 const snapshot=async()=>{const out={};for(const t of others){assert.match(t,/^[a-z_0-9]+$/);out[t]=hash(JSON.stringify(await q('SELECT to_jsonb(t)::text r FROM hon.'+t+' t ORDER BY 1')));}return out;};const baseline=await snapshot();

 // 2. Closed program: read says CLOSED, sign-up refused with zero effects.
 const dana=person('dana');
 const closed=ok(await send('account/sign-up',{identity:dana,method:'GET'}));
 assert.deepEqual({...closed,terms:undefined},{signupStatus:'CLOSED',terms:undefined,eligibility:'ELIGIBLE',registration:null});assert.equal(closed.terms.termsVersionId,terms);assert.equal(closed.terms.status,'TEST_ONLY_DRAFT');
 await denied(()=>send('account/sign-up',{identity:dana,body:form()}),409,'SIGNUP_CLOSED');
 await setProgram('TEST_MODE');
 pass('CLOSED by default: the read reports it and sign-up is refused with no identity or school written');

 // 3. Input and identity refusals, all with zero effects.
 await denied(()=>send('account/sign-up',{identity:person('unverified',false),body:form()}),403,'VERIFIED_EMAIL_REQUIRED');
 await denied(()=>send('account/sign-up',{body:form()}),401);
 for(const patch of [{email:'evil@example.invalid'},{subject:'oidc:other'},{organizationId:K()},{role:'OWNER'},{plan:'COMPLETE'}])await denied(()=>send('account/sign-up',{identity:dana,body:form(patch)}),400);
 for(const patch of [{confirmation:'YES'},{timezone:'Mars/Olympus'},{timezone:'posix/UTC'},{ownerName:''},{schoolName:'x'.repeat(121)},{legalName:'a\tb'}])await denied(()=>send('account/sign-up',{identity:dana,body:form(patch)}),400);
 await denied(()=>send('account/sign-up',{identity:dana,body:form(),headers:{'x-hon-human-command':'school-staff-account'}}),403);
 await denied(()=>send('account/sign-up',{identity:dana,body:form(),headers:{origin:'https://evil.invalid'}}),403);
 await assert.rejects(()=>restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4)',['manus:'+K(),'x@example.invalid',form(),K()]),e=>e.code==='22023');
 await assert.rejects(()=>restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4)',[dana.externalSubject,'Mixed@Example.invalid',form(),K()]),e=>e.code==='22023');
 await denied(()=>send('account/sign-up',{identity:dana,body:form({termsVersionId:K()})}),409,'SIGNUP_TERMS_CHANGED');
 pass('unverified email, no session, forged body authority, bad names/time zone/confirmation, wrong command or origin, non-OIDC subject and stale terms are refused atomically');

 // 4. Happy path: exactly one organization, school, OWNER role and grant; entitlement SUSPENDED; no access, billing or AI.
 const key=K(),before=await counts();
 const reg=ok(await send('account/sign-up',{identity:dana,body:form(),key}));
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
 assert.deepEqual(ok(await send('account/sign-up',{identity:dana,body:form(),key})),reg);
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
 const cleanReg=ok(await send('account/sign-up',{identity:clean,body:form({schoolName:'Clean Dojo'})}));assert.equal(cleanReg.lifecycle,'REGISTERED');
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
 await assert.rejects(()=>q("INSERT INTO hon.hon_os_signup_terms_versions(version,status,title,document_digest,recorded_at) VALUES(2,'OWNER_APPROVED','x',$1,clock_timestamp())",['a'.repeat(64)]),e=>e.code==='23514');
 pass('closing the program between the writes and commit aborts the whole sign-up; registrations and terms are append-only; no approved-terms status exists yet');

 // 10 (0273). Abuse protection held in the database: disposable email domains and global admission limits.
 for(const t of ['hon_os_admission_limits','hon_os_signup_blocked_email_domains']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced,t);
  for(const p of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 await assert.rejects(()=>q('DELETE FROM hon.hon_os_admission_limits'),e=>/ADMISSION_LIMITS_IMMUTABLE/.test(e.message));
 await assert.rejects(()=>q('UPDATE hon.hon_os_admission_limits SET signups_per_hour=0'),e=>e.code==='23514');
 const limits=(await q('SELECT *,recorded_at::text rec FROM hon.hon_os_admission_limits'))[0];
 assert.deepEqual([limits.signups_per_hour,limits.signups_per_day,limits.trials_per_hour,limits.trials_per_day],[30,200,30,200]);
 const at=(label,domain)=>({...person(label),email:label+'-'+K()+'@'+domain});
 for(const domain of ['mailinator.com','inbox.yopmail.com','MAILDROP.CC'])await denied(()=>send('account/sign-up',{identity:at('throwaway',domain),body:form()}),409,'SIGNUP_EMAIL_DOMAIN_NOT_ACCEPTED');
 assert.equal((await q("SELECT hon.hon_os_email_domain_blocked('owner@notmailinator.com') a,hon.hon_os_email_domain_blocked('owner@mailinator.com.example.invalid') b"))[0].a,false);
 const setLimits=(hour,day)=>q('UPDATE hon.hon_os_admission_limits SET signups_per_hour=$1,signups_per_day=$2',[hour,day]);
 const recent=async span=>Number((await q(`SELECT count(*) n FROM hon.hon_os_school_registrations WHERE registered_at>clock_timestamp()-interval '${span}'`))[0].n);
 try{
  await setLimits(Math.max(1,await recent('1 hour')),Math.max(1,await recent('1 day')));
  if(await recent('1 hour')>0)await denied(()=>send('account/sign-up',{identity:person('over-hour'),body:form()}),409,'SIGNUP_CAPACITY_REACHED');
  await setLimits(1,Math.max(1,await recent('1 day')));
  if(await recent('1 day')>0)await denied(()=>send('account/sign-up',{identity:person('over-day'),body:form()}),409,'SIGNUP_CAPACITY_REACHED');
  // One seat left, five different people at once: exactly one school is created.
  const n=await recent('1 hour');await setLimits(n+1,Math.max(n+1,await recent('1 day')+1));
  const rush=await Promise.all(Array.from({length:5},(_,i)=>send('account/sign-up',{identity:person('rush'+i),body:form()})));
  assert.equal(rush.filter(r=>r.status===200).length,1,JSON.stringify(rush.map(r=>[r.status,r.body.code])));
  assert(rush.filter(r=>r.status!==200).every(r=>(r.status===409&&r.body.code==='SIGNUP_CAPACITY_REACHED')||(r.status===503&&r.body.code==='SIGNUP_BUSY')));
  assert.equal(await recent('1 hour'),n+1);
 }finally{await q('UPDATE hon.hon_os_admission_limits SET signups_per_hour=$1,signups_per_day=$2,recorded_at=$3::timestamptz',[limits.signups_per_hour,limits.signups_per_day,limits.rec]);}
 pass('0273: a verified email at a listed throwaway domain (or its subdomain) is refused with no effects; hourly and daily admission limits refuse new schools with no effects; five people racing for the last seat create exactly one school; limits are migration-owner only');

 assert.deepEqual(await snapshot(),baseline);
 pass('no billing, access-state, credit, AI, CRM, trial or outbox table changed: identity, school, OWNER grant and registration only');
 console.log(`PASS: HON OS public sign-up (${groups} groups)`);
}finally{await setProgram('CLOSED').catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end(),blocker.end()]);}
