import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setLegacySales, assertLegacySalesClosed } from './saas-legacy-sales-simulation.mjs';
import { activatePreD9ProvisionedSchool } from './pre-d9-provisioning-simulation.mjs';
// HON OS-only new-customer sales (0184, owner decision D8) integrity proof, TEST MODE, SIMULATED PROVIDER, disposable
// database only. Legacy Core/Complete new sales ship CLOSED (CHECK legacy_new_sales = 'CLOSED'); this proof reopens them
// only to build the pre-closure world (legacy customers, stale checkout links, a payment held while paid access was
// inactive), closes them again exactly as shipped and then proves: no path sells a legacy plan to anyone (school and HQ
// checkout, replayed pre-closure keys, provider sessions on pre-closure checkouts, HQ subscription records and founder
// reservations, direct writes), a stale legacy payment is held for HQ review and never activates, new customers buy only
// HQ-published HON OS offers (directly, or through the D7 first-payment path with founder and sale limits), and legacy
// customers keep renewals, refunds, disputes, lifecycle commands and lifetime rights. Paid access ACTIVE is simulated
// here only for the awaiting-payment cases and restored before the proof ends.
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
const {HqOnboardingService}=await import('../../../apps/api/dist/hq/hq-onboarding.service.js');
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
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions',
 'saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code,message)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);if(message)assert.equal(e.message,message);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
// Pre-closure legacy customers: L1 Core regular monthly (renewal, refund, lifecycle), L2 Complete founder lifetime (dispute).
// Pre-closure stale links: ST Core open checkout, SF Complete founder monthly open checkout (holds a legacy founder slot),
// SC Core checkout whose provider outcome was unknown (still CREATED). AW: awaiting its first payment, paid a legacy
// checkout while paid access was inactive (held for an HQ retry). New customers after the closure: NC and NF provisioned
// Complete schools, and N registered through HQ provisioning (Core).
const O=Object.fromEntries(['L1','L2','ST','SF','SC','AW','NC','NF'].map(k=>[k,{id:randomUUID(),tier:['L1','ST','SC'].includes(k)?'CORE':'COMPLETE',school:randomUUID(),role:randomUUID()}]));
const humans=Object.fromEntries(['owner','operator','support','ownerN',...Object.keys(O).map(k=>`owner${k}`)].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`d8-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
const N={};
const fixtureOrgs=()=>[...Object.values(O).map(o=>o.id),...(N.id?[N.id]:[])];
let createdProvider=false,programTouched=false;
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
async function withoutGuards(tables,sqls){
 await admin.query('BEGIN');
 try{for(const t of tables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);for(const[sql,params]of sqls)await admin.query(sql,params);
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);await admin.query('COMMIT');}
 catch(e){await admin.query('ROLLBACK');throw e;}
}
// A direct write with only the 0184 guard left enabled on that table: the guard alone refuses it.
async function guardRefuses(table,sql,params){
 await admin.query('BEGIN');
 try{
  for(const t of (await admin.query("SELECT tgname FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal AND tgname<>'saas_legacy_new_sale'",[`hon.${table}`])).rows)
   await admin.query(`ALTER TABLE hon.${table} DISABLE TRIGGER ${t.tgname}`);
  await sqlDeny(admin.query(sql,params),'23514','SAAS_LEGACY_SALES_CLOSED');
 }finally{await admin.query('ROLLBACK');}
}
async function untouched(){const out={};for(const t of ['organization_entitlements','billing_accounts','memberships','invoices','payment_attempts','champions_reward_entries','ai_usage_ledger'])
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
  if(createdProvider)await admin.query("DELETE FROM hon.hq_ai_provider_connections WHERE provider_id='HIGGSFIELD'");
  // N, registered through HQ provisioning, keeps append-only platform audit rows; it stays in the disposable database.
  const orgs=Object.values(O).map(o=>o.id);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const deliver=d=>payments.handleWebhook(d.raw,d.signature);
const outcome=async d=>{const r=await deliver(d);return [r.event.outcome,r.event.detail];};
const options=(k,school=O[k].school)=>payments.readPlanOptions(H(`owner${k}`),school);
const start=(k,offerId,key=K(),school=O[k].school)=>payments.startSchoolCheckout(H(`owner${k}`),school,{offerId},key);
const startOs=(k,offerId,key=K(),school=O[k]?.school??N.school)=>payments.startSchoolHonOsCheckout(H(`owner${k}`),school,{offerId},key);
const sessionOf=r=>r.checkout.providerSessionId;
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const ent=async o=>row('SELECT tier::text,status::text,version FROM hon.organization_entitlements WHERE organization_id=$1',[o]);
const checkoutRow=async id=>row('SELECT status,status_reason,version,subscription_id FROM hon.saas_checkout_sessions WHERE id=$1',[id]);
const subscriptions=async o=>(await admin.query('SELECT source,plan_code,offer_kind,billing_interval,status,period_index FROM hon.saas_subscriptions WHERE organization_id=$1 ORDER BY created_at',[o])).rows;
const checkoutCount=async o=>(await row('SELECT count(*)::int n FROM hon.saas_checkout_sessions WHERE organization_id=$1',[o])).n;
const transitions=async o=>(await admin.query('SELECT kind,outcome,reason FROM hon.saas_access_transitions WHERE organization_id=$1 ORDER BY occurred_at,id',[o])).rows.map(r=>`${r.kind}:${r.outcome}:${r.reason}`);
const legacyFounder=async()=>(await admin.query('SELECT status,count(*)::int n FROM hon.saas_founder_reservations GROUP BY 1 ORDER BY 1')).rows;
const offerOf=(opts,kind)=>opts.offers.find(o=>o.offerKind===kind).offerId;
const subOf=async org=>(await billing.readOrganizationSubscription(H('operator'),org)).current;
const providerCalls=()=>sim.requests.filter(r=>r.path==='/v1/checkout/sessions').length;
// Every HON OS price and term below is fixture data chosen by "HQ" in this proof, not a constant in the product.
const osOffer=(code,kind,priceMinor,displayName,patch={})=>{const interval=contracts.saasHonOsOfferBillingInterval(kind);return{offerCode:code,offerKind:kind,displayName,priceMinor,
 salesOpensAt:iso(NOW-HOUR),salesClosesAt:null,eligibility:'ANY_ACTIVE_ORGANIZATION',saleLimit:interval==='ONE_TIME'?25:null,
 priceLock:interval==='ONE_TIME'?'NONE':'WHILE_CONTINUOUSLY_SUBSCRIBED',priceLockMonths:null,annualRenewal:interval==='ANNUAL'?'AUTO_RENEW_AT_LOCKED_PRICE':null,
 plannedMonthlyPremiumCredits:12000,aiFairUseReference:interval==='ONE_TIME'?'Fixture lifetime AI fair-use policy v1':null,refundWindowDays:30,
 cancellationTiming:interval==='ONE_TIME'?null:'END_OF_PAID_PERIOD',...patch};};

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- 0. shipped posture: legacy new sales pinned CLOSED, HON OS the only new-sale product, private and immutable ----------
 await assertLegacySalesClosed(admin);
 assert.deepEqual((await admin.query('SELECT new_sale_product,legacy_new_sales,source_reference FROM hon.saas_new_sales_policy')).rows,
  [{new_sale_product:'HON_OS',legacy_new_sales:'CLOSED',source_reference:'OWNER_DIRECTION_2026_10_23_D8'}]);
 await sqlDeny(restricted.query('SELECT * FROM hon.saas_new_sales_policy'),'42501');
 for(const sig of ['saas_legacy_new_sales_open()','guard_saas_legacy_new_sale()'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);
 await sqlDeny(admin.query("UPDATE hon.saas_new_sales_policy SET legacy_new_sales='CLOSED'"),'42501','IMMUTABLE_SAAS_EVIDENCE');
 await sqlDeny(admin.query('DELETE FROM hon.saas_new_sales_policy'),'42501','IMMUTABLE_SAAS_EVIDENCE');
 await admin.query('BEGIN');
 try{await admin.query('ALTER TABLE hon.saas_new_sales_policy DISABLE TRIGGER USER');
  await sqlDeny(admin.query("UPDATE hon.saas_new_sales_policy SET legacy_new_sales='OPEN'"),'23514');}finally{await admin.query('ROLLBACK');}
 await cleanup();

 // ---------- fixture: identities, schools, the legacy catalog and the HON OS offer set ----------
 // The pre-closure world is built with legacy sales reopened in this disposable database only.
 await setLegacySales(admin,true);
 await admin.query('BEGIN');
 if((await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state) VALUES('HIGGSFIELD','Fixture provider','DISABLED') ON CONFLICT DO NOTHING RETURNING provider_id")).rowCount)createdProvider=true;
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[who,hqRole,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['support','HON_HQ_SUPPORT',['hq.billing.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,hqRole,perms]);
 for(const[k,o]of Object.entries(O)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o.id,`D8 Fixture Dojo ${k}`]);
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
 // One HON OS founder slot and one lifetime sale, so the limits can be exhausted by new customers.
 const pub=await billing.publishOfferSet(H('owner'),...await(async()=>{const dr=await billing.createOfferSetDraft(H('owner'),{basedOnSetId:null,
  termsReference:'Fixture HON OS terms v1 (not customer terms)',founderTotalLimit:1,offers:[osOffer('OS_MONTHLY','REGULAR_MONTHLY',31700,'Monthly'),
   osOffer('OS_FOUNDER_MONTHLY','FOUNDER_MONTHLY',18300,'Founder monthly',{eligibility:'NEW_ORGANIZATIONS_ONLY'}),
   osOffer('OS_LIFETIME','LIFETIME',950000,'Lifetime',{saleLimit:1,refundWindowDays:7})]},K());
  return[dr.set.setId,{expectedRevision:dr.set.revision,previewDigest:dr.preview.previewDigest,approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K()];})());
 const V=Object.fromEntries(pub.set.offers.map(o=>[o.offerCode,o.offerId]));
 const before=await untouched();

 // ---------- 1. before the closure: legacy customers, stale links and a held payment ----------
 const coreOpts=await options('L1'),completeOpts=await options('L2');
 const legacyOffers=[...coreOpts.offers,...completeOpts.offers].map(o=>o.offerId);
 assert.equal(legacyOffers.length,6,'Core and Complete regular, founder monthly and founder lifetime');
 const coL1=await start('L1',offerOf(coreOpts,'REGULAR_MONTHLY'));
 const paidL1=sim.completeCheckout(sessionOf(coL1));
 assert.deepEqual(await outcome(paidL1.completed),['APPLIED','SUBSCRIPTION_ACTIVATED']);
 const coL2=await start('L2',offerOf(completeOpts,'FOUNDER_LIFETIME'));
 const paidL2=sim.completeCheckout(sessionOf(coL2));
 assert.deepEqual(await outcome(paidL2.completed),['APPLIED','SUBSCRIPTION_ACTIVATED']);
 const coST=await start('ST',offerOf(coreOpts,'REGULAR_MONTHLY'));
 const coSF=await start('SF',offerOf(completeOpts,'FOUNDER_MONTHLY'));
 assert.deepEqual([coST.checkout.status,coSF.checkout.status],['OPEN','OPEN']);
 const kSC=K();sim.failNextRequest('NETWORK');
 await deny(start('SC',offerOf(coreOpts,'REGULAR_MONTHLY'),kSC),409,'SAAS_OUTCOME_UNKNOWN');
 const coSC=(await options('SC')).checkout;
 assert.equal(coSC.status,'CREATED');
 // AW is placed awaiting its first payment (paid access ACTIVE, simulated), opens a legacy Complete checkout and pays
 // after paid access became inactive again: the payment is held for an HQ-owner retry.
 await setAccessProgram(true);
 await access.awaitFirstPayment(H('owner'),O.AW.id,{expectedEntitlementVersion:(await ent(O.AW.id)).version},K());
 const coAW=await start('AW',offerOf(completeOpts,'REGULAR_MONTHLY'));
 await setAccessProgram(false);
 const paidAW=sim.completeCheckout(sessionOf(coAW));
 assert.deepEqual(await outcome(paidAW.completed),['NEEDS_REVIEW','ACCESS_PROGRAM_INACTIVE']);
 const legacySubsBefore=(await admin.query("SELECT id,organization_id,source,plan_code,offer_kind,status,version FROM hon.saas_subscriptions ORDER BY id")).rows;
 assert.deepEqual(await legacyFounder(),[{status:'ALLOCATED',n:1},{status:'RESERVED',n:1}],'L2 holds a legacy lifetime slot, SF a monthly hold');

 // ---------- 2. the closure as shipped ----------
 await setLegacySales(admin,false);
 await assertLegacySalesClosed(admin);
 const callsAtClosure=providerCalls();

 // ---------- 3. new customers cannot buy a legacy plan through any path ----------
 // N is a brand-new school registered through HQ provisioning (Core): a new customer, with no legacy subscription.
 const provisioned=await new HqOnboardingService(database).provisionInitialSchool({externalSubject:H('owner')},{legalName:'D8 Provisioned Dojo LLC',
  displayName:'D8 Provisioned Dojo',schoolName:'D8 Provisioned Dojo Main',schoolSlug:`d8-${randomUUID().slice(0,8)}`,timezone:'America/Chicago',initialTier:'CORE',idempotencyKey:K(),expectedPrincipalId:humans.owner.id});
 Object.assign(N,{id:provisioned.organizationId,school:provisioned.schoolId});
 // N stands in for a school provisioned before D9 (0185 holds new provisioning SUSPENDED; the D9 proof covers that case).
 await activatePreD9ProvisionedSchool(admin,N.id);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute')",
  [N.id,N.school,humans.ownerN.id,provisioned.ownerRoleId,humans.owner.id]);
 const optsN=await payments.readPlanOptions(H('ownerN'),N.school);
 assert.deepEqual([optsN.entitlementTier,optsN.offers,optsN.subscription,optsN.checkout],['CORE',[],null,null],'no legacy offer is listed');
 for(const k of ['NC','NF','ST','L1'])assert.deepEqual((await options(k)).offers,[],`${k} sees no legacy offer`);
 // Direct API calls with every legacy offer ID (including stale IDs a client kept), by the school and by HQ.
 for(const offerId of legacyOffers){
  await deny(payments.startSchoolCheckout(H('ownerN'),N.school,{offerId},K()),422,'SAAS_LEGACY_SALES_CLOSED');
  await deny(start('NC',offerId),422,'SAAS_LEGACY_SALES_CLOSED');
  for(const who of ['owner','operator'])for(const org of [N.id,O.NC.id])
   await deny(payments.startHqCheckout(H(who),{organizationId:org,offerId},K()),422,'SAAS_LEGACY_SALES_CLOSED');
 }
 // Authorization still comes first: an outsider learns nothing more than before.
 await deny(payments.startSchoolCheckout(H('ownerNC'),N.school,{offerId:legacyOffers[0]},K()),403,'SAAS_FORBIDDEN');
 await deny(payments.startHqCheckout(H('support'),{organizationId:N.id,offerId:legacyOffers[0]},K()),403,'SAAS_FORBIDDEN');
 // HQ shortcuts: recording a legacy subscription or reserving a legacy founder slot.
 const founderOffer=offerOf(completeOpts,'FOUNDER_LIFETIME');
 await deny(billing.recordSubscription(H('owner'),{source:'CATALOG_OFFER',organizationId:O.NC.id,offerId:offerOf(completeOpts,'REGULAR_MONTHLY'),founderReservationId:null},K()),422,'SAAS_LEGACY_SALES_CLOSED');
 await deny(billing.recordSubscription(H('owner'),{source:'LEGACY_ENTITLEMENT',organizationId:N.id},K()),422,'SAAS_LEGACY_SALES_CLOSED');
 await deny(billing.recordSubscription(H('owner'),{source:'LEGACY_ENTITLEMENT',organizationId:O.NC.id},K()),422,'SAAS_LEGACY_SALES_CLOSED');
 await deny(billing.reserveFounder(H('owner'),{organizationId:O.NF.id,offerId:founderOffer},K()),422,'SAAS_LEGACY_SALES_CLOSED');
 for(const k of ['NC','NF'])assert.deepEqual([await checkoutCount(O[k].id),await subscriptions(O[k].id)],[0,[]],`${k}: nothing recorded`);
 assert.deepEqual([await checkoutCount(N.id),await subscriptions(N.id)],[0,[]]);
 assert.equal(providerCalls(),callsAtClosure,'no provider session was requested');
 // Direct writes that bypass every function are refused by the 0184 guard itself.
 await guardRefuses('saas_subscriptions',"INSERT INTO hon.saas_subscriptions(organization_id,source,plan_code,entitlement_tier,billing_interval,entitlement_version_at_record,status,status_reason,version,created_by_principal_id,created_at,updated_at) VALUES($1,'LEGACY_ENTITLEMENT','CORE','CORE','NONE',1,'PENDING_ACTIVATION','RECORDED',1,$2,clock_timestamp(),clock_timestamp())",[N.id,humans.owner.id]);
 await guardRefuses('saas_checkout_sessions',"INSERT INTO hon.saas_checkout_sessions(organization_id,school_id,catalog_id,offer_id,plan_code,offer_kind,billing_interval,amount_minor,requester_kind,requested_by_principal_id,provider,status,status_reason,expires_at,version,created_at,updated_at) SELECT $1,$2,o.catalog_id,o.id,o.plan_code,o.offer_kind,o.billing_interval,o.price_minor,'SCHOOL_OWNER',$3,'STRIPE_SIMULATED','CREATED','CREATED',clock_timestamp()+interval '1 hour',1,clock_timestamp(),clock_timestamp() FROM hon.saas_catalog_offers o WHERE o.id=$4",[N.id,N.school,humans.ownerN.id,offerOf(coreOpts,'REGULAR_MONTHLY')]);
 await guardRefuses('saas_founder_reservations',"INSERT INTO hon.saas_founder_reservations(organization_id,catalog_id,offer_id,pool,status,status_reason,version,hold_expires_at,reserved_by_principal_id,reserved_at) SELECT $1,o.catalog_id,o.id,'LIFETIME','RESERVED','RESERVED',1,clock_timestamp()+interval '1 day',$2,clock_timestamp() FROM hon.saas_catalog_offers o WHERE o.id=$3",[O.NF.id,humans.owner.id,founderOffer]);
 await guardRefuses('saas_checkout_sessions',"UPDATE hon.saas_checkout_sessions SET status='OPEN',status_reason='PROVIDER_SESSION_OPENED',version=version+1,provider_session_id='cs_test_d8direct',checkout_url='https://checkout.simulated.invalid/d8' WHERE id=$1",[coSC.checkoutId]);

 // ---------- 4. stale legacy links never sell ----------
 // A checkout left CREATED by an unknown provider outcome: replaying the same request is refused before the provider is
 // called, and attaching a provider session to it is refused; the school can still cancel it.
 await deny(start('SC',offerOf(coreOpts,'REGULAR_MONTHLY'),kSC),422,'SAAS_LEGACY_SALES_CLOSED');
 assert.equal(providerCalls(),callsAtClosure);
 await sqlDeny(admin.query('SELECT hon.attach_saas_checkout_session($1,$2,$3::jsonb,$4,$5,$6)',[H('ownerSC'),coSC.checkoutId,
  JSON.stringify({outcome:'OPENED',providerSessionId:'cs_test_d8stale',checkoutUrl:'https://checkout.simulated.invalid/d8stale'}),K(),K(),K()]),'23514','SAAS_LEGACY_SALES_CLOSED');
 const cancelledSC=await payments.cancelCheckout(H('ownerSC'),coSC.checkoutId,{expectedVersion:coSC.version},K());
 assert.deepEqual([cancelledSC.checkout.status,cancelledSC.checkout.statusReason],['CANCELLED','CANCELLED_BY_REQUESTER']);
 // An open link paid after the closure is held for HQ review: no subscription, invoice, entitlement or credit change.
 const entST=await ent(O.ST.id);
 const paidST=sim.completeCheckout(sessionOf(coST));
 assert.deepEqual(await outcome(paidST.completed),['NEEDS_REVIEW','LEGACY_SALES_CLOSED']);
 assert.deepEqual(await checkoutRow(coST.checkout.checkoutId),{status:'PAID_NEEDS_REVIEW',status_reason:'LEGACY_SALES_CLOSED',version:3,subscription_id:null});
 // Replays of the same payment, and the first subscription invoice, change nothing.
 await deliver(paidST.completed).catch(()=>{});
 const dupST=JSON.parse(paidST.completed.raw.toString());dupST.id=`evt_d8dup${randomUUID().replaceAll('-','').slice(0,12)}`;
 assert.deepEqual(await outcome(sim.sign(dupST)),['NEEDS_REVIEW','PAID_AFTER_CLOSE']);
 await deliver(paidST.firstInvoice).catch(()=>{});
 assert.deepEqual([await subscriptions(O.ST.id),await ent(O.ST.id),(await checkoutRow(coST.checkout.checkoutId)).version],[[],entST,3]);
 assert.equal((await options('ST')).checkout.status,'PAID_NEEDS_REVIEW','the school sees its held payment');
 // A stale legacy founder link: the hold is never allocated, and legacy and HON OS founder pools stay separate.
 const paidSF=sim.completeCheckout(sessionOf(coSF));
 assert.deepEqual(await outcome(paidSF.completed),['NEEDS_REVIEW','LEGACY_SALES_CLOSED']);
 assert.deepEqual([await subscriptions(O.SF.id),await legacyFounder()],[[],[{status:'ALLOCATED',n:1},{status:'RESERVED',n:1}]]);
 // A payment held while paid access was inactive is not activated by the HQ-owner retry once legacy sales are closed.
 await setAccessProgram(true);
 const retryAW=await access.retryFirstPaymentActivation(H('owner'),coAW.checkout.checkoutId,{expectedCheckoutVersion:(await checkoutRow(coAW.checkout.checkoutId)).version},K());
 assert.deepEqual([retryAW.outcome,retryAW.detail],['NEEDS_REVIEW','LEGACY_SALES_CLOSED']);
 assert.deepEqual(await ent(O.AW.id),{tier:'COMPLETE',status:'SUSPENDED',version:2},'AW stays without access');
 assert.deepEqual(await transitions(O.AW.id),['AWAITING_FIRST_PAYMENT:APPLIED:AWAITING_INITIAL_PAYMENT','FIRST_PAYMENT_ACTIVATION:NEEDS_REVIEW:ACCESS_PROGRAM_INACTIVE',
  'FIRST_PAYMENT_ACTIVATION:NEEDS_REVIEW:LEGACY_SALES_CLOSED']);
 assert.deepEqual(await subscriptions(O.AW.id),[]);

 // ---------- 5. new customers buy HQ-published HON OS offers only ----------
 // AW (awaiting) buys HON OS through the D7 path: the verified payment activates HON OS (COMPLETE), no AI credits.
 const coAWos=await startOs('AW',V.OS_MONTHLY);
 assert.deepEqual([coAWos.checkout.planCode,coAWos.checkout.amountMinor,coAWos.checkout.offerKind],['COMPLETE',31700,'REGULAR_MONTHLY']);
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coAWos)).completed),['APPLIED','ACCESS_ACTIVATED']);
 assert.deepEqual([(await ent(O.AW.id)).tier,(await ent(O.AW.id)).status],['COMPLETE','ACTIVE']);
 assert.deepEqual(await subscriptions(O.AW.id),[{source:'HON_OS_OFFER',plan_code:'COMPLETE',offer_kind:'REGULAR_MONTHLY',billing_interval:'MONTHLY',status:'IN_SERVICE',period_index:0}]);
 assert.equal((await row('SELECT count(*)::int n FROM hon.saas_credit_allowances WHERE organization_id=$1',[O.AW.id])).n,0);
 // N (provisioned Core) cannot buy HON OS on a Core entitlement and no longer has any legacy option: HQ places it
 // awaiting its first payment and it buys the single HON OS founder slot (NEW_ORGANIZATIONS_ONLY).
 await deny(startOs('N',V.OS_MONTHLY,K(),N.school),422,'SAAS_ENTITLEMENT_MISMATCH');
 await access.awaitFirstPayment(H('owner'),N.id,{expectedEntitlementVersion:(await ent(N.id)).version},K());
 assert.deepEqual((await payments.readPlanOptions(H('ownerN'),N.school)).offers,[],'awaiting: still no legacy offer');
 for(const offerId of legacyOffers)await deny(payments.startSchoolCheckout(H('ownerN'),N.school,{offerId},K()),422,'SAAS_LEGACY_SALES_CLOSED');
 const kN=K();
 const coN=await startOs('N',V.OS_FOUNDER_MONTHLY,kN,N.school);
 const paidN=sim.completeCheckout(sessionOf(coN));
 assert.deepEqual(await outcome(paidN.completed),['APPLIED','ACCESS_ACTIVATED']);
 const replayedN=await deliver(paidN.completed);
 assert.deepEqual([replayedN.replayed,replayedN.event.outcome],[true,'APPLIED'],'payment replay returns the first receipt');
 const dupN=JSON.parse(paidN.completed.raw.toString());dupN.id=`evt_d8dupn${randomUUID().replaceAll('-','').slice(0,12)}`;
 assert.deepEqual(await outcome(sim.sign(dupN)),['ALREADY_APPLIED','CHECKOUT_COMPLETED'],'the same payment under a new event id');
 const replayN=await startOs('N',V.OS_FOUNDER_MONTHLY,kN,N.school);
 assert.equal(replayN.replayed,true,'checkout replay with the same key');
 assert.deepEqual([(await ent(N.id)).tier,(await ent(N.id)).status],['COMPLETE','ACTIVE']);
 assert.deepEqual((await subscriptions(N.id)).map(s=>[s.source,s.offer_kind]),[['HON_OS_OFFER','FOUNDER_MONTHLY']]);
 await setAccessProgram(false);
 // The HON OS founder pool (1) is now used; the legacy founder slot and hold above never counted toward it.
 await deny(startOs('NF',V.OS_FOUNDER_MONTHLY),422,'SAAS_FOUNDER_SOLD_OUT');
 // NC (provisioned Complete, no subscription) buys the single lifetime sale through the 0182 path; NF is then sold out.
 const coNC=await startOs('NC',V.OS_LIFETIME);
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coNC)).completed),['APPLIED','SUBSCRIPTION_ACTIVATED']);
 await deny(startOs('NF',V.OS_LIFETIME),422,'SAAS_OFFER_SOLD_OUT');
 assert.deepEqual((await subscriptions(O.NC.id)).map(s=>[s.source,s.offer_kind,s.billing_interval]),[['HON_OS_OFFER','LIFETIME','LIFETIME']]);
 // NF can still buy the regular monthly HON OS offer.
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(await startOs('NF',V.OS_MONTHLY))).completed),['APPLIED','SUBSCRIPTION_ACTIVATED']);

 // ---------- 6. legacy customers continue unchanged ----------
 const entL1=await ent(O.L1.id),entL2=await ent(O.L2.id);
 // Refund request inside the 30-day guarantee of the legacy first purchase.
 const refund=await billing.createRefundRequest(H('operator'),{organizationId:O.L1.id,requestReceivedAt:iso(Date.now()),customerReference:'Fixture support ticket',note:null},K());
 assert.equal(refund.refundRequest.status,'REQUESTED');
 // Lifecycle commands still apply to the legacy subscription; cancellation stays policy-gated exactly as before.
 let subL1=await subOf(O.L1.id);
 const suspended=await billing.commandSubscription(H('owner'),subL1.subscriptionId,{action:'SUSPEND',reasonCode:'OWNER_HOLD',expectedVersion:subL1.version},K());
 assert.equal(suspended.subscription.status,'SUSPENDED');
 const resumed=await billing.commandSubscription(H('owner'),subL1.subscriptionId,{action:'RESUME',reasonCode:'REVIEW_RESOLVED',expectedVersion:suspended.subscription.version},K());
 assert.equal(resumed.subscription.status,'IN_SERVICE');
 await deny(billing.commandSubscription(H('owner'),subL1.subscriptionId,{action:'CANCEL',reasonCode:'SCHOOL_REQUEST',expectedVersion:resumed.subscription.version},K()),422,'SAAS_POLICY_UNDECIDED');
 // Renewal at the legacy price (fixture time travel: period 0 moved 31 days into the past).
 await withoutGuards(['saas_subscriptions','saas_invoices'],[
  ["UPDATE hon.saas_subscriptions SET service_started_at=service_started_at-interval '31 days',period_anchor_at=period_anchor_at-interval '31 days',current_period_start=current_period_start-interval '31 days',current_period_end=current_period_start-interval '31 days'+interval '1 month' WHERE id=$1",[subL1.subscriptionId]],
  ["UPDATE hon.saas_invoices SET service_period_start=service_period_start-interval '31 days',service_period_end=service_period_start-interval '31 days'+interval '1 month' WHERE subscription_id=$1",[subL1.subscriptionId]]]);
 subL1=await subOf(O.L1.id);
 const renewalL1=sim.renewal(paidL1.subscription,Date.parse(subL1.currentPeriod.endsAt)/1000,14900);
 assert.deepEqual(await outcome(renewalL1.delivery),['APPLIED','RENEWAL_RECORDED']);
 const dupRenewal=JSON.parse(renewalL1.delivery.raw.toString());dupRenewal.id=`evt_d8dupr${randomUUID().replaceAll('-','').slice(0,12)}`;
 assert.deepEqual(await outcome(sim.sign(dupRenewal)),['ALREADY_APPLIED','PAYMENT_ALREADY_RECORDED'],'renewal replay');
 subL1=await subOf(O.L1.id);
 assert.deepEqual([subL1.currentPeriod.index,subL1.paymentStatus,subL1.offerKind],[1,'PAID','REGULAR_MONTHLY']);
 assert.deepEqual(await outcome(sim.refund(renewalL1.paymentIntent,renewalL1.invoice,14900)),['APPLIED','REFUND_RECORDED']);
 // Paid lifetime right: a dispute is reconciled as evidence; the lifetime subscription and its founder slot stay.
 const disputeL2=await outcome(sim.dispute(paidL2.paymentIntent,357600,paidL2.charge));
 assert.equal(disputeL2[0],'APPLIED');
 assert.deepEqual((await subscriptions(O.L2.id)).map(s=>[s.source,s.plan_code,s.offer_kind,s.billing_interval,s.status]),[['CATALOG_OFFER','COMPLETE','FOUNDER_LIFETIME','LIFETIME','IN_SERVICE']]);
 assert.deepEqual([await ent(O.L1.id),await ent(O.L2.id)],[entL1,entL2],'a legacy payment never changes the entitlement');
 // Every pre-closure legacy subscription is still there, unchanged in kind, and no legacy subscription was added.
 const legacySubsAfter=(await admin.query("SELECT id,organization_id,source,plan_code,offer_kind FROM hon.saas_subscriptions WHERE source<>'HON_OS_OFFER' ORDER BY id")).rows;
 assert.deepEqual(legacySubsAfter,legacySubsBefore.map(({id,organization_id,source,plan_code,offer_kind})=>({id,organization_id,source,plan_code,offer_kind})));
 // HQ still sees the full legacy history, including the held stale payments.
 const hq=await payments.readPayments(H('operator'));
 assert.deepEqual(['ST','SF','AW'].map(k=>hq.checkouts.find(c=>c.organizationId===O[k].id&&c.status==='PAID_NEEDS_REVIEW')?.statusReason),
  ['LEGACY_SALES_CLOSED','LEGACY_SALES_CLOSED','ACCESS_PROGRAM_INACTIVE']);

 assert.deepEqual(await untouched(),before,'no entitlement outside the fixture, school-to-family billing, Champions or AI usage row changed');
 await assertLegacySalesClosed(admin);
 assert.deepEqual((await admin.query('SELECT status FROM hon.saas_access_program')).rows,[{status:'INACTIVE'}]);
 console.log('PASS: HON OS-only new sales (0184, D8) proof (legacy new sales pinned CLOSED as shipped and reopened only to build the pre-closure fixture; paid access ACTIVE simulated in the disposable database only, then restored; TEST MODE, SIMULATED Stripe) — policy private and immutable; every legacy offer ID refused for school and HQ checkout with no provider call; HQ legacy subscription records (catalog and legacy entitlement) and legacy founder reservations refused; direct inserts and provider-session attaches refused by the guard itself; a replayed pre-closure key never reaches the provider; stale open, founder and inactive-held legacy payments held for review (LEGACY_SALES_CLOSED) with no subscription, entitlement or founder allocation, including replays and the HQ retry; new customers buy HON OS only (D7 awaiting path with founder pool, 0182 path with lifetime sale limit, replay safe, no AI credits); legacy customers keep refunds, lifecycle commands, renewals, provider refunds, disputes and lifetime rights.');
}finally{
 if(programTouched)await setAccessProgram(false).catch(e=>console.error('RESTORE FAILED',e));
 await setLegacySales(admin,false).catch(e=>console.error('RESTORE FAILED',e));
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end()]);}
}
