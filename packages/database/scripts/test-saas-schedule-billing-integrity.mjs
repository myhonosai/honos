import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID as K, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pricingOffers, scheduleInput, acceptanceInput } from './price-acceptance-fixture.mjs';
import { generationInput } from './subscription-generation-fixture.mjs';
import { verifySaasBillingSecurity } from './saas-billing-security.mjs';

// Fixed disposable local fixture only: no inherited DSN, provider credentials, network, or customer data.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const u of [owner,runtime])assert(u.protocol==='postgresql:'&&u.hostname==='localhost'&&u.port==='5432'&&u.pathname==='/hon_champions_validation'&&u.search===''&&u.hash===''&&u.password);
assert(owner.username==='hon_champions_owner'&&runtime.username==='hon_champions_runtime');
assert(!Object.keys(process.env).some(k=>/^PG[A-Z_]*$|^(?:STRIPE|SQUARE|OPENAI|ANTHROPIC|OPENROUTER|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k)));
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasPriceAcceptanceService}=await import('../../../apps/api/dist/saas-pricing/saas-price-acceptance.service.js');
const {SaasSubscriptionGenerationService}=await import('../../../apps/api/dist/saas-pricing/saas-subscription-generation.service.js');
const {SaasScheduleBillingService}=await import('../../../apps/api/dist/saas-pricing/saas-schedule-billing.service.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const apiRequire=createRequire(new URL('../../../apps/api/package.json',import.meta.url));
const contracts=apiRequire('@hon/contracts');
const {DeterministicScheduleProvider}=apiRequire('../../../apps/api/test/fixtures/subscription-schedule-provider.cjs');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),pricing=new SaasPriceAcceptanceService(billing),generations=new SaasSubscriptionGenerationService(billing);
const provider=new DeterministicScheduleProvider(),schedules=new SaasScheduleBillingService(billing,provider),payments=new SaasPaymentsService(billing,database,{});
const client=u=>new pg.Client({connectionString:u.toString(),ssl:false}),admin=client(owner),restricted=client(runtime);
const humans=Object.fromEntries(['hq','school','other','staff','ai'].map(k=>[k,{id:K(),user:K(),subject:'b2-'+K()}]));
const H=k=>humans[k].subject,org={id:K(),school:K(),second:K(),role:K()},foreign={id:K(),school:K(),role:K()};
const tables=['saas_schedule_bindings','saas_schedule_provider_events','saas_schedule_paid_periods','saas_schedule_reconciliations','saas_subscription_generations','saas_price_acceptances','saas_price_schedules'];
const row=async(q,p)=>(await admin.query(q,p)).rows[0];let groups=0;const passed=s=>console.log('PASS B2 '+(++groups)+': '+s);
const deny=(work,status,code)=>assert.rejects(Promise.resolve().then(work),e=>{assert.equal(e.getStatus?.(),status,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;});
const sqlDeny=(work,code)=>assert.rejects(work,e=>{assert.equal(e.code,code,e.stack);return true;});
const stamp=s=>createHash('sha256').update(s).digest('hex');
async function digest(value){return (await row('SELECT hon.saas_hon_os_digest($1::jsonb) digest',[value])).digest;}
async function cleanup(){
  await admin.query('ROLLBACK');await admin.query('BEGIN');
  try { for(const t of [...tables,'saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets','saas_outbox','saas_audit','saas_requests']) {
    await admin.query('ALTER TABLE hon.'+t+' DISABLE TRIGGER USER');
    if(t==='saas_outbox')await admin.query('DELETE FROM hon.saas_outbox WHERE audit_id IN (SELECT id FROM hon.saas_audit WHERE actor_principal_id=ANY($1::uuid[]))',[Object.values(humans).map(x=>x.id)]);
    else if(['saas_audit','saas_requests'].includes(t))await admin.query('DELETE FROM hon.'+t+' WHERE actor_principal_id=ANY($1::uuid[])',[Object.values(humans).map(x=>x.id)]);
    else await admin.query('DELETE FROM hon.'+t); await admin.query('ALTER TABLE hon.'+t+' ENABLE TRIGGER USER');
  } await admin.query('COMMIT'); } catch(e){await admin.query('ROLLBACK');throw e;}
}
await Promise.all([admin,restricted].map(x=>x.connect()));
try {
  assert.equal((await row("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).marker,'HON disposable Champions Club validation');
  await verifySaasBillingSecurity(admin,'hon_champions_runtime');
  await admin.query('BEGIN');
  for(const[k,h]of Object.entries(humans)) {
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'B2 SYNTHETIC')",[h.user,h.subject,h.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,$3,'B2 SYNTHETIC',true)",[h.id,k==='ai'?null:h.user,k==='ai'?'AI_EMPLOYEE':'HUMAN_USER']);
  }
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '1 hour')",[humans.hq.id]);
  for(const o of [org,foreign]) {
    await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'B2 SYNTHETIC','B2 SYNTHETIC')",[o.id]);
    await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'B2 SYNTHETIC',$3,'UTC')",[o.school,o.id,'b2-'+o.school]);
    await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE','SUSPENDED')",[o.id]);
    await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','B2 synthetic owner',true)",[o.role,o.id]);
    await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.hon.purchase')",[o.role,o.id]);
  }
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'B2 second',$3,'UTC')",[org.second,org.id,'b2-'+org.second]);
  for(const[k,o]of [['school',org],['staff',org],['other',foreign]])await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')",[o.id,o.school,humans[k].id,o.role]);
  await admin.query('COMMIT');
  const offerDraft=await billing.createOfferSetDraft(H('hq'),{basedOnSetId:null,termsReference:'SYNTHETIC_B2_TERMS_V1',founderTotalLimit:50,offers:pricingOffers()},K());
  const set=(await billing.publishOfferSet(H('hq'),offerDraft.set.setId,{expectedRevision:offerDraft.set.revision,previewDigest:offerDraft.preview.previewDigest,approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K())).set;
  const offer=set.offers.find(x=>x.offerKind==='REGULAR_MONTHLY');
  const founder=set.offers.find(x=>x.offerKind==='FOUNDER_MONTHLY');
  const founderSchedule=(await pricing.record(H('hq'),scheduleInput(founder,offer,0),K())).schedule;
  const founderPreview=await pricing.preview(H('school'),org.school,founderSchedule.scheduleId);
  assert(founderPreview.blockers.includes('FOUNDER_ALLOCATION_CONTRACT_UNAVAILABLE'));
  await deny(()=>pricing.accept(H('school'),org.school,acceptanceInput(founderPreview),K()),422,'SAAS_PRICE_ACCEPTANCE_BLOCKED');
  const recorded=(await pricing.record(H('hq'),scheduleInput(offer,offer,0),K())).schedule;
  const accepted=await pricing.accept(H('school'),org.school,acceptanceInput(await pricing.preview(H('school'),org.school,recorded.scheduleId)),K());
  const generation=(await generations.record(H('school'),org.school,generationInput(accepted),K())).generation;
  const input={generationId:generation.generationId,generationDigest:generation.generationDigest,confirmation:contracts.SAAS_SCHEDULE_BINDING_CONFIRMATION};
  await deny(()=>schedules.start(H('school'),org.school,input,K()),422,'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_bindings')).n,0,'disabled program must roll back binding intent');
  await payments.setPaymentProgram(H('hq'),{action:'ENABLE_TEST_MODE',expectedVersion:1,provider:'STRIPE_SIMULATED',testTaxReference:'B2 TEST TAX',authorizationReference:'B2 TEST AUTHORIZATION'},K());
  const key=K(),receipt=await schedules.start(H('school'),org.school,input,key),binding=receipt.binding;
  assert.equal(binding.provider,'STRIPE_SIMULATED');assert.equal(binding.mode,'TEST');assert.equal(binding.status,'BOUND_TEST_ONLY');assert.equal(binding.billingEnabled,false);assert.equal(binding.checkoutAvailable,false);assert.equal(binding.accessGranted,false);assert.equal(binding.paidAccessProgram,'INACTIVE');
  assert.equal(provider.calls,1);assert.deepEqual((await schedules.start(H('school'),org.school,input,key)).binding,binding);assert.equal(provider.calls,1);
  await deny(()=>schedules.start(H('school'),org.second,input,K()),403,'SAAS_FORBIDDEN');await deny(()=>schedules.read(H('other'),foreign.school,binding.bindingId),404,'SAAS_UNAVAILABLE');
  assert.deepEqual(await schedules.read(H('staff'),org.school,binding.bindingId),binding);assert.deepEqual(await schedules.readHq(H('hq'),binding.bindingId),binding);
  const malformedObservation={identity:'DETERMINISTIC_FAKE',mode:'TEST',outcome:'BOUND',bindingId:binding.bindingId,bindingKey:binding.bindingKey,requirementsDigest:binding.requirementsDigest,
    accountReference:'fake_null_flag_account',subscriptionReference:'fake_null_flag_subscription',scheduleReference:'fake_null_flag_schedule',automaticCalendarTransition:null,automaticCollectionEnabled:null};
  await sqlDeny(restricted.query('SELECT hon.record_saas_schedule_binding_observation($1::uuid,$2::jsonb,$3::uuid,$4::uuid)',[binding.bindingId,malformedObservation,K(),K()]),'22023');
  passed('exact A2/B1 lineage, explicit founder refusal pending C, TEST simulated binding, malformed-observation refusal, durable recovery, school/HQ isolation, and no checkout/access effect');
  const baseEvent=(eventId,amountMinor=24900,startsAt='2031-01-01T00:00:00.000Z',endsAt='2031-02-01T00:00:00.000Z')=>({provider:'STRIPE_SIMULATED',mode:'TEST',eventId,eventType:'invoice.paid',bindingId:binding.bindingId,
    accountReference:binding.providerAccountReference,subscriptionReference:binding.providerSubscriptionReference,scheduleReference:binding.providerScheduleReference,
    invoiceReference:'fake_invoice_'+eventId.slice(4),relatedInvoiceReference:null,coveredPeriod:{startsAt,endsAt},amountMinor,currency:'USD',occurredAt:'2031-02-01T00:00:01.000Z'});
  const paid=baseEvent('evt_'+K().replaceAll('-','_')),paidReceipt=await schedules.ingestVerifiedTestEvidence(paid,await digest(paid));
  assert.equal(paidReceipt.outcome,'APPLIED');assert.equal(paidReceipt.qualifyingPaidPeriodCount,1);assert.equal(paidReceipt.accessGranted,false);
  assert.deepEqual(await schedules.ingestVerifiedTestEvidence(paid,await digest(paid)),paidReceipt,'same event replays immutable original evidence');
  const concurrent=baseEvent('evt_'+K().replaceAll('-','_'),24900,'2031-02-01T00:00:00.000Z','2031-03-01T00:00:00.000Z');concurrent.occurredAt='2031-03-01T00:00:01.000Z';
  const concurrentDigest=await digest(concurrent),concurrentReceipts=await Promise.all([schedules.ingestVerifiedTestEvidence(concurrent,concurrentDigest),schedules.ingestVerifiedTestEvidence(concurrent,concurrentDigest)]);
  assert.deepEqual(concurrentReceipts[0],concurrentReceipts[1]);assert.equal(concurrentReceipts[0].outcome,'APPLIED');assert.equal(concurrentReceipts[0].qualifyingPaidPeriodCount,2);
  const duplicate=baseEvent('evt_'+K().replaceAll('-','_'));duplicate.invoiceReference=paid.invoiceReference;duplicate.coveredPeriod={startsAt:'2031-02-01T00:00:00.000Z',endsAt:'2031-03-01T00:00:00.000Z'};duplicate.occurredAt='2031-03-01T00:00:01.000Z';
  assert.equal((await schedules.ingestVerifiedTestEvidence(duplicate,await digest(duplicate))).outcome,'ALREADY_APPLIED');
  const wrong=baseEvent('evt_'+K().replaceAll('-','_'),1,'2031-02-01T00:00:00.000Z','2031-03-01T00:00:00.000Z');wrong.invoiceReference='fake_invoice_wrong';wrong.occurredAt='2031-03-01T00:00:01.000Z';
  assert.equal((await schedules.ingestVerifiedTestEvidence(wrong,await digest(wrong))).outcome,'NEEDS_REVIEW');
  const reverse={...baseEvent('evt_'+K().replaceAll('-','_')),eventType:'charge.refunded',invoiceReference:null,relatedInvoiceReference:paid.invoiceReference,coveredPeriod:null,occurredAt:'2031-03-02T00:00:01.000Z'};
  const reversal=await schedules.ingestVerifiedTestEvidence(reverse,await digest(reverse));assert.equal(reversal.outcome,'NEEDS_REVIEW');
  const after=await schedules.read(H('school'),org.school,binding.bindingId);assert.equal(after.qualifyingPaidPeriodCount,2);assert.equal(after.unresolvedReconciliation,true);
  assert.equal((await row('SELECT status FROM hon.saas_access_program')).status,'INACTIVE');assert.equal((await row('SELECT count(*)::int n FROM hon.saas_access_transitions')).n,0);
  passed('verified paid-period evidence counts once; duplicate, wrong-amount, refund/reversal facts fail closed into immutable reconciliation with paid access still inactive');
  for(const q of ['SELECT * FROM hon.saas_schedule_bindings','UPDATE hon.saas_schedule_bindings SET id=id','DELETE FROM hon.saas_schedule_provider_events','INSERT INTO hon.saas_schedule_paid_periods SELECT * FROM hon.saas_schedule_paid_periods LIMIT 1'])await sqlDeny(restricted.query(q),'42501');
  await verifySaasBillingSecurity(admin,'hon_champions_runtime');
  passed('forced RLS/private tables/functions and immutable evidence remain enforced for the restricted runtime');
  console.log(`PASS: Commercial B2 ${groups} scenario groups; deterministic fake only; no Stripe network, charge, invoice issuance, checkout, entitlement, trial, credits, or deployment.`);
} finally { await Promise.allSettled([admin.query('ROLLBACK'),restricted.query('ROLLBACK')]);try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end()]);} }
