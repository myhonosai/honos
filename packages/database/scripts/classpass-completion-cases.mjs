import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ParentClassPassViewService } from '../../../apps/api/dist/families/parent-classpass-view.service.js';
export async function testClassPassCompletionCases({admin,runtime,db,ids,ctx,command,deny,read,issue,student,session,snapshot,product}) {
  let groups=0;
  // A historical seed is a complete immutable snapshot + matching issuance
  // ledger, not an illegal UPDATE of issued_at/expires_at or a disabled trigger.
  const template=await issue(product,await student(),2);
  const expired=randomUUID(),request=randomUUID();
  await admin.query(`INSERT INTO hon.classpass_passes SELECT
   $1::uuid,organization_id,school_id,product_id,student_profile_id,program_id,issuance_kind,product_version,product_name,
   allowed_uses,validity_days,allowed_booking_policy,program_version,program_name,program_status,minimum_age_months,maximum_age_months,
   now()-interval '60 days',now()-interval '60 days'+validity_days*interval '24 hours',issued_by_principal_id,allowed_uses,'ACTIVE',1,updated_at
   FROM hon.classpass_passes WHERE id=$2`,[expired,template.id]);
  // now() supplies the same historical instant for both snapshot timestamps.
  await admin.query(`INSERT INTO hon.classpass_ledger(organization_id,school_id,pass_id,kind,use_delta,pass_version,reason,actor_principal_id,request_id,recorded_at)
   SELECT organization_id,school_id,id,'ISSUANCE',allowed_uses,1,'Historical local allowance',issued_by_principal_id,$2,issued_at FROM hon.classpass_passes WHERE id=$1`,[expired,request]);
  assert.equal((await read('PASS',expired)).expired,true);
  await deny('ADMIT',await session(),{expectedVersion:1,passId:expired});
  await deny('REVERSE_ISSUANCE',expired,{expectedVersion:1,reason:'Expired allowance is not reversible'});groups++;

  // Expired, previously redeemed pass: historical session/booking and both
  // issuance/debit evidence agree; expiry must also deny redemption reversal.
  const expiredUsed=randomUUID(),historicalBooking=randomUUID(),historicalSession=await session({starts:new Date(Date.now()-59*86400000),ends:new Date(Date.now()-59*86400000+3600000)});
  await admin.query(`INSERT INTO hon.classpass_passes SELECT
   $1::uuid,organization_id,school_id,product_id,student_profile_id,program_id,issuance_kind,product_version,product_name,
   allowed_uses,validity_days,allowed_booking_policy,program_version,program_name,program_status,minimum_age_months,maximum_age_months,
   now()-interval '60 days',now()-interval '60 days'+validity_days*interval '24 hours',issued_by_principal_id,allowed_uses-1,'ACTIVE',2,updated_at
   FROM hon.classpass_passes WHERE id=$2`,[expiredUsed,template.id]);
  await admin.query('BEGIN');
  try {
   await admin.query("SELECT set_config('app.hon_classpass_write','on',true)");
   await admin.query(`INSERT INTO hon.class_bookings(id,organization_id,school_id,class_session_id,student_profile_id,booking_kind,classpass_id,status,source)
    SELECT $2,organization_id,school_id,$3,student_profile_id,'CLASS_PASS',id,'BOOKED','STAFF' FROM hon.classpass_passes WHERE id=$1`,[expiredUsed,historicalBooking,historicalSession]);
   await admin.query('COMMIT');
  } catch(e){await admin.query('ROLLBACK');throw e;}
  await admin.query(`INSERT INTO hon.classpass_ledger(organization_id,school_id,pass_id,kind,use_delta,pass_version,reason,actor_principal_id,request_id,recorded_at)
   SELECT organization_id,school_id,id,'ISSUANCE',allowed_uses,1,'Historical local allowance',issued_by_principal_id,$2,issued_at FROM hon.classpass_passes WHERE id=$1`,[expiredUsed,randomUUID()]);
  await admin.query(`INSERT INTO hon.classpass_ledger(organization_id,school_id,pass_id,kind,use_delta,class_booking_id,pass_version,actor_principal_id,request_id,recorded_at)
   SELECT organization_id,school_id,id,'REDEMPTION',-1,$2,2,issued_by_principal_id,$3,issued_at+interval '1 day' FROM hon.classpass_passes WHERE id=$1`,[expiredUsed,historicalBooking,randomUUID()]);
  await deny('REVERSE_REDEMPTION',historicalBooking,{expectedVersion:2,passId:expiredUsed,reason:'Expired redemption cannot restore'});
  await deny('ADMIT',await session(),{expectedVersion:2,passId:expiredUsed});
  assert.equal((await read('PASS',expiredUsed)).ledger.length,2);groups++;

  const singleProduct=randomUUID();
  await command('CONFIGURE_PRODUCT',singleProduct,{expectedVersion:0,programId:ids.program,name:'Final use allowance',allowedUses:1,validityDays:30,reason:'Local final-use case'});
  const single=await issue(singleProduct,await student()),singleSession=await session();
  const final=await command('ADMIT',singleSession,{expectedVersion:1,passId:single.id});
  assert.equal(final.status,'EXHAUSTED');assert.equal(final.remainingUses,0);assert.equal(final.version,2);
  assert.deepEqual((await read('PASS',single.id)).ledger.map(l=>l.useDelta),[1,-1]);
  await deny('ADMIT',await session(),{expectedVersion:2,passId:single.id});
  await deny('REVERSE_ISSUANCE',single.id,{expectedVersion:2,reason:'Final-use issuance cannot be reversed'});
  const restore=await command('REVERSE_REDEMPTION',final.booking.id,{expectedVersion:2,passId:single.id,reason:'Before-start correction'});
  assert.equal(restore.status,'ACTIVE');assert.equal(restore.remainingUses,1);assert.equal(restore.version,3);
  await deny('REVERSE_REDEMPTION',final.booking.id,{expectedVersion:3,passId:single.id,reason:'No duplicate restoration'});
  assert.deepEqual((await read('PASS',single.id)).ledger.map(l=>l.useDelta),[1,-1,1]);groups++;

  const parentUser=randomUUID(),parentPrincipal=randomUUID(),parentSubject=`classpass-parent-${randomUUID()}`,parentGrant=randomUUID();
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$1::uuid::text||'@example.test','Private guardian')",[parentUser,parentSubject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Guardian')",[parentPrincipal,parentUser]);
  await admin.query("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,'PRIMARY_GUARDIAN',$6)",[parentGrant,ids.org,ids.school,ids.family,parentPrincipal,ids.principal]);
  const visible=await student(),hidden=await student(),suspended=await student();
  for(const [id,role,name]of[[visible,'STUDENT','Authorized child'],[hidden,'OTHER','HIDDEN_OTHER_CHILD'],[suspended,'STUDENT','HIDDEN_SUSPENDED_CHILD']]) {
    await admin.query('UPDATE hon.people SET given_name=$2,family_name=\'\' WHERE id=(SELECT person_id FROM hon.student_profiles WHERE id=$1)',[id,name]);
    await admin.query('INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) SELECT organization_id,school_id,$2,person_id,$3::hon.family_member_role FROM hon.student_profiles WHERE id=$1',[id,ids.family,role]);
    await admin.query('UPDATE hon.student_profiles SET primary_family_id=$2 WHERE id=$1',[id,ids.family]);
  }
  const vp=await issue(singleProduct,visible),hp=await issue(singleProduct,hidden),sp=await issue(singleProduct,suspended),parentSession=await session({capacity:1});
  const visibleAdmission=await command('ADMIT',parentSession,{expectedVersion:1,passId:vp.id});
  const hiddenWait=await command('ADMIT',parentSession,{expectedVersion:1,passId:hp.id});assert.equal(hiddenWait.decision,'WAITLISTED_NOT_REDEEMED');
  await admin.query("UPDATE hon.student_profiles SET status='SUSPENDED' WHERE id=$1",[suspended]);
  const service=new ParentClassPassViewService(db);
  async function parentRead(){const before=await snapshot();const result=await service.get(parentSubject);assert.deepEqual(await snapshot(),before);return result.data;}
  let view=await parentRead();assert.equal(view.paymentProviderOutcome,'UNAVAILABLE');assert.equal(view.children.items.length,1);
  assert.equal(view.children.items[0].displayName,'Authorized child');assert.equal(view.children.items[0].passes.items[0].status,'EXHAUSTED');
  assert.deepEqual(view.children.items[0].passes.items[0].bookings.items.map(b=>[b.bookingStatus,b.redemptionOutcome,b.attendanceState]),[['BOOKED','REDEEMED','NOT_RECORDED']]);
  // Existing canonical attendance is observable, never created by ClassPass.
  const {AttendanceService}=await import('../../../apps/api/dist/schedule/attendance.service.js');
  await new AttendanceService(db).record(ctx(),parentSession,{studentProfileId:visible,status:'PRESENT',category:'GUEST_DROP_IN'});
  view=await parentRead();assert.equal(view.children.items[0].passes.items[0].bookings.items[0].attendanceState,'PRESENT');
  await deny('REVERSE_REDEMPTION',visibleAdmission.booking.id,{expectedVersion:2,passId:vp.id,reason:'Exhausted attended pass cannot restore'});
  const encoded=JSON.stringify(view);for(const secret of[hp.id,sp.id,parentPrincipal,ids.school,ids.family,'HIDDEN_OTHER_CHILD','HIDDEN_SUSPENDED_CHILD','studentProfileId','ledger','actorPrincipalId','requestId','programName'])assert(!encoded.includes(secret));groups++;
  // Foreign and forged GUCs do not select a family, school, child or pass.
  const before=await snapshot();await runtime.query('BEGIN READ ONLY');
  try {
    assert.equal((await runtime.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
    await runtime.query("SELECT set_config('app.hon_school_id',$1,true),set_config('app.hon_organization_id',$2,true),set_config('app.hon_principal_id',$3,true)",[ids.otherSchool,ids.otherOrg,ids.principal]);
    const raw=(await runtime.query('SELECT hon.read_parent_classpass_view($1) data',[parentSubject])).rows[0].data;assert.deepEqual(raw.children,view.children);
    for(const table of['classpass_products','classpass_passes','classpass_ledger']) {
      await runtime.query('SAVEPOINT denied');await assert.rejects(()=>runtime.query(`SELECT * FROM hon.${table}`),e=>e.code==='42501'||e.code==='P0001');await runtime.query('ROLLBACK TO SAVEPOINT denied');
    }
  } finally {await runtime.query('ROLLBACK');}
  assert.deepEqual(await snapshot(),before);
  const parentCtx=ctx({principalId:parentPrincipal,externalSubject:parentSubject});
  await assert.rejects(()=>read('PASS',vp.id,parentCtx),e=>e.getStatus?.()===403);
  await deny('ADMIT',await session(),{expectedVersion:2,passId:vp.id},parentCtx,403);groups++;
  // Revocation, VIEWER, inactive topology and multi-family ambiguity fail closed.
  for(const [sql,restore,args]of[
    ["UPDATE hon.family_access_grants SET access_level='VIEWER' WHERE id=$1","UPDATE hon.family_access_grants SET access_level='SECONDARY_GUARDIAN' WHERE id=$1",[parentGrant]],
    ["UPDATE hon.family_access_grants SET effective_from=now()-interval '2 days',effective_until=now()-interval '1 day' WHERE id=$1","UPDATE hon.family_access_grants SET effective_until=NULL WHERE id=$1",[parentGrant]],
    ["UPDATE hon.families SET status='SUSPENDED' WHERE id=$1","UPDATE hon.families SET status='ACTIVE' WHERE id=$1",[ids.family]],
    ['UPDATE hon.principals SET is_active=false WHERE id=$1','UPDATE hon.principals SET is_active=true WHERE id=$1',[parentPrincipal]],
  ]) {await admin.query(sql,args);await assert.rejects(()=>service.get(parentSubject),e=>e.getStatus?.()===403);await assert.rejects(()=>runtime.query('SELECT hon.read_parent_classpass_view($1)',[parentSubject]),e=>e.code==='42501');await admin.query(restore,args);}
  assert.equal((await parentRead()).accessLevel,'SECONDARY_GUARDIAN');
  const secondFamily=randomUUID();await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Other private family')",[secondFamily,ids.org,ids.school]);
  await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$5)",[ids.org,ids.school,secondFamily,parentPrincipal,ids.principal]);
  await assert.rejects(()=>service.get(parentSubject),e=>e.getStatus?.()===409);await assert.rejects(()=>runtime.query('SELECT hon.read_parent_classpass_view($1)',[parentSubject]),e=>e.code==='42501');
  await admin.query('DELETE FROM hon.family_access_grants WHERE family_id=$1',[secondFamily]);groups++;
  // Fixed output caps are enforced by SQL, not just the client verifier.
  for(let i=0;i<21;i++){const child=await student();await admin.query("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) SELECT organization_id,school_id,$2,person_id,'STUDENT' FROM hon.student_profiles WHERE id=$1",[child,ids.family]);}
  view=await parentRead();assert.equal(view.children.items.length,20);assert.equal(view.children.limited,true);groups++;
  return groups;
}
