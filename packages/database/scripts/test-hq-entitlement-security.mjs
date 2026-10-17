import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

// No configurable target: these aliases and the database marker are mandatory.
const urls=['DATABASE_URL','HON_RUNTIME_DATABASE_URL'].map(key=>{
  const u=new URL(process.env[key]??'');
  if(u.protocol!=='postgresql:'||u.hostname!=='localhost'||u.port!=='55432'||u.pathname!=='/hon_entitlement_validation'
    ||u.username!==(key==='DATABASE_URL'?'postgres':'hon_runtime')||!u.password||u.search||u.hash) throw new Error('HQ entitlement proof requires exact disposable localhost:55432 aliases.');
  return u.toString();
});
const owner=new pg.Client({connectionString:urls[0],ssl:false});
const runtime=new pg.Client({connectionString:urls[1],ssl:false});
const concurrent=new pg.Client({connectionString:urls[1],ssl:false});
const blocker=new pg.Client({connectionString:urls[0],ssl:false});
const org=randomUUID(), essential=randomUUID(), missing=randomUUID();
const subject='hq-entitlement-'+randomUUID(), operatorSubject='hq-operator-'+randomUUID(), noHqSubject='school-human-'+randomUUID();
const actor=randomUUID(), operator=randomUUID(), noHq=randomUUID(), grant=randomUUID();
const fingerprint=(o,t,v)=>createHash('sha256').update(`hq.entitlement.transition:${o}:${t}:${v}`).digest('hex');
const command=(client=runtime,o=org,t='COMPLETE',v=1,key=randomUUID(),sub=subject,fp=fingerprint(o,t,v))=>client.query(
  'SELECT hon.transition_organization_entitlement_from_hq($1,$2::uuid,$3,$4::integer,$5::uuid,$6,$7::uuid,$8::uuid) data',
  [sub,o,t,v,key,fp,randomUUID(),randomUUID()]).then(r=>r.rows[0].data);
let groups=0;
const deny=async(operation,code,label)=>{await assert.rejects(operation,e=>e.code===code,label);groups++;};
const canonical=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
const block=canonical.split('-- HQ entitlement transition exact verification:')[1]?.split('-- End HQ entitlement transition exact verification.')[0];
if(!block)throw new Error('Missing shared canonical HQ entitlement verifier.');
const verification='DO $$'+block.split('DO $$')[1];
const tables=[];
async function snapshot(){const state={};for(const t of tables)state[t]=(await owner.query(`SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]'::jsonb) data FROM (SELECT to_jsonb(t) row FROM hon."${t}" t) q`)).rows[0].data;return state;}
async function state(){return(await owner.query('SELECT tier::text,version,status::text,effective_from,updated_at,effective_until FROM hon.organization_entitlements WHERE organization_id=$1',[org])).rows[0];}
async function recheckRollback(sql,params=[]){await owner.query('BEGIN');try{await owner.query(sql,params);await deny(()=>owner.query(verification),'P0001','Canonical/JS-shared drift rejection');}finally{await owner.query('ROLLBACK');}}
await owner.connect();
try{
  const marker=(await owner.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;
  assert.equal(marker,'HON disposable entitlement boundary validation');
  await Promise.all([runtime.connect(),concurrent.connect(),blocker.connect()]);
  await owner.query(verification);groups++;
  await owner.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'HQ entitlement fixture','HQ entitlement fixture'),($2,'Legacy entitlement fixture','Legacy entitlement fixture'),($3,'No entitlement fixture','No entitlement fixture')",[org,essential,missing]);
  await owner.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE','ACTIVE',now()-interval '1 day'),($2,'ESSENTIAL','ACTIVE',now()-interval '1 day')",[org,essential]);
  for(const [sub,p] of [[subject,actor],[operatorSubject,operator],[noHqSubject,noHq]]){
    const u=randomUUID();await owner.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,'fixture@example.test','Fixture human')",[u,sub]);
    await owner.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Fixture human')",[p,u]);
  }
  await owner.query("INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role,effective_from) VALUES($1,$2,'HON_HQ_OWNER',now()-interval '1 day')",[grant,actor]);
  await owner.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OPERATOR',ARRAY['hq.entitlement.manage'],now()-interval '1 day')",[operator]);
  const school=randomUUID(), family=randomUUID(), familyGrant=randomUUID(), schoolRole=randomUUID();
  await owner.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1::uuid,$2::uuid,'Fixture school',$1::text)",[school,org]);
  await owner.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School owner',true)",[schoolRole,org]);
  await owner.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions',[schoolRole,org]);
  await owner.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5)',[org,school,noHq,schoolRole,actor]);
  await owner.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Fixture family')",[family,org,school]);
  tables.push(...(await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).rows.map(r=>r.tablename));
  const before=await snapshot(); const key=randomUUID();
  const result=await command(runtime,org,'COMPLETE',1,key);
  assert.deepEqual(Object.keys(result).sort(),['effectiveFrom','organizationId','priorTier','replayed','targetTier','version']);
  assert.equal(result.priorTier,'CORE');assert.equal(result.targetTier,'COMPLETE');assert.equal(result.version,2);assert.equal(result.replayed,false);
  const changed=await state();assert.equal(changed.tier,'COMPLETE');assert.equal(changed.version,2);assert.equal(changed.effective_from.toISOString(),changed.updated_at.toISOString());
  const after=await snapshot();
  for(const t of tables)if(!['organization_entitlements','hq_entitlement_requests','hq_entitlement_audit','hq_entitlement_outbox'].includes(t))assert.deepEqual(after[t],before[t],`No effects on ${t}`);
  assert.deepEqual(after.organization_entitlements.find(r=>r.organization_id===essential),before.organization_entitlements.find(r=>r.organization_id===essential),'Essential row preserved exactly, including version/window');
  const evidence=(await owner.query('SELECT a.prior_state,a.next_state,o.payload,r.status,r.response_body FROM hon.hq_entitlement_audit a JOIN hon.hq_entitlement_outbox o ON o.audit_id=a.id JOIN hon.hq_entitlement_requests r ON r.actor_principal_id=a.actor_principal_id AND r.idempotency_key=a.idempotency_key WHERE a.actor_principal_id=$1 AND a.idempotency_key=$2',[actor,key])).rows[0];
  assert.deepEqual(Object.keys(evidence.prior_state).sort(),['effectiveFrom','organizationId','tier','version']);
  assert.equal(evidence.prior_state.tier,'CORE');assert.equal(evidence.next_state.tier,'COMPLETE');assert.equal(evidence.status,'COMPLETED');assert.deepEqual(evidence.response_body,result);assert.equal(evidence.payload.executionAllowed,false);assert.equal(evidence.payload.internalOnly,true);
  assert(!/school|user|provider|price|credit|subscription|payment/i.test(JSON.stringify(evidence)));groups++;
  assert.deepEqual(await command(runtime,org,'COMPLETE',1,key),{...result,replayed:true});assert.deepEqual(await snapshot(),after,'Replay has zero mutation');groups++;
  await deny(()=>command(runtime,org,'CORE',2,key),'23505','Same actor/key different fingerprint');
  await deny(()=>command(runtime,org,'CORE',1),'40001','Stale version');
  await deny(()=>command(runtime,org,'COMPLETE',2),'40001','No-op target');
  const down=await command(runtime,org,'CORE',2,randomUUID(),operatorSubject);assert.equal(down.priorTier,'COMPLETE');assert.equal(down.targetTier,'CORE');assert.equal(down.version,3);groups++;
  assert.deepEqual(await command(runtime,org,'COMPLETE',1,key),{...result,replayed:true},'Historical receipt replay does not change current row');assert.equal((await state()).tier,'CORE');groups++;
  for(const target of ['CORE','COMPLETE'])await deny(()=>command(runtime,essential,target,1),'P0002','All Essential sources rejected');
  for(const source of ['CORE','COMPLETE','ESSENTIAL']){
    const o=source==='ESSENTIAL'?essential:org;
    if(source!=='ESSENTIAL')await owner.query('UPDATE hon.organization_entitlements SET tier=$2::hon.plan_tier WHERE organization_id=$1',[org,source]);
    await deny(()=>command(runtime,o,'ESSENTIAL',3),'22023','All Essential targets rejected');
  }
  await owner.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1",[org]);
  for(const target of [null,'core','COMPLETE ','AI'])await deny(()=>command(runtime,org,target,3),'22023','Closed target');
  for(const version of [0,-1,2147483647,null])await deny(()=>command(runtime,org,'COMPLETE',version),'22023','Safe positive integer');
  await deny(()=>command(runtime,missing,'COMPLETE',1),'P0002','Missing entitlement');
  await deny(()=>command(runtime,randomUUID(),'COMPLETE',1),'P0002','Unknown organization');
  await deny(()=>command(runtime,org,'COMPLETE',3,randomUUID(),subject,'a'.repeat(64)),'22023','Fingerprint bound to exact command');
  for(const sub of [noHqSubject,'unknown-subject'])await deny(()=>command(runtime,org,'COMPLETE',3,randomUUID(),sub),'42501','No HQ authority');
  await owner.query("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,'PRIMARY_GUARDIAN',$5)",[familyGrant,org,school,family,actor]);
  await deny(()=>command(runtime,org,'COMPLETE',3),'42501','HQ human with active family identity fails closed');
  await owner.query('DELETE FROM hon.family_access_grants WHERE id=$1',[familyGrant]);
  for(const permission of [[],['hq.entitlement.manage.extra'],['hq.ai.providers.manage']]){
    await owner.query('UPDATE hon.hq_operator_grants SET permission_codes=$2::text[] WHERE principal_id=$1',[operator,permission]);
    await deny(()=>command(runtime,org,'COMPLETE',3,randomUUID(),operatorSubject),'42501','Exact HQ operator permission required');
  }
  await owner.query("UPDATE hon.hq_operator_grants SET permission_codes=ARRAY['hq.entitlement.manage'],hq_role='HON_HQ_SUPPORT' WHERE principal_id=$1",[operator]);
  await deny(()=>command(runtime,org,'COMPLETE',3,randomUUID(),operatorSubject),'42501','Support cannot borrow operator permission');
  await owner.query("UPDATE hon.hq_operator_grants SET hq_role='HON_HQ_OPERATOR' WHERE principal_id=$1",[operator]);
  for(const update of ["effective_until=clock_timestamp()-interval '1 second'","effective_from=clock_timestamp()+interval '1 day',effective_until=NULL"]){
    await owner.query(`UPDATE hon.hq_operator_grants SET ${update} WHERE id=$1`,[grant]);
    await deny(()=>command(runtime,org,'COMPLETE',3),'42501','Expired/future owner grant');
  }
  await owner.query("UPDATE hon.hq_operator_grants SET effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE id=$1",[grant]);
  await owner.query('BEGIN');try{await owner.query('DELETE FROM hon.hq_operator_grants WHERE id=$1',[grant]);await owner.query('COMMIT');await deny(()=>command(runtime,org,'COMPLETE',3),'42501','Deleted/revoked owner grant');}catch(e){await owner.query('ROLLBACK');throw e;}
  await owner.query("INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role,effective_from) VALUES($1,$2,'HON_HQ_OWNER',now()-interval '1 day')",[grant,actor]);
  await owner.query('UPDATE hon.principals SET is_active=false WHERE id=$1',[actor]);await deny(()=>command(runtime,org,'COMPLETE',3),'42501','Inactive human');await owner.query('UPDATE hon.principals SET is_active=true WHERE id=$1',[actor]);
  const ambiguous=randomUUID();await owner.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) SELECT $2,'HUMAN_USER',user_id,'Ambiguous' FROM hon.principals WHERE id=$1",[actor,ambiguous]);
  await deny(()=>command(runtime,org,'COMPLETE',3),'42501','Ambiguous identity');await owner.query('DELETE FROM hon.principals WHERE id=$1',[ambiguous]);
  const machine=randomUUID();await owner.query("INSERT INTO hon.principals(id,principal_type,display_name) VALUES($1,'AI_EMPLOYEE','No human identity')",[machine]);await owner.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')",[machine]);
  await deny(()=>command(runtime,org,'COMPLETE',3,randomUUID(),machine),'42501','AI principal UUID cannot act as external subject');
  for(const setting of ['app.hon_organization_id','app.hon_school_id','app.hon_family_id','app.hon_principal_id','app.hon_principal_type','app.hon_source','app.hon_action_request_id','app.hon_delegated_by_principal_id']){
    await runtime.query('BEGIN');await runtime.query('SELECT set_config($1,$2,true)',[setting,'untrusted']);await deny(()=>command(runtime,org,'COMPLETE',3),'42501','Mixed tenant/family/action/nonhuman context');await runtime.query('ROLLBACK');
  }
  for(const state of ["status='SUSPENDED'","effective_from=clock_timestamp()+interval '1 day'","effective_from=clock_timestamp()-interval '2 days',effective_until=clock_timestamp()-interval '1 day'"]){
    await owner.query(`UPDATE hon.organization_entitlements SET ${state} WHERE organization_id=$1`,[org]);await deny(()=>command(runtime,org,'COMPLETE',3),'P0002','Only current active entitlement');
    await owner.query("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[org]);
  }
  const inProgress=randomUUID();await owner.query("INSERT INTO hon.hq_entitlement_requests(actor_principal_id,idempotency_key,request_fingerprint,request_id,correlation_id,status) VALUES($1,$2,$3,$4,$5,'IN_PROGRESS')",[actor,inProgress,fingerprint(org,'COMPLETE',3),randomUUID(),randomUUID()]);
  await deny(()=>command(runtime,org,'COMPLETE',3,inProgress),'55P03','Persisted in-progress is never a success');
  await runtime.query('BEGIN');const concurrentKey=randomUUID();const pending=await command(runtime,org,'COMPLETE',3,concurrentKey);assert.equal(pending.version,4);
  await deny(()=>command(concurrent,org,'COMPLETE',3,concurrentKey),'55P03','Same-key concurrent attempt fails closed');
  const waiting=command(concurrent,org,'COMPLETE',3,randomUUID());
  await runtime.query('COMMIT');await deny(()=>waiting,'40001','Distinct concurrent key cannot double-transition stale row');
  assert.deepEqual(await command(concurrent,org,'COMPLETE',3,concurrentKey),{...pending,replayed:true});groups++;
  // Transaction rollback, then the same key may safely be retried.
  const rollbackKey=randomUUID(), rollbackBefore=await snapshot();await runtime.query('BEGIN');await command(runtime,org,'CORE',4,rollbackKey);await runtime.query('ROLLBACK');assert.deepEqual(await snapshot(),rollbackBefore,'Rollback removes row/audit/outbox/receipt atomically');groups++;
  const committedDown=await command(runtime,org,'CORE',4,rollbackKey);assert.equal(committedDown.version,5);groups++;
  // Inject failures at both evidence stages: each must roll back the entire call.
  await owner.query("CREATE FUNCTION hon.fixture_fail_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture evidence failure' USING ERRCODE='23514'; END $$");
  for(const table of ['hq_entitlement_audit','hq_entitlement_outbox']){
    await owner.query(`CREATE TRIGGER fixture_fail BEFORE INSERT ON hon.${table} FOR EACH ROW EXECUTE FUNCTION hon.fixture_fail_entitlement()`);
    const atomicBefore=await snapshot();await deny(()=>command(runtime,org,'COMPLETE',5),'23514','Atomic evidence failure');assert.deepEqual(await snapshot(),atomicBefore,'Audit/outbox failure has zero partial state');
    await owner.query(`DROP TRIGGER fixture_fail ON hon.${table}`);
  }
  await owner.query('DROP FUNCTION hon.fixture_fail_entitlement()');
  // Live authority expires while waiting for the exact entitlement row lock.
  await owner.query("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",[grant]);
  await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM hon.organization_entitlements WHERE organization_id=$1 FOR UPDATE',[org]);
  const expiredWait=command(runtime,org,'COMPLETE',5);await new Promise(resolve=>setTimeout(resolve,650));await blocker.query('COMMIT');await deny(()=>expiredWait,'42501','Lock-time HQ grant expiry rechecked');
  await owner.query('UPDATE hon.hq_operator_grants SET effective_until=NULL WHERE id=$1',[grant]);
  // Revocation committed while the command is blocked at the authority lock.
  await blocker.query('BEGIN');await blocker.query('UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp()-interval \'1 second\' WHERE id=$1',[grant]);
  const revokedWait=command(runtime,org,'COMPLETE',5);await new Promise(resolve=>setTimeout(resolve,100));await blocker.query('COMMIT');await deny(()=>revokedWait,'42501','Lock-time grant revocation rechecked');
  await owner.query('UPDATE hon.hq_operator_grants SET effective_until=NULL WHERE id=$1',[grant]);
  for(const t of ['organization_entitlements','hq_entitlement_requests','hq_entitlement_audit','hq_entitlement_outbox']){
    for(const sql of [`SELECT * FROM hon.${t}`,`UPDATE hon.${t} SET ${t==='organization_entitlements'?"tier='COMPLETE'":t==='hq_entitlement_requests'?"status='COMPLETED'":t==='hq_entitlement_audit'?"action_code='hq.entitlement.transition'":"event_type='hq.organization.entitlement.changed'"}`,`DELETE FROM hon.${t}`,`TRUNCATE hon.${t}`])await deny(()=>runtime.query(sql),'42501','No direct table ACL');
  }
  for(const sql of ['SET ROLE postgres','ALTER ROLE hon_runtime BYPASSRLS','GRANT postgres TO hon_runtime','CREATE TABLE hon.entitlement_escalation(id int)','SELECT hon.require_hq_entitlement_actor(\'x\')'])await deny(()=>runtime.query(sql),'42501','No escalation/private helper execute');
  for(const table of ['hq_entitlement_requests','hq_entitlement_audit','hq_entitlement_outbox'])for(const verb of ['UPDATE','DELETE','TRUNCATE']){
    const sql=verb==='UPDATE'?`UPDATE hon.${table} SET ${table==='hq_entitlement_requests'?"status=status":table==='hq_entitlement_audit'?"action_code=action_code":"event_type=event_type"} WHERE ${table==='hq_entitlement_requests'?"status='COMPLETED'":"true"}`:verb==='DELETE'?`DELETE FROM hon.${table}`:`TRUNCATE hon.${table} CASCADE`;
    await deny(()=>owner.query(sql),'42501','Evidence immutable even to owner DML');
  }
  for(const drift of [
    'GRANT UPDATE(tier) ON hon.organization_entitlements TO hon_runtime',
    'GRANT SELECT ON hon.hq_entitlement_audit TO PUBLIC',
    'GRANT SELECT(response_body) ON hon.hq_entitlement_requests TO hon_runtime',
    'ALTER ROLE hon_runtime BYPASSRLS','ALTER ROLE hon_runtime CREATEROLE','GRANT postgres TO hon_runtime',
    'ALTER TABLE hon.hq_entitlement_outbox NO FORCE ROW LEVEL SECURITY',
    'CREATE POLICY leaked ON hon.hq_entitlement_audit USING(true)',
    'ALTER TABLE hon.hq_entitlement_audit DISABLE TRIGGER hq_entitlement_immutable',
    'GRANT EXECUTE ON FUNCTION hon.require_hq_entitlement_actor(text) TO hon_runtime',
    'GRANT EXECUTE ON FUNCTION hon.transition_organization_entitlement_from_hq(text,uuid,text,integer,uuid,text,uuid,uuid) TO PUBLIC',
    'GRANT EXECUTE ON FUNCTION hon.transition_organization_entitlement_from_hq(text,uuid,text,integer,uuid,text,uuid,uuid) TO hon_runtime WITH GRANT OPTION',
    'ALTER FUNCTION hon.transition_organization_entitlement_from_hq(text,uuid,text,integer,uuid,text,uuid,uuid) SECURITY INVOKER',
    'ALTER FUNCTION hon.transition_organization_entitlement_from_hq(text,uuid,text,integer,uuid,text,uuid,uuid) SET search_path=public,hon',
    'ALTER FUNCTION hon.transition_organization_entitlement_from_hq(text,uuid,text,integer,uuid,text,uuid,uuid) OWNER TO hon_runtime',
    "CREATE OR REPLACE FUNCTION hon.require_hq_entitlement_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$ BEGIN RETURN NULL; END $$",
    "CREATE FUNCTION hon.transition_organization_entitlement_from_hq(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$",
  ])await recheckRollback(drift);
  await owner.query(verification);groups++;
  // Existing school tier gates observe only their own selector-free fixed reader.
  for(const [target,version] of [['COMPLETE',5],['CORE',6]]){
    await command(runtime,org,target,version);
    await concurrent.query('BEGIN');await concurrent.query("SELECT set_config('app.hon_organization_id',$1,true)",[org]);
    assert.deepEqual((await concurrent.query('SELECT * FROM hon.read_current_organization_entitlement()')).rows,[{tier:target}]);
    await deny(()=>concurrent.query('SELECT tier FROM hon.organization_entitlements'),'42501','School cannot mutate/read source entitlement');await concurrent.query('ROLLBACK');groups++;
  }
  assert.deepEqual((await runtime.query('SELECT * FROM hon.read_current_organization_entitlement()')).rows,[]);groups++;
  console.log(`PASS: ${groups} assertion groups; ${tables.length} HON-table no-effect snapshots; Core->Complete/Complete->Core, every Essential source/target rejection, exact owner/operator and context denials, locked expiry/revocation, stale/replay/key binding/concurrency, atomic rollback/audit/outbox failure, immutable private evidence, ACL/escalation and 17 canonical/JS-shared drift denials; fixed school entitlement reader; zero external calls.`);
}finally{
  await Promise.all([runtime,concurrent,blocker].map(async c=>{await c.query('ROLLBACK').catch(()=>{});await c.end().catch(()=>{});}));await owner.end();
}
