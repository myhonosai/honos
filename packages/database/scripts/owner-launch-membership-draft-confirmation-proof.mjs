import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Only the marked localhost owner proof may invoke this fixture. All GETs use
 * checked() with an EMPTY effects allowlist: every HON table must be unchanged. */
export async function proveOwnerLaunchMembershipDraftConfirmation({owner,service,scope,other,context,checked,raw,drift,ids,ownerRoleId,program,classSession,registered}) {
 let groups=0; const check=()=>groups++; const status=n=>e=>e?.getStatus?.()===n;
 const read=(c=context())=>checked(()=>service.readMembershipDraft(c));
 const rawRead=(c=context())=>checked(()=>raw(c,'SELECT hon.read_owner_launch_membership_draft($1) data',[c.externalSubject]));
 const empty={state:'NO_RECORDED_DRAFT',receipt:null},unavailable={state:'DRAFT_UNAVAILABLE',receipt:null};
 const effects=['billing_accounts','memberships','audit_events','outbox_events','idempotency_records'];
 const declaration=r=>({registrationId:r.registrationId,expectedReceiptVersion:1,planCode:'OPAQUE-CONFIRMATION',termStartedAt:'2027-01-01T00:00:00.000Z',termEndsAt:'2028-01-01T00:00:00.000Z',currency:'USD'});
 assert.deepEqual(await read(),empty);assert.deepEqual(await read(context(other)),empty);check();
 const adult=await checked(()=>service.draftMembership(context(),declaration(registered.receipt)),effects);
 const {billingAccountCreated,...safeAdult}=adult.receipt;
 const expected={state:'RECORDED_DRAFT',receipt:safeAdult};
 for(let i=0;i<3;i++)assert.deepEqual(await read(),expected);
 assert.deepEqual((await rawRead()).rows[0].data,expected);
 assert.equal(Object.keys(safeAdult).length,9);
 assert(!/account|payer|participant|person|family|schedule|invoice|provider|payment|audit|action|policy|source|PII_CANARY/i.test(JSON.stringify(expected)));check();
 // A second independently granted direct human in the SAME school cannot see
 // this creator's audit or receipt. Its own child draft confirms guardian payer
 // and child participant without leaking either identity or granting parent access.
 const childIds={user:randomUUID(),principal:randomUUID(),grant:randomUUID()},childSubject='confirmation-child-'+randomUUID();
 await owner.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$1::uuid::text||'@example.test','Fixture child operator')",[childIds.user,childSubject]);
 await owner.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Fixture child operator')",[childIds.principal,childIds.user]);
 await owner.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)',[childIds.grant,scope.organizationId,scope.schoolId,childIds.principal,ownerRoleId]);
 const childContext=()=>context({principalId:childIds.principal,externalSubject:childSubject});
 assert.deepEqual(await read(childContext()),empty);
 const child=await checked(()=>service.registerGuardianChild(childContext(),{programId:program.id,expectedProgramVersion:program.version,classSessionId:classSession.id,expectedClassSessionVersion:classSession.version,guardianGivenName:'PII_CANARY_GUARDIAN_'+randomUUID(),guardianFamilyName:'Private '+randomUUID(),guardianBirthDate:'1980-02-03',childGivenName:'PII_CANARY_CHILD_'+randomUUID(),childFamilyName:'Private '+randomUUID(),childBirthDate:'2015-02-03',attestation:'NEW_CHILD_WITH_NEW_GUARDIAN'}),['people','families','family_members','student_profiles','student_curriculum_enrollments','guardian_child_registration_receipts','guardian_child_registration_outbox','audit_events']);
 const childDraft=await checked(()=>service.draftMembership(childContext(),declaration(child.receipt)),effects);
 const {billingAccountCreated:ignored,...safeChild}=childDraft.receipt;
 const childExpected={state:'RECORDED_DRAFT',receipt:safeChild};
 assert.deepEqual(await read(childContext()),childExpected);assert.deepEqual(await read(),expected);assert.deepEqual(await read(context(other)),empty);check();
 const adultRow=(await owner.query('SELECT * FROM hon.memberships WHERE id=$1',[safeAdult.membershipId])).rows[0];
 const childRow=(await owner.query('SELECT * FROM hon.memberships WHERE id=$1',[safeChild.membershipId])).rows[0];
 const audit=(await owner.query("SELECT * FROM hon.audit_events WHERE entity_id=$1 AND next_state->>'operation'='OWNER_LAUNCH_MEMBERSHIP_DRAFT'",[safeAdult.membershipId])).rows[0];
 const childAudit=(await owner.query("SELECT * FROM hon.audit_events WHERE entity_id=$1 AND next_state->>'operation'='OWNER_LAUNCH_MEMBERSHIP_DRAFT'",[safeChild.membershipId])).rows[0];
 const mutate=async(sql,args,restore,restoreArgs=args,c=context())=>{await owner.query(sql,args);try{assert.deepEqual(await read(c),unavailable);}finally{await owner.query(restore,restoreArgs);}assert.deepEqual(await read(c),c.principalId===childIds.principal?childExpected:expected);};
 // Current state, canonical version, metadata and payer/participant drift all
 // fail unavailable rather than returning historical creation success or a fallback.
 for(const state of ['ACTIVE','CANCELLED'])await mutate('UPDATE hon.memberships SET state=$2 WHERE id=$1',[adultRow.id,state],"UPDATE hon.memberships SET state='DRAFT' WHERE id=$1",[adultRow.id]);
 for(const [column,value]of [['version',adultRow.version+1],['plan_code','CHANGED'],['term_started_at','2027-02-01T00:00:00Z'],['term_ends_at','2029-01-01T00:00:00Z'],['participant_person_id',childRow.participant_person_id],['billing_account_id',childRow.billing_account_id]])await mutate(`UPDATE hon.memberships SET ${column}=$2 WHERE id=$1`,[adultRow.id,value],`UPDATE hon.memberships SET ${column}=$2 WHERE id=$1`,[adultRow.id,adultRow[column]]);
 const payer=(await owner.query('SELECT responsible_person_id,currency FROM hon.billing_accounts WHERE id=$1',[adultRow.billing_account_id])).rows[0];
 await mutate('UPDATE hon.billing_accounts SET responsible_person_id=$2 WHERE id=$1',[adultRow.billing_account_id,childRow.participant_person_id],'UPDATE hon.billing_accounts SET responsible_person_id=$2 WHERE id=$1',[adultRow.billing_account_id,payer.responsible_person_id]);
 await mutate("UPDATE hon.billing_accounts SET currency='CAD' WHERE id=$1",[adultRow.billing_account_id],'UPDATE hon.billing_accounts SET currency=$2 WHERE id=$1',[adultRow.billing_account_id,payer.currency]);
 await mutate('UPDATE hon.memberships SET participant_person_id=$2 WHERE id=$1',[childRow.id,payer.responsible_person_id],'UPDATE hon.memberships SET participant_person_id=$2 WHERE id=$1',[childRow.id,childRow.participant_person_id],childContext());check();
 const duplicateAccount=(await owner.query("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency) VALUES($1,$2,$3,'USD') RETURNING id",[scope.organizationId,scope.schoolId,payer.responsible_person_id])).rows[0].id;
 try{assert.deepEqual(await read(),unavailable);}finally{await owner.query('DELETE FROM hon.billing_accounts WHERE id=$1',[duplicateAccount]);}
 const schedule=(await owner.query("INSERT INTO hon.membership_payment_schedules(organization_id,school_id,membership_id,frequency,amount_minor,currency) VALUES($1,$2,$3,'MONTHLY',1,'USD') RETURNING id",[scope.organizationId,scope.schoolId,adultRow.id])).rows[0].id;
 try{assert.deepEqual(await read(),unavailable);}finally{await owner.query('DELETE FROM hon.membership_payment_schedules WHERE id=$1',[schedule]);}
 const invoice=(await owner.query("INSERT INTO hon.invoices(organization_id,school_id,billing_account_id,membership_id,currency,subtotal_minor,total_minor) VALUES($1,$2,$3,$4,'USD',1,1) RETURNING id",[scope.organizationId,scope.schoolId,adultRow.billing_account_id,adultRow.id])).rows[0].id;
 try{assert.deepEqual(await read(),unavailable);}finally{await owner.query('DELETE FROM hon.invoices WHERE id=$1',[invoice]);}check();
 // Privileged synthetic evidence corruption probes are local-only. Immutable
 // receipt triggers are temporarily disabled ONLY to exercise defensive reads.
 for(const patch of [{registrationId:randomUUID()},{registrationId:child.receipt.registrationId},{registrationId:'invalid'},{membershipId:childRow.id},{membershipVersion:2},{state:'ACTIVE'}])await mutate('UPDATE hon.audit_events SET next_state=$2::jsonb WHERE id=$1',[audit.id,JSON.stringify({...audit.next_state,...patch})],'UPDATE hon.audit_events SET next_state=$2::jsonb WHERE id=$1',[audit.id,JSON.stringify(audit.next_state)]);
 await mutate('UPDATE hon.audit_events SET entity_id=$2 WHERE id=$1',[audit.id,childRow.id],'UPDATE hon.audit_events SET entity_id=$2 WHERE id=$1',[audit.id,audit.entity_id]);
 const foreignReceipt=(await owner.query('SELECT id FROM hon.student_registration_receipts WHERE organization_id=$1 AND school_id=$2 LIMIT 1',[other.organizationId,other.schoolId])).rows[0].id;
 await mutate('UPDATE hon.audit_events SET next_state=$2::jsonb WHERE id=$1',[audit.id,JSON.stringify({...audit.next_state,registrationId:foreignReceipt})],'UPDATE hon.audit_events SET next_state=$2::jsonb WHERE id=$1',[audit.id,JSON.stringify(audit.next_state)]);
 for(const [table,id]of [['student_registration_receipts',registered.receipt.registrationId],['guardian_child_registration_receipts',child.receipt.registrationId]]){
  await owner.query(`ALTER TABLE hon.${table} DISABLE TRIGGER registration_immutable`);
  try{await mutate(`UPDATE hon.${table} SET actor_principal_id=$2 WHERE id=$1`,[id,ids.otherPrincipal],`UPDATE hon.${table} SET actor_principal_id=$2 WHERE id=$1`,[id,table.startsWith('student')?ids.principal:childIds.principal],table.startsWith('student')?context():childContext());}
  finally{await owner.query(`ALTER TABLE hon.${table} ENABLE TRIGGER registration_immutable`);}
 }check();
 // Missing audit is no recorded DRAFT even while the canonical row exists.
 await owner.query('UPDATE hon.audit_events SET actor_principal_id=$2 WHERE id=$1',[audit.id,ids.otherPrincipal]);
 try{assert.deepEqual(await read(),empty);}finally{await owner.query('UPDATE hon.audit_events SET actor_principal_id=$2 WHERE id=$1',[audit.id,ids.principal]);}
 await mutate('UPDATE hon.audit_events SET actor_principal_id=$2 WHERE id=$1',[childAudit.id,ids.principal],'UPDATE hon.audit_events SET actor_principal_id=$2 WHERE id=$1',[childAudit.id,childIds.principal]);check();
 // Canonical row loss cannot fall back to an otherwise matching generic DRAFT.
 const canonicalJson=(await owner.query('SELECT to_jsonb(m) row FROM hon.memberships m WHERE id=$1',[adultRow.id])).rows[0].row;
 const generic=(await owner.query("INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at) VALUES($1,$2,$3,$4,$5,'DRAFT',$6,$7) RETURNING id",[scope.organizationId,scope.schoolId,adultRow.billing_account_id,adultRow.participant_person_id,adultRow.plan_code,adultRow.term_started_at,adultRow.term_ends_at])).rows[0].id;
 await owner.query('DELETE FROM hon.memberships WHERE id=$1',[adultRow.id]);
 try{assert.deepEqual(await read(),unavailable);}finally{await owner.query('INSERT INTO hon.memberships SELECT (jsonb_populate_record(NULL::hon.memberships,$1::jsonb)).*',[JSON.stringify(canonicalJson)]);await owner.query('DELETE FROM hon.memberships WHERE id=$1',[generic]);}
 assert.deepEqual(await read(),expected);check();
 const foreignPerson=(await owner.query('SELECT s.person_id FROM hon.student_registration_receipts r JOIN hon.student_profiles s ON s.id=r.student_profile_id WHERE r.id=$1',[foreignReceipt])).rows[0].person_id;
 const foreignAccount=(await owner.query("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency) VALUES($1,$2,$3,'USD') RETURNING id",[other.organizationId,other.schoolId,foreignPerson])).rows[0].id;
 const foreignMembership=(await owner.query("INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at) VALUES($1,$2,$3,$4,$5,'DRAFT',$6,$7) RETURNING id",[other.organizationId,other.schoolId,foreignAccount,foreignPerson,adultRow.plan_code,adultRow.term_started_at,adultRow.term_ends_at])).rows[0].id;
 try{await mutate('UPDATE hon.audit_events SET entity_id=$2,next_state=$3::jsonb WHERE id=$1',[audit.id,foreignMembership,JSON.stringify({...audit.next_state,membershipId:foreignMembership})],'UPDATE hon.audit_events SET entity_id=$2,next_state=$3::jsonb WHERE id=$1',[audit.id,adultRow.id,JSON.stringify(audit.next_state)]);}
 finally{await owner.query('DELETE FROM hon.memberships WHERE id=$1',[foreignMembership]);await owner.query('DELETE FROM hon.billing_accounts WHERE id=$1',[foreignAccount]);}check();
 // Same live role/permission/tier exclusion gates hold on reload, including
 // custom-role authority, expiration, revoked/nonhuman/delegated/action/HQ/parent.
 for(const permission of ['school.view','curriculum.progress.record','billing.membership.create','billing.account.create','family.manage']){
  await owner.query('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2',[ownerRoleId,permission]);
  try{await assert.rejects(()=>read(permission==='family.manage'?childContext():context()),status(403));}
  finally{await owner.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[ownerRoleId,scope.organizationId,permission]);}
 }
 for(const [sql,args,restore,restoreArgs]of [
  ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[scope.organizationId],"UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[scope.organizationId]],
  ['UPDATE hon.principals SET is_active=false WHERE id=$1',[ids.principal],'UPDATE hon.principals SET is_active=true WHERE id=$1',[ids.principal]],
  ['UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[ids.grant],'UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[ids.grant]],
  ["UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()-interval '1s' WHERE id=$1",[ids.grant],'UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1',[ids.grant]],
  ["UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1s' WHERE organization_id=$1",[scope.organizationId],'UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1',[scope.organizationId]],
  ["UPDATE hon.roles SET code='PARENT' WHERE id=$1",[ownerRoleId],"UPDATE hon.roles SET code='FRONT_DESK' WHERE id=$1",[ownerRoleId]],
  ["INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_SUPPORT')",[ids.principal],'DELETE FROM hon.hq_operator_grants WHERE principal_id=$1',[ids.principal]],
  ["INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4)",[scope.organizationId,scope.schoolId,ids.family,ids.principal],'DELETE FROM hon.family_access_grants WHERE family_id=$1 AND principal_id=$2',[ids.family,ids.principal]]
 ]){await owner.query(sql,args);try{await assert.rejects(()=>read(),status(403));await assert.rejects(()=>rawRead(),e=>e.code==='42501');}finally{await owner.query(restore,restoreArgs);}}check();
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{source:'AUTOMATION'},{delegatedByPrincipalId:ids.principal},{actionRequestId:randomUUID()},{externalSubject:other.externalSubject},{principalId:ids.otherPrincipal},{schoolId:other.schoolId},{organizationId:other.organizationId}]){
  await assert.rejects(()=>read(context(patch)),status(403));await assert.rejects(()=>rawRead(context(patch)),e=>e.code==='42501');
 }check();
 const tier=(await owner.query('SELECT tier FROM hon.organization_entitlements WHERE organization_id=$1',[scope.organizationId])).rows[0].tier;
 try{for(const value of ['ESSENTIAL','CORE','COMPLETE']){await owner.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[scope.organizationId,value]);assert.deepEqual(await read(),expected);assert.deepEqual(await read(childContext()),childExpected);}}
 finally{await owner.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[scope.organizationId,tier]);}check();
 // Authorization must expire closed after a canonical lock wait, not just at
 // the initial IAM check. The read still leaves every table unchanged.
 await owner.query("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()+interval '2 seconds' WHERE id=$1",[ids.grant]);
 await owner.query('BEGIN');await owner.query('LOCK TABLE hon.memberships IN SHARE ROW EXCLUSIVE MODE');
 try{
  const pending=assert.rejects(()=>read(),status(403));
  await new Promise(resolve=>setTimeout(resolve,2200));await owner.query('ROLLBACK');await pending;
 }finally{await owner.query('ROLLBACK');await owner.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1',[ids.grant]);}
 assert.deepEqual(await read(),expected);check();
 // Fixed signature/no overload, no direct mutation or elevated execution grants.
 await assert.rejects(()=>checked(()=>raw(context(),'SELECT hon.read_owner_launch_membership_draft($1,$2)',[context().externalSubject,adultRow.id])),e=>e.code==='42883');
 for(const sql of ["ALTER FUNCTION hon.read_owner_launch_membership_draft(text) SET statement_timeout TO '1s'",'ALTER FUNCTION hon.read_owner_launch_membership_draft(text) SECURITY INVOKER',"CREATE FUNCTION hon.read_owner_launch_membership_draft(text,uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$"])await drift(sql);
 for(const table of ['audit_events','billing_accounts','memberships'])await drift(`GRANT DELETE ON hon.${table} TO hon_owner_launch_runtime`);
 await drift("CREATE OR REPLACE FUNCTION hon.read_owner_launch_membership_draft(p_subject text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$ BEGIN RETURN '{}'::jsonb; END $$");
 assert.deepEqual(await read(),expected);assert.deepEqual(await read(childContext()),childExpected);check();
 return groups;
}
