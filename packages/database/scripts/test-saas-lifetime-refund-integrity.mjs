import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID as K } from 'node:crypto';
import { createRequire } from 'node:module';
import { pricingOffers, scheduleInput, acceptanceInput } from './price-acceptance-fixture.mjs';
import { generationInput } from './subscription-generation-fixture.mjs';
import { verifySaasBillingSecurity } from './saas-billing-security.mjs';

// 0309: a verified refund inside the refund window ends lifetime access (owner D2; the sale stays counted). Fixed
// disposable local fixture only: synthetic organizations, the deterministic TEST provider, no network, no charge, no refund
// sent anywhere, no checkout and no deployment.
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
const hq={id:K(),user:K(),subject:'lr-'+K()},operator={id:K(),user:K(),subject:'lr-'+K()};
const orgs=[];const principals=()=>[hq.id,operator.id,...orgs.map(o=>o.principal)];
const tables=['saas_lifetime_sales','saas_founder_allocations','saas_paid_review_resolutions','saas_access_transitions','saas_access_states','saas_schedule_reconciliations','saas_schedule_paid_periods','saas_schedule_provider_events','saas_schedule_bindings','saas_subscription_generations','saas_price_acceptances','saas_price_schedules'];
const row=async(q,p)=>(await admin.query(q,p)).rows[0];let groups=0;const passed=s=>console.log('PASS 0309 '+(++groups)+': '+s);
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
async function makeOrgs(n,label,entitlement='SUSPENDED'){
  const made=[];await admin.query('BEGIN');
  for(let i=0;i<n;i++){
    const o={label:label+i,id:K(),school:K(),role:K(),principal:K(),user:K(),subject:'lr-'+K()};
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'LR SYNTHETIC')",[o.user,o.subject,o.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','LR SYNTHETIC',true)",[o.principal,o.user]);
    await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'LR SYNTHETIC','LR SYNTHETIC')",[o.id]);
    await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'LR SYNTHETIC',$3,'UTC')",[o.school,o.id,'lr-'+o.school]);
    await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE',$2)",[o.id,entitlement]);
    await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','LR synthetic owner',true)",[o.role,o.id]);
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
  const d=await billing.createOfferSetDraft(hq.subject,{basedOnSetId:null,termsReference:'SYNTHETIC_LR_TERMS_V1',founderTotalLimit,offers},K());
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
  for(const q of ["SELECT hon.saas_schedule_end_lifetime_access(gen_random_uuid(),gen_random_uuid(),'evt_x',clock_timestamp())",
    "UPDATE hon.saas_schedule_bindings SET status='REFUNDED_ENDED'","UPDATE hon.saas_access_states SET state='AWAITING_FIRST_PAYMENT'",
    "INSERT INTO hon.saas_access_transitions(organization_id,kind,outcome,reason) VALUES(gen_random_uuid(),'SCHEDULE_REFUND_ENDED','APPLIED','LIFETIME_REFUND_IN_WINDOW')"])
    await sqlDeny(restricted.query(q),'42501');
  passed('the runtime has no direct path: it cannot end access, end a binding, move an access state or write an ending record; the billing inventory holds');

  await admin.query('BEGIN');
  for(const [h,role,perms] of [[hq,'HON_HQ_OWNER',[]],[operator,'HON_HQ_OPERATOR',['hq.billing.manage']]]){
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'LR SYNTHETIC')",[h.user,h.subject,h.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','LR SYNTHETIC',true)",[h.id,h.user]);
    await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[h.id,role,perms]);
  }
  await admin.query('COMMIT');
  await payments.setPaymentProgram(hq.subject,{action:'ENABLE_TEST_MODE',expectedVersion:1,provider:'STRIPE_SIMULATED',testTaxReference:'LR TEST TAX',authorizationReference:'LR TEST AUTHORIZATION'},K());


  const s1=await publish([...pricingOffers(),lifetimeOffer('LIFETIME',357600,20),lifetimeOffer('FOUNDER_LIFETIME',189600,5)],50);
  const lt=s1.schedules.LIFETIME,LT=s1.offers.LIFETIME.offerId;
  const ref=e=>e.invoiceReference;
  const counts=async()=>row("SELECT (SELECT count(*)::int FROM hon.saas_schedule_provider_events) events,(SELECT count(*)::int FROM hon.saas_access_transitions) transitions,(SELECT count(*)::int FROM hon.saas_schedule_reconciliations) reviews,(SELECT count(*)::int FROM hon.saas_lifetime_sales) sales");
  const entitlement=o=>row("SELECT status::text,effective_until IS NULL open,effective_until<=clock_timestamp() ended,version FROM hon.organization_entitlements WHERE organization_id=$1",[o.id]);
  const accessState=o=>row("SELECT state,reason,activation_source,binding_id,first_paid_period_id,paid_through FROM hon.saas_access_states WHERE organization_id=$1",[o.id]);
  async function buy(o,s=lt,active=false){
    const b=await signUp(o,s),e=lifetimePaid(b);
    if(active)await setAccessProgram(true);
    try{const r=await ingest(e);assert.equal(r.outcome,'APPLIED',JSON.stringify(r));return {b,e,r};}finally{if(active)await setAccessProgram(false);}
  }
  // Move the counted sale back in time (fixture only: the sale row is immutable, so its guard is lifted for this one write).
  async function soldDaysAgo(b,days){
    await admin.query('BEGIN');
    try{await admin.query('ALTER TABLE hon.saas_lifetime_sales DISABLE TRIGGER USER');
      await admin.query("UPDATE hon.saas_lifetime_sales SET sold_at=clock_timestamp()-make_interval(days=>$2) WHERE binding_id=$1",[b.bindingId,days]);
      await admin.query('ALTER TABLE hon.saas_lifetime_sales ENABLE TRIGGER USER');await admin.query('COMMIT');}
    catch(e){await admin.query('ROLLBACK');throw e;}
  }

  // ---------- a full refund inside the window ends access, in the same transaction ----------
  const [a,b2,c3,d4,e5,f6,g7]=await makeOrgs(7,'refund');for(const o of [a,b2,c3,d4,e5,f6,g7])await awaiting(o);
  const A=await buy(a,lt,true);
  assert.deepEqual([A.r.billingStatus,A.r.access.accessActivation],['ACTIVE','APPLIED']);
  assert.deepEqual(await entitlement(a),{status:'ACTIVE',open:true,ended:null,version:(await entitlement(a)).version});
  const before=await counts(),rA=refund(A.b,ref(A.e));
  const ended=await ingest(rA);
  assert.deepEqual([ended.outcome,ended.reason,ended.billingStatus,ended.access,ended.qualifyingPaidPeriodCount],
    ['APPLIED','LIFETIME_REFUND_IN_WINDOW','REFUNDED_ENDED',{accessActivation:'ENDED',accessGranted:false},1],JSON.stringify(ended));
  const ea=await entitlement(a);assert.deepEqual([ea.status,ea.open,ea.ended],['SUSPENDED',false,true],'the entitlement ends now');
  assert.deepEqual(await accessState(a),{state:'AWAITING_FIRST_PAYMENT',reason:'AWAITING_INITIAL_PAYMENT',activation_source:null,binding_id:null,first_paid_period_id:null,paid_through:null});
  const tA=await row("SELECT t.outcome,t.reason,t.provider_event_id,t.paid_period_id=q.id same_period,t.next_entitlement->>'status' next FROM hon.saas_access_transitions t JOIN hon.saas_schedule_paid_periods q ON q.binding_id=t.binding_id WHERE t.binding_id=$1 AND t.kind='SCHEDULE_REFUND_ENDED'",[A.b.bindingId]);
  assert.deepEqual(tA,{outcome:'APPLIED',reason:'LIFETIME_REFUND_IN_WINDOW',provider_event_id:rA.eventId,same_period:true,next:'SUSPENDED'});
  const bA=await row("SELECT status,status_reason,terminal_at IS NOT NULL terminal,activated_at IS NOT NULL activated FROM hon.saas_schedule_bindings WHERE id=$1",[A.b.bindingId]);
  assert.deepEqual(bA,{status:'REFUNDED_ENDED',status_reason:'LIFETIME_REFUND_IN_WINDOW',terminal:true,activated:true});
  const after=await counts();
  assert.deepEqual([after.events-before.events,after.transitions-before.transitions,after.reviews-before.reviews,after.sales-before.sales],[1,1,0,0],'one event, one ending record, nothing held, the sale stays counted');
  const viewA=await schedules.read(a.subject,a.school,A.b.bindingId);
  assert.deepEqual([viewA.status,viewA.statusReason,viewA.access],['REFUNDED_ENDED','LIFETIME_REFUND_IN_WINDOW',{accessActivation:'ENDED',reason:null,paidThrough:null,accessUntil:null}]);
  assert.equal((await schedules.readHq(hq.subject,A.b.bindingId)).access.accessActivation,'ENDED');
  assert.equal((await reviews.list(hq.subject,null)).items.some(i=>i.subjectId===A.b.bindingId),false,'an ended plan with nothing held is not in the HQ queue');
  passed('a full refund of the counted lifetime payment inside the window ends the binding (REFUNDED_ENDED), the entitlement (SUSPENDED, ends now) and the access state (back to awaiting) in one transaction; the school and HQ reads say ENDED; the sale stays counted');

  // ---------- the same refund delivered twice changes nothing more ----------
  const replay=await ingest(rA);
  assert.deepEqual(replay,ended);assert.deepEqual(await counts(),after);
  assert.equal((await entitlement(a)).version,ea.version);
  const second=await ingest(refund(A.b,ref(A.e)));
  assert.deepEqual([second.outcome,second.reason,second.billingStatus],['NEEDS_REVIEW','BINDING_NOT_COLLECTING','REFUNDED_ENDED'],'a second refund event for an ended plan is stored for review, never re-applied');
  assert.equal((await row("SELECT count(*)::int n FROM hon.saas_access_transitions WHERE binding_id=$1 AND kind='SCHEDULE_REFUND_ENDED'",[A.b.bindingId])).n,1);
  passed('the same refund event delivered again returns the stored receipt and writes nothing; a different refund event for the ended plan is stored for HQ review and ends nothing twice');

  // ---------- held for review: partial, after the window, dispute; inside the window on its last day ----------
  const B=await buy(b2);
  const partial=await ingest(refund(B.b,ref(B.e),100000));
  assert.deepEqual([partial.outcome,partial.reason,partial.billingStatus],['NEEDS_REVIEW','REVERSAL_REVIEW_REQUIRED','NEEDS_REVIEW']);
  const C=await buy(c3);await soldDaysAgo(C.b,31);
  const late=await ingest(refund(C.b,ref(C.e)));
  assert.deepEqual([late.outcome,late.reason,late.billingStatus],['NEEDS_REVIEW','REVERSAL_REVIEW_REQUIRED','NEEDS_REVIEW'],'day window + 1 is held for review');
  const D=await buy(d4);
  const disputed=await ingest(dispute(D.b,ref(D.e)));
  assert.deepEqual([disputed.outcome,disputed.reason,disputed.billingStatus],['NEEDS_REVIEW','REVERSAL_REVIEW_REQUIRED','NEEDS_REVIEW']);
  const E=await buy(e5);await soldDaysAgo(E.b,29);
  const lastDay=await ingest(refund(E.b,ref(E.e)));
  assert.deepEqual([lastDay.outcome,lastDay.billingStatus,lastDay.access.accessActivation],['APPLIED','REFUNDED_ENDED','ENDED'],'inside the window ends access');
  assert.deepEqual(await accessState(e5),{state:'AWAITING_FIRST_PAYMENT',reason:'AWAITING_INITIAL_PAYMENT',activation_source:null,binding_id:null,first_paid_period_id:null,paid_through:null},
    'access that was never switched on (program INACTIVE) stays awaiting');
  assert.equal((await entitlement(e5)).status,'SUSPENDED');
  for(const [o,x] of [[b2,B],[c3,C],[d4,D]]){
    assert.equal((await entitlement(o)).status,'SUSPENDED','held for review: nothing changes automatically');
    assert.equal((await row("SELECT count(*)::int n FROM hon.saas_access_transitions WHERE binding_id=$1 AND kind='SCHEDULE_REFUND_ENDED'",[x.b.bindingId])).n,0);
  }
  const items=(await reviews.list(hq.subject,null)).items;
  // Listed for HQ, unchanged from 0237: a reversal of a counted payment holds no money, so HQ sees it with nothing to refund.
  assert.deepEqual([B,C,D].map(x=>items.find(i=>i.subjectId===x.b.bindingId)?.blocker),['NO_HELD_PAYMENT','NO_HELD_PAYMENT','NO_HELD_PAYMENT']);
  assert.equal(await sales(LT),5,'every counted sale stays counted');
  passed('a partial refund, a refund on day window + 1 and a dispute are held for HQ review with nothing changed; a full refund on day window - 1 ends the plan (also when access was never switched on)');

  // ---------- a refund for another binding's invoice is refused ----------
  const F=await buy(f6);
  const foreign=await ingest(refund(F.b,ref(A.e)));
  assert.deepEqual([foreign.outcome,foreign.reason,foreign.billingStatus],['NEEDS_REVIEW','UNLINKED_REVERSAL','NEEDS_REVIEW']);
  assert.equal((await row("SELECT count(*)::int n FROM hon.saas_access_transitions WHERE binding_id=$1 AND kind='SCHEDULE_REFUND_ENDED'",[F.b.bindingId])).n,0);
  passed('a refund that names another binding\'s invoice is never applied: held as UNLINKED_REVERSAL, nothing ended');

  // ---------- buy again after the refund; money that reaches an ended plan is held and blocks a new sign-up ----------
  // The exact schedule this school accepted stays accepted once (0188); any other price on sale can be bought.
  assert.deepEqual((await preview(a,lt)).blockers,['ALREADY_ACCEPTED']);
  const again=await buy(a,s1.schedules.FOUNDER_LIFETIME,true);
  assert.deepEqual([again.r.billingStatus,again.r.access.accessActivation],['ACTIVE','APPLIED'],'the school may buy again after a refund that ended access');
  assert.deepEqual(await entitlement(a),{status:'ACTIVE',open:true,ended:null,version:(await entitlement(a)).version});
  assert.deepEqual([await sales(LT),await sales(s1.offers.FOUNDER_LIFETIME.offerId)],[6,1],'the re-purchase is a new counted sale; the refunded one is not returned');
  const stray=await ingest({...lifetimePaid(E.b)});
  assert.deepEqual([stray.outcome,stray.reason,stray.billingStatus],['NEEDS_REVIEW','PAID_AFTER_TERMINAL','REFUNDED_ENDED']);
  const strayItem=(await reviews.list(hq.subject,null)).items.find(i=>i.subjectId===E.b.bindingId);
  assert.deepEqual([strayItem?.heldAmountMinor,strayItem?.blocker],[357600,null],'the ending refund is not a reversal to review; the stray payment is refundable by HQ');
  const eGeneration=await generate(e5,s1.schedules.REGULAR_MONTHLY);
  await deny(()=>schedules.start(e5.subject,e5.school,bindInput(eGeneration),K()),422,'SAAS_BILLING_REVIEW_PENDING');
  // HQ records the refund it owes, the provider's refund of the stray payment is stored, HQ verifies it: the hold clears.
  const owed=await reviews.resolve(hq.subject,{subjectKind:'SCHEDULE_BINDING',subjectId:E.b.bindingId,expectedVersion:strayItem.subjectVersion,decision:'REFUND_OWED',
    reason:'Paid after this lifetime plan was refunded and ended',confirmation:c.SAAS_PAID_REVIEW_RESOLVE_CONFIRMATION},K());
  await ingest(refund(E.b,(await row("SELECT normalized->>'invoiceReference' r FROM hon.saas_schedule_provider_events WHERE provider_event_id=$1",[stray.providerEventId])).r));
  const verified=await reviews.verifyRefund(hq.subject,owed.resolution.resolutionId,{expectedVersion:1,confirmation:c.SAAS_PAID_REVIEW_VERIFY_CONFIRMATION},K());
  assert.deepEqual([verified.billingStatus,verified.billingReviewOpen],['REFUNDED_ENDED',false]);
  assert.equal((await schedules.start(e5.subject,e5.school,bindInput(eGeneration),K())).binding.status,'BOUND_TEST_ONLY','once HQ verified the refund the school may sign up again');
  passed('after an ending refund the school buys again (new sale; COMPLETE access again); a payment that reaches the ended plan is held, listed for HQ refund and blocks a new sign-up until HQ verifies its refund');

  // ---------- closed paths ----------
  const G=await buy(g7);
  const [m8]=await makeOrgs(1,'monthly');await awaiting(m8);
  const recurring=await signUp(m8,s1.schedules.REGULAR_MONTHLY);
  assert.equal((await ingest(paid(recurring))).billingStatus,'ACTIVE');
  for(const [q,p,code] of [
    ["UPDATE hon.saas_schedule_bindings SET status='REFUNDED_ENDED',status_reason='LIFETIME_REFUND_IN_WINDOW',terminal_at=clock_timestamp(),version=version+1 WHERE id=$1",[G.b.bindingId],'23514'],
    ["UPDATE hon.saas_schedule_bindings SET status='REFUNDED_ENDED',status_reason='LIFETIME_REFUND_IN_WINDOW',version=version+1 WHERE id=$1",[G.b.bindingId],'42501'],
    ["UPDATE hon.saas_schedule_bindings SET status='REFUNDED_ENDED',status_reason='LIFETIME_REFUND_IN_WINDOW',terminal_at=clock_timestamp(),version=version+1 WHERE id=$1",[recurring.bindingId],'42501'],
    ["UPDATE hon.saas_access_states SET state='AWAITING_FIRST_PAYMENT',reason='AWAITING_INITIAL_PAYMENT',activation_source=NULL,binding_id=NULL,first_paid_period_id=NULL,paid_through=NULL,version=version+1 WHERE organization_id=$1",[a.id],'42501'],
  ]){await admin.query('BEGIN');await sqlDeny((async()=>{await admin.query(q,p);await admin.query('COMMIT');})(),code);await admin.query('ROLLBACK');}
  await admin.query('BEGIN');
  await sqlDeny(admin.query("INSERT INTO hon.saas_access_transitions(organization_id,kind,outcome,reason,binding_id,paid_period_id,provider_event_id,prior_entitlement,next_entitlement,actor_principal_id,occurred_at) SELECT organization_id,kind,outcome,reason,binding_id,paid_period_id,provider_event_id,prior_entitlement,next_entitlement,actor_principal_id,occurred_at FROM hon.saas_access_transitions WHERE kind='SCHEDULE_REFUND_ENDED' AND binding_id=$1",[A.b.bindingId]),'23505');
  await admin.query('ROLLBACK');
  await verifySaasBillingSecurity(admin,'hon_champions_runtime');
  assert.deepEqual(await row("SELECT status,mutations_enabled FROM hon.saas_access_program"),{status:'INACTIVE',mutations_enabled:false});
  assert.equal((await row("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='saas_access_program_status_check'")).definition,STATUS_CHECK);
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_checkout_sessions')).n,0);
  passed('no direct path: an owner-written ending without the ingest audit fails at commit, a recurring plan can never be REFUNDED_ENDED, an active plan\'s access cannot be moved back by hand, one ending per binding; access program back to INACTIVE; no checkout');
  console.log(`PASS: HON OS lifetime refund ends access (0309) ${groups} scenario groups; deterministic TEST provider only; no Stripe network, charge, refund sent, checkout, credits or deployment.`);
} finally {
  await Promise.allSettled([admin.query('ROLLBACK'),restricted.query('ROLLBACK')]);
  try { await setAccessProgram(false); await cleanup(); }
  finally { await Promise.allSettled([admin.end(),watcher.end(),restricted.end()]); }
}
