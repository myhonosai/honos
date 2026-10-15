import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_marketing_ai_validation'||owner.username!=='hon_marketing_ai_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_marketing_ai_runtime') throw Error('Only new disposable localhost marketing AI validation aliases allowed. No remote dataset.');
const runtimeApplicationName=`marketing-ai-save-${randomUUID()}`;runtime.searchParams.set('application_name',runtimeApplicationName);process.env.HON_RUNTIME_DATABASE_URL=runtime.toString();
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {AiInvocationPlanService}=await import('../../../apps/api/dist/ai/ai-invocation-plan.service.js');
const {ActionEngineService}=await import('../../../apps/api/dist/action/action-engine.service.js');
const {MarketingAssistantService}=await import('../../../apps/api/dist/marketing/marketing-assistant.service.js');
const {CampaignService}=await import('../../../apps/api/dist/marketing/campaign.service.js');
const {OpenRouterRuntime,ProviderRuntimeError}=await import('../../../apps/api/dist/ai/provider-runtime.js');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false});await admin.connect();
const database=new RuntimeDatabaseService();const plans=new AiInvocationPlanService(database),actions=new ActionEngineService(database);
const ids=Object.fromEntries(['org','foreignOrg','school','otherSchool','foreignSchool','user','reviewerUser','actor','reviewer','role','catalog','policy'].map(k=>[k,randomUUID()]));
const subject=`marketing-ai-${randomUUID()}`,reviewSubject=`review-ai-${randomUUID()}`;
const context=(patch={})=>({organizationId:ids.org,schoolId:ids.school,principalId:ids.actor,externalSubject:subject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),...patch});
const reviewContext=()=>context({principalId:ids.reviewer,externalSubject:reviewSubject});
let network=0,generated=0;const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{network++;throw Error('NO EXTERNAL NETWORK PERMITTED');};
const draft={title:'Welcome to beginner classes',content:'Discover martial arts in a friendly setting. Ask [school name] about [class times] and [introductory offer].'};
const fake={readiness:()=> 'READY',generate:async input=>{generated++;assert.equal(input.providerId,'OPENROUTER');assert.equal(input.modelId,'approved/marketing-test');assert.equal(input.outputBudget,1024);return {draft,inputTokens:200,outputTokens:100,providerCostMicrounits:600};}};
const assistant=new MarketingAssistantService(database,plans,actions,fake);
const disabled=new MarketingAssistantService(database,plans,actions,new OpenRouterRuntime(()=>({}),globalThis.fetch));
let groups=0;const checked=()=>groups++;
const securityFailures=[];
const status=n=>e=>e?.getStatus?.()===n;
const command=(sql,args,c=context())=>database.withTenantTransaction(c,async client=>{await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");return client.query(sql,args);});
const rows=async(sql,args=[])=> (await admin.query(sql,args)).rows;
try {
 await admin.query('BEGIN');
 await admin.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$3,$3),($2,$3,$3)',[ids.org,ids.foreignOrg,'Synthetic marketing AI validation']);
 await admin.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1::uuid,$4,$6,$1::text),($2::uuid,$4,$6,$2::text),($3::uuid,$5,$6,$3::text)',[ids.school,ids.otherSchool,ids.foreignSchool,ids.org,ids.foreignOrg,'Synthetic school']);
 await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE','ACTIVE'),($2,'COMPLETE','ACTIVE')",[ids.org,ids.foreignOrg]);
 await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::text||\'@example.test\',\'Owner\'),($3::uuid,$4,$3::text||\'@example.test\',\'Reviewer\')',[ids.user,subject,ids.reviewerUser,reviewSubject]);
 await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Owner'),($3,'HUMAN_USER',$4,'Reviewer')",[ids.actor,ids.user,ids.reviewer,ids.reviewerUser]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','Synthetic owner',true)",[ids.role,ids.org]);
 await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions',[ids.role,ids.org]);
 await admin.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$4,$6,$4),($1,$2,$5,$6,$4),($1,$3,$4,$6,$4)',[ids.org,ids.school,ids.otherSchool,ids.actor,ids.reviewer,ids.role]);
 await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','Synthetic approved provider','HEALTHY',$1) ON CONFLICT(provider_id) DO UPDATE SET state='HEALTHY',version=hon.hq_ai_provider_connections.version+1,credential_secret_ref=excluded.credential_secret_ref",[`hon-secret:${randomUUID()}`]);
 await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/marketing-test','Synthetic approved model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')",[ids.catalog]);
 await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',100000,'2020-01-01')",[ids.policy,ids.org,ids.school]);
 await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)',[ids.policy,ids.catalog]);await admin.query('COMMIT');
 const campaigns=new CampaignService(database);const start=new Date(Date.now()+3600000).toISOString(),end=new Date(Date.now()+86400000*30).toISOString();
 const campaign=(await campaigns.save(context(),null,{expectedVersion:0,code:'AI_TEST',name:'Synthetic beginner campaign',goal:'Introduce beginner classes',offerLabel:'',channel:'REFERRAL',startsAt:start,endsAt:end,plannedBudgetMinor:0,currency:'USD'})).campaign;
 const input={campaignId:campaign.id,request:'Write a friendly beginner classes introduction. Use placeholders for unprovided facts.'};
 const blocked=await disabled.submit(context(),input);assert.equal(blocked.status,'CONFIGURATION_REQUIRED');assert.equal(blocked.draft,null);assert.equal(blocked.inputTokens,null);assert.equal(network,0);assert.equal((await rows('SELECT count(*)::int n FROM hon.ai_usage_ledger WHERE work_item_id=$1',[blocked.workItemId]))[0].n,0);checked();
 const c=context();const pending=await assistant.submit(c,input);assert.equal(pending.status,'AWAITING_APPROVAL');assert.deepEqual(pending.draft,draft);assert.equal(pending.customerCredits,1);assert.equal(pending.providerCostMicrounits,600);assert.equal(generated,1);assert.equal((await assistant.submit(c,input)).id,pending.id);assert.equal(generated,1);
 await assert.rejects(assistant.submit(c,{...input,request:'Swapped brief'}),status(409));await assert.rejects(assistant.saveApproved(context(),pending.id),status(403));checked();
 const proposal=await actions.getForReview(reviewContext(),pending.actionRequestId);assert.equal(proposal.reviewBlock,null);assert.equal(proposal.effectiveAuthorityMode,'CONFIRM');assert.equal(proposal.normalizedPayload.content,draft.content);assert.equal(proposal.normalizedPayload.campaignId,campaign.id);
 const binding={actionRequestId:proposal.id,actionCode:proposal.actionCode,requestedByPrincipalId:proposal.requestedByPrincipalId,payloadHash:proposal.payloadHash,policyVersion:proposal.policyVersion,approvalExpiresAt:proposal.approvalExpiresAt,effectiveAuthorityMode:'CONFIRM'};
 await assert.rejects(actions.decide(context(),{actionRequestId:proposal.id,decision:'APPROVED',binding}),status(409));await assert.rejects(actions.decide(reviewContext(),{actionRequestId:proposal.id,decision:'APPROVED',binding:{...binding,payloadHash:'a'.repeat(64)}}),status(409));checked();
 await actions.decide(reviewContext(),{actionRequestId:proposal.id,decision:'APPROVED',binding});const saved=await assistant.saveApproved(context(),pending.id);assert.equal(saved.status,'SAVED');assert.equal((await assistant.saveApproved(context(),pending.id)).status,'SAVED');
 const content=await assistant.workspace(context(),campaign.id);assert.equal(content.length,1);assert.equal(content[0].content,draft.content);assert.equal((await rows('SELECT status FROM hon.work_items WHERE id=$1',[pending.workItemId]))[0].status,'COMPLETED');assert.equal((await rows('SELECT status FROM hon.action_requests WHERE id=$1',[proposal.id]))[0].status,'SUCCEEDED');assert.equal((await rows('SELECT count(*)::int n FROM hon.ai_usage_ledger WHERE work_item_id=$1',[pending.workItemId]))[0].n,1);checked();
 const rejected=await assistant.submit(context(),input);const rr=await actions.getForReview(reviewContext(),rejected.actionRequestId);const rb={actionRequestId:rr.id,actionCode:rr.actionCode,requestedByPrincipalId:rr.requestedByPrincipalId,payloadHash:rr.payloadHash,policyVersion:rr.policyVersion,approvalExpiresAt:rr.approvalExpiresAt,effectiveAuthorityMode:'CONFIRM'};
 const deniedContext=reviewContext(),denial={actionRequestId:rr.id,decision:'DENIED',binding:rb};const deniedReceipt=await actions.decide(deniedContext,denial);
 assert.equal((await assistant.read(context(),rejected.id)).status,'REJECTED');await assert.rejects(assistant.saveApproved(context(),rejected.id),status(403));assert.equal((await assistant.workspace(context(),campaign.id)).length,1);checked();
 try {assert.deepEqual(await actions.decide(deniedContext,denial),deniedReceipt);}
 catch(e) {securityFailures.push(`DENIED receipt replay failed: ${e.getResponse?.().detail??e.message}`);}
 const denialEffects=()=>rows(`SELECT (SELECT count(*)::int FROM hon.action_approvals WHERE action_request_id=$1) approvals,(SELECT count(*)::int FROM hon.audit_events WHERE action_request_id=$1) audits,(SELECT count(*)::int FROM hon.outbox_events WHERE aggregate_id=$1 OR aggregate_id=$2) events,(SELECT count(*)::int FROM hon.marketing_campaign_content WHERE invocation_id=$2) saves`,[rr.id,rejected.id]);
 const recordedEffects=await denialEffects();
 assert.deepEqual(await actions.decide(deniedContext,denial),deniedReceipt);
 assert.deepEqual(await denialEffects(),recordedEffects,'Receipt replay must not decide, audit, reject or save again.');
 for(const swapped of [{...denial,decision:'APPROVED'},{...denial,reason:'Different command'},{...denial,binding:{...rb,payloadHash:'a'.repeat(64)}}]) await assert.rejects(actions.decide(deniedContext,swapped),status(409));
 for(const patch of [{idempotencyKey:randomUUID()},{principalId:ids.actor,externalSubject:subject},{schoolId:ids.otherSchool},{organizationId:ids.foreignOrg,schoolId:ids.foreignSchool}]) await assert.rejects(actions.decide({...deniedContext,...patch},denial),e=>[403,409].includes(e.getStatus()));
 assert.deepEqual(await denialEffects(),recordedEffects);
 for(const patch of [{schoolId:ids.otherSchool},{organizationId:ids.foreignOrg,schoolId:ids.foreignSchool},{principalId:ids.reviewer,externalSubject:reviewSubject}]) await assert.rejects(assistant.read(context(patch),pending.id),e=>[403,404].includes(e.getStatus()));
 await assert.rejects(assistant.submit(context({source:'AI'}),input),status(403));await assert.rejects(assistant.submit(context({delegatedByPrincipalId:ids.actor}),input),status(403));checked();
 // The save adapter must retain the existing reviewer's complete live human qualification, not merely action.approve.
 const parentProbe=await assistant.submit(context(),input);const pr=await actions.getForReview(reviewContext(),parentProbe.actionRequestId);
 const pb={actionRequestId:pr.id,actionCode:pr.actionCode,requestedByPrincipalId:pr.requestedByPrincipalId,payloadHash:pr.payloadHash,policyVersion:pr.policyVersion,approvalExpiresAt:pr.approvalExpiresAt,effectiveAuthorityMode:'CONFIRM'};
 await actions.decide(reviewContext(),{actionRequestId:pr.id,decision:'APPROVED',binding:pb});
 const parentRole=randomUUID();await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'PARENT','Synthetic parent',true)",[parentRole,ids.org]);
 const parentGrant=(await admin.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5) RETURNING id',[ids.org,ids.school,ids.reviewer,parentRole,ids.actor])).rows[0].id;
 try {
  await assert.rejects(actions.getForReview(reviewContext(),pr.id),status(403));
  try {await assert.rejects(assistant.saveApproved(context(),parentProbe.id),status(403),'A no-longer-qualified parent reviewer must not authorize an internal campaign save.');}
  catch {securityFailures.push('Save accepted an approval after the reviewer became an active PARENT (review UI correctly denies the same reviewer).');}
 } finally {await admin.query('DELETE FROM hon.principal_role_grants WHERE id=$1',[parentGrant]);}
 const denyUnqualified=async()=>{
  await assert.rejects(actions.getForReview(reviewContext(),pr.id),status(403));
  await assert.rejects(assistant.saveApproved(context(),parentProbe.id),status(403));
  assert.equal((await rows('SELECT count(*)::int n FROM hon.marketing_campaign_content WHERE invocation_id=$1',[parentProbe.id]))[0].n,0);
  assert.equal((await rows('SELECT status FROM hon.action_requests WHERE id=$1',[pr.id]))[0].status,'APPROVED');
 };
 // The existing review boundary's PARENT exclusion is not school-scoped.
 const otherParent=(await admin.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5) RETURNING id',[ids.org,ids.otherSchool,ids.reviewer,parentRole,ids.actor])).rows[0].id;
 try {
  await denyUnqualified();
  await admin.query("UPDATE hon.principal_role_grants SET effective_from=clock_timestamp()+interval '1 day' WHERE id=$1",[otherParent]);
  await actions.getForReview(reviewContext(),pr.id); // Future PARENT grants do not exclude.
  await admin.query("UPDATE hon.principal_role_grants SET effective_from=clock_timestamp()-interval '2 days',effective_until=clock_timestamp()-interval '1 day' WHERE id=$1",[otherParent]);
  await actions.getForReview(reviewContext(),pr.id); // Nor expired grants.
  await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL,revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1',[otherParent,ids.actor]);
  await actions.getForReview(reviewContext(),pr.id); // Nor revoked grants.
 } finally {await admin.query('DELETE FROM hon.principal_role_grants WHERE id=$1',[otherParent]);}
 const duplicate=randomUUID();
 await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Duplicate reviewer')",[duplicate,ids.reviewerUser]);
 try {await denyUnqualified();} finally {await admin.query('DELETE FROM hon.principals WHERE id=$1',[duplicate]);}
 const hq=(await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_SUPPORT') RETURNING id",[ids.reviewer])).rows[0].id;
 try {await denyUnqualified();} finally {await admin.query('DELETE FROM hon.hq_operator_grants WHERE id=$1',[hq]);}
 await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1',[ids.reviewer]);
 try {await denyUnqualified();} finally {await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1',[ids.reviewer]);}
 const reviewGrant=(await rows('SELECT id FROM hon.principal_role_grants WHERE principal_id=$1 AND organization_id=$2 AND school_id=$3 AND role_id=$4',[ids.reviewer,ids.org,ids.school,ids.role]))[0].id;
 const inspector=new pg.Client({connectionString:owner.toString(),ssl:false});await inspector.connect();
 const holdSaveDependencyLock=async(sql,args)=>{await admin.query('BEGIN');const blockerPid=(await admin.query('SELECT pg_backend_pid() pid')).rows[0].pid;await admin.query(sql,args);return blockerPid;};
 const waitForSaveLock=async(blockerPid)=>{
  for(let attempt=0;attempt<100;attempt++) {
   const waiting=(await inspector.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND application_name=$2 AND $3::integer=ANY(pg_blocking_pids(pid))) waiting',[runtime.username,runtimeApplicationName,blockerPid])).rows[0].waiting;
   if(waiting)return;
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('Expected actual restricted-role save dependency lock wait.');
 };
 try {
  // Revocation committed while the save waits must replace its pre-wait view.
  let blockerPid=await holdSaveDependencyLock('SELECT id FROM hon.principal_role_grants WHERE id=$1 FOR UPDATE',[reviewGrant]);
  let saving=assistant.saveApproved(context(),parentProbe.id).then(value=>({value}),error=>({error}));
  try {await waitForSaveLock(blockerPid);await admin.query('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp() WHERE id=$1',[reviewGrant]);await admin.query('COMMIT');}
  finally {await admin.query('ROLLBACK');}
  assert.equal((await saving).error?.getStatus?.(),403,'Post-wait revoked reviewer must not authorize save.');
  await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1',[reviewGrant]);
  // Natural grant expiry during a later work-item wait also requires a fresh
  // clock/qualification check before ANY content or state transition.
  const until=(await admin.query("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()+interval '2 seconds' WHERE id=$1 RETURNING effective_until",[reviewGrant])).rows[0].effective_until;
  blockerPid=await holdSaveDependencyLock('SELECT id FROM hon.work_items WHERE id=$1 FOR UPDATE',[parentProbe.workItemId]);
  saving=assistant.saveApproved(context(),parentProbe.id).then(value=>({value}),error=>({error}));
  try {await waitForSaveLock(blockerPid);await new Promise(resolve=>setTimeout(resolve,Math.max(0,until.getTime()-Date.now()+100)));await admin.query('COMMIT');}
  finally {await admin.query('ROLLBACK');}
  assert.equal((await saving).error?.getStatus?.(),403,'Expiry after a work-item lock wait must not authorize save.');
  await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1',[reviewGrant]);
  // Create a normally bound proposal with a short fixture lifetime. Only the
  // proposal-construction clock is injected; live database clocks and immutable
  // binding/evidence guards remain untouched throughout review and execution.
  const propose=actions.proposeInTransaction;
  actions.proposeInTransaction=async(...args)=>{const now=Date.now;try{Date.now=()=>now()-30*60*1000+3000;return await propose.apply(actions,args);}finally{Date.now=now;}};
  let expiring;
  try {expiring=await assistant.submit(context(),input);} finally {actions.proposeInTransaction=propose;}
  const er=await actions.getForReview(reviewContext(),expiring.actionRequestId);
  const eb={actionRequestId:er.id,actionCode:er.actionCode,requestedByPrincipalId:er.requestedByPrincipalId,payloadHash:er.payloadHash,policyVersion:er.policyVersion,approvalExpiresAt:er.approvalExpiresAt,effectiveAuthorityMode:'CONFIRM'};
  await actions.decide(reviewContext(),{actionRequestId:er.id,decision:'APPROVED',binding:eb});
  blockerPid=await holdSaveDependencyLock('SELECT id FROM hon.work_items WHERE id=$1 FOR UPDATE',[expiring.workItemId]);
  saving=assistant.saveApproved(context(),expiring.id).then(value=>({value}),error=>({error}));
  try {await waitForSaveLock(blockerPid);await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(er.approvalExpiresAt)-Date.now()+100)));await admin.query('COMMIT');}
  finally {await admin.query('ROLLBACK');}
  assert.equal((await saving).error?.getStatus?.(),403,'Approval clock must be checked after every dependency wait.');
  assert.equal((await rows('SELECT count(*)::int n FROM hon.marketing_campaign_content WHERE invocation_id=$1',[expiring.id]))[0].n,0);
  assert.equal((await rows('SELECT status FROM hon.action_requests WHERE id=$1',[er.id]))[0].status,'APPROVED');
 } finally {await admin.query('ROLLBACK');await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1',[reviewGrant]);await inspector.end();}
 assert.equal((await rows('SELECT count(*)::int n FROM hon.marketing_campaign_content WHERE invocation_id=$1',[parentProbe.id]))[0].n,0);
 assert.equal((await assistant.saveApproved(context(),parentProbe.id)).status,'SAVED','Restored exact human reviewer remains qualified.');
 checked();
 const unknownService=new MarketingAssistantService(database,plans,actions,{readiness:()=> 'READY',generate:async()=>{throw new ProviderRuntimeError('UNKNOWN','PROVIDER_UNKNOWN');}});const unknown=await unknownService.submit(context(),input);assert.equal(unknown.status,'UNKNOWN');assert.equal(unknown.draft,null);const before=generated;assert.equal((await assistant.generate(context(),unknown.id)).status,'UNKNOWN');assert.equal(generated,before);assert.equal((await rows('SELECT reserved_credits FROM hon.marketing_ai_invocations WHERE id=$1',[unknown.id]))[0].reserved_credits,6);checked();
 const failureService=new MarketingAssistantService(database,plans,actions,{readiness:()=> 'READY',generate:async()=>{throw new ProviderRuntimeError('FAILED','PROVIDER_REJECTED');}});const failed=await failureService.submit(context(),input);assert.equal(failed.status,'FAILED');assert.equal((await rows('SELECT reserved_credits FROM hon.marketing_ai_invocations WHERE id=$1',[failed.id]))[0].reserved_credits,0);checked();
 await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1",[ids.org]);await assert.rejects(assistant.submit(context(),input),status(403));await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1",[ids.org]);
 await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='marketing.assistant.use'",[ids.role]);await assert.rejects(assistant.submit(context(),input),status(403));await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'marketing.assistant.use')",[ids.role,ids.org]);checked();
 await admin.query("INSERT INTO hon.ai_usage_ledger(organization_id,school_id,provider_code,model_code,modality,customer_credits,correlation_id) VALUES($1,$2,'OPENROUTER','synthetic-budget','TEXT',11990,$3)",[ids.org,ids.school,randomUUID()]);const budget=await assistant.submit(context(),input);assert.equal(budget.status,'BLOCKED');assert.equal(budget.draft,null);assert.equal(generated,before);checked();
 const acl=(await command("SELECT has_table_privilege(current_user,'hon.marketing_ai_invocations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') allowed",[])).rows[0];assert.equal(acl.allowed,false);for(const table of ['marketing_ai_invocations','marketing_ai_drafts','marketing_campaign_content']) assert((await rows("SELECT relrowsecurity AND relforcerowsecurity safe FROM pg_class WHERE oid=$1::regclass",[`hon.${table}`]))[0].safe);checked();
 assert.equal(network,0);console.log(`Marketing Assistant integration completed ${groups} groups with genuine restricted-role transactions, DI fake only and zero provider network; ${securityFailures.length} blocking review/save regressions. Synthetic fixtures remain only in the guarded disposable local database.`);
 assert.deepEqual(securityFailures,[],'Blocking Marketing Assistant review/save defects: do not commit or push.');
} finally {globalThis.fetch=originalFetch;await database.onModuleDestroy();await admin.end();}
