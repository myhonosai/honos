import { syntheticExceptionPolicy } from './exception-policy-fixture.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// B-HQ-1 HQ access overview (0219 proposed) integrity proof, TEST MODE, disposable database only. It proves: only a current HQ
// owner or an HQ operator with hq.billing.manage reads it (support, other operators, school owners, lapsed owners and unknown
// subjects are refused); the restricted runtime can execute the read but neither helper; each organization's access status,
// open exception, subscription and owner-invitation status match the facts; the advisory exception-grant
// eligibility agrees with what hon.grant_saas_access_exception then actually does (grant succeeds exactly when eligible, and
// an ineligible organization is refused with the matching code); the policy-not-ready state is shown; paging walks every
// organization once in order and the summary matches; the status filter is exact; the read writes nothing and never
// returns an invitation email.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const contracts=await import('@hon/contracts');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),access=new SaasSchoolBillingService(billing);
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const saasTables=['saas_access_exceptions','saas_exception_policy_decisions','saas_access_transitions','saas_access_states','saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions',
 'saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions',
 'saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions',
 'saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),HOUR=3600_000,DAY=24*HOUR;
// NEW: provisioned the D9 way (SUSPENDED, no access). LG: legacy customer (ACTIVE entitlement). SUB: suspended, holds a
// subscription. AW: awaiting its first payment. SCH: receives a scheduled exception. OFF:
// suspended organization status. INV: suspended, pending owner invitation.
const O=Object.fromEntries(['NEW','LG','SUB','AW','SCH','OFF','INV'].map(k=>[k,{id:randomUUID(),school:randomUUID(),role:randomUUID()}]));
const humans=Object.fromEntries(['owner','exowner','operator','onboarder','support','schoolOwner','stranger'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`hqao-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  const all=[...saasTables,'saas_credit_program','saas_reward_fulfillment','saas_payment_program','school_owner_invitations'];
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of saasTables)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query("UPDATE hon.saas_credit_program SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query("UPDATE hon.saas_reward_fulfillment SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query("UPDATE hon.saas_payment_program SET status='DISABLED',provider=NULL,test_tax_reference=NULL,authorization_reference=NULL,version=1,changed_by_principal_id=NULL");
  const orgs=Object.values(O).map(o=>o.id);
  await admin.query('DELETE FROM hon.school_owner_invitations WHERE organization_id=ANY($1::uuid[])',[orgs]);
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
async function withoutGuards(tables,sqls){
 await admin.query('BEGIN');
 try{for(const t of tables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);for(const[sql,params]of sqls)await admin.query(sql,params);
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);await admin.query('COMMIT');}
 catch(e){await admin.query('ROLLBACK');throw e;}
}
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const read=(who,q={})=>access.readAccessOverview(H(who),q);
// Walks every page (limit 1..100) and returns all rows in order.
async function walk(who,limit,status){
 const out=[];let cursor;let page;
 do{page=await read(who,{limit:String(limit),...(status?{status}:{}),...(cursor?{cursor:contracts.encodeSaasAccessOverviewCursor(cursor)}:{})});
  out.push(...page.organizations);cursor=page.nextCursor;}while(cursor);
 return {rows:out,last:page};
}
const mine=async who=>{const {rows}=await walk(who,100);return Object.fromEntries(Object.entries(O).map(([k,o])=>[k,rows.find(r=>r.organizationId===o.id)]));};
const writes=async()=>row(`SELECT (SELECT count(*) FROM hon.saas_audit)::int a,(SELECT count(*) FROM hon.saas_requests)::int r,(SELECT count(*) FROM hon.saas_outbox)::int o,
 (SELECT coalesce(sum(version),0) FROM hon.organization_entitlements)::int v,(SELECT count(*) FROM hon.saas_access_exceptions)::int x`);
const grantInput=(k,patch={})=>({schoolId:O[k].school,purpose:'INTERNAL_TESTING',reason:'Fixture HQ access overview check',scopeTier:'COMPLETE',
 startsAt:iso(Date.now()),expiresAt:iso(Date.now()+30*DAY),expectedEntitlementVersion:1,...patch});

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- 0. posture ----------
 for(const[sig,allowed]of [['read_saas_access_overview_from_hq(text,text,timestamptz,uuid,integer)',true],['saas_access_overview_row(uuid,boolean)',false],['saas_exception_policy_ready()',false]])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
 assert.deepEqual(await row("SELECT prosecdef d,provolatile v,proconfig c FROM pg_proc WHERE oid='hon.read_saas_access_overview_from_hq(text,text,timestamptz,uuid,integer)'::regprocedure"),
  {d:true,v:'v',c:['search_path=pg_catalog, hon']});
 await cleanup();

 // ---------- fixture ----------
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[who,hqRole,perms,until]of [['owner','HON_HQ_OWNER',[],null],['exowner','HON_HQ_OWNER',[],'1 minute'],['operator','HON_HQ_OPERATOR',['hq.billing.manage'],null],
  ['onboarder','HON_HQ_OPERATOR',['hq.onboarding.manage','hq.dashboard.view'],null],['support','HON_HQ_SUPPORT',['hq.billing.manage'],null]])
  await admin.query(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',${until?`clock_timestamp()-interval '${until}'`:'NULL'})`,[humans[who].id,hqRole,perms]);
 for(const[k,o]of Object.entries(O)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,$2,$2,$3,clock_timestamp())",[o.id,`HQAO Fixture Dojo ${k}`,k==='OFF'?'SUSPENDED':'ACTIVE']);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE',$2,clock_timestamp()-interval '90 days')",[o.id,k==='LG'?'ACTIVE':'SUSPENDED']);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'America/New_York')",[o.school,o.id,`HQAO School ${k}`]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[o.role,o.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[o.role,o.id]);
 }
 // The school owner holds every permission at NEW: still never an HQ reader.
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",
  [O.NEW.id,O.NEW.school,humans.schoolOwner.id,O.NEW.role]);
 await admin.query('COMMIT');
 await withoutGuards(['saas_subscriptions','saas_access_states'],[
  ["INSERT INTO hon.saas_subscriptions(organization_id,source,plan_code,entitlement_tier,billing_interval,entitlement_version_at_record,status,status_reason,version,created_by_principal_id,created_at,updated_at) VALUES($1,'LEGACY_ENTITLEMENT','CORE','CORE','NONE',1,'PENDING_ACTIVATION','RECORDED',1,$2,clock_timestamp(),clock_timestamp())",[O.SUB.id,humans.owner.id]],
  ["INSERT INTO hon.saas_access_states(organization_id,state,reason,version,changed_by_principal_id,created_at,updated_at) VALUES($1,'AWAITING_FIRST_PAYMENT','AWAITING_INITIAL_PAYMENT',1,$2,clock_timestamp(),clock_timestamp())",[O.AW.id,humans.owner.id]]]);
 await admin.query("INSERT INTO hon.school_owner_invitations(organization_id,school_id,email,token_hash,created_by,created_at,expires_at,status) VALUES($1,$2,'invited-owner@example.test',$3,$4,now(),now()+interval '6 days','PENDING')",
  [O.INV.id,O.INV.school,'a'.repeat(64),humans.owner.id]);

 // ---------- 1. authority ----------
 for(const who of ['support','onboarder','schoolOwner','exowner','stranger'])await deny(read(who),403,'SAAS_FORBIDDEN');
 await deny(access.readAccessOverview('hqao-unknown-'+randomUUID(),{}),403,'SAAS_FORBIDDEN');
 for(const args of [[H('owner'),null,null,null,0],[H('owner'),null,null,null,101],[H('owner'),'SUSPENDED',null,null,10],[H('owner'),null,new Date(),null,10],[H('owner'),null,null,randomUUID(),10]])
  await sqlDeny(restricted.query('SELECT hon.read_saas_access_overview_from_hq($1,$2,$3,$4,$5)',args),'22023');
 await sqlDeny(restricted.query('SELECT hon.saas_access_overview_row($1,true)',[O.NEW.id]),'42501');
 await deny(access.readAccessOverview(H('owner'),{organizationId:O.NEW.id}),400,'INVALID_SAAS_INPUT');

 // ---------- 2. before the exception policy is approved ----------
 const before=await writes();
 const unready=await read('owner');
 assert.deepEqual(unready.exceptionPolicy,{ready:false,maxDays:null,validUntil:null,maxScheduleAheadDays:30});
 assert.equal(unready.paidAccessProgram,'INACTIVE');
 let m=await mine('owner');
 assert.deepEqual(m.NEW.exceptionGrant,{eligible:false,blockers:['EXCEPTION_POLICY_REQUIRED'],expectedEntitlementVersion:1});
 await assert.rejects(access.grantAccessException(H('owner'),O.NEW.id,grantInput('NEW'),K()),e=>{assert.equal(e.getResponse().code,'SAAS_EXCEPTION_POLICY_REQUIRED');return true;});

 await syntheticExceptionPolicy(admin,access,H('owner'));
 const afterPolicy=await writes();

 // ---------- 3. statuses, blockers and facts ----------
 const ownerView=await read('owner'),opView=await read('operator');
 assert.equal(ownerView.viewer.canGrantAndRevokeExceptions,true);
 assert.equal(opView.viewer.canGrantAndRevokeExceptions,false,'an operator reads but never grants (D9)');
 assert.deepEqual({...opView,viewer:null,asOf:null},{...ownerView,viewer:null,asOf:null},'owner and operator see the same facts');
 assert.equal(ownerView.exceptionPolicy.ready,true); assert.equal(ownerView.exceptionPolicy.maxDays,90);
 m=await mine('owner');
 const expect={NEW:['NO_ACCESS',[]],LG:['PROVISIONED_ACCESS',['ENTITLEMENT_IN_EFFECT']],SUB:['NO_ACCESS',['SUBSCRIPTION_EXISTS']],AW:['AWAITING_FIRST_PAYMENT',['ACCESS_STATE_EXISTS']],SCH:['NO_ACCESS',[]],OFF:['NO_ACCESS',['ORGANIZATION_NOT_ACTIVE']],INV:['NO_ACCESS',[]]};
 for(const[k,[status,blockers]]of Object.entries(expect)){
  assert.equal(m[k].accessStatus,status,k);
  assert.deepEqual(m[k].exceptionGrant,{eligible:blockers.length===0,blockers,expectedEntitlementVersion:1},k);
  assert.deepEqual(m[k].schools,[{schoolId:O[k].school,schoolDisplayName:`HQAO School ${k}`,schoolStatus:'ACTIVE'}],k);
  assert.equal(m[k].schoolCount,1);
 }
 assert.equal(m.AW.accessState,'AWAITING_FIRST_PAYMENT'); assert.equal(m.NEW.accessState,'PROVISIONED');
 assert.deepEqual({...m.SUB.subscription,subscriptionId:null},{subscriptionId:null,status:'PENDING_ACTIVATION',planCode:'CORE',billingInterval:'NONE'});
 assert.equal(m.NEW.openCheckout,false); assert.equal(m.SUB.openCheckout,false);
 assert.equal(m.INV.ownerOnboarding.status,'PENDING'); assert.equal(m.NEW.ownerOnboarding.status,'NOT_INVITED');
 assert(!JSON.stringify(ownerView).includes('invited-owner@example.test')&&!JSON.stringify(ownerView).includes('a'.repeat(64)),'no invitation email or token');
 assert.deepEqual(await writes(),afterPolicy,'reads write nothing');
 assert.deepEqual(afterPolicy.v,before.v,'no entitlement changed');

 // ---------- 4. the advisory eligibility agrees with the command ----------
 for(const[k,code]of [['LG','SAAS_ENTITLEMENT_IN_EFFECT'],['SUB','SAAS_SUBSCRIPTION_EXISTS'],['AW','SAAS_ACCESS_STATE_EXISTS'],['OFF','SAAS_UNAVAILABLE']])
  await assert.rejects(access.grantAccessException(H('owner'),O[k].id,grantInput(k),K()),e=>{assert.equal(e.getResponse().code,code,k);return true;});
 await deny(access.grantAccessException(H('operator'),O.NEW.id,grantInput('NEW'),K()),403,'SAAS_FORBIDDEN');
 const g=await access.grantAccessException(H('owner'),O.NEW.id,grantInput('NEW',{expectedEntitlementVersion:m.NEW.exceptionGrant.expectedEntitlementVersion}),K());
 const s=await access.grantAccessException(H('owner'),O.SCH.id,grantInput('SCH',{startsAt:iso(Date.now()+2*DAY),expiresAt:iso(Date.now()+20*DAY)}),K());
 m=await mine('owner');
 assert.equal(m.NEW.accessStatus,'EXCEPTION_IN_EFFECT');
 assert.deepEqual(m.NEW.currentException,{exceptionId:g.exception.exceptionId,schoolId:O.NEW.school,purpose:'INTERNAL_TESTING',scopeTier:'COMPLETE',
  startsAt:g.exception.startsAt,expiresAt:g.exception.expiresAt,lifecycle:'IN_EFFECT',revocable:true});
 assert.deepEqual(m.NEW.exceptionGrant,{eligible:false,blockers:['ACCESS_EXCEPTION_ACTIVE','ENTITLEMENT_IN_EFFECT'],expectedEntitlementVersion:2});
 assert.equal(m.SCH.accessStatus,'EXCEPTION_SCHEDULED'); assert.equal(m.SCH.currentException.exceptionId,s.exception.exceptionId);
 assert.equal(m.SCH.currentException.lifecycle,'SCHEDULED'); assert.deepEqual(m.SCH.exceptionGrant.blockers,['ACCESS_EXCEPTION_ACTIVE']);
 await assert.rejects(access.grantAccessException(H('owner'),O.SCH.id,grantInput('SCH',{expectedEntitlementVersion:2}),K()),e=>{assert.equal(e.getResponse().code,'SAAS_ACCESS_EXCEPTION_ACTIVE');return true;});
 // Revoking returns the school to NO_ACCESS and eligible at the next entitlement version.
 await access.revokeAccessException(H('owner'),g.exception.exceptionId,{reason:'Fixture overview revocation check'},K());
 m=await mine('owner');
 assert.equal(m.NEW.accessStatus,'NO_ACCESS'); assert.equal(m.NEW.currentException,null);
 assert.deepEqual(m.NEW.exceptionGrant,{eligible:true,blockers:[],expectedEntitlementVersion:3});

 // ---------- 5. paging, order, summary and filter ----------
 const total=(await row('SELECT count(*)::int n FROM hon.organizations')).n;
 const all=await walk('owner',100),ones=await walk('operator',1);
 assert.equal(all.rows.length,total); assert.equal(all.last.summary.total,total);
 assert.deepEqual(ones.rows.map(r=>r.organizationId),all.rows.map(r=>r.organizationId),'limit 1 walks the same order');
 assert.equal(new Set(all.rows.map(r=>r.organizationId)).size,total,'no duplicates');
 for(const st of contracts.SAAS_ACCESS_OVERVIEW_STATUSES){
  assert.equal(all.rows.filter(r=>r.accessStatus===st).length,all.last.summary[st],st);
  const f=await walk('owner',2,st);
  assert(f.rows.every(r=>r.accessStatus===st),st);
  assert.deepEqual(f.rows.map(r=>r.organizationId),all.rows.filter(r=>r.accessStatus===st).map(r=>r.organizationId),st);
 }
 console.log(`HQ access overview proof passed (${total} organizations; ${Object.keys(O).length} fixtures; statuses, eligibility vs command, paging, filter, no writes).`);
}finally{
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy?.()]);}
}
