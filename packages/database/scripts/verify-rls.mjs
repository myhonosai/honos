import pg from 'pg';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for RLS verification.');

const expectedRlsTables = [
  'action_approvals',
  'action_policies',
  'action_requests',
  'ai_usage_ledger',
  'audit_events',
  'billing_accounts',
  'crm_activities',
  'crm_leads',
  'crm_pipeline_stages',
  'crm_pipelines',
  'curricula',
  'curriculum_ranks',
  'curriculum_requirements',
  'families',
  'family_access_grants',
  'family_members',
  'hq_onboarding_requests',
  'hq_operator_grants',
  'idempotency_records',
  'invoices',
  'membership_payment_schedules',
  'memberships',
  'organization_entitlements',
  'organizations',
  'outbox_delivery_attempts',
  'outbox_events',
  'payment_attempts',
  'people',
  'principal_interface_preferences',
  'principal_role_grants',
  'roles',
  'schools',
  'student_curriculum_enrollments',
  'student_profiles',
  'testing_candidates',
  'testing_events',
  'promotion_decisions',
  'work_items',
].sort();

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});
await client.connect();
try {
  const rows = (await client.query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'hon'
      AND c.relkind = 'r'
      AND c.relname = ANY($1::text[])
    ORDER BY c.relname
  `, [expectedRlsTables])).rows;
  const present = new Set(rows.map((row) => row.relname));
  const missingTables = expectedRlsTables.filter((table) => !present.has(table));
  const unforced = rows.filter((row) => !row.relrowsecurity || !row.relforcerowsecurity).map((row) => row.relname);
  const unexpected = (await client.query(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'hon' AND c.relkind = 'r' AND c.relrowsecurity = true AND c.relname <> ALL($1::text[])
    ORDER BY c.relname
  `, [expectedRlsTables])).rows.map((row) => row.relname);
  if (missingTables.length || unforced.length || unexpected.length) {
    throw new Error(`RLS verification failed. Missing: ${missingTables.join(', ') || 'none'}; disabled/unforced: ${unforced.join(', ') || 'none'}; untracked RLS tables: ${unexpected.join(', ') || 'none'}.`);
  }

  const appendOnlyPolicies = (await client.query(`
    SELECT tablename, array_agg(cmd ORDER BY cmd) AS commands
    FROM pg_policies
    WHERE schemaname = 'hon' AND tablename IN ('audit_events', 'outbox_events')
    GROUP BY tablename
  `)).rows;
  for (const policy of appendOnlyPolicies) {
    const commands = policy.commands ?? [];
    if (!commands.includes('SELECT') || !commands.includes('INSERT') || commands.some((command) => ['ALL', 'UPDATE', 'DELETE'].includes(command))) {
      throw new Error(`Append-only policy verification failed for ${policy.tablename}.`);
    }
  }
  if (appendOnlyPolicies.length !== 2) throw new Error('Append-only policies are missing for HON audit/outbox tables.');

  const context = await client.query("SELECT hon.current_organization_id() AS organization_id, hon.current_school_id() AS school_id");
  if (context.rows[0].organization_id !== null || context.rows[0].school_id !== null) {
    throw new Error('Connection began with unexpected residual tenant context.');
  }
  console.log(`Verified forced RLS on all ${expectedRlsTables.length} tracked HON operational tables, append-only audit/outbox policies, and cleared connection context.`);
} finally {
  await client.end();
}
