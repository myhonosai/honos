import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { DocumentService } from '../../../apps/api/dist/documents/document.service.js';
import { DocumentController } from '../../../apps/api/dist/documents/document.controller.js';
import { ParentDocumentController } from '../../../apps/api/dist/documents/parent-document.controller.js';
import { RuntimeDatabaseService } from '../../../apps/api/dist/foundation/runtime-database.service.js';
import { DOCUMENT_COMMAND_REGISTRY } from '../../config/dist/index.js';
import { actionDefinition } from '../../domain/dist/index.js';
if (!process.env.DATABASE_URL || !process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Admin and restricted runtime URLs required.');
const opts = connectionString => ({ connectionString, ssl:connectionString.includes('localhost')?false:{rejectUnauthorized:false} });
const admin=new pg.Client(opts(process.env.DATABASE_URL)), runtime=new pg.Client(opts(process.env.HON_RUNTIME_DATABASE_URL));
const db=new RuntimeDatabaseService(), svc=new DocumentService(db), staff=new DocumentController(db,svc), parent=new ParentDocumentController(db,svc);
const ids=Object.fromEntries(['org','otherOrg','school','sibling','otherSchool','owner','weak','reader','family','otherFamily','foreignFamily'].map(k=>[k,randomUUID()]));
const humans=Object.fromEntries(['staff','weak','reader','parent','otherParent','coParent','viewer','outsider'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`doc-${k}-${randomUUID()}`} ]));
const orgs=[ids.org,ids.otherOrg]; const tables=['document_templates','document_versions','document_publications','document_acknowledgements','document_command_requests'];
const c=(who='staff',school=ids.school,key=randomUUID())=>({organizationId:school===ids.otherSchool?ids.otherOrg:ids.org,schoolId:school,principalId:humans[who].id,externalSubject:humans[who].subject,principalType:'HUMAN_USER',source:'HUMAN_UI',audienceMode:['parent','otherParent','coParent','viewer'].includes(who)?'PARENT':'STAFF',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:key});
const deny=(fn,status=403)=>assert.rejects(async()=>fn(),e=>{assert.equal(e.getStatus(),status);return true;});
const sqlDeny=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code);return true;});
const count=async t=>Number((await admin.query(`SELECT count(*) n FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs])).rows[0].n);
const body=(audience='STAFF',familyId=ids.family)=>({title:'Safety acknowledgement',content:'Read the safety rules.\nThis is internal evidence only.',audience,...(audience==='PARENT'?{familyId}:{})});
const publish=async t=>(await svc.publish(c(),t.id,{versionId:t.versionId,expectedVersion:t.version})).record;
const ack=t=>({contentHash:t.contentHash,choice:'ACKNOWLEDGE',attestationText:'I have read this document.'});
let trigger=false;
async function cleanup(){
 await admin.query('ROLLBACK');
 if(trigger){await admin.query('DROP TRIGGER IF EXISTS document_fixture_failure ON hon.outbox_events');await admin.query('DROP FUNCTION IF EXISTS hon.document_fixture_failure()');}
 await admin.query('BEGIN');
 try{
  // Test-only privileged fixture cleanup. No production delete API or grants.
  for(const t of tables) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('UPDATE hon.document_templates SET current_publication_id=NULL WHERE organization_id=ANY($1::uuid[])',[orgs]);
  for(const t of ['document_command_requests','document_acknowledgements','document_publications','document_versions','document_templates','outbox_delivery_attempts','outbox_events','audit_events','idempotency_records','family_access_grants','families','principal_role_grants','organization_entitlements','roles']) await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs]);
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of tables) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
  await admin.query('DELETE FROM hon.schools WHERE organization_id=ANY($1::uuid[])',[orgs]);await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs]);await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
await Promise.all([admin.connect(),runtime.connect()]);
try{
 for(const t of [...tables,'users','principals','roles','role_permissions','family_access_grants']){
  assert.equal((await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') p",[`hon.${t}`])).rows[0].p,false);
  await sqlDeny(()=>runtime.query(`SELECT * FROM hon.${t}`));
 }
 for(const signature of ['hon.guard_document_immutability()','hon.require_document_actor(text,text,text,uuid,boolean)','hon.document_family_authorized(text,uuid,boolean)']) assert.equal((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') p",[signature])).rows[0].p,false);
 assert.equal((await admin.query("SELECT count(*) n FROM hon.permissions WHERE code LIKE 'document.%' AND is_sensitive AND is_staff_assignable")).rows[0].n,'6');
 for(const command of DOCUMENT_COMMAND_REGISTRY){assert.equal(command.execution,'HUMAN_ONLY');assert.equal(command.minimumTier,'ESSENTIAL');assert.equal(actionDefinition(command.code),undefined);}
 await admin.query('BEGIN');
 for(const org of orgs)await admin.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)',[org,'Document fixture']);
 for(const [school,org] of [[ids.school,ids.org],[ids.sibling,ids.org],[ids.otherSchool,ids.otherOrg]])await admin.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1::uuid,$2,$3,$1::text)',[school,org,'School fixture']);
 for(const h of Object.values(humans)){await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)',[h.user,h.subject,`${h.user}@example.test`,'PRIVATE_DIRECTORY']);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY')",[h.id,h.user]);}
 for(const [role,code] of [[ids.owner,'OWNER'],[ids.weak,'AUTHOR_ONLY'],[ids.reader,'READER_ONLY']])await admin.query('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,$4)',[role,ids.org,code,role===ids.owner]);
 await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions',[ids.owner,ids.org]);
 for(const [role,perm] of [[ids.weak,'document.template.create'],[ids.weak,'document.template.version'],[ids.reader,'document.read']])await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[role,ids.org,perm]);
 for(const [who,role] of [['staff',ids.owner],['weak',ids.weak],['reader',ids.reader]])await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')",[ids.org,ids.school,humans[who].id,role]);
 for(const [family,org,school] of [[ids.family,ids.org,ids.school],[ids.otherFamily,ids.org,ids.school],[ids.foreignFamily,ids.otherOrg,ids.otherSchool]])await admin.query('INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,$4)',[family,org,school,'PRIVATE_FAMILY']);
 for(const [who,family,level] of [['parent',ids.family,'PRIMARY_GUARDIAN'],['coParent',ids.family,'SECONDARY_GUARDIAN'],['otherParent',ids.otherFamily,'PRIMARY_GUARDIAN'],['viewer',ids.family,'VIEWER']])await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '1 day')",[ids.org,ids.school,family,humans[who].id,level,humans.staff.id]);
 await admin.query('COMMIT');
 const prohibited=['communication_messages','communication_consents','payment_attempts','invoices','memberships','people','action_requests','action_approvals','ai_usage_ledger','ai_invocation_plans','work_items'];
 const before=Object.fromEntries(await Promise.all(prohibited.map(async t=>[t,await count(t)])));
 const createContext=c(); const template=(await svc.create(createContext,body())).record;
 assert.equal(template.version,1);assert.equal(template.currentPublicationId,null);
 assert.equal(template.contentHash,createHash('sha256').update(template.title+'\n'+template.content).digest('hex'));
 assert((await svc.create(createContext,body())).replayed);await deny(()=>svc.create(createContext,{...body(),title:'changed'}),409);
 const draft=(await svc.create(c(),body('PARENT'))).record;
 const otherDraft=(await svc.create(c(),body('PARENT',ids.otherFamily))).record;
 await deny(()=>svc.create(c(),body('PARENT',ids.foreignFamily)));
 await deny(()=>svc.create(c(),{...body(),audience:'STUDENT'}),400);
 await deny(()=>svc.create(c('parent'),body()));
 for(const source of ['AI','AUTOMATION','INTEGRATION','PUBLIC_API','MIGRATION'])await deny(()=>svc.create({...c(),source},body()));
 for(const principalType of ['AI_EMPLOYEE','AUTOMATION','INTEGRATION','SYSTEM_SERVICE'])await deny(()=>svc.create({...c(),principalType},body()));
 await deny(()=>svc.publish({...c(),actionRequestId:randomUUID()},template.id,{versionId:template.versionId,expectedVersion:1}));
 await deny(()=>svc.publish({...c(),delegatedByPrincipalId:humans.parent.id},template.id,{versionId:template.versionId,expectedVersion:1}));
 await deny(()=>svc.create(c('outsider'),body()));await deny(()=>svc.create({...c(),externalSubject:humans.weak.subject},body()));
 await deny(()=>svc.create(c('staff',ids.sibling),body()));await deny(()=>svc.create(c('staff',ids.otherSchool),body()));
 await deny(()=>staff.create(ids.otherOrg,ids.school,randomUUID(),body(),{honIdentity:{externalSubject:humans.staff.subject}}));
 await deny(()=>parent.list(ids.school,{honIdentity:{externalSubject:humans.staff.subject}}));
 assert.deepEqual(await svc.read(c('parent'),'LIST',null),[]);
 await deny(()=>svc.read(c('parent'),'TEMPLATE',draft.id),400);
 await deny(()=>svc.publish(c('weak'),template.id,{versionId:template.versionId,expectedVersion:1}));
 await deny(()=>svc.publish(c(),template.id,{versionId:draft.versionId,expectedVersion:1}),404);
 await deny(()=>svc.publish(c(),template.id,{versionId:template.versionId,expectedVersion:2}),409);
 const published=await publish(template), pPublished=await publish(draft), otherPublished=await publish(otherDraft);
 const pId=pPublished.currentPublicationId;
 const parentList=await svc.read(c('parent'),'LIST',null);assert.equal(parentList.length,1);assert.equal(parentList[0].id,pId);assert(!('familyId' in parentList[0]));assert(!('signerPrincipalId' in parentList[0]));
 await deny(()=>svc.read(c('parent'),'PUBLICATION',published.currentPublicationId),404);
 await deny(()=>svc.read(c('parent'),'PUBLICATION',otherPublished.currentPublicationId),404);
 await deny(()=>svc.acknowledge(c('parent'),published.currentPublicationId,ack(published)),404);
 await deny(()=>svc.acknowledge(c('parent'),otherPublished.currentPublicationId,ack(otherPublished)));
 await deny(()=>svc.acknowledge(c(),pId,ack(pPublished)),404);
 await deny(()=>svc.acknowledge(c('reader'),published.currentPublicationId,ack(published)));
 await deny(()=>svc.acknowledge(c('viewer'),pId,ack(pPublished)));
 for(const extra of [{familyId:ids.family},{personId:randomUUID()},{signerPrincipalId:humans.parent.id},{signatureImage:'data:image/png;base64,xxx'},{acknowledgedAt:new Date().toISOString()}])await deny(()=>svc.acknowledge(c('parent'),pId,{...ack(pPublished),...extra}),400);
 await deny(()=>svc.acknowledge(c('parent'),pId,{...ack(pPublished),contentHash:'0'.repeat(64)}),400);
 await deny(()=>svc.acknowledge(c('parent'),pId,{...ack(pPublished),attestationText:'x'.repeat(501)}),400);
 const ackContext=c('parent');const concurrent=await Promise.all([svc.acknowledge(ackContext,pId,ack(pPublished)),svc.acknowledge(ackContext,pId,ack(pPublished))]);
 assert.equal(concurrent.filter(r=>!r.replayed).length,1);assert.equal(concurrent[0].record.id,concurrent[1].record.id);
 const evidence=concurrent[0].record;assert.equal(evidence.signerPrincipalId,humans.parent.id);assert.equal(evidence.familyId,ids.family);assert.equal(evidence.versionId,pPublished.versionId);assert.equal(evidence.kind,'INTERNAL_HUMAN_ACKNOWLEDGEMENT');assert.equal(await count('document_acknowledgements'),1);
 assert((await svc.acknowledge(c('parent'),pId,ack(pPublished))).replayed);
 await deny(()=>svc.acknowledge(c('parent'),pId,{...ack(pPublished),attestationText:'different'}),409);
 assert.deepEqual(await svc.read(c('parent'),'EVIDENCE',evidence.id),evidence);
 await deny(()=>svc.read(c('coParent'),'EVIDENCE',evidence.id),404);
 await deny(()=>svc.read(c('otherParent'),'EVIDENCE',evidence.id),404);
 await deny(()=>svc.read(c('reader'),'EVIDENCE',evidence.id));
 assert.deepEqual(await svc.read(c(),'EVIDENCE',evidence.id),evidence);
 assert.equal(await count('idempotency_records'),0,'No private document/evidence replay response may enter shared infrastructure storage');
 assert.equal((await svc.read(c(),'VERSION',draft.versionId)).contentHash,draft.contentHash);await deny(()=>svc.read(c('parent'),'VERSION',draft.versionId),400);
 const staffAck=(await svc.acknowledge(c(),published.currentPublicationId,{contentHash:published.contentHash,choice:'ACKNOWLEDGE'})).record;assert.equal(staffAck.familyId,null);assert.equal(staffAck.attestationText,null);
 // Published bytes, publication audience, and acknowledged evidence reject UPDATE/DELETE even with an administrative connection.
 for(const [table,id,update] of [['document_versions',draft.versionId,"title='tampered'"],['document_publications',pId,"audience='STAFF',family_id=NULL"],['document_acknowledgements',evidence.id,"choice='ACKNOWLEDGE'"],['document_templates',draft.id,"audience='STAFF',family_id=NULL,version=version+1"]]){
  await sqlDeny(()=>admin.query(`UPDATE hon.${table} SET ${update} WHERE id=$1`,[id]));await sqlDeny(()=>admin.query(`DELETE FROM hon.${table} WHERE id=$1`,[id]));
 }
 const versions=await Promise.allSettled([svc.version(c(),draft.id,{expectedVersion:pPublished.version,title:'New title',content:'New content'}),svc.version(c(),draft.id,{expectedVersion:pPublished.version,title:'Other title',content:'Other content'})]);
 assert.equal(versions.filter(r=>r.status==='fulfilled').length,1);assert.equal(versions.filter(r=>r.status==='rejected'&&r.reason.getStatus()===409).length,1);
 const revised=versions.find(r=>r.status==='fulfilled').value.record;assert.equal(revised.versionNumber,2);assert.equal(revised.currentPublicationId,pId);
 assert.equal((await svc.read(c('parent'),'PUBLICATION',pId)).content,pPublished.content);
 await deny(()=>svc.publish(c(),draft.id,{expectedVersion:revised.version,versionId:pPublished.versionId}),409);
 const latest=await publish(revised);await deny(()=>svc.acknowledge(ackContext,pId,ack(pPublished)),409);await deny(()=>svc.read(c('parent'),'PUBLICATION',pId),404);
 assert.deepEqual(await svc.read(c('parent'),'EVIDENCE',evidence.id),evidence);assert.equal((await svc.read(c(),'PUBLICATION',pId)).current,false);
 // Authorized actor in a different school still cannot see or mutate these IDs.
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')",[ids.org,ids.sibling,humans.staff.id,ids.owner]);
 await deny(()=>svc.read(c('staff',ids.sibling),'PUBLICATION',pId),404);await deny(()=>svc.read(c('staff',ids.sibling),'EVIDENCE',evidence.id),404);await deny(()=>svc.version(c('staff',ids.sibling),draft.id,{expectedVersion:latest.version,title:'Cross',content:'Cross'}),404);
 await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1',[humans.parent.id]);await deny(()=>svc.read(c('parent'),'LIST',null));await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1',[humans.parent.id]);
 await admin.query("UPDATE hon.family_access_grants SET effective_until=clock_timestamp()-interval '1 second' WHERE principal_id=$1",[humans.parent.id]);await deny(()=>svc.acknowledge(c('parent'),latest.currentPublicationId,ack(latest)));await admin.query('UPDATE hon.family_access_grants SET effective_until=NULL WHERE principal_id=$1',[humans.parent.id]);
 // Post-wait guardian expiry is evaluated with a live clock, not now().
 await admin.query("UPDATE hon.family_access_grants SET effective_until=clock_timestamp()+interval '1 second' WHERE principal_id=$1",[humans.coParent.id]);
 await admin.query('BEGIN');await admin.query('SELECT id FROM hon.organizations WHERE id=$1 FOR UPDATE',[ids.org]);
 const waiting=svc.acknowledge(c('coParent'),latest.currentPublicationId,ack(latest)).then(()=>({ok:true}),error=>({error}));await new Promise(r=>setTimeout(r,1500));await admin.query('ROLLBACK');assert.equal((await waiting).error?.getStatus(),403);
 await admin.query('UPDATE hon.family_access_grants SET effective_until=NULL WHERE principal_id=$1',[humans.coParent.id]);
 // Exact fixed SQL API source/context prohibitions (not just TypeScript guards).
 for(const [source,type,actionRequest] of [['AI','HUMAN_USER',''],['HUMAN_UI','AI_EMPLOYEE',''],['HUMAN_UI','HUMAN_USER',randomUUID()]]){
  const request=randomUUID();await runtime.query('BEGIN');await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_source',$5,true),set_config('app.hon_request_id',$6,true),set_config('app.hon_action_request_id',$7,true)",[ids.org,ids.school,humans.staff.id,type,source,request,actionRequest]);
  await sqlDeny(()=>runtime.query("SELECT hon.mutate_document($1,'STAFF','document.template.create',NULL,$2,$3,$4,$5)",[humans.staff.subject,body(),randomUUID(),request,request]));await runtime.query('ROLLBACK');
 }
 // Direct RLS proof independent of lack of runtime grants: a temporary non-bypass
 // role with explicit SELECT/INSERT sees no rows even with genuine tenant GUCs.
 await admin.query('BEGIN');await admin.query('CREATE ROLE hon_document_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS');await admin.query('GRANT hon_document_rls_probe TO CURRENT_USER');await admin.query('GRANT USAGE ON SCHEMA hon TO hon_document_rls_probe');
 for(const t of tables)await admin.query(`GRANT SELECT,INSERT ON hon.${t} TO hon_document_rls_probe`);
 await admin.query('SET LOCAL ROLE hon_document_rls_probe');await admin.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true)",[ids.org,ids.school]);
 for(const t of tables)assert.equal((await admin.query(`SELECT count(*) n FROM hon.${t}`)).rows[0].n,'0');
 await sqlDeny(()=>admin.query('INSERT INTO hon.document_templates(organization_id,school_id,audience,latest_version_id,created_by_principal_id) VALUES($1,$2,$3,$4,$5)',[ids.org,ids.school,'STAFF',randomUUID(),humans.staff.id]));await admin.query('ROLLBACK');
 // Acknowledgement + evidence + audit + inert outbox + idempotency are atomic.
 await admin.query(`CREATE FUNCTION hon.document_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${ids.org}'::uuid THEN RAISE EXCEPTION 'document fixture failure'; END IF; RETURN NEW; END $$`);await admin.query('CREATE TRIGGER document_fixture_failure BEFORE INSERT ON hon.outbox_events FOR EACH ROW EXECUTE FUNCTION hon.document_fixture_failure()');trigger=true;
 const atomicBefore=Object.fromEntries(await Promise.all([...tables,'audit_events','outbox_events','idempotency_records'].map(async t=>[t,await count(t)])));
 const failureContext=c('coParent');await assert.rejects(()=>svc.acknowledge(failureContext,latest.currentPublicationId,ack(latest)),/document fixture failure/);
 await assert.rejects(()=>svc.create(c(),body()),/document fixture failure/);
 for(const [t,n] of Object.entries(atomicBefore))assert.equal(await count(t),n,`${t} rolled back`);
 await admin.query('DROP TRIGGER document_fixture_failure ON hon.outbox_events');await admin.query('DROP FUNCTION hon.document_fixture_failure()');trigger=false;
 assert.equal((await svc.acknowledge(failureContext,latest.currentPublicationId,ack(latest))).replayed,false);
 // Provisioning seeds explicit new OWNER permissions without new principal grants.
 await admin.query('BEGIN');await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,granted_by_principal_id) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],$1)",[humans.outsider.id]);
 const provision=(await admin.query("SELECT * FROM hon.provision_school_from_hq($1,'Fixture','Fixture','Fixture',$2,'UTC','ESSENTIAL'::hon.plan_tier,$3,$4,$5,$6)",[humans.outsider.subject,`doc-${randomUUID()}`,randomUUID(),randomUUID(),randomUUID(),randomUUID()])).rows[0];
 assert.equal((await admin.query("SELECT count(*) n FROM hon.role_permissions WHERE role_id=$1 AND permission_code LIKE 'document.%'",[provision.owner_role_id])).rows[0].n,'6');assert.equal((await admin.query('SELECT count(*) n FROM hon.principal_role_grants WHERE organization_id=$1',[provision.organization_id])).rows[0].n,'0');await admin.query('ROLLBACK');
 const audits=(await admin.query('SELECT * FROM hon.audit_events WHERE organization_id=ANY($1::uuid[])',[orgs])).rows, events=(await admin.query('SELECT * FROM hon.outbox_events WHERE organization_id=ANY($1::uuid[])',[orgs])).rows;
 assert.equal(audits.length,events.length);assert(audits.every(a=>a.source==='HUMAN_UI'&&!a.action_request_id&&a.action_code.startsWith('document.')));
 for(const a of audits)assert.equal(events.filter(e=>e.causation_id===a.request_id&&e.aggregate_id===a.entity_id&&e.payload.internalOnly).length,1);
 assert.doesNotMatch(JSON.stringify([...audits,...events]),/PRIVATE_|attestationText|Read the safety|New content|@example/);
 for(const t of prohibited)assert.equal(await count(t),before[t],`${t} has no automatic effect`);
 assert.equal((await runtime.query("SELECT nullif(current_setting('app.hon_organization_id',true),'') c")).rows[0].c,null);
 console.log('PASS documents: scoped staff/verified parent, immutable publications/content/evidence, no student fallback, cross-school/family/audience denial, stale/replay/concurrency, live guardian expiry, human-only SQL/UI contracts, exact runtime directory/helper denial, direct forced RLS, provisioning, atomic evidence and zero AI/financial/communication/provider effects.');
}catch(e){console.error('Document integrity failure:',e);throw e;}finally{await db.onModuleDestroy();await runtime.end();await cleanup();await admin.end();}
