import pg from 'pg';
import { setLegacySales } from './saas-legacy-sales-simulation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// HON paid access B6A (0172) integrity proof: the central access authority and the first-payment activation
// pathway, TEST MODE, SIMULATED PROVIDER, disposable database only. The paid-access program ships INACTIVE
// (CHECK status = 'INACTIVE'); to exercise the transition this proof simulates ACTIVE inside the disposable
// database only (it drops that CHECK, flips the row, and restores both before it ends) and asserts the
// shipped state is back. Real API services, the real Stripe test-mode adapter and a deterministic simulator
// run end to end: awaiting first payment -> Core or Complete chosen by the school -> signed webhook ->
// entitlement, access state, allowance and evidence in one transaction; plus duplicates, replays, out-of-order
// events, wrong-school and founder-price tampering, expired and refunded payments, simultaneous purchases,
// recoverable HQ review states and existing provisioned schools left exactly as they were.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const {StripeTestModeAdapter}=await import('../../../apps/api/dist/payments/stripe-test-mode-adapter.js');
const {StripeSimulator}=await import('../../../apps/api/dist/payments/stripe-simulator.js');
const contracts=await import('@hon/contracts');
const SECRET='whsec_disposableFixtureSecret0123456789',KEY='sk_test_disposableFixtureKey0123456789';
const sim=new StripeSimulator(SECRET);
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),access=new SaasSchoolBillingService(billing);
const payments=new SaasPaymentsService(billing,database,new StripeTestModeAdapter({secretKey:KEY,webhookSecret:SECRET,provider:'STRIPE_SIMULATED',transport:sim.transport}));
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const saasTables=['saas_access_transitions','saas_access_states','saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions',
 'saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions',
 'saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions'];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code='42501')=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
// Awaiting-payment fixture organizations: A (buys Complete founder monthly), B (Core founder lifetime), C (forced activation failure),
// D (held while the program is inactive, then retried), E (refunded before retry), F (failed activation, then refunded), G (expired checkout paid late), M (amount tampering),
// S1/S2 (simultaneous purchases), Q (never pays). P1/P2 are existing provisioned schools (Core, Complete) that must stay untouched.
const keys=['A','B','C','D','E','F','G','M','S1','S2','Q','P1','P2'];
const O=Object.fromEntries(keys.map(k=>[k,{id:randomUUID(),tier:k==='P2'?'COMPLETE':'CORE',school:randomUUID(),role:randomUUID()}]));
const humans=Object.fromEntries(['owner','operator','support',...keys.map(k=>`owner${k}`)].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`b6a-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
const fixtureOrgs=()=>Object.values(O).map(o=>o.id);
let createdProvider=false,programTouched=false;
const STATUS_CHECK="CHECK ((status = 'INACTIVE'::text))";
async function setAccessProgram(active){
 programTouched=true;
 await admin.query('BEGIN');
 try{
  await admin.query('ALTER TABLE hon.saas_access_program DISABLE TRIGGER USER');
  if(active){await admin.query('ALTER TABLE hon.saas_access_program DROP CONSTRAINT IF EXISTS saas_access_program_status_check');await admin.query("UPDATE hon.saas_access_program SET status='ACTIVE'");}
  else{await admin.query("UPDATE hon.saas_access_program SET status='INACTIVE'");
   if(!(await admin.query("SELECT 1 FROM pg_constraint WHERE conname='saas_access_program_status_check' AND conrelid='hon.saas_access_program'::regclass")).rowCount)
    await admin.query("ALTER TABLE hon.saas_access_program ADD CONSTRAINT saas_access_program_status_check CHECK (status = 'INACTIVE')");}
  await admin.query('ALTER TABLE hon.saas_access_program ENABLE TRIGGER USER');
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
async function untouched(){const out={};for(const t of ['organization_entitlements','billing_accounts','memberships','invoices','payment_attempts','champions_reward_entries'])
 out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t WHERE ${t==='organization_entitlements'?'NOT (organization_id=ANY($1::uuid[]))':'true OR $1::uuid[] IS NULL'} ORDER BY 1`,[fixtureOrgs()])).rows.map(r=>r.r);return out;}
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  const all=[...saasTables,'saas_credit_program','saas_reward_fulfillment','saas_payment_program'];
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of saasTables)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query("UPDATE hon.saas_credit_program SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query("UPDATE hon.saas_reward_fulfillment SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query("UPDATE hon.saas_payment_program SET status='DISABLED',provider=NULL,test_tax_reference=NULL,authorization_reference=NULL,version=1,changed_by_principal_id=NULL");
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('DELETE FROM hon.ai_usage_ledger WHERE organization_id=ANY($1::uuid[])',[fixtureOrgs()]);
  if(createdProvider)await admin.query("DELETE FROM hon.hq_ai_provider_connections WHERE provider_id='HIGGSFIELD'");
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[fixtureOrgs()]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[fixtureOrgs()]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const deliver=d=>payments.handleWebhook(d.raw,d.signature);
const outcome=async d=>{const r=await deliver(d);return [r.event.outcome,r.event.detail];};
const options=(who,school)=>payments.readPlanOptions(H(who),school);
const start=(who,school,offerId,key=K())=>payments.startSchoolCheckout(H(who),school,{offerId},key);
const offer=(opts,plan,kind)=>opts.offers.find(o=>o.planCode===plan&&o.offerKind===kind).offerId;
const ent=async org=>(await admin.query("SELECT tier::text,status::text,version FROM hon.organization_entitlements WHERE organization_id=$1",[org])).rows[0];
const readAccess=org=>access.readOrganizationAccess(H('operator'),org);
const transitions=async org=>(await admin.query("SELECT kind,outcome,reason FROM hon.saas_access_transitions WHERE organization_id=$1 ORDER BY occurred_at,id",[org])).rows.map(r=>`${r.kind}:${r.outcome}:${r.reason}`);
const checkoutRow=async id=>(await admin.query("SELECT status,status_reason,version FROM hon.saas_checkout_sessions WHERE id=$1",[id])).rows[0];
const allowances=async org=>(await admin.query("SELECT a.allowance_credits,a.period_index FROM hon.saas_credit_allowances a JOIN hon.saas_subscriptions s ON s.id=a.subscription_id WHERE s.organization_id=$1",[org])).rows;
const capable=async(org,cap)=>(await admin.query('SELECT hon.saas_capability_allowed($1,$2) a',[org,cap])).rows[0].a;
// A deferred (NOT_READY) provider event must leave no claim, audit/outbox or provider-event row behind.
async function eventWrites(id){return (await admin.query(`WITH k AS (SELECT md5('saas.provider.event:STRIPE_SIMULATED:'||$1)::uuid id)
 SELECT (SELECT count(*)::int FROM hon.saas_requests,k WHERE idempotency_key=k.id) requests,
 (SELECT count(*)::int FROM hon.saas_audit,k WHERE idempotency_key=k.id) audit,
 (SELECT count(*)::int FROM hon.saas_outbox o JOIN hon.saas_audit a ON a.id=o.audit_id,k WHERE a.idempotency_key=k.id) outbox,
 (SELECT count(*)::int FROM hon.saas_provider_events WHERE provider='STRIPE_SIMULATED' AND provider_event_id=$1) events`,[id])).rows[0];}
const placeAwaiting=async(k,who='owner')=>access.awaitFirstPayment(H(who),O[k].id,{expectedEntitlementVersion:(await ent(O[k].id)).version},K());

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- runtime posture: private tables and internal transition functions ----------
 for(const t of ['saas_access_states','saas_access_transitions','saas_access_program'])await sqlDeny(restricted.query(`SELECT * FROM hon.${t}`));
 for(const sig of ['saas_apply_first_payment_access(uuid,uuid,uuid,jsonb,timestamptz)','saas_try_first_payment_access(uuid,uuid,uuid,jsonb,timestamptz)',
  'saas_activate_checkout_core(uuid,jsonb,timestamptz,boolean)','saas_organization_access(uuid)','saas_capability_allowed(uuid,text)','saas_awaiting_first_payment(uuid)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);
 await sqlDeny(restricted.query("INSERT INTO hon.saas_access_states(organization_id,state,reason,version,changed_by_principal_id,created_at,updated_at) VALUES(gen_random_uuid(),'PAYMENT_ACTIVE','FIRST_PAYMENT_VERIFIED',1,gen_random_uuid(),now(),now())"));
 // The program ships INACTIVE, pinned by CHECK and immutable.
 assert.deepEqual((await admin.query('SELECT status,mutations_enabled FROM hon.saas_access_program')).rows,[{status:'INACTIVE',mutations_enabled:false}]);
 assert.equal((await admin.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='saas_access_program_status_check'")).rows[0].d,STATUS_CHECK);
 await cleanup();
 // 0184 (D8) closed legacy new sales; this proof exercises them, so it reopens them in this disposable database only.
 await setLegacySales(admin,true);

 // ---------- fixture ----------
 await admin.query('BEGIN');
 if((await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state) VALUES('HIGGSFIELD','Fixture provider','DISABLED') ON CONFLICT DO NOTHING RETURNING provider_id")).rowCount)createdProvider=true;
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[who,hqRole,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['support','HON_HQ_SUPPORT',['hq.billing.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,hqRole,perms]);
 for(const[k,o]of Object.entries(O)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o.id,`B6A Fixture Dojo ${k}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,$2,clock_timestamp()-interval '90 days')",[o.id,o.tier]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'America/New_York')",[o.school,o.id,`School ${k}`]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[o.role,o.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[o.role,o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[o.id,o.school,humans[`owner${k}`].id,o.role]);
 }
 await admin.query('COMMIT');
 const d=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
 d.termsReference='Fixture HON plan terms (not customer terms)';
 d.founderProgram={...d.founderProgram,eligibility:'ANY_ACTIVE_ORGANIZATION',opensAt:iso(NOW-HOUR)};
 await billing.publishCatalog(H('owner'),(await billing.createCatalogDraft(H('owner'),d,K())).catalog.catalogId,K());
 await payments.setPaymentProgram(H('owner'),{action:'ENABLE_TEST_MODE',expectedVersion:1,authorizationReference:'Fixture owner test-mode authorization (disposable)',
  provider:'STRIPE_SIMULATED',testTaxReference:'TEST MODE: no tax collected; TAXES undecided (fixture)'},K());
 const ev=(await billing.recordCostEvidence(H('owner'),{providerId:'HIGGSFIELD',modelCode:'fixture-image-1',costUnit:'IMAGE',measuredUnits:1000,billedCostMicrounits:40_000_000,
  fullyLoadedCostMicrounits:50_000_000,evidenceReference:'FIXTURE-B6A-PROVIDER-1',periodStart:iso(NOW-40*DAY),periodEnd:iso(NOW-10*DAY),note:null},K())).costEvidence;
 const pd=(await billing.createPricingDraft(H('operator'),{termsReference:'Fixture premium pricing (not customer terms)',operations:[{operationCode:'image.generate',
  category:'IMAGE_GENERATION',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,requiredCapability:'ai.premium_metered',costEvidenceId:ev.costEvidenceId}]},K())).pricing;
 await billing.publishPricing(H('owner'),pd.pricingId,K());
 await billing.setCreditProgram(H('owner'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'Fixture owner authorization (disposable)'},K());
 const before=await untouched();
 const provisionedBefore={P1:await ent(O.P1.id),P2:await ent(O.P2.id)};

 // ---------- 1. INACTIVE (as shipped): the central authority reads, every B6A command is refused ----------
 let a=await readAccess(O.P1.id);
 assert.deepEqual([a.state,a.source,a.paidAccessProgram,a.entitlement.tier,a.transitions],['PROVISIONED','PROVISIONED','INACTIVE','CORE',[]]);
 assert.deepEqual(a.capabilities,[...contracts.SAAS_CORE_CAPABILITIES]);
 assert.deepEqual((await readAccess(O.P2.id)).capabilities,[...contracts.SAAS_CORE_CAPABILITIES,...contracts.SAAS_COMPLETE_ONLY_CAPABILITIES]);
 await deny(placeAwaiting('A'),422,'SAAS_ACCESS_NOT_ACTIVE');
 for(const who of ['operator','support','ownerA'])await deny(placeAwaiting('A',who),403,'SAAS_FORBIDDEN');
 for(const who of ['support','ownerA','ownerP1'])await deny(access.readOrganizationAccess(H(who),O.A.id),403,'SAAS_FORBIDDEN');
 await deny(access.readOrganizationAccess(H('operator'),randomUUID()),404,'SAAS_UNAVAILABLE');
 await deny(access.retryFirstPaymentActivation(H('owner'),randomUUID(),{expectedCheckoutVersion:1},K()),422,'SAAS_ACCESS_NOT_ACTIVE');
 for(const body of [{},{expectedEntitlementVersion:0},{expectedEntitlementVersion:'1'},{expectedEntitlementVersion:1,tier:'COMPLETE'},{expectedEntitlementVersion:1,organizationId:O.B.id}])
  await deny(access.awaitFirstPayment(H('owner'),O.A.id,body,K()),400,'INVALID_SAAS_INPUT');
 await deny(access.retryFirstPaymentActivation(H('owner'),randomUUID(),{expectedCheckoutVersion:1,amountMinor:100},K()),400,'INVALID_SAAS_INPUT');
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.saas_access_states')).rows[0].n,0);

 // ---------- 2. simulated ACTIVE (disposable only): HQ owner places organizations awaiting their first payment ----------
 await setAccessProgram(true);
 assert.equal((await readAccess(O.P1.id)).paidAccessProgram,'ACTIVE');
 await deny(placeAwaiting('A','operator'),403,'SAAS_FORBIDDEN'); // HQ owner only
 const stale=await access.awaitFirstPayment(H('owner'),O.A.id,{expectedEntitlementVersion:7},K()).catch(e=>e);http(409,'SAAS_VERSION_CONFLICT')(stale);
 const kA=K(),vA=(await ent(O.A.id)).version;
 const placedA=await access.awaitFirstPayment(H('owner'),O.A.id,{expectedEntitlementVersion:vA},kA);
 assert.deepEqual([placedA.replayed,placedA.access.state,placedA.access.source,placedA.access.entitlement.status,placedA.access.entitlement.inEffect,placedA.access.capabilities],
  [false,'AWAITING_FIRST_PAYMENT','NONE','SUSPENDED',false,[]]);
 assert.equal((await access.awaitFirstPayment(H('owner'),O.A.id,{expectedEntitlementVersion:vA},kA)).replayed,true);
 await deny(access.awaitFirstPayment(H('owner'),O.A.id,{expectedEntitlementVersion:vA+1},kA),409,'IDEMPOTENCY_KEY_REUSED');
 await deny(placeAwaiting('A'),422,'SAAS_ACCESS_STATE_EXISTS');
 for(const k of ['B','C','D','E','F','G','M','S1','S2','Q'])await placeAwaiting(k);
 assert.equal(await capable(O.A.id,'crm.families_students_prospects'),false,'no access before the first payment');
 // Billing recovery stays open while awaiting: billing reads, plan options and checkout.
 const accountA=await access.readAccount(H('ownerA'),O.A.school);
 assert.deepEqual([accountA.access.state,accountA.access.source,accountA.access.paymentActivated,accountA.access.paidAccessProgram,accountA.access.activation],
  ['AWAITING_FIRST_PAYMENT','PROVISIONED',false,'ACTIVE','UNAVAILABLE']);
 let optsA=await options('ownerA',O.A.school);
 assert.equal(optsA.entitlementTier,null);
 assert.deepEqual(optsA.offers.map(o=>[o.planCode,o.offerKind,o.priceMinor,o.monthlyPremiumCredits]),[['CORE','FOUNDER_MONTHLY',7900,5000],['COMPLETE','FOUNDER_MONTHLY',14900,12000],
  ['CORE','REGULAR_MONTHLY',14900,5000],['COMPLETE','REGULAR_MONTHLY',24900,12000],['CORE','FOUNDER_LIFETIME',189600,5000],['COMPLETE','FOUNDER_LIFETIME',357600,12000]]);
 // An existing provisioned school is unchanged: only its own tier, and access untouched.
 const optsP1=await options('ownerP1',O.P1.school);
 assert.equal(optsP1.entitlementTier,'CORE');
 await deny(start('ownerP1',O.P1.school,offer(optsA,'COMPLETE','REGULAR_MONTHLY')),422,'SAAS_ENTITLEMENT_MISMATCH');
 // A provisioned school with a subscription or open checkout cannot be placed awaiting.
 const coP1=await start('ownerP1',O.P1.school,offer(optsP1,'CORE','REGULAR_MONTHLY'));
 await deny(placeAwaiting('P1'),422,'SAAS_CHECKOUT_OPEN');
 assert.deepEqual(await outcome(sim.completeCheckout(coP1.checkout.providerSessionId).completed),['APPLIED','SUBSCRIPTION_ACTIVATED']);
 await deny(placeAwaiting('P1'),422,'SAAS_SUBSCRIPTION_EXISTS');
 assert.deepEqual(await ent(O.P1.id),provisionedBefore.P1,'a provisioned school paying for its plan keeps its entitlement exactly');
 assert.equal((await readAccess(O.P1.id)).source,'PROVISIONED');

 // ---------- 3. Complete founder monthly: the server determines tier, price and allowance ----------
 await deny(start('ownerB',O.A.school,offer(optsA,'COMPLETE','FOUNDER_MONTHLY')),403,'SAAS_FORBIDDEN'); // another school's owner
 await deny(payments.startSchoolCheckout(H('ownerA'),O.A.school,{offerId:offer(optsA,'COMPLETE','FOUNDER_MONTHLY'),priceMinor:100},K()),400,'INVALID_SAAS_INPUT');
 await deny(payments.startSchoolCheckout(H('ownerA'),O.A.school,{offerId:offer(optsA,'COMPLETE','FOUNDER_MONTHLY'),schoolId:O.B.school},K()),400,'INVALID_SAAS_INPUT');
 const coA=await start('ownerA',O.A.school,offer(optsA,'COMPLETE','FOUNDER_MONTHLY'));
 assert.deepEqual([coA.checkout.planCode,coA.checkout.offerKind,coA.checkout.amountMinor],['COMPLETE','FOUNDER_MONTHLY',14900]);
 const paidA=sim.completeCheckout(coA.checkout.providerSessionId);
 // Out of order: the first subscription invoice arrives before the checkout completion. Since 0173 it cannot be
 // finalized without its checkout mapping: it is refused for provider redelivery and leaves nothing behind.
 await deny(deliver(paidA.firstInvoice),503,'SAAS_PROVIDER_EVENT_RETRY');
 assert.deepEqual(await eventWrites(paidA.firstInvoice.event.id),{requests:0,audit:0,outbox:0,events:0});
 assert.equal((await ent(O.A.id)).status,'SUSPENDED','an invoice event alone never activates');
 assert.deepEqual(await transitions(O.A.id),['AWAITING_FIRST_PAYMENT:APPLIED:AWAITING_INITIAL_PAYMENT']);
 // The same completion delivered six times concurrently activates exactly once.
 await Promise.all(Array.from({length:8},()=>readAccess(O.Q.id)));
 const racedA=await Promise.allSettled(Array.from({length:6},()=>deliver(paidA.completed)));
 const okA=racedA.filter(r=>r.status==='fulfilled').map(r=>r.value);
 assert.ok(okA.length>=1,JSON.stringify(racedA.map(r=>r.reason?.getResponse?.())));
 // A delivery racing the first one is told to retry (the provider redelivers); it never applies twice.
 for(const r of racedA.filter(r=>r.status==='rejected'))http(503,'SAAS_PROVIDER_EVENT_RETRY')(r.reason);
 const firstA=okA.find(r=>!r.replayed);
 assert.deepEqual([firstA.event.outcome,firstA.event.detail,firstA.event.organizationId],['APPLIED','ACCESS_ACTIVATED',O.A.id]);
 assert.equal((await deliver(paidA.completed)).replayed,true);
 // The redelivered early invoice now attributes to A's checkout and subscription and changes nothing else.
 const invA=await deliver(paidA.firstInvoice);
 assert.deepEqual([invA.replayed,invA.event.outcome,invA.event.detail,invA.event.organizationId,invA.event.checkoutId,invA.event.subscriptionId],
  [false,'ALREADY_APPLIED','FIRST_INVOICE_COVERED_BY_CHECKOUT',O.A.id,coA.checkout.checkoutId,firstA.event.subscriptionId]);
 assert.deepEqual(await eventWrites(paidA.firstInvoice.event.id),{requests:1,audit:1,outbox:1,events:1});
 assert.equal((await deliver(paidA.firstInvoice)).replayed,true);
 const entA=await ent(O.A.id);
 assert.deepEqual([entA.tier,entA.status,entA.version],['COMPLETE','ACTIVE',vA+2]);
 a=await readAccess(O.A.id);
 assert.deepEqual([a.state,a.source,a.entitlement.inEffect,a.transitions.map(t=>`${t.kind}:${t.outcome}:${t.reason}`)],
  ['PAYMENT_ACTIVE','PAYMENT_ACTIVATED',true,['AWAITING_FIRST_PAYMENT:APPLIED:AWAITING_INITIAL_PAYMENT','FIRST_PAYMENT_ACTIVATION:APPLIED:FIRST_PAYMENT_VERIFIED']]);
 const actA=a.transitions[1];
 assert.deepEqual([actA.checkoutId,actA.priorEntitlement.status,actA.nextEntitlement.tier,actA.providerEventId],[coA.checkout.checkoutId,'SUSPENDED','COMPLETE',paidA.completed.event.id]);
 assert.ok(actA.allowanceId&&actA.subscriptionId);
 assert.deepEqual(await allowances(O.A.id),[{allowance_credits:12000,period_index:0}],'the full Complete allowance, once');
 for(const cap of contracts.SAAS_COMPLETE_ONLY_CAPABILITIES)assert.equal(await capable(O.A.id,cap),true,cap);
 const accountA2=await access.readAccount(H('ownerA'),O.A.school);
 assert.deepEqual([accountA2.access.state,accountA2.access.source,accountA2.access.paymentActivated,accountA2.access.activation,accountA2.allowance.state,accountA2.allowance.grantedCredits],
  ['PAYMENT_ACTIVE','PAYMENT_ACTIVATED',true,'READY','AVAILABLE',12000]);
 assert.equal((await options('ownerA',O.A.school)).entitlementTier,'COMPLETE','after activation the B5 plan rule applies again');
 await deny(placeAwaiting('A'),422,'SAAS_ACCESS_STATE_EXISTS');
 await sqlDeny(admin.query("UPDATE hon.saas_access_states SET state='AWAITING_FIRST_PAYMENT',reason='AWAITING_INITIAL_PAYMENT',checkout_id=NULL,subscription_id=NULL,version=version+1 WHERE organization_id=$1",[O.A.id]));
 await sqlDeny(admin.query('DELETE FROM hon.saas_access_transitions WHERE organization_id=$1',[O.A.id]));
 await sqlDeny(admin.query('DELETE FROM hon.saas_access_states WHERE organization_id=$1',[O.A.id]));

 // ---------- 4. Core founder lifetime: Core features only, full monthly allowance ----------
 const optsB=await options('ownerB',O.B.school);
 const coB=await start('ownerB',O.B.school,offer(optsB,'CORE','FOUNDER_LIFETIME'));
 assert.equal(coB.checkout.amountMinor,189600);
 assert.deepEqual(await outcome(sim.completeCheckout(coB.checkout.providerSessionId).completed),['APPLIED','ACCESS_ACTIVATED']);
 assert.deepEqual([(await ent(O.B.id)).tier,(await ent(O.B.id)).status],['CORE','ACTIVE']);
 assert.deepEqual(await allowances(O.B.id),[{allowance_credits:5000,period_index:0}]);
 assert.equal(await capable(O.B.id,'crm.families_students_prospects'),true);
 for(const cap of contracts.SAAS_COMPLETE_ONLY_CAPABILITIES)assert.equal(await capable(O.B.id,cap),false,`Core lacks ${cap}`);

 // ---------- 5. tampered amount and expired checkout: recorded for HQ review, never a partial grant ----------
 const optsM=await options('ownerM',O.M.school);
 const coM=await start('ownerM',O.M.school,offer(optsM,'COMPLETE','FOUNDER_MONTHLY'));
 assert.deepEqual(await outcome(sim.completeCheckout(coM.checkout.providerSessionId,{amount:7900}).completed),['NEEDS_REVIEW','AMOUNT_MISMATCH']);
 assert.deepEqual([(await ent(O.M.id)).status,await transitions(O.M.id)],['SUSPENDED',['AWAITING_FIRST_PAYMENT:APPLIED:AWAITING_INITIAL_PAYMENT','FIRST_PAYMENT_ACTIVATION:NEEDS_REVIEW:AMOUNT_MISMATCH']]);
 await deny(access.retryFirstPaymentActivation(H('owner'),coM.checkout.checkoutId,{expectedCheckoutVersion:(await checkoutRow(coM.checkout.checkoutId)).version},K()),422,'SAAS_ACCESS_NOT_RETRYABLE');
 const optsG=await options('ownerG',O.G.school);
 const coG=await start('ownerG',O.G.school,offer(optsG,'CORE','REGULAR_MONTHLY'));
 assert.deepEqual(await outcome(sim.expire(coG.checkout.providerSessionId)),['APPLIED','CHECKOUT_EXPIRED']);
 assert.deepEqual(await outcome(sim.completeCheckout(coG.checkout.providerSessionId).completed),['NEEDS_REVIEW','PAID_AFTER_CLOSE']);
 assert.deepEqual([(await ent(O.G.id)).status,(await transitions(O.G.id)).at(-1)],['SUSPENDED','FIRST_PAYMENT_ACTIVATION:NEEDS_REVIEW:PAID_AFTER_CLOSE']);
 await deny(access.retryFirstPaymentActivation(H('owner'),coG.checkout.checkoutId,{expectedCheckoutVersion:(await checkoutRow(coG.checkout.checkoutId)).version},K()),422,'SAAS_ACCESS_NOT_RETRYABLE');

 // ---------- 6. simultaneous purchases ----------
 const optsS=await options('ownerS1',O.S1.school);
 const sameOrg=await Promise.allSettled([start('ownerS1',O.S1.school,offer(optsS,'CORE','REGULAR_MONTHLY')),start('ownerS1',O.S1.school,offer(optsS,'COMPLETE','REGULAR_MONTHLY'))]);
 assert.equal(sameOrg.filter(r=>r.status==='fulfilled').length,1,'one open checkout per organization');
 for(const r of sameOrg.filter(r=>r.status==='rejected'))http(422,'SAAS_CHECKOUT_OPEN')(r.reason);
 const coS1=sameOrg.find(r=>r.status==='fulfilled').value;
 const coS2=await start('ownerS2',O.S2.school,offer(optsS,'COMPLETE','REGULAR_MONTHLY'));
 const both=await Promise.all([deliver(sim.completeCheckout(coS1.checkout.providerSessionId).completed),deliver(sim.completeCheckout(coS2.checkout.providerSessionId).completed)]);
 assert.deepEqual(both.map(r=>[r.event.detail,r.event.organizationId]),[['ACCESS_ACTIVATED',O.S1.id],['ACCESS_ACTIVATED',O.S2.id]]);
 assert.equal((await ent(O.S1.id)).tier,coS1.checkout.planCode);
 assert.equal((await ent(O.S2.id)).tier,'COMPLETE');
 assert.equal((await ent(O.Q.id)).status,'SUSPENDED','an unrelated awaiting organization is never activated by another payment');

 // ---------- 7. forced activation failure -> recorded HQ review -> retry (completed checkout) ----------
 const allowanceDef=(await admin.query("SELECT pg_get_functiondef('hon.saas_current_allowance(uuid,uuid,timestamptz)'::regprocedure) d")).rows[0].d;
 const optsC=await options('ownerC',O.C.school);
 const coC=await start('ownerC',O.C.school,offer(optsC,'COMPLETE','REGULAR_MONTHLY'));
 await admin.query(`CREATE OR REPLACE FUNCTION hon.saas_current_allowance(p_subscription uuid, p_actor uuid, p_at timestamptz) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $f$ BEGIN RAISE EXCEPTION 'FIXTURE_FORCED_FAILURE'; END $f$`);
 const optsF=await options('ownerF',O.F.school);
 const coF=await start('ownerF',O.F.school,offer(optsF,'COMPLETE','REGULAR_MONTHLY'));
 let failedC,failedF;const paidF=sim.completeCheckout(coF.checkout.providerSessionId);
 try{failedC=await deliver(sim.completeCheckout(coC.checkout.providerSessionId).completed);failedF=await deliver(paidF.completed);}finally{await admin.query(allowanceDef);}
 assert.equal(failedF.event.detail,'ACCESS_ACTIVATION_NEEDS_REVIEW');
 assert.deepEqual([failedC.event.outcome,failedC.event.detail],['APPLIED','ACCESS_ACTIVATION_NEEDS_REVIEW'],'the payment is recorded; activation is not falsely reported');
 assert.deepEqual([(await ent(O.C.id)).status,(await checkoutRow(coC.checkout.checkoutId)).status,(await transitions(O.C.id)).at(-1),await allowances(O.C.id)],
  ['SUSPENDED','COMPLETED','FIRST_PAYMENT_ACTIVATION:NEEDS_REVIEW:ACTIVATION_FAILED',[]],'no partial grant');
 a=await readAccess(O.C.id);
 assert.deepEqual([a.state,a.source],['AWAITING_FIRST_PAYMENT','NONE']);
 const vC=(await checkoutRow(coC.checkout.checkoutId)).version;
 for(const who of ['operator','support','ownerC'])await deny(access.retryFirstPaymentActivation(H(who),coC.checkout.checkoutId,{expectedCheckoutVersion:vC},K()),403,'SAAS_FORBIDDEN');
 await deny(access.retryFirstPaymentActivation(H('owner'),coC.checkout.checkoutId,{expectedCheckoutVersion:vC+1},K()),409,'SAAS_VERSION_CONFLICT');
 const kC=K();
 const retryC=await access.retryFirstPaymentActivation(H('owner'),coC.checkout.checkoutId,{expectedCheckoutVersion:vC},kC);
 assert.deepEqual([retryC.outcome,retryC.detail,retryC.access.state,retryC.access.entitlement.tier,retryC.replayed],['APPLIED','ACCESS_ACTIVATED','PAYMENT_ACTIVE','COMPLETE',false]);
 assert.equal((await access.retryFirstPaymentActivation(H('owner'),coC.checkout.checkoutId,{expectedCheckoutVersion:vC},kC)).replayed,true);
 await deny(access.retryFirstPaymentActivation(H('owner'),coC.checkout.checkoutId,{expectedCheckoutVersion:vC},K()),422,'SAAS_ACCESS_STATE_CHANGED');
 assert.deepEqual(await allowances(O.C.id),[{allowance_credits:12000,period_index:0}]);
 // F's payment is refunded (matched by its payment intent) before the retry: activation is re-validated against
 // provider-verified net payment and goes back to review instead of granting access.
 assert.deepEqual(await outcome(paidF.firstInvoice),['ALREADY_APPLIED','FIRST_INVOICE_COVERED_BY_CHECKOUT']);
 assert.equal((await deliver(sim.refund(paidF.paymentIntent,null,24900))).event.outcome,'APPLIED');
 const retryF=await access.retryFirstPaymentActivation(H('owner'),coF.checkout.checkoutId,{expectedCheckoutVersion:(await checkoutRow(coF.checkout.checkoutId)).version},K());
 assert.deepEqual([retryF.outcome,retryF.detail,retryF.access.state,(await ent(O.F.id)).status,(await transitions(O.F.id)).at(-1),await allowances(O.F.id)],
  ['NEEDS_REVIEW','SAAS_ACCESS_PAYMENT_UNVERIFIED','AWAITING_FIRST_PAYMENT','SUSPENDED','FIRST_PAYMENT_ACTIVATION:NEEDS_REVIEW:SAAS_ACCESS_PAYMENT_UNVERIFIED',[]]);
 // A replayed webhook never adds another allowance.
 assert.equal((await deliver(sim.sign(sim.events.find(e=>e.type==='checkout.session.completed'&&e.data.object.client_reference_id===coC.checkout.checkoutId)))).replayed,true);
 assert.deepEqual(await allowances(O.C.id),[{allowance_credits:12000,period_index:0}]);

 // ---------- 8. program inactive at payment time -> held -> HQ retry after the program is active again ----------
 const optsD=await options('ownerD',O.D.school),optsE=await options('ownerE',O.E.school);
 const coD=await start('ownerD',O.D.school,offer(optsD,'CORE','REGULAR_MONTHLY'));
 const coE=await start('ownerE',O.E.school,offer(optsE,'COMPLETE','FOUNDER_LIFETIME'));
 await setAccessProgram(false);
 assert.deepEqual(await outcome(sim.completeCheckout(coD.checkout.providerSessionId).completed),['NEEDS_REVIEW','ACCESS_PROGRAM_INACTIVE']);
 const paidE=sim.completeCheckout(coE.checkout.providerSessionId);
 assert.deepEqual(await outcome(paidE.completed),['NEEDS_REVIEW','ACCESS_PROGRAM_INACTIVE']);
 for(const k of ['D','E'])assert.deepEqual([(await ent(O[k].id)).status,(await transitions(O[k].id)).at(-1)],['SUSPENDED','FIRST_PAYMENT_ACTIVATION:NEEDS_REVIEW:ACCESS_PROGRAM_INACTIVE']);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_subscriptions WHERE organization_id=ANY($1::uuid[])",[[O.D.id,O.E.id]])).rows[0].n,0,'nothing recorded while inactive');
 // While inactive an awaiting school is an ordinary suspended entitlement: no new checkout.
 await deny(start('ownerQ',O.Q.school,offer(optsD,'CORE','REGULAR_MONTHLY')),422,'SAAS_ENTITLEMENT_NOT_ACTIVE');
 await deny(access.retryFirstPaymentActivation(H('owner'),coD.checkout.checkoutId,{expectedCheckoutVersion:(await checkoutRow(coD.checkout.checkoutId)).version},K()),422,'SAAS_ACCESS_NOT_ACTIVE');
 // E's payment is refunded before anyone retries it.
 assert.ok((await deliver(sim.refund(paidE.paymentIntent,null,357600))).event);
 await setAccessProgram(true);
 await deny(access.retryFirstPaymentActivation(H('owner'),coE.checkout.checkoutId,{expectedCheckoutVersion:(await checkoutRow(coE.checkout.checkoutId)).version},K()),422,'SAAS_ACCESS_PAYMENT_REVERSED');
 assert.equal((await ent(O.E.id)).status,'SUSPENDED');
 // Wrong-school attribution: a checkout can only ever activate its own organization.
 const retryD=await access.retryFirstPaymentActivation(H('owner'),coD.checkout.checkoutId,{expectedCheckoutVersion:(await checkoutRow(coD.checkout.checkoutId)).version},K());
 assert.deepEqual([retryD.outcome,retryD.detail,retryD.access.organizationId,retryD.access.entitlement.tier],['APPLIED','ACCESS_ACTIVATED',O.D.id,'CORE']);
 assert.equal((await checkoutRow(coD.checkout.checkoutId)).status,'COMPLETED');
 assert.deepEqual(await allowances(O.D.id),[{allowance_credits:5000,period_index:0}]);
 assert.equal((await ent(O.Q.id)).status,'SUSPENDED');

 // ---------- 9. evidence, no unintended effect, restore the shipped state ----------
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_access_transitions WHERE kind='FIRST_PAYMENT_ACTIVATION' AND outcome='APPLIED'")).rows[0].n,6);
 assert.deepEqual((await admin.query("SELECT DISTINCT a.action_code FROM hon.saas_audit a WHERE a.action_code LIKE 'saas.access.%' ORDER BY 1")).rows.map(r=>r.action_code),['saas.access.await','saas.access.retry']);
 assert.deepEqual((await admin.query("SELECT DISTINCT event_type FROM hon.saas_outbox WHERE event_type LIKE 'saas.access.%' ORDER BY 1")).rows.map(r=>r.event_type),['saas.access.awaiting','saas.access.retried']);
 assert.deepEqual({P1:await ent(O.P1.id),P2:await ent(O.P2.id)},provisionedBefore);
 assert.deepEqual(await untouched(),before,'no other organization, school billing or Champions effect');
 await setAccessProgram(false);
 programTouched=false;
 assert.deepEqual((await admin.query('SELECT status,mutations_enabled FROM hon.saas_access_program')).rows,[{status:'INACTIVE',mutations_enabled:false}]);
 assert.equal((await admin.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='saas_access_program_status_check'")).rows[0].d,STATUS_CHECK);
 await deny(placeAwaiting('Q'),422,'SAAS_ACCESS_NOT_ACTIVE');
 console.log('PASS: HON paid access B6A proof (program INACTIVE as shipped; ACTIVE simulated in the disposable database only, then restored) — every B6A command refused while inactive; HQ-owner-only awaiting placement with version, idempotency and closed input; awaiting schools keep billing, plan and checkout but no capabilities; school-chosen Core or Complete with server-frozen price; verified payment activates tier, access state and the full 12,000/5,000 allowance once in one transaction (6 concurrent replays; an invoice before checkout is deferred for redelivery, then attributed); Core lacks Complete capabilities; tampered amount, late payment, inactive program and forced failure become HQ review states with no partial grant; HQ retry completes held or failed activations and refuses refunded payments; simultaneous purchases isolated; provisioned schools untouched.');
}finally{
 await setLegacySales(admin,false).catch(e=>console.error('RESTORE FAILED',e));
 if(programTouched)await setAccessProgram(false).catch(e=>console.error('RESTORE FAILED',e));
 await cleanup().catch(e=>console.error(e));
 await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy?.()]);
}
