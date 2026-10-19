import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// HON Subscription Billing B5 (0158) integrity proof, TEST MODE, SIMULATED PROVIDER. The real API
// services, the real Stripe test-mode adapter (request building, Stripe-format webhook signature
// verification, normalization) and a deterministic Stripe simulator injected as its transport run
// against a disposable database. Every provider-verified row here is provider STRIPE_SIMULATED: it
// proves HON's integration, not a Stripe account. Journey: HQ registers a school -> the owner sees
// plan options -> hosted checkout -> signed webhook -> subscription, invoice and PROVIDER_VERIFIED
// evidence -> Core allowance -> HQ status; plus failure, cancellation, abandonment, async payment,
// duplicate / out-of-order / missed webhooks, renewals, failed renewals, refunds, disputes, founder
// inventory under contention, tenant isolation and no unintended effect.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {StripeTestModeAdapter}=await import('../../../apps/api/dist/payments/stripe-test-mode-adapter.js');
const {StripeSimulator}=await import('../../../apps/api/dist/payments/stripe-simulator.js');
const {HqOnboardingService}=await import('../../../apps/api/dist/hq/hq-onboarding.service.js');
const contracts=await import('@hon/contracts');
const SECRET='whsec_disposableFixtureSecret0123456789',KEY='sk_test_disposableFixtureKey0123456789';
const sim=new StripeSimulator(SECRET);
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database);
const payments=new SaasPaymentsService(billing,database,new StripeTestModeAdapter({secretKey:KEY,webhookSecret:SECRET,provider:'STRIPE_SIMULATED',transport:sim.transport}));
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const b5Tables=['saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions'];
const saasTables=[...b5Tables,'saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions',
 'saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions'];
const championsTables=['champions_outbox','champions_audit','champions_reward_history','champions_reward_entries','champions_reward_policies','champions_attribution_history',
 'champions_attributions','champions_requests','champions_referral_codes','champions_policies'];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code='42501')=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
// A: journey school registered through HQ provisioning (Core). Fixture orgs: B Complete (founder lifetime),
// F1-F3 Core (founder monthly contention), X Complete (amount mismatch), Y/Z/V Core, W Core referred by R.
const O=Object.fromEntries(['B','F1','F2','F3','X','Y','Z','V','W','R'].map(k=>[k,{id:randomUUID(),tier:['B','X'].includes(k)?'COMPLETE':'CORE',school:randomUUID(),role:randomUUID()}]));
const humans=Object.fromEntries(['owner','operator','support','ownerA',...Object.keys(O).map(k=>`owner${k}`),'plainA'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`b5-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
let createdProvider=false;
async function untouched(){const out={};for(const t of ['organization_entitlements','billing_accounts','memberships','invoices','membership_payment_schedules','payment_attempts','audit_events','outbox_events','champions_reward_entries'])out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t ORDER BY 1`)).rows.map(r=>r.r);return out;}
async function rejectedWithoutGuards(table,sql,params=[],code='23514'){
 await admin.query('BEGIN');
 try{await admin.query(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);await sqlDeny(admin.query(sql,params),code);}finally{await admin.query('ROLLBACK');}
}
async function withoutGuards(tables,sqls){
 await admin.query('BEGIN');
 try{for(const t of tables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);for(const[sql,params]of sqls)await admin.query(sql,params);
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);await admin.query('COMMIT');}
 catch(e){await admin.query('ROLLBACK');throw e;}
}
const fixtureOrgs=()=>Object.values(O).map(o=>o.id);
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  const all=[...saasTables,'saas_credit_program','saas_reward_fulfillment','saas_payment_program',...championsTables];
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of [...saasTables,...championsTables])await admin.query(`DELETE FROM hon.${t}`);
  await admin.query("UPDATE hon.saas_credit_program SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query("UPDATE hon.saas_reward_fulfillment SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query("UPDATE hon.saas_payment_program SET status='DISABLED',provider=NULL,test_tax_reference=NULL,authorization_reference=NULL,version=1,changed_by_principal_id=NULL");
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('DELETE FROM hon.ai_usage_ledger WHERE organization_id=ANY($1::uuid[])',[fixtureOrgs()]);
  if(createdProvider)await admin.query("DELETE FROM hon.hq_ai_provider_connections WHERE provider_id='HIGGSFIELD'");
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[fixtureOrgs()]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[fixtureOrgs()]);
  // The provisioned journey school and its HQ owner keep append-only platform audit rows; they stay in the disposable database.
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const deliver=d=>payments.handleWebhook(d.raw,d.signature);
const outcome=async d=>{const r=await deliver(d);return [r.event.outcome,r.event.detail];};
const options=(who,school)=>payments.readPlanOptions(H(who),school);
const start=(who,school,offerId,key=K())=>payments.startSchoolCheckout(H(who),school,{offerId},key);
const sessionOf=r=>r.checkout.providerSessionId;
const subOf=async org=>(await billing.readOrganizationSubscription(H('operator'),org)).current;
const offerOf=(opts,kind)=>opts.offers.find(o=>o.offerKind===kind).offerId;

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- runtime posture ----------
 for(const t of ['saas_payment_program','saas_checkout_sessions','saas_provider_events','saas_provider_payment_refs'])await sqlDeny(restricted.query(`SELECT * FROM hon.${t}`));
 for(const sig of ['saas_activate_checkout(uuid,jsonb,timestamptz)','saas_open_checkout(uuid,uuid,uuid,uuid,text,timestamptz)','saas_provider_invoice(hon.saas_subscriptions,integer,integer,timestamptz,text,jsonb,timestamptz)','require_saas_school_purchaser(text,uuid)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.principals WHERE id='00000000-0000-4000-8000-0000000000b5' AND principal_type='INTEGRATION' AND user_id IS NULL")).rows[0].n,1);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.hq_operator_grants WHERE principal_id='00000000-0000-4000-8000-0000000000b5'")).rows[0].n,0);
 await cleanup();

 // ---------- fixture ----------
 await admin.query('BEGIN');
 if((await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state) VALUES('HIGGSFIELD','Fixture provider','DISABLED') ON CONFLICT DO NOTHING RETURNING provider_id")).rowCount)createdProvider=true;
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[who,hqRole,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['support','HON_HQ_SUPPORT',['hq.billing.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,hqRole,perms]);
 for(const[k,o]of Object.entries(O)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o.id,`B5 Fixture Dojo ${k}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,$2,clock_timestamp()-interval '90 days')",[o.id,o.tier]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'America/New_York')",[o.school,o.id,`School ${k}`]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[o.role,o.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[o.role,o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[o.id,o.school,humans[`owner${k}`].id,o.role]);
 }
 // W was referred by R through the Champions Club (QUALIFIED), so W's dispute raises a B4 referral alert.
 const champ={policy:randomUUID(),code:randomUUID(),attribution:randomUUID()};
 await admin.query(`INSERT INTO hon.champions_policies(id,policy_version,status,attribution_window_days,refund_window_days,minimum_paid_days,minimum_paid_invoices,payment_verification_source,
  welcome_credit_minor,terms_reference,created_by_principal_id,published_by_principal_id,published_at) VALUES($1,1,'PUBLISHED',90,30,30,1,'HQ_OWNER_ATTESTATION',10000,'Fixture program terms',$2,$2,clock_timestamp())`,[champ.policy,humans.owner.id]);
 await admin.query("INSERT INTO hon.champions_referral_codes(id,organization_id,school_id,code,created_by_principal_id,created_at) VALUES($1,$2,$3,'PAYMENTB5X',$4,clock_timestamp()-interval '50 days')",[champ.code,O.R.id,O.R.school,humans.owner.id]);
 await admin.query(`INSERT INTO hon.champions_attributions(id,referral_code_id,referrer_organization_id,referrer_school_id,referred_organization_id,state,state_reason,version,
  captured_by_principal_id,captured_at,qualified_policy_id,qualified_at,qualification_evidence,decided_by_principal_id,decided_at)
  VALUES($1,$2,$3,$4,$5,'QUALIFIED','QUALIFICATION_VERIFIED',2,$6,clock_timestamp()-interval '40 days',$7,clock_timestamp(),'{"source":"HQ_OWNER_ATTESTATION"}',$6,clock_timestamp())`,
  [champ.attribution,champ.code,O.R.id,O.R.school,O.W.id,humans.owner.id,champ.policy]);
 await admin.query('COMMIT');
 // Owner-approved catalog values; the founder limits below are a disposable fixture (3 total: 1 lifetime, 2 monthly) so contention can be exhausted.
 assert.deepEqual(contracts.SAAS_OWNER_APPROVED_DRAFT.founderProgram,{totalLimit:50,lifetimeLimit:20,monthlyLimit:30,eligibility:'UNDECIDED',reservationHoldDays:1,opensAt:null,closesAt:null});
 assert.deepEqual(contracts.SAAS_OWNER_APPROVED_DRAFT.offers.map(o=>[o.planCode,o.offerKind,o.priceMinor]),[['CORE','REGULAR_MONTHLY',14900],['CORE','FOUNDER_MONTHLY',7900],
  ['CORE','FOUNDER_LIFETIME',189600],['COMPLETE','REGULAR_MONTHLY',24900],['COMPLETE','FOUNDER_MONTHLY',14900],['COMPLETE','FOUNDER_LIFETIME',357600]]);
 const d=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
 d.termsReference='Fixture HON plan terms (not customer terms)';
 d.founderProgram={...d.founderProgram,totalLimit:3,lifetimeLimit:1,monthlyLimit:2,eligibility:'ANY_ACTIVE_ORGANIZATION',opensAt:iso(NOW-HOUR)};
 await billing.publishCatalog(H('owner'),(await billing.createCatalogDraft(H('owner'),d,K())).catalog.catalogId,K());

 // ---------- 1. school registration through HQ provisioning ----------
 const provisioned=await new HqOnboardingService(database).provisionInitialSchool({externalSubject:H('owner')},{legalName:'Journey Martial Arts LLC',
  displayName:'Journey Martial Arts',schoolName:'Journey Martial Arts Main',schoolSlug:`journey-${randomUUID().slice(0,8)}`,timezone:'America/Chicago',initialTier:'CORE',idempotencyKey:K()});
 const A={id:provisioned.organizationId,school:provisioned.schoolId};
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute')",
  [A.id,A.school,humans.ownerA.id,provisioned.ownerRoleId,humans.owner.id]);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.role_permissions WHERE role_id=$1 AND permission_code='billing.hon.purchase'",[provisioned.ownerRoleId])).rows[0].n,1,
  'A newly registered school owner can purchase their plan.');
 const before=await untouched();
 const sessionsStart=sim.requests.length;

 // ---------- 2. payments ship disabled ----------
 let opts=await options('ownerA',A.school);
 assert.deepEqual([opts.entitlementTier,opts.payments,opts.subscription,opts.checkout,opts.annualBilling,opts.planChanges,opts.cardDataStored],
  ['CORE',{status:'DISABLED',mode:null},null,null,'UNAVAILABLE','UNAVAILABLE',false]);
 assert.deepEqual(opts.offers.map(o=>[o.offerKind,o.priceMinor,o.monthlyPremiumCredits]),[['FOUNDER_MONTHLY',7900,5000],['REGULAR_MONTHLY',14900,5000],['FOUNDER_LIFETIME',189600,5000]]);
 await deny(start('ownerA',A.school,offerOf(opts,'REGULAR_MONTHLY')),422,'SAAS_PAYMENTS_NOT_ACTIVE');
 for(const who of ['support','owner','plainA','ownerB'])await deny(options(who,A.school),403,'SAAS_FORBIDDEN');
 let program=(await payments.readPayments(H('operator'))).program;
 assert.deepEqual([program.status,program.liveMode,program.cardDataStored,program.refundExecution],['DISABLED','UNAVAILABLE',false,'UNAVAILABLE']);
 const enable={action:'ENABLE_TEST_MODE',expectedVersion:1,authorizationReference:'Fixture owner test-mode authorization (disposable)',provider:'STRIPE_SIMULATED',
  testTaxReference:'TEST MODE: no tax collected; TAXES undecided (fixture)'};
 await deny(payments.setPaymentProgram(H('operator'),enable,K()),403,'SAAS_FORBIDDEN');
 program=(await payments.setPaymentProgram(H('owner'),enable,K())).program;
 assert.deepEqual([program.status,program.provider,program.mode],['TEST_MODE','STRIPE_SIMULATED','TEST']);

 // ---------- 3. plan selection and hosted checkout (school owner) ----------
 opts=await options('ownerA',A.school);
 assert.deepEqual(opts.payments,{status:'TEST_MODE',mode:'TEST'});
 assert.deepEqual(opts.offers.filter(o=>o.offerKind!=='REGULAR_MONTHLY').map(o=>o.founderSlotsRemaining),[2,1]);
 const completeOffer=(await billing.readCatalog(H('operator'))).published.offers.find(o=>o.planCode==='COMPLETE'&&o.offerKind==='REGULAR_MONTHLY').offerId;
 await deny(start('ownerA',A.school,completeOffer),422,'SAAS_ENTITLEMENT_MISMATCH'); // a payment never changes access; plan changes stay undecided
 const kA=K();
 const coA=await start('ownerA',A.school,offerOf(opts,'REGULAR_MONTHLY'),kA);
 assert.deepEqual([coA.providerCall,coA.checkout.status,coA.checkout.amountMinor,coA.checkout.planCode,coA.checkout.mode,coA.checkout.requesterKind],['OPENED','OPEN',14900,'CORE','TEST','SCHOOL_OWNER']);
 assert.match(coA.checkout.checkoutUrl,/^https:\/\/checkout\.simulated\.invalid\//);
 const req=sim.requests.at(-1);
 assert.deepEqual([req.form.get('mode'),req.form.get('line_items[0][price_data][unit_amount]'),req.form.get('line_items[0][price_data][recurring][interval]'),req.idempotencyKey],
  ['subscription','14900','month',`hon-checkout-${coA.checkout.checkoutId}`]);
 const replay=await start('ownerA',A.school,offerOf(opts,'REGULAR_MONTHLY'),kA);
 assert.deepEqual([replay.replayed,replay.providerCall,replay.checkout.status],[true,'ALREADY_OPEN','OPEN']);
 assert.equal(sim.requests.length,sessionsStart+1,'a replay never opens a second provider session');
 await deny(start('ownerA',A.school,offerOf(opts,'FOUNDER_MONTHLY')),422,'SAAS_CHECKOUT_OPEN');
 await deny(start('ownerB',A.school,offerOf(opts,'REGULAR_MONTHLY')),403,'SAAS_FORBIDDEN'); // another school's owner
 assert.equal((await options('ownerA',A.school)).checkout.checkoutUrl,coA.checkout.checkoutUrl);

 // ---------- 4. verified payment activates the subscription ----------
 const paidA=sim.completeCheckout(sessionOf(coA));
 // A tampered or unsigned delivery never reaches the database.
 const forged=Buffer.from(paidA.completed.raw.toString().replace('"amount_total":14900','"amount_total":100'));
 await deny(payments.handleWebhook(forged,paidA.completed.signature),400,'INVALID_WEBHOOK');
 await deny(payments.handleWebhook(paidA.completed.raw,undefined),400,'INVALID_WEBHOOK');
 const live=sim.liveEvent();await deny(payments.handleWebhook(live.raw,live.signature),400,'INVALID_WEBHOOK');
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.saas_provider_events')).rows[0].n,0);
 const actA=await deliver(paidA.completed);
 assert.deepEqual([actA.replayed,actA.event.outcome,actA.event.detail,actA.event.organizationId],[false,'APPLIED','SUBSCRIPTION_ACTIVATED',A.id]);
 const dupA=await deliver(paidA.completed);
 assert.deepEqual([dupA.replayed,dupA.event.eventId],[true,actA.event.eventId],'a redelivered event is a replay');
 const altered={...JSON.parse(paidA.completed.raw.toString())};altered.data.object.amount_total=100;
 await deny(deliver(sim.sign(altered)),409,'SAAS_PROVIDER_EVENT_CONFLICT'); // same event id, different content
 assert.deepEqual(await outcome(paidA.firstInvoice),['ALREADY_APPLIED','FIRST_INVOICE_COVERED_BY_CHECKOUT']);
 let subA=await subOf(A.id);
 assert.deepEqual([subA.status,subA.planCode,subA.offerKind,subA.paymentStatus,subA.paymentVerification,subA.currentPeriod.index],['IN_SERVICE','CORE','REGULAR_MONTHLY','PAID','PROVIDER_VERIFIED',0]);
 assert.equal(subA.paidThroughAt,subA.currentPeriod.endsAt);
 const invA=(await billing.readInvoices(H('operator'),'ISSUED')).invoices.find(i=>i.organizationId===A.id);
 const invDetail=await billing.readInvoice(H('operator'),invA.invoiceId);
 assert.match(invDetail.invoiceNumber,/^HON-20\d{2}-\d{6}$/);
 assert.deepEqual([invDetail.totalMinor,invDetail.taxStatus,invDetail.taxMinor,invDetail.taxVerificationReference,invDetail.settlement.state,invDetail.evidence[0].source,invDetail.evidence[0].providerVerified],
  [14900,'NO_TAX_APPLICABLE',0,enable.testTaxReference,'PAID_VERIFIED','PROVIDER_VERIFIED',true]);
 const standA=await billing.readPaymentStanding(H('operator'),A.id);
 assert.deepEqual([standA.verified.paidInvoiceCount,standA.providerVerification,standA.championsPaymentSource,standA.evidence.providerVerified],[1,'TEST_MODE','NOT_CONNECTED',1]);
 assert.equal((await admin.query("SELECT tier::text t FROM hon.organization_entitlements WHERE organization_id=$1",[A.id])).rows[0].t,'CORE','entitlement untouched');
 opts=await options('ownerA',A.school);
 assert.deepEqual([opts.subscription.paymentStatus,opts.checkout.status,opts.checkout.checkoutUrl],['PAID','COMPLETED',null]);
 await deny(start('ownerA',A.school,offerOf(opts,'REGULAR_MONTHLY')),422,'SAAS_SUBSCRIPTION_EXISTS');

 // ---------- 5. the Core allowance follows the verified subscription (B3 ledger) ----------
 const ev=(await billing.recordCostEvidence(H('owner'),{providerId:'HIGGSFIELD',modelCode:'fixture-image-1',costUnit:'IMAGE',measuredUnits:1000,billedCostMicrounits:40_000_000,
  fullyLoadedCostMicrounits:50_000_000,evidenceReference:'FIXTURE-B5-PROVIDER-1',periodStart:iso(NOW-40*DAY),periodEnd:iso(NOW-10*DAY),note:null},K())).costEvidence;
 const pd=(await billing.createPricingDraft(H('operator'),{termsReference:'Fixture premium pricing (not customer terms)',operations:[{operationCode:'image.generate',
  category:'IMAGE_GENERATION',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,requiredCapability:'ai.premium_metered',costEvidenceId:ev.costEvidenceId}]},K())).pricing;
 await billing.publishPricing(H('owner'),pd.pricingId,K());
 await billing.setCreditProgram(H('owner'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'Fixture owner authorization (disposable)'},K());
 const allowA=(await billing.commandAllowance(H('operator'),{action:'OPEN_CURRENT',subscriptionId:subA.subscriptionId},K())).allowance;
 assert.deepEqual([allowA.planCode,allowA.allowanceBasis,allowA.balance.allowanceCredits,allowA.periodIndex,allowA.periodStart],['CORE','REGULAR',5000,0,subA.currentPeriod.startsAt]);
 assert.equal((await billing.readSchoolCredits(H('ownerA'),A.school)).currentAllowance.balance.availableCredits,5000);

 // ---------- 6. HQ status ----------
 let hq=await payments.readPayments(H('operator'));
 const hqA=hq.checkouts.find(c=>c.checkoutId===coA.checkout.checkoutId);
 assert.deepEqual([hqA.status,hqA.statusReason,hqA.subscriptionId],['COMPLETED','PAYMENT_VERIFIED',subA.subscriptionId]);
 assert.deepEqual(hq.events.filter(e=>e.organizationId===A.id).map(e=>e.outcome).sort(),['ALREADY_APPLIED','APPLIED']);
 for(const who of ['support','ownerA'])await deny(payments.readPayments(H(who)),403,'SAAS_FORBIDDEN');

 // ---------- 7. founder inventory under contention, expiry and cancellation return slots ----------
 const founderMonthly=offerOf(await options('ownerF1',O.F1.school),'FOUNDER_MONTHLY');
 await Promise.all(Array.from({length:8},()=>payments.readPayments(H('operator')))); // open pool connections so the race really overlaps
 const race=await Promise.allSettled(['F1','F2','F3'].map(k=>start(`owner${k}`,O[k].school,founderMonthly)));
 const raceWon=race.filter(r=>r.status==='fulfilled');
 assert.equal(raceWon.length,2,JSON.stringify(race.map(r=>r.reason?.getResponse?.()??r.value?.checkout?.status)));
 for(const r of race.filter(r=>r.status==='rejected'))http(422,'SAAS_FOUNDER_SOLD_OUT')(r.reason);
 const loser=['F1','F2','F3'][race.findIndex(r=>r.status==='rejected')],winners=['F1','F2','F3'].filter(k=>k!==loser);
 const co=Object.fromEntries(winners.map((k,i)=>[k,raceWon[i].value]));
 for(const k of winners)assert.equal(co[k].checkout.organizationId,O[k].id);
 assert.equal((await options(`owner${loser}`,O[loser].school)).offers.find(o=>o.offerKind==='FOUNDER_MONTHLY').founderSlotsRemaining,0);
 // The first winner abandons; the provider expires the session and the slot returns.
 const [w1,w2]=winners;
 assert.deepEqual(await outcome(sim.expire(sessionOf(co[w1]))),['APPLIED','CHECKOUT_EXPIRED']);
 assert.equal((await options(`owner${loser}`,O[loser].school)).offers.find(o=>o.offerKind==='FOUNDER_MONTHLY').founderSlotsRemaining,1);
 const coL=await start(`owner${loser}`,O[loser].school,founderMonthly);
 assert.equal(coL.checkout.status,'OPEN');
 // Out of order: the first subscription invoice arrives before the checkout completion.
 const paidL=sim.completeCheckout(sessionOf(coL));
 assert.deepEqual(await outcome(paidL.firstInvoice),['ALREADY_APPLIED','FIRST_INVOICE_COVERED_BY_CHECKOUT']);
 assert.deepEqual(await outcome(paidL.completed),['APPLIED','SUBSCRIPTION_ACTIVATED']);
 const subL=await subOf(O[loser].id);
 assert.deepEqual([subL.offerKind,subL.priceMinor,subL.paymentStatus],['FOUNDER_MONTHLY',7900,'PAID']);
 assert.equal((await admin.query("SELECT status FROM hon.saas_founder_reservations WHERE organization_id=$1 AND status='ALLOCATED'",[O[loser].id])).rowCount,1);
 // The second winner's payment is asynchronous and then fails: no subscription; the slot returns.
 const asyncW2=sim.completeCheckout(sessionOf(co[w2]),{paid:false});
 assert.deepEqual(await outcome(asyncW2.completed),['AWAITING_ASYNC_PAYMENT','PAYMENT_PENDING']);
 assert.equal((await payments.readPayments(H('operator'))).reconciliation.awaitingAsyncPayment,1);
 assert.deepEqual(await outcome(sim.asyncPaymentFailed(sessionOf(co[w2]))),['APPLIED','ASYNC_PAYMENT_FAILED']);
 assert.equal(await subOf(O[w2].id),null);
 // A completion for the expired session (late payment) is never activated: HQ reviews it.
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(co[w1])).completed),['NEEDS_REVIEW','PAID_AFTER_CLOSE']);
 assert.equal(await subOf(O[w1].id),null);
 // The first winner retries and cancels on the hosted page; a later completion is reviewed too.
 const coW1=await start(`owner${w1}`,O[w1].school,founderMonthly);
 await deny(payments.cancelCheckout(H(`owner${w2}`),coW1.checkout.checkoutId,{expectedVersion:coW1.checkout.version},K()),403,'SAAS_FORBIDDEN');
 const cancelled=await payments.cancelCheckout(H(`owner${w1}`),coW1.checkout.checkoutId,{expectedVersion:coW1.checkout.version},K());
 assert.deepEqual([cancelled.checkout.status,cancelled.checkout.statusReason,cancelled.providerExpiry],['CANCELLED','CANCELLED_BY_REQUESTER','REQUESTED']);
 assert.equal(sim.sessions.get(sessionOf(coW1)).status,'expired');
 assert.equal((await admin.query("SELECT status_reason FROM hon.saas_founder_reservations WHERE id=$1",[coW1.checkout.founderReservationId])).rows[0].status_reason,'SCHOOL_DECLINED');

 // ---------- 8. founder paid lifetime (one-time payment) keeps the full monthly allowance ----------
 const optsB=await options('ownerB',O.B.school);
 assert.deepEqual(optsB.offers.map(o=>[o.planCode,o.offerKind,o.priceMinor,o.monthlyPremiumCredits]),[['COMPLETE','FOUNDER_MONTHLY',14900,12000],['COMPLETE','REGULAR_MONTHLY',24900,12000],['COMPLETE','FOUNDER_LIFETIME',357600,12000]]);
 const coB=await start('ownerB',O.B.school,offerOf(optsB,'FOUNDER_LIFETIME'));
 assert.equal(sim.requests.at(-1).form.get('mode'),'payment');
 const paidB=sim.completeCheckout(sessionOf(coB));
 assert.deepEqual(await outcome(paidB.completed),['APPLIED','SUBSCRIPTION_ACTIVATED']);
 const subB=await subOf(O.B.id);
 assert.deepEqual([subB.billingInterval,subB.paymentStatus,subB.paymentVerification,subB.paidThroughAt],['LIFETIME','PAID','PROVIDER_VERIFIED',null]);
 const allowB=(await billing.commandAllowance(H('operator'),{action:'OPEN_CURRENT',subscriptionId:subB.subscriptionId},K())).allowance;
 assert.deepEqual([allowB.allowanceBasis,allowB.balance.allowanceCredits],['LIFETIME',12000]);
 assert.equal((await options('ownerB',O.B.school)).offers.find(o=>o.offerKind==='FOUNDER_LIFETIME').founderSlotsRemaining,0);

 // ---------- 9. provider failure, unknown outcome and recovery by idempotent retry ----------
 const optsZ=await options('ownerZ',O.Z.school);
 sim.failNextRequest('REJECT');
 await deny(start('ownerZ',O.Z.school,offerOf(optsZ,'REGULAR_MONTHLY')),502,'SAAS_PAYMENT_PROVIDER_UNAVAILABLE');
 assert.equal((await options('ownerZ',O.Z.school)).checkout.status,'FAILED');
 const kZ=K();sim.failNextRequest('NETWORK');
 await deny(start('ownerZ',O.Z.school,offerOf(optsZ,'REGULAR_MONTHLY'),kZ),409,'SAAS_OUTCOME_UNKNOWN');
 assert.equal((await options('ownerZ',O.Z.school)).checkout.status,'CREATED');
 assert.equal((await payments.readPayments(H('operator'))).reconciliation.createdWithoutProviderSession,1);
 const retryZ=await start('ownerZ',O.Z.school,offerOf(optsZ,'REGULAR_MONTHLY'),kZ);
 assert.deepEqual([retryZ.replayed,retryZ.providerCall,retryZ.checkout.status],[true,'OPENED','OPEN']);
 // Abandoned: never paid, past its expiry; the HQ sweep closes it.
 await withoutGuards(['saas_checkout_sessions'],[["UPDATE hon.saas_checkout_sessions SET created_at=created_at-interval '2 days',expires_at=expires_at-interval '2 days' WHERE id=$1",[retryZ.checkout.checkoutId]]]);
 assert.equal((await payments.readPayments(H('operator'))).reconciliation.openPastExpiry,1);
 await deny(payments.sweepCheckouts(H('support'),K()),403,'SAAS_FORBIDDEN');
 assert.equal((await payments.sweepCheckouts(H('operator'),K())).expired,1);
 assert.deepEqual((({status,statusReason})=>[status,statusReason])((await payments.readPayments(H('operator'))).checkouts.find(c=>c.checkoutId===retryZ.checkout.checkoutId)),['EXPIRED','LOCAL_EXPIRED']);

 // ---------- 10. amount mismatch and cross-tenant references never activate ----------
 const optsX=await options('ownerX',O.X.school);
 const coX=await start('ownerX',O.X.school,offerOf(optsX,'REGULAR_MONTHLY'));
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coX),{amount:100}).completed),['NEEDS_REVIEW','AMOUNT_MISMATCH']);
 assert.equal(await subOf(O.X.id),null);
 const coY=await start('ownerY',O.Y.school,offerOf(await options('ownerY',O.Y.school),'REGULAR_MONTHLY'));
 const spoof=JSON.parse(sim.completeCheckout(sessionOf(coY)).completed.raw.toString());
 spoof.id='evt_spoofed000001';spoof.data.object.client_reference_id=coA.checkout.checkoutId;spoof.data.object.metadata.honCheckoutId=coA.checkout.checkoutId;
 assert.deepEqual(await outcome(sim.sign(spoof)),['NEEDS_REVIEW','UNKNOWN_CHECKOUT']); // Y's session cannot pay A's checkout
 hq=await payments.readPayments(H('operator'));
 assert.deepEqual([hq.reconciliation.paidNeedsReview,hq.reconciliation.eventsNeedingReview],[2,3]);

 // ---------- 11. renewals: the provider period lines up with HON's anchored period ----------
 // Fixture time travel: A's period 0 (subscription, its invoice and its allowance) moves 31 days into the past.
 await withoutGuards(['saas_subscriptions','saas_credit_allowances','saas_invoices'],[
  ["UPDATE hon.saas_subscriptions SET service_started_at=service_started_at-interval '31 days',period_anchor_at=period_anchor_at-interval '31 days',current_period_start=current_period_start-interval '31 days',current_period_end=current_period_start-interval '31 days'+interval '1 month' WHERE id=$1",[subA.subscriptionId]],
  ["UPDATE hon.saas_invoices SET service_period_start=service_period_start-interval '31 days',service_period_end=service_period_start-interval '31 days'+interval '1 month' WHERE subscription_id=$1",[subA.subscriptionId]],
  ["UPDATE hon.saas_credit_allowances SET period_start=period_start-interval '31 days',period_end=period_start-interval '31 days'+interval '1 month' WHERE id=$1",[allowA.allowanceId]]]);
 subA=await subOf(A.id);
 assert.equal(subA.paymentStatus,'DUE','period 0 has ended and period 1 is unpaid');
 const renewal=sim.renewal(paidA.subscription,Date.parse(subA.currentPeriod.endsAt)/1000,14900);
 assert.deepEqual(await outcome(renewal.delivery),['APPLIED','RENEWAL_RECORDED']);
 subA=await subOf(A.id);
 assert.deepEqual([subA.currentPeriod.index,subA.paymentStatus,subA.paymentVerification],[1,'PAID','PROVIDER_VERIFIED']);
 const periodOne=(await billing.readInvoices(H('operator'),'ISSUED')).invoices.filter(i=>i.organizationId===A.id).map(i=>i.periodIndex).sort();
 assert.deepEqual(periodOne,[0,1]);
 const dupRenewal=JSON.parse(renewal.delivery.raw.toString());dupRenewal.id='evt_renewalcopy01';
 assert.deepEqual(await outcome(sim.sign(dupRenewal)),['ALREADY_APPLIED','PAYMENT_ALREADY_RECORDED']); // same provider invoice under a new event id
 assert.deepEqual(await outcome(sim.renewal(paidA.subscription,Date.parse(subA.currentPeriod.endsAt)/1000+10*86400,14900).delivery),['NEEDS_REVIEW','PERIOD_MISMATCH']);
 assert.deepEqual(await outcome(sim.renewal(paidA.subscription,Date.parse(subA.currentPeriod.endsAt)/1000,9900).delivery),['NEEDS_REVIEW','AMOUNT_MISMATCH']);
 assert.equal((await billing.commandAllowance(H('operator'),{action:'OPEN_CURRENT',subscriptionId:subA.subscriptionId},K())).allowance.periodIndex,1); // fresh full allowance, no rollover
 // A failed renewal (founder monthly school, period 0 elapsed) shows PAST_DUE; HON suspends nothing.
 await withoutGuards(['saas_subscriptions','saas_invoices'],[["UPDATE hon.saas_subscriptions SET service_started_at=service_started_at-interval '31 days',period_anchor_at=period_anchor_at-interval '31 days',current_period_start=current_period_start-interval '31 days',current_period_end=current_period_start-interval '31 days'+interval '1 month' WHERE id=$1",[subL.subscriptionId]],
  ["UPDATE hon.saas_invoices SET service_period_start=service_period_start-interval '31 days',service_period_end=service_period_start-interval '31 days'+interval '1 month' WHERE subscription_id=$1",[subL.subscriptionId]]]);
 const subL2=await subOf(O[loser].id);
 assert.deepEqual(await outcome(sim.renewalFailed(paidL.subscription,Date.parse(subL2.currentPeriod.endsAt)/1000,7900)),['APPLIED','RENEWAL_PAYMENT_FAILED']);
 const subL3=await subOf(O[loser].id);
 assert.deepEqual([subL3.paymentStatus,subL3.status],['PAST_DUE','IN_SERVICE']);

 // ---------- 12. refunds and disputes reconcile as provider-verified evidence (no HON execution) ----------
 // B lifetime: the owner approves the B4 guarantee; the refund itself happens at the provider.
 const rq=(await billing.createRefundRequest(H('operator'),{organizationId:O.B.id,requestReceivedAt:iso(Date.now()),customerReference:'Fixture support ticket',note:null},K())).refundRequest;
 assert.deepEqual([rq.evidenceStrength,rq.requestedAmountMinor,rq.execution],['PROVIDER_VERIFIED',357600,'UNAVAILABLE']);
 const rqA=(await billing.decideRefundRequest(H('owner'),rq.refundRequestId,{decision:'APPROVE',reasonCode:'GUARANTEE_APPROVED',expectedVersion:1,note:null},K())).refundRequest;
 assert.deepEqual(await outcome(sim.refund(paidB.paymentIntent,null,100000,paidB.charge)),['APPLIED','REFUND_RECORDED']);
 assert.deepEqual(await outcome(sim.refund(paidB.paymentIntent,null,100000,paidB.charge)),['ALREADY_APPLIED','REFUND_ALREADY_RECORDED']); // cumulative amount unchanged
 await deny(billing.decideRefundRequest(H('owner'),rq.refundRequestId,{decision:'MARK_EVIDENCED',reasonCode:'REFUND_EVIDENCE_RECORDED',expectedVersion:rqA.version,note:null},K()),422,'SAAS_REFUND_EVIDENCE_INCOMPLETE');
 assert.deepEqual(await outcome(sim.refund(paidB.paymentIntent,null,357600,paidB.charge)),['APPLIED','REFUND_RECORDED']);
 const rqDone=(await billing.decideRefundRequest(H('owner'),rq.refundRequestId,{decision:'MARK_EVIDENCED',reasonCode:'REFUND_EVIDENCE_RECORDED',expectedVersion:rqA.version,note:null},K())).refundRequest;
 assert.deepEqual([rqDone.status,rqDone.refundEvidencedMinor,rqDone.executionStatus],['REFUND_EVIDENCED',357600,'NOT_EXECUTED']);
 assert.deepEqual((await admin.query("SELECT amount_minor FROM hon.saas_payment_evidence WHERE organization_id=$1 AND kind='REFUND' ORDER BY amount_minor",[O.B.id])).rows.map(r=>r.amount_minor),[100000,257600]);
 assert.deepEqual([(await subOf(O.B.id)).paymentStatus,(await subOf(O.B.id)).status],['REFUNDED','IN_SERVICE']); // cancellation timing undecided: nothing is cancelled
 // A refund reported only by the subscription invoice reference reconciles through the linked refs.
 assert.deepEqual(await outcome(sim.refund(null,paidL.invoice,7900)),['APPLIED','REFUND_RECORDED']);
 // W (referred by R) pays, then disputes: CHARGEBACK evidence and a B4 referral alert, nothing reversed.
 const coWr=await start('ownerW',O.W.school,offerOf(await options('ownerW',O.W.school),'REGULAR_MONTHLY'));
 const paidW=sim.completeCheckout(sessionOf(coWr));
 assert.deepEqual(await outcome(paidW.completed),['APPLIED','SUBSCRIPTION_ACTIVATED']);
 assert.deepEqual(await outcome(paidW.firstInvoice),['ALREADY_APPLIED','FIRST_INVOICE_COVERED_BY_CHECKOUT']);
 const dispute=sim.dispute(paidW.paymentIntent,14900);
 assert.deepEqual(await outcome(dispute),['APPLIED','CHARGEBACK_RECORDED']);
 assert.equal((await subOf(O.W.id)).paymentStatus,'DISPUTED');
 const alert=(await billing.readReferralAlerts(H('operator'),'OPEN')).alerts.find(a=>a.referredOrganizationId===O.W.id);
 assert.deepEqual([alert.source,alert.evidenceKind,alert.automaticReversal,alert.debtCreated],['PAYMENT_EVIDENCE','CHARGEBACK','NONE',false]);
 const dupDispute=JSON.parse(dispute.raw.toString());dupDispute.id='evt_disputecopy01';
 assert.deepEqual(await outcome(sim.sign(dupDispute)),['ALREADY_APPLIED','DISPUTE_ALREADY_RECORDED']);
 // Money events that match nothing HON billed are kept for review, never ignored (no checkout is open now).
 await payments.cancelCheckout(H('ownerY'),coY.checkout.checkoutId,{expectedVersion:(await options('ownerY',O.Y.school)).checkout.version},K());
 assert.deepEqual(await outcome(sim.refund('pi_unknown000001',null,5000)),['NEEDS_REVIEW','UNMATCHED_PAYMENT']);
 assert.deepEqual(await outcome(sim.renewal('sub_unknown000001',Math.floor(Date.now()/1000),14900).delivery),['NEEDS_REVIEW','UNKNOWN_PROVIDER_SUBSCRIPTION']);

 // ---------- 13. missed webhooks: recovery re-fetches provider events and applies them once ----------
 const coV=await start('ownerV',O.V.school,offerOf(await options('ownerV',O.V.school),'REGULAR_MONTHLY'));
 const missed=sim.completeCheckout(sessionOf(coV)); // never delivered by webhook
 assert.equal(await subOf(O.V.id),null);
 await deny(payments.recoverEvents(H('support'),{sinceHours:1}),403,'SAAS_FORBIDDEN');
 const recovered=await payments.recoverEvents(H('operator'),{sinceHours:1});
 assert.equal(recovered.fetched,sim.events.length);
 assert.equal((await subOf(O.V.id)).paymentStatus,'PAID');
 assert.ok(recovered.results.some(r=>r.type==='checkout.session.completed'&&r.organizationId===O.V.id&&r.outcome==='APPLIED'));
 const again=await payments.recoverEvents(H('operator'),{sinceHours:1});
 assert.equal(again.results.filter(r=>r.outcome==='APPLIED'&&r.organizationId===O.V.id).length,1,'already-applied events replay');
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.saas_subscriptions WHERE organization_id=$1',[O.V.id])).rows[0].n,1);
 assert.equal((await deliver(missed.completed)).replayed,true); // the late webhook is a replay
 // Events for another provider than the configured one are refused in the database itself.
 const otherProvider={provider:'STRIPE',eventId:'evt_wrongprovider01',type:'customer.created',livemode:false,createdAt:iso(Date.now()),object:{}};
 await sqlDeny(restricted.query('SELECT hon.ingest_saas_provider_event($1::jsonb,$2)',[JSON.stringify(otherProvider),'0'.repeat(64)]),'42501');
 await sqlDeny(restricted.query('SELECT hon.ingest_saas_provider_event($1::jsonb,$2)',[JSON.stringify({...otherProvider,provider:'STRIPE_SIMULATED',livemode:true}),'0'.repeat(64)]),'42501');

 // ---------- 14. constraints hold with guards disabled; provider records are append-only ----------
 await rejectedWithoutGuards('saas_payment_program',"UPDATE hon.saas_payment_program SET status='LIVE_MODE'");
 await rejectedWithoutGuards('saas_payment_program',"UPDATE hon.saas_payment_program SET live_mode=true");
 await rejectedWithoutGuards('saas_checkout_sessions',"UPDATE hon.saas_checkout_sessions SET provider_mode='LIVE'");
 await rejectedWithoutGuards('saas_checkout_sessions',"UPDATE hon.saas_checkout_sessions SET checkout_url='http://pay.example/x' WHERE checkout_url IS NOT NULL");
 await rejectedWithoutGuards('saas_checkout_sessions',"UPDATE hon.saas_checkout_sessions SET provider_session_id='cs_live_abc' WHERE provider_session_id IS NOT NULL");
 await rejectedWithoutGuards('saas_provider_events',"UPDATE hon.saas_provider_events SET livemode=true");
 await rejectedWithoutGuards('saas_payment_evidence',"UPDATE hon.saas_payment_evidence SET provider_mode='LIVE' WHERE source='PROVIDER_VERIFIED'");
 await rejectedWithoutGuards('saas_payment_evidence',"UPDATE hon.saas_payment_evidence SET provider_event_id=NULL WHERE source='PROVIDER_VERIFIED'");
 await rejectedWithoutGuards('saas_payment_evidence',"UPDATE hon.saas_payment_evidence SET source='HQ_ATTESTATION' WHERE source='PROVIDER_VERIFIED'");
 await rejectedWithoutGuards('saas_checkout_sessions',`INSERT INTO hon.saas_checkout_sessions(organization_id,school_id,catalog_id,offer_id,plan_code,offer_kind,billing_interval,amount_minor,
  requester_kind,requested_by_principal_id,provider,status,status_reason,expires_at,version,created_at,updated_at)
  SELECT organization_id,school_id,catalog_id,offer_id,plan_code,offer_kind,billing_interval,amount_minor,requester_kind,requested_by_principal_id,provider,'OPEN','PROVIDER_SESSION_OPENED',
  expires_at,1,created_at,updated_at FROM hon.saas_checkout_sessions LIMIT 1`);
 for(const sql of ['UPDATE hon.saas_provider_events SET outcome=outcome','DELETE FROM hon.saas_provider_payment_refs',"UPDATE hon.saas_checkout_sessions SET status='OPEN',version=version+1 WHERE status='COMPLETED'",
  "UPDATE hon.saas_payment_program SET provider='STRIPE',version=version+1",'TRUNCATE hon.saas_provider_events CASCADE','DELETE FROM hon.saas_checkout_sessions'])
  await sqlDeny(admin.query(sql));

 // ---------- 15. evidence and no unintended effect ----------
 const ev5=(await admin.query(`SELECT (SELECT count(*) FROM hon.saas_requests WHERE status<>'COMPLETED')::int open,
  (SELECT count(*) FROM hon.saas_outbox WHERE payload->'executionAllowed'<>'false'::jsonb OR payload->'internalOnly'<>'true'::jsonb)::int live,
  (SELECT count(*) FROM hon.saas_provider_events)::int events,
  (SELECT count(*) FROM hon.saas_audit WHERE action_code='saas.provider.event')::int "eventAudit",
  (SELECT count(*) FROM hon.saas_payment_evidence WHERE source='PROVIDER_VERIFIED' AND (provider_code<>'STRIPE_SIMULATED' OR provider_mode<>'TEST'))::int "notSimulated"`)).rows[0];
 assert.deepEqual([ev5.open,ev5.live,ev5.notSimulated],[0,0,0]);
 assert.equal(ev5.eventAudit,ev5.events,'one audit row per applied provider event');
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_subscriptions WHERE created_by_principal_id='00000000-0000-4000-8000-0000000000b5'")).rows[0].n,5);
 assert.deepEqual(await untouched(),before,'No entitlement, school-to-family billing or payment attempt, shared audit/outbox or Champions reward row changed.');
 console.log(`PASS: HON payments B5 proof (TEST MODE, SIMULATED Stripe) — school registered through HQ provisioning; plan options; hosted checkout through the real adapter; ${ev5.events} signature-verified events applied once (tampered, unsigned, live, conflicting and wrong-provider deliveries refused); subscription, invoice and PROVIDER_VERIFIED evidence in one transaction; Core 5,000 / lifetime Complete 12,000 allowances; founder contention, expiry, async failure, cancellation and late payment; unknown-outcome retry; abandoned sweep; renewals and PAST_DUE; provider refunds and disputes reconciled (B4 evidence and alert); missed-webhook recovery; no entitlement or school-billing effect.`);
}finally{
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end()]);}
}
