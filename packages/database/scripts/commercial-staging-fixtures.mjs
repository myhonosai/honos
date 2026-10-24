import assert from 'node:assert/strict';
import { verifySaasBillingSecurity } from './saas-billing-security.mjs';
import { verifyChampionsClubSecurity } from './champions-club-security.mjs';
import { assertLegacySalesClosed } from './saas-legacy-sales-simulation.mjs';
import { fixture } from './commercial-staging-safety.mjs';

export const noAiTables = ['saas_credit_allowances', 'saas_credit_reservations', 'saas_credit_ledger', 'saas_credit_threshold_events', 'ai_usage_ledger'];

/** Additional test-only tripwires. Never included in a migration or runtime deployment. */
export async function installEffectTripwires(client) {
  await client.query(`CREATE SCHEMA hon_validation; REVOKE ALL ON SCHEMA hon_validation FROM PUBLIC;
    CREATE FUNCTION hon_validation.no_ai_grants() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'VALIDATION_NO_AI_GRANTS'; END $$;
    REVOKE ALL ON FUNCTION hon_validation.no_ai_grants() FROM PUBLIC;
    ALTER TABLE hon.saas_credit_program ADD CONSTRAINT hon_staging_credit_inactive CHECK (status = 'INACTIVE');`);
  for (const table of noAiTables) await client.query(`CREATE TRIGGER hon_staging_no_ai_grants BEFORE INSERT OR UPDATE ON hon.${table}
    FOR EACH STATEMENT EXECUTE FUNCTION hon_validation.no_ai_grants()`);
  // An empty INSERT still fires the statement trigger: prove the tripwire works without granting anything.
  await assert.rejects(client.query('INSERT INTO hon.saas_credit_allowances SELECT * FROM hon.saas_credit_allowances WHERE false'),
    e => e.message === 'VALIDATION_NO_AI_GRANTS');
}

export async function shippedPosture(client, migrationEvidence) {
  const marker = (await client.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: fixture.owner, marker: fixture.marker });
  const ledger = (await client.query('SELECT filename FROM hon.schema_migrations ORDER BY filename')).rows.map(r => r.filename);
  assert.deepEqual(ledger, migrationEvidence.entries.map(e => e.file), 'Applied migration sequence differs.');
  const observedOrder = (await client.query('SELECT filename FROM hon.schema_migrations ORDER BY applied_at,filename')).rows.map(r => r.filename);
  assert.deepEqual(observedOrder, ledger, 'Migrations were not recorded in sequence.');
  await verifySaasBillingSecurity(client, fixture.runtime);
  await verifyChampionsClubSecurity(client, fixture.runtime);
  await assertLegacySalesClosed(client);
  const programs = (await client.query(`SELECT
    (SELECT status FROM hon.saas_access_program) paid_access,
    (SELECT mutations_enabled FROM hon.saas_access_program) mutations_enabled,
    (SELECT status FROM hon.saas_credit_program) ai_credits,
    (SELECT status FROM hon.saas_payment_program) payments,
    (SELECT status FROM hon.saas_reward_fulfillment) rewards`)).rows[0];
  assert.deepEqual(programs, { paid_access: 'INACTIVE', mutations_enabled: false, ai_credits: 'INACTIVE', payments: 'DISABLED', rewards: 'INACTIVE' });
  const records = (await client.query("SELECT to_jsonb(r) r FROM hon.saas_policy_records r WHERE policy_code='PAID_ACCESS' ORDER BY version")).rows.map(x => x.r);
  assert.equal(records.at(-1)?.status, 'PROPOSED');
  const terms = (await client.query('SELECT to_jsonb(t) t FROM hon.saas_access_policy_terms t ORDER BY policy_version')).rows.map(x => x.t);
  assert.equal(terms.length, 1); assert.equal(terms[0].policy_version, 1); assert.equal(terms[0].status, 'PROPOSED');
  assert.equal(terms[0].exception_max_days, 90); assert.equal(terms[0].exception_authority, 'HQ_OWNER');
  const constraints = (await client.query(`SELECT conrelid::regclass::text relation,conname,pg_get_constraintdef(oid) definition
    FROM pg_constraint WHERE conrelid IN ('hon.saas_access_program'::regclass,'hon.saas_access_policy_terms'::regclass,'hon.saas_new_sales_policy'::regclass)
    ORDER BY 1,2`)).rows;
  assert(constraints.some(c => c.relation === 'hon.saas_access_program' && c.definition.includes("status = 'INACTIVE'")));
  assert(constraints.some(c => c.relation === 'hon.saas_access_policy_terms' && c.definition.includes("status = 'PROPOSED'")));
  const counts = {};
  for (const table of noAiTables) {
    counts[table] = (await client.query(`SELECT count(*)::int n FROM hon.${table}`)).rows[0].n;
    assert.equal(counts[table], 0, 'AI grants/ledger activity must stay absent.');
    assert.equal((await client.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='hon_staging_no_ai_grants' AND tgenabled='O'", ['hon.' + table])).rows[0].n, 1);
  }
  return { programs, records, terms, constraints, counts,
    policyGap: 'PAID_ACCESS_PROPOSED; TERMS_V1_IMMUTABLE_PROPOSED_ONLY; EXCEPTION_GRANTS_HAVE_NO_APPROVED_STATUS_GATE' };
}
