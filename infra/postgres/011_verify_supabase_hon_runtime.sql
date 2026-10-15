-- HON / Supabase development runtime-role verification
-- Run this AFTER 010_supabase_hon_runtime.sql in the Supabase SQL Editor.

-- 1) Role posture: every boolean must be false except rolcanlogin.
SELECT
  rolname,
  rolcanlogin,
  rolsuper,
  rolinherit,
  rolcreaterole,
  rolcreatedb,
  rolreplication,
  rolbypassrls
FROM pg_roles
WHERE rolname = 'hon_runtime';

-- 2) No explicit privileged role memberships: this should return zero rows.
SELECT parent.rolname AS inherited_role
FROM pg_auth_members membership
JOIN pg_roles parent ON parent.oid = membership.roleid
JOIN pg_roles member ON member.oid = membership.member
WHERE member.rolname = 'hon_runtime';

-- 3) Required grants only. can_connect and can_use_hon_schema must be true;
-- can_create_in_hon_schema must be false.
SELECT
  has_database_privilege('hon_runtime', current_database(), 'CONNECT') AS can_connect,
  has_schema_privilege('hon_runtime', 'hon', 'USAGE') AS can_use_hon_schema,
  has_schema_privilege('hon_runtime', 'hon', 'CREATE') AS can_create_in_hon_schema;

SELECT has_function_privilege(
  'hon_runtime',
  'hon.resolve_authorized_scope(text, uuid, text)',
  'EXECUTE'
) AS can_resolve_authorized_scope;

SELECT has_function_privilege(
  'hon_runtime',
  'hon.resolve_hq_operator_scope(text, text)',
  'EXECUTE'
) AS can_resolve_hq_operator_scope;

-- Conventional trial scheduling/outcome commands need exact RLS-bound CRUD
-- subset access. DELETE must stay unavailable.
SELECT
  has_table_privilege('hon_runtime', 'hon.crm_appointments', 'SELECT') AS can_read_crm_appointments,
  has_table_privilege('hon_runtime', 'hon.crm_appointments', 'INSERT') AS can_create_crm_appointments,
  has_table_privilege('hon_runtime', 'hon.crm_appointments', 'UPDATE') AS can_update_crm_appointments,
  has_table_privilege('hon_runtime', 'hon.crm_appointments', 'DELETE') AS can_delete_crm_appointments,
  has_type_privilege('hon_runtime', 'hon.crm_appointment_type', 'USAGE') AS can_use_crm_appointment_type,
  has_type_privilege('hon_runtime', 'hon.crm_appointment_status', 'USAGE') AS can_use_crm_appointment_status;

-- Parent requests require SELECT/INSERT; the separate human staff review
-- command requires the only allowed UPDATE transition. DELETE must remain false.
SELECT
  has_table_privilege('hon_runtime', 'hon.planned_absence_requests', 'SELECT') AS can_read_planned_absence_requests,
  has_table_privilege('hon_runtime', 'hon.planned_absence_requests', 'INSERT') AS can_submit_planned_absence_requests,
  has_table_privilege('hon_runtime', 'hon.planned_absence_requests', 'UPDATE') AS can_review_planned_absence_requests,
  has_table_privilege('hon_runtime', 'hon.planned_absence_requests', 'DELETE') AS can_delete_planned_absence_requests,
  has_type_privilege('hon_runtime', 'hon.planned_absence_request_status', 'USAGE') AS can_use_planned_absence_status;

-- Durable work-item commands need RLS-bound list/create/transition operations,
-- never deletion or direct access to the principal directory.
SELECT
  has_table_privilege('hon_runtime', 'hon.work_items', 'SELECT') AS can_read_work_items,
  has_table_privilege('hon_runtime', 'hon.work_items', 'INSERT') AS can_create_work_items,
  has_table_privilege('hon_runtime', 'hon.work_items', 'UPDATE') AS can_transition_work_items,
  has_table_privilege('hon_runtime', 'hon.work_items', 'DELETE') AS can_delete_work_items;

-- AI usage economics is a tenant-scoped, aggregate read. Ledger writes, credit
-- charging/reset, and provider execution remain unavailable to the runtime role.
SELECT
  has_table_privilege('hon_runtime', 'hon.ai_usage_ledger', 'SELECT') AS can_read_ai_usage_ledger,
  has_table_privilege('hon_runtime', 'hon.ai_usage_ledger', 'INSERT') AS can_insert_ai_usage_ledger,
  has_table_privilege('hon_runtime', 'hon.ai_usage_ledger', 'UPDATE') AS can_update_ai_usage_ledger,
  has_table_privilege('hon_runtime', 'hon.ai_usage_ledger', 'DELETE') AS can_delete_ai_usage_ledger;

-- Operational reporting has no revenue calculation. It reads only aggregate
-- invoice status and payment-attempt state, so each billing input is SELECT-only.
SELECT
  has_table_privilege('hon_runtime', 'hon.invoices', 'SELECT') AS can_read_invoices,
  has_table_privilege('hon_runtime', 'hon.invoices', 'INSERT') AS can_insert_invoices,
  has_table_privilege('hon_runtime', 'hon.invoices', 'UPDATE') AS can_update_invoices,
  has_table_privilege('hon_runtime', 'hon.invoices', 'DELETE') AS can_delete_invoices,
  has_table_privilege('hon_runtime', 'hon.payment_attempts', 'SELECT') AS can_read_payment_attempts,
  has_table_privilege('hon_runtime', 'hon.payment_attempts', 'INSERT') AS can_insert_payment_attempts,
  has_table_privilege('hon_runtime', 'hon.payment_attempts', 'UPDATE') AS can_update_payment_attempts,
  has_table_privilege('hon_runtime', 'hon.payment_attempts', 'DELETE') AS can_delete_payment_attempts;

-- 4) RLS is enabled and forced on every operational table.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'hon'
  AND c.relkind = 'r'
ORDER BY c.relname;

-- 5) Confirm the runtime role starts with no tenant context and sees no people
-- through RLS without a transaction-bound scope. Roll back so SQL Editor role
-- state is not retained.
BEGIN;
SET LOCAL ROLE hon_runtime;
SELECT current_user, session_user, hon.current_organization_id(), hon.current_school_id();
SELECT count(*) AS rows_visible_without_tenant_context FROM hon.people;
ROLLBACK;

-- 6) Full isolation proof runs from the actual Session Pooler runtime URL after
-- it is saved as HON_RUNTIME_DATABASE_URL:
-- pnpm db:test-security
-- pnpm db:test-ai-usage
-- The HON test creates two temporary school scopes inside a rolled-back
-- transaction, proves the second school's person is invisible to the first,
-- proves a composite tenant FK rejects a cross-school relation, and confirms
-- transaction-local context clears after completion. The AI usage fixture also
-- proves SELECT-only ledger access, active-tier credit calculation, and a
-- cross-school ledger row remains invisible.
