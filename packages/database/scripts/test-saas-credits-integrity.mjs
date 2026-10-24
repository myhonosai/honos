import pg from 'pg';
import { setLegacySales } from './saas-legacy-sales-simulation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// HON Subscription Billing B3 (0156) integrity proof through the real API service on a disposable
// database: owner-gated credit program, verified provider cost evidence, versioned operation pricing,
// one allowance per subscription period, RESERVE/FINALIZE/RELEASE/EXPIRE ledger, retry safety,
// unknown-outcome handling, concurrency-safe balance, 75/90/100 thresholds, plan capability limits,
// suspension, no rollover, provider cost kept apart from credits, and no billing or Champions effect.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const contracts=await import('@hon/contracts');
const api=new SaasBillingService(new RuntimeDatabaseService());
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const saasTables=['saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions','saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions',
 'saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions'];
const b3Tables=['saas_credit_program','saas_provider_cost_evidence','saas_pricing_versions','saas_operation_prices','saas_credit_allowances','saas_credit_reservations','saas_credit_ledger','saas_credit_threshold_events'];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code='42501')=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
// A Core regular (two schools), B Complete founder lifetime, C Core (suspended mid-flight), D Core (suspended before any grant),
// L legacy Core, E legacy Essential.
const O=Object.fromEntries(['A','B','C','D','L','E'].map(k=>[k,{id:randomUUID(),tier:{A:'CORE',B:'COMPLETE',C:'CORE',D:'CORE',L:'CORE',E:'ESSENTIAL'}[k],school:randomUUID(),role:randomUUID()}]));
const schoolA2=randomUUID();
const humans=Object.fromEntries(['owner','operator','support','staffA','staffA2','staffB','staffC','staffL','staffE','plainA'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`credits-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
let commands=0;const ok=async p=>{const r=await p;if(!r.replayed)commands++;return r;};
const createdProviders=[];
async function untouched(){const out={};for(const t of ['organization_entitlements','billing_accounts','memberships','invoices','membership_payment_schedules','champions_reward_entries','champions_attributions','saas_invoices','saas_payment_evidence','audit_events','outbox_events'])out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t ORDER BY 1`)).rows.map(r=>r.r);return out;}
async function rejectedWithoutGuards(table,sql,params=[],code='23514'){
 await admin.query('BEGIN');
 try{await admin.query(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);await sqlDeny(admin.query(sql,params),code);}finally{await admin.query('ROLLBACK');}
}
async function withoutGuards(tables,sqls){
 await admin.query('BEGIN');
 try{for(const t of tables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);for(const[sql,params]of sqls)await admin.query(sql,params);
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);await admin.query('COMMIT');}
 catch(e){await admin.query('ROLLBACK');throw e;}
}
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of [...saasTables,'saas_credit_program'])await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of saasTables)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query("UPDATE hon.saas_credit_program SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of [...saasTables,'saas_credit_program'])await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  const orgIds=Object.values(O).map(o=>o.id),principalIds=Object.values(humans).map(h=>h.id);
  await admin.query('DELETE FROM hon.ai_usage_ledger WHERE organization_id=ANY($1::uuid[])',[orgIds]);
  if(createdProviders.length)await admin.query('DELETE FROM hon.hq_ai_provider_connections WHERE provider_id=ANY($1::text[])',[createdProviders]);
  await admin.query('DELETE FROM hon.organization_entitlements WHERE organization_id=ANY($1::uuid[])',[orgIds]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.principal_role_grants WHERE organization_id=ANY($1::uuid[])',[orgIds]);
  await admin.query('DELETE FROM hon.role_permissions WHERE organization_id=ANY($1::uuid[])',[orgIds]);
  await admin.query('DELETE FROM hon.roles WHERE organization_id=ANY($1::uuid[])',[orgIds]);
  await admin.query('DELETE FROM hon.schools WHERE organization_id=ANY($1::uuid[])',[orgIds]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgIds]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const evidenceInput=(patch={})=>({providerId:'HIGGSFIELD',modelCode:'fixture-image-1',costUnit:'IMAGE',measuredUnits:1000,billedCostMicrounits:40_000_000,
 fullyLoadedCostMicrounits:50_000_000,evidenceReference:'FIXTURE-PROVIDER-INVOICE-1',periodStart:iso(NOW-40*DAY),periodEnd:iso(NOW-10*DAY),note:'Fixture usage export (not real billing)',...patch});
const reserve=(who,school,operationCode,units,key=K(),extra={})=>api.reservePremiumCredits(H(who),school,{operationCode,units,employeeKey:null,actionRequestId:null,workItemId:null,...extra},key);
const settle=(who,r,outcome,patch={})=>api.settlePremiumCredits(H(who),r.reservationId,{outcome,expectedVersion:r.version,finalUnits:null,providerCostMicrounits:null,inputUnits:null,outputUnits:null,...patch},K());
const balance=async(org)=>(await api.readOrganizationCredits(H('operator'),org)).allowances[0].balance;

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- runtime posture ----------
 for(const t of b3Tables)await sqlDeny(restricted.query(`SELECT * FROM hon.${t}`));
 for(const sig of ['saas_current_allowance(uuid,uuid,timestamptz)','saas_record_provider_usage(hon.saas_credit_reservations,uuid,bigint,bigint,bigint)','require_saas_school_actor(text,uuid)','saas_record_thresholds(uuid,timestamptz)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);
 await cleanup();
 // 0184 (D8) closed legacy new sales; this proof exercises them, so it reopens them in this disposable database only.
 await setLegacySales(admin,true);

 // ---------- fixture ----------
 await admin.query('BEGIN');
 for(const p of ['HIGGSFIELD','OPENROUTER']){const r=await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state) VALUES($1,'Fixture provider','DISABLED') ON CONFLICT DO NOTHING RETURNING provider_id",[p]);if(r.rowCount)createdProviders.push(p);}
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[k,o]of Object.entries(O)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o.id,`Credits Fixture Dojo ${k}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,$2,clock_timestamp()-interval '90 days')",[o.id,o.tier]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'America/New_York')",[o.school,o.id,`School ${k}`]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'PREMIUM_STAFF','Fixture premium role')",[o.role,o.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'ai.premium.request')",[o.role,o.id]);
 }
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'School A2',$1::text,'America/New_York')",[schoolA2,O.A.id]);
 const plainRole=randomUUID();
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'FRONT_DESK','Fixture role without premium')",[plainRole,O.A.id]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'champions.participate')",[plainRole,O.A.id]);
 const grant=(who,org,school,role)=>admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[org,school,humans[who].id,role]);
 await grant('staffA',O.A.id,O.A.school,O.A.role);await grant('staffA2',O.A.id,O.A.school,O.A.role);await grant('staffB',O.B.id,O.B.school,O.B.role);
 await grant('staffC',O.C.id,O.C.school,O.C.role);await grant('staffL',O.L.id,O.L.school,O.L.role);await grant('staffE',O.E.id,O.E.school,O.E.role);
 await grant('plainA',O.A.id,O.A.school,plainRole);
 for(const[who,hqRole,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['support','HON_HQ_SUPPORT',['hq.billing.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,hqRole,perms]);
 await admin.query('COMMIT');
 const d=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
 d.termsReference='Fixture HON plan terms v1 (not customer terms)';d.founderProgram={...d.founderProgram,eligibility:'ANY_ACTIVE_ORGANIZATION',opensAt:iso(NOW-HOUR)};
 const cat=(await api.publishCatalog(H('owner'),(await api.createCatalogDraft(H('owner'),d,K())).catalog.catalogId,K())).catalog;
 const offer=(plan,kind)=>cat.offers.find(o=>o.planCode===plan&&o.offerKind===kind).offerId;
 const fres=(await api.reserveFounder(H('owner'),{organizationId:O.B.id,offerId:offer('COMPLETE','FOUNDER_LIFETIME')},K())).reservation;
 const rec=input=>api.recordSubscription(H('owner'),input,K()).then(r=>r.subscription);
 const start=s=>api.commandSubscription(H('owner'),s.subscriptionId,{action:'START_SERVICE',expectedVersion:s.version,reasonCode:'SERVICE_STARTED'},K()).then(r=>r.subscription);
 const subs={};
 subs.A=await start(await rec({source:'CATALOG_OFFER',organizationId:O.A.id,offerId:offer('CORE','REGULAR_MONTHLY'),founderReservationId:null}));
 subs.B=await start(await rec({source:'CATALOG_OFFER',organizationId:O.B.id,offerId:offer('COMPLETE','FOUNDER_LIFETIME'),founderReservationId:fres.reservationId}));
 subs.C=await start(await rec({source:'CATALOG_OFFER',organizationId:O.C.id,offerId:offer('CORE','REGULAR_MONTHLY'),founderReservationId:null}));
 subs.D=await start(await rec({source:'CATALOG_OFFER',organizationId:O.D.id,offerId:offer('CORE','REGULAR_MONTHLY'),founderReservationId:null}));
 subs.L=await start(await rec({source:'LEGACY_ENTITLEMENT',organizationId:O.L.id}));
 subs.E=await start(await rec({source:'LEGACY_ENTITLEMENT',organizationId:O.E.id}));
 subs.D=(await api.commandSubscription(H('owner'),subs.D.subscriptionId,{action:'SUSPEND',expectedVersion:subs.D.version,reasonCode:'OWNER_HOLD'},K())).subscription;
 const before=await untouched();
 const requestBaseline=(await admin.query('SELECT count(*)::int n FROM hon.saas_requests')).rows[0].n;

 // ---------- 1. inactive by default; nothing priced; no default cost ----------
 let program=await api.readCreditProgram(H('operator'));
 assert.deepEqual([program.program.status,program.program.topUps,program.program.overage,program.program.purchases,program.publishedPricing,program.costEvidence.length,program.premiumCreditsFromOrdinaryUse],
  ['INACTIVE','UNAVAILABLE','DISABLED','DISABLED',null,0,false]);
 let school=await api.readSchoolCredits(H('staffA'),O.A.school);
 assert.deepEqual([school.programStatus,school.currentAllowance,school.operations,school.ordinaryUseConsumesCredits,school.topUps],['INACTIVE',null,[],false,'UNAVAILABLE']);
 await deny(api.estimatePremiumOperation(H('staffA'),O.A.school,{operation:'image.generate',units:'1'}),422,'SAAS_OPERATION_NOT_PRICED');
 await deny(reserve('staffA',O.A.school,'image.generate',1),422,'SAAS_CREDITS_NOT_ACTIVE');
 await deny(api.setCreditProgram(H('owner'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'Fixture owner authorization'},K()),422,'SAAS_PRICING_NOT_PUBLISHED');
 await deny(api.setCreditProgram(H('operator'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'x'},K()),403,'SAAS_FORBIDDEN');
 for(const who of ['plainA','staffB','owner','support'])await deny(api.readSchoolCredits(H(who),O.A.school),403,'SAAS_FORBIDDEN');
 await deny(api.readSchoolCredits(H('staffE'),O.E.school),403,'SAAS_FORBIDDEN'); // Essential has no premium allowance

 // ---------- 2. verified provider cost evidence ----------
 await deny(api.recordCostEvidence(H('operator'),evidenceInput(),K()),403,'SAAS_FORBIDDEN');
 await deny(api.recordCostEvidence(H('owner'),evidenceInput({fullyLoadedCostMicrounits:1}),K()),400,'INVALID_SAAS_INPUT');
 await sqlDeny(restricted.query('SELECT hon.record_saas_provider_cost_evidence($1,$2::jsonb,$3,$4,$5)',[H('owner'),JSON.stringify(evidenceInput({fullyLoadedCostMicrounits:1})),K(),K(),K()]),'23514');
 await deny(api.recordCostEvidence(H('owner'),evidenceInput({periodEnd:iso(NOW+DAY)}),K()),422,'SAAS_COST_PERIOD_INVALID');
 await deny(api.recordCostEvidence(H('owner'),evidenceInput({providerId:'HEYGEN'}),K()),422,'SAAS_PROVIDER_UNKNOWN');
 const evImage=(await ok(api.recordCostEvidence(H('owner'),evidenceInput(),K()))).costEvidence;
 assert.deepEqual([evImage.fullyLoadedCostMicrounitsPerUnit,evImage.source],[50000,'HQ_OWNER_VERIFIED_PROVIDER_BILLING']);
 await deny(api.recordCostEvidence(H('owner'),evidenceInput(),K()),422,'SAAS_EVIDENCE_DUPLICATE_REFERENCE');
 const evTask=(await ok(api.recordCostEvidence(H('owner'),evidenceInput({providerId:'OPENROUTER',modelCode:'fixture-agent-model',costUnit:'TASK',measuredUnits:200,
  billedCostMicrounits:30_000_000,fullyLoadedCostMicrounits:36_000_000,evidenceReference:'FIXTURE-OR-USAGE-1'}),K()))).costEvidence;
 const evResearch=(await ok(api.recordCostEvidence(H('owner'),evidenceInput({providerId:'OPENROUTER',modelCode:'fixture-research-model',costUnit:'TOKEN_1K',measuredUnits:100000,
  billedCostMicrounits:900_000,fullyLoadedCostMicrounits:1_000_000,evidenceReference:'FIXTURE-OR-USAGE-2'}),K()))).costEvidence;

 // ---------- 3. versioned pricing linked to verified cost ----------
 const ops=[{operationCode:'image.generate',category:'IMAGE_GENERATION',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,requiredCapability:'ai.premium_metered',costEvidenceId:evImage.costEvidenceId},
  {operationCode:'employee.task',category:'AI_EMPLOYEE_TASK',displayName:'AI employee task',billingUnit:'TASK',creditsPerUnit:400,maxUnitsPerRequest:5,requiredCapability:'ai.workforce',costEvidenceId:evTask.costEvidenceId},
  {operationCode:'research.deep',category:'DEEP_RESEARCH',displayName:'Deep research',billingUnit:'TOKEN_1K',creditsPerUnit:2,maxUnitsPerRequest:2000,requiredCapability:'ai.premium_metered',costEvidenceId:evResearch.costEvidenceId}];
 await deny(api.createPricingDraft(H('operator'),{termsReference:'T',operations:[{...ops[0],costEvidenceId:evTask.costEvidenceId}]},K()),422,'SAAS_PRICING_COST_EVIDENCE_MISMATCH');
 await deny(api.createPricingDraft(H('operator'),{termsReference:'T',operations:[{...ops[1],requiredCapability:'ai.premium_metered'}]},K()),400,'INVALID_SAAS_INPUT');
 await deny(api.createPricingDraft(H('support'),{termsReference:'T',operations:ops},K()),403,'SAAS_FORBIDDEN');
 const undecided=(await ok(api.createPricingDraft(H('operator'),{termsReference:null,operations:ops},K()))).pricing;
 await deny(api.publishPricing(H('owner'),undecided.pricingId,K()),422,'SAAS_PRICING_UNDECIDED');
 const draft=(await ok(api.createPricingDraft(H('operator'),{termsReference:'Fixture premium pricing v1 (not customer terms)',operations:ops},K()))).pricing;
 await deny(api.publishPricing(H('operator'),draft.pricingId,K()),403,'SAAS_FORBIDDEN');
 const pricing=(await ok(api.publishPricing(H('owner'),draft.pricingId,K()))).pricing;
 const img=pricing.operations.find(o=>o.operationCode==='image.generate');
 assert.deepEqual([img.creditsPerUnit,img.fullyLoadedCostMicrounitsPerUnit,img.fullyLoadedCostMicrounitsPerCredit,img.providerId],[10,50000,5000,'HIGGSFIELD']);

 // ---------- 4. owner activation ----------
 const act=(await ok(api.setCreditProgram(H('owner'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'Fixture owner authorization (disposable)'},K()))).program;
 assert.deepEqual([act.status,act.version,act.topUps],['ACTIVE',2,'UNAVAILABLE']);
 await deny(api.setCreditProgram(H('owner'),{action:'ACTIVATE',expectedVersion:2,authorizationReference:'again'},K()),409,'SAAS_TRANSITION_NOT_ALLOWED');

 // ---------- 5. plan capabilities and estimates ----------
 school=await api.readSchoolCredits(H('staffA'),O.A.school);
 assert.deepEqual(school.operations.map(o=>o.operationCode),['image.generate','research.deep']); // Core: no AI workforce
 assert.ok(!('providerId' in school.operations[0])&&!('fullyLoadedCostMicrounitsPerUnit' in school.operations[0]));
 assert.deepEqual((await api.readSchoolCredits(H('staffB'),O.B.school)).operations.map(o=>o.operationCode),['employee.task','image.generate','research.deep']);
 let est=await api.estimatePremiumOperation(H('staffA'),O.A.school,{operation:'image.generate',units:'5'});
 assert.deepEqual([est.estimatedCredits,est.allowed,est.refusal,est.estimateOnly],[50,true,null,true]);
 assert.equal((await api.estimatePremiumOperation(H('staffA'),O.A.school,{operation:'employee.task',units:'1'})).refusal,'SAAS_OPERATION_NOT_IN_PLAN');
 assert.equal((await api.estimatePremiumOperation(H('staffA'),O.A.school,{operation:'image.generate',units:'9'})).refusal,'SAAS_OPERATION_UNITS_EXCEEDED');
 await deny(api.estimatePremiumOperation(H('staffA'),O.A.school,{operation:'image.generate'}),400,'INVALID_SAAS_INPUT');

 // ---------- 6. reserve: allowance per period, idempotent retry, refusals ----------
 await deny(reserve('staffA',O.A.school,'employee.task',1),422,'SAAS_OPERATION_NOT_IN_PLAN');
 await deny(reserve('staffA',O.A.school,'image.generate',9),422,'SAAS_OPERATION_UNITS_EXCEEDED');
 for(const who of ['plainA','staffB','owner'])await deny(reserve(who,O.A.school,'image.generate',1),403,'SAAS_FORBIDDEN');
 await deny(reserve('staffA',schoolA2,'image.generate',1),403,'SAAS_FORBIDDEN'); // granted at school A only
 const kR=K();
 const r1=await ok(reserve('staffA',O.A.school,'image.generate',5,kR));
 assert.deepEqual([r1.reservation.status,r1.reservation.reservedCredits,r1.allowance.balance.allowanceCredits,r1.allowance.balance.availableCredits,r1.allowance.allowanceBasis,r1.allowance.planCode],
  ['RESERVED',50,5000,4950,'REGULAR','CORE']);
 assert.equal(r1.allowance.periodStart,subs.A.currentPeriod.startsAt);assert.equal(r1.allowance.periodEnd,subs.A.currentPeriod.endsAt);
 const again=await reserve('staffA',O.A.school,'image.generate',5,kR);
 assert.deepEqual([again.replayed,again.reservation.reservationId],[true,r1.reservation.reservationId]);
 await deny(reserve('staffA',O.A.school,'image.generate',4,kR),409,'IDEMPOTENCY_KEY_REUSED');
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_credit_ledger WHERE entry_kind='RESERVE' AND reservation_id=$1",[r1.reservation.reservationId])).rows[0].n,1);
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.saas_credit_allowances WHERE subscription_id=$1',[subs.A.subscriptionId])).rows[0].n,1);

 // ---------- 7. settle: finalize, release, failure cost, unknown outcome ----------
 await deny(settle('staffA2',r1.reservation,'SUCCEEDED',{finalUnits:3,providerCostMicrounits:150000}),403,'SAAS_FORBIDDEN'); // only the requester settles
 let s1=await ok(settle('staffA',r1.reservation,'SUCCEEDED',{finalUnits:3,providerCostMicrounits:150000,outputUnits:3}));
 assert.deepEqual([s1.reservation.status,s1.reservation.finalCredits,s1.allowance.balance.consumedCredits,s1.allowance.balance.heldCredits,s1.allowance.balance.availableCredits],['FINALIZED',30,30,0,4970]);
 const usage1=(await admin.query('SELECT u.* FROM hon.ai_usage_ledger u JOIN hon.saas_credit_reservations r ON r.usage_id=u.id WHERE r.id=$1',[r1.reservation.reservationId])).rows[0];
 assert.deepEqual([usage1.customer_credits,usage1.provider_cost_microunits,usage1.modality,usage1.provider_code,usage1.school_id],['0','150000','IMAGE','HIGGSFIELD',O.A.school]);
 await deny(settle('staffA',s1.reservation,'FAILED'),409,'SAAS_TRANSITION_NOT_ALLOWED');
 const r2=(await ok(reserve('staffA',O.A.school,'image.generate',2))).reservation;
 await deny(settle('staffA',r2,'SUCCEEDED',{finalUnits:3,providerCostMicrounits:1}),422,'SAAS_FINAL_EXCEEDS_RESERVATION');
 const s2=await ok(settle('staffA',r2,'FAILED',{providerCostMicrounits:1000}));
 assert.deepEqual([s2.reservation.status,s2.allowance.balance.availableCredits,s2.allowance.balance.consumedCredits],['RELEASED',4970,30]);
 assert.equal((await admin.query('SELECT u.provider_cost_microunits::int c FROM hon.ai_usage_ledger u JOIN hon.saas_credit_reservations r ON r.usage_id=u.id WHERE r.id=$1',[r2.reservationId])).rows[0].c,1000);
 const r3=(await ok(reserve('staffA',O.A.school,'image.generate',4))).reservation;
 const u3=(await ok(settle('staffA',r3,'UNKNOWN'))).reservation;
 assert.equal(u3.status,'OUTCOME_UNKNOWN');assert.equal((await balance(O.A.id)).heldCredits,40);
 await deny(settle('staffA',u3,'SUCCEEDED',{finalUnits:4,providerCostMicrounits:1}),409,'SAAS_TRANSITION_NOT_ALLOWED'); // no blind retry
 const resolveBody=(r,resolution,patch={})=>({resolution,expectedVersion:r.version,finalUnits:null,providerCostMicrounits:null,evidenceReference:'Fixture provider dashboard export',...patch});
 await deny(api.resolveCreditReservation(H('operator'),u3.reservationId,resolveBody(u3,'NOT_CHARGED'),K()),403,'SAAS_FORBIDDEN');
 await deny(api.resolveCreditReservation(H('owner'),r1.reservation.reservationId,resolveBody(s1.reservation,'NOT_CHARGED'),K()),409,'SAAS_TRANSITION_NOT_ALLOWED');
 const res3=(await ok(api.resolveCreditReservation(H('owner'),u3.reservationId,resolveBody(u3,'SUCCEEDED',{finalUnits:4,providerCostMicrounits:200000}),K()))).reservation;
 assert.deepEqual([res3.status,res3.statusReason,res3.finalCredits,res3.providerCostMicrounits,res3.resolutionReference],['FINALIZED','HQ_RESOLVED_SUCCEEDED',40,200000,'Fixture provider dashboard export']);
 const r4=(await ok(reserve('staffA',O.A.school,'research.deep',100))).reservation;
 const u4=(await ok(settle('staffA',r4,'UNKNOWN'))).reservation;
 const res4=(await ok(api.resolveCreditReservation(H('owner'),u4.reservationId,resolveBody(u4,'NOT_CHARGED'),K()))).reservation;
 assert.deepEqual([res4.status,res4.usageId],['RELEASED',null]);
 let bA=await balance(O.A.id);assert.deepEqual([bA.consumedCredits,bA.heldCredits,bA.availableCredits],[70,0,4930]);

 // ---------- 8. concurrency: exact balance under contention, thresholds, hard stop at 100% ----------
 const race=await Promise.allSettled(Array.from({length:8},()=>reserve('staffB',O.B.school,'employee.task',5,K(),{employeeKey:'alex'})));
 const won=race.filter(r=>r.status==='fulfilled');commands+=won.length;
 assert.equal(won.length,6,JSON.stringify(race.map(r=>r.reason?.getResponse?.()??r.status)));
 for(const r of race.filter(r=>r.status==='rejected'))http(422,'SAAS_CREDITS_EXHAUSTED')(r.reason);
 let credB=await api.readOrganizationCredits(H('owner'),O.B.id);
 const allowB=credB.allowances[0];
 assert.deepEqual([allowB.balance.allowanceCredits,allowB.allowanceBasis,allowB.planCode,allowB.balance.heldCredits,allowB.balance.availableCredits,allowB.balance.usedPercent],
  [12000,'LIFETIME','COMPLETE',12000,0,100]);
 assert.deepEqual(allowB.thresholds.map(t=>[t.thresholdPercent,t.notification]),[[75,'NOT_SENT'],[90,'NOT_SENT'],[100,'NOT_SENT']]);
 const anchorB=new Date(subs.B.serviceStartedAt),endB=new Date(anchorB);endB.setUTCMonth(endB.getUTCMonth()+1);
 assert.deepEqual([allowB.periodStart,allowB.periodEnd,allowB.periodIndex],[subs.B.serviceStartedAt,endB.toISOString(),0]);
 assert.equal((await api.estimatePremiumOperation(H('staffB'),O.B.school,{operation:'research.deep',units:'1'})).refusal,'SAAS_CREDITS_EXHAUSTED');
 await deny(reserve('staffB',O.B.school,'research.deep',1),422,'SAAS_CREDITS_EXHAUSTED'); // no top-up, no overage
 const wonB=won.map(r=>r.value.reservation);
 assert.ok(wonB.every(r=>r.employeeKey==='alex'));
 await ok(settle('staffB',wonB[0],'FAILED'));
 assert.equal((await balance(O.B.id)).availableCredits,2000);

 // ---------- 9. legacy and Essential ----------
 const rl=await ok(reserve('staffL',O.L.school,'image.generate',1));
 assert.deepEqual([rl.allowance.allowanceBasis,rl.allowance.balance.allowanceCredits],['LEGACY',5000]);
 await deny(reserve('staffE',O.E.school,'image.generate',1),403,'SAAS_FORBIDDEN');

 // ---------- 10. suspension: no new grants or jobs; in-flight settles; history kept ----------
 const rc=(await ok(reserve('staffC',O.C.school,'image.generate',2))).reservation;
 subs.C=(await api.commandSubscription(H('owner'),subs.C.subscriptionId,{action:'SUSPEND',expectedVersion:subs.C.version,reasonCode:'ACCOUNT_REVIEW'},K())).subscription;
 await deny(reserve('staffC',O.C.school,'image.generate',1),422,'SAAS_SUBSCRIPTION_NOT_ACTIVE');
 assert.equal((await api.estimatePremiumOperation(H('staffC'),O.C.school,{operation:'image.generate',units:'1'})).refusal,'SAAS_SUBSCRIPTION_NOT_ACTIVE');
 const sc=await ok(settle('staffC',rc,'SUCCEEDED',{finalUnits:2,providerCostMicrounits:100000}));
 assert.deepEqual([sc.reservation.status,sc.allowance.balance.consumedCredits,sc.allowance.balance.allowanceCredits],['FINALIZED',20,5000]);
 await deny(api.commandAllowance(H('operator'),{action:'OPEN_CURRENT',subscriptionId:subs.D.subscriptionId},K()),422,'SAAS_SUBSCRIPTION_NOT_ACTIVE');

 // ---------- 11. period end: expiry without rollover, fresh full allowance ----------
 const allowA=(await api.readOrganizationCredits(H('operator'),O.A.id)).allowances[0];
 await deny(api.commandAllowance(H('operator'),{action:'EXPIRE',allowanceId:allowA.allowanceId,expectedVersion:allowA.version},K()),422,'SAAS_PERIOD_NOT_ENDED');
 // Elapse A's period (fixture only), then advance the subscription period.
 await withoutGuards(['saas_subscriptions','saas_credit_allowances'],[
  ["UPDATE hon.saas_subscriptions SET service_started_at=service_started_at-interval '40 days',period_anchor_at=period_anchor_at-interval '40 days',current_period_start=current_period_start-interval '40 days',current_period_end=current_period_start-interval '40 days'+interval '1 month' WHERE id=$1",[subs.A.subscriptionId]],
  ["UPDATE hon.saas_credit_allowances SET period_start=period_start-interval '40 days',period_end=period_start-interval '40 days'+interval '1 month' WHERE id=$1",[allowA.allowanceId]]]);
 await deny(reserve('staffA',O.A.school,'image.generate',1),422,'SAAS_ALLOWANCE_PERIOD_UNAVAILABLE'); // HQ has not advanced the period
 const cur=(await api.readOrganizationSubscription(H('owner'),O.A.id)).current;
 await api.commandSubscription(H('owner'),cur.subscriptionId,{action:'ADVANCE_PERIOD',expectedVersion:cur.version,reasonCode:'PERIOD_ELAPSED'},K());
 const fresh=await ok(reserve('staffA',O.A.school,'image.generate',1));
 assert.deepEqual([fresh.allowance.periodIndex,fresh.allowance.balance.allowanceCredits,fresh.allowance.balance.availableCredits,fresh.allowance.rollover],[1,5000,4990,'NONE']);
 const history=(await api.readOrganizationCredits(H('operator'),O.A.id)).allowances;
 const old=history.find(a=>a.allowanceId===allowA.allowanceId);
 assert.deepEqual([old.status,old.balance.expiredCredits,old.balance.availableCredits,old.balance.consumedCredits],['EXPIRED',4930,0,70]);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_credit_ledger WHERE allowance_id=$1 AND entry_kind='EXPIRE'",[allowA.allowanceId])).rows[0].n,1);

 // ---------- 12. deactivation stops new work but not settlement ----------
 const pv=(await api.readCreditProgram(H('owner'))).program;
 await ok(api.setCreditProgram(H('owner'),{action:'DEACTIVATE',expectedVersion:pv.version,authorizationReference:'Fixture owner pause'},K()));
 await deny(reserve('staffA',O.A.school,'image.generate',1),422,'SAAS_CREDITS_NOT_ACTIVE');
 assert.equal((await api.estimatePremiumOperation(H('staffA'),O.A.school,{operation:'image.generate',units:'1'})).refusal,'SAAS_CREDITS_NOT_ACTIVE');
 await ok(settle('staffA',fresh.reservation,'SUCCEEDED',{finalUnits:1,providerCostMicrounits:50000}));

 // ---------- 13. ordinary usage is visible but never deducted ----------
 await admin.query("INSERT INTO hon.ai_usage_ledger(organization_id,school_id,provider_code,model_code,modality,input_units,output_units,provider_cost_microunits,customer_credits,correlation_id) VALUES($1,$2,'OPENROUTER','fixture-chat','TEXT',800,200,900,1,gen_random_uuid())",[O.A.id,O.A.school]);
 const credA=await api.readOrganizationCredits(H('operator'),O.A.id);
 assert.deepEqual([credA.ordinaryUsageThisMonth.events,credA.ordinaryUsageThisMonth.providerCostMicrounits,credA.ordinaryUsageThisMonth.premiumDeduction],[1,900,'NONE']);
 assert.equal(credA.allowances[0].balance.consumedCredits,10);
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.ai_usage_ledger u JOIN hon.saas_credit_reservations r ON r.usage_id=u.id WHERE u.customer_credits<>0')).rows[0].n,0);

 // ---------- 14. constraints hold even with guards disabled ----------
 for(const col of ['top_ups_enabled','overage_enabled'])await rejectedWithoutGuards('saas_credit_program',`UPDATE hon.saas_credit_program SET ${col}=true`);
 await rejectedWithoutGuards('saas_credit_program',"UPDATE hon.saas_credit_program SET status='ACTIVE',authorization_reference=NULL");
 await rejectedWithoutGuards('saas_credit_threshold_events',"UPDATE hon.saas_credit_threshold_events SET notification_status='SENT'");
 await rejectedWithoutGuards('saas_credit_reservations',"UPDATE hon.saas_credit_reservations SET final_units=final_units+1000,final_credits=(final_units+1000)*credits_per_unit WHERE id=$1",[r1.reservation.reservationId]);
 await rejectedWithoutGuards('saas_provider_cost_evidence',"UPDATE hon.saas_provider_cost_evidence SET source='HQ_GUESS' WHERE id=$1",[evImage.costEvidenceId]);
 await rejectedWithoutGuards('saas_provider_cost_evidence',"UPDATE hon.saas_provider_cost_evidence SET fully_loaded_cost_microunits=1 WHERE id=$1",[evImage.costEvidenceId]);
 await rejectedWithoutGuards('saas_operation_prices',"UPDATE hon.saas_operation_prices SET required_capability='ai.premium_metered' WHERE operation_code='employee.task'");
 // Guards: ledgers append-only, allowances never reduced, published pricing frozen, reservations never reopen.
 await sqlDeny(admin.query('UPDATE hon.saas_credit_ledger SET credits=1'));
 await sqlDeny(admin.query('DELETE FROM hon.saas_credit_ledger'));
 await sqlDeny(admin.query('UPDATE hon.saas_credit_allowances SET allowance_credits=1 WHERE id=$1',[allowB.allowanceId]));
 await sqlDeny(admin.query('DELETE FROM hon.saas_credit_allowances WHERE id=$1',[allowB.allowanceId]));
 await sqlDeny(admin.query('UPDATE hon.saas_operation_prices SET credits_per_unit=1'));
 await sqlDeny(admin.query("INSERT INTO hon.saas_operation_prices(pricing_id,operation_code,category,display_name,billing_unit,credits_per_unit,max_units_per_request,required_capability,cost_evidence_id) VALUES($1,'video.generate','VIDEO_GENERATION','Video','IMAGE',1,1,'ai.premium_metered',$2)",[pricing.pricingId,evImage.costEvidenceId]));
 await sqlDeny(admin.query("UPDATE hon.saas_credit_reservations SET status='RESERVED',version=version+1 WHERE id=$1",[r1.reservation.reservationId]));
 await sqlDeny(admin.query('UPDATE hon.saas_provider_cost_evidence SET note=NULL'));
 await sqlDeny(admin.query('TRUNCATE hon.saas_credit_ledger CASCADE'));

 // ---------- 15. ledger invariants, evidence, no other effect ----------
 const inv=(await admin.query(`SELECT count(*)::int bad FROM hon.saas_credit_reservations r CROSS JOIN LATERAL (SELECT
   coalesce(sum(credits) FILTER (WHERE entry_kind='RESERVE'),0) res, coalesce(sum(credits) FILTER (WHERE entry_kind='FINALIZE'),0) fin,
   coalesce(sum(credits) FILTER (WHERE entry_kind='RELEASE'),0) rel FROM hon.saas_credit_ledger l WHERE l.reservation_id=r.id) x
   WHERE x.res<>r.reserved_credits OR (r.status IN ('FINALIZED','RELEASED') AND x.fin+x.rel<>r.reserved_credits) OR (r.status IN ('RESERVED','OUTCOME_UNKNOWN') AND x.fin+x.rel<>0)
     OR x.fin<>coalesce(r.final_credits,0)`)).rows[0].bad;
 assert.equal(inv,0);
 const ev=(await admin.query(`SELECT (SELECT count(*) FROM hon.saas_requests WHERE status='COMPLETED')::int req,(SELECT count(*) FROM hon.saas_requests WHERE status<>'COMPLETED')::int open,
  (SELECT count(*) FROM hon.saas_audit WHERE action_code LIKE 'saas.credits.%')::int audit,
  (SELECT count(*) FROM hon.saas_outbox WHERE event_type LIKE 'saas.credits.%' AND payload->'internalOnly'='true'::jsonb AND payload->'executionAllowed'='false'::jsonb)::int inert`)).rows[0];
 assert.deepEqual(ev,{req:requestBaseline+commands+2,open:0,audit:commands,inert:commands}); // +2: subscription SUSPEND (C) and ADVANCE_PERIOD (A) fixture commands
 assert.deepEqual(await untouched(),before,'No entitlement, school billing, HON invoice/evidence, Champions or shared audit row changed.');
 console.log(`PASS: HON premium credits B3 proof — ${commands} commands with exact evidence; owner-gated program; verified-cost-linked pricing; one allowance per period; idempotent reserve; finalize/release/unknown/resolve; exact balance under 8-way contention; 75/90/100 thresholds and hard stop; plan capabilities; suspension; expiry without rollover; provider cost kept apart from credits; no billing or Champions effect.`);
}finally{
 await setLegacySales(admin,false).catch(e=>console.error('RESTORE FAILED',e));
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end()]);}
}
