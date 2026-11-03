import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifySaasBillingSecurity } from './saas-billing-security.mjs';
// CW1 HON OS creative credit wallet (0202) integrity proof. DISPOSABLE DATABASE ONLY, TEST MODE, SIMULATED
// provider results. Paid access ships INACTIVE; like the 0183 onboarding proof this simulates ACTIVE in the
// disposable database only (to register and pay two brand-new HON OS schools through the real simulated Stripe
// path) and restores the shipped state before it ends. The creative program ships INACTIVE and is activated
// here by the fixture HQ owner only. No generation provider is called: every provider outcome and cost is a
// synthetic value written by this proof. No card is charged: top-up fulfillment runs the internal contract with
// synthetic STRIPE_SIMULATED payment facts.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
process.env.HON_RUNTIME_DATABASE_POOL_MAX='10';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasCreativeWalletService}=await import('../../../apps/api/dist/saas-billing/saas-creative-wallet.service.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {StripeTestModeAdapter}=await import('../../../apps/api/dist/payments/stripe-test-mode-adapter.js');
const {StripeSimulator}=await import('../../../apps/api/dist/payments/stripe-simulator.js');
const contracts=await import('@hon/contracts');
const SECRET='whsec_disposableFixtureSecret0123456789',KEY='sk_test_disposableFixtureKey0123456789';
const sim=new StripeSimulator(SECRET);
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),wallet=new SaasCreativeWalletService(billing);
const payments=new SaasPaymentsService(billing,database,new StripeTestModeAdapter({secretKey:KEY,webhookSecret:SECRET,provider:'STRIPE_SIMULATED',transport:sim.transport}));
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const ownerPool=new pg.Pool({connectionString:owner.toString(),ssl:false,max:5});
const creativeTables=['saas_creative_cost_events','saas_creative_ledger','saas_creative_reservations','saas_creative_lots','saas_creative_adjustments','saas_creative_topup_purchases',
 'saas_creative_wallets','saas_creative_rates','saas_creative_rate_versions'];
const offerTables=['saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const saasTables=['saas_access_transitions','saas_access_states','saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions',
 'saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions',
 'saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions',...offerTables];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code,e.stack);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code='42501',message)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);if(message)assert.equal(e.message,message);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
// A and B: brand-new HON OS schools that pay through simulated Stripe. Z registers but never pays. P is an HQ-provisioned
// COMPLETE school with no paid access (like a pilot, trial or exception school: never PAYMENT_ACTIVE).
const humans=Object.fromEntries(['owner','operator','support','staffP','ownerA','ownerB','ownerZ'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`cw1-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
const P={id:randomUUID(),school:randomUUID(),role:randomUUID()};
const S={},created=[];
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
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 const orgs=[...fixtureOrgs(),...(await admin.query("SELECT s.organization_id id FROM hon.saas_access_transitions s WHERE s.reason='NEW_SCHOOL_REGISTERED'").catch(()=>({rows:[]}))).rows.map(r=>r.id)];
 await admin.query('BEGIN');try{
  const all=[...creativeTables,'saas_creative_program',...saasTables,'saas_credit_program','saas_reward_fulfillment','saas_payment_program'];
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of creativeTables)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query("UPDATE hon.saas_creative_program SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query('DELETE FROM hon.ai_usage_ledger WHERE organization_id=ANY($1::uuid[])',[orgs]);
  for(const t of saasTables)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query("UPDATE hon.saas_credit_program SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query("UPDATE hon.saas_payment_program SET status='DISABLED',provider=NULL,test_tax_reference=NULL,authorization_reference=NULL,version=1,changed_by_principal_id=NULL");
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  if(createdProvider)await admin.query("DELETE FROM hon.hq_ai_provider_connections WHERE provider_id='HIGGSFIELD'");
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const details=k=>({legalName:`CW1 Fixture Dojo ${k} LLC`,displayName:`CW1 Dojo ${k}`,schoolName:`CW1 Dojo ${k} Main`,schoolSlug:`cw1-dojo-${k.toLowerCase()}`,timezone:'America/Chicago'});
const register=(who,p)=>admin.query('SELECT hon.initialize_saas_hon_os_school_account($1,$2::jsonb,$3,$4,$5) r',[H(who),JSON.stringify(p),K(),K(),K()]).then(r=>r.rows[0].r);
const deliver=d=>payments.handleWebhook(d.raw,d.signature);
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const n=async(sql,params)=>(await row(sql,params)).n;
const org=k=>S[k].organizationId,school=k=>S[k].schoolId;
const offer=(code,kind,priceMinor,displayName)=>{const interval=contracts.saasHonOsOfferBillingInterval(kind);return{offerCode:code,offerKind:kind,displayName,priceMinor,
 salesOpensAt:iso(NOW-HOUR),salesClosesAt:null,eligibility:'ANY_ACTIVE_ORGANIZATION',saleLimit:null,priceLock:'WHILE_CONTINUOUSLY_SUBSCRIBED',priceLockMonths:null,
 annualRenewal:interval==='ANNUAL'?'AUTO_RENEW_AT_LOCKED_PRICE':null,plannedMonthlyPremiumCredits:12000,aiFairUseReference:null,refundWindowDays:30,cancellationTiming:'END_OF_PAID_PERIOD'};};
const schoolWallet=k=>wallet.readSchoolWallet(H(`owner${k}`),school(k));
const hqWallet=k=>wallet.readSchoolWalletFromHq(H('owner'),school(k));
const video=(units,key=K(),who='ownerA',k='A')=>wallet.reserveCredits(H(who),school(k),{operationCode:'video.generate',units,providerId:'HIGGSFIELD',modelCode:'fixture-video-1'},key);
const settle=(r,body,key=K(),who='ownerA')=>wallet.settleCredits(H(who),r.reservationId,{expectedVersion:r.version,...body},key);
const usage=async ids=>(await admin.query('SELECT provider_code,modality::text,customer_credits::int,provider_cost_microunits::bigint cost,output_units::int units,correlation_id FROM hon.ai_usage_ledger WHERE correlation_id=ANY($1::uuid[]) ORDER BY occurred_at,id',[ids])).rows;
const ledgerTotals=async o=>(await admin.query("SELECT entry_kind,sum(credits)::int c FROM hon.saas_creative_ledger WHERE school_id=$1 GROUP BY 1 ORDER BY 1",[o])).rows.reduce((a,r)=>({...a,[r.entry_kind]:r.c}),{});
const fulfill=(purchaseId,payment,at=new Date(),client=ownerPool)=>client.query('SELECT hon.saas_fulfill_creative_topup($1,$2::jsonb,$3) r',[purchaseId,JSON.stringify(payment),at]).then(r=>r.rows[0].r);
const creativeAudit=async()=>(await admin.query("SELECT action_code,count(*)::int c FROM hon.saas_audit WHERE action_code LIKE 'saas.creative.%' GROUP BY 1 ORDER BY 1")).rows.reduce((a,r)=>({...a,[r.action_code]:r.c}),{});
const creativeOutbox=async()=>(await admin.query("SELECT count(*)::int n FROM hon.saas_outbox WHERE event_type LIKE 'saas.creative.%'")).rows[0].n;

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 await cleanup();

 // ---------- 0. posture: shipped INACTIVE, 12,000 monthly, approved packages, deny-all tables, internal-only fulfillment ----------
 assert.deepEqual((await admin.query('SELECT status,version,monthly_included_credits FROM hon.saas_creative_program')).rows,[{status:'INACTIVE',version:1,monthly_included_credits:12000}]);
 await sqlDeny(admin.query("UPDATE hon.saas_creative_program SET monthly_included_credits=13000"),'42501','SAAS_TRANSITION_NOT_ALLOWED');
 await sqlDeny(admin.query("INSERT INTO hon.saas_creative_program(program_id,status,version,monthly_included_credits,changed_at) VALUES(1,'INACTIVE',1,13000,now())"),'23514');
 assert.deepEqual((await admin.query('SELECT package_code,base_credits,bonus_credits,price_minor,currency FROM hon.saas_creative_topup_packages ORDER BY price_minor')).rows,
  [{package_code:'STARTER',base_credits:3000,bonus_credits:0,price_minor:3000,currency:'usd'},{package_code:'GROWTH',base_credits:6000,bonus_credits:1200,price_minor:6000,currency:'usd'},
   {package_code:'CREATOR',base_credits:12000,bonus_credits:4800,price_minor:12000,currency:'usd'}],'owner-approved $30/$60/$120 packages');
 await sqlDeny(admin.query("UPDATE hon.saas_creative_topup_packages SET bonus_credits=0"));
 for(const t of ['saas_creative_program','saas_creative_wallets','saas_creative_lots','saas_creative_ledger','saas_creative_reservations','saas_creative_topup_purchases','saas_creative_adjustments','saas_creative_rates'])
  await sqlDeny(restricted.query(`SELECT 1 FROM hon.${t} LIMIT 1`));
 for(const sig of ['saas_fulfill_creative_topup(uuid,jsonb,timestamptz)','saas_creative_open_window(uuid,uuid,timestamptz)','saas_creative_settle_lots(hon.saas_creative_reservations,integer,uuid,timestamptz)',
  'saas_creative_lock_wallet(uuid,timestamptz)','saas_creative_record_usage(hon.saas_creative_reservations,uuid,bigint,integer)','saas_creative_expire_lots(uuid,uuid,timestamptz)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);
 await sqlDeny(restricted.query("SELECT hon.saas_fulfill_creative_topup(gen_random_uuid(),'{}'::jsonb,now())"));
 await verifySaasBillingSecurity(admin,'hon_champions_runtime');

 // ---------- fixture: identities, a provisioned school, catalog, offers, test-mode payments, cost evidence ----------
 await admin.query('BEGIN');
 if((await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state) VALUES('HIGGSFIELD','Fixture provider','DISABLED') ON CONFLICT DO NOTHING RETURNING provider_id")).rowCount)createdProvider=true;
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[who,hqRole,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['support','HON_HQ_SUPPORT',['hq.billing.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,hqRole,perms]);
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'CW1 Fixture Provisioned','CW1 Fixture Provisioned')",[P.id]);
 await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'COMPLETE',clock_timestamp()-interval '90 days')",[P.id]);
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Provisioned School',$1::text,'America/New_York')",[P.school,P.id]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[P.role,P.id]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[P.role,P.id]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[P.id,P.school,humans.staffP.id,P.role]);
 await admin.query('COMMIT');
 const d=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
 d.termsReference='Fixture HON plan terms (not customer terms)';
 d.founderProgram={...d.founderProgram,eligibility:'ANY_ACTIVE_ORGANIZATION',opensAt:iso(NOW-HOUR)};
 await billing.publishCatalog(H('owner'),(await billing.createCatalogDraft(H('owner'),d,K())).catalog.catalogId,K());
 const pub=await billing.publishOfferSet(H('owner'),...await(async()=>{const dr=await billing.createOfferSetDraft(H('owner'),{basedOnSetId:null,
   termsReference:'Fixture HON OS terms v1 (not customer terms)',founderTotalLimit:3,offers:[offer('OS_MONTHLY','REGULAR_MONTHLY',24900,'Monthly')]},K());
  return[dr.set.setId,{expectedRevision:dr.set.revision,previewDigest:dr.preview.previewDigest,approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K()];})());
 const MONTHLY=pub.set.offers[0].offerId;
 await payments.setPaymentProgram(H('owner'),{action:'ENABLE_TEST_MODE',expectedVersion:1,authorizationReference:'Fixture owner test-mode authorization (disposable)',
  provider:'STRIPE_SIMULATED',testTaxReference:'TEST MODE: no tax collected; TAXES undecided (fixture)'},K());
 const videoCost=(await billing.recordCostEvidence(H('owner'),{providerId:'HIGGSFIELD',modelCode:'fixture-video-1',costUnit:'VIDEO_SECOND',measuredUnits:600,billedCostMicrounits:120_000_000,
  fullyLoadedCostMicrounits:150_000_000,evidenceReference:'FIXTURE-CW1-VIDEO-COST',periodStart:iso(NOW-40*DAY),periodEnd:iso(NOW-10*DAY),note:null},K())).costEvidence;
 await setAccessProgram(true);
 for(const k of ['A','B','Z']){S[k]=await register(`owner${k}`,details(k));created.push(S[k].organizationId);}
 for(const k of ['A','B']){
  const co=await payments.startSchoolHonOsCheckout(H(`owner${k}`),school(k),{offerId:MONTHLY},K());
  const paid=sim.completeCheckout(co.checkout.providerSessionId);
  assert.deepEqual([(await deliver(paid.completed)).event.detail],['ACCESS_ACTIVATED'],`${k} paid`);
  S[k].paid=paid;
 }
 const agentCreditRows=async()=>n("SELECT (SELECT count(*) FROM hon.saas_credit_allowances)+(SELECT count(*) FROM hon.saas_credit_reservations)+(SELECT count(*) FROM hon.saas_credit_ledger) n");
 const agentBefore=await agentCreditRows();
 const checkoutsBefore=await n('SELECT count(*)::int n FROM hon.saas_checkout_sessions');

 // ---------- 1. program INACTIVE: reads work, nothing is granted, reserved or purchased ----------
 let w=await schoolWallet('A');
 assert.deepEqual([w.program.status,w.eligibility.reason,w.balance.availableCredits,w.lots.length,w.rates,w.agentConversationsDeductCredits,w.paymentsActive,w.walletVersion],
  ['INACTIVE','PROGRAM_INACTIVE',0,0,null,false,false,null]);
 assert.deepEqual(w.packages.map(p=>[p.packageCode,p.priceMinor,p.totalCredits]),[['STARTER',3000,3000],['GROWTH',6000,7200],['CREATOR',12000,16800]]);
 await deny(wallet.openWindow(H('ownerA'),school('A'),K()),422,'SAAS_CREATIVE_PROGRAM_INACTIVE');
 await deny(video(1),422,'SAAS_CREATIVE_PROGRAM_INACTIVE');
 await deny(wallet.createTopupPurchase(H('ownerA'),school('A'),{packageCode:'STARTER'},K()),422,'SAAS_CREATIVE_PROGRAM_INACTIVE');

 // ---------- 2. HQ owner only: rates (configurable, provisional unless cost-verified) then activation ----------
 const PROGRAM={action:'ACTIVATE',expectedVersion:1,authorizationReference:'Fixture owner creative authorization (disposable)'};
 await deny(wallet.setProgram(H('owner'),PROGRAM,K()),422,'SAAS_CREATIVE_RATES_NOT_PUBLISHED');
 const RATES={termsReference:'Fixture provisional creative rates v1 (not final prices)',rates:[
  {operationCode:'image.generate',mediaKind:'IMAGE',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,costEvidenceId:null},
  {operationCode:'video.generate',mediaKind:'VIDEO',displayName:'AI video',billingUnit:'VIDEO_SECOND',creditsPerUnit:50,maxUnitsPerRequest:60,costEvidenceId:videoCost.costEvidenceId}]};
 for(const who of ['operator','support','ownerA'])await deny(wallet.publishRates(H(who),RATES,K()),403,'SAAS_FORBIDDEN');
 await deny(wallet.publishRates(H('owner'),{...RATES,rates:[{...RATES.rates[0],billingUnit:'VIDEO_SECOND'}]},K()),400,'INVALID_SAAS_INPUT');
 await deny(wallet.publishRates(H('owner'),{...RATES,rates:[{...RATES.rates[0],costEvidenceId:videoCost.costEvidenceId}]},K()),422,'SAAS_PRICING_COST_EVIDENCE_MISMATCH');
 const r1=await wallet.publishRates(H('owner'),{...RATES,rates:[{...RATES.rates[0],creditsPerUnit:12}]},K());
 const r2=await wallet.publishRates(H('owner'),RATES,K());
 assert.deepEqual([r2.rates.rateVersion,r2.retiredRateVersionId,r2.rates.rates.map(r=>[r.operationCode,r.creditsPerUnit,r.rateBasis])],
  [2,r1.rates.rateVersionId,[['image.generate',10,'PROVISIONAL'],['video.generate',50,'VERIFIED_COST']]],'a new rate card replaces the old one; costs are configurable');
 for(const who of ['operator','ownerA'])await deny(wallet.setProgram(H(who),PROGRAM,K()),403,'SAAS_FORBIDDEN');
 const progKey=K();
 assert.equal((await wallet.setProgram(H('owner'),PROGRAM,progKey)).program.status,'ACTIVE');
 assert.equal((await wallet.setProgram(H('owner'),PROGRAM,progKey)).replayed,true);
 await deny(wallet.setProgram(H('owner'),PROGRAM,K()),409,'SAAS_VERSION_CONFLICT');

 // ---------- 3. eligibility: only PAYMENT_ACTIVE HON OS schools with a verified paid period ----------
 await deny(wallet.openWindow(H('ownerZ'),school('Z'),K()),403,'SAAS_FORBIDDEN');// awaiting first payment: no staff scope at all
 await deny(wallet.openWindow(H('staffP'),P.school,K()),422,'SAAS_CREATIVE_PAID_ACCESS_REQUIRED');// provisioned/pilot/trial-like: never the paid allowance
 await deny(wallet.reserveCredits(H('staffP'),P.school,{operationCode:'image.generate',units:1,providerId:'HIGGSFIELD',modelCode:'fixture-image-1'},K()),422,'SAAS_CREATIVE_PAID_ACCESS_REQUIRED');
 await deny(wallet.createTopupPurchase(H('staffP'),P.school,{packageCode:'STARTER'},K()),422,'SAAS_CREATIVE_PAID_ACCESS_REQUIRED');
 const hqP=await wallet.readSchoolWalletFromHq(H('operator'),P.school);
 assert.deepEqual([hqP.eligibility.reason,hqP.lots.length],['PAID_ACCESS_REQUIRED',0]);
 for(const who of ['ownerB','owner','operator','staffP'])await deny(wallet.openWindow(H(who),school('A'),K()),403,'SAAS_FORBIDDEN');

 // ---------- 4. one included window grant per paid window, under concurrency and replay ----------
 const winKey=K();
 const opens=await Promise.allSettled([wallet.openWindow(H('ownerA'),school('A'),winKey),...Array.from({length:7},()=>wallet.openWindow(H('ownerA'),school('A'),K()))]);
 assert.equal(opens.filter(o=>o.status==='fulfilled').length,8,JSON.stringify(opens.map(o=>o.reason?.message)));
 const lotIds=new Set(opens.map(o=>o.value.lot.lotId));
 assert.equal(lotIds.size,1,'eight concurrent opens, one lot');
 const includedA=[...lotIds][0];
 assert.equal((await wallet.openWindow(H('ownerA'),school('A'),winKey)).replayed,true);
 assert.deepEqual(await ledgerTotals(school('A')),{GRANT:12000},'one 12,000 grant');
 const subA=await row("SELECT id,current_period_start,current_period_end FROM hon.saas_subscriptions WHERE organization_id=$1 AND status<>'VOIDED'",[org('A')]);
 const lotA=await row('SELECT * FROM hon.saas_creative_lots WHERE id=$1',[includedA]);
 assert.deepEqual([lotA.lot_kind,lotA.credits,lotA.window_index,lotA.subscription_id,iso(lotA.window_start),iso(lotA.window_end),iso(lotA.expires_at)],
  ['INCLUDED_MONTHLY',12000,0,subA.id,iso(subA.current_period_start),iso(subA.current_period_end),iso(subA.current_period_end)],'window = paid UTC month, expires at its end (no rollover)');
 await sqlDeny(admin.query("INSERT INTO hon.saas_creative_lots(school_id,organization_id,lot_kind,credits,subscription_id,window_index,window_start,window_end,expires_at,granted_by_principal_id,granted_at) VALUES($6,$1,'INCLUDED_MONTHLY',12000,$2,0,$3,$4,$4,$5,now())",
  [org('A'),subA.id,lotA.window_start,lotA.window_end,humans.owner.id,school('A')]),'23505');
 await wallet.openWindow(H('ownerB'),school('B'),K());
 const includedB=(await hqWallet('B')).lots[0].lotId;

 // ---------- 5. concurrent spending never overdraws ----------
 const race=await Promise.allSettled(Array.from({length:8},()=>video(60)));// 3,000 credits each against 12,000
 const won=race.filter(r=>r.status==='fulfilled').map(r=>r.value.reservation);
 assert.equal(won.length,4,'exactly four of eight 3,000-credit reservations fit 12,000');
 for(const r of race.filter(r=>r.status==='rejected'))http(422,'SAAS_CREDITS_EXHAUSTED')(r.reason);
 w=await schoolWallet('A');
 assert.deepEqual([w.balance.availableCredits,w.balance.heldCredits],[0,12000]);
 assert.ok(won.every(r=>r.lots.length===1&&r.lots[0].lotId===includedA&&r.rateBasis==='VERIFIED_COST'));
 const keyed=K(),first=await video(1,keyed).catch(e=>e);
 http(422,'SAAS_CREDITS_EXHAUSTED')(first);
 await deny(video(61),422,'SAAS_OPERATION_UNITS_EXCEEDED');
 await deny(wallet.reserveCredits(H('ownerA'),school('A'),{operationCode:'audio.generate',units:1,providerId:'HIGGSFIELD',modelCode:'m'},K()),422,'SAAS_OPERATION_NOT_PRICED');
 await deny(wallet.reserveCredits(H('ownerA'),school('A'),{operationCode:'image.generate',units:1,providerId:'NOT_CONNECTED_PROVIDER',modelCode:'m'},K()),422,'SAAS_PROVIDER_UNKNOWN');
 await deny(wallet.reserveCredits(H('ownerB'),school('A'),{operationCode:'image.generate',units:1,providerId:'HIGGSFIELD',modelCode:'m'},K()),403,'SAAS_FORBIDDEN');

 // ---------- 6. settlement: success, failure (cost kept), unknown; replay; only the requester ----------
 const [g1,g2,g3,g4]=won;
 const s1Key=K();
 const s1=await settle(g1,{outcome:'SUCCEEDED',finalUnits:40,providerCostMicrounits:9_100_000},s1Key);
 assert.deepEqual([s1.reservation.status,s1.reservation.finalCredits,s1.balance.availableCredits],['FINALIZED',2000,1000],'actual 2,000 consumed, 1,000 released');
 assert.equal((await settle(g1,{outcome:'SUCCEEDED',finalUnits:40,providerCostMicrounits:9_100_000},s1Key)).replayed,true);
 await deny(settle(g1,{outcome:'SUCCEEDED',finalUnits:40,providerCostMicrounits:9_100_000}),409,'SAAS_VERSION_CONFLICT');
 await deny(settle(g2,{outcome:'SUCCEEDED',finalUnits:61,providerCostMicrounits:1}),422,'SAAS_FINAL_EXCEEDS_RESERVATION');
 await deny(settle(g2,{outcome:'FAILED',finalUnits:null,providerCostMicrounits:null},K(),'ownerB'),403,'SAAS_FORBIDDEN');
 const s2=await settle(g2,{outcome:'FAILED',finalUnits:null,providerCostMicrounits:420_000});
 assert.deepEqual([s2.reservation.status,s2.reservation.statusReason,s2.balance.availableCredits],['RELEASED','PROVIDER_FAILED',4000],'failed: nothing consumed, cost still recorded');
 const s3=await settle(g3,{outcome:'UNKNOWN',finalUnits:null,providerCostMicrounits:null});
 assert.deepEqual([s3.reservation.status,s3.balance.heldCredits],['OUTCOME_UNKNOWN',6000],'unknown stays held');
 const s4=await settle(g4,{outcome:'SUCCEEDED',finalUnits:60,providerCostMicrounits:13_650_000});
 assert.deepEqual([s4.balance.availableCredits,s4.balance.heldCredits],[4000,3000]);

 // ---------- 7. HQ owner resolves UNKNOWN and a stuck in-flight reservation with evidence ----------
 const g5=(await video(20)).reservation;// 1,000 held, never settled by the runtime
 for(const who of ['operator','ownerA'])await deny(wallet.resolveReservation(H(who),g3.reservationId,{resolution:'NOT_CHARGED',expectedVersion:2,finalUnits:null,providerCostMicrounits:0,evidenceReference:'FIXTURE-CW1-RESOLVE'},K()),403,'SAAS_FORBIDDEN');
 const res3=await wallet.resolveReservation(H('owner'),g3.reservationId,{resolution:'SUCCEEDED',expectedVersion:2,finalUnits:10,providerCostMicrounits:2_275_000,evidenceReference:'FIXTURE-CW1-PROVIDER-LOG-3'},K());
 assert.deepEqual([res3.reservation.status,res3.reservation.statusReason,res3.reservation.finalCredits,res3.reservation.providerCostMicrounits],['FINALIZED','HQ_RESOLVED_SUCCEEDED',500,2_275_000]);
 const res5=await wallet.resolveReservation(H('owner'),g5.reservationId,{resolution:'NOT_CHARGED',expectedVersion:1,finalUnits:null,providerCostMicrounits:0,evidenceReference:'FIXTURE-CW1-NO-JOB-5'},K());
 assert.deepEqual([res5.reservation.status,res5.reservation.usageId],['RELEASED',null]);
 await deny(settle(g5,{outcome:'SUCCEEDED',finalUnits:20,providerCostMicrounits:1}),409,'SAAS_VERSION_CONFLICT');// the requester can no longer double-apply
 w=await schoolWallet('A');
 assert.deepEqual([w.balance.availableCredits,w.balance.heldCredits],[12000-2000-3000-500,0]);
 assert.ok(!('providerId' in w.reservations[0])&&!('providerCostMicrounits' in w.reservations[0])&&!('providerExpense' in w),'school views carry no provider cost');

 // ---------- 8. provider expense tracked independently; agent budget and AI team conversations untouched ----------
 const ids=[g1,g2,g3,g4,g5].map(r=>r.reservationId);
 const u=await usage(ids);
 assert.deepEqual(u.map(x=>[x.provider_code,x.modality,x.customer_credits,Number(x.cost),x.units]),
  [['HIGGSFIELD','VIDEO',0,9_100_000,40],['HIGGSFIELD','VIDEO',0,420_000,0],['HIGGSFIELD','VIDEO',0,13_650_000,60],['HIGGSFIELD','VIDEO',0,2_275_000,10]],
  'one usage row per charged outcome, customer_credits 0 (never against the agent ceiling); no row for a zero-cost NOT_CHARGED');
 const hqA=await hqWallet('A');
 assert.deepEqual([hqA.providerExpense.actualProviderCostMicrounits,hqA.providerExpense.finalizedProviderCostMicrounits,hqA.providerExpense.failedOrNotChargedProviderCostMicrounits,hqA.providerExpense.consumedCredits],
  [25_445_000,25_025_000,420_000,5500],'actual expense is separate from credits deducted');
 assert.equal(await agentCreditRows(),agentBefore,'no B3 agent allowance, reservation or ledger row');

 // ---------- 9. HQ owner grants, adjustments and corrections (no preset limit; idempotent; audited) ----------
 const promo={kind:'PROMOTIONAL',credits:1000,reasonCode:'PROMOTION',note:'Fixture launch promotion'};
 for(const who of ['operator','support','ownerA'])await deny(wallet.grantCredits(H(who),school('A'),promo,K()),403,'SAAS_FORBIDDEN');
 await deny(wallet.grantCredits(H('owner'),school('A'),{...promo,credits:0},K()),400,'INVALID_SAAS_INPUT');
 const gKey=K(),gp=await wallet.grantCredits(H('owner'),school('A'),promo,gKey);
 assert.deepEqual([gp.adjustment.lot.kind,gp.adjustment.lot.credits,gp.adjustment.lot.expiresAt],['PROMOTIONAL',1000,null]);
 assert.equal((await wallet.grantCredits(H('owner'),school('A'),promo,gKey)).replayed,true);
 await deny(wallet.grantCredits(H('owner'),school('A'),{...promo,credits:999},gKey),409,'IDEMPOTENCY_KEY_REUSED');
 const big=await wallet.grantCredits(H('owner'),school('A'),{kind:'ADJUSTMENT',credits:50_000_000,reasonCode:'SERVICE_RECOVERY',note:'Fixture large adjustment (no preset cap)'},K());
 await deny(wallet.debitLot(H('operator'),big.adjustment.lot.lotId,{credits:1,reasonCode:'RECORDED_IN_ERROR',note:'x'},K()),403,'SAAS_FORBIDDEN');
 await deny(wallet.debitLot(H('owner'),big.adjustment.lot.lotId,{credits:50_000_001,reasonCode:'RECORDED_IN_ERROR',note:'Too much'},K()),422,'SAAS_CREATIVE_DEBIT_EXCEEDS_AVAILABLE');
 const db1=await wallet.debitLot(H('owner'),big.adjustment.lot.lotId,{credits:49_999_000,reasonCode:'RECORDED_IN_ERROR',note:'Fixture correction of an over-grant'},K());
 assert.deepEqual([db1.adjustment.lot.availableCredits,db1.adjustment.lot.debitedCredits],[1000,49_999_000]);
 const db2=await wallet.debitLot(H('owner'),includedA,{credits:5500,reasonCode:'BILLING_CORRECTION',note:'Fixture correction of included credits'},K());
 assert.equal(db2.adjustment.lot.availableCredits,1000);
 await deny(wallet.grantCredits(H('owner'),randomUUID(),promo,K()),404,'SAAS_UNAVAILABLE');

 // ---------- 10. top-ups: recorded intent; internal TEST MODE fulfillment; exactly-once credits; mismatch held ----------
 await deny(wallet.createTopupPurchase(H('ownerB'),school('A'),{packageCode:'GROWTH'},K()),403,'SAAS_FORBIDDEN');
 await deny(wallet.createTopupPurchase(H('ownerA'),school('A'),{packageCode:'GROWTH',priceMinor:1},K()),400,'INVALID_SAAS_INPUT');
 const pKey=K(),pg1=await wallet.createTopupPurchase(H('ownerA'),school('A'),{packageCode:'GROWTH'},pKey);
 assert.deepEqual([pg1.purchase.status,pg1.purchase.priceMinor,pg1.purchase.baseCredits,pg1.purchase.bonusCredits,pg1.purchase.payment,pg1.purchase.lotId],
  ['PENDING_PAYMENT',6000,6000,1200,'NOT_CONNECTED',null]);
 assert.equal((await wallet.createTopupPurchase(H('ownerA'),school('A'),{packageCode:'GROWTH'},pKey)).replayed,true);
 assert.equal(await n('SELECT count(*)::int n FROM hon.saas_checkout_sessions'),checkoutsBefore,'no checkout created, no card charged');
 const pay=(ref,amount=6000,patch={})=>({provider:'STRIPE_SIMULATED',paymentRef:ref,amountMinor:amount,currency:'usd',livemode:false,...patch});
 await sqlDeny(fulfill(pg1.purchase.purchaseId,pay('pi_cw1live',6000,{livemode:true})),'42501','SAAS_PROVIDER_LIVE_MODE_REFUSED');
 await sqlDeny(fulfill(pg1.purchase.purchaseId,pay('pi_cw1real',6000,{provider:'STRIPE'})),'42501','SAAS_PAYMENTS_NOT_ACTIVE');
 const REF='pi_cw1Growth0001';
 const fs=await Promise.allSettled(Array.from({length:5},()=>fulfill(pg1.purchase.purchaseId,pay(REF))));
 const ok=fs.filter(f=>f.status==='fulfilled').map(f=>f.value);
 assert.ok(ok.length>=1,JSON.stringify(fs.map(f=>f.reason?.message)));
 for(const f of fs.filter(f=>f.status==='rejected'))assert.ok(['55P03','40001','23505'].includes(f.reason.code),f.reason.stack);// in-flight duplicates are told to retry
 assert.equal(ok.filter(r=>!r.replayed).length,1,'one fulfillment');
 assert.equal(new Set(ok.map(r=>r.lotId)).size,1);
 const purchasedLot=ok[0].lotId;
 assert.equal((await fulfill(pg1.purchase.purchaseId,pay(REF))).replayed,true);
 const dup=await fulfill(pg1.purchase.purchaseId,pay('pi_cw1Growth0002'));
 assert.deepEqual([dup.outcome,dup.lotId],['DUPLICATE_PAYMENT_REVIEW',null],'a second payment for the same purchase never grants again');
 assert.equal(await n("SELECT count(*)::int n FROM hon.saas_creative_lots WHERE lot_kind='PURCHASED_TOPUP' AND school_id=$1",[school('A')]),1);
 const pl=await row('SELECT credits,base_credits,bonus_credits,expires_at FROM hon.saas_creative_lots WHERE id=$1',[purchasedLot]);
 assert.deepEqual(pl,{credits:7200,base_credits:6000,bonus_credits:1200,expires_at:null},'purchased credits keep base and bonus separately; no invented expiry');
 const pg2=await wallet.createTopupPurchase(H('ownerA'),school('A'),{packageCode:'STARTER'},K());
 const mm=await fulfill(pg2.purchase.purchaseId,pay('pi_cw1Starter0001',2999));
 assert.deepEqual([mm.outcome,mm.lotId,mm.purchase.statusReason],['NEEDS_REVIEW',null,'AMOUNT_MISMATCH']);
 await sqlDeny(fulfill(pg2.purchase.purchaseId,pay(REF)),'23505');// a payment reference already used for another purchase
 await deny(wallet.debitLot(H('owner'),purchasedLot,{credits:1,reasonCode:'BILLING_CORRECTION',note:'Not allowed'},K()),422,'SAAS_CREATIVE_PURCHASED_LOT_PROTECTED');

 // ---------- 11. consumption order: included, then promotional/adjustment, then purchased ----------
 const c1=(await video(60)).reservation;// 3,000: included 1,000 + promotional 1,000 + adjustment 1,000
 const kinds=async r=>(await Promise.all(r.lots.map(async l=>[(await row('SELECT lot_kind FROM hon.saas_creative_lots WHERE id=$1',[l.lotId])).lot_kind,l.reservedCredits])));
 assert.deepEqual(await kinds(c1),[['INCLUDED_MONTHLY',1000],['PROMOTIONAL',1000],['ADJUSTMENT',1000]]);
 const c2=(await video(60)).reservation;
 assert.deepEqual(await kinds(c2),[['PURCHASED_TOPUP',3000]]);
 w=await schoolWallet('A');
 assert.deepEqual([w.balance.availableCredits,w.balance.heldCredits],[4200,6000]);

 // ---------- 12. program deactivation stops new spending; in-flight settlement still records cost ----------
 await wallet.setProgram(H('owner'),{action:'DEACTIVATE',expectedVersion:2,authorizationReference:'Fixture owner pause (disposable)'},K());
 await deny(video(1),422,'SAAS_CREATIVE_PROGRAM_INACTIVE');
 await settle(c2,{outcome:'FAILED',finalUnits:null,providerCostMicrounits:0});
 await wallet.setProgram(H('owner'),{action:'ACTIVATE',expectedVersion:3,authorizationReference:'Fixture owner resume (disposable)'},K());

 // ---------- 13. monthly renewal: no next window until the next period is paid; unused included credits expire ----------
 const T1=new Date(new Date(subA.current_period_end).getTime()+HOUR);
 await admin.query('BEGIN');
 await admin.query('SELECT hon.saas_creative_lock_wallet($1,$2)',[school('A'),T1]);
 assert.equal((await row('SELECT hon.saas_creative_eligibility($1,$2) e',[school('A'),T1])).e.reason,'WINDOW_UNAVAILABLE');// monthly windows follow the renewed (paid) subscription period
 assert.equal((await row('SELECT hon.saas_creative_open_window($1,$2,$3) l',[school('A'),humans.ownerA.id,T1])).l,null);
 await admin.query('ROLLBACK');
 const ren=await deliver(sim.renewal(S.A.paid.subscription,Math.floor(new Date(subA.current_period_end).getTime()/1000),24900).delivery);
 assert.deepEqual([ren.event.outcome,ren.event.detail],['APPLIED','RENEWAL_RECORDED']);
 await admin.query('BEGIN');
 try{
  await admin.query('SELECT hon.saas_creative_lock_wallet($1,$2)',[school('A'),T1]);
  const next=(await row('SELECT hon.saas_creative_open_window($1,$2,$3) l',[school('A'),humans.ownerA.id,T1])).l;
  const nl=await row('SELECT window_index,credits FROM hon.saas_creative_lots WHERE id=$1',[next]);
  assert.deepEqual(nl,{window_index:1,credits:12000},'next paid window grants a fresh 12,000');
  assert.equal((await row('SELECT hon.saas_creative_open_window($1,$2,$3) l',[school('A'),humans.ownerA.id,T1])).l,next,'idempotent per window');
  const exp=await row("SELECT sum(credits)::int c FROM hon.saas_creative_ledger WHERE lot_id=$1 AND entry_kind='EXPIRE'",[includedA]);
  assert.equal(exp.c,null,'window 0 has nothing unreserved left to expire (all of it is held or used)');
  // The held c1 share of window 0 is released after the window ended: it expires immediately (no rollover).
  const c1row=await row('SELECT r FROM hon.saas_creative_reservations r WHERE id=$1',[c1.reservationId]);
  await admin.query('SELECT hon.saas_creative_settle_lots($1::hon.saas_creative_reservations,0,$2,$3)',[c1row.r,humans.ownerA.id,T1]);
  const t=await row("SELECT hon.saas_creative_lot_remaining($1) rem,(SELECT sum(credits)::int FROM hon.saas_creative_ledger WHERE lot_id=$1 AND entry_kind='EXPIRE') e",[includedA]);
  assert.deepEqual([t.rem,t.e],[0,1000]);
  const pr=await row("SELECT hon.saas_creative_lot_remaining(id) rem FROM hon.saas_creative_lots WHERE school_id=$1 AND lot_kind='PROMOTIONAL'",[school('A')]);
  assert.equal(pr.rem,1000,'promotional credits released back, no invented expiry');
 }finally{await admin.query('ROLLBACK');}

 // ---------- 14. tenant isolation and evidence ----------
 const wb=await schoolWallet('B');
 assert.deepEqual([wb.balance.availableCredits,wb.balance.heldCredits,wb.lots.map(l=>l.lotId),wb.reservations.length,wb.purchases.length,wb.adjustments.length],
  [12000,0,[includedB],0,0,0],'school B unaffected by every A operation');
 await deny(wallet.readSchoolWallet(H('ownerA'),school('B')),403,'SAAS_FORBIDDEN');
 await deny(wallet.readSchoolWallet(H('ownerB'),school('A')),403,'SAAS_FORBIDDEN');
 await deny(wallet.readSchoolWalletFromHq(H('ownerA'),school('A')),403,'SAAS_FORBIDDEN');
 await deny(wallet.readWallets(H('ownerA')),403,'SAAS_FORBIDDEN');
 assert.equal(await n("SELECT count(*)::int n FROM hon.saas_creative_ledger e JOIN hon.saas_creative_lots l ON l.id=e.lot_id WHERE e.school_id<>l.school_id OR e.organization_id<>l.organization_id"),0);
 assert.equal(await n("SELECT count(*)::int n FROM hon.saas_creative_reservations r JOIN hon.saas_creative_ledger e ON e.reservation_id=r.id WHERE e.school_id<>r.school_id OR e.organization_id<>r.organization_id"),0);
 const list=await wallet.readWallets(H('operator'));
 assert.deepEqual(new Set(list.wallets.map(x=>x.schoolId)),new Set([school('A'),school('B')]));
 const listA=list.wallets.find(x=>x.schoolId===school('A'));
 assert.deepEqual([listA.actualProviderCostMicrounits,listA.consumedCredits,listA.outcomeUnknown],[25_445_000,5500,0]);
 // Every balance equals its ledger: GRANT - FINALIZE - (held) - EXPIRE - DEBIT.
 for(const k of ['A','B']){
  const t=await ledgerTotals(school(k)),bal=(await hqWallet(k)).balance;
  assert.equal(bal.availableCredits+bal.heldCredits,(t.GRANT??0)-(t.FINALIZE??0)-(t.EXPIRE??0)-(t.DEBIT??0),`${k} balance = ledger`);
 }
 const audit=await creativeAudit();
 assert.deepEqual(audit,{'saas.creative.debit':2,'saas.creative.fulfill':3,'saas.creative.grant':2,'saas.creative.program':3,'saas.creative.purchase':2,
  'saas.creative.rates':2,'saas.creative.reserve':7,'saas.creative.resolve':2,'saas.creative.settle':5,'saas.creative.window':9},'one audit row per applied command, none for replays or refusals');
 assert.equal(await creativeOutbox(),Object.values(audit).reduce((a,b)=>a+b,0),'one outbox event per audit row');
 for(const t of ['saas_creative_ledger','saas_creative_lots','saas_creative_adjustments'])await sqlDeny(admin.query(`DELETE FROM hon.${t}`));
 await sqlDeny(admin.query("UPDATE hon.saas_creative_reservations SET final_credits=0"));
 await verifySaasBillingSecurity(admin,'hon_champions_runtime');

 await setAccessProgram(false);programTouched=false;
 console.log('PASS: CW1 creative credit wallet (0202) — ships INACTIVE with 12,000 monthly and the owner-approved $30/$60/$120 packages; HQ-owner-only rates (configurable, PROVISIONAL unless cost-verified) and activation; only PAYMENT_ACTIVE HON OS schools with a provider-verified paid period get the included window (provisioned and unpaid schools refused); one window grant under 8 concurrent opens and replay; 8 concurrent 3,000-credit reservations against 12,000: exactly 4 succeed, no overdraw; success/failed/unknown settlement with the requester only, HQ-owner evidence resolution of unknown and stuck reservations, no double settlement; actual provider expense recorded separately (customer_credits 0, no agent-budget rows); HQ-owner promotional/adjustment grants (no preset cap) and corrections, purchased lots protected; top-up purchases are intents (no checkout, no card), TEST MODE fulfillment grants base+bonus exactly once under 5 concurrent deliveries, refuses live mode, holds mismatches and duplicate payments for review; included -> promotional/adjustment -> purchased consumption; no next window until paid, unused included credits expire; school isolation, ledger = balance, exact audit/outbox evidence, immutable ledger; security verifier.');
}finally{
 if(programTouched)await setAccessProgram(false).catch(e=>console.error('RESTORE FAILED',e));
 await cleanup().catch(e=>console.error(e));
 await Promise.allSettled([admin.end(),restricted.end(),ownerPool.end(),database.onModuleDestroy?.()]);
}
