import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// Interface language persistence (0171) integrity proof against a disposable database through the real API service:
// personal preference bound to the verified user (never a browser-supplied id) and portable across schools and
// organizations; school default set only with settings.language.manage at that exact school, audited, never
// overwriting personal preferences; precedence personal > named school default > English; idempotent,
// version-checked and race-safe updates; closed input; deny-all tables and private helpers.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {LanguagePreferencesService}=await import('../../../apps/api/dist/preferences/language-preferences.controller.js');
const database=new RuntimeDatabaseService(),languages=new LanguagePreferencesService(database);
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const tables=['language_audit','language_requests','school_language_defaults','user_language_preferences'];
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code='42501')=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID();
const org={A:randomUUID(),B:randomUUID()},school={A1:randomUUID(),A2:randomUUID(),B1:randomUUID()},role={ownerA:randomUUID(),frontA:randomUUID(),ownerB:randomUUID()};
const family=randomUUID();
const humans=Object.fromEntries(['ownerA1','staffA','ownerB1','parentA1','hq','dual','inactive','newA1','mixed'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`lang-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject;
const mine=(who,schoolId)=>languages.readMine(H(who),schoolId?{schoolId}:{});
const setMine=(who,language,expectedVersion,key=K())=>languages.updateMine(H(who),{language,expectedVersion},key);
const readSchool=(who,s)=>languages.readSchool(H(who),s);
const setSchool=(who,s,language,expectedVersion,key=K())=>languages.updateSchool(H(who),s,{language,expectedVersion},key);
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  for(const t of tables)await admin.query(`DELETE FROM hon.${t}`);
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('DELETE FROM hon.family_access_grants WHERE organization_id=ANY($1::uuid[])',[Object.values(org)]);
  await admin.query('DELETE FROM hon.families WHERE organization_id=ANY($1::uuid[])',[Object.values(org)]);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[Object.values(org)]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[Object.values(org)]);
  // Fixture identities (random subjects) stay in the disposable database, as in the other proofs.
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const prefs=async()=>(await admin.query('SELECT user_id,language,version FROM hon.user_language_preferences ORDER BY user_id')).rows;

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- runtime posture ----------
 for(const t of tables)await sqlDeny(restricted.query(`SELECT * FROM hon.${t}`));
 for(const sig of ['language_actor(text)','language_school_member(uuid,uuid)','language_school_manager(uuid,uuid)','language_replay(uuid,uuid,text,text)','language_input(jsonb)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,false,sig);
 await cleanup();

 // ---------- fixture: organization A (schools A1, A2), organization B (school B1) ----------
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',$3)",[h.id,h.user,h!==humans.inactive]);}
 await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[randomUUID(),humans.dual.user]); // two active principals
 await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '1 hour')",[humans.hq.id]);
 for(const[o,name]of [[org.A,'Lang Fixture A'],[org.B,'Lang Fixture B']]){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o,name]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')",[o]);
 }
 for(const[s,o]of [[school.A1,org.A],[school.A2,org.A],[school.B1,org.B]])await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$1::text,$1::text,'America/New_York')",[s,o]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true),($3,$4,'OWNER','School Owner',true),($5,$2,'FRONT_DESK','Front desk',false)",[role.ownerA,org.A,role.ownerB,org.B,role.frontA]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[role.ownerA,org.A]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[role.ownerB,org.B]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions WHERE code<>'settings.language.manage' AND is_staff_assignable",[role.frontA,org.A]);
 const grant=(who,o,s,r)=>admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[o,s,humans[who].id,r]);
 await grant('ownerA1',org.A,school.A1,role.ownerA);await grant('staffA',org.A,school.A1,role.frontA);await grant('staffA',org.A,school.A2,role.frontA);
 await grant('mixed',org.A,school.A1,role.ownerA);await grant('mixed',org.A,school.A2,role.frontA); // manager at A1, plain staff at A2
 await grant('newA1',org.A,school.A1,role.frontA);await grant('ownerB1',org.B,school.B1,role.ownerB);await grant('dual',org.A,school.A1,role.frontA);
 await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Fixture family')",[family,org.A,school.A1]);
 await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',clock_timestamp()-interval '1 hour',$5)",[org.A,school.A1,family,humans.parentA1.id,humans.ownerA1.id]);
 await admin.query('COMMIT');
 const themesBefore=(await admin.query('SELECT to_jsonb(t)::text r FROM hon.principal_interface_preferences t ORDER BY 1')).rows;
 // Existing system OWNER roles received the new permission.
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.permissions WHERE code='settings.language.manage' AND is_staff_assignable AND NOT is_sensitive")).rows[0].n,1);

 // ---------- 1. defaults: English when nothing is set ----------
 let v=await mine('staffA');
 assert.deepEqual([v.preference,v.schoolDefault,v.effective,v.supportedLanguages],[null,null,{language:'en',source:'SYSTEM_DEFAULT'},['en','ko','es']]);
 v=await mine('staffA',school.A1);
 assert.deepEqual([v.schoolDefault.defaultLanguage,v.schoolDefault.source,v.schoolDefault.version,v.effective.source],['en','SYSTEM_DEFAULT',0,'SYSTEM_DEFAULT']);
 for(const who of ['dual','inactive'])await deny(mine(who),403,'LANGUAGE_FORBIDDEN'); // ambiguous or inactive identity
 await deny(languages.readMine('lang-unknown-subject',{}),403,'LANGUAGE_FORBIDDEN');

 // ---------- 2. personal preference: self only, versioned, idempotent ----------
 const k1=K();
 let r=await setMine('staffA','ko',0,k1);
 assert.deepEqual([r.preference.language,r.preference.version,r.replayed],['ko',1,false]);
 assert.deepEqual([(await setMine('staffA','ko',0,k1)).replayed,(await setMine('staffA','ko',0,k1)).preference.version],[true,1],'a retry with the same key is a replay');
 await deny(setMine('staffA','es',0,k1),409,'IDEMPOTENCY_KEY_REUSED');
 await deny(setMine('staffA','es',0),409,'LANGUAGE_VERSION_CONFLICT'); // stale version
 r=await setMine('staffA','es',1);
 assert.deepEqual([r.preference.language,r.preference.version],['es',2]);
 // The preference belongs to the user, not to a school or session: every school context and a fresh service see it.
 for(const s of [undefined,school.A1,school.A2])assert.deepEqual((await mine('staffA',s)).effective,{language:'es',source:'PERSONAL'});
 assert.equal((await new LanguagePreferencesService(new RuntimeDatabaseService()).readMine(H('staffA'),{})).preference.language,'es');
 // No user id is accepted from the request; another user is unaffected.
 for(const bad of [{language:'es',expectedVersion:0,userId:humans.ownerA1.user},{language:'fr',expectedVersion:0},{language:'EN',expectedVersion:0},
  {language:'en'},{language:'en',expectedVersion:-1},{language:'en',expectedVersion:1.5},{language:'en',expectedVersion:'0'},[],null])
  await deny(languages.updateMine(H('ownerA1'),bad,K()),400,'INVALID_LANGUAGE_INPUT');
 await deny(languages.updateMine(H('ownerA1'),{language:'en',expectedVersion:0},'not-a-uuid'),400,'INVALID_LANGUAGE_INPUT');
 await deny(languages.readMine(H('staffA'),{userId:humans.ownerA1.user}),400,'INVALID_LANGUAGE_INPUT');
 assert.equal((await mine('ownerA1')).preference,null);
 // HQ and family identities have personal preferences too.
 assert.equal((await setMine('hq','ko',0)).preference.language,'ko');
 assert.equal((await setMine('parentA1','es',0)).preference.language,'es');

 // ---------- 3. school default: exact-school manager only, audited ----------
 for(const[who,s]of [['staffA',school.A1],['ownerA1',school.A2],['ownerA1',school.B1],['ownerB1',school.A1],['hq',school.A1],['parentA1',school.A1],['dual',school.A1]])
  await deny(setSchool(who,s,'ko',0),403,'LANGUAGE_FORBIDDEN');
 await deny(setSchool('ownerA1',randomUUID(),'ko',0),403,'LANGUAGE_FORBIDDEN');
 await deny(setSchool('mixed',school.A2,'ko',0),403,'LANGUAGE_FORBIDDEN'); // a manager at A1 cannot set A2, where they are plain staff
 assert.equal((await readSchool('mixed',school.A2)).canManage,false);
 const before=await prefs();
 r=await setSchool('ownerA1',school.A1,'ko',0);
 assert.deepEqual([r.schoolDefault.schoolId,r.schoolDefault.organizationId,r.schoolDefault.defaultLanguage,r.schoolDefault.source,r.schoolDefault.version,r.replayed],
  [school.A1,org.A,'ko','SCHOOL',1,false]);
 await deny(setSchool('ownerA1',school.A1,'es',0),409,'LANGUAGE_VERSION_CONFLICT');
 r=await setSchool('ownerA1',school.A1,'es',1);
 assert.equal(r.schoolDefault.version,2);
 assert.deepEqual(await prefs(),before,'a school default never overwrites personal preferences');
 // Reads: members of the school only; canManage reflects the exact-school permission.
 assert.deepEqual([(await readSchool('ownerA1',school.A1)).canManage,(await readSchool('staffA',school.A1)).canManage,(await readSchool('parentA1',school.A1)).canManage],[true,false,false]);
 assert.equal((await readSchool('staffA',school.A2)).source,'SYSTEM_DEFAULT');
 for(const[who,s]of [['ownerB1',school.A1],['ownerA1',school.B1],['hq',school.A1],['parentA1',school.A2]])await deny(readSchool(who,s),403,'LANGUAGE_FORBIDDEN');
 for(const[who,s]of [['ownerB1',school.A1],['parentA1',school.A2]])await deny(mine(who,s),403,'LANGUAGE_FORBIDDEN'); // no other school's settings disclosed

 // ---------- 4. precedence: personal > the named school's default > English ----------
 assert.deepEqual((await mine('newA1',school.A1)).effective,{language:'es',source:'SCHOOL_DEFAULT'});
 assert.deepEqual((await mine('newA1')).effective,{language:'en',source:'SYSTEM_DEFAULT'},'no school is guessed');
 assert.deepEqual((await mine('ownerA1',school.A1)).effective,{language:'es',source:'SCHOOL_DEFAULT'});
 assert.deepEqual((await mine('parentA1',school.A1)).effective,{language:'es',source:'PERSONAL'});
 assert.deepEqual((await mine('staffA',school.A1)).effective,{language:'es',source:'PERSONAL'});
 await setMine('newA1','ko',0);
 assert.deepEqual((await mine('newA1',school.A1)).effective,{language:'ko',source:'PERSONAL'});
 // Multi-school staff: each school's default applies only when that school is named.
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[org.A,school.A2,humans.ownerA1.id,role.ownerA]);
 await setSchool('ownerA1',school.A2,'ko',0);
 assert.deepEqual([(await mine('ownerA1',school.A1)).effective.language,(await mine('ownerA1',school.A2)).effective.language,(await mine('ownerA1')).effective.language],['es','ko','en']);
 // A revoked grant loses both read and manage at once.
 await admin.query("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE principal_id=$1 AND school_id=$3",[humans.ownerA1.id,humans.ownerB1.id,school.A2]);
 await deny(setSchool('ownerA1',school.A2,'en',1),403,'LANGUAGE_FORBIDDEN');
 await deny(readSchool('ownerA1',school.A2),403,'LANGUAGE_FORBIDDEN');

 // ---------- 5. audit history ----------
 const audit=(await admin.query("SELECT scope,school_id,organization_id,user_id,actor_principal_id,prior_language,next_language,version FROM hon.language_audit WHERE scope='SCHOOL_DEFAULT' ORDER BY occurred_at")).rows;
 assert.deepEqual(audit.map(a=>[a.school_id,a.organization_id,a.actor_principal_id,a.prior_language,a.next_language,a.version]),
  [[school.A1,org.A,humans.ownerA1.id,null,'ko',1],[school.A1,org.A,humans.ownerA1.id,'ko','es',2],[school.A2,org.A,humans.ownerA1.id,null,'ko',1]]);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.language_audit WHERE scope='PERSONAL' AND user_id=$1",[humans.staffA.user])).rows[0].n,2);
 // Append-only evidence; preference rows only move forward by one version.
 for(const sql of ["UPDATE hon.language_audit SET next_language='en'","DELETE FROM hon.language_audit","DELETE FROM hon.language_requests",
  "DELETE FROM hon.user_language_preferences","DELETE FROM hon.school_language_defaults","TRUNCATE hon.language_audit CASCADE"])await sqlDeny(admin.query(sql));
 await sqlDeny(admin.query("UPDATE hon.user_language_preferences SET user_id=$1 WHERE user_id=$2",[humans.ownerA1.user,humans.staffA.user]));
 await sqlDeny(admin.query("UPDATE hon.user_language_preferences SET language='en' WHERE user_id=$1",[humans.staffA.user])); // no version step
 await sqlDeny(admin.query("UPDATE hon.school_language_defaults SET organization_id=$1, version=version+1 WHERE school_id=$2",[org.B,school.A1]));
 await sqlDeny(admin.query("INSERT INTO hon.user_language_preferences VALUES($1,'fr',1,now(),now())",[humans.ownerB1.user]),'23514');

 // ---------- 6. concurrency: one winner per version; one effect per key ----------
 await Promise.all(Array.from({length:8},()=>database.callLanguage('readMine',[H('ownerB1'),null]))); // warm the pool so the races overlap
 const race=await Promise.allSettled(Array.from({length:6},(_,i)=>setMine('ownerB1',i%2?'ko':'es',0)));
 assert.equal(race.filter(x=>x.status==='fulfilled').length,1,JSON.stringify(race.map(x=>x.status)));
 for(const x of race.filter(x=>x.status==='rejected'))http(409,'LANGUAGE_VERSION_CONFLICT')(x.reason);
 const sameKey=K();
 const dup=await Promise.all(Array.from({length:6},()=>setSchool('ownerB1',school.B1,'ko',0,sameKey)));
 assert.deepEqual([dup.filter(d=>!d.replayed).length,new Set(dup.map(d=>d.schoolDefault.version)).size],[1,1]);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.language_audit WHERE school_id=$1",[school.B1])).rows[0].n,1);

 // ---------- 7. tenant or action context is refused; appearance untouched ----------
 await restricted.query('BEGIN');
 await restricted.query("SELECT set_config('app.hon_organization_id',$1,true)",[org.A]);
 await sqlDeny(restricted.query('SELECT hon.read_my_language_preference($1,NULL)',[H('staffA')]));
 await restricted.query('ROLLBACK');
 await restricted.query('BEGIN');
 await restricted.query("SELECT set_config('app.hon_principal_id',$1,true)",[humans.ownerA1.id]);
 await sqlDeny(restricted.query('SELECT hon.set_my_language_preference($1,$2::jsonb,$3,$4,$5)',[H('ownerA1'),'{"language":"ko","expectedVersion":0}',K(),K(),K()]));
 await restricted.query('ROLLBACK');
 assert.deepEqual((await admin.query('SELECT to_jsonb(t)::text r FROM hon.principal_interface_preferences t ORDER BY 1')).rows,themesBefore,'appearance preferences are independent');
 console.log('PASS: interface language persistence — personal preference bound to the verified user and portable across schools and sessions (HQ, staff, family; ambiguous/inactive identities refused); school default only with settings.language.manage at the exact school, audited, never overwriting personal preferences; personal > named school default > English with no guessed school; revoked grants lose access; closed input; idempotent replays, key reuse and stale versions refused; exactly one winner under concurrent updates; append-only evidence; tenant/action context refused; appearance untouched.');
}finally{
 await cleanup().catch(e=>console.error('cleanup failed',e.message));
 await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy?.()]);
}
