import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_crm_close_validation'||owner.username!=='hon_crm_close_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_crm_close_runtime')throw new Error('Only exact disposable localhost CRM-close URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {LeadCloseService}=await import('../../../apps/api/dist/crm/lead-close.service.js');
const {LeadCloseController}=await import('../../../apps/api/dist/crm/lead-close.controller.js');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const db=new RuntimeDatabaseService(),service=new LeadCloseService(db),controller=new LeadCloseController(db,service);
const ids=Object.fromEntries(['org','foreignOrg','school','sibling','foreignSchool','role','readRole','closeRole','parentRole','wrongRole','orgRole','foreignRole'].map(k=>[k,randomUUID()]));
const humans=Object.fromEntries(['staff','reader','closer','inactive','parent','mixed','hq','ai','future','expired','revoked','orgOnly','wrong','foreign','nonstaff'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`close-${k}-${randomUUID()}`} ]));
const leads={};const orgs=[ids.org,ids.foreignOrg];let injected=null;
const context=(who='staff',key=randomUUID(),school=ids.school)=>({organizationId:school===ids.foreignSchool?ids.foreignOrg:ids.org,schoolId:school,principalId:humans[who].id,externalSubject:humans[who].subject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:key});
const input=(patch={})=>({status:'WON',expectedVersion:1,closeNote:'PRIVATE_INTERNAL_CLOSE_NOTE\nHuman CRM recordkeeping only.',...patch});
const deny=(fn,status=403)=>assert.rejects(fn,e=>{assert.equal(e.getStatus?.(),status,e.stack);return true;});
const sqlDeny=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.stack);return true;});
async function direct(c,work,client=restricted){await client.query('BEGIN');try{for(const[k,v]of Object.entries({organization_id:c.organizationId,school_id:c.schoolId,principal_id:c.principalId,principal_type:c.principalType,source:c.source,request_id:c.requestId,action_request_id:c.actionRequestId??'',delegated_by_principal_id:c.delegatedByPrincipalId??''}))await client.query('SELECT set_config($1,$2,true)',[`app.hon_${k}`,v]);const result=await work(client);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}}
const sqlClose=(c,id,p)=>direct(c,client=>client.query('SELECT hon.close_crm_lead($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid)',[c.externalSubject,id,JSON.stringify(p),c.idempotencyKey,c.requestId,c.correlationId]));
async function snapshot(tables){const out={};for(const table of tables)out[table]=(await admin.query(`SELECT to_jsonb(t) record FROM hon.${table} t ORDER BY to_jsonb(t)::text`)).rows;return out;}
async function seedLead(name,school=ids.school,org=ids.org,status='OPEN'){
 const [id,person,pipeline,stage]=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
 await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'PRIVATE_CONTACT','UNCHANGED','private@example.test')",[person,org,school]);
 await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'UNCHANGED_PIPELINE')",[pipeline,org,school]);
 await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'UNCHANGED_STAGE',1)",[stage,org,school,pipeline]);
 await admin.query("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,$7::hon.lead_status)",[id,org,school,person,pipeline,stage,status]);
 leads[name]=id;return id;
}
async function cleanup(){
 await admin.query('ROLLBACK');if(injected){await admin.query(`DROP TRIGGER IF EXISTS crm_close_fixture_failure ON hon.${injected}`);await admin.query('DROP FUNCTION IF EXISTS hon.crm_close_fixture_failure()');}
 await admin.query('BEGIN');try{
  for(const t of ['crm_lead_close_requests','crm_lead_attributions'])await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  for(const t of ['crm_lead_close_requests','outbox_delivery_attempts','outbox_events','audit_events','crm_lead_attributions','crm_leads','crm_pipeline_stages','crm_pipelines','people','principal_role_grants','role_permissions','roles','organization_entitlements'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs]);
  for(const t of ['crm_lead_close_requests','crm_lead_attributions'])await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
  await admin.query('DELETE FROM hon.schools WHERE organization_id=ANY($1::uuid[])',[orgs]);await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs]);await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
await Promise.all([admin.connect(),restricted.connect()]);
try{
 const marker=(await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
 assert.equal(marker.owner,'hon_crm_close_owner');assert.equal(marker.marker,'HON disposable CRM-only lead close validation');
 const posture=(await restricted.query("SELECT NOT(rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication) safe FROM pg_roles WHERE rolname=current_user")).rows[0];assert(posture.safe);
 assert.equal((await restricted.query("SELECT count(*)::int n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)")).rows[0].n,0);
 const protectedTables=['crm_lead_close_requests','users','principals','permissions','roles','role_permissions','principal_role_grants','family_access_grants','hq_operator_grants','organizations','schools'];
 for(const t of protectedTables){assert.equal((await restricted.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') allowed",[`hon.${t}`])).rows[0].allowed,false,t);await sqlDeny(()=>restricted.query(`SELECT * FROM hon.${t}`));}
 for(const signature of ['guard_crm_lead_close_history()','crm_lead_close_has_permission(uuid,uuid,uuid,text)','require_crm_lead_close_actor(text)','guard_crm_lead_close_update()'])assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",['hon.'+signature])).rows[0].allowed,false);
 for(const signature of ['resolve_crm_lead_close_scope(text,uuid)','close_crm_lead(text,uuid,jsonb,uuid,uuid,uuid)'])assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",['hon.'+signature])).rows[0].allowed,true);
 await admin.query('BEGIN');
 for(const org of orgs){await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'CRM close fixture','CRM close fixture')",[org]);await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'ESSENTIAL',clock_timestamp()-interval '1 day')",[org]);}
 for(const [school,org]of [[ids.school,ids.org],[ids.sibling,ids.org],[ids.foreignSchool,ids.foreignOrg]])await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Fixture school',$1::text,'America/New_York')",[school,org]);
 for(const[who,h]of Object.entries(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,$3,'PRIVATE_DIRECTORY',$4)",[h.id,who==='ai'?null:h.user,who==='ai'?'AI_EMPLOYEE':'HUMAN_USER',who!=='inactive']);}
 for(const[role,org,code,codes]of [[ids.role,ids.org,'STAFF',['crm.lead.read','crm.lead.close']],[ids.readRole,ids.org,'READER',['crm.lead.read']],[ids.closeRole,ids.org,'CLOSER',['crm.lead.close']],[ids.parentRole,ids.org,'PARENT',['crm.lead.read','crm.lead.close']],[ids.wrongRole,ids.org,'OTHER_STAFF',['crm.lead.read','crm.lead.close']],[ids.orgRole,ids.org,'ORG_ONLY',['crm.lead.read','crm.lead.close']],[ids.foreignRole,ids.foreignOrg,'FOREIGN_STAFF',['crm.lead.read','crm.lead.close']]]){
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,'Fixture role')",[role,org,code]);for(const permission of codes)await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[role,org,permission]);
 }
 for(const who of Object.keys(humans).filter(k=>!['nonstaff','orgOnly'].includes(k))){
  const role=who==='reader'?ids.readRole:who==='closer'?ids.closeRole:who==='parent'?ids.parentRole:who==='wrong'?ids.wrongRole:who==='orgOnly'?ids.orgRole:who==='foreign'?ids.foreignRole:ids.role;
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from,effective_until) VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6::interval,CASE WHEN $7 THEN clock_timestamp()-interval '1 second' ELSE NULL END)",[who==='foreign'?ids.foreignOrg:ids.org,who==='orgOnly'?null:who==='wrong'?ids.sibling:who==='foreign'?ids.foreignSchool:ids.school,humans[who].id,role,humans.staff.id,who==='future'?'1 day':'-2 days',who==='expired']);
 }
 await admin.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5)',[ids.org,ids.school,humans.mixed.id,ids.parentRole,humans.staff.id]);
 await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE principal_id=$1',[humans.revoked.id,humans.staff.id]);
 await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes) VALUES($1,'HON_HQ_OWNER',ARRAY['crm.lead.close'])",[humans.hq.id]);
 for(const name of ['won','lost','race','same','rollback','expiry','permission','raw','tierESSENTIAL','tierCORE','tierCOMPLETE'])await seedLead(name);
 await seedLead('archived',ids.school,ids.org,'ARCHIVED');await seedLead('sibling',ids.sibling);await seedLead('foreign',ids.foreignSchool,ids.foreignOrg);
 await admin.query('COMMIT');
 const forbidden=['crm_activities','crm_appointments','crm_pipelines','crm_pipeline_stages','crm_lead_attributions','people','student_profiles','families','family_members','family_access_grants','work_items','action_requests','action_approvals','communication_messages','communication_consents','payment_attempts','invoices','memberships','membership_payment_schedules','billing_accounts','ai_usage_ledger','ai_invocation_plans','ai_team_presentation_preferences','hq_ai_provider_connections','hq_ai_control_requests','automation_rules','automation_rule_versions','automation_rule_requests','crm_follow_ups','crm_follow_up_versions','outbox_delivery_attempts'];
 const before=await snapshot(forbidden),allWrites=['crm_leads','crm_lead_close_requests','audit_events','outbox_events'],noWrites=await snapshot(allWrites);
 for(const who of ['reader','closer','inactive','parent','mixed','hq','ai','future','expired','revoked','orgOnly','wrong','foreign','nonstaff']){await deny(()=>service.close(context(who),leads.won,input()));assert.equal(await db.resolveCrmLeadCloseScope(humans[who].subject,ids.school),undefined);}
 for(const c of [{...context(),organizationId:ids.foreignOrg},context('staff',randomUUID(),ids.sibling),{...context(),externalSubject:humans.reader.subject}])await deny(()=>service.close(c,leads.won,input()));
 for(const id of [leads.sibling,leads.foreign,randomUUID()])await deny(()=>service.close(context(),id,input()),404);
 for(const patch of [{source:'AI'},{source:'AUTOMATION'},{source:'PUBLIC_API'},{source:'PARENT_APP'},{source:'HQ_SUPPORT'},{source:'INTEGRATION'},{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{principalType:'SYSTEM_SERVICE'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]){await deny(()=>service.close({...context(),...patch},leads.won,input()));await sqlDeny(()=>sqlClose({...context(),...patch},leads.won,input()));}
 for(const patch of [{status:'OPEN'},{status:'ARCHIVED'},{status:'COMPLETED'},{expectedVersion:0},{expectedVersion:'1'},{expectedVersion:1.5},{expectedVersion:999999999},{closeNote:null},{closeNote:''},{closeNote:' x'},{closeNote:'x '},{closeNote:'x\t'},{closeNote:'x\u202e'},{closeNote:'x\u0085'},{closeNote:'\u00a0x'},{closeNote:'x\u202f'},{closeNote:'x'.repeat(2001)},{leadId:leads.won},{organizationId:ids.org},{source:'HUMAN_UI'},{send:true}]){await deny(()=>service.close(context(),leads.won,input(patch)),400);await sqlDeny(()=>sqlClose(context(),leads.won,input(patch)),'22023');}
 await deny(()=>service.close(context(),leads.archived,input()),409);await deny(()=>service.close(context(),leads.won,input({expectedVersion:2})),409);
 assert.deepEqual(await snapshot(allWrites),noWrites,'All denials must leave every mutation/evidence table unchanged.');
 // Generic runtime UPDATE cannot fake a close, including by forging the command GUC.
 await sqlDeny(()=>direct(context(),async client=>{await client.query("SELECT set_config('app.hon_crm_close_lead_id',$1,true)",[leads.raw]);return client.query("UPDATE hon.crm_leads SET status='WON',version=version+1,won_at=clock_timestamp() WHERE id=$1::uuid",[leads.raw]);}));
 const c=context(),first=await service.close(c,leads.won,input());assert.equal(first.replayed,false);assert.equal(first.receipt.status,'WON');assert.equal(first.receipt.version,2);assert.equal(first.receipt.priorVersion,1);assert.equal(first.receipt.crmOnly,true);assert.equal(first.receipt.closeNote,input().closeNote);
 assert.deepEqual((await service.close({...c,requestId:randomUUID()},leads.won,input())).receipt,first.receipt);
 assert.equal((await service.close(c,leads.won,input())).replayed,true);
 for(const p of [{status:'LOST'},{closeNote:'different'},{expectedVersion:2}])await deny(()=>service.close(c,leads.won,input(p)),409);
 await deny(()=>service.close(c,leads.lost,input()),409);await deny(()=>service.close(context(),leads.won,input({expectedVersion:2})),409);
 const lost=await controller.close(ids.org,ids.school,leads.lost,randomUUID(),{status:'LOST',expectedVersion:1},{honIdentity:{externalSubject:humans.staff.subject}});assert.equal(lost.data.status,'LOST');assert.equal(lost.data.closeNote,null);
 for(const[name,receipt]of [['won',first.receipt],['lost',lost.data]]){const row=(await admin.query('SELECT to_jsonb(l) record FROM hon.crm_leads l WHERE id=$1',[leads[name]])).rows[0].record;const original=noWrites.crm_leads.find(x=>x.record.id===leads[name]).record;for(const k of Object.keys(original).filter(k=>!['status','won_at','lost_at','version','updated_at'].includes(k)))assert.deepEqual(JSON.parse(JSON.stringify(row[k])),original[k],k);assert.equal(row.status,receipt.status);assert.equal(row.version,2);assert.equal(row.won_at!==null,name==='won');assert.equal(row.lost_at!==null,name==='lost');}
 const same=context();const retries=await Promise.all([service.close(same,leads.same,input()),service.close(same,leads.same,input())]);assert.equal(retries.filter(x=>!x.replayed).length,1);assert.deepEqual(retries[0].receipt,retries[1].receipt);
 const race=await Promise.allSettled([service.close(context(),leads.race,input()),service.close(context(),leads.race,input({status:'LOST'}))]);assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal(race.find(x=>x.status==='rejected').reason.getStatus(),409);
 // Exact live authority is required even for a successful historical replay.
 for(const[apply,args,restore]of [
  ['UPDATE hon.principals SET is_active=false WHERE id=$1',[humans.staff.id],'UPDATE hon.principals SET is_active=true WHERE id=$1'],
  ["DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='crm.lead.close'",[ids.role],`INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,'${ids.org}','crm.lead.close')`],
  ["DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='crm.lead.read'",[ids.role],`INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,'${ids.org}','crm.lead.read')`],
  ["UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1",[ids.org],'UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1'],
  ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1",[ids.school],"UPDATE hon.schools SET status='ACTIVE' WHERE id=$1"],
  ["UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1",[ids.org],"UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1"],
  ['UPDATE hon.roles SET management_school_id=$2 WHERE id=$1',[ids.role,ids.sibling],'UPDATE hon.roles SET management_school_id=NULL WHERE id=$1'],
 ]){await admin.query(apply,args);await deny(()=>service.close(c,leads.won,input()));await admin.query(restore,args.slice(0,1));}
 // A valid read role cannot borrow close authority from an org or wrong-school grant.
 for(const school of [ids.sibling]){await admin.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5)',[ids.org,school,humans.reader.id,ids.orgRole,humans.staff.id]);await deny(()=>service.close(context('reader'),leads.permission,input()));await admin.query('DELETE FROM hon.principal_role_grants WHERE principal_id=$1 AND role_id=$2',[humans.reader.id,ids.orgRole]);}
 const duplicate=randomUUID();await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Duplicate')",[duplicate,humans.staff.user]);try{await deny(()=>service.close(c,leads.won,input()));}finally{await admin.query('DELETE FROM hon.principals WHERE id=$1',[duplicate]);}
 // Observe blocking at the authority SHARE lock and then revoke/expire while blocked.
 const probe=new pg.Client({connectionString:owner.toString(),ssl:false});await probe.connect();
 async function blockedChange(id,change){await admin.query('BEGIN');await admin.query('LOCK TABLE hon.principal_role_grants IN ROW EXCLUSIVE MODE');const pid=(await admin.query('SELECT pg_backend_pid() pid')).rows[0].pid;const pending=service.close(context(),id,input()).then(value=>({value}),error=>({error}));let blocked=false;for(let n=0;n<300;n++){blocked=(await probe.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) b',[pid])).rows[0].b;if(blocked)break;await new Promise(r=>setTimeout(r,10));}assert(blocked,'Observed actual PostgreSQL lock blocking');await change();await admin.query('COMMIT');assert.equal((await pending).error?.getStatus(),403);}
 try{
  await blockedChange(leads.permission,()=>admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE principal_id=$1',[humans.staff.id,humans.reader.id]));await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE principal_id=$1',[humans.staff.id]);
  await admin.query("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()+interval '300 milliseconds' WHERE principal_id=$1",[humans.staff.id]);await blockedChange(leads.expiry,()=>new Promise(r=>setTimeout(r,400)));await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE principal_id=$1',[humans.staff.id]);
 }finally{await admin.query('ROLLBACK');await probe.end();}
 for(const table of ['audit_events','outbox_events','crm_lead_close_requests']){
  await admin.query(`CREATE FUNCTION hon.crm_close_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${ids.org}'::uuid THEN RAISE EXCEPTION 'close atomic failure'; END IF; RETURN NEW; END $$`);await admin.query(`CREATE TRIGGER crm_close_fixture_failure BEFORE INSERT ON hon.${table} FOR EACH ROW EXECUTE FUNCTION hon.crm_close_fixture_failure()`);injected=table;
  const prior=await snapshot(allWrites);await assert.rejects(()=>service.close(context(),leads.rollback,input()),/close atomic failure/);assert.deepEqual(await snapshot(allWrites),prior);
  await admin.query(`DROP TRIGGER crm_close_fixture_failure ON hon.${table}`);await admin.query('DROP FUNCTION hon.crm_close_fixture_failure()');injected=null;
 }
 await sqlDeny(()=>admin.query("UPDATE hon.crm_lead_close_requests SET response='{}' WHERE organization_id=$1",[ids.org]));await sqlDeny(()=>admin.query('DELETE FROM hon.crm_lead_close_requests WHERE organization_id=$1',[ids.org]));await sqlDeny(()=>admin.query('TRUNCATE hon.crm_lead_close_requests'));
 await admin.query('GRANT SELECT ON hon.crm_lead_close_requests TO hon_crm_close_runtime');try{assert.equal((await direct(context(),client=>client.query('SELECT count(*)::int n FROM hon.crm_lead_close_requests'))).rows[0].n,0);await sqlDeny(()=>direct(context(),client=>client.query('SET LOCAL row_security=off; SELECT * FROM hon.crm_lead_close_requests')));}finally{await admin.query('REVOKE SELECT ON hon.crm_lead_close_requests FROM hon_crm_close_runtime');}
 for(const tier of ['ESSENTIAL','CORE','COMPLETE']){await admin.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[ids.org,tier]);const id=leads['tier'+tier];const r=await service.close(context(),id,{status:'LOST',expectedVersion:1,closeNote:'😀'.repeat(2000)});assert.equal(r.receipt.status,'LOST');}
 const requests=(await admin.query('SELECT * FROM hon.crm_lead_close_requests WHERE organization_id=$1',[ids.org])).rows;
 const audits=(await admin.query("SELECT source,action_request_id,prior_state,next_state FROM hon.audit_events WHERE organization_id=$1 AND action_code='crm.lead.close'",[ids.org])).rows;
 const events=(await admin.query("SELECT event_type,schema_version,aggregate_version,payload FROM hon.outbox_events WHERE organization_id=$1 AND event_type='crm.lead.human_closed'",[ids.org])).rows;
 assert.equal(requests.length,7);assert.equal(audits.length,requests.length);assert.equal(events.length,requests.length);assert(audits.every(a=>a.source==='HUMAN_UI'&&a.action_request_id===null&&a.prior_state.status==='OPEN'));
 assert(events.every(e=>e.schema_version===1&&e.payload.crmOnly&&e.payload.humanOnly&&e.payload.internalOnly&&e.payload.executionAllowed===false));assert.doesNotMatch(JSON.stringify([...audits,...events]),/PRIVATE_|closeNote|contact|email|phone|enrollment|revenue/);
 assert.deepEqual(await snapshot(forbidden),before,'No contact/trial/student/family/membership/payment/consent/attendance/provider/AI/action/automation effects.');
 const verify=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).split('-- CRM-only lead close exact verification:')[1]?.split('-- End CRM-only lead close exact verification.')[0];assert(verify);await admin.query(verify.replaceAll('hon_runtime','hon_crm_close_runtime'));
 // Canonical verifier must detect ACL/policy/function/trigger drift, rollback safely.
 for(const drift of ["GRANT SELECT ON hon.crm_lead_close_requests TO hon_crm_close_runtime","CREATE POLICY fixture_bad ON hon.crm_lead_close_requests USING(true)","ALTER TABLE hon.crm_lead_close_requests DISABLE ROW LEVEL SECURITY","ALTER TABLE hon.crm_leads DISABLE TRIGGER crm_lead_close_update_guard","GRANT EXECUTE ON FUNCTION hon.require_crm_lead_close_actor(text) TO hon_crm_close_runtime"]){await admin.query('BEGIN');try{await admin.query(drift);await assert.rejects(()=>admin.query(verify.replaceAll('hon_runtime','hon_crm_close_runtime')));}finally{await admin.query('ROLLBACK');}}
 assert.equal((await restricted.query('SELECT hon.current_school_id() id')).rows[0].id,null);
 console.log('PASS CRM close integrity: exact current staff read+close authority and subject; parent/HQ/AI/org/foreign/expired/mixed denial; closed API+SQL; WON/LOST OPEN/version atomicity; unchanged lead fields; exact replay and races; observed revocation/post-lock expiry; rollback at audit/outbox/receipt; private immutable FORCE-RLS evidence; canonical drift verification; all tiers; zero other-domain/execution effects.');
}finally{try{await cleanup();}finally{await Promise.all([admin.end(),restricted.end(),db.onModuleDestroy()]);}}
