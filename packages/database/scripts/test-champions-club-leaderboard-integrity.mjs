import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// Champions Club leaderboard (0150) integrity proof. Disposable localhost fixture only.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost Champions Club URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {ChampionsClubService}=await import('../../../apps/api/dist/champions/champions-club.service.js');
const runtimeDatabase=new RuntimeDatabaseService(),service=new ChampionsClubService(runtimeDatabase);
const httpStatus=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const championsTables=['champions_outbox','champions_audit','champions_contest_history','champions_contest_winners','champions_contest_results','champions_contest_pauses','champions_contest_schools','champions_contest_prizes','champions_contests','champions_leaderboard_holds','champions_leaderboard_preferences','champions_reward_history','champions_reward_entries','champions_reward_policies','champions_attribution_history','champions_attributions','champions_requests','champions_referral_codes','champions_policies'];
// S1..S6 referrer schools; one organization each. R* are referred organizations.
const S=Object.fromEntries([1,2,3,4,5,6].map(n=>[n,{org:randomUUID(),school:randomUUID(),code:randomUUID(),role:randomUUID(),name:`Fixture Dojo ${n}`}]));
const humans=Object.fromEntries(['owner','operator','support','staff1','staff2','staff5','nogrant'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`board-${k}-${randomUUID()}`}]));
const referred=[];
const orgs=()=>[...Object.values(S).map(s=>s.org),...referred];
const m1Policy=randomUUID();
const sqlDeny=(fn,code='42501',message)=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.stack);if(message)assert.equal(e.message,message);return true;});
const call=async(fn,args,types)=>(await restricted.query(`SELECT hon.${fn}(${args.map((_,i)=>`$${i+1}${types?.[i]?`::${types[i]}`:''}`).join(',')}) r`,args)).rows[0].r;
const hqBoard=(who,period='ALL_TIME',month=null)=>call('read_champions_leaderboard_from_hq',[humans[who].subject,period,month]);
const hqStats=(who,school)=>call('read_champions_school_statistics_from_hq',[humans[who].subject,school]);
const hold=(who,p,key=randomUUID())=>call('set_champions_leaderboard_hold',[humans[who].subject,JSON.stringify(p),key,randomUUID(),randomUUID()],[null,'jsonb']);
const board=(who,school,period='ALL_TIME',month=null)=>call('read_champions_leaderboard_for_school',[humans[who].subject,school,period,month]);
const stats=(who,school)=>call('read_champions_school_statistics',[humans[who].subject,school]);
const prefer=(who,school,mode,key=randomUUID())=>call('set_champions_leaderboard_preference',[humans[who].subject,school,JSON.stringify({displayMode:mode}),key,randomUUID(),randomUUID()],[null,null,'jsonb']);
// Times inside the current and previous UTC months, never in the future.
const now=new Date(),monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
const thisMonth=offset=>new Date(monthStart.getTime()+Math.min(3600_000,(now-monthStart)/2)*(offset+1)/10);
const lastMonth=days=>new Date(monthStart.getTime()-days*86400_000);
const ym=d=>d.toISOString().slice(0,7);
const currentMonth=ym(monthStart),previousMonth=ym(lastMonth(1));
async function attribution(s,state,qualifiedAt){
 const org=randomUUID(),id=randomUUID();referred.push(org);
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,created_at) VALUES($1,'Referred fixture','Referred Fixture Dojo',clock_timestamp())",[org]);
 const decided=state!=='PENDING',qualified=state==='QUALIFIED'||state==='REFUNDED'||state==='REVERSED';
 const reason={PENDING:'CAPTURED',QUALIFIED:'QUALIFICATION_VERIFIED',REJECTED:'FRAUD_SUSPECTED',REFUNDED:'REFUND_ISSUED',REVERSED:'PAYMENT_REVERSED'}[state];
 await admin.query(`INSERT INTO hon.champions_attributions(id,referral_code_id,referrer_organization_id,referrer_school_id,referred_organization_id,state,state_reason,version,
  captured_by_principal_id,captured_at,qualified_policy_id,qualified_at,qualification_evidence,decided_by_principal_id,decided_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
  [id,s.code,s.org,s.school,org,state,reason,decided?2:1,humans.owner.id,new Date(Date.now()-90*86400_000),qualified?m1Policy:null,qualified?(qualifiedAt??thisMonth(0)):null,
   qualified?{source:'HQ_OWNER_ATTESTATION'}:null,decided?humans.owner.id:null,decided?(qualifiedAt??thisMonth(0)):null]);
 await admin.query("INSERT INTO hon.champions_attribution_history(attribution_id,from_state,to_state,version,state_reason,actor_principal_id,occurred_at) VALUES($1,NULL,'PENDING',1,'CAPTURED',$2,$3)",[id,humans.owner.id,new Date(Date.now()-90*86400_000)]);
 if(decided)await admin.query("INSERT INTO hon.champions_attribution_history(attribution_id,from_state,to_state,version,state_reason,actor_principal_id,occurred_at) VALUES($1,'PENDING',$2,2,$3,$4,$5)",[id,state,reason,humans.owner.id,qualifiedAt??thisMonth(0)]);
 return {id,org};
}
async function snapshot(){const out={};for(const t of ['champions_attributions','champions_attribution_history','champions_reward_entries','organization_entitlements','memberships','invoices'])out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t ORDER BY 1`)).rows.map(r=>r.r);return out;}
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
 for(const t of ['champions_leaderboard_preferences','champions_leaderboard_holds'])await sqlDeny(()=>restricted.query(`SELECT * FROM hon.${t}`));
 for(const sig of ['champions_standings(date)','champions_school_statistics_json(uuid,boolean)','champions_milestone_progress(integer)','champions_period_month(text,text)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);

 // ---------- fixture ----------
 await cleanup();
 await admin.query('BEGIN');
 for(const[who,h]of Object.entries(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[n,s]of Object.entries(S)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,$2,$2,$3::hon.membership_status,clock_timestamp()-interval '200 days')",[s.org,`${s.name} LLC`,n==='4'?'SUSPENDED':'ACTIVE']);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '200 days')",[s.org]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'America/New_York')",[s.school,s.org,s.name]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'CHAMPIONS_STAFF','Fixture role')",[s.role,s.org]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'champions.participate')",[s.role,s.org]);
  await admin.query("INSERT INTO hon.champions_referral_codes(id,organization_id,school_id,code,created_by_principal_id,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '150 days')",[s.code,s.org,s.school,`LDRB${'ABCDEF'[n-1]}23456`,humans.owner.id]);
 }
 for(const[who,n]of [['staff1',1],['staff2',2],['staff5',5]])
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[S[n].org,S[n].school,humans[who].id,S[n].role]);
 for(const[who,role,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.champions.manage']],['support','HON_HQ_SUPPORT',['hq.champions.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,role,perms]);
 await admin.query(`INSERT INTO hon.champions_policies(id,policy_version,status,attribution_window_days,refund_window_days,minimum_paid_days,minimum_paid_invoices,payment_verification_source,
  welcome_credit_minor,terms_reference,created_by_principal_id,published_by_principal_id,published_at) VALUES($1,1,'PUBLISHED',90,30,30,1,'HQ_OWNER_ATTESTATION',10000,'Fixture terms',$2,$2,clock_timestamp())`,[m1Policy,humans.owner.id]);
 // S1: 3 qualified this month + 2 last month (5), plus pending/rejected/refunded/reversed that never count.
 for(let i=0;i<3;i++)await attribution(S[1],'QUALIFIED',thisMonth(i));
 for(let i=0;i<2;i++)await attribution(S[1],'QUALIFIED',lastMonth(5+i));
 for(const st of ['PENDING','PENDING','REJECTED','REFUNDED','REVERSED'])await attribution(S[1],st,lastMonth(3));
 // S2: 5 qualified, all last month, so it reached 5 before S1 did: same rank, listed first.
 for(let i=0;i<5;i++)await attribution(S[2],'QUALIFIED',lastMonth(8+i));
 // S3: 3 last month. S4: 2, organization suspended. S5: 4, held for review. S6: pending only.
 for(let i=0;i<3;i++)await attribution(S[3],'QUALIFIED',lastMonth(4+i));
 for(let i=0;i<2;i++)await attribution(S[4],'QUALIFIED',lastMonth(4+i));
 for(let i=0;i<4;i++)await attribution(S[5],'QUALIFIED',lastMonth(4+i));
 for(let i=0;i<3;i++)await attribution(S[6],'PENDING');
 await admin.query('COMMIT');
 const before=await snapshot();

 // ---------- authority and selectors ----------
 for(const who of ['support','staff1','nogrant'])await sqlDeny(()=>hqBoard(who),'42501');
 for(const who of ['owner','operator','staff2','nogrant'])await sqlDeny(()=>board(who,S[1].school),'42501');
 await sqlDeny(()=>stats('staff1',S[2].school),'42501');
 await sqlDeny(()=>hqStats('support',S[1].school),'42501');
 await sqlDeny(()=>hqStats('operator',randomUUID()),'P0002');
 for(const [period,month] of [['MONTH',null],['ALL_TIME',currentMonth],['MONTH','2025-12'],['MONTH','2026-13'],['MONTH','26-01'],['WEEK',null],['MONTH',ym(new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)))]])
  await sqlDeny(()=>hqBoard('operator',period,month),'22023');

 // ---------- HQ hold so S5 starts excluded ----------
 for(const bad of [{action:'PLACE',schoolId:S[5].school},{action:'PLACE',schoolId:S[5].school,reasonCode:'BAD_VIBES'},{action:'DELETE',schoolId:S[5].school},{action:'RELEASE',schoolId:'x'}])
  await sqlDeny(()=>hold('operator',bad),'22023');
 for(const who of ['support','staff1'])await sqlDeny(()=>hold(who,{action:'PLACE',schoolId:S[5].school,reasonCode:'FRAUD_REVIEW'}),'42501');
 await sqlDeny(()=>hold('operator',{action:'PLACE',schoolId:randomUUID(),reasonCode:'FRAUD_REVIEW'}),'P0002');
 const holdKey=randomUUID();
 const placed=await hold('operator',{action:'PLACE',schoolId:S[5].school,reasonCode:'FRAUD_REVIEW'},holdKey);
 assert.equal(placed.status,'ACTIVE');assert.deepEqual(await hold('operator',{action:'PLACE',schoolId:S[5].school,reasonCode:'FRAUD_REVIEW'},holdKey),{...placed,replayed:true});
 await sqlDeny(()=>hold('owner',{action:'PLACE',schoolId:S[5].school,reasonCode:'DISPUTE'}),'40001');

 // ---------- official all-time standings ----------
 const all=await hqBoard('operator');
 assert.equal(all.countsOnly,'QUALIFIED');assert.equal(all.timeZone,'UTC');assert.equal(all.totalRanked,3);
 assert.deepEqual(all.standings.map(s=>[s.position,s.rank,s.schoolId,s.qualifiedReferrals]),[[1,1,S[2].school,5],[2,1,S[1].school,5],[3,3,S[3].school,3]]);
 assert.equal(all.standings.find(s=>s.schoolId===S[1].school).pendingReferrals,2);
 assert(all.standings.every(s=>s.displayMode==='ANONYMOUS'));
 assert.deepEqual(all.held.map(h=>[h.schoolId,h.reasonCode,h.qualifiedReferrals]),[[S[5].school,'FRAUD_REVIEW',4]]);
 for(const n of [4,5,6])assert.equal(all.standings.some(s=>s.schoolId===S[n].school),false,`S${n} is not in official standings`);
 // ---------- monthly standings (UTC) ----------
 const cur=await hqBoard('owner','MONTH',currentMonth);
 assert.equal(cur.month,currentMonth);assert.deepEqual(cur.standings.map(s=>[s.rank,s.schoolId,s.qualifiedReferrals]),[[1,S[1].school,3]]);
 const prev=await hqBoard('owner','MONTH',previousMonth);
 if(previousMonth>='2026-01')assert.deepEqual(prev.standings.map(s=>[s.rank,s.schoolId,s.qualifiedReferrals]),[[1,S[2].school,5],[2,S[3].school,3],[3,S[1].school,2]]);

 // ---------- school-facing privacy ----------
 const v1=await board('staff1',S[1].school);
 assert.deepEqual(v1.standings.map(s=>[s.rank,s.displayName,s.anonymous,s.qualifiedReferrals,s.isYou]),[[1,null,true,5,false],[1,S[1].name,false,5,true],[3,null,true,3,false]]);
 assert.deepEqual(v1.you,{schoolId:S[1].school,status:'RANKED',rank:1,qualifiedReferrals:5,displayMode:'ANONYMOUS'});
 const leak=JSON.stringify(v1);
 for(const n of [2,3,5])for(const v of [S[n].school,S[n].org,S[n].name])assert.equal(leak.includes(v),false,`School view never exposes S${n} identity`);
 assert.equal(leak.includes('pending'),false);
 for(const bad of [{displayMode:'NAME'},{displayMode:'SCHOOL_NAME',displayName:'x'},{}])await sqlDeny(()=>call('set_champions_leaderboard_preference',[humans.staff2.subject,S[2].school,JSON.stringify(bad),randomUUID(),randomUUID(),randomUUID()],[null,null,'jsonb']),'22023');
 for(const who of ['owner','staff1'])await sqlDeny(()=>prefer(who,S[2].school,'SCHOOL_NAME'),'42501');
 const prefKey=randomUUID(),optIn=await prefer('staff2',S[2].school,'SCHOOL_NAME',prefKey);
 assert.deepEqual([optIn.displayMode,optIn.version,optIn.replayed],['SCHOOL_NAME',1,false]);
 assert.deepEqual(await prefer('staff2',S[2].school,'SCHOOL_NAME',prefKey),{...optIn,replayed:true});
 assert.deepEqual((await board('staff1',S[1].school)).standings[0],{rank:1,displayName:S[2].name,anonymous:false,qualifiedReferrals:5,isYou:false});
 assert.equal((await hqBoard('operator')).standings[0].displayMode,'SCHOOL_NAME');
 assert.equal((await prefer('staff2',S[2].school,'ANONYMOUS')).version,2);
 assert.equal((await board('staff1',S[1].school)).standings[0].displayName,null,'Opting out hides the name again.');
 // A held school sees only NOT_RANKED, never the hold or its reason.
 const v5=await board('staff5',S[5].school);
 assert.deepEqual(v5.you,{schoolId:S[5].school,status:'NOT_RANKED',rank:null,qualifiedReferrals:4,displayMode:'ANONYMOUS'});
 assert.equal(/FRAUD|hold|REVIEW/i.test(JSON.stringify(v5)),false);
 assert.equal((await board('staff1',S[1].school,'MONTH',currentMonth)).you.qualifiedReferrals,3);

 // ---------- statistics ----------
 const st1=await stats('staff1',S[1].school);
 assert.deepEqual(st1.referrals,{pending:2,qualified:5,rejected:1,refunded:1,reversed:1});
 assert.equal(st1.monthlyQualified.length,12);assert.deepEqual(st1.monthlyQualified.at(-1),{month:currentMonth,qualified:3});
 if(previousMonth>='2026-01')assert.equal(st1.monthlyQualified.at(-2).qualified,2);
 assert.equal(st1.allTimeRank,1);assert.equal(st1.historyLimit,50);
 assert.deepEqual(st1.milestones,{program:{status:'POLICY_UNDECIDED',policyVersion:null},reached:[],nextMilestone:null,qualifiedReferrals:5});
 assert.equal(st1.history.length,5*2+2+3*2,'5 qualified and 3 decided referrals carry two events each, 2 pending carry one');
 assert(st1.history.every(h=>Object.keys(h).sort().join()==='fromState,occurredAt,reason,toState'),'School history carries no referred identity.');
 assert.equal(JSON.stringify(st1).includes('Referred Fixture Dojo'),false);
 // Milestone progress follows the published reward ladder.
 await admin.query(`INSERT INTO hon.champions_reward_policies(policy_version,status,referrer_credit_minor,referrer_credit_max_rank,welcome_credit_minor,first_free_months_count,first_free_months_total,
  second_free_months_count,second_free_months_total,prize_count,lifetime_count,terms_reference,created_by_principal_id,published_by_principal_id,published_at)
  VALUES(1,'PUBLISHED',10000,4,10000,5,6,10,12,20,30,'Fixture reward terms',$1,$1,clock_timestamp())`,[humans.owner.id]);
 const ms=(await stats('staff1',S[1].school)).milestones;
 assert.deepEqual(ms.reached.map(r=>[r.rewardKind,r.milestoneCount]),[['REFERRER_CREDIT',1],['REFERRER_CREDIT',2],['REFERRER_CREDIT',3],['REFERRER_CREDIT',4],['FREE_MONTHS',5]]);
 assert.deepEqual(ms.nextMilestone,{rewardKind:'FREE_MONTHS',milestoneCount:10,remaining:5});
 const hq5=await hqStats('operator',S[5].school);
 assert.deepEqual(hq5.hold.reasonCode,'FRAUD_REVIEW');assert.equal(hq5.allTimeRank,null);assert.equal(hq5.referrals.qualified,4);
 const hq1=await hqStats('owner',S[1].school);
 assert.equal(hq1.schoolName,S[1].name);assert.equal(hq1.hold,null);assert.equal(hq1.history[0].referredOrganizationName,'Referred Fixture Dojo');

 // ---------- holds change standings only ----------
 await hold('operator',{action:'PLACE',schoolId:S[3].school,reasonCode:'DUPLICATE_REVIEW'});
 assert.deepEqual((await hqBoard('operator')).standings.map(s=>s.schoolId),[S[2].school,S[1].school]);
 await sqlDeny(()=>hold('operator',{action:'RELEASE',schoolId:S[3].school}),'42501');
 const released=await hold('owner',{action:'RELEASE',schoolId:S[3].school});
 assert.equal(released.status,'RELEASED');assert.notEqual(released.releasedAt,null);
 await sqlDeny(()=>hold('owner',{action:'RELEASE',schoolId:S[3].school}),'40001');
 assert.equal((await hqBoard('operator')).totalRanked,3);
 // Reversing a qualified referral drops it from the official count immediately.
 const s3attr=(await admin.query("SELECT id FROM hon.champions_attributions WHERE referrer_school_id=$1 AND state='QUALIFIED' LIMIT 1",[S[3].school])).rows[0].id;
 await call('decide_champions_attribution',[humans.owner.subject,s3attr,JSON.stringify({decision:'REVERSE',reasonCode:'PAYMENT_REVERSED',expectedVersion:2}),randomUUID(),randomUUID(),randomUUID()],[null,null,'jsonb']);
 assert.equal((await hqBoard('operator')).standings.find(s=>s.schoolId===S[3].school).qualifiedReferrals,2);

 // ---------- immutability and evidence ----------
 for(const sql of ["DELETE FROM hon.champions_leaderboard_preferences","UPDATE hon.champions_leaderboard_holds SET status='ACTIVE', released_at=NULL, released_by_principal_id=NULL WHERE status='RELEASED'",
   "UPDATE hon.champions_leaderboard_holds SET reason_code='DISPUTE'","DELETE FROM hon.champions_leaderboard_holds","TRUNCATE hon.champions_leaderboard_preferences","UPDATE hon.champions_leaderboard_preferences SET display_mode='SCHOOL_NAME'"])
  await sqlDeny(()=>admin.query(sql),'42501');
 const evidence=(await admin.query("SELECT (SELECT count(*)::int FROM hon.champions_requests WHERE status='COMPLETED') completed,(SELECT count(*)::int FROM hon.champions_requests WHERE status<>'COMPLETED') open,(SELECT count(*)::int FROM hon.champions_audit) audits,(SELECT count(*)::int FROM hon.champions_outbox WHERE payload->'internalOnly'='true'::jsonb AND payload->'executionAllowed'='false'::jsonb) inert")).rows[0];
 assert.equal(evidence.open,0);assert.equal(evidence.audits,evidence.completed);assert.equal(evidence.inert,evidence.audits);
 // Holds and preferences never touched attributions (except the explicit REVERSE above), rewards or billing.
 const after=await snapshot();
 for(const t of ['organization_entitlements','memberships','invoices'])assert.deepEqual(after[t],before[t],t);
 // M5: the REVERSE decision reconciled S3's permanent liabilities (2 credits + 2 welcome credits); nothing else accrued.
 const newEntries=(await admin.query('SELECT referrer_school_id, reward_kind FROM hon.champions_reward_entries')).rows;
 assert.equal(newEntries.length,4);assert(newEntries.every(e=>e.referrer_school_id===S[3].school));
 assert.equal(after.champions_attributions.filter(r=>!before.champions_attributions.includes(r)).length,1);

 // ---------- API service on real output ----------
 const apiBoard=await service.readHqLeaderboard(humans.operator.subject,{period:'MONTH',month:currentMonth});
 assert.equal(apiBoard.standings[0].schoolId,S[1].school);
 assert.equal((await service.readHqLeaderboard(humans.operator.subject,{})).period,'ALL_TIME');
 await assert.rejects(()=>service.readHqLeaderboard(humans.operator.subject,{period:'MONTH'}),httpStatus(400,'INVALID_CHAMPIONS_INPUT'));
 assert.equal((await service.readSchoolLeaderboard(humans.staff1.subject,S[1].school,{})).you.status,'RANKED');
 assert.equal((await service.readSchoolStatistics(humans.staff1.subject,S[1].school)).referrals.qualified,5);
 assert.equal((await service.readHqSchoolStatistics(humans.owner.subject,S[5].school)).hold.reasonCode,'FRAUD_REVIEW');
 assert.equal((await service.setLeaderboardPreference(humans.staff1.subject,S[1].school,{displayMode:'SCHOOL_NAME'},randomUUID())).displayMode,'SCHOOL_NAME');
 await assert.rejects(()=>service.setLeaderboardHold(humans.operator.subject,{action:'RELEASE',schoolId:S[5].school},randomUUID()),httpStatus(403));
 assert.equal((await service.setLeaderboardHold(humans.owner.subject,{action:'RELEASE',schoolId:S[5].school},randomUUID())).status,'RELEASED');
 assert.equal((await service.readHqLeaderboard(humans.owner.subject,{})).totalRanked,4,'A released school returns to the standings.');
 await assert.rejects(()=>service.readSchoolStatistics(humans.staff1.subject,S[2].school),httpStatus(403));
 console.log('PASS: Champions Club leaderboard: QUALIFIED-only all-time and UTC monthly standings with shared tie ranks and reached-first order; pending/rejected/refunded/reversed, suspended-organization and held schools excluded; HQ/school authority and closed selectors; anonymous-by-default privacy with school-controlled opt-in/out, no other-school identity or pending counts in school views, confidential holds; per-school statistics (state counts, 12-month series, milestone progress, identity-free history); owner-only hold release; immutable preferences/holds; inert evidence; no reward, entitlement, membership or invoice effect; and the API service on real output.');
}finally{
 try{await cleanup();}finally{await Promise.all([admin.end(),restricted.end(),runtimeDatabase.onModuleDestroy()]);}
}
