import { syntheticExceptionPolicy } from './exception-policy-fixture.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertLegacySalesClosed } from './saas-legacy-sales-simulation.mjs';
// HQ-owner access exception hardening (0185, D9 review corrections) integrity proof, TEST MODE, disposable database
// only. It proves: (1) authority holds through the mutation: a revocation (or grant) that waits while the HQ owner's
// authority is revoked or expires by the clock commits nothing (no entitlement change, exception ending, audit, outbox
// or idempotency claim), an authority change that arrives after the command holds its locks is ordered after it with no
// deadlock, and an authorized retry under the same key is a fresh request; (2) closing works through more than 200 open
// exceptions in batches of at most 200 that hold only expired or superseded records, so live exceptions never fill a
// batch, are never closed early, and successive calls make progress, with audit and idempotent replay; (3) Champions
// contest eligibility and the freeze require the entitlement window at evaluation time: an exception school is
// eligible while its exception is in effect, a scheduled or expired one is not (before any cleanup), a contest that
// ends after the expiry freezes it out and never proposes it as a winner, legacy customers stay eligible, and results
// frozen earlier are not recalculated. Paid access stays INACTIVE and no AI credit is granted.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const database=new RuntimeDatabaseService(),access=new SaasSchoolBillingService(new SaasBillingService(database));
const client=url=>new pg.Client({connectionString:url.toString(),ssl:false});
const admin=client(owner),blocker=client(owner),changer=client(owner),restricted=client(runtime);
const saasTables=['saas_access_exceptions','saas_exception_policy_decisions','saas_access_transitions','saas_access_states','saas_outbox','saas_audit','saas_requests'];
const championsTables=['champions_outbox','champions_audit','champions_contest_history','champions_contest_winners','champions_contest_results','champions_contest_pauses',
 'champions_contest_schools','champions_contest_prizes','champions_contests','champions_leaderboard_holds','champions_leaderboard_preferences','champions_reward_history',
 'champions_reward_entries','champions_reward_policies','champions_attribution_history','champions_attributions','champions_requests','champions_referral_codes','champions_policies'];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code,message)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);if(message)assert.equal(e.message,message);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),HOUR=3600_000,DAY=24*HOUR;
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const humans=Object.fromEntries(['owner','operator','ownerR','ownerT','ownerS','ownerG'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`d9h-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
// Organizations: R/T/S/G for the authority races; C* for the champions contest; bulk ones for closing.
const orgs={};
const newOrg=(key,{id=randomUUID(),status='SUSPENDED',tier='COMPLETE'}={})=>orgs[key]={id,school:randomUUID(),status,tier};
async function insertOrgs(list){
 await admin.query(`INSERT INTO hon.organizations(id,legal_name,display_name) SELECT id,'D9H fixture '||id,'D9H fixture' FROM unnest($1::uuid[]) id`,[list.map(o=>o.id)]);
 await admin.query(`INSERT INTO hon.schools(id,organization_id,name,slug,timezone) SELECT s,o,'D9H school','d9h-'||s,'America/New_York' FROM unnest($1::uuid[],$2::uuid[]) x(s,o)`,
  [list.map(o=>o.school),list.map(o=>o.id)]);
 await admin.query(`INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) SELECT o,t::hon.plan_tier,s::hon.membership_status,clock_timestamp()-interval '400 days'
  FROM unnest($1::uuid[],$2::text[],$3::text[]) x(o,t,s)`,[list.map(o=>o.id),list.map(o=>o.tier),list.map(o=>o.status)]);
}
const ent=async o=>row('SELECT tier::text,status::text,version,effective_until FROM hon.organization_entitlements WHERE organization_id=$1',[o]);
const exceptionInput=(o,patch={})=>({schoolId:o.school,purpose:'APPROVED_PILOT',reason:'Fixture pilot for the hardening proof',scopeTier:'COMPLETE',
 startsAt:iso(Date.now()),expiresAt:iso(Date.now()+30*DAY),expectedEntitlementVersion:1,...patch});
const grant=(who,o,patch,key=K())=>access.grantAccessException(H(who),o.id,exceptionInput(o,patch),key);
const settle=p=>p.then(value=>({value}),error=>({error}));
const forbidden=out=>{assert.ok(out.error,'the command must be refused after its authority lapsed');http(403,'SAAS_FORBIDDEN')(out.error);};
async function waitBlockedBy(pid){
 for(const end=Date.now()+5000;Date.now()<end;await sleep(10))
  if((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) b',[pid])).rows[0].b)return;
 throw new Error('Expected a real lock wait');
}
async function waitBlocked(pid){
 for(const end=Date.now()+5000;Date.now()<end;await sleep(10))
  if((await admin.query('SELECT cardinality(pg_blocking_pids($1))>0 b',[pid])).rows[0].b)return;
 throw new Error('Expected the authority change to wait');
}
const holdOrgLock=async o=>{await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('saas.organization:'||$1,0))",[o.id]);
 return (await blocker.query('SELECT pg_backend_pid() p')).rows[0].p;};
// Nothing the refused command could have written exists: entitlement, exception, audit, outbox and the request claim.
async function nothingCommitted(who,key,o,entBefore,exceptionId){
 assert.deepEqual(await ent(o.id),entBefore,'entitlement unchanged');
 if(exceptionId)assert.deepEqual(await row('SELECT status,end_reason FROM hon.saas_access_exceptions WHERE id=$1',[exceptionId]),{status:'GRANTED',end_reason:null},'exception not ended');
 else assert.equal((await row('SELECT count(*)::int n FROM hon.saas_access_exceptions WHERE organization_id=$1',[o.id])).n,0,'no exception recorded');
 assert.equal((await row('SELECT count(*)::int n FROM hon.saas_audit WHERE actor_principal_id=$1',[humans[who].id])).n,0,'no audit');
 assert.equal((await row('SELECT count(*)::int n FROM hon.saas_outbox o JOIN hon.saas_audit a ON a.id=o.audit_id WHERE a.actor_principal_id=$1',[humans[who].id])).n,0,'no outbox');
 assert.equal((await row('SELECT count(*)::int n FROM hon.saas_requests WHERE actor_principal_id=$1 AND idempotency_key=$2',[humans[who].id,key])).n,0,'no request claim');
}
const setAuthority=(who,until)=>admin.query(`UPDATE hon.hq_operator_grants SET effective_until=${until} WHERE principal_id=$1`,[humans[who].id]);
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of [...saasTables,...championsTables]){await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);await admin.query(`DELETE FROM hon.${t}`);await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);}
  const ids=Object.values(orgs).map(o=>o.id).concat(referred);
  for(const t of ['organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[ids]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[ids]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const referred=[];

await Promise.all([admin,blocker,changer,restricted].map(c=>c.connect()));
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 await assertLegacySalesClosed(admin);
 assert.equal((await row('SELECT status FROM hon.saas_access_program')).status,'INACTIVE');
 await cleanup();
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[who,role,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['ownerR','HON_HQ_OWNER',[]],['ownerT','HON_HQ_OWNER',[]],['ownerS','HON_HQ_OWNER',[]],['ownerG','HON_HQ_OWNER',[]]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,role,perms]);
 await admin.query('COMMIT');
 await syntheticExceptionPolicy(admin,access,H('owner'));
 for(const k of ['R','T','S','G'])newOrg(k);
 await insertOrgs(['R','T','S','G'].map(k=>orgs[k]));
 const beforeOthers=(await admin.query('SELECT to_jsonb(e)::text r FROM hon.organization_entitlements e ORDER BY 1')).rows.map(r=>r.r);
 const rv={reason:'Pilot ended; access removed by HQ'};

 // ---------- 1. authority holds through the mutation ----------
 const xR=(await grant('owner',orgs.R)).exception,xT=(await grant('owner',orgs.T)).exception,xS=(await grant('owner',orgs.S)).exception;
 // 1a. Revoked while waiting: the owner's HQ grant is ended (uncommitted) before the revocation starts; the revocation
 // passes its first check, waits on the authority lock, and after the change commits it is refused with nothing written.
 let entBefore=await ent(orgs.R.id);
 await blocker.query('BEGIN');
 const bR=(await blocker.query('SELECT pg_backend_pid() p')).rows[0].p;
 await blocker.query('UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1',[humans.ownerR.id]);
 const kR=K();
 const rR=settle(access.revokeAccessException(H('ownerR'),xR.exceptionId,rv,kR));
 await waitBlockedBy(bR);
 await blocker.query('COMMIT');
 forbidden(await rR);
 await nothingCommitted('ownerR',kR,orgs.R,entBefore,xR.exceptionId);
 await deny(access.revokeAccessException(H('ownerR'),xR.exceptionId,rv,kR),403,'SAAS_FORBIDDEN');
 // An authorized retry under the same key is a fresh request (the refused attempt left no claim), then replays exactly.
 await setAuthority('ownerR','NULL');
 const retried=await access.revokeAccessException(H('ownerR'),xR.exceptionId,rv,kR);
 assert.deepEqual([retried.replayed,retried.exception.lifecycle,retried.exception.endedByPrincipalId,retried.entitlementSuspended],[false,'REVOKED',humans.ownerR.id,true]);
 assert.deepEqual(await access.revokeAccessException(H('ownerR'),xR.exceptionId,rv,kR),{...retried,replayed:true});
 await deny(access.revokeAccessException(H('ownerR'),xR.exceptionId,{reason:'A different reason for the same key'},kR),409,'IDEMPOTENCY_KEY_REUSED');
 // 1b. Expired while waiting: the owner's grant runs out by the clock while the revocation waits on the organization lock.
 entBefore=await ent(orgs.T.id);
 await setAuthority('ownerT',"clock_timestamp()+interval '1500 milliseconds'");
 const bT=await holdOrgLock(orgs.T);
 const kT=K();
 const rT=settle(access.revokeAccessException(H('ownerT'),xT.exceptionId,rv,kT));
 await waitBlockedBy(bT);
 await sleep(1800);
 await blocker.query('COMMIT');
 forbidden(await rT);
 await nothingCommitted('ownerT',kT,orgs.T,entBefore,xT.exceptionId);
 // 1c. The same for a grant: no exception, entitlement change or evidence after the grantor's authority lapsed.
 entBefore=await ent(orgs.G.id);
 await setAuthority('ownerG',"clock_timestamp()+interval '1500 milliseconds'");
 const bG=await holdOrgLock(orgs.G);
 const kG=K();
 const rG=settle(grant('ownerG',orgs.G,{},kG));
 await waitBlockedBy(bG);
 await sleep(1800);
 await blocker.query('COMMIT');
 forbidden(await rG);
 await nothingCommitted('ownerG',kG,orgs.G,entBefore,null);
 // 1d. A change that arrives after the revocation holds its locks waits for it (no deadlock): the revocation commits
 // under authority that was current throughout, then the change applies; a later replay needs current authority.
 const bS=await holdOrgLock(orgs.S);
 const kS=K();
 const rS=settle(access.revokeAccessException(H('ownerS'),xS.exceptionId,rv,kS));
 await waitBlockedBy(bS);
 const cPid=(await changer.query('SELECT pg_backend_pid() p')).rows[0].p;
 const change=settle(changer.query('UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1 RETURNING clock_timestamp() at',[humans.ownerS.id]));
 await waitBlocked(cPid);
 await blocker.query('COMMIT');
 const sOut=await rS,cOut=await change;
 assert.equal(sOut.error,undefined,sOut.error?.stack);assert.equal(cOut.error,undefined,cOut.error?.stack);
 assert.equal(sOut.value.exception.lifecycle,'REVOKED');
 const sAudit=await row("SELECT occurred_at FROM hon.saas_audit WHERE actor_principal_id=$1 AND action_code='saas.access.exception_revoke'",[humans.ownerS.id]);
 assert.ok(sAudit.occurred_at<cOut.value.rows[0].at,'the revocation committed before the authority change applied');
 await deny(access.revokeAccessException(H('ownerS'),xS.exceptionId,rv,kS),403,'SAAS_FORBIDDEN');
 // xT is still open; an authorized owner can still revoke it.
 assert.equal((await access.revokeAccessException(H('owner'),xT.exceptionId,rv,K())).exception.lifecycle,'REVOKED');

 // ---------- 2. closing works through more than 200 open exceptions ----------
 // 215 live (200 in effect, 15 scheduled) whose organization ids sort first, so the previous selection (the first 200
 // open rows by organization) would hold only live exceptions; 235 closable (210 expired, 25 superseded) sort last.
 const lead=c=>c+randomUUID().slice(1);
 const live=[...Array(215)].map((_,i)=>newOrg(`L${i}`,{id:lead('0')})),expired=[...Array(210)].map((_,i)=>newOrg(`E${i}`,{id:lead('f')})),
  superseded=[...Array(25)].map((_,i)=>newOrg(`X${i}`,{id:lead('f')}));
 await insertOrgs([...live,...expired,...superseded]);
 const inBatches=async(list,fn)=>{for(let i=0;i<list.length;i+=10)await Promise.all(list.slice(i,i+10).map(fn));};
 await inBatches(live,(o,j)=>grant('owner',o,live.indexOf(o)>=200?{startsAt:iso(Date.now()+DAY),expiresAt:iso(Date.now()+20*DAY)}:{}));
 await inBatches(superseded,o=>grant('owner',o));
 // An entitlement replaced outside these commands (simulated directly) leaves its exception superseded.
 await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED',version=version+1,updated_at=clock_timestamp() WHERE organization_id=ANY($1::uuid[])",[superseded.map(o=>o.id)]);
 let lastExpiry=0;
 await inBatches(expired,o=>{const e=Date.now()+4000;lastExpiry=Math.max(lastExpiry,e);return grant('owner',o,{expiresAt:iso(e)});});
 await sleep(Math.max(0,lastExpiry-Date.now())+300);
 const liveIds=live.map(o=>o.id),closableIds=[...expired,...superseded].map(o=>o.id);
 assert.equal((await row("SELECT count(*)::int n FROM hon.saas_access_exceptions WHERE status='GRANTED'")).n,450);
 assert.deepEqual((await row("SELECT bool_and(organization_id=ANY($1::uuid[])) a FROM (SELECT organization_id FROM hon.saas_access_exceptions WHERE status='GRANTED' ORDER BY organization_id LIMIT 200) f",[liveIds])).a,true,
  'the previous first-200 selection would have held only live exceptions');
 const liveEnt=(await admin.query('SELECT organization_id,status::text,version FROM hon.organization_entitlements WHERE organization_id=ANY($1::uuid[]) ORDER BY 1',[liveIds])).rows;
 const k1=K();
 const c1=await access.closeExpiredAccessExceptions(H('operator'),{},k1);
 const c2=await access.closeExpiredAccessExceptions(H('owner'),{},K());
 const c3=await access.closeExpiredAccessExceptions(H('operator'),{},K());
 assert.deepEqual([c1.closed.length,c2.closed.length,c3.closed.length],[200,35,0],'successive calls progress through every closable record');
 const all=[...c1.closed,...c2.closed];
 assert.deepEqual(all.map(x=>x.organizationId).sort(),[...closableIds].sort(),'exactly the expired and superseded exceptions closed, each once');
 const byOrg=Object.fromEntries(all.map(x=>[x.organizationId,x]));
 assert.ok(expired.every(o=>byOrg[o.id].endReason==='EXPIRED'&&byOrg[o.id].endedByPrincipalId!==null));
 assert.ok(superseded.every(o=>byOrg[o.id].endReason==='SUPERSEDED'));
 assert.deepEqual((await row("SELECT count(*)::int n FROM hon.organization_entitlements WHERE organization_id=ANY($1::uuid[]) AND status='SUSPENDED' AND version=3",[expired.map(o=>o.id)])).n,210,'lapsed entitlements suspended');
 assert.deepEqual((await row("SELECT count(*)::int n FROM hon.organization_entitlements WHERE organization_id=ANY($1::uuid[]) AND status='SUSPENDED' AND version=3",[superseded.map(o=>o.id)])).n,25,'replaced entitlements left as they were');
 assert.equal((await row("SELECT count(*)::int n FROM hon.saas_access_exceptions WHERE status='GRANTED' AND organization_id=ANY($1::uuid[])",[liveIds])).n,215,'no live exception closed early');
 assert.deepEqual((await admin.query('SELECT organization_id,status::text,version FROM hon.organization_entitlements WHERE organization_id=ANY($1::uuid[]) ORDER BY 1',[liveIds])).rows,liveEnt);
 assert.deepEqual((await admin.query("SELECT (next_state->>'closed')::int n FROM hon.saas_audit WHERE action_code='saas.access.exception_close' ORDER BY occurred_at")).rows.map(r=>r.n),[200,35,0],'one audit record per call');
 assert.equal((await row("SELECT count(*)::int n FROM hon.saas_outbox WHERE event_type='saas.access.exceptions_closed'")).n,3);
 const replay1=await access.closeExpiredAccessExceptions(H('operator'),{},k1);
 assert.deepEqual(replay1,{...c1,replayed:true},'idempotent replay');

 // ---------- 3. Champions contest eligibility uses the entitlement window ----------
 // CX: exception that expires during the contest; CA: exception in effect throughout; CS: scheduled exception;
 // CL: a legacy customer (ACTIVE, no window).
 for(const k of ['CX','CA','CS'])newOrg(k);
 newOrg('CL',{status:'ACTIVE'});
 await insertOrgs(['CX','CA','CS','CL'].map(k=>orgs[k]));
 const policy=randomUUID();
 await admin.query('BEGIN');
 await admin.query(`INSERT INTO hon.champions_policies(id,policy_version,status,attribution_window_days,refund_window_days,minimum_paid_days,minimum_paid_invoices,payment_verification_source,
  welcome_credit_minor,terms_reference,created_by_principal_id,published_by_principal_id,published_at) VALUES($1,1,'PUBLISHED',90,30,30,1,'HQ_OWNER_ATTESTATION',10000,'Fixture terms',$2,$2,clock_timestamp())`,[policy,humans.owner.id]);
 const NOW=Date.now();
 for(const[n,[k,count]]of [['CX',5],['CA',3],['CS',4],['CL',4]].entries()){
  const o=orgs[k];o.code=randomUUID();
  await admin.query("INSERT INTO hon.champions_referral_codes(id,organization_id,school_id,code,created_by_principal_id,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '300 days')",[o.code,o.id,o.school,`HARDN${'ABCD'[n]}2345`,humans.owner.id]);
  for(let i=0;i<count;i++){
   const r=randomUUID(),c=NOW-9*DAY+(n*10+i)*HOUR,q=NOW-8*DAY+(n*10+i)*HOUR;referred.push(r);
   await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,created_at) VALUES($1,'Referred fixture','Referred Fixture Dojo',$2)",[r,new Date(c-DAY)]);
   await admin.query(`INSERT INTO hon.champions_attributions(id,referral_code_id,referrer_organization_id,referrer_school_id,referred_organization_id,state,state_reason,version,
    captured_by_principal_id,captured_at,qualified_policy_id,qualified_at,qualification_evidence,decided_by_principal_id,decided_at) VALUES($1,$2,$3,$4,$5,'QUALIFIED','QUALIFICATION_VERIFIED',2,$6,$7,$8,$9,$10,$6,$9)`,
    [randomUUID(),o.code,o.id,o.school,r,humans.owner.id,new Date(c),policy,new Date(q),{source:'HQ_OWNER_ATTESTATION'}]);
  }
 }
 await admin.query('COMMIT');
 const cmd=async(contest,p)=>(await restricted.query('SELECT hon.command_champions_contest($1,$2,$3::jsonb,$4,$5,$6) r',[H('owner'),contest,JSON.stringify(p),K(),K(),K()])).rows[0].r;
 const detail=async contest=>(await restricted.query('SELECT hon.read_champions_contest_from_hq($1,$2) r',[H('owner'),contest])).rows[0].r;
 const config=endsAt=>({name:'Hardening Referral Cup',description:'Fixture contest for the entitlement window proof.',termsReference:'Fixture contest terms v1 (not legal terms)',
  startsAt:iso(NOW-10*DAY),endsAt:iso(endsAt),countBasis:'CAPTURED_AND_QUALIFIED_IN_WINDOW',minimumQualified:1,tieRule:'OWNER_RESOLVES',
  eligibility:{scope:'ALL_ACTIVE_SCHOOLS',tiers:['CORE','COMPLETE'],schoolIds:[]},budgetMinor:120000,giftCardCompliance:'UNDECIDED',
  prizes:[{placeFrom:1,placeTo:1,kind:'ELECTRONICS',description:'Front-desk tablet',quantity:1,estimatedUnitCostMinor:50000},
   {placeFrom:2,placeTo:3,kind:'AMUSEMENT_TICKETS',description:'Amusement park family ticket pack',quantity:4,estimatedUnitCostMinor:8000}]});
 const start=async endsAt=>{const id=(await cmd(null,{action:'CREATE',...config(endsAt)})).contest.contestId;
  await cmd(id,{action:'SCHEDULE',expectedVersion:1,schoolVisibility:'HIDDEN'});await cmd(id,{action:'ACTIVATE',expectedVersion:2});return id;};
 const earlier=await start(Date.now()+HOUR),contest=await start(Date.now()+7000);
 const contestEnds=Date.now()+7000-50;
 const xX=(await grant('owner',orgs.CX,{expiresAt:iso(Date.now()+3500)})).exception;
 await grant('owner',orgs.CA);
 await grant('owner',orgs.CS,{startsAt:iso(Date.now()+DAY),expiresAt:iso(Date.now()+20*DAY)});
 const standing=(d,k)=>d.standings.find(s=>s.schoolId===orgs[k].school);
 // While the exception is in effect the school is eligible (and leads); a scheduled exception is not yet eligible.
 let d=await detail(contest);
 assert.deepEqual(['CX','CA','CL'].map(k=>[standing(d,k).eligible,standing(d,k).qualifiedReferrals]),[[true,5],[true,3],[true,4]]);
 assert.deepEqual([standing(d,'CX').rank,standing(d,'CS').eligible,standing(d,'CS').ineligibleReason],[1,false,'TIER_NOT_ELIGIBLE'],'future-start window is not eligible');
 // A contest frozen while CX was in effect keeps CX in its results.
 await cmd(earlier,{action:'END',expectedVersion:3});
 const frozenEarlier=JSON.stringify((await detail(earlier)).standings);
 assert.deepEqual([standing(await detail(earlier),'CX').eligible,standing(await detail(earlier),'CX').rank],[true,1]);
 // The exception expires; nobody closes it.
 await sleep(Math.max(0,Date.parse(xX.expiresAt)-Date.now())+200);
 assert.deepEqual(await row('SELECT status FROM hon.saas_access_exceptions WHERE id=$1',[xX.exceptionId]),{status:'GRANTED'},'not yet closed');
 d=await detail(contest);
 assert.deepEqual([standing(d,'CX').eligible,standing(d,'CX').ineligibleReason,standing(d,'CX').rank],[false,'TIER_NOT_ELIGIBLE',null],'expired before cleanup: excluded');
 assert.deepEqual([standing(d,'CL').rank,standing(d,'CA').rank],[1,2],'legitimate customers stay eligible');
 // The contest ends after the expiry: the freeze excludes CX and winner proposals never name it.
 await sleep(Math.max(0,contestEnds-Date.now())+200);
 await cmd(contest,{action:'END',expectedVersion:3});
 const results=(await admin.query('SELECT school_id,eligible,ineligible_reason,standing_position FROM hon.champions_contest_results WHERE contest_id=$1',[contest])).rows;
 const res=k=>results.find(r=>r.school_id===orgs[k].school);
 assert.deepEqual([res('CX').eligible,res('CX').ineligible_reason,res('CX').standing_position],[false,'TIER_NOT_ELIGIBLE',null]);
 assert.deepEqual([res('CS').eligible,res('CL').standing_position,res('CA').standing_position],[false,1,2]);
 await cmd(contest,{action:'PROPOSE_WINNERS',expectedVersion:4});
 const winners=(await detail(contest)).winners;
 assert.deepEqual(winners.map(w=>[w.place,w.schoolId]),[[1,orgs.CL.school],[2,orgs.CA.school]],'no proposal for the expired exception school');
 // Nor can the owner hand a rejected place to it: it is not an eligible frozen result.
 await cmd(contest,{action:'REJECT_WINNER',expectedVersion:5,winnerId:winners[1].winnerId,reasonCode:'INELIGIBLE'});
 await sqlDeny(cmd(contest,{action:'RESOLVE_WINNER',expectedVersion:6,winnerId:winners[1].winnerId,schoolId:orgs.CX.school}),'23514','CHAMPIONS_CONTEST_WINNER_NOT_ELIGIBLE');
 // Historical frozen results are evidence: they are not recalculated after the expiry.
 assert.equal(JSON.stringify((await detail(earlier)).standings),frozenEarlier,'earlier frozen results unchanged');

 // ---------- posture ----------
 const afterOthers=(await admin.query('SELECT to_jsonb(e)::text r FROM hon.organization_entitlements e WHERE NOT (organization_id=ANY($1::uuid[])) ORDER BY 1',[Object.values(orgs).map(o=>o.id)])).rows.map(r=>r.r);
 assert.deepEqual(afterOthers,beforeOthers.filter(r=>!Object.values(orgs).some(o=>r.includes(o.id))),'no other organization touched');
 assert.equal((await row('SELECT count(*)::int n FROM hon.saas_credit_allowances')).n,0,'no AI credits');
 assert.equal((await row('SELECT status FROM hon.saas_access_program')).status,'INACTIVE');
 await assertLegacySalesClosed(admin);
 console.log('PASS: access exception hardening (D9 corrections) — revocations and grants that wait while the HQ owner is revoked or expires commit nothing (no entitlement, ending, audit, outbox or claim), a later authority change waits for the command without deadlock, and authorized same-key retries are fresh then replay exactly; closing works through 450 open exceptions (215 live sorted first) in batches of 200 and 35 without closing a live one, with audit and replay; Champions contest eligibility and the freeze require the entitlement window (in-effect exception eligible, scheduled and expired-before-cleanup excluded, no winner proposal after expiry, legacy customers eligible, earlier frozen results unchanged); paid access INACTIVE, no AI credits.');
}finally{
 await blocker.query('ROLLBACK').catch(()=>{});
 try{await cleanup();}finally{await Promise.allSettled([admin,blocker,changer,restricted].map(c=>c.end()));}
}
