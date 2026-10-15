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

-- Human invoice drafting and the sole DRAFT-to-ISSUED transition require
-- SELECT/INSERT/UPDATE. DELETE and all payment/provider mutations remain
-- unavailable to the runtime role.
SELECT
  has_table_privilege('hon_runtime', 'hon.invoices', 'SELECT') AS can_read_invoices,
  has_table_privilege('hon_runtime', 'hon.invoices', 'INSERT') AS can_insert_invoices,
  has_table_privilege('hon_runtime', 'hon.invoices', 'UPDATE') AS can_update_invoices,
  has_table_privilege('hon_runtime', 'hon.invoices', 'DELETE') AS can_delete_invoices,
  has_table_privilege('hon_runtime', 'hon.payment_attempts', 'SELECT') AS can_read_payment_attempts,
  has_table_privilege('hon_runtime', 'hon.payment_attempts', 'INSERT') AS can_insert_payment_attempts,
  has_table_privilege('hon_runtime', 'hon.payment_attempts', 'UPDATE') AS can_update_payment_attempts,
  has_table_privilege('hon_runtime', 'hon.payment_attempts', 'DELETE') AS can_delete_payment_attempts;

-- Human membership creation, activation, and direct ACTIVE-to-CANCELLED
-- cancellation use the reviewed RLS-bound SELECT/INSERT/UPDATE subset. DELETE,
-- payment-attempt writes, and every payment-provider action remain unavailable.
SELECT
  has_table_privilege('hon_runtime', 'hon.memberships', 'SELECT') AS can_read_memberships,
  has_table_privilege('hon_runtime', 'hon.memberships', 'INSERT') AS can_insert_memberships,
  has_table_privilege('hon_runtime', 'hon.memberships', 'UPDATE') AS can_update_memberships,
  has_table_privilege('hon_runtime', 'hon.memberships', 'DELETE') AS can_delete_memberships;

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

-- 7) Decision-only AI planning: SELECT and the two fixed functions are true;
-- all direct plan writes and all HQ provider/config table privileges are false.
SELECT has_table_privilege('hon_runtime','hon.ai_invocation_plans','SELECT') AS can_read_plans,
  has_table_privilege('hon_runtime','hon.ai_invocation_plans','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_mutate_plans,
  has_function_privilege('hon_runtime','hon.plan_ai_invocation(uuid,jsonb,uuid,uuid,uuid)','EXECUTE') AS can_plan,
  has_function_privilege('hon_runtime','hon.require_ai_invocation_plan_access()','EXECUTE') AS can_check_plan_access;
SELECT table_name, has_table_privilege('hon_runtime','hon.' || table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS forbidden_config_access
FROM unnest(ARRAY['hq_ai_provider_connections','hq_ai_model_catalog','hq_ai_routing_policies','hq_ai_routing_candidates','hq_ai_control_requests','hq_ai_control_audit','hq_ai_control_outbox']) AS table_name;
SELECT signature, has_function_privilege('hon_runtime',signature,'EXECUTE') AS forbidden_helper_execution
FROM unnest(ARRAY['hon.validate_ai_invocation_plan_input(jsonb)','hon.ai_invocation_plan_summary(uuid)','hon.reject_ai_invocation_plan_mutation()']) AS signature;
-- pnpm db:test-ai-plans additionally proves live human/Complete gates, replay,
-- optimistic state/version, immutable plans, atomic evidence and no execution.

-- 8) Organization operations summary: only this fixed read-only projection has
-- the new EXECUTE privilege. Public/other-grantee ACL must remain false, owner
-- bypass must be true, search_path must be exactly pg_catalog, hon.
SELECT p.prosecdef, p.provolatile, p.proconfig,
  r.rolsuper OR r.rolbypassrls AS owner_can_project_through_forced_rls,
  has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS can_read_operations_summary,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) AS acl
    WHERE acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS forbidden_broad_execute
FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
WHERE p.oid='hon.read_organization_operations_summary(text,uuid,timestamptz,timestamptz)'::regprocedure;
SELECT table_name, has_table_privilege('hon_runtime','hon.' || table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS forbidden_directory_access
FROM unnest(ARRAY['users','principals','roles','permissions','role_permissions','principal_role_grants','family_access_grants','organizations','schools','hq_operator_grants','hq_onboarding_requests','crm_activities']) AS table_name;
-- pnpm db:test-operations-summary proves Core/Complete/live permissions, exact
-- authorized-school-only aggregates, revocation, no PII and read-only execution.

-- 9) Human staff IAM: only command/single-ID projection EXECUTE is true.
SELECT p.proname,p.prosecdef,p.proconfig,
  has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS runtime_execute,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS forbidden_broad_execute
FROM pg_proc p WHERE p.oid IN (
  'hon.mutate_staff_role(text,text,uuid,jsonb,text,uuid,uuid)'::regprocedure,
  'hon.read_staff_role(text,text,uuid)'::regprocedure,
  'hon.resolve_staff_role_target(uuid,text,uuid)'::regprocedure,
  'hon.guard_staff_custom_role_recipients()'::regprocedure);
-- Both target/recipient helper runtime_execute values MUST be false. Paths fixed.
SELECT t,has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS forbidden_iam_access
FROM unnest(ARRAY['users','principals','roles','permissions','role_permissions','principal_role_grants','hq_operator_grants']) t;
-- pnpm db:test-staff-roles proves scope/subset/HUMAN_UI, exact registered target,
-- expiry, concurrency, idempotent ending, OWNER protection, evidence/no effects.

-- 10) Internal documents: all tables deny-all forced RLS, no direct runtime access.
-- Only mutate_document/read_documents runtime EXECUTE may be true; all helpers false.
SELECT t,has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS forbidden_document_table_access
FROM unnest(ARRAY['document_templates','document_versions','document_publications','document_acknowledgements','document_command_requests']) t;
SELECT p.proname,p.prosecdef,p.proconfig,r.rolsuper OR r.rolbypassrls AS trusted_owner,
  has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS runtime_execute,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS forbidden_broad_execute
FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid IN (
  'hon.mutate_document(text,text,text,uuid,jsonb,text,uuid,uuid)'::regprocedure,
  'hon.read_documents(text,text,text,uuid,integer)'::regprocedure,
  'hon.guard_document_immutability()'::regprocedure,
  'hon.require_document_actor(text,text,text,uuid,boolean)'::regprocedure,
  'hon.document_family_authorized(text,uuid,boolean)'::regprocedure);
SELECT * FROM pg_policies WHERE schemaname='hon' AND tablename LIKE 'document_%'; -- zero rows
-- pnpm db:test-documents proves real runtime and direct RLS, publication immutability,
-- family/audience separation, stale/replay, human-only, atomic evidence/no effects.

-- 11) Search: STABLE definer, fixed path, trusted owner, runtime EXECUTE true,
-- broad ACL false. No direct directory/HQ/secret grants are introduced.
SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolbypassrls,r.rolsuper,
  has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS runtime_execute,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS broad_acl
FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
WHERE p.oid='hon.search_school(text,uuid,uuid,text,text[],uuid)'::regprocedure;
-- pnpm db:test-search proves active/exact scope, revocation, literal injection,
-- redaction, stable 20 cap and READ ONLY/no audit/outbox/provider side effects.
