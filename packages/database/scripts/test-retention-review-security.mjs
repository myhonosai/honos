import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { retentionReviewFunctions, verifyRetentionReviewSecurity } from './retention-review-security.mjs';

if (!process.env.DATABASE_URL || !process.env.HON_RUNTIME_DATABASE_URL) {
  throw new Error('Both migration and restricted runtime database URLs are required.');
}
const options = (connectionString) => ({ connectionString, ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false } });
const runtimeRoleName = new URL(process.env.HON_RUNTIME_DATABASE_URL).username.split('.', 1)[0];
const admin = new pg.Client(options(process.env.DATABASE_URL));
const runtime = new pg.Client(options(process.env.HON_RUNTIME_DATABASE_URL));

await Promise.all([admin.connect(), runtime.connect()]);
try {
  await verifyRetentionReviewSecurity(admin, runtimeRoleName);

  // Some shared operational tables, such as testing candidates, already have
  // reviewed runtime SELECT privileges for other HON commands. This read-only
  // slice may not add access to its private renewal/follow-up/progress sources.
  for (const table of ['membership_renewal_reviews', 'membership_renewal_versions', 'crm_follow_ups', 'curriculum_progress_observations']) {
    const direct = (await admin.query(
      "SELECT has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1, $2, 'SELECT,INSERT,UPDATE,REFERENCES') AS allowed",
      [runtimeRoleName, `hon.${table}`],
    )).rows[0].allowed;
    assert.equal(direct, false, `runtime must not gain direct Retention Review source access: ${table}`);
  }

  const state = async () => (await admin.query(`SELECT
    (SELECT count(*) FROM hon.audit_events) AS audit,
    (SELECT count(*) FROM hon.outbox_events) AS outbox,
    (SELECT count(*) FROM hon.action_requests) AS actions,
    (SELECT count(*) FROM hon.work_items) AS work_items,
    (SELECT count(*) FROM hon.ai_usage_ledger) AS ai_usage,
    (SELECT count(*) FROM hon.memberships) AS memberships,
    (SELECT count(*) FROM hon.attendance_records) AS attendance
  `)).rows[0];
  const before = await state();

  await runtime.query('BEGIN READ ONLY');
  try {
    const organizationId = randomUUID();
    const schoolId = randomUUID();
    await runtime.query(`SELECT
      set_config('app.hon_organization_id', $1, true),
      set_config('app.hon_school_id', $2, true),
      set_config('app.hon_principal_id', $3, true),
      set_config('app.hon_principal_type', 'HUMAN_USER', true),
      set_config('app.hon_source', 'HUMAN_UI', true),
      set_config('app.hon_action_request_id', '', true),
      set_config('app.hon_delegated_by_principal_id', '', true)`, [organizationId, schoolId, randomUUID()]);
    await assert.rejects(
      () => runtime.query('SELECT hon.read_retention_review_signals($1,$2::uuid)', [`unverified-${randomUUID()}`, randomUUID()]),
      error => error?.code === '42501',
      'forged human/school context must fail closed',
    );
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  assert.deepEqual(await state(), before, 'Retention Review Signals denial/read path changed operational, audit, outbox, action, work, AI, membership, or attendance state.');
  assert.equal(retentionReviewFunctions.filter(([, execute]) => execute).length, 2, 'Only scope resolution and read projection may execute at runtime.');
  console.log('Verified Retention Review Signals is runtime-function-only, true read-only, client-denied, source-table-denied, forged-context-denied, and has zero mutation effects.');
} finally {
  await Promise.all([admin.end(), runtime.end()]);
}
