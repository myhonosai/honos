import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID as K } from 'node:crypto';
import { createRequire } from 'node:module';
import { pricingOffers, scheduleInput, acceptanceInput } from './price-acceptance-fixture.mjs';
import { generationInput } from './subscription-generation-fixture.mjs';
import { verifySaasBillingSecurity } from './saas-billing-security.mjs';

// 0325: the $100 Champions Club welcome credit on HON OS plans (schedule path). Fixed disposable local fixture only:
// synthetic organizations, the real Champions referral flow, the deterministic TEST provider, no network, no charge, no
// cash payout, no checkout and no deployment.
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
const hq={id:K(),user:K(),subject:'wc-'+K()},operator={id:K(),user:K(),subject:'wc-'+K()};
const orgs=[];const principals=()=>[hq.id,operator.id,...orgs.map(o=>o.principal)];
const tables=['saas_schedule_credit_uses','saas_schedule_welcome_credits','saas_lifetime_sales','saas_founder_allocations','saas_paid_review_resolutions','saas_access_transitions','saas_access_states','saas_schedule_reconciliations','saas_schedule_paid_periods','saas_schedule_provider_events','saas_schedule_bindings','saas_subscription_generations','saas_price_acceptances','saas_price_schedules'];
const championsTables=['champions_outbox','champions_audit','champions_contest_history','champions_contest_winners','champions_contest_results','champions_contest_pauses','champions_contest_schools','champions_contest_prizes','champions_contests','champions_leaderboard_holds','champions_leaderboard_preferences','champions_reward_history','champions_reward_entries','champions_reward_policies','champions_attribution_history','champions_attributions','champions_requests','champions_referral_codes','champions_policies'];
const row=async(q,p)=>(await admin.query(q,p)).rows[0];let groups=0;const passed=s=>console.log('PASS 0325 '+(++groups)+': '+s);
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
    const o={label:label+i,id:K(),school:K(),role:K(),principal:K(),user:K(),subject:'wc-'+K()};
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'WC SYNTHETIC')",[o.user,o.subject,o.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','WC SYNTHETIC',true)",[o.principal,o.user]);
    await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'WC SYNTHETIC','WC SYNTHETIC')",[o.id]);
    await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'WC SYNTHETIC',$3,'UTC')",[o.school,o.id,'wc-'+o.school]);
    await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE',$2)",[o.id,entitlement]);
    await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','WC synthetic owner',true)",[o.role,o.id]);
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
  const d=await billing.createOfferSetDraft(hq.subject,{basedOnSetId:null,termsReference:'SYNTHETIC_WC_TERMS_V1',founderTotalLimit,offers},K());
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
  for(const q of ["SELECT hon.saas_schedule_credit_remaining(gen_random_uuid())","SELECT hon.saas_schedule_welcome_credit_json(gen_random_uuid())",
    "INSERT INTO hon.saas_schedule_welcome_credits(reward_entry_id,organization_id,binding_id,amount_minor,provider_credit_key,applied_by_principal_id,applied_at) VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),10000,gen_random_uuid(),gen_random_uuid(),clock_timestamp())",
    "SELECT * FROM hon.saas_schedule_credit_uses","SELECT hon.saas_schedule_current_suspension(gen_random_uuid())","UPDATE hon.organization_entitlements SET status='SUSPENDED'",
    "INSERT INTO hon.saas_access_transitions(organization_id,kind,outcome,reason) VALUES(gen_random_uuid(),'PAST_DUE_SUSPENSION','APPLIED','RENEWAL_UNPAID_AFTER_GRACE')",
    "SELECT hon.saas_schedule_after_paid_period(gen_random_uuid(),gen_random_uuid(),clock_timestamp())"])
    await sqlDeny(restricted.query(q),'42501');
  passed('the runtime has no direct path: no welcome-credit or credit-use table access, no credit helper, no entitlement write; the billing inventory holds');

  await admin.query('BEGIN');
  for(const [h,role,perms] of [[hq,'HON_HQ_OWNER',[]],[operator,'HON_HQ_OPERATOR',['hq.billing.manage']]]){
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'WC SYNTHETIC')",[h.user,h.subject,h.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','WC SYNTHETIC',true)",[h.id,h.user]);
    await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[h.id,role,perms]);
  }
  await admin.query('COMMIT');
  await payments.setPaymentProgram(hq.subject,{action:'ENABLE_TEST_MODE',expectedVersion:1,provider:'STRIPE_SIMULATED',testTaxReference:'WC TEST TAX',authorizationReference:'WC TEST AUTHORIZATION'},K());



  const s1=await publish([...pricingOffers({FOUNDER_MONTHLY:{priceMinor:7900}}),lifetimeOffer('LIFETIME',357600,20)],50);
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
  const founderMonthly=s1.schedules.FOUNDER_MONTHLY;
  const view=(o,b)=>schedules.read(o.subject,o.school,b.bindingId);
  const credits=async b=>(await admin.query('SELECT amount_minor FROM hon.saas_schedule_credit_uses WHERE binding_id=$1 ORDER BY recorded_at,id',[b.bindingId])).rows.map(r=>r.amount_minor);
  const credit=(b,o,rewardEntryId,expectedEntryVersion,key=K())=>schedules.applyWelcomeCredit(o.subject,b.bindingId,{rewardEntryId,expectedEntryVersion},key);
  const fulfillment=async action=>{const v=(await row('SELECT version FROM hon.saas_reward_fulfillment WHERE program_id=1')).version;
    return billing.setRewardFulfillment(hq.subject,{action,expectedVersion:v,authorizationReference:'WC SYNTHETIC FULFILLMENT TEST'},K());};

  // ---------- the referrer school, Champions terms and the referral code (real Champions flow) ----------
  const [ref]=await makeOrgs(1,'referrer','ACTIVE');
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'champions.participate')",[ref.role,ref.id]);
  await admin.query("UPDATE hon.hq_operator_grants SET permission_codes=permission_codes||ARRAY['hq.champions.manage'] WHERE principal_id=$1",[operator.id]);
  await admin.query("UPDATE hon.organizations SET created_at=clock_timestamp()-interval '90 days' WHERE id=$1",[ref.id]);
  await admin.query('COMMIT');
  const program=(await champions.createPolicyDraft(operator.subject,{attributionWindowDays:30,refundWindowDays:0,minimumPaidDays:0,minimumPaidInvoices:1,paymentVerificationSource:'HQ_OWNER_ATTESTATION',welcomeCreditMinor:10000,termsReference:'WC program terms (fixture)'},K())).policy;
  await champions.publishPolicy(hq.subject,program.policyId,K());
  const rewards=(await champions.createRewardPolicyDraft(operator.subject,{referrerCreditMinor:10000,referrerCreditMaxRank:4,welcomeCreditMinor:10000,firstFreeMonthsCount:5,firstFreeMonthsTotal:6,secondFreeMonthsCount:10,secondFreeMonthsTotal:12,prizeCount:20,prizeBudgetMinor:null,lifetimeCount:30,clawbackRule:'UNDECIDED',monthlyRule:'AS_EARNED',annualRule:'AS_EARNED',founderRule:'UNDECIDED',paidLifetimeRule:'OWNER_SUBSTITUTE',termsReference:'WC reward terms (fixture)'},K())).policy;
  await champions.publishRewardPolicy(hq.subject,rewards.policyId,K());
  const code=(await champions.issueReferralCode(ref.subject,ref.school,K())).code;
  // Referred schools exist only after the code (as a real referred sign-up would).
  const referred=await makeOrgs(5,'referred');for(const o of referred)await awaiting(o);
  const [a,bo,co,d,l]=referred;
  // Each referred school buys, the HQ owner qualifies its referral, and its $100 welcome credit accrues.
  async function refer(o,s){
    const b=await buy(o,s);
    const at=(await champions.captureAttribution(operator.subject,{referralCode:code,referredOrganizationId:o.id},K())).attribution;
    await champions.decideAttribution(hq.subject,at.attributionId,{decision:'QUALIFY',reasonCode:'QUALIFICATION_VERIFIED',expectedVersion:1,
      evidence:{firstPaidAt:new Date(Date.now()-1000).toISOString(),paidInvoiceCount:1,reference:'WC owner attestation (fixture)'}},K());
    const entry=(await row("SELECT id,version,status,credit_minor FROM hon.champions_reward_entries WHERE reward_kind='WELCOME_CREDIT' AND beneficiary_organization_id=$1",[o.id]));
    assert.deepEqual([entry.status,entry.credit_minor],['ACCRUED',10000]);
    return {b,entry};
  }
  const approve=async entry=>{await champions.decideReward(hq.subject,entry.id,{decision:'APPROVE',expectedVersion:entry.version,planBasis:'MONTHLY',substitute:null,prize:null},K());
    return row('SELECT id,version,status FROM hon.champions_reward_entries WHERE id=$1',[entry.id]);};

  // ---------- refusals before a credit can be used ----------
  const RA=await refer(a,founderMonthly),RL=await refer(l,lt);
  await deny(()=>credit(RA.b,{subject:hq.subject},RA.entry.id,RA.entry.version),422,'SAAS_REWARD_NOT_APPROVED');
  const ea=await approve(RA.entry),el=await approve(RL.entry);
  await deny(()=>credit(RA.b,{subject:hq.subject},ea.id,ea.version),422,'SAAS_REWARDS_NOT_ACTIVE');
  await fulfillment('ACTIVATE');
  await deny(()=>credit(RA.b,{subject:operator.subject},ea.id,ea.version),403);
  await deny(()=>credit(RA.b,{subject:a.subject},ea.id,ea.version),403);
  await deny(()=>credit(RA.b,{subject:hq.subject},ea.id,ea.version+1),409);
  // An entry can be used only on its own school's plan, and never on a lifetime plan.
  await deny(()=>credit(RL.b,{subject:hq.subject},ea.id,ea.version),422,'SAAS_REWARD_NOT_APPLICABLE');
  await deny(()=>credit(RL.b,{subject:hq.subject},el.id,el.version),422,'SAAS_REWARD_NOT_APPLICABLE');
  await deny(()=>credit(RA.b,{subject:hq.subject},ea.id,ea.version,'not-a-key'),400,'INVALID_SAAS_INPUT');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_welcome_credits')).n,0);
  assert.equal(provider.credits.size,0);
  passed('nothing is applied before HQ approves the entry and turns fulfillment on; HQ operators, school staff, a stale version, another school or a lifetime plan are refused; the provider is never called');

  // ---------- apply: recorded, sent to the provider once, visible as amounts only ----------
  const key=K();
  const receipt=await credit(RA.b,{subject:hq.subject},ea.id,ea.version,key);
  assert.deepEqual([receipt.amountMinor,receipt.providerCredited,receipt.replayed,receipt.cashPayout],[10000,true,false,false]);
  assert.deepEqual(receipt.welcomeCredit,{creditedMinor:10000,usedMinor:0,remainingMinor:10000});
  assert.equal(provider.balances.get(RA.b.providerAccountReference),10000);
  const again=await credit(RA.b,{subject:hq.subject},ea.id,ea.version,key);
  assert.equal(again.replayed,true);assert.equal(again.welcomeCreditId,receipt.welcomeCreditId);
  assert.equal(provider.balances.get(RA.b.providerAccountReference),10000,'a replay re-sends the same idempotent credit, never a second one');
  await deny(()=>credit(RA.b,{subject:hq.subject},ea.id,ea.version),422,'SAAS_REWARD_ALREADY_APPLIED');
  await deny(()=>billing.applyChampionsReward(hq.subject,ea.id,{expectedEntryVersion:ea.version,firstPeriodIndex:null},K()),422);
  const va=await view(a,RA.b);assert.deepEqual(va.welcomeCredit,{creditedMinor:10000,usedMinor:0,remainingMinor:10000});
  assert(!JSON.stringify(va).includes(ref.id)&&!JSON.stringify(va).includes(ref.school),'the referred school never sees who referred it');
  assert.deepEqual((await schedules.readHq(hq.subject,RA.b.bindingId)).welcomeCredit,va.welcomeCredit);
  const audit=await row("SELECT count(*)::int n FROM hon.saas_audit WHERE action_code='saas.rewards.apply' AND entity_id=$1",[receipt.welcomeCreditId]);
  assert.equal(audit.n,1);
  passed('the HQ owner applies the approved $100 once: one record, one audit row, one provider balance credit (a replay does not credit again); either reward path refuses a second use; the school sees amounts only');

  // ---------- renewals: $79 founder month fully covered, the remaining $21 off the next, then full price ----------
  let r=await withProgram(async()=>ingest({...(await next(RA.b,a)),amountMinor:0}));
  assert.equal(r.outcome,'APPLIED',JSON.stringify(r));
  assert.deepEqual(await credits(RA.b),[7900]);
  assert.equal((await row('SELECT amount_minor FROM hon.saas_schedule_paid_periods WHERE binding_id=$1 ORDER BY covered_starts_at DESC LIMIT 1',[RA.b.bindingId])).amount_minor,0);
  const amounts=async b=>(await admin.query('SELECT amount_minor FROM hon.saas_schedule_paid_periods WHERE binding_id=$1 ORDER BY covered_starts_at',[b.bindingId])).rows.map(x=>x.amount_minor);
  r=await withProgram(async()=>ingest({...(await next(RA.b,a)),amountMinor:5800}));
  assert.equal(r.outcome,'APPLIED',JSON.stringify(r));
  assert.deepEqual(await credits(RA.b),[7900,2100]);
  r=await withProgram(async()=>ingest(await next(RA.b,a)));
  assert.equal(r.outcome,'APPLIED',JSON.stringify(r));
  assert.deepEqual(await amounts(RA.b),[7900,0,5800,7900]);
  assert.deepEqual(await credits(RA.b),[7900,2100]);
  assert.deepEqual((await view(a,RA.b)).welcomeCredit,{creditedMinor:10000,usedMinor:10000,remainingMinor:0});
  assert.equal((await ent(a)).status,'ACTIVE');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_reconciliations WHERE binding_id=$1',[RA.b.bindingId])).n,0);
  passed('a $79 founder renewal is recorded at $0 (credit $79 used), the next at $58 (the remaining $21), then full price; access stays on and nothing goes to review');

  // ---------- any other amount is reviewed; a refund or dispute raises the referral alert ----------
  const RB=await refer(bo,monthly);const eb=await approve(RB.entry);
  await credit(RB.b,{subject:hq.subject},eb.id,eb.version);
  r=await withProgram(async()=>ingest(await next(RB.b,bo)));
  assert.deepEqual([r.outcome,r.reason,r.billingStatus],['NEEDS_REVIEW','AMOUNT_MISMATCH','NEEDS_REVIEW'],'the full $249 while $100 credit remains is held, never counted');
  assert.deepEqual(await credits(RB.b),[]);
  assert.deepEqual((await view(bo,RB.b)).welcomeCredit,{creditedMinor:10000,usedMinor:0,remainingMinor:10000});
  await deny(async()=>ingest({...refund(RB.b,'fake_invoice_x'),amountMinor:0}),400,'INVALID_SAAS_INPUT');
  const RD=await refer(d,monthly);const ed=await approve(RD.entry);
  const firstRef=(await row('SELECT provider_invoice_reference r FROM hon.saas_schedule_paid_periods WHERE binding_id=$1',[RD.b.bindingId])).r;
  r=await ingest(refund(RD.b,firstRef,24900));
  assert.equal(r.reason,'REVERSAL_REVIEW_REQUIRED');
  const alerts=(await billing.readReferralAlerts(hq.subject,'OPEN')).alerts.filter(x=>x.referredOrganizationId===d.id);
  assert.equal(alerts.length,1);assert.deepEqual([alerts[0].source,alerts[0].evidenceKind,alerts[0].referredRecordedNetMinor],['SCHEDULE_EVENT','REFUND',24900]);
  assert.equal(alerts[0].scheduleEventId,(await row('SELECT id FROM hon.saas_schedule_provider_events WHERE provider_event_id=$1',[r.providerEventId])).id);
  await deny(()=>credit(RD.b,{subject:hq.subject},ed.id,ed.version),422,'SAAS_REWARD_PAYMENT_ALERT_OPEN');
  // A dispute on a school whose credit was already applied lists it as affected, and claws nothing back.
  const lastA=(await row('SELECT provider_invoice_reference r FROM hon.saas_schedule_paid_periods WHERE binding_id=$1 ORDER BY covered_starts_at DESC LIMIT 1',[RA.b.bindingId])).r;
  await ingest(dispute(RA.b,lastA));
  const alertA=(await billing.readReferralAlerts(hq.subject,'OPEN')).alerts.find(x=>x.referredOrganizationId===a.id);
  assert.deepEqual([alertA.evidenceKind,alertA.affectedApplications,alertA.automaticReversal,alertA.debtCreated],['CHARGEBACK',[receipt.welcomeCreditId],'NONE',false]);
  assert.deepEqual((await view(a,RA.b)).welcomeCredit,{creditedMinor:10000,usedMinor:10000,remainingMinor:0});
  passed('the full price while credit remains goes to review and uses nothing; a refund or dispute on a referred HON OS plan raises the referral alert, which blocks an unused welcome credit and lists an applied one, with no clawback');

  // ---------- provider outage: the credit stays recorded and a retry with the same key converges ----------
  const RC=await refer(co,monthly);const ec=await approve(RC.entry);const ck=K();
  provider.failNextCredit=true;
  await deny(()=>credit(RC.b,{subject:hq.subject},ec.id,ec.version,ck),503,'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_welcome_credits WHERE binding_id=$1',[RC.b.bindingId])).n,1);
  assert.equal(provider.balances.get(RC.b.providerAccountReference),undefined);
  const retried=await credit(RC.b,{subject:hq.subject},ec.id,ec.version,ck);
  assert.deepEqual([retried.replayed,retried.providerCredited],[true,true]);
  assert.equal(provider.balances.get(RC.b.providerAccountReference),10000);
  r=await withProgram(async()=>ingest({...(await next(RC.b,co)),amountMinor:14900}));
  assert.equal(r.outcome,'APPLIED',JSON.stringify(r));assert.deepEqual(await credits(RC.b),[10000]);
  passed('a provider outage leaves the credit recorded (503); the same key retries the same idempotent provider credit once; the next $249 renewal is accepted at $149');

  // ---------- no direct path at commit ----------
  const lockedRow=await row('SELECT id FROM hon.saas_schedule_paid_periods WHERE binding_id=$1 ORDER BY covered_starts_at LIMIT 1',[RC.b.bindingId]);
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.saas_schedule_paid_periods(binding_id,provider_invoice_reference,provider_event_id,covered_starts_at,covered_ends_at,amount_minor,currency,recorded_at) VALUES($1,'fake_invoice_forged','evt_forged',clock_timestamp()+interval '400 days',clock_timestamp()+interval '430 days',100,'USD',clock_timestamp())",[RC.b.bindingId]);
  await sqlDeny(admin.query('COMMIT'),'23514');
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.saas_schedule_credit_uses(credit_id,binding_id,paid_period_id,amount_minor,recorded_at) SELECT w.id,w.binding_id,$2,1,clock_timestamp() FROM hon.saas_schedule_welcome_credits w WHERE w.binding_id=$1",[RC.b.bindingId,lockedRow.id]);
  await sqlDeny(admin.query('COMMIT'),'23514');
  await sqlDeny(admin.query("UPDATE hon.saas_schedule_welcome_credits SET amount_minor=amount_minor+1"),'42501');
  await sqlDeny(admin.query("DELETE FROM hon.saas_schedule_credit_uses"),'42501');
  await fulfillment('DEACTIVATE');
  await verifySaasBillingSecurity(admin,'hon_champions_runtime');
  assert.deepEqual(await row("SELECT status,mutations_enabled FROM hon.saas_access_program"),{status:'INACTIVE',mutations_enabled:false});
  assert.deepEqual(await row("SELECT status,cash_payouts FROM hon.saas_reward_fulfillment"),{status:'INACTIVE',cash_payouts:false});
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_checkout_sessions')).n,0);
  passed('a forged reduced payment or an extra credit use fails at commit; credit records are immutable; fulfillment and the access program back to INACTIVE; no cash payout; no checkout');
  console.log(`PASS: HON OS referral welcome credit (0325) ${groups} scenario groups; real Champions referral flow; deterministic TEST provider only; no Stripe network, charge, cash payout, checkout or deployment.`);
} finally {
  await Promise.allSettled([admin.query('ROLLBACK'),restricted.query('ROLLBACK')]);
  try { await setAccessProgram(false); await cleanup(); }
  finally { await Promise.allSettled([admin.end(),watcher.end(),restricted.end()]); }
}
