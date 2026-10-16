import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import {requireCurriculumLibraryLocalUrls} from './curriculum-library-local-guard.mjs';
import {curriculumLibraryTables,verifyCurriculumLibrarySecurity} from './curriculum-library-security.mjs';
import {CurriculumLibraryService} from '../../../apps/api/dist/curriculum/library.service.js';
import {StaffCurriculumLibraryController,ParentCurriculumLibraryController} from '../../../apps/api/dist/curriculum/library.controller.js';
import {RuntimeDatabaseService} from '../../../apps/api/dist/foundation/runtime-database.service.js';
import {createRequire} from 'node:module';
const {isSafeCurriculumResourceUrl}=createRequire(import.meta.url)('../../contracts/dist/index.js');
requireCurriculumLibraryLocalUrls();
const admin=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false});
const runtime=new pg.Client({connectionString:process.env.HON_RUNTIME_DATABASE_URL,ssl:false});
const db=new RuntimeDatabaseService(),svc=new CurriculumLibraryService(db),staff=new StaffCurriculumLibraryController(db,svc),parent=new ParentCurriculumLibraryController(svc);
const ids=Object.fromEntries(['org','foreignOrg','school','otherSchool','foreignSchool','role','wrongRole','foreignRole','curriculum','otherCurriculum','foreignCurriculum','siblingCurriculum','rank','nextRank','otherRank','foreignRank','family','otherFamily','student','otherStudent','enrollment','otherEnrollment'].map(k=>[k,randomUUID()]));
const humans=Object.fromEntries(['manager','wrong','parent','otherParent','foreign'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`library-${k}-${randomUUID()}`} ]));
const orgs=[ids.org,ids.foreignOrg];
const context=(who='manager',school=ids.school,key=randomUUID())=>({organizationId:school===ids.foreignSchool?ids.foreignOrg:ids.org,schoolId:school,principalId:humans[who].id,externalSubject:humans[who].subject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:key});
const input=(patch={})=>({expectedVersion:0,curriculumId:ids.curriculum,rankId:ids.rank,kind:'VIDEO',url:'https://www.youtube.com/watch?v=school-approved',title:'Approved basics',description:'Optional human-approved reference.',audience:'PARENT',...patch});
const deny=(fn,status=403)=>assert.rejects(async()=>fn(),e=>{assert.equal(e.getStatus?.(),status,e.stack);return true;});
const sqlDeny=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.stack);return true;});
const snapshot=async tables=>{const s={};for(const t of tables)s[t]=(await admin.query(`SELECT * FROM hon.${t} WHERE organization_id=ANY($1::uuid[]) ORDER BY to_jsonb(${t})::text`,[orgs])).rows;return s;};
const count=async t=>Number((await admin.query(`SELECT count(*) n FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs])).rows[0].n);
// Marked disposable fixture only: vary existing enrollment relationships without manufacturing domain command evidence.
async function fixtureEnrollment(sql,params) { await admin.query('BEGIN');try{await admin.query('ALTER TABLE hon.student_curriculum_enrollments DISABLE TRIGGER enrollment_recorded_human_evidence');await admin.query(sql,params);await admin.query('ALTER TABLE hon.student_curriculum_enrollments ENABLE TRIGGER enrollment_recorded_human_evidence');await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;} }
const parentRequest=who=>({method:'GET',headers:{},originalUrl:'/v1/parent/curriculum-library',honIdentity:{externalSubject:humans[who].subject}});
const readParent=who=>parent.read({},parentRequest(who));
const oldFetch=globalThis.fetch,oldHttps=https.request,oldResolve=dns.resolve,oldLookup=dns.lookup,oldConnect=net.Socket.prototype.connect;
let externalAttempts=0;
const noExternal=()=>{externalAttempts++;throw new Error('External I/O prohibited by library fixture');};
globalThis.fetch=noExternal;https.request=noExternal;dns.resolve=noExternal;
dns.lookup=function(host,...args){if(!['localhost','127.0.0.1','::1'].includes(host))return noExternal();return oldLookup.call(this,host,...args);};
net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const host=typeof first==='object'?first.host:args[1];const port=typeof first==='object'?first.port:first;if(!['localhost','127.0.0.1','::1'].includes(host)||Number(port)!==5432)return noExternal();return oldConnect.apply(this,args);};
await Promise.all([admin.connect(),runtime.connect()]);
try {
 const marker=(await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()" )).rows[0];
 assert.equal(marker.owner,'hon_curriculum_library_owner');assert.equal(marker.marker,'HON disposable curriculum_library validation');
 await verifyCurriculumLibrarySecurity(admin,'hon_curriculum_library_runtime');
 // Setup guards are tested in separate clean child environments. No target is touched.
 const setup=new URL('./setup-curriculum-library-validation.mjs',import.meta.url).pathname;
 const safeEnv={PATH:process.env.PATH,HOME:'/home/ubuntu',LANG:'C.UTF-8'};
 for(const patch of [{HON_CURRICULUM_LIBRARY_VALIDATION_TARGET:'postgresql://remote.invalid:5432/hon_curriculum_library_validation'}, {STRIPE_SECRET_KEY:'synthetic'}, {HON_ACTION_EXECUTION_ENABLED:'synthetic'}, {OPENAI_API_KEY:'synthetic'}, {UNRECOGNIZED_VENDOR_TOKEN:'synthetic'}, {CUSTOM_PROVIDER_SWITCH:'synthetic'}, {DATABASE_URL:'postgresql://localhost:5432/ordinary'}]) {
  const r=spawnSync(process.execPath,[setup],{env:{...safeEnv,...patch},encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/refuse|refused|required|Clear inherited/i);
 }
 for(const t of [...curriculumLibraryTables,'users','principals','principal_role_grants','role_permissions','family_access_grants']) {
  assert.equal((await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ok",[`hon.${t}`])).rows[0].ok,false,t);
  await sqlDeny(()=>runtime.query(`SELECT * FROM hon.${t}`));
 }
 for(const signature of ['valid_curriculum_resource_url(text)','guard_curriculum_resource()','lock_curriculum_resource_actor(text)','curriculum_resource_projection(hon.curriculum_resources)']) {
  assert.equal((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') ok",[`hon.${signature}`])).rows[0].ok,false,signature);
 }
 await admin.query('BEGIN');
 for(const org of orgs) {await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Synthetic Library','Synthetic Library')",[org]);await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'ESSENTIAL',clock_timestamp()-interval '1 day')",[org]);}
 for(const [school,org] of [[ids.school,ids.org],[ids.otherSchool,ids.org],[ids.foreignSchool,ids.foreignOrg]]) await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1::uuid,$2,'Synthetic School',$1::text)",[school,org]);
 for(const h of Object.values(humans)) {await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_STAFF_IDENTITY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','PRIVATE_STAFF_IDENTITY')",[h.id,h.user]);}
 for(const [role,org,permission] of [[ids.role,ids.org,'curriculum.manage'],[ids.wrongRole,ids.org,'curriculum.progress.record'],[ids.foreignRole,ids.foreignOrg,'curriculum.manage']]) {await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1::uuid,$2,$1::text,'Synthetic role')",[role,org]);await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[role,org,permission]);}
 for(const [who,role,org,school] of [['manager',ids.role,ids.org,ids.school],['wrong',ids.wrongRole,ids.org,ids.school],['foreign',ids.foreignRole,ids.foreignOrg,ids.foreignSchool]]) await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')",[org,school,humans[who].id,role]);
 for(const [curriculum,rank,school,org,name] of [[ids.curriculum,ids.rank,ids.school,ids.org,'Main curriculum'],[ids.otherCurriculum,ids.otherRank,ids.school,ids.org,'Other curriculum'],[ids.foreignCurriculum,ids.foreignRank,ids.foreignSchool,ids.foreignOrg,'Foreign curriculum'],[ids.siblingCurriculum,null,ids.otherSchool,ids.org,'Sibling curriculum']]) {
  await admin.query("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code) VALUES($1,$2,$3,$4,'LINEAR')",[curriculum,org,school,name]);
  if(rank)await admin.query("INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,'White',1)",[rank,org,school,curriculum]);
 }
 await admin.query("INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,'Next',2)",[ids.nextRank,ids.org,ids.school,ids.curriculum]);
 for(const [family,student,enrollment,who,rank] of [[ids.family,ids.student,ids.enrollment,'parent',ids.rank],[ids.otherFamily,ids.otherStudent,ids.otherEnrollment,'otherParent',ids.nextRank]]) {
  const person=randomUUID();await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Synthetic family')",[family,ids.org,ids.school]);
  await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Child','Safe')",[person,ids.org,ids.school]);
  await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id) VALUES($1,$2,$3,$4,$5)',[student,ids.org,ids.school,person,family]);
  await admin.query("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')",[ids.org,ids.school,family,person]);
  await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4,clock_timestamp()-interval '1 day')",[ids.org,ids.school,family,humans[who].id]);
  await admin.query('INSERT INTO hon.student_curriculum_enrollments(id,organization_id,school_id,student_profile_id,curriculum_id,current_rank_id) VALUES($1,$2,$3,$4,$5,$6)',[enrollment,ids.org,ids.school,student,ids.curriculum,rank]);
 }
 await admin.query('COMMIT');
 const prohibited=['people','student_profiles','student_curriculum_enrollments','curriculum_requirements','curriculum_progress_observations','curriculum_enrollment_history','testing_candidates','testing_events','promotion_decisions','families','family_access_grants','family_members','communication_messages','communication_consents','payment_attempts','invoices','memberships','membership_payment_schedules','billing_accounts','action_requests','action_approvals','ai_usage_ledger','ai_invocation_plans','work_items','automation_rules','outbox_events','outbox_delivery_attempts'];
 const before=await snapshot(prohibited);
 const createContext=context(),first=(await svc.create(createContext,input())).record;assert.equal(first.version,1);assert.equal((await svc.create(createContext,input())).replayed,true);
 await deny(()=>svc.create(createContext,input({title:'Different command'})),409);
 const duplicated=context();const same=await Promise.all([svc.create(duplicated,input({title:'Concurrent same key'})),svc.create(duplicated,input({title:'Concurrent same key'}))]);assert.equal(same.filter(r=>!r.replayed).length,1);assert.equal(same[0].record.id,same[1].record.id);
 const allRanks=(await svc.create(context(),input({rankId:null,title:'All-rank reference',kind:'LINK',url:'https://school-resources.org/basics'}))).record;
 const staffOnly=(await svc.create(context(),input({audience:'STAFF',title:'Staff-only reference'}))).record;
 const otherRank=(await svc.create(context(),input({rankId:ids.nextRank,title:'Next-rank reference'}))).record;
 const otherCurriculum=(await svc.create(context(),input({curriculumId:ids.otherCurriculum,rankId:ids.otherRank,title:'Other-curriculum reference'}))).record;
 const foreign=(await svc.create(context('foreign',ids.foreignSchool),input({curriculumId:ids.foreignCurriculum,rankId:ids.foreignRank,title:'Foreign reference'}))).record;
 const list=await svc.list(context());assert.equal(list.curricula.length,2);assert(!list.resources.some(r=>r.id===foreign.id));assert(!JSON.stringify(list).includes('PRIVATE_STAFF_IDENTITY'));
 for(const who of ['wrong','parent','otherParent'])await deny(()=>svc.list(context(who)));
 await deny(()=>svc.list(context('manager',ids.otherSchool)));await deny(()=>svc.list(context('manager',ids.foreignSchool)));
 for(const type of ['AI_EMPLOYEE','AUTOMATION','INTEGRATION','SYSTEM_SERVICE'])await deny(()=>svc.create({...context(),principalType:type},input()));
 for(const source of ['AI','AUTOMATION','INTEGRATION','PUBLIC_API','HQ_SUPPORT','MIGRATION'])await deny(()=>svc.create({...context(),source},input()));
 for(const patch of [{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()},{externalSubject:humans.parent.subject},{principalId:humans.parent.id}])await deny(()=>svc.create({...context(),...patch},input()));
 for(const rankId of [ids.otherRank,ids.foreignRank])await deny(()=>svc.create(context(),input({rankId})),400);
 for(const curriculumId of [ids.foreignCurriculum,ids.siblingCurriculum])await deny(()=>svc.create(context(),input({curriculumId,rankId:null})),404);
 for(const patch of [{actorPrincipalId:humans.parent.id},{expectedVersion:1},{kind:'IFRAME'},{title:'<script>'},{description:'bad\ntext'},{audience:'PUBLIC'},{rankId:''},{title:' '},{url:'https://youtube.com/#fragment'}])await deny(()=>svc.create(context(),input(patch)),400);
 const unsafe=['http://youtube.com/watch','https://user:pass@youtube.com/x','https://youtube.com/#x','https://youtube.com/a b','https://youtube.com/a\n','https://localhost/a','https://127.0.0.1/a','https://10.1.1.1/a','https://192.168.1.1/a','https://169.254.169.254/x','https://[::1]/a','https://[2001:4860:4860::8888]/a','https://2130706433/a','https://0177.0.0.1/x','https://0x7f000001/x','https://foo.local/x','https://foo.internal/x','https://foo.arpa/x','https://foo.invalid/x','https://foo.test/x','https://foo.onion/x','https:///x','https://-bad.org/x','https://bad-.org/x','https://a..org/x','https://a.org./x','https://a.org:443/x','https://a.org/percent%20space','https://a.org/\\evil','https://a.org/é','https://a.org/%0d','https://a.org/%23','https://xn--bad.test/x'];
 for(const url of unsafe) {assert.equal(isSafeCurriculumResourceUrl(url),false,url);assert.equal((await admin.query('SELECT hon.valid_curriculum_resource_url($1) ok',[url])).rows[0].ok,false,url);await deny(()=>svc.create(context(),input({url})),400);}
 assert.equal(isSafeCurriculumResourceUrl('https://www.youtube.com/watch?v=x&list=y'),true);
 // Direct SQL cannot bypass the API's URL, context, identity or closed-object validation.
 async function raw(op='CREATE',resource=null,body=input(),patch={}) {
  const c={...context(),...patch};await runtime.query('BEGIN');try {
   await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_source',$5,true),set_config('app.hon_action_request_id',$6,true),set_config('app.hon_delegated_by_principal_id',$7,true),set_config('app.hon_request_id',$8,true)",[c.organizationId,c.schoolId,c.principalId,c.principalType,c.source,c.actionRequestId??'',c.delegatedByPrincipalId??'',c.requestId]);
   return await runtime.query('SELECT hon.mutate_curriculum_resource($1,$2,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid)',[c.externalSubject,op,resource,JSON.stringify(body),c.idempotencyKey,c.requestId,c.correlationId]);
  } finally {await runtime.query('ROLLBACK');}
 }
 for(const patch of [{source:'AI'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()},{principalType:'AUTOMATION'},{principalId:humans.parent.id}])await sqlDeny(()=>raw('CREATE',null,input(),patch));
 for(const body of [input({url:'https://127.0.0.1/x'}),input({extra:'not accepted'}),input({rankId:ids.otherRank})])await sqlDeny(()=>raw('CREATE',null,body),'22023');
 await sqlDeny(()=>runtime.query('SELECT hon.read_staff_curriculum_library($1)',[humans.manager.subject]));
 for(const patch of [{source:'AI'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()},{principalType:'AI_EMPLOYEE'}]) {
  const pc={...context('parent'),...patch};await runtime.query('BEGIN');try{await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_source',$5,true),set_config('app.hon_action_request_id',$6,true),set_config('app.hon_delegated_by_principal_id',$7,true)",[pc.organizationId,pc.schoolId,pc.principalId,pc.principalType,pc.source,pc.actionRequestId??'',pc.delegatedByPrincipalId??'']);await sqlDeny(()=>runtime.query('SELECT hon.read_parent_curriculum_library($1,$2)',[humans.parent.subject,ids.family]));}finally{await runtime.query('ROLLBACK');}
 }
 const update={expectedVersion:1,title:'Revised approved basics',description:'Concise reference description.',audience:'PARENT'};
 const race=await Promise.allSettled([svc.update(context(),first.id,update),svc.update(context(),first.id,update)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.find(r=>r.status==='rejected').reason.getStatus(),409);
 await deny(()=>svc.update(context(),first.id,{...update,url:'https://vimeo.com/rewrite'}),400);
 await deny(()=>svc.archive(context(),first.id,{expectedVersion:1}),409);
 let p=(await readParent('parent')).data;assert(p.resources.some(r=>r.title===update.title));assert(p.resources.some(r=>r.title===allRanks.title));assert(!p.resources.some(r=>[staffOnly.title,otherRank.title,otherCurriculum.title,foreign.title].includes(r.title)));
 assert.deepEqual(Object.keys(p.resources[0]).sort(),['title','description','kind','url','curriculumName','rankName','childDisplayName'].sort());assert.doesNotMatch(JSON.stringify(p),/PRIVATE_|principal|familyId|schoolId|organizationId|provider|audit|progress|readiness|billing/);
 const other=(await readParent('otherParent')).data;assert(other.resources.some(r=>r.title===otherRank.title));assert(!other.resources.some(r=>r.title===update.title));
 const arc=context();assert.equal((await svc.archive(arc,first.id,{expectedVersion:2})).record.status,'ARCHIVED');assert.equal((await svc.archive(arc,first.id,{expectedVersion:2})).replayed,true);
 await deny(()=>svc.update(context(),first.id,{...update,expectedVersion:3}),409);assert(!(await readParent('parent')).data.resources.some(r=>r.title===update.title));
 for(const [table,id] of [['curriculum_resource_versions',first.id],['curriculum_resource_facts',first.id]]) {await sqlDeny(()=>admin.query(`DELETE FROM hon.${table} WHERE resource_id=$1`,[id]));await sqlDeny(()=>admin.query(`TRUNCATE hon.${table} CASCADE`));}
 await sqlDeny(()=>admin.query('DELETE FROM hon.curriculum_resources WHERE id=$1',[first.id]));await sqlDeny(()=>admin.query("UPDATE hon.curriculum_resources SET title='Rewrite',version=version+1 WHERE id=$1",[first.id]));await sqlDeny(()=>admin.query("UPDATE hon.curriculum_resources SET url='https://vimeo.com/new',version=version+1 WHERE id=$1",[staffOnly.id]));
 await sqlDeny(()=>admin.query('DELETE FROM hon.curriculum_resource_requests WHERE principal_id=$1',[humans.manager.id]));
 // Mistaken table and column grants remain deny-all under forced RLS; exact verifier rejects them.
 await admin.query('GRANT SELECT ON hon.curriculum_resources TO hon_curriculum_library_runtime');await runtime.query('BEGIN');await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true)",[ids.org,ids.school]);assert.equal((await runtime.query('SELECT count(*) n FROM hon.curriculum_resources')).rows[0].n,'0');await runtime.query('ROLLBACK');await assert.rejects(()=>verifyCurriculumLibrarySecurity(admin,'hon_curriculum_library_runtime'),/private table\/column ACL/);await admin.query('REVOKE SELECT ON hon.curriculum_resources FROM hon_curriculum_library_runtime');
 await admin.query('BEGIN');await admin.query('GRANT SELECT(title) ON hon.curriculum_resources TO hon_curriculum_library_runtime');await assert.rejects(()=>verifyCurriculumLibrarySecurity(admin,'hon_curriculum_library_runtime'),/private table\/column ACL/);await admin.query('ROLLBACK');
 // Injected audit/fact failure rolls projection, immutable history and receipt back together.
 for(const table of ['audit_events','curriculum_resource_facts']) {
  const atomic=[...curriculumLibraryTables,'audit_events'],prior=await snapshot(atomic);
  await admin.query(`CREATE FUNCTION hon.library_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${ids.org}'::uuid THEN RAISE EXCEPTION 'library atomic rollback'; END IF; RETURN NEW; END $$`);
  await admin.query(`CREATE TRIGGER library_fixture_failure BEFORE INSERT ON hon.${table} FOR EACH ROW EXECUTE FUNCTION hon.library_fixture_failure()`);
  try {await assert.rejects(()=>svc.create(context(),input({title:'Rollback reference'})),/library atomic rollback/);assert.deepEqual(await snapshot(atomic),prior);} finally {await admin.query(`DROP TRIGGER library_fixture_failure ON hon.${table}`);await admin.query('DROP FUNCTION hon.library_fixture_failure()');}
 }
 // Revocation is rechecked before completed replay, even after blocking locks.
 const replay=()=>svc.create(createContext,input());
 for(const [sql,undo,params] of [
  ['UPDATE hon.principals SET is_active=false WHERE id=$1','UPDATE hon.principals SET is_active=true WHERE id=$1',[humans.manager.id]],
  ["DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='curriculum.manage'","INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'curriculum.manage')",[ids.role,ids.org]],
  ["UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE principal_id=$1",'UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE principal_id=$1',[humans.manager.id]],
  ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1","UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[ids.org]],
  ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1","UPDATE hon.schools SET status='ACTIVE' WHERE id=$1",[ids.school]],
  ["UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1","UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1",[ids.org]]
 ]) {const n=(sql.match(/\$[0-9]+/g)??[]).reduce((a,x)=>Math.max(a,Number(x.slice(1))),0);await admin.query(sql,params.slice(0,n));try{await deny(replay);await deny(()=>svc.list(context()));}finally{await admin.query(undo,params);}}
 for(const tier of ['ESSENTIAL','CORE','COMPLETE']) {await admin.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[ids.org,tier]);assert.equal((await replay()).replayed,true);assert((await svc.list(context())).resources.length);}
 await admin.query("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1",[ids.org]);await deny(replay);await deny(()=>readParent('parent'));await admin.query('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1',[ids.org]);
 await admin.query('UPDATE hon.roles SET management_school_id=$2 WHERE id=$1',[ids.role,ids.otherSchool]);await deny(replay);await admin.query('UPDATE hon.roles SET management_school_id=NULL WHERE id=$1',[ids.role]);
 await admin.query("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()+interval '300 milliseconds' WHERE principal_id=$1",[humans.manager.id]);await admin.query('BEGIN');await admin.query('SELECT 1 FROM hon.organizations WHERE id=$1 FOR UPDATE',[ids.org]);const waiting=replay();const rejection=deny(()=>waiting);await new Promise(r=>setTimeout(r,450));await admin.query('COMMIT');await rejection;await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE principal_id=$1',[humans.manager.id]);
 // Current family/student/enrollment/rank relationships fail closed.
 for(const [table,column,id,value] of [['student_profiles','status',ids.student,'SUSPENDED'],['student_curriculum_enrollments','status',ids.enrollment,'SUSPENDED'],['family_members','member_role',ids.family,'OTHER']]) {
  const key=table==='family_members'?'family_id':'id';await (table==='student_curriculum_enrollments'?fixtureEnrollment:admin.query.bind(admin))(`UPDATE hon.${table} SET ${column}=$2 WHERE ${key}=$1`,[id,value]);assert.equal((await readParent('parent')).data.resources.length,0);await (table==='student_curriculum_enrollments'?fixtureEnrollment:admin.query.bind(admin))(`UPDATE hon.${table} SET ${column}=$2 WHERE ${key}=$1`,[id,table==='family_members'?'STUDENT':'ACTIVE']);
 }
 await fixtureEnrollment('UPDATE hon.student_curriculum_enrollments SET current_rank_id=NULL WHERE id=$1',[ids.enrollment]);p=(await readParent('parent')).data;assert.deepEqual(p.resources.map(r=>r.title),[allRanks.title]);
 await fixtureEnrollment('UPDATE hon.student_curriculum_enrollments SET current_rank_id=$2 WHERE id=$1',[ids.enrollment,ids.nextRank]);p=(await readParent('parent')).data;assert(p.resources.some(r=>r.title===otherRank.title));await fixtureEnrollment('UPDATE hon.student_curriculum_enrollments SET current_rank_id=$2 WHERE id=$1',[ids.enrollment,ids.rank]);
 await admin.query('UPDATE hon.student_profiles SET primary_family_id=$2 WHERE id=$1',[ids.student,ids.otherFamily]);assert.equal((await readParent('parent')).data.resources.length,0);await admin.query('UPDATE hon.student_profiles SET primary_family_id=$2 WHERE id=$1',[ids.student,ids.family]);
 for(const [sql,undo,params] of [
  ["UPDATE hon.family_access_grants SET effective_until=clock_timestamp()-interval '1 second' WHERE principal_id=$1",'UPDATE hon.family_access_grants SET effective_until=NULL WHERE principal_id=$1',[humans.parent.id]],
  ['UPDATE hon.principals SET is_active=false WHERE id=$1','UPDATE hon.principals SET is_active=true WHERE id=$1',[humans.parent.id]],
  ["UPDATE hon.families SET status='SUSPENDED' WHERE id=$1","UPDATE hon.families SET status='ACTIVE' WHERE id=$1",[ids.family]]
 ]) {await admin.query(sql,params);try {await deny(()=>readParent('parent'));}finally{await admin.query(undo,params);}}
 // SQL scope can't be forged to another family, even in the same school.
 const parentScope=(await db.resolveParentJourneyScopes(humans.parent.subject))[0];
 await deny(()=>db.withTenantTransaction({...parentScope,principalType:'HUMAN_USER',requestId:randomUUID()},async c=>{await c.query("SELECT set_config('app.hon_source','HUMAN_UI',true)");try{await c.query('SELECT hon.read_parent_curriculum_library($1,$2)',[humans.parent.subject,ids.otherFamily]);}catch(e){if(e.code==='42501')throw Object.assign(new Error('Denied'),{getStatus:()=>403});throw e;}}));
 await deny(()=>parent.read({familyId:ids.otherFamily},parentRequest('parent')),400);
 await deny(()=>parent.read({}, {...parentRequest('parent'),originalUrl:'/v1/parent/curriculum-library?child=x'}),400);
 await deny(()=>parent.read({}, {...parentRequest('parent'),headers:{'x-hon-source':'AI'}}));
 await deny(()=>staff.list(ids.foreignSchool,{honIdentity:{externalSubject:humans.manager.subject}}));
 const secondGrant=await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,'VIEWER',$4,clock_timestamp()-interval '1 day') RETURNING id",[ids.org,ids.school,ids.otherFamily,humans.parent.id]);await deny(()=>readParent('parent'));await admin.query('DELETE FROM hon.family_access_grants WHERE id=$1',[secondGrant.rows[0].id]);
 // The exact verifier fails body, ACL and trigger drift, not only broad RLS checks.
 for(const sql of ['GRANT EXECUTE ON FUNCTION hon.lock_curriculum_resource_actor(text) TO hon_curriculum_library_runtime','ALTER TABLE hon.curriculum_resource_facts DISABLE TRIGGER library_history_immutable']) {await admin.query('BEGIN');try{await admin.query(sql);await assert.rejects(()=>verifyCurriculumLibrarySecurity(admin,'hon_curriculum_library_runtime'),/exact function-only ACL|immutable guards/);}finally{await admin.query('ROLLBACK');}}
 const definition=(await admin.query("SELECT pg_get_functiondef('hon.valid_curriculum_resource_url(text)'::regprocedure) body")).rows[0].body;await admin.query('BEGIN');try{await admin.query(definition.replace('RETURN true;','RETURN false;'));await assert.rejects(()=>verifyCurriculumLibrarySecurity(admin,'hon_curriculum_library_runtime'),/fixed function posture\/body/);}finally{await admin.query('ROLLBACK');}
 const canonical=await readFile(new URL('../../../infra/postgres/010_supabase_hon_runtime.sql',import.meta.url),'utf8');
 assert.match(canonical,/Curriculum library exact grant reconciliation/);
 assert.equal(await count('curriculum_resource_versions'),await count('curriculum_resource_requests'));assert.equal(await count('curriculum_resource_facts'),await count('curriculum_resource_requests'));assert.equal(await count('audit_events'),await count('curriculum_resource_requests'));
 const facts=(await admin.query('SELECT * FROM hon.curriculum_resource_facts WHERE organization_id=ANY($1::uuid[])',[orgs])).rows;assert(facts.every(f=>f.state==='INERT'&&f.internal_only));assert.doesNotMatch(JSON.stringify(facts),/https:|provider|payload|delivery|worker|title|description/);
 assert.deepEqual(await snapshot(prohibited),before,'No curriculum, progress, testing, families, billing, communication, AI, Action Engine, automation or general outbox effects');
 assert.equal(externalAttempts,0,'No external fetch, HTTPS or DNS resource lookup');
 assert.equal((await runtime.query('SELECT hon.current_school_id() id')).rows[0].id,null,'transaction context cleared');
 await verifyCurriculumLibrarySecurity(admin,'hon_curriculum_library_runtime');
 const verifier=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');await admin.query(verifier.replaceAll('hon_runtime','hon_curriculum_library_runtime'));
 console.log('PASS curriculum library integrity: schools/ACL/RLS/function posture; exact human authority/revocation/locks; lexical URLs; rank/family scope; replay/version/concurrency/archive; immutable history and audit+inert-fact atomicity; parent redaction; no external I/O or domain effects. Synthetic records remain only in the named disposable local fixture.');
} finally {
 await admin.query('ROLLBACK');await runtime.query('ROLLBACK');await Promise.all([admin.end(),runtime.end(),db.onModuleDestroy()]);globalThis.fetch=oldFetch;https.request=oldHttps;dns.resolve=oldResolve;dns.lookup=oldLookup;net.Socket.prototype.connect=oldConnect;
}
