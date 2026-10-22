import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { membershipFixtureQuery } from './membership-activation-test-support.mjs';

/** Runs only inside the marked localhost-only, rejecting-transport owner proof. */
export async function proveOwnerLaunchMembershipDraft({owner,service,accounts,memberships,scope,other,context,checked,raw,drift,ids,ownerRoleId,program,classSession}) {
 let groups=0; const check=()=>groups++; const status=n=>error=>error?.getStatus?.()===n;
 const effects=['billing_accounts','memberships','audit_events','outbox_events','idempotency_records'];
 const registrationEffects=['people','student_profiles','student_curriculum_enrollments','student_registration_receipts','student_registration_outbox','audit_events'];
 const guardianEffects=['people','families','family_members','student_profiles','student_curriculum_enrollments','guardian_child_registration_receipts','guardian_child_registration_outbox','audit_events'];
 const target={programId:program.id,expectedProgramVersion:program.version,classSessionId:classSession.id,expectedClassSessionVersion:classSession.version};
 const adult=()=>checked(()=>service.register(context(),{...target,givenName:'Membership adult '+randomUUID(),familyName:'PII_CANARY_DRAFT',birthDate:'1990-02-03',attestation:'NEW_ADULT_NO_GUARDIAN_REQUIRED'}),registrationEffects);
 const child=()=>checked(()=>service.registerGuardianChild(context(),{...target,guardianGivenName:'Membership guardian '+randomUUID(),guardianFamilyName:'PII_CANARY_GUARDIAN_'+randomUUID(),guardianBirthDate:'1980-02-03',childGivenName:'Membership child '+randomUUID(),childFamilyName:'PII_CANARY_CHILD_'+randomUUID(),childBirthDate:'2015-02-03',attestation:'NEW_CHILD_WITH_NEW_GUARDIAN'}),guardianEffects);
 const registrations=[];for(let i=0;i<11;i++)registrations.push(await adult());
 const guardianChild=await child(),guardianReuse=await child();
 const input=(r,patch={})=>({registrationId:r.receipt.registrationId,expectedReceiptVersion:1,planCode:'OPAQUE-STAFF-CODE',termStartedAt:'2027-01-01T00:00:00.000Z',termEndsAt:'2028-01-01T00:00:00.000Z',currency:'USD',...patch});
 const draft=(r,c=context(),patch={})=>checked(()=>service.draftMembership(c,input(r,patch)),effects);
 const callRaw=(c,value)=>checked(()=>raw(c,'SELECT hon.draft_owner_launch_membership($1,$2::jsonb,$3,$4,$5)',[c.externalSubject,JSON.stringify(value),c.idempotencyKey,c.requestId,c.correlationId]));
 const person=async r=>(await owner.query('SELECT person_id FROM hon.student_profiles WHERE id=$1',[r.receipt.studentProfileId])).rows[0].person_id;
 const account=async(r,currency='USD',classification='CANONICAL')=>owner.query('INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification) VALUES($1,$2,$3,$4,$5) RETURNING id',[scope.organizationId,scope.schoolId,await person(r),currency,classification]);
 const firstContext=context(),first=await draft(registrations[0],firstContext);
 assert.equal(first.receipt.state,'DRAFT');assert.equal(first.receipt.billingAccountCreated,true);assert.equal(first.replayed,false);
 assert(!/payer|participant|personId|familyId|billingAccountId|PII_CANARY|paymentSchedule|activation|invoice/i.test(JSON.stringify(first)));
 const canonical=(await owner.query('SELECT m.state,m.plan_code,m.term_started_at,m.term_ends_at,m.participant_person_id,a.responsible_person_id,a.currency FROM hon.memberships m JOIN hon.billing_accounts a ON a.id=m.billing_account_id WHERE m.id=$1',[first.receipt.membershipId])).rows[0];
 assert.equal(canonical.participant_person_id,await person(registrations[0]));assert.equal(canonical.responsible_person_id,canonical.participant_person_id);assert.equal(canonical.currency,'USD');assert.equal(canonical.state,'DRAFT');assert.equal(canonical.plan_code,'OPAQUE-STAFF-CODE');assert.equal(canonical.term_started_at.toISOString(),input(registrations[0]).termStartedAt);assert.equal(canonical.term_ends_at.toISOString(),input(registrations[0]).termEndsAt);check();
 // Same key is a no-write replay. A new key is one completed redacted response,
 // not a new membership/account/audit/outbox. A changed declaration conflicts.
 const replay=await checked(()=>service.draftMembership(firstContext,input(registrations[0])));assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,first.receipt);
 const next=await draft(registrations[0]);assert.equal(next.replayed,true);assert.deepEqual(next.receipt,first.receipt);
 for(const patch of [{planCode:'DIFFERENT'},{currency:'CAD'},{termEndsAt:'2029-01-01T00:00:00.000Z'}])await assert.rejects(()=>draft(registrations[0],context(),patch),status(patch.currency?400:409));
 await assert.rejects(()=>draft(registrations[0],firstContext,{planCode:'DIFFERENT'}),status(409));check();
 // Explicit existing same-currency normal account reuse, not a new billing model.
 const existing=(await checked(async()=>accounts.create(context(),{responsiblePersonId:await person(registrations[1]),currency:'CAD'}),effects)).account.id;
 const reused=await draft(registrations[1],context(),{currency:'CAD'});assert.equal(reused.receipt.billingAccountCreated,false);
 assert.equal((await owner.query('SELECT billing_account_id FROM hon.memberships WHERE id=$1',[reused.receipt.membershipId])).rows[0].billing_account_id,existing);check();
 // Guardian-child receipt derives guardian payer and child participant; no access,
 // contact, family, login, payment or guardian-profile row is created.
 const gc=await draft(guardianChild);
 const gcRelation=(await owner.query('SELECT m.participant_person_id,a.responsible_person_id,r.guardian_person_id,r.child_person_id FROM hon.memberships m JOIN hon.billing_accounts a ON a.id=m.billing_account_id JOIN hon.guardian_child_registration_receipts r ON r.id=$2 WHERE m.id=$1',[gc.receipt.membershipId,guardianChild.receipt.registrationId])).rows[0];
 assert.equal(gcRelation.participant_person_id,gcRelation.child_person_id);assert.equal(gcRelation.responsible_person_id,gcRelation.guardian_person_id);assert.notEqual(gcRelation.participant_person_id,gcRelation.responsible_person_id);
 const guardianPayer=(await owner.query('SELECT guardian_person_id FROM hon.guardian_child_registration_receipts WHERE id=$1',[guardianReuse.receipt.registrationId])).rows[0].guardian_person_id;
 const guardianAccount=await checked(()=>accounts.create(context(),{responsiblePersonId:guardianPayer,currency:'EUR'}),effects);
 const guardianReused=await draft(guardianReuse,context(),{currency:'EUR'});assert.equal(guardianReused.receipt.billingAccountCreated,false);
 assert.equal((await owner.query('SELECT billing_account_id FROM hon.memberships WHERE id=$1',[guardianReused.receipt.membershipId])).rows[0].billing_account_id,guardianAccount.account.id);check();
 await account(registrations[2],'CAD');await assert.rejects(()=>draft(registrations[2]),e=>status(400)(e)&&e.getResponse().code==='MEMBERSHIP_DRAFT_NEEDS_STAFF');
 await account(registrations[3]);await account(registrations[3],'USD','ADDITIONAL');await assert.rejects(()=>draft(registrations[3]),e=>status(400)(e)&&e.getResponse().code==='MEMBERSHIP_DRAFT_NEEDS_STAFF');check();
 // Identical concurrent same-key and different-key commands create one account,
 // one membership and one pair of canonical creation facts, never double draft.
 for(const [r,sameKey]of [[registrations[4],true],[registrations[5],false]]){
  const c=context();const results=await checked(()=>Promise.all([service.draftMembership(c,input(r)),service.draftMembership(sameKey?c:context(),input(r))]),effects);
  assert.deepEqual(results[0].receipt,results[1].receipt);assert.equal(results.filter(x=>x.replayed).length,1);
  const count=(await owner.query('SELECT (SELECT count(*)::int FROM hon.billing_accounts WHERE responsible_person_id=$1) accounts,(SELECT count(*)::int FROM hon.memberships WHERE participant_person_id=$1) memberships',[await person(r)])).rows[0];assert.deepEqual(count,{accounts:1,memberships:1});
 }check();
 // Closed input and exact ISO/term validation are independently enforced in SQL.
 const malformed=[{expectedReceiptVersion:2},{expectedReceiptVersion:'1'},{planCode:''},{planCode:' x '},{planCode:'x'.repeat(81)},{planCode:'x\n'},{currency:'usd'},{currency:'US'},{currency:'ZZZ'},{currency:null},{termStartedAt:'2027-02-30T00:00:00.000Z'},{termStartedAt:'2027-01-01'},{termStartedAt:'infinity'},{termStartedAt:'2027-01-01T00:00:00+23:59'},{termStartedAt:'0000-01-01T00:00:00Z'},{termStartedAt:'0001-01-01T00:00:00+14:00'},{termEndsAt:'9999-12-31T23:59:59-14:00'},{termEndsAt:'2027-01-01T00:00:00.000Z'},{termEndsAt:'2026-01-01T00:00:00.000Z'}];
 for(const patch of malformed){await assert.rejects(()=>draft(registrations[6],context(),patch),status(400));await assert.rejects(()=>callRaw(context(),input(registrations[6],patch)),e=>['22023','22007','22008','40001'].includes(e.code));}
 for(const key of ['personId','payerPersonId','participantPersonId','billingAccountId','familyId','programId','classSessionId','schoolId','schedule','paymentSchedule','price','discount','paymentMethodId','processor','activation','invoice']){
  const value=input(registrations[6],{[key]:randomUUID()});await assert.rejects(()=>checked(()=>service.draftMembership(context(),value)),status(400));await assert.rejects(()=>callRaw(context(),value),e=>e.code==='22023');
 }
 for(const key of ['registrationId','expectedReceiptVersion','planCode','termStartedAt','termEndsAt','currency']){const value=input(registrations[6]);delete value[key];await assert.rejects(()=>callRaw(context(),value),e=>e.code==='22023');}check();
 await assert.rejects(()=>draft({receipt:{registrationId:randomUUID()}}),status(404));
 const foreign=(await owner.query('SELECT id FROM hon.student_registration_receipts WHERE organization_id=$1 AND school_id=$2 LIMIT 1',[other.organizationId,other.schoolId])).rows[0].id;
 await assert.rejects(()=>draft({receipt:{registrationId:foreign}}),status(404));await assert.rejects(()=>draft(registrations[6],context(other)),status(404));check();
 // Current custom role (the previous proof renamed OWNER to FRONT_DESK) must
 // explicitly retain BOTH exact live billing permissions, even for replay.
 for(const permission of ['billing.membership.create','billing.account.create']){
  await owner.query('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2',[ownerRoleId,permission]);
  try{await assert.rejects(()=>draft(registrations[6]),status(403));await assert.rejects(()=>checked(()=>service.draftMembership(firstContext,input(registrations[0]))),status(403));}
  finally{await owner.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[ownerRoleId,scope.organizationId,permission]);}
 }
 for(const [sql,args,restore]of [
  ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[scope.organizationId],"UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1"],
  ['UPDATE hon.principals SET is_active=false WHERE id=$1',[ids.principal],'UPDATE hon.principals SET is_active=true WHERE id=$1'],
  ['UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[ids.grant],'UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1']
 ]){await owner.query(sql,args);try{await assert.rejects(()=>draft(registrations[6]),status(403));await assert.rejects(()=>checked(()=>service.draftMembership(firstContext,input(registrations[0]))),status(403));}finally{await owner.query(restore,args);}}
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{source:'AUTOMATION'},{delegatedByPrincipalId:ids.principal},{actionRequestId:randomUUID()},{externalSubject:other.externalSubject},{schoolId:other.schoolId},{principalId:ids.otherPrincipal}]){
  await assert.rejects(()=>draft(registrations[6],context(patch)),status(403));await assert.rejects(()=>callRaw(context(patch),input(registrations[6])),e=>e.code==='42501');
 }
 for(const [sql,args,restore]of [
  ["INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_SUPPORT')",[ids.principal],'DELETE FROM hon.hq_operator_grants WHERE principal_id=$1'],
  ["INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4)",[scope.organizationId,scope.schoolId,ids.family,ids.principal],'DELETE FROM hon.family_access_grants WHERE organization_id=$1 AND school_id=$2 AND family_id=$3 AND principal_id=$4']
 ]){await owner.query(sql,args);try{await assert.rejects(()=>draft(registrations[6]),status(403));}finally{await owner.query(restore,args);}}check();
 const originalTier=(await owner.query('SELECT tier FROM hon.organization_entitlements WHERE organization_id=$1',[scope.organizationId])).rows[0].tier;
 try{for(const tier of ['ESSENTIAL','CORE','COMPLETE']){await owner.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[scope.organizationId,tier]);assert.equal((await draft(registrations[6])).receipt.state,'DRAFT');}}finally{await owner.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[scope.organizationId,originalTier]);}check();
 // Exact canonical evidence and redaction; no payer/participant/account selector
 // leaks into the membership audit/outbox/idempotency receipt.
 const evidence=(await owner.query(`SELECT
  (SELECT count(*)::int FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.membership.create' AND source='HUMAN_UI' AND request_id=$2 AND correlation_id=$3) audits,
  (SELECT count(*)::int FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.membership.drafted' AND causation_id=$2 AND correlation_id=$3) outbox,
  (SELECT status FROM hon.idempotency_records WHERE organization_id=$4 AND school_id=$5 AND principal_id=$6 AND idempotency_key=$7) status`,[first.receipt.membershipId,firstContext.requestId,firstContext.correlationId,scope.organizationId,scope.schoolId,scope.principalId,firstContext.idempotencyKey])).rows[0];assert.deepEqual(evidence,{audits:1,outbox:1,status:'COMPLETED'});
 const payloads=(await owner.query('SELECT next_state FROM hon.audit_events WHERE entity_id=$1',[first.receipt.membershipId])).rows;assert(!/PII_CANARY|personId|payer|participant|billingAccountId/i.test(JSON.stringify(payloads)));check();
 const genericPerson=await person(registrations[10]);
 const genericAccount=(await checked(()=>accounts.create(context(),{responsiblePersonId:genericPerson,currency:'USD'}),effects)).account;
 const genericContext=context(),genericInput={billingAccountId:genericAccount.id,participantPersonId:genericPerson,planCode:'GENERIC-UNCHANGED',termStartedAt:input(registrations[10]).termStartedAt,termEndsAt:input(registrations[10]).termEndsAt};
 const generic=await checked(()=>memberships.createDraft(genericContext,genericInput),effects);assert.equal(generic.membership.state,'DRAFT');
 assert.equal((await checked(()=>memberships.createDraft(genericContext,genericInput))).replayed,true);check();
 // Fail after canonical account/membership inserts, including final idempotency:
 // every failed command must leave all HON tables byte-for-byte unchanged.
 for(const [i,target]of ['audit_events','outbox_events','idempotency_records'].entries()){
  const event=target==='idempotency_records'?'UPDATE':'INSERT';
  const condition=target==='audit_events'?"IF NEW.action_code='billing.membership.create' THEN RAISE EXCEPTION 'FIXTURE_DRAFT_EVIDENCE_FAILURE'; END IF;":target==='outbox_events'?"IF NEW.event_type='billing.membership.drafted' THEN RAISE EXCEPTION 'FIXTURE_DRAFT_EVIDENCE_FAILURE'; END IF;":"RAISE EXCEPTION 'FIXTURE_DRAFT_EVIDENCE_FAILURE';";
  await owner.query(`CREATE FUNCTION hon.fixture_fail_owner_launch_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${condition} RETURN NEW; END $$; CREATE TRIGGER fixture_owner_launch_draft BEFORE ${event} ON hon.${target} FOR EACH ROW EXECUTE FUNCTION hon.fixture_fail_owner_launch_draft()`);
  try{await assert.rejects(()=>draft(registrations[7+i]),status(503));}finally{await owner.query(`DROP TRIGGER fixture_owner_launch_draft ON hon.${target}; DROP FUNCTION hon.fixture_fail_owner_launch_draft()`);}
 }check();
 // Prove current changed draft state cannot masquerade as a new DRAFT command.
 // 0177: lifecycle transitions are trigger-guarded; the disposable owner seeds and restores this state directly.
 await membershipFixtureQuery(owner,"UPDATE hon.memberships SET state='ACTIVE' WHERE id=$1",[first.receipt.membershipId]);
 try{await assert.rejects(()=>checked(()=>service.draftMembership(firstContext,input(registrations[0]))),status(400));}finally{await membershipFixtureQuery(owner,"UPDATE hon.memberships SET state='DRAFT' WHERE id=$1",[first.receipt.membershipId]);}
 await drift("ALTER FUNCTION hon.draft_owner_launch_membership(text,jsonb,text,uuid,uuid) SET statement_timeout TO '1s'");check();
 // Whole-table checked() proves zero effects outside the five canonical tables
 // on every command, explicitly including schedules/methods/processors/invoices/
 // attempts/activation/booking/attendance/family/communication/AI/provider work.
 return groups;
}
