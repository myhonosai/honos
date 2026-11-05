import pg from 'pg';
import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addUtcMonthsClamped } from './commercial-staging-month-fixtures.mjs';
import { saasUtcCalendarFunctions, verifySaasBillingSecurity } from './saas-billing-security.mjs';
import { runUtcOperatorChecks } from './saas-billing-utc-operator-check.mjs';
// Issue #100 / 0201, production path: HON OS checkout activation and provider renewals arrive as signed Stripe
// webhooks (TEST MODE, deterministic simulator, disposable Champions fixture only) through the real API services:
// SaasPaymentsService.handleWebhook -> ingest -> saas_activate_hon_os_checkout_core / saas_apply_renewal ->
// saas_provider_invoice. Monthly and annual (auto-renewing) subscriptions are anchored at month ends, leap days and
// DST-change days; every delivery runs on ONE reused pooled backend left in a different TimeZone (UTC included) by the
// previous borrower, and one activation runs on a fresh pool under a non-UTC database default. Every period, history
// row and provider-paid invoice must be the ORIGINAL anchor plus whole UTC calendar months (clamped), whatever the
// session. The pre-0201 drift is reproduced on this same path with the pins removed (disposable database only), and
// the read-only operator checks find exactly the drifted rows. Paid access is simulated ACTIVE here (disposable only)
// and restored; payment events are STRIPE_SIMULATED; no real provider, card, credit or production data is involved.
// Fail-closed target guard (Manus review P2): exact disposable localhost fixture as node-postgres itself interprets
// the URLs, no PG* overrides, explicit client configs, then a server-side database/role/loopback/marker check below.
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env),runtime={username:CHAMPIONS_RUNTIME_ROLE};
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
// One pooled connection: every webhook below reuses the SAME backend session (connection-pool reuse).
process.env.HON_RUNTIME_DATABASE_POOL_MAX='1';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {StripeTestModeAdapter}=await import('../../../apps/api/dist/payments/stripe-test-mode-adapter.js');
const {StripeSimulator}=await import('../../../apps/api/dist/payments/stripe-simulator.js');
const contracts=await import('@hon/contracts');
const SECRET='whsec_disposableFixtureSecret0123456789',KEY='sk_test_disposableFixtureKey0123456789';
// The simulator's clock sets each event's `created` (the provider payment time the activation anchors to). Deliveries
// are re-signed at the real time, so the signature check (300 s tolerance) is exercised exactly as in production.
const clock={at:null};
const sim=new StripeSimulator(SECRET,()=>clock.at??Date.now());
const atTime=(instant,work)=>{clock.at=Date.parse(instant);try{return work();}finally{clock.at=null;}};
const adapter=()=>new StripeTestModeAdapter({secretKey:KEY,webhookSecret:SECRET,provider:'STRIPE_SIMULATED',transport:sim.transport});
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database);
const payments=new SaasPaymentsService(billing,database,adapter());
const pool=database['getPool']();
const admin=new pg.Client(targets.owner);
const offerTables=['saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const saasTables=['saas_access_transitions','saas_access_states','saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions',
 'saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions',
 'saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions',...offerTables];
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000;
const ZONES=['America/New_York','UTC','Pacific/Kiritimati','Australia/Sydney','America/Los_Angeles','Asia/Kolkata','Pacific/Pago_Pago','Europe/London','America/St_Johns','Australia/Lord_Howe','Pacific/Chatham'];
// Anchors (whole seconds: provider events carry seconds). M = monthly, A = annual auto-renewing; R = pre-0201 reproduction.
const CASES={
 M1:{interval:'MONTHLY',anchor:'2024-01-31T23:59:59.000Z',why:'month end into a leap February, then 30-day months'},
 M2:{interval:'MONTHLY',anchor:'2025-03-09T07:30:00.000Z',why:'US DST start day; activated under a non-UTC database default'},
 M3:{interval:'MONTHLY',anchor:'2025-10-26T00:30:00.000Z',why:'EU DST end day, just after midnight UTC'},
 M4:{interval:'MONTHLY',anchor:'2025-08-31T23:30:00.000Z',why:'31st late evening UTC (the next calendar day in eastern zones)'},
 A1:{interval:'ANNUAL',anchor:'2024-02-29T12:00:00.000Z',why:'leap day: renews on 28 February'},
 A2:{interval:'ANNUAL',anchor:'2024-10-31T04:30:00.000Z',why:'month end near the US DST end'},
 R:{interval:'MONTHLY',anchor:'2026-01-31T02:00:00.000Z',why:'pre-0201 reproduction with the pins removed'},
};
const humans=Object.fromEntries(['owner',...Object.keys(CASES).map(k=>`owner${k}`)].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`saas-utc-webhook-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
const S={},created=[];
let programTouched=false,databaseDefaultChanged=false,unpinned=[];
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
 const orgs=[...created,...(await admin.query("SELECT s.organization_id id FROM hon.saas_access_transitions s WHERE s.reason='NEW_SCHOOL_REGISTERED'").catch(()=>({rows:[]}))).rows.map(r=>r.id)];
 await admin.query('BEGIN');try{
  const all=[...saasTables,'saas_credit_program','saas_reward_fulfillment','saas_payment_program'];
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of saasTables)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query("UPDATE hon.saas_payment_program SET status='DISABLED',provider=NULL,test_tax_reference=NULL,authorization_reference=NULL,version=1,changed_by_principal_id=NULL");
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const register=(who,k)=>admin.query('SELECT hon.initialize_saas_hon_os_school_account($1,$2::jsonb,$3,$4,$5) r',[H(who),JSON.stringify({legalName:`UTC Webhook Fixture Dojo ${k} LLC`,
 displayName:`UTC Webhook Dojo ${k}`,schoolName:`UTC Webhook Dojo ${k} Main`,schoolSlug:`utc-webhook-dojo-${k.toLowerCase()}`,timezone:'America/Chicago'}),K(),K(),K()]).then(r=>r.rows[0].r);
const session=async()=>(await pool.query("SELECT pg_backend_pid() pid,current_setting('TimeZone') tz")).rows[0];
const leakZone=async zone=>{await pool.query("SELECT set_config('TimeZone',$1,false)",[zone]);return session();};
// Re-sign at the real time and deliver through the production webhook entry point.
const deliver=async(d,service=payments)=>{const signed=sim.sign(d.event,Math.floor(Date.now()/1000));const r=await service.handleWebhook(signed.raw,signed.signature);return [r.event.outcome,r.event.detail];};
const sub=async k=>row("SELECT id,version,billing_interval,period_index,period_anchor_at,current_period_start,current_period_end FROM hon.saas_subscriptions WHERE organization_id=$1 AND status<>'VOIDED'",[S[k].organizationId]);
const months=k=>CASES[k].interval==='ANNUAL'?12:1;
const expected=(k,index)=>({index,start:addUtcMonthsClamped(CASES[k].anchor,index*months(k)),end:addUtcMonthsClamped(CASES[k].anchor,(index+1)*months(k))});
const actual=s=>({index:s.period_index,start:iso(s.current_period_start),end:iso(s.current_period_end)});
const invoices=async k=>(await admin.query("SELECT i.period_index,i.service_period_start s,i.service_period_end e,i.status FROM hon.saas_invoices i JOIN hon.saas_subscriptions x ON x.id=i.subscription_id WHERE x.organization_id=$1 AND i.kind='SUBSCRIPTION_PERIOD' ORDER BY i.period_index",[S[k].organizationId])).rows;
const pinned=async()=>(await admin.query(`SELECT count(*) FILTER (WHERE 'TimeZone=UTC'=ANY(p.proconfig))::int ok,count(*)::int n FROM unnest($1::text[]) f JOIN pg_proc p ON p.oid=('hon.'||f)::regprocedure`,[saasUtcCalendarFunctions])).rows[0];
// The webhook-path functions, taken from the pinned list itself (exact regprocedure text).
const WEBHOOK_PATH=saasUtcCalendarFunctions.filter(f=>/^(saas_activate_hon_os_checkout_core|saas_apply_renewal|saas_provider_invoice)\(/.test(f));

let deliveries=0,renewals=0;
await admin.connect();
await verifyChampionsProofConnection(admin,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection({query:(...a)=>database['getPool']().query(...a)},CHAMPIONS_RUNTIME_ROLE);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 assert.deepEqual(await pinned(),{ok:saasUtcCalendarFunctions.length,n:saasUtcCalendarFunctions.length},'every month-adding SaaS function is pinned (0201)');
 assert.equal(WEBHOOK_PATH.length,3,'activation, renewal and provider invoice are all on the pinned list');
 await cleanup();

 // ---------- fixture: HQ owner, catalog, monthly + annual auto-renewing HON OS offers, TEST MODE payments ----------
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '1 hour')",[humans.owner.id]);
 await admin.query('COMMIT');
 const d=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
 d.termsReference='Fixture HON plan terms (not customer terms)';
 d.founderProgram={...d.founderProgram,eligibility:'ANY_ACTIVE_ORGANIZATION',opensAt:iso(NOW-HOUR)};
 await billing.publishCatalog(H('owner'),(await billing.createCatalogDraft(H('owner'),d,K())).catalog.catalogId,K());
 const offer=(code,kind,priceMinor,displayName)=>{const interval=contracts.saasHonOsOfferBillingInterval(kind);return{offerCode:code,offerKind:kind,displayName,priceMinor,
  salesOpensAt:iso(NOW-HOUR),salesClosesAt:null,eligibility:'ANY_ACTIVE_ORGANIZATION',saleLimit:null,priceLock:'WHILE_CONTINUOUSLY_SUBSCRIBED',priceLockMonths:null,
  annualRenewal:interval==='ANNUAL'?'AUTO_RENEW_AT_LOCKED_PRICE':null,plannedMonthlyPremiumCredits:12000,aiFairUseReference:null,refundWindowDays:30,cancellationTiming:'END_OF_PAID_PERIOD'};};
 const pub=await billing.publishOfferSet(H('owner'),...await(async()=>{const dr=await billing.createOfferSetDraft(H('owner'),{basedOnSetId:null,
   termsReference:'Fixture HON OS terms v1 (not customer terms)',founderTotalLimit:3,offers:[offer('OS_MONTHLY','REGULAR_MONTHLY',24900,'Monthly'),offer('OS_ANNUAL','REGULAR_ANNUAL',249000,'Annual')]},K());
  return[dr.set.setId,{expectedRevision:dr.set.revision,previewDigest:dr.preview.previewDigest,approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K()];})());
 const OFFER=Object.fromEntries(pub.set.offers.map(o=>[o.offerCode,o]));
 await payments.setPaymentProgram(H('owner'),{action:'ENABLE_TEST_MODE',expectedVersion:1,authorizationReference:'Fixture owner test-mode authorization (disposable)',
  provider:'STRIPE_SIMULATED',testTaxReference:'TEST MODE: no tax collected; TAXES undecided (fixture)'},K());
 await setAccessProgram(true);
 for(const k of Object.keys(CASES)){S[k]=await register(`owner${k}`,k);created.push(S[k].organizationId);}
 const checkout=async k=>{const o=CASES[k].interval==='ANNUAL'?OFFER.OS_ANNUAL:OFFER.OS_MONTHLY;
  const co=await payments.startSchoolHonOsCheckout(H(`owner${k}`),S[k].schoolId,{offerId:o.offerId},K());
  // The customer pays on the hosted page at the anchor instant (the provider's event time).
  return {price:o.priceMinor,paid:atTime(CASES[k].anchor,()=>sim.completeCheckout(co.checkout.providerSessionId))};};
 const first=await session();

 // ---------- 1. activation + renewals through the webhook, on one reused pooled session in rotating zones ----------
 const C={};
 for(const k of ['M1','M3','M4','A1','A2']){
  C[k]=await checkout(k);
  const zone=ZONES[deliveries%ZONES.length];await leakZone(zone);
  assert.deepEqual(await deliver(C[k].paid.completed),['APPLIED','ACCESS_ACTIVATED'],`${k} activation in ${zone}`);deliveries++;
  assert.deepEqual(await session(),{pid:first.pid,tz:zone},'the function-level UTC setting never leaks into the pooled session');
 }
 // M2: activation on a fresh pool whose connections take a non-UTC database default (a role/database/pooler setting).
 await admin.query("ALTER DATABASE hon_champions_validation SET TimeZone = 'America/New_York'");databaseDefaultChanged=true;
 const db2=new RuntimeDatabaseService(),payments2=new SaasPaymentsService(new SaasBillingService(db2),db2,adapter());
 try{
  assert.equal((await db2['getPool']().query("SELECT current_setting('TimeZone') tz")).rows[0].tz,'America/New_York');
  C.M2=await checkout('M2');
  assert.deepEqual(await deliver(C.M2.paid.completed,payments2),['APPLIED','ACCESS_ACTIVATED'],'M2 activation under a New York database default');deliveries++;
  assert.equal((await db2['getPool']().query("SELECT current_setting('TimeZone') tz")).rows[0].tz,'America/New_York','caller session TimeZone restored');
 }finally{await db2.onModuleDestroy?.();await admin.query('ALTER DATABASE hon_champions_validation RESET TimeZone');databaseDefaultChanged=false;}
 for(const k of ['M1','M2','M3','M4','A1','A2']){
  assert.deepEqual(actual(await sub(k)),expected(k,0),`${k} activation period (${CASES[k].why})`);
  // The first-invoice event of the same checkout is recognized as already recorded, whatever the session.
  await leakZone(ZONES[(deliveries+3)%ZONES.length]);
  assert.deepEqual(await deliver(C[k].paid.firstInvoice),['ALREADY_APPLIED','FIRST_INVOICE_COVERED_BY_CHECKOUT'],`${k} first invoice`);deliveries++;
 }
 for(const k of ['M1','M2','M3','M4','A1','A2']){
  for(let index=1;Date.parse(expected(k,index).start)<=NOW;index++){
   const start=expected(k,index).start;
   const r=atTime(start,()=>sim.renewal(C[k].paid.subscription,Math.floor(Date.parse(start)/1000),C[k].price));
   const zone=ZONES[(deliveries+index)%ZONES.length];const before=await leakZone(zone);
   assert.equal(before.pid,first.pid,'single pooled backend reused');
   assert.deepEqual(await deliver(r.delivery),['APPLIED','RENEWAL_RECORDED'],`${k} renewal ${index} in ${zone}`);deliveries++;renewals++;
   assert.deepEqual(actual(await sub(k)),expected(k,index),`${k} period ${index} after a renewal delivered in ${zone} (${CASES[k].why})`);
   assert.deepEqual(await session(),{pid:first.pid,tz:zone});
   // A duplicate delivery of the same renewal in another zone changes nothing.
   if(index===1){
    const evidence=async()=>(await row('SELECT count(*)::int n FROM hon.saas_payment_evidence e JOIN hon.saas_invoices i ON i.id=e.invoice_id JOIN hon.saas_subscriptions x ON x.id=i.subscription_id WHERE x.organization_id=$1',[S[k].organizationId])).n;
    const n0=await evidence();await leakZone('Pacific/Chatham');
    const signed=sim.sign(r.delivery.event,Math.floor(Date.now()/1000));const again=await payments.handleWebhook(signed.raw,signed.signature);deliveries++;
    assert.deepEqual([again.replayed,again.event.outcome,again.event.detail],[true,'APPLIED','RENEWAL_RECORDED'],'the same provider event is answered from its first receipt');
    assert.deepEqual(actual(await sub(k)),expected(k,1));assert.equal(await evidence(),n0,'no second payment evidence');}
  }
  // History and provider-paid invoices carry the same UTC periods.
  const s=await sub(k);
  const hist=(await admin.query('SELECT period_index,current_period_start s,current_period_end e FROM hon.saas_subscription_history WHERE subscription_id=$1 AND period_index IS NOT NULL ORDER BY version',[s.id])).rows;
  assert.deepEqual(hist.map(h=>({index:h.period_index,start:iso(h.s),end:iso(h.e)})),Array.from({length:s.period_index+1},(_,i)=>expected(k,i)),`${k} history`);
  assert.deepEqual((await invoices(k)).map(i=>({index:i.period_index,start:iso(i.s),end:iso(i.e)})),Array.from({length:s.period_index+1},(_,i)=>expected(k,i)),`${k} provider-paid invoices`);
 }
 // Spot checks of the approved semantics (independent of the helper).
 const at=async(k,index)=>iso((await row('SELECT h.current_period_start s FROM hon.saas_subscription_history h JOIN hon.saas_subscriptions x ON x.id=h.subscription_id WHERE x.organization_id=$1 AND h.period_index=$2 LIMIT 1',[S[k].organizationId,index])).s);
 assert.deepEqual([await at('M1',1),await at('M1',2),await at('M1',13)],['2024-02-29T23:59:59.000Z','2024-03-31T23:59:59.000Z','2025-02-28T23:59:59.000Z']);
 assert.deepEqual([await at('A1',1),await at('A1',2)],['2025-02-28T12:00:00.000Z','2026-02-28T12:00:00.000Z']);
 assert.deepEqual([await at('M2',1),await at('M3',1)],['2025-04-09T07:30:00.000Z','2025-11-26T00:30:00.000Z'],'DST-day anchors keep the UTC time of day');

 // ---------- 2. the production issue on this path: pins removed (disposable only), New York session ----------
 const R=await checkout('R');
 for(const f of WEBHOOK_PATH){await admin.query(`ALTER FUNCTION hon.${f} RESET TimeZone`);unpinned.push(f);}
 try{
  await assert.rejects(verifySaasBillingSecurity(admin,runtime.username),/not pinned to UTC|Unsafe HON subscription function/,'the security verifier refuses unpinned webhook billing functions');
  await leakZone('America/New_York');
  assert.deepEqual(await deliver(R.paid.completed),['APPLIED','ACCESS_ACTIVATED']);deliveries++;
  // UTC: Jan 31 02:00Z + 1 month = Feb 28 02:00Z. New York: Jan 30 21:00 EST + 1 month = Feb 28 21:00 EST = Mar 1 02:00Z.
  assert.deepEqual(actual(await sub('R')),{index:0,start:CASES.R.anchor,end:'2026-03-01T02:00:00.000Z'},'pre-0201 activation drift reproduced');
  const r=atTime('2026-02-28T02:00:00.000Z',()=>sim.renewal(R.paid.subscription,Math.floor(Date.parse('2026-02-28T02:00:00.000Z')/1000),R.price));
  await leakZone('America/New_York');
  assert.deepEqual(await deliver(r.delivery),['APPLIED','RENEWAL_RECORDED']);deliveries++;renewals++;
  // Period 1 in New York: Mar 1 02:00Z to Mar 30 21:00 EDT = Mar 31 01:00Z (the DST hour moves the end too).
  assert.deepEqual(actual(await sub('R')),{index:1,start:'2026-03-01T02:00:00.000Z',end:'2026-03-31T01:00:00.000Z'},'pre-0201 renewal drift reproduced');
  assert.notDeepEqual(actual(await sub('R')),expected('R',1));
 }finally{
  for(const f of unpinned.splice(0))await admin.query(`ALTER FUNCTION hon.${f} SET TimeZone = 'UTC'`);
 }
 assert.deepEqual(await pinned(),{ok:saasUtcCalendarFunctions.length,n:saasUtcCalendarFunctions.length});
 await verifySaasBillingSecurity(admin,runtime.username);

 // ---------- 3. read-only operator checks: exactly the drifted rows, nothing else; nothing is corrected ----------
 const rid=(await sub('R')).id;
 const snapshot=async()=>(await admin.query("SELECT (SELECT md5(string_agg(to_jsonb(s)::text,'' ORDER BY s.id)) FROM hon.saas_subscriptions s) a,(SELECT md5(string_agg(to_jsonb(h)::text,'' ORDER BY h.subscription_id,h.version)) FROM hon.saas_subscription_history h) b,(SELECT md5(string_agg(to_jsonb(i)::text,'' ORDER BY i.id)) FROM hon.saas_invoices i) c")).rows[0];
 const beforeChecks=await snapshot();
 const found=await runUtcOperatorChecks(admin);
 assert.deepEqual(found.subscriptions.map(r=>[r.id,r.period_index,iso(r.utc_period_start),iso(r.utc_period_end)]),[[rid,1,expected('R',1).start,expected('R',1).end]]);
 assert.deepEqual(found.history.map(r=>[r.subscription_id,r.period_index]),[[rid,0],[rid,1]],'both drifted history rows of R, nothing else');
 assert.deepEqual(found.invoices.map(r=>[r.subscription_id,r.period_index,iso(r.service_period_start),iso(r.service_period_end)]),
  [[rid,0,CASES.R.anchor,'2026-03-01T02:00:00.000Z'],[rid,1,'2026-03-01T02:00:00.000Z','2026-03-31T01:00:00.000Z']],'both provider-paid invoices of R with their stored (drifted) periods');
 assert.deepEqual(await snapshot(),beforeChecks,'the operator checks change nothing');
 await assert.rejects(admin.query('BEGIN TRANSACTION READ ONLY').then(()=>admin.query("UPDATE hon.saas_subscriptions SET status_reason=status_reason WHERE id=$1",[rid])).finally(()=>admin.query('ROLLBACK')),e=>e.code==='25006','the checks run read-only');
 // After 0201 a new period for R is computed in UTC from the ORIGINAL anchor; the stored drifted rows stay as recorded.
 const r2start=expected('R',2).start;
 if(Date.parse(r2start)<=NOW){
  const r2=atTime(r2start,()=>sim.renewal(R.paid.subscription,Math.floor(Date.parse(r2start)/1000),R.price));
  await leakZone('America/New_York');
  assert.deepEqual(await deliver(r2.delivery),['APPLIED','RENEWAL_RECORDED']);deliveries++;renewals++;
  assert.deepEqual(actual(await sub('R')),expected('R',2),'pinned: the next period is UTC from the original anchor');
  assert.deepEqual((await runUtcOperatorChecks(admin)).history.map(r=>[r.subscription_id,r.period_index]),[[rid,0],[rid,1]],'historical rows are not rewritten');
 }

 // ---------- 4. no other effect ----------
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_subscriptions WHERE organization_id<>ALL($1::uuid[])",[created])).rows[0].n,0);
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.saas_credit_allowances')).rows[0].n,0,'no AI credits opened');
 assert.equal((await session()).pid,first.pid);
 await setAccessProgram(false);programTouched=false;
 console.log(`PASS: 0201 UTC billing periods on the production webhook path — ${deliveries} signed TEST MODE webhooks (${renewals} renewals) through SaasPaymentsService on one reused pooled session across ${ZONES.length} zones (UTC included) and a non-UTC database default; monthly and annual auto-renewing HON OS subscriptions anchored at month ends, a leap day and DST-change days keep UTC calendar periods (clamped, time of day kept) in subscriptions, history and provider-paid invoices; duplicate deliveries change nothing; the pre-0201 drift is reproduced on this path only with the pins removed; the read-only operator checks find exactly the drifted rows and change nothing.`);
}finally{
 if(databaseDefaultChanged)await admin.query('ALTER DATABASE hon_champions_validation RESET TimeZone').catch(e=>console.error('RESET FAILED',e));
 for(const f of WEBHOOK_PATH)await admin.query(`ALTER FUNCTION hon.${f} SET TimeZone = 'UTC'`).catch(e=>console.error('REPIN FAILED',e));
 if(programTouched)await setAccessProgram(false).catch(e=>console.error('RESTORE FAILED',e));
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),database.onModuleDestroy?.()]);}
}
