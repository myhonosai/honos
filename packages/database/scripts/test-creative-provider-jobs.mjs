import pg from 'pg';
import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// C1 creative provider jobs (0354): permits under the HQ per-provider daily limit, submission ids, worker lease/poll/record,
// deadline UNKNOWN, requester-unavailable, per-school daily caps. Built on CS1 (0216) and CW1 (0202). Real database, restricted
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
const creativeTables=['creative_provider_jobs','creative_generation_assets','creative_generations','saas_creative_ledger','saas_creative_reservations','saas_creative_lots','saas_creative_adjustments','saas_creative_topup_purchases',
 'saas_creative_wallets','saas_creative_rates','saas_creative_rate_versions'];
// creative_avatars (0276) and creative_avatar_videos (0277) reference generations: delete them first when present.
const optionalCreativeTables=['saas_creative_cost_events','creative_avatars','creative_avatar_videos'];
const limitTables=['creative_limit_commands','creative_school_daily_caps','creative_provider_daily_limits'];
const saasTables=['saas_access_transitions','saas_access_states','saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions',
 'saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions',
 'saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions',
 'saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const http=(n,code)=>e=>{assert.equal(e?.getStatus?.(),n,e?.stack??String(e));if(code)assert.equal(e.getResponse().code,code,e.stack);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
const humans=Object.fromEntries(['owner','ownerA','ownerB','staffA2'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`c1j-${k}-${randomUUID()}`}]));
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
  const all=[...limitTables,...cts,'saas_creative_program',...saasTables,'saas_credit_program','saas_reward_fulfillment','saas_payment_program',...pauseTables];
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of [...limitTables,...cts])await admin.query(`DELETE FROM hon.${t}`);
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
const details=k=>({legalName:`C1 Fixture Dojo ${k} LLC`,displayName:`C1 Dojo ${k}`,schoolName:`C1 Dojo ${k} Main`,schoolSlug:`c1j-dojo-${k.toLowerCase()}`,timezone:'America/Chicago'});
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
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'C1 Dojo A Second',$1::text,'America/Chicago')",[S.A2,S.orgA]);
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
 // ---------- C1 helpers ----------
 const pool=database['getPool']();
 const rt=async(sql,params)=>(await pool.query(sql,params)).rows[0]?.r;
 const code=c=>e=>{assert.ok(String(e?.message).includes(c),`expected ${c}, got ${e?.message}`);return true;};
 const refuse=(p,c)=>assert.rejects(p,code(c));
 const begin=(who,gid)=>rt('SELECT hon.begin_creative_provider_submission($1,$2) r',[H(who),gid]);
 const submitted=(who,gid,id)=>rt('SELECT hon.record_creative_provider_submission($1,$2,$3) r',[H(who),gid,id]);
 const rec=(who,gid,body)=>rt('SELECT hon.record_creative_generation_result($1,$2,$3::jsonb) r',[H(who),gid,JSON.stringify(body)]);
 const claim=(n=25,lease=60)=>admin.query('SELECT * FROM hon.claim_creative_provider_jobs($1,$2)',[n,lease]).then(r=>r.rows);
 const poll=(job,lease)=>admin.query('SELECT hon.record_creative_provider_job_poll($1,$2) r',[job,lease]).then(r=>r.rows[0].r);
 const result=(job,lease,body)=>admin.query('SELECT hon.record_creative_provider_job_result($1,$2,$3::jsonb) r',[job,lease,JSON.stringify(body)]).then(r=>r.rows[0].r);
 const setLimit=(micros,expectedVersion,key=K(),who='owner')=>rt('SELECT hon.command_creative_provider_daily_limit($1,$2::jsonb,$3) r',
  [H(who),JSON.stringify({providerId:'HIGGSFIELD',dailyLimitMicros:micros,reason:'Fixture daily provider limit for C1',expectedVersion}),key]);
 const setCaps=(school,caps,expectedVersion,key=K(),who='owner')=>rt('SELECT hon.command_creative_school_daily_caps($1,$2::jsonb,$3) r',
  [H(who),JSON.stringify({schoolId:school,...caps,reason:'Fixture school daily caps for C1',expectedVersion}),key]);
 const readHq=(who='owner')=>rt('SELECT hon.read_creative_limits_from_hq($1) r',[H(who)]);
 const job=gid=>row('SELECT * FROM hon.creative_provider_jobs WHERE generation_id=$1',[gid]);
 const gphase=async gid=>(await row('SELECT phase FROM hon.creative_generations WHERE id=$1',[gid])).phase;
 // Time travel for the disposable fixture only (the guard trigger forbids these moves to every role).
 const travel=async(jobId,sql)=>{await admin.query('BEGIN');try{await admin.query('ALTER TABLE hon.creative_provider_jobs DISABLE TRIGGER USER');
  await admin.query(`UPDATE hon.creative_provider_jobs SET ${sql} WHERE id=$1`,[jobId]);await admin.query('ALTER TABLE hon.creative_provider_jobs ENABLE TRIGGER USER');await admin.query('COMMIT');}
  catch(e){await admin.query('ROLLBACK');throw e;}};
 const due=jobId=>travel(jobId,"next_poll_at=clock_timestamp()-interval '1 second'");
 const failed={outcome:'FAILED',finalUnits:null,providerCostMicrounits:null,failureReason:'PROVIDER_REJECTED',assets:null};
 const unknownBody={outcome:'UNKNOWN',finalUnits:null,providerCostMicrounits:null,failureReason:'PROVIDER_UNKNOWN',assets:null};
 const interrupted={outcome:'UNKNOWN',finalUnits:null,providerCostMicrounits:null,failureReason:'INTERRUPTED',assets:null};
 let limitVersion=0;
 const ourJobs=async lease=>(await claim()).filter(j=>lease.includes(j.job_id));

 await check('J1','no HQ limit means no real submission: the permit is refused, NOT_SENT returns every credit, nothing is left reserved',async()=>{
  const before=(await bal('A1')).availableCredits;
  const g=(await createOnly('A1')).generation;
  await refuse(begin('ownerA',g.generationId),'CREATIVE_PROVIDER_LIMIT_NOT_SET');
  assert.equal(await job(g.generationId),undefined);
  const out=await rec('ownerA',g.generationId,notSent);
  assert.deepEqual([out.generation.status,(await bal('A1')).availableCredits],['FAILED',before]);
 });

 await check('J2','the provider limit is HQ-owner only, versioned, idempotent; key reuse and stale versions are refused',async()=>{
  await refuse(setLimit(1_000_000,0,K(),'ownerA'),'SAAS_FORBIDDEN');
  const key=K();const a=await setLimit(1_000_000,0,key);
  assert.deepEqual([a.version,a.replayed,a.dailyLimitMicros],[1,false,1_000_000]);
  assert.deepEqual([(await setLimit(1_000_000,0,key)).replayed],[true]);
  await refuse(setLimit(2_000_000,0,key),'CREATIVE_LIMIT_KEY_REUSED');
  await refuse(setLimit(2_000_000,0),'SAAS_VERSION_CONFLICT');
  await refuse(rt('SELECT hon.command_creative_provider_daily_limit($1,$2::jsonb,$3) r',[H('owner'),JSON.stringify({providerId:'OPENROUTER',dailyLimitMicros:1,reason:'Fixture wrong provider id',expectedVersion:1}),K()]),'INVALID_CREATIVE_LIMIT');
  limitVersion=1;
  const hq=await readHq();
  assert.equal(hq.providers.find(p=>p.providerId==='HIGGSFIELD').dailyLimitMicros,1_000_000);
  await refuse(readHq('ownerA'),'SAAS_FORBIDDEN');
 });

 const S1={};
 await check('J3','a permit records the worst case; the submission id is set once (same id replays, another id or a reused id is refused); a replayed permit never makes a second job',async()=>{
  const g=(await createOnly('A1')).generation;S1.g=g.generationId;
  const p=await begin('ownerA',g.generationId);
  assert.deepEqual([p.status,p.submitted,p.replayed],['PERMITTED',false,false]);
  assert.equal((await begin('ownerA',g.generationId)).replayed,true);
  const j=await job(g.generationId);assert.deepEqual([Number(j.worst_case_micros),j.status],[100000,'PERMITTED'],'10 credits x $0.01');
  await refuse(begin('staffA2',g.generationId),'SAAS_FORBIDDEN');
  await refuse(submitted('staffA2',g.generationId,'hf-req-1'),'SAAS_FORBIDDEN');
  const s=await submitted('ownerA',g.generationId,'hf-req-1');
  assert.deepEqual([s.status,s.submitted,s.replayed],['SUBMITTED',true,false]);
  assert.equal((await submitted('ownerA',g.generationId,'hf-req-1')).replayed,true);
  await refuse(submitted('ownerA',g.generationId,'hf-req-2'),'CREATIVE_PROVIDER_JOB_MISMATCH');
  const g2=(await createOnly('A1')).generation;S1.g2=g2.generationId;await begin('ownerA',g2.generationId);
  await refuse(submitted('ownerA',g2.generationId,'hf-req-1'),'CREATIVE_PROVIDER_JOB_MISMATCH');
  await refuse(submitted('ownerA',g2.generationId,'bad id with spaces'),'INVALID_SAAS_INPUT');
 });

 await check('J4','a submitted job cannot be recorded by the runtime (success, failure, unknown or INTERRUPTED); a still-PERMITTED job takes FAILED from the requester and closes as REQUESTER',async()=>{
  for(const b of [success(1),failed,unknownBody,interrupted])await refuse(rec('ownerA',S1.g,b),'CREATIVE_GENERATION_HAS_PROVIDER_JOB');
  await refuse(rec('ownerA',S1.g2,success(1)),'CREATIVE_GENERATION_HAS_PROVIDER_JOB');
  await refuse(rec('ownerA',S1.g2,interrupted),'CREATIVE_GENERATION_HAS_PROVIDER_JOB');
  const out=await rec('ownerA',S1.g2,failed);
  assert.equal(out.generation.status,'FAILED');
  const j=await job(S1.g2);assert.deepEqual([j.status,j.closed_by],['RECORDED','REQUESTER']);
 });

 await check('J5','the worker leases only due SUBMITTED jobs; a poll backs off and frees the lease; a wrong or old lease is refused',async()=>{
  const j=await job(S1.g);
  assert.equal((await ourJobs([j.id])).length,0,'not due yet (10 s after submit)');
  await due(j.id);
  const [c]=await ourJobs([j.id]);
  assert.deepEqual([c.provider_id,c.provider_job_id,c.operation_code,c.media_kind,c.units,c.format],['HIGGSFIELD','hf-req-1','image.generate','IMAGE',1,'SQUARE']);
  assert.ok(!('prompt' in c),'the worker never gets the prompt');
  assert.equal((await ourJobs([j.id])).length,0,'a leased job is not claimed twice');
  await refuse(poll(j.id,K()),'CREATIVE_JOB_LEASE_LOST');
  const p=await poll(j.id,c.lease_token);
  const after=await job(S1.g);
  assert.deepEqual([p.status,after.poll_count,after.lease_token],['SUBMITTED',1,null]);
  assert.ok(new Date(after.next_poll_at)-Date.now()>15_000,'second poll waits 20 seconds');
  await refuse(poll(j.id,c.lease_token),'CREATIVE_JOB_LEASE_LOST');
 });

 await check('J6','a worker result settles once through the 0216 rules for the requester: actual units charged, assets stored, job RECORDED by WORKER; a second result is refused',async()=>{
  const j=await job(S1.g);await due(j.id);
  const [c]=await ourJobs([j.id]);
  await refuse(result(j.id,c.lease_token,notSent),'INVALID_SAAS_INPUT');
  await refuse(result(j.id,c.lease_token,interrupted),'INVALID_SAAS_INPUT');
  const r=await result(j.id,c.lease_token,success(1));
  assert.equal(r.status,'RECORDED');
  assert.deepEqual((await admin.query('SELECT origin FROM hon.creative_generation_assets WHERE generation_id=$1',[S1.g])).rows.map(x=>x.origin),['PROVIDER']);
  const g=await studio.read(H('ownerA'),S.A1,S1.g);
  assert.deepEqual([g.status,g.chargedCredits,g.assets.length],['SUCCEEDED',10,1]);
  const after=await job(S1.g);assert.deepEqual([after.status,after.closed_by,after.lease_token],['RECORDED','WORKER',null]);
  const settled=await res(S1.g);
  assert.equal(settled.settled_by_principal_id,humans.ownerA.id,'the requester is the recorded actor');
  await refuse(result(j.id,c.lease_token,success(1)),'CREATIVE_JOB_LEASE_LOST');
 });

 await check('J7','a requester who is no longer usable: nothing is settled, the job closes REQUESTER_UNAVAILABLE, HQ sees it and resolves the still-RESERVED reservation',async()=>{
  const g=(await createOnly('A2')).generation;await begin('staffA2',g.generationId);await submitted('staffA2',g.generationId,'hf-req-gone');
  const j=await job(g.generationId);await due(j.id);const [c]=await ourJobs([j.id]);
  await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1',[humans.staffA2.id]);
  try{
   assert.equal((await result(j.id,c.lease_token,success(1))).status,'REQUESTER_UNAVAILABLE');
  }finally{await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1',[humans.staffA2.id]);}
  const r=await res(g.generationId);assert.equal(r.status,'RESERVED');
  assert.equal(await gphase(g.generationId),'SUBMITTING');
  const listed=(await readHq()).requesterUnavailable;
  assert.ok(listed.some(x=>x.jobId===j.id&&x.reservationId===r.id&&x.schoolId===S.A2&&x.providerResult.outcome==='SUCCEEDED'&&x.providerResult.assets.length===1),
   'the paid provider answer is kept on the job for HQ');
  await wallet.resolveReservation(H('owner'),r.id,{resolution:'NOT_CHARGED',expectedVersion:r.version,finalUnits:null,providerCostMicrounits:null,evidenceReference:'Fixture provider dashboard export'},K());
  assert.equal((await studio.read(H('staffA2'),S.A2,g.generationId)).status,'RESOLVED_NOT_CHARGED');
  assert.ok(!(await readHq()).requesterUnavailable.some(x=>x.jobId===j.id),'resolved jobs leave the HQ list');
 });

 await check('J8','a job with no answer by its 30-minute deadline (submitted or only permitted) is recorded UNKNOWN for HQ by the claim sweep, never resent',async()=>{
  const ids=[];
  for(const submit of [true,false]){
   const g=(await createOnly('B')).generation;await begin('ownerB',g.generationId);
   if(submit)await submitted('ownerB',g.generationId,`hf-req-late-${randomUUID().slice(0,8)}`);
   const j=await job(g.generationId);ids.push([g.generationId,j.id]);
   await travel(j.id,"permitted_at=permitted_at-interval '31 minutes',deadline_at=deadline_at-interval '31 minutes'");
  }
  assert.equal((await ourJobs(ids.map(x=>x[1]))).length,0,'expired jobs are swept, not leased');
  for(const [gid] of ids){
   const j=await job(gid);assert.deepEqual([j.status,j.closed_by],['TIMED_OUT','DEADLINE']);
   assert.equal((await studio.read(H('ownerB'),S.B,gid)).status,'UNDER_REVIEW');
   assert.equal((await res(gid)).status,'OUTCOME_UNKNOWN');
  }
 });

 await check('J9','the daily provider guard counts open and unknown jobs at worst case and recorded costs at cost; concurrent permits never pass the limit',async()=>{
  const committed=Number((await readHq()).providers.find(p=>p.providerId==='HIGGSFIELD').committedTodayMicros);
  // 2 open worst cases fit, a third does not.
  const v=(await setLimit(committed+200_000,limitVersion)).version;limitVersion=v;
  const gs=[];for(let i=0;i<3;i++)gs.push((await createOnly('B')).generation.generationId);
  const outs=await Promise.allSettled(gs.map(g=>begin('ownerB',g)));
  assert.deepEqual(outs.map(o=>o.status).sort(),['fulfilled','fulfilled','rejected']);
  assert.ok(String(outs.find(o=>o.status==='rejected').reason.message).includes('CREATIVE_PROVIDER_DAILY_LIMIT'));
  const loser=gs[outs.findIndex(o=>o.status==='rejected')];
  assert.equal((await rec('ownerB',loser,notSent)).generation.status,'FAILED','a refused permit releases its credits');
  // A finished job counts at its recorded cost (1,000 micro-USD), no longer at its 100,000 worst case.
  const winners=gs.filter(g=>g!==loser);
  const committedOf=async()=>Number((await readHq()).providers.find(p=>p.providerId==='HIGGSFIELD').committedTodayMicros);
  assert.equal(await committedOf(),committed+200_000);
  await submitted('ownerB',winners[0],`hf-req-cost-${randomUUID().slice(0,8)}`);
  const j=await job(winners[0]);await due(j.id);const [c]=await ourJobs([j.id]);
  await result(j.id,c.lease_token,success(1));
  assert.equal(await committedOf(),committed+101_000);
  // A failure with no reported cost stays at its worst case (never a guessed zero).
  assert.equal((await rec('ownerB',winners[1],failed)).generation.status,'FAILED');
  assert.equal(await committedOf(),committed+101_000);
  const g4=(await createOnly('B')).generation.generationId;
  await refuse(begin('ownerB',g4),'CREATIVE_PROVIDER_DAILY_LIMIT');
  limitVersion=(await setLimit(committed+201_000,limitVersion)).version;
  assert.equal((await begin('ownerB',g4)).status,'PERMITTED');
  await rec('ownerB',g4,failed);
 });

 await check('J10','per-school daily caps: HQ override per school, refused before any reservation, refunded generations do not count, other schools unaffected',async()=>{
  synthetic.behaviour='SUCCEED';
  const day=`date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  const used=Number((await row(`SELECT count(*) n FROM hon.creative_generations WHERE school_id=$1 AND created_at>=${day} AND phase NOT IN ('NOT_SENT','PROVIDER_FAILED') AND media_kind='IMAGE'`,[S.B])).n);
  await refuse(setCaps(S.B,{images:used+1,videos:12,avatarVideos:10},0,K(),'ownerB'),'SAAS_FORBIDDEN');
  assert.equal((await setCaps(S.B,{images:used+1,videos:12,avatarVideos:10},0)).version,1);
  await refuse(setCaps(S.B,{images:used+1,videos:12,avatarVideos:10},0),'SAAS_VERSION_CONFLICT');
  await gen('B',{units:1});
  const n=await reservationCount(S.B);
  await assert.rejects(gen('B',{units:1}),e=>{assert.match(JSON.stringify(e?.getResponse?.()??e?.message),/CREATIVE_DAILY_LIMIT_REACHED/);return true;});
  assert.equal(await reservationCount(S.B),n,'nothing reserved');
  assert.equal((await gen('A1',{units:1})).generation.status,'SUCCEEDED','school A1 keeps the default caps');
  await setCaps(S.B,{images:50,videos:12,avatarVideos:10},1);
  assert.equal((await gen('B',{units:1})).generation.status,'SUCCEEDED','raising the cap allows it again');
  assert.equal((await readHq()).schoolCaps.find(c=>c.schoolId===S.B).images,50);
  assert.equal((await row("SELECT hon.creative_cap_class('avatar.create','IMAGE') c")).c,null,'avatar.create keeps only its own 12-avatar limit');
  assert.equal((await row("SELECT hon.creative_cap_class('avatar.video','VIDEO') c")).c,'AVATAR_VIDEO');
 });

 await check('J12','a permit re-decides at the live clock: a stale generation (over 120 s), an HQ creative pause and a different staff member are refused; a real model needs a permit to record success',async()=>{
  const g=(await createOnly('B')).generation.generationId;
  await admin.query('BEGIN');await admin.query('ALTER TABLE hon.creative_generations DISABLE TRIGGER USER');
  await admin.query("UPDATE hon.creative_generations SET created_at=created_at-interval '121 seconds' WHERE id=$1",[g]);
  await admin.query('ALTER TABLE hon.creative_generations ENABLE TRIGGER USER');await admin.query('COMMIT');
  await refuse(begin('ownerB',g),'CREATIVE_GENERATION_STALE');
  assert.equal((await rec('ownerB',g,interrupted)).generation.status,'UNDER_REVIEW','an abandoned one is recorded INTERRUPTED, never sent');
  const g2=(await createOnly('B')).generation.generationId;
  await pause('PAUSE',S.orgB,'CREATIVE_MEDIA');
  try{await refuse(begin('ownerB',g2),'SAAS_CREATIVE_AI_PAUSED_BY_HQ');}
  finally{await pause('RESUME',S.orgB,'CREATIVE_MEDIA');}
  await rec('ownerB',g2,notSent);
  const real=(await billing.call('createCreativeGeneration',[H('ownerB'),S.B,JSON.stringify({operationCode:'image.generate',units:1,format:'SQUARE',prompt:'Real model fixture request'}),
   JSON.stringify({providerId:'HIGGSFIELD',modelCode:'hf-image-model'}),K(),K(),K()],contracts.validateCreativeGenerationReceipt)).generation.generationId;
  await refuse(rec('ownerB',real,success(1)),'CREATIVE_PROVIDER_PERMIT_REQUIRED');
  assert.equal((await rec('ownerB',real,notSent)).generation.status,'FAILED');
 });

 await check('J11','ACL: runtime has EXECUTE only on its entry points, the worker functions and private helpers are not granted to the runtime, no table access',async()=>{
  const can=async(role,fn)=>(await row('SELECT has_function_privilege($1,$2,\'EXECUTE\') ok',[role,fn])).ok;
  for(const f of ['hon.begin_creative_provider_submission(text,uuid)','hon.record_creative_provider_submission(text,uuid,text)','hon.record_creative_generation_result(text,uuid,jsonb)',
   'hon.command_creative_provider_daily_limit(text,jsonb,uuid)','hon.command_creative_school_daily_caps(text,jsonb,uuid)','hon.read_creative_limits_from_hq(text)'])
   assert.equal(await can(CHAMPIONS_RUNTIME_ROLE,f),true,f);
  for(const f of ['hon.claim_creative_provider_jobs(integer,integer)','hon.record_creative_provider_job_poll(uuid,uuid)','hon.record_creative_provider_job_result(uuid,uuid,jsonb)',
   'hon.creative_record_generation_result(text,uuid,jsonb,text)','hon.creative_close_provider_job(hon.creative_provider_jobs,jsonb,text)','hon.creative_requester_subject(uuid)'])
   assert.equal(await can(CHAMPIONS_RUNTIME_ROLE,f),false,f);
  for(const t of ['creative_provider_jobs','creative_provider_daily_limits','creative_school_daily_caps','creative_limit_commands']){
   assert.equal((await row("SELECT has_table_privilege($1,$2,'SELECT') ok",[CHAMPIONS_RUNTIME_ROLE,'hon.'+t])).ok,false,t);
   assert.equal((await row('SELECT relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass',['hon.'+t])).f,true,t);
  }
  await assert.rejects(pool.query('SELECT hon.claim_creative_provider_jobs(1,30)'),/permission denied/);
  if((await row("SELECT count(*)::int n FROM pg_roles WHERE rolname='hon_communication_worker'")).n)
   assert.equal(await can('hon_communication_worker','hon.claim_creative_provider_jobs(integer,integer)'),true);
 });
 await setAccessProgram(false);programTouched=false;
}finally{
 if(programTouched)await setAccessProgram(false).catch(e=>console.error('RESTORE FAILED',e));
 await cleanup().catch(e=>{console.error(e);process.exitCode=1;});
 await Promise.allSettled([admin.end(),ownerPool.end(),database.onModuleDestroy?.()]);
}
const failedChecks=results.filter(r=>r[1]==='FAIL');
console.log(`${failedChecks.length?'FAIL':'PASS'}: C1 creative provider jobs ${results.length-failedChecks.length}/${results.length} (${results.map(r=>`${r[0]} ${r[1]}`).join(', ')})`);
if(failedChecks.length)process.exitCode=1;
