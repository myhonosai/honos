import { loadClassPassValidationEnv } from './classpass-env.mjs';
loadClassPassValidationEnv();
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { verifyClassPassSecurity } from './classpass-security.mjs';
import { readFile } from 'node:fs/promises';
import { testClassPassAclDrift } from './classpass-acl-probes.mjs';
import { testClassPassCompletionCases } from './classpass-completion-cases.mjs';
import { testClassBookingLockVerifier } from './class-booking-lock-security.mjs';
const { RuntimeDatabaseService }=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { ClassPassService }=await import('../../../apps/api/dist/classpass/classpass.service.js');
const { ClassBookingService }=await import('../../../apps/api/dist/schedule/class-booking.service.js');
const { AttendanceService }=await import('../../../apps/api/dist/schedule/attendance.service.js');
let externalCalls=0,groups=0,commands=0;
const forbidden=()=>{externalCalls++;throw new Error('External/provider/payment/message/network effect forbidden');};
globalThis.fetch=forbidden;http.request=forbidden;http.get=forbidden;https.request=forbidden;https.get=forbidden;
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const o=Array.isArray(args[0])?args[0][0]:args[0];if(!(typeof o==='object'?o.port===5432&&o.host==='localhost':o===5432&&args[1]==='localhost'))return forbidden();return connect.apply(this,args);};
const admin=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false}),runtime=new pg.Client({connectionString:process.env.HON_RUNTIME_DATABASE_URL,ssl:false});
const db=new RuntimeDatabaseService(),service=new ClassPassService(db),generic=new ClassBookingService(db),attendance=new AttendanceService(db);
const readOnlyTransaction=db.withTenantReadOnlyTransaction.bind(db);
let readOnlyChecks=0;
db.withTenantReadOnlyTransaction=(context,work)=>readOnlyTransaction(context,async client=>{
 assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');readOnlyChecks++;return work(client);
});
const ids=Object.fromEntries(['org','otherOrg','school','otherSchool','user','principal','role','grant','program','otherProgram','family'].map(k=>[k,randomUUID()]));
const subject=`classpass-local-${randomUUID()}`;
const safeEnv={PATH:process.env.PATH??'/usr/bin:/bin',HOME:'/home/ubuntu',LANG:'C.UTF-8'};
const ctx=(patch={})=>{const id=randomUUID();return{organizationId:ids.org,schoolId:ids.school,principalId:ids.principal,principalType:'HUMAN_USER',source:'HUMAN_UI',externalSubject:subject,requestId:id,correlationId:id,idempotencyKey:randomUUID(),...patch};};
const check=()=>groups++;
const status=n=>e=>e?.getStatus?.()===n;
let tables;
const canonical=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_classpass_runtime');
async function waitForSqlLocks(marker,minimum=1){
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){const result=await runtime.query("SELECT count(*)::integer n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND pid<>pg_backend_pid()",['%'+marker+'%']);if(result.rows[0].n>=minimum)return;await new Promise(r=>setTimeout(r,20));}
 throw new Error('SQL lock barrier not observed: '+marker);
}
async function waitForGrantExpiry(){
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){if((await admin.query('SELECT effective_until<=clock_timestamp() expired FROM hon.principal_role_grants WHERE id=$1',[ids.grant])).rows[0].expired)return;await new Promise(r=>setTimeout(r,20));}
 throw new Error('Database grant-expiry barrier not observed');
}
async function snapshot(){const result={};for(const table of tables){assert(/^[a-z_]+$/.test(table));result[table]=(await admin.query(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) hash FROM hon.${table} t`)).rows[0].hash;}return result;}
const allowed=new Set(['classpass_products','classpass_passes','classpass_ledger','class_bookings','audit_events','outbox_events','idempotency_records']);
async function command(action,target,input,c=ctx()){const before=await snapshot();try{const result=await service.command(c,action,target,input);commands++;const after=await snapshot();for(const t of tables)if(!allowed.has(t))assert.equal(after[t],before[t],`Unrelated effect on ${t}`);assert.equal(result.externalEffects,'NONE');assert.equal(result.paymentProviderOutcome,'UNAVAILABLE');return result;}catch(e){assert.deepEqual(await snapshot(),before);throw e;}}
async function deny(action,target,input,c=ctx(),n=400){await assert.rejects(()=>command(action,target,input,c),status(n));}
async function read(kind,id,c=ctx()){const before=await snapshot();try{const r=await service.read(c,kind,id);assert.deepEqual(await snapshot(),before);return r;}catch(e){assert.deepEqual(await snapshot(),before);throw e;}}
async function raw(c,work){await runtime.query('BEGIN');try{await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_source',$5,true),set_config('app.hon_external_subject',$6,true),set_config('app.hon_action_request_id',$7,true),set_config('app.hon_delegated_by_principal_id',$8,true),set_config('app.hon_request_id',$9,true),set_config('app.hon_correlation_id',$10,true)",[c.organizationId,c.schoolId,c.principalId,c.principalType,c.source,c.externalSubject,c.actionRequestId??'',c.delegatedByPrincipalId??'',c.requestId,c.correlationId]);return await work(runtime);}finally{await runtime.query('ROLLBACK');}}
async function rawCommand(action,target,input,c=ctx()){return raw(c,r=>r.query('SELECT hon.command_classpass($1,$2,$3,$4,$5,$6,$7)',[c.externalSubject,action,target,input,c.idempotencyKey,c.requestId,c.correlationId]));}
async function student(org=ids.org,school=ids.school){const person=randomUUID(),id=randomUUID();await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Private','SECRET_NOT_EXPOSED')",[person,org,school]);await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,birth_date) VALUES($1,$2,$3,$4,\'2010-01-01\')',[id,org,school,person]);return id;}
async function session(patch={}){const id=randomUUID();await admin.query("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status) VALUES($1,$2,$3,$4,'Local Session',$5,$6,$7,$8,$9)",[id,patch.org??ids.org,patch.school??ids.school,patch.program??ids.program,patch.starts??new Date(Date.now()+3600000),patch.ends??new Date(Date.now()+7200000),patch.capacity??1,patch.policy??'WALK_IN',patch.status??'SCHEDULED']);return id;}
async function issue(product,studentId,version=1){return command('ISSUE',product,{expectedVersion:version,studentProfileId:studentId,issuanceKind:'MANUAL_NONFINANCIAL',reason:'Local operational grant'});}
function teardown(){const sql=`DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='hon_classpass_validation' AND pg_get_userbyid(datdba)='hon_classpass_owner' AND shobj_description(oid,'pg_database')='HON disposable classpass validation') THEN RAISE EXCEPTION 'Refusing unmarked fixture'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('hon_classpass_owner','hon_classpass_runtime') AND shobj_description(oid,'pg_authid') IS DISTINCT FROM 'HON disposable classpass validation') THEN RAISE EXCEPTION 'Refusing unmarked roles'; END IF;
END $$;
DROP DATABASE hon_classpass_validation WITH (FORCE); DROP ROLE hon_classpass_runtime; DROP ROLE hon_classpass_owner;`;
 const result=spawnSync('sudo',['-u','postgres','psql','-X','-q','-v','ON_ERROR_STOP=1','-d','postgres'],{input:sql,encoding:'utf8',env:safeEnv});if(result.status!==0)throw new Error('Marked ClassPass fixture teardown failed.');}
await admin.connect();await runtime.connect();
try{
 const marker=(await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];assert.equal(marker.owner,'hon_classpass_owner');assert.equal(marker.marker,'HON disposable classpass validation');
 await verifyClassPassSecurity(admin,'hon_classpass_runtime');
 await admin.query(canonical);
 const aclProbes=await testClassPassAclDrift(admin,'hon_classpass_runtime');check();
 await testClassBookingLockVerifier(admin,'hon_classpass_runtime');
 const posture=(await runtime.query('SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(posture.rolcanlogin,true);for(const[k,v]of Object.entries(posture))if(k!=='rolcanlogin')assert.equal(v,false);
 for(const t of ['classpass_products','classpass_passes','classpass_ledger','users','principals','roles'])for(const sql of [`SELECT * FROM hon.${t}`,`DELETE FROM hon.${t}`])await assert.rejects(()=>runtime.query(sql),e=>e.code==='42501');
 await assert.rejects(()=>runtime.query('SELECT hon.lock_classpass_actor($1,$2)',[subject,'classpass.manage']),e=>e.code==='42501');check();
 await admin.query('BEGIN');
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Local','Local'),($2,'Other','Other')",[ids.org,ids.otherOrg]);
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$3,'Local',$1::uuid::text),($2,$4,'Other',$2::uuid::text)",[ids.school,ids.otherSchool,ids.org,ids.otherOrg]);
 await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'ESSENTIAL','ACTIVE'),($2,'ESSENTIAL','ACTIVE')",[ids.org,ids.otherOrg]);
 await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$1::uuid::text||'@example.test','Local Staff')",[ids.user,subject]);
 await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Staff')",[ids.principal,ids.user]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,management_school_id) VALUES($1,$2,$1::uuid::text,'Local ClassPass',$3)",[ids.role,ids.org,ids.school]);
 for(const p of ['classpass.manage','classpass.admit','classpass.reverse','classpass.read','schedule.booking.manage','attendance.record'])await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[ids.role,ids.org,p]);
 await admin.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)',[ids.grant,ids.org,ids.school,ids.principal,ids.role]);
 await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$3,$4,'Local Program','SCHEDULED'),($2,$5,$6,'Other','SCHEDULED')",[ids.program,ids.otherProgram,ids.org,ids.school,ids.otherOrg,ids.otherSchool]);
 await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Local Family')",[ids.family,ids.org,ids.school]);
 await admin.query('COMMIT');
 tables=(await admin.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hon' AND relkind='r' ORDER BY relname")).rows.map(r=>r.relname);
 const a=await student(),b=await student(),c=await student(),foreign=await student(ids.otherOrg,ids.otherSchool),product=randomUUID();
 const config={expectedVersion:0,programId:ids.program,name:'Operational allowance',allowedUses:2,validityDays:30,reason:'Local configuration'};
 const configContext=ctx();let r=await command('CONFIGURE_PRODUCT',product,config,configContext);assert.equal(r.version,1);assert.equal((await command('CONFIGURE_PRODUCT',product,config,configContext)).replayed,true);
 await deny('CONFIGURE_PRODUCT',product,{...config,allowedUses:3},configContext,409);
 await deny('CONFIGURE_PRODUCT',product,config,ctx(),409);
 await deny('CONFIGURE_PRODUCT',randomUUID(),{...config,programId:ids.otherProgram});
 await deny('ISSUE',product,{expectedVersion:1,studentProfileId:foreign,issuanceKind:'MANUAL_NONFINANCIAL',reason:'No foreign student'});check();
 // Services and the actual SQL command independently reject forged authority.
 const deniedPatches=[{principalType:'AI_EMPLOYEE'},{source:'AI'},{source:'AUTOMATION'},{source:'API'},{externalSubject:'spoof'},{principalId:randomUUID()},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()},{schoolId:ids.otherSchool},{organizationId:ids.otherOrg}];
 for(const patch of deniedPatches){await assert.rejects(()=>rawCommand('CONFIGURE_PRODUCT',randomUUID(),config,ctx(patch)),e=>e.code==='42501');await assert.rejects(()=>read('PRODUCT',product,ctx(patch)),status(403));}check();
 await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')",[ids.principal]);await assert.rejects(()=>read('PRODUCT',product),status(403));await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1',[ids.principal]);
 await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4)",[ids.org,ids.school,ids.family,ids.principal]);await assert.rejects(()=>read('PRODUCT',product),status(403));await admin.query('DELETE FROM hon.family_access_grants WHERE principal_id=$1',[ids.principal]);check();
 for(const [sql,restore,args]of [
 ['UPDATE hon.principal_role_grants SET revoked_at=now(),revoked_by_principal_id=principal_id WHERE id=$1','UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[ids.grant]],
 ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1","UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[ids.org]],
 ['UPDATE hon.principals SET is_active=false WHERE id=$1','UPDATE hon.principals SET is_active=true WHERE id=$1',[ids.principal]],
 ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1","UPDATE hon.schools SET status='ACTIVE' WHERE id=$1",[ids.school]],
 ["UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1","UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1",[ids.org]]]){await admin.query(sql,args);await assert.rejects(()=>read('PRODUCT',product),status(403));await deny('CONFIGURE_PRODUCT',randomUUID(),config,ctx(),403);await admin.query(restore,args);}check();
 const pa=await issue(product,a),pb=await issue(product,b),pc=await issue(product,c),s=await session();
 assert.equal((await read('PASS',pa.id)).ledger.length,1);
 for(const extra of [{amount:1},{currency:'USD'},{purchaseId:randomUUID()},{paymentProviderOutcome:'SUCCEEDED'},{payerId:randomUUID()},{invoiceId:randomUUID()},{membershipId:randomUUID()},{studentProfileId:b},{status:'BOOKED'}])await deny('ADMIT',s,{expectedVersion:1,passId:pa.id,...extra});
 for(const reason of ['', ' ', 'padded ', 'x'.repeat(501), 'control\nreason'])await deny('REVERSE_ISSUANCE',pc.id,{expectedVersion:1,reason});
 await deny('ISSUE',product,{expectedVersion:1,studentProfileId:a,issuanceKind:'PAYMENT_BACKED',reason:'Forbidden purchase'});
 await deny('ADMIT',s,{expectedVersion:0,passId:pa.id});await deny('ADMIT',s,{expectedVersion:2,passId:pa.id},ctx(),409);
 await deny('ADMIT',await session({policy:'REQUIRED_BOOKING'}),{expectedVersion:1,passId:pa.id});
 await deny('ADMIT',await session({starts:new Date(Date.now()+86400000),ends:new Date(Date.now()+90000000)}),{expectedVersion:1,passId:pa.id});
 await deny('ADMIT',await session({starts:new Date(Date.now()-7200000),ends:new Date(Date.now()-3600000)}),{expectedVersion:1,passId:pa.id});
 await deny('ADMIT',await session({status:'DRAFT'}),{expectedVersion:1,passId:pa.id});
 await deny('ADMIT',await session({org:ids.otherOrg,school:ids.otherSchool,program:ids.otherProgram}),{expectedVersion:1,passId:pa.id},ctx(),404);check();
 // Frozen product/program facts survive product changes and retirement.
 await command('CONFIGURE_PRODUCT',product,{...config,expectedVersion:1,name:'New allowance',allowedUses:5});assert.equal((await read('PASS',pa.id)).allowedUses,2);
 await admin.query('UPDATE hon.programs SET minimum_age_months=9999 WHERE id=$1',[ids.program]);await deny('ADMIT',s,{expectedVersion:1,passId:pa.id});await admin.query('UPDATE hon.programs SET minimum_age_months=NULL WHERE id=$1',[ids.program]);
 await admin.query("UPDATE hon.student_profiles SET status='SUSPENDED' WHERE id=$1",[a]);await deny('ADMIT',s,{expectedVersion:1,passId:pa.id});await admin.query("UPDATE hon.student_profiles SET status='ACTIVE' WHERE id=$1",[a]);
 const admissionContext=ctx();const admitted=await command('ADMIT',s,{expectedVersion:1,passId:pa.id},admissionContext);assert.equal(admitted.decision,'ADMITTED_REDEEMED');assert.equal(admitted.remainingUses,1);assert.equal(admitted.booking.status,'BOOKED');
 assert.equal((await command('ADMIT',s,{expectedVersion:1,passId:pa.id},admissionContext)).replayed,true);
 await deny('ADMIT',s,{expectedVersion:2,passId:pa.id},admissionContext,409);
 const waitingContext=ctx(),waiting=await command('ADMIT',s,{expectedVersion:1,passId:pb.id},waitingContext);assert.equal(waiting.decision,'WAITLISTED_NOT_REDEEMED');assert.equal(waiting.remainingUses,2);assert.equal(waiting.version,1);
 assert.equal((await read('PASS',pb.id)).ledger.length,1);
 const repeat=await command('ADMIT',s,{expectedVersion:1,passId:pb.id});assert.equal(repeat.booking.id,waiting.booking.id);assert.equal(repeat.decision,'WAITLISTED_NOT_REDEEMED');
 await deny('REVERSE_REDEMPTION',waiting.booking.id,{expectedVersion:1,passId:pb.id,reason:'No redemption'});check();
 const reversed=await command('REVERSE_REDEMPTION',admitted.booking.id,{expectedVersion:2,passId:pa.id,reason:'Staff admission correction'});assert.equal(reversed.remainingUses,2);assert.equal(reversed.booking.status,'CANCELLED');assert.equal((await read('BOOKING',waiting.booking.id)).status,'WAITLISTED');
 const oldReplay=await command('ADMIT',s,{expectedVersion:1,passId:pb.id},waitingContext);assert.equal(oldReplay.decision,'WAITLISTED_NOT_REDEEMED');
 const promoted=await command('ADMIT',s,{expectedVersion:1,passId:pb.id});assert.equal(promoted.booking.id,waiting.booking.id);assert.equal(promoted.decision,'ADMITTED_REDEEMED');assert.equal(promoted.remainingUses,1);
 await deny('REVERSE_REDEMPTION',admitted.booking.id,{expectedVersion:3,passId:pa.id,reason:'Duplicate reversal'});
 await deny('REVERSE_ISSUANCE',pa.id,{expectedVersion:3,reason:'Previously used'});
 await deny('ADMIT',s,{expectedVersion:3,passId:pa.id});check();
 // Raw generic command cannot choose CLASS_PASS; generic WALK_IN still may overbook.
 await assert.rejects(()=>generic.create(ctx(),s,{studentProfileId:c,bookingKind:'CLASS_PASS'}),status(400));
 const genericBooking=await generic.create(ctx(),s,{studentProfileId:c,bookingKind:'REGULAR'});assert.equal(genericBooking.booking.status,'BOOKED');assert.equal(genericBooking.booking.activeSeatCount,2);
 await deny('ADMIT',s,{expectedVersion:1,passId:pc.id},ctx(),409);
 await assert.rejects(()=>raw(ctx(),r=>r.query("INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,classpass_id,status,source) VALUES($1,$2,$3,$4,'CLASS_PASS',$5,'BOOKED','STAFF')",[ids.org,ids.school,s,a,pa.id])),e=>e.code==='42501');
 await assert.rejects(()=>runtime.query("UPDATE hon.class_bookings SET status='BOOKED'"),e=>e.code==='42501');check();
 // The generic lock exposes exactly four facts, never a raw session UPDATE ACL.
 const lock=(sessionId,c=ctx(),parameter=c.externalSubject)=>raw(c,r=>r.query('SELECT * FROM hon.lock_class_booking_session($1,$2::uuid)',[parameter,sessionId]));
 const foreignSession=await session({org:ids.otherOrg,school:ids.otherSchool,program:ids.otherProgram});
 let beforeLock=await snapshot();
 assert.deepEqual((await lock(s)).rows,[{id:s,capacity:1,booking_policy:'WALK_IN',status:'SCHEDULED'}]);
 assert.equal((await lock(foreignSession)).rowCount,0);assert.equal((await lock(randomUUID())).rowCount,0);
 for(const patch of [...deniedPatches,{externalSubject:''},{organizationId:''},{schoolId:''},{organizationId:'invalid'},{schoolId:'invalid'}]){
  await assert.rejects(()=>lock(s,ctx(patch)),e=>e.code==='42501');
  const malformed=patch.organizationId===''||patch.schoolId===''||patch.organizationId==='invalid'||patch.schoolId==='invalid';
  await assert.rejects(()=>generic.create(ctx(patch),s,{studentProfileId:a,bookingKind:'REGULAR'}),e=>status(403)(e)||(malformed&&['P0001','22P02'].includes(e.code)));
 }
 await assert.rejects(()=>lock(s,ctx(),'forged-parameter'),e=>e.code==='42501');
 await assert.rejects(()=>runtime.query('SELECT hon.require_classpass_read_actor($1)',[subject]),e=>e.code==='42501');
 await assert.rejects(()=>raw(ctx(),r=>r.query('SELECT id FROM hon.class_sessions WHERE id=$1 FOR UPDATE',[s])),e=>e.code==='42501');
 assert.deepEqual(await snapshot(),beforeLock);check();
 const siblingSchool=randomUUID(),siblingProgram=randomUUID();
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Sibling',$1::uuid::text)",[siblingSchool,ids.org]);
 await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Sibling','SCHEDULED')",[siblingProgram,ids.org,siblingSchool]);
 const siblingSession=await session({school:siblingSchool,program:siblingProgram});
 assert.equal((await lock(siblingSession)).rowCount,0);await assert.rejects(()=>lock(siblingSession,ctx({schoolId:siblingSchool})),e=>e.code==='42501');
 await admin.query('UPDATE hon.roles SET management_school_id=$1 WHERE id=$2',[siblingSchool,ids.role]);await assert.rejects(()=>lock(s),e=>e.code==='42501');await admin.query('UPDATE hon.roles SET management_school_id=$1 WHERE id=$2',[ids.school,ids.role]);
 for(const tier of ['CORE','COMPLETE']){await admin.query('UPDATE hon.organization_entitlements SET tier=$1 WHERE organization_id=$2',[tier,ids.org]);assert.equal((await lock(s)).rowCount,1);assert.equal((await read('PRODUCT',product)).id,product);}
 await admin.query("UPDATE hon.organization_entitlements SET tier='ESSENTIAL' WHERE organization_id=$1",[ids.org]);check();
 const savedContext=ctx();await generic.create(savedContext,s,{studentProfileId:c,bookingKind:'REGULAR'});
 for(const[sql,restore,args]of[
  ['UPDATE hon.principal_role_grants SET revoked_at=now(),revoked_by_principal_id=principal_id WHERE id=$1','UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[ids.grant]],
  ['UPDATE hon.principal_role_grants SET effective_from=now()-interval \'1 day\',effective_until=now()-interval \'1 hour\' WHERE id=$1','UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1',[ids.grant]],
  ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1","UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[ids.org]],
  ['UPDATE hon.organization_entitlements SET effective_from=now()-interval \'1 day\',effective_until=now()-interval \'1 hour\' WHERE organization_id=$1','UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1',[ids.org]],
  ['UPDATE hon.principals SET is_active=false WHERE id=$1','UPDATE hon.principals SET is_active=true WHERE id=$1',[ids.principal]],
  ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1","UPDATE hon.schools SET status='ACTIVE' WHERE id=$1",[ids.school]],
  ["UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1","UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1",[ids.org]],
  ["DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='schedule.booking.manage'","INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT id,organization_id,'schedule.booking.manage' FROM hon.roles WHERE id=$1",[ids.role]],
 ]){await admin.query(sql,args);beforeLock=await snapshot();await assert.rejects(()=>lock(s),e=>e.code==='42501');await assert.rejects(()=>generic.create(savedContext,s,{studentProfileId:c,bookingKind:'REGULAR'}),status(403));assert.deepEqual(await snapshot(),beforeLock);await admin.query(restore,args);}check();
 // A second active principal for one subject must not establish human authority.
 const ambiguous=randomUUID();await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Ambiguous')",[ambiguous,ids.user]);
 await assert.rejects(()=>lock(s),e=>e.code==='42501');await assert.rejects(()=>read('PRODUCT',product),status(403));await admin.query('DELETE FROM hon.principals WHERE id=$1',[ambiguous]);check();
 const waitForGenericLock=()=>waitForSqlLocks('FROM hon.lock_class_booking_session');
 for(const kind of ['grant-expiry','entitlement-expiry','revocation']){
  const target=await session(),newStudent=await student();
  await admin.query('BEGIN');await admin.query('SELECT id FROM hon.class_sessions WHERE id=$1 FOR UPDATE',[target]);
  const pending=generic.create(ctx(),target,{studentProfileId:newStudent,bookingKind:'REGULAR'}).then(()=>null,e=>e);
  await waitForGenericLock();
  if(kind==='revocation')await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[ids.grant]);
  else if(kind==='grant-expiry')await admin.query("UPDATE hon.principal_role_grants SET effective_from=clock_timestamp()-interval '2 days',effective_until=clock_timestamp()-interval '1 day' WHERE id=$1",[ids.grant]);
  else await admin.query("UPDATE hon.organization_entitlements SET effective_from=clock_timestamp()-interval '2 days',effective_until=clock_timestamp()-interval '1 day' WHERE organization_id=$1",[ids.org]);
  await admin.query('COMMIT');beforeLock=await snapshot();assert.equal((await pending)?.getStatus?.(),403);assert.deepEqual(await snapshot(),beforeLock);
  await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL,revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[ids.grant]);
  await admin.query('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1',[ids.org]);
 }check();
 // Concurrent distinct passes serialize on the canonical session, never oversubscribe.
 const raceSession=await session(),race=await Promise.all([service.command(ctx(),'ADMIT',raceSession,{expectedVersion:2,passId:pb.id}),service.command(ctx(),'ADMIT',raceSession,{expectedVersion:1,passId:pc.id})]);
 assert.deepEqual(race.map(x=>x.decision).sort(),['ADMITTED_REDEEMED','WAITLISTED_NOT_REDEEMED']);
 assert.equal(Number((await admin.query("SELECT count(*) n FROM hon.class_bookings WHERE class_session_id=$1 AND status IN('BOOKED','CHECKED_IN')",[raceSession])).rows[0].n),1);check();
 const pd=await issue(product,a,2),s1=await session(),s2=await session();const double=await Promise.allSettled([service.command(ctx(),'ADMIT',s1,{expectedVersion:1,passId:pd.id}),service.command(ctx(),'ADMIT',s2,{expectedVersion:1,passId:pd.id})]);assert.equal(double.filter(x=>x.status==='fulfilled').length,1);assert.equal(double.filter(x=>x.status==='rejected').length,1);assert.equal((await read('PASS',pd.id)).remainingUses,4);check();
 // Check-in, attendance and session-start gates never restore a debit.
 const pe=await issue(product,b,2),attendanceSession=await session();const ae=await command('ADMIT',attendanceSession,{expectedVersion:1,passId:pe.id});
 await attendance.record(ctx(),attendanceSession,{studentProfileId:b,status:'PRESENT',category:'GUEST_DROP_IN'});
 await deny('REVERSE_REDEMPTION',ae.booking.id,{expectedVersion:2,passId:pe.id,reason:'Attendance blocks reversal'});
 const pf=await issue(product,c,2),started=await session({starts:new Date(Date.now()-60000),ends:new Date(Date.now()+3600000)});const af=await command('ADMIT',started,{expectedVersion:1,passId:pf.id});await deny('REVERSE_REDEMPTION',af.booking.id,{expectedVersion:2,passId:pf.id,reason:'Session already started'});check();
 const unused=await issue(product,a,2),reverseContext=ctx();const ur=await command('REVERSE_ISSUANCE',unused.id,{expectedVersion:1,reason:'Unused allowance withdrawn'},reverseContext);assert.equal(ur.status,'REVERSED');assert.equal(ur.remainingUses,0);assert.equal((await command('REVERSE_ISSUANCE',unused.id,{expectedVersion:1,reason:'Unused allowance withdrawn'},reverseContext)).replayed,true);await deny('ADMIT',await session(),{expectedVersion:2,passId:unused.id});check();
 // Trigger failures prove business, evidence, idempotency and outbox roll back together.
 await admin.query("CREATE FUNCTION hon.classpass_local_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='classpass.operational' THEN RAISE EXCEPTION 'LOCAL_ATOMICITY_PROBE' USING ERRCODE='22023'; END IF; RETURN NEW; END $$; REVOKE ALL ON FUNCTION hon.classpass_local_fail() FROM PUBLIC; CREATE TRIGGER classpass_local_fail BEFORE INSERT ON hon.outbox_events FOR EACH ROW EXECUTE FUNCTION hon.classpass_local_fail()");
 await deny('ISSUE',product,{expectedVersion:2,studentProfileId:a,issuanceKind:'MANUAL_NONFINANCIAL',reason:'Atomicity probe'});
 await admin.query('DROP TRIGGER classpass_local_fail ON hon.outbox_events; DROP FUNCTION hon.classpass_local_fail()');check();
 // Role/entitlement time expiry is rechecked after a canonical session wait.
 const expPass=await issue(product,a,2),locked=await session();await admin.query("UPDATE hon.principal_role_grants SET effective_from=now()-interval '1 day',effective_until=clock_timestamp()+interval '2 seconds' WHERE id=$1",[ids.grant]);
 await admin.query('BEGIN');await admin.query('SELECT id FROM hon.class_sessions WHERE id=$1 FOR UPDATE',[locked]);
 const blocked=service.command(ctx(),'ADMIT',locked,{expectedVersion:1,passId:expPass.id});const blockedResult=blocked.then(()=>null,e=>e);await waitForSqlLocks('SELECT hon.command_classpass');await waitForGrantExpiry();await admin.query('COMMIT');assert.equal((await blockedResult).getStatus(),403);await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1',[ids.grant]);check();
 // Same key: both callers are observed waiting before releasing the session.
 const identicalPass=await issue(product,await student(),2),identicalSession=await session(),identicalCtx=ctx();
 await admin.query('BEGIN');await admin.query('SELECT id FROM hon.class_sessions WHERE id=$1 FOR UPDATE',[identicalSession]);
 const one=service.command(identicalCtx,'ADMIT',identicalSession,{expectedVersion:1,passId:identicalPass.id});
 await waitForSqlLocks('SELECT hon.command_classpass');
 const two=service.command({...identicalCtx,requestId:randomUUID(),correlationId:randomUUID()},'ADMIT',identicalSession,{expectedVersion:1,passId:identicalPass.id});
 await waitForSqlLocks('SELECT hon.command_classpass',2);await admin.query('COMMIT');
 const identical=await Promise.all([one,two]);assert.deepEqual(identical.map(r=>r.replayed).sort(),[false,true]);
 assert.deepEqual(identical.map(({replayed,...receipt})=>receipt)[0],identical.map(({replayed,...receipt})=>receipt)[1]);
 assert.equal(Number((await admin.query("SELECT count(*) n FROM hon.classpass_ledger WHERE pass_id=$1 AND kind='REDEMPTION'",[identicalPass.id])).rows[0].n),1);
 assert.equal(Number((await admin.query('SELECT count(*) n FROM hon.class_bookings WHERE classpass_id=$1',[identicalPass.id])).rows[0].n),1);
 const saved=(await admin.query('SELECT status,response_body FROM hon.idempotency_records WHERE principal_id=$1 AND idempotency_key=$2',[ids.principal,identicalCtx.idempotencyKey])).rows;assert.equal(saved.length,1);assert.equal(saved[0].status,'COMPLETED');
 const {replayed,...receipt}=identical[0];assert.deepEqual(saved[0].response_body,receipt);
 assert.equal(Number((await admin.query("SELECT count(*) n FROM hon.audit_events WHERE request_id=$1 AND action_code='classpass.admit'",[identicalCtx.requestId])).rows[0].n),1);
 assert.equal(Number((await admin.query("SELECT count(*) n FROM hon.outbox_events WHERE causation_id=$1 AND event_type='classpass.operational'",[identicalCtx.requestId])).rows[0].n),1);check();
 // Mixed canonical lock contention, in both deterministic arrival orders.
 // Generic WALK_IN intentionally may overcapacity; ClassPass never consumes an
 // unavailable seat and never changes that documented generic rule.
 for(const first of ['classpass','generic']){
  const mixed=await session(),pass=await issue(product,await student(),2),genericStudent=await student();
  const before=await snapshot();await admin.query('BEGIN');await admin.query('SELECT id FROM hon.class_sessions WHERE id=$1 FOR UPDATE',[mixed]);
  const cp=()=>service.command(ctx(),'ADMIT',mixed,{expectedVersion:1,passId:pass.id});
  const gb=()=>generic.create(ctx(),mixed,{studentProfileId:genericStudent,bookingKind:'REGULAR'});
  const firstPending=first==='classpass'?cp():gb();await waitForSqlLocks(first==='classpass'?'SELECT hon.command_classpass':'FROM hon.lock_class_booking_session');
  const secondPending=first==='classpass'?gb():cp();await waitForSqlLocks(first==='classpass'?'FROM hon.lock_class_booking_session':'SELECT hon.command_classpass');await admin.query('COMMIT');
  const results=await Promise.all([firstPending,secondPending]),cpResult=results[first==='classpass'?0:1],genericResult=results[first==='generic'?0:1];
  assert.equal(genericResult.booking.status,'BOOKED');assert.equal(cpResult.decision,first==='classpass'?'ADMITTED_REDEEMED':'WAITLISTED_NOT_REDEEMED');
  assert.equal(Number((await admin.query("SELECT count(*) n FROM hon.class_bookings WHERE class_session_id=$1 AND status IN('BOOKED','CHECKED_IN')",[mixed])).rows[0].n),first==='classpass'?2:1);
  assert.equal((await read('PASS',pass.id)).remainingUses,first==='classpass'?4:5);
  assert.equal(Number((await admin.query("SELECT count(*) n FROM hon.classpass_ledger WHERE pass_id=$1 AND kind='REDEMPTION'",[pass.id])).rows[0].n),first==='classpass'?1:0);
  const after=await snapshot();for(const table of tables)if(!allowed.has(table))assert.equal(after[table],before[table]);
 }check();
 groups+=await testClassPassCompletionCases({admin,runtime,db,ids,ctx,command,deny,read,issue,student,session,snapshot,product});
 await command('RETIRE_PRODUCT',product,{expectedVersion:2,reason:'Retire future issuance'});await deny('ISSUE',product,{expectedVersion:3,studentProfileId:a,issuanceKind:'MANUAL_NONFINANCIAL',reason:'Retired'});
 await deny('CONFIGURE_PRODUCT',product,{...config,expectedVersion:3});check();
 const ledger=(await admin.query('SELECT pass_id,sum(use_delta)::integer total,count(*) n FROM hon.classpass_ledger GROUP BY pass_id')).rows;for(const l of ledger){const p=(await admin.query('SELECT remaining_uses FROM hon.classpass_passes WHERE id=$1',[l.pass_id])).rows[0];assert.equal(l.total,p.remaining_uses);}
 const before=await snapshot();for(const sql of ['UPDATE hon.classpass_ledger SET use_delta=0','DELETE FROM hon.classpass_ledger','TRUNCATE hon.classpass_ledger','UPDATE hon.classpass_passes SET allowed_uses=9'])await assert.rejects(()=>admin.query(sql),e=>e.code==='42501');assert.deepEqual(await snapshot(),before);check();
 // Live revocation denies even a saved idempotent receipt.
 await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='classpass.admit'",[ids.role]);await deny('ADMIT',s,{expectedVersion:1,passId:pa.id},admissionContext,403);check();
 await verifyClassPassSecurity(admin,'hon_classpass_runtime');
 await admin.query(canonical);
 const jsVerification=spawnSync(process.execPath,[new URL('./verify-rls.mjs',import.meta.url).pathname],{encoding:'utf8',env:{...safeEnv,DATABASE_URL:process.env.DATABASE_URL,HON_RUNTIME_DATABASE_URL:process.env.HON_RUNTIME_DATABASE_URL}});
 assert.equal(jsVerification.status,0,jsVerification.stderr);console.log('Canonical full SQL verification passed twice; JS verify-rls passed.');
 assert(readOnlyChecks>0);assert.equal(externalCalls,0);console.log(`ClassPass integrity passed: ${groups} assertion groups, ${aclProbes} rollback-only ACL drift checks, ${commands} verified commands, ${readOnlyChecks} real read-only checks, ${tables.length} full-table snapshots; external calls 0.`);
} finally {await admin.query('ROLLBACK');await runtime.query('ROLLBACK');await db.onModuleDestroy();await runtime.end();await admin.end();teardown();}
