import pg from 'pg';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for RLS verification.');

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
      AND c.relname IN (
        'organizations', 'organization_entitlements', 'schools', 'hq_operator_grants', 'principal_interface_preferences', 'audit_events', 'idempotency_records', 'outbox_events',
        'people', 'crm_leads', 'billing_accounts', 'memberships', 'invoices',
        'payment_attempts', 'membership_payment_schedules', 'action_requests', 'action_approvals', 'work_items', 'outbox_delivery_attempts',
        'ai_usage_ledger'
      )
    ORDER BY c.relname
  `)).rows;
  const missing = rows.filter((row) => !row.relrowsecurity || !row.relforcerowsecurity).map((row) => row.relname);
  if (rows.length < 20 || missing.length > 0) {
    throw new Error(`RLS verification failed. Missing, disabled, or unforced: ${missing.join(', ') || 'required tables'}`);
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
  console.log(`Verified RLS on ${rows.length} HON operational tables, append-only audit/outbox policies, and cleared connection context.`);
} finally {
  await client.end();
}
