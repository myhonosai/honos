import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID as K } from 'node:crypto';
import { createRequire } from 'node:module';
import { pricingOffers, scheduleInput, acceptanceInput } from './price-acceptance-fixture.mjs';
import { generationInput } from './subscription-generation-fixture.mjs';
import { verifySaasBillingSecurity } from './saas-billing-security.mjs';

// 0324: renewals, failed payments, grace, past-due suspension and restore on the schedule path (owner terms v2). Fixed
// disposable local fixture only: synthetic organizations, the deterministic TEST provider, no network, no charge, no card
// retry, no checkout and no deployment. Time is moved by shifting one school's recorded period back (fixture only).
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
const apiRequire=createRequire(new URL('../../../apps/api/package.json',import.meta.url));
const c=apiRequire('@hon/contracts');
const {DeterministicScheduleProvider}=apiRequire('./test/fixtures/subscription-schedule-provider.cjs');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),pricing=new SaasPriceAcceptanceService(billing);
const generations=new SaasSubscriptionGenerationService(billing),provider=new DeterministicScheduleProvider(),schedules=new SaasScheduleBillingService(billing,provider);
const schoolBilling=new SaasSchoolBillingService(billing),reviews=new SaasPaidReviewService(billing),founder=new SaasFounderService(billing),payments=new SaasPaymentsService(billing,database,{});
const client=u=>new pg.Client({connectionString:u.toString(),ssl:false}),admin=client(owner),watcher=client(owner),restricted=client(runtime);
const hq={id:K(),user:K(),subject:'rn-'+K()},operator={id:K(),user:K(),subject:'rn-'+K()};
const orgs=[];const principals=()=>[hq.id,operator.id,...orgs.map(o=>o.principal)];
const tables=['saas_lifetime_sales','saas_founder_allocations','saas_paid_review_resolutions','saas_access_transitions','saas_access_states','saas_schedule_reconciliations','saas_schedule_paid_periods','saas_schedule_provider_events','saas_schedule_bindings','saas_subscription_generations','saas_price_acceptances','saas_price_schedules'];
const row=async(q,p)=>(await admin.query(q,p)).rows[0];let groups=0;const passed=s=>console.log('PASS 0324 '+(++groups)+': '+s);
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
    const o={label:label+i,id:K(),school:K(),role:K(),principal:K(),user:K(),subject:'rn-'+K()};
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'RN SYNTHETIC')",[o.user,o.subject,o.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','RN SYNTHETIC',true)",[o.principal,o.user]);
    await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'RN SYNTHETIC','RN SYNTHETIC')",[o.id]);
    await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'RN SYNTHETIC',$3,'UTC')",[o.school,o.id,'rn-'+o.school]);
    await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE',$2)",[o.id,entitlement]);
    await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','RN synthetic owner',true)",[o.role,o.id]);
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
  const d=await billing.createOfferSetDraft(hq.subject,{basedOnSetId:null,termsReference:'SYNTHETIC_RN_TERMS_V1',founderTotalLimit,offers},K());
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
  for(const q of ["SELECT hon.saas_schedule_current_suspension(gen_random_uuid())","UPDATE hon.organization_entitlements SET status='SUSPENDED'",
    "INSERT INTO hon.saas_access_transitions(organization_id,kind,outcome,reason) VALUES(gen_random_uuid(),'PAST_DUE_SUSPENSION','APPLIED','RENEWAL_UNPAID_AFTER_GRACE')",
    "SELECT hon.saas_schedule_after_paid_period(gen_random_uuid(),gen_random_uuid(),clock_timestamp())"])
    await sqlDeny(restricted.query(q),'42501');
  passed('the runtime has no direct path: no entitlement or access-record write, no suspension helper, no renewal hook; the billing inventory holds');

  await admin.query('BEGIN');
  for(const [h,role,perms] of [[hq,'HON_HQ_OWNER',[]],[operator,'HON_HQ_OPERATOR',['hq.billing.manage']]]){
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'RN SYNTHETIC')",[h.user,h.subject,h.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','RN SYNTHETIC',true)",[h.id,h.user]);
    await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[h.id,role,perms]);
  }
  await admin.query('COMMIT');
  await payments.setPaymentProgram(hq.subject,{action:'ENABLE_TEST_MODE',expectedVersion:1,provider:'STRIPE_SIMULATED',testTaxReference:'RN TEST TAX',authorizationReference:'RN TEST AUTHORIZATION'},K());



  const s1=await publish([...pricingOffers(),lifetimeOffer('LIFETIME',357600,20)],50);
  const monthly=s1.schedules.REGULAR_MONTHLY,lt=s1.schedules.LIFETIME;
  const DAY=86400_000,addMonth=iso=>{const d=new Date(iso);d.setUTCMonth(d.getUTCMonth()+1);return d.toISOString();};
  const ent=o=>row("SELECT status::text,effective_until,version FROM hon.organization_entitlements WHERE organization_id=$1",[o.id]);
  const paidThrough=async o=>(await row("SELECT paid_through FROM hon.saas_access_states WHERE organization_id=$1",[o.id])).paid_through.toISOString();
  const kinds=async b=>(await admin.query("SELECT kind||':'||outcome||':'||reason k FROM hon.saas_access_transitions WHERE binding_id=$1 ORDER BY occurred_at,id",[b.bindingId])).rows.map(r=>r.k);
  const standing=o=>schoolBilling.readAccessStanding(o.subject,o.school);
  const window=async o=>(await admin.query('SELECT * FROM hon.crm_owner_read_only_window($1)',[o.id])).rows[0]??null;
  const pastDue=async()=>(await schedules.listPastDue(200)).bindingIds;
  // A payment for exactly one month starting where the school's paid time ends.
  const next=async(b,o,startOffsetDays=0)=>{const e=paid(b);const start=new Date(Date.parse(await paidThrough(o))+startOffsetDays*DAY).toISOString();return {...e,coveredPeriod:{startsAt:start,endsAt:addMonth(start)}};};
  async function withProgram(work){await setAccessProgram(true);try{return await work();}finally{await setAccessProgram(false);}}
  async function buy(o,s=monthly){const b=await signUp(o,s);const e=s===lt?lifetimePaid(b):paid(b);const r=await withProgram(()=>ingest(e));assert.equal(r.access.accessActivation,'APPLIED',JSON.stringify(r));return b;}
  // Fixture only: move this school's paid time back by N days (its period, access state and entitlement window together).
  async function back(o,b,days){
    await admin.query('BEGIN');
    try{for(const t of ['saas_schedule_paid_periods','saas_access_states'])await admin.query('ALTER TABLE hon.'+t+' DISABLE TRIGGER USER');
      await admin.query("UPDATE hon.saas_schedule_paid_periods SET covered_starts_at=covered_starts_at-make_interval(days=>$2),covered_ends_at=covered_ends_at-make_interval(days=>$2) WHERE binding_id=$1",[b.bindingId,days]);
      await admin.query("UPDATE hon.saas_access_states SET paid_through=paid_through-make_interval(days=>$2) WHERE organization_id=$1",[o.id,days]);
      await admin.query("UPDATE hon.organization_entitlements SET effective_from=effective_from-make_interval(days=>$2),effective_until=effective_until-make_interval(days=>$2) WHERE organization_id=$1",[o.id,days]);
      for(const t of ['saas_schedule_paid_periods','saas_access_states'])await admin.query('ALTER TABLE hon.'+t+' ENABLE TRIGGER USER');
      await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}
  }
  const orgsN=await makeOrgs(7,'renew');for(const o of orgsN)await awaiting(o);
  const [a,bo,co,d,l,f6]=orgsN;

  // ---------- failed renewal: grace with an in-app notice, nothing suspended ----------
  const A=await buy(a);await back(a,A,32);
  const failed=await ingest({...paid(A),eventType:'invoice.payment_failed'});
  assert.deepEqual([failed.outcome,failed.reason,failed.billingStatus],['ATTEMPT_FAILED','PAYMENT_NOT_VERIFIED','ACTIVE']);
  const stA=await standing(a);
  assert.deepEqual([stA.state,stA.paymentIssue,stA.paymentStatus,stA.renewalDueAt],['PAYMENT_ISSUE_GRACE',true,'PAST_DUE',await paidThrough(a)]);
  assert.equal(Date.parse(stA.graceEndsAt)-Date.parse(stA.renewalDueAt),7*DAY);
  assert.equal((await ent(a)).status,'ACTIVE');
  assert.equal((await pastDue()).includes(A.bindingId),false);
  await deny(()=>schedules.suspendPastDue(A.bindingId),422,'SAAS_SCHEDULE_NOT_PAST_DUE');
  passed('a failed renewal keeps full access for the 7-day grace; the school standing shows the payment issue, due date and grace end; suspension is refused during grace');

  // ---------- after grace: suspension, owner read-only window; repeat is a replay ----------
  const B=await buy(bo);await back(bo,B,40);
  assert.equal((await standing(bo)).state,'NO_ACCESS','grace has run out; access lapsed by time before the worker runs');
  assert((await pastDue()).includes(B.bindingId));
  const sB=await schedules.suspendPastDue(B.bindingId);
  assert.deepEqual([sB.outcome,sB.policyVersion,sB.replayed,sB.paidThrough],['SUSPENDED',2,false,await paidThrough(bo)]);
  assert.equal(Date.parse(sB.ownerReadOnlyUntil)-Date.parse(sB.suspendedAt),90*DAY);
  const eB=await ent(bo);assert.equal(eB.status,'SUSPENDED');
  assert.deepEqual((await kinds(B)).slice(-1),['PAST_DUE_SUSPENSION:APPLIED:RENEWAL_UNPAID_AFTER_GRACE']);
  const wB=await window(bo);assert(wB&&wB.policy_version===2&&wB.entitlement_version===eB.version,'the 0192 owner read-only window is open');
  const stB=await standing(bo);
  assert.deepEqual([stB.state,stB.paymentIssue,stB.suspendedAt],['SUSPENDED_OWNER_READ_ONLY',true,sB.suspendedAt]);
  assert.equal((await schedules.read(bo.subject,bo.school,B.bindingId)).status,'ACTIVE','billing stays active so the school can still pay');
  const again=await schedules.suspendPastDue(B.bindingId);
  assert.deepEqual({...again,replayed:false},sB);assert.equal(again.replayed,true);
  assert.equal((await ent(bo)).version,eB.version,'a repeat run changes nothing');
  assert.equal((await pastDue()).includes(B.bindingId),false);
  passed('after grace the worker suspends the plan (entitlement SUSPENDED, PAST_DUE_SUSPENSION under terms v2) and opens the 90-day owner read-only window; billing stays ACTIVE; a repeat run is a replay');

  // ---------- a renewal paid during grace extends normally ----------
  const ext=await withProgram(async()=>ingest(await next(A,a)));
  assert.deepEqual([ext.outcome,ext.access.accessActivation],['APPLIED','EXTENDED']);
  assert.equal((await ent(a)).status,'ACTIVE');assert.equal((await standing(a)).state,'IN_GOOD_STANDING');
  await deny(()=>schedules.suspendPastDue(A.bindingId),422,'SAAS_SCHEDULE_NOT_PAST_DUE');
  passed('a renewal verified during grace extends access and clears the payment issue; the plan is never suspended');

  // ---------- a lifetime plan is never past due ----------
  const L=await buy(l,lt);
  assert.equal((await pastDue()).includes(L.bindingId),false);
  await deny(()=>schedules.suspendPastDue(L.bindingId),422,'SAAS_SCHEDULE_NOT_PAST_DUE');
  assert.deepEqual([(await standing(l)).state,(await standing(l)).paymentStatus],['IN_GOOD_STANDING','PAID']);
  passed('a lifetime plan is never listed or suspended for non-payment and reads as paid');

  // ---------- restore: the overdue period's payment; a gap stays in review ----------
  const restored=await withProgram(async()=>ingest(await next(B,bo)));
  assert.deepEqual([restored.outcome,restored.access.accessActivation,restored.access.accessGranted],['APPLIED','EXTENDED',true]);
  const eR=await ent(bo);
  assert.equal(eR.status,'ACTIVE');assert(eR.effective_until>new Date(),'access is in effect again');
  assert.deepEqual((await kinds(B)).slice(-1),['SCHEDULE_ACCESS_RESTORED:APPLIED:OVERDUE_PERIOD_PAID']);
  assert.equal(await window(bo),null,'the owner read-only window ends when access is restored');
  assert.equal((await standing(bo)).state,'IN_GOOD_STANDING');
  const C=await buy(co);await back(co,C,40);await schedules.suspendPastDue(C.bindingId);
  const gap=await withProgram(async()=>ingest(await next(C,co,31)));
  assert.deepEqual([gap.outcome,gap.access.accessActivation,gap.access.reason],['APPLIED','NEEDS_REVIEW','PAID_PERIOD_GAP']);
  assert.equal((await ent(co)).status,'SUSPENDED','a payment that skips the overdue period never restores access');
  passed('the verified payment of the overdue period restores access at once and closes the owner window; a payment that leaves a gap stays SUSPENDED and goes to HQ review');

  // ---------- a suspension run and the overdue payment race: never left suspended ----------
  const D=await buy(d);await back(d,D,40);
  const pay=await next(D,d);
  await setAccessProgram(true);
  try{
    await admin.query('BEGIN');await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('saas.organization:'||$1::text,0))",[d.id]);
    const holder=(await row('SELECT pg_backend_pid() p')).p,both=Promise.allSettled([schedules.suspendPastDue(D.bindingId),ingest(pay)]);
    for(const until=Date.now()+8000;;){
      const n=(await watcher.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[holder])).rows[0].n;
      if(n>=2)break;if(Date.now()>until)throw Error('expected the suspension and the payment to wait on the organization lock');await new Promise(r=>setTimeout(r,20));
    }
    await admin.query('COMMIT');
    const [susp,payment]=await both;
    assert.equal(payment.status,'fulfilled',String(payment.reason));
    assert.equal(payment.value.access.accessGranted,true,'the payment restores or extends access whichever ran first');
    if(susp.status==='rejected')assert.equal(susp.reason.getResponse().code,'SAAS_SCHEDULE_NOT_PAST_DUE');
  }finally{await setAccessProgram(false);}
  assert.equal((await ent(d)).status,'ACTIVE');
  passed('a suspension run and the overdue payment for the same school serialize on the organization lock (both proven waiting); the school ends ACTIVE either way');

  // ---------- closed paths ----------
  await deny(()=>schedules.suspendPastDue('not-a-uuid'),400,'INVALID_SAAS_INPUT');
  await deny(()=>schedules.listPastDue(0),400,'INVALID_SAAS_INPUT');
  const awaitingOnly=await signUp(f6,monthly);
  await deny(()=>schedules.suspendPastDue(awaitingOnly.bindingId),422,'SAAS_SCHEDULE_NOT_PAST_DUE');
  await admin.query('BEGIN');
  await sqlDeny(admin.query("INSERT INTO hon.saas_access_transitions(organization_id,kind,outcome,reason,binding_id,paid_period_id,policy_version,prior_entitlement,next_entitlement,actor_principal_id,occurred_at) SELECT organization_id,kind,outcome,reason,binding_id,paid_period_id,policy_version,prior_entitlement,next_entitlement,actor_principal_id,occurred_at FROM hon.saas_access_transitions WHERE kind='PAST_DUE_SUSPENSION' AND binding_id=$1",[C.bindingId]),'23505');
  await admin.query('ROLLBACK');
  await verifySaasBillingSecurity(admin,'hon_champions_runtime');
  assert.deepEqual(await row("SELECT status,mutations_enabled FROM hon.saas_access_program"),{status:'INACTIVE',mutations_enabled:false});
  assert.equal((await row("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='saas_access_program_status_check'")).definition,STATUS_CHECK);
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_checkout_sessions')).n,0);
  passed('closed inputs refused; an unpaid sign-up is never suspended; one suspension per lapsed period; access program back to INACTIVE; no checkout');
  console.log(`PASS: HON OS schedule renewals and suspension (0324) ${groups} scenario groups; deterministic TEST provider only; no Stripe network, charge, card retry, checkout, credits or deployment.`);
} finally {
  await Promise.allSettled([admin.query('ROLLBACK'),restricted.query('ROLLBACK')]);
  try { await setAccessProgram(false); await cleanup(); }
  finally { await Promise.allSettled([admin.end(),watcher.end(),restricted.end()]); }
}
