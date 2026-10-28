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
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('../../../apps/api/dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('../../../apps/api/dist/foundation/hon-identity.service.js');
const {SchoolOwnerInvitationService}=require('../../../apps/api/dist/accounts/school-owner-invitation.service.js');
const {SchoolOwnerInvitationController,SchoolAccountHumanGuard}=require('../../../apps/api/dist/accounts/school-owner-invitation.controller.js');
const {OWNER_INVITATION_CONFIRMATION}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),blocker=new pg.Client({connectionString:owner.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'p0-disposable',secret:randomBytes(32).toString('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const actor={hq:{subject:'p0-hq-'+K(),principal:K(),user:K()},operator:{subject:'p0-op-'+K(),principal:K(),user:K()}};
const identities={a:{externalSubject:'oidc:p0:'+K(),email:'a-'+K()+'@example.invalid',emailVerified:true},b:{externalSubject:'oidc:p0:'+K(),email:'b-'+K()+'@example.invalid',emailVerified:true}};
const pass=name=>console.log('PASS P0-1 '+(++groups)+' '+name);
const hash=x=>createHash('sha256').update(x).digest('hex');
async function send(path,{who='hq',body,key=K(),method='POST',identity,expired=false,headers={}}={}){
 const person=identity??(actor[who]?{externalSubject:actor[who].subject}:identities[who]);
 const cookie=person?HON_SESSION_COOKIE+'='+issueSession(person,session,Math.floor(Date.now()/1000)-(expired?43201:0)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':'school-owner-account','idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const invite=(o,email,extra={})=>{const token=randomBytes(32).toString('base64url');return {organizationId:o.organizationId,schoolId:o.schoolId,email,ttlHours:24,token,...extra};};
const accept=(i,token)=>({invitationId:i.invitationId,token,confirmation:OWNER_INVITATION_CONFIRMATION});
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const receipt=r=>{assert.equal(r.status,200,JSON.stringify(r));return r.body.data;};
const counts=async()=>Object.fromEntries(await Promise.all(['users','principals','principal_role_grants','school_owner_invitations','school_account_requests','school_account_events'].map(async t=>[t,(await q('SELECT count(*) n FROM hon.'+t))[0].n])));
async function denied(work,status){const before=await counts();const r=await work();assert.equal(r.status,status,JSON.stringify(r));assert.deepEqual(await counts(),before);assert.equal(r.headers['cache-control'],'private, no-store');assert(!JSON.stringify(r.body).match(/tokenHash|external_subject|SQLSTATE|SELECT /));return r;}
try{
 await Promise.all([admin.connect(),restricted.connect(),blocker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 await verifySchoolAccountSecurity(admin,runtime.username);pass('forced deny-all RLS, exact runtime function privileges, no table/column or public helper bypass');
 for(const [kind,a]of Object.entries(actor)){
  await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'P0 synthetic HQ')",[a.user,a.subject,a.user+'@example.invalid']);
  await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','P0 synthetic HQ')",[a.principal,a.user]);
  await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes) VALUES($1,$2,ARRAY['hq.onboarding.manage'])",[a.principal,kind==='hq'?'HON_HQ_OWNER':'HON_HQ_OPERATOR']);
 }
 const provision=async()=>{const id=K();return (await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'P0 synthetic','P0 synthetic','P0 school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[actor.hq.subject,'p0-'+id,K(),K()]))[0];};
 const orgA=await provision(),orgB=await provision();
 const excluded=['users','principals','principal_role_grants','school_owner_invitations','school_account_requests','school_account_events'];
 const tables=(await q("SELECT tablename FROM pg_tables WHERE schemaname='hon' AND NOT(tablename=ANY($1)) ORDER BY tablename",[excluded])).map(r=>r.tablename);
 const snapshot=async()=>{const out={};for(const t of tables){assert.match(t,/^[a-z_]+$/);out[t]=hash(JSON.stringify(await q('SELECT to_jsonb(t)::text r FROM hon.'+t+' t ORDER BY 1')));}return out;};const baseline=await snapshot();
 const module=await Test.createTestingModule({controllers:[SchoolOwnerInvitationController],providers:[SchoolOwnerInvitationService,SchoolAccountHumanGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 const inputA=invite(orgA,identities.a.email),inputB=invite(orgB,identities.b.email),key=K();
 const invitationA=receipt(await send('hq/school-owner-invitations',{body:inputA,key}));
 assert.equal(invitationA.status,'PENDING');assert(!JSON.stringify(invitationA).includes(inputA.token));
 assert.deepEqual(receipt(await send('hq/school-owner-invitations',{body:inputA,key})),invitationA);
 await denied(()=>send('hq/school-owner-invitations',{body:{...inputA,email:'changed@example.invalid'},key}),409);
 const invitationB=receipt(await send('hq/school-owner-invitations',{body:inputB}));
 pass('HQ-only expiring invitations, server hash custody, exact retry and changed-key conflict; independent organizations');
 await denied(()=>send('hq/school-owner-invitations',{who:'operator',body:invite(orgA,'op@example.invalid')}),403);
 await denied(()=>send('hq/school-owner-invitations',{who:'a',body:invite(orgA,'owner@example.invalid')}),403);
 await denied(()=>send('hq/school-owner-invitations',{body:invite({...orgA,schoolId:orgB.schoolId},'mismatch@example.invalid')}),404);
 for(const patch of [{role:'OWNER'},{activate:true},{organizationId:orgA.organizationId,principalId:K()}])await denied(()=>send('hq/school-owner-invitations',{body:{...inputA,...patch}}),400);
 pass('operator/school denial; cross-organization school selectors and client authority/activation overrides refused atomically');
 for(const [who,body,identity]of [['b',accept(invitationA,inputA.token),undefined],['a',accept(invitationB,inputB.token),undefined],['a',accept(invitationA,randomBytes(32).toString('base64url')),undefined],['a',accept(invitationA,inputA.token),{...identities.a,emailVerified:undefined}]])
  await denied(()=>send('account/school-owner-invitations/accept',{who,body,identity}),403);
 await denied(()=>send('account/school-owner-invitations/accept',{who:'a',body:accept(invitationA,inputA.token),expired:true}),401);
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
 pass('two independent signed owners get exactly their own server-selected role/school; single use and lost-response exact replay do not duplicate');
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
 for(const sql of ['SELECT * FROM hon.school_owner_invitations','DELETE FROM hon.school_account_events','SELECT hon.lock_school_account_authority()'])await assert.rejects(()=>restricted.query(sql),e=>e.code==='42501');pass('immutable evidence and direct runtime/helper bypasses denied');
 const list=receipt(await send('hq/schools/'+orgB.schoolId+'/owner-invitations',{method:'GET'}));assert(list.every(i=>i.schoolId===orgB.schoolId));assert(!JSON.stringify(list).includes('tokenHash'));
 await denied(()=>send('hq/schools/'+orgB.schoolId+'/owner-invitations',{who:'b',method:'GET'}),403);
 await denied(()=>send('hq/school-owner-invitations',{body:invite(orgB,'csrf@example.invalid'),headers:{origin:'https://evil.invalid'}}),403);pass('protected minimized HQ-only read and same-origin mutation boundary');
 // Restore the intentional IAM revocation test before comparing all unrelated business records.
 assert.deepEqual(await snapshot(),baseline);pass('all unrelated business rows unchanged: zero entitlement, SaaS, payment, AI credit, CRM, delivery or provider effects');
 console.log('PASS P0-1: '+groups+' real signed-session/PostgreSQL scenario groups; no live accounts/providers.');
}finally{
 try{await blocker.query('ROLLBACK');}catch{}
 try{if(app)await app.close();else await database.onModuleDestroy();}finally{await Promise.allSettled([admin.end(),restricted.end(),blocker.end()]);}
}
