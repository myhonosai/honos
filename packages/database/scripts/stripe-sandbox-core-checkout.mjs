import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
// HON payments B5: FIRST REAL STRIPE SANDBOX RUN (owner-authorized 2026-10-19), TEST MODE ONLY.
// Exactly one Core regular monthly checkout through the real B5 services and the real Stripe test-mode
// adapter (provider STRIPE), against a disposable local database. Events are reconciled through the
// provider Events API (missed-webhook recovery); webhook forwarding is tested separately.
//
//   preflight -> read-only: authenticated, sandbox, livemode false; nothing written
//   start  -> preflight (test mode, livemode false), fixture, ONE hosted Checkout session, prints its URL
//   verify -> after the owner completes it: recover events twice, reconcile HON records against Stripe
//
// Credentials: the restricted sandbox key never enters this process. The environment's Network Secret
// injects it at egress for api.stripe.com, replacing whatever Authorization header is sent. The adapter
// is therefore constructed here, and only here, with a fixed non-secret placeholder that satisfies its
// unchanged test-key format check. Production key selection (paymentProviderFromEnvironment) is untouched,
// and any STRIPE_* variable in the environment aborts this run. Safety does not rest on the placeholder:
// every Stripe response must carry livemode false (checked below and by the adapter itself).
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden; the sandbox key comes only from the egress Network Secret.');
if(process.env.NODE_USE_ENV_PROXY!=='1'||!process.env.HTTPS_PROXY)throw new Error('Run through the egress proxy (NODE_USE_ENV_PROXY=1) so the Network Secret authenticates the requests.');
const mode=process.argv[2],statePath=process.env.HON_STRIPE_SANDBOX_STATE??'';
if(!['preflight','start','verify'].includes(mode)||!statePath.startsWith('/home/ubuntu/jobs/'))throw new Error('Usage: HON_STRIPE_SANDBOX_STATE=/home/ubuntu/jobs/<dir>/state.json node stripe-sandbox-core-checkout.mjs preflight|start|verify');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const PLACEHOLDER_KEY='rk_test_networkSecretInjectedAtEgress',UNUSED_WEBHOOK_SECRET='whsec_recoveryOnlyRunNoWebhookPath';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {StripeTestModeAdapter,STRIPE_API_VERSION}=await import('../../../apps/api/dist/payments/stripe-test-mode-adapter.js');
const {HqOnboardingService}=await import('../../../apps/api/dist/hq/hq-onboarding.service.js');
const contracts=await import('@hon/contracts');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database);
const payments=new SaasPaymentsService(billing,database,new StripeTestModeAdapter({secretKey:PLACEHOLDER_KEY,webhookSecret:UNUSED_WEBHOOK_SECRET,provider:'STRIPE'}));
const admin=new pg.Client({connectionString:owner.toString(),ssl:false});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString();
const log=(label,value)=>console.log(`${label}: ${typeof value==='string'?value:JSON.stringify(value)}`);

/** Read-only Stripe GET through the egress proxy; only ids and non-sensitive fields are ever printed. */
async function stripeGet(path){
 const r=await fetch(`https://api.stripe.com/v1${path}`,{headers:{Authorization:`Bearer ${PLACEHOLDER_KEY}`,'Stripe-Version':STRIPE_API_VERSION},redirect:'error'});
 const body=await r.json();
 if(!r.ok)throw new Error(`Stripe GET ${path.split('?')[0]} failed: HTTP ${r.status} ${body?.error?.type??''} ${body?.error?.code??''}`.trim());
 return body;
}
const assertTestMode=(o,what)=>{for(const x of (o.object==='list'?o.data:[o]))assert.equal(x.livemode,false,`${what}: Stripe returned a livemode object; stopping.`);};
async function untouched(org){
 return {entitlement:(await admin.query('SELECT to_jsonb(e)::text r FROM hon.organization_entitlements e WHERE organization_id=$1',[org])).rows.map(r=>r.r),
  accessProgram:(await admin.query('SELECT status,mutations_enabled FROM hon.saas_access_program')).rows};
}

await admin.connect();
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- preflight: authenticated, sandbox, test mode ----------
 const pre=await stripeGet('/events?limit=3');
 assert.equal(pre.object,'list');assertTestMode(pre,'preflight events');
 log('preflight','authenticated GET /v1/events ok; every object livemode=false');
 log('preflight event api_versions',[...new Set(pre.data.map(e=>e.api_version))]);

 if(mode==='preflight'){console.log('PASS: preflight only; no fixture or session created.');}
 else if(mode==='start'){
  if(existsSync(statePath))throw new Error('A sandbox checkout was already started; a second session needs owner authorization.');
  assert.equal((await admin.query('SELECT count(*)::int n FROM hon.saas_checkout_sessions')).rows[0].n,0,'disposable database already holds a checkout');
  // Fixture identities (disposable; no real school, family or customer data).
  const humans=Object.fromEntries(['owner','operator','schoolOwner'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`stripe-sandbox-${k}-${randomUUID()}`}]));
  await admin.query('BEGIN');
  for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);
   await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
  for(const[who,hqRole,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']]])
   await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,hqRole,perms]);
  await admin.query('COMMIT');
  const H=k=>humans[k].subject;
  // Owner-approved catalog prices, published unchanged. Founder eligibility is still an undecided owner
  // decision, which blocks publishing; as in the B5 proof it gets a disposable fixture value here. The
  // regular monthly offer tested below does not use it.
  const d=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
  d.termsReference='Sandbox test plan terms (not customer terms)';
  d.founderProgram={...d.founderProgram,eligibility:'ANY_ACTIVE_ORGANIZATION',opensAt:iso(Date.now()-3600_000)};
  await billing.publishCatalog(H('owner'),(await billing.createCatalogDraft(H('owner'),d,K())).catalog.catalogId,K());
  const provisioned=await new HqOnboardingService(database).provisionInitialSchool({externalSubject:H('owner')},{legalName:'Sandbox Test Dojo LLC',
   displayName:'Sandbox Test Dojo',schoolName:'Sandbox Test Dojo Main',schoolSlug:`sandbox-${randomUUID().slice(0,8)}`,timezone:'America/Chicago',initialTier:'CORE',idempotencyKey:K(),expectedPrincipalId:humans.owner.id});
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute')",
   [provisioned.organizationId,provisioned.schoolId,humans.schoolOwner.id,provisioned.ownerRoleId,humans.owner.id]);
  const program=(await payments.setPaymentProgram(H('owner'),{action:'ENABLE_TEST_MODE',expectedVersion:1,provider:'STRIPE',
   authorizationReference:'Owner authorization 2026-10-19: one Core monthly sandbox checkout (test mode only)',
   testTaxReference:'TEST MODE: no tax collected; TAXES undecided (sandbox)'},K())).program;
  assert.deepEqual([program.status,program.provider,program.mode],['TEST_MODE','STRIPE','TEST']);
  const opts=await payments.readPlanOptions(H('schoolOwner'),provisioned.schoolId);
  const offer=opts.offers.find(o=>o.offerKind==='REGULAR_MONTHLY');
  assert.deepEqual([opts.entitlementTier,opts.payments,offer.priceMinor,offer.monthlyPremiumCredits],['CORE',{status:'TEST_MODE',mode:'TEST'},14900,5000]);
  const before=await untouched(provisioned.organizationId);
  const co=await payments.startSchoolCheckout(H('schoolOwner'),provisioned.schoolId,{offerId:offer.offerId},K());
  // Recorded before any further check, so a failure below can never lead to a second session.
  writeFileSync(statePath,JSON.stringify({humans,organizationId:provisioned.organizationId,schoolId:provisioned.schoolId,checkoutId:co.checkout.checkoutId,
   providerSessionId:co.checkout.providerSessionId,startedAt:iso(Date.now()),before},null,1),{mode:0o600,flag:'wx'});
  assert.deepEqual([co.providerCall,co.checkout.status,co.checkout.planCode,co.checkout.offerKind,co.checkout.amountMinor,co.checkout.mode],['OPENED','OPEN','CORE','REGULAR_MONTHLY',14900,'TEST']);
  const session=await stripeGet(`/checkout/sessions/${co.checkout.providerSessionId}`);
  assertTestMode(session,'checkout session');
  assert.deepEqual([session.mode,session.amount_total,session.currency,session.client_reference_id,session.metadata?.honOrganizationId,session.status],
   ['subscription',14900,'usd',co.checkout.checkoutId,provisioned.organizationId,'open']);
  log('checkout id (HON)',co.checkout.checkoutId);
  log('session id (Stripe)',co.checkout.providerSessionId);
  log('organization (disposable)',provisioned.organizationId);
  log('hosted checkout url',co.checkout.checkoutUrl);
  console.log('PAUSED: complete the hosted checkout with a Stripe test card, then run verify.');
 }else{
  const s=JSON.parse(readFileSync(statePath,'utf8')),H=k=>s.humans[k].subject;
  // ---------- Stripe's own record of the session ----------
  const session=await stripeGet(`/checkout/sessions/${s.providerSessionId}`);
  assertTestMode(session,'checkout session');
  log('stripe session',{status:session.status,payment_status:session.payment_status,amount_total:session.amount_total,currency:session.currency,
   subscription:typeof session.subscription==='string'?session.subscription:session.subscription?.id,invoice:typeof session.invoice==='string'?session.invoice:session.invoice?.id});
  assert.deepEqual([session.status,session.payment_status,session.amount_total,session.currency,session.client_reference_id,session.metadata?.honOrganizationId],
   ['complete','paid',14900,'usd',s.checkoutId,s.organizationId],'Stripe does not report this checkout as paid; nothing is reconciled.');
  // ---------- recovery through the Events API ----------
  const sinceHours=Math.min(72,Math.ceil((Date.now()-Date.parse(s.startedAt))/3600_000)+1);
  const r1=await payments.recoverEvents(H('operator'),{sinceHours});
  log('recovery 1',{fetched:r1.fetched,applied:r1.results.length,thisCheckout:r1.results.filter(e=>e.organizationId===s.organizationId).map(e=>[e.type,e.providerEventId,e.outcome,e.detail])});
  // One explicit dependency pass: an initial invoice listed before its checkout is safely deferred.
  // There is no polling loop and no second checkout or payment is created.
  const catchUp=await payments.recoverEvents(H('operator'),{sinceHours});
  const ours=catchUp.results.filter(e=>e.organizationId===s.organizationId);
  log('recovery dependency pass',{fetched:catchUp.fetched,thisCheckout:ours.map(e=>[e.type,e.providerEventId,e.outcome,e.detail])});
  const completed=ours.find(e=>e.type==='checkout.session.completed');
  assert.ok(completed,'checkout.session.completed not recovered yet; re-run verify shortly.');
  assert.ok(['APPLIED','ALREADY_APPLIED'].includes(completed.outcome),`completed event outcome ${completed.outcome}/${completed.detail}`);
  const rows=(await admin.query('SELECT provider,provider_event_id,event_type AS type,outcome,outcome_detail AS detail FROM hon.saas_provider_events WHERE organization_id=$1 ORDER BY received_at',[s.organizationId])).rows;
  assert.ok(rows.every(e=>e.provider==='STRIPE'),'every recorded event is provider STRIPE (not simulated)');
  assert.ok(rows.some(e=>e.type==='checkout.session.completed'&&e.outcome==='APPLIED'&&e.detail==='SUBSCRIPTION_ACTIVATED'));
  const evStripe=await stripeGet(`/events/${completed.providerEventId}`);assertTestMode(evStripe,'event');
  assert.equal(evStripe.data.object.id,s.providerSessionId);
  log('completed event api_version',evStripe.api_version);
  // ---------- HON records ----------
  const sub=(await billing.readOrganizationSubscription(H('operator'),s.organizationId)).current;
  const initialInvoice=ours.find(e=>e.type==='invoice.paid');
  assert.ok(initialInvoice,'initial invoice not attributed: inspect the recorded event; historical NULL-attribution receipts are not repaired by replay.');
  assert.deepEqual([initialInvoice.organizationId,initialInvoice.checkoutId,initialInvoice.subscriptionId,initialInvoice.outcome,initialInvoice.detail],
   [s.organizationId,s.checkoutId,sub.subscriptionId,'ALREADY_APPLIED','FIRST_INVOICE_COVERED_BY_CHECKOUT']);
  assert.deepEqual([sub.status,sub.planCode,sub.offerKind,sub.paymentStatus,sub.currentPeriod.index],['IN_SERVICE','CORE','REGULAR_MONTHLY','PAID',0]);
  assert.equal((await payments.readPlanOptions(H('schoolOwner'),s.schoolId)).paymentVerification,'PROVIDER_VERIFIED');
  const co=(await admin.query('SELECT status,amount_minor,currency,provider,provider_mode,provider_subscription_ref,subscription_id,invoice_id FROM hon.saas_checkout_sessions WHERE id=$1',[s.checkoutId])).rows[0];
  assert.deepEqual([co.status,co.amount_minor,co.currency,co.provider,co.provider_mode,co.subscription_id],['COMPLETED',14900,'USD','STRIPE','TEST',sub.subscriptionId]);
  const inv=await billing.readInvoice(H('operator'),co.invoice_id);
  assert.deepEqual([inv.totalMinor,inv.settlement.state,inv.evidence.length,inv.evidence[0].source,inv.evidence[0].providerVerified],[14900,'PAID_VERIFIED',1,'PROVIDER_VERIFIED',true]);
  const ev=(await admin.query('SELECT source,provider_code,provider_mode,provider_event_id,amount_minor,currency FROM hon.saas_payment_evidence WHERE invoice_id=$1',[co.invoice_id])).rows;
  assert.deepEqual(ev.map(e=>[e.source,e.provider_code,e.provider_mode,e.amount_minor,e.currency]),[['PROVIDER_VERIFIED','STRIPE','TEST',14900,'USD']]);
  assert.equal(ev[0].provider_event_id,completed.providerEventId,'evidence cites the authentic Stripe event');
  log('HON records',{subscription:sub.subscriptionId,invoice:inv.invoiceNumber,evidenceEvent:ev[0].provider_event_id,stripeSubscription:co.provider_subscription_ref});
  // ---------- Core allowance (B3 rules; credit program and pricing are disposable fixtures) ----------
  if((await admin.query('SELECT status FROM hon.saas_credit_program')).rows[0].status==='INACTIVE'){
   await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state) VALUES('HIGGSFIELD','Fixture provider','DISABLED') ON CONFLICT DO NOTHING");
  const costEvidence=(await billing.recordCostEvidence(H('owner'),{providerId:'HIGGSFIELD',modelCode:'fixture-image-1',costUnit:'IMAGE',measuredUnits:1000,billedCostMicrounits:40_000_000,
   fullyLoadedCostMicrounits:50_000_000,evidenceReference:'SANDBOX-FIXTURE-COST-1',periodStart:iso(Date.now()-40*86400_000),periodEnd:iso(Date.now()-10*86400_000),note:null},K()).catch(e=>{throw new Error(`cost evidence fixture: ${e.message}`);})).costEvidence;
  const pd=(await billing.createPricingDraft(H('operator'),{termsReference:'Fixture premium pricing (not customer terms)',operations:[{operationCode:'image.generate',
   category:'IMAGE_GENERATION',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,requiredCapability:'ai.premium_metered',costEvidenceId:costEvidence.costEvidenceId}]},K())).pricing;
  await billing.publishPricing(H('owner'),pd.pricingId,K());
  await billing.setCreditProgram(H('owner'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'Sandbox fixture credit program (disposable database)'},K());
  }
  const openKey=K();
  const allow=(await billing.commandAllowance(H('operator'),{action:'OPEN_CURRENT',subscriptionId:sub.subscriptionId},openKey)).allowance;
  assert.deepEqual([allow.planCode,allow.allowanceBasis,allow.balance.allowanceCredits,allow.periodIndex,allow.periodStart],['CORE','REGULAR',5000,0,sub.currentPeriod.startsAt]);
  assert.equal((await billing.readSchoolCredits(H('schoolOwner'),s.schoolId)).currentAllowance.balance.availableCredits,5000);
  // ---------- duplicates: recovery again, allowance command again ----------
  const counts=async()=>(await admin.query(`SELECT (SELECT count(*) FROM hon.saas_subscriptions WHERE organization_id=$1)::int subs,(SELECT count(*) FROM hon.saas_invoices WHERE organization_id=$1)::int invoices,
   (SELECT count(*) FROM hon.saas_payment_evidence WHERE organization_id=$1)::int evidence,(SELECT count(*) FROM hon.saas_credit_allowances WHERE organization_id=$1)::int allowances,
   (SELECT count(*) FROM hon.saas_credit_ledger l JOIN hon.saas_credit_allowances a ON a.id=l.allowance_id WHERE a.organization_id=$1)::int ledger,(SELECT count(*) FROM hon.saas_provider_events WHERE organization_id=$1)::int events`,[s.organizationId])).rows[0];
  const c1=await counts();
  const r2=await payments.recoverEvents(H('operator'),{sinceHours});
  const ours2=r2.results.filter(e=>e.organizationId===s.organizationId);
  assert.ok(ours2.every(e=>rows.some(x=>x.provider_event_id===e.providerEventId)),'second recovery records no new event for this school');
  await billing.commandAllowance(H('operator'),{action:'OPEN_CURRENT',subscriptionId:sub.subscriptionId},openKey);
  await billing.commandAllowance(H('operator'),{action:'OPEN_CURRENT',subscriptionId:sub.subscriptionId},K()).catch(()=>{});
  const c2=await counts();
  assert.deepEqual(c2,c1,'duplicate recovery and allowance commands change nothing');
  assert.deepEqual([c2.subs,c2.invoices,c2.evidence,c2.allowances],[1,1,1,1]);
  assert.equal((await billing.readSchoolCredits(H('schoolOwner'),s.schoolId)).currentAllowance.balance.availableCredits,5000);
  log('duplicate check',{recovery2:ours2.map(e=>[e.type,e.outcome,e.detail]),counts:c2});
  // ---------- no B6 effect: entitlement row and access program unchanged ----------
  const after=await untouched(s.organizationId);
  assert.deepEqual(after,s.before,'entitlement and paid-access program unchanged');
  assert.deepEqual(after.accessProgram,[{status:'INACTIVE',mutations_enabled:false}]);
  console.log('PASS: first real Stripe sandbox Core monthly checkout reconciled (provider STRIPE, test mode, Events API recovery); duplicates inert; no entitlement or paid-access effect.');
 }
}finally{await admin.end();await database.onModuleDestroy?.();}
