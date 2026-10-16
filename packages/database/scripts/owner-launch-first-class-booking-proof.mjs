import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Called only inside the marked, descriptor-bound, network-disabled owner proof. */
export async function proveOwnerLaunchFirstClassBooking({
  owner, service, programs, classes, bookings, scope, other, context, checked, raw, drift, ids, ownerRoleId,
}) {
  let groups = 0;
  const check = () => groups++;
  const status = (n) => (error) => error?.getStatus?.() === n;
  const bookingEffects = ['class_bookings', 'idempotency_records', 'audit_events', 'outbox_events'];
  const registrationEffects = ['people', 'student_profiles', 'student_curriculum_enrollments', 'student_registration_receipts', 'student_registration_outbox', 'audit_events'];
  const guardianRegistrationEffects = ['people', 'families', 'family_members', 'student_profiles', 'student_curriculum_enrollments', 'guardian_child_registration_receipts', 'guardian_child_registration_outbox', 'audit_events'];
  const programEffects = ['programs', 'idempotency_records', 'audit_events', 'outbox_events'];
  const classEffects = ['class_sessions', 'idempotency_records', 'audit_events', 'outbox_events'];
  const at = (offset) => new Date(Date.now() + offset).toISOString();
  const forbiddenNames = [
    'memberships', 'billing_accounts', 'invoices', 'payment_attempts', 'attendance_records',
    'classpass_passes', 'classpass_ledger', 'ai_usage_ledger', 'ai_invocation_plans',
    'communication_messages', 'communication_message_queue', 'message_deliveries',
    'action_requests', 'action_proposals', 'work_items', 'provider_cost_ledger',
  ];
  const forbiddenTables = (await owner.query(
    "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hon' AND c.relkind='r' AND c.relname=ANY($1::text[]) ORDER BY relname",
    [forbiddenNames],
  )).rows.map((row) => row.relname);
  const forbiddenSnapshot = async () => Object.fromEntries(await Promise.all(forbiddenTables.map(async (table) => {
    assert(/^[a-z_]+$/.test(table));
    const result = await owner.query(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) hash FROM hon.${table} t`);
    return [table, result.rows[0].hash];
  })));
  const forbiddenBefore = await forbiddenSnapshot();
  const adultInput = (session, patch = {}) => ({
    programId: session.programId,
    expectedProgramVersion: session.programVersion,
    classSessionId: session.id,
    expectedClassSessionVersion: session.version,
    givenName: `Booking adult ${randomUUID()}`,
    familyName: 'PII_CANARY_BOOKING',
    birthDate: '1990-02-03',
    attestation: 'NEW_ADULT_NO_GUARDIAN_REQUIRED',
    ...patch,
  });
  const guardianInput = (session, patch = {}) => ({
    programId: session.programId,
    expectedProgramVersion: session.programVersion,
    classSessionId: session.id,
    expectedClassSessionVersion: session.version,
    guardianGivenName: `Booking guardian ${randomUUID()}`,
    guardianFamilyName: `PII_CANARY_GUARDIAN_${randomUUID()}`,
    guardianBirthDate: '1980-02-03',
    childGivenName: `Booking child ${randomUUID()}`,
    childFamilyName: `PII_CANARY_CHILD_${randomUUID()}`,
    childBirthDate: '2015-02-03',
    attestation: 'NEW_CHILD_WITH_NEW_GUARDIAN',
    ...patch,
  });
  const bookingInput = (registration, session, patch = {}) => ({
    registrationId: registration.receipt.registrationId,
    expectedReceiptVersion: 1,
    expectedClassSessionVersion: session.version,
    ...patch,
  });
  const registerAdult = (session, value = adultInput(session), c = context()) => checked(() => service.register(c, value), registrationEffects);
  const registerGuardianChild = (session, value = guardianInput(session), c = context()) => checked(() => service.registerGuardianChild(c, value), guardianRegistrationEffects);
  const book = (registration, session, c = context(), patch = {}) => checked(() => service.bookFirstClass(c, bookingInput(registration, session, patch)), bookingEffects);
  const createProgram = async (c = context()) => (await checked(() => programs.create(c, { name: `Owner booking proof ${randomUUID()}` }), programEffects)).program;
  const createClass = async (program, capacity, c = context()) => {
    const created = await checked(() => classes.create(c, {
      programId: program.id,
      name: `Owner booking proof ${randomUUID()}`,
      startsAt: at(86_400_000),
      endsAt: at(90_000_000),
      capacity,
      bookingPolicy: 'OPTIONAL_BOOKING',
    }), classEffects);
    return { ...created.classSession, programId: program.id, programVersion: program.version };
  };

  // The adult and guardian-child receipt variants both select their exact canonical
  // class. Capacity one yields one BOOKED row and one WAITLISTED row, never a
  // second booking model or an admission/payment result.
  const program = await createProgram();
  const capacitySession = await createClass(program, 1);
  const adult = await registerAdult(capacitySession);
  const guardianChild = await registerGuardianChild(capacitySession);
  const firstContext = context();
  const first = await book(adult, capacitySession, firstContext);
  assert.equal(first.replayed, false);
  assert.equal(first.receipt.status, 'BOOKED');
  assert.equal(first.receipt.registrationId, adult.receipt.registrationId);
  assert.equal(first.receipt.classSessionId, capacitySession.id);
  assert(!JSON.stringify(first).includes('PII_CANARY'));
  const sameKey = await book(adult, capacitySession, firstContext);
  const newKey = await book(adult, capacitySession);
  assert.deepEqual(sameKey.receipt, first.receipt);
  assert.deepEqual(newKey.receipt, first.receipt);
  assert.equal(sameKey.replayed, true);
  assert.equal(newKey.replayed, true);
  const waitlisted = await book(guardianChild, capacitySession);
  assert.equal(waitlisted.replayed, false);
  assert.equal(waitlisted.receipt.status, 'WAITLISTED');
  const capacityRows = (await owner.query(
    "SELECT student_profile_id,booking_kind,status,source FROM hon.class_bookings WHERE class_session_id=$1 ORDER BY student_profile_id",
    [capacitySession.id],
  )).rows;
  assert.deepEqual(capacityRows, [
    { student_profile_id: adult.receipt.studentProfileId, booking_kind: 'REGULAR', status: 'BOOKED', source: 'STAFF' },
    { student_profile_id: guardianChild.receipt.studentProfileId, booking_kind: 'REGULAR', status: 'WAITLISTED', source: 'STAFF' },
  ].sort((left, right) => left.student_profile_id.localeCompare(right.student_profile_id)));
  const capacityEvidence = (await owner.query(
    `SELECT
       (SELECT count(*)::int FROM hon.audit_events WHERE action_code='schedule.booking.create' AND next_state->>'classSessionId'=$1) audits,
       (SELECT count(*)::int FROM hon.outbox_events WHERE event_type='class.booking.created' AND payload->>'classSessionId'=$1) outbox,
       (SELECT count(*)::int FROM hon.idempotency_records WHERE organization_id=$2 AND school_id=$3 AND principal_id=$4 AND idempotency_key IN ($5,$6,$7)) idempotency`,
    [capacitySession.id, scope.organizationId, scope.schoolId, scope.principalId, firstContext.idempotencyKey, newKey.receipt.bookingId === first.receipt.bookingId ? firstContext.idempotencyKey : '', ''],
  )).rows[0];
  // The exact first key produces evidence once; same-key/new-key replays never
  // duplicate the canonical audit/outbox fact. The idempotency count below is
  // rechecked with the actual keys in the next query because the receipt omits them.
  assert.equal(capacityEvidence.audits, 2);
  assert.equal(capacityEvidence.outbox, 2);
  const bookingIdempotency = (await owner.query(
    "SELECT idempotency_key,status,response_status,response_body->>'bookingId' booking_id FROM hon.idempotency_records WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND response_body->>'classSessionId'=$4 AND response_body->>'registrationId'=$5 ORDER BY created_at,id",
    [scope.organizationId, scope.schoolId, scope.principalId, capacitySession.id, adult.receipt.registrationId],
  )).rows;
  assert.equal(bookingIdempotency.length, 2);
  assert(bookingIdempotency.every((row) => row.status === 'COMPLETED' && row.booking_id === first.receipt.bookingId));
  check();

  // Two different receipt-bound requests contend for the same canonical session
  // lock. Exactly one consumes the last capacity slot and the other is durable
  // WAITLISTED, regardless of arrival order.
  const concurrencySession = await createClass(program, 1);
  const concurrentAdult = await registerAdult(concurrencySession);
  const concurrentChild = await registerGuardianChild(concurrencySession);
  const concurrentResults = await checked(() => Promise.all([
    service.bookFirstClass(context(), bookingInput(concurrentAdult, concurrencySession)),
    service.bookFirstClass(context(), bookingInput(concurrentChild, concurrencySession)),
  ]), bookingEffects);
  assert.deepEqual(concurrentResults.map((result) => result.receipt.status).sort(), ['BOOKED', 'WAITLISTED']);
  assert.equal((await owner.query("SELECT count(*)::int count FROM hon.class_bookings WHERE class_session_id=$1 AND status='BOOKED'", [concurrencySession.id])).rows[0].count, 1);
  check();

  // A current class version is required, and receipt version one is deliberately
  // fixed until a future immutable-receipt evolution is separately reviewed.
  const staleSession = await createClass(program, 2);
  const staleAdult = await registerAdult(staleSession);
  await owner.query('UPDATE hon.class_sessions SET version=version+1 WHERE id=$1', [staleSession.id]);
  try {
    await assert.rejects(() => book(staleAdult, staleSession), status(409));
  } finally {
    await owner.query('UPDATE hon.class_sessions SET version=version-1 WHERE id=$1', [staleSession.id]);
  }
  const receiptVersionContext = context();
  await assert.rejects(() => checked(() => raw(receiptVersionContext,
    'SELECT hon.book_owner_launch_first_class($1,$2::jsonb,$3,$4,$5)',
    [receiptVersionContext.externalSubject, JSON.stringify(bookingInput(staleAdult, staleSession, { expectedReceiptVersion: 2 })), receiptVersionContext.idempotencyKey, receiptVersionContext.requestId, receiptVersionContext.correlationId],
  )), (error) => error?.code === '40001');
  for (const patch of [
    { studentProfileId: guardianChild.receipt.studentProfileId }, { familyId: ids.family },
    { programId: program.id }, { classSessionId: capacitySession.id }, { schoolId: other.schoolId },
  ]) {
    const c = context();
    await assert.rejects(() => checked(() => raw(c,
      'SELECT hon.book_owner_launch_first_class($1,$2::jsonb,$3,$4,$5)',
      [c.externalSubject, JSON.stringify({ ...bookingInput(staleAdult, staleSession), ...patch }), c.idempotencyKey, c.requestId, c.correlationId],
    )), (error) => error?.code === '22023');
  }
  check();

  // A receipt from a different live school/actor is not a selector. Nor can the
  // client inject a foreign student, family, program, class, or school key.
  const otherProgram = await createProgram(context(other));
  const otherSession = await createClass(otherProgram, 2, context(other));
  const otherAdult = await registerAdult(otherSession, adultInput(otherSession), context(other));
  await assert.rejects(() => book(otherAdult, otherSession), status(404));
  await assert.rejects(() => book({ receipt: { ...adult.receipt, registrationId: randomUUID() } }, capacitySession), status(404));
  check();

  // Coexistence means a prior canonical ClassBookingService REGULAR booking is
  // returned as the same booking, with no duplicate class_bookings/audit/outbox.
  const coexistenceSession = await createClass(program, 3);
  const coexistenceAdult = await registerAdult(coexistenceSession);
  const canonical = await checked(() => bookings.create(context(), coexistenceSession.id, {
    studentProfileId: coexistenceAdult.receipt.studentProfileId,
    bookingKind: 'REGULAR',
  }), bookingEffects);
  assert.equal(canonical.booking.status, 'BOOKED');
  const beforeCoexistenceEvidence = (await owner.query(
    "SELECT (SELECT count(*)::int FROM hon.audit_events WHERE entity_id=$1) audits,(SELECT count(*)::int FROM hon.outbox_events WHERE aggregate_id=$1) outbox",
    [canonical.booking.id],
  )).rows[0];
  const coexistence = await book(coexistenceAdult, coexistenceSession);
  assert.equal(coexistence.replayed, true);
  assert.equal(coexistence.receipt.bookingId, canonical.booking.id);
  assert.deepEqual((await owner.query(
    "SELECT (SELECT count(*)::int FROM hon.audit_events WHERE entity_id=$1) audits,(SELECT count(*)::int FROM hon.outbox_events WHERE aggregate_id=$1) outbox",
    [canonical.booking.id],
  )).rows[0], beforeCoexistenceEvidence);
  check();

  // Every authority condition is live at the fixed wrapper and the canonical
  // session lock. All denial probes use whole-HON-table snapshots and must write
  // nothing, including no idempotency record.
  const deniedSession = await createClass(program, 2);
  const deniedAdult = await registerAdult(deniedSession);
  const deny = (c = context()) => book(deniedAdult, deniedSession, c);
  await owner.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='schedule.booking.manage'", [ownerRoleId]);
  try { await assert.rejects(() => deny(), status(403)); }
  finally { await owner.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'schedule.booking.manage') ON CONFLICT DO NOTHING", [ownerRoleId, scope.organizationId]); }
  for (const [sql, args, restore] of [
    ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [scope.organizationId], "UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1"],
    ["UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1", [ids.grant], "UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1"],
  ]) {
    await owner.query(sql, args);
    try { await assert.rejects(() => deny(), status(403)); }
    finally { await owner.query(restore, args); }
  }
  await owner.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_SUPPORT')", [ids.principal]);
  try { await assert.rejects(() => deny(), status(403)); }
  finally { await owner.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1', [ids.principal]); }
  await owner.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$4)", [scope.organizationId, scope.schoolId, ids.family, ids.principal]);
  try { await assert.rejects(() => deny(), status(403)); }
  finally { await owner.query('DELETE FROM hon.family_access_grants WHERE principal_id=$1 AND family_id=$2', [ids.principal, ids.family]); }
  for (const patch of [
    { principalType: 'AI_EMPLOYEE' }, { principalType: 'AUTOMATION' }, { principalType: 'INTEGRATION' },
    { source: 'AI' }, { source: 'AUTOMATION' }, { delegatedByPrincipalId: ids.principal }, { actionRequestId: randomUUID() },
  ]) await assert.rejects(() => deny(context(patch)), status(403));
  check();

  // Forged runtime GUCs cannot grant authority. The raw function is executable
  // only through its fixed ACL, and its own source/marker/delegation checks deny.
  for (const patch of [
    { principalType: 'AI_EMPLOYEE' }, { source: 'AI' }, { delegatedByPrincipalId: ids.principal },
    { actionRequestId: randomUUID() }, { externalSubject: other.externalSubject }, { schoolId: other.schoolId },
  ]) {
    const c = context(patch);
    await assert.rejects(() => checked(() => raw(c,
      'SELECT hon.book_owner_launch_first_class($1,$2::jsonb,$3,$4,$5)',
      [c.externalSubject, JSON.stringify(bookingInput(deniedAdult, deniedSession)), c.idempotencyKey, c.requestId, c.correlationId],
    )), (error) => error?.code === '42501');
  }
  await drift("ALTER FUNCTION hon.book_owner_launch_first_class(text,jsonb,text,uuid,uuid) SET statement_timeout TO '1s'");
  check();

  // A normal booking writes precisely the canonical row plus its canonical audit,
  // outbox, and completed idempotency response. Failure of either evidence insert
  // rolls back all four effects atomically.
  const atomicSession = await createClass(program, 2);
  const atomicAdult = await registerAdult(atomicSession);
  const atomicContext = context();
  const atomic = await book(atomicAdult, atomicSession, atomicContext);
  const atomicEvidence = (await owner.query(
    `SELECT b.id,b.status,b.booking_kind,b.source,
      (SELECT count(*)::int FROM hon.audit_events a WHERE a.entity_id=b.id AND a.action_code='schedule.booking.create' AND a.source='HUMAN_UI' AND a.request_id=$2 AND a.correlation_id=$3) audits,
      (SELECT count(*)::int FROM hon.outbox_events o WHERE o.aggregate_id=b.id AND o.event_type='class.booking.created' AND o.causation_id=$2 AND o.correlation_id=$3) outbox,
      (SELECT status FROM hon.idempotency_records i WHERE i.organization_id=$4 AND i.school_id=$5 AND i.principal_id=$6 AND i.idempotency_key=$7) idempotency_status
     FROM hon.class_bookings b WHERE b.id=$1`,
    [atomic.receipt.bookingId, atomicContext.requestId, atomicContext.correlationId, scope.organizationId, scope.schoolId, scope.principalId, atomicContext.idempotencyKey],
  )).rows[0];
  assert.deepEqual(atomicEvidence, { id: atomic.receipt.bookingId, status: 'BOOKED', booking_kind: 'REGULAR', source: 'STAFF', audits: 1, outbox: 1, idempotency_status: 'COMPLETED' });
  for (const target of ['audit_events', 'outbox_events']) {
    const failedSession = await createClass(program, 2);
    const failedAdult = await registerAdult(failedSession);
    const condition = target === 'audit_events'
      ? "IF NEW.action_code='schedule.booking.create' THEN RAISE EXCEPTION 'FIXTURE_BOOKING_ATOMICITY_FAILURE'; END IF;"
      : "RAISE EXCEPTION 'FIXTURE_BOOKING_ATOMICITY_FAILURE';";
    await owner.query(`CREATE FUNCTION hon.fixture_fail_owner_launch_booking_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${condition} RETURN NEW; END $$; CREATE TRIGGER fixture_owner_launch_booking_evidence BEFORE INSERT ON hon.${target} FOR EACH ROW EXECUTE FUNCTION hon.fixture_fail_owner_launch_booking_evidence()`);
    try { await assert.rejects(() => book(failedAdult, failedSession), status(503)); }
    finally { await owner.query(`DROP TRIGGER fixture_owner_launch_booking_evidence ON hon.${target}; DROP FUNCTION hon.fixture_fail_owner_launch_booking_evidence()`); }
  }
  check();

  // The per-command whole-table snapshots already prove every non-allowlisted
  // HON table is unchanged. Repeat a named high-risk cross-domain checksum here
  // so this proof explicitly records zero membership/payment/attendance/AI/provider/message effects.
  assert.deepEqual(await forbiddenSnapshot(), forbiddenBefore);
  return groups;
}
