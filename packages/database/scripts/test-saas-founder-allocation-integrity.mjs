import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID as K } from 'node:crypto';
import { createRequire } from 'node:module';
import { pricingOffers, scheduleInput, acceptanceInput } from './price-acceptance-fixture.mjs';
import { generationInput } from './subscription-generation-fixture.mjs';
import { verifySaasBillingSecurity } from './saas-billing-security.mjs';

// HON OS schedule billing piece 4 (0279): the founder 50-spot count. Fixed disposable local fixture only: synthetic
// organizations, the deterministic TEST provider, no network, no charge, no checkout and no deployment.
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
const apiRequire=createRequire(new URL('../../../apps/api/package.json',import.meta.url));
const c=apiRequire('@hon/contracts');
const {DeterministicScheduleProvider}=apiRequire('./test/fixtures/subscription-schedule-provider.cjs');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),pricing=new SaasPriceAcceptanceService(billing);
const generations=new SaasSubscriptionGenerationService(billing),provider=new DeterministicScheduleProvider(),schedules=new SaasScheduleBillingService(billing,provider);
const reviews=new SaasPaidReviewService(billing),founder=new SaasFounderService(billing),payments=new SaasPaymentsService(billing,database,{});
const client=u=>new pg.Client({connectionString:u.toString(),ssl:false}),admin=client(owner),watcher=client(owner),restricted=client(runtime);
const hq={id:K(),user:K(),subject:'p4-'+K()},operator={id:K(),user:K(),subject:'p4-'+K()};
const orgs=[];const principals=()=>[hq.id,operator.id,...orgs.map(o=>o.principal)];
const tables=['saas_founder_allocations','saas_paid_review_resolutions','saas_access_transitions','saas_access_states','saas_schedule_reconciliations','saas_schedule_paid_periods','saas_schedule_provider_events','saas_schedule_bindings','saas_subscription_generations','saas_price_acceptances','saas_price_schedules'];
const row=async(q,p)=>(await admin.query(q,p)).rows[0];let groups=0;const passed=s=>console.log('PASS 0279 '+(++groups)+': '+s);
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
    for(const t of [...tables,'saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets','saas_outbox','saas_audit','saas_requests']){
      await admin.query('ALTER TABLE hon.'+t+' DISABLE TRIGGER USER');
      if(t==='saas_outbox')await admin.query('DELETE FROM hon.saas_outbox WHERE audit_id IN (SELECT id FROM hon.saas_audit WHERE actor_principal_id=ANY($1::uuid[]))',[principals()]);
      else if(['saas_audit','saas_requests'].includes(t))await admin.query('DELETE FROM hon.'+t+' WHERE actor_principal_id=ANY($1::uuid[])',[principals()]);
      else await admin.query('DELETE FROM hon.'+t);
      await admin.query('ALTER TABLE hon.'+t+' ENABLE TRIGGER USER');
    }
    await admin.query('ALTER TABLE hon.saas_payment_program DISABLE TRIGGER USER');
    await admin.query("UPDATE hon.saas_payment_program SET status='DISABLED',provider=NULL,live_mode=false,test_tax_reference=NULL,authorization_reference=NULL,version=1,changed_by_principal_id=NULL,changed_at=clock_timestamp() WHERE program_id=1");
    await admin.query('ALTER TABLE hon.saas_payment_program ENABLE TRIGGER USER');
    await admin.query('COMMIT');
  } catch(e){await admin.query('ROLLBACK');throw e;}
}
// N synthetic organizations, each with one school and one purchaser (billing.hon.purchase on that exact school).
async function makeOrgs(n,label){
  const made=[];await admin.query('BEGIN');
  for(let i=0;i<n;i++){
    const o={label:label+i,id:K(),school:K(),role:K(),principal:K(),user:K(),subject:'p4-'+K()};
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'P4 SYNTHETIC')",[o.user,o.subject,o.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','P4 SYNTHETIC',true)",[o.principal,o.user]);
    await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'P4 SYNTHETIC','P4 SYNTHETIC')",[o.id]);
    await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'P4 SYNTHETIC',$3,'UTC')",[o.school,o.id,'p4-'+o.school]);
    await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE','SUSPENDED')",[o.id]);
    await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','P4 synthetic owner',true)",[o.role,o.id]);
    await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.hon.purchase')",[o.role,o.id]);
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
const refund=(b,ref,amountMinor)=>({...paid(b),eventType:'charge.refunded',invoiceReference:null,relatedInvoiceReference:ref,coveredPeriod:null,amountMinor});
const ingest=async e=>schedules.ingestVerifiedTestEvidence(e,await digest(e));
const preview=(o,s)=>pricing.preview(o.subject,o.school,s.scheduleId);
async function accept(o,s){return (await pricing.accept(o.subject,o.school,acceptanceInput(await preview(o,s)),K())).acceptance;}
async function generate(o,s){return (await generations.record(o.subject,o.school,generationInput(await accept(o,s)),K())).generation;}
const bindInput=g=>({generationId:g.generationId,generationDigest:g.generationDigest,confirmation:c.SAAS_SCHEDULE_BINDING_CONFIRMATION});
async function signUp(o,s){return (await schedules.start(o.subject,o.school,bindInput(await generate(o,s)),K())).binding;}
async function publish(offers,founderTotalLimit){
  const d=await billing.createOfferSetDraft(hq.subject,{basedOnSetId:null,termsReference:'SYNTHETIC_P4_TERMS_V1',founderTotalLimit,offers},K());
  const set=(await billing.publishOfferSet(hq.subject,d.set.setId,{expectedRevision:d.set.revision,previewDigest:d.preview.previewDigest,approval:c.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K())).set;
  const byKind=Object.fromEntries(set.offers.map(o=>[o.offerKind,o])),recorded={};
  for(const kind of c.SAAS_SCHEDULED_OFFER_KINDS)recorded[kind]=(await pricing.record(hq.subject,scheduleInput(byKind[kind],byKind[kind],0),K())).schedule;
  return {set,offers:byKind,schedules:recorded};
}
await Promise.all([admin,watcher,restricted].map(x=>x.connect()));
try {
  assert.equal((await row("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).marker,'HON disposable Champions Club validation');
  assert.deepEqual(await row("SELECT status,mutations_enabled FROM hon.saas_access_program"),{status:'INACTIVE',mutations_enabled:false});
  for(const t of tables)assert.equal((await row('SELECT count(*)::int n FROM hon.'+t)).n,0,'dedicated empty fixture required: '+t);
  await verifySaasBillingSecurity(admin,'hon_champions_runtime');
  assert.deepEqual(await row('SELECT pool_id,capacity,counting_rule FROM hon.saas_founder_pool'),{pool_id:1,capacity:50,counting_rule:'FIRST_VERIFIED_SCHEDULE_PAYMENT'});
  for(const q of ['UPDATE hon.saas_founder_pool SET capacity=51','UPDATE hon.saas_founder_pool SET capacity=50','DELETE FROM hon.saas_founder_pool','TRUNCATE hon.saas_founder_pool CASCADE',
    "INSERT INTO hon.saas_founder_pool VALUES(1,50,'FIRST_VERIFIED_SCHEDULE_PAYMENT',clock_timestamp())"]){await admin.query('BEGIN');await sqlDeny(admin.query(q),'42501');await admin.query('ROLLBACK');}
  for(const q of ['SELECT * FROM hon.saas_founder_pool','SELECT * FROM hon.saas_founder_allocations','UPDATE hon.saas_founder_pool SET capacity=capacity',
    "SELECT hon.saas_founder_unavailable_reason(gen_random_uuid(),gen_random_uuid())"])await sqlDeny(restricted.query(q),'42501');
  passed('one immutable pool of exactly 50 (owner cannot change, add or remove it); private tables, helpers and forced RLS');

  await admin.query('BEGIN');
  for(const [h,role,perms] of [[hq,'HON_HQ_OWNER',[]],[operator,'HON_HQ_OPERATOR',['hq.billing.manage']]]){
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'P4 SYNTHETIC')",[h.user,h.subject,h.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','P4 SYNTHETIC',true)",[h.id,h.user]);
    await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[h.id,role,perms]);
  }
  await admin.query('COMMIT');
  await payments.setPaymentProgram(hq.subject,{action:'ENABLE_TEST_MODE',expectedVersion:1,provider:'STRIPE_SIMULATED',testTaxReference:'P4 TEST TAX',authorizationReference:'P4 TEST AUTHORIZATION'},K());

  // ---------- locked founder terms ----------
  const s1=await publish(pricingOffers(),1);
  for(const kind of c.SAAS_SCHEDULED_OFFER_KINDS)assert.deepEqual(s1.schedules[kind].terms,c.honOsLaunchScheduleTerms(kind));
  assert.deepEqual([s1.schedules.FOUNDER_MONTHLY.terms.schemaVersion,s1.schedules.FOUNDER_MONTHLY.terms.initialPriceMinor,s1.schedules.FOUNDER_MONTHLY.terms.renewalPriceMinor,s1.schedules.FOUNDER_MONTHLY.terms.standardPriceMinor],[2,19920,19920,24900]);
  assert.deepEqual([s1.schedules.FOUNDER_ANNUAL.terms.initialPriceMinor,s1.schedules.FOUNDER_ANNUAL.terms.renewalPriceMinor,s1.schedules.FOUNDER_ANNUAL.terms.standardPriceMinor],[149400,149400,209700]);
  assert.equal(s1.schedules.REGULAR_MONTHLY.terms.schemaVersion,1);
  assert.match(s1.schedules.FOUNDER_MONTHLY.disclosureText,/^\$199\.20 per month for as long as this subscription stays active\. If it is canceled, or lapses for more than the 7-day grace period, a new subscription is at the standard price of \$249\.00 per month\./);
  await deny(()=>pricing.record(hq.subject,scheduleInput(s1.offers.FOUNDER_MONTHLY,s1.offers.REGULAR_MONTHLY,1),K()),422,'SAAS_PRICE_TERMS_UNSUPPORTED');
  // A founder offer published without the lock (or renewing at the current price) cannot get a schedule at all.
  const unlockedOffers=pricingOffers({FOUNDER_MONTHLY:{priceLock:'NONE'},FOUNDER_ANNUAL:{annualRenewal:'AUTO_RENEW_AT_CURRENT_PRICE'}});
  const ud=await billing.createOfferSetDraft(hq.subject,{basedOnSetId:null,termsReference:'SYNTHETIC_P4_UNLOCKED',founderTotalLimit:50,offers:unlockedOffers},K());
  const us=(await billing.publishOfferSet(hq.subject,ud.set.setId,{expectedRevision:ud.set.revision,previewDigest:ud.preview.previewDigest,approval:c.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K())).set;
  for(const kind of ['FOUNDER_MONTHLY','FOUNDER_ANNUAL']){const o=us.offers.find(x=>x.offerKind===kind);await deny(()=>pricing.record(hq.subject,scheduleInput(o,o,0),K()),422,'SAAS_PRICE_TERMS_UNSUPPORTED');}
  passed('founder terms v2: $199.20/$1,494 locked while subscribed, renewal at the same price, standard return price disclosed; step-up renewal and unlocked founder offers refused; standard terms unchanged (v1)');

  // ---------- counted at the first verified payment, never at sign-up ----------
  // The unlocked set superseded S1, so publish a fresh set with a founder limit of 1 for the limit checks.
  const limited=await publish(pricingOffers(),1);
  const [o1,o2]=await makeOrgs(2,'limit');
  const view0=await founder.schoolAvailability(o1.subject,o1.school);
  assert.deepEqual([view0.pool.allocated,view0.pool.remaining,view0.spotReserved,view0.organizationUsedFounderSpot,view0.offers.map(x=>[x.offerKind,x.available,x.reason])],
    [0,50,false,false,[['FOUNDER_MONTHLY',true,null],['FOUNDER_ANNUAL',true,null]]]);
  assert.deepEqual(view0.offers.map(x=>[x.priceMinor,x.standardPriceMinor]),[[19920,24900],[149400,209700]]);
  await admin.query("INSERT INTO hon.saas_access_states(organization_id,state,reason,version,changed_by_principal_id,created_at,updated_at) VALUES($1,'AWAITING_FIRST_PAYMENT','AWAITING_INITIAL_PAYMENT',1,$2,clock_timestamp(),clock_timestamp())",[o1.id,hq.id]);
  const b1=await signUp(o1,limited.schedules.FOUNDER_MONTHLY);
  assert.deepEqual([b1.status,b1.requirements.lockedPriceMinor,b1.requirements.priceRule],['BOUND_TEST_ONLY',19920,'LOCKED_WHILE_SUBSCRIBED']);
  assert.equal(await spots(),0,'an unpaid founder sign-up holds no spot (OD-4)');
  // A failed attempt and a wrong amount count nothing.
  assert.equal((await ingest({...paid(b1),eventType:'invoice.payment_failed'})).outcome,'ATTEMPT_FAILED');assert.equal(await spots(),0);
  // The first verified payment switches on access (program active only inside this disposable fixture) with the counted spot.
  let first;await setAccessProgram(true);try{first=await ingest(paid(b1));}finally{await setAccessProgram(false);}
  assert.deepEqual([first.outcome,first.billingStatus,first.qualifyingPaidPeriodCount,first.access.accessActivation],['APPLIED','ACTIVE',1,'APPLIED'],JSON.stringify(first.access));
  assert.deepEqual(await row('SELECT spot_number,organization_id,offer_kind,locked_price_minor FROM hon.saas_founder_allocations'),{spot_number:1,organization_id:o1.id,offer_kind:'FOUNDER_MONTHLY',locked_price_minor:19920});
  const renewal=await ingest(paid(b1,1));
  assert.deepEqual([renewal.outcome,renewal.qualifyingPaidPeriodCount],['APPLIED',2]);assert.equal(await spots(),1,'a renewal at the locked price never counts another spot');
  assert.equal((await ingest(paid(b1,2,24900))).reason,'AMOUNT_MISMATCH','the locked founder price is the only accepted amount while subscribed');
  // The set limit (1) is reached; the organization that holds a spot can never get another.
  assert.deepEqual((await preview(o2,limited.schedules.FOUNDER_ANNUAL)).blockers,['FOUNDER_SET_LIMIT_REACHED']);
  passed('a spot is counted only by the first verified founder payment (not sign-up, failed attempt or renewal); first payment activates access with that spot; set founder limit honored');

  const s2=await publish(pricingOffers({FOUNDER_ANNUAL:{saleLimit:1}}),50);
  assert.deepEqual((await preview(o1,s2.schedules.FOUNDER_MONTHLY)).blockers,['FOUNDER_ALREADY_USED']);
  assert.deepEqual((await founder.schoolAvailability(o1.subject,o1.school)).offers.map(x=>x.reason),['FOUNDER_ALREADY_USED','FOUNDER_ALREADY_USED']);
  const b2=await signUp(o2,s2.schedules.FOUNDER_ANNUAL);
  assert.deepEqual([(await ingest(paid(b2))).billingStatus,await spots()],['ACTIVE',2]);
  const [o3]=await makeOrgs(1,'offer');
  assert.deepEqual((await preview(o3,s2.schedules.FOUNDER_ANNUAL)).blockers,['FOUNDER_OFFER_LIMIT_REACHED']);
  assert.deepEqual((await preview(o3,s2.schedules.FOUNDER_MONTHLY)).blockers,[]);
  passed('one founder spot per organization ever (FOUNDER_ALREADY_USED); founder offer sale limit honored per offer');

  // ---------- 1 .. 49, then the race for the 50th ----------
  const fill=await makeOrgs(47,'fill');fill.unshift(o3);fill.pop();
  for(const o of fill){const b=await signUp(o,s2.schedules.FOUNDER_MONTHLY);assert.equal((await ingest(paid(b))).billingStatus,'ACTIVE');}
  assert.equal(await spots(),49);
  const [racerA,racerB,lateAccepted,lateGenerated,soldOutOrg]=await makeOrgs(5,'race');
  const [bA,bB]=[await signUp(racerA,s2.schedules.FOUNDER_MONTHLY),await signUp(racerB,s2.schedules.FOUNDER_MONTHLY)];
  const lateAcceptance=await accept(lateAccepted,s2.schedules.FOUNDER_MONTHLY),lateGeneration=await generate(lateGenerated,s2.schedules.FOUNDER_MONTHLY);
  assert.equal((await founder.schoolAvailability(racerA.subject,racerA.school)).pool.remaining,1,'49 counted; signed-up plans hold nothing');
  // Real lock waits: hold the pool row, start both first payments, prove both wait on it, then release.
  await admin.query('BEGIN');await admin.query('SELECT 1 FROM hon.saas_founder_pool WHERE pool_id=1 FOR UPDATE');
  const holder=(await row('SELECT pg_backend_pid() p')).p,pending=Promise.allSettled([ingest(paid(bA)),ingest(paid(bB))]);
  for(const until=Date.now()+8000;;){
    // The first waits on the holder; the second queues behind the first (or the holder): both are blocked.
    const n=(await watcher.query('SELECT count(*)::int n FROM pg_stat_activity WHERE pid<>$1 AND cardinality(pg_blocking_pids(pid))>0 AND (SELECT bool_or($1=ANY(pg_blocking_pids(x.pid))) FROM pg_stat_activity x WHERE cardinality(pg_blocking_pids(x.pid))>0)',[holder])).rows[0].n;
    if(n>=2)break;if(Date.now()>until)throw Error('expected both first payments to wait on the pool lock');await new Promise(r=>setTimeout(r,20));
  }
  await admin.query('COMMIT');
  const race=(await pending).map(r=>{if(r.status==='rejected')throw r.reason;return r.value;});
  const winner=race.find(r=>r.outcome==='APPLIED'),loser=race.find(r=>r.outcome!=='APPLIED');
  assert(winner&&loser,'exactly one of two concurrent first payments counts the last spot');
  assert.deepEqual([winner.billingStatus,loser.outcome,loser.reason,loser.billingStatus,loser.qualifyingPaidPeriodCount],['ACTIVE','NEEDS_REVIEW','FOUNDER_SPOT_UNAVAILABLE','NEEDS_REVIEW',0]);
  assert.equal(await spots(),50);
  assert.deepEqual((await admin.query('SELECT spot_number FROM hon.saas_founder_allocations ORDER BY spot_number')).rows.map(r=>r.spot_number),Array.from({length:50},(_,i)=>i+1));
  const loserBinding=loser.bindingId===bA.bindingId?bA:bB,loserOrg=loser.bindingId===bA.bindingId?racerA:racerB;
  assert.equal((await row("SELECT count(*)::int n FROM hon.saas_schedule_reconciliations WHERE binding_id=$1 AND reason='FOUNDER_SPOT_UNAVAILABLE'",[loserBinding.bindingId])).n,1);
  passed('spots 1..49 counted one per paid organization; two concurrent first payments for the 50th (both proven waiting on the pool lock): exactly one counted, the other payment held for review (kept, never counted, never auto-refunded)');

  // ---------- sold out: refused before any charge ----------
  assert.deepEqual((await preview(soldOutOrg,s2.schedules.FOUNDER_MONTHLY)).blockers,['FOUNDER_SOLD_OUT']);
  await deny(async()=>pricing.accept(soldOutOrg.subject,soldOutOrg.school,acceptanceInput(await preview(soldOutOrg,s2.schedules.FOUNDER_MONTHLY)),K()),422,'SAAS_PRICE_ACCEPTANCE_BLOCKED');
  await deny(()=>generations.record(lateAccepted.subject,lateAccepted.school,generationInput(lateAcceptance),K()),422,'SAAS_FOUNDER_UNAVAILABLE');
  const callsBefore=provider.calls;
  await deny(()=>schedules.start(lateGenerated.subject,lateGenerated.school,bindInput(lateGeneration),K()),422,'SAAS_FOUNDER_UNAVAILABLE');
  assert.equal(provider.calls,callsBefore,'a refused founder sign-up never reaches the provider');
  assert.deepEqual((await preview(soldOutOrg,s2.schedules.REGULAR_MONTHLY)).blockers,[],'standard plans stay on sale');
  const soldView=await founder.schoolAvailability(soldOutOrg.subject,soldOutOrg.school);
  assert.deepEqual([soldView.pool.remaining,soldView.offers.map(x=>x.reason)],[0,['FOUNDER_SOLD_OUT','FOUNDER_SOLD_OUT']]);
  const hqView=await founder.pool(operator.subject);
  assert.deepEqual([hqView.capacity,hqView.allocated,hqView.remaining,hqView.heldWithoutSpot,hqView.spots.length,hqView.legacyFounderSalesCounted],[50,50,0,1,50,false]);
  await deny(()=>founder.pool(soldOutOrg.subject),403,'SAAS_FORBIDDEN');
  await deny(()=>founder.schoolAvailability(soldOutOrg.subject,racerA.school),403,'SAAS_FORBIDDEN');
  passed('once 50 are counted: founder acceptance, generation and sign-up refused before any charge or provider call; standard plans unaffected; HQ and school reads exact and isolated');

  // ---------- the held payment: HQ refund, then the school can leave and buy standard ----------
  const cancel=()=>schedules.cancelBeforePayment(loserOrg.subject,loserOrg.school,loserBinding.bindingId,K());
  await deny(cancel,422,'SAAS_SCHEDULE_BINDING_NOT_CANCELLABLE');
  const items=(await reviews.list(hq.subject,null)).items,item=items.find(i=>i.subjectId===loserBinding.bindingId);
  assert.deepEqual([item.reason,item.heldAmountMinor,item.blocker,item.allowedDecisions],['FOUNDER_SPOT_UNAVAILABLE',19920,null,['REFUND_OWED']]);
  const owed=await reviews.resolve(hq.subject,{subjectKind:'SCHEDULE_BINDING',subjectId:loserBinding.bindingId,expectedVersion:item.subjectVersion,decision:'REFUND_OWED',
    reason:'Founder spots were all counted before this payment',confirmation:c.SAAS_PAID_REVIEW_RESOLVE_CONFIRMATION},K());
  const heldRef=(await row("SELECT normalized->>'invoiceReference' r FROM hon.saas_schedule_provider_events WHERE binding_id=$1 AND event_type='invoice.paid' AND outcome='NEEDS_REVIEW'",[loserBinding.bindingId])).r;
  await ingest(refund(loserBinding,heldRef,19920));
  await deny(cancel,422,'SAAS_SCHEDULE_BINDING_NOT_CANCELLABLE');
  const verified=await reviews.verifyRefund(hq.subject,owed.resolution.resolutionId,{expectedVersion:1,confirmation:c.SAAS_PAID_REVIEW_VERIFY_CONFIRMATION},K());
  assert.deepEqual([verified.billingStatus,verified.billingReviewOpen],['BOUND_TEST_ONLY',false],'the sign-up carries on as before (waiting for a first payment)');
  assert.equal(await spots(),50,'a refund never returns or creates a spot');
  const cancelled=await cancel();
  assert.deepEqual([cancelled.binding.status,cancelled.binding.statusReason],['CANCELLED_BEFORE_PAYMENT','PURCHASER_CANCELLED_BEFORE_PAYMENT']);
  const standard=await signUp(loserOrg,s2.schedules.REGULAR_MONTHLY);
  assert.deepEqual([standard.status,standard.requirements.lockedPriceMinor],['BOUND_TEST_ONLY',24900]);
  assert.equal((await founder.pool(hq.subject)).heldWithoutSpot,0);
  // A paid (counted) founder plan is never cancellable this way.
  await deny(()=>schedules.cancelBeforePayment(o1.subject,o1.school,b1.bindingId,K()),422,'SAAS_SCHEDULE_BINDING_NOT_CANCELLABLE');
  passed('held payment listed for HQ as FOUNDER_SPOT_UNAVAILABLE; refund obligation, provider refund evidence and verification return the sign-up to waiting; only then may the school cancel and sign up at the standard price; spots never returned');

  // ---------- closed records ----------
  for(const q of ['UPDATE hon.saas_founder_allocations SET spot_number=spot_number','DELETE FROM hon.saas_founder_allocations','TRUNCATE hon.saas_founder_allocations']){
    await admin.query('BEGIN');await sqlDeny(admin.query(q),'42501');await admin.query('ROLLBACK');}
  const a1=await row('SELECT * FROM hon.saas_founder_allocations WHERE spot_number=1');
  await admin.query('BEGIN');
  await sqlDeny(admin.query("INSERT INTO hon.saas_founder_allocations(spot_number,organization_id,school_id,binding_id,paid_period_id,provider_event_id,offer_id,offer_set_id,offer_kind,locked_price_minor,allocated_at) VALUES(51,$1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())",
    [soldOutOrg.id,soldOutOrg.school,a1.binding_id,a1.paid_period_id,a1.provider_event_id,a1.offer_id,a1.offer_set_id,a1.offer_kind,a1.locked_price_minor]),'23514');
  await admin.query('ROLLBACK');
  for(const q of ['INSERT INTO hon.saas_founder_allocations SELECT * FROM hon.saas_founder_allocations LIMIT 1','DELETE FROM hon.saas_founder_allocations'])await sqlDeny(restricted.query(q),'42501');
  await verifySaasBillingSecurity(admin,'hon_champions_runtime');
  assert.deepEqual(await row("SELECT status,mutations_enabled FROM hon.saas_access_program"),{status:'INACTIVE',mutations_enabled:false});
  assert.equal((await row("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='saas_access_program_status_check'")).definition,STATUS_CHECK);
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_checkout_sessions')).n,0);
  passed('spots are immutable (no edit, delete or truncate even by the owner); a forged 51st spot is refused; runtime has no table path; access program back to INACTIVE; no checkout created');
  console.log(`PASS: HON OS founder 50-spot count (0279) ${groups} scenario groups; deterministic TEST provider only; no Stripe network, charge, checkout, trial, credits or deployment.`);
} finally {
  await Promise.allSettled([admin.query('ROLLBACK'),restricted.query('ROLLBACK')]);
  try { await setAccessProgram(false); await cleanup(); }
  finally { await Promise.allSettled([admin.end(),watcher.end(),restricted.end()]); }
}
