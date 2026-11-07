import pg from 'pg';
import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// CS1 Creative Studio generations (proposed 0216) on the CW1 per-school creative wallet (0202). Real database, restricted
// runtime role, the real API services and a SYNTHETIC provider runtime injected by this proof (no network, no provider,
// no payment). Fixture: the CW1 review-regression fixture (two paid HON OS organizations, a second school in org A).
// DISPOSABLE DATABASE ONLY, TEST MODE, SIMULATED payments. Each check runs on its own so one failure never hides another.
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env),runtime={username:CHAMPIONS_RUNTIME_ROLE};
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
process.env.HON_RUNTIME_DATABASE_POOL_MAX='12';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasCreativeWalletService}=await import('../../../apps/api/dist/saas-billing/saas-creative-wallet.service.js');
const {CreativeStudioService}=await import('../../../apps/api/dist/creative-studio/creative-studio.service.js');
const {SyntheticCreativeProviderRuntime}=await import('../../../apps/api/dist/creative-studio/creative-provider-runtime.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {StripeTestModeAdapter}=await import('../../../apps/api/dist/payments/stripe-test-mode-adapter.js');
const {StripeSimulator}=await import('../../../apps/api/dist/payments/stripe-simulator.js');
const contracts=await import('@hon/contracts');
const SECRET='whsec_disposableFixtureSecret0123456789',KEY='sk_test_disposableFixtureKey0123456789';
const sim=new StripeSimulator(SECRET);
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),wallet=new SaasCreativeWalletService(billing);
const synthetic=new SyntheticCreativeProviderRuntime('SUCCEED'),studio=new CreativeStudioService(billing,synthetic);
const payments=new SaasPaymentsService(billing,database,new StripeTestModeAdapter({secretKey:KEY,webhookSecret:SECRET,provider:'STRIPE_SIMULATED',transport:sim.transport}));
const admin=new pg.Client(targets.owner);
const ownerPool=new pg.Pool({...targets.owner,max:8});
const creativeTables=['creative_generation_assets','creative_generations','saas_creative_ledger','saas_creative_reservations','saas_creative_lots','saas_creative_adjustments','saas_creative_topup_purchases',
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
const humans=Object.fromEntries(['owner','ownerA','ownerB','staffA2'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`cs1-${k}-${randomUUID()}`}]));
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
  // 0195 (final review): immutable pause/resume command identities reference the pause rows.
  const pauseTables=(await tableExists('ai_spend_pause_commands'))?['ai_spend_pause_commands','ai_spend_pauses']:['ai_spend_pauses'];
  const all=[...cts,'saas_creative_program',...saasTables,'saas_credit_program','saas_reward_fulfillment','saas_payment_program',...pauseTables];
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of cts)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query("UPDATE hon.saas_creative_program SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  if(pauseTables.length===2)await admin.query('DELETE FROM hon.ai_spend_pause_commands WHERE actor_principal_id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);
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
const details=k=>({legalName:`CS1 Fixture Dojo ${k} LLC`,displayName:`CS1 Dojo ${k}`,schoolName:`CS1 Dojo ${k} Main`,schoolSlug:`cs1-dojo-${k.toLowerCase()}`,timezone:'America/Chicago'});
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
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'CS1 Dojo A Second',$1::text,'America/Chicago')",[S.A2,S.orgA]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'CS1_STAFF','Fixture staff',false)",[roleA2,S.orgA]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions WHERE is_staff_assignable",[roleA2,S.orgA]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[S.orgA,S.A2,humans.staffA2.id,roleA2]);
 await admin.query('COMMIT');
 await wallet.publishRates(H('owner'),{termsReference:'Fixture provisional creative rates (not final prices)',rates:[
  {operationCode:'image.generate',mediaKind:'IMAGE',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,costEvidenceId:null},
  {operationCode:'video.generate',mediaKind:'VIDEO',displayName:'AI video',billingUnit:'VIDEO_SECOND',creditsPerUnit:50,maxUnitsPerRequest:60,costEvidenceId:null}]},K());
 await wallet.setProgram(H('owner'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'Fixture owner creative authorization (disposable)'},K());

 // ---------- CS1 helpers ----------
 const PROMPT='Spring kids karate camp poster with bold colors';
 const gen=(at,body={},key=K(),who=actor[at])=>studio.create(H(who),S[at],{operationCode:'image.generate',units:2,format:'SQUARE',prompt:PROMPT,...body},key);
 const createOnly=(at,body={},key=K(),who=actor[at])=>billing.call('createCreativeGeneration',[H(who),S[at],JSON.stringify({operationCode:'image.generate',units:1,format:'SQUARE',prompt:'In-flight fixture request',...body}),
  JSON.stringify({providerId:'HIGGSFIELD',modelCode:'synthetic-image-1'}),key,K(),K()],contracts.validateCreativeGenerationReceipt);
 const record=(who,gid,outcome)=>billing.call('recordCreativeGenerationResult',[H(who),gid,JSON.stringify(outcome)],contracts.validateCreativeGenerationReceipt);
 const res=gid=>row('SELECT r.* FROM hon.saas_creative_reservations r JOIN hon.creative_generations g ON g.reservation_id=r.id AND g.school_id=r.school_id WHERE g.id=$1',[gid]);
 const bal=async at=>(await wallet.readSchoolWallet(H(actor[at]),S[at])).balance;
 const success=(n=1)=>({outcome:'SUCCEEDED',finalUnits:n,providerCostMicrounits:1000*n,failureReason:null,
  assets:Array.from({length:n},(_,i)=>({mediaType:'image/png',width:1024,height:1024,durationSeconds:null,providerAssetReference:`synthetic:fixture:${i+1}`}))});
 const notSent={outcome:'NOT_SENT',finalUnits:null,providerCostMicrounits:null,failureReason:'PROVIDER_NOT_CONNECTED',assets:null};
 const generationCount=async school=>Number((await row('SELECT count(*) n FROM hon.creative_generations WHERE school_id=$1',[school])).n);
 const reservationCount=async school=>Number((await row('SELECT count(*) n FROM hon.saas_creative_reservations WHERE school_id=$1',[school])).n);
 for(const at of ['A1','A2','B'])await wallet.openWindow(H(actor[at]),S[at],K());

 await check('G1','a successful generation charges the actual units from that school only, records CREATIVE_MEDIA cost with zero customer credits, keeps audit and stores synthetic results',async()=>{
  synthetic.behaviour='SUCCEED';const calls=synthetic.calls.length;
  assert.equal((await bal('A1')).availableCredits,12000);
  const out=await gen('A1');const g=out.generation;
  assert.deepEqual([g.status,g.chargedCredits,g.reservedCredits,g.failureReason,g.assets.length,out.replayed],['SUCCEEDED',20,20,null,2,false]);
  assert.ok(g.assets.every((a,i)=>a.origin==='SYNTHETIC'&&a.ordinal===i+1&&a.mediaType==='image/png'&&a.width===1024&&a.durationSeconds===null));
  assert.equal(out.balance.availableCredits,11980);assert.equal((await bal('A2')).availableCredits,12000,'the sibling school wallet is untouched');
  assert.equal(synthetic.calls.length,calls+1);
  assert.deepEqual([synthetic.calls.at(-1).providerRequestId,synthetic.calls.at(-1).prompt,synthetic.calls.at(-1).format],[g.generationId,PROMPT,'SQUARE']);
  const r=await res(g.generationId);
  assert.deepEqual([r.status,r.status_reason,r.cost_status,Number(r.provider_cost_microunits),r.final_credits],['FINALIZED','PROVIDER_SUCCEEDED','RECORDED',2000,20]);
  const u=await row('SELECT spend_class,customer_credits,provider_cost_microunits,school_id FROM hon.ai_usage_ledger WHERE id=$1',[r.usage_id]);
  assert.deepEqual([u.spend_class,Number(u.customer_credits),Number(u.provider_cost_microunits),u.school_id],['CREATIVE_MEDIA',0,2000,S.A1]);
  const agent=await row(`SELECT (SELECT count(*) FROM hon.saas_credit_reservations WHERE organization_id=$1)::int b3,
    (SELECT count(*) FROM hon.ai_usage_ledger WHERE organization_id=$1 AND (spend_class<>'CREATIVE_MEDIA' OR customer_credits<>0))::int agent`,[S.orgA]);
  assert.deepEqual(agent,{b3:0,agent:0},'no internal agent budget, B3 credit or customer credit is used');
  const audit=(await admin.query('SELECT action_code FROM hon.saas_audit WHERE entity_id=$1 ORDER BY occurred_at',[r.id])).rows.map(x=>x.action_code);
  assert.deepEqual(audit,['saas.creative.reserve','saas.creative.settle']);
  const list=await studio.list(H('ownerA'),S.A1);
  assert.equal(list.provider,'CONNECTED');assert.equal(list.generations[0].generationId,g.generationId);
  assert.deepEqual(await studio.read(H('ownerA'),S.A1,g.generationId),g);
  assert.ok(!/HIGGSFIELD|synthetic-image|synthetic:|providerCost/.test(JSON.stringify(list)),'no provider identity, model, cost or reference in the school view');
 });

 await check('G2','the same key returns the same generation without a second reservation or provider call; a different body under the key is refused',async()=>{
  synthetic.behaviour='SUCCEED';const key=K();
  const first=await gen('A1',{},key);const calls=synthetic.calls.length,n=await reservationCount(S.A1);
  const again=await gen('A1',{},key);
  assert.deepEqual([again.replayed,again.generation.generationId,again.generation.status],[true,first.generation.generationId,'SUCCEEDED']);
  assert.deepEqual([synthetic.calls.length,await reservationCount(S.A1)],[calls,n]);
  await deny(gen('A1',{prompt:'A different poster'},key),409,'IDEMPOTENCY_KEY_REUSED');
  await deny(gen('A1',{units:3},key),409,'IDEMPOTENCY_KEY_REUSED');
  // Concurrent identical requests: one generation, one provider call.
  const k2=K(),c0=synthetic.calls.length,both=await Promise.allSettled([gen('A1',{},k2),gen('A1',{},k2)]);
  const ids=new Set(both.filter(x=>x.status==='fulfilled').map(x=>x.value.generation.generationId));
  assert.ok(ids.size<=1&&both.some(x=>x.status==='fulfilled'),'at most one generation for one key');
  for(const x of both.filter(x=>x.status==='rejected'))assert.equal(x.reason?.getStatus?.(),409);
  assert.equal(synthetic.calls.length,c0+1);
  assert.equal(Number((await row('SELECT count(*) n FROM hon.creative_generations WHERE idempotency_key=$1',[k2])).n),1);
 });

 await check('G3','failures return the credits: rejected cost stays UNKNOWN (never a guessed zero), a reported cost is recorded, not-sent is a known zero',async()=>{
  const start=(await bal('A1')).availableCredits;
  synthetic.behaviour='REJECT';const a=(await gen('A1')).generation;
  assert.deepEqual([a.status,a.failureReason,a.chargedCredits,a.assets.length],['FAILED','PROVIDER_REJECTED',null,0]);
  let r=await res(a.generationId);assert.deepEqual([r.status,r.cost_status,r.provider_cost_microunits,r.usage_id],['RELEASED','UNKNOWN',null,null]);
  synthetic.behaviour='REJECT_WITH_COST';const b=(await gen('A1')).generation;
  r=await res(b.generationId);assert.deepEqual([b.status,r.cost_status,Number(r.provider_cost_microunits)],['FAILED','RECORDED',250]);
  assert.equal((await row('SELECT spend_class FROM hon.ai_usage_ledger WHERE id=$1',[r.usage_id])).spend_class,'CREATIVE_MEDIA');
  synthetic.behaviour='PRE_SEND';const c=(await gen('A1')).generation;
  r=await res(c.generationId);assert.deepEqual([c.status,c.failureReason,r.cost_status,Number(r.provider_cost_microunits),r.usage_id],['FAILED','INVALID_REQUEST','RECORDED',0,null]);
  assert.equal((await bal('A1')).availableCredits,start,'every failed generation returned its credits');
  synthetic.behaviour='SUCCEED';
 });

 await check('G4','an unclear outcome holds the credits for the HQ owner; HQ resolution (not charged / charged) shows in the school view; no second record',async()=>{
  const start=await bal('A1');
  synthetic.behaviour='UNKNOWN';const a=(await gen('A1')).generation;
  assert.deepEqual([a.status,a.failureReason,a.chargedCredits],['UNDER_REVIEW','PROVIDER_UNKNOWN',null]);
  let b=await bal('A1');assert.deepEqual([b.availableCredits,b.heldCredits],[start.availableCredits-20,start.heldCredits+20],'credits are held, not charged');
  synthetic.behaviour='UNVERIFIED';const v=(await gen('A1')).generation;
  assert.deepEqual([v.status,v.failureReason],['UNDER_REVIEW','UNVERIFIED_RESULT'],'a result claiming more than was reserved is never trusted');
  await deny(record('ownerA',a.generationId,success(1)),409,'SAAS_TRANSITION_NOT_ALLOWED');
  const ra=await res(a.generationId);
  for(const who of ['ownerA','staffA2'])await deny(wallet.resolveReservation(H(who),ra.id,{resolution:'NOT_CHARGED',expectedVersion:ra.version,finalUnits:null,providerCostMicrounits:null,evidenceReference:'Fixture evidence'},K()),403,'SAAS_FORBIDDEN');
  await wallet.resolveReservation(H('owner'),ra.id,{resolution:'NOT_CHARGED',expectedVersion:ra.version,finalUnits:null,providerCostMicrounits:null,evidenceReference:'Fixture provider dashboard export'},K());
  const rv=await res(v.generationId);
  await wallet.resolveReservation(H('owner'),rv.id,{resolution:'SUCCEEDED',expectedVersion:rv.version,finalUnits:1,providerCostMicrounits:1000,evidenceReference:'Fixture provider invoice line'},K());
  const na=await studio.read(H('ownerA'),S.A1,a.generationId),nv=await studio.read(H('ownerA'),S.A1,v.generationId);
  assert.deepEqual([na.status,na.chargedCredits,na.assets.length],['RESOLVED_NOT_CHARGED',null,0]);
  assert.deepEqual([nv.status,nv.chargedCredits,nv.assets.length],['RESOLVED_CHARGED',10,0]);
  b=await bal('A1');assert.deepEqual([b.availableCredits,b.heldCredits],[start.availableCredits-10,start.heldCredits]);
  synthetic.behaviour='SUCCEED';
 });

 await check('G5','exact-school isolation: a sibling school or another organization never lists, reads or records another school\'s generation',async()=>{
  const g=(await gen('A1')).generation,mine=(await gen('A2')).generation;
  const sib=await studio.list(H('staffA2'),S.A2);
  assert.ok(sib.generations.every(x=>x.schoolId===S.A2)&&sib.generations.some(x=>x.generationId===mine.generationId));
  assert.ok(!JSON.stringify(sib).includes(g.generationId));
  await deny(studio.read(H('staffA2'),S.A2,g.generationId),404,'SAAS_UNAVAILABLE');
  await deny(studio.read(H('staffA2'),S.A1,g.generationId),403,'SAAS_FORBIDDEN');
  await deny(studio.list(H('ownerB'),S.A1),403,'SAAS_FORBIDDEN');
  await deny(studio.create(H('ownerB'),S.A1,{operationCode:'image.generate',units:1,format:'SQUARE',prompt:PROMPT},K()),403,'SAAS_FORBIDDEN');
  const open=(await createOnly('A1')).generation;
  for(const who of ['ownerB','staffA2','owner'])await deny(record(who,open.generationId,success(1)),403,'SAAS_FORBIDDEN');
  await deny(studio.list(`unknown-${randomUUID()}`,S.A1),403,'SAAS_FORBIDDEN');
  await record('ownerA',open.generationId,notSent);
 });

 await check('G6','fair use: at most 3 generations in progress per school; the 4th is refused without a reservation; other schools are unaffected',async()=>{
  const open=[];for(let i=0;i<3;i++)open.push((await createOnly('A1')).generation);
  const n=await reservationCount(S.A1),held=(await bal('A1')).heldCredits;
  await deny(createOnly('A1'),422,'CREATIVE_TOO_MANY_IN_PROGRESS');
  await deny(gen('A1'),422,'CREATIVE_TOO_MANY_IN_PROGRESS');
  assert.deepEqual([await reservationCount(S.A1),(await bal('A1')).heldCredits],[n,held],'the refused request reserved nothing');
  assert.equal((await gen('B')).generation.status,'SUCCEEDED','another school is not limited by this school');
  for(const g of open)await record('ownerA',g.generationId,notSent);
  assert.equal((await gen('A1')).generation.status,'SUCCEEDED');
 });

 await check('G7','an interrupted request (no answer recorded) is held as UNKNOWN only after 120 seconds; earlier it is still in progress',async()=>{
  const key=K(),body={operationCode:'image.generate',units:1,format:'SQUARE',prompt:'In-flight fixture request'};
  const g=(await createOnly('A1',{},key)).generation;
  await deny(record('ownerA',g.generationId,{outcome:'UNKNOWN',finalUnits:null,providerCostMicrounits:null,failureReason:'INTERRUPTED',assets:null}),409,'CREATIVE_GENERATION_IN_PROGRESS');
  const calls=synthetic.calls.length;
  assert.equal((await studio.create(H('ownerA'),S.A1,body,key)).generation.status,'GENERATING','a replay inside the window is answered unchanged');
  await admin.query('BEGIN');try{await admin.query('ALTER TABLE hon.creative_generations DISABLE TRIGGER USER');
   await admin.query("UPDATE hon.creative_generations SET created_at=created_at-interval '10 minutes' WHERE id=$1",[g.generationId]);
   await admin.query('ALTER TABLE hon.creative_generations ENABLE TRIGGER USER');await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}
  const held=await studio.create(H('ownerA'),S.A1,body,key);
  assert.deepEqual([held.replayed,held.generation.status,held.generation.failureReason],[true,'UNDER_REVIEW','INTERRUPTED']);
  assert.equal(synthetic.calls.length,calls,'the provider is never called again for a replay');
  const r=await res(g.generationId);assert.deepEqual([r.status,r.cost_status],['OUTCOME_UNKNOWN','PENDING']);
  await wallet.resolveReservation(H('owner'),r.id,{resolution:'NOT_CHARGED',expectedVersion:r.version,finalUnits:null,providerCostMicrounits:0,evidenceReference:'Fixture: provider shows no job'},K());
 });

 await check('G8','the S4 emergency pause and the program switch refuse new generations; a result already in flight is still recorded; the AI-team-only pause does not stop creative media',async()=>{
  const inflight=(await createOnly('A1')).generation;
  await pause('PAUSE',S.orgA,'CREATIVE_MEDIA');
  try{
   const n=await generationCount(S.A1);
   await deny(gen('A1'),422,'SAAS_CREATIVE_AI_PAUSED_BY_HQ');await deny(gen('A2'),422,'SAAS_CREATIVE_AI_PAUSED_BY_HQ');
   assert.equal(await generationCount(S.A1),n,'no generation row for a refused request');
   assert.equal((await record('ownerA',inflight.generationId,success(1))).generation.status,'SUCCEEDED','in-flight result recorded during the pause');
   assert.equal((await gen('B')).generation.status,'SUCCEEDED','another organization is unaffected');
  }finally{await pause('RESUME',S.orgA,'CREATIVE_MEDIA');}
  await pause('PAUSE',S.orgA,'AGENT_INFERENCE');
  try{assert.equal((await gen('A1')).generation.status,'SUCCEEDED','pausing the AI team does not stop Creative Studio');}
  finally{await pause('RESUME',S.orgA,'AGENT_INFERENCE');}
  const prog=(await row('SELECT version FROM hon.saas_creative_program WHERE program_id=1')).version;
  const inflight2=(await createOnly('A1')).generation;
  await wallet.setProgram(H('owner'),{action:'DEACTIVATE',expectedVersion:prog,authorizationReference:'Fixture owner pause (disposable)'},K());
  try{
   await deny(gen('A1'),422,'SAAS_CREATIVE_PROGRAM_INACTIVE');
   assert.equal((await record('ownerA',inflight2.generationId,success(1))).generation.status,'SUCCEEDED');
  }finally{await wallet.setProgram(H('owner'),{action:'ACTIVATE',expectedVersion:prog+1,authorizationReference:'Fixture owner resume (disposable)'},K());}
  await deny(gen('A1',{units:9}),422,'SAAS_OPERATION_UNITS_EXCEEDED');
  await deny(gen('A1',{operationCode:'audio.generate'}),422,'SAAS_OPERATION_NOT_PRICED');
 });

 await check('G9','video: one synthetic clip, charged per second; balance exhaustion refuses without a generation row',async()=>{
  const v=(await gen('A2',{operationCode:'video.generate',units:12,format:'PORTRAIT',prompt:'Ten second promo clip for our adult kickboxing class'})).generation;
  assert.deepEqual([v.status,v.mediaKind,v.chargedCredits,v.assets.length,v.assets[0].mediaType,v.assets[0].durationSeconds,v.assets[0].width],['SUCCEEDED','VIDEO',600,1,'video/mp4',12,1080]);
  const left=(await bal('A2')).availableCredits,n=await generationCount(S.A2);
  const need=Math.ceil((left+1)/3000);
  const tries=[];for(let i=0;i<need+1;i++)tries.push(await gen('A2',{operationCode:'video.generate',units:60,format:'LANDSCAPE',prompt:'Long clip'}).then(x=>x.generation.status,e=>e.getResponse?.().code));
  assert.ok(tries.includes('SAAS_CREDITS_EXHAUSTED'),JSON.stringify(tries));
  assert.equal(await generationCount(S.A2),n+tries.filter(t=>t==='SUCCEEDED').length,'no generation row for a refused request');
 });

 await check('G10','posture: deny-all private tables, four runtime entry points, private helpers, immutable request fields and results',async()=>{
  for(const t of ['creative_generations','creative_generation_assets']){
   const p=await row(`SELECT c.relrowsecurity rls,c.relforcerowsecurity forced,${['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'].map(x=>`has_table_privilege($1,c.oid,'${x}') "${x}"`).join(',')} FROM pg_class c WHERE c.oid=('hon.'||$2)::regclass`,[CHAMPIONS_RUNTIME_ROLE,t]);
   assert.deepEqual(p,{rls:true,forced:true,SELECT:false,INSERT:false,UPDATE:false,DELETE:false,TRUNCATE:false},t);
  }
  const fns=(await admin.query(`SELECT p.oid::regprocedure::text s,has_function_privilege($1,p.oid,'EXECUTE') x,
    coalesce((SELECT bool_or(a.grantee=0) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),false) pub
    FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname IN ('creative_prompt_ok','guard_creative_generation','creative_generation_json',
    'creative_generation_fingerprint','create_creative_generation','record_creative_generation_result','read_creative_generations','read_creative_generation') ORDER BY 1`,[CHAMPIONS_RUNTIME_ROLE])).rows;
  assert.deepEqual(fns.filter(f=>f.x).map(f=>f.s).sort(),['hon.create_creative_generation(text,uuid,jsonb,jsonb,uuid,uuid,uuid)','hon.read_creative_generation(text,uuid,uuid)',
   'hon.read_creative_generations(text,uuid)','hon.record_creative_generation_result(text,uuid,jsonb)']);
  assert.ok(fns.every(f=>!f.pub),'nothing is executable through PUBLIC');
  const runtimePool=database['getPool']();
  await assert.rejects(runtimePool.query('SELECT * FROM hon.creative_generations LIMIT 1'),e=>e.code==='42501');
  const g=(await gen('A1')).generation;
  await assert.rejects(admin.query("UPDATE hon.creative_generations SET prompt='changed' WHERE id=$1",[g.generationId]),e=>e.code==='42501');
  await assert.rejects(admin.query('DELETE FROM hon.creative_generations WHERE id=$1',[g.generationId]),e=>e.code==='42501');
  await assert.rejects(admin.query("UPDATE hon.creative_generation_assets SET width=1 WHERE generation_id=$1",[g.generationId]),e=>/IMMUTABLE|42501/.test(e.code+e.message));
  await assert.rejects(admin.query("INSERT INTO hon.creative_generation_assets(generation_id,school_id,ordinal,media_type,width,height,origin,provider_asset_reference,created_at) VALUES($1,$2,3,'image/png',1,1,'PROVIDER','x',now())",[g.generationId,S.A1]),e=>e.code==='23514','only SYNTHETIC results in CS1');
 });

 // ---------- P2-162-1 (Manus): authority is final for the generation write, not only for the CW1 reserve ----------
 // A trusted holder keeps hon.creative_generations IN SHARE MODE: the request passes the CW1 reserve (authority still
 // valid), then blocks on the generation insert (proved with pg_blocking_pids on the holder's exact PID, never a sleep).
 // The grant or entitlement ends by the server clock during that wait; the holder releases before the lock timeout.
 // The request must be refused with nothing written and the provider never called.
 const serverPassed=async t=>(await row('SELECT clock_timestamp() > $1::timestamptz p',[t])).p;
 const untilPassed=async t=>{for(let i=0;i<200&&!(await serverPassed(t));i++)await new Promise(z=>setTimeout(z,25));assert.ok(await serverPassed(t),'server clock passed the expiry');};
 const soon=async ms=>(await row(`SELECT clock_timestamp()+interval '${ms} milliseconds' t`)).t;
 async function duringGenerationWriteWait(request,during){
  const holder=await ownerPool.connect();let pending;
  try{
   await holder.query('BEGIN');await holder.query('LOCK TABLE hon.creative_generations IN SHARE MODE');
   const hpid=(await holder.query('SELECT pg_backend_pid() p')).rows[0].p;
   pending=request().then(v=>({ok:true,v}),e=>({ok:false,e}));
   let waiter=null;
   for(let i=0;i<300&&!waiter;i++){waiter=await row("SELECT l.pid,l.mode m FROM pg_locks l WHERE NOT l.granted AND l.locktype='relation' AND l.relation='hon.creative_generations'::regclass AND $1=ANY(pg_blocking_pids(l.pid))",[hpid]);if(!waiter)await new Promise(z=>setTimeout(z,10));}
   assert.ok(waiter,'the request is blocked on the generation write by the holder PID');
   assert.equal(waiter.m,'RowExclusiveLock','it waits for the generation insert lock (after the CW1 reserve has run)');
   await during();
   await holder.query('ROLLBACK');
   return await pending;
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await pending?.catch?.(()=>{});}
 }
 const countsB=async()=>row("SELECT (SELECT count(*)::int FROM hon.creative_generations WHERE school_id=$1) gens,(SELECT count(*)::int FROM hon.saas_creative_reservations WHERE school_id=$1) res,(SELECT count(*)::int FROM hon.saas_creative_ledger WHERE school_id=$1) ledger,(SELECT count(*)::int FROM hon.saas_audit WHERE organization_id=$2) audit,(SELECT count(*)::int FROM hon.saas_outbox o JOIN hon.saas_audit a ON a.id=o.audit_id WHERE a.organization_id=$2) outbox",[S.B,S.orgB]);
 const setEntitlementUntil=t=>admin.query('UPDATE hon.organization_entitlements SET effective_until=$2 WHERE organization_id=$1',[S.orgB,t]);
 const setGrantsUntil=async t=>{await admin.query('BEGIN');try{await admin.query('ALTER TABLE hon.principal_role_grants DISABLE TRIGGER USER');
  await admin.query('UPDATE hon.principal_role_grants SET effective_until=$3 WHERE principal_id=$1 AND organization_id=$2',[humans.ownerB.id,S.orgB,t]);
  await admin.query('ALTER TABLE hon.principal_role_grants ENABLE TRIGGER USER');await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}};
 const lateExpiry=async(set,codes)=>{
  const until=await soon(1200);await set(until);
  try{
   const before=await countsB(),calls=synthetic.calls.length;
   const out=await duringGenerationWriteWait(()=>gen('B'),async()=>{assert.equal(await serverPassed(until),false,'blocked before the expiry');await untilPassed(until);});
   assert.equal(out.ok,false,'the waiting request is refused, not completed with the reserve-time decision');
   assert.ok(codes.includes(out.e?.getResponse?.()?.code),String(out.e?.getResponse?.()?.code??out.e?.stack??out.e));
   assert.deepEqual(await countsB(),before,'no generation, reservation, ledger entry, audit or outbox row');
   assert.equal(synthetic.calls.length,calls,'the synthetic provider is never invoked');
  }finally{await set(null);}
 };
 await check('G11a','the generation write re-checks requester authority at the live clock: a role grant that expired while the insert waited refuses, nothing written, no provider call',
  ()=>lateExpiry(setGrantsUntil,['SAAS_FORBIDDEN']));
 await check('G11b','the generation write re-checks the entitlement at the live clock: an entitlement that ended while the insert waited refuses, nothing written, no provider call',
  ()=>lateExpiry(setEntitlementUntil,['SAAS_FORBIDDEN','SAAS_CREATIVE_ENTITLEMENT_NOT_IN_EFFECT','SAAS_CREATIVE_AI_ACCESS_LAPSED']));
 await check('G11c','control: the same generation-write wait with authority still valid completes once, with one provider call',async()=>{
  const calls=synthetic.calls.length;
  const out=await duringGenerationWriteWait(()=>gen('B'),async()=>{});
  assert.equal(out.ok,true,String(out.e?.stack??out.e));
  assert.deepEqual([out.v.generation.status,synthetic.calls.length],['SUCCEEDED',calls+1]);
 });
 await setAccessProgram(false);programTouched=false;
}finally{
 if(programTouched)await setAccessProgram(false).catch(e=>console.error('RESTORE FAILED',e));
 await cleanup().catch(e=>{console.error(e);process.exitCode=1;});
 await Promise.allSettled([admin.end(),ownerPool.end(),database.onModuleDestroy?.()]);
}
const failed=results.filter(r=>r[1]==='FAIL');
console.log(`${failed.length?'FAIL':'PASS'}: CS1 Creative Studio generations ${results.length-failed.length}/${results.length} (${results.map(r=>`${r[0]} ${r[1]}`).join(', ')})`);
if(failed.length)process.exitCode=1;
