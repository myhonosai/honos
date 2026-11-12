/** HON OS 14-day free trial (0246): real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL.
 *  No provider, no payment, no AI call. Trial AI credit is checked at the decision and ceiling the agents use. The sign-up and trial programs are opened to TEST_MODE by this proof's owner connection only.
 *  The HQ trial policy, campaign and publication below are SYNTHETIC fixtures made through the 0187 owner-only service. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
import {trialTerms,trialDefinition,trialApproval,trialPromoLimits,trialPromoBudget} from './trial-governance-fixture.mjs';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {HonOsTrialService}=require('./dist/accounts/hon-os-trial.service.js');
const {HonOsTrialController,HonOsTrialHumanGuard}=require('./dist/accounts/hon-os-trial.controller.js');
const {SaasBillingService}=require('./dist/saas-billing/saas-billing.service.js');
const {SaasTrialsService}=require('./dist/saas-trials/saas-trials.service.js');
const {SIGNUP_CONFIRMATION,TRIAL_CONFIRMATION,TRIAL_HUMAN_COMMAND}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),blocker=new pg.Client({connectionString:owner.toString(),ssl:false});
const database=new RuntimeDatabaseService(),trials=new SaasTrialsService(new SaasBillingService(database));let app,groups=0,origin;
const session={mode:'OIDC',audience:'trial-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS TRIAL '+(++groups)+' '+name);
const hash=x=>createHash('sha256').update(x).digest('hex');
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const DAY=86400_000,reason='DISPOSABLE SYNTHETIC HON OS TRIAL RUNTIME ONLY';
async function send(path,{identity,body,key=K(),method='POST',headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':TRIAL_HUMAN_COMMAND,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;};
const tables=['hon_os_trial_enrollments','organization_entitlements','school_account_requests','saas_access_states','saas_subscriptions','saas_checkout_sessions','saas_credit_allowances','saas_access_exceptions'];
const counts=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await q('SELECT count(*) n FROM hon.'+t))[0].n])));
const entitlements=async()=>hash(JSON.stringify(await q('SELECT to_jsonb(e)::text r FROM hon.organization_entitlements e ORDER BY 1')));
async function denied(work,status,code){const before=[await counts(),await entitlements()];const r=await work();assert.equal(r.status,status,JSON.stringify(r.body));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));assert.deepEqual([await counts(),await entitlements()],before);assert.equal(r.headers['cache-control'],'private, no-store');assert(!JSON.stringify(r.body).match(/external_subject|SQLSTATE|SELECT |hon\./));return r;}
const setPrograms=status=>Promise.all(['hon_os_signup_program','hon_os_trial_program'].map(t=>q('UPDATE hon.'+t+' SET status=$1,recorded_at=clock_timestamp() WHERE program_id=1',[status])));
const setTrialProgram=status=>q('UPDATE hon.hon_os_trial_program SET status=$1,recorded_at=clock_timestamp() WHERE program_id=1',[status]);
let terms;
const person=label=>({externalSubject:'oidc:trial:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function register(label){const p=person(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/New_York',termsVersionId:terms,confirmation:SIGNUP_CONFIRMATION},K()])).rows[0].data;
 return {...p,reg:r};}
const ai=async(org,at='clock_timestamp()',cls='AGENT_INFERENCE')=>(await q(`SELECT hon.ai_spend_allowed($1,${at},$2) r`,[org,cls]))[0].r;
// Agent credits a prepare could still commit now: ceiling minus what is already committed (both as every prepare reads them).
const room=async(org,at='clock_timestamp()')=>{const r=(await q(`SELECT hon.ai_org_ceiling($1,${at}) c,hon.ai_org_committed_credits($1,${at}) u`,[org]))[0];return Number(r.c)-Number(r.u);};
const spend=(who,credits,cost=0)=>q("INSERT INTO hon.ai_usage_ledger(organization_id,school_id,provider_code,model_code,modality,customer_credits,provider_cost_microunits,correlation_id,occurred_at) VALUES($1,$2,'OPENROUTER','trial-fixture','TEXT',$3,$4,$5,clock_timestamp())",[who.reg.organizationId,who.reg.schoolId,credits,cost,K()]);
const gated=async subject=>(await q('SELECT * FROM hon.resolve_follow_up_scope($1)',[subject])).length;

try{
 await Promise.all([admin.connect(),restricted.connect(),blocker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody and exact runtime ACL.
 for(const t of ['hon_os_trial_program','hon_os_trial_enrollments']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const fns=await q("SELECT p.oid,p.proname,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname IN ('hon_os_trial_open','hon_os_trial_live','hon_os_trial_json','hon_os_trial_campaign_offer','start_hon_os_trial','read_hon_os_trial','guard_hon_os_trial_checkout','ai_spend_allowed','ai_trial_funding_available','ai_org_ceiling')");
 assert.equal(fns.length,10);
 for(const f of fns){const entry=['start_hon_os_trial','read_hon_os_trial'].includes(f.proname);
  assert.equal(f.prosecdef,entry||f.proname==='ai_spend_allowed',f.proname);assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry,f.proname);}
 assert.equal((await q('SELECT status FROM hon.hon_os_trial_program'))[0].status,'CLOSED');
 assert.equal((await q('SELECT status FROM hon.saas_trial_program'))[0].status,'INACTIVE');
 await assert.rejects(()=>q("UPDATE hon.hon_os_trial_program SET status='LIVE'"),e=>e.code==='23514');
 await assert.rejects(()=>q('DELETE FROM hon.hon_os_trial_program'),e=>/SIGNUP_PROGRAM_IMMUTABLE/.test(e.message));
 assert.equal((await q('SELECT hon.ai_trial_funding_available($1,clock_timestamp(),$2) f',[K(),'AGENT_INFERENCE']))[0].f,false);
 assert.equal((await q('SELECT hon.ai_org_ceiling($1,clock_timestamp()) c',[K()]))[0].c,12000);
 pass('forced deny-all RLS on two new tables; runtime executes exactly two entry points; trial program seeded CLOSED with no LIVE value; 0187 program stays INACTIVE; no trial: funding hook false and the interim 12000 ceiling unchanged');

 // HQ owner publishes one PUBLIC 14-day campaign (capacity 2) and one PRIVATE_INVITATION campaign under a new approval.
 const hq={id:K(),user:K(),subject:'trial-hq-'+K()};
 await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Trial HQ synthetic')",[hq.user,hq.subject,hq.user+'@example.invalid']);
 await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','Trial HQ synthetic',true)",[hq.id,hq.user]);
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')",[hq.id]);
 const policyVersion=Number((await q('SELECT coalesce(max(version),0) v FROM hon.saas_trial_policy_versions'))[0].v);
 const policy=(await trials.propose(hq.subject,{expectedVersion:policyVersion,terms:trialTerms({termsReference:'HON_OS_TRIAL_SYNTHETIC_TERMS',promotionalLimits:trialPromoLimits({maxPerRequestCreditCap:10})}),reason},K())).policyVersion;
 const revision=Number((await q('SELECT coalesce(max(revision),0) r FROM hon.saas_trial_policy_decisions'))[0].r);
 await trials.decide(hq.subject,trialApproval(policy.policyId,revision),K());
 const campaignOf=async patch=>{const v=(await trials.draft(hq.subject,{campaignId:null,expectedVersion:0,definition:trialDefinition({durationDays:14,termsReference:'HON_OS_TRIAL_SYNTHETIC_TERMS',enrollmentOpensAt:new Date(Date.now()-60_000).toISOString(),...patch}),reason},K())).campaignVersion;
  const preview=await trials.preview(hq.subject,v.versionId);assert.equal(preview.ready,true,JSON.stringify(preview.blockers));
  await trials.publish(hq.subject,preview.campaignId,{versionId:preview.versionId,expectedRevision:preview.expectedRevision,previewDigest:preview.digest,confirmation:'PUBLISH_TRIAL_CAMPAIGN_DEFINITION_ONLY',reason},K());return v.campaignId;};
 // HQ's trial setting: 100 agent credits per school, 20 a day, 10 a request, credits expire after 7 days, campaign cost cap 10 USD.
 const budget=trialPromoBudget({perRequestCreditCap:10});
 const campaign=await campaignOf({name:'Synthetic public 14-day trial',linkMode:'PUBLIC',maximumEnrollments:2,promotionalBudget:budget});
 const privateCampaign=await campaignOf({name:'Synthetic invitation trial',linkMode:'PRIVATE_INVITATION'});

 const module=await Test.createTestingModule({controllers:[HonOsTrialController],providers:[HonOsTrialService,HonOsTrialHumanGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 const excluded=new Set([...tables,'users','principals','organizations','schools','roles','role_permissions','principal_role_grants','hon_os_school_registrations','hon_os_signup_program','hon_os_trial_program',
  'hq_operator_grants','saas_trial_policy_versions','saas_trial_policy_decisions','saas_trial_campaign_versions','saas_trial_publications','saas_requests','saas_audit','saas_outbox']);
 const others=(await q("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).map(r=>r.tablename).filter(t=>!excluded.has(t));
 const snapshot=async()=>{const out={};for(const t of others){assert.match(t,/^[a-z_0-9]+$/);out[t]=hash(JSON.stringify(await q('SELECT to_jsonb(t)::text r FROM hon.'+t+' t ORDER BY 1')));}return out;};
 const baseline=await snapshot(),guarded=await counts();
 await setPrograms('TEST_MODE');
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const ana=await register('ana'),ben=await register('ben'),cai=await register('cai'),dev=await register('dev'),eli=await register('eli');
 const form=(who,extra={})=>({schoolId:who.reg.schoolId,campaignId:campaign,confirmation:TRIAL_CONFIRMATION,...extra});

 // 2. Closed trial program: the read says CLOSED and offers nothing; start refused with zero effects. A registered school reads REGISTERED for AI.
 await setTrialProgram('CLOSED');
 assert.deepEqual(ok(await send('account/trial',{identity:ana,method:'GET'})),{trialStatus:'CLOSED',schoolId:ana.reg.schoolId,available:null,trial:null});
 await denied(()=>send('account/trial',{identity:ana,body:form(ana)}),409,'TRIAL_CLOSED');
 assert.equal(await ai(ana.reg.organizationId),'AI_ACCESS_NOT_PAID');assert.equal(await ai(ana.reg.organizationId,'clock_timestamp()','CREATIVE_MEDIA'),'AI_ACCESS_NOT_PAID');
 await setTrialProgram('TEST_MODE');
 const offered=ok(await send('account/trial',{identity:ana,method:'GET'}));
 assert.deepEqual(offered,{trialStatus:'TEST_MODE',schoolId:ana.reg.schoolId,available:{campaignId:campaign,name:'Synthetic public 14-day trial',durationDays:14,automaticCharge:false,paymentMethodRequired:false,
  aiIncluded:true,aiCredits:{credits:100,dailyCap:20,perRequestCap:10,expiryDays:7}},trial:null});
 pass('CLOSED by default: no offer and no trial; a REGISTERED school with no trial is AI_ACCESS_NOT_PAID; TEST_MODE offers only the public campaign, with no charge, no payment method and its HQ-set AI credit');

 // 3. Refusals with zero effects: identity, school, input, campaign channel, unknown campaign, command and origin.
 await denied(()=>send('account/trial',{body:form(ana)}),401);
 await denied(()=>send('account/trial',{identity:person('stranger'),body:form(ana)}),403,'ACCOUNT_FORBIDDEN');
 await denied(()=>send('account/trial',{identity:ben,body:form(ana)}),403,'ACCOUNT_FORBIDDEN');
 for(const patch of [{organizationId:ana.reg.organizationId},{plan:'COMPLETE'},{durationDays:90},{aiIncluded:true},{confirmation:'YES'},{schoolId:'school'}])await denied(()=>send('account/trial',{identity:ana,body:form(ana,patch)}),400);
 await denied(()=>send('account/trial',{identity:ana,body:form(ana,{campaignId:privateCampaign})}),409,'TRIAL_CAMPAIGN_UNAVAILABLE');
 await denied(()=>send('account/trial',{identity:ana,body:form(ana,{campaignId:K()})}),409,'TRIAL_CAMPAIGN_UNAVAILABLE');
 await denied(()=>send('account/trial',{identity:ana,body:form(ana),headers:{'x-hon-human-command':'hon-os-sign-up'}}),403);
 await denied(()=>send('account/trial',{identity:ana,body:form(ana),headers:{origin:'https://evil.invalid'}}),403);
 await assert.rejects(()=>restricted.query('SELECT hon.start_hon_os_trial($1,$2::jsonb,$3)',['manus:'+K(),form(ana),K()]),e=>e.code==='22023');
 pass('no session, unregistered identity, another owner\'s school, forged body authority, invitation-only or unknown campaign, wrong command or origin and non-OIDC subjects are refused atomically');

 // 4. Happy path: entitlement becomes the campaign profile, ACTIVE until start + 14 days; no charge, no AI.
 const key=K(),before=await counts(),prior=(await q('SELECT * FROM hon.organization_entitlements WHERE organization_id=$1',[ana.reg.organizationId]))[0];
 assert.equal(await gated(ana.externalSubject),0);
 const trial=ok(await send('account/trial',{identity:ana,body:form(ana),key}));
 assert.equal(trial.status,'TRIAL_ACTIVE');assert.equal(trial.durationDays,14);assert.equal(trial.schoolId,ana.reg.schoolId);assert.equal(trial.campaignId,campaign);
 assert.equal(Date.parse(trial.endsAt)-Date.parse(trial.startsAt),14*DAY);
 for(const k of ['automaticCharge','paymentMethodRequired','creativeCreditsIncluded'])assert.equal(trial[k],false,k);
 assert.equal(trial.aiIncluded,true);assert.equal(Date.parse(trial.aiCredits.expiresAt)-Date.parse(trial.startsAt),7*DAY);
 assert.deepEqual({...trial.aiCredits,expiresAt:undefined},{credits:100,dailyCap:20,perRequestCap:10,expiresAt:undefined,used:0});
 const after=await counts();
 for(const t of ['hon_os_trial_enrollments','school_account_requests'])assert.equal(Number(after[t])-Number(before[t]),1,t);
 for(const t of ['organization_entitlements','saas_access_states','saas_subscriptions','saas_checkout_sessions','saas_credit_allowances','saas_access_exceptions'])assert.equal(after[t],before[t],t);
 // The receipt shows milliseconds; the window itself is exact: effective_until = ends_at = starts_at + 14 days.
 const ent=(await q('SELECT e.tier,e.status,e.version,e.effective_until=t.ends_at AND t.ends_at=t.starts_at+interval \'14 days\' AND e.effective_from=t.starts_at until_end,e.effective_from<=clock_timestamp() started FROM hon.organization_entitlements e JOIN hon.hon_os_trial_enrollments t ON t.organization_id=e.organization_id WHERE e.organization_id=$1',[ana.reg.organizationId]))[0];
 assert.deepEqual(ent,{tier:'COMPLETE',status:'ACTIVE',version:prior.version+1,until_end:true,started:true});
 const row=(await q('SELECT * FROM hon.hon_os_trial_enrollments WHERE id=$1',[trial.enrollmentId]))[0];
 assert.equal(row.program_status,'TEST_MODE');assert.equal(row.prior_entitlement.status,'SUSPENDED');assert.equal(row.granted_entitlement_version,prior.version+1);assert.equal(row.terms_reference,'HON_OS_TRIAL_SYNTHETIC_TERMS');assert.deepEqual(row.ai_budget,budget);
 assert(await gated(ana.externalSubject)>0,'the trial school can use entitlement-gated school features');
 assert.notEqual((await q('SELECT hon.school_staff_manager($1,$2) m',[ana.externalSubject,ana.reg.schoolId]))[0].m,null);
 // Agent AI is allowed under the HQ-set credit; Creative Studio media never is (wallet only).
 assert.equal(await ai(ana.reg.organizationId),null);assert.equal(await ai(ana.reg.organizationId,'clock_timestamp()','CREATIVE_MEDIA'),'AI_TRIAL_FUNDING_NOT_APPROVED');
 assert.equal(await ai(ben.reg.organizationId),'AI_ACCESS_NOT_PAID');
 // Credits expire after creditExpiryDays (7) while the trial itself runs 14; access ends by the clock at endsAt.
 const startsAt="(SELECT starts_at FROM hon.hon_os_trial_enrollments WHERE organization_id=$1)",endsAt="(SELECT ends_at FROM hon.hon_os_trial_enrollments WHERE organization_id=$1)";
 assert.equal(await ai(ana.reg.organizationId,startsAt+"+interval '7 days'-interval '1 millisecond'"),null);
 assert.equal(await ai(ana.reg.organizationId,startsAt+"+interval '7 days'"),'AI_TRIAL_FUNDING_NOT_APPROVED');assert.equal(await room(ana.reg.organizationId,startsAt+"+interval '7 days'"),0);
 assert.equal(await ai(ana.reg.organizationId,endsAt),'AI_ACCESS_NOT_PAID');assert.equal(await ai(ana.reg.organizationId,endsAt+"-interval '1 millisecond'"),'AI_TRIAL_FUNDING_NOT_APPROVED');
 assert.deepEqual((await q(`SELECT hon.hon_os_trial_live($1,${endsAt}) a,hon.hon_os_trial_live($1,${endsAt}-interval '1 millisecond') b`,[ana.reg.organizationId]))[0],{a:false,b:true});
 pass('the trial sets the entitlement to COMPLETE ACTIVE until exactly start + 14 days (gated features open, access ends by the clock); no access state, subscription, checkout, allowance or exception; agent AI allowed under the HQ-set credit until it expires on day 7, Creative Studio media never');

 // 5. Replay, key reuse, second trial.
 assert.deepEqual(ok(await send('account/trial',{identity:ana,body:form(ana),key})),trial);
 await denied(()=>send('account/trial',{identity:ana,body:form(ana,{campaignId:privateCampaign}),key}),409,'TRIAL_KEY_REUSED');
 await denied(()=>send('account/trial',{identity:ana,body:form(ana)}),409,'TRIAL_ALREADY_USED');
 const mine=ok(await send('account/trial',{identity:ana,method:'GET'}));assert.equal(mine.available,null);assert.deepEqual(mine.trial,trial);
 assert.deepEqual(ok(await send('account/trial',{identity:person('nobody'),method:'GET'})),{trialStatus:'TEST_MODE',schoolId:null,available:null,trial:null});
 pass('same key returns the same receipt; a changed body under the key and a second trial are refused; the read shows only the caller\'s own trial');

 // 6. Not eligible: a school whose entitlement is no longer SUSPENDED (for example an HQ change) is never touched.
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE',version=version+1,updated_at=clock_timestamp() WHERE organization_id=$1",[eli.reg.organizationId]);
 await denied(()=>send('account/trial',{identity:eli,body:form(eli)}),409,'TRIAL_NOT_ELIGIBLE');
 // Busy envelope.
 await blocker.query('BEGIN');
 try{await blocker.query('LOCK TABLE hon.principal_role_grants IN SHARE ROW EXCLUSIVE MODE');await denied(()=>send('account/trial',{identity:cai,body:form(cai)}),503,'TRIAL_BUSY');}
 finally{await blocker.query('ROLLBACK');}
 // Program closed after the writes, before commit, aborts the whole start.
 await q("CREATE FUNCTION public.trial_close_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE hon.hon_os_trial_program SET status='CLOSED'; RETURN NEW; END $$");
 await q('CREATE TRIGGER trial_close_barrier AFTER INSERT ON hon.hon_os_trial_enrollments FOR EACH ROW EXECUTE FUNCTION public.trial_close_barrier()');
 try{await denied(()=>send('account/trial',{identity:cai,body:form(cai)}),409,'TRIAL_CLOSED');}
 finally{await q('DROP TRIGGER trial_close_barrier ON hon.hon_os_trial_enrollments');await q('DROP FUNCTION public.trial_close_barrier()');}
 assert.equal((await q('SELECT status FROM hon.hon_os_trial_program'))[0].status,'TEST_MODE');
 pass('a school that already has access is not eligible; a held IAM lock is a recoverable busy; closing the program between the writes and commit aborts everything');

 // 7. Concurrency and capacity: five tabs, five keys, one trial; the campaign stops at its maximum.
 const burst=await Promise.all(Array.from({length:5},()=>send('account/trial',{identity:ben,body:form(ben)})));
 assert.equal(burst.filter(r=>r.status===200).length,1,JSON.stringify(burst.map(r=>[r.status,r.body.code])));
 assert(burst.filter(r=>r.status!==200).every(r=>(r.status===409&&r.body.code==='TRIAL_ALREADY_USED')||(r.status===503&&r.body.code==='TRIAL_BUSY')));
 assert.equal((await q('SELECT count(*) n FROM hon.hon_os_trial_enrollments WHERE organization_id=$1',[ben.reg.organizationId]))[0].n,'1');
 assert.equal(ok(await send('account/trial',{identity:cai,method:'GET'})).available,null);
 await denied(()=>send('account/trial',{identity:cai,body:form(cai)}),409,'TRIAL_CAMPAIGN_FULL');
 pass('five concurrent starts by one owner create exactly one trial; a full campaign is no longer offered and refuses a new school');

 // Trial AI credit arithmetic, on the same ceiling and committed total every agent prepare compares against under the
 // organization budget lock. Usage rows are written and rolled back (no AI call; the ledger is left untouched).
 const later=startsAt+"+interval '3 days'";
 await admin.query('BEGIN');
 try{
  assert.equal(await room(ana.reg.organizationId),10,'a fresh trial: one request may commit at most the per-request cap');
  await spend(ana,18);assert.equal(await room(ana.reg.organizationId),2,'18 used today: only 2 left under the daily cap of 20');
  assert.equal(await room(ana.reg.organizationId,later),10,'a later day: the daily cap resets, the per-request cap binds');
  await spend(ana,80);assert.equal(await room(ana.reg.organizationId,later),2,'98 of 100 used: only 2 left of the school credit');
  await spend(ana,2);assert.equal(await room(ana.reg.organizationId,later),0,'all 100 used: nothing more until the trial ends');
  assert.equal((await q('SELECT hon.hon_os_trial_json(t) j FROM hon.hon_os_trial_enrollments t WHERE organization_id=$1',[ana.reg.organizationId]))[0].j.aiCredits.used,100,'the receipt shows what was used');
 }finally{await admin.query('ROLLBACK');}
 await admin.query('BEGIN');
 try{
  await spend(ben,0,1000*10000);assert.equal(await room(ana.reg.organizationId),0,'campaign provider cost reached its cap (another school spent it): no school in the campaign may commit more');
  assert.equal(await room(eli.reg.organizationId),12000-Number((await q('SELECT hon.ai_org_committed_credits($1,clock_timestamp()) u',[eli.reg.organizationId]))[0].u),'a school with no trial keeps the interim ceiling');
 }finally{await admin.query('ROLLBACK');}
 assert.equal(ok(await send('account/trial',{identity:ana,method:'GET'})).trial.aiCredits.used,0);
 pass('trial AI credit: per-request cap 10, daily cap 20 resetting each UTC day, 100 credits per school, and the campaign cost cap across schools all bound the ceiling agent prepares enforce; schools without a trial keep 12000');

 // 8. No checkout for a trial school until the reviewed conversion slice exists.
 await assert.rejects(()=>q("INSERT INTO hon.saas_checkout_sessions(organization_id) VALUES($1)",[ana.reg.organizationId]),e=>e.message==='TRIAL_CONVERSION_UNAVAILABLE');
 // Evidence is append-only; the program has no LIVE value.
 for(const sql of ['UPDATE hon.hon_os_trial_enrollments SET duration_days=90','DELETE FROM hon.hon_os_trial_enrollments'])await assert.rejects(()=>q(sql),e=>/ACCOUNT_EVIDENCE_IMMUTABLE/.test(e.message));
 pass('a trial school cannot open a checkout (TRIAL_CONVERSION_UNAVAILABLE); trial evidence is immutable');

 // 9. Ended and superseded trials, by the clock and by a newer entitlement version (enrollment written by the owner fixture in the past).
 const pub=(await q("SELECT p.id,p.version_id,p.policy_decision_id FROM hon.saas_trial_publications p WHERE p.campaign_id=$1 AND p.kind='PUBLISHED'",[privateCampaign]))[0];
 const enroll=async(who,{daysAgo=15,aiBudget=budget}={})=>{const k=K();await q("INSERT INTO hon.school_account_requests VALUES($1,$2,'synthetic-ended-trial','{}')",[who.externalSubject,k]);
  const e=(await q("WITH n AS (SELECT clock_timestamp()-make_interval(days=>$2) t) UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=n.t,effective_until=n.t+interval '14 days',version=version+1,updated_at=clock_timestamp() FROM n WHERE organization_id=$1 RETURNING version,effective_from::text effective_from",[who.reg.organizationId,daysAgo]))[0];
  await q("INSERT INTO hon.hon_os_trial_enrollments(organization_id,school_id,registration_id,campaign_id,campaign_version_id,publication_id,policy_decision_id,capability_profile,duration_days,terms_reference,starts_at,ends_at,prior_entitlement,granted_entitlement_version,enrolled_by_principal_id,subject,idempotency_key,program_status,ai_budget) VALUES($1,$2,$3,$4,$5,$6,$7,'COMPLETE',14,'HON_OS_TRIAL_SYNTHETIC_TERMS',$8::timestamptz,$8::timestamptz+interval '14 days','{}',$9,$10,$11,$12,'TEST_MODE',$13::jsonb)",
   [who.reg.organizationId,who.reg.schoolId,who.reg.registrationId,privateCampaign,pub.version_id,pub.id,pub.policy_decision_id,e.effective_from,e.version,(await q('SELECT owner_principal_id p FROM hon.hon_os_school_registrations WHERE id=$1',[who.reg.registrationId]))[0].p,who.externalSubject,k,JSON.stringify(aiBudget)]);};
 await enroll(dev);
 const done=ok(await send('account/trial',{identity:dev,method:'GET'}));assert.equal(done.trial.status,'TRIAL_ENDED');assert.equal(done.available,null);
 assert.equal(await gated(dev.externalSubject),0,'an ended trial opens no gated feature');assert.equal(await ai(dev.reg.organizationId),'AI_ACCESS_NOT_PAID');
 await denied(()=>send('account/trial',{identity:dev,body:form(dev)}),409,'TRIAL_ALREADY_USED');
 await q("UPDATE hon.organization_entitlements SET version=version+1,updated_at=clock_timestamp() WHERE organization_id=$1",[dev.reg.organizationId]);
 assert.equal(ok(await send('account/trial',{identity:dev,method:'GET'})).trial.status,'SUPERSEDED');
 // A live trial from a campaign without a budget: no trial AI at all (ceiling 0), receipt says so.
 await enroll(cai,{daysAgo:0,aiBudget:null});
 const plain=ok(await send('account/trial',{identity:cai,method:'GET'})).trial;assert.equal(plain.status,'TRIAL_ACTIVE');assert.equal(plain.aiIncluded,false);assert.equal(plain.aiCredits,null);
 assert.equal(await ai(cai.reg.organizationId),'AI_TRIAL_FUNDING_NOT_APPROVED');assert.equal(await room(cai.reg.organizationId),0);
 pass('after its 14 days a trial reads TRIAL_ENDED, opens no gated feature and no AI, and cannot be restarted; a newer entitlement version reads SUPERSEDED; a trial without an HQ budget has no AI');

 // 0272 review fixes. Open holds come from four agent tables with deep foreign keys, so the arithmetic is proven by
 // replacing hon.ai_org_open_agent_holds with a fixture table inside a rolled-back transaction (DDL is transactional);
 // the real function is checked to read exactly the four tables ai_org_committed_credits reads.
 const body=name=>q("SELECT pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname=$1",[name]).then(r=>r[0].d);
 const holdTables=d=>[...d.matchAll(/hon\.([a-z_]+_invocations)\b/g)].map(m=>m[1]).filter((t,i,a)=>a.indexOf(t)===i).sort();
 assert.deepEqual(holdTables(await body('ai_org_open_agent_holds')),holdTables(await body('ai_org_committed_credits')));
 assert.equal(holdTables(await body('ai_org_open_agent_holds')).length,4);
 assert.deepEqual(await q('SELECT * FROM hon.ai_org_open_agent_holds($1)',[ana.reg.organizationId]),[]);
 for(const reader of ['read_ai_school_usage_from_hq','read_ai_team_readiness'])assert.match(await body(reader),/ai_org_display_ceiling/,reader);
 const display=async(org,at='clock_timestamp()')=>Number((await q(`SELECT hon.ai_org_display_ceiling($1,${at}) c`,[org]))[0].c);
 assert.equal(await display(ana.reg.organizationId),100,'HQ sees the trial credits left, not the per-request minimum');assert.equal(await room(ana.reg.organizationId),10);
 assert.equal(await display(eli.reg.organizationId),12000);assert.equal(await display(ana.reg.organizationId,startsAt+"+interval '7 days'"),0);
 const fay=await register('fay');await enroll(fay,{daysAgo:13,aiBudget:{...budget,creditExpiryDays:14}});
 const fayStart=(await q('SELECT starts_at::text s FROM hon.hon_os_trial_enrollments WHERE organization_id=$1',[fay.reg.organizationId]))[0].s;
 const crossesMonth=(await q("SELECT date_trunc('month',$1::timestamptz AT TIME ZONE 'UTC')<>date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') x",[fayStart]))[0].x;
 await admin.query('BEGIN');
 try{
  await q('CREATE TEMP TABLE fx_holds(org uuid,held_at timestamptz,status text,reserved_credits bigint,max_provider_cost_microunits bigint) ON COMMIT DROP');
  await q(`CREATE OR REPLACE FUNCTION hon.ai_org_open_agent_holds(p_org uuid) RETURNS TABLE(held_at timestamptz,status text,reserved_credits bigint,max_provider_cost_microunits bigint)
    LANGUAGE sql STABLE SET search_path=pg_catalog,hon,pg_temp AS $f$ SELECT held_at,status,reserved_credits,max_provider_cost_microunits FROM pg_temp.fx_holds WHERE org=p_org $f$`);
  const hold=(who,{at='clock_timestamp()',status='SENDING',credits=10,cost=null}={})=>q(`INSERT INTO pg_temp.fx_holds VALUES($1,${at},$2,$3,$4)`,[who.reg.organizationId,status,credits,cost]);
  // 1. A hold in flight counts at its plan's maximum cost toward the campaign cap; with no plan it counts as the whole cap.
  await spend(ben,0,600*10000);assert.equal(await room(ana.reg.organizationId),10,'6 of 10 USD used: still room');
  await hold(ben,{cost:400*10000});assert.equal(await room(ana.reg.organizationId),0,'6 USD used + 4 USD in flight reaches the 10 USD cap');
  assert.equal(await display(ana.reg.organizationId),0);
  await q('DELETE FROM pg_temp.fx_holds');await hold(ben,{status:'UNKNOWN',cost:null});assert.equal(await room(ana.reg.organizationId),0,'a lost outcome without a plan counts as the whole cap');
  await q('DELETE FROM pg_temp.fx_holds');await hold(ben,{at:"clock_timestamp()-interval '30 days'",cost:400*10000});assert.equal(await room(ana.reg.organizationId),10,'a hold from before that school\'s trial does not count');
  await q('DELETE FROM pg_temp.fx_holds');
  // 3. A lost hold from before this month (but inside the trial) still uses trial credits; one from before the trial does not.
  assert.equal(await display(fay.reg.organizationId),100);
  await hold(fay,{at:`'${fayStart}'::timestamptz+interval '1 hour'`,status:'UNKNOWN',credits:30,cost:1});
  await hold(fay,{at:`'${fayStart}'::timestamptz-interval '1 hour'`,status:'UNKNOWN',credits:7,cost:1});
  const lost=(await q("SELECT count(*) n FROM pg_temp.fx_holds f WHERE org=$1 AND NOT hon.ai_hold_counts(f.status,f.held_at,hon.ai_spend_window($1,clock_timestamp()),clock_timestamp())",[fay.reg.organizationId]))[0].n;
  assert.equal(Number(lost),crossesMonth?2:0);
  assert.equal(await display(fay.reg.organizationId),crossesMonth?70:100,'30 credits held and lost last month leave 70 (the hold from before the trial is not trial usage)');
 }finally{await admin.query('ROLLBACK');}
 assert.match(await body('ai_org_open_agent_holds'),/marketing_ai_invocations/,'the fixture replacement rolled back');
 pass('0272: campaign cost cap counts open holds at their plan maximum (no plan = whole cap); HQ usage and readiness show the trial credits left; lost holds from an earlier month inside the trial still use trial credits'+(crossesMonth?'':' (month-crossing case not reachable today; window arithmetic checked)'));

 // 4 (0272). A replay is a read of the owner's own receipt: once their owner grant is revoked it is refused.
 const anaGrant=(await q('SELECT owner_grant_id g FROM hon.hon_os_school_registrations WHERE id=$1',[ana.reg.registrationId]))[0].g;
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[anaGrant]);
 await denied(()=>send('account/trial',{identity:ana,body:form(ana),key}),403,'ACCOUNT_FORBIDDEN');
 pass('0272: replaying a start with the same key after the owner grant was revoked is refused (no receipt returned)');

 assert.deepEqual(await snapshot(),baseline);
 const end=await counts();for(const t of ['saas_access_states','saas_subscriptions','saas_checkout_sessions','saas_credit_allowances','saas_access_exceptions'])assert.equal(end[t],guarded[t],t);
 pass('no billing, access-state, credit, AI, CRM or outbox table changed: entitlement windows, trial evidence and request receipts only');
 console.log(`PASS: HON OS free trial runtime (${groups} groups)`);
}finally{await setPrograms('CLOSED').catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end(),blocker.end()]);}
