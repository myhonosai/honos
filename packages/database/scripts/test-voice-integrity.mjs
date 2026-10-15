import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { RuntimeDatabaseService } from '../../../apps/api/dist/foundation/runtime-database.service.js';
import { VoiceService } from '../../../apps/api/dist/voice/voice.service.js';
import { verifyVoiceSecurity,voiceTables } from './voice-security.mjs';
for(const [key,role] of [['DATABASE_URL','hon_voice_owner'],['HON_RUNTIME_DATABASE_URL','hon_voice_runtime']]) {
 const u=new URL(process.env[key]??'');if(u.hostname!=='localhost'||u.port!=='5432'||u.pathname!=='/hon_voice_validation'||u.username!==role)throw new Error('Only exact disposable localhost voice database/roles allowed. Never remote URLs.');
}
const admin=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false}),runtime=new pg.Client({connectionString:process.env.HON_RUNTIME_DATABASE_URL,ssl:false}),database=new RuntimeDatabaseService(),voice=new VoiceService(database);
const org=randomUUID(),otherOrg=randomUUID(),school=randomUUID(),sibling=randomUUID(),otherSchool=randomUUID();
const humans=Object.fromEntries(['owner','peer','other','parent','hq','inactive','future','expired','orgOnly','wrongRoleSchool','noPermission','noReferences'].map(w=>[w,{id:randomUUID(),user:randomUUID(),role:randomUUID(),grant:randomUUID(),subject:`voice-${w}-${randomUUID()}`,org:w==='other'?otherOrg:org,school:w==='other'?otherSchool:school}]));
const c=(who='owner',patch={})=>({organizationId:humans[who].org,schoolId:humans[who].school,principalId:humans[who].id,externalSubject:humans[who].subject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),...patch});
const create=(ctx=c(),input={agentCatalogId:'alex'})=>voice.mutate(ctx,'create',null,input);
const mutate=(s,operation,input,ctx=c())=>voice.mutate(ctx,operation,s.id,{expectedVersion:s.version,...input});
const deny=(work,status=403)=>assert.rejects(work,e=>{assert.equal(e.getStatus?.(),status,e.stack);return true;});
const sqlDeny=(work,code='42501')=>assert.rejects(work,e=>{assert.equal(e.code,code,e.stack);return true;});
async function snapshot(tables){const result={};for(const t of tables)result[t]=(await admin.query(`SELECT to_jsonb(t) r FROM hon.${t} t ORDER BY to_jsonb(t)::text`)).rows;return result;}
async function direct(ctx,work){await runtime.query('BEGIN');try{for(const[k,v]of Object.entries({organization_id:ctx.organizationId,school_id:ctx.schoolId,principal_id:ctx.principalId,principal_type:ctx.principalType,source:ctx.source,action_request_id:ctx.actionRequestId??'',delegated_by_principal_id:ctx.delegatedByPrincipalId??''}))await runtime.query('SELECT set_config($1,$2,true)',[`app.hon_${k}`,v]);const value=await work();await runtime.query('COMMIT');return value;}catch(e){await runtime.query('ROLLBACK');throw e;}}
async function historical(s,seconds){const id=randomUUID();await admin.query(`WITH t AS MATERIALIZED (SELECT clock_timestamp() at_time) INSERT INTO hon.voice_sessions(id,organization_id,school_id,actor_principal_id,agent_catalog_id,created_at,updated_at,expires_at)
 SELECT $1,$2,$3,$4,'alex',at_time-interval '30 minutes'+$5::interval,at_time,at_time+$5::interval FROM t`,[id,org,school,humans.owner.id,`${seconds} seconds`]);return {...s,id,version:1};}
const canonical=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_voice_runtime');
const sql=(input)=>execFileSync('sudo',['-u','postgres','psql','-d','hon_voice_validation','-v','ON_ERROR_STOP=1'],{input,stdio:['pipe','pipe','pipe']});
await Promise.all([admin.connect(),runtime.connect()]);
try {
 assert.equal(Number((await admin.query('SELECT count(*) n FROM hon.voice_sessions')).rows[0].n),0,'Fresh disposable database required');
 await verifyVoiceSecurity(admin,'hon_voice_runtime');sql(canonical);
 await admin.query('BEGIN');
 for(const o of [org,otherOrg]){await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_ORG','PRIVATE_ORG')",[o]);await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')",[o]);}
 for(const [s,o]of [[school,org],[sibling,org],[otherSchool,otherOrg]])await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'PRIVATE_SCHOOL',$3,'UTC')",[s,o,s]);
 for(const [who,h]of Object.entries(humans)) {
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@private.example.test`]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',$3)",[h.id,h.user,who!=='inactive']);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role,management_school_id) VALUES($1,$2,$3,'PRIVATE_ROLE',false,$4)",[h.role,h.org,who==='parent'?'PARENT':`VOICE_${who.toUpperCase()}`,who==='wrongRoleSchool'?sibling:null]);
  for(const perm of [...(who==='noPermission'?[]:['ai.voice.interact']),...(who==='noReferences'?[]:['work_item.read','action.approve'])])await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[h.role,h.org,perm]);
  if(who!=='orgOnly')await admin.query("INSERT INTO hon.principal_role_grants(id,principal_id,organization_id,school_id,role_id,granted_by_principal_id,effective_from,effective_until) VALUES($1,$2,$3,$4,$5,$2,clock_timestamp()+$6::interval,CASE WHEN $7 THEN clock_timestamp()-interval '1 hour' ELSE NULL END)",[h.grant,h.id,h.org,h.school,h.role,who==='future'?'1 day':'-2 days',who==='expired']);
 }
 await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')",[humans.hq.id]);
 await admin.query('COMMIT');
 const work=randomUUID(),action=randomUUID(),approval=randomUUID(),foreignWork=randomUUID(),foreignAction=randomUUID(),otherApproval=randomUUID();
 for(const [id,o,s] of [[work,org,school],[foreignWork,otherOrg,otherSchool]])await admin.query("INSERT INTO hon.work_items(id,organization_id,school_id,work_type,status,payload,result,correlation_id) VALUES($1,$2,$3,'PRIVATE_WORK','WAITING_FOR_APPROVAL','{\"raw\":\"PRIVATE_WORK_PAYLOAD\"}','{\"credential\":\"PRIVATE_RESULT\"}',$4)",[id,o,s,randomUUID()]);
 for(const [id,o,s,p] of [[action,org,school,humans.owner.id],[foreignAction,otherOrg,otherSchool,humans.other.id]])await admin.query("INSERT INTO hon.action_requests(id,organization_id,school_id,requested_by_principal_id,action_code,normalized_payload,payload_hash,required_permission,effective_authority_mode,policy_version,status,approval_expires_at,provider_idempotency_reference,correlation_id,idempotency_key) VALUES($1,$2,$3,$4,'crm.lead.create','{\"secret\":\"PRIVATE_ACTION_PAYLOAD\"}',$5,'crm.lead.create','CONFIRM',1,'APPROVED',clock_timestamp()+interval '30 minutes','PRIVATE_PROVIDER_REFERENCE',$6,$7)",[id,o,s,p,'a'.repeat(64),randomUUID(),randomUUID()]);
 for(const [id,a,o,s,p]of [[approval,action,org,school,humans.peer.id],[otherApproval,foreignAction,otherOrg,otherSchool,humans.other.id]])await admin.query("INSERT INTO hon.action_approvals(id,organization_id,school_id,action_request_id,reviewer_principal_id,decision,reviewed_payload_hash,reviewed_policy_version,reason) VALUES($1,$2,$3,$4,$5,'APPROVED',$6,1,'PRIVATE_APPROVAL_REASON')",[id,o,s,a,p,'a'.repeat(64)]);
 const prohibited=['people','crm_leads','crm_appointments','memberships','membership_payment_schedules','invoices','payment_attempts','communication_consents','communication_messages','marketing_campaigns','ai_usage_ledger','ai_invocation_plans','work_items','action_requests','action_approvals','action_policies','ai_team_presentation_preferences','hq_ai_provider_connections','hq_ai_model_catalog','hq_ai_routing_policies','hq_ai_routing_candidates','outbox_delivery_attempts'];
 const effects=await snapshot(prohibited);
 for(const who of ['parent','hq','inactive','future','expired','orgOnly','wrongRoleSchool','noPermission'])await deny(()=>create(c(who)));
 for(const patch of [{source:'AI'},{source:'AUTOMATION'},{source:'INTEGRATION'},{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{delegatedByPrincipalId:randomUUID()},{actionRequestId:randomUUID()},{schoolId:sibling},{organizationId:otherOrg,schoolId:otherSchool},{principalId:humans.other.id},{externalSubject:humans.other.subject}])await deny(()=>create(c('owner',patch)));
 for(const tier of ['ESSENTIAL','CORE']){await admin.query('UPDATE hon.organization_entitlements SET tier=$2::hon.plan_tier WHERE organization_id=$1',[org,tier]);await deny(()=>create());}await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1",[org]);
 for(const input of [{agentCatalogId:'eian'},{agentCatalogId:'unknown'},{agentCatalogId:'alex',provider:'OPENROUTER'},{agentCatalogId:'alex',modelId:randomUUID()},{agentCatalogId:'alex',voiceProfile:'CLEAR'},{agentCatalogId:'alex',transcript:'raw'},{agentCatalogId:'alex',payload:{}},{agentCatalogId:'alex',approvalId:approval},{agentCatalogId:'alex',workItemId:null}])await deny(()=>create(c(),input),400);
 const refs={agentCatalogId:'alex',workItemId:work,actionRequestId:action,approvalId:approval};
 for(const patch of [{workItemId:foreignWork},{actionRequestId:foreignAction},{approvalId:otherApproval},{workItemId:randomUUID()}])await deny(()=>create(c(),{...refs,...patch}));
 await deny(()=>create(c('noReferences'),refs));
 const ctx=c(),made=await create(ctx,refs);let s=made.session;assert.equal(s.state,'REQUESTED');assert.equal(s.providerConnected,false);assert.equal(s.executionTriggered,false);assert.equal(made.receiptVersion,1);assert.equal(made.replayed,false);
 assert.deepEqual((await create(ctx,refs)).session,s);await deny(()=>create(ctx,{...refs,agentCatalogId:'chad'}),409);
 const exact=await voice.read(c(),s.id);assert.deepEqual(exact,s);assert(!JSON.stringify(exact).includes('PRIVATE_'));assert.equal(exact.workItemId,work);assert.equal(exact.approvalId,approval);
 await deny(()=>voice.read(c('peer'),s.id));await deny(()=>voice.read(c('other'),s.id));await deny(()=>voice.read(c('owner',{schoolId:sibling}),s.id));
 await deny(()=>create(c('peer'),{agentCatalogId:'alex',resumeSessionId:s.id}));
 for(const who of ['parent','hq','inactive','noPermission'])await deny(()=>voice.read(c(who),s.id));
 const connectingContext=c(),connectingInput={expectedVersion:1,state:'VOICE_CONNECTING',reasonCode:'NOT_CONFIGURED'};
 s=(await voice.mutate(connectingContext,'status',s.id,connectingInput)).session;assert.equal(s.state,'VOICE_CONNECTING');assert.equal(s.providerConnected,false);
 await deny(()=>mutate(s,'status',{state:'VOICE_CONNECTING',reasonCode:'CLIENT_ERROR'}),409);
 const r=await mutate(s,'status',{state:'VOICE_UNAVAILABLE',reasonCode:'CLIENT_ERROR'});s=r.session;assert.equal(s.state,'VOICE_UNAVAILABLE');
 await deny(()=>mutate(s,'status',{state:'VOICE_CONNECTING',reasonCode:'CLIENT_ERROR'}),409);
 await deny(()=>mutate(s,'status',{state:'CONNECTED',reasonCode:'NOT_CONFIGURED'}),400);
 await deny(()=>mutate(s,'mark-fallback',{reasonCode:'raw provider error'}),400);
 s=(await mutate(s,'mark-fallback',{reasonCode:'CLIENT_OFFLINE'})).session;
 const draft='Review general school operations.';
 for(const bad of ['', ' a','a ', 'a'.repeat(501),'private@example.test','Call phone','https://example.test','api secret','Bearer token','Raw transcript','Record audio','<script>','Number 123','Line\nBreak','Résumé', 'key_abc'])await deny(()=>mutate(s,'mark-fallback',{reasonCode:'NOT_CONFIGURED',draftText:bad}),400);
 s=(await mutate(s,'mark-fallback',{reasonCode:'NOT_CONFIGURED',draftText:'A'.repeat(500)})).session;assert.equal(s.draftText.length,500);
 const draftContext=c(),draftInput={expectedVersion:s.version,reasonCode:'NOT_CONFIGURED',draftText:draft};s=(await voice.mutate(draftContext,'mark-fallback',s.id,draftInput)).session;
 assert.equal((await voice.read(c(),s.id)).draftText,draft);assert(s.draftNotice.includes('does not send a command'));
 const priorVersion=s.version;s=(await mutate(s,'end',{})).session;assert.equal(s.state,'ENDED');assert.equal(s.version,priorVersion+1);
 const historicalReplay=await voice.mutate(draftContext,'mark-fallback',s.id,draftInput);assert.equal(historicalReplay.replayed,true);assert.equal(historicalReplay.receiptVersion,priorVersion);assert.equal(historicalReplay.session.state,'ENDED','Replay never regresses current state');
 await deny(()=>mutate(s,'mark-fallback',{reasonCode:'NOT_CONFIGURED'}),409);await deny(()=>mutate(s,'end',{}),409);
 const resumed=(await create(c(),{agentCatalogId:'chad',resumeSessionId:s.id})).session;assert.equal(resumed.resumeSessionId,s.id);assert.equal(resumed.workItemId,work);assert.equal(resumed.draftText,null);assert.equal(resumed.agentCatalogId,'chad');
 const concurrent=(await create()).session;const same=c(),body={expectedVersion:1,state:'VOICE_UNAVAILABLE',reasonCode:'NOT_CONFIGURED'};
 const concurrentResults=await Promise.all([voice.mutate(same,'status',concurrent.id,body),voice.mutate(same,'status',concurrent.id,body)]);assert.equal(concurrentResults.filter(r=>r.replayed).length,1);assert.equal(concurrentResults[0].session.version,2);assert.deepEqual(concurrentResults[0].session,concurrentResults[1].session);
 const competing=(await create()).session;const results=await Promise.allSettled([mutate(competing,'status',{state:'VOICE_UNAVAILABLE',reasonCode:'NOT_CONFIGURED'}),mutate(competing,'mark-fallback',{reasonCode:'CLIENT_ERROR'})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 // Expiry is an honest read flag, never an automatic transition or success.
 const expiry=await historical(s,-1);const expiredRead=await voice.read(c(),expiry.id);assert.equal(expiredRead.expired,true);assert.equal(expiredRead.state,'REQUESTED');await deny(()=>mutate(expiry,'mark-fallback',{reasonCode:'CLIENT_ERROR'}),409);assert.equal((await mutate(expiry,'end',{})).session.state,'ENDED');
 const short=await historical(s,1.1);await admin.query('BEGIN');await admin.query('SELECT id FROM hon.voice_sessions WHERE id=$1 FOR UPDATE',[short.id]);const waiting=mutate(short,'mark-fallback',{reasonCode:'CLIENT_ERROR'}).then(value=>({value}),error=>({error}));await new Promise(r=>setTimeout(r,1300));await admin.query('COMMIT');assert.equal((await waiting).error?.getStatus(),409,'Post-lock expiry denied');
 const revoke=async(flag)=>admin.query('UPDATE hon.principal_role_grants SET revoked_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,revoked_by_principal_id=CASE WHEN $2 THEN principal_id ELSE NULL END WHERE id=$1',[humans.owner.grant,flag]);
 await revoke(true);await deny(()=>voice.read(c(),s.id));await deny(()=>create(ctx,refs));await deny(()=>voice.mutate(connectingContext,'status',s.id,connectingInput));await revoke(false);
 await admin.query('BEGIN');await admin.query('SELECT id FROM hon.principal_role_grants WHERE id=$1 FOR UPDATE',[humans.owner.grant]);const late=create().then(value=>({value}),error=>({error}));await new Promise(r=>setTimeout(r,150));await revoke(true);await admin.query('COMMIT');assert.equal((await late).error?.getStatus(),403,'Revocation committed during lock wait denied');await revoke(false);
 for(const [table,column,value]of [['organizations','status','SUSPENDED'],['schools','status','SUSPENDED'],['organization_entitlements','status','SUSPENDED']]){const key=table==='organization_entitlements'?'organization_id':'id',id=table==='schools'?school:org;await admin.query(`UPDATE hon.${table} SET ${column}=$2 WHERE ${key}=$1`,[id,value]);await deny(()=>voice.read(c(),s.id));await deny(()=>create(ctx,refs));await admin.query(`UPDATE hon.${table} SET ${column}='ACTIVE' WHERE ${key}=$1`,[id]);}
 await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='action.approve'",[humans.owner.role]);await deny(()=>voice.read(c(),s.id));await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'action.approve')",[humans.owner.role,org]);
 // Audit or outbox failure rolls back session+receipt+all evidence atomically.
 for(const table of ['audit_events','outbox_events']){
  const before=await snapshot([...voiceTables,'audit_events','outbox_events']);await admin.query(`CREATE FUNCTION hon.voice_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$; CREATE TRIGGER voice_fixture_failure BEFORE INSERT ON hon.${table} FOR EACH ROW EXECUTE FUNCTION hon.voice_fixture_failure()`);
  await assert.rejects(()=>create());await admin.query(`DROP TRIGGER voice_fixture_failure ON hon.${table}; DROP FUNCTION hon.voice_fixture_failure()`);assert.deepEqual(await snapshot([...voiceTables,'audit_events','outbox_events']),before,'Atomic rollback');
 }
 const evidence=JSON.stringify((await admin.query("SELECT next_state FROM hon.audit_events WHERE entity_type='VOICE_SESSION' UNION ALL SELECT payload FROM hon.outbox_events WHERE aggregate_type='VOICE_SESSION'")).rows);assert(!evidence.includes(draft));assert(!evidence.includes('PRIVATE_'));assert(!evidence.includes('draftText'));assert(!evidence.includes('microphone'));assert(!evidence.includes('providerHealth'));
 const receipts=JSON.stringify((await admin.query('SELECT to_jsonb(t) r FROM hon.voice_session_requests t')).rows);assert(!receipts.includes(draft));assert(!receipts.includes('PRIVATE_'));
 for(const table of voiceTables)await sqlDeny(()=>direct(c(),()=>runtime.query(`SELECT * FROM hon.${table}`)));
 for(const signature of ['hon.require_voice_actor($1)','hon.voice_session_snapshot($1::uuid)'])await sqlDeny(()=>direct(c(),()=>runtime.query(`SELECT ${signature}`,[signature.includes('actor')?humans.owner.subject:s.id])));
 await sqlDeny(()=>direct(c(),()=>runtime.query("INSERT INTO hon.voice_sessions(organization_id,school_id,actor_principal_id,agent_catalog_id) VALUES($1,$2,$3,'alex')",[org,school,humans.owner.id])));
 await sqlDeny(()=>direct(c('hq'),()=>runtime.query('SELECT hon.read_voice_session($1,$2)',[humans.hq.subject,s.id])));
 await sqlDeny(()=>direct(c('owner',{source:'AI'}),()=>runtime.query('SELECT hon.read_voice_session($1,$2)',[humans.owner.subject,s.id])));
 await sqlDeny(()=>direct(c('owner',{delegatedByPrincipalId:randomUUID()}),()=>runtime.query('SELECT hon.read_voice_session($1,$2)',[humans.owner.subject,s.id])));
 await sqlDeny(()=>runtime.query('SELECT hon.read_voice_session($1,$2)',[humans.owner.subject,s.id]));
 await sqlDeny(()=>admin.query('UPDATE hon.voice_sessions SET work_item_id=NULL WHERE id=$1',[s.id]));await sqlDeny(()=>admin.query('DELETE FROM hon.voice_sessions WHERE id=$1',[s.id]));await sqlDeny(()=>admin.query('TRUNCATE hon.voice_session_requests'));
 assert.deepEqual(await snapshot(prohibited),effects,'Zero provider/config/invocation/action/work/usage/billing/communication/delivery changes');
 // JS and canonical SQL both reject deliberately drifted private surfaces.
 const block=canonical.slice(canonical.indexOf('-- Complete voice handoff:'));
 for(const drift of ["GRANT SELECT ON hon.voice_sessions TO hon_voice_runtime","GRANT SELECT(draft_text) ON hon.voice_sessions TO hon_voice_runtime","ALTER TABLE hon.voice_sessions NO FORCE ROW LEVEL SECURITY","ALTER POLICY voice_sessions_deny_all ON hon.voice_sessions USING(true)","GRANT EXECUTE ON FUNCTION hon.require_voice_actor(text) TO hon_voice_runtime","GRANT EXECUTE ON FUNCTION hon.read_voice_session(text,uuid) TO PUBLIC","ALTER FUNCTION hon.read_voice_session(text,uuid) SET search_path=hon,pg_catalog","ALTER FUNCTION hon.read_voice_session(text,uuid) SECURITY INVOKER","ALTER TABLE hon.voice_sessions DISABLE TRIGGER voice_session_guard","ALTER TABLE hon.voice_sessions ADD COLUMN raw_transcript text"]){
  await admin.query('BEGIN');await admin.query(drift);await assert.rejects(()=>verifyVoiceSecurity(admin,'hon_voice_runtime'));await admin.query('ROLLBACK');assert.throws(()=>sql(`BEGIN; ${drift}; ${block} ROLLBACK;`));
 }
 for(const table of voiceTables)sql(`BEGIN; CREATE ROLE hon_voice_probe NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; GRANT USAGE,CREATE ON SCHEMA hon TO hon_voice_probe; ALTER TABLE hon.${table} OWNER TO hon_voice_probe; SET LOCAL ROLE hon_voice_probe; DO $$ BEGIN IF (SELECT count(*) FROM hon.${table})<>0 THEN RAISE EXCEPTION 'RLS_LEAK'; END IF; END $$; RESET ROLE; ROLLBACK;`);
 await verifyVoiceSecurity(admin,'hon_voice_runtime');sql(canonical);
 console.log('Complete voice handoff integrity passed: exact Complete/human/school/actor/HQ/parent denial, scoped IDs only, monotonic states, expired/post-lock expiry, live revocation/replay, concurrent UUID receipts, bounded private drafts and evidence redaction, direct ACL/FORCE-RLS, audit/outbox rollback, 20 JS+SQL drift denials, zero provider/invocation/action/work/usage/billing/communication effects.');
} finally {await admin.query('ROLLBACK');await Promise.all([database.onModuleDestroy(),runtime.end(),admin.end()]);}
