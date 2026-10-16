import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Only the main marked localhost, provider-rejecting proof invokes this module.
 * Every successful/denied read uses checked() with NO effects allowlisted. */
export async function proveOwnerLaunchFirstClassBookingContext({owner,runtime,service,programs,classes,bookings,scope,other,context,checked,raw,drift,ids,ownerRoleId}) {
 let groups=0;const check=()=>groups++;const status=n=>e=>e?.getStatus?.()===n;
 const empty={state:'NO_RECORDED_BOOKING',context:null},unavailable={state:'BOOKING_UNAVAILABLE',context:null};
 const read=c=>checked(()=>service.readFirstClassBookingContext(c));
 const rawRead=c=>checked(()=>raw(c,'SELECT hon.read_owner_launch_first_class_booking_context($1) data',[c.externalSubject]));
 const bookingEffects=['class_bookings','idempotency_records','audit_events','outbox_events'];
 const adultEffects=['people','student_profiles','student_curriculum_enrollments','student_registration_receipts','student_registration_outbox','audit_events'];
 const childEffects=['people','families','family_members','student_profiles','student_curriculum_enrollments','guardian_child_registration_receipts','guardian_child_registration_outbox','audit_events'];
 const operator=async(label)=>{
  const user=randomUUID(),principal=randomUUID(),grant=randomUUID(),externalSubject='booking-confirmation-'+label+'-'+randomUUID();
  await owner.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$1::uuid::text||'@example.test','Fixture confirmation operator')",[user,externalSubject]);
  await owner.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Fixture confirmation operator')",[principal,user]);
  await owner.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)',[grant,scope.organizationId,scope.schoolId,principal,ownerRoleId]);
  return {principalId:principal,externalSubject,grant};
 };
 const adultActor=await operator('adult'),childActor=await operator('child'),observer=await operator('observer');
 const adultContext=()=>context(adultActor),childContext=()=>context(childActor);
 assert.deepEqual(await read(adultContext()),empty);assert.deepEqual(await read(childContext()),empty);assert.deepEqual(await read(context(observer)),empty);check();
 const setup=async(c,label)=>{
  const program=(await checked(()=>programs.create(c,{name:'Confirmation program '+label}),['programs','idempotency_records','audit_events','outbox_events'])).program;
  const session=(await checked(()=>classes.create(context({principalId:c.principalId,externalSubject:c.externalSubject}),{programId:program.id,name:'Readable first class '+label,startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString(),capacity:1,bookingPolicy:'OPTIONAL_BOOKING'}),['class_sessions','idempotency_records','audit_events','outbox_events'])).classSession;
  return {program,session,target:{programId:program.id,expectedProgramVersion:program.version,classSessionId:session.id,expectedClassSessionVersion:session.version}};
 };
 const adultSetup=await setup(adultContext(),'adult'),childSetup=await setup(childContext(),'child');
 const adult=await checked(()=>service.register(adultContext(),{...adultSetup.target,givenName:'Readable Adult',familyName:'Confirmation '+randomUUID(),birthDate:'1990-02-03',attestation:'NEW_ADULT_NO_GUARDIAN_REQUIRED'}),adultEffects);
 const child=await checked(()=>service.registerGuardianChild(childContext(),{...childSetup.target,guardianGivenName:'PII_CANARY_GUARDIAN_'+randomUUID(),guardianFamilyName:'Private Guardian',guardianBirthDate:'1980-02-03',childGivenName:'Readable Child',childFamilyName:'Confirmation '+randomUUID(),childBirthDate:'2015-02-03',attestation:'NEW_CHILD_WITH_NEW_GUARDIAN'}),childEffects);
 assert.deepEqual(await read(adultContext()),empty);assert.deepEqual(await read(childContext()),empty);check();
 // Canonical generic booking alone cannot infer owner-launch confirmation.
 const generic=await checked(()=>bookings.create(adultContext(),adultSetup.session.id,{studentProfileId:adult.receipt.studentProfileId,bookingKind:'REGULAR'}),bookingEffects);
 assert.deepEqual(await read(adultContext()),empty);
 const bookInput=(registration,setup)=>({registrationId:registration.receipt.registrationId,expectedReceiptVersion:1,expectedClassSessionVersion:setup.session.version});
 const firstContext=adultContext(),booked=await checked(()=>service.bookFirstClass(firstContext,bookInput(adult,adultSetup)),bookingEffects);
 assert.equal(booked.receipt.bookingId,generic.booking.id);assert.equal(booked.replayed,true);
 assert.deepEqual((await checked(()=>service.bookFirstClass(firstContext,bookInput(adult,adultSetup)))).receipt,booked.receipt);
 assert.deepEqual((await checked(()=>service.bookFirstClass(adultContext(),bookInput(adult,adultSetup)),['idempotency_records'])).receipt,booked.receipt);
 const concurrent=await checked(()=>Promise.all([service.bookFirstClass(adultContext(),bookInput(adult,adultSetup)),service.readFirstClassBookingContext(adultContext())]),['idempotency_records']);assert.equal(concurrent[0].receipt.bookingId,booked.receipt.bookingId);assert.equal(concurrent[1].context.booking.id,booked.receipt.bookingId);
 const expected=await read(adultContext());assert.equal(expected.state,'RECORDED_BOOKING');assert.equal(expected.context.booking.status,'BOOKED');assert(expected.context.student.displayName.startsWith('Readable Adult'));assert.equal(expected.context.classSession.name,'Readable first class adult');
 assert.deepEqual((await rawRead(adultContext())).rows[0].data,expected);assert.deepEqual(await read(adultContext()),expected);check();
 // Fill the child's canonical class using generic staff semantics. Only the
 // receipt-linked child may appear, never this other booked student's identity.
 await checked(()=>bookings.create(childContext(),childSetup.session.id,{studentProfileId:adult.receipt.studentProfileId,bookingKind:'REGULAR'}),bookingEffects);
 const waitlisted=await checked(()=>service.bookFirstClass(childContext(),bookInput(child,childSetup)),bookingEffects);
 const childExpected=await read(childContext());assert.equal(waitlisted.receipt.status,'WAITLISTED');assert.equal(childExpected.context.booking.status,'WAITLISTED');assert(childExpected.context.student.displayName.startsWith('Readable Child'));
 assert.equal(childExpected.context.registrationId,child.receipt.registrationId);assert(!JSON.stringify(childExpected).includes(adult.receipt.studentProfileId));assert(!JSON.stringify(childExpected).includes('PII_CANARY_GUARDIAN'));
 for(const value of [expected,childExpected]){
  assert.deepEqual(Object.keys(value).sort(),['context','state']);assert.deepEqual(Object.keys(value.context).sort(),['booking','classSession','registrationId','student']);
  assert.deepEqual(Object.keys(value.context.student).sort(),['displayName','studentProfileId']);
  assert.deepEqual(Object.keys(value.context.classSession).sort(),['bookingPolicy','capacity','endsAt','id','name','startsAt','status']);
  assert.deepEqual(Object.keys(value.context.booking).sort(),['bookingKind','id','recordedAt','status','version']);
  assert(!/guardian|family|birth|email|phone|attendance|membership|billing|payment|provider|eligibility|parent|communication|audit|outbox|action/i.test(JSON.stringify(value)));
 }
 assert.deepEqual(await read(context(observer)),empty);assert.deepEqual(await read(context(other)),empty);check();
 const mutate=async(sql,args,restore,restoreArgs=args,c=adultContext(),after=expected)=>{
  await owner.query(sql,args);try{assert.deepEqual(await read(c),unavailable);}finally{await owner.query(restore,restoreArgs);}assert.deepEqual(await read(c),after);
 };
 const adultRow=(await owner.query('SELECT * FROM hon.class_bookings WHERE id=$1',[booked.receipt.bookingId])).rows[0];
 const isolatedClass=(await owner.query("INSERT INTO hon.class_sessions(organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy) SELECT organization_id,school_id,program_id,'Isolated drift class',starts_at,ends_at,capacity,booking_policy FROM hon.class_sessions WHERE id=$1 RETURNING id",[adultSetup.session.id])).rows[0].id;
 for(const [column,value]of [['student_profile_id',child.receipt.studentProfileId],['class_session_id',isolatedClass],['booking_kind','TRIAL'],['version',adultRow.version+1],['source','PARENT_APP'],['created_at','2020-01-01T00:00:00Z']])await mutate(`UPDATE hon.class_bookings SET ${column}=$2 WHERE id=$1`,[adultRow.id,value],`UPDATE hon.class_bookings SET ${column}=$2 WHERE id=$1`,[adultRow.id,adultRow[column]]);
 for(const state of ['WAITLISTED','CHECKED_IN','NO_SHOW'])await mutate('UPDATE hon.class_bookings SET status=$2 WHERE id=$1',[adultRow.id,state],'UPDATE hon.class_bookings SET status=$2 WHERE id=$1',[adultRow.id,adultRow.status]);
 await mutate("UPDATE hon.class_bookings SET status='CANCELLED',cancelled_at=clock_timestamp(),version=version+1 WHERE id=$1",[adultRow.id],'UPDATE hon.class_bookings SET status=$2,cancelled_at=NULL,version=$3 WHERE id=$1',[adultRow.id,adultRow.status,adultRow.version]);check();
 // Actual current class status/name/capacity/policy/times are not historical
 // creation metadata. A cancelled class is clearly cancelled, never attendance.
 await owner.query("UPDATE hon.class_sessions SET status='CANCELLED',cancellation_reason='Fixture cancelled',version=version+1 WHERE id=$1",[adultSetup.session.id]);
 try{const cancelled=await read(adultContext());assert.equal(cancelled.context.classSession.status,'CANCELLED');assert.equal(cancelled.context.booking.status,'BOOKED');}finally{await owner.query("UPDATE hon.class_sessions SET status='SCHEDULED',cancellation_reason=NULL,version=version-1 WHERE id=$1",[adultSetup.session.id]);}
 const sessionRow=(await owner.query('SELECT * FROM hon.class_sessions WHERE id=$1',[adultSetup.session.id])).rows[0];
 await owner.query("UPDATE hon.class_sessions SET name='Current readable class',capacity=2,booking_policy='REQUIRED_BOOKING',starts_at=starts_at+interval '1 hour',ends_at=ends_at+interval '1 hour' WHERE id=$1",[sessionRow.id]);
 try{const current=(await read(adultContext())).context.classSession;assert.equal(current.name,'Current readable class');assert.equal(current.capacity,2);assert.equal(current.bookingPolicy,'REQUIRED_BOOKING');assert.notEqual(current.startsAt,expected.context.classSession.startsAt);}finally{await owner.query('UPDATE hon.class_sessions SET name=$2,capacity=$3,booking_policy=$4,starts_at=$5,ends_at=$6 WHERE id=$1',[sessionRow.id,sessionRow.name,sessionRow.capacity,sessionRow.booking_policy,sessionRow.starts_at,sessionRow.ends_at]);}check();
 const responses=(await owner.query("SELECT * FROM hon.idempotency_records WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND response_body->>'bookingId'=$4",[scope.organizationId,scope.schoolId,adultActor.principalId,adultRow.id])).rows;
 // Identical replay evidence is safe; ONE changed/foreign response is ambiguity.
 const foreignRegistration=(await owner.query('SELECT receipt FROM hon.student_registration_receipts WHERE organization_id=$1 AND school_id=$2 AND actor_principal_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1',[other.organizationId,other.schoolId,other.principalId])).rows[0].receipt;
 const foreignVersion=(await owner.query('SELECT version FROM hon.class_sessions WHERE id=$1',[foreignRegistration.classSessionId])).rows[0].version;
 const foreignBooking=await checked(()=>service.bookFirstClass(context(other),{registrationId:foreignRegistration.registrationId,expectedReceiptVersion:1,expectedClassSessionVersion:foreignVersion}),bookingEffects);
 const foreignRead=await read(context(other));assert.equal(foreignRead.context.booking.id,foreignBooking.receipt.bookingId);assert(!JSON.stringify(foreignRead).includes(adult.receipt.studentProfileId));
 for(const patch of [{bookingId:foreignBooking.receipt.bookingId},{bookingId:waitlisted.receipt.bookingId},{classSessionId:childSetup.session.id},{bookingVersion:2},{status:'WAITLISTED'},{guardian:'PII_CANARY'},{recordedAt:'invalid'}])await mutate('UPDATE hon.idempotency_records SET response_body=$2::jsonb WHERE id=$1',[responses[0].id,JSON.stringify({...responses[0].response_body,...patch})],'UPDATE hon.idempotency_records SET response_body=$2::jsonb WHERE id=$1',[responses[0].id,JSON.stringify(responses[0].response_body)]);
 await owner.query("UPDATE hon.idempotency_records SET status='FAILED' WHERE id=ANY($1::uuid[])",[responses.map(r=>r.id)]);try{assert.deepEqual(await read(adultContext()),empty);}finally{await owner.query("UPDATE hon.idempotency_records SET status='COMPLETED' WHERE id=ANY($1::uuid[])",[responses.map(r=>r.id)]);}check();
 for(const [table,receipt,c,after]of [['student_registration_receipts',adult.receipt,adultContext(),expected],['guardian_child_registration_receipts',child.receipt,childContext(),childExpected]]){
  const row=(await owner.query(`SELECT * FROM hon.${table} WHERE id=$1`,[receipt.registrationId])).rows[0];
  await owner.query(`ALTER TABLE hon.${table} DISABLE TRIGGER registration_immutable`);
  try{for(const patch of [{registrationId:randomUUID()},{studentProfileId:randomUUID()},{programId:randomUUID()},{classSessionId:randomUUID()},{status:'BOOKED'}])await mutate(`UPDATE hon.${table} SET receipt=$2::jsonb WHERE id=$1`,[row.id,JSON.stringify({...row.receipt,...patch})],`UPDATE hon.${table} SET receipt=$2::jsonb WHERE id=$1`,[row.id,JSON.stringify(row.receipt)],c,after);}
  finally{await owner.query(`ALTER TABLE hon.${table} ENABLE TRIGGER registration_immutable`);}
 }check();
 // Immutable explicit family composites reject relation mutation even by a local
 // fixture owner. Defensive reader also rejects a changed receipt family field.
 const childReceipt=(await owner.query('SELECT * FROM hon.guardian_child_registration_receipts WHERE id=$1',[child.receipt.registrationId])).rows[0];
 await owner.query('ALTER TABLE hon.guardian_child_registration_receipts DISABLE TRIGGER registration_immutable');
 try{await mutate('UPDATE hon.guardian_child_registration_receipts SET receipt=$2::jsonb WHERE id=$1',[childReceipt.id,JSON.stringify({...childReceipt.receipt,familyId:ids.family})],'UPDATE hon.guardian_child_registration_receipts SET receipt=$2::jsonb WHERE id=$1',[childReceipt.id,JSON.stringify(childReceipt.receipt)],childContext(),childExpected);}finally{await owner.query('ALTER TABLE hon.guardian_child_registration_receipts ENABLE TRIGGER registration_immutable');}check();
 // Only this disposable owner may remove/reinstate a composite FK to simulate
 // impossible production drift. Each observed GET still has zero table effects.
 const composites=[
  ['student_registration_receipts','registration_class_program_fk','FOREIGN KEY(class_session_id,program_id,organization_id,school_id) REFERENCES hon.class_sessions(id,program_id,organization_id,school_id)',
   'UPDATE hon.class_sessions SET program_id=$2 WHERE id=$1',[adultSetup.session.id,childSetup.program.id],'UPDATE hon.class_sessions SET program_id=$2 WHERE id=$1',[adultSetup.session.id,adultSetup.program.id],adultContext(),expected],
  ['guardian_child_registration_receipts','child_registration_guardian_fk','FOREIGN KEY(guardian_member_id,family_id,guardian_person_id,guardian_role,organization_id,school_id) REFERENCES hon.family_members(id,family_id,person_id,member_role,organization_id,school_id)',
   "UPDATE hon.family_members SET member_role='STUDENT' WHERE id=$1",[childReceipt.guardian_member_id],"UPDATE hon.family_members SET member_role='GUARDIAN' WHERE id=$1",[childReceipt.guardian_member_id],childContext(),childExpected],
 ];
 for(const [table,constraint,definition,sql,args,restore,restoreArgs,c,after]of composites){
  await owner.query(`ALTER TABLE hon.${table} DROP CONSTRAINT ${constraint}`);
  try{await mutate(sql,args,restore,restoreArgs,c,after);}finally{await owner.query(`ALTER TABLE hon.${table} ADD CONSTRAINT ${constraint} ${definition}`);}
 }
 check();
 const person=(await owner.query('SELECT p.* FROM hon.student_profiles s JOIN hon.people p ON p.id=s.person_id WHERE s.id=$1',[adult.receipt.studentProfileId])).rows[0];
 await owner.query("UPDATE hon.people SET given_name=E'<Readable>\\n',family_name=E'Adult\\t' WHERE id=$1",[person.id]);try{assert.equal((await read(adultContext())).context.student.displayName,'Readable Adult');}finally{await owner.query('UPDATE hon.people SET given_name=$2,family_name=$3 WHERE id=$1',[person.id,person.given_name,person.family_name]);}
 await mutate("UPDATE hon.people SET given_name='< >',family_name='' WHERE id=$1",[person.id],'UPDATE hon.people SET given_name=$2,family_name=$3 WHERE id=$1',[person.id,person.given_name,person.family_name]);check();
 const audit=(await owner.query("SELECT * FROM hon.audit_events WHERE entity_id=$1 AND action_code='schedule.booking.create'",[adultRow.id])).rows[0];
 await mutate('UPDATE hon.audit_events SET entity_id=$2 WHERE id=$1',[audit.id,waitlisted.receipt.bookingId],'UPDATE hon.audit_events SET entity_id=$2 WHERE id=$1',[audit.id,adultRow.id]);
 const rowJson=(await owner.query('SELECT to_jsonb(b) value FROM hon.class_bookings b WHERE id=$1',[adultRow.id])).rows[0].value;
 await owner.query('DELETE FROM hon.class_bookings WHERE id=$1',[adultRow.id]);try{assert.deepEqual(await read(adultContext()),unavailable);}finally{await owner.query('INSERT INTO hon.class_bookings SELECT (jsonb_populate_record(NULL::hon.class_bookings,$1::jsonb)).*',[JSON.stringify(rowJson)]);}check();
 for(const permission of ['school.view','curriculum.progress.record','schedule.booking.manage','family.manage']){
  await owner.query('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2',[ownerRoleId,permission]);try{const c=permission==='family.manage'?childContext():adultContext();await assert.rejects(()=>read(c),status(403));await assert.rejects(()=>rawRead(c),e=>e.code==='42501');}finally{await owner.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[ownerRoleId,scope.organizationId,permission]);}
 }check();
 for(const [sql,args,restore,restoreArgs]of [
  ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[scope.organizationId],"UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[scope.organizationId]],
  ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1",[scope.schoolId],"UPDATE hon.schools SET status='ACTIVE' WHERE id=$1",[scope.schoolId]],
  ["UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1",[scope.organizationId],"UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1",[scope.organizationId]],
  ['UPDATE hon.principals SET is_active=false WHERE id=$1',[adultActor.principalId],'UPDATE hon.principals SET is_active=true WHERE id=$1',[adultActor.principalId]],
  ['UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[adultActor.grant],'UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[adultActor.grant]],
  ["UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()-interval '1s' WHERE id=$1",[adultActor.grant],'UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1',[adultActor.grant]],
  ["UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1s' WHERE organization_id=$1",[scope.organizationId],'UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1',[scope.organizationId]],
  ["UPDATE hon.roles SET code='PARENT' WHERE id=$1",[ownerRoleId],"UPDATE hon.roles SET code='FRONT_DESK' WHERE id=$1",[ownerRoleId]],
  ["INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_SUPPORT')",[adultActor.principalId],'DELETE FROM hon.hq_operator_grants WHERE principal_id=$1',[adultActor.principalId]],
  ["INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4)",[scope.organizationId,scope.schoolId,ids.family,adultActor.principalId],'DELETE FROM hon.family_access_grants WHERE family_id=$1 AND principal_id=$2',[ids.family,adultActor.principalId]],
 ]){await owner.query(sql,args);try{await assert.rejects(()=>read(adultContext()),status(403));await assert.rejects(()=>rawRead(adultContext()),e=>e.code==='42501');}finally{await owner.query(restore,restoreArgs);}}check();
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{source:'AUTOMATION'},{delegatedByPrincipalId:ids.principal},{actionRequestId:randomUUID()},{externalSubject:other.externalSubject},{principalId:ids.otherPrincipal},{schoolId:other.schoolId},{organizationId:other.organizationId}]){
  const c=context({...adultActor,...patch});await assert.rejects(()=>read(c),status(403));await assert.rejects(()=>rawRead(c),e=>e.code==='42501');
 }check();
 const tier=(await owner.query('SELECT tier FROM hon.organization_entitlements WHERE organization_id=$1',[scope.organizationId])).rows[0].tier;
 try{for(const value of ['ESSENTIAL','CORE','COMPLETE']){await owner.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[scope.organizationId,value]);assert.deepEqual(await read(adultContext()),expected);assert.deepEqual(await read(childContext()),childExpected);}}finally{await owner.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[scope.organizationId,tier]);}check();
 await owner.query("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()+interval '2 seconds' WHERE id=$1",[adultActor.grant]);
 await owner.query('BEGIN');await owner.query('LOCK TABLE hon.class_bookings IN SHARE ROW EXCLUSIVE MODE');
 try{const pending=assert.rejects(()=>read(adultContext()),status(403));await new Promise(resolve=>setTimeout(resolve,2200));await owner.query('ROLLBACK');await pending;}finally{await owner.query('ROLLBACK');await owner.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1',[adultActor.grant]);}check();
 await assert.rejects(()=>checked(()=>raw(adultContext(),'SELECT hon.read_owner_launch_first_class_booking_context($1,$2)',[adultActor.externalSubject,adultRow.id])),e=>e.code==='42883');
 for(const sql of ["ALTER FUNCTION hon.read_owner_launch_first_class_booking_context(text) SET statement_timeout TO '1s'",'ALTER FUNCTION hon.read_owner_launch_first_class_booking_context(text) SECURITY INVOKER',"CREATE FUNCTION hon.read_owner_launch_first_class_booking_context(text,uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$",'GRANT UPDATE(status) ON hon.class_bookings TO hon_owner_launch_runtime',"CREATE OR REPLACE FUNCTION hon.read_owner_launch_first_class_booking_context(p_subject text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$ BEGIN RETURN '{}'::jsonb; END $$"])await drift(sql);
 for(const table of ['student_registration_receipts','guardian_child_registration_receipts'])await assert.rejects(()=>runtime.query(`SELECT * FROM hon.${table}`),e=>e.code==='42501');
 assert.deepEqual(await read(adultContext()),expected);assert.deepEqual(await read(childContext()),childExpected);check();
 const latest=await checked(()=>service.register(adultContext(),{...adultSetup.target,givenName:'Latest unbooked adult '+randomUUID(),familyName:'Private newest',birthDate:'1990-02-03',attestation:'NEW_ADULT_NO_GUARDIAN_REQUIRED'}),adultEffects);
 assert.notEqual(latest.receipt.registrationId,adult.receipt.registrationId);assert.deepEqual(await read(adultContext()),empty);
 await checked(()=>service.registerGuardianChild(adultContext(),{...adultSetup.target,guardianGivenName:'Ambiguity guardian '+randomUUID(),guardianFamilyName:'Private guardian',guardianBirthDate:'1980-02-03',childGivenName:'Ambiguity child '+randomUUID(),childFamilyName:'Private child',childBirthDate:'2015-02-03',attestation:'NEW_CHILD_WITH_NEW_GUARDIAN'}),childEffects);
 assert.deepEqual(await read(adultContext()),unavailable);check();
 return groups;
}
