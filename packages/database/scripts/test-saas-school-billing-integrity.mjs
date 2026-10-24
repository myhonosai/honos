import pg from 'pg';
import { setLegacySales } from './saas-legacy-sales-simulation.mjs';
import { activatePreD9ProvisionedSchool } from './pre-d9-provisioning-simulation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// HON Subscription Billing B5.1 (0170) integrity proof: school-owner billing reads and the INACTIVE B6 paid-access
// foundation, against a disposable database through the real API services. Provider-verified rows come from the
// deterministic Stripe simulator (STRIPE_SIMULATED); HQ-recorded rows from B2 attestation. Proves: billing.hon.view
// at the exact school (HQ, support, other organizations and staff without the permission refused); organization-level
// billing across a multi-school organization; drafts, notes and internal references never visible; stable keyset
// pagination over the complete history; provider-verified versus HQ-recorded distinctions; refunds and chargebacks;
// entitlement, activation and allowance read from canonical records (never from payment); the HQ dry run of the
// proposed paid-access terms; the access program cannot be activated; nothing is written by any read.
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
const contracts=await import('@hon/contracts');
const SECRET='whsec_disposableFixtureSecret0123456789',KEY='sk_test_disposableFixtureKey0123456789';
const sim=new StripeSimulator(SECRET);
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database);
const payments=new SaasPaymentsService(billing,database,new StripeTestModeAdapter({secretKey:KEY,webhookSecret:SECRET,provider:'STRIPE_SIMULATED',transport:sim.transport}));
const reads=new SaasSchoolBillingService(billing);
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const saasTables=['saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions','saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger',
 'saas_reward_applications','saas_refund_history','saas_refund_requests','saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances',
 'saas_operation_prices','saas_pricing_versions','saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox',
 'saas_audit','saas_requests','saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions'];
const championsTables=['champions_outbox','champions_audit','champions_reward_history','champions_reward_entries','champions_reward_policies','champions_attribution_history',
 'champions_attributions','champions_requests','champions_referral_codes','champions_policies'];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code='42501')=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
// Fixture organizations: B Complete (HQ-attested), C Core (paid, then entitlement suspended), D Core (unpaid renewal),
// E Complete (founder lifetime, refunded), W Core (disputed), F Core (provisioned only, no subscription).
const O=Object.fromEntries(['B','C','D','E','W','F'].map(k=>[k,{id:randomUUID(),tier:['B','E'].includes(k)?'COMPLETE':'CORE',school:randomUUID(),role:randomUUID()}]));
const humans=Object.fromEntries(['owner','operator','support','ownerA','ownerA2','clerkA',...Object.keys(O).map(k=>`owner${k}`)].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`b51-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
let createdProvider=false,A=null;
const fixtureOrgs=()=>[...Object.values(O).map(o=>o.id)];
async function untouched(){const out={};for(const t of ['organization_entitlements','billing_accounts','memberships','invoices','membership_payment_schedules','payment_attempts','audit_events','outbox_events',
 'champions_reward_entries','saas_access_program','saas_access_policy_terms'])out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t ORDER BY 1`)).rows.map(r=>r.r);return out;}
// Everything a read could possibly write: B1-B5 evidence, B3 allowance opening and the shared ledgers.
async function writes(){const out={};for(const t of ['saas_requests','saas_audit','saas_outbox','saas_credit_allowances','saas_credit_ledger','saas_subscription_history',
 'saas_invoices','saas_payment_evidence','saas_provider_events','saas_checkout_sessions','saas_refund_requests'])out[t]=(await admin.query(`SELECT count(*)::int n FROM hon.${t}`)).rows[0].n;return out;}
async function withoutGuards(tables,sqls){
 await admin.query('BEGIN');
 try{for(const t of tables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);for(const[sql,params]of sqls)await admin.query(sql,params);
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);await admin.query('COMMIT');}
 catch(e){await admin.query('ROLLBACK');throw e;}
}
async function rejectedWithoutGuards(table,sql,params=[],code='23514'){
 await admin.query('BEGIN');
 try{await admin.query(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);await sqlDeny(admin.query(sql,params),code);}finally{await admin.query('ROLLBACK');}
}
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  const all=[...saasTables,'saas_credit_program','saas_reward_fulfillment','saas_payment_program',...championsTables];
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of [...saasTables,...championsTables])await admin.query(`DELETE FROM hon.${t}`);
  await admin.query("UPDATE hon.saas_credit_program SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query("UPDATE hon.saas_reward_fulfillment SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query("UPDATE hon.saas_payment_program SET status='DISABLED',provider=NULL,test_tax_reference=NULL,authorization_reference=NULL,version=1,changed_by_principal_id=NULL");
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of all)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('DELETE FROM hon.ai_usage_ledger WHERE organization_id=ANY($1::uuid[])',[fixtureOrgs()]);
  if(createdProvider)await admin.query("DELETE FROM hon.hq_ai_provider_connections WHERE provider_id='HIGGSFIELD'");
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[fixtureOrgs()]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[fixtureOrgs()]);
  // The provisioned school A and its HQ owner keep append-only platform audit rows; they stay in the disposable database.
  if(A){await admin.query('DELETE FROM hon.principal_role_grants WHERE organization_id=$1 AND school_id<>$2',[A.id,A.school]);await admin.query('DELETE FROM hon.schools WHERE organization_id=$1 AND id<>$2',[A.id,A.school]);}
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const deliver=d=>payments.handleWebhook(d.raw,d.signature);
const outcome=async d=>{const r=await deliver(d);return [r.event.outcome,r.event.detail];};
const options=(who,school)=>payments.readPlanOptions(H(who),school);
const offerOf=(opts,kind)=>opts.offers.find(o=>o.offerKind===kind).offerId;
const start=(who,school,offerId)=>payments.startSchoolCheckout(H(who),school,{offerId},K());
const subOf=async org=>(await billing.readOrganizationSubscription(H('operator'),org)).current;
const account=(who,school)=>reads.readAccount(H(who),school);
const page=(who,school,query={})=>reads.readInvoices(H(who),school,query);
const detail=(who,school,invoice)=>reads.readInvoice(H(who),school,invoice);
const dryRun=org=>reads.readAccessReadiness(H('operator'),org);
const elapse=(subId,days)=>withoutGuards(['saas_subscriptions','saas_invoices','saas_credit_allowances'],[
 [`UPDATE hon.saas_subscriptions SET service_started_at=service_started_at-$2::interval,period_anchor_at=period_anchor_at-$2::interval,current_period_start=current_period_start-$2::interval,
   current_period_end=CASE WHEN billing_interval='MONTHLY' THEN current_period_start-$2::interval+interval '1 month' END WHERE id=$1`,[subId,`${days} days`]],
 [`UPDATE hon.saas_invoices SET service_period_start=service_period_start-$2::interval,service_period_end=CASE WHEN service_period_end IS NULL THEN NULL ELSE service_period_start-$2::interval+interval '1 month' END WHERE subscription_id=$1`,[subId,`${days} days`]],
 [`UPDATE hon.saas_credit_allowances SET period_start=period_start-$2::interval,period_end=period_start-$2::interval+interval '1 month' WHERE subscription_id=$1`,[subId,`${days} days`]]]);
async function payCheckout(who,school,kind='REGULAR_MONTHLY'){
 const co=await start(who,school,offerOf(await options(who,school),kind));
 const paid=sim.completeCheckout(co.checkout.providerSessionId);
 assert.deepEqual(await outcome(paid.completed),['APPLIED','SUBSCRIPTION_ACTIVATED']);
 if(paid.firstInvoice)assert.deepEqual(await outcome(paid.firstInvoice),['ALREADY_APPLIED','FIRST_INVOICE_COVERED_BY_CHECKOUT']);
 return paid;
}
const SCHOOL_EVIDENCE_KEYS=['amountMinor','currency','evidenceId','kind','occurredAt','providerMode','providerVerified','recordedAt','relatedEvidenceId','source'];

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- 0. runtime posture ----------
 for(const t of ['saas_access_program','saas_access_policy_terms'])await sqlDeny(restricted.query(`SELECT * FROM hon.${t}`));
 for(const sig of ['require_saas_school_billing_viewer(text,uuid)','saas_school_invoice_json(uuid,boolean)','saas_access_condition(uuid)','saas_access_shadow(uuid)','saas_entitlement_json(uuid)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);
 for(const sig of ['read_saas_school_billing_account(text,uuid)','read_saas_school_invoices(text,uuid,text,text,timestamptz,uuid,integer)','read_saas_school_invoice(text,uuid,uuid)','read_saas_access_readiness_from_hq(text,uuid)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,true,sig);
 await cleanup();
 // 0184 (D8) closed legacy new sales; this proof exercises them, so it reopens them in this disposable database only.
 await setLegacySales(admin,true);

 // ---------- fixture ----------
 await admin.query('BEGIN');
 if((await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state) VALUES('HIGGSFIELD','Fixture provider','DISABLED') ON CONFLICT DO NOTHING RETURNING provider_id")).rowCount)createdProvider=true;
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[who,hqRole,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['support','HON_HQ_SUPPORT',['hq.billing.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,hqRole,perms]);
 for(const[k,o]of Object.entries(O)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o.id,`B51 Fixture Dojo ${k}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,$2,clock_timestamp()-interval '90 days')",[o.id,o.tier]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'America/New_York')",[o.school,o.id,`School ${k}`]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[o.role,o.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[o.role,o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[o.id,o.school,humans[`owner${k}`].id,o.role]);
 }
 await admin.query('COMMIT');
 const d=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
 d.termsReference='Fixture HON plan terms (not customer terms)';
 d.founderProgram={...d.founderProgram,eligibility:'ANY_ACTIVE_ORGANIZATION',opensAt:iso(NOW-HOUR)};
 const cat=(await billing.publishCatalog(H('owner'),(await billing.createCatalogDraft(H('owner'),d,K())).catalog.catalogId,K())).catalog;
 const offer=(plan,kind)=>cat.offers.find(o=>o.planCode===plan&&o.offerKind===kind);

 // A: registered through HQ provisioning, a second school A2 in the same organization, and a front-desk clerk without billing.hon.view.
 const provisioned=await new HqOnboardingService(database).provisionInitialSchool({externalSubject:H('owner')},{legalName:'Billing Reads Martial Arts LLC',
  displayName:'Billing Reads Martial Arts',schoolName:'Billing Reads Main',schoolSlug:`b51-${randomUUID().slice(0,8)}`,timezone:'America/Chicago',initialTier:'CORE',idempotencyKey:K()});
 A={id:provisioned.organizationId,school:provisioned.schoolId,school2:randomUUID(),clerkRole:randomUUID()};
 // This fixture stands in for a school provisioned before D9 (0185 holds new provisioning SUSPENDED).
 await activatePreD9ProvisionedSchool(admin,provisioned.organizationId);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.role_permissions WHERE role_id=$1 AND permission_code='billing.hon.view'",[provisioned.ownerRoleId])).rows[0].n,1,
  'A newly registered school owner can view their own billing.');
 await admin.query('BEGIN');
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Billing Reads North',$1::text,'America/Chicago')",[A.school2,A.id]);
 for(const[who,school]of [['ownerA',A.school],['ownerA2',A.school2]])
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute')",
   [A.id,school,humans[who].id,provisioned.ownerRoleId,humans.owner.id]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'FRONT_DESK','Front desk',false)",[A.clerkRole,A.id]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions WHERE code NOT IN ('billing.hon.view','billing.hon.purchase')",[A.clerkRole,A.id]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute')",
  [A.id,A.school,humans.clerkA.id,A.clerkRole,humans.owner.id]);
 await admin.query('COMMIT');

 // ---------- 1. owner decisions recorded; the access program cannot be activated ----------
 const policies=Object.fromEntries((await billing.readCatalog(H('operator'))).policies.map(p=>[p.policyCode,p]));
 assert.deepEqual(Object.keys(policies),[...contracts.SAAS_POLICY_CODES]);
 assert.deepEqual([policies.PAYMENT_PROVIDER.status,policies.PAYMENT_PROVIDER.decision,policies.PAYMENT_PROVIDER.version,policies.PAYMENT_PROVIDER.actionsEnabled],['DECIDED','STRIPE_TEST_MODE_ONLY',4,false]);
 assert.deepEqual([policies.PAID_ACCESS.status,policies.PAID_ACCESS.decision,policies.PAID_ACCESS.actionsEnabled],['PROPOSED','HON_RECOMMENDED_TERMS_V1',false]);
 await sqlDeny(admin.query("UPDATE hon.saas_access_program SET status='ACTIVE'"));
 await rejectedWithoutGuards('saas_access_program',"UPDATE hon.saas_access_program SET status='ACTIVE'");
 await rejectedWithoutGuards('saas_access_program',"UPDATE hon.saas_access_program SET mutations_enabled=true");
 await rejectedWithoutGuards('saas_access_policy_terms',"UPDATE hon.saas_access_policy_terms SET status='APPROVED'");
 await rejectedWithoutGuards('saas_access_policy_terms',"UPDATE hon.saas_access_policy_terms SET suspend_after_days=5");
 await sqlDeny(admin.query("DELETE FROM hon.saas_access_policy_terms"));

 // ---------- 2. payments: provider-verified (A, C, D, E, W) and HQ-recorded (B) ----------
 const enable={action:'ENABLE_TEST_MODE',expectedVersion:1,authorizationReference:'Fixture owner test-mode authorization (disposable)',provider:'STRIPE_SIMULATED',
  testTaxReference:'TEST MODE: no tax collected; TAXES undecided (fixture)'};
 await payments.setPaymentProgram(H('owner'),enable,K());
 const paidA=await payCheckout('ownerA',A.school);
 const paidC=await payCheckout('ownerC',O.C.school);
 const paidD=await payCheckout('ownerD',O.D.school);
 const paidE=await payCheckout('ownerE',O.E.school,'FOUNDER_LIFETIME');
 const paidW=await payCheckout('ownerW',O.W.school);
 // Premium AI: the B3 program and the Core allowance for A (the same canonical ledger the school read reports).
 const ev=(await billing.recordCostEvidence(H('owner'),{providerId:'HIGGSFIELD',modelCode:'fixture-image-1',costUnit:'IMAGE',measuredUnits:1000,billedCostMicrounits:40_000_000,
  fullyLoadedCostMicrounits:50_000_000,evidenceReference:'FIXTURE-B51-PROVIDER-1',periodStart:iso(NOW-40*DAY),periodEnd:iso(NOW-10*DAY),note:null},K())).costEvidence;
 const pd=(await billing.createPricingDraft(H('operator'),{termsReference:'Fixture premium pricing (not customer terms)',operations:[{operationCode:'image.generate',
  category:'IMAGE_GENERATION',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,requiredCapability:'ai.premium_metered',costEvidenceId:ev.costEvidenceId}]},K())).pricing;
 await billing.publishPricing(H('owner'),pd.pricingId,K());
 // Before the credit program is active, the allowance reports PROGRAM_INACTIVE with the plan's planned amount.
 let accA=await account('ownerA',A.school);
 assert.deepEqual([accA.allowance.state,accA.allowance.plannedMonthlyCredits,accA.allowance.grantedCredits],['PROGRAM_INACTIVE',5000,null]);
 await billing.setCreditProgram(H('owner'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'Fixture owner authorization (disposable)'},K());
 let subA=await subOf(A.id);
 accA=await account('ownerA',A.school);
 assert.deepEqual([accA.allowance.state,accA.allowance.grantedCredits],['NOT_YET_OPENED',null]);
 // B: HQ-recorded billing (no provider): record the subscription, issue period 0, attest a payment.
 const subB=(await billing.commandSubscription(H('owner'),(await billing.recordSubscription(H('owner'),{source:'CATALOG_OFFER',organizationId:O.B.id,
  offerId:offer('COMPLETE','REGULAR_MONTHLY').offerId,founderReservationId:null},K())).subscription.subscriptionId,{action:'START_SERVICE',expectedVersion:1,reasonCode:'SERVICE_STARTED'},K())).subscription;
 const icmd=(inv,body)=>billing.commandInvoice(H('owner'),inv.invoiceId,{...body,expectedVersion:body.expectedVersion??inv.version},K()).then(r=>r.invoice);
 const issuedFor=async(sub,period)=>{const dr=(await billing.createInvoiceDraft(H('owner'),{subscriptionId:sub,periodIndex:period},K())).invoice;
  return icmd(await icmd(dr,{action:'SET_TAX',treatment:'NO_TAX_APPLICABLE',taxLines:[],verificationReference:'Fixture tax review (not tax advice)'}),{action:'ISSUE'});};
 const b0=await issuedFor(subB.subscriptionId,0);
 const bPay=(await billing.recordPaymentEvidence(H('owner'),b0.invoiceId,{kind:'PAYMENT_RECEIVED',amountMinor:b0.totalMinor,occurredAt:iso(NOW-HOUR),
  reference:'RCPT-INTERNAL-B0',relatedEvidenceId:null,note:'HQ private note: wire received (fixture)'},K())).evidence;
 // A later B period stays a draft: never visible to the school.
 await elapse(subB.subscriptionId,31);
 const subB1=(await billing.commandSubscription(H('owner'),subB.subscriptionId,{action:'ADVANCE_PERIOD',expectedVersion:(await subOf(O.B.id)).version,reasonCode:'PERIOD_ELAPSED'},K())).subscription;
 const bDraft=(await billing.createInvoiceDraft(H('owner'),{subscriptionId:subB.subscriptionId,periodIndex:1},K())).invoice;
 // W disputes; E (lifetime) is refunded in full at the provider, with a B4 guarantee request.
 assert.deepEqual(await outcome(sim.dispute(paidW.paymentIntent,14900)),['APPLIED','CHARGEBACK_RECORDED']);
 const rqE=(await billing.createRefundRequest(H('operator'),{organizationId:O.E.id,requestReceivedAt:iso(Date.now()),customerReference:'Fixture internal ticket 42',note:'HQ private refund note'},K())).refundRequest;
 await billing.decideRefundRequest(H('owner'),rqE.refundRequestId,{decision:'APPROVE',reasonCode:'GUARANTEE_APPROVED',expectedVersion:1,note:null},K());
 assert.deepEqual(await outcome(sim.refund(paidE.paymentIntent,null,357600,paidE.charge)),['APPLIED','REFUND_RECORDED']);
 // A renews twice (three provider-verified invoices for pagination).
 for(let n=0;n<2;n++){
  await elapse(subA.subscriptionId,31);subA=await subOf(A.id);
  assert.deepEqual(await outcome(sim.renewal(paidA.subscription,Date.parse(subA.currentPeriod.endsAt)/1000,14900).delivery),['APPLIED','RENEWAL_RECORDED']);
 }
 subA=await subOf(A.id);
 assert.equal(subA.currentPeriod.index,2);
 // D: period 0 has elapsed and the renewal failed.
 await elapse((await subOf(O.D.id)).subscriptionId,40);
 const subD=await subOf(O.D.id);
 assert.deepEqual(await outcome(sim.renewalFailed(paidD.subscription,Date.parse(subD.currentPeriod.endsAt)/1000,14900)),['APPLIED','RENEWAL_PAYMENT_FAILED']);
 // C: paid, then HQ suspends the entitlement (an existing, non-commercial access decision).
 await withoutGuards([],[["UPDATE hon.organization_entitlements SET status='SUSPENDED',version=version+1 WHERE organization_id=$1",[O.C.id]]]);
 const before=await untouched();

 // ---------- 3. authorization: billing.hon.view at the exact school only ----------
 for(const who of ['owner','operator','support','clerkA','ownerB'])await deny(account(who,A.school),403,'SAAS_FORBIDDEN');
 for(const who of ['owner','operator','support','clerkA','ownerB'])await deny(page(who,A.school),403,'SAAS_FORBIDDEN');
 await deny(account('ownerA',O.B.school),403,'SAAS_FORBIDDEN'); // another organization's school
 await deny(account('ownerA',randomUUID()),403,'SAAS_FORBIDDEN');
 await deny(reads.readAccessReadiness(H('ownerA'),A.id),403,'SAAS_FORBIDDEN'); // the dry run is HQ-only
 await deny(account('ownerA','not-a-uuid'),400,'INVALID_SAAS_INPUT');
 // A role named for a family/platform identity never qualifies, even holding the permission.
 await admin.query("UPDATE hon.roles SET code='PARENT_PORTAL' WHERE id=$1",[A.clerkRole]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.hon.view')",[A.clerkRole,A.id]);
 await deny(account('clerkA',A.school),403,'SAAS_FORBIDDEN');
 await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='billing.hon.view'",[A.clerkRole]);
 await admin.query("UPDATE hon.roles SET code='FRONT_DESK' WHERE id=$1",[A.clerkRole]);
 // A revoked grant is refused at once.
 await admin.query("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$3 WHERE principal_id=$1 AND school_id=$2",[humans.ownerA2.id,A.school2,humans.owner.id]);
 await deny(account('ownerA2',A.school2),403,'SAAS_FORBIDDEN');
 await admin.query("UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE principal_id=$1 AND school_id=$2",[humans.ownerA2.id,A.school2]);

 // ---------- 4. organization-level billing: both schools of A see the same records ----------
 accA=await account('ownerA',A.school);
 const accA2=await account('ownerA2',A.school2);
 assert.deepEqual([accA.organizationId,accA.billingScope,accA.schoolCount,accA2.organizationId,accA2.schoolId],[A.id,'ORGANIZATION',2,A.id,A.school2]);
 assert.deepEqual((await page('ownerA2',A.school2)).invoices,(await page('ownerA',A.school)).invoices);

 // ---------- 5. complete, stable pagination (newest issued first) ----------
 // Two of A's invoices share one issue millisecond (and differ below it): the page boundary falls between them.
 await withoutGuards(['saas_invoices'],[["UPDATE hon.saas_invoices SET issued_at=date_trunc('milliseconds',(SELECT max(issued_at) FROM hon.saas_invoices WHERE organization_id=$1))+CASE WHEN id=(SELECT min(id::text)::uuid FROM hon.saas_invoices WHERE organization_id=$1) THEN interval '900 microseconds' ELSE interval '100 microseconds' END WHERE organization_id=$1 AND period_index IN (1,2)",[A.id]]]);
 const dbIds=(await admin.query("SELECT id FROM hon.saas_invoices WHERE organization_id=$1 AND status IN ('ISSUED','VOID') ORDER BY date_trunc('milliseconds',issued_at) DESC, id DESC",[A.id])).rows.map(r=>r.id);
 assert.equal((await admin.query("SELECT count(DISTINCT date_trunc('milliseconds',issued_at))::int n FROM hon.saas_invoices WHERE organization_id=$1",[A.id])).rows[0].n,2);
 assert.equal(dbIds.length,3);
 const walked=[];let cursor=null,pages=0;
 do{
  const p=await page('ownerA',A.school,{limit:'1',...(cursor?{cursor:contracts.encodeSaasSchoolInvoiceCursor(cursor)}:{})});
  walked.push(...p.invoices.map(i=>i.invoiceId));cursor=p.nextCursor;pages++;
  if(pages===1){ // a new invoice issued mid-walk never shifts the remaining pages (keyset on immutable issued_at, id)
   await elapse(subA.subscriptionId,31);subA=await subOf(A.id);
   assert.deepEqual(await outcome(sim.renewal(paidA.subscription,Date.parse(subA.currentPeriod.endsAt)/1000,14900).delivery),['APPLIED','RENEWAL_RECORDED']);
  }
 }while(cursor&&pages<10);
 assert.deepEqual(walked,dbIds,'every invoice exactly once, in order, despite a concurrent insert');
 const all=await page('ownerA',A.school,{limit:'100'});
 assert.equal(all.invoices.length,4);assert.equal(all.nextCursor,null);
 // The current period's Core allowance is opened and two images are reserved (B3 commands, before the read-only block).
 await billing.commandAllowance(H('operator'),{action:'OPEN_CURRENT',subscriptionId:subA.subscriptionId},K());
 const reservation=(await billing.reservePremiumCredits(H('ownerA'),A.school,{operationCode:'image.generate',units:2,employeeKey:null,actionRequestId:null,workItemId:null},K())).reservation;
 const writesBefore=await writes();
 assert.deepEqual((await page('ownerA',A.school,{status:'VOID'})).invoices,[]);
 assert.deepEqual((await page('ownerA',A.school,{kind:'LIFETIME_PURCHASE'})).invoices,[]);
 assert.equal((await page('ownerE',O.E.school,{kind:'LIFETIME_PURCHASE'})).invoices.length,1);
 for(const bad of [{limit:'0'},{limit:'101'},{limit:'abc'},{status:'DRAFT'},{kind:'X'},{cursor:'nope'},{cursor:`${iso(NOW)}~not-uuid`},{other:'1'},{status:['ISSUED','VOID']}])
  await deny(page('ownerA',A.school,bad),400,'INVALID_SAAS_INPUT');

 // ---------- 6. invoice detail: provider-verified; drafts, notes and references never visible ----------
 const newest=all.invoices[0];
 const a0=await detail('ownerA',A.school,all.invoices.at(-1).invoiceId);
 assert.deepEqual([a0.status,a0.periodIndex,a0.totalMinor,a0.taxStatus,a0.settlement.state,a0.paymentVerification,a0.lines.length,a0.lines[0].lineKind,a0.refunds.length],
  ['ISSUED',0,14900,'NO_TAX_APPLICABLE','PAID_VERIFIED','PROVIDER_VERIFIED',1,'PLAN_FEE',0]);
 assert.deepEqual(Object.keys(a0.evidence[0]).sort(),SCHOOL_EVIDENCE_KEYS);
 assert.deepEqual([a0.evidence[0].source,a0.evidence[0].providerVerified,a0.evidence[0].providerMode],['PROVIDER_VERIFIED',true,'TEST']);
 assert.equal(JSON.stringify(a0).includes('taxVerificationReference'),false);
 assert.equal(JSON.stringify(a0).includes(enable.testTaxReference),false,'internal tax references are not shown to schools');
 assert.equal((await detail('ownerA2',A.school2,newest.invoiceId)).invoiceId,newest.invoiceId);
 // HQ-recorded: B sees its attested payment as HQ_RECORDED, without the HQ note or reference.
 const bd=await detail('ownerB',O.B.school,b0.invoiceId);
 assert.deepEqual([bd.settlement.state,bd.paymentVerification,bd.evidence[0].source,bd.evidence[0].providerVerified,bd.evidence[0].providerMode],['PAID_ATTESTED','HQ_RECORDED','HQ_ATTESTATION',false,null]);
 assert.equal(JSON.stringify(bd).includes('HQ private note'),false);assert.equal(JSON.stringify(bd).includes('RCPT-INTERNAL-B0'),false);
 assert.deepEqual((await page('ownerB',O.B.school)).invoices.map(i=>i.invoiceId),[b0.invoiceId],'the draft is not listed');
 for(const[who,school,inv]of [['ownerB',O.B.school,bDraft.invoiceId],['ownerA',A.school,b0.invoiceId],['ownerB',O.B.school,newest.invoiceId],['ownerA',A.school,randomUUID()]])
  await deny(detail(who,school,inv),404,'SAAS_UNAVAILABLE'); // drafts, other organizations and missing ids look the same
 // Refunds and chargebacks.
 const e0=(await page('ownerE',O.E.school)).invoices[0];
 const ed=await detail('ownerE',O.E.school,e0.invoiceId);
 assert.deepEqual([ed.kind,ed.offerKind,ed.settlement.refundedMinor,ed.settlement.state,ed.paymentVerification,ed.evidence.map(e=>e.kind)],
  ['LIFETIME_PURCHASE','FOUNDER_LIFETIME',357600,'REVERSED','NONE',['PAYMENT_RECEIVED','REFUND']]);
 assert.deepEqual([ed.refunds.length,ed.refunds[0].status,ed.refunds[0].execution,ed.refunds[0].refundEvidencedMinor],[1,'APPROVED','UNAVAILABLE',357600]);
 assert.equal(JSON.stringify(ed).includes('Fixture internal ticket 42'),false);assert.equal(JSON.stringify(ed).includes('HQ private refund note'),false);
 const wd=await detail('ownerW',O.W.school,(await page('ownerW',O.W.school)).invoices[0].invoiceId);
 assert.deepEqual([wd.settlement.chargedBackMinor,wd.evidence.map(e=>[e.kind,e.source])],[14900,[['PAYMENT_RECEIVED','PROVIDER_VERIFIED'],['CHARGEBACK','PROVIDER_VERIFIED']]]);

 // ---------- 7. account: entitlement, activation, payment standing and allowance from canonical records ----------
 accA=await account('ownerA',A.school);
 const credits=await billing.readSchoolCredits(H('ownerA'),A.school);
 assert.deepEqual([accA.entitlement.tier,accA.entitlement.inEffect,accA.access.source,accA.access.paymentActivated,accA.access.paidAccessProgram,accA.access.activation,accA.access.alignment],
  ['CORE',true,'PROVISIONED',false,'INACTIVE','READY','ALIGNED']);
 assert.deepEqual([accA.subscription.subscriptionId,accA.subscription.planCode,accA.payment.status,accA.payment.verification,accA.payment.providerVerification,accA.payment.verified.paidInvoiceCount],
  [subA.subscriptionId,'CORE','PAID','PROVIDER_VERIFIED','TEST_MODE',4]);
 assert.deepEqual([accA.allowance.state,accA.allowance.basis,accA.allowance.grantedCredits,accA.allowance.reservedCredits,accA.allowance.remainingCredits],
  ['AVAILABLE','REGULAR',5000,20,4980]);
 assert.deepEqual([accA.allowance.period.index,accA.allowance.remainingCredits],[credits.currentAllowance.periodIndex,credits.currentAllowance.balance.availableCredits],'one source of truth: the B3 ledger');
 assert.ok(accA.subscriptionHistory.length>=3 && accA.subscriptionHistory.every((h,n)=>h.version===n+1));
 assert.deepEqual(accA.subscriptions.map(s=>[s.planCode,s.offerKind,s.priceMinor,s.catalogVersion]),[['CORE','REGULAR_MONTHLY',14900,cat.catalogVersion]]);
 // C paid, but its entitlement is suspended: the payment does not make the account ready, and billing stays readable.
 const accC=await account('ownerC',O.C.school);
 assert.deepEqual([accC.payment.status,accC.entitlement.status,accC.entitlement.inEffect,accC.access.activation,accC.allowance.state],['PAID','SUSPENDED',false,'PENDING_ACCOUNT_ACTIVATION','ACCESS_NOT_ACTIVE']);
 await deny(billing.readSchoolCredits(H('ownerC'),O.C.school),403,'SAAS_FORBIDDEN'); // premium AI already requires an active entitlement
 // D: unpaid since its paid period ended.
 const accD=await account('ownerD',O.D.school);
 assert.deepEqual([accD.payment.status,accD.access.activation,accD.payment.unpaidSince!==null],['PAST_DUE','READY',true]);
 // F: provisioned only.
 const accF=await account('ownerF',O.F.school);
 assert.deepEqual([accF.subscription,accF.access.alignment,accF.access.activation,accF.payment.status,accF.allowance.state,accF.subscriptions],[null,'NO_SUBSCRIPTION','READY','NOT_BILLED','NO_SUBSCRIPTION',[]]);
 // B HQ-attested: verification is HQ_ATTESTED, never provider-verified.
 const accB=await account('ownerB',O.B.school);
 assert.deepEqual([accB.payment.verification,accB.payment.verified.paidInvoiceCount,accB.payment.recorded.paidInvoiceCount],[subB1.paymentStatus==='PAID'?'HQ_ATTESTED':'NONE',0,1]);
 assert.deepEqual([(await account('ownerE',O.E.school)).refunds.length,(await account('ownerE',O.E.school)).payment.status],[1,'REFUNDED']);
 assert.equal((await account('ownerW',O.W.school)).payment.status,'DISPUTED');

 // ---------- 8. B6 dry run (HQ only): proposed terms, enforcement NONE ----------
 const shadow=async org=>{const r=await dryRun(org);return [r.dryRun.wouldBeState,r.dryRun.reason,r.dryRun.enforcement];};
 const rA=await dryRun(A.id);
 assert.deepEqual([rA.program.status,rA.program.mutationsEnabled,rA.proposedTerms.status,rA.proposedTerms.graceDays,rA.proposedTerms.suspendAfterDays,rA.dryRun.wouldBeState],
  ['INACTIVE',false,'PROPOSED',7,21,'ACTIVE']);
 assert.deepEqual(await shadow(O.F.id),['ACTIVE','PROVISIONED_WITHOUT_SUBSCRIPTION','NONE']);
 assert.deepEqual(await shadow(O.E.id),['ENDED','REFUNDED','NONE']);
 assert.deepEqual(await shadow(O.W.id),['SUSPENDED','DISPUTE_OPEN','NONE']);
 // D: about 10 days unpaid (40 days since its start, minus its paid month) is past the 7-day grace: RESTRICTED; 14 days later SUSPENDED.
 const rD=await dryRun(O.D.id);
 const daysD=Math.floor((Date.now()-Date.parse(rD.dryRun.condition.unpaidSince))/DAY);
 assert.ok(daysD>7&&daysD<=21,String(daysD));
 assert.deepEqual([rD.dryRun.wouldBeState,rD.dryRun.daysUnpaid,rD.dryRun.premiumAiWouldBeSuspended,rD.dryRun.condition.paymentStatus],['RESTRICTED',daysD,true,'PAST_DUE']);
 assert.deepEqual(await writes(),writesBefore,'school reads and the dry run write nothing');
 await elapse(subD.subscriptionId,14);
 const rD2=await dryRun(O.D.id);
 // Calendar months differ in length, so the shifted paid period ends 13-14 days earlier.
 assert.deepEqual([rD2.dryRun.wouldBeState,rD2.dryRun.daysUnpaid>21,rD2.dryRun.daysUnpaid-daysD>=13],['SUSPENDED',true,true]);
 await deny(dryRun(randomUUID()),404,'SAAS_UNAVAILABLE');
 await deny(reads.readAccessReadiness(H('support'),A.id),403,'SAAS_FORBIDDEN');

 // ---------- 9. nothing changed: entitlements, family billing, audit/outbox, programs ----------
 const after=await untouched();
 for(const t of Object.keys(before))assert.deepEqual(after[t],before[t],t);
 assert.deepEqual((await admin.query("SELECT tier::text,status::text FROM hon.organization_entitlements WHERE organization_id=$1",[A.id])).rows[0],{tier:'CORE',status:'ACTIVE'});
 assert.equal(reservation.status,'RESERVED');
 console.log('PASS: HON school billing reads B5.1 (simulated Stripe + HQ attestation) — billing.hon.view at the exact school (HQ, support, clerk, family-named role, revoked grant and other organizations refused); organization-level billing across two schools; complete keyset pagination stable under a concurrent invoice; drafts, HQ notes and internal references hidden; provider-verified versus HQ-recorded payments; refunds and chargebacks; entitlement, activation (never from payment) and B3 allowance from canonical records; HQ dry run of the proposed paid-access terms (ACTIVE, RESTRICTED, SUSPENDED, ENDED) with enforcement NONE; access program cannot be activated; no write.');
}finally{
 await setLegacySales(admin,false).catch(e=>console.error('RESTORE FAILED',e));
 await cleanup().catch(e=>console.error('cleanup failed',e.message));
 await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy?.()]);
}
