import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// Champions Club reward accounting (0149) integrity proof. Disposable localhost fixture only.
// Liabilities are recorded; nothing is applied to billing, entitlements, memberships or payments.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost Champions Club URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {ChampionsClubService}=await import('../../../apps/api/dist/champions/champions-club.service.js');
const runtimeDatabase=new RuntimeDatabaseService(),service=new ChampionsClubService(runtimeDatabase);
const httpStatus=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const championsTables=['champions_outbox','champions_audit','champions_leaderboard_holds','champions_leaderboard_preferences','champions_reward_history','champions_reward_entries','champions_reward_policies','champions_attribution_history','champions_attributions','champions_requests','champions_referral_codes','champions_policies'];
const ids=Object.fromEntries(['orgA','schoolA','orgR1','schoolR1','staffRole','r1Role','m1Policy','code'].map(k=>[k,randomUUID()]));
const humans=Object.fromEntries(['owner','operator','support','staff','r1staff'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`rewards-${k}-${randomUUID()}`}]));
const referred=[];// [{org, attribution}]
const orgs=()=>[ids.orgA,ids.orgR1,...referred.map(r=>r.org)];
const sqlDeny=(fn,code='42501',message)=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.stack);if(message)assert.equal(e.message,message);return true;});
const call=async(fn,args,types)=>(await restricted.query(`SELECT hon.${fn}(${args.map((_,i)=>`$${i+1}${types?.[i]?`::${types[i]}`:''}`).join(',')}) r`,args)).rows[0].r;
const draft=(who,p,key=randomUUID())=>call('create_champions_reward_policy_draft',[humans[who].subject,JSON.stringify(p),key,randomUUID(),randomUUID()],[null,'jsonb']);
const publish=(who,policy,key=randomUUID())=>call('publish_champions_reward_policy',[humans[who].subject,policy,key,randomUUID(),randomUUID()]);
const reconcile=(who,key=randomUUID(),school=ids.schoolA)=>call('reconcile_champions_rewards',[humans[who].subject,school,key,randomUUID(),randomUUID()]);
const decide=(who,entry,p,key=randomUUID())=>call('decide_champions_reward',[humans[who].subject,entry,JSON.stringify(p),key,randomUUID(),randomUUID()],[null,null,'jsonb']);
const ledger=(who,status=null)=>call('read_champions_reward_ledger_from_hq',[humans[who].subject,status]);
const program=who=>call('read_champions_reward_program_from_hq',[humans[who].subject]);
const schoolRewards=(who,school=ids.schoolA)=>call('read_champions_school_rewards',[humans[who].subject,school]);
const decideAttribution=(id,version)=>call('decide_champions_attribution',[humans.owner.subject,id,JSON.stringify({decision:'REVERSE',reasonCode:'PAYMENT_REVERSED',expectedVersion:version}),randomUUID(),randomUUID(),randomUUID()],[null,null,'jsonb']);
// The owner-approved ladder: $100 at 1-4, 6 months at 5, 12 months total at 10, prize at 20, lifetime at 30.
const terms=(patch={})=>({referrerCreditMinor:10000,referrerCreditMaxRank:4,welcomeCreditMinor:10000,firstFreeMonthsCount:5,firstFreeMonthsTotal:6,
 secondFreeMonthsCount:10,secondFreeMonthsTotal:12,prizeCount:20,prizeBudgetMinor:null,lifetimeCount:30,clawbackRule:'UNDECIDED',
 monthlyRule:'AS_EARNED',annualRule:'AS_EARNED',founderRule:'UNDECIDED',paidLifetimeRule:'OWNER_SUBSTITUTE',termsReference:'Fixture reward terms (not legal terms)',...patch});
const approve=(version,patch={})=>({decision:'APPROVE',expectedVersion:version,planBasis:'MONTHLY',substitute:null,prize:null,...patch});
async function entries(){return (await admin.query('SELECT * FROM hon.champions_reward_entries ORDER BY accrued_at, milestone_count NULLS LAST, id')).rows;}
const live=async(kind)=>(await entries()).filter(e=>e.reward_kind===kind&&e.status!=='VOIDED');
async function qualifyReferrals(n){
 await admin.query('BEGIN');
 for(let i=0;i<n;i++){
  const org=randomUUID(),attribution=randomUUID();
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,created_at) VALUES($1,'Referred fixture','Referred fixture',clock_timestamp())",[org]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')",[org]);
  await admin.query(`INSERT INTO hon.champions_attributions(id,referral_code_id,referrer_organization_id,referrer_school_id,referred_organization_id,state,state_reason,version,
   captured_by_principal_id,captured_at,qualified_policy_id,qualified_at,qualification_evidence,decided_by_principal_id,decided_at)
   VALUES($1,$2,$3,$4,$5,'QUALIFIED','QUALIFICATION_VERIFIED',2,$6,clock_timestamp()-interval '40 days',$7,clock_timestamp(),'{"source":"HQ_OWNER_ATTESTATION"}',$6,clock_timestamp())`,
   [attribution,ids.code,ids.orgA,ids.schoolA,org,humans.owner.id,ids.m1Policy]);
  referred.push({org,attribution});
 }
 await admin.query('COMMIT');
}
async function snapshot(){const out={};for(const t of ['organization_entitlements','memberships','invoices','membership_payment_schedules','audit_events','outbox_events','principal_role_grants','hq_operator_grants'])out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t ORDER BY 1`)).rows.map(r=>r.r);return out;}
async function cleanup(){
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
await Promise.all([admin.connect(),restricted.connect()]);
try{
 const marker=(await admin.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
 assert.equal(marker.marker,'HON disposable Champions Club validation');
 for(const t of ['champions_reward_policies','champions_reward_entries','champions_reward_history'])await sqlDeny(()=>restricted.query(`SELECT * FROM hon.${t}`));
 for(const signature of ['guard_champions_rewards()','champions_reward_json(hon.champions_reward_entries)','champions_reward_policy_json(hon.champions_reward_policies)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",['hon.'+signature])).rows[0].allowed,false,signature);

 // ---------- fixture ----------
 await cleanup();
 await admin.query('BEGIN');
 for(const org of [ids.orgA,ids.orgR1]){await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,created_at) VALUES($1,'Rewards fixture','Rewards fixture',clock_timestamp()-interval '60 days')",[org]);await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '60 days')",[org]);}
 for(const[school,org]of [[ids.schoolA,ids.orgA],[ids.schoolR1,ids.orgR1]])await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Rewards fixture school',$1::text,'America/New_York')",[school,org]);
 for(const[who,h]of Object.entries(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[role,org]of [[ids.staffRole,ids.orgA],[ids.r1Role,ids.orgR1]]){await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'CHAMPIONS_STAFF','Fixture role')",[role,org]);await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'champions.participate')",[role,org]);}
 for(const[who,role,org,school]of [['staff',ids.staffRole,ids.orgA,ids.schoolA],['r1staff',ids.r1Role,ids.orgR1,ids.schoolR1]])
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[org,school,humans[who].id,role]);
 for(const[who,role,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.champions.manage']],['support','HON_HQ_SUPPORT',['hq.champions.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,role,perms]);
 await admin.query(`INSERT INTO hon.champions_policies(id,policy_version,status,attribution_window_days,refund_window_days,minimum_paid_days,minimum_paid_invoices,payment_verification_source,
  welcome_credit_minor,terms_reference,created_by_principal_id,published_by_principal_id,published_at) VALUES($1,1,'PUBLISHED',90,30,30,1,'HQ_OWNER_ATTESTATION',10000,'Fixture program terms',$2,$2,clock_timestamp())`,[ids.m1Policy,humans.owner.id]);
 await admin.query("INSERT INTO hon.champions_referral_codes(id,organization_id,school_id,code,created_by_principal_id,created_at) VALUES($1,$2,$3,'REWARDS234',$4,clock_timestamp()-interval '50 days')",[ids.code,ids.orgA,ids.schoolA,humans.staff.id]);
 // The R1 school is itself a referred school, so its staff can see their own welcome credit.
 await admin.query(`INSERT INTO hon.champions_attributions(referral_code_id,referrer_organization_id,referrer_school_id,referred_organization_id,state,state_reason,version,
  captured_by_principal_id,captured_at,qualified_policy_id,qualified_at,qualification_evidence,decided_by_principal_id,decided_at)
  VALUES($1,$2,$3,$4,'QUALIFIED','QUALIFICATION_VERIFIED',2,$5,clock_timestamp()-interval '45 days',$6,clock_timestamp(),'{"source":"HQ_OWNER_ATTESTATION"}',$5,clock_timestamp())`,
  [ids.code,ids.orgA,ids.schoolA,ids.orgR1,humans.owner.id,ids.m1Policy]);
 await admin.query('COMMIT');
 const before=await snapshot();

 // ---------- reward terms ----------
 for(const who of ['support','staff'])await sqlDeny(()=>program(who),'42501');
 assert.deepEqual(await program('operator'),{published:null,drafts:[],financialActivation:'DISABLED'});
 await sqlDeny(()=>reconcile('operator'),'23514','CHAMPIONS_POLICY_UNDECIDED');
 for(const bad of [{...terms(),extra:1},(({prizeCount,...rest})=>rest)(terms()),terms({referrerCreditMinor:'10000'}),terms({clawbackRule:null}),terms({prizeBudgetMinor:-1}),terms({financialActivation:true})])
  await sqlDeny(()=>draft('operator',bad),'22023','INVALID_CHAMPIONS_INPUT');
 // Ladder order, inclusive totals and the paid-lifetime rule are database constraints.
 for(const bad of [terms({firstFreeMonthsCount:4}),terms({secondFreeMonthsTotal:5}),terms({prizeCount:10}),terms({lifetimeCount:20}),terms({paidLifetimeRule:'AS_EARNED'}),terms({monthlyRule:'FREE'})])
  await sqlDeny(()=>draft('operator',bad),'23514');
 for(const who of ['support','staff'])await sqlDeny(()=>draft(who,terms()),'42501');
 const incomplete=(await draft('operator',terms({lifetimeCount:null}))).policy;
 assert.equal(incomplete.status,'DRAFT');assert.equal(incomplete.financialActivation,'DISABLED');assert.equal(incomplete.aiAllowance,'FULL_PLAN_ALLOWANCE');
 await sqlDeny(()=>publish('operator',incomplete.policyId),'42501');
 await sqlDeny(()=>publish('owner',incomplete.policyId),'23514','CHAMPIONS_POLICY_UNDECIDED');
 const v1=(await draft('operator',terms())).policy;
 assert.equal((await publish('owner',v1.policyId)).policy.status,'PUBLISHED');

 // ---------- accrual: 1 qualified (R1) + 2 more ----------
 await qualifyReferrals(2);
 for(const who of ['support','staff'])await sqlDeny(()=>reconcile(who),'42501');
 await sqlDeny(()=>reconcile('operator',randomUUID(),randomUUID()),'P0002');
 const key3=randomUUID(),r3=await reconcile('operator',key3);
 assert.equal(r3.qualifiedCount,3);assert.equal(r3.accrued,6);assert.equal(r3.flaggedForReview,0);assert.equal(r3.financialActivation,'DISABLED');
 assert.deepEqual(await reconcile('operator',key3),{...r3,replayed:true});
 assert.equal((await reconcile('owner')).accrued,0,'Reconciliation is idempotent in effect.');
 assert.deepEqual((await live('REFERRER_CREDIT')).map(e=>[e.milestone_ordinal,e.credit_minor,e.beneficiary_organization_id]),[[1,10000,ids.orgA],[2,10000,ids.orgA],[3,10000,ids.orgA]]);
 const welcome=await live('WELCOME_CREDIT');
 assert.equal(welcome.length,3);assert(welcome.every(e=>e.credit_minor===10000&&e.beneficiary_role==='REFERRED'&&e.beneficiary_organization_id!==ids.orgA));

 // 5 qualified: the 4th credit and 6 free months (credits stop after rank 4).
 await qualifyReferrals(2);
 const r5=await reconcile('operator');
 assert.equal(r5.qualifiedCount,5);assert.equal(r5.accrued,4);
 assert.deepEqual((await live('FREE_MONTHS')).map(e=>[e.milestone_ordinal,e.milestone_count,e.free_months,e.ai_allowance]),[[1,5,6,'FULL_PLAN_ALLOWANCE']]);
 assert.equal((await live('REFERRER_CREDIT')).length,4);
 const view5=await schoolRewards('staff');
 assert.equal(view5.qualifiedReferrals,5);assert.deepEqual(view5.nextMilestone,{rewardKind:'FREE_MONTHS',milestoneCount:10,remaining:5});
 assert.deepEqual(view5.rewards.map(r=>r.rewardKind),['REFERRER_CREDIT','REFERRER_CREDIT','REFERRER_CREDIT','REFERRER_CREDIT','FREE_MONTHS']);
 assert.equal(view5.financialActivation,'DISABLED');
 const r1View=await schoolRewards('r1staff',ids.schoolR1);
 assert.deepEqual(r1View.rewards.map(r=>[r.rewardKind,r.beneficiaryRole,r.creditMinor]),[['WELCOME_CREDIT','REFERRED',10000]]);
 assert.equal(JSON.stringify(r1View).includes(ids.orgA)||JSON.stringify(r1View).includes(ids.schoolA),false,'A referred school never sees its referrer.');
 for(const who of ['owner','operator','r1staff'])await sqlDeny(()=>schoolRewards(who),'42501');

 // 10, 20, 30: second free-month milestone (12 total, including the 6), prize, lifetime.
 await qualifyReferrals(25);
 const r30=await reconcile('operator');
 assert.equal(r30.qualifiedCount,30);assert.equal(r30.accrued,3+25);
 const months=await live('FREE_MONTHS');
 assert.deepEqual(months.map(e=>[e.milestone_ordinal,e.milestone_count,e.free_months]),[[1,5,6],[2,10,6]]);
 assert.equal(months.reduce((n,e)=>n+e.free_months,0),12);
 const [prize]=await live('PRIZE');assert.equal(prize.milestone_count,20);assert.equal(prize.prize_cost_minor,null);
 const [lifetime]=await live('LIFETIME_MEMBERSHIP');assert.equal(lifetime.milestone_count,30);assert.equal(lifetime.lifetime_tier,'CORE');assert.equal(lifetime.ai_allowance,'FULL_PLAN_ALLOWANCE');
 assert.equal((await live('WELCOME_CREDIT')).length,30);
 assert.equal((await schoolRewards('staff')).nextMilestone,null);

 // ---------- approval controls (owner only, rules from the published policy) ----------
 const [credit1,credit2,credit3,credit4]=await live('REFERRER_CREDIT');
 for(const bad of [{decision:'APPROVE',expectedVersion:1,planBasis:'MONTHLY',substitute:null},approve(1,{planBasis:'WEEKLY'}),approve(1,{substitute:{description:'x'}}),
   approve(1,{prize:{kind:'CAR',description:'x',costMinor:1}}),{decision:'VOID',expectedVersion:1,reasonCode:'BORED'},{decision:'RETAIN',expectedVersion:1,note:'x'},{decision:'FULFILL',expectedVersion:1}])
  await sqlDeny(()=>decide('owner',credit1.id,bad),'22023','INVALID_CHAMPIONS_INPUT');
 for(const who of ['operator','support','staff'])await sqlDeny(()=>decide(who,credit1.id,approve(1)),'42501');
 await sqlDeny(()=>decide('owner',randomUUID(),approve(1)),'P0002');
 await sqlDeny(()=>decide('owner',credit1.id,approve(2)),'40001','CHAMPIONS_VERSION_CONFLICT');
 await sqlDeny(()=>decide('owner',credit1.id,approve(1,{substitute:{description:'Gift card',valueMinor:10000}})),'23514','CHAMPIONS_REWARD_SUBSTITUTE_MISMATCH');
 await sqlDeny(()=>decide('owner',credit1.id,approve(1,{planBasis:'FOUNDER'})),'23514','CHAMPIONS_REWARD_RULE_UNDECIDED');
 await sqlDeny(()=>decide('owner',credit1.id,approve(1,{planBasis:'PAID_LIFETIME'})),'23514','CHAMPIONS_REWARD_SUBSTITUTE_MISMATCH');
 await sqlDeny(()=>decide('owner',credit1.id,approve(1,{prize:{kind:'ELECTRONICS',description:'Tablet',costMinor:50000}})),'22023');
 const approveKey=randomUUID();
 const approved1=await decide('owner',credit1.id,approve(1),approveKey);
 assert.equal(approved1.entry.status,'APPROVED');assert.equal(approved1.entry.fulfillmentForm,'AS_EARNED');assert.equal(approved1.entry.planBasis,'MONTHLY');
 assert.deepEqual(await decide('owner',credit1.id,approve(1),approveKey),{...approved1,replayed:true});
 await sqlDeny(()=>decide('owner',credit1.id,approve(2)),'40001','CHAMPIONS_TRANSITION_NOT_ALLOWED');
 // An existing paid-lifetime member gets an owner-recorded substitute, never a duplicate.
 const sub=await decide('owner',credit2.id,approve(1,{planBasis:'PAID_LIFETIME',substitute:{description:'Account credit toward add-ons',valueMinor:10000}}));
 assert.equal(sub.entry.fulfillmentForm,'OWNER_SUBSTITUTE');assert.deepEqual(sub.entry.substitute,{description:'Account credit toward add-ons',valueMinor:10000});
 await sqlDeny(()=>decide('owner',prize.id,approve(1,{prize:{kind:'ELECTRONICS',description:'Tablet',costMinor:50000}})),'23514','CHAMPIONS_REWARD_RULE_UNDECIDED');
 await sqlDeny(()=>decide('owner',prize.id,approve(1)),'22023');
 // Fraud void is owner judgment on any live entry, independent of the clawback rule.
 const fraud=await decide('owner',credit4.id,{decision:'VOID',expectedVersion:1,reasonCode:'FRAUD_CONFIRMED'});
 assert.equal(fraud.entry.status,'VOIDED');assert.equal(fraud.entry.voidReason,'FRAUD_CONFIRMED');
 await sqlDeny(()=>decide('owner',credit4.id,{decision:'VOID',expectedVersion:2,reasonCode:'DUPLICATE'}),'40001','CHAMPIONS_TRANSITION_NOT_ALLOWED');
 await sqlDeny(()=>decide('owner',credit3.id,{decision:'VOID',expectedVersion:1,reasonCode:'BASIS_REVERSED'}),'40001','CHAMPIONS_TRANSITION_NOT_ALLOWED');
 // A voided milestone is re-accrued as a new entry while its basis still holds.
 assert.equal((await reconcile('operator')).accrued,1);
 const credit4b=(await live('REFERRER_CREDIT')).find(e=>e.milestone_ordinal===4);assert.notEqual(credit4b.id,credit4.id);

 // ---------- reversals: liabilities go to review, never silently erased ----------
 const reversedRef=referred.at(-1);
 assert.equal((await decideAttribution(reversedRef.attribution,2)).attribution.state,'REVERSED');
 const r29=await reconcile('operator');
 assert.equal(r29.qualifiedCount,29);assert.equal(r29.flaggedForReview,2);assert.equal(r29.accrued,0);
 const lifetimeReview=(await entries()).find(e=>e.id===lifetime.id);assert.equal(lifetimeReview.status,'REVERSAL_REVIEW');assert.equal(lifetimeReview.status_before_review,'ACCRUED');
 const welcomeReview=(await entries()).find(e=>e.attribution_id===reversedRef.attribution);assert.equal(welcomeReview.status,'REVERSAL_REVIEW');
 await sqlDeny(()=>decide('owner',lifetime.id,{decision:'VOID',expectedVersion:2,reasonCode:'BASIS_REVERSED'}),'23514','CHAMPIONS_REWARD_RULE_UNDECIDED');
 await sqlDeny(()=>decide('owner',lifetime.id,{decision:'RETAIN',expectedVersion:2}),'23514','CHAMPIONS_REWARD_RULE_UNDECIDED');
 await sqlDeny(()=>decide('owner',lifetime.id,approve(2)),'40001','CHAMPIONS_TRANSITION_NOT_ALLOWED');
 // The basis returns: the entry is restored to its prior state.
 await qualifyReferrals(1);
 const r30b=await reconcile('operator');
 assert.equal(r30b.restored,1);assert.equal(r30b.accrued,1);assert.equal(r30b.flaggedForReview,0);
 assert.equal((await entries()).find(e=>e.id===lifetime.id).status,'ACCRUED');
 assert.equal((await entries()).find(e=>e.id===welcomeReview.id).status,'REVERSAL_REVIEW','A reversed referral welcome stays in review.');
 const newest=referred.at(-1);
 assert.equal((await decideAttribution(newest.attribution,2)).attribution.state,'REVERSED');
 assert.equal((await reconcile('operator')).flaggedForReview,2);

 // ---------- owner decides the clawback rule and prize budget (new policy version) ----------
 // The new ladder moves the first free-month milestone to 6; earned milestones are not duplicated.
 const v2=(await draft('operator',terms({clawbackRule:'VOID_UNFULFILLED',prizeBudgetMinor:150000,founderRule:'AS_EARNED',firstFreeMonthsCount:6}))).policy;
 assert.equal((await publish('owner',v2.policyId)).retiredPolicyId,v1.policyId);
 assert.equal((await reconcile('operator')).accrued,0);
 assert.equal((await live('FREE_MONTHS')).length,2);
 const lifetimeNow=(await entries()).find(e=>e.id===lifetime.id);
 await sqlDeny(()=>decide('owner',lifetime.id,{decision:'RETAIN',expectedVersion:lifetimeNow.version}),'23514','CHAMPIONS_CLAWBACK_NOT_PERMITTED');
 const voided=await decide('owner',welcomeReview.id,{decision:'VOID',expectedVersion:welcomeReview.version,reasonCode:'BASIS_REVERSED'});
 assert.equal(voided.entry.status,'VOIDED');
 assert.equal((await reconcile('operator')).accrued,0,'A voided welcome for a reversed referral is not re-accrued.');
 await sqlDeny(()=>decide('owner',prize.id,approve(1,{prize:{kind:'EXPERIENCE',description:'Seminar trip',costMinor:150001}})),'23514','CHAMPIONS_PRIZE_OVER_BUDGET');
 const prizeApproved=await decide('owner',prize.id,approve(1,{planBasis:'FOUNDER',prize:{kind:'ELECTRONICS',description:'Tablet for the front desk',costMinor:80000}}));
 assert.deepEqual(prizeApproved.entry.prize,{kind:'ELECTRONICS',description:'Tablet for the front desk',costMinor:80000});
 // Retaining instead: a later version sets RETAIN_EARNED.
 const v3=(await draft('owner',terms({clawbackRule:'RETAIN_EARNED',prizeBudgetMinor:150000,founderRule:'AS_EARNED'}))).policy;
 await publish('owner',v3.policyId);
 await sqlDeny(()=>decide('owner',lifetime.id,{decision:'VOID',expectedVersion:lifetimeNow.version,reasonCode:'BASIS_REVERSED'}),'23514','CHAMPIONS_CLAWBACK_NOT_PERMITTED');
 const retained=await decide('owner',lifetime.id,{decision:'RETAIN',expectedVersion:lifetimeNow.version});
 assert.equal(retained.entry.status,'ACCRUED');assert.equal(retained.entry.retained,true);
 assert.equal((await reconcile('operator')).flaggedForReview,0,'Retained entries are not flagged again.');

 // ---------- ledger and liabilities ----------
 const book=await ledger('operator');
 assert.equal(book.financialActivation,'DISABLED');assert.equal(book.currency,'USD');assert.equal(book.limit,200);
 const all=await entries();
 assert.equal(book.entries.length,all.length);
 const group=(status,kind)=>book.liabilities.find(l=>l.status===status&&l.rewardKind===kind);
 assert.deepEqual(group('APPROVED','REFERRER_CREDIT'),{status:'APPROVED',rewardKind:'REFERRER_CREDIT',entries:2,creditMinor:20000,freeMonths:0,prizeCostMinor:0,substituteValueMinor:10000});
 assert.equal(group('ACCRUED','FREE_MONTHS').freeMonths,12);
 assert.equal(group('APPROVED','PRIZE').prizeCostMinor,80000);
 assert.equal(group('ACCRUED','LIFETIME_MEMBERSHIP').entries,1);
 assert.equal(book.liabilities.some(l=>l.status==='VOIDED'),false,'Voided entries are not liabilities.');
 const liveWelcome=all.filter(e=>e.reward_kind==='WELCOME_CREDIT'&&e.status!=='VOIDED').reduce((n,e)=>n+e.credit_minor,0);
 assert.equal(book.liabilities.filter(l=>l.rewardKind==='WELCOME_CREDIT').reduce((n,l)=>n+l.creditMinor,0),liveWelcome);
 assert.equal((await ledger('owner','VOIDED')).entries.length,2);
 await sqlDeny(()=>ledger('operator','PAID'),'22023');
 for(const who of ['support','staff'])await sqlDeny(()=>ledger(who),'42501');

 // ---------- evidence and immutability ----------
 const history=(await admin.query('SELECT from_status,to_status,version,reason FROM hon.champions_reward_history WHERE entry_id=$1 ORDER BY version',[lifetime.id])).rows;
 assert.deepEqual(history.map(h=>[h.from_status,h.to_status,h.reason]),[[null,'ACCRUED','ACCRUED'],['ACCRUED','REVERSAL_REVIEW','BASIS_LOST'],['REVERSAL_REVIEW','ACCRUED','BASIS_RESTORED'],['ACCRUED','REVERSAL_REVIEW','BASIS_LOST'],['REVERSAL_REVIEW','ACCRUED','RETAINED']]);
 const evidence=(await admin.query("SELECT (SELECT count(*)::int FROM hon.champions_requests WHERE status='COMPLETED') completed,(SELECT count(*)::int FROM hon.champions_requests WHERE status<>'COMPLETED') open,(SELECT count(*)::int FROM hon.champions_audit) audits,(SELECT count(*)::int FROM hon.champions_outbox WHERE payload->'internalOnly'='true'::jsonb AND payload->'executionAllowed'='false'::jsonb) inert")).rows[0];
 assert.equal(evidence.open,0);assert.equal(evidence.audits,evidence.completed);assert.equal(evidence.inert,evidence.audits);
 for(const sql of ["UPDATE hon.champions_reward_entries SET credit_minor=0","UPDATE hon.champions_reward_entries SET beneficiary_organization_id=referrer_organization_id, version=version+1 WHERE reward_kind='WELCOME_CREDIT'",
   "UPDATE hon.champions_reward_entries SET status='ACCRUED', version=version+1 WHERE status='VOIDED'","UPDATE hon.champions_reward_entries SET retained=false, version=version+1 WHERE retained",
   "UPDATE hon.champions_reward_entries SET prize_cost_minor=1, version=version+1 WHERE reward_kind='PRIZE'","DELETE FROM hon.champions_reward_entries","TRUNCATE hon.champions_reward_history",
   "UPDATE hon.champions_reward_history SET reason='APPROVED'","UPDATE hon.champions_reward_policies SET lifetime_count=40","DELETE FROM hon.champions_reward_policies"])
  await sqlDeny(()=>admin.query(sql),'42501');
 await admin.query('ALTER TABLE hon.champions_reward_policies DISABLE TRIGGER champions_guarded');
 try{await sqlDeny(()=>admin.query('UPDATE hon.champions_reward_policies SET financial_activation=true'),'23514');}finally{await admin.query('ALTER TABLE hon.champions_reward_policies ENABLE TRIGGER champions_guarded');}
 // Nothing was applied: entitlements, memberships, invoices, payment schedules and shared audit are untouched.
 const after=await snapshot();
 const strip=rows=>rows.filter(r=>!referred.some(x=>r.includes(x.org)));
 for(const t of Object.keys(before))assert.deepEqual(strip(after[t]),strip(before[t]),t);

 // ---------- API service on real output ----------
 const apiProgram=await service.readRewardProgram(humans.operator.subject);
 assert.equal(apiProgram.published.policyId,v3.policyId);
 const apiLedger=await service.readRewardLedger(humans.owner.subject,'APPROVED');
 assert(apiLedger.entries.every(e=>e.status==='APPROVED'));
 const apiSchool=await service.readSchoolRewards(humans.staff.subject,ids.schoolA);
 assert.equal(apiSchool.qualifiedReferrals,29,"31 qualified, 2 later reversed");
 const apiReconcile=await service.reconcileRewards(humans.operator.subject,ids.schoolA,randomUUID());
 assert.equal(apiReconcile.accrued,0);
 await assert.rejects(()=>service.decideReward(humans.owner.subject,credit3.id,approve(1,{planBasis:'MONTHLY',substitute:{description:'x',valueMinor:1}}),randomUUID()),httpStatus(422,'CHAMPIONS_REWARD_SUBSTITUTE_MISMATCH'));
 assert.equal((await service.decideReward(humans.owner.subject,credit3.id,approve(1,{planBasis:'ANNUAL'}),randomUUID())).entry.status,'APPROVED');
 await assert.rejects(()=>service.decideReward(humans.operator.subject,credit4b.id,approve(1),randomUUID()),httpStatus(403));
 const apiDraft=(await service.createRewardPolicyDraft(humans.operator.subject,terms(),randomUUID())).policy;
 await assert.rejects(()=>service.publishRewardPolicy(humans.operator.subject,apiDraft.policyId,randomUUID()),httpStatus(403));
 assert.equal((await service.publishRewardPolicy(humans.owner.subject,apiDraft.policyId,randomUUID())).retiredPolicyId,v3.policyId);
 await assert.rejects(()=>service.reconcileRewards(humans.staff.subject,ids.schoolA,randomUUID()),httpStatus(403));
 console.log('PASS: Champions Club reward accounting: versioned reward terms (complete ladder to publish, ordered thresholds, inclusive free-month totals, paid-lifetime substitute only, financial activation pinned disabled), owner/operator/support/school authority, accrual of $100 credits at 1-4, 6 then 12 total free months with full AI allowance, prize at 20 and lifetime at 30, per-referral welcome credits, idempotent reconciliation, no duplicate milestones across policy versions, approval rules by plan basis with undecided-rule refusal, prize budget, fraud void, reversal review/restore/clawback void/retain, liability totals, immutable evidence, no billing/entitlement/membership/invoice effect, and the API service on real output.');
}finally{
 try{await cleanup();}finally{await Promise.all([admin.end(),restricted.end(),runtimeDatabase.onModuleDestroy()]);}
}
