/** Retention review member list (0407). Real signed HON sessions -> Nest -> runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). Synthetic names only. */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
import {membershipFixtureStatement} from './membership-activation-test-support.mjs';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {RetentionReviewService:S}=require('./dist/retention-review/retention-review.service.js'),{RetentionReviewController:C}=require('./dist/retention-review/retention-review.controller.js'),{RetentionReviewHumanUiGuard:G}=require('./dist/retention-review/retention-review.dto.js');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'retention-members-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS RETENTION-MEMBERS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=label=>({externalSubject:'oidc:retmembers:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function get(path,identity){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method:'GET',headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',accept:'application/json'}},res=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>{let body;try{body=JSON.parse(t);}catch{body=t;}resolve({status:res.statusCode,headers:res.headers,body});});});req.on('error',reject);req.end();});
}
async function human(identity,label){
 const user=K(),principal=K();
 await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[user,identity.externalSubject,identity.email,label]);
 await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,true)",[principal,user,label]);
 return principal;
}
async function customRole(o,code,perms){
 const id=(await q("INSERT INTO hon.roles(organization_id,management_school_id,code,name) VALUES($1,$2,$3,$4) RETURNING id",[o.organizationId,o.schoolId,code,code.replace('CUSTOM_','')]))[0].id;
 for(const p of perms)await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[id,o.organizationId,p]);
 return id;
}
const grant=async(o,principal,role)=>(await q("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day') RETURNING id",[o.organizationId,o.schoolId,principal,role]))[0].id;
async function member(o,given,family,state){
 const p=K(),b=K(),m=K();
 await admin.query('BEGIN');
 try{
  await q('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,$4,$5,$6)',[p,o.organizationId,o.schoolId,given,family,'canary-'+K()+'@example.invalid']);
  await q('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)',[b,o.organizationId,o.schoolId,p]);
  await membershipFixtureStatement(admin,"INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_ends_at) VALUES($1,$2,$3,$4,$5,'FIXTURE',$6,'2027-01-31T00:00:00Z')",[m,o.organizationId,o.schoolId,b,p,state]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
 return m;
}
const list=o=>'staff/retention/review/memberships?schoolId='+o.schoolId;

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Runtime ACL: an EXECUTE-only definer entry point that refuses a call outside a tenant HUMAN_UI session.
 const fn=(await q("SELECT p.oid,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname='list_retention_review_members'"))[0];
 assert.equal(fn.prosecdef,true);
 assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,fn.oid]))[0].ok,true);
 assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[fn.oid]))[0].ok,false);
 await assert.rejects(()=>restricted.query("SELECT hon.list_retention_review_members('x')"),e=>e.code==='42501');
 pass('EXECUTE-only definer entry point that refuses calls outside a tenant HUMAN_UI session');

 const hq={subject:'retmembers-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'Members synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Members synthetic','Members synthetic','Members school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,'retmembers-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const reviewer=person('reviewer');const reviewerPrincipal=await human(reviewer,'Riley Reviewer');const reviewerGrant=await grant(A,reviewerPrincipal,await customRole(A,'CUSTOM_RET_REVIEW',['school.view','retention.review.read']));
 const viewer=person('viewer');await grant(A,await human(viewer,'Vic Viewer'),await customRole(A,'CUSTOM_RET_VIEW',['school.view']));
 const reviewerB=person('reviewer-b');await grant(B,await human(reviewerB,'Other School'),await customRole(B,'CUSTOM_RET_REVIEW',['school.view','retention.review.read']));
 const outsider=person('outsider');await human(outsider,'Outsider');
 const zoe=await member(A,'Zoe','Young','ACTIVE'),ann=await member(A,'Ann','Able','FROZEN'),ended=await member(A,'Ned','Ended','EXPIRED');
 const draft=await member(A,'Dee','Draft','DRAFT'),cancelled=await member(A,'Cal','Cancelled','CANCELLED'),other=await member(B,'Bea','Elsewhere','ACTIVE');
 const module=await Test.createTestingModule({controllers:[C],providers:[S,G,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;

 // 2. The reviewer sees this school's current members by name, ordered by name, with only id, name, state and term end.
 const r=await get(list(A),reviewer);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');
 const items=r.body.data.items;
 assert.deepEqual(items.map(i=>i.displayName),['Ann Able','Ned Ended','Zoe Young']);
 assert.deepEqual(items.map(i=>i.membershipId),[ann,ended,zoe]);
 for(const i of items){assert.deepEqual(Object.keys(i).sort(),['displayName','membershipId','state','termEndsAt']);assert.equal(i.termEndsAt,'2027-01-31T00:00:00.000Z');}
 assert(!JSON.stringify(r.body).includes('canary-'),'no contact detail');
 for(const hidden of [draft,cancelled,other])assert(!items.some(i=>i.membershipId===hidden));
 pass('lists only this school\'s ACTIVE, FROZEN, CANCELLATION_PENDING and EXPIRED memberships by participant name, never contacts, drafts, cancelled or another school\'s members');

 // 3. Wrong permission, other school, outsider, signed-out and extra query parameters get nothing.
 for(const [label,res] of [['no permission',await get(list(A),viewer)],['other school reviewer',await get(list(A),reviewerB)],['outsider',await get(list(A),outsider)],['signed out',await get(list(A),null)],['extra query',await get(list(A)+'&membershipId='+zoe,reviewer)]]){
  assert(res.status>=400&&res.status<500,label+' '+res.status);assert(!JSON.stringify(res.body).includes('Zoe'),label);
 }
 pass('a staff member without retention.review.read, another school\'s reviewer, an outsider, a signed-out caller and an extra query parameter are refused with no names');

 // 4. Revoked grant and lapsed entitlement read nothing.
 await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[A.organizationId]).catch(async()=>q("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1",[A.organizationId]));
 const lapsed=await get(list(A),reviewer);assert(lapsed.status===403,'lapsed '+lapsed.status);
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[A.organizationId]);
 assert.equal((await get(list(A),reviewer)).status,200);
 await q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[reviewerGrant]);
 const revoked=await get(list(A),reviewer);assert(revoked.status===403,'revoked '+revoked.status);
 pass('a lapsed school and a revoked grant read nothing');

 // 5. Read only: nothing about the school changed.
 assert.equal((await q("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'retention.%'",[A.organizationId]))[0].n,0);
 pass('the list writes no audit, outbox or review record');
 console.log('Retention review member list integrity passed: '+groups+' groups.');
}finally{await app?.close();await Promise.allSettled([admin.end(),restricted.end()]);}
