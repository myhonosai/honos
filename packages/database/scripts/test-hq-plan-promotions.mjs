import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID as K } from 'node:crypto';
import { createRequire } from 'node:module';
import { pricingOffers, scheduleInput, acceptanceInput } from './price-acceptance-fixture.mjs';
import { generationInput } from './subscription-generation-fixture.mjs';

// HQ plan promotions (0308) integrity proof. Fixed disposable local Champions Club fixture only: synthetic organizations,
// the deterministic TEST schedule provider, no network, no charge, no checkout, no message and no deployment. It proves:
// only a current HQ owner writes promotions (marketing/billing operators and school owners are refused); marketing
// operators read; the runtime has seven entry points and no table privilege; commands are idempotent by actor and key;
// only published, on-sale offers can be promoted; content changes only in DRAFT; start needs the exact preview digest;
// schools see a promotion only while it is live, they are in the audience, they are not already on its billing interval
// and the subscription page's offer read lists the offer as ELIGIBLE; non-billing staff and other schools see nothing;
// seen/opened/dismissed are recorded once per person; HQ reach counts equal the recorded rows; pause, stop-sales and end
// hide it; history and events are immutable.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const u of [owner,runtime])assert(u.protocol==='postgresql:'&&u.hostname==='localhost'&&u.port==='5432'&&u.pathname==='/hon_champions_validation'&&u.search===''&&u.hash===''&&u.password);
assert(owner.username==='hon_champions_owner'&&runtime.username==='hon_champions_runtime');
assert(!Object.keys(process.env).some(k=>/^PG[A-Z_]*$|^(?:STRIPE|SQUARE|OPENAI|ANTHROPIC|OPENROUTER|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k)));
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasPriceAcceptanceService}=await import('../../../apps/api/dist/saas-pricing/saas-price-acceptance.service.js');
const {SaasSubscriptionGenerationService}=await import('../../../apps/api/dist/saas-pricing/saas-subscription-generation.service.js');
const {SaasScheduleBillingService}=await import('../../../apps/api/dist/saas-pricing/saas-schedule-billing.service.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {HqPlanPromotionsService}=await import('../../../apps/api/dist/hq-plan-promotions/hq-plan-promotions.service.js');
const apiRequire=createRequire(new URL('../../../apps/api/package.json',import.meta.url));
const c=apiRequire('@hon/contracts');
const {DeterministicScheduleProvider}=apiRequire('./test/fixtures/subscription-schedule-provider.cjs');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),pricing=new SaasPriceAcceptanceService(billing);
const generations=new SaasSubscriptionGenerationService(billing),schedules=new SaasScheduleBillingService(billing,new DeterministicScheduleProvider());
const payments=new SaasPaymentsService(billing,database,{}),promos=new HqPlanPromotionsService(billing);
const client=u=>new pg.Client({connectionString:u.toString(),ssl:false}),admin=client(owner),restricted=client(runtime);
const human=k=>({k,id:K(),user:K(),subject:`ppr-${k}-${K()}`});
const hq=human('owner'),marketer=human('marketer'),reader=human('reader'),billingOp=human('billing');
const hqs=[hq,marketer,reader,billingOp],orgs=[];
const principals=()=>[...hqs.map(h=>h.id),...orgs.flatMap(o=>[o.principal,o.staff])];
const mine=['school_plan_promotion_events','hq_plan_promotion_requests','hq_plan_promotion_versions','hq_plan_promotions'];
const saasTables=['saas_schedule_bindings','saas_subscription_generations','saas_price_acceptances','saas_price_schedules','saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const row=async(q,p)=>(await admin.query(q,p)).rows[0];let groups=0;const passed=s=>console.log('PASS 0308 '+(++groups)+': '+s);
const deny=(work,status,code)=>assert.rejects(Promise.resolve().then(work),e=>{assert.equal(e.getStatus?.(),status,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;});
const sqlDeny=(work,code)=>assert.rejects(work,e=>{assert.equal(e.code,code,e.stack);return true;});
async function cleanup(){
  await admin.query('ROLLBACK');await admin.query('BEGIN');
  try {
    for(const t of [...mine,...saasTables,'saas_outbox','saas_audit','saas_requests']){
      await admin.query('ALTER TABLE hon.'+t+' DISABLE TRIGGER USER');
      if(t==='saas_outbox')await admin.query('DELETE FROM hon.saas_outbox WHERE audit_id IN (SELECT id FROM hon.saas_audit WHERE actor_principal_id=ANY($1::uuid[]))',[principals()]);
      else if(['saas_audit','saas_requests'].includes(t))await admin.query('DELETE FROM hon.'+t+' WHERE actor_principal_id=ANY($1::uuid[])',[principals()]);
      else await admin.query('DELETE FROM hon.'+t);
      await admin.query('ALTER TABLE hon.'+t+' ENABLE TRIGGER USER');
    }
    await admin.query('ALTER TABLE hon.saas_payment_program DISABLE TRIGGER USER');
    await admin.query("UPDATE hon.saas_payment_program SET status='DISABLED',provider=NULL,live_mode=false,test_tax_reference=NULL,authorization_reference=NULL,version=1,changed_by_principal_id=NULL,changed_at=clock_timestamp() WHERE program_id=1");
    await admin.query('ALTER TABLE hon.saas_payment_program ENABLE TRIGGER USER');
    await admin.query('COMMIT');
  } catch(e){await admin.query('ROLLBACK');throw e;}
}
// Synthetic organizations: one school, an owner with billing.hon.purchase and a staff member without it, ACTIVE COMPLETE.
async function makeOrg(label){
  const o={label,id:K(),school:K(),role:K(),staffRole:K(),principal:K(),user:K(),subject:'ppr-'+K(),staff:K(),staffUser:K(),staffSubject:'ppr-'+K()};
  await admin.query('BEGIN');
  for(const [id,user,subject] of [[o.principal,o.user,o.subject],[o.staff,o.staffUser,o.staffSubject]]){
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PPR SYNTHETIC')",[user,subject,user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PPR SYNTHETIC',true)",[id,user]);
  }
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PPR SYNTHETIC','PPR SYNTHETIC')",[o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'PPR SYNTHETIC',$3,'UTC')",[o.school,o.id,'ppr-'+o.school]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE','ACTIVE')",[o.id]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','PPR owner',true),($3,$2,'INSTRUCTOR','PPR staff',false)",[o.role,o.id,o.staffRole]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.hon.purchase')",[o.role,o.id]);
  for(const [p,r] of [[o.principal,o.role],[o.staff,o.staffRole]])
    await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')",[o.id,o.school,p,r]);
  await admin.query('COMMIT');orgs.push(o);return o;
}
async function publish(){
  const d=await billing.createOfferSetDraft(hq.subject,{basedOnSetId:null,termsReference:'SYNTHETIC_PPR_TERMS_V1',founderTotalLimit:50,offers:pricingOffers()},K());
  const set=(await billing.publishOfferSet(hq.subject,d.set.setId,{expectedRevision:d.set.revision,previewDigest:d.preview.previewDigest,approval:c.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K())).set;
  const byKind=Object.fromEntries(set.offers.map(o=>[o.offerKind,o])),recorded={};
  for(const kind of ['REGULAR_MONTHLY','REGULAR_ANNUAL'])recorded[kind]=(await pricing.record(hq.subject,scheduleInput(byKind[kind],byKind[kind],0),K())).schedule;
  return {set,offers:byKind,schedules:recorded};
}
async function signUp(o,s){
  const preview=await pricing.preview(o.subject,o.school,s.scheduleId);
  const acceptance=(await pricing.accept(o.subject,o.school,acceptanceInput(preview),K())).acceptance;
  const g=(await generations.record(o.subject,o.school,generationInput(acceptance),K())).generation;
  return (await schedules.start(o.subject,o.school,{generationId:g.generationId,generationDigest:g.generationDigest,confirmation:c.SAAS_SCHEDULE_BINDING_CONFIRMATION},K())).binding;
}
const now=Date.now(),iso=ms=>new Date(ms).toISOString();
const content=(offerId,patch={})=>({headline:'Save with annual billing',body:'Switch to the annual plan and pay for ten months instead of twelve.',buttonLabel:'See annual plan',
  offerId,audience:'ALL_SCHOOLS',schoolIds:[],startsAt:iso(now-60_000),endsAt:iso(now+7*86_400_000),marketingCampaignId:null,...patch});
const shown=async(o,who=o.subject)=>(await promos.school(who,o.school)).promotions.map(p=>p.promotionId);
const start=async p=>{const d=await promos.read(hq.subject,p.promotionId);return (await promos.status(hq.subject,p.promotionId,{expectedVersion:d.promotion.version,status:'ACTIVE',previewDigest:d.preview.digest},K())).promotion;};
const counts=async()=>row(`SELECT (SELECT count(*) FROM hon.hq_plan_promotions)::int p,(SELECT count(*) FROM hon.hq_plan_promotion_versions)::int v,
  (SELECT count(*) FROM hon.hq_plan_promotion_requests)::int r,(SELECT count(*) FROM hon.school_plan_promotion_events)::int e,
  (SELECT count(*) FROM hon.saas_checkout_sessions)::int checkouts,(SELECT count(*) FROM hon.saas_offer_sets)::int sets`);

await Promise.all([admin,restricted].map(x=>x.connect()));
try {
  assert.equal((await row("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).marker,'HON disposable Champions Club validation');
  // ---------- posture ----------
  const entry=['create_hq_plan_promotion(text,jsonb,uuid)','update_hq_plan_promotion(text,uuid,jsonb,uuid)','set_hq_plan_promotion_status(text,uuid,jsonb,uuid)',
    'read_hq_plan_promotions(text,text,timestamptz,uuid,integer)','read_hq_plan_promotion(text,uuid)','read_school_plan_promotions(text,uuid)',
    'record_school_plan_promotion_event(text,uuid,uuid,jsonb)'];
  const internal=['school_plan_promotions_shown(text,uuid,timestamptz)','hq_plan_promotion_content(jsonb)','hq_plan_promotion_claim(uuid,uuid,text,text)',
    'hq_plan_promotion_targets(hon.hq_plan_promotions,uuid,timestamptz)','hq_plan_promotion_school_plan(uuid,timestamptz)','require_hq_plan_promotion_owner(text)',
    'hq_plan_promotion_digest(hon.hq_plan_promotions)','hq_plan_promotion_preview(hon.hq_plan_promotions)','hq_plan_promotion_reach(hon.hq_plan_promotions)'];
  for(const [sig,allowed] of [...entry.map(s=>[s,true]),...internal.map(s=>[s,false])])
    assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
  for(const t of mine){
    for(const priv of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await restricted.query('SELECT has_table_privilege(current_user,$1,$2) a',['hon.'+t,priv])).rows[0].a,false,t+' '+priv);
    assert.deepEqual(await row("SELECT relrowsecurity r,relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass",['hon.'+t]),{r:true,f:true},t);
  }
  for(const t of [...mine,...saasTables])assert.equal((await row('SELECT count(*)::int n FROM hon.'+t)).n,0,'dedicated empty fixture required: '+t);
  passed('runtime holds exactly seven entry points, no helper and no table privilege; forced RLS on all four tables');

  // ---------- fixture ----------
  await admin.query('BEGIN');
  for(const [h,role,perms] of [[hq,'HON_HQ_OWNER',[]],[marketer,'HON_HQ_OPERATOR',['hq.marketing.manage']],[reader,'HON_HQ_OPERATOR',['hq.marketing.read']],[billingOp,'HON_HQ_OPERATOR',['hq.billing.manage']]]){
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PPR SYNTHETIC')",[h.user,h.subject,h.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PPR SYNTHETIC',true)",[h.id,h.user]);
    await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[h.id,role,perms]);
  }
  await admin.query('COMMIT');
  await payments.setPaymentProgram(hq.subject,{action:'ENABLE_TEST_MODE',expectedVersion:1,provider:'STRIPE_SIMULATED',testTaxReference:'PPR TEST TAX',authorizationReference:'PPR TEST AUTHORIZATION'},K());
  const pub=await publish();
  const A=await makeOrg('A'),B=await makeOrg('B'),C=await makeOrg('C');
  const annual=pub.offers.REGULAR_ANNUAL.offerId,monthly=pub.offers.REGULAR_MONTHLY.offerId;
  assert.deepEqual(await row("SELECT hon.hq_plan_promotion_school_plan($1,clock_timestamp()) p",[A.id]),{p:'NONE'});

  // ---------- HQ authority and input ----------
  for(const who of [marketer,reader,billingOp])await deny(()=>promos.create(who.subject,{code:'ANNUAL-SWITCH',...content(annual)},K()),403,'SAAS_FORBIDDEN');
  await deny(()=>promos.create(A.subject,{code:'ANNUAL-SWITCH',...content(annual)},K()),403,'SAAS_FORBIDDEN');
  await deny(()=>promos.list(billingOp.subject,{}),403,'SAAS_FORBIDDEN');
  for(const bad of [content(annual,{audience:'SELECTED_SCHOOLS'}),content(annual,{schoolIds:[A.school]}),content(annual,{endsAt:iso(now+91*86_400_000)}),
    content(annual,{endsAt:iso(now-120_000)}),content(annual,{headline:' padded'}),{...content(annual),extra:1}])
    await deny(()=>promos.create(hq.subject,{code:'BAD-ONE',...bad},K()),400,'INVALID_SAAS_INPUT');
  await deny(()=>promos.create(hq.subject,{code:'BAD-ONE',...content(K())},K()),422,'HQ_PLAN_PROMOTION_OFFER_NOT_ON_SALE');
  await deny(()=>promos.create(hq.subject,{code:'BAD-ONE',...content(annual,{audience:'SELECTED_SCHOOLS',schoolIds:[K()]})},K()),400,'INVALID_SAAS_INPUT');
  assert.equal((await counts()).p,0);
  const key=K(),created=await promos.create(hq.subject,{code:'ANNUAL-SWITCH',...content(annual)},key);
  assert.equal(created.replayed,false);assert.equal(created.promotion.status,'DRAFT');assert.equal(created.promotion.live,false);
  assert.equal(created.promotion.offer.offerKind,'REGULAR_ANNUAL');assert.equal(created.promotion.offer.priceMinor,209700);
  const replay=await promos.create(hq.subject,{code:'ANNUAL-SWITCH',...content(annual)},key);
  assert.equal(replay.replayed,true);assert.equal(replay.promotion.promotionId,created.promotion.promotionId);
  await deny(()=>promos.create(hq.subject,{code:'OTHER-CODE',...content(annual)},key),409,'IDEMPOTENCY_KEY_REUSED');
  await deny(()=>promos.create(hq.subject,{code:'ANNUAL-SWITCH',...content(annual)},K()),422,'HQ_PLAN_PROMOTION_CODE_TAKEN');
  const P1=created.promotion;
  const listR=await promos.list(reader.subject,{});
  assert.equal(listR.viewer.canManage,false);assert.equal(listR.messaging,'IN_APP_ONLY');assert.deepEqual(listR.promotions.map(p=>p.promotionId),[P1.promotionId]);
  assert.deepEqual(listR.offers.map(o=>o.offerKind).sort(),['FOUNDER_ANNUAL','FOUNDER_MONTHLY','REGULAR_ANNUAL','REGULAR_MONTHLY']);
  assert.equal((await promos.list(marketer.subject,{status:'DRAFT'})).viewer.canManage,false);
  assert.equal((await promos.list(hq.subject,{})).viewer.canManage,true);
  await deny(()=>promos.update(marketer.subject,P1.promotionId,{expectedVersion:1,...content(annual)},K()),403,'SAAS_FORBIDDEN');
  await deny(()=>promos.update(hq.subject,P1.promotionId,{expectedVersion:1,...content(annual)},K()),422,'HQ_PLAN_PROMOTION_NO_CHANGE');
  await deny(()=>promos.update(hq.subject,P1.promotionId,{expectedVersion:9,...content(annual,{headline:'Annual saves money'})},K()),409,'SAAS_VERSION_CONFLICT');
  const upd=await promos.update(hq.subject,P1.promotionId,{expectedVersion:1,...content(annual,{headline:'Annual saves money'})},K());
  assert.equal(upd.promotion.version,2);assert.equal(upd.promotion.headline,'Annual saves money');
  passed('only a current HQ owner writes; marketing operators read (canManage false), billing operators and school owners are refused; closed, bounded input; only an on-sale published offer; idempotent replay, key reuse and code reuse refused; draft edits need the current version and a change');

  // ---------- preview and start ----------
  for(const o of [A,B,C])assert.deepEqual(await shown(o),[],'a draft is never shown');
  const d1=await promos.read(hq.subject,P1.promotionId);
  assert.equal(d1.preview.audienceSchools>=3,true);assert.equal(d1.preview.offerOnSale,true);
  assert.equal(d1.versions.length,2);assert.deepEqual(d1.reach,{seenSchools:0,openedSchools:0,dismissedSchools:0,purchaseStartedSchools:0,countsAre:'RECORDED_EVENTS_NOT_ESTIMATES'});
  await deny(()=>promos.status(hq.subject,P1.promotionId,{expectedVersion:2,status:'ACTIVE',previewDigest:'0'.repeat(64)},K()),409,'HQ_PLAN_PROMOTION_PREVIEW_STALE');
  await deny(()=>promos.status(hq.subject,P1.promotionId,{expectedVersion:2,status:'ACTIVE',previewDigest:null},K()),400,'INVALID_SAAS_INPUT');
  await deny(()=>promos.status(marketer.subject,P1.promotionId,{expectedVersion:2,status:'ACTIVE',previewDigest:d1.preview.digest},K()),403,'SAAS_FORBIDDEN');
  const live=await start(P1);
  assert.equal(live.status,'ACTIVE');assert.equal(live.live,true);assert.equal(live.approvedDigest,d1.preview.digest);
  await deny(()=>promos.update(hq.subject,P1.promotionId,{expectedVersion:3,...content(annual,{headline:'Changed after start'})},K()),422,'HQ_PLAN_PROMOTION_NOT_DRAFT');
  passed('start needs the exact current preview digest from an HQ owner; a started promotion cannot be edited');

  // ---------- school visibility ----------
  for(const o of [A,B,C])assert.deepEqual(await shown(o),[P1.promotionId]);
  const view=(await promos.school(A.subject,A.school)).promotions[0];
  assert.deepEqual(Object.keys(view).sort(),['body','buttonLabel','dismissed','endsAt','headline','offer','promotionId']);
  assert.deepEqual(Object.keys(view.offer).sort(),['billingInterval','currency','displayName','offerCode','offerId','offerKind','priceMinor']);
  assert.equal(view.dismissed,false);
  await deny(()=>promos.school(A.staffSubject,A.school),403,'SAAS_FORBIDDEN');
  await deny(()=>promos.school(A.subject,B.school),403,'SAAS_FORBIDDEN');
  await deny(()=>promos.school(hq.subject,A.school),403,'SAAS_FORBIDDEN');
  await deny(()=>promos.schoolEvent(A.staffSubject,A.school,P1.promotionId,{kind:'SEEN'}),403,'SAAS_FORBIDDEN');
  await deny(()=>promos.schoolEvent(A.subject,B.school,P1.promotionId,{kind:'SEEN'}),403,'SAAS_FORBIDDEN');
  await deny(()=>promos.schoolEvent(A.subject,A.school,K(),{kind:'SEEN'}),404,'SAAS_UNAVAILABLE');
  await deny(()=>promos.schoolEvent(A.subject,A.school,P1.promotionId,{kind:'CLICKED'}),400,'INVALID_SAAS_INPUT');
  passed('a live promotion is shown to billing staff of every audience school; only display fields and the offer summary; non-billing staff, other schools and HQ get nothing');

  // ---------- events and reach ----------
  assert.deepEqual(await promos.schoolEvent(A.subject,A.school,P1.promotionId,{kind:'SEEN'}),{promotionId:P1.promotionId,kind:'SEEN',recorded:true});
  assert.deepEqual(await promos.schoolEvent(A.subject,A.school,P1.promotionId,{kind:'SEEN'}),{promotionId:P1.promotionId,kind:'SEEN',recorded:false});
  await promos.schoolEvent(A.subject,A.school,P1.promotionId,{kind:'OPENED'});
  await promos.schoolEvent(B.subject,B.school,P1.promotionId,{kind:'SEEN'});
  await promos.schoolEvent(B.subject,B.school,P1.promotionId,{kind:'DISMISSED'});
  assert.equal((await promos.school(B.subject,B.school)).promotions[0].dismissed,true);
  assert.equal((await promos.school(A.subject,A.school)).promotions[0].dismissed,false);
  // A starts an annual sign-up after seeing it: counted, and A (now on annual billing) no longer sees an annual promotion.
  const bA=await signUp(A,pub.schedules.REGULAR_ANNUAL);
  assert.equal(bA.requirements.billingInterval,'ANNUAL');
  assert.deepEqual(await row("SELECT hon.hq_plan_promotion_school_plan($1,clock_timestamp()) p",[A.id]),{p:'ANNUAL'});
  assert.deepEqual(await shown(A),[]);
  assert.deepEqual((await promos.read(reader.subject,P1.promotionId)).reach,{seenSchools:2,openedSchools:1,dismissedSchools:1,purchaseStartedSchools:1,countsAre:'RECORDED_EVENTS_NOT_ESTIMATES'});
  assert.deepEqual((await promos.list(reader.subject,{})).promotions[0].reach.seenSchools,2);
  passed('seen/opened/dismissed are recorded once per person; dismissal is per person; reach equals recorded rows; a later sign-up for the promoted offer is counted and the school stops seeing it once on that interval');

  // ---------- audiences ----------
  const bB=await signUp(B,pub.schedules.REGULAR_MONTHLY);
  assert.equal(bB.requirements.billingInterval,'MONTHLY');
  const P2=(await promos.create(hq.subject,{code:'MONTHLY-TO-ANNUAL',...content(annual,{audience:'MONTHLY_PLAN'})},K())).promotion;
  const P3=(await promos.create(hq.subject,{code:'PICKED-SCHOOLS',...content(annual,{audience:'SELECTED_SCHOOLS',schoolIds:[C.school]})},K())).promotion;
  const P4=(await promos.create(hq.subject,{code:'MONTHLY-OFFER',...content(monthly,{audience:'NO_PLAN'})},K())).promotion;
  for(const p of [P2,P3,P4])await start(p);
  const ofB=await shown(B),ofC=await shown(C);
  assert(ofB.includes(P1.promotionId)&&ofB.includes(P2.promotionId)&&!ofB.includes(P3.promotionId)&&!ofB.includes(P4.promotionId),'B: monthly plan');
  assert(ofC.includes(P1.promotionId)&&ofC.includes(P3.promotionId)&&ofC.includes(P4.promotionId)&&!ofC.includes(P2.promotionId),'C: no plan');
  assert.deepEqual(await shown(A),[]);
  passed('audiences: monthly-plan schools only, picked schools only, no-plan schools only; a school on the promoted interval never sees it');

  // ---------- pause, stop sales, end ----------
  let p3=(await promos.read(hq.subject,P3.promotionId)).promotion;
  p3=(await promos.status(hq.subject,P3.promotionId,{expectedVersion:p3.version,status:'PAUSED',previewDigest:null},K())).promotion;
  assert.equal((await shown(C)).includes(P3.promotionId),false);
  await deny(()=>promos.schoolEvent(C.subject,C.school,P3.promotionId,{kind:'SEEN'}),404,'SAAS_UNAVAILABLE');
  p3=(await promos.status(hq.subject,P3.promotionId,{expectedVersion:p3.version,status:'ACTIVE',previewDigest:null},K())).promotion;
  assert.equal((await shown(C)).includes(P3.promotionId),true);
  p3=(await promos.status(hq.subject,P3.promotionId,{expectedVersion:p3.version,status:'ENDED',previewDigest:null},K())).promotion;
  assert.equal((await shown(C)).includes(P3.promotionId),false);
  await deny(()=>promos.status(hq.subject,P3.promotionId,{expectedVersion:p3.version,status:'ACTIVE',previewDigest:null},K()),422,'HQ_PLAN_PROMOTION_ENDED');
  await billing.stopOfferSales(hq.subject,monthly,{reasonCode:'OWNER_DISABLED'},K());
  assert.equal((await shown(C)).includes(P4.promotionId),false,'a stopped offer is never promoted');
  assert.equal((await promos.read(hq.subject,P4.promotionId)).promotion.live,false);
  await deny(()=>promos.create(hq.subject,{code:'STOPPED-OFFER',...content(monthly)},K()),422,'HQ_PLAN_PROMOTION_OFFER_NOT_ON_SALE');
  const p4=(await promos.read(hq.subject,P4.promotionId)).promotion;
  const paused4=(await promos.status(hq.subject,P4.promotionId,{expectedVersion:p4.version,status:'PAUSED',previewDigest:null},K())).promotion;
  await deny(()=>promos.status(hq.subject,P4.promotionId,{expectedVersion:paused4.version,status:'ACTIVE',previewDigest:null},K()),422,'HQ_PLAN_PROMOTION_OFFER_NOT_ON_SALE');
  passed('pause hides and resume shows without a new digest; ENDED is final; stopping sales of the offer hides the promotion, refuses new ones and refuses resuming');

  // ---------- immutability and no side effects ----------
  for(const q of ['UPDATE hon.hq_plan_promotion_versions SET kind=kind','DELETE FROM hon.hq_plan_promotion_versions','UPDATE hon.school_plan_promotion_events SET kind=kind',
    'DELETE FROM hon.school_plan_promotion_events','DELETE FROM hon.hq_plan_promotions','TRUNCATE hon.hq_plan_promotion_requests CASCADE',
    `UPDATE hon.hq_plan_promotions SET headline='Rewritten', version=version+1 WHERE id='${P1.promotionId}'`,
    `UPDATE hon.hq_plan_promotions SET approved_digest=repeat('a',64), version=version+1 WHERE id='${P1.promotionId}'`]){
    await admin.query('BEGIN');await sqlDeny(admin.query(q),'42501');await admin.query('ROLLBACK');}
  for(const q of ['SELECT * FROM hon.hq_plan_promotions','INSERT INTO hon.school_plan_promotion_events SELECT * FROM hon.school_plan_promotion_events LIMIT 1'])
    await sqlDeny(restricted.query(q),'42501');
  const end=await counts();
  assert.equal(end.checkouts,0,'no checkout created');assert.equal(end.sets,1,'no offer set created or changed by a promotion');
  assert.equal(end.e,4);
  passed('history, requests and school events never change (even for the owner role); content and approved digest of a started promotion are fixed; runtime has no table path; no checkout or offer change');
  console.log(`PASS: HQ plan promotions (0308) ${groups} scenario groups; deterministic TEST provider only; no checkout, charge, message, provider call or deployment.`);
} finally {
  await Promise.allSettled([admin.query('ROLLBACK'),restricted.query('ROLLBACK')]);
  try { await cleanup(); }
  finally { await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy?.()]); }
}
