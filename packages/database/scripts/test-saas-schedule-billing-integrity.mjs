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
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {HqOnboardingService}=await import('../../../apps/api/dist/hq/hq-onboarding.service.js');
const apiRequire=createRequire(new URL('../../../apps/api/package.json',import.meta.url));
const contracts=apiRequire('@hon/contracts');
const {DeterministicScheduleProvider}=apiRequire('./test/fixtures/subscription-schedule-provider.cjs');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),pricing=new SaasPriceAcceptanceService(billing),generations=new SaasSubscriptionGenerationService(billing),access=new SaasSchoolBillingService(billing),onboarding=new HqOnboardingService(database);
const provider=new DeterministicScheduleProvider(),schedules=new SaasScheduleBillingService(billing,provider),payments=new SaasPaymentsService(billing,database,{});
const client=u=>new pg.Client({connectionString:u.toString(),ssl:false}),admin=client(owner),restricted=client(runtime);
const humans=Object.fromEntries(['hq','school','other','staff','ai','d7','d9','race'].map(k=>[k,{id:K(),user:K(),subject:'b2-'+K()}]));
const H=k=>humans[k].subject,org={id:K(),school:K(),second:K(),role:K()},foreign={id:K(),school:K(),role:K()};
const tables=['saas_schedule_reconciliations','saas_schedule_paid_periods','saas_schedule_provider_events','saas_schedule_bindings','saas_access_transitions','saas_access_states','saas_subscription_generations','saas_price_acceptances','saas_price_schedules'];
const row=async(q,p)=>(await admin.query(q,p)).rows[0];let groups=0;const passed=s=>console.log('PASS B2 '+(++groups)+': '+s);
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
    d9=await onboarding.provisionInitialSchool({externalSubject:H('hq')},{legalName:'B2 D9 Fixture LLC',displayName:'B2 D9 Fixture',schoolName:'B2 D9 Main',schoolSlug:'b2-d9-'+K().slice(0,8),timezone:'UTC',initialTier:'COMPLETE',idempotencyKey:K()});
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
  assert.equal(binding.provider,'STRIPE_SIMULATED');assert.equal(binding.mode,'TEST');assert.equal(binding.status,'BOUND_TEST_ONLY');assert.equal(binding.billingEnabled,false);assert.equal(binding.checkoutAvailable,false);assert.equal(binding.accessGranted,false);assert.equal(binding.paidAccessProgram,'INACTIVE');
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
    assert.deepEqual([receipt.binding.organizationId,receipt.binding.schoolId,receipt.binding.status,receipt.binding.checkoutAvailable,receipt.binding.billingEnabled,receipt.binding.accessGranted,receipt.binding.paidAccessProgram],
      [fixture.organizationId,fixture.schoolId,'BOUND_TEST_ONLY',false,false,false,'INACTIVE'],label);
    assert.deepEqual(await row('SELECT tier::text,status::text FROM hon.organization_entitlements WHERE organization_id=$1',[fixture.organizationId]),{tier:'COMPLETE',status:'SUSPENDED'},label+' leaves entitlement suspended');
    assert.deepEqual(await row('SELECT state,reason FROM hon.saas_access_states WHERE organization_id=$1',[fixture.organizationId]),{state:'AWAITING_FIRST_PAYMENT',reason:'AWAITING_INITIAL_PAYMENT'},label+' leaves access awaiting');
  }
  const d7Replay=await schedules.start(H('d7'),d7.schoolId,d7Input,d7Key);
  assert.equal(d7Replay.replayed,true);assert.deepEqual(d7Replay.binding,d7Receipt.binding);assert.equal(provider.calls,3,'bound replay never recontacts the adapter');
  await deny(()=>schedules.start(H('d7'),d7.schoolId,d7Input,K()),409,'SAAS_SCHEDULE_BINDING_EXISTS');
  await deny(()=>schedules.start(H('d7'),d7.schoolId,d9Input,K()),404,'SAAS_UNAVAILABLE');
  assert.equal(provider.calls,3,'duplicate and cross-organization requests do not contact the adapter');
  await deny(()=>schedules.start(H('school'),org.second,input,K()),403,'SAAS_FORBIDDEN');await deny(()=>schedules.read(H('other'),foreign.school,binding.bindingId),404,'SAAS_UNAVAILABLE');
  assert.deepEqual(await schedules.read(H('staff'),org.school,binding.bindingId),binding);assert.deepEqual(await schedules.readHq(H('hq'),binding.bindingId),binding);

  // The reverse D9 writer and B2 use the same organization key. A waiting state may win and B2 then succeeds;
  // a B2 intent may win and the later D9 write is an explicit no-effect lifecycle conflict. No race activates access.
  const race=await onboarding.provisionInitialSchool({externalSubject:H('hq')},{legalName:'B2 Race Fixture LLC',displayName:'B2 Race Fixture',schoolName:'B2 Race Main',schoolSlug:'b2-race-'+K().slice(0,8),timezone:'UTC',initialTier:'COMPLETE',idempotencyKey:K()});
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
  assert.deepEqual([raceStart.value.binding.organizationId,raceStart.value.binding.schoolId,raceStart.value.binding.checkoutAvailable,raceStart.value.binding.billingEnabled,raceStart.value.binding.accessGranted,raceStart.value.binding.paidAccessProgram],
    [race.organizationId,race.schoolId,false,false,false,'INACTIVE']);
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
  const baseEvent=(eventId,amountMinor=24900,startsAt='2031-01-01T00:00:00.000Z',endsAt='2031-02-01T00:00:00.000Z')=>({provider:'STRIPE_SIMULATED',mode:'TEST',eventId,eventType:'invoice.paid',bindingId:binding.bindingId,
    accountReference:binding.providerAccountReference,subscriptionReference:binding.providerSubscriptionReference,scheduleReference:binding.providerScheduleReference,
    invoiceReference:'fake_invoice_'+eventId.slice(4),relatedInvoiceReference:null,coveredPeriod:{startsAt,endsAt},amountMinor,currency:'USD',occurredAt:new Date().toISOString()});
  const invalidOccurredAt=baseEvent('evt_'+K().replaceAll('-','_'));invalidOccurredAt.occurredAt='2031-02-30T00:00:00.000Z';
  const invalidOccurredAtDigest=await digest(invalidOccurredAt);
  await deny(()=>schedules.ingestVerifiedTestEvidence(invalidOccurredAt,invalidOccurredAtDigest),400,'INVALID_SAAS_INPUT');
  const futureOccurredAt=baseEvent('evt_'+K().replaceAll('-','_'));futureOccurredAt.occurredAt=new Date(Date.now()+600_000).toISOString();
  const futureOccurredAtDigest=await digest(futureOccurredAt);
  await deny(()=>schedules.ingestVerifiedTestEvidence(futureOccurredAt,futureOccurredAtDigest),400,'INVALID_SAAS_INPUT');
  const paid=baseEvent('evt_'+K().replaceAll('-','_')),paidReceipt=await schedules.ingestVerifiedTestEvidence(paid,await digest(paid));
  assert.equal(paidReceipt.outcome,'APPLIED');assert.equal(paidReceipt.qualifyingPaidPeriodCount,1);assert.equal(paidReceipt.accessGranted,false);
  const storedPaidEvent=await row('SELECT provider_occurred_at,received_at,outcome FROM hon.saas_schedule_provider_events WHERE provider_event_id=$1',[paid.eventId]);
  assert.equal(storedPaidEvent.provider_occurred_at.toISOString(),paid.occurredAt);assert(storedPaidEvent.received_at instanceof Date);assert.equal(storedPaidEvent.outcome,'APPLIED');
  assert.deepEqual(await schedules.ingestVerifiedTestEvidence(paid,await digest(paid)),paidReceipt,'same event replays immutable original evidence');
  const conflicting={...paid,amountMinor:24899},conflictingDigest=await digest(conflicting);
  await deny(()=>schedules.ingestVerifiedTestEvidence(conflicting,conflictingDigest),409,'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_provider_events WHERE provider_event_id=$1',[paid.eventId])).n,1,'conflicting digest must not replace immutable event evidence');
  const concurrent=baseEvent('evt_'+K().replaceAll('-','_'),24900,'2031-02-01T00:00:00.000Z','2031-03-01T00:00:00.000Z');
  const concurrentDigest=await digest(concurrent),concurrentReceipts=await Promise.all([schedules.ingestVerifiedTestEvidence(concurrent,concurrentDigest),schedules.ingestVerifiedTestEvidence(concurrent,concurrentDigest)]);
  assert.deepEqual(concurrentReceipts[0],concurrentReceipts[1]);assert.equal(concurrentReceipts[0].outcome,'APPLIED');assert.equal(concurrentReceipts[0].qualifyingPaidPeriodCount,2);
  const duplicate=baseEvent('evt_'+K().replaceAll('-','_'));duplicate.invoiceReference=paid.invoiceReference;duplicate.coveredPeriod={startsAt:'2031-02-01T00:00:00.000Z',endsAt:'2031-03-01T00:00:00.000Z'};
  const duplicateReceipt=await schedules.ingestVerifiedTestEvidence(duplicate,await digest(duplicate));assert.equal(duplicateReceipt.outcome,'ALREADY_APPLIED');assert.equal(duplicateReceipt.qualifyingPaidPeriodCount,2);
  const outOfOrder=baseEvent('evt_'+K().replaceAll('-','_'),24900,'2030-12-01T00:00:00.000Z','2031-01-01T00:00:00.000Z');
  const outOfOrderReceipt=await schedules.ingestVerifiedTestEvidence(outOfOrder,await digest(outOfOrder));assert.equal(outOfOrderReceipt.outcome,'NEEDS_REVIEW');assert.equal(outOfOrderReceipt.reason,'OUT_OF_ORDER_COVERED_PERIOD');assert.equal(outOfOrderReceipt.qualifyingPaidPeriodCount,2);
  const wrong=baseEvent('evt_'+K().replaceAll('-','_'),1,'2031-02-01T00:00:00.000Z','2031-03-01T00:00:00.000Z');wrong.invoiceReference='fake_invoice_wrong';
  assert.equal((await schedules.ingestVerifiedTestEvidence(wrong,await digest(wrong))).outcome,'NEEDS_REVIEW');
  const failed={...baseEvent('evt_'+K().replaceAll('-','_')),eventType:'invoice.payment_failed'},failedReceipt=await schedules.ingestVerifiedTestEvidence(failed,await digest(failed));assert.equal(failedReceipt.outcome,'NEEDS_REVIEW');assert.equal(failedReceipt.reason,'PAYMENT_NOT_VERIFIED');
  const reverse={...baseEvent('evt_'+K().replaceAll('-','_')),eventType:'charge.refunded',invoiceReference:null,relatedInvoiceReference:paid.invoiceReference,coveredPeriod:null};
  const reversal=await schedules.ingestVerifiedTestEvidence(reverse,await digest(reverse));assert.equal(reversal.outcome,'NEEDS_REVIEW');
  const dispute={...baseEvent('evt_'+K().replaceAll('-','_')),eventType:'charge.dispute.created',invoiceReference:null,relatedInvoiceReference:paid.invoiceReference,coveredPeriod:null};
  assert.equal((await schedules.ingestVerifiedTestEvidence(dispute,await digest(dispute))).outcome,'NEEDS_REVIEW');
  const eventsBeforeUnsupported=(await row('SELECT count(*)::int n FROM hon.saas_schedule_provider_events')).n,unsupported={...baseEvent('evt_'+K().replaceAll('-','_')),eventType:'invoice.payment_pending'},unsupportedDigest=await digest(unsupported);
  await deny(()=>schedules.ingestVerifiedTestEvidence(unsupported,unsupportedDigest),400,'INVALID_SAAS_INPUT');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_schedule_provider_events')).n,eventsBeforeUnsupported,'unsupported event must have no ledger effect');
  const after=await schedules.read(H('school'),org.school,binding.bindingId);assert.equal(after.qualifyingPaidPeriodCount,2);assert.equal(after.unresolvedReconciliation,true);
  assert.equal((await row('SELECT status FROM hon.saas_access_program')).status,'INACTIVE');assert.equal((await row("SELECT count(*)::int n FROM hon.saas_access_transitions WHERE kind='FIRST_PAYMENT_ACTIVATION'")).n,0);
  passed('valid provider evidence reaches the immutable ledger; replay, concurrent duplicate, digest conflict, out-of-order, unsupported, failed, refund, and dispute facts remain idempotent or fail closed with paid access inactive');
  for(const q of ['SELECT * FROM hon.saas_schedule_bindings','UPDATE hon.saas_schedule_bindings SET id=id','DELETE FROM hon.saas_schedule_provider_events','INSERT INTO hon.saas_schedule_paid_periods SELECT * FROM hon.saas_schedule_paid_periods LIMIT 1'])await sqlDeny(restricted.query(q),'42501');
  await verifySaasBillingSecurity(admin,'hon_champions_runtime');
  passed('forced RLS/private tables/functions and immutable evidence remain enforced for the restricted runtime');
  console.log(`PASS: Commercial B2 ${groups} scenario groups; deterministic fake only; no Stripe network, charge, invoice issuance, checkout, entitlement, trial, credits, or deployment.`);
} finally {
  await Promise.allSettled([admin.query('ROLLBACK'),restricted.query('ROLLBACK')]);
  try { await setAccessProgram(false); await cleanup(); }
  finally { await Promise.allSettled([admin.end(),restricted.end()]); }
}
