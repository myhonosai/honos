import pg from 'pg';
import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// WB1 AI website drafts (0344): one draft = one CW1 (0202) reservation of a WEBSITE rate, per page, on the school's own wallet. Real database, restricted
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
const {CreativeWebsiteService}=await import('../../../apps/api/dist/creative-studio/creative-website.service.js');
const {SyntheticWebsiteDraftRuntime}=await import('../../../apps/api/dist/creative-studio/website-draft-runtime.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {StripeTestModeAdapter}=await import('../../../apps/api/dist/payments/stripe-test-mode-adapter.js');
const {StripeSimulator}=await import('../../../apps/api/dist/payments/stripe-simulator.js');
const contracts=await import('@hon/contracts');
const SECRET='whsec_disposableFixtureSecret0123456789',KEY='sk_test_disposableFixtureKey0123456789';
const sim=new StripeSimulator(SECRET);
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),wallet=new SaasCreativeWalletService(billing);
const synthetic=new SyntheticCreativeProviderRuntime('SUCCEED'),studio=new CreativeStudioService(billing,synthetic);
const fake=new SyntheticWebsiteDraftRuntime('SUCCEED'),sites=new CreativeWebsiteService(billing,fake);
const payments=new SaasPaymentsService(billing,database,new StripeTestModeAdapter({secretKey:KEY,webhookSecret:SECRET,provider:'STRIPE_SIMULATED',transport:sim.transport}));
const admin=new pg.Client(targets.owner);
const ownerPool=new pg.Pool({...targets.owner,max:8});
const creativeTables=['creative_website_draft_pages','creative_website_drafts','creative_avatars','creative_generation_assets','creative_generations','saas_creative_ledger','saas_creative_reservations','saas_creative_lots','saas_creative_adjustments','saas_creative_topup_purchases',
 'saas_creative_wallets','saas_creative_rates','saas_creative_rate_versions'];
// creative_avatar_videos (0277) references avatars: delete it first when present.
const optionalCreativeTables=['saas_creative_cost_events','creative_avatar_videos'];
const saasTables=['saas_access_transitions','saas_access_states','saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions',
 'saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions',
 'saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions',
 'saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const http=(n,code)=>e=>{assert.equal(e?.getStatus?.(),n,e?.stack??String(e));if(code)assert.equal(e.getResponse().code,code,e.stack);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
const humans=Object.fromEntries(['owner','ownerA','ownerB','staffA2'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`wb1-${k}-${randomUUID()}`}]));
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
const details=k=>({legalName:`WB1 Fixture Dojo ${k} LLC`,displayName:`WB1 Dojo ${k}`,schoolName:`WB1 Dojo ${k} Main`,schoolSlug:`wb1-dojo-${k.toLowerCase()}`,timezone:'America/Chicago'});
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
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'WB1 Dojo A Second',$1::text,'America/Chicago')",[S.A2,S.orgA]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'WB1_STAFF','Fixture staff',false)",[roleA2,S.orgA]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions WHERE is_staff_assignable",[roleA2,S.orgA]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[S.orgA,S.A2,humans.staffA2.id,roleA2]);
 await admin.query('COMMIT');
 await wallet.publishRates(H('owner'),{termsReference:'Fixture provisional creative rates (not final prices)',rates:[
  {operationCode:'image.generate',mediaKind:'IMAGE',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,costEvidenceId:null},
  {operationCode:'video.generate',mediaKind:'VIDEO',displayName:'AI video',billingUnit:'VIDEO_SECOND',creditsPerUnit:50,maxUnitsPerRequest:60,costEvidenceId:null}]},K());
 await wallet.setProgram(H('owner'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'Fixture owner creative authorization (disposable)'},K()); // ---------- WB1 helpers ----------
 const BRIEF='Family taekwondo school in a friendly neighborhood. Kids classes after school, adult classes in the evening.';
 const ask=(patch={})=>({operationCode:'website.draft',pages:['HOME','PROGRAMS','CONTACT'],brief:BRIEF,...patch});
 const make=(at,body={},key=K(),who=actor[at])=>sites.create(H(who),S[at],ask(body),key);
 const res=did=>row('SELECT r.* FROM hon.saas_creative_reservations r JOIN hon.creative_website_drafts d ON d.reservation_id=r.id AND d.school_id=r.school_id WHERE d.id=$1',[did]);
 const bal=async at=>(await wallet.readSchoolWallet(H(actor[at]),S[at])).balance;
 const counts=async school=>row('SELECT (SELECT count(*)::int FROM hon.creative_website_drafts WHERE school_id=$1) drafts,(SELECT count(*)::int FROM hon.creative_website_draft_pages WHERE school_id=$1) pages,(SELECT count(*)::int FROM hon.saas_creative_reservations WHERE school_id=$1) res,(SELECT count(*)::int FROM hon.creative_generations WHERE school_id=$1) gens',[school]);
 const WEBSITE_RATE={operationCode:'website.draft',mediaKind:'WEBSITE',displayName:'AI website draft',billingUnit:'PAGE',creditsPerUnit:150,maxUnitsPerRequest:8,costEvidenceId:null};
 const BASE_RATES=[{operationCode:'image.generate',mediaKind:'IMAGE',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,costEvidenceId:null}];
 const publish=rates=>wallet.publishRates(H('owner'),{termsReference:'Fixture provisional creative rates (not final prices)',rates},K());
 const publishRaw=rates=>ownerPool.query('SELECT hon.publish_saas_creative_rates($1,$2::jsonb,$3,$4,$5) r',[H('owner'),JSON.stringify({termsReference:'Fixture direct rates',rates}),K(),K(),K()]);
 const rawCreate=(at,body,key=K(),who=actor[at])=>billing.call('createCreativeWebsiteDraft',[H(who),S[at],JSON.stringify(body),JSON.stringify({providerId:'HIGGSFIELD',modelCode:'synthetic-website-1'}),key,K(),K()],contracts.validateCreativeWebsiteDraftReceipt);
 const rawRecord=(draftId,outcome,who='ownerA')=>billing.call('recordCreativeWebsiteDraftResult',[H(who),draftId,JSON.stringify(outcome)],contracts.validateCreativeWebsiteDraftReceipt);
 for(const at of ['A1','A2','B'])await wallet.openWindow(H(actor[at]),S[at],K());

 await check('WB1','no published website rate: a draft is refused before anything is written; the provider is never called',async()=>{
  const before=await counts(S.A1),calls=fake.calls.length;
  await deny(make('A1'),422,'SAAS_OPERATION_NOT_PRICED');
  assert.deepEqual(await counts(S.A1),before);assert.equal(fake.calls.length,calls);
 });

 await check('WB2','HQ publishes website rates per PAGE only: another unit, cost evidence or more than 8 pages is refused by the contract and by the database',async()=>{
  for(const bad of [{...WEBSITE_RATE,billingUnit:'REQUEST'},{...WEBSITE_RATE,maxUnitsPerRequest:9},{...WEBSITE_RATE,costEvidenceId:randomUUID()},
    {...BASE_RATES[0],billingUnit:'PAGE'}]){
   await deny(publish([...BASE_RATES,bad]),400,'INVALID_SAAS_INPUT');
   await assert.rejects(publishRaw([...BASE_RATES,bad]),e=>e.code==='22023',JSON.stringify(bad));
  }
  await publish([...BASE_RATES,WEBSITE_RATE]);
  const w=await wallet.readSchoolWallet(H('ownerA'),S.A1);
  assert.deepEqual(w.rates.rates.find(r=>r.operationCode==='website.draft'),{operationCode:'website.draft',mediaKind:'WEBSITE',displayName:'AI website draft',billingUnit:'PAGE',
   creditsPerUnit:150,maxUnitsPerRequest:8,rateBasis:'PROVISIONAL'});
  assert.equal((await studio.list(H('ownerA'),S.A1)).provider,'CONNECTED','the image studio still reads with a website rate published');
 });

 let first;
 await check('WB3','a draft is charged per page from that school only, one provider call with the brief and pages, usage recorded as creative TEXT with no AI-team charge',async()=>{
  fake.behaviour='SUCCEED';const calls=fake.calls.length;
  assert.equal((await bal('A1')).availableCredits,12000);
  const out=await make('A1');first=out.draft;
  assert.deepEqual([first.status,first.pages,first.reservedCredits,first.chargedCredits,first.failureReason,out.replayed],['SUCCEEDED',['HOME','PROGRAMS','CONTACT'],450,450,null,false]);
  assert.deepEqual(first.content.map(p=>[p.pageKey,p.origin]),[['HOME','SYNTHETIC'],['PROGRAMS','SYNTHETIC'],['CONTACT','SYNTHETIC']]);
  assert.equal(out.balance.availableCredits,11550);assert.equal((await bal('A2')).availableCredits,12000,'the sibling school wallet is untouched');
  assert.equal(fake.calls.length,calls+1);
  const c=fake.calls.at(-1);assert.deepEqual([c.providerRequestId,c.pages,c.brief,c.operationCode],[first.draftId,['HOME','PROGRAMS','CONTACT'],BRIEF,'website.draft']);
  const r=await res(first.draftId);assert.deepEqual([r.status,r.media_kind,r.units,r.final_credits],['FINALIZED','WEBSITE',3,450]);
  const usage=await row('SELECT spend_class,modality::text m,customer_credits,provider_cost_microunits c FROM hon.ai_usage_ledger WHERE id=$1',[r.usage_id]);
  assert.deepEqual([usage.spend_class,usage.m,Number(usage.customer_credits),Number(usage.c)],['CREATIVE_MEDIA','TEXT',0,6000]);
  const list=await sites.list(H('ownerA'),S.A1);
  assert.deepEqual([list.provider,list.drafts.map(d=>d.draftId),list.drafts[0].content],['CONNECTED',[first.draftId],null],'the list carries no page text');
  assert.deepEqual(await sites.read(H('ownerA'),S.A1,first.draftId),first);
 });

 await check('WB4','the same key returns the same draft without a second reservation or provider call; a different body under the key is refused',async()=>{
  const key=K(),a=await make('A1',{pages:['HOME']},key),before=await counts(S.A1),calls=fake.calls.length;
  const again=await make('A1',{pages:['HOME']},key);
  assert.deepEqual([again.replayed,again.draft.draftId,again.draft.status],[true,a.draft.draftId,'SUCCEEDED']);
  assert.deepEqual(await counts(S.A1),before);assert.equal(fake.calls.length,calls);
  await deny(make('A1',{pages:['ABOUT']},key),409,'IDEMPOTENCY_KEY_REUSED');
  await deny(make('A1',{pages:['HOME'],brief:'Another brief for the same key'},key),409,'IDEMPOTENCY_KEY_REUSED');
 });

 await check('WB5','only the pages returned are charged; failed returns everything; unclear or unverified is held for the HQ owner, who resolves it',async()=>{
  const start=(await bal('A1')).availableCredits;
  fake.behaviour='PARTIAL';const p=(await make('A1',{pages:['HOME','ABOUT']})).draft;
  assert.deepEqual([p.status,p.reservedCredits,p.chargedCredits,p.content.map(x=>x.pageKey)],['SUCCEEDED',300,150,['HOME']]);
  assert.equal((await bal('A1')).availableCredits,start-150);
  fake.behaviour='REJECT_WITH_COST';const f=(await make('A1')).draft;
  assert.deepEqual([f.status,f.failureReason,f.chargedCredits,f.content],['FAILED','PROVIDER_REJECTED',null,null]);
  assert.equal((await bal('A1')).availableCredits,start-150,'credits returned');
  assert.equal(Number((await res(f.draftId)).provider_cost_microunits),250,'the reported cost is recorded, never guessed');
  fake.behaviour='UNVERIFIED';const v=(await make('A1')).draft;
  assert.deepEqual([v.status,v.failureReason],['UNDER_REVIEW','UNVERIFIED_RESULT']);
  fake.behaviour='UNKNOWN';const u=(await make('A1')).draft;
  assert.deepEqual([u.status,u.failureReason],['UNDER_REVIEW','PROVIDER_UNKNOWN']);
  const b=await bal('A1');assert.deepEqual([b.availableCredits,b.heldCredits],[start-150-900,900]);
  for(const d of [u,v]){const r=await res(d.draftId);
   await wallet.resolveReservation(H('owner'),r.id,{resolution:'NOT_CHARGED',expectedVersion:r.version,finalUnits:null,providerCostMicrounits:null,evidenceReference:'Fixture provider dashboard export'},K());}
  assert.deepEqual((await sites.read(H('ownerA'),S.A1,u.draftId)).status,'RESOLVED_NOT_CHARGED');
  assert.equal((await bal('A1')).availableCredits,start-150);
  fake.behaviour='PRE_SEND';const n=(await make('A1')).draft;
  assert.deepEqual([n.status,n.failureReason],['FAILED','INVALID_REQUEST']);
  assert.equal(Number((await res(n.draftId)).provider_cost_microunits),0,'never sent: a known zero');
  fake.behaviour='SUCCEED';
 });

 await check('WB6','fair use: one draft in progress per school; the result is recorded once, only by its requester; other schools are unaffected',async()=>{
  const g=await rawCreate('A1',ask());assert.equal(g.draft.status,'GENERATING');
  const before=await counts(S.A1),calls=fake.calls.length;
  await deny(make('A1',{pages:['FAQ']}),422,'CREATIVE_TOO_MANY_IN_PROGRESS');
  assert.deepEqual(await counts(S.A1),before);assert.equal(fake.calls.length,calls);
  assert.equal((await make('A2')).draft.status,'SUCCEEDED','the limit is per school');
  await deny(rawRecord(g.draft.draftId,{outcome:'UNKNOWN',providerCostMicrounits:null,failureReason:'INTERRUPTED',pages:null}),409);
  await deny(rawRecord(g.draft.draftId,{outcome:'FAILED',providerCostMicrounits:null,failureReason:'PROVIDER_REJECTED',pages:null},'ownerB'),403);
  await deny(rawRecord(g.draft.draftId,{outcome:'SUCCEEDED',providerCostMicrounits:1,failureReason:null,pages:[{pageKey:'FAQ',title:'Not asked',sections:[{heading:'x',body:'y'}]}]}),400,'INVALID_SAAS_INPUT');
  const done=await rawRecord(g.draft.draftId,{outcome:'FAILED',providerCostMicrounits:null,failureReason:'PROVIDER_REJECTED',pages:null});
  assert.equal(done.draft.status,'FAILED');
  await deny(rawRecord(g.draft.draftId,{outcome:'FAILED',providerCostMicrounits:null,failureReason:'PROVIDER_REJECTED',pages:null}),409);
 });

 await check('WB7','kinds stay apart: an image rate never funds a draft, and the image route refuses a website rate, with nothing written either way',async()=>{
  const before=await counts(S.B),calls=fake.calls.length,icalls=synthetic.calls.length;
  await deny(make('B',{operationCode:'image.generate'}),422,'CREATIVE_WEBSITE_RATE_INVALID');
  await assert.rejects(studio.create(H('ownerB'),S.B,{operationCode:'website.draft',units:1,format:'SQUARE',prompt:BRIEF},K()));
  assert.deepEqual(await counts(S.B),before,'no draft, generation or reservation');
  assert.deepEqual([fake.calls.length,synthetic.calls.length],[calls,icalls]);
 });

 await check('WB8','closed input: unknown, repeated or out-of-order pages and an over-long brief are refused at the API and in the database',async()=>{
  const before=await counts(S.B);
  for(const bad of [{pages:['CONTACT','HOME']},{pages:['HOME','HOME']},{pages:['BLOG']},{pages:[]},{brief:'x'.repeat(1001)},{brief:' padded '}]){
   await deny(make('B',bad),400,'INVALID_SAAS_INPUT');
   await assert.rejects(rawCreate('B',ask(bad)),http(400,'INVALID_SAAS_INPUT'));
  }
  assert.deepEqual(await counts(S.B),before);
 });

 await check('WB9','exact-school isolation: a sibling school or another organization never lists or reads another school\'s draft',async()=>{
  await deny(sites.read(H('staffA2'),S.A2,first.draftId),404,'SAAS_UNAVAILABLE');
  assert.ok(!(await sites.list(H('staffA2'),S.A2)).drafts.some(d=>d.draftId===first.draftId));
  await deny(sites.read(H('ownerB'),S.A1,first.draftId),403,'SAAS_FORBIDDEN');
  await deny(sites.list(H('ownerB'),S.A1),403,'SAAS_FORBIDDEN');
  await deny(make('A1',{},K(),'ownerB'),403,'SAAS_FORBIDDEN');
 });

 await check('WB10','an HQ emergency pause of creative spend refuses new drafts with nothing written; resuming allows them again',async()=>{
  await pause('PAUSE',S.orgB,'CREATIVE_MEDIA');
  try{
   const before=await counts(S.B),calls=fake.calls.length;
   await assert.rejects(make('B'),e=>e?.getStatus?.()===422&&/^SAAS_CREATIVE_/.test(e.getResponse().code),'refused by the pause');
   assert.deepEqual(await counts(S.B),before);assert.equal(fake.calls.length,calls);
  }finally{await pause('RESUME',S.orgB,'CREATIVE_MEDIA');}
  assert.equal((await make('B')).draft.status,'SUCCEEDED');
 });

 await check('WB11','posture: deny-all private tables, four runtime entry points, private helpers, immutable pages and requests',async()=>{
  for(const t of ['creative_website_drafts','creative_website_draft_pages']){
   const p=await row(`SELECT c.relrowsecurity rls,c.relforcerowsecurity forced,${['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'].map(x=>`has_table_privilege($1,c.oid,'${x}') "${x}"`).join(',')} FROM pg_class c WHERE c.oid=$2::regclass`,[CHAMPIONS_RUNTIME_ROLE,'hon.'+t]);
   assert.deepEqual(p,{rls:true,forced:true,SELECT:false,INSERT:false,UPDATE:false,DELETE:false,TRUNCATE:false},t);
  }
  const fns=(await admin.query(`SELECT p.oid::regprocedure::text s,has_function_privilege($1,p.oid,'EXECUTE') x,
    coalesce((SELECT bool_or(a.grantee=0) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),false) pub
    FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname ~ 'creative_website' ORDER BY 1`,[CHAMPIONS_RUNTIME_ROLE])).rows;
  assert.equal(fns.length,12,JSON.stringify(fns));
  assert.deepEqual(fns.filter(f=>f.x).map(f=>f.s).sort(),['hon.create_creative_website_draft(text,uuid,jsonb,jsonb,uuid,uuid,uuid)','hon.read_creative_website_draft(text,uuid,uuid)',
   'hon.read_creative_website_drafts(text,uuid)','hon.record_creative_website_draft_result(text,uuid,jsonb)']);
  assert.ok(fns.every(f=>!f.pub),'nothing is executable through PUBLIC');
  await assert.rejects(database['getPool']().query('SELECT * FROM hon.creative_website_drafts LIMIT 1'),e=>e.code==='42501');
  await assert.rejects(admin.query("UPDATE hon.creative_website_draft_pages SET title='changed' WHERE draft_id=$1",[first.draftId]),e=>/IMMUTABLE|42501|55000/.test(e.code+e.message));
  await assert.rejects(admin.query("UPDATE hon.creative_website_drafts SET brief='changed brief' WHERE id=$1",[first.draftId]),e=>e.code==='42501');
  await assert.rejects(admin.query('DELETE FROM hon.creative_website_drafts WHERE id=$1',[first.draftId]),e=>e.code==='42501');
 });
 await setAccessProgram(false);programTouched=false;
}finally{
 if(programTouched)await setAccessProgram(false).catch(e=>console.error('RESTORE FAILED',e));
 await cleanup().catch(e=>{console.error(e);process.exitCode=1;});
 await Promise.allSettled([admin.end(),ownerPool.end(),database.onModuleDestroy?.()]);
}
const failed=results.filter(r=>r[1]==='FAIL');
console.log(`${failed.length?'FAIL':'PASS'}: WB1 AI website drafts ${results.length-failed.length}/${results.length} (${results.map(r=>`${r[0]} ${r[1]}`).join(', ')})`);
if(failed.length)process.exitCode=1;
