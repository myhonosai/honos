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
const {SaasPaidReviewService}=await import('../../../apps/api/dist/saas-paid-review/saas-paid-review.service.js');
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {HqOnboardingService}=await import('../../../apps/api/dist/hq/hq-onboarding.service.js');
const apiRequire=createRequire(new URL('../../../apps/api/package.json',import.meta.url));
const contracts=apiRequire('@hon/contracts');
const {DeterministicScheduleProvider}=apiRequire('./test/fixtures/subscription-schedule-provider.cjs');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),pricing=new SaasPriceAcceptanceService(billing),generations=new SaasSubscriptionGenerationService(billing),access=new SaasSchoolBillingService(billing),onboarding=new HqOnboardingService(database);
const provider=new DeterministicScheduleProvider(),schedules=new SaasScheduleBillingService(billing,provider),reviews=new SaasPaidReviewService(billing),payments=new SaasPaymentsService(billing,database,{});
const client=u=>new pg.Client({connectionString:u.toString(),ssl:false}),admin=client(owner),restricted=client(runtime);
const humans=Object.fromEntries(['hq','school','other','staff','ai','d7','d9','race','cancel','iv','pa','pb','pc'].map(k=>[k,{id:K(),user:K(),subject:'b2-'+K()}]));
const H=k=>humans[k].subject,org={id:K(),school:K(),second:K(),role:K()},foreign={id:K(),school:K(),role:K()};
// The shipped OD-4 policy row is migration data: never deleted by fixture cleanup.
const tables=['saas_paid_review_resolutions','saas_access_transitions','saas_access_states','saas_schedule_reconciliations','saas_schedule_paid_periods','saas_schedule_provider_events','saas_schedule_bindings','saas_subscription_generations','saas_price_acceptances','saas_price_schedules'];
const row=async(q,p)=>(await admin.query(q,p)).rows[0];let groups=0;const passed=s=>console.log('PASS 0230 '+(++groups)+': '+s);
const deny=(work,status,code)=>assert.rejects(Promise.resolve().then(work),e=>{assert.equal(e.getStatus?.(),status,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;});
const sqlDeny=(work,code)=>assert.rejects(work,e=>{assert.equal(e.code,code,e.stack);return true;});
const sqlRuleDeny=(work,message)=>assert.rejects(work,e=>{assert.equal(e.code,'23514',e.stack);assert.equal(e.message,message,e.stack);return true;});
const stamp=s=>createHash('sha256').update(s).digest('hex');
async function digest(value){return (await row('SELECT hon.saas_hon_os_digest($1::jsonb) digest',[value])).digest;}
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
const STUB_HOOK="CREATE OR REPLACE FUNCTION hon.saas_schedule_after_paid_period(p_binding uuid,p_period uuid,p_at timestamptz) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $f$ SELECT jsonb_build_object('accessActivation','NOT_ATTEMPTED','accessGranted',false) $f$";
// Groups 1-5 prove the 0230 seam against the piece-1 stub; group 6 restores the shipped 0235 hook (ACL kept by CREATE OR REPLACE).
const restoreHook=()=>admin.query(STUB_HOOK);let shippedHook=null;
async function withUserTriggersDisabled(names,work){
  await admin.query('BEGIN');
  try {
    for(const name of names) await admin.query('ALTER TABLE hon.'+name+' DISABLE TRIGGER USER');
    const result=await work();
    for(const name of [...names].reverse()) await admin.query('ALTER TABLE hon.'+name+' ENABLE TRIGGER USER');
    await admin.query('COMMIT'); return result;
  } catch(e) { await admin.query('ROLLBACK'); throw e; }
}
async function cleanup(){
  await admin.query('ROLLBACK');await admin.query('BEGIN');
  try { for(const t of [...tables,'saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets','saas_outbox','saas_audit','saas_requests']) {
    await admin.query('ALTER TABLE hon.'+t+' DISABLE TRIGGER USER');
    if(t==='saas_outbox')await admin.query('DELETE FROM hon.saas_outbox WHERE audit_id IN (SELECT id FROM hon.saas_audit WHERE actor_principal_id=ANY($1::uuid[]))',[Object.values(humans).map(x=>x.id)]);
    else if(['saas_audit','saas_requests'].includes(t))await admin.query('DELETE FROM hon.'+t+' WHERE actor_principal_id=ANY($1::uuid[])',[Object.values(humans).map(x=>x.id)]);
    else await admin.query('DELETE FROM hon.'+t); await admin.query('ALTER TABLE hon.'+t+' ENABLE TRIGGER USER');
  }
    await admin.query('ALTER TABLE hon.saas_payment_program DISABLE TRIGGER USER');
    await admin.query("UPDATE hon.saas_payment_program SET status='DISABLED',provider=NULL,live_mode=false,test_tax_reference=NULL,authorization_reference=NULL,version=1,changed_by_principal_id=NULL,changed_at=clock_timestamp() WHERE program_id=1");
    await admin.query('ALTER TABLE hon.saas_payment_program ENABLE TRIGGER USER');
    assert.deepEqual((await row('SELECT status,provider,live_mode,test_tax_reference,authorization_reference,changed_by_principal_id FROM hon.saas_payment_program WHERE program_id=1')),{status:'DISABLED',provider:null,live_mode:false,test_tax_reference:null,authorization_reference:null,changed_by_principal_id:null});
    await admin.query('COMMIT'); } catch(e){await admin.query('ROLLBACK');throw e;}
}
await Promise.all([admin,restricted].map(x=>x.connect()));
try {
  assert.equal((await row("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).marker,'HON disposable Champions Club validation');
  assert.deepEqual(await row("SELECT status,mutations_enabled FROM hon.saas_access_program"),{status:'INACTIVE',mutations_enabled:false});
  assert.equal((await row("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='saas_access_program_status_check'")).definition,STATUS_CHECK);
  await verifySaasBillingSecurity(admin,'hon_champions_runtime');
  shippedHook=(await row("SELECT pg_get_functiondef('hon.saas_schedule_after_paid_period(uuid,uuid,timestamptz)'::regprocedure) d")).d;
  assert.match(shippedHook,/saas_schedule_activate_access/,'0235 hook is installed');
  await restoreHook();
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
  const prepareGeneration=async(who,school)=>{
    const preview=await pricing.preview(H(who),school,recorded.scheduleId);
    const accepted=await pricing.accept(H(who),school,acceptanceInput(preview),K());
    return (await generations.record(H(who),school,generationInput(accepted.acceptance),K())).generation;
  };

  // Exercise the real D9 and D7 creation paths only in the disposable fixture. B6A is restored to its shipped
  // INACTIVE posture before any B2 binding begins; neither path opens checkout, collects money, or activates access.
  let d9,d7;
  await setAccessProgram(true);
  try {
    d9=await onboarding.provisionInitialSchool({externalSubject:H('hq')},{legalName:'B2 D9 Fixture LLC',displayName:'B2 D9 Fixture',schoolName:'B2 D9 Main',schoolSlug:'b2-d9-'+K().slice(0,8),timezone:'UTC',initialTier:'COMPLETE',idempotencyKey:K(),expectedPrincipalId:humans.hq.id});
    await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute')",
      [d9.organizationId,d9.schoolId,humans.d9.id,d9.ownerRoleId,humans.hq.id]);
    await access.awaitFirstPayment(H('hq'),d9.organizationId,{expectedEntitlementVersion:1},K());
    d7=(await admin.query('SELECT hon.initialize_saas_hon_os_school_account($1,$2::jsonb,$3,$4,$5) receipt',[
      H('d7'),JSON.stringify({legalName:'B2 D7 Fixture LLC',displayName:'B2 D7 Fixture',schoolName:'B2 D7 Main',schoolSlug:'b2-d7-'+K().slice(0,8),timezone:'UTC'}),K(),K(),K()])).rows[0].receipt;
  } finally { await setAccessProgram(false); }
  assert.deepEqual(await row("SELECT status,mutations_enabled FROM hon.saas_access_program"),{status:'INACTIVE',mutations_enabled:false});
  assert.equal((await row("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='saas_access_program_status_check'")).definition,STATUS_CHECK);
  for(const [label,fixture] of [['D9',d9],['D7',d7]]){
    assert.deepEqual(await row('SELECT state,reason FROM hon.saas_access_states WHERE organization_id=$1',[fixture.organizationId]),{state:'AWAITING_FIRST_PAYMENT',reason:'AWAITING_INITIAL_PAYMENT'},label);
    assert.equal((await row('SELECT count(*)::int n FROM hon.saas_subscriptions WHERE organization_id=$1',[fixture.organizationId])).n,0,label+' starts without a subscription');
    assert.equal((await row("SELECT count(*)::int n FROM hon.saas_checkout_sessions WHERE organization_id=$1 AND status IN ('CREATED','OPEN')",[fixture.organizationId])).n,0,label+' starts without checkout');
  }
  assert.equal((await row("SELECT reason FROM hon.saas_access_transitions WHERE organization_id=$1 AND kind='AWAITING_FIRST_PAYMENT'",[d9.organizationId])).reason,'AWAITING_INITIAL_PAYMENT');
  assert.equal((await row("SELECT reason FROM hon.saas_access_transitions WHERE organization_id=$1 AND kind='AWAITING_FIRST_PAYMENT'",[d7.organizationId])).reason,'NEW_SCHOOL_REGISTERED');

  const generation=await prepareGeneration('school',org.school);
  const d9Generation=await prepareGeneration('d9',d9.schoolId);
  const d7Generation=await prepareGeneration('d7',d7.schoolId);
  const input={generationId:generation.generationId,generationDigest:generation.generationDigest,confirmation:contracts.SAAS_SCHEDULE_BINDING_CONFIRMATION};
  await deny(()=>schedules.start(H('school'),org.school,input,K()),422,'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_bindings')).n,0,'disabled program must roll back binding intent');
  await payments.setPaymentProgram(H('hq'),{action:'ENABLE_TEST_MODE',expectedVersion:1,provider:'STRIPE_SIMULATED',testTaxReference:'B2 TEST TAX',authorizationReference:'B2 TEST AUTHORIZATION'},K());
  const key=K(),receipt=await schedules.start(H('school'),org.school,input,key),binding=receipt.binding;
  assert.equal(binding.provider,'STRIPE_SIMULATED');assert.equal(binding.mode,'TEST');assert.equal(binding.status,'BOUND_TEST_ONLY');assert.equal(binding.billingEnabled,false);assert.equal(binding.checkoutAvailable,false);assert.equal(binding.accessDecidedSeparately,true);assert.equal('accessGranted' in binding,false);assert.equal(binding.version,2);assert.equal(binding.requirements.lockedPriceMinor,offer.priceMinor);assert.equal(binding.requirements.priceRule,'LOCKED_WHILE_SUBSCRIBED');
  assert.equal(provider.calls,1);assert.deepEqual((await schedules.start(H('school'),org.school,input,key)).binding,binding);assert.equal(provider.calls,1);

  // Direct fixture rows exercise every pre-existing lifecycle conflict without invoking checkout, payment, or a
  // provider adapter. They are removed immediately; B2 observes only the immutable availability predicate.
  const catalogInput=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);catalogInput.termsReference='B2 conflict fixture catalog terms';
  catalogInput.founderProgram={...catalogInput.founderProgram,eligibility:'ANY_ACTIVE_ORGANIZATION',opensAt:new Date(Date.now()-3600_000).toISOString()};
  const catalogDraft=await billing.createCatalogDraft(H('hq'),catalogInput,K());await billing.publishCatalog(H('hq'),catalogDraft.catalog.catalogId,K());
  const catalogOffer=await row("SELECT id,catalog_id,plan_code,offer_kind,billing_interval,price_minor FROM hon.saas_catalog_offers WHERE catalog_id=$1 AND plan_code='COMPLETE' AND offer_kind='REGULAR_MONTHLY'",[catalogDraft.catalog.catalogId]);
  const conflictBindings=(await row('SELECT count(*)::int n FROM hon.saas_schedule_bindings')).n,conflictOutbox=(await row('SELECT count(*)::int n FROM hon.saas_outbox')).n,conflictCalls=provider.calls;
  const activeSubscription=K(),activeCheckout=K();
  await withUserTriggersDisabled(['saas_subscriptions','saas_checkout_sessions'],async()=>{
    await admin.query("INSERT INTO hon.saas_subscriptions(id,organization_id,source,plan_code,entitlement_tier,billing_interval,entitlement_version_at_record,status,status_reason,version,created_by_principal_id,created_at,updated_at) VALUES($1,$2,'LEGACY_ENTITLEMENT','COMPLETE','COMPLETE','NONE',1,'PENDING_ACTIVATION','RECORDED',1,$3,clock_timestamp(),clock_timestamp())",[activeSubscription,foreign.id,humans.other.id]);
    await admin.query("INSERT INTO hon.saas_checkout_sessions(id,organization_id,school_id,catalog_id,offer_id,plan_code,offer_kind,billing_interval,amount_minor,requester_kind,requested_by_principal_id,provider,status,status_reason,expires_at,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'SCHOOL_OWNER',$10,'STRIPE_SIMULATED','CREATED','CREATED',clock_timestamp()+interval '1 hour',1,clock_timestamp(),clock_timestamp())",[activeCheckout,foreign.id,foreign.school,catalogOffer.catalog_id,catalogOffer.id,catalogOffer.plan_code,catalogOffer.offer_kind,catalogOffer.billing_interval,catalogOffer.price_minor,humans.other.id]);
  });
  await admin.query("INSERT INTO hon.saas_access_states(organization_id,state,reason,version,checkout_id,subscription_id,changed_by_principal_id,created_at,updated_at) VALUES($1,'PAYMENT_ACTIVE','FIRST_PAYMENT_VERIFIED',1,$2,$3,$4,clock_timestamp(),clock_timestamp())",[foreign.id,activeCheckout,activeSubscription,humans.hq.id]);
  await sqlRuleDeny(admin.query('SELECT hon.saas_schedule_binding_available($1)',[foreign.id]),'SAAS_SUBSCRIPTION_EXISTS');
  await withUserTriggersDisabled(['saas_access_states','saas_checkout_sessions','saas_subscriptions'],async()=>{
    await admin.query('DELETE FROM hon.saas_access_states WHERE organization_id=$1',[foreign.id]);
    await admin.query('DELETE FROM hon.saas_checkout_sessions WHERE id=$1',[activeCheckout]);
    await admin.query('DELETE FROM hon.saas_subscriptions WHERE id=$1',[activeSubscription]);
  });
  const openCheckout=K();
  await withUserTriggersDisabled(['saas_checkout_sessions'],()=>admin.query("INSERT INTO hon.saas_checkout_sessions(id,organization_id,school_id,catalog_id,offer_id,plan_code,offer_kind,billing_interval,amount_minor,requester_kind,requested_by_principal_id,provider,status,status_reason,expires_at,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'SCHOOL_OWNER',$10,'STRIPE_SIMULATED','CREATED','CREATED',clock_timestamp()+interval '1 hour',1,clock_timestamp(),clock_timestamp())",[openCheckout,foreign.id,foreign.school,catalogOffer.catalog_id,catalogOffer.id,catalogOffer.plan_code,catalogOffer.offer_kind,catalogOffer.billing_interval,catalogOffer.price_minor,humans.other.id]));
  await sqlRuleDeny(admin.query('SELECT hon.saas_schedule_binding_available($1)',[foreign.id]),'SAAS_CHECKOUT_OPEN');
  await withUserTriggersDisabled(['saas_checkout_sessions'],()=>admin.query('DELETE FROM hon.saas_checkout_sessions WHERE id=$1',[openCheckout]));
  const liveException=K();
  await withUserTriggersDisabled(['saas_access_exceptions'],()=>admin.query("INSERT INTO hon.saas_access_exceptions(id,organization_id,school_id,purpose,reason,scope_tier,starts_at,expires_at,policy_version,max_days,prior_entitlement,granted_entitlement,granted_entitlement_version,granted_by_principal_id,granted_at,status) VALUES($1,$2,$3,'INTERNAL_TESTING','Disposable B2 conflict fixture','COMPLETE',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day',1,2,'{}','{}',2,$4,clock_timestamp(),'GRANTED')",[liveException,foreign.id,foreign.school,humans.hq.id]));
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE',status='ACTIVE',effective_from=clock_timestamp()-interval '1 minute',effective_until=clock_timestamp()+interval '1 day',version=2 WHERE organization_id=$1",[foreign.id]);
  await sqlRuleDeny(admin.query('SELECT hon.saas_schedule_binding_available($1)',[foreign.id]),'SAAS_ACCESS_EXCEPTION_ACTIVE');
  await withUserTriggersDisabled(['saas_access_exceptions'],async()=>{
    await admin.query('DELETE FROM hon.saas_access_exceptions WHERE id=$1',[liveException]);
    await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE',status='SUSPENDED',effective_from=clock_timestamp(),effective_until=NULL,version=1 WHERE organization_id=$1",[foreign.id]);
  });
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_bindings')).n,conflictBindings,'all conflict rows refuse before a B2 binding');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_outbox')).n,conflictOutbox,'all conflict rows refuse before B2 audit/outbox work');
  assert.equal(provider.calls,conflictCalls,'all conflict rows refuse before adapter invocation');
  const d7Input={generationId:d7Generation.generationId,generationDigest:d7Generation.generationDigest,confirmation:contracts.SAAS_SCHEDULE_BINDING_CONFIRMATION};
  const d9Input={generationId:d9Generation.generationId,generationDigest:d9Generation.generationDigest,confirmation:contracts.SAAS_SCHEDULE_BINDING_CONFIRMATION};
  const d7Key=K(),[d7Receipt,d9Receipt]=await Promise.all([
    schedules.start(H('d7'),d7.schoolId,d7Input,d7Key),
    schedules.start(H('d9'),d9.schoolId,d9Input,K()),
  ]);
  assert.equal(provider.calls,3,'separately authorized awaiting organizations may bind independently');
  for(const [label,fixture,receipt] of [['D7',d7,d7Receipt],['D9',d9,d9Receipt]]){
    assert.equal(receipt.replayed,false,label);
    assert.deepEqual([receipt.binding.organizationId,receipt.binding.schoolId,receipt.binding.status,receipt.binding.checkoutAvailable,receipt.binding.billingEnabled,receipt.binding.accessDecidedSeparately],
      [fixture.organizationId,fixture.schoolId,'BOUND_TEST_ONLY',false,false,true],label);
    assert.deepEqual(await row('SELECT tier::text,status::text FROM hon.organization_entitlements WHERE organization_id=$1',[fixture.organizationId]),{tier:'COMPLETE',status:'SUSPENDED'},label+' leaves entitlement suspended');
    assert.deepEqual(await row('SELECT state,reason FROM hon.saas_access_states WHERE organization_id=$1',[fixture.organizationId]),{state:'AWAITING_FIRST_PAYMENT',reason:'AWAITING_INITIAL_PAYMENT'},label+' leaves access awaiting');
  }
  const d7Replay=await schedules.start(H('d7'),d7.schoolId,d7Input,d7Key);
  assert.equal(d7Replay.replayed,true);assert.deepEqual(d7Replay.binding,d7Receipt.binding);assert.equal(provider.calls,3,'bound replay never recontacts the adapter');
  await deny(()=>schedules.start(H('d7'),d7.schoolId,d7Input,K()),409,'SAAS_SCHEDULE_BINDING_EXISTS');
  await deny(()=>schedules.start(H('d7'),d7.schoolId,d9Input,K()),404,'SAAS_UNAVAILABLE');
  assert.equal(provider.calls,3,'duplicate and cross-organization requests do not contact the adapter');
  await deny(()=>schedules.start(H('school'),org.second,input,K()),403,'SAAS_FORBIDDEN');await deny(()=>schedules.read(H('other'),foreign.school,binding.bindingId),404,'SAAS_UNAVAILABLE');
  const notAttempted={accessActivation:'NOT_ATTEMPTED',reason:null,paidThrough:null,accessUntil:null};
  for(const view of [await schedules.read(H('staff'),org.school,binding.bindingId),await schedules.readHq(H('hq'),binding.bindingId)]){
    const {access:viewAccess,...billingView}=view;assert.deepEqual(billingView,binding);assert.deepEqual(viewAccess,notAttempted);
  }

  // The reverse D9 writer and B2 use the same organization key. A waiting state may win and B2 then succeeds;
  // a B2 intent may win and the later D9 write is an explicit no-effect lifecycle conflict. No race activates access.
  const race=await onboarding.provisionInitialSchool({externalSubject:H('hq')},{legalName:'B2 Race Fixture LLC',displayName:'B2 Race Fixture',schoolName:'B2 Race Main',schoolSlug:'b2-race-'+K().slice(0,8),timezone:'UTC',initialTier:'COMPLETE',idempotencyKey:K(),expectedPrincipalId:humans.hq.id});
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute')",
    [race.organizationId,race.schoolId,humans.race.id,race.ownerRoleId,humans.hq.id]);
  const raceGeneration=await prepareGeneration('race',race.schoolId);
  const raceInput={generationId:raceGeneration.generationId,generationDigest:raceGeneration.generationDigest,confirmation:contracts.SAAS_SCHEDULE_BINDING_CONFIRMATION};
  let raceStart,raceAwait;
  await setAccessProgram(true);
  try {
    [raceStart,raceAwait]=await Promise.allSettled([
      schedules.start(H('race'),race.schoolId,raceInput,K()),
      access.awaitFirstPayment(H('hq'),race.organizationId,{expectedEntitlementVersion:1},K()),
    ]);
  } finally { await setAccessProgram(false); }
  assert.equal(raceStart.status,'fulfilled',raceStart.status==='rejected'?raceStart.reason?.stack:'');
  assert.deepEqual([raceStart.value.binding.organizationId,raceStart.value.binding.schoolId,raceStart.value.binding.checkoutAvailable,raceStart.value.binding.billingEnabled,raceStart.value.binding.accessDecidedSeparately],
    [race.organizationId,race.schoolId,false,false,true]);
  if(raceAwait.status==='fulfilled') {
    assert.deepEqual(await row('SELECT state,reason FROM hon.saas_access_states WHERE organization_id=$1',[race.organizationId]),{state:'AWAITING_FIRST_PAYMENT',reason:'AWAITING_INITIAL_PAYMENT'});
  } else {
    assert.equal(raceAwait.reason?.getStatus?.(),422);assert.equal(raceAwait.reason?.getResponse?.().code,'SAAS_SCHEDULE_LIFECYCLE_CONFLICT');
    assert.equal((await row('SELECT count(*)::int n FROM hon.saas_access_states WHERE organization_id=$1',[race.organizationId])).n,0);
  }
  assert.deepEqual(await row("SELECT status,mutations_enabled FROM hon.saas_access_program"),{status:'INACTIVE',mutations_enabled:false});
  assert.equal((await row("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='saas_access_program_status_check'")).definition,STATUS_CHECK);
  const malformedObservation={identity:'DETERMINISTIC_FAKE',mode:'TEST',outcome:'BOUND',bindingId:binding.bindingId,bindingKey:binding.bindingKey,requirementsDigest:binding.requirementsDigest,
    accountReference:'fake_null_flag_account',subscriptionReference:'fake_null_flag_subscription',scheduleReference:'fake_null_flag_schedule',automaticCalendarTransition:null,automaticCollectionEnabled:null};
  await sqlDeny(restricted.query('SELECT hon.record_saas_schedule_binding_observation($1::uuid,$2::jsonb,$3::uuid,$4::uuid)',[binding.bindingId,malformedObservation,K(),K()]),'22023');
  passed('exact A2/B1 lineage, explicit founder refusal pending C, TEST simulated binding, malformed-observation refusal, durable recovery, school/HQ isolation, and no checkout/access effect');
  const price=binding.requirements.lockedPriceMinor;
  const evt=()=>'evt_'+K().replaceAll('-','_');
  const baseEvent=(eventId,amountMinor=price,startsAt='2031-01-01T00:00:00.000Z',endsAt='2031-02-01T00:00:00.000Z',b=binding)=>({provider:'STRIPE_SIMULATED',mode:'TEST',eventId,eventType:'invoice.paid',bindingId:b.bindingId,
    accountReference:b.providerAccountReference,subscriptionReference:b.providerSubscriptionReference,scheduleReference:b.providerScheduleReference,
    invoiceReference:'fake_invoice_'+eventId.slice(4).toLowerCase(),relatedInvoiceReference:null,coveredPeriod:{startsAt,endsAt},amountMinor,currency:'USD',occurredAt:new Date().toISOString()});
  const ingest=async e=>schedules.ingestVerifiedTestEvidence(e,await digest(e));
  const invalidOccurredAt=baseEvent(evt());invalidOccurredAt.occurredAt='2031-02-30T00:00:00.000Z';
  const invalidOccurredAtDigest=await digest(invalidOccurredAt);
  await deny(()=>schedules.ingestVerifiedTestEvidence(invalidOccurredAt,invalidOccurredAtDigest),400,'INVALID_SAAS_INPUT');
  const futureOccurredAt=baseEvent(evt());futureOccurredAt.occurredAt=new Date(Date.now()+600_000).toISOString();
  const futureOccurredAtDigest=await digest(futureOccurredAt);
  await deny(()=>schedules.ingestVerifiedTestEvidence(futureOccurredAt,futureOccurredAtDigest),400,'INVALID_SAAS_INPUT');
  // The payload's bindingId must agree with the provider references; it can never select another organization's binding.
  const crossed={...baseEvent(evt()),bindingId:d9Receipt.binding.bindingId},crossedDigest=await digest(crossed);
  await deny(()=>schedules.ingestVerifiedTestEvidence(crossed,crossedDigest),409,'SAAS_OUTCOME_UNKNOWN');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_provider_events WHERE provider_event_id=$1',[crossed.eventId])).n,0);
  // A failed attempt before any payment is stored without a review row and changes nothing.
  const earlyFail={...baseEvent(evt()),eventType:'invoice.payment_failed'},earlyFailReceipt=await ingest(earlyFail);
  assert.deepEqual([earlyFailReceipt.outcome,earlyFailReceipt.reason,earlyFailReceipt.billingStatus],['ATTEMPT_FAILED','PAYMENT_NOT_VERIFIED','BOUND_TEST_ONLY']);
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_reconciliations WHERE provider_event_id=$1',[earlyFail.eventId])).n,0);
  // First verified payment: billing outcome ACTIVE, access outcome reported separately (stub: NOT_ATTEMPTED).
  const paid=baseEvent(evt()),paidReceipt=await ingest(paid);
  assert.deepEqual([paidReceipt.outcome,paidReceipt.billingStatus,paidReceipt.qualifyingPaidPeriodCount,paidReceipt.access],['APPLIED','ACTIVE',1,{accessActivation:'NOT_ATTEMPTED',accessGranted:false}]);
  const active=await schedules.read(H('school'),org.school,binding.bindingId);
  assert.deepEqual([active.status,active.statusReason,active.version],['ACTIVE','FIRST_PAYMENT_VERIFIED',3]);assert(active.activatedAt);
  assert.equal((await row("SELECT count(*)::int n FROM hon.saas_audit WHERE entity_id=$1 AND action_code='saas.schedule_binding.transition' AND next_state->>'status'='ACTIVE'",[binding.bindingId])).n,1,'ACTIVE transition is audited');
  assert.deepEqual(await row('SELECT tier::text,status::text FROM hon.organization_entitlements WHERE organization_id=$1',[org.id]),{tier:'COMPLETE',status:'SUSPENDED'},'billing ACTIVE never implies access');
  const storedPaidEvent=await row('SELECT provider_occurred_at,received_at,outcome FROM hon.saas_schedule_provider_events WHERE provider_event_id=$1',[paid.eventId]);
  assert.equal(storedPaidEvent.provider_occurred_at.toISOString(),paid.occurredAt);assert(storedPaidEvent.received_at instanceof Date);assert.equal(storedPaidEvent.outcome,'APPLIED');
  assert.deepEqual(await ingest(paid),paidReceipt,'same event replays immutable original evidence');
  const conflicting={...paid,amountMinor:price-1},conflictingDigest=await digest(conflicting);
  await deny(()=>schedules.ingestVerifiedTestEvidence(conflicting,conflictingDigest),409,'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_provider_events WHERE provider_event_id=$1',[paid.eventId])).n,1,'conflicting digest must not replace immutable event evidence');
  const concurrent=baseEvent(evt(),price,'2031-02-01T00:00:00.000Z','2031-03-01T00:00:00.000Z');
  const concurrentDigest=await digest(concurrent),concurrentReceipts=await Promise.all([schedules.ingestVerifiedTestEvidence(concurrent,concurrentDigest),schedules.ingestVerifiedTestEvidence(concurrent,concurrentDigest)]);
  assert.deepEqual(concurrentReceipts[0],concurrentReceipts[1]);assert.deepEqual([concurrentReceipts[0].outcome,concurrentReceipts[0].qualifyingPaidPeriodCount,concurrentReceipts[0].billingStatus],['APPLIED',2,'ACTIVE']);
  const duplicate=baseEvent(evt());duplicate.invoiceReference=paid.invoiceReference;duplicate.coveredPeriod={startsAt:'2031-03-01T00:00:00.000Z',endsAt:'2031-04-01T00:00:00.000Z'};
  const duplicateReceipt=await ingest(duplicate);assert.deepEqual([duplicateReceipt.outcome,duplicateReceipt.qualifyingPaidPeriodCount],['ALREADY_APPLIED',2]);
  // Same locked price on every period: a late earlier period is recorded, never parked (no count-based expected amount).
  const lateEarlier=baseEvent(evt(),price,'2030-12-01T00:00:00.000Z','2031-01-01T00:00:00.000Z');
  const lateReceipt=await ingest(lateEarlier);assert.deepEqual([lateReceipt.outcome,lateReceipt.qualifyingPaidPeriodCount,lateReceipt.billingStatus],['APPLIED',3,'ACTIVE']);
  const failed={...baseEvent(evt()),eventType:'invoice.payment_failed'},failedReceipt=await ingest(failed);
  assert.deepEqual([failedReceipt.outcome,failedReceipt.reason,failedReceipt.billingStatus],['ATTEMPT_FAILED','PAYMENT_NOT_VERIFIED','ACTIVE']);
  const eventsBeforeUnsupported=(await row('SELECT count(*)::int n FROM hon.saas_schedule_provider_events')).n,unsupported={...baseEvent(evt()),eventType:'invoice.payment_pending'},unsupportedDigest=await digest(unsupported);
  await deny(()=>schedules.ingestVerifiedTestEvidence(unsupported,unsupportedDigest),400,'INVALID_SAAS_INPUT');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_provider_events')).n,eventsBeforeUnsupported,'unsupported event must have no ledger effect');
  assert.equal(await row('SELECT hon.saas_org_billing_conflict($1) c',[org.id]).then(r=>r.c),null);
  // Wrong amount: money is recorded as evidence, never counted, and billing parks in review; nothing after it counts.
  const wrong=baseEvent(evt(),price+1,'2031-04-01T00:00:00.000Z','2031-05-01T00:00:00.000Z'),wrongReceipt=await ingest(wrong);
  assert.deepEqual([wrongReceipt.outcome,wrongReceipt.reason,wrongReceipt.billingStatus,wrongReceipt.qualifyingPaidPeriodCount],['NEEDS_REVIEW','AMOUNT_MISMATCH','NEEDS_REVIEW',3]);
  const parked=baseEvent(evt(),price,'2031-05-01T00:00:00.000Z','2031-06-01T00:00:00.000Z'),parkedReceipt=await ingest(parked);
  assert.deepEqual([parkedReceipt.outcome,parkedReceipt.reason,parkedReceipt.billingStatus,parkedReceipt.qualifyingPaidPeriodCount],['NEEDS_REVIEW','BINDING_NOT_COLLECTING','NEEDS_REVIEW',3]);
  const reverse={...baseEvent(evt()),eventType:'charge.refunded',invoiceReference:null,relatedInvoiceReference:paid.invoiceReference,coveredPeriod:null};
  assert.deepEqual([(await ingest(reverse)).outcome,(await row('SELECT outcome_reason r FROM hon.saas_schedule_provider_events WHERE provider_event_id=$1',[reverse.eventId])).r],['NEEDS_REVIEW','BINDING_NOT_COLLECTING']);
  const reviewed=await schedules.read(H('school'),org.school,binding.bindingId);
  assert.deepEqual([reviewed.status,reviewed.statusReason,reviewed.qualifyingPaidPeriodCount,reviewed.unresolvedReconciliation],['NEEDS_REVIEW','AMOUNT_MISMATCH',3,true]);
  // The shared conflict probe is read-only: it runs inside a READ ONLY transaction and reports the held payment.
  await admin.query('BEGIN READ ONLY');assert.equal((await row('SELECT hon.saas_org_billing_conflict($1) c',[org.id])).c,'PAID_NEEDS_REVIEW');await admin.query('COMMIT');
  await sqlRuleDeny(admin.query('SELECT hon.saas_schedule_binding_available($1)',[org.id]),'SAAS_BILLING_REVIEW_PENDING');
  // Refunds and disputes on a collecting binding park it too.
  const refundOnRace={...baseEvent(evt(),price,undefined,undefined,raceStart.value.binding),eventType:'charge.dispute.created',invoiceReference:null,relatedInvoiceReference:'fake_invoice_unknown',coveredPeriod:null};
  const raceReceipt=await ingest(refundOnRace);assert.deepEqual([raceReceipt.outcome,raceReceipt.reason,raceReceipt.billingStatus],['NEEDS_REVIEW','UNLINKED_REVERSAL','NEEDS_REVIEW']);
  // One payment covers exactly one billing interval of the locked terms (calendar month or year, within one day).
  const matches=async(i,st,en)=>(await row('SELECT hon.saas_schedule_period_matches($1,$2,$3) m',[i,st,en])).m;
  for(const [i,st,en,ok] of [['MONTHLY','2031-01-31T00:00:00Z','2031-02-28T00:00:00Z',true],['MONTHLY','2031-01-01T00:00:00Z','2031-02-02T00:00:00Z',true],
    ['MONTHLY','2031-01-01T00:00:00Z','2031-02-02T00:00:01Z',false],['MONTHLY','2031-01-01T00:00:00Z','2036-01-01T00:00:00Z',false],['MONTHLY','2031-01-01T00:00:00Z','2031-01-15T00:00:00Z',false],
    ['ANNUAL','2031-01-01T00:00:00Z','2032-01-01T00:00:00Z',true],['ANNUAL','2031-01-01T00:00:00Z','2031-12-31T00:00:00Z',true],['ANNUAL','2031-01-01T00:00:00Z','2031-02-01T00:00:00Z',false],
    ['ANNUAL','2031-01-01T00:00:00Z','2036-01-01T00:00:00Z',false],['WEEKLY','2031-01-01T00:00:00Z','2031-01-08T00:00:00Z',false]]) assert.equal(await matches(i,st,en),ok,[i,st,en].join(' '));
  const ivOrg=await onboarding.provisionInitialSchool({externalSubject:H('hq')},{legalName:'B2 Interval Fixture LLC',displayName:'B2 Interval Fixture',schoolName:'B2 Interval Main',schoolSlug:'b2-iv-'+K().slice(0,8),timezone:'UTC',initialTier:'COMPLETE',idempotencyKey:K(),expectedPrincipalId:humans.hq.id});
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute')",
    [ivOrg.organizationId,ivOrg.schoolId,humans.iv.id,ivOrg.ownerRoleId,humans.hq.id]);
  const ivGeneration=await prepareGeneration('iv',ivOrg.schoolId);
  const ivBinding=(await schedules.start(H('iv'),ivOrg.schoolId,{generationId:ivGeneration.generationId,generationDigest:ivGeneration.generationDigest,confirmation:contracts.SAAS_SCHEDULE_BINDING_CONFIRMATION},K())).binding;
  assert.equal(ivBinding.requirements.billingInterval,'MONTHLY');
  const fiveYears=await ingest(baseEvent(evt(),price,'2031-01-01T00:00:00.000Z','2036-01-01T00:00:00.000Z',ivBinding));
  assert.deepEqual([fiveYears.outcome,fiveYears.reason,fiveYears.billingStatus,fiveYears.qualifyingPaidPeriodCount],['NEEDS_REVIEW','PERIOD_INTERVAL_MISMATCH','NEEDS_REVIEW',0],'one monthly payment never covers five years');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_paid_periods WHERE binding_id=$1',[ivBinding.bindingId])).n,0);
  assert.equal((await row("SELECT count(*)::int n FROM hon.saas_schedule_reconciliations WHERE binding_id=$1 AND reason='PERIOD_INTERVAL_MISMATCH'",[ivBinding.bindingId])).n,1);
  passed('locked-price evidence: billing ACTIVE on the first verified payment with access reported separately; replay, digest conflict, concurrent duplicate, late earlier period, failed attempts, wrong amounts, periods that are not exactly one billing interval, reversals and payments to parked bindings are stored and fail closed');

  // An access hook that fails (or breaks its contract) never undoes the payment: the period, event and ACTIVE billing stay.
  const d7Binding=d7Receipt.binding,d7Paid=baseEvent(evt(),price,undefined,undefined,d7Binding);
  await admin.query("CREATE OR REPLACE FUNCTION hon.saas_schedule_after_paid_period(p_binding uuid,p_period uuid,p_at timestamptz) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $f$ BEGIN UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=(SELECT organization_id FROM hon.saas_schedule_bindings WHERE id=p_binding); RAISE EXCEPTION 'synthetic access failure'; END $f$");
  const d7Receipt2=await ingest(d7Paid);
  assert.deepEqual([d7Receipt2.outcome,d7Receipt2.billingStatus,d7Receipt2.qualifyingPaidPeriodCount,d7Receipt2.access],['APPLIED','ACTIVE',1,{accessActivation:'NEEDS_REVIEW',reason:'ACCESS_HOOK_FAILED',accessGranted:false}]);
  assert.deepEqual(await row('SELECT tier::text,status::text FROM hon.organization_entitlements WHERE organization_id=$1',[d7.organizationId]),{tier:'COMPLETE',status:'SUSPENDED'},'failed hook work is rolled back');
  assert.equal((await row("SELECT count(*)::int n FROM hon.saas_schedule_reconciliations WHERE binding_id=$1 AND reason='ACCESS_HOOK_FAILED'",[d7Binding.bindingId])).n,1);
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_paid_periods WHERE binding_id=$1',[d7Binding.bindingId])).n,1);
  await admin.query("CREATE OR REPLACE FUNCTION hon.saas_schedule_after_paid_period(p_binding uuid,p_period uuid,p_at timestamptz) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $f$ SELECT jsonb_build_object('accessActivation','GRANTED_BY_STATUS') $f$");
  const d7Next=baseEvent(evt(),price,'2031-02-01T00:00:00.000Z','2031-03-01T00:00:00.000Z',d7Binding),d7Receipt3=await ingest(d7Next);
  assert.deepEqual([d7Receipt3.outcome,d7Receipt3.billingStatus,d7Receipt3.qualifyingPaidPeriodCount,d7Receipt3.access.accessActivation],['APPLIED','ACTIVE',2,'NEEDS_REVIEW']);
  await restoreHook();
  assert.equal((await row('SELECT hon.saas_schedule_after_paid_period($1,$2,clock_timestamp()) r',[K(),K()])).r.accessActivation,'NOT_ATTEMPTED');
  passed('billing and access are separate outcomes: a failing or contract-breaking access hook is isolated, rolled back and recorded for review while the payment stands');

  // Lifecycle: a PENDING binding with an unknown provider outcome is reconciled only from a definite provider answer.
  const foreignGeneration=await prepareGeneration('other',foreign.school);
  const failing=new SaasScheduleBillingService(billing,{async bindOrFindSchedule(){throw new Error('network');}});
  const foreignInput={generationId:foreignGeneration.generationId,generationDigest:foreignGeneration.generationDigest,confirmation:contracts.SAAS_SCHEDULE_BINDING_CONFIRMATION};
  await deny(()=>failing.start(H('other'),foreign.school,foreignInput,K()),503,'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE');
  const pendingRow=await row("SELECT id FROM hon.saas_schedule_bindings WHERE organization_id=$1 AND status='PENDING_PROVIDER_BINDING'",[foreign.id]);
  const pendingView=await schedules.readHq(H('hq'),pendingRow.id);
  const freshProvider=new DeterministicScheduleProvider(),reconciler=new SaasScheduleBillingService(billing,freshProvider);
  const voided=await reconciler.reconcilePending(pendingView);
  assert.deepEqual([voided.binding.status,voided.binding.statusReason,voided.binding.version,voided.replayed],['VOIDED_PROVIDER_FAILED','PROVIDER_CONFIRMED_NOT_CREATED',2,false]);assert(voided.binding.terminalAt);
  assert.equal((await restricted.query('SELECT hon.record_saas_schedule_binding_reconciliation($1::uuid,$2::jsonb) r',[pendingRow.id,{identity:'DETERMINISTIC_FAKE',mode:'TEST',outcome:'NOT_FOUND',bindingId:pendingRow.id,bindingKey:pendingView.bindingKey,requirementsDigest:pendingView.requirementsDigest}])).rows[0].r.replayed,true);
  await admin.query('SELECT hon.saas_schedule_binding_available($1)',[foreign.id]);
  // A terminal binding stores late money for review and counts nothing.
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_bindings WHERE organization_id=$1 AND status IN (\'PENDING_PROVIDER_BINDING\',\'BOUND_TEST_ONLY\',\'ACTIVE\',\'NEEDS_REVIEW\')',[foreign.id])).n,0,'a voided binding releases the organization');

  // Unpaid expiry uses the shipped owner policy (OD-4: 7 days = 10080 minutes), immutable even for the owner.
  const d9Binding=d9Receipt.binding;
  const policy=await row('SELECT policy_id,version,unpaid_window_minutes,approved_by_principal_id,approval_reference FROM hon.saas_billing_lifecycle_policy');
  assert.deepEqual([policy.policy_id,policy.version,policy.unpaid_window_minutes,policy.approved_by_principal_id],[1,1,10080,null]);assert.match(policy.approval_reference,/^OD-4 owner decision 2026-11-09/);
  for(const q of ["UPDATE hon.saas_billing_lifecycle_policy SET unpaid_window_minutes=15","DELETE FROM hon.saas_billing_lifecycle_policy","TRUNCATE hon.saas_billing_lifecycle_policy"]){await admin.query('BEGIN');await sqlDeny(admin.query(q),'42501');await admin.query('ROLLBACK');}
  await deny(()=>schedules.expireUnpaid(d9Binding),422,'SAAS_SCHEDULE_BINDING_NOT_EXPIRABLE');
  provider.collected.add(d9Binding.bindingId);
  await deny(()=>schedules.expireUnpaid(d9Binding),503,'SAAS_SCHEDULE_BINDING_RECONCILIATION_REQUIRED');provider.collected.delete(d9Binding.bindingId);
  // The window runs from sign-up (binding creation): one minute short of seven days is still open; seven days elapsed expires.
  await withUserTriggersDisabled(['saas_schedule_bindings'],()=>admin.query("UPDATE hon.saas_schedule_bindings SET created_at=clock_timestamp()-interval '10079 minutes' WHERE id=$1",[d9Binding.bindingId]));
  await deny(()=>schedules.expireUnpaid(d9Binding),422,'SAAS_SCHEDULE_BINDING_NOT_EXPIRABLE');
  await withUserTriggersDisabled(['saas_schedule_bindings'],()=>admin.query("UPDATE hon.saas_schedule_bindings SET created_at=clock_timestamp()-interval '10081 minutes' WHERE id=$1",[d9Binding.bindingId]));
  const expired=await schedules.expireUnpaid(d9Binding);
  assert.deepEqual([expired.binding.status,expired.binding.statusReason,expired.binding.version,expired.replayed],['EXPIRED_UNPAID','UNPAID_WINDOW_ELAPSED',3,false]);
  assert.equal((await row('SELECT policy_version v FROM hon.saas_schedule_bindings WHERE id=$1',[d9Binding.bindingId])).v,1);
  assert.equal((await schedules.expireUnpaid({...d9Binding})).replayed,true);
  await admin.query('SELECT hon.saas_schedule_binding_available($1)',[d9.organizationId]);
  const latePaid=baseEvent(evt(),price,undefined,undefined,d9Binding),lateReceipt2=await ingest(latePaid);
  assert.deepEqual([lateReceipt2.outcome,lateReceipt2.reason,lateReceipt2.billingStatus,lateReceipt2.qualifyingPaidPeriodCount],['NEEDS_REVIEW','PAID_AFTER_TERMINAL','EXPIRED_UNPAID',0]);
  // Late money on an ended binding blocks a new lifecycle (no second charge) until HQ resolves it.
  await sqlRuleDeny(admin.query('SELECT hon.saas_schedule_binding_available($1)',[d9.organizationId]),'SAAS_BILLING_REVIEW_PENDING');
  assert.equal((await row('SELECT hon.saas_org_billing_conflict($1) c',[d9.organizationId])).c,'PAID_NEEDS_REVIEW');
  await deny(()=>schedules.start(H('d9'),d9.schoolId,d9Input,K()),422,'SAAS_BILLING_REVIEW_PENDING');
  // Money evidence blocks expiry: the race binding has a stored dispute (and is parked), so it can never expire.
  await sqlRuleDeny(restricted.query('SELECT hon.record_saas_schedule_binding_expiry($1::uuid,$2::jsonb)',[raceStart.value.binding.bindingId,{identity:'DETERMINISTIC_FAKE',mode:'TEST',outcome:'CANCELLED_NOTHING_COLLECTED',bindingId:raceStart.value.binding.bindingId,accountReference:raceStart.value.binding.providerAccountReference,subscriptionReference:raceStart.value.binding.providerSubscriptionReference,scheduleReference:raceStart.value.binding.providerScheduleReference}]),'SAAS_SCHEDULE_BINDING_NOT_EXPIRABLE');

  // Cancel before first payment (OD-4): only the exact school purchaser, only a confirmed no-cost provider cancel,
  // terminal and audited, releases the organization, and late money is stored for review. A paid binding is never cancellable.
  const cancelOrg=await onboarding.provisionInitialSchool({externalSubject:H('hq')},{legalName:'B2 Cancel Fixture LLC',displayName:'B2 Cancel Fixture',schoolName:'B2 Cancel Main',schoolSlug:'b2-cancel-'+K().slice(0,8),timezone:'UTC',initialTier:'COMPLETE',idempotencyKey:K(),expectedPrincipalId:humans.hq.id});
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute')",
    [cancelOrg.organizationId,cancelOrg.schoolId,humans.cancel.id,cancelOrg.ownerRoleId,humans.hq.id]);
  const cancelSchool=cancelOrg.schoolId,cancelGeneration=await prepareGeneration('cancel',cancelSchool);
  const cancelInput={generationId:cancelGeneration.generationId,generationDigest:cancelGeneration.generationDigest,confirmation:contracts.SAAS_SCHEDULE_BINDING_CONFIRMATION};
  const cancelBound=(await schedules.start(H('cancel'),cancelSchool,cancelInput,K())).binding;assert.equal(cancelBound.status,'BOUND_TEST_ONLY');
  await deny(()=>schedules.cancelBeforePayment(H('school'),cancelSchool,cancelBound.bindingId,K()),403);
  await deny(()=>schedules.cancelBeforePayment(H('school'),org.school,cancelBound.bindingId,K()),404);
  provider.collected.add(cancelBound.bindingId);
  await deny(()=>schedules.cancelBeforePayment(H('cancel'),cancelSchool,cancelBound.bindingId,K()),503,'SAAS_SCHEDULE_BINDING_RECONCILIATION_REQUIRED');provider.collected.delete(cancelBound.bindingId);
  assert.equal((await row('SELECT status FROM hon.saas_schedule_bindings WHERE id=$1',[cancelBound.bindingId])).status,'BOUND_TEST_ONLY','an unconfirmed cancel records nothing');
  const cancelKey=K(),cancelled=await schedules.cancelBeforePayment(H('cancel'),cancelSchool,cancelBound.bindingId,cancelKey);
  assert.deepEqual([cancelled.binding.status,cancelled.binding.statusReason,cancelled.binding.version,cancelled.replayed],['CANCELLED_BEFORE_PAYMENT','PURCHASER_CANCELLED_BEFORE_PAYMENT',3,false]);assert(cancelled.binding.terminalAt);
  assert.equal((await row("SELECT count(*)::int n FROM hon.saas_audit WHERE entity_id=$1 AND action_code='saas.schedule_binding.cancel' AND actor_principal_id=$2",[cancelBound.bindingId,humans.cancel.id])).n,1);
  const cancelObservation={identity:'DETERMINISTIC_FAKE',mode:'TEST',outcome:'CANCELLED_NOTHING_COLLECTED',bindingId:cancelBound.bindingId,accountReference:cancelBound.providerAccountReference,subscriptionReference:cancelBound.providerSubscriptionReference,scheduleReference:cancelBound.providerScheduleReference};
  const cancelReplay=(await restricted.query('SELECT hon.cancel_saas_schedule_binding($1,$2,$3,$4::jsonb,$5,$6,$7) r',[H('cancel'),cancelSchool,cancelBound.bindingId,cancelObservation,cancelKey,K(),K()])).rows[0].r;
  assert.equal(cancelReplay.binding.status,'CANCELLED_BEFORE_PAYMENT','exact-key replay returns the recorded receipt');
  await sqlRuleDeny(restricted.query('SELECT hon.cancel_saas_schedule_binding($1,$2,$3,$4::jsonb,$5,$6,$7)',[H('cancel'),cancelSchool,cancelBound.bindingId,cancelObservation,K(),K(),K()]),'SAAS_SCHEDULE_BINDING_NOT_CANCELLABLE');
  assert.equal((await schedules.cancelBeforePayment(H('cancel'),cancelSchool,cancelBound.bindingId,K())).replayed,true);
  await admin.query('SELECT hon.saas_schedule_binding_available($1)',[cancelOrg.organizationId]);
  const cancelLate=await ingest(baseEvent(evt(),price,undefined,undefined,cancelBound));
  assert.deepEqual([cancelLate.outcome,cancelLate.reason,cancelLate.billingStatus],['NEEDS_REVIEW','PAID_AFTER_TERMINAL','CANCELLED_BEFORE_PAYMENT']);
  await sqlRuleDeny(admin.query('SELECT hon.saas_schedule_binding_available($1)',[cancelOrg.organizationId]),'SAAS_BILLING_REVIEW_PENDING');
  const d7Now=await schedules.read(H('d7'),d7.schoolId,d7Binding.bindingId);
  await deny(()=>schedules.cancelBeforePayment(H('d7'),d7.schoolId,d7Binding.bindingId,K()),422,'SAAS_SCHEDULE_BINDING_NOT_CANCELLABLE');
  await sqlRuleDeny(restricted.query('SELECT hon.cancel_saas_schedule_binding($1,$2,$3,$4::jsonb,$5,$6,$7)',[H('d7'),d7.schoolId,d7Binding.bindingId,{...cancelObservation,bindingId:d7Binding.bindingId,accountReference:d7Now.providerAccountReference,subscriptionReference:d7Now.providerSubscriptionReference,scheduleReference:d7Now.providerScheduleReference},K(),K(),K()]),'SAAS_SCHEDULE_BINDING_NOT_CANCELLABLE');

  // The transition table is closed even for the owner, and an unaudited transition cannot commit.
  await admin.query('BEGIN');
  await sqlDeny(admin.query("UPDATE hon.saas_schedule_bindings SET status='BOUND_TEST_ONLY',status_reason='BINDING_OBSERVED_TEST_ONLY',activated_at=NULL,version=version+1 WHERE id=$1",[d7Binding.bindingId]),'42501');
  await admin.query('ROLLBACK');
  await admin.query('BEGIN');
  await sqlDeny(admin.query("UPDATE hon.saas_schedule_bindings SET status='ACTIVE',status_reason='FIRST_PAYMENT_VERIFIED',activated_at=clock_timestamp() WHERE id=$1",[d9Binding.bindingId]),'42501');
  await admin.query('ROLLBACK');
  await admin.query('BEGIN');
  await admin.query("UPDATE hon.saas_schedule_bindings SET status='NEEDS_REVIEW',status_reason='AMOUNT_MISMATCH',version=version+1 WHERE id=$1",[d7Binding.bindingId]);
  await sqlRuleDeny(admin.query('COMMIT'),'SAAS_SCHEDULE_BINDING_EVIDENCE_REQUIRED');
  assert.equal((await row('SELECT status FROM hon.saas_schedule_bindings WHERE id=$1',[d7Binding.bindingId])).status,'ACTIVE');
  assert.equal((await row('SELECT status FROM hon.saas_access_program')).status,'INACTIVE');
  assert.equal((await row("SELECT count(*)::int n FROM hon.saas_access_transitions WHERE kind='FIRST_PAYMENT_ACTIVATION'")).n,0);
  passed('lifecycle: provider-confirmed void, 7-day owner-window unpaid expiry and no-cost purchaser cancel before first payment are terminal and release the organization; late money after terminal is stored for review and blocks a new lifecycle; money evidence blocks expiry; transitions are closed and audited');
  // ---------- 0235 piece 2: the shipped access hook switches access on after the first verified payment ----------
  await admin.query(shippedHook);
  const accessOrgs={};
  await setAccessProgram(true);
  try {
    for(const k of ['pa','pb','pc']) accessOrgs[k]=(await admin.query('SELECT hon.initialize_saas_hon_os_school_account($1,$2::jsonb,$3,$4,$5) receipt',[
      H(k),JSON.stringify({legalName:'B2 '+k+' Fixture LLC',displayName:'B2 '+k+' Fixture',schoolName:'B2 '+k+' Main',schoolSlug:'b2-'+k+'-'+K().slice(0,8),timezone:'UTC'}),K(),K(),K()])).rows[0].receipt;
  } finally { await setAccessProgram(false); }
  const bindFor=async k=>{const g=await prepareGeneration(k,accessOrgs[k].schoolId);
    return (await schedules.start(H(k),accessOrgs[k].schoolId,{generationId:g.generationId,generationDigest:g.generationDigest,confirmation:contracts.SAAS_SCHEDULE_BINDING_CONFIRMATION},K())).binding;};
  const paB=await bindFor('pa'),pbB=await bindFor('pb'),pcB=await bindFor('pc');
  // Calendar-month paid periods (0230 reviews any other length): the first started an hour ago (day of month <= 28).
  const DAY=86_400_000,GRACE=7*DAY,iso=ms=>new Date(ms).toISOString();
  const addMonths=(ms,n)=>{const d=new Date(ms);d.setUTCMonth(d.getUTCMonth()+n);return d.getTime();};
  let t0=Date.now()-3_600_000;while(new Date(t0).getUTCDate()>28)t0-=DAY;
  const P=i=>[addMonths(t0,i),addMonths(t0,i+1)];
  const pay=(b,[s,e])=>baseEvent(evt(),price,iso(s),iso(e),b);
  const ent=id=>row('SELECT tier::text,status::text,effective_from,effective_until,version FROM hon.organization_entitlements WHERE organization_id=$1',[id]);
  const st=id=>row('SELECT state,reason,activation_source,binding_id,first_paid_period_id,paid_through,checkout_id,subscription_id FROM hon.saas_access_states WHERE organization_id=$1',[id]);
  const inEffect=async id=>(await row('SELECT hon.saas_entitlement_json($1) j',[id])).j.inEffect;
  const transitions=async b=>(await admin.query('SELECT kind,outcome,reason FROM hon.saas_access_transitions WHERE binding_id=$1 ORDER BY occurred_at,kind,outcome',[b])).rows.map(r=>[r.kind,r.outcome,r.reason].join(':'));
  const paOrg=accessOrgs.pa.organizationId,pbOrg=accessOrgs.pb.organizationId,pcOrg=accessOrgs.pc.organizationId;
  const paEntBefore=await ent(paOrg);assert.deepEqual([paEntBefore.status,(await st(paOrg)).state],['SUSPENDED','AWAITING_FIRST_PAYMENT']);
  // Shipped posture (program INACTIVE): the payment is kept and billing becomes ACTIVE; access lands in HQ review, unchanged.
  const pa1=await ingest(pay(paB,P(0)));
  assert.deepEqual([pa1.outcome,pa1.billingStatus,pa1.access],['APPLIED','ACTIVE',{accessActivation:'NEEDS_REVIEW',accessGranted:false,reason:'ACCESS_PROGRAM_INACTIVE'}]);
  assert.deepEqual(await ent(paOrg),paEntBefore);assert.equal((await st(paOrg)).state,'AWAITING_FIRST_PAYMENT');assert.equal(await inEffect(paOrg),false);
  const paView=await schedules.readHq(H('hq'),paB.bindingId);
  assert.deepEqual([paView.status,paView.access],['ACTIVE',{accessActivation:'NEEDS_REVIEW',reason:'ACCESS_PROGRAM_INACTIVE',paidThrough:null,accessUntil:null}]);
  assert.deepEqual((await schedules.read(H('pa'),accessOrgs.pa.schoolId,paB.bindingId)).access,paView.access,'school sees the same access outcome');
  // A renewal paid while the review is open still counts as money and waits for the retry.
  const pa2=await ingest(pay(paB,P(1)));
  assert.deepEqual([pa2.outcome,pa2.qualifyingPaidPeriodCount,pa2.access],['APPLIED',2,{accessActivation:'NEEDS_REVIEW',accessGranted:false,reason:'ACTIVATION_PENDING'}]);
  const retryBody={expectedBindingVersion:paView.version};
  await deny(()=>schedules.retryAccess(H('hq'),paB.bindingId,retryBody,K()),422,'SAAS_ACCESS_NOT_ACTIVE');
  await deny(()=>schedules.retryAccess(H('pa'),paB.bindingId,retryBody,K()),403);
  await deny(()=>schedules.retryAccess(H('hq'),paB.bindingId,{expectedBindingVersion:paView.version,extra:true},K()),400,'INVALID_SAAS_INPUT');
  assert.equal(await inEffect(paOrg),false);
  await setAccessProgram(true);
  try {
    await deny(()=>schedules.retryAccess(H('hq'),paB.bindingId,{expectedBindingVersion:paView.version+1},K()),409);
    await deny(()=>schedules.retryAccess(H('hq'),pbB.bindingId,{expectedBindingVersion:pbB.version},K()),422,'SAAS_ACCESS_NOT_RETRYABLE');
    // HQ-owner retry activates on the period in effect, then applies the renewal paid while waiting.
    const retryKey=K(),retried=await schedules.retryAccess(H('hq'),paB.bindingId,retryBody,retryKey);
    assert.deepEqual([retried.bindingId,retried.access.accessActivation,retried.access.accessGranted,retried.access.reason],[paB.bindingId,'APPLIED',true,null]);
    assert.equal(Date.parse(retried.access.paidThrough),P(1)[1]);assert.equal(Date.parse(retried.access.accessUntil),P(1)[1]+GRACE);
    assert.equal(retried.replayed,false);assert.deepEqual(await schedules.retryAccess(H('hq'),paB.bindingId,retryBody,retryKey),{...retried,replayed:true},'exact-key replay');
    await deny(()=>schedules.retryAccess(H('hq'),paB.bindingId,retryBody,K()),422,'SAAS_ACCESS_NOT_RETRYABLE');
    const paEnt=await ent(paOrg),paSt=await st(paOrg);
    assert.deepEqual([paEnt.tier,paEnt.status,paEnt.effective_from.getTime(),paEnt.effective_until.getTime(),paEnt.version],['COMPLETE','ACTIVE',P(0)[0],P(1)[1]+GRACE,paEntBefore.version+2]);
    assert.deepEqual([paSt.state,paSt.reason,paSt.activation_source,paSt.binding_id,paSt.paid_through.getTime(),paSt.checkout_id,paSt.subscription_id],
      ['PAYMENT_ACTIVE','FIRST_PAYMENT_VERIFIED','SCHEDULE_BINDING',paB.bindingId,P(1)[1],null,null]);
    assert.equal(paSt.first_paid_period_id,(await row('SELECT id FROM hon.saas_schedule_paid_periods WHERE binding_id=$1 AND covered_starts_at=$2',[paB.bindingId,new Date(P(0)[0])])).id);
    assert.equal(await inEffect(paOrg),true);
    assert.deepEqual(await transitions(paB.bindingId),['SCHEDULE_FIRST_PAYMENT_ACTIVATION:NEEDS_REVIEW:ACCESS_PROGRAM_INACTIVE','SCHEDULE_FIRST_PAYMENT_ACTIVATION:APPLIED:FIRST_PAYMENT_VERIFIED','SCHEDULE_RENEWAL_EXTENSION:APPLIED:RENEWAL_PAYMENT_VERIFIED']);
    assert.equal((await row("SELECT count(*)::int n FROM hon.saas_audit WHERE action_code='saas.access.retry' AND actor_principal_id=$1 AND organization_id=$2",[humans.hq.id,paOrg])).n,1,'retry is audited once');
    assert.deepEqual((await schedules.read(H('pa'),accessOrgs.pa.schoolId,paB.bindingId)).access,{accessActivation:'APPLIED',reason:null,paidThrough:retried.access.paidThrough,accessUntil:retried.access.accessUntil});
    // Renewal extends; replay and a late earlier period change nothing; a gap after the window lapses goes to review.
    const pa3Event=pay(paB,P(2)),pa3=await ingest(pa3Event);
    assert.deepEqual([pa3.outcome,pa3.qualifyingPaidPeriodCount,pa3.access],['APPLIED',3,{accessActivation:'EXTENDED',accessGranted:true}]);
    assert.deepEqual(await ingest(pa3Event),pa3);
    assert.equal((await ent(paOrg)).effective_until.getTime(),P(2)[1]+GRACE);assert.equal((await st(paOrg)).paid_through.getTime(),P(2)[1]);
    const early=await ingest(pay(paB,P(-1)));
    assert.deepEqual([early.outcome,early.access],['APPLIED',{accessActivation:'NOT_ATTEMPTED',accessGranted:false,reason:'ALREADY_COVERED'}]);
    const gapStart=P(3)[0]+GRACE+DAY,gap=await ingest(pay(paB,[gapStart,addMonths(gapStart,1)]));
    assert.deepEqual([gap.outcome,gap.access],['APPLIED',{accessActivation:'NEEDS_REVIEW',accessGranted:false,reason:'PAID_PERIOD_GAP'}]);
    assert.equal((await ent(paOrg)).effective_until.getTime(),P(2)[1]+GRACE,'neither a late period nor a gap moves the window');
    assert.equal((await row("SELECT count(*)::int n FROM hon.saas_access_transitions WHERE binding_id=$1 AND outcome='APPLIED'",[paB.bindingId])).n,3,'one applied transition per paid period');
    // Access windows only move forward, and the schedule source cannot be rewritten, even by the owner.
    for(const q of ["UPDATE hon.saas_access_states SET paid_through=paid_through-interval '1 day',version=version+1 WHERE organization_id=$1",
      "UPDATE hon.saas_access_states SET binding_id=NULL,version=version+1 WHERE organization_id=$1",
      "UPDATE hon.saas_access_states SET state='AWAITING_FIRST_PAYMENT',reason='AWAITING_INITIAL_PAYMENT',version=version+1 WHERE organization_id=$1",
      "DELETE FROM hon.saas_access_states WHERE organization_id=$1"]){await admin.query('BEGIN');await sqlDeny(admin.query(q,[paOrg]),'42501');await admin.query('ROLLBACK');}

    // Program active: the first payment activates directly, once, even under concurrent duplicate delivery.
    const pb1=pay(pbB,P(0)),pb1Digest=await digest(pb1);
    const pbReceipts=await Promise.all([schedules.ingestVerifiedTestEvidence(pb1,pb1Digest),schedules.ingestVerifiedTestEvidence(pb1,pb1Digest)]);
    assert.deepEqual(pbReceipts[0],pbReceipts[1]);assert.deepEqual([pbReceipts[0].billingStatus,pbReceipts[0].access],['ACTIVE',{accessActivation:'APPLIED',accessGranted:true}]);
    assert.deepEqual(await transitions(pbB.bindingId),['SCHEDULE_FIRST_PAYMENT_ACTIVATION:APPLIED:FIRST_PAYMENT_VERIFIED']);
    assert.equal(await inEffect(pbOrg),true);assert.equal((await ent(pbOrg)).effective_until.getTime(),P(0)[1]+GRACE);
    // Without a renewal, access lapses by time alone (no job): once the window is past, the entitlement is out of effect.
    await admin.query("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1",[pbOrg]);
    assert.equal(await inEffect(pbOrg),false);

    // An unexpected error inside activation rolls back to its own savepoint: payment kept, access unchanged, review recorded.
    const pcEntBefore=await ent(pcOrg);
    await admin.query("CREATE FUNCTION hon.b2_fixture_fail_entitlement() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'synthetic entitlement failure'; END $f$");
    await admin.query(`CREATE TRIGGER b2_fixture_fail BEFORE UPDATE ON hon.organization_entitlements FOR EACH ROW WHEN (OLD.organization_id='${pcOrg}') EXECUTE FUNCTION hon.b2_fixture_fail_entitlement()`);
    let pc1;
    try { pc1=await ingest(pay(pcB,P(0))); }
    finally { await admin.query('DROP TRIGGER b2_fixture_fail ON hon.organization_entitlements');await admin.query('DROP FUNCTION hon.b2_fixture_fail_entitlement()'); }
    assert.deepEqual([pc1.outcome,pc1.billingStatus,pc1.qualifyingPaidPeriodCount,pc1.access],['APPLIED','ACTIVE',1,{accessActivation:'NEEDS_REVIEW',accessGranted:false,reason:'ACCESS_ACTIVATION_ERROR'}]);
    assert.deepEqual(await ent(pcOrg),pcEntBefore);assert.equal((await st(pcOrg)).state,'AWAITING_FIRST_PAYMENT');
    const pcView=await schedules.readHq(H('hq'),pcB.bindingId);
    const pcRetried=await schedules.retryAccess(H('hq'),pcB.bindingId,{expectedBindingVersion:pcView.version},K());
    assert.deepEqual([pcRetried.access.accessActivation,pcRetried.access.accessGranted,await inEffect(pcOrg)],['APPLIED',true,true]);
  } finally { await setAccessProgram(false); }
  // Paid access switched off after activation: a renewal is kept as money but never extends the window; HQ reviews it.
  const pcUntil=(await ent(pcOrg)).effective_until.getTime(),pc2=await ingest(pay(pcB,P(1)));
  assert.deepEqual([pc2.outcome,pc2.qualifyingPaidPeriodCount,pc2.access],['APPLIED',2,{accessActivation:'NEEDS_REVIEW',accessGranted:false,reason:'ACCESS_PROGRAM_INACTIVE'}]);
  assert.equal((await ent(pcOrg)).effective_until.getTime(),pcUntil);
  assert.deepEqual(await row("SELECT status,mutations_enabled FROM hon.saas_access_program"),{status:'INACTIVE',mutations_enabled:false});
  assert.equal((await row("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='saas_access_program_status_check'")).definition,STATUS_CHECK);
  passed('0235 access: the first verified payment switches on COMPLETE access for the paid period plus the 7-day grace (program INACTIVE -> HQ review, payment kept); HQ-owner retry, renewal extension, no shortening, gap review, concurrent single activation, time lapse, and savepoint isolation');
  // ---------- 0237 piece 3: HQ review queue for held schedule money; refund obligation and verified refund ----------
  const queue=async(who='hq')=>{const items=[];let cursor=null;do{const page=await reviews.list(H(who),cursor);items.push(...page.items);cursor=page.nextCursor;}while(cursor);return items;};
  const itemOf=async id=>(await queue()).find(i=>i.subjectId===id);
  const owe=(id,version,decision='REFUND_OWED')=>({subjectKind:'SCHEDULE_BINDING',subjectId:id,expectedVersion:version,decision,reason:'Fixture held schedule payment owed back',confirmation:contracts.SAAS_PAID_REVIEW_RESOLVE_CONFIRMATION});
  const verifyBody=version=>({expectedVersion:version,confirmation:contracts.SAAS_PAID_REVIEW_VERIFY_CONFIRMATION});
  const conflictOf=async id=>(await row('SELECT hon.saas_org_billing_conflict($1) c',[id])).c;
  const refundOf=(b,ref,amountMinor)=>({...baseEvent(evt(),amountMinor,undefined,undefined,b),eventType:'charge.refunded',invoiceReference:null,relatedInvoiceReference:ref,coveredPeriod:null});
  const heldRef=async b=>(await row("SELECT normalized->>'invoiceReference' r FROM hon.saas_schedule_provider_events WHERE binding_id=$1 AND event_type='invoice.paid' AND outcome='NEEDS_REVIEW' ORDER BY received_at LIMIT 1",[b])).r;
  // Reads: HQ only; every item reports held money and whether HQ may record a refund, never inferring one.
  for(const who of ['school','staff','d9'])await deny(()=>reviews.list(H(who),null),403,'SAAS_FORBIDDEN');
  const all=await queue();
  assert.deepEqual(new Set(all.map(i=>i.subjectId)),new Set([binding.bindingId,raceStart.value.binding.bindingId,ivBinding.bindingId,d9Binding.bindingId,cancelBound.bindingId]),'every billing review is listed, access-only reviews are not');
  const mainItem=all.find(i=>i.subjectId===binding.bindingId),raceItem=all.find(i=>i.subjectId===raceStart.value.binding.bindingId);
  assert.deepEqual([mainItem.billingStatus,mainItem.heldItemCount,mainItem.heldAmountMinor,mainItem.blocker,mainItem.allowedDecisions],['NEEDS_REVIEW',2,2*price+1,'REVERSAL_POLICY_REQUIRED',[]],'a reversal of a counted payment waits for the refund/dispute policy');
  assert.deepEqual([raceItem.allowedDecisions,raceItem.blocker!==null],[[],true]);
  await deny(()=>reviews.resolve(H('hq'),owe(binding.bindingId,mainItem.subjectVersion),K()),422,'SAAS_REVIEW_NOT_RESOLVABLE');
  // Cursor paging is stable on (created_at, id) and never silently truncates.
  const firstCursor=(await row("SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')||'~'||id::text c FROM hon.saas_schedule_bindings WHERE id=$1",[all[0].subjectId])).c;
  assert.deepEqual((await reviews.list(H('hq'),firstCursor)).items.map(i=>i.subjectId),all.slice(1).map(i=>i.subjectId));
  assert.equal((await reviews.list(H('hq'),null)).nextCursor,null);
  // Late money on an ended sign-up (d9): obligation -> partial refund refused -> full refund verified -> hold cleared.
  const d9Item=all.find(i=>i.subjectId===d9Binding.bindingId);
  assert.deepEqual([d9Item.billingStatus,d9Item.reason,d9Item.heldAmountMinor,d9Item.blocker,d9Item.allowedDecisions],['EXPIRED_UNPAID','UNPAID_WINDOW_ELAPSED',price,null,['REFUND_OWED']]);
  for(const who of ['school','d9'])await deny(()=>reviews.resolve(H(who),owe(d9Binding.bindingId,d9Item.subjectVersion),K()),403,'SAAS_FORBIDDEN');
  await deny(()=>reviews.resolve(H('hq'),owe(d9Binding.bindingId,d9Item.subjectVersion,'RESUME_BILLING'),K()),422,'SAAS_BILLING_POLICY_UNAVAILABLE');
  const d9Owed=await reviews.resolve(H('hq'),owe(d9Binding.bindingId,d9Item.subjectVersion),K());
  assert.deepEqual([d9Owed.resolution.status,d9Owed.resolution.heldAmountMinor,d9Owed.resolution.providerActionExecuted],['AWAITING_REFUND_EVIDENCE',price,false]);
  await deny(()=>reviews.verifyRefund(H('hq'),d9Owed.resolution.resolutionId,verifyBody(1),K()),422,'SAAS_REFUND_EVIDENCE_MISSING');
  const d9Ref=await heldRef(d9Binding.bindingId);
  await ingest(refundOf(d9Binding,d9Ref,price-100));
  await deny(()=>reviews.verifyRefund(H('hq'),d9Owed.resolution.resolutionId,verifyBody(1),K()),422,'SAAS_REFUND_INCOMPLETE');
  assert.equal(await conflictOf(d9.organizationId),'PAID_NEEDS_REVIEW','stored refund evidence alone never clears a hold');
  await ingest(refundOf(d9Binding,d9Ref,price));
  // Two concurrent verifications with different keys: exactly one writes.
  const both=await Promise.allSettled([1,2].map(()=>reviews.verifyRefund(H('hq'),d9Owed.resolution.resolutionId,verifyBody(1),K())));
  assert.equal(both.filter(r=>r.status==='fulfilled').length,1);
  const d9Verified=both.find(r=>r.status==='fulfilled').value;
  assert.deepEqual([d9Verified.resolution.status,d9Verified.resolution.refundedAmountMinor,d9Verified.billingStatus,d9Verified.billingReviewOpen],['REFUND_VERIFIED',price,'EXPIRED_UNPAID',false]);
  assert.equal(await conflictOf(d9.organizationId),null);
  await admin.query('SELECT hon.saas_schedule_binding_available($1)',[d9.organizationId]);
  // A later payment on the same ended sign-up opens the review again.
  await ingest(baseEvent(evt(),price,'2031-03-01T00:00:00.000Z','2031-04-01T00:00:00.000Z',d9Binding));
  assert.equal(await conflictOf(d9.organizationId),'PAID_NEEDS_REVIEW');
  assert.equal((await itemOf(d9Binding.bindingId)).allowedDecisions[0],'REFUND_OWED','history kept, a new obligation may be recorded');
  // A parked plan that was billing carries on as before once the held payment is refunded (owner decision 2026-11-09).
  const pcBefore=await schedules.readHq(H('hq'),pcB.bindingId);
  const pcWrong=await ingest(baseEvent(evt(),price+5,iso(P(2)[0]),iso(P(2)[1]),pcB));
  assert.deepEqual([pcWrong.outcome,pcWrong.reason,pcWrong.billingStatus],['NEEDS_REVIEW','AMOUNT_MISMATCH','NEEDS_REVIEW']);
  const pcItem=await itemOf(pcB.bindingId),pcOwed=await reviews.resolve(H('hq'),owe(pcB.bindingId,pcItem.subjectVersion),K());
  await ingest(refundOf(pcB,await heldRef(pcB.bindingId),price+5));
  const pcVerified=await reviews.verifyRefund(H('hq'),pcOwed.resolution.resolutionId,verifyBody(1),K());
  const pcAfter=await schedules.readHq(H('hq'),pcB.bindingId);
  assert.deepEqual([pcVerified.billingStatus,pcAfter.status,pcAfter.statusReason,pcAfter.version,pcAfter.activatedAt,pcAfter.qualifyingPaidPeriodCount],
    ['ACTIVE','ACTIVE','REVIEW_REFUND_VERIFIED',pcBefore.version+2,pcBefore.activatedAt,2]);
  assert.equal((await row("SELECT count(*)::int n FROM hon.saas_audit WHERE entity_id=$1 AND action_code='saas.paid_review.verify_refund' AND next_state->>'status'='ACTIVE'",[pcB.bindingId])).n,1,'the return to billing is audited');
  const pcNext=await ingest(pay(pcB,P(2)));
  assert.deepEqual([pcNext.outcome,pcNext.billingStatus,pcNext.qualifyingPaidPeriodCount],['APPLIED','ACTIVE',3],'billing continues at the locked price');
  // A never-paid plan goes back to waiting for its first payment (the 7-day window still applies).
  const ivItem=await itemOf(ivBinding.bindingId),ivOwed=await reviews.resolve(H('hq'),owe(ivBinding.bindingId,ivItem.subjectVersion),K());
  await ingest(refundOf(ivBinding,await heldRef(ivBinding.bindingId),price));
  await reviews.verifyRefund(H('hq'),ivOwed.resolution.resolutionId,verifyBody(1),K());
  const ivAfter=await schedules.read(H('iv'),ivOrg.schoolId,ivBinding.bindingId);
  assert.deepEqual([ivAfter.status,ivAfter.statusReason,ivAfter.activatedAt],['BOUND_TEST_ONLY','REVIEW_REFUND_VERIFIED',null]);
  assert.deepEqual([(await ingest(baseEvent(evt(),price,'2031-06-01T00:00:00.000Z','2031-07-01T00:00:00.000Z',ivBinding))).billingStatus],['ACTIVE']);
  // Closed records: only the commands write; the owner cannot edit, delete or forge a review exit.
  for(const q of ['UPDATE hon.saas_paid_review_resolutions SET reason=reason','DELETE FROM hon.saas_paid_review_resolutions','TRUNCATE hon.saas_paid_review_resolutions']){
    await admin.query('BEGIN');await sqlDeny(admin.query(q),'42501');await admin.query('ROLLBACK');}
  await admin.query('BEGIN');
  await sqlDeny(admin.query("UPDATE hon.saas_schedule_bindings SET status='ACTIVE',status_reason='REVIEW_REFUND_VERIFIED',version=version+1 WHERE id=$1",[binding.bindingId]),'42501');
  await admin.query('ROLLBACK');
  for(const q of ['SELECT * FROM hon.saas_paid_review_resolutions',"SELECT hon.saas_paid_review_open('SCHEDULE_BINDING',gen_random_uuid())"])await sqlDeny(restricted.query(q),'42501');
  await admin.query('BEGIN READ ONLY');assert.equal(await conflictOf(org.id),'PAID_NEEDS_REVIEW');await admin.query('COMMIT');
  passed('0237 HQ review queue: every held schedule payment listed for HQ with its blocker; HQ-owner refund obligation (no provider action), partial refund refused, verified full refund clears the hold, concurrent single verification, a parked billing plan carries on and a never-paid plan goes back to waiting; later money reopens; records closed');
  for(const q of ['SELECT * FROM hon.saas_schedule_bindings','UPDATE hon.saas_schedule_bindings SET id=id','DELETE FROM hon.saas_schedule_provider_events','INSERT INTO hon.saas_schedule_paid_periods SELECT * FROM hon.saas_schedule_paid_periods LIMIT 1'])await sqlDeny(restricted.query(q),'42501');
  await verifySaasBillingSecurity(admin,'hon_champions_runtime');
  passed('forced RLS/private tables/functions and immutable evidence remain enforced for the restricted runtime');
  console.log(`PASS: HON OS schedule billing (0230 + 0235 + 0237) ${groups} scenario groups; deterministic fake only; no Stripe network, charge, invoice issuance, checkout, trial, credits, or deployment; access is switched on only inside the disposable fixture with the program briefly ACTIVE.`);
} finally {
  await Promise.allSettled([admin.query('ROLLBACK'),restricted.query('ROLLBACK')]);
  try { if(shippedHook)await admin.query(shippedHook); await setAccessProgram(false); await cleanup(); }
  finally { await Promise.allSettled([admin.end(),restricted.end()]); }
}
