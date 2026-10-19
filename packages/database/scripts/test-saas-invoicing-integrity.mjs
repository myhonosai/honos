import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// HON Subscription Billing B2 (0155) integrity proof through the real API service on a disposable
// database: HON-to-school invoices (gapless numbering, adjustments, owner-verified tax, issue, void),
// append-only HQ-attested payment evidence (payments, refunds, chargebacks), payment standing for
// future Champions qualification (verified vs recorded), recorded owner decisions that enable nothing,
// and no effect on subscriptions, founder inventory, entitlements, school billing or Champions.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const contracts=await import('@hon/contracts');
const api=new SaasBillingService(new RuntimeDatabaseService());
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const saasTables=['saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions','saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions','saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions'];
const b2Tables=['saas_policy_records','saas_invoice_sequences','saas_invoices','saas_invoice_lines','saas_payment_evidence'];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code='42501')=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
// A Core monthly, B Complete founder lifetime, C legacy Essential, D Core not started, E Core monthly.
const O=Object.fromEntries(['A','B','C','D','E'].map(k=>[k,{id:randomUUID(),tier:{A:'CORE',B:'COMPLETE',C:'ESSENTIAL',D:'CORE',E:'CORE'}[k]}]));
const humans=Object.fromEntries(['owner','operator','support','staff'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`invoice-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
let commands=0;const ok=async p=>{const r=await p;if(!r.replayed)commands++;return r;};
async function untouched(){const out={};for(const t of ['organization_entitlements','billing_accounts','memberships','invoices','membership_payment_schedules','ai_usage_ledger','champions_reward_entries','champions_attributions','audit_events','outbox_events'])out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t ORDER BY 1`)).rows.map(r=>r.r);return out;}
const rows=async t=>(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t ORDER BY 1`)).rows.map(r=>r.r);
async function rejectedWithoutGuards(table,sql,params=[],code='23514'){
 await admin.query('BEGIN');
 try{await admin.query(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);await sqlDeny(admin.query(sql,params),code);}finally{await admin.query('ROLLBACK');}
}
async function withoutGuards(table,sql,params=[]){
 await admin.query('BEGIN');
 try{await admin.query(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);await admin.query(sql,params);await admin.query(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);await admin.query('COMMIT');}
 catch(e){await admin.query('ROLLBACK');throw e;}
}
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of saasTables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of saasTables)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of saasTables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  const orgIds=Object.values(O).map(o=>o.id),principalIds=Object.values(humans).map(h=>h.id);
  await admin.query('DELETE FROM hon.organization_entitlements WHERE organization_id=ANY($1::uuid[])',[orgIds]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.principal_role_grants WHERE principal_id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.roles WHERE organization_id=ANY($1::uuid[])',[orgIds]);
  await admin.query('DELETE FROM hon.schools WHERE organization_id=ANY($1::uuid[])',[orgIds]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgIds]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const draft=(subscriptionId,periodIndex,who='owner',key=K())=>api.createInvoiceDraft(H(who),{subscriptionId,periodIndex},key);
const icmd=(invoice,body,who='owner',key=K())=>api.commandInvoice(H(who),invoice.invoiceId,{...body,expectedVersion:body.expectedVersion??invoice.version},key);
const noTax=invoice=>icmd(invoice,{action:'SET_TAX',treatment:'NO_TAX_APPLICABLE',taxLines:[],verificationReference:'Fixture tax review TR-1 (not tax advice)'});
const issue=invoice=>icmd(invoice,{action:'ISSUE'});
const pay=(invoice,amountMinor,occurredAt,reference,extra={},who='owner')=>api.recordPaymentEvidence(H(who),invoice.invoiceId,
 {kind:'PAYMENT_RECEIVED',amountMinor,occurredAt,reference,relatedEvidenceId:null,note:null,...extra},K());
const standing=org=>api.readPaymentStanding(H('operator'),org);

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- runtime posture ----------
 for(const t of b2Tables)await sqlDeny(restricted.query(`SELECT * FROM hon.${t}`));
 for(const sig of ['saas_invoice_facts(uuid,uuid)','saas_payment_standing(uuid)','saas_invoice_json(uuid,boolean)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);

 // ---------- fixture: catalog, founder reservation, subscriptions ----------
 await cleanup();
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[k,o]of Object.entries(O)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o.id,`Invoice Fixture Dojo ${k}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,$2,clock_timestamp()-interval '90 days')",[o.id,o.tier]);
 }
 const school=randomUUID(),role=randomUUID();
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Fixture School',$1::text,'America/New_York')",[school,O.A.id]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'OWNER_STAFF','Fixture role')",[role,O.A.id]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[O.A.id,school,humans.staff.id,role]);
 for(const[who,hqRole,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['support','HON_HQ_SUPPORT',['hq.billing.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,hqRole,perms]);
 await admin.query('COMMIT');
 const d=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
 assert.equal(d.founderProgram.reservationHoldDays,1);
 d.termsReference='Fixture HON plan terms v1 (not customer terms)';d.founderProgram={...d.founderProgram,eligibility:'ANY_ACTIVE_ORGANIZATION',opensAt:iso(NOW-HOUR)};
 const cat=(await api.publishCatalog(H('owner'),(await api.createCatalogDraft(H('owner'),d,K())).catalog.catalogId,K())).catalog;
 const offer=(plan,kind)=>cat.offers.find(o=>o.planCode===plan&&o.offerKind===kind).offerId;
 const res=(await api.reserveFounder(H('owner'),{organizationId:O.B.id,offerId:offer('COMPLETE','FOUNDER_LIFETIME')},K())).reservation;
 const rec=input=>api.recordSubscription(H('owner'),input,K()).then(r=>r.subscription);
 const start=s=>api.commandSubscription(H('owner'),s.subscriptionId,{action:'START_SERVICE',expectedVersion:s.version,reasonCode:'SERVICE_STARTED'},K()).then(r=>r.subscription);
 let sA=await start(await rec({source:'CATALOG_OFFER',organizationId:O.A.id,offerId:offer('CORE','REGULAR_MONTHLY'),founderReservationId:null}));
 const sB=await start(await rec({source:'CATALOG_OFFER',organizationId:O.B.id,offerId:offer('COMPLETE','FOUNDER_LIFETIME'),founderReservationId:res.reservationId}));
 const sC=await start(await rec({source:'LEGACY_ENTITLEMENT',organizationId:O.C.id}));
 // Elapse A's first period (fixture only) so period 1 can be invoiced.
 await withoutGuards('saas_subscriptions',`UPDATE hon.saas_subscriptions SET service_started_at=service_started_at-interval '40 days',period_anchor_at=period_anchor_at-interval '40 days',
  current_period_start=current_period_start-interval '40 days',current_period_end=current_period_start-interval '40 days'+interval '1 month' WHERE id=$1`,[sA.subscriptionId]);
 sA=(await api.commandSubscription(H('owner'),sA.subscriptionId,{action:'ADVANCE_PERIOD',expectedVersion:sA.version,reasonCode:'PERIOD_ELAPSED'},K())).subscription;
 const sD=await rec({source:'CATALOG_OFFER',organizationId:O.D.id,offerId:offer('CORE','REGULAR_MONTHLY'),founderReservationId:null});
 const sE=await start(await rec({source:'CATALOG_OFFER',organizationId:O.E.id,offerId:offer('CORE','REGULAR_MONTHLY'),founderReservationId:null}));
 const before=await untouched();
 const evidenceBaseline=(await admin.query('SELECT count(*)::int n FROM hon.saas_requests')).rows[0].n;

 // ---------- 1. recorded owner decisions enable nothing ----------
 const policies=Object.fromEntries((await api.readCatalog(H('operator'))).policies.map(p=>[p.policyCode,p]));
 assert.deepEqual(Object.keys(policies),[...contracts.SAAS_POLICY_CODES]);
 assert.ok(Object.values(policies).every(p=>p.actionsEnabled===false));
 for(const[code,status,decision]of [['CREDIT_ROLLOVER','DECIDED','NO_ROLLOVER'],['TOP_UP_PRICING','DECIDED','TWICE_VERIFIED_PROVIDER_COST'],
  ['FOUNDER_SLOT_RETURN','DECIDED','EXPIRED_UNPAID_RETURN_ACTIVATED_RETAINED'],['REFUND_GUARANTEE','DECIDED','FIRST_PURCHASE_30_DAY_FULL_REFUND_ALL_OFFERS'],
  ['FOUNDER_PROGRAM','DECIDED','FIFTY_TOTAL_THIRTY_MONTHLY_TWENTY_LIFETIME_ONE_PER_ORGANIZATION'],['FOUNDER_ALLOWANCE','DECIDED','FULL_MONTHLY_PLAN_ALLOWANCE'],
  ['CANCELLATION_TIMING','PROPOSED','END_OF_PAID_PERIOD'],['PLAN_CHANGE_TIMING','PROPOSED','BILLING_PERIOD_BOUNDARY'],['PRORATION','PROPOSED','NO_AUTOMATIC_PRORATION'],
  ['FOUNDER_RESERVATION_HOLD','PROPOSED','ONE_DAY'],['TAXES','UNDECIDED',null],['ANNUAL_BILLING','UNDECIDED',null],['REFUND_EXECUTION','UNDECIDED',null],['PAYMENT_PROVIDER','PROPOSED','STRIPE_TEST_MODE_ADAPTER']])
  assert.deepEqual([policies[code].status,policies[code].decision],[status,decision],code);
 await deny(api.commandSubscription(H('owner'),sA.subscriptionId,{action:'CANCEL',expectedVersion:sA.version,reasonCode:'SCHOOL_REQUEST'},K()),422,'SAAS_POLICY_UNDECIDED');
 await deny(api.commandSubscription(H('owner'),sA.subscriptionId,{action:'CHANGE_OFFER',expectedVersion:sA.version,reasonCode:'SCHOOL_REQUEST',offerId:offer('COMPLETE','REGULAR_MONTHLY')},K()),422,'SAAS_POLICY_UNDECIDED');
 const annual=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);annual.offers.splice(5,1,{planCode:'COMPLETE',offerKind:'FOUNDER_ANNUAL',priceMinor:150000});
 await deny(api.createCatalogDraft(H('owner'),annual,K()),422,'SAAS_POLICY_UNDECIDED');

 // ---------- 2. drafts ----------
 for(const who of ['support','staff'])await deny(draft(sA.subscriptionId,0,who),403,'SAAS_FORBIDDEN');
 await deny(draft(sC.subscriptionId,null),422,'SAAS_INVOICE_NOT_BILLABLE'); // legacy: no price
 await deny(draft(sD.subscriptionId,0),422,'SAAS_INVOICE_NOT_BILLABLE'); // service not started
 await deny(draft(sA.subscriptionId,2),422,'SAAS_INVOICE_PERIOD_NOT_STARTED');
 await deny(draft(sA.subscriptionId,null),400,'INVALID_SAAS_INPUT');
 await deny(draft(sB.subscriptionId,0),400,'INVALID_SAAS_INPUT');
 await deny(draft(randomUUID(),0),404,'SAAS_UNAVAILABLE');
 const kA=K();
 let a0=(await ok(draft(sA.subscriptionId,0,'operator',kA))).invoice;
 assert.deepEqual([a0.status,a0.invoiceNumber,a0.taxStatus,a0.taxMinor,a0.totalMinor,a0.subtotalMinor,a0.delivery,a0.collection,a0.settlement.state,a0.settlement.balanceMinor],
  ['DRAFT',null,'UNRESOLVED',null,null,14900,'NOT_SENT','DISABLED','NOT_ISSUED',null]);
 assert.deepEqual(a0.lines.map(l=>[l.lineKind,l.amountMinor]),[['PLAN_FEE',14900]]);assert.match(a0.description,/^HON Core — monthly — service period \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
 const anchor=new Date(sA.serviceStartedAt),month=n=>{const x=new Date(anchor);x.setUTCMonth(x.getUTCMonth()+n);return x.toISOString();};
 assert.deepEqual(a0.servicePeriod,{startsAt:month(0),endsAt:month(1)});assert.equal(sA.currentPeriod.index,1);
 assert.equal((await draft(sA.subscriptionId,0,'operator',kA)).replayed,true);
 await deny(draft(sA.subscriptionId,0),422,'SAAS_INVOICE_EXISTS');
 let b0=(await ok(draft(sB.subscriptionId,null))).invoice;
 assert.deepEqual([b0.kind,b0.periodIndex,b0.subtotalMinor,b0.offerKind,b0.servicePeriod.endsAt],['LIFETIME_PURCHASE',null,357600,'FOUNDER_LIFETIME',null]);
 assert.match(b0.description,/^HON Complete — founder paid lifetime — one-time purchase$/);
 await deny(draft(sB.subscriptionId,null),422,'SAAS_INVOICE_EXISTS');

 // ---------- 3. adjustments, verified tax, issue ----------
 await deny(issue(a0),422,'SAAS_INVOICE_TAX_UNRESOLVED');
 await deny(icmd(a0,{action:'ISSUE'},'operator'),403,'SAAS_FORBIDDEN');
 await deny(icmd(a0,{action:'SET_TAX',treatment:'NO_TAX_APPLICABLE',taxLines:[],verificationReference:'x'},'operator'),403,'SAAS_FORBIDDEN');
 a0=(await ok(icmd(a0,{action:'ADD_ADJUSTMENT',adjustment:{kind:'DISCOUNT',amountMinor:-1000,description:'Fixture onboarding discount',reference:'DISC-1'}},'operator'))).invoice;
 assert.deepEqual([a0.subtotalMinor,a0.version,a0.lines.length],[13900,2,2]);
 await deny(icmd(a0,{action:'ADD_ADJUSTMENT',adjustment:{kind:'CORRECTION',amountMinor:-20000,description:'Too large',reference:null}}),422,'SAAS_INVOICE_NEGATIVE_TOTAL');
 await deny(icmd(a0,{action:'ISSUE',expectedVersion:1}),409,'SAAS_VERSION_CONFLICT');
 a0=(await ok(noTax(a0))).invoice;
 assert.deepEqual([a0.taxStatus,a0.taxMinor,a0.totalMinor,a0.taxVerificationReference],['NO_TAX_APPLICABLE',0,13900,'Fixture tax review TR-1 (not tax advice)']);
 await deny(icmd(a0,{action:'ADD_ADJUSTMENT',adjustment:{kind:'DISCOUNT',amountMinor:-1,description:'Late',reference:null}}),409,'SAAS_TRANSITION_NOT_ALLOWED');
 await deny(noTax(a0),409,'SAAS_TRANSITION_NOT_ALLOWED');
 a0=(await ok(issue(a0))).invoice;
 const year=new Date().getUTCFullYear();
 assert.equal(a0.status,'ISSUED');assert.equal(a0.invoiceNumber,`HON-${year}-000001`);assert.equal(a0.settlement.state,'UNPAID');assert.equal(a0.settlement.balanceMinor,13900);
 await deny(issue(a0),409,'SAAS_TRANSITION_NOT_ALLOWED');
 b0=(await ok(icmd(b0,{action:'SET_TAX',treatment:'TAX_LINES',taxLines:[{jurisdiction:'Fixture State',amountMinor:1234}],verificationReference:'Fixture tax review TR-2'}))).invoice;
 assert.deepEqual([b0.taxMinor,b0.totalMinor,b0.lines.at(-1).lineKind],[1234,357600+1234,'TAX']);
 b0=(await ok(issue(b0))).invoice;assert.equal(b0.invoiceNumber,`HON-${year}-000002`);
 // A void draft never consumes a number; concurrent issues get distinct consecutive numbers.
 let e0=(await ok(draft(sE.subscriptionId,0))).invoice;
 const v=(await ok(icmd(e0,{action:'VOID',reasonCode:'ISSUED_IN_ERROR'}))).invoice;assert.deepEqual([v.status,v.invoiceNumber],['VOID',null]);
 e0=(await ok(noTax((await ok(draft(sE.subscriptionId,0))).invoice))).invoice;
 let a1=(await ok(noTax((await ok(draft(sA.subscriptionId,1))).invoice))).invoice;
 const both=await Promise.all([issue(a1),issue(e0)]);commands+=2;
 assert.deepEqual(both.map(r=>r.invoice.invoiceNumber).sort(),[`HON-${year}-000003`,`HON-${year}-000004`]);
 [a1,e0]=both.map(r=>r.invoice);
 assert.deepEqual(a1.servicePeriod,{startsAt:month(1),endsAt:month(2)});

 // ---------- 4. payment evidence (HQ attestation only) ----------
 await deny(pay(a0,1000,iso(NOW-DAY),'RCPT-0',{},'operator'),403,'SAAS_FORBIDDEN');
 await deny(pay(a0,1000,iso(NOW+DAY),'RCPT-F'),422,'SAAS_EVIDENCE_IN_FUTURE');
 const p1=(await ok(pay(a0,5000,iso(NOW-3*DAY),'RCPT-1'))).evidence;
 assert.deepEqual([p1.source,p1.providerVerified,p1.kind],['HQ_ATTESTATION',false,'PAYMENT_RECEIVED']);
 let inv=await api.readInvoice(H('operator'),a0.invoiceId);assert.deepEqual([inv.settlement.state,inv.settlement.balanceMinor,inv.settlement.verifiedNetMinor],['PARTIALLY_PAID',8900,0]);
 await deny(pay(a0,9000,iso(NOW-DAY),'RCPT-2'),422,'SAAS_PAYMENT_EXCEEDS_BALANCE');
 await deny(pay(a0,100,iso(NOW-DAY),'RCPT-1'),422,'SAAS_EVIDENCE_DUPLICATE_REFERENCE');
 await deny(api.recordPaymentEvidence(H('owner'),a0.invoiceId,{kind:'PAYMENT_RECEIVED',amountMinor:100,occurredAt:iso(NOW-DAY),reference:'RCPT-S',relatedEvidenceId:null,note:null,source:'PROVIDER_VERIFIED'},K()),400,'INVALID_SAAS_INPUT');
 await sqlDeny(restricted.query('SELECT hon.record_saas_payment_evidence($1,$2,$3::jsonb,$4,$5,$6)',[H('owner'),a0.invoiceId,
  JSON.stringify({kind:'PAYMENT_RECEIVED',amountMinor:100,occurredAt:iso(NOW-DAY),reference:'RCPT-S',relatedEvidenceId:null,note:null,source:'PROVIDER_VERIFIED'}),K(),K(),K()]),'22023');
 const p2=(await ok(pay(a0,8900,iso(NOW-2*DAY),'RCPT-2',{note:'Bank transfer seen in HQ statement (fixture)'}))).evidence;
 inv=await api.readInvoice(H('operator'),a0.invoiceId);assert.deepEqual([inv.settlement.state,inv.settlement.balanceMinor,inv.evidence.length],['PAID_ATTESTED',0,2]);
 let st=await standing(O.A.id);
 assert.deepEqual(st.verified,{firstPaidAt:null,paidThroughAt:null,lifetimePaid:false,paidInvoiceCount:0,refundedInvoiceCount:0,chargebackInvoiceCount:0});
 assert.deepEqual([st.recorded.paidInvoiceCount,st.recorded.firstPaidAt,st.recorded.paidThroughAt],[1,p2.occurredAt,a0.servicePeriod.endsAt]);
 assert.deepEqual([st.evidence,st.championsPaymentSource,st.providerVerification,st.subscriptionId],[{hqAttested:2,providerVerified:0},'NOT_CONNECTED','NOT_CONFIGURED',sA.subscriptionId]);
 await ok(pay(a1,a1.totalMinor,iso(NOW-HOUR),'RCPT-3'));
 st=await standing(O.A.id);assert.deepEqual([st.recorded.paidInvoiceCount,st.recorded.paidThroughAt],[2,a1.servicePeriod.endsAt]);
 // Refunds and chargebacks reduce standing; they never exceed the payment they reverse.
 await deny(api.recordPaymentEvidence(H('owner'),a0.invoiceId,{kind:'REFUND',amountMinor:6000,occurredAt:iso(NOW-HOUR),reference:'RF-1',relatedEvidenceId:p1.evidenceId,note:null},K()),422,'SAAS_REVERSAL_EXCEEDS_PAYMENT');
 await deny(api.recordPaymentEvidence(H('owner'),a0.invoiceId,{kind:'REFUND',amountMinor:100,occurredAt:iso(NOW-5*DAY),reference:'RF-0',relatedEvidenceId:p1.evidenceId,note:null},K()),422,'SAAS_EVIDENCE_BEFORE_PAYMENT');
 await deny(api.recordPaymentEvidence(H('owner'),b0.invoiceId,{kind:'REFUND',amountMinor:100,occurredAt:iso(NOW-HOUR),reference:'RF-X',relatedEvidenceId:p1.evidenceId,note:null},K()),422,'SAAS_EVIDENCE_RELATED_MISMATCH');
 await deny(api.recordPaymentEvidence(H('owner'),a0.invoiceId,{kind:'REFUND',amountMinor:100,occurredAt:iso(NOW-HOUR),reference:'RF-N',relatedEvidenceId:null,note:null},K()),400,'INVALID_SAAS_INPUT');
 await ok(api.recordPaymentEvidence(H('owner'),a0.invoiceId,{kind:'REFUND',amountMinor:5000,occurredAt:iso(NOW-HOUR),reference:'RF-1',relatedEvidenceId:p1.evidenceId,note:'First-purchase guarantee refund made outside HON (fixture)'},K()));
 await deny(api.recordPaymentEvidence(H('owner'),a0.invoiceId,{kind:'CHARGEBACK',amountMinor:1,occurredAt:iso(NOW-HOUR),reference:'CB-0',relatedEvidenceId:p1.evidenceId,note:null},K()),422,'SAAS_REVERSAL_EXCEEDS_PAYMENT');
 inv=await api.readInvoice(H('operator'),a0.invoiceId);assert.deepEqual([inv.settlement.state,inv.settlement.netMinor,inv.settlement.refundedMinor,inv.settlement.balanceMinor],['PARTIALLY_PAID',8900,5000,5000]);
 st=await standing(O.A.id);
 assert.deepEqual([st.recorded.paidInvoiceCount,st.recorded.refundedInvoiceCount,st.recorded.paidThroughAt],[1,1,null]); // period 0 no longer paid
 assert.equal(st.verified.refundedInvoiceCount,0);
 // Lifetime: paid then fully charged back.
 const bp=(await ok(pay(b0,b0.totalMinor,iso(NOW-2*DAY),'WIRE-77'))).evidence;
 st=await standing(O.B.id);assert.deepEqual([st.recorded.lifetimePaid,st.recorded.paidInvoiceCount,st.verified.lifetimePaid],[true,1,false]);
 await ok(api.recordPaymentEvidence(H('owner'),b0.invoiceId,{kind:'CHARGEBACK',amountMinor:b0.totalMinor,occurredAt:iso(NOW-HOUR),reference:'CB-77',relatedEvidenceId:bp.evidenceId,note:null},K()));
 inv=await api.readInvoice(H('owner'),b0.invoiceId);assert.deepEqual([inv.settlement.state,inv.settlement.netMinor],['REVERSED',0]);
 st=await standing(O.B.id);assert.deepEqual([st.recorded.lifetimePaid,st.recorded.paidInvoiceCount,st.recorded.chargebackInvoiceCount,st.recorded.firstPaidAt],[false,0,1,null]);
 // Evidence only on issued invoices; an invoice with evidence cannot be voided; one without can.
 await deny(icmd(a0,{action:'VOID',reasonCode:'DUPLICATE'}),422,'SAAS_INVOICE_HAS_EVIDENCE');
 e0=(await ok(icmd(e0,{action:'VOID',reasonCode:'SUPERSEDED'}))).invoice;assert.deepEqual([e0.status,e0.invoiceNumber,e0.voidReason],['VOID',`HON-${year}-000004`,'SUPERSEDED']);
 await deny(pay(e0,100,iso(NOW-HOUR),'RCPT-V'),422,'SAAS_INVOICE_NOT_ISSUED');
 const replacement=(await ok(draft(sE.subscriptionId,0))).invoice;
 await deny(pay(replacement,100,iso(NOW-HOUR),'RCPT-D'),422,'SAAS_INVOICE_NOT_ISSUED');
 assert.equal((await api.readInvoices(H('operator'),'VOID')).invoices.length,2);
 assert.equal((await api.readInvoices(H('operator'),'ISSUED')).invoices.length,3);
 assert.ok((await api.readInvoices(H('operator'),undefined)).invoices.every(i=>i.delivery==='NOT_SENT'&&i.collection==='DISABLED'&&i.settlement.verifiedNetMinor===0));
 await deny(api.readInvoice(H('support'),a0.invoiceId),403,'SAAS_FORBIDDEN');
 await deny(api.readPaymentStanding(H('staff'),O.A.id),403,'SAAS_FORBIDDEN');

 // ---------- 5. no effect on subscriptions, founder inventory, entitlements, school billing or Champions ----------
 const org=await api.readOrganizationSubscription(H('owner'),O.B.id);
 // Payment status is derived from evidence (B5): B's lifetime purchase was charged back, so it reads DISPUTED, unverified;
 // the subscription lifecycle and founder slot are untouched.
 assert.deepEqual([org.current.status,org.current.paymentStatus,org.current.paymentVerification,org.current.paidThroughAt,org.founderReservations[0].status],
  ['IN_SERVICE','DISPUTED','NONE',null,'ALLOCATED']);
 const inventory=(await api.readCatalog(H('owner'))).founderInventory;assert.deepEqual([inventory.lifetime.allocated,inventory.remaining.lifetime],[1,19]);
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.saas_subscriptions')).rows[0].n,5);
 assert.deepEqual(await untouched(),before,'No entitlement, school billing, AI usage, Champions or shared audit row changed.');

 // ---------- 6. constraints hold even with guards disabled ----------
 const evId=p2.evidenceId;
 await rejectedWithoutGuards('saas_payment_evidence',"UPDATE hon.saas_payment_evidence SET source='PROVIDER_VERIFIED' WHERE id=$1",[evId]);
 await rejectedWithoutGuards('saas_payment_evidence',"UPDATE hon.saas_payment_evidence SET provider_event_id='evt_fixture' WHERE id=$1",[evId]);
 await rejectedWithoutGuards('saas_invoices',"UPDATE hon.saas_invoices SET delivery_status='SENT' WHERE id=$1",[a0.invoiceId]);
 await rejectedWithoutGuards('saas_invoices',"UPDATE hon.saas_invoices SET collection_enabled=true WHERE id=$1",[a0.invoiceId]);
 await rejectedWithoutGuards('saas_invoices',"UPDATE hon.saas_invoices SET status='ISSUED',issued_at=clock_timestamp(),issued_by_principal_id=$2,invoice_number='HON-2026-999999' WHERE id=$1",[replacement.invoiceId,humans.owner.id]);
 await rejectedWithoutGuards('saas_invoices',"UPDATE hon.saas_invoices SET total_minor=total_minor+1 WHERE id=$1",[a0.invoiceId]);
 await rejectedWithoutGuards('saas_policy_records',"UPDATE hon.saas_policy_records SET actions_enabled=true WHERE policy_code='CREDIT_ROLLOVER'");
 await rejectedWithoutGuards('saas_policy_records',"INSERT INTO hon.saas_policy_records(policy_code,version,status,decision_code,summary,blocks,source_reference,recorded_at) VALUES('TAXES',3,'UNDECIDED','X','s','b','r',clock_timestamp())");
 // Guards: evidence and decisions are append-only, issued invoices are frozen, numbering only moves forward.
 await sqlDeny(admin.query('UPDATE hon.saas_payment_evidence SET amount_minor=1 WHERE id=$1',[evId]));
 await sqlDeny(admin.query('DELETE FROM hon.saas_payment_evidence WHERE id=$1',[evId]));
 await sqlDeny(admin.query('DELETE FROM hon.saas_invoices WHERE id=$1',[a0.invoiceId]));
 await sqlDeny(admin.query('UPDATE hon.saas_invoices SET subtotal_minor=1,version=version+1 WHERE id=$1',[a0.invoiceId]));
 await sqlDeny(admin.query("UPDATE hon.saas_invoices SET status='DRAFT',version=version+1 WHERE id=$1",[a0.invoiceId]));
 await sqlDeny(admin.query("INSERT INTO hon.saas_invoice_lines(invoice_id,line_number,line_kind,description,amount_minor,created_by_principal_id,created_at) VALUES($1,9,'CORRECTION','x',1,$2,clock_timestamp())",[a0.invoiceId,humans.owner.id]));
 await sqlDeny(admin.query('UPDATE hon.saas_invoice_lines SET amount_minor=1 WHERE invoice_id=$1',[a0.invoiceId]));
 await sqlDeny(admin.query('UPDATE hon.saas_invoice_sequences SET last_number=last_number-1'));
 await sqlDeny(admin.query("UPDATE hon.saas_policy_records SET summary='changed' WHERE policy_code='TAXES'"));
 await sqlDeny(admin.query('TRUNCATE hon.saas_payment_evidence CASCADE'));

 // ---------- 7. evidence ----------
 const ev=(await admin.query(`SELECT (SELECT count(*) FROM hon.saas_requests WHERE status='COMPLETED')::int req,(SELECT count(*) FROM hon.saas_requests WHERE status<>'COMPLETED')::int open,
  (SELECT count(*) FROM hon.saas_audit WHERE action_code IN ('saas.invoice.draft','saas.invoice.command','saas.payment.evidence'))::int audit,
  (SELECT count(*) FROM hon.saas_outbox WHERE event_type IN ('saas.invoice.drafted','saas.invoice.changed','saas.payment.evidence_recorded')
    AND payload->'internalOnly'='true'::jsonb AND payload->'executionAllowed'='false'::jsonb)::int inert`)).rows[0];
 assert.deepEqual(ev,{req:evidenceBaseline+commands,open:0,audit:commands,inert:commands});
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_payment_evidence WHERE source<>'HQ_ATTESTATION'")).rows[0].n,0);
 assert.deepEqual((await admin.query("SELECT invoice_number FROM hon.saas_invoices WHERE invoice_number IS NOT NULL ORDER BY 1")).rows.map(r=>r.invoice_number),
  [1,2,3,4].map(n=>`HON-${year}-00000${n}`));
 console.log(`PASS: HON invoices and payment evidence B2 proof — ${commands} commands with exact evidence; gapless numbering under concurrency; owner-verified tax required before issue; HQ attestation never provider-verified; refunds/chargebacks reduce standing; recorded owner decisions enable nothing; no subscription, founder, entitlement, school-billing or Champions effect.`);
}finally{
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end()]);}
}
