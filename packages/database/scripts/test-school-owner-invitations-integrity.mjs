/** Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL. No provider. */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
import {verifySchoolAccountSecurity} from './school-account-security.mjs';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key));
// createRequire resolves relative specifiers from apps/api/package.json, NOT this script.
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {SchoolOwnerInvitationService}=require('./dist/accounts/school-owner-invitation.service.js');
const {SchoolOwnerInvitationController,SchoolAccountHumanGuard}=require('./dist/accounts/school-owner-invitation.controller.js');
const {OWNER_INVITATION_CONFIRMATION}=require('@hon/contracts');
const {HqController}=require('./dist/hq/hq.controller.js');
const {HqOverviewService}=require('./dist/hq/hq-overview.service.js');
const {HqSchoolDirectoryService}=require('./dist/hq/hq-school-directory.service.js');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),blocker=new pg.Client({connectionString:owner.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'p0-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const actor={hq:{subject:'p0-hq-'+K(),principal:K(),user:K()},operator:{subject:'p0-op-'+K(),principal:K(),user:K()},expired:{subject:'p0-expired-'+K(),principal:K(),user:K()},waiter:{subject:'p0-wait-'+K(),principal:K(),user:K()}};
const identities={a:{externalSubject:'oidc:p0:'+K(),email:'a-'+K()+'@example.invalid',emailVerified:true},b:{externalSubject:'oidc:p0:'+K(),email:'b-'+K()+'@example.invalid',emailVerified:true}};
const pass=name=>console.log('PASS P0-1 '+(++groups)+' '+name);
const hash=x=>createHash('sha256').update(x).digest('hex');
async function send(path,{who='hq',body,key=K(),method='POST',identity,expired=false,headers={}}={}){
 const person=identity??(actor[who]?{externalSubject:actor[who].subject}:identities[who]);
 const cookie=person?HON_SESSION_COOKIE+'='+issueSession(person,session,Math.floor(Date.now()/1000)-(expired?43201:0)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':'school-owner-account','idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const invite=(o,email,extra={})=>{const token=randomBytes(32).toString('base64url');return {schoolId:o.schoolId,email,ttlHours:24,token,...extra};};
const accept=(i,token)=>({invitationId:i.invitationId,token,confirmation:OWNER_INVITATION_CONFIRMATION});
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const receipt=r=>{assert.equal(r.status,200,JSON.stringify(r));return r.body.data;};
const counts=async()=>Object.fromEntries(await Promise.all(['users','principals','principal_role_grants','school_owner_invitations','school_account_requests','school_account_events'].map(async t=>[t,(await q('SELECT count(*) n FROM hon.'+t))[0].n])));
async function denied(work,status){const before=await counts();const r=await work();assert.equal(r.status,status,JSON.stringify(r));assert.deepEqual(await counts(),before);assert.equal(r.headers['cache-control'],'private, no-store');assert(!JSON.stringify(r.body).match(/tokenHash|external_subject|SQLSTATE|SELECT /));return r;}
async function waitBehindInvitationRow(pid,blockerPid){
 for(let n=0;n<250;n++){
  // pg_stat_activity wait details are masked across roles; pg_blocking_pids exposes the
  // actual blocking edge without granting fixture owners pg_read_all_stats.
  const row=(await q("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='hon.users'::regclass AND mode='ShareRowExclusiveLock' AND granted) AS authority,$2::integer=ANY(pg_blocking_pids($1::integer)) AS waiting",[pid,blockerPid]))[0];
  if(row.authority&&row.waiting)return;
  await new Promise(done=>setTimeout(done,20));
 }
 throw Error('Consequential command did not reach the protected row-wait rendezvous');
}
try{
 await Promise.all([admin.connect(),restricted.connect(),blocker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 await verifySchoolAccountSecurity(admin,runtime.username);pass('forced deny-all RLS, exact runtime function privileges, no table/column or public helper bypass');
 for(const [kind,a]of Object.entries(actor)){
  await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'P0 synthetic HQ')",[a.user,a.subject,a.user+'@example.invalid']);
  await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','P0 synthetic HQ')",[a.principal,a.user]);
  await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days',CASE WHEN $3 THEN clock_timestamp()-interval '1 day' ELSE NULL END)",[a.principal,kind==='operator'?'HON_HQ_OPERATOR':'HON_HQ_OWNER',kind==='expired']);
 }
 const provision=async()=>{const id=K();return (await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'P0 synthetic','P0 synthetic','P0 school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[actor.hq.subject,'p0-'+id,K(),K()]))[0];};
 const orgA=await provision(),orgB=await provision();
 const bootstrapGrants=()=>q('SELECT to_jsonb(g) value FROM hon.principal_role_grants g WHERE principal_id=$1 AND school_id=ANY($2::uuid[]) ORDER BY id',[actor.hq.principal,[orgA.schoolId,orgB.schoolId]]);
 const originalBootstrapGrants=await bootstrapGrants();assert.equal(originalBootstrapGrants.length,2);
 const excluded=['users','principals','principal_role_grants','school_owner_invitations','school_account_requests','school_account_events'];
 const tables=(await q("SELECT tablename FROM pg_tables WHERE schemaname='hon' AND NOT(tablename=ANY($1)) ORDER BY tablename",[excluded])).map(r=>r.tablename);
 const snapshot=async()=>{const out={};for(const t of tables){assert.match(t,/^[a-z_]+$/);out[t]=hash(JSON.stringify(await q('SELECT to_jsonb(t)::text r FROM hon.'+t+' t ORDER BY 1')));}return out;};const baseline=await snapshot();
 const module=await Test.createTestingModule({controllers:[SchoolOwnerInvitationController,HqController],providers:[SchoolOwnerInvitationService,SchoolAccountHumanGuard,HonIdentityService,HqOverviewService,HqSchoolDirectoryService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 const productionDirectory=receipt(await send('hq/schools',{method:'GET'})).directory;
 for(const emitVerifiedEmail of [false,true]){
  const cookie=HON_SESSION_COOKIE+'='+issueSession({externalSubject:actor.hq.subject,email:'hq-synthetic@example.invalid',emailVerified:true},{...session,emitVerifiedEmail});
  const directory=receipt(await send('hq/schools',{method:'GET',headers:{cookie}})).directory;
  assert(directory.schools.some(s=>s.schoolId===orgA.schoolId));
 }
 pass('actual identity guard and HQ resolver accept legacy/new session shapes while issuer rollout is separate from reader compatibility');
 const selected=productionDirectory.schools.find(s=>s.schoolId===orgA.schoolId);assert(selected);
 assert.deepEqual(Object.keys(selected).sort(),['createdAt','entitlementTier','organizationDisplayName','organizationOperationalStatus','schoolDisplayName','schoolId','schoolOperationalStatus']);
 assert(!Object.hasOwn(selected,'organizationId'));assert(!Object.hasOwn(selected,'invitationId'));
 const inputA=invite(selected,identities.a.email),inputB=invite(orgB,identities.b.email),key=K();
 const invitationA=receipt(await send('hq/school-owner-invitations',{body:inputA,key}));
 assert.equal(invitationA.status,'PENDING');assert.equal(invitationA.organizationId,orgA.organizationId);assert.equal(invitationA.schoolId,selected.schoolId);
 pass('real HQ directory response has no organizationId; school-only UI command creates invitation under the database-resolved organization');assert(!JSON.stringify(invitationA).includes(inputA.token));
 assert.deepEqual(receipt(await send('hq/school-owner-invitations',{body:inputA,key})),invitationA);
 await denied(()=>send('hq/school-owner-invitations',{body:{...inputA,email:'changed@example.invalid'},key}),409);
 const invitationB=receipt(await send('hq/school-owner-invitations',{body:inputB}));
 pass('HQ-only expiring invitations, server hash custody, exact retry and changed-key conflict; independent organizations');
 // These assertions fail on the reviewed implementation: it returns 55P03 before checking authority.
 // AccessShare reads remain possible under this ordinary writer lock; unauthorized callers must
 // deny before attempting either the onboarding advisory lock or broad account/billing locks.
 for(const lock of ['advisory','tables']){
  await blocker.query('BEGIN');
  try{
   if(lock==='advisory')await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('hon.school-account.v1',0))");
   else await blocker.query('LOCK TABLE hon.users IN SHARE ROW EXCLUSIVE MODE');
   for(const who of ['operator','expired'])await denied(()=>send('hq/school-owner-invitations',{who,body:invite(orgA,'no-lock-'+K()+'@example.invalid')}),403);
   for(const subject of [actor.operator.subject,'oidc:unprivileged:'+K()]){
    await assert.rejects(()=>restricted.query("SELECT hon.manage_school_owner_invitation($1,'REVOKE',$2::jsonb,$3)",[subject,{invitationId:invitationA.invitationId},K()]),e=>e.code==='42501');
    await assert.rejects(()=>restricted.query('SELECT hon.read_school_owner_invitations($1,$2)',[subject,orgA.schoolId]),e=>e.code==='42501');
   }
   const bad={...accept(invitationA,inputA.token),tokenHash:hash(randomBytes(32))};delete bad.token;
   await assert.rejects(()=>restricted.query('SELECT hon.accept_school_owner_invitation($1,$2,$3::jsonb,$4)',[identities.a.externalSubject,identities.a.email,bad,K()]),e=>e.code==='42501');
   const good={invitationId:invitationA.invitationId,confirmation:OWNER_INVITATION_CONFIRMATION,tokenHash:hash(inputA.token)};
   await assert.rejects(()=>restricted.query('SELECT hon.accept_school_owner_invitation($1,$2,$3::jsonb,$4)',[identities.a.externalSubject,identities.a.email,good,K()]),e=>e.code==='55P03');
   await denied(()=>send('hq/school-owner-invitations',{body:invite(orgA,'valid-busy-'+K()+'@example.invalid')}),503);
  }finally{await blocker.query('ROLLBACK');}
 }
 pass('unprivileged, expired and wrong-capability callers deny before contended advisory/account-table locks; valid callers retain explicit recoverable busy');
 for(const isolation of ['REPEATABLE READ','SERIALIZABLE']){
  const before=await counts();await restricted.query('BEGIN ISOLATION LEVEL '+isolation);
  try{await assert.rejects(()=>restricted.query("SELECT hon.manage_school_owner_invitation($1,'REVOKE',$2::jsonb,$3)",[actor.hq.subject,{invitationId:invitationA.invitationId},K()]),e=>e.code==='42501');}
  finally{await restricted.query('ROLLBACK');}assert.deepEqual(await counts(),before);
 }
 pass('snapshot transaction isolation cannot preserve stale authority across lock acquisition or replay');
 await denied(()=>send('hq/school-owner-invitations',{who:'operator',body:invite(orgA,'op@example.invalid')}),403);
 await denied(()=>send('hq/school-owner-invitations',{who:'a',body:invite(orgA,'owner@example.invalid')}),403);
 await denied(()=>send('hq/school-owner-invitations',{body:invite({schoolId:K()},'missing@example.invalid')}),404);
 for(const patch of [{organizationId:orgB.organizationId},{role:'OWNER'},{activate:true},{organizationId:orgA.organizationId,principalId:K()}])await denied(()=>send('hq/school-owner-invitations',{body:{...inputA,...patch}}),400);
 await denied(()=>send('hq/school-owner-invitations',{who:'expired',body:invite(orgA,'expired@example.invalid')}),403);
 await denied(()=>send('hq/school-owner-invitations',{body:invite(orgA,'expired-session@example.invalid'),expired:true}),401);
 const rawOverride={schoolId:orgA.schoolId,organizationId:orgB.organizationId,email:'raw-'+K()+'@example.invalid',ttlHours:24,tokenHash:hash(randomBytes(32))};
 const noClaims=await counts();await assert.rejects(()=>restricted.query("SELECT hon.manage_school_owner_invitation($1,'INVITE',$2::jsonb,$3::uuid)",[actor.hq.subject,rawOverride,K()]),e=>e.code==='22023');assert.deepEqual(await counts(),noClaims);
 pass('operator/school/expired-HQ/session denial; browser and direct-function organization overrides, unknown schools and role/activation overrides refused atomically');
 for(const [who,body,identity]of [['b',accept(invitationA,inputA.token),undefined],['a',accept(invitationB,inputB.token),undefined],['a',accept(invitationA,randomBytes(32).toString('base64url')),undefined],['a',accept(invitationA,inputA.token),{...identities.a,emailVerified:undefined}]])
  await denied(()=>send('account/school-owner-invitations/accept',{who,body,identity}),403);
 await denied(()=>send('account/school-owner-invitations/accept',{who:'a',body:accept(invitationA,inputA.token),expired:true}),401);
 await denied(()=>send('account/school-owner-invitations/accept',{who:'a',body:accept(invitationA,inputA.token),headers:{cookie:HON_SESSION_COOKIE+'='+issueSession(identities.a,{...session,emitVerifiedEmail:false})}}),403);
 await denied(()=>send('account/school-owner-invitations/accept',{who:'a',body:accept(invitationA,inputA.token),headers:{cookie:HON_SESSION_COOKIE+'='+issueSession(identities.a,{...session,secret:randomBytes(32).toString('hex')})}}),401);
 pass('verified signed email/subject, exact invitation token, expired session and cross-school acceptance fail closed without records');
 const acceptKey=K(),bodyA=accept(invitationA,inputA.token);
 const accountA=receipt(await send('account/school-owner-invitations/accept',{who:'a',body:bodyA,key:acceptKey}));
 assert.equal(accountA.organizationId,orgA.organizationId);assert.equal(accountA.schoolId,orgA.schoolId);assert.equal(accountA.accountStatus,'OWNER_BOUND');
 for(const k of ['accessGranted','billingActivated','aiCreditsGranted'])assert.equal(accountA[k],false);
 assert.deepEqual(receipt(await send('account/school-owner-invitations/accept',{who:'a',body:bodyA,key:acceptKey})),accountA);
 await denied(()=>send('account/school-owner-invitations/accept',{who:'a',body:bodyA}),403);
 const accountB=receipt(await send('account/school-owner-invitations/accept',{who:'b',body:accept(invitationB,inputB.token)}));assert.equal(accountB.organizationId,orgB.organizationId);
 for(const [identity,o,other]of [[identities.a,orgA,orgB],[identities.b,orgB,orgA]]){
  assert.equal((await restricted.query("SELECT * FROM hon.resolve_authorized_scope($1,$2,'school.view')",[identity.externalSubject,o.schoolId])).rowCount,1);
  assert.equal((await restricted.query("SELECT * FROM hon.resolve_authorized_scope($1,$2,'school.view')",[identity.externalSubject,other.schoolId])).rowCount,0);
  const bound=await q("SELECT g.organization_id,g.school_id,r.code FROM hon.users u JOIN hon.principals p ON p.user_id=u.id JOIN hon.principal_role_grants g ON g.principal_id=p.id JOIN hon.roles r ON r.id=g.role_id WHERE u.external_subject=$1",[identity.externalSubject]);assert.equal(bound.length,1);assert.equal(bound[0].code,'OWNER');assert.equal(bound[0].school_id,o.schoolId);
 }
 // Test already-bound, fully permissioned school owners too, not only unknown signed subjects.
 await denied(()=>send('hq/school-owner-invitations',{who:'a',body:invite(orgB,'forbidden-'+K()+'@example.invalid')}),403);
 await denied(()=>send('hq/school-owner-invitations',{who:'b',body:invite(orgA,'forbidden-'+K()+'@example.invalid')}),403);
 pass('two independent signed owners get exactly their own server-selected role/school; cross-organization HQ invitation attempts denied; single use and lost-response exact replay do not duplicate');
 const otherOrgInput=invite(orgB,identities.a.email),otherOrgInv=receipt(await send('hq/school-owner-invitations',{body:otherOrgInput}));
 await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('hon.school-account.v1',0))");
 try{const before=await counts();await assert.rejects(()=>restricted.query('SELECT hon.accept_school_owner_invitation($1,$2,$3::jsonb,$4)',[identities.a.externalSubject,identities.a.email,{invitationId:otherOrgInv.invitationId,confirmation:OWNER_INVITATION_CONFIRMATION,tokenHash:hash(otherOrgInput.token)},K()]),e=>e.code==='23514');assert.deepEqual(await counts(),before);}
 finally{await blocker.query('ROLLBACK');}
 pass('even a valid invitation capability cannot acquire broad locks for an incompatible cross-organization identity');
 const c={externalSubject:'oidc:p0:'+K(),email:'c-'+K()+'@example.invalid',emailVerified:true},inputC=invite(orgA,c.email),invC=receipt(await send('hq/school-owner-invitations',{body:inputC})),kc=K(),bc=accept(invC,inputC.token);
 const parallel=await Promise.all([send('account/school-owner-invitations/accept',{identity:c,body:bc,key:kc}),send('account/school-owner-invitations/accept',{identity:c,body:bc,key:kc})]);
 assert(parallel.some(r=>r.status===200));assert(parallel.every(r=>[200,503].includes(r.status)));receipt(await send('account/school-owner-invitations/accept',{identity:c,body:bc,key:kc}));
 assert.equal((await q('SELECT count(*) n FROM hon.school_account_events WHERE invitation_id=$1 AND action=\'ACCEPT\'',[invC.invitationId]))[0].n,'1');pass('concurrent acceptance serializes or returns recoverable busy; explicit same-key recovery creates one grant and one event');
 receipt(await send('hq/school-owner-invitations/revoke',{body:{invitationId:invitationA.invitationId}}));
 await denied(()=>send('account/school-owner-invitations/accept',{who:'a',body:bodyA,key:acceptKey}),403);
 assert.equal((await restricted.query("SELECT * FROM hon.resolve_authorized_scope($1,$2,'school.view')",[identities.a.externalSubject,orgA.schoolId])).rowCount,0);
 assert.equal((await restricted.query("SELECT * FROM hon.resolve_authorized_scope($1,$2,'school.view')",[identities.b.externalSubject,orgB.schoolId])).rowCount,1);pass('revocation ends only the invitation-bound grant; accepted retry cannot resurrect authority; foreign owner preserved');
 const expiredId=K(),expiredToken=randomBytes(32).toString('base64url');
 await q("INSERT INTO hon.school_owner_invitations(id,organization_id,school_id,email,token_hash,created_by,created_at,expires_at,status) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day','PENDING')",[expiredId,orgA.organizationId,orgA.schoolId,c.email,hash(expiredToken),actor.hq.principal]);
 await denied(()=>send('account/school-owner-invitations/accept',{identity:c,body:accept({invitationId:expiredId},expiredToken)}),403);pass('expired invitations fail closed without cleanup or new claims');
 const pid=(await restricted.query('SELECT pg_backend_pid() pid')).rows[0].pid,blockerPid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 // Authorized requests may wait behind a private invitation row, but live authority/expiry
 // must be checked after that wait; the losing command must roll back every possible effect.
 await blocker.query('BEGIN');await blocker.query('SELECT id FROM hon.school_owner_invitations WHERE id=$1 FOR UPDATE',[otherOrgInv.invitationId]);
 await q("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp()+interval '5 seconds' WHERE principal_id=$1",[actor.waiter.principal]);
 const beforeWait=await counts(),pendingRevoke=restricted.query("SELECT hon.manage_school_owner_invitation($1,'REVOKE',$2::jsonb,$3)",[actor.waiter.subject,{invitationId:otherOrgInv.invitationId},K()]).then(value=>({value}),error=>({error}));
 await waitBehindInvitationRow(pid,blockerPid);
 await q('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(effective_until-clock_timestamp())))+0.02) FROM hon.hq_operator_grants WHERE principal_id=$1',[actor.waiter.principal]);
 await blocker.query('COMMIT');assert.equal((await pendingRevoke).error?.code,'42501');assert.deepEqual(await counts(),beforeWait);assert.equal((await q('SELECT status FROM hon.school_owner_invitations WHERE id=$1',[otherOrgInv.invitationId]))[0].status,'PENDING');
 await q('UPDATE hon.hq_operator_grants SET effective_until=NULL WHERE principal_id=$1',[actor.waiter.principal]);
 const waitIdentity={externalSubject:'oidc:wait:'+K(),email:'wait-'+K()+'@example.invalid',emailVerified:true},waitToken=randomBytes(32).toString('base64url'),waitId=K();
 await q("INSERT INTO hon.school_owner_invitations(id,organization_id,school_id,email,token_hash,created_by,created_at,expires_at,status) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp()+interval '5 seconds','PENDING')",[waitId,orgA.organizationId,orgA.schoolId,waitIdentity.email,hash(waitToken),actor.hq.principal]);
 await blocker.query('BEGIN');await blocker.query('SELECT id FROM hon.school_owner_invitations WHERE id=$1 FOR UPDATE',[waitId]);
 const beforeExpiry=await counts(),pendingAccept=restricted.query('SELECT hon.accept_school_owner_invitation($1,$2,$3::jsonb,$4)',[waitIdentity.externalSubject,waitIdentity.email,{invitationId:waitId,confirmation:OWNER_INVITATION_CONFIRMATION,tokenHash:hash(waitToken)},K()]).then(value=>({value}),error=>({error}));
 await waitBehindInvitationRow(pid,blockerPid);await q('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))+0.02) FROM hon.school_owner_invitations WHERE id=$1',[waitId]);
 await blocker.query('COMMIT');assert.equal((await pendingAccept).error?.code,'42501');assert.deepEqual(await counts(),beforeExpiry);
 pass('HQ authority and invitation expiry during actual row waits fail closed; no partial identity, role, invitation, claim or evidence effects');
 // Authority that expires between verification and the evidence write fails closed (deterministic clock barrier).
 // Fixture-only: the evidence INSERT waits until a pinned instant T has passed. HQ authority or the invitation is set to
 // expire exactly at T, so every pre-write check sees it live and only a check made after the evidence write sees it expired.
 // Sequences are not transactional: each trigger entry stays counted even when the command later rolls back.
 await q('CREATE SEQUENCE public.p0_clock_barrier_entries');
 await q('CREATE TABLE public.p0_clock_barrier_at(until timestamptz)');await q('INSERT INTO public.p0_clock_barrier_at VALUES(NULL)');
 await q(`CREATE FUNCTION public.p0_clock_barrier() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  DECLARE u timestamptz; BEGIN SELECT until INTO u FROM public.p0_clock_barrier_at;
  IF u IS NOT NULL THEN PERFORM nextval('public.p0_clock_barrier_entries'); PERFORM pg_sleep(greatest(0,extract(epoch FROM u-clock_timestamp()))+0.02); END IF; RETURN NEW; END $$`);
 await q('CREATE TRIGGER p0_clock_barrier BEFORE INSERT ON hon.school_account_events FOR EACH ROW EXECUTE FUNCTION public.p0_clock_barrier()');
 const pin=async()=>{const t=(await q("SELECT clock_timestamp()+interval '1500 milliseconds' t"))[0].t;await q('UPDATE public.p0_clock_barrier_at SET until=$1',[t]);return t;};
 const unpin=()=>q('UPDATE public.p0_clock_barrier_at SET until=NULL');
 const expireWaiterAt=t=>q('UPDATE hon.hq_operator_grants SET effective_until=$2 WHERE principal_id=$1',[actor.waiter.principal,t]);
 const restoreWaiter=()=>q('UPDATE hon.hq_operator_grants SET effective_until=NULL WHERE principal_id=$1',[actor.waiter.principal]);
 // The call must observably enter the evidence-write trigger (rollback-independent counter) and only then fail.
 const entries=async()=>Number((await q('SELECT CASE WHEN is_called THEN last_value ELSE 0 END n FROM public.p0_clock_barrier_entries'))[0].n);
 const atBoundary=async(t,work)=>{const before=await entries();const r=await denied(work,403);
  assert((await entries())>before,'refused before entering the evidence write');assert(Date.now()>=t.getTime(),'refused before the expiry instant');return r;};
 const throughBarrier=async(t,work)=>{const before=await entries();const r=await work();assert((await entries())>before,'control did not pass the barrier');assert(Date.now()>=t.getTime());return r;};
 try{
  // Control: intact HQ authority completes through the same barrier.
  let t=await pin();
  const ctlIdentity={externalSubject:'oidc:p0:'+K(),email:'ctl-'+K()+'@example.invalid',emailVerified:true},ctlInput=invite(orgA,ctlIdentity.email);
  const ctlInv=receipt(await throughBarrier(t,()=>send('hq/school-owner-invitations',{who:'waiter',body:ctlInput})));assert.equal(ctlInv.status,'PENDING');await unpin();
  // INVITE and REVOKE: the HQ owner grant expires at T.
  t=await pin();await expireWaiterAt(t);
  await atBoundary(t,()=>send('hq/school-owner-invitations',{who:'waiter',body:invite(orgA,'late-'+K()+'@example.invalid')}));
  await unpin();await restoreWaiter();
  t=await pin();await expireWaiterAt(t);
  await atBoundary(t,()=>send('hq/school-owner-invitations/revoke',{who:'waiter',body:{invitationId:ctlInv.invitationId}}));
  assert.equal((await q('SELECT status FROM hon.school_owner_invitations WHERE id=$1',[ctlInv.invitationId]))[0].status,'PENDING');
  await unpin();await restoreWaiter();
  // ACCEPT: the issuing HQ owner's grant expires at T; no identity or OWNER grant survives.
  t=await pin();await expireWaiterAt(t);
  await atBoundary(t,()=>send('account/school-owner-invitations/accept',{identity:ctlIdentity,body:accept(ctlInv,ctlInput.token)}));
  await unpin();await restoreWaiter();
  assert.equal((await q('SELECT count(*) n FROM hon.users WHERE external_subject=$1',[ctlIdentity.externalSubject]))[0].n,'0');
  assert.equal((await q('SELECT status FROM hon.school_owner_invitations WHERE id=$1',[ctlInv.invitationId]))[0].status,'PENDING');
  // ACCEPT: the invitation itself expires at T.
  const lateIdentity={externalSubject:'oidc:p0:'+K(),email:'late-accept-'+K()+'@example.invalid',emailVerified:true},lateToken=randomBytes(32).toString('base64url'),lateId=K();
  t=await pin();
  await q("INSERT INTO hon.school_owner_invitations(id,organization_id,school_id,email,token_hash,created_by,created_at,expires_at,status) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),$7,'PENDING')",[lateId,orgA.organizationId,orgA.schoolId,lateIdentity.email,hash(lateToken),actor.waiter.principal,t]);
  await atBoundary(t,()=>send('account/school-owner-invitations/accept',{identity:lateIdentity,body:accept({invitationId:lateId},lateToken)}));
  await unpin();
  assert.equal((await q('SELECT count(*) n FROM hon.users WHERE external_subject=$1',[lateIdentity.externalSubject]))[0].n,'0');
  // Control acceptance through the barrier, then revoke it so the owner grant does not outlive the group.
  t=await pin();assert.equal(receipt(await throughBarrier(t,()=>send('account/school-owner-invitations/accept',{identity:ctlIdentity,body:accept(ctlInv,ctlInput.token)}))).accountStatus,'OWNER_BOUND');await unpin();
  // REVOKE of the accepted invitation: the HQ owner grant expires at T; the invitation and every OWNER grant field roll back.
  const ownerGrantRows=()=>q("SELECT to_jsonb(g)::text r FROM hon.principal_role_grants g JOIN hon.principals p ON p.id=g.principal_id JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=$1 ORDER BY g.id",[ctlIdentity.externalSubject]);
  const invitationRow=()=>q('SELECT to_jsonb(i)::text r FROM hon.school_owner_invitations i WHERE id=$1',[ctlInv.invitationId]);
  const acceptedGrants=await ownerGrantRows(),acceptedInvitation=await invitationRow();assert.equal(acceptedGrants.length,1);
  t=await pin();await expireWaiterAt(t);
  await atBoundary(t,()=>send('hq/school-owner-invitations/revoke',{who:'waiter',body:{invitationId:ctlInv.invitationId}}));
  await unpin();await restoreWaiter();
  assert.deepEqual(await ownerGrantRows(),acceptedGrants,'late revoke leaves every OWNER grant field unchanged');
  assert.deepEqual(await invitationRow(),acceptedInvitation,'late revoke leaves the accepted invitation unchanged');
  receipt(await send('hq/school-owner-invitations/revoke',{who:'waiter',body:{invitationId:ctlInv.invitationId}}));
  assert.notDeepEqual(await ownerGrantRows(),acceptedGrants,'the authorized revoke does end the OWNER grant');
  // Replay after expiry: a stored INVITE response is not returned to an HQ owner whose authority has ended.
  const replayKey=K(),replayInput=invite(orgA,'replay-'+K()+'@example.invalid');receipt(await send('hq/school-owner-invitations',{who:'waiter',body:replayInput,key:replayKey}));
  await q('UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1',[actor.waiter.principal]);
  await denied(()=>send('hq/school-owner-invitations',{who:'waiter',body:replayInput,key:replayKey}),403);
 }finally{
  await unpin().catch(()=>{});await restoreWaiter();
  await q('DROP TRIGGER p0_clock_barrier ON hon.school_account_events');await q('DROP FUNCTION public.p0_clock_barrier()');await q('DROP TABLE public.p0_clock_barrier_at');await q('DROP SEQUENCE public.p0_clock_barrier_entries');
 }
 pass('HQ authority or invitation expiry between verification and the evidence write fails closed (trigger entry observed): no invitation, revocation, identity, OWNER grant change or evidence, including revoke of an accepted invitation; replay after expiry refused');
 const rollbackIdentity={externalSubject:'oidc:p0:'+K(),email:'rollback-'+K()+'@example.invalid',emailVerified:true},rollbackInput=invite(orgA,rollbackIdentity.email);
 const rollbackInvitation=receipt(await send('hq/school-owner-invitations',{body:rollbackInput}));
 await q('ALTER TABLE hon.school_account_events ADD CONSTRAINT p0_synthetic_failure CHECK(false) NOT VALID');
 try{await denied(()=>send('account/school-owner-invitations/accept',{identity:rollbackIdentity,body:accept(rollbackInvitation,rollbackInput.token)}),409);}finally{await q('ALTER TABLE hon.school_account_events DROP CONSTRAINT p0_synthetic_failure');}
 pass('injected evidence failure rolls back newly created user, principal, grant, acceptance state, claim and audit/outbox together');
 const blocked=invite(orgB,'blocked-'+K()+'@example.invalid'),before=await counts();
 await blocker.query('BEGIN');await blocker.query('UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1',[actor.hq.principal]);
 await denied(()=>send('hq/school-owner-invitations',{body:blocked}),503);await blocker.query('COMMIT');
 await denied(()=>send('hq/school-owner-invitations',{body:blocked}),403);assert.deepEqual(await counts(),before);
 await q('UPDATE hon.hq_operator_grants SET effective_until=NULL WHERE principal_id=$1',[actor.hq.principal]);pass('concurrent HQ revocation: NOWAIT prevents inverted waits and post-revocation requests create no invitation, identity or evidence');
 for(const t of ['school_account_events','school_account_requests']){await assert.rejects(()=>admin.query('UPDATE hon.'+t+" SET subject=subject"),e=>e.code==='42501');}
 for(const sql of ['SELECT * FROM hon.school_owner_invitations','DELETE FROM hon.school_account_events','SELECT hon.lock_school_account_authority()',"SELECT hon.check_school_owner_acceptance(NULL,NULL,'{}',NULL)"])await assert.rejects(()=>restricted.query(sql),e=>e.code==='42501');pass('immutable evidence and direct runtime/helper bypasses denied');
 const list=receipt(await send('hq/schools/'+orgB.schoolId+'/owner-invitations',{method:'GET'}));assert(list.every(i=>i.schoolId===orgB.schoolId));assert(!JSON.stringify(list).includes('tokenHash'));
 await denied(()=>send('hq/schools/'+orgB.schoolId+'/owner-invitations',{who:'b',method:'GET'}),403);
 await denied(()=>send('hq/school-owner-invitations',{body:invite(orgB,'csrf@example.invalid'),headers:{origin:'https://evil.invalid'}}),403);pass('protected minimized HQ-only read and same-origin mutation boundary');
 const beforeThrottle=await counts();let throttled;
 for(let n=0;n<31;n++){const r=await send('hq/school-owner-invitations',{who:'operator',body:invite(orgA,'rate-'+K()+'@example.invalid')});if(r.status===429){throttled=r;break;}assert.equal(r.status,403);}
 assert(throttled);assert.equal(throttled.body.outcome,'NOT_SUBMITTED');assert(+throttled.headers['retry-after']>=1&&+throttled.headers['retry-after']<=60);assert.deepEqual(await counts(),beforeThrottle);
 const rateIdentity={externalSubject:'oidc:rate:'+K(),email:'rate-'+K()+'@example.invalid',emailVerified:true};let acceptThrottle;
 for(let n=0;n<11;n++){const r=await send('account/school-owner-invitations/accept',{identity:rateIdentity,body:accept(invitationB,randomBytes(32).toString('base64url'))});if(r.status===429){acceptThrottle=r;break;}assert.equal(r.status,403);}
 assert(acceptThrottle);assert.equal(acceptThrottle.body.outcome,'NOT_SUBMITTED');assert(+acceptThrottle.headers['retry-after']>=1&&+acceptThrottle.headers['retry-after']<=60);assert.deepEqual(await counts(),beforeThrottle);
 pass('bounded authenticated HQ and acceptance HTTP throttling return 429 before SQL with no account, audit, outbox or business effects');
 // Restore the intentional IAM revocation test before comparing all unrelated business records.
 assert.deepEqual(await bootstrapGrants(),originalBootstrapGrants);assert.deepEqual(await snapshot(),baseline);pass('D9 HQ bootstrap grants and all unrelated business rows unchanged: zero entitlement, SaaS, payment, AI credit, CRM, delivery or provider effects');
 console.log('PASS P0-1: '+groups+' real signed-session/PostgreSQL scenario groups; no live accounts/providers.');
}finally{
 try{await blocker.query('ROLLBACK');}catch{}
 try{if(app)await app.close();else await database.onModuleDestroy();}finally{await Promise.allSettled([admin.end(),restricted.end(),blocker.end()]);}
}
