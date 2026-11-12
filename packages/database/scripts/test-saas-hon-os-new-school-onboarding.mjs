import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// HON OS new-school onboarding (0183, owner decision D7) integrity proof, TEST MODE, SIMULATED PROVIDER, disposable
// database only. Paid access ships INACTIVE (CHECK status = 'INACTIVE'); like the B6A proof this simulates ACTIVE in
// the disposable database only and restores the shipped state before it ends. The real API services, the real Stripe
// test-mode adapter and the deterministic simulator run end to end: a brand-new school is registered awaiting its
// first payment (no access), picks an HQ-published HON OS offer, pays, and the verified payment activates the HON OS
// (COMPLETE) entitlement in the same transaction, for every offer kind. Failed, cancelled, expired, out-of-order,
// replayed and concurrent events, the HQ retry of a payment held while paid access was inactive (including the
// SALE_LIMIT_REACHED and FOUNDER_UNAVAILABLE rechecks), tenant isolation, provisioned schools and credits are covered.
// Every provider-verified row is STRIPE_SIMULATED: it proves HON's integration, not a Stripe account.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const {SaasPaidReviewService}=await import('../../../apps/api/dist/saas-paid-review/saas-paid-review.service.js');
const {StripeTestModeAdapter}=await import('../../../apps/api/dist/payments/stripe-test-mode-adapter.js');
const {StripeSimulator}=await import('../../../apps/api/dist/payments/stripe-simulator.js');
const contracts=await import('@hon/contracts');
const SECRET='whsec_disposableFixtureSecret0123456789',KEY='sk_test_disposableFixtureKey0123456789';
const sim=new StripeSimulator(SECRET);
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),access=new SaasSchoolBillingService(billing),reviews=new SaasPaidReviewService(billing);
const payments=new SaasPaymentsService(billing,database,new StripeTestModeAdapter({secretKey:KEY,webhookSecret:SECRET,provider:'STRIPE_SIMULATED',transport:sim.transport}));
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const pool=new pg.Pool({connectionString:owner.toString(),ssl:false,max:4});
const offerTables=['saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const saasTables=['saas_paid_review_resolutions','saas_access_transitions','saas_access_states','saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions',
 'saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions',
 'saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions',...offerTables];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code='42501',message)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);if(message)assert.equal(e.message,message);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
// New schools, each registered through the initializer (organization IDs are created by it):
// NM monthly (out of order, concurrent duplicates, replay), NA annual auto-renewing, NP annual prepaid (async payment fails, then succeeds),
// NFA/NFM/NFL founder annual/monthly/lifetime, NL1/NL2 race for the last lifetime sale, NC cancels then rebuys, NE expires then pays late,
// NX concurrent checkout attempts, NI/NS/NU pay while paid access is inactive (HQ retry: activates / sale limit reached / founder unavailable),
// NZ never pays. P is an existing HQ-provisioned COMPLETE school (0182 path, must stay as it was); "taken" already owns P.
const NEW=['NM','NA','NP','NFA','NFM','NFL','NL1','NL2','NC','NE','NX','NI','NS','NU','NZ','NR'];
const humans=Object.fromEntries(['owner','operator','support','taken',...NEW.map(k=>`owner${k}`)].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`hon-os-onboard-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
const P={id:randomUUID(),school:randomUUID(),role:randomUUID()};
const S={};// new-school registration receipts by key
const created=[];
const fixtureOrgs=()=>[P.id,...created];
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
async function untouched(){const out={};for(const t of ['organization_entitlements','billing_accounts','memberships','invoices','payment_attempts','champions_reward_entries','ai_usage_ledger'])
 out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t WHERE ${t==='organization_entitlements'?'NOT (organization_id=ANY($1::uuid[]))':'true OR $1::uuid[] IS NULL'} ORDER BY 1`,[fixtureOrgs()])).rows.map(r=>r.r);return out;}
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 const orgs=[...fixtureOrgs(),...(await admin.query("SELECT s.organization_id id FROM hon.saas_access_transitions s WHERE s.reason='NEW_SCHOOL_REGISTERED'").catch(()=>({rows:[]}))).rows.map(r=>r.id)];
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
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const ownerKey=k=>`owner${k}`;
const details=(k,patch={})=>({legalName:`HON OS Onboarding Fixture Dojo ${k} LLC`,displayName:`Fixture Dojo ${k}`,schoolName:`Fixture Dojo ${k} Main`,
 schoolSlug:`fixture-dojo-${k.toLowerCase()}`,timezone:'America/Chicago',...patch});
const register=(who,p,key=K(),client=admin)=>client.query('SELECT hon.initialize_saas_hon_os_school_account($1,$2::jsonb,$3,$4,$5) r',[H(who),JSON.stringify(p),key,K(),K()]).then(r=>r.rows[0].r);
const deliver=d=>payments.handleWebhook(d.raw,d.signature);
const outcome=async d=>{const r=await deliver(d);return [r.event.outcome,r.event.detail];};
const view=k=>billing.readSchoolHonOsOffers(H(ownerKey(k)),S[k].schoolId);
const startOf=(k,offerId,key=K())=>payments.startSchoolHonOsCheckout(H(ownerKey(k)),S[k].schoolId,{offerId},key);
const eligibility=async k=>Object.fromEntries((await view(k)).offers.map(o=>[o.offerCode,o.eligibility]));
const sessionOf=r=>r.checkout.providerSessionId;
const org=k=>S[k].organizationId;
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const ent=async o=>row('SELECT tier::text,status::text,version FROM hon.organization_entitlements WHERE organization_id=$1',[o]);
const transitions=async o=>(await admin.query('SELECT kind,outcome,reason FROM hon.saas_access_transitions WHERE organization_id=$1 ORDER BY occurred_at,id',[o])).rows.map(r=>`${r.kind}:${r.outcome}:${r.reason}`);
const checkoutRow=async id=>row('SELECT status,status_reason,version FROM hon.saas_checkout_sessions WHERE id=$1',[id]);
const subscriptionRow=async o=>row("SELECT * FROM hon.saas_subscriptions WHERE organization_id=$1 AND status<>'VOIDED'",[o]);
const subscriptionCount=async o=>(await row('SELECT count(*)::int n FROM hon.saas_subscriptions WHERE organization_id=$1',[o])).n;
const capable=async(o,cap)=>(await row('SELECT hon.saas_capability_allowed($1,$2) a',[o,cap])).a;
const followUpScope=async k=>(await row('SELECT count(*)::int n FROM hon.resolve_follow_up_scope($1)',[H(ownerKey(k))])).n;
const retry=async(checkoutId,who='owner',key=K())=>access.retryFirstPaymentActivation(H(who),checkoutId,{expectedCheckoutVersion:(await checkoutRow(checkoutId)).version},key);
const form=checkoutId=>{const f=sim.requests.find(r=>r.path==='/v1/checkout/sessions'&&r.form?.get('client_reference_id')===checkoutId).form;
 return[f.get('mode'),f.get('line_items[0][price_data][unit_amount]'),f.get('line_items[0][price_data][recurring][interval]')];};
// The school is active only after a verified payment: entitlement, access state, capabilities and staff scope all agree.
async function assertActivated(k,offerKind,priceMinor,interval){
 const e=await ent(org(k));
 assert.deepEqual([e.tier,e.status,e.version],['COMPLETE','ACTIVE',2],`${k} entitlement`);
 const a=await access.readOrganizationAccess(H('operator'),org(k));
 assert.deepEqual([a.state,a.source,a.entitlement.inEffect],['PAYMENT_ACTIVE','PAYMENT_ACTIVATED',true],`${k} access`);
 assert.deepEqual(a.transitions.map(t=>`${t.kind}:${t.outcome}:${t.reason}`).filter(t=>t.includes(':APPLIED:')),
  ['AWAITING_FIRST_PAYMENT:APPLIED:NEW_SCHOOL_REGISTERED','FIRST_PAYMENT_ACTIVATION:APPLIED:FIRST_PAYMENT_VERIFIED'],`${k} transitions`);
 assert.equal(a.transitions.at(-1).allowanceId,null,`${k}: no AI credits are opened at HON OS activation`);
 for(const cap of contracts.SAAS_COMPLETE_ONLY_CAPABILITIES)assert.equal(await capable(org(k),cap),true,`${k} ${cap}`);
 assert.equal(await followUpScope(k),1,`${k} staff scope resolves once paid`);
 const s=await subscriptionRow(org(k));
 assert.deepEqual([s.source,s.plan_code,s.entitlement_tier,s.offer_kind,s.price_minor,s.billing_interval,s.status],
  ['HON_OS_OFFER','COMPLETE','COMPLETE',offerKind,priceMinor,interval,'IN_SERVICE'],`${k} subscription`);
 const c=await row('SELECT accepted_offer,accepted_offer_digest FROM hon.saas_checkout_sessions WHERE subscription_id=$1',[s.id]);
 assert.deepEqual([s.accepted_offer,s.accepted_offer_digest],[c.accepted_offer,c.accepted_offer_digest],`${k} accepted offer copied`);
 return s;
}
async function assertAwaiting(k){
 assert.deepEqual(await ent(org(k)),{tier:'COMPLETE',status:'SUSPENDED',version:1},`${k} still held`);
 assert.equal((await row('SELECT state FROM hon.saas_access_states WHERE organization_id=$1',[org(k)])).state,'AWAITING_FIRST_PAYMENT');
 for(const cap of [...contracts.SAAS_CORE_CAPABILITIES,...contracts.SAAS_COMPLETE_ONLY_CAPABILITIES])assert.equal(await capable(org(k),cap),false,`${k} ${cap}`);
 assert.equal(await followUpScope(k),0,`${k} staff scope refused before payment`);
 assert.equal(await subscriptionCount(org(k)),0);
}

// Every price and term below is fixture data chosen by "HQ" in this proof, not a constant in the product.
const offer=(code,kind,priceMinor,displayName,patch={})=>{const interval=contracts.saasHonOsOfferBillingInterval(kind);return{offerCode:code,offerKind:kind,displayName,priceMinor,
 salesOpensAt:iso(NOW-HOUR),salesClosesAt:null,eligibility:'ANY_ACTIVE_ORGANIZATION',saleLimit:interval==='ONE_TIME'?25:null,
 priceLock:interval==='ONE_TIME'?'NONE':'WHILE_CONTINUOUSLY_SUBSCRIBED',priceLockMonths:null,annualRenewal:interval==='ANNUAL'?'AUTO_RENEW_AT_LOCKED_PRICE':null,
 plannedMonthlyPremiumCredits:12000,aiFairUseReference:interval==='ONE_TIME'?'Fixture lifetime AI fair-use policy v1':null,refundWindowDays:30,
 cancellationTiming:interval==='ONE_TIME'?null:'END_OF_PAID_PERIOD',...patch};};
const offers=()=>[
 offer('OS_MONTHLY','REGULAR_MONTHLY',31700,'Monthly'),
 offer('OS_ANNUAL','REGULAR_ANNUAL',317000,'Annual'),
 offer('OS_ANNUAL_PREPAID','REGULAR_ANNUAL',299000,'Annual prepaid',{annualRenewal:'NO_AUTO_RENEWAL',priceLock:'FIXED_MONTHS',priceLockMonths:12}),
 offer('OS_FOUNDER_MONTHLY','FOUNDER_MONTHLY',18300,'Founder monthly',{eligibility:'NEW_ORGANIZATIONS_ONLY'}),
 offer('OS_FOUNDER_ANNUAL','FOUNDER_ANNUAL',183000,'Founder annual',{annualRenewal:'NO_AUTO_RENEWAL',priceLock:'FIXED_MONTHS',priceLockMonths:24,refundWindowDays:14}),
 offer('OS_LIFETIME','LIFETIME',950000,'Lifetime',{saleLimit:1,refundWindowDays:7}),
 offer('OS_FOUNDER_LIFETIME','FOUNDER_LIFETIME',640000,'Founder lifetime',{saleLimit:5})];
const TERMS='Fixture HON OS terms v1 (not customer terms)';

await Promise.all([admin.connect(),restricted.connect()]);
const v1Gate=on=>admin.query(`ALTER TABLE hon.saas_checkout_sessions ${on?'ENABLE':'DISABLE'} TRIGGER saas_hon_os_v1_offer_kind`);
try{
 // 0237 (owner answer 5) refuses every new HON OS v1 founder or lifetime checkout. This proof replays the pre-0237 sales
 // history: the refusal is proven live where that history first sells one, then set aside in the disposable database
 // only, and restored (and checked enabled) before the PASS line and in the finally block.
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- runtime posture: registration and the HON OS activation core are never runtime-executable ----------
 for(const sig of ['initialize_saas_hon_os_school_account(text,jsonb,uuid,uuid,uuid)','saas_activate_hon_os_checkout_core(uuid,jsonb,timestamptz,boolean)',
  'saas_activate_hon_os_checkout(uuid,jsonb,timestamptz)','saas_apply_first_payment_access(uuid,uuid,uuid,jsonb,timestamptz)','saas_hon_os_refusal(uuid,hon.saas_offer_set_offers,timestamptz)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);
 await sqlDeny(restricted.query("SELECT hon.initialize_saas_hon_os_school_account('x','{}'::jsonb,gen_random_uuid(),gen_random_uuid(),gen_random_uuid())"));
 assert.deepEqual((await admin.query('SELECT status,mutations_enabled FROM hon.saas_access_program')).rows,[{status:'INACTIVE',mutations_enabled:false}]);
 assert.equal((await admin.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='saas_access_program_status_check'")).rows[0].d,STATUS_CHECK);
 await cleanup();

 // ---------- fixture: identities, one provisioned COMPLETE school, legacy catalog and an active credit program ----------
 await admin.query('BEGIN');
 if((await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state) VALUES('HIGGSFIELD','Fixture provider','DISABLED') ON CONFLICT DO NOTHING RETURNING provider_id")).rowCount)createdProvider=true;
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[who,hqRole,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['support','HON_HQ_SUPPORT',['hq.billing.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,hqRole,perms]);
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'HON OS Onboarding Fixture Provisioned','HON OS Onboarding Fixture Provisioned')",[P.id]);
 await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'COMPLETE',clock_timestamp()-interval '90 days')",[P.id]);
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Provisioned School',$1::text,'America/New_York')",[P.school,P.id]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[P.role,P.id]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[P.role,P.id]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[P.id,P.school,humans.taken.id,P.role]);
 await admin.query('COMMIT');
 const d=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
 d.termsReference='Fixture HON plan terms (not customer terms)';
 d.founderProgram={...d.founderProgram,eligibility:'ANY_ACTIVE_ORGANIZATION',opensAt:iso(NOW-HOUR)};
 await billing.publishCatalog(H('owner'),(await billing.createCatalogDraft(H('owner'),d,K())).catalog.catalogId,K());
 const ev=(await billing.recordCostEvidence(H('owner'),{providerId:'HIGGSFIELD',modelCode:'fixture-image-1',costUnit:'IMAGE',measuredUnits:1000,billedCostMicrounits:40_000_000,
  fullyLoadedCostMicrounits:50_000_000,evidenceReference:'FIXTURE-D7-PROVIDER-1',periodStart:iso(NOW-40*DAY),periodEnd:iso(NOW-10*DAY),note:null},K())).costEvidence;
 const pd=(await billing.createPricingDraft(H('operator'),{termsReference:'Fixture premium pricing (not customer terms)',operations:[{operationCode:'image.generate',
  category:'IMAGE_GENERATION',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,requiredCapability:'ai.premium_metered',costEvidenceId:ev.costEvidenceId}]},K())).pricing;
 await billing.publishPricing(H('owner'),pd.pricingId,K());
 // The credit program is ACTIVE here on purpose: HON OS activation must still open no AI credits.
 await billing.setCreditProgram(H('owner'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'Fixture owner authorization (disposable)'},K());
 const pub=await billing.publishOfferSet(H('owner'),...await(async()=>{const dr=await billing.createOfferSetDraft(H('owner'),{basedOnSetId:null,termsReference:TERMS,founderTotalLimit:3,offers:offers()},K());
  return[dr.set.setId,{expectedRevision:dr.set.revision,previewDigest:dr.preview.previewDigest,approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K()];})());
 const V=Object.fromEntries(pub.set.offers.map(o=>[o.offerCode,o.offerId]));
 await payments.setPaymentProgram(H('owner'),{action:'ENABLE_TEST_MODE',expectedVersion:1,authorizationReference:'Fixture owner test-mode authorization (disposable)',
  provider:'STRIPE_SIMULATED',testTaxReference:'TEST MODE: no tax collected; TAXES undecided (fixture)'},K());
 const before=await untouched();
 const entP0=await ent(P.id);

 // ---------- 1. paid access INACTIVE (as shipped): no new school can be registered ----------
 await sqlDeny(register(ownerKey('NZ'),details('NZ')),'23514','SAAS_ACCESS_NOT_ACTIVE');
 assert.equal((await row("SELECT count(*)::int n FROM hon.organizations WHERE legal_name LIKE 'HON OS Onboarding Fixture Dojo %'")).n,0);

 // ---------- 2. simulated ACTIVE (disposable only): registration of brand-new schools ----------
 await setAccessProgram(true);
 // Closed input: exactly these five trimmed fields, a lowercase slug and a real time zone.
 for(const bad of [{...details('NZ'),extra:'x'},(({timezone,...r})=>r)(details('NZ')),details('NZ',{schoolSlug:'Bad Slug'}),details('NZ',{timezone:'Mars/Olympus'}),
  details('NZ',{legalName:' padded'}),details('NZ',{displayName:''}),details('NZ',{schoolName:7})])
  await sqlDeny(register(ownerKey('NZ'),bad),'22023');
 await sqlDeny(admin.query('SELECT hon.initialize_saas_hon_os_school_account($1,$2::jsonb,$3,$4,$5)',[`unknown-${randomUUID()}`,JSON.stringify(details('NZ')),K(),K(),K()]),'42501');
 // An identity that already holds school or HQ access cannot register another school.
 for(const who of ['taken','owner','operator'])await sqlDeny(register(who,details('NZ')),'23514','SAAS_OWNER_NOT_ELIGIBLE');
 const kNM=K();
 S.NM=await register(ownerKey('NM'),details('NM'),kNM);created.push(S.NM.organizationId);
 assert.deepEqual([S.NM.replayed,S.NM.access.state,S.NM.access.source,S.NM.access.entitlement.tier,S.NM.access.entitlement.status,S.NM.access.capabilities,S.NM.access.paidAccessProgram],
  [false,'AWAITING_FIRST_PAYMENT','NONE','COMPLETE','SUSPENDED',[],'ACTIVE']);
 const again=await register(ownerKey('NM'),details('NM'),kNM);
 assert.deepEqual([again.replayed,again.organizationId,again.schoolId],[true,S.NM.organizationId,S.NM.schoolId],'same key replays the same registration');
 await sqlDeny(register(ownerKey('NM'),details('NM',{schoolSlug:'fixture-dojo-nm-2'}),kNM),'23505','SAAS_KEY_REUSED');
 await sqlDeny(register(ownerKey('NM'),details('NM2')),'23514','SAAS_OWNER_NOT_ELIGIBLE');
 // Two concurrent registrations of the same identity with different keys: exactly one school.
 const regRace=await Promise.allSettled([register(ownerKey('NR'),details('NR'),K(),pool),register(ownerKey('NR'),details('NR2'),K(),pool)]);
 assert.equal(regRace.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(regRace.map(r=>r.reason?.message)));
 assert.equal(regRace.find(r=>r.status==='rejected').reason.message,'SAAS_OWNER_NOT_ELIGIBLE');
 S.NR=regRace.find(r=>r.status==='fulfilled').value;created.push(S.NR.organizationId);
 for(const k of NEW.filter(k=>!S[k])){S[k]=await register(ownerKey(k),details(k));created.push(S[k].organizationId);}
 const reg=await row("SELECT o.display_name,s.slug,s.timezone,r.code,(SELECT count(*)::int FROM hon.role_permissions rp WHERE rp.role_id=r.id) perms,(SELECT count(*)::int FROM hon.permissions) all_perms FROM hon.organizations o JOIN hon.schools s ON s.organization_id=o.id JOIN hon.principal_role_grants g ON g.school_id=s.id JOIN hon.roles r ON r.id=g.role_id WHERE o.id=$1 AND g.principal_id=$2",[org('NM'),humans.ownerNM.id]);
 assert.deepEqual([reg.display_name,reg.slug,reg.timezone,reg.code,reg.perms],['Fixture Dojo NM','fixture-dojo-nm','America/Chicago','OWNER',reg.all_perms]);
 for(const k of NEW)await assertAwaiting(k);
 assert.deepEqual(await transitions(org('NM')),['AWAITING_FIRST_PAYMENT:APPLIED:NEW_SCHOOL_REGISTERED']);
 // Before payment: billing and offers readable, nothing else. Each owner sees only its own school.
 const accountNM=await access.readAccount(H('ownerNM'),S.NM.schoolId);
 assert.deepEqual([accountNM.access.state,accountNM.access.paymentActivated,accountNM.access.activation,accountNM.allowance.state],['AWAITING_FIRST_PAYMENT',false,'UNAVAILABLE','ACCESS_NOT_ACTIVE']);
 let v=await view('NM');
 assert.deepEqual([v.purchase,v.paidAccessProgram,v.checkout,v.purchased],['TEST_MODE','ACTIVE',null,null]);
 assert.deepEqual(v.offers.map(o=>[o.offerCode,o.eligibility]),[['OS_MONTHLY','ELIGIBLE'],['OS_ANNUAL','ELIGIBLE'],['OS_ANNUAL_PREPAID','ELIGIBLE'],
  ['OS_FOUNDER_MONTHLY','ELIGIBLE'],['OS_FOUNDER_ANNUAL','ELIGIBLE'],['OS_LIFETIME','ELIGIBLE'],['OS_FOUNDER_LIFETIME','ELIGIBLE']],'D7: no active entitlement needed');
 await deny(billing.readSchoolHonOsOffers(H('ownerNA'),S.NM.schoolId),403,'SAAS_FORBIDDEN');
 for(const who of ['ownerNA','owner','operator','support','taken'])await deny(payments.startSchoolHonOsCheckout(H(who),S.NM.schoolId,{offerId:V.OS_MONTHLY},K()),403,'SAAS_FORBIDDEN');
 for(const body of [{offerId:V.OS_MONTHLY,priceMinor:100},{offerId:V.OS_MONTHLY,organizationId:org('NA')},{}])
  await deny(payments.startSchoolHonOsCheckout(H('ownerNM'),S.NM.schoolId,body,K()),400,'INVALID_SAAS_INPUT');
 // D8 (0184): a school awaiting its first payment sees no legacy Core/Complete offer and cannot open a legacy checkout.
 assert.deepEqual((await payments.readPlanOptions(H('ownerNZ'),S.NZ.schoolId)).offers,[]);

 // ---------- 3. regular monthly: out-of-order first invoice, concurrent duplicate deliveries, replay ----------
 const coNM=await startOf('NM',V.OS_MONTHLY);
 assert.deepEqual(form(coNM.checkout.checkoutId),['subscription','31700','month']);
 assert.deepEqual([coNM.checkout.planCode,coNM.checkout.amountMinor,coNM.purchase.offerSetVersion],['COMPLETE',31700,1]);
 const paidNM=sim.completeCheckout(sessionOf(coNM));
 await deny(deliver(paidNM.firstInvoice),503,'SAAS_PROVIDER_EVENT_RETRY');
 await assertAwaiting('NM');
 const racedNM=await Promise.allSettled(Array.from({length:5},()=>deliver(paidNM.completed)));
 for(const r of racedNM.filter(r=>r.status==='rejected'))http(503,'SAAS_PROVIDER_EVENT_RETRY')(r.reason);
 const firstNM=racedNM.filter(r=>r.status==='fulfilled').map(r=>r.value).filter(r=>!r.replayed);
 assert.deepEqual(firstNM.map(r=>[r.event.outcome,r.event.detail,r.event.organizationId]),[['APPLIED','ACCESS_ACTIVATED',org('NM')]],'exactly one activation');
 assert.equal((await deliver(paidNM.completed)).replayed,true);
 assert.deepEqual(await outcome(paidNM.firstInvoice),['ALREADY_APPLIED','FIRST_INVOICE_COVERED_BY_CHECKOUT']);
 const sNM=await assertActivated('NM','REGULAR_MONTHLY',31700,'MONTHLY');
 assert.equal(await subscriptionCount(org('NM')),1);
 const accountNM2=await access.readAccount(H('ownerNM'),S.NM.schoolId);
 assert.deepEqual([accountNM2.access.state,accountNM2.access.activation,accountNM2.access.alignment,accountNM2.allowance.state,accountNM2.allowance.plannedMonthlyCredits],
  ['PAYMENT_ACTIVE','READY','ALIGNED','NOT_YET_OPENED',12000],'planned credits are planning only; nothing granted');
 // A renewal bills the accepted price; it neither grants credits nor touches the entitlement.
 assert.deepEqual(await outcome(sim.renewal(paidNM.subscription,Math.floor(new Date(sNM.current_period_end).getTime()/1000),31700).delivery),['APPLIED','RENEWAL_RECORDED']);
 assert.deepEqual(await ent(org('NM')),{tier:'COMPLETE',status:'ACTIVE',version:2});
 v=await view('NM');
 assert.equal(v.offers.every(o=>o.eligibility==='NOT_ELIGIBLE_EXISTING_SUBSCRIPTION'),true,'one purchase per school');
 await deny(startOf('NM',V.OS_ANNUAL),422,'SAAS_SUBSCRIPTION_EXISTS');

 // ---------- 4. annual auto-renewing (YEAR) and annual prepaid with a failed, then a successful, async payment ----------
 const coNA=await startOf('NA',V.OS_ANNUAL);
 assert.deepEqual(form(coNA.checkout.checkoutId),['subscription','317000','year']);
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coNA)).completed),['APPLIED','ACCESS_ACTIVATED']);
 const sNA=await assertActivated('NA','REGULAR_ANNUAL',317000,'ANNUAL');
 assert.equal(new Date(sNA.current_period_end)-new Date(sNA.current_period_start)>=365*DAY,true,'a 12-month period');
 const coNP1=await startOf('NP',V.OS_ANNUAL_PREPAID);
 assert.deepEqual(form(coNP1.checkout.checkoutId),['payment','299000',null]);
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coNP1),{paid:false}).completed),['AWAITING_ASYNC_PAYMENT','PAYMENT_PENDING']);
 await assertAwaiting('NP');
 assert.deepEqual(await outcome(sim.asyncPaymentFailed(sessionOf(coNP1))),['APPLIED','ASYNC_PAYMENT_FAILED']);
 assert.deepEqual(await checkoutRow(coNP1.checkout.checkoutId),{status:'FAILED',status_reason:'ASYNC_PAYMENT_FAILED',version:3});
 await assertAwaiting('NP');
 assert.equal((await eligibility('NP')).OS_ANNUAL_PREPAID,'ELIGIBLE','a failed first payment leaves the school free to try again');
 const coNP2=await startOf('NP',V.OS_ANNUAL_PREPAID);
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coNP2),{paid:false}).completed),['AWAITING_ASYNC_PAYMENT','PAYMENT_PENDING']);
 const lateSuccess=sim.asyncPaymentSucceeded(sessionOf(coNP2));
 assert.deepEqual(await outcome(lateSuccess),['APPLIED','ACCESS_ACTIVATED']);
 assert.equal((await deliver(lateSuccess)).replayed,true);
 const sNP=await assertActivated('NP','REGULAR_ANNUAL',299000,'ANNUAL');
 assert.equal((await row('SELECT provider_subscription_ref r FROM hon.saas_checkout_sessions WHERE id=$1',[coNP2.checkout.checkoutId])).r,null,'prepaid annual: no recurring billing');
 assert.equal(sNP.accepted_offer.recurringBilling,'NONE');

 // ---------- 5. cancelled and expired first checkouts; late payments go to review, never activate ----------
 const coNC1=await startOf('NC',V.OS_MONTHLY);
 const cancelledNC=await payments.cancelCheckout(H('ownerNC'),coNC1.checkout.checkoutId,{expectedVersion:coNC1.checkout.version},K());
 assert.deepEqual([cancelledNC.checkout.status,cancelledNC.providerExpiry],['CANCELLED','REQUESTED']);
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coNC1)).completed),['NEEDS_REVIEW','PAID_AFTER_CLOSE']);
 await assertAwaiting('NC');
 assert.deepEqual(await transitions(org('NC')),['AWAITING_FIRST_PAYMENT:APPLIED:NEW_SCHOOL_REGISTERED','FIRST_PAYMENT_ACTIVATION:NEEDS_REVIEW:PAID_AFTER_CLOSE']);
 await deny(retry(coNC1.checkout.checkoutId),422,'SAAS_ACCESS_NOT_RETRYABLE');
 const coNC2=await startOf('NC',V.OS_MONTHLY);
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coNC2)).completed),['APPLIED','ACCESS_ACTIVATED']);
 await assertActivated('NC','REGULAR_MONTHLY',31700,'MONTHLY');
 const coNE=await startOf('NE',V.OS_ANNUAL);
 assert.deepEqual(await outcome(sim.expire(sessionOf(coNE))),['APPLIED','CHECKOUT_EXPIRED']);
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coNE)).completed),['NEEDS_REVIEW','PAID_AFTER_CLOSE']);
 await assertAwaiting('NE');
 await deny(retry(coNE.checkout.checkoutId),422,'SAAS_ACCESS_NOT_RETRYABLE');

 // ---------- 6. concurrent checkout attempts by one new school: exactly one checkout ----------
 const xRace=await Promise.allSettled(Array.from({length:5},(_,i)=>startOf('NX',i%2?V.OS_ANNUAL:V.OS_MONTHLY)));
 assert.equal(xRace.filter(r=>r.status==='fulfilled').length,1,'one open checkout per school');
 for(const r of xRace.filter(r=>r.status==='rejected'))http(422,'SAAS_CHECKOUT_OPEN')(r.reason);
 assert.equal((await row("SELECT count(*)::int n FROM hon.saas_checkout_sessions WHERE organization_id=$1",[org('NX')])).n,1);
 const coNX=xRace.find(r=>r.status==='fulfilled').value;
 const kNX=K(),coNXk=await startOf('NX',V.OS_MONTHLY,kNX).catch(e=>e);http(422,'SAAS_CHECKOUT_OPEN')(coNXk);
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coNX)).completed),['APPLIED','ACCESS_ACTIVATED']);
 await assertActivated('NX',coNX.checkout.offerKind,coNX.checkout.amountMinor,coNX.checkout.billingInterval);

 // ---------- 7. paid access inactive at payment time: held, then the HQ owner retries with every recheck ----------
 await v1Gate(true);
 await deny(startOf('NU',V.OS_FOUNDER_MONTHLY),422,'SAAS_OFFER_REQUIRES_SCHEDULE');
 await deny(startOf('NU',V.OS_FOUNDER_ANNUAL),422,'SAAS_OFFER_REQUIRES_SCHEDULE');
 await deny(startOf('NU',V.OS_FOUNDER_LIFETIME),422,'SAAS_OFFER_REQUIRES_SCHEDULE');
 await deny(startOf('NS',V.OS_LIFETIME),422,'SAAS_OFFER_REQUIRES_SCHEDULE');
 await v1Gate(false);
 const coNU=await startOf('NU',V.OS_FOUNDER_MONTHLY);// holds a founder slot (pool limit 3)
 const coNS=await startOf('NS',V.OS_LIFETIME);// holds the only lifetime sale
 const coNI=await startOf('NI',V.OS_MONTHLY);
 assert.deepEqual((await billing.readOfferManagement(H('operator'))).honOsSales.founderPool,{limit:3,allocated:0,held:1,remaining:2});
 await setAccessProgram(false);
 const paidNS=sim.completeCheckout(sessionOf(coNS)),paidNU=sim.completeCheckout(sessionOf(coNU));
 for(const[k,paid]of [['NI',sim.completeCheckout(sessionOf(coNI))],['NS',paidNS],['NU',paidNU]]){
  assert.deepEqual(await outcome(paid.completed),['NEEDS_REVIEW','ACCESS_PROGRAM_INACTIVE'],k);
  await assertAwaiting(k);
  assert.deepEqual((await transitions(org(k))).at(-1),'FIRST_PAYMENT_ACTIVATION:NEEDS_REVIEW:ACCESS_PROGRAM_INACTIVE');
 }
 // While inactive, a school awaiting payment is an ordinary suspended school: no checkout, no retry, no registration.
 assert.equal(Object.values(await eligibility('NZ')).every(e=>e==='NOT_ELIGIBLE_ENTITLEMENT'),true);
 await deny(startOf('NZ',V.OS_MONTHLY),422,'SAAS_ENTITLEMENT_NOT_ACTIVE');
 await deny(retry(coNI.checkout.checkoutId),422,'SAAS_ACCESS_NOT_ACTIVE');
 await setAccessProgram(true);
 // Held payments no longer hold inventory: other schools take the last lifetime sale and every founder slot.
 const lifeRace=await Promise.allSettled(['NL1','NL2'].map(k=>startOf(k,V.OS_LIFETIME)));
 assert.equal(lifeRace.filter(r=>r.status==='fulfilled').length,1,'exactly one school holds the last lifetime sale');
 http(422,'SAAS_OFFER_SOLD_OUT')(lifeRace.find(r=>r.status==='rejected').reason);
 const lifeWinner=lifeRace[0].status==='fulfilled'?'NL1':'NL2',lifeLoser=lifeWinner==='NL1'?'NL2':'NL1';
 const coLife=lifeRace.find(r=>r.status==='fulfilled').value;
 assert.deepEqual(form(coLife.checkout.checkoutId),['payment','950000',null]);
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coLife)).completed),['APPLIED','ACCESS_ACTIVATED']);
 const sLife=await assertActivated(lifeWinner,'LIFETIME',950000,'LIFETIME');
 assert.equal(sLife.current_period_end,null,'lifetime: no period end, no renewal');
 assert.equal((await eligibility(lifeLoser)).OS_LIFETIME,'SOLD_OUT');
 await assertAwaiting(lifeLoser);
 for(const[k,code,kind,price,interval,form0]of [['NFA','OS_FOUNDER_ANNUAL','FOUNDER_ANNUAL',183000,'ANNUAL',['payment','183000',null]],
  ['NFL','OS_FOUNDER_LIFETIME','FOUNDER_LIFETIME',640000,'LIFETIME',['payment','640000',null]],['NFM','OS_FOUNDER_MONTHLY','FOUNDER_MONTHLY',18300,'MONTHLY',['subscription','18300','month']]]){
  const co=await startOf(k,V[code]);
  assert.deepEqual(form(co.checkout.checkoutId),form0,k);
  assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(co)).completed),['APPLIED','ACCESS_ACTIVATED'],k);
  await assertActivated(k,kind,price,interval);
 }
 assert.deepEqual((await billing.readOfferManagement(H('operator'))).honOsSales.founderPool,{limit:3,allocated:3,held:0,remaining:0});
 assert.equal((await eligibility('NZ')).OS_FOUNDER_MONTHLY,'FOUNDER_SOLD_OUT');
 // HQ-owner retry: only the HQ owner, version-checked and idempotent.
 for(const who of ['operator','support','ownerNI'])await deny(retry(coNI.checkout.checkoutId,who),403,'SAAS_FORBIDDEN');
 await deny(access.retryFirstPaymentActivation(H('owner'),coNI.checkout.checkoutId,{expectedCheckoutVersion:(await checkoutRow(coNI.checkout.checkoutId)).version+1},K()),409,'SAAS_VERSION_CONFLICT');
 const kNI=K(),vNI=(await checkoutRow(coNI.checkout.checkoutId)).version;
 const retryNI=await access.retryFirstPaymentActivation(H('owner'),coNI.checkout.checkoutId,{expectedCheckoutVersion:vNI},kNI);
 assert.deepEqual([retryNI.outcome,retryNI.detail,retryNI.access.state,retryNI.access.entitlement.tier,retryNI.replayed],['APPLIED','ACCESS_ACTIVATED','PAYMENT_ACTIVE','COMPLETE',false]);
 assert.equal((await access.retryFirstPaymentActivation(H('owner'),coNI.checkout.checkoutId,{expectedCheckoutVersion:vNI},kNI)).replayed,true);
 await deny(retry(coNI.checkout.checkoutId),422,'SAAS_ACCESS_STATE_CHANGED');
 await assertActivated('NI','REGULAR_MONTHLY',31700,'MONTHLY');
 assert.deepEqual(Object.values(await checkoutRow(coNI.checkout.checkoutId)).slice(0,2),['COMPLETED','PAYMENT_VERIFIED']);
 // The sale limit and the founder pool are re-checked at the retry: those payments stay held for HQ, never oversold.
 const retryNS=await retry(coNS.checkout.checkoutId);
 assert.deepEqual([retryNS.outcome,retryNS.detail,retryNS.access.state],['NEEDS_REVIEW','SALE_LIMIT_REACHED','AWAITING_FIRST_PAYMENT']);
 const retryNU=await retry(coNU.checkout.checkoutId);
 assert.deepEqual([retryNU.outcome,retryNU.detail,retryNU.access.state],['NEEDS_REVIEW','FOUNDER_UNAVAILABLE','AWAITING_FIRST_PAYMENT']);
 for(const[k,reason]of [['NS','SALE_LIMIT_REACHED'],['NU','FOUNDER_UNAVAILABLE']]){
  await assertAwaiting(k);
  assert.deepEqual((await transitions(org(k))).slice(-2),['FIRST_PAYMENT_ACTIVATION:NEEDS_REVIEW:ACCESS_PROGRAM_INACTIVE',`FIRST_PAYMENT_ACTIVATION:NEEDS_REVIEW:${reason}`]);
 }
 assert.deepEqual((await billing.readOfferManagement(H('operator'))).honOsSales.founderPool,{limit:3,allocated:3,held:0,remaining:0},'never oversold');
 assert.equal((await row("SELECT count(*)::int n FROM hon.saas_subscriptions WHERE hon_os_offer_id=$1 AND status<>'VOIDED'",[V.OS_LIFETIME])).n,1,'sale limit 1 kept');
 // A held payment that is refunded is never activated by a later retry.
 assert.ok((await deliver(sim.refund(paidNS.paymentIntent,null,950000))).event);
 await deny(retry(coNS.checkout.checkoutId),422,'SAAS_ACCESS_PAYMENT_REVERSED');
 // ---------- 0237 piece 3: HQ review queue for held v1 payments; refund obligation and verified refund ----------
 const queue=async(who='owner')=>{const items=[];let cursor=null;do{const page=await reviews.list(H(who),cursor);items.push(...page.items);cursor=page.nextCursor;}while(cursor);return items;};
 const itemOf=async id=>(await queue()).find(i=>i.subjectId===id);
 const resolveBody=(id,version,decision='REFUND_OWED')=>({subjectKind:'V1_CHECKOUT',subjectId:id,expectedVersion:version,decision,reason:'Fixture held payment owed back to the school',confirmation:contracts.SAAS_PAID_REVIEW_RESOLVE_CONFIRMATION});
 const verifyBody=version=>({expectedVersion:version,confirmation:contracts.SAAS_PAID_REVIEW_VERIFY_CONFIRMATION});
 const conflict=async k=>(await row('SELECT hon.saas_org_billing_conflict($1) c',[org(k)])).c;
 for(const who of ['support','ownerNU'])await deny(reviews.list(H(who),null),403,'SAAS_FORBIDDEN');
 await deny(reviews.list(H('operator'),'not-a-cursor'),400,'INVALID_SAAS_INPUT');
 const itemNU=await itemOf(coNU.checkout.checkoutId),itemNS=await itemOf(coNS.checkout.checkoutId);
 assert.deepEqual([itemNU.billingStatus,itemNU.reason,itemNU.heldItemCount,itemNU.heldAmountMinor,itemNU.fullyRefunded,itemNU.blocker,itemNU.allowedDecisions,itemNU.providerActionExecuted],
  ['PAID_NEEDS_REVIEW','ACCESS_PROGRAM_INACTIVE',1,18300,false,null,['REFUND_OWED'],false]);
 assert.deepEqual([itemNS.heldAmountMinor,itemNS.refundedAmountMinor,itemNS.fullyRefunded],[950000,950000,true],'stored provider refund evidence is shown, never applied by the read');
 assert.deepEqual((await reviews.list(H('operator'),null)).items.map(i=>i.subjectId).sort(),(await queue()).map(i=>i.subjectId).sort(),'HQ billing operators may read the queue');
 assert.equal(await conflict('NS'),'PAID_NEEDS_REVIEW','raw refund evidence never clears a hold by itself');
 // Commands: HQ owner only; accepting held money without a refund is owner decision OD-14 and refused.
 for(const who of ['operator','support','ownerNU'])await deny(reviews.resolve(H(who),resolveBody(coNU.checkout.checkoutId,itemNU.subjectVersion),K()),403,'SAAS_FORBIDDEN');
 for(const decision of ['ACTIVATE','RESUME_BILLING'])await deny(reviews.resolve(H('owner'),resolveBody(coNU.checkout.checkoutId,itemNU.subjectVersion,decision),K()),422,'SAAS_BILLING_POLICY_UNAVAILABLE');
 await deny(reviews.resolve(H('owner'),{...resolveBody(coNU.checkout.checkoutId,itemNU.subjectVersion),confirmation:'YES'},K()),400,'INVALID_SAAS_INPUT');
 await deny(reviews.resolve(H('owner'),resolveBody(coNU.checkout.checkoutId,itemNU.subjectVersion+1),K()),409,'SAAS_VERSION_CONFLICT');
 const kNU=K(),owedNU=await reviews.resolve(H('owner'),resolveBody(coNU.checkout.checkoutId,itemNU.subjectVersion),kNU);
 assert.deepEqual([owedNU.resolution.status,owedNU.resolution.heldAmountMinor,owedNU.resolution.providerActionExecuted,owedNU.item.allowedDecisions,owedNU.replayed],['AWAITING_REFUND_EVIDENCE',18300,false,[],false]);
 assert.equal((await reviews.resolve(H('owner'),resolveBody(coNU.checkout.checkoutId,itemNU.subjectVersion),kNU)).replayed,true);
 await deny(reviews.resolve(H('owner'),resolveBody(coNU.checkout.checkoutId,itemNU.subjectVersion),K()),422,'SAAS_REVIEW_NOT_RESOLVABLE');
 assert.equal(await conflict('NU'),'PAID_NEEDS_REVIEW','a refund obligation keeps blocking');
 // A recorded refund obligation can never be activated by the v1 access retry, and no writer may move the checkout.
 assert.notEqual((await retry(coNU.checkout.checkoutId)).outcome,'APPLIED');
 await admin.query('BEGIN');
 await sqlDeny(admin.query("UPDATE hon.saas_checkout_sessions SET status='COMPLETED',version=version+1 WHERE id=$1",[coNU.checkout.checkoutId]),'23514','SAAS_REVIEW_REFUND_RECORDED');
 await admin.query('ROLLBACK');
 assert.equal((await checkoutRow(coNU.checkout.checkoutId)).status,'PAID_NEEDS_REVIEW');
 const rNU=owedNU.resolution.resolutionId;
 await deny(reviews.verifyRefund(H('operator'),rNU,verifyBody(1),K()),403,'SAAS_FORBIDDEN');
 await deny(reviews.verifyRefund(H('owner'),rNU,verifyBody(1),K()),422,'SAAS_REFUND_EVIDENCE_MISSING');
 assert.ok((await deliver(sim.refund(null,paidNU.invoice,10000))).event);
 await deny(reviews.verifyRefund(H('owner'),rNU,verifyBody(1),K()),422,'SAAS_REFUND_INCOMPLETE');
 assert.equal((await row('SELECT status FROM hon.saas_paid_review_resolutions WHERE id=$1',[rNU])).status,'AWAITING_REFUND_EVIDENCE','a partial refund writes nothing');
 assert.ok((await deliver(sim.refund(null,paidNU.invoice,18300))).event);
 await deny(reviews.verifyRefund(H('owner'),rNU,verifyBody(2),K()),409,'SAAS_VERSION_CONFLICT');
 const kV=K(),verifiedNU=await reviews.verifyRefund(H('owner'),rNU,verifyBody(1),kV);
 assert.deepEqual([verifiedNU.resolution.status,verifiedNU.resolution.refundedAmountMinor,verifiedNU.resolution.refundEvidence.length,verifiedNU.billingStatus,verifiedNU.billingReviewOpen,verifiedNU.replayed],
  ['REFUND_VERIFIED',18300,2,'PAID_NEEDS_REVIEW',false,false]);
 assert.equal((await reviews.verifyRefund(H('owner'),rNU,verifyBody(1),kV)).replayed,true);
 await deny(reviews.verifyRefund(H('owner'),rNU,verifyBody(2),K()),422,'SAAS_REVIEW_NOT_RESOLVABLE');
 assert.equal(await conflict('NU'),null,'only a verified full refund clears the hold');
 assert.equal(await itemOf(coNU.checkout.checkoutId),undefined,'a verified item leaves the queue');
 const owedNS=await reviews.resolve(H('owner'),resolveBody(coNS.checkout.checkoutId,itemNS.subjectVersion),K());
 assert.equal((await reviews.verifyRefund(H('owner'),owedNS.resolution.resolutionId,verifyBody(1),K())).resolution.status,'REFUND_VERIFIED');
 assert.equal(await conflict('NS'),null);
 assert.deepEqual((await admin.query("SELECT action_code,count(*)::int n FROM hon.saas_audit WHERE action_code LIKE 'saas.paid_review.%' GROUP BY 1 ORDER BY 1")).rows,
  [{action_code:'saas.paid_review.resolve',n:2},{action_code:'saas.paid_review.verify_refund',n:2}]);
 assert.equal((await row("SELECT count(*)::int n FROM hon.saas_outbox WHERE event_type IN ('saas.paid_review.resolved','saas.paid_review.refund_verified') AND payload->>'executionAllowed'='false'")).n,4);
 for(const q of ['UPDATE hon.saas_paid_review_resolutions SET reason=reason','DELETE FROM hon.saas_paid_review_resolutions','TRUNCATE hon.saas_paid_review_resolutions']){
  await admin.query('BEGIN');await sqlDeny(admin.query(q),'42501');await admin.query('ROLLBACK');}
 await sqlDeny(restricted.query('SELECT * FROM hon.saas_paid_review_resolutions'),'42501');
 await sqlDeny(restricted.query('SELECT hon.saas_paid_review_items($1,$2)',['V1_CHECKOUT',coNU.checkout.checkoutId]),'42501');
 // A dispute after a verified refund reopens the subject: listed again with the dispute blocker, and the org hold returns.
 // One-time payment: matched by payment intent. Subscription mode: the dispute has no invoice, so it is matched through
 // the charge of the matched refund.
 assert.ok((await deliver(sim.dispute(paidNS.paymentIntent,950000))).event);
 const chargeNU=(await row("SELECT normalized->'object'->>'chargeRef' AS c FROM hon.saas_provider_events WHERE event_type='charge.refunded' AND normalized->'object'->>'invoiceRef'=$1 LIMIT 1",[paidNU.invoice])).c;
 assert.ok(chargeNU);
 assert.ok((await deliver(sim.dispute(null,18300,chargeNU))).event);
 for(const[k,co]of [['NS',coNS],['NU',coNU]]){
  const again=await itemOf(co.checkout.checkoutId);
  assert.deepEqual([again?.blocker,again?.allowedDecisions,again?.openResolution],['DISPUTE_POLICY_REQUIRED',[],null],`${k}: a later dispute lists the checkout again`);
  assert.equal(await conflict(k),'PAID_NEEDS_REVIEW',`${k}: a later dispute restores the billing hold`);
 }
 await deny(reviews.resolve(H('owner'),resolveBody(coNS.checkout.checkoutId,(await itemOf(coNS.checkout.checkoutId)).subjectVersion),K()),422,'SAAS_REVIEW_NOT_RESOLVABLE');

 // ---------- 8. an existing provisioned COMPLETE school still buys through the 0182 path, unchanged ----------
 const coP=await payments.startSchoolHonOsCheckout(H('taken'),P.school,{offerId:V.OS_MONTHLY},K());
 assert.deepEqual(await outcome(sim.completeCheckout(sessionOf(coP)).completed),['APPLIED','SUBSCRIPTION_ACTIVATED']);
 assert.deepEqual(await ent(P.id),entP0,'a purchase never changes a provisioned entitlement');
 assert.equal((await access.readOrganizationAccess(H('operator'),P.id)).state,'PROVISIONED');

 // ---------- 9. evidence, no unintended effect, restore the shipped state ----------
 const activated=['NM','NA','NP','NC','NX','NI','NFA','NFL','NFM',lifeWinner];
 assert.equal((await row("SELECT count(*)::int n FROM hon.saas_access_transitions WHERE kind='FIRST_PAYMENT_ACTIVATION' AND outcome='APPLIED'")).n,activated.length);
 assert.equal((await row("SELECT count(*)::int n FROM hon.saas_subscriptions WHERE organization_id=ANY($1::uuid[]) AND status<>'VOIDED'",[activated.map(org)])).n,activated.length,'one subscription each');
 assert.deepEqual((await admin.query("SELECT count(*)::int n FROM hon.saas_credit_allowances WHERE organization_id=ANY($1::uuid[])",[fixtureOrgs()])).rows[0].n,0,
  'no AI credits granted while the credit program is active');
 assert.deepEqual((await admin.query("SELECT DISTINCT action_code FROM hon.saas_audit WHERE action_code LIKE 'saas.access.%' ORDER BY 1")).rows.map(r=>r.action_code),['saas.access.initialize','saas.access.retry']);
 assert.deepEqual((await admin.query("SELECT DISTINCT event_type FROM hon.saas_outbox WHERE event_type LIKE 'saas.access.%' ORDER BY 1")).rows.map(r=>r.event_type),['saas.access.initialized','saas.access.retried']);
 assert.equal((await row("SELECT count(*)::int n FROM hon.saas_audit WHERE action_code='saas.access.initialize'")).n,NEW.length,'one audited registration per school; replays add none');
 for(const k of ['NZ','NE',lifeLoser,'NS','NU'])await assertAwaiting(k);
 assert.deepEqual(await untouched(),before,'no other organization, school billing or Champions effect');
 await setAccessProgram(false);
 programTouched=false;
 assert.deepEqual((await admin.query('SELECT status,mutations_enabled FROM hon.saas_access_program')).rows,[{status:'INACTIVE',mutations_enabled:false}]);
 assert.equal((await admin.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='saas_access_program_status_check'")).rows[0].d,STATUS_CHECK);
 await deny(startOf('NZ',V.OS_MONTHLY),422,'SAAS_ENTITLEMENT_NOT_ACTIVE');
 await v1Gate(true);
 assert.equal((await admin.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='hon.saas_checkout_sessions'::regclass AND tgname='saas_hon_os_v1_offer_kind'")).rows[0].tgenabled,'O','0237 v1 founder/lifetime refusal restored');
 console.log('PASS: HON OS new-school onboarding (0183, D7) proof (paid access INACTIVE as shipped; ACTIVE simulated in the disposable database only, then restored; TEST MODE, SIMULATED Stripe) — registration refused while inactive; private registration with closed input, one school per verified identity (idempotent, concurrent-safe), entitlement held SUSPENDED with no capabilities or staff scope; a school awaiting its first payment buys a HQ-published HON OS offer without an active entitlement; the verified payment activates COMPLETE once for monthly, annual auto-renewing, annual prepaid, founder annual, founder monthly, founder lifetime and lifetime offers (concurrent duplicate deliveries, out-of-order first invoice, replay); failed async, cancelled and expired first payments leave the school awaiting and free to retry, late payments go to review; one checkout per school under concurrency; payments held while paid access was inactive are retried by the HQ owner only, re-checking the sale limit (SALE_LIMIT_REACHED), founder pool (FOUNDER_UNAVAILABLE) and refunds; provisioned schools unchanged; no AI credits opened.');
}finally{
 await v1Gate(true).catch(()=>{});
 if(programTouched)await setAccessProgram(false).catch(e=>console.error('RESTORE FAILED',e));
 await cleanup().catch(e=>console.error(e));
 await Promise.allSettled([admin.end(),restricted.end(),pool.end(),database.onModuleDestroy?.()]);
}
