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

-- Human membership creation uses an RLS-bound SELECT plus a DRAFT-only column
-- INSERT (0177). Activation and direct ACTIVE-to-CANCELLED cancellation run only
-- inside protected definer functions: expected true, false, true, false, false.
-- DELETE, payment-attempt writes, and every payment-provider action remain unavailable.
SELECT
  has_table_privilege('hon_runtime', 'hon.memberships', 'SELECT') AS can_read_memberships,
  has_table_privilege('hon_runtime', 'hon.memberships', 'INSERT') AS can_insert_any_membership_column,
  has_column_privilege('hon_runtime', 'hon.memberships', 'plan_code', 'INSERT') AS can_insert_draft_columns,
  has_any_column_privilege('hon_runtime', 'hon.memberships', 'UPDATE') AS can_update_memberships,
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
FROM unnest(ARRAY['hq_ai_provider_connections','hq_ai_model_catalog','hq_ai_routing_policies','hq_ai_routing_candidates','hq_ai_task_profiles','hq_ai_task_profile_candidates','hq_ai_control_requests','hq_ai_control_audit','hq_ai_control_outbox']) AS table_name;
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
DECLARE projection record; role_name text;
BEGIN
 SELECT proc.prosecdef,proc.provolatile,proc.proconfig,r.rolsuper OR r.rolbypassrls AS trusted_owner,
   has_function_privilege('hon_runtime',proc.oid,'EXECUTE') AS runtime_execute,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(proc.proacl,acldefault('f',proc.proowner))) acl
    WHERE acl.grantee NOT IN(proc.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS broad,
   position('current_setting' IN pg_get_functiondef(proc.oid))=0 AS no_guc
 INTO projection FROM pg_proc proc JOIN pg_roles r ON r.oid=proc.proowner
 WHERE proc.oid='hon.read_school_command_center(text,uuid,uuid)'::regprocedure;
 IF projection.prosecdef IS DISTINCT FROM true OR projection.provolatile<>'s' OR projection.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
   OR projection.trusted_owner IS DISTINCT FROM true OR projection.runtime_execute IS DISTINCT FROM true OR projection.broad IS DISTINCT FROM false OR projection.no_guc IS DISTINCT FROM true THEN
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

-- 8c) School Health Score: fixed aggregate-only operational indicator. It has
-- no prediction, execution, or write path and receives only runtime EXECUTE.
SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolsuper OR r.rolbypassrls AS trusted_owner,
  has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS runtime_execute,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS forbidden_broad_execute,
  position('current_setting' IN pg_get_functiondef(p.oid)) = 0 AS no_caller_guc_authority
FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
WHERE p.oid='hon.read_school_health_score(text,uuid,uuid)'::regprocedure;
DO $$
DECLARE projection record; role_name text;
BEGIN
 SELECT proc.prosecdef,proc.provolatile,proc.proconfig,r.rolsuper OR r.rolbypassrls AS trusted_owner,
   has_function_privilege('hon_runtime',proc.oid,'EXECUTE') AS runtime_execute,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(proc.proacl,acldefault('f',proc.proowner))) acl
    WHERE acl.grantee NOT IN(proc.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS broad,
   position('current_setting' IN pg_get_functiondef(proc.oid))=0 AS no_guc
 INTO projection FROM pg_proc proc JOIN pg_roles r ON r.oid=proc.proowner
 WHERE proc.oid='hon.read_school_health_score(text,uuid,uuid)'::regprocedure;
 IF projection.prosecdef IS DISTINCT FROM true OR projection.provolatile<>'s' OR projection.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
   OR projection.trusted_owner IS DISTINCT FROM true OR projection.runtime_execute IS DISTINCT FROM true OR projection.broad IS DISTINCT FROM false OR projection.no_guc IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Unsafe School Health Score projection ACL or definition';
 END IF;
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  IF has_function_privilege(role_name,'hon.read_school_health_score(text,uuid,uuid)','EXECUTE') THEN
   RAISE EXCEPTION 'Client School Health Score execute: %',role_name;
  END IF;
 END LOOP;
END $$;
-- pnpm db:test-health-score proves forged-GUC denial, zero audit/outbox/action/
-- work/AI writes, no new direct runtime directory grants, and aggregate-only output.

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

-- 13b) Parent billing observations: exactly one fixed SECURITY DEFINER function
-- resolves one live guardian family itself. The response has no selector or
-- identifier inputs beyond verified subject; no provider/payment method or write
-- authority is added. Source billing tables remain forced RLS.
SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolsuper OR r.rolbypassrls AS trusted_owner,
  has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS runtime_execute,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS forbidden_broad_execute
FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
WHERE p.oid='hon.read_parent_billing_view(text)'::regprocedure;
SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='hon' AND c.relname IN('billing_accounts','memberships','invoices','payment_attempts');
-- pnpm db:test-parent-billing proves guardian/current-family-only redaction,
-- ambiguity/revocation, relationship insufficiency, zero writes and no provider
-- or collection activity on an explicitly disposable local database.

-- 13c) Parent testing status: one selector-free, read-only current-family
-- projection. Runtime gets only EXECUTE; no client execution, caller GUC, or
-- scorecard/evaluation/certificate table privilege is added.
SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolsuper OR r.rolbypassrls AS trusted_owner,
  has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS runtime_execute,
  position('current_setting' IN pg_get_functiondef(p.oid)) = 0 AS no_caller_guc_authority,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS forbidden_broad_execute
FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
WHERE p.oid='hon.read_parent_testing_status(text)'::regprocedure;
DO $$
DECLARE role_name text; projection record;
BEGIN
  SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolsuper OR r.rolbypassrls AS trusted_owner,
    has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS runtime_execute,
    position('current_setting' IN pg_get_functiondef(p.oid)) = 0 AS no_caller_guc,
    NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS closed
  INTO projection FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
  WHERE p.oid='hon.read_parent_testing_status(text)'::regprocedure;
  IF projection.prosecdef IS DISTINCT FROM true OR projection.provolatile <> 'v'
    OR projection.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
    OR projection.trusted_owner IS DISTINCT FROM true OR projection.runtime_execute IS DISTINCT FROM true
    OR projection.no_caller_guc IS DISTINCT FROM true OR projection.closed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Unsafe parent testing status projection ACL or definition';
  END IF;
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
    IF has_function_privilege(role_name,'hon.read_parent_testing_status(text)','EXECUTE') THEN
      RAISE EXCEPTION 'Client parent testing status execute: %', role_name;
    END IF;
  END LOOP;
END $$;
-- Local disposable proof: pnpm db:test-parent-testing-status. It verifies one
-- current-family scope, status-only redaction, payer-safe certificate visibility,
-- cross-family denial, evaluator exclusion, and zero side effects.

-- 13d) Parent message history cannot mistake queue intent for delivery evidence.
-- The fixed projection returns only a receipt-evidence-unavailable state and
-- grants no direct communication, consent, recipient, sender, or provider data.
DO $$
DECLARE role_name text; projection record;
BEGIN
  SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolsuper OR r.rolbypassrls AS trusted_owner,
    has_function_privilege('hon_runtime',p.oid,'EXECUTE') AS runtime_execute,
    position('current_setting' IN pg_get_functiondef(p.oid)) = 0 AS no_caller_guc,
    NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE acl.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) AS closed
  INTO projection FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
  WHERE p.oid='hon.read_parent_message_history(text)'::regprocedure;
  IF projection.prosecdef IS DISTINCT FROM true OR projection.provolatile <> 'v'
    OR projection.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
    OR projection.trusted_owner IS DISTINCT FROM true OR projection.runtime_execute IS DISTINCT FROM true
    OR projection.no_caller_guc IS DISTINCT FROM true OR projection.closed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Unsafe parent message-history projection ACL or definition';
  END IF;
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
    IF has_function_privilege(role_name,'hon.read_parent_message_history(text)','EXECUTE') THEN
      RAISE EXCEPTION 'Client parent message-history execute: %', role_name;
    END IF;
  END LOOP;
END $$;
-- Local disposable proof: pnpm db:test-parent-message-history. It verifies
-- guardian-only scope, receipt-evidence-unavailable redaction and zero effects.

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
 FOR t IN SELECT unnest(ARRAY['revenue_plans','revenue_plan_versions','revenue_plan_requests','users','principals','roles','permissions','role_permissions','principal_role_grants','family_access_grants','organizations','schools','hq_operator_grants','hq_onboarding_requests','crm_activities','hq_ai_provider_connections','hq_ai_model_catalog','hq_ai_routing_policies','hq_ai_routing_candidates','hq_ai_task_profiles','hq_ai_task_profile_candidates','hq_ai_control_requests','hq_ai_control_audit','hq_ai_control_outbox']) LOOP
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
  ('hon.list_my_marketing_invocations(text)',true,true,'v','search_path=pg_catalog, hon'),
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

-- Teaching Studio exact verification: human-only bounded authoring has private
-- forced-RLS state and only three runtime callable boundaries.
DO $$ DECLARE t text; f record; r record; b boolean; trigger_name text; trigger_type integer; BEGIN
 FOR t IN SELECT unnest(ARRAY['teaching_lesson_plans','teaching_lesson_plan_revisions','teaching_resources','teaching_resource_revisions','instructor_assessments','instructor_assessment_revisions','teaching_studio_requests']) LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee<>c.relowner)
  INTO b FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Teaching Studio private table %',t; END IF;
  FOR trigger_name,trigger_type IN SELECT * FROM (VALUES('teaching_studio_immutable',27),('teaching_studio_no_truncate',34)) v(n,k) LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgname=trigger_name AND tgtype=trigger_type AND tgfoid='hon.guard_teaching_studio_history()'::regprocedure AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred) THEN RAISE EXCEPTION 'Unsafe Teaching Studio trigger %.%',t,trigger_name; END IF;
  END LOOP;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
  ('hon.guard_teaching_studio_history()',false,false),
  ('hon.teaching_studio_text(text,integer,boolean,boolean)',false,false),
  ('hon.teaching_studio_permission(uuid,uuid,uuid,text)',false,true),
  ('hon.resolve_teaching_studio_scope(text,uuid)',true,true),
  ('hon.require_teaching_studio_actor(text,text)',false,true),
  ('hon.lock_teaching_studio_actor(text,text,boolean)',false,true),
  ('hon.validate_teaching_studio_input(text,jsonb)',false,false),
  ('hon.teaching_lesson_projection(uuid,integer)',false,true),
  ('hon.teaching_resource_projection(uuid,integer)',false,true),
  ('hon.teaching_assessment_projection(uuid,integer)',false,true),
  ('hon.read_teaching_studio(text,text,uuid,uuid,integer)',true,true),
  ('hon.mutate_teaching_studio(text,text,uuid,uuid,jsonb,text,uuid,uuid)',true,true)
 ) v(signature,can_execute,is_definer) LOOP
  SELECT p.prosecdef=f.is_definer AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
  INTO b FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Teaching Studio function %',f.signature; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP IF has_function_privilege(r.rolname,f.signature,'EXECUTE') THEN RAISE EXCEPTION 'Forbidden client Teaching Studio function %',r.rolname; END IF; END LOOP;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='teaching.studio.read' AND is_sensitive AND is_staff_assignable)
  OR NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='teaching.lesson.manage' AND is_sensitive AND is_staff_assignable)
  OR NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='teaching.resource.manage' AND is_sensitive AND is_staff_assignable)
  OR NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='teaching.assessment.record' AND is_sensitive AND is_staff_assignable) THEN RAISE EXCEPTION 'Unsafe Teaching Studio permission registry'; END IF;
END $$;
-- End Teaching Studio verification.

-- Retention Review Signals: only scope resolution and a read-only redacted
-- projection are executable by hon_runtime. Helpers, PUBLIC and client roles
-- remain denied; no table privilege is added by this read-only slice.
DO $$
DECLARE expected record; role_name text; safe boolean;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('hon.retention_review_has_permission(uuid,uuid,uuid)', false),
      ('hon.resolve_retention_review_scope(text,uuid)', true),
      ('hon.require_retention_review_actor(text)', false),
      ('hon.lock_retention_review_actor(text)', false),
      ('hon.read_retention_review_signals(text,uuid)', true)
    ) AS x(signature, runtime_execute)
  LOOP
    SELECT p.prosecdef
      AND p.provolatile = 'v'
      AND p.proconfig = ARRAY['search_path=pg_catalog, hon']::text[]
      AND (owner_role.rolsuper OR owner_role.rolbypassrls)
      AND owner_role.rolname <> 'hon_runtime'
      AND has_function_privilege('hon_runtime', p.oid, 'EXECUTE') = expected.runtime_execute
      AND NOT EXISTS (
        SELECT 1
        FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
        WHERE acl.grantee <> p.proowner
          AND (
            acl.grantee <> (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')
            OR NOT expected.runtime_execute
            OR acl.is_grantable
            OR acl.privilege_type <> 'EXECUTE'
          )
      )
    INTO safe
    FROM pg_proc p
    JOIN pg_roles owner_role ON owner_role.oid = p.proowner
    WHERE p.oid = expected.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Unsafe Retention Review Signals function: %', expected.signature;
    END IF;
    FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
      IF has_function_privilege(role_name, expected.signature, 'EXECUTE') THEN
        RAISE EXCEPTION 'Client Retention Review Signals function execution: %.%', role_name, expected.signature;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM hon.permissions
    WHERE code = 'retention.review.read' AND is_sensitive AND is_staff_assignable
  ) THEN
    RAISE EXCEPTION 'Retention Review Signals permission registry is unsafe';
  END IF;
END $$;
-- End Retention Review Signals verification.


-- Human testing certificate exact verification: private forced-RLS tables,
-- inert local evidence only, and precisely scope/read/issue runtime functions.
DO $$
DECLARE expected record; t text; r text; safe boolean;
BEGIN
  FOR t IN SELECT unnest(ARRAY['testing_certificates','testing_certificate_requests','testing_certificate_outbox']) LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity
      AND (owner_role.rolsuper OR owner_role.rolbypassrls)
      AND owner_role.rolname <> 'hon_runtime'
      AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = c.oid)
      AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS acl WHERE acl.grantee <> c.relowner)
      AND NOT EXISTS (SELECT 1 FROM pg_attribute AS a CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
                      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND acl.grantee <> c.relowner)
    INTO safe
    FROM pg_class AS c JOIN pg_roles AS owner_role ON owner_role.oid = c.relowner
    WHERE c.oid = ('hon.' || t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe testing certificate private table: %', t; END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'hon.testing_certificate_outbox'::regclass
      AND conname = 'testing_certificate_outbox_execution_allowed_check'
      AND contype = 'c' AND convalidated
      AND pg_get_constraintdef(oid) = 'CHECK ((NOT execution_allowed))') THEN
    RAISE EXCEPTION 'Testing certificate outbox must stay inert';
  END IF;

  FOR expected IN SELECT * FROM (VALUES
    ('hon.testing_certificate_safe_text(text,integer)',false,false,'i'),
    ('hon.guard_testing_certificate_history()',false,false,'v'),
    ('hon.testing_certificate_permission(uuid,uuid,uuid,text)',false,true,'v'),
    ('hon.resolve_testing_certificate_scope(text,uuid)',true,true,'v'),
    ('hon.require_testing_certificate_actor(text,text)',false,true,'v'),
    ('hon.lock_testing_certificate_actor(text,text,boolean)',false,true,'v'),
    ('hon.testing_certificate_projection(uuid)',false,true,'v'),
    ('hon.guard_testing_certificate_insert()',false,true,'v'),
    ('hon.guard_testing_certificate_dependency()',false,true,'v'),
    ('hon.guard_testing_certificate_promotion_delete()',false,true,'v'),
    ('hon.read_testing_certificate(text,uuid)',true,true,'v'),
    ('hon.issue_testing_certificate(text,uuid,jsonb,text,uuid,uuid)',true,true,'v')
  ) AS x(signature, runtime_execute, security_definer, volatility) LOOP
    SELECT p.prosecdef = expected.security_definer
      AND p.provolatile = expected.volatility
      AND p.proconfig = ARRAY['search_path=pg_catalog, hon']::text[]
      AND (owner_role.rolsuper OR owner_role.rolbypassrls)
      AND owner_role.rolname <> 'hon_runtime'
      AND has_function_privilege('hon_runtime', p.oid, 'EXECUTE') = expected.runtime_execute
      AND NOT EXISTS (
        SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
        WHERE acl.grantee <> p.proowner
          AND (acl.grantee <> (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')
               OR NOT expected.runtime_execute OR acl.is_grantable OR acl.privilege_type <> 'EXECUTE')
      )
    INTO safe
    FROM pg_proc AS p JOIN pg_roles AS owner_role ON owner_role.oid = p.proowner
    WHERE p.oid = expected.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe testing certificate function: %', expected.signature; END IF;
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
      IF has_function_privilege(r, expected.signature, 'EXECUTE') THEN
        RAISE EXCEPTION 'Client testing certificate function execution: %.%', r, expected.signature;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code = 'testing.certificate.read' AND is_sensitive AND is_staff_assignable)
    OR NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code = 'testing.certificate.issue' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'Testing certificate permission registry is unsafe';
  END IF;
END $$;
-- End Human testing certificate exact verification.


-- Human testing scorecard exact verification: private independently attributable
-- observations only, inert local evidence, and fixed scope/read/record functions.
DO $$
DECLARE expected record; t text; r text; safe boolean;
BEGIN
  FOR t IN SELECT unnest(ARRAY['testing_scorecards','testing_scorecard_evaluations','testing_scorecard_requests','testing_scorecard_outbox']) LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity
      AND (owner_role.rolsuper OR owner_role.rolbypassrls)
      AND owner_role.rolname <> 'hon_runtime'
      AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = c.oid)
      AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS acl WHERE acl.grantee <> c.relowner)
      AND NOT EXISTS (SELECT 1 FROM pg_attribute AS a CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
                      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND acl.grantee <> c.relowner)
    INTO safe
    FROM pg_class AS c JOIN pg_roles AS owner_role ON owner_role.oid = c.relowner
    WHERE c.oid = ('hon.' || t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe testing scorecard private table: %', t; END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'hon.testing_scorecard_outbox'::regclass
      AND conname = 'testing_scorecard_outbox_execution_allowed_check'
      AND contype = 'c' AND convalidated
      AND pg_get_constraintdef(oid) = 'CHECK ((NOT execution_allowed))') THEN
    RAISE EXCEPTION 'Testing scorecard outbox must stay inert';
  END IF;

  FOR expected IN SELECT * FROM (VALUES
    ('hon.testing_scorecard_safe_criterion(text)',false,false),
    ('hon.testing_scorecard_permission(uuid,uuid,uuid,text)',false,true),
    ('hon.resolve_testing_scorecard_scope(text,uuid)',true,true),
    ('hon.require_testing_scorecard_actor(text,text)',false,true),
    ('hon.lock_testing_scorecard_actor(text,text,boolean)',false,true),
    ('hon.testing_scorecard_projection(uuid,uuid,uuid)',false,true),
    ('hon.guard_testing_scorecard_root()',false,true),
    ('hon.guard_testing_scorecard_evaluation()',false,true),
    ('hon.guard_testing_scorecard_history()',false,false),
    ('hon.read_testing_scorecard(text,uuid,uuid)',true,true),
    ('hon.record_testing_scorecard_evaluation(text,uuid,uuid,jsonb,text,uuid,uuid)',true,true)
  ) AS x(signature, runtime_execute, security_definer) LOOP
    SELECT p.prosecdef = expected.security_definer
      AND p.provolatile = 'v'
      AND p.proconfig = ARRAY['search_path=pg_catalog, hon']::text[]
      AND (owner_role.rolsuper OR owner_role.rolbypassrls)
      AND owner_role.rolname <> 'hon_runtime'
      AND has_function_privilege('hon_runtime', p.oid, 'EXECUTE') = expected.runtime_execute
      AND NOT EXISTS (
        SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
        WHERE acl.grantee <> p.proowner
          AND (acl.grantee <> (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')
               OR NOT expected.runtime_execute OR acl.is_grantable OR acl.privilege_type <> 'EXECUTE')
      )
    INTO safe
    FROM pg_proc AS p JOIN pg_roles AS owner_role ON owner_role.oid = p.proowner
    WHERE p.oid = expected.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe testing scorecard function: %', expected.signature; END IF;
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
      IF has_function_privilege(r, expected.signature, 'EXECUTE') THEN
        RAISE EXCEPTION 'Client testing scorecard function execution: %.%', r, expected.signature;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code = 'testing.scorecard.read' AND is_sensitive AND is_staff_assignable)
    OR NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code = 'testing.scorecard.record' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'Testing scorecard permission registry is unsafe';
  END IF;
END $$;
-- End Human testing scorecard exact verification.


-- Claire Teaching Assistant exact verification: curriculum-only private draft
-- evidence, forced deny-all RLS, and explicit runtime callable functions only.
DO $$
DECLARE expected record; t text; r text; safe boolean;
BEGIN
  FOR t IN SELECT unnest(ARRAY['teaching_ai_invocations','teaching_ai_drafts','teaching_studio_ai_drafts']) LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity
      AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime'
      AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND acl.grantee<>c.relowner)
    INTO safe FROM pg_class c JOIN pg_roles owner_role ON owner_role.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Claire private table: %',t; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('hon.teaching_assistant_safe_text(text,integer,boolean)',false,false,'i','search_path=pg_catalog'),
    ('hon.guard_teaching_assistant()',false,false,'v','search_path=pg_catalog, hon'),
    ('hon.resolve_teaching_assistant_scope(text)',true,true,'v','search_path=pg_catalog, hon'),
    ('hon.require_teaching_assistant_actor(text,boolean)',false,true,'v','search_path=pg_catalog, hon'),
    ('hon.teaching_assistant_event(uuid,text)',false,true,'v','search_path=pg_catalog, hon'),
    ('hon.read_teaching_invocation(text,uuid)',true,true,'v','search_path=pg_catalog, hon'),
    ('hon.list_my_teaching_invocations(text)',true,true,'v','search_path=pg_catalog, hon'),
    ('hon.list_teaching_assistant_curricula(text)',true,true,'v','search_path=pg_catalog, hon'),
    ('hon.begin_teaching_request(text,jsonb,uuid)',true,true,'v','search_path=pg_catalog, hon'),
    ('hon.teaching_planning_reference(text,uuid)',true,true,'v','search_path=pg_catalog, hon'),
    ('hon.prepare_teaching_invocation(text,uuid,uuid,boolean)',true,true,'v','search_path=pg_catalog, hon'),
    ('hon.fail_teaching_invocation(text,uuid,text,text)',true,true,'v','search_path=pg_catalog, hon'),
    ('hon.record_teaching_result(text,uuid,jsonb)',true,true,'v','search_path=pg_catalog, hon'),
    ('hon.bind_teaching_proposal(text,uuid,uuid)',true,true,'v','search_path=pg_catalog, hon'),
    ('hon.teaching_action_is_current(uuid,jsonb)',true,true,'v','search_path=pg_catalog, hon'),
    ('hon.reject_teaching_draft(uuid)',true,true,'v','search_path=pg_catalog, hon'),
    ('hon.save_approved_teaching_draft(text,uuid)',true,true,'v','search_path=pg_catalog, hon')
  ) AS x(signature,runtime_execute,security_definer,volatility,path_setting) LOOP
    SELECT p.prosecdef=expected.security_definer AND p.provolatile=expected.volatility AND p.proconfig=ARRAY[expected.path_setting]::text[]
      AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime'
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=expected.runtime_execute
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee<>p.proowner AND (acl.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT expected.runtime_execute OR acl.is_grantable OR acl.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner_role ON owner_role.oid=p.proowner WHERE p.oid=expected.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Claire function: %',expected.signature; END IF;
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
      IF has_function_privilege(r,expected.signature,'EXECUTE') THEN RAISE EXCEPTION 'Client Claire function execution: %.%',r,expected.signature; END IF;
    END LOOP;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='teaching.assistant.use' AND is_sensitive AND is_staff_assignable) THEN RAISE EXCEPTION 'Claire staff permission registry is unsafe'; END IF;
END $$;
-- End Claire Teaching Assistant exact verification.

-- Chad CRM follow-up content proposal verification: exact private tables and
-- callable boundaries only; it grants neither delivery nor execution.
DO $$
DECLARE expected record; t text; r text; safe boolean;
BEGIN
  FOR t IN SELECT unnest(ARRAY['chad_follow_up_invocations','chad_follow_up_drafts']) LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime'
      AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee<>c.relowner)
    INTO safe FROM pg_class c JOIN pg_roles owner_role ON owner_role.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Chad private table: %',t; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('hon.guard_chad_follow_up()',false,false),('hon.resolve_chad_follow_up_scope(text)',true,true),('hon.require_chad_follow_up_actor(text)',false,true),('hon.chad_follow_up_event(uuid,text)',false,true),('hon.read_chad_follow_up_invocation(text,uuid)',true,true),('hon.list_my_chad_follow_up_invocations(text)',true,true),('hon.begin_chad_follow_up_request(text,jsonb,uuid)',true,true),('hon.chad_follow_up_planning_reference(text,uuid)',true,true),('hon.prepare_chad_follow_up_invocation(text,uuid,uuid,boolean)',true,true),('hon.fail_chad_follow_up_invocation(text,uuid,text,text)',true,true),('hon.record_chad_follow_up_result(text,uuid,jsonb)',true,true),('hon.bind_chad_follow_up_proposal(text,uuid,uuid)',true,true),('hon.chad_follow_up_draft_is_current(uuid,jsonb)',true,true),('hon.transition_chad_follow_up_draft(uuid,text)',true,true)
  ) AS x(signature,runtime_execute,security_definer) LOOP
    SELECT p.prosecdef=expected.security_definer AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime' AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=expected.runtime_execute
    INTO safe FROM pg_proc p JOIN pg_roles owner_role ON owner_role.oid=p.proowner WHERE p.oid=expected.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Chad function: %',expected.signature; END IF;
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP IF has_function_privilege(r,expected.signature,'EXECUTE') THEN RAISE EXCEPTION 'Client Chad function execution: %.%',r,expected.signature; END IF; END LOOP;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='crm.assistant.follow_up_draft' AND is_sensitive AND is_staff_assignable) THEN RAISE EXCEPTION 'Chad permission registry is unsafe'; END IF;
END $$;
-- End Chad CRM follow-up content proposal verification.

-- Human instructor qualification evidence: forced deny-all RLS/private references,
-- direct human boundaries only, and an inert non-dispatchable evidence outbox.
DO $$
DECLARE expected record; t text; r text; safe boolean;
BEGIN
  FOR t IN SELECT unnest(ARRAY['instructor_qualifications','instructor_qualification_revisions','instructor_qualification_evidence','instructor_qualification_evidence_reviews','instructor_qualification_requests','instructor_qualification_outbox']) LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime'
      AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND acl.grantee<>c.relowner)
    INTO safe FROM pg_class c JOIN pg_roles owner_role ON owner_role.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe instructor qualification private table: %',t; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.instructor_qualification_outbox'::regclass AND conname='instructor_qualification_outbox_execution_allowed_check' AND contype='c' AND convalidated AND pg_get_constraintdef(oid)='CHECK ((NOT execution_allowed))') THEN RAISE EXCEPTION 'Instructor qualification outbox must stay inert'; END IF;
  FOR expected IN SELECT * FROM (VALUES
    ('hon.instructor_qualification_safe_text(text,integer)',false,false),
    ('hon.guard_instructor_qualification_history()',false,false),
    ('hon.instructor_qualification_permission(uuid,uuid,uuid,text)',false,true),
    ('hon.resolve_instructor_qualification_scope(text)',true,true),
    ('hon.require_instructor_qualification_actor(text,text)',false,true),
    ('hon.lock_instructor_qualification_actor(text,text,boolean)',false,true),
    ('hon.instructor_qualification_definition_projection(uuid)',false,true),
    ('hon.instructor_qualification_evidence_projection(uuid,uuid)',false,true),
    ('hon.read_instructor_qualification(text,text,uuid,uuid)',true,true),
    ('hon.mutate_instructor_qualification(text,text,uuid,uuid,jsonb,text,uuid,uuid)',true,true)
  ) AS x(signature,runtime_execute,security_definer) LOOP
    SELECT p.prosecdef=expected.security_definer
      AND p.provolatile=CASE WHEN expected.signature='hon.instructor_qualification_safe_text(text,integer)' THEN 'i' ELSE 'v' END
      AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime'
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=expected.runtime_execute
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee<>p.proowner AND (acl.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT expected.runtime_execute OR acl.is_grantable OR acl.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner_role ON owner_role.oid=p.proowner WHERE p.oid=expected.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe instructor qualification function: %',expected.signature; END IF;
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP IF has_function_privilege(r,expected.signature,'EXECUTE') THEN RAISE EXCEPTION 'Client instructor qualification function execution: %.%',r,expected.signature; END IF; END LOOP;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='staff.instructor_qualification.read' AND is_sensitive AND is_staff_assignable)
    OR NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='staff.instructor_qualification.manage' AND is_sensitive AND is_staff_assignable) THEN RAISE EXCEPTION 'Instructor qualification permission registry is unsafe'; END IF;
END $$;
-- End Human instructor qualification exact verification.

-- HQ AI exact verification: function-only selection configuration, never execution.
DO $$
DECLARE t text; f record; b record; client_role text;
BEGIN
 FOR t IN SELECT unnest(ARRAY['hq_ai_provider_connections','hq_ai_model_catalog','hq_ai_routing_policies','hq_ai_routing_candidates','hq_ai_task_profiles','hq_ai_task_profile_candidates','hq_ai_control_requests','hq_ai_control_audit','hq_ai_control_outbox']) LOOP
  SELECT c.relrowsecurity,c.relforcerowsecurity,r.rolsuper OR r.rolbypassrls trusted_owner,
    EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t) has_policy,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
    OR EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee<>c.relowner) broad_acl
  INTO b FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF NOT b.relrowsecurity OR NOT b.relforcerowsecurity OR NOT b.trusted_owner OR b.has_policy OR b.broad_acl
    OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe HQ AI table/column RLS or ACL: %',t;
  END IF;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
   ('hon.hq_ai_control_plane_read(text)',true,true,'s'),
   ('hon.hq_ai_control_plane_write(text,text,jsonb,uuid,uuid)',true,true,'v'),
   ('hon.hq_ai_routing_registry(text,uuid)',true,true,'s'),
   ('hon.hq_ai_task_profile_registry(text,uuid)',true,true,'s'),
   ('hon.hq_ai_snapshot()',false,false,'s'),
   ('hon.hq_ai_task_profile_snapshot(uuid)',false,false,'s'),
   ('hon.hq_ai_validate_write(text,jsonb)',false,false,'v'),
   ('hon.hq_ai_valid_list(jsonb,text[],integer,integer)',false,false,'i'),
   ('hon.hq_ai_safe_text(text,boolean)',false,false,'i')
 ) AS v(signature,should_execute,should_define,expected_volatility) LOOP
  SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolsuper OR r.rolbypassrls trusted_owner,
    has_function_privilege('hon_runtime',p.oid,'EXECUTE') runtime_execute,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
      AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.should_execute OR a.privilege_type<>'EXECUTE' OR a.is_grantable)) broad_acl
  INTO b FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b.trusted_owner IS DISTINCT FROM true OR b.prosecdef IS DISTINCT FROM f.should_define OR b.runtime_execute IS DISTINCT FROM f.should_execute
    OR b.provolatile::text<>f.expected_volatility OR b.broad_acl IS DISTINCT FROM false
    OR b.proconfig IS DISTINCT FROM (CASE WHEN f.signature='hon.hq_ai_safe_text(text,boolean)' THEN ARRAY['search_path=pg_catalog'] ELSE ARRAY['search_path=pg_catalog, hon'] END) THEN
    RAISE EXCEPTION 'Unsafe exact HQ AI function owner/path/ACL: %',f.signature;
  END IF;
  FOR client_role IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
    IF has_function_privilege(client_role,f.signature,'EXECUTE') THEN RAISE EXCEPTION 'Client HQ AI function grant'; END IF;
  END LOOP;
 END LOOP;
END $$;
-- End HQ AI exact verification.

-- Advanced attendance exact verification:
DO $$
DECLARE t text; f record; b record; a record; runtime_oid oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime');
BEGIN
 FOREACH t IN ARRAY ARRAY['attendance_progression_policies','attendance_policy_requests'] LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity forced,r.rolsuper OR r.rolbypassrls trusted,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee<>c.relowner)
    OR EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) acl WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND acl.grantee<>c.relowner) broad INTO b
  FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=format('hon.%I',t)::regclass;
  IF NOT b.forced OR NOT b.trusted OR b.broad OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t) THEN RAISE EXCEPTION 'Unsafe attendance policy table %',t; END IF;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
  ('hon.default_attendance_categories()',false,false,'i'),('hon.valid_attendance_categories(jsonb)',false,false,'i'),
  ('hon.lock_attendance_actor(text,text)',true,true,'v'),('hon.read_attendance_policy(text,uuid)',true,true,'v'),
  ('hon.configure_attendance_policy(text,uuid,jsonb,text,uuid,uuid)',true,true,'v'),
  ('hon.record_attendance(text,uuid,jsonb,text,uuid,uuid)',true,true,'v'),('hon.snapshot_attendance_credit()',false,true,'v')) x(signature,runtime_allowed,definer,volatility) LOOP
  SELECT p.prosecdef,p.provolatile::text volatility,p.proconfig,r.rolsuper OR r.rolbypassrls trusted,
   has_function_privilege('hon_runtime',p.oid,'EXECUTE') runtime_execute,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee<>p.proowner AND (acl.grantee<>runtime_oid OR NOT f.runtime_allowed OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable)) broad INTO b
  FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF NOT b.trusted OR b.prosecdef<>f.definer OR b.volatility<>f.volatility OR b.runtime_execute<>f.runtime_allowed OR b.broad OR b.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon'] THEN RAISE EXCEPTION 'Unsafe attendance function %',f.signature; END IF;
 END LOOP;
 SELECT c.relrowsecurity AND c.relforcerowsecurity forced,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee<>c.relowner AND (acl.grantee<>runtime_oid OR acl.privilege_type<>'SELECT' OR acl.is_grantable)) broad INTO b
 FROM pg_class c WHERE c.oid='hon.attendance_records'::regclass;
 IF NOT b.forced OR b.broad OR NOT has_table_privilege('hon_runtime','hon.attendance_records','SELECT')
  OR has_table_privilege('hon_runtime','hon.attendance_records','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN RAISE EXCEPTION 'Unsafe attendance record table'; END IF;
 FOR a IN SELECT attname,has_column_privilege('hon_runtime',attrelid,attnum,'INSERT,UPDATE,REFERENCES') allowed,
   EXISTS(SELECT 1 FROM aclexplode(attacl) acl WHERE acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=attrelid)) broad
  FROM pg_attribute WHERE attrelid='hon.attendance_records'::regclass AND attnum>0 AND NOT attisdropped LOOP
  IF a.broad OR a.allowed THEN RAISE EXCEPTION 'Unsafe attendance column %',a.attname; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.attendance_records'::regclass AND tgname='attendance_credit_snapshot' AND tgfoid='hon.snapshot_attendance_credit()'::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN RAISE EXCEPTION 'Missing attendance snapshot guard'; END IF;
 FOREACH t IN ARRAY ARRAY['attendance_progression_policies','attendance_policy_requests'] LOOP
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=format('hon.%I',t)::regclass AND tgenabled='O' AND tgfoid='hon.guard_campaign_history()'::regprocedure AND NOT tgisinternal)<>2 THEN RAISE EXCEPTION 'Missing attendance immutable guards'; END IF;
 END LOOP;
END $$;
-- End advanced attendance exact verification.

-- Promotion readiness exact verification:
DO $$ DECLARE t text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
  WHERE p.oid='hon.read_promotion_readiness(text,uuid,uuid)'::regprocedure AND p.prosecdef AND p.provolatile='s'
   AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (owner.rolsuper OR owner.rolbypassrls) AND owner.rolname<>'hon_runtime'
   AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
    AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.privilege_type<>'EXECUTE' OR a.is_grantable))) THEN
  RAISE EXCEPTION 'Unsafe promotion readiness function or ACL'; END IF;
 FOREACH t IN ARRAY ARRAY['curricula','curriculum_ranks','curriculum_requirements','student_curriculum_enrollments','student_profiles','curriculum_enrollment_history','curriculum_progress_observations','promotion_decisions','attendance_records','class_sessions','testing_events','testing_candidates','document_templates','document_publications','document_acknowledgements'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=format('hon.%I',t)::regclass AND relrowsecurity AND relforcerowsecurity) THEN RAISE EXCEPTION 'Readiness evidence lacks forced RLS'; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['curriculum_enrollment_history','curriculum_progress_observations','document_templates','document_publications','document_acknowledgements'] LOOP
  IF has_table_privilege('hon_runtime',format('hon.%I',t),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege('hon_runtime',format('hon.%I',t),'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Readiness must not grant private table access'; END IF;
 END LOOP;
END $$;
-- End promotion readiness exact verification.

-- ClassPass exact verification:
DO $$ DECLARE t text; r text; signature text; f record; runtime_oid oid; runtime_execute boolean; BEGIN
 SELECT oid INTO runtime_oid FROM pg_roles WHERE rolname='hon_runtime';
 IF runtime_oid IS NULL THEN RAISE EXCEPTION 'ClassPass runtime missing'; END IF;
 FOR t IN SELECT unnest(ARRAY['classpass_products','classpass_passes','classpass_ledger']) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=('hon.'||t)::regclass AND relrowsecurity AND relforcerowsecurity)
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=('hon.'||t)::regclass) THEN RAISE EXCEPTION 'ClassPass requires forced no-policy RLS: %',t; END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles owner ON owner.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass AND NOT(owner.rolsuper OR owner.rolbypassrls)) THEN RAISE EXCEPTION 'ClassPass table owner must be trusted'; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
   IF has_table_privilege(r,'hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r,'hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'ClassPass table or column ACL surplus: % %',r,t; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee=0) THEN RAISE EXCEPTION 'ClassPass PUBLIC table grant'; END IF;
 END LOOP;
 FOR signature IN SELECT unnest(ARRAY['read_classpass(text,text,uuid)','command_classpass(text,text,uuid,jsonb,text,uuid,uuid)','lock_classpass_actor(text,text)','guard_classpass_snapshot()','guard_classpass_booking()','require_classpass_read_actor(text)','lock_class_booking_session(text,uuid)','read_parent_classpass_view(text)']) LOOP
  SELECT p.*,owner.rolsuper,owner.rolbypassrls INTO f FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=('hon.'||signature)::regprocedure;
  IF f.oid IS NULL OR f.proowner=runtime_oid OR NOT(f.rolsuper OR f.rolbypassrls) OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon'] THEN RAISE EXCEPTION 'ClassPass function posture: %',signature; END IF;
  IF signature IN('read_classpass(text,text,uuid)','command_classpass(text,text,uuid,jsonb,text,uuid,uuid)','lock_classpass_actor(text,text)','require_classpass_read_actor(text)','lock_class_booking_session(text,uuid)','read_parent_classpass_view(text)') AND NOT f.prosecdef THEN RAISE EXCEPTION 'ClassPass definer required'; END IF;
  runtime_execute:=signature IN('read_classpass(text,text,uuid)','command_classpass(text,text,uuid,jsonb,text,uuid,uuid)','lock_class_booking_session(text,uuid)','read_parent_classpass_view(text)');
  -- Exact explicit entries, not merely effective privilege for four named roles.
  -- Owner self-EXECUTE and, for public boundaries only, runtime EXECUTE; no GO.
  IF EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a
   WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable
    OR (a.grantee<>f.proowner AND (NOT runtime_execute OR a.grantee<>runtime_oid))
    OR a.grantor<>f.proowner)
   OR NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=f.proowner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)
   OR (SELECT count(*) FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=runtime_oid AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)<>(CASE WHEN runtime_execute THEN 1 ELSE 0 END)
   OR has_function_privilege('hon_runtime',f.oid,'EXECUTE') IS DISTINCT FROM runtime_execute
   OR has_function_privilege('hon_runtime',f.oid,'EXECUTE WITH GRANT OPTION') THEN
   RAISE EXCEPTION 'ClassPass exact function ACL surplus/missing/grant option: %',signature;
  END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_function_privilege(r,f.oid,'EXECUTE') THEN RAISE EXCEPTION 'ClassPass forbidden client function authority: % %',r,signature; END IF;
  END LOOP;
 END LOOP;
 IF has_table_privilege('hon_runtime','hon.class_bookings','UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege('hon_runtime','hon.class_bookings','UPDATE') THEN RAISE EXCEPTION 'ClassPass must not grant raw booking mutation'; END IF;
END $$;
-- End ClassPass exact verification.

-- Class booking lock exact verification:
DO $$ DECLARE f record; safe boolean; r text; BEGIN
 FOR f IN SELECT * FROM (VALUES
  ('hon.lock_class_booking_session(text,uuid)',true,'v'),
  ('hon.require_classpass_read_actor(text)',false,'s'),
  ('hon.read_classpass(text,text,uuid)',true,'s')
 ) x(signature,runtime_execute,volatility) LOOP
  SELECT p.prosecdef AND p.provolatile::text=f.volatility
   AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[]
   AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.is_grantable OR (a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')
     OR NOT f.runtime_execute OR a.privilege_type<>'EXECUTE')))
  INTO safe FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe class booking lock/read function %',f.signature; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   IF has_function_privilege(r,f.signature,'EXECUTE') THEN RAISE EXCEPTION 'Forbidden class booking client function %',r; END IF;
  END LOOP;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='hon.lock_class_booking_session(text,uuid)'::regprocedure
  AND proretset AND prorettype='record'::regtype
  AND proargnames=ARRAY['p_subject','p_session','id','capacity','booking_policy','status']::text[]
  AND proargmodes=ARRAY['i','i','t','t','t','t']::"char"[]
  AND proallargtypes=ARRAY['text'::regtype::oid,'uuid'::regtype::oid,'uuid'::regtype::oid,'integer'::regtype::oid,'text'::regtype::oid,'text'::regtype::oid]) THEN
  RAISE EXCEPTION 'Unsafe class booking lock return facts';
 END IF;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  IF has_table_privilege(r,'hon.class_sessions','UPDATE') OR has_any_column_privilege(r,'hon.class_sessions','UPDATE') THEN
   RAISE EXCEPTION 'Forbidden direct session UPDATE privilege %',r;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  WHERE c.oid='hon.class_sessions'::regclass AND a.grantee=0 AND a.privilege_type='UPDATE')
  OR EXISTS(SELECT 1 FROM pg_attribute att,LATERAL aclexplode(att.attacl) a
   WHERE att.attrelid='hon.class_sessions'::regclass AND a.grantee=0 AND a.privilege_type='UPDATE') THEN
  RAISE EXCEPTION 'Forbidden PUBLIC session UPDATE privilege';
 END IF;
END $$;
-- End class booking lock exact verification.

-- Kiosk handoff exact verification:
DO $$ DECLARE t text; f record; runtime_oid oid; executable boolean; signature text; expected_config text[]; BEGIN
 SELECT oid INTO runtime_oid FROM pg_roles WHERE rolname='hon_runtime';
 IF runtime_oid IS NULL THEN RAISE EXCEPTION 'Kiosk runtime missing'; END IF;
 FOREACH t IN ARRAY ARRAY['kiosk_terminals','kiosk_terminal_sessions','kiosk_claims','kiosk_handoffs','kiosk_receipts'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND c.relowner<>runtime_oid)
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=('hon.'||t)::regclass) THEN RAISE EXCEPTION 'Kiosk forced no-policy RLS required: %',t; END IF;
  IF EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid,LATERAL aclexplode(att.attacl) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner)
   OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Kiosk private table/column ACL surplus: %',t; END IF;
  IF EXISTS(SELECT 1 FROM pg_constraint fk WHERE fk.conrelid=('hon.'||t)::regclass AND fk.contype='f' AND (cardinality(fk.conkey)<2
   OR NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=fk.conrelid AND a.attname='organization_id' AND a.attnum=ANY(fk.conkey))
   OR NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=fk.conrelid AND a.attname='school_id' AND a.attnum=ANY(fk.conkey)))) THEN RAISE EXCEPTION 'Kiosk composite scope FK required: %',t; END IF;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['manage_kiosk_terminal(text,text,uuid,uuid,text)','provision_kiosk_claim(text,uuid,uuid,uuid,text)','submit_kiosk_handoff(text,text)','read_kiosk_handoff(text,uuid)','lock_kiosk_actor(text,text)','kiosk_secret_valid(text)','guard_kiosk_transition()'] LOOP
  SELECT p.*,o.rolsuper,o.rolbypassrls INTO f FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=('hon.'||signature)::regprocedure;
  executable:=signature IN('manage_kiosk_terminal(text,text,uuid,uuid,text)','provision_kiosk_claim(text,uuid,uuid,uuid,text)','submit_kiosk_handoff(text,text)','read_kiosk_handoff(text,uuid)');
  expected_config:=CASE WHEN signature='kiosk_secret_valid(text)' THEN ARRAY['search_path=pg_catalog'] ELSE ARRAY['search_path=pg_catalog, hon'] END;
  IF f.oid IS NULL OR f.proowner=runtime_oid OR NOT(f.rolsuper OR f.rolbypassrls) OR f.proconfig IS DISTINCT FROM expected_config
   OR (signature NOT IN('kiosk_secret_valid(text)','guard_kiosk_transition()') AND (NOT f.prosecdef OR f.provolatile<>'v')) THEN RAISE EXCEPTION 'Kiosk function posture: %',signature; END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>f.proowner OR (a.grantee<>f.proowner AND (NOT executable OR a.grantee<>runtime_oid)))
   OR (SELECT count(*) FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=f.proowner AND NOT a.is_grantable)<>1
   OR (SELECT count(*) FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=runtime_oid AND NOT a.is_grantable)<>(CASE WHEN executable THEN 1 ELSE 0 END)
   OR has_function_privilege('hon_runtime',f.oid,'EXECUTE') IS DISTINCT FROM executable
   OR has_function_privilege('hon_runtime',f.oid,'EXECUTE WITH GRANT OPTION') THEN RAISE EXCEPTION 'Kiosk exact function ACL surplus/missing/grant option: %',signature; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='hon.submit_kiosk_handoff(text,text)'::regprocedure AND pronargs=2 AND prorettype='text'::regtype)
  OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='hon.read_kiosk_handoff(text,uuid)'::regprocedure AND pronargs=2 AND prorettype='jsonb'::regtype) THEN RAISE EXCEPTION 'Kiosk exact fixed signatures required'; END IF;
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='hon' AND table_name='kiosk_receipts' AND column_name NOT IN('id','organization_id','school_id','handoff_id','claim_id','terminal_session_id','result','recorded_at')) THEN RAISE EXCEPTION 'Kiosk receipt must contain internal IDs/result/time only'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.kiosk_receipts'::regclass AND NOT tgisinternal AND tgenabled='O' AND tgfoid='hon.guard_campaign_history()'::regprocedure)<>3 THEN RAISE EXCEPTION 'Kiosk receipt append-only guards required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=runtime_oid AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication) THEN RAISE EXCEPTION 'Kiosk restricted runtime required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=runtime_oid AND setdatabase=0 AND setconfig @> ARRAY['log_parameter_max_length=0','log_parameter_max_length_on_error=0']) THEN RAISE EXCEPTION 'Kiosk bearer parameter logging must be disabled by administrator'; END IF;
END $$;
-- End kiosk handoff exact verification.

-- Retention acknowledgement exact verification:
DO $$ DECLARE t text; f record; runtime_oid oid; executable boolean; signature text; expected_config text[]; BEGIN
 SELECT oid INTO runtime_oid FROM pg_roles WHERE rolname='hon_runtime';
 IF runtime_oid IS NULL THEN RAISE EXCEPTION 'Retention acknowledgement runtime missing'; END IF;
 FOREACH t IN ARRAY ARRAY['retention_review_acknowledgements','retention_review_acknowledgement_receipts','retention_review_acknowledgement_outbox','retention_review_acknowledgement_evidence_keys'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND c.relowner<>runtime_oid)
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=('hon.'||t)::regclass) THEN RAISE EXCEPTION 'Retention acknowledgement forced no-policy RLS required: %',t; END IF;
  IF EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid,LATERAL aclexplode(att.attacl) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner)
   OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Retention acknowledgement private table/column ACL surplus: %',t; END IF;
  IF EXISTS(SELECT 1 FROM pg_constraint fk WHERE fk.conrelid=('hon.'||t)::regclass AND fk.contype='f' AND fk.confrelid<>'hon.principals'::regclass AND (cardinality(fk.conkey)<2
   OR NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=fk.conrelid AND a.attname='organization_id' AND a.attnum=ANY(fk.conkey))
   OR NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=fk.conrelid AND a.attname='school_id' AND a.attnum=ANY(fk.conkey)))) THEN RAISE EXCEPTION 'Retention acknowledgement composite scope FK required: %',t; END IF;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['require_retention_acknowledgement_actor(text)','retention_review_evidence_fingerprint(jsonb,timestamptz)','read_retention_review_acknowledgement_evidence(text,uuid)','acknowledge_retention_review_evidence(text,uuid,text,text,timestamptz,uuid,uuid,uuid)'] LOOP
  SELECT p.*,o.rolsuper,o.rolbypassrls INTO f FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=('hon.'||signature)::regprocedure;
  executable:=signature IN('read_retention_review_acknowledgement_evidence(text,uuid)','acknowledge_retention_review_evidence(text,uuid,text,text,timestamptz,uuid,uuid,uuid)');
  expected_config:=ARRAY['search_path=pg_catalog, hon'];
  IF f.oid IS NULL OR f.proowner=runtime_oid OR NOT(f.rolsuper OR f.rolbypassrls) OR f.proconfig IS DISTINCT FROM expected_config
   OR (NOT f.prosecdef OR f.provolatile<>'v') THEN RAISE EXCEPTION 'Retention acknowledgement function posture: %',signature; END IF;
  -- Fixed forward-only 0124 implementation: reject restoration of vulnerable
  -- 0123 semantics even when the signature/ACL/security posture is unchanged.
  IF signature='acknowledge_retention_review_evidence(text,uuid,text,text,timestamptz,uuid,uuid,uuid)' AND md5(f.prosrc)<>'6ea520210f67af2761e91734ebeed238' THEN RAISE EXCEPTION 'Retention acknowledgement fixed 0124 command drift'; END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>f.proowner OR (a.grantee<>f.proowner AND (NOT executable OR a.grantee<>runtime_oid)))
   OR (SELECT count(*) FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=f.proowner AND NOT a.is_grantable)<>1
   OR (SELECT count(*) FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=runtime_oid AND NOT a.is_grantable)<>(CASE WHEN executable THEN 1 ELSE 0 END)
   OR has_function_privilege('hon_runtime',f.oid,'EXECUTE') IS DISTINCT FROM executable
   OR has_function_privilege('hon_runtime',f.oid,'EXECUTE WITH GRANT OPTION') THEN RAISE EXCEPTION 'Retention acknowledgement exact function ACL surplus/missing/grant option: %',signature; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['retention_review_acknowledgements','retention_review_acknowledgement_receipts','retention_review_acknowledgement_outbox','retention_review_acknowledgement_evidence_keys'] LOOP
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND NOT tgisinternal AND tgenabled='O' AND tgfoid='hon.guard_campaign_history()'::regprocedure AND tgtype IN(27,34))<>2 THEN RAISE EXCEPTION 'Retention acknowledgement immutable guards missing: %',t; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='hon' AND table_name='retention_review_acknowledgements' AND column_name NOT IN('id','organization_id','school_id','membership_id','actor_principal_id','evidence_version','evidence_fingerprint','observed_at','recorded_at','state'))
  OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='hon' AND table_name='retention_review_acknowledgement_receipts' AND column_name NOT IN('id','organization_id','school_id','membership_id','actor_principal_id','acknowledgement_id','idempotency_digest','evidence_version','evidence_fingerprint','observed_at'))
  OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='hon' AND table_name='retention_review_acknowledgement_outbox' AND column_name NOT IN('id','organization_id','school_id','membership_id','actor_principal_id','acknowledgement_id','evidence_version','evidence_fingerprint','observed_at','event_code','state'))
  OR (SELECT array_agg(attname::text||':'||atttypid::regtype::text||':'||attnotnull::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='hon.retention_review_acknowledgement_evidence_keys'::regclass AND attnum>0 AND NOT attisdropped)
   IS DISTINCT FROM ARRAY['id:uuid:true','organization_id:uuid:true','school_id:uuid:true','membership_id:uuid:true','actor_principal_id:uuid:true','evidence_version:text:true','evidence_fingerprint:text:true','observed_at:timestamp with time zone:true','acknowledgement_id:uuid:true'] THEN RAISE EXCEPTION 'Retention acknowledgement evidence columns must be closed and redacted'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.retention_review_acknowledgement_evidence_keys'::regclass AND conname='retention_ack_evidence_natural_key' AND contype='u' AND convalidated AND NOT condeferrable
  AND pg_get_constraintdef(oid)='UNIQUE (organization_id, school_id, membership_id, actor_principal_id, evidence_version, evidence_fingerprint, observed_at)') THEN RAISE EXCEPTION 'Retention acknowledgement exact natural evidence key required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint fk WHERE fk.conrelid='hon.retention_review_acknowledgement_evidence_keys'::regclass AND fk.conname='retention_ack_evidence_ack_fk' AND fk.contype='f' AND fk.confrelid='hon.retention_review_acknowledgements'::regclass AND fk.convalidated AND fk.condeferrable AND fk.condeferred AND fk.confdeltype='r' AND fk.confupdtype='a'
  AND ARRAY(SELECT a.attname::text FROM unnest(fk.conkey) WITH ORDINALITY k(attnum,position) JOIN pg_attribute a ON a.attrelid=fk.conrelid AND a.attnum=k.attnum ORDER BY k.position)=ARRAY['acknowledgement_id','organization_id','school_id','membership_id','actor_principal_id','evidence_version','evidence_fingerprint','observed_at']
  AND ARRAY(SELECT a.attname::text FROM unnest(fk.confkey) WITH ORDINALITY k(attnum,position) JOIN pg_attribute a ON a.attrelid=fk.confrelid AND a.attnum=k.attnum ORDER BY k.position)=ARRAY['id','organization_id','school_id','membership_id','actor_principal_id','evidence_version','evidence_fingerprint','observed_at']) THEN RAISE EXCEPTION 'Retention acknowledgement deferred exact evidence FK required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.retention_review_acknowledgement_receipts'::regclass AND contype='u' AND NOT condeferrable AND pg_get_constraintdef(oid)='UNIQUE (organization_id, school_id, actor_principal_id, idempotency_digest)')
  OR EXISTS(SELECT 1 FROM pg_constraint u WHERE u.conrelid='hon.retention_review_acknowledgement_receipts'::regclass AND u.contype IN('u','p') AND u.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=u.conrelid AND attname='acknowledgement_id')]::smallint[]) THEN RAISE EXCEPTION 'Retention acknowledgement requires one receipt per scoped key, not per acknowledgement'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.retention_review_acknowledgement_outbox'::regclass AND contype='c' AND pg_get_constraintdef(oid) = 'CHECK ((state = ''INERT''::text))') THEN RAISE EXCEPTION 'Retention acknowledgement outbox must remain permanently inert'; END IF;
 IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='retention.review.acknowledge' AND is_sensitive AND is_staff_assignable) THEN RAISE EXCEPTION 'Retention acknowledgement exact sensitive staff permission required'; END IF;
END $$;
-- End retention acknowledgement exact verification.

-- HQ-1 platform overview exact verification: one fixed HQ-only aggregate read.
-- It has no selector/GUC authority, no client EXECUTE, no direct private source
-- table access, and no action, work, provider, financial, or audit side effects.
DO $$
DECLARE
  runtime_oid oid;
  projection record;
  table_name text;
  role_name text;
BEGIN
  SELECT oid INTO runtime_oid FROM pg_roles WHERE rolname = 'hon_runtime';
  IF runtime_oid IS NULL THEN RAISE EXCEPTION 'HQ overview runtime missing'; END IF;

  SELECT p.*, owner.rolsuper OR owner.rolbypassrls AS trusted_owner,
    has_function_privilege('hon_runtime', p.oid, 'EXECUTE') AS runtime_execute,
    has_function_privilege('hon_runtime', p.oid, 'EXECUTE WITH GRANT OPTION') AS runtime_grantable,
    pg_get_functiondef(p.oid) AS definition
  INTO projection
  FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner
  WHERE p.oid = 'hon.read_hq_platform_overview(text)'::regprocedure;

  IF projection.oid IS NULL OR projection.prosecdef IS DISTINCT FROM true
    OR projection.provolatile <> 's'
    OR projection.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
    OR projection.trusted_owner IS DISTINCT FROM true
    OR projection.runtime_execute IS DISTINCT FROM true
    OR projection.runtime_grantable IS DISTINCT FROM false
    OR position('current_setting' IN projection.definition) <> 0
    OR position('resolve_hq_operator_scope' IN projection.definition) = 0
    OR position('hq.dashboard.view' IN projection.definition) = 0
    OR position('HON_HQ_OWNER' IN projection.definition) = 0
    OR position('HON_HQ_OPERATOR' IN projection.definition) = 0
    OR projection.definition ~* '\m(insert|update|delete|merge|call)\M'
    OR EXISTS (
      SELECT 1
      FROM aclexplode(coalesce(projection.proacl, acldefault('f', projection.proowner))) acl
      WHERE acl.privilege_type <> 'EXECUTE'
        OR acl.is_grantable
        OR acl.grantor <> projection.proowner
        OR (acl.grantee <> projection.proowner AND acl.grantee <> runtime_oid)
    )
    OR (SELECT count(*) FROM aclexplode(coalesce(projection.proacl, acldefault('f', projection.proowner))) acl
        WHERE acl.grantee = projection.proowner AND acl.privilege_type = 'EXECUTE' AND NOT acl.is_grantable) <> 1
    OR (SELECT count(*) FROM aclexplode(coalesce(projection.proacl, acldefault('f', projection.proowner))) acl
        WHERE acl.grantee = runtime_oid AND acl.privilege_type = 'EXECUTE' AND NOT acl.is_grantable) <> 1 THEN
    RAISE EXCEPTION 'Unsafe HQ overview function ACL, authority, or definition';
  END IF;

  FOREACH table_name IN ARRAY ARRAY['organizations','schools','hq_onboarding_requests','hq_ai_provider_connections','hq_ai_task_profiles'] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c JOIN pg_roles owner ON owner.oid = c.relowner
      WHERE c.oid = ('hon.' || table_name)::regclass
        AND c.relrowsecurity AND c.relforcerowsecurity
        AND (owner.rolsuper OR owner.rolbypassrls)
        AND c.relowner <> runtime_oid
    ) THEN RAISE EXCEPTION 'HQ overview source is not forced RLS/private: %', table_name; END IF;
    IF has_table_privilege('hon_runtime', 'hon.' || table_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime', 'hon.' || table_name, 'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'HQ overview direct runtime source access: %', table_name;
    END IF;
  END LOOP;

  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name)
      AND has_function_privilege(role_name, 'hon.read_hq_platform_overview(text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'HQ overview client execute: %', role_name;
    END IF;
  END LOOP;
END;
$$;
-- End HQ-1 platform overview exact verification.

-- HQ School Management exact verification: a fixed, selector-free customer
-- directory. It admits only the existing live HQ owner/operator resolver and
-- exposes no direct source-table, client, support, or mutation authority.
DO $$
DECLARE
  runtime_oid oid;
  projection record;
  table_name text;
  role_name text;
BEGIN
  SELECT oid INTO runtime_oid FROM pg_roles WHERE rolname = 'hon_runtime';
  IF runtime_oid IS NULL THEN RAISE EXCEPTION 'HQ school directory runtime missing'; END IF;
  SELECT p.*, owner.rolsuper OR owner.rolbypassrls AS trusted_owner,
    has_function_privilege('hon_runtime', p.oid, 'EXECUTE') AS runtime_execute,
    has_function_privilege('hon_runtime', p.oid, 'EXECUTE WITH GRANT OPTION') AS runtime_grantable,
    pg_get_functiondef(p.oid) AS definition
  INTO projection
  FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner
  WHERE p.oid = 'hon.read_hq_school_directory(text)'::regprocedure;
  IF projection.oid IS NULL OR projection.prosecdef IS DISTINCT FROM true
    OR projection.provolatile <> 's'
    OR projection.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
    OR projection.trusted_owner IS DISTINCT FROM true
    OR projection.runtime_execute IS DISTINCT FROM true
    OR projection.runtime_grantable IS DISTINCT FROM false
    OR position('current_setting' IN projection.definition) <> 0
    OR position('resolve_hq_operator_scope' IN projection.definition) = 0
    OR position('hq.dashboard.view' IN projection.definition) = 0
    OR position('HON_HQ_OWNER' IN projection.definition) = 0
    OR position('HON_HQ_OPERATOR' IN projection.definition) = 0
    OR position('jsonb_build_object' IN projection.definition) = 0
    OR projection.definition ~* '\m(legal_name|email|principal|user_id|student|family|attendance|curriculum|payment|invoice|provider|credential|usage|cost|support|impersonation|audit|outbox|action)\M'
    OR projection.definition ~* '\m(insert|update|delete|merge|call)\M'
    OR EXISTS (
      SELECT 1
      FROM aclexplode(coalesce(projection.proacl, acldefault('f', projection.proowner))) acl
      WHERE acl.privilege_type <> 'EXECUTE'
        OR acl.is_grantable
        OR acl.grantor <> projection.proowner
        OR (acl.grantee <> projection.proowner AND acl.grantee <> runtime_oid)
    )
    OR (SELECT count(*) FROM aclexplode(coalesce(projection.proacl, acldefault('f', projection.proowner))) acl
        WHERE acl.grantee = projection.proowner AND acl.privilege_type = 'EXECUTE' AND NOT acl.is_grantable) <> 1
    OR (SELECT count(*) FROM aclexplode(coalesce(projection.proacl, acldefault('f', projection.proowner))) acl
        WHERE acl.grantee = runtime_oid AND acl.privilege_type = 'EXECUTE' AND NOT acl.is_grantable) <> 1 THEN
    RAISE EXCEPTION 'Unsafe HQ school directory function ACL, authority, or definition';
  END IF;
  FOREACH table_name IN ARRAY ARRAY['organizations','schools','organization_entitlements'] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c JOIN pg_roles owner ON owner.oid = c.relowner
      WHERE c.oid = ('hon.' || table_name)::regclass
        AND c.relrowsecurity AND c.relforcerowsecurity
        AND (owner.rolsuper OR owner.rolbypassrls)
        AND c.relowner <> runtime_oid
    ) THEN RAISE EXCEPTION 'HQ school directory source is not forced RLS/private: %', table_name; END IF;
    IF has_table_privilege('hon_runtime', 'hon.' || table_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime', 'hon.' || table_name, 'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'HQ school directory direct runtime source access: %', table_name;
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name)
      AND has_function_privilege(role_name, 'hon.read_hq_school_directory(text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'HQ school directory client execute: %', role_name;
    END IF;
  END LOOP;
END;
$$;
-- End HQ school directory exact verification.

-- Current organization entitlement exact verification: a no-argument tier-only
-- read for conventional tenant transactions, never a raw source-table exception.
DO $$
DECLARE
  runtime_oid oid;
  projection record;
  role_name text;
BEGIN
  SELECT oid INTO runtime_oid FROM pg_roles WHERE rolname = 'hon_runtime'
    AND rolcanlogin AND NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication);
  IF runtime_oid IS NULL OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = runtime_oid) THEN
    RAISE EXCEPTION 'Unsafe current organization entitlement runtime role';
  END IF;
  SELECT p.*, owner.rolsuper OR owner.rolbypassrls AS trusted_owner,
    pg_get_function_result(p.oid) AS result_shape,
    has_function_privilege('hon_runtime', p.oid, 'EXECUTE') AS runtime_execute,
    has_function_privilege('hon_runtime', p.oid, 'EXECUTE WITH GRANT OPTION') AS runtime_grantable
  INTO projection
  FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner
  WHERE p.oid = 'hon.read_current_organization_entitlement()'::regprocedure;
  IF projection.oid IS NULL OR projection.proowner = runtime_oid
    OR projection.trusted_owner IS DISTINCT FROM true
    OR projection.prosecdef IS DISTINCT FROM true OR projection.provolatile <> 's'
    OR projection.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'sql')
    OR projection.pronargs <> 0 OR projection.result_shape <> 'TABLE(tier text)'
    OR projection.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
    OR projection.runtime_execute IS DISTINCT FROM true OR projection.runtime_grantable IS DISTINCT FROM false
    OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'hon' AND p.proname = 'read_current_organization_entitlement') <> 1
    OR trim(regexp_replace(projection.prosrc, '\s+', ' ', 'g')) IS DISTINCT FROM
      'SELECT entitlement.tier::text FROM hon.organization_entitlements AS entitlement WHERE entitlement.organization_id = hon.current_organization_id() AND entitlement.status = ''ACTIVE''::hon.membership_status AND entitlement.effective_from <= current_timestamp AND (entitlement.effective_until IS NULL OR entitlement.effective_until > statement_timestamp())'
    OR EXISTS (
      SELECT 1 FROM aclexplode(coalesce(projection.proacl, acldefault('f', projection.proowner))) acl
      WHERE acl.privilege_type <> 'EXECUTE' OR acl.is_grantable OR acl.grantor <> projection.proowner
        OR acl.grantee NOT IN (projection.proowner, runtime_oid)
    )
    OR (SELECT count(*) FROM aclexplode(coalesce(projection.proacl, acldefault('f', projection.proowner))) acl
        WHERE acl.grantee = runtime_oid AND acl.privilege_type = 'EXECUTE' AND NOT acl.is_grantable) <> 1
    OR (SELECT count(*) FROM aclexplode(coalesce(projection.proacl, acldefault('f', projection.proowner))) acl
        WHERE acl.grantee = projection.proowner AND acl.privilege_type = 'EXECUTE' AND NOT acl.is_grantable) <> 1 THEN
    RAISE EXCEPTION 'Unsafe current organization entitlement function definition, owner, or ACL';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_roles owner ON owner.oid = c.relowner
    WHERE c.oid = 'hon.organization_entitlements'::regclass
      AND c.relrowsecurity AND c.relforcerowsecurity AND c.relowner <> runtime_oid
      AND (owner.rolsuper OR owner.rolbypassrls)
  ) THEN RAISE EXCEPTION 'Unsafe entitlement source owner or forced RLS'; END IF;
  IF has_table_privilege('hon_runtime', 'hon.organization_entitlements', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime', 'hon.organization_entitlements', 'SELECT,INSERT,UPDATE,REFERENCES')
    OR EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
      WHERE c.oid = 'hon.organization_entitlements'::regclass AND acl.grantee IN (0, runtime_oid))
    OR EXISTS (SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) acl
      WHERE att.attrelid = 'hon.organization_entitlements'::regclass AND att.attnum > 0 AND NOT att.attisdropped
        AND acl.grantee IN (0, runtime_oid)) THEN
    RAISE EXCEPTION 'Forbidden raw entitlement table or column privilege';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) AND (
      has_function_privilege(role_name, projection.oid, 'EXECUTE')
      OR has_table_privilege(role_name, 'hon.organization_entitlements', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(role_name, 'hon.organization_entitlements', 'SELECT,INSERT,UPDATE,REFERENCES')
    ) THEN RAISE EXCEPTION 'Forbidden client entitlement privilege: %', role_name; END IF;
  END LOOP;
END;
$$;
-- End current organization entitlement exact verification.

-- Retention factual attention exact verification:
DO $$ DECLARE t text; f record; runtime_oid oid; executable boolean; signature text; expected_hash text; BEGIN
 SELECT oid INTO runtime_oid FROM pg_roles WHERE rolname='hon_runtime';
 IF runtime_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=runtime_oid AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication) OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=runtime_oid) THEN RAISE EXCEPTION 'Retention attention restricted runtime required'; END IF;
 FOREACH t IN ARRAY ARRAY['retention_attention_alerts','retention_attention_resolutions','retention_attention_record_receipts','retention_attention_resolution_receipts','retention_attention_outbox'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND c.relowner<>runtime_oid) OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=('hon.'||t)::regclass) THEN RAISE EXCEPTION 'Retention attention forced no-policy trusted RLS: %',t; END IF;
  IF EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid,LATERAL aclexplode(att.attacl) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner)
   OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Retention attention table/column ACL surplus: %',t; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND NOT tgisinternal AND tgenabled='O' AND tgfoid='hon.guard_campaign_history()'::regprocedure AND tgtype IN(27,34))<>2 THEN RAISE EXCEPTION 'Retention attention immutable guards: %',t; END IF;
  IF (SELECT array_agg(attname::text||':'||atttypid::regtype::text||':'||attnotnull::text ORDER BY attnum) FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped) IS DISTINCT FROM (CASE t
   WHEN 'retention_attention_alerts' THEN ARRAY['id:uuid:true','organization_id:uuid:true','school_id:uuid:true','membership_id:uuid:true','actor_principal_id:uuid:true','evidence_code:text:true','evidence_version:text:true','evidence_fingerprint:text:true','observed_at:timestamp with time zone:true','created_at:timestamp with time zone:true']
   WHEN 'retention_attention_resolutions' THEN ARRAY['id:uuid:true','organization_id:uuid:true','school_id:uuid:true','membership_id:uuid:true','alert_id:uuid:true','actor_principal_id:uuid:true','expected_alert_version:integer:true','resolution_reason:text:true','resolved_at:timestamp with time zone:true']
   WHEN 'retention_attention_record_receipts' THEN ARRAY['id:uuid:true','organization_id:uuid:true','school_id:uuid:true','membership_id:uuid:true','actor_principal_id:uuid:true','alert_id:uuid:true','idempotency_digest:bytea:true']
   WHEN 'retention_attention_resolution_receipts' THEN ARRAY['id:uuid:true','organization_id:uuid:true','school_id:uuid:true','membership_id:uuid:true','actor_principal_id:uuid:true','alert_id:uuid:true','resolution_id:uuid:true','idempotency_digest:bytea:true']
   WHEN 'retention_attention_outbox' THEN ARRAY['id:uuid:true','organization_id:uuid:true','school_id:uuid:true','membership_id:uuid:true','alert_id:uuid:true','fact_version:integer:true','event_code:text:true','state:text:true']
   END) THEN RAISE EXCEPTION 'Retention attention exact closed columns: %',t; END IF;
  IF EXISTS(SELECT 1 FROM pg_constraint fk WHERE fk.conrelid=('hon.'||t)::regclass AND fk.contype='f' AND fk.confrelid<>'hon.principals'::regclass AND (cardinality(fk.conkey)<3 OR fk.confdeltype<>'r' OR NOT fk.convalidated
   OR NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=fk.conrelid AND a.attname='organization_id' AND a.attnum=ANY(fk.conkey)) OR NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=fk.conrelid AND a.attname='school_id' AND a.attnum=ANY(fk.conkey)))) THEN RAISE EXCEPTION 'Retention attention composite scope FK: %',t; END IF;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['require_retention_attention_actor(text,text)','retention_attention_codes(jsonb)','retention_attention_projection(uuid,boolean)','read_retention_attention_alerts(text,uuid)','read_retention_attention_evidence(text,uuid)','record_retention_attention_alert(text,uuid,text,text,timestamptz,text,uuid,uuid,uuid)','resolve_retention_attention_alert(text,uuid,uuid,integer,text,uuid,uuid,uuid)'] LOOP
  SELECT p.*,o.rolsuper,o.rolbypassrls INTO f FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=('hon.'||signature)::regprocedure;
  executable:=signature=ANY(ARRAY['read_retention_attention_alerts(text,uuid)','read_retention_attention_evidence(text,uuid)','record_retention_attention_alert(text,uuid,text,text,timestamptz,text,uuid,uuid,uuid)','resolve_retention_attention_alert(text,uuid,uuid,integer,text,uuid,uuid,uuid)']);
  expected_hash:=CASE f.proname
   WHEN 'require_retention_attention_actor' THEN 'f12626ace67e3aa93e9f861a7d35358e'
   WHEN 'retention_attention_codes' THEN 'ea2c9aa28af662f43feab68b4f04a4c9'
   WHEN 'retention_attention_projection' THEN 'dbd15eebc44818997a54e2ec032674fa'
   WHEN 'read_retention_attention_alerts' THEN '68db75da2883379c7f202951d261b165'
   WHEN 'read_retention_attention_evidence' THEN '70b7f7d485da78b584a279e8c1c31d70'
   WHEN 'record_retention_attention_alert' THEN 'd832cb12d92a6b221b7d2760bff74197'
   WHEN 'resolve_retention_attention_alert' THEN '57bbac30f588cfbefb3e4a5a31a3c872'
   END;
  IF f.oid IS NULL OR f.proowner=runtime_oid OR NOT(f.rolsuper OR f.rolbypassrls) OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon'] OR NOT f.prosecdef OR f.provolatile<>'v' OR f.prorettype<>'jsonb'::regtype AND f.proname<>'require_retention_attention_actor' OR md5(f.prosrc) IS DISTINCT FROM expected_hash THEN RAISE EXCEPTION 'Retention attention fixed function posture/body: %',signature; END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>f.proowner OR (a.grantee<>f.proowner AND (NOT executable OR a.grantee<>runtime_oid)))
   OR (SELECT count(*) FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=f.proowner AND NOT a.is_grantable)<>1
   OR (SELECT count(*) FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=runtime_oid AND NOT a.is_grantable)<>(CASE WHEN executable THEN 1 ELSE 0 END)
   OR has_function_privilege('hon_runtime',f.oid,'EXECUTE') IS DISTINCT FROM executable OR has_function_privilege('hon_runtime',f.oid,'EXECUTE WITH GRANT OPTION') THEN RAISE EXCEPTION 'Retention attention exact function-only ACL: %',signature; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.retention_attention_alerts'::regclass AND conname='retention_attention_natural_key' AND contype='u' AND convalidated AND NOT condeferrable AND pg_get_constraintdef(oid)='UNIQUE (organization_id, school_id, membership_id, evidence_code, evidence_version, evidence_fingerprint, observed_at)') THEN RAISE EXCEPTION 'Retention attention school-wide natural evidence key required'; END IF;
 FOREACH t IN ARRAY ARRAY['retention_attention_record_receipts','retention_attention_resolution_receipts'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=('hon.'||t)::regclass AND contype='u' AND NOT condeferrable AND pg_get_constraintdef(oid)='UNIQUE (organization_id, school_id, actor_principal_id, idempotency_digest)') THEN RAISE EXCEPTION 'Retention attention scoped receipt key: %',t; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.retention_attention_resolutions'::regclass AND contype='u' AND NOT condeferrable AND pg_get_constraintdef(oid)='UNIQUE (alert_id)') THEN RAISE EXCEPTION 'Retention attention one resolution only'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.retention_attention_outbox'::regclass AND contype='c' AND pg_get_constraintdef(oid)='CHECK ((state = ''INERT''::text))') THEN RAISE EXCEPTION 'Retention attention permanently inert fact required'; END IF;
 IF (SELECT count(*) FROM hon.permissions WHERE code IN('retention.review.alert.read','retention.review.alert.record','retention.review.alert.resolve') AND is_sensitive AND is_staff_assignable)<>3 THEN RAISE EXCEPTION 'Retention attention exact sensitive staff permissions required'; END IF;
END $$;
-- End retention factual attention exact verification.

-- Curriculum library exact verification:
-- 0605 replaced the bodies of hon.guard_curriculum_resource, hon.curriculum_resource_projection, hon.mutate_curriculum_resource and
-- hon.read_parent_curriculum_library (cycle column, DOCUMENT kind); their hashes below are the 0605 bodies.
DO $$ DECLARE t text; c record; signature text; f record; expected_hash text; executable boolean; runtime_oid oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'); BEGIN
 IF runtime_oid IS NULL THEN RAISE EXCEPTION 'Library restricted runtime missing'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE oid=runtime_oid AND (NOT rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication)) OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=runtime_oid) OR has_schema_privilege('hon_runtime','hon','CREATE') THEN RAISE EXCEPTION 'Library unsafe runtime role'; END IF;
 FOREACH t IN ARRAY ARRAY['curriculum_resources','curriculum_resource_versions','curriculum_resource_requests','curriculum_resource_facts'] LOOP
  SELECT * INTO c FROM pg_class WHERE oid=to_regclass('hon.'||t);
  IF c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR c.relowner=runtime_oid OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid) THEN RAISE EXCEPTION 'Library forced deny-all RLS: %',t; END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute p CROSS JOIN LATERAL aclexplode(p.attacl) a WHERE p.attrelid=c.oid AND a.grantee<>c.relowner)
   OR has_table_privilege('hon_runtime',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN RAISE EXCEPTION 'Library private table/column ACL: %',t; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal AND tgenabled='O')<>2 THEN RAISE EXCEPTION 'Library immutable guards missing: %',t; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=c.relowner AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Library trusted table owner required: %',t; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal AND tgenabled='O' AND tgfoid=(CASE WHEN t='curriculum_resources' THEN 'hon.guard_curriculum_resource()'::regprocedure ELSE 'hon.guard_curriculum_history()'::regprocedure END) AND tgtype IN(27,34))<>2 THEN RAISE EXCEPTION 'Library exact immutable guard functions/events required: %',t; END IF;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['valid_curriculum_resource_url(text)','guard_curriculum_resource()','lock_curriculum_resource_actor(text)','curriculum_resource_projection(hon.curriculum_resources)','read_staff_curriculum_library(text)','mutate_curriculum_resource(text,text,uuid,jsonb,text,uuid,uuid)','read_parent_curriculum_library(text,uuid)'] LOOP
  SELECT p.*,r.rolsuper,r.rolbypassrls INTO f FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=to_regprocedure('hon.'||signature);
  executable:=signature=ANY(ARRAY['read_staff_curriculum_library(text)','mutate_curriculum_resource(text,text,uuid,jsonb,text,uuid,uuid)','read_parent_curriculum_library(text,uuid)']);
  expected_hash:=CASE f.proname
   WHEN 'valid_curriculum_resource_url' THEN '22469a4242d744d498c09f3460790a93'
   WHEN 'guard_curriculum_resource' THEN '9415c4fbb3dccc8db1ea397fefe0eae9'
   WHEN 'lock_curriculum_resource_actor' THEN '72cca48e824d14f17bbf843211f1f61c'
   WHEN 'curriculum_resource_projection' THEN '4c351e8084546fc3e63351d94e1ebfec'
   WHEN 'read_staff_curriculum_library' THEN 'ff6afaae7d2cd119087fa27433a9ebcd'
   WHEN 'mutate_curriculum_resource' THEN '21887d0bd0f8aff8a9febee355e2cd59'
   WHEN 'read_parent_curriculum_library' THEN '5afab2b94053609f85f50e72f2575d83'
   END;
  IF f.oid IS NULL OR f.proowner=runtime_oid OR NOT(f.rolsuper OR f.rolbypassrls) OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
   OR f.prosecdef IS DISTINCT FROM (signature=ANY(ARRAY['lock_curriculum_resource_actor(text)','read_staff_curriculum_library(text)','mutate_curriculum_resource(text,text,uuid,jsonb,text,uuid,uuid)','read_parent_curriculum_library(text,uuid)'])) OR f.provolatile IS DISTINCT FROM (CASE WHEN signature=ANY(ARRAY['valid_curriculum_resource_url(text)','curriculum_resource_projection(hon.curriculum_resources)']) THEN 'i'::"char" ELSE 'v'::"char" END)
   OR md5(f.prosrc) IS DISTINCT FROM expected_hash THEN RAISE EXCEPTION 'Library fixed function posture/body: %',signature; END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>f.proowner OR (a.grantee<>f.proowner AND (NOT executable OR a.grantee<>runtime_oid)))
   OR (SELECT count(*) FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=f.proowner AND NOT a.is_grantable)<>1
   OR (SELECT count(*) FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=runtime_oid AND NOT a.is_grantable)<>(CASE WHEN executable THEN 1 ELSE 0 END)
   OR has_function_privilege('hon_runtime',f.oid,'EXECUTE') IS DISTINCT FROM executable OR has_function_privilege('hon_runtime',f.oid,'EXECUTE WITH GRANT OPTION') THEN RAISE EXCEPTION 'Library exact function-only ACL: %',signature; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.curriculum_resource_requests'::regclass AND contype='p' AND convalidated AND NOT condeferrable AND pg_get_constraintdef(oid)='PRIMARY KEY (organization_id, school_id, principal_id, idempotency_key)') THEN RAISE EXCEPTION 'Library scoped receipt key required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.curriculum_resources'::regclass AND contype='f' AND convalidated AND confrelid='hon.curriculum_ranks'::regclass AND pg_get_constraintdef(oid)='FOREIGN KEY (rank_id, curriculum_id, organization_id, school_id) REFERENCES hon.curriculum_ranks(id, curriculum_id, organization_id, school_id)') THEN RAISE EXCEPTION 'Library exact rank relationship required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.curriculum_resource_facts'::regclass AND contype='c' AND pg_get_constraintdef(oid)='CHECK ((state = ''INERT''::text))') THEN RAISE EXCEPTION 'Library permanently inert facts required'; END IF;
END $$;
-- End curriculum library exact verification.

-- Owner launch exact verification:
DO $$ DECLARE t text; f record; b boolean; trigger_name text; trigger_type integer; BEGIN
 FOREACH t IN ARRAY ARRAY['student_registration_receipts','student_registration_outbox','guardian_child_registration_receipts','guardian_child_registration_outbox'] LOOP
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee<>c.relowner)
  INTO b FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
  IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe owner launch table %',t; END IF;
  FOR trigger_name,trigger_type IN SELECT * FROM (VALUES('registration_immutable',27),('registration_no_truncate',34)) v(n,k) LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgname=trigger_name AND tgtype=trigger_type AND tgfoid='hon.guard_curriculum_history()'::regprocedure AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred) THEN RAISE EXCEPTION 'Unsafe registration trigger %.%',t,trigger_name; END IF;
  END LOOP;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES
  ('hon.guard_enrollment_program_identity()',false,false),('hon.resolve_owner_launch_scope(text)',true,true),
  ('hon.require_owner_launch_actor(text)',false,true),('hon.lock_owner_launch_actor(text)',false,true),
  ('hon.register_owner_launch_student(text,jsonb,text,uuid,uuid)',true,true),('hon.read_owner_launch(text)',true,true),('hon.read_owner_launch_saved_students(text)',true,true),('hon.require_owner_launch_family_actor(text)',false,true),('hon.register_owner_launch_guardian_child(text,jsonb,text,uuid,uuid)',true,true),('hon.book_owner_launch_first_class(text,jsonb,text,uuid,uuid)',true,true),('hon.draft_owner_launch_membership(text,jsonb,text,uuid,uuid)',true,true),('hon.read_owner_launch_membership_draft(text)',true,true),('hon.read_owner_launch_first_class_booking_context(text)',true,true)
 ) v(signature,can_execute,is_definer) LOOP
  SELECT p.prosecdef=f.is_definer AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
   AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
  INTO b FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe owner launch function %',f.signature; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.student_registration_outbox'::regclass AND conname='student_registration_outbox_state_check' AND convalidated AND pg_get_constraintdef(oid)=$def$CHECK ((state = 'INERT'::text))$def$)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.student_registration_outbox'::regclass AND conname='student_registration_outbox_event_code_check' AND convalidated AND pg_get_constraintdef(oid)=$def$CHECK ((event_code = 'student.registered.v1'::text))$def$)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.student_curriculum_enrollments'::regclass AND conname='enrollment_program_scope_fk' AND contype='f' AND convalidated)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.student_curriculum_enrollments'::regclass AND conname='enrollment_truthful_target' AND contype='c' AND convalidated)
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.student_curriculum_enrollments'::regclass AND tgname='enrollment_program_identity' AND tgfoid='hon.guard_enrollment_program_identity()'::regprocedure AND tgenabled='O' AND tgtype=19) THEN RAISE EXCEPTION 'Unsafe owner launch enrollment/outbox integrity'; END IF;
END $$;
DO $$ DECLARE f record; expected record; BEGIN
 FOR f IN SELECT * FROM (VALUES
 ('student_registration_receipts','registration_enrollment_relation_fk','FOREIGN KEY (enrollment_id, student_profile_id, program_id, organization_id, school_id) REFERENCES hon.student_curriculum_enrollments(id, student_profile_id, program_id, organization_id, school_id)'),
 ('student_registration_receipts','registration_class_program_fk','FOREIGN KEY (class_session_id, program_id, organization_id, school_id) REFERENCES hon.class_sessions(id, program_id, organization_id, school_id)'),
 ('student_registration_outbox','registration_outbox_scope_fk','FOREIGN KEY (registration_id, organization_id, school_id) REFERENCES hon.student_registration_receipts(id, organization_id, school_id)'),
 ('guardian_child_registration_receipts','child_registration_guardian_fk','FOREIGN KEY (guardian_member_id, family_id, guardian_person_id, guardian_role, organization_id, school_id) REFERENCES hon.family_members(id, family_id, person_id, member_role, organization_id, school_id)'),
 ('guardian_child_registration_receipts','child_registration_child_fk','FOREIGN KEY (child_member_id, family_id, child_person_id, child_role, organization_id, school_id) REFERENCES hon.family_members(id, family_id, person_id, member_role, organization_id, school_id)'),
 ('guardian_child_registration_receipts','child_registration_student_family_fk','FOREIGN KEY (student_profile_id, child_person_id, family_id, organization_id, school_id) REFERENCES hon.student_profiles(id, person_id, primary_family_id, organization_id, school_id)'),
 ('guardian_child_registration_receipts','child_registration_enrollment_fk','FOREIGN KEY (enrollment_id, student_profile_id, program_id, organization_id, school_id) REFERENCES hon.student_curriculum_enrollments(id, student_profile_id, program_id, organization_id, school_id)'),
 ('guardian_child_registration_receipts','child_registration_class_fk','FOREIGN KEY (class_session_id, program_id, organization_id, school_id) REFERENCES hon.class_sessions(id, program_id, organization_id, school_id)'),
 ('guardian_child_registration_outbox','child_registration_outbox_scope_fk','FOREIGN KEY (registration_id, organization_id, school_id) REFERENCES hon.guardian_child_registration_receipts(id, organization_id, school_id)')
 ) v(tbl,name,definition) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=format('hon.%I',f.tbl)::regclass AND conname=f.name AND contype='f' AND convalidated AND NOT condeferrable AND pg_get_constraintdef(oid)=f.definition) THEN RAISE EXCEPTION 'Unsafe registration relation %.%',f.tbl,f.name; END IF;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
 ('student_registration_receipts',ARRAY['id','organization_id','school_id','actor_principal_id','student_profile_id','enrollment_id','program_id','class_session_id','idempotency_digest','fingerprint','receipt','created_at']::text[]),
 ('student_registration_outbox',ARRAY['registration_id','organization_id','school_id','event_code','state']::text[]),
 ('guardian_child_registration_receipts',ARRAY['id','organization_id','school_id','actor_principal_id','family_id','guardian_person_id','child_person_id','guardian_member_id','child_member_id','guardian_role','child_role','student_profile_id','enrollment_id','program_id','class_session_id','idempotency_digest','fingerprint','receipt','created_at']::text[]),
 ('guardian_child_registration_outbox',ARRAY['registration_id','organization_id','school_id','event_code','state']::text[])
 ) v(tbl,cols) LOOP
  IF (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid=format('hon.%I',expected.tbl)::regclass AND attnum>0 AND NOT attisdropped) IS DISTINCT FROM expected.cols
   OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=format('hon.%I',expected.tbl)::regclass AND attnum>0 AND NOT attisdropped AND NOT attnotnull) THEN RAISE EXCEPTION 'Unsafe registration columns %',expected.tbl; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='hon.enrollment_student_program_unique'::regclass AND indisunique AND indisvalid AND pg_get_expr(indpred,indrelid)='(program_id IS NOT NULL)')
  OR has_column_privilege('hon_runtime','hon.student_curriculum_enrollments','program_id','UPDATE')
  OR has_table_privilege('hon_runtime','hon.student_curriculum_enrollments','INSERT') THEN RAISE EXCEPTION 'Unsafe program enrollment command boundary'; END IF;
END $$;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT * FROM (VALUES
 ('guardian_child_registration_outbox',$def$CHECK ((state = 'INERT'::text))$def$),
 ('guardian_child_registration_outbox',$def$CHECK ((event_code = 'student.guardian_child_registered.v1'::text))$def$),
 ('guardian_child_registration_receipts',$def$CHECK ((guardian_role = 'GUARDIAN'::hon.family_member_role))$def$),
 ('guardian_child_registration_receipts',$def$CHECK ((child_role = 'STUDENT'::hon.family_member_role))$def$),
 ('guardian_child_registration_receipts','CHECK (((guardian_person_id <> child_person_id) AND (guardian_member_id <> child_member_id)))'),
 ('guardian_child_registration_receipts','CHECK ((octet_length(idempotency_digest) = 32))'),
 ('guardian_child_registration_receipts','CHECK ((octet_length(fingerprint) = 32))')
 ) v(tbl,definition) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=format('hon.%I',f.tbl)::regclass AND contype='c' AND convalidated AND pg_get_constraintdef(oid)=f.definition) THEN RAISE EXCEPTION 'Unsafe child registration invariant %',f.tbl; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.guardian_child_registration_receipts'::regclass AND contype='u' AND convalidated AND NOT condeferrable AND pg_get_constraintdef(oid)='UNIQUE (organization_id, school_id, actor_principal_id, idempotency_digest)') THEN RAISE EXCEPTION 'Child registration scoped replay key required'; END IF;
END $$;
DO $$ BEGIN
 -- read_owner_launch_membership_draft: 0169 body (same tables and mode as 0139, canonical lock order).
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='hon.read_owner_launch_membership_draft(text)'::regprocedure) IS DISTINCT FROM '1f3b2c97a98d71b279e38db7e39f646b' THEN RAISE EXCEPTION 'Owner launch DRAFT confirmation body drift'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='hon.read_owner_launch_first_class_booking_context(text)'::regprocedure) IS DISTINCT FROM 'aa3867a643ba61d184acccfeab21e179' THEN RAISE EXCEPTION 'Owner launch booking context body drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid='hon.read_owner_launch_first_class_booking_context(text)'::regprocedure AND p.prorettype='jsonb'::regtype AND NOT p.proretset AND p.prokind='f' AND p.proargnames=ARRAY['p_subject']::text[] AND p.proargmodes IS NULL AND l.lanname='plpgsql'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantor<>p.proowner OR a.is_grantable OR a.privilege_type<>'EXECUTE' OR a.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))=2
 ) THEN RAISE EXCEPTION 'Unsafe exact owner booking context signature/ACL'; END IF;
 IF has_table_privilege('hon_runtime','hon.class_bookings','UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege('hon_runtime','hon.class_bookings','UPDATE') THEN RAISE EXCEPTION 'Unsafe owner launch booking context mutation grant'; END IF;
 IF has_table_privilege('hon_runtime','hon.audit_events','UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('hon_runtime','hon.memberships','DELETE,TRUNCATE')
 OR has_table_privilege('hon_runtime','hon.billing_accounts','UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'Unsafe owner launch canonical relation mutation grant'; END IF;
END $$;
-- End owner launch exact verification.

-- Current staff reporting scope exact verification:
DO $$
DECLARE boundary_safe boolean; table_name text;
BEGIN
  SELECT p.prosecdef AND p.provolatile = 's'
    AND p.proconfig = ARRAY['search_path=pg_catalog, hon']::text[]
    AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname <> 'hon_runtime'
    AND p.proargnames = ARRAY['p_subject','organization_id','school_id']::text[]
    AND p.proallargtypes = ARRAY['text'::regtype,'uuid'::regtype,'uuid'::regtype]::oid[]
    AND has_function_privilege('hon_runtime', p.oid, 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      WHERE acl.grantee <> p.proowner
        AND (acl.grantee <> (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')
          OR acl.is_grantable OR acl.privilege_type <> 'EXECUTE')
    )
    AND (SELECT count(*) FROM pg_proc other WHERE other.pronamespace = p.pronamespace AND other.proname = p.proname) = 1
  INTO boundary_safe FROM pg_proc p JOIN pg_roles owner_role ON owner_role.oid = p.proowner
  WHERE p.oid = 'hon.resolve_current_staff_reporting_scope(text)'::regprocedure;
  IF boundary_safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe current staff reporting scope boundary'; END IF;
  FOREACH table_name IN ARRAY ARRAY['organizations','schools','roles','role_permissions','principal_role_grants','family_access_grants','hq_operator_grants'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = ('hon.' || table_name)::regclass AND relrowsecurity AND relforcerowsecurity) THEN
      RAISE EXCEPTION 'Current staff reporting scope requires forced RLS: %', table_name;
    END IF;
  END LOOP;
END;
$$;
-- End current staff reporting scope exact verification.
-- Staff reporting schools exact verification:
DO $$
DECLARE boundary_safe boolean; table_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime'))
    OR has_schema_privilege('hon_runtime', 'hon', 'CREATE') THEN
    RAISE EXCEPTION 'Staff reporting schools require a restricted runtime role';
  END IF;
  SELECT p.prosecdef AND p.provolatile = 's' AND p.prokind = 'f' AND p.proretset
    AND p.prorettype = 'record'::regtype AND language.lanname = 'sql'
    AND p.proconfig = ARRAY['search_path=pg_catalog, hon']::text[]
    AND (owner_role.rolsuper OR owner_role.rolbypassrls)
    AND owner_role.rolname NOT IN ('hon_runtime', 'anon', 'authenticated', 'service_role')
    AND p.proargnames = ARRAY['p_subject','organization_id','school_id','organization_name','school_name']::text[]
    AND p.proallargtypes = ARRAY['text'::regtype,'uuid'::regtype,'uuid'::regtype,'text'::regtype,'text'::regtype]::oid[]
    AND p.proargmodes = ARRAY['i','t','t','t','t']::"char"[]
    AND md5(p.prosrc) = '0d2ca236834b34b6453a99714e0ad85c'
    AND has_function_privilege('hon_runtime', p.oid, 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      WHERE acl.grantor <> p.proowner OR acl.is_grantable OR acl.privilege_type <> 'EXECUTE'
        OR acl.grantee NOT IN (p.proowner, (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime'))
    )
    AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))) = 2
    AND (SELECT count(*) FROM pg_proc other WHERE other.pronamespace = p.pronamespace AND other.proname = p.proname) = 1
  INTO boundary_safe FROM pg_proc p JOIN pg_roles owner_role ON owner_role.oid = p.proowner
    JOIN pg_language language ON language.oid = p.prolang
  WHERE p.oid = 'hon.read_staff_reporting_schools(text)'::regprocedure;
  IF boundary_safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe staff reporting schools boundary'; END IF;
  FOREACH table_name IN ARRAY ARRAY['organizations','schools','roles','role_permissions','principal_role_grants','family_access_grants','hq_operator_grants'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = ('hon.' || table_name)::regclass AND relrowsecurity AND relforcerowsecurity) THEN
      RAISE EXCEPTION 'Staff reporting schools require forced RLS: %', table_name;
    END IF;
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['users','principals','permissions','organizations','schools','roles','role_permissions','principal_role_grants','family_access_grants','hq_operator_grants'] LOOP
    IF has_table_privilege('hon_runtime', 'hon.' || table_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime', 'hon.' || table_name, 'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Forbidden reporting schools directory access: %', table_name;
    END IF;
  END LOOP;
END;
$$;
-- End staff reporting schools exact verification.

-- Parent planned absence request exact verification:
DO $$ DECLARE f record; b boolean; t text; BEGIN
 FOR f IN SELECT * FROM (VALUES
 ('hon.require_parent_planned_absence_scope(text)',false,'f9d538be1d3f5f8a955a462f3f22906b'),
 ('hon.read_parent_planned_absence_request_context(text)',true,'16c97abd7813ff2a7d97d1d07a873909'),
 ('hon.lock_parent_planned_absence_request(text,uuid,uuid,text)',true,'fff25c11c9a60bc6eb13e75c233f16ef')
 ) v(signature,can_execute,body_hash) LOOP
  SELECT p.prosecdef AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>'hon_runtime'
   AND md5(p.prosrc)=f.body_hash
   AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.can_execute
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.can_execute OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
   AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
  INTO b FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
  IF b IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe parent absence function %',f.signature; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['families','family_members','student_profiles','family_access_grants','people','planned_absence_requests'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=('hon.'||t)::regclass AND relrowsecurity AND relforcerowsecurity) THEN RAISE EXCEPTION 'Parent absence requires forced RLS: %',t; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.planned_absence_requests'::regclass AND tgname='planned_absence_requests_student_family_integrity' AND tgfoid='hon.enforce_planned_absence_student_family()'::regprocedure AND tgenabled='O')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.planned_absence_requests'::regclass AND tgname='planned_absence_requests_initial_state' AND tgfoid='hon.enforce_planned_absence_initial_state()'::regprocedure AND tgenabled='O') THEN RAISE EXCEPTION 'Canonical planned-absence constraints required'; END IF;
END $$;
-- End parent planned absence request exact verification.

-- Planned absence review exact verification:
DO $$ DECLARE f record; p record; runtime_oid oid := (SELECT oid FROM pg_roles WHERE rolname='hon_runtime'); BEGIN
 IF runtime_oid IS NULL OR EXISTS(SELECT 1 FROM pg_roles WHERE oid=runtime_oid AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication)) OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=runtime_oid) THEN RAISE EXCEPTION 'Restricted review runtime required'; END IF;
 FOR f IN SELECT * FROM (VALUES
 ('resolve_planned_absence_review_scope','65f58b6da46c0fa60fc526c046f92dea',true),
 ('require_planned_absence_review_actor','621ec2f50ad2d3e1d7d27d7b39bbeb69',false),
 ('lock_planned_absence_review_actor','dcebc46b1019c65bd399c7f6e944ecb9',true),
 ('read_staff_planned_absence_review_queue','1e8b83a138801e854a0a1bddee9daf77',true)
 ) expected(name,source_md5,runtime_allowed) LOOP
  SELECT proc.*,owner.rolsuper,owner.rolbypassrls INTO p FROM pg_proc proc JOIN pg_roles owner ON owner.oid=proc.proowner WHERE proc.oid=to_regprocedure('hon.'||f.name||'(text)');
  IF p.oid IS NULL OR NOT p.prosecdef OR p.provolatile<>'v' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon'] OR NOT(p.rolsuper OR p.rolbypassrls) OR p.proowner=runtime_oid OR md5(p.prosrc)<>f.source_md5 THEN RAISE EXCEPTION 'Canonical review function required: %',f.name; END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee<>p.proowner AND (acl.grantee<>runtime_oid OR NOT f.runtime_allowed OR acl.is_grantable)) OR has_function_privilege('hon_runtime',p.oid,'EXECUTE') IS DISTINCT FROM f.runtime_allowed THEN RAISE EXCEPTION 'Exact review function ACL required: %',f.name; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hon' AND c.relname='planned_absence_requests' AND c.relrowsecurity AND c.relforcerowsecurity) OR (SELECT count(*) FROM pg_policies WHERE schemaname='hon' AND tablename='planned_absence_requests')<>1 OR NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename='planned_absence_requests' AND policyname='planned_absence_requests_tenant_isolation' AND qual='((organization_id = hon.current_organization_id()) AND (school_id = hon.current_school_id()))' AND with_check=qual) THEN RAISE EXCEPTION 'Original planned absence FORCE RLS policy required'; END IF;
 IF has_table_privilege('hon_runtime','hon.planned_absence_requests','DELETE,TRUNCATE,REFERENCES,TRIGGER') OR NOT has_table_privilege('hon_runtime','hon.planned_absence_requests','SELECT') OR NOT has_table_privilege('hon_runtime','hon.planned_absence_requests','INSERT') OR NOT has_table_privilege('hon_runtime','hon.planned_absence_requests','UPDATE') THEN RAISE EXCEPTION 'Original bounded command table grants required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='schedule.planned_absence.review' AND is_staff_assignable) THEN RAISE EXCEPTION 'Canonical review permission required'; END IF;
END $$;
-- End planned absence review exact verification.

-- CRM-only lead close exact verification:
DO $$ DECLARE f record; p record; runtime_oid oid := (SELECT oid FROM pg_roles WHERE rolname='hon_runtime'); BEGIN
 IF runtime_oid IS NULL OR EXISTS(SELECT 1 FROM pg_roles WHERE oid=runtime_oid AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication)) OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=runtime_oid) OR has_schema_privilege('hon_runtime','hon','CREATE') THEN RAISE EXCEPTION 'Restricted CRM close runtime required'; END IF;
 FOR f IN SELECT * FROM (VALUES
 ('hon.guard_crm_lead_close_history()','9ec7d7514d478b9dff3601332684eabf',false,false),
 ('hon.crm_lead_close_has_permission(uuid,uuid,uuid,text)','37e23a9753e678215568e7d41062a708',false,true),
 ('hon.resolve_crm_lead_close_scope(text,uuid)','7380ca81c43880a7b520796512a9efea',true,true),
 ('hon.require_crm_lead_close_actor(text)','68b00d4367ac0168df9ef6c40bd784e6',false,true),
 ('hon.guard_crm_lead_close_update()','f775069fe766751c7a16f0c4beb9b469',false,false),
 ('hon.close_crm_lead(text,uuid,jsonb,uuid,uuid,uuid)','997766c485ee5825e481a233e9c400e2',true,true)
 ) expected(signature,source_md5,runtime_allowed,definer) LOOP
  SELECT proc.*,owner.rolsuper,owner.rolbypassrls INTO p FROM pg_proc proc JOIN pg_roles owner ON owner.oid=proc.proowner WHERE proc.oid=to_regprocedure(f.signature);
  IF p.oid IS NULL OR p.prosecdef IS DISTINCT FROM f.definer OR p.provolatile<>'v' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon'] OR NOT(p.rolsuper OR p.rolbypassrls) OR p.proowner=runtime_oid OR md5(p.prosrc)<>f.source_md5 OR (SELECT count(*) FROM pg_proc other WHERE other.pronamespace=p.pronamespace AND other.proname=p.proname)<>1 THEN RAISE EXCEPTION 'Canonical CRM close function required: %',f.signature; END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee<>p.proowner AND (acl.grantee<>runtime_oid OR NOT f.runtime_allowed OR acl.is_grantable)) OR has_function_privilege('hon_runtime',p.oid,'EXECUTE') IS DISTINCT FROM f.runtime_allowed THEN RAISE EXCEPTION 'Exact CRM close function ACL required: %',f.signature; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='hon.crm_lead_close_requests'::regclass AND relrowsecurity AND relforcerowsecurity)
  OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename='crm_lead_close_requests')
  OR has_table_privilege('hon_runtime','hon.crm_lead_close_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR has_any_column_privilege('hon_runtime','hon.crm_lead_close_requests','SELECT,INSERT,UPDATE,REFERENCES')
  OR EXISTS(SELECT 1 FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='hon.crm_lead_close_requests'::regclass AND a.grantee<>c.relowner) THEN RAISE EXCEPTION 'Private CRM close FORCE-RLS receipt required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.crm_lead_close_requests'::regclass AND tgname='crm_lead_close_immutable' AND tgfoid='hon.guard_crm_lead_close_history()'::regprocedure AND tgenabled='O' AND tgtype=27)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.crm_lead_close_requests'::regclass AND tgname='crm_lead_close_no_truncate' AND tgfoid='hon.guard_crm_lead_close_history()'::regprocedure AND tgenabled='O' AND tgtype=34)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.crm_leads'::regclass AND tgname='crm_lead_close_update_guard' AND tgfoid='hon.guard_crm_lead_close_update()'::regprocedure AND tgenabled='O' AND tgtype=19) THEN RAISE EXCEPTION 'Canonical CRM close triggers required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='crm.lead.close' AND is_sensitive AND is_staff_assignable) THEN RAISE EXCEPTION 'Exact staff CRM close permission required'; END IF;
END $$;
-- End CRM-only lead close exact verification.

-- HQ entitlement transition exact verification:
DO $$ DECLARE f record; p record; t text; runtime_oid oid := (SELECT oid FROM pg_roles WHERE rolname='hon_runtime'); BEGIN
  IF runtime_oid IS NULL OR EXISTS(SELECT 1 FROM pg_roles WHERE oid=runtime_oid AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication))
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=runtime_oid) OR has_schema_privilege('hon_runtime','hon','CREATE') THEN RAISE EXCEPTION 'Restricted HQ entitlement runtime required'; END IF;
  FOR f IN SELECT * FROM (VALUES
    ('hon.guard_hq_entitlement_evidence()','918eb49dd64a752e408f32dfe38da61f',false,false,'trigger'),
    ('hon.require_hq_entitlement_actor(text)','39a28e82a9f0168ea33e82731d761289',false,true,'uuid'),
    ('hon.transition_organization_entitlement_from_hq(text,uuid,text,integer,uuid,text,uuid,uuid)','b3245db9dfde9617ddacef299242c960',true,true,'jsonb')
  ) expected(signature,source_md5,runtime_allowed,definer,return_type) LOOP
    SELECT proc.*,owner.rolsuper,owner.rolbypassrls,owner.rolname owner_name INTO p FROM pg_proc proc JOIN pg_roles owner ON owner.oid=proc.proowner WHERE proc.oid=to_regprocedure(f.signature);
    IF p.oid IS NULL OR p.prosecdef IS DISTINCT FROM f.definer OR p.provolatile<>'v' OR p.prokind<>'f' OR p.proretset
      OR p.prorettype<>f.return_type::regtype OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
      OR NOT(p.rolsuper OR p.rolbypassrls) OR p.owner_name IN ('hon_runtime','anon','authenticated','service_role') OR md5(p.prosrc)<>f.source_md5
      OR (SELECT count(*) FROM pg_proc other WHERE other.pronamespace=p.pronamespace AND other.proname=p.proname)<>1 THEN RAISE EXCEPTION 'Canonical HQ entitlement function required: %',f.signature; END IF;
    IF EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantor<>p.proowner OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable OR (acl.grantee<>p.proowner AND (acl.grantee<>runtime_oid OR NOT f.runtime_allowed)))
      OR has_function_privilege('hon_runtime',p.oid,'EXECUTE') IS DISTINCT FROM f.runtime_allowed
      OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>(CASE WHEN f.runtime_allowed THEN 2 ELSE 1 END) THEN RAISE EXCEPTION 'Exact HQ entitlement function ACL required: %',f.signature; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['organization_entitlements','hq_entitlement_requests','hq_entitlement_audit','hq_entitlement_outbox'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname NOT IN('hon_runtime','anon','authenticated','service_role'))
      OR EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner)
      OR EXISTS(SELECT 1 FROM pg_attribute col JOIN pg_class c ON c.oid=col.attrelid,LATERAL aclexplode(col.attacl) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Private FORCE-RLS HQ entitlement table required: %',t; END IF;
    IF t<>'organization_entitlements' THEN
      IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
        OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgname='hq_entitlement_immutable' AND tgfoid='hon.guard_hq_entitlement_evidence()'::regprocedure AND tgenabled='O' AND tgtype=27)
        OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgname='hq_entitlement_no_truncate' AND tgfoid='hon.guard_hq_entitlement_evidence()'::regprocedure AND tgenabled='O' AND tgtype=34) THEN RAISE EXCEPTION 'Immutable private HQ entitlement evidence required: %',t; END IF;
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='hon.organization_entitlements'::regclass AND a.attname='version' AND a.atttypid='integer'::regtype AND a.attnotnull AND pg_get_expr(d.adbin,d.adrelid)='1')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.organization_entitlements'::regclass AND convalidated AND contype='c' AND pg_get_constraintdef(oid)='CHECK ((version > 0))')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.hq_entitlement_requests'::regclass AND convalidated AND NOT condeferrable AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (actor_principal_id, idempotency_key)')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.hq_entitlement_outbox'::regclass AND convalidated AND NOT condeferrable AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (audit_id)') THEN RAISE EXCEPTION 'HQ entitlement version/receipt/outbox invariants required'; END IF;
END $$;
-- End HQ entitlement transition exact verification.

-- CRM lead registration exact verification:
DO $$ DECLARE f record; p record; runtime_oid oid := (SELECT oid FROM pg_roles WHERE rolname='hon_runtime'); BEGIN
  IF runtime_oid IS NULL
    OR EXISTS(SELECT 1 FROM pg_roles WHERE oid=runtime_oid AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication))
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=runtime_oid)
    OR has_schema_privilege('hon_runtime','hon','CREATE') THEN RAISE EXCEPTION 'Restricted CRM registration runtime required'; END IF;
  FOR f IN SELECT * FROM (VALUES
    ('hon.guard_crm_lead_registration_history()','dc1fc17328c4de05c501c5d1666c44f7',false,false,'trigger',false),
    ('hon.crm_lead_registration_has_permission(uuid,uuid,uuid,text)','e3b71364e299c4be376b83b3e4daa41a',false,true,'boolean',false),
    ('hon.resolve_crm_lead_registration_scope(text,uuid)','5c3fbbff4af1becc237ae5d7f94fc5c7',true,true,'record',true),
    ('hon.require_crm_lead_registration_actor(text,text)','b1473f5d95b499f8c1d9c10907b34e08',false,true,'uuid',false),
    -- register_crm_lead_person: 0169 body (IAM tables in SHARE, CRM domain tables in SHARE ROW EXCLUSIVE).
    ('hon.register_crm_lead_person(text,uuid,jsonb,uuid,uuid,uuid)','539030f1832cdf3f320e356bf57e7c41',true,true,'jsonb',false)
  ) expected(signature,source_md5,runtime_allowed,definer,return_type,return_set) LOOP
    SELECT proc.*,owner.rolsuper,owner.rolbypassrls,owner.rolname owner_name INTO p
      FROM pg_proc proc JOIN pg_roles owner ON owner.oid=proc.proowner WHERE proc.oid=to_regprocedure(f.signature);
    IF p.oid IS NULL OR p.prosecdef IS DISTINCT FROM f.definer OR p.provolatile<>'v' OR p.prokind<>'f'
      OR p.prorettype<>f.return_type::regtype OR p.proretset IS DISTINCT FROM f.return_set
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
      OR NOT(p.rolsuper OR p.rolbypassrls) OR p.owner_name IN ('hon_runtime','anon','authenticated','service_role')
      OR md5(p.prosrc)<>f.source_md5
      OR (SELECT count(*) FROM pg_proc other WHERE other.pronamespace=p.pronamespace AND other.proname=p.proname)<>1 THEN
      RAISE EXCEPTION 'Canonical CRM registration function required: %',f.signature;
    END IF;
    IF EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE acl.grantor<>p.proowner OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable
        OR (acl.grantee<>p.proowner AND (acl.grantee<>runtime_oid OR NOT f.runtime_allowed)))
      OR has_function_privilege('hon_runtime',p.oid,'EXECUTE') IS DISTINCT FROM f.runtime_allowed
      OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>(CASE WHEN f.runtime_allowed THEN 2 ELSE 1 END) THEN
      RAISE EXCEPTION 'Exact CRM registration function ACL required: %',f.signature;
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles owner ON owner.oid=c.relowner
      WHERE c.oid='hon.crm_lead_registration_conversions'::regclass AND c.relrowsecurity AND c.relforcerowsecurity
        AND (owner.rolsuper OR owner.rolbypassrls) AND owner.rolname NOT IN ('hon_runtime','anon','authenticated','service_role'))
    OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename='crm_lead_registration_conversions')
    OR EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      WHERE c.oid='hon.crm_lead_registration_conversions'::regclass AND acl.grantee<>c.relowner)
    OR EXISTS(SELECT 1 FROM pg_attribute col JOIN pg_class c ON c.oid=col.attrelid,LATERAL aclexplode(col.attacl) acl
      WHERE c.oid='hon.crm_lead_registration_conversions'::regclass AND acl.grantee<>c.relowner)
    OR has_table_privilege('hon_runtime','hon.crm_lead_registration_conversions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.crm_lead_registration_conversions','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Private CRM registration FORCE-RLS evidence required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.crm_lead_registration_conversions'::regclass AND tgname='crm_lead_registration_immutable'
      AND tgfoid='hon.guard_crm_lead_registration_history()'::regprocedure AND tgenabled='O' AND tgtype=27)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.crm_lead_registration_conversions'::regclass AND tgname='crm_lead_registration_no_truncate'
      AND tgfoid='hon.guard_crm_lead_registration_history()'::regprocedure AND tgenabled='O' AND tgtype=34) THEN
    RAISE EXCEPTION 'Canonical CRM registration immutable triggers required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.crm_lead_registration_conversions'::regclass AND convalidated AND NOT condeferrable AND contype='u'
      AND pg_get_constraintdef(oid)='UNIQUE (organization_id, school_id, actor_principal_id, idempotency_key)')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.crm_lead_registration_conversions'::regclass AND convalidated AND NOT condeferrable AND contype='u'
      AND pg_get_constraintdef(oid)='UNIQUE (source_lead_id)')
    OR NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='crm.lead.register' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'Canonical CRM registration idempotency/source and permission invariants required';
  END IF;
END $$;
-- End CRM lead registration exact verification.

-- Adult CRM membership draft exact verification, including immutable source and function drift.
-- draft_crm_adult_membership is verified against its 0169 definition (canonical lock order: key reservation, IAM SHARE, domain SHARE ROW EXCLUSIVE).
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['people','student_profiles','crm_lead_registration_conversions','crm_leads','family_members','billing_accounts','memberships','crm_adult_membership_draft_sources'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=('hon.'||t)::regclass AND relrowsecurity AND relforcerowsecurity) THEN RAISE EXCEPTION 'Adult CRM draft FORCE RLS required: %',t; END IF;
  END LOOP;
  SELECT NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
    AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
  INTO safe FROM pg_class c WHERE c.oid='hon.crm_adult_membership_draft_sources'::regclass;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Adult CRM membership source must be private'; END IF;
  FOR f IN SELECT * FROM (VALUES ('hon.guard_crm_adult_membership_draft_source()',false,false,'34f4563a08922d0cfce9c4cd319100fe33d9ed126f0ed940af2b7b0a85fd8651'),
('hon.require_crm_adult_membership_actor(text)',true,false,'b02c87ebf4c7b837dd5e78f5f8fd65e1b820e835214dcc2389cf0e8acd7b0a2a'),
('hon.crm_adult_membership_relation(uuid)',true,false,'71d39ddcd35a15c7baf094045aaf1979c5d61516dab7818d3cee0bb009c81457'),
('hon.read_crm_adult_membership_preparation(text,uuid)',true,true,'909adac7587840fbcd7e464e7b2b2c6b920d44b2d6264822fbcbffe1cc43243f'),
('hon.read_crm_adult_membership_draft_confirmation(text,uuid)',true,true,'1c28232bde9839acda9d7e38724a711842827dd17cf871a81c2770a67f211c05'),
('hon.draft_crm_adult_membership(text,jsonb,uuid,uuid,uuid)',true,true,'c106968a870a801571fbb6d0031dc419cc0bf0a6e9375966a1931bee25493ab4')) e(signature,definer,runtime_allowed,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe adult CRM membership draft function: %',f.signature; END IF;
  END LOOP;
  SELECT p.prorettype='jsonb'::regtype AND NOT p.proretset AND p.prokind='f' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
    AND p.pronargs=2 AND oidvectortypes(p.proargtypes)='text, uuid' AND p.proargnames=ARRAY['subject','selected_student']
    AND p.proargmodes IS NULL AND p.proargdefaults IS NULL
    AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname='read_crm_adult_membership_draft_confirmation')=1
  INTO safe FROM pg_proc p WHERE p.oid='hon.read_crm_adult_membership_draft_confirmation(text,uuid)'::regprocedure;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe adult CRM membership confirmation signature'; END IF;
  FOR expected IN SELECT * FROM (VALUES ('crm_adult_membership_source_immutable',27),('crm_adult_membership_source_no_truncate',34)) e(name,kind) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.crm_adult_membership_draft_sources'::regclass AND tgname=expected.name AND tgtype=expected.kind AND tgfoid='hon.guard_crm_adult_membership_draft_source()'::regprocedure AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred) THEN RAISE EXCEPTION 'Unsafe adult CRM membership source trigger'; END IF;
  END LOOP;
  FOR t IN SELECT unnest(ARRAY['PRIMARY KEY (conversion_id)','UNIQUE (membership_id)','UNIQUE (organization_id, school_id, actor_principal_id, idempotency_key)']) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.crm_adult_membership_draft_sources'::regclass AND convalidated AND NOT condeferrable AND pg_get_constraintdef(oid)=t) THEN RAISE EXCEPTION 'Missing adult CRM draft source uniqueness'; END IF;
  END LOOP;
  FOR t IN SELECT unnest(ARRAY['schools','crm_lead_registration_conversions','memberships']) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.crm_adult_membership_draft_sources'::regclass AND confrelid=('hon.'||t)::regclass AND contype='f' AND convalidated AND NOT condeferrable AND array_length(conkey,1)>=2 AND confdeltype='r') THEN RAISE EXCEPTION 'Missing adult CRM draft source scoped FK'; END IF;
  END LOOP;
END $$;
-- End adult CRM membership draft exact verification.

-- CRM lead registration recovery exact verification (0174): one read-only definer, runtime EXECUTE only, no overload.
DO $$ DECLARE safe boolean; BEGIN
  SELECT p.prosecdef AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']
    AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='87b01d2fe2307aff23b2ea9fdd021d386b965e71cad1cb308d0f7e3b7b9ac33a'
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    AND p.prorettype='jsonb'::regtype AND NOT p.proretset AND p.prokind='f' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
    AND p.pronargs=2 AND oidvectortypes(p.proargtypes)='text, uuid' AND p.proargnames=ARRAY['subject','selected_lead']
    AND p.proargmodes IS NULL AND p.proargdefaults IS NULL
    AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname='read_crm_lead_registration_recovery')=1
  INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid='hon.read_crm_lead_registration_recovery(text,uuid)'::regprocedure;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe CRM lead registration recovery function'; END IF;
  -- Private actor-independent current-DRAFT check: never callable by the runtime or anyone but its owner.
  SELECT p.prosecdef AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']
    AND (owner.rolsuper OR owner.rolbypassrls) AND NOT has_function_privilege('hon_runtime',p.oid,'EXECUTE')
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='3f44ad99d0b571e6cc052370017b2b475bc6b5f1b018da51f2816eddd4173845'
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)
    AND p.prorettype='boolean'::regtype AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname='crm_adult_membership_draft_is_current')=1
  INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid='hon.crm_adult_membership_draft_is_current(uuid)'::regprocedure;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe CRM adult membership current-DRAFT check'; END IF;
END $$;
-- End CRM lead registration recovery exact verification.

-- School membership plan catalog exact verification (0175): private immutable tables, five runtime entry points, private helpers and guards, no overloads.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['membership_plans','membership_plan_versions','membership_plan_selections'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'School membership plan table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.guard_membership_plan()',false,false,'6b25106590748dffc6e8c3250cf6ca7e5f14eae80d2506d7c8d7201da432a3c3'),
('hon.guard_membership_plan_version()',false,false,'9c081574080016694c1587fe3d810d33f29232ab243e81d7a2b7b4a48108f63a'),
('hon.guard_membership_plan_selection()',false,false,'d4f4506bef058b36e4f285c87f1722db4baca645d44e1aadb7a6e4d19ab17035'),
('hon.require_membership_plan_manager(text)',true,false,'41895c5c0c21215afd60652f39ef07e6bd131470cb2f3368e8b268a8c5184a2f'),
('hon.membership_plan_validated_terms(jsonb)',true,false,'b108ba63c4c2da714d076a085895bfb2cadbb0b97b7db06d74901693472d3874'),
('hon.membership_plan_version_summary(uuid,integer)',true,false,'a0af232d46adc9230ea2c5df1db23c9e9ca4029edfaaa1507b1aba20e24eb92c'),
('hon.read_school_membership_plan_catalog(text)',true,true,'5cc7728519fdd3e0ad77d0c0186037557a7213e31724e03c8bfa3978ec1fbc35'),
('hon.create_school_membership_plan(text,jsonb,uuid,uuid,uuid)',true,true,'31ecdbf8ff1323a7984d0058cd84aa9a52d12caa7ae73a4e07c9f8d3433e907f'),
('hon.revise_school_membership_plan(text,uuid,jsonb,uuid,uuid,uuid)',true,true,'9f7aec2b0ddc75389a31de58c236839f7a3f03ce0eb805c89ae23727d78cf90b'),
('hon.read_crm_adult_membership_plan_options(text)',true,true,'8575e3f29e4789bee79392277fdce335983f7d7a10db6943a387bbc12a0b6d12'),
('hon.draft_crm_adult_membership_from_plan(text,jsonb,uuid,uuid,uuid)',true,true,'d4a22f1dbcdaac65d4f0a7032df761ae02ee944b5a0367d158e2e1c69c231458')) e(signature,definer,runtime_allowed,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY['search_path=pg_catalog, hon']
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school membership plan function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('membership_plans','membership_plan_guard','hon.guard_membership_plan()'),('membership_plans','membership_plan_no_truncate','hon.guard_membership_plan()'),
    ('membership_plan_versions','membership_plan_version_guard','hon.guard_membership_plan_version()'),('membership_plan_versions','membership_plan_version_no_truncate','hon.guard_membership_plan_version()'),
    ('membership_plan_selections','membership_plan_selection_immutable','hon.guard_membership_plan_selection()'),('membership_plan_selections','membership_plan_selection_no_truncate','hon.guard_membership_plan_selection()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing school membership plan guard: %',expected.name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='billing.membership_plan.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'School membership plan permission invariant required'; END IF;
END $$;
-- End school membership plan catalog exact verification.

-- CRM guardian/child enrollment exact verification (0176, child relation + family read replaced by 0218; 0218 person command receipts and correction helpers included): private immutable tables, four runtime entry points, private helpers and guards, no overloads.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['crm_guardian_child_enrolled_children','crm_guardian_child_payer_designations','crm_guardian_child_membership_draft_sources','crm_guardian_child_identity_corrections','school_person_command_receipts'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'CRM guardian/child enrollment table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.guard_crm_guardian_child_enrollment_history()',false,false,'384a8a523a91e6339126829dc53b09aa47d33a48ab94e4fa01f7dddc53bf3b5c'),
('hon.capture_crm_guardian_child_registration_child()',true,false,'98c12236c3ea0f866e39aab5707affd1a4ff44b885c2828abf6b797bb742f9aa'),
('hon.require_crm_guardian_child_enrollment_actor(text)',true,false,'1ce782ebcd4e6b15183acaa39434c7a7ef5342e875d694dd01dded3d2f2a63e2'),
('hon.crm_guardian_child_family_relation(uuid)',true,false,'c28275b6efad28d071aca09a170eb15dd942d586ca22146a856e836419c44232'),
('hon.crm_guardian_child_child_relation(uuid)',true,false,'5098f43db920d04a2043186b83433e96bfbf21f877a15e6700fd9b5fa266a313'),
('hon.crm_guardian_child_current_designation(uuid,uuid,uuid,uuid,uuid)',true,false,'c5f51fa97aeaa2901d3515ed42cf9f8c0c31de64cdc1afc1ace7ef0aeb7cf90e'),
('hon.crm_guardian_child_membership_draft_current(uuid)',true,false,'0eb5c4cca23e5cda775be4225cbf0259502bfdd9c9883dd2e65953e52ffc07f6'),
('hon.read_crm_guardian_child_enrollment(text,uuid)',true,true,'adeb793f2a1b9158c9ac1ae68957513f2bf52a7e2874f33a1002fb8f7a2e54b3'),
('hon.designate_crm_guardian_child_payer(text,uuid,jsonb,uuid,uuid,uuid)',true,true,'95d672e03d52b5905d289e2ddc373ac2671c2ea8eb3524edfd25858ab65ed3f9'),
('hon.add_crm_guardian_child_additional_child(text,uuid,jsonb,uuid,uuid,uuid)',true,true,'0a97e309a147cb531ce874ce806c09c87d43bf01047f70fee84940d51559535a'),
('hon.draft_crm_guardian_child_membership_from_plan(text,jsonb,uuid,uuid,uuid)',true,true,'9e0a95a431a80c3f3af5f24c0d99aea0558f9141efe24d3239f3a87d90c0635f'),
('hon.crm_guardian_child_current_identity(uuid,uuid,uuid)',false,false,'bd62d2334085e7882e95d598683ac9bfcd6c67aa938d04df039dddd63ca3970d'),
('hon.record_crm_guardian_child_identity_correction(uuid,uuid,uuid,uuid,uuid,text,text,date)',false,false,'bc1714cfa175e8d9b448d428cbb62824203b9d52deca3c164e7750fc92ce399d'),
('hon.guard_school_person_command_receipt()',false,false,'6d6c8d3012529d9d3b24627332254cde9b9a38196cfcbbf912313788e11870e5'),
('hon.school_person_is_owner(uuid,uuid)',false,false,'02b129313c3c282d79072a0342f9301561c324b9623136c0eb8c4b2d6de90d65'),
('hon.update_school_student_birth_date(text,jsonb,uuid)',true,true,'c06debf31093419c35ad2463803041f206f808412aa2cc719feba4c12c5dda59')) e(signature,definer,runtime_allowed,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY['search_path=pg_catalog, hon']
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe CRM guardian/child enrollment function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('crm_guardian_child_enrolled_children','crm_guardian_child_enrolled_children_immutable','hon.guard_crm_guardian_child_enrollment_history()'),
    ('crm_guardian_child_enrolled_children','crm_guardian_child_enrolled_children_no_truncate','hon.guard_crm_guardian_child_enrollment_history()'),
    ('crm_guardian_child_payer_designations','crm_guardian_child_payer_designation_immutable','hon.guard_crm_guardian_child_enrollment_history()'),
    ('crm_guardian_child_payer_designations','crm_guardian_child_payer_designation_no_truncate','hon.guard_crm_guardian_child_enrollment_history()'),
    ('crm_guardian_child_membership_draft_sources','crm_guardian_child_membership_source_immutable','hon.guard_crm_guardian_child_enrollment_history()'),
    ('crm_guardian_child_membership_draft_sources','crm_guardian_child_membership_source_no_truncate','hon.guard_crm_guardian_child_enrollment_history()'),
    ('crm_guardian_child_identity_corrections','crm_guardian_child_identity_corrections_immutable','hon.guard_crm_guardian_child_enrollment_history()'),
    ('crm_guardian_child_identity_corrections','crm_guardian_child_identity_corrections_no_truncate','hon.guard_crm_guardian_child_enrollment_history()'),
    ('school_person_command_receipts','school_person_command_receipts_complete_once','hon.guard_school_person_command_receipt()'),
    ('school_person_command_receipts','school_person_command_receipts_no_truncate','hon.guard_school_person_command_receipt()'),
    ('crm_lead_registration_conversions','crm_guardian_child_registration_child_capture','hon.capture_crm_guardian_child_registration_child()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing CRM guardian/child enrollment guard: %',expected.name; END IF;
  END LOOP;
END $$;
-- End CRM guardian/child enrollment exact verification.
-- Membership activation gate exact verification (0177): private immutable evidence, three runtime entry points,
-- private helpers, the settings-free transition trigger, D41 option C membership privileges and the D30a permissions.
DO $$ DECLARE f record; safe boolean; t text; expected record; cols text[]; BEGIN
  FOREACH t IN ARRAY ARRAY['membership_activation_decisions','membership_effective_periods','membership_activation_follow_ups'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Membership activation evidence table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.guard_membership_activation_evidence()',false,false,'search_path=pg_catalog, hon','a2c13dee64a2b6227bf4563a01ace4f1984b1576a2f82141329721ba907948c4'),
('hon.guard_membership_state_transition()',false,false,'search_path=pg_catalog, hon','1e860ef88864ffe8e61ebe064cba7cf4458df30ef6189cef96e859239dbbd28e'),
('hon.membership_local_date(timestamptz,text)',false,false,'search_path=pg_catalog','60fb21bff4757c407e3acddc061c304629f0f035145d633924461e75090ad465'),
('hon.membership_local_day_start(date,text)',false,false,'search_path=pg_catalog, hon','7d311eb5b3ec550b13b360c747cc628fc8d13369e2984c01a12cbd2c3794e4ec'),
('hon.membership_effective_status_at(hon.membership_state,timestamptz,timestamptz,timestamptz)',false,false,'search_path=pg_catalog, hon','1430f67da4c27d157e9d520ac4b50e04c750391b22680ca21553fb7dfc33d613'),
('hon.membership_activation_text_ok(text,integer)',false,false,'search_path=pg_catalog','da4065773ea5ed7bf34267f0ff311863463c5d168d8ec8c0ad97a506677dbfe3'),
('hon.membership_activation_date(jsonb)',false,false,'search_path=pg_catalog','70dfaa487da94917b5204642ac4dd5685870f65062c9026e979e5919289b4963'),
('hon.membership_lifecycle_permission(uuid,uuid,uuid,text)',true,false,'search_path=pg_catalog, hon','1aaff531834840168bff93e5786e9956669fdb636b74c7d0c4f43dc245586f7f'),
('hon.require_membership_lifecycle_actor(text,text)',true,false,'search_path=pg_catalog, hon','718396f6ab991c2bfc539432bcf0875300a0db49f4deb5f58635c3626ad170f1'),
('hon.evaluate_membership_activation(uuid,boolean,date,date)',true,false,'search_path=pg_catalog, hon','9b2679af3efeb30175e068eeec49fa05e36190e6ad82eefa94f642f506601462'),
('hon.preview_school_membership_activation(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','19a4444b60c5c644f49be3da77ca2b5bbe52ff4d8aba4d8c94ce402b1bb7e271'),
('hon.activate_school_membership(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','81781b22ed586bfd90813c494446cfe7c61ac1631713829c63b443e7809323b0'),
('hon.cancel_school_membership(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','e7b9e588cf9afec657245a8ea94a1b59b5356341e6d5403c53edeeb8796d0f36')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe membership activation function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('membership_activation_decisions','membership_activation_decisions_immutable','hon.guard_membership_activation_evidence()'),
    ('membership_activation_decisions','membership_activation_decisions_no_truncate','hon.guard_membership_activation_evidence()'),
    ('membership_effective_periods','membership_effective_periods_immutable','hon.guard_membership_activation_evidence()'),
    ('membership_effective_periods','membership_effective_periods_no_truncate','hon.guard_membership_activation_evidence()'),
    ('membership_activation_follow_ups','membership_activation_follow_ups_immutable','hon.guard_membership_activation_evidence()'),
    ('membership_activation_follow_ups','membership_activation_follow_ups_no_truncate','hon.guard_membership_activation_evidence()'),
    ('memberships','membership_state_transition_guard','hon.guard_membership_state_transition()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing membership activation guard: %',expected.name; END IF;
  END LOOP;
  -- 0624 adds exactly one more: the one-per-program overlap check (AFTER UPDATE, verified in the 0624 section).
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.memberships'::regclass AND NOT tgisinternal)<>2
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.memberships'::regclass AND NOT tgisinternal AND tgname NOT IN ('membership_state_transition_guard','memberships_one_per_program'))<>0 THEN
    RAISE EXCEPTION 'hon.memberships must carry exactly the 0177 transition guard (body replaced by 0178) and the 0624 one-per-program check'; END IF;
  -- D41 option C: SELECT; no table INSERT, no UPDATE at any level, no DELETE/TRUNCATE; INSERT on exactly the seven DRAFT columns.
  SELECT array_agg(attname::text ORDER BY attname) INTO cols FROM pg_attribute
    WHERE attrelid='hon.memberships'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('hon_runtime',attrelid,attnum,'INSERT');
  IF NOT has_table_privilege('hon_runtime','hon.memberships','SELECT') OR has_table_privilege('hon_runtime','hon.memberships','INSERT')
    OR has_any_column_privilege('hon_runtime','hon.memberships','UPDATE') OR has_table_privilege('hon_runtime','hon.memberships','DELETE')
    OR has_table_privilege('hon_runtime','hon.memberships','TRUNCATE')
    OR cols IS DISTINCT FROM ARRAY['billing_account_id','organization_id','participant_person_id','plan_code','school_id','term_ends_at','term_started_at'] THEN
    RAISE EXCEPTION 'hon_runtime membership privileges must be exactly D41 option C'; END IF;
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('billing.membership.activation.override','billing.membership.rules.manage','billing.membership.change.approve')
      AND is_sensitive AND is_staff_assignable)<>3 THEN
    RAISE EXCEPTION 'Membership activation permissions must exist as sensitive staff-assignable permissions'; END IF;
END $$;
-- End membership activation gate exact verification.
-- Membership date revisions exact verification (0178): private immutable revision evidence with a settings-free insert
-- guard, five runtime entry points, private helpers, the E1b-D1 permissions mapped to system owners only, and no new
-- runtime privilege on hon.memberships. The three 0177 functions 0178 replaces are pinned in the 0177 section above.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['membership_date_revisions','membership_date_revision_follow_ups'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Membership date revision evidence table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.guard_membership_date_revision_insert()',false,false,'search_path=pg_catalog, hon','307aee8273bb3a18e677e8ac26561c1cd64fc0286fbbd18aa16dc5202240dfbc'),
('hon.membership_instant_text(timestamptz)',false,false,'search_path=pg_catalog','8008e27252c49128b17c779d789a2d75c66632e8c1444104cce0caa2f3d063ef'),
('hon.membership_next_anchored_term_end(date,integer,date)',false,false,'search_path=pg_catalog','8fce7468323ed9826804fc67f4598e2adb5836a51bae1861edb571c88592cb9c'),
('hon.membership_date_revision_retroactive_days(date,date,date,date,date)',false,false,'search_path=pg_catalog','505e045f8c94792404a1501fffa9c2060102a8953344a0900f929288bbc1181e'),
('hon.membership_current_period(uuid)',false,false,'search_path=pg_catalog, hon','3e64412fb06e4d4cc987bea9999c49e0ef83128090f96847c3ec641d5b677d42'),
('hon.membership_reporting_status(hon.membership_state,timestamptz,timestamptz,boolean,timestamptz)',false,false,'search_path=pg_catalog, hon','262b9d5dd9b24f21ed2c221b13d107078071f55daa6f06dd93b32072cc72ba11'),
('hon.evaluate_membership_date_revision(uuid,text,boolean,date,date)',true,false,'search_path=pg_catalog, hon','2d72aaae85518d66eb6a55d3e56457e3171fee1642e9c4fb03e3c66f156727a3'),
('hon.preview_membership_date_revision(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','3d7a20a9140cb2d11cc2d1aa1fc5336e6240a53cbb72ec7a09e69ff994865bf6'),
('hon.revise_membership_dates(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','630627c13a9defd707c6615d43787512101d3c5c2a33172a7d544fb231e292ed'),
('hon.read_membership_date_history(text,uuid)',true,true,'search_path=pg_catalog, hon','d943418c1f02b86a303f71ef42df0f456621ce77f5eb29347182de387ff1da1f'),
('hon.read_membership_date_confirmation_queue(text,jsonb)',true,true,'search_path=pg_catalog, hon','f200b7dcfe7eecf66b643a2ea78eef6ffb0b2671eac2830223fbb233b488f538'),
('hon.read_school_membership_status_summary(text)',true,true,'search_path=pg_catalog, hon','cf87534888d223dda57d31a24272c78c29474711154146048357d16411662cad')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe membership date revision function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('membership_date_revisions','membership_date_revisions_immutable','hon.guard_membership_activation_evidence()'),
    ('membership_date_revisions','membership_date_revisions_no_truncate','hon.guard_membership_activation_evidence()'),
    ('membership_date_revisions','membership_date_revision_insert_guard','hon.guard_membership_date_revision_insert()'),
    ('membership_date_revision_follow_ups','membership_date_revision_follow_ups_immutable','hon.guard_membership_activation_evidence()'),
    ('membership_date_revision_follow_ups','membership_date_revision_follow_ups_no_truncate','hon.guard_membership_activation_evidence()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing membership date revision guard: %',expected.name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.membership_date_revisions'::regclass AND NOT tgisinternal)<>3
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.membership_date_revision_follow_ups'::regclass AND NOT tgisinternal)<>2 THEN
    RAISE EXCEPTION 'Membership date revision evidence must carry exactly its reviewed triggers'; END IF;
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('billing.membership.dates.revise','billing.membership.dates.retroactive')
      AND is_sensitive AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'Membership date permissions must exist as sensitive staff-assignable permissions'; END IF;
END $$;
-- End membership date revisions exact verification.


-- Exact A2P-1 resolver security. No mutable records or direct table grants.
DO $$ DECLARE safe boolean; BEGIN
 SELECT p.prosecdef AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']
   AND (o.rolsuper OR o.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='4d42f66852893d61b9d593676dcf59c54a858a46655b31a9028dcd69e316bbed'
   AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
 INTO safe FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='hon.read_a2p_preparation_scope(text)'::regprocedure;
 IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'A2P-1 preparation scope drift'; END IF;
END $$;

-- Class Sessions current-school read exact verification:
-- 0147's named SECURITY DEFINER projection is the runtime's only Class Sessions
-- read entry point. Runtime holds exactly one non-grantable EXECUTE on it; the
-- private authority helper, PUBLIC and client roles hold none. Forced RLS stays.
DO $$
DECLARE read_safe boolean; helper_safe boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')) THEN
    RAISE EXCEPTION 'Class Sessions read requires a restricted runtime role';
  END IF;
  SELECT p.prosecdef AND p.provolatile = 'v' AND p.prokind = 'f'
    AND p.prorettype = 'jsonb'::regtype
    AND (o.rolsuper OR o.rolbypassrls)
    AND o.rolname NOT IN ('hon_runtime', 'anon', 'authenticated', 'service_role')
    AND has_function_privilege('hon_runtime', p.oid, 'EXECUTE')
    AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace = p.pronamespace AND x.proname = p.proname) = 1
    AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.grantee <> p.proowner AND (a.grantee <> (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')
        OR a.is_grantable OR a.privilege_type <> 'EXECUTE' OR a.grantor <> p.proowner))
    AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')) = 1
  INTO read_safe FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
  WHERE p.oid = 'hon.read_current_school_class_sessions(text)'::regprocedure;
  IF read_safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Class Sessions read grant drift'; END IF;
  SELECT p.prosecdef
    AND NOT has_function_privilege('hon_runtime', p.oid, 'EXECUTE')
    AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee <> p.proowner)
  INTO helper_safe FROM pg_proc p
  WHERE p.oid = 'hon.require_current_school_class_sessions_read_actor(text)'::regprocedure;
  IF helper_safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Class Sessions private helper exposed'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
    AND (has_function_privilege(r.oid, 'hon.read_current_school_class_sessions(text)', 'EXECUTE')
      OR has_function_privilege(r.oid, 'hon.require_current_school_class_sessions_read_actor(text)', 'EXECUTE'))) THEN
    RAISE EXCEPTION 'Class Sessions read exposed to a client role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'hon.class_sessions'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'class_sessions must retain forced RLS';
  END IF;
END $$;
-- End Class Sessions current-school read exact verification.

-- CS1 0216 (proposed) Creative Studio generations: exact posture of the private tables and the four runtime entry points.
DO $$ DECLARE t text; safe boolean; expected record; r text; BEGIN
  FOR t IN SELECT unnest(ARRAY['creative_generations','creative_generation_assets']) LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity
      AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime'
      AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND acl.grantee<>c.relowner)
    INTO safe FROM pg_class c JOIN pg_roles owner_role ON owner_role.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Creative Studio private table: %',t; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('hon.creative_prompt_ok(text)',false,false,'i'),
    ('hon.guard_creative_generation()',false,false,'v'),
    ('hon.creative_generation_json(hon.creative_generations)',false,false,'s'),
    ('hon.creative_generation_fingerprint(uuid,jsonb)',false,false,'i'),
    ('hon.create_creative_generation(text,uuid,jsonb,jsonb,uuid,uuid,uuid)',true,true,'v'),
    ('hon.record_creative_generation_result(text,uuid,jsonb)',true,true,'v'),
    ('hon.read_creative_generations(text,uuid)',true,true,'v'),
    ('hon.read_creative_generation(text,uuid,uuid)',true,true,'v')
  ) AS x(signature,runtime_execute,security_definer,volatility) LOOP
    SELECT p.prosecdef=expected.security_definer AND p.provolatile=expected.volatility AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[]
      AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime'
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=expected.runtime_execute
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee<>p.proowner AND (acl.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT expected.runtime_execute OR acl.is_grantable OR acl.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner_role ON owner_role.oid=p.proowner WHERE p.oid=expected.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Creative Studio function: %',expected.signature; END IF;
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
      IF has_function_privilege(r,expected.signature,'EXECUTE') THEN RAISE EXCEPTION 'Creative Studio function exposed to %: %',r,expected.signature; END IF;
    END LOOP;
  END LOOP;
END $$;

-- A1 0276 Creative Studio avatars: exact posture of the private table and the three runtime entry points.
DO $$ DECLARE t text; safe boolean; expected record; r text; BEGIN
  FOR t IN SELECT unnest(ARRAY['creative_avatars']) LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity
      AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime'
      AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND acl.grantee<>c.relowner)
    INTO safe FROM pg_class c JOIN pg_roles owner_role ON owner_role.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Creative Studio avatar private table: %',t; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('hon.creative_avatar_name_ok(text)',false,false,'i'),
    ('hon.guard_creative_avatar_generation()',false,true,'v'),
    ('hon.creative_avatar_json(hon.creative_avatars)',false,false,'s'),
    ('hon.creative_avatar_fingerprint(uuid,jsonb)',false,false,'i'),
    ('hon.create_creative_avatar(text,uuid,jsonb,jsonb,uuid,uuid,uuid)',true,true,'v'),
    ('hon.read_creative_avatars(text,uuid)',true,true,'v'),
    ('hon.read_creative_avatar(text,uuid,uuid)',true,true,'v')
  ) AS x(signature,runtime_execute,security_definer,volatility) LOOP
    SELECT p.prosecdef=expected.security_definer AND p.provolatile=expected.volatility AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[]
      AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime'
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=expected.runtime_execute
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee<>p.proowner AND (acl.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT expected.runtime_execute OR acl.is_grantable OR acl.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner_role ON owner_role.oid=p.proowner WHERE p.oid=expected.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Creative Studio avatar function: %',expected.signature; END IF;
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
      IF has_function_privilege(r,expected.signature,'EXECUTE') THEN RAISE EXCEPTION 'Creative Studio avatar function exposed to %: %',r,expected.signature; END IF;
    END LOOP;
  END LOOP;
END $$;

-- A2 0277 Creative Studio avatar videos: exact posture of the private table and the three runtime entry points.
DO $$ DECLARE t text; safe boolean; expected record; r text; BEGIN
  FOR t IN SELECT unnest(ARRAY['creative_avatar_videos']) LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity
      AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime'
      AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND acl.grantee<>c.relowner)
    INTO safe FROM pg_class c JOIN pg_roles owner_role ON owner_role.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Creative Studio avatar video private table: %',t; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('hon.guard_creative_avatar_generation()',false,true,'v'),
    ('hon.creative_avatar_video_json(hon.creative_avatar_videos)',false,false,'s'),
    ('hon.creative_avatar_video_fingerprint(uuid,jsonb)',false,false,'i'),
    ('hon.create_creative_avatar_video(text,uuid,jsonb,jsonb,uuid,uuid,uuid)',true,true,'v'),
    ('hon.read_creative_avatar_videos(text,uuid)',true,true,'v'),
    ('hon.read_creative_avatar_video(text,uuid,uuid)',true,true,'v')
  ) AS x(signature,runtime_execute,security_definer,volatility) LOOP
    SELECT p.prosecdef=expected.security_definer AND p.provolatile=expected.volatility AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[]
      AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime'
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=expected.runtime_execute
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee<>p.proowner AND (acl.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT expected.runtime_execute OR acl.is_grantable OR acl.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner_role ON owner_role.oid=p.proowner WHERE p.oid=expected.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Creative Studio avatar video function: %',expected.signature; END IF;
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
      IF has_function_privilege(r,expected.signature,'EXECUTE') THEN RAISE EXCEPTION 'Creative Studio avatar video function exposed to %: %',r,expected.signature; END IF;
    END LOOP;
  END LOOP;
END $$;
-- A3 0684 Creative Studio photo avatars: exact posture of the four private tables and the five runtime entry points.
DO $$ DECLARE t text; safe boolean; expected record; r text; BEGIN
  FOR t IN SELECT unnest(ARRAY['creative_avatar_photo_consents','creative_avatar_photos','creative_avatar_photo_withdrawals','creative_avatar_photo_links']) LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity
      AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime'
      AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND acl.grantee<>c.relowner)
    INTO safe FROM pg_class c JOIN pg_roles owner_role ON owner_role.oid=c.relowner WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Creative Studio photo avatar private table: %',t; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('hon.creative_photo_signature_ok(text)',false,false,'i'),
    ('hon.creative_photo_bytes_ok(text,bytea)',false,false,'i'),
    ('hon.guard_creative_avatar_photo()',false,false,'v'),
    ('hon.creative_photo_principal(text)',false,true,'v'),
    ('hon.creative_photo_subject_live(uuid,uuid,uuid)',false,true,'v'),
    ('hon.creative_photo_consent_live(uuid)',false,true,'v'),
    ('hon.creative_avatar_withdrawn(uuid)',false,true,'v'),
    ('hon.creative_generation_withdrawn(uuid)',false,true,'v'),
    ('hon.creative_photo_consent_json(hon.creative_avatar_photo_consents,uuid)',false,true,'v'),
    ('hon.creative_photo_fingerprint(uuid,jsonb,text)',false,false,'i'),
    ('hon.upload_creative_avatar_photo(text,uuid,jsonb,text,uuid)',true,true,'v'),
    ('hon.read_creative_avatar_photos(text,uuid)',true,true,'v'),
    ('hon.read_creative_avatar_photo_image(text,uuid,uuid)',true,true,'v'),
    ('hon.delete_creative_avatar_photo(text,uuid,uuid)',true,true,'v'),
    ('hon.creative_photo_avatar_fingerprint(uuid,jsonb)',false,false,'i'),
    ('hon.create_creative_photo_avatar(text,uuid,jsonb,jsonb,uuid,uuid,uuid)',true,true,'v')
  ) AS x(signature,runtime_execute,security_definer,volatility) LOOP
    SELECT p.prosecdef=expected.security_definer AND p.provolatile=expected.volatility AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[]
      AND (owner_role.rolsuper OR owner_role.rolbypassrls) AND owner_role.rolname<>'hon_runtime'
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=expected.runtime_execute
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee<>p.proowner AND (acl.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT expected.runtime_execute OR acl.is_grantable OR acl.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner_role ON owner_role.oid=p.proowner WHERE p.oid=expected.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Creative Studio photo avatar function: %',expected.signature; END IF;
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
      IF has_function_privilege(r,expected.signature,'EXECUTE') THEN RAISE EXCEPTION 'Creative Studio photo avatar function exposed to %: %',r,expected.signature; END IF;
    END LOOP;
  END LOOP;
END $$;
-- End Creative Studio generations exact verification.

-- School membership list exact verification (0220, U6): one read-only definer projection, runtime EXECUTE only.
DO $$ DECLARE safe boolean; BEGIN
  SELECT p.prosecdef AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']
    AND (o.rolsuper OR o.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='6dee6e1cea18c217f9a24013333fb8718f49a05573596de7c693c06958ab3617'
    AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
  INTO safe FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='hon.read_school_membership_list(text,jsonb)'::regprocedure;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school membership list function'; END IF;
END $$;
-- End school membership list exact verification.

-- Class-session pages exact verification (0221): one read-only definer projection, runtime EXECUTE only.
DO $$ DECLARE safe boolean; BEGIN
  SELECT p.prosecdef AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, hon']
    AND (o.rolsuper OR o.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='78863ed832e05044be3c1a8d1fe2beede748bd7648173f6ea30f6ef2ab8637f5'
    AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
  INTO safe FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='hon.read_school_class_session_page(text,jsonb)'::regprocedure;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe class-session page function'; END IF;
END $$;
-- End class-session pages exact verification.
-- Membership pause, cancellation and refund records exact verification (0224): private forced-RLS tables, settings-free
-- guards, private helpers, six new runtime entry points (cancel is pinned in the 0177 block) and the three permissions.
-- 0231 replaced the body of hon.pause_school_membership (rolling-year paused-days count); its hash below is the 0231 body.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['school_membership_pause_policies','membership_pauses','membership_refund_records'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Membership pause table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.guard_school_membership_pause_policy_insert()',false,false,'search_path=pg_catalog, hon','6884542f50ced5ca9f6c210d41ee558ad2523f4117524a39c10b4ae98f52f90a'),
('hon.guard_membership_pause()',false,false,'search_path=pg_catalog, hon','89197a3c85e66d707190095209bb1a003888c3225cc5dae96c8eb063d54395d9'),
('hon.membership_pause_text_ok(jsonb,boolean)',false,false,'search_path=pg_catalog','cec6ad5989b89bd1334049aad74188cef12547a18b024ce0b90345be6a73d491'),
('hon.membership_pause_date(jsonb)',false,false,'search_path=pg_catalog','10de318f76aee1cedb89411a3d35a68168c0f4d197558d35d8a26425ff1b8545'),
('hon.membership_school_today()',true,false,'search_path=pg_catalog, hon','66d5930b96db5a24a31d7129eaf855890200ca58b8d4ab037ef5f7e628f57d00'),
('hon.membership_pause_policy_json(uuid,uuid)',true,false,'search_path=pg_catalog, hon','ab0f64a44ba278f4f340fbd77648ba68537bae0dc9d96f8328ab50f2d5c9bb5d'),
('hon.membership_pause_json(hon.membership_pauses)',false,false,'search_path=pg_catalog, hon','beea1f004bb8ad0a04c7f197065b300d5e1896c5c9159406cb10c87656004b30'),
('hon.membership_refund_json(hon.membership_refund_records)',false,false,'search_path=pg_catalog, hon','14d25298028d089c3b0f0e8a4ecc2cc6c4d17d98efcd8dd0313793b242cf8910'),
('hon.membership_pause_begin(text,text,text,text)',true,false,'search_path=pg_catalog, hon','b74d7a8edb72bbb6e955896b3f6a5909fdda1701ca24c5d96cd20b022c283e73'),
('hon.membership_pause_finish(text,text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,text,uuid,integer,uuid,uuid)',true,false,'search_path=pg_catalog, hon','742c785b1395ccd25a5f60f4dfcad1d5aabe482936df672f270b9b2905e1ff17'),
('hon.membership_command_args_ok(text,text,uuid,uuid)',false,false,'search_path=pg_catalog','7afb3caf93863cd51c5da2fed002341221cb8628e15285689470f394ee94f042'),
('hon.read_school_membership_pause_policy(text)',true,true,'search_path=pg_catalog, hon','8a4ccf67894ced208e7bdd88f38b95da2d0dea40dfb2969d1f511997133eb76b'),
('hon.set_school_membership_pause_policy(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','8a5de833ffd79e01bfae58768b5a5d4d15a6a269ed3775cd9e41dd48364a733c'),
('hon.pause_school_membership(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','7d891a384ff23ea9ae763d04b181e4f6d571888760c925f7c21ef8107c1315dc'),
('hon.resume_school_membership(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','674b318b8920bbce7b05faf8cdb59e883e3a5c9b8b7a275fc875fb9d4d0fa172'),
('hon.record_membership_refund(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','56e4abbfa70311bf8272b35716223d6c877b43171e1b119b9099343a756dbc23'),
('hon.read_membership_pauses_and_refunds(text,uuid)',true,true,'search_path=pg_catalog, hon','3f15ad85d31109214ba9b5cfd3df6f227a21ef7b75d022b312c30ff18aab20dc')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe membership pause function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('school_membership_pause_policies','school_membership_pause_policies_immutable','hon.guard_membership_activation_evidence()'),
    ('school_membership_pause_policies','school_membership_pause_policies_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_membership_pause_policies','school_membership_pause_policy_insert_guard','hon.guard_school_membership_pause_policy_insert()'),
    ('membership_pauses','membership_pause_guard','hon.guard_membership_pause()'),
    ('membership_pauses','membership_pauses_no_truncate','hon.guard_membership_activation_evidence()'),
    ('membership_refund_records','membership_refund_records_immutable','hon.guard_membership_activation_evidence()'),
    ('membership_refund_records','membership_refund_records_no_truncate','hon.guard_membership_activation_evidence()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing membership pause guard: %',expected.name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('billing.membership.pause','billing.membership.pause_policy.manage','billing.membership.refund.record')
      AND is_sensitive AND is_staff_assignable)<>3 THEN
    RAISE EXCEPTION 'Membership pause permissions must exist as sensitive staff-assignable permissions'; END IF;
END $$;
-- End membership pause exact verification.
-- Student CSV import exact verification (0226): private forced-RLS tables, the evidence guard, private helpers, five
-- runtime entry points and the students.import permission.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['student_import_batches','student_import_rows','student_import_requests'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Student import table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.guard_student_import()',true,false,'search_path=pg_catalog, hon','c9cd68374c58d5d42acd90cefbcb933a50b5fdeca29313d56acb3b828bda5ebe'),
('hon.require_student_import_actor(text)',true,false,'search_path=pg_catalog, hon','1316f39854dc70e3fc7deecf96b48b14964ff2f5d1845b094af9ddcc1cb31ceb'),
('hon.student_import_fields()',false,false,'search_path=pg_catalog','d5df936dbc745cb27a1d2c8f84a4412e05f562220314f42ff04ee6f24c6e217f'),
('hon.student_import_check_row(jsonb,jsonb,jsonb,date)',false,false,'search_path=pg_catalog','33d7ae2571e2606ee89f6d31b18d23541c63b292a304d2cab1b7e8a339525f72'),
('hon.student_import_guardian(jsonb)',false,false,'search_path=pg_catalog','6d250b75a53d90cd8c9a191ab1455fe5f4850dc4a4d3494f910623b98ede7adc'),
('hon.student_import_summary(uuid)',false,false,'search_path=pg_catalog, hon','4dd9747e4b5057cc22bee8966b9e376214e8e5a6bedf1e74fb3b12548a2fdc6f'),
('hon.student_import_detail(uuid)',false,false,'search_path=pg_catalog, hon','c12cb5a08ec6894ae2670cb09368fd57084d64ae26addeebccdeb19ddbc8aadc'),
('hon.student_import_begin(text,text,jsonb,text,uuid,uuid)',true,false,'search_path=pg_catalog, hon','c0fbbfc4c2009f4935f8d81a8e6a1f606d9a01291f80e92d8267120af84685bd'),
('hon.student_import_finish(text,uuid,text,uuid,text,uuid,uuid,jsonb)',true,false,'search_path=pg_catalog, hon','dc66fc11d55165df91669d2dcc7f16c9ba46f965b3d84685c07c7795171052f2'),
('hon.stage_student_import(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','9a22cad3496e4dea6777f79c09e67fbd0a0b927a92e399418426475bc5777bd1'),
('hon.decide_student_import(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','22e689083a5a7b5c8b6c70a6490db94a23c5c92c48ec61908f573e021dbe1358'),
('hon.apply_student_import_row(uuid,integer,uuid,uuid,uuid)',true,false,'search_path=pg_catalog, hon','00b8f229730f706cb1a3d34f73bed554a53a1e008b58c4c481e1c6b0becf02b8'),
('hon.finalize_student_import(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','8b59499c923f77aaede863956a1a688e5321db076a5f4df48f381ca18bc87656'),
('hon.read_student_imports(text)',true,true,'search_path=pg_catalog, hon','52575a8becbf9ad433a997d038b926658e71d31e7205df58ba012f9032f4e0ca'),
('hon.read_student_import(text,uuid)',true,true,'search_path=pg_catalog, hon','9016bdadb2a2e7591ac349861dae3f9f8f1b15fd291bcdce9b45275f9888d59b')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe student import function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('student_import_batches','student_import_batches_guard'),('student_import_rows','student_import_rows_guard'),
    ('student_import_requests','student_import_requests_guard'),('student_import_batches','student_import_batches_no_truncate'),
    ('student_import_rows','student_import_rows_no_truncate'),('student_import_requests','student_import_requests_no_truncate')) e(tbl,name) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid='hon.guard_student_import()'::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing student import guard: %',expected.name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='students.import' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'students.import must exist as a sensitive staff-assignable permission'; END IF;
END $$;
-- End student CSV import exact verification.

-- CRM school clock exact verification (0236): one read-only definer projection with runtime EXECUTE only, and its
-- internal actor helper with no runtime privilege.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.crm_school_clock_actor(text,uuid,uuid)',false,false,'s','325d5330c281e8a45e18897cd58bb5c6ad221b194ee2bbc5dce967df4b455b71'),
('hon.read_crm_school_clock(text)',true,true,'v','a64b59bea3f1d5037229a53d2cbd1ac42864959a4525e056bd2ff7df7f2f2ea3')) e(signature,definer,runtime_allowed,volatility,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.provolatile=f.volatility AND p.proconfig=ARRAY['search_path=pg_catalog, hon']
      AND (o.rolsuper OR o.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (NOT f.runtime_allowed OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe CRM school clock function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End CRM school clock exact verification.

-- 0251 replaced the bodies of hon.class_series_json, hon.read_school_class_series and hon.revise_class_series (ongoing switch, topUpDue, new weekdays of ongoing series filled); their hashes below are the 0251 bodies.
-- 0567 replaced the body of hon.class_series_apply_future (classes moved off their roster from the calendar are skipped); its hash below is the 0567 body.
-- Recurring class series exact verification (B-SCH-1 0239): private forced-RLS series and occurrence tables, the series guard,
-- private helpers, six runtime entry points; the runtime still has no UPDATE on hon.class_sessions.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['class_series','class_series_occurrences'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Class series table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.guard_class_series()',true,false,'search_path=pg_catalog, hon','f521e14b8760c8064dba2bb57d96a688f9c1e786f242e56f3dac27cadee51e69'),
('hon.require_class_series_actor(text)',true,false,'search_path=pg_catalog, hon','493d8d19f622148de9b8ba7816d55918acb2a9c20015a3b3255c9257531d86e9'),
('hon.class_series_json(hon.class_series)',true,false,'search_path=pg_catalog, hon','ac63ec1bc183d40534a4623df595d4bb46b110f717861b58f08a281b372c82a8'),
('hon.class_series_pattern(jsonb,boolean)',false,false,'search_path=pg_catalog, hon','30abf7a726b2fb7c8c970b56b50a25be4239743474107f8954977279d0193bf5'),
('hon.class_series_command_begin(text,text,text)',true,false,'search_path=pg_catalog, hon','7119e94378413589f6e0fc87777f10405147e5556cd4b047b0d38ce6e0b45944'),
('hon.class_series_command_finish(text,text,uuid,jsonb,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',true,false,'search_path=pg_catalog, hon','3fba076d7585bdac91002f2dc9ecf156debb50a5680d5899571361a1e99f902d'),
('hon.class_series_apply_future(hon.class_series,text)',true,false,'search_path=pg_catalog, hon','01b183c1fb680a81b50957262d0c1b5d13448a7a0b9f1b4f1725c25c93a7ed0c'),
('hon.create_class_series(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','789071319d0903f962db946b683d9ee520d88739a0cc3e4f1742f0d0c44ddeab'),
('hon.revise_class_series(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','59d84e1b8134dc6d6d2d637f64128640f91cb56d6c0f5013fcbb324366cf20d4'),
('hon.end_class_series(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','874b8ab2922b59f0bca68e24a7dd87bb1955d023c790f1a8ec6ae5e4f9d6422c'),
('hon.fill_class_series(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','e06f110fa778c3c253a5a3e2b9451c5f70d4b114149cd74f252fb9d8a1935194'),
('hon.read_school_class_series(text)',true,true,'search_path=pg_catalog, hon','12784704f06184407d4ebbfc478d84b769de7ec4683316ff57c8caa35ad4d4ea'),
('hon.read_school_weekly_timetable(text,jsonb)',true,true,'search_path=pg_catalog, hon','2ff7caf2c9a791b2d6a037be4a01c75016b564c197935add272f296fba936351')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe class series function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('class_series','class_series_guard','hon.guard_class_series()'),
    ('class_series','class_series_no_truncate','hon.guard_membership_activation_evidence()'),
    ('class_series_occurrences','class_series_occurrences_immutable','hon.guard_membership_activation_evidence()'),
    ('class_series_occurrences','class_series_occurrences_no_truncate','hon.guard_membership_activation_evidence()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing class series guard: %',expected.name; END IF;
  END LOOP;
  IF has_any_column_privilege('hon_runtime','hon.class_sessions','UPDATE') THEN RAISE EXCEPTION 'Runtime must not update class sessions'; END IF;
END $$;
-- End recurring class series exact verification.

-- Tuition payment records exact verification (B-TUI-1 0240): a private forced-RLS record table, the two guards, private
-- helpers, four runtime entry points, the record permission, and the one status guard on hon.invoices.
DO $$ DECLARE f record; safe boolean; expected record; BEGIN
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
    AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
  INTO safe FROM pg_class c WHERE c.oid='hon.invoice_payment_records'::regclass;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Tuition payment record table must be private with FORCE RLS'; END IF;
  FOR f IN SELECT * FROM (VALUES
('hon.guard_invoice_payment_record()',true,false,'search_path=pg_catalog, hon','83b79ba66f63c96f3f5490960a10c8e95caac72c042c922498bd994f701d4bcb'),
('hon.guard_invoice_payment_status()',true,false,'search_path=pg_catalog, hon','d42c2d8a463004dfb1a7f118dc9c2e1b8fd081179147c7b62cde75a9142a3a43'),
('hon.require_tuition_actor(text,text)',true,false,'search_path=pg_catalog, hon','7ac8fe41104b2585562332e5a4bd235be3e1dedd9beb844082b3f0b3162a2e82'),
('hon.require_tuition_reader(text)',true,false,'search_path=pg_catalog, hon','f903656f91eaabca6673190572ce52ff3da42a87f2b818398bc00ad10e1164b5'),
('hon.invoice_payment_json(hon.invoice_payment_records)',false,false,'search_path=pg_catalog, hon','b357b9a37b1e7188d1e9972bb0cfc29ddadd3c8fb1932c8f510918e5fb0d452a'),
('hon.invoice_balance_json(hon.invoices)',true,false,'search_path=pg_catalog, hon','b5fcd6c54f5bd406f790308de190cc6d2bf3dd776aa2384ede9e26c1e3059398'),
('hon.tuition_command_begin(text,text,text)',true,false,'search_path=pg_catalog, hon','db163b4f857cd3b9fc498283117e27a5b46a661355cb4de30c2d800b609f1045'),
('hon.tuition_command_finish(text,text,uuid,jsonb,text,uuid,jsonb,jsonb,text,uuid,integer,uuid,uuid)',true,false,'search_path=pg_catalog, hon','9c91a173a6b391a979cfce2100ff8e5ba9cd7e89bfd9e6dde73da7c918818817'),
('hon.record_invoice_payment(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','07783efdddf5709927d59330453fb651e6e40617f9fa0143ccc44a12d26271a7'),
('hon.void_invoice_payment(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','dd54b50b86aae50764ec1ca68c3c2fb7321ddbbf8cba3fe17242a58ee893435c'),
('hon.read_invoice_payments(text,uuid)',true,true,'search_path=pg_catalog, hon','38fe117317715cbb8244177069dcbe7cb3c7c5c17c5c3a9a8810f0227e3bcc4c'),
('hon.read_school_receivables(text,jsonb)',true,true,'search_path=pg_catalog, hon','530f11d2506442e61f90de695a37225b01c6fb8f55671272646b8ec297be5a36')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe tuition payment function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('invoice_payment_records','invoice_payment_record_guard','hon.guard_invoice_payment_record()'),
    ('invoice_payment_records','invoice_payment_records_no_truncate','hon.guard_membership_activation_evidence()'),
    ('invoices','invoice_payment_status_guard','hon.guard_invoice_payment_status()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing tuition payment guard: %',expected.name; END IF;
  END LOOP;
  -- 0337 adds one more invoice guard (an open autopay charge holds its invoices), and 0530 one more (an open family
  -- payment holds its invoice), and 0630 one more (runtime INSERT only as DRAFT); each is verified in its own section.
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.invoices'::regclass AND NOT tgisinternal AND tgname NOT IN ('school_pay_charge_invoice_guard','parent_invoice_pay_invoice_guard','invoice_insert_status_guard'))<>1 THEN
    RAISE EXCEPTION 'hon.invoices must carry exactly the tuition payment status guard'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='billing.invoice.payment.record' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'billing.invoice.payment.record must exist as a sensitive staff-assignable permission'; END IF;
  IF has_table_privilege('hon_runtime','hon.invoices','DELETE') THEN RAISE EXCEPTION 'Runtime must not delete invoices'; END IF;
END $$;
-- End tuition payment records exact verification.

-- Ongoing class series exact verification (B-SCH-2 0251): the private ongoing column, one private helper and two runtime entry points.
DO $$ DECLARE f record; safe boolean; BEGIN
  IF EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a JOIN pg_class c ON c.oid=x.attrelid
      WHERE x.attrelid='hon.class_series'::regclass AND x.attname='ongoing' AND a.grantee<>c.relowner)
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='hon.class_series'::regclass AND attname='ongoing' AND atttypid='boolean'::regtype AND attnotnull) THEN
    RAISE EXCEPTION 'hon.class_series.ongoing must be a private NOT NULL boolean'; END IF;
  FOR f IN SELECT * FROM (VALUES
('hon.class_series_fill_dates(hon.class_series,date,date)',true,false,'search_path=pg_catalog, hon','7c320407a1bd2b05a7ca45c6d6bbc98182435abffb558f2f3079f58f1ae66a93'),
('hon.set_class_series_ongoing(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','f34de3665727e1ec473ba75a72a3cc8e877bf4d5c67f4f0323554ffc3298462a'),
('hon.top_up_class_series(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','c7f36b277c3d47143b9c55c5e66658c270f895af9ef43d5ab3dc1c433ce851b3')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe ongoing class series function: %',f.signature; END IF;
  END LOOP;
  IF has_any_column_privilege('hon_runtime','hon.class_sessions','UPDATE') THEN RAISE EXCEPTION 'Runtime must not update class sessions'; END IF;
END $$;
-- End ongoing class series exact verification.

-- School payment connections exact verification (B-TUI-2 0258): three private forced-RLS tables, the guards, private
-- helpers, six runtime entry points, the two permissions, and a provider registry that is never live.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.school_pay_providers','hon.school_pay_connections','hon.school_pay_connection_events'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=t::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'School payment table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.school_pay_capabilities_ok(jsonb)',false,false,'search_path=pg_catalog','06a760116cb31bccc05b5744c9210282eb237e712fabe5f52f05f8407bfef560'),
('hon.guard_school_pay_connection()',true,false,'search_path=pg_catalog, hon','ca63878ec37b758f1d03999ea64391e15baee8e2107fb134938c2bbd3f61f987'),
('hon.require_school_pay_actor(text,text)',true,false,'search_path=pg_catalog, hon','1cb9d691e46a5e885b1a038335164c51122a6043e94139a74e30293a991a1c2b'),
('hon.require_school_pay_reader(text)',true,false,'search_path=pg_catalog, hon','0ea5164d4d234bd7a49b554e845bde508b33b625269775ff95b937f3038d7d17'),
('hon.school_pay_connection_json(hon.school_pay_connections)',false,false,'search_path=pg_catalog, hon','ab503fa6fd4fe382b20297b7196994be0626cd18386ba292ef1d728c121d2281'),
('hon.school_pay_observation_ok(jsonb)',false,false,'search_path=pg_catalog','b964d6192f817194e55427229f4bba83823a1bafa46d6561aadb7b46875f5e56'),
('hon.school_pay_command_begin(text,text,text)',true,false,'search_path=pg_catalog, hon','e95e4aa612d5d559bf697d88de741613bccb8d4a7091fafcd0af757319601f2f'),
('hon.school_pay_command_finish(text,text,uuid,hon.school_pay_connections,text,text,jsonb,uuid,uuid)',true,false,'search_path=pg_catalog, hon','4bd3be705f3b545199162e3b3437fc0d0e991c9f2575c567781f8e0e68a197ef'),
('hon.school_pay_args_ok(text,uuid,jsonb,text,uuid,uuid,text[],text[])',false,false,'search_path=pg_catalog, hon','de2fd29c891b6550fa38d055fc046a198d1c9e90be6b7347b199a385e57c5a9d'),
('hon.school_pay_lock_connection(uuid,integer)',true,false,'search_path=pg_catalog, hon','a2a7b57ba3db0605bac9e56315c2c300e91d90e848c5dc04176191f5a6df2e8b'),
('hon.read_school_payment_processors(text)',true,true,'search_path=pg_catalog, hon','570a2dcb17443ca85f921c9cd7bfc84fef59ab9ecbc4a46e0146272d0241947f'),
('hon.start_school_payment_connection(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','08bc907fdba773452a52dea4977c3d6f4f46753e3fe6d1f8faacf5d4f99034e1'),
('hon.set_school_payment_onboarding_link(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','5b51f613baddd3aa63ccf87e0313148504fa95cc8734571c6a5facba00ead5d4'),
('hon.school_pay_account_free(hon.school_pay_connections,text)',true,false,'search_path=pg_catalog, hon','f627e5dad741d24228353041e0ed631389c20812877999e35d02db8fc6f2c903'),
('hon.record_school_payment_status(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','036f9097a1a7abc30565f89227c1fb012a4c5ce3f4ddc1b0a9dcc03a8c84aebf'),
('hon.set_default_school_payment_connection(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','598bae115bdef41b7cecf8cac40812cde870101b706027964ff8801f1bfef9a6'),
('hon.disconnect_school_payment_connection(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','b0419db95c9ce42f9f615543b8bafa8ca92f9eaae475f377e8b1716df918816d')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school payment function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('school_pay_connections','school_pay_connection_guard','hon.guard_school_pay_connection()'),
    ('school_pay_connections','school_pay_connections_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_pay_connection_events','school_pay_connection_events_immutable','hon.guard_membership_activation_evidence()'),
    ('school_pay_connection_events','school_pay_connection_events_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_pay_providers','school_pay_providers_immutable','hon.guard_membership_activation_evidence()'),
    ('school_pay_providers','school_pay_providers_no_truncate','hon.guard_membership_activation_evidence()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing school payment guard: %',expected.name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('school_pay.connection.manage','school_pay.read') AND is_sensitive AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'school_pay permissions must exist as sensitive staff-assignable permissions'; END IF;
  IF EXISTS(SELECT 1 FROM hon.school_pay_providers WHERE live_allowed) OR EXISTS(SELECT 1 FROM hon.school_pay_connections WHERE mode<>'TEST') THEN
    RAISE EXCEPTION 'School payments must stay in test mode'; END IF;
END $$;
-- End school payment connections exact verification.

-- School payer saved methods exact verification (B-TUI-2 0321): four private forced-RLS tables, the guards, private
-- validators and helpers, six runtime entry points and the permission.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.school_pay_customers','hon.school_pay_method_setups','hon.school_pay_methods','hon.school_pay_method_events'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=t::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'School payer method table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.guard_school_pay_method_setup()',true,false,'search_path=pg_catalog, hon','268b6cb31f618ef2e27985201b7b5445bcaf2e6f7c0ac7c0af987d7f3ed51577'),
('hon.guard_school_pay_method()',true,false,'search_path=pg_catalog, hon','c3ce246d16e3ebb36b5d6c6526a0c7877c74d432a69279836a67246d9fbc690b'),
('hon.require_school_pay_method_actor(text,text)',true,false,'search_path=pg_catalog, hon','f2502f3898852a8690692f86d84ad71657b4eef076cbd64f6134a87e69d7e622'),
('hon.require_school_pay_method_reader(text)',true,false,'search_path=pg_catalog, hon','3abcb1e7071708a57c470da27b0193dd1a05fce7ceb067b2a106320c0d881920'),
('hon.school_pay_instant(timestamp with time zone)',false,false,'search_path=pg_catalog','e4a86c6f3c7e0d57791518a05be7b1552ebb4b274f34c42dc0e8b86bf6a93d46'),
('hon.school_pay_method_json(hon.school_pay_methods)',false,false,'search_path=pg_catalog, hon','ba0dda7f37f751c30345f0ff977bc7db38bbc45264435d5970e1edfd0a60891f'),
('hon.school_pay_setup_json(hon.school_pay_method_setups)',false,false,'search_path=pg_catalog, hon','1564a497806142bc937c7f18ec52de1940a6ad6566f8672595f30734538dd30c'),
('hon.school_pay_method_observation_ok(jsonb)',false,false,'search_path=pg_catalog','0104479fa4203d5a34a39ce4e08574c3d0b7fd5e8da52c625d8a083bdd19319b'),
('hon.school_pay_method_begin(text,text,text)',true,false,'search_path=pg_catalog, hon','a4a7fd7575536e8399d9a913732248814c34cb78eef143e9a99ca1568f8e6815'),
('hon.school_pay_method_record(uuid,uuid,text,uuid,integer,text,text,jsonb,jsonb,uuid,uuid)',true,false,'search_path=pg_catalog, hon','30c74f21420d14cd9ed31605c141c5bea19df46d8742e3922f94ddbea0988784'),
('hon.school_pay_method_complete(text,text,uuid,jsonb)',true,false,'search_path=pg_catalog, hon','9b2b71c73b630b95d6d15c8c00bab4152857959c9e5dd179eb397c9f5eb12618'),
('hon.school_pay_lock_payer(uuid)',true,false,'search_path=pg_catalog, hon','c13cf95bd792bdf481236a6ef7bb896a5ba7cf76f9ebec944b87ac72344ae805'),
('hon.school_pay_lock_method(uuid,integer)',true,false,'search_path=pg_catalog, hon','985b718aded17611b83e76b1e44475ba9db1e36c856d0ffb165ef70f6282e024'),
('hon.read_school_pay_payer_methods(text,uuid)',true,true,'search_path=pg_catalog, hon','4dfd5a41524e2cfa386f27319ecd3eb40f805ea0bb8f4f6cbf09a743082b25e5'),
('hon.read_school_pay_expiring_methods(text)',true,true,'search_path=pg_catalog, hon','eb6dc59a91ed39a0533c597abff21d1775fa7a769ee6452a302241d5818cd08b'),
('hon.start_school_pay_method_setup(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','a10937645c992e742dd7895e1943f3c488c41128e628151ffeb6f0c3cc4bd489'),
('hon.finish_school_pay_method_setup(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','e96ed6570979d7439ad9488f95d657d9bccc80eeee16ed6c5e5474eb17aa7a31'),
('hon.set_default_school_pay_method(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','9314b4a6e327cece8c72365162395f666ad36b685e55f52077ce2aa7f11d2d11'),
('hon.remove_school_pay_method(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','8717b001bfa7462c0c5e42f8aec8a30a62787d67f6774a111cb7eac1147305f1')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school payer method function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('school_pay_customers','school_pay_customers_immutable','hon.guard_membership_activation_evidence()'),
    ('school_pay_customers','school_pay_customers_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_pay_method_setups','school_pay_method_setup_guard','hon.guard_school_pay_method_setup()'),
    ('school_pay_method_setups','school_pay_method_setups_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_pay_methods','school_pay_method_guard','hon.guard_school_pay_method()'),
    ('school_pay_methods','school_pay_methods_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_pay_method_events','school_pay_method_events_immutable','hon.guard_membership_activation_evidence()'),
    ('school_pay_method_events','school_pay_method_events_no_truncate','hon.guard_membership_activation_evidence()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing school payer method guard: %',expected.name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='school_pay.method.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'school_pay.method.manage must exist as a sensitive staff-assignable permission'; END IF;
END $$;
-- End school payer saved methods exact verification.

-- School autopay exact verification (B-TUI-2 0322): five private forced-RLS tables, the plan guard, private helpers,
-- eight runtime entry points and the two permissions.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.school_pay_discount_rules','hon.school_pay_autopay_plans','hon.school_pay_autopay_cycles','hon.school_pay_autopay_cycle_lines','hon.school_pay_autopay_events'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=t::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'School autopay table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.guard_school_pay_autopay_plan()',true,false,'search_path=pg_catalog, hon','107c77dcf040941fbeaf1a4f9a022a701970cb24639fe36e94da1368aaa9b005'),
('hon.require_school_pay_autopay_actor(text,text)',true,false,'search_path=pg_catalog, hon','134694222f8aa54ff2547ba9b70527d557b50a2965105614a37142ce6b2457c1'),
('hon.require_school_pay_autopay_reader(text,text[])',true,false,'search_path=pg_catalog, hon','2054e0deae2fedecd49fa52a61b73ee4238dd3bc34f86f750b4e57bba366976b'),
('hon.school_pay_school_zone()',true,false,'search_path=pg_catalog, hon','6237e35872aaf3b336a3ceae9d6d361cc3d8a351bc4b587d410305e0278779ef'),
('hon.school_pay_discount_rule_json(hon.school_pay_discount_rules)',false,false,'search_path=pg_catalog, hon','e3f1986ff3c589933d775f58cb5eff7ed40dc37e60794da76bc33df70ce4447a'),
('hon.school_pay_autopay_plan_json(hon.school_pay_autopay_plans)',false,false,'search_path=pg_catalog, hon','86c9cc2f7f3dd1735feea472a77cb2ab34e29511b56ff21bb04b5541d652850d'),
('hon.school_pay_current_discount_rule()',true,false,'search_path=pg_catalog, hon','ac0b1db791e36092e408428eb0b7315496f0ea57da67cd3c39967b65b49dc291'),
('hon.school_pay_sibling_discount(hon.school_pay_discount_rules,integer,integer,text)',false,false,'search_path=pg_catalog, hon','0ce701b08d2c9c42d11bc251c408f7bf1e383336925eb11ee10b01dedbde33bf'),
('hon.school_pay_next_period(timestamp with time zone,text,text,timestamp with time zone,timestamp with time zone)',false,false,'search_path=pg_catalog','5a26914caf6b255054169da1ed250aaea8723704203d5c4ebf56274874d4a285'),
('hon.school_pay_series_anchor(timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)',false,false,'search_path=pg_catalog','fd2a63b1e9730c0930945739ea0c3942d8a17054f328789fc21b4dbb22afdb32'),
('hon.school_pay_autopay_due(uuid,date,text,hon.school_pay_discount_rules)',true,false,'search_path=pg_catalog, hon','27ccd7216b7e061bc81e7f8c839fb202ed540bb1a70b5374c90db6c85a50b2d3'),
('hon.school_pay_autopay_cycle_json(hon.school_pay_autopay_cycles)',true,false,'search_path=pg_catalog, hon','88d35e90a2180672b65c039343c43e58e51eafc8f55036d437075bc199d91a68'),
('hon.school_pay_autopay_method_usable(uuid,uuid)',true,false,'search_path=pg_catalog, hon','6e6df6c6984a0d035806752d2e73f1ff8ea548d64a36159486786914c8bacc45'),
('hon.school_pay_autopay_begin(text,text,text,text)',true,false,'search_path=pg_catalog, hon','8a90304837e3adb51380250bc2a7222730f6ca1897cad82bfa6e374bd431c021'),
('hon.school_pay_autopay_record(uuid,uuid,text,uuid,integer,text,text,jsonb,jsonb,uuid,uuid)',true,false,'search_path=pg_catalog, hon','e014c4202c79fbb9f3186150e890123912aea20e28fbf2d7cc3ef01bd83244dd'),
('hon.school_pay_autopay_complete(text,text,text,uuid,jsonb)',true,false,'search_path=pg_catalog, hon','5e40da7e0954e72a5d460ff3376df5bd648aa31569e5445859cdf4a9a5507177'),
('hon.school_pay_lock_autopay_plan(uuid,integer)',true,false,'search_path=pg_catalog, hon','ed2e8fe0a9811d9feb1de26f81ee3b7e30251e526c4d0d785051b023f9499286'),
('hon.read_school_pay_autopay(text,uuid)',true,true,'search_path=pg_catalog, hon','3a9a52a5df347a1b3c6046bdd953e0810db1d1efa36e5900588d15cd144cb6c2'),
('hon.read_school_pay_discount_rule(text)',true,true,'search_path=pg_catalog, hon','5ed353d7745de9e42d5260e990cd9d1ec4a44da166459f425d649c9a6bca8c04'),
('hon.set_school_pay_discount_rule(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','c4200b8c1ced93331d0f45fd01b9e3a458e5558f652a0ff2b77750c3e022c25b'),
('hon.enroll_school_pay_autopay(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','9b2cc7d8c96c7f4073933796959ebf7e008d4bed06726927ea3470ed75407343'),
('hon.change_school_pay_autopay_method(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','4afe599e81c3c0b48c87b43120add1679411a9fd124bd5603cbf6db2c595d405'),
('hon.set_school_pay_autopay_state(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','1447c643e9c7ecfd1ea72004cb151d602f95fcffb9f55cf348d9712963d6ec79'),
('hon.cancel_school_pay_autopay(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','ce709fd3dbd90a679df06aca118a6d17645c1759eaaf72992091c5a06a6f97f3'),
('hon.prepare_school_pay_autopay_cycle(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','d8f3fe44fc1dae7855069a9f879b554afb877794e0a9035fe1e2ff7823eecdd2')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school autopay function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('school_pay_discount_rules','school_pay_discount_rules_immutable','hon.guard_membership_activation_evidence()'),
    ('school_pay_discount_rules','school_pay_discount_rules_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_pay_autopay_plans','school_pay_autopay_plan_guard','hon.guard_school_pay_autopay_plan()'),
    ('school_pay_autopay_plans','school_pay_autopay_plans_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_pay_autopay_cycles','school_pay_autopay_cycles_immutable','hon.guard_membership_activation_evidence()'),
    ('school_pay_autopay_cycles','school_pay_autopay_cycles_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_pay_autopay_cycle_lines','school_pay_autopay_cycle_lines_immutable','hon.guard_membership_activation_evidence()'),
    ('school_pay_autopay_cycle_lines','school_pay_autopay_cycle_lines_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_pay_autopay_events','school_pay_autopay_events_immutable','hon.guard_membership_activation_evidence()'),
    ('school_pay_autopay_events','school_pay_autopay_events_no_truncate','hon.guard_membership_activation_evidence()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing school autopay guard: %',expected.name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('school_pay.autopay.manage','school_pay.discount.manage') AND is_sensitive AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'school_pay.autopay.manage and school_pay.discount.manage must exist as sensitive staff-assignable permissions'; END IF;
END $$;
-- End school autopay exact verification.

-- School autopay charges exact verification (B-TUI-2 0337): two private forced-RLS tables, the attempt, payment-record
-- and invoice guards, private helpers, four runtime entry points and the PROVIDER payment method.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.school_pay_charge_attempts','hon.school_pay_charge_events'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=t::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'School autopay charge table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.guard_school_pay_charge_attempt()',true,false,'search_path=pg_catalog, hon','f51a3bd209748c6963de31ff39cc35f6e9d10f46174a2060c2497816fb34587d'),
('hon.school_pay_invoice_charge_open(uuid)',true,false,'search_path=pg_catalog, hon','3a9692741e5149599d60f4c55faa420296ce6b4cb462d3803ea39f4cab461012'),
('hon.guard_school_pay_charge_payment_record()',true,false,'search_path=pg_catalog, hon','ca717afb2623fa3f05d78a1ccda763edf8083460036fe7125def6473ad6d3d1f'),
('hon.guard_school_pay_charge_invoice()',true,false,'search_path=pg_catalog, hon','662e92f463cfba1a4b30fc96fddcfc3e7e4bb87a41724b7407f618457a514f04'),
('hon.school_pay_charge_json(hon.school_pay_charge_attempts)',true,false,'search_path=pg_catalog, hon','b3942ee06b7967e19bb772404c29dca8c0d6372f0737735401a603cde89f8a69'),
('hon.school_pay_charge_record(uuid,hon.school_pay_charge_attempts,text,jsonb,text,uuid,uuid)',true,false,'search_path=pg_catalog, hon','40f2e7b4b62daffca89ea3f5250e3907ab8163b38738d3359d9e92f802a402b4'),
('hon.school_pay_lock_charge(uuid,integer)',true,false,'search_path=pg_catalog, hon','76a8a8127041c700b95b9899553c96a002ab8f8a5e2af506987ca83c9ff1b266'),
('hon.read_school_pay_autopay_charges(text,uuid)',true,true,'search_path=pg_catalog, hon','dbcfd342b3691421dd85a9d68cb5f9262096e7ed3500304f48e9d54d19234c0c'),
('hon.read_school_pay_charge_attempt(text,uuid)',true,true,'search_path=pg_catalog, hon','54e5f715f65db777d5b1caef2b528793defb63efe51eaaa4e15c41e5f2297856'),
('hon.begin_school_pay_charge(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','dcfb154ad5b2b0ecd4c26b032bf2041430b04c6ebb37734fc2348927928d1e1c'),
('hon.school_pay_charge_outcome_ok(jsonb)',false,false,'search_path=pg_catalog, hon','eef349a8e5589c75110a4eb198a111f23d23c615400bc8fcaa37e7e904bf4357'),
('hon.school_pay_charge_settle(hon.school_pay_charge_attempts,jsonb,uuid,text,uuid,uuid)',true,false,'search_path=pg_catalog, hon','82c1ecde9a5cb1a7c9a52fb79c4af29ce00f14564138616f1a3dd7a87bd9b91f'),
('hon.finish_school_pay_charge(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','2d46ece141220939210c3a8908da1065f78d75f774541a6e9a01b2d632465bfc')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school autopay charge function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('school_pay_charge_attempts','school_pay_charge_attempt_guard','hon.guard_school_pay_charge_attempt()'),
    ('school_pay_charge_attempts','school_pay_charge_attempts_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_pay_charge_events','school_pay_charge_events_immutable','hon.guard_membership_activation_evidence()'),
    ('school_pay_charge_events','school_pay_charge_events_no_truncate','hon.guard_membership_activation_evidence()'),
    ('invoice_payment_records','school_pay_charge_payment_record_guard','hon.guard_school_pay_charge_payment_record()'),
    ('invoices','school_pay_charge_invoice_guard','hon.guard_school_pay_charge_invoice()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing school autopay charge guard: %',expected.name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.invoice_payment_records'::regclass AND conname='invoice_payment_records_provider_reference_check' AND convalidated)
    OR (SELECT count(*) FROM pg_constraint WHERE conrelid='hon.invoice_payment_records'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%CARD_TERMINAL%')<>1
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.invoice_payment_records'::regclass AND conname='invoice_payment_records_method_check'
      AND pg_get_constraintdef(oid) LIKE '%PROVIDER%') THEN
    RAISE EXCEPTION 'Invoice payment records must allow exactly the manual methods and PROVIDER with a processor reference'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='hon' AND indexname='school_pay_charge_attempts_one_live_idx') THEN
    RAISE EXCEPTION 'A cycle must have at most one charge attempt that is not FAILED'; END IF;
END $$;
-- End school autopay charges exact verification.

-- School payment credential vault exact verification (B-TUI-2 0320): two private forced-RLS tables, the guards, the
-- deferred credential check, private validators, four runtime entry points, and only Square keeping credentials.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.school_pay_provider_credentials','hon.school_pay_credentials'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=t::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'School payment credential table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.check_school_pay_connection_credential()',true,false,'search_path=pg_catalog, hon','e663c7c09c9cc07f08067abe73c173ab2253fb46f78dd3372549a78945f7c29e'),
('hon.check_school_payment_onboarding_state(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','ebf82596ef482e4ddff48b996dee8d5b4a13c43d30756054aa7baa328c290360'),
('hon.destroy_school_pay_credential_on_end()',true,false,'search_path=pg_catalog, hon','57381575d521f64bc8b417cbeb4db137bfb9b797e05896bbe5ba32d802d4d979'),
('hon.guard_school_pay_credential()',true,false,'search_path=pg_catalog, hon','e894b487e8aa3743383855a4cbeee4c93c7869c498ac7bca080376caeb9db0cf'),
('hon.read_school_payment_account_use(text,uuid)',true,true,'search_path=pg_catalog, hon','22503521f3534da4ee9d96355eafa293640c61e37f483a0592fe856c1aa0c994'),
('hon.read_school_payment_credential(text,uuid)',true,true,'search_path=pg_catalog, hon','4f7f42f6fe935be36f03f58c2b7cf4c66ae7ecc24427e7e700bfcbd427021d48'),
('hon.record_school_payment_status_with_credential(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','77f450a3afd747a9e29643cfbfe32b0c58d1198773f520c3950c61e9fdae64bd'),
('hon.school_pay_credential_input_ok(jsonb)',false,false,'search_path=pg_catalog','1e0d04634f74c29427f869d446417a4d61bac646956b947d287fd578cd27352f')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school payment credential function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('school_pay_credentials','school_pay_credential_guard','hon.guard_school_pay_credential()'),
    ('school_pay_credentials','school_pay_credentials_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_pay_provider_credentials','school_pay_provider_credentials_immutable','hon.guard_membership_activation_evidence()'),
    ('school_pay_provider_credentials','school_pay_provider_credentials_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_pay_connections','school_pay_connection_credential_destroy','hon.destroy_school_pay_credential_on_end()'),
    ('school_pay_connections','school_pay_connection_credential_check','hon.check_school_pay_connection_credential()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O') THEN
      RAISE EXCEPTION 'Missing school payment credential guard: %',expected.name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.school_pay_connections'::regclass AND tgname='school_pay_connection_credential_check' AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'The school payment credential check must be deferred to commit'; END IF;
  IF (SELECT string_agg(provider_code||':'||credential_kind,',' ORDER BY provider_code) FROM hon.school_pay_provider_credentials) IS DISTINCT FROM 'SQUARE:OAUTH_TOKENS' THEN
    RAISE EXCEPTION 'Only Square keeps school payment credentials'; END IF;
  IF EXISTS(SELECT 1 FROM hon.school_pay_credentials k JOIN hon.school_pay_connections c ON c.id=k.connection_id WHERE c.ended_at IS NOT NULL AND k.destroyed_at IS NULL) THEN
    RAISE EXCEPTION 'An ended school payment connection still holds a credential'; END IF;
END $$;
-- End school payment credential vault exact verification.

-- School checkout pages exact verification (B-TUI-2 0269): two private forced-RLS tables, the guards, private
-- validators and helpers, two runtime entry points and the permission.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.school_checkout_pages','hon.school_checkout_page_versions'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=t::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'School checkout table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.checkout_text_ok(jsonb,integer,boolean)',false,false,'search_path=pg_catalog','794543a7922028c125cbb065b54ca97ad1b0b5c56cfa6d9a87e9ff76dd382e12'),
('hon.checkout_i18n_ok(jsonb,integer,boolean)',false,false,'search_path=pg_catalog, hon','b239d42e6814189094309db1b5ff1e3e85ee668c4f45972413ab88a700462b52'),
('hon.checkout_content_ok(jsonb)',false,false,'search_path=pg_catalog, hon','d58781d1946c1681ce86e346f610a59e5c4369b223f8ef01d812706e6151723b'),
('hon.guard_school_checkout_page()',false,false,'search_path=pg_catalog, hon','63a5a8ae76a8592e09e86b0a47741beb44d41b4536012714d3357dc75dd8efe4'),
('hon.require_school_checkout_actor(text)',true,false,'search_path=pg_catalog, hon','ce5ec0311542b6956f4155b94e2887499626783b66f30779838adaf27c7c6bc0'),
('hon.school_checkout_page_json(hon.school_checkout_pages)',false,false,'search_path=pg_catalog, hon','39f46e65b834fb8f1137ccfae9ae58d9069a7639e3538af084c420b3c88d68e1'),
('hon.read_school_checkout_pages(text)',true,false,'search_path=pg_catalog, hon','02f443483ac4bd2750ebf6278e3283f86baf8e58e6715cd9c59134e617731f6d'),
('hon.save_school_checkout_page(text,jsonb,text,uuid,uuid)',true,false,'search_path=pg_catalog, hon','2ee3c365baacab116aad18fe0c37eb591db7258d7209c627c1ced7d45d1dcf53')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school checkout function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('school_checkout_pages','school_checkout_page_guard','hon.guard_school_checkout_page()'),
    ('school_checkout_pages','school_checkout_pages_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_checkout_page_versions','school_checkout_page_versions_immutable','hon.guard_membership_activation_evidence()'),
    ('school_checkout_page_versions','school_checkout_page_versions_no_truncate','hon.guard_membership_activation_evidence()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing school checkout guard: %',expected.name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='school_checkout.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'school_checkout.manage must exist as a sensitive staff-assignable permission'; END IF;
END $$;
-- End school checkout pages exact verification.

-- School event booking exact verification (B-SCH-3 0261): four private forced-RLS tables, private helpers and eight runtime entry points.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_events','school_event_slots','school_event_bookings','school_event_rates'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=('hon.'||t)::regclass AND relrowsecurity AND relforcerowsecurity)
      OR has_table_privilege('hon_runtime',('hon.'||t)::regclass,'SELECT') OR has_table_privilege('hon_runtime',('hon.'||t)::regclass,'INSERT')
      OR has_table_privilege('hon_runtime',('hon.'||t)::regclass,'UPDATE') OR has_table_privilege('hon_runtime',('hon.'||t)::regclass,'DELETE')
      OR has_any_column_privilege('hon_runtime',('hon.'||t)::regclass,'SELECT') THEN
      RAISE EXCEPTION 'hon.% must be private with forced RLS',t; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000261')
    OR NOT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000261' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL) THEN
    RAISE EXCEPTION 'The public event booking principal must be a role-free system service'; END IF;
  FOR f IN SELECT * FROM (VALUES
('hon.school_event_text_ok(text,integer,integer)',false,false,'search_path=pg_catalog','f9822772a30474ac4e92fe944a1a28e32a9ca01b676aa7fc7c63a84d2d9f86fa'),
('hon.guard_school_event()',true,false,'search_path=pg_catalog, hon','efb459bf00a5a3ade73094e54be183526dc7472b6c0a3d099b975146b1b2eba8'),
('hon.guard_school_event_booking()',true,false,'search_path=pg_catalog, hon','5ea50f6450c2c57b9a95de906388d5a3d5182c3ec4ad4577f09f3c1c4ffd25d4'),
('hon.school_event_slot_taken(uuid)',true,false,'search_path=pg_catalog, hon','93b3a2e5dc77423e797de4c8bf6dfce82879bdcd805ed66c083814c66c865ae8'),
('hon.school_event_json(hon.school_events)',true,false,'search_path=pg_catalog, hon','03ca019a0b8640faa0e07ee84ae42f27180df99689f5650e06d956a4b3433894'),
('hon.school_event_booking_json(hon.school_event_bookings)',true,false,'search_path=pg_catalog, hon','9d37b220554cd25a792b7eb2dcc64fee3dbc4dacc3c77590d9a22610d943e5e5'),
('hon.school_event_input(jsonb)',false,false,'search_path=pg_catalog, hon','d67f94449bf46dce99810a730a52d5da64f5879e5f3a83a9d6273bed3435beb3'),
('hon.school_event_command_finish(text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',true,false,'search_path=pg_catalog, hon','9d3a79b0be6d24600a6d0314a99b09b9344c0683044aba9d64fc58299be9c78b'),
('hon.save_school_event(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','013fa779651da9686a50b72ae8c4d288e3afbf40a5c3168cc5cc89233b733224'),
('hon.set_school_event_status(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','8d50c7429b68acc6b48ef1cefeda2ca32bbb2765449a25ceea31a1f1eda88f10'),
('hon.set_school_event_booking_status(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','b4fe65d0414303602b3e5ea2acdd3082042e4985cf04ac47245f0887fd0a39af'),
('hon.read_school_events(text)',true,true,'search_path=pg_catalog, hon','f3c40ab04eb63c9eb65b4b8e52d1af686a76d3c20854fdd33fb496a0e1e65c89'),
('hon.read_school_event(text,uuid)',true,true,'search_path=pg_catalog, hon','21259a6369d4d9a3f5fe1d4fa013581f70aa2d645a2b918e2edade64820dd058'),
('hon.take_school_event_rate(uuid,text,integer)',true,false,'search_path=pg_catalog, hon','7da03a0bd5423337c2472edd2fd2337f4ec7d74ee7f3fb6e47e48c709c5c8c67'),
('hon.public_school_event(text)',true,false,'search_path=pg_catalog, hon','78e99fcbedaea0d1aacbdfa0d67c19dd9cb834a4c3e5cb58df2fd9c4785c3404'),
('hon.read_public_school_event(text)',true,true,'search_path=pg_catalog, hon','25e00301e7c71ab2ad577e460f589ecbed6336047b8a4fe1efc9d1d79d1f110f'),
('hon.school_event_booking_input(jsonb)',false,false,'search_path=pg_catalog, hon','ca89ded1d444fe534a16da007c6342cea4c0022511a608bb60c77e17d9fc2b2f'),
('hon.book_public_school_event(text,jsonb,text)',true,true,'search_path=pg_catalog, hon','ba2d2021193a7798c7b67f91de7c31b6ccb8f97ddbd76eeb07fbee3590894ad1'),
('hon.cancel_public_school_event_booking(text,jsonb)',true,true,'search_path=pg_catalog, hon','ff635a29f483eb22eaab4154b4796a092f4670fdba5c70027ec57903842c5f74')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school event booking function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End school event booking exact verification.

-- Maya at-risk students exact verification (M1 0259): two private helpers and one read-only runtime entry point.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.require_maya_actor(text,text)',true,false,'search_path=pg_catalog, hon','f02d8bf96fd8778b33996b792fd26abd8870fcee9a8f8fba0e7984ea3e40a3e9'),
('hon.maya_reader_sees_tuition(text)',true,false,'search_path=pg_catalog, hon','16334235a565a92419cacb6472b0324fe185928c20bfea2782c93a7235b221af'),
('hon.read_maya_at_risk_students(text,jsonb)',true,true,'search_path=pg_catalog, hon','fef4486ea9a901293e41231c3ad82a86c002d5bd47e609b22fbac0e78871e3c4')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Maya at-risk function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='retention.review.read' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'retention.review.read must exist as a sensitive staff-assignable permission'; END IF;
END $$;
-- End Maya at-risk students exact verification.

-- School invoice list exact verification (B-TUI-1b 0280): one definer read-only runtime entry point, exact body.
DO $$ DECLARE safe boolean; BEGIN
  SELECT p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND (owner.rolsuper OR owner.rolbypassrls)
    AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='cb1fbb5c9d43b79c8991a892a2bff687edb37c2b60f456d9e0c300d80e2acb35'
    AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
  INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid='hon.read_school_invoices(text,jsonb)'::regprocedure;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school invoice list function'; END IF;
END $$;
-- End school invoice list exact verification.

-- Missed-call text-back exact verification (B-COM-1 0249): a private forced-RLS table the runtime cannot touch, one
-- entitlement-gated definer read and the HQ-owner settings command for the runtime, and worker-only routing/recording.
DO $$ DECLARE f text; runtime oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'); BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.missed_calls'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR has_table_privilege('hon_runtime','hon.missed_calls','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'Unsafe missed-call table posture'; END IF;
  FOREACH f IN ARRAY ARRAY['hon.read_school_missed_calls(text,uuid,integer)','hon.set_school_missed_call_settings_from_hq(text,uuid,text,boolean,integer)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND p.proowner<>runtime AND (owner.rolsuper OR owner.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (a.grantee<>runtime OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
      RAISE EXCEPTION 'Unsafe missed-call runtime function: %',f; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc x WHERE x.pronamespace='hon'::regnamespace AND x.proname='read_school_missed_calls')<>1 THEN
    RAISE EXCEPTION 'Unexpected missed-call read overload'; END IF;
  FOREACH f IN ARRAY ARRAY['hon.read_missed_call_route(text)','hon.record_missed_call(text,text,text,text,timestamptz)',
    'hon.claim_missed_call_text_backs(integer,integer)','hon.record_missed_call_text_back_result(uuid,uuid,text,text)'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE') THEN RAISE EXCEPTION 'Runtime can run missed-call worker function: %',f; END IF;
  END LOOP;
END $$;
-- End missed-call text-back exact verification.

-- School page branding exact verification (B-SCH-3 0285): two private forced-RLS tables, the guards, private validators
-- and helpers, three runtime entry points and the permission.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.school_page_branding','hon.school_page_branding_versions'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=t::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'School branding table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.school_branding_image_ok(text)',false,false,'search_path=pg_catalog','b10e7b2fced41045b95b6ab3843d662dc31192978ec596c23922071faa482d62'),
('hon.school_branding_input_ok(jsonb)',false,false,'search_path=pg_catalog, hon','053a6c6f5c424e4bbe5dcdbdfe8e696d652884514bc1562f34c3705426678882'),
('hon.guard_school_page_branding()',false,false,'search_path=pg_catalog, hon','4069df59a225f8552d5f3580bc20e0bf8f597d6a4a8532094e9ba05e485323f4'),
('hon.require_school_branding_actor(text)',true,false,'search_path=pg_catalog, hon','15ded18d96c4a2956744c9ef24b4f6c37f9a0686a0a5918477cc1a4197a8fe9d'),
('hon.school_page_branding_json(hon.school_page_branding)',false,false,'search_path=pg_catalog, hon','2b75779f3aa2a4fddf7b26cbca03e922a752effa694a3653ec0bba0b3551810d'),
('hon.read_school_page_branding(text)',true,true,'search_path=pg_catalog, hon','7a0f8422ee144c7c90df29e63b9160255d052ea64d193e2a199b84568a0273c7'),
('hon.save_school_page_branding(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','71b8e89c1975c7d3f9d3d6a2cc6a1d1787438579d6ead5d2667c22f6c62134f4'),
('hon.read_public_school_branding(uuid)',true,true,'search_path=pg_catalog, hon','92c9b82ee4ff86f509546c2bb441a6f63144a88de8f2adefab0385368a84ea63')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school branding function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('school_page_branding','school_page_branding_guard','hon.guard_school_page_branding()'),
    ('school_page_branding','school_page_branding_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_page_branding_versions','school_page_branding_versions_immutable','hon.guard_membership_activation_evidence()'),
    ('school_page_branding_versions','school_page_branding_versions_no_truncate','hon.guard_membership_activation_evidence()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing school branding guard: %',expected.name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='school_branding.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'school_branding.manage must exist as a sensitive staff-assignable permission'; END IF;
END $$;
-- End school page branding exact verification.

-- Zernio lead intake exact verification (B-COM-1 0250): two private forced-RLS tables the runtime cannot touch, the
-- HQ-owner mapping command for the runtime, and worker-only lead recording.
DO $$ DECLARE t text; runtime oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'); BEGIN
  FOREACH t IN ARRAY ARRAY['hon.zernio_lead_forms','hon.zernio_lead_receipts'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR has_table_privilege('hon_runtime',t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'Unsafe Zernio table posture: %',t; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
      WHERE p.oid='hon.set_zernio_lead_form_from_hq(text,uuid,text,text,uuid,uuid,jsonb,text,integer)'::regprocedure AND p.prosecdef
      AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND p.proowner<>runtime AND (owner.rolsuper OR owner.rolbypassrls)
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>runtime OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
    RAISE EXCEPTION 'Unsafe Zernio mapping command'; END IF;
  IF has_function_privilege('hon_runtime','hon.record_zernio_lead(text,text,text,text,jsonb,jsonb)'::regprocedure,'EXECUTE')
    OR has_function_privilege('hon_runtime','hon.zernio_valid_field_map(jsonb)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'Runtime can run a Zernio worker function'; END IF;
END $$;
-- End Zernio lead intake exact verification.

-- School booking types exact verification (0286): three private forced-RLS tables, private helpers and eight runtime entry points.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_booking_types','school_booking_type_bookings','school_booking_type_rates'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=('hon.'||t)::regclass AND relrowsecurity AND relforcerowsecurity)
      OR has_table_privilege('hon_runtime',('hon.'||t)::regclass,'SELECT') OR has_table_privilege('hon_runtime',('hon.'||t)::regclass,'INSERT')
      OR has_table_privilege('hon_runtime',('hon.'||t)::regclass,'UPDATE') OR has_table_privilege('hon_runtime',('hon.'||t)::regclass,'DELETE')
      OR has_any_column_privilege('hon_runtime',('hon.'||t)::regclass,'SELECT') THEN
      RAISE EXCEPTION 'hon.% must be private with forced RLS',t; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000286')
    OR NOT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000286' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL) THEN
    RAISE EXCEPTION 'The public booking type principal must be a role-free system service'; END IF;
  FOR f IN SELECT * FROM (VALUES
('hon.school_booking_text_ok(text,integer)',false,false,'search_path=pg_catalog, hon','0d6e88ab130348536766d9d478a269481d62f313a13c8d610e707aafb168c90e'),
('hon.guard_school_booking_type()',true,false,'search_path=pg_catalog, hon','15a94d96ce5192ae45d9b69f5a4ff1161701bdb2c4b75d3b9e40f0a10c8b30e8'),
('hon.guard_school_booking_type_booking()',true,false,'search_path=pg_catalog, hon','a40ee1d67f60ac9d94bd2019e702f17e61aae3e6809193919f0a2c7649b006b1'),
('hon.school_booking_type_utc(timestamp with time zone)',false,false,'search_path=pg_catalog','ee207cea42ebf3e328b051bda6eae4cb6b246e589d7fe99e6e0da208f148377d'),
('hon.school_booking_type_taken(uuid,timestamp with time zone)',true,false,'search_path=pg_catalog, hon','1b22d9be44c388792205ec2f4c60b777cd6a96c8ff057cfe246c80ffdf107ecd'),
('hon.school_booking_type_times(hon.school_booking_types,text,integer)',true,false,'search_path=pg_catalog, hon','92d769ba9ef67fb5f2b727ac1c441076c4ec9780fdd4b4462ef497ec9487c471'),
('hon.school_booking_type_time_ok(hon.school_booking_types,text,timestamp with time zone)',true,false,'search_path=pg_catalog, hon','b1c5bdf12b059e7dd675a9fa9a01860eb046adfe7652edd3c0af46b0f8e9c505'),
('hon.school_booking_type_json(hon.school_booking_types)',true,false,'search_path=pg_catalog, hon','631cac50109ccca513e97cd339dac22fe1ddb05f8f7d180f1336b90dec2897f5'),
('hon.school_booking_type_booking_json(hon.school_booking_type_bookings)',true,false,'search_path=pg_catalog, hon','36ea3927ac1f750830aabe316270f45f7abcca18fdcadfccce140a0d0e46a318'),
('hon.school_booking_type_input(jsonb)',false,false,'search_path=pg_catalog, hon','a1895d42966ddf39845a87f62afe675226ee014bb87c9847d63c6e27017230b1'),
('hon.school_booking_type_command_finish(text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',true,false,'search_path=pg_catalog, hon','963bd4d5683dfb0034c9d9ac1e4dc85360d1f8b1d3e6813f1091e953508c8249'),
('hon.save_school_booking_type(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','0257aa0164d3f928f9a7d210aed57c8b7209c7b5f007e95de13ec93f84de7c52'),
('hon.set_school_booking_type_status(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','e1c48d3f8c7be64d7411761ec6a0423eed8bc6d97075962930fffb255f0fba4a'),
('hon.set_school_booking_type_booking_status(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','3cac890784545b0a15070ecdc337c4ad300007c30b705e6013c812736376e5bb'),
('hon.read_school_booking_types(text)',true,true,'search_path=pg_catalog, hon','22965831c550b3532fd87805d8c7cc2edcf24845f800949d59eeaeb20f8acd4e'),
('hon.read_school_booking_type(text,uuid)',true,true,'search_path=pg_catalog, hon','27b3d4290eae5edb032ed7cf666203e51a64bf51c29e68f1b2bfb0125de9cd60'),
('hon.take_school_booking_type_rate(uuid,text,integer)',true,false,'search_path=pg_catalog, hon','d479fe0eb90801226320d450325c4696f86813da7a761ad42c9849dae857217a'),
('hon.public_school_booking_type(text)',true,false,'search_path=pg_catalog, hon','987bb22bcbb535ba7247d91f3458ae0616f42a97e991eb1a82cba2cc509eedf6'),
('hon.read_public_school_booking_type(text)',true,true,'search_path=pg_catalog, hon','2e3694f46c07519104fe9cfcf2d1979e1e139a51202a3a6f37287c5646adb1fb'),
('hon.school_booking_type_booking_input(hon.school_booking_types,jsonb)',false,false,'search_path=pg_catalog, hon','32942ec9fcbf16a1ce973e3b983f4b1723197b9c7c1e5988b6eccb19f5a7bb1c'),
('hon.book_public_school_booking_type(text,jsonb,text)',true,true,'search_path=pg_catalog, hon','540e84332911f853dffe21523d1620f80bcb305778aa3d7afefae0a52879a364'),
('hon.cancel_public_school_booking_type_booking(text,jsonb)',true,true,'search_path=pg_catalog, hon','3425646e00b723373cc76a5a7883f5281456e2830d60d43fcf18b5512c1059ca')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school booking type function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End school booking types exact verification.

-- School reports exact verification (R1 0331): one runtime read, the private actor check and period builder.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.require_school_reports_actor(text)',true,false,'search_path=pg_catalog, hon','93e1e5004fe0c23ef85e7c419cba30670793b40bcc924096e5048669553dbfb6'),
('hon.school_report_periods(uuid,uuid,text,integer,timestamptz)',true,false,'search_path=pg_catalog, hon','7212d2355091511b853d743dce01ec2b5fb959fb5df043b4a28cff9478a8891b'),
('hon.read_school_reports(text,jsonb)',true,true,'search_path=pg_catalog, hon','6721f3af25235c837b0f50552777df73c3606d3898b826cb5b278f5a81d63e8a')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school reports function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End school reports exact verification.
-- Parent class booking exact verification (0329): private helpers and three runtime entry points.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.parent_class_booking_scope(text,boolean)',true,false,'search_path=pg_catalog, hon','cb18dc6356494af40a5b1af73147d4dd8d1bbafefab492439f51180e63fcac15'),
('hon.parent_class_booking_child_ok(uuid,uuid)',true,false,'search_path=pg_catalog, hon','237a329c4db7c485ffa5521d1a4028ed443de87e157873ac4e2b17fdc11110d7'),
-- 0607 replaced the body of hon.parent_class_booking_session_ok (classes on a closed day are not offered); its hash below is the 0607 body.
('hon.parent_class_booking_session_ok(uuid,hon.class_sessions)',true,false,'search_path=pg_catalog, hon','5e10f242e88a5bd527e19cfe7027388305257a36ee371ceca551832833cb948a'),
('hon.parent_class_booking_seats(uuid)',true,false,'search_path=pg_catalog, hon','61bfcc57c3e31a23b3a689150ead7d7d43c724db47483cbac8a3f74dcf2e3002'),
('hon.parent_class_booking_json(hon.class_bookings,hon.class_sessions)',true,false,'search_path=pg_catalog, hon','d753781cf05db78ddc2525f62e8ecf36aaa4b0a63432578c7155bed238c1ff37'),
('hon.parent_class_booking_begin(text,text,text)',true,false,'search_path=pg_catalog, hon','d66182b548222ae12d0d1cc3e027279005c55389277c37718c2476595384215a'),
('hon.parent_class_booking_finish(text,text,uuid,jsonb,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',true,false,'search_path=pg_catalog, hon','a9ddf831453529fd97154ae53e60eb65f1e023218b332008491e172d3a97e5e0'),
('hon.read_parent_class_booking_choices(text)',true,true,'search_path=pg_catalog, hon','edd9ec2e0d2c427c5ab4ea2e44be2d7c7b42fc702ec897b6d96187a7459318d4'),
('hon.book_parent_class_session(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','3370b119da07e09107e79c289f816b6e5a89313503f71cdfefefb8e8b8f7a70e'),
('hon.cancel_parent_class_booking(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','3ba7638f326952cc3589d28740abc64d8d45faf4f5527f667319e08bc6f88aee')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe parent class booking function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End parent class booking exact verification.
-- School Twilio subaccounts exact verification (T1 0351): a private forced-RLS table the runtime cannot touch and five
-- worker-only definer functions the runtime cannot run.
DO $$ DECLARE f text; BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.school_twilio_accounts'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR has_table_privilege('hon_runtime','hon.school_twilio_accounts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'Unsafe school Twilio subaccount table posture'; END IF;
  FOREACH f IN ARRAY ARRAY['hon.begin_school_twilio_account(uuid,integer)','hon.complete_school_twilio_account(uuid,uuid,text,text,text)',
    'hon.read_twilio_webhook_account(text)','hon.read_twilio_send_account(uuid,text)','hon.twilio_number_in_account(text,text)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND (owner.rolsuper OR owner.rolbypassrls))
      OR has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE') THEN
      RAISE EXCEPTION 'Unsafe school Twilio subaccount function: %',f; END IF;
  END LOOP;
END $$;
-- End school Twilio subaccounts exact verification.
-- School number orders exact verification (T2 0352): private forced-RLS table, six runtime entry points, worker-only
-- claim/record and private helpers.
DO $$ DECLARE f record; BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.school_number_orders'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR has_table_privilege('hon_runtime','hon.school_number_orders','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'Unsafe school number order table posture'; END IF;
  FOR f IN SELECT * FROM (VALUES
    ('hon.authorize_school_number_search(text)',true),('hon.request_school_number(text,jsonb,text)',true),
    ('hon.cancel_school_number_order(text,uuid,integer)',true),('hon.read_school_number_orders(text)',true),
    ('hon.decide_school_number_order_from_hq(text,uuid,text,text,integer)',true),('hon.read_hq_school_number_orders(text,text)',true),
    ('hon.require_school_sender_manager(text)',false),('hon.claim_school_number_purchases(integer,integer)',false),
    ('hon.record_school_number_purchase(uuid,uuid,text,text,text,text,text)',false),
    ('hon.guard_school_number_order()',false),('hon.guard_school_twilio_account()',false)) e(signature,runtime_allowed) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND (owner.rolsuper OR owner.rolbypassrls))
      OR has_function_privilege('hon_runtime',f.signature::regprocedure,'EXECUTE') IS DISTINCT FROM f.runtime_allowed THEN
      RAISE EXCEPTION 'Unsafe school number order function: %',f.signature; END IF;
  END LOOP;
  -- Both tables keep their guard triggers (no delete, no truncate, forward-only status, fixed school and SID).
  IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='O' AND t.tgname IN ('guarded','no_truncate')
      AND t.tgrelid IN ('hon.school_number_orders'::regclass,'hon.school_twilio_accounts'::regclass)) <> 4 THEN
    RAISE EXCEPTION 'Unsafe school number order table posture'; END IF;
END $$;
-- End school number orders exact verification.
-- School number order settle exact verification (T2c 0358): the HQ-owner settle entry point is a trusted definer the
-- runtime may call; the settle columns are covered by the forced-RLS table posture above.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
      WHERE p.oid='hon.settle_school_number_order_from_hq(text,uuid,text,text,integer)'::regprocedure AND p.prosecdef
      AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND (owner.rolsuper OR owner.rolbypassrls))
    OR NOT has_function_privilege('hon_runtime','hon.settle_school_number_order_from_hq(text,uuid,text,text,integer)','EXECUTE')
    OR has_function_privilege('hon_runtime','hon.guard_school_number_order()','EXECUTE')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='school_number_orders_settled' AND conrelid='hon.school_number_orders'::regclass) THEN
    RAISE EXCEPTION 'Unsafe school number order settle posture'; END IF;
END $$;
-- End school number order settle exact verification.
-- School A2P registrations exact verification (T3a 0553): private forced-RLS table with its guard triggers, five runtime
-- entry points, worker-only claim/record, a private owner check, and the 0248 HQ setter still a runtime definer.
DO $$ DECLARE f record; BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.school_a2p_registrations'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR has_table_privilege('hon_runtime','hon.school_a2p_registrations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='O' AND t.tgname IN ('guarded','no_truncate')
      AND t.tgrelid='hon.school_a2p_registrations'::regclass) <> 2
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='school_a2p_registrations_approved' AND conrelid='hon.school_a2p_registrations'::regclass) THEN
    RAISE EXCEPTION 'Unsafe school A2P registration table posture'; END IF;
  FOR f IN SELECT * FROM (VALUES
    ('hon.request_school_a2p_registration(text,jsonb,text)',true),('hon.cancel_school_a2p_registration(text,uuid,integer)',true),
    ('hon.read_school_a2p_registrations(text)',true),('hon.decide_school_a2p_registration_from_hq(text,uuid,text,text,integer)',true),
    ('hon.read_hq_school_a2p_registrations(text,text)',true),('hon.set_school_text_sender_from_hq(text,uuid,text,text,text,boolean,integer)',true),
    ('hon.require_school_a2p_owner(text)',false),('hon.claim_school_a2p_registrations(integer,integer)',false),
    ('hon.record_school_a2p_progress(uuid,uuid,text,jsonb,text,integer)',false),('hon.guard_school_a2p_registration()',false)) e(signature,runtime_allowed) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND (owner.rolsuper OR owner.rolbypassrls))
      OR has_function_privilege('hon_runtime',f.signature::regprocedure,'EXECUTE') IS DISTINCT FROM f.runtime_allowed THEN
      RAISE EXCEPTION 'Unsafe school A2P registration function: %',f.signature; END IF;
  END LOOP;
  IF has_function_privilege('hon_runtime','hon.school_a2p_business(jsonb)','EXECUTE')
    OR has_function_privilege('hon_runtime','hon.school_a2p_registration_json(hon.school_a2p_registrations)','EXECUTE') THEN
    RAISE EXCEPTION 'School A2P registration helper runnable by runtime'; END IF;
END $$;
-- End school A2P registrations exact verification.
-- Creative provider jobs exact verification (C1 0354): four private forced-RLS tables the runtime cannot touch, five
-- runtime entry points (plus the 0216 record wrapper above), worker functions and private helpers not runnable by it.
DO $$ DECLARE t text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['creative_provider_daily_limits','creative_school_daily_caps','creative_limit_commands','creative_provider_jobs'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'Unsafe creative provider job table posture: %',t; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.begin_creative_provider_submission(text,uuid)','hon.record_creative_provider_submission(text,uuid,text)',
    'hon.command_creative_provider_daily_limit(text,jsonb,uuid)','hon.command_creative_school_daily_caps(text,jsonb,uuid)','hon.read_creative_limits_from_hq(text)',
    'hon.claim_creative_provider_jobs(integer,integer)','hon.record_creative_provider_job_poll(uuid,uuid)','hon.record_creative_provider_job_result(uuid,uuid,jsonb)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND (owner.rolsuper OR owner.rolbypassrls)) THEN
      RAISE EXCEPTION 'Unsafe creative provider job function: %',f; END IF;
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE') <> (f NOT LIKE 'hon.claim_creative%' AND f NOT LIKE 'hon.record_creative_provider_job_%') THEN
      RAISE EXCEPTION 'Wrong runtime EXECUTE on creative provider job function: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.creative_record_generation_result(text,uuid,jsonb,text)','hon.creative_requester_subject(uuid)',
    'hon.creative_close_provider_job(hon.creative_provider_jobs,jsonb,text)','hon.creative_leased_job(uuid,uuid)','hon.creative_provider_committed_micros(text,timestamptz)'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE') THEN RAISE EXCEPTION 'Creative provider job helper runnable by runtime: %',f; END IF;
  END LOOP;
END $$;
-- End creative provider jobs exact verification.

-- School reports locations exact verification (R2 0332): one runtime read and the private per-location check.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.school_reports_location_allowed(uuid,uuid,uuid)',true,false,'search_path=pg_catalog, hon','09ea5075a1e424962a80a8075be4e3d318a929867bab5ba534effdfad6491710'),
('hon.read_school_reports_locations(text,jsonb)',true,true,'search_path=pg_catalog, hon','a7e4713c7c9ace670344f20125c0c6ae845feb274dfaf505e0ffc1a7c6d0ad74')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school reports locations function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End school reports locations exact verification.

-- School reports dashboard exact verification (R3 0520): one runtime read and three private helpers.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.school_dashboard_members(uuid,uuid)',true,false,'search_path=pg_catalog, hon','128ad76ba2cc03f7f668ea88048f1196838ff26d96ff61e88ffb036c28839977'),
('hon.school_dashboard_income(uuid,uuid,text,timestamp with time zone,timestamp with time zone)',true,false,'search_path=pg_catalog, hon','97e9aaf00e48d6ee39041ac4a4e02cf82a5b9b60bcb6fdd9340164a5b3dd7fc0'),
('hon.school_dashboard_kpis(uuid,uuid,text,timestamp with time zone,timestamp with time zone)',true,false,'search_path=pg_catalog, hon','3f83288d46756613d7bf35ac981780ab360e384592261dc944c2cb7e3e0ede73'),
('hon.read_school_reports_dashboard(text,jsonb)',true,true,'search_path=pg_catalog, hon','3176cb4114cd70d547242cba063d2dbd140d45cf716dfae2b735dc4d06a3d503')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config] AND p.provolatile='s'
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school reports dashboard function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End school reports dashboard exact verification.

-- School contacts list exact verification (C1 0521): one runtime read and two private helpers.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.require_school_contacts_actor(text)',true,false,'search_path=pg_catalog, hon','da51077efd0d9cf23610403472c6551e6f51d935b672b762b633974e5a300be0'),
('hon.school_contact_facts(uuid,uuid,timestamp with time zone)',true,false,'search_path=pg_catalog, hon','f481befbcea6c9e50078c3e0cddd8d26561814a339a7a8617152c109f0cd48dd'),
('hon.read_school_contact_list(text,jsonb)',true,true,'search_path=pg_catalog, hon','931e224a24fe99c033ef083a6046647d2f90b333957dfa81e9e20f52d0a354fe')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config] AND p.provolatile='s'
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school contacts list function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End school contacts list exact verification.

-- School contact card exact verification (C2 0522): one runtime read and two private helpers.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.school_contact_card_can(uuid,uuid,uuid,text)',true,false,'search_path=pg_catalog, hon','51833fe5d339195ff9309001d6a460bd2070d6fcebe8a1d8bc6f5c26c6aba616'),
('hon.school_contact_card_time(timestamp with time zone)',true,false,'search_path=pg_catalog, hon','e4a86c6f3c7e0d57791518a05be7b1552ebb4b274f34c42dc0e8b86bf6a93d46'),
('hon.read_school_contact_card(text,jsonb)',true,true,'search_path=pg_catalog, hon','66be110863b1387e2892614f418047c50413d1939554495ec92dc117f56439a3')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config] AND p.provolatile='s'
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school contact card function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End school contact card exact verification.

-- School contact merge and archive exact verification (C3 0523): five runtime entry points, private helpers, a private table.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.guard_school_contact_archive()',false,false,'search_path=pg_catalog, hon','v','d34a1772d3f162a2f59a512845bb16e4342714ca299f24641eef51bad73535e8'),
('hon.require_school_contact_admin(text,text)',true,false,'search_path=pg_catalog, hon','v','80eb68f4b9b30e831ef80b99addf6d722a3ed032ff4f87635f9b2f15a3e52af0'),
('hon.school_contact_admin_begin(uuid,text,text)',true,false,'search_path=pg_catalog, hon','v','ab1a5d9b6f613a0882b3d242846da5cbaa3f5c5487410b76e0969d02494762d6'),
('hon.school_contact_archive_plan(uuid,uuid,uuid)',true,false,'search_path=pg_catalog, hon','s','be7c9a3e0cf0b99511fe49612d6e2a6423ab7af175db26c2cd327fd88e57b27d'),
('hon.school_contact_merge_plan(uuid,uuid,uuid,uuid)',true,false,'search_path=pg_catalog, hon','s','138d72cc623f45f64ae4f2471507cb2e2e6f502b2e95aaf2155fed3f7b899844'),
('hon.school_contact_admin_person(uuid,uuid,uuid)',true,false,'search_path=pg_catalog, hon','s','ddf78a33ee8f8d7771b6c60fbaef4535d3f296f28a93dec6aef684c44e6f2cbe'),
('hon.read_school_contact_archive(text,jsonb)',true,true,'search_path=pg_catalog, hon','v','e76ccda135666363f12bfd010bdcb61c13b7652f5a9c1980b649526bdbecd0af'),
('hon.school_contact_archive_command(text,jsonb,text,uuid,uuid,boolean)',true,false,'search_path=pg_catalog, hon','v','43eb4068f3d0813ea045f60b38fe642ffbc3925c2dad921204dad94fdfd7c542'),
('hon.archive_school_contact(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','v','c723295a67b8cfa6741d94efeb228b3158990f15b6fa84c167cf2e5496f4f13b'),
('hon.restore_school_contact(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','v','8cfaeaf075de3d326f3d96bce295d7f0dc4ef61b30a922df631d194e1d464d96'),
('hon.read_school_contact_merge(text,jsonb)',true,true,'search_path=pg_catalog, hon','v','37f31569cf3f1b6656e0c8cb55645549b8b4f410bcfd23412099f1cafbb363ad'),
('hon.merge_school_contacts(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','v','7639e2fa71a7b496c14b83959c221d31f0fb2cae5cbefbafc0f5b531c21909fb')) e(signature,definer,runtime_allowed,config,volatility,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config] AND p.provolatile=f.volatility
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school contact merge/archive function: %',f.signature; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') AND (has_table_privilege('hon_runtime','hon.school_contact_archives','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='hon.school_contact_archives'::regclass)) THEN
    RAISE EXCEPTION 'hon.school_contact_archives must stay private with forced RLS'; END IF;
END $$;
-- End school contact merge and archive exact verification.

-- New membership and renew from the contact card exact verification (M-B 0624): two runtime entry points, private helpers, a private table.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.guard_person_membership_start()',false,false,'search_path=pg_catalog, hon','v','778a1f0da886a102416515b7fddaf20f1fbd4442450a7bd598cfbc393f1d0a14'),
('hon.membership_program_group(uuid)',true,false,'search_path=pg_catalog, hon','s','22bc641d28bcd4afaa522d080918b158ed1f2bc89eeae4a547a4279c0f3060f2'),
('hon.guard_person_membership_overlap()',false,false,'search_path=pg_catalog, hon','v','60249362e907a9e11fa91ebd837d3d1f8d86470b4414e7acd3e8a6ceec314457'),
('hon.require_person_membership_actor(text)',true,false,'search_path=pg_catalog, hon','v','1967748144cd348d56dc95abc5f0240c7ab1fba2c18ad6a051d544741751aa21'),
('hon.person_membership_start_facts(uuid,date)',true,false,'search_path=pg_catalog, hon','s','4a9e7833b68b007062e11c5afe1d203faa2cfd970ad776fe756307c1415e5666'),
('hon.person_membership_start_item(hon.memberships,text)',true,false,'search_path=pg_catalog, hon','s','c5750ccc97cf64271794abc290420a20a106381674882c491f00ece2f722af4b'),
('hon.read_person_membership_start(text,jsonb)',true,true,'search_path=pg_catalog, hon','v','5e159c6728b25979dbe9a1360d7c335cb11c3a61a90da227a258bb552bba31b4'),
('hon.start_person_membership(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','v','67a9828cb5d1969af3b55c746ec976ce95a6143251724031ea5a7c2c3a692195')) e(signature,definer,runtime_allowed,config,volatility,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config] AND p.provolatile=f.volatility
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe card membership start function: %',f.signature; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') AND (has_table_privilege('hon_runtime','hon.person_membership_starts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='hon.person_membership_starts'::regclass)) THEN
    RAISE EXCEPTION 'hon.person_membership_starts must stay private with forced RLS'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.memberships'::regclass AND tgname='memberships_one_per_program'
      AND tgfoid='hon.guard_person_membership_overlap()'::regprocedure AND tgtype=21 AND tgenabled='O' AND NOT tgisinternal)
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.person_membership_starts'::regclass AND NOT tgisinternal
      AND tgfoid='hon.guard_person_membership_start()'::regprocedure AND tgenabled='O')<>2 THEN
    RAISE EXCEPTION 'Missing card membership start guard triggers'; END IF;
END $$;
-- End new membership and renew from the contact card exact verification.

-- Family messages exact verification (0330): private helpers, private forced-RLS tables and six runtime entry points.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.family_message_body_ok(text)',false,false,'search_path=pg_catalog','911c8020274ce0bad19829ea68cafc456c16dd76f61ef1fbe827e68611e0b146'),
('hon.guard_family_message_thread()',false,false,'search_path=pg_catalog, hon','f42f869cc31028aaec75d17a4b321b35b18fbbcffa6b3d5d2e063f7199b5a2eb'),
('hon.family_message_parent_scope(text,boolean)',true,false,'search_path=pg_catalog, hon','934532bf7f7ae9807bbc7692110f31a3aa0f3359250a578897d95f308e6c6c35'),
('hon.require_family_messages_actor(text)',true,false,'search_path=pg_catalog, hon','1bdbf05c83d5044897fa2d74193938ab17c7d839dfbaf970358a9ccd5330b0a1'),
('hon.family_message_time(timestamp with time zone)',false,false,'search_path=pg_catalog','e4a86c6f3c7e0d57791518a05be7b1552ebb4b274f34c42dc0e8b86bf6a93d46'),
('hon.family_message_json(hon.family_messages,uuid)',true,false,'search_path=pg_catalog, hon','baf138c7b630fcb89c0ec813fb95510288fbcf44700df03774940fd2477f0a74'),
('hon.family_message_list(uuid,uuid)',true,false,'search_path=pg_catalog, hon','c37b4dea088a25f7a72fdffcbacaf890e3080d9d655120dae7d889888135614f'),
('hon.family_message_unread(hon.family_message_threads)',true,false,'search_path=pg_catalog, hon','6b2760aeceef08a8cf14010c232d91a3af41e181dfc5c48faa438fab7b6cea81'),
('hon.family_message_read_through(hon.family_message_threads,uuid)',true,false,'search_path=pg_catalog, hon','7c6743a71b1c4f248ff2ef17dbf48622d898689eb7b5027e3512c6bd91ba56c9'),
('hon.family_message_begin(uuid,text,text)',true,false,'search_path=pg_catalog, hon','ab1a5d9b6f613a0882b3d242846da5cbaa3f5c5487410b76e0969d02494762d6'),
('hon.family_message_append(hon.family_message_threads,uuid,text,text,text,uuid,uuid)',true,false,'search_path=pg_catalog, hon','3f1ef77db5d298e350ab36c269f6c614450cac712368eb0f9111db2a4591a57b'),
('hon.read_parent_family_messages(text)',true,true,'search_path=pg_catalog, hon','1def9f2bc2adac08074493044c5212e4def48eaf4989a224878e0f2d202813e0'),
('hon.send_parent_family_message(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','c55c87326a967de7c244a98197ac0c01c268be3d93e69a6c3d085625054f1f04'),
('hon.read_family_message_inbox(text)',true,true,'search_path=pg_catalog, hon','bf49605bc28739c2b9fad8e9272d7de8a89726e059efd9a79cdd7442755fadc3'),
('hon.read_family_message_thread(text,uuid)',true,true,'search_path=pg_catalog, hon','2a3e50dfdfd9e083baec07b7415b69d4d608b42dcd2423b3b0f62795aa594bcb'),
('hon.mark_family_message_thread_read(text,jsonb,uuid,uuid)',true,true,'search_path=pg_catalog, hon','4a8709f673dad310ca48205c89698a47a3ede41ca75a4a8765919fb9b0599ac6'),
('hon.reply_family_message(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','1cae3e247d7ccfa1b72b47e4aa2948a8d99f024bd78619023fd4e12343f72db7')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe family message function: %',f.signature; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['family_message_threads','family_messages'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe family message table: %',t;
    END IF;
  END LOOP;
END $$;
-- End family messages exact verification.

-- School conversations exact verification (0364): private helpers, two private forced-RLS tables, seven staff runtime entry
-- points; the inbound intake is runnable only by hon_communication_worker (013), never by the runtime.
DO $$ DECLARE f record; safe boolean; t text; worker_oid oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_communication_worker'); BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.conversation_body_ok(text)',false,false,false,'search_path=pg_catalog','53dfa913f9ff8f68060d53a6b2b66a2c0831568e388ca92e60742f22b590162e'),
('hon.conversation_tags_ok(text[])',false,false,false,'search_path=pg_catalog','dec73cf1312918d4c380e47fd3ee49e210bf95163c664d1d739e5b35d14071c7'),
('hon.guard_school_conversation()',false,false,false,'search_path=pg_catalog, hon','d04f47eb34a9b0867950d7569acc9bb7389371a9906700e0adddd0dd4866a501'),
('hon.conversation_staff_has(uuid,uuid,uuid,text)',true,false,false,'search_path=pg_catalog, hon','099455284fb85ee72eba82d4feff10cc21fa8d9c47517101ac8c89a285801102'),
('hon.require_conversation_actor(text,boolean)',true,false,false,'search_path=pg_catalog, hon','edae19e955bee3b56686346f1da36671937638e54b9d5e26ba6475cebbe829d9'),
('hon.conversation_time(timestamp with time zone)',false,false,false,'search_path=pg_catalog','e4a86c6f3c7e0d57791518a05be7b1552ebb4b274f34c42dc0e8b86bf6a93d46'),
('hon.conversation_row_json(hon.school_conversations)',true,false,false,'search_path=pg_catalog, hon','c5f308674824deb7c11243a12a618768aea35d2e3306aebbc774461e3032e73a'),
('hon.conversation_message_json(hon.school_conversation_messages)',true,false,false,'search_path=pg_catalog, hon','a20b62d3e23323bbc459db8f02084618e2e620cd4df3f4cf7cd249c0e79b9881'),
('hon.conversation_contact_json(hon.school_conversations)',true,false,false,'search_path=pg_catalog, hon','ad40a3bbdd7fa13c368753de22ae909ef2a9af15c689459400adeacf42705429'),
('hon.conversation_command_begin(uuid,text,text)',true,false,false,'search_path=pg_catalog, hon','ab1a5d9b6f613a0882b3d242846da5cbaa3f5c5487410b76e0969d02494762d6'),
('hon.conversation_command_finish(uuid,text,hon.school_conversations,text,jsonb,jsonb,text,jsonb,uuid,uuid)',true,false,false,'search_path=pg_catalog, hon','282f93a23aee60b82021287a1e749c262feb4be4b64f62e20dd7b73657cb1060'),
('hon.conversation_lock(uuid,integer)',true,false,false,'search_path=pg_catalog, hon','5ce2e4cbe2ea3b846812129706723a12869189503758c7f3753238d61cdc9f91'),
('hon.conversation_input_ok(jsonb,text[],text[])',false,false,false,'search_path=pg_catalog','40ee2f41174c7ac30097f1bf4998f9b74d3665fbd14c0a1de0aa559132d84161'),
('hon.conversation_uuid_ok(jsonb)',false,false,false,'search_path=pg_catalog','f1a9de559daef6acb8f68bedde192f716654ecc0d8401c3c95da92c4fe26cc9f'),
('hon.record_inbound_conversation_text(text,text,text,integer,text,timestamp with time zone)',true,false,true,'search_path=pg_catalog, hon','921f318c14478446e461d6bad2471004f2db30ba878f8bdd8358ec41b4e7765b'),
('hon.read_school_conversations(text,jsonb)',true,true,false,'search_path=pg_catalog, hon','d493be27bcfd5509b0bcd083f2a44878c02ccd69820cfefe777ea61c70002bb3'),
('hon.read_school_conversation(text,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','19d0090964fc107f4f20aa7d7ac80bf3b7635c4d8be1d839b25ec6a193875501'),
('hon.reply_school_conversation(text,jsonb,text,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','b54d6237a05a1cfc800508d54c7ff43d36933a51da533877b8d6b962a25d5c40'),
('hon.update_school_conversation(text,jsonb,text,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','f197b90014fd5eb9037473da92ca7eae2b651107b0133b05612030e4e3d28117'),
('hon.mark_school_conversation_read(text,jsonb,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','404969e8ff05628486e02f3115ed22a562a5e605c8b9e021af5067be97f32d44'),
('hon.link_school_conversation(text,jsonb,text,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','0118b5cc31a599a80cb9e08fa49489089cb5d0ab2b5dec0b2152e6559e730603'),
('hon.create_school_conversation_lead(text,jsonb,text,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','7f250d1096a83eb0c2da67066403b07ec031f341ae4d9ab490709381a6e93b74')) e(signature,definer,runtime_allowed,worker_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.is_grantable OR a.privilege_type<>'EXECUTE'
          OR NOT ((a.grantee=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') AND f.runtime_allowed)
            OR (a.grantee IS NOT DISTINCT FROM worker_oid AND f.worker_allowed))))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school conversation function: %',f.signature; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['school_conversations','school_conversation_messages'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe school conversation table: %',t;
    END IF;
  END LOOP;
END $$;
-- End school conversations exact verification.
-- Paper import exact verification (0388)
DO $$ DECLARE f text; t text;
  entry text[]:=ARRAY['hon.create_paper_import(text,jsonb,text,uuid,uuid)','hon.add_paper_import_page(text,uuid,jsonb,text,uuid,uuid)',
    'hon.begin_paper_reading(text,uuid,jsonb,uuid,uuid)','hon.record_paper_reading(text,uuid,jsonb,uuid,uuid)',
    'hon.save_paper_import_table(text,uuid,jsonb,text,uuid,uuid)','hon.send_paper_import(text,uuid,jsonb,text,uuid,uuid)',
    'hon.delete_paper_import(text,uuid,jsonb,text,uuid,uuid)','hon.read_paper_imports(text)','hon.read_paper_import(text,uuid)',
    'hon.read_paper_import_page(text,uuid,integer)'];
  helpers text[]:=ARRAY['hon.guard_paper_import()','hon.paper_import_columns(text)','hon.paper_import_cell_ok(jsonb)',
    'hon.paper_import_table_ok(text,jsonb,jsonb)','hon.paper_import_image_clean(text,bytea)','hon.paper_import_summary(hon.paper_import_sets)',
    'hon.paper_import_detail(hon.paper_import_sets)','hon.paper_import_erase(uuid,text,uuid)','hon.paper_import_purge_school(uuid,uuid)',
    'hon.purge_expired_paper_imports()','hon.paper_import_begin(text,text,jsonb,text,uuid,uuid)','hon.require_paper_import_actor(text)',
    'hon.paper_import_finish(text,uuid,text,uuid,text,uuid,uuid,jsonb)','hon.paper_import_lock(uuid,jsonb)','hon.paper_import_csv_field(text)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe paper import entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe paper import helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['paper_import_sets','paper_import_pages','paper_import_requests'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe paper import table: %',t;
    END IF;
  END LOOP;
END $$;
-- End paper import exact verification.
-- Contact photo exact verification (0390)
DO $$ DECLARE f text; t text;
  entry text[]:=ARRAY['hon.read_person_photo(text,uuid,uuid)','hon.set_person_photo(text,jsonb,uuid)','hon.remove_person_photo(text,jsonb,uuid)'];
  helpers text[]:=ARRAY['hon.guard_person_photo()','hon.person_photo_summary(hon.person_photos)','hon.person_photo_begin(text,text,jsonb,uuid)',
    'hon.person_photo_finish(text,uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb,jsonb)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe contact photo entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe contact photo helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['person_photos','person_photo_requests'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe contact photo table: %',t;
    END IF;
  END LOOP;
END $$;
-- End contact photo exact verification.
-- School location exact verification (0392)
DO $$ DECLARE f text; t text;
  entry text[]:=ARRAY['hon.read_school_location(text)','hon.save_school_location(text,jsonb,text,uuid,uuid)',
    'hon.register_hon_os_school_with_location(text,text,jsonb,uuid)'];
  helpers text[]:=ARRAY['hon.guard_biometric_jurisdiction_data()','hon.school_location_region_ok(text,text)','hon.school_location_text_ok(jsonb,integer,boolean)',
    'hon.school_location_input_ok(jsonb)','hon.guard_school_location()','hon.biometric_locality(text)','hon.biometric_profile_for(text,text,text)',
    'hon.biometric_notice_json(text)','hon.school_location_json(hon.school_locations)','hon.school_location_view(hon.school_locations)',
    'hon.require_school_location_actor(text)','hon.school_location_write(uuid,uuid,uuid,jsonb,integer,text,uuid,uuid)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe school location entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe school location helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['school_locations','school_location_versions','biometric_jurisdiction_profiles','biometric_jurisdiction_rules'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe school location table: %',t;
    END IF;
  END LOOP;
END $$;
-- End school location exact verification.

-- School checkouts exact verification (B-TUI-2 0402): three private forced-RLS tables, the guards, private validators
-- and helpers, three runtime entry points and the permission.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.school_checkouts','hon.school_checkout_versions','hon.school_checkout_settings'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=t::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'School checkouts table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.checkout_int_ok(jsonb,bigint,bigint)',false,false,'search_path=pg_catalog','b60376389be8213423f78f85adc8194cb4e078f77ba88646934f78840511e504'),
('hon.checkout_fields_ok(jsonb)',false,false,'search_path=pg_catalog, hon','06f2d8a77242a42a61ff0972f8d221e50cca8ed93cf34be0815391daef17e769'),
('hon.checkout_option_ok(jsonb)',false,false,'search_path=pg_catalog, hon','d8d827fafd027d6942bfbdcb329d2acc8678388aecdbb1a85e685023d7838439'),
('hon.school_checkout_content_ok(jsonb)',false,false,'search_path=pg_catalog, hon','7242765ce3e618d1aa2e9a561be2c2316cd276adaa43c63e2be8d40f9b253957'),
('hon.school_checkout_groups_ok(jsonb)',false,false,'search_path=pg_catalog, hon','81ca19d07350af1c8c3ca4d209c70ad6a0e2ff945298e7a49f5f549a42955c66'),
('hon.school_checkout_default_groups()',false,false,'search_path=pg_catalog','9c59014bad6b190b53fcdc835255f7d8dfc1b6f9871fa8b54291646b9a03cdf4'),
('hon.guard_school_checkout()',false,false,'search_path=pg_catalog, hon','fefe8437e69c1b12024051864d826cf87c7c3a6f6647dc90b89e8343c7ea2c0e'),
('hon.school_checkout_json(hon.school_checkouts)',false,false,'search_path=pg_catalog, hon','b9278fd23ff56b533fd5af59d9323ca30a145cff6d0cad42380e0bdf33d3e995'),
('hon.school_checkout_settings_json(uuid,uuid)',false,false,'search_path=pg_catalog, hon','a5ff6ebae9fd5fe65797e68bb32dcad5ce646195b1e4c68515e89ba40836a95f'),
('hon.school_checkout_begin(text,text,jsonb,text)',false,false,'search_path=pg_catalog, hon','ada2403285fb29a1cd8eeaf628d0e283d86a861e90dca6bb8864f48d675d5ab0'),
('hon.school_checkout_finish(text,uuid,text,jsonb)',false,false,'search_path=pg_catalog, hon','9fe0f76d0c160ea4e92c9a1b8a971df8de6d1cd34ae4ef0996c81237e0ff4c21'),
('hon.read_school_checkouts(text)',true,true,'search_path=pg_catalog, hon','9d4269b690fbe64b2de0b5e6c6bc7cc692001b47a76ac1b4a4206357aaab4771'),
('hon.save_school_checkout(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','038935b36bf304c4ad4942468d0c420ecdaf04e288e93e3ce0ae8e6efe69a1da'),
('hon.save_school_checkout_settings(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','bfb98d55afd4801a4b7b807360c5991bee2f3ed0fa0bd23a9e98dab4bf0204a2')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school checkouts function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('school_checkouts','school_checkout_guard','hon.guard_school_checkout()'),
    ('school_checkouts','school_checkouts_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_checkout_settings','school_checkout_settings_guard','hon.guard_school_checkout()'),
    ('school_checkout_settings','school_checkout_settings_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_checkout_versions','school_checkout_versions_immutable','hon.guard_membership_activation_evidence()'),
    ('school_checkout_versions','school_checkout_versions_no_truncate','hon.guard_membership_activation_evidence()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing school checkouts guard: %',expected.name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='school_checkout.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'school_checkout.manage must exist as a sensitive staff-assignable permission'; END IF;
END $$;
-- End school checkouts exact verification.

-- Shopify Connected exact verification (0405)
DO $$ DECLARE f text; t text;
  entry text[]:=ARRAY['hon.read_shopify(text,uuid)','hon.read_shopify_catalog(text,uuid)','hon.read_shopify_orders(text,uuid)',
    'hon.start_shopify_connect(text,jsonb,text)','hon.claim_shopify_connect(text,jsonb)','hon.record_shopify_connection(text,jsonb)',
    'hon.begin_shopify_sync(text,jsonb)','hon.rotate_shopify_credential(text,jsonb)','hon.record_shopify_sync_page(text,jsonb)',
    'hon.finish_shopify_sync(text,jsonb)','hon.disconnect_shopify(text,jsonb)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe Shopify entry point: %',f; END IF;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND (p.proname LIKE 'shopify\_%' OR p.proname='guard_shopify') LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe Shopify helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['shopify_connections','shopify_credentials','shopify_connect_intents','shopify_syncs','shopify_products',
    'shopify_variants','shopify_orders','shopify_order_lines'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe Shopify table: %',t;
    END IF;
  END LOOP;
END $$;

-- Shopify background sync and webhooks exact verification (0449): the runtime reaches no new table or function; the
-- five worker functions are executable by hon_communication_worker only (when that login exists).
DO $$ DECLARE f text; t text; w oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_communication_worker');
  worker text[]:=ARRAY['hon.record_shopify_webhook(jsonb)','hon.claim_shopify_background_sync()','hon.rotate_shopify_background_credential(jsonb)',
    'hon.record_shopify_background_page(jsonb)','hon.finish_shopify_background_sync(jsonb)'];
BEGIN
  -- Exact bodies: a worker function or its lease check changed outside migrations is refused.
  FOR f,t IN SELECT * FROM (VALUES ('hon.record_shopify_webhook(jsonb)','9b84cd3885681f1b6543817686360178'),
      ('hon.claim_shopify_background_sync()','ee5655e217df75581d8158322fbebbdb'),('hon.rotate_shopify_background_credential(jsonb)','1adddb8980963336ffce32e7b5b1ff5e'),
      ('hon.record_shopify_background_page(jsonb)','d9650d9b91ba44f99483bc4cd5143e5b'),('hon.finish_shopify_background_sync(jsonb)','a4cc3fd3ac5218cb53bbfeac24ee4f54'),
      ('hon.shopify_leased_sync(jsonb,text[],boolean)','c48ec46f82d55eacc7f5ca74d55d02b8')) v LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM t THEN RAISE EXCEPTION 'Shopify worker function body drift: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY worker LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND NOT has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee IS DISTINCT FROM w))) THEN
      RAISE EXCEPTION 'Unsafe Shopify worker function: %',f; END IF;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND p.proname IN ('shopify_system_evidence','shopify_school_live','shopify_apply_page','shopify_leased_sync') LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe Shopify helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['shopify_sync_requests','shopify_webhook_receipts'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe Shopify table: %',t;
    END IF;
  END LOOP;
END $$;
-- End Shopify Connected exact verification.
-- Attendance card exact verification (0394)
DO $$ DECLARE f text; t text;
  entry text[]:=ARRAY['hon.read_attendance_cards(text)','hon.configure_attendance_cards(text,jsonb,text,uuid,uuid)','hon.issue_attendance_cards(text,jsonb,text,uuid,uuid)','hon.revoke_attendance_card(text,jsonb,text,uuid,uuid)','hon.check_in_with_attendance_card(text,uuid,jsonb,text,uuid,uuid)','hon.set_student_photo_consent(text,jsonb,text,uuid,uuid)'];
  helpers text[]:=ARRAY['hon.guard_attendance_card()','hon.attendance_cards_actor(text)','hon.attendance_card_settings_json(uuid,uuid)','hon.attendance_card_json(hon.attendance_cards)',
    'hon.attendance_card_begin(text,text,jsonb,text,uuid,uuid)','hon.attendance_card_finish(text,uuid,text,text,uuid,jsonb,text,uuid,uuid,jsonb)',
    'hon.attendance_check_in_student(text,uuid,uuid,text,uuid,text,text,uuid,uuid)','hon.attendance_photo_consent_rule(uuid,uuid)',
    'hon.attendance_photo_consent_state(boolean,hon.student_photo_consents)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe attendance card entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe attendance card helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['attendance_card_settings','attendance_cards','attendance_check_ins','attendance_card_requests','student_photo_consent_rules','student_photo_consents'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe attendance card table: %',t;
    END IF;
  END LOOP;
END $$;
-- End attendance card exact verification.
-- School staff pick list exact verification (0404)
DO $$ DECLARE f text:='hon.list_school_staff_for_picker(text,text)';
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
        AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
    RAISE EXCEPTION 'Unsafe staff pick list entry point: %',f; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM '837904469250ef98c81a64773a9e350f'
    OR (SELECT proconfig FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon'] THEN
    RAISE EXCEPTION 'Staff pick list body drift: %',f; END IF;
END $$;
-- End school staff pick list exact verification.
-- Staff qualification and role lists exact verification (0406)
DO $$ DECLARE f text; expected jsonb:='{"hon.list_instructor_qualifications(text,text,uuid)":"2b09093c624579f8a92b9da60b8689e7","hon.list_staff_roles(text)":"22f6493edb52503e3b8dd96a94ef76d7"}';
BEGIN
  FOR f IN SELECT jsonb_object_keys(expected) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe staff list entry point: %',f; END IF;
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM expected->>f
      OR (SELECT proconfig FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon'] THEN
      RAISE EXCEPTION 'Staff list body drift: %',f; END IF;
  END LOOP;
END $$;
-- End staff qualification and role lists exact verification.
-- Retention review member list exact verification (0407)
DO $$ DECLARE f text := 'hon.list_retention_review_members(text)';
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
        AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
    RAISE EXCEPTION 'Unsafe membership list entry point: %',f; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM '53d3658e70cc67c51eaeb9a76c8d0d0b'
    OR (SELECT proconfig FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon'] THEN
    RAISE EXCEPTION 'Membership list body drift: %',f; END IF;
END $$;
-- End retention review member list exact verification.
-- Staff assignable permissions list exact verification (0412)
DO $$ DECLARE f constant text:='hon.list_assignable_staff_permissions(text)'; expected constant text:='765e1c4afc6138d1f2394033308a77c8';
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
        AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
    RAISE EXCEPTION 'Unsafe staff permissions list entry point: %',f; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM expected
    OR (SELECT proconfig FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM ARRAY['search_path=pg_catalog, hon'] THEN
    RAISE EXCEPTION 'Staff permissions list body drift: %',f; END IF;
END $$;
-- End staff assignable permissions list exact verification.
-- Walk-in kiosk exact verification (0414)
DO $$ DECLARE f text; t text;
  entry text[]:=ARRAY['hon.save_walkin_kiosk_settings(text,jsonb,text,uuid,uuid)','hon.start_walkin_kiosk_device(text,jsonb,text,uuid,uuid)',
    'hon.end_walkin_kiosk_device(text,uuid,jsonb,text,uuid,uuid)','hon.set_walkin_visit_desk_paid(text,uuid,jsonb,text,uuid,uuid)',
    'hon.read_walkin_kiosk(text)','hon.read_walkin_kiosk_settings(text)','hon.read_walkin_visit(text,uuid)',
    'hon.read_walkin_kiosk_terminal(text)','hon.submit_walkin_visit(text,jsonb,text)'];
  helpers text[]:=ARRAY['hon.walkin_text_ok(jsonb,integer,integer,boolean)','hon.guard_walkin_kiosk()','hon.walkin_utc(timestamp with time zone)',
    'hon.walkin_principal_holds(uuid,uuid,uuid,text)','hon.require_walkin_actor(text,text)',
    'hon.walkin_command_begin(text,text,text,text)',
    'hon.walkin_command_finish(text,text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',
    'hon.walkin_settings_json(hon.walkin_kiosk_settings)','hon.walkin_device_json(hon.walkin_kiosk_devices)',
    'hon.walkin_visit_json(hon.walkin_visits)','hon.walkin_settings_input(jsonb)','hon.walkin_live_device(text)',
    'hon.take_walkin_kiosk_rate(uuid,text,integer)','hon.walkin_name_ok(jsonb)','hon.walkin_birth_date(jsonb,date)',
    'hon.walkin_visit_input(hon.walkin_kiosk_settings,jsonb,date)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe walk-in kiosk entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe walk-in kiosk helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['walkin_kiosk_settings','walkin_waiver_texts','walkin_kiosk_devices','walkin_visits','walkin_visit_participants','walkin_waiver_signatures','walkin_kiosk_rates'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe walk-in kiosk table: %',t;
    END IF;
  END LOOP;
END $$;
-- End walk-in kiosk exact verification.
-- Automation workflows and contact tags exact verification (AU-1 0416): five private forced-RLS tables the runtime cannot
-- touch, twelve runtime entry points, and private helpers, guards, the actor check and the engine-only contact_tag_apply.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.guard_automation_workflow_history()',true,false,'search_path=pg_catalog, hon','bd178753ff55c597469b68d05a5829e5101522af6b9cdc782f3d43c8a60ac54c'),
('hon.guard_automation_workflow()',true,false,'search_path=pg_catalog, hon','81fe707261e528747c73e0b957d93cfcc57d69d1fd86309e3d8160420c7bef98'),
('hon.require_automation_workflow_actor(text,text)',true,false,'search_path=pg_catalog, hon','5b84f3838699b1c5c60b9107459b7955bea0788658bd5b9e1da13655b274d844'),
('hon.automation_invalid(text)',false,false,'search_path=pg_catalog, hon','0f5d594cb0b1a5cd740550aa23bfbab0a61bf822f6bf380b824135a1a6acf5ef'),
('hon.automation_keys(jsonb,text[])',false,false,'search_path=pg_catalog, hon','7fc8f80386425cd60f870a68b094bd0cf9872a639cffe1d102a52c25e0ceed2e'),
('hon.automation_int(jsonb,integer,integer)',false,false,'search_path=pg_catalog, hon','764aedb78b2fed9116d90ad7dbc096dbde300580e5b95c6e1f128503dbc83a45'),
('hon.automation_uuid(jsonb)',false,false,'search_path=pg_catalog, hon','7a661b3976739abb58c7969252328431a554fd9e9ebcb0f7672d3f7f346df3ba'),
('hon.automation_enum(jsonb,text[])',false,false,'search_path=pg_catalog, hon','891c8038d1a890a45222528aafa9856eaa76b7c825d3fd5084d6f1bb74844e43'),
('hon.automation_text(jsonb,integer,integer,boolean)',false,false,'search_path=pg_catalog, hon','cbb4cb9e2349fdc7c2422033afc0d1a77f273f2d409c0691629e8827742ac3a1'),
('hon.automation_tag_ok(jsonb)',false,false,'search_path=pg_catalog, hon','985cf4e1bef08e166e5ba39d7e8fc3039b29d4c0e2e329f2fd71254d494171ed'),
('hon.automation_tool_key_ok(jsonb)',false,false,'search_path=pg_catalog, hon','4f50dcf44e8b3cdb72c7d7646682ef4341834c0b197e992d4634dadf1d899191'),
('hon.automation_local_time(jsonb)',false,false,'search_path=pg_catalog, hon','bdff9a57b7b35c3e473d96a5d07794441a3d8f268c29148bfe549c138aa46c0a'),
('hon.automation_date(jsonb)',false,false,'search_path=pg_catalog, hon','2d19fde6d49d843494dc435c9e997868a340fcf2f3a2dc800df53c9b0a195711'),
('hon.automation_list(jsonb,integer,integer,text,text[])',false,false,'search_path=pg_catalog, hon','b849daf47d93c984a9a9f435d708c56e842db0ecbb63d00fdc9dd078bcf98585'),
('hon.automation_condition_ok(jsonb)',false,false,'search_path=pg_catalog, hon','eed03275166b416035957830f59432e09e9bcc87d0be47dece7f05c3e633d1a7'),
('hon.automation_trigger_ok(jsonb)',false,false,'search_path=pg_catalog, hon','e24930c467c84a3d9f86b55e11e7c65ed3d302df9d76e9d9a5fb3e2771eac7e8'),
('hon.automation_content_ok(jsonb,boolean)',false,false,'search_path=pg_catalog, hon','2c6f8abc08c73d81293577aecb30b681d721cc51b85b423028c525ac25b4200e'),
('hon.automation_step_edges(jsonb)',false,false,'search_path=pg_catalog, hon','6176fc7b319072743308e16c750e597a27f6f4c3725393593a88153977702beb'),
('hon.validate_automation_definition(jsonb)',false,false,'search_path=pg_catalog, hon','f55a4b450d85642b5515d5170bcd5e54649924ce1c5d2113a96587e81faf9898'),
('hon.automation_name(jsonb)',false,false,'search_path=pg_catalog, hon','679b7fdace95f156667ebb956cdac2be8eff3aafac92dae9424ae823fa4158bc'),
('hon.automation_check_call(text,uuid,uuid)',false,false,'search_path=pg_catalog, hon','512ab78b8f7d2e20aca3df3cb87164a4fc51a65891f129005440e313765f99ac'),
('hon.automation_claim(uuid,uuid,uuid,text,text,text)',false,false,'search_path=pg_catalog, hon','f845c81992070380c473f0d785e5bbff0ec3f9a6c03157d3eb88e3aa4c9cd333'),
('hon.automation_finish(uuid,uuid,uuid,text,jsonb)',false,false,'search_path=pg_catalog, hon','34dc06af5237a961fb6c53ae6a24441e606dd6a7f263267bc99d6c853ad23738'),
('hon.automation_fp(text,text)',false,false,'search_path=pg_catalog, hon','96f163c8373d89eb9643ddab2a1bb03013522192a926ec29483c1deec61e3057'),
('hon.automation_workflow_json(hon.automation_workflows)',false,false,'search_path=pg_catalog, hon','eee1fb610b04223cc5ea724c8db901042f459fb6235617f80253e46081e7f312'),
('hon.automation_version_json(hon.automation_workflow_versions)',false,false,'search_path=pg_catalog, hon','4dd6d6539ae99d60ae096c8d00ac19c8f580cd5db302ca7b4597c26432207ce3'),
('hon.automation_detail_json(hon.automation_workflows)',false,false,'search_path=pg_catalog, hon','0cc676b7c6f63af72d6d5b65b478ca5ba49e127783492897e4e4dfd0fd366165'),
('hon.automation_evidence(uuid,uuid,uuid,text,text,uuid,integer,jsonb,uuid,uuid)',false,false,'search_path=pg_catalog, hon','b70340cfb8ebe3cb260c5701a60e87183a2f75433aa4b0cfedc688ec51abcf9f'),
('hon.create_automation_workflow(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','5805e6d0fe967db896e8d9bbeef4e0f5ec61a6f5c5dc5a551ed60b99f464e7eb'),
('hon.automation_lock_workflow(uuid,uuid,uuid,jsonb)',false,false,'search_path=pg_catalog, hon','c7eee4e87106cc4587adca944c3be8119bbc9490e4b36b43cba917ee3417347e'),
('hon.automation_append_version(hon.automation_workflows,text,jsonb,integer,uuid,uuid)',false,false,'search_path=pg_catalog, hon','ced296a8261b9c624a2d0b9cc9ae1eb21efe25dd2ee7db44536920f9deb7463f'),
('hon.save_automation_workflow_version(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','a6e8df351debd63ca719f3ef34ee23a136e3a6888f692fe32bda56bc234034fe'),
('hon.restore_automation_workflow_version(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','a5421cddb45f1c547a3d355fe2f5ce564f80c48bf5d16bab643e1c524ecf5f2c'),
('hon.archive_automation_workflow(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','7f83d88e6fde8c3149d4c8920f12d7dbd260ce581690e1898b96aa807e0444ea'),
('hon.read_automation_workflows(text)',true,true,'search_path=pg_catalog, hon','dcefc51d72473a215c2b51bf5a46875561e20c6bae0aaee641906ded1d4cff24'),
('hon.read_automation_workflow(text,uuid)',true,true,'search_path=pg_catalog, hon','8485d3677a4fa8903f69af8bf4b2d11f0335ee06eeb8c37e40bba42104ecb0d3'),
('hon.read_automation_workflow_version(text,uuid,integer)',true,true,'search_path=pg_catalog, hon','0601497452f7c676efeed5f48940475744389349ac2dffa92b1190f7959b5421'),
('hon.contact_tag_list_json(uuid,uuid,uuid)',false,false,'search_path=pg_catalog, hon','f93737e347664ae233ecd29bc6a43ac1407f9e65a4679b04cf497abe86b2eb06'),
('hon.contact_tag_apply(uuid,uuid,uuid,text,boolean,uuid,text,uuid,uuid)',false,false,'search_path=pg_catalog, hon','20f2c6bbce37e5fcf443ec65bee77d098bbb57dfc49e92982159ff001fb20206'),
('hon.change_contact_tag(text,uuid,jsonb,boolean,text,uuid,uuid)',true,false,'search_path=pg_catalog, hon','21f3d4f248df3b7eca44de3af71de322a2818e7386993c6a05ac6fd1958632fc'),
('hon.add_contact_tag(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','250eabeb5df2d7511d881e3d3be408a0bbcca89339450e2438bd941b3ddceeac'),
('hon.remove_contact_tag(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','c06d434e63fdb93c47f21c675bd35441aca7d9456ba19e7c95162c269244d5ad'),
('hon.read_school_contact_tags(text)',true,true,'search_path=pg_catalog, hon','32c83a0c188d93e3e6776fa7733c4ed43e979d3c39486ffc5446e2a7c7ed0be2'),
('hon.read_person_contact_tags(text,uuid)',true,true,'search_path=pg_catalog, hon','9376d063c5c7db766b1e4c5a83db9e00327036281b738ebbea8f57ab89f74627'),
('hon.lookup_contact_tags(text,jsonb)',true,true,'search_path=pg_catalog, hon','1cba22acd17d524628af822f92673c098487f2645fb51b8775d1296e2ce66795')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe automation workflow function: %',f.signature; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['automation_workflows','automation_workflow_versions','automation_commands','contact_tags','contact_tag_events'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe automation workflow table: %',t;
    END IF;
  END LOOP;
  -- Guard triggers: no delete or truncate, immutable history and commands, forward-only workflows.
  IF (SELECT count(*) FROM pg_trigger g WHERE NOT g.tgisinternal AND g.tgenabled='O' AND (g.tgrelid::regclass::text,g.tgname,g.tgfoid::regproc::text) IN (
      ('hon.automation_workflows','guarded','hon.guard_automation_workflow'),('hon.automation_workflows','no_truncate','hon.guard_automation_workflow_history'),
      ('hon.automation_workflow_versions','guarded','hon.guard_automation_workflow_history'),('hon.automation_workflow_versions','no_truncate','hon.guard_automation_workflow_history'),
      ('hon.automation_commands','guarded','hon.guard_automation_workflow_history'),('hon.automation_commands','no_truncate','hon.guard_automation_workflow_history'),
      ('hon.contact_tags','no_truncate','hon.guard_automation_workflow_history'),
      ('hon.contact_tag_events','guarded','hon.guard_automation_workflow_history'),('hon.contact_tag_events','no_truncate','hon.guard_automation_workflow_history'))) <> 9 THEN
    RAISE EXCEPTION 'Unsafe automation workflow table posture: guard triggers'; END IF;
END $$;
-- End automation workflows and contact tags exact verification.
-- School one-time payment exact verification (B-TUI-2 0529): two private forced-RLS tables, the payment guard, internal
-- opener/state/cancel helpers that the runtime can never call, four API entry points and one live payment per caller record.
DO $$ DECLARE f record; safe boolean; t text; expected record; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.school_pay_once','hon.school_pay_once_events'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    INTO safe FROM pg_class c WHERE c.oid=t::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'School one-time payment table must be private with FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.guard_school_pay_once()',true,false,'search_path=pg_catalog, hon','146eda805148cf8b04b17a50e115ad8d443ee60dc7ae377dbc1be092194a9406'),
('hon.school_pay_once_json(hon.school_pay_once)',true,false,'search_path=pg_catalog, hon','dada49e4219c0766b8b7b7f3c8e3f7583d9c87989011ec5bd3c8ec75e0b9f1fd'),
('hon.school_pay_once_record(hon.school_pay_once,text,jsonb)',true,false,'search_path=pg_catalog, hon','ed1e9f9cdcd60e74a9c18fc5489017ab3c18c37f6b0b12979d3b8fd63842f2ef'),
('hon.school_pay_once_connection(uuid,uuid)',true,false,'search_path=pg_catalog, hon','79a382f793dde948ed35350c6680c7a82008eddd8d6466d903d9e5bdbde38a05'),
('hon.school_pay_once_provider(uuid,uuid)',true,false,'search_path=pg_catalog, hon','5181fd08f01fdf39baad56c02e5be4fa589b5a439128d438f94ad36ffa6bf2ad'),
('hon.school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamp with time zone)',true,false,'search_path=pg_catalog, hon','22f2cc0d4c25f26af3a2d0f75f5f6b674cb8dbf4ad81f95609a8537f8f3ca9ac'),
('hon.school_pay_once_state(uuid)',true,false,'search_path=pg_catalog, hon','92232df24fcb7b1c3d16dfc0f024243ffb53a01f6bc63fe3dbc0067fc276feb7'),
('hon.school_pay_once_cancel(uuid)',true,false,'search_path=pg_catalog, hon','fda71731d5c24ee71075c41c2d6c2aa251dcabc1355ff151d35425e75197fc88'),
('hon.read_school_pay_once(uuid)',true,true,'search_path=pg_catalog, hon','784ba9ab62974f5a50f5a98885f01bedb39708784480c6f364dab0fd7bc486fb'),
('hon.start_school_pay_once(uuid,jsonb)',true,true,'search_path=pg_catalog, hon','fd59d925b7197a20b738355be9b88e38409c4489ac825f347697d0d3b710df8d'),
('hon.record_school_pay_once(uuid,jsonb)',true,true,'search_path=pg_catalog, hon','50d1e14183cf9ce4da3c4e0cbb8c10c3f3e9f0fa8f3bfdbe143b2ae89b4464ab'),
('hon.list_due_school_pay_once(integer)',true,true,'search_path=pg_catalog, hon','fb793d67c1691ca4c973e8cf09c43f22937d70e55bc2ad5d655931352dc590b2')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school one-time payment function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('school_pay_once','school_pay_once_guard','hon.guard_school_pay_once()'),
    ('school_pay_once','school_pay_once_no_truncate','hon.guard_membership_activation_evidence()'),
    ('school_pay_once_events','school_pay_once_events_immutable','hon.guard_membership_activation_evidence()'),
    ('school_pay_once_events','school_pay_once_events_no_truncate','hon.guard_membership_activation_evidence()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing school one-time payment guard: %',expected.name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('hon.school_pay_once'::regclass,'hon.school_pay_once_events'::regclass) AND NOT tgisinternal
      AND tgname NOT IN ('parent_invoice_pay_settle','family_checkout_settle','public_checkout_settle'))<>4 THEN
    RAISE EXCEPTION 'School one-time payment tables must have exactly their four guards'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='hon' AND indexname='school_pay_once_one_live_idx'
      AND indexdef LIKE '%UNIQUE%(organization_id, school_id, source, source_id)%') THEN
    RAISE EXCEPTION 'A caller record must have at most one live one-time payment'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000529' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL)
    OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000529')
    OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id='00000000-0000-4000-8000-000000000529')
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id='00000000-0000-4000-8000-000000000529') THEN
    RAISE EXCEPTION 'The one-time payment recorder must be a code-owned service with no authority'; END IF;
END $$;
-- End school one-time payment exact verification.
-- Lead pipeline board exact verification (0417)
DO $$ DECLARE f text;
  entry text[]:=ARRAY['hon.read_crm_pipeline_board(text,uuid,text)','hon.move_crm_lead_stage(text,uuid,jsonb,text,uuid,uuid)',
    'hon.save_crm_pipeline_stages(text,uuid,jsonb,text,uuid,uuid)'];
  helpers text[]:=ARRAY['hon.crm_board_ts(timestamptz)','hon.require_crm_board_actor(text,text)','hon.lock_crm_board_actor(text,text)',
    'hon.crm_board_stages_json(uuid)','hon.guard_crm_lead_stage_update()','hon.guard_crm_pipeline_stage_update()','hon.crm_stage_name_ok(jsonb)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe lead pipeline board entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe lead pipeline board helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='crm_lead_stage_update_guard' AND tgrelid='hon.crm_leads'::regclass AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='crm_pipeline_stage_update_guard' AND tgrelid='hon.crm_pipeline_stages'::regclass AND tgenabled='O') THEN
    RAISE EXCEPTION 'Lead pipeline board guards missing'; END IF;
END $$;
-- End lead pipeline board exact verification.
-- Conversation AI training exact verification (0420): private helpers, five private forced-RLS tables, seven staff runtime
-- entry points and two HQ program entry points; nothing is runnable by the communication worker.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.conversation_ai_text_ok(text,integer)',false,false,'search_path=pg_catalog','d4a113ad9c58a2668356d92d9772cec0f4b5e291e3249e283c6ecce2f7505657'),
('hon.conversation_ai_words_ok(text[])',false,false,'search_path=pg_catalog','266cb23a85acc955d62d82d4f59d93b0bd9979b5dc89f1346a98c9d1f1d1c2cc'),
('hon.conversation_ai_locales_ok(text[])',false,false,'search_path=pg_catalog','c7c2f5045b68e3601a8803dc13f1ccd37e92b99210cdf36c4fc562993f04fe86'),
('hon.guard_conversation_ai_program_changes()',false,false,'search_path=pg_catalog','70037e443cda7813204dc1fd7061086c36783179711426a26261fdebd1b9e623'),
('hon.guard_conversation_ai_row()',false,false,'search_path=pg_catalog, hon','89b9608c2dc6519af65ca86ebc77a14ba2f8e694d9a642c6e302b5f275e872ac'),
('hon.require_conversation_ai_actor(text,boolean)',true,false,'search_path=pg_catalog, hon','9be646d3c4c142a547ca795ea0081c72f8b4b574fe3d80438451608924b4ebf8'),
('hon.conversation_ai_finish(uuid,text,text,uuid,integer,text,jsonb,jsonb,text,jsonb,uuid,uuid)',true,false,'search_path=pg_catalog, hon','979e7d01ab0b86afb7fd11a391c54b5d469e75be3a4c58e3f3202f407135d1be'),
('hon.conversation_ai_settings_json(hon.school_conversation_ai_settings)',true,false,'search_path=pg_catalog, hon','f2a08ffeeed1e5dc9686e76dee2eb7eda01700ade15faa9ce7aee02bd4a10876'),
('hon.conversation_ai_item_json(hon.school_ai_training_items)',true,false,'search_path=pg_catalog, hon','a5c549b2a7a713e96bd8f27248408f7ffbf4d6827dda51f9b46869b54a204e49'),
('hon.school_ai_knowledge(uuid,uuid)',true,false,'search_path=pg_catalog, hon','45250984d5ed3c5b04f6b3322b41e4440352c5115437114483299e44264363ca'),
('hon.read_school_conversation_ai(text)',true,true,'search_path=pg_catalog, hon','030d7c4b604aa684cda7517cfc84bc50ae9c7a4da055886ab245d0ded1a130cd'),
('hon.read_school_ai_knowledge(text)',true,true,'search_path=pg_catalog, hon','fa35c49e849ee56a6abbe1102abcaaf7418eff9393e6a9d5c4f164e87564c3b6'),
('hon.set_school_conversation_ai_settings(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','e22a9be625f6ad1fdd2072b86efffbb56fe02e740fae1c88d11f0bfd6a093e72'),
('hon.upload_school_ai_training_file(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','6cc5ad16f4d37e8b39a3d53f4a8e96ed9324f9df28cda1ad36f4d81c744f63b4'),
('hon.read_school_ai_training_file(text,uuid)',true,true,'search_path=pg_catalog, hon','eb165a61d52883c3edebf72314b45945ecf85cd3f74ef5c6bc3ffdfec47b169b'),
('hon.save_school_ai_training_item(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','4da9375ad2232cd6209811c17250a8d0a3ab2d0dab389f896977b1b37a9c99da'),
('hon.set_school_ai_training_item_status(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','5e8900f5cbeb73f430ce8a3e07f3f977fe03193f194027041382147968a5202a'),
('hon.read_conversation_ai_program_from_hq(text)',true,true,'search_path=pg_catalog, hon','6d656efff26b189c213664fc87d458a70adac3ef7faa5490dd9d4c64781822ba'),
('hon.command_conversation_ai_program(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','dfca015e319d187c3c1ab44d552ca5d8ccc6407225ca2b8543fd6c3d5e1e91b9')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.is_grantable OR a.privilege_type<>'EXECUTE'
          OR NOT (a.grantee=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') AND f.runtime_allowed)))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe conversation AI function: %',f.signature; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['conversation_ai_program','conversation_ai_program_changes','school_conversation_ai_settings','school_ai_training_files','school_ai_training_items'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe conversation AI table: %',t;
    END IF;
  END LOOP;
END $$;
-- End conversation AI training exact verification.
-- Automation engine exact verification (AU-2 0423): three private forced-RLS engine tables nobody but the owner touches, four runtime
-- entry points (turn on, pause, run history), two definer engine functions only the hon_automation_worker login (014) may call,
-- private helpers, forward-only guards, the AUTOMATION principal and the message origin columns. 0574 replaced the body of
-- hon.automation_unavailable (the three date triggers now run); its hash below is the 0574 body.
DO $$ DECLARE f record; safe boolean; t text; worker oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_automation_worker'); BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.guard_automation_run()',true,false,false,'search_path=pg_catalog, hon','65683e06da1ed396b09ab9ac1a460ae718c0b4cfa31c6f1d97c90b8f627d0abb'),
('hon.automation_unavailable(jsonb)',false,false,false,'search_path=pg_catalog, hon','178ad43fc35d2dd11aac3b3b37889c5ef41f213b496868d3692546658d362b3c'),
('hon.automation_references_ok(uuid,uuid,uuid,jsonb)',false,false,false,'search_path=pg_catalog, hon','af5fd466e05f55bd1afad7b4515edcc9606e71a86cb59dc4150e1d744b8976eb'),
('hon.automation_activator_ok(uuid,uuid,uuid)',false,false,false,'search_path=pg_catalog, hon','9803631a0c534efefcb11b57b618043e77e710db7a567a32a6700d993d414a9a'),
('hon.automation_trial_booked(uuid,uuid,uuid,timestamp with time zone)',false,false,false,'search_path=pg_catalog, hon','8c640f7d5e3056dfde834c683dfea98e68c609d89cc6fa13c21a5d4eec9acbb6'),
('hon.automation_enrolled(uuid,uuid,uuid,timestamp with time zone)',false,false,false,'search_path=pg_catalog, hon','eaf38840dd7fb0de0866919f56d8d9636338545083cacc8cf4054e62f9361251'),
('hon.automation_condition_holds(uuid,uuid,uuid,timestamp with time zone,jsonb)',false,false,false,'search_path=pg_catalog, hon','16d3b51b7a8a8b5030afef5719c62efcbb815c7c459cfac1ad1d133669bd2538'),
('hon.automation_exit_reached(uuid,uuid,uuid,timestamp with time zone,jsonb)',false,false,false,'search_path=pg_catalog, hon','45607ebf5b8c08f2470501eb7886a37024d7a398992c2dd8b828d2d99e6a38b0'),
('hon.automation_start_run(hon.automation_workflows,uuid,text,uuid,uuid,integer,timestamp with time zone)',false,false,false,'search_path=pg_catalog, hon','fbfddd89366633248d106c8421b85fe818d80bc59813d023a3d6f83a8eac1001'),
('hon.automation_event_subject(hon.outbox_events)',false,false,false,'search_path=pg_catalog, hon','1296bc299e7375525760dab00eab860121fa686e03ee2f7eaa1c1ca0287e71af'),
('hon.consume_automation_events(integer)',true,false,true,'search_path=pg_catalog, hon','473741f525f144d59fa64853053cdc73425a1a5546336a44a9cd6847eeca6f5c'),
('hon.automation_render(text,text,text)',false,false,false,'search_path=pg_catalog, hon','932d44db812e9a31d07e4b8aba02cb3282b6ed865696cc148fc9627e0e667acf'),
('hon.automation_next_local_time(text,text)',false,false,false,'search_path=pg_catalog, hon','27a2abf40c7f022c0f2c412971924af141a652bc2d421d7eb02b6edabe6857b7'),
('hon.automation_end_run(uuid,text,text)',false,false,false,'search_path=pg_catalog, hon','d5241ff75d5dcae0896e26b28d5446771430d479d3d21296521a9d0bafec8ca1'),
('hon.automation_engine_pause(uuid,text)',false,false,false,'search_path=pg_catalog, hon','f32c46e1b872cc41c16e6641b379f62c1b171cdec3315efb26bda435c78185f7'),
('hon.automation_execute_step(hon.automation_run_steps,hon.automation_runs,hon.automation_workflows,jsonb)',false,false,false,'search_path=pg_catalog, hon','36158f398669f704dd5ccd404643bef493266323542c1d3a594038f16c19616a'),
('hon.run_due_automation_steps(integer)',true,false,true,'search_path=pg_catalog, hon','37164b7b3a64f7a84c2ca363a15d089b5a17c32ca96ef04cbf90d20c62771b59'),
('hon.activate_automation_workflow(text,uuid,jsonb,text,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','f942e4fb0ac8486df045340583d11902b50e989855a9c6e7a17cc3e007b7c92c'),
('hon.pause_automation_workflow(text,uuid,jsonb,text,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','58a18e20d5c235bef7f381423733f845f5a792ee42841ff4b175b2f378d7ecef'),
('hon.automation_run_json(hon.automation_runs)',false,false,false,'search_path=pg_catalog, hon','020200561dae1423bd5d28222a408e3b6b136dd37ced035078caffa1762abde2'),
('hon.read_automation_runs(text,uuid)',true,true,false,'search_path=pg_catalog, hon','bea0d2780b582e32d5f7792a3a5d6aa88bf4b28db81af52f4dc4fdb9759a7564'),
('hon.read_automation_run(text,uuid)',true,true,false,'search_path=pg_catalog, hon','c117ec20a209b32f71b486457615596b4a55201c149e1bd87e0e410fe6780d45')) e(signature,definer,runtime_allowed,worker_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND (worker IS NULL OR has_function_privilege(worker,p.oid,'EXECUTE')=f.worker_allowed)
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.is_grantable OR a.privilege_type<>'EXECUTE'
          OR NOT ((a.grantee=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') AND f.runtime_allowed) OR (a.grantee=worker AND f.worker_allowed))))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe automation engine function: %',f.signature; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['automation_event_receipts','automation_runs','automation_run_steps'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES')
      OR (worker IS NOT NULL AND (has_table_privilege(worker,'hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(worker,'hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES'))) THEN
      RAISE EXCEPTION 'Unsafe automation engine table: %',t;
    END IF;
  END LOOP;
  -- Guard triggers: receipts never change; runs and steps only move forward; nothing is truncated.
  IF (SELECT count(*) FROM pg_trigger g WHERE NOT g.tgisinternal AND g.tgenabled='O' AND (g.tgrelid::regclass::text,g.tgname,g.tgfoid::regproc::text) IN (
      ('hon.automation_event_receipts','guarded','hon.guard_automation_workflow_history'),('hon.automation_event_receipts','no_truncate','hon.guard_automation_workflow_history'),
      ('hon.automation_runs','guarded','hon.guard_automation_run'),('hon.automation_runs','no_truncate','hon.guard_automation_workflow_history'),
      ('hon.automation_run_steps','guarded','hon.guard_automation_run'),('hon.automation_run_steps','no_truncate','hon.guard_automation_workflow_history'))) <> 6 THEN
    RAISE EXCEPTION 'Unsafe automation engine table posture: guard triggers'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000368' AND principal_type='AUTOMATION')
    OR (SELECT count(*) FROM pg_attribute WHERE attrelid='hon.communication_messages'::regclass AND NOT attisdropped
      AND attname IN ('origin_kind','origin_id','email_subject'))<>3
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.communication_messages'::regclass AND conname='communication_messages_origin_shape' AND convalidated) THEN
    RAISE EXCEPTION 'Unsafe automation engine posture: principal or message origin'; END IF;
  IF worker IS NOT NULL AND (SELECT r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
      OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) FROM pg_roles r WHERE r.oid=worker) THEN
    RAISE EXCEPTION 'Unsafe automation engine posture: hon_automation_worker role'; END IF;
END $$;
-- End automation engine exact verification.
-- Contact message history exact verification (0424): private helpers, one private forced-RLS table, three staff runtime entry
-- points; the email subject lookup is runnable only by hon_communication_worker (013), never by the runtime.
DO $$ DECLARE f record; safe boolean; worker_oid oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_communication_worker'); BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.contact_message_standard_subject(text)',false,false,false,'search_path=pg_catalog','75a03c8ff8037f501859eac4177a9fe7350b2f57ad13777c78c376b5ce24b4f6'),
('hon.communication_email_subject(uuid,uuid)',true,false,true,'search_path=pg_catalog, hon','3f8257e6fc567854999eca0621dd2dfd9ea9a381f7cd81c597d1878a8c5add44'),
('hon.contact_message_delivery_state(hon.communication_messages)',true,false,false,'search_path=pg_catalog, hon','cbf1526b9d0ea8805b256bb9fcb81962eb8c7d8d60a8dfe9ee61c3e5368b0241'),
('hon.contact_message_origin(hon.communication_messages)',true,false,false,'search_path=pg_catalog, hon','9ab3dda1fe1543626dffeda4e73aa4c8f8ddb86c50d97f42c937fb8f68770b35'),
('hon.contact_message_rows(uuid,boolean)',true,false,false,'search_path=pg_catalog, hon','970a90640772f02c398e111b7e2f140d57551583664d11c04143952e386d537e'),
('hon.contact_message_person(uuid)',true,false,false,'search_path=pg_catalog, hon','fc369b1b98107b0aa100f409cd25c2ced5ae8dfb506beff714d6cb8c18f3d7b0'),
('hon.read_contact_message_history(text,uuid,jsonb)',true,true,false,'search_path=pg_catalog, hon','d54e8b766f98d310b9b55b9f2a78a8610ed182d3ea99ced4da6088a787532535'),
('hon.contact_email_resend_block(hon.communication_messages,hon.people)',true,false,false,'search_path=pg_catalog, hon','15f4501bbe654b59c3b32e4e52331db2b71a88578762c3992374a78765c6614f'),
('hon.contact_email_message(uuid,uuid)',true,false,false,'search_path=pg_catalog, hon','bf0fa3ee519710ba7f69aed199f0017675b0b91d5e50c1b04c69e54c386add63'),
('hon.read_contact_message_email(text,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','5ccccf124c9dba9bc07cc73c7976af21ee73f56f8b08b6015e3debabeaa1efa5'),
('hon.require_contact_resend_actor(text)',true,false,false,'search_path=pg_catalog, hon','56e7d90453fb93a2bc16a9342be49c350c6ed5e5f38330248e8ee9107ce3019e'),
('hon.resend_contact_message_email(text,jsonb,text,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','9574a4eb384086f0f2fd0cef9c5c6cc17f253fb735324e4b9beb2aeef4f5e51a')) e(signature,definer,runtime_allowed,worker_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.is_grantable OR a.privilege_type<>'EXECUTE'
          OR NOT ((a.grantee=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') AND f.runtime_allowed)
            OR (a.grantee IS NOT DISTINCT FROM worker_oid AND f.worker_allowed))))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe contact message history function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.communication_message_resends'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.communication_message_resends'::regclass)
    OR has_table_privilege('hon_runtime','hon.communication_message_resends','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.communication_message_resends','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe contact message history table: communication_message_resends';
  END IF;
END $$;
-- End contact message history exact verification.
-- Face check-in exact verification (0443)
DO $$ DECLARE f text; t text; n integer;
  entry text[]:=ARRAY['hon.read_face_checkin(text)','hon.save_face_checkin_settings(text,jsonb,text,uuid,uuid)','hon.record_face_checkin_consent(text,jsonb,text,uuid,uuid)',
    'hon.withdraw_face_checkin_consent(text,jsonb,text,uuid,uuid)','hon.enroll_face_checkin_student(text,jsonb,text,uuid,uuid)','hon.match_face_checkin(text,uuid,jsonb,text,uuid,uuid)',
    'hon.confirm_face_checkin_match(text,jsonb,text,uuid,uuid)','hon.read_family_face_checkin(text)','hon.sign_family_face_checkin_consent(text,jsonb,text,uuid,uuid)',
    'hon.withdraw_family_face_checkin_consent(text,jsonb,text,uuid,uuid)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe face check-in entry point: %',f; END IF;
  END LOOP;
  SELECT count(*) INTO n FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace
    AND (p.proname LIKE 'face\_checkin\_%' OR p.proname IN ('guard_face_checkin','purge_face_checkin_retention'))
    AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE') OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner));
  IF n<>0 THEN RAISE EXCEPTION 'Unsafe face check-in helper (% found)',n; END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname LIKE 'face\_checkin\_%')<15 THEN
    RAISE EXCEPTION 'Face check-in helpers missing'; END IF;
  FOREACH t IN ARRAY ARRAY['face_checkin_program','face_checkin_form_parts','face_checkin_forms','face_checkin_settings','face_checkin_consents',
      'face_templates','face_template_deletions','face_checkin_matches','face_checkin_requests'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe face check-in table: %',t;
    END IF;
  END LOOP;
END $$;
-- End face check-in exact verification.
-- School demo data exact verification (0459): two private forced-RLS tables, three staff runtime entry points (read, load,
-- remove), the removal check that the 42 patched append-only guards call (runtime and the three workers may run it), the
-- refusal triggers that keep demo people from messages and school-pay, and every other helper migration-owner only.
DO $$ DECLARE f record; safe boolean; t text; workers oid[]:=ARRAY(SELECT oid FROM pg_roles WHERE rolname IN ('hon_outbox_worker','hon_communication_worker','hon_automation_worker')); BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%demo_data%')<>17 THEN
    RAISE EXCEPTION 'Unexpected school demo data functions'; END IF;
  FOR f IN SELECT * FROM (VALUES
('hon.demo_data_is_demo(text,uuid)',true,false,false,'search_path=pg_catalog, hon','dd6c028771e5d9f92da9c48b29ed981b73e2082da851620fd3362446de7f53a7'),
('hon.demo_data_person_tables()',false,false,false,'search_path=pg_catalog','ca3cb64f5bb8a39455fc7d5b2e74896f3f0eee832a46879999806dcf4556f363'),
('hon.demo_data_register(uuid,uuid,uuid,text,uuid)',true,false,false,'search_path=pg_catalog, hon','944c373b87df474d74621c6eb4dbb20838a15abfcdb947f226256d7d8de6755a'),
('hon.demo_data_removal_allows(text,jsonb)',true,true,true,'search_path=pg_catalog, hon','e867cfe0b31b33b49c28af8f78d6e733d7cfc85a894919969c3f08cff52ac709'),
('hon.guard_school_demo_data()',false,false,false,'search_path=pg_catalog, hon','e18628d1e587a8afce523fb5630f4e1dba4fec1b5a5a6b5f83d85fc6f0ba1194'),
('hon.load_school_demo_data(text,jsonb,text,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','2d4fc5841387bedd1ed6c96ef702f51044d2e3ccb0c9bf1884682ace68a79ef0'),
('hon.read_school_demo_data(text)',true,true,false,'search_path=pg_catalog, hon','c43c760f75b02e81ba06d83006ef560623002a81b1f6b6c5d73e398f7971ac27'),
('hon.refuse_demo_data_target()',true,false,false,'search_path=pg_catalog, hon','3376565780adf45268abff3a6d8fe667ecdcb74e3ebc374d766008f22d24ea1a'),
('hon.remove_school_demo_data(text,jsonb,text,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','ee275b954e2482f5ed925c2d15bc32ad7d27b72310f8854781449618f18187b9'),
('hon.require_demo_data_actor(text)',true,false,false,'search_path=pg_catalog, hon','b4ff1a5f44a6b1be96655e41884c3f1816102caea70852d2aeda9cda82090d64'),
('hon.school_demo_data_attendance(uuid,uuid,uuid,uuid,text,jsonb,uuid[],integer[],integer[])',true,false,false,'search_path=pg_catalog, hon','0669c55a5a5ba40d8281ceef5c064878ca7752b368a9034f626377665333427e'),
('hon.school_demo_data_begin(text,text,jsonb,text,uuid,uuid)',true,false,false,'search_path=pg_catalog, hon','d73fab306eafd34c8ad6340e1c6d3e833b185041a534848e23e1f18af6614574'),
('hon.school_demo_data_collect(uuid,uuid,uuid)',true,false,false,'search_path=pg_catalog, hon','265767a5f2608aa825871c8519171eea989c4a16edcda923deaec298e47a82fe'),
('hon.school_demo_data_delete(uuid)',true,false,false,'search_path=pg_catalog, hon','fe51977f55482eaa96325f0a8e898c1a5bb2dacee62c00c90b959e8bc885752c'),
('hon.school_demo_data_finish(text,uuid,text,jsonb)',true,false,false,'search_path=pg_catalog, hon','2db6dba17630bfcd60c5da56566743fce553eef9b9d95a7b0db7d594013fb9bf'),
('hon.school_demo_data_view(uuid,uuid)',true,false,false,'search_path=pg_catalog, hon','de29ae37237d85ab520b884e443fdfeee5c2a1628807faca2f7f39b8d5b48021'),
('hon.school_demo_data_write(uuid,uuid,uuid,uuid,uuid,uuid)',true,false,false,'search_path=pg_catalog, hon','40e0c7b8848710759d4467141467c7086570cc20ce2bf68abae50fd20a1758af')) e(signature,definer,runtime_allowed,worker_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.is_grantable OR a.privilege_type<>'EXECUTE'
          OR NOT ((a.grantee=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') AND f.runtime_allowed)
            OR (a.grantee=ANY(workers) AND f.worker_allowed))))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school demo data function: %',f.signature; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['school_demo_data_sets','school_demo_data_rows'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe school demo data table: %',t;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon'
      AND p.prosrc LIKE E'%\n  IF TG_OP=''DELETE'' AND hon.demo_data_removal_allows(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF; -- 0459 demo data removal\n%')<>42
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.prosrc LIKE '%demo_data_removal_allows%'
      AND p.proname<>'demo_data_removal_allows' AND array_length(string_to_array(p.prosrc,'demo_data_removal_allows'),1)<>2) THEN
    RAISE EXCEPTION 'Unexpected demo data removal check in append-only guards'; END IF;
  IF (SELECT count(*) FROM pg_trigger g WHERE g.tgname='demo_data_refuse' AND g.tgenabled='O' AND g.tgfoid='hon.refuse_demo_data_target()'::regprocedure
      AND g.tgrelid IN ('hon.communication_messages'::regclass,'hon.school_family_access_invitations'::regclass,'hon.school_pay_customers'::regclass,
        'hon.school_pay_method_setups'::regclass,'hon.school_pay_autopay_plans'::regclass,'hon.school_pay_charge_attempts'::regclass))<>6 THEN
    RAISE EXCEPTION 'Demo data refusal triggers missing'; END IF;
END $$;
-- End school demo data exact verification.
-- Membership agreement exact verification (0463)
DO $$ DECLARE f text; t text; n integer;
  entry text[]:=ARRAY['hon.read_membership_agreement(text)','hon.save_membership_agreement_draft(text,jsonb,text,uuid,uuid)',
    'hon.publish_membership_agreement(text,jsonb,text,uuid,uuid)','hon.read_family_membership_agreement(text)',
    'hon.sign_family_membership_agreement(text,jsonb,text,uuid,uuid)','hon.set_family_child_photo(text,jsonb,text,uuid,uuid)',
    'hon.remove_family_child_photo(text,jsonb,text,uuid,uuid)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe membership agreement entry point: %',f; END IF;
  END LOOP;
  SELECT count(*) INTO n FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace
    AND (p.proname LIKE 'membership\_agreement\_%' OR p.proname='guard_membership_agreement')
    AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE') OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner));
  IF n<>0 THEN RAISE EXCEPTION 'Unsafe membership agreement helper (% found)',n; END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname LIKE 'membership\_agreement\_%')<12 THEN
    RAISE EXCEPTION 'Membership agreement helpers missing'; END IF;
  FOREACH t IN ARRAY ARRAY['membership_agreement_drafts','membership_agreement_versions','membership_agreement_texts','membership_agreement_signatures',
      'membership_agreement_requests'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe membership agreement table: %',t;
    END IF;
  END LOOP;
END $$;
-- End membership agreement exact verification.

-- Parent school bookings exact verification (0466): private helpers, a private forced-RLS table and four runtime entry points.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.guard_parent_school_booking()',true,false,'search_path=pg_catalog, hon','0579ae3d2ac21cb22c89211aaf75276a658420fdb0cd94b4aff6f00bf62f1e7f'),
('hon.parent_school_booking_contact(uuid,uuid)',true,false,'search_path=pg_catalog, hon','cd9c648c49ffd7005f0b01765c9e320ac084b8dd5b5399fbba8309e879bd68c4'),
('hon.parent_school_booking_json(text,uuid)',true,false,'search_path=pg_catalog, hon','a46e67aa7700482a4ef1870a0d7f3c61ba149508c0c2dfaa6c00cab67d3e3e30'),
('hon.parent_school_booking_live(uuid,text,uuid)',true,false,'search_path=pg_catalog, hon','bcd126fbae3055be740d663b43d709210ce207d924a4b0dd2d9a51c9dfe0acae'),
('hon.parent_school_booking_finish(text,text,uuid,uuid,text,uuid,jsonb,text,text,jsonb,jsonb,integer,uuid,uuid)',true,false,'search_path=pg_catalog, hon','38db66f77ebd07cb2ac7f6880bb0e856924709fe6835e5f58fe54af66e1d563b'),
('hon.parent_school_booking_lock(text)',true,false,'search_path=pg_catalog, hon','c3c11d7443ffae5cf92366044243b94b577a2bd1c3ac09f475e2c24769a5bcf9'),
('hon.read_parent_school_bookings(text)',true,true,'search_path=pg_catalog, hon','fe34a3d6a9c09950e527ddc86ea9ca486e86fced0baa0abc73cc5356fb67efb0'),
('hon.book_parent_school_event_slot(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','f73e0430bfa3385a324f166957d584931c82d4c9979dac0090d1f3a2e9dcb259'),
('hon.book_parent_school_booking_type(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','8538275c6056cebb29a4f738eed104e1c0c12a36f4116485e67340b3b1265017'),
('hon.cancel_parent_school_booking(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','32eb7b0d3d32a736e480809eaba1841018ce8a789716924f8371899361283fb6')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe parent school booking function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.parent_school_bookings'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.parent_school_bookings'::regclass)
    OR has_table_privilege('hon_runtime','hon.parent_school_bookings','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.parent_school_bookings','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe parent school booking table';
  END IF;
END $$;
-- End parent school bookings exact verification.
-- Staff shift schedule exact verification (0467)
DO $$ DECLARE f text;
  entry text[]:=ARRAY['hon.read_staff_shift_week(text,date)','hon.save_staff_shift(text,jsonb,text,uuid,uuid)'];
  helpers text[]:=ARRAY['hon.staff_shift_text_ok(jsonb,integer)','hon.staff_shift_minutes(text,boolean)','hon.staff_shift_date_ok(jsonb)',
    'hon.guard_staff_shift()','hon.require_staff_shift_actor(text,text)','hon.staff_shift_json(hon.staff_shifts)','hon.staff_shift_display_name(uuid)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe staff shift entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe staff shift helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.staff_shifts'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.staff_shifts'::regclass)
    OR has_table_privilege('hon_runtime','hon.staff_shifts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.staff_shifts','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe staff shift table'; END IF;
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('staff.shift.manage','staff.shift.view_own') AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'Staff shift permissions missing'; END IF;
END $$;
-- End staff shift exact verification.
-- Shopify order retention exact verification (0470): the purge is executable by hon_communication_worker only (when that
-- login exists); the trigger function by nobody; both bodies exact; the retention trigger is in place.
DO $$ DECLARE f text; t text; w oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_communication_worker');
BEGIN
  FOR f,t IN SELECT * FROM (VALUES ('hon.purge_expired_shopify_orders()','8b4804b74e9a6f8abe20b59aa1f29eee'),
      ('hon.shopify_purge_expired_orders_on_success()','0d390e29b082f0fe9a1b199191b8faa2')) v LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM t THEN RAISE EXCEPTION 'Shopify retention function body drift: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='hon.purge_expired_shopify_orders()'::regprocedure
      AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND NOT has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
        AND (a.is_grantable OR a.grantee IS DISTINCT FROM w))) THEN
    RAISE EXCEPTION 'Unsafe Shopify retention function'; END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='hon.shopify_purge_expired_orders_on_success()'::regprocedure
      AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
    RAISE EXCEPTION 'Unsafe Shopify retention trigger function'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.shopify_syncs'::regclass AND tgname='shopify_syncs_order_retention' AND tgenabled='O'
      AND tgfoid='hon.shopify_purge_expired_orders_on_success()'::regprocedure) THEN
    RAISE EXCEPTION 'Shopify order retention trigger missing'; END IF;
END $$;
-- End Shopify order retention exact verification.

-- Parent family picker exact verification (0471): the private selection table, the private helper, the redefined family scopes and two runtime entry points.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.parent_live_family_scopes(text)',true,false,'search_path=pg_catalog, hon','b5ec04292b7c0b8a22ad81bdccf7b4d72e661b58bbe27c5ee5f129c46e3b3524'),
('hon.parent_class_booking_scope(text,boolean)',true,false,'search_path=pg_catalog, hon','cb18dc6356494af40a5b1af73147d4dd8d1bbafefab492439f51180e63fcac15'),
('hon.face_checkin_family_scope(text,boolean)',true,false,'search_path=pg_catalog, hon','e4d3454467f9f1c1290ab6a6b84a627dd2e3ba8a865ef1072ea710351fdfb652'),
('hon.school_family_acceptor_conflict(text,text,hon.school_family_access_invitations)',false,false,'search_path=pg_catalog, hon','06a988bb21c29c801f959aee91de9bb179fcb6d353e7f30351163fb3061bacfd'),
('hon.read_parent_family_choices(text)',true,true,'search_path=pg_catalog, hon','b2f7f4c031f49c6fd1b42aa34a9ce63f201ef94322c8fed2b199364ff47fe349'),
('hon.select_parent_family(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','eb84302e40ca74ea17dedf1a67d665f7fb31333600f098d7c7fd890b690b962d'),
('hon.resolve_parent_journey_scopes(text)',true,true,'search_path=pg_catalog, hon','ab8a77665e9ece9980c971453e05a04d12ebc118c79ee6310a36c1f62797f303')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe parent family picker function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.parent_family_selections'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.parent_family_selections'::regclass)
    OR has_table_privilege('hon_runtime','hon.parent_family_selections','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.parent_family_selections','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe parent family picker table';
  END IF;
END $$;
-- End parent family picker exact verification.

-- Parent school reads follow the family choice exact verification (0473): the private helper, the picker's choice list and the per-school parent resolver.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.parent_family_scope_any(text,uuid)',true,false,'search_path=pg_catalog, hon','20be8b6aa5add0ad188c486aa3331133477b8962405503ca439ee4cf67b920c9'),
('hon.parent_live_family_scopes(text)',true,false,'search_path=pg_catalog, hon','b5ec04292b7c0b8a22ad81bdccf7b4d72e661b58bbe27c5ee5f129c46e3b3524'),
('hon.resolve_parent_family_scope(text,uuid)',true,true,'search_path=pg_catalog, hon','e76a7689c3a06550acf0ea8a7de33d107aae0bae1ec1d454497d4beba808bb23')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe parent school scope function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End parent school reads follow the family choice exact verification.

-- Eian family AI exact verification (0474): the private turn table and its four S4 triggers, the pure route helper and the
-- re-pinned planner that calls it, private Eian helpers and seven runtime entry points. The S4 shared functions that gained
-- EIAN were redefined again by 0550 (adding TEXT_PROPOSAL) and are pinned in the 0550 section below.
-- ai_select_text_route body hash re-pinned by 0688 (legacy policy order skips definitely unavailable models).
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.ai_select_text_route(uuid,uuid,uuid,text,text,integer,bigint)',true,false,'search_path=pg_catalog, hon','c89d83535415ee132d37c8a026d7dc80b51a154b83bc23e7d5f9fe7178662acb'),
('hon.plan_ai_invocation(uuid,jsonb,uuid,uuid,uuid)',true,true,'search_path=pg_catalog, hon','17675880148308085f1317d6a88561cdf86dd47d3fa9036d8100b4ceee155635'),
('hon.eian_turn_limits()',false,false,'search_path=pg_catalog','0f454af366b8676c78035cce4722573484eef6ffa7b90921a10258a490827994'),
('hon.eian_burst_limit()',false,false,'search_path=pg_catalog','5e6a329b1c71b45fb5674458e87b8f8fd18c5b9916f026435f4b1cba7cae4610'),
('hon.eian_scope(text)',true,false,'search_path=pg_catalog, hon','afe37bc2bc76e9af1e30100277a1a865b3218ec4d9b33b791a208f11c0df93a7'),
('hon.eian_access(text)',true,false,'search_path=pg_catalog, hon','f4e619e296dea7098b40d8200e17dd578e183fcdaff84ad57f7d0df883242cc3'),
('hon.eian_unavailable_reason(uuid,uuid,boolean)',true,false,'search_path=pg_catalog, hon','de0c73719a9c12afc9ffecad71829c740f73abce85996731f2dc90043ba5e69a'),
('hon.eian_facts_ok(jsonb)',false,false,'search_path=pg_catalog','5dee68d2e78fcca110a427464ea23a1819918d01778134c64a432bfc03ecbd35'),
('hon.eian_turn_view(hon.eian_turns,boolean)',true,false,'search_path=pg_catalog, hon','a20a1febb75ad661b9ff2aab62e626842c3dc1c7b11857d007bf85bc89e9530a'),
('hon.read_eian_status(text,boolean)',true,true,'search_path=pg_catalog, hon','76cc90d9104dde327d92a9d704879857898565b0e483bf8d8845defc578919ff'),
('hon.read_eian_turn(text,uuid)',true,true,'search_path=pg_catalog, hon','9fe9e6019b0e845ef2aa66d617c6065b8b4782b413dd3d592da40987dab7c33a'),
('hon.begin_eian_turn(text,text,text)',true,true,'search_path=pg_catalog, hon','7d4c6bf36042dce0efdd868209b2a1b1ab93c3a4d2eb3fe31eb6ed4b5f0c9c86'),
('hon.plan_eian_turn(text,uuid,uuid,uuid)',true,true,'search_path=pg_catalog, hon','120f7c05c0d76dce3a989499c7d96d5f127a64754e1665aafe126d81a23aac5e'),
('hon.prepare_eian_turn(text,uuid,uuid,boolean,jsonb,jsonb)',true,true,'search_path=pg_catalog, hon','b7b937e0437a96873e0247a2d43c768ee4f78ff556fff6f0ca2b418ee9202ebd'),
('hon.fail_eian_turn(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','ea5e453a389f95b954cdc69631c2889bd0024f4de1e5bb9b2ce051c5e80d4da3'),
('hon.record_eian_turn_result(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','299c891b3c5e91df5ab0d576a1d817642db8d6210aebf349a8ab04d29b5d4d9f'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Eian family AI function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.eian_turns'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.eian_turns'::regclass)
    OR has_table_privilege('hon_runtime','hon.eian_turns','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.eian_turns','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe Eian turn table';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='hon.eian_turns'::regclass AND t.tgenabled='O' AND (t.tgname, t.tgfoid) IN (
      ('ai_spend_start_guard','hon.ai_spend_start_guard()'::regprocedure), ('ai_spend_reserve_guard','hon.ai_spend_reserve_guard()'::regprocedure),
      ('ai_spend_reserve_guard_insert','hon.ai_spend_reserve_guard()'::regprocedure), ('zz_ai_hold_origin','hon.ai_stamp_hold_origin()'::regprocedure))) <> 4 THEN
    RAISE EXCEPTION 'Eian turn S4 triggers missing';
  END IF;
END $$;
-- End Eian family AI exact verification.
-- Staff time clock exact verification (0478)
DO $$ DECLARE f text; t text;
  entry text[]:=ARRAY['hon.staff_time_clock_punch(text,jsonb,text,uuid,uuid)','hon.read_my_time_clock(text)','hon.read_staff_timesheet_week(text,date)',
    'hon.save_staff_time_entry(text,jsonb,text,uuid,uuid)','hon.set_staff_timesheet_week(text,jsonb,text,uuid,uuid)'];
  helpers text[]:=ARRAY['hon.staff_time_local_ok(jsonb)','hon.guard_staff_time()','hon.require_staff_time_actor(text,text)',
    'hon.staff_time_entry_json(hon.staff_time_entries)','hon.staff_timesheet_week_json(uuid,uuid,uuid,date)',
    'hon.staff_time_week_of(date)','hon.staff_time_week_approved(uuid,uuid,uuid,date)','hon.staff_time_begin(text,text,text,jsonb,text,uuid)',
    'hon.staff_time_finish(text,text,text,uuid,jsonb)','hon.staff_time_record(text,uuid,jsonb,jsonb,integer,uuid,uuid,uuid,jsonb)'];
  tables text[]:=ARRAY['hon.staff_time_entries','hon.staff_time_entry_revisions','hon.staff_timesheet_weeks'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe staff time entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe staff time helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=t::regclass)
      OR has_table_privilege('hon_runtime',t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime',t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe staff time table: %',t; END IF;
  END LOOP;
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('staff.time.clock','staff.timesheet.manage') AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'Staff time permissions missing'; END IF;
END $$;
-- End staff time clock exact verification.

-- Shopify product changes exact verification (0496, SH4a): six runtime entry points (definer, owner-safe, runtime only,
-- exact bodies); the change table is forced-RLS with no policy and no runtime privilege; every new helper stays closed.
DO $$ DECLARE f text; t text;
  entry text[]:=ARRAY['hon.read_shopify_product_changes(text,uuid)','hon.propose_shopify_product_change(text,jsonb)','hon.cancel_shopify_product_change(text,jsonb)',
    'hon.approve_shopify_product_change(text,jsonb)','hon.rotate_shopify_change_credential(text,jsonb)','hon.record_shopify_product_change_result(text,jsonb)'];
BEGIN
  FOR f,t IN SELECT * FROM (VALUES ('hon.read_shopify_product_changes(text,uuid)','c9ffb984aff89d62f550dd97cc83402c'),
      ('hon.propose_shopify_product_change(text,jsonb)','1f0db6cc91143a9b9f523c142253209f'),('hon.cancel_shopify_product_change(text,jsonb)','669f1ce90c8d974e522e68255b514a52'),
      ('hon.approve_shopify_product_change(text,jsonb)','1b46ea3b1d44f613fe3fe27b7e795795'),('hon.rotate_shopify_change_credential(text,jsonb)','43ecb7034d74235ae67c530b61143dc2'),
      ('hon.record_shopify_product_change_result(text,jsonb)','8b8c5c7310f9d03fe30049e8f33832f1'),('hon.guard_shopify_product_change()','1b6ee6dfb8d817c9b2163d6a4c6f9f94'),
      ('hon.shopify_locked_change(uuid,jsonb)','515c47ff8148c870ac6b23491497e2bc'),('hon.shopify_leased_change(uuid,uuid,jsonb,boolean)','bed71c1e6af57533ef99ecf1e0e73949'),
      ('hon.shopify_change_matches(hon.shopify_product_changes,jsonb)','b8f15aa40311b3b02816b944f4cb0f74'),('hon.shopify_mirror_product(uuid,jsonb,uuid)','8d4eced3cba45ff543e20e4b4cd21349')) v LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM t THEN RAISE EXCEPTION 'Shopify product change function body drift: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe Shopify product change entry point: %',f; END IF;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND (p.proname LIKE 'shopify\_%' OR p.proname IN ('guard_shopify','guard_shopify_product_change')) LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe Shopify product change helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.shopify_product_changes'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.shopify_product_changes'::regclass)
    OR has_table_privilege('hon_runtime','hon.shopify_product_changes','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.shopify_product_changes','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe Shopify product change table'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.shopify_product_changes'::regclass AND tgenabled='O' AND (
      (tgname='shopify_product_changes_guard' AND tgfoid='hon.guard_shopify_product_change()'::regprocedure)
      OR (tgname='shopify_product_changes_no_truncate' AND tgfoid='hon.guard_shopify()'::regprocedure))) <> 2 THEN
    RAISE EXCEPTION 'Shopify product change guards missing'; END IF;
END $$;
-- End Shopify product changes exact verification.

-- Membership agreement signing link exact verification (0499)
DO $$ DECLARE f text;
  entry text[]:=ARRAY['hon.read_membership_agreement_send(text,jsonb)','hon.send_membership_agreement_link(text,jsonb,text,text,uuid,uuid)',
    'hon.read_membership_agreement_link(text)','hon.sign_membership_agreement_link(text,jsonb,uuid)'];
  fns text[]:=ARRAY['hon.guard_membership_agreement_link()','hon.membership_agreement_link_actor(text)',
    'hon.membership_agreement_link_children(uuid,uuid,uuid,uuid)','hon.membership_agreement_link_json(hon.membership_agreement_links)',
    'hon.membership_agreement_link_live(hon.membership_agreement_links)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe membership agreement link entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY fns LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND a.grantee<>p.proowner) THEN
      RAISE EXCEPTION 'Unsafe membership agreement link helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.membership_agreement_links'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.membership_agreement_links'::regclass)
    OR has_table_privilege('hon_runtime','hon.membership_agreement_links','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.membership_agreement_links','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe membership agreement link table'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000499' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active) THEN
    RAISE EXCEPTION 'Membership agreement link principal missing'; END IF;
END $$;
-- End membership agreement signing link exact verification.
-- Parent invoice payment exact verification (0530): internal scope, balance and hold helpers and the settle trigger that the runtime can never
-- call, three API entry points, the FAMILY_INVOICE source and the holds on invoices, payment records and charge attempts.
DO $$ DECLARE f record; safe boolean; expected record; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.parent_invoice_pay_open(uuid)',true,false,'search_path=pg_catalog, hon','ba74921d7cd710c413da1f9f0c8fdb0a540ac030d052379e019791e1e8a6b4d4'),
('hon.guard_parent_invoice_pay_record()',true,false,'search_path=pg_catalog, hon','f7bc1870338e8ad66447e70036d1b48a248f10ed0c51b51134b6ee0dfc82c3d4'),
('hon.guard_parent_invoice_pay_invoice()',true,false,'search_path=pg_catalog, hon','644f147f6141ae47b9dc4c02ec1272cfd53ab45ea9d3dfb99b385377fd77272f'),
('hon.guard_parent_invoice_pay_charge()',true,false,'search_path=pg_catalog, hon','092e827e9cdd20ffe9e684b8b1c77d3d78d79c26f4d2a5020e985909b4c2662f'),
('hon.parent_invoice_pay_scope(text)',true,false,'search_path=pg_catalog, hon','7c8b204c73f882751064534c3ecd9b79ea9945e9104f6c55d3432677dd76fdb1'),
('hon.parent_invoice_pay_invoices(uuid,uuid,uuid)',true,false,'search_path=pg_catalog, hon','73f77c2fdb5c60e190cb4b40e018842afb800430441857367aafe074e706491f'),
('hon.parent_invoice_pay_balance(uuid)',true,false,'search_path=pg_catalog, hon','176ec1527f930cf6dea56d3b2d55183964ae87438d47ec12bfd687c08ad26891'),
('hon.parent_invoice_pay_latest(uuid)',true,false,'search_path=pg_catalog, hon','858ab153664a30381ca762a08d0204c51f6e016645c45374485e6cc94dada6fe'),
('hon.settle_parent_invoice_payment()',true,false,'search_path=pg_catalog, hon','0a1c1a2bb05d617bf2f5f358d2480741a4512e6a34d93cd2cb9585eedc354c2b'),
('hon.read_parent_invoice_payments(text)',true,true,'search_path=pg_catalog, hon','2d0e8c9164b6993cb32e23bad7542822b0bd43ee84dffc26831e4da238a2588a'),
('hon.read_parent_invoice_payment(text,uuid)',true,true,'search_path=pg_catalog, hon','9ee6e696bcc53f9927d2b673c83b63146734de72e9cb2376c1040afd72e0b4d6'),
('hon.open_parent_invoice_payment(text,uuid)',true,true,'search_path=pg_catalog, hon','a5d6d390449d934abb29fd07ac7a27c6a9e99880cfbedd0135c43e2f8981d497')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe parent invoice payment function: %',f.signature; END IF;
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES ('school_pay_once','parent_invoice_pay_settle','hon.settle_parent_invoice_payment()'),
    ('invoice_payment_records','parent_invoice_pay_record_guard','hon.guard_parent_invoice_pay_record()'),
    ('invoices','parent_invoice_pay_invoice_guard','hon.guard_parent_invoice_pay_invoice()'),
    ('school_pay_charge_attempts','parent_invoice_pay_charge_guard','hon.guard_parent_invoice_pay_charge()')) e(tbl,name,fn) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||expected.tbl)::regclass AND tgname=expected.name AND tgfoid=expected.fn::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Missing parent invoice payment trigger: %',expected.name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.school_pay_once'::regclass AND conname='school_pay_once_source_check'
      AND pg_get_constraintdef(oid) LIKE '%FAMILY_INVOICE%') THEN
    RAISE EXCEPTION 'The one-time payment source must include FAMILY_INVOICE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000530' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL)
    OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000530')
    OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id='00000000-0000-4000-8000-000000000530')
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id='00000000-0000-4000-8000-000000000530') THEN
    RAISE EXCEPTION 'The parent invoice payment recorder must be a code-owned service with no authority'; END IF;
END $$;
-- End parent invoice payment exact verification.
-- Walk-in kiosk card payment exact verification (0533): four runtime entry points, owner-only helpers, PAID_CARD columns.
DO $$ DECLARE f text;
  entry text[]:=ARRAY['hon.read_walkin_card_provider(text)','hon.open_walkin_card_payment(text,text)','hon.settle_walkin_card_payment(text,text)',
    'hon.read_walkin_visit_card_payment(text,uuid)'];
  helpers text[]:=ARRAY['hon.walkin_card_payment_of(hon.walkin_visits)','hon.walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid)',
    'hon.walkin_tablet_hold(text)','hon.walkin_tablet_visit(hon.walkin_kiosk_devices,text)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND (SELECT proconfig FROM pg_proc WHERE oid=f::regprocedure) IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe walk-in card payment entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND p.prosecdef)
      OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe walk-in card payment helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.walkin_visits'::regclass AND conname='walkin_visits_card_paid_check')
    OR (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid='hon.walkin_visits'::regclass AND c.conname='walkin_visits_payment_state_check')
      IS DISTINCT FROM 'CHECK ((payment_state = ANY (ARRAY[''FREE''::text, ''PAY_AT_DESK''::text, ''PAID_AT_DESK''::text, ''PAID_CARD''::text])))'
    OR has_any_column_privilege('hon_runtime','hon.walkin_visits','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe walk-in card payment columns'; END IF;
END $$;
-- End walk-in kiosk card payment exact verification.
-- Walk-in kiosk trial class exact verification (0537): owner-only class, seat and trial helpers, trial columns.
DO $$ DECLARE f text;
  helpers text[]:=ARRAY['hon.walkin_session_taken(uuid)','hon.walkin_trial_session_open(hon.class_sessions,jsonb,integer)',
    'hon.walkin_trial_classes(uuid,uuid,jsonb)','hon.walkin_trial_class_json(hon.walkin_visits)',
    'hon.walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid,uuid)','hon.walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid)'];
BEGIN
  FOREACH f IN ARRAY helpers LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND p.prosecdef
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon'])
      OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe walk-in trial class helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.walkin_visits'::regclass AND conname='walkin_visits_trial_check')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.walkin_visits'::regclass AND conname='walkin_visits_trial_session_fk')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.walkin_visits'::regclass AND conname='walkin_visits_trial_appointment_fk')
    OR has_any_column_privilege('hon_runtime','hon.walkin_visits','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe walk-in trial class columns'; END IF;
END $$;
-- End walk-in kiosk trial class exact verification.
-- Walk-in kiosk trial seats exact verification (0538): one scoped runtime seat read, owner-only seat helper.
DO $$ DECLARE f text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='hon.read_class_session_seats_taken(uuid)'::regprocedure
      AND p.prosecdef AND p.provolatile='s' AND (o.rolsuper OR o.rolbypassrls)
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
    RAISE EXCEPTION 'Unsafe class session seat read'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname='read_class_session_seats_taken')<>1 THEN
    RAISE EXCEPTION 'Unexpected class session seat read overload'; END IF;
  FOREACH f IN ARRAY ARRAY['hon.walkin_session_taken(uuid)','hon.parent_class_booking_seats(uuid)'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE') THEN RAISE EXCEPTION 'Unsafe class seat helper: %',f; END IF;
  END LOOP;
  IF has_table_privilege('hon_runtime','hon.school_demo_data_rows','SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Unsafe demo data rows grant'; END IF;
END $$;
-- End walk-in kiosk trial seats exact verification.
-- Shared AI text proposals exact verification (0550): the kind table and the proposal table with its guards and four S4
-- triggers, the private ai_text core, the WEBSITE_EDIT entry points (seven runtime) and the eight S4 shared functions,
-- now counting both EIAN (0474) and TEXT_PROPOSAL holds, UNKNOWN rows, resolutions, late expenses and HQ usage.
-- 0638 re-created those eight shared functions again to add EIAN_SPEECH (Eian natural voice clips), and 0652 again to add
-- AGENT_SPEECH (staff agent speech clips); the eight hashes below are the 0652 bodies. 0690 re-created ai_text_prepare and
-- ai_text_record (creative-billed kinds); those two hashes are the 0690 bodies.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.ai_org_committed_credits(uuid,timestamptz)',true,false,'search_path=pg_catalog, hon','912b515826a51a6fba5b9029977161f9e3a366b54d30123dc427cf3a0e44149d'),
('hon.ai_org_open_agent_holds(uuid)',false,false,'search_path=pg_catalog, hon','83c921780a75b8c584f8f12f454b18de9962cf9b632eb337150c42a6603fcfea'),
('hon.ai_school_committed_cost_micros(uuid,uuid,timestamptz)',true,false,'search_path=pg_catalog, hon','6924f4f3fbf8f75fd7419616400161464fae107d1dabef4543154d3331031c09'),
('hon.ai_text_begin(text,uuid,text,uuid,integer,jsonb)',true,false,'search_path=pg_catalog, hon','6f82977de496d1ed4a4dc92344338141ac0a7e6a1b438aedcd3d8289883036aa'),
('hon.ai_text_close(uuid,uuid,text)',true,false,'search_path=pg_catalog, hon','c7eb4e44d4c7e0b43356156e95e0575a3abefc205611d98e4606c81505e29010'),
('hon.ai_text_event(uuid,text)',true,false,'search_path=pg_catalog, hon','f959f57392aaa107fd79d0b094854aae0f61cac002bc96f71308fc8b503685a0'),
('hon.ai_text_fail(uuid,uuid,text,text)',true,false,'search_path=pg_catalog, hon','29d2f210d4f0a5a9806c37010e04371fca0ef00a52d91bf6a3724be965ed49ef'),
('hon.ai_text_planning_reference(uuid,uuid)',true,false,'search_path=pg_catalog, hon','07b5666966d6ab065efe82da92fa2f2b6c39fa367660a0101eb5fcd798aba0bd'),
('hon.ai_text_prepare(uuid,uuid,uuid,boolean,text)',true,false,'search_path=pg_catalog, hon','a78d9ed568150e0ccf99b928157f6f8d3532011e6a46b4da814b1e9d7781a436'),
('hon.ai_text_record(uuid,uuid,jsonb,jsonb,jsonb)',true,false,'search_path=pg_catalog, hon','977c6f5b04422af647fcbf70fcf219a8f5ff4026f0ba96a3264edfa43aa81ff9'),
('hon.ai_text_row(uuid,uuid)',true,false,'search_path=pg_catalog, hon','c872bdf33d4691655dfebf209863dfd96c2a51dbb64c897802fc25952c60d01d'),
('hon.ai_unknown_validate(text,jsonb)',false,false,'search_path=pg_catalog, hon','25644d7c2b7998c666c1d93cb9f82a44cf0d15aef5b638f2cff54e584951c469'),
('hon.begin_school_website_ai_edit(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','942cb067060413f3309465c5cd4c6f8d326b8c73a41d695a00dcd452f3465f69'),
('hon.close_school_website_ai_edit(text,uuid,text)',true,true,'search_path=pg_catalog, hon','cf273be12c4a99889369dad1feb7ecff0ae6d73edaecde2c82274d6054432298'),
('hon.fail_school_website_ai_edit(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','cec489c91805c02f0a460bc9f8401c295fc0efdf66637a86ac3f000703352688'),
('hon.guard_ai_text_proposals()',false,false,'search_path=pg_catalog, hon','431a2ad9c9a47028538a537910d2b2b40bef20e091af7b4e650963202671be75'),
('hon.prepare_school_website_ai_edit(text,uuid,uuid,boolean)',true,true,'search_path=pg_catalog, hon','8b78db60ef391b85adc83b5bcbfcfe2eae5c8097fde15fc7d96888adf8cba659'),
('hon.read_ai_school_usage_from_hq(text,timestamptz,timestamptz)',true,true,'search_path=pg_catalog, hon','529990ca6a5703607eb7bb898d9125aa0a8858f414f2e3552bd72da57a1ee0df'),
('hon.read_ai_unknown_invocations_from_hq(text)',true,true,'search_path=pg_catalog, hon','3fc40c85bd6bdf02173bbe45d5388d125859058ea580147e5a6e6a770ff9faba'),
('hon.read_school_website_ai_edits(text,uuid)',true,true,'search_path=pg_catalog, hon','5bca23fda531a8d5ab1f1bbbed5d08b873ef8da848dea32ba893e4cbc335d99f'),
('hon.record_ai_late_provider_expense(text,text,uuid,jsonb,uuid,uuid,uuid)',true,true,'search_path=pg_catalog, hon','c49d55805da8bb976a1590d9f2d2d819a17aa9d77073709a07c3a6d511563b43'),
('hon.record_school_website_ai_edit(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','94284d3805916895a286633e8a81d58d4f7f56c0835e41217b68be4e9588f2f4'),
('hon.resolve_ai_unknown_invocation(text,text,uuid,jsonb,uuid,uuid,uuid)',true,true,'search_path=pg_catalog, hon','2b7ce366c109c00d780f032f37032ad10d037242361d34d99ff08741836c633a'),
('hon.school_website_ai_actor(text)',true,false,'search_path=pg_catalog, hon','768224c8665725fe986a89512fbac5a3a69e54e6b6627fbb033d13b5ceb2e1c5'),
('hon.school_website_ai_edit_planning_reference(text,uuid)',true,true,'search_path=pg_catalog, hon','a649cd44c33edc3d00f17a46830ce3f632ff814b5274e760688186d49b7baa6d'),
('hon.school_website_ai_facts(jsonb,text)',false,false,'search_path=pg_catalog, hon','c6a2bfb758bca374c226adeb598d7e297fed6715b68e4a10788bebb71a078a14'),
('hon.school_website_ai_proposal_ok(jsonb)',false,false,'search_path=pg_catalog, hon','852faa84decc92ee7b5d4d10dacc3ff32034b2279fedc20854b5f4dc2cf47368'),
('hon.school_website_ai_view(uuid,uuid)',true,false,'search_path=pg_catalog, hon','830d4f263809921c30c16b46d34c06a1cf0c138f4ad85d6b9c0ba07cfe3f66cf'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe shared AI text function: %',f.signature; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['hon.ai_text_kinds','hon.ai_text_proposals']::regclass[]) t(r) WHERE NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t.r AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=t.r)
      OR has_table_privilege('hon_runtime',t.r,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime',t.r,'SELECT,INSERT,UPDATE,REFERENCES')) THEN
    RAISE EXCEPTION 'Unsafe shared AI text table';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='hon.ai_text_proposals'::regclass AND t.tgenabled='O' AND (t.tgname, t.tgfoid) IN (
      ('ai_spend_start_guard','hon.ai_spend_start_guard()'::regprocedure), ('ai_spend_reserve_guard','hon.ai_spend_reserve_guard()'::regprocedure),
      ('ai_spend_reserve_guard_insert','hon.ai_spend_reserve_guard()'::regprocedure), ('zz_ai_hold_origin','hon.ai_stamp_hold_origin()'::regprocedure),
      ('ai_text_proposals_guard','hon.guard_ai_text_proposals()'::regprocedure), ('ai_text_proposals_no_truncate','hon.guard_ai_text_proposals()'::regprocedure))) <> 6 THEN
    RAISE EXCEPTION 'Shared AI text proposal triggers missing';
  END IF;
END $$;
-- End shared AI text proposals exact verification.
-- School calls exact verification (0556): four private forced-RLS tables, eight staff runtime entry points, worker-only
-- provider functions and owner-only helpers, all SECURITY DEFINER with the fixed search path.
DO $$ DECLARE f text; t text;
  entry text[]:=ARRAY['hon.read_school_calling(text)','hon.set_school_calling_settings(text,jsonb,uuid,uuid)','hon.set_my_school_call_ringing(text,jsonb)',
    'hon.start_school_call(text,jsonb,text,uuid,uuid)','hon.read_school_calls(text,jsonb)','hon.update_school_call(text,jsonb,uuid,uuid)',
    'hon.set_school_do_not_call(text,jsonb)','hon.open_school_call_recording(text,uuid)'];
  worker text[]:=ARRAY['hon.connect_school_client_call(uuid,text,text,text)','hon.route_school_incoming_call(text,text,text)',
    'hon.record_school_call_status(text,text,text,text,integer,timestamptz)','hon.record_school_call_recording(text,text,text,integer,boolean)',
    'hon.read_school_call_recordings_due(integer)','hon.mark_school_call_recording_deleted(uuid,text)'];
  closed text[]:=ARRAY['hon.require_school_call_actor(text,boolean)','hon.school_call_person(uuid,uuid,text)','hon.school_call_account_ok(uuid,text)','hon.expire_school_calls(uuid)',
    'hon.school_call_json(hon.school_calls)','hon.school_call_audit(hon.school_calls,uuid,text,text,jsonb,text,uuid,uuid)',
    'hon.guard_school_call()','hon.guard_school_calling_settings()','hon.guard_school_call_staff()','hon.guard_school_do_not_call()'];
BEGIN
  FOREACH t IN ARRAY ARRAY['school_calling_settings','school_call_staff','school_calls','school_do_not_call'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'Unsafe school calls table: %',t; END IF;
  END LOOP;
  FOREACH f IN ARRAY entry||worker||closed LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND p.prosecdef AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon'])
      OR has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE') IS DISTINCT FROM (f=ANY(entry))
      OR (EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker')
        AND has_function_privilege('hon_communication_worker',f::regprocedure,'EXECUTE') IS DISTINCT FROM (f=ANY(worker)))
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure
        AND a.grantee=0) THEN
      RAISE EXCEPTION 'Unsafe school calls function: %',f; END IF;
  END LOOP;
END $$;
-- End school calls exact verification.

-- Simple invoices exact verification (SI1 0558)
DO $$ DECLARE f text; t text; safe boolean;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.create_simple_invoice(text,jsonb,text,uuid,uuid)','hon.read_school_invoice_detail(text,uuid)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure
        AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
      RAISE EXCEPTION 'Unsafe simple invoice entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.simple_invoice_detail_json(hon.invoices,boolean)','hon.simple_invoice_can_issue(text)',
      'hon.simple_invoice_text_ok(jsonb,integer,boolean)','hon.guard_invoice_simple_rows()'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND a.grantee=0) THEN
      RAISE EXCEPTION 'Unsafe simple invoice helper: %',f; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname IN ('create_simple_invoice','read_school_invoice_detail'))<>2 THEN
    RAISE EXCEPTION 'Unexpected simple invoice overload'; END IF;
  FOREACH t IN ARRAY ARRAY['invoice_line_items','invoice_details'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe simple invoice table: %',t; END IF;
    IF (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=('hon.'||t)::regclass AND NOT g.tgisinternal AND g.tgenabled='O'
        AND g.tgfoid='hon.guard_invoice_simple_rows()'::regprocedure)<>2 THEN
      RAISE EXCEPTION 'Simple invoice guards missing on %',t; END IF;
  END LOOP;
END $$;
-- End simple invoices exact verification.
-- Calendar cards exact verification (0567): the card kind and roster instructor columns, the private forced-RLS roster
-- detachment table, private helpers, the occurrence trigger and three runtime entry points; still no runtime UPDATE on class sessions.
DO $$ DECLARE f record; safe boolean; BEGIN
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
    AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND tgname='class_session_roster_detachments_immutable' AND NOT tgisinternal)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND tgname='class_session_roster_detachments_no_truncate' AND NOT tgisinternal)
  INTO safe FROM pg_class c WHERE c.oid='hon.class_session_roster_detachments'::regclass;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Roster detachments must be private, immutable and FORCE RLS'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='hon.class_sessions'::regclass AND attname='session_kind' AND atttypid='text'::regtype AND attnotnull)
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.class_sessions'::regclass AND conname='class_sessions_session_kind_check')
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='hon.class_series'::regclass AND attname='session_kind' AND atttypid='text'::regtype AND attnotnull)
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='hon.class_series'::regclass AND attname='lead_instructor_principal_id' AND atttypid='uuid'::regtype)
    OR EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a JOIN pg_class c ON c.oid=x.attrelid
      WHERE x.attrelid='hon.class_series'::regclass AND x.attname IN ('session_kind','lead_instructor_principal_id') AND a.grantee<>c.relowner)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.class_series_occurrences'::regclass AND tgname='class_series_occurrence_inherit' AND NOT tgisinternal
      AND tgfoid='hon.class_series_occurrence_inherit()'::regprocedure) THEN
    RAISE EXCEPTION 'Unsafe calendar card columns or occurrence trigger'; END IF;
  FOR f IN SELECT * FROM (VALUES
('hon.calendar_instructor_ok(uuid,uuid,uuid)',true,false,'search_path=pg_catalog, hon','10f1ede2fa35f1fb1a34d196555e061b8a9221b09e48663477318dbd060bd33f'),
('hon.class_series_occurrence_inherit()',true,false,'search_path=pg_catalog, hon','769018b72f49972a10e9fe1a6c1416b045c5f622641e8196329bb3eb44c5f99f'),
('hon.calendar_card_command_finish(text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',true,false,'search_path=pg_catalog, hon','afe49b9fbbd604a62f4c994f9aa6d67cdf57f9c70e9a6684aaf0f4e9c6db41e7'),
('hon.create_calendar_card(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','813f6ae96dca73dd9a8e82da08b2582f4bf458c9d94d0c7d1c4ee4e183b9fd71'),
('hon.move_calendar_card(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','9486c99871157f5e84f9611d70b141bbacdf91be2dbdb6176db5704094aa6eea'),
('hon.read_school_calendar_cards(text,jsonb)',true,true,'search_path=pg_catalog, hon','8b60a8a66eb9214df14669446158c6ac36f78a922e807fda2d3efb6f676b8da8')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe calendar card function: %',f.signature; END IF;
  END LOOP;
  IF has_any_column_privilege('hon_runtime','hon.class_sessions','UPDATE') THEN RAISE EXCEPTION 'Runtime must not update class sessions'; END IF;
END $$;
-- End calendar cards exact verification.
-- Automation date triggers exact verification (AU-3 0574): one private forced-RLS scan receipt table nobody but the owner touches
-- (forward-only guards), private candidate and birthday helpers, and one definer scan only the hon_automation_worker login (014) may call.
DO $$ DECLARE f record; safe boolean; worker oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_automation_worker'); BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.automation_next_birthday(date,date)',false,false,false,'search_path=pg_catalog, hon','450419c70e89811c753abf222900b14d8c61c67dc1b09d76207d35f8c1440935'),
('hon.automation_date_subject_open(uuid,uuid,text)',false,false,false,'search_path=pg_catalog, hon','05f33adb132e3dace679fc0b201d1a299022a7a0ed84eb620e181f5926d372b3'),
('hon.automation_date_candidates(hon.automation_workflows,jsonb,date,text)',false,false,false,'search_path=pg_catalog, hon','556603ea44a0f76545615877370cd5353043043766e2741bf747e039e622b3d6'),
('hon.scan_automation_schedules(integer)',true,false,true,'search_path=pg_catalog, hon','cd26c195ee65ab4454751a225fde6072a62521e8816166d762a57b76bffe4173')) e(signature,definer,runtime_allowed,worker_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND (worker IS NULL OR has_function_privilege(worker,p.oid,'EXECUTE')=f.worker_allowed)
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.is_grantable OR a.privilege_type<>'EXECUTE'
          OR NOT ((a.grantee=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') AND f.runtime_allowed) OR (a.grantee=worker AND f.worker_allowed))))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe automation date trigger function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.automation_schedule_scans'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.automation_schedule_scans'::regclass)
    OR has_table_privilege('hon_runtime','hon.automation_schedule_scans','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.automation_schedule_scans','SELECT,INSERT,UPDATE,REFERENCES')
    OR (worker IS NOT NULL AND (has_table_privilege(worker,'hon.automation_schedule_scans','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(worker,'hon.automation_schedule_scans','SELECT,INSERT,UPDATE,REFERENCES'))) THEN
    RAISE EXCEPTION 'Unsafe automation date trigger table: automation_schedule_scans';
  END IF;
  -- Guard triggers: scan receipts never change and are never truncated.
  IF (SELECT count(*) FROM pg_trigger g WHERE NOT g.tgisinternal AND g.tgenabled='O' AND (g.tgrelid::regclass::text,g.tgname,g.tgfoid::regproc::text) IN (
      ('hon.automation_schedule_scans','guarded','hon.guard_automation_workflow_history'),('hon.automation_schedule_scans','no_truncate','hon.guard_automation_workflow_history'))) <> 2 THEN
    RAISE EXCEPTION 'Unsafe automation date trigger table posture: guard triggers'; END IF;
END $$;
-- End automation date triggers exact verification.
-- School announcements exact verification (0576): private title, scope and JSON helpers, the write guard, four runtime entry points and a
-- private forced-RLS table the runtime can never touch directly.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.school_announcement_title_ok(text)',false,false,'search_path=pg_catalog','5a743ed6ddbeb67d486c9678bea6fb7a4682da55484c6f719803e0c7cf1e199b'),
('hon.guard_school_announcement()',false,false,'search_path=pg_catalog, hon','7f36851762b4848dda76943c0eca128c057db88801998cf0437a508ac6c13aee'),
('hon.school_announcement_parent_scope(text)',true,false,'search_path=pg_catalog, hon','782964087089c4feca334f5940294930b1c1586cffe228e75206416eab75480c'),
('hon.require_school_announcements_actor(text)',true,false,'search_path=pg_catalog, hon','c496bd74ed650a880b3735e82279c9934819b9df34332c09c4cee1e3f0bb467c'),
('hon.school_announcement_family_json(hon.school_announcements)',true,false,'search_path=pg_catalog, hon','060b18bd1000ba92fc30ac843a3a3078c21674b8963e508deca6375a30ab61c8'),
('hon.school_announcement_staff_json(hon.school_announcements)',true,false,'search_path=pg_catalog, hon','e91a1110e8229f3cb6243554a745b9657e3a8c3d23a792aefed005405a945695'),
('hon.read_parent_school_announcements(text)',true,true,'search_path=pg_catalog, hon','b42286f83b937b65ff94ac33149c3ab4dd2799338939d70d37db7fb597c63da6'),
('hon.read_school_announcements(text)',true,true,'search_path=pg_catalog, hon','8e974dde8c79198e935240ed0f9270fb3fb99eee7c8cc17a60db1b75de64d696'),
('hon.publish_school_announcement(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','7f50ec48b95451729488f8ca4a2198a011ee9999ed73c6acc2e5aa41f92549d0'),
('hon.withdraw_school_announcement(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','a0a798a755e39c3fba2c2f20a1fd4b1812e22cd917111ffd36f8e902b4d721d8')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe school announcement function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.school_announcements'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.school_announcements'::regclass)
    OR has_table_privilege('hon_runtime','hon.school_announcements','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.school_announcements','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe school announcements table'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.school_announcements'::regclass AND NOT tgisinternal AND tgenabled='O'
      AND ((tgname='school_announcements_guard' AND tgfoid='hon.guard_school_announcement()'::regprocedure)
        OR (tgname='school_announcements_no_truncate' AND tgfoid='hon.guard_membership_activation_evidence()'::regprocedure)))<>2
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.school_announcements'::regclass AND NOT tgisinternal)<>2 THEN
    RAISE EXCEPTION 'hon.school_announcements must carry exactly its two guards'; END IF;
END $$;
-- End school announcements exact verification.
-- Parent pro shop exact verification (0581): a private scope helper and one runtime read of the mirrored Shopify products.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.parent_pro_shop_scope(text)',true,false,'search_path=pg_catalog, hon','4e21712b1b5c0e86d01c14f91ae3a39fa900e29a6c5abd709ed9024ad212612a'),
('hon.read_parent_pro_shop(text)',true,true,'search_path=pg_catalog, hon','ccea6dd5c412d4b41958c338e584b92c79fc540661ca92f0b2ef46074e5f4e7f')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe parent pro shop function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End parent pro shop exact verification.
-- Calendar settings exact verification (0583): three private forced-RLS tables with guard and no-truncate triggers, private
-- helpers and eight runtime entry points.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOREACH t IN ARRAY ARRAY['calendar_share_settings','calendar_block_outs','share_calendars'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND tgname=t||'_guard' AND NOT tgisinternal AND tgfoid='hon.guard_calendar_settings()'::regprocedure)
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND tgname=t||'_no_truncate' AND NOT tgisinternal)
    INTO safe FROM pg_class c WHERE c.oid=('hon.'||t)::regclass;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Calendar settings table must be private, guarded and FORCE RLS: %',t; END IF;
  END LOOP;
  FOR f IN SELECT * FROM (VALUES
('hon.guard_calendar_settings()',false,false,'search_path=pg_catalog, hon','82b4992e390578bb166c15a123002960e09c9e779052e6dfe38cbb5d50250418'),
('hon.calendar_day_blocked(uuid,uuid,date)',true,false,'search_path=pg_catalog, hon','74289b956cd480a78038895f666a24f28309a812aefe1dd9bd26e7810b159f8d'),
('hon.share_calendar_times(uuid,uuid,uuid,text,integer)',true,false,'search_path=pg_catalog, hon','d02eeebcfaf1dc3ffd2602ac6903b487c9bfa0af3584872d52abb618b067bd81'),
('hon.share_calendar_json(hon.share_calendars)',true,false,'search_path=pg_catalog, hon','8f359f6dde3e4dbb072f8d5a777820dc846f954800088740118bfcc8ec99c2c4'),
('hon.calendar_block_out_json(hon.calendar_block_outs)',false,false,'search_path=pg_catalog, hon','8da71fff985809ffe2c4a7d82a139cd18accb0d019f6acc7130f9019f097694a'),
('hon.calendar_settings_fp(text,uuid,jsonb)',false,false,'search_path=pg_catalog','bbfb92ae8192f72c6c66ce5616cf6fe90bd70c7293636500839826b5ee3f0372'),
('hon.calendar_expected_version(jsonb)',false,false,'search_path=pg_catalog','9b383f9759d096a24b434537d779fc1bd20c039683b69f0fcad75d67069ffac8'),
('hon.public_share_calendar(text)',true,false,'search_path=pg_catalog, hon','aca7d4ce6e2869aab27e50a7199f09b08d80e53cc1a0ec53646cdb69d3f3e3c8'),
('hon.save_calendar_share_settings(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','3d7a55cdbec5be04e60d6cad37a2a7d69681318f4eb31a9ba840c334a08768f6'),
('hon.save_calendar_block_out(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','ef3d93521a701abd42cbb04dcb0cc3b43d940dfbba58eede6fb8fe8952140897'),
('hon.remove_calendar_block_out(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','335460d212eae52ec95289c49f290b51a2ce5c8122f4277462c945213ce9d997'),
('hon.save_share_calendar(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','d656cf26febb4ed559fe076c3332aab4dbdb1ea2f511470e6ef19c92717542e2'),
('hon.delete_share_calendar(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','01d82a6257c31df540c6e6c6d93008ff3fef25bcfe83ba16afbef829a78e41e4'),
('hon.read_calendar_settings(text)',true,true,'search_path=pg_catalog, hon','3465be4b189ba9b5ee283e22d7f6b469b74ef215aff7e3740b5b0907199f9d1c'),
('hon.read_school_calendar_block_outs(text,jsonb)',true,true,'search_path=pg_catalog, hon','02bdb87849deda7c91271d9b1dc3452263315915700845c59e40af747d929d8a'),
('hon.read_public_share_calendar(text)',true,true,'search_path=pg_catalog, hon','0848b8e246deae8c4226860e58958ba586b288d7ea066c345e9258839aee3528')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe calendar settings function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End calendar settings exact verification.
-- School message history exact verification (TE1 0585): two runtime read entry points, three private helpers.
DO $$ DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.read_school_message_history(text,jsonb)','hon.read_school_opted_out_contacts(text,jsonb)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure
        AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
      RAISE EXCEPTION 'Unsafe school message history entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.require_school_messages_actor(text,text)','hon.school_messages_args_ok(jsonb,text[])','hon.school_message_outcome(text)'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND (a.grantee=0 OR a.grantee<>p.proowner)) THEN
      RAISE EXCEPTION 'Unsafe school message history helper: %',f; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname IN ('read_school_message_history','read_school_opted_out_contacts',
      'require_school_messages_actor','school_messages_args_ok','school_message_outcome'))<>5 THEN
    RAISE EXCEPTION 'Unexpected school message history overload'; END IF;
END $$;
-- End school message history exact verification.
-- School message templates exact verification (TE2 0586): three runtime entry points, nine private helpers, a forced-RLS table.
DO $$ DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.read_school_message_templates(text,jsonb)','hon.save_school_message_template(text,jsonb,text,uuid,uuid)',
      'hon.set_school_message_template_status(text,jsonb,text,uuid,uuid)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure
        AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
      RAISE EXCEPTION 'Unsafe school message template entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.school_template_line_ok(text,integer)','hon.school_template_body_ok(text,integer)','hon.school_template_tags_ok(text)',
      'hon.guard_school_message_template()','hon.require_school_template_actor(text,text)','hon.school_message_template_json(hon.school_message_templates)',
      'hon.school_template_command_begin(text,text,jsonb,text,uuid,uuid)','hon.school_template_room_check(uuid,uuid,text,text,uuid,boolean)',
      'hon.school_template_command_finish(uuid,text,hon.school_message_templates,jsonb,text,uuid,uuid,jsonb)'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND (a.grantee=0 OR a.grantee<>p.proowner)) THEN
      RAISE EXCEPTION 'Unsafe school message template helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.school_message_templates'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename='school_message_templates')
    OR EXISTS(SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='hon.school_message_templates'::regclass AND a.grantee<>c.relowner) THEN
    RAISE EXCEPTION 'Unsafe school message template table'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname IN ('read_school_message_templates','save_school_message_template',
      'set_school_message_template_status','school_template_line_ok','school_template_body_ok','school_template_tags_ok','guard_school_message_template',
      'require_school_template_actor','school_message_template_json','school_template_command_begin','school_template_room_check','school_template_command_finish'))<>12 THEN
    RAISE EXCEPTION 'Unexpected school message template overload'; END IF;
END $$;
-- End school message templates exact verification.
-- Paper import AI reader exact verification (0594)
DO $$ DECLARE f text;
  entry text[]:=ARRAY['hon.begin_paper_ai_reading(text,uuid,jsonb,uuid,uuid)','hon.paper_ai_reading_planning_reference(text,uuid)',
    'hon.prepare_paper_ai_reading(text,uuid,uuid,boolean)','hon.fail_paper_ai_reading(text,uuid,text,text)',
    'hon.record_paper_ai_reading(text,uuid,jsonb,uuid,uuid)','hon.type_paper_import_rows(text,uuid,jsonb,uuid,uuid)'];
  helpers text[]:=ARRAY['hon.ai_plan_document_reading_guard()','hon.paper_reading_proposal_id(uuid)','hon.paper_import_note(uuid,text,uuid,uuid,uuid)',
    'hon.paper_reading_ai_actor(text)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe paper import AI reader entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe paper import AI reader helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.ai_invocation_plans'::regclass AND tgname='ai_plan_document_reading_guard' AND tgenabled='O') THEN
    RAISE EXCEPTION 'The READ_DOCUMENT plan guard is missing'; END IF;
END $$;
-- End paper import AI reader exact verification.
-- Family checkout orders exact verification (0598): private scope, pricing and JSON helpers, the order guard, the settle trigger, four runtime entry
-- points, a private forced-RLS table the runtime can never touch directly and a code-owned recorder with no authority.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.guard_family_checkout_order()',false,false,'search_path=pg_catalog, hon','b94be91e0945babfde4fa50de55de7e3f8936c551819e7aa1e707abaf3116ae6'),
('hon.family_checkout_scope(text,boolean)',true,false,'search_path=pg_catalog, hon','bd6f2f585a00c022eaf6d377b850e3c31b2ba8cee01f56cac1595afdb8bee65e'),
('hon.family_checkout_children(uuid,uuid,uuid)',true,false,'search_path=pg_catalog, hon','0a850378057a26f6d042d93cb628bfac5859ad98c9e46941664207022ff4f024'),
('hon.family_checkout_today(uuid)',true,false,'search_path=pg_catalog, hon','1bdf40cdc2f388d05b59ed362e36f8c4d2e884a56b8a7160a48e820acec77ff9'),
('hon.family_checkout_payment_live(uuid)',true,false,'search_path=pg_catalog, hon','40aac4e954dd3fcaef015d5ed376f6a33052b2b44de11bdb48ecb445025467d7'),
('hon.family_checkout_taken(uuid,text)',true,false,'search_path=pg_catalog, hon','2b76b11f28482c6aa4525e672d04493f1cd2e4ccee24c7732b270f96e22c597b'), -- as replaced by 0627 (counts share link orders too)
('hon.family_checkout_en(jsonb)',false,false,'search_path=pg_catalog','da5ca1a25665cf3ae73afa608fa02312ae429ba84b6adf1ffa45d1e53c39e14f'),
('hon.family_checkout_option_open(jsonb,date)',false,false,'search_path=pg_catalog','3b42c14450b2af600556f766fe47a3fe6ecf1a4aadb4de9cc2b0740dd58a1406'),
('hon.family_checkout_page_json(hon.school_checkouts,date)',true,false,'search_path=pg_catalog, hon','4aca0835d5db9cb6f5257666fd49dbc2bb04b01943b18faabb7ead6a037f99ec'),
('hon.family_checkout_order_json(hon.family_checkout_orders)',true,false,'search_path=pg_catalog, hon','bec6d97a138180fe466116027da71aa9db52776b23063afa481c178a176ff47a'),
('hon.read_parent_checkout_pages(text)',true,true,'search_path=pg_catalog, hon','f8aa7fccb2a127efd7df4215e0e0b1078549abb30b2e8e6536ae5411804d9a0b'),
('hon.open_parent_checkout_order(text,jsonb,text)',true,true,'search_path=pg_catalog, hon','0da0550bb87570fd013335c8a7f3d0b76281189e3ca911ec710ab119572b77cb'),
('hon.read_parent_checkout_order(text,uuid)',true,true,'search_path=pg_catalog, hon','089e8ae5a6919b83a6b9b82a88b9453c1f207181a408f13ca76c3edf3d4db17f'),
('hon.read_school_checkout_orders(text)',true,true,'search_path=pg_catalog, hon','edbe690a207b58e5fdfa66efbc513e3f5aea4edcca552c0cd95b4b0e9bbf6a55'),
('hon.settle_family_checkout_order()',true,false,'search_path=pg_catalog, hon','a4d3737562232b647cafedc9f99b8acb46d3ec54b5ee690639872007b49da56e')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe family checkout function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.family_checkout_orders'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.family_checkout_orders'::regclass)
    OR has_table_privilege('hon_runtime','hon.family_checkout_orders','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.family_checkout_orders','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe family checkout orders table'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.family_checkout_orders'::regclass AND NOT tgisinternal AND tgenabled='O'
      AND ((tgname='family_checkout_orders_guard' AND tgfoid='hon.guard_family_checkout_order()'::regprocedure)
        OR (tgname='family_checkout_orders_no_truncate' AND tgfoid='hon.guard_membership_activation_evidence()'::regprocedure)))<>2
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.family_checkout_orders'::regclass AND NOT tgisinternal)<>2 THEN
    RAISE EXCEPTION 'hon.family_checkout_orders must carry exactly its two guards'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.school_pay_once'::regclass AND tgname='family_checkout_settle'
      AND tgfoid='hon.settle_family_checkout_order()'::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Missing family checkout settle trigger'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000582' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL)
    OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000582')
    OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id='00000000-0000-4000-8000-000000000582')
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id='00000000-0000-4000-8000-000000000582') THEN
    RAISE EXCEPTION 'The family checkout order recorder must be a code-owned service with no authority'; END IF;
END $$;
-- End family checkout orders exact verification.

-- Shopify merch AI ideas exact verification (0596): the MERCH_IDEAS kind row on the shared AI text proposals (0550), the
-- closed brief and answer shapes, the private authority, facts and view helpers, and the seven runtime entry points.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.begin_shopify_merch_ideas(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','74497d61d966dc3995e267b69b8a55aec23664b1d42d3a83e9557f89a1214257'),
('hon.close_shopify_merch_ideas(text,uuid,text)',true,true,'search_path=pg_catalog, hon','fad059daacdad94ab0447391ad0e8ec607aa17f984f80d77bd0b6b0db5ab8d73'),
('hon.fail_shopify_merch_ideas(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','15e79a69ec549f3e59b2492039c0130f0793f190824fddb1263a9c5689e4ad87'),
('hon.prepare_shopify_merch_ideas(text,uuid,uuid,boolean)',true,true,'search_path=pg_catalog, hon','260b38d97bf4ba28c21c1736073f56d1a2bcd93e0d8e0990efb49aff6f0df220'),
('hon.read_shopify_merch_ideas(text,uuid)',true,true,'search_path=pg_catalog, hon','ed965695d7dee5a5061d615ef6a1f58d3ad24cd0b87b1ab0f749d9fbbd74bbfc'),
('hon.record_shopify_merch_ideas(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','f9b7cff52e04cde057d9c45d227a655179d198c834da8c36b24c56ec2974aee8'),
('hon.plan_shopify_merch_ideas(text,uuid)',true,true,'search_path=pg_catalog, hon','8ed1020ee0bd464b9121ed83f66559d063de11802030df7dcf0f15dd47b1fbef'),
('hon.shopify_merch_ai_actor(text)',true,false,'search_path=pg_catalog, hon','6b4bfc609c2515784d441e8e10e13ca68e8529c48ae9b889ab95a4845a84b582'),
('hon.shopify_merch_ai_facts(jsonb,uuid)',true,false,'search_path=pg_catalog, hon','27619b0084c24ed5871006eef2c379cdad247191ea69f584ad1825ae968441ff'),
('hon.shopify_merch_ai_reader(text)',true,false,'search_path=pg_catalog, hon','936c85ab00504181ff469620a89f6ae367ef135dc3c082d1231e754cc8937243'),
('hon.shopify_merch_ai_view(uuid,uuid)',true,false,'search_path=pg_catalog, hon','d34e69258f1c91bcd82737b230fe4a5553c9ac1cd4104aa9dba1ae671669449f'),
('hon.shopify_merch_brief_ok(jsonb)',false,false,'search_path=pg_catalog, hon','6f052b10309fb4b20549fe23d0f73d645658dd53c6086bfccee73fa0ffbe9647'),
('hon.shopify_merch_ideas_ok(jsonb)',false,false,'search_path=pg_catalog, hon','5b95d879b9138c63bf7df2f882262b483eab78e77047c98bba0e5d5c7eb27970'),
('hon.shopify_merch_keys_are(jsonb,text[])',false,false,'search_path=pg_catalog','7556a96f17a68188dd305a64c9279afd187b13bee9774d8bbdfc6d7fd4a64547'),
('hon.shopify_merch_kinds()',false,false,'search_path=pg_catalog','eddd559534ff456e765791368587c0ade5a8118fee60b3c00525f43c2ea9c184'),
('hon.shopify_merch_styles()',false,false,'search_path=pg_catalog','912ab927daf35e3d494e2cbf105504c7da9b5fd7fe332b013f111d38318e3e4d'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (NOT f.definer OR owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Shopify merch AI function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_kinds k WHERE k.kind='MERCH_IDEAS' AND k.agent_key='marcus' AND k.task_class='DRAFT_MARKETING'
      AND k.input_budget=6000 AND k.output_budget=3000 AND k.max_cost_microunits=80000 AND k.max_result_bytes=12288
      AND k.caller='HUMAN_UI' AND k.subject_type='SHOPIFY_STORE' AND k.usage_agent='MERCH_IDEAS') THEN
    RAISE EXCEPTION 'Shopify merch AI kind row missing or changed';
  END IF;
END $$;
-- End Shopify merch AI ideas exact verification.

-- Shopify finance exact verification (0597, SH-F1): two runtime entry points and one worker function (definer,
-- owner-safe, exact bodies); the snapshot table is forced-RLS with no policy and no runtime privilege; every new helper
-- and the end-of-connection trigger stay closed.
DO $$ DECLARE f text; t text; w oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_communication_worker');
  entry text[]:=ARRAY['hon.read_shopify_finance(text,uuid)','hon.record_shopify_finance(text,jsonb)'];
BEGIN
  FOR f,t IN SELECT * FROM (VALUES ('hon.read_shopify_finance(text,uuid)','3b71e5deb62e9a4de6689e496d9ab071'),('hon.record_shopify_finance(text,jsonb)','ec69aca61bc28659aedcc3f6df3c32f1'),
      ('hon.record_shopify_background_finance(jsonb)','cc5d78c2e1ba8c5fbd7b4f805e24af67'),('hon.shopify_apply_finance(hon.shopify_syncs,jsonb)','1bafe76ede8da2415192eb1fdc1b1fd0'),
      ('hon.shopify_finance_ok(jsonb)','49145981c791aeb25cdd0f4da3c07422'),('hon.shopify_finance_on_end()','aa8d7f4bfa62d3bad802ea885f672aec')) v LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM t THEN RAISE EXCEPTION 'Shopify finance function body drift: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe Shopify finance entry point: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='hon.record_shopify_background_finance(jsonb)'::regprocedure
      AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND NOT has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
        AND (a.is_grantable OR a.grantee IS DISTINCT FROM w))) THEN
    RAISE EXCEPTION 'Unsafe Shopify finance worker function'; END IF;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND p.proname IN ('shopify_finance_on_end','shopify_signed_money_ok','shopify_currency_ok','shopify_finance_ok','shopify_apply_finance') LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe Shopify finance helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.shopify_finance'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.shopify_finance'::regclass)
    OR has_table_privilege('hon_runtime','hon.shopify_finance','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.shopify_finance','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe Shopify finance table'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgenabled='O' AND (
      (tgrelid='hon.shopify_finance'::regclass AND tgname='shopify_finance_no_truncate' AND tgfoid='hon.guard_shopify()'::regprocedure)
      OR (tgrelid='hon.shopify_connections'::regclass AND tgname='shopify_connection_finance_end' AND tgfoid='hon.shopify_finance_on_end()'::regprocedure))) <> 2 THEN
    RAISE EXCEPTION 'Shopify finance triggers missing'; END IF;
END $$;
-- End Shopify finance exact verification.

-- Shopify storefront blocks exact verification (0609, TB2): the 0600 theme draft objects are gone; five runtime entry points
-- (definer, owner-safe, exact bodies); the table forced-RLS with no policy and no runtime privilege; the end-of-connection
-- trigger and every helper stay closed.
DO $$ DECLARE f text; t text;
  entry text[]:=ARRAY['hon.read_shopify_storefront(text,uuid)','hon.save_shopify_storefront(text,jsonb)',
    'hon.begin_shopify_storefront_publish(text,jsonb)','hon.rotate_shopify_storefront_credential(text,jsonb)',
    'hon.finish_shopify_storefront_publish(text,jsonb)'];
BEGIN
  IF to_regclass('hon.shopify_theme_drafts') IS NOT NULL OR to_regclass('hon.shopify_theme_edits') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon'
      AND (p.proname LIKE '%shopify_theme%' OR p.proname='guard_shopify_theme_edit')) THEN
    RAISE EXCEPTION 'Retired Shopify theme draft objects still present'; END IF;
  FOR f,t IN SELECT * FROM (VALUES
    ('hon.begin_shopify_storefront_publish(text,jsonb)','8210e62b007e22f632e58018df5e6f75'),
    ('hon.finish_shopify_storefront_publish(text,jsonb)','03b33ede60a7c6c1659bbb6514635164'),
    ('hon.read_shopify_storefront(text,uuid)','9330abfc892a6b516ff58de71f0cbb3b'),
    ('hon.rotate_shopify_storefront_credential(text,jsonb)','62c7d37465cec0291df0721eb1ce76e1'),
    ('hon.save_shopify_storefront(text,jsonb)','9983c73ed6ad1c07f8ad2700fedd9135'),
    ('hon.shopify_storefront_leased(uuid,uuid,jsonb)','9adc2553349d84f62770148622a97d63'),
    ('hon.shopify_storefront_locked(uuid)','10a31c56278de690ab7ff5f403c81eea'),
    ('hon.shopify_storefront_on_end()','c48bd1eec43e4d2768fd5a74df1796eb'),
    ('hon.shopify_storefront_settings_ok(jsonb)','92c570e3a4c0197eff1b190f6ce48257')
  ) v LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM t THEN RAISE EXCEPTION 'Shopify storefront function body drift: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe Shopify storefront entry point: %',f; END IF;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND p.proname IN ('shopify_storefront_on_end','shopify_storefront_settings_ok','shopify_storefront_locked','shopify_storefront_leased') LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe Shopify storefront helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.shopify_storefronts'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.shopify_storefronts'::regclass)
    OR has_table_privilege('hon_runtime','hon.shopify_storefronts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.shopify_storefronts','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe Shopify storefront table'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgenabled='O' AND (
      (tgrelid='hon.shopify_storefronts'::regclass AND tgname='shopify_storefronts_no_truncate' AND tgfoid='hon.guard_shopify()'::regprocedure)
      OR (tgrelid='hon.shopify_connections'::regclass AND tgname='shopify_connection_storefront_end' AND tgfoid='hon.shopify_storefront_on_end()'::regprocedure))) <> 2 THEN
    RAISE EXCEPTION 'Shopify storefront triggers missing'; END IF;
END $$;
-- End Shopify storefront blocks exact verification.
-- Shopify fulfilment source exact verification (0611, PD1): the variant column, the five replaced bodies (same owners and
-- grants as before) and the closed name check.
DO $$ DECLARE f text; t text; BEGIN
  FOR f,t IN SELECT * FROM (VALUES
    ('hon.read_shopify(text,uuid)','59c86c55bb79b7cc72c45897ad6fbd24'),
    ('hon.read_shopify_catalog(text,uuid)','ff8903d4c5a8c5b4a6c782d581a9ac03'),
    ('hon.shopify_apply_page(hon.shopify_syncs,text,jsonb)','2ffd726a505c3c3e53e7794d2dae2cb7'),
    ('hon.shopify_fulfilled_by_ok(jsonb)','5e24ca2eccbdd2526bd3ca66bcacb4c7'),
    ('hon.shopify_mirror_product(uuid,jsonb,uuid)','8d4eced3cba45ff543e20e4b4cd21349'),
    ('hon.shopify_product_item_ok(jsonb)','7d19d001397ad8f916dab5e710e6d981')
  ) v LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=f::regprocedure) IS DISTINCT FROM t THEN RAISE EXCEPTION 'Shopify fulfilment source function body drift: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.read_shopify(text,uuid)','hon.read_shopify_catalog(text,uuid)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe Shopify read entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.shopify_apply_page(hon.shopify_syncs,text,jsonb)','hon.shopify_fulfilled_by_ok(jsonb)',
      'hon.shopify_mirror_product(uuid,jsonb,uuid)','hon.shopify_product_item_ok(jsonb)'] LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe Shopify fulfilment source helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='hon.shopify_variants'::regclass AND attname='fulfilled_by' AND atttypid='text'::regtype
      AND NOT attnotnull AND NOT attisdropped)
    OR has_any_column_privilege('hon_runtime','hon.shopify_variants','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe Shopify fulfilment source column'; END IF;
END $$;
-- End Shopify fulfilment source exact verification.
-- Parent announcement push exact verification (0601): private token check, guards, live-person check and scope, two runtime entry points,
-- four worker functions only the communication worker may run, and three private forced-RLS tables nobody else can touch.
DO $$ DECLARE f record; safe boolean; t text; worker oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_communication_worker'); BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.parent_push_token_ok(text)',false,false,false,'search_path=pg_catalog','64cbc11052ab6aea74186b1cc9f1ddda87b6ce97d9687f2ac7aec64ba4cee53e'),
('hon.guard_parent_push_device()',false,false,false,'search_path=pg_catalog, hon','9e4b082ee1cd84b0e6c0d641f47262f202bac913b1ac8191668231dcadaec68f'),
('hon.guard_parent_push_delivery()',false,false,false,'search_path=pg_catalog, hon','f5f0de8787da8e66af5eb4e605d7d1276412b89e8af891ab16a1383a2d82cb65'),
('hon.parent_push_principal_live_at(uuid,uuid,uuid)',true,false,false,'search_path=pg_catalog, hon','12522dac7d3a7f73efa11a8ffb18e62b05daa24e957fd2cf55aa466c9f39287c'),
('hon.parent_push_scope(text)',true,false,false,'search_path=pg_catalog, hon','cc23b80a7a54efa4359ef77b38469c30ca57e15d5e0959a456716b209f2db3da'),
('hon.register_parent_push_device(text,jsonb,text,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','8915741e9c7ef45d4ae8bc9ed811a5c1e08ba69a88f8abe8b726e785d07463e3'),
('hon.unregister_parent_push_device(text,jsonb,text,uuid,uuid)',true,true,false,'search_path=pg_catalog, hon','a6cdc2689ee4d07f94e7a6dd9d55ec756a8c542ad1be33d42116cf4fc63944bd'),
('hon.claim_parent_push_deliveries(integer,integer)',true,false,true,'search_path=pg_catalog, hon','d78a85c7badb6b092ef16d496efa75c9bcbb2cff850d36f6abed9b5b41a8300f'),
('hon.record_parent_push_send(uuid,uuid,jsonb)',true,false,true,'search_path=pg_catalog, hon','8afe507bc68fbc6ffb10914d177b1dd1c9c3da5d75c722af68212afc6a53b10f'),
('hon.claim_parent_push_receipts(integer,integer)',true,false,true,'search_path=pg_catalog, hon','2e3117cf7b3871cc70474e3db0db52b46199050571971c53146ff74b09c8c4c5'),
('hon.record_parent_push_receipt(uuid,uuid,jsonb)',true,false,true,'search_path=pg_catalog, hon','01287d5d3efbe246579bc5b8e0fe56e7d3d9ef0eac886ae79990ecddc80fcccf')) e(signature,definer,runtime_allowed,worker_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND NOT (a.privilege_type='EXECUTE' AND NOT a.is_grantable
          AND ((a.grantee=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') AND f.runtime_allowed)
            OR (a.grantee=worker AND f.worker_allowed))))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe parent push function: %',f.signature; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['parent_push_devices','parent_push_fanouts','parent_push_deliveries'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES')
      OR (worker IS NOT NULL AND (has_table_privilege(worker,'hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(worker,'hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES'))) THEN
      RAISE EXCEPTION 'Unsafe parent push table: %',t; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.parent_push_devices'::regclass AND NOT tgisinternal AND tgenabled='O'
      AND ((tgname='parent_push_devices_guard' AND tgfoid='hon.guard_parent_push_device()'::regprocedure)
        OR (tgname='parent_push_devices_no_truncate' AND tgfoid='hon.guard_membership_activation_evidence()'::regprocedure)))<>2
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.parent_push_devices'::regclass AND NOT tgisinternal)<>2 THEN
    RAISE EXCEPTION 'hon.parent_push_devices must carry exactly its two guards'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.parent_push_deliveries'::regclass AND NOT tgisinternal AND tgenabled='O'
      AND ((tgname='parent_push_deliveries_guard' AND tgfoid='hon.guard_parent_push_delivery()'::regprocedure)
        OR (tgname='parent_push_deliveries_no_truncate' AND tgfoid='hon.guard_membership_activation_evidence()'::regprocedure)))<>2
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.parent_push_deliveries'::regclass AND NOT tgisinternal)<>2 THEN
    RAISE EXCEPTION 'hon.parent_push_deliveries must carry exactly its two guards'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.parent_push_fanouts'::regclass AND NOT tgisinternal AND tgenabled='O'
      AND tgfoid='hon.guard_membership_activation_evidence()'::regprocedure AND tgname IN ('parent_push_fanouts_immutable','parent_push_fanouts_no_truncate'))<>2
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.parent_push_fanouts'::regclass AND NOT tgisinternal)<>2 THEN
    RAISE EXCEPTION 'hon.parent_push_fanouts must carry exactly its two guards'; END IF;
END $$;
-- End parent announcement push exact verification.
-- Parent attendance streaks exact verification (0602): two private helpers and one runtime read of each child's weekly streak.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.parent_attendance_streak_scope(text)',true,false,'search_path=pg_catalog, hon','6413c080d2e14db63dd517c3027500079ee5c073b237b93b9435e091ab875f62'),
('hon.parent_attendance_streak_weeks(uuid,uuid,uuid,text)',true,false,'search_path=pg_catalog, hon','4c942048bb09e27adfd2a3a1bc366bf7cd7d8655457c5cb88244a355c89d3cde'),
('hon.read_parent_attendance_streaks(text)',true,true,'search_path=pg_catalog, hon','2fe1c204603de05035fa4d7de6e65a0f823c748b70008bc86e541f5d9f17a03d')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe parent attendance streak function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End parent attendance streaks exact verification.
-- Journey recommendations exact verification (0603): private text, scope, trigger, target and JSON helpers, the write guard,
-- four runtime entry points and a private forced-RLS table the runtime can never touch directly.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.journey_text_ok(text,integer,boolean)',false,false,'search_path=pg_catalog','487d7c7babea664218269d815a700aac4d150be754140579a07a4c7a75da4105'),
('hon.guard_journey_recommendation()',false,false,'search_path=pg_catalog, hon','abc6726b50a8de8c1f3e34f78406c1bbc76d3334f2b1d13407e881917a89c749'),
('hon.require_journey_recommendations_actor(text)',true,false,'search_path=pg_catalog, hon','4caf74d5f2dad4fa50d2e2ed13d64cf4f7fba168761391026d19ce5097f17e1d'),
('hon.journey_recommendation_parent_scope(text)',true,false,'search_path=pg_catalog, hon','5a50751fab0cc4acd883e5890cdf207d0de9f738ad5a5fb15c07aaad169e6a7b'),
('hon.journey_checkout_title(uuid,uuid,uuid)',true,false,'search_path=pg_catalog, hon','72a68723c7f937d41517b5ce3c3887f5235563967faacaeba6ed0de508090b33'),
('hon.journey_event_title(uuid,uuid,uuid)',true,false,'search_path=pg_catalog, hon','48de16efc9b7ca01bf9df2055d3e9ab1500f74237a234e24817d4d5f1f1b280f'),
('hon.journey_recommendation_reached(hon.journey_recommendations,hon.student_curriculum_enrollments)',true,false,'search_path=pg_catalog, hon','1277bbbd3f46cea65d994f1a7161fecdfeb5b6ff5fa24c2675592a0bb5747e58'),
('hon.journey_child_signed_up(hon.journey_recommendations,uuid)',true,false,'search_path=pg_catalog, hon','325bc4ea04d1eb73bfff6610cb63ad1097002ecec7f745cd1f4c5db493b66e13'),
('hon.journey_recommendation_staff_json(hon.journey_recommendations)',true,false,'search_path=pg_catalog, hon','8fcdd822892ac24edb871c1ec3d93bdc60fcde003e471795afbd83508e377566'),
('hon.read_parent_journey_recommendations(text)',true,true,'search_path=pg_catalog, hon','bd19ca704cb6c0e49ea57c5110bdc425c91557b56e8ec23d9a92c041f4cc108a'),
('hon.read_journey_recommendations(text)',true,true,'search_path=pg_catalog, hon','6869676977b79340531b0272bc689f96c658c1a3b04c12ebf883992e1527f496'),
('hon.save_journey_recommendation(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','13bb3676bfed9b04f738437f3468bdbf4a751bd0686ce5e8ef685599af4660f3'),
('hon.set_journey_recommendation_status(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','7f557467fb7287a257d9b3c5a947abff8bc830c85de74830b742100aab5323b1')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe journey recommendation function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.journey_recommendations'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.journey_recommendations'::regclass)
    OR has_table_privilege('hon_runtime','hon.journey_recommendations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.journey_recommendations','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe journey recommendations table'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.journey_recommendations'::regclass AND NOT tgisinternal AND tgenabled='O'
      AND ((tgname='journey_recommendations_guard' AND tgfoid='hon.guard_journey_recommendation()'::regprocedure)
        OR (tgname='journey_recommendations_no_truncate' AND tgfoid='hon.guard_membership_activation_evidence()'::regprocedure)))<>2
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.journey_recommendations'::regclass AND NOT tgisinternal)<>2 THEN
    RAISE EXCEPTION 'hon.journey_recommendations must carry exactly its two guards'; END IF;
END $$;
-- End journey recommendations exact verification.
-- Family referrals exact verification (0604): private helpers, seven runtime entry points, five private forced-RLS tables with guards.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.guard_family_referral_rows()',false,false,'search_path=pg_catalog, hon','314dbb05287e2da471a2d27f6bbd457e853aa191978eeed30d45f895f8d13129'),
('hon.require_school_referral_actor(text,text)',true,false,'search_path=pg_catalog, hon','c395db828dc9d575c4a1151fcb12a5385082c151e9602c5bdb22e1c1e66f7564'),
('hon.school_referral_program_json(uuid,uuid)',true,false,'search_path=pg_catalog, hon','efe55fdb5e464dbf5fe930dcee5ebf11c7bd0791f77f85fa829561bd5650eb3b'),
('hon.family_referral_display(text,integer)',false,false,'search_path=pg_catalog','6dc48e9e62534fc012adb7097fdb9d0203a552406f4d5ff55ea192ef568018e5'),
('hon.family_referral_staff_json(hon.family_referrals)',true,false,'search_path=pg_catalog, hon','688d5c38e68fd953ffda0e816dc111506437bcb56e5fcaa7e3199dd58adfb68f'),
('hon.read_school_referrals(text)',true,true,'search_path=pg_catalog, hon','76faec5648dd6c39863949e19a979c137ec54b8b4141d276c44b6981d830ab8a'),
('hon.family_referral_text(jsonb,integer,boolean,boolean)',false,false,'search_path=pg_catalog, hon','e96404e895a33453e004fa0222a57400a567b653c4d1a441835cd6b569713d5e'),
('hon.school_referral_begin(uuid,text,text)',true,false,'search_path=pg_catalog, hon','bf47a32dbc1b55955eeee2a8578aff425495bf97e0ef1a1fe4cab3d1c652c853'),
('hon.configure_school_referral_program(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','213b829c0f405dedb5ecc32e5cc59f72bb1b91f21629f77de5e80ef1e51d2b80'),
('hon.decide_family_referral_reward(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','49bc7662589cfafaa175ababb0200e1bf8474d2f113779a11791158fdd2488ab'),
('hon.family_referral_scope(text,boolean)',true,false,'search_path=pg_catalog, hon','89e8f2752b69d789e4378e5ab0d280fe23cc64aba42ceade3a1756053b4aca07'),
('hon.family_referral_program_live(uuid,uuid)',true,false,'search_path=pg_catalog, hon','f2174d290592d96273549fec90962df90dda14698d5b9b0c09d69cb390ec9d64'),
('hon.read_parent_referrals(text)',true,true,'search_path=pg_catalog, hon','2131c70f19a59060657213e9670e6fc5c78a21e09aad0b5bc1b4ad5b236756ad'),
('hon.issue_parent_referral_link(text)',true,true,'search_path=pg_catalog, hon','668845de0109ee41aa7a4d71e39402a2b6b7dd6b749f9ff31700bcf61a69b640'),
('hon.family_referral_code_live(text)',true,false,'search_path=pg_catalog, hon','9e15fe83025265c6b96ac8c23087457383b9c6e8d1b0d979d420bdb7c0646271'),
('hon.read_public_referral(text)',true,true,'search_path=pg_catalog, hon','a478d2bee0d62fc94dd453a1ecd91bfb663f6101d242a873e65b5e195e5bb4a7'),
('hon.submit_family_referral(text,jsonb,text)',true,true,'search_path=pg_catalog, hon','98ccec2c2a43d5957172ec3b85dfef62192f4b3199aff3e335226aab93c6c238')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe family referral function: %',f.signature; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['school_referral_programs','school_referral_program_versions','school_referral_requests','family_referral_codes','family_referrals'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR has_table_privilege('hon_runtime',('hon.'||t)::regclass,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=('hon.'||t)::regclass AND NOT g.tgisinternal AND g.tgenabled='O'
        AND g.tgfoid IN ('hon.guard_family_referral_rows()'::regprocedure,'hon.guard_membership_activation_evidence()'::regprocedure))<>2 THEN
      RAISE EXCEPTION 'hon.% must be private, forced-RLS and carry exactly its two guards',t; END IF;
  END LOOP;
END $$;
-- End family referrals exact verification.
-- Parent app curriculum exact verification (0605): four private forced-RLS tables with their guards, the cycle column and constraints
-- on curriculum_resources, private helpers and two runtime entry points.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOREACH t IN ARRAY ARRAY['curriculum_cycles','curriculum_app_settings','curriculum_app_events','curriculum_app_requests'] LOOP
    SELECT c.relrowsecurity AND c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner)
      AND (SELECT count(*) FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal AND tgenabled='O')=2
      AND EXISTS(SELECT 1 FROM pg_roles WHERE oid=c.relowner AND (rolsuper OR rolbypassrls))
    INTO safe FROM pg_class c WHERE c.oid=to_regclass('hon.'||t);
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Parent app curriculum table must be private, guarded and FORCE RLS: %',t; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='hon.curriculum_resources'::regclass AND attname='cycle_id' AND atttypid='uuid'::regtype AND NOT attisdropped)
    OR EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a JOIN pg_class c ON c.oid=x.attrelid WHERE x.attrelid='hon.curriculum_resources'::regclass AND x.attname='cycle_id' AND a.grantee<>c.relowner)
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.curriculum_resources'::regclass AND conname='curriculum_resources_rank_or_cycle' AND convalidated AND pg_get_constraintdef(oid)='CHECK (((rank_id IS NULL) OR (cycle_id IS NULL)))')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.curriculum_resources'::regclass AND contype='f' AND convalidated AND confrelid='hon.curriculum_cycles'::regclass
      AND pg_get_constraintdef(oid)='FOREIGN KEY (cycle_id, curriculum_id, organization_id, school_id) REFERENCES hon.curriculum_cycles(id, curriculum_id, organization_id, school_id)')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.curriculum_resources'::regclass AND conname='curriculum_resources_kind_check' AND pg_get_constraintdef(oid)='CHECK ((kind = ANY (ARRAY[''VIDEO''::text, ''LINK''::text, ''DOCUMENT''::text])))')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.curriculum_app_requests'::regclass AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (organization_id, school_id, principal_id, idempotency_key)')
    OR NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='hon' AND indexname='curriculum_cycles_active_position')
    THEN RAISE EXCEPTION 'Unsafe parent app curriculum columns or constraints'; END IF;
  FOR f IN SELECT * FROM (VALUES
('hon.curriculum_app_name_ok(text,integer)',false,false,'a1e8ead3cc2218801959245c1b83b144db237137e4cb3cc8250783eeb03db2fa'),
('hon.guard_curriculum_cycle()',false,false,'aced90ebf3274d2ac8d6c99c022dfe06b93b093dd0418ccaaa39c0d0bd65b030'),
('hon.guard_curriculum_app_settings()',false,false,'dae65289a2524e7bc3c5e8f101b63d507b1f49f45ebad968fbc8db457076523d'),
('hon.curriculum_app_cycle_state(uuid,uuid,uuid)',false,false,'78428b8429dce5f1e483b5c02d72ae329ca93c321e0ba8841126c11915f03222'),
('hon.curriculum_app_projection(uuid,uuid,uuid)',false,false,'4578665ecabc0a7654500134a316a0392ebf273ae78ff6c3dadd0ef473831ff2'),
('hon.read_staff_parent_app_curriculum(text)',true,true,'27b9704064f7677dc7b60e3340ab0e8805db230c273d878666207760203aea52'),
('hon.mutate_parent_app_curriculum(text,text,uuid,uuid,jsonb,text,uuid,uuid)',true,true,'190242a1cedbe2166c2cb4b9786df614aa29de674ffacae496a09307f2935e6a')) e(signature,definer,runtime_allowed,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY['search_path=pg_catalog, hon']
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe parent app curriculum function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End parent app curriculum exact verification.

-- Closed days for families exact verification (0607): the private closed-day helper and the two kiosk trial helpers it now
-- filters (the parent booking helper is pinned in the 0329 section above); none is open to the runtime or PUBLIC.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.class_session_on_closed_day(hon.class_sessions)',true,'search_path=pg_catalog, hon','2000f8bf34d83a4d37fa6f60fcb8d2b134664f1936135bd758442edb7635ab26'),
('hon.walkin_trial_session_open(hon.class_sessions,jsonb,integer)',true,'search_path=pg_catalog, hon','5b8c0373220440eef3385662f7c53eaf73797567db95a42b124ce7148f637041'),
('hon.walkin_trial_classes(uuid,uuid,jsonb)',true,'search_path=pg_catalog, hon','1fca00badb3cdf18f727f7da46efccd8e3b1022d2c97ce9c954c72602bd40181')) e(signature,definer,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND NOT has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe closed-day function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End closed days for families exact verification.
-- Journey recommendation responses exact verification (0608): three private helpers (immutability guard, name rule, receipt),
-- two runtime entry points, the 0603 family read replaced to leave out hidden recommendations (hash above), and a private
-- forced-RLS table with exactly its two guards and its two once-only indexes.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.guard_journey_recommendation_response()',false,false,'search_path=pg_catalog','1f25c0e55ae475781467d2d48c98797f31001ec00c000d282e607a5a055c55e0'),
('hon.journey_child_name_ok(text)',false,false,'search_path=pg_catalog','82c93b3ee7656d0fa5c3ae878a2b431f1c977112cf75dff03dcb038ce3a2c041'),
('hon.journey_response_json(hon.journey_recommendation_responses,boolean)',false,false,'search_path=pg_catalog','2000bd7a8aa66228adafc90d547feff3a6008547e7ae9b2b382b8ba2af0db30c'),
('hon.respond_parent_journey_recommendation(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','b49a9c6439ff1f55d66145d161ecb19a576b6893a4b54fa8c701d0402556bc1f'),
('hon.read_journey_recommendation_interest(text)',true,true,'search_path=pg_catalog, hon','4db00330b9c19c2314878a0cea80df1c6ce8d6f2252897a0d2f4ad967cb8523c')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe journey recommendation response function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.journey_recommendation_responses'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.journey_recommendation_responses'::regclass)
    OR has_table_privilege('hon_runtime','hon.journey_recommendation_responses','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.journey_recommendation_responses','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe journey recommendation responses table'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.journey_recommendation_responses'::regclass AND NOT tgisinternal AND tgenabled='O'
      AND tgname IN ('journey_recommendation_responses_immutable','journey_recommendation_responses_no_truncate')
      AND tgfoid='hon.guard_journey_recommendation_response()'::regprocedure)<>2
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.journey_recommendation_responses'::regclass AND NOT tgisinternal)<>2 THEN
    RAISE EXCEPTION 'hon.journey_recommendation_responses must carry exactly its two guards'; END IF;
  IF (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='hon.journey_recommendation_responses'::regclass AND i.indisunique
      AND i.indisvalid AND i.indpred IS NOT NULL AND c.relname IN ('journey_recommendation_responses_hidden_once','journey_recommendation_responses_interest_once'))<>2 THEN
    RAISE EXCEPTION 'hon.journey_recommendation_responses must keep its once-only indexes'; END IF;
END $$;
-- End journey recommendation responses exact verification.
-- Parent app curriculum read exact verification (0610): the private child entries helper and two runtime entry points.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.curriculum_app_child_entries(uuid,uuid,uuid)',false,false,'450c5b748c2d87cdc3ee28b1277cdd2f656ea328044f95372abde1855c67918f'),
('hon.read_parent_curriculum_app(text,uuid)',true,true,'6e9cf6695959c60fedd87ef70dcafcbde2ef51a79e005f6d0bb7f5229e295a88'),
('hon.read_staff_parent_app_curriculum_preview(text,uuid)',true,true,'5ca6c27d9648f5d72d3d147ef019d1c98ff2f6348c922e8f781a219cde0c1820')) e(signature,definer,runtime_allowed,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY['search_path=pg_catalog, hon']
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe parent app curriculum read function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End parent app curriculum read exact verification.

-- Point of Sale exact verification (0612)
DO $$ DECLARE f text; t text; c text;
  entry text[]:=ARRAY['hon.read_pos(text,uuid)','hon.read_pos_sales(text,uuid,date,date)','hon.read_pos_sale(text,uuid,uuid)',
    'hon.save_pos_settings(text,jsonb,uuid)','hon.save_pos_item(text,jsonb,uuid)','hon.adjust_pos_stock(text,jsonb,uuid)',
    'hon.record_pos_sale(text,jsonb,uuid)','hon.refund_pos_sale(text,jsonb,uuid)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe point of sale entry point: %',f; END IF;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND (p.proname LIKE 'pos\_%' OR p.proname='guard_pos_evidence') LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe point of sale helper: %',f; END IF;
  END LOOP;
  -- Fixed bodies, search path and volatility for the entry points, the authority check and the evidence guard (0612; refund as replaced by 0613, read and sale by 0614).
  FOR f,t,c IN SELECT * FROM (VALUES
    ('hon.read_pos(text,uuid)','30418353e3a643057806870656d8af10','s'),
    ('hon.read_pos_sales(text,uuid,date,date)','f7f313cf6f4426fd3acae2e94f137dd4','s'),
    ('hon.read_pos_sale(text,uuid,uuid)','014b642fc8785f482c477c4fb3f8fbb5','s'),
    ('hon.save_pos_settings(text,jsonb,uuid)','d20a8db67825e726102b9d6a87fa76a6','v'),
    ('hon.save_pos_item(text,jsonb,uuid)','d17777ebf701687429c64f99f0d4af9f','v'),
    ('hon.adjust_pos_stock(text,jsonb,uuid)','cd3cb6a8cc2b3b80b1e96d1082a5445f','v'),
    ('hon.record_pos_sale(text,jsonb,uuid)','cfc576716745c998c0fc693120c489ed','v'),
    ('hon.refund_pos_sale(text,jsonb,uuid)','28f35e89bcfa719735deb88667f492da','v'),
    ('hon.pos_actor(text,uuid,boolean)','4e4876137aa85838c796c676d3cf784f','s'),
    ('hon.pos_begin(text,text,jsonb,uuid,boolean)','4b4dc8ca1142e6c63b2b02a4ee7a4777','v'),
    ('hon.pos_finish(text,boolean,uuid,uuid,uuid,text,uuid,text,text,uuid,integer,jsonb,jsonb,jsonb)','b31626085f6ac12a5b2f4bbb30f33244','v'),
    ('hon.guard_pos_evidence()','8de6f1c6547c3a2a67ccd35150776925','v')) x LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND md5(p.prosrc)=t AND p.provolatile=c
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND (f<>'hon.guard_pos_evidence()' OR NOT p.prosecdef)) THEN
      RAISE EXCEPTION 'Point of sale function body/posture drift: %',f; END IF;
  END LOOP;
  -- Every POS table keeps its row guard and its truncate guard, enabled and calling the evidence guard.
  FOREACH t IN ARRAY ARRAY['pos_settings','pos_items','pos_sales','pos_sale_lines','pos_refunds','pos_stock_moves','pos_requests'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgname=t||'_guard' AND tgfoid='hon.guard_pos_evidence()'::regprocedure AND tgenabled='O' AND NOT tgisinternal)
      OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgname=t||'_no_truncate' AND tgfoid='hon.guard_pos_evidence()'::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'Point of sale evidence guard missing: %',t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['pos_settings','pos_items','pos_sales','pos_sale_lines','pos_refunds','pos_stock_moves','pos_requests'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe point of sale table: %',t;
    END IF;
  END LOOP;
END $$;
-- End point of sale exact verification.

-- Point of Sale sells Shopify products exact verification (0613; rotate and the sale JSON as replaced by 0614)
DO $$ DECLARE f text; t text; c text; d boolean;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.begin_pos_shopify_stock(text,jsonb)','hon.rotate_pos_shopify_credential(text,jsonb)','hon.finish_pos_shopify_stock(text,jsonb)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe point of sale Shopify stock entry point: %',f; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='hon.guard_pos_shopify_stock_task()'::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
    RAISE EXCEPTION 'Unsafe point of sale Shopify stock guard'; END IF;
  FOR f,t,c,d IN SELECT * FROM (VALUES
    ('hon.begin_pos_shopify_stock(text,jsonb)','530a08e72d6c82b4bd2551fe15ec8fac','v',true),
    ('hon.rotate_pos_shopify_credential(text,jsonb)','c8f7ca14bc296164b8976a85b25a6a32','v',true),
    ('hon.finish_pos_shopify_stock(text,jsonb)','981da94f2c43499f4f3b1a047f6dc284','v',true),
    ('hon.pos_sale_json(hon.pos_sales)','d68a0b5ba6eb6f7ba99a3c847ab64c14','s',false),
    ('hon.pos_shopify_minor(numeric,text)','994396a441c8673b358ef5cbaea9e228','i',false),
    ('hon.pos_shopify_source(uuid,text)','650e195141e3f0932e333a39a14f8f48','s',false),
    ('hon.pos_shopify_stock_json(uuid)','a0373e2faad0411301d657e31fe50260','s',false),
    ('hon.pos_shopify_line_name(text,text)','dfc3f5d05160f392a2aa635a066eba90','i',false),
    ('hon.guard_pos_shopify_stock_task()','ee6d062f93f015e3e85beeb8f34bbfe4','v',false)) x LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND md5(p.prosrc)=t AND p.provolatile=c AND p.prosecdef=d
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']) THEN
      RAISE EXCEPTION 'Point of sale Shopify function body/posture drift: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.pos_shopify_stock_tasks'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.pos_shopify_stock_tasks'::regclass)
    OR has_table_privilege('hon_runtime','hon.pos_shopify_stock_tasks','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.pos_shopify_stock_tasks','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe point of sale Shopify stock table';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.pos_shopify_stock_tasks'::regclass AND tgfoid='hon.guard_pos_shopify_stock_task()'::regprocedure AND tgenabled='O' AND NOT tgisinternal)<2 THEN
    RAISE EXCEPTION 'Point of sale Shopify stock guard missing'; END IF;
END $$;
-- End point of sale sells Shopify products exact verification.

-- Point of Sale Shopify orders for made-to-order items exact verification (0614)
DO $$ DECLARE f text; t text; c text; d boolean;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.begin_pos_shopify_order(text,jsonb)','hon.finish_pos_shopify_order(text,jsonb)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe point of sale Shopify order entry point: %',f; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='hon.guard_pos_shopify_order()'::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
    RAISE EXCEPTION 'Unsafe point of sale Shopify order guard'; END IF;
  FOR f,t,c,d IN SELECT * FROM (VALUES
    ('hon.begin_pos_shopify_order(text,jsonb)','7f134ce7fbef271ba46f86c94f345af0','v',true),
    ('hon.finish_pos_shopify_order(text,jsonb)','b3c23b5a03a5e11bdf7952a99161600e','v',true),
    ('hon.pos_shopify_orders_ok(uuid)','886a387cf127d04240a08b597d28234a','s',false),
    ('hon.pos_ship_to_ok(jsonb)','8f987f0884d17664e919b666c29e24b4','i',false),
    ('hon.pos_school_ship_to(uuid)','7ac36e8534f8a586b5f57386a8b3df1d','s',false),
    ('hon.pos_shopify_order_json(uuid)','b65d444d621a517e620314794014e7c7','s',false),
    ('hon.shopify_connection_json(hon.shopify_connections)','679de615ef04b57aa83cd5b0b9572e83','s',false),
    ('hon.guard_pos_shopify_order()','c32ab6bc3564de2a9966fb61250b2c14','v',false)) x LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND md5(p.prosrc)=t AND p.provolatile=c AND p.prosecdef=d
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']) THEN
      RAISE EXCEPTION 'Point of sale Shopify order function body/posture drift: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.pos_shopify_orders'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.pos_shopify_orders'::regclass)
    OR has_table_privilege('hon_runtime','hon.pos_shopify_orders','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.pos_shopify_orders','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe point of sale Shopify order table';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.pos_shopify_orders'::regclass AND tgfoid='hon.guard_pos_shopify_order()'::regprocedure AND tgenabled='O' AND NOT tgisinternal)<2 THEN
    RAISE EXCEPTION 'Point of sale Shopify order guard missing'; END IF;
END $$;
-- End point of sale Shopify orders exact verification.

-- Shopify commerce review exact verification (0615): the COMMERCE_REVIEW kind row on the shared AI text proposals (0550), the
-- closed brief and answer shapes, the private facts and view helpers, and the seven runtime entry points.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.begin_shopify_commerce_review(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','0d95960ec52dd5695c664e822d4f5dc651b42ba94d871771dec322203135fc71'),
('hon.close_shopify_commerce_review(text,uuid,text)',true,true,'search_path=pg_catalog, hon','4618ff19142e10676a38aa91cf737c08c7954d90f68bacee033a6712482cf02a'),
('hon.fail_shopify_commerce_review(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','aa598288f3c91b509926be2ea7698bcb689f0f91a4229aa5769e4704b131dafe'),
('hon.plan_shopify_commerce_review(text,uuid)',true,true,'search_path=pg_catalog, hon','1f404ed988ef3a83d3fabd0da33229c0d2b4c7d5ce767a8e26a3d303a559e1b0'),
('hon.prepare_shopify_commerce_review(text,uuid,uuid,boolean)',true,true,'search_path=pg_catalog, hon','47c66f31877189d243287e7a73b71db4ba0c44e9dc432b6c2f983940edbdcecf'),
('hon.read_shopify_commerce_reviews(text,uuid)',true,true,'search_path=pg_catalog, hon','23fa6dfc69183f24fff889cdd2dffab8e11c5ecb8ec512006041c03f97b5a213'),
('hon.record_shopify_commerce_review(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','6bf77e8c7d32eea75e78a925d4c403a8bb55d2ce5e2ab30feac0eeae0063b9d3'),
('hon.shopify_review_areas()',false,false,'search_path=pg_catalog','2175abf1464e56c29e9a1b79b3f7f95b2bb15ab91510b822ad06a20e254f3667'),
('hon.shopify_review_brief_ok(jsonb)',false,false,'search_path=pg_catalog, hon','7eab52876983ef55014744ccc6aa5920553aebee600da154058811b20a2b6083'),
('hon.shopify_review_clip(text,integer)',false,false,'search_path=pg_catalog','b2e68069a2b7bebd740987d6827034655f18abf9149928ba0d80182f36494df6'),
('hon.shopify_review_facts(jsonb,uuid)',true,false,'search_path=pg_catalog, hon','0b71890ef2058cf18c6db78707e9c0608238852dab51f72a53b361b23260b5bd'),
('hon.shopify_review_focuses()',false,false,'search_path=pg_catalog','c832069dfd117640f3162a865b3fe2fd1d4da174f5a80e7c409ccaef95b083aa'),
('hon.shopify_review_ok(jsonb)',false,false,'search_path=pg_catalog, hon','3528aa0f161df542c930134169755ad628cf7c8b3dbbc23423eb158bf54d56e9'),
('hon.shopify_review_view(uuid,uuid)',true,false,'search_path=pg_catalog, hon','cb82660a02435e83c6749f16060db7a81fb99839d3da037e612c8b50ac81f46f'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (NOT f.definer OR owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Shopify commerce review function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_kinds k WHERE k.kind='COMMERCE_REVIEW' AND k.agent_key='marcus' AND k.task_class='DRAFT_MARKETING'
      AND k.input_budget=9000 AND k.output_budget=2500 AND k.max_cost_microunits=80000 AND k.max_result_bytes=12288
      AND k.caller='HUMAN_UI' AND k.subject_type='SHOPIFY_STORE' AND k.usage_agent='COMMERCE_REVIEW') THEN
    RAISE EXCEPTION 'Shopify commerce review kind row missing or changed';
  END IF;
END $$;
-- End Shopify commerce review exact verification.

-- Creative designs exact verification (D1 0617): six runtime entry points, fourteen private helpers, two forced-RLS tables.
DO $$ DECLARE f text; t text; c text; d boolean; s text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.read_school_creative_designs(text,jsonb)','hon.read_school_creative_design(text,jsonb)',
      'hon.read_school_creative_design_photo(text,jsonb)','hon.save_school_creative_design(text,jsonb,text,uuid,uuid)',
      'hon.set_school_creative_design_status(text,jsonb,text,uuid,uuid)','hon.add_school_creative_design_photo(text,jsonb,text,uuid,uuid)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure
        AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
      RAISE EXCEPTION 'Unsafe creative design entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.creative_design_size(text)','hon.creative_design_name_ok(text)','hon.creative_design_num_ok(jsonb,numeric,numeric)',
      'hon.creative_design_color_ok(jsonb,boolean)','hon.creative_design_document_ok(jsonb,text)','hon.guard_school_creative_design()',
      'hon.guard_school_creative_design_photo()','hon.require_creative_design_actor(text,text)',
      'hon.school_creative_design_summary(hon.school_creative_designs)','hon.school_creative_design_json(hon.school_creative_designs)',
      'hon.school_creative_design_photo_json(hon.school_creative_design_photos)','hon.creative_design_command_begin(text,text,jsonb,text,uuid,uuid)',
      'hon.creative_design_room_check(uuid,uuid,text,uuid,boolean)',
      'hon.creative_design_command_finish(uuid,text,text,uuid,integer,jsonb,jsonb,text,uuid,uuid,jsonb)'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND (a.grantee=0 OR a.grantee<>p.proowner)) THEN
      RAISE EXCEPTION 'Unsafe creative design helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['school_creative_designs','school_creative_design_photos'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
      OR EXISTS(SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner) THEN
      RAISE EXCEPTION 'Unsafe creative design table: %',t; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname IN ('read_school_creative_designs','read_school_creative_design',
      'read_school_creative_design_photo','save_school_creative_design','set_school_creative_design_status','add_school_creative_design_photo',
      'creative_design_size','creative_design_name_ok','creative_design_num_ok','creative_design_color_ok','creative_design_document_ok',
      'guard_school_creative_design','guard_school_creative_design_photo','require_creative_design_actor','school_creative_design_summary',
      'school_creative_design_json','school_creative_design_photo_json','creative_design_command_begin','creative_design_room_check',
      'creative_design_command_finish'))<>20 THEN
    RAISE EXCEPTION 'Unexpected creative design overload'; END IF;
  -- Fixed bodies, volatility, definer posture and search path for all twenty functions; the four triggers; the two permissions.
  FOR f,t,c,d,s IN SELECT * FROM (VALUES
    ('hon.add_school_creative_design_photo(text,jsonb,text,uuid,uuid)','c84a6898c76a425131a058a6d4d4b8c0','v',true,'search_path=pg_catalog, hon'),
    ('hon.creative_design_color_ok(jsonb,boolean)','25562d81844c7b71eeb8ae2c8f5ff25b','i',false,'search_path=pg_catalog'),
    ('hon.creative_design_command_begin(text,text,jsonb,text,uuid,uuid)','02101624f41d5a8b7d5ee847311f1969','v',true,'search_path=pg_catalog, hon'),
    ('hon.creative_design_command_finish(uuid,text,text,uuid,integer,jsonb,jsonb,text,uuid,uuid,jsonb)','8865de247715009e8a7f5256c47c303b','v',true,'search_path=pg_catalog, hon'),
    ('hon.creative_design_document_ok(jsonb,text)','2b26cb0c414b2cad8b47bd0d104827d5', -- 0703 designer fonts widen the font list
    'i',false,'search_path=pg_catalog, hon'),
    ('hon.creative_design_name_ok(text)','ffebbe46ce672527f3c5c739cf0ff358','i',false,'search_path=pg_catalog'),
    ('hon.creative_design_num_ok(jsonb,numeric,numeric)','69805e649e72a08c1b5ecf39fdc38d3f','i',false,'search_path=pg_catalog'),
    ('hon.creative_design_room_check(uuid,uuid,text,uuid,boolean)','189b08c18cb7903e8177f617ab98a80e','v',true,'search_path=pg_catalog, hon'),
    ('hon.creative_design_size(text)','dcc839466a21d65e41b6e8f124010b6d','i',false,'search_path=pg_catalog'),
    ('hon.guard_school_creative_design()','05cc55e1cf8b872f1a48e2fc2eeed81e','v',false,'search_path=pg_catalog, hon'),
    ('hon.guard_school_creative_design_photo()','a3940619cea59da7fbcf99eb771b8ae4','v',false,'search_path=pg_catalog, hon'),
    ('hon.read_school_creative_design(text,jsonb)','d946858e974190566327328a1708e5b4','v',true,'search_path=pg_catalog, hon'),
    ('hon.read_school_creative_design_photo(text,jsonb)','6e6c19cd0e858c6f5c2ef12b088941c5','v',true,'search_path=pg_catalog, hon'),
    ('hon.read_school_creative_designs(text,jsonb)','b6c79f7c6a964e0099e58365ec2eb061','v',true,'search_path=pg_catalog, hon'),
    ('hon.require_creative_design_actor(text,text)','8c2642ff6ab201d18405d03043c6866c','v',true,'search_path=pg_catalog, hon'),
    ('hon.save_school_creative_design(text,jsonb,text,uuid,uuid)','ee311fd597a5c17eb2a732ffed695017','v',true,'search_path=pg_catalog, hon'),
    ('hon.school_creative_design_json(hon.school_creative_designs)','f8a29b526cc55f1fecfcbb2b17abd458','s',false,'search_path=pg_catalog, hon'),
    ('hon.school_creative_design_photo_json(hon.school_creative_design_photos)','caa169fe20527e30a8285dac4bd3cdc6','s',false,'search_path=pg_catalog, hon'),
    ('hon.school_creative_design_summary(hon.school_creative_designs)','489cf997497f758271af1931aa8b0120','s',false,'search_path=pg_catalog, hon'),
    ('hon.set_school_creative_design_status(text,jsonb,text,uuid,uuid)','684236d0ef3c8aaebbf97983925f4f69','v',true,'search_path=pg_catalog, hon')) x(f,t,c,d,s) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND md5(p.prosrc)=t AND p.provolatile=c AND p.prosecdef=d
        AND p.proconfig IS NOT DISTINCT FROM ARRAY[s]) THEN
      RAISE EXCEPTION 'Creative design function body/posture drift: %',f; END IF;
  END LOOP;
  FOR t,f IN SELECT * FROM (VALUES ('school_creative_designs','hon.guard_school_creative_design()'),('school_creative_design_photos','hon.guard_school_creative_design_photo()')) x LOOP
    IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgfoid=f::regprocedure AND tgenabled='O' AND NOT tgisinternal
        AND tgname IN ('guard','no_truncate'))<>2 THEN
      RAISE EXCEPTION 'Creative design guard missing: %',t; END IF;
  END LOOP;
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('creative.design.read','creative.design.manage') AND NOT is_sensitive AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'Creative design permissions missing or changed'; END IF;
END $$;
-- End creative designs exact verification.

-- HQ Creative designs exact verification (0678): six runtime entry points, eight private helpers, three forced-RLS HQ-only tables.
DO $$ DECLARE f text; t text; c text; d boolean; s text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.read_hq_creative_designs(text,jsonb)','hon.read_hq_creative_design(text,jsonb)',
      'hon.read_hq_creative_design_photo(text,jsonb)','hon.save_hq_creative_design(text,jsonb,uuid)',
      'hon.set_hq_creative_design_status(text,jsonb,uuid)','hon.add_hq_creative_design_photo(text,jsonb,uuid)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure
        AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
      RAISE EXCEPTION 'Unsafe HQ creative design entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_hq_creative_design()','hon.guard_hq_creative_design_append()',
      'hon.hq_creative_design_summary(hon.hq_creative_designs)','hon.hq_creative_design_json(hon.hq_creative_designs)',
      'hon.hq_creative_design_photo_json(hon.hq_creative_design_photos)','hon.hq_creative_design_claim(uuid,uuid,text,text)',
      'hon.hq_creative_design_room_check(text,uuid,boolean)','hon.hq_creative_design_id(jsonb,text)'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND (a.grantee=0 OR a.grantee<>p.proowner)) THEN
      RAISE EXCEPTION 'Unsafe HQ creative design helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hq_creative_designs','hq_creative_design_photos','hq_creative_design_requests'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
      OR EXISTS(SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner) THEN
      RAISE EXCEPTION 'Unsafe HQ creative design table: %',t; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname IN ('read_hq_creative_designs','read_hq_creative_design',
      'read_hq_creative_design_photo','save_hq_creative_design','set_hq_creative_design_status','add_hq_creative_design_photo',
      'guard_hq_creative_design','guard_hq_creative_design_append','hq_creative_design_summary','hq_creative_design_json',
      'hq_creative_design_photo_json','hq_creative_design_claim','hq_creative_design_room_check','hq_creative_design_id'))<>14 THEN
    RAISE EXCEPTION 'Unexpected HQ creative design overload'; END IF;
  -- Fixed bodies, volatility, definer posture and search path for all fourteen functions; the six triggers.
  FOR f,t,c,d,s IN SELECT * FROM (VALUES
    ('hon.add_hq_creative_design_photo(text,jsonb,uuid)','5070255ade2619cde95961b002c3ab79','v',true,'search_path=pg_catalog, hon'),
    ('hon.guard_hq_creative_design()','33656e1ee12f1b2ec8aee7f557380c74','v',false,'search_path=pg_catalog, hon'),
    ('hon.guard_hq_creative_design_append()','a3940619cea59da7fbcf99eb771b8ae4','v',false,'search_path=pg_catalog, hon'),
    ('hon.hq_creative_design_claim(uuid,uuid,text,text)','c3f646d39ad2eae928be82d4f0a66b64','v',false,'search_path=pg_catalog, hon'),
    ('hon.hq_creative_design_id(jsonb,text)','cd403448b4d64a64366e1fd61e24d53f','i',false,'search_path=pg_catalog, hon'),
    ('hon.hq_creative_design_json(hon.hq_creative_designs)','42da293a47443515ee2b29f3c718730b','s',false,'search_path=pg_catalog, hon'),
    ('hon.hq_creative_design_photo_json(hon.hq_creative_design_photos)','caa169fe20527e30a8285dac4bd3cdc6','s',false,'search_path=pg_catalog, hon'),
    ('hon.hq_creative_design_room_check(text,uuid,boolean)','ca81f03b303e6f62ef5fc29a30bdfb72','v',false,'search_path=pg_catalog, hon'),
    ('hon.hq_creative_design_summary(hon.hq_creative_designs)','489cf997497f758271af1931aa8b0120','s',false,'search_path=pg_catalog, hon'),
    ('hon.read_hq_creative_design(text,jsonb)','b1e846e3603f0d471e6df192af12686d','v',true,'search_path=pg_catalog, hon'),
    ('hon.read_hq_creative_design_photo(text,jsonb)','028cf6bf5d19bae0b36bea5cc062b5a0','v',true,'search_path=pg_catalog, hon'),
    ('hon.read_hq_creative_designs(text,jsonb)','b80632eaa8cee317a5a0d17262ace358','v',true,'search_path=pg_catalog, hon'),
    ('hon.save_hq_creative_design(text,jsonb,uuid)','42a36b6a00ad54773cf9083dd5ef6976','v',true,'search_path=pg_catalog, hon'),
    ('hon.set_hq_creative_design_status(text,jsonb,uuid)','44997ae8a92acb595c0a5e0ea2e2e7f5','v',true,'search_path=pg_catalog, hon')) x(f,t,c,d,s) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND md5(p.prosrc)=t AND p.provolatile=c AND p.prosecdef=d
        AND p.proconfig IS NOT DISTINCT FROM ARRAY[s]) THEN
      RAISE EXCEPTION 'HQ creative design function body/posture drift: %',f; END IF;
  END LOOP;
  FOR t,f IN SELECT * FROM (VALUES ('hq_creative_designs','hon.guard_hq_creative_design()'),
      ('hq_creative_design_photos','hon.guard_hq_creative_design_append()'),('hq_creative_design_requests','hon.guard_hq_creative_design_append()')) x LOOP
    IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgfoid=f::regprocedure AND tgenabled='O' AND NOT tgisinternal
        AND tgname IN ('guard','no_truncate'))<>2 THEN
      RAISE EXCEPTION 'HQ creative design guard missing: %',t; END IF;
  END LOOP;
END $$;
-- End HQ Creative designs exact verification.

-- CRM trial authority hold exact verification (0629, launch-readiness P1): one runtime entry point, fixed body and posture.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='hon.hold_crm_trial_authority(text)'::regprocedure
      AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.provolatile='v' AND md5(p.prosrc)='6d0ab855befc8721fab5e656f4472c76'
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
    RAISE EXCEPTION 'Unsafe CRM trial authority hold'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname='hold_crm_trial_authority')<>1 THEN
    RAISE EXCEPTION 'Unexpected CRM trial authority hold overload'; END IF;
END $$;
-- End CRM trial authority hold exact verification.

-- Invoice INSERT status guard exact verification (0630, launch-readiness P2; body from 0644 H3, which never trusts platform API or HON runtime roles): private trigger function, one BEFORE INSERT trigger.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='hon.guard_invoice_insert_status()'::regprocedure
      AND NOT p.prosecdef AND p.provolatile='v' AND md5(p.prosrc)='7bd30dd8c232c7c4a866364b4cd602f1'
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
      AND NOT has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)) THEN
    RAISE EXCEPTION 'Unsafe invoice INSERT status guard function'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='hon.invoices'::regclass AND t.tgname='invoice_insert_status_guard'
      AND t.tgfoid='hon.guard_invoice_insert_status()'::regprocedure AND t.tgenabled='O' AND NOT t.tgisinternal
      AND t.tgtype=7) THEN
    RAISE EXCEPTION 'Missing or altered invoice INSERT status guard trigger'; END IF;
END $$;
-- End invoice INSERT status guard exact verification.

-- Class booking lock identity plane exact verification (0631, launch-readiness P2; body from 0644 H2, staff-assignable permission): the current body, unchanged posture and one overload.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='hon.lock_class_booking_session(text,uuid)'::regprocedure
      AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.provolatile='v' AND md5(p.prosrc)='b143b54fd8b1332e8eb75ab976b6232e'
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
    RAISE EXCEPTION 'Unsafe or pre-0644 class booking lock'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname='lock_class_booking_session')<>1 THEN
    RAISE EXCEPTION 'Unexpected class booking lock overload'; END IF;
END $$;
-- End class booking lock identity plane exact verification.
-- Class sessions function-only reads exact verification (0632, #177): no runtime SELECT on hon.class_sessions, two runtime reads, one private helper.
DO $$ DECLARE f record; BEGIN
  IF has_table_privilege('hon_runtime','hon.class_sessions','SELECT') OR has_any_column_privilege('hon_runtime','hon.class_sessions','SELECT')
    OR NOT has_table_privilege('hon_runtime','hon.class_sessions','INSERT') THEN
    RAISE EXCEPTION 'hon.class_sessions must be INSERT-only for the runtime (no table or column SELECT)'; END IF;
  FOR f IN SELECT * FROM (VALUES
    ('hon.require_class_sessions_human_read()',false,false,'s','2feaa0b10eff965b23ad924d24053946'),
    ('hon.read_operations_report_session_counts(text,timestamptz,timestamptz)',true,true,'s','8ea9cc990b7c068bc99be462370f75d1'),
    ('hon.read_parent_family_schedule(text,uuid,timestamptz,timestamptz)',true,true,'v','a59962d8713cd5785ec8823e3792aa49')
  ) x(signature,definer,runtime_execute,volatility,body) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f.signature::regprocedure
        AND p.prosecdef=f.definer AND (o.rolsuper OR o.rolbypassrls) AND p.provolatile::text=f.volatility AND md5(p.prosrc)=f.body
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_execute
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (NOT f.runtime_execute OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')
            OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
      RAISE EXCEPTION 'Unsafe class sessions read function %',f.signature; END IF;
  END LOOP;
END $$;
-- End class sessions function-only reads exact verification.
-- Owner-launch first booking lifecycle exact verification (0644 H1, launch-readiness P3): the 0644 body (refuses COMPLETED classes after the exact replay), unchanged posture and one overload.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='hon.book_owner_launch_first_class(text,jsonb,text,uuid,uuid)'::regprocedure
      AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.provolatile='v' AND md5(p.prosrc)='6e5f2c8926fa3a406aa9f4f2dbf3e2eb'
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
    RAISE EXCEPTION 'Unsafe or pre-0644 owner-launch first booking'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname='book_owner_launch_first_class')<>1 THEN
    RAISE EXCEPTION 'Unexpected owner-launch first booking overload'; END IF;
END $$;
-- End owner-launch first booking lifecycle exact verification.
-- Class session minimum duration exact verification (0645, launch-readiness [25]): one validated check of at least a minute.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.class_sessions'::regclass AND conname='class_sessions_minimum_duration'
      AND contype='c' AND convalidated
      AND pg_get_constraintdef(oid)=$def$CHECK (((ends_at - starts_at) >= '00:01:00'::interval))$def$) THEN
    RAISE EXCEPTION 'Missing or altered class session minimum duration'; END IF;
END $$;
-- End class session minimum duration exact verification.

-- Checkout page share links exact verification (0620): the link guard, the public page selector, two runtime entry points
-- (the public read's hash is the 0627 body, which adds the sign-up form fields)
-- (staff issue, public read) and a private forced-RLS table the runtime can never touch directly.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.guard_school_checkout_link()',false,false,'search_path=pg_catalog, hon','071402441db3e65d205c0be87068b7d33f91406ff6972b2f01c0ae1311b46438'),
('hon.public_school_checkout(text)',true,false,'search_path=pg_catalog, hon','714c0b62124bdbf42e8aaddfd339411ea0f161c6be2fbd7ab7d1231bb7701ff0'),
('hon.issue_school_checkout_links(text)',true,true,'search_path=pg_catalog, hon','146dfd67b4b4bf51555188fc805addfbdcfae316cea5769b47c77d59528da565'),
('hon.read_public_school_checkout(text)',true,true,'search_path=pg_catalog, hon','2d3f3be50332ff9b9ad66cec19d5f826794f95047fd9db7566f600fecdc33020')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe checkout page link function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.school_checkout_links'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.school_checkout_links'::regclass)
    OR has_table_privilege('hon_runtime','hon.school_checkout_links','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.school_checkout_links','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe checkout page links table'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.school_checkout_links'::regclass AND NOT tgisinternal AND tgenabled='O'
      AND ((tgname='school_checkout_links_guard' AND tgfoid='hon.guard_school_checkout_link()'::regprocedure)
        OR (tgname='school_checkout_links_no_truncate' AND tgfoid='hon.guard_membership_activation_evidence()'::regprocedure)))<>2
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.school_checkout_links'::regclass AND NOT tgisinternal)<>2 THEN
    RAISE EXCEPTION 'hon.school_checkout_links must carry exactly its two guards'; END IF;
END $$;
-- End checkout page share links exact verification.
-- School blasts exact verification (0621)
DO $$ DECLARE f text; t text;
  entry text[]:=ARRAY['hon.save_school_blast(text,jsonb,text,uuid,uuid)','hon.send_school_blast(text,jsonb,text,uuid,uuid)',
    'hon.cancel_school_blast(text,jsonb,text,uuid,uuid)','hon.read_school_blasts(text)','hon.read_school_blast(text,uuid)','hon.read_school_blast_audience(text,uuid)'];
  helpers text[]:=ARRAY['hon.school_blast_text_ok(jsonb,integer,integer)','hon.school_blast_line_ok(jsonb,integer)','hon.school_blast_audience_ok(jsonb)',
    'hon.guard_school_blast()','hon.require_school_blast_actor(text,text)','hon.school_blast_address(text,text,text)',
    'hon.school_blast_resolve(uuid,uuid,text,jsonb)','hon.school_blast_render(text,text,text,text,text)','hon.school_blast_json(hon.school_blasts)',
    'hon.school_blast_summary_json(hon.school_blasts)','hon.school_blast_begin(text,text,jsonb,text,uuid)',
    'hon.school_blast_finish(text,text,uuid,text,hon.school_blasts,jsonb,uuid,uuid)'];
  tables text[]:=ARRAY['hon.school_blasts','hon.school_blast_recipients'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe school blast entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe school blast helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=t::regclass)
      OR has_table_privilege('hon_runtime',t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime',t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe school blast table: %',t; END IF;
  END LOOP;
  IF (SELECT count(*) FROM hon.permissions WHERE (code='marketing.blast.read' AND NOT is_sensitive AND is_staff_assignable)
      OR (code='marketing.blast.send' AND is_sensitive AND is_staff_assignable))<>2 THEN
    RAISE EXCEPTION 'School blast permissions missing'; END IF;
END $$;
-- End school blasts exact verification.

-- Rank setup exact verification (0622)
DO $$ DECLARE f text; t text; c text; d boolean;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.read_staff_rank_setup(text)','hon.mutate_rank_setup(text,text,uuid,uuid,jsonb,text,uuid,uuid)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe rank setup entry point: %',f; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN('hon.rank_setup_program(uuid,uuid,uuid)'::regprocedure,'hon.rank_setup_rules(jsonb,integer,integer)'::regprocedure) AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
    RAISE EXCEPTION 'Unsafe rank setup helper'; END IF;
  FOR f,t,c,d IN SELECT * FROM (VALUES
    ('hon.read_staff_rank_setup(text)','458e2a2bec63e58d7493089816ca3179','v',true),
    ('hon.mutate_rank_setup(text,text,uuid,uuid,jsonb,text,uuid,uuid)','4f13ac880d02767a01aba321a5ba6e2b','v',true),
    ('hon.rank_setup_program(uuid,uuid,uuid)','67367f8ce9dd8da25e1cdbb6d5fbd858','s',false),
    ('hon.rank_setup_rules(jsonb,integer,integer)','aa0bd917b5ef77822d4515b6e8f6cb40','i',false)) x LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND md5(p.prosrc)=t AND p.provolatile=c AND p.prosecdef=d
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']) THEN
      RAISE EXCEPTION 'Rank setup function body/posture drift: %',f; END IF;
  END LOOP;
END $$;
-- End rank setup exact verification.

-- Mobile hand-off single use exact verification (0655)
DO $$ DECLARE t oid := to_regclass('hon.mobile_handoff_redemptions'); f oid := to_regprocedure('hon.redeem_mobile_handoff(text,uuid,timestamptz)');
BEGIN
  IF t IS NULL OR f IS NULL THEN RAISE EXCEPTION 'Mobile hand-off redemption ledger missing (0655)'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=t AND relrowsecurity AND relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=t) THEN RAISE EXCEPTION 'Mobile hand-off ledger must be forced RLS with no policies'; END IF;
  IF EXISTS(SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=t AND a.grantee<>c.relowner) THEN
    RAISE EXCEPTION 'Mobile hand-off ledger must have no table grants'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
      AND p.provolatile='v' AND p.prorettype='boolean'::regtype AND md5(p.prosrc)='300e51f8eef239b6aad8a7d573800e9b'
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
        AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
    RAISE EXCEPTION 'Unsafe or drifted hon.redeem_mobile_handoff'; END IF;
END $$;
-- End mobile hand-off single use exact verification.

-- Public checkout orders exact verification (0627): orders placed from a checkout page share link, the hourly counters,
-- the private guard, helpers and settle trigger, three runtime entry points, and two private forced-RLS tables the runtime
-- can never touch directly. (0627 also replaced hon.family_checkout_taken and hon.read_public_school_checkout; their hashes
-- are pinned in the 0598 and 0620 sections above.)
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.guard_public_checkout_order()',false,false,'search_path=pg_catalog, hon','9f644adfd8b1827b309340891a8651d0524aa428e7f2cdfe8a01b1fb73550cbd'),
('hon.take_public_checkout_rate(uuid,text,integer)',true,false,'search_path=pg_catalog, hon','bbc573d31fd20a14a191cb64780cb9cabb728dc9af71e11a15f4e9776217cdc1'),
('hon.public_checkout_intake_ok()',true,false,'search_path=pg_catalog, hon','afabbed1e4aea6b4cd33b7f880ab8076b60c5d8570cee8995caa909b3ca7642e'),
('hon.public_checkout_order_for(uuid,text)',true,false,'search_path=pg_catalog, hon','d6a61b464f2ca1d08f8033e5535813bd61dfa20bf7d7f715f5ad9647baf382cb'),
('hon.public_checkout_order_json(hon.public_checkout_orders)',true,false,'search_path=pg_catalog, hon','35147f8b5283000affa3129bf90ef18bf373b98895608b085c33f3d4dd87cd1b'),
('hon.settle_public_checkout_order()',true,false,'search_path=pg_catalog, hon','d12a22087e71a90c543ed99be34f1986ce82b0f37994094a0f37183d2231266b'),
('hon.open_public_checkout_order(text,jsonb,text,boolean)',true,true,'search_path=pg_catalog, hon','3779ba47679df3638a3f7717313b3c9b6f6df2b5a855ba0e52219799c5b1377f'),
('hon.read_public_checkout_order(text,text)',true,true,'search_path=pg_catalog, hon','c6fef10dc7405bce8f6191fc80b7f1ef320b14768af2f0cad29ec86b691deef1'),
('hon.read_school_public_checkout_orders(text)',true,true,'search_path=pg_catalog, hon','4fc82d6c9db853cbf4e302a9e4f14449312c06467d4ff24ba18145601498e8c0')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe public checkout order function: %',f.signature; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hon.public_checkout_orders','hon.public_checkout_rates'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=t::regclass)
      OR has_table_privilege('hon_runtime',t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime',t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe public checkout table: %',t; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.public_checkout_orders'::regclass AND NOT tgisinternal AND tgenabled='O'
      AND ((tgname='public_checkout_orders_guard' AND tgfoid='hon.guard_public_checkout_order()'::regprocedure)
        OR (tgname='public_checkout_orders_no_truncate' AND tgfoid='hon.guard_membership_activation_evidence()'::regprocedure)))<>2
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.public_checkout_orders'::regclass AND NOT tgisinternal)<>2
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.public_checkout_rates'::regclass AND NOT tgisinternal)<>0 THEN
    RAISE EXCEPTION 'hon.public_checkout_orders must carry exactly its two guards'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.school_pay_once'::regclass AND tgname='public_checkout_settle'
      AND tgfoid='hon.settle_public_checkout_order()'::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Missing public checkout settle trigger'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000627' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL)
    OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000627')
    OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id='00000000-0000-4000-8000-000000000627')
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id='00000000-0000-4000-8000-000000000627') THEN
    RAISE EXCEPTION 'The public checkout order intake must be a code-owned service with no authority'; END IF;
END $$;
-- End public checkout orders exact verification.
-- School media library exact verification (0628)
DO $$ DECLARE f text; t text;
  entry text[]:=ARRAY['hon.read_school_media(text)',
    'hon.begin_school_media_upload(text,jsonb,text,uuid,uuid)','hon.finish_school_media_upload(text,jsonb,uuid,uuid)',
    'hon.rename_school_media(text,jsonb,text,uuid,uuid)','hon.delete_school_media(text,jsonb,text,uuid,uuid)',
    'hon.confirm_school_media_removed(text,uuid,uuid,uuid)','hon.resolve_school_media_link(text)'];
  helpers text[]:=ARRAY['hon.school_media_title_ok(jsonb)','hon.school_media_new_token()','hon.guard_school_media_asset()',
    'hon.require_school_media_actor(text,text)','hon.school_media_json(hon.school_media_assets)','hon.school_media_usage(uuid,uuid)',
    'hon.school_media_begin(text,text,jsonb,text,uuid)','hon.school_media_current(uuid,uuid,jsonb)','hon.school_media_finish(text,text,uuid,text,hon.school_media_assets,jsonb,uuid,uuid)'];
  tables text[]:=ARRAY['hon.school_media_assets'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe school media entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe school media helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=t::regclass)
      OR has_table_privilege('hon_runtime',t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime',t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe school media table: %',t; END IF;
  END LOOP;
  IF (SELECT count(*) FROM hon.permissions WHERE (code='marketing.media.read' AND NOT is_sensitive AND is_staff_assignable)
      OR (code='marketing.media.manage' AND is_sensitive AND is_staff_assignable))<>2 THEN
    RAISE EXCEPTION 'School media permissions missing'; END IF;
END $$;
-- End school media library exact verification.

-- Attendance report exact verification (AR1 0633): one stable read-only runtime entry point, fixed body and posture.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='hon.read_attendance_report(text,jsonb)'::regprocedure
      AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.provolatile='s'
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='a9fa38de85db47bb077e2c3d8bfa79b2368cbf195e5f15e802f081549e6f8980'
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
    RAISE EXCEPTION 'Unsafe attendance report read'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname='read_attendance_report')<>1 THEN
    RAISE EXCEPTION 'Unexpected attendance report overload'; END IF;
END $$;
-- End attendance report exact verification.
-- Intake contact consent exact verification (0634): one runtime entry point, owner-only helpers, read-only forced-RLS
-- capture table, deferred lead trigger.
DO $$ DECLARE f text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='hon.record_staff_intake_consent(text,jsonb)'::regprocedure AND p.prosecdef
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
      AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
    RAISE EXCEPTION 'Unsafe staff intake consent entry point'; END IF;
  FOREACH f IN ARRAY ARRAY['hon.record_intake_consent(uuid,text,text,jsonb,uuid,boolean)','hon.intake_consent_after_lead()'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND p.prosecdef
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon'])
      OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe intake consent helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='hon.communication_consent_captures'::regclass AND relrowsecurity AND relforcerowsecurity)
    OR NOT has_table_privilege('hon_runtime','hon.communication_consent_captures','SELECT')
    OR has_table_privilege('hon_runtime','hon.communication_consent_captures','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'Unsafe intake consent capture table'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='hon.crm_leads'::regclass AND tgname='crm_leads_intake_consent'
      AND tgconstraint<>0 AND tgdeferrable AND tginitdeferred AND tgenabled='O' AND tgfoid='hon.intake_consent_after_lead()'::regprocedure) THEN
    RAISE EXCEPTION 'Missing deferred intake consent trigger'; END IF;
END $$;
-- End intake contact consent exact verification.
-- Staff AI agent switches exact verification (0635, HON Staff app S2): nine staff-assignable switches, the two wrapped
-- runtime entry points, and the internal helpers and renamed 0284 bodies with no runtime or other grant.
DO $$ DECLARE f record; BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('ai.agent.hon.use','ai.agent.kai.use','ai.agent.alex.use','ai.agent.chad.use','ai.agent.maya.use',
        'ai.agent.marcus.use','ai.agent.jordan.use','ai.agent.claire.use','ai.agent.lena.use') AND NOT is_sensitive AND is_staff_assignable)<>9
     OR (SELECT count(*) FROM hon.permissions WHERE code LIKE 'ai.agent.%')<>9 THEN
    RAISE EXCEPTION 'Missing or altered AI agent switch permissions'; END IF;
  FOR f IN SELECT * FROM (VALUES
    ('hon.begin_hon_turn(text,uuid,jsonb,uuid)',true,true,'v','1ccf93b0a84953331efad79fa730ecd1'),
    ('hon.read_ai_team_readiness(text)',true,true,'v','e68977ad91563e714fed294ce11865d3'),
    ('hon.begin_hon_turn_0284(text,uuid,jsonb,uuid)',true,false,'v','6f3e382932fa0af594a42eb120f89049'),
    ('hon.read_ai_team_readiness_0284(text)',true,false,'v','be0673a8f5fcc45deb43213191033737'),
    ('hon.principal_has_ai_agent(uuid,uuid,uuid,text)',true,false,'s','d07f83decb97abe3683abf01120a475e'),
    ('hon.require_ai_agent_capability(text)',true,false,'s','47b468de5ef5c8fc4c6da3701b1d7470'),
    ('hon.hold_and_recheck_ai_planning_authority(text)',true,false,'v','bb76ec6efac2f947e07ec938ea0ecd7e'),
    ('hon.hon_reply_allowed_suggestions(uuid,uuid,uuid,text[])',true,false,'s','1d30a75b40e9941ffd7529ca5a626afb')
  ) x(signature,definer,runtime_execute,volatility,body) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f.signature::regprocedure
        AND p.prosecdef=f.definer AND (o.rolsuper OR o.rolbypassrls) AND p.provolatile::text=f.volatility AND md5(p.prosrc)=f.body
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_execute
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (NOT f.runtime_execute OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')
            OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
      RAISE EXCEPTION 'Unsafe AI agent switch function %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='hon.ai_agent_switch_permission(text)'::regprocedure AND NOT p.prosecdef AND p.provolatile='i'
      AND md5(p.prosrc)='ba0561d5fadeba02f08445d5c451d467' AND NOT has_function_privilege('hon_runtime',p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'Unsafe AI agent switch name helper'; END IF;
END $$;
-- End staff AI agent switches exact verification.
-- Rank chart AI draft exact verification (0636): the RANK_CHART kind row on the shared AI text proposals (0550), the closed
-- brief and draft shapes, the private actor, facts and view helpers, and the seven runtime entry points.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.begin_rank_chart_draft(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','1f9744ef6334348e300e88c61cc4eb19cb8552645312f1d7dc261a839b270940'),
('hon.close_rank_chart_draft(text,uuid,text)',true,true,'search_path=pg_catalog, hon','5c988ce8c05ee27efccea609abaf3d1c9727fe98a1764efae03c725e4b4c79a7'),
('hon.fail_rank_chart_draft(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','3feae945c7f1d30a8d9962cde7fc27d3edd7a590ad406805c71c23674aa44561'),
('hon.plan_rank_chart_draft(text,uuid)',true,true,'search_path=pg_catalog, hon','412669ab27950d8ae9f96f41cf9bd78437d579ba061a65e70cff4504365dbb88'),
('hon.prepare_rank_chart_draft(text,uuid,uuid,boolean)',true,true,'search_path=pg_catalog, hon','86051b3091c9d5d2765dc321c4fd49500d46012b408d506d819efc130028cfe3'),
('hon.read_rank_chart_drafts(text,uuid)',true,true,'search_path=pg_catalog, hon','0dc4f291a0027c0a64fd3c2ee0a958212e0bc132e2ddf15b3bdeeee567b5a391'),
('hon.record_rank_chart_draft(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','1729ce567bdc75597d64ad1f131e34e6fa1742fb9806522f0e817bcfadd5fab6'),
('hon.rank_chart_ai_actor(text)',true,false,'search_path=pg_catalog, hon','ce0c708987e4168d288f07d3b2ff6494816b5be7b0782ccbec4deb0d3972a359'),
('hon.rank_chart_brief_ok(jsonb)',false,false,'search_path=pg_catalog, hon','8d93ce12801a7754fcd8093575a268356e89bbf1854b7681b8af6c760e6ff93f'),
('hon.rank_chart_facts(jsonb)',true,false,'search_path=pg_catalog, hon','a25a066125cef3eb73f0cc7832cfe122ef69df9582059a50b243c1bd182dac96'),
('hon.rank_chart_ok(jsonb)',false,false,'search_path=pg_catalog, hon','87b3386d720ba8724060a7e8aaa966d28ac1fb363987b99ea27621c8f9476f38'),
('hon.rank_chart_view(uuid,uuid)',true,false,'search_path=pg_catalog, hon','58347e329510c9ba09aad9c3d68959aecc8d9be47afa3d11a87a71db6bd14508'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (NOT f.definer OR owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe rank chart AI draft function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_kinds k WHERE k.kind='RANK_CHART' AND k.agent_key='kai' AND k.task_class='DRAFT_TEACHING'
      AND k.input_budget=16000 AND k.output_budget=5000 AND k.max_cost_microunits=150000 AND k.max_result_bytes=12288
      AND k.caller='HUMAN_UI' AND k.subject_type='SCHOOL' AND k.usage_agent='RANK_CHART') THEN
    RAISE EXCEPTION 'Rank chart AI draft kind row missing or changed';
  END IF;
END $$;
-- End rank chart AI draft exact verification.

-- Eian natural voice exact verification (0638): the private clip table (a digest and a length, never the words or the sound)
-- with its four S4 triggers, two private helpers and five runtime entry points. The eight S4 shared functions that gained
-- EIAN_SPEECH are pinned in the 0550 section above with their 0638 bodies.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.eian_speech_limits()',false,false,'search_path=pg_catalog','400ec3ced8cd50c551079690bacc49143cb47bad5857f4c3dea82fa0be992bc6'),
('hon.eian_speech_unavailable_reason(uuid,uuid,boolean)',true,false,'search_path=pg_catalog, hon','439eaef626396c40760111b94dc598266c3d7b1d9ad981fe3ba61ece5b1dfa02'),
('hon.read_eian_speech_status(text,boolean)',true,true,'search_path=pg_catalog, hon','98262cf43d01d38d743b6580d123e66134fa05486813dcad3e1daa640cfc6c05'),
('hon.begin_eian_speech(text,text,text,integer)',true,true,'search_path=pg_catalog, hon','16a59b9628c46bf197323b0706a4e48a046e7ff92eaa837aca310e2e2478a0dc'),
('hon.prepare_eian_speech(text,uuid,boolean)',true,true,'search_path=pg_catalog, hon','3f365faac243f48c42d3fd587ad87eea9bf5bcdfc1eee113003c6e5397612be1'),
('hon.fail_eian_speech(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','e75f027981ce667f515b3511017ead43decf252383fd1ccb32e351c865e8227b'),
('hon.record_eian_speech_result(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','77635b7af622cc820b435234937af77e9a38e36a6e1caa4a254c346e482c92db'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Eian natural voice function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.eian_speech_clips'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.eian_speech_clips'::regclass)
    OR has_table_privilege('hon_runtime','hon.eian_speech_clips','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.eian_speech_clips','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe Eian speech clip table';
  END IF;
  -- The table can hold no words and no sound: exactly these columns.
  IF (SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM pg_attribute a WHERE a.attrelid='hon.eian_speech_clips'::regclass AND a.attnum>0 AND NOT a.attisdropped)
     <> ARRAY['characters','created_at','family_id','held_at','id','idempotency_key','organization_id','provider_request_id','reason','requested_by','reserved_credits','school_id','status','text_digest','updated_at','usage_id'] THEN
    RAISE EXCEPTION 'Eian speech clip columns changed';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='hon.eian_speech_clips'::regclass AND t.tgenabled='O' AND (t.tgname, t.tgfoid) IN (
      ('ai_spend_start_guard','hon.ai_spend_start_guard()'::regprocedure), ('ai_spend_reserve_guard','hon.ai_spend_reserve_guard()'::regprocedure),
      ('ai_spend_reserve_guard_insert','hon.ai_spend_reserve_guard()'::regprocedure), ('zz_ai_hold_origin','hon.ai_stamp_hold_origin()'::regprocedure))) <> 4 THEN
    RAISE EXCEPTION 'Eian speech clip S4 triggers missing';
  END IF;
END $$;
-- End Eian natural voice exact verification.
-- Alex delegation plans exact verification (0639): the ALEX_DELEGATION_PLAN kind row on the shared AI text proposals (0550),
-- the closed brief and answer shapes, the private helpers, the eight runtime entry points and the two closed evidence tables.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.alex_plan_actor(text)',true,false,'search_path=pg_catalog, hon','22540944e18d1532801571e43641cdfba7ce511b82b4bbfb9ed3cbc67702debd'),
('hon.alex_plan_areas()',false,false,'search_path=pg_catalog','b544cbcaeee47589e51d5085b9a2f129f259080e389a8381ddfb16049e5da5ec'),
('hon.alex_plan_brief_ok(jsonb)',false,false,'search_path=pg_catalog, hon','6e25173e1aff182e791cb66833fbba01f7e589cefa6f3174de953a6664a92e21'),
('hon.alex_plan_facts(text,uuid,jsonb)',true,false,'search_path=pg_catalog, hon','ace4e38b2e69f261eae603326cc7826632bd2a8c407a6cdabb67e619f10ff6dd'),
('hon.alex_plan_fix_refs(uuid)',true,false,'search_path=pg_catalog, hon','748bb2493566563bafa034d07d4ab8ede2e8b19d1f8f6e1e6aa4fbe8dd9ea9af'),
('hon.alex_plan_keys_are(jsonb,text[])',false,false,'search_path=pg_catalog','7556a96f17a68188dd305a64c9279afd187b13bee9774d8bbdfc6d7fd4a64547'),
('hon.alex_plan_line_ok(text,integer)',false,false,'search_path=pg_catalog, hon','a94feea13748dbf9238ad9643bf8672aad450dde7b306ae1dee557fd2594df24'),
('hon.alex_plan_ok(jsonb)',false,false,'search_path=pg_catalog, hon','080cf9284e2c960a52f37e4b90a2cf51edf7b5cf0a0727ec88ec8975bf3fb01c'),
('hon.alex_plan_reader(text)',true,false,'search_path=pg_catalog, hon','b5727b67b28d305bf03e12a7d799419fce65e452131bbfd35074e4df8430a702'),
('hon.alex_plan_view(uuid,uuid)',true,false,'search_path=pg_catalog, hon','06377522a66212c93123cbd99c9c6774eeebc1c9164b1a8e33a2913e3434a9a3'),
('hon.begin_alex_plan(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','4321ac79a6e8a0af106cac30f8db481add9ddda646a48b3363bcfc0f28fcc24d'),
('hon.close_alex_plan(text,uuid,text)',true,true,'search_path=pg_catalog, hon','ea8d36657128325bb03fa680e7507b15f54cce03433a44613275f11f2b6cab42'),
('hon.create_alex_plan_tasks(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','78f3b2a285aef267191d32ed3617a68ccbe63c8ab9dde620b9ae66481b51c5ee'),
('hon.fail_alex_plan(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','3c3dce1d6e5f49b7fff54234e6695be294819a105d426f638250b48ebc206e72'),
('hon.guard_alex_plan_rows()',false,false,'search_path=pg_catalog','60c2ac1f79fdd66d9c79e5d5afcbdbe6d0e3a368a4fc9e62b48cf513972189b4'),
('hon.plan_alex_plan(text,uuid)',true,true,'search_path=pg_catalog, hon','a794107e1e8f58044a6dbea8b9426f8f420ce1b94f76e3eaa72a1b2b4ad623c6'),
('hon.prepare_alex_plan(text,uuid,uuid,boolean)',true,true,'search_path=pg_catalog, hon','27b8323521edc2bf33bf62a56968f3fa26f9f8d8c34179aa5cfeb1e0a7e64c23'),
('hon.read_alex_plans(text,uuid)',true,true,'search_path=pg_catalog, hon','78a11d2f2019fdee42f498953ac3823ca8cf3f34700c8e8d7ddd2542d7bdd93b'),
('hon.record_alex_plan(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','ae4c53483ce5cbb80ee45853885f931213d9c2f58f2e963a7adf29d3554243f3'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (NOT f.definer OR owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Alex delegation plan function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_kinds k WHERE k.kind='ALEX_DELEGATION_PLAN' AND k.agent_key='alex' AND k.task_class='ANALYZE'
      AND k.input_budget=12000 AND k.output_budget=3000 AND k.max_cost_microunits=80000 AND k.max_result_bytes=12288
      AND k.caller='HUMAN_UI' AND k.subject_type='SCHOOL' AND k.usage_agent='GENERAL_MANAGEMENT') THEN
    RAISE EXCEPTION 'Alex delegation plan kind row missing or changed';
  END IF;
  FOREACH t IN ARRAY ARRAY['hon.alex_plan_staff_refs','hon.alex_plan_created_tasks'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR has_table_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
      OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE') THEN
      RAISE EXCEPTION 'Alex delegation plan table is not closed: %',t;
    END IF;
  END LOOP;
END $$;
-- End Alex delegation plans exact verification.
-- Jordan follow-through exact verification (0640): the JORDAN_FOLLOW_UP kind row on the shared AI text proposals (0550),
-- the closed brief and answer shapes, the private helpers, the eight runtime entry points and the two closed evidence tables.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.apply_jordan_follow_ups(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','71580d68700d4344b4b923b43ecf421c14c7d8949bfeacc465e62282492f4db4'),
('hon.begin_jordan_follow_up(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','c49dab6593b04a32d649f0f636747080716066c673ba40a55880de8f3a39cf54'),
('hon.close_jordan_follow_up(text,uuid,text)',true,true,'search_path=pg_catalog, hon','61b3c4d269c9a6a3a94e38e72d6e1fbc305fb2f0b3cb88e639fe62de9c7bded4'),
('hon.fail_jordan_follow_up(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','863eb8592e10c24ce5a5ea72ae325ebe8ed25f3ac07ff6479c06d7651313ae45'),
('hon.jordan_follow_up_actor(text)',true,false,'search_path=pg_catalog, hon','a09db56bfae320bb92380bbdef7f958361f2f73c67fc2ba77e85043c28136036'),
('hon.jordan_follow_up_brief_ok(jsonb)',false,false,'search_path=pg_catalog, hon','8f9505deae9d2b72d5b4f75746f8fda28804e2aeb70bef9637ba65c971354d30'),
('hon.jordan_follow_up_facts(text,uuid,jsonb)',true,false,'search_path=pg_catalog, hon','3f18611dab685f303dc9feb71a96cfc7aa4cdb01c463880b47748868e9e428b0'),
('hon.jordan_follow_up_fix_refs(uuid,text)',true,false,'search_path=pg_catalog, hon','45e96c1a62ab74e22933872de37195c0ec1bfb356cd05281819516e4dfc008ac'),
('hon.jordan_follow_up_ok(jsonb)',false,false,'search_path=pg_catalog, hon','8decd425e207f37e69cfea3df17b6b537ca08394c9e87d9ad4925950ca8ba385'),
('hon.jordan_follow_up_reader(text)',true,false,'search_path=pg_catalog, hon','571180164c33b1583afc894dbadcbefe8069073f4602ef20d38487c2bd1745c4'),
('hon.jordan_follow_up_view(uuid,uuid)',true,false,'search_path=pg_catalog, hon','6a144ec30ecdd7c568e6ce5c33da850433ff0b89b580e62851cb86359c594feb'),
('hon.plan_jordan_follow_up(text,uuid)',true,true,'search_path=pg_catalog, hon','6de64de3eab93acc85375285ade9b13f5e5954e6c955c6e03d6ece81eda736a3'),
('hon.prepare_jordan_follow_up(text,uuid,uuid,boolean)',true,true,'search_path=pg_catalog, hon','c8fed74689159c3c4b7c23bec2f78c04c482eb1974abf5bb289f57187de2293b'),
('hon.read_jordan_follow_ups(text,uuid)',true,true,'search_path=pg_catalog, hon','e61b0aafc840386e625d9e5e36eb2af211996c21a4be2294e90c13c8f1c7e0a9'),
('hon.record_jordan_follow_up(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','8112c275ce565e9a9be551ee8e3141cd93d02829265ac3f8aa98fd1d3a9e5bed'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (NOT f.definer OR owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Jordan follow-through function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_kinds k WHERE k.kind='JORDAN_FOLLOW_UP' AND k.agent_key='jordan' AND k.task_class='ANALYZE'
      AND k.input_budget=12000 AND k.output_budget=3000 AND k.max_cost_microunits=80000 AND k.max_result_bytes=12288
      AND k.caller='HUMAN_UI' AND k.subject_type='SCHOOL' AND k.usage_agent='OPERATIONS') THEN
    RAISE EXCEPTION 'Jordan follow-through kind row missing or changed';
  END IF;
  FOREACH t IN ARRAY ARRAY['hon.jordan_follow_up_refs','hon.jordan_follow_up_applied'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR has_table_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
      OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE') THEN
      RAISE EXCEPTION 'Jordan follow-through table is not closed: %',t;
    END IF;
  END LOOP;
END $$;
-- End Jordan follow-through exact verification.
-- Marcus marketing review exact verification (0641): the MARCUS_MARKETING_REVIEW kind row on the shared AI text proposals (0550),
-- the closed brief and answer shapes, the private helpers and the seven runtime entry points.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.begin_marcus_review(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','2ad3a975099aaec3a4ec82cb18dbafd6671ebf4ef7cd20bbb0246298b6875212'),
('hon.close_marcus_review(text,uuid,text)',true,true,'search_path=pg_catalog, hon','165c2276b3a5957f06ffd6825cc671308e92a7e06602bba1d42a4ea2b47c9645'),
('hon.fail_marcus_review(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','d1ac39fd09bb62757a42b1abaa0ca9071bfd33e454d30a874e9a5abbcab7c487'),
('hon.marcus_review_actor(text)',true,false,'search_path=pg_catalog, hon','97a653a441b6eb73720f65283fe701c2ac212b50eb0d76797ea45a430f4949e0'),
('hon.marcus_review_brief_ok(jsonb)',false,false,'search_path=pg_catalog, hon','626bf9f0cf6ed4d905eafba7b4488a52ca5662ea00420cd1a9947d477040f380'),
('hon.marcus_review_facts(jsonb)',true,false,'search_path=pg_catalog, hon','d0adfa53cb92f83907972a63325862ecc2c0de7046e77f825c708c204d5cc430'),
('hon.marcus_review_ok(jsonb)',false,false,'search_path=pg_catalog, hon','79b4e8efa0b207265f0976ce16f5b54c80ea12f10ab902ed2cb249ec7cf7b856'),
('hon.marcus_review_reader(text)',true,false,'search_path=pg_catalog, hon','5f65e154600d5c17cdbddbc646f77ba1278dd26831f6ac0ead8cd583a1441b10'),
('hon.marcus_review_view(uuid,uuid)',true,false,'search_path=pg_catalog, hon','041558bd5d70d30ea2e843d402d8521729c5a61137ef8c9f95cd7d3155f86389'),
('hon.plan_marcus_review(text,uuid)',true,true,'search_path=pg_catalog, hon','b63cd8706d097b7d53cf586b0ca1231e080e939135f9d4d696e19dd9265f1ef4'),
('hon.prepare_marcus_review(text,uuid,uuid,boolean)',true,true,'search_path=pg_catalog, hon','d4d3798d9eedec7821b719462edaad28bfc8718e9e6b912f235ca10a5210d50f'),
('hon.read_marcus_reviews(text,uuid)',true,true,'search_path=pg_catalog, hon','3fece2d2ebc567e71a90ddb812d09161547fbeae870c539a4549ddad4b09bccb'),
('hon.record_marcus_review(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','f60968161d8eac8492793035f2dc0956d8f156d5160a5f73e14ec3c97134c772'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (NOT f.definer OR owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Marcus marketing review function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_kinds k WHERE k.kind='MARCUS_MARKETING_REVIEW' AND k.agent_key='marcus' AND k.task_class='DRAFT_MARKETING'
      AND k.input_budget=12000 AND k.output_budget=3000 AND k.max_cost_microunits=80000 AND k.max_result_bytes=12288
      AND k.caller='HUMAN_UI' AND k.subject_type='SCHOOL' AND k.usage_agent='MARKETING') THEN
    RAISE EXCEPTION 'Marcus marketing review kind row missing or changed';
  END IF;
END $$;
-- End Marcus marketing review exact verification.
-- Claire KPI report exact verification (0643): the CLAIRE_KPI_REPORT kind row on the shared AI text proposals (0550), the
-- closed brief and answer shapes, the private helpers, the seven runtime entry points and the closed counted-numbers table.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.begin_claire_kpi_report(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','2811b1522b63df712ef83488fa829f20edb230e77271a06d1d19bc0a8076cb89'),
('hon.claire_kpi_actor(text)',true,false,'search_path=pg_catalog, hon','42ba0cdba67ce8a8bb2f802d907fa6100f0c920281c344ffbcb6641bee12a1e2'),
('hon.claire_kpi_brief_ok(jsonb)',false,false,'search_path=pg_catalog, hon','14a7de81c5514f8695b22bee2007c231b7c8c9c45261f9eba26d6e66e88f5cbd'),
('hon.claire_kpi_codes()',false,false,'search_path=pg_catalog','342f0db44634580b5927ec2040ebde82f6cabf06f9cb07ad4aa79f2423b7c127'),
('hon.claire_kpi_count(integer)',true,false,'search_path=pg_catalog, hon','530271cbc77858de32410cda666b122e02e9ccd91419442264c35ec8bd299d3b'),
('hon.claire_kpi_facts(text,uuid,jsonb)',true,false,'search_path=pg_catalog, hon','ff127274dcaab7b1747d263fb8f4ab82aedf374b398085cc95a4ca7e1cae6d15'),
('hon.claire_kpi_ok(jsonb)',false,false,'search_path=pg_catalog, hon','02f5f7e50651ad10f8d8bd82c03983bae4e853c618ce6f6d21ee81db07816a2a'),
('hon.claire_kpi_reader(text)',true,false,'search_path=pg_catalog, hon','a5e93d7891f06baed5503d25f510a3f9d6aa84f17e19fa6fac9b881303ee2745'),
('hon.claire_kpi_view(uuid,uuid)',true,false,'search_path=pg_catalog, hon','6acc8eb345d5543895292abbf0d2c03e2b3cca942727478d41579faf36b99136'),
('hon.close_claire_kpi_report(text,uuid,text)',true,true,'search_path=pg_catalog, hon','d3695bed80061ef5c863bc2340e178b66f9f7935fb654c34a19bc063687cbf04'),
('hon.fail_claire_kpi_report(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','98720caf46d89096838312bdd011be4a9446e656f66682215039b6c81549e293'),
('hon.plan_claire_kpi_report(text,uuid)',true,true,'search_path=pg_catalog, hon','22a610d704fa3433d7f8b41082eebc9bd999c19f5cc9cbf6641174fa20243308'),
('hon.prepare_claire_kpi_report(text,uuid,uuid,boolean)',true,true,'search_path=pg_catalog, hon','5841a374817a36fb179bd0fb9b9bc3750cae0cc30ffeb6716ac3563e374d2558'),
('hon.read_claire_kpi_reports(text,uuid)',true,true,'search_path=pg_catalog, hon','7a2f1787e4516c1b7aee5d143288bf1bc183d17d0b62ae3f5b67f3edc83b14ca'),
('hon.record_claire_kpi_report(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','a533b111176938276ea34a3f460fd6793313cb3bf06c5636e475f6839e9c472f'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (NOT f.definer OR owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Claire KPI report function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_kinds k WHERE k.kind='CLAIRE_KPI_REPORT' AND k.agent_key='claire' AND k.task_class='ANALYZE'
      AND k.input_budget=12000 AND k.output_budget=3000 AND k.max_cost_microunits=80000 AND k.max_result_bytes=12288
      AND k.caller='HUMAN_UI' AND k.subject_type='SCHOOL' AND k.usage_agent='BUSINESS_PERFORMANCE') THEN
    RAISE EXCEPTION 'Claire KPI report kind row missing or changed';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.claire_kpi_report_numbers'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR has_table_privilege('hon_runtime','hon.claire_kpi_report_numbers','SELECT') OR has_table_privilege('hon_runtime','hon.claire_kpi_report_numbers','INSERT')
    OR has_table_privilege('hon_runtime','hon.claire_kpi_report_numbers','UPDATE') OR has_table_privilege('hon_runtime','hon.claire_kpi_report_numbers','DELETE') THEN
    RAISE EXCEPTION 'Claire KPI report numbers table is not closed';
  END IF;
END $$;
-- End Claire KPI report exact verification.

-- Membership plan payment options exact verification (0642): three runtime entry points, six private helpers, two forced-RLS tables.
DO $$ DECLARE f text; t text; c text; d boolean; s text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.read_school_membership_plan_setups(text)','hon.create_school_membership_plan_with_options(text,jsonb,uuid,uuid,uuid)',
      'hon.revise_school_membership_plan_with_options(text,uuid,jsonb,uuid,uuid,uuid)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure
        AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
      RAISE EXCEPTION 'Unsafe membership plan option entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_membership_plan_setup()','hon.membership_plan_setup_int(jsonb,integer,integer,boolean)','hon.membership_plan_validated_setup(jsonb)',
      'hon.membership_plan_setup_summary(uuid,integer)','hon.membership_plan_setup_terms(jsonb,jsonb)','hon.membership_plan_insert_setup(uuid,integer,jsonb,uuid)'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND (a.grantee=0 OR a.grantee<>p.proowner)) THEN
      RAISE EXCEPTION 'Unsafe membership plan option helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['membership_plan_version_setups','membership_plan_payment_options'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
      OR EXISTS(SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner) THEN
      RAISE EXCEPTION 'Unsafe membership plan option table: %',t; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname IN ('guard_membership_plan_setup','membership_plan_setup_int','membership_plan_validated_setup',
      'membership_plan_setup_summary','membership_plan_setup_terms','membership_plan_insert_setup','read_school_membership_plan_setups',
      'create_school_membership_plan_with_options','revise_school_membership_plan_with_options'))<>9 THEN
    RAISE EXCEPTION 'Unexpected membership plan option overload'; END IF;
  FOR f,t,c,d,s IN SELECT * FROM (VALUES
    ('hon.create_school_membership_plan_with_options(text,jsonb,uuid,uuid,uuid)','5651355218ada7e3c5e45d33746c8bf1','v',true,'search_path=pg_catalog, hon'),
    ('hon.guard_membership_plan_setup()','f580ad9acbae46a1c09263ce987ccd4a','v',false,'search_path=pg_catalog, hon'),
    ('hon.membership_plan_insert_setup(uuid,integer,jsonb,uuid)','dab3c3a4fb662dbc2e180bb1131b5286','v',true,'search_path=pg_catalog, hon'),
    ('hon.membership_plan_setup_int(jsonb,integer,integer,boolean)','64ad633ebdcf89c8cc469aafdbd1d5f7','i',false,'search_path=pg_catalog'),
    ('hon.membership_plan_setup_summary(uuid,integer)','22fca18a051aefb49e2e6873f8fd087c','s',true,'search_path=pg_catalog, hon'),
    ('hon.membership_plan_setup_terms(jsonb,jsonb)','205c334ad93ba9649df12d2a7116a79b','i',false,'search_path=pg_catalog'),
    ('hon.membership_plan_validated_setup(jsonb)','bb1d8330497d542e5322b9d23a787d9e','i',false,'search_path=pg_catalog, hon'),
    ('hon.read_school_membership_plan_setups(text)','8a44c2bfb7fb9830d47c9b971c0e64e8','v',true,'search_path=pg_catalog, hon'),
    ('hon.revise_school_membership_plan_with_options(text,uuid,jsonb,uuid,uuid,uuid)','5eb4d2e5618734fb43e94a6d0715ad96','v',true,'search_path=pg_catalog, hon')) x(f,t,c,d,s) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND md5(p.prosrc)=t AND p.provolatile=c AND p.prosecdef=d
        AND p.proconfig IS NOT DISTINCT FROM ARRAY[s]) THEN
      RAISE EXCEPTION 'Membership plan option function body/posture drift: %',f; END IF;
  END LOOP;
  FOR t IN SELECT unnest(ARRAY['membership_plan_version_setups','membership_plan_payment_options']) LOOP
    IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgfoid='hon.guard_membership_plan_setup()'::regprocedure AND tgenabled='O' AND NOT tgisinternal)<>2 THEN
      RAISE EXCEPTION 'Membership plan option guard missing: %',t; END IF;
  END LOOP;
END $$;
-- End membership plan payment options exact verification.
-- Maya renewal prep exact verification (0646): the MAYA_RENEWAL_PREP kind row on the shared AI text proposals (0550), the
-- closed brief and answer shapes, the private helpers, the eight runtime entry points and the closed evidence tables.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.apply_maya_renewal_preps(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','381cceb33f5b9ee2e0b8de06a1bbe41b664afcb333fe7ab40c64a6065f74a306'),
('hon.begin_maya_renewal_prep(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','3c43136521e6037c5744d5628c358de5d69556232d1eef2cb8b1eeb57c524b2a'),
('hon.close_maya_renewal_prep(text,uuid,text)',true,true,'search_path=pg_catalog, hon','32631fe9cc520e717d6bff69526b009ad82041efcbae5104d936971320e12699'),
('hon.fail_maya_renewal_prep(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','e9829fd4e57970525b289dcf0e3cc04f4e29034245fd2672051b776c6bdbdddf'),
('hon.maya_renewal_actor(text)',true,false,'search_path=pg_catalog, hon','3ed4b7dab927666f7fd9f9652592795ac682e4036c3cfcfe99b63e248bea4201'),
('hon.maya_renewal_brief_ok(jsonb)',false,false,'search_path=pg_catalog, hon','26df06331ef2328dd4024dbb52136813c981c81bbbc45c8ea79e67fe65bdbc9a'),
('hon.maya_renewal_facts(text,uuid,jsonb)',true,false,'search_path=pg_catalog, hon','226865b50b6658ed8216fdd93bfec63cd5857741f7818444abd107d9408d4c06'),
('hon.maya_renewal_fix_refs(uuid,text)',true,false,'search_path=pg_catalog, hon','50b42686f6d9cfea4bbde2712834a7a3bdfbd192b862109b50f553e0760a0a4e'),
('hon.maya_renewal_ok(jsonb)',false,false,'search_path=pg_catalog, hon','d9ef19b4af02325cb2834db40cb49a1895f67919f47ddb1f7d8a4bafcfa3fe84'),
('hon.maya_renewal_open_review(uuid)',true,false,'search_path=pg_catalog, hon','269b591fe0b745d4965bf672fb0dc69fbf0dfadf932a1dab0dd0f8508749d2d3'),
('hon.maya_renewal_reader(text)',true,false,'search_path=pg_catalog, hon','793d832e85e4f0a10bead4244753e00af8babf82204e73675c0f87c63382551f'),
('hon.maya_renewal_view(uuid,uuid)',true,false,'search_path=pg_catalog, hon','6229c4035c798f5e2ce05481a79fd77777fc4153fee5dfa9388fb4ee9fcccaa8'),
('hon.plan_maya_renewal_prep(text,uuid)',true,true,'search_path=pg_catalog, hon','4193f12edfcdc50fc48e0913a82d38943de350a7d240b9d9e810181f6f80f239'),
('hon.prepare_maya_renewal_prep(text,uuid,uuid,boolean)',true,true,'search_path=pg_catalog, hon','f7f1390539db71e0af34ef72786398074b51b4e44109365e0ffba41285d0e7d9'),
('hon.read_maya_renewal_preps(text,uuid)',true,true,'search_path=pg_catalog, hon','03c79714a5fcda319e910874c23aea987f9531420f914d7c320053559a00ea27'),
('hon.record_maya_renewal_prep(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','661f8416ce070e204de226ca065c592dbd304f3389c1897bd97c3148f81bd9c5'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (NOT f.definer OR owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Maya renewal prep function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_kinds k WHERE k.kind='MAYA_RENEWAL_PREP' AND k.agent_key='maya' AND k.task_class='ANALYZE'
      AND k.input_budget=12000 AND k.output_budget=3000 AND k.max_cost_microunits=80000 AND k.max_result_bytes=12288
      AND k.caller='HUMAN_UI' AND k.subject_type='SCHOOL' AND k.usage_agent='RETENTION') THEN
    RAISE EXCEPTION 'Maya renewal prep kind row missing or changed';
  END IF;
  FOREACH t IN ARRAY ARRAY['hon.maya_renewal_refs','hon.maya_renewal_applied'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR has_table_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
      OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE') THEN
      RAISE EXCEPTION 'Maya renewal prep table % is not closed',t;
    END IF;
  END LOOP;
END $$;
-- End Maya renewal prep exact verification.
-- Chad approved-draft send exact verification (0647): the plan/read/cancel entry points, the approval transition that queues one
-- message, the closed helpers, the closed plan and send evidence tables with their guard triggers, and the message origin.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.ai_draft_reachable(uuid,text)',true,false,'search_path=pg_catalog, hon','0de6c26e8a8414882839b932fa82d75ec0fcb1468f95e8c1ea0573e4cb54c8a2'),
('hon.cancel_chad_draft_send(text,uuid)',true,true,'search_path=pg_catalog, hon','4d399c86a2b65648a62c045e2e1f62e16d809cc3b4c3d5cc367df38d7829a0b8'),
('hon.chad_draft_send_view(uuid)',true,false,'search_path=pg_catalog, hon','6c7027683c02151c1b777d717c99ea205143df084ed1782d828cb043c919736d'),
('hon.guard_ai_draft_send_rows()',false,false,'search_path=pg_catalog, hon','6bbb67a3df181e7e8d4c1be17c44c5eb725cdfacd9f52c5a0ea343211ee8d2bb'),
('hon.read_chad_draft_send_for_review(uuid)',true,true,'search_path=pg_catalog, hon','09d0023943dacfe373344656bb4ce18d4322fbec95d208fb3f36b8c2dc47af7d'),
('hon.read_chad_draft_send(text,uuid)',true,true,'search_path=pg_catalog, hon','bb422d037818d2d2b197dbbc2007a7515a8257e9ab682e544013784f350c49f7'),
('hon.set_chad_draft_send_plan(text,uuid,jsonb,text)',true,true,'search_path=pg_catalog, hon','f146c7bfede96ce3753edf30ea5d9264fa29d6385f8a1e6f0cbfe7ad132167cb'),
('hon.transition_chad_follow_up_draft(uuid,text)',true,true,'search_path=pg_catalog, hon','3ce82eaaf2aa4f3941452d507cc05e77fac9369429a7e50d508d8f81aa5ddde2'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (NOT f.definer OR owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Chad approved-draft send function: %',f.signature; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hon.ai_draft_send_plans','hon.ai_draft_sends'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=t::regclass)
      OR has_table_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
      OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE')
      OR (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=t::regclass AND NOT g.tgisinternal AND g.tgenabled='O'
        AND g.tgfoid='hon.guard_ai_draft_send_rows()'::regprocedure)<>2 THEN
      RAISE EXCEPTION 'Chad approved-draft send table % is not closed',t;
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.communication_messages'::regclass AND conname='communication_messages_origin_kind_check'
      AND convalidated AND pg_get_constraintdef(oid) LIKE '%AI_APPROVED_DRAFT%') THEN
    RAISE EXCEPTION 'Message origin AI_APPROVED_DRAFT missing';
  END IF;
END $$;
-- End Chad approved-draft send exact verification.
-- Maya check-in draft send exact verification (0649): the nine entry points, the closed helpers, the kind row and the closed
-- target and send tables with their guard triggers.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.approve_maya_check_in_draft(text,uuid,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','aada1c58af4322b946b9c70dcb27a964d576f91c64412b4b2543c31038eff53b'),
('hon.begin_maya_check_in_draft(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','8037d9c4b56871bd19ade58735294aa96ba75dff5207426eff5f1aeb7d583e91'),
('hon.cancel_maya_check_in_send(text,uuid)',true,true,'search_path=pg_catalog, hon','b71c1b2766bce14b6c67a7406f29b0f3d6eb387638201a7b33fc5dc843ac2c82'),
('hon.close_maya_check_in_draft(text,uuid,text)',true,true,'search_path=pg_catalog, hon','a429793d4fee573c13a532ddeff626fbf87a8148467ccebb8c169733a1a703f1'),
('hon.fail_maya_check_in_draft(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','b8422adca7f8e57b0eebab3a0d543043e29ca6236e1258abc20046a78e1e4168'),
('hon.guard_maya_check_in_rows()',false,false,'search_path=pg_catalog, hon','70e42942870b082d29dc5496d7bb2eb3e09bca3cb4c98d5d0cb9ae3a2eb09353'),
('hon.maya_check_in_actor(text)',true,false,'search_path=pg_catalog, hon','b2a4b663d6b2fdb642de874c8c2ffd20f4044030c0e9e8f21933e8199439923c'),
('hon.maya_check_in_at_risk_row(text,uuid)',true,false,'search_path=pg_catalog, hon','8fca542d01446bd487737686e1972e1cf81349b7a90ee831e3c02d659efa98fd'),
('hon.maya_check_in_brief_ok(jsonb)',false,false,'search_path=pg_catalog, hon','6bb1010760d5aaf80a0bc12c53899ced64423bd426b98fcd1a22e066c78d0d4f'),
('hon.maya_check_in_line_ok(text,integer)',false,false,'search_path=pg_catalog, hon','f880816eaac6b43db7c9d8f828d52d938181084365368e77b231d7f66ecb49e8'),
('hon.maya_check_in_ok(jsonb,text)',false,false,'search_path=pg_catalog, hon','e4303630580f63bafe823229cdc3c6263ae30ba70f13c052d63153a196e2e174'),
('hon.maya_check_in_reader(text)',true,false,'search_path=pg_catalog, hon','d4ae80cd2f829677b5030ebde2361235c42cacc067e4cda2f21074c222a794fe'),
('hon.maya_check_in_recipient(uuid,text)',true,false,'search_path=pg_catalog, hon','88b9f3e004238666313f70a25da1c3d17f098b370a25925b5554d768d63482a7'),
('hon.maya_check_in_text_ok(text,integer)',false,false,'search_path=pg_catalog, hon','3268ff4cc006a90b58ca4da62caa43597df2ae29558d09dfbaef9ab4526d3877'),
('hon.maya_check_in_view(uuid,uuid)',true,false,'search_path=pg_catalog, hon','a8662bbe94fa0421845a5a525753b45463a8dbf99053afb144e82b2c549a1511'),
('hon.plan_maya_check_in_draft(text,uuid)',true,true,'search_path=pg_catalog, hon','51fe6925bfeb5036120b0bedee7e467a36126f5ba2bfab11ab4f526cc2e98ab3'),
('hon.prepare_maya_check_in_draft(text,uuid,uuid,boolean)',true,true,'search_path=pg_catalog, hon','b7c8a4842b1311aa713a4ab2de54aa277a77d633daa4a91df0f08a1ef3ad34c1'),
('hon.read_maya_check_in_drafts(text,uuid)',true,true,'search_path=pg_catalog, hon','43a10962a748aa72834d9f8a58c8389c6f0b3da05261bbcb191c1f521ce6f87d'),
('hon.record_maya_check_in_draft(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','d905a582ab535f67d0ffc3d5b22b30a3bc66b1186b623a36f8c086e3603a7a0a'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (NOT f.definer OR owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Maya check-in draft function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_kinds k WHERE k.kind='MAYA_CHECK_IN_DRAFT' AND k.agent_key='maya' AND k.task_class='ANALYZE'
      AND k.input_budget=6000 AND k.output_budget=2000 AND k.max_cost_microunits=60000 AND k.max_result_bytes=8192
      AND k.caller='HUMAN_UI' AND k.subject_type='SCHOOL' AND k.usage_agent='RETENTION') THEN
    RAISE EXCEPTION 'Maya check-in draft kind row missing or changed';
  END IF;
  FOREACH t IN ARRAY ARRAY['hon.maya_check_in_targets','hon.maya_check_in_sends'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=t::regclass)
      OR has_table_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
      OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE')
      OR (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=t::regclass AND NOT g.tgisinternal AND g.tgenabled='O'
        AND g.tgfoid='hon.guard_maya_check_in_rows()'::regprocedure)<>2 THEN
      RAISE EXCEPTION 'Maya check-in draft table % is not closed',t;
    END IF;
  END LOOP;
END $$;
-- End Maya check-in draft send exact verification.
-- Chad lead next steps exact verification (0650): the eight entry points, the closed helpers, the kind row and the closed
-- alias and applied tables with their guard triggers.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.begin_chad_lead_plan(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','253813d8bc0931f217eb72133899965f8d47d02ebdd3a07e32b715ce5f6552d6'),
('hon.chad_lead_plan_brief_ok(jsonb)',false,false,'search_path=pg_catalog, hon','9237098bdcd5e14fcbf365a50255daeaebd7cd2ace58a98bc0a2bbdcc9161ec7'),
('hon.chad_lead_plan_facts(uuid,jsonb)',true,false,'search_path=pg_catalog, hon','f7aae00bf3e0ed065c830fa6b2fbb51339a106b2e5dba6f8d21ca19fa776b03f'),
('hon.chad_lead_plan_fits(uuid,jsonb)',true,false,'search_path=pg_catalog, hon','f1cf870baf7cdb8df6f20cc072eb70cda83b1ad6d0fccfc16a24d4de981382d3'),
('hon.chad_lead_plan_fix_refs(uuid,text)',true,false,'search_path=pg_catalog, hon','fc880eaa82a372ce2d944f26fca711a277289f97a902fc70727271fa7c8408eb'),
('hon.chad_lead_plan_ok(jsonb)',false,false,'search_path=pg_catalog, hon','53c1db02f1d870360b66a996f32ec58276d76b6ab700c4727c2c3f7a41d9bd6a'),
('hon.chad_lead_plan_trial_ahead(uuid)',true,false,'search_path=pg_catalog, hon','f9b682b95e015bd65c0b5ce5e188ee3c2f97b7f0095c4d9c4768e67e7d7a792f'),
('hon.chad_lead_plan_view(uuid,uuid)',true,false,'search_path=pg_catalog, hon','43dd2e938f74ba2b9dcfddb820d087df960f35684075c032f93fd2cc86baa5f2'),
('hon.close_chad_lead_plan(text,uuid,text)',true,true,'search_path=pg_catalog, hon','3827175b2c629d450d256de6288cb332b9555bd097456cdaa9f6159dbd4fe441'),
('hon.fail_chad_lead_plan(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','604697e041950c081b4af361d6e2fda3cc6f27301adda2ef078406868d5074b2'),
('hon.plan_chad_lead_plan(text,uuid)',true,true,'search_path=pg_catalog, hon','b5413a3731f01b0b5ff2610bf83fe4b37d606cd2c8586ebf47cee77a7f23c1b2'),
('hon.prepare_chad_lead_plan(text,uuid,uuid,boolean)',true,true,'search_path=pg_catalog, hon','945a8de0b22188eebd90c79205f2b798918a23661502acb0167cf37a269209ca'),
('hon.read_chad_lead_plans(text,uuid)',true,true,'search_path=pg_catalog, hon','c53ab32994f6b54d943c34ce797be9b4cd480b88cc985b43ba03778a93960885'),
('hon.record_chad_lead_plan(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','909607819e61c08e9783866dbe5f2a1d2a963098c00b9f6bf9a1157a0b0fb0f2'),
('hon.record_chad_lead_plan_step(text,uuid,integer,jsonb)',true,true,'search_path=pg_catalog, hon','5b58c53f95d12e741265fcf98b771d97afe2c6f5550bed6d9e56cf8304333322'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (NOT f.definer OR owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Chad lead plan function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_kinds k WHERE k.kind='CHAD_LEAD_PLAN' AND k.agent_key='chad' AND k.task_class='DRAFT_FOLLOW_UP'
      AND k.input_budget=10000 AND k.output_budget=2500 AND k.max_cost_microunits=80000 AND k.max_result_bytes=12288
      AND k.caller='HUMAN_UI' AND k.subject_type='SCHOOL' AND k.usage_agent='CHAD_FOLLOW_UP') THEN
    RAISE EXCEPTION 'Chad lead plan kind row missing or changed';
  END IF;
  FOREACH t IN ARRAY ARRAY['hon.chad_lead_plan_refs','hon.chad_lead_plan_applied'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=t::regclass)
      OR has_table_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
      OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE')
      OR (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=t::regclass AND NOT g.tgisinternal AND g.tgenabled='O'
        AND g.tgfoid='hon.guard_alex_plan_rows()'::regprocedure)<>2 THEN
      RAISE EXCEPTION 'Chad lead plan table % is not closed',t;
    END IF;
  END LOOP;
END $$;
-- End Chad lead next steps exact verification.
-- Staff agent speech exact verification (0652): the private clip table (a digest and a length, never the words or the sound)
-- with its four S4 triggers, two private helpers and five runtime entry points. The eight S4 shared functions that gained
-- AGENT_SPEECH are pinned in the 0550 section above with their 0652 bodies.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.agent_speech_limits()',false,false,'search_path=pg_catalog','235a5d89c900d5fb27a8ad4ad46fc57552c541dcb8c260435ae0a8caa96708a5'),
('hon.agent_speech_actor(text,text)',true,false,'search_path=pg_catalog, hon','58b4e5429b30f4631b3488b42b7db0b6f0db03c0d48cff18791c6e7d630aa160'),
('hon.read_agent_speech_status(text,text,boolean)',true,true,'search_path=pg_catalog, hon','13f19b3d9ff39b73b48e68c657541ce7df0b35b8bcf98418b25ea3250db4cab9'),
('hon.begin_agent_speech(text,text,text,text,integer)',true,true,'search_path=pg_catalog, hon','47d3bcd80b4ceeb22522b14a66172cfdc9e3e90c7ff454aaabdaa8861d045f0c'),
('hon.prepare_agent_speech(text,uuid,boolean)',true,true,'search_path=pg_catalog, hon','68cc58641718e2737c90fe97a271299b99f4cfac1ecc3ae6a53c1d9404d15aed'),
('hon.fail_agent_speech(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','dbaed1958f7fed118126360475daadabc68d35d6164a8dbeac015d63948e24b9'),
('hon.record_agent_speech_result(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','7e32049882fd4dc21b09cbae94a37fab39705552f77186f8e8e6a88342b6fcb5'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe staff agent speech function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.agent_speech_clips'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.agent_speech_clips'::regclass)
    OR has_table_privilege('hon_runtime','hon.agent_speech_clips','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.agent_speech_clips','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe staff agent speech clip table';
  END IF;
  -- The table can hold no words and no sound: exactly these columns.
  IF (SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM pg_attribute a WHERE a.attrelid='hon.agent_speech_clips'::regclass AND a.attnum>0 AND NOT a.attisdropped)
     <> ARRAY['agent_key','characters','created_at','held_at','id','idempotency_key','organization_id','provider_request_id','reason','requested_by','reserved_credits','school_id','status','text_digest','updated_at','usage_id'] THEN
    RAISE EXCEPTION 'Staff agent speech clip columns changed';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='hon.agent_speech_clips'::regclass AND t.tgenabled='O' AND (t.tgname, t.tgfoid) IN (
      ('ai_spend_start_guard','hon.ai_spend_start_guard()'::regprocedure), ('ai_spend_reserve_guard','hon.ai_spend_reserve_guard()'::regprocedure),
      ('ai_spend_reserve_guard_insert','hon.ai_spend_reserve_guard()'::regprocedure), ('zz_ai_hold_origin','hon.ai_stamp_hold_origin()'::regprocedure))) <> 4 THEN
    RAISE EXCEPTION 'Staff agent speech clip S4 triggers missing';
  END IF;
END $$;
-- End staff agent speech exact verification.
-- Blast pictures exact verification (0653)
-- Three private helpers, the worker-only campaign picture lookup, and the 0653 body check on hon.school_blasts in place of
-- the 0621 one.
DO $$ DECLARE f record; worker_oid oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_communication_worker'); BEGIN
  FOR f IN SELECT * FROM (VALUES
    ('hon.school_blast_picture_ids(text)',false,false),('hon.school_blast_body_ok(jsonb,text)',false,false),
    ('hon.school_blast_pictures_ready(uuid,uuid,text)',false,false),('hon.communication_email_pictures(uuid,uuid)',true,true)) e(signature,definer,worker_allowed) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f.signature::regprocedure AND p.prosecdef=f.definer
        AND (NOT f.definer OR o.rolsuper OR o.rolbypassrls) AND NOT has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.privilege_type<>'EXECUTE' OR NOT (f.worker_allowed AND a.grantee IS NOT DISTINCT FROM worker_oid)))) THEN
      RAISE EXCEPTION 'Unsafe blast picture function: %',f.signature; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.school_blasts'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%school_blast_text_ok(to_jsonb(body)%')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.school_blasts'::regclass AND conname='school_blasts_body_ok' AND convalidated
      AND pg_get_constraintdef(oid) LIKE '%school_blast_body_ok(to_jsonb(body), channel)%') THEN
    RAISE EXCEPTION 'Unsafe blast picture body check';
  END IF;
END $$;
-- End blast pictures exact verification.
-- School videos exact verification (0654)
-- Seven runtime-only entry points, two private helpers, the copy service principal, and the combined kind check.
DO $$ DECLARE f text;
  entry text[]:=ARRAY['hon.begin_school_video_upload(text,jsonb,text,uuid,uuid)','hon.finish_school_video_upload(text,jsonb,uuid,uuid)',
    'hon.claim_school_video_copy()','hon.finish_school_video_copy(uuid,uuid,jsonb)','hon.fail_school_video_copy(uuid,uuid,text)',
    'hon.resolve_school_video_poster(text)','hon.resolve_school_video_page(text)'];
  helpers text[]:=ARRAY['hon.school_video_copy_record(hon.school_media_assets,text,jsonb)','hon.school_blast_video_ids(text)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe school video entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe school video helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000654' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL)
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.school_media_assets'::regclass AND conname='school_media_assets_kind_check' AND convalidated)
    OR has_table_privilege('hon_runtime','hon.school_media_assets','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'Unsafe school video setup';
  END IF;
END $$;
-- End school videos exact verification.

-- Profile details exact verification (0656): two runtime entry points, private helpers, a private table.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.person_profile_contact_list(jsonb,text,text)',false,false,'search_path=pg_catalog','i','0859ee1b7ccfffcda5dd1e17cb1c96b553619c630c4c8f94b38b3bd504b707bc'),
('hon.person_profile_details_json(uuid,text)',false,false,'search_path=pg_catalog, hon','s','71fc0dd8515dc24569eed24f08e09c2c919b2c82f21769083c271bab033ec3ad'),
('hon.read_school_person_details(text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','s','a7f2c7808b1845d28a14ed29f15eb4a61bca3576423d38f49861cf6c92453144'),
('hon.update_school_person_details(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','v','99183aaf4b5e2b529590dfc408f234a1c244346bbc8251aa71d0db9b287d0092')) e(signature,definer,runtime_allowed,config,volatility,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config] AND p.provolatile=f.volatility
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe profile details function: %',f.signature; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') AND (has_table_privilege('hon_runtime','hon.person_profile_details','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='hon.person_profile_details'::regclass)) THEN
    RAISE EXCEPTION 'hon.person_profile_details must stay private with forced RLS'; END IF;
END $$;
-- End profile details exact verification.
-- Staff-chosen phone alerts exact verification (0658): four private helpers nobody else may run, and one private forced-RLS
-- request table with exactly its two guards. The changed staff commands and worker claim are pinned in the 0330, 0576 and 0601 sections.
DO $$ DECLARE f record; safe boolean; worker oid:=(SELECT oid FROM pg_roles WHERE rolname='hon_communication_worker'); BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.guard_parent_push_request()',false,'search_path=pg_catalog, hon','c6cefca6bb46af125148bdf2308a5c651fc245e707e37f6fb97a4db02e639b4a'),
('hon.request_parent_push(uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid)',true,'search_path=pg_catalog, hon','c3c05c806639ac2fcc7617b14c3e7db22e15a0bf5b4c4a8ee97417064acd948b'),
('hon.parent_push_choice(jsonb,text[])',false,'search_path=pg_catalog','cfb9c4239c12117d337b1e9dbaa22954312e9fea4f13a6c9c2776ab68f503b86'),
('hon.parent_push_principal_in_family(uuid,uuid,uuid,uuid)',true,'search_path=pg_catalog, hon','c18a444b92328eab98619def2521206f72cded18fabef912f752eef7eb5c40a9')) e(signature,definer,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND NOT has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND (worker IS NULL OR NOT has_function_privilege(worker,p.oid,'EXECUTE'))
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe parent push request function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.parent_push_requests'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.parent_push_requests'::regclass)
    OR has_table_privilege('hon_runtime','hon.parent_push_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.parent_push_requests','SELECT,INSERT,UPDATE,REFERENCES')
    OR (worker IS NOT NULL AND (has_table_privilege(worker,'hon.parent_push_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(worker,'hon.parent_push_requests','SELECT,INSERT,UPDATE,REFERENCES'))) THEN
    RAISE EXCEPTION 'Unsafe parent push request table'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.parent_push_requests'::regclass AND NOT tgisinternal AND tgenabled='O'
      AND ((tgname='parent_push_requests_guard' AND tgfoid='hon.guard_parent_push_request()'::regprocedure)
        OR (tgname='parent_push_requests_no_truncate' AND tgfoid='hon.guard_membership_activation_evidence()'::regprocedure)))<>2
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.parent_push_requests'::regclass AND NOT tgisinternal)<>2 THEN
    RAISE EXCEPTION 'hon.parent_push_requests must carry exactly its two guards'; END IF;
END $$;
-- End staff-chosen phone alerts exact verification.

-- Contact card membership details exact verification (0659): one read-only runtime entry point.
DO $$ DECLARE safe boolean; BEGIN
  SELECT p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND p.provolatile='s' AND p.prorettype='jsonb'::regtype
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='49d602c84403e8ffffed17c874a5520f7de948f5d41fff317e44e3ef042eff92'
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid='hon.read_school_contact_membership_details(text,jsonb)'::regprocedure;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe or drifted hon.read_school_contact_membership_details'; END IF;
END $$;
-- End contact card membership details exact verification.

-- HQ school lifecycle exact verification (0675): two runtime entry points, two private helpers, three forced-RLS tables.
DO $$ DECLARE f text; t text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.transition_school_lifecycle_from_hq(text,uuid,text,text,text,uuid,uuid,uuid)','hon.read_hq_school_archive_dates(text)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure
        AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
      RAISE EXCEPTION 'Unsafe HQ school lifecycle entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_hq_school_lifecycle_evidence()','hon.require_hq_school_lifecycle_actor(text)'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND (a.grantee=0 OR a.grantee<>p.proowner)) THEN
      RAISE EXCEPTION 'Unsafe HQ school lifecycle helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hq_school_lifecycle_requests','hq_school_lifecycle_audit','hq_school_lifecycle_outbox'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
      OR EXISTS(SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner) THEN
      RAISE EXCEPTION 'Unsafe HQ school lifecycle table: %',t; END IF;
    IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgfoid='hon.guard_hq_school_lifecycle_evidence()'::regprocedure AND tgenabled='O' AND NOT tgisinternal)<>2 THEN
      RAISE EXCEPTION 'HQ school lifecycle evidence guard missing: %',t; END IF;
  END LOOP;
END $$;
-- End HQ school lifecycle exact verification.

-- HQ school plan assignments exact verification (0676; 0700 start date replaced assign + json bodies): three runtime entry points, eleven private helpers, two forced-RLS tables.
DO $$ DECLARE f text; t text; c text; d boolean; s text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.read_hq_school_plan(text,uuid)','hon.assign_hq_school_plan(text,uuid,jsonb,uuid)','hon.remove_hq_school_plan(text,uuid,jsonb,uuid)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure
        AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
      RAISE EXCEPTION 'Unsafe HQ school plan entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_hq_school_plan_evidence()','hon.require_hq_school_plan_owner(text)','hon.hq_school_plan_owner_eligible(uuid)',
      'hon.hq_school_plan_json(hon.hq_school_plan_assignments)','hon.hq_school_plan_offers()','hon.hq_school_plan_current(uuid)',
      'hon.hq_school_plan_view(uuid,uuid)','hon.hq_school_plan_claim(uuid,uuid,text,text)','hon.hq_school_plan_lock(uuid,integer,boolean)',
      'hon.hq_school_plan_expected(jsonb)','hon.hq_school_plan_note(jsonb)'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND (a.grantee=0 OR a.grantee<>p.proowner)) THEN
      RAISE EXCEPTION 'Unsafe HQ school plan helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hq_school_plan_assignments','hq_school_plan_requests'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
      OR EXISTS(SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner) THEN
      RAISE EXCEPTION 'Unsafe HQ school plan table: %',t; END IF;
    IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgfoid='hon.guard_hq_school_plan_evidence()'::regprocedure AND tgenabled='O' AND NOT tgisinternal)<>2 THEN
      RAISE EXCEPTION 'HQ school plan guard missing: %',t; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname LIKE '%hq_school_plan%')<>14 THEN
    RAISE EXCEPTION 'Unexpected HQ school plan overload'; END IF;
  FOR f,t,c,d,s IN SELECT * FROM (VALUES
    ('hon.assign_hq_school_plan(text,uuid,jsonb,uuid)','c443425ca5d999c6d72d3cf998d33df5','v',true),
    ('hon.guard_hq_school_plan_evidence()','038a3ad60cf851ce84ba3330bd4f322f','v',false),
    ('hon.hq_school_plan_claim(uuid,uuid,text,text)','0a52e5a8f7173cab4dea868e50576ecc','v',false),
    ('hon.hq_school_plan_current(uuid)','48f22d7aa8b47ced2aa0919af9fe9321','s',false),
    ('hon.hq_school_plan_expected(jsonb)','6005bd5c38be258c8367427e3a30e3c9','i',false),
    ('hon.hq_school_plan_json(hon.hq_school_plan_assignments)','c7bff4b414af640628afdc9ae004e812','s',false),
    ('hon.hq_school_plan_lock(uuid,integer,boolean)','a27fab280c617381ef01c69dcbd09c2b','v',false),
    ('hon.hq_school_plan_note(jsonb)','5b8a66141e4fbf795300b6fc4d7b432f','i',false),
    ('hon.hq_school_plan_offers()','180aff67b318b9fc3c25f7a0c5641179','s',false),
    ('hon.hq_school_plan_owner_eligible(uuid)','dbc3cd018b615eacfbd5ce243d396c5d','s',false),
    ('hon.hq_school_plan_view(uuid,uuid)','913e37dbe15b2be2ff90ee6780f0d9c4','s',false),
    ('hon.read_hq_school_plan(text,uuid)','1383b8081a88528f41e6ef62d2b64e24','v',true),
    ('hon.remove_hq_school_plan(text,uuid,jsonb,uuid)','72e0e4601531edfd50863ef4beae49a9','v',true),
    ('hon.require_hq_school_plan_owner(text)','6e7895d645e16e9bd9c5195ef8ecbd55','v',false)) x(f,t,c,d) CROSS JOIN (SELECT 'search_path=pg_catalog, hon'::text) y(s) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND md5(p.prosrc)=t AND p.provolatile=c AND p.prosecdef=d
        AND p.proconfig IS NOT DISTINCT FROM ARRAY[s]) THEN
      RAISE EXCEPTION 'HQ school plan function body/posture drift: %',f; END IF;
  END LOOP;
END $$;
-- End HQ school plan assignments exact verification.

-- HQ ad account connections exact verification (0677): six runtime entry points, seven private helpers, five forced-RLS tables.
DO $$ DECLARE f text; t text; c text; d boolean; s text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.read_hq_ad_accounts(text)','hon.start_hq_ad_connect(text,jsonb,text)','hon.record_hq_ad_profile(text,uuid,text)',
      'hon.claim_hq_ad_connect(text,text)','hon.record_hq_ad_accounts(text,uuid,jsonb)','hon.disconnect_hq_ad_account(text,uuid,jsonb,uuid)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure
        AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
      RAISE EXCEPTION 'Unsafe HQ ad connection entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_hq_ad()','hon.hq_ad_owner_eligible(uuid)','hon.require_hq_ad_actor(text,boolean)','hon.hq_ad_account_json(hon.hq_ad_accounts)',
      'hon.hq_ad_accounts_json()','hon.hq_ad_event(text,uuid,uuid,uuid,jsonb)','hon.hq_ad_open_intent(uuid,uuid)'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND (a.grantee=0 OR a.grantee<>p.proowner)) THEN
      RAISE EXCEPTION 'Unsafe HQ ad connection helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hq_ad_profile','hq_ad_accounts','hq_ad_connect_intents','hq_ad_requests','hq_ad_events'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
      OR EXISTS(SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner) THEN
      RAISE EXCEPTION 'Unsafe HQ ad connection table: %',t; END IF;
    IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgfoid='hon.guard_hq_ad()'::regprocedure AND tgenabled='O' AND NOT tgisinternal)<>2 THEN
      RAISE EXCEPTION 'HQ ad connection guard missing: %',t; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND (proname LIKE '%hq\_ad\_%' OR proname='guard_hq_ad'))<>13 THEN
    RAISE EXCEPTION 'Unexpected HQ ad connection overload'; END IF;
  FOR f,t,c,d,s IN SELECT * FROM (VALUES
    ('hon.claim_hq_ad_connect(text,text)','e8fb92ded4d17db66accd3d79cfb1289','v',true,'search_path=pg_catalog, hon'),
    ('hon.disconnect_hq_ad_account(text,uuid,jsonb,uuid)','b216501f99a353098889476837085820','v',true,'search_path=pg_catalog, hon'),
    ('hon.guard_hq_ad()','995f9a67805f08f1d1d8e2a3b09c7ecb','v',false,'search_path=pg_catalog, hon'),
    ('hon.hq_ad_account_json(hon.hq_ad_accounts)','4966a321b1b8fbd39badaa04ccc03105','s',false,'search_path=pg_catalog, hon'),
    ('hon.hq_ad_accounts_json()','db0ee8455ed9aa2399443a6f689405d9','s',false,'search_path=pg_catalog, hon'),
    ('hon.hq_ad_event(text,uuid,uuid,uuid,jsonb)','e2aadd252affd3709c0bd5204f60bb7e','v',false,'search_path=pg_catalog, hon'),
    ('hon.hq_ad_open_intent(uuid,uuid)','b94d44e9146e956a3df8e3a4edfc9846','v',false,'search_path=pg_catalog, hon'),
    ('hon.hq_ad_owner_eligible(uuid)','6aa8dd564fe2af7cea8d2cf0db4e6c25','s',false,'search_path=pg_catalog, hon'),
    ('hon.read_hq_ad_accounts(text)','d3c2da11fff3e0c147f19c0435d958bd','v',true,'search_path=pg_catalog, hon'),
    ('hon.record_hq_ad_accounts(text,uuid,jsonb)','ce1b78e40466523ccb181aeddc98e93c','v',true,'search_path=pg_catalog, hon'),
    ('hon.record_hq_ad_profile(text,uuid,text)','7079b9b04de43d9ffc54cf052d633454','v',true,'search_path=pg_catalog, hon'),
    ('hon.require_hq_ad_actor(text,boolean)','d892ab624ab770d942cae767f2fca92a','v',false,'search_path=pg_catalog, hon'),
    ('hon.start_hq_ad_connect(text,jsonb,text)','251fef7be73988c7ee362aa6125fd0ca','v',true,'search_path=pg_catalog, hon')) x(f,t,c,d,s) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND md5(p.prosrc)=t AND p.provolatile=c AND p.prosecdef=d
        AND p.proconfig IS NOT DISTINCT FROM ARRAY[s]) THEN
      RAISE EXCEPTION 'HQ ad connection function body/posture drift: %',f; END IF;
  END LOOP;
END $$;
-- End HQ ad account connections exact verification.
-- Membership activates on signing exact verification (0680): no runtime entry point, two owner-only functions, one deferred
-- signature trigger, one forced-RLS immutable outcome table, and the 0177 decision checks that bind each basis to its rules.
DO $$ DECLARE f text; t text; c text; d boolean; s text;
BEGIN
  FOR f,t,c,d,s IN SELECT * FROM (VALUES
    ('hon.membership_agreement_signed_starts()','ceac82a22b556d83ee6d0abc3e3eb5a4','v',true,'search_path=pg_catalog, hon'),
    ('hon.membership_start_on_signing(hon.membership_agreement_signatures,uuid)','10ef849cc2f518bab9164bee2eac0908','v',true,'search_path=pg_catalog, hon')) x(f,t,c,d,s) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND md5(p.prosrc)=t AND p.provolatile=c
        AND p.prosecdef=d AND (o.rolsuper OR o.rolbypassrls) AND p.proconfig IS NOT DISTINCT FROM ARRAY[s])
      OR has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND (a.grantee=0 OR a.grantee<>p.proowner)) THEN
      RAISE EXCEPTION 'Membership signing start function body/posture drift: %',f; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname IN ('membership_agreement_signed_starts','membership_start_on_signing'))<>2 THEN
    RAISE EXCEPTION 'Unexpected membership signing start overload'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.membership_agreement_signatures'::regclass AND tgname='membership_agreement_signed_starts'
      AND tgfoid='hon.membership_agreement_signed_starts()'::regprocedure AND tgenabled='O' AND tgdeferrable AND tginitdeferred AND tgconstraint<>0)<>1 THEN
    RAISE EXCEPTION 'Membership signing start trigger missing or not deferred'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.membership_signing_activations'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename='membership_signing_activations')
    OR EXISTS(SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='hon.membership_signing_activations'::regclass AND a.grantee<>c.relowner)
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.membership_signing_activations'::regclass AND tgfoid='hon.guard_membership_activation_evidence()'::regprocedure
      AND tgenabled='O' AND NOT tgisinternal)<>2 THEN
    RAISE EXCEPTION 'Unsafe membership signing outcome table'; END IF;
  FOR t,s IN SELECT * FROM (VALUES
    ('membership_activation_decisions_decision_basis_check','CHECK ((decision_basis = ANY (ARRAY[''STAFF_ACTIVATION_PRE_POLICY''::text, ''AGREEMENT_SIGNED''::text])))'),
    ('membership_activation_decisions_authorizing_permission_check','CHECK ((authorizing_permission = ANY (ARRAY[''billing.membership.activate''::text, ''membership_agreement.signed''::text])))'),
    ('membership_activation_decisions_signing_basis_check','ad4f56069ec01210852c31434f8bca75'),
    ('membership_activation_decision_requirements_not_evaluated_check','b41b29543d33fe8cf2845c400ecfb93f')) x(t,s) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.membership_activation_decisions'::regclass AND conname=t AND contype='c' AND convalidated
        AND (pg_get_constraintdef(oid)=s OR md5(pg_get_constraintdef(oid))=s)) THEN
      RAISE EXCEPTION 'Membership activation decision check drift: %',t; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.membership_effective_periods'::regclass AND conname='membership_effective_periods_authorizing_permission_check'
      AND pg_get_constraintdef(oid)='CHECK ((authorizing_permission = ANY (ARRAY[''billing.membership.activate''::text, ''membership_agreement.signed''::text])))') THEN
    RAISE EXCEPTION 'Membership effective period permission check drift'; END IF;
END $$;
-- End membership activates on signing exact verification.
-- Staff timesheet no-self-approval exact verification (0681)
DO $$ DECLARE f text:='hon.staff_time_actor_is_owner(uuid,uuid,uuid)';
BEGIN
  IF to_regprocedure(f) IS NULL OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
    RAISE EXCEPTION 'Unsafe staff time helper: %',f; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='hon.set_staff_timesheet_week(text,jsonb,text,uuid,uuid)'::regprocedure
      AND position('TIMESHEET_SELF_APPROVAL' IN p.prosrc)>0 AND position('staff_time_actor_is_owner' IN p.prosrc)>0) THEN
    RAISE EXCEPTION 'Staff timesheet self-approval block missing'; END IF;
END $$;
-- End staff timesheet no-self-approval exact verification.
-- Kai teaching journal exact verification (0685)
DO $$ DECLARE f text;
  entry text[]:=ARRAY['hon.read_kai_journal(text,date,date)','hon.read_kai_team_journal(text,date,date)','hon.save_kai_journal_entry(text,jsonb,text,uuid,uuid)'];
  helpers text[]:=ARRAY['hon.kai_journal_text_ok(text,integer,boolean)','hon.kai_journal_topics_ok(text[])','hon.guard_kai_journal_entry()',
    'hon.require_kai_journal_actor(text)','hon.kai_journal_json(hon.kai_journal_entries)','hon.kai_journal_display_name(uuid)'];
BEGIN
  FOREACH f IN ARRAY entry LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
          AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')))) THEN
      RAISE EXCEPTION 'Unsafe Kai journal entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY helpers LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
      RAISE EXCEPTION 'Unsafe Kai journal helper: %',f; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.kai_journal_entries'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='hon.kai_journal_entries'::regclass)
    OR has_table_privilege('hon_runtime','hon.kai_journal_entries','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege('hon_runtime','hon.kai_journal_entries','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe Kai journal table'; END IF;
  IF (SELECT count(*) FROM hon.permissions WHERE code='teaching.journal.use' AND is_staff_assignable AND NOT is_sensitive)<>1 THEN
    RAISE EXCEPTION 'Kai journal permission missing'; END IF;
END $$;
-- End Kai teaching journal exact verification.

-- Monthly goal plan exact verification (G1 0686): one runtime read; the renewals-due helper and the rate and pace builders are private.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.monthly_goal_pace(numeric,numeric,numeric,integer)',false,false,'search_path=pg_catalog, hon','52e59707b1b0588614110a0e5d22907560c831e397973aad8fd0920cf05430c5'),
('hon.monthly_goal_rate(bigint,bigint,integer,numeric)',false,false,'search_path=pg_catalog, hon','e001224945722db79f76d8dda1692cef5351ffe98f129a71e4002252905a00b9'),
('hon.school_renewals_due(uuid,uuid,timestamptz,timestamptz,timestamptz)',true,false,'search_path=pg_catalog, hon','b9a001e01a07bd2859bfe5096d005980f136641692b23693f8221ecfa2dfdc98'),
('hon.read_monthly_goal_plan(text,jsonb)',true,true,'search_path=pg_catalog, hon','5cce372659029086067d4686d3b3d4ce883f7f61281a367b9dade388d69bbf23')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe monthly goal plan function: %',f.signature; END IF;
  END LOOP;
END $$;
-- End monthly goal plan exact verification.
-- Conversation AI test chat exact verification (0687): the CONVERSATION_TEST kind row (fixed budgets) and its twelve functions,
-- six of them runtime entry points. The shared AI text core and S4 functions are pinned in the 0550 section above, unchanged.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.begin_conversation_ai_test(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','270dd60e82325d4876fe52031ddaf2876ecac607ccd53fd8a73f3b9a2775bf02'),
('hon.conversation_ai_test_actor(text)',true,false,'search_path=pg_catalog, hon','ca2f6549c8e40ea3788f9d340fa6bd2794570a35d35b2aeafd47ae0d3e32f063'),
('hon.conversation_ai_test_allowed(uuid)',true,false,'search_path=pg_catalog, hon','29df31059946fd9ef66aa1a1c2841e453c2c83550b8223cde99b93aba8826b53'),
('hon.conversation_ai_test_answer_ok(jsonb)',false,false,'search_path=pg_catalog, hon','72b2c592d9447d2bc764b019c8d159074e319be4af2468dee286dfdb34042150'),
('hon.conversation_ai_test_facts(uuid,uuid)',true,false,'search_path=pg_catalog, hon','d6ecb68135efb6773b42a549cbbfe5f5c7d5f3ec0333f107227a25f8974a7a15'),
('hon.conversation_ai_test_planning_reference(text,uuid)',true,true,'search_path=pg_catalog, hon','6517dcf07a9eb60ed80135b1a0ab43fbcc141da031dcc28ed5ea7259a4b6f15b'),
('hon.conversation_ai_test_unavailable_reason(uuid,boolean)',true,false,'search_path=pg_catalog, hon','c207903058dcad4de5a1ba9a008f9809cdfb05afe332c4524464db0f53fadd06'),
('hon.conversation_ai_test_view(uuid)',true,false,'search_path=pg_catalog, hon','c818398e5cb74ad9dfa3fb57efd1007370b5f03c11cc9c50bd6b8902af73e633'),
('hon.fail_conversation_ai_test(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','3717ca791019a6f20a0b71f950b139ba585401b51c24a942ec0d6a1b0b1e4e49'),
('hon.prepare_conversation_ai_test(text,uuid,uuid,boolean)',true,true,'search_path=pg_catalog, hon','fc60c70090fc4b49060e948ddcc969b2e2fd9b784fa23705cbf15a97e8235cc5'),
('hon.read_conversation_ai_test(text,boolean)',true,true,'search_path=pg_catalog, hon','04c2b5b87ed46709d8f7e09e833f8c0d3117af6657f917af2bae5e9dc807039f'),
('hon.record_conversation_ai_test(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','496f88281ae26f369b758a931ba2af024c4c89bf4ab967f41e7e979342edc798'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe Conversation AI test function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_kinds WHERE kind='CONVERSATION_TEST' AND agent_key='chad' AND task_class='DRAFT_FOLLOW_UP' AND input_budget=12000
      AND output_budget=600 AND max_cost_microunits=20000 AND max_result_bytes=4096 AND caller='HUMAN_UI' AND subject_type='CONVERSATION_AI_TEST' AND usage_agent='CONVERSATION_TEST') THEN
    RAISE EXCEPTION 'Conversation AI test kind missing or changed';
  END IF;
END $$;
-- End Conversation AI test chat exact verification.

-- AI website edits on creative credits exact verification (0690): the billing registry (exactly WEBSITE_EDIT -> website.edit)
-- and the proposal-to-reservation link, both deny-all with forced RLS; the private reserve and settle helpers and the two
-- guards; the CW1 functions it re-created; the runtime read of the website price; the triggers and the WEBSITE catalog
-- rule. ai_text_prepare and ai_text_record are pinned in the 0550 section above with their 0690 bodies.
DO $$ DECLARE f record; safe boolean; t text; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.ai_text_creative_applies(hon.ai_text_proposals,timestamptz)',true,false,'search_path=pg_catalog, hon','0d82ad6f95132caba978fcfcbc07f93f69d550078976fd95457246541c45522e'),
('hon.ai_text_creative_reserve(hon.ai_text_proposals,hon.ai_invocation_plans)',true,false,'search_path=pg_catalog, hon','ffc643599a798dbf3019ba3af30ecfd543bde21aee9b9ae23dc1644bcae07bce'),
('hon.ai_text_creative_settle()',true,false,'search_path=pg_catalog, hon','e7fa39c773cac29df7468ad105d16d6585b4862409a237c2cca924e5c11bb4fa'),
('hon.guard_ai_text_creative()',false,false,'search_path=pg_catalog, hon','7ab0272cdad7ca16d51de0e31f3909fe7068e98fc6698fa136cce5f364b0373e'),
('hon.guard_website_creative_reservation()',false,false,'search_path=pg_catalog, hon','ad6f745fb6ac071dc44ced7f1afc5150e9f54bb9f420ac16804f57475bbc28e9'),
('hon.publish_saas_creative_rates(text,jsonb,uuid,uuid,uuid)',true,true,'search_path=pg_catalog, hon','36ad727f1afee92526332e68db3559ab9d13033c5181dd182cec683b2fd4a20b'),
('hon.read_school_website_ai_price(text)',true,true,'search_path=pg_catalog, hon','153efc69b051846eb51cc20345ad68a393da697c3cdb8a0d22d3be684d0c62c4'),
('hon.saas_creative_record_usage(hon.saas_creative_reservations,uuid,bigint,integer)',true,false,'search_path=pg_catalog, hon','40161eb555fa2eea3e8169f54e85246bec47c32b0ce828314dea98a7b644304b'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (NOT f.definer OR owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe website AI creative credit function: %',f.signature; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hon.ai_text_creative_billing','hon.ai_text_creative_reservations'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=t::regclass)
      OR has_table_privilege('hon_runtime',t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege('hon_runtime',t,'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe website AI creative credit table: %',t;
    END IF;
  END LOOP;
  IF (SELECT array_agg(kind||'='||operation_code ORDER BY kind) FROM hon.ai_text_creative_billing) IS DISTINCT FROM ARRAY['WEBSITE_EDIT=website.edit'] THEN
    RAISE EXCEPTION 'Website AI creative billing registry changed';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgenabled='O' AND (t.tgrelid, t.tgname, t.tgfoid) IN (
      ('hon.ai_text_creative_billing'::regclass,'ai_text_creative_billing_immutable','hon.guard_ai_text_creative()'::regprocedure),
      ('hon.ai_text_creative_billing'::regclass,'ai_text_creative_billing_no_truncate','hon.guard_ai_text_creative()'::regprocedure),
      ('hon.ai_text_creative_reservations'::regclass,'ai_text_creative_reservations_immutable','hon.guard_ai_text_creative()'::regprocedure),
      ('hon.ai_text_creative_reservations'::regclass,'ai_text_creative_reservations_no_truncate','hon.guard_ai_text_creative()'::regprocedure),
      ('hon.saas_creative_reservations'::regclass,'website_creative_reservation_guard','hon.guard_website_creative_reservation()'::regprocedure),
      ('hon.ai_text_proposals'::regclass,'zz_ai_text_creative_settle','hon.ai_text_creative_settle()'::regprocedure))) <> 6 THEN
    RAISE EXCEPTION 'Website AI creative credit triggers missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='hon.saas_creative_rates'::regclass AND c.conname='saas_creative_rates_unit_fits_kind' AND c.convalidated
      AND pg_get_constraintdef(c.oid) LIKE '%max_units_per_request = 1%' AND pg_get_constraintdef(c.oid) LIKE '%PROVISIONAL%') THEN
    RAISE EXCEPTION 'Website creative rate rule missing';
  END IF;
END $$;
-- End AI website edits on creative credits exact verification.
-- Creative media storage exact verification (C3 0691): one private forced-RLS table the runtime cannot touch, three
-- runtime entry points, the stored-result worker function and private helpers not runnable by it.
DO $$ DECLARE f text; BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.creative_stored_objects'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='hon.creative_stored_objects'::regclass)
    OR has_table_privilege('hon_runtime','hon.creative_stored_objects','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'Unsafe creative stored object table posture'; END IF;
  FOREACH f IN ARRAY ARRAY['hon.authorize_creative_asset_read(text,uuid,uuid)','hon.delete_creative_asset(text,uuid,uuid)',
    'hon.confirm_creative_asset_removed(text,uuid,uuid)','hon.record_creative_provider_job_stored_result(uuid,uuid,jsonb,jsonb)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND (owner.rolsuper OR owner.rolbypassrls)) THEN
      RAISE EXCEPTION 'Unsafe creative media function: %',f; END IF;
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE') <> (f NOT LIKE 'hon.record_creative_provider_job_%') THEN
      RAISE EXCEPTION 'Wrong runtime EXECUTE on creative media function: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.creative_school_object(text,uuid,uuid,boolean)','hon.guard_creative_stored_object()'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE') THEN RAISE EXCEPTION 'Creative media helper runnable by runtime: %',f; END IF;
  END LOOP;
END $$;
-- End creative media storage exact verification.
-- Creative asset review exact verification (C4 0692): one private forced-RLS append-only table the runtime cannot touch,
-- two runtime entry points, private helpers not runnable by it.
DO $$ DECLARE f text; BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.creative_asset_reviews'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='hon.creative_asset_reviews'::regclass)
    OR has_table_privilege('hon_runtime','hon.creative_asset_reviews','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'Unsafe creative asset review table posture'; END IF;
  FOREACH f IN ARRAY ARRAY['hon.review_creative_asset(text,uuid,uuid,text)','hon.list_creative_review_queue(text,uuid,integer)','hon.authorize_creative_asset_read(text,uuid,uuid)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f::regprocedure AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog, hon'] AND (owner.rolsuper OR owner.rolbypassrls)) THEN
      RAISE EXCEPTION 'Unsafe creative review function: %',f; END IF;
    IF NOT has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE') THEN RAISE EXCEPTION 'Missing runtime EXECUTE on creative review function: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.creative_asset_review_status(uuid)','hon.creative_reviewer_holds(uuid,uuid,uuid)','hon.guard_creative_asset_review()'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE') THEN RAISE EXCEPTION 'Creative review helper runnable by runtime: %',f; END IF;
  END LOOP;
END $$;
-- End creative asset review exact verification.
-- School voice apps exact verification (0693): one private forced-RLS table, one staff runtime entry point, worker-only
-- claim/record/key functions and an owner-only guard, all SECURITY DEFINER with the fixed search path.
DO $$ DECLARE f text;
  entry text[]:=ARRAY['hon.authorize_school_phone_token(text)'];
  worker text[]:=ARRAY['hon.read_schools_needing_voice_app(integer)','hon.begin_school_voice_app(uuid,integer)','hon.record_school_voice_app_twiml(uuid,uuid,text)',
    'hon.complete_school_voice_app(uuid,uuid,text,text,text)','hon.read_school_voice_app(uuid)'];
  closed text[]:=ARRAY['hon.guard_school_voice_app()'];
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.school_voice_apps'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR has_table_privilege('hon_runtime','hon.school_voice_apps','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR (EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker')
      AND has_table_privilege('hon_communication_worker','hon.school_voice_apps','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) THEN
    RAISE EXCEPTION 'Unsafe school voice apps table'; END IF;
  FOREACH f IN ARRAY entry||worker||closed LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND p.prosecdef AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon'])
      OR has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE') IS DISTINCT FROM (f=ANY(entry))
      OR (EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker')
        AND has_function_privilege('hon_communication_worker',f::regprocedure,'EXECUTE') IS DISTINCT FROM (f=ANY(worker)))
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND a.grantee=0) THEN
      RAISE EXCEPTION 'Unsafe school voice apps function: %',f; END IF;
  END LOOP;
END $$;
-- End school voice apps exact verification.
-- HQ calls exact verification (0694): six private forced-RLS tables, nine HQ runtime entry points, worker-only provider
-- functions and owner-only definer helpers, all SECURITY DEFINER with the fixed search path.
DO $$ DECLARE f text; t text;
  entry text[]:=ARRAY['hon.read_hq_calling(text)','hon.set_hq_calling_settings(text,jsonb)','hon.set_my_hq_call_ringing(text,jsonb)',
    'hon.start_hq_call(text,jsonb,text)','hon.read_hq_calls(text,jsonb)','hon.update_hq_call(text,jsonb)','hon.set_hq_do_not_call(text,jsonb)',
    'hon.open_hq_call_recording(text,uuid)','hon.authorize_hq_phone_token(text)'];
  worker text[]:=ARRAY['hon.hq_needs_voice_app()','hon.begin_hq_voice_app(integer)','hon.record_hq_voice_app_twiml(uuid,text)',
    'hon.complete_hq_voice_app(uuid,text,text,text)','hon.read_hq_voice_app()','hon.connect_hq_client_call(uuid,text,text)',
    'hon.route_hq_incoming_call(text,text,text)','hon.record_hq_call_status(text,text,text,integer,timestamptz)',
    'hon.record_hq_call_voicemail(text,text,integer)','hon.read_hq_call_recordings_due(integer)','hon.mark_hq_call_recording_deleted(uuid,text)'];
  closed text[]:=ARRAY['hon.guard_hq_call()','hon.guard_hq_calling_row()','hon.guard_hq_voice_app()','hon.guard_hq_call_evidence()',
    'hon.hq_call_staff_ok(uuid)','hon.hq_call_number()','hon.hq_call_contact(text)','hon.expire_hq_calls()','hon.hq_call_json(hon.hq_calls)',
    'hon.hq_call_evidence(uuid,uuid,text,text,jsonb)'];
BEGIN
  FOREACH t IN ARRAY ARRAY['hq_calling_settings','hq_call_staff','hq_calls','hq_do_not_call','hq_voice_app','hq_call_events'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=('hon.'||t)::regclass)
      OR has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR (EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker')
        AND has_table_privilege('hon_communication_worker','hon.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) THEN
      RAISE EXCEPTION 'Unsafe HQ calls table: %',t; END IF;
  END LOOP;
  FOREACH f IN ARRAY entry||worker||closed LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND p.prosecdef AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon'])
      OR has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE') IS DISTINCT FROM (f=ANY(entry))
      OR (EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker')
        AND has_function_privilege('hon_communication_worker',f::regprocedure,'EXECUTE') IS DISTINCT FROM (f=ANY(worker)))
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND a.grantee=0) THEN
      RAISE EXCEPTION 'Unsafe HQ calls function: %',f; END IF;
  END LOOP;
END $$;
-- End HQ calls exact verification.
-- HQ school visits exact verification (0696): three runtime entry points, five private helpers, four forced-RLS tables,
-- and 63 school checks that carry the live-visit test.
DO $$ DECLARE f text; t text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.enter_school_as_hq(text,uuid,text,uuid,uuid,uuid)','hon.leave_school_as_hq(text,uuid,uuid,uuid,uuid)','hon.read_my_hq_school_visits(text)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=f::regprocedure
        AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls) AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon']
        AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) THEN
      RAISE EXCEPTION 'Unsafe HQ school visit entry point: %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_hq_school_visit_evidence()','hon.hq_visit_active(uuid)','hon.ensure_hq_support_role(uuid)',
      'hon.require_hq_school_visit_actor(text)','hon.hq_school_visit_ts(timestamp with time zone)'] LOOP
    IF has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND (a.grantee=0 OR a.grantee<>p.proowner)) THEN
      RAISE EXCEPTION 'Unsafe HQ school visit helper: %',f; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hq_school_visit_requests','hq_school_visits','hq_school_visit_audit','hq_school_visit_outbox'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('hon.'||t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
      OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename=t)
      OR EXISTS(SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=('hon.'||t)::regclass AND a.grantee<>c.relowner) THEN
      RAISE EXCEPTION 'Unsafe HQ school visit table: %',t; END IF;
    IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=('hon.'||t)::regclass AND tgfoid='hon.guard_hq_school_visit_evidence()'::regprocedure AND tgenabled='O' AND NOT tgisinternal)<>2 THEN
      RAISE EXCEPTION 'HQ school visit evidence guard missing: %',t; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND prosrc LIKE '%hon.hq_visit_active(%')<>63 THEN
    RAISE EXCEPTION 'HQ school visit check drift'; END IF;
END $$;
-- End HQ school visits exact verification.
-- HON OS plan features exact verification (0697)
DO $$ DECLARE f text:='hon.saas_offer_input_capabilities(jsonb)';
BEGIN
  IF to_regprocedure(f) IS NULL OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND (has_function_privilege('hon_runtime',p.oid,'EXECUTE')
      OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))) THEN
    RAISE EXCEPTION 'Unsafe HON OS plan feature helper: %',f; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='hon.saas_offer_set_offers'::regclass AND attname='capabilities' AND attnotnull AND NOT attisdropped)
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.saas_offer_set_offers'::regclass AND conname='saas_offer_set_offers_capabilities_check')
    OR has_column_privilege('hon_runtime','hon.saas_offer_set_offers','capabilities','SELECT') THEN
    RAISE EXCEPTION 'HON OS plan feature column drift'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='hon.saas_offer_set_write_content(uuid,jsonb)'::regprocedure AND position('saas_offer_input_capabilities' IN p.prosrc)>0)
    OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='hon.saas_offer_json(hon.saas_offer_set_offers)'::regprocedure AND position('''capabilities''' IN p.prosrc)>0) THEN
    RAISE EXCEPTION 'HON OS plan features not written or reported'; END IF;
END $$;
-- End HON OS plan features exact verification.
-- HQ inbound owner replies exact verification (0698): the runtime may only read replies; the communication worker records
-- inbound texts; the reply table is forced-RLS, policy-free, grant-free and append-only; the outcome check adds REPLY_RECORDED.
DO $$ DECLARE f text; t text; c text; d boolean; s text; r boolean; w boolean;
BEGIN
  FOR f,t,c,d,s,r,w IN SELECT * FROM (VALUES
    ('hon.hq_inbound_reply_json(hon.hq_inbound_replies)','565b4f4f6e9024a8d45c7a208ba58381','s',false,'search_path=pg_catalog, hon',false,false),
    ('hon.read_hq_replies(text,uuid,integer)','b77b2a335ee2cefd684dc663db514770','v',true,'search_path=pg_catalog, hon',true,false),
    ('hon.record_hq_inbound_text(text,text,text,text,text,timestamp with time zone)','db5eb39d156952eec65f27b94eabee44','v',true,'search_path=pg_catalog, hon',false,true)) x(f,t,c,d,s,r,w) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND md5(p.prosrc)=t AND p.provolatile=c AND p.prosecdef=d
        AND p.proconfig IS NOT DISTINCT FROM ARRAY[s])
      OR has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')<>r
      OR (EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') AND has_function_privilege('hon_communication_worker',f::regprocedure,'EXECUTE')<>w)
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND a.grantee=0) THEN
      RAISE EXCEPTION 'HQ inbound reply function body/posture drift: %',f; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname IN ('hq_inbound_reply_json','read_hq_replies','record_hq_inbound_text'))<>3 THEN
    RAISE EXCEPTION 'Unexpected HQ inbound reply overload'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.hq_inbound_replies'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename='hq_inbound_replies')
    OR EXISTS(SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='hon.hq_inbound_replies'::regclass AND a.grantee<>c.relowner)
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.hq_inbound_replies'::regclass AND tgfoid='hon.guard_hq_communication_evidence()'::regprocedure
      AND tgenabled='O' AND NOT tgisinternal AND tgname IN ('immutable','no_truncate'))<>2
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.hq_inbound_replies'::regclass AND conname='hq_inbound_replies_provider_provider_event_id_key' AND contype='u') THEN
    RAISE EXCEPTION 'Unsafe HQ inbound reply table'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.hq_inbound_texts'::regclass AND conname='hq_inbound_texts_outcome_check' AND contype='c' AND convalidated
      AND md5(pg_get_constraintdef(oid))='f54d6b3afd09d775e88a5113914a0647') THEN
    RAISE EXCEPTION 'HQ inbound text outcome check drift'; END IF;
END $$;
-- End HQ inbound owner replies exact verification.

-- HQ number orders exact verification (0704): the runtime may run the HQ owner's read and three commands only; the worker
-- none; the order table is forced-RLS, policy-free, grant-free, never deleted; only a BUYING row changes (lease or finish).
DO $$ DECLARE f text; t text; c text; d boolean; r boolean;
BEGIN
  FOR f,t,c,d,r IN SELECT * FROM (VALUES
    ('hon.guard_hq_number_order()','3c6c0369b3d52a0309aa0ca8723e80b2','v',false,false),
    ('hon.hq_number_order_json(hon.hq_number_orders)','941e8b735f43b808929bab46c4ba5d2b','s',false,false),
    ('hon.start_hq_number_order(text,jsonb,uuid)','ee66b575244bdc0b73b12990d431fc1e','v',true,true),
    ('hon.claim_hq_number_order(text,uuid)','027693cbbe6196a177d5476e3400ef91','v',true,true),
    ('hon.finish_hq_number_order(text,uuid,jsonb)','f9b2bc0db5541aad6652e2fea176e068','v',true,true),
    ('hon.read_hq_number_orders(text)','3743bde21a96b88792f037f5e43034ed','v',true,true)) x(f,t,c,d,r) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f::regprocedure AND md5(p.prosrc)=t AND p.provolatile=c AND p.prosecdef=d
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, hon'])
      OR has_function_privilege('hon_runtime',f::regprocedure,'EXECUTE')<>r
      OR (EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') AND has_function_privilege('hon_communication_worker',f::regprocedure,'EXECUTE'))
      OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND a.grantee=0) THEN
      RAISE EXCEPTION 'HQ number order function drift: %',f; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='hon'::regnamespace
      AND proname IN ('guard_hq_number_order','hq_number_order_json','start_hq_number_order','claim_hq_number_order','finish_hq_number_order','read_hq_number_orders'))<>6 THEN
    RAISE EXCEPTION 'Unexpected HQ number order overload'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='hon.hq_number_orders'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hon' AND tablename='hq_number_orders')
    OR EXISTS(SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='hon.hq_number_orders'::regclass AND a.grantee<>c.relowner)
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.hq_number_orders'::regclass AND tgfoid='hon.guard_hq_number_order()'::regprocedure
      AND tgenabled='O' AND NOT tgisinternal AND tgname IN ('guarded','no_truncate'))<>2
    OR NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='hon' AND indexname='hq_number_orders_one_buying') THEN
    RAISE EXCEPTION 'Unsafe HQ number order table'; END IF;
END $$;
-- End HQ number orders exact verification.
-- School plan features exact verification (0699)
DO $$ BEGIN
  IF to_regprocedure('hon.read_school_plan_features(text,uuid)') IS NULL OR to_regprocedure('hon.school_plan_features(uuid,uuid)') IS NULL
    OR NOT has_function_privilege('hon_runtime','hon.read_school_plan_features(text,uuid)','EXECUTE')
    OR has_function_privilege('hon_runtime','hon.school_plan_features(uuid,uuid)','EXECUTE')
    OR EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid IN ('hon.read_school_plan_features(text,uuid)'::regprocedure,'hon.school_plan_features(uuid,uuid)'::regprocedure)
        AND a.grantee<>p.proowner AND a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Unsafe school plan features ACL'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='hon.read_school_plan_features(text,uuid)'::regprocedure AND p.prosecdef
      AND position('staff_member_eligible' IN p.prosrc)>0 AND position('family_access_grants' IN p.prosrc)>0)
    OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='hon.school_plan_features(uuid,uuid)'::regprocedure AND NOT p.prosecdef
      AND position('hq_school_plan_current' IN p.prosrc)>0 AND position('cur.school_id = p_school' IN p.prosrc)>0) THEN
    RAISE EXCEPTION 'School plan features read drift'; END IF;
END $$;
-- End school plan features exact verification.

-- Design AI draft exact verification (0705): the DESIGN_DRAFT kind row on the shared AI text proposals (0550), the closed
-- brief, word and draft shapes, the private actor, facts and view helpers, and the seven runtime entry points.
DO $$ DECLARE f record; safe boolean; BEGIN
  FOR f IN SELECT * FROM (VALUES
('hon.begin_design_draft(text,jsonb,uuid)',true,true,'search_path=pg_catalog, hon','c4ae16b981a132960344fba072dd6e38987ef69d3a5643c8aaaac7c6277f4402'),
('hon.close_design_draft(text,uuid,text)',true,true,'search_path=pg_catalog, hon','aa68d2d0be492b81683b47538d3b5a69da385d258de61ca98e5fc3a7809570e8'),
('hon.design_draft_ai_actor(text)',true,false,'search_path=pg_catalog, hon','d609e9b3381bdd7e0e4799564d3ec2b6b31865528268219effa00ce2a3ba5b7b'),
('hon.design_draft_brief_ok(jsonb)',false,false,'search_path=pg_catalog, hon','37776a7f6c1b2ffd4c6a123acd8dbf27db2e05c05c08eb74cd7e08b0802cad7c'),
('hon.design_draft_facts(jsonb)',true,false,'search_path=pg_catalog, hon','7fb871cd60f901872e7e23faad6b2b954472a7a261dfa6a5bad257a1241b4ac6'),
('hon.design_draft_ok(jsonb)',false,false,'search_path=pg_catalog, hon','a3ac8db0cc260bf596bce31df7d3f209481a8488d24b5e6d2da4189d9039b0a0'),
('hon.design_draft_view(uuid,uuid)',true,false,'search_path=pg_catalog, hon','d0cc3c3e8129d3267b323fb094345b7b7957dfc5ae02402867c49dcd9fe69c79'),
('hon.design_draft_word_ok(jsonb,integer,integer,boolean)',false,false,'search_path=pg_catalog, hon','f60c69967e1ce11214acac305319117187662ca3f7c4b542cc7c1c1948c060b3'),
('hon.fail_design_draft(text,uuid,text,text)',true,true,'search_path=pg_catalog, hon','7fe6b1ceb01a7252429bd97be3525fc75f15377bd2e02ff38723cfcedac6bdda'),
('hon.plan_design_draft(text,uuid)',true,true,'search_path=pg_catalog, hon','8e2ab95e5dd0f3538c4df532d554361ce5f3c1223c332422c39a10acc1acdb8c'),
('hon.prepare_design_draft(text,uuid,uuid,boolean)',true,true,'search_path=pg_catalog, hon','7d1653ab20956c647848b6df880b45769eed47561c90a920170114a56f853861'),
('hon.read_design_drafts(text,uuid)',true,true,'search_path=pg_catalog, hon','16a204cfbea9945b56586dba9969c4c40d7beeb25f8a3cb01d90519795069530'),
('hon.record_design_draft(text,uuid,jsonb)',true,true,'search_path=pg_catalog, hon','558537449e7176bd1b4e486eb5917e0d2c1de21f9b39a0b186ff2fd2c13b0b82'))
 e(signature,definer,runtime_allowed,config,body_hash) LOOP
    SELECT p.prosecdef=f.definer AND p.proconfig=ARRAY[f.config]
      AND (NOT f.definer OR owner.rolsuper OR owner.rolbypassrls) AND has_function_privilege('hon_runtime',p.oid,'EXECUTE')=f.runtime_allowed
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
      AND (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='hon_runtime') OR NOT f.runtime_allowed OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
    INTO safe FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=f.signature::regprocedure;
    IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe design AI draft function: %',f.signature; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_kinds k WHERE k.kind='DESIGN_DRAFT' AND k.agent_key='marcus' AND k.task_class='DRAFT_MARKETING'
      AND k.input_budget=6000 AND k.output_budget=3000 AND k.max_cost_microunits=40000 AND k.max_result_bytes=8192
      AND k.caller='HUMAN_UI' AND k.subject_type='SCHOOL' AND k.usage_agent='DESIGN_DRAFT') THEN
    RAISE EXCEPTION 'Design AI draft kind row missing or changed';
  END IF;
END $$;
-- End design AI draft exact verification.
