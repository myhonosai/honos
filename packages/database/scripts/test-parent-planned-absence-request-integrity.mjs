import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyParentPlannedAbsenceRequestSecurity } from './parent-planned-absence-request-security.mjs';
const owner = new URL(process.env.DATABASE_URL ?? ''), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_parent_journey_validation_sandbox' || owner.username !== 'hon_parent_journey_sandbox_owner' || runtime.hostname !== owner.hostname || runtime.port !== owner.port || runtime.pathname !== owner.pathname || runtime.username !== 'hon_parent_journey_sandbox_runtime') throw new Error('Only the exact disposable localhost parent database is permitted.');
if (Object.keys(process.env).some(key => /^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key))) throw new Error('No provider credentials or execution switches permitted.');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { ParentPlannedAbsenceService } = await import('../../../apps/api/dist/families/parent-planned-absence.service.js');
const { ParentPlannedAbsenceRequestService } = await import('../../../apps/api/dist/families/parent-planned-absence-request.service.js');
const { ParentPlannedAbsenceHistoryService } = await import('../../../apps/api/dist/families/parent-planned-absence-history.service.js');
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false }), restricted = new pg.Client({ connectionString: runtime.toString(), ssl: false });
const db = new RuntimeDatabaseService(), canonical = new ParentPlannedAbsenceService(db), requests = new ParentPlannedAbsenceRequestService(db, canonical), history = new ParentPlannedAbsenceHistoryService(db);
const ids = Object.fromEntries(['organization','school','family','otherFamily','guardian','guardianUser','viewer','viewerUser','grant','viewerGrant','child','profile','inactive','inactiveProfile','outsider','outsideProfile'].map(k=>[k,randomUUID()]));
const subject = `absence-request-${randomUUID()}`, viewerSubject = `absence-viewer-${randomUUID()}`;
const input = (overrides={})=>({studentProfileId:ids.profile,startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString(),reason:'PRIVATE_PARENT_REASON',...overrides});
const denied = code=>error=>error.getStatus()===code;
await admin.connect(); await restricted.connect();
try {
 await verifyParentPlannedAbsenceRequestSecurity(admin,runtime.username);
 await admin.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)',[ids.organization,'PRIVATE_ORGANIZATION']);
 await admin.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,$3,$4)',[ids.school,ids.organization,'PRIVATE_SCHOOL',`absence-${ids.school}`]);
 await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4),($5,$6,$7,$8)',[ids.guardianUser,subject,`${ids.guardianUser}@example.test`,'PRIVATE_GUARDIAN',ids.viewerUser,viewerSubject,`${ids.viewerUser}@example.test`,'PRIVATE_VIEWER']);
 await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3),($4,'HUMAN_USER',$5,$6)",[ids.guardian,ids.guardianUser,'PRIVATE_GUARDIAN',ids.viewer,ids.viewerUser,'PRIVATE_VIEWER']);
 await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PRIVATE_FAMILY'),($4,$2,$3,'PRIVATE_OTHER_FAMILY')",[ids.family,ids.organization,ids.school,ids.otherFamily]);
 await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Authorized','Child'),($4,$2,$3,'PRIVATE_INACTIVE','Child'),($5,$2,$3,'PRIVATE_OUTSIDER','Child')",[ids.child,ids.organization,ids.school,ids.inactive,ids.outsider]);
 await admin.query("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT'),($1,$2,$3,$5,'STUDENT'),($1,$2,$6,$7,'STUDENT')",[ids.organization,ids.school,ids.family,ids.child,ids.inactive,ids.otherFamily,ids.outsider]);
 await admin.query("INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id,status) VALUES($1,$2,$3,$4,$5,'ACTIVE'),($6,$2,$3,$7,$5,'SUSPENDED'),($8,$2,$3,$9,$10,'ACTIVE')",[ids.profile,ids.organization,ids.school,ids.child,ids.family,ids.inactiveProfile,ids.inactive,ids.outsideProfile,ids.outsider,ids.otherFamily]);
 await admin.query("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,'PRIMARY_GUARDIAN',now()-interval '1 day',$5),($6,$2,$3,$4,$7,'VIEWER',now()-interval '1 day',$5)",[ids.grant,ids.organization,ids.school,ids.family,ids.guardian,ids.viewerGrant,ids.viewer]);
 const snapshot = async ()=>(await admin.query(`SELECT coalesce(jsonb_object_agg(table_name,n),'{}') counts FROM (SELECT table_name,(xpath('/row/n/text()',query_to_xml(format('SELECT count(*) n FROM hon.%I',table_name),false,true,'')))[1]::text::bigint n FROM information_schema.tables WHERE table_schema='hon' AND table_type='BASE TABLE') rows`)).rows[0].counts;
 const before = await snapshot();
 assert.deepEqual((await requests.context(subject)).data,{children:[{studentProfileId:ids.profile,displayName:'Authorized Child'}]});
 assert.deepEqual(await snapshot(),before,'Context must write no table.');
 for (const who of [viewerSubject,'unknown-subject']) { await assert.rejects(requests.context(who),denied(403)); await assert.rejects(requests.submit(who,input(),randomUUID()),denied(403)); }
 for (const profile of [ids.inactiveProfile,ids.outsideProfile,randomUUID()]) await assert.rejects(requests.submit(subject,input({studentProfileId:profile}),randomUUID()),denied(403));
 for (const changes of [{endsAt:new Date(Date.now()+91*86400000).toISOString()},{startsAt:'2026-02-30T09:00:00Z'},{startsAt:'2026-01-01'},{reason:'a'.repeat(1001)},{familyId:ids.family},{schoolId:ids.school}]) await assert.rejects(requests.submit(subject,input(changes),randomUUID()),denied(400));
 assert.deepEqual(await snapshot(),before,'Denied or invalid requests must write no table.');
 const value=input(),key=randomUUID(), result=await requests.submit(subject,value,key);
 assert.deepEqual(Object.keys(result.data).sort(),['status','submittedAt']);assert.equal(result.data.status,'SUBMITTED');assert(!/PRIVATE_|familyId|schoolId|principalId|studentProfileId|reason|review|provider|payment/.test(JSON.stringify(result.data)));
 const after=await snapshot();for(const [table,count] of Object.entries(before)) assert.equal(after[table]-count,['planned_absence_requests','audit_events','outbox_events','idempotency_records'].includes(table)?1:0,`Unexpected effect on ${table}`);
 const row=(await admin.query('SELECT * FROM hon.planned_absence_requests WHERE organization_id=$1',[ids.organization])).rows[0];assert.equal(row.family_id,ids.family);assert.equal(row.requested_by_principal_id,ids.guardian);assert.equal(row.status,'SUBMITTED');assert.equal(row.reviewed_at,null);assert.equal(row.review_note,null);assert.equal(row.reason,value.reason);
 const audit=(await admin.query('SELECT action_code,source FROM hon.audit_events WHERE organization_id=$1',[ids.organization])).rows[0];assert.deepEqual(audit,{action_code:'parent.planned_absence.request',source:'HUMAN_UI'});
 assert.equal((await admin.query('SELECT event_type FROM hon.outbox_events WHERE organization_id=$1',[ids.organization])).rows[0].event_type,'parent.planned_absence.requested');
 const replay=await requests.submit(subject,value,key);assert.deepEqual(replay.data,result.data);assert.equal(replay.meta.replayed,true);assert.deepEqual(await snapshot(),after);
 await assert.rejects(requests.submit(subject,{...value,reason:'Changed'},key),denied(409));
 assert.equal((await history.get(subject)).data.requests.items[0].status,'SUBMITTED');assert(!/PRIVATE_|reason|reviewNote|studentProfileId/.test(JSON.stringify((await history.get(subject)).data)));
 // Every current scope/child change invalidates retry as well as discovery.
 await admin.query("UPDATE hon.student_profiles SET status='SUSPENDED' WHERE id=$1",[ids.profile]);assert.deepEqual((await requests.context(subject)).data,{children:[]});await assert.rejects(requests.submit(subject,value,key),denied(403));await admin.query("UPDATE hon.student_profiles SET status='ACTIVE' WHERE id=$1",[ids.profile]);
 const extra=randomUUID();await admin.query("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,'VIEWER',now()-interval '2 hours',$5)",[extra,ids.organization,ids.school,ids.family,ids.guardian]);await assert.rejects(requests.context(subject),denied(403));await assert.rejects(requests.submit(subject,value,key),denied(403));await admin.query('DELETE FROM hon.family_access_grants WHERE id=$1',[extra]);
 await admin.query("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,'SECONDARY_GUARDIAN',now()-interval '2 hours',$5)",[extra,ids.organization,ids.school,ids.otherFamily,ids.guardian]);await assert.rejects(requests.context(subject),denied(409));await assert.rejects(requests.submit(subject,value,key),denied(409));await admin.query('DELETE FROM hon.family_access_grants WHERE id=$1',[extra]);
 for(const [table,id,column,val,restore] of [['family_access_grants',ids.grant,'effective_until',new Date(Date.now()-60000),null],['families',ids.family,'status','SUSPENDED','ACTIVE'],['schools',ids.school,'status','SUSPENDED','ACTIVE'],['organizations',ids.organization,'status','SUSPENDED','ACTIVE'],['principals',ids.guardian,'is_active',false,true]]) {
  await admin.query(`UPDATE hon.${table} SET ${column}=$2 WHERE id=$1`,[id,val]);await assert.rejects(requests.context(subject),denied(403));await assert.rejects(requests.submit(subject,value,key),denied(403));await admin.query(`UPDATE hon.${table} SET ${column}=$2 WHERE id=$1`,[id,restore]);
 }
 // Evidence failure is a rollback, never a partial submission.
 await admin.query("CREATE FUNCTION hon.absence_proof_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected proof failure'; END $$; CREATE TRIGGER absence_proof_fail BEFORE INSERT ON hon.outbox_events FOR EACH ROW EXECUTE FUNCTION hon.absence_proof_fail()");
 await assert.rejects(requests.submit(subject,input(),randomUUID()),denied(503));assert.deepEqual(await snapshot(),after);await admin.query('DROP TRIGGER absence_proof_fail ON hon.outbox_events; DROP FUNCTION hon.absence_proof_fail()');
 // Original initial state and exact composite family constraint are still enforced.
 for(const [profile,status] of [[ids.outsideProfile,'SUBMITTED'],[ids.profile,'APPROVED']]) await assert.rejects(admin.query("INSERT INTO hon.planned_absence_requests(organization_id,school_id,family_id,student_profile_id,requested_by_principal_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5,now()+interval '1 day',now()+interval '2 days',$6)",[ids.organization,ids.school,ids.family,profile,ids.guardian,status]),e=>e.code==='23514');
 for (const table of ['users','principals','family_access_grants']) await assert.rejects(restricted.query(`SELECT * FROM hon.${table}`),e=>e.code==='42501');
 await assert.rejects(restricted.query('SELECT hon.require_parent_planned_absence_scope($1)',[subject]),e=>e.code==='42501');
 await assert.rejects(restricted.query('SELECT hon.lock_parent_planned_absence_request($1,$2,$3,$4)',[subject,ids.profile,ids.family,'PRIMARY_GUARDIAN']),e=>e.code==='42501');
 assert.equal((await restricted.query('SELECT hon.read_parent_planned_absence_request_context($1) data',[subject])).rows[0].data.children.length,1);
 // Verifier must reject weakened ACLs and body definitions, then pass restoration.
 await admin.query('BEGIN');try {await admin.query('GRANT EXECUTE ON FUNCTION hon.read_parent_planned_absence_request_context(text) TO PUBLIC');await assert.rejects(verifyParentPlannedAbsenceRequestSecurity(admin,runtime.username));}finally{await admin.query('ROLLBACK');}
 await admin.query('BEGIN');try {await admin.query("CREATE OR REPLACE FUNCTION hon.read_parent_planned_absence_request_context(p_subject text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$ BEGIN RETURN '{}'::jsonb; END $$");await assert.rejects(verifyParentPlannedAbsenceRequestSecurity(admin,runtime.username));}finally{await admin.query('ROLLBACK');}
 await verifyParentPlannedAbsenceRequestSecurity(admin,runtime.username);
 console.log('PASS: local-only parent context/submit uses canonical models, exact live guardian scope and active child revalidation, minimal selectors/redacted SUBMITTED receipt, replay and atomic evidence; invalid/viewer/mixed/ambiguous/revoked/changed scopes fail closed, forced RLS/ACL/body verifier rejects weakening, and all downstream tables remain unchanged.');
} finally {await db.onModuleDestroy();await restricted.end();await admin.end();}
