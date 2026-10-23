import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// HON OS commercial offers (0181) integrity proof through the real API service on a disposable database:
// one HON OS product, six HQ-priced offer kinds, owner-only versioned drafts, digest-approved publication,
// immutable published offers, stop-sales, school discovery with server-evaluated eligibility, and no effect on the
// legacy Core/Complete catalog, subscriptions, founder inventory, entitlements, payments or paid access.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const contracts=await import('@hon/contracts');
const api=new SaasBillingService(new RuntimeDatabaseService());
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const offerTables=['saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code='42501')=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
// O1 legacy Core (has a legacy subscription), O2 new school with no subscription, O3 another organization.
const O=Object.fromEntries([1,2,3].map(n=>[n,{id:randomUUID(),school:randomUUID(),role:randomUUID(),tier:n===1?'CORE':'COMPLETE'}]));
const humans=Object.fromEntries(['owner','operator','support','purchaser1','purchaser2','clerk2','purchaser3'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`offers-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
let commands=0;const ok=async p=>{const r=await p;if(!r.replayed)commands++;return r;};

// Every price below is fixture data chosen by "HQ" in this proof, not a constant in the product.
const offer=(code,kind,priceMinor,patch={})=>{const interval=contracts.saasHonOsOfferBillingInterval(kind);return{offerCode:code,offerKind:kind,
 displayName:`HON OS ${code.toLowerCase().replaceAll('_',' ')}`,priceMinor,salesOpensAt:iso(NOW-HOUR),salesClosesAt:null,eligibility:'ANY_ACTIVE_ORGANIZATION',
 saleLimit:interval==='ONE_TIME'?25:null,priceLock:interval==='ONE_TIME'?'NONE':'WHILE_CONTINUOUSLY_SUBSCRIBED',priceLockMonths:null,
 annualRenewal:interval==='ANNUAL'?'AUTO_RENEW_AT_LOCKED_PRICE':null,plannedMonthlyPremiumCredits:12000,
 aiFairUseReference:interval==='ONE_TIME'?'Fixture lifetime AI fair-use policy v1':null,refundWindowDays:30,
 cancellationTiming:interval==='ONE_TIME'?null:'END_OF_PAID_PERIOD',...patch};};
const six=(prices={})=>{const p={REGULAR_MONTHLY:31700,REGULAR_ANNUAL:317000,FOUNDER_MONTHLY:18300,FOUNDER_ANNUAL:183000,LIFETIME:950000,FOUNDER_LIFETIME:640000,...prices};return[
 offer('OS_MONTHLY','REGULAR_MONTHLY',p.REGULAR_MONTHLY),offer('OS_ANNUAL','REGULAR_ANNUAL',p.REGULAR_ANNUAL),
 offer('OS_FOUNDER_MONTHLY','FOUNDER_MONTHLY',p.FOUNDER_MONTHLY,{eligibility:'NEW_ORGANIZATIONS_ONLY'}),offer('OS_FOUNDER_ANNUAL','FOUNDER_ANNUAL',p.FOUNDER_ANNUAL,{annualRenewal:'NO_AUTO_RENEWAL',priceLock:'FIXED_MONTHS',priceLockMonths:24}),
 offer('OS_LIFETIME','LIFETIME',p.LIFETIME,{saleLimit:40}),offer('OS_FOUNDER_LIFETIME','FOUNDER_LIFETIME',p.FOUNDER_LIFETIME,{saleLimit:10,salesOpensAt:iso(NOW+30*DAY)})];};
const draftInput=(patch={})=>({basedOnSetId:null,termsReference:'Fixture HON OS terms v1 (not customer terms)',founderTotalLimit:30,offers:six(),...patch});

async function evidence(entityId){return(await admin.query("SELECT a.action_code,a.entity_type,o.event_type FROM hon.saas_audit a JOIN hon.saas_outbox o ON o.audit_id=a.id WHERE a.entity_id=$1 ORDER BY a.occurred_at,a.id",[entityId])).rows;}
async function untouched(){const out={};for(const t of ['organization_entitlements','saas_catalog_versions','saas_catalog_plans','saas_catalog_offers','saas_founder_reservations','saas_subscriptions','saas_subscription_history',
 'saas_invoices','saas_checkout_sessions','saas_credit_allowances','saas_credit_ledger','saas_refund_requests','saas_access_program','saas_payment_program','billing_accounts','invoices','ai_usage_ledger','champions_reward_entries','audit_events','outbox_events'])
 out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t ORDER BY 1`)).rows.map(r=>r.r);return out;}
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  const tables=[...offerTables,'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions','saas_outbox','saas_audit','saas_requests'];
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of tables)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  const orgIds=Object.values(O).map(o=>o.id),principalIds=Object.values(humans).map(h=>h.id);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgIds]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgIds]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- runtime posture: no table access, private helpers not executable, exactly the entry points granted ----------
 for(const t of offerTables){await sqlDeny(restricted.query(`SELECT * FROM hon.${t}`));await sqlDeny(restricted.query(`DELETE FROM hon.${t}`));}
 for(const sig of ['saas_offer_set_preview(uuid)','saas_offer_set_content_valid(jsonb)','saas_offer_set_write_content(uuid,jsonb)','saas_offer_owner(text)','saas_offer_set_json(uuid)','saas_hon_os_product_json()'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);
 for(const sig of ['read_saas_offer_management_from_hq(text)','read_saas_offer_set_from_hq(text,uuid)','create_saas_offer_set_draft(text,jsonb,uuid,uuid,uuid)','revise_saas_offer_set_draft(text,uuid,jsonb,uuid,uuid,uuid)',
  'discard_saas_offer_set_draft(text,uuid,jsonb,uuid,uuid,uuid)','publish_saas_offer_set(text,uuid,jsonb,uuid,uuid,uuid)','stop_saas_offer_sales(text,uuid,jsonb,uuid,uuid,uuid)','read_saas_hon_os_offers_for_school(text,uuid)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,true,sig);
 for(const t of offerTables){const r=(await admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=('hon.'||$1)::regclass",[t])).rows[0];assert.deepEqual(r,{relrowsecurity:true,relforcerowsecurity:true},t);}
 const prices=(await admin.query("SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (proname LIKE '%saas_offer%' OR proname LIKE '%hon_os%')")).rows.map(r=>r.prosrc).join('\n');
 for(const hardcoded of ['24900','14900','317000','31700'])assert.ok(!prices.includes(hardcoded),`no price ${hardcoded} in 0181 functions`);

 // ---------- fixture ----------
 await cleanup();
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[n,o]of Object.entries(O)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o.id,`Offers Fixture Dojo ${n}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,$2,'ACTIVE',clock_timestamp()-interval '30 days')",[o.id,o.tier]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Fixture School',$1::text,'America/New_York')",[o.school,o.id]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'BILLING_FIXTURE','Fixture purchaser role')",[o.role,o.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.hon.purchase')",[o.role,o.id]);
 }
 const clerkRole=randomUUID();
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'CLERK_FIXTURE','Fixture clerk role')",[clerkRole,O[2].id]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.hon.view')",[clerkRole,O[2].id]);
 for(const[who,n,role]of [['purchaser1',1],['purchaser2',2],['purchaser3',3],['clerk2',2,clerkRole]])
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[O[n].id,O[n].school,humans[who].id,role??O[n].role]);
 for(const[who,hqRole,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['support','HON_HQ_SUPPORT',['hq.billing.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,hqRole,perms]);
 await admin.query('COMMIT');
 // A published legacy Core/Complete catalog and a legacy Core subscription for O1: history that HON OS offers must never touch.
 const legacyDraft=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);legacyDraft.termsReference='Fixture legacy plan terms v1';
 legacyDraft.founderProgram={...legacyDraft.founderProgram,eligibility:'NO_PRIOR_CATALOG_SUBSCRIPTION',reservationHoldDays:7,opensAt:iso(NOW-HOUR)};
 const legacy=await api.createCatalogDraft(H('owner'),legacyDraft,K());
 const legacyCatalog=(await api.publishCatalog(H('owner'),legacy.catalog.catalogId,K())).catalog;
 const coreRegular=legacyCatalog.offers.find(o=>o.planCode==='CORE'&&o.offerKind==='REGULAR_MONTHLY');
 const legacySub=(await api.recordSubscription(H('owner'),{source:'CATALOG_OFFER',organizationId:O[1].id,offerId:coreRegular.offerId,founderReservationId:null},K())).subscription;
 assert.equal(legacySub.planCode,'CORE');assert.equal(legacySub.priceMinor,coreRegular.priceMinor);
 const before=await untouched();

 // ---------- 1. initial state and read authority ----------
 const initial=await api.readOfferManagement(H('operator'));
 assert.equal(initial.published,null);assert.deepEqual(initial.drafts,[]);assert.deepEqual(initial.history,[]);assert.deepEqual(initial.onSaleOfferIds,[]);
 assert.deepEqual(initial.product,{...contracts.HON_OS_PRODUCT,capabilities:[...contracts.HON_OS_PRODUCT.capabilities]});
 assert.ok(initial.product.capabilities.includes('ai.workforce'),'HON OS is the full (COMPLETE) capability policy');
 assert.deepEqual(initial.honOsSales,{offers:[],founderPool:{limit:null,allocated:0,held:0,remaining:null}},'no HON OS sales recorded before any purchase');
 assert.deepEqual(initial.legacySales,[{catalogVersion:legacyCatalog.catalogVersion,planCode:'CORE',offerKind:'REGULAR_MONTHLY',priceMinor:coreRegular.priceMinor,status:legacySub.status,subscriptions:1}]);
 assert.equal(initial.paidAccessProgram,'INACTIVE');assert.equal(initial.purchase,'UNAVAILABLE','payment program DISABLED: no checkout');assert.equal(initial.chargesEnabled,false);assert.equal(initial.creditGrantsEnabled,false);
 assert.ok(await api.readOfferManagement(H('owner')));
 for(const who of ['support','purchaser1','clerk2'])await deny(api.readOfferManagement(H(who)),403,'SAAS_FORBIDDEN');
 await deny(api.readOfferManagement('offers-unknown-subject'),403,'SAAS_FORBIDDEN');
 await deny(api.readOfferSet(H('operator'),randomUUID()),404,'SAAS_UNAVAILABLE');
 await deny(api.readOfferSet(H('operator'),'not-a-uuid'),400,'INVALID_SAAS_INPUT');

 // ---------- 2. drafts: owner only, strict input, idempotent ----------
 const input=draftInput();
 for(const who of ['operator','support','purchaser1','clerk2'])await deny(api.createOfferSetDraft(H(who),input,K()),403,'SAAS_FORBIDDEN');
 for(const bad of [{...input,offers:[]},{...input,offers:[...input.offers,input.offers[0]]},{...input,offers:[{...input.offers[0],priceMinor:99}]},
  {...input,offers:[{...input.offers[0],currency:'USD'}]},{...input,offers:[{...input.offers[4],priceLock:'WHILE_CONTINUOUSLY_SUBSCRIBED'}]},
  {...input,offers:[{...input.offers[1],annualRenewal:null}]},{...input,offers:[{...input.offers[0],annualRenewal:'NO_AUTO_RENEWAL'}]},
  {...input,offers:[{...input.offers[0],offerKind:'ESSENTIAL_MONTHLY'}]},{...input,offers:[{...input.offers[0],planCode:'CORE'}]},
  {...input,offers:[{...input.offers[0],salesOpensAt:iso(NOW),salesClosesAt:iso(NOW-1)}]},{...input,chargesEnabled:true},{...input,founderTotalLimit:1001}])
  await deny(api.createOfferSetDraft(H('owner'),bad,K()),400,'INVALID_SAAS_INPUT');
 // The database refuses the same malformed content directly (the API is not the only check).
 const dbInvalid=async p=>sqlDeny(restricted.query('SELECT hon.create_saas_offer_set_draft($1,$2::jsonb,$3,$4,$5)',[H('owner'),JSON.stringify(p),K(),K(),K()]),'22023');
 await dbInvalid({...input,offers:[{...input.offers[0],priceMinor:'31700'}]});
 await dbInvalid({...input,offers:[{...input.offers[4],cancellationTiming:'END_OF_PAID_PERIOD'}]});
 await dbInvalid({...input,offers:[{...input.offers[0],extra:true}]});
 await dbInvalid({...input,founderTotalLimit:-1});
 const key=K();
 const d1=await ok(api.createOfferSetDraft(H('owner'),input,key));
 assert.equal(d1.replayed,false);assert.equal(d1.set.status,'DRAFT');assert.equal(d1.set.revision,1);assert.equal(d1.set.setVersion,1);
 assert.deepEqual(d1.set.offers.map(o=>[o.offerCode,o.offerKind,o.billingInterval,o.founder,o.priceMinor]),[
  ['OS_MONTHLY','REGULAR_MONTHLY','MONTHLY',false,31700],['OS_ANNUAL','REGULAR_ANNUAL','ANNUAL',false,317000],['OS_FOUNDER_MONTHLY','FOUNDER_MONTHLY','MONTHLY',true,18300],
  ['OS_FOUNDER_ANNUAL','FOUNDER_ANNUAL','ANNUAL',true,183000],['OS_LIFETIME','LIFETIME','ONE_TIME',false,950000],['OS_FOUNDER_LIFETIME','FOUNDER_LIFETIME','ONE_TIME',true,640000]]);
 assert.ok(d1.set.offers.every(o=>o.premiumCreditsStatus==='PLANNING_ONLY_NOT_A_CREDIT_GRANT'&&o.salesStop===null&&o.currency==='USD'));
 const replay=await api.createOfferSetDraft(H('owner'),input,key);
 assert.equal(replay.replayed,true);assert.equal(replay.set.setId,d1.set.setId);
 await deny(api.createOfferSetDraft(H('owner'),{...input,founderTotalLimit:31},key),409,'IDEMPOTENCY_KEY_REUSED');
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.saas_offer_sets')).rows[0].n,1);

 // ---------- 3. preview: server-computed quotes and readiness ----------
 const p1=d1.preview;
 assert.equal(p1.ready,true,JSON.stringify(p1.issues));assert.equal(p1.effect,'NEW_PURCHASES_ONLY');assert.equal(p1.existingSubscriptionsRepriced,false);assert.equal(p1.comparisonOfferCode,'OS_MONTHLY');
 const q=Object.fromEntries(p1.quotes.map(x=>[x.offerCode,x]));
 assert.equal(q.OS_MONTHLY.monthlyEquivalentMinor,31700);
 assert.equal(q.OS_ANNUAL.monthlyEquivalentMinor,Math.round(317000/12));assert.equal(q.OS_ANNUAL.annualSavingsVsRegularMonthlyMinor,12*31700-317000);
 assert.equal(q.OS_LIFETIME.monthlyEquivalentMinor,null);assert.equal(q.OS_LIFETIME.lifetimeBreakEvenMonths,Math.ceil(950000/31700));
 assert.equal(q.OS_FOUNDER_MONTHLY.founderDiscountPercentVsRegular,Math.round(100*(31700-18300)/31700));
 assert.equal(q.OS_FOUNDER_ANNUAL.founderDiscountPercentVsRegular,Math.round(100*(317000-183000)/317000));
 assert.equal(q.OS_FOUNDER_LIFETIME.founderDiscountPercentVsRegular,Math.round(100*(950000-640000)/950000));
 assert.equal(q.OS_MONTHLY.founderDiscountPercentVsRegular,null);
 const detail=await api.readOfferSet(H('operator'),d1.set.setId);
 assert.equal(detail.preview.previewDigest,p1.previewDigest,'the preview digest is deterministic');

 // ---------- 4. revise: optimistic revision, not-ready content, digest changes ----------
 const notReady={expectedRevision:1,termsReference:null,founderTotalLimit:null,
  offers:[offer('OS_MONTHLY','REGULAR_MONTHLY',29900,{refundWindowDays:null,cancellationTiming:null}),offer('OS_LIFETIME','LIFETIME',800000,{saleLimit:null,aiFairUseReference:null}),offer('OS_FOUNDER_MONTHLY','FOUNDER_MONTHLY',19900)]};
 await deny(api.reviseOfferSetDraft(H('operator'),d1.set.setId,notReady,K()),403,'SAAS_FORBIDDEN');
 await deny(api.reviseOfferSetDraft(H('owner'),d1.set.setId,{...notReady,expectedRevision:2},K()),409,'SAAS_VERSION_CONFLICT');
 await deny(api.reviseOfferSetDraft(H('owner'),randomUUID(),notReady,K()),404,'SAAS_UNAVAILABLE');
 const r2=await ok(api.reviseOfferSetDraft(H('owner'),d1.set.setId,notReady,K()));
 assert.equal(r2.set.revision,2);assert.equal(r2.preview.ready,false);assert.notEqual(r2.preview.previewDigest,p1.previewDigest);
 assert.deepEqual(r2.preview.issues.map(i=>[i.code,i.offerCode]),[['TERMS_REFERENCE_REQUIRED',null],['FOUNDER_LIMIT_REQUIRED',null],
  ['CANCELLATION_TIMING_REQUIRED','OS_MONTHLY'],['REFUND_WINDOW_REQUIRED','OS_MONTHLY'],['LIFETIME_FAIR_USE_REQUIRED','OS_LIFETIME'],['LIFETIME_SALE_LIMIT_REQUIRED','OS_LIFETIME']]);
 await deny(api.publishOfferSet(H('owner'),d1.set.setId,{expectedRevision:2,previewDigest:r2.preview.previewDigest,approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K()),422,'SAAS_OFFER_SET_NOT_READY');
 const r3=await ok(api.reviseOfferSetDraft(H('owner'),d1.set.setId,{expectedRevision:2,termsReference:input.termsReference,founderTotalLimit:30,offers:six()},K()));
 assert.equal(r3.set.revision,3);assert.equal(r3.preview.ready,true);
 assert.notEqual(r3.preview.previewDigest,p1.previewDigest,'same content at a new revision needs a fresh approval');
 // offer rows are rewritten only while the set is a draft; offer IDs of a draft may change between revisions
 assert.deepEqual(r3.set.offers.map(o=>o.offerCode),input.offers.map(o=>o.offerCode));

 // ---------- 5. publish: owner only, exact approval of the previewed revision ----------
 const publish=(set,rev,digest,who='owner',k=K())=>api.publishOfferSet(H(who),set,{expectedRevision:rev,previewDigest:digest,approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},k);
 await deny(publish(d1.set.setId,3,r3.preview.previewDigest,'operator'),403,'SAAS_FORBIDDEN');
 await deny(publish(d1.set.setId,3,p1.previewDigest),422,'SAAS_OFFER_PREVIEW_CHANGED');
 await deny(publish(d1.set.setId,3,'0'.repeat(64)),422,'SAAS_OFFER_PREVIEW_CHANGED');
 await deny(publish(d1.set.setId,2,r3.preview.previewDigest),409,'SAAS_VERSION_CONFLICT');
 await deny(api.publishOfferSet(H('owner'),d1.set.setId,{expectedRevision:3,previewDigest:r3.preview.previewDigest,approval:'APPROVE'},K()),400,'INVALID_SAAS_INPUT');
 await deny(api.publishOfferSet(H('owner'),d1.set.setId,{expectedRevision:3,previewDigest:r3.preview.previewDigest,approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL,force:true},K()),400,'INVALID_SAAS_INPUT');
 const pubKey=K();
 const pub1=await ok(publish(d1.set.setId,3,r3.preview.previewDigest,'owner',pubKey));
 assert.equal(pub1.set.status,'PUBLISHED');assert.equal(pub1.retiredSetId,null);assert.equal(pub1.set.approvedPreviewDigest,r3.preview.previewDigest);
 assert.equal((await publish(d1.set.setId,3,r3.preview.previewDigest,'owner',pubKey)).replayed,true);
 await deny(api.reviseOfferSetDraft(H('owner'),d1.set.setId,{expectedRevision:3,termsReference:'x',founderTotalLimit:1,offers:six()},K()),409,'SAAS_OFFER_SET_NOT_DRAFT');
 await deny(api.discardOfferSetDraft(H('owner'),d1.set.setId,{expectedRevision:3},K()),409,'SAAS_OFFER_SET_NOT_DRAFT');
 const set1Offers=Object.fromEntries(pub1.set.offers.map(o=>[o.offerCode,o]));

 // ---------- 6. published offers are immutable at the database ----------
 await sqlDeny(admin.query('UPDATE hon.saas_offer_set_offers SET price_minor=1000 WHERE set_id=$1',[d1.set.setId]));
 await sqlDeny(admin.query('DELETE FROM hon.saas_offer_set_offers WHERE set_id=$1',[d1.set.setId]));
 await sqlDeny(admin.query('INSERT INTO hon.saas_offer_set_offers(set_id,position,offer_code,offer_kind,billing_interval,founder,display_name,price_minor,eligibility,price_lock,refund_window_days) VALUES($1,9,$2,$3,$4,false,$5,1000,$6,$7,0)',
  [d1.set.setId,'OS_SNEAKY','REGULAR_MONTHLY','MONTHLY','Sneaky','ANY_ACTIVE_ORGANIZATION','NONE']));
 await sqlDeny(admin.query("UPDATE hon.saas_offer_sets SET terms_reference='changed' WHERE id=$1",[d1.set.setId]));
 await sqlDeny(admin.query("UPDATE hon.saas_offer_sets SET status='DRAFT' WHERE id=$1",[d1.set.setId]));
 await sqlDeny(admin.query('DELETE FROM hon.saas_offer_sets WHERE id=$1',[d1.set.setId]));
 await sqlDeny(admin.query('TRUNCATE hon.saas_offer_set_offers CASCADE'));
 await sqlDeny(restricted.query("UPDATE hon.saas_offer_set_offers SET price_minor=1000"));
 await sqlDeny(admin.query("UPDATE hon.saas_offer_sets SET charges_enabled=true WHERE id=$1",[d1.set.setId]));

 // ---------- 7. school discovery: exact school, on-sale only, server-evaluated eligibility ----------
 const s2=await api.readSchoolHonOsOffers(H('purchaser2'),O[2].school);
 assert.equal(s2.offerSetVersion,1);assert.equal(s2.purchase,'UNAVAILABLE');assert.equal(s2.paidAccessProgram,'INACTIVE');assert.equal(s2.chargesEnabled,false);
 assert.equal(s2.checkout,null);assert.equal(s2.purchased,null);
 // Purchase binding (0182): founder offers are self-serve inside the HON OS founder pool; eligibility is the server's decision.
 assert.deepEqual(s2.offers.map(o=>[o.offerCode,o.eligibility,o.recurringBilling]),[['OS_MONTHLY','ELIGIBLE','MONTH'],['OS_ANNUAL','ELIGIBLE','YEAR'],
  ['OS_FOUNDER_MONTHLY','ELIGIBLE','MONTH'],['OS_FOUNDER_ANNUAL','ELIGIBLE','NONE'],['OS_LIFETIME','ELIGIBLE','NONE']],'founder lifetime opens in 30 days, so it is not on sale yet');
 for(const o of s2.offers)for(const hidden of ['salesStop','salesOpensAt','position','saleLimit'])assert.ok(!(hidden in o),hidden);
 const s1=await api.readSchoolHonOsOffers(H('purchaser1'),O[1].school);
 assert.deepEqual([...new Set(s1.offers.map(o=>o.eligibility))],['NOT_ELIGIBLE_ENTITLEMENT'],'a CORE organization (with a legacy subscription) cannot buy HON OS (COMPLETE policy) yet');
 await deny(api.readSchoolHonOsOffers(H('purchaser3'),O[2].school),403,'SAAS_FORBIDDEN');
 await deny(api.readSchoolHonOsOffers(H('clerk2'),O[2].school),403,'SAAS_FORBIDDEN');
 for(const who of ['owner','operator'])await deny(api.readSchoolHonOsOffers(H(who),O[2].school),403,'SAAS_FORBIDDEN');
 await deny(api.readSchoolHonOsOffers(H('purchaser2'),'not-a-uuid'),400,'INVALID_SAAS_INPUT');

 // ---------- 8. HON OS offer IDs are not legacy catalog offers: no checkout or subscription path accepts them ----------
 await deny(api.recordSubscription(H('owner'),{source:'CATALOG_OFFER',organizationId:O[2].id,offerId:set1Offers.OS_MONTHLY.offerId,founderReservationId:null},K()),422,'SAAS_OFFER_NOT_AVAILABLE');
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.saas_catalog_offers WHERE id=ANY($1::uuid[])',[pub1.set.offers.map(o=>o.offerId)])).rows[0].n,0);

 // ---------- 9. stop sales: owner only, published only, once, visible everywhere ----------
 await deny(api.stopOfferSales(H('operator'),set1Offers.OS_ANNUAL.offerId,{reasonCode:'OWNER_DISABLED'},K()),403,'SAAS_FORBIDDEN');
 await deny(api.stopOfferSales(H('owner'),set1Offers.OS_ANNUAL.offerId,{reasonCode:'BECAUSE'},K()),400,'INVALID_SAAS_INPUT');
 await deny(api.stopOfferSales(H('owner'),randomUUID(),{reasonCode:'OWNER_DISABLED'},K()),404,'SAAS_UNAVAILABLE');
 const stopKey=K();
 const stop=await ok(api.stopOfferSales(H('owner'),set1Offers.OS_ANNUAL.offerId,{reasonCode:'PRICE_CHANGE_PENDING'},stopKey));
 assert.equal(stop.offer.salesStop.reasonCode,'PRICE_CHANGE_PENDING');assert.equal(stop.offer.priceMinor,317000,'stopping never changes the price');
 assert.equal((await api.stopOfferSales(H('owner'),set1Offers.OS_ANNUAL.offerId,{reasonCode:'PRICE_CHANGE_PENDING'},stopKey)).replayed,true);
 await deny(api.stopOfferSales(H('owner'),set1Offers.OS_ANNUAL.offerId,{reasonCode:'OWNER_DISABLED'},K()),422,'SAAS_OFFER_SALES_ALREADY_STOPPED');
 await sqlDeny(admin.query('DELETE FROM hon.saas_offer_sales_stops'));
 assert.ok(!(await api.readSchoolHonOsOffers(H('purchaser2'),O[2].school)).offers.some(o=>o.offerCode==='OS_ANNUAL'));
 const afterStop=await api.readOfferManagement(H('operator'));
 assert.ok(!afterStop.onSaleOfferIds.includes(set1Offers.OS_ANNUAL.offerId));assert.ok(afterStop.onSaleOfferIds.includes(set1Offers.OS_MONTHLY.offerId));
 assert.ok(!afterStop.onSaleOfferIds.includes(set1Offers.OS_FOUNDER_LIFETIME.offerId));

 // ---------- 10. a price change is a new version: new offer IDs, old set retired, history kept ----------
 const d2=await ok(api.createOfferSetDraft(H('owner'),draftInput({basedOnSetId:d1.set.setId,offers:six({REGULAR_MONTHLY:33300,REGULAR_ANNUAL:333000})}),K()));
 assert.equal(d2.set.setVersion,2);assert.equal(d2.set.basedOnSetId,d1.set.setId);
 assert.ok(d2.set.offers.every(o=>!pub1.set.offers.some(p=>p.offerId===o.offerId)),'a new version never reuses an offer id');
 const d3=await ok(api.createOfferSetDraft(H('owner'),draftInput({termsReference:'Abandoned idea'}),K()));
 await deny(api.discardOfferSetDraft(H('owner'),d3.set.setId,{expectedRevision:2},K()),409,'SAAS_VERSION_CONFLICT');
 const discarded=await ok(api.discardOfferSetDraft(H('owner'),d3.set.setId,{expectedRevision:1},K()));
 assert.equal(discarded.set.status,'DISCARDED');
 await deny(publish(d3.set.setId,1,d3.preview.previewDigest),409,'SAAS_OFFER_SET_NOT_DRAFT');
 const pub2=await ok(publish(d2.set.setId,1,d2.preview.previewDigest));
 assert.equal(pub2.retiredSetId,d1.set.setId);
 await deny(api.stopOfferSales(H('owner'),set1Offers.OS_MONTHLY.offerId,{reasonCode:'OWNER_DISABLED'},K()),422,'SAAS_OFFER_NOT_PUBLISHED');
 const retired=await api.readOfferSet(H('operator'),d1.set.setId);
 assert.equal(retired.set.status,'RETIRED');assert.deepEqual(retired.set.offers.map(o=>o.priceMinor),pub1.set.offers.map(o=>o.priceMinor),'retired prices are preserved exactly');
 assert.equal(retired.set.offers.find(o=>o.offerCode==='OS_ANNUAL').salesStop.reasonCode,'PRICE_CHANGE_PENDING','a retired set keeps its stop history');
 const mgmt=await api.readOfferManagement(H('owner'));
 assert.equal(mgmt.published.setId,d2.set.setId);assert.deepEqual(mgmt.drafts,[]);
 assert.deepEqual(mgmt.history.map(h=>[h.setVersion,h.status]),[[3,'DISCARDED'],[2,'PUBLISHED'],[1,'RETIRED']]);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_offer_sets WHERE status='PUBLISHED'")).rows[0].n,1);
 const s2b=await api.readSchoolHonOsOffers(H('purchaser2'),O[2].school);
 assert.equal(s2b.offerSetVersion,2);assert.equal(s2b.offers.find(o=>o.offerCode==='OS_MONTHLY').priceMinor,33300);assert.ok(s2b.offers.some(o=>o.offerCode==='OS_ANNUAL'),'the stop applied to the old offer, not the new version');

 // ---------- 11. concurrency: simultaneous publishes leave exactly one published set ----------
 const [c1,c2]=await Promise.all([api.createOfferSetDraft(H('owner'),draftInput(),K()),api.createOfferSetDraft(H('owner'),draftInput(),K())]);
 assert.notEqual(c1.set.setVersion,c2.set.setVersion);
 const raced=await Promise.allSettled([publish(c1.set.setId,1,c1.preview.previewDigest),publish(c2.set.setId,1,c2.preview.previewDigest)]);
 assert.equal(raced.filter(r=>r.status==='fulfilled').length,2,'publishes serialize; each retires the one before');commands+=4;
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_offer_sets WHERE status='PUBLISHED'")).rows[0].n,1);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_offer_sets WHERE status='RETIRED'")).rows[0].n,3);

 // ---------- 12. evidence: one audit + outbox row per command; nothing else changed ----------
 assert.deepEqual(await evidence(d1.set.setId),[['saas.offers.draft','OFFER_SET','saas.offers.drafted'],['saas.offers.revise','OFFER_SET','saas.offers.revised'],
  ['saas.offers.revise','OFFER_SET','saas.offers.revised'],['saas.offers.publish','OFFER_SET','saas.offers.published']].map(([action_code,entity_type,event_type])=>({action_code,entity_type,event_type})));
 assert.deepEqual(await evidence(set1Offers.OS_ANNUAL.offerId),[{action_code:'saas.offers.stop_sales',entity_type:'OFFER',event_type:'saas.offers.sales_stopped'}]);
 assert.deepEqual(await evidence(d3.set.setId),[{action_code:'saas.offers.draft',entity_type:'OFFER_SET',event_type:'saas.offers.drafted'},{action_code:'saas.offers.discard',entity_type:'OFFER_SET',event_type:'saas.offers.discarded'}]);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_audit WHERE action_code LIKE 'saas.offers.%'")).rows[0].n,commands);
 assert.deepEqual(await untouched(),before,'legacy catalog, subscriptions, founder inventory, entitlements, payments, credits and paid access unchanged');
 assert.equal((await api.readOfferManagement(H('owner'))).paidAccessProgram,'INACTIVE');
 console.log(`PASS: HON OS commercial offers (0181) proof — ${commands} owner commands with exact audit/outbox evidence; six HQ-priced offer kinds (monthly, annual, founder monthly/annual, lifetime, founder lifetime) on one HON OS product; operator/support/school identities refused; idempotent replay and key reuse; revision conflicts; server preview quotes and readiness; publish only with the digest of the exact previewed revision; published offers immutable (UPDATE/DELETE/INSERT/TRUNCATE refused); stop-sales once and published only; price change = new version with new offer IDs and the prior set retired intact; concurrent publishes leave one published set; exact-school purchaser discovery with on-sale filtering and server eligibility; HON OS offer IDs refused by the legacy subscription path; legacy catalog, subscriptions, founder records, entitlements and paid access (INACTIVE) unchanged.`);
}finally{await cleanup().catch(e=>console.error('cleanup failed',e));await Promise.all([admin.end(),restricted.end()]);}
