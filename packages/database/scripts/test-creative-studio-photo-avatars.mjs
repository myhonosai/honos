import pg from 'pg';
import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// A3 Creative Studio photo avatars (0305): an adult staff member's OWN photo with signed likeness consent; delete erases it
// and withdraws the photo avatar and its videos. Built on A1 (0276), A2 (0277), CS1 (0216) and the CW1 wallet (0202). Real database, restricted
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
const humans=Object.fromEntries(['owner','ownerA','ownerB','staffA2','staffA1','staffA1b','parentA1'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`ph1-${k}-${randomUUID()}`}]));
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
const details=k=>({legalName:`PH1 Fixture Dojo ${k} LLC`,displayName:`PH1 Dojo ${k}`,schoolName:`PH1 Dojo ${k} Main`,schoolSlug:`ph1-dojo-${k.toLowerCase()}`,timezone:'America/Chicago'});
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
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'PH1 Dojo A Second',$1::text,'America/Chicago')",[S.A2,S.orgA]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'PH1_STAFF','Fixture staff',false)",[roleA2,S.orgA]);
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

  await publish([...BASE_RATES,AVATAR_RATE,VIDEO_RATE]);
 // ---------- A3 fixture: two staff members and one parent-coded principal at school A1 ----------
 const roleStaff=randomUUID(),roleParent=randomUUID();
 await admin.query('BEGIN');
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'PH1_INSTRUCTOR','Fixture instructor',false),($3,$2,'PARENT_PH1','Fixture parent',false)",[roleStaff,S.orgA,roleParent]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT r,$2,code FROM hon.permissions,unnest($1::uuid[]) r WHERE is_staff_assignable",[[roleStaff,roleParent],S.orgA]);
 for(const [who,role] of [['staffA1',roleStaff],['staffA1b',roleStaff],['parentA1',roleParent]])
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[S.orgA,S.A1,humans[who].id,role]);
 await admin.query('COMMIT');
 // A tiny structurally valid JPEG carrying EXIF (with a fake location), XMP-style APP1 and a comment that must be stripped.
 const seg=(marker,body)=>{const b=Buffer.from(body);const h=Buffer.alloc(4);h[0]=0xff;h[1]=marker;h.writeUInt16BE(b.length+2,2);return Buffer.concat([h,b]);};
 const jpeg=(tag='one')=>Buffer.concat([Buffer.from([0xff,0xd8]),seg(0xe0,Buffer.concat([Buffer.from('JFIF\0','latin1'),Buffer.from([1,1,0,0,1,0,1,0,0])])),
  seg(0xe1,Buffer.from('Exif\0\0GPS-SECRET-48.8584N-2.2945E camera=FixtureCam','latin1')),seg(0xfe,Buffer.from('COMMENT-SECRET','latin1')),
  seg(0xdb,Buffer.alloc(65,7)),seg(0xda,Buffer.from([1,1,0,0,0x3f,0])),Buffer.from(`scan-data-${tag}-`.repeat(8),'latin1'),Buffer.from([0xff,0xd9])]);
 const SIGN='Jordan Lee';
 const consent=(patch={})=>({consentVersion:contracts.CREATIVE_PHOTO_CONSENT_VERSION,ownLikeness:true,adult:true,marketingUse:true,signatureName:SIGN,contentType:'image/jpeg',photo:jpeg().toString('base64'),...patch});
 const upload=(who,patch={},key=K(),at='A1')=>studio.uploadPhoto(H(who),S[at],consent(patch),key);
 const photoCounts=async school=>row(`SELECT (SELECT count(*)::int FROM hon.creative_avatar_photo_consents WHERE school_id=$1) consents,(SELECT count(*)::int FROM hon.creative_avatar_photos WHERE school_id=$1) photos,
  (SELECT count(*)::int FROM hon.creative_avatar_photo_withdrawals WHERE school_id=$1) withdrawals,(SELECT count(*)::int FROM hon.creative_avatar_photo_links WHERE school_id=$1) links`,[school]);
 const photoAvatar=(who,consentId,patch={},key=K(),at='A1')=>studio.createPhotoAvatar(H(who),S[at],{consentId,name:'Coach Jordan',style:'REALISTIC',...patch},key);
 const all=async()=>({...(await counts(S.A1)),...(await photoCounts(S.A1))});

 let mine;
 await check('PH1','a staff member uploads their own photo with signed consent: stored without its embedded metadata, consent recorded, same key replays, a different body under the key is refused',async()=>{
  const key=K(),out=await upload('staffA1',{},key);mine=out.photo;
  assert.deepEqual([mine.status,mine.mine,mine.signatureName,mine.contentType,mine.withdrawnReason,mine.avatarIds,out.replayed],['ACTIVE',true,SIGN,'image/jpeg',null,[],false]);
  const stored=(await row('SELECT bytes FROM hon.creative_avatar_photos WHERE consent_id=$1',[mine.consentId])).bytes;
  assert.ok(!stored.includes('GPS-SECRET')&&!stored.includes('COMMENT-SECRET')&&!stored.includes('FixtureCam'),'EXIF location, camera and comment removed');
  assert.ok(stored.includes('JFIF')&&stored.includes('scan-data-one'),'the image data itself is kept');
  const c=await row('SELECT * FROM hon.creative_avatar_photo_consents WHERE id=$1',[mine.consentId]);
  assert.deepEqual([c.subject_principal_id,c.attests_own_likeness,c.attests_adult,c.attests_marketing_use,c.signature_name,c.consent_version,c.byte_size],
   [humans.staffA1.id,true,true,true,SIGN,'HON-LIKENESS-2026-11-12',stored.length]);
  assert.equal(c.photo_sha256,(await row("SELECT encode(sha256($1::bytea),'hex') h",[stored])).h);
  assert.ok(!Object.keys(c).some(k=>/byte(s|a)$|image/.test(k)&&k!=='byte_size'),'the consent record never holds the image');
  const before=await photoCounts(S.A1),again=await upload('staffA1',{},key);
  assert.deepEqual([again.replayed,again.photo.consentId],[true,mine.consentId]);assert.deepEqual(await photoCounts(S.A1),before);
  await deny(upload('staffA1',{signatureName:'Someone Else'},key),409,'IDEMPOTENCY_KEY_REUSED');
  const img=await studio.readPhotoImage(H('staffA1'),S.A1,mine.consentId);
  assert.deepEqual([img.contentType,Buffer.from(img.photo,'base64').equals(stored)],['image/jpeg',true],'the person in the photo can view it');
 });

 await check('PH2','consent must be complete and the file must really be an image of the declared type, at the API and in the database; nothing is written otherwise',async()=>{
  const before=await photoCounts(S.A1);
  for(const patch of [{adult:false},{ownLikeness:false},{marketingUse:false},{consentVersion:'OLD'},{signatureName:'J'},{signatureName:' padded '},
    {contentType:'image/gif'},{photo:'not base64!'},{photo:Buffer.alloc(1_048_577,1).toString('base64')}])
   await deny(upload('staffA1b',patch),400,'INVALID_SAAS_INPUT');
  await deny(upload('staffA1b',{contentType:'image/png'}),400,'INVALID_SAAS_INPUT');
  const {photo,...fields}=consent();
  const direct=(p,bytes)=>billing.call('uploadCreativeAvatarPhoto',[H('staffA1b'),S.A1,JSON.stringify(p),bytes,K()],contracts.validateCreativePhotoReceipt);
  await deny(direct({...fields,adult:false},photo),400,'INVALID_SAAS_INPUT');
  await deny(direct({...fields,extra:true},photo),400,'INVALID_SAAS_INPUT');
  await deny(direct(fields,Buffer.from('GIF89a'.padEnd(80,'x')).toString('base64')),400,'INVALID_SAAS_INPUT');
  assert.deepEqual(await photoCounts(S.A1),before);
 });

 await check('PH3','staff only: a parent-coded account, another organization and a sibling school\'s staff cannot upload for this school',async()=>{
  const before=await photoCounts(S.A1);
  await deny(upload('parentA1'),403,'SAAS_FORBIDDEN');
  await deny(upload('ownerB'),403,'SAAS_FORBIDDEN');
  await deny(upload('staffA2'),403,'SAAS_FORBIDDEN');
  assert.deepEqual(await photoCounts(S.A1),before);
 });

 await check('PH4','own photo only: another staff member cannot view, list, use or delete someone else\'s photo',async()=>{
  const other=await studio.listPhotos(H('staffA1b'),S.A1);
  assert.deepEqual([other.canManageAll,other.photos.length],[false,0]);
  await deny(studio.readPhotoImage(H('staffA1b'),S.A1,mine.consentId),404,'SAAS_UNAVAILABLE');
  await deny(studio.readPhotoImage(H('ownerA'),S.A1,mine.consentId),404,'SAAS_UNAVAILABLE');
  const before=await all(),calls=synthetic.calls.length;
  await deny(photoAvatar('staffA1b',mine.consentId),404,'SAAS_UNAVAILABLE');
  await deny(photoAvatar('ownerA',mine.consentId),404,'SAAS_UNAVAILABLE');
  await deny(studio.deletePhoto(H('staffA1b'),S.A1,mine.consentId),404,'SAAS_UNAVAILABLE');
  await deny(studio.deletePhoto(H('ownerB'),S.A1,mine.consentId),404,'SAAS_UNAVAILABLE');
  assert.deepEqual(await all(),before);assert.equal(synthetic.calls.length,calls);
 });

 let jordan,jordanVideo;
 await check('PH5','the person makes an avatar from their own photo: one avatar.create at the HQ rate from that school only, one synthetic call with the look and never the photo; same key replays',async()=>{
  const calls=synthetic.calls.length,start=(await bal('A1')).availableCredits,sibling=(await bal('A2')).availableCredits,key=K();
  const out=await photoAvatar('staffA1',mine.consentId,{},key);jordan=out.avatar;
  assert.deepEqual([jordan.status,jordan.name,jordan.style,jordan.generation.operationCode,jordan.generation.chargedCredits,out.replayed],['READY','Coach Jordan','REALISTIC','avatar.create',100,false]);
  assert.equal(out.balance.availableCredits,start-100);assert.equal((await bal('A2')).availableCredits,sibling);
  assert.equal(synthetic.calls.length,calls+1);
  const c=synthetic.calls.at(-1);assert.deepEqual(Object.keys(c.avatar).sort(),['description','name','style']);
  assert.ok(!JSON.stringify(c).includes(mine.consentId)&&!JSON.stringify(c).includes('scan-data'),'the provider never receives the photo');
  assert.deepEqual((await studio.listPhotos(H('staffA1'),S.A1)).photos[0].avatarIds,[jordan.avatarId]);
  const again=await photoAvatar('staffA1',mine.consentId,{},key);
  assert.deepEqual([again.replayed,again.avatar.avatarId,synthetic.calls.length],[true,jordan.avatarId,calls+1]);
  await deny(photoAvatar('staffA1',mine.consentId,{name:'Other'},key),409,'IDEMPOTENCY_KEY_REUSED');
  assert.ok((await studio.listAvatars(H('ownerA'),S.A1)).avatars.some(a=>a.avatarId===jordan.avatarId),'it is an ordinary avatar of the school');
 });

 await check('PH6','the school can make a talking video with the photo avatar while the likeness is live',async()=>{
  jordanVideo=(await film('A1',jordan.avatarId)).video;
  assert.equal(jordanVideo.status,'READY');
  assert.ok((await studio.listAvatarVideos(H('ownerA'),S.A1)).videos.some(v=>v.videoId===jordanVideo.videoId));
 });

 await check('PH7','the person deletes their photo: the image is erased, the consent stays as proof, the avatar, its videos and their generations disappear and cannot be used; repeating is harmless',async()=>{
  const del=await studio.deletePhoto(H('staffA1'),S.A1,mine.consentId);
  assert.deepEqual([del.photo.status,del.photo.withdrawnReason],['WITHDRAWN','DELETED_BY_SUBJECT']);
  assert.equal((await row('SELECT count(*)::int n FROM hon.creative_avatar_photos WHERE consent_id=$1',[mine.consentId])).n,0,'bytes erased');
  assert.equal((await row('SELECT count(*)::int n FROM hon.creative_avatar_photo_consents WHERE id=$1',[mine.consentId])).n,1,'consent kept');
  await deny(studio.readPhotoImage(H('staffA1'),S.A1,mine.consentId),404,'SAAS_UNAVAILABLE');
  assert.ok(!(await studio.listAvatars(H('ownerA'),S.A1)).avatars.some(a=>a.avatarId===jordan.avatarId));
  await deny(studio.readAvatar(H('ownerA'),S.A1,jordan.avatarId),404,'SAAS_UNAVAILABLE');
  assert.ok(!(await studio.listAvatarVideos(H('ownerA'),S.A1)).videos.some(v=>v.videoId===jordanVideo.videoId));
  await deny(studio.readAvatarVideo(H('ownerA'),S.A1,jordanVideo.videoId),404,'SAAS_UNAVAILABLE');
  const gens=(await studio.list(H('ownerA'),S.A1)).generations.map(g=>g.generationId);
  assert.ok(!gens.includes(jordan.generation.generationId)&&!gens.includes(jordanVideo.generation.generationId),'their generations are hidden too');
  await deny(studio.read(H('ownerA'),S.A1,jordanVideo.generation.generationId),404,'SAAS_UNAVAILABLE');
  const before=await all(),calls=synthetic.calls.length;
  await deny(film('A1',jordan.avatarId),404,'SAAS_UNAVAILABLE');
  await deny(photoAvatar('staffA1',mine.consentId),422,'CREATIVE_AVATAR_WITHDRAWN');
  assert.deepEqual(await all(),before);assert.equal(synthetic.calls.length,calls);
  const twice=await studio.deletePhoto(H('staffA1'),S.A1,mine.consentId);
  assert.deepEqual([twice.photo.status,twice.photo.withdrawnReason],['WITHDRAWN','DELETED_BY_SUBJECT']);
  assert.ok((await studio.listAvatars(H('ownerA'),S.A1)).avatars.some(a=>a.avatarId===kim.avatarId),'other avatars are untouched');
 });

 await check('PH8','a live school owner sees every consent (never the image) and can delete one for the person; replacing a photo erases the previous one',async()=>{
  const b1=(await upload('staffA1b',{signatureName:'Sam Park'})).photo;
  const list=await studio.listPhotos(H('ownerA'),S.A1);
  assert.equal(list.canManageAll,true);const seen=list.photos.find(p=>p.consentId===b1.consentId);
  assert.deepEqual([seen.mine,seen.status],[false,'ACTIVE']);
  assert.ok(list.photos.some(p=>p.consentId===mine.consentId&&p.status==='WITHDRAWN'));
  await deny(studio.readPhotoImage(H('ownerA'),S.A1,b1.consentId),404,'SAAS_UNAVAILABLE');
  const b2=(await upload('staffA1b',{signatureName:'Sam Park',photo:jpeg('two').toString('base64')})).photo;
  const replaced=(await studio.listPhotos(H('staffA1b'),S.A1)).photos.find(p=>p.consentId===b1.consentId);
  assert.deepEqual([replaced.status,replaced.withdrawnReason],['WITHDRAWN','REPLACED']);
  assert.equal((await row('SELECT count(*)::int n FROM hon.creative_avatar_photos WHERE subject_principal_id=$1',[humans.staffA1b.id])).n,1,'one stored photo per person');
  const del=await studio.deletePhoto(H('ownerA'),S.A1,b2.consentId);
  assert.deepEqual([del.photo.status,del.photo.withdrawnReason,del.photo.mine],['WITHDRAWN','DELETED_BY_OWNER',false]);
  assert.equal((await row('SELECT count(*)::int n FROM hon.creative_avatar_photos WHERE subject_principal_id=$1',[humans.staffA1b.id])).n,0);
 });

 const setStaffRevoked=async(who,revoked)=>{await admin.query('BEGIN');try{await admin.query('ALTER TABLE hon.principal_role_grants DISABLE TRIGGER USER');
  await admin.query('UPDATE hon.principal_role_grants SET effective_until=$2 WHERE principal_id=$1',[humans[who].id,revoked?new Date(Date.now()-60_000):null]);
  await admin.query('ALTER TABLE hon.principal_role_grants ENABLE TRIGGER USER');await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}};
 let fresh,freshAvatar;
 await check('PH9','leaving the school withdraws the likeness: the avatar hides and cannot speak, while the person can still see and delete their photo',async()=>{
  fresh=(await upload('staffA1',{photo:jpeg('three').toString('base64')})).photo;
  freshAvatar=(await photoAvatar('staffA1',fresh.consentId,{name:'Coach Jordan Two'})).avatar;
  assert.ok((await studio.listAvatars(H('ownerA'),S.A1)).avatars.some(a=>a.avatarId===freshAvatar.avatarId));
  await setStaffRevoked('staffA1',true);
  try{
   assert.ok(!(await studio.listAvatars(H('ownerA'),S.A1)).avatars.some(a=>a.avatarId===freshAvatar.avatarId));
   const before=await all(),calls=synthetic.calls.length;
   await deny(film('A1',freshAvatar.avatarId),404,'SAAS_UNAVAILABLE');
   assert.deepEqual(await all(),before);assert.equal(synthetic.calls.length,calls);
   assert.equal((await studio.listPhotos(H('ownerA'),S.A1)).photos.find(p=>p.consentId===fresh.consentId).status,'INACTIVE');
   const own=await studio.listPhotos(H('staffA1'),S.A1);assert.ok(own.photos.some(p=>p.consentId===fresh.consentId));
   await deny(upload('staffA1'),403,'SAAS_FORBIDDEN');
  }finally{await setStaffRevoked('staffA1',false);}
  assert.ok((await studio.listAvatars(H('ownerA'),S.A1)).avatars.some(a=>a.avatarId===freshAvatar.avatarId),'restored staff: the stored, never-deleted likeness is usable again');
 });

 await check('PH10','posture: four deny-all private tables, five runtime entry points, private helpers, erasable-but-unchangeable photos, immutable consent evidence',async()=>{
  for(const t of ['creative_avatar_photo_consents','creative_avatar_photos','creative_avatar_photo_withdrawals','creative_avatar_photo_links']){
   const p=await row(`SELECT c.relrowsecurity rls,c.relforcerowsecurity forced,${['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'].map(x=>`has_table_privilege($1,c.oid,'${x}') "${x}"`).join(',')} FROM pg_class c WHERE c.oid=$2::regclass`,[CHAMPIONS_RUNTIME_ROLE,'hon.'+t]);
   assert.deepEqual(p,{rls:true,forced:true,SELECT:false,INSERT:false,UPDATE:false,DELETE:false,TRUNCATE:false},t);
   await assert.rejects(database['getPool']().query(`SELECT * FROM hon.${t} LIMIT 1`),e=>e.code==='42501',t);
  }
  const fns=(await admin.query(`SELECT p.oid::regprocedure::text s,has_function_privilege($1,p.oid,'EXECUTE') x,
    coalesce((SELECT bool_or(a.grantee=0) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),false) pub
    FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname ~ '(creative_photo|avatar_photo|_withdrawn$)' ORDER BY 1`,[CHAMPIONS_RUNTIME_ROLE])).rows;
  assert.equal(fns.length,16,JSON.stringify(fns));
  assert.deepEqual(fns.filter(f=>f.x).map(f=>f.s).sort(),['hon.create_creative_photo_avatar(text,uuid,jsonb,jsonb,uuid,uuid,uuid)','hon.delete_creative_avatar_photo(text,uuid,uuid)',
   'hon.read_creative_avatar_photo_image(text,uuid,uuid)','hon.read_creative_avatar_photos(text,uuid)','hon.upload_creative_avatar_photo(text,uuid,jsonb,text,uuid)']);
  assert.ok(fns.every(f=>!f.pub),'nothing is executable through PUBLIC');
  await assert.rejects(admin.query("UPDATE hon.creative_avatar_photos SET content_type='image/png' WHERE consent_id=$1",[fresh.consentId]),e=>/IMMUTABLE|55000/.test(e.code+e.message));
  await assert.rejects(admin.query('TRUNCATE hon.creative_avatar_photos'),e=>/IMMUTABLE|55000/.test(e.code+e.message));
  await assert.rejects(admin.query("UPDATE hon.creative_avatar_photo_consents SET signature_name='Changed' WHERE id=$1",[fresh.consentId]),e=>/IMMUTABLE|42501|55000/.test(e.code+e.message));
  await assert.rejects(admin.query('DELETE FROM hon.creative_avatar_photo_consents WHERE id=$1',[mine.consentId]),e=>/IMMUTABLE|42501|55000/.test(e.code+e.message));
  await assert.rejects(admin.query('DELETE FROM hon.creative_avatar_photo_withdrawals WHERE consent_id=$1',[mine.consentId]),e=>/IMMUTABLE|42501|55000/.test(e.code+e.message));
  await assert.rejects(admin.query('DELETE FROM hon.creative_avatar_photo_links WHERE consent_id=$1',[mine.consentId]),e=>/IMMUTABLE|42501|55000/.test(e.code+e.message));
 });

 // ---------- a deletion and an in-flight video for the same likeness are serialized ----------
 async function withPendingDelete(commit){
  const holder=await ownerPool.connect();let pending;
  try{
   await holder.query('BEGIN');
   await holder.query('SELECT hon.delete_creative_avatar_photo($1,$2,$3)',[H('staffA1'),S.A1,fresh.consentId]);
   const hpid=(await holder.query('SELECT pg_backend_pid() p')).rows[0].p;
   pending=film('A1',freshAvatar.avatarId,{seconds:7}).then(v=>({ok:true,v}),e=>({ok:false,e}));
   let waiter=null;
   for(let i=0;i<300&&!waiter;i++){waiter=await row("SELECT l.pid FROM pg_locks l WHERE NOT l.granted AND $1=ANY(pg_blocking_pids(l.pid))",[hpid]);if(!waiter)await new Promise(z=>setTimeout(z,10));}
   assert.ok(waiter,'the video request waits for the deletion');
   await holder.query(commit?'COMMIT':'ROLLBACK');
   return await pending;
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await pending?.catch?.(()=>{});}
 }
 await check('PH11a','control: a deletion that rolls back lets the waiting video complete once',async()=>{
  const calls=synthetic.calls.length,out=await withPendingDelete(false);
  assert.equal(out.ok,true,String(out.e?.stack??out.e));assert.deepEqual([out.v.video.status,synthetic.calls.length],['READY',calls+1]);
 });
 await check('PH11b','a video request that waited for a committed deletion is refused: nothing reserved, no provider call',async()=>{
  const before=await all(),calls=synthetic.calls.length,out=await withPendingDelete(true);
  assert.equal(out.ok,false,'refused');assert.equal(out.e?.getResponse?.()?.code,'SAAS_UNAVAILABLE',String(out.e?.stack??out.e));
  const after=await all();assert.deepEqual([after.videos,after.gens,after.res],[before.videos,before.gens,before.res]);
  assert.equal(synthetic.calls.length,calls);
  assert.equal((await row('SELECT count(*)::int n FROM hon.creative_avatar_photos WHERE consent_id=$1',[fresh.consentId])).n,0);
 });
 await setAccessProgram(false);programTouched=false;
}finally{
 if(programTouched)await setAccessProgram(false).catch(e=>console.error('RESTORE FAILED',e));
 await cleanup().catch(e=>{console.error(e);process.exitCode=1;});
 await Promise.allSettled([admin.end(),ownerPool.end(),database.onModuleDestroy?.()]);
}
const failed=results.filter(r=>r[1]==='FAIL');
console.log(`${failed.length?'FAIL':'PASS'}: A3 Creative Studio photo avatars ${results.length-failed.length}/${results.length} (${results.map(r=>`${r[0]} ${r[1]}`).join(', ')})`);
if(failed.length)process.exitCode=1;
