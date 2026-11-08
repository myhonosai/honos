import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID as K } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { syntheticExceptionPolicy } from './exception-policy-fixture.mjs';
import { verifySaasBillingSecurity } from './saas-billing-security.mjs';
// D10: ALL APPROVED decisions below are synthetic disposable fixtures. Never seeds or operational approval.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
assert(owner.hostname==='localhost'&&owner.port==='5432'&&owner.pathname==='/hon_champions_validation'&&owner.username==='hon_champions_owner');
assert(runtime.hostname===owner.hostname&&runtime.port===owner.port&&runtime.pathname===owner.pathname&&runtime.username==='hon_champions_runtime');
assert(!Object.keys(process.env).some(k=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k)));
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const service=new SaasSchoolBillingService(new SaasBillingService(new RuntimeDatabaseService()));
const client=url=>new pg.Client({connectionString:url.toString(),ssl:false});
const admin=client(owner),a=client(runtime),b=client(runtime);
// Decisions bind to the latest proposed paid-access terms version (2 since 0192).
let TERMS=1;
const humans=Object.fromEntries(['owner','operator','school','expired','ai','delegated'].map(k=>[k,{id:K(),user:K(),subject:'d10-'+K()}]));
const H=k=>humans[k].subject,DAY=86400_000,iso=n=>new Date(n).toISOString();
const orgs=Array.from({length:12},()=>({id:K(),school:K()}));
const tables=['saas_access_exceptions','saas_exception_policy_decisions','saas_outbox','saas_audit','saas_requests'];
let groups=0;
const passed=name=>{groups++;console.log('PASS D10 '+groups+': '+name);};
const row=async(sql,p)=>(await admin.query(sql,p)).rows[0];
const ent=async o=>row('SELECT to_jsonb(e) data FROM hon.organization_entitlements e WHERE organization_id=$1',[o.id]).then(r=>r.data);
async function footprint(){const x={};for(const t of tables)x[t]=(await row(`SELECT count(*)::int n FROM hon.${t}`)).n;return x;}
const deny=(p,status,code)=>assert.rejects(p,e=>{assert.equal(e.getStatus?.(),status,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;});
const sqlDeny=(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const input=(o,patch={})=>({schoolId:o.school,purpose:'INTERNAL_TESTING',reason:'Disposable synthetic exception only',scopeTier:'COMPLETE',startsAt:iso(Date.now()),expiresAt:iso(Date.now()+DAY),expectedEntitlementVersion:1,...patch});
const grant=(o,body=input(o),key=K(),who='owner')=>service.grantAccessException(H(who),o.id,body,key);
const decide=(body,key=K(),who='owner')=>service.decideExceptionPolicy(H(who),body,key);
const approval=patch=>syntheticExceptionPolicy(admin,service,H('owner'),patch);
const inactive=async()=>{
 assert.deepEqual(await row(`SELECT (SELECT status FROM hon.saas_access_program) paid,(SELECT status FROM hon.saas_credit_program) ai,(SELECT status FROM hon.saas_payment_program) pay,(SELECT status FROM hon.saas_reward_fulfillment) rewards`),{paid:'INACTIVE',ai:'INACTIVE',pay:'DISABLED',rewards:'INACTIVE'});
 for(const t of ['saas_credit_allowances','saas_credit_reservations','saas_credit_ledger','ai_usage_ledger'])assert.equal((await row(`SELECT count(*)::int n FROM hon.${t}`)).n,0);
};
async function nothing(command,o,status=422,code='SAAS_EXCEPTION_POLICY_REQUIRED'){
 const before=await footprint(),e=await ent(o);await deny(command(),status,code);assert.deepEqual(await footprint(),before);assert.deepEqual(await ent(o),e);
}
const sqlGrant=(c,o,body=input(o),key=K())=>c.query('SELECT hon.grant_saas_access_exception($1,$2,$3,$4,$5,$6) data',[H('owner'),o.id,body,key,K(),K()]);
const sqlDecision=(c,body,key=K())=>c.query('SELECT hon.decide_saas_exception_policy($1,$2,$3,$4,$5) data',[H('owner'),body,key,K(),K()]);
const settled=p=>p.then(value=>({value}),error=>({error}));
async function waitBlocked(c){const pid=(await c.query('SELECT pg_backend_pid() p')).rows[0].p;return pid;}
async function waits(pid){for(const end=Date.now()+5000;Date.now()<end;await sleep(10)){if((await row('SELECT cardinality(pg_blocking_pids($1))>0 b',[pid])).b)return;}throw Error('Expected real PostgreSQL lock contention');}
async function cleanup(){
 await admin.query('ROLLBACK');await admin.query('BEGIN');
 try{
  for(const t of tables){await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);await admin.query(`DELETE FROM hon.${t}`);await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);}
  for(const t of ['organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs.map(o=>o.id)]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs.map(o=>o.id)]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
await Promise.all([admin,a,b].map(c=>c.connect()));
try{
 assert.equal((await row("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).m,'HON disposable Champions Club validation');
 await cleanup();await inactive();await verifySaasBillingSecurity(admin,'hon_champions_runtime');
 const paidTerms=(await admin.query("SELECT to_jsonb(t) x FROM hon.saas_access_policy_terms t UNION ALL SELECT to_jsonb(r) FROM hon.saas_policy_records r WHERE policy_code='PAID_ACCESS'")).rows;
 await admin.query('BEGIN');
 for(const[k,h]of Object.entries(humans)){
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic D10')",[h.user,h.subject,h.id+'@example.test']);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,$3,'Synthetic D10',true)",[h.id,k==='ai'?null:h.user,k==='ai'?'AI_EMPLOYEE':'HUMAN_USER']);
 }
 for(const[k,role,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['expired','HON_HQ_OWNER',[]],['ai','HON_HQ_OWNER',[]],['delegated','HON_HQ_OWNER',[]]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '2 days',CASE WHEN $4 THEN clock_timestamp()-interval '1 day' ELSE NULL END)",[humans[k].id,role,perms,k==='expired']);
 // Second active principal makes the subject ambiguous/delegated even with an owner grant.
 await admin.query("INSERT INTO hon.principals(user_id,principal_type,display_name,is_active) VALUES($1,'HUMAN_USER','Second principal',true)",[humans.delegated.user]);
 for(const o of orgs){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'D10 disposable','D10 disposable')",[o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'D10 disposable',$3,'America/Los_Angeles')",[o.school,o.id,'d10-'+o.school]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','SUSPENDED',clock_timestamp()-interval '1 day')",[o.id]);
 }
 await admin.query('COMMIT');
 assert.equal((await service.readExceptionPolicy(H('owner'))).effectiveStatus,'ABSENT');
 await nothing(()=>grant(orgs[0]),orgs[0]);passed('absent policy refuses grant atomically, including no request/audit/outbox');
 TERMS=Number((await admin.query('SELECT max(policy_version) v FROM hon.saas_access_policy_terms')).rows[0].v);
 const proposed={expectedRevision:0,decision:'PROPOSED',termsVersion:TERMS,maxDays:3,validFrom:iso(Date.now()-1000),validUntil:iso(Date.now()+DAY),reason:'Synthetic proposed policy is not approval'};
 await decide(proposed);await nothing(()=>grant(orgs[0]),orgs[0]);passed('PROPOSED cannot authorize access');
 const beforeApprove=await Promise.all(orgs.map(ent));
 const approved=(await approval({maxDays:3})).policy;
 assert.deepEqual(await Promise.all(orgs.map(ent)),beforeApprove);await inactive();passed('explicit synthetic approval alone changes no entitlement, subscription, payment or AI ledger');
 const ownerView=await service.readExceptionPolicy(H('owner'));
 assert.equal((await service.readExceptionPolicy(H('operator'))).current.approvalId,approved.approvalId);
 assert.equal(ownerView.effectiveStatus,'ACTIVE');assert.equal(ownerView.current.approvalId,approved.approvalId);
 {const t=(await admin.query('SELECT policy_version v,exception_max_days d FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1')).rows[0];
  const operatorView=await service.readExceptionPolicy(H('operator'));
  assert.deepEqual(ownerView.terms,{policyVersion:Number(t.v),exceptionMaxDays:Number(t.d),exceptionAuthority:'HQ_OWNER'});
  assert.deepEqual(operatorView.terms,ownerView.terms);assert.equal(ownerView.viewer.canDecide,true);assert.equal(operatorView.viewer.canDecide,false);
  passed('0220 read names the current terms the next decision must cite; only the HQ owner is told it may decide');}
 for(const who of ['operator','school','expired','ai','delegated']){
  const n=await footprint();
  await deny(approvalAttempt(who),403,'SAAS_FORBIDDEN');assert.deepEqual(await footprint(),n);
  await nothing(()=>grant(orgs[0],input(orgs[0]),K(),who),orgs[0],403,'SAAS_FORBIDDEN');
 }
 passed('operator, school, expired, AI and ambiguous human cannot approve or grant; no writes');
 // A policy decision waiting on IAM must observe a concurrent authority revocation before writing.
 const policyAttempt={expectedRevision:approved.revision,decision:'APPROVED',termsVersion:TERMS,maxDays:3,
  validFrom:iso(Date.now()-1000),validUntil:iso(Date.now()+DAY),reason:'Synthetic approval authority lock regression',confirmation:'APPROVE_ACCESS_EXCEPTION_POLICY_ONLY'};
 const waitBehindAdmin=async()=>{const pid=(await row('SELECT pg_backend_pid() p')).p;
  for(const end=Date.now()+5000;Date.now()<end;await sleep(10))if((await row('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) b',[pid])).b)return;
  throw Error('Expected policy command to wait behind the actual authority/policy lock');};
 await admin.query('UPDATE hon.hq_operator_grants SET effective_until=NULL WHERE principal_id=$1',[humans.expired.id]);
 let beforeDenied=await footprint(),beforeDeniedEnt=await Promise.all(orgs.map(ent));
 await admin.query('BEGIN');await admin.query('UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1',[humans.expired.id]);
 let pending=settled(decide(policyAttempt,K(),'expired'));await waitBehindAdmin();await admin.query('COMMIT');
 let denied=await pending;assert(denied.error);assert.equal(denied.error.getStatus(),403);assert.deepEqual(await footprint(),beforeDenied);assert.deepEqual(await Promise.all(orgs.map(ent)),beforeDeniedEnt);
 passed('policy approval waiting on IAM loses revoked authority and commits no claim/evidence/access');
 // Authority can also lapse by the clock while waiting on policy serialization.
 await admin.query("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp()+interval '1800 milliseconds' WHERE principal_id=$1",[humans.expired.id]);
 beforeDenied=await footprint();await admin.query('BEGIN');await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('saas.access.exception.policy',0))");
 pending=settled(decide(policyAttempt,K(),'expired'));await waitBehindAdmin();await sleep(2000);await admin.query('COMMIT');
 denied=await pending;assert(denied.error);assert.equal(denied.error.getStatus(),403);assert.deepEqual(await footprint(),beforeDenied);assert.deepEqual(await Promise.all(orgs.map(ent)),beforeDeniedEnt);
 passed('policy approval rechecks owner clock expiry after a real policy-lock wait');

 await nothing(()=>grant(orgs[0],input(orgs[0],{schoolId:orgs[1].school})),orgs[0],404,'SAAS_UNAVAILABLE');
 await nothing(()=>grant(orgs[0],input(orgs[0],{expiresAt:iso(Date.now()+4*DAY)})),orgs[0],422,'SAAS_EXCEPTION_TOO_LONG');passed('exact school and approved duration enforced by database');
 const body=input(orgs[0]),key=K(),receipt=await grant(orgs[0],body,key);
 assert.deepEqual(receipt.exception.governingPolicy,{approvalId:approved.approvalId,revision:approved.revision,termsVersion:TERMS,maxDays:3});
 assert.equal(receipt.exception.maxDays,3);assert.equal((await grant(orgs[0],body,key)).replayed,true);
 await deny(grant(orgs[0],{...body,reason:'Changed request under existing key'},key),409,'IDEMPOTENCY_KEY_REUSED');passed('immutable governing binding, approved limit, exact replay and changed-key refusal');
 const current=(await service.readExceptionPolicy(H('owner'))).current;
 const withdraw={expectedRevision:current.revision,decision:'WITHDRAWN',reason:'Synthetic withdrawal blocks only new grants'};
 const wKey=K();await decide(withdraw,wKey);assert.equal((await decide(withdraw,wKey)).replayed,true);
 await nothing(()=>grant(orgs[1]),orgs[1]);
 const nReplay=await footprint();assert.equal((await grant(orgs[0],body,key)).replayed,true);assert.deepEqual(await footprint(),nReplay);
 await service.revokeAccessException(H('owner'),receipt.exception.exceptionId,{reason:'Synthetic revocation without approval'},K());
 await nothing(()=>grant(orgs[0],input(orgs[0],{expectedEntitlementVersion:3})),orgs[0]);passed('withdrawal blocks renewal, preserves historical replay and allows revoke');
 await approval();await decide({expectedRevision:(await service.readExceptionPolicy(H('owner'))).current.revision,decision:'REVOKED',reason:'Synthetic policy revocation for proof'});
 await nothing(()=>grant(orgs[1]),orgs[1]);passed('revoked policy refuses new grants');
 await approval();
 const rev=(await service.readExceptionPolicy(H('owner'))).current.revision;
 await decide({...proposed,expectedRevision:rev});await nothing(()=>grant(orgs[1]),orgs[1]);passed('superseding PROPOSED decision never falls back to old approval');
 await approval({validFrom:iso(Date.now()+DAY),validUntil:iso(Date.now()+2*DAY)});await nothing(()=>grant(orgs[1]),orgs[1]);passed('future approval cannot authorize early grants');
 await approval({validUntil:iso(Date.now()+1200)});await sleep(1400);await nothing(()=>grant(orgs[1]),orgs[1]);assert.equal((await service.readExceptionPolicy(H('owner'))).effectiveStatus,'EXPIRED');passed('expired approval refuses new grants');
 await approval({validUntil:iso(Date.now()+1400)});
 const beforeExpiry=await footprint(),beforeEnt=await ent(orgs[1]);await a.query('BEGIN');await sqlGrant(a,orgs[1]);await sleep(1600);
 await sqlDeny(a.query('COMMIT'),'23514');assert.deepEqual(await footprint(),beforeExpiry);assert.deepEqual(await ent(orgs[1]),beforeEnt);passed('approval expiring before transaction commit rolls back entitlement and all evidence');
 await approval();
 // Arrival A: policy withdrawal already holds the policy lock. Grant must wait, then refuse after commit.
 await a.query('BEGIN');const revision=(await service.readExceptionPolicy(H('owner'))).current.revision;
 await sqlDecision(a,{expectedRevision:revision,decision:'WITHDRAWN',reason:'Synthetic concurrent withdrawal first'});
 const pidB=await waitBlocked(b),beforeRace=await footprint(),entRace=await ent(orgs[2]);
 const loses=settled(sqlGrant(b,orgs[2]));await waits(pidB);await a.query('COMMIT');const lost=await loses;
 assert.equal(lost.error?.message,'SAAS_EXCEPTION_POLICY_REQUIRED');assert.deepEqual(await ent(orgs[2]),entRace);
 assert.equal((await footprint()).saas_requests,beforeRace.saas_requests+1,'only withdrawal recorded');passed('withdrawal-first real lock race cannot authorize stale grant');
 await approval();
 // Arrival B: grant already holds policy lock. Withdrawal waits; the grant commits under its then-valid approval.
 await a.query('BEGIN');await sqlGrant(a,orgs[3]);
 const revision2=(await service.readExceptionPolicy(H('owner'))).current.revision;
 const withdrawLater=settled(sqlDecision(b,{expectedRevision:revision2,decision:'WITHDRAWN',reason:'Synthetic concurrent withdrawal second'}));
 await waits(pidB);await a.query('COMMIT');assert.ok((await withdrawLater).value);assert.equal((await ent(orgs[3])).status,'ACTIVE');
 await nothing(()=>grant(orgs[4]),orgs[4]);passed('grant-first commits once; later withdrawal prevents all subsequent grants without deadlock');
 await approval();
 // Competing policy changes share one expected revision. Exactly one may win and the loser leaves no claim.
 const revision3=(await service.readExceptionPolicy(H('owner'))).current.revision;
 const changes=await Promise.all([a,b].map(c=>settled(sqlDecision(c,{expectedRevision:revision3,decision:'WITHDRAWN',reason:'Synthetic competing decision revision'}))));
 assert.equal(changes.filter(x=>x.value).length,1);assert.equal(changes.find(x=>x.error).error.message,'SAAS_VERSION_CONFLICT');passed('concurrent expected-revision decisions cannot create split policy heads');
 await approval();
 // Non-default snapshots must not hide a newer append-only policy head after waiting.
 for(const isolation of ['REPEATABLE READ','SERIALIZABLE']){
  await a.query('BEGIN ISOLATION LEVEL '+isolation);
  await sqlDeny(sqlGrant(a,orgs[6]),'22023');await a.query('ROLLBACK');
  await a.query('BEGIN ISOLATION LEVEL '+isolation);
  await sqlDeny(sqlDecision(a,{expectedRevision:0,decision:'REVOKED',reason:'Synthetic unsupported snapshot'}),'22023');await a.query('ROLLBACK');
 }
 passed('non-default snapshot isolation fails closed instead of authorizing a stale policy');
 for(const table of ['saas_exception_policy_decisions','saas_access_exceptions','organization_entitlements']){
  await sqlDeny(b.query(`SELECT * FROM hon.${table}`),'42501');
  await sqlDeny(b.query(`UPDATE hon.${table} SET ${table==='organization_entitlements'?'version=version':'id=id'}`),'42501');
 }
 await sqlDeny(b.query('SELECT hon.saas_require_exception_policy()'),'42501');
 for(const setting of ['hon.exception_policy_approved','hon.saas_owner_override'])await b.query('SELECT set_config($1,$2,false)',[setting,'true']);
 await sqlDeny(b.query('DELETE FROM hon.saas_exception_policy_decisions'),'42501');
 await sqlDeny(admin.query('UPDATE hon.saas_exception_policy_decisions SET max_days=1'),'42501');
 await sqlDeny(admin.query('TRUNCATE hon.saas_exception_policy_decisions CASCADE'),'42501');passed('forced RLS, private helpers, immutable history and no setting-based authority bypass');
 // Cleanup remains allowed with no valid policy. It closes only lapsed exceptions, not a still-live one.
 await approval({maxDays:1});const short=await grant(orgs[5],input(orgs[5],{expiresAt:iso(Date.now()+1200)}));
 await decide({expectedRevision:(await service.readExceptionPolicy(H('owner'))).current.revision,decision:'WITHDRAWN',reason:'Synthetic cleanup without valid approval'});await sleep(1400);
 const closed=await service.closeExpiredAccessExceptions(H('operator'),{},K());assert(closed.closed.some(x=>x.exceptionId===short.exception.exceptionId));
 assert.equal((await ent(orgs[5])).status,'SUSPENDED');assert.equal((await ent(orgs[3])).status,'ACTIVE');passed('expiry cleanup survives policy withdrawal and never closes live exceptions');
 await verifySaasBillingSecurity(admin,'hon_champions_runtime');await inactive();
 assert.deepEqual((await admin.query("SELECT to_jsonb(t) x FROM hon.saas_access_policy_terms t UNION ALL SELECT to_jsonb(r) FROM hon.saas_policy_records r WHERE policy_code='PAID_ACCESS'")).rows,paidTerms);
 assert.equal((await row('SELECT count(*)::int n FROM hon.saas_subscriptions WHERE organization_id=ANY($1::uuid[])',[orgs.map(o=>o.id)])).n,0);
 passed('full PAID_ACCESS terms still PROPOSED, programs inactive, no subscriptions/AI effects; security registry intact');
 console.log(`PASS: D10 ${groups} scenario groups; real runtime PostgreSQL commands, synthetic exception-only decisions, two actual lock arrival orders; no provider calls.`);
}finally{
 await Promise.all([a.query('ROLLBACK'),b.query('ROLLBACK')]);
 try{await cleanup();await inactive();assert.equal((await row('SELECT count(*)::int n FROM hon.saas_exception_policy_decisions')).n,0);}finally{await Promise.allSettled([admin.end(),a.end(),b.end()]);}
}
function approvalAttempt(who){return decide({expectedRevision:2,decision:'APPROVED',termsVersion:TERMS,maxDays:3,validFrom:iso(Date.now()-1000),validUntil:iso(Date.now()+DAY),reason:'Unauthorized synthetic approval attempt',confirmation:'APPROVE_ACCESS_EXCEPTION_POLICY_ONLY'},K(),who);}
