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

-- 8b) School Command Center: a single fixed projection, not a new CRM/action
-- surface. Runtime gets EXECUTE only; no PUBLIC/client execute or caller GUC
-- authority is allowed. The detailed fixture also proves Essential/Core/Complete,
-- parent/HQ denial, selected-school isolation, windows and zero side effects.
SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolsuper OR r.rolbypassrls AS trusted_owner,
  has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS runtime_execute,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS forbidden_broad_execute,
  position('current_setting' IN pg_get_functiondef(p.oid)) = 0 AS no_caller_guc_authority
FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
WHERE p.oid='hon.read_school_command_center(text,uuid,uuid)'::regprocedure;
DO $$
DECLARE p record; role_name text;
BEGIN
 SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolsuper OR r.rolbypassrls AS trusted_owner,
   has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS runtime_execute,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS broad,
   position('current_setting' IN pg_get_functiondef(p.oid))=0 AS no_guc
 INTO p FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid='hon.read_school_command_center(text,uuid,uuid)'::regprocedure;
 IF p.prosecdef IS DISTINCT FROM true OR p.provolatile<>'s' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
   OR p.trusted_owner IS DISTINCT FROM true OR p.runtime_execute IS DISTINCT FROM true OR p.broad IS DISTINCT FROM false OR p.no_guc IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Unsafe Command Center projection ACL or definition';
 END IF;
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  IF has_function_privilege(role_name,'hon.read_school_command_center(text,uuid,uuid)','EXECUTE') THEN
   RAISE EXCEPTION 'Client Command Center execute: %',role_name;
  END IF;
 END LOOP;
END $$;
-- pnpm db:test-command-center proves direct runtime directory/source-table denial
-- where not already granted to other modules, RLS/FORCE-RLS posture, no raw PII,
-- exact half-open windows, deterministic cards, and no AI/provider/Action Engine writes.

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

-- 12) Human lead imports: zero table grants/policies, all four tables forced RLS.
SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
 has_table_privilege('hon_runtime',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS forbidden_import_table_access
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hon' AND c.relname IN('lead_import_batches','lead_import_rows','lead_import_evidence','lead_import_requests');
SELECT * FROM pg_policies WHERE schemaname='hon' AND tablename LIKE 'lead_import_%'; -- zero rows
-- Only resolver/mutate/read runtime EXECUTE is true; internal helpers are false.
SELECT p.proname,p.prosecdef,p.proconfig,r.rolsuper OR r.rolbypassrls AS trusted_owner,
 has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS runtime_execute,
 EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE a.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS forbidden_broad_execute
FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid IN(
 'hon.resolve_lead_import_scope(text,text)'::regprocedure,
 'hon.mutate_lead_import(text,text,uuid,jsonb,text,uuid,uuid)'::regprocedure,
 'hon.read_lead_import(text,text,uuid,uuid)'::regprocedure,
 'hon.guard_lead_import_evidence()'::regprocedure,
 'hon.require_lead_import_actor(text,text)'::regprocedure,
 'hon.lead_import_summary(uuid)'::regprocedure,
 'hon.validate_lead_import_row(jsonb,jsonb,jsonb)'::regprocedure,
 'hon.apply_imported_lead(uuid,integer,uuid,uuid,uuid)'::regprocedure);
-- pnpm db:test-lead-import proves isolation/revocation, private review, strict CSV,
-- no merge, explicit scoped atomic finalization/replay, redacted audit/inert outbox.

SELECT r.rolname,t,has_table_privilege(r.rolname,'hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS forbidden_client_import_access
FROM pg_roles r CROSS JOIN unnest(ARRAY['lead_import_batches','lead_import_rows','lead_import_evidence','lead_import_requests']) t
WHERE r.rolname IN('anon','authenticated','service_role'); -- all false

-- 13) Human curriculum progress: private history/current requirement tables deny
-- all direct runtime/client access. Only fixed commands/reads/locks and shared
-- authorization boundaries execute; trigger, actor and evidence helpers do not.
SELECT t,has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS forbidden_curriculum_access
FROM unnest(ARRAY['curriculum_requirements','curriculum_requirement_versions','curriculum_enrollment_history','curriculum_progress_observations','curriculum_command_requests']) t;
WITH expected(signature,runtime_execute,security_definer) AS (VALUES
 ('hon.mutate_curriculum_progress(text,text,uuid,uuid,jsonb,text,uuid,uuid)',true,true),
 ('hon.read_staff_curriculum_progress(text,text,uuid,uuid)',true,true),
 ('hon.read_parent_curriculum_progress(text,uuid)',true,true),
 ('hon.lock_human_testing_authority(text)',true,true),
 ('hon.lock_human_testing_record(text,text,uuid)',true,true),
 ('hon.resolve_authorized_scope(text,uuid,text)',true,true),
 ('hon.resolve_parent_family_scope(text,uuid)',true,true),
 ('hon.resolve_parent_journey_scopes(text)',true,true),
 ('hon.principal_has_school_permission(uuid,uuid,uuid,text)',true,true),
 ('hon.require_curriculum_actor(text,text)',false,true),
 ('hon.validate_curriculum_observation()',false,true),
 ('hon.snapshot_curriculum_requirement()',false,true),
 ('hon.verify_curriculum_enrollment_evidence()',false,true),
 ('hon.guard_curriculum_history()',false,false),
 ('hon.guard_curriculum_requirement()',false,false),
 ('hon.guard_curriculum_enrollment_identity()',false,false),
 ('hon.guard_curriculum_structure_identity()',false,false)
)
SELECT expected.signature,p.prosecdef,p.proconfig,r.rolsuper OR r.rolbypassrls AS trusted_owner,
 expected.runtime_execute AS expected_runtime_execute,
 has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS runtime_execute,
 has_function_privilege('hon_runtime',p.oid,'EXECUTE')=expected.runtime_execute
   AND p.prosecdef=expected.security_definer AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AS matches_expected_boundary,
 EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS forbidden_broad_execute
FROM expected JOIN pg_proc p ON p.oid=expected.signature::regprocedure JOIN pg_roles r ON r.oid=p.proowner;

-- Enrollment SELECT must be true; table-wide mutation and INSERT columns false.
SELECT has_table_privilege('hon_runtime','hon.student_curriculum_enrollments','SELECT') AS can_read_enrollment,
 has_table_privilege('hon_runtime','hon.student_curriculum_enrollments','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS forbidden_broad_enrollment_mutation,
 has_any_column_privilege('hon_runtime','hon.student_curriculum_enrollments','INSERT,REFERENCES') AS forbidden_enrollment_column_insert_or_reference,
 has_table_privilege('hon_runtime','hon.testing_candidates','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS forbidden_broad_grading_mutation;
-- Every matches_expected_update must be true, including all non-allowed columns.
WITH expected(table_name,update_columns) AS (VALUES
 ('student_curriculum_enrollments',ARRAY['current_rank_id','version','updated_at']),
 ('testing_candidates',ARRAY['result','instructor_notes','version','updated_at'])
)
SELECT e.table_name,a.attname,a.attname=ANY(e.update_columns) AS expected_update,
 has_column_privilege('hon_runtime',a.attrelid,a.attnum,'UPDATE') AS runtime_update,
 has_column_privilege('hon_runtime',a.attrelid,a.attnum,'UPDATE')=(a.attname=ANY(e.update_columns)) AS matches_expected_update
FROM expected e JOIN pg_attribute a ON a.attrelid=('hon.'||e.table_name)::regclass
WHERE a.attnum>0 AND NOT a.attisdropped ORDER BY e.table_name,a.attnum;

SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='hon' AND c.relname IN('curriculum_requirement_versions','curriculum_enrollment_history','curriculum_progress_observations','curriculum_command_requests'); -- all forced
SELECT * FROM pg_policies WHERE schemaname='hon' AND tablename IN('curriculum_requirement_versions','curriculum_enrollment_history','curriculum_progress_observations','curriculum_command_requests'); -- zero rows
-- Detect PUBLIC or any other client ACL even when that client role is absent.
SELECT c.relname,
 EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
   WHERE acl.grantee NOT IN(c.relowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))
 OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl
   WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   AND acl.grantee NOT IN(c.relowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS forbidden_broad_table_or_column_acl
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='hon' AND c.relname IN('curriculum_requirements','curriculum_requirement_versions','curriculum_enrollment_history','curriculum_progress_observations','curriculum_command_requests','student_curriculum_enrollments'); -- all false
SELECT r.rolname,t,has_table_privilege(r.rolname,'hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS forbidden_client_curriculum_access
FROM pg_roles r CROSS JOIN unnest(ARRAY['curriculum_requirements','curriculum_requirement_versions','curriculum_enrollment_history','curriculum_progress_observations','curriculum_command_requests']) t
WHERE r.rolname IN('anon','authenticated','service_role');
SELECT r.rolname,
 has_table_privilege(r.rolname,'hon.student_curriculum_enrollments','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 OR has_any_column_privilege(r.rolname,'hon.student_curriculum_enrollments','INSERT,UPDATE,REFERENCES') AS forbidden_client_enrollment_mutation
FROM pg_roles r WHERE r.rolname IN('anon','authenticated','service_role'); -- all false
-- pnpm db:test-curriculum-progress proves live exact human/source permissions,
-- relationships, immutable versions/history, concurrency/replay, family redaction,
-- atomic audit/inert outbox and all-requirements-met NEVER causing promotion.

-- 14) Deterministic revenue planning: exactly two runtime functions, no tables,
-- columns, helper EXECUTE, PUBLIC/client/HQ or directory access. All rows below
-- must match_expected; the executable assertion block fails on drift.
WITH expected(signature,runtime_execute,definer) AS (VALUES
 ('hon.save_revenue_plan(text,uuid,jsonb,text,uuid,uuid)',true,true),
 ('hon.read_revenue_plan(text,text,uuid,integer)',true,true),
 ('hon.validate_revenue_plan_input(jsonb)',false,false),
 ('hon.guard_revenue_plan()',false,false),
 ('hon.guard_revenue_plan_history()',false,false),
 ('hon.require_revenue_planning_actor(text)',false,true),
 ('hon.lock_revenue_planning_actor(text)',false,true),
 ('hon.revenue_plan_snapshot(uuid)',false,true)
)
SELECT e.signature,p.prosecdef,p.proconfig,r.rolsuper OR r.rolbypassrls AS trusted_owner,
 has_function_privilege('hon_runtime',p.oid,'EXECUTE')=e.runtime_execute
 AND p.prosecdef=e.definer AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT e.runtime_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE')) AS matches_expected
FROM expected e JOIN pg_proc p ON p.oid=e.signature::regprocedure JOIN pg_roles r ON r.oid=p.proowner;
SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
 EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
 OR EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a
  WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee<>c.relowner) AS forbidden_nonowner_table_or_column_acl
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='hon' AND c.relname IN('revenue_plans','revenue_plan_versions','revenue_plan_requests');
SELECT * FROM pg_policies WHERE schemaname='hon' AND tablename IN('revenue_plans','revenue_plan_versions','revenue_plan_requests'); -- zero rows
DO $$
DECLARE t text; f record; b record; r text;
BEGIN
 FOR t IN SELECT unnest(ARRAY['revenue_plans','revenue_plan_versions','revenue_plan_requests']) LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND (owner.rolsuper OR owner.rolbypassrls)
   AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a
    WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee<>c.relowner) AS safe
  INTO b FROM pg_class c JOIN pg_roles owner ON owner.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe revenue private table: %',t; END IF;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
  ('hon.save_revenue_plan(text,uuid,jsonb,text,uuid,uuid)',true,true),('hon.read_revenue_plan(text,text,uuid,integer)',true,true),
  ('hon.validate_revenue_plan_input(jsonb)',false,false),('hon.guard_revenue_plan()',false,false),('hon.guard_revenue_plan_history()',false,false),
  ('hon.require_revenue_planning_actor(text)',false,true),('hon.lock_revenue_planning_actor(text)',false,true),('hon.revenue_plan_snapshot(uuid)',false,true)
 ) e(signature,can_execute,definer) LOOP
  SELECT (owner.rolsuper OR owner.rolbypassrls) AND p.prosecdef=f.definer AND p.provolatile='v'
   AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE')) AS safe
  INTO b FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe revenue function: %',f.signature; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_function_privilege(r,f.signature,'EXECUTE') THEN RAISE EXCEPTION 'Client revenue function access: %',r; END IF;
  END LOOP;
 END LOOP;
 FOR t IN SELECT unnest(ARRAY['revenue_plans','revenue_plan_versions','revenue_plan_requests','users','principals','roles','permissions','role_permissions','principal_role_grants','family_access_grants','organizations','schools','hq_operator_grants','hq_onboarding_requests','crm_activities','hq_ai_provider_connections','hq_ai_model_catalog','hq_ai_routing_policies','hq_ai_routing_candidates','hq_ai_control_requests','hq_ai_control_audit','hq_ai_control_outbox']) LOOP
  IF has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Forbidden runtime private/directory/HQ access: %',t; END IF;
 END LOOP;
END $$;
-- Guarded disposable-local proof only for this slice: pnpm db:test-revenue-planning.
-- No production/Supabase migration or remote fixture is implied by this verifier.

-- Human marketing planning / immutable lead attribution: exact allowlist only.
-- Re-runnable diagnostics. Four entry points execute, no table/client/helper access.
DO $$ DECLARE t text; f record; b record; r text;
BEGIN
 FOR t IN SELECT unnest(ARRAY['marketing_campaigns','marketing_campaign_versions','marketing_campaign_requests','crm_lead_attributions']) LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND (owner.rolsuper OR owner.rolbypassrls)
   AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee<>c.relowner) safe
  INTO b FROM pg_class c JOIN pg_roles owner ON owner.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe campaign private table: %',t; END IF;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
  ('hon.resolve_campaign_scope(text,text)',true,true),
  ('hon.mutate_campaign(text,text,uuid,jsonb,text,uuid,uuid)',true,true),
  ('hon.read_campaigns(text,text,uuid,text,text,integer)',true,true),
  ('hon.authorize_campaign_lead(text,boolean)',true,true),
  ('hon.guard_campaign_history()',false,false),
  ('hon.validate_campaign_window(text,text,boolean)',false,false),
  ('hon.validate_campaign_input(jsonb,boolean)',false,false),
  ('hon.campaign_summary(uuid)',false,true),
  ('hon.guard_campaign_record()',false,false),
  ('hon.require_campaign_actor(text,text)',false,true),
  ('hon.lock_campaign_actor(text,text)',false,true),
  ('hon.capture_lead_attribution()',false,true),
  ('hon.guard_campaign_evidence_insert()',false,true),
  ('hon.check_campaign_current_version()',false,true)
 ) e(signature,can_execute,definer) LOOP
  SELECT (owner.rolsuper OR owner.rolbypassrls) AND p.prosecdef=f.definer AND p.provolatile='v'
   AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
  INTO b FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe campaign function: %',f.signature; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_function_privilege(r,f.signature,'EXECUTE') THEN RAISE EXCEPTION 'Client campaign function access: %',r; END IF;
  END LOOP;
 END LOOP;
 FOR t IN SELECT unnest(ARRAY['marketing_campaigns','marketing_campaign_versions','marketing_campaign_requests','crm_lead_attributions','users','principals','roles','permissions','role_permissions','principal_role_grants','family_access_grants','organizations','schools','hq_operator_grants','crm_activities','hq_ai_provider_connections','hq_ai_control_requests']) LOOP
  IF has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Forbidden runtime campaign/directory/HQ access: %',t; END IF;
 END LOOP;
END $$;
-- Local isolated proof: pnpm db:test-marketing-campaigns. Never targets production.

-- Public form exact ACL/RLS verification (no PUBLIC execute is required).
DO $$ DECLARE t text; f record; b record; r text;
BEGIN
 FOR t IN SELECT unnest(ARRAY['public_lead_forms','public_lead_form_versions','public_lead_form_requests','public_lead_form_receipts','public_lead_form_rates']) LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND (owner.rolsuper OR owner.rolbypassrls)
   AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee<>c.relowner) safe
  INTO b FROM pg_class c JOIN pg_roles owner ON owner.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe public form private table: %',t; END IF;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
  ('hon.resolve_public_form_scope(text,text)',true,true),
  ('hon.read_public_forms(text)',true,true),
  ('hon.mutate_public_form(text,text,uuid,jsonb,text,uuid,uuid)',true,true),
  ('hon.read_published_form(text)',true,true),
  ('hon.submit_public_form(text,jsonb,text)',true,true),
  ('hon.validate_public_form_config(jsonb)',false,false),
  ('hon.require_public_form_actor(text,text)',false,true),
  ('hon.lock_public_form_actor(text,text)',false,true),
  ('hon.public_form_staff_summary(uuid)',false,true),
  ('hon.validate_public_form_submission(jsonb,jsonb)',false,false),
  ('hon.take_public_form_rate(uuid,text,integer)',false,true),
  ('hon.create_public_form_lead(uuid,uuid,jsonb,uuid)',false,true),
  ('hon.guard_public_form_record()',false,true),
  ('hon.check_public_form_version()',false,true)
 ) e(signature,can_execute,definer) LOOP
  SELECT (owner.rolsuper OR owner.rolbypassrls) AND p.prosecdef=f.definer AND p.provolatile='v'
   AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
  INTO b FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe public form function: %',f.signature; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_function_privilege(r,f.signature,'EXECUTE') THEN RAISE EXCEPTION 'Client public form function access: %',r; END IF;
  END LOOP;
 END LOOP;
 FOR t IN SELECT unnest(ARRAY['public_lead_forms','public_lead_form_versions','public_lead_form_requests','public_lead_form_receipts','public_lead_form_rates','users','principals','roles','permissions','role_permissions','principal_role_grants','family_access_grants','organizations','schools','hq_operator_grants','crm_activities','hq_ai_provider_connections','hq_ai_control_requests']) LOOP
  IF has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Forbidden runtime public form/directory/HQ access: %',t; END IF;
 END LOOP;
END $$;

-- Form provenance is a trigger-backed invariant, not only a function ACL check.
DO $$ DECLARE expected record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('public_lead_forms','public_form_identity_guard','hon.guard_public_form_record()',false),
  ('public_lead_forms','public_form_no_truncate','hon.guard_public_form_record()',false),
  ('public_lead_forms','public_form_current_version','hon.check_public_form_version()',true),
  ('public_lead_form_versions','public_form_version_coherent','hon.check_public_form_version()',false),
  ('public_lead_form_versions','public_form_versions_immutable','hon.guard_campaign_history()',false),
  ('public_lead_form_versions','public_form_versions_no_truncate','hon.guard_campaign_history()',false),
  ('public_lead_form_requests','public_form_requests_immutable','hon.guard_campaign_history()',false),
  ('public_lead_form_requests','public_form_requests_no_truncate','hon.guard_campaign_history()',false),
  ('public_lead_form_receipts','public_form_receipts_no_update','hon.guard_campaign_history()',false),
  ('crm_leads','lead_source_snapshot','hon.capture_lead_attribution()',false),
  ('crm_leads','lead_source_immutable','hon.capture_lead_attribution()',false),
  ('crm_lead_attributions','lead_attributions_immutable','hon.guard_campaign_history()',false),
  ('crm_lead_attributions','lead_attributions_no_truncate','hon.guard_campaign_history()',false),
  ('crm_lead_attributions','lead_attribution_coherent','hon.guard_campaign_evidence_insert()',false)
 ) e(tablename,triggername,signature,deferred) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tablename)::regclass AND tgname=expected.triggername AND tgfoid=expected.signature::regprocedure AND tgenabled='O' AND NOT tgisinternal AND tgdeferrable=expected.deferred AND tginitdeferred=expected.deferred) THEN RAISE EXCEPTION 'Unsafe public form provenance trigger: %',expected.triggername; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000075' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active)
  OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000075')
  OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id='00000000-0000-4000-8000-000000000075')
  OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id='00000000-0000-4000-8000-000000000075') THEN RAISE EXCEPTION 'Unsafe public form intake principal'; END IF;
END $$;

-- Human staff planning exact verification: three boundaries, no tables or directory.
DO $$ DECLARE t text; f record; b record; r text; expected record;
BEGIN
 FOR t IN SELECT unnest(ARRAY['staff_profiles','staff_planning_revisions','staff_planning_requests']) LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND (owner.rolsuper OR owner.rolbypassrls)
   AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee<>c.relowner) safe
  INTO b FROM pg_class c JOIN pg_roles owner ON owner.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe staff planning private table: %',t; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_table_privilege(r,'hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r,'hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Client staff table access: %',r; END IF;
  END LOOP;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
  ('hon.resolve_staff_availability_scope(text,text)',true,true),
  ('hon.save_staff_planning_revision(text,uuid,text,jsonb,text,uuid,uuid)',true,true),
  ('hon.read_staff_availability(text,uuid,text,integer)',true,true),
  ('hon.guard_staff_planning_history()',false,false),
  ('hon.validate_staff_planning_input(text,jsonb)',false,false),
  ('hon.staff_member_eligible(uuid,uuid,uuid)',false,true),
  ('hon.staff_has_planning_permission(uuid,uuid,uuid,text)',false,true),
  ('hon.require_staff_planning_actor(text,uuid,text)',false,true),
  ('hon.lock_staff_planning_actor(text,uuid,text)',false,true),
  ('hon.staff_revision_summary(uuid,text,integer)',false,true),
  ('hon.guard_staff_profile_insert()',false,true),
  ('hon.guard_staff_revision_insert()',false,true)
 ) e(signature,can_execute,definer) LOOP
  SELECT (owner.rolsuper OR owner.rolbypassrls) AND p.prosecdef=f.definer AND p.provolatile='v'
   AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
  INTO b FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe staff planning function: %',f.signature; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_function_privilege(r,f.signature,'EXECUTE') THEN RAISE EXCEPTION 'Client staff function access: %',r; END IF;
  END LOOP;
 END LOOP;
 FOR t IN SELECT unnest(ARRAY['staff_profiles','staff_planning_revisions','staff_planning_requests','users','principals','roles','permissions','role_permissions','principal_role_grants','family_access_grants','organizations','schools','hq_operator_grants']) LOOP
  IF has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Forbidden runtime staff/directory access: %',t; END IF;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
  ('staff_profiles','staff_profiles_immutable','hon.guard_staff_planning_history()',27),
  ('staff_profiles','staff_profiles_no_truncate','hon.guard_staff_planning_history()',34),
  ('staff_profiles','staff_profile_insert_guard','hon.guard_staff_profile_insert()',7),
  ('staff_planning_revisions','staff_revisions_immutable','hon.guard_staff_planning_history()',27),
  ('staff_planning_revisions','staff_revisions_no_truncate','hon.guard_staff_planning_history()',34),
  ('staff_planning_revisions','staff_revision_insert_guard','hon.guard_staff_revision_insert()',7),
  ('staff_planning_requests','staff_requests_immutable','hon.guard_staff_planning_history()',27),
  ('staff_planning_requests','staff_requests_no_truncate','hon.guard_staff_planning_history()',34)
 ) e(tablename,triggername,signature,trigger_type) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tablename)::regclass AND tgname=expected.triggername AND tgfoid=expected.signature::regprocedure AND tgtype=expected.trigger_type AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred) THEN RAISE EXCEPTION 'Unsafe staff planning invariant trigger: %',expected.triggername; END IF;
 END LOOP;
END $$;
-- End human staff planning verification.
-- Inert automation exact verification: four boundaries, no execution.
DO $$ DECLARE t text; f record; b record; r text; expected record;
BEGIN
 FOR t IN SELECT unnest(ARRAY['automation_rules','automation_rule_versions','automation_rule_requests']) LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND (owner.rolsuper OR owner.rolbypassrls)
   AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee<>c.relowner) safe
  INTO b FROM pg_class c JOIN pg_roles owner ON owner.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe automation configuration private table: %',t; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_table_privilege(r,'hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r,'hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Client automation table access: %',r; END IF;
  END LOOP;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
  ('hon.resolve_automation_rule_scope(text,text)',true,true),
  ('hon.save_automation_rule(text,uuid,jsonb,text,uuid,uuid)',true,true),
  ('hon.read_automation_rules(text,uuid,integer)',true,true),
  ('hon.dry_run_automation_rule(text,uuid,jsonb)',true,true),
  ('hon.guard_automation_history()',false,false),
  ('hon.automation_closed(jsonb,text[])',false,false),
  ('hon.validate_automation_input(jsonb,boolean)',false,false),
  ('hon.automation_has_permission(uuid,uuid,uuid,text)',false,true),
  ('hon.require_automation_actor(text,text)',false,true),
  ('hon.lock_automation_actor(text,text)',false,true),
  ('hon.automation_rule_summary(uuid,integer)',false,true),
  ('hon.guard_automation_insert()',false,true),
  ('hon.plan_automation_descriptor(jsonb,jsonb)',false,false)
 ) e(signature,can_execute,definer) LOOP
  SELECT (owner.rolsuper OR owner.rolbypassrls) AND p.prosecdef=f.definer AND p.provolatile='v'
   AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
  INTO b FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe automation configuration function: %',f.signature; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_function_privilege(r,f.signature,'EXECUTE') THEN RAISE EXCEPTION 'Client automation function access: %',r; END IF;
  END LOOP;
 END LOOP;
 FOR t IN SELECT unnest(ARRAY['automation_rules','automation_rule_versions','automation_rule_requests','users','principals','roles','permissions','role_permissions','principal_role_grants','family_access_grants','organizations','schools','hq_operator_grants']) LOOP
  IF has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Forbidden runtime automation/directory access: %',t; END IF;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
  ('automation_rules','automation_rules_immutable','hon.guard_automation_history()',27),
  ('automation_rules','automation_rules_no_truncate','hon.guard_automation_history()',34),
  ('automation_rules','automation_rule_insert_guard','hon.guard_automation_insert()',7),
  ('automation_rule_versions','automation_versions_immutable','hon.guard_automation_history()',27),
  ('automation_rule_versions','automation_versions_no_truncate','hon.guard_automation_history()',34),
  ('automation_rule_versions','automation_version_insert_guard','hon.guard_automation_insert()',7),
  ('automation_rule_requests','automation_requests_immutable','hon.guard_automation_history()',27),
  ('automation_rule_requests','automation_requests_no_truncate','hon.guard_automation_history()',34)
 ) e(tablename,triggername,signature,trigger_type) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tablename)::regclass AND tgname=expected.triggername AND tgfoid=expected.signature::regprocedure AND tgtype=expected.trigger_type AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred) THEN RAISE EXCEPTION 'Unsafe automation configuration invariant trigger: %',expected.triggername; END IF;
 END LOOP;
END $$;
-- End inert automation verification.

-- Human follow-up exact verification: three boundaries, no execution.
DO $$ DECLARE t text; f record; b record; r text; expected record;
BEGIN
 FOR t IN SELECT unnest(ARRAY['crm_follow_ups','crm_follow_up_versions','crm_follow_up_requests']) LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND (owner.rolsuper OR owner.rolbypassrls)
   AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee<>c.relowner) safe
  INTO b FROM pg_class c JOIN pg_roles owner ON owner.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe follow-up private table: %',t; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_table_privilege(r,'hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r,'hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Client automation table access: %',r; END IF;
  END LOOP;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
  ('hon.resolve_follow_up_scope(text)',true,true),
  ('hon.mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid)',true,true),
  ('hon.read_follow_ups(text,uuid,text,text,uuid)',true,true),
  ('hon.guard_follow_up_history()',false,false),
  ('hon.validate_follow_up_input(text,jsonb)',false,false),
  ('hon.follow_up_has_permission(uuid,uuid,uuid,text)',false,true),
  ('hon.require_follow_up_actor(text)',false,true),
  ('hon.lock_follow_up_actor(text,uuid)',false,true),
  ('hon.follow_up_authorized(uuid,uuid)',false,true),
  ('hon.follow_up_summary(uuid,integer)',false,true),
  ('hon.guard_follow_up_insert()',false,true)
 ) e(signature,can_execute,definer) LOOP
  SELECT (owner.rolsuper OR owner.rolbypassrls) AND p.prosecdef=f.definer AND p.provolatile='v'
   AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
  INTO b FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe follow-up function: %',f.signature; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_function_privilege(r,f.signature,'EXECUTE') THEN RAISE EXCEPTION 'Client automation function access: %',r; END IF;
  END LOOP;
 END LOOP;
 FOR t IN SELECT unnest(ARRAY['crm_follow_ups','crm_follow_up_versions','crm_follow_up_requests','users','principals','roles','permissions','role_permissions','principal_role_grants','family_access_grants','organizations','schools','hq_operator_grants']) LOOP
  IF has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Forbidden runtime follow-up/directory access: %',t; END IF;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
  ('crm_follow_ups','follow_ups_immutable','hon.guard_follow_up_history()',27),
  ('crm_follow_ups','follow_ups_no_truncate','hon.guard_follow_up_history()',34),
  ('crm_follow_ups','follow_up_insert_guard','hon.guard_follow_up_insert()',7),
  ('crm_follow_up_versions','follow_up_versions_immutable','hon.guard_follow_up_history()',27),
  ('crm_follow_up_versions','follow_up_versions_no_truncate','hon.guard_follow_up_history()',34),
  ('crm_follow_up_versions','follow_up_version_insert_guard','hon.guard_follow_up_insert()',7),
  ('crm_follow_up_requests','follow_up_requests_immutable','hon.guard_follow_up_history()',27),
  ('crm_follow_up_requests','follow_up_requests_no_truncate','hon.guard_follow_up_history()',34)
 ) e(tablename,triggername,signature,trigger_type) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tablename)::regclass AND tgname=expected.triggername AND tgfoid=expected.signature::regprocedure AND tgtype=expected.trigger_type AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred) THEN RAISE EXCEPTION 'Unsafe follow-up invariant trigger: %',expected.triggername; END IF;
 END LOOP;
END $$;
-- End human follow-up verification.

-- Human renewal exact verification: five boundaries, no execution.
DO $$ DECLARE t text; f record; b record; r text; expected record;
BEGIN
 FOR t IN SELECT unnest(ARRAY['membership_renewal_reviews','membership_renewal_versions','membership_renewal_requests']) LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND (owner.rolsuper OR owner.rolbypassrls)
   AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee<>c.relowner) safe
  INTO b FROM pg_class c JOIN pg_roles owner ON owner.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe renewal private table: %',t; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_table_privilege(r,'hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r,'hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Client automation table access: %',r; END IF;
  END LOOP;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
  ('hon.resolve_renewal_scope(text)',true,true),
  ('hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid)',true,true),
  ('hon.read_renewals(text,uuid,text,uuid,integer)',true,true),
  ('hon.read_renewal_membership(text,uuid)',true,true),
  ('hon.read_renewal_history(text,uuid,integer)',true,true),
  ('hon.guard_renewal_history()',false,false),
  ('hon.validate_renewal_input(text,jsonb)',false,false),
  ('hon.renewal_has_permission(uuid,uuid,uuid,text)',false,true),
  ('hon.require_renewal_actor(text)',false,true),
  ('hon.lock_renewal_actor(text)',false,true),
  ('hon.renewal_membership_facts(uuid)',false,true),
  ('hon.renewal_summary(uuid,integer)',false,true),
  ('hon.guard_renewal_insert()',false,true)
 ) e(signature,can_execute,definer) LOOP
  SELECT (owner.rolsuper OR owner.rolbypassrls) AND p.prosecdef=f.definer AND p.provolatile='v'
   AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
  INTO b FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b.safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe renewal function: %',f.signature; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_function_privilege(r,f.signature,'EXECUTE') THEN RAISE EXCEPTION 'Client automation function access: %',r; END IF;
  END LOOP;
 END LOOP;
 FOR t IN SELECT unnest(ARRAY['membership_renewal_reviews','membership_renewal_versions','membership_renewal_requests','users','principals','roles','permissions','role_permissions','principal_role_grants','family_access_grants','organizations','schools','hq_operator_grants']) LOOP
  IF has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Forbidden runtime renewal/directory access: %',t; END IF;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
  ('membership_renewal_reviews','renewal_reviews_immutable','hon.guard_renewal_history()',27),
  ('membership_renewal_reviews','renewal_reviews_no_truncate','hon.guard_renewal_history()',34),
  ('membership_renewal_reviews','renewal_review_insert_guard','hon.guard_renewal_insert()',7),
  ('membership_renewal_versions','renewal_versions_immutable','hon.guard_renewal_history()',27),
  ('membership_renewal_versions','renewal_versions_no_truncate','hon.guard_renewal_history()',34),
  ('membership_renewal_versions','renewal_version_insert_guard','hon.guard_renewal_insert()',7),
  ('membership_renewal_requests','renewal_requests_immutable','hon.guard_renewal_history()',27),
  ('membership_renewal_requests','renewal_requests_no_truncate','hon.guard_renewal_history()',34)
 ) e(tablename,triggername,signature,trigger_type) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tablename)::regclass AND tgname=expected.triggername AND tgfoid=expected.signature::regprocedure AND tgtype=expected.trigger_type AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred) THEN RAISE EXCEPTION 'Unsafe renewal invariant trigger: %',expected.triggername; END IF;
 END LOOP;
END $$;
-- End human renewal verification.

-- Closed human owner community verification: exact ACLs, no policies, immutable history.
DO $$ DECLARE t text; f record; r record; b boolean; trigger_name text; trigger_type integer; BEGIN
 FOR t IN SELECT unnest(ARRAY['community_verifications','community_organizations','community_members','community_profiles','community_content','community_versions','community_requests','community_events']) LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee<>c.relowner)
  INTO b FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe community table %',t; END IF;
  IF t<>'community_verifications' THEN
   FOR trigger_name,trigger_type IN SELECT * FROM (VALUES('community_immutable',27),('community_no_truncate',34)) v(n,k) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgname=trigger_name AND tgtype=trigger_type AND tgfoid='hon.guard_community_history()'::regprocedure AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred) THEN RAISE EXCEPTION 'Unsafe community trigger %.%',t,trigger_name; END IF;
   END LOOP;
  END IF;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
 ('hon.guard_community_history()',false,false),
 ('hon.community_permission(uuid,uuid,uuid,text)',false,true),
 ('hon.resolve_community_scope(text,uuid)',true,true),
 ('hon.community_member_active(uuid)',false,true),
 ('hon.require_community_actor(text,boolean)',false,true),
 ('hon.lock_community_actor(text,boolean)',false,true),
 ('hon.community_text(text,integer,boolean,boolean)',false,false),
 ('hon.validate_community_input(text,jsonb)',false,false),
 ('hon.community_visible(uuid,uuid,integer)',false,true),
 ('hon.community_projection(uuid,uuid,integer)',false,true),
 ('hon.read_community_profile(text)',true,true),
 ('hon.mutate_community(text,text,uuid,jsonb,text,uuid)',true,true),
 ('hon.read_community(text,text,uuid,uuid,uuid)',true,true),
 ('hon.read_community_history(text,uuid,integer)',true,true)
 ) v(signature,can_execute,is_definer) LOOP
  SELECT p.prosecdef=f.is_definer AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
  INTO b FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe community function %',f.signature; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_function_privilege(r.rolname,f.signature,'EXECUTE') THEN RAISE EXCEPTION 'Forbidden client community function %',r.rolname; END IF;
  END LOOP;
 END LOOP;
END $$;

-- Human Action Engine approvals: exact new read/lock function minima, immutable
-- intent/evidence, boolean-only tenant-bound CRM target revalidation, and
-- qualified school-bound evidence SELECT. No execution grant.
DO $$ DECLARE f record; t record; p record; b boolean; priv text; trigger_name text; trigger_type integer;
BEGIN
 FOR f IN SELECT * FROM (VALUES
 ('hon.require_human_action_review(text,uuid)',true,true,false),
 ('hon.human_action_reviewer()',true,true,false),
 ('hon.crm_lead_target_is_current(uuid,uuid)',true,true,true),
 ('hon.guard_action_review_immutability()',false,false,false)) v(signature,can_execute,is_definer,boolean_result) LOOP
 SELECT x.prosecdef=f.is_definer AND x.provolatile='v' AND x.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (NOT f.boolean_result OR x.prorettype='bool'::regtype) AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
 AND has_function_privilege('hon_runtime',x.oid,'EXECUTE')=f.can_execute
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(x.proacl,acldefault('f',x.proowner))) a WHERE a.grantee<>x.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
 INTO b FROM pg_proc x JOIN pg_roles o ON o.oid=x.proowner WHERE x.oid=f.signature::regprocedure;
 IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe action approval function %',f.signature; END IF;
 END LOOP;
 FOR t IN SELECT * FROM (VALUES ('action_requests',ARRAY['SELECT','INSERT','UPDATE']),('action_approvals',ARRAY['SELECT','INSERT']),('action_policies',ARRAY['SELECT'])) v(name,privileges) LOOP
 SELECT c.relrowsecurity AND c.relforcerowsecurity
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.privilege_type<>ALL(t.privileges) OR a.is_grantable))
 AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
 INTO b FROM pg_class c WHERE c.oid=('hon.'||t.name)::regclass;
 IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe action approval table %',t.name; END IF;
 FOREACH priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
 IF has_table_privilege('hon_runtime','hon.'||t.name,priv) IS DISTINCT FROM (priv=ANY(t.privileges)) THEN RAISE EXCEPTION 'Wrong approval minimum %.%',t.name,priv; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_policy WHERE polrelid=('hon.'||t.name)::regclass)<>(CASE WHEN t.name='action_approvals' THEN 2 ELSE 1 END) THEN RAISE EXCEPTION 'Wrong approval policy count %',t.name; END IF;
 SELECT polpermissive AND polcmd='*'
 AND regexp_replace(pg_get_expr(polqual,polrelid),'[[:space:]()]','','g')='organization_id=hon.current_organization_idANDschool_id=hon.current_school_id'
 AND regexp_replace(pg_get_expr(polwithcheck,polrelid),'[[:space:]()]','','g')='organization_id=hon.current_organization_idANDschool_id=hon.current_school_id'
 INTO b FROM pg_policy WHERE polrelid=('hon.'||t.name)::regclass AND polname=t.name||'_tenant_isolation';
 IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe action approval tenant policy %',t.name; END IF;
 END LOOP;
 SELECT NOT polpermissive AND polcmd='r' AND regexp_replace(pg_get_expr(polqual,polrelid),'[[:space:]()]','','g')='hon.human_action_reviewer'
 INTO b FROM pg_policy WHERE polrelid='hon.action_approvals'::regclass AND polname='action_approvals_qualified_read';
 IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe qualified approval evidence policy'; END IF;
 FOR t IN SELECT * FROM (VALUES('action_requests','action_request_immutable',27),('action_requests','action_request_no_truncate',34),('action_approvals','action_approval_immutable',27),('action_approvals','action_approval_no_truncate',34)) v(name,trig,kind) LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||t.name)::regclass AND tgname=t.trig AND tgtype=t.kind AND tgfoid='hon.guard_action_review_immutability()'::regprocedure AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred) THEN RAISE EXCEPTION 'Unsafe action approval trigger %.%',t.name,t.trig; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.action_approvals'::regclass AND conname='action_approvals_request_tenant_fk' AND contype='f' AND convalidated) THEN RAISE EXCEPTION 'Missing scoped approval proposal FK'; END IF;
END $$;

-- Complete voice handoff: two human entrypoints only, private references/drafts.
DO $$ DECLARE f record; t text; b boolean; x record;
BEGIN
 FOR f IN SELECT * FROM (VALUES
 ('hon.guard_voice_history()',false,false),('hon.require_voice_actor(text)',false,true),
 ('hon.require_voice_references(uuid,uuid,uuid)',false,true),('hon.voice_session_snapshot(uuid)',false,true),
 ('hon.read_voice_session(text,uuid)',true,true),('hon.mutate_voice_session(text,text,uuid,jsonb,uuid,uuid,uuid)',true,true)) v(signature,can_execute,is_definer) LOOP
 SELECT p.prosecdef=f.is_definer AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[]
 AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime' AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
 INTO b FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
 IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe voice function %',f.signature; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['voice_sessions','voice_session_requests'] LOOP
 SELECT c.relrowsecurity AND c.relforcerowsecurity
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=c.oid AND acl.grantee<>c.relowner)
 AND NOT has_table_privilege('hon_runtime',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 AND NOT has_any_column_privilege('hon_runtime',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
 INTO b FROM pg_class c WHERE c.oid=('hon.'||t)::regclass;
 IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe private voice table %',t; END IF;
 IF (SELECT count(*) FROM pg_policy WHERE polrelid=('hon.'||t)::regclass)<>1 THEN RAISE EXCEPTION 'Unsafe voice policy count %',t; END IF;
 SELECT polpermissive AND polcmd='*' AND pg_get_expr(polqual,polrelid)='false' AND pg_get_expr(polwithcheck,polrelid)='false'
 INTO b FROM pg_policy WHERE polrelid=('hon.'||t)::regclass AND polname=t||'_deny_all';
 IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe deny-all voice policy %',t; END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES
 ('voice_sessions','voice_session_guard',27),('voice_sessions','voice_session_no_truncate',34),
 ('voice_session_requests','voice_request_guard',27),('voice_session_requests','voice_request_no_truncate',34)) v(tab,trig,kind) LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||x.tab)::regclass AND tgname=x.trig AND tgtype=x.kind AND tgfoid='hon.guard_voice_history()'::regprocedure AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred) THEN RAISE EXCEPTION 'Unsafe voice trigger %',x.trig; END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES
 ('voice_sessions','schools'),('voice_sessions','work_items'),('voice_sessions','action_requests'),
 ('voice_sessions','action_approvals'),('voice_sessions','voice_sessions'),('voice_session_requests','voice_sessions')) v(tab,ref) LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=('hon.'||x.tab)::regclass AND confrelid=('hon.'||x.ref)::regclass AND contype='f' AND convalidated AND NOT condeferrable AND array_length(conkey,1)>=2) THEN RAISE EXCEPTION 'Missing voice scope FK %.%',x.tab,x.ref; END IF;
 END LOOP;
 IF (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='hon.voice_sessions'::regclass AND attnum>0 AND NOT attisdropped)<>ARRAY['id','organization_id','school_id','actor_principal_id','agent_catalog_id','work_item_id','action_request_id','approval_id','resume_session_id','state','reason_code','version','draft_text','created_at','updated_at','expires_at']
 OR (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='hon.voice_session_requests'::regclass AND attnum>0 AND NOT attisdropped)<>ARRAY['organization_id','school_id','actor_principal_id','idempotency_key','request_fingerprint','session_id','receipt_version','created_at'] THEN RAISE EXCEPTION 'Expanded voice data surface'; END IF;
END $$;

-- Conventional human work independent deny-all ACL/definer/trigger checks.
DO $$ DECLARE t text; x record; safe boolean; BEGIN
 FOREACH t IN ARRAY ARRAY['work_items','human_work_history','human_work_requests'] LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity
   AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=c.relname)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=c.oid AND acl.grantee<>c.relowner)
   AND NOT has_table_privilege('hon_runtime',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   AND NOT has_any_column_privilege('hon_runtime',c.oid,'SELECT,INSERT,UPDATE,REFERENCES') INTO safe FROM pg_class c WHERE c.oid=format('hon.%I',t)::regclass;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe private human work table %',t; END IF;
 END LOOP;
 FOR x IN SELECT * FROM(VALUES
 ('hon.guard_human_work_history()',false,false,'v'),
 ('hon.validate_human_work(text,jsonb)',false,false,'v'),
 ('hon.human_work_permission(uuid,uuid,uuid,text)',false,true,'v'),
 ('hon.resolve_human_work_scope(text)',true,true,'v'),
 ('hon.require_human_work_actor(text)',false,true,'v'),
 ('hon.lock_human_work_actor(text,uuid[])',false,true,'v'),
 ('hon.human_work_visible(uuid,hon.work_items)',false,true,'v'),
 ('hon.human_work_transition_allowed(text,text)',false,false,'i'),
 ('hon.human_work_snapshot(uuid,integer,uuid,integer)',false,true,'v'),
 ('hon.guard_human_work_row()',false,false,'v'),
 ('hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid)',true,true,'v'),
 ('hon.read_human_work(text,uuid,text,text,uuid,integer)',true,true,'v'),
 ('hon.lock_ai_planning_work_reference(uuid)',true,true,'v')
 )v(signature,allowed,definer,volatility) LOOP
  SELECT p.prosecdef=x.definer AND p.provolatile=x.volatility::"char" AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[]
   AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=x.allowed
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT x.allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
  INTO safe FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=x.signature::regprocedure;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe human work function %',x.signature; END IF;
 END LOOP;
 FOR x IN SELECT * FROM(VALUES
  ('work_items','human_work_row_guard','hon.guard_human_work_row()'),('work_items','human_work_no_truncate','hon.guard_human_work_row()'),
  ('human_work_history','human_work_history_immutable','hon.guard_human_work_history()'),('human_work_history','human_work_history_no_truncate','hon.guard_human_work_history()'),
  ('human_work_requests','human_work_requests_immutable','hon.guard_human_work_history()'),('human_work_requests','human_work_requests_no_truncate','hon.guard_human_work_history()')
 )v(tbl,trg,fn) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=format('hon.%I',x.tbl)::regclass AND tgname=x.trg AND tgenabled='O' AND tgfoid=x.fn::regprocedure) THEN RAISE EXCEPTION 'Missing human work trigger %',x.trg; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['human_work_shape','work_items_version_positive','work_items_id_tenant_unique'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.work_items'::regclass AND conname=t AND convalidated) THEN RAISE EXCEPTION 'Missing human work constraint %',t; END IF;
 END LOOP;
END $$;

-- Marketplace canonical fail-closed ACL/RLS verification.
-- Closed human owner marketplace verification: exact ACLs, no policies, immutable history.
DO $$ DECLARE t text; f record; r record; b boolean; trigger_name text; trigger_type integer; BEGIN
 FOR t IN SELECT unnest(ARRAY['marketplace_assets','marketplace_versions','marketplace_curations','marketplace_selections','marketplace_requests','marketplace_events','marketplace_outbox']) LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee<>c.relowner)
  INTO b FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe marketplace table %',t; END IF;
  IF true THEN
   FOR trigger_name,trigger_type IN SELECT * FROM (VALUES('marketplace_immutable',27),('marketplace_no_truncate',34)) v(n,k) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgname=trigger_name AND tgtype=trigger_type AND tgfoid='hon.guard_marketplace_history()'::regprocedure AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred) THEN RAISE EXCEPTION 'Unsafe marketplace trigger %.%',t,trigger_name; END IF;
   END LOOP;
  END IF;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
('hon.guard_marketplace_history()',false,false),
 ('hon.marketplace_permission(uuid,uuid,uuid,text)',false,true),
 ('hon.resolve_marketplace_scope(text,uuid)',true,true),
 ('hon.require_marketplace_actor(text,text)',false,true),
 ('hon.lock_marketplace_member(uuid)',false,true),
 ('hon.lock_marketplace_actor(text,text)',false,true),
 ('hon.marketplace_text(text,integer)',false,false),
 ('hon.validate_marketplace_input(text,jsonb)',false,false),
 ('hon.review_marketplace_asset(uuid,integer,text)',false,false),
 ('hon.marketplace_visible(uuid,integer)',false,true),
 ('hon.marketplace_projection(uuid,integer)',false,true),
 ('hon.marketplace_selection_projection(uuid)',false,true),
 ('hon.read_marketplace(text,text,uuid,uuid,integer)',true,true),
 ('hon.mutate_marketplace(text,text,uuid,jsonb,text,uuid)',true,true)
 ) v(signature,can_execute,is_definer) LOOP
  SELECT p.prosecdef=f.is_definer AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
  INTO b FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe marketplace function %',f.signature; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_function_privilege(r.rolname,f.signature,'EXECUTE') THEN RAISE EXCEPTION 'Forbidden client marketplace function %',r.rolname; END IF;
  END LOOP;
 END LOOP;
END $$;

-- Permanent marketplace review-only and inert-outbox constraints cannot be relaxed.
DO $$ DECLARE x record; BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('marketplace_selections','marketplace_selections_enabled_check','CHECK ((NOT enabled))'),
  ('marketplace_selections','marketplace_selections_status_check',$definition$CHECK ((status = 'REQUIRES_REVIEW'::text))$definition$),
  ('marketplace_selections','marketplace_selections_version_check','CHECK ((version = 1))'),
  ('marketplace_outbox','marketplace_outbox_execution_allowed_check','CHECK ((NOT execution_allowed))'),
  ('marketplace_outbox','marketplace_outbox_status_check',$definition$CHECK ((status = 'INERT'::text))$definition$)
 ) v(tbl,name,definition) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=format('hon.%I',x.tbl)::regclass AND conname=x.name AND contype='c' AND convalidated AND pg_get_constraintdef(oid)=x.definition) THEN RAISE EXCEPTION 'Unsafe permanent marketplace constraint %.%',x.tbl,x.name; END IF;
 END LOOP;
END $$;

-- Closed human student achievement verification: exact ACLs, no policies, immutable history.
DO $$ DECLARE t text; f record; r record; b boolean; trigger_name text; trigger_type integer; BEGIN
 FOR t IN SELECT unnest(ARRAY['achievement_definitions','achievement_definition_versions','achievement_awards','achievement_award_versions','achievement_requests','achievement_events','achievement_outbox']) LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee<>c.relowner)
  INTO b FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe achievement table %',t; END IF;
  IF true THEN
   FOR trigger_name,trigger_type IN SELECT * FROM (VALUES('achievement_immutable',27),('achievement_no_truncate',34)) v(n,k) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgname=trigger_name AND tgtype=trigger_type AND tgfoid='hon.guard_achievement_history()'::regprocedure AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred) THEN RAISE EXCEPTION 'Unsafe achievement trigger %.%',t,trigger_name; END IF;
   END LOOP;
  END IF;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
 ('hon.guard_achievement_history()',false,false),
 ('hon.achievement_text(text,integer,boolean)',false,false),
 ('hon.achievement_permission(uuid,uuid,uuid,text)',false,true),
 ('hon.resolve_achievement_scope(text,uuid)',true,true),
 ('hon.require_achievement_actor(text,text)',false,true),
 ('hon.lock_achievement_actor(text,text,boolean)',false,true),
 ('hon.lock_achievement_student(uuid)',false,true),
 ('hon.validate_achievement_input(text,jsonb)',false,false),
 ('hon.achievement_definition_projection(uuid,integer)',false,true),
 ('hon.achievement_award_projection(uuid,integer,boolean)',false,true),
 ('hon.read_achievements(text,text,uuid,uuid,uuid,integer)',true,true),
 ('hon.mutate_achievements(text,text,uuid,uuid,jsonb,text,uuid,uuid)',true,true),
 ('hon.require_parent_achievement_actor(text,uuid,uuid)',false,true),
 ('hon.read_parent_achievements(text,uuid,uuid,uuid)',true,true)
 ) v(signature,can_execute,is_definer) LOOP
  SELECT p.prosecdef=f.is_definer AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
  INTO b FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe achievement function %',f.signature; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_function_privilege(r.rolname,f.signature,'EXECUTE') THEN RAISE EXCEPTION 'Forbidden client achievement function %',r.rolname; END IF;
  END LOOP;
 END LOOP;
END $$;

-- Permanent achievement review-only and inert-outbox constraints cannot be relaxed.
DO $$ DECLARE x record; BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('achievement_outbox','achievement_outbox_execution_allowed_check','CHECK ((NOT execution_allowed))'),
  ('achievement_outbox','achievement_outbox_status_check',$definition$CHECK ((status = 'INERT'::text))$definition$)
 ) v(tbl,name,definition) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=format('hon.%I',x.tbl)::regclass AND conname=x.name AND contype='c' AND convalidated AND pg_get_constraintdef(oid)=x.definition) THEN RAISE EXCEPTION 'Unsafe permanent achievement constraint %.%',x.tbl,x.name; END IF;
 END LOOP;
END $$;

-- Marketing Assistant exact verification:
-- Shared with db:verify-rls. This verifies posture, not provider readiness or execution.
DO $$ DECLARE t text; f record; b boolean; expected record;
BEGIN
 FOREACH t IN ARRAY ARRAY['marketing_ai_invocations','marketing_ai_drafts','marketing_campaign_content'] LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee<>c.relowner)
   INTO b FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Marketing Assistant private table: %',t; END IF;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
  ('hon.marketing_safe_text(text,integer)',false,false,'i','search_path=pg_catalog'),
  ('hon.marketing_owner(text)',false,true,'v','search_path=pg_catalog, hon'),
  ('hon.marketing_event(uuid,text)',false,true,'v','search_path=pg_catalog, hon'),
  ('hon.guard_marketing_invocation()',false,false,'v','search_path=pg_catalog, hon'),
  ('hon.read_marketing_invocation(text,uuid)',true,true,'v','search_path=pg_catalog, hon'),
  ('hon.begin_marketing_request(text,jsonb,uuid)',true,true,'v','search_path=pg_catalog, hon'),
  ('hon.prepare_marketing_invocation(text,uuid,uuid,boolean)',true,true,'v','search_path=pg_catalog, hon'),
  ('hon.fail_marketing_invocation(text,uuid,text,text)',true,true,'v','search_path=pg_catalog, hon'),
  ('hon.record_marketing_result(text,uuid,jsonb)',true,true,'v','search_path=pg_catalog, hon'),
  ('hon.bind_marketing_proposal(text,uuid,uuid)',true,true,'v','search_path=pg_catalog, hon'),
  ('hon.marketing_action_is_current(uuid,jsonb)',true,true,'v','search_path=pg_catalog, hon'),
  ('hon.reject_marketing_draft(uuid)',true,true,'v','search_path=pg_catalog, hon'),
  ('hon.save_approved_marketing_draft(text,uuid)',true,true,'v','search_path=pg_catalog, hon'),
  ('hon.marketing_planning_reference(text,uuid)',true,true,'v','search_path=pg_catalog, hon'),
  ('hon.read_marketing_campaign_content(text,uuid)',true,true,'v','search_path=pg_catalog, hon')
 ) e(signature,can_execute,definer,volatility,path) LOOP
  SELECT (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime' AND p.prosecdef=f.definer
   AND p.provolatile::text=f.volatility AND p.proconfig=ARRAY[f.path]::text[]
   AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
   INTO b FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Marketing Assistant function: %',f.signature; END IF;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
  ('marketing_ai_invocations','marketing_invocation_guard','hon.guard_marketing_invocation()',27),
  ('marketing_ai_invocations','marketing_invocation_no_truncate','hon.guard_marketing_invocation()',34),
  ('marketing_ai_drafts','marketing_draft_immutable','hon.guard_campaign_history()',27),
  ('marketing_ai_drafts','marketing_draft_no_truncate','hon.guard_campaign_history()',34),
  ('marketing_campaign_content','marketing_content_immutable','hon.guard_campaign_history()',27),
  ('marketing_campaign_content','marketing_content_no_truncate','hon.guard_campaign_history()',34)
 ) e(table_name,trigger_name,signature,trigger_type) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.table_name)::regclass
   AND tgname=expected.trigger_name AND tgfoid=expected.signature::regprocedure AND tgtype=expected.trigger_type
   AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred) THEN
   RAISE EXCEPTION 'Unsafe Marketing Assistant immutable trigger: %',expected.trigger_name;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='marketing.assistant.use' AND is_sensitive AND NOT is_staff_assignable) THEN
  RAISE EXCEPTION 'Unsafe Marketing Assistant permission registry';
 END IF;
END $$;
-- End Marketing Assistant verification.
