import pg from 'pg';
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {trialTerms,trialDefinition,trialApproval,trialPromoLimits,trialPromoBudget} from './trial-governance-fixture.mjs';
import {syntheticExceptionPolicy} from './exception-policy-fixture.mjs';
import {verifySaasBillingSecurity} from './saas-billing-security.mjs';
// D11-A approvals/publications below are SYNTHETIC fixtures only, never seeds or operational decisions.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
assert(owner.hostname==='localhost'&&owner.port==='5432'&&owner.pathname==='/hon_champions_validation'&&owner.username==='hon_champions_owner');
assert(runtime.hostname===owner.hostname&&runtime.port===owner.port&&runtime.pathname===owner.pathname&&runtime.username==='hon_champions_runtime');
assert(!Object.keys(process.env).some(k=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k)));
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasTrialsService}=await import('../../../apps/api/dist/saas-trials/saas-trials.service.js');
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const database=new RuntimeDatabaseService();
const callDatabase=database.callSaasBilling.bind(database);
// Disposable fixture diagnostics only: production continues to redact database errors.
database.callSaasBilling=async(...args)=>{try{return await callDatabase(...args);}catch(error){
 if(!['42501','40001','23514','23505','55P03','P0002','22023'].includes(error.code))console.error('D11-A fixture SQL failure',JSON.stringify({operation:args[0],code:error.code,message:error.message,where:error.where}));
 throw error;
}};
const billing=new SaasBillingService(database),trials=new SaasTrialsService(billing),exceptions=new SaasSchoolBillingService(billing);
const client=url=>new pg.Client({connectionString:url.toString(),ssl:false});
const admin=client(owner),a=client(runtime),b=client(runtime);
const tables=['saas_trial_publications','saas_trial_campaign_versions','saas_trial_policy_decisions','saas_trial_policy_versions'];
const humans=Object.fromEntries(['owner','operator','support','school','expired','ambiguous','ai'].map(k=>[k,{id:K(),user:K(),subject:'d11a-'+K()}]));
const H=k=>humans[k]?.subject??'unknown-d11a-subject',reason='DISPOSABLE SYNTHETIC TRIAL GOVERNANCE ONLY',DAY=86400_000,iso=n=>new Date(n).toISOString();
const org={id:K(),school:K()};let groups=0;
const passed=x=>{groups++;console.log('PASS D11-A '+groups+': '+x);};
const row=async(q,p)=>(await admin.query(q,p)).rows[0];
const footprint=async()=>{const result={};for(const t of [...tables,'saas_requests','saas_audit','saas_outbox','saas_exception_policy_decisions'])result[t]=(await row('SELECT count(*)::int n FROM hon.'+t)).n;return result;};
const deny=(p,status,code)=>assert.rejects(p,e=>{assert.equal(e.getStatus?.(),status,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;});
const sqlDeny=(p,code,message)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);if(message)assert.equal(e.message,message);return true;});
async function nothing(command,status,code){const before=await footprint();await deny(Promise.resolve().then(command),status,code);assert.deepEqual(await footprint(),before,'denial leaves no row, claim, audit or outbox');}
const propose=(terms=trialTerms(),expectedVersion=0,key=K(),who='owner')=>trials.propose(H(who),{expectedVersion,terms,reason},key);
const draft=(definition=trialDefinition(),campaignId=null,expectedVersion=0,key=K(),who='owner')=>trials.draft(H(who),{campaignId,expectedVersion,definition,reason},key);
const decisionRevision=async()=>(await trials.read(H('owner'))).policyDecisions[0]?.revision??0;
const approve=async(policyId,patch={},key=K(),who='owner')=>trials.decide(H(who),trialApproval(policyId,await decisionRevision(),patch),key);
const publicationBody=preview=>({versionId:preview.versionId,expectedRevision:preview.expectedRevision,previewDigest:preview.digest,confirmation:'PUBLISH_TRIAL_CAMPAIGN_DEFINITION_ONLY',reason});
const publish=(preview,key=K(),who='owner')=>trials.publish(H(who),preview.campaignId,publicationBody(preview),key);
const sqlPublish=(c,preview,key=K())=>c.query('SELECT hon.publish_saas_trial_campaign($1,$2,$3,$4,$5,$6) data',[H('owner'),preview.campaignId,publicationBody(preview),key,K(),K()]);
const sqlDecide=(c,body,key=K())=>c.query('SELECT hon.decide_saas_trial_policy($1,$2,$3,$4,$5) data',[H('owner'),body,key,K(),K()]);
const settled=p=>p.then(value=>({value}),error=>({error}));
async function waitsFor(pid){for(const end=Date.now()+5000;Date.now()<end;await sleep(10))if((await row('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) b',[pid])).b)return;throw Error('Expected real PostgreSQL lock wait');}
async function noClaim(key){for(const t of ['saas_requests','saas_audit'])assert.equal((await row('SELECT count(*)::int n FROM hon.'+t+' WHERE actor_principal_id=$1 AND idempotency_key=$2',[humans.owner.id,key])).n,0);assert.equal((await row('SELECT count(*)::int n FROM hon.saas_outbox o JOIN hon.saas_audit a ON a.id=o.audit_id WHERE a.actor_principal_id=$1 AND a.idempotency_key=$2',[humans.owner.id,key])).n,0);}
async function gates(){
 assert.deepEqual(await row('SELECT status,signup_enabled,enrollment_enabled,promotional_issuance_enabled FROM hon.saas_trial_program'),{status:'INACTIVE',signup_enabled:false,enrollment_enabled:false,promotional_issuance_enabled:false});
 assert.deepEqual(await row(`SELECT (SELECT status FROM hon.saas_access_program) access,(SELECT status FROM hon.saas_credit_program) credits,(SELECT status FROM hon.saas_payment_program) payments`),{access:'INACTIVE',credits:'INACTIVE',payments:'DISABLED'});
}
async function cleanup(){
 await admin.query('ROLLBACK');await admin.query('BEGIN');
 try{
  for(const t of tables){await admin.query('ALTER TABLE hon.'+t+' DISABLE TRIGGER USER');await admin.query('DELETE FROM hon.'+t);await admin.query('ALTER TABLE hon.'+t+' ENABLE TRIGGER USER');}
  await admin.query('ALTER TABLE hon.saas_exception_policy_decisions DISABLE TRIGGER USER');await admin.query('DELETE FROM hon.saas_exception_policy_decisions WHERE actor_principal_id=ANY($1::uuid[])',[Object.values(humans).map(x=>x.id)]);await admin.query('ALTER TABLE hon.saas_exception_policy_decisions ENABLE TRIGGER USER');
  for(const t of ['saas_outbox','saas_audit','saas_requests']){
   await admin.query('ALTER TABLE hon.'+t+' DISABLE TRIGGER USER');
   if(t==='saas_outbox')await admin.query('DELETE FROM hon.saas_outbox WHERE audit_id IN (SELECT id FROM hon.saas_audit WHERE actor_principal_id=ANY($1::uuid[]))',[Object.values(humans).map(x=>x.id)]);
   else await admin.query('DELETE FROM hon.'+t+' WHERE actor_principal_id=ANY($1::uuid[])',[Object.values(humans).map(x=>x.id)]);
   await admin.query('ALTER TABLE hon.'+t+' ENABLE TRIGGER USER');
  }
  await admin.query('DELETE FROM hon.organization_entitlements WHERE organization_id=$1',[org.id]);await admin.query('DELETE FROM hon.schools WHERE organization_id=$1',[org.id]);await admin.query('DELETE FROM hon.organizations WHERE id=$1',[org.id]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
await Promise.all([admin,a,b].map(c=>c.connect()));
try{
 assert.equal((await row("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).marker,'HON disposable Champions Club validation');
 for(const t of tables)assert.equal((await row('SELECT count(*)::int n FROM hon.'+t)).n,0,'no seeded governance record');
 await gates();await verifySaasBillingSecurity(admin,'hon_champions_runtime');passed('shipped trial program is pinned inactive, empty governance records, complete security registry');
 await admin.query('BEGIN');
 for(const[k,h]of Object.entries(humans)){
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'D11-A synthetic')",[h.user,h.subject,h.user+'@example.test']);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,$3,'D11-A synthetic',true)",[h.id,k==='ai'?null:h.user,k==='ai'?'AI_EMPLOYEE':'HUMAN_USER']);
 }
 for(const[k,role,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.billing.manage']],['support','HON_HQ_SUPPORT',[]],['expired','HON_HQ_OWNER',[]],['ambiguous','HON_HQ_OWNER',[]],['ai','HON_HQ_OWNER',[]]])await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '2 days',CASE WHEN $4 THEN clock_timestamp()-interval '1 day' ELSE NULL END)",[humans[k].id,role,perms,k==='expired']);
 await admin.query("INSERT INTO hon.principals(user_id,principal_type,display_name,is_active) VALUES($1,'HUMAN_USER','Ambiguous fixture',true)",[humans.ambiguous.user]);
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'D11-A synthetic','D11-A synthetic')",[org.id]);
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'D11-A synthetic',$3,'UTC')",[org.school,org.id,'d11a-'+org.school]);
 await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE','SUSPENDED')",[org.id]);await admin.query('COMMIT');
 // Snapshot every existing domain table. Exclude only governed metadata, request/audit evidence and the fixture IAM rows.
 const excluded=[...tables,'saas_requests','saas_audit','saas_outbox','saas_exception_policy_decisions','users','principals','hq_operator_grants'];
 const oldTables=(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='hon' AND NOT(tablename=ANY($1::text[])) ORDER BY tablename",[excluded])).rows.map(r=>r.tablename);
 async function domainSnapshot(){const result={};for(const t of oldTables){assert(/^[a-z_][a-z0-9_]*$/.test(t));const values=(await admin.query('SELECT to_jsonb(t)::text data FROM hon.'+t+' t ORDER BY 1')).rows;result[t]=createHash('sha256').update(JSON.stringify(values)).digest('hex');}return result;}
 const domainBefore=await domainSnapshot();
 assert.equal((await trials.read(H('operator'))).program.enrollmentEnabled,false);
 for(const who of ['operator','support','school','expired','ambiguous','ai','missing']){
  await nothing(()=>propose(trialTerms(),0,K(),who),403,'SAAS_FORBIDDEN');await nothing(()=>draft(trialDefinition(),null,0,K(),who),403,'SAAS_FORBIDDEN');
  await nothing(()=>trials.decide(H(who),trialApproval(K(),0),K()),403,'SAAS_FORBIDDEN');
  if(who!=='operator')await nothing(()=>trials.read(H(who)),403,'SAAS_FORBIDDEN');
 }
 passed('only a live unambiguous HQ owner writes; billing operator reads; support/school/expired/AI contexts denied with zero claims');
 const initial=(await draft(trialDefinition({capabilityProfile:'CORE'}))).campaignVersion;
 let preview=await trials.preview(H('owner'),initial.versionId);assert(preview.blockers.includes('TRIAL_POLICY_REQUIRED'));await nothing(()=>publish(preview),422,'SAAS_TRIAL_PUBLICATION_BLOCKED');
 await syntheticExceptionPolicy(admin,exceptions,H('owner'));preview=await trials.preview(H('owner'),initial.versionId);await nothing(()=>publish(preview),422,'SAAS_TRIAL_PUBLICATION_BLOCKED');
 await exceptions.decideExceptionPolicy(H('owner'),{expectedRevision:1,decision:'WITHDRAWN',reason},K());passed('missing trial approval refuses publication even with a valid D10 exception-only approval');
 const limits=trialTerms({allowedCapabilityProfiles:['CORE'],allowedEligibilityCodes:['NEW_ORGANIZATIONS_ONLY'],allowedLinkModes:['PRIVATE_INVITATION']});
 const pKey=K(),pInput={expectedVersion:0,terms:limits,reason};const p=(await trials.propose(H('owner'),pInput,pKey)).policyVersion;
 assert.equal(p.status,'PROPOSED');assert.equal((await trials.propose(H('owner'),pInput,pKey)).replayed,true);await nothing(()=>trials.propose(H('owner'),{...pInput,reason:reason+' changed'},pKey),409,'IDEMPOTENCY_KEY_REUSED');
 await nothing(()=>propose(limits),409,'SAAS_VERSION_CONFLICT');preview=await trials.preview(H('owner'),initial.versionId);await nothing(()=>publish(preview),422,'SAAS_TRIAL_PUBLICATION_BLOCKED');passed('immutable proposed policy and exact idempotent receipt never imply approval');
 const approvalBody=trialApproval(p.policyId,0),decisionKeys=[K(),K()];
 const concurrentDecisions=await Promise.all(decisionKeys.map(k=>settled(trials.decide(H('owner'),approvalBody,k))));
 assert.equal(concurrentDecisions.filter(x=>x.value).length,1);assert.equal(concurrentDecisions.find(x=>x.error).error.getStatus(),409);
 const aKey=decisionKeys[concurrentDecisions.findIndex(x=>x.value)];await noClaim(decisionKeys[concurrentDecisions.findIndex(x=>x.error)]);
 assert.equal((await trials.decide(H('owner'),approvalBody,aKey)).replayed,true);
 await nothing(()=>trials.decide(H('owner'),approvalBody,K()),409,'SAAS_VERSION_CONFLICT');
 await nothing(()=>trials.decide(H('owner'),{...approvalBody,confirmation:'APPROVE_ACCESS_EXCEPTION_POLICY_ONLY'},K()),400,'INVALID_SAAS_INPUT');passed('explicit trial-only approval, revision checks, duplicate decision replay and wrong confirmation refusal');
 const xInput={schoolId:org.school,purpose:'INTERNAL_TESTING',reason,scopeTier:'COMPLETE',startsAt:iso(Date.now()),expiresAt:iso(Date.now()+DAY),expectedEntitlementVersion:1};
 await nothing(()=>exceptions.grantAccessException(H('owner'),org.id,xInput,K()),422,'SAAS_EXCEPTION_POLICY_REQUIRED');passed('trial approval cannot authorize a D9/D10 exception grant');
 const beforeRead=await footprint();for(const who of ['owner','operator']){const v=await trials.read(H(who));assert.equal(v.program.signupEnabled,false);const c=await trials.campaign(H(who),initial.campaignId);assert.equal(c.activationAvailable,false);preview=await trials.preview(H(who),initial.versionId);assert.equal(preview.ready,true);assert.equal(preview.activationAvailable,false);assert.equal(preview.promotionalCreditsAvailable,false);}assert.deepEqual(await footprint(),beforeRead);passed('authorized governance reads and server previews write nothing and never report activation');
 const invalidDefinitions=[
  [{durationDays:30},'DURATION_NOT_ALLOWED'],[{capabilityProfile:'COMPLETE'},'CAPABILITY_PROFILE_NOT_ALLOWED'],[{eligibility:'HQ_REVIEW_REQUIRED'},'ELIGIBILITY_NOT_ALLOWED'],[{linkMode:'PUBLIC'},'LINK_MODE_NOT_ALLOWED'],
  [{maximumEnrollments:101},'CAPACITY_EXCEEDS_POLICY'],[{enrollmentClosesAt:iso(Date.now()+31*DAY)},'ENROLLMENT_WINDOW_EXCEEDS_POLICY'],[{termsReference:'DIFFERENT_TERMS'},'TERMS_REFERENCE_MISMATCH'],[{promotionalBudget:trialPromoBudget()},'PROMOTIONAL_METADATA_NOT_ALLOWED']
 ];
 for(const [patch,code]of invalidDefinitions){const v=(await draft(trialDefinition({capabilityProfile:'CORE',...patch}))).campaignVersion;const pr=await trials.preview(H('owner'),v.versionId);assert(pr.blockers.includes(code),JSON.stringify(pr));await nothing(()=>publish(pr),422,'SAAS_TRIAL_PUBLICATION_BLOCKED');}
 passed('approved bounds independently enforce duration, profile, eligibility, channel, capacity, window, terms and optional promotional metadata');
 preview=await trials.preview(H('owner'),initial.versionId);const kWinner=K(),kLoser=K();await a.query('BEGIN');await sqlPublish(a,preview,kWinner);
 let pid=(await a.query('SELECT pg_backend_pid() p')).rows[0].p;let waiting=settled(publish(preview,kLoser));await waitsFor(pid);await a.query('COMMIT');let result=await waiting;assert.equal(result.error?.getStatus(),409);await noClaim(kLoser);
 assert.equal((await publish(preview,kWinner)).replayed,true);await nothing(()=>publish(preview,K(),'operator'),403,'SAAS_FORBIDDEN');
 assert.equal((await row('SELECT count(*)::int n FROM hon.saas_trial_publications WHERE campaign_id=$1',[initial.campaignId])).n,1);passed('concurrent publication has exactly one winner; loser has no evidence/claim; same-key retry is historical receipt');
 const v2=(await draft({...initial.definition,name:'New immutable version',maximumEnrollments:70},initial.campaignId,1)).campaignVersion;
 const old=(await trials.campaign(H('owner'),initial.campaignId)).versions.find(x=>x.versionId===initial.versionId);assert.deepEqual(old,initial);
 const stale=await trials.preview(H('owner'),initial.versionId);assert(stale.blockers.includes('CAMPAIGN_VERSION_STALE'));await publish(await trials.preview(H('owner'),v2.versionId));passed('revisions append without changing published terms; stale/previously published versions cannot republish');
 const vB=(await draft(trialDefinition({capabilityProfile:'CORE',maximumEnrollments:80}))).campaignVersion,vC=(await draft(trialDefinition({capabilityProfile:'CORE',maximumEnrollments:80}))).campaignVersion;
 const prB=await trials.preview(H('owner'),vB.versionId),prC=await trials.preview(H('owner'),vC.versionId);assert(prB.ready&&prC.ready);
 const capacity=await Promise.all([settled(publish(prB)),settled(publish(prC))]);assert.equal(capacity.filter(x=>x.value).length,1);assert.equal(capacity.find(x=>x.error).error.getStatus(),409);passed('aggregate capacity and preview digest include other campaigns; concurrent distinct campaigns cannot exceed policy');
 await approve(p.policyId);const vD=(await draft(trialDefinition({capabilityProfile:'CORE'}))).campaignVersion,prD=await trials.preview(H('owner'),vD.versionId);
 const withdrawal={decision:'WITHDRAWN',expectedRevision:await decisionRevision(),reason};await a.query('BEGIN');await sqlDecide(a,withdrawal);pid=(await a.query('SELECT pg_backend_pid() p')).rows[0].p;
 const kD=K();waiting=settled(publish(prD,kD));await waitsFor(pid);await a.query('COMMIT');result=await waiting;assert.equal(result.error?.getResponse().code,'SAAS_TRIAL_PREVIEW_STALE');await noClaim(kD);passed('withdrawal-first real lock race invalidates publication with zero loser effects');
 await approve(p.policyId);const vE=(await draft(trialDefinition({capabilityProfile:'CORE'}))).campaignVersion,prE=await trials.preview(H('owner'),vE.versionId);
 await a.query('BEGIN');await sqlPublish(a,prE);pid=(await a.query('SELECT pg_backend_pid() p')).rows[0].p;
 waiting=settled(trials.decide(H('owner'),{decision:'WITHDRAWN',expectedRevision:await decisionRevision(),reason},K()));await waitsFor(pid);await a.query('COMMIT');assert((await waiting).value);assert.equal((await trials.preview(H('owner'),vE.versionId)).ready,false);await gates();passed('publication-first lock race commits metadata once; later withdrawal never activates it');
 const pubE=(await trials.campaign(H('owner'),vE.campaignId)).publications[0];await trials.withdraw(H('owner'),vE.campaignId,{expectedRevision:pubE.revision,reason},K());passed('explicit campaign withdrawal remains available when policy is withdrawn');
 for(const patch of [{validFrom:iso(Date.now()+DAY),validUntil:iso(Date.now()+40*DAY)},{validUntil:iso(Date.now()+1200)}]){
  await approve(p.policyId,patch);if(patch.validUntil&&Date.parse(patch.validUntil)<Date.now()+5000)await sleep(1400);
  const v=(await draft(trialDefinition({capabilityProfile:'CORE'}))).campaignVersion,pr=await trials.preview(H('owner'),v.versionId);assert(pr.blockers.includes('TRIAL_POLICY_REQUIRED'));await nothing(()=>publish(pr),422,'SAAS_TRIAL_PUBLICATION_BLOCKED');
 }
 await approve(p.policyId);await trials.decide(H('owner'),{decision:'REVOKED',expectedRevision:await decisionRevision(),reason},K());preview=await trials.preview(H('owner'),vD.versionId);assert(preview.blockers.includes('TRIAL_POLICY_REQUIRED'));await nothing(()=>publish(preview),422,'SAAS_TRIAL_PUBLICATION_BLOCKED');passed('scheduled, expired and revoked approvals never authorize publication');
 const revokedKey=K();await admin.query('UPDATE hon.hq_operator_grants SET effective_until=NULL WHERE principal_id=$1',[humans.expired.id]);let beforeDenied=await footprint();
 await admin.query('BEGIN');await admin.query('UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1',[humans.expired.id]);pid=(await row('SELECT pg_backend_pid() p')).p;
 waiting=settled(propose(trialTerms(),1,revokedKey,'expired'));await waitsFor(pid);await admin.query('COMMIT');result=await waiting;assert.equal(result.error?.getStatus(),403);assert.deepEqual(await footprint(),beforeDenied);passed('authority revocation during an actual IAM lock wait rolls back completely');
 await admin.query("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp()+interval '1800 milliseconds' WHERE principal_id=$1",[humans.expired.id]);beforeDenied=await footprint();
 await admin.query('BEGIN');await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('saas.customer_trials.governance',0))");pid=(await row('SELECT pg_backend_pid() p')).p;
 waiting=settled(propose(trialTerms(),1,K(),'expired'));await waitsFor(pid);await sleep(2000);await admin.query('COMMIT');result=await waiting;assert.equal(result.error?.getStatus(),403);assert.deepEqual(await footprint(),beforeDenied);passed('owner clock expiry during a governance lock wait also commits nothing');
 const shortUntil=Date.now()+2300;await approve(p.policyId,{validUntil:iso(shortUntil)});
 const short=(await draft(trialDefinition({capabilityProfile:'CORE',enrollmentOpensAt:iso(Date.now()-100),enrollmentClosesAt:iso(shortUntil-100)}))).campaignVersion;
 const shortPreview=await trials.preview(H('owner'),short.versionId);assert(shortPreview.ready);const beforeCommit=await footprint();await a.query('BEGIN');await sqlPublish(a,shortPreview);await sleep(2500);await sqlDeny(a.query('COMMIT'),'23514');assert.deepEqual(await footprint(),beforeCommit);passed('policy/window expiry before COMMIT refuses publication and rolls back audit/outbox/idempotency');
 for(const isolation of ['REPEATABLE READ','SERIALIZABLE']){await a.query('BEGIN ISOLATION LEVEL '+isolation);await sqlDeny(a.query('SELECT hon.propose_saas_trial_policy($1,$2,$3,$4,$5)',[H('owner'),{expectedVersion:1,terms:trialTerms(),reason},K(),K(),K()]),'22023');await a.query('ROLLBACK');}passed('snapshot isolation cannot conceal a newer approval after waiting');
 const p2=(await propose(trialTerms({maxTotalEnrollmentCapacity:300,promotionalLimits:trialPromoLimits({maxTotalCampaignCostMinor:1500})}),1)).policyVersion;await approve(p2.policyId);
 preview=await trials.preview(H('owner'),vD.versionId);assert(preview.ready);await nothing(()=>publish({...preview,digest:'0'.repeat(64)}),409,'SAAS_TRIAL_PREVIEW_STALE');
 const promo=(await draft(trialDefinition({promotionalBudget:trialPromoBudget()}))).campaignVersion;await publish(await trials.preview(H('owner'),promo.versionId));
 for(const patch of [{creditsPerEnrollment:101},{creditExpiryDays:8},{dailyCreditCap:21},{perRequestCreditCap:6},{maximumCampaignCostMinor:1001}]){
  const v=(await draft(trialDefinition({durationDays:14,promotionalBudget:trialPromoBudget(patch)}))).campaignVersion,pr=await trials.preview(H('owner'),v.versionId);assert(pr.blockers.includes('PROMOTIONAL_METADATA_EXCEEDS_POLICY'));await nothing(()=>publish(pr),422,'SAAS_TRIAL_PUBLICATION_BLOCKED');
 }
 const promo2=(await draft(trialDefinition({promotionalBudget:trialPromoBudget()}))).campaignVersion,prPromo=await trials.preview(H('owner'),promo2.versionId);assert(prPromo.blockers.includes('AGGREGATE_PROMOTIONAL_METADATA_EXCEEDS_POLICY'));await nothing(()=>publish(prPromo),422,'SAAS_TRIAL_PUBLICATION_BLOCKED');await gates();passed('optional promotional metadata is bounded per campaign and in aggregate; never issues credit or activates a program');
 const published=(await trials.campaign(H('owner'),promo.campaignId)).publications[0];await approve(p2.policyId);assert.equal((await trials.campaign(H('owner'),promo.campaignId)).publications[0].publicationId,published.publicationId);assert((await trials.preview(H('owner'),promo.versionId)).blockers.includes('CAMPAIGN_ALREADY_PUBLISHED'));passed('a new approval never republishes an old campaign or mutates its historical decision binding');
 for(const t of ['saas_trial_program',...tables]){await sqlDeny(b.query('SELECT * FROM hon.'+t),'42501');await sqlDeny(b.query('DELETE FROM hon.'+t),'42501');await sqlDeny(admin.query('UPDATE hon.'+t+' SET '+(t==='saas_trial_program'?"status='ACTIVE'":'id=id')),'42501');}
 await sqlDeny(b.query("SELECT hon.saas_trial_begin($1,$2,$3,'{}',$4,$5)",[H('owner'),K(),'saas.trials.policy_decide',K(),K()]),'42501');
 await sqlDeny(admin.query('TRUNCATE hon.saas_trial_policy_versions CASCADE'),'42501');
 await sqlDeny(admin.query('INSERT INTO hon.saas_trial_policy_versions(version,terms,reason,actor_principal_id,idempotency_key,recorded_at) VALUES(3,$1,$2,$3,$4,clock_timestamp())',[trialTerms(),reason,humans.owner.id,K()]),'23514');
 await sqlDeny(b.query('SELECT hon.propose_saas_trial_policy($1,$2,$3,$4,$5)',[H('owner'),{expectedVersion:2,terms:{...trialTerms(),approve:true},reason},K(),K(),K()]),'22023');passed('forced RLS/private ACLs, immutable history, inert gate and alternate-path evidence protections hold in PostgreSQL');
 await verifySaasBillingSecurity(admin,'hon_champions_runtime');assert.deepEqual(await domainSnapshot(),domainBefore);await gates();passed('every pre-existing domain table unchanged; D9/D10, entitlements, paid access, payment, AI and parent records unaffected');
 console.log(`PASS: D11-A ${groups} scenario groups; actual API-service/restricted PostgreSQL commands and real lock races; synthetic governance only; no activation/provider calls.`);
}finally{
 await Promise.all([a.query('ROLLBACK'),b.query('ROLLBACK')]);try{await cleanup();await gates();for(const t of tables)assert.equal((await row('SELECT count(*)::int n FROM hon.'+t)).n,0);}finally{await Promise.allSettled([admin.end(),a.end(),b.end()]);}
}
