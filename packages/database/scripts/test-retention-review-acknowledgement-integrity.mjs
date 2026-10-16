import { loadRetentionAcknowledgementValidationEnv } from './retention-review-acknowledgement-env.mjs';
loadRetentionAcknowledgementValidationEnv();
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { proveRetentionAttention } from './retention-attention-integrity.mjs';
import { retentionAcknowledgementTables as privateTables, retentionAcknowledgementFunctions as functions, verifyRetentionAcknowledgementSecurity } from './retention-review-acknowledgement-security.mjs';
import { verifyRetentionReviewSecurity } from './retention-review-security.mjs';
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { RetentionReviewService } = await import('../../../apps/api/dist/retention-review/retention-review.service.js');
let groups=0,operations=0,aclProbes=0,externalCalls=0;
const forbidden=()=>{externalCalls++;throw new Error('External transport forbidden in retention acknowledgement proof');};
globalThis.fetch=forbidden;http.request=forbidden;http.get=forbidden;https.request=forbidden;https.get=forbidden;
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const o=Array.isArray(args[0])?args[0][0]:args[0];if(!(typeof o==='object'?o.port===5432&&o.host==='localhost':o===5432&&args[1]==='localhost'))return forbidden();return connect.apply(this,args);};
const owner=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false});
const runtime=new pg.Client({connectionString:process.env.HON_RUNTIME_DATABASE_URL,ssl:false});
const db=new RuntimeDatabaseService(),service=new RetentionReviewService(db);
const ids=Object.fromEntries(['org','otherOrg','school','otherSchool','siblingSchool','user','otherUser','principal','otherPrincipal','role','otherRole','grant','otherGrant','person','otherPerson','billing','otherBilling','membership','otherMembership','family','student','renewal','program','session','attendance','curriculum','rank','requirement','enrollment','observation','testingEvent','candidate'].map(k=>[k,randomUUID()]));
const subject='retention-local-'+randomUUID(),otherSubject='retention-other-'+randomUUID();
const context=(patch={})=>{const requestId=randomUUID();return{organizationId:ids.org,schoolId:ids.school,principalId:ids.principal,principalType:'HUMAN_USER',source:'HUMAN_UI',externalSubject:subject,requestId,correlationId:requestId,...patch};};
const other=context({organizationId:ids.otherOrg,schoolId:ids.otherSchool,principalId:ids.otherPrincipal,externalSubject:otherSubject});
const check=()=>groups++,status=n=>e=>e?.getStatus?.()===n;
let tables;
async function snapshot(excluded=[]){const result={};for(const table of tables){if(excluded.includes(table))continue;assert(/^[a-z_]+$/.test(table));result[table]=(await owner.query(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) hash FROM hon.${table} t`)).rows[0].hash;}return result;}
async function checked(work,allowed=[]){const before=await snapshot();try{const result=await work();operations++;const after=await snapshot();for(const table of tables)if(!allowed.includes(table))assert.equal(after[table],before[table],'Unexpected platform write: '+table);return result;}catch(error){assert.deepEqual(await snapshot(),before,'Denied/failed command wrote platform data');throw error;}}
const evidence=(c=context(),membership=ids.membership)=>checked(()=>service.acknowledgementEvidence(c,membership));
const input=e=>({evidenceVersion:e.evidenceVersion,evidenceFingerprint:e.evidenceFingerprint,observedAt:e.signals.observedAt,idempotencyKey:randomUUID()});
const allowed=[...privateTables,'audit_events'];
const ack=(value,c=context(),membership=ids.membership)=>checked(()=>service.acknowledge(c,membership,value),allowed);
async function raw(c,sql,args){await runtime.query('BEGIN');try{await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_source',$5,true),set_config('app.hon_external_subject',$6,true),set_config('app.hon_action_request_id',$7,true),set_config('app.hon_delegated_by_principal_id',$8,true)",[c.organizationId,c.schoolId,c.principalId,c.principalType,c.source,c.externalSubject,c.actionRequestId??'',c.delegatedByPrincipalId??'']);return await runtime.query(sql,args);}finally{await runtime.query('ROLLBACK');}}
async function evidenceFacts(value){return(await owner.query(`WITH acknowledgements AS (
 SELECT id FROM hon.retention_review_acknowledgements WHERE organization_id=$1 AND school_id=$2 AND membership_id=$3 AND actor_principal_id=$4 AND evidence_version=$5 AND evidence_fingerprint=$6 AND observed_at=$7
) SELECT (SELECT count(*)::int FROM acknowledgements) acknowledgements,
 (SELECT count(*)::int FROM hon.retention_review_acknowledgement_evidence_keys WHERE organization_id=$1 AND school_id=$2 AND membership_id=$3 AND actor_principal_id=$4 AND evidence_version=$5 AND evidence_fingerprint=$6 AND observed_at=$7) evidence_keys,
 (SELECT count(*)::int FROM hon.retention_review_acknowledgement_receipts WHERE acknowledgement_id IN(SELECT id FROM acknowledgements)) receipts,
 (SELECT count(*)::int FROM hon.retention_review_acknowledgement_outbox WHERE acknowledgement_id IN(SELECT id FROM acknowledgements) AND state='INERT') inert_outbox,
 (SELECT count(*)::int FROM hon.audit_events WHERE entity_id IN(SELECT id FROM acknowledgements) AND action_code='retention.review.acknowledge') audits`,[ids.org,ids.school,ids.membership,ids.principal,value.evidenceVersion,value.evidenceFingerprint,value.observedAt])).rows[0];}
const rawAck=(c,value,membership=ids.membership)=>raw(c,'SELECT hon.acknowledge_retention_review_evidence($1,$2,$3,$4,$5,$6,$7,$8)',[c.externalSubject,membership,value.evidenceVersion,value.evidenceFingerprint,value.observedAt,value.idempotencyKey,c.requestId,c.correlationId]);
const fixtureOwnerContext=requestId=>owner.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$4,true),set_config('app.hon_request_id',$5,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)",[ids.org,ids.school,ids.principal,subject,requestId]);
async function appendFixtureRenewalVersion(version,status){const requestId=randomUUID();await owner.query('BEGIN');try{await fixtureOwnerContext(requestId);await owner.query("INSERT INTO hon.membership_renewal_versions(renewal_id,organization_id,school_id,version,review_from,review_to,status,note,reason,reminder_needed,membership_facts,operation,actor_principal_id,source,request_id) SELECT $1,$2,$3,$4,clock_timestamp()-interval '14 days',clock_timestamp()+interval '16 days',$5,'Fixture renewal reviewed','Fixture renewal state change',false,hon.renewal_membership_facts($6),'REVISE',$7,'HUMAN_UI',$8",[ids.renewal,ids.org,ids.school,version,status,ids.membership,ids.principal,requestId]);await owner.query('COMMIT');}catch(error){await owner.query('ROLLBACK');throw error;}}
async function appendFixtureAttendanceRecord(){const requestId=randomUUID();await owner.query('BEGIN');try{await fixtureOwnerContext(requestId);await owner.query("INSERT INTO hon.attendance_records(id,organization_id,school_id,class_session_id,student_profile_id,status,recorded_at) VALUES($1,$2,$3,$4,$5,'PRESENT',clock_timestamp()-interval '1 day')",[ids.attendance,ids.org,ids.school,ids.session,ids.student]);await owner.query('COMMIT');}catch(error){await owner.query('ROLLBACK');throw error;}}
async function appendFixtureObservation(){const requestId=randomUUID();await owner.query('BEGIN');try{await fixtureOwnerContext(requestId);await owner.query("INSERT INTO hon.curriculum_progress_observations(id,organization_id,school_id,enrollment_id,curriculum_id,curriculum_rank_id,requirement_id,requirement_version,enrollment_version,version,status,actor_principal_id,source,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,1,1,1,'PRACTICING',$8,'HUMAN_UI',$9)",[ids.observation,ids.org,ids.school,ids.enrollment,ids.curriculum,ids.rank,ids.requirement,ids.principal,requestId]);await owner.query('COMMIT');}catch(error){await owner.query('ROLLBACK');throw error;}}
function teardown(){const sql=`DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='hon_retention_acknowledgement_validation' AND pg_get_userbyid(datdba)='hon_retention_acknowledgement_owner' AND shobj_description(oid,'pg_database')='HON disposable retention_acknowledgement validation') THEN RAISE EXCEPTION 'Refusing unmarked fixture'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('hon_retention_acknowledgement_owner','hon_retention_acknowledgement_runtime') AND shobj_description(oid,'pg_authid') IS DISTINCT FROM 'HON disposable retention_acknowledgement validation') THEN RAISE EXCEPTION 'Refusing unmarked roles'; END IF;
 END $$; DROP DATABASE hon_retention_acknowledgement_validation WITH (FORCE); DROP ROLE hon_retention_acknowledgement_runtime; DROP ROLE hon_retention_acknowledgement_owner;`;
 const result=spawnSync('sudo',['-u','postgres','psql','-X','-q','-v','ON_ERROR_STOP=1','-h','/var/run/postgresql','-p','5432','-d','postgres'],{input:sql,encoding:'utf8',env:{PATH:process.env.PATH,HOME:'/home/ubuntu',LANG:'C.UTF-8'}});if(result.status!==0)throw new Error('Marked retention fixture teardown failed');}
let passed=false;
await owner.connect();await runtime.connect();
try{
 const marker=(await owner.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];assert.equal(marker.owner,'hon_retention_acknowledgement_owner');assert.equal(marker.marker,'HON disposable retention_acknowledgement validation');
 await verifyRetentionAcknowledgementSecurity(owner,'hon_retention_acknowledgement_runtime');await verifyRetentionReviewSecurity(owner,'hon_retention_acknowledgement_runtime');
 const canonical=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_retention_acknowledgement_runtime');await owner.query(canonical);check();
 for(const table of privateTables)for(const drift of [`GRANT SELECT ON hon.${table} TO hon_retention_acknowledgement_runtime`,`GRANT SELECT(id) ON hon.${table} TO PUBLIC`,`GRANT UPDATE(id) ON hon.${table} TO hon_retention_acknowledgement_runtime`,`ALTER TABLE hon.${table} NO FORCE ROW LEVEL SECURITY`,`ALTER TABLE hon.${table} DISABLE ROW LEVEL SECURITY`,`CREATE POLICY retention_drift ON hon.${table} USING(true)`,`ALTER TABLE hon.${table} DISABLE TRIGGER retention_ack_immutable`,`ALTER TABLE hon.${table} DISABLE TRIGGER retention_ack_no_truncate`,`ALTER TABLE hon.${table} ADD COLUMN private_note text`]){
  await owner.query('BEGIN');try{await owner.query(drift);await assert.rejects(()=>verifyRetentionAcknowledgementSecurity(owner,'hon_retention_acknowledgement_runtime'));aclProbes++;}finally{await owner.query('ROLLBACK');}
 }
 const historicalCommand=(await readFile(new URL('../migrations/0123_human_retention_review_acknowledgement.sql',import.meta.url),'utf8')).match(/CREATE FUNCTION hon\.acknowledge_retention_review_evidence\([\s\S]*?END \$\$;/)[0].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
 for(const drift of [
  'ALTER TABLE hon.retention_review_acknowledgement_evidence_keys DROP CONSTRAINT retention_ack_evidence_natural_key',
  'ALTER TABLE hon.retention_review_acknowledgement_evidence_keys DROP CONSTRAINT retention_ack_evidence_ack_fk',
  'ALTER TABLE hon.retention_review_acknowledgement_evidence_keys ALTER CONSTRAINT retention_ack_evidence_ack_fk NOT DEFERRABLE',
  'ALTER TABLE hon.retention_review_acknowledgement_evidence_keys ALTER CONSTRAINT retention_ack_evidence_ack_fk DEFERRABLE INITIALLY IMMEDIATE',
  'ALTER TABLE hon.retention_review_acknowledgement_evidence_keys ALTER COLUMN observed_at DROP NOT NULL',
  'ALTER TABLE hon.retention_review_acknowledgement_receipts ADD UNIQUE(acknowledgement_id)',
  historicalCommand]){
  await owner.query('BEGIN');try{await owner.query(drift);await assert.rejects(()=>verifyRetentionAcknowledgementSecurity(owner,'hon_retention_acknowledgement_runtime'));aclProbes++;}finally{await owner.query('ROLLBACK');}
 }
 for(const [signature,executable]of functions)for(const drift of [`GRANT EXECUTE ON FUNCTION hon.${signature} TO PUBLIC`,`GRANT EXECUTE ON FUNCTION hon.${signature} TO hon_retention_acknowledgement_runtime WITH GRANT OPTION`,...(executable?[`REVOKE EXECUTE ON FUNCTION hon.${signature} FROM hon_retention_acknowledgement_runtime`]:[])]){
  await owner.query('BEGIN');try{await owner.query(drift);await assert.rejects(()=>verifyRetentionAcknowledgementSecurity(owner,'hon_retention_acknowledgement_runtime'));aclProbes++;}finally{await owner.query('ROLLBACK');}
 }
 for(const table of privateTables){for(const sql of [`SELECT * FROM hon.${table}`,`INSERT INTO hon.${table}(id) VALUES(gen_random_uuid())`,`UPDATE hon.${table} SET id=id`,`DELETE FROM hon.${table}`,`TRUNCATE hon.${table}`])await assert.rejects(()=>runtime.query(sql),e=>e.code==='42501');
  await owner.query('BEGIN');try{await owner.query(`GRANT SELECT ON hon.${table} TO hon_retention_acknowledgement_runtime`);await owner.query('SET LOCAL ROLE hon_retention_acknowledgement_runtime');assert.deepEqual((await owner.query(`SELECT * FROM hon.${table}`)).rows,[]);await owner.query('RESET ROLE');}finally{await owner.query('ROLLBACK');}
 }check();
 await owner.query('BEGIN');
 await owner.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Local','Local'),($2,'Other','Other')",[ids.org,ids.otherOrg]);
 await owner.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$3,'Local',$1::uuid::text),($2,$4,'Other',$2::uuid::text),($5,$3,'Sibling',$5::uuid::text)",[ids.school,ids.otherSchool,ids.org,ids.otherOrg,ids.siblingSchool]);
 await owner.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'ESSENTIAL','ACTIVE'),($2,'CORE','ACTIVE')",[ids.org,ids.otherOrg]);
 for(const [u,p,r,g,o,s,sub,person,billing,membership]of [[ids.user,ids.principal,ids.role,ids.grant,ids.org,ids.school,subject,ids.person,ids.billing,ids.membership],[ids.otherUser,ids.otherPrincipal,ids.otherRole,ids.otherGrant,ids.otherOrg,ids.otherSchool,otherSubject,ids.otherPerson,ids.otherBilling,ids.otherMembership]]){
		  await owner.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$1::uuid::text||'@example.test','PII_CANARY_STAFF')",[u,sub]);
		  await owner.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','PII_CANARY_STAFF')",[p,u]);
		  await owner.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role,management_school_id) VALUES($1,$2,'OWNER','Owner',true,$3)",[r,o,s]);
		  for(const permission of ['retention.review.read','retention.review.acknowledge','retention.review.alert.read','retention.review.alert.record','retention.review.alert.resolve',...(o===ids.org?['billing.membership.read','billing.renewal.manage','attendance.record','curriculum.progress.record']:[])])await owner.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[r,o,permission]);
		  await owner.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)',[g,o,s,p,r]);
		  await owner.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'PII_CANARY_CONTACT','PII_CANARY_PERSON')",[person,o,s]);
		  await owner.query('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)',[billing,o,s,person]);
	  await owner.query("INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at) VALUES($1,$2,$3,$4,$5,'PII_CANARY_PLAN','ACTIVE',now()-interval '30 days',now()+interval '60 days')",[membership,o,s,billing,person]);
	 }
	 const fixtureRenewalRequestId=randomUUID();await fixtureOwnerContext(fixtureRenewalRequestId);
	 await owner.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)',[ids.student,ids.org,ids.school,ids.person]);
	 await owner.query("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Fixture program','SCHEDULED')",[ids.program,ids.org,ids.school]);
	 await owner.query("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status) VALUES($1,$2,$3,$4,'Fixture completed session',clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',1,'OPTIONAL_BOOKING','COMPLETED')",[ids.session,ids.org,ids.school,ids.program]);
	 await owner.query("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code) VALUES($1,$2,$3,'Fixture curriculum','LINEAR')",[ids.curriculum,ids.org,ids.school]);
	 await owner.query("INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,'Fixture rank',1)",[ids.rank,ids.org,ids.school,ids.curriculum]);
	 await owner.query("INSERT INTO hon.curriculum_requirements(id,organization_id,school_id,curriculum_rank_id,requirement_code,requirement_kind,definition,is_required) VALUES($1,$2,$3,$4,'FIXTURE_REQUIREMENT','TECHNIQUE','{\"label\":\"Fixture requirement\"}'::jsonb,true)",[ids.requirement,ids.org,ids.school,ids.rank]);
	 await owner.query("INSERT INTO hon.testing_events(id,organization_id,school_id,curriculum_id,name,starts_at,status) VALUES($1,$2,$3,$4,'Fixture testing event',clock_timestamp()+interval '1 day','OPEN')",[ids.testingEvent,ids.org,ids.school,ids.curriculum]);
	 await owner.query('INSERT INTO hon.membership_renewal_reviews(id,organization_id,school_id,membership_id,created_by_principal_id) VALUES($1,$2,$3,$4,$5)',[ids.renewal,ids.org,ids.school,ids.membership,ids.principal]);
	 await owner.query("INSERT INTO hon.membership_renewal_versions(renewal_id,organization_id,school_id,version,review_from,review_to,status,note,reason,reminder_needed,membership_facts,operation,actor_principal_id,source,request_id,recorded_at) SELECT $1,$2,$3,1,clock_timestamp()-interval '15 days',clock_timestamp()+interval '15 days','OPEN','Fixture renewal opened','Fixture renewal baseline',false,hon.renewal_membership_facts($4),'CREATE',$5,'HUMAN_UI',$6,clock_timestamp()-interval '2 days'",[ids.renewal,ids.org,ids.school,ids.membership,ids.principal,fixtureRenewalRequestId]);
		 await owner.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PII_CANARY_FAMILY')",[ids.family,ids.org,ids.school]);
		 await owner.query('COMMIT');
 tables=(await owner.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hon' AND relkind='r' ORDER BY relname")).rows.map(r=>r.relname);
 await proveRetentionAttention({owner,runtime,service,ids,context,other,checked,snapshot,raw,fixtureOwnerContext});
 // The original read remains READ ONLY, redacted and creates no evidence writes.
 const original=await checked(()=>service.read(context(),ids.membership));assert.equal(original.readOnly,true);assert.equal(original.membershipId,ids.membership);check();
 const e=await evidence(),value=input(e);assert(!JSON.stringify(e).includes('PII_CANARY'));check();
 const result=await ack(value);assert.equal(result.state,'EVIDENCE_REVIEWED');assert.equal(result.noDownstreamEffect,true);
 assert.deepEqual(await ack(value),result);check();
 // Rollback-only upgrade proof: reproduce the actual 0123 distinct-key bug,
 // apply 0124 to populated immutable history, and verify deterministic newest
 // seeding without deleting/revising any existing acknowledgement or fact.
 const legacy=input(await evidence()),legacyKeys=[randomUUID(),randomUUID()];const upgradeBefore=await snapshot();
 const forwardMigration=(await readFile(new URL('../migrations/0124_retention_review_acknowledgement_evidence_key.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'').replaceAll('hon_runtime','hon_retention_acknowledgement_runtime');
 await owner.query('BEGIN');try{
  await owner.query('DROP TABLE hon.retention_review_acknowledgement_evidence_keys; ALTER TABLE hon.retention_review_acknowledgement_receipts ADD CONSTRAINT retention_review_acknowledgement_receipt_acknowledgement_id_key UNIQUE(acknowledgement_id)');
  await owner.query(historicalCommand);await fixtureOwnerContext(randomUUID());
  const invoke=async key=>(await owner.query('SELECT hon.acknowledge_retention_review_evidence($1,$2,$3,$4,$5,$6,$7,$8) data',[subject,ids.membership,legacy.evidenceVersion,legacy.evidenceFingerprint,legacy.observedAt,key,randomUUID(),randomUUID()])).rows[0].data;
  const older=await invoke(legacyKeys[0]);await owner.query('SELECT pg_sleep(0.005)');const newer=await invoke(legacyKeys[1]);assert.notEqual(older.acknowledgementId,newer.acknowledgementId);
  const historyBefore=await snapshot(['retention_review_acknowledgement_evidence_keys']);
  await owner.query(forwardMigration);assert.deepEqual(await snapshot(['retention_review_acknowledgement_evidence_keys']),historyBefore,'Forward migration changed immutable history');
  const canonicalSeed=(await owner.query(`SELECT key.acknowledgement_id,(SELECT id FROM hon.retention_review_acknowledgements WHERE organization_id=key.organization_id AND school_id=key.school_id AND membership_id=key.membership_id AND actor_principal_id=key.actor_principal_id AND evidence_version=key.evidence_version AND evidence_fingerprint=key.evidence_fingerprint AND observed_at=key.observed_at ORDER BY recorded_at DESC,id DESC LIMIT 1) expected FROM hon.retention_review_acknowledgement_evidence_keys key WHERE key.evidence_fingerprint=$1 AND key.observed_at=$2`,[legacy.evidenceFingerprint,legacy.observedAt])).rows;
  assert.equal(canonicalSeed.length,1);assert.equal(canonicalSeed[0].acknowledgement_id,canonicalSeed[0].expected);assert.equal(canonicalSeed[0].acknowledgement_id,newer.acknowledgementId);
  await verifyRetentionAcknowledgementSecurity(owner,'hon_retention_acknowledgement_runtime');
  assert.deepEqual(await invoke(legacyKeys[0]),older);assert.deepEqual(await invoke(legacyKeys[1]),newer);assert.deepEqual(await snapshot(['retention_review_acknowledgement_evidence_keys']),historyBefore,'Historical receipt replay wrote evidence');
  assert.deepEqual(await invoke(randomUUID()),newer);assert.deepEqual(await snapshot(['retention_review_acknowledgement_evidence_keys','retention_review_acknowledgement_receipts']),await Promise.resolve(Object.fromEntries(Object.entries(historyBefore).filter(([table])=>table!=='retention_review_acknowledgement_receipts'))),'New key for historical evidence wrote more than its receipt');
  assert.deepEqual(await evidenceFacts(legacy),{acknowledgements:2,evidence_keys:1,receipts:3,inert_outbox:2,audits:2});
 }finally{await owner.query('ROLLBACK');}
 assert.deepEqual(await snapshot(),upgradeBefore);await verifyRetentionAcknowledgementSecurity(owner,'hon_retention_acknowledgement_runtime');check();
 // Same-key concurrency yields exactly one immutable acknowledgement/receipt/audit/outbox.
 const concurrent=input(await evidence());const before=await snapshot();const outputs=await Promise.all([service.acknowledge(context(),ids.membership,concurrent),service.acknowledge(context(),ids.membership,concurrent)]);assert.deepEqual(outputs[0],outputs[1]);const after=await snapshot();for(const table of tables)if(!allowed.includes(table))assert.equal(after[table],before[table]);
 assert.deepEqual(await evidenceFacts(concurrent),{acknowledgements:1,evidence_keys:1,receipts:1,inert_outbox:1,audits:1});check();
 // Distinct keys contend on the exact evidence lock before either may write.
 // Observe BOTH blocked transactions, not merely Promise.all of possibly serial
 // completions. Release the barrier and require one fact with two key receipts.
 const distinct=input(await evidence()),second={...distinct,idempotencyKey:randomUUID()};assert.notEqual(distinct.idempotencyKey,second.idempotencyKey);
 assert.deepEqual(await evidenceFacts(distinct),{acknowledgements:0,evidence_keys:0,receipts:0,inert_outbox:0,audits:0});
 const distinctBefore=await snapshot();await owner.query('BEGIN');
 await owner.query(`SELECT pg_advisory_xact_lock(hashtextextended('retention.ack.evidence:'||jsonb_build_array($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,to_char($7::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text,0))`,[ids.org,ids.school,ids.membership,ids.principal,distinct.evidenceVersion,distinct.evidenceFingerprint,distinct.observedAt]);
 const pendingDistinct=Promise.all([service.acknowledge(context(),ids.membership,distinct),service.acknowledge(context(),ids.membership,second)]);pendingDistinct.catch(()=>{});
 try{let waiting=0;const deadline=Date.now()+2000;do{
  waiting=(await owner.query(`SELECT count(DISTINCT waiter.pid)::int n FROM pg_locks holder JOIN pg_locks waiter ON waiter.locktype=holder.locktype AND waiter.database=holder.database AND waiter.classid=holder.classid AND waiter.objid=holder.objid AND waiter.objsubid=holder.objsubid WHERE holder.locktype='advisory' AND holder.pid=pg_backend_pid() AND holder.granted AND NOT waiter.granted`)).rows[0].n;
  if(waiting!==2)await new Promise(resolve=>setTimeout(resolve,20));
 }while(waiting!==2&&Date.now()<deadline);assert.equal(waiting,2,'Both distinct-key transactions must contend on the natural evidence lock');}
 finally{await owner.query('COMMIT');}
 const distinctOutputs=await pendingDistinct;assert.deepEqual(distinctOutputs[0],distinctOutputs[1]);
 const distinctAfter=await snapshot();for(const table of tables)if(!allowed.includes(table))assert.equal(distinctAfter[table],distinctBefore[table],'Distinct-key command wrote unrelated table: '+table);
 const distinctCounts={acknowledgements:1,evidence_keys:1,receipts:2,inert_outbox:1,audits:1};assert.deepEqual(await evidenceFacts(distinct),distinctCounts);
 for(const payload of [distinct,second])assert.deepEqual(await checked(()=>service.acknowledge(context(),ids.membership,payload)),distinctOutputs[0]);
 assert.deepEqual(await evidenceFacts(distinct),distinctCounts);
 const anotherObservation=input(await evidence());await assert.rejects(()=>ack({...anotherObservation,idempotencyKey:distinct.idempotencyKey}),status(409));check();
 // A later different key appends ONLY its own receipt for the existing ack.
 const third={...distinct,idempotencyKey:randomUUID()};assert.deepEqual(await checked(()=>service.acknowledge(context(),ids.membership,third),['retention_review_acknowledgement_receipts']),distinctOutputs[0]);
 assert.deepEqual(await evidenceFacts(distinct),{...distinctCounts,receipts:3});check();
 const foreign=input(await evidence(other,ids.otherMembership));await ack(foreign,other,ids.otherMembership);
 await assert.rejects(()=>evidence(context(),ids.otherMembership),status(404));await assert.rejects(()=>ack(value,other),status(404));
 await assert.rejects(()=>evidence(context({schoolId:ids.siblingSchool})),status(403));check();
 const fresh=input(await evidence());await assert.rejects(()=>ack({...fresh,evidenceFingerprint:'0'.repeat(64)}),status(409));await assert.rejects(()=>ack({...fresh,observedAt:new Date(Date.now()-6*60_000).toISOString()}),status(409));await assert.rejects(()=>ack({...fresh,observedAt:new Date(Date.now()+60_000).toISOString()}),status(409));
 for(const patch of [{evidenceVersion:'V2'},{evidenceFingerprint:'private-note'},{note:'private'},{idempotencyKey:'text-note'},{observedAt:'not-a-time'}])await assert.rejects(()=>ack({...fresh,...patch}),status(400));check();
 // Live source changed: stale initial read AND its already successful receipt fail closed.
	 await owner.query("UPDATE hon.memberships SET term_ends_at=term_ends_at-interval '1 day',version=version+1 WHERE id=$1",[ids.membership]);
	 await assert.rejects(()=>ack(fresh),status(409));await assert.rejects(()=>ack(value),status(409));
	 const changed=input(await evidence());await assert.rejects(()=>ack({...changed,idempotencyKey:value.idempotencyKey}),status(409));await ack(changed);check();
	 // Every other observed-facts category is recomputed from its real, scoped source
	 // record after the read; no caller-provided source fact can satisfy acknowledgement.
	 const renewalBefore=await evidence(),renewalStale=input(renewalBefore);assert.equal(renewalBefore.signals.renewalReview.latestReviewState,'OPEN');
	 await appendFixtureRenewalVersion(2,'REVIEWED');const currentRenewal=(await owner.query('SELECT version,status FROM hon.membership_renewal_versions WHERE renewal_id=$1 ORDER BY version DESC LIMIT 1',[ids.renewal])).rows[0];assert.deepEqual(currentRenewal,{version:2,status:'REVIEWED'});
	 const renewalAfter=await evidence();assert.notDeepEqual(renewalAfter.signals.renewalReview,renewalBefore.signals.renewalReview,'Renewal review projection did not change after a new current version');assert.equal(renewalAfter.signals.renewalReview.latestReviewState,'REVIEWED');await assert.rejects(()=>ack(renewalStale),status(409));check();
	 const attendanceBefore=await evidence(),attendanceStale=input(attendanceBefore);assert.equal(attendanceBefore.signals.attendance.status,'INSUFFICIENT_DATA');assert.equal(Number(attendanceBefore.signals.attendance.recordedAttendanceCount),0);
	 await appendFixtureAttendanceRecord();
	 const attendanceAfter=await evidence();assert.notDeepEqual(attendanceAfter.signals.attendance,attendanceBefore.signals.attendance,'Attendance projection did not change for the scoped 28-day record');assert.equal(attendanceAfter.signals.attendance.status,'AVAILABLE');assert.equal(Number(attendanceAfter.signals.attendance.recordedAttendanceCount),1);assert.equal(Number(attendanceAfter.signals.attendance.presentCount),1);await assert.rejects(()=>ack(attendanceStale),status(409));check();
	 const enrollmentBefore=await evidence(),enrollmentStale=input(enrollmentBefore);assert.equal(enrollmentBefore.signals.progression.status,'UNAVAILABLE');assert.equal(Number(enrollmentBefore.signals.progression.curriculumEnrollmentCount),0);
	 await owner.query('INSERT INTO hon.student_curriculum_enrollments(id,organization_id,school_id,student_profile_id,curriculum_id,current_rank_id) VALUES($1,$2,$3,$4,$5,$6)',[ids.enrollment,ids.org,ids.school,ids.student,ids.curriculum,ids.rank]);
	 const enrollmentAfter=await evidence();assert.notDeepEqual(enrollmentAfter.signals.progression,enrollmentBefore.signals.progression,'Progression projection did not change for the scoped enrollment');assert.equal(enrollmentAfter.signals.progression.status,'AVAILABLE');assert.equal(Number(enrollmentAfter.signals.progression.curriculumEnrollmentCount),1);await assert.rejects(()=>ack(enrollmentStale),status(409));check();
	 const observationBefore=await evidence(),observationStale=input(observationBefore);assert.equal(Number(observationBefore.signals.progression.progressObservationCount),0);
	 await appendFixtureObservation();
	 const observationAfter=await evidence();assert.notDeepEqual(observationAfter.signals.progression,observationBefore.signals.progression,'Progression projection did not change for the scoped observation');assert.equal(Number(observationAfter.signals.progression.progressObservationCount),1);assert.equal(observationAfter.signals.progression.progressObservationAvailability,'AVAILABLE');await assert.rejects(()=>ack(observationStale),status(409));check();
	 const candidateBefore=await evidence(),candidateStale=input(candidateBefore);assert.equal(Number(candidateBefore.signals.progression.testingRecordCount),0);
	 await owner.query('INSERT INTO hon.testing_candidates(id,organization_id,school_id,testing_event_id,student_curriculum_enrollment_id,target_rank_id) VALUES($1,$2,$3,$4,$5,$6)',[ids.candidate,ids.org,ids.school,ids.testingEvent,ids.enrollment,ids.rank]);
	 const candidateAfter=await evidence();assert.notDeepEqual(candidateAfter.signals.progression,candidateBefore.signals.progression,'Progression projection did not change for the scoped testing candidate');assert.equal(Number(candidateAfter.signals.progression.testingRecordCount),1);assert.equal(candidateAfter.signals.progression.testingObservationAvailability,'AVAILABLE');await assert.rejects(()=>ack(candidateStale),status(409));check();
	 // Existing custom roles with exact authority remain allowed; no role-name upsell.
	 await owner.query("UPDATE hon.roles SET code='FRONT_DESK' WHERE id=$1",[ids.role]);await ack(input(await evidence()));await owner.query("UPDATE hon.roles SET code='OWNER' WHERE id=$1",[ids.role]);
 for(const tier of ['ESSENTIAL','CORE','COMPLETE']){await owner.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[ids.org,tier]);await ack(input(await evidence()));}check();
 const live=input(await evidence());
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{principalType:'SYSTEM_SERVICE'},{principalType:'PARENT'},{source:'AI'},{source:'AUTOMATION'},{source:'PUBLIC_API'},{source:'HQ_SUPPORT'},{externalSubject:'spoof'},{principalId:randomUUID()},{schoolId:ids.otherSchool},{organizationId:ids.otherOrg},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]){
  const c=context(patch);await assert.rejects(()=>ack(live,c),status(403));await assert.rejects(()=>checked(()=>rawAck(c,live)),e=>e.code==='42501');
 }check();
 for(const [sql,restore,args]of [
  ['UPDATE hon.principal_role_grants SET revoked_at=now(),revoked_by_principal_id=principal_id WHERE id=$1','UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[ids.grant]],
  ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1","UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[ids.org]],
  ['UPDATE hon.principals SET is_active=false WHERE id=$1','UPDATE hon.principals SET is_active=true WHERE id=$1',[ids.principal]],
  ["UPDATE hon.roles SET code='PARENT' WHERE id=$1","UPDATE hon.roles SET code='OWNER' WHERE id=$1",[ids.role]],
  ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1","UPDATE hon.schools SET status='ACTIVE' WHERE id=$1",[ids.school]],
  ["UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1","UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1",[ids.org]],
  ['UPDATE hon.roles SET management_school_id=$2 WHERE id=$1','UPDATE hon.roles SET management_school_id=$2 WHERE id=$1',[ids.role,ids.siblingSchool,ids.school]],
  ["DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='retention.review.acknowledge'","INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'retention.review.acknowledge')",[ids.role,ids.org]],
  ["DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='retention.review.read'","INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'retention.review.read')",[ids.role,ids.org]]]){
  const n=s=>Math.max(...[...s.matchAll(/\$(\d+)/g)].map(m=>Number(m[1])));await owner.query(sql,args.slice(0,n(sql)));await assert.rejects(()=>ack(live),status(403));await assert.rejects(()=>checked(()=>rawAck(context(),live)),e=>e.code==='42501');await owner.query(restore,restore.includes('management_school_id')?[ids.role,ids.school]:args.slice(0,n(restore)));
 }check();
 for(const roleCode of ['GUARDIAN','STUDENT','FAMILY','HQ','HON_OPERATOR','PLATFORM','SYSTEM']){await owner.query('UPDATE hon.roles SET code=$2 WHERE id=$1',[ids.role,roleCode]);await assert.rejects(()=>ack(live),status(403));}await owner.query("UPDATE hon.roles SET code='OWNER' WHERE id=$1",[ids.role]);
 await owner.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')",[ids.principal]);await assert.rejects(()=>ack(live),status(403));await owner.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1',[ids.principal]);
 await owner.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4)",[ids.org,ids.school,ids.family,ids.principal]);await assert.rejects(()=>ack(live),status(403));await owner.query('DELETE FROM hon.family_access_grants WHERE principal_id=$1',[ids.principal]);
 const ambiguous=randomUUID();await owner.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Ambiguous')",[ambiguous,ids.user]);await assert.rejects(()=>ack(live),status(403));await owner.query('DELETE FROM hon.principals WHERE id=$1',[ambiguous]);check();
 // Revocation committed while the command is waiting for its stable locks is
 // observed after locks, not masked by a before-lock authorization decision.
 const locked=input(await evidence());await owner.query('BEGIN');await owner.query('LOCK TABLE hon.attendance_records IN ROW EXCLUSIVE MODE');
 const pending=service.acknowledge(context(),ids.membership,locked);const pendingAssertion=assert.rejects(pending,status(403));
 await new Promise(resolve=>setTimeout(resolve,100));
 await owner.query('UPDATE hon.principal_role_grants SET revoked_at=now(),revoked_by_principal_id=principal_id WHERE id=$1',[ids.grant]);await owner.query('COMMIT');await pendingAssertion;
 await owner.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[ids.grant]);check();
 // Force failure at the last atomic write: neither acknowledgement, receipt nor
 // audit survives. No generic outbox/worker/event-consumer path is touched.
 await owner.query("CREATE FUNCTION hon.retention_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'local atomicity probe'; END $$; CREATE TRIGGER retention_fixture_fail BEFORE INSERT ON hon.retention_review_acknowledgement_outbox FOR EACH ROW EXECUTE FUNCTION hon.retention_fixture_fail()");
 await assert.rejects(async()=>ack(input(await evidence())),status(503));
 await owner.query('DROP TRIGGER retention_fixture_fail ON hon.retention_review_acknowledgement_outbox; DROP FUNCTION hon.retention_fixture_fail()');check();
 for(const table of privateTables)for(const sql of [`UPDATE hon.${table} SET id=id`,`DELETE FROM hon.${table}`,`TRUNCATE hon.${table}`])await assert.rejects(()=>owner.query(sql),e=>['42501','0A000'].includes(e.code));await assert.rejects(()=>owner.query('TRUNCATE hon.'+privateTables.join(',hon.')),e=>e.code==='42501');check();
 // Composite scope and permanently inert state cannot be forged by fixture owner.
 await assert.rejects(()=>owner.query("INSERT INTO hon.retention_review_acknowledgements(organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at,recorded_at) VALUES($1,$2,$3,$4,'RETENTION_REVIEW_SIGNALS_V1',$5,now(),now())",[ids.org,ids.school,ids.otherMembership,ids.principal,'0'.repeat(64)]),e=>e.code==='23503');check();
 // A natural-key loser cannot insert a duplicate key, and the deferred composite
 // FK rejects an orphan reservation at COMMIT, leaving every table unchanged.
 await assert.rejects(()=>checked(()=>owner.query("INSERT INTO hon.retention_review_acknowledgement_evidence_keys(organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at,acknowledgement_id) VALUES($1,$2,$3,$4,$5,$6,$7,gen_random_uuid())",[ids.org,ids.school,ids.membership,ids.principal,distinct.evidenceVersion,distinct.evidenceFingerprint,distinct.observedAt])),e=>e.code==='23505'&&e.constraint==='retention_ack_evidence_natural_key');
 await assert.rejects(()=>checked(async()=>{await owner.query('BEGIN');try{
  await owner.query("INSERT INTO hon.retention_review_acknowledgement_evidence_keys(organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at,acknowledgement_id) VALUES($1,$2,$3,$4,'RETENTION_REVIEW_SIGNALS_V1',$5,clock_timestamp(),gen_random_uuid())",[ids.org,ids.school,ids.membership,ids.principal,'0'.repeat(64)]);
  await owner.query('COMMIT');
 }finally{await owner.query('ROLLBACK');}}),e=>e.code==='23503'&&e.constraint==='retention_ack_evidence_ack_fk');check();
 for(const table of privateTables){const rows=JSON.stringify((await owner.query(`SELECT to_jsonb(t) data FROM hon.${table} t`)).rows);for(const canary of ['PII_CANARY',subject,otherSubject,value.idempotencyKey,process.env.DATABASE_URL,process.env.HON_RUNTIME_DATABASE_URL])assert(!rows.includes(canary),table+' leaked private data');}
 const audits=(await owner.query("SELECT next_state FROM hon.audit_events WHERE action_code='retention.review.acknowledge'")).rows;assert(audits.length>0);for(const {next_state}of audits){assert.equal(next_state.state,'EVIDENCE_REVIEWED');assert.equal(next_state.noDownstreamEffect,true);assert(!JSON.stringify(next_state).includes('PII_CANARY'));assert(!('actor_principal_id' in next_state));}
 const counts=(await owner.query("SELECT (SELECT count(*)::int FROM hon.retention_review_acknowledgements) acknowledgements,(SELECT count(*)::int FROM hon.retention_review_acknowledgement_evidence_keys) evidence_keys,(SELECT count(*)::int FROM hon.retention_review_acknowledgement_receipts) receipts,(SELECT count(*)::int FROM hon.retention_review_acknowledgement_outbox WHERE state='INERT') inert_outbox,(SELECT count(*)::int FROM hon.audit_events WHERE action_code='retention.review.acknowledge') audits")).rows[0];assert.equal(new Set([counts.acknowledgements,counts.evidence_keys,counts.inert_outbox,counts.audits]).size,1);assert(counts.receipts>counts.acknowledgements);
 const residual=(await runtime.query("SELECT hon.current_organization_id() org,hon.current_school_id() school")).rows[0];assert.equal(residual.org,null);assert.equal(residual.school,null);check();
 await verifyRetentionAcknowledgementSecurity(owner,'hon_retention_acknowledgement_runtime');
 for(const script of ['verify-rls.mjs','test-retention-review-security.mjs']){
  const run=spawnSync(process.execPath,[new URL('./'+script,import.meta.url).pathname],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:'/home/ubuntu',LANG:'C.UTF-8',DATABASE_URL:process.env.DATABASE_URL,HON_RUNTIME_DATABASE_URL:process.env.HON_RUNTIME_DATABASE_URL}});
  if(run.status!==0)throw new Error('Existing guarded-local security regression failed: '+script+' '+run.stderr.replaceAll(new URL(process.env.DATABASE_URL).password,'[REDACTED]').replaceAll(new URL(process.env.HON_RUNTIME_DATABASE_URL).password,'[REDACTED]'));
  console.log(run.stdout.trim());
 }
 assert.equal(externalCalls,0);passed=true;
 console.log(`Retention acknowledgement integrity passed: ${groups} assertion groups, ${aclProbes} rollback-only ACL/RLS/constraint/function probes, ${operations} whole-table checked operations, ${tables.length} HON tables; evidence ${JSON.stringify(counts)}; zero external calls. Same-key concurrency exactly one acknowledgement/receipt/audit/inert outbox. Two blocked concurrent distinct keys exactly one acknowledgement/evidence key/audit/inert outbox and two receipts; identical acknowledgement responses and write-free deterministic replay.`);
}finally{
 await db.onModuleDestroy();await owner.end();await runtime.end();
 if(passed){teardown();await unlink(process.env.HON_RETENTION_ACKNOWLEDGEMENT_ENV_FILE);console.log('Marked disposable retention database/roles and private credential descriptor removed.');}
 else console.log('Validation failed; marked local fixture retained for diagnosis. No completion claim.');
}
