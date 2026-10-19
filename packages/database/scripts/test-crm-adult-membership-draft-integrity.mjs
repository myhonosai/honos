import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { requireCrmAdultMembershipDraftLocalUrls } from './crm-adult-membership-draft-local-guard.mjs';
import { verifyCrmAdultMembershipDraftSecurity } from './crm-adult-membership-draft-security.mjs';

requireCrmAdultMembershipDraftLocalUrls();
const ownerUrl = new URL(process.env.DATABASE_URL);
const runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL);
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { CrmAdultMembershipDraftService } = await import('../../../apps/api/dist/billing/crm-adult-membership-draft.service.js');
const { LeadRegistrationService } = await import('../../../apps/api/dist/crm/lead-registration.service.js');
const { MembershipService } = await import('../../../apps/api/dist/billing/membership.service.js');
const owner = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const runtime = new pg.Client({ connectionString: runtimeUrl.toString(), ssl: false });
const ids = Object.fromEntries(['org','school','otherOrg','otherSchool','foreignSchool','user','actor','role','grant','pipeline','stage','family'].map(k=>[k,randomUUID()]));
const subject=`crm-adult-draft-${randomUUID()}`;
const context=(patch={})=>({ organizationId:ids.org,schoolId:ids.school,principalId:ids.actor,principalType:'HUMAN_USER',source:'HUMAN_UI',externalSubject:subject,requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),...patch });
const input=(student,patch={})=>({studentProfileId:student,planCode:'STAFF-OPAQUE',confirmation:'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT',...patch});
const prep=(student,patch={})=>service.prepare(context({idempotencyKey:'',...patch}),{studentProfileId:student});
const confirm=(student,patch={})=>service.confirmCurrentDraft(context({idempotencyKey:'',...patch}),{studentProfileId:student});
const status=n=>e=>e?.getStatus?.()===n;
let assertions=0, snapshots=0, externalCalls=0;
const originals=[globalThis.fetch,http.request,https.request];
const reject=()=>{externalCalls++;throw new Error('EXTERNAL_TRANSPORT_BLOCKED');};
globalThis.fetch=reject;http.request=reject;https.request=reject;
await owner.connect(); await runtime.connect();
const db=new RuntimeDatabaseService(); const service=new CrmAdultMembershipDraftService(db); const registrations=new LeadRegistrationService(db);
let tables=[],allTables=[];
async function snapshot() {
  const out={};
  for(const table of tables) out[table]=(await owner.query(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb) data FROM hon.${table} x WHERE organization_id=ANY($1::uuid[])`,[[ids.org,ids.otherOrg]])).rows[0].data;
  snapshots++; return out;
}
async function noWrite(work,predicate) {const before=await snapshot();if(predicate) await assert.rejects(work,predicate);else await work();assert.deepEqual(await snapshot(),before);assertions++;}
async function snapshotAll() {const out={};for(const table of allTables) out[table]=(await owner.query(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb) data FROM hon."${table.replaceAll('"','""')}" x`)).rows[0].data;snapshots++;return out;}
async function noAnyWrite(work,predicate) {const before=await snapshotAll();if(predicate) await assert.rejects(work,predicate);else await work();assert.deepEqual(await snapshotAll(),before);assertions++;}
async function raw(c,p,read=false,commit=false) {
  await runtime.query(read?'BEGIN READ ONLY':'BEGIN');
  try {
    await runtime.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
    await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_request_id',$5,true),set_config('app.hon_source',$6,true),set_config('app.hon_external_subject',$7,true),set_config('app.hon_action_request_id',$8,true),set_config('app.hon_delegated_by_principal_id',$9,true)",[c.organizationId,c.schoolId,c.principalId,c.principalType,c.requestId,c.source,c.externalSubject,c.actionRequestId??'',c.delegatedByPrincipalId??'']);
    const result=read?await runtime.query('SELECT hon.read_crm_adult_membership_preparation($1,$2::uuid) data',[c.externalSubject,p.studentProfileId]):await runtime.query('SELECT hon.draft_crm_adult_membership($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) data',[c.externalSubject,JSON.stringify(p),c.idempotencyKey,c.requestId,c.correlationId]);
    if(commit) await runtime.query('COMMIT');return result;
  } finally {await runtime.query('ROLLBACK');}
}
async function rawConfirmation(c,student) {
  await runtime.query('BEGIN');
  try {
    await runtime.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
    await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_request_id',$5,true),set_config('app.hon_source',$6,true),set_config('app.hon_external_subject',$7,true),set_config('app.hon_action_request_id',$8,true),set_config('app.hon_delegated_by_principal_id',$9,true)",[c.organizationId,c.schoolId,c.principalId,c.principalType,c.requestId,c.source,c.externalSubject,c.actionRequestId??'',c.delegatedByPrincipalId??'']);
    return await runtime.query('SELECT hon.read_crm_adult_membership_draft_confirmation($1,$2::uuid) data',[c.externalSubject,student]);
  } finally {await runtime.query('ROLLBACK');}
}
async function account(person,classification='CANONICAL',currency='USD') {return (await owner.query('INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification) VALUES($1,$2,$3,$4,$5) RETURNING id',[ids.org,ids.school,person,currency,classification])).rows[0].id;}
async function registration(withAccount=true,guardian=false) {
  const person=randomUUID(),lead=randomUUID();
  await owner.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'Ada','Student','private@example.test')",[person,ids.org,ids.school]);
  await owner.query("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')",[lead,ids.org,ids.school,person,ids.pipeline,ids.stage]);
  const r=await registrations.register(context(),lead,guardian?{registrationPath:'GUARDIAN_CHILD',childGivenName:'Kai'+randomUUID().replaceAll('-',''),childFamilyName:'Child'+randomUUID().replaceAll('-',''),childBirthDate:'2015-01-02',confirmation:'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION'}:{registrationPath:'ADULT',birthDate:'1990-01-02',confirmation:'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION'});
  assert.equal(r.result.outcome,'REGISTERED');
  const conversion=(await owner.query('SELECT id FROM hon.crm_lead_registration_conversions WHERE source_lead_id=$1',[lead])).rows[0].id;
  return {person,lead,student:r.result.studentProfileId,conversion,account:withAccount?await account(person):null};
}
try {
  const marker=(await owner.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker,{owner:'hon_crm_adult_membership_draft_owner',marker:'HON disposable CRM adult membership draft validation'});
  await verifyCrmAdultMembershipDraftSecurity(owner,runtimeUrl.username);
  for(const sql of ['SELECT hon.require_crm_adult_membership_actor($1)','SELECT * FROM hon.crm_adult_membership_relation($1::uuid)']) await assert.rejects(runtime.query(sql,[sql.includes('relation')?randomUUID():subject]),e=>e.code==='42501');
  await assert.rejects(runtime.query('SELECT * FROM hon.crm_adult_membership_draft_sources'),e=>e.code==='42501');
  await assert.rejects(runtime.query('SELECT hon.read_crm_adult_membership_preparation($1,$2::uuid)',[subject,randomUUID()]),e=>e.code==='42501');
  await assert.rejects(runtime.query('SELECT hon.read_crm_adult_membership_draft_confirmation($1,$2::uuid)',[subject,randomUUID()]),e=>e.code==='42501');
  await owner.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_ORG','PRIVATE_ORG'),($2,'FOREIGN_ORG','FOREIGN_ORG')",[ids.org,ids.otherOrg]);
  await owner.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_SCHOOL',$3),($4,$2,'OTHER_SCHOOL',$5),($6,$7,'FOREIGN_SCHOOL',$8)",[ids.school,ids.org,`school-${ids.school}`,ids.otherSchool,`school-${ids.otherSchool}`,ids.foreignSchool,ids.otherOrg,`school-${ids.foreignSchool}`]);
  await owner.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'ESSENTIAL',clock_timestamp()-interval '1 day')",[ids.org,ids.otherOrg]);
  await owner.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,'private.staff@example.test','PRIVATE_STAFF')",[ids.user,subject]);
  await owner.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','PRIVATE_STAFF')",[ids.actor,ids.user]);
  await owner.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'FRONT_DESK','Private role')",[ids.role,ids.org]);
  for(const permission of ['crm.lead.read','crm.lead.register','student.profile.manage','people.create','family.create','family.member.manage','billing.membership.create']) await owner.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[ids.role,ids.org,permission]);
  await owner.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')",[ids.grant,ids.org,ids.school,ids.actor,ids.role]);
  await owner.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_PIPELINE')",[ids.pipeline,ids.org,ids.school]);
  await owner.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',1,'WON')",[ids.stage,ids.org,ids.school,ids.pipeline]);
  tables=(await owner.query("SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema='hon' AND column_name='organization_id' ORDER BY table_name")).rows.map(x=>x.table_name);
  allTables=(await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).rows.map(x=>x.tablename);
  const students=[];for(let i=0;i<13;i++) students.push(await registration());
  const missing=await registration(false),child=await registration(true,true);
  await owner.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PRIVATE_FAMILY')",[ids.family,ids.org,ids.school]);
  // Preparation is ID-free and completely read-only across every org-owned table.
  await noWrite(async()=>assert.deepEqual(await prep(students[0].student),{studentDisplayName:'Ada Student',currency:'USD',readiness:'READY_FOR_DRAFT'}));
  for(const id of [missing.student,child.student,randomUUID()]) {await noWrite(()=>prep(id),status(404));await noWrite(()=>confirm(id),status(404));}
  await noWrite(()=>raw(context({schoolId:ids.otherSchool}),input(students[0].student),true),e=>e.code==='42501');
  await owner.query("UPDATE hon.student_profiles SET status='SUSPENDED' WHERE id=$1",[students[1].student]);
  await noWrite(()=>prep(students[1].student),status(404));await noWrite(()=>service.draft(context(),input(students[1].student)),status(404));
  await owner.query("UPDATE hon.student_profiles SET status='ACTIVE' WHERE id=$1",[students[1].student]);
  await account(students[2].person,'ADDITIONAL');await noWrite(()=>prep(students[2].student),status(404));await noWrite(()=>service.draft(context(),input(students[2].student)),status(404));
  await owner.query("UPDATE hon.billing_accounts SET account_classification='ADDITIONAL' WHERE id=$1",[students[3].account]);await noWrite(()=>prep(students[3].student),status(404));
  await owner.query("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'GUARDIAN')",[ids.org,ids.school,ids.family,students[4].person]);await noWrite(()=>prep(students[4].student),status(404));
  for(const student of [missing,child,students[3],students[4]]) await noWrite(()=>service.draft(context(),input(student.student)),status(404));
  const replacementPerson=randomUUID();await owner.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Wrong','Person')",[replacementPerson,ids.org,ids.school]);
  await owner.query('UPDATE hon.student_profiles SET person_id=$1 WHERE id=$2',[replacementPerson,students[11].student]);await noWrite(()=>prep(students[11].student),status(404));await noWrite(()=>service.draft(context(),input(students[11].student)),status(404));
  await owner.query('UPDATE hon.student_profiles SET person_id=$1 WHERE id=$2',[students[11].person,students[11].student]);
  const duplicateLead=randomUUID();await owner.query("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')",[duplicateLead,ids.org,ids.school,students[12].person,ids.pipeline,ids.stage]);
  await owner.query("INSERT INTO hon.crm_lead_registration_conversions(organization_id,school_id,source_lead_id,original_contact_person_id,registration_path,resulting_student_profile_id,actor_principal_id,idempotency_key,fingerprint,response) SELECT organization_id,school_id,$1,original_contact_person_id,registration_path,resulting_student_profile_id,actor_principal_id,$2,fingerprint,response || jsonb_build_object('leadId',$1::uuid) FROM hon.crm_lead_registration_conversions WHERE id=$3",[duplicateLead,randomUUID(),students[12].conversion]);
  await noWrite(()=>prep(students[12].student),status(404));await noWrite(()=>service.draft(context(),input(students[12].student)),status(404));
  const firstContext=context(),firstInput=input(students[0].student,{termStartedAt:'2027-01-01T00:00:00.000Z',termEndsAt:'2028-01-01T00:00:00.000Z'});
  const before=await snapshot();const first=await service.draft(firstContext,firstInput);const after=await snapshot();
  const effects=tables.filter(t=>JSON.stringify(before[t])!==JSON.stringify(after[t]));assert.deepEqual(effects.sort(),['audit_events','crm_adult_membership_draft_sources','idempotency_records','memberships','outbox_events']);assertions++;
  assert.equal(first.replayed,false);assert.equal(first.receipt.state,'DRAFT');assert.doesNotMatch(JSON.stringify(first.receipt),/person|payer|family|conversion|account|payment|invoice|amount|currency/i);
  const row=(await owner.query('SELECT state,plan_code,billing_account_id,participant_person_id,term_started_at,term_ends_at FROM hon.memberships WHERE id=$1',[first.receipt.membershipId])).rows[0];
  assert.equal(row.billing_account_id,students[0].account);assert.equal(row.participant_person_id,students[0].person);assert.equal(row.state,'DRAFT');assert.equal(row.term_started_at.toISOString(),firstInput.termStartedAt);
  let current;await noAnyWrite(async()=>{current=await confirm(students[0].student);assert.deepEqual(current,{state:'RECORDED_DRAFT',receipt:first.receipt});assert.doesNotMatch(JSON.stringify(current),/person|payer|family|conversion|account|payment|invoice|amount|currency|version/i);});
  await noWrite(async()=>assert.deepEqual((await rawConfirmation(context(),students[0].student)).rows[0].data,current));
  const recoveryUser=randomUUID(),recoveryActor=randomUUID(),recoveryGrant=randomUUID(),recoverySubject=`crm-adult-draft-recovery-${randomUUID()}`;
  await owner.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,'recovery.staff@example.test','RECOVERY_STAFF')",[recoveryUser,recoverySubject]);
  await owner.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','RECOVERY_STAFF')",[recoveryActor,recoveryUser]);
  await owner.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '1 day')",[recoveryGrant,ids.org,ids.school,recoveryActor,ids.role,ids.actor]);
  await noAnyWrite(()=>service.confirmCurrentDraft(context({principalId:recoveryActor,externalSubject:recoverySubject,idempotencyKey:''}),{studentProfileId:students[0].student}),status(404));
  await noWrite(async()=>{const replay=await service.draft(firstContext,firstInput);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,first.receipt);});
  await noWrite(()=>service.draft(firstContext,{...firstInput,planCode:'CHANGED'}),status(409));
  await noWrite(()=>service.draft(context(),firstInput),status(404));await noWrite(()=>prep(students[0].student),status(404));
  // Lifetime unique source holds after activation, while same-key creation receipt remains exact historical evidence.
  await owner.query("UPDATE hon.memberships SET state='ACTIVE' WHERE id=$1",[first.receipt.membershipId]);
  await noWrite(async()=>assert.deepEqual((await service.draft(firstContext,firstInput)).receipt,first.receipt));await noWrite(()=>service.draft(context(),firstInput),status(404));
  await noAnyWrite(()=>confirm(students[0].student),status(404));
  for(const [student,sameKey] of [[students[5],true],[students[6],false]]) {
    const c=context();const results=await Promise.allSettled([service.draft(c,input(student.student)),service.draft(sameKey?c:context(),input(student.student))]);
    if(sameKey) {assert(results.every(r=>r.status==='fulfilled'));assert.deepEqual(results[0].value.receipt,results[1].value.receipt);assert.equal(results.filter(r=>r.value.replayed).length,1);} else {assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.getStatus(),404);}
    assert.equal((await owner.query('SELECT count(*)::int count FROM hon.memberships WHERE participant_person_id=$1',[student.person])).rows[0].count,1);assertions++;
  }
  // SQL validates the same closed shape even when the API is bypassed.
  for(const key of ['accountId','billingAccountId','personId','familyId','conversionId','currency','paymentSchedule','amount','autoRenew','invoice','payment','charge','provider','agreement','discount','authorization']) await noWrite(()=>raw(context(),input(students[7].student,{[key]:randomUUID()})),e=>e.code==='22023');
  for(const patch of [{planCode:''},{planCode:'x'.repeat(81)},{planCode:' x '},{termStartedAt:null},{termStartedAt:'2027-02-30T00:00:00.000Z'},{termStartedAt:'infinity'},{termStartedAt:'2027-01-01'},{confirmation:false}]) await noWrite(()=>raw(context(),input(students[7].student,patch)),e=>['22023','22007','22008'].includes(e.code));
  // Independent direct-human and live authority checks apply to preparation, draft and replay.
  for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{source:'AUTOMATION'},{source:'INTEGRATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()},{externalSubject:'other-subject'},{principalId:randomUUID()},{schoolId:ids.otherSchool},{organizationId:ids.otherOrg}]) {await noWrite(()=>raw(context(patch),input(students[7].student)),e=>e.code==='42501');await noWrite(()=>raw(context(patch),input(students[7].student),true),e=>e.code==='42501');await noWrite(()=>rawConfirmation(context(patch),students[0].student),e=>e.code==='42501');}
  async function changed(sql,args,restore) {await owner.query(sql,args);try{await noWrite(()=>prep(students[7].student),status(403));await noWrite(()=>confirm(students[0].student),status(403));await noWrite(()=>service.draft(firstContext,firstInput),status(403));}finally{await owner.query(restore,args);}}
  await changed("UPDATE hon.principals SET is_active=false WHERE id=$1",[ids.actor],"UPDATE hon.principals SET is_active=true WHERE id=$1");
  await changed("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[ids.grant],"UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1");
  await changed("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()-interval '1 minute' WHERE id=$1",[ids.grant],"UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1");
  await changed("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[ids.org],"UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1");
  await changed("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 minute' WHERE organization_id=$1",[ids.org],"UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1");
  await changed("DELETE FROM hon.role_permissions WHERE role_id=$1 AND organization_id=$2 AND permission_code='billing.membership.create'",[ids.role,ids.org],"INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.membership.create')");
  await changed("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_SUPPORT')",[ids.actor],'DELETE FROM hon.hq_operator_grants WHERE principal_id=$1');
  await changed("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'VIEWER',$4)",[ids.org,ids.school,ids.family,ids.actor],'DELETE FROM hon.family_access_grants WHERE organization_id=$1 AND school_id=$2 AND family_id=$3 AND principal_id=$4');
  const second=randomUUID();await changed("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','SECOND')",[second,ids.user],'DELETE FROM hon.principals WHERE id=$1 AND user_id=$2');
  await changed("UPDATE hon.roles SET code='PARENT_MIXED' WHERE id=$1",[ids.role],"UPDATE hon.roles SET code='FRONT_DESK' WHERE id=$1");
  // No account-create permission is required; the existing canonical account alone is reused.
  for(const tier of ['ESSENTIAL','CORE','COMPLETE']) {await owner.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[ids.org,tier]);await noWrite(()=>prep(students[7].student));}
  // Held grant mutation: command sees old authority, waits, then must recheck and deny.
  await owner.query('BEGIN');await owner.query("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[ids.grant]);
  const waiting=service.draft(context(),input(students[7].student));waiting.catch(()=>{});await new Promise(r=>setTimeout(r,150));await owner.query('COMMIT');await assert.rejects(waiting,status(403));assertions++;
  await owner.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[ids.grant]);
  await owner.query('BEGIN');await account(students[10].person,'ADDITIONAL');const accountRaceBefore=await snapshot();
  const accountRace=service.draft(context(),input(students[10].student));accountRace.catch(()=>{});await new Promise(r=>setTimeout(r,150));await owner.query('COMMIT');await assert.rejects(accountRace,status(404));assert.deepEqual(await snapshot(),accountRaceBefore);assertions++;
  // Evidence failures, including final live-authority loss caused inside a fixture trigger, roll back every table.
  for(const [table,event,body] of [['audit_events','INSERT',"RAISE EXCEPTION 'FIXTURE_EVIDENCE_FAILURE';"],['outbox_events','INSERT',"RAISE EXCEPTION 'FIXTURE_EVIDENCE_FAILURE';"],['idempotency_records','UPDATE',"RAISE EXCEPTION 'FIXTURE_EVIDENCE_FAILURE';"],['outbox_events','INSERT',`UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id='${ids.grant}'::uuid;`],['crm_adult_membership_draft_sources','INSERT',"NEW.receipt:='{}'::jsonb;"],['outbox_events','INSERT',"NEW.payload:='{}'::jsonb;"]]) {
    await owner.query(`CREATE FUNCTION hon.fixture_crm_draft_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE TRIGGER fixture_crm_draft_failure BEFORE ${event} ON hon.${table} FOR EACH ROW EXECUTE FUNCTION hon.fixture_crm_draft_failure()`);
    try {await noWrite(()=>service.draft(context(),input(students[8].student)),status(body.includes('UPDATE hon')?403:body.includes('NEW.')?409:503));}finally{await owner.query(`DROP TRIGGER fixture_crm_draft_failure ON hon.${table};DROP FUNCTION hon.fixture_crm_draft_failure()`);}
  }
  // Cross-school/foreign/missing selectors all use the same unavailable result.
  const otherStudent=randomUUID(),otherPerson=randomUUID();await owner.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'FOREIGN','PERSON')",[otherPerson,ids.otherOrg,ids.foreignSchool]);await owner.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)',[otherStudent,ids.otherOrg,ids.foreignSchool,otherPerson]);await noWrite(()=>prep(otherStudent),status(404));
  // Canonical generic membership creation behavior remains unchanged and has no CRM source linkage.
  const generic=new MembershipService(db),genericContext=context();const genericInput={billingAccountId:students[9].account,participantPersonId:students[9].person,planCode:'GENERIC-UNCHANGED'};
  assert.equal((await generic.createDraft(genericContext,genericInput)).membership.state,'DRAFT');await noWrite(async()=>assert.equal((await generic.createDraft(genericContext,genericInput)).replayed,true));
  await noWrite(()=>prep(students[9].student),status(404));await noWrite(()=>confirm(students[9].student),status(404));await noWrite(()=>service.draft(context(),input(students[9].student)),status(404));
  // A source-backed current confirmation rejects post-creation drift and any
  // financial artifact without creating audit/outbox/idempotency side effects.
  const planDrift=await service.draft(context(),input(students[11].student));await noWrite(async()=>assert.equal((await confirm(students[11].student)).state,'RECORDED_DRAFT'));
  await owner.query("UPDATE hon.memberships SET plan_code='POST_CREATION_CHANGE' WHERE id=$1",[planDrift.receipt.membershipId]);await noAnyWrite(()=>confirm(students[11].student),status(404));
  const scheduled=await service.draft(context(),input(students[8].student));await owner.query("INSERT INTO hon.membership_payment_schedules(organization_id,school_id,membership_id,frequency,amount_minor,currency) VALUES($1,$2,$3,'MONTHLY',1,'USD')",[ids.org,ids.school,scheduled.receipt.membershipId]);await noAnyWrite(()=>confirm(students[8].student),status(404));
  const invoiced=await service.draft(context(),input(students[7].student));await owner.query('INSERT INTO hon.invoices(organization_id,school_id,billing_account_id,membership_id,currency,subtotal_minor,discount_minor,total_minor) VALUES($1,$2,$3,$4,$5,0,0,0)',[ids.org,ids.school,students[7].account,invoiced.receipt.membershipId,'USD']);await noAnyWrite(()=>confirm(students[7].student),status(404));
  for(const sql of ["UPDATE hon.crm_adult_membership_draft_sources SET receipt='{}'::jsonb",'DELETE FROM hon.crm_adult_membership_draft_sources','TRUNCATE hon.crm_adult_membership_draft_sources']) await assert.rejects(owner.query(sql),e=>e.code==='42501');
  for(const sql of ['ALTER TABLE hon.crm_adult_membership_draft_sources NO FORCE ROW LEVEL SECURITY',`GRANT SELECT (receipt) ON hon.crm_adult_membership_draft_sources TO ${runtimeUrl.username}`,`GRANT EXECUTE ON FUNCTION hon.crm_adult_membership_relation(uuid) TO ${runtimeUrl.username}`,`GRANT EXECUTE ON FUNCTION hon.read_crm_adult_membership_draft_confirmation(text,uuid) TO ${runtimeUrl.username} WITH GRANT OPTION`,'ALTER TABLE hon.crm_adult_membership_draft_sources DISABLE TRIGGER crm_adult_membership_source_immutable','ALTER FUNCTION hon.draft_crm_adult_membership(text,jsonb,uuid,uuid,uuid) SET search_path=public,hon','ALTER FUNCTION hon.read_crm_adult_membership_draft_confirmation(text,uuid) SET search_path=public,hon',"CREATE FUNCTION hon.read_crm_adult_membership_draft_confirmation(text,text) RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_object()'"]) {await owner.query('BEGIN');try{await owner.query(sql);await assert.rejects(verifyCrmAdultMembershipDraftSecurity(owner,runtimeUrl.username));assertions++;}finally{await owner.query('ROLLBACK');}}
  await verifyCrmAdultMembershipDraftSecurity(owner,runtimeUrl.username);
  const verifier=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  await owner.query(verifier.slice(verifier.indexOf('-- Adult CRM membership draft exact verification,')).replaceAll('hon_runtime',runtimeUrl.username));
  const evidence=(await owner.query(`SELECT (SELECT count(*)::int FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.membership.create' AND source='HUMAN_UI') audits,(SELECT count(*)::int FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.membership.drafted' AND payload->>'executionAllowed'='false') outbox,(SELECT count(*)::int FROM hon.crm_adult_membership_draft_sources WHERE conversion_id=$2 AND membership_id=$1) sources`,[first.receipt.membershipId,students[0].conversion])).rows[0];assert.deepEqual(evidence,{audits:1,outbox:1,sources:1});
  assert.equal(externalCalls,0);
  console.log(`PASS: adult CRM membership draft (${assertions} assertion groups, ${snapshots} organization/all-table no-effect snapshots): verified ADULT REGISTERED relations, historical creation receipt versus creator-owned current DRAFT confirmation, strict current human/school/permission/tier, canonical-only account, unique source, generic-fallback refusal, schedule/invoice/plan/activation drift refusal, identical replay, distinct-key concurrency, immutable provenance, atomic audit/outbox/idempotency, final rechecks, exact ACL/function/overload drift, unchanged generic membership and zero provider/financial/family/automation effects.`);
} finally {await db.onModuleDestroy();await runtime.end();await owner.end();[globalThis.fetch,http.request,https.request]=originals;}
