import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID as K } from 'node:crypto';
import { createRequire } from 'node:module';
import { pricingOffers, scheduleInput, acceptanceInput } from './price-acceptance-fixture.mjs';
import { generationInput } from './subscription-generation-fixture.mjs';
import { verifySaasBillingSecurity } from './saas-billing-security.mjs';

// HON OS lifetime purchase through the schedule path (0306). Fixed disposable local fixture only: synthetic organizations,
// the deterministic TEST provider, no network, no charge, no checkout and no deployment.
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
const hq={id:K(),user:K(),subject:'lt-'+K()},operator={id:K(),user:K(),subject:'lt-'+K()};
const orgs=[];const principals=()=>[hq.id,operator.id,...orgs.map(o=>o.principal)];
const tables=['saas_lifetime_sales','saas_founder_allocations','saas_paid_review_resolutions','saas_access_transitions','saas_access_states','saas_schedule_reconciliations','saas_schedule_paid_periods','saas_schedule_provider_events','saas_schedule_bindings','saas_subscription_generations','saas_price_acceptances','saas_price_schedules'];
const row=async(q,p)=>(await admin.query(q,p)).rows[0];let groups=0;const passed=s=>console.log('PASS 0306 '+(++groups)+': '+s);
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
    const o={label:label+i,id:K(),school:K(),role:K(),principal:K(),user:K(),subject:'lt-'+K()};
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'LT SYNTHETIC')",[o.user,o.subject,o.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','LT SYNTHETIC',true)",[o.principal,o.user]);
    await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'LT SYNTHETIC','LT SYNTHETIC')",[o.id]);
    await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'LT SYNTHETIC',$3,'UTC')",[o.school,o.id,'lt-'+o.school]);
    await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE',$2)",[o.id,entitlement]);
    await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','LT synthetic owner',true)",[o.role,o.id]);
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
const refund=(b,ref,amountMinor)=>({...paid(b),eventType:'charge.refunded',invoiceReference:null,relatedInvoiceReference:ref,coveredPeriod:null,amountMinor});
const ingest=async e=>schedules.ingestVerifiedTestEvidence(e,await digest(e));
const preview=(o,s)=>pricing.preview(o.subject,o.school,s.scheduleId);
async function accept(o,s){return (await pricing.accept(o.subject,o.school,acceptanceInput(await preview(o,s)),K())).acceptance;}
async function generate(o,s){return (await generations.record(o.subject,o.school,generationInput(await accept(o,s)),K())).generation;}
const bindInput=g=>({generationId:g.generationId,generationDigest:g.generationDigest,confirmation:c.SAAS_SCHEDULE_BINDING_CONFIRMATION});
async function signUp(o,s){return (await schedules.start(o.subject,o.school,bindInput(await generate(o,s)),K())).binding;}
async function publish(offers,founderTotalLimit){
  const d=await billing.createOfferSetDraft(hq.subject,{basedOnSetId:null,termsReference:'SYNTHETIC_LT_TERMS_V1',founderTotalLimit,offers},K());
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
  for(const q of ['SELECT * FROM hon.saas_lifetime_sales','SELECT hon.saas_lifetime_unavailable_reason(gen_random_uuid())',
    'INSERT INTO hon.saas_lifetime_sales SELECT * FROM hon.saas_lifetime_sales'])await sqlDeny(restricted.query(q),'42501');
  passed('private lifetime sales table and helpers (runtime has no table or helper path); forced RLS and the billing inventory hold');

  await admin.query('BEGIN');
  for(const [h,role,perms] of [[hq,'HON_HQ_OWNER',[]],[operator,'HON_HQ_OPERATOR',['hq.billing.manage']]]){
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'LT SYNTHETIC')",[h.user,h.subject,h.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','LT SYNTHETIC',true)",[h.id,h.user]);
    await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[h.id,role,perms]);
  }
  await admin.query('COMMIT');
  await payments.setPaymentProgram(hq.subject,{action:'ENABLE_TEST_MODE',expectedVersion:1,provider:'STRIPE_SIMULATED',testTaxReference:'LT TEST TAX',authorizationReference:'LT TEST AUTHORIZATION'},K());

  // ---------- one-time terms (v3) ----------
  const s1=await publish([...pricingOffers(),lifetimeOffer('LIFETIME',357600,2),lifetimeOffer('FOUNDER_LIFETIME',189600,1)],50);
  for(const kind of c.SAAS_SCHEDULED_OFFER_KINDS)assert.deepEqual(s1.schedules[kind].terms,c.honOsLaunchScheduleTerms(kind),'recurring terms unchanged');
  const lt=s1.schedules.LIFETIME,flt=s1.schedules.FOUNDER_LIFETIME;
  assert.deepEqual(lt.terms,c.validateSaasLifetimeTermsV3(lt.terms));
  assert.deepEqual([lt.terms.schemaVersion,lt.terms.billingInterval,lt.terms.initialPriceMinor,lt.terms.renewalPriceMinor,lt.terms.renewalPriceRule,lt.cancellationTerms.timing,lt.refundTerms.windowDays],
    [3,'ONE_TIME',357600,357600,'NO_RENEWAL_ONE_TIME',null,30]);
  assert.equal(lt.disclosureText,'$3,576.00 paid once for lifetime HON OS access. It never renews and is never charged again. Sale limit: 2. A sale is counted only when the payment is verified, and if the limit is reached first, that payment is held for review and refunded. A refund within the 30-day refund window ends lifetime access. AI use follows the fair-use terms: SYNTHETIC_FAIR_USE_V1.');
  assert.match(flt.disclosureText,/Sale limit: 1\..*Founder lifetime does not use one of the 50 founder spots\./);
  await deny(()=>pricing.record(hq.subject,scheduleInput(s1.offers.LIFETIME,s1.offers.REGULAR_MONTHLY,1),K()),422,'SAAS_PRICE_TERMS_UNSUPPORTED');
  passed('lifetime and founder lifetime get one-time terms v3 (paid once, never renews, own sale limit, refund window, fair use, no founder spot) with an exact disclosure; a renewal offer is refused; recurring terms byte-identical');

  // ---------- sign-up, first verified payment, open-ended access ----------
  const [o1,o2,o3]=await makeOrgs(3,'buy');for(const o of [o1,o2,o3])await awaiting(o);
  const b1=await signUp(o1,lt);
  assert.deepEqual([b1.status,b1.requirements.billingInterval,b1.requirements.priceRule,b1.requirements.lockedPriceMinor,b1.requirements.cancellationTerms.timing],
    ['BOUND_TEST_ONLY','ONE_TIME','ONE_TIME_PURCHASE',357600,null]);
  assert.equal(await sales(s1.offers.LIFETIME.offerId),0,'an unpaid lifetime sign-up holds no sale');
  // A recurring-shaped payment (with an end) is not a lifetime payment; a lifetime-shaped one is not a monthly payment.
  await deny(()=>ingest(paid({...b1,requirements:{...b1.requirements,billingInterval:'MONTHLY'}})),400,'INVALID_SAAS_INPUT');
  const bm=await signUp(o3,s1.schedules.REGULAR_MONTHLY);
  await deny(()=>ingest(lifetimePaid(bm)),400,'INVALID_SAAS_INPUT');
  assert.equal((await ingest(lifetimePaid(b1,357500))).reason,'AMOUNT_MISMATCH');
  const [o4]=await makeOrgs(1,'buy2');await awaiting(o4);
  const b4=await signUp(o4,lt);
  let first;await setAccessProgram(true);try{first=await ingest(lifetimePaid(b4));}finally{await setAccessProgram(false);}
  assert.deepEqual([first.outcome,first.billingStatus,first.qualifyingPaidPeriodCount,first.access.accessActivation],['APPLIED','ACTIVE',1,'APPLIED'],JSON.stringify(first));
  assert.deepEqual(await row('SELECT sale_number,organization_id,offer_kind,price_minor FROM hon.saas_lifetime_sales'),{sale_number:1,organization_id:o4.id,offer_kind:'LIFETIME',price_minor:357600});
  const ent=await row("SELECT tier::text,status::text,effective_until FROM hon.organization_entitlements WHERE organization_id=$1",[o4.id]);
  assert.deepEqual(ent,{tier:'COMPLETE',status:'ACTIVE',effective_until:null},'lifetime access never ends by time');
  assert.equal((await row("SELECT paid_through::text p FROM hon.saas_access_states WHERE organization_id=$1",[o4.id])).p,'infinity');
  assert.equal((await row("SELECT covered_ends_at::text e FROM hon.saas_schedule_paid_periods WHERE binding_id=$1",[b4.bindingId])).e,'infinity');
  const view=await schedules.read(o4.subject,o4.school,b4.bindingId);
  assert.deepEqual([view.status,view.access],['ACTIVE',{accessActivation:'APPLIED',reason:null,paidThrough:null,accessUntil:null}]);
  // Nothing renews: any later payment overlaps the open-ended period and is held for review, never counted.
  const second=await ingest(lifetimePaid(b4));
  assert.deepEqual([second.outcome,second.reason,second.qualifyingPaidPeriodCount],['NEEDS_REVIEW','OVERLAPPING_COVERED_PERIOD',1]);
  assert.equal(await sales(s1.offers.LIFETIME.offerId),1);
  passed('lifetime sign-up binds ONE_TIME at the locked price (no sale held); the first verified payment counts sale 1 and gives COMPLETE access with no end; wrong shape or amount refused or reviewed; a second payment is held, never counted');

  // ---------- founder lifetime: own limit, never the founder pool ----------
  const bf=await signUp(o2,flt);
  const fpaid=await ingest(lifetimePaid(bf));
  assert.deepEqual([fpaid.outcome,fpaid.billingStatus,fpaid.access.reason],['APPLIED','ACTIVE','ACCESS_PROGRAM_INACTIVE']);
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_founder_allocations')).n,0,'founder lifetime never uses a founder spot (owner D1)');
  assert.equal(await sales(s1.offers.FOUNDER_LIFETIME.offerId),1);
  const [o5]=await makeOrgs(1,'soldout','ACTIVE');
  assert.deepEqual((await preview(o5,flt)).blockers,['LIFETIME_SOLD_OUT']);
  assert.deepEqual((await preview(o5,s1.schedules.FOUNDER_MONTHLY)).blockers,[],'the founder pool is untouched by founder lifetime');
  await admin.query("UPDATE hon.organization_entitlements SET effective_from=clock_timestamp()-interval '1 day' WHERE organization_id=$1",[o5.id]);
  const offers=await billing.readSchoolHonOsOffers(o5.subject,o5.school);
  assert.deepEqual(offers.offers.filter(x=>x.billingInterval==='ONE_TIME').map(x=>[x.offerKind,x.eligibility]),[['LIFETIME','ELIGIBLE'],['FOUNDER_LIFETIME','SOLD_OUT']],
    'the school offers read shows a sold-out lifetime offer as SOLD_OUT, and never FOUNDER_SOLD_OUT for founder lifetime');
  passed('founder lifetime counts against its own HQ sale limit only (no founder spot); once sold out the preview and the school offers read say SOLD_OUT; founder monthly still on sale');

  // ---------- the last LIFETIME sale: concurrent first payments ----------
  const [racerA,racerB,lateAccepted,lateGenerated]=await makeOrgs(4,'race');
  const [bA,bB]=[await signUp(racerA,lt),await signUp(racerB,lt)];
  const lateAcceptance=await accept(lateAccepted,lt),lateGeneration=await generate(lateGenerated,lt);
  await admin.query('BEGIN');await admin.query('SELECT 1 FROM hon.saas_offer_set_offers WHERE id=$1 FOR UPDATE',[s1.offers.LIFETIME.offerId]);
  const holder=(await row('SELECT pg_backend_pid() p')).p,pending=Promise.allSettled([ingest(lifetimePaid(bA)),ingest(lifetimePaid(bB))]);
  for(const until=Date.now()+8000;;){
    const n=(await watcher.query('SELECT count(*)::int n FROM pg_stat_activity WHERE pid<>$1 AND cardinality(pg_blocking_pids(pid))>0 AND (SELECT bool_or($1=ANY(pg_blocking_pids(x.pid))) FROM pg_stat_activity x WHERE cardinality(pg_blocking_pids(x.pid))>0)',[holder])).rows[0].n;
    if(n>=2)break;if(Date.now()>until)throw Error('expected both first payments to wait on the offer row lock');await new Promise(r=>setTimeout(r,20));
  }
  await admin.query('COMMIT');
  const race=(await pending).map(r=>{if(r.status==='rejected')throw r.reason;return r.value;});
  const winner=race.find(r=>r.outcome==='APPLIED'),loser=race.find(r=>r.outcome!=='APPLIED');
  assert(winner&&loser,'exactly one of two concurrent first payments counts the last sale');
  assert.deepEqual([winner.billingStatus,loser.outcome,loser.reason,loser.billingStatus,loser.qualifyingPaidPeriodCount],['ACTIVE','NEEDS_REVIEW','LIFETIME_SALE_LIMIT_REACHED','NEEDS_REVIEW',0]);
  assert.deepEqual((await admin.query('SELECT sale_number FROM hon.saas_lifetime_sales WHERE offer_id=$1 ORDER BY sale_number',[s1.offers.LIFETIME.offerId])).rows.map(r=>r.sale_number),[1,2]);
  const item=(await reviews.list(hq.subject,null)).items.find(i=>i.subjectId===loser.bindingId);
  assert.deepEqual([item.reason,item.heldAmountMinor,item.blocker,item.allowedDecisions],['LIFETIME_SALE_LIMIT_REACHED',357600,null,['REFUND_OWED']]);
  passed('two concurrent first payments for the last lifetime sale (both proven waiting on the offer row lock): exactly one counted, the other held for HQ refund (LIFETIME_SALE_LIMIT_REACHED), listed in the HQ queue');

  // ---------- sold out: refused before any charge ----------
  await deny(()=>generations.record(lateAccepted.subject,lateAccepted.school,generationInput(lateAcceptance),K()),422,'SAAS_LIFETIME_SOLD_OUT');
  const callsBefore=provider.calls;
  await deny(()=>schedules.start(lateGenerated.subject,lateGenerated.school,bindInput(lateGeneration),K()),422,'SAAS_LIFETIME_SOLD_OUT');
  assert.equal(provider.calls,callsBefore,'a refused lifetime sign-up never reaches the provider');
  passed('once the limit is counted: lifetime generation and sign-up refused before any provider call');

  // ---------- closed records ----------
  for(const q of ['UPDATE hon.saas_lifetime_sales SET sale_number=sale_number','DELETE FROM hon.saas_lifetime_sales','TRUNCATE hon.saas_lifetime_sales']){
    await admin.query('BEGIN');await sqlDeny(admin.query(q),'42501');await admin.query('ROLLBACK');}
  const s=await row('SELECT * FROM hon.saas_lifetime_sales WHERE sale_number=1 AND offer_id=$1',[s1.offers.LIFETIME.offerId]);
  await admin.query('BEGIN');
  await sqlDeny(admin.query("INSERT INTO hon.saas_lifetime_sales(sale_number,offer_id,offer_set_id,offer_kind,organization_id,school_id,binding_id,paid_period_id,provider_event_id,price_minor,sold_at) VALUES(3,$1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())",
    [s.offer_id,s.offer_set_id,s.offer_kind,o5.id,o5.school,s.binding_id,s.paid_period_id,s.provider_event_id,s.price_minor]),'23514');
  await admin.query('ROLLBACK');
  await verifySaasBillingSecurity(admin,'hon_champions_runtime');
  assert.deepEqual(await row("SELECT status,mutations_enabled FROM hon.saas_access_program"),{status:'INACTIVE',mutations_enabled:false});
  assert.equal((await row("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='saas_access_program_status_check'")).definition,STATUS_CHECK);
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_checkout_sessions')).n,0);
  passed('lifetime sales are immutable (no edit, delete or truncate even by the owner); a forged extra sale is refused; access program back to INACTIVE; no checkout created');
  console.log(`PASS: HON OS lifetime purchase (0306) ${groups} scenario groups; deterministic TEST provider only; no Stripe network, charge, checkout, trial, credits or deployment.`);
} finally {
  await Promise.allSettled([admin.query('ROLLBACK'),restricted.query('ROLLBACK')]);
  try { await setAccessProgram(false); await cleanup(); }
  finally { await Promise.allSettled([admin.end(),watcher.end(),restricted.end()]); }
}
