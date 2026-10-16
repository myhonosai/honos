import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { retentionAttentionTables as privateTables, retentionAttentionFunctions as functions, verifyRetentionAttentionSecurity } from './retention-attention-security.mjs';

/** Extension of the descriptor-bound acknowledgement fixture, not a new remote harness. */
export async function proveRetentionAttention({ owner, runtime, service, ids, context, other, checked, snapshot, raw, fixtureOwnerContext }) {
  let groups=0, probes=0; const check=()=>groups++, status=n=>e=>e?.getStatus?.()===n;
  const allowed=[...privateTables,'audit_events'];
  const evidence=(c=context(),membership=ids.membership)=>checked(()=>service.attentionEvidence(c,membership));
  const read=(c=context(),membership=ids.membership)=>checked(()=>service.attentionAlerts(c,membership));
  const input=e=>({evidenceVersion:e.evidenceVersion,evidenceFingerprint:e.evidenceFingerprint,observedAt:e.signals.observedAt,evidenceCode:e.attentionCodes[0],idempotencyKey:randomUUID()});
  const record=(value,c=context(),membership=ids.membership)=>checked(()=>service.recordAttention(c,membership,value),allowed);
  const resolve=(value,c=context(),membership=ids.membership)=>checked(()=>service.resolveAttention(c,membership,value),allowed);
  const resolution=a=>({alertId:a.alertId,expectedAlertVersion:1,resolutionReason:'REVIEW_COMPLETED',idempotencyKey:randomUUID()});
  const rawRecord=(c,v,m=ids.membership)=>raw(c,'SELECT hon.record_retention_attention_alert($1,$2,$3,$4,$5,$6,$7,$8,$9)',[c.externalSubject,m,v.evidenceVersion,v.evidenceFingerprint,v.observedAt,v.evidenceCode,v.idempotencyKey,c.requestId,c.correlationId]);
  const rawResolve=(c,v,m=ids.membership)=>raw(c,'SELECT hon.resolve_retention_attention_alert($1,$2,$3,$4,$5,$6,$7,$8)',[c.externalSubject,m,v.alertId,v.expectedAlertVersion,v.resolutionReason,v.idempotencyKey,c.requestId,c.correlationId]);
  const rawRead=c=>raw(c,'SELECT hon.read_retention_attention_alerts($1,$2)',[c.externalSubject,ids.membership]);
  const rawEvidence=c=>raw(c,'SELECT hon.read_retention_attention_evidence($1,$2)',[c.externalSubject,ids.membership]);
  const counts=async alert=>(await owner.query(`SELECT
    (SELECT count(*)::int FROM hon.retention_attention_alerts WHERE id=$1) roots,
    (SELECT count(*)::int FROM hon.retention_attention_record_receipts WHERE alert_id=$1) record_receipts,
    (SELECT count(*)::int FROM hon.retention_attention_resolutions WHERE alert_id=$1) resolutions,
    (SELECT count(*)::int FROM hon.retention_attention_resolution_receipts WHERE alert_id=$1) resolution_receipts,
    (SELECT count(*)::int FROM hon.retention_attention_outbox WHERE alert_id=$1 AND state='INERT') inert_outbox,
    (SELECT count(*)::int FROM hon.audit_events WHERE entity_id=$1 AND action_code IN('retention.review.alert.record','retention.review.alert.resolve')) audits`,[alert])).rows[0];
  const expectation=(records=1,resolved=0)=>({roots:1,record_receipts:records,resolutions:resolved,resolution_receipts:resolved,inert_outbox:1+resolved,audits:1+resolved});
  await verifyRetentionAttentionSecurity(owner,'hon_retention_acknowledgement_runtime');check();
  for(const table of privateTables) {
    for(const drift of [`GRANT SELECT ON hon.${table} TO hon_retention_acknowledgement_runtime`,`GRANT SELECT(id) ON hon.${table} TO PUBLIC`,`ALTER TABLE hon.${table} NO FORCE ROW LEVEL SECURITY`,`ALTER TABLE hon.${table} DISABLE ROW LEVEL SECURITY`,`CREATE POLICY attention_drift ON hon.${table} USING(true)`,`ALTER TABLE hon.${table} DISABLE TRIGGER retention_attention_immutable`,`ALTER TABLE hon.${table} DISABLE TRIGGER retention_attention_no_truncate`,`ALTER TABLE hon.${table} ADD COLUMN private_note text`]) {
      await owner.query('BEGIN');try { await owner.query(drift);await assert.rejects(()=>verifyRetentionAttentionSecurity(owner,'hon_retention_acknowledgement_runtime'));probes++; } finally { await owner.query('ROLLBACK'); }
    }
    for(const sql of [`SELECT * FROM hon.${table}`,`INSERT INTO hon.${table}(id) VALUES(gen_random_uuid())`,`UPDATE hon.${table} SET id=id`,`DELETE FROM hon.${table}`,`TRUNCATE hon.${table}`]) await assert.rejects(()=>runtime.query(sql),e=>e.code==='42501');
    await owner.query('BEGIN');try { await owner.query(`GRANT SELECT ON hon.${table} TO hon_retention_acknowledgement_runtime`);await owner.query('SET LOCAL ROLE hon_retention_acknowledgement_runtime');assert.deepEqual((await owner.query(`SELECT * FROM hon.${table}`)).rows,[]); } finally { await owner.query('ROLLBACK'); }
  }check();
  for(const [signature,executable] of functions) for(const drift of [`GRANT EXECUTE ON FUNCTION hon.${signature} TO PUBLIC`,`GRANT EXECUTE ON FUNCTION hon.${signature} TO hon_retention_acknowledgement_runtime WITH GRANT OPTION`,...(executable?[`REVOKE EXECUTE ON FUNCTION hon.${signature} FROM hon_retention_acknowledgement_runtime`]:[])]) {
    await owner.query('BEGIN');try {await owner.query(drift);await assert.rejects(()=>verifyRetentionAttentionSecurity(owner,'hon_retention_acknowledgement_runtime'));probes++;}finally{await owner.query('ROLLBACK');}
  }
  for(const drift of ['ALTER TABLE hon.retention_attention_alerts DROP CONSTRAINT retention_attention_natural_key','ALTER TABLE hon.retention_attention_resolutions DROP CONSTRAINT retention_attention_resolutions_alert_id_key']) {
    await owner.query('BEGIN');try {await owner.query(drift);await assert.rejects(()=>verifyRetentionAttentionSecurity(owner,'hon_retention_acknowledgement_runtime'));probes++;}finally{await owner.query('ROLLBACK');}
  }check();
  // No new permission is accidentally mapped to another system role.
  assert.equal((await owner.query("SELECT count(*)::int n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.is_system_role AND r.code<>'OWNER' AND rp.permission_code LIKE 'retention.review.alert.%'")).rows[0].n,0);check();
  const secondUser=randomUUID(),secondPrincipal=randomUUID(),secondGrant=randomUUID(),secondSubject='attention-peer-'+randomUUID();
  await owner.query('BEGIN');
  await owner.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$1::uuid::text||'@example.test','PII_CANARY_PEER')",[secondUser,secondSubject]);
  await owner.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','PII_CANARY_PEER')",[secondPrincipal,secondUser]);
  await owner.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$6)',[secondGrant,ids.org,ids.school,secondPrincipal,ids.role,ids.principal]);
  await owner.query('COMMIT');
  const peer=context({principalId:secondPrincipal,externalSubject:secondSubject});
  const originalTerm=(await owner.query('SELECT term_ends_at FROM hon.memberships WHERE id=$1',[ids.membership])).rows[0].term_ends_at;
  // Original membership has no negative attendance fact and an explicit renewal review.
  assert.deepEqual((await evidence()).attentionCodes,[]);assert.deepEqual((await read()).alerts,[]);check();
  await owner.query("UPDATE hon.memberships SET term_ends_at=clock_timestamp()+interval '10 days',version=version+1 WHERE id=$1",[ids.membership]);
  const e=await evidence(),value=input(e);assert.deepEqual(e.attentionCodes,['TERM_ENDING_WITHIN_30_DAYS']);assert(!JSON.stringify(e).includes('PII_CANARY'));
  const a=await record(value);assert.equal(a.state,'OPEN');assert.deepEqual(await checked(()=>service.recordAttention(context(),ids.membership,value)),a);assert.deepEqual(await counts(a.alertId),expectation());check();
  for(const patch of [{evidenceCode:'INVENTED_RISK'},{note:'private'},{evidenceVersion:'V2'},{idempotencyKey:'text'},{observedAt:'bad'}])await assert.rejects(()=>record({...value,...patch}),status(400));
  await assert.rejects(()=>record({...value,evidenceCode:'UNEXCUSED_ABSENCE_RECORDED',idempotencyKey:randomUUID()}),status(409));
  for(const patch of [{evidenceFingerprint:'0'.repeat(64)},{observedAt:new Date(Date.now()-360_000).toISOString()},{observedAt:new Date(Date.now()+60_000).toISOString()}])await assert.rejects(()=>record({...value,...patch}),status(409));check();
  await new Promise(r=>setTimeout(r,5));const same=input(await evidence());
  const sameOutputs=await checked(()=>Promise.all([service.recordAttention(context(),ids.membership,same),service.recordAttention(context(),ids.membership,same)]),allowed);
  assert.deepEqual(sameOutputs[0],sameOutputs[1]);assert.deepEqual(await counts(sameOutputs[0].alertId),expectation());check();
  // Force TWO distinct qualified humans to wait on the same actor-free natural key.
  await new Promise(r=>setTimeout(r,5));const distinct=input(await evidence()),otherKey={...distinct,idempotencyKey:randomUUID()};const before=await snapshot();
  await owner.query('BEGIN');await owner.query(`SELECT pg_advisory_xact_lock(hashtextextended('retention.attention.evidence:'||jsonb_build_array($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::text,to_char($7::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text,0))`,[ids.org,ids.school,ids.membership,distinct.evidenceCode,distinct.evidenceVersion,distinct.evidenceFingerprint,distinct.observedAt]);
  const pending=Promise.all([service.recordAttention(context(),ids.membership,distinct),service.recordAttention(peer,ids.membership,otherKey)]);pending.catch(()=>{});
  try { let waiting=0;const deadline=Date.now()+2000;do {
    waiting=(await owner.query("SELECT count(DISTINCT waiter.pid)::int n FROM pg_locks holder JOIN pg_locks waiter ON waiter.locktype=holder.locktype AND waiter.database=holder.database AND waiter.classid=holder.classid AND waiter.objid=holder.objid AND waiter.objsubid=holder.objsubid WHERE holder.locktype='advisory' AND holder.pid=pg_backend_pid() AND holder.granted AND NOT waiter.granted")).rows[0].n;
    if(waiting!==2)await new Promise(r=>setTimeout(r,20));
  }while(waiting!==2&&Date.now()<deadline);assert.equal(waiting,2,'Both human requests must contend on school-wide evidence'); }finally{await owner.query('COMMIT');}
  const outputs=await pending;assert.deepEqual(outputs[0],outputs[1]);const after=await snapshot();for(const table of Object.keys(before))if(!allowed.includes(table))assert.equal(after[table],before[table],table);
  const shared=outputs[0];assert.deepEqual(await counts(shared.alertId),expectation(2));
  assert.deepEqual(await checked(()=>service.recordAttention(context(),ids.membership,distinct)),shared);
  assert.deepEqual(await checked(()=>service.recordAttention(peer,ids.membership,otherKey)),shared);
  assert.deepEqual(await checked(()=>service.recordAttention(context(),ids.membership,{...distinct,idempotencyKey:randomUUID()}),['retention_attention_record_receipts']),shared);
  assert.deepEqual(await counts(shared.alertId),expectation(3));check();
  const changedKeyObservation=input(await evidence());await assert.rejects(()=>record({...changedKeyObservation,idempotencyKey:value.idempotencyKey}),status(409));check();
  const r=resolution(shared),resolved=await resolve(r);assert.equal(resolved.state,'RESOLVED');assert.equal(resolved.alertVersion,2);
  assert.deepEqual(await checked(()=>service.resolveAttention(context(),ids.membership,r)),resolved);assert.deepEqual(await counts(shared.alertId),expectation(3,1));
  await assert.rejects(()=>resolve({...r,idempotencyKey:randomUUID()}),status(409));await assert.rejects(()=>resolve({...r,resolutionReason:'EVIDENCE_CHANGED'}),status(409));
  for(const patch of [{expectedAlertVersion:2},{expectedAlertVersion:0},{resolutionReason:'CONTACT_SUCCEEDED'},{note:'private'}])await assert.rejects(()=>resolve({...r,...patch}),status(400));
  assert.deepEqual(await checked(()=>service.recordAttention(context(),ids.membership,distinct)),shared,'Creation receipt remains immutable after resolution');
  assert.deepEqual((await read()).alerts.find(alert=>alert.alertId===shared.alertId),resolved);assert(!JSON.stringify(resolved).includes('PII_CANARY'));check();
  const sr=resolution(sameOutputs[0]);const resolutionOutputs=await checked(()=>Promise.all([service.resolveAttention(context(),ids.membership,sr),service.resolveAttention(context(),ids.membership,sr)]),allowed);assert.deepEqual(resolutionOutputs[0],resolutionOutputs[1]);assert.deepEqual(await counts(sr.alertId),expectation(1,1));check();
  // Different humans/keys cannot resolve an exact open version twice.
  const ar=resolution(a),otherResolution={...ar,idempotencyKey:randomUUID()};
  const racing=await checked(()=>Promise.allSettled([service.resolveAttention(context(),ids.membership,ar),service.resolveAttention(peer,ids.membership,otherResolution)]),allowed);
  assert.equal(racing.filter(x=>x.status==='fulfilled').length,1);const loser=racing.find(x=>x.status==='rejected');assert.equal(loser.reason.getStatus(),409);assert.deepEqual(await counts(a.alertId),expectation(1,1));check();
  // Two schools plus sibling-school/foreign alert/membership mismatches fail closed.
  const foreignEvidence=await evidence(other,ids.otherMembership);assert.deepEqual(foreignEvidence.attentionCodes,['RENEWAL_REVIEW_NOT_RECORDED']);const foreign=await record(input(foreignEvidence),other,ids.otherMembership);
  await assert.rejects(()=>read(context(),ids.otherMembership),status(404));await assert.rejects(()=>evidence(context(),ids.otherMembership),status(404));
  await assert.rejects(()=>resolve(resolution(foreign)),status(404));await assert.rejects(()=>resolve(r,other,ids.otherMembership),status(404));await assert.rejects(()=>read(context({schoolId:ids.siblingSchool})),status(403));check();
  for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{principalType:'SYSTEM_SERVICE'},{principalType:'PARENT'},{source:'AI'},{source:'AUTOMATION'},{source:'PUBLIC_API'},{source:'HQ_SUPPORT'},{externalSubject:'spoof'},{principalId:randomUUID()},{schoolId:ids.otherSchool},{organizationId:ids.otherOrg},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]) {
    const c=context(patch);
    for(const work of [()=>read(c),()=>evidence(c),()=>record(value,c),()=>resolve(r,c)])await assert.rejects(work,status(403));
    for(const work of [()=>rawRead(c),()=>rawEvidence(c),()=>rawRecord(c,value),()=>rawResolve(c,r)])await assert.rejects(()=>checked(work),e=>e.code==='42501');
  }check();
  for(const permission of ['retention.review.alert.read','retention.review.alert.record','retention.review.alert.resolve','retention.review.read']) {
    await owner.query('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2',[ids.role,permission]);
    if(permission==='retention.review.alert.read'||permission==='retention.review.read')await assert.rejects(()=>read(),status(403));else await read();
    if(permission==='retention.review.alert.record'||permission==='retention.review.read'){await assert.rejects(()=>evidence(),status(403));await assert.rejects(()=>record(value),status(403));}else{await evidence();assert.deepEqual(await checked(()=>service.recordAttention(context(),ids.membership,value)),a);}
    if(permission==='retention.review.alert.resolve'||permission==='retention.review.read')await assert.rejects(()=>resolve(r),status(403));else assert.deepEqual(await checked(()=>service.resolveAttention(context(),ids.membership,r)),resolved);
    await owner.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[ids.role,ids.org,permission]);
  }check();
  for(const tier of ['ESSENTIAL','CORE','COMPLETE']) {await owner.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[ids.org,tier]);await evidence();await read();assert.deepEqual(await checked(()=>service.recordAttention(context(),ids.membership,value)),a);}check();
  for(const [sql,restore,args]of [
    ['UPDATE hon.principal_role_grants SET revoked_at=now(),revoked_by_principal_id=principal_id WHERE id=$1','UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[ids.grant]],
    ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1","UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[ids.org]],
    ["UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1","UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1",[ids.org]],
    ['UPDATE hon.principals SET is_active=false WHERE id=$1','UPDATE hon.principals SET is_active=true WHERE id=$1',[ids.principal]],
    ["UPDATE hon.roles SET code='PARENT' WHERE id=$1","UPDATE hon.roles SET code='OWNER' WHERE id=$1",[ids.role]],
    ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1","UPDATE hon.schools SET status='ACTIVE' WHERE id=$1",[ids.school]],
    ["UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1","UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1",[ids.org]]]) {
    await owner.query(sql,args);for(const work of [()=>read(),()=>evidence(),()=>record(value),()=>resolve(r)])await assert.rejects(work,status(403));await owner.query(restore,args);
  }
  for(const roleCode of ['GUARDIAN','STUDENT','FAMILY','HQ','HON_OPERATOR','PLATFORM','SYSTEM']) {await owner.query('UPDATE hon.roles SET code=$2 WHERE id=$1',[ids.role,roleCode]);await assert.rejects(()=>record(value),status(403));await assert.rejects(()=>resolve(r),status(403));}await owner.query("UPDATE hon.roles SET code='OWNER' WHERE id=$1",[ids.role]);
  await owner.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')",[ids.principal]);for(const work of [()=>read(),()=>evidence(),()=>record(value),()=>resolve(r)])await assert.rejects(work,status(403));await owner.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1',[ids.principal]);
  await owner.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4)",[ids.org,ids.school,ids.family,ids.principal]);for(const work of [()=>read(),()=>evidence(),()=>record(value),()=>resolve(r)])await assert.rejects(work,status(403));await owner.query('DELETE FROM hon.family_access_grants WHERE principal_id=$1',[ids.principal]);check();
  // Authority committed while either command waits is rechecked after its locks.
  for(const [table,work] of [['attendance_records',()=>service.recordAttention(context(),ids.membership,value)],['family_access_grants',()=>service.resolveAttention(context(),ids.membership,r)]]) {
    await owner.query('BEGIN');await owner.query(`LOCK TABLE hon.${table} IN ROW EXCLUSIVE MODE`);const waiting=assert.rejects(work(),status(403));await new Promise(r=>setTimeout(r,100));await owner.query('UPDATE hon.principal_role_grants SET revoked_at=now(),revoked_by_principal_id=principal_id WHERE id=$1',[ids.grant]);await owner.query('COMMIT');await waiting;await owner.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1',[ids.grant]);
  }check();
  // Changed live facts deny even a previously successful receipt.
  await owner.query("UPDATE hon.memberships SET term_ends_at=clock_timestamp()-interval '1 day',version=version+1 WHERE id=$1",[ids.membership]);await assert.rejects(()=>record(value),status(409));const ended=await evidence();assert.deepEqual(ended.attentionCodes,['TERM_ENDED']);const endedAlert=await record(input(ended));check();
  // Atomic failure at the final inert fact rolls back root/history/receipt/audit.
  await owner.query("CREATE FUNCTION hon.attention_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'local atomicity probe'; END $$; CREATE TRIGGER attention_fixture_fail BEFORE INSERT ON hon.retention_attention_outbox FOR EACH ROW EXECUTE FUNCTION hon.attention_fixture_fail()");
  const atomicInput=input(await evidence());await assert.rejects(()=>record(atomicInput),status(503));await assert.rejects(()=>resolve(resolution(endedAlert)),status(503));
  await owner.query('DROP TRIGGER attention_fixture_fail ON hon.retention_attention_outbox; DROP FUNCTION hon.attention_fixture_fail()');check();
  // Qualifying positive attendance fact on a separate known membership; missing
  // progression and attendance alone on the original never produced a code.
  const person=randomUUID(),billing=randomUUID(),membership=randomUUID(),student=randomUUID(),attendance=randomUUID();
  await owner.query('BEGIN');await fixtureOwnerContext(randomUUID());
  await owner.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'PII_CANARY','PII_CANARY')",[person,ids.org,ids.school]);
  await owner.query('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)',[billing,ids.org,ids.school,person]);
  await owner.query("INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state) VALUES($1,$2,$3,$4,$5,'FIXTURE','ACTIVE')",[membership,ids.org,ids.school,billing,person]);
  await owner.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)',[student,ids.org,ids.school,person]);
  await owner.query("INSERT INTO hon.attendance_records(id,organization_id,school_id,class_session_id,student_profile_id,status,recorded_at) VALUES($1,$2,$3,$4,$5,'UNEXCUSED_ABSENCE',clock_timestamp()-interval '1 day')",[attendance,ids.org,ids.school,ids.session,student]);await owner.query('COMMIT');
  const absence=await evidence(context(),membership);assert.deepEqual(absence.attentionCodes,['RENEWAL_REVIEW_NOT_RECORDED','UNEXCUSED_ABSENCE_RECORDED']);await record({...input(absence),evidenceCode:'UNEXCUSED_ABSENCE_RECORDED'},context(),membership);check();
  for(const table of privateTables)for(const sql of [`UPDATE hon.${table} SET id=id`,`DELETE FROM hon.${table}`,`TRUNCATE hon.${table}`])await assert.rejects(()=>owner.query(sql),e=>['42501','0A000'].includes(e.code));check();
  await owner.query('UPDATE hon.memberships SET term_ends_at=$2,version=version+1 WHERE id=$1',[ids.membership,originalTerm]);await owner.query("UPDATE hon.organization_entitlements SET tier='ESSENTIAL' WHERE organization_id=$1",[ids.org]);
  await verifyRetentionAttentionSecurity(owner,'hon_retention_acknowledgement_runtime');
  console.log(`Retention factual attention integrity passed: ${groups} assertion groups, ${probes} rollback-only ACL/RLS/schema/function probes; two blocked distinct humans shared one root/audit/inert outbox and two receipts; exact replay, resolution version/concurrency, immutable private history and whole-platform no-effect checks passed.`);
}
