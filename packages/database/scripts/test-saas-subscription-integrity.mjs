import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// HON Subscription Billing B1 (0154) integrity proof through the real API service on a disposable
// database: versioned catalog, owner-only publication, atomic founder inventory, subscription records
// linked to (never writing) organization_entitlements, undecided policies refused, inert evidence.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const contracts=await import('@hon/contracts');
const api=new SaasBillingService(new RuntimeDatabaseService());
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const saasTables=['saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions','saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests','saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions'];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code='42501')=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000;
// O1 Core, O2 Complete, O3 legacy Essential, O4 Core, O5 Core, O6 Complete, O7 no entitlement, O8 suspended entitlement.
const O=Object.fromEntries([1,2,3,4,5,6,7,8].map(n=>[n,{id:randomUUID(),tier:{1:'CORE',2:'COMPLETE',3:'ESSENTIAL',4:'CORE',5:'CORE',6:'COMPLETE',8:'CORE'}[n]??null}]));
const humans=Object.fromEntries(['owner','operator','championsOperator','support','staff'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`saas-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
let commands=0;const ok=async p=>{const r=await p;if(!r.replayed)commands++;return r;};
async function untouched(){const out={};for(const t of ['organization_entitlements','hq_entitlement_requests','billing_accounts','memberships','invoices','membership_payment_schedules','ai_usage_ledger','champions_reward_entries','audit_events','outbox_events'])out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t ORDER BY 1`)).rows.map(r=>r.r);return out;}
async function withoutGuards(table,sql,params=[]){
 await admin.query('BEGIN');
 try{await admin.query(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);await admin.query(sql,params);await admin.query(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);await admin.query('COMMIT');}
 catch(e){await admin.query('ROLLBACK');throw e;}
}
async function rejectedWithoutGuards(table,sql,params=[],code='23514'){
 await admin.query('BEGIN');
 try{await admin.query(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);await sqlDeny(admin.query(sql,params),code);}finally{await admin.query('ROLLBACK');}
}
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of saasTables){await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);}
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of saasTables)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of saasTables){await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);}
  const orgIds=Object.values(O).map(o=>o.id),principalIds=Object.values(humans).map(h=>h.id);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgIds]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
  await admin.query('DELETE FROM hon.schools WHERE organization_id=ANY($1::uuid[])',[orgIds]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgIds]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const approved=()=>structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
const configured=(patch={})=>{const d=approved();d.termsReference='Fixture HON plan terms v1 (not customer terms)';
 d.founderProgram={...d.founderProgram,eligibility:'NO_PRIOR_CATALOG_SUBSCRIPTION',reservationHoldDays:7,opensAt:iso(NOW-HOUR),...patch};return d;};
const offer=(catalog,plan,kind)=>catalog.offers.find(o=>o.planCode===plan&&o.offerKind===kind).offerId;
const cmd=(id,version,action,reasonCode,extra={})=>api.commandSubscription(H('owner'),id,{action,expectedVersion:version,reasonCode,...extra},K());

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- runtime posture ----------
 for(const t of [...saasTables,'saas_policy_decisions'])await sqlDeny(restricted.query(`SELECT * FROM hon.${t}`));
 for(const sig of ['require_saas_hq_actor(text,boolean)','saas_claim_request(uuid,uuid,text,text,uuid,uuid)','saas_founder_inventory(timestamptz)','saas_plan_capabilities(text)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);

 // ---------- fixture ----------
 await cleanup();
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[n,o]of Object.entries(O)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o.id,`Subscription Fixture Dojo ${n}`]);
  if(o.tier)await admin.query(`INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '30 days')`,[o.id,o.tier,n==='8'?'SUSPENDED':'ACTIVE']);
 }
 const school=randomUUID(),role=randomUUID();
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Fixture School',$1::text,'America/New_York')",[school,O[1].id]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'OWNER_STAFF','Fixture role')",[role,O[1].id]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[O[1].id,school,humans.staff.id,role]);
 for(const[who,hqRole,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['championsOperator','HON_HQ_OPERATOR',['hq.champions.manage','hq.entitlement.manage']],['support','HON_HQ_SUPPORT',['hq.billing.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,hqRole,perms]);
 await admin.query('COMMIT');
 const before=await untouched();

 // ---------- 1. authority and initial state ----------
 const initial=await api.readCatalog(H('operator'));
 assert.equal(initial.published,null);assert.deepEqual(initial.drafts,[]);
 assert.deepEqual(initial.policies.map(p=>p.policyCode),[...contracts.SAAS_POLICY_CODES]);assert.ok(initial.policies.every(p=>p.actionsEnabled===false));assert.ok(initial.policies.some(p=>p.status==='DECIDED'));
 assert.equal(initial.founderInventory.status,'NOT_PUBLISHED');assert.equal(initial.founderInventory.remaining.total,null);
 assert.equal(initial.chargesEnabled,false);assert.equal(initial.creditGrantsEnabled,false);assert.equal(initial.paymentProvider,'NOT_CONFIGURED');
 await api.readCatalog(H('owner'));
 for(const who of ['championsOperator','support','staff'])await deny(api.readCatalog(H(who)),403,'SAAS_FORBIDDEN');
 await deny(api.readCatalog('unknown-subject'),403,'SAAS_FORBIDDEN');
 await restricted.query('BEGIN');await restricted.query("SELECT set_config('app.hon_organization_id',$1,true)",[O[1].id]);
 await sqlDeny(restricted.query('SELECT hon.read_saas_catalog_from_hq($1)',[H('owner')]));await restricted.query('ROLLBACK');

 // ---------- 2. drafts ----------
 const annual=approved();annual.offers.splice(5,1,{planCode:'CORE',offerKind:'REGULAR_ANNUAL',priceMinor:149000});
 await deny(api.createCatalogDraft(H('owner'),annual,K()),422,'SAAS_POLICY_UNDECIDED');
 for(const bad of [{...approved(),plans:[...approved().plans,{planCode:'ESSENTIAL',displayName:'Essential',plannedMonthlyPremiumCredits:null}]},
  {...approved(),offers:[{planCode:'ESSENTIAL',offerKind:'REGULAR_MONTHLY',priceMinor:9900}]},{...approved(),chargesEnabled:true},
  {...approved(),founderProgram:{...approved().founderProgram,lifetimeLimit:60}},{...approved(),offers:[...approved().offers,approved().offers[0]]}])
  await deny(api.createCatalogDraft(H('owner'),bad,K()),400,'INVALID_SAAS_INPUT');
 // Database refuses the same shapes even when the API validator is bypassed.
 await sqlDeny(restricted.query('SELECT hon.create_saas_catalog_draft($1,$2::jsonb,$3,$4,$5)',[H('owner'),JSON.stringify({...approved(),chargesEnabled:true}),K(),K(),K()]),'22023');
 const k1=K();
 const d1=await ok(api.createCatalogDraft(H('operator'),approved(),k1));
 assert.equal(d1.catalog.status,'DRAFT');assert.equal(d1.catalog.catalogVersion,1);assert.equal(d1.replayed,false);
 assert.deepEqual(d1.catalog.plans.map(p=>[p.planCode,p.availability,p.plannedMonthlyPremiumCredits]),[['CORE','PUBLIC',5000],['COMPLETE','PUBLIC',12000],['ESSENTIAL','LEGACY_ONLY',null]]);
 const caps=Object.fromEntries(d1.catalog.plans.map(p=>[p.planCode,p.capabilities]));
 assert.deepEqual(caps.CORE,[...contracts.SAAS_CORE_CAPABILITIES]);assert.ok(!caps.CORE.some(c=>contracts.SAAS_COMPLETE_ONLY_CAPABILITIES.includes(c)));
 assert.ok(contracts.SAAS_COMPLETE_ONLY_CAPABILITIES.every(c=>caps.COMPLETE.includes(c)));assert.ok(d1.catalog.plans.every(p=>p.ordinaryUseConsumesCredits===false));
 assert.deepEqual(d1.catalog.offers.map(o=>[o.planCode,o.offerKind,o.billingInterval,o.priceMinor]),[['CORE','REGULAR_MONTHLY','MONTHLY',14900],['CORE','FOUNDER_MONTHLY','MONTHLY',7900],
  ['CORE','FOUNDER_LIFETIME','LIFETIME',189600],['COMPLETE','REGULAR_MONTHLY','MONTHLY',24900],['COMPLETE','FOUNDER_MONTHLY','MONTHLY',14900],['COMPLETE','FOUNDER_LIFETIME','LIFETIME',357600]]);
 assert.ok(!d1.catalog.offers.some(o=>o.planCode==='ESSENTIAL'));
 const replay=await api.createCatalogDraft(H('operator'),approved(),k1);assert.equal(replay.replayed,true);assert.equal(replay.catalog.catalogId,d1.catalog.catalogId);
 await deny(api.createCatalogDraft(H('operator'),configured(),k1),409,'IDEMPOTENCY_KEY_REUSED');

 // ---------- 3. publication ----------
 await deny(api.publishCatalog(H('operator'),d1.catalog.catalogId,K()),403,'SAAS_FORBIDDEN');
 await deny(api.publishCatalog(H('owner'),d1.catalog.catalogId,K()),422,'SAAS_CATALOG_UNDECIDED'); // terms and founder eligibility undecided
 const regularOnly=approved();regularOnly.termsReference='Fixture regular-only terms';regularOnly.offers=regularOnly.offers.filter(o=>o.offerKind==='REGULAR_MONTHLY');
 regularOnly.plans[0].plannedMonthlyPremiumCredits=null;
 const dNull=await ok(api.createCatalogDraft(H('owner'),regularOnly,K()));
 await deny(api.publishCatalog(H('owner'),dNull.catalog.catalogId,K()),422,'SAAS_CATALOG_UNDECIDED'); // Core allowance undecided
 // Small limits prove the atomic sold-out path: total 3, lifetime 1, monthly 2.
 const d2=await ok(api.createCatalogDraft(H('owner'),configured({totalLimit:3,lifetimeLimit:1,monthlyLimit:2}),K()));
 const p2=await ok(api.publishCatalog(H('owner'),d2.catalog.catalogId,K()));
 assert.equal(p2.catalog.status,'PUBLISHED');assert.equal(p2.retiredCatalogId,null);assert.equal(p2.catalog.chargesEnabled,false);
 await deny(api.publishCatalog(H('owner'),d2.catalog.catalogId,K()),409,'SAAS_CATALOG_NOT_DRAFT');
 const cat=p2.catalog;
 let view=await api.readCatalog(H('owner'));
 assert.equal(view.published.catalogId,cat.catalogId);assert.equal(view.drafts.length,2);
 assert.deepEqual(view.founderInventory,{status:'CONFIGURED',totalLimit:3,lifetimeLimit:1,monthlyLimit:2,lifetime:{allocated:0,held:0},monthly:{allocated:0,held:0},remaining:{total:3,lifetime:1,monthly:2}});

 // ---------- 4. founder inventory ----------
 const reserve=(org,offerId,who='owner',key=K())=>api.reserveFounder(H(who),{organizationId:org,offerId},key);
 await deny(reserve(O[1].id,offer(cat,'CORE','FOUNDER_LIFETIME'),'operator'),403,'SAAS_FORBIDDEN');
 await deny(reserve(O[1].id,offer(cat,'CORE','REGULAR_MONTHLY')),422,'SAAS_OFFER_NOT_FOUNDER');
 await deny(reserve(O[1].id,offer(d1.catalog,'CORE','FOUNDER_LIFETIME')),422,'SAAS_OFFER_NOT_AVAILABLE');
 await deny(reserve(randomUUID(),offer(cat,'CORE','FOUNDER_LIFETIME')),404,'SAAS_UNAVAILABLE');
 const r1=await ok(reserve(O[1].id,offer(cat,'CORE','FOUNDER_LIFETIME')));
 assert.equal(r1.reservation.status,'RESERVED');assert.equal(r1.reservation.pool,'LIFETIME');assert.equal(r1.reservation.holdExpired,false);
 assert.deepEqual(r1.inventory.remaining,{total:2,lifetime:0,monthly:2});
 await deny(reserve(O[4].id,offer(cat,'CORE','FOUNDER_LIFETIME')),422,'SAAS_FOUNDER_SOLD_OUT');
 await deny(reserve(O[1].id,offer(cat,'CORE','FOUNDER_MONTHLY')),422,'SAAS_FOUNDER_ALREADY_RESERVED');
 // Concurrency: four simultaneous monthly reservations for two remaining slots.
 const race=await Promise.allSettled([[2,'COMPLETE'],[4,'CORE'],[5,'CORE'],[6,'COMPLETE']].map(([n,plan])=>reserve(O[n].id,offer(cat,plan,'FOUNDER_MONTHLY'))));
 const won=race.filter(r=>r.status==='fulfilled');commands+=won.length;
 assert.equal(won.length,2,JSON.stringify(race.map(r=>r.reason?.getResponse?.()??r.status)));
 for(const r of race.filter(r=>r.status==='rejected'))http(422,'SAAS_FOUNDER_SOLD_OUT')(r.reason);
 view=await api.readCatalog(H('operator'));
 assert.deepEqual(view.founderInventory.remaining,{total:0,lifetime:0,monthly:0});assert.equal(view.founderInventory.monthly.held,2);
 const winners=won.map(r=>r.value.reservation);
 // Release one held monthly slot; it returns to inventory.
 await deny(api.releaseFounder(H('owner'),winners[1].reservationId,{expectedVersion:2,reasonCode:'SCHOOL_DECLINED'},K()),409,'SAAS_VERSION_CONFLICT');
 const rel=await ok(api.releaseFounder(H('owner'),winners[1].reservationId,{expectedVersion:1,reasonCode:'SCHOOL_DECLINED'},K()));
 assert.equal(rel.reservation.status,'RELEASED');assert.deepEqual(rel.inventory.remaining,{total:1,lifetime:0,monthly:1});
 await deny(api.releaseFounder(H('owner'),winners[1].reservationId,{expectedVersion:2,reasonCode:'OWNER_RELEASED'},K()),409,'SAAS_TRANSITION_NOT_ALLOWED');

 // ---------- 5. subscription records ----------
 const record=(input,who='owner',key=K())=>api.recordSubscription(H(who),input,key);
 const catalogInput=(org,offerId,founderReservationId=null)=>({source:'CATALOG_OFFER',organizationId:org,offerId,founderReservationId});
 await deny(record(catalogInput(O[1].id,offer(cat,'CORE','FOUNDER_LIFETIME'),r1.reservation.reservationId),'operator'),403,'SAAS_FORBIDDEN');
 await deny(record(catalogInput(O[1].id,offer(cat,'CORE','FOUNDER_LIFETIME'))),422,'SAAS_FOUNDER_RESERVATION_REQUIRED');
 await deny(record(catalogInput(O[1].id,offer(cat,'CORE','FOUNDER_LIFETIME'),winners[0].reservationId)),422,'SAAS_FOUNDER_RESERVATION_MISMATCH');
 await deny(record(catalogInput(O[1].id,offer(cat,'COMPLETE','REGULAR_MONTHLY'))),422,'SAAS_ENTITLEMENT_MISMATCH');
 await deny(record(catalogInput(O[3].id,offer(cat,'CORE','REGULAR_MONTHLY'))),422,'SAAS_ENTITLEMENT_MISMATCH'); // Essential is never offered
 await deny(record(catalogInput(O[4].id,offer(cat,'CORE','REGULAR_MONTHLY'),r1.reservation.reservationId)),400,'INVALID_SAAS_INPUT');
 await deny(record({source:'LEGACY_ENTITLEMENT',organizationId:O[7].id}),422,'SAAS_ENTITLEMENT_NOT_ACTIVE');
 await deny(record({source:'LEGACY_ENTITLEMENT',organizationId:O[8].id}),422,'SAAS_ENTITLEMENT_NOT_ACTIVE');
 await deny(record({source:'LEGACY_ENTITLEMENT',organizationId:randomUUID()}),404,'SAAS_UNAVAILABLE');
 const s1=(await ok(record(catalogInput(O[1].id,offer(cat,'CORE','FOUNDER_LIFETIME'),r1.reservation.reservationId)))).subscription;
 assert.deepEqual([s1.status,s1.billingInterval,s1.priceMinor,s1.planCode,s1.paymentStatus,s1.paidThroughAt,s1.chargesEnabled,s1.currentPeriod],
  ['PENDING_ACTIVATION','LIFETIME',189600,'CORE','NOT_BILLED',null,false,null]);
 assert.deepEqual(s1.premiumCredits,{plannedMonthlyAllowance:5000,status:'NOT_GRANTED'});
 await deny(record(catalogInput(O[1].id,offer(cat,'CORE','REGULAR_MONTHLY'))),422,'SAAS_SUBSCRIPTION_EXISTS');
 const legacy=(await ok(record({source:'LEGACY_ENTITLEMENT',organizationId:O[3].id}))).subscription;
 assert.deepEqual([legacy.source,legacy.planCode,legacy.billingInterval,legacy.priceMinor,legacy.offerId,legacy.premiumCredits.plannedMonthlyAllowance],
  ['LEGACY_ENTITLEMENT','ESSENTIAL','NONE',null,null,null]);
 const s4=(await ok(record(catalogInput(O[4].id,offer(cat,'CORE','REGULAR_MONTHLY'))))).subscription;
 // Eligibility NO_PRIOR_CATALOG_SUBSCRIPTION: O4 now holds a catalog subscription.
 await ok(api.releaseFounder(H('owner'),winners[0].reservationId,{expectedVersion:1,reasonCode:'OWNER_RELEASED'},K()));
 await deny(reserve(O[4].id,offer(cat,'CORE','FOUNDER_MONTHLY')),422,'SAAS_FOUNDER_NOT_ELIGIBLE');

 // ---------- 6. lifecycle ----------
 let x=(await ok(cmd(s4.subscriptionId,1,'START_SERVICE','SERVICE_STARTED'))).subscription;
 assert.equal(x.status,'IN_SERVICE');assert.equal(x.currentPeriod.index,0);assert.equal(x.currentPeriod.startsAt,x.serviceStartedAt);
 const anchor=new Date(x.serviceStartedAt);const plusMonths=n=>{const d=new Date(anchor);d.setUTCMonth(d.getUTCMonth()+n);return d.toISOString();};
 assert.equal(x.currentPeriod.endsAt,plusMonths(1));
 await deny(api.commandSubscription(H('operator'),s4.subscriptionId,{action:'SUSPEND',expectedVersion:2,reasonCode:'OWNER_HOLD'},K()),403,'SAAS_FORBIDDEN');
 await deny(cmd(s4.subscriptionId,1,'SUSPEND','OWNER_HOLD'),409,'SAAS_VERSION_CONFLICT');
 await deny(cmd(s4.subscriptionId,2,'ADVANCE_PERIOD','PERIOD_ELAPSED'),422,'SAAS_PERIOD_NOT_ENDED');
 await deny(cmd(s4.subscriptionId,2,'CHANGE_OFFER','SCHOOL_REQUEST',{offerId:offer(cat,'CORE','REGULAR_MONTHLY')}),422,'SAAS_POLICY_UNDECIDED');
 await deny(cmd(s4.subscriptionId,2,'CANCEL','SCHOOL_REQUEST'),422,'SAAS_POLICY_UNDECIDED');
 await deny(cmd(s4.subscriptionId,2,'VOID','RECORDED_IN_ERROR'),409,'SAAS_TRANSITION_NOT_ALLOWED');
 // Simulate 40 days of elapsed service (disposable fixture only), then advance: periods stay anchored.
 await withoutGuards('saas_subscriptions',`UPDATE hon.saas_subscriptions SET service_started_at=service_started_at-interval '40 days',period_anchor_at=period_anchor_at-interval '40 days',
  current_period_start=current_period_start-interval '40 days',current_period_end=current_period_start-interval '40 days'+interval '1 month' WHERE id=$1`,[s4.subscriptionId]);
 x=(await ok(cmd(s4.subscriptionId,2,'ADVANCE_PERIOD','PERIOD_ELAPSED'))).subscription;
 const a2=new Date(x.serviceStartedAt),m=n=>{const d=new Date(a2);d.setUTCMonth(d.getUTCMonth()+n);return d.toISOString();};
 assert.deepEqual(x.currentPeriod,{index:1,startsAt:m(1),endsAt:m(2)});assert.equal(x.paymentStatus,'NOT_BILLED');
 await deny(cmd(s4.subscriptionId,3,'ADVANCE_PERIOD','PERIOD_ELAPSED'),422,'SAAS_PERIOD_NOT_ENDED');
 x=(await ok(cmd(s4.subscriptionId,3,'SUSPEND','ACCOUNT_REVIEW'))).subscription;assert.equal(x.status,'SUSPENDED');assert.equal(x.currentPeriod.index,1);
 await deny(cmd(s4.subscriptionId,4,'SUSPEND','OWNER_HOLD'),409,'SAAS_TRANSITION_NOT_ALLOWED');
 // The entitlement changes through the existing HQ transition (0146): the record reports MISMATCH and RESUME is refused.
 const entRow=(await admin.query('SELECT tier::text tier,updated_at::text updated_at FROM hon.organization_entitlements WHERE organization_id=$1',[O[4].id])).rows[0];
 await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1",[O[4].id]);
 assert.equal((await api.readOrganizationSubscription(H('operator'),O[4].id)).alignment,'MISMATCH');
 await deny(cmd(s4.subscriptionId,4,'RESUME','REVIEW_RESOLVED'),422,'SAAS_ENTITLEMENT_MISMATCH');
 await admin.query('UPDATE hon.organization_entitlements SET tier=$2::hon.plan_tier,updated_at=$3::timestamptz WHERE organization_id=$1',[O[4].id,entRow.tier,entRow.updated_at]);
 x=(await ok(cmd(s4.subscriptionId,4,'RESUME','REVIEW_RESOLVED'))).subscription;assert.equal(x.status,'IN_SERVICE');
 // Lifetime: one period from service start, no end, no advancing.
 x=(await ok(cmd(s1.subscriptionId,1,'START_SERVICE','SERVICE_STARTED'))).subscription;
 assert.deepEqual(x.currentPeriod,{index:null,startsAt:x.serviceStartedAt,endsAt:null});
 await deny(cmd(s1.subscriptionId,2,'ADVANCE_PERIOD','PERIOD_ELAPSED'),422,'SAAS_NO_BILLING_PERIODS');
 x=(await ok(cmd(legacy.subscriptionId,1,'START_SERVICE','SERVICE_STARTED'))).subscription;assert.equal(x.currentPeriod,null);
 // A founder record made in error is voided and its slot returns to inventory.
 // O2 has no catalog subscription; whatever it held in the race was released above.
 const loser=2,loserPlan=O[loser].tier;
 const r5=await ok(reserve(O[loser].id,offer(cat,loserPlan,'FOUNDER_MONTHLY')));
 const s5=(await ok(record(catalogInput(O[loser].id,offer(cat,loserPlan,'FOUNDER_MONTHLY'),r5.reservation.reservationId)))).subscription;
 assert.equal((await api.readFounderReservations(H('owner'),'ALLOCATED')).reservations.length,2);
 view=await api.readCatalog(H('owner'));assert.equal(view.founderInventory.remaining.total,1);
 x=(await ok(cmd(s5.subscriptionId,1,'VOID','RECORDED_IN_ERROR'))).subscription;assert.equal(x.status,'VOIDED');
 const freed=(await api.readFounderReservations(H('owner'),'RELEASED')).reservations.find(r=>r.reservationId===r5.reservation.reservationId);
 assert.equal(freed.statusReason,'SUBSCRIPTION_VOIDED');assert.equal(freed.subscriptionId,s5.subscriptionId);
 view=await api.readCatalog(H('owner'));assert.equal(view.founderInventory.remaining.total,2);
 // An allocated slot (O1, in service) is never released.
 const alloc=(await api.readFounderReservations(H('owner'),'ALLOCATED')).reservations[0];
 await deny(api.releaseFounder(H('owner'),alloc.reservationId,{expectedVersion:alloc.version,reasonCode:'OWNER_RELEASED'},K()),409,'SAAS_TRANSITION_NOT_ALLOWED');
 // Expired holds stop counting, cannot be recorded, and are expired on the next reservation.
 await deny(reserve(O[6].id,offer(cat,'COMPLETE','FOUNDER_LIFETIME')),422,'SAAS_FOUNDER_SOLD_OUT'); // lifetime pool (1) is allocated to O1
 const r6=await ok(reserve(O[6].id,offer(cat,'COMPLETE','FOUNDER_MONTHLY')));
 await withoutGuards('saas_founder_reservations',"UPDATE hon.saas_founder_reservations SET reserved_at=reserved_at-interval '9 days',hold_expires_at=hold_expires_at-interval '8 days' WHERE id=$1",[r6.reservation.reservationId]);
 const expiredView=(await api.readFounderReservations(H('owner'),'RESERVED')).reservations.find(r=>r.reservationId===r6.reservation.reservationId);
 assert.equal(expiredView.holdExpired,true);
 await deny(record(catalogInput(O[6].id,r6.reservation.offerId,r6.reservation.reservationId)),422,'SAAS_FOUNDER_RESERVATION_EXPIRED');
 const r6b=await ok(reserve(O[6].id,r6.reservation.offerId));assert.equal(r6b.reservation.status,'RESERVED');
 assert.equal((await api.readFounderReservations(H('owner'),'EXPIRED')).reservations[0].reservationId,r6.reservation.reservationId);

 // ---------- 7. later catalogs ----------
 const below=await ok(api.createCatalogDraft(H('owner'),configured({totalLimit:1,lifetimeLimit:1,monthlyLimit:1}),K()));
 await deny(api.publishCatalog(H('owner'),below.catalog.catalogId,K()),422,'SAAS_FOUNDER_LIMIT_BELOW_USAGE');
 const closed=await ok(api.createCatalogDraft(H('owner'),configured({opensAt:iso(NOW-2*HOUR),closesAt:iso(NOW-HOUR)}),K()));
 const pc=await ok(api.publishCatalog(H('owner'),closed.catalog.catalogId,K()));assert.equal(pc.retiredCatalogId,cat.catalogId);
 await deny(reserve(O[5].id,offer(pc.catalog,'CORE','FOUNDER_MONTHLY')),422,'SAAS_FOUNDER_WINDOW_CLOSED');
 const full=await ok(api.createCatalogDraft(H('owner'),configured(),K()));
 await ok(api.publishCatalog(H('owner'),full.catalog.catalogId,K()));
 view=await api.readCatalog(H('owner'));
 assert.deepEqual([view.founderInventory.totalLimit,view.founderInventory.lifetimeLimit,view.founderInventory.monthlyLimit],[50,20,30]);
 assert.equal(view.founderInventory.lifetime.allocated,1);
 assert.equal(view.founderInventory.remaining.total,50-1-1);assert.equal(view.founderInventory.remaining.lifetime,19);assert.equal(view.founderInventory.remaining.monthly,29);
 // Existing records keep the retired catalog's offer and price.
 const org1=await api.readOrganizationSubscription(H('operator'),O[1].id);
 assert.equal(org1.current.catalogVersion,cat.catalogVersion);assert.equal(org1.current.priceMinor,189600);assert.equal(org1.alignment,'ALIGNED');
 assert.deepEqual(org1.history.map(h=>[h.version,h.status]),[[2,'IN_SERVICE'],[1,'PENDING_ACTIVATION']]);
 assert.equal(org1.entitlement.tier,'CORE');assert.equal(org1.founderReservations[0].status,'ALLOCATED');
 assert.equal((await api.readOrganizationSubscription(H('owner'),O[7].id)).alignment,'NO_ENTITLEMENT');
 assert.equal((await api.readOrganizationSubscription(H('owner'),O[2].id)).alignment,'NO_SUBSCRIPTION');
 await deny(api.readOrganizationSubscription(H('support'),O[1].id),403,'SAAS_FORBIDDEN');
 const subs=await api.readSubscriptions(H('operator'),undefined);
 assert.ok(subs.subscriptions.every(s=>s.paymentStatus==='NOT_BILLED'&&s.paidThroughAt===null&&s.chargesEnabled===false&&s.premiumCredits.status==='NOT_GRANTED'));
 assert.equal((await api.readSubscriptions(H('operator'),'VOIDED')).subscriptions.length,1);

 // ---------- 8. constraints hold even with guards disabled ----------
 const sub=s4.subscriptionId,cid=cat.catalogId;
 for(const [col,val] of [['charges_enabled','true'],["payment_status","'PAID'"],['paid_through_at','clock_timestamp()']])
  await rejectedWithoutGuards('saas_subscriptions',`UPDATE hon.saas_subscriptions SET ${col}=${val} WHERE id=$1`,[sub]);
 for(const col of ['charges_enabled','credit_grants_enabled'])await rejectedWithoutGuards('saas_catalog_versions',`UPDATE hon.saas_catalog_versions SET ${col}=true WHERE id=$1`,[cid]);
 await rejectedWithoutGuards('saas_policy_decisions',"UPDATE hon.saas_policy_decisions SET status='DECIDED' WHERE policy_code='ANNUAL_BILLING'");
 await rejectedWithoutGuards('saas_catalog_offers',"INSERT INTO hon.saas_catalog_offers(catalog_id,plan_code,offer_kind,billing_interval,price_minor) VALUES($1,'ESSENTIAL','REGULAR_MONTHLY','MONTHLY',9900)",[d1.catalog.catalogId]);
 await rejectedWithoutGuards('saas_catalog_offers',"INSERT INTO hon.saas_catalog_offers(catalog_id,plan_code,offer_kind,billing_interval,price_minor) VALUES($1,'CORE','REGULAR_ANNUAL','ANNUAL',149000)",[d1.catalog.catalogId]);
 await rejectedWithoutGuards('saas_catalog_plans',"UPDATE hon.saas_catalog_plans SET capabilities=array_append(capabilities,'ai.workforce') WHERE catalog_id=$1 AND plan_code='CORE'",[cid]);
 await rejectedWithoutGuards('saas_catalog_plans',"UPDATE hon.saas_catalog_plans SET availability='PUBLIC' WHERE catalog_id=$1 AND plan_code='ESSENTIAL'",[cid]);
 // Guards: evidence is immutable, records only move through their documented transitions, catalogs are frozen once published.
 await sqlDeny(admin.query('UPDATE hon.saas_audit SET next_state=$1::jsonb',['{}']));
 await sqlDeny(admin.query('DELETE FROM hon.saas_subscriptions WHERE id=$1',[sub]));
 await sqlDeny(admin.query("UPDATE hon.saas_subscriptions SET status='VOIDED',version=version+1 WHERE id=$1",[sub]));
 await sqlDeny(admin.query("UPDATE hon.saas_subscriptions SET price_minor=100,version=version+1 WHERE id=$1",[sub]));
 await sqlDeny(admin.query("UPDATE hon.saas_founder_reservations SET status='RESERVED',version=version+1 WHERE status='ALLOCATED'"));
 await sqlDeny(admin.query("UPDATE hon.saas_catalog_versions SET status='DRAFT' WHERE id=$1",[cid]));
 await sqlDeny(admin.query("INSERT INTO hon.saas_catalog_offers(catalog_id,plan_code,offer_kind,billing_interval,price_minor) VALUES($1,'CORE','REGULAR_MONTHLY','MONTHLY',100)",[cid]));
 await sqlDeny(admin.query("UPDATE hon.saas_catalog_offers SET price_minor=100 WHERE catalog_id=$1",[cid]));
 await sqlDeny(admin.query('TRUNCATE hon.saas_outbox CASCADE'));
 await sqlDeny(admin.query("DELETE FROM hon.saas_policy_decisions WHERE policy_code='TAXES'"));

 // ---------- 9. evidence and isolation ----------
 const ev=(await admin.query(`SELECT (SELECT count(*) FROM hon.saas_requests WHERE status='COMPLETED')::int req,(SELECT count(*) FROM hon.saas_requests WHERE status<>'COMPLETED')::int open,
  (SELECT count(*) FROM hon.saas_audit)::int audit,(SELECT count(*) FROM hon.saas_outbox)::int outbox,
  (SELECT count(*) FROM hon.saas_outbox WHERE payload->'internalOnly'='true'::jsonb AND payload->'executionAllowed'='false'::jsonb)::int inert,
  (SELECT count(*) FROM hon.saas_audit a JOIN hon.saas_requests r USING(actor_principal_id,idempotency_key) WHERE a.request_id=r.request_id)::int joined`)).rows[0];
 assert.deepEqual(ev,{req:commands,open:0,audit:commands,outbox:commands,inert:commands,joined:commands});
 const hist=(await admin.query('SELECT count(*)::int n FROM hon.saas_subscription_history h JOIN hon.saas_subscriptions s ON s.id=h.subscription_id WHERE h.version>s.version')).rows[0].n;
 assert.equal(hist,0);
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.saas_subscriptions s WHERE (SELECT count(*) FROM hon.saas_subscription_history h WHERE h.subscription_id=s.id)<>s.version')).rows[0].n,0);
 assert.deepEqual(await untouched(),before,'No entitlement, school billing, AI usage, Champions or shared audit/outbox row changed.');
 console.log(`PASS: HON subscription catalog B1 proof — ${commands} commands with exact evidence; owner-only publication; atomic founder inventory under concurrency; entitlement-linked records; undecided policies refused; financial activation pinned off.`);
}finally{
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end()]);}
}
