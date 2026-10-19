import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// HON Subscription Billing B4 (0157) integrity proof through the real API services on a disposable
// database: 30-day first-purchase refund guarantee records (regular, founder monthly and paid
// lifetime), first-purchase identification, windows, approve/deny/evidence workflow, refund reserve,
// duplicate prevention under concurrency; the Champions ladder ($100 credits 1-4, $100 welcome credits,
// 6 then 12 total free months, prize, lifetime) applied to HON subscriptions through the owner-gated
// fulfillment switch; credit never above the invoice balance and a zero-total invoice unissuable;
// free months never invoiced and still carrying the full B3 allowance; refunds and chargebacks of
// referred schools raising alerts that block fulfillment without reversing anything; and no refund
// execution, payout, prize, debt, entitlement, school-billing or shared-audit effect.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {ChampionsClubService}=await import('../../../apps/api/dist/champions/champions-club.service.js');
const contracts=await import('@hon/contracts');
const database=new RuntimeDatabaseService(),api=new SaasBillingService(database),champions=new ChampionsClubService(database);
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const b4Tables=['saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions','saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests'];
const saasTables=[...b4Tables,'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions',
 'saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests',
 'saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions'];
const championsTables=['champions_outbox','champions_audit','champions_contest_history','champions_contest_winners','champions_contest_results','champions_contest_pauses','champions_contest_schools',
 'champions_contest_prizes','champions_contests','champions_leaderboard_holds','champions_leaderboard_preferences','champions_reward_history','champions_reward_entries','champions_reward_policies',
 'champions_attribution_history','champions_attributions','champions_requests','champions_referral_codes','champions_policies'];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code='42501')=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
// R referrer (Core regular), W1/W2 referred schools with HON subscriptions, P* plain referred schools;
// refund cases: RA regular Core, RX regular Core with two purchases, FM Core founder monthly, FL Complete founder lifetime.
const O=Object.fromEntries(['R','W1','W2','RA','RX','FM','FL'].map(k=>[k,{id:randomUUID(),tier:k==='FL'?'COMPLETE':'CORE',school:randomUUID()}]));
const plain=[];// referred-only organizations
const humans=Object.fromEntries(['owner','operator','support','staffR'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`b4-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
const ids={m1Policy:randomUUID(),code:randomUUID(),role:randomUUID()};
// Open pool connections first so a race really runs concurrently instead of queueing on a cold pool.
const warm=()=>Promise.all(Array.from({length:8},()=>api.readRefundReserve(H('operator'))));
let commands=0;const ok=async p=>{const r=await p;if(!r.replayed)commands++;return r;};
let createdProvider=false;
const orgIds=()=>[...Object.values(O).map(o=>o.id),...plain];
// Entitlement rows of referred fixtures added after the snapshot (qualify) are fixture setup, not effects.
const lateFixtures=[];
async function untouched(){const out={};for(const t of ['organization_entitlements','billing_accounts','memberships','invoices','membership_payment_schedules','audit_events','outbox_events','principal_role_grants','hq_operator_grants'])
 out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t ${t==='organization_entitlements'?'WHERE organization_id<>ALL($1::uuid[])':''} ORDER BY 1`,t==='organization_entitlements'?[lateFixtures]:[])).rows.map(r=>r.r);return out;}
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
  for(const t of [...saasTables,'saas_credit_program','saas_reward_fulfillment',...championsTables])await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of [...saasTables,...championsTables])await admin.query(`DELETE FROM hon.${t}`);
  await admin.query("UPDATE hon.saas_credit_program SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query("UPDATE hon.saas_reward_fulfillment SET status='INACTIVE',version=1,authorization_reference=NULL,changed_by_principal_id=NULL");
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of [...saasTables,'saas_credit_program','saas_reward_fulfillment',...championsTables])await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  const principalIds=Object.values(humans).map(h=>h.id);
  await admin.query('DELETE FROM hon.ai_usage_ledger WHERE organization_id=ANY($1::uuid[])',[orgIds()]);
  if(createdProvider)await admin.query("DELETE FROM hon.hq_ai_provider_connections WHERE provider_id='HIGGSFIELD'");
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgIds()]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgIds()]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
// ---------- helpers through the real services ----------
const draft=(subscriptionId,periodIndex)=>api.createInvoiceDraft(H('owner'),{subscriptionId,periodIndex},K()).then(r=>r.invoice);
const icmd=(invoice,body)=>api.commandInvoice(H('owner'),invoice.invoiceId,{...body,expectedVersion:body.expectedVersion??invoice.version},K()).then(r=>r.invoice);
const noTax=invoice=>icmd(invoice,{action:'SET_TAX',treatment:'NO_TAX_APPLICABLE',taxLines:[],verificationReference:'Fixture tax review (not tax advice)'});
const issued=async(sub,period)=>icmd(await noTax(await draft(sub,period)),{action:'ISSUE'});
const evidence=(invoice,kind,amountMinor,occurredAt,reference,relatedEvidenceId=null)=>api.recordPaymentEvidence(H('owner'),invoice.invoiceId,
 {kind,amountMinor,occurredAt,reference,relatedEvidenceId,note:null},K()).then(r=>r.evidence);
const eligibility=(org,receivedAt)=>api.readRefundEligibility(H('operator'),org,receivedAt?{receivedAt}:{});
const intake=(org,receivedAt,who='operator',key=K())=>api.createRefundRequest(H(who),{organizationId:org,requestReceivedAt:receivedAt,customerReference:'Fixture support ticket',note:null},key);
const decideRefund=(r,decision,reasonCode,who='owner',key=K())=>api.decideRefundRequest(H(who),r.refundRequestId,{decision,reasonCode,expectedVersion:r.version,note:null},key);
const preview=org=>api.readRewardPreview(H('operator'),org);
const entryRows=async(where='',params=[])=>(await admin.query(`SELECT * FROM hon.champions_reward_entries ${where} ORDER BY accrued_at, milestone_count NULLS LAST, id`,params)).rows;
const applyReward=(e,firstPeriodIndex=null,who='owner',key=K())=>api.applyChampionsReward(H(who),e.id,{expectedEntryVersion:e.version,firstPeriodIndex},key);
const fresh=async e=>(await entryRows('WHERE id=$1',[e.id]))[0];
const approve=async(e,patch={})=>champions.decideReward(H('owner'),e.id,{decision:'APPROVE',expectedVersion:e.version,planBasis:'MONTHLY',substitute:null,prize:null,...patch},K());
async function qualify(n){
 await admin.query('BEGIN');
 for(let i=0;i<n;i++){
  const org=randomUUID();plain.push(org);
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Referred fixture','Referred fixture')",[org]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')",[org]);
  await attribute(org);
 }
 await admin.query('COMMIT');
}
const attributions={};
async function attribute(org){
 const id=randomUUID();attributions[org]=id;
 await admin.query(`INSERT INTO hon.champions_attributions(id,referral_code_id,referrer_organization_id,referrer_school_id,referred_organization_id,state,state_reason,version,
  captured_by_principal_id,captured_at,qualified_policy_id,qualified_at,qualification_evidence,decided_by_principal_id,decided_at)
  VALUES($1,$2,$3,$4,$5,'QUALIFIED','QUALIFICATION_VERIFIED',2,$6,clock_timestamp()-interval '40 days',$7,clock_timestamp(),'{"source":"HQ_OWNER_ATTESTATION"}',$6,clock_timestamp())`,
  [id,ids.code,O.R.id,O.R.school,org,humans.owner.id,ids.m1Policy]);
}

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- runtime posture ----------
 for(const t of ['saas_refund_requests','saas_refund_history','saas_reward_fulfillment','saas_reward_applications','saas_account_credit_ledger','saas_free_periods','saas_referral_payment_alerts'])
  await sqlDeny(restricted.query(`SELECT * FROM hon.${t}`));
 for(const sig of ['saas_refund_eligibility(uuid,timestamptz)','saas_account_credit_grants(uuid)','saas_reward_entry_state(hon.champions_reward_entries)','saas_evidence_referral_alert()'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);
 await cleanup();

 // ---------- fixture ----------
 await admin.query('BEGIN');
 if((await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state) VALUES('HIGGSFIELD','Fixture provider','DISABLED') ON CONFLICT DO NOTHING RETURNING provider_id")).rowCount)createdProvider=true;
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[k,o]of Object.entries(O)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o.id,`B4 Fixture Dojo ${k}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,$2,clock_timestamp()-interval '90 days')",[o.id,o.tier]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'America/New_York')",[o.school,o.id,`School ${k}`]);
 }
 // R's owner-level staff hold every school permission an owner role carries; none of them reaches HQ billing.
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'OWNER_LIKE','Fixture school owner role')",[ids.role,O.R.id]);
 for(const perm of ['ai.premium.request','champions.participate'])await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)",[ids.role,O.R.id,perm]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[O.R.id,O.R.school,humans.staffR.id,ids.role]);
 for(const[who,hqRole,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage','hq.champions.manage']],['support','HON_HQ_SUPPORT',['hq.billing.manage','hq.champions.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,hqRole,perms]);
 await admin.query(`INSERT INTO hon.champions_policies(id,policy_version,status,attribution_window_days,refund_window_days,minimum_paid_days,minimum_paid_invoices,payment_verification_source,
  welcome_credit_minor,terms_reference,created_by_principal_id,published_by_principal_id,published_at) VALUES($1,1,'PUBLISHED',90,30,30,1,'HQ_OWNER_ATTESTATION',10000,'Fixture program terms',$2,$2,clock_timestamp())`,[ids.m1Policy,humans.owner.id]);
 await admin.query("INSERT INTO hon.champions_referral_codes(id,organization_id,school_id,code,created_by_principal_id,created_at) VALUES($1,$2,$3,'REFUNDB4XY',$4,clock_timestamp()-interval '50 days')",[ids.code,O.R.id,O.R.school,humans.owner.id]);
 for(const k of ['W1','W2'])await attribute(O[k].id);
 await admin.query('COMMIT');
 await qualify(8); // 10 qualified referrals
 const d=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);
 d.termsReference='Fixture HON plan terms v1 (not customer terms)';d.founderProgram={...d.founderProgram,eligibility:'ANY_ACTIVE_ORGANIZATION',opensAt:iso(NOW-HOUR)};
 const cat=(await api.publishCatalog(H('owner'),(await api.createCatalogDraft(H('owner'),d,K())).catalog.catalogId,K())).catalog;
 const offer=(plan,kind)=>cat.offers.find(o=>o.planCode===plan&&o.offerKind===kind);
 const rec=input=>api.recordSubscription(H('owner'),input,K()).then(r=>r.subscription);
 const start=s=>api.commandSubscription(H('owner'),s.subscriptionId,{action:'START_SERVICE',expectedVersion:s.version,reasonCode:'SERVICE_STARTED'},K()).then(r=>r.subscription);
 const regular=async k=>start(await rec({source:'CATALOG_OFFER',organizationId:O[k].id,offerId:offer('CORE','REGULAR_MONTHLY').offerId,founderReservationId:null}));
 const founder=async(k,plan,kind)=>{const r=(await api.reserveFounder(H('owner'),{organizationId:O[k].id,offerId:offer(plan,kind).offerId},K())).reservation;
  return start(await rec({source:'CATALOG_OFFER',organizationId:O[k].id,offerId:offer(plan,kind).offerId,founderReservationId:r.reservationId}));};
 const subs={};
 for(const k of ['R','W1','W2','RA','RX'])subs[k]=await regular(k);
 subs.FM=await founder('FM','CORE','FOUNDER_MONTHLY');subs.FL=await founder('FL','COMPLETE','FOUNDER_LIFETIME');
 const elapse=(sub,days)=>withoutGuards(['saas_subscriptions'],[[`UPDATE hon.saas_subscriptions SET service_started_at=service_started_at-$2::interval,period_anchor_at=period_anchor_at-$2::interval,
  current_period_start=current_period_start-$2::interval,current_period_end=current_period_start-$2::interval+interval '1 month' WHERE id=$1`,[sub.subscriptionId,`${days} days`]]]);
 const advance=async k=>{const cur=(await api.readOrganizationSubscription(H('owner'),O[k].id)).current;
  subs[k]=(await api.commandSubscription(H('owner'),cur.subscriptionId,{action:'ADVANCE_PERIOD',expectedVersion:cur.version,reasonCode:'PERIOD_ELAPSED'},K())).subscription;};
 const before=await untouched();
 const requestBaseline=(await admin.query('SELECT count(*)::int n FROM hon.saas_requests')).rows[0].n;
 const subscriptionSnapshot=async()=>(await admin.query("SELECT id,status,status_reason,offer_kind,plan_code,entitlement_tier,billing_interval,price_minor,founder_reservation_id FROM hon.saas_subscriptions ORDER BY id")).rows;

 // ---------- 1. owner decisions recorded; nothing activated ----------
 const policies=Object.fromEntries((await api.readCatalog(H('operator'))).policies.map(p=>[p.policyCode,p]));
 assert.deepEqual(Object.keys(policies),[...contracts.SAAS_POLICY_CODES]);
 for(const[code,status,decision]of [['REFUND_GUARANTEE','DECIDED','FIRST_PURCHASE_30_DAY_FULL_REFUND_ALL_OFFERS'],
  ['CHAMPIONS_REWARD_LADDER','DECIDED','CREDITS_1_4_WELCOME_6_12_MONTHS_PRIZE_20_LIFETIME_30'],['REWARD_CLAWBACK','UNDECIDED',null],
  ['ZERO_DOLLAR_INVOICE','UNDECIDED',null],['REFUND_EXECUTION','UNDECIDED',null],['CANCELLATION_TIMING','PROPOSED','END_OF_PAID_PERIOD']])
  assert.deepEqual([policies[code].status,policies[code].decision,policies[code].actionsEnabled],[status,decision,false],code);

 // ---------- 2. refund eligibility: first purchase, windows, every offer ----------
 for(const who of ['support','staffR'])await deny(api.readRefundEligibility(H(who),O.RA.id,{}),403,'SAAS_FORBIDDEN');
 const raNone=await eligibility(O.RA.id);
 assert.deepEqual([raNone.eligible,raNone.refusal,raNone.invoiceId,raNone.refundableMinor,raNone.execution],[false,'SAAS_REFUND_NO_PAID_PURCHASE',null,0,'UNAVAILABLE']);
 const ra0=await issued(subs.RA.subscriptionId,0);
 assert.equal((await eligibility(O.RA.id)).refusal,'SAAS_REFUND_NO_PAID_PURCHASE'); // issued but unpaid
 const raPay=await evidence(ra0,'PAYMENT_RECEIVED',ra0.totalMinor,iso(NOW-5*DAY),'RCPT-RA-1');
 const raE=await eligibility(O.RA.id);
 assert.deepEqual([raE.eligible,raE.invoiceId,raE.offerKind,raE.refundableMinor,raE.firstPaidAt,raE.windowEndsAt,raE.evidenceStrength],
  [true,ra0.invoiceId,'REGULAR_MONTHLY',14900,iso(NOW-5*DAY),iso(NOW-5*DAY+30*DAY),'HQ_ATTESTED']);
 assert.equal((await eligibility(O.RA.id,iso(NOW-6*DAY))).refusal,'SAAS_REFUND_BEFORE_PAYMENT');
 // RX: two purchases; the guarantee follows the first one, whose window has closed.
 await elapse(subs.RX,40);await advance('RX');
 const rx0=await issued(subs.RX.subscriptionId,0),rx1=await issued(subs.RX.subscriptionId,1);
 await evidence(rx0,'PAYMENT_RECEIVED',14900,iso(NOW-35*DAY),'RCPT-RX-0');await evidence(rx1,'PAYMENT_RECEIVED',14900,iso(NOW-2*DAY),'RCPT-RX-1');
 const rxE=await eligibility(O.RX.id);
 assert.deepEqual([rxE.eligible,rxE.refusal,rxE.invoiceId,rxE.windowEndsAt],[false,'SAAS_REFUND_WINDOW_EXPIRED',rx0.invoiceId,iso(NOW-5*DAY)]);
 await deny(intake(O.RX.id,iso(NOW-HOUR)),422,'SAAS_REFUND_WINDOW_EXPIRED');
 // A request received inside the window but recorded later is still covered (exactly 30 days is not).
 assert.equal((await eligibility(O.RX.id,iso(NOW-35*DAY+30*DAY))).refusal,'SAAS_REFUND_WINDOW_EXPIRED');
 const rxLate=(await eligibility(O.RX.id,iso(NOW-35*DAY+30*DAY-1000)));assert.equal(rxLate.eligible,true);
 // The window is exactly 720 hours whatever the session time zone (RA's window spans the US DST change on 2026-11-01).
 await admin.query("SET TimeZone='America/New_York'");
 const dst=(await admin.query("SELECT (r->>'windowEndsAt')::timestamptz-(r->>'firstPaidAt')::timestamptz w FROM (SELECT hon.saas_refund_eligibility($1,clock_timestamp()) r) x",[O.RA.id])).rows[0].w;
 await admin.query("SET TimeZone='UTC'");
 assert.deepEqual([dst.days??0,dst.hours??0],[30,0],JSON.stringify(dst));
 const fm0=await issued(subs.FM.subscriptionId,0);await evidence(fm0,'PAYMENT_RECEIVED',fm0.totalMinor,iso(NOW-3*DAY),'RCPT-FM');
 const fl0=await issued(subs.FL.subscriptionId,null);await evidence(fl0,'PAYMENT_RECEIVED',fl0.totalMinor,iso(NOW-4*DAY),'RCPT-FL');
 assert.deepEqual([(await eligibility(O.FM.id)).offerKind,(await eligibility(O.FM.id)).refundableMinor],['FOUNDER_MONTHLY',7900]);
 const flE=await eligibility(O.FL.id);
 assert.deepEqual([flE.offerKind,flE.refundableMinor,flE.eligible],['FOUNDER_LIFETIME',357600,true]);

 // ---------- 3. intake, duplicates under concurrency, reserve ----------
 await deny(intake(O.RA.id,iso(NOW+HOUR)),422,'SAAS_EVIDENCE_IN_FUTURE');
 await deny(intake(O.RA.id,iso(NOW-HOUR),'support'),403,'SAAS_FORBIDDEN');
 await deny(intake(O.RA.id,iso(NOW-HOUR),'staffR'),403,'SAAS_FORBIDDEN');
 const kRA=K();
 const raReq=(await ok(intake(O.RA.id,iso(NOW-HOUR),'operator',kRA))).refundRequest;
 assert.deepEqual([raReq.status,raReq.requestedAmountMinor,raReq.approvedAmountMinor,raReq.execution,raReq.executionStatus,raReq.subscriptionConsequence,raReq.invoiceId],
  ['REQUESTED',14900,null,'UNAVAILABLE','NOT_EXECUTED','BLOCKED_PENDING_TERMS',ra0.invoiceId]);
 assert.equal((await intake(O.RA.id,iso(NOW-HOUR),'operator',kRA)).replayed,true);
 await deny(intake(O.RA.id,iso(NOW-2*HOUR),'operator',kRA),409,'IDEMPOTENCY_KEY_REUSED');
 await deny(intake(O.RA.id,iso(NOW-HOUR)),422,'SAAS_REFUND_REQUEST_OPEN');
 await warm();
 const race=await Promise.allSettled(Array.from({length:6},()=>intake(O.FM.id,iso(NOW-HOUR))));
 const raceWon=race.filter(r=>r.status==='fulfilled');commands+=raceWon.length;
 assert.equal(raceWon.length,1,JSON.stringify(race.map(r=>r.reason?.getResponse?.()??r.status)));
 for(const r of race.filter(r=>r.status==='rejected'))http(422,'SAAS_REFUND_REQUEST_OPEN')(r.reason);
 const fmReq=raceWon[0].value.refundRequest;
 let reserve=await api.readRefundReserve(H('operator'));
 // Open windows without a live request: FL lifetime only (RA and FM have requests; RX's window closed).
 assert.deepEqual(reserve.windowExposure,{organizations:1,totalMinor:357600,paidLifetimeMinor:357600,monthlyMinor:0,earliestWindowEndsAt:iso(NOW-4*DAY+30*DAY)});
 assert.deepEqual([reserve.pendingRequests,reserve.approvedNotEvidenced,reserve.recommendedReserveMinor,reserve.execution],
  [{requests:2,totalMinor:22800},{requests:0,totalMinor:0},380400,'UNAVAILABLE']);

 // ---------- 4. owner decisions: approve, deny, evidence; nothing executed or cancelled ----------
 const subsBeforeRefunds=await subscriptionSnapshot();
 await deny(decideRefund(raReq,'APPROVE','GUARANTEE_APPROVED','operator'),403,'SAAS_FORBIDDEN');
 await deny(decideRefund(raReq,'MARK_EVIDENCED','REFUND_EVIDENCE_RECORDED'),409,'SAAS_TRANSITION_NOT_ALLOWED');
 await deny(decideRefund({...raReq,version:2},'APPROVE','GUARANTEE_APPROVED'),409,'SAAS_VERSION_CONFLICT');
 const raApproved=(await ok(decideRefund(raReq,'APPROVE','GUARANTEE_APPROVED'))).refundRequest;
 assert.deepEqual([raApproved.status,raApproved.approvedAmountMinor,raApproved.executionStatus,raApproved.version],['APPROVED',14900,'NOT_EXECUTED',2]);
 await deny(decideRefund(raApproved,'DENY','OWNER_DECLINED_TERMS'),409,'SAAS_TRANSITION_NOT_ALLOWED');
 await deny(decideRefund(raApproved,'MARK_EVIDENCED','REFUND_EVIDENCE_RECORDED'),422,'SAAS_REFUND_EVIDENCE_INCOMPLETE');
 await evidence(ra0,'REFUND',10000,iso(NOW-HOUR),'RF-RA-1',raPay.evidenceId);
 await deny(decideRefund(raApproved,'MARK_EVIDENCED','REFUND_EVIDENCE_RECORDED'),422,'SAAS_REFUND_EVIDENCE_INCOMPLETE');
 await evidence(ra0,'REFUND',4900,iso(NOW-HOUR),'RF-RA-2',raPay.evidenceId);
 const raDone=(await ok(decideRefund(raApproved,'MARK_EVIDENCED','REFUND_EVIDENCE_RECORDED'))).refundRequest;
 assert.deepEqual([raDone.status,raDone.refundEvidencedMinor,raDone.approvedAmountMinor,raDone.executionStatus],['REFUND_EVIDENCED',14900,14900,'NOT_EXECUTED']);
 assert.equal((await eligibility(O.RA.id,iso(NOW-HOUR))).refusal,'SAAS_REFUND_ALREADY_GRANTED');
 await deny(intake(O.RA.id,iso(NOW-HOUR)),422,'SAAS_REFUND_ALREADY_GRANTED'); // the guarantee covers the first purchase once
 const fmDenied=(await ok(decideRefund(fmReq,'DENY','DUPLICATE_REQUEST'))).refundRequest;
 assert.deepEqual([fmDenied.status,fmDenied.statusReason,fmDenied.approvedAmountMinor],['DENIED','DUPLICATE_REQUEST',null]);
 const flReq=(await ok(intake(O.FL.id,iso(NOW-HOUR)))).refundRequest;
 const flApproved=(await ok(decideRefund(flReq,'APPROVE','GUARANTEE_APPROVED'))).refundRequest;
 assert.deepEqual([flApproved.offerKind,flApproved.approvedAmountMinor],['FOUNDER_LIFETIME',357600]);
 const rxReq=(await ok(intake(O.RX.id,rxLate.requestReceivedAt))).refundRequest;
 assert.equal(rxReq.invoiceId,rx0.invoiceId);
 assert.deepEqual((await admin.query('SELECT version,status,status_reason,amount_minor FROM hon.saas_refund_history WHERE refund_request_id=$1 ORDER BY version',[raReq.refundRequestId])).rows,
  [{version:1,status:'REQUESTED',status_reason:'REQUESTED',amount_minor:14900},{version:2,status:'APPROVED',status_reason:'GUARANTEE_APPROVED',amount_minor:14900},
   {version:3,status:'REFUND_EVIDENCED',status_reason:'REFUND_EVIDENCE_RECORDED',amount_minor:14900}]);
 reserve=await api.readRefundReserve(H('owner'));
 // FM's denied request returns its open window to exposure; FL is approved-not-evidenced; RX's late request is pending.
 assert.deepEqual([reserve.windowExposure.organizations,reserve.windowExposure.monthlyMinor,reserve.windowExposure.paidLifetimeMinor,reserve.approvedNotEvidenced,reserve.pendingRequests,reserve.recommendedReserveMinor],
  [1,7900,0,{requests:1,totalMinor:357600},{requests:1,totalMinor:14900},7900+357600+14900]);
 assert.equal((await api.readRefundRequests(H('operator'),'APPROVED')).refundRequests.length,1);
 assert.deepEqual(await subscriptionSnapshot(),subsBeforeRefunds,'Refund records never cancel, suspend or change a subscription or founder slot.');

 // ---------- 5. Champions ladder liabilities (M2) through the real Champions service ----------
 const terms={referrerCreditMinor:10000,referrerCreditMaxRank:4,welcomeCreditMinor:10000,firstFreeMonthsCount:5,firstFreeMonthsTotal:6,secondFreeMonthsCount:10,
  secondFreeMonthsTotal:12,prizeCount:20,prizeBudgetMinor:150000,lifetimeCount:30,clawbackRule:'UNDECIDED',monthlyRule:'AS_EARNED',annualRule:'AS_EARNED',
  founderRule:'UNDECIDED',paidLifetimeRule:'OWNER_SUBSTITUTE',termsReference:'Fixture reward terms (not legal terms)'};
 const rp=(await champions.createRewardPolicyDraft(H('operator'),terms,K())).policy;
 await champions.publishRewardPolicy(H('owner'),rp.policyId,K());
 await champions.reconcileRewards(H('operator'),O.R.school,K());
 let rows=await entryRows();
 const byKind=k=>rows.filter(e=>e.reward_kind===k&&e.status!=='VOIDED');
 assert.deepEqual(byKind('REFERRER_CREDIT').map(e=>[e.milestone_ordinal,e.credit_minor]),[[1,10000],[2,10000],[3,10000],[4,10000]]);
 assert.equal(byKind('WELCOME_CREDIT').length,10);assert.ok(byKind('WELCOME_CREDIT').every(e=>e.credit_minor===10000&&e.beneficiary_role==='REFERRED'));
 assert.deepEqual(byKind('FREE_MONTHS').map(e=>[e.milestone_count,e.free_months]),[[5,6],[10,6]]); // 6 at five, 12 total (incl. the 6) at ten
 // Before approval and activation, nothing is ready and nothing applies.
 let pr=await preview(O.R.id);
 assert.deepEqual([pr.fulfillment.status,pr.fulfillment.prizes,pr.fulfillment.cashPayouts],['INACTIVE','NOT_ISSUED','DISABLED']);
 assert.ok(pr.rewards.every(r=>r.state==='PENDING'&&r.blocker==='SAAS_REWARD_NOT_APPROVED'&&r.fulfilledNotice==='PREVIEW_IS_NOT_FULFILLMENT'));
 for(const e of [...byKind('REFERRER_CREDIT'),...byKind('FREE_MONTHS'),...rows.filter(e=>e.reward_kind==='WELCOME_CREDIT'&&[O.W1.id,O.W2.id].includes(e.beneficiary_organization_id))])await approve(e);
 rows=await entryRows();
 pr=await preview(O.R.id);
 assert.ok(pr.rewards.every(r=>r.state==='PENDING'&&r.blocker==='SAAS_REWARDS_NOT_ACTIVE'));
 const credit1=byKind('REFERRER_CREDIT')[0];
 await deny(applyReward(credit1),422,'SAAS_REWARDS_NOT_ACTIVE');
 // A plain referred school has no HON subscription to apply its welcome credit to.
 const plainWelcome=rows.find(e=>e.reward_kind==='WELCOME_CREDIT'&&e.beneficiary_organization_id===plain[0]);
 await approve(plainWelcome);
 assert.equal((await preview(plain[0])).rewards[0].blocker,'SAAS_REWARD_NO_SUBSCRIPTION');

 // ---------- 6. owner activation of reward fulfillment ----------
 await deny(api.setRewardFulfillment(H('operator'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'x'},K()),403,'SAAS_FORBIDDEN');
 const ful=(await ok(api.setRewardFulfillment(H('owner'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'Fixture owner authorization (disposable)'},K()))).fulfillment;
 assert.deepEqual([ful.status,ful.version,ful.prizes,ful.cashPayouts],['ACTIVE',2,'NOT_ISSUED','DISABLED']);
 await deny(api.setRewardFulfillment(H('owner'),{action:'ACTIVATE',expectedVersion:2,authorizationReference:'again'},K()),409,'SAAS_TRANSITION_NOT_ALLOWED');
 pr=await preview(O.R.id);
 assert.deepEqual(pr.rewards.map(r=>[r.rewardKind,r.applicationKind]).sort(),[...Array(4).fill(['REFERRER_CREDIT','ACCOUNT_CREDIT']),...Array(2).fill(['FREE_MONTHS','FREE_PERIODS'])].sort());
 assert.ok(pr.rewards.every(r=>r.state==='READY'&&r.subscriptionId===subs.R.subscriptionId));

 // ---------- 7. $100 referrer credits: one application per entry, ever ----------
 for(const who of ['operator','support','staffR'])await deny(applyReward(credit1,null,who),403,'SAAS_FORBIDDEN');
 await deny(applyReward(credit1,3),400,'INVALID_SAAS_INPUT');
 await deny(applyReward({...credit1,version:credit1.version+1}),409,'SAAS_VERSION_CONFLICT');
 await warm();
 const applyRace=await Promise.allSettled(Array.from({length:6},()=>applyReward(credit1)));
 const applyWon=applyRace.filter(r=>r.status==='fulfilled');commands+=applyWon.length;
 assert.equal(applyWon.length,1,JSON.stringify(applyRace.map(r=>r.reason?.getResponse?.()??r.status)));
 for(const r of applyRace.filter(r=>r.status==='rejected'))http(422,'SAAS_REWARD_ALREADY_APPLIED')(r.reason);
 assert.deepEqual([applyWon[0].value.application.applicationKind,applyWon[0].value.application.creditMinor,applyWon[0].value.reward.state],['ACCOUNT_CREDIT',10000,'APPLIED']);
 for(const e of byKind('REFERRER_CREDIT').slice(1))await ok(applyReward(e));
 pr=await preview(O.R.id);
 assert.deepEqual(pr.accountCredit,{grantedMinor:40000,appliedMinor:0,availableMinor:40000,blockedMinor:0});
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_account_credit_ledger WHERE organization_id=$1 AND entry_kind='GRANT'",[O.R.id])).rows[0].n,4);

 // ---------- 8. credit preview and application: never above the invoice, zero total unissuable ----------
 let r0=await draft(subs.R.subscriptionId,0);
 const cp=await api.readCreditApplicationPreview(H('operator'),r0.invoiceId);
 assert.deepEqual([cp.availableCreditMinor,cp.wouldApplyMinor,cp.resultingSubtotalMinor,cp.applicable,cp.zeroTotalIssuable,cp.previewOnly],[40000,14900,0,true,false,true]);
 assert.equal((await api.readInvoice(H('operator'),r0.invoiceId)).subtotalMinor,14900,'A preview changes nothing.');
 await deny(api.applyAccountCredit(H('operator'),r0.invoiceId,{expectedVersion:r0.version},K()),403,'SAAS_FORBIDDEN');
 const credited=(await ok(api.applyAccountCredit(H('owner'),r0.invoiceId,{expectedVersion:r0.version},K())));
 assert.deepEqual([credited.appliedCreditMinor,credited.invoice.subtotalMinor,credited.invoice.lines.at(-1).lineKind,credited.invoice.lines.at(-1).amountMinor],[14900,0,'ACCOUNT_CREDIT',-14900]);
 await deny(api.applyAccountCredit(H('owner'),r0.invoiceId,{expectedVersion:credited.invoice.version},K()),422,'SAAS_NO_ACCOUNT_CREDIT');
 assert.deepEqual((await preview(O.R.id)).accountCredit,{grantedMinor:40000,appliedMinor:14900,availableMinor:25100,blockedMinor:0});
 const zero=await noTax(credited.invoice);
 await deny(api.commandInvoice(H('owner'),zero.invoiceId,{action:'ISSUE',expectedVersion:zero.version},K()),422,'SAAS_INVOICE_ZERO_TOTAL'); // ZERO_DOLLAR_INVOICE undecided
 await icmd(zero,{action:'VOID',reasonCode:'ISSUED_IN_ERROR'});
 assert.deepEqual((await preview(O.R.id)).accountCredit,{grantedMinor:40000,appliedMinor:0,availableMinor:40000,blockedMinor:0},'Credit on a voided invoice is restored.');

 // ---------- 9. welcome credit to the referred school's own subscription ----------
 const w1Welcome=rows.find(e=>e.reward_kind==='WELCOME_CREDIT'&&e.beneficiary_organization_id===O.W1.id);
 const w1App=(await ok(applyReward(w1Welcome))).application;
 assert.deepEqual([w1App.organizationId,w1App.subscriptionId,w1App.creditMinor],[O.W1.id,subs.W1.subscriptionId,10000]);
 let w10=await draft(subs.W1.subscriptionId,0);
 w10=(await ok(api.applyAccountCredit(H('owner'),w10.invoiceId,{expectedVersion:w10.version},K()))).invoice;
 assert.equal(w10.subtotalMinor,4900); // $149 less the $100 welcome credit
 w10=await icmd(await noTax(w10),{action:'ISSUE'});
 const w1Pay=await evidence(w10,'PAYMENT_RECEIVED',4900,iso(NOW-2*DAY),'RCPT-W1');
 assert.deepEqual((await preview(O.W1.id)).accountCredit,{grantedMinor:10000,appliedMinor:10000,availableMinor:0,blockedMinor:0});

 // ---------- 10. free months: 6 then 12 total, never double counted, never invoiced ----------
 const [free5,free10]=byKind('FREE_MONTHS');
 await deny(applyReward(free5),400,'INVALID_SAAS_INPUT'); // the starting period is required
 const f5=(await ok(applyReward(free5,1))).application;
 assert.deepEqual([f5.applicationKind,f5.freeMonths,f5.firstPeriodIndex],['FREE_PERIODS',6,1]);
 await deny(applyReward(free10,6),422,'SAAS_REWARD_PERIOD_TAKEN');
 // ---------- 11. full AI allowance during a free month (B3 ledger, no second ledger) ----------
 const ev=(await ok(api.recordCostEvidence(H('owner'),{providerId:'HIGGSFIELD',modelCode:'fixture-image-1',costUnit:'IMAGE',measuredUnits:1000,billedCostMicrounits:40_000_000,
  fullyLoadedCostMicrounits:50_000_000,evidenceReference:'FIXTURE-B4-PROVIDER-1',periodStart:iso(NOW-40*DAY),periodEnd:iso(NOW-10*DAY),note:null},K()))).costEvidence;
 const pd=(await ok(api.createPricingDraft(H('operator'),{termsReference:'Fixture premium pricing (not customer terms)',operations:[{operationCode:'image.generate',
  category:'IMAGE_GENERATION',displayName:'AI image',billingUnit:'IMAGE',creditsPerUnit:10,maxUnitsPerRequest:8,requiredCapability:'ai.premium_metered',costEvidenceId:ev.costEvidenceId}]},K()))).pricing;
 await ok(api.publishPricing(H('owner'),pd.pricingId,K()));
 await ok(api.setCreditProgram(H('owner'),{action:'ACTIVATE',expectedVersion:1,authorizationReference:'Fixture owner authorization (disposable)'},K()));
 const a0=(await ok(api.commandAllowance(H('operator'),{action:'OPEN_CURRENT',subscriptionId:subs.R.subscriptionId},K()))).allowance;
 assert.deepEqual([a0.periodIndex,a0.allowanceBasis,a0.balance.allowanceCredits],[0,'REGULAR',5000]);
 await withoutGuards(['saas_subscriptions','saas_credit_allowances'],[
  ["UPDATE hon.saas_subscriptions SET service_started_at=service_started_at-interval '40 days',period_anchor_at=period_anchor_at-interval '40 days',current_period_start=current_period_start-interval '40 days',current_period_end=current_period_start-interval '40 days'+interval '1 month' WHERE id=$1",[subs.R.subscriptionId]],
  ["UPDATE hon.saas_credit_allowances SET period_start=period_start-interval '40 days',period_end=period_start-interval '40 days'+interval '1 month' WHERE id=$1",[a0.allowanceId]]]);
 await advance('R');
 await deny(api.createInvoiceDraft(H('owner'),{subscriptionId:subs.R.subscriptionId,periodIndex:1},K()),422,'SAAS_PERIOD_FREE');
 const a1=(await ok(api.commandAllowance(H('operator'),{action:'OPEN_CURRENT',subscriptionId:subs.R.subscriptionId},K()))).allowance;
 assert.deepEqual([a1.periodIndex,a1.allowanceBasis,a1.balance.allowanceCredits,a1.balance.availableCredits,a1.rollover],[1,'CHAMPIONS_FREE_MONTH',5000,5000,'NONE']);
 const again=(await ok(api.commandAllowance(H('operator'),{action:'OPEN_CURRENT',subscriptionId:subs.R.subscriptionId},K()))).allowance;
 assert.equal(again.allowanceId,a1.allowanceId);
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.saas_credit_allowances WHERE subscription_id=$1 AND period_index=1',[subs.R.subscriptionId])).rows[0].n,1);
 const expired=(await api.readOrganizationCredits(H('operator'),O.R.id)).allowances.find(a=>a.allowanceId===a0.allowanceId);
 assert.deepEqual([expired.status,expired.balance.expiredCredits,expired.balance.availableCredits],['EXPIRED',5000,0]); // no rollover into the free month
 const staffCredits=await api.readSchoolCredits(H('staffR'),O.R.school);
 assert.deepEqual([staffCredits.currentAllowance.allowanceBasis,staffCredits.currentAllowance.balance.allowanceCredits],['CHAMPIONS_FREE_MONTH',5000]);

 // ---------- 12. 20 and 30 referrals: prize stays manual; lifetime keeps the full allowance and is recorded, not converted ----------
 const firstLate=plain.length;await qualify(20);lateFixtures.push(...plain.slice(firstLate));
 await champions.reconcileRewards(H('operator'),O.R.school,K());
 rows=await entryRows();
 const prize=byKind('PRIZE')[0],lifetime=byKind('LIFETIME_MEMBERSHIP')[0];
 assert.deepEqual([prize.milestone_count,lifetime.milestone_count,lifetime.lifetime_tier,lifetime.ai_allowance],[20,30,'CORE','FULL_PLAN_ALLOWANCE']);
 await approve(prize,{prize:{kind:'EXPERIENCE',description:'Fixture approved experience prize',costMinor:100000}});
 await approve(lifetime);
 await deny(applyReward(await fresh(prize)),422,'SAAS_REWARD_PRIZE_MANUAL');
 const life=(await ok(applyReward(await fresh(lifetime)))).application;
 assert.deepEqual([life.applicationKind,life.status,life.lifetimeTier],['LIFETIME_CONVERSION','CONVERSION_BLOCKED','CORE']);
 const rSub=(await admin.query('SELECT offer_kind,billing_interval,price_minor,entitlement_tier FROM hon.saas_subscriptions WHERE id=$1',[subs.R.subscriptionId])).rows[0];
 assert.deepEqual(rSub,{offer_kind:'REGULAR_MONTHLY',billing_interval:'MONTHLY',price_minor:14900,entitlement_tier:'CORE'},'The plan is not changed until terms exist.');
 assert.equal((await preview(O.R.id)).rewards.find(r=>r.rewardEntryId===lifetime.id).state,'APPLIED_CONVERSION_BLOCKED');

 // ---------- 13. chargeback and refund of referred schools: alerts block fulfillment; nothing reversed or charged ----------
 const w20=await issued(subs.W2.subscriptionId,0);const w2Pay=await evidence(w20,'PAYMENT_RECEIVED',14900,iso(NOW-3*DAY),'RCPT-W2');
 assert.equal((await api.readReferralAlerts(H('operator'),'OPEN')).alerts.length,0);
 await evidence(w20,'CHARGEBACK',14900,iso(NOW-HOUR),'CB-W2',w2Pay.evidenceId);
 let alerts=(await api.readReferralAlerts(H('operator'),'OPEN')).alerts;
 assert.equal(alerts.length,1);
 const cb=alerts[0];
 assert.deepEqual([cb.source,cb.evidenceKind,cb.referredOrganizationId,cb.attributionState,cb.referredRecordedNetMinor,cb.automaticReversal,cb.debtCreated],
  ['PAYMENT_EVIDENCE','CHARGEBACK',O.W2.id,'QUALIFIED',0,'NONE',false]);
 const appsBefore=(await admin.query('SELECT * FROM hon.saas_reward_applications ORDER BY id')).rows;
 // The alert names every ladder benefit already applied for the referrer (4 credits, the first free months, lifetime), for owner review.
 assert.deepEqual([...cb.affectedApplications].sort(),appsBefore.filter(a=>a.organization_id===O.R.id).map(a=>a.id).sort());
 assert.equal(cb.affectedApplications.length,6);
 const creditLedgerBefore=(await admin.query('SELECT * FROM hon.saas_account_credit_ledger ORDER BY id')).rows;
 const freeBefore=(await admin.query('SELECT * FROM hon.saas_free_periods ORDER BY subscription_id,period_index')).rows;
 await deny(applyReward(await fresh(free10),7),422,'SAAS_REWARD_PAYMENT_ALERT_OPEN');
 const w2Welcome=rows.find(e=>e.reward_kind==='WELCOME_CREDIT'&&e.beneficiary_organization_id===O.W2.id);
 await deny(applyReward(await fresh(w2Welcome)),422,'SAAS_REWARD_PAYMENT_ALERT_OPEN');
 pr=await preview(O.R.id);
 assert.deepEqual(pr.accountCredit,{grantedMinor:40000,appliedMinor:0,availableMinor:0,blockedMinor:40000});
 assert.equal(pr.rewards.find(r=>r.rewardEntryId===free10.id).state,'BLOCKED_REVIEW');
 r0=await draft(subs.R.subscriptionId,0);
 await deny(api.applyAccountCredit(H('owner'),r0.invoiceId,{expectedVersion:r0.version},K()),422,'SAAS_NO_ACCOUNT_CREDIT');
 // W1 asks for its guarantee refund: approval raises a second alert for owner review.
 const w1Req=(await ok(intake(O.W1.id,iso(NOW-HOUR)))).refundRequest;
 assert.equal(w1Req.requestedAmountMinor,4900); // 100% of what was paid; the welcome credit is not cash
 await ok(decideRefund(w1Req,'APPROVE','GUARANTEE_APPROVED'));
 alerts=(await api.readReferralAlerts(H('operator'),'OPEN')).alerts;
 const rf=alerts.find(a=>a.source==='REFUND_REQUEST');
 assert.deepEqual([alerts.length,rf.evidenceKind,rf.referredOrganizationId,rf.refundRequestId],[2,'REFUND_APPROVED',O.W1.id,w1Req.refundRequestId]);
 // ATTRIBUTION_DECIDED needs an actual Champions decision first.
 const resolve=(al,resolution,who='owner')=>api.resolveReferralAlert(H(who),al.alertId,{expectedVersion:al.version,resolution,reference:'Fixture owner review note'},K());
 await deny(resolve(rf,'ATTRIBUTION_DECIDED','operator'),403,'SAAS_FORBIDDEN');
 await deny(resolve(rf,'ATTRIBUTION_DECIDED'),422,'SAAS_ALERT_ATTRIBUTION_UNDECIDED');
 await champions.decideAttribution(H('owner'),attributions[O.W1.id],{decision:'REVERSE',reasonCode:'PAYMENT_REVERSED',expectedVersion:2},K());
 assert.equal((await fresh(lifetime)).status,'REVERSAL_REVIEW'); // 29 qualified: M2 moves the liability to review
 const rfDone=(await ok(resolve(rf,'ATTRIBUTION_DECIDED'))).alert;
 assert.deepEqual([rfDone.status,rfDone.resolution,rfDone.attributionState,rfDone.debtCreated],['RESOLVED','ATTRIBUTION_DECIDED','REVERSED',false]);
 await deny(resolve(rfDone,'NO_QUALIFICATION_IMPACT'),409,'SAAS_TRANSITION_NOT_ALLOWED');
 await deny(applyReward(await fresh(free10),7),422,'SAAS_REWARD_PAYMENT_ALERT_OPEN'); // the chargeback alert is still open
 await ok(resolve(cb,'NO_QUALIFICATION_IMPACT'));
 // Nothing previously applied was reversed, clawed back or turned into a debt.
 assert.deepEqual((await admin.query('SELECT * FROM hon.saas_reward_applications WHERE id=ANY($1::uuid[]) ORDER BY id',[appsBefore.map(a=>a.id)])).rows,appsBefore);
 assert.deepEqual((await admin.query('SELECT * FROM hon.saas_account_credit_ledger WHERE id=ANY($1::uuid[]) ORDER BY id',[creditLedgerBefore.map(a=>a.id)])).rows,creditLedgerBefore);
 assert.deepEqual((await admin.query('SELECT * FROM hon.saas_free_periods ORDER BY subscription_id,period_index')).rows,freeBefore);
 assert.equal((await preview(O.R.id)).rewards.find(r=>r.rewardEntryId===lifetime.id).state,'APPLIED_CONVERSION_BLOCKED');
 // With both alerts resolved, the remaining approved ladder reward applies: 12 total free months.
 await deny(applyReward(await fresh(free10),0),422,'SAAS_REWARD_PERIOD_IN_PAST');
 await deny(applyReward(await fresh(free10),6),422,'SAAS_REWARD_PERIOD_TAKEN');
 await ok(applyReward(await fresh(free10),7));
 const periods=(await admin.query('SELECT period_index FROM hon.saas_free_periods WHERE subscription_id=$1 ORDER BY period_index',[subs.R.subscriptionId])).rows.map(r=>r.period_index);
 assert.deepEqual(periods,[1,2,3,4,5,6,7,8,9,10,11,12]);
 assert.equal((await admin.query("SELECT sum(free_months)::int n FROM hon.saas_reward_applications WHERE application_kind='FREE_PERIODS' AND subscription_id=$1",[subs.R.subscriptionId])).rows[0].n,12);
 pr=await preview(O.R.id);
 assert.deepEqual(pr.freePeriods.map(f=>f.periodIndex),periods);
 assert.deepEqual(pr.accountCredit,{grantedMinor:40000,appliedMinor:0,availableMinor:40000,blockedMinor:0});

 // ---------- 14. deactivation stops new applications ----------
 const fv=(await preview(O.R.id)).fulfillment;
 await ok(api.setRewardFulfillment(H('owner'),{action:'DEACTIVATE',expectedVersion:fv.version,authorizationReference:'Fixture owner pause'},K()));
 await deny(api.applyAccountCredit(H('owner'),r0.invoiceId,{expectedVersion:r0.version},K()),422,'SAAS_REWARDS_NOT_ACTIVE');
 assert.equal((await api.readCreditApplicationPreview(H('operator'),r0.invoiceId)).fulfillment,'INACTIVE');

 // ---------- 15. authorization and isolation ----------
 for(const who of ['support','staffR']){
  await deny(api.readRefundRequests(H(who),undefined),403,'SAAS_FORBIDDEN');await deny(api.readRefundReserve(H(who)),403,'SAAS_FORBIDDEN');
  await deny(api.readRewardPreview(H(who),O.R.id),403,'SAAS_FORBIDDEN');await deny(api.readReferralAlerts(H(who),undefined),403,'SAAS_FORBIDDEN');
  await deny(api.readCreditApplicationPreview(H(who),r0.invoiceId),403,'SAAS_FORBIDDEN');
 }
 await deny(api.readRewardPreview(H('operator'),randomUUID()),404,'SAAS_UNAVAILABLE');
 await sqlDeny(restricted.query('SELECT hon.apply_saas_referral_reward($1,$2,$3::jsonb,$4,$5,$6)',[H('operator'),credit1.id,JSON.stringify({expectedEntryVersion:1,firstPeriodIndex:null}),K(),K(),K()]));

 // ---------- 16. constraints hold with guards disabled; records are append-only ----------
 await rejectedWithoutGuards('saas_refund_requests',"UPDATE hon.saas_refund_requests SET execution_status='EXECUTED'");
 await rejectedWithoutGuards('saas_refund_requests',"UPDATE hon.saas_refund_requests SET subscription_consequence='CANCELLED'");
 await rejectedWithoutGuards('saas_refund_requests',"UPDATE hon.saas_refund_requests SET window_ends_at=window_ends_at+interval '1 day'");
 // A second live request for the same organization is impossible (the guarantee applies once).
 await rejectedWithoutGuards('saas_refund_requests',`INSERT INTO hon.saas_refund_requests(organization_id,subscription_id,invoice_id,offer_kind,first_paid_at,window_ends_at,request_received_at,
  customer_reference,requested_amount_minor,evidence_strength,status,status_reason,version,requested_by_principal_id,created_at)
  SELECT organization_id,subscription_id,invoice_id,offer_kind,first_paid_at,window_ends_at,request_received_at,customer_reference,requested_amount_minor,evidence_strength,
  'REQUESTED','REQUESTED',1,requested_by_principal_id,created_at FROM hon.saas_refund_requests WHERE id=$1`,[raReq.refundRequestId],'23505');
 for(const col of ['prizes_issued','cash_payouts'])await rejectedWithoutGuards('saas_reward_fulfillment',`UPDATE hon.saas_reward_fulfillment SET ${col}=true`);
 await rejectedWithoutGuards('saas_reward_fulfillment',"UPDATE hon.saas_reward_fulfillment SET status='ACTIVE',authorization_reference=NULL");
 await rejectedWithoutGuards('saas_reward_applications',"INSERT INTO hon.saas_reward_applications(reward_entry_id,organization_id,subscription_id,application_kind,credit_minor,status,applied_by_principal_id,applied_at) SELECT reward_entry_id,organization_id,subscription_id,application_kind,credit_minor,status,applied_by_principal_id,applied_at FROM hon.saas_reward_applications WHERE application_kind='ACCOUNT_CREDIT' LIMIT 1",[],'23505');
 await rejectedWithoutGuards('saas_free_periods',"INSERT INTO hon.saas_free_periods SELECT subscription_id,period_index,application_id,recorded_at FROM hon.saas_free_periods LIMIT 1",[],'23505');
 await rejectedWithoutGuards('saas_invoice_lines',"UPDATE hon.saas_invoice_lines SET amount_minor=100 WHERE line_kind='ACCOUNT_CREDIT'");
 await rejectedWithoutGuards('saas_referral_payment_alerts',"UPDATE hon.saas_referral_payment_alerts SET status='OPEN'");
 for(const sql of ['UPDATE hon.saas_reward_applications SET status=status','DELETE FROM hon.saas_account_credit_ledger','DELETE FROM hon.saas_free_periods',
  'UPDATE hon.saas_refund_history SET amount_minor=1',"UPDATE hon.saas_refund_requests SET status='REQUESTED',version=version+1","UPDATE hon.saas_referral_payment_alerts SET status='OPEN',version=version+1",
  'DELETE FROM hon.saas_refund_requests','TRUNCATE hon.saas_reward_applications CASCADE'])
  await sqlDeny(admin.query(sql));
 // A free period cannot be invoiced even by direct insert.
 await sqlDeny(admin.query(`INSERT INTO hon.saas_invoices(organization_id,subscription_id,kind,period_index,service_period_start,service_period_end,plan_code,offer_kind,description,status,version,
  subtotal_minor,tax_status,created_by_principal_id,created_at,updated_at) VALUES($1,$2,'SUBSCRIPTION_PERIOD',5,clock_timestamp(),clock_timestamp()+interval '1 month','CORE','REGULAR_MONTHLY','x','DRAFT',1,14900,'UNRESOLVED',$3,clock_timestamp(),clock_timestamp())`,
  [O.R.id,subs.R.subscriptionId,humans.owner.id]),'23514');

 // ---------- 17. evidence and no unintended effect ----------
 const ev4=(await admin.query(`SELECT (SELECT count(*) FROM hon.saas_requests WHERE status<>'COMPLETED')::int open,
  (SELECT count(*) FROM hon.saas_audit WHERE action_code LIKE 'saas.refund.%' OR action_code LIKE 'saas.rewards.%')::int audit,
  (SELECT count(*) FROM hon.saas_outbox WHERE (event_type LIKE 'saas.refund.%' OR event_type LIKE 'saas.rewards.%') AND payload->'internalOnly'='true'::jsonb AND payload->'executionAllowed'='false'::jsonb)::int inert,
  (SELECT count(*) FROM hon.saas_outbox WHERE payload->'executionAllowed'<>'false'::jsonb)::int live`)).rows[0];
 const b4Commands=(await admin.query("SELECT count(*)::int n FROM hon.saas_requests WHERE status='COMPLETED' AND (operation LIKE 'saas.refund.%' OR operation LIKE 'saas.rewards.%')")).rows[0].n;
 assert.deepEqual(ev4,{open:0,audit:b4Commands,inert:b4Commands,live:0});
 assert.ok(b4Commands>=20,String(b4Commands));
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.saas_refund_requests WHERE execution_status<>'NOT_EXECUTED' OR subscription_consequence<>'BLOCKED_PENDING_TERMS'")).rows[0].n,0);
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.ai_usage_ledger WHERE organization_id=ANY($1::uuid[])',[orgIds()])).rows[0].n,0);
 assert.deepEqual(await untouched(),before,'No entitlement, school-to-family billing, role grant or shared audit row changed.');
 console.log(`PASS: HON refunds and Champions rewards B4 proof — ${b4Commands} B4 commands with exact evidence; first-purchase 30-day eligibility for regular, founder monthly and paid lifetime; approve/deny/evidence with history; duplicate requests refused under 6-way contention; refund reserve; $100 credits 1-4 and welcome credits applied once (6-way contention); credit capped at the invoice and restored on void; zero-total unissuable; 6 then 12 total free months never invoiced with the full allowance; prize manual; lifetime recorded with conversion blocked; chargeback/refund alerts block fulfillment without reversal or debt; no execution, payout or school-billing effect.`);
}finally{
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end()]);}
}
