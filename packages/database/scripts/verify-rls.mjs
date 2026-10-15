import pg from 'pg';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for RLS verification.');

const expectedRlsTables = [
  'action_approvals',
  'action_policies',
  'action_requests',
  'ai_usage_ledger',
  'audit_events',
  'attendance_records',
  'billing_accounts',
  'class_bookings',
  'class_session_instructors',
  'class_sessions',
  'class_templates',
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
  'knowledge_articles',
  'membership_payment_schedules',
  'memberships',
  'organization_entitlements',
  'organizations',
  'outbox_delivery_attempts',
  'outbox_events',
  'payment_attempts',
  'people',
  'planned_absence_requests',
  'principal_interface_preferences',
  'principal_role_grants',
  'programs',
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

  const workItemPolicies = (await client.query(`
    SELECT cmd
    FROM pg_policies
    WHERE schemaname = 'hon' AND tablename = 'work_items'
  `)).rows.map((row) => row.cmd);
  if (!workItemPolicies.includes('ALL')) {
    throw new Error('Work-item tenant-isolation RLS policy is missing.');
  }

  const aiUsagePolicies = (await client.query(`
    SELECT cmd
    FROM pg_policies
    WHERE schemaname = 'hon' AND tablename = 'ai_usage_ledger'
  `)).rows.map((row) => row.cmd);
  if (!aiUsagePolicies.includes('ALL')) {
    throw new Error('AI usage ledger tenant-isolation RLS policy is missing.');
  }

  const runtimeRole = (await client.query(`SELECT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
  ) AS exists`)).rows[0];
  if (runtimeRole?.exists) {
    const runtimeLedgerPrivileges = (await client.query(`
      SELECT
        has_table_privilege('hon_runtime', 'hon.ai_usage_ledger', 'SELECT') AS can_select,
        has_table_privilege('hon_runtime', 'hon.ai_usage_ledger', 'INSERT') AS can_insert,
        has_table_privilege('hon_runtime', 'hon.ai_usage_ledger', 'UPDATE') AS can_update,
        has_table_privilege('hon_runtime', 'hon.ai_usage_ledger', 'DELETE') AS can_delete
    `)).rows[0];
    if (!runtimeLedgerPrivileges?.can_select
      || runtimeLedgerPrivileges.can_insert
      || runtimeLedgerPrivileges.can_update
      || runtimeLedgerPrivileges.can_delete) {
      throw new Error('hon_runtime AI usage ledger privileges are not the required SELECT-only minimum.');
    }

    const runtimeOperationsReportingPrivileges = (await client.query(`
      SELECT
        has_table_privilege('hon_runtime', 'hon.invoices', 'SELECT') AS invoices_can_select,
        has_table_privilege('hon_runtime', 'hon.invoices', 'INSERT') AS invoices_can_insert,
        has_table_privilege('hon_runtime', 'hon.invoices', 'UPDATE') AS invoices_can_update,
        has_table_privilege('hon_runtime', 'hon.invoices', 'DELETE') AS invoices_can_delete,
        has_table_privilege('hon_runtime', 'hon.payment_attempts', 'SELECT') AS payments_can_select,
        has_table_privilege('hon_runtime', 'hon.payment_attempts', 'INSERT') AS payments_can_insert,
        has_table_privilege('hon_runtime', 'hon.payment_attempts', 'UPDATE') AS payments_can_update,
        has_table_privilege('hon_runtime', 'hon.payment_attempts', 'DELETE') AS payments_can_delete
    `)).rows[0];
    if (!runtimeOperationsReportingPrivileges?.invoices_can_select
      || runtimeOperationsReportingPrivileges.invoices_can_insert
      || runtimeOperationsReportingPrivileges.invoices_can_update
      || runtimeOperationsReportingPrivileges.invoices_can_delete
      || !runtimeOperationsReportingPrivileges.payments_can_select
      || runtimeOperationsReportingPrivileges.payments_can_insert
      || runtimeOperationsReportingPrivileges.payments_can_update
      || runtimeOperationsReportingPrivileges.payments_can_delete) {
      throw new Error('hon_runtime operational reporting billing privileges are not the required SELECT-only minimum.');
    }
  }

  const context = await client.query("SELECT hon.current_organization_id() AS organization_id, hon.current_school_id() AS school_id");
  if (context.rows[0].organization_id !== null || context.rows[0].school_id !== null) {
    throw new Error('Connection began with unexpected residual tenant context.');
  }
  console.log(`Verified forced RLS on all ${expectedRlsTables.length} tracked HON operational tables, append-only audit/outbox policies, work-item and AI ledger tenant isolation, SELECT-only AI-ledger/invoice/payment reporting access, and cleared connection context.`);
} finally {
  await client.end();
}
