import { loadKioskHandoffValidationEnv } from './kiosk-handoff-env.mjs';
loadKioskHandoffValidationEnv();
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { kioskTables, kioskFunctions, verifyKioskHandoffSecurity } from './kiosk-handoff-security.mjs';
const { RuntimeDatabaseService }=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { KioskService }=await import('../../../apps/api/dist/kiosk/kiosk.service.js');
let groups=0,operations=0,externalCalls=0;
const forbidden=()=>{externalCalls++;throw new Error('External service forbidden');};
globalThis.fetch=forbidden;http.request=forbidden;http.get=forbidden;https.request=forbidden;https.get=forbidden;
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const o=Array.isArray(args[0])?args[0][0]:args[0];if(!(typeof o==='object'?o.port===5432&&o.host==='localhost':o===5432&&args[1]==='localhost'))return forbidden();return connect.apply(this,args);};
const owner=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false});
const runtime=new pg.Client({connectionString:process.env.HON_RUNTIME_DATABASE_URL,ssl:false});
const db=new RuntimeDatabaseService(),service=new KioskService(db);
const ids=Object.fromEntries(['org','otherOrg','school','otherSchool','user','otherUser','principal','otherPrincipal','role','otherRole','grant','otherGrant','program','otherProgram','student','otherStudent','session','otherSession','family'].map(k=>[k,randomUUID()]));
const subject='kiosk-local-'+randomUUID(),otherSubject='kiosk-other-'+randomUUID();
const context=(patch={})=>{const id=randomUUID();return{organizationId:ids.org,schoolId:ids.school,principalId:ids.principal,principalType:'HUMAN_USER',source:'HUMAN_UI',externalSubject:subject,requestId:id,correlationId:id,idempotencyKey:'',...patch};};
const other=context({organizationId:ids.otherOrg,schoolId:ids.otherSchool,principalId:ids.otherPrincipal,externalSubject:otherSubject});
const secret=()=>randomBytes(32).toString('base64url');
const digest=s=>createHash('sha256').update(s).digest();
const check=()=>groups++;
const code=n=>e=>e?.getStatus?.()===n;
let tables;
async function snapshot(){const r={};for(const t of tables){assert(/^[a-z_]+$/.test(t));r[t]=(await owner.query(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) hash FROM hon.${t} t`)).rows[0].hash;}return r;}
async function checked(work,allowed=[]){const before=await snapshot();try{const r=await work();operations++;const after=await snapshot();for(const t of tables)if(!allowed.includes(t))assert.equal(after[t],before[t],'Unexpected platform write: '+t);return r;}catch(e){assert.deepEqual(await snapshot(),before,'Denied request wrote data');throw e;}}
const terminal=async(c=context(),id=randomUUID(),token=secret())=>{const input={terminalSessionId:randomUUID(),terminalSession:token};const r=await checked(()=>service.activate(c,id,input),['kiosk_terminals','kiosk_terminal_sessions']);return{...r,token};};
const provision=async(c=context(),student=ids.student,session=ids.session,id=randomUUID(),token=secret())=>{const r=await checked(()=>service.provision(c,id,{studentProfileId:student,classSessionId:session,claim:token}),['kiosk_claims']);return{...r,token};};
const recovery=(id,c=context())=>checked(()=>service.recover(c,id));
const publicSubmit=(t,c,valid=false)=>checked(()=>service.submit({terminalSession:t,claim:c}),valid?['kiosk_claims','kiosk_handoffs','kiosk_receipts']:[]);
async function raw(c,sql,args){await runtime.query('BEGIN');try{await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_source',$5,true),set_config('app.hon_external_subject',$6,true),set_config('app.hon_action_request_id',$7,true),set_config('app.hon_delegated_by_principal_id',$8,true)",[c.organizationId,c.schoolId,c.principalId,c.principalType,c.source,c.externalSubject,c.actionRequestId??'',c.delegatedByPrincipalId??'']);return await runtime.query(sql,args);}finally{await runtime.query('ROLLBACK');}}
async function expiredClaim(student=ids.student,session=ids.session,patch={}){
	 const id=randomUUID(),token=secret();await owner.query("WITH instant AS (SELECT clock_timestamp() AS value) INSERT INTO hon.kiosk_claims(id,organization_id,school_id,student_profile_id,class_session_id,bearer_digest,state,issued_at,expires_at) SELECT $1,$2,$3,$4,$5,$6,$7,value-interval '11 minutes',value-interval '1 minute' FROM instant",[id,patch.org??ids.org,patch.school??ids.school,student,session,digest(token),patch.state??'ISSUED']);return{id,token};
}
function teardown(){const sql=`DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='hon_kiosk_handoff_validation' AND pg_get_userbyid(datdba)='hon_kiosk_handoff_owner' AND shobj_description(oid,'pg_database')='HON disposable kiosk_handoff validation') THEN RAISE EXCEPTION 'Refusing unmarked fixture'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('hon_kiosk_handoff_owner','hon_kiosk_handoff_runtime') AND shobj_description(oid,'pg_authid') IS DISTINCT FROM 'HON disposable kiosk_handoff validation') THEN RAISE EXCEPTION 'Refusing unmarked roles'; END IF;
 END $$; DROP DATABASE hon_kiosk_handoff_validation WITH (FORCE); DROP ROLE hon_kiosk_handoff_runtime; DROP ROLE hon_kiosk_handoff_owner;`;
 const result=spawnSync('sudo',['-u','postgres','psql','-X','-q','-v','ON_ERROR_STOP=1','-h','/var/run/postgresql','-p','5432','-d','postgres'],{input:sql,encoding:'utf8',env:{PATH:process.env.PATH,HOME:'/home/ubuntu',LANG:'C.UTF-8'}});if(result.status!==0)throw new Error('Marked kiosk fixture teardown failed');}
let passed=false;
await owner.connect();await runtime.connect();
try{
 const marker=(await owner.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];assert.equal(marker.owner,'hon_kiosk_handoff_owner');assert.equal(marker.marker,'HON disposable kiosk_handoff validation');
 await verifyKioskHandoffSecurity(owner,'hon_kiosk_handoff_runtime');
 const canonical=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_kiosk_handoff_runtime');await owner.query(canonical);check();
 // Rollback-only ACL drift, including unknown grantee, PUBLIC, column grants and grant option.
 let aclProbes=0;
 for(const t of kioskTables)for(const drift of [`GRANT SELECT ON hon.${t} TO hon_kiosk_handoff_runtime`,`GRANT SELECT(id) ON hon.${t} TO PUBLIC`,`ALTER TABLE hon.${t} NO FORCE ROW LEVEL SECURITY`,`CREATE POLICY kiosk_drift ON hon.${t} USING(true)`]){
  await owner.query('BEGIN');try{await owner.query(drift);await assert.rejects(()=>verifyKioskHandoffSecurity(owner,'hon_kiosk_handoff_runtime'));aclProbes++;}finally{await owner.query('ROLLBACK');}
 }
 for(const [signature,executable]of kioskFunctions)for(const drift of [`GRANT EXECUTE ON FUNCTION hon.${signature} TO PUBLIC`,`GRANT EXECUTE ON FUNCTION hon.${signature} TO hon_kiosk_handoff_runtime WITH GRANT OPTION`,...(executable?[`REVOKE EXECUTE ON FUNCTION hon.${signature} FROM hon_kiosk_handoff_runtime`]:[])]){
  await owner.query('BEGIN');try{await owner.query(drift);await assert.rejects(()=>verifyKioskHandoffSecurity(owner,'hon_kiosk_handoff_runtime'));aclProbes++;}finally{await owner.query('ROLLBACK');}
 }
 await verifyKioskHandoffSecurity(owner,'hon_kiosk_handoff_runtime');check();
 for(const t of kioskTables)for(const sql of [`SELECT * FROM hon.${t}`,`DELETE FROM hon.${t}`,`TRUNCATE hon.${t}`])await assert.rejects(()=>runtime.query(sql),e=>e.code==='42501');
 for(const signature of ['lock_kiosk_actor','kiosk_secret_valid'])await assert.rejects(()=>runtime.query(signature==='lock_kiosk_actor'?'SELECT hon.lock_kiosk_actor($1,$2)':'SELECT hon.kiosk_secret_valid($1)',signature==='lock_kiosk_actor'?[subject,'kiosk.handoff.read']:[secret()]),e=>e.code==='42501');check();
 await owner.query('BEGIN');
 await owner.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Local','Local'),($2,'Other','Other')",[ids.org,ids.otherOrg]);
 await owner.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$3,'Local',$1::uuid::text),($2,$4,'Other',$2::uuid::text)",[ids.school,ids.otherSchool,ids.org,ids.otherOrg]);
 await owner.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'ESSENTIAL','ACTIVE'),($2,'CORE','ACTIVE')",[ids.org,ids.otherOrg]);
 for(const [u,p,r,g,o,s,sub]of [[ids.user,ids.principal,ids.role,ids.grant,ids.org,ids.school,subject],[ids.otherUser,ids.otherPrincipal,ids.otherRole,ids.otherGrant,ids.otherOrg,ids.otherSchool,otherSubject]]){
  await owner.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$1::uuid::text||'@example.test','Local Staff')",[u,sub]);
  await owner.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Staff')",[p,u]);
  await owner.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role,management_school_id) VALUES($1,$2,'OWNER','Owner',true,$3)",[r,o,s]);
  for(const permission of ['kiosk.terminal.manage','kiosk.handoff.provision','kiosk.handoff.read'])await owner.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[r,o,permission]);
  await owner.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)',[g,o,s,p,r]);
 }
 await owner.query("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$3,$4,'Local Program','SCHEDULED'),($2,$5,$6,'Other','SCHEDULED')",[ids.program,ids.otherProgram,ids.org,ids.school,ids.otherOrg,ids.otherSchool]);
 for(const [student,session,org,school,program]of [[ids.student,ids.session,ids.org,ids.school,ids.program],[ids.otherStudent,ids.otherSession,ids.otherOrg,ids.otherSchool,ids.otherProgram]]){
  const person=randomUUID();await owner.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'PII_CANARY_GIVEN','PII_CANARY_FAMILY')",[person,org,school]);
  await owner.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)',[student,org,school,person]);
  await owner.query("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status) VALUES($1,$2,$3,$4,'PII_CANARY_SESSION',now()+interval '1 hour',now()+interval '2 hours',1,'REQUIRED_BOOKING','SCHEDULED')",[session,org,school,program]);
 }
 await owner.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PII_CANARY_FAMILY')",[ids.family,ids.org,ids.school]);
 await owner.query('COMMIT');
 tables=(await owner.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hon' AND relkind='r' ORDER BY relname")).rows.map(r=>r.relname);
 const t=await terminal(),foreign=await terminal(other),claim=await provision();
 assert.equal(new Date(t.expiresAt)-new Date(t.createdAt),15*60000);assert.equal(new Date(claim.expiresAt)-new Date(claim.issuedAt),10*60000);check();
 await assert.rejects(()=>provision(),code(400));await assert.rejects(()=>provision(context(),ids.otherStudent,ids.session),code(400));await assert.rejects(()=>provision(context(),ids.student,ids.otherSession),code(400));
 await assert.rejects(()=>terminal(other,t.terminalId),code(400));check();
 const expected={result:'NEEDS_STAFF_ASSISTANCE'};
 for(const [a,b]of [[secret(),secret()],[t.token,secret()],[foreign.token,claim.token],[t.token,'short'],['short',claim.token]])assert.deepEqual(await publicSubmit(a,b),expected);
 const beforeConcurrent=await snapshot();const outputs=await Promise.all([service.submit({terminalSession:t.token,claim:claim.token}),service.submit({terminalSession:t.token,claim:claim.token})]);assert.deepEqual(outputs,[expected,expected]);const afterConcurrent=await snapshot();for(const table of tables)if(!['kiosk_claims','kiosk_handoffs','kiosk_receipts'].includes(table))assert.equal(afterConcurrent[table],beforeConcurrent[table]);
 assert.equal((await owner.query('SELECT count(*)::int n FROM hon.kiosk_handoffs WHERE claim_id=$1',[claim.claimId])).rows[0].n,1);
 assert.equal((await owner.query('SELECT count(*)::int n FROM hon.kiosk_receipts WHERE claim_id=$1',[claim.claimId])).rows[0].n,1);
 assert.deepEqual(await publicSubmit(t.token,claim.token),expected);check();
 const read=await recovery(claim.claimId);assert.equal(read.state,'CONSUMED');assert.equal(read.handoff.state,'PENDING_STAFF_REVIEW');assert(!JSON.stringify(read).includes('PII_CANARY'));assert(!JSON.stringify(read).includes(t.token));assert(!JSON.stringify(read).includes(claim.token));
 await assert.rejects(()=>recovery(claim.claimId,other),code(400));await assert.rejects(()=>recovery(randomUUID()),code(400));check();
 const next=await provision();const rotated=await terminal(context(),t.terminalId);
 assert.deepEqual(await publicSubmit(t.token,next.token),expected);assert.deepEqual(await publicSubmit(rotated.token,next.token,true),expected);check();
 const expired=await expiredClaim();assert.deepEqual(await publicSubmit(rotated.token,expired.token),expected);assert.equal((await recovery(expired.id)).state,'EXPIRED');
 const replacement=await provision();assert.equal((await owner.query('SELECT state FROM hon.kiosk_claims WHERE id=$1',[expired.id])).rows[0].state,'EXPIRED');
 const expiredTerminalId=randomUUID(),expiredSession=randomUUID(),expiredToken=secret();
 await owner.query("INSERT INTO hon.kiosk_terminals(id,organization_id,school_id,state) VALUES($1,$2,$3,'ACTIVE')",[expiredTerminalId,ids.org,ids.school]);
	 await owner.query("WITH instant AS (SELECT clock_timestamp() AS value) INSERT INTO hon.kiosk_terminal_sessions(id,organization_id,school_id,terminal_id,bearer_digest,created_at,expires_at) SELECT $1,$2,$3,$4,$5,value-interval '16 minutes',value-interval '1 minute' FROM instant",[expiredSession,ids.org,ids.school,expiredTerminalId,digest(expiredToken)]);
 assert.deepEqual(await publicSubmit(expiredToken,replacement.token),expected);check();
 await checked(()=>service.retire(context(),rotated.terminalId,{}),['kiosk_terminals']);assert.deepEqual(await publicSubmit(rotated.token,replacement.token),expected);await assert.rejects(()=>terminal(context(),rotated.terminalId),code(400));check();
 const live=await terminal();
 for(const [sql,restore,args]of [
  ["UPDATE hon.student_profiles SET status='SUSPENDED' WHERE id=$1","UPDATE hon.student_profiles SET status='ACTIVE' WHERE id=$1",[ids.student]],
	 ["UPDATE hon.class_sessions SET status='CANCELLED',cancellation_reason='fixture cancellation' WHERE id=$1","UPDATE hon.class_sessions SET status='SCHEDULED',cancellation_reason=NULL WHERE id=$1",[ids.session]],
  ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1","UPDATE hon.schools SET status='ACTIVE' WHERE id=$1",[ids.school]],
  ["UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1","UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1",[ids.org]]]){
	 await owner.query(sql,args);assert.deepEqual(await publicSubmit(live.token,replacement.token),expected);await assert.rejects(()=>provision());await owner.query(restore,args);
 }check();
 // App and SQL independently refuse all non-human/delegated/incorrect exact identities.
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{principalType:'SYSTEM_SERVICE'},{source:'AI'},{source:'AUTOMATION'},{source:'PUBLIC_API'},{source:'HQ_SUPPORT'},{externalSubject:'spoof'},{principalId:randomUUID()},{schoolId:ids.otherSchool},{organizationId:ids.otherOrg},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]){
  const c=context(patch);await assert.rejects(()=>recovery(claim.claimId,c),code(403));await assert.rejects(()=>raw(c,'SELECT hon.read_kiosk_handoff($1,$2)',[c.externalSubject,claim.claimId]),e=>e.code==='42501');
 }check();
 for(const [sql,restore,args]of [
  ['UPDATE hon.principal_role_grants SET revoked_at=now(),revoked_by_principal_id=principal_id WHERE id=$1','UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[ids.grant]],
  ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1","UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[ids.org]],
  ['UPDATE hon.principals SET is_active=false WHERE id=$1','UPDATE hon.principals SET is_active=true WHERE id=$1',[ids.principal]],
  ["UPDATE hon.roles SET code='STAFF' WHERE id=$1","UPDATE hon.roles SET code='OWNER' WHERE id=$1",[ids.role]],
  ["DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='kiosk.handoff.read'","INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'kiosk.handoff.read')",[ids.role,ids.org]]]){
  // Query placeholders deliberately limited to the arguments the statement uses.
  await owner.query(sql,args.slice(0,sql.includes('$2')?2:1));await assert.rejects(()=>recovery(claim.claimId),code(403));await owner.query(restore,args.slice(0,restore.includes('$2')?2:1));
 }check();
 await owner.query("UPDATE hon.roles SET code='ADMIN' WHERE id=$1",[ids.role]);await recovery(claim.claimId);await assert.rejects(()=>terminal(),code(403));await owner.query("UPDATE hon.roles SET code='OWNER' WHERE id=$1",[ids.role]);check();
 await owner.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')",[ids.principal]);await assert.rejects(()=>recovery(claim.claimId),code(403));await owner.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1',[ids.principal]);
 await owner.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4)",[ids.org,ids.school,ids.family,ids.principal]);await assert.rejects(()=>recovery(claim.claimId),code(403));await owner.query('DELETE FROM hon.family_access_grants WHERE principal_id=$1',[ids.principal]);
 const ambiguous=randomUUID();await owner.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Ambiguous')",[ambiguous,ids.user]);await assert.rejects(()=>recovery(claim.claimId),code(403));await owner.query('DELETE FROM hon.principals WHERE id=$1',[ambiguous]);check();
	 // Composite scope FKs and strict TTLs cannot be bypassed even by privileged fixture writers.
 for(const insert of [
  ()=>owner.query("INSERT INTO hon.kiosk_terminal_sessions(id,organization_id,school_id,terminal_id,bearer_digest,created_at,expires_at) VALUES($1,$2,$3,$4,$5,now(),now()+interval '16 minutes')",[randomUUID(),ids.org,ids.school,live.terminalId,digest(secret())]),
  ()=>owner.query("INSERT INTO hon.kiosk_terminal_sessions(id,organization_id,school_id,terminal_id,bearer_digest,created_at,expires_at) VALUES($1,$2,$3,$4,$5,now(),now()+interval '1 minute')",[randomUUID(),ids.otherOrg,ids.otherSchool,live.terminalId,digest(secret())]),
  ()=>owner.query("INSERT INTO hon.kiosk_claims(id,organization_id,school_id,student_profile_id,class_session_id,bearer_digest,state,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,'ISSUED',now(),now()+interval '11 minutes')",[randomUUID(),ids.org,ids.school,ids.student,ids.session,digest(secret())])])await assert.rejects(insert,e=>['23514','23503'].includes(e.code));check();
 // All projection/receipt/durable state has no plaintext bearer or operational/private names.
 for(const table of kioskTables){const rows=JSON.stringify((await owner.query(`SELECT to_jsonb(t)-'bearer_digest' data FROM hon.${table} t`)).rows);for(const canary of ['PII_CANARY',t.token,claim.token,replacement.token,live.token])assert(!rows.includes(canary),table+' leaked sensitive data');}
 const receipt=(await owner.query('SELECT * FROM hon.kiosk_receipts LIMIT 1')).rows[0];assert.deepEqual(Object.keys(receipt).sort(),['id','organization_id','school_id','handoff_id','claim_id','terminal_session_id','result','recorded_at'].sort());
 for(const sql of ['UPDATE hon.kiosk_receipts SET result=result','DELETE FROM hon.kiosk_receipts','TRUNCATE hon.kiosk_receipts'])await assert.rejects(()=>owner.query(sql),e=>e.code==='42501');check();
 assert.equal(externalCalls,0);await verifyKioskHandoffSecurity(owner,'hon_kiosk_handoff_runtime');passed=true;
 console.log(`Kiosk handoff integrity passed: ${groups} assertion groups, ${aclProbes} rollback-only ACL/RLS probes, ${operations} whole-table checked operations, ${tables.length} HON tables; zero external calls. Concurrent duplicate produced exactly one handoff/receipt. Local fixture only.`);
} finally {
 await db.onModuleDestroy();await owner.end();await runtime.end();
 if(passed){teardown();await unlink(process.env.HON_KIOSK_HANDOFF_ENV_FILE);console.log('Marked disposable kiosk database/roles and private credential descriptor removed.');}
 else console.log('Validation failed; marked local fixture retained for diagnosis. No completion claim.');
}
