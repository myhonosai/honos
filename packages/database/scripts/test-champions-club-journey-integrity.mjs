import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
// Champions Club end-to-end journey (M1-M5) through the real API service on a disposable database:
// code -> attribution -> qualification -> automatic reward accrual -> leaderboard -> contest ->
// winner review -> reversal -> consistent liabilities, standings, overview and audit.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost Champions Club URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {ChampionsClubService}=await import('../../../apps/api/dist/champions/champions-club.service.js');
const runtimeDatabase=new RuntimeDatabaseService(),api=new ChampionsClubService(runtimeDatabase);
const httpStatus=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const admin=new pg.Client({connectionString:owner.toString(),ssl:false});
const championsTables=['champions_outbox','champions_audit','champions_contest_history','champions_contest_winners','champions_contest_results','champions_contest_pauses','champions_contest_schools','champions_contest_prizes','champions_contests','champions_leaderboard_holds','champions_leaderboard_preferences','champions_reward_history','champions_reward_entries','champions_reward_policies','champions_attribution_history','champions_attributions','champions_requests','champions_referral_codes','champions_policies'];
const ids=Object.fromEntries(['orgA','schoolA','roleA','orgR','orgR2','orgX'].map(k=>[k,randomUUID()]));
const humans=Object.fromEntries(['owner','operator','staff'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`journey-${k}-${randomUUID()}`}]));
const orgs=()=>[ids.orgA,ids.orgR,ids.orgR2,ids.orgX];
const H=k=>humans[k].subject,K=()=>randomUUID(),iso=d=>new Date(d).toISOString();
async function snapshot(){const out={};for(const t of ['organization_entitlements','memberships','invoices','membership_payment_schedules','audit_events','outbox_events'])out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t ORDER BY 1`)).rows.map(r=>r.r);return out;}
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of championsTables){await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);await admin.query(`DELETE FROM hon.${t}`);await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);}
  const principalIds=Object.values(humans).map(h=>h.id);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs()]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
  await admin.query('DELETE FROM hon.schools WHERE organization_id=ANY($1::uuid[])',[orgs()]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs()]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
async function addOrg(id,name,createdAt='clock_timestamp()'){
 await admin.query(`INSERT INTO hon.organizations(id,legal_name,display_name,created_at) VALUES($1,$2,$2,${createdAt})`,[id,name]);
 await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')",[id]);
}
await admin.connect();
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 await cleanup();
 await admin.query('BEGIN');
 for(const[k,h]of Object.entries(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 await addOrg(ids.orgA,'Journey Dojo LLC',"clock_timestamp()-interval '90 days'");
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Journey Dojo',$1::text,'America/New_York')",[ids.schoolA,ids.orgA]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'CHAMPIONS_STAFF','Fixture role')",[ids.roleA,ids.orgA]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'champions.participate')",[ids.roleA,ids.orgA]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[ids.orgA,ids.schoolA,humans.staff.id,ids.roleA]);
 await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '1 hour'),($2,'HON_HQ_OPERATOR',ARRAY['hq.champions.manage'],clock_timestamp()-interval '1 hour')",[humans.owner.id,humans.operator.id]);
 await admin.query('COMMIT');
 const before=await snapshot();
 const contestStart=Date.now()-3600_000;

 // 1. Program and reward terms (owner publishes; financial activation stays disabled).
 const programDraft=(await api.createPolicyDraft(H('operator'),{attributionWindowDays:30,refundWindowDays:0,minimumPaidDays:0,minimumPaidInvoices:1,paymentVerificationSource:'HQ_OWNER_ATTESTATION',welcomeCreditMinor:10000,termsReference:'Journey program terms (fixture)'},K())).policy;
 await api.publishPolicy(H('owner'),programDraft.policyId,K());
 const rewardDraft=(await api.createRewardPolicyDraft(H('operator'),{referrerCreditMinor:10000,referrerCreditMaxRank:4,welcomeCreditMinor:10000,firstFreeMonthsCount:5,firstFreeMonthsTotal:6,secondFreeMonthsCount:10,secondFreeMonthsTotal:12,prizeCount:20,prizeBudgetMinor:null,lifetimeCount:30,clawbackRule:'UNDECIDED',monthlyRule:'AS_EARNED',annualRule:'AS_EARNED',founderRule:'UNDECIDED',paidLifetimeRule:'OWNER_SUBSTITUTE',termsReference:'Journey reward terms (fixture)'},K())).policy;
 await api.publishRewardPolicy(H('owner'),rewardDraft.policyId,K());

 // 2. The school issues its code; a new organization signs up after it.
 const code=(await api.issueReferralCode(H('staff'),ids.schoolA,K())).code;
 await sleep(5);
 await admin.query('BEGIN');await addOrg(ids.orgR,'Referred Journey Dojo');await addOrg(ids.orgR2,'Second Referred Dojo');await admin.query('COMMIT');

 // 3. HQ records the attribution. Duplicates and self-referral are refused.
 const captureKey=K();
 const attribution=(await api.captureAttribution(H('operator'),{referralCode:code,referredOrganizationId:ids.orgR},captureKey)).attribution;
 assert.equal(attribution.state,'PENDING');
 assert.equal((await api.captureAttribution(H('operator'),{referralCode:code,referredOrganizationId:ids.orgR},captureKey)).replayed,true);
 await assert.rejects(()=>api.captureAttribution(H('owner'),{referralCode:code,referredOrganizationId:ids.orgR},K()),httpStatus(409,'CHAMPIONS_DUPLICATE_ATTRIBUTION'));
 await assert.rejects(()=>api.captureAttribution(H('owner'),{referralCode:code,referredOrganizationId:ids.orgA},K()),httpStatus(422,'CHAMPIONS_SELF_REFERRAL'));
 await assert.rejects(()=>api.captureAttribution(H('staff'),{referralCode:code,referredOrganizationId:ids.orgR2},K()),httpStatus(403));
 const second=(await api.captureAttribution(H('operator'),{referralCode:code,referredOrganizationId:ids.orgR2},K())).attribution;

 // 4. A contest window covering the referral, scheduled and activated by HQ.
 const contestConfig={name:'Journey Cup',description:'End-to-end fixture contest.',termsReference:'Journey contest terms (fixture)',startsAt:iso(contestStart),endsAt:iso(Date.now()+3600_000),
  countBasis:'CAPTURED_AND_QUALIFIED_IN_WINDOW',minimumQualified:1,tieRule:'EARLIEST_TO_REACH',eligibility:{scope:'ALL_ACTIVE_SCHOOLS',tiers:['CORE'],schoolIds:[]},budgetMinor:60000,giftCardCompliance:'UNDECIDED',
  prizes:[{placeFrom:1,placeTo:1,kind:'EXPERIENCE',description:'Team experience day',quantity:1,estimatedUnitCostMinor:50000}]};
 const contest=(await api.commandContest(H('operator'),undefined,{action:'CREATE',...contestConfig},K())).contest;
 await api.commandContest(H('owner'),contest.contestId,{action:'SCHEDULE',expectedVersion:1,schoolVisibility:'ELIGIBLE_SCHOOLS'},K());
 await api.commandContest(H('operator'),contest.contestId,{action:'ACTIVATE',expectedVersion:2},K());

 // 5. The owner qualifies the referral: reward liabilities accrue in the same transaction (M5).
 const qualifyBody={decision:'QUALIFY',reasonCode:'QUALIFICATION_VERIFIED',expectedVersion:1,evidence:{firstPaidAt:iso(Date.now()-1000),paidInvoiceCount:1,reference:'Journey owner attestation'}};
 await assert.rejects(()=>api.decideAttribution(H('operator'),attribution.attributionId,qualifyBody,K()),httpStatus(403));
 const qualifyKey=K();
 assert.equal((await api.decideAttribution(H('owner'),attribution.attributionId,qualifyBody,qualifyKey)).attribution.state,'QUALIFIED');
 assert.equal((await api.decideAttribution(H('owner'),attribution.attributionId,qualifyBody,qualifyKey)).replayed,true,'Idempotent: no second accrual.');
 let ledger=await api.readRewardLedger(H('operator'),undefined);
 assert.deepEqual(ledger.entries.map(e=>[e.rewardKind,e.status]).sort(),[['REFERRER_CREDIT','ACCRUED'],['WELCOME_CREDIT','ACCRUED']],'Accrued automatically, without a manual reconcile.');
 assert.equal(ledger.entries.find(e=>e.rewardKind==='WELCOME_CREDIT').beneficiaryOrganizationId,ids.orgR);
 assert.equal((await api.reconcileRewards(H('operator'),ids.schoolA,K())).accrued,0,'Manual reconcile finds nothing missing.');
 // A rejected referral accrues nothing.
 await api.decideAttribution(H('operator'),second.attributionId,{decision:'REJECT',reasonCode:'NOT_ELIGIBLE',expectedVersion:1},K());
 assert.equal((await api.readRewardLedger(H('operator'),undefined)).entries.length,2);

 // 6. Permanent leaderboard, school statistics and rewards agree.
 await sleep(5);
 const board=await api.readHqLeaderboard(H('operator'),{});
 assert.deepEqual(board.standings.map(s=>[s.schoolId,s.qualifiedReferrals,s.rank]),[[ids.schoolA,1,1]]);
 const stats=await api.readSchoolStatistics(H('staff'),ids.schoolA);
 assert.deepEqual(stats.referrals,{pending:0,qualified:1,rejected:1,refunded:0,reversed:0});
 assert.deepEqual(stats.milestones.reached,[{rewardKind:'REFERRER_CREDIT',milestoneCount:1}]);assert.equal(stats.allTimeRank,1);
 assert.equal((await api.readSchoolRewards(H('staff'),ids.schoolA)).rewards.length,1,'The referrer sees its own credit, not the referred school\'s welcome credit.');

 // 7. Contest standings count the referral; the owner ends, reviews and completes.
 let detail=await api.readContest(H('operator'),contest.contestId);
 assert.deepEqual(detail.standings.map(s=>[s.schoolId,s.qualifiedReferrals,s.eligible]),[[ids.schoolA,1,true]]);
 assert.equal((await api.readSchoolContests(H('staff'),ids.schoolA)).contests[0].you.rank,1);
 await api.commandContest(H('owner'),contest.contestId,{action:'END',expectedVersion:3},K());
 await api.commandContest(H('operator'),contest.contestId,{action:'PROPOSE_WINNERS',expectedVersion:4},K());
 detail=await api.readContest(H('owner'),contest.contestId);
 const winner=detail.winners[0];assert.deepEqual([winner.schoolId,winner.status,winner.estimatedCostMinor],[ids.schoolA,'PROPOSED',50000]);
 await api.commandContest(H('owner'),contest.contestId,{action:'APPROVE_WINNER',expectedVersion:5,winnerId:winner.winnerId},K());
 await api.commandContest(H('owner'),contest.contestId,{action:'COMPLETE',expectedVersion:6},K());
 assert.equal((await api.readSchoolContests(H('staff'),ids.schoolA)).contests[0].won,true);

 // 8. Overview before reversal.
 let overview=await api.readOverview(H('operator'));
 assert.deepEqual([overview.program.status,overview.rewardProgram.status,overview.financialActivation,overview.automaticTransitions],['PUBLISHED','PUBLISHED','DISABLED','NOT_CONFIGURED']);
 assert.deepEqual(overview.attributions,{pending:0,qualified:1,rejected:1,refunded:0,reversed:0});
 assert.deepEqual([overview.rankedSchools,overview.referralCodes.active,overview.rewardLiabilities.entries,overview.rewardLiabilities.creditMinor,overview.contests.completed,overview.contestLiabilities.approvedWinnerCostMinor],[1,1,2,20000,1,50000]);
 await assert.rejects(()=>api.readOverview(H('staff')),httpStatus(403));

 // 9. The payment is reversed: liabilities go to review in the same transaction, the permanent
 //    standings drop the school, and the completed contest's frozen result does not move.
 await api.decideAttribution(H('owner'),attribution.attributionId,{decision:'REVERSE',reasonCode:'PAYMENT_REVERSED',expectedVersion:2},K());
 ledger=await api.readRewardLedger(H('owner'),'REVERSAL_REVIEW');
 assert.equal(ledger.entries.length,2,'Both liabilities moved to review, none voided.');
 assert.equal((await api.readHqLeaderboard(H('operator'),{})).standings.length,0);
 assert.equal((await api.readSchoolStatistics(H('staff'),ids.schoolA)).referrals.reversed,1);
 assert.deepEqual((await api.readContest(H('owner'),contest.contestId)).standings.map(s=>s.qualifiedReferrals),[1],'Frozen contest results are final.');
 overview=await api.readOverview(H('operator'));
 assert.deepEqual([overview.attributions.qualified,overview.attributions.reversed,overview.rankedSchools,overview.rewardLiabilities.inReview],[0,1,0,2]);

 // 10. Audit and consistency: every command has exactly one request, audit row and inert outbox
 //     event; attribution decisions record their reward reconciliation; nothing outside
 //     Champions changed (no billing, entitlement, membership, invoice or shared audit effect).
 const evidence=(await admin.query("SELECT (SELECT count(*)::int FROM hon.champions_requests WHERE status='COMPLETED') completed,(SELECT count(*)::int FROM hon.champions_requests WHERE status<>'COMPLETED') open,(SELECT count(*)::int FROM hon.champions_audit) audits,(SELECT count(*)::int FROM hon.champions_outbox WHERE payload->'internalOnly'='true'::jsonb AND payload->'executionAllowed'='false'::jsonb) inert,(SELECT count(*)::int FROM hon.champions_outbox) outbox")).rows[0];
 assert.equal(evidence.open,0);assert.equal(evidence.audits,evidence.completed);assert.equal(evidence.outbox,evidence.audits);assert.equal(evidence.inert,evidence.outbox);
 const decisions=(await admin.query("SELECT next_state FROM hon.champions_audit WHERE action_code='champions.attribution.decide' ORDER BY occurred_at")).rows.map(r=>r.next_state);
 assert.deepEqual(decisions.map(d=>[d.state,d.rewardsReconciled.accrued,d.rewardsReconciled.flaggedForReview]),[['QUALIFIED',2,0],['REJECTED',0,0],['REVERSED',0,2]]);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.champions_reward_entries WHERE status='VOIDED'")).rows[0].n,0);
 const after=await snapshot();
 for(const t of Object.keys(before))assert.deepEqual(after[t].filter(r=>!r.includes(ids.orgR)&&!r.includes(ids.orgR2)),before[t].filter(r=>!r.includes(ids.orgR)&&!r.includes(ids.orgR2)),t);
 console.log('PASS: Champions Club end-to-end journey through the API service: owner-published program and reward terms, school code, HQ attribution with replay/duplicate/self-referral/authority refusals, owner QUALIFY accruing referrer and welcome liabilities in the same transaction (idempotent; reconcile finds nothing missing), REJECT accruing nothing, consistent permanent leaderboard/statistics/rewards, contest standings, end, winner proposal, approval and completion, overview totals, REVERSE moving liabilities to review (never voiding), dropping the school from permanent standings and leaving frozen contest results final, one request/audit/inert outbox per command with reconciliation recorded on each decision, and no billing, entitlement, membership, invoice or shared-audit effect.');
}finally{
 try{await cleanup();}finally{await Promise.all([admin.end(),runtimeDatabase.onModuleDestroy()]);}
}
