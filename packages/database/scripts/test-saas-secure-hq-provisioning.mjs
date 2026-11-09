import { syntheticExceptionPolicy } from './exception-policy-fixture.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertLegacySalesClosed } from './saas-legacy-sales-simulation.mjs';
// Secure HQ school provisioning (0185, owner decision D9) integrity proof, TEST MODE, SIMULATED PROVIDER, disposable
// database only. It proves: HQ provisioning creates a school with no operating access (entitlement SUSPENDED, no
// capabilities, no credits) for every authorized provisioner, idempotently and under concurrency, and refuses everyone
// else; only an HQ owner can grant a time-limited, scoped, audited exception, and never to an organization that already
// has access, a payment path, a subscription or another exception; forged approvals, AI/delegated contexts, direct writes
// and cross-tenant schools are refused; exceptions end by expiry, revocation or a later change, and closing them suspends
// the entitlement; a live exception is never a purchase basis and its scope cannot be widened by an HQ tier change;
// existing customers are untouched; the D7 first-purchase path and the D8 legacy closure still hold for a provisioned
// school; a pilot converts to paid only revoke-first: awaiting-first-payment is refused while an exception is active or
// scheduled and works (then D7) once it was revoked or expired. Paid access ACTIVE is simulated only for the D7 and
// conversion cases and restored before the proof ends.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasPaymentsService}=await import('../../../apps/api/dist/payments/saas-payments.service.js');
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const {StripeTestModeAdapter}=await import('../../../apps/api/dist/payments/stripe-test-mode-adapter.js');
const {StripeSimulator}=await import('../../../apps/api/dist/payments/stripe-simulator.js');
const {HqOnboardingService}=await import('../../../apps/api/dist/hq/hq-onboarding.service.js');
const {HqEntitlementService}=await import('../../../apps/api/dist/hq/hq-entitlement.service.js');
const contracts=await import('@hon/contracts');
const SECRET='whsec_disposableFixtureSecret0123456789',KEY='sk_test_disposableFixtureKey0123456789';
const sim=new StripeSimulator(SECRET);
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),access=new SaasSchoolBillingService(billing);
const payments=new SaasPaymentsService(billing,database,new StripeTestModeAdapter({secretKey:KEY,webhookSecret:SECRET,provider:'STRIPE_SIMULATED',transport:sim.transport}));
const onboarding=new HqOnboardingService(database),hqEntitlement=new HqEntitlementService(database);
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const saasTables=['saas_access_exceptions','saas_exception_policy_decisions','saas_access_transitions','saas_access_states','saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions',
 'saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions',
 'saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions',
 'saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code,message)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);if(message)assert.equal(e.message,message);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),HOUR=3600_000,DAY=24*HOUR;
// LG: an existing legacy customer (ACTIVE Complete, legacy subscription). PS: a pre-D9 provisioned school (ACTIVE Core,
// no subscription). SX: a suspended organization holding a subscription. AW: awaiting its first payment.
const O=Object.fromEntries(['LG','PS','SX','AW'].map(k=>[k,{id:randomUUID(),tier:k==='PS'?'CORE':'COMPLETE',school:randomUUID(),role:randomUUID()}]));
const humans=Object.fromEntries(['owner','exowner','operator','onboarder','support','stranger',...['P1','P2','P3','P4','P5','P6'].map(k=>`owner${k}`),
 ...Object.keys(O).map(k=>`owner${k}`)].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`d9-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
const P={};
let createdProvider=false,programTouched=false;
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
async function withoutGuards(tables,sqls){
 await admin.query('BEGIN');
 try{for(const t of tables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);for(const[sql,params]of sqls)await admin.query(sql,params);
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);await admin.query('COMMIT');}
 catch(e){await admin.query('ROLLBACK');throw e;}
}
// Every other organization in the database must be untouched; the fixtures' own changes are asserted one by one.
const provisionedOrgs=()=>[...Object.values(P).map(p=>p.organizationId),...Object.values(O).map(o=>o.id)];
async function untouched(){const out={};for(const t of ['organization_entitlements','billing_accounts','memberships','invoices','payment_attempts','champions_reward_entries','ai_usage_ledger'])
 out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t WHERE ${t==='organization_entitlements'?'NOT (organization_id=ANY($1::uuid[]))':'true OR $1::uuid[] IS NULL'} ORDER BY 1`,[provisionedOrgs()])).rows.map(r=>r.r);return out;}
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  const all=[...saasTables,'saas_credit_program','saas_reward_fulfillment','saas_payment_program'];
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of saasTables)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query("UPDATE hon.saas_credit_program SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query("UPDATE hon.saas_reward_fulfillment SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query("UPDATE hon.saas_payment_program SET status='DISABLED',provider=NULL,test_tax_reference=NULL,authorization_reference=NULL,version=1,changed_by_principal_id=NULL");
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  if(createdProvider)await admin.query("DELETE FROM hon.hq_ai_provider_connections WHERE provider_id='HIGGSFIELD'");
  // Schools provisioned through HQ, and PS (its HQ tier change), keep append-only platform audit rows; they stay in the
  // disposable database.
  const orgs=Object.values(O).filter(o=>o!==O.PS).map(o=>o.id);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const ent=async o=>row('SELECT tier::text,status::text,version,effective_until FROM hon.organization_entitlements WHERE organization_id=$1',[o]);
const caps=async o=>(await row('SELECT hon.saas_organization_access($1) a',[o])).a;
const allowances=async o=>(await row('SELECT count(*)::int n FROM hon.saas_credit_allowances WHERE organization_id=$1',[o])).n;
const subs=async o=>(await row('SELECT count(*)::int n FROM hon.saas_subscriptions WHERE organization_id=$1',[o])).n;
// A school-staff operating path: the human-work scope resolver (STATUS_GATED, window-aware) for the school's own owner.
const staffScope=async k=>(await restricted.query('SELECT organization_id FROM hon.resolve_human_work_scope($1)',[H(`owner${k}`)])).rows.map(r=>r.organization_id);
const provision=(who,slug,tier='COMPLETE',key=K(),extra={})=>onboarding.provisionInitialSchool({externalSubject:H(who)},{legalName:`D9 ${slug} LLC`,
 displayName:`D9 ${slug}`,schoolName:`D9 ${slug} Main`,schoolSlug:slug,timezone:'America/Chicago',initialTier:tier,idempotencyKey:key,expectedPrincipalId:humans[who].id,...extra});
const exceptionInput=(k,patch={})=>({schoolId:P[k].schoolId,purpose:'PRODUCT_DEMONSTRATION',reason:'Fixture demonstration for an approved prospect',
 scopeTier:'COMPLETE',startsAt:iso(Date.now()),expiresAt:iso(Date.now()+30*DAY),expectedEntitlementVersion:1,...patch});
const grant=(who,org,input,key=K())=>access.grantAccessException(H(who),org,input,key);
const osOffer=(code,kind,priceMinor,displayName)=>({offerCode:code,offerKind:kind,displayName,priceMinor,salesOpensAt:iso(Date.now()-HOUR),salesClosesAt:null,
 eligibility:'ANY_ACTIVE_ORGANIZATION',saleLimit:null,priceLock:'WHILE_CONTINUOUSLY_SUBSCRIBED',priceLockMonths:null,annualRenewal:null,
 plannedMonthlyPremiumCredits:12000,aiFairUseReference:null,refundWindowDays:30,cancellationTiming:'END_OF_PAID_PERIOD'});
// Grants the school-owner human an OWNER grant at a provisioned school (the school's own staff, not HQ).
async function addSchoolOwner(k){
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute')",
  [P[k].organizationId,P[k].schoolId,humans[`owner${k}`].id,P[k].ownerRoleId,humans.owner.id]);
}

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- 0. shipped posture ----------
 await assertLegacySalesClosed(admin);
 assert.equal((await row('SELECT status FROM hon.saas_access_program')).status,'INACTIVE');
 assert.deepEqual((await row('SELECT exception_max_days,exception_authority FROM hon.saas_access_policy_terms ORDER BY policy_version DESC LIMIT 1')),{exception_max_days:90,exception_authority:'HQ_OWNER'});
 await sqlDeny(restricted.query('SELECT * FROM hon.saas_access_exceptions'),'42501');
 for(const[sig,allowed]of [['guard_saas_access_exceptions()',false],['guard_saas_access_exception_grant()',false],['saas_access_exception_live(uuid)',false],
  ['saas_end_access_exception(uuid,text,text,uuid,timestamp with time zone)',false],['grant_saas_access_exception(text,uuid,jsonb,uuid,uuid,uuid)',true],
  ['revoke_saas_access_exception(text,uuid,jsonb,uuid,uuid,uuid)',true],['close_expired_saas_access_exceptions(text,uuid,uuid,uuid)',true],
  ['read_saas_access_exceptions_from_hq(text,uuid)',true]])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
 await cleanup();

 // ---------- fixture ----------
 await admin.query('BEGIN');
 if((await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state) VALUES('HIGGSFIELD','Fixture provider','DISABLED') ON CONFLICT DO NOTHING RETURNING provider_id")).rowCount)createdProvider=true;
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[who,hqRole,perms,until]of [['owner','HON_HQ_OWNER',[],null],['exowner','HON_HQ_OWNER',[],'1 minute'],['operator','HON_HQ_OPERATOR',['hq.billing.manage','hq.entitlement.manage'],null],
  ['onboarder','HON_HQ_OPERATOR',['hq.onboarding.manage'],null],['support','HON_HQ_SUPPORT',['hq.billing.manage'],null]])
  await admin.query(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',${until?`clock_timestamp()-interval '${until}'`:'NULL'})`,[humans[who].id,hqRole,perms]);
 for(const[k,o]of Object.entries(O)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o.id,`D9 Fixture Dojo ${k}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '90 days')",[o.id,o.tier,k==='SX'?'SUSPENDED':'ACTIVE']);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'America/New_York')",[o.school,o.id,`School ${k}`]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[o.role,o.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[o.role,o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[o.id,o.school,humans[`owner${k}`].id,o.role]);
 }
 await admin.query('COMMIT');
 // LG is a legacy customer and SX a suspended organization with a subscription (written as recorded before D8).
 const legacySub=(org)=>["INSERT INTO hon.saas_subscriptions(organization_id,source,plan_code,entitlement_tier,billing_interval,entitlement_version_at_record,status,status_reason,version,created_by_principal_id,created_at,updated_at) VALUES($1,'LEGACY_ENTITLEMENT','COMPLETE','COMPLETE','NONE',1,'PENDING_ACTIVATION','RECORDED',1,$2,clock_timestamp(),clock_timestamp())",[org,humans.owner.id]];
 await withoutGuards(['saas_subscriptions'],[legacySub(O.LG.id),legacySub(O.SX.id)]);
 const d=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
 d.termsReference='Fixture HON plan terms (not customer terms)';
 d.founderProgram={...d.founderProgram,eligibility:'ANY_ACTIVE_ORGANIZATION',opensAt:iso(Date.now()-HOUR)};
 await billing.publishCatalog(H('owner'),(await billing.createCatalogDraft(H('owner'),d,K())).catalog.catalogId,K());
 await payments.setPaymentProgram(H('owner'),{action:'ENABLE_TEST_MODE',expectedVersion:1,authorizationReference:'Fixture owner test-mode authorization (disposable)',
  provider:'STRIPE_SIMULATED',testTaxReference:'TEST MODE: no tax collected; TAXES undecided (fixture)'},K());
 const pub=await billing.publishOfferSet(H('owner'),...await(async()=>{const dr=await billing.createOfferSetDraft(H('owner'),{basedOnSetId:null,
  termsReference:'Fixture HON OS terms v1 (not customer terms)',founderTotalLimit:0,offers:[osOffer('OS_MONTHLY','REGULAR_MONTHLY',31700,'Monthly')]},K());
  return[dr.set.setId,{expectedRevision:dr.set.revision,previewDigest:dr.preview.previewDigest,approval:contracts.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K()];})());
 const OS=pub.set.offers[0].offerId;
 // The D7 first purchase: HON OS checkout by the school's own owner, then the verified (simulated) payment activates it.
 const firstPurchase=async k=>{const co=await payments.startSchoolHonOsCheckout(H(`owner${k}`),P[k].schoolId,{offerId:OS},K());
  const paid=sim.completeCheckout(co.checkout.providerSessionId);const d=await payments.handleWebhook(paid.completed.raw,paid.completed.signature);
  assert.deepEqual([d.event.outcome,d.event.detail],['APPLIED','ACCESS_ACTIVATED'],k);};
 const legacyOffer=(await payments.readPlanOptions(H('ownerLG'),O.LG.school)).offers;
 assert.deepEqual(legacyOffer,[],'D8: no legacy offer is listed');
 const before=await untouched();

 await syntheticExceptionPolicy(admin,access,H('owner'));
 // ---------- 1. provisioning grants no operating access ----------
 const slug=k=>`d9-${k.toLowerCase()}-${randomUUID().slice(0,8)}`;
 const kP1=K(),slugP1=slug('P1');
 P.P1=await provision('owner',slugP1,'COMPLETE',kP1);
 P.P2=await provision('onboarder',slug('P2'),'CORE');
 for(const[k,tier]of [['P1','COMPLETE'],['P2','CORE']]){
  assert.equal(P[k].replayed,false);
  assert.deepEqual(await ent(P[k].organizationId),{tier,status:'SUSPENDED',version:1,effective_until:null},`${k}: entitlement held SUSPENDED`);
  const a=await caps(P[k].organizationId);
  assert.deepEqual([a.state,a.source,a.capabilities,a.entitlement.inEffect],['PROVISIONED','NONE',[],false],`${k}: no capability`);
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_access_states WHERE organization_id=$1',[P[k].organizationId])).n,0,'no awaiting state');
  assert.deepEqual([await allowances(P[k].organizationId),await subs(P[k].organizationId)],[0,0],`${k}: no credits, no subscription`);
  const audit=await row("SELECT next_state FROM hon.audit_events WHERE organization_id=$1 AND action_code='hq.organization.provision'",[P[k].organizationId]);
  assert.deepEqual([audit.next_state.entitlementStatus,audit.next_state.access,audit.next_state.tier],['SUSPENDED','NONE',tier]);
 }
 await addSchoolOwner('P1');await addSchoolOwner('P2');
 assert.deepEqual(await staffScope('P1'),[],'the provisioned school owner has no staff operating scope');
 assert.deepEqual(await staffScope('PS'),[O.PS.id],'a pre-D9 provisioned school keeps its access');
 // Idempotent replay and key reuse.
 const replay=await provision('owner',slugP1,'COMPLETE',kP1);
 assert.deepEqual([replay.replayed,replay.organizationId,replay.schoolId],[true,P.P1.organizationId,P.P1.schoolId]);
 await deny(provision('owner',slugP1,'CORE',kP1),409,'HQ_PROVISIONING_CONFLICT');
 // Unauthorized provisioners: billing support, a billing operator without onboarding, a school owner, a stranger, an expired HQ owner.
 for(const who of ['support','ownerLG','stranger','exowner'])await deny(provision(who,slug('X')),403,'HQ_PROVISIONING_FORBIDDEN');
 // Concurrency: five identical requests under one key create one school.
 const kC=K(),slugC=slug('P3');
 const race=await Promise.allSettled(Array.from({length:5},()=>provision('owner',slugC,'COMPLETE',kC)));
 const won=race.filter(r=>r.status==='fulfilled').map(r=>r.value);
 assert.ok(won.length>=1&&race.every(r=>r.status==='fulfilled'||['HQ_PROVISIONING_IN_PROGRESS','HQ_PROVISIONING_CONFLICT'].includes(r.reason?.getResponse?.().code)),JSON.stringify(race.map(r=>r.reason?.getResponse?.()??r.reason?.code)));
 assert.equal(new Set(won.map(r=>r.organizationId)).size,1);
 assert.equal((await row('SELECT count(*)::int n FROM hon.schools WHERE slug=$1',[slugC])).n,1,'exactly one school');
 P.P3={...won[0]};await addSchoolOwner('P3');
 P.P4=await provision('owner',slug('P4'));await addSchoolOwner('P4');
 P.P5=await provision('owner',slug('P5'));await addSchoolOwner('P5');
 P.P6=await provision('owner',slug('P6'));await addSchoolOwner('P6');

 // ---------- 1b. expected-principal binding and authority order (0208) ----------
 // The receipt echoes the database actor and the current entitlement status.
 assert.deepEqual([P.P1.actorPrincipalId,P.P1.entitlementStatus,P.P2.actorPrincipalId,replay.actorPrincipalId],[humans.owner.id,'SUSPENDED',humans.onboarder.id,humans.owner.id]);
 // Runtime can execute only the bound entry point.
 for(const[sig,allowed]of [['provision_school_from_hq(text,text,text,text,text,text,hon.plan_tier,text,text,uuid,uuid)',false],['hq_provisioning_actor(text)',false],
  ['provision_school_from_hq_human(text,uuid,text,text,text,text,text,hon.plan_tier,text,text,uuid,uuid)',true]])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
 await sqlDeny(restricted.query("SELECT * FROM hon.provision_school_from_hq($1,'X','X','X',$2,'UTC','COMPLETE',$3,'f',$4,$4)",[H('owner'),slug('direct'),K(),K()]),'42501');
 const provisioningRows=async(who,key,slugValue)=>({schools:(await row('SELECT count(*)::int n FROM hon.schools WHERE slug=$1',[slugValue])).n,
  requests:(await row('SELECT count(*)::int n FROM hon.hq_onboarding_requests WHERE actor_principal_id=$1 AND idempotency_key=$2',[humans[who].id,key])).n});
 // A session that changed after the screen verified its principal is refused before any write.
 {
  const kM=K(),slugM=slug('mismatch');
  for(const expectedPrincipalId of [humans.onboarder.id,randomUUID(),humans.ownerP1.id])
   await deny(provision('owner',slugM,'COMPLETE',kM,{expectedPrincipalId}),409,'HQ_EXPECTED_PRINCIPAL_MISMATCH');
  assert.deepEqual(await provisioningRows('owner',kM,slugM),{schools:0,requests:0},'mismatch writes nothing');
  await deny(provision('stranger',slugM,'COMPLETE',kM,{expectedPrincipalId:humans.owner.id}),403,'HQ_PROVISIONING_FORBIDDEN');
  await deny(provision('owner',slugM,'COMPLETE',kM,{expectedPrincipalId:'not-a-uuid'}),400,'HQ_EXPECTED_PRINCIPAL_REQUIRED');
  const ok=await provision('owner',slugM,'COMPLETE',kM);P.PM=ok;
  assert.deepEqual([ok.replayed,ok.actorPrincipalId],[false,humans.owner.id]);
  // A replay under a different expected principal discloses nothing.
  await deny(provision('owner',slugM,'COMPLETE',kM,{expectedPrincipalId:humans.onboarder.id}),409,'HQ_EXPECTED_PRINCIPAL_MISMATCH');
  assert.deepEqual(await provisioningRows('owner',kM,slugM),{schools:1,requests:1});
 }
 // Authority that ends while the rows are being written rolls everything back; a replay after it ended is refused.
 {
  const late={id:randomUUID(),user:randomUUID(),subject:`d9-late-${randomUUID()}`};humans.late=late;
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[late.user,late.subject,`${late.user}@example.test`]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[late.id,late.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '1 hour')",[late.id]);
  // Sequences are not transactional: a trigger entry stays counted even when the command rolls back.
  await admin.query('CREATE SEQUENCE public.d9_clock_barrier_entries');
  await admin.query('CREATE TABLE public.d9_clock_barrier_at(until timestamptz)');await admin.query('INSERT INTO public.d9_clock_barrier_at VALUES(NULL)');
  await admin.query(`CREATE FUNCTION public.d9_clock_barrier() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
   DECLARE u timestamptz; BEGIN SELECT until INTO u FROM public.d9_clock_barrier_at;
   IF u IS NOT NULL AND NEW.event_type='organization.provisioned' THEN PERFORM nextval('public.d9_clock_barrier_entries'); PERFORM pg_sleep(greatest(0,extract(epoch FROM u-clock_timestamp()))+0.02); END IF; RETURN NEW; END $$`);
  // The outbox row is the last insert; only the request-completion update follows it.
  await admin.query('CREATE TRIGGER d9_clock_barrier BEFORE INSERT ON hon.outbox_events FOR EACH ROW EXECUTE FUNCTION public.d9_clock_barrier()');
  const entries=async()=>Number((await row('SELECT CASE WHEN is_called THEN last_value ELSE 0 END n FROM public.d9_clock_barrier_entries')).n);
  const durable=['organizations','organization_entitlements','schools','roles','role_permissions','principal_role_grants','audit_events','outbox_events','hq_onboarding_requests'];
  const durableCounts=async()=>Object.fromEntries(await Promise.all(durable.map(async t=>[t,(await row(`SELECT count(*)::int n FROM hon.${t}`)).n])));
  const pin=async()=>{const t=(await row("SELECT clock_timestamp()+interval '1500 milliseconds' t")).t;await admin.query('UPDATE public.d9_clock_barrier_at SET until=$1',[t]);return t;};
  try{
   // Control: intact authority completes through the same barrier.
   let t=await pin();const kCtl=K(),slugCtl=slug('late-ctl');let e0=await entries();
   const ctl=await provision('late',slugCtl,'COMPLETE',kCtl);P.PL=ctl;
   assert.equal(await entries(),e0+1,'control entered the barrier');assert.ok(Date.now()>=t.getTime(),'control passed the barrier');assert.equal(ctl.actorPrincipalId,late.id);
   // The grant ends at the barrier: nothing is committed.
   t=await pin();await admin.query('UPDATE hon.hq_operator_grants SET effective_until=$2 WHERE principal_id=$1',[late.id,t]);
   const kL=K(),slugL=slug('late');const beforeLate=await durableCounts();e0=await entries();
   await deny(provision('late',slugL,'COMPLETE',kL),403,'HQ_PROVISIONING_FORBIDDEN');
   assert.equal(await entries(),e0+1,'refused only after entering the last insert');assert.ok(Date.now()>=t.getTime(),'refused only after the expiry instant');
   assert.deepEqual(await durableCounts(),beforeLate,'every durable provisioning table rolled back');
   assert.deepEqual(await provisioningRows('late',kL,slugL),{schools:0,requests:0},'late expiry rolls back the school and the request claim');
   // The control request cannot be replayed once authority ended.
   await admin.query('UPDATE public.d9_clock_barrier_at SET until=NULL');
   await deny(provision('late',slugCtl,'COMPLETE',kCtl),403,'HQ_PROVISIONING_FORBIDDEN');
   // Restored authority replays; a removed grant is equally final.
   await admin.query('UPDATE hon.hq_operator_grants SET effective_until=NULL WHERE principal_id=$1',[late.id]);
   assert.equal((await provision('late',slugCtl,'COMPLETE',kCtl)).replayed,true,'restored authority replays');
   await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1',[late.id]);
   await deny(provision('late',slugCtl,'COMPLETE',kCtl),403,'HQ_PROVISIONING_FORBIDDEN');
  }finally{
   await admin.query('DROP TRIGGER IF EXISTS d9_clock_barrier ON hon.outbox_events');await admin.query('DROP FUNCTION IF EXISTS public.d9_clock_barrier()');await admin.query('DROP TABLE IF EXISTS public.d9_clock_barrier_at');await admin.query('DROP SEQUENCE IF EXISTS public.d9_clock_barrier_entries');
  }
 }
 // A second active principal on the same user is ambiguous and refused.
 {
  const twin=randomUUID();
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[twin,humans.onboarder.user]);
  try{await deny(provision('onboarder',slug('twin')),403,'HQ_PROVISIONING_FORBIDDEN');}
  finally{await admin.query('DELETE FROM hon.principals WHERE id=$1',[twin]);}
 }

 // ---------- 2. D8 and D7 for a provisioned school ----------
 const opts=await payments.readPlanOptions(H('ownerP1'),P.P1.schoolId);
 assert.deepEqual([opts.offers,opts.subscription,opts.checkout],[[],null,null],'D8: no legacy offer');
 const legacyOfferId=(await row("SELECT id FROM hon.saas_catalog_offers WHERE plan_code='COMPLETE' AND offer_kind='REGULAR_MONTHLY'")).id;
 await deny(payments.startSchoolCheckout(H('ownerP1'),P.P1.schoolId,{offerId:legacyOfferId},K()),422,'SAAS_LEGACY_SALES_CLOSED');
 assert.equal((await billing.readSchoolHonOsOffers(H('ownerP1'),P.P1.schoolId)).offers[0].eligibility,'NOT_ELIGIBLE_ENTITLEMENT');
 await deny(payments.startSchoolHonOsCheckout(H('ownerP1'),P.P1.schoolId,{offerId:OS},K()),422,'SAAS_ENTITLEMENT_NOT_ACTIVE');
 // With paid access ACTIVE (simulated), the HQ owner places P5 awaiting its first payment and it buys HON OS (D7).
 await setAccessProgram(true);
 await access.awaitFirstPayment(H('owner'),P.P5.organizationId,{expectedEntitlementVersion:1},K());
 assert.equal((await billing.readSchoolHonOsOffers(H('ownerP5'),P.P5.schoolId)).offers[0].eligibility,'ELIGIBLE');
 const co=await payments.startSchoolHonOsCheckout(H('ownerP5'),P.P5.schoolId,{offerId:OS},K());
 const paid=sim.completeCheckout(co.checkout.providerSessionId);
 const delivered=await payments.handleWebhook(paid.completed.raw,paid.completed.signature);
 assert.deepEqual([delivered.event.outcome,delivered.event.detail],['APPLIED','ACCESS_ACTIVATED']);
 assert.deepEqual(await ent(P.P5.organizationId),{tier:'COMPLETE',status:'ACTIVE',version:3,effective_until:null});
 assert.equal((await caps(P.P5.organizationId)).state,'PAYMENT_ACTIVE');
 assert.equal(await allowances(P.P5.organizationId),0,'no AI credits at HON OS activation');
 assert.deepEqual(await staffScope('P5'),[P.P5.organizationId],'paid access operates');
 await setAccessProgram(false);

 // ---------- 3. who may grant an exception ----------
 const in1=exceptionInput('P1');
 for(const who of ['operator','support','onboarder','ownerP1','stranger','exowner'])await deny(grant(who,P.P1.organizationId,in1),403,'SAAS_FORBIDDEN');
 // A forged approval field is not part of the contract; nothing the client sends names the grantor.
 await deny(grant('operator',P.P1.organizationId,{...in1,approvedByPrincipalId:humans.owner.id}),400,'INVALID_SAAS_INPUT');
 await deny(grant('owner',P.P1.organizationId,{...in1,approvedByPrincipalId:humans.owner.id}),400,'INVALID_SAAS_INPUT');
 // An HQ owner's identity inside an AI action or delegated context is refused by the database.
 for(const setting of ['app.hon_action_request_id','app.hon_delegated_by_principal_id']){
  await restricted.query('BEGIN');
  try{
   await restricted.query('SELECT set_config($1,$2,true)',[setting,setting.endsWith('principal_id')?humans.owner.id:randomUUID()]);
   await sqlDeny(restricted.query('SELECT hon.grant_saas_access_exception($1,$2,$3::jsonb,$4,$5,$6)',[H('owner'),P.P1.organizationId,JSON.stringify(in1),K(),K(),K()]),'42501');
  }finally{await restricted.query('ROLLBACK');}
 }
 assert.equal((await row('SELECT count(*)::int n FROM hon.saas_access_exceptions')).n,0);
 // Input rules: purpose, reason, scope, window, school identity.
 for(const bad of [{purpose:'FREE_FOREVER'},{reason:'short'},{reason:' padded reason text '},{scopeTier:'ESSENTIAL'},{startsAt:'2026-10-23'},
  {expiresAt:in1.startsAt},{expectedEntitlementVersion:0},{schoolId:'not-a-uuid'}])
  await deny(grant('owner',P.P1.organizationId,{...in1,...bad}),400,'INVALID_SAAS_INPUT');
 await deny(grant('owner',P.P1.organizationId,{...in1,expiresAt:iso(Date.parse(in1.startsAt)+91*DAY)}),422,'SAAS_EXCEPTION_TOO_LONG');
 await deny(grant('owner',P.P1.organizationId,{...in1,startsAt:iso(Date.now()-DAY)}),422,'SAAS_EXCEPTION_WINDOW_INVALID');
 await deny(grant('owner',P.P1.organizationId,{...in1,startsAt:iso(Date.now()+31*DAY),expiresAt:iso(Date.now()+40*DAY)}),422,'SAAS_EXCEPTION_WINDOW_INVALID');
 await deny(grant('owner',P.P1.organizationId,{...in1,expectedEntitlementVersion:2}),409);
 // Cross-tenant: another organization's school, or an unknown organization.
 await deny(grant('owner',P.P1.organizationId,{...in1,schoolId:P.P2.schoolId}),404,'SAAS_UNAVAILABLE');
 await deny(grant('owner',randomUUID(),in1),404,'SAAS_UNAVAILABLE');
 // Existing customers and payment paths are never overwritten by an exception.
 const inOf=(k,patch)=>({...in1,schoolId:O[k].school,...patch});
 await deny(grant('owner',O.LG.id,inOf('LG')),422,'SAAS_ENTITLEMENT_IN_EFFECT');
 await deny(grant('owner',O.PS.id,inOf('PS')),422,'SAAS_ENTITLEMENT_IN_EFFECT');
 await deny(grant('owner',O.SX.id,inOf('SX')),422,'SAAS_SUBSCRIPTION_EXISTS');
 await deny(grant('owner',P.P5.organizationId,{...in1,schoolId:P.P5.schoolId,expectedEntitlementVersion:3}),422,'SAAS_ENTITLEMENT_IN_EFFECT');
 await setAccessProgram(true);
 await access.awaitFirstPayment(H('owner'),O.AW.id,{expectedEntitlementVersion:1},K());
 await setAccessProgram(false);
 await deny(grant('owner',O.AW.id,inOf('AW',{expectedEntitlementVersion:2})),422,'SAAS_ACCESS_STATE_EXISTS');
 assert.equal((await row('SELECT count(*)::int n FROM hon.saas_access_exceptions')).n,0,'no refused request left a record');

 // ---------- 4. a granted exception: scoped, audited, idempotent, no credits ----------
 const kG=K();
 const g1=await grant('owner',P.P1.organizationId,in1,kG);
 const x1=g1.exception;
 assert.deepEqual([g1.replayed,x1.lifecycle,x1.status,x1.purpose,x1.scopeTier,x1.aiCredits,x1.maxDays,x1.policyVersion,x1.grantedByPrincipalId,x1.schoolId],
  [false,'IN_EFFECT','GRANTED','PRODUCT_DEMONSTRATION','COMPLETE','NONE',90,2,humans.owner.id,P.P1.schoolId]);
 assert.deepEqual([x1.priorEntitlement.status,x1.grantedEntitlement.status,x1.grantedEntitlement.effectiveUntil],['SUSPENDED','ACTIVE',in1.expiresAt]);
 assert.deepEqual((await ent(P.P1.organizationId)).status,'ACTIVE');
 assert.deepEqual([g1.access.source,g1.access.capabilities],['PROVISIONED',[...contracts.SAAS_PLAN_CAPABILITIES.COMPLETE]]);
 assert.deepEqual(await staffScope('P1'),[P.P1.organizationId],'the exception gives the school its scope');
 assert.deepEqual([await allowances(P.P1.organizationId),await subs(P.P1.organizationId)],[0,0],'no AI credits, no subscription');
 const ev=await row("SELECT a.actor_principal_id,a.entity_id,a.organization_id,o.event_type,o.payload->>'internalOnly' internal FROM hon.saas_audit a JOIN hon.saas_outbox o ON o.audit_id=a.id WHERE a.action_code='saas.access.exception_grant'");
 assert.deepEqual(ev,{actor_principal_id:humans.owner.id,entity_id:x1.exceptionId,organization_id:P.P1.organizationId,event_type:'saas.access.exception_granted',internal:'true'});
 const r1=await grant('owner',P.P1.organizationId,in1,kG);
 assert.deepEqual([r1.replayed,r1.exception.exceptionId],[true,x1.exceptionId],'idempotent replay');
 await deny(grant('owner',P.P1.organizationId,{...in1,reason:'A different fixture reason text'},kG),409,'IDEMPOTENCY_KEY_REUSED');
 await deny(grant('owner',P.P1.organizationId,{...in1,expectedEntitlementVersion:2}),422,'SAAS_ACCESS_EXCEPTION_ACTIVE');
 // Reads: HQ billing staff can read; a school owner cannot.
 const view=await access.readAccessExceptions(H('operator'),P.P1.organizationId);
 assert.deepEqual(view.exceptions.map(x=>[x.exceptionId,x.lifecycle]),[[x1.exceptionId,'IN_EFFECT']]);
 await deny(access.readAccessExceptions(H('ownerP1'),P.P1.organizationId),403,'SAAS_FORBIDDEN');
 // A live exception is never a purchase basis, and an HQ tier change cannot widen or alter its scope.
 assert.equal((await billing.readSchoolHonOsOffers(H('ownerP1'),P.P1.schoolId)).offers[0].eligibility,'NOT_ELIGIBLE_ENTITLEMENT');
 await deny(payments.startSchoolHonOsCheckout(H('ownerP1'),P.P1.schoolId,{offerId:OS},K()),422,'SAAS_ACCESS_EXCEPTION_ACTIVE');
 await deny(payments.startSchoolCheckout(H('ownerP1'),P.P1.schoolId,{offerId:legacyOfferId},K()),422,'SAAS_LEGACY_SALES_CLOSED');
 await deny(hqEntitlement.transition(H('operator'),P.P1.organizationId,{targetTier:'CORE',expectedVersion:2},K()),404,'HQ_ENTITLEMENT_UNAVAILABLE');
 await deny(hqEntitlement.transition(H('owner'),P.P1.organizationId,{targetTier:'CORE',expectedVersion:2},K()),404,'HQ_ENTITLEMENT_UNAVAILABLE');
 assert.deepEqual(await hqEntitlement.transition(H('operator'),O.PS.id,{targetTier:'COMPLETE',expectedVersion:1},K()).then(r=>[r.priorTier,r.targetTier]),['CORE','COMPLETE'],
  'tier changes for schools without an exception still work');

 // ---------- 5. concurrency: five different grant requests for one school ----------
 const in2={...exceptionInput('P2'),purpose:'APPROVED_PILOT',reason:'Fixture approved pilot for an early partner',scopeTier:'CORE'};
 const race2=await Promise.allSettled(Array.from({length:5},()=>grant('owner',P.P2.organizationId,in2)));
 assert.equal(race2.filter(r=>r.status==='fulfilled').length,1,'exactly one exception');
 for(const r of race2.filter(r=>r.status==='rejected'))assert.ok([409,422].includes(r.reason.getStatus?.()),r.reason.stack);
 assert.equal((await row("SELECT count(*)::int n FROM hon.saas_access_exceptions WHERE organization_id=$1",[P.P2.organizationId])).n,1);
 assert.deepEqual(await ent(P.P2.organizationId).then(e=>[e.tier,e.status,e.version]),['CORE','ACTIVE',2]);
 assert.deepEqual((await caps(P.P2.organizationId)).capabilities,[...contracts.SAAS_PLAN_CAPABILITIES.CORE],'scope is Core only');

 // ---------- 6. direct writes ----------
 await sqlDeny(restricted.query("INSERT INTO hon.saas_access_exceptions(organization_id) VALUES($1)",[P.P3.organizationId]),'42501');
 await sqlDeny(restricted.query("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[P.P3.organizationId]),'42501');
 await sqlDeny(restricted.query("SELECT hon.saas_end_access_exception($1,'REVOKED',NULL,$2,clock_timestamp())",[x1.exceptionId,humans.owner.id]),'42501');
 const forged=(grantor,until)=>admin.query(`INSERT INTO hon.saas_access_exceptions(organization_id,school_id,purpose,reason,scope_tier,starts_at,expires_at,policy_version,max_days,
  prior_entitlement,granted_entitlement,granted_entitlement_version,granted_by_principal_id,granted_at,status)
  SELECT e.organization_id,$2,'INTERNAL_TESTING','Forged exception written around the command','COMPLETE',e.effective_from,coalesce(e.effective_until,$4::timestamptz),1,90,
   '{}'::jsonb,'{}'::jsonb,e.version,$3,clock_timestamp(),'GRANTED' FROM hon.organization_entitlements e WHERE e.organization_id=$1`,
  [P.P3.organizationId,P.P3.schoolId,grantor,until]);
 // Even the migration owner writing the row directly must name a current HQ owner and the entitlement exactly as it stands.
 await admin.query('BEGIN');
 try{await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp(),effective_until=clock_timestamp()+interval '10 days',version=version+1 WHERE organization_id=$1",[P.P3.organizationId]);
  for(const who of ['operator','support','ownerP3','exowner'])await admin.query('SAVEPOINT f').then(()=>sqlDeny(forged(humans[who].id,null),'42501','SAAS_EXCEPTION_FORBIDDEN')).then(()=>admin.query('ROLLBACK TO SAVEPOINT f'));
 }finally{await admin.query('ROLLBACK');}
 await sqlDeny(forged(humans.owner.id,iso(Date.now()+DAY)),'42501','SAAS_EXCEPTION_FORBIDDEN');
 await sqlDeny(admin.query("UPDATE hon.saas_access_exceptions SET expires_at=expires_at+interval '1 day' WHERE id=$1",[x1.exceptionId]),'42501','IMMUTABLE_SAAS_RECORD');
 await sqlDeny(admin.query("UPDATE hon.saas_access_exceptions SET scope_tier='COMPLETE' WHERE organization_id=$1",[P.P2.organizationId]),'42501','IMMUTABLE_SAAS_RECORD');
 await sqlDeny(admin.query('DELETE FROM hon.saas_access_exceptions WHERE id=$1',[x1.exceptionId]),'42501','IMMUTABLE_SAAS_RECORD');
 await sqlDeny(admin.query('TRUNCATE hon.saas_access_exceptions'),'42501','IMMUTABLE_SAAS_RECORD');

 // ---------- 7. revocation ----------
 const rv={reason:'Demonstration finished; access removed'};
 for(const who of ['operator','support','ownerP1'])await deny(access.revokeAccessException(H(who),x1.exceptionId,rv,K()),403,'SAAS_FORBIDDEN');
 await deny(access.revokeAccessException(H('owner'),x1.exceptionId,{reason:'no'},K()),400,'INVALID_SAAS_INPUT');
 const kR=K();
 const revoked=await access.revokeAccessException(H('owner'),x1.exceptionId,rv,kR);
 assert.deepEqual([revoked.replayed,revoked.entitlementSuspended,revoked.exception.lifecycle,revoked.exception.endNote,revoked.exception.endedByPrincipalId,revoked.access.capabilities],
  [false,true,'REVOKED',rv.reason,humans.owner.id,[]]);
 assert.deepEqual(await ent(P.P1.organizationId).then(e=>[e.status,e.version]),['SUSPENDED',3]);
 assert.deepEqual(await staffScope('P1'),[],'revoked: no operating scope');
 assert.equal((await access.revokeAccessException(H('owner'),x1.exceptionId,rv,kR)).replayed,true);
 await deny(access.revokeAccessException(H('owner'),x1.exceptionId,rv,K()),422,'SAAS_EXCEPTION_ENDED');
 assert.equal((await billing.readSchoolHonOsOffers(H('ownerP1'),P.P1.schoolId)).offers[0].eligibility,'NOT_ELIGIBLE_ENTITLEMENT');
 await deny(payments.startSchoolHonOsCheckout(H('ownerP1'),P.P1.schoolId,{offerId:OS},K()),422,'SAAS_ENTITLEMENT_NOT_ACTIVE');

 // ---------- 8. expiry, closing and a renewed exception ----------
 const in3={...exceptionInput('P3'),purpose:'INTERNAL_TESTING',reason:'Fixture internal QA window for HQ testing',startsAt:iso(Date.now()),expiresAt:iso(Date.now()+3000)};
 const x3=(await grant('owner',P.P3.organizationId,in3)).exception;
 assert.equal(x3.lifecycle,'IN_EFFECT');
 const x6=(await grant('owner',P.P6.organizationId,{...in3,schoolId:P.P6.schoolId,purpose:'APPROVED_PILOT',reason:'Fixture pilot that runs to its expiry',expiresAt:iso(Date.now()+3000)})).exception;
 assert.deepEqual(await staffScope('P3'),[P.P3.organizationId]);
 await sleep(3500);
 const lapsed=await caps(P.P3.organizationId);
 assert.deepEqual([lapsed.entitlement.status,lapsed.entitlement.inEffect,lapsed.capabilities],['ACTIVE',false,[]],'expired by its own window');
 assert.deepEqual(await staffScope('P3'),[],'expired: no operating scope, before anyone closes it');
 assert.equal((await access.readAccessExceptions(H('owner'),P.P3.organizationId)).exceptions[0].lifecycle,'EXPIRED');
 await deny(payments.startSchoolHonOsCheckout(H('ownerP3'),P.P3.schoolId,{offerId:OS},K()),422,'SAAS_ENTITLEMENT_NOT_ACTIVE');
 // A scheduled exception is not yet in effect.
 const x4=(await grant('owner',P.P4.organizationId,{...exceptionInput('P4'),purpose:'APPROVED_PILOT',reason:'Fixture pilot starting tomorrow',
  startsAt:iso(Date.now()+DAY),expiresAt:iso(Date.now()+60*DAY)})).exception;
 assert.equal(x4.lifecycle,'SCHEDULED');
 assert.deepEqual([(await caps(P.P4.organizationId)).capabilities,await staffScope('P4')],[[],[]],'scheduled: nothing yet');
 await deny(payments.startSchoolHonOsCheckout(H('ownerP4'),P.P4.schoolId,{offerId:OS},K()),422,'SAAS_ACCESS_EXCEPTION_ACTIVE');
 // Revoke-first pilot conversion (owner policy): while an exception is active (P2) or scheduled (P4), the HQ owner
 // cannot place the school awaiting its first payment, even with paid access ACTIVE (simulated); nothing changes.
 await setAccessProgram(true);
 const states=async o=>(await row('SELECT count(*)::int n FROM hon.saas_access_states WHERE organization_id=$1',[o])).n;
 for(const[k,x,tier]of [['P2',null,'CORE'],['P4',x4,'COMPLETE']]){
  await deny(access.awaitFirstPayment(H('owner'),P[k].organizationId,{expectedEntitlementVersion:2},K()),422,'SAAS_ACCESS_EXCEPTION_ACTIVE');
  assert.deepEqual(await ent(P[k].organizationId).then(e=>[e.tier,e.status,e.version]),[tier,'ACTIVE',2],`${k}: entitlement unchanged`);
  assert.equal(await states(P[k].organizationId),0,`${k}: no awaiting state`);
  assert.equal((await access.readAccessExceptions(H('owner'),P[k].organizationId)).exceptions[0].lifecycle,k==='P2'?'IN_EFFECT':'SCHEDULED');
 }
 assert.equal((await row("SELECT count(*)::int n FROM hon.saas_audit WHERE action_code='saas.access.await' AND organization_id=ANY($1::uuid[])",[[P.P2.organizationId,P.P4.organizationId]])).n,0,'no refused transition was recorded');
 // The database backstop refuses an access state written around the command while an exception is open and unexpired.
 await sqlDeny(admin.query("INSERT INTO hon.saas_access_states(organization_id,state,reason,version,changed_by_principal_id,created_at,updated_at) VALUES($1,'AWAITING_FIRST_PAYMENT','AWAITING_INITIAL_PAYMENT',1,$2,clock_timestamp(),clock_timestamp())",
  [P.P4.organizationId,humans.owner.id]),'23514','SAAS_ACCESS_EXCEPTION_ACTIVE');
 // Revoked: the HQ owner revokes P4's scheduled pilot first; then P4 can await its first payment and buy HON OS (D7).
 assert.equal((await access.revokeAccessException(H('owner'),x4.exceptionId,{reason:'Pilot converting to a paid subscription'},K())).entitlementSuspended,true);
 await access.awaitFirstPayment(H('owner'),P.P4.organizationId,{expectedEntitlementVersion:3},K());
 assert.equal((await caps(P.P4.organizationId)).state,'AWAITING_FIRST_PAYMENT');
 await firstPurchase('P4');
 assert.deepEqual(await ent(P.P4.organizationId).then(e=>[e.tier,e.status,e.version,e.effective_until]),['COMPLETE','ACTIVE',5,null]);
 assert.equal((await caps(P.P4.organizationId)).state,'PAYMENT_ACTIVE');
 // Expired: P6's pilot reached its expiry and nobody closed it. It no longer blocks; the transition closes its record as
 // EXPIRED (its lapsed entitlement suspended) before holding the school awaiting, and P6 buys HON OS (D7).
 assert.equal((await access.readAccessExceptions(H('owner'),P.P6.organizationId)).exceptions[0].lifecycle,'EXPIRED');
 await access.awaitFirstPayment(H('owner'),P.P6.organizationId,{expectedEntitlementVersion:2},K());
 const x6end=(await access.readAccessExceptions(H('owner'),P.P6.organizationId)).exceptions[0];
 assert.deepEqual([x6end.exceptionId,x6end.status,x6end.lifecycle,x6end.endReason],[x6.exceptionId,'ENDED','EXPIRED','EXPIRED']);
 assert.deepEqual(await ent(P.P6.organizationId).then(e=>[e.status,e.version]),['SUSPENDED',4]);
 await firstPurchase('P6');
 assert.deepEqual(await ent(P.P6.organizationId).then(e=>[e.status,e.version,e.effective_until]),['ACTIVE',5,null]);
 assert.deepEqual([await allowances(P.P4.organizationId),await allowances(P.P6.organizationId)],[0,0],'no AI credits at HON OS activation');
 await setAccessProgram(false);
 // Closing: unauthorized, then a billing operator closes the lapsed exception; live ones stay. (Supersession and batches
 // above 200 are proved in test-saas-access-exception-hardening.mjs.)
 for(const who of ['support','ownerP3','stranger'])await deny(access.closeExpiredAccessExceptions(H(who),{},K()),403,'SAAS_FORBIDDEN');
 await deny(access.closeExpiredAccessExceptions(H('operator'),{extra:true},K()),400,'INVALID_SAAS_INPUT');
 const kX=K();
 const closed=await access.closeExpiredAccessExceptions(H('operator'),{},kX);
 assert.deepEqual(closed.closed.map(x=>[x.organizationId,x.endReason]),[[P.P3.organizationId,'EXPIRED']]);
 assert.deepEqual(await ent(P.P3.organizationId).then(e=>[e.status,e.version]),['SUSPENDED',3],'closing suspends the lapsed entitlement');
 assert.equal((await access.closeExpiredAccessExceptions(H('operator'),{},kX)).replayed,true);
 assert.deepEqual((await access.closeExpiredAccessExceptions(H('owner'),{},K())).closed,[],'nothing left to close');
 assert.equal((await access.readAccessExceptions(H('owner'),P.P2.organizationId)).exceptions[0].lifecycle,'IN_EFFECT','a live exception is never closed');
 // A new exception after one ended (the previous record stays as evidence).
 const x3b=(await grant('owner',P.P3.organizationId,{...in3,startsAt:iso(Date.now()),expiresAt:iso(Date.now()+7*DAY),expectedEntitlementVersion:3})).exception;
 assert.equal(x3b.lifecycle,'IN_EFFECT');
 assert.deepEqual((await access.readAccessExceptions(H('owner'),P.P3.organizationId)).exceptions.map(x=>x.lifecycle),['IN_EFFECT','EXPIRED']);
 // An expired exception that nobody closed is closed by the next grant.
 const in1b={...exceptionInput('P1'),expectedEntitlementVersion:3,startsAt:iso(Date.now()),expiresAt:iso(Date.now()+2000)};
 await grant('owner',P.P1.organizationId,in1b);
 await sleep(2500);
 await grant('owner',P.P1.organizationId,{...in1b,startsAt:iso(Date.now()),expiresAt:iso(Date.now()+DAY),expectedEntitlementVersion:4});
 assert.deepEqual((await access.readAccessExceptions(H('owner'),P.P1.organizationId)).exceptions.map(x=>x.lifecycle),['IN_EFFECT','EXPIRED','REVOKED']);
 assert.equal((await row("SELECT count(*)::int n FROM hon.saas_access_exceptions WHERE status='GRANTED' AND organization_id=$1",[P.P1.organizationId])).n,1);

 // ---------- 9. existing customers and credits ----------
 assert.deepEqual(await untouched(),before,'no organization outside this proof was touched');
 assert.deepEqual(await ent(O.LG.id).then(e=>[e.tier,e.status,e.version]),['COMPLETE','ACTIVE',1],'legacy customer untouched');
 assert.equal((await row('SELECT count(*)::int n FROM hon.saas_credit_allowances')).n,0,'no AI credits anywhere');
 assert.deepEqual(await staffScope('LG'),[O.LG.id],'legacy customer keeps operating');
 await assertLegacySalesClosed(admin);
 assert.equal((await row('SELECT status FROM hon.saas_access_program')).status,'INACTIVE');
 console.log('PASS: secure HQ provisioning (D9) — provisioned schools get no access, credits or capability (owner and onboarding operator, idempotent, one school under a five-way race, unauthorized provisioners refused); D8 closure and the D7 first purchase hold for a provisioned school; only a current HQ owner grants an exception (operators, support, school owners, strangers, an expired owner, AI and delegated contexts, forged fields and direct writes refused); exceptions are scoped, windowed (90-day cap), audited, idempotent, one per school under a five-way race, never a purchase basis and never widened by a tier change; revocation, expiry, scheduling, closing and renewal behave; awaiting-first-payment is refused while an exception is active or scheduled (command and database backstop) and works, followed by the D7 purchase, after revocation or expiry; existing customers untouched; no AI credits.');
}finally{
 if(programTouched)await setAccessProgram(false).catch(e=>console.error('RESTORE FAILED',e));
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end()]);}
}
