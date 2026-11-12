import pg from 'pg';
import { setLegacySales } from './saas-legacy-sales-simulation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// HON OS purchase binding (0182) integrity proof, TEST MODE, SIMULATED PROVIDER. The real API services, the real Stripe
// test-mode adapter and the deterministic Stripe simulator run against a disposable database. Every provider-verified
// row here is STRIPE_SIMULATED: it proves HON's integration, not a Stripe account. A school buys each of the six HQ-published
// HON OS offer kinds at the exact published price and terms (frozen as the accepted offer); monthly and auto-renewing
// annual offers renew at the accepted price only; one-time offers (lifetime, annual without auto-renewal) create no
// recurring obligation; unpublished, future, stopped, retired, unsupported, ineligible and sold-out offers are refused for new checkouts,
// while an open checkout keeps its accepted terms through a routine price change and only an explicit stop-sales blocks it;
// the sale limit and the one cumulative HON OS founder pool hold under contention; late, tampered and mismatched payments
// go to HQ review; refunds and disputes reconcile; legacy records, entitlements, credits and paid access are untouched.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {HqEntitlementService}=await import('../../../apps/api/dist/hq/hq-entitlement.service.js');
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const {StripeTestModeAdapter}=await import('../../../apps/api/dist/payments/stripe-test-mode-adapter.js');
const {StripeSimulator}=await import('../../../apps/api/dist/payments/stripe-simulator.js');
const contracts=await import('@hon/contracts');
const SECRET='whsec_disposableFixtureSecret0123456789',KEY='sk_test_disposableFixtureKey0123456789';
const sim=new StripeSimulator(SECRET);
const database=new RuntimeDatabaseService(),hqEntitlement=new HqEntitlementService(database),billing=new SaasBillingService(database),schoolBilling=new SaasSchoolBillingService(billing);
const payments=new SaasPaymentsService(billing,database,new StripeTestModeAdapter({secretKey:KEY,webhookSecret:SECRET,provider:'STRIPE_SIMULATED',transport:sim.transport}));
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const offerTables=['saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const saasTables=['saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions','saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger',
 'saas_reward_applications','saas_refund_history','saas_refund_requests','saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances',
 'saas_operation_prices','saas_pricing_versions','saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox',
 'saas_audit','saas_requests','saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions',...offerTables];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code='42501')=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// A promotion whose sales window closes while a school's checkout is still open (owner decision D6, revised).
const SHORT_CLOSE=NOW+60_000;
// COMPLETE organizations buy; C is CORE; E's entitlement has ended; G has a legacy (LEGACY_ENTITLEMENT) subscription.
const NAMES=['M','A','FA','FL','FM1','FM2','FM3','L','L2','X','R','Y','Z','Q','V','T','U','N','W','C','E','G'];
const O=Object.fromEntries(NAMES.map(k=>[k,{id:randomUUID(),tier:k==='C'?'CORE':'COMPLETE',school:randomUUID(),role:randomUUID()}]));
const humans=Object.fromEntries(['owner','operator','support','staffM',...NAMES.map(k=>`owner${k}`)].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`hon-os-buy-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
const fixtureOrgs=()=>Object.values(O).map(o=>o.id);

// Every price and term below is fixture data chosen by "HQ" in this proof, not a constant in the product.
const offer=(code,kind,priceMinor,displayName,patch={})=>{const interval=contracts.saasHonOsOfferBillingInterval(kind);return{offerCode:code,offerKind:kind,displayName,priceMinor,
 salesOpensAt:iso(NOW-HOUR),salesClosesAt:null,eligibility:'ANY_ACTIVE_ORGANIZATION',saleLimit:interval==='ONE_TIME'?25:null,
 priceLock:interval==='ONE_TIME'?'NONE':'WHILE_CONTINUOUSLY_SUBSCRIBED',priceLockMonths:null,annualRenewal:interval==='ANNUAL'?'AUTO_RENEW_AT_LOCKED_PRICE':null,
 plannedMonthlyPremiumCredits:12000,aiFairUseReference:interval==='ONE_TIME'?'Fixture lifetime AI fair-use policy v1':null,refundWindowDays:30,
 cancellationTiming:interval==='ONE_TIME'?null:'END_OF_PAID_PERIOD',...patch};};
const offersV1=()=>[
 offer('OS_MONTHLY','REGULAR_MONTHLY',31700,'Monthly'),
 offer('OS_ANNUAL','REGULAR_ANNUAL',317000,'Annual'),
 offer('OS_FOUNDER_MONTHLY','FOUNDER_MONTHLY',18300,'Founder monthly',{eligibility:'NEW_ORGANIZATIONS_ONLY'}),
 offer('OS_FOUNDER_ANNUAL','FOUNDER_ANNUAL',183000,'Founder annual',{annualRenewal:'NO_AUTO_RENEWAL',priceLock:'FIXED_MONTHS',priceLockMonths:24,refundWindowDays:14}),
 offer('OS_LIFETIME','LIFETIME',950000,'Lifetime',{saleLimit:1,refundWindowDays:7}),
 offer('OS_FOUNDER_LIFETIME','FOUNDER_LIFETIME',640000,'Founder lifetime',{saleLimit:5}),
 offer('OS_PROMO','REGULAR_MONTHLY',29900,'Spring promotion'),
 offer('OS_ANNUAL_CURRENT','REGULAR_ANNUAL',330000,'Annual at current price',{annualRenewal:'AUTO_RENEW_AT_CURRENT_PRICE'}),
 offer('OS_SHORT','REGULAR_MONTHLY',30500,'Weekend promotion',{salesClosesAt:iso(SHORT_CLOSE)}),
 offer('OS_LATER','REGULAR_MONTHLY',30000,'Opens later',{salesOpensAt:iso(NOW+30*DAY)})];
const TERMS='Fixture HON OS terms v1 (not customer terms)';

async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  const all=[...saasTables,'saas_credit_program','saas_reward_fulfillment','saas_payment_program'];
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of saasTables)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query("UPDATE hon.saas_payment_program SET status='DISABLED',provider=NULL,test_tax_reference=NULL,authorization_reference=NULL,version=1,changed_by_principal_id=NULL");
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  // Section 9b's HQ tier transition evidence (immutable outside a disposable cleanup).
  for(const t of ['hq_entitlement_outbox','hq_entitlement_audit','hq_entitlement_requests'])await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('DELETE FROM hon.hq_entitlement_outbox WHERE audit_id IN (SELECT id FROM hon.hq_entitlement_audit WHERE organization_id=ANY($1::uuid[]))',[fixtureOrgs()]);
  const hqKeys=(await admin.query('DELETE FROM hon.hq_entitlement_audit WHERE organization_id=ANY($1::uuid[]) RETURNING actor_principal_id,idempotency_key',[fixtureOrgs()])).rows;
  for(const r of hqKeys)await admin.query('DELETE FROM hon.hq_entitlement_requests WHERE actor_principal_id=$1 AND idempotency_key=$2',[r.actor_principal_id,r.idempotency_key]);
  for(const t of ['hq_entitlement_outbox','hq_entitlement_audit','hq_entitlement_requests'])await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[fixtureOrgs()]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[fixtureOrgs()]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
async function untouched(){const out={};for(const t of ['organization_entitlements','saas_founder_reservations','saas_catalog_versions','saas_credit_allowances','saas_credit_ledger','saas_access_program',
 'saas_credit_program','billing_accounts','memberships','invoices','payment_attempts','ai_usage_ledger','champions_reward_entries','audit_events','outbox_events'])
 // N's entitlement is changed on purpose by HQ in section 9b and asserted there.
 out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t WHERE $1::text IS NULL OR to_jsonb(t)->>'organization_id' IS DISTINCT FROM $1::text ORDER BY 1`,
  [t==='organization_entitlements'?O.N.id:null])).rows.map(r=>r.r);return out;}
const deliver=d=>payments.handleWebhook(d.raw,d.signature);
const outcome=async d=>{const r=await deliver(d);return [r.event.outcome,r.event.detail];};
const view=(who,school)=>billing.readSchoolHonOsOffers(H(who),school);
const start=(who,school,offerId,key=K())=>payments.startSchoolHonOsCheckout(H(who),school,{offerId},key);
const startOf=(k,offerId,key)=>start(`owner${k}`,O[k].school,offerId,key);
const eligibility=async k=>Object.fromEntries((await view(`owner${k}`,O[k].school)).offers.map(o=>[o.offerCode,o.eligibility]));
const sessionOf=r=>r.checkout.providerSessionId;
const subOf=async org=>(await billing.readOrganizationSubscription(H('operator'),org)).current;
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const sessionReq=checkoutId=>sim.requests.find(r=>r.path==='/v1/checkout/sessions'&&r.form?.get('client_reference_id')===checkoutId);
const form=checkoutId=>{const f=sessionReq(checkoutId).form;return[f.get('mode'),f.get('line_items[0][price_data][unit_amount]'),f.get('line_items[0][price_data][recurring][interval]'),
 f.get('line_items[0][price_data][product_data][name]')];};
async function snapshotOf(checkoutId){
 return row(`SELECT c.accepted_offer a,c.accepted_offer_digest d,hon.saas_hon_os_digest(c.accepted_offer) recomputed,hon.saas_hon_os_accepted_offer(o) live,c.provider_recurring r,
  c.provider_subscription_ref sref,c.offer_set_id,c.catalog_id,c.offer_id FROM hon.saas_checkout_sessions c JOIN hon.saas_offer_set_offers o ON o.id=c.hon_os_offer_id WHERE c.id=$1`,[checkoutId]);
}
async function subscriptionRow(org){return row("SELECT * FROM hon.saas_subscriptions WHERE organization_id=$1 AND status<>'VOIDED'",[org]);}
async function invoiceLines(org){return(await admin.query('SELECT i.kind,i.period_index,i.subtotal_minor,i.service_period_start,i.service_period_end,l.description FROM hon.saas_invoices i JOIN hon.saas_invoice_lines l ON l.invoice_id=i.id WHERE i.organization_id=$1 ORDER BY i.created_at,i.period_index NULLS FIRST',[org])).rows;}
// Pays one checkout through the simulator and the real webhook path; returns the provider refs.
async function pay(co,expect=['APPLIED','SUBSCRIPTION_ACTIVATED']){
 const paid=sim.completeCheckout(sessionOf(co));
 assert.deepEqual(await outcome(paid.completed),expect);
 if(paid.firstInvoice&&expect[0]==='APPLIED')assert.deepEqual(await outcome(paid.firstInvoice),['ALREADY_APPLIED','FIRST_INVOICE_COVERED_BY_CHECKOUT']);
 return paid;
}

await Promise.all([admin.connect(),restricted.connect()]);
const v1Gate=on=>admin.query(`ALTER TABLE hon.saas_checkout_sessions ${on?'ENABLE':'DISABLE'} TRIGGER saas_hon_os_v1_offer_kind`);
try{
 // 0237 (owner answer 5) refuses every new HON OS v1 founder or lifetime checkout. This proof replays the pre-0237 sales
 // history: the refusal is proven live where that history first sells one, then set aside in the disposable database
 // only, and restored (and checked enabled) before the PASS line and in the finally block.
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- runtime posture: only the school entry point is callable ----------
 for(const sig of ['saas_open_hon_os_checkout(uuid,uuid,uuid,uuid,timestamptz)','saas_activate_hon_os_checkout(uuid,jsonb,timestamptz)','saas_hon_os_refusal(uuid,hon.saas_offer_set_offers,timestamptz)',
  'saas_hon_os_accepted_offer(hon.saas_offer_set_offers)','saas_hon_os_offer_usage(uuid,timestamptz,uuid)','saas_hon_os_founder_usage(timestamptz,uuid)','saas_hon_os_purchase_json(hon.saas_checkout_sessions)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);
 assert.equal((await restricted.query("SELECT has_function_privilege(current_user,'hon.create_saas_hon_os_checkout_from_school(text,uuid,jsonb,uuid,uuid,uuid)','EXECUTE') a")).rows[0].a,true);
 for(const t of ['saas_checkout_sessions','saas_subscriptions','saas_offer_set_offers'])await sqlDeny(restricted.query(`SELECT * FROM hon.${t}`));
 await cleanup();
 // 0184 (D8) closed legacy new sales; this proof exercises them, so it reopens them in this disposable database only.
 await setLegacySales(admin,true);

 // ---------- fixture ----------
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[who,hqRole,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['support','HON_HQ_SUPPORT',['hq.billing.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,hqRole,perms]);
 for(const[k,o]of Object.entries(O)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o.id,`HON OS Fixture Dojo ${k}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from,effective_until) VALUES($1,$2,clock_timestamp()-interval '90 days',$3)",
   [o.id,o.tier,k==='E'?iso(NOW-DAY):null]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'America/New_York')",[o.school,o.id,`School ${k}`]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[o.role,o.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[o.role,o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[o.id,o.school,humans[`owner${k}`].id,o.role]);
 }
 // A staff member at M without billing.hon.purchase.
 const staffRole=randomUUID();
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'FRONT_DESK','Front desk',false)",[staffRole,O.M.id]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions WHERE code NOT LIKE 'billing.%'",[staffRole,O.M.id]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[O.M.id,O.M.school,humans.staffM.id,staffRole]);
 await admin.query('COMMIT');
 const legacyG=(await billing.recordSubscription(H('owner'),{source:'LEGACY_ENTITLEMENT',organizationId:O.G.id},K())).subscription;
 assert.equal(legacyG.source,'LEGACY_ENTITLEMENT');
 const before=await untouched();
 const legacyBefore=(await admin.query("SELECT to_jsonb(s)::text r FROM hon.saas_subscriptions s WHERE source<>'HON_OS_OFFER' ORDER BY 1")).rows;

 // ---------- 1. HQ publishes the offer set (owner only, digest-approved) ----------
 const d1=await billing.createOfferSetDraft(H('owner'),{basedOnSetId:null,termsReference:TERMS,founderTotalLimit:4,offers:offersV1()},K());
 const pub1=await billing.publishOfferSet(H('owner'),d1.set.setId,{expectedRevision:d1.set.revision,previewDigest:d1.preview.previewDigest,approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K());
 const V1=Object.fromEntries(pub1.set.offers.map(o=>[o.offerCode,o.offerId]));

 // ---------- 2. payments ship disabled: nothing can be bought ----------
 let v=await view('ownerM',O.M.school);
 assert.deepEqual([v.purchase,v.checkout,v.purchased,v.paidAccessProgram,v.chargesEnabled,v.offerSetVersion],['UNAVAILABLE',null,null,'INACTIVE',false,1]);
 await deny(startOf('M',V1.OS_MONTHLY),422,'SAAS_PAYMENTS_NOT_ACTIVE');
 const enable={action:'ENABLE_TEST_MODE',expectedVersion:1,authorizationReference:'Fixture owner test-mode authorization (disposable)',provider:'STRIPE_SIMULATED',
  testTaxReference:'TEST MODE: no tax collected; TAXES undecided (fixture)'};
 assert.equal((await payments.setPaymentProgram(H('owner'),enable,K())).program.status,'TEST_MODE');

 // ---------- 3. discovery and refusals (server-decided eligibility) ----------
 v=await view('ownerM',O.M.school);
 assert.equal(v.purchase,'TEST_MODE');
 assert.deepEqual(v.offers.map(o=>[o.offerCode,o.eligibility,o.recurringBilling]),[['OS_MONTHLY','ELIGIBLE','MONTH'],['OS_ANNUAL','ELIGIBLE','YEAR'],
  ['OS_FOUNDER_MONTHLY','ELIGIBLE','MONTH'],['OS_FOUNDER_ANNUAL','ELIGIBLE','NONE'],['OS_LIFETIME','ELIGIBLE','NONE'],['OS_FOUNDER_LIFETIME','ELIGIBLE','NONE'],
  ['OS_PROMO','ELIGIBLE','MONTH'],['OS_ANNUAL_CURRENT','NOT_AVAILABLE_TERMS',null],['OS_SHORT','ELIGIBLE','MONTH']],'only offers on sale are listed; OS_LATER opens in 30 days');
 const sale0=Object.fromEntries((await billing.readOfferManagement(H('operator'))).honOsSales.offers.map(r=>[r.offerCode,r.saleStatus]));
 assert.deepEqual(sale0,{OS_MONTHLY:'ON_SALE',OS_ANNUAL:'ON_SALE',OS_FOUNDER_MONTHLY:'ON_SALE',OS_FOUNDER_ANNUAL:'ON_SALE',OS_LIFETIME:'ON_SALE',OS_FOUNDER_LIFETIME:'ON_SALE',
  OS_PROMO:'ON_SALE',OS_ANNUAL_CURRENT:'TERMS_UNSUPPORTED',OS_SHORT:'ON_SALE',OS_LATER:'NOT_ON_SALE'},'HQ sees that published repricing terms cannot be bought');
 assert.deepEqual(Object.values(await eligibility('C')).every(e=>e==='NOT_ELIGIBLE_ENTITLEMENT'||e==='NOT_AVAILABLE_TERMS'),true);
 assert.equal((await eligibility('G')).OS_MONTHLY,'NOT_ELIGIBLE_EXISTING_SUBSCRIPTION');
 await deny(startOf('C',V1.OS_MONTHLY),422,'SAAS_ENTITLEMENT_MISMATCH'); // a purchase never changes the entitlement
 await deny(startOf('E',V1.OS_MONTHLY),422,'SAAS_ENTITLEMENT_NOT_ACTIVE');
 await deny(startOf('G',V1.OS_MONTHLY),422,'SAAS_SUBSCRIPTION_EXISTS'); // legacy subscribers cannot switch yet (D7)
 await deny(startOf('M',V1.OS_ANNUAL_CURRENT),422,'SAAS_OFFER_TERMS_UNSUPPORTED'); // no automatic repricing (D4)
 await deny(startOf('M',V1.OS_LATER),422,'SAAS_OFFER_NOT_AVAILABLE');
 await deny(startOf('M',randomUUID()),422,'SAAS_OFFER_NOT_AVAILABLE');
 const draft2=await billing.createOfferSetDraft(H('owner'),{basedOnSetId:pub1.set.setId,termsReference:TERMS,founderTotalLimit:3,offers:offersV1()},K());
 await deny(startOf('M',draft2.set.offers[0].offerId),422,'SAAS_OFFER_NOT_AVAILABLE'); // unpublished draft
 await billing.discardOfferSetDraft(H('owner'),draft2.set.setId,{expectedRevision:draft2.set.revision},K());
 await deny(payments.startSchoolCheckout(H('ownerM'),O.M.school,{offerId:V1.OS_MONTHLY},K()),422,'SAAS_OFFER_NOT_AVAILABLE'); // the legacy path never sells HON OS
 for(const body of [{offerId:V1.OS_MONTHLY,priceMinor:100},{offerId:V1.OS_MONTHLY,offerKind:'LIFETIME'},{offerId:'OS_MONTHLY'},{}])
  await deny(payments.startSchoolHonOsCheckout(H('ownerM'),O.M.school,body,K()),400,'INVALID_SAAS_INPUT'); // the client sends only the offer ID
 for(const who of ['staffM','ownerA','owner','operator','support'])await deny(start(who,O.M.school,V1.OS_MONTHLY),403,'SAAS_FORBIDDEN');
 await deny(view('ownerA',O.M.school),403,'SAAS_FORBIDDEN');
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.saas_checkout_sessions')).rows[0].n,0,'refusals write nothing');

 // V opens a checkout on a promotion whose sales window closes before V pays (paid in section 9).
 const coV=await startOf('V',V1.OS_SHORT);
 assert.equal(Date.now()<SHORT_CLOSE,true,'fixture: the promotion is still on sale when V opens its checkout');

 // ---------- 4. regular monthly: hosted checkout, verified payment, accepted offer ----------
 const kM=K(),coM=await startOf('M',V1.OS_MONTHLY,kM);
 assert.deepEqual([coM.providerCall,coM.replayed,coM.checkout.status,coM.checkout.amountMinor,coM.checkout.offerKind,coM.checkout.billingInterval,coM.checkout.planCode,coM.checkout.offerId,coM.checkout.founderReservationId],
  ['OPENED',false,'OPEN',31700,'REGULAR_MONTHLY','MONTHLY','COMPLETE',V1.OS_MONTHLY,null]);
 assert.deepEqual(coM.purchase,{productName:'HON OS — Monthly',offerDisplayName:'Monthly',recurringBilling:'MONTH',offerSetVersion:1,termsReference:TERMS,
  acceptedOfferDigest:coM.purchase.acceptedOfferDigest});
 assert.deepEqual(form(coM.checkout.checkoutId),['subscription','31700','month','HON OS — Monthly']);
 const snapM=await snapshotOf(coM.checkout.checkoutId);
 assert.deepEqual(snapM.a,snapM.live,'the accepted offer is the published offer, exactly');
 assert.deepEqual([snapM.d,snapM.recomputed,coM.purchase.acceptedOfferDigest].every(d=>d===snapM.d&&/^[0-9a-f]{64}$/.test(d)),true);
 assert.deepEqual([snapM.a.priceMinor,snapM.a.offerKind,snapM.a.offerSetVersion,snapM.a.recurringBilling,snapM.a.termsReference,snapM.a.planCode,snapM.a.plannedMonthlyPremiumCredits,snapM.r,snapM.catalog_id,snapM.offer_id],
  [31700,'REGULAR_MONTHLY',1,'MONTH',TERMS,'COMPLETE',12000,'MONTH',null,null]);
 const replayM=await startOf('M',V1.OS_MONTHLY,kM);
 assert.deepEqual([replayM.replayed,replayM.providerCall,replayM.checkout.checkoutId],[true,'ALREADY_OPEN',coM.checkout.checkoutId]);
 assert.equal(sim.requests.filter(r=>r.path==='/v1/checkout/sessions').length,2,'a replay never opens a second provider session (V and M only)');
 await deny(startOf('M',V1.OS_MONTHLY,K()),422,'SAAS_CHECKOUT_OPEN');
 v=await view('ownerM',O.M.school);
 assert.deepEqual([v.checkout.checkoutId,v.checkout.checkoutUrl,v.offers.every(o=>o.eligibility==='CHECKOUT_IN_PROGRESS'||o.eligibility==='NOT_AVAILABLE_TERMS')],[coM.checkout.checkoutId,coM.checkout.checkoutUrl,true]);
 const paidM=await pay(coM);
 const subM=await subOf(O.M.id);
 assert.deepEqual([subM.source,subM.offerId,subM.catalogVersion,subM.planCode,subM.entitlementTier,subM.offerKind,subM.billingInterval,subM.priceMinor,subM.status,subM.paymentStatus,subM.currentPeriod.index,subM.premiumCredits],
  ['HON_OS_OFFER',V1.OS_MONTHLY,null,'COMPLETE','COMPLETE','REGULAR_MONTHLY','MONTHLY',31700,'IN_SERVICE','PAID',0,{plannedMonthlyAllowance:12000,status:'NOT_GRANTED'}]);
 const rowM=await subscriptionRow(O.M.id);
 assert.deepEqual([rowM.accepted_offer,rowM.accepted_offer_digest,rowM.offer_set_id,rowM.catalog_id],[snapM.a,snapM.d,pub1.set.setId,null],'the subscription carries the accepted offer verbatim');
 assert.equal(new Date(subM.currentPeriod.endsAt)-new Date(subM.currentPeriod.startsAt)>=28*DAY,true);
 assert.match((await invoiceLines(O.M.id))[0].description,/^HON OS — Monthly — service period \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
 v=await view('ownerM',O.M.school);
 assert.deepEqual([v.purchased.subscriptionId,v.purchased.offerId,v.purchased.priceMinor,v.purchased.recurringBilling,v.purchased.offerSetVersion,v.purchased.acceptedOfferDigest,v.purchased.status,v.checkout.status],
  [subM.subscriptionId,V1.OS_MONTHLY,31700,'MONTH',1,snapM.d,'IN_SERVICE','COMPLETED']);
 assert.equal(v.offers.every(o=>o.eligibility==='NOT_ELIGIBLE_EXISTING_SUBSCRIPTION'||o.eligibility==='NOT_AVAILABLE_TERMS'),true);
 await deny(startOf('M',V1.OS_ANNUAL),422,'SAAS_SUBSCRIPTION_EXISTS');
 assert.equal((await deliver(paidM.completed)).replayed,true,'a redelivered event is a replay');
 // Monthly renewal at the accepted price; a misaligned period or a different amount goes to HQ review.
 assert.deepEqual(await outcome(sim.renewal(paidM.subscription,Date.parse(subM.currentPeriod.endsAt)/1000,31700).delivery),['APPLIED','RENEWAL_RECORDED']);
 assert.equal((await subOf(O.M.id)).currentPeriod.index,1);
 const subM1=await subOf(O.M.id);
 assert.deepEqual(await outcome(sim.renewal(paidM.subscription,Date.parse(subM1.currentPeriod.endsAt)/1000+10*DAY/1000,31700).delivery),['NEEDS_REVIEW','PERIOD_MISMATCH']);
 assert.deepEqual(await outcome(sim.renewal(paidM.subscription,Date.parse(subM1.currentPeriod.endsAt)/1000,24900).delivery),['NEEDS_REVIEW','AMOUNT_MISMATCH']);

 // ---------- 5. regular annual (auto-renew at the locked price): yearly provider subscription, 12-month periods ----------
 const coA=await startOf('A',V1.OS_ANNUAL);
 assert.deepEqual([coA.checkout.billingInterval,coA.purchase.recurringBilling,...form(coA.checkout.checkoutId)],['ANNUAL','YEAR','subscription','317000','year','HON OS — Annual']);
 const paidA=await pay(coA);
 const subA=await subOf(O.A.id);
 assert.deepEqual([subA.billingInterval,subA.offerKind,subA.priceMinor,subA.currentPeriod.index,subA.paymentStatus],['ANNUAL','REGULAR_ANNUAL',317000,0,'PAID']);
 const startA=new Date(subA.currentPeriod.startsAt),endA=new Date(subA.currentPeriod.endsAt),plus12=new Date(startA);plus12.setUTCMonth(plus12.getUTCMonth()+12);
 assert.equal(endA.getTime(),plus12.getTime(),'an annual period is 12 months');
 const invA=await invoiceLines(O.A.id);
 assert.deepEqual([invA.length,invA[0].kind,invA[0].subtotal_minor,invA[0].service_period_end.getTime()],[1,'SUBSCRIPTION_PERIOD',317000,endA.getTime()]);
 const accountA=await schoolBilling.readAccount(H('ownerA'),O.A.school);
 assert.deepEqual([accountA.subscription.source,accountA.subscription.billingInterval,accountA.access.paidAccessProgram,accountA.payment.status,accountA.payment.verification,accountA.allowance.programStatus,accountA.allowance.plannedMonthlyCredits],
  ['HON_OS_OFFER','ANNUAL','INACTIVE','PAID','PROVIDER_VERIFIED','INACTIVE',12000],'the school billing account reads planned credits from the accepted offer; nothing is granted');
 // A monthly-length provider period never matches an annual subscription; the next annual period renews at the accepted price.
 assert.deepEqual(await outcome(sim.renewal(paidA.subscription,Date.parse(subA.currentPeriod.startsAt)/1000+31*DAY/1000,317000).delivery),['NEEDS_REVIEW','PERIOD_MISMATCH']);
 assert.deepEqual(await outcome(sim.renewal(paidA.subscription,endA.getTime()/1000,317000).delivery),['APPLIED','RENEWAL_RECORDED']);
 const subA1=await subOf(O.A.id),plus24=new Date(startA);plus24.setUTCMonth(plus24.getUTCMonth()+24);
 assert.deepEqual([subA1.currentPeriod.index,new Date(subA1.currentPeriod.endsAt).getTime()],[1,plus24.getTime()]);

 // ---------- 6. founder annual without auto-renewal and founder lifetime: one-time payments, no recurring obligation ----------
 await v1Gate(true);
 await deny(startOf('FA',V1.OS_FOUNDER_ANNUAL),422,'SAAS_OFFER_REQUIRES_SCHEDULE');
 await deny(startOf('FA',V1.OS_FOUNDER_LIFETIME),422,'SAAS_OFFER_REQUIRES_SCHEDULE');
 await deny(startOf('FA',V1.OS_FOUNDER_MONTHLY),422,'SAAS_OFFER_REQUIRES_SCHEDULE');
 await deny(startOf('FA',V1.OS_LIFETIME),422,'SAAS_OFFER_REQUIRES_SCHEDULE');
 await v1Gate(false);
 const coFA=await startOf('FA',V1.OS_FOUNDER_ANNUAL);
 assert.deepEqual([coFA.checkout.billingInterval,coFA.purchase.recurringBilling,...form(coFA.checkout.checkoutId)],['ANNUAL','NONE','payment','183000',null,'HON OS — Founder annual']);
 const paidFA=await pay(coFA);
 assert.equal(paidFA.subscription,null);
 const subFA=await subOf(O.FA.id);
 assert.deepEqual([subFA.offerKind,subFA.billingInterval,subFA.founderReservationId,subFA.currentPeriod.index,subFA.paymentStatus],['FOUNDER_ANNUAL','ANNUAL',null,0,'PAID']);
 assert.equal((await snapshotOf(coFA.checkout.checkoutId)).sref,null,'no provider subscription exists for a one-time annual term');
 const coFL=await startOf('FL',V1.OS_FOUNDER_LIFETIME);
 assert.deepEqual([coFL.checkout.billingInterval,coFL.purchase.recurringBilling,...form(coFL.checkout.checkoutId)],['LIFETIME','NONE','payment','640000',null,'HON OS — Founder lifetime']);
 const paidFL=await pay(coFL);
 const subFL=await subOf(O.FL.id);
 assert.deepEqual([subFL.offerKind,subFL.billingInterval,subFL.currentPeriod?.index??null,subFL.currentPeriod?.endsAt??null,subFL.paymentStatus],['FOUNDER_LIFETIME','LIFETIME',null,null,'PAID']);
 const invFL=await invoiceLines(O.FL.id);
 assert.deepEqual([invFL.length,invFL[0].kind,invFL[0].description],[1,'LIFETIME_PURCHASE','HON OS — Founder lifetime — one-time purchase']);
 assert.equal((await snapshotOf(coFL.checkout.checkoutId)).sref,null);

 // ---------- 7. the one HON OS founder pool (limit 4) under contention; cancellation returns the slot ----------
 let mgmt=await billing.readOfferManagement(H('operator'));
 assert.deepEqual(mgmt.honOsSales.founderPool,{limit:4,allocated:2,held:0,remaining:2});
 // FM3 holds a founder slot and pays only after HQ lowers the founder cap (section 9b).
 const coFM3=await startOf('FM3',V1.OS_FOUNDER_MONTHLY);
 const race=await Promise.allSettled(['FM1','FM2'].map(k=>startOf(k,V1.OS_FOUNDER_MONTHLY)));
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1,'exactly one school holds the last founder slot');
 const winner=race[0].status==='fulfilled'?'FM1':'FM2',loser=winner==='FM1'?'FM2':'FM1',coWin=race.find(r=>r.status==='fulfilled').value;
 http(422,'SAAS_FOUNDER_SOLD_OUT')(race.find(r=>r.status==='rejected').reason);
 assert.equal((await eligibility('X')).OS_FOUNDER_MONTHLY,'FOUNDER_SOLD_OUT');
 assert.equal((await eligibility('X')).OS_FOUNDER_LIFETIME,'FOUNDER_SOLD_OUT');
 assert.deepEqual((await billing.readOfferManagement(H('operator'))).honOsSales.founderPool,{limit:4,allocated:2,held:2,remaining:0});
 await deny(payments.cancelCheckout(H(`owner${loser}`),coWin.checkout.checkoutId,{expectedVersion:coWin.checkout.version},K()),403,'SAAS_FORBIDDEN');
 const cancelled=await payments.cancelCheckout(H(`owner${winner}`),coWin.checkout.checkoutId,{expectedVersion:coWin.checkout.version},K());
 assert.deepEqual([cancelled.checkout.status,cancelled.providerExpiry],['CANCELLED','REQUESTED']);
 assert.equal((await eligibility('X')).OS_FOUNDER_MONTHLY,'ELIGIBLE','a cancelled hold returns its slot');
 const coLoser=await startOf(loser,V1.OS_FOUNDER_MONTHLY);
 assert.deepEqual(form(coLoser.checkout.checkoutId),['subscription','18300','month','HON OS — Founder monthly']);
 await pay(coLoser);
 assert.deepEqual((await billing.readOfferManagement(H('operator'))).honOsSales.founderPool,{limit:4,allocated:3,held:1,remaining:0});
 await deny(startOf(winner,V1.OS_FOUNDER_MONTHLY),422,'SAAS_FOUNDER_SOLD_OUT');
 await deny(startOf(winner,V1.OS_FOUNDER_LIFETIME),422,'SAAS_FOUNDER_SOLD_OUT');
 await deny(startOf('X',V1.OS_FOUNDER_ANNUAL),422,'SAAS_FOUNDER_SOLD_OUT');

 // ---------- 8. regular lifetime with a sale limit of 1, under contention ----------
 const lifeRace=await Promise.allSettled(['L','L2'].map(k=>startOf(k,V1.OS_LIFETIME)));
 assert.equal(lifeRace.filter(r=>r.status==='fulfilled').length,1,'the sale limit admits exactly one live checkout');
 http(422,'SAAS_OFFER_SOLD_OUT')(lifeRace.find(r=>r.status==='rejected').reason);
 const lifeWinner=lifeRace[0].status==='fulfilled'?'L':'L2',coL=lifeRace.find(r=>r.status==='fulfilled').value;
 assert.deepEqual([coL.checkout.offerKind,coL.checkout.billingInterval,...form(coL.checkout.checkoutId)],['LIFETIME','LIFETIME','payment','950000',null,'HON OS — Lifetime']);
 const paidL=await pay(coL);
 const lifeLoser=lifeWinner==='L'?'L2':'L';
 assert.equal((await eligibility(lifeLoser)).OS_LIFETIME,'SOLD_OUT');
 await deny(startOf(lifeLoser,V1.OS_LIFETIME),422,'SAAS_OFFER_SOLD_OUT');
 const L=O[lifeWinner];

 // ---------- 9. payments that do not match the accepted offer go to HQ review, never activation ----------
 const coX=await startOf('X',V1.OS_ANNUAL);
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coX),{amount:100}).completed),['NEEDS_REVIEW','AMOUNT_MISMATCH']);
 // A recurring offer paid without a provider subscription (or the reverse) is never activated.
 const coR=await startOf('R',V1.OS_MONTHLY);
 const crafted=JSON.parse(sim.completeCheckout(sessionOf(coR)).completed.raw.toString());
 crafted.id=`evt_crafted${randomUUID().replaceAll('-','').slice(0,12)}`;crafted.data.object.subscription=null;crafted.data.object.invoice=null;
 assert.deepEqual(await outcome(sim.sign(crafted)),['NEEDS_REVIEW','RECURRING_MISMATCH']);
 // Sales stopped after the checkout opened, before payment (D6).
 const coY=await startOf('Y',V1.OS_PROMO);
 await billing.stopOfferSales(H('owner'),V1.OS_PROMO,{reasonCode:'OWNER_DISABLED'},K());
 await pause(1100); // provider event timestamps have whole-second precision
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coY)).completed),['NEEDS_REVIEW','OFFER_SALES_STOPPED']);
 await deny(startOf('W',V1.OS_PROMO),422,'SAAS_OFFER_NOT_AVAILABLE');
 // Expiry: a checkout the provider expired, or one past its validity window that no sweep has closed yet, is never activated.
 const coT=await startOf('T',V1.OS_MONTHLY);
 assert.deepEqual(await outcome(sim.expire(sessionOf(coT))),['APPLIED','CHECKOUT_EXPIRED']);
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coT)).completed),['NEEDS_REVIEW','PAID_AFTER_CLOSE']);
 const coU=await startOf('U',V1.OS_MONTHLY);
 await admin.query('BEGIN');await admin.query('ALTER TABLE hon.saas_checkout_sessions DISABLE TRIGGER USER');
 await admin.query("UPDATE hon.saas_checkout_sessions SET expires_at=created_at+interval '1 second' WHERE id=$1",[coU.checkout.checkoutId]);
 await admin.query('ALTER TABLE hon.saas_checkout_sessions ENABLE TRIGGER USER');await admin.query('COMMIT');
 await pause(2100);
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coU)).completed),['NEEDS_REVIEW','PAID_AFTER_CLOSE']);

 // ---------- 9b. routine price replacement vs explicit stop-sales (owner decision D6, revised) ----------
 // Z and Q open checkouts on version 1. HQ then publishes version 3 (version 2 was the discarded draft) with new prices and
 // new offer IDs. A routine replacement keeps both checkouts valid at their accepted version-1 terms; HQ then explicitly
 // stops Q's retired offer, which sends Q's payment to review. Z keeps the accepted price.
 const coZ=await startOf('Z',V1.OS_MONTHLY),coQ=await startOf('Q',V1.OS_ANNUAL);
 const d2=await billing.createOfferSetDraft(H('owner'),{basedOnSetId:pub1.set.setId,termsReference:'Fixture HON OS terms v2 (not customer terms)',founderTotalLimit:3,
  offers:[offer('OS_MONTHLY','REGULAR_MONTHLY',34900,'Monthly'),offer('OS_ANNUAL','REGULAR_ANNUAL',349000,'Annual'),offer('OS_FOUNDER_MONTHLY','FOUNDER_MONTHLY',18300,'Founder monthly',{eligibility:'NEW_ORGANIZATIONS_ONLY'}),
   offer('OS_LIFETIME','LIFETIME',990000,'Lifetime',{saleLimit:10})]},K());
 const pub2=await billing.publishOfferSet(H('owner'),d2.set.setId,{expectedRevision:d2.set.revision,previewDigest:d2.preview.previewDigest,approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K());
 assert.equal(pub2.retiredSetId,pub1.set.setId);
 const V2=Object.fromEntries(pub2.set.offers.map(o=>[o.offerCode,o.offerId]));
 // An emergency stop is possible on a retired offer only while it has a live checkout.
 await deny(billing.stopOfferSales(H('owner'),V1.OS_FOUNDER_LIFETIME,{reasonCode:'OWNER_DISABLED'},K()),422,'SAAS_OFFER_NOT_PUBLISHED');
 await deny(billing.stopOfferSales(H('operator'),V1.OS_ANNUAL,{reasonCode:'OWNER_DISABLED'},K()),403,'SAAS_FORBIDDEN');
 const stopQ=await billing.stopOfferSales(H('owner'),V1.OS_ANNUAL,{reasonCode:'TERMS_REVIEW'},K());
 assert.equal(stopQ.offer.salesStop.reasonCode,'TERMS_REVIEW');
 await pause(1100); // provider event timestamps have whole-second precision
 const paidZ=sim.completeCheckout(sessionOf(coZ));
 assert.deepEqual(await outcome(paidZ.completed),['APPLIED','SUBSCRIPTION_ACTIVATED'],'a routine price replacement never blocks a valid checkout');
 assert.deepEqual(await outcome(paidZ.firstInvoice),['ALREADY_APPLIED','FIRST_INVOICE_COVERED_BY_CHECKOUT']);
 const subZ=await subOf(O.Z.id),rowZ=await subscriptionRow(O.Z.id);
 assert.deepEqual([subZ.priceMinor,subZ.offerId,rowZ.offer_set_id,rowZ.accepted_offer.offerSetVersion,rowZ.accepted_offer.priceMinor,rowZ.accepted_offer_digest],
  [31700,V1.OS_MONTHLY,pub1.set.setId,1,31700,(await snapshotOf(coZ.checkout.checkoutId)).d],'Z keeps the exact version-1 terms it accepted');
 const replayZ=await deliver(paidZ.completed);
 assert.deepEqual([replayZ.replayed,(await admin.query('SELECT count(*)::int n FROM hon.saas_subscriptions WHERE organization_id=$1',[O.Z.id])).rows[0].n],[true,1],'a replayed payment never creates a second subscription');
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coQ)).completed),['NEEDS_REVIEW','OFFER_SALES_STOPPED'],'an explicit stop-sales still applies');
 // Version 3 lowered the founder cap to 3 while 4 founder slots were committed (3 allocated + FM3's open hold). A held slot is
 // contractual: FM3's payment activates against the cap it accepted under, and lowering the cap never revokes it.
 assert.deepEqual((await billing.readOfferManagement(H('operator'))).honOsSales.founderPool,{limit:3,allocated:3,held:1,remaining:0});
 await pay(coFM3);
 const rowFM3=await subscriptionRow(O.FM3.id);
 assert.deepEqual([rowFM3.offer_kind,rowFM3.price_minor,rowFM3.accepted_offer.offerSetVersion],['FOUNDER_MONTHLY',18300,1]);
 assert.deepEqual((await billing.readOfferManagement(H('operator'))).honOsSales.founderPool,{limit:3,allocated:4,held:0,remaining:0});
 await deny(startOf('N',V2.OS_FOUNDER_MONTHLY),422,'SAAS_FOUNDER_SOLD_OUT');
 // Defensive recheck: HQ moves N from COMPLETE to CORE (the real 0146 transition) between checkout and payment, so the
 // HON OS payment no longer matches the access it was bought under and goes to review instead of activating.
 const coN=await startOf('N',V2.OS_MONTHLY);
 const entN0=await row('SELECT tier::text,version FROM hon.organization_entitlements WHERE organization_id=$1',[O.N.id]);
 await hqEntitlement.transition(H('owner'),O.N.id,{targetTier:'CORE',expectedVersion:entN0.version},K());
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coN)).completed),['NEEDS_REVIEW','ENTITLEMENT_CHANGED']);
 assert.deepEqual(await row('SELECT tier::text,status::text,version FROM hon.organization_entitlements WHERE organization_id=$1',[O.N.id]),
  {tier:'CORE',status:'ACTIVE',version:entN0.version+1},'the review never changes the entitlement HQ set');
 // V's promotion window has closed meanwhile: its accepted terms are honored, and new checkouts are refused.
 if(Date.now()<=SHORT_CLOSE+1000)await pause(SHORT_CLOSE+1100-Date.now());
 await deny(startOf('W',V1.OS_SHORT),422,'SAAS_OFFER_NOT_AVAILABLE');
 const paidV=sim.completeCheckout(sessionOf(coV));
 assert.deepEqual(await outcome(paidV.completed),['APPLIED','SUBSCRIPTION_ACTIVATED'],'a sales window that closes during a valid checkout does not block it');
 assert.equal((await subOf(O.V.id)).priceMinor,30500);
 // Provider verification: unsigned, tampered and live-mode deliveries never reach the database.
 const paidLate=sim.completeCheckout(sessionOf(coQ));
 await deny(payments.handleWebhook(paidLate.completed.raw,undefined),400,'INVALID_WEBHOOK');
 await deny(payments.handleWebhook(Buffer.from(paidLate.completed.raw.toString().replace('"amount_total":317000','"amount_total":100')),paidLate.completed.signature),400,'INVALID_WEBHOOK');
 const live=sim.liveEvent();await deny(payments.handleWebhook(live.raw,live.signature),400,'INVALID_WEBHOOK');
 const review=(await payments.readPayments(H('operator')));
 assert.deepEqual(['X','R','Y','T','U','Q','N'].map(k=>review.checkouts.find(c=>c.organizationId===O[k].id)).map(c=>[c.status,c.statusReason]),
  [['PAID_NEEDS_REVIEW','AMOUNT_MISMATCH'],['PAID_NEEDS_REVIEW','RECURRING_MISMATCH'],['PAID_NEEDS_REVIEW','OFFER_SALES_STOPPED'],['PAID_NEEDS_REVIEW','PAID_AFTER_CLOSE'],
   ['PAID_NEEDS_REVIEW','PAID_AFTER_CLOSE'],['PAID_NEEDS_REVIEW','OFFER_SALES_STOPPED'],['PAID_NEEDS_REVIEW','ENTITLEMENT_CHANGED']]);
 assert.equal(review.reconciliation.paidNeedsReview,7);
 for(const k of ['X','R','Y','T','U','Q','N'])assert.equal(await subOf(O[k].id),null,'review never creates a subscription');

 // ---------- 10. price changes affect new purchases only ----------
 await deny(startOf('W',V1.OS_MONTHLY),422,'SAAS_OFFER_NOT_AVAILABLE'); // retired offer
 v=await view('ownerW',O.W.school);
 assert.deepEqual([v.offerSetVersion,...v.offers.map(o=>[o.offerCode,o.priceMinor,o.eligibility])],[3,['OS_MONTHLY',34900,'ELIGIBLE'],['OS_ANNUAL',349000,'ELIGIBLE'],
  ['OS_FOUNDER_MONTHLY',18300,'FOUNDER_SOLD_OUT'],['OS_LIFETIME',990000,'ELIGIBLE']],'the founder pool is cumulative across set versions (D1)');
 // M keeps its accepted v1 price: the next renewal at 31,700 applies, and 34,900 goes to review.
 const subM2=await subOf(O.M.id);
 assert.deepEqual(await outcome(sim.renewal(paidM.subscription,Date.parse(subM2.currentPeriod.endsAt)/1000,34900).delivery),['NEEDS_REVIEW','AMOUNT_MISMATCH']);
 assert.deepEqual(await outcome(sim.renewal(paidM.subscription,Date.parse(subM2.currentPeriod.endsAt)/1000,31700).delivery),['APPLIED','RENEWAL_RECORDED']);
 assert.deepEqual([(await subOf(O.M.id)).priceMinor,(await subscriptionRow(O.M.id)).accepted_offer],[31700,snapM.a]);
 const coW=await startOf('W',V2.OS_MONTHLY);
 assert.deepEqual([coW.checkout.amountMinor,coW.purchase.offerSetVersion,(await snapshotOf(coW.checkout.checkoutId)).a.priceMinor],[34900,3,34900]);
 await pay(coW);

 // ---------- 11. refund windows from the accepted offer; provider refunds and disputes reconcile ----------
 const elig=async org=>billing.readRefundEligibility(H('operator'),org,{});
 const eFA=await elig(O.FA.id),eL=await elig(L.id),eM=await elig(O.M.id);
 assert.deepEqual([eFA.eligible,eFA.offerKind,Date.parse(eFA.windowEndsAt)-Date.parse(eFA.firstPaidAt)],[true,'FOUNDER_ANNUAL',14*DAY]);
 assert.deepEqual([eL.eligible,eL.offerKind,Date.parse(eL.windowEndsAt)-Date.parse(eL.firstPaidAt),eL.refundableMinor],[true,'LIFETIME',7*DAY,950000]);
 assert.deepEqual([eM.offerKind,Date.parse(eM.windowEndsAt)-Date.parse(eM.firstPaidAt)],['REGULAR_MONTHLY',30*DAY]);
 assert.equal((await billing.readRefundReserve(H('operator'))).windowExposure.paidLifetimeMinor,950000+640000,'both lifetime kinds count as paid-lifetime refund exposure');
 assert.deepEqual(await outcome(sim.refund(paidFL.paymentIntent,null,640000,paidFL.charge)),['APPLIED','REFUND_RECORDED']);
 assert.equal((await subOf(O.FL.id)).paymentStatus,'REFUNDED');
 assert.deepEqual(await outcome(sim.dispute(paidL.paymentIntent,950000,paidL.charge)),['APPLIED','CHARGEBACK_RECORDED']);
 assert.equal((await subOf(L.id)).paymentStatus,'DISPUTED');
 assert.equal((await billing.readRefundReserve(H('operator'))).windowExposure.paidLifetimeMinor,0,'refunded and disputed lifetime purchases leave no exposure');
 // A returning organization is not a new organization: simulated (rolled back) by voiding FL's paid record, which no command can do today.
 await admin.query('BEGIN');
 try{await admin.query('ALTER TABLE hon.saas_subscriptions DISABLE TRIGGER USER');
  await admin.query("UPDATE hon.saas_subscriptions SET status='VOIDED',status_reason='RECORDED_IN_ERROR',version=version+1,service_started_at=NULL,period_anchor_at=NULL,period_index=NULL,current_period_start=NULL,current_period_end=NULL WHERE organization_id=$1",[O.FL.id]);
  const refusal=async id=>(await admin.query('SELECT hon.saas_hon_os_refusal($1,o,clock_timestamp()) r FROM hon.saas_offer_set_offers o WHERE o.id=$2',[O.FL.id,id])).rows[0].r;
  assert.deepEqual([await refusal(V2.OS_FOUNDER_MONTHLY),await refusal(V2.OS_MONTHLY)],['SAAS_OFFER_NOT_ELIGIBLE',null]);}
 finally{await admin.query('ROLLBACK');}

 // ---------- 12. HQ sales view, ledgers and no unintended effect ----------
 mgmt=await billing.readOfferManagement(H('operator'));
 assert.deepEqual([mgmt.purchase,mgmt.paidAccessProgram,mgmt.chargesEnabled,mgmt.creditGrantsEnabled],['TEST_MODE','INACTIVE',false,false]);
 const sales=Object.fromEntries(mgmt.honOsSales.offers.filter(r=>r.subscriptions+r.openCheckouts+r.paidNeedsReview>0).map(r=>[`${r.setVersion}:${r.offerCode}`,[r.subscriptions,r.openCheckouts,r.paidNeedsReview,r.saleLimit]]));
 assert.equal(mgmt.honOsSales.offers.length,12,'the published set (4) and every retired offer that had a checkout (8)');
 assert.equal(mgmt.honOsSales.offers.every(r=>r.saleStatus===(r.setVersion===3?'ON_SALE':'NOT_ON_SALE')),true,'retired offers are never shown as on sale');
 assert.deepEqual(sales,{'1:OS_MONTHLY':[2,0,3,null],'1:OS_ANNUAL':[1,0,2,null],'1:OS_FOUNDER_MONTHLY':[2,0,0,null],'1:OS_FOUNDER_ANNUAL':[1,0,0,null],'1:OS_FOUNDER_LIFETIME':[1,0,0,5],
  '1:OS_LIFETIME':[1,0,0,1],'1:OS_PROMO':[0,0,1,null],'1:OS_SHORT':[1,0,0,null],'3:OS_MONTHLY':[1,0,1,null]});
 assert.deepEqual(mgmt.honOsSales.founderPool,{limit:3,allocated:4,held:0,remaining:0},'commitments above a lowered cap are kept, never revoked');
 const hon=(await admin.query("SELECT offer_kind,billing_interval,count(*)::int n FROM hon.saas_subscriptions WHERE source='HON_OS_OFFER' AND status<>'VOIDED' GROUP BY 1,2 ORDER BY 1")).rows.map(r=>[r.offer_kind,r.billing_interval,r.n]);
 assert.deepEqual(hon,[['FOUNDER_ANNUAL','ANNUAL',1],['FOUNDER_LIFETIME','LIFETIME',1],['FOUNDER_MONTHLY','MONTHLY',2],['LIFETIME','LIFETIME',1],['REGULAR_ANNUAL','ANNUAL',1],['REGULAR_MONTHLY','MONTHLY',4]]);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_checkout_sessions WHERE hon_os_offer_id IS NOT NULL AND provider_recurring='NONE' AND provider_subscription_ref IS NOT NULL")).rows[0].n,0,
  'no one-time purchase has a provider subscription');
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_subscriptions s JOIN hon.saas_checkout_sessions c ON c.subscription_id=s.id WHERE s.accepted_offer<>c.accepted_offer OR s.accepted_offer_digest<>c.accepted_offer_digest OR s.price_minor<>(s.accepted_offer->>'priceMinor')::int")).rows[0].n,0);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_audit a JOIN hon.saas_outbox o ON o.audit_id=a.id WHERE a.action_code='saas.checkout.create_hon_os' AND o.event_type='saas.checkout.created'")).rows[0].n,
  (await admin.query('SELECT count(*)::int n FROM hon.saas_checkout_sessions WHERE hon_os_offer_id IS NOT NULL')).rows[0].n,'every HON OS checkout has one audit row and one outbox event');
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_payment_evidence WHERE source='PROVIDER_VERIFIED' AND organization_id=ANY($1::uuid[])",[fixtureOrgs()])).rows[0].n>=8,true);
 const after=await untouched();
 for(const t of Object.keys(before))assert.deepEqual(after[t],before[t],`${t} unchanged`);
 assert.deepEqual((await admin.query("SELECT to_jsonb(s)::text r FROM hon.saas_subscriptions s WHERE source<>'HON_OS_OFFER' ORDER BY 1")).rows,legacyBefore,'legacy subscriptions unchanged');
 // Published offers are still immutable snapshots after being sold.
 await sqlDeny(admin.query('UPDATE hon.saas_offer_set_offers SET price_minor=100 WHERE id=$1',[V1.OS_MONTHLY]));
 // A tampered accepted offer is refused by the database.
 await admin.query('BEGIN');
 try{await admin.query('ALTER TABLE hon.saas_subscriptions DISABLE TRIGGER USER');
  await sqlDeny(admin.query(`UPDATE hon.saas_subscriptions SET accepted_offer=jsonb_set(accepted_offer,'{priceMinor}','100') WHERE organization_id=$1`,[O.M.id]),'23514');}
 finally{await admin.query('ROLLBACK');}
 await v1Gate(true);
 assert.equal((await admin.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='hon.saas_checkout_sessions'::regclass AND tgname='saas_hon_os_v1_offer_kind'")).rows[0].tgenabled,'O','0237 v1 founder/lifetime refusal restored');
 console.log(`PASS: HON OS purchase binding (0182) proof (TEST MODE, SIMULATED Stripe) — six HQ-published offer kinds bought end to end through the real adapter at the exact accepted offer (snapshot + SHA-256 digest on checkout, subscription and invoice); monthly and annual renewals at the accepted price only (period and amount mismatches to review); one-time annual and lifetime purchases with no provider subscription; unpublished, future, stopped, retired, unsupported-terms, ineligible and sold-out offers refused; sale limit and cumulative founder pool atomic under contention, cancellation returns the slot, a founder hold is honored after HQ lowers the cap; entitlement lapse before payment goes to review; a routine price change or closed sales window during an open checkout honors the accepted terms, while explicit stop-sales (including on a retired offer), expiry, amount and recurring mismatches go to HQ review; payment replay and unsigned, tampered or live deliveries refused; refund windows from the accepted offer; refunds and disputes reconciled; price change affects new purchases only; entitlements, legacy records, credits and paid access unchanged.`);
}finally{
 await v1Gate(true).catch(()=>{});
 await setLegacySales(admin,false).catch(e=>console.error('RESTORE FAILED',e));
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end()]);}
}
