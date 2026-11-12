import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// B1 HQ Ask HON + HQ AI text budget (0263) integrity proof, TEST MODE, disposable database only, fake provider only. It
// proves: the runtime can execute only the five entry points and has no table privilege; only the HQ owner sets the monthly
// HQ AI text cap (current or next 12 UTC months, versioned, idempotent, never below use, immutable history); the HQ owner or
// an operator with hq.dashboard.view asks and reads their own turns, while marketing-only, support, lapsed owners, school
// owners and strangers are refused; with no provider connected the API refuses before any write; a turn needs an eligible
// server-chosen route, an unpaused platform, a set cap with room and fewer than 3 in progress (each refused with nothing
// written); the facts are the HQ overview only (no school names); one provider call per turn, replays never call or reserve
// again and key reuse is refused; outcomes are recorded once with measured tokens (ANSWERED charges ceil(tokens/1000) never
// above the reservation, FAILED and NOT_SENT charge nothing, out-of-bounds and unknown results are held for the HQ owner,
// interrupted only after 120 s); the HQ owner resolves held turns; a person whose grant lapses meanwhile still records the
// result but the answer is concealed from them; rows never change outside those moves; nothing school-side is touched.
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env);
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|ZERNIO|META|GOOGLE|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {HqHonService}=await import('../../../apps/api/dist/hq-hon/hq-hon.service.js');
const {HonReplyProviderRuntimeError,OpenRouterHonReplyRuntime}=await import('../../../apps/api/dist/ai/hon-reply-provider-runtime.js');

// The only provider: a fake that records every invocation. Nothing leaves this process.
class FakeReplyRuntime{
 constructor(){this.calls=[];this.next=null;}
 readiness(){return 'READY';}
 async generate(input){this.calls.push(input);const n=this.next;this.next=null;if(n instanceof Error)throw n;
  return n??{reply:'HQ has 1 school on HON OS. Recorded facts only.',inputTokens:2100,outputTokens:400,providerCostMicrounits:1200,truncated:false,suggestions:[],followUps:[],sources:[]};}
}
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database);
const provider=new FakeReplyRuntime(),hon=new HqHonService(billing,provider);
const offline=new HqHonService(billing,new OpenRouterHonReplyRuntime(()=>({})));
const admin=new pg.Client(targets.owner),restricted=new pg.Client(targets.runtime);
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID();
const ORG=randomUUID(),S=randomUUID(),ROLE=randomUUID(),CATALOG=randomUUID(),SCHOOL_NAME=`HQHON Secret School ${randomUUID().slice(0,8)}`;
const humans=Object.fromEntries(['owner','exowner','viewer','marketer','supportOp','schoolOwner','stranger','leaver','finance','ops','supportMgr','mkt2']
 .map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`hqhon-${k}-${randomUUID()}`,name:`Fixture ${k}`}]));
const H=k=>humans[k].subject,P=k=>humans[k].id;
const CASE_SUBJECT=`HQHON secret case ${randomUUID().slice(0,8)}`;
const tables=['hq_hon_requests','hq_hon_turns','hq_hon_budget_changes','hq_hon_budget_periods'];
let providerRow=null;
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  const ps=Object.values(humans).map(h=>h.id),us=Object.values(humans).map(h=>h.user);
  await admin.query('DELETE FROM hon.hq_hon_requests WHERE actor_principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.hq_hon_turns WHERE asked_by=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.hq_hon_budget_changes WHERE actor_principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.hq_hon_budget_periods WHERE set_by=ANY($1::uuid[])',[ps]);
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('ALTER TABLE hon.ai_spend_pauses DISABLE TRIGGER USER');
  await admin.query('DELETE FROM hon.ai_spend_pauses WHERE paused_by_principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('ALTER TABLE hon.ai_spend_pauses ENABLE TRIGGER USER');
  await admin.query('ALTER TABLE hon.hq_support_cases DISABLE TRIGGER USER');
  await admin.query('DELETE FROM hon.hq_support_cases WHERE organization_id=$1',[ORG]);
  await admin.query('ALTER TABLE hon.hq_support_cases ENABLE TRIGGER USER');
  await admin.query('DELETE FROM hon.hq_ai_model_catalog WHERE catalog_id=$1',[CATALOG]);
  if(providerRow==='CREATED')await admin.query("DELETE FROM hon.hq_ai_provider_connections WHERE provider_id='OPENROUTER'");
  else if(providerRow)await admin.query("UPDATE hon.hq_ai_provider_connections SET state=$1,credential_secret_ref=$2 WHERE provider_id='OPENROUTER'",[providerRow.state,providerRow.credential_secret_ref]);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`,[ORG]);
  await admin.query('DELETE FROM hon.organizations WHERE id=$1',[ORG]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[us]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const counts=async()=>row(`SELECT (SELECT count(*) FROM hon.hq_hon_turns)::int t,(SELECT count(*) FROM hon.hq_hon_budget_periods)::int b,
 (SELECT count(*) FROM hon.hq_hon_budget_changes)::int h,(SELECT count(*) FROM hon.hq_hon_requests)::int r`);
// Everything a school AI turn or its spend is made of. HQ HON must never write any of it.
const schoolSide=async()=>row(`SELECT (SELECT count(*) FROM hon.ai_usage_ledger)::int u,(SELECT count(*) FROM hon.ai_invocation_plans)::int p,
 (SELECT count(*) FROM hon.hon_conversation_turns)::int ht,(SELECT count(*) FROM hon.hon_reply_invocations)::int hr,(SELECT count(*) FROM hon.hq_creative_generations)::int cg,
 (SELECT count(*) FROM hon.saas_creative_reservations)::int cr`);
const month=(d=new Date(),plus=0)=>{const x=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+plus,1));return x.toISOString().slice(0,10);};
const NOW=month(),NEXT=month(new Date(),1);
const ask=(patch={})=>({question:'How many schools are on HON OS and is onboarding moving?',replyMode:'STANDARD',agentKey:'hon',...patch});
const budgetIn=(patch={})=>({periodStart:NOW,creditCap:100,expectedVersion:null,reason:'November HQ AI text test budget',...patch});
const resolveIn=(v,patch={})=>({expectedVersion:v,resolution:'NOT_CHARGED',chargedCredits:null,providerCostMicrounits:null,evidenceReference:'Provider dashboard export 2026-11',...patch});
const raw=(who,input,key=K())=>billing.call('askHqHon',[H(who),JSON.stringify(input),key],v=>v);
const record=(who,id,p)=>billing.call('recordHqHonResult',[H(who),id,JSON.stringify(p)],v=>v);
const answered=(patch={})=>({outcome:'ANSWERED',reply:'Fine.',truncated:false,inputTokens:1000,outputTokens:500,providerCostMicrounits:900,failureReason:null,...patch});
const cost=async id=>row('SELECT cost_status,provider_cost_microunits::int c,input_tokens i,output_tokens o FROM hon.hq_hon_turns WHERE id=$1',[id]);

await Promise.all([admin.connect(),restricted.connect()]);
await verifyChampionsProofConnection(admin,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection(restricted,CHAMPIONS_RUNTIME_ROLE);
await verifyChampionsProofConnection({query:(...a)=>database['getPool']().query(...a)},CHAMPIONS_RUNTIME_ROLE);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- 0. posture ----------
 for(const[sig,allowed]of [['set_hq_hon_budget(text,jsonb,uuid)',true],['ask_hq_hon(text,jsonb,uuid)',true],['record_hq_hon_result(text,uuid,jsonb)',true],
  ['resolve_hq_hon_turn(text,uuid,jsonb,uuid)',true],['read_hq_hon_conversation(text)',true],['require_hq_hon_actor(text,boolean)',false],
  ['hq_hon_permission_held(uuid,text)',false],['hq_hon_owner_eligible(uuid)',false],['hq_hon_agent_facts(text,text)',false],['hq_hon_claim(uuid,uuid,text,text)',false],
  ['hq_hon_lock_period(date)',false],['hq_hon_budget_json(date)',false],['hq_hon_turn_json(hon.hq_hon_turns,uuid)',false],['hq_hon_agent_permission(text)',false],['hq_hon_counts(text[],text[])',false]])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
 for(const t of tables)for(const priv of ['SELECT','INSERT','UPDATE','DELETE'])
  assert.equal((await restricted.query('SELECT has_table_privilege(current_user,$1,$2) a',['hon.'+t,priv])).rows[0].a,false,`${t} ${priv}`);
 for(const t of tables)assert.deepEqual(await row("SELECT relrowsecurity r,relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass",['hon.'+t]),{r:true,f:true},t);
 await cleanup();
 assert.deepEqual(await counts(),{t:0,b:0,h:0,r:0},'the disposable database holds no other HQ HON rows');

 // ---------- fixture ----------
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[h.user,h.subject,`${h.user}@example.test`,h.name]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,true)",[h.id,h.user,h.name]);}
 for(const[who,role,perms,until]of [['owner','HON_HQ_OWNER',[],null],['exowner','HON_HQ_OWNER',[],'1 minute'],['viewer','HON_HQ_OPERATOR',['hq.dashboard.view'],null],
  ['marketer','HON_HQ_OPERATOR',['hq.marketing.read','hq.marketing.manage'],null],['supportOp','HON_HQ_SUPPORT',['hq.dashboard.view','hq.support.manage'],null],
  ['leaver','HON_HQ_OPERATOR',['hq.dashboard.view'],null],['finance','HON_HQ_OPERATOR',['hq.dashboard.view','hq.billing.manage'],null],
  ['ops','HON_HQ_OPERATOR',['hq.dashboard.view','hq.onboarding.manage'],null],['supportMgr','HON_HQ_OPERATOR',['hq.dashboard.view','hq.support.manage'],null],
  ['mkt2','HON_HQ_OPERATOR',['hq.dashboard.view','hq.marketing.manage'],null]])
  await admin.query(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',${until?`clock_timestamp()-interval '${until}'`:'NULL'})`,[P(who),role,perms]);
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,$2,$2,'ACTIVE',clock_timestamp())",[ORG,SCHOOL_NAME]);
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'UTC')",[S,ORG,SCHOOL_NAME]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[ROLE,ORG]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[ROLE,ORG]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[ORG,S,P('schoolOwner'),ROLE]);
 providerRow=(await admin.query("SELECT state,credential_secret_ref FROM hon.hq_ai_provider_connections WHERE provider_id='OPENROUTER'")).rows[0]??'CREATED';
 const secret=`hon-secret:${randomUUID()}`;
 if(providerRow==='CREATED')await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','Fixture OpenRouter','HEALTHY',$1)",[secret]);
 else await admin.query("UPDATE hon.hq_ai_provider_connections SET state='HEALTHY',credential_secret_ref=coalesce(credential_secret_ref,$1) WHERE provider_id='OPENROUTER'",[secret]);
 await admin.query('COMMIT');
 await admin.query("INSERT INTO hon.hq_support_cases(organization_id,school_id,subject,category,priority,status,opened_by,opened_at,updated_at) VALUES($1,$2,$3,'BILLING','URGENT','OPEN',$4,clock_timestamp()-interval '10 days',clock_timestamp())",[ORG,S,CASE_SUBJECT,P('owner')]);
 const start=await counts(),school=await schoolSide();

 // ---------- 1. authority ----------
 for(const who of ['exowner','marketer','supportOp','schoolOwner','stranger']){
  await deny(hon.conversation(H(who)),403,'SAAS_FORBIDDEN');
  await deny(hon.ask(H(who),ask(),K()),403,'SAAS_FORBIDDEN');
  await deny(hon.setBudget(H(who),budgetIn(),K()),403,'SAAS_FORBIDDEN');
 }
 await deny(hon.conversation('hqhon-unknown-'+randomUUID()),403,'SAAS_FORBIDDEN');
 const first=await hon.conversation(H('viewer'));
 assert.deepEqual([first.provider,first.viewer.isOwner,first.turns,first.budgetHistory,first.underReview],['CONNECTED',false,[],[],[]]);
 assert.deepEqual(first.budget,{periodStart:NOW,creditCap:null,usedCredits:0,heldCredits:0,availableCredits:0,inProgress:0,version:null,setBy:null,setAt:null});
 assert.equal((await hon.conversation(H('owner'))).viewer.isOwner,true);
 await deny(hon.setBudget(H('viewer'),budgetIn(),K()),403,'SAAS_FORBIDDEN');
 await deny(hon.resolve(H('viewer'),randomUUID(),resolveIn(1),K()),403,'SAAS_FORBIDDEN');
 // With no provider connected the API refuses before the database is asked: nothing is reserved or written.
 await deny(offline.ask(H('owner'),ask(),K()),503,'HQ_HON_PROVIDER_NOT_CONNECTED');
 assert.equal((await offline.conversation(H('owner'))).provider,'NOT_CONNECTED');
 assert.deepEqual(await counts(),start,'refusals wrote nothing');

 // ---------- 2. budget ----------
 await deny(hon.ask(H('owner'),ask(),K()),422,'HQ_HON_NO_ELIGIBLE_ROUTE');
 await admin.query(`INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from)
  VALUES($1,'OPENROUTER','fixture/hq-text-model','Fixture HQ text model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',1,'TOKEN',clock_timestamp()-interval '1 hour')`,[CATALOG]);
 await deny(hon.ask(H('owner'),ask(),K()),422,'HQ_HON_BUDGET_NOT_SET');
 for(const bad of [budgetIn({periodStart:'2026-11-02'}),budgetIn({creditCap:-1}),budgetIn({creditCap:10000001}),budgetIn({creditCap:1.5}),budgetIn({reason:'no'}),
  budgetIn({reason:' padded '}),budgetIn({expectedVersion:0}),{...budgetIn(),extra:1}])
  await deny(hon.setBudget(H('owner'),bad,K()),400,'INVALID_SAAS_INPUT');
 await sqlDeny(restricted.query('SELECT hon.set_hq_hon_budget($1,$2::jsonb,$3)',[H('owner'),JSON.stringify(budgetIn({creditCap:'100'})),K()]),'22023');
 await sqlDeny(restricted.query('SELECT hon.set_hq_hon_budget($1,$2::jsonb,$3)',[H('owner'),JSON.stringify(budgetIn({periodStart:'2026-02-30'})),K()]),'22023');
 await deny(hon.setBudget(H('owner'),budgetIn({periodStart:month(new Date(),-1)}),K()),422,'HQ_HON_PERIOD_NOT_ALLOWED');
 await deny(hon.setBudget(H('owner'),budgetIn({periodStart:month(new Date(),13)}),K()),422,'HQ_HON_PERIOD_NOT_ALLOWED');
 await deny(hon.setBudget(H('owner'),budgetIn({expectedVersion:1}),K()),409,'SAAS_VERSION_CONFLICT');
 const bk=K(),set1=await hon.setBudget(H('owner'),budgetIn(),bk);
 assert.deepEqual([set1.replayed,set1.budget.creditCap,set1.budget.version,set1.budget.availableCredits,set1.budget.setBy.principalId],[false,100,1,100,P('owner')]);
 assert.equal((await hon.setBudget(H('owner'),budgetIn(),bk)).replayed,true,'replay');
 await deny(hon.setBudget(H('owner'),budgetIn({creditCap:101}),bk),409,'IDEMPOTENCY_KEY_REUSED');
 await deny(hon.setBudget(H('owner'),budgetIn(),K()),409,'SAAS_VERSION_CONFLICT');
 await deny(hon.setBudget(H('owner'),budgetIn({expectedVersion:1}),K()),422,'HQ_HON_BUDGET_NO_CHANGE');
 const set2=await hon.setBudget(H('owner'),budgetIn({creditCap:60,expectedVersion:1,reason:'Trim to sixty'}),K());
 assert.deepEqual([set2.budget.creditCap,set2.budget.version],[60,2]);
 await hon.setBudget(H('owner'),budgetIn({periodStart:NEXT,creditCap:500,reason:'Next month plan'}),K());
 assert.deepEqual((await hon.conversation(H('owner'))).budgetHistory.map(h=>[h.periodStart,h.version,h.creditCap,h.previousCap]),[[NEXT,1,500,null],[NOW,2,60,100],[NOW,1,100,null]]);
 assert.deepEqual((await hon.conversation(H('viewer'))).budgetHistory,[],'cap history is the HQ owner\'s');

 // ---------- 3. ask ----------
 for(const bad of [ask({question:''}),ask({question:' padded'}),ask({question:'x'.repeat(2001)}),ask({question:'bell\u0007'}),ask({agentKey:'claire'}),
  ask({agentKey:'kai'}),ask({agentKey:'Chase'}),ask({replyMode:'LONG'}),{...ask(),organizationId:ORG},(({agentKey,...r})=>r)(ask())])
  await deny(hon.ask(H('owner'),bad,K()),400,'INVALID_SAAS_INPUT');
 await sqlDeny(restricted.query('SELECT hon.ask_hq_hon($1,$2::jsonb,$3)',[H('owner'),JSON.stringify(ask({agentKey:'kai'})),K()]),'22023');
 // A platform-wide AI pause stops HQ turns; an organization's own pause does not.
 await admin.query("INSERT INTO hon.ai_spend_pauses(organization_id,spend_class,reason,pause_key,pause_fingerprint,paused_by_principal_id) VALUES($1,'ALL','Fixture school pause reason',$2,'f',$3)",[ORG,K(),P('owner')]);
 for(const cls of ['AGENT_INFERENCE','ALL']){
  const id=(await row("INSERT INTO hon.ai_spend_pauses(organization_id,spend_class,reason,pause_key,pause_fingerprint,paused_by_principal_id) VALUES(NULL,$1,'Fixture platform pause reason',$2,'f',$3) RETURNING id",[cls,K(),P('owner')])).id;
  await deny(hon.ask(H('owner'),ask(),K()),422,'HQ_HON_PAUSED_BY_HQ');
  await admin.query("UPDATE hon.ai_spend_pauses SET ended_at=clock_timestamp(),end_key=$2,end_reason='Fixture platform pause ended',ended_by_principal_id=$3 WHERE id=$1",[id,K(),P('owner')]);
 }
 const creativePause=(await row("INSERT INTO hon.ai_spend_pauses(organization_id,spend_class,reason,pause_key,pause_fingerprint,paused_by_principal_id) VALUES(NULL,'CREATIVE_MEDIA','Fixture creative-only pause',$1,'f',$2) RETURNING id",[K(),P('owner')])).id;
 assert.equal(provider.calls.length,0,'no refusal reached the provider');
 assert.deepEqual(await counts(),{...start,b:2,h:3,r:3},'only the budget writes so far');

 // The happy path: the viewer asks; one provider call with the HQ overview as facts.
 const k1=K(),a1=await hon.ask(H('viewer'),ask(),k1);
 assert.equal(provider.calls.length,1);
 const call=provider.calls[0];
 assert.deepEqual([call.specialist,call.providerId,call.modelId,call.replyMode,call.step,call.providerRequestId,call.inputBudget,call.outputBudget,call.maxCostMicrounits],
  ['hq_hon','OPENROUTER','fixture/hq-text-model','STANDARD',1,a1.turn.turnId,8000,1500,80000]);
 const facts=JSON.parse(call.facts);
 assert.deepEqual(Object.keys(facts).sort(),['hqAiTextBudget','hqOverview']);
 assert.equal(facts.hqOverview.callerHqRole,undefined,'the caller role is not a fact');
 assert(facts.hqOverview.schoolCount>=1&&facts.hqOverview.organizationCount>=1);
 assert(!call.facts.includes(SCHOOL_NAME)&&!call.facts.includes(ORG)&&!call.facts.includes(S),'no school or organization identity in the facts');
 assert.equal(facts.hqAiTextBudget.creditCap,60);
 assert.deepEqual([a1.replayed,a1.turn.status,a1.turn.reply,a1.turn.truncated,a1.turn.concealed,a1.turn.reservedCredits,a1.turn.chargedCredits,a1.turn.askedBy.principalId],
  [false,'ANSWERED','HQ has 1 school on HON OS. Recorded facts only.',false,false,10,3,P('viewer')],'charged ceil(2500/1000)=3');
 assert.deepEqual(await cost(a1.turn.turnId),{cost_status:'RECORDED',c:1200,i:2100,o:400});
 assert.deepEqual([a1.budget.usedCredits,a1.budget.heldCredits,a1.budget.availableCredits],[3,0,57]);
 const again=await hon.ask(H('viewer'),ask(),k1);
 assert.deepEqual([again.replayed,again.turn.turnId,again.turn.status,provider.calls.length],[true,a1.turn.turnId,'ANSWERED',1],'replay never calls or reserves again');
 await deny(hon.ask(H('viewer'),ask({question:'Something else?'}),k1),409,'IDEMPOTENCY_KEY_REUSED');
 const mine=await hon.conversation(H('viewer'));
 assert.deepEqual([mine.turns.length,mine.turns[0].turnId,mine.underReview],[1,a1.turn.turnId,[]]);
 assert.deepEqual((await hon.conversation(H('owner'))).turns,[],'each person sees their own turns');
 await admin.query("UPDATE hon.ai_spend_pauses SET ended_at=clock_timestamp(),end_key=$2,end_reason='Fixture creative pause ended',ended_by_principal_id=$3 WHERE id=$1",[creativePause,K(),P('owner')]);

 // ---------- 4. outcomes ----------
 provider.next=new HonReplyProviderRuntimeError('FAILED','PROVIDER_REJECTED');
 const f=await hon.ask(H('owner'),ask({replyMode:'DETAILED'}),K());
 assert.deepEqual([f.turn.status,f.turn.failureReason,f.turn.chargedCredits,f.turn.reservedCredits,f.turn.reply],['FAILED','PROVIDER_REJECTED',null,15,null]);
 assert.equal((await cost(f.turn.turnId)).cost_status,'UNKNOWN','a rejection with no reported cost is never a guessed zero');
 provider.next=new HonReplyProviderRuntimeError('PRE_SEND','INVALID_REQUEST');
 const ns=await hon.ask(H('owner'),ask(),K());
 assert.deepEqual([ns.turn.status,ns.turn.failureReason,(await cost(ns.turn.turnId)).c],['FAILED','INVALID_REQUEST',0]);
 provider.next=new HonReplyProviderRuntimeError('UNKNOWN','PROVIDER_UNKNOWN');
 const u=await hon.ask(H('owner'),ask(),K());
 assert.deepEqual([u.turn.status,u.turn.failureReason,u.budget.heldCredits],['UNDER_REVIEW','PROVIDER_UNKNOWN',10]);
 provider.next={reply:'Too long.',inputTokens:9000,outputTokens:100,providerCostMicrounits:10,truncated:false,suggestions:[],followUps:[],sources:[]};
 const over=await hon.ask(H('owner'),ask(),K());
 assert.deepEqual([over.turn.status,over.turn.failureReason],['UNDER_REVIEW','UNVERIFIED_RESULT'],'a result over the budgets is never trusted');
 provider.next={reply:'Ask Marcus.',inputTokens:100,outputTokens:100,providerCostMicrounits:10,truncated:false,suggestions:['marcus'],followUps:[],sources:[]};
 assert.equal((await hon.ask(H('owner'),ask(),K())).turn.status,'UNDER_REVIEW','HQ HON never suggests school specialists');
 assert.equal(provider.calls.length,6);
 // The database holds the bounds too, whatever the API sends.
 const open=await raw('owner',ask());
 assert.deepEqual([open.turn.status,open.replayed,typeof open.invocation.facts],['ANSWERING',false,'string']);
 const replayRaw=await billing.call('askHqHon',[H('owner'),JSON.stringify(ask()),K()],v=>v);
 assert.equal(replayRaw.invocation.turnId,replayRaw.turn.turnId);
 for(const bad of [answered({inputTokens:'5'}),answered({reply:' x'}),answered({failureReason:'PROVIDER_UNKNOWN'}),{...answered(),extra:1},
  {outcome:'FAILED',reply:'x',truncated:null,inputTokens:null,outputTokens:null,providerCostMicrounits:null,failureReason:'PROVIDER_REJECTED'},
  {outcome:'UNKNOWN',reply:null,truncated:null,inputTokens:null,outputTokens:null,providerCostMicrounits:5,failureReason:'PROVIDER_UNKNOWN'}])
  await deny(record('owner',open.turn.turnId,bad),400,'INVALID_SAAS_INPUT');
 await deny(record('viewer',open.turn.turnId,answered()),403,'SAAS_FORBIDDEN');
 await deny(record('owner',open.turn.turnId,{outcome:'UNKNOWN',reply:null,truncated:null,inputTokens:null,outputTokens:null,providerCostMicrounits:null,failureReason:'INTERRUPTED'}),409,'HQ_HON_TURN_IN_PROGRESS');
 const held=await record('owner',open.turn.turnId,answered({providerCostMicrounits:80001}));
 assert.deepEqual([held.turn.status,held.turn.failureReason,held.turn.reply],['UNDER_REVIEW','UNVERIFIED_RESULT',null],'over the cost ceiling is held');
 await deny(record('owner',open.turn.turnId,answered()),409,'SAAS_TRANSITION_NOT_ALLOWED');
 const cut=await record('owner',replayRaw.turn.turnId,answered({inputTokens:8000,outputTokens:1500,truncated:true}));
 assert.deepEqual([cut.turn.status,cut.turn.truncated,cut.turn.chargedCredits],['ANSWERED',true,10],'charge never exceeds the reservation');

 // ---------- 5. caps ----------
 let b=(await hon.conversation(H('owner'))).budget;
 assert.deepEqual([b.usedCredits,b.heldCredits,b.availableCredits],[13,40,7]);
 await deny(hon.ask(H('owner'),ask(),K()),422,'HQ_HON_BUDGET_EXHAUSTED');
 await deny(hon.setBudget(H('owner'),budgetIn({creditCap:52,expectedVersion:2,reason:'Below use'}),K()),422,'HQ_HON_CAP_BELOW_USE');
 await hon.setBudget(H('owner'),budgetIn({creditCap:200,expectedVersion:2,reason:'Room for the in-progress test'}),K());
 const busy=[await raw('owner',ask()),await raw('owner',ask()),await raw('viewer',ask())];
 await deny(hon.ask(H('owner'),ask(),K()),422,'HQ_HON_TOO_MANY_IN_PROGRESS');
 assert.equal(provider.calls.length,6,'caps are refused before any provider call');
 // Close the busy turns so nothing is left open.
 for(const t of busy)await record(t.turn.askedBy.principalId===P('viewer')?'viewer':'owner',t.turn.turnId,answered());

 // ---------- 6. resolution ----------
 const queue=(await hon.conversation(H('owner'))).underReview;
 assert.deepEqual(queue.map(t=>t.turnId).sort(),[u.turn.turnId,over.turn.turnId,open.turn.turnId,(await row("SELECT id FROM hon.hq_hon_turns WHERE failure_reason='UNVERIFIED_RESULT' AND id NOT IN ($1,$2)",[over.turn.turnId,open.turn.turnId])).id].sort());
 assert.deepEqual((await hon.conversation(H('viewer'))).underReview,[],'the review queue is the HQ owner\'s');
 const flying=await raw('owner',ask());
 await deny(hon.resolve(H('owner'),flying.turn.turnId,resolveIn(1),K()),409,'SAAS_TRANSITION_NOT_ALLOWED');
 await record('owner',flying.turn.turnId,answered());
 await deny(hon.resolve(H('owner'),u.turn.turnId,resolveIn(1),K()),409,'SAAS_VERSION_CONFLICT');
 await deny(hon.resolve(H('owner'),u.turn.turnId,resolveIn(2,{resolution:'CHARGED',chargedCredits:11}),K()),422,'HQ_HON_CHARGE_EXCEEDS_RESERVATION');
 await deny(hon.resolve(H('owner'),u.turn.turnId,resolveIn(2,{resolution:'CHARGED',chargedCredits:null}),K()),400,'INVALID_SAAS_INPUT');
 await deny(hon.resolve(H('owner'),randomUUID(),resolveIn(1),K()),404,'SAAS_UNAVAILABLE');
 const rk=K(),r1=await hon.resolve(H('owner'),u.turn.turnId,resolveIn(2,{resolution:'CHARGED',chargedCredits:4,providerCostMicrounits:3000}),rk);
 assert.deepEqual([r1.replayed,r1.turn.status,r1.turn.chargedCredits,r1.turn.reply,(await cost(u.turn.turnId)).c],[false,'RESOLVED_CHARGED',4,null,3000]);
 assert.equal((await hon.resolve(H('owner'),u.turn.turnId,resolveIn(2,{resolution:'CHARGED',chargedCredits:4,providerCostMicrounits:3000}),rk)).replayed,true);
 const r2=await hon.resolve(H('owner'),over.turn.turnId,resolveIn(2),K());
 assert.deepEqual([r2.turn.status,r2.turn.chargedCredits,(await cost(over.turn.turnId)).cost_status],['RESOLVED_NOT_CHARGED',null,'UNKNOWN']);
 await deny(hon.resolve(H('owner'),over.turn.turnId,resolveIn(3),K()),409,'SAAS_TRANSITION_NOT_ALLOWED');

 // ---------- 7. a grant that lapses mid-flight ----------
 const leaving=await raw('leaver',ask({question:'What should HQ look at first today?'}));
 await admin.query("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1",[P('leaver')]);
 const kept=await record('leaver',leaving.turn.turnId,answered({reply:'Look at onboarding.'}));
 assert.deepEqual([kept.turn.status,kept.turn.reply,kept.turn.concealed],['ANSWERED',null,true],'the result is kept, the answer concealed from a lapsed reader');
 assert.deepEqual(await row('SELECT (hon.hq_hon_turn_json(t,$2))->>\'reply\' r FROM hon.hq_hon_turns t WHERE id=$1',[leaving.turn.turnId,P('owner')]),{r:'Look at onboarding.'});
 await deny(hon.conversation(H('leaver')),403,'SAAS_FORBIDDEN');
 await deny(hon.ask(H('leaver'),ask(),K()),403,'SAAS_FORBIDDEN');

 // ---------- 8. the six HQ executives (0264) ----------
 const EXEC=['chase','mia','ethan','olivia','ryan','sophia'];
 assert.deepEqual((await hon.conversation(H('owner'))).availableAgents,['hon',...EXEC],'the HQ owner may ask every executive');
 assert.deepEqual((await hon.conversation(H('viewer'))).availableAgents,['hon']);
 assert.deepEqual((await hon.conversation(H('finance'))).availableAgents,['hon','ethan','olivia','ryan']);
 assert.deepEqual((await hon.conversation(H('ops'))).availableAgents,['hon','sophia']);
 assert.deepEqual((await hon.conversation(H('supportMgr'))).availableAgents,['hon','mia']);
 assert.deepEqual((await hon.conversation(H('mkt2'))).availableAgents,['hon','chase'],'hq.marketing.manage reads HQ marketing');
 await deny(hon.conversation(H('supportOp')),403,'SAAS_FORBIDDEN');
 const before8=await counts();
 for(const[who,agentKey]of [['viewer','chase'],['viewer','olivia'],['ops','mia'],['supportMgr','ryan'],['finance','sophia'],['mkt2','ethan']])
  await deny(hon.ask(H(who),ask({agentKey}),K()),403,'SAAS_FORBIDDEN');
 assert.deepEqual(await counts(),before8,'an executive refusal writes nothing');
 const cur=(await hon.conversation(H('owner'))).budget;
 await hon.setBudget(H('owner'),budgetIn({creditCap:cur.usedCredits+cur.heldCredits+200,expectedVersion:cur.version,reason:'Room for the executive checks'}),K());
 const shapes={chase:['hqCreativeBudget','hqMarketingCampaigns'],mia:['hqSupportCases'],ethan:['hqAiPlatform','hqAiTextBudget','hqCreativeBudget'],
  olivia:['hqAiTextBudget','note','saasInvoices','saasRefundRequests','saasSchedulePaidPeriods'],ryan:['note','saasAccessStates','saasScheduleBindings','saasSubscriptions'],sophia:['hqOnboardingRequests','organizations','saasAccessExceptions']};
 const perms={chase:'hq.marketing.read',mia:'hq.support.manage',ethan:'hq.billing.manage',olivia:'hq.billing.manage',ryan:'hq.billing.manage',sophia:'hq.onboarding.manage'};
 for(const agentKey of EXEC){
  const n=provider.calls.length,r=await hon.ask(H('owner'),ask({agentKey,question:`What should HQ know from ${agentKey} today?`}),K());
  assert.deepEqual([r.turn.agentKey,r.turn.status,r.turn.concealed,provider.calls.length],[agentKey,'ANSWERED',false,n+1],agentKey);
  const call=provider.calls.at(-1),facts=JSON.parse(call.facts);
  assert.deepEqual([call.specialist,call.hqAgent,call.step],['hq_hon',agentKey,1],agentKey);
  assert.deepEqual(Object.keys(facts).sort(),shapes[agentKey],agentKey);
  for(const secret of [SCHOOL_NAME,ORG,S,CASE_SUBJECT,...Object.values(humans).map(h=>h.name)])
   assert(!call.facts.includes(secret),`${agentKey} facts carry no school, organization, case or person identity`);
  assert.deepEqual(await row('SELECT source_permissions s,reserved_credits c FROM hon.hq_hon_turns WHERE id=$1',[r.turn.turnId]),{s:[perms[agentKey]],c:10},agentKey);
  if(agentKey==='mia'){
   assert(facts.hqSupportCases.openByPriority.URGENT>=1&&facts.hqSupportCases.openOlderThan7Days>=1,'the fixture case is counted');
   assert.deepEqual(Object.keys(facts.hqSupportCases.byStatus).sort(),['CLOSED','OPEN','RESOLVED','WAITING_ON_SCHOOL']);
  }
  if(agentKey==='ethan')assert.equal(facts.hqAiPlatform.providerConnections.OPENROUTER,'HEALTHY');
  // 0304: Ryan and Olivia count HON OS schedule billing too, matched against independent reads of the same tables.
  if(agentKey==='ryan'){
   const want=await row(`SELECT count(*) FILTER (WHERE status='ACTIVE')::int active,
     count(*) FILTER (WHERE status='ACTIVE' AND requirements->>'billingInterval'='ANNUAL')::int annual,
     coalesce(sum((requirements->>'lockedPriceMinor')::bigint) FILTER (WHERE status='ACTIVE' AND requirements->>'billingInterval'='ANNUAL'),0)::int annual_minor,
     coalesce(sum((requirements->>'lockedPriceMinor')::bigint) FILTER (WHERE status='ACTIVE' AND requirements->>'billingInterval'='MONTHLY'),0)::int monthly_minor
     FROM hon.saas_schedule_bindings`);
   const b=facts.saasScheduleBindings;
   assert.deepEqual(Object.keys(b.byStatus).sort(),['ACTIVE','BOUND_TEST_ONLY','CANCELLED_BEFORE_PAYMENT','EXPIRED_UNPAID','NEEDS_REVIEW','PENDING_PROVIDER_BINDING','VOIDED_PROVIDER_FAILED']);
   assert.deepEqual([b.byStatus.ACTIVE,b.activeByInterval.ANNUAL,b.activeAnnualListMinor,b.activeMonthlyListMinor],[want.active,want.annual,want.annual_minor,want.monthly_minor]);
   const src=await row(`SELECT count(*) FILTER (WHERE state='PAYMENT_ACTIVE' AND activation_source='SCHEDULE_BINDING')::int sched,
     count(*) FILTER (WHERE state='PAYMENT_ACTIVE' AND activation_source IS NULL)::int v1 FROM hon.saas_access_states`);
   assert.deepEqual(facts.saasAccessStates.paymentActiveBySource,{V1_CHECKOUT:src.v1,SCHEDULE_BINDING:src.sched});
   assert.deepEqual(Object.keys(facts.saasAccessStates.byState).sort(),['AWAITING_FIRST_PAYMENT','PAYMENT_ACTIVE']);
  }
  if(agentKey==='olivia'){
   const p=facts.saasSchedulePaidPeriods,want=await row(`SELECT count(*)::int n,coalesce(sum(amount_minor),0)::int m FROM hon.saas_schedule_paid_periods
     WHERE recorded_at>=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
   assert.deepEqual([p.recordedThisMonth,p.recordedThisMonthMinor,p.recordedThisMonthByInterval.MONTHLY+p.recordedThisMonthByInterval.ANNUAL],[want.n,want.m,want.n]);
  }
  if(agentKey==='sophia')assert(facts.organizations.total>=1&&facts.organizations.byStatus.ACTIVE>=1);
 }
 // An operator whose billing permission ends keeps the record, but the answer is concealed and the executive is gone.
 const fin=await hon.ask(H('finance'),ask({agentKey:'olivia',question:'Any refunds waiting on a decision?'}),K());
 assert.deepEqual([fin.turn.status,fin.turn.concealed],['ANSWERED',false]);
 await admin.query("UPDATE hon.hq_operator_grants SET permission_codes=ARRAY['hq.dashboard.view'] WHERE principal_id=$1",[P('finance')]);
 const finView=await hon.conversation(H('finance'));
 assert.deepEqual(finView.availableAgents,['hon']);
 assert.deepEqual(finView.turns.filter(t=>t.turnId===fin.turn.turnId).map(t=>[t.status,t.reply,t.concealed]),[['ANSWERED',null,true]]);
 await deny(hon.ask(H('finance'),ask({agentKey:'ryan'}),K()),403,'SAAS_FORBIDDEN');
 // The widened checks still refuse anything outside the catalog.
 await sqlDeny(admin.query("UPDATE hon.hq_hon_turns SET agent_key='claire' WHERE id=$1",[fin.turn.turnId]),'42501');
 assert.deepEqual(await row("SELECT hon.hq_hon_agent_permission('claire') c,hon.hq_hon_agent_permission('kai') k"),{c:null,k:null});
 await deny(hon.ask(H('owner'),ask({agentKey:'claire'}),K()),400,'INVALID_SAAS_INPUT');

 // ---------- 9. immutability and isolation ----------
 await sqlDeny(admin.query("UPDATE hon.hq_hon_turns SET question='changed', version=version+1 WHERE id=$1",[a1.turn.turnId]),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_hon_turns SET reply='changed', version=version+1 WHERE id=$1",[a1.turn.turnId]),'42501');
 await sqlDeny(admin.query('DELETE FROM hon.hq_hon_turns WHERE id=$1',[a1.turn.turnId]),'42501');
 await sqlDeny(admin.query('DELETE FROM hon.hq_hon_budget_changes WHERE period_start=$1',[NOW]),'42501');
 await sqlDeny(admin.query('TRUNCATE hon.hq_hon_requests'),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_hon_budget_periods SET credit_cap=1 WHERE period_start=$1",[NOW]),'42501');
 assert.deepEqual(await schoolSide(),school,'no school AI usage, plan, turn, invocation or creative row was written');
 assert.equal((await row("SELECT count(*)::int n FROM hon.hq_hon_turns WHERE status='ANSWERING'")).n,0);
 console.log('HQ Ask HON proof passed (posture, authority incl. owner-only cap and review, provider-not-connected before any write, route/pause/budget/in-progress refusals, HQ overview facts without school identity, one provider call per turn with idempotent replay and key reuse, measured settlement never above the reservation, failed/not-sent/unknown/out-of-bounds outcomes, interrupted only after 120 s, owner resolution, lapsed grant keeps the result and conceals the answer, six HQ executives with per-agent permission, aggregate facts without identity and concealment when a permission ends, immutability, nothing school-side).');
}finally{
 await cleanup().catch(e=>console.error('cleanup failed',e));
 await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy?.()]);
}
