import pg from 'pg';
import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// CW1 independent-review regressions (Manus review of PR #124 at a07f637, 2026-11-03). One check per finding,
// each run on its own so a failure in one is reported without hiding the others:
//   P1-A exact-school isolation inside one organization; P1-B school-owned wallets (owner decision 2026-11-03);
//   P1-C the S4 emergency AI pause and access changes apply to new creative reservations, never to accounting;
//   P2-A creative provider expense is classified CREATIVE_MEDIA; P2-B an unknown provider cost stays reconcilable.
// DISPOSABLE DATABASE ONLY, TEST MODE, SIMULATED provider results and payments (same posture as the CW1 proof).
// Fail-closed target guard (Manus review P2): exact disposable localhost fixture as node-postgres itself interprets
// the URLs, no PG* overrides, explicit client configs, then a server-side database/role/loopback/marker check below.
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env),runtime={username:CHAMPIONS_RUNTIME_ROLE};
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
process.env.HON_RUNTIME_DATABASE_POOL_MAX='12';
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
const admin=new pg.Client(targets.owner);
const ownerPool=new pg.Pool({...targets.owner,max:8});
const creativeTables=['saas_creative_ledger','saas_creative_reservations','saas_creative_lots','saas_creative_adjustments','saas_creative_topup_purchases',
 'saas_creative_wallets','saas_creative_rates','saas_creative_rate_versions'];
const optionalCreativeTables=['saas_creative_cost_events'];
const saasTables=['saas_access_transitions','saas_access_states','saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions',
 'saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions',
 'saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions',
 'saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const http=(n,code)=>e=>{assert.equal(e?.getStatus?.(),n,e?.stack??String(e));if(code)assert.equal(e.getResponse().code,code,e.stack);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
const humans=Object.fromEntries(['owner','ownerA','ownerB','staffA2','ownerC'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`cw1r-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
const S={},created=[];
let createdProvider=false,programTouched=false;
const tableExists=async t=>(await admin.query('SELECT to_regclass($1) r',['hon.'+t])).rows[0].r!==null;
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
 const cts=[...creativeTables];for(const t of optionalCreativeTables)if(await tableExists(t))cts.unshift(t);
 await admin.query('BEGIN');try{
  const all=[...cts,'saas_creative_program',...saasTables,'saas_credit_program','saas_reward_fulfillment','saas_payment_program','ai_spend_pauses'];
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of cts)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query("UPDATE hon.saas_creative_program SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query('DELETE FROM hon.ai_spend_pauses WHERE paused_by_principal_id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);
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
const details=k=>({legalName:`CW1R Fixture Dojo ${k} LLC`,displayName:`CW1R Dojo ${k}`,schoolName:`CW1R Dojo ${k} Main`,schoolSlug:`cw1r-dojo-${k.toLowerCase()}`,timezone:'America/Chicago'});
const register=(who,p)=>admin.query('SELECT hon.initialize_saas_hon_os_school_account($1,$2::jsonb,$3,$4,$5) r',[H(who),JSON.stringify(p),K(),K(),K()]).then(r=>r.rows[0].r);
const deliver=d=>payments.handleWebhook(d.raw,d.signature);
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const offer=(code,kind,priceMinor,displayName)=>{const interval=contracts.saasHonOsOfferBillingInterval(kind);return{offerCode:code,offerKind:kind,displayName,priceMinor,
 salesOpensAt:iso(NOW-HOUR),salesClosesAt:null,eligibility:'ANY_ACTIVE_ORGANIZATION',saleLimit:null,priceLock:'WHILE_CONTINUOUSLY_SUBSCRIBED',priceLockMonths:null,
 annualRenewal:interval==='ANNUAL'?'AUTO_RENEW_AT_LOCKED_PRICE':null,plannedMonthlyPremiumCredits:12000,aiFairUseReference:null,refundWindowDays:30,cancellationTiming:'END_OF_PAID_PERIOD'};};
// Actors per school: ownerA at school A1 (the registered school), staffA2 at a second school A2 of the SAME organization, ownerB at B.
const actor={A1:'ownerA',A2:'staffA2',B:'ownerB',C:'ownerC'};
const reserve=(at,op,units,key=K(),who=actor[at])=>wallet.reserveCredits(H(who),S[at],{operationCode:op,units,providerId:'HIGGSFIELD',modelCode:op==='video.generate'?'fixture-video-1':'fixture-image-1'},key);
const settle=(r,body,key=K(),who)=>wallet.settleCredits(H(who),r.reservationId,{expectedVersion:r.version,...body},key);
const fulfill=(purchaseId,payment,client=ownerPool)=>client.query('SELECT hon.saas_fulfill_creative_topup($1,$2::jsonb,$3) r',[purchaseId,JSON.stringify(payment),new Date()]).then(r=>r.rows[0].r);
const pay=(ref,amount)=>({provider:'STRIPE_SIMULATED',paymentRef:ref,amountMinor:amount,currency:'usd',livemode:false});
const pause=(action,organizationId,spendClass,key=K())=>ownerPool.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3) r',[H('owner'),JSON.stringify({action,organizationId,spendClass,reason:'Fixture emergency pause for the CW1 review regression'}),key]).then(r=>r.rows[0].r);
const lateCost=(reservationId,event,client=ownerPool)=>client.query('SELECT hon.saas_record_creative_provider_cost($1,$2::jsonb,$3) r',[reservationId,JSON.stringify(event),new Date()]).then(r=>r.rows[0].r);
const results=[];
async function check(id,title,fn){
 try{await fn();results.push([id,'PASS',title]);console.log(`PASS ${id}: ${title}`);}
 catch(e){results.push([id,'FAIL',title]);console.log(`FAIL ${id}: ${title}\n  ${String(e?.message??e).split('\n').slice(0,6).join('\n  ')}`);}
}

await admin.connect();
await verifyChampionsProofConnection(admin,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection(ownerPool,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection({query:(...a)=>database['getPool']().query(...a)},CHAMPIONS_RUNTIME_ROLE);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 await cleanup();
 // ---------- fixture (stable across the reviewed head and the correction) ----------
 await admin.query('BEGIN');
 if((await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state) VALUES('HIGGSFIELD','Fixture provider','DISABLED') ON CONFLICT DO NOTHING RETURNING provider_id")).rowCount)createdProvider=true;
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '1 hour')",[humans.owner.id]);
 await admin.query('COMMIT');
 const d=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
 d.termsReference='Fixture HON plan terms (not customer terms)';
 d.founderProgram={...d.founderProgram,eligibility:'ANY_ACTIVE_ORGANIZATION',opensAt:iso(NOW-HOUR)};
 await billing.publishCatalog(H('owner'),(await billing.createCatalogDraft(H('owner'),d,K())).catalog.catalogId,K());
 const pub=await billing.publishOfferSet(H('owner'),...await(async()=>{const dr=await billing.createOfferSetDraft(H('owner'),{basedOnSetId:null,
   termsReference:'Fixture HON OS terms v1 (not customer terms)',founderTotalLimit:3,offers:[offer('OS_MONTHLY','REGULAR_MONTHLY',24900,'Monthly')]},K());
  return[dr.set.setId,{expectedRevision:dr.set.revision,previewDigest:dr.preview.previewDigest,approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K()];})());
 await payments.setPaymentProgram(H('owner'),{action:'ENABLE_TEST_MODE',expectedVersion:1,authorizationReference:'Fixture owner test-mode authorization (disposable)',
  provider:'STRIPE_SIMULATED',testTaxReference:'TEST MODE: no tax collected; TAXES undecided (fixture)'},K());
 await setAccessProgram(true);
 for(const k of ['A','B']){
  const r=await register(`owner${k}`,details(k));created.push(r.organizationId);S[`org${k}`]=r.organizationId;S[k==='A'?'A1':'B']=r.schoolId;
  const co=await payments.startSchoolHonOsCheckout(H(`owner${k}`),r.schoolId,{offerId:pub.set.offers[0].offerId},K());
  assert.deepEqual([(await deliver(sim.completeCheckout(co.checkout.providerSessionId).completed)).event.detail],['ACCESS_ACTIVATED'],`${k} paid`);
 }
 // A2: a second ACTIVE school of organization A with its own staff member (exact-school grant at A2 only).
 S.A2=randomUUID();const roleA2=randomUUID();
 await admin.query('BEGIN');
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'CW1R Dojo A Second',$1::text,'America/Chicago')",[S.A2,S.orgA]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'CW1R_STAFF','Fixture staff',false)",[roleA2,S.orgA]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions WHERE is_staff_assignable",[roleA2,S.orgA]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[S.orgA,S.A2,humans.staffA2.id,roleA2]);
 await admin.query('COMMIT');
 await wallet.publishRates(H('owner'),{termsReference:'Fixture provisional creative rates (not final prices)',rates:[
  {operationCode:'image.generate',mediaKind:'IMAGE',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,costEvidenceId:null},
  {operationCode:'video.generate',mediaKind:'VIDEO',displayName:'AI video',billingUnit:'VIDEO_SECOND',creditsPerUnit:50,maxUnitsPerRequest:60,costEvidenceId:null}]},K());
 await wallet.setProgram(H('owner'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'Fixture owner creative authorization (disposable)'},K());
 const leaks=(json,ids)=>ids.filter(id=>JSON.stringify(json).includes(id));

 // ---------- P1-A: exact-school isolation inside one organization ----------
 await check('P1-A','a school-scoped user never sees a sibling school\'s purchases, ledger, lots, reservations or identifiers',async()=>{
  await wallet.openWindow(H('ownerA'),S.A1,K());
  const a2own=(await reserve('A2','image.generate',1)).reservation;// A2's only reservation, made BEFORE A1's 60 newer ones
  const purchase=(await wallet.createTopupPurchase(H('ownerA'),S.A1,{packageCode:'GROWTH'},K())).purchase;
  const ful=await fulfill(purchase.purchaseId,pay('pi_cw1rIsolation01',6000));
  const a1=[];for(let i=0;i<60;i++)a1.push((await reserve('A1','image.generate',1)).reservation);
  await settle(a1[0],{outcome:'FAILED',finalUnits:null,providerCostMicrounits:1000},K(),'ownerA');
  const v=await wallet.readSchoolWallet(H('staffA2'),S.A2);
  const a1Ids=[purchase.purchaseId,ful.lotId,...a1.map(r=>r.reservationId)];
  assert.deepEqual(leaks(v,a1Ids),[],'no A1 purchase, purchased lot or reservation identifier in the A2 school view');
  assert.deepEqual([v.purchases.length,v.reservations.map(r=>r.reservationId)],[0,[a2own.reservationId]],'A2 sees only its own reservation, filtered before the limit');
  assert.ok(v.history.every(e=>!a1Ids.includes(e.lotId)&&!a1Ids.includes(e.reservationId)),'A2 history carries no A1 ledger entry');
  await deny(wallet.readSchoolWallet(H('staffA2'),S.A1),403,'SAAS_FORBIDDEN');
  await deny(wallet.readSchoolWallet(H('ownerA'),S.A2),403,'SAAS_FORBIDDEN');
  await settle(a2own,{outcome:'FAILED',finalUnits:null,providerCostMicrounits:0},K(),'staffA2');
  for(const r of a1.slice(1))await settle(r,{outcome:'FAILED',finalUnits:null,providerCostMicrounits:0},K(),'ownerA');
 });

 // ---------- P1-B: each eligible paying school owns its wallet ----------
 await check('P1-B','each school gets its own 12,000 monthly, its own purchased credits, its own lock; no sibling spending',async()=>{
  const l1=(await wallet.openWindow(H('ownerA'),S.A1,K())).lot,l2=(await wallet.openWindow(H('staffA2'),S.A2,K())).lot;
  assert.notEqual(l1.lotId,l2.lotId,'A1 and A2 each receive their own included window');
  assert.deepEqual([l1.credits,l2.credits],[12000,12000]);
  const v2=await wallet.readSchoolWallet(H('staffA2'),S.A2);
  assert.equal(v2.balance.availableCredits,12000,'A2 balance holds only A2 credits (A1 purchased credits are not shared)');
  const race=await Promise.allSettled([...Array.from({length:8},()=>reserve('A2','video.generate',60)),...Array.from({length:3},()=>reserve('A1','video.generate',60))]);
  const won2=race.slice(0,8).filter(r=>r.status==='fulfilled'),won1=race.slice(8).filter(r=>r.status==='fulfilled');
  assert.equal(won2.length,4,'exactly four 3,000-credit reservations fit A2\'s own 12,000');
  assert.equal(won1.length,3,'A1 spends independently at the same time');
  await deny(reserve('A2','image.generate',1),422,'SAAS_CREDITS_EXHAUSTED');// A1 still has credits; A2 may not use them
  const rows=(await admin.query("SELECT school_id,count(*)::int n FROM hon.saas_creative_lots WHERE lot_kind='INCLUDED_MONTHLY' AND organization_id=$1 GROUP BY 1",[S.orgA])).rows;
  assert.equal(rows.length,2,'one included lot per school');
  for(const r of [...won2,...won1])await settle(r.value.reservation,{outcome:'FAILED',finalUnits:null,providerCostMicrounits:0},K(),r.value.reservation.schoolId===S.A2?'staffA2':'ownerA');
  // School-specific lock: while A1's wallet row is locked by another transaction, A2 still reserves (no shared lock).
  const holder=await ownerPool.connect();
  try{
   await holder.query('BEGIN');await holder.query('SELECT hon.saas_creative_lock_wallet($1,clock_timestamp())',[S.A1]);
   const timeout=ms=>new Promise(r=>setTimeout(()=>r('TIMEOUT'),ms));
   const blocked=reserve('A1','image.generate',1);
   assert.equal(await Promise.race([blocked.then(()=>'DONE',()=>'DONE'),timeout(1500)]),'TIMEOUT','the held lock really blocks A1');
   const freed=await Promise.race([reserve('A2','image.generate',1).then(r=>r.reservation),timeout(5000)]);
   assert.notEqual(freed,'TIMEOUT','A2 is not blocked by a held A1 wallet lock');
   await settle(freed,{outcome:'FAILED',finalUnits:null,providerCostMicrounits:0},K(),'staffA2');
   await holder.query('ROLLBACK');
   await settle((await blocked).reservation,{outcome:'FAILED',finalUnits:null,providerCostMicrounits:0},K(),'ownerA');
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
 });

 // ---------- P1-C: the S4 shared spend decision gates new creative reservations, never accounting ----------
 await check('P1-C','organization/platform pauses, revoked and expired access refuse new reservations; in-flight results still record; pause vs reserve race is serialized',async()=>{
  const inflight=(await reserve('A1','image.generate',2)).reservation;
  const p1=await pause('PAUSE',S.orgA,'CREATIVE_MEDIA');
  await deny(reserve('A1','image.generate',1),422,'SAAS_CREATIVE_AI_PAUSED_BY_HQ');
  await deny(reserve('A2','image.generate',1),422,'SAAS_CREATIVE_AI_PAUSED_BY_HQ');
  const st=await settle(inflight,{outcome:'SUCCEEDED',finalUnits:2,providerCostMicrounits:30000},K(),'ownerA');
  assert.equal(st.reservation.status,'FINALIZED','a result already in flight is still recorded during a pause');
  assert.ok((await reserve('B','image.generate',1)).reservation,'another organization is unaffected');
  await pause('RESUME',S.orgA,'CREATIVE_MEDIA');
  await pause('PAUSE',S.orgA,'AGENT_INFERENCE');
  assert.ok((await reserve('A1','image.generate',1)).reservation,'an agent-only pause does not stop creative media');
  await pause('RESUME',S.orgA,'AGENT_INFERENCE');
  await pause('PAUSE',null,'ALL');
  await deny(reserve('B','image.generate',1),422,'SAAS_CREATIVE_AI_PAUSED_BY_HQ');
  await pause('RESUME',null,'ALL');
  // Race: reservations and a pause at the same moment. Every reservation that exists was decided before the pause
  // committed; nothing reserved after it.
  const racers=Array.from({length:6},()=>reserve('A1','image.generate',1));
  const pr=pause('PAUSE',S.orgA,'ALL');
  const settled=await Promise.allSettled(racers);const pz=await pr;
  const pausedAt=(await row('SELECT paused_at FROM hon.ai_spend_pauses WHERE id=$1',[pz.pauseId])).paused_at;
  for(const r of settled){if(r.status==='fulfilled')assert.ok(new Date(r.value.reservation.reservedAt)<=pausedAt);else http(422,'SAAS_CREATIVE_AI_PAUSED_BY_HQ')(r.reason);}
  await deny(reserve('A1','image.generate',1),422,'SAAS_CREATIVE_AI_PAUSED_BY_HQ');
  for(const r of settled.filter(r=>r.status==='fulfilled'))await settle(r.value.reservation,{outcome:'FAILED',finalUnits:null,providerCostMicrounits:0},K(),'ownerA');
  await pause('RESUME',S.orgA,'ALL');
  // Revoked requester: the staff grant ends mid-flight. No new reservation; the in-flight result is still recorded.
  const r2=(await reserve('A2','image.generate',1)).reservation;
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$3 WHERE principal_id=$1 AND school_id=$2',[humans.staffA2.id,S.A2,humans.ownerA.id]);
  await deny(reserve('A2','image.generate',1),403,'SAAS_FORBIDDEN');
  assert.equal((await settle(r2,{outcome:'SUCCEEDED',finalUnits:1,providerCostMicrounits:15000},K(),'staffA2')).reservation.status,'FINALIZED');
  // Expired entitlement: B's entitlement ends mid-flight. No new reservation; the in-flight result is still recorded.
  const r3=(await reserve('B','image.generate',1)).reservation;
  await admin.query("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1",[S.orgB]);
  const refused=await reserve('B','image.generate',1).catch(e=>e);
  assert.ok([403,422].includes(refused?.getStatus?.()),'expired access refuses new reservations');
  assert.equal((await settle(r3,{outcome:'SUCCEEDED',finalUnits:1,providerCostMicrounits:15000},K(),'ownerB')).reservation.status,'FINALIZED');
 });

 // ---------- P2-A: creative expense is CREATIVE_MEDIA, never agent inference ----------
 await check('P2-A','creative usage rows are CREATIVE_MEDIA; HQ per-school usage splits creative from agent inference across schools',async()=>{
  const own=(await reserve('A1','image.generate',1)).reservation;
  await settle(own,{outcome:'SUCCEEDED',finalUnits:1,providerCostMicrounits:12000},K(),'ownerA');
  const rows=(await admin.query("SELECT u.spend_class,u.school_id,u.customer_credits FROM hon.ai_usage_ledger u JOIN hon.saas_creative_reservations r ON r.usage_id=u.id")).rows;
  assert.ok(rows.length>=1);
  assert.deepEqual([...new Set(rows.map(r=>r.spend_class))],['CREATIVE_MEDIA']);
  assert.ok(rows.every(r=>Number(r.customer_credits)===0));
  const before=(await row('SELECT hon.ai_org_committed_credits($1,clock_timestamp()) c',[S.orgA])).c;
  await admin.query("INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,provider_code,model_code,modality,input_units,output_units,provider_cost_microunits,customer_credits,spend_class,correlation_id) VALUES($1,$2,$3,'OPENROUTER','fixture-text','TEXT',100,50,700,1,'AGENT_INFERENCE',$4)",[S.orgA,S.A1,humans.ownerA.id,randomUUID()]);
  const after=(await row('SELECT hon.ai_org_committed_credits($1,clock_timestamp()) c',[S.orgA])).c;
  assert.equal(Number(after)-Number(before),1,'only agent inference counts against the agent budget');
  const u=(await row('SELECT hon.read_ai_school_usage_from_hq($1,$2,$3) r',[H('owner'),new Date(NOW-DAY),new Date(Date.now()+DAY)])).r;
  const cost=async(school,cls)=>Number((await row('SELECT coalesce(sum(provider_cost_microunits),0) c FROM hon.ai_usage_ledger WHERE school_id=$1 AND spend_class=$2',[school,cls])).c);
  const text=JSON.stringify(u);
  for(const sc of [S.A1,S.A2,S.B])assert.ok(text.includes(sc),'every school with usage is reported');
  assert.ok(text.includes('CREATIVE_MEDIA')&&text.includes('AGENT_INFERENCE'));
  assert.ok(await cost(S.A1,'CREATIVE_MEDIA')>0&&await cost(S.A1,'AGENT_INFERENCE')===700);
 });

 // ---------- P2-B: unknown provider cost stays reconcilable; never a guessed zero ----------
 await check('P2-B','FAILED with unknown cost stays UNKNOWN (not zero); a later provider charge is recorded once (duplicates, lost responses, HQ, revoked access)',async()=>{
  const g=(await reserve('A1','video.generate',4)).reservation;
  const key=K();
  const s=await settle(g,{outcome:'FAILED',finalUnits:null,providerCostMicrounits:null},key,'ownerA');
  assert.equal((await settle(g,{outcome:'FAILED',finalUnits:null,providerCostMicrounits:null},key,'ownerA')).replayed,true,'a lost response is retried safely');
  const db=await row('SELECT status,cost_status,provider_cost_microunits,usage_id FROM hon.saas_creative_reservations WHERE id=$1',[g.reservationId]);
  assert.deepEqual(db,{status:'RELEASED',cost_status:'UNKNOWN',provider_cost_microunits:null,usage_id:null},'credits released, cost unknown (not a verified zero)');
  const ev={provider:'HIGGSFIELD',eventRef:'evt_cw1rLate0001',costMicrounits:42000};
  const deliveries=await Promise.allSettled(Array.from({length:5},()=>lateCost(g.reservationId,ev)));
  const ok=deliveries.filter(x=>x.status==='fulfilled').map(x=>x.value);
  for(const x of deliveries.filter(x=>x.status==='rejected'))assert.ok(['55P03','40001','23505'].includes(x.reason.code),x.reason.stack);
  assert.equal(ok.filter(x=>!x.replayed).length,1,'one late cost applied under duplicate notifications');
  assert.equal((await lateCost(g.reservationId,ev)).replayed,true);
  const dup=await lateCost(g.reservationId,{...ev,eventRef:'evt_cw1rLate0002',costMicrounits:99999});
  assert.equal(dup.outcome,'DUPLICATE_COST_REVIEW','a different later charge for the same generation is held for review, never added');
  const after=await row('SELECT cost_status,provider_cost_microunits::bigint c,(SELECT count(*)::int FROM hon.ai_usage_ledger WHERE correlation_id=$1) n,(SELECT spend_class FROM hon.ai_usage_ledger WHERE correlation_id=$1 LIMIT 1) cls FROM hon.saas_creative_reservations WHERE id=$1',[g.reservationId]);
  assert.deepEqual([after.cost_status,Number(after.c),after.n,after.cls],['RECORDED',42000,1,'CREATIVE_MEDIA']);
  // HQ owner records a cost the provider reported out of band, after the requester lost access (B entitlement expired).
  const lost=(await row("SELECT r.id,r.version FROM hon.saas_creative_reservations r WHERE r.school_id=$1 AND r.status='RESERVED' LIMIT 1",[S.A1]));
  const g2=lost?{reservationId:lost.id,version:lost.version}:(await reserve('A1','image.generate',1)).reservation;
  await settle(g2,{outcome:'UNKNOWN',finalUnits:null,providerCostMicrounits:null},K(),'ownerA');
  const res=await wallet.resolveReservation(H('owner'),g2.reservationId,{resolution:'NOT_CHARGED',expectedVersion:g2.version+1,finalUnits:null,providerCostMicrounits:null,evidenceReference:'FIXTURE-CW1R-NO-COST-YET'},K());
  assert.deepEqual([res.reservation.status,res.reservation.costStatus,res.reservation.providerCostMicrounits],['RELEASED','UNKNOWN',null],'HQ may release credits without guessing a zero cost');
  const rec=await wallet.recordProviderCost(H('owner'),g2.reservationId,{expectedVersion:res.reservation.version,providerCostMicrounits:5100,evidenceReference:'FIXTURE-CW1R-INVOICE-LINE'},K());
  assert.deepEqual([rec.reservation.costStatus,rec.reservation.providerCostMicrounits],['RECORDED',5100]);
  await deny(wallet.recordProviderCost(H('owner'),g2.reservationId,{expectedVersion:rec.reservation.version,providerCostMicrounits:1,evidenceReference:'FIXTURE-CW1R-SECOND'},K()),409,'SAAS_TRANSITION_NOT_ALLOWED');
  await deny(wallet.recordProviderCost(H('ownerA'),g2.reservationId,{expectedVersion:rec.reservation.version,providerCostMicrounits:1,evidenceReference:'x'},K()),403,'SAAS_FORBIDDEN');
  const hq=await wallet.readSchoolWalletFromHq(H('owner'),S.A1);
  assert.equal(hq.providerExpense.unknownCostGenerations,0);
 });


 // ---------- P2-W (Manus round 2, Task 4): authority, eligibility and expiry are decided AFTER the wallet-lock wait ----------
 // Deterministic two-connection proofs: a holder transaction keeps school C's wallet lock while the API request waits on
 // it (confirmed with pg_blocking_pids, never a sleep), the condition changes by the server clock during the wait
 // (confirmed with clock_timestamp()), then the holder releases. A decision taken before the wait must not survive it.
 let lot,until,before,out;
 await check('P2-W0','fixture: third paid school C',async()=>{
  const r=await register('ownerC',details('C'));created.push(r.organizationId);S.orgC=r.organizationId;S.C=r.schoolId;
  const co=await payments.startSchoolHonOsCheckout(H('ownerC'),r.schoolId,{offerId:pub.set.offers[0].offerId},K());
  assert.deepEqual([(await deliver(sim.completeCheckout(co.checkout.providerSessionId).completed)).event.detail],['ACCESS_ACTIVATED'],'C paid');
 });
 const serverPassed=async t=>(await row('SELECT clock_timestamp() > $1::timestamptz p',[t])).p;
 const untilPassed=async t=>{for(let i=0;i<200&&!(await serverPassed(t));i++)await new Promise(z=>setTimeout(z,25));assert.ok(await serverPassed(t),'server clock passed the expiry');};
 // Runs `request` while a holder keeps C's wallet lock; `during` runs once the request is provably blocked on the holder.
 async function duringWalletWait(request,during){
  const holder=await ownerPool.connect();
  try{
   await holder.query('BEGIN');await holder.query('SELECT hon.saas_creative_lock_wallet($1,clock_timestamp())',[S.C]);
   const hpid=(await holder.query('SELECT pg_backend_pid() p')).rows[0].p;
   const pending=request().then(v=>({ok:true,v}),e=>({ok:false,e}));
   let blocked=0;
   for(let i=0;i<400&&!blocked;i++){blocked=(await row('SELECT count(*)::int n FROM pg_stat_activity a WHERE $1=ANY(pg_blocking_pids(a.pid))',[hpid])).n;if(!blocked)await new Promise(z=>setTimeout(z,10));}
   assert.ok(blocked>0,'the request is blocked on the held wallet lock');
   await during();
   await holder.query('ROLLBACK');
   return await pending;
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
 }
 const counts=async()=>row("SELECT (SELECT count(*)::int FROM hon.saas_creative_lots WHERE school_id=$1) lots,(SELECT count(*)::int FROM hon.saas_creative_reservations WHERE school_id=$1) res,(SELECT count(*)::int FROM hon.saas_creative_ledger WHERE school_id=$1) ledger,(SELECT count(*)::int FROM hon.saas_audit WHERE organization_id=$2) audit",[S.C,S.orgC]);
 const refusedWith=(out,codes)=>{assert.equal(out.ok,false,'the waiting request is refused, not completed with a pre-wait decision');assert.ok(codes.includes(out.e?.getResponse?.()?.code),String(out.e?.getResponse?.()?.code??out.e));};
 const setEntitlementUntil=t=>admin.query('UPDATE hon.organization_entitlements SET effective_until=$2 WHERE organization_id=$1',[S.orgC,t]);
 const setGrantsUntil=async t=>{await admin.query('BEGIN');try{await admin.query('ALTER TABLE hon.principal_role_grants DISABLE TRIGGER USER');
  await admin.query('UPDATE hon.principal_role_grants SET effective_until=$3 WHERE principal_id=$1 AND organization_id=$2',[humans.ownerC.id,S.orgC,t]);
  await admin.query('ALTER TABLE hon.principal_role_grants ENABLE TRIGGER USER');await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}};
 const soon=async ms=>(await row(`SELECT clock_timestamp()+interval '${ms} milliseconds' t`)).t;

 await check('P2-W1a','window opening re-checks requester authority after a wallet-lock wait (role grant expired during the wait: no window granted)',async()=>{
  // W1a: the requester's grant expires while window opening waits: no included window may be granted afterwards.
  until=await soon(1200);await setGrantsUntil(until);
  try{
  before=await counts();
  out=await duringWalletWait(()=>wallet.openWindow(H('ownerC'),S.C,K()),async()=>{assert.equal(await serverPassed(until),false,'blocked before the expiry');await untilPassed(until);});
  refusedWith(out,['SAAS_FORBIDDEN']);
  assert.deepEqual(await counts(),before,'no lot, ledger entry, reservation or audit action');
  }finally{await setGrantsUntil(null);}
 });
 await check('P2-W1b','window opening re-checks the entitlement after a wallet-lock wait (entitlement ended during the wait: no window granted)',async()=>{
  // W1b: the entitlement ends while window opening waits: no included window may be granted afterwards.
  until=await soon(1200);await setEntitlementUntil(until);
  try{
  before=await counts();
  out=await duringWalletWait(()=>wallet.openWindow(H('ownerC'),S.C,K()),async()=>{assert.equal(await serverPassed(until),false,'blocked before the expiry');await untilPassed(until);});
  refusedWith(out,['SAAS_FORBIDDEN','SAAS_CREATIVE_ENTITLEMENT_NOT_IN_EFFECT','SAAS_CREATIVE_AI_ACCESS_LAPSED']);
  assert.deepEqual(await counts(),before,'no lot, ledger entry, reservation or audit action');
  }finally{await setEntitlementUntil(null);lot=(await wallet.openWindow(H('ownerC'),S.C,K())).lot;}
  assert.equal(lot.credits,12000);
 });
 await check('P2-W2','a reservation re-checks requester authority after a wallet-lock wait (role grant expired during the wait: refused, nothing written); an in-flight cost still records',async()=>{
  // W2: the requester's role grant expires while a reservation waits: refused 403; a generation already in flight
  //     (reserved before) still records its provider result and cost.
  const inflight=(await reserve('C','image.generate',2)).reservation;
  until=await soon(1200);await setGrantsUntil(until);
  try{
  before=await counts();
  out=await duringWalletWait(()=>reserve('C','image.generate',1),async()=>{assert.equal(await serverPassed(until),false,'blocked before the expiry');await untilPassed(until);});
  refusedWith(out,['SAAS_FORBIDDEN']);
  assert.deepEqual(await counts(),before,'no reservation, ledger entry or audit action after the wait');
  assert.equal((await settle(inflight,{outcome:'SUCCEEDED',finalUnits:2,providerCostMicrounits:21000},K(),'ownerC')).reservation.status,'FINALIZED','the in-flight result and its cost still record');
  }finally{await setGrantsUntil(null);for(const x of (await admin.query("SELECT id,version FROM hon.saas_creative_reservations WHERE school_id=$1 AND status='RESERVED'",[S.C])).rows)await settle({reservationId:x.id,version:x.version},{outcome:'FAILED',finalUnits:null,providerCostMicrounits:0},K(),'ownerC');}
 });
 await check('P2-W3','concurrent retries with one key during a wallet-lock wait create exactly one reservation',async()=>{
  // W3: concurrent retries with one key while waiting: exactly one reservation. The concurrent duplicate is told the
  //     request may not be assumed applied (409, retry with the same key); the retry replays the same reservation.
  const key=K();before=await counts();
  out=await duringWalletWait(()=>Promise.allSettled([reserve('C','image.generate',1,key),reserve('C','image.generate',1,key)]),async()=>{});
  const won=out.v.filter(x=>x.status==='fulfilled'),lost=out.v.filter(x=>x.status==='rejected');
  assert.deepEqual([won.length,lost.length],[1,1],'one request applies, the concurrent duplicate does not');
  http(409,'SAAS_OUTCOME_UNKNOWN')(lost[0].reason);// in progress: retry with the same key
  const again=await reserve('C','image.generate',1,key);
  assert.deepEqual([again.replayed,again.reservation.reservationId],[true,won[0].value.reservation.reservationId],'the retry replays the same reservation');
  assert.equal((await counts()).res,before.res+1,'exactly one reservation for one key');
  await settle(won[0].value.reservation,{outcome:'FAILED',finalUnits:null,providerCostMicrounits:0},K(),'ownerC');
 });
 await check('P2-W4','an HQ pause issued during a wallet-lock wait is serialized behind the waiting reservation; nothing is reserved after it',async()=>{
  // W4: an HQ pause issued while a reservation waits is serialized behind it (the reservation was decided first);
  //     nothing is reserved after the pause commits.
  let pausing;
  out=await duringWalletWait(()=>reserve('C','image.generate',1),async()=>{pausing=pause('PAUSE',S.orgC,'CREATIVE_MEDIA');await new Promise(z=>setTimeout(z,200));});
  const pz=await pausing;
  try{
  assert.equal(out.ok,true,'decided before the pause committed');
  assert.ok(new Date(out.v.reservation.reservedAt)<=(await row('SELECT paused_at FROM hon.ai_spend_pauses WHERE id=$1',[pz.pauseId])).paused_at);
  await deny(reserve('C','image.generate',1),422,'SAAS_CREATIVE_AI_PAUSED_BY_HQ');
  await settle(out.v.reservation,{outcome:'FAILED',finalUnits:null,providerCostMicrounits:0},K(),'ownerC');
  }finally{await pause('RESUME',S.orgC,'CREATIVE_MEDIA');}
 });
 await check('P2-W5','an included window that ends during a wallet-lock wait cannot fund the waiting reservation',async()=>{
  // W5: the funding window ends while a reservation waits: the expired lot cannot fund it.
  until=await soon(1200);
  await admin.query('BEGIN');try{await admin.query('ALTER TABLE hon.saas_creative_lots DISABLE TRIGGER USER');
   await admin.query('UPDATE hon.saas_creative_lots SET window_end=$2,expires_at=$2 WHERE id=$1',[lot.lotId,until]);
   await admin.query('ALTER TABLE hon.saas_creative_lots ENABLE TRIGGER USER');await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}
  before=await counts();
  out=await duringWalletWait(()=>reserve('C','image.generate',1),async()=>{assert.equal(await serverPassed(until),false,'blocked before the expiry');await untilPassed(until);});
  refusedWith(out,['SAAS_CREDITS_EXHAUSTED','SAAS_CREATIVE_WINDOW_UNAVAILABLE','SAAS_CREATIVE_WINDOW_NOT_PAID']);
  const after=await counts();
  assert.deepEqual([after.res,after.audit],[before.res,before.audit],'no reservation or audit action funded by the expired window');
 });
 await setAccessProgram(false);programTouched=false;
}finally{
 if(programTouched)await setAccessProgram(false).catch(e=>console.error('RESTORE FAILED',e));
 await cleanup().catch(e=>console.error(e));
 await Promise.allSettled([admin.end(),ownerPool.end(),database.onModuleDestroy?.()]);
}
const failed=results.filter(r=>r[1]==='FAIL');
console.log(`${failed.length?'FAIL':'PASS'}: CW1 review regressions ${results.length-failed.length}/${results.length} (${results.map(r=>`${r[0]} ${r[1]}`).join(', ')})`);
if(failed.length)process.exitCode=1;
