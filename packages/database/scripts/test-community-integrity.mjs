import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { RuntimeDatabaseService } from '../../../apps/api/dist/foundation/runtime-database.service.js';
import { CommunityService } from '../../../apps/api/dist/community/community.service.js';
import { communityTables, communityFunctions, verifyCommunitySecurity } from './community-security.mjs';
for(const [key,role] of [['DATABASE_URL','hon_community_owner'],['HON_RUNTIME_DATABASE_URL','hon_community_runtime']]) {
 const u=new URL(process.env[key]??'');if(u.hostname!=='localhost'||u.port!=='5432'||u.pathname!=='/hon_community_validation'||u.username!==role)throw new Error('Only exact disposable localhost community database and roles allowed. Never remote URLs.');
}
const admin=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false}),runtime=new pg.Client({connectionString:process.env.HON_RUNTIME_DATABASE_URL,ssl:false});
const database=new RuntimeDatabaseService(),svc=new CommunityService(database);
const org=randomUUID(),otherOrg=randomUUID(),school=randomUUID(),sibling=randomUUID(),otherSchool=randomUUID();
const humans=Object.fromEntries(['owner','operator','other','staff','parent','hq','inactive','future','expired','orgOnly','noPermission','wrongRoleSchool'].map(k=>[k,{id:randomUUID(),user:randomUUID(),role:randomUUID(),grant:randomUUID(),subject:`community-${k}-${randomUUID()}`,org:k==='other'?otherOrg:org,school:k==='other'?otherSchool:school}]));
const c=(who='owner',patch={})=>({organizationId:humans[who].org,schoolId:humans[who].school,principalId:humans[who].id,externalSubject:humans[who].subject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),...patch});
const content=(patch={})=>({expectedVersion:0,kind:'TOPIC',parentId:null,title:'General school-owner practice',body:'What general practice helps owners?',status:'DRAFT',reason:'Private human author reason',...patch});
const revise=(r,patch={})=>content({expectedVersion:r.version,kind:r.kind,parentId:r.parentId,title:r.title,body:r.body,status:r.status,reason:r.reason,...patch});
const deny=(work,status=403)=>assert.rejects(async()=>work(),e=>{assert.equal(e.getStatus?.(),status,e.stack);return true;});
const sqlDeny=(work,code='42501')=>assert.rejects(async()=>work(),e=>{assert.equal(e.code,code,e.stack);return true;});
async function direct(context,work){await runtime.query('BEGIN');try{for(const[k,v]of Object.entries({organization_id:context.organizationId,school_id:context.schoolId,principal_id:context.principalId,principal_type:context.principalType,source:context.source,request_id:context.requestId,action_request_id:context.actionRequestId??'',delegated_by_principal_id:context.delegatedByPrincipalId??''}))await runtime.query('SELECT set_config($1,$2,true)',[`app.hon_${k}`,v]);const r=await work();await runtime.query('COMMIT');return r;}catch(e){await runtime.query('ROLLBACK');throw e;}}
async function snapshot(tables){const data={};for(const t of tables)data[t]=(await admin.query(`SELECT to_jsonb(t) record FROM hon.${t} t ORDER BY to_jsonb(t)::text`)).rows;return data;}
async function cleanup(){await admin.query('ROLLBACK');await admin.query('DROP TRIGGER IF EXISTS community_fixture_failure ON hon.community_events; DROP FUNCTION IF EXISTS hon.community_fixture_failure()');await admin.query('BEGIN');try{
 for(const t of communityTables)if(t!=='community_verifications')await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
 for(const t of ['community_events','community_requests','community_versions','community_content','community_profiles','community_members','community_organizations','community_verifications'])await admin.query(`DELETE FROM hon.${t}`);
 for(const t of communityTables)if(t!=='community_verifications')await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
 await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);
 for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[[org,otherOrg]]);
 await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
 await admin.query('DELETE FROM hon.schools WHERE organization_id=ANY($1::uuid[])',[[org,otherOrg]]);await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[[org,otherOrg]]);await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}}
await Promise.all([admin.connect(),runtime.connect()]);
try {
 // This test database must have no prior community data; never delete unrelated fixtures.
 for(const t of communityTables)assert.equal(Number((await admin.query(`SELECT count(*) n FROM hon.${t}`)).rows[0].n),0,'Fresh disposable database required');
 await verifyCommunitySecurity(admin,'hon_community_runtime');
 for(const t of communityTables){assert.equal((await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') allowed",[`hon.${t}`])).rows[0].allowed,false);await sqlDeny(()=>runtime.query(`SELECT * FROM hon.${t}`));}
 for(const [signature,allowed]of communityFunctions)assert.equal((await runtime.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') allowed',[signature])).rows[0].allowed,allowed,signature);
 await sqlDeny(()=>runtime.query("SELECT hon.read_community_profile('anonymous')"));
 await admin.query('BEGIN');
 for(const id of [org,otherOrg])await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_LEGAL_NAME','PRIVATE_ORG_DIRECTORY')",[id]);
 for(const [id,o]of [[school,org],[sibling,org],[otherSchool,otherOrg]])await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'PRIVATE_SCHOOL_DIRECTORY',$1::text,'America/New_York')",[id,o]);
 for(const o of [org,otherOrg])await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'ESSENTIAL','ACTIVE',clock_timestamp()-interval '1 day')",[o]);
 for(const [who,h]of Object.entries(humans)) {
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_PERSONAL_DIRECTORY')",[h.user,h.subject,`${h.user}@private.example.test`]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_PERSONAL_DIRECTORY',$3)",[h.id,h.user,who!=='inactive']);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role,management_school_id) VALUES($1,$2,$3,'PRIVATE_ROLE_DIRECTORY',$4,$5)",[h.role,h.org,who==='parent'?'PARENT':who==='owner'||who==='other'?'OWNER':`COMMUNITY_${who.toUpperCase()}`,who==='owner'||who==='other',who==='wrongRoleSchool'?sibling:null]);
  for(const permission of ['crm.lead.read',...(who==='noPermission'?[]:['community.participate','community.organization.manage'])])await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[h.role,h.org,permission]);
  if(who!=='orgOnly') await admin.query("INSERT INTO hon.principal_role_grants(id,principal_id,organization_id,school_id,role_id,granted_by_principal_id,effective_from,effective_until) VALUES($1,$2,$3,$4,$5,$2,clock_timestamp()+$6::interval,CASE WHEN $7 THEN clock_timestamp()-interval '1 hour' ELSE NULL END)",[h.grant,h.id,h.org,who==='orgOnly'?null:h.school,h.role,who==='future'?'1 day':'-2 days',who==='expired']);
  if(who!=='staff')await admin.query("INSERT INTO hon.community_verifications(principal_id,organization_id,school_id,capacity,verified_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[h.id,h.org,h.school,who==='operator'?'OPERATOR':'OWNER']);
 }
 await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')",[humans.hq.id]);
 await admin.query('COMMIT');
 const operationalTables=['people','student_profiles','families','family_members','family_access_grants','crm_leads','crm_appointments','crm_activities','billing_accounts','memberships','membership_payment_schedules','invoices','payment_attempts','communication_messages','communication_consents','marketing_campaigns','marketing_campaign_versions','ai_usage_ledger','ai_invocation_plans','action_requests','automation_rules','work_items','outbox_events','outbox_delivery_attempts','audit_events'];
 const baseline=await snapshot(operationalTables);
 for(const who of ['staff','parent','hq','inactive','future','expired','orgOnly','noPermission','wrongRoleSchool']) {
  assert.equal(await database.resolveCommunityScope(humans[who].subject,humans[who].school),undefined,who);
  await deny(()=>svc.profile(c(who)));await deny(()=>svc.list(c(who),'TOPIC',null));
 }
 assert.equal(await database.resolveCommunityScope(humans.owner.subject,sibling),undefined);
 await deny(()=>svc.profile(c('owner',{schoolId:sibling})));await deny(()=>svc.profile(c('owner',{organizationId:otherOrg,schoolId:otherSchool})));
 await deny(()=>svc.profile(c('owner',{principalId:humans.other.id})));await deny(()=>svc.profile(c('owner',{externalSubject:humans.other.subject})));
 for(const patch of [{source:'AI_TOOL'},{source:'PUBLIC_API'},{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]) {
  await deny(()=>svc.profile(c('owner',patch))); const ctx=c('owner',patch);
  await sqlDeny(()=>direct(ctx,()=>runtime.query('SELECT hon.read_community_profile($1)',[ctx.externalSubject])));
 }
 await sqlDeny(()=>admin.query('INSERT INTO hon.principal_role_grants(principal_id,organization_id,school_id,role_id,granted_by_principal_id) VALUES($1,$2,NULL,$3,$1)',[humans.owner.id,org,humans.owner.role]),'23502');
 assert.equal((await svc.profile(c())).organizationEnabled,false);await deny(()=>svc.list(c(),'TOPIC',null));
 await svc.mutate(c(),'CONSENT',null,{expectedVersion:0,enabled:true});
 await svc.mutate(c('other'),'CONSENT',null,{expectedVersion:0,enabled:true});
 for(const who of ['owner','operator','other'])await svc.mutate(c(who),'PROFILE',null,{expectedVersion:0,displayName:who==='owner'?'Owner alias':who==='operator'?'Operator alias':'Other owner alias',enabled:true});
 await deny(()=>svc.mutate(c('operator'),'CONSENT',null,{expectedVersion:1,enabled:false}));
 const createContext=c();let topic=(await svc.mutate(createContext,'CONTENT',null,content())).result;
 assert.equal(topic.canEdit,true);assert.equal((await svc.list(c('other'),'TOPIC',null)).items.length,0);
 await deny(()=>svc.read(c('other'),'TOPIC',null,topic.id),404);await deny(()=>svc.history(c('operator'),topic.id),404);
 assert.equal((await svc.mutate(createContext,'CONTENT',null,content())).replayed,true);
 await deny(()=>svc.mutate(createContext,'CONTENT',null,content({body:'Changed private body'})),409);
 for(const patch of [{attachments:[]},{url:'https://example.test'},{studentId:randomUUID()},{billingAccountId:randomUUID()},{provider:'fake'},{body:'example.com'},{body:'a@school.test'},{body:'file:///private'},{body:'www.school.test'},{body:'+1 800 555 1234'},{body:'<b>private</b>'},{body:'x'.repeat(4001)}]) {
  await deny(()=>svc.mutate(c(),'CONTENT',null,content(patch)),400);
  const ctx=c();await sqlDeny(()=>direct(ctx,()=>runtime.query('SELECT hon.mutate_community($1,\'CONTENT\',NULL,$2::jsonb,$3,$4::uuid)',[ctx.externalSubject,JSON.stringify(content(patch)),ctx.idempotencyKey,ctx.requestId])),'22023');
 }
 topic=(await svc.mutate(c(),'CONTENT',topic.id,revise(topic,{status:'PUBLISHED',reason:'Explicit member sharing'}))).result;
 const publicRead=await svc.read(c('other'),'TOPIC',null,topic.id);assert.equal(publicRead.canEdit,false);assert.equal(publicRead.reason,null);assert.equal(publicRead.displayName,'Owner alias');
 const publicText=JSON.stringify(publicRead);for(const marker of ['PRIVATE',org,otherOrg,school,humans.owner.id,humans.owner.user,'externalSubject','organizationId','schoolId','principalId','email','provider','payment'])assert(!publicText.includes(marker),marker);
 await deny(()=>svc.mutate(c('other'),'CONTENT',topic.id,revise(topic)),404);
 await deny(()=>svc.history(c('other'),topic.id),404);
 let post=(await svc.mutate(c('operator'),'CONTENT',null,content({kind:'POST',parentId:topic.id,title:'General owner answer'}))).result;
 await deny(()=>svc.mutate(c('other'),'CONTENT',null,content({kind:'COMMENT',parentId:post.id,title:''})),404);
 post=(await svc.mutate(c('operator'),'CONTENT',post.id,revise(post,{status:'PUBLISHED'}))).result;
 let comment=(await svc.mutate(c('other'),'CONTENT',null,content({kind:'COMMENT',parentId:post.id,title:''}))).result;
 comment=(await svc.mutate(c('other'),'CONTENT',comment.id,revise(comment,{status:'PUBLISHED'}))).result;
 assert.equal((await svc.list(c('owner'),'COMMENT',post.id)).items.length,1);
 await deny(()=>svc.mutate(c('owner'),'CONTENT',null,content({kind:'COMMENT',parentId:comment.id,title:''})),404);
 await deny(()=>svc.mutate(c('owner'),'CONTENT',null,content({kind:'POST',parentId:post.id})),404);
 await deny(()=>svc.mutate(c('owner'),'CONTENT',topic.id,revise(topic,{status:'DRAFT'})),409);
 await deny(()=>svc.mutate(c('operator'),'CONTENT',post.id,revise(post,{parentId:comment.id})),400);
 await deny(()=>svc.mutate(c('owner'),'CONTENT',topic.id,revise(topic,{expectedVersion:1})),409);
 topic=(await svc.mutate(c(),'CONTENT',topic.id,revise(topic,{title:'Updated general topic',reason:'Human revision'}))).result;
 const history=await svc.history(c(),topic.id);assert.equal(history.items.length,3);assert.deepEqual(Object.keys(history.items[0]).sort(),['recordedAt','status','version']);assert(!JSON.stringify(history).includes('body'));
 // Organization/profile withdrawal hides the author and descendants; settings remain accessible.
 await svc.mutate(c(),'PROFILE',null,{expectedVersion:1,displayName:'Owner alias',enabled:false});
 await deny(()=>svc.list(c(),'TOPIC',null));assert.equal((await svc.list(c('other'),'TOPIC',null)).items.length,0);await deny(()=>svc.list(c('other'),'COMMENT',post.id),404);
 await svc.mutate(c(),'PROFILE',null,{expectedVersion:2,displayName:'New owner alias',enabled:true});
 assert.equal((await svc.read(c('other'),'TOPIC',null,topic.id)).displayName,'New owner alias');
 await svc.mutate(c(),'CONSENT',null,{expectedVersion:1,enabled:false});await deny(()=>svc.list(c('operator'),'TOPIC',null));assert.equal((await svc.list(c('other'),'TOPIC',null)).items.length,0);
 await svc.mutate(c(),'CONSENT',null,{expectedVersion:2,enabled:true});
 // Late revocations are applied before replay and output, never cached scope authority.
 const changes=[
  ['verification',"UPDATE hon.community_verifications SET revoked_at=clock_timestamp() WHERE principal_id=$1","UPDATE hon.community_verifications SET revoked_at=NULL WHERE principal_id=$1"],
  ['expiry',"UPDATE hon.community_verifications SET effective_until=clock_timestamp()-interval '1 hour' WHERE principal_id=$1","UPDATE hon.community_verifications SET effective_until=NULL WHERE principal_id=$1"],
  ['grant',"UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$1 WHERE principal_id=$1","UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE principal_id=$1"],
  ['inactive',"UPDATE hon.principals SET is_active=false WHERE id=$1","UPDATE hon.principals SET is_active=true WHERE id=$1"],
 ];
 for(const [name,change,restore]of changes){await admin.query(change,[humans.owner.id]);try{await deny(()=>svc.list(c(),'TOPIC',null));await deny(()=>svc.mutate(createContext,'CONTENT',null,content()));assert.equal((await svc.list(c('other'),'TOPIC',null)).items.length,0,name);}finally{await admin.query(restore,[humans.owner.id]);}}
 await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='community.participate'",[humans.owner.role]);
 await deny(()=>svc.mutate(createContext,'CONTENT',null,content()));assert.equal((await svc.list(c('other'),'TOPIC',null)).items.length,0);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'community.participate')",[humans.owner.role,org]);
 await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[org]);
 await deny(()=>svc.profile(c()));assert.equal((await svc.list(c('other'),'TOPIC',null)).items.length,0);
 await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[org]);
 // Concurrent identical receipts serialize to one human write and one replay.
 const concurrent=c(); const concurrentResults=await Promise.all([svc.mutate(concurrent,'CONTENT',null,content()),svc.mutate(concurrent,'CONTENT',null,content())]);
 assert.deepEqual(concurrentResults.map(r=>r.replayed).sort(),[false,true]);assert.equal(concurrentResults[0].result.id,concurrentResults[1].result.id);
 // A permission revocation holding the grant lock must be seen after a waiting read/replay resumes.
 await admin.query('BEGIN');await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$1 WHERE id=$2',[humans.owner.id,humans.owner.grant]);
 const waiting=svc.mutate(createContext,'CONTENT',null,content()).then(()=>({allowed:true}),e=>({status:e.getStatus?.()}));
 let blocked=false;
 for(let i=0;i<100;i++){const rows=(await admin.query("SELECT 1 FROM pg_stat_activity WHERE usename='hon_community_runtime' AND wait_event_type='Lock'")).rows;if(rows.length){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
 assert(blocked,'Expected a real lock wait before revocation completes');await admin.query('COMMIT');assert.equal((await waiting).status,403);
 await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[humans.owner.grant]);
 // Bounded real pages and immutable metadata history.
 for(let i=0;i<31;i++)await svc.mutate(c(),'CONTENT',null,content());
 const firstPage=await svc.list(c(),'TOPIC',null);assert.equal(firstPage.items.length,30);assert.equal(firstPage.nextAfter,firstPage.items[29].id);
 const secondPage=await svc.list(c(),'TOPIC',null,firstPage.nextAfter);assert(secondPage.items.every(x=>x.id>firstPage.nextAfter));assert.equal(secondPage.nextAfter,null);
 let historyDraft=concurrentResults[0].result;
 for(let i=0;i<31;i++)historyDraft=(await svc.mutate(c(),'CONTENT',historyDraft.id,revise(historyDraft))).result;
 const firstHistory=await svc.history(c(),historyDraft.id);assert.equal(firstHistory.items.length,30);assert.equal(firstHistory.nextBefore,firstHistory.items[29].version);
 const secondHistory=await svc.history(c(),historyDraft.id,firstHistory.nextBefore);assert.equal(secondHistory.items.length,2);assert.equal(secondHistory.nextBefore,null);
 // Exact school binding for authors: same principal in sibling school cannot edit private ownership.
 await admin.query('INSERT INTO hon.principal_role_grants(principal_id,organization_id,school_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$1)',[humans.owner.id,org,sibling,humans.owner.role]);
 await admin.query("INSERT INTO hon.community_verifications(principal_id,organization_id,school_id,capacity,verified_at) VALUES($1,$2,$3,'OWNER',clock_timestamp()-interval '1 day')",[humans.owner.id,org,sibling]);
 const siblingContext=()=>c('owner',{schoolId:sibling});await svc.mutate(siblingContext(),'PROFILE',null,{expectedVersion:0,displayName:'Sibling owner alias',enabled:true});
 assert.equal((await svc.read(siblingContext(),'TOPIC',null,topic.id)).canEdit,false);await deny(()=>svc.history(siblingContext(),topic.id),404);await deny(()=>svc.mutate(siblingContext(),'CONTENT',topic.id,revise(topic)),404);
 // Atomic rollback after content/version append but before audit/receipt success.
 const beforeFailure=await snapshot(communityTables);
 await admin.query("CREATE FUNCTION hon.community_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_FAILURE'; END $$; CREATE TRIGGER community_fixture_failure BEFORE INSERT ON hon.community_events FOR EACH ROW EXECUTE FUNCTION hon.community_fixture_failure()");
 await deny(()=>svc.mutate(c(),'CONTENT',null,content()),503);
 await admin.query('DROP TRIGGER community_fixture_failure ON hon.community_events; DROP FUNCTION hon.community_fixture_failure()');assert.deepEqual(await snapshot(communityTables),beforeFailure);
 // Immutable roots/history and no hard-delete/truncate, including trusted direct DML.
 for(const t of communityTables.filter(t=>t!=='community_verifications')){await sqlDeny(()=>admin.query(`DELETE FROM hon.${t}`));await sqlDeny(()=>admin.query(`TRUNCATE hon.${t} CASCADE`));}
 assert.deepEqual(await snapshot(operationalTables),baseline,'Community must have zero operational/provider/payment/marketing/action/outbox/global-audit effects');
 assert(!JSON.stringify((await admin.query('SELECT to_jsonb(e) data FROM hon.community_events e')).rows).includes('Private human author reason'));
 for(const row of (await admin.query('SELECT response FROM hon.community_requests')).rows)assert(Object.keys(row.response).every(k=>['id','version'].includes(k)));
 // Real row FORCE-RLS proof, including a non-bypass table owner and row_security=off.
 for(const table of communityTables){assert(Number((await admin.query(`SELECT count(*) n FROM hon.${table}`)).rows[0].n)>0);execFileSync('sudo',['-u','postgres','psql','-d','hon_community_validation','-v','ON_ERROR_STOP=1'],{input:`BEGIN; CREATE ROLE hon_community_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; GRANT USAGE,CREATE ON SCHEMA hon TO hon_community_rls_probe; ALTER TABLE hon.${table} OWNER TO hon_community_rls_probe; SET LOCAL ROLE hon_community_rls_probe; DO $$ BEGIN IF (SELECT count(*) FROM hon.${table})<>0 THEN RAISE EXCEPTION 'RLS_LEAK'; END IF; BEGIN SET LOCAL row_security=off; PERFORM 1 FROM hon.${table}; RAISE EXCEPTION 'RLS_OFF_LEAK'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$; RESET ROLE; ROLLBACK;`,stdio:['pipe','pipe','pipe']});}
 const canonical=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_community_runtime');
 const js=()=>execFileSync('node',['scripts/verify-rls.mjs'],{cwd:new URL('../',import.meta.url),env:process.env,stdio:'pipe'});
 const sql=()=>execFileSync('sudo',['-u','postgres','psql','-d','hon_community_validation','-v','ON_ERROR_STOP=1'],{input:canonical,stdio:['pipe','pipe','pipe']});
 js();sql();
 const drifts=[
  ['table grant','GRANT SELECT ON hon.community_content TO hon_community_runtime','REVOKE SELECT ON hon.community_content FROM hon_community_runtime'],
  ['column grant','GRANT SELECT(body) ON hon.community_versions TO hon_community_runtime','REVOKE SELECT(body) ON hon.community_versions FROM hon_community_runtime'],
  ['PUBLIC execute','GRANT EXECUTE ON FUNCTION hon.read_community(text,text,uuid,uuid,uuid) TO PUBLIC','REVOKE EXECUTE ON FUNCTION hon.read_community(text,text,uuid,uuid,uuid) FROM PUBLIC'],
  ['helper execute','GRANT EXECUTE ON FUNCTION hon.community_projection(uuid,uuid,integer) TO hon_community_runtime','REVOKE EXECUTE ON FUNCTION hon.community_projection(uuid,uuid,integer) FROM hon_community_runtime'],
  ['grant option','GRANT EXECUTE ON FUNCTION hon.read_community_profile(text) TO hon_community_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION hon.read_community_profile(text) FROM hon_community_runtime'],
  ['search path','ALTER FUNCTION hon.mutate_community(text,text,uuid,jsonb,text,uuid) SET search_path=public,hon','ALTER FUNCTION hon.mutate_community(text,text,uuid,jsonb,text,uuid) SET search_path=pg_catalog,hon'],
  ['definer','ALTER FUNCTION hon.read_community(text,text,uuid,uuid,uuid) SECURITY INVOKER','ALTER FUNCTION hon.read_community(text,text,uuid,uuid,uuid) SECURITY DEFINER'],
  ['forced RLS','ALTER TABLE hon.community_versions NO FORCE ROW LEVEL SECURITY','ALTER TABLE hon.community_versions FORCE ROW LEVEL SECURITY'],
  ['RLS enable','ALTER TABLE hon.community_content DISABLE ROW LEVEL SECURITY','ALTER TABLE hon.community_content ENABLE ROW LEVEL SECURITY'],
  ['permissive policy','CREATE POLICY community_probe ON hon.community_versions USING(true)','DROP POLICY community_probe ON hon.community_versions'],
  ['immutable trigger','ALTER TABLE hon.community_versions DISABLE TRIGGER community_immutable','ALTER TABLE hon.community_versions ENABLE TRIGGER community_immutable'],
  ['truncate trigger','ALTER TABLE hon.community_requests DISABLE TRIGGER community_no_truncate','ALTER TABLE hon.community_requests ENABLE TRIGGER community_no_truncate'],
 ];
 for(const [name,drift,restore]of drifts){await admin.query(drift);try{assert.throws(js,`${name}: JS accepted drift`);assert.throws(sql,`${name}: canonical accepted drift`);console.log(`Denied community verifier drift: ${name}`);}finally{await admin.query('ROLLBACK');await admin.query(restore);}}
 topic=(await svc.mutate(c(),'CONTENT',topic.id,revise(topic,{status:'ARCHIVED',reason:'Human archive and retain history'}))).result;
 assert.equal((await svc.read(c(),'TOPIC',null,topic.id)).status,'ARCHIVED');await deny(()=>svc.read(c('other'),'TOPIC',null,topic.id),404);await deny(()=>svc.list(c('other'),'COMMENT',post.id),404);await deny(()=>svc.mutate(c(),'CONTENT',topic.id,revise(topic)),409);
 assert.deepEqual(await snapshot(operationalTables),baseline);await verifyCommunitySecurity(admin,'hon_community_runtime');
 console.log('Community integrity passed: exact human membership/verification/opt-in; private state/history; cross-school redacted published sharing; live revocation/replay; immutable optimistic lifecycle; atomic rollback; real-row FORCE-RLS; both 12-case drift verifiers; zero operational/provider/payment/marketing/execution effects.');
} finally {try{await cleanup();}finally{await database.onModuleDestroy();await runtime.end();await admin.end();}}
