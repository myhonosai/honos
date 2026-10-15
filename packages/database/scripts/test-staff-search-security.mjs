import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { StaffSearchController } from '../../../apps/api/dist/search/staff-search.controller.js';
import { StaffSearchService } from '../../../apps/api/dist/search/staff-search.service.js';
import { RuntimeDatabaseService } from '../../../apps/api/dist/foundation/runtime-database.service.js';
const { STAFF_SEARCH_KINDS } = createRequire(import.meta.url)('../../contracts/dist/index.js');

if (!process.env.DATABASE_URL || !process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Migration and restricted runtime URLs are required.');
const options = connectionString => ({ connectionString, ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false } });
const admin = new pg.Client(options(process.env.DATABASE_URL));
const runtime = new pg.Client(options(process.env.HON_RUNTIME_DATABASE_URL));
const database = new RuntimeDatabaseService();
const controller = new StaffSearchController(new StaffSearchService(database));
const ids = Object.fromEntries(['org','otherOrg','a','b','hidden','foreign','role','weakRole','grantA','grantB','user','principal','parentUser','parent','hqUser','hq','family'].map(key => [key,randomUUID()]));
const subject = `staff-search-${randomUUID()}`;
const parentSubject = `search-parent-${randomUUID()}`;
const hqSubject = `search-hq-${randomUUID()}`;
const records = {};
const request = (externalSubject=subject) => ({honIdentity:{externalSubject}});
const search = async (q='needle', types, org=ids.org, school=ids.a, externalSubject=subject) => (await controller.search(org,school,{q,...(types!==undefined?{types}:{})},request(externalSubject))).data.search;
const status = n => error => {assert.equal(error.getStatus(),n);return true;};
const deny = operation => assert.rejects(operation,status(403));
const sqlDenied = (operation,code='42501') => assert.rejects(operation,error=>error.code===code);
const sqlSearch = (q='needle',types=[...STAFF_SEARCH_KINDS],org=ids.org,school=ids.a,who=subject,id=null) => runtime.query('SELECT hon.search_school($1,$2::uuid,$3::uuid,$4,$5::text[],$6::uuid) data',[who,org,school,q,types,id]);
let providerCalls=0; const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{providerCalls++;throw new Error('Search must not invoke HTTP/provider services');};
const operational = ['audit_events','outbox_events','action_requests','action_approvals','idempotency_records','ai_usage_ledger','ai_invocation_plans','work_items','communication_messages','communication_consents','payment_attempts','invoices','memberships','billing_accounts','people','student_profiles','crm_leads','crm_activities','class_sessions','programs','curricula','document_templates','document_versions','document_publications','document_acknowledgements','knowledge_articles'];
async function snapshot() {
  const output={};
  for(const table of operational) output[table]=(await admin.query(`SELECT count(*) AS n,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS digest FROM hon.${table} t WHERE organization_id=ANY($1::uuid[])`,[[ids.org,ids.otherOrg]])).rows[0];
  for(const table of ['hq_ai_provider_connections','hq_ai_model_catalog','hq_ai_routing_policies','hq_ai_routing_candidates','hq_ai_control_requests','hq_ai_control_audit','hq_ai_control_outbox']) output[table]=(await admin.query(`SELECT count(*) n,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) digest FROM hon.${table} t`)).rows[0];
  return output;
}
async function cleanup() {
  await admin.query('ROLLBACK'); await admin.query('BEGIN');
  try {
    for(const table of ['crm_activities','crm_leads','crm_pipeline_stages','crm_pipelines','student_profiles','class_sessions','programs','curricula','people','family_access_grants','families','principal_role_grants','organization_entitlements']) await admin.query(`DELETE FROM hon.${table} WHERE organization_id=ANY($1::uuid[])`,[[ids.org,ids.otherOrg]]);
    await admin.query('DELETE FROM hon.role_permissions WHERE organization_id=ANY($1::uuid[])',[[ids.org,ids.otherOrg]]);
    await admin.query('DELETE FROM hon.roles WHERE organization_id=ANY($1::uuid[])',[[ids.org,ids.otherOrg]]);
    await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1',[ids.hq]);
    await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[[ids.principal,ids.parent,ids.hq]]);
    await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[[ids.user,ids.parentUser,ids.hqUser]]);
    await admin.query('DELETE FROM hon.schools WHERE organization_id=ANY($1::uuid[])',[[ids.org,ids.otherOrg]]);
    await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[[ids.org,ids.otherOrg]]);
    await admin.query('COMMIT');
  } catch(error) {await admin.query('ROLLBACK');throw error;}
}
await Promise.all([admin.connect(),runtime.connect()]);
try {
  await admin.query('BEGIN');
  for(const org of [ids.org,ids.otherOrg])await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'DIRECTORY_CANARY','DIRECTORY_CANARY')",[org]);
  for(const school of ['a','b','hidden','foreign'])await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1::uuid,$2,'DIRECTORY_CANARY',$1::text)",[ids[school],school==='foreign'?ids.otherOrg:ids.org]);
  for(const [user,principal,external] of [[ids.user,ids.principal,subject],[ids.parentUser,ids.parent,parentSubject],[ids.hqUser,ids.hq,hqSubject]]) {
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,'directory@example.test','DIRECTORY_CANARY')",[user,external]);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','DIRECTORY_CANARY')",[principal,user]);
  }
  for(const [role,code] of [[ids.role,'SEARCH_TEST'],[ids.weakRole,'WEAK_SEARCH']])await admin.query('INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,$3)',[role,ids.org,code]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'search.global')",[ids.role,ids.org]);
  for(const permission of ['school.view','people.read','crm.lead.read','reporting.view'])await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[ids.weakRole,ids.org,permission]);
  for(const [school,role,grant] of [[ids.a,ids.role,ids.grantA],[ids.b,ids.role,ids.grantB],[ids.hidden,ids.weakRole,randomUUID()]])await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,statement_timestamp()-interval '1 day')",[grant,ids.org,school,ids.principal,role]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'ESSENTIAL',statement_timestamp()-interval '1 day')",[ids.org]);
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'DIRECTORY_CANARY')",[ids.family,ids.org,ids.a]);
  await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$5)",[ids.org,ids.a,ids.family,ids.parent,ids.principal]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes) VALUES($1,'HON_HQ_OWNER',ARRAY['search.global'])",[ids.hq]);
  for(const key of ['a','b','foreign']) {
    const org=key==='foreign'?ids.otherOrg:ids.org,school=ids[key];const record=records[key]={student:randomUUID(),person:randomUUID(),lead:randomUUID(),program:randomUUID(),session:randomUUID(),curriculum:randomUUID()};
    await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,'Lee','contact-only@example.test','+15555550123')",[record.person,org,school,key==='a'?'Needle':'Other Needle']);
    await admin.query("INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,birth_date) VALUES($1,$2,$3,$4,'2000-01-01')",[record.student,org,school,record.person]);
    const pipe=randomUUID(),stage=randomUUID();
    await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_PIPELINE')",[pipe,org,school]);
    await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'PRIVATE_STAGE',1)",[stage,org,school,pipe]);
    await admin.query("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,source_code,attribution) VALUES($1,$2,$3,$4,$5,$6,'PRIVATE_SOURCE','{\"secret\":\"PRIVATE_ATTRIBUTION\"}')",[record.lead,org,school,record.person,pipe,stage]);
    await admin.query("INSERT INTO hon.crm_activities(organization_id,school_id,lead_id,activity_type,details) VALUES($1,$2,$3,'NOTE','{\"note\":\"PRIVATE_NOTE\"}')",[org,school,record.lead]);
    await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name,description) VALUES($1,$2,$3,'Needle program','PRIVATE_DESCRIPTION')",[record.program,org,school]);
    await admin.query("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code,description) VALUES($1,$2,$3,'Needle curriculum','LINEAR','PRIVATE_DESCRIPTION')",[record.curriculum,org,school]);
    await admin.query("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status,cancellation_reason) VALUES($1,$2,$3,$4,'Needle session',now(),now()+interval '1 hour',10,'WALK_IN','CANCELLED','PRIVATE_CANCELLATION')",[record.session,org,school,record.program]);
  }
  // A person without student/lead ownership is never a result/directory source.
  await admin.query("INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email) VALUES($1,$2,'PRIVATE_UNLINKED_PERSON','Hidden','unlinked@example.test')",[ids.org,ids.a]);
  // Ties, literal wildcard/SQL characters, Unicode and normalized display bounds.
  for(let i=0;i<25;i++)await admin.query("INSERT INTO hon.programs(organization_id,school_id,name) VALUES($1,$2,$3)",[ids.org,ids.a,`many ${String(i).padStart(2,'0')}`]);
  for(const name of ['rank','rank prefix','a rank contains',"literal %_'; DROP TABLE hon.users--",'  dirty\t\u202e name  ','long '+ 'x'.repeat(180),'clip '+ 'x'.repeat(154)+' end','Unicode 🦁'])await admin.query('INSERT INTO hon.programs(organization_id,school_id,name) VALUES($1,$2,$3)',[ids.org,ids.a,name]);
  await admin.query('COMMIT');
  const before=await snapshot();
  const result=await search(); assert.equal(result.results.length,5);assert.deepEqual(new Set(result.results.map(r=>r.kind)),new Set(STAFF_SEARCH_KINDS));
  for(const row of result.results) {assert.deepEqual(Object.keys(row),['kind','entityId','title','subtitle','route']);assert.equal(row.route,`/staff/search/${ids.org}/${ids.a}/${row.kind}/${row.entityId}`);}
  const serialized=JSON.stringify(result);assert.doesNotMatch(serialized,/PRIVATE_|contact-only|1555555|2000-01-01|DIRECTORY_CANARY|personId|principalId|provider|email|phone|prompt|content|description|attribution/i);
  for(const id of [ids.b,ids.foreign,ids.otherOrg,ids.principal,ids.user,records.a.person,records.b.student,records.foreign.lead])assert(!serialized.includes(id));
  const other=await search('needle',undefined,ids.org,ids.b);assert.equal(other.results.length,5);assert(!JSON.stringify(other).includes(records.a.student));
  assert.deepEqual((await search('Needle Lee','STUDENT,LEAD')).results.map(r=>r.kind),['LEAD','STUDENT']);
  for(const kind of STAFF_SEARCH_KINDS)assert((await search('needle',kind)).results.every(r=>r.kind===kind));
  assert.equal((await search('contact-only')).results.length,1);assert.equal((await search('+15555550123')).results[0].kind,'LEAD');
  for(const q of ['PRIVATE_NOTE','PRIVATE_SOURCE','PRIVATE_ATTRIBUTION','PRIVATE_CANCELLATION','PRIVATE_DESCRIPTION','PRIVATE_UNLINKED_PERSON','unlinked@example.test','DIRECTORY_CANARY','2000-01-01'])assert.deepEqual((await search(q)).results,[],q);
  assert.equal((await search('%_')).results.length,1);assert.deepEqual((await search("' OR 1=1--")).results,[]);
  assert.equal((await search("DROP TABLE hon.users")).results.length,1);assert.equal((await search('🦁')).results[0].title,'Unicode 🦁');
  assert.equal((await search('dirty')).results[0].title,'dirty name');assert.equal(Array.from((await search('long')).results[0].title).length,160);
  assert.equal((await search('clip')).results[0].title,'clip '+'x'.repeat(154));
  assert.deepEqual((await search('rank','PROGRAM')).results.map(r=>r.title),['rank','rank prefix','a rank contains']);
  const many=await search('many','PROGRAM');assert.equal(many.results.length,20);assert.deepEqual(many,await search('many','PROGRAM'));assert.equal(many.results[0].title,'many 00');assert.equal(many.results.at(-1).title,'many 19');
  // Known-ID navigation is reauthorized and cannot expand to private detail data.
  const card=(await controller.readResult(ids.org,ids.a,'STUDENT',records.a.student,request())).data.result;assert.equal(card.title,'Needle Lee');
  await assert.rejects(()=>controller.readResult(ids.org,ids.a,'STUDENT',records.b.student,request()),status(404));
  await deny(()=>search('needle',undefined,ids.org,ids.hidden));await deny(()=>search('needle',undefined,ids.otherOrg,ids.a));await deny(()=>search('needle',undefined,ids.org,ids.foreign));
  await deny(()=>search('needle',undefined,ids.otherOrg,ids.foreign));await deny(()=>search('needle',undefined,ids.org,randomUUID()));
  await deny(()=>search('needle',undefined,ids.org,ids.a,parentSubject));await deny(()=>search('needle',undefined,ids.org,ids.a,hqSubject));await deny(()=>search('needle',undefined,ids.org,ids.a,'unknown'));
  await deny(()=>controller.search(ids.org,ids.a,{q:'needle'},{}));
  for(const tier of ['ESSENTIAL','CORE','COMPLETE']) {await admin.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[ids.org,tier]);assert.equal((await search()).results.length,5);}
  // Read permission has no commercial entitlement dependency, even when absent.
  await admin.query('DELETE FROM hon.organization_entitlements WHERE organization_id=$1',[ids.org]);assert.equal((await search()).results.length,5);
  for(const update of ["revoked_at=statement_timestamp(),revoked_by_principal_id=principal_id","revoked_at=NULL,revoked_by_principal_id=NULL,effective_from=statement_timestamp()+interval '1 hour'","effective_from=statement_timestamp()-interval '1 day',effective_until=statement_timestamp()-interval '1 hour'"]) {
    await admin.query(`UPDATE hon.principal_role_grants SET ${update} WHERE id=$1`,[ids.grantA]);await deny(()=>search());await sqlDenied(()=>sqlSearch());await deny(()=>controller.readResult(ids.org,ids.a,'STUDENT',records.a.student,request()));
  }
  await admin.query("UPDATE hon.principal_role_grants SET effective_from=statement_timestamp()-interval '1 day',effective_until=NULL WHERE id=$1",[ids.grantA]);
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='search.global'",[ids.role]);await deny(()=>search());
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'search.global')",[ids.role,ids.org]);
  await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1',[ids.principal]);await deny(()=>search());await sqlDenied(()=>sqlSearch());
  await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1',[ids.principal]);
  for(const type of ['AI_EMPLOYEE','AUTOMATION','INTEGRATION','SYSTEM_SERVICE']) {await admin.query('UPDATE hon.principals SET principal_type=$2,user_id=NULL WHERE id=$1',[ids.principal,type]);await deny(()=>search());}
  await admin.query("UPDATE hon.principals SET principal_type='HUMAN_USER',user_id=$2 WHERE id=$1",[ids.principal,ids.user]);
  const ambiguous=randomUUID();await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','AMBIGUOUS')",[ambiguous,ids.user]);await deny(()=>search());await admin.query('DELETE FROM hon.principals WHERE id=$1',[ambiguous]);
  for(const [table,id] of [['schools',ids.a],['organizations',ids.org]]) {await admin.query(`UPDATE hon.${table} SET status='SUSPENDED' WHERE id=$1`,[id]);await deny(()=>search());await admin.query(`UPDATE hon.${table} SET status='ACTIVE' WHERE id=$1`,[id]);}
  // Actual runtime role and function ACL: no owner/helper/PUBLIC widening.
  const posture=(await runtime.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(posture.current_user,'hon_runtime');assert(!posture.rolsuper&&!posture.rolbypassrls);
  const boundary=(await admin.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolsuper,r.rolbypassrls,has_function_privilege('hon_runtime',p.oid,'EXECUTE') allowed,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) broad_acl
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='hon.search_school(text,uuid,uuid,text,text[],uuid)'::regprocedure`)).rows[0];
  assert(boundary.prosecdef&&boundary.provolatile==='s'&&boundary.allowed&&!boundary.broad_acl&&(boundary.rolsuper||boundary.rolbypassrls));assert.deepEqual(boundary.proconfig,['search_path=pg_catalog, hon']);
  for(const table of ['users','principals','roles','permissions','role_permissions','principal_role_grants','family_access_grants','organizations','schools','hq_operator_grants','hq_onboarding_requests','crm_activities','document_templates','document_versions','document_publications','document_acknowledgements','hq_ai_provider_connections','hq_ai_model_catalog','hq_ai_routing_policies','hq_ai_routing_candidates','hq_ai_control_requests','hq_ai_control_audit','hq_ai_control_outbox']) {
    assert.equal((await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed",[`hon.${table}`])).rows[0].allowed,false,table);await sqlDenied(()=>runtime.query(`SELECT * FROM hon.${table} LIMIT 1`));
  }
  for(const q of [null,'','   ','\u00a0','\u3000','x'.repeat(121),'x\n','x\u202e'])await sqlDenied(()=>sqlSearch(q),'22023');
  for(const types of [null,[],['HQ'],['STUDENT',null],['STUDENT','STUDENT'],['LEAD; SELECT * FROM hon.users'],['../secrets'],[['STUDENT']],['STUDENT','LEAD','CLASS_SESSION','PROGRAM','CURRICULUM','PROGRAM']])await sqlDenied(()=>sqlSearch('needle',types),'22023');
  await sqlDenied(()=>sqlSearch('', ['STUDENT'],ids.org,ids.a,subject,records.a.student),'22023');
  await sqlDenied(()=>sqlSearch('record',['STUDENT','LEAD'],ids.org,ids.a,subject,records.a.student),'22023');
  await runtime.query('BEGIN READ ONLY');
  await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true)",[ids.otherOrg,ids.foreign,ids.hq]);
  assert.deepEqual((await sqlSearch()).rows[0].data,result);
  assert.equal((await runtime.query('SELECT count(*) n FROM hon.people WHERE id=$1',[records.a.person])).rows[0].n,'0');
  await runtime.query('COMMIT');
  assert.equal((await runtime.query("SELECT nullif(current_setting('app.hon_school_id',true),'') scope")).rows[0].scope,null);
  assert.deepEqual(await snapshot(),before);assert.equal(providerCalls,0);
  // Identical student titles tie by scoped UUID, not heap/insert order.
  await admin.query('BEGIN');
  const tieIds=[];
  for(let i=0;i<3;i++) {
    const person=randomUUID(),student=randomUUID();tieIds.push(student);
    await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'tiecase','Lee')",[person,ids.org,ids.a]);
    await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)',[student,ids.org,ids.a,person]);
  }
  const tied=(await admin.query("SELECT hon.search_school($1,$2,$3,'tiecase',ARRAY['STUDENT']) data",[subject,ids.org,ids.a])).rows[0].data;
  assert.deepEqual(tied.results.map(r=>r.entityId),tieIds.sort());await admin.query('ROLLBACK');
  // Static fixed relation allowlist backs runtime exclusion of forbidden sources.
  const source=await readFile(new URL('../migrations/0066_staff_search_display_boundary.sql',import.meta.url),'utf8');
  const body=source.split('SET search_path = pg_catalog, hon AS $$')[1].split('END $$;')[0];
  assert.deepEqual([...new Set([...body.matchAll(/(?:FROM|JOIN) hon\.([a-z_]+)/g)].map(m=>m[1]))].sort(),['users','principals','schools','organizations','principal_role_grants','roles','role_permissions','student_profiles','people','crm_leads','class_sessions','programs','curricula'].sort());
  assert.doesNotMatch(body,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE|set_config|dblink|http|pg_notify)\b/i);
  const permission=(await admin.query("SELECT is_sensitive,is_staff_assignable FROM hon.permissions WHERE code='search.global'")).rows[0];assert(permission.is_sensitive&&permission.is_staff_assignable);
  assert.equal((await admin.query("SELECT count(*) n FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER' AND NOT EXISTS(SELECT 1 FROM hon.role_permissions p WHERE p.role_id=r.id AND p.organization_id=r.organization_id AND p.permission_code='search.global')")).rows[0].n,'0');
  // Execute the ACTUAL migration backfill in rollback-only fixtures. Neither an
  // OWNER-named non-system role nor a non-OWNER role gets authority or new grants.
  await admin.query('BEGIN');
  const canonical=randomUUID(),fakeOwner=randomUUID();
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','OWNER',true),($3,$4,'OWNER','OWNER',false)",[canonical,ids.org,fakeOwner,ids.otherOrg]);
  const grantsBefore=(await admin.query('SELECT count(*) n FROM hon.principal_role_grants WHERE organization_id=ANY($1::uuid[])',[[ids.org,ids.otherOrg]])).rows[0].n;
  const migration=await readFile(new URL('../migrations/0065_deterministic_staff_search.sql',import.meta.url),'utf8');
  const backfill='INSERT INTO hon.role_permissions'+migration.split('INSERT INTO hon.role_permissions')[1].split('ON CONFLICT DO NOTHING;')[0]+'ON CONFLICT DO NOTHING;';
  await admin.query(backfill);await admin.query(backfill);
  assert.equal((await admin.query("SELECT count(*) n FROM hon.role_permissions WHERE role_id=$1 AND permission_code='search.global'",[canonical])).rows[0].n,'1');
  assert.equal((await admin.query("SELECT count(*) n FROM hon.role_permissions WHERE role_id=ANY($1::uuid[]) AND permission_code='search.global'",[[fakeOwner,ids.weakRole]])).rows[0].n,'0');
  assert.equal((await admin.query('SELECT count(*) n FROM hon.principal_role_grants WHERE organization_id=ANY($1::uuid[])',[[ids.org,ids.otherOrg]])).rows[0].n,grantsBefore);await admin.query('ROLLBACK');
  console.log('PASS staff search: actual hon_runtime, all tiers, exact active human permission/revocation, school/org/parent/HQ isolation, closed literal filters, redaction, scoped routes, stable 20 cap, READ ONLY and zero provider/write/audit/outbox effects.');
} finally {
  globalThis.fetch=originalFetch;
  try {await runtime.query('ROLLBACK');await cleanup();} finally {await Promise.all([admin.end(),runtime.end(),database.onModuleDestroy()]);}
}
