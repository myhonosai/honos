import pg from 'pg';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for RLS verification.');

const expectedRlsTables = [
  'action_approvals',
  'action_policies',
  'action_requests',
  'ai_team_presentation_preferences',
  'ai_usage_ledger',
  'ai_invocation_plans',
  'audit_events',
  'attendance_records',
  'billing_accounts',
  'class_bookings',
  'class_session_instructors',
  'class_sessions',
  'class_templates',
  'communication_consents',
  'communication_messages',
  'crm_activities',
  'crm_appointments',
  'crm_leads',
  'crm_pipeline_stages',
  'crm_pipelines',
  'curricula',
  'curriculum_ranks',
  'curriculum_requirements',
  'families',
  'family_access_grants',
  'family_members',
  'hq_ai_provider_connections',
  'hq_ai_model_catalog',
  'hq_ai_routing_policies',
  'hq_ai_routing_candidates',
  'hq_ai_control_requests',
  'hq_ai_control_audit',
  'hq_ai_control_outbox',
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

  const planPolicies = (await client.query("SELECT cmd FROM pg_policies WHERE schemaname='hon' AND tablename='ai_invocation_plans'")).rows;
  if (planPolicies.length !== 1 || planPolicies[0].cmd !== 'SELECT') throw new Error('Invocation plans must have only scoped SELECT policy; append is definer-only.');

  const runtimeRole = (await client.query(`SELECT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
  ) AS exists`)).rows[0];
  const hqAiTables = expectedRlsTables.filter((table) => table.startsWith('hq_ai_'));
  const hqAiPolicies = (await client.query(`
    SELECT tablename FROM pg_policies
    WHERE schemaname = 'hon' AND tablename = ANY($1::text[])
  `, [hqAiTables])).rows;
  if (hqAiPolicies.length) throw new Error('HQ AI configuration must retain forced deny-all RLS without tenant/GUC policies.');
  if (runtimeRole?.exists) {
    const summaryBoundary = (await client.query(`
      SELECT p.prosecdef, p.provolatile, p.proconfig, r.rolsuper, r.rolbypassrls,
        has_function_privilege('hon_runtime', p.oid, 'EXECUTE') AS execute,
        EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE acl.grantee NOT IN (p.proowner, (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime'))) AS broad_acl
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = 'hon.read_organization_operations_summary(text,uuid,timestamptz,timestamptz)'::regprocedure
    `)).rows[0];
    if (!summaryBoundary?.execute || !summaryBoundary.prosecdef || summaryBoundary.provolatile !== 's'
      || summaryBoundary.broad_acl || summaryBoundary.proconfig?.length !== 1
      || !summaryBoundary.proconfig.includes('search_path=pg_catalog, hon')
      || !(summaryBoundary.rolsuper || summaryBoundary.rolbypassrls)) {
      throw new Error('Unsafe organization operations summary projection boundary.');
    }
    for (const table of ['users', 'principals', 'roles', 'permissions', 'role_permissions', 'principal_role_grants',
      'family_access_grants', 'organizations', 'schools', 'hq_operator_grants', 'hq_onboarding_requests', 'crm_activities']) {
      if ((await client.query("SELECT has_table_privilege('hon_runtime',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed", [`hon.${table}`])).rows[0].allowed) {
        throw new Error(`Forbidden runtime directory/control-plane/activity privilege: hon.${table}`);
      }
    }
    for (const table of hqAiTables) {
      const access = (await client.query(`
        SELECT has_table_privilege('hon_runtime', $1, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed
      `, [`hon.${table}`])).rows[0];
      if (access?.allowed) throw new Error(`hon_runtime has forbidden direct HQ AI privileges on ${table}.`);
    }
    const planAccess = (await client.query("SELECT has_table_privilege('hon_runtime','hon.ai_invocation_plans','SELECT') AS read,has_table_privilege('hon_runtime','hon.ai_invocation_plans','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS mutate")).rows[0];
    if (!planAccess.read || planAccess.mutate) throw new Error('Invocation plans require exact SELECT-only runtime access.');
    for (const signature of ['hon.plan_ai_invocation(uuid,jsonb,uuid,uuid,uuid)', 'hon.require_ai_invocation_plan_access()']) {
      const f = (await client.query("SELECT p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls,has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS execute FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure", [signature])).rows[0];
      if (!f?.execute || !f.prosecdef || !f.proconfig?.includes('search_path=pg_catalog, hon') || !(f.rolsuper || f.rolbypassrls)) throw new Error(`Unsafe planning boundary: ${signature}`);
    }
    for (const signature of ['hon.validate_ai_invocation_plan_input(jsonb)','hon.ai_invocation_plan_summary(uuid)','hon.reject_ai_invocation_plan_mutation()']) {
      if ((await client.query("SELECT has_function_privilege('hon_runtime',$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed) throw new Error(`Forbidden runtime planning helper: ${signature}`);
    }
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

    const runtimeCrmAppointmentPrivileges = (await client.query(`
      SELECT
        has_table_privilege('hon_runtime', 'hon.crm_appointments', 'SELECT') AS can_select,
        has_table_privilege('hon_runtime', 'hon.crm_appointments', 'INSERT') AS can_insert,
        has_table_privilege('hon_runtime', 'hon.crm_appointments', 'UPDATE') AS can_update,
        has_table_privilege('hon_runtime', 'hon.crm_appointments', 'DELETE') AS can_delete,
        has_type_privilege('hon_runtime', 'hon.crm_appointment_type', 'USAGE') AS type_usage,
        has_type_privilege('hon_runtime', 'hon.crm_appointment_status', 'USAGE') AS status_usage
    `)).rows[0];
    if (!runtimeCrmAppointmentPrivileges?.can_select
      || !runtimeCrmAppointmentPrivileges.can_insert
      || !runtimeCrmAppointmentPrivileges.can_update
      || runtimeCrmAppointmentPrivileges.can_delete
      || !runtimeCrmAppointmentPrivileges.type_usage
      || !runtimeCrmAppointmentPrivileges.status_usage) {
      throw new Error('hon_runtime CRM appointment privileges are not the required SELECT/INSERT/UPDATE and no-DELETE minimum.');
    }

    const runtimeCommunicationConsentPrivileges = (await client.query(`
      SELECT
        has_table_privilege('hon_runtime', 'hon.communication_consents', 'SELECT') AS can_select,
        has_table_privilege('hon_runtime', 'hon.communication_consents', 'INSERT') AS can_insert,
        has_table_privilege('hon_runtime', 'hon.communication_consents', 'UPDATE') AS can_update,
        has_table_privilege('hon_runtime', 'hon.communication_consents', 'DELETE') AS can_delete,
        has_type_privilege('hon_runtime', 'hon.communication_consent_channel', 'USAGE') AS channel_usage,
        has_type_privilege('hon_runtime', 'hon.communication_consent_status', 'USAGE') AS status_usage,
        has_type_privilege('hon_runtime', 'hon.communication_consent_source', 'USAGE') AS source_usage
    `)).rows[0];
    if (!runtimeCommunicationConsentPrivileges?.can_select
      || !runtimeCommunicationConsentPrivileges.can_insert
      || !runtimeCommunicationConsentPrivileges.can_update
      || runtimeCommunicationConsentPrivileges.can_delete
      || !runtimeCommunicationConsentPrivileges.channel_usage
      || !runtimeCommunicationConsentPrivileges.status_usage
      || !runtimeCommunicationConsentPrivileges.source_usage) {
      throw new Error('hon_runtime communication consent privileges are not the required SELECT/INSERT/UPDATE, enum-usage, and no-DELETE minimum.');
    }

    const runtimeCommunicationMessagePrivileges = (await client.query(`
      SELECT
        has_table_privilege('hon_runtime', 'hon.communication_messages', 'SELECT') AS can_select,
        has_table_privilege('hon_runtime', 'hon.communication_messages', 'INSERT') AS can_insert,
        has_table_privilege('hon_runtime', 'hon.communication_messages', 'UPDATE') AS can_update,
        has_table_privilege('hon_runtime', 'hon.communication_messages', 'DELETE') AS can_delete,
        has_type_privilege('hon_runtime', 'hon.communication_message_channel', 'USAGE') AS channel_usage,
        has_type_privilege('hon_runtime', 'hon.communication_message_lifecycle', 'USAGE') AS lifecycle_usage
    `)).rows[0];
    if (!runtimeCommunicationMessagePrivileges?.can_select
      || !runtimeCommunicationMessagePrivileges.can_insert
      || !runtimeCommunicationMessagePrivileges.can_update
      || runtimeCommunicationMessagePrivileges.can_delete
      || !runtimeCommunicationMessagePrivileges.channel_usage
      || !runtimeCommunicationMessagePrivileges.lifecycle_usage) {
      throw new Error('hon_runtime communication message privileges are not the required SELECT/INSERT/UPDATE, enum-usage, and no-DELETE minimum.');
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
      || !runtimeOperationsReportingPrivileges.invoices_can_insert
      || !runtimeOperationsReportingPrivileges.invoices_can_update
      || runtimeOperationsReportingPrivileges.invoices_can_delete
      || !runtimeOperationsReportingPrivileges.payments_can_select
      || runtimeOperationsReportingPrivileges.payments_can_insert
      || runtimeOperationsReportingPrivileges.payments_can_update
      || runtimeOperationsReportingPrivileges.payments_can_delete) {
      throw new Error('hon_runtime billing privileges are not exact invoice SELECT/INSERT/UPDATE and payment SELECT-only minima.');
    }

    const runtimeMembershipPrivileges = (await client.query(`
      SELECT
        has_table_privilege('hon_runtime', 'hon.memberships', 'SELECT') AS can_select,
        has_table_privilege('hon_runtime', 'hon.memberships', 'INSERT') AS can_insert,
        has_table_privilege('hon_runtime', 'hon.memberships', 'UPDATE') AS can_update,
        has_table_privilege('hon_runtime', 'hon.memberships', 'DELETE') AS can_delete
    `)).rows[0];
    if (!runtimeMembershipPrivileges?.can_select
      || !runtimeMembershipPrivileges.can_insert
      || !runtimeMembershipPrivileges.can_update
      || runtimeMembershipPrivileges.can_delete) {
      throw new Error('hon_runtime membership privileges are not the required SELECT/INSERT/UPDATE and no-DELETE minimum.');
    }

    const runtimeAiTeamPreferencesPrivileges = (await client.query(`
      SELECT
        has_table_privilege('hon_runtime', 'hon.ai_team_presentation_preferences', 'SELECT') AS can_select,
        has_table_privilege('hon_runtime', 'hon.ai_team_presentation_preferences', 'INSERT') AS can_insert,
        has_table_privilege('hon_runtime', 'hon.ai_team_presentation_preferences', 'UPDATE') AS can_update,
        has_table_privilege('hon_runtime', 'hon.ai_team_presentation_preferences', 'DELETE') AS can_delete
    `)).rows[0];
    if (!runtimeAiTeamPreferencesPrivileges?.can_select
      || !runtimeAiTeamPreferencesPrivileges.can_insert
      || !runtimeAiTeamPreferencesPrivileges.can_update
      || runtimeAiTeamPreferencesPrivileges.can_delete) {
      throw new Error('hon_runtime AI Team presentation preferences privileges are not the required SELECT/INSERT/UPDATE and no-DELETE minimum.');
    }
  }

  const context = await client.query("SELECT hon.current_organization_id() AS organization_id, hon.current_school_id() AS school_id");
  if (context.rows[0].organization_id !== null || context.rows[0].school_id !== null) {
    throw new Error('Connection began with unexpected residual tenant context.');
  }
  console.log(`Verified forced RLS on all ${expectedRlsTables.length} tracked HON operational tables, append-only audit/outbox policies, work-item, immutable decision-only AI plans and AI ledger tenant isolation, exact CRM appointment and communications consent/message command grants, invoice and membership SELECT/INSERT/UPDATE plus payment and AI-ledger SELECT-only reporting access, fixed read-only operations summary definer/ACL and forbidden runtime directory/HQ/activity grants, and cleared connection context.`);
} finally {
  await client.end();
}
