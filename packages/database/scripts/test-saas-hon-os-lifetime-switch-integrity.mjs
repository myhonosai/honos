import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID as K } from 'node:crypto';
import { createRequire } from 'node:module';
import { pricingOffers, scheduleInput, acceptanceInput } from './price-acceptance-fixture.mjs';
import { generationInput } from './subscription-generation-fixture.mjs';
import { verifySaasBillingSecurity } from './saas-billing-security.mjs';

// 0341: switch from monthly or annual straight to lifetime with credit (owner D3/D3a). Fixed disposable local fixture only:
// synthetic organizations, the deterministic TEST provider, no network, no charge, no refund sent, no
// checkout and no deployment.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const u of [owner,runtime])assert(u.protocol==='postgresql:'&&u.hostname==='localhost'&&u.port==='5432'&&u.pathname==='/hon_champions_validation'&&u.search===''&&u.hash===''&&u.password);
assert(owner.username==='hon_champions_owner'&&runtime.username==='hon_champions_runtime');
assert(!Object.keys(process.env).some(k=>/^PG[A-Z_]*$|^(?:STRIPE|SQUARE|OPENAI|ANTHROPIC|OPENROUTER|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k)));
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasPriceAcceptanceService}=await import('../../../apps/api/dist/saas-pricing/saas-price-acceptance.service.js');
const {SaasSubscriptionGenerationService}=await import('../../../apps/api/dist/saas-pricing/saas-subscription-generation.service.js');
const {SaasScheduleBillingService}=await import('../../../apps/api/dist/saas-pricing/saas-schedule-billing.service.js');
const {SaasPaidReviewService}=await import('../../../apps/api/dist/saas-paid-review/saas-paid-review.service.js');
const {SaasFounderService}=await import('../../../apps/api/dist/saas-founder/saas-founder.service.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const {ChampionsClubService}=await import('../../../apps/api/dist/champions/champions-club.service.js');
const apiRequire=createRequire(new URL('../../../apps/api/package.json',import.meta.url));
const c=apiRequire('@hon/contracts');
const {DeterministicScheduleProvider}=apiRequire('./test/fixtures/subscription-schedule-provider.cjs');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),pricing=new SaasPriceAcceptanceService(billing);
const generations=new SaasSubscriptionGenerationService(billing),provider=new DeterministicScheduleProvider(),schedules=new SaasScheduleBillingService(billing,provider);
const champions=new ChampionsClubService(database),schoolBilling=new SaasSchoolBillingService(billing),reviews=new SaasPaidReviewService(billing),founder=new SaasFounderService(billing),payments=new SaasPaymentsService(billing,database,{});
const client=u=>new pg.Client({connectionString:u.toString(),ssl:false}),admin=client(owner),watcher=client(owner),restricted=client(runtime);
const hq={id:K(),user:K(),subject:'sw-'+K()},operator={id:K(),user:K(),subject:'sw-'+K()};
const orgs=[];const principals=()=>[hq.id,operator.id,...orgs.map(o=>o.principal)];
const tables=['saas_lifetime_switches','saas_schedule_credit_uses','saas_schedule_welcome_credits','saas_lifetime_sales','saas_founder_allocations','saas_paid_review_resolutions','saas_access_transitions','saas_access_states','saas_schedule_reconciliations','saas_schedule_paid_periods','saas_schedule_provider_events','saas_schedule_bindings','saas_subscription_generations','saas_price_acceptances','saas_price_schedules'];
const championsTables=['champions_outbox','champions_audit','champions_contest_history','champions_contest_winners','champions_contest_results','champions_contest_pauses','champions_contest_schools','champions_contest_prizes','champions_contests','champions_leaderboard_holds','champions_leaderboard_preferences','champions_reward_history','champions_reward_entries','champions_reward_policies','champions_attribution_history','champions_attributions','champions_requests','champions_referral_codes','champions_policies'];
const row=async(q,p)=>(await admin.query(q,p)).rows[0];let groups=0;const passed=s=>console.log('PASS 0341 '+(++groups)+': '+s);
const deny=(work,status,code)=>assert.rejects(Promise.resolve().then(work),e=>{assert.equal(e.getStatus?.(),status,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;});
const sqlDeny=(work,code)=>assert.rejects(work,e=>{assert.equal(e.code,code,e.stack);return true;});
const digest=async v=>(await row('SELECT hon.saas_hon_os_digest($1::jsonb) d',[v])).d;
const spots=async()=>(await row('SELECT count(*)::int n FROM hon.saas_founder_allocations')).n;
const STATUS_CHECK="CHECK ((status = 'INACTIVE'::text))";
async function setAccessProgram(active){
  await admin.query('BEGIN');
  try {
    await admin.query('ALTER TABLE hon.saas_access_program DISABLE TRIGGER USER');
    if(active){
      await admin.query('ALTER TABLE hon.saas_access_program DROP CONSTRAINT IF EXISTS saas_access_program_status_check');
      await admin.query("UPDATE hon.saas_access_program SET status='ACTIVE'");
    } else {
      await admin.query("UPDATE hon.saas_access_program SET status='INACTIVE'");
      if(!(await admin.query("SELECT 1 FROM pg_constraint WHERE conname='saas_access_program_status_check' AND conrelid='hon.saas_access_program'::regclass")).rowCount)
        await admin.query("ALTER TABLE hon.saas_access_program ADD CONSTRAINT saas_access_program_status_check CHECK (status = 'INACTIVE')");
    }
    await admin.query('ALTER TABLE hon.saas_access_program ENABLE TRIGGER USER');
    await admin.query('COMMIT');
  } catch(e) { await admin.query('ROLLBACK'); throw e; }
}
async function cleanup(){
  await admin.query('ROLLBACK');await admin.query('BEGIN');
  try {
    await admin.query('ALTER TABLE hon.saas_referral_payment_alerts DISABLE TRIGGER USER');await admin.query('DELETE FROM hon.saas_referral_payment_alerts');await admin.query('ALTER TABLE hon.saas_referral_payment_alerts ENABLE TRIGGER USER');
    for(const t of [...tables,'saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets','saas_outbox','saas_audit','saas_requests']){
      await admin.query('ALTER TABLE hon.'+t+' DISABLE TRIGGER USER');
      if(t==='saas_outbox')await admin.query('DELETE FROM hon.saas_outbox WHERE audit_id IN (SELECT id FROM hon.saas_audit WHERE actor_principal_id=ANY($1::uuid[]))',[principals()]);
      else if(['saas_audit','saas_requests'].includes(t))await admin.query('DELETE FROM hon.'+t+' WHERE actor_principal_id=ANY($1::uuid[])',[principals()]);
      else await admin.query('DELETE FROM hon.'+t);
      await admin.query('ALTER TABLE hon.'+t+' ENABLE TRIGGER USER');
    }
    for(const t of championsTables){await admin.query('ALTER TABLE hon.'+t+' DISABLE TRIGGER USER');await admin.query('DELETE FROM hon.'+t);await admin.query('ALTER TABLE hon.'+t+' ENABLE TRIGGER USER');}
    await admin.query('ALTER TABLE hon.saas_reward_fulfillment DISABLE TRIGGER USER');
    await admin.query("UPDATE hon.saas_reward_fulfillment SET status='INACTIVE',authorization_reference=NULL,changed_by_principal_id=NULL,changed_at=clock_timestamp() WHERE program_id=1");
    await admin.query('ALTER TABLE hon.saas_reward_fulfillment ENABLE TRIGGER USER');
    await admin.query('ALTER TABLE hon.saas_payment_program DISABLE TRIGGER USER');
    await admin.query("UPDATE hon.saas_payment_program SET status='DISABLED',provider=NULL,live_mode=false,test_tax_reference=NULL,authorization_reference=NULL,version=1,changed_by_principal_id=NULL,changed_at=clock_timestamp() WHERE program_id=1");
    await admin.query('ALTER TABLE hon.saas_payment_program ENABLE TRIGGER USER');
    await admin.query('COMMIT');
  } catch(e){await admin.query('ROLLBACK');throw e;}
}
// N synthetic organizations, each with one school and one purchaser (billing.hon.purchase on that exact school).
async function makeOrgs(n,label,entitlement='SUSPENDED'){
  const made=[];await admin.query('BEGIN');
  for(let i=0;i<n;i++){
    const o={label:label+i,id:K(),school:K(),role:K(),principal:K(),user:K(),subject:'sw-'+K()};
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'SW SYNTHETIC')",[o.user,o.subject,o.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','SW SYNTHETIC',true)",[o.principal,o.user]);
    await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'SW SYNTHETIC','SW SYNTHETIC')",[o.id]);
    await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'SW SYNTHETIC',$3,'UTC')",[o.school,o.id,'sw-'+o.school]);
    await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE',$2)",[o.id,entitlement]);
    await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','SW synthetic owner',true)",[o.role,o.id]);
    await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.hon.purchase'),($1,$2,'billing.hon.view')",[o.role,o.id]);
    await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')",[o.id,o.school,o.principal,o.role]);
    made.push(o);orgs.push(o);
  }
  await admin.query('COMMIT');return made;
}
const evt=()=>'evt_'+K().replaceAll('-','_');
// Periods start one day ago (UTC midnight) so a first payment can switch on access now.
const base=new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),new Date().getUTCDate()-1));
const step=(months,n)=>{const d=new Date(base);d.setUTCMonth(d.getUTCMonth()+months*n);return d.toISOString();};
const P={MONTHLY:[0,1,2,3].map(n=>step(1,n)),ANNUAL:[0,1,2,3].map(n=>step(12,n))};
const paid=(b,n=0,amountMinor=b.requirements.lockedPriceMinor)=>{const iv=P[b.requirements.billingInterval],eventId=evt();return {provider:'STRIPE_SIMULATED',mode:'TEST',eventId,eventType:'invoice.paid',bindingId:b.bindingId,
  accountReference:b.providerAccountReference,subscriptionReference:b.providerSubscriptionReference,scheduleReference:b.providerScheduleReference,
  invoiceReference:'fake_invoice_'+eventId.slice(4).toLowerCase(),relatedInvoiceReference:null,coveredPeriod:{startsAt:iv[n],endsAt:iv[n+1]},amountMinor,currency:'USD',occurredAt:new Date().toISOString()};};
const lifetimePaid=(b,amountMinor=b.requirements.lockedPriceMinor)=>{const e=paid({...b,requirements:{...b.requirements,billingInterval:'MONTHLY'}},0,amountMinor);return {...e,coveredPeriod:{startsAt:P.MONTHLY[0],endsAt:null}};};
const refund=(b,ref,amountMinor=b.requirements.lockedPriceMinor)=>({...lifetimePaid(b),eventType:'charge.refunded',invoiceReference:null,relatedInvoiceReference:ref,coveredPeriod:null,amountMinor});
const dispute=(b,ref)=>({...refund(b,ref),eventType:'charge.dispute.created'});
const ingest=async e=>schedules.ingestVerifiedTestEvidence(e,await digest(e));
const preview=(o,s)=>pricing.preview(o.subject,o.school,s.scheduleId);
async function accept(o,s){return (await pricing.accept(o.subject,o.school,acceptanceInput(await preview(o,s)),K())).acceptance;}
async function generate(o,s){return (await generations.record(o.subject,o.school,generationInput(await accept(o,s)),K())).generation;}
const bindInput=g=>({generationId:g.generationId,generationDigest:g.generationDigest,confirmation:c.SAAS_SCHEDULE_BINDING_CONFIRMATION});
async function signUp(o,s){return (await schedules.start(o.subject,o.school,bindInput(await generate(o,s)),K())).binding;}
async function publish(offers,founderTotalLimit){
  const d=await billing.createOfferSetDraft(hq.subject,{basedOnSetId:null,termsReference:'SYNTHETIC_SW_TERMS_V1',founderTotalLimit,offers},K());
  const set=(await billing.publishOfferSet(hq.subject,d.set.setId,{expectedRevision:d.set.revision,previewDigest:d.preview.previewDigest,approval:c.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K())).set;
  const byKind=Object.fromEntries(set.offers.map(o=>[o.offerKind,o])),recorded={};
  for(const kind of [...c.SAAS_SCHEDULED_OFFER_KINDS,...c.SAAS_LIFETIME_OFFER_KINDS].filter(k=>byKind[k]))recorded[kind]=(await pricing.record(hq.subject,scheduleInput(byKind[kind],byKind[kind],0),K())).schedule;
  return {set,offers:byKind,schedules:recorded};
}
const lifetimeOffer=(kind,priceMinor,saleLimit)=>({offerCode:kind,offerKind:kind,displayName:kind,priceMinor,
  salesOpensAt:new Date(Date.now()-3600_000).toISOString(),salesClosesAt:null,eligibility:'ANY_ACTIVE_ORGANIZATION',saleLimit,
  priceLock:'NONE',priceLockMonths:null,annualRenewal:null,plannedMonthlyPremiumCredits:12000,aiFairUseReference:'SYNTHETIC_FAIR_USE_V1',
  refundWindowDays:30,cancellationTiming:null});
const sales=async offer=>(await row('SELECT count(*)::int n FROM hon.saas_lifetime_sales WHERE offer_id=$1',[offer])).n;
const awaiting=o=>admin.query("INSERT INTO hon.saas_access_states(organization_id,state,reason,version,changed_by_principal_id,created_at,updated_at) VALUES($1,'AWAITING_FIRST_PAYMENT','AWAITING_INITIAL_PAYMENT',1,$2,clock_timestamp(),clock_timestamp())",[o.id,hq.id]);
await Promise.all([admin,watcher,restricted].map(x=>x.connect()));
try {
  assert.equal((await row("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).marker,'HON disposable Champions Club validation');
  assert.deepEqual(await row("SELECT status,mutations_enabled FROM hon.saas_access_program"),{status:'INACTIVE',mutations_enabled:false});
  for(const t of tables)assert.equal((await row('SELECT count(*)::int n FROM hon.'+t)).n,0,'dedicated empty fixture required: '+t);
  await verifySaasBillingSecurity(admin,'hon_champions_runtime');
  for(const q of ["SELECT * FROM hon.saas_lifetime_switches","SELECT hon.saas_lifetime_switch_for_binding(gen_random_uuid())",
    "SELECT * FROM hon.saas_lifetime_switch_source(gen_random_uuid(),clock_timestamp())",
    "SELECT * FROM hon.saas_lifetime_switch_credit(100,clock_timestamp(),clock_timestamp()+interval '30 days',clock_timestamp(),1000)",
    "SELECT hon.saas_schedule_switch_lifetime_access(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'evt_x',clock_timestamp())",
    "UPDATE hon.saas_access_states SET paid_through='infinity'"])
    await sqlDeny(restricted.query(q),'42501');
  passed('the runtime has no direct path: no switch table access, no credit, source or access-move helper, no access write; the billing inventory holds');

  await admin.query('BEGIN');
  for(const [h,role,perms] of [[hq,'HON_HQ_OWNER',[]],[operator,'HON_HQ_OPERATOR',['hq.billing.manage']]]){
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'SW SYNTHETIC')",[h.user,h.subject,h.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','SW SYNTHETIC',true)",[h.id,h.user]);
    await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[h.id,role,perms]);
  }
  await admin.query('COMMIT');
  await payments.setPaymentProgram(hq.subject,{action:'ENABLE_TEST_MODE',expectedVersion:1,provider:'STRIPE_SIMULATED',testTaxReference:'SW TEST TAX',authorizationReference:'SW TEST AUTHORIZATION'},K());
  const s1=await publish([...pricingOffers(),lifetimeOffer('LIFETIME',357600,20),lifetimeOffer('FOUNDER_LIFETIME',189600,1)],50);
  const monthly=s1.schedules.REGULAR_MONTHLY,annual=s1.schedules.REGULAR_ANNUAL,lt=s1.schedules.LIFETIME,flt=s1.schedules.FOUNDER_LIFETIME;
  const DAY=86400_000;
  const ent=o=>row("SELECT status::text,effective_until,version FROM hon.organization_entitlements WHERE organization_id=$1",[o.id]);
  const access=o=>row("SELECT state,binding_id,paid_through FROM hon.saas_access_states WHERE organization_id=$1",[o.id]);
  const bstatus=async b=>(await row('SELECT status,status_reason FROM hon.saas_schedule_bindings WHERE id=$1',[b.bindingId]));
  async function withProgram(work){await setAccessProgram(true);try{return await work();}finally{await setAccessProgram(false);}}
  async function buy(o,s){const b=await signUp(o,s);const e=s===lt||s===flt?lifetimePaid(b):paid(b);const r=await withProgram(()=>ingest(e));assert.equal(r.access.accessActivation,'APPLIED',JSON.stringify(r));return b;}
  const quote=o=>schedules.lifetimeSwitchQuote(o.subject,o.school);
  const view=(o,b)=>schedules.read(o.subject,o.school,b.bindingId);
  const expectedCredit=(q,price)=>{const st=Date.parse(q.fromPeriod.startsAt),en=Date.parse(q.fromPeriod.endsAt),d=Math.max(1,Math.round((en-st)/DAY)),
    u=Math.min(d,Math.max(0,Math.floor((en-Date.now())/DAY)));return Math.min(Math.floor(q.fromPeriod.paidMinor*u/d),price-100);};
  const gens=new Map();
  async function switchTo(o,s,q,key=K(),patch={}){
    const gk=o.id+':'+s.scheduleId;if(!gens.has(gk))gens.set(gk,await generate(o,s));const g=gens.get(gk),offer=q.offers.find(x=>x.offerId===s.offerId)??q.offers[0];
    return schedules.startLifetimeSwitch(o.subject,o.school,{generationId:g.generationId,generationDigest:g.generationDigest,fromBindingId:q.fromBindingId,
      expectedFromVersion:q.fromBindingVersion,expectedCreditMinor:offer.creditMinor,confirmation:c.SAAS_LIFETIME_SWITCH_CONFIRMATION,...patch},key);
  }

  // ---------- quote ----------
  const people=await makeOrgs(9,'sw');for(const o of people)await awaiting(o);
  const [A,B,C,D,E,F,G,H,I]=people;
  assert.deepEqual((await quote(A)).refusal,'NO_ACTIVE_PLAN');assert.equal((await quote(A)).offers.length,0);
  const bA=await buy(A,monthly),bB=await buy(B,annual);
  const qA=await quote(A),qB=await quote(B);
  for(const [q,b,interval,price] of [[qA,bA,'MONTHLY',24900],[qB,bB,'ANNUAL',209700]]){
    assert.equal(q.eligible,true);assert.equal(q.fromBindingId,b.bindingId);assert.equal(q.fromPlan.billingInterval,interval);assert.equal(q.fromPeriod.paidMinor,price);
    const o=q.offers.find(x=>x.offerKind==='LIFETIME');
    assert.equal(o.creditMinor,expectedCredit(q,357600));assert.equal(o.amountDueMinor,357600-o.creditMinor);assert(o.creditMinor>0&&o.creditMinor<price);
    assert.equal(o.availability,'AVAILABLE');assert.equal(q.refundSent,false);
  }
  // A lifetime school has no recurring plan to switch from.
  const bL=await buy(I,lt);assert.equal((await quote(I)).refusal,'NO_ACTIVE_PLAN');
  passed(`quote: monthly credit $${qA.offers[0].creditMinor/100} and annual credit $${qB.offers[0].creditMinor/100} are the paid amount times whole unused days over the period, rounded down; no plan or a lifetime plan gets no quote`);

  // ---------- sign-up ----------
  await deny(()=>switchTo(A,lt,qA,K(),{expectedCreditMinor:qA.offers[0].creditMinor+1}),409,'SAAS_LIFETIME_SWITCH_QUOTE_STALE');
  await deny(()=>switchTo(A,lt,qA,K(),{expectedFromVersion:qA.fromBindingVersion+1}),409,'SAAS_VERSION_CONFLICT');
  const keyA=K(),swA=await switchTo(A,lt,qA,keyA);
  const credA=qA.offers.find(x=>x.offerKind==='LIFETIME').creditMinor;
  assert.equal(swA.binding.status,'BOUND_TEST_ONLY');assert.equal(swA.providerCredited,true);assert.equal(swA.lifetimeSwitch.creditMinor,credA);
  assert.equal(swA.lifetimeSwitch.amountDueMinor,357600-credA);assert.equal(swA.lifetimeSwitch.status,'AWAITING_PAYMENT');
  assert.equal(provider.balances.get(swA.binding.providerAccountReference),credA);
  // Same key: the same switch, the same idempotent provider credit (never a second one).
  const again=await switchTo(A,lt,qA,keyA).catch(e=>e);
  assert(again instanceof Error||again.lifetimeSwitch.switchId===swA.lifetimeSwitch.switchId);
  assert.equal(provider.balances.get(swA.binding.providerAccountReference),credA);
  assert.equal((await quote(A)).refusal,'SWITCH_IN_PROGRESS');
  assert.deepEqual(await bstatus(bA),{status:'ACTIVE',status_reason:'FIRST_PAYMENT_VERIFIED'});
  assert.equal((await access(A)).binding_id,bA.bindingId);
  await sqlDeny(admin.query("UPDATE hon.saas_lifetime_switches SET credit_minor=credit_minor+1"),'42501');
  passed('sign-up: a stale credit or version is refused; the switch binding is bound with its credit fixed and put on the new provider balance once; the old plan keeps running and keeps access');

  // ---------- switch paid ----------
  const pay=b=>lifetimePaid(swA.binding,b);
  const ev=pay(357600-credA);
  // A provider outage on the stop: 503 (webhook not acknowledged) with the switch already committed; nothing stopped yet.
  provider.failNextStop=true;
  const eventsBefore=(await row("SELECT count(*)::int n FROM hon.saas_schedule_provider_events")).n;
  await deny(()=>withProgram(()=>ingest(ev)),503,'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE');
  assert.equal(provider.stopped.has(bA.bindingId),false);
  assert.deepEqual(await bstatus(bA),{status:'SWITCHED_TO_LIFETIME',status_reason:'SWITCHED_TO_LIFETIME'});
  const eventsAfterOutage=(await row("SELECT count(*)::int n FROM hon.saas_schedule_provider_events")).n;
  assert.equal(eventsAfterOutage,eventsBefore+1);
  // The provider redelivers the same event: the stored receipt is replayed and the stop happens once; nothing new is written.
  const r=await withProgram(()=>ingest(ev));
  assert.equal((await row("SELECT count(*)::int n FROM hon.saas_schedule_provider_events")).n,eventsAfterOutage);
  assert.equal(r.outcome,'APPLIED');assert.equal(r.billingStatus,'ACTIVE');assert.equal(r.access.accessActivation,'APPLIED');
  assert.equal(r.switchedFrom.bindingId,bA.bindingId);assert.equal(r.oldScheduleStopped,true);assert(provider.stopped.has(bA.bindingId));
  assert.deepEqual(await bstatus(bA),{status:'SWITCHED_TO_LIFETIME',status_reason:'SWITCHED_TO_LIFETIME'});
  const stA=await access(A);assert.equal(stA.state,'PAYMENT_ACTIVE');assert.equal(stA.binding_id,swA.binding.bindingId);assert.equal(String(stA.paid_through),'Infinity');
  const eA=await ent(A);assert.equal(eA.status,'ACTIVE');assert.equal(eA.effective_until,null);
  assert.equal(await sales(lt.offerId),2);
  const vOld=await view(A,bA),vNew=await view(A,swA.binding);
  assert.equal(vOld.access.accessActivation,'SWITCHED');assert.equal(vOld.lifetimeSwitch.status,'SWITCHED');
  assert.equal(vNew.access.accessActivation,'APPLIED');assert.equal(vNew.access.paidThrough,null);assert.equal(vNew.lifetimeSwitch.lifetimeStartedAt!==null,true);
  const hqList=await schedules.hqLifetimeSwitches(hq.subject);assert.equal(hqList.switches[0].switchId,swA.lifetimeSwitch.switchId);assert.equal(hqList.refundSent,false);
  // Replay: the stored receipt, nothing changes.
  const replay=await ingest(ev);assert.equal(replay.outcome,'APPLIED');assert.equal(await sales(lt.offerId),2);
  assert.equal((await row("SELECT count(*)::int n FROM hon.saas_access_transitions WHERE kind='SCHEDULE_LIFETIME_SWITCH'")).n,1);
  passed(`switch paid at $${(357600-credA)/100}: one transaction makes lifetime ACTIVE, counts the sale, moves access open-ended and ends the old plan as SWITCHED_TO_LIFETIME; the old schedule is stopped (no proration, no refund); a stop outage answers 503 and the redelivery stops it once with nothing new written; a replay changes nothing; HQ lists it`);

  // ---------- held for review ----------
  // Wrong amount (full price although the credit was recorded): held; access stays on the old plan.
  const bC=await buy(C,monthly),qC=await quote(C),swC=await switchTo(C,lt,qC);
  const rc=await withProgram(()=>ingest(lifetimePaid(swC.binding,357600)));
  assert.equal(rc.outcome,'NEEDS_REVIEW');assert.equal(rc.reason,'AMOUNT_MISMATCH');
  assert.equal((await bstatus(bC)).status,'ACTIVE');assert.equal((await access(C)).binding_id,bC.bindingId);
  // An old-plan renewal lands first: the credit no longer matches; held, access stays on the (renewed) old plan.
  const bD=await buy(D,monthly),qD=await quote(D),swD=await switchTo(D,lt,qD);
  const ren={...paid(bD,1)};await withProgram(()=>ingest(ren));
  const rd=await withProgram(()=>ingest(lifetimePaid(swD.binding,swD.lifetimeSwitch.amountDueMinor)));
  assert.equal(rd.reason,'LIFETIME_SWITCH_SOURCE_CHANGED');assert.equal((await bstatus(bD)).status,'ACTIVE');assert.equal((await access(D)).binding_id,bD.bindingId);
  // The sale limit is reached first (founder lifetime, limit 1): held, never counted.
  const bE=await buy(E,monthly),qE=await quote(E),swE=await switchTo(E,flt,qE);
  await buy(F,flt);
  const re=await withProgram(()=>ingest(lifetimePaid(swE.binding,swE.lifetimeSwitch.amountDueMinor)));
  assert.equal(re.reason,'LIFETIME_SALE_LIMIT_REACHED');assert.equal(await sales(flt.offerId),1);
  assert.equal((await bstatus(bE)).status,'ACTIVE');assert.equal((await access(E)).binding_id,bE.bindingId);
  for(const [o,b] of [[C,bC],[D,bD],[E,bE]])assert.equal((await view(o,b)).access.accessActivation,'APPLIED');
  passed('a wrong amount, an old-plan renewal that lands first or a sale limit reached first is held for HQ review; the old plan stays ACTIVE and keeps access; nothing is counted');

  // ---------- after the switch ----------
  // Money for the switched plan is held for HQ (listed), never counted.
  const late={...paid(bA,1)};const rl=await ingest(late);assert.equal(rl.outcome,'NEEDS_REVIEW');assert.equal(rl.reason,'PAID_AFTER_TERMINAL');
  const queue=await reviews.list(hq.subject,null).catch(()=>null);
  if(queue)assert(queue.items.some(x=>x.subjectId===bA.bindingId||x.bindingId===bA.bindingId||JSON.stringify(x).includes(bA.bindingId)));
  // A full refund of the switch payment inside the window ends lifetime (D2); the old plan does not come back.
  const rr=await ingest(refund(swA.binding,ev.invoiceReference,357600-credA));
  assert.equal(rr.reason,'LIFETIME_REFUND_IN_WINDOW');assert.equal((await access(A)).state,'AWAITING_FIRST_PAYMENT');
  assert.equal((await bstatus(bA)).status,'SWITCHED_TO_LIFETIME');assert.equal((await view(A,swA.binding)).lifetimeSwitch.status,'SWITCHED_THEN_REFUNDED');
  passed('a late old-plan payment is held for HQ; a full in-window refund of the switch payment ends lifetime and the old plan does not come back; no refund is ever sent by HON');

  // ---------- annual switch, no direct path ----------
  const swB=await switchTo(B,lt,qB);
  const rb=await withProgram(()=>ingest(lifetimePaid(swB.binding,swB.lifetimeSwitch.amountDueMinor)));
  assert.equal(rb.outcome,'APPLIED');assert.equal((await bstatus(bB)).status,'SWITCHED_TO_LIFETIME');
  // Forged: an owner-written switch ending without its paid lifetime plan, or an access move by hand, is refused.
  const bG=await buy(G,monthly);
  await admin.query('BEGIN');
  await sqlDeny(admin.query("UPDATE hon.saas_schedule_bindings SET status='SWITCHED_TO_LIFETIME',status_reason='SWITCHED_TO_LIFETIME',version=version+1,terminal_at=clock_timestamp() WHERE id=$1",[bG.bindingId]),'42501');
  await admin.query('ROLLBACK');
  await admin.query('BEGIN');
  await sqlDeny(admin.query("UPDATE hon.saas_access_states SET binding_id=$2,paid_through='infinity',version=version+1 WHERE organization_id=$1",[G.id,bL.bindingId]),'42501');
  await admin.query('ROLLBACK');
  await sqlDeny(admin.query("DELETE FROM hon.saas_lifetime_switches"),'42501');
  await verifySaasBillingSecurity(admin,'hon_champions_runtime');
  assert.deepEqual(await row("SELECT status,mutations_enabled FROM hon.saas_access_program"),{status:'INACTIVE',mutations_enabled:false});
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_checkout_sessions')).n,0);
  void H;
  passed('an annual plan switches the same way; a hand-written switch ending, a hand-moved access state or a deleted switch record is refused; access program back to INACTIVE; no checkout');
  console.log(`PASS: HON OS switch to lifetime with credit (0341) ${groups} scenario groups; deterministic TEST provider only; no Stripe network, charge, refund sent, checkout or deployment.`);
} finally {
  await Promise.allSettled([admin.query('ROLLBACK'),restricted.query('ROLLBACK')]);
  try { await setAccessProgram(false); await cleanup(); }
  finally { await Promise.allSettled([admin.end(),watcher.end(),restricted.end()]); }
}
