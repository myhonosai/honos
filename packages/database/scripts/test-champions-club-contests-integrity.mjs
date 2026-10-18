import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
// Champions Club contests (0152) integrity proof. Disposable localhost fixture only.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost Champions Club URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {ChampionsClubService}=await import('../../../apps/api/dist/champions/champions-club.service.js');
const runtimeDatabase=new RuntimeDatabaseService(),service=new ChampionsClubService(runtimeDatabase);
const httpStatus=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const championsTables=['champions_outbox','champions_audit','champions_contest_history','champions_contest_winners','champions_contest_results','champions_contest_pauses','champions_contest_schools','champions_contest_prizes','champions_contests','champions_leaderboard_holds','champions_leaderboard_preferences','champions_reward_history','champions_reward_entries','champions_reward_policies','champions_attribution_history','champions_attributions','champions_requests','champions_referral_codes','champions_policies'];
// T1..T6 referrer schools. T5 is on the Essential tier; T6 is under a leaderboard hold.
const T=Object.fromEntries([1,2,3,4,5,6].map(n=>[n,{org:randomUUID(),school:randomUUID(),code:randomUUID(),role:randomUUID(),name:`Contest Dojo ${n}`,tier:n===5?'ESSENTIAL':'CORE'}]));
const humans=Object.fromEntries(['owner','operator','support','staff1','staff5','staff6'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`contest-${k}-${randomUUID()}`}]));
const referred=[];const orgs=()=>[...Object.values(T).map(t=>t.org),...referred];
const m1Policy=randomUUID();
const sqlDeny=(fn,code='42501',message)=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.stack);if(message)assert.equal(e.message,message);return true;});
const call=async(fn,args,types)=>(await restricted.query(`SELECT hon.${fn}(${args.map((_,i)=>`$${i+1}${types?.[i]?`::${types[i]}`:''}`).join(',')}) r`,args)).rows[0].r;
const cmd=(who,contest,p,key=randomUUID())=>call('command_champions_contest',[humans[who].subject,contest,JSON.stringify(p),key,randomUUID(),randomUUID()],[null,'uuid','jsonb']);
const detail=(who,contest)=>call('read_champions_contest_from_hq',[humans[who].subject,contest]);
const list=(who,status=null)=>call('read_champions_contests_from_hq',[humans[who].subject,status]);
const schoolView=(who,school)=>call('read_champions_contests_for_school',[humans[who].subject,school]);
const iso=d=>new Date(d).toISOString();
const NOW=Date.now(),DAY=86400_000;
const windowStart=NOW-10*DAY,windowEnd=NOW+3600_000;
const config=(patch={})=>({name:'Fall Referral Cup',description:'Refer schools this fall; top schools win prizes (fixture).',termsReference:'Fixture contest terms v1 (not legal terms)',
 startsAt:iso(windowStart),endsAt:iso(windowEnd),countBasis:'CAPTURED_AND_QUALIFIED_IN_WINDOW',minimumQualified:1,tieRule:'OWNER_RESOLVES',
 eligibility:{scope:'ALL_ACTIVE_SCHOOLS',tiers:['CORE','COMPLETE'],schoolIds:[]},budgetMinor:120000,giftCardCompliance:'UNDECIDED',
 prizes:[{placeFrom:1,placeTo:1,kind:'ELECTRONICS',description:'Front-desk tablet',quantity:1,estimatedUnitCostMinor:50000},
  {placeFrom:2,placeTo:3,kind:'AMUSEMENT_TICKETS',description:'Amusement park family ticket pack',quantity:4,estimatedUnitCostMinor:8000}],...patch});
async function attribution(t,state,capturedAt,qualifiedAt){
 const org=randomUUID(),id=randomUUID();referred.push(org);
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,created_at) VALUES($1,'Referred fixture','Referred Fixture Dojo',$2)",[org,new Date(capturedAt-DAY)]);
 const q=state!=='PENDING';
 await admin.query(`INSERT INTO hon.champions_attributions(id,referral_code_id,referrer_organization_id,referrer_school_id,referred_organization_id,state,state_reason,version,
  captured_by_principal_id,captured_at,qualified_policy_id,qualified_at,qualification_evidence,decided_by_principal_id,decided_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
  [id,t.code,t.org,t.school,org,state,{QUALIFIED:'QUALIFICATION_VERIFIED',REVERSED:'PAYMENT_REVERSED',PENDING:'CAPTURED'}[state],q?2:1,humans.owner.id,new Date(capturedAt),
   q?m1Policy:null,q?new Date(qualifiedAt):null,q?{source:'HQ_OWNER_ATTESTATION'}:null,q?humans.owner.id:null,q?new Date(qualifiedAt):null]);
}
const inWindow=i=>[windowStart+DAY+i*3600_000, windowStart+2*DAY+i*3600_000];
async function snapshot(){const out={};for(const t of ['champions_reward_entries','champions_reward_policies','champions_leaderboard_holds','champions_leaderboard_preferences','organization_entitlements','memberships','invoices','champions_policies'])out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t ORDER BY 1`)).rows.map(r=>r.r);return out;}
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
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 for(const t of ['champions_contests','champions_contest_prizes','champions_contest_results','champions_contest_winners','champions_contest_history'])await sqlDeny(()=>restricted.query(`SELECT * FROM hon.${t}`));
 for(const sig of ['champions_contest_counts(uuid,timestamptz)','champions_contest_standings(uuid)','champions_contest_write_config(uuid,jsonb,boolean)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);

 // ---------- fixture ----------
 await cleanup();
 await admin.query('BEGIN');
 for(const[who,h]of Object.entries(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[n,t]of Object.entries(T)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,created_at) VALUES($1,$2,$2,clock_timestamp()-interval '400 days')",[t.org,`${t.name} LLC`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,$2,clock_timestamp()-interval '400 days')",[t.org,t.tier]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'America/New_York')",[t.school,t.org,t.name]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'CHAMPIONS_STAFF','Fixture role')",[t.role,t.org]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'champions.participate')",[t.role,t.org]);
  await admin.query("INSERT INTO hon.champions_referral_codes(id,organization_id,school_id,code,created_by_principal_id,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '300 days')",[t.code,t.org,t.school,`CNTST${'ABCDEF'[n-1]}2345`,humans.owner.id]);
 }
 for(const[who,n]of [['staff1',1],['staff5',5],['staff6',6]])
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[T[n].org,T[n].school,humans[who].id,T[n].role]);
 for(const[who,role,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.champions.manage']],['support','HON_HQ_SUPPORT',['hq.champions.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,role,perms]);
 await admin.query(`INSERT INTO hon.champions_policies(id,policy_version,status,attribution_window_days,refund_window_days,minimum_paid_days,minimum_paid_invoices,payment_verification_source,
  welcome_credit_minor,terms_reference,created_by_principal_id,published_by_principal_id,published_at) VALUES($1,1,'PUBLISHED',90,30,30,1,'HQ_OWNER_ATTESTATION',10000,'Fixture terms',$2,$2,clock_timestamp())`,[m1Policy,humans.owner.id]);
 // In-window qualified referrals: T1 4, T2 3 (+2 captured before the window), T3 3, T4 3, T5 2 (Essential), T6 5 (held).
 const plan={1:4,2:3,3:3,4:3,5:2,6:5};
 for(const[n,k]of Object.entries(plan))for(let i=0;i<k;i++){const[c,q]=inWindow(i+Number(n));await attribution(T[n],'QUALIFIED',c,q);}
 for(let i=0;i<2;i++)await attribution(T[2],'QUALIFIED',windowStart-5*DAY,windowStart+DAY);
 await attribution(T[1],'REVERSED',...inWindow(9));await attribution(T[1],'PENDING',windowStart+DAY);
 await admin.query("INSERT INTO hon.champions_leaderboard_holds(school_id,organization_id,reason_code,placed_by_principal_id,placed_at) VALUES($1,$2,'FRAUD_REVIEW',$3,clock_timestamp())",[T[6].school,T[6].org,humans.owner.id]);
 await admin.query('COMMIT');
 const before=await snapshot();

 // ---------- drafts: authority and closed configuration ----------
 for(const who of ['support','staff1'])await sqlDeny(()=>cmd(who,null,{action:'CREATE',...config()}),'42501');
 for(const bad of [{...config(),action:'CREATE',extra:1},{action:'CREATE',...config({prizes:[{placeFrom:1,placeTo:1,kind:'CAR',description:'x',quantity:1}]})},
   {action:'CREATE',...config({eligibility:{scope:'SELECTED_SCHOOLS',tiers:['CORE'],schoolIds:[]}})},{action:'CREATE',...config({startsAt:'2026-10-01'})},{action:'LAUNCH_NOW'}])
  await sqlDeny(()=>cmd('operator',null,bad),'22023');
 for(const bad of [config({prizes:[{placeFrom:1,placeTo:2,kind:'ELECTRONICS',description:'x',quantity:1,estimatedUnitCostMinor:1},{placeFrom:2,placeTo:3,kind:'ELECTRONICS',description:'y',quantity:1,estimatedUnitCostMinor:1}]})])
  await sqlDeny(()=>cmd('operator',null,{action:'CREATE',...bad}),'23514','CHAMPIONS_CONTEST_PRIZES_OVERLAP');
 await sqlDeny(()=>cmd('operator',null,{action:'CREATE',...config({endsAt:iso(windowStart-1)})}),'23514');
 const createKey=randomUUID();
 const created=await cmd('operator',null,{action:'CREATE',...config({termsReference:null})},createKey);
 const A=created.contest.contestId;
 assert.equal(created.contest.status,'DRAFT');assert.equal(created.contest.version,1);assert.equal(created.contest.estimatedPrizeCostMinor,114000);
 assert.deepEqual([created.contest.publicListing,created.contest.financialActivation,created.contest.automaticTransitions,created.contest.schoolVisibility],['DISABLED','DISABLED','NOT_CONFIGURED','HIDDEN']);
 assert.deepEqual(await cmd('operator',null,{action:'CREATE',...config({termsReference:null})},createKey),{...created,replayed:true});
 // Owner approval: an incomplete draft cannot be scheduled, and operators cannot schedule.
 await sqlDeny(()=>cmd('operator',A,{action:'SCHEDULE',expectedVersion:1,schoolVisibility:'ELIGIBLE_SCHOOLS'}),'42501');
 await sqlDeny(()=>cmd('owner',A,{action:'SCHEDULE',expectedVersion:1,schoolVisibility:'ELIGIBLE_SCHOOLS'}),'23514','CHAMPIONS_CONTEST_INCOMPLETE');
 await sqlDeny(()=>cmd('operator',A,{action:'UPDATE',expectedVersion:2,...config()}),'40001','CHAMPIONS_VERSION_CONFLICT');
 const overBudget=await cmd('operator',A,{action:'UPDATE',expectedVersion:1,...config({budgetMinor:100000})});
 assert.equal(overBudget.contest.version,2);
 await sqlDeny(()=>cmd('owner',A,{action:'SCHEDULE',expectedVersion:2,schoolVisibility:'ELIGIBLE_SCHOOLS'}),'23514','CHAMPIONS_CONTEST_OVER_BUDGET');
 const withGift=config({prizes:[...config().prizes,{placeFrom:4,placeTo:4,kind:'GIFT_CARD',description:'Visa gift card (where permitted)',quantity:1,estimatedUnitCostMinor:5000}],budgetMinor:150000});
 await cmd('operator',A,{action:'UPDATE',expectedVersion:2,...withGift});
 await sqlDeny(()=>cmd('owner',A,{action:'SCHEDULE',expectedVersion:3,schoolVisibility:'ELIGIBLE_SCHOOLS'}),'23514','CHAMPIONS_GIFT_CARDS_NOT_PERMITTED');
 await cmd('operator',A,{action:'UPDATE',expectedVersion:3,...config()});
 // Duplicate copies configuration into a new draft only.
 const dup=(await cmd('operator',A,{action:'DUPLICATE',name:'Winter Referral Cup',startsAt:iso(NOW+30*DAY),endsAt:iso(NOW+60*DAY)})).contest;
 assert.deepEqual([dup.status,dup.duplicatedFrom,dup.prizes.length,dup.budgetMinor,dup.schoolVisibility],['DRAFT',A,2,120000,'HIDDEN']);

 // ---------- schedule, start due, activate ----------
 const scheduled=(await cmd('owner',A,{action:'SCHEDULE',expectedVersion:4,schoolVisibility:'ELIGIBLE_SCHOOLS'})).contest;
 assert.equal(scheduled.status,'SCHEDULED');assert.equal(scheduled.due,'START_DUE','Start time passed: the read says so; nothing starts by itself.');
 await sqlDeny(()=>cmd('operator',A,{action:'UPDATE',expectedVersion:5,...config()}),'40001','CHAMPIONS_TRANSITION_NOT_ALLOWED');
 // The future duplicate cannot be activated early.
 const dupScheduled=await cmd('owner',dup.contestId,{action:'SCHEDULE',expectedVersion:1,schoolVisibility:'HIDDEN'});
 assert.equal(dupScheduled.contest.due,'NONE');
 await sqlDeny(()=>cmd('operator',dup.contestId,{action:'ACTIVATE',expectedVersion:2}),'23514','CHAMPIONS_CONTEST_NOT_STARTED');
 assert.equal((await cmd('owner',dup.contestId,{action:'CANCEL',expectedVersion:2,reasonCode:'OWNER_DECISION'})).contest.status,'CANCELLED');
 assert.equal((await cmd('operator',A,{action:'ACTIVATE',expectedVersion:5})).contest.status,'ACTIVE');

 // ---------- live contest standings (separate from the permanent leaderboard) ----------
 let d=await detail('operator',A);
 assert.equal(d.standingsFrozen,false);assert.equal(d.countsOnly,'QUALIFIED');
 const live=Object.fromEntries(d.standings.map(s=>[s.schoolId,s]));
 assert.deepEqual([1,2,3,4].map(n=>live[T[n].school].qualifiedReferrals),[4,3,3,3],'Pre-window captures, reversals and pending referrals never count.');
 assert.deepEqual([live[T[1].school].rank,live[T[2].school].rank,live[T[3].school].rank,live[T[4].school].rank],[1,2,2,2]);
 assert.deepEqual([live[T[5].school].ineligibleReason,live[T[6].school].ineligibleReason],['TIER_NOT_ELIGIBLE','LEADERBOARD_HOLD']);
 assert.equal(live[T[6].school].rank,null);

 // ---------- pause excludes referrals qualified while paused ----------
 await sqlDeny(()=>cmd('owner',A,{action:'RESUME',expectedVersion:6}),'40001');
 d=await detail('operator',A);
 const paused=await cmd('operator',A,{action:'PAUSE',expectedVersion:6});
 assert.equal(paused.contest.status,'PAUSED');
 const pausedAt=Date.parse((await detail('operator',A)).pauses[0].pausedAt);
 await admin.query('BEGIN');await attribution(T[1],'QUALIFIED',pausedAt-1000,pausedAt+1);await admin.query('COMMIT');
 await sqlDeny(()=>cmd('operator',A,{action:'RESUME',expectedVersion:7}),'42501');
 await sqlDeny(()=>cmd('owner',A,{action:'SCHEDULE',expectedVersion:7,schoolVisibility:'HIDDEN'}),'40001');
 await sleep(5);
 assert.equal((await cmd('owner',A,{action:'RESUME',expectedVersion:7})).contest.status,'ACTIVE');
 const resumedAt=Date.parse((await detail('operator',A)).pauses[0].resumedAt);
 await admin.query('BEGIN');await attribution(T[1],'QUALIFIED',resumedAt-1000,resumedAt+1);await admin.query('COMMIT');
 await sleep(5);
 assert.equal((await detail('operator',A)).standings.find(s=>s.schoolId===T[1].school).qualifiedReferrals,5,'The paused-period referral is excluded; the post-resume one counts.');

 // ---------- school views ----------
 const v1=(await schoolView('staff1',T[1].school)).contests;
 assert.equal(v1.length,1);assert.equal(v1[0].contestId,A);assert.deepEqual(v1[0].you,{qualifiedReferrals:5,status:'RANKED',rank:1});
 assert.equal(JSON.stringify(v1).includes('estimatedUnitCostMinor')||JSON.stringify(v1).includes(T[2].school),false,'Schools see no costs and no other school ids.');
 assert(v1[0].standings.filter(s=>!s.isYou).every(s=>s.anonymous&&s.displayName===null));
 assert.equal((await schoolView('staff5',T[5].school)).contests.length,0,'Ineligible tier: the contest is not shown.');
 const v6=(await schoolView('staff6',T[6].school)).contests[0];
 assert.deepEqual(v6.you,{qualifiedReferrals:5,status:'NOT_RANKED',rank:null});assert.equal(/HOLD|FRAUD/.test(JSON.stringify(v6)),false);
 for(const who of ['owner','operator'])await sqlDeny(()=>schoolView(who,T[1].school),'42501');

 // ---------- end (early end is owner-only) and freeze ----------
 await sqlDeny(()=>cmd('operator',A,{action:'PROPOSE_WINNERS',expectedVersion:8}),'40001');
 await sqlDeny(()=>cmd('operator',A,{action:'END',expectedVersion:8}),'42501');
 const ended=await cmd('owner',A,{action:'END',expectedVersion:8});
 assert.equal(ended.contest.status,'ENDED');
 d=await detail('owner',A);
 assert.equal(d.standingsFrozen,true);
 const frozenBefore=JSON.stringify(d.standings);
 await admin.query('BEGIN');for(let i=0;i<3;i++)await attribution(T[4],'QUALIFIED',windowStart+DAY,Date.now()-1000);await admin.query('COMMIT');
 assert.equal(JSON.stringify((await detail('owner',A)).standings),frozenBefore,'Frozen results never move.');
 await sqlDeny(()=>cmd('owner',A,{action:'RESUME',expectedVersion:9}),'40001');

 // ---------- winners: tie at a prize boundary needs the owner ----------
 const proposed=await cmd('operator',A,{action:'PROPOSE_WINNERS',expectedVersion:9});
 assert.equal(proposed.contest.status,'PENDING_WINNER_APPROVAL');
 d=await detail('owner',A);
 const byPlace=Object.fromEntries(d.winners.map(w=>[w.place,w]));
 assert.deepEqual([byPlace[1].schoolId,byPlace[1].status],[T[1].school,'PROPOSED']);
 assert.deepEqual([byPlace[2].status,byPlace[3].status,byPlace[2].reasonCode],['TIE_REVIEW','TIE_REVIEW','TIE_AT_BOUNDARY'],'T2/T3/T4 tie at rank 2 across the place-3 boundary.');
 assert.equal(byPlace[1].estimatedCostMinor,50000);assert.equal(byPlace[2].estimatedCostMinor,32000);
 assert.deepEqual(d.liabilities,{currency:'USD',budgetMinor:120000,estimatedPrizeCostMinor:114000,pendingWinnerCostMinor:114000,approvedWinnerCostMinor:0,financialActivation:'DISABLED'});
 let v=11;
 const w=(action,winner,extra={})=>cmd('owner',A,{action,expectedVersion:v++,winnerId:winner.winnerId,...extra});
 await sqlDeny(()=>cmd('operator',A,{action:'APPROVE_WINNER',expectedVersion:10,winnerId:byPlace[1].winnerId}),'42501');
 v=10;
 assert.equal((await w('APPROVE_WINNER',byPlace[1])).contest.status,'PENDING_WINNER_APPROVAL');
 await sqlDeny(()=>cmd('owner',A,{action:'APPROVE_WINNER',expectedVersion:v,winnerId:byPlace[2].winnerId}),'40001','CHAMPIONS_TRANSITION_NOT_ALLOWED');
 await sqlDeny(()=>cmd('owner',A,{action:'RESOLVE_WINNER',expectedVersion:v,winnerId:byPlace[2].winnerId,schoolId:T[6].school}),'23514','CHAMPIONS_CONTEST_WINNER_NOT_ELIGIBLE');
 await sqlDeny(()=>cmd('owner',A,{action:'RESOLVE_WINNER',expectedVersion:v,winnerId:byPlace[2].winnerId,schoolId:T[1].school}),'23514','CHAMPIONS_CONTEST_WINNER_NOT_ELIGIBLE');
 await w('RESOLVE_WINNER',byPlace[2],{schoolId:T[2].school});
 await w('RESOLVE_WINNER',byPlace[3],{schoolId:T[4].school});
 await sqlDeny(()=>cmd('owner',A,{action:'COMPLETE',expectedVersion:v}),'23514','CHAMPIONS_CONTEST_WINNERS_UNRESOLVED');
 // Dispute (operator may raise), dismissal, rejection and reassignment.
 await cmd('operator',A,{action:'DISPUTE_WINNER',expectedVersion:v++,winnerId:byPlace[2].winnerId,reasonCode:'DISPUTE_RAISED'});
 await w('RESOLVE_WINNER',byPlace[2],{schoolId:T[2].school});
 await w('APPROVE_WINNER',byPlace[2]);
 await w('REJECT_WINNER',byPlace[3],{reasonCode:'FRAUD_CONFIRMED'});
 await w('RESOLVE_WINNER',byPlace[3],{schoolId:T[3].school});
 await w('APPROVE_WINNER',byPlace[3]);
 d=await detail('owner',A);
 assert.deepEqual(d.winners.map(x=>[x.place,x.schoolId,x.status]),[[1,T[1].school,'APPROVED'],[2,T[2].school,'APPROVED'],[3,T[3].school,'APPROVED']]);
 assert.equal(d.liabilities.approvedWinnerCostMinor,114000);assert.equal(d.liabilities.pendingWinnerCostMinor,0);
 const completed=await cmd('owner',A,{action:'COMPLETE',expectedVersion:v++});
 assert.equal(completed.contest.status,'COMPLETED');assert.notEqual(completed.contest.completedAt,null);
 await sqlDeny(()=>cmd('owner',A,{action:'CANCEL',expectedVersion:v,reasonCode:'OWNER_DECISION'}),'40001');
 assert.equal((await schoolView('staff1',T[1].school)).contests[0].won,true);
 const actions=d.history.map(h=>h.action);
 for(const a of ['CREATE','UPDATE','SCHEDULE','ACTIVATE','PAUSE','RESUME','END','PROPOSE_WINNERS','RESOLVE_WINNER','DISPUTE_WINNER','REJECT_WINNER','APPROVE_WINNER'])assert(actions.includes(a),a);

 // ---------- END_DUE: a contest whose window closed waits for HQ, and any HQ actor may end it ----------
 const C=(await cmd('operator',null,{action:'CREATE',...config({name:'Short Cup',startsAt:iso(NOW-DAY),endsAt:iso(Date.now()+3000),budgetMinor:200000,
  countBasis:'QUALIFIED_IN_WINDOW',eligibility:{scope:'SELECTED_SCHOOLS',tiers:['CORE'],schoolIds:[T[1].school]}})})).contest.contestId;
 await cmd('owner',C,{action:'SCHEDULE',expectedVersion:1,schoolVisibility:'HIDDEN'});
 await cmd('operator',C,{action:'ACTIVATE',expectedVersion:2});
 await sleep(3500);
 assert.equal((await detail('operator',C)).contest.due,'END_DUE');
 assert.equal((await cmd('operator',C,{action:'END',expectedVersion:3})).contest.status,'ENDED');
 // Selected-school scope and the QUALIFIED_IN_WINDOW basis: T4's late-qualified referrals count but T4 was not selected.
 const cs=Object.fromEntries((await detail('operator',C)).standings.map(x=>[x.schoolId,x]));
 assert.deepEqual([cs[T[1].school].eligible,cs[T[1].school].qualifiedReferrals,cs[T[1].school].rank],[true,2,1]);
 assert.deepEqual([cs[T[4].school].eligible,cs[T[4].school].ineligibleReason,cs[T[4].school].qualifiedReferrals],[false,'NOT_SELECTED',3]);
 assert.equal((await schoolView('staff1',T[1].school)).contests.some(c=>c.contestId===C),false,'Hidden contests are never shown to schools.');
 const listed=await list('operator');
 assert.deepEqual(listed.contests.map(c=>c.status).sort(),['CANCELLED','COMPLETED','ENDED']);
 assert.deepEqual((await list('operator','COMPLETED')).contests.map(c=>c.contestId),[A]);
 await sqlDeny(()=>list('operator','LIVE'),'22023');
 for(const who of ['support','staff1'])await sqlDeny(()=>list(who),'42501');
 await sqlDeny(()=>detail('operator',randomUUID()),'P0002');

 // ---------- immutability, evidence, separation ----------
 for(const sql of [`UPDATE hon.champions_contests SET name='Renamed', version=version+1 WHERE id='${A}'`,
   `UPDATE hon.champions_contests SET status='ACTIVE', version=version+1 WHERE id='${A}'`,
   `UPDATE hon.champions_contests SET school_visibility='HIDDEN', version=version+1 WHERE id='${A}'`,
   `INSERT INTO hon.champions_contest_prizes(contest_id,place_from,place_to,prize_kind,description,quantity,estimated_unit_cost_minor) VALUES('${A}',9,9,'OTHER_APPROVED','Late add',1,1)`,
   `DELETE FROM hon.champions_contest_prizes WHERE contest_id='${A}'`,`UPDATE hon.champions_contest_results SET qualified_count=99`,`DELETE FROM hon.champions_contest_results`,
   `UPDATE hon.champions_contest_winners SET estimated_cost_minor=1, version=version+1`,`DELETE FROM hon.champions_contest_winners`,`TRUNCATE hon.champions_contest_history`,
   `DELETE FROM hon.champions_contests`])
  await sqlDeny(()=>admin.query(sql),'42501');
 await admin.query('ALTER TABLE hon.champions_contests DISABLE TRIGGER champions_guarded');
 try{for(const col of ['financial_activation=true',"public_listing='ENABLED'",'owner_approval_required=false'])await sqlDeny(()=>admin.query(`UPDATE hon.champions_contests SET ${col}`),'23514');}
 finally{await admin.query('ALTER TABLE hon.champions_contests ENABLE TRIGGER champions_guarded');}
 const evidence=(await admin.query("SELECT (SELECT count(*)::int FROM hon.champions_requests WHERE status='COMPLETED') completed,(SELECT count(*)::int FROM hon.champions_requests WHERE status<>'COMPLETED') open,(SELECT count(*)::int FROM hon.champions_audit) audits,(SELECT count(*)::int FROM hon.champions_outbox WHERE payload->'internalOnly'='true'::jsonb AND payload->'executionAllowed'='false'::jsonb) inert")).rows[0];
 assert.equal(evidence.open,0);assert.equal(evidence.audits,evidence.completed);assert.equal(evidence.inert,evidence.audits);
 // Contests touched nothing in the permanent program, billing or holds.
 const after=await snapshot();
 for(const t of Object.keys(before))assert.deepEqual(after[t],before[t],t);

 // ---------- API service on real output ----------
 const apiList=await service.readContests(humans.operator.subject,undefined);
 assert.equal(apiList.contests.length,3);
 const apiDetail=await service.readContest(humans.owner.subject,A);
 assert.equal(apiDetail.winners.length,3);
 assert.equal((await service.readSchoolContests(humans.staff1.subject,T[1].school)).contests[0].won,true);
 const apiCreated=await service.commandContest(humans.operator.subject,undefined,{action:'CREATE',...config({name:'API Cup',startsAt:iso(NOW+DAY),endsAt:iso(NOW+20*DAY)})},randomUUID());
 assert.equal(apiCreated.contest.status,'DRAFT');
 await assert.rejects(()=>service.commandContest(humans.operator.subject,apiCreated.contest.contestId,{action:'SCHEDULE',expectedVersion:1,schoolVisibility:'HIDDEN'},randomUUID()),httpStatus(403));
 assert.equal((await service.commandContest(humans.owner.subject,apiCreated.contest.contestId,{action:'SCHEDULE',expectedVersion:1,schoolVisibility:'HIDDEN'},randomUUID())).contest.status,'SCHEDULED');
 await assert.rejects(()=>service.commandContest(humans.operator.subject,apiCreated.contest.contestId,{action:'ACTIVATE',expectedVersion:2},randomUUID()),httpStatus(422,'CHAMPIONS_CONTEST_NOT_STARTED'));
 await assert.rejects(()=>service.commandContest(humans.operator.subject,undefined,{action:'ACTIVATE',expectedVersion:1},randomUUID()),httpStatus(400));
 console.log('PASS: Champions Club contests: closed HQ draft configuration (dates, count basis, minimum, tie rule, tier/school eligibility, budget, gift-card compliance, non-overlapping prizes), owner-only scheduling with completeness/budget/gift-card gates and school visibility, duplicate-to-draft, truthful START_DUE/END_DUE with manual activate/pause/resume/end (early end owner-only), window- and pause-exact QUALIFIED-only standings with pre-window, reversed, pending, ineligible-tier and held schools excluded, frozen results on end, boundary-tie review with owner resolution, dispute/reject/reassign/approve, unresolved-winner completion block, budgeted liabilities with financial activation, public listing and owner approval pinned, privacy-filtered school views of visible contests only, immutable configuration/results/history, inert evidence, no effect on permanent rewards, holds, entitlements, memberships or invoices, and the API service on real output.');
}finally{
 try{await admin.query('ROLLBACK').catch(()=>{});await cleanup();}finally{await Promise.all([admin.end(),restricted.end(),runtimeDatabase.onModuleDestroy()]);}
}
