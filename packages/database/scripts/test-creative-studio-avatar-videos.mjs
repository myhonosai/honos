import pg from 'pg';
import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// A2 Creative Studio avatar videos (0277): one video = one CS1 generation (0216) of avatar.video for a READY avatar (0276) on the CW1 wallet (0202). Real database, restricted
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
const creativeTables=['creative_avatar_videos','creative_avatars','creative_generation_assets','creative_generations','saas_creative_ledger','saas_creative_reservations','saas_creative_lots','saas_creative_adjustments','saas_creative_topup_purchases',
 'saas_creative_wallets','saas_creative_rates','saas_creative_rate_versions'];
const optionalCreativeTables=['saas_creative_cost_events','creative_avatar_photo_consents','creative_avatar_photo_withdrawals','creative_avatar_photos','creative_avatar_photo_links'];
const saasTables=['saas_access_transitions','saas_access_states','saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions',
 'saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions',
 'saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions',
 'saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const http=(n,code)=>e=>{assert.equal(e?.getStatus?.(),n,e?.stack??String(e));if(code)assert.equal(e.getResponse().code,code,e.stack);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
const humans=Object.fromEntries(['owner','ownerA','ownerB','staffA2'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`vd1-${k}-${randomUUID()}`}]));
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
const details=k=>({legalName:`VD1 Fixture Dojo ${k} LLC`,displayName:`VD1 Dojo ${k}`,schoolName:`VD1 Dojo ${k} Main`,schoolSlug:`vd1-dojo-${k.toLowerCase()}`,timezone:'America/Chicago'});
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
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'VD1 Dojo A Second',$1::text,'America/Chicago')",[S.A2,S.orgA]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'VD1_STAFF','Fixture staff',false)",[roleA2,S.orgA]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions WHERE is_staff_assignable",[roleA2,S.orgA]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[S.orgA,S.A2,humans.staffA2.id,roleA2]);
 await admin.query('COMMIT');
 await wallet.publishRates(H('owner'),{termsReference:'Fixture provisional creative rates (not final prices)',rates:[
  {operationCode:'image.generate',mediaKind:'IMAGE',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,costEvidenceId:null},
  {operationCode:'video.generate',mediaKind:'VIDEO',displayName:'AI video',billingUnit:'VIDEO_SECOND',creditsPerUnit:50,maxUnitsPerRequest:60,costEvidenceId:null}]},K());
 await wallet.setProgram(H('owner'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'Fixture owner creative authorization (disposable)'},K());
 // ---------- A1 helpers ----------
 const DESC='Friendly taekwondo master in a black dobok, warm smile, studio lighting';
 const look=(patch={})=>({name:'Master Kim',style:'REALISTIC',description:DESC,...patch});
 const make=(at,body={},key=K(),who=actor[at])=>studio.createAvatar(H(who),S[at],look(body),key);
 const res=gid=>row('SELECT r.* FROM hon.saas_creative_reservations r JOIN hon.creative_generations g ON g.reservation_id=r.id AND g.school_id=r.school_id WHERE g.id=$1',[gid]);
 const bal=async at=>(await wallet.readSchoolWallet(H(actor[at]),S[at])).balance;
 const counts=async school=>row('SELECT (SELECT count(*)::int FROM hon.creative_avatar_videos WHERE school_id=$1) videos,(SELECT count(*)::int FROM hon.creative_avatars WHERE school_id=$1) avatars,(SELECT count(*)::int FROM hon.creative_generations WHERE school_id=$1) gens,(SELECT count(*)::int FROM hon.saas_creative_reservations WHERE school_id=$1) res',[school]);
 const AVATAR_RATE={operationCode:'avatar.create',mediaKind:'IMAGE',displayName:'AI avatar',billingUnit:'REQUEST',creditsPerUnit:100,maxUnitsPerRequest:1,costEvidenceId:null};
 const BASE_RATES=[{operationCode:'image.generate',mediaKind:'IMAGE',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,costEvidenceId:null}];
 const publish=rates=>wallet.publishRates(H('owner'),{termsReference:'Fixture provisional creative rates (not final prices)',rates},K());
 for(const at of ['A1','A2','B'])await wallet.openWindow(H(actor[at]),S[at],K());

 const VIDEO_RATE={operationCode:'avatar.video',mediaKind:'VIDEO',displayName:'AI avatar video',billingUnit:'VIDEO_SECOND',creditsPerUnit:50,maxUnitsPerRequest:60,costEvidenceId:null};
 const SCRIPT='Hi, I am Master Kim. Join our free trial class this Saturday at ten!';
 const clip=(avatarId,patch={})=>({avatarId,script:SCRIPT,seconds:15,format:'PORTRAIT',...patch});
 const film=(at,avatarId,patch={},key=K(),who=actor[at])=>studio.createAvatarVideo(H(who),S[at],clip(avatarId,patch),key);
 await publish([...BASE_RATES,AVATAR_RATE]);
 synthetic.behaviour='SUCCEED';
 const kim=(await make('A1')).avatar;assert.equal(kim.status,'READY');
 const kimB=(await make('B',{name:'Coach Ortiz'})).avatar;assert.equal(kimB.status,'READY');

 await check('VD1','no published avatar.video rate: making an avatar video is refused before anything is written; the provider is never called',async()=>{
  const before=await counts(S.A1),calls=synthetic.calls.length;
  await deny(film('A1',kim.avatarId),422,'SAAS_OPERATION_NOT_PRICED');
  assert.deepEqual(await counts(S.A1),before);assert.equal(synthetic.calls.length,calls);
 });
 await publish([...BASE_RATES,AVATAR_RATE,VIDEO_RATE]);

 let first;
 await check('VD2','an avatar video is one avatar.video generation: charged per second at the HQ rate from that school only, one provider call with the look and the script, READY with one synthetic clip',async()=>{
  const calls=synthetic.calls.length,start=(await bal('A1')).availableCredits,sibling=(await bal('A2')).availableCredits;
  const out=await film('A1',kim.avatarId);first=out.video;const g=first.generation;
  assert.deepEqual([first.status,first.avatarId,first.script,first.seconds,first.format,out.replayed],['READY',kim.avatarId,SCRIPT,15,'PORTRAIT',false]);
  assert.deepEqual([g.operationCode,g.mediaKind,g.units,g.format,g.prompt,g.status,g.chargedCredits,g.assets.length],['avatar.video','VIDEO',15,'PORTRAIT',SCRIPT,'SUCCEEDED',750,1]);
  assert.deepEqual([g.assets[0].durationSeconds,g.assets[0].origin],[15,'SYNTHETIC']);
  assert.equal(out.balance.availableCredits,start-750);assert.equal((await bal('A2')).availableCredits,sibling,'the sibling school wallet is untouched');
  assert.equal(synthetic.calls.length,calls+1);
  const c=synthetic.calls.at(-1);
  assert.deepEqual([c.operationCode,c.mediaKind,c.units,c.providerRequestId,c.prompt,c.modelCode,c.avatar],
   ['avatar.video','VIDEO',15,g.generationId,SCRIPT,'synthetic-avatar-video-1',{name:'Master Kim',style:'REALISTIC',description:DESC}]);
  const r=await res(g.generationId);assert.deepEqual([r.status,r.final_credits],['FINALIZED',750]);
  const usage=await row('SELECT spend_class,customer_credits FROM hon.ai_usage_ledger WHERE id=$1',[r.usage_id]);
  assert.deepEqual([usage.spend_class,Number(usage.customer_credits)],['CREATIVE_MEDIA',0]);
  assert.deepEqual((await studio.listAvatarVideos(H('ownerA'),S.A1)).videos.map(v=>v.videoId),[first.videoId]);
  assert.deepEqual(await studio.readAvatarVideo(H('ownerA'),S.A1,first.videoId),first);
  assert.ok((await studio.list(H('ownerA'),S.A1)).generations.some(x=>x.generationId===g.generationId),'it is also an ordinary generation in the history');
 });

 await check('VD3','the same key returns the same video without a second reservation or provider call; a different body under the key is refused',async()=>{
  const key=K(),a=await film('A1',kim.avatarId,{seconds:10,format:'SQUARE'},key),before=await counts(S.A1),calls=synthetic.calls.length;
  const again=await film('A1',kim.avatarId,{seconds:10,format:'SQUARE'},key);
  assert.deepEqual([again.replayed,again.video.videoId,again.video.status],[true,a.video.videoId,'READY']);
  assert.deepEqual(await counts(S.A1),before);assert.equal(synthetic.calls.length,calls);
  await deny(film('A1',kim.avatarId,{seconds:11,format:'SQUARE'},key),409,'IDEMPOTENCY_KEY_REUSED');
  await deny(film('A1',kim.avatarId,{seconds:10,format:'SQUARE',script:'Different words'},key),409,'IDEMPOTENCY_KEY_REUSED');
 });

 await check('VD4','only this school\'s READY avatar can speak: not-ready, other-school and unknown avatars are refused with nothing written, also at the database entry point',async()=>{
  synthetic.behaviour='UNKNOWN';const held=(await make('A1',{name:'Held look'})).avatar;assert.equal(held.status,'UNDER_REVIEW');
  synthetic.behaviour='REJECT';const failed=(await make('A1',{name:'Failed look'})).avatar;assert.equal(failed.status,'NOT_CREATED');
  synthetic.behaviour='SUCCEED';
  const before=await counts(S.A1),beforeA2=await counts(S.A2),calls=synthetic.calls.length;
  await deny(film('A1',held.avatarId),422,'CREATIVE_AVATAR_NOT_READY');
  await deny(film('A1',failed.avatarId),422,'CREATIVE_AVATAR_NOT_READY');
  await deny(film('A2',kim.avatarId),404,'SAAS_UNAVAILABLE');
  await deny(film('A1',K()),404,'SAAS_UNAVAILABLE');
  const direct=(at,avatarId)=>billing.call('createCreativeAvatarVideo',[H(actor[at]),S[at],JSON.stringify(clip(avatarId)),JSON.stringify({providerId:'HIGGSFIELD',modelCode:'synthetic-avatar-video-1'}),K(),K(),K()],contracts.validateCreativeAvatarVideoReceipt);
  await deny(direct('A2',kim.avatarId),404,'SAAS_UNAVAILABLE');
  await deny(direct('A1',held.avatarId),422,'CREATIVE_AVATAR_NOT_READY');
  await deny(direct('B',kim.avatarId),404,'SAAS_UNAVAILABLE');
  assert.deepEqual(await counts(S.A1),before);assert.deepEqual(await counts(S.A2),beforeA2);assert.equal(synthetic.calls.length,calls);
  const r=await res(held.generation.generationId);
  await wallet.resolveReservation(H('owner'),r.id,{resolution:'NOT_CHARGED',expectedVersion:r.version,finalUnits:null,providerCostMicrounits:null,evidenceReference:'Fixture provider dashboard export'},K());
 });

 await check('VD5','avatar.* stays reserved: the generic route refuses avatar.video, and the database rolls back an avatar.video or any other avatar.* generation without its record at commit',async()=>{
  const OTHER={...VIDEO_RATE,operationCode:'avatar.other',displayName:'Unknown avatar op'};
  await publish([...BASE_RATES,AVATAR_RATE,VIDEO_RATE,OTHER]);
  try{
   const before=await counts(S.A1);
   await deny(studio.create(H('ownerA'),S.A1,{operationCode:'avatar.video',units:15,format:'PORTRAIT',prompt:SCRIPT},K()),400,'INVALID_SAAS_INPUT');
   for(const op of ['avatar.video','avatar.other'])
    await assert.rejects(billing.call('createCreativeGeneration',[H('ownerA'),S.A1,JSON.stringify({operationCode:op,units:15,format:'PORTRAIT',prompt:SCRIPT}),
     JSON.stringify({providerId:'HIGGSFIELD',modelCode:'synthetic-avatar-video-1'}),K(),K(),K()],contracts.validateCreativeGenerationReceipt),undefined,op);
   assert.deepEqual(await counts(S.A1),before,'no orphan avatar generation, reservation or charge');
  }finally{await publish([...BASE_RATES,AVATAR_RATE,VIDEO_RATE]);}
 });

 await check('VD6','a rejected video returns its credits and is NOT_CREATED; an unclear one is held UNDER_REVIEW until the HQ owner resolves it',async()=>{
  const start=await bal('A1');
  synthetic.behaviour='REJECT';const f=(await film('A1',kim.avatarId,{seconds:5})).video;
  assert.deepEqual([f.status,f.generation.status,f.generation.chargedCredits],['NOT_CREATED','FAILED',null]);
  assert.equal((await bal('A1')).availableCredits,start.availableCredits,'credits returned');
  synthetic.behaviour='UNKNOWN';const u=(await film('A1',kim.avatarId,{seconds:6})).video;
  assert.deepEqual([u.status,u.generation.status],['UNDER_REVIEW','UNDER_REVIEW']);
  const b=await bal('A1');assert.deepEqual([b.availableCredits,b.heldCredits],[start.availableCredits-300,start.heldCredits+300]);
  const r=await res(u.generation.generationId);
  await wallet.resolveReservation(H('owner'),r.id,{resolution:'NOT_CHARGED',expectedVersion:r.version,finalUnits:null,providerCostMicrounits:null,evidenceReference:'Fixture provider dashboard export'},K());
  const after=await studio.readAvatarVideo(H('ownerA'),S.A1,u.videoId);
  assert.deepEqual([after.status,after.generation.status],['NOT_CREATED','RESOLVED_NOT_CHARGED']);
  synthetic.behaviour='SUCCEED';
 });

 await check('VD7','the HQ rate decides the media kind: an avatar.video rate that is not a video is refused with nothing written',async()=>{
  await publish([...BASE_RATES,AVATAR_RATE,{...VIDEO_RATE,mediaKind:'IMAGE',billingUnit:'IMAGE'}]);
  try{
   const before=await counts(S.B),calls=synthetic.calls.length;
   await deny(film('B',kimB.avatarId),422,'CREATIVE_AVATAR_RATE_INVALID');
   assert.deepEqual(await counts(S.B),before);assert.equal(synthetic.calls.length,calls);
  }finally{await publish([...BASE_RATES,AVATAR_RATE,VIDEO_RATE]);}
 });

 await check('VD8','length is 5 to 60 seconds at the API and in the database; nothing is written for a bad request',async()=>{
  const before=await counts(S.A1),calls=synthetic.calls.length;
  for(const seconds of [4,61,10.5])await deny(film('A1',kim.avatarId,{seconds}),400,'INVALID_SAAS_INPUT');
  for(const seconds of [4,61])await deny(billing.call('createCreativeAvatarVideo',[H('ownerA'),S.A1,JSON.stringify(clip(kim.avatarId,{seconds})),
   JSON.stringify({providerId:'HIGGSFIELD',modelCode:'synthetic-avatar-video-1'}),K(),K(),K()],contracts.validateCreativeAvatarVideoReceipt),400,'INVALID_SAAS_INPUT');
  assert.deepEqual(await counts(S.A1),before);assert.equal(synthetic.calls.length,calls);
 });

 await check('VD9','exact-school isolation: a sibling school or another organization never lists or reads another school\'s video',async()=>{
  await deny(studio.readAvatarVideo(H('staffA2'),S.A2,first.videoId),404,'SAAS_UNAVAILABLE');
  assert.ok(!(await studio.listAvatarVideos(H('staffA2'),S.A2)).videos.some(v=>v.videoId===first.videoId));
  await deny(studio.readAvatarVideo(H('ownerB'),S.A1,first.videoId),403,'SAAS_FORBIDDEN');
  await deny(studio.listAvatarVideos(H('ownerB'),S.A1),403,'SAAS_FORBIDDEN');
  await deny(film('A1',kim.avatarId,{},K(),'ownerB'),403,'SAAS_FORBIDDEN');
 });

 await check('VD10','posture: deny-all private table, three runtime entry points, private helpers, immutable videos',async()=>{
  const p=await row(`SELECT c.relrowsecurity rls,c.relforcerowsecurity forced,${['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'].map(x=>`has_table_privilege($1,c.oid,'${x}') "${x}"`).join(',')} FROM pg_class c WHERE c.oid='hon.creative_avatar_videos'::regclass`,[CHAMPIONS_RUNTIME_ROLE]);
  assert.deepEqual(p,{rls:true,forced:true,SELECT:false,INSERT:false,UPDATE:false,DELETE:false,TRUNCATE:false});
  const fns=(await admin.query(`SELECT p.oid::regprocedure::text s,has_function_privilege($1,p.oid,'EXECUTE') x,
    coalesce((SELECT bool_or(a.grantee=0) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),false) pub
    FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname ~ 'avatar_video' ORDER BY 1`,[CHAMPIONS_RUNTIME_ROLE])).rows;
  assert.equal(fns.length,5,JSON.stringify(fns));
  assert.deepEqual(fns.filter(f=>f.x).map(f=>f.s).sort(),['hon.create_creative_avatar_video(text,uuid,jsonb,jsonb,uuid,uuid,uuid)','hon.read_creative_avatar_video(text,uuid,uuid)','hon.read_creative_avatar_videos(text,uuid)']);
  assert.ok(fns.every(f=>!f.pub),'nothing is executable through PUBLIC');
  const guard=await row(`SELECT p.prosecdef d,has_function_privilege($1,p.oid,'EXECUTE') x FROM pg_proc p WHERE p.oid='hon.guard_creative_avatar_generation()'::regprocedure`,[CHAMPIONS_RUNTIME_ROLE]);
  assert.deepEqual(guard,{d:true,x:false},'the replaced guard stays a private definer');
  await assert.rejects(database['getPool']().query('SELECT * FROM hon.creative_avatar_videos LIMIT 1'),e=>e.code==='42501');
  await assert.rejects(admin.query("UPDATE hon.creative_avatar_videos SET script='changed' WHERE id=$1",[first.videoId]),e=>/IMMUTABLE|42501|55000/.test(e.code+e.message));
  await assert.rejects(admin.query('DELETE FROM hon.creative_avatar_videos WHERE id=$1',[first.videoId]),e=>/IMMUTABLE|42501|55000/.test(e.code+e.message));
 });

 // ---------- finality: authority is final for the video write, not only for the generation inside it ----------
 const serverPassed=async t=>(await row('SELECT clock_timestamp() > $1::timestamptz p',[t])).p;
 const untilPassed=async t=>{for(let i=0;i<200&&!(await serverPassed(t));i++)await new Promise(z=>setTimeout(z,25));assert.ok(await serverPassed(t),'server clock passed the expiry');};
 const soon=async ms=>(await row(`SELECT clock_timestamp()+interval '${ms} milliseconds' t`)).t;
 async function duringVideoWriteWait(request,during){
  const holder=await ownerPool.connect();let pending;
  try{
   await holder.query('BEGIN');await holder.query('LOCK TABLE hon.creative_avatar_videos IN SHARE MODE');
   const hpid=(await holder.query('SELECT pg_backend_pid() p')).rows[0].p;
   pending=request().then(v=>({ok:true,v}),e=>({ok:false,e}));
   let waiter=null;
   for(let i=0;i<300&&!waiter;i++){waiter=await row("SELECT l.pid,l.mode m FROM pg_locks l WHERE NOT l.granted AND l.locktype='relation' AND l.relation='hon.creative_avatar_videos'::regclass AND $1=ANY(pg_blocking_pids(l.pid))",[hpid]);if(!waiter)await new Promise(z=>setTimeout(z,10));}
   assert.ok(waiter,'the request is blocked on the video write by the holder PID');
   assert.equal(waiter.m,'RowExclusiveLock','it waits for the video insert (after the CS1 create has run)');
   await during();
   await holder.query('ROLLBACK');
   return await pending;
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await pending?.catch?.(()=>{});}
 }
 const setGrantsUntil=async t=>{await admin.query('BEGIN');try{await admin.query('ALTER TABLE hon.principal_role_grants DISABLE TRIGGER USER');
  await admin.query('UPDATE hon.principal_role_grants SET effective_until=$3 WHERE principal_id=$1 AND organization_id=$2',[humans.ownerB.id,S.orgB,t]);
  await admin.query('ALTER TABLE hon.principal_role_grants ENABLE TRIGGER USER');await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}};
 await check('VD11a','the video write re-checks requester authority at the live clock: a grant that expired while the insert waited refuses, nothing written, no provider call',async()=>{
  const until=await soon(1500);await setGrantsUntil(until);
  try{
   const before=await counts(S.B),calls=synthetic.calls.length;
   const out=await duringVideoWriteWait(()=>film('B',kimB.avatarId),async()=>{assert.equal(await serverPassed(until),false,'blocked before the expiry');await untilPassed(until);});
   assert.equal(out.ok,false,'refused, not completed with the earlier decision');
   assert.equal(out.e?.getResponse?.()?.code,'SAAS_FORBIDDEN',String(out.e?.stack??out.e));
   assert.deepEqual(await counts(S.B),before,'no video, generation or reservation');
   assert.equal(synthetic.calls.length,calls);
  }finally{await setGrantsUntil(null);}
 });
 await check('VD11b','control: the same video-write wait with authority still valid completes once, with one provider call',async()=>{
  const calls=synthetic.calls.length;
  const out=await duringVideoWriteWait(()=>film('B',kimB.avatarId,{seconds:8}),async()=>{});
  assert.equal(out.ok,true,String(out.e?.stack??out.e));
  assert.deepEqual([out.v.video.status,synthetic.calls.length],['READY',calls+1]);
 });
 await setAccessProgram(false);programTouched=false;
}finally{
 if(programTouched)await setAccessProgram(false).catch(e=>console.error('RESTORE FAILED',e));
 await cleanup().catch(e=>{console.error(e);process.exitCode=1;});
 await Promise.allSettled([admin.end(),ownerPool.end(),database.onModuleDestroy?.()]);
}
const failed=results.filter(r=>r[1]==='FAIL');
console.log(`${failed.length?'FAIL':'PASS'}: A2 Creative Studio avatar videos ${results.length-failed.length}/${results.length} (${results.map(r=>`${r[0]} ${r[1]}`).join(', ')})`);
if(failed.length)process.exitCode=1;
