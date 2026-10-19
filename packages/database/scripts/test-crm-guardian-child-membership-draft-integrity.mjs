import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { requireCrmGuardianChildMembershipDraftLocalUrls } from './crm-guardian-child-membership-draft-local-guard.mjs';
import { crmGuardianChildMembershipDraftFunctions, verifyCrmGuardianChildMembershipDraftSecurity } from './crm-guardian-child-membership-draft-security.mjs';

requireCrmGuardianChildMembershipDraftLocalUrls();
const owner = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
const runtime = new pg.Pool({ connectionString: process.env.HON_RUNTIME_DATABASE_URL, ssl: false, max: 4 });
const runtimeRole = new URL(process.env.HON_RUNTIME_DATABASE_URL).username;
const ids = Object.fromEntries(['org','school','otherOrg','otherSchool','foreignSchool','user','actor','role','grant','pipeline','stage'].map(k => [k,randomUUID()]));
const subject = `crm-guardian-child-${randomUUID()}`;
const context = (patch={}) => ({ organizationId:ids.org, schoolId:ids.school, principalId:ids.actor, principalType:'HUMAN_USER', source:'HUMAN_UI', externalSubject:subject, requestId:randomUUID(), correlationId:randomUUID(), idempotencyKey:randomUUID(), ...patch });
const payerInput = (student,patch={}) => ({ studentProfileId:student, confirmation:'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_PAYER_DESIGNATION', ...patch });
const draftInput = (student,patch={}) => ({ studentProfileId:student, planCode:'STAFF-OPAQUE', confirmation:'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_CRM_MEMBERSHIP_DRAFT', ...patch });
const code = (...codes) => e => codes.includes(e.code);
let groups=0, snapshots=0, externalCalls=0, allTables=[];
const originals=[globalThis.fetch,http.request,https.request];
const reject=()=>{externalCalls++; throw new Error('EXTERNAL_TRANSPORT_BLOCKED');};
globalThis.fetch=reject; http.request=reject; https.request=reject;
async function snapshot() {
  const result={};
  for(const table of allTables) result[table]=(await owner.query(`SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb)::text) data FROM hon."${table.replaceAll('"','""')}" x`)).rows[0].data;
  snapshots++; return result;
}
async function noWrite(work,predicate) {
  const before=await snapshot(); let result;
  if(predicate) await assert.rejects(work,predicate); else result=await work();
  assert.deepEqual(await snapshot(),before); groups++; return result;
}
async function transaction(c,work,commit=true,readOnly=false) {
  const client=await runtime.connect();
  try {
    await client.query(readOnly?'BEGIN READ ONLY':'BEGIN');
    await client.query("SET LOCAL statement_timeout='12s'; SET LOCAL lock_timeout='8s'");
    await client.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_request_id',$5,true),set_config('app.hon_source',$6,true),set_config('app.hon_external_subject',$7,true),set_config('app.hon_action_request_id',$8,true),set_config('app.hon_delegated_by_principal_id',$9,true)",[c.organizationId,c.schoolId,c.principalId,c.principalType,c.requestId,c.source,c.externalSubject,c.actionRequestId??'',c.delegatedByPrincipalId??'']);
    const result=await work(client);
    await client.query(commit?'COMMIT':'ROLLBACK'); return result;
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
const call = (mode,p,c=context()) => transaction(c,async client=>{
  const names={payerPrepare:'read_crm_guardian_child_payer_designation_preparation',draftPrepare:'read_crm_guardian_child_membership_preparation',confirm:'read_crm_guardian_child_membership_draft_confirmation',payer:'designate_crm_guardian_child_payer',draft:'draft_crm_guardian_child_membership'};
  const isWrite=['payer','draft'].includes(mode);
  const sql=isWrite?`SELECT hon.${names[mode]}($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) data`:`SELECT hon.${names[mode]}($1,$2::uuid) data`;
  return (await client.query(sql,isWrite?[c.externalSubject,JSON.stringify(p),c.idempotencyKey,c.requestId,c.correlationId]:[c.externalSubject,p.studentProfileId])).rows[0].data;
});
const prep = (s,c) => call('payerPrepare',payerInput(s),c);
const ready = (s,c) => call('draftPrepare',draftInput(s),c);
const confirm = (s,c) => call('confirm',draftInput(s),c);
const designate = (s,c) => call('payer',payerInput(s),c);
const draft = (s,c) => call('draft',draftInput(s),c);
async function account(person,classification='CANONICAL',currency='USD') {
  return (await owner.query('INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification) VALUES($1,$2,$3,$4,$5) RETURNING id',[ids.org,ids.school,person,currency,classification])).rows[0].id;
}
async function registration(withAccount=true,guardian=true,expectedFailure=null,snapshotted=true) {
  const person=randomUUID(), lead=randomUUID();
  await owner.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Source','Guardian')",[person,ids.org,ids.school]);
  await owner.query("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')",[lead,ids.org,ids.school,person,ids.pipeline,ids.stage]);
  const p=guardian?{registrationPath:'GUARDIAN_CHILD',childGivenName:`Child${randomUUID().replaceAll('-','')}`,childFamilyName:`Student${randomUUID().replaceAll('-','')}`,childBirthDate:'2015-01-02',confirmation:'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION'}:{registrationPath:'ADULT',birthDate:'1990-01-02',confirmation:'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION'};
  const c=context();
  const register=()=>transaction(c,async client=>{
    await client.query('SAVEPOINT registration_source_facts');
    const registered=(await client.query('SELECT hon.register_crm_lead_person($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) data',[subject,lead,JSON.stringify(p),c.idempotencyKey,c.requestId,c.correlationId])).rows[0].data;
    await client.query('RELEASE SAVEPOINT registration_source_facts');
    return registered;
  });
  if(expectedFailure) { await noWrite(register,expectedFailure); return; }
  const before=await snapshot(), registered=await register(), after=await snapshot();
  const expectedChanges=guardian?['audit_events','crm_lead_registration_conversions',...(snapshotted?['crm_guardian_child_registration_source_facts']:[]),'families','family_members','outbox_events','people','student_profiles']:['audit_events','crm_lead_registration_conversions','outbox_events','student_profiles'];
  assert.deepEqual(allTables.filter(t=>before[t]!==after[t]),expectedChanges.sort()); groups++;
  assert.equal(registered.result.outcome,'REGISTERED');
  const conversion=(await owner.query('SELECT id FROM hon.crm_lead_registration_conversions WHERE source_lead_id=$1',[lead])).rows[0].id;
  const student=registered.result.studentProfileId, family=registered.result.familyId;
  const child=(await owner.query('SELECT person_id FROM hon.student_profiles WHERE id=$1',[student])).rows[0].person_id;
  const members=family?(await owner.query('SELECT id,person_id FROM hon.family_members WHERE family_id=$1',[family])).rows:[];
  const facts=(await owner.query(`SELECT x.conversion_id,x.organization_id,x.school_id,x.student_profile_id,x.child_person_id,x.family_id,x.given_name,x.family_name,x.birth_date::text,
    x.created_at=c.created_at AS original_time FROM hon.crm_guardian_child_registration_source_facts x JOIN hon.crm_lead_registration_conversions c ON c.id=x.conversion_id WHERE x.conversion_id=$1`,[conversion])).rows;
  assert.deepEqual(facts,guardian&&snapshotted?[{conversion_id:conversion,organization_id:ids.org,school_id:ids.school,student_profile_id:student,child_person_id:child,family_id:family,given_name:p.childGivenName,family_name:p.childFamilyName,birth_date:p.childBirthDate,original_time:true}]:[]); groups++;
  return {person,lead,conversion,student,family,child,guardianMember:members.find(x=>x.person_id===person)?.id,childMember:members.find(x=>x.person_id===child)?.id,account:withAccount?await account(person):null,label:guardian?`${p.childGivenName} ${p.childFamilyName}`:'Source Guardian'};
}
async function changed(sql,args,restore,works,predicate=code('P0002')) {
  await owner.query(sql,args);
  try { for(const work of works) await noWrite(work,predicate); }
  finally { await owner.query(restore,args); }
}
async function fixtureTrigger(table,event,body,work) {
  await owner.query(`CREATE FUNCTION hon.fixture_guardian_child_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$; CREATE TRIGGER fixture_guardian_child_failure BEFORE ${event} ON hon.${table} FOR EACH ROW EXECUTE FUNCTION hon.fixture_guardian_child_failure()`);
  try { await work(); } finally { await owner.query(`DROP TRIGGER fixture_guardian_child_failure ON hon.${table}; DROP FUNCTION hon.fixture_guardian_child_failure()`); }
}
async function generic(student,c=context(),patch={}) {
  return transaction(c,client=>client.query('INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state) VALUES($1,$2,$3,$4,$5,$6)',[c.organizationId,c.schoolId,patch.account??student.account,patch.person??student.child,'GENERIC-UNCHANGED',patch.state??'DRAFT']));
}
try {
  await owner.connect();
  assert.deepEqual((await owner.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0],{owner:'hon_crm_guardian_child_membership_draft_owner',marker:'HON disposable CRM guardian child membership draft validation'});
  await verifyCrmGuardianChildMembershipDraftSecurity(owner,runtimeRole);
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
  allTables=(await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).rows.map(x=>x.tablename);
  // Owner-only fixture simulation of a conversion installed before 0167. Never
  // synthesize historical facts from mutable people/profile data or backfill it.
  let historical;
  await owner.query('ALTER TABLE hon.crm_lead_registration_conversions DISABLE TRIGGER crm_guardian_child_registration_facts_capture');
  try { historical=await registration(true,true,null,false); }
  finally { await owner.query('ALTER TABLE hon.crm_lead_registration_conversions ENABLE TRIGGER crm_guardian_child_registration_facts_capture'); }
  for(const work of [()=>prep(historical.student),()=>designate(historical.student),()=>ready(historical.student),()=>draft(historical.student),()=>confirm(historical.student)]) await noWrite(work,code('P0002'));
  const students=[]; for(let i=0;i<12;i++) students.push(await registration());
  const missing=await registration(false), adult=await registration(true,false);
  const originalSourceFacts=(await snapshot()).crm_guardian_child_registration_source_facts;
  await noWrite(()=>owner.query(`INSERT INTO hon.crm_guardian_child_registration_source_facts SELECT * FROM hon.crm_guardian_child_registration_source_facts WHERE conversion_id=$1`,[students[0].conversion]),code('23505'));
  await noWrite(()=>owner.query(`INSERT INTO hon.crm_guardian_child_registration_source_facts(conversion_id,organization_id,school_id,student_profile_id,child_person_id,family_id,given_name,family_name,birth_date)
    SELECT $1,$2,$3,student_profile_id,child_person_id,family_id,given_name,family_name,birth_date FROM hon.crm_guardian_child_registration_source_facts WHERE conversion_id=$4`,[historical.conversion,ids.otherOrg,ids.foreignSchool,students[0].conversion]),code('23503'));
  // Pre-designation corrections cannot become the original registration facts,
  // even without a version increment, including either name and birth-date drift.
  const unconsumed=students[11];
  const originalNames=(await owner.query('SELECT given_name,family_name FROM hon.people WHERE id=$1',[unconsumed.child])).rows[0];
  const beforeDesignation=[()=>prep(unconsumed.student),()=>designate(unconsumed.student),()=>ready(unconsumed.student),()=>draft(unconsumed.student),()=>confirm(unconsumed.student)];
  await changed("UPDATE hon.people SET given_name='Corrected' WHERE id=$1 AND given_name=$2",[unconsumed.child,originalNames.given_name],'UPDATE hon.people SET given_name=$2 WHERE id=$1',beforeDesignation);
  await changed("UPDATE hon.people SET family_name='Corrected' WHERE id=$1 AND family_name=$2",[unconsumed.child,originalNames.family_name],'UPDATE hon.people SET family_name=$2 WHERE id=$1',beforeDesignation);
  await changed("UPDATE hon.student_profiles SET birth_date='2015-01-03' WHERE id=$1",[unconsumed.student],"UPDATE hon.student_profiles SET birth_date='2015-01-02' WHERE id=$1",beforeDesignation);
  // The trimmed display label is unchanged; exact identity fields still differ.
  await changed("UPDATE hon.people SET family_name=family_name || ' ' WHERE id=$1 AND family_name=$2",[unconsumed.child,originalNames.family_name],'UPDATE hon.people SET family_name=$2 WHERE id=$1',beforeDesignation);
  await changed('UPDATE hon.student_profiles SET person_id=$2 WHERE id=$1 AND person_id=$3',[unconsumed.student,unconsumed.person,unconsumed.child],'UPDATE hon.student_profiles SET person_id=$3 WHERE id=$1 AND person_id=$2',beforeDesignation);
  const s=students[0], expectedPreparation={studentDisplayName:s.label,guardianDisplayName:'Source Guardian',currency:'USD',readiness:'READY_FOR_PAYER_DESIGNATION'};
  assert.deepEqual(await noWrite(()=>prep(s.student)),expectedPreparation);
  await noWrite(()=>transaction(context(),client=>client.query('SELECT hon.read_crm_guardian_child_payer_designation_preparation($1,$2::uuid)',[subject,s.student]),true,true));
  for(const student of [missing,adult,{student:randomUUID()}]) {
    for(const work of [()=>prep(student.student),()=>ready(student.student),()=>confirm(student.student),()=>designate(student.student),()=>draft(student.student)]) await noWrite(work,code('P0002'));
  }
  await account(missing.person,'ADDITIONAL','EUR');
  for(const work of [()=>prep(missing.student),()=>designate(missing.student),()=>ready(missing.student),()=>draft(missing.student)]) await noWrite(work,code('P0002'));
  await noWrite(()=>generic(s),code('P0002'));
  await noWrite(()=>generic(s,context(),{state:'ACTIVE'}),code('P0002'));
  await noWrite(()=>generic(s,context(),{account:adult.account}),code('P0002'));
  // A canonical account is reused even when one or more additional accounts exist.
  await account(s.person,'ADDITIONAL','EUR'); await noWrite(()=>prep(s.student));
  const payerContext=context(), payerBefore=await snapshot(), payer=await designate(s.student,payerContext), payerAfter=await snapshot();
  assert.deepEqual(allTables.filter(t=>payerBefore[t]!==payerAfter[t]),['audit_events','crm_guardian_child_payer_designations','family_members','idempotency_records','outbox_events']); groups++;
  assert.equal(payer.replayed,false); assert.deepEqual(Object.keys(payer.receipt).sort(),['currency','guardianDisplayName','recordedAt','state','studentDisplayName']);
  assert.equal(payer.receipt.state,'PAYER_DESIGNATED');
  assert.equal((await owner.query('SELECT is_billing_contact FROM hon.family_members WHERE id=$1',[s.guardianMember])).rows[0].is_billing_contact,true);
  const payerReplay=await noWrite(()=>designate(s.student,payerContext)); assert.equal(payerReplay.replayed,true); assert.deepEqual(payerReplay.receipt,payer.receipt);
  await noWrite(()=>call('payer',payerInput(students[1].student),payerContext),code('23505'));
  await noWrite(()=>designate(s.student),code('P0002')); await noWrite(()=>prep(s.student),code('P0002'));
  await account(s.person,'ADDITIONAL','CAD');
  await noWrite(()=>transaction(context(),client=>client.query('SELECT hon.read_crm_guardian_child_membership_preparation($1,$2::uuid)',[subject,s.student]),true,true));
  assert.deepEqual(await noWrite(()=>ready(s.student)),{...expectedPreparation,readiness:'READY_FOR_DRAFT'});
  const draftContext=context(), input=draftInput(s.student,{termStartedAt:'2027-01-01T00:00:00.000Z',termEndsAt:'2028-01-01T00:00:00.000Z'});
  const before=await snapshot(), first=await call('draft',input,draftContext), after=await snapshot();
  assert.deepEqual(allTables.filter(t=>before[t]!==after[t]),['audit_events','crm_guardian_child_membership_draft_sources','idempotency_records','memberships','outbox_events']); groups++;
  assert.equal(first.replayed,false); assert.equal(first.receipt.state,'DRAFT');
  assert.deepEqual(Object.keys(first.receipt).sort(),['membershipId','planCode','recordedAt','state','termEndsAt','termStartedAt']);
  assert.doesNotMatch(JSON.stringify(first.receipt),/person|payer|family|conversion|account|currency|price|payment|invoice/i);
  const membership=(await owner.query('SELECT billing_account_id,participant_person_id,state,version FROM hon.memberships WHERE id=$1',[first.receipt.membershipId])).rows[0];
  assert.deepEqual(membership,{billing_account_id:s.account,participant_person_id:s.child,state:'DRAFT',version:1});
  assert.deepEqual(await noWrite(()=>confirm(s.student)),{state:'RECORDED_DRAFT',receipt:first.receipt});
  const exactReplay=await noWrite(()=>call('draft',input,draftContext)); assert.equal(exactReplay.replayed,true); assert.deepEqual(exactReplay.receipt,first.receipt);
  await noWrite(()=>call('draft',{...input,planCode:'CHANGED'},draftContext),code('23505'));
  await noWrite(()=>draft(s.student),code('P0002')); await noWrite(()=>ready(s.student),code('P0002'));
  await noWrite(()=>generic(s),code('P0002'));
  // Designation ownership and DRAFT-confirmation ownership are independent.
  const secondUser=randomUUID(), secondActor=randomUUID(), secondSubject=`second-${randomUUID()}`;
  await owner.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,'second@example.test','SECOND')",[secondUser,secondSubject]);
  await owner.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','SECOND')",[secondActor,secondUser]);
  await owner.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')",[ids.org,ids.school,secondActor,ids.role,ids.actor]);
  const otherActor=context({principalId:secondActor,externalSubject:secondSubject,idempotencyKey:payerContext.idempotencyKey});
  await noWrite(()=>designate(s.student,otherActor),code('P0002'));
  await noWrite(()=>confirm(s.student,otherActor),code('P0002'));
  await noWrite(()=>call('draft',input,{...otherActor,idempotencyKey:draftContext.idempotencyKey}),code('P0002'));
  await designate(students[1].student);
  const secondDraft=await draft(students[1].student,otherActor);
  await noWrite(()=>confirm(students[1].student),code('P0002'));
  assert.deepEqual(await noWrite(()=>confirm(students[1].student,otherActor)),{state:'RECORDED_DRAFT',receipt:secondDraft.receipt});
  const actorRaceStudent=students[8], actorRaceKey=randomUUID();
  const actorRace=await Promise.allSettled([designate(actorRaceStudent.student,context({idempotencyKey:actorRaceKey})),designate(actorRaceStudent.student,{...otherActor,idempotencyKey:actorRaceKey})]);
  assert.equal(actorRace.filter(r=>r.status==='fulfilled').length,1); assert.equal(actorRace.find(r=>r.status==='rejected').reason.code,'P0002');
  const membershipActorRace=await Promise.allSettled([draft(actorRaceStudent.student),draft(actorRaceStudent.student,{...otherActor,idempotencyKey:randomUUID()})]);
  assert.equal(membershipActorRace.filter(r=>r.status==='fulfilled').length,1); assert.equal(membershipActorRace.find(r=>r.status==='rejected').reason.code,'P0002');
  assert.deepEqual((await owner.query('SELECT (SELECT count(*)::int FROM hon.crm_guardian_child_payer_designations WHERE conversion_id=$1) designations,(SELECT count(*)::int FROM hon.crm_guardian_child_membership_draft_sources WHERE conversion_id=$1) sources,(SELECT count(*)::int FROM hon.memberships WHERE participant_person_id=$2) memberships',[actorRaceStudent.conversion,actorRaceStudent.child])).rows[0],{designations:1,sources:1,memberships:1}); groups++;
  // Identical-key and distinct-key races leave exactly one designation/source/member.
  for(const [student,sameKey] of [[students[2],true],[students[3],false]]) {
    const c=context(), results=await Promise.allSettled([designate(student.student,c),designate(student.student,sameKey?c:context())]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,sameKey?2:1);
    if(sameKey) { assert.equal(results.filter(r=>r.value.replayed).length,1); assert.deepEqual(results[0].value.receipt,results[1].value.receipt); }
    else assert.equal(results.find(r=>r.status==='rejected').reason.code,'P0002');
    const dc=context(), drafts=await Promise.allSettled([draft(student.student,dc),draft(student.student,sameKey?dc:context())]);
    assert.equal(drafts.filter(r=>r.status==='fulfilled').length,sameKey?2:1);
    if(sameKey) { assert.equal(drafts.filter(r=>r.value.replayed).length,1); assert.deepEqual(drafts[0].value.receipt,drafts[1].value.receipt); }
    else assert.equal(drafts.find(r=>r.status==='rejected').reason.code,'P0002');
    assert.equal((await owner.query('SELECT count(*)::int count FROM hon.memberships WHERE participant_person_id=$1',[student.child])).rows[0].count,1); groups++;
  }
  // Independently closed database inputs, exact confirmation, canonical UTC-ms terms.
  for(const field of ['guardianId','personId','familyId','conversionId','accountId','billingAccountId','currency','provider','authority','amount','paymentSchedule','agreement','price','activation']) {
    await noWrite(()=>call('payer',payerInput(students[4].student,{[field]:randomUUID()})),code('22023'));
    await noWrite(()=>call('draft',draftInput(students[4].student,{[field]:randomUUID()})),code('22023'));
  }
  for(const patch of [{confirmation:false},{studentProfileId:null},{studentProfileId:'invalid'}]) await noWrite(()=>call('payer',payerInput(students[4].student,patch)),code('22023'));
  for(const patch of [{planCode:''},{planCode:'x'.repeat(81)},{planCode:' x '},{planCode:'<x>'},{confirmation:false},{termStartedAt:null},{termStartedAt:'2027-02-30T00:00:00.000Z'},{termStartedAt:'2027-01-01'},{termStartedAt:'2027-01-01T00:00:00.000+00:00'},{termStartedAt:'infinity'},{termStartedAt:'2027-01-01T00:00:00.000Z',termEndsAt:'2026-01-01T00:00:00.000Z'}]) await noWrite(()=>call('draft',draftInput(students[4].student,patch)),code('22023','22007','22008'));
  // All five public boundaries independently reject nonhuman/mixed/foreign contexts.
  for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{source:'AUTOMATION'},{source:'INTEGRATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()},{externalSubject:'wrong-subject'},{principalId:randomUUID()},{schoolId:ids.otherSchool},{schoolId:ids.foreignSchool,organizationId:ids.otherOrg},{organizationId:ids.otherOrg}]) {
    const c=context(patch);
    for(const work of [()=>prep(students[4].student,c),()=>designate(students[4].student,c),()=>ready(s.student,c),()=>draft(students[4].student,c),()=>confirm(s.student,c)]) await noWrite(work,code('42501'));
  }
  const authorityWorks=[()=>prep(students[4].student),()=>designate(s.student,payerContext),()=>ready(students[5].student),()=>call('draft',input,draftContext),()=>confirm(s.student)];
  for(const [sql,args,restore] of [
    ["UPDATE hon.principals SET is_active=false WHERE id=$1",[ids.actor],"UPDATE hon.principals SET is_active=true WHERE id=$1"],
    ["UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[ids.grant],"UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1"],
    ["UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()-interval '1 minute' WHERE id=$1",[ids.grant],"UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1"],
    ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[ids.org],"UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1"],
    ["UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 minute' WHERE organization_id=$1",[ids.org],"UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1"],
    ["UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1",[ids.org],"UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1"],
    ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1",[ids.school],"UPDATE hon.schools SET status='ACTIVE' WHERE id=$1"],
    ["UPDATE hon.roles SET code='PARENT_MIXED' WHERE id=$1",[ids.role],"UPDATE hon.roles SET code='FRONT_DESK' WHERE id=$1"],
    ["INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_SUPPORT')",[ids.actor],"DELETE FROM hon.hq_operator_grants WHERE principal_id=$1"],
    ["INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'VIEWER',$4)",[ids.org,ids.school,s.family,ids.actor],"DELETE FROM hon.family_access_grants WHERE organization_id=$1 AND school_id=$2 AND family_id=$3 AND principal_id=$4"],
  ]) await changed(sql,args,restore,authorityWorks,code('42501'));
  for(const permission of ['billing.membership.create','family.member.manage']) await changed('DELETE FROM hon.role_permissions WHERE role_id=$1 AND organization_id=$2 AND permission_code=$3',[ids.role,ids.org,permission],'INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',authorityWorks,code('42501'));
  const mixed=randomUUID(); await changed("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','MIXED')",[mixed,ids.user],'DELETE FROM hon.principals WHERE id=$1 AND user_id=$2',authorityWorks,code('42501'));
  for(const tier of ['ESSENTIAL','CORE','COMPLETE']) { await owner.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[ids.org,tier]); await noWrite(()=>prep(students[4].student)); await noWrite(()=>confirm(s.student)); }
  // Current exact graph/versions/projection/frozen account, never replacement selection.
  const driftWorks=[()=>designate(s.student,payerContext),()=>ready(s.student),()=>call('draft',input,draftContext),()=>confirm(s.student)];
  for(const [sql,args,restore] of [
    ["UPDATE hon.student_profiles SET status='SUSPENDED' WHERE id=$1",[s.student],"UPDATE hon.student_profiles SET status='ACTIVE' WHERE id=$1"],
    ['UPDATE hon.student_profiles SET primary_family_id=NULL WHERE id=$1',[s.student],'UPDATE hon.student_profiles SET primary_family_id=$2 WHERE id=$1'],
    ['UPDATE hon.student_profiles SET version=version+1 WHERE id=$1',[s.student],'UPDATE hon.student_profiles SET version=version-1 WHERE id=$1'],
    ["UPDATE hon.families SET status='SUSPENDED' WHERE id=$1",[s.family],"UPDATE hon.families SET status='ACTIVE' WHERE id=$1"],
    ['UPDATE hon.families SET version=version+1 WHERE id=$1',[s.family],'UPDATE hon.families SET version=version-1 WHERE id=$1'],
    ["UPDATE hon.family_members SET member_role='OTHER' WHERE id=$1",[s.guardianMember],"UPDATE hon.family_members SET member_role='GUARDIAN' WHERE id=$1"],
    ["UPDATE hon.family_members SET member_role='OTHER' WHERE id=$1",[s.childMember],"UPDATE hon.family_members SET member_role='STUDENT' WHERE id=$1"],
    ['UPDATE hon.family_members SET is_billing_contact=false WHERE id=$1',[s.guardianMember],'UPDATE hon.family_members SET is_billing_contact=true WHERE id=$1'],
    ['UPDATE hon.family_members SET is_billing_contact=true WHERE id=$1',[s.childMember],'UPDATE hon.family_members SET is_billing_contact=false WHERE id=$1'],
    ["UPDATE hon.billing_accounts SET account_classification='ADDITIONAL' WHERE id=$1",[s.account],"UPDATE hon.billing_accounts SET account_classification='CANONICAL' WHERE id=$1"],
    ["UPDATE hon.billing_accounts SET currency='EUR' WHERE id=$1",[s.account],"UPDATE hon.billing_accounts SET currency='USD' WHERE id=$1"],
    ['UPDATE hon.billing_accounts SET version=version+1 WHERE id=$1',[s.account],'UPDATE hon.billing_accounts SET version=version-1 WHERE id=$1'],
    ["UPDATE hon.people SET given_name='Changed' WHERE id=$1",[s.person],"UPDATE hon.people SET given_name='Source' WHERE id=$1"],
    ['UPDATE hon.people SET version=version+1 WHERE id=$1',[s.child],'UPDATE hon.people SET version=version-1 WHERE id=$1'],
  ]) {
    if(args.length===1 && sql.includes('primary_family_id=NULL')) {await owner.query(sql,args); try {for(const work of driftWorks) await noWrite(work,code('P0002'));} finally {await owner.query(restore,[s.student,s.family]);}}
    else await changed(sql,args,restore,driftWorks);
  }
  const competing=randomUUID(); await owner.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Other','Guardian')",[competing,ids.org,ids.school]);
  await changed("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES($1,$2,$3,$4,'GUARDIAN',true)",[ids.org,ids.school,s.family,competing],'DELETE FROM hon.family_members WHERE organization_id=$1 AND school_id=$2 AND family_id=$3 AND person_id=$4',driftWorks);
  // Lifetime source uniqueness survives activation; a historical replay is not confirmation.
  await changed("UPDATE hon.memberships SET state='ACTIVE' WHERE id=$1",[first.receipt.membershipId],"UPDATE hon.memberships SET state='DRAFT' WHERE id=$1",[()=>confirm(s.student)]);
  for(const [sql,restore] of [["UPDATE hon.memberships SET plan_code='DRIFT' WHERE id=$1","UPDATE hon.memberships SET plan_code='STAFF-OPAQUE' WHERE id=$1"],['UPDATE hon.memberships SET version=2 WHERE id=$1','UPDATE hon.memberships SET version=1 WHERE id=$1']]) await changed(sql,[first.receipt.membershipId],restore,[()=>confirm(s.student)]);
  await changed("INSERT INTO hon.membership_payment_schedules(organization_id,school_id,membership_id,frequency,amount_minor,currency) VALUES($1,$2,$3,'MONTHLY',1,'USD')",[ids.org,ids.school,first.receipt.membershipId],'DELETE FROM hon.membership_payment_schedules WHERE organization_id=$1 AND school_id=$2 AND membership_id=$3',[()=>confirm(s.student)]);
  await changed("INSERT INTO hon.invoices(organization_id,school_id,membership_id,billing_account_id,currency,subtotal_minor,discount_minor,total_minor) VALUES($1,$2,$3,$4,'USD',0,0,0)",[ids.org,ids.school,first.receipt.membershipId,s.account],'DELETE FROM hon.invoices WHERE organization_id=$1 AND school_id=$2 AND membership_id=$3 AND billing_account_id=$4',[()=>confirm(s.student)]);
  // Held mutations prove post-lock revocation and competing projection rechecks.
  await owner.query('BEGIN'); await owner.query("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[ids.grant]);
  const waiting=designate(students[4].student); waiting.catch(()=>{}); await new Promise(r=>setTimeout(r,100)); await owner.query('COMMIT'); await assert.rejects(waiting,code('42501')); groups++;
  await owner.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[ids.grant]);
  await designate(students[5].student);
  await owner.query('BEGIN'); await owner.query('UPDATE hon.family_members SET is_billing_contact=false WHERE id=$1',[students[5].guardianMember]);
  const graphRace=draft(students[5].student); graphRace.catch(()=>{}); await new Promise(r=>setTimeout(r,100)); await owner.query('COMMIT'); await assert.rejects(graphRace,code('P0002')); groups++;
  await owner.query('UPDATE hon.family_members SET is_billing_contact=true WHERE id=$1',[students[5].guardianMember]);
  await owner.query('BEGIN'); await account(students[5].person,'ADDITIONAL','EUR'); const extraRace=draft(students[5].student); extraRace.catch(()=>{}); await new Promise(r=>setTimeout(r,100)); await owner.query('COMMIT'); assert.equal((await extraRace).receipt.state,'DRAFT'); groups++;
  // Failures/corruptions of every evidence stage and final authority roll back all tables.
  const failureCases=[['audit_events','INSERT',"RAISE EXCEPTION 'FIXTURE_EVIDENCE_FAILURE';",'P0001'],['outbox_events','INSERT',"RAISE EXCEPTION 'FIXTURE_EVIDENCE_FAILURE';",'P0001'],['idempotency_records','UPDATE',"RAISE EXCEPTION 'FIXTURE_EVIDENCE_FAILURE';",'P0001'],['outbox_events','INSERT',"NEW.payload:='{}'::jsonb;",'40001'],['outbox_events','INSERT',`UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id='${ids.grant}'::uuid;`,'42501']];
  for(const [table,event,body,errorCode] of failureCases) await fixtureTrigger(table,event,body,()=>noWrite(()=>designate(students[6].student),code(errorCode)));
  await fixtureTrigger('crm_guardian_child_payer_designations','INSERT',"NEW.request_fingerprint:=repeat('0',64);",()=>noWrite(()=>designate(students[6].student),code('40001')));
  await designate(students[6].student);
  for(const [table,event,body,errorCode] of failureCases) await fixtureTrigger(table,event,body,()=>noWrite(()=>draft(students[6].student),code(errorCode)));
  await fixtureTrigger('crm_guardian_child_membership_draft_sources','INSERT',"NEW.receipt:='{}'::jsonb;",()=>noWrite(()=>draft(students[6].student),code('P0002')));
  // Malformed/duplicate immutable conversion evidence is unavailable, not a directory.
  await fixtureTrigger('crm_lead_registration_conversions','INSERT',"NEW.response:=NEW.response || jsonb_build_object('sourceContactPersonId',gen_random_uuid());",async()=>{
    await registration(true,true,code('P0002'));
  });
  await fixtureTrigger('crm_guardian_child_registration_source_facts','INSERT',"RAISE EXCEPTION 'FIXTURE_SOURCE_FACT_FAILURE';",()=>registration(true,true,code('P0001')));
  await fixtureTrigger('crm_lead_registration_conversions','INSERT',`UPDATE hon.family_members SET member_role='OTHER' WHERE family_id=NEW.family_id AND member_role='STUDENT';`,()=>registration(true,true,code('P0002')));
  await fixtureTrigger('crm_lead_registration_conversions','INSERT',`UPDATE hon.student_profiles SET primary_family_id=NULL WHERE id=NEW.resulting_student_profile_id;`,()=>registration(true,true,code('P0002')));
  const duplicate=students[7], duplicateLead=randomUUID();
  await owner.query("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')",[duplicateLead,ids.org,ids.school,duplicate.person,ids.pipeline,ids.stage]);
  const duplicateInsert=()=>owner.query("INSERT INTO hon.crm_lead_registration_conversions(organization_id,school_id,source_lead_id,original_contact_person_id,registration_path,resulting_student_profile_id,family_id,actor_principal_id,idempotency_key,fingerprint,response,created_at) SELECT organization_id,school_id,$1,original_contact_person_id,registration_path,resulting_student_profile_id,family_id,actor_principal_id,$2,fingerprint,response || jsonb_build_object('leadId',$1::uuid),created_at FROM hon.crm_lead_registration_conversions WHERE id=$3",[duplicateLead,randomUUID(),duplicate.conversion]);
  // A post-0167 insertion cannot snapshot an already committed mutable graph.
  await noWrite(duplicateInsert,code('P0002'));
  await owner.query('ALTER TABLE hon.crm_lead_registration_conversions DISABLE TRIGGER crm_guardian_child_registration_facts_capture');
  try { await duplicateInsert(); }
  finally { await owner.query('ALTER TABLE hon.crm_lead_registration_conversions ENABLE TRIGGER crm_guardian_child_registration_facts_capture'); }
  await noWrite(()=>prep(duplicate.student),code('P0002')); await noWrite(()=>designate(duplicate.student),code('P0002'));
  // Non-CRM and adult generic participants retain their existing canonical behavior.
  await generic(adult); groups++;
  const ordinaryPerson=randomUUID(); await owner.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Ordinary','Participant')",[ordinaryPerson,ids.org,ids.school]);
  const ordinary={child:ordinaryPerson,account:await account(ordinaryPerson)}; await generic(ordinary); groups++;
  // Foreign selector has no distinguishable facts under the authorized local scope.
  const foreignPerson=randomUUID(), foreignStudent=randomUUID();
  await owner.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Foreign','Person')",[foreignPerson,ids.otherOrg,ids.foreignSchool]);
  await owner.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)',[foreignStudent,ids.otherOrg,ids.foreignSchool,foreignPerson]);
  for(const work of [()=>prep(foreignStudent),()=>designate(foreignStudent),()=>ready(foreignStudent),()=>draft(foreignStudent),()=>confirm(foreignStudent)]) await noWrite(work,code('P0002'));
  // Direct private ACL and forced deny-all RLS, immutable source and overload/hash drift.
  for(const table of ['crm_guardian_child_registration_source_facts','crm_guardian_child_payer_designations','crm_guardian_child_membership_draft_sources']) {
    const update=table==='crm_guardian_child_registration_source_facts'?"given_name='Forged'":"receipt='{}'::jsonb";
    for(const sql of [`SELECT * FROM hon.${table}`,`INSERT INTO hon.${table}(conversion_id) VALUES('${randomUUID()}')`,`UPDATE hon.${table} SET ${update}`,`DELETE FROM hon.${table}`,`TRUNCATE hon.${table} CASCADE`]) await noWrite(()=>transaction(context(),client=>client.query(sql)),code('42501'));
    for(const sql of [`UPDATE hon.${table} SET ${update}`,`DELETE FROM hon.${table}`,`TRUNCATE hon.${table} CASCADE`]) await noWrite(()=>owner.query(sql),code('42501'));
    // Temporarily granting SELECT cannot defeat FORCE-RLS with zero policies.
    await owner.query('BEGIN'); try { await owner.query(`GRANT SELECT ON hon.${table} TO ${runtimeRole}`); await owner.query(`SET LOCAL ROLE ${runtimeRole}`); assert.equal((await owner.query(`SELECT count(*)::int count FROM hon.${table}`)).rows[0].count,0); } finally { await owner.query('ROLLBACK'); } groups++;
  }
  for(const [signature,,allowed] of crmGuardianChildMembershipDraftFunctions) if(!allowed && !signature.endsWith('()')) {
    const sql=signature.includes('actor')?'SELECT hon.require_crm_guardian_child_membership_actor($1)':'SELECT hon.'+signature.slice(4).replace('(uuid)','($1::uuid)');
    await noWrite(()=>runtime.query(sql,[signature.includes('actor')?subject:s.student]),code('42501'));
  }
  await noWrite(()=>runtime.query('SELECT hon.read_crm_guardian_child_payer_designation_preparation($1,$2::uuid)',[subject,s.student]),code('42501'));
  const verifier=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const canonicalVerification=verifier.slice(verifier.indexOf('-- Guardian-child CRM exact verification:')).replaceAll('hon_runtime',runtimeRole);
  for(const sql of [
    'ALTER TABLE hon.crm_guardian_child_registration_source_facts NO FORCE ROW LEVEL SECURITY',
    `GRANT SELECT (given_name) ON hon.crm_guardian_child_registration_source_facts TO ${runtimeRole}`,
    'GRANT SELECT ON hon.crm_guardian_child_registration_source_facts TO PUBLIC',
    `GRANT EXECUTE ON FUNCTION hon.capture_crm_guardian_child_registration_source_facts() TO ${runtimeRole}`,
    'ALTER TABLE hon.crm_lead_registration_conversions DISABLE TRIGGER crm_guardian_child_registration_facts_capture',
    'ALTER TABLE hon.crm_guardian_child_registration_source_facts DISABLE TRIGGER crm_guardian_child_registration_facts_immutable',
    'ALTER TABLE hon.crm_guardian_child_registration_source_facts DISABLE TRIGGER crm_guardian_child_registration_facts_no_truncate',
    'ALTER TABLE hon.crm_guardian_child_registration_source_facts DROP CONSTRAINT crm_guardian_child_registration_source_facts_pkey',
    'ALTER TABLE hon.crm_guardian_child_registration_source_facts ADD COLUMN unexpected text',
    'ALTER FUNCTION hon.capture_crm_guardian_child_registration_source_facts() SET search_path=public,hon',
    'ALTER TABLE hon.crm_guardian_child_payer_designations NO FORCE ROW LEVEL SECURITY',
    `GRANT SELECT (receipt) ON hon.crm_guardian_child_payer_designations TO ${runtimeRole}`,
    `GRANT EXECUTE ON FUNCTION hon.crm_guardian_child_designated_relation(uuid) TO ${runtimeRole}`,
    'GRANT EXECUTE ON FUNCTION hon.crm_guardian_child_designated_relation(uuid) TO PUBLIC',
    'GRANT SELECT (receipt) ON hon.crm_guardian_child_payer_designations TO service_role',
    'CREATE POLICY fixture_public_policy ON hon.crm_guardian_child_payer_designations USING (true)',
    `GRANT EXECUTE ON FUNCTION hon.read_crm_guardian_child_membership_draft_confirmation(text,uuid) TO ${runtimeRole} WITH GRANT OPTION`,
    'ALTER TABLE hon.memberships DISABLE TRIGGER crm_guardian_child_membership_source_required',
    'ALTER TABLE hon.crm_guardian_child_membership_draft_sources DISABLE TRIGGER crm_guardian_child_membership_source_immutable',
    'ALTER TABLE hon.crm_guardian_child_membership_draft_sources DROP CONSTRAINT crm_guardian_child_draft_membership_fk',
    'ALTER TABLE hon.crm_guardian_child_membership_draft_sources ADD COLUMN unexpected text',
    'ALTER FUNCTION hon.designate_crm_guardian_child_payer(text,jsonb,uuid,uuid,uuid) SET search_path=public,hon',
    'ALTER FUNCTION hon.designate_crm_guardian_child_payer(text,jsonb,uuid,uuid,uuid) STRICT',
    "CREATE OR REPLACE FUNCTION hon.crm_guardian_child_designated_relation(selected_student uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$ BEGIN RETURN '{}'::jsonb; END $$",
    "CREATE FUNCTION hon.read_crm_guardian_child_membership_draft_confirmation(text,text) RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_object()'",
  ]) {
    await owner.query('BEGIN');
    try {
      await owner.query(sql); await owner.query('SAVEPOINT exact_source_check');
      await assert.rejects(verifyCrmGuardianChildMembershipDraftSecurity(owner,runtimeRole));
      await owner.query('ROLLBACK TO SAVEPOINT exact_source_check');
      await assert.rejects(owner.query(canonicalVerification),code('P0001')); groups++;
    } finally { await owner.query('ROLLBACK'); }
  }
  await verifyCrmGuardianChildMembershipDraftSecurity(owner,runtimeRole);
  const source=(await owner.query('SELECT id FROM hon.crm_guardian_child_payer_designations WHERE conversion_id=$1',[s.conversion])).rows[0];
  assert.deepEqual((await owner.query(`SELECT (SELECT count(*)::int FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.guardian_payer.designate') payer_audits,
    (SELECT count(*)::int FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.guardian_payer.designated' AND schema_version=1 AND payload->>'executionAllowed'='false') payer_outbox,
    (SELECT count(*)::int FROM hon.audit_events WHERE entity_id=$2 AND action_code='billing.membership.create') draft_audits,
    (SELECT count(*)::int FROM hon.outbox_events WHERE aggregate_id=$2 AND event_type='billing.membership.drafted' AND schema_version=1 AND payload->>'executionAllowed'='false') draft_outbox`,[source.id,first.receipt.membershipId])).rows[0],{payer_audits:1,payer_outbox:1,draft_audits:1,draft_outbox:1});
  // Even a repeated full canonical verifier block parses and remains read-only.
  await noWrite(()=>owner.query(canonicalVerification));
  await noWrite(()=>owner.query(verifier.replaceAll('hon_runtime',runtimeRole)));
  assert.equal((await snapshot()).crm_guardian_child_registration_source_facts,originalSourceFacts,'registration source facts stay unchanged for the entire lifecycle'); groups++;
  assert.equal(externalCalls,0);
  console.log(`PASS: guardian-child CRM payer designation + source-bound membership DRAFT (${groups} assertion groups, ${snapshots} all-table snapshots, ${allTables.length} tables): fresh atomic original registration facts; no historical backfill; exact pre-designation name/person/birth-date drift denial with zero effects; lifetime immutable source facts; closed direct-human inputs/subject/scope/current dual permission and entitlement; original guardian and distinct active child/family; frozen canonical reuse with additional accounts; no-account and ambiguous/drift rejection; exact actor/key replay and races; private immutable provenance; generic child insert rejection without weakening other participants; creator-owned write-free current confirmation; no schedule/invoice/provider/AI/automation/activation; exact SHA-256/signature/overload/ACL/FORCE-RLS/table/constraint/trigger drift rejection; full canonical 011 succeeds.`);
} finally { await runtime.end(); await owner.end(); [globalThis.fetch,http.request,https.request]=originals; }
