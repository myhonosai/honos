import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { RuntimeDatabaseService } from '../../../apps/api/dist/foundation/runtime-database.service.js';
import { CommunityService } from '../../../apps/api/dist/community/community.service.js';
import { communityTables, communityFunctions, verifyCommunitySecurity } from './community-security.mjs';
import { MarketplaceService } from '../../../apps/api/dist/marketplace/marketplace.service.js';
import { marketplaceTables, marketplaceFunctions, verifyMarketplaceSecurity } from './marketplace-security.mjs';
for(const [key,role] of [['DATABASE_URL','hon_marketplace_owner'],['HON_RUNTIME_DATABASE_URL','hon_marketplace_runtime']]) {
 const u=new URL(process.env[key]??'');if(u.hostname!=='localhost'||u.port!=='5432'||u.pathname!=='/hon_marketplace_validation'||u.username!==role)throw new Error('Only exact disposable localhost marketplace database and roles allowed. Never remote URLs.');
}
const admin=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false}),runtime=new pg.Client({connectionString:process.env.HON_RUNTIME_DATABASE_URL,ssl:false});
const database=new RuntimeDatabaseService(),community=new CommunityService(database);
const org=randomUUID(),otherOrg=randomUUID(),school=randomUUID(),sibling=randomUUID(),otherSchool=randomUUID();
const humans=Object.fromEntries(['owner','operator','other','staff','parent','hq','inactive','future','expired','orgOnly','noPermission','wrongRoleSchool'].map(k=>[k,{id:randomUUID(),user:randomUUID(),role:randomUUID(),grant:randomUUID(),subject:`community-${k}-${randomUUID()}`,org:k==='other'?otherOrg:org,school:k==='other'?otherSchool:school}]));
const c=(who='owner',patch={})=>({organizationId:humans[who].org,schoolId:humans[who].school,principalId:humans[who].id,externalSubject:humans[who].subject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),...patch});
const deny=(work,status=403)=>assert.rejects(async()=>work(),e=>{assert.equal(e.getStatus?.(),status,e.stack);return true;});
const sqlDeny=(work,code='42501')=>assert.rejects(async()=>work(),e=>{assert.equal(e.code,code,e.stack);return true;});
async function direct(context,work){await runtime.query('BEGIN');try{for(const[k,v]of Object.entries({organization_id:context.organizationId,school_id:context.schoolId,principal_id:context.principalId,principal_type:context.principalType,source:context.source,request_id:context.requestId,action_request_id:context.actionRequestId??'',delegated_by_principal_id:context.delegatedByPrincipalId??''}))await runtime.query('SELECT set_config($1,$2,true)',[`app.hon_${k}`,v]);const r=await work();await runtime.query('COMMIT');return r;}catch(e){await runtime.query('ROLLBACK');throw e;}}
async function snapshot(tables){const data={};for(const t of tables)data[t]=(await admin.query(`SELECT to_jsonb(t) record FROM hon.${t} t ORDER BY to_jsonb(t)::text`)).rows;return data;}
async function cleanup(){await admin.query('ROLLBACK');await admin.query('DROP TRIGGER IF EXISTS marketplace_fixture_failure ON hon.marketplace_events; DROP FUNCTION IF EXISTS hon.marketplace_fixture_failure()');await admin.query('BEGIN');try{
 for(const t of marketplaceTables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
 for(const t of ['marketplace_outbox','marketplace_events','marketplace_requests','marketplace_selections','marketplace_curations','marketplace_versions','marketplace_assets'])await admin.query(`DELETE FROM hon.${t}`);
 for(const t of marketplaceTables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
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
 await verifyCommunitySecurity(admin,'hon_marketplace_runtime');
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
  for(const permission of ['crm.lead.read',...(who==='noPermission'?[]:['community.participate','community.organization.manage','marketplace.asset.read','marketplace.asset.manage','marketplace.selection.save'])])await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[h.role,h.org,permission]);
  if(who!=='orgOnly') await admin.query("INSERT INTO hon.principal_role_grants(id,principal_id,organization_id,school_id,role_id,granted_by_principal_id,effective_from,effective_until) VALUES($1,$2,$3,$4,$5,$2,clock_timestamp()+$6::interval,CASE WHEN $7 THEN clock_timestamp()-interval '1 hour' ELSE NULL END)",[h.grant,h.id,h.org,who==='orgOnly'?null:h.school,h.role,who==='future'?'1 day':'-2 days',who==='expired']);
  if(who!=='staff')await admin.query("INSERT INTO hon.community_verifications(principal_id,organization_id,school_id,capacity,verified_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[h.id,h.org,h.school,who==='operator'?'OPERATOR':'OWNER']);
 }
 await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')",[humans.hq.id]);
 await admin.query('COMMIT');
 for(const who of ['staff','parent','hq','inactive','future','expired','orgOnly','noPermission','wrongRoleSchool']) {
  assert.equal(await database.resolveCommunityScope(humans[who].subject,humans[who].school),undefined,who);
  await deny(()=>community.profile(c(who)));await deny(()=>community.list(c(who),'TOPIC',null));
 }
 assert.equal(await database.resolveCommunityScope(humans.owner.subject,sibling),undefined);
 await deny(()=>community.profile(c('owner',{schoolId:sibling})));await deny(()=>community.profile(c('owner',{organizationId:otherOrg,schoolId:otherSchool})));
 await deny(()=>community.profile(c('owner',{principalId:humans.other.id})));await deny(()=>community.profile(c('owner',{externalSubject:humans.other.subject})));
 for(const patch of [{source:'AI_TOOL'},{source:'PUBLIC_API'},{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]) {
  await deny(()=>community.profile(c('owner',patch))); const ctx=c('owner',patch);
  await sqlDeny(()=>direct(ctx,()=>runtime.query('SELECT hon.read_community_profile($1)',[ctx.externalSubject])));
 }
 await sqlDeny(()=>admin.query('INSERT INTO hon.principal_role_grants(principal_id,organization_id,school_id,role_id,granted_by_principal_id) VALUES($1,$2,NULL,$3,$1)',[humans.owner.id,org,humans.owner.role]),'23502');
 assert.equal((await community.profile(c())).organizationEnabled,false);await deny(()=>community.list(c(),'TOPIC',null));
 await community.mutate(c(),'CONSENT',null,{expectedVersion:0,enabled:true});
 await community.mutate(c('other'),'CONSENT',null,{expectedVersion:0,enabled:true});
 for(const who of ['owner','operator','other'])await community.mutate(c(who),'PROFILE',null,{expectedVersion:0,displayName:who==='owner'?'Owner alias':who==='operator'?'Operator alias':'Other owner alias',enabled:true});
 const svc=new MarketplaceService(database);

 const input=(patch={})=>({expectedVersion:0,title:'General owner planning blueprint',category:'OPERATIONS',assetKind:'BLUEPRINT',targetModule:'WORK_ITEMS',requiredPermissions:['work_item.read'],releaseNotes:'Initial descriptive release',previewText:'A general weekly planning checklist for an owner to consider.',status:'DRAFT',...patch});
 const revision=(r,patch={})=>{const{id,version,...fields}=r;return{expectedVersion:version,...fields,...patch};};
 const list=async(who='owner',mode='BROWSE',after=null)=>(await svc.read(c(who),mode,null,after));
 const selection=(a)=>({expectedVersion:0,assetVersion:a.version});
 const curate=async(a,decision='APPROVED')=>admin.query('SELECT hon.review_marketplace_asset($1,$2,$3)',[a.id,a.version,decision]);
 await verifyMarketplaceSecurity(admin,'hon_marketplace_runtime');
 for(const t of marketplaceTables){assert.equal((await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') allowed",[`hon.${t}`])).rows[0].allowed,false);await sqlDeny(()=>runtime.query(`SELECT * FROM hon.${t}`));}
 for(const[signature,allowed]of marketplaceFunctions)assert.equal((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",[signature])).rows[0].allowed,allowed,signature);
 await sqlDeny(()=>runtime.query('SELECT hon.review_marketplace_asset($1,1,\'APPROVED\')',[randomUUID()]));
 for(const who of ['staff','parent','hq','inactive','future','expired','orgOnly','noPermission','wrongRoleSchool']){
  assert.equal(await database.resolveMarketplaceScope(humans[who].subject,humans[who].school),undefined,who);
  await deny(()=>svc.read(c(who),'ACCESS'));await deny(()=>svc.read(c(who),'BROWSE'));await deny(()=>svc.mutate(c(who),'ASSET',null,input()));
 }
 for(const patch of [{source:'AI_TOOL'},{source:'PUBLIC_API'},{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]){
  await deny(()=>svc.read(c('owner',patch),'BROWSE'));const ctx=c('owner',patch);await sqlDeny(()=>direct(ctx,()=>runtime.query("SELECT hon.read_marketplace($1,'BROWSE')",[ctx.externalSubject])));
 }
 await deny(()=>svc.read(c('owner',{principalId:humans.other.id}),'BROWSE'));await deny(()=>svc.read(c('owner',{externalSubject:humans.other.subject}),'BROWSE'));
 await deny(()=>svc.read(c('owner',{organizationId:otherOrg,schoolId:otherSchool}),'BROWSE'));await deny(()=>svc.read(c('owner',{schoolId:sibling}),'BROWSE'));
 assert.deepEqual(await svc.read(c('operator'),'ACCESS'),{canBrowse:false,canCreate:true,canSave:false,executionAllowed:false});
 await deny(()=>svc.read(c('operator'),'BROWSE'));await deny(()=>svc.read(c('operator'),'SAVED'));
 const operationalTables=(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='hon' AND tablename NOT LIKE 'marketplace_%' AND tablename NOT LIKE 'community_%' AND tablename NOT IN('principal_role_grants','role_permissions','roles','organization_entitlements','principals') ORDER BY tablename")).rows.map(x=>x.tablename);
 const baseline=await snapshot(operationalTables);
 const createContext=c();let a=(await svc.mutate(createContext,'ASSET',null,input())).result;
 assert.equal(a.status,'DRAFT');assert.equal((await list('other')).items.length,0);
 await deny(()=>svc.read(c('other'),'OWN',a.id),404);await deny(()=>svc.read(c('other'),'BROWSE',a.id),404);await deny(()=>svc.read(c('other'),'HISTORY',a.id),404);
 await deny(()=>svc.mutate(c('other'),'ASSET',a.id,revision(a)),404);
 assert.equal((await svc.mutate(createContext,'ASSET',null,input())).replayed,true);
 await deny(()=>svc.mutate(createContext,'ASSET',null,input({title:'Changed title'})),409);
 const invalidPatches=[{attachments:[]},{url:'https://example.test'},{studentId:randomUUID()},{customerId:randomUUID()},{credential:'hidden'},{code:'anything'},{config:{}},{price:10},{provider:'fake'},{action:'apply'},{requiredPermissions:['action.execute']},{requiredPermissions:[]},{requiredPermissions:['work_item.read','work_item.read']},{requiredPermissions:[{}]},{title:'secret'},{previewText:'example.com'},{previewText:'a@school.test'},{previewText:'+1 800 555 1234'},{previewText:'https://example.test'},{previewText:'file:///private'},{previewText:'www.school.test'},{previewText:'<b>private</b>'},{previewText:'{"script":"apply"}'},{previewText:'function apply()'},{previewText:'curl endpoint'},{previewText:'password abc'},{previewText:'let x = 1;'},{previewText:'invisible\u200btext'},{previewText:'x'.repeat(1601)},{releaseNotes:'x'.repeat(401)},{targetModule:'AI'},{status:'INSTALLED'}];
 for(const patch of invalidPatches){await deny(()=>svc.mutate(c(),'ASSET',null,input(patch)),400);const ctx=c();await sqlDeny(()=>direct(ctx,()=>runtime.query("SELECT hon.mutate_marketplace($1,'ASSET',NULL,$2::jsonb,$3,$4::uuid)",[ctx.externalSubject,JSON.stringify(input(patch)),ctx.idempotencyKey,ctx.requestId])),'22023');}
 a=(await svc.mutate(c(),'ASSET',a.id,revision(a,{status:'PUBLISHED'}))).result;
 assert.equal((await list('other')).items.length,0,'Publishing alone not curated');
 await deny(()=>svc.mutate(c('other'),'SAVE',a.id,selection(a)),404);
 await curate(a);const published=await svc.read(c('other'),'BROWSE',a.id);assert.deepEqual(published,a);
 const text=JSON.stringify(published);for(const marker of ['PRIVATE',org,school,humans.owner.id,humans.owner.user,'displayName','externalSubject','organizationId','schoolId','principalId','email','body','provider','payment','credential'])assert(!text.includes(marker),marker);
 await deny(()=>svc.mutate(c('operator'),'SAVE',a.id,selection(a)));
 const saveContext=c('other');const saved=(await svc.mutate(saveContext,'SAVE',a.id,selection(a))).result;
 assert.equal(saved.status,'REQUIRES_REVIEW');assert.equal(saved.enabled,false);assert.equal(saved.version,1);assert.deepEqual(saved.asset,a);
 assert.equal((await svc.mutate(saveContext,'SAVE',a.id,selection(a))).replayed,true);
 assert.equal((await svc.mutate(c('other'),'SAVE',a.id,selection(a))).result.id,saved.id,'Duplicate selection shares row');
 assert.equal((await list('owner','SAVED')).items.length,0);assert.equal((await list('other','SAVED')).items.length,1);
 await deny(()=>svc.mutate(c('other'),'SAVE',a.id,{...selection(a),enabled:true}),400);
 await sqlDeny(()=>admin.query('UPDATE hon.marketplace_selections SET enabled=true WHERE id=$1',[saved.id]));
 await deny(()=>svc.mutate(c(),'ASSET',a.id,revision(a,{status:'DRAFT'})),409);
 await deny(()=>svc.mutate(c(),'ASSET',a.id,revision(a,{expectedVersion:1})),409);
 await deny(()=>svc.mutate(c(),'ASSET',a.id,revision(a,{status:'ARCHIVED',previewText:'Changed metadata'})),409);
 a=(await svc.mutate(c(),'ASSET',a.id,revision(a,{releaseNotes:'Second human descriptive release'}))).result;
 assert.equal((await list('other')).items.length,0,'New published version needs fresh exact curation');
 assert.equal((await list('other','SAVED')).items[0].asset,null);
 await deny(()=>svc.mutate(saveContext,'SAVE',a.id,{expectedVersion:0,assetVersion:2}),404);
 await curate(a);assert.equal((await list('other')).items[0].version,a.version);
 assert.equal((await list('other','SAVED')).items[0].asset,null,'Old saved version never silently upgraded');
 const newSave=c('other');const newer=(await svc.mutate(newSave,'SAVE',a.id,selection(a))).result;
 await curate(a,'REVOKED');assert.equal((await list('other')).items.length,0);await deny(()=>svc.mutate(newSave,'SAVE',a.id,selection(a)),404);
 await curate(a);assert.equal((await list('other','SAVED')).items.find(x=>x.id===newer.id).asset.version,a.version);
 let operatorAsset=(await svc.mutate(c('operator'),'ASSET',null,input({title:'General operator blueprint'}))).result;
 operatorAsset=(await svc.mutate(c('operator'),'ASSET',operatorAsset.id,revision(operatorAsset,{status:'PUBLISHED'}))).result;
 await curate(operatorAsset);assert((await list('other')).items.some(x=>x.id===operatorAsset.id));
 await deny(()=>svc.read(c('owner'),'HISTORY',operatorAsset.id),404);
 const history=await svc.read(c(),'HISTORY',a.id);assert.equal(history.items.length,3);assert.deepEqual(Object.keys(history.items[0]).sort(),['status','version']);
 // Verification, grant, membership, creator permission and entitlement revocations precede reads/replay.
 const changes=[
  ['verification',"UPDATE hon.community_verifications SET revoked_at=clock_timestamp() WHERE principal_id=$1","UPDATE hon.community_verifications SET revoked_at=NULL WHERE principal_id=$1"],
  ['expiry',"UPDATE hon.community_verifications SET effective_until=clock_timestamp()-interval '1 hour' WHERE principal_id=$1","UPDATE hon.community_verifications SET effective_until=NULL WHERE principal_id=$1"],
  ['grant',"UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$1 WHERE principal_id=$1","UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE principal_id=$1"],
  ['inactive',"UPDATE hon.principals SET is_active=false WHERE id=$1","UPDATE hon.principals SET is_active=true WHERE id=$1"],
 ];
 for(const[name,change,restore]of changes){await admin.query(change,[humans.owner.id]);try{await deny(()=>svc.read(c(),'BROWSE'));await deny(()=>svc.mutate(createContext,'ASSET',null,input()));assert(!(await list('other')).items.some(x=>x.id===a.id),name);assert.equal((await list('other','SAVED')).items.find(x=>x.id===newer.id).asset,null);await deny(()=>svc.mutate(newSave,'SAVE',a.id,selection(a)),404);}finally{await admin.query(restore,[humans.owner.id]);}}
 for(const permission of ['marketplace.asset.manage','community.participate']){
  await admin.query('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2',[humans.owner.role,permission]);
  assert(!(await list('other')).items.some(x=>x.id===a.id));await deny(()=>svc.mutate(createContext,'ASSET',null,input()));
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[humans.owner.role,org,permission]);
 }
 await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='marketplace.selection.save'",[humans.other.role]);await deny(()=>svc.mutate(newSave,'SAVE',a.id,selection(a)));await deny(()=>svc.read(c('other'),'SAVED'));
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'marketplace.selection.save')",[humans.other.role,otherOrg]);
 await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='marketplace.asset.read'",[humans.other.role]);await deny(()=>svc.mutate(newSave,'SAVE',a.id,selection(a)));assert((await list('other','SAVED')).items.every(x=>x.asset===null));
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'marketplace.asset.read')",[humans.other.role,otherOrg]);
 await community.mutate(c(),'PROFILE',null,{expectedVersion:1,displayName:'Owner alias',enabled:false});assert(!(await list('other')).items.some(x=>x.id===a.id));await deny(()=>svc.mutate(createContext,'ASSET',null,input()));
 await community.mutate(c(),'PROFILE',null,{expectedVersion:2,displayName:'Owner alias',enabled:true});
 await community.mutate(c(),'CONSENT',null,{expectedVersion:1,enabled:false});await deny(()=>svc.read(c(),'BROWSE'));assert(!(await list('other')).items.some(x=>x.id===a.id));
 await community.mutate(c(),'CONSENT',null,{expectedVersion:2,enabled:true});
 await community.mutate(c('other'),'PROFILE',null,{expectedVersion:1,displayName:'Other alias',enabled:false});await deny(()=>svc.mutate(newSave,'SAVE',a.id,selection(a)));await deny(()=>svc.read(c('other'),'SAVED'));
 await community.mutate(c('other'),'PROFILE',null,{expectedVersion:2,displayName:'Other alias',enabled:true});
 await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[org]);assert(!(await list('other')).items.some(x=>x.id===a.id));await deny(()=>svc.read(c(),'BROWSE'));
 await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[org]);
 // Live creator-grant lock wait: the viewer must not get a stale safe projection after revocation commits.
 await admin.query('BEGIN');await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$1 WHERE id=$2',[humans.owner.id,humans.owner.grant]);
 const waiting=svc.read(c('other'),'BROWSE',a.id).then(()=>({allowed:true}),e=>({status:e.getStatus?.()}));let blocked=false;
 for(let i=0;i<100;i++){if((await admin.query("SELECT 1 FROM pg_stat_activity WHERE usename='hon_marketplace_runtime' AND wait_event_type='Lock'")).rows.length){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
 assert(blocked,'Expected real creator lock wait');await admin.query('COMMIT');assert.equal((await waiting).status,404);
 await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[humans.owner.grant]);
 // Exact school creator ownership, even for the same verified principal.
 await admin.query('INSERT INTO hon.principal_role_grants(principal_id,organization_id,school_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$1)',[humans.owner.id,org,sibling,humans.owner.role]);
 await admin.query("INSERT INTO hon.community_verifications(principal_id,organization_id,school_id,capacity,verified_at) VALUES($1,$2,$3,'OWNER',clock_timestamp()-interval '1 day')",[humans.owner.id,org,sibling]);
 await community.mutate(c('owner',{schoolId:sibling}),'PROFILE',null,{expectedVersion:0,displayName:'Sibling alias',enabled:true});
 await deny(()=>svc.read(c('owner',{schoolId:sibling}),'OWN',a.id),404);await deny(()=>svc.read(c('owner',{schoolId:sibling}),'HISTORY',a.id),404);await deny(()=>svc.mutate(c('owner',{schoolId:sibling}),'ASSET',a.id,revision(a)),404);
 assert.equal((await svc.read(c('owner',{schoolId:sibling}),'SAVED')).items.length,0);
 // Concurrent identical writes produce one release and one replay; stale concurrent versions conflict.
 const concurrent=c();const results=await Promise.all([svc.mutate(concurrent,'ASSET',null,input()),svc.mutate(concurrent,'ASSET',null,input())]);assert.deepEqual(results.map(x=>x.replayed).sort(),[false,true]);assert.equal(results[0].result.id,results[1].result.id);
 const competing=await Promise.allSettled([svc.mutate(c(),'ASSET',a.id,revision(a)),svc.mutate(c(),'ASSET',a.id,revision(a))]);assert.equal(competing.filter(x=>x.status==='fulfilled').length,1);assert.equal(competing.find(x=>x.status==='rejected').reason.getStatus(),409);
 a=(await svc.read(c(),'OWN',a.id));await curate(a);
 // Real bounded pages and history, no cached public drafts.
 for(let i=0;i<31;i++)await svc.mutate(c(),'ASSET',null,input());const first=await list('owner','OWN');assert.equal(first.items.length,30);assert.equal(first.nextAfter,first.items[29].id);const second=await list('owner','OWN',first.nextAfter);assert(second.items.every(x=>x.id>first.nextAfter));
 let draft=results[0].result;for(let i=0;i<31;i++)draft=(await svc.mutate(c(),'ASSET',draft.id,revision(draft))).result;const h=await svc.read(c(),'HISTORY',draft.id);assert.equal(h.items.length,30);assert.equal(h.nextBefore,h.items[29].version);assert.equal((await svc.read(c(),'HISTORY',draft.id,null,h.nextBefore)).items.length,2);
 // Atomic event failure rolls back release, audit, inert outbox and receipt.
 const beforeFailure=await snapshot(marketplaceTables);await admin.query("CREATE FUNCTION hon.marketplace_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$; CREATE TRIGGER marketplace_fixture_failure BEFORE INSERT ON hon.marketplace_events FOR EACH ROW EXECUTE FUNCTION hon.marketplace_fixture_failure()");
 await deny(()=>svc.mutate(c(),'ASSET',null,input()),503);assert.deepEqual(await snapshot(marketplaceTables),beforeFailure);await admin.query('DROP TRIGGER marketplace_fixture_failure ON hon.marketplace_events; DROP FUNCTION hon.marketplace_fixture_failure()');
 a=(await svc.mutate(c(),'ASSET',a.id,revision(a,{status:'ARCHIVED'}))).result;assert(!(await list('other')).items.some(x=>x.id===a.id));await deny(()=>svc.mutate(c(),'ASSET',a.id,revision(a)),409);await deny(()=>svc.read(c('other'),'BROWSE',a.id),404);assert((await list('other','SAVED')).items.filter(x=>x.assetId===a.id).every(x=>x.asset===null));
 // FORCE RLS proof with an actual nonempty table, including same scope and table owner.
 await admin.query('GRANT SELECT ON hon.marketplace_versions TO hon_marketplace_runtime');assert.equal((await runtime.query('SELECT * FROM hon.marketplace_versions')).rows.length,0);await admin.query('REVOKE SELECT ON hon.marketplace_versions FROM hon_marketplace_runtime');
 await admin.query('CREATE ROLE marketplace_rls_probe NOSUPERUSER NOBYPASSRLS NOLOGIN; GRANT USAGE ON SCHEMA hon TO marketplace_rls_probe; ALTER TABLE hon.marketplace_versions OWNER TO marketplace_rls_probe');await admin.query('SET ROLE marketplace_rls_probe');assert.equal((await admin.query('SELECT * FROM hon.marketplace_versions')).rows.length,0);await admin.query('RESET ROLE; ALTER TABLE hon.marketplace_versions OWNER TO hon_marketplace_owner; DROP OWNED BY marketplace_rls_probe; DROP ROLE marketplace_rls_probe');
 const canonical=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_marketplace_runtime');
 const sql=()=>execFileSync('sudo',['-u','postgres','psql','-d','hon_marketplace_validation','-v','ON_ERROR_STOP=1'],{input:canonical,stdio:['pipe','pipe','pipe']});
 const js=()=>execFileSync('node',['scripts/verify-rls.mjs'],{env:process.env,stdio:['pipe','pipe','pipe']});sql();js();
 const drifts=[
  ['disabled constraint','ALTER TABLE hon.marketplace_selections DROP CONSTRAINT marketplace_selections_enabled_check','ALTER TABLE hon.marketplace_selections ADD CONSTRAINT marketplace_selections_enabled_check CHECK(NOT enabled)'],
  ['inert outbox constraint','ALTER TABLE hon.marketplace_outbox DROP CONSTRAINT marketplace_outbox_status_check',"ALTER TABLE hon.marketplace_outbox ADD CONSTRAINT marketplace_outbox_status_check CHECK(status='INERT')"],
  ['table SELECT','GRANT SELECT ON hon.marketplace_versions TO hon_marketplace_runtime','REVOKE SELECT ON hon.marketplace_versions FROM hon_marketplace_runtime'],
  ['column SELECT','GRANT SELECT(preview_text) ON hon.marketplace_versions TO hon_marketplace_runtime','REVOKE SELECT(preview_text) ON hon.marketplace_versions FROM hon_marketplace_runtime'],
  ['PUBLIC execute','GRANT EXECUTE ON FUNCTION hon.read_marketplace(text,text,uuid,uuid,integer) TO PUBLIC','REVOKE EXECUTE ON FUNCTION hon.read_marketplace(text,text,uuid,uuid,integer) FROM PUBLIC'],
  ['curator execute','GRANT EXECUTE ON FUNCTION hon.review_marketplace_asset(uuid,integer,text) TO hon_marketplace_runtime','REVOKE EXECUTE ON FUNCTION hon.review_marketplace_asset(uuid,integer,text) FROM hon_marketplace_runtime'],
  ['helper execute','GRANT EXECUTE ON FUNCTION hon.marketplace_projection(uuid,integer) TO hon_marketplace_runtime','REVOKE EXECUTE ON FUNCTION hon.marketplace_projection(uuid,integer) FROM hon_marketplace_runtime'],
  ['grant option','GRANT EXECUTE ON FUNCTION hon.resolve_marketplace_scope(text,uuid) TO hon_marketplace_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION hon.resolve_marketplace_scope(text,uuid) FROM hon_marketplace_runtime'],
  ['search path','ALTER FUNCTION hon.mutate_marketplace(text,text,uuid,jsonb,text,uuid) SET search_path=public,hon','ALTER FUNCTION hon.mutate_marketplace(text,text,uuid,jsonb,text,uuid) SET search_path=pg_catalog,hon'],
  ['definer','ALTER FUNCTION hon.read_marketplace(text,text,uuid,uuid,integer) SECURITY INVOKER','ALTER FUNCTION hon.read_marketplace(text,text,uuid,uuid,integer) SECURITY DEFINER'],
  ['FORCE RLS','ALTER TABLE hon.marketplace_versions NO FORCE ROW LEVEL SECURITY','ALTER TABLE hon.marketplace_versions FORCE ROW LEVEL SECURITY'],
  ['RLS enabled','ALTER TABLE hon.marketplace_assets DISABLE ROW LEVEL SECURITY','ALTER TABLE hon.marketplace_assets ENABLE ROW LEVEL SECURITY'],
  ['permissive policy','CREATE POLICY marketplace_probe ON hon.marketplace_versions USING(true)','DROP POLICY marketplace_probe ON hon.marketplace_versions'],
  ['immutable trigger','ALTER TABLE hon.marketplace_versions DISABLE TRIGGER marketplace_immutable','ALTER TABLE hon.marketplace_versions ENABLE TRIGGER marketplace_immutable'],
  ['truncate trigger','ALTER TABLE hon.marketplace_requests DISABLE TRIGGER marketplace_no_truncate','ALTER TABLE hon.marketplace_requests ENABLE TRIGGER marketplace_no_truncate'],
 ];
 for(const[name,drift,restore]of drifts){await admin.query(drift);try{assert.throws(js,`${name}: JS accepted drift`);assert.throws(sql,`${name}: canonical accepted drift`);console.log(`Denied marketplace drift: ${name}`);}finally{await admin.query('ROLLBACK');await admin.query(restore);}}
 assert.deepEqual(await snapshot(operationalTables),baseline,'No configuration/domain/public/provider/purchase/action effects');
 assert.equal((await admin.query("SELECT count(*) n FROM hon.marketplace_outbox WHERE status<>'INERT' OR execution_allowed")).rows[0].n,'0');
 assert.equal((await admin.query('SELECT count(*) n FROM hon.marketplace_outbox')).rows[0].n,(await admin.query('SELECT count(*) n FROM hon.marketplace_events')).rows[0].n);
 await verifyMarketplaceSecurity(admin,'hon_marketplace_runtime');
 console.log('Marketplace integrity passed: exact verified human permissions/opt-in; version-bound manual curation; minimal redacted sharing; owner-only disabled school selections; creator-private history; live revocation/replay/lock waits; concurrency/versioning/rollback; actual-row FORCE RLS; dual 15-case drift verifiers; zero config/domain/public/purchase/provider/Action Engine effects.');
}finally{await cleanup();await database.onModuleDestroy();await Promise.all([admin.end(),runtime.end()]);}
