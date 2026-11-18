import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// Agent voice choices (0460) against a disposable database through the real API service: each person's own choice
// (1-3) per AI teammate in one school; scope from the verified identity with the personal interface-preference
// permissions; forced RLS per school; closed values; idempotent replay, key reuse refused; audited; runtime can
// SELECT/INSERT/UPDATE only (no DELETE). Presentation only: no provider, no AI call.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|ELEVENLABS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {AgentVoiceService}=await import('../../../apps/api/dist/preferences/agent-voice.service.js');
const database=new RuntimeDatabaseService(),voices=new AgentVoiceService(database);
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const K=()=>randomUUID();
const ONE={hon:1,claire:1,alex:1,jordan:1,lena:1,marcus:1,chad:1,maya:1,kai:1};
const org={A:randomUUID(),B:randomUUID()},school={A1:randomUUID(),A2:randomUUID(),B1:randomUUID()},role={ownerA:randomUUID(),ownerB:randomUUID()};
const humans=Object.fromEntries(['ownerA','staffA','ownerB','outsider'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`voice-${k}-${randomUUID()}`}]));
const scopeFor=async(who,s,perm='settings.interface_theme.update')=>database.resolveAuthorizedScope(humans[who].subject,s,perm);
const ctx=(scope,key=K())=>{const requestId=randomUUID();return{organizationId:scope.organizationId,schoolId:scope.schoolId,principalId:scope.principalId,principalType:'HUMAN_USER',requestId,correlationId:requestId,idempotencyKey:key,source:'HUMAN_UI'};};
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const sqlCode=(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- table posture ----------
 const t=(await admin.query("SELECT c.relrowsecurity r,c.relforcerowsecurity f FROM pg_class c WHERE c.oid='hon.principal_agent_voice_preferences'::regclass")).rows[0];
 assert.deepEqual([t.r,t.f],[true,true],'forced RLS');
 const priv=(await admin.query("SELECT has_table_privilege($1,'hon.principal_agent_voice_preferences',p) a FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p",[runtime.username])).rows.map(r=>r.a);
 assert.deepEqual(priv,[true,true,true,false,false],'runtime: SELECT/INSERT/UPDATE only');
 for(const r of ['anon','authenticated','service_role'])if((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[r])).rowCount)
  assert.equal((await admin.query("SELECT has_table_privilege($1,'hon.principal_agent_voice_preferences','SELECT') a",[r])).rows[0].a,false,r);
 // Runtime with no tenant set sees nothing and cannot write.
 assert.equal((await restricted.query('SELECT count(*)::int n FROM hon.principal_agent_voice_preferences')).rows[0].n,0);

 // ---------- fixture: org A (schools A1, A2), org B (school B1) ----------
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);}
 for(const[o,name]of [[org.A,'Voice Fixture A'],[org.B,'Voice Fixture B']]){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o,name]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')",[o]);
 }
 for(const[s,o]of [[school.A1,org.A],[school.A2,org.A],[school.B1,org.B]])await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$1::text,$1::text,'America/New_York')",[s,o]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true),($3,$4,'OWNER','School Owner',true)",[role.ownerA,org.A,role.ownerB,org.B]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[role.ownerA,org.A]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[role.ownerB,org.B]);
 const grant=(who,o,s,r)=>admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[o,s,humans[who].id,r]);
 await grant('ownerA',org.A,school.A1,role.ownerA);await grant('ownerA',org.A,school.A2,role.ownerA);await grant('staffA',org.A,school.A1,role.ownerA);await grant('ownerB',org.B,school.B1,role.ownerB);
 await admin.query('COMMIT');

 // ---------- scope comes from the verified identity only ----------
 const a1=await scopeFor('ownerA',school.A1),a2=await scopeFor('ownerA',school.A2),s1=await scopeFor('staffA',school.A1),b1=await scopeFor('ownerB',school.B1);
 assert.ok(a1&&a2&&s1&&b1);
 assert.ok(!(await scopeFor('outsider',school.A1)),'no grant, no scope');
 assert.ok(!(await scopeFor('ownerB',school.A1)),'another organization\'s owner gets no scope here');
 assert.ok(!(await scopeFor('staffA',school.A2)),'not granted at A2');

 // ---------- defaults, save, replay, key reuse ----------
 assert.deepEqual((await voices.get(ctx(a1))).choices,ONE,'nothing chosen yet: every teammate on voice 1');
 const key=K();
 const saved=await voices.save(ctx(a1,key),{agentKey:'jordan',voiceChoice:3});
 assert.deepEqual(saved.choices,{...ONE,jordan:3});
 const replay=await voices.save(ctx(a1,key),{agentKey:'jordan',voiceChoice:3});
 assert.deepEqual([replay.replayed,replay.choices.jordan],[true,3],'exact retry replays');
 await assert.rejects(voices.save(ctx(a1,key),{agentKey:'jordan',voiceChoice:2}),http(409,'IDEMPOTENCY_KEY_REUSED'));
 assert.equal((await voices.save(ctx(a1),{agentKey:'lena',voiceChoice:2})).choices.lena,2);
 assert.deepEqual((await voices.save(ctx(a1),{agentKey:'jordan',voiceChoice:1})).choices,{...ONE,lena:2},'back to the original voice');
 assert.equal((await admin.query('SELECT count(*)::int n FROM hon.principal_agent_voice_preferences WHERE principal_id=$1',[humans.ownerA.id])).rows[0].n,2,'one row per teammate');
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND action_code='settings.agent_voice.update' AND actor_principal_id=$2",[org.A,humans.ownerA.id])).rows[0].n,3,'each change audited once (not the replay)');

 // ---------- isolation: per person, per school, per organization ----------
 assert.deepEqual((await voices.get(ctx(s1))).choices,ONE,'a colleague in the same school keeps their own voices');
 assert.deepEqual((await voices.get(ctx(a2))).choices,ONE,'the same person in another school starts fresh');
 assert.deepEqual((await voices.get(ctx(b1))).choices,ONE,'another organization sees nothing');
 // Runtime under school A2's tenant cannot see or change A1's rows.
 await restricted.query('BEGIN');
 try{
  await restricted.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true)",[org.A,school.A2]);
  assert.equal((await restricted.query('SELECT count(*)::int n FROM hon.principal_agent_voice_preferences')).rows[0].n,0,'RLS: A1 rows invisible from A2');
  const up=await restricted.query('UPDATE hon.principal_agent_voice_preferences SET voice_choice=3');
  assert.equal(up.rowCount,0,'RLS: nothing to update from A2');
  await sqlCode(restricted.query("INSERT INTO hon.principal_agent_voice_preferences(organization_id,school_id,principal_id,agent_key,voice_choice) VALUES($1,$2,$3,'hon',2)",[org.A,school.A1,humans.ownerA.id]),'42501');
 }finally{await restricted.query('ROLLBACK');}
 await restricted.query('BEGIN');
 try{
  await restricted.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true)",[org.A,school.A1]);
  await sqlCode(restricted.query('DELETE FROM hon.principal_agent_voice_preferences'),'42501');
 }finally{await restricted.query('ROLLBACK');}

 // ---------- closed values ----------
 for(const[agent,choice]of [['bob',1],['hon',0],['hon',4]])
  await sqlCode(admin.query("INSERT INTO hon.principal_agent_voice_preferences(organization_id,school_id,principal_id,agent_key,voice_choice) VALUES($1,$2,$3,$4,$5)",[org.A,school.A1,humans.staffA.id,agent,choice]),'23514');
 console.log('PASS agent voice preferences (0460): defaults, save, exact replay, key reuse refused, audit, per-person/school/organization isolation, forced RLS, runtime SELECT/INSERT/UPDATE only, closed values');
}finally{
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('DELETE FROM hon.principal_agent_voice_preferences WHERE organization_id=ANY($1::uuid[])',[Object.values(org)]).catch(()=>{});
 await Promise.all([admin.end(),restricted.end()]);
}
