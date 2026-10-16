import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
/** Called only inside the marked, descriptor-bound, network-disabled owner proof. */
export async function proveOwnerLaunchGuardianChild({owner,runtime,database,service,programs,classes,scope,other,context,checked,raw,drift,ids,program,classSession,ownerRoleId}) {
 let groups=0; const check=()=>groups++; const status=n=>e=>e?.getStatus?.()===n;
 const effects=['people','families','family_members','student_profiles','student_curriculum_enrollments','guardian_child_registration_receipts','guardian_child_registration_outbox','audit_events'];
 const input=(patch={})=>({programId:program.id,expectedProgramVersion:program.version,classSessionId:classSession.id,expectedClassSessionVersion:classSession.version,guardianGivenName:'PII_CANARY guardian '+randomUUID(),guardianFamilyName:'Guardian '+randomUUID(),guardianBirthDate:'1980-02-03',childGivenName:'PII_CANARY child '+randomUUID(),childFamilyName:'Child '+randomUUID(),childBirthDate:'2015-02-03',attestation:'NEW_CHILD_WITH_NEW_GUARDIAN',...patch});
 const register=(v=input(),c=context())=>checked(()=>service.registerGuardianChild(c,v),effects);
 const value=input(),rc=context(),registered=await register(value,rc);
 assert.equal(registered.replayed,false); assert.equal(registered.receipt.status,'REGISTERED_NO_BOOKING'); assert.equal(registered.receipt.registrationKind,'NEW_CHILD_WITH_NEW_GUARDIAN'); assert(!JSON.stringify(registered).includes('PII_CANARY'));
 const record=(await owner.query('SELECT * FROM hon.guardian_child_registration_receipts WHERE id=$1',[registered.receipt.registrationId])).rows[0];
 const members=(await owner.query('SELECT person_id,member_role,is_billing_contact FROM hon.family_members WHERE family_id=$1 ORDER BY member_role',[record.family_id])).rows;
 assert.deepEqual(members,[{person_id:record.guardian_person_id,member_role:'GUARDIAN',is_billing_contact:false},{person_id:record.child_person_id,member_role:'STUDENT',is_billing_contact:false}]);
 const student=(await owner.query('SELECT person_id,primary_family_id,birth_date::text FROM hon.student_profiles WHERE id=$1',[record.student_profile_id])).rows[0];
 assert.deepEqual(student,{person_id:record.child_person_id,primary_family_id:record.family_id,birth_date:value.childBirthDate});
 assert.notEqual(record.guardian_person_id,record.child_person_id);
 assert.equal((await owner.query('SELECT count(*)::int count FROM hon.student_profiles WHERE person_id=$1',[record.guardian_person_id])).rows[0].count,0);
 const enrollment=(await owner.query('SELECT student_profile_id,program_id,curriculum_id,current_rank_id FROM hon.student_curriculum_enrollments WHERE id=$1',[record.enrollment_id])).rows[0];
 assert.deepEqual(enrollment,{student_profile_id:record.student_profile_id,program_id:program.id,curriculum_id:null,current_rank_id:null});check();
 assert.deepEqual((await checked(()=>service.registerGuardianChild(rc,value))),{receipt:registered.receipt,replayed:true});
 assert.deepEqual((await checked(()=>service.read(context()))).guardianChildRegistration,registered.receipt);
 await assert.rejects(()=>checked(()=>service.registerGuardianChild(rc,{...value,childGivenName:'Changed'})),status(409));
 await assert.rejects(()=>register(value),status(400));
 await assert.rejects(()=>register({...value,guardianGivenName:value.guardianGivenName.replaceAll(' ','-').toUpperCase()}),status(400));
 await assert.rejects(()=>register({...input(),childFamilyName:value.childFamilyName}),status(400));check();
 const concurrent=input(),concurrentContext=context();const replay=await checked(()=>Promise.all([service.registerGuardianChild(concurrentContext,concurrent),service.registerGuardianChild(concurrentContext,concurrent)]),effects);
 assert.deepEqual(replay[0].receipt,replay[1].receipt);assert.equal(replay.filter(r=>r.replayed).length,1);
 const potential=input(),duplicates=await checked(()=>Promise.allSettled([service.registerGuardianChild(context(),potential),service.registerGuardianChild(context(),potential)]),effects);
 assert.equal(duplicates.filter(r=>r.status==='fulfilled').length,1);assert.equal(duplicates.filter(r=>r.status==='rejected'&&r.reason.getStatus()===400).length,1);check();
 for(const patch of [{guardianBirthDate:'2015-01-01'},{childBirthDate:'1990-01-01'},{childBirthDate:'2999-01-01'},{guardianBirthDate:'1899-01-01'},{childBirthDate:'2026-02-30'},{childGivenName:'<private>'},{guardianGivenName:'---'},{guardianGivenName:'Same',guardianFamilyName:'Person',childGivenName:'s a m e',childFamilyName:'PERSON'},{attestation:'NEW_ADULT_NO_GUARDIAN_REQUIRED'},{guardians:[]},{children:[]},{familyId:ids.family},{guardianId:ids.principal},{parentLogin:true},{expectedProgramVersion:0},{expectedClassSessionVersion:1.5}])await assert.rejects(()=>register(input(patch)),status(400));
 // Raw function arguments are independently closed, not only TypeScript checked.
 for(const patch of [{guardianGivenName:null},{childBirthDate:null},{attestation:null},{guardianBirthDate:'2026-02-30'},{childFamilyName:''},{familyId:ids.family},{guardians:[]},{guardianGivenName:'Same',guardianFamilyName:'Person',childGivenName:'s a m e',childFamilyName:'PERSON'}]){const c=context();await assert.rejects(()=>checked(()=>raw(c,'SELECT hon.register_owner_launch_guardian_child($1,$2::jsonb,$3,$4,$5)',[c.externalSubject,JSON.stringify(input(patch)),c.idempotencyKey,c.requestId,c.correlationId])),e=>['22023','22007','22008'].includes(e.code));}check();
 for(const patch of [{expectedProgramVersion:2},{expectedClassSessionVersion:2},{programId:randomUUID()},{classSessionId:randomUUID()}])await assert.rejects(()=>register(input(patch)),status(patch.programId||patch.classSessionId?404:409));
 for(const [sql,args,restore]of [
  ["UPDATE hon.programs SET status='CANCELLED' WHERE id=$1",[program.id],"UPDATE hon.programs SET status='DRAFT' WHERE id=$1"],
  ["UPDATE hon.programs SET minimum_age_months=180 WHERE id=$1",[program.id],"UPDATE hon.programs SET minimum_age_months=NULL WHERE id=$1"],
  ["UPDATE hon.programs SET maximum_age_months=24 WHERE id=$1",[program.id],"UPDATE hon.programs SET maximum_age_months=NULL WHERE id=$1"],
  ["UPDATE hon.class_sessions SET status='CANCELLED',cancellation_reason='Local fixture cancellation' WHERE id=$1",[classSession.id],"UPDATE hon.class_sessions SET status='SCHEDULED',cancellation_reason=NULL WHERE id=$1"],
  ["UPDATE hon.class_sessions SET starts_at=clock_timestamp()-interval '1 day' WHERE id=$1",[classSession.id],"UPDATE hon.class_sessions SET starts_at=clock_timestamp()+interval '1 day' WHERE id=$1"]
 ]){await owner.query(sql,args);await assert.rejects(()=>register(),status(400));await owner.query(restore,args);}check();
 // Historical replay is not a current-version eligibility assertion.
 await owner.query('UPDATE hon.programs SET version=version+1 WHERE id=$1',[program.id]);
 assert.equal((await checked(()=>service.registerGuardianChild(rc,value))).replayed,true);await assert.rejects(()=>register(),status(409));await owner.query('UPDATE hon.programs SET version=version-1 WHERE id=$1',[program.id]);check();
 const classDate=(await owner.query("SELECT (starts_at AT TIME ZONE 'UTC')::date::text date FROM hon.class_sessions WHERE id=$1",[classSession.id])).rows[0].date;
 const cutoff=(await owner.query("SELECT ($1::date-interval '18 years')::date::text date",[classDate])).rows[0].date;
 await assert.rejects(()=>register(input({childBirthDate:cutoff})),status(400));
 const nextDay=(await owner.query("SELECT ($1::date+1)::text date",[cutoff])).rows[0].date;
 await register(input({guardianBirthDate:cutoff,childBirthDate:nextDay}));check();
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{source:'AUTOMATION'},{source:'API'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:ids.principal},{externalSubject:other.externalSubject},{schoolId:other.schoolId}])await assert.rejects(()=>register(input(),context(patch)),status(403));
 for(const patch of [{principalType:'AI_EMPLOYEE'},{source:'AI'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:ids.principal},{principalId:ids.otherPrincipal},{schoolId:other.schoolId},{externalSubject:other.externalSubject}]){const c=context(patch);await assert.rejects(()=>checked(()=>raw(c,'SELECT hon.register_owner_launch_guardian_child($1,$2::jsonb,$3,$4,$5)',[c.externalSubject,JSON.stringify(input()),c.idempotencyKey,c.requestId,c.correlationId])),e=>e.code==='42501');}check();
 for(const [sql,args,restore]of [
  ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[scope.organizationId],"UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1"],
  ["UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[ids.grant],"UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1"],
  ["UPDATE hon.principals SET is_active=false WHERE id=$1",[ids.principal],"UPDATE hon.principals SET is_active=true WHERE id=$1"],
  ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1",[scope.schoolId],"UPDATE hon.schools SET status='ACTIVE' WHERE id=$1"]
 ]){await owner.query(sql,args);await assert.rejects(()=>checked(()=>service.registerGuardianChild(rc,value)),status(403));await owner.query(restore,args);}check();
 for(const tier of ['ESSENTIAL','CORE','COMPLETE']){await owner.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[scope.organizationId,tier]);await register();}check();
 await owner.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_SUPPORT')",[ids.principal]);await assert.rejects(()=>register(),status(403));await owner.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1',[ids.principal]);
 await owner.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4)",[scope.organizationId,scope.schoolId,ids.family,ids.principal]);await assert.rejects(()=>register(),status(403));await owner.query('DELETE FROM hon.family_access_grants WHERE principal_id=$1',[ids.principal]);check();
 // No owner-label shortcut: deny ordinary staff without the EXACT additional permission.
 await owner.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='family.manage'",[ownerRoleId]);
 await assert.rejects(()=>checked(()=>service.registerGuardianChild(rc,value)),status(403));assert.equal((await checked(()=>service.read(context()))).guardianChildRegistration,null);
 // The adult command stays independent of family.manage.
 assert((await checked(()=>service.read(context()))).registration);
 await owner.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'family.manage')",[ownerRoleId,scope.organizationId]);check();
 // Hold a write-compatible IAM lock: initial SELECT succeeds, then SHARE waits.
 // Revoke authority in the blocker before release; post-lock reauthorization denies.
 await owner.query('BEGIN');let pending;
 try {
  await owner.query('LOCK TABLE hon.role_permissions IN ROW EXCLUSIVE MODE');
  pending=service.registerGuardianChild(context(),input());const rejected=assert.rejects(()=>pending,status(403));
  let waited=false;for(let i=0;i<100;i++){if((await owner.query("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.relation='hon.role_permissions'::regclass AND NOT l.granted AND a.usename='hon_owner_launch_runtime') waiting")).rows[0].waiting){waited=true;break;}await new Promise(r=>setTimeout(r,10));}assert(waited,'command must reach the IAM lock wait');
  await owner.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='family.manage'",[ownerRoleId]);await owner.query('COMMIT');await rejected;
 } finally {await owner.query('ROLLBACK');if(pending)await pending.catch(()=>{});await owner.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'family.manage') ON CONFLICT DO NOTHING",[ownerRoleId,scope.organizationId]);}check();
 for(const code of ['PARENT','GUARDIAN','HQ_SUPPORT','SYSTEM']) {
  await owner.query('UPDATE hon.roles SET code=$2 WHERE id=$1',[ownerRoleId,code]);
  try{await assert.rejects(()=>checked(()=>service.registerGuardianChild(rc,value)),status(403));}finally{await owner.query("UPDATE hon.roles SET code='FRONT_DESK' WHERE id=$1",[ownerRoleId]);}
 }check();
 // Time must be evaluated after an actual advisory wait, including on replay.
 for(const target of ['grant','entitlement']) {
  const table=target==='grant'?'principal_role_grants':'organization_entitlements',selector=target==='grant'?'id':'organization_id',id=target==='grant'?ids.grant:scope.organizationId;
  await owner.query(`UPDATE hon.${table} SET effective_until=clock_timestamp()+interval '1 second' WHERE ${selector}=$1`,[id]);
  await owner.query('BEGIN');let waiting;
  try{
   await owner.query("SELECT pg_advisory_xact_lock(hashtextextended('student.registration:'||$1||':'||$2,0))",[scope.organizationId,scope.schoolId]);
   waiting=service.registerGuardianChild(rc,value);const denied=assert.rejects(()=>waiting,status(403));
   let reached=false;for(let i=0;i<100;i++){if((await owner.query("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND NOT l.granted AND a.usename='hon_owner_launch_runtime') waiting")).rows[0].waiting){reached=true;break;}await new Promise(r=>setTimeout(r,10));}assert(reached,'replay must reach advisory wait before expiry');
   await new Promise(r=>setTimeout(r,1100));await owner.query('COMMIT');await denied;
  } finally {await owner.query('ROLLBACK');if(waiting)await waiting.catch(()=>{});await owner.query(`UPDATE hon.${table} SET effective_until=NULL WHERE ${selector}=$1`,[id]);}
 }check();
 // Independent second-school registration; no cross-school identity/family inference.
 const bc=context(other),bp=(await checked(()=>programs.create(bc,{name:'Other program '+randomUUID()}),['programs','idempotency_records','audit_events','outbox_events'])).program;
 const bs=(await checked(()=>classes.create(context(other),{programId:bp.id,name:'Other class',startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString(),capacity:10,bookingPolicy:'OPTIONAL_BOOKING'}),['class_sessions','idempotency_records','audit_events','outbox_events'])).classSession;
 const bvalue={...value,programId:bp.id,expectedProgramVersion:bp.version,classSessionId:bs.id,expectedClassSessionVersion:bs.version};const br=await register(bvalue,context(other));
 await assert.rejects(()=>register(input({programId:bp.id})),status(404));await assert.rejects(()=>register(input({classSessionId:bs.id})),status(404));
 assert.notEqual(br.receipt.familyId,registered.receipt.familyId);
 assert.deepEqual((await checked(()=>service.read(context(other)))).guardianChildRegistration,br.receipt);check();
 const extra=(await checked(()=>programs.create(context(),{name:'Mismatched program '+randomUUID()}),['programs','idempotency_records','audit_events','outbox_events'])).program;
 await assert.rejects(()=>register(input({programId:extra.id})),status(404));check();
 // Composite graph protection proves both family and exact school/class/enrollment links.
 for(const patch of [{family_id:br.receipt.familyId},{guardian_person_id:record.child_person_id},{child_member_id:record.guardian_member_id},{student_profile_id:br.receipt.studentProfileId},{enrollment_id:br.receipt.enrollmentId},{class_session_id:bs.id}]){
  await owner.query('BEGIN');try{await assert.rejects(()=>owner.query("INSERT INTO hon.guardian_child_registration_receipts SELECT (jsonb_populate_record(NULL::hon.guardian_child_registration_receipts,to_jsonb(r)||jsonb_build_object('id',gen_random_uuid(),'idempotency_digest','\\x'||encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'))||$2::jsonb)).* FROM hon.guardian_child_registration_receipts r WHERE id=$1",[record.id,JSON.stringify(patch)]),e=>['23503','23514'].includes(e.code));}finally{await owner.query('ROLLBACK');}
 }
 for(const sql of ['ALTER TABLE hon.guardian_child_registration_receipts DROP CONSTRAINT child_registration_guardian_fk','ALTER TABLE hon.guardian_child_registration_receipts DROP CONSTRAINT child_registration_child_fk','ALTER TABLE hon.guardian_child_registration_receipts DROP CONSTRAINT child_registration_student_family_fk','ALTER TABLE hon.guardian_child_registration_outbox DROP CONSTRAINT guardian_child_registration_outbox_state_check'])await drift(sql);check();
 for(const target of ['audit','outbox']){
  const table=target==='audit'?'audit_events':'guardian_child_registration_outbox';
  const condition=target==='audit'?"IF NEW.action_code='student.guardian_child.register' THEN RAISE EXCEPTION 'FIXTURE_ATOMICITY_FAILURE'; END IF;":"RAISE EXCEPTION 'FIXTURE_ATOMICITY_FAILURE';";
  await owner.query(`CREATE FUNCTION hon.fixture_fail_child_registration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${condition} RETURN NEW; END $$; CREATE TRIGGER fixture_child_registration BEFORE INSERT ON hon.${table} FOR EACH ROW EXECUTE FUNCTION hon.fixture_fail_child_registration()`);
  try{await assert.rejects(()=>register(),status(503));}finally{await owner.query(`DROP TRIGGER fixture_child_registration ON hon.${table}; DROP FUNCTION hon.fixture_fail_child_registration()`);}
 }check();
 const counts=(await owner.query("SELECT (SELECT count(*)::int FROM hon.guardian_child_registration_receipts) receipts,(SELECT count(*)::int FROM hon.guardian_child_registration_outbox WHERE state='INERT') facts,(SELECT count(*)::int FROM hon.audit_events WHERE action_code='student.guardian_child.register') audits")).rows[0];assert.equal(counts.receipts,counts.facts);assert.equal(counts.receipts,counts.audits);
 const evidence=(await owner.query("SELECT r.receipt,a.next_state,o.event_code,o.state FROM hon.guardian_child_registration_receipts r JOIN hon.audit_events a ON a.entity_id=r.id AND a.action_code='student.guardian_child.register' JOIN hon.guardian_child_registration_outbox o ON o.registration_id=r.id")).rows;
 for(const row of evidence){assert.deepEqual(row.receipt,row.next_state);assert(!JSON.stringify(row).includes('PII_CANARY'));assert.equal(row.state,'INERT');}
 for(const table of ['guardian_child_registration_receipts','guardian_child_registration_outbox'])for(const sql of [`UPDATE hon.${table} SET school_id=school_id`,`DELETE FROM hon.${table}`,`TRUNCATE hon.${table} CASCADE`]){await owner.query('BEGIN');try{await assert.rejects(()=>owner.query(sql),e=>e.code==='42501');}finally{await owner.query('ROLLBACK');}}check();
 // No principal/session/access/contact model was created for either person.
 assert.equal((await owner.query('SELECT count(*)::int count FROM hon.family_access_grants WHERE family_id IN(SELECT family_id FROM hon.guardian_child_registration_receipts)')).rows[0].count,0);
 assert.equal((await owner.query('SELECT count(*)::int count FROM hon.people WHERE id IN(SELECT guardian_person_id FROM hon.guardian_child_registration_receipts UNION SELECT child_person_id FROM hon.guardian_child_registration_receipts) AND (email IS NOT NULL OR phone_e164 IS NOT NULL)')).rows[0].count,0);
 // Private helper is never a runtime function grant, even with forged correct GUCs.
 const c=context();await assert.rejects(()=>raw(c,'SELECT hon.require_owner_launch_family_actor($1)',[c.externalSubject]),e=>e.code==='42501');check();
 return groups;
}
