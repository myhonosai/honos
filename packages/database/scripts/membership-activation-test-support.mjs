// Shared test support for the 0177 membership activation gate. Used only by disposable-localhost proofs.
//
// 1. Two-step activation through the real MembershipService: preview, then confirm exactly what was previewed.
// 2. A privileged fixture writer for proofs that must seed non-DRAFT memberships directly. The 0177 transition
//    trigger has no bypass marker by design, so the disposable database owner disables it for one statement inside
//    one transaction (ALTER TABLE takes an ACCESS EXCLUSIVE lock, so no concurrent session can observe the gap).
//    It refuses anything that is not a marked HON disposable validation database, and the runtime role can never do
//    this because it does not own hon.memberships.

export const ACTIVATION_CONFIRMATION = 'I_CONFIRM_MEMBERSHIP_ACTIVATION_AND_DATES_NO_AGREEMENT_CONSENT_OR_PAYMENT_RECORDED';
export const OVERRIDE_CONFIRMATION = 'I_ACKNOWLEDGE_THE_REVIEW_REMAINS_UNRESOLVED';
export const ADULT_ATTESTATION = 'I_ATTEST_STAFF_VERIFIED_THE_PARTICIPANT_IS_AN_ADULT';

/** A confirmation that accepts exactly the previewed facts; `patch` overrides any field. */
export function confirmationFor(preview, patch = {}) {
  const codes = preview.warnings.map((warning) => warning.code);
  const input = {
    expectedVersion: preview.version,
    previewDigest: preview.previewDigest,
    startDate: preview.proposedDates.startDate,
    endDate: preview.proposedDates.endDate,
    dateSource: preview.proposedDates.dateSource,
    acknowledgedWarnings: codes,
    overrides: preview.overridableWarnings.map((code) => ({ code, reason: 'Owner reviewed the pending CRM identity question in person.', confirmation: OVERRIDE_CONFIRMATION })),
    reasonCode: 'ROUTINE_ENROLLMENT',
    confirmation: ACTIVATION_CONFIRMATION,
  };
  if (input.dateSource === 'STAFF_ADJUSTED') input.dateAdjustmentReason = 'Staff confirmed the agreed membership dates.';
  if (codes.includes('START_DATE_BACKDATED')) input.reasonText = 'Membership started before it was recorded in HON.';
  return { ...input, ...patch };
}

/** `actor.context(patch)` builds a command context with a fresh key; previews use an empty key. */
export async function previewActivation(service, actor, membershipId, dates = {}) {
  return service.previewActivation(actor.context({ idempotencyKey: '' }), membershipId, dates);
}

export async function activateWithPreview(service, actor, membershipId, { dates = {}, patch = {}, context } = {}) {
  const preview = await previewActivation(service, actor, membershipId, dates);
  return service.activate(context ?? actor.context(), membershipId, confirmationFor(preview, patch));
}

async function assertDisposable(client) {
  const row = (await client.query(`SELECT shobj_description(d.oid,'pg_database') AS marker, r.rolsuper OR r.rolbypassrls AS trusted,
      pg_get_userbyid(c.relowner)=current_user AS owns_memberships
    FROM pg_database d, pg_roles r, pg_class c WHERE d.datname=current_database() AND r.rolname=current_user AND c.oid='hon.memberships'::regclass`)).rows[0];
  if (!row || typeof row.marker !== 'string' || !/^HON disposable .+ validation$/.test(row.marker) || !row.trusted || !row.owns_memberships) {
    throw new Error('Membership fixture writes are allowed only as the owner of a marked HON disposable validation database.');
  }
}

/**
 * Runs one fixture statement against hon.memberships with the 0177 transition guard disabled, as the disposable
 * database owner, atomically. Returns the statement's rows.
 */
export async function membershipFixtureQuery(ownerClient, text, values = []) {
  await assertDisposable(ownerClient);
  await ownerClient.query('BEGIN');
  try {
    await ownerClient.query('ALTER TABLE hon.memberships DISABLE TRIGGER membership_state_transition_guard');
    const result = await ownerClient.query(text, values);
    await ownerClient.query('ALTER TABLE hon.memberships ENABLE TRIGGER membership_state_transition_guard');
    await ownerClient.query('COMMIT');
    return result.rows;
  } catch (error) {
    await ownerClient.query('ROLLBACK');
    throw error;
  }
}

/**
 * The same fixture write inside a transaction the caller already opened (it fails fast outside one). The 0177/0178
 * transition guard is disabled only for this one statement, under a savepoint, and re-enabled before returning.
 */
export async function membershipFixtureStatement(ownerClient, text, values = []) {
  await assertDisposable(ownerClient);
  await ownerClient.query('SAVEPOINT membership_fixture');
  try {
    await ownerClient.query('ALTER TABLE hon.memberships DISABLE TRIGGER membership_state_transition_guard');
    const result = await ownerClient.query(text, values);
    await ownerClient.query('ALTER TABLE hon.memberships ENABLE TRIGGER membership_state_transition_guard');
    await ownerClient.query('RELEASE SAVEPOINT membership_fixture');
    return result.rows;
  } catch (error) {
    await ownerClient.query('ROLLBACK TO SAVEPOINT membership_fixture');
    throw error;
  }
}
