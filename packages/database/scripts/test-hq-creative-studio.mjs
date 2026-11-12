import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// M2 HQ Creative Studio + HQ creative budget (0253) integrity proof, TEST MODE, disposable database only. It proves: the
// runtime can execute only the six entry points and has no table privilege; only the HQ owner sets the monthly HQ cap
// (current or next 12 UTC months, versioned, idempotent, never below use, immutable history); the HQ owner or an operator
// with hq.marketing.manage requests, hq.marketing.read only reads, and support, billing, lapsed owners, school owners and
// strangers are refused; with no provider connected the API refuses before any write; a request reserves the published
// rate against the HQ cap (not set, exhausted, too many in progress, platform creative pause, unpriced, units, archived
// campaign all refused with nothing written); replays never reserve twice and key reuse is refused; outcomes are recorded
// once (succeeded charges actual units, failed/not-sent charge nothing, unverified and unknown are held for the HQ owner,
// interrupted only after 120 s); the HQ owner resolves held requests; rows never change outside those moves; no school
// creative wallet, lot, ledger, reservation, usage or school generation row is touched; a person revoked meanwhile gets nothing.
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env);
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|ZERNIO|META|GOOGLE|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {HqMarketingService}=await import('../../../apps/api/dist/hq-marketing/hq-marketing.service.js');
const {HqCreativeService}=await import('../../../apps/api/dist/hq-creative/hq-creative.service.js');
const {SyntheticCreativeProviderRuntime,UnconfiguredCreativeProviderRuntime}=await import('../../../apps/api/dist/creative-studio/creative-provider-runtime.js');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),marketing=new HqMarketingService(billing);
const provider=new SyntheticCreativeProviderRuntime('SUCCEED'),creative=new HqCreativeService(billing,provider);
const offline=new HqCreativeService(billing,new UnconfiguredCreativeProviderRuntime());
const admin=new pg.Client(targets.owner),restricted=new pg.Client(targets.runtime);
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID();
const ORG=randomUUID(),S=randomUUID(),ROLE=randomUUID();
const humans=Object.fromEntries(['owner','exowner','marketer','reader','supportOp','billingOp','schoolOwner','stranger','leaver']
 .map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`hqcs-${k}-${randomUUID()}`,name:`Fixture ${k}`}]));
const H=k=>humans[k].subject,P=k=>humans[k].id;
const tables=['hq_creative_requests','hq_creative_generation_assets','hq_creative_generations','hq_creative_budget_changes','hq_creative_budget_periods'];
let createdRates=null,createdProvider=false;
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of [...tables,'hq_marketing_requests','hq_marketing_campaign_versions','hq_marketing_campaigns','saas_creative_rates','saas_creative_rate_versions'])
   await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  const ps=Object.values(humans).map(h=>h.id),us=Object.values(humans).map(h=>h.user);
  const gs=(await admin.query('SELECT id FROM hon.hq_creative_generations WHERE requested_by=ANY($1::uuid[])',[ps])).rows.map(r=>r.id);
  await admin.query('DELETE FROM hon.hq_creative_requests WHERE actor_principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.hq_creative_generation_assets WHERE generation_id=ANY($1::uuid[])',[gs]);
  await admin.query('DELETE FROM hon.hq_creative_generations WHERE id=ANY($1::uuid[])',[gs]);
  await admin.query('DELETE FROM hon.hq_creative_budget_changes WHERE actor_principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.hq_creative_budget_periods WHERE set_by=ANY($1::uuid[])',[ps]);
  const cs=(await admin.query('SELECT id FROM hon.hq_marketing_campaigns WHERE created_by=ANY($1::uuid[])',[ps])).rows.map(r=>r.id);
  await admin.query('DELETE FROM hon.hq_marketing_requests WHERE campaign_id=ANY($1::uuid[])',[cs]);
  await admin.query('DELETE FROM hon.hq_marketing_campaign_versions WHERE campaign_id=ANY($1::uuid[])',[cs]);
  await admin.query('DELETE FROM hon.hq_marketing_campaigns WHERE id=ANY($1::uuid[])',[cs]);
  if(createdRates){await admin.query('DELETE FROM hon.saas_creative_rates WHERE rate_version_id=$1',[createdRates]);await admin.query('DELETE FROM hon.saas_creative_rate_versions WHERE id=$1',[createdRates]);}
  for(const t of [...tables,'hq_marketing_requests','hq_marketing_campaign_versions','hq_marketing_campaigns','saas_creative_rates','saas_creative_rate_versions'])
   await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('ALTER TABLE hon.ai_spend_pauses DISABLE TRIGGER USER');
  await admin.query('DELETE FROM hon.ai_spend_pauses WHERE paused_by_principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('ALTER TABLE hon.ai_spend_pauses ENABLE TRIGGER USER');
  if(createdProvider)await admin.query("DELETE FROM hon.hq_ai_provider_connections WHERE provider_id='HIGGSFIELD'");
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`,[ORG]);
  await admin.query('DELETE FROM hon.organizations WHERE id=$1',[ORG]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[us]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const counts=async()=>row(`SELECT (SELECT count(*) FROM hon.hq_creative_generations)::int g,(SELECT count(*) FROM hon.hq_creative_generation_assets)::int a,
 (SELECT count(*) FROM hon.hq_creative_budget_periods)::int b,(SELECT count(*) FROM hon.hq_creative_budget_changes)::int h,(SELECT count(*) FROM hon.hq_creative_requests)::int r`);
// Everything a school creative wallet or school generation is made of. HQ creative must never write any of it.
const schoolSide=async()=>row(`SELECT (SELECT count(*) FROM hon.saas_creative_wallets)::int w,(SELECT count(*) FROM hon.saas_creative_lots)::int l,
 (SELECT count(*) FROM hon.saas_creative_ledger)::int lg,(SELECT count(*) FROM hon.saas_creative_reservations)::int rs,
 (SELECT count(*) FROM hon.saas_creative_cost_events)::int ce,(SELECT count(*) FROM hon.creative_generations)::int sg,
 (SELECT count(*) FROM hon.ai_usage_ledger)::int u`);
const month=(d=new Date(),plus=0)=>{const x=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+plus,1));return x.toISOString().slice(0,10);};
const NOW=month(),NEXT=month(new Date(),1);
const ask=(patch={})=>({operationCode:'image.generate',units:2,format:'SQUARE',prompt:'Founder 50 poster: dojo owner smiling at a calm front desk.',campaignId:null,...patch});
const budgetIn=(patch={})=>({periodStart:NOW,creditCap:100,expectedVersion:null,reason:'November HQ creative test budget',...patch});
const record=(who,id,p)=>billing.call('recordHqCreativeGenerationResult',[H(who),id,JSON.stringify(p)],v=>v);
const resolveIn=(v,patch={})=>({expectedVersion:v,resolution:'NOT_CHARGED',finalUnits:null,providerCostMicrounits:null,evidenceReference:'Provider dashboard export 2026-11',...patch});

await Promise.all([admin.connect(),restricted.connect()]);
await verifyChampionsProofConnection(admin,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection(restricted,CHAMPIONS_RUNTIME_ROLE);
await verifyChampionsProofConnection({query:(...a)=>database['getPool']().query(...a)},CHAMPIONS_RUNTIME_ROLE);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- 0. posture ----------
 for(const[sig,allowed]of [['set_hq_creative_budget(text,jsonb,uuid)',true],['create_hq_creative_generation(text,jsonb,jsonb,uuid)',true],
  ['record_hq_creative_generation_result(text,uuid,jsonb)',true],['resolve_hq_creative_generation(text,uuid,jsonb,uuid)',true],['read_hq_creative_studio(text)',true],
  ['read_hq_creative_generation(text,uuid)',true],['require_hq_creative_owner(text)',false],['hq_creative_owner_eligible(uuid)',false],
  ['hq_creative_claim(uuid,uuid,text,text)',false],['hq_creative_lock_period(date)',false],['hq_creative_budget_json(date)',false]])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
 for(const t of tables)for(const priv of ['SELECT','INSERT','UPDATE','DELETE'])
  assert.equal((await restricted.query('SELECT has_table_privilege(current_user,$1,$2) a',['hon.'+t,priv])).rows[0].a,false,`${t} ${priv}`);
 for(const t of tables)assert.deepEqual(await row("SELECT relrowsecurity r,relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass",['hon.'+t]),{r:true,f:true},t);
 await cleanup();
 assert.deepEqual(await counts(),{g:0,a:0,b:0,h:0,r:0},'the disposable database holds no other HQ creative rows');

 // ---------- fixture ----------
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[h.user,h.subject,`${h.user}@example.test`,h.name]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,true)",[h.id,h.user,h.name]);}
 for(const[who,role,perms,until]of [['owner','HON_HQ_OWNER',[],null],['exowner','HON_HQ_OWNER',[],'1 minute'],['marketer','HON_HQ_OPERATOR',['hq.marketing.manage'],null],
  ['reader','HON_HQ_OPERATOR',['hq.marketing.read'],null],['supportOp','HON_HQ_SUPPORT',['hq.marketing.manage','hq.support.manage'],null],
  ['billingOp','HON_HQ_OPERATOR',['hq.billing.manage','hq.dashboard.view'],null],['leaver','HON_HQ_OPERATOR',['hq.marketing.manage'],null]])
  await admin.query(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',${until?`clock_timestamp()-interval '${until}'`:'NULL'})`,[P(who),role,perms]);
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'HQCS Fixture Dojo','HQCS Fixture Dojo','ACTIVE',clock_timestamp())",[ORG]);
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'HQCS Main',$1::text,'UTC')",[S,ORG]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[ROLE,ORG]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[ROLE,ORG]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[ORG,S,P('schoolOwner'),ROLE]);
 if((await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state) VALUES('HIGGSFIELD','Fixture provider','DISABLED') ON CONFLICT DO NOTHING RETURNING provider_id")).rowCount)createdProvider=true;
 assert.equal((await admin.query("SELECT 1 FROM hon.saas_creative_rate_versions WHERE status='PUBLISHED'")).rowCount,0,'no other published school rates in the disposable database');
 createdRates=(await row("INSERT INTO hon.saas_creative_rate_versions(rate_version,status,terms_reference,published_by_principal_id,published_at) VALUES((SELECT coalesce(max(rate_version),0)+1 FROM hon.saas_creative_rate_versions),'PUBLISHED','Fixture provisional creative rates (not final prices)',$1,clock_timestamp()) RETURNING id",[P('owner')])).id;
 await admin.query(`INSERT INTO hon.saas_creative_rates(rate_version_id,operation_code,media_kind,display_name,billing_unit,credits_per_unit,max_units_per_request,rate_basis)
  VALUES($1,'image.generate','IMAGE','Image',  'IMAGE',10,4,'PROVISIONAL'),($1,'video.generate','VIDEO','Short video','VIDEO_SECOND',5,30,'PROVISIONAL')`,[createdRates]);
 await admin.query('COMMIT');
 const start=await counts(),school=await schoolSide();

 // ---------- 1. authority ----------
 for(const who of ['exowner','supportOp','billingOp','schoolOwner','stranger']){
  await deny(creative.studio(H(who)),403,'SAAS_FORBIDDEN');
  await deny(creative.create(H(who),ask(),K()),403,'SAAS_FORBIDDEN');
  await deny(creative.setBudget(H(who),budgetIn(),K()),403,'SAAS_FORBIDDEN');
 }
 await deny(creative.studio('hqcs-unknown-'+randomUUID()),403,'SAAS_FORBIDDEN');
 const first=await creative.studio(H('reader'));
 assert.deepEqual([first.provider,first.viewer.canManage,first.viewer.isOwner,first.generations,first.budgetHistory],['CONNECTED',false,false,[],[]]);
 assert.deepEqual(first.budget,{periodStart:NOW,creditCap:null,usedCredits:0,heldCredits:0,availableCredits:0,inProgress:0,version:null,setBy:null,setAt:null});
 assert.deepEqual(first.rates.map(r=>[r.operationCode,r.creditsPerUnit,r.maxUnitsPerRequest]),[['image.generate',10,4],['video.generate',5,30]],'the published school rates, read only');
 assert.deepEqual([(await creative.studio(H('marketer'))).viewer.isOwner,(await creative.studio(H('owner'))).viewer.isOwner],[false,true]);
 await deny(creative.create(H('reader'),ask(),K()),403,'SAAS_FORBIDDEN');
 for(const who of ['reader','marketer'])await deny(creative.setBudget(H(who),budgetIn(),K()),403,'SAAS_FORBIDDEN');
 await deny(creative.read(H('owner'),randomUUID()),404,'SAAS_UNAVAILABLE');
 // With no provider connected the API refuses before the database is asked: nothing is reserved or written.
 await deny(offline.create(H('owner'),ask(),K()),503,'CREATIVE_PROVIDER_NOT_CONNECTED');
 assert.equal((await offline.studio(H('owner'))).provider,'NOT_CONNECTED');
 assert.deepEqual(await counts(),start,'refusals wrote nothing');

 // ---------- 2. budget ----------
 await deny(creative.create(H('owner'),ask(),K()),422,'HQ_CREATIVE_BUDGET_NOT_SET');
 for(const bad of [budgetIn({periodStart:'2026-11-02'}),budgetIn({creditCap:-1}),budgetIn({creditCap:10000001}),budgetIn({creditCap:1.5}),budgetIn({reason:'no'}),
  budgetIn({reason:' padded '}),budgetIn({expectedVersion:0}),{...budgetIn(),extra:1}])
  await deny(creative.setBudget(H('owner'),bad,K()),400,'INVALID_SAAS_INPUT');
 await sqlDeny(restricted.query('SELECT hon.set_hq_creative_budget($1,$2::jsonb,$3)',[H('owner'),JSON.stringify(budgetIn({creditCap:'100'})),K()]),'22023');
 await deny(creative.setBudget(H('owner'),budgetIn({periodStart:month(new Date(),-1)}),K()),422,'HQ_CREATIVE_PERIOD_NOT_ALLOWED');
 await deny(creative.setBudget(H('owner'),budgetIn({periodStart:month(new Date(),13)}),K()),422,'HQ_CREATIVE_PERIOD_NOT_ALLOWED');
 await deny(creative.setBudget(H('owner'),budgetIn({expectedVersion:1}),K()),409,'SAAS_VERSION_CONFLICT');
 const bk=K(),set1=await creative.setBudget(H('owner'),budgetIn(),bk);
 assert.deepEqual([set1.replayed,set1.budget.creditCap,set1.budget.version,set1.budget.availableCredits,set1.budget.setBy.principalId],[false,100,1,100,P('owner')]);
 assert.deepEqual((await creative.setBudget(H('owner'),budgetIn(),bk)).replayed,true,'replay');
 await deny(creative.setBudget(H('owner'),budgetIn({creditCap:101}),bk),409,'IDEMPOTENCY_KEY_REUSED');
 await deny(creative.setBudget(H('owner'),budgetIn(),K()),409,'SAAS_VERSION_CONFLICT');
 await deny(creative.setBudget(H('owner'),budgetIn({expectedVersion:1}),K()),422,'HQ_CREATIVE_BUDGET_NO_CHANGE');
 const set2=await creative.setBudget(H('owner'),budgetIn({creditCap:60,expectedVersion:1,reason:'Trim to sixty'}),K());
 assert.deepEqual([set2.budget.creditCap,set2.budget.version],[60,2]);
 await creative.setBudget(H('owner'),budgetIn({periodStart:NEXT,creditCap:500,reason:'Next month plan'}),K());
 const hist=(await creative.studio(H('owner'))).budgetHistory;
 assert.deepEqual(hist.map(h=>[h.periodStart,h.version,h.creditCap,h.previousCap]),[[NEXT,1,500,null],[NOW,2,60,100],[NOW,1,100,null]]);

 // ---------- 3. request ----------
 for(const bad of [ask({units:0}),ask({units:1.5}),ask({format:'WIDE'}),ask({prompt:''}),ask({prompt:' x'}),ask({prompt:'a‮b'}),ask({campaignId:'nope'}),
  ask({operationCode:'Bad'}),{...ask(),providerId:'HIGGSFIELD'},(({campaignId,...r})=>r)(ask())])
  await deny(creative.create(H('owner'),bad,K()),400,'INVALID_SAAS_INPUT');
 await sqlDeny(restricted.query('SELECT hon.create_hq_creative_generation($1,$2::jsonb,$3::jsonb,$4)',[H('owner'),JSON.stringify(ask()),JSON.stringify({providerId:'HIGGSFIELD'}),K()]),'22023');
 await deny(creative.create(H('owner'),ask({operationCode:'audio.generate'}),K()),422,'HQ_CREATIVE_OPERATION_NOT_PRICED');
 await deny(creative.create(H('owner'),ask({units:5}),K()),422,'HQ_CREATIVE_UNITS_EXCEEDED');
 await deny(creative.create(H('owner'),ask({campaignId:randomUUID()}),K()),404,'SAAS_UNAVAILABLE');
 // Archived campaigns cannot be linked; an open one can.
 const camp=(await marketing.create(H('owner'),{code:'CREATIVE-M2',name:'Creative push',goal:'Fresh poster set for the founder offer.',audience:'NEW_SCHOOLS',
  offerLabel:'Founder 50',channel:'META_ADS',startsOn:'2027-03-01',endsOn:'2027-03-31',plannedBudgetMinor:0},K())).campaign;
 const gone=(await marketing.create(H('owner'),{code:'CREATIVE-OLD',name:'Old push',goal:'Old poster set for the founder offer.',audience:'NEW_SCHOOLS',
  offerLabel:'Founder 50',channel:'META_ADS',startsOn:'2027-03-01',endsOn:'2027-03-31',plannedBudgetMinor:0},K())).campaign;
 await marketing.status(H('owner'),gone.campaignId,{expectedVersion:1,status:'ARCHIVED'},K());
 await deny(creative.create(H('owner'),ask({campaignId:gone.campaignId}),K()),422,'HQ_CAMPAIGN_ARCHIVED');
 // A platform-wide creative pause stops HQ requests too; an organization pause does not.
 await admin.query("INSERT INTO hon.ai_spend_pauses(organization_id,spend_class,reason,pause_key,pause_fingerprint,paused_by_principal_id) VALUES($1,'ALL','Fixture school pause reason',$2,'f',$3)",[ORG,K(),P('owner')]);
 const pauseId=(await row("INSERT INTO hon.ai_spend_pauses(organization_id,spend_class,reason,pause_key,pause_fingerprint,paused_by_principal_id) VALUES(NULL,'CREATIVE_MEDIA','Fixture platform pause reason',$1,'f',$2) RETURNING id",[K(),P('owner')])).id;
 await deny(creative.create(H('owner'),ask(),K()),422,'HQ_CREATIVE_PAUSED_BY_HQ');
 await admin.query("UPDATE hon.ai_spend_pauses SET ended_at=clock_timestamp(),end_key=$2,end_reason='Fixture platform pause ended',ended_by_principal_id=$3 WHERE id=$1",[pauseId,K(),P('owner')]);
 // Pause race (S4 gate): while a platform pause command holds 'ai.pause:platform:CREATIVE_MEDIA' exclusively and has
 // recorded its pause but not committed, an HQ request waits on the shared gate, then sees the pause and is refused.
 {const pauser=new pg.Client(targets.owner);await pauser.connect();
  try{
   await pauser.query('BEGIN');
   await pauser.query("SELECT pg_advisory_xact_lock(hashtextextended('ai.pause:platform:CREATIVE_MEDIA',0))");
   const racedId=(await pauser.query("INSERT INTO hon.ai_spend_pauses(organization_id,spend_class,reason,pause_key,pause_fingerprint,paused_by_principal_id) VALUES(NULL,'CREATIVE_MEDIA','Fixture raced platform pause',$1,'f',$2) RETURNING id",[K(),P('owner')])).rows[0].id;
   let settled=false;const raced=creative.create(H('owner'),ask(),K()).finally(()=>{settled=true;});
   raced.catch(()=>{});
   let waiting=false;
   for(let i=0;i<100&&!waiting;i++){await new Promise(r=>setTimeout(r,50));
    waiting=(await admin.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].n>0;}
   assert(waiting&&!settled,'the HQ request waits on the platform pause gate');
   await pauser.query('COMMIT');
   await deny(raced,422,'HQ_CREATIVE_PAUSED_BY_HQ');
   await admin.query("UPDATE hon.ai_spend_pauses SET ended_at=clock_timestamp(),end_key=$2,end_reason='Fixture raced pause ended',ended_by_principal_id=$3 WHERE id=$1",[racedId,K(),P('owner')]);
  }finally{await pauser.query('ROLLBACK').catch(()=>{});await pauser.end();}}
 const before=await counts();
 assert.equal(before.g,0,'no refused request wrote a generation');

 // Success: 2 images x 10 = 20 reserved; the synthetic provider returns 2 images; 20 charged.
 provider.behaviour='SUCCEED';provider.calls.length=0;
 const gk=K(),ok=await creative.create(H('marketer'),ask({campaignId:camp.campaignId}),gk);
 assert.deepEqual([ok.replayed,ok.generation.status,ok.generation.reservedCredits,ok.generation.chargedCredits,ok.generation.assets.length,ok.generation.campaign.code,ok.generation.requestedBy.principalId],
  [false,'SUCCEEDED',20,20,2,'CREATIVE-M2',P('marketer')]);
 assert.deepEqual([ok.budget.usedCredits,ok.budget.heldCredits,ok.budget.availableCredits],[20,0,40]);
 assert.equal(provider.calls.length,1);
 const again=await creative.create(H('marketer'),ask({campaignId:camp.campaignId}),gk);
 assert.deepEqual([again.replayed,again.generation.generationId,provider.calls.length],[true,ok.generation.generationId,1],'replay never calls the provider again');
 await deny(creative.create(H('marketer'),ask({units:1}),gk),409,'IDEMPOTENCY_KEY_REUSED');
 assert.ok(!/HIGGSFIELD|synthetic-image|synthetic:|providerCost/.test(JSON.stringify(await creative.studio(H('reader')))),'no provider identity, model, cost or reference in the view');
 // Rejected (with cost) and not-sent charge nothing.
 provider.behaviour='REJECT_WITH_COST';
 const rej=await creative.create(H('owner'),ask({units:1}),K());
 assert.deepEqual([rej.generation.status,rej.generation.failureReason,rej.generation.chargedCredits,rej.budget.availableCredits],['FAILED','PROVIDER_REJECTED',null,40]);
 assert.deepEqual(await row('SELECT cost_status,provider_cost_microunits::int c FROM hon.hq_creative_generations WHERE id=$1',[rej.generation.generationId]),{cost_status:'RECORDED',c:250});
 provider.behaviour='REJECT';
 const rej2=await creative.create(H('owner'),ask({units:1}),K());
 assert.equal((await row('SELECT cost_status FROM hon.hq_creative_generations WHERE id=$1',[rej2.generation.generationId])).cost_status,'UNKNOWN','an unreported cost is never a guessed zero');
 provider.behaviour='PRE_SEND';
 const ns=await creative.create(H('owner'),ask({units:1}),K());
 assert.deepEqual([ns.generation.status,ns.generation.failureReason],['FAILED','INVALID_REQUEST']);
 // Unverified and unknown results are held for the HQ owner.
 provider.behaviour='UNVERIFIED';
 const uv=await creative.create(H('owner'),ask({units:1}),K());
 assert.deepEqual([uv.generation.status,uv.generation.failureReason,uv.budget.heldCredits,uv.budget.availableCredits],['UNDER_REVIEW','UNVERIFIED_RESULT',10,30]);
 provider.behaviour='UNKNOWN';
 const unk=await creative.create(H('owner'),ask({units:1}),K());
 assert.deepEqual([unk.generation.status,unk.budget.heldCredits,unk.budget.availableCredits],['UNDER_REVIEW',20,20]);
 // The cap is never lowered below what is used plus held.
 await deny(creative.setBudget(H('owner'),budgetIn({creditCap:39,expectedVersion:2,reason:'Too low'}),K()),422,'HQ_CREATIVE_CAP_BELOW_USE');
 await deny(creative.create(H('owner'),ask({units:3}),K()),422,'HQ_CREATIVE_BUDGET_EXHAUSTED');

 // ---------- 4. in flight, interrupted, at most 3 ----------
 await creative.setBudget(H('owner'),budgetIn({creditCap:200,expectedVersion:2,reason:'Room for more'}),K());
 const pending=[];
 for(let i=0;i<3;i++){const key=K();const r=await billing.call('createHqCreativeGeneration',[H('owner'),JSON.stringify(ask({units:1,prompt:`Pending poster ${i}`})),
  JSON.stringify({providerId:'HIGGSFIELD',modelCode:'synthetic-image-1'}),key],v=>v);pending.push({key,g:r.generation});}
 assert.deepEqual(pending.map(p=>p.g.status),['GENERATING','GENERATING','GENERATING']);
 await deny(creative.create(H('owner'),ask({units:1}),K()),422,'HQ_CREATIVE_TOO_MANY_IN_PROGRESS');
 const p0=pending[0].g;
 await deny(record('marketer',p0.generationId,{outcome:'UNKNOWN',finalUnits:null,providerCostMicrounits:null,failureReason:'PROVIDER_UNKNOWN',assets:null}),403,'SAAS_FORBIDDEN');
 await deny(record('owner',p0.generationId,{outcome:'UNKNOWN',finalUnits:null,providerCostMicrounits:null,failureReason:'INTERRUPTED',assets:null}),409,'CREATIVE_GENERATION_IN_PROGRESS');
 // A replay before 120 s returns the request unchanged; after it, the request is held as INTERRUPTED (no provider call).
 provider.behaviour='SUCCEED';provider.calls.length=0;
 const early=await creative.create(H('owner'),ask({units:1,prompt:'Pending poster 0'}),pending[0].key);
 assert.deepEqual([early.replayed,early.generation.status,provider.calls.length],[true,'GENERATING',0]);
 await admin.query('ALTER TABLE hon.hq_creative_generations DISABLE TRIGGER guarded');
 await admin.query("UPDATE hon.hq_creative_generations SET created_at=created_at-interval '3 minutes' WHERE id=$1",[p0.generationId]);
 await admin.query('ALTER TABLE hon.hq_creative_generations ENABLE TRIGGER guarded');
 const held=await creative.create(H('owner'),ask({units:1,prompt:'Pending poster 0'}),pending[0].key);
 assert.deepEqual([held.replayed,held.generation.status,held.generation.failureReason,provider.calls.length],[true,'UNDER_REVIEW','INTERRUPTED',0]);
 // Recorded exactly once.
 const p1=pending[1].g;
 const won=await record('owner',p1.generationId,{outcome:'SUCCEEDED',finalUnits:1,providerCostMicrounits:900,failureReason:null,
  assets:[{mediaType:'image/webp',width:1024,height:1024,durationSeconds:null,providerAssetReference:'synthetic:x:1'}]});
 assert.equal(won.generation.status,'SUCCEEDED');
 await deny(record('owner',p1.generationId,{outcome:'NOT_SENT',finalUnits:null,providerCostMicrounits:null,failureReason:'INVALID_REQUEST',assets:null}),409,'SAAS_TRANSITION_NOT_ALLOWED');
 await sqlDeny(restricted.query('SELECT hon.record_hq_creative_generation_result($1,$2,$3::jsonb)',[H('owner'),pending[2].g.generationId,
  JSON.stringify({outcome:'SUCCEEDED',finalUnits:2,providerCostMicrounits:1,failureReason:null,assets:[{mediaType:'image/png',width:1,height:1,durationSeconds:null,providerAssetReference:'s:1'}]})]),'22023');

 // ---------- 5. HQ owner resolution ----------
 await deny(creative.resolve(H('marketer'),uv.generation.generationId,resolveIn(uv.generation.version),K()),403,'SAAS_FORBIDDEN');
 await deny(creative.resolve(H('owner'),ok.generation.generationId,resolveIn(ok.generation.version),K()),409);
 await deny(creative.resolve(H('owner'),uv.generation.generationId,resolveIn(1),K()),409,'SAAS_VERSION_CONFLICT');
 await deny(creative.resolve(H('owner'),uv.generation.generationId,resolveIn(uv.generation.version,{resolution:'SUCCEEDED',finalUnits:2}),K()),422,'HQ_CREATIVE_FINAL_EXCEEDS_RESERVATION');
 for(const bad of [resolveIn(2,{finalUnits:1}),resolveIn(2,{resolution:'SUCCEEDED'}),resolveIn(2,{evidenceReference:''}),resolveIn(2,{providerCostMicrounits:-1})])
  await deny(creative.resolve(H('owner'),uv.generation.generationId,bad,K()),400,'INVALID_SAAS_INPUT');
 const rk=K(),r1=await creative.resolve(H('owner'),uv.generation.generationId,resolveIn(uv.generation.version,{resolution:'SUCCEEDED',finalUnits:1,providerCostMicrounits:700}),rk);
 assert.deepEqual([r1.replayed,r1.generation.status,r1.generation.chargedCredits],[false,'RESOLVED_CHARGED',10]);
 assert.equal((await creative.resolve(H('owner'),uv.generation.generationId,resolveIn(uv.generation.version,{resolution:'SUCCEEDED',finalUnits:1,providerCostMicrounits:700}),rk)).replayed,true);
 const r2=await creative.resolve(H('owner'),unk.generation.generationId,resolveIn(unk.generation.version),K());
 assert.deepEqual([r2.generation.status,r2.generation.chargedCredits],['RESOLVED_NOT_CHARGED',null]);
 // The owner may also close a request still GENERATING (a lost API process), but only once it is clearly interrupted
 // (120 s), so a late provider result is never overtaken; after that its late result is refused.
 const p2=pending[2].g;
 await deny(creative.resolve(H('owner'),p2.generationId,resolveIn(p2.version),K()),409,'SAAS_TRANSITION_NOT_ALLOWED');
 await admin.query('ALTER TABLE hon.hq_creative_generations DISABLE TRIGGER guarded');
 await admin.query("UPDATE hon.hq_creative_generations SET created_at=created_at-interval '3 minutes' WHERE id=$1",[p2.generationId]);
 await admin.query('ALTER TABLE hon.hq_creative_generations ENABLE TRIGGER guarded');
 await creative.resolve(H('owner'),p2.generationId,resolveIn(p2.version),K());
 await deny(record('owner',p2.generationId,{outcome:'NOT_SENT',finalUnits:null,providerCostMicrounits:null,failureReason:'INVALID_REQUEST',assets:null}),409,'SAAS_TRANSITION_NOT_ALLOWED');
 const fin=(await creative.studio(H('owner'))).budget;
 // used: 20 (ok) + 10 (p1) + 10 (uv resolved) = 40; held: p0 interrupted 10.
 assert.deepEqual([fin.usedCredits,fin.heldCredits,fin.availableCredits,fin.inProgress],[40,10,150,0]);
 assert.equal((await creative.read(H('reader'),p0.generationId)).status,'UNDER_REVIEW');

 // ---------- 6. immutability and separation ----------
 await sqlDeny(admin.query("UPDATE hon.hq_creative_generations SET prompt='changed' WHERE id=$1",[ok.generation.generationId]),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_creative_generations SET status='GENERATING',version=version+1 WHERE id=$1",[rej.generation.generationId]),'42501');
 await sqlDeny(admin.query('DELETE FROM hon.hq_creative_generations WHERE id=$1',[ok.generation.generationId]),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_creative_budget_changes SET credit_cap=1"),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_creative_budget_periods SET credit_cap=1 WHERE period_start=$1",[NOW]),'42501');
 await sqlDeny(admin.query('DELETE FROM hon.hq_creative_generation_assets'),'42501');
 await sqlDeny(admin.query('DELETE FROM hon.hq_creative_requests'),'42501');
 await sqlDeny(admin.query('TRUNCATE hon.hq_creative_budget_changes'),'42501');
 await assert.rejects(admin.query("INSERT INTO hon.hq_creative_generation_assets(generation_id,ordinal,media_type,width,height,origin,provider_asset_reference,created_at) VALUES($1,9,'image/png',1,1,'PROVIDER','x',now())",[ok.generation.generationId]),e=>e.code==='23514','only SYNTHETIC results');
 assert.deepEqual(await schoolSide(),school,'no school creative wallet, lot, ledger, reservation, cost, usage or school generation row was written');

 // ---------- 7. revocation ----------
 const lk=K();
 await admin.query("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1",[P('leaver')]);
 await deny(creative.studio(H('leaver')),403,'SAAS_FORBIDDEN');
 await deny(creative.create(H('leaver'),ask({units:1}),lk),403,'SAAS_FORBIDDEN');
 assert.equal((await row('SELECT count(*)::int n FROM hon.hq_creative_generations WHERE requested_by=$1',[P('leaver')])).n,0);
 console.log('HQ Creative Studio proof passed (posture, authority incl. read-only and owner-only, provider-not-connected before any write, budget periods/versions/history/floor, rates, request refusals incl. pause (and the pause-gate race)/campaign/cap/in-progress, idempotent replay and key reuse, outcomes recorded once, interrupted after 120 s, owner resolution, immutability, no school wallet rows, revocation).');
}finally{
 await cleanup().catch(e=>console.error('cleanup failed',e));
 await Promise.all([admin.end(),restricted.end(),database.onModuleDestroy?.()]);
}
