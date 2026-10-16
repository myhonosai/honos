import { loadOwnerLaunchValidationEnv } from './owner-launch-env.mjs';
loadOwnerLaunchValidationEnv();
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { ownerLaunchTables, ownerLaunchFunctions, verifyOwnerLaunchSecurity } from './owner-launch-security.mjs';
const { RuntimeDatabaseService }=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { OwnerLaunchService }=await import('../../../apps/api/dist/owner-launch/owner-launch.service.js');
const { ProgramService }=await import('../../../apps/api/dist/programs/program.service.js');
const { ClassSessionService }=await import('../../../apps/api/dist/schedule/class-session.service.js');
const { HqOnboardingService }=await import('../../../apps/api/dist/hq/hq-onboarding.service.js');
let groups=0,operations=0,driftProbes=0,externalCalls=0;
const forbid=()=>{externalCalls++;throw new Error('External transport forbidden in owner launch proof');};
globalThis.fetch=forbid;http.request=forbid;http.get=forbid;https.request=forbid;https.get=forbid;
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const o=Array.isArray(args[0])?args[0][0]:args[0];if(!(typeof o==='object'?o.port===5432&&o.host==='localhost':o===5432&&args[1]==='localhost'))return forbid();return connect.apply(this,args);};
const owner=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false}),runtime=new pg.Client({connectionString:process.env.HON_RUNTIME_DATABASE_URL,ssl:false});
const database=new RuntimeDatabaseService(),service=new OwnerLaunchService(database),programs=new ProgramService(database),classes=new ClassSessionService(database),hq=new HqOnboardingService(database);
const ids=Object.fromEntries(['hqUser','hqPrincipal','user','principal','otherUser','otherPrincipal','grant','otherGrant','family'].map(k=>[k,randomUUID()]));
const subject='owner-local-'+randomUUID(),otherSubject='owner-other-'+randomUUID(),hqSubject='hq-local-'+randomUUID();
let scope,other,program,classSession,tables;
const context=(patch={})=>{const requestId=randomUUID();return{...scope,externalSubject:subject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId,correlationId:requestId,idempotencyKey:randomUUID(),...patch};};
const status=n=>e=>e?.getStatus?.()===n,check=()=>groups++;
async function snapshot(){const result={};for(const table of tables){assert(/^[a-z_]+$/.test(table));result[table]=(await owner.query(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) hash FROM hon.${table} t`)).rows[0].hash;}return result;}
async function checked(work,allowed=[]){const before=await snapshot();try{const result=await work();operations++;const after=await snapshot();for(const table of tables)if(!allowed.includes(table))assert.equal(after[table],before[table],'Unexpected write: '+table);return result;}catch(error){assert.deepEqual(await snapshot(),before,'Denied command wrote data');throw error;}}
async function raw(c,sql,args){await runtime.query('BEGIN');try{await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_source',$5,true),set_config('app.hon_external_subject',$6,true),set_config('app.hon_action_request_id',$7,true),set_config('app.hon_delegated_by_principal_id',$8,true),set_config('app.hon_request_id',$9,true)",[c.organizationId,c.schoolId,c.principalId,c.principalType,c.source,c.externalSubject,c.actionRequestId??'',c.delegatedByPrincipalId??'',c.requestId]);return await runtime.query(sql,args);}finally{await runtime.query('ROLLBACK');}}
const registrationEffects=['people','student_profiles','student_curriculum_enrollments',...ownerLaunchTables,'audit_events'];
const input=(patch={})=>({programId:program.id,expectedProgramVersion:program.version,classSessionId:classSession.id,expectedClassSessionVersion:classSession.version,givenName:'Private adult '+randomUUID(),familyName:'PII_CANARY_FAMILY',birthDate:'1990-02-03',attestation:'NEW_ADULT_NO_GUARDIAN_REQUIRED',...patch});
const register=(value,c=context())=>checked(()=>service.register(c,value),registrationEffects);
async function drift(sql){await owner.query('BEGIN');try{await owner.query(sql);await assert.rejects(()=>verifyOwnerLaunchSecurity(owner,'hon_owner_launch_runtime'));driftProbes++;}finally{await owner.query('ROLLBACK');}}
await owner.connect();await runtime.connect();
try {
 const marker=(await owner.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];assert.equal(marker.owner,'hon_owner_launch_owner');assert.equal(marker.marker,'HON disposable owner_launch validation');
 await verifyOwnerLaunchSecurity(owner,'hon_owner_launch_runtime');
 const canonical=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_owner_launch_runtime');await owner.query(canonical);check();
 const flags=(await runtime.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname=current_user')).rows[0];assert(Object.values(flags).every(v=>v===false));check();
 for(const table of ownerLaunchTables){
  for(const sql of [`SELECT * FROM hon.${table}`,`INSERT INTO hon.${table} DEFAULT VALUES`,`UPDATE hon.${table} SET school_id=school_id`,`DELETE FROM hon.${table}`,`TRUNCATE hon.${table}`])await assert.rejects(()=>runtime.query(sql),e=>e.code==='42501');
  for(const sql of [`GRANT SELECT ON hon.${table} TO hon_owner_launch_runtime`,`GRANT SELECT(school_id) ON hon.${table} TO PUBLIC`,`ALTER TABLE hon.${table} NO FORCE ROW LEVEL SECURITY`,`CREATE POLICY launch_drift ON hon.${table} USING(true)`,`ALTER TABLE hon.${table} DISABLE TRIGGER registration_immutable`,`ALTER TABLE hon.${table} DISABLE TRIGGER registration_no_truncate`])await drift(sql);
 }
 for(const [f,executable]of ownerLaunchFunctions)for(const sql of [`GRANT EXECUTE ON FUNCTION hon.${f} TO PUBLIC`,`GRANT EXECUTE ON FUNCTION hon.${f} TO hon_owner_launch_runtime WITH GRANT OPTION`,...(executable?[`REVOKE EXECUTE ON FUNCTION hon.${f} FROM hon_owner_launch_runtime`]:[])])await drift(sql);
 for(const sql of ['ALTER TABLE hon.student_curriculum_enrollments DROP CONSTRAINT enrollment_program_scope_fk','ALTER TABLE hon.student_curriculum_enrollments DROP CONSTRAINT enrollment_truthful_target','ALTER TABLE hon.student_registration_outbox DROP CONSTRAINT student_registration_outbox_state_check'])await drift(sql);check();
 for(const [u,p,sub]of [[ids.hqUser,ids.hqPrincipal,hqSubject],[ids.user,ids.principal,subject],[ids.otherUser,ids.otherPrincipal,otherSubject]]){
  await owner.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$1::uuid::text||'@example.test','Local fixture human')",[u,sub]);
  await owner.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Local fixture human')",[p,u]);
 }
 await owner.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')",[ids.hqPrincipal]);
 const provision=async(name,tier)=>hq.provisionInitialSchool({externalSubject:hqSubject},{legalName:'Local '+name,displayName:'Local '+name,schoolName:'Local '+name,schoolSlug:'local-'+randomUUID(),timezone:'UTC',initialTier:tier,idempotencyKey:randomUUID()});
 const a=await provision('launch','ESSENTIAL'),b=await provision('other','CORE');
 for(const [school,p,g]of [[a,ids.principal,ids.grant],[b,ids.otherPrincipal,ids.otherGrant]])await owner.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)',[g,school.organizationId,school.schoolId,p,school.ownerRoleId]);
 scope={organizationId:a.organizationId,schoolId:a.schoolId,principalId:ids.principal};other={organizationId:b.organizationId,schoolId:b.schoolId,principalId:ids.otherPrincipal,externalSubject:otherSubject};
 tables=(await owner.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hon' AND relkind='r' ORDER BY relname")).rows.map(r=>r.relname);
 assert.deepEqual(await checked(()=>database.resolveOwnerLaunchScope(subject)),scope);assert.equal(await checked(()=>database.resolveOwnerLaunchScope(hqSubject)),undefined);
 const empty=await checked(()=>service.read(context()));assert.equal(empty.program,null);assert.equal(empty.classSession,null);assert.equal(empty.registration,null);check();
 const pc=context(),pvalue={name:'First program '+randomUUID()};
 const p=await checked(()=>programs.create(pc,pvalue),['programs','idempotency_records','audit_events','outbox_events']);program=p.program;assert.equal(p.replayed,false);
 assert.equal((await checked(()=>programs.create(pc,pvalue))).replayed,true);
 const cc=context(),cvalue={programId:program.id,name:'First class',startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString(),capacity:10,bookingPolicy:'OPTIONAL_BOOKING'};
 const c=await checked(()=>classes.create(cc,cvalue),['class_sessions','idempotency_records','audit_events','outbox_events']);classSession=c.classSession;
 assert.equal((await checked(()=>classes.create(cc,cvalue))).replayed,true);
 const beforeRegistration=await checked(()=>service.read(context()));assert.equal(beforeRegistration.program.id,program.id);assert.equal(beforeRegistration.classSession.id,classSession.id);check();
 const value=input(),rc=context(),registered=await register(value,rc);assert.equal(registered.replayed,false);assert.equal(registered.receipt.status,'REGISTERED_NO_BOOKING');assert(!JSON.stringify(registered).includes('PII_CANARY'));check();
 const relation=(await owner.query('SELECT s.person_id,s.primary_family_id,s.birth_date,e.student_profile_id,e.program_id,e.curriculum_id,e.current_rank_id,e.version FROM hon.student_profiles s JOIN hon.student_curriculum_enrollments e ON e.student_profile_id=s.id WHERE s.id=$1',[registered.receipt.studentProfileId])).rows[0];
 assert.equal(relation.primary_family_id,null);assert.equal(relation.student_profile_id,registered.receipt.studentProfileId);assert.equal(relation.program_id,program.id);assert.equal(relation.curriculum_id,null);assert.equal(relation.current_rank_id,null);assert.equal(relation.version,1);check();
 const replay=await checked(()=>service.register(rc,value));assert.deepEqual(replay.receipt,registered.receipt);assert.equal(replay.replayed,true);
 assert.deepEqual((await checked(()=>service.read(context()))).registration,registered.receipt);
 await assert.rejects(()=>checked(()=>service.register(rc,{...value,givenName:'Different'})),status(409));
 await assert.rejects(()=>register(value),status(400));check();
 const concurrentInput=input(),concurrentContext=context();const results=await checked(()=>Promise.all([service.register(concurrentContext,concurrentInput),service.register(concurrentContext,concurrentInput)]),registrationEffects);
 assert.deepEqual(results[0].receipt,results[1].receipt);assert.equal(results.filter(r=>r.replayed).length,1);check();
 const duplicate=input();const duplicates=await checked(()=>Promise.allSettled([service.register(context(),duplicate),service.register(context(),duplicate)]),registrationEffects);assert.equal(duplicates.filter(r=>r.status==='fulfilled').length,1);assert.equal(duplicates.filter(r=>r.status==='rejected'&&r.reason.getStatus()===400).length,1);check();
 const counts=(await owner.query("SELECT (SELECT count(*)::int FROM hon.student_registration_receipts) receipts,(SELECT count(*)::int FROM hon.student_registration_outbox WHERE state='INERT') facts,(SELECT count(*)::int FROM hon.audit_events WHERE action_code='student.register') audits,(SELECT count(*)::int FROM hon.student_curriculum_enrollments WHERE program_id=$1) enrollments",[program.id])).rows[0];assert.deepEqual(counts,{receipts:3,facts:3,audits:3,enrollments:3});check();
 for(const patch of [{birthDate:'2015-01-01'},{birthDate:'1899-01-01'},{birthDate:'2030-01-01'},{attestation:'GUARDIAN'},{guardianId:ids.principal},{schoolId:other.schoolId},{familyId:ids.family},{expectedProgramVersion:2},{expectedClassSessionVersion:2},{programId:randomUUID()},{classSessionId:randomUUID()}])await assert.rejects(()=>register(input(patch)),status(patch.expectedProgramVersion||patch.expectedClassSessionVersion?409:patch.programId||patch.classSessionId?404:400));check();
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{source:'AUTOMATION'},{delegatedByPrincipalId:ids.principal},{actionRequestId:randomUUID()},{...other},{externalSubject:otherSubject},{schoolId:other.schoolId}])await assert.rejects(()=>register(input(),context(patch)),status(patch.organizationId===other.organizationId?404:403));check();
 // Raw forged GUCs cannot make foreign/HQ/nonhuman/delegated/action identities authoritative.
 for(const patch of [{principalType:'AI_EMPLOYEE'},{source:'AI'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:ids.principal},{externalSubject:hqSubject},{principalId:ids.otherPrincipal},{schoolId:other.schoolId}]){const ctx=context(patch);await assert.rejects(()=>checked(()=>raw(ctx,'SELECT hon.register_owner_launch_student($1,$2::jsonb,$3,$4,$5)',[ctx.externalSubject,JSON.stringify(input()),ctx.idempotencyKey,ctx.requestId,ctx.correlationId])),e=>e.code==='42501');}check();
 for(const tier of ['CORE','COMPLETE']){await owner.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[scope.organizationId,tier]);const r=await register(input());assert.equal(r.receipt.status,'REGISTERED_NO_BOOKING');}check();
 for(const [sql,args,restore]of [
  ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[scope.organizationId],"UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1"],
  ["UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[ids.grant],"UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1"],
  ["UPDATE hon.principals SET is_active=false WHERE id=$1",[ids.principal],"UPDATE hon.principals SET is_active=true WHERE id=$1"]
 ]){await owner.query(sql,args);await assert.rejects(()=>checked(()=>service.register(rc,value)),status(403));await assert.rejects(()=>checked(()=>service.read(context())),status(403));await owner.query(restore,args);}check();
 await owner.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_SUPPORT')",[ids.principal]);await assert.rejects(()=>register(input()),status(403));await owner.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1',[ids.principal]);check();
 await owner.query('INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,\'Local family\')',[ids.family,scope.organizationId,scope.schoolId]);
 await owner.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4)",[scope.organizationId,scope.schoolId,ids.family,ids.principal]);await assert.rejects(()=>register(input()),status(403));await owner.query('DELETE FROM hon.family_access_grants WHERE principal_id=$1',[ids.principal]);check();
 // Existing staff can operate only with ALL existing permissions, not OWNER label.
 await owner.query("UPDATE hon.roles SET code='FRONT_DESK',is_system_role=false WHERE id=$1",[a.ownerRoleId]);await register(input());
 await owner.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='curriculum.progress.record'",[a.ownerRoleId]);await assert.rejects(()=>register(input()),status(403));await owner.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'curriculum.progress.record')",[a.ownerRoleId,scope.organizationId]);check();
 // Failure after all authoritative inserts must rollback the whole registration.
 await owner.query("CREATE FUNCTION hon.fixture_fail_registration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action_code='student.register' THEN RAISE EXCEPTION 'FIXTURE_ATOMICITY_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_registration_audit BEFORE INSERT ON hon.audit_events FOR EACH ROW EXECUTE FUNCTION hon.fixture_fail_registration_audit()");await assert.rejects(()=>register(input()),status(503));await owner.query('DROP TRIGGER fixture_registration_audit ON hon.audit_events; DROP FUNCTION hon.fixture_fail_registration_audit()');check();
 // FKs and immutable canonical program linkage reject mixed school/program relations.
 await owner.query('BEGIN');try{await assert.rejects(()=>owner.query('UPDATE hon.student_curriculum_enrollments SET program_id=$2 WHERE id=$1',[registered.receipt.enrollmentId,randomUUID()]),e=>e.code==='42501');}finally{await owner.query('ROLLBACK');}check();
 for(const table of ownerLaunchTables){await owner.query('BEGIN');try{await owner.query(`GRANT SELECT ON hon.${table} TO hon_owner_launch_runtime; SET LOCAL ROLE hon_owner_launch_runtime`);assert.deepEqual((await owner.query(`SELECT * FROM hon.${table}`)).rows,[]);}finally{await owner.query('ROLLBACK');}}check();
 assert.equal((await runtime.query("SELECT nullif(current_setting('app.hon_school_id',true),'') context")).rows[0].context,null);assert.equal(externalCalls,0);
 console.log(`Owner launch proof passed: ${groups} assertion groups, ${operations} whole-table checked operations, ${driftProbes} rollback-only ACL/RLS probes, ${tables.length} HON table snapshots, zero external calls. Fixture remains marked localhost-only for regression checks.`);
} finally {await database.onModuleDestroy();await runtime.end();await owner.end();net.Socket.prototype.connect=connect;}
