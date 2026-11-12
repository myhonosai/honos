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
   WHEN 'guard_curriculum_resource' THEN '04c5ee9a43548efd7ae2a03b5f68d0c1'
   WHEN 'lock_curriculum_resource_actor' THEN '72cca48e824d14f17bbf843211f1f61c'
   WHEN 'curriculum_resource_projection' THEN 'b4fd2c24a8e0e84138b4e0862b31d15b'
   WHEN 'read_staff_curriculum_library' THEN 'ff6afaae7d2cd119087fa27433a9ebcd'
   WHEN 'mutate_curriculum_resource' THEN '00e261bfb2a5c1fabadfd6e020bcb691'
   WHEN 'read_parent_curriculum_library' THEN '0dcd740136a3ee78f3720fa973ba1b9c'
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
    AND md5(p.prosrc) = '51fc4ca0ed315550cb104c3ce2a0b855'
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
 ('resolve_planned_absence_review_scope','1a550ec1dffbbb97c907121bd4738f81',true),
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
 ('hon.guard_crm_lead_close_history()','2a83879e999f9d1858ec5f1438e9763a',false,false),
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
    ('hon.guard_crm_lead_registration_history()','8673d8b711519a75d2d727276ebdd5a7',false,false,'trigger',false),
    ('hon.crm_lead_registration_has_permission(uuid,uuid,uuid,text)','e3b71364e299c4be376b83b3e4daa41a',false,true,'boolean',false),
    ('hon.resolve_crm_lead_registration_scope(text,uuid)','97012048ddae1177aadeba233454afcf',true,true,'record',true),
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
  FOR f IN SELECT * FROM (VALUES ('hon.guard_crm_adult_membership_draft_source()',false,false,'a525769ae5e582d7958994cb52b7b522929c43663ace7290e9ce9654d5e2c64d'),
('hon.require_crm_adult_membership_actor(text)',true,false,'f5d9345e3a9fb7abf4c2686d8566cd4f21f60afdc8bd089164dcf9dabd6e30b0'),
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
('hon.guard_membership_plan_version()',false,false,'2977003ee266b7d2967f4f5155ffa646c1b6925a9aec55f554eb80e706062c98'),
('hon.guard_membership_plan_selection()',false,false,'31cc7aaabb6ec7e731a343f261d55dcb540877e3a6ee6553fe4b97c68d7343e4'),
('hon.require_membership_plan_manager(text)',true,false,'55b5a9821f0a106e18d89b443ec3b7d4e480e968c6918f2c9738227d2c5ff63c'),
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
('hon.guard_crm_guardian_child_enrollment_history()',false,false,'4d5bb4bfc08f5167e20e5b458766502bbe6039d00e610aefbaa8ea77f0085d71'),
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
('hon.guard_membership_activation_evidence()',false,false,'search_path=pg_catalog, hon','c60a35d8df72884601abcd51d9f032a18f10f626662601d9d609e6aab56b06af'),
('hon.guard_membership_state_transition()',false,false,'search_path=pg_catalog, hon','1e860ef88864ffe8e61ebe064cba7cf4458df30ef6189cef96e859239dbbd28e'),
('hon.membership_local_date(timestamptz,text)',false,false,'search_path=pg_catalog','60fb21bff4757c407e3acddc061c304629f0f035145d633924461e75090ad465'),
('hon.membership_local_day_start(date,text)',false,false,'search_path=pg_catalog, hon','7d311eb5b3ec550b13b360c747cc628fc8d13369e2984c01a12cbd2c3794e4ec'),
('hon.membership_effective_status_at(hon.membership_state,timestamptz,timestamptz,timestamptz)',false,false,'search_path=pg_catalog, hon','1430f67da4c27d157e9d520ac4b50e04c750391b22680ca21553fb7dfc33d613'),
('hon.membership_activation_text_ok(text,integer)',false,false,'search_path=pg_catalog','da4065773ea5ed7bf34267f0ff311863463c5d168d8ec8c0ad97a506677dbfe3'),
('hon.membership_activation_date(jsonb)',false,false,'search_path=pg_catalog','70dfaa487da94917b5204642ac4dd5685870f65062c9026e979e5919289b4963'),
('hon.membership_lifecycle_permission(uuid,uuid,uuid,text)',true,false,'search_path=pg_catalog, hon','1aaff531834840168bff93e5786e9956669fdb636b74c7d0c4f43dc245586f7f'),
('hon.require_membership_lifecycle_actor(text,text)',true,false,'search_path=pg_catalog, hon','dfe50a97f63ecbd589b550e6d532febcdd19e14c599e26c318ce439a245c1d6f'),
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
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.memberships'::regclass AND NOT tgisinternal)<>1 THEN
    RAISE EXCEPTION 'hon.memberships must carry exactly the 0177 transition guard (body replaced by 0178)'; END IF;
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
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='b43923e631e0754e70c4c039c2cddceb7b8a00a7a1f4ac41bb2da03d7b136419'
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
('hon.guard_membership_pause()',false,false,'search_path=pg_catalog, hon','a7f0a4bba001e88edcafcd45c4d9bddb8c819f1fdb129c6051838e1feb4d5b83'),
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
('hon.guard_student_import()',true,false,'search_path=pg_catalog, hon','45ba00a2951101e7c0510a8ff136da84e498aa1a9437524d37fd775f5ccb92df'),
('hon.require_student_import_actor(text)',true,false,'search_path=pg_catalog, hon','0d7763a58e4e5edcf15f4fd90fedac036afd941a2ef7ffc939fc7f28202259c6'),
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
('hon.guard_class_series()',true,false,'search_path=pg_catalog, hon','25279023919d330ac968de1abea2faed15b8d1241c3fe6bc8ca0497f37f1d9e2'),
('hon.require_class_series_actor(text)',true,false,'search_path=pg_catalog, hon','a91ef014ce4bb04d732d405ba53b5a0ec1be10267fe2efac6b5f504cdafec2bf'),
('hon.class_series_json(hon.class_series)',true,false,'search_path=pg_catalog, hon','ac63ec1bc183d40534a4623df595d4bb46b110f717861b58f08a281b372c82a8'),
('hon.class_series_pattern(jsonb,boolean)',false,false,'search_path=pg_catalog, hon','30abf7a726b2fb7c8c970b56b50a25be4239743474107f8954977279d0193bf5'),
('hon.class_series_command_begin(text,text,text)',true,false,'search_path=pg_catalog, hon','7119e94378413589f6e0fc87777f10405147e5556cd4b047b0d38ce6e0b45944'),
('hon.class_series_command_finish(text,text,uuid,jsonb,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',true,false,'search_path=pg_catalog, hon','3fba076d7585bdac91002f2dc9ecf156debb50a5680d5899571361a1e99f902d'),
('hon.class_series_apply_future(hon.class_series,text)',true,false,'search_path=pg_catalog, hon','f5b76af7d5a086421461f3419d828fc1c2554221a32e613c1162bd771459f62f'),
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
('hon.guard_invoice_payment_record()',true,false,'search_path=pg_catalog, hon','5173648ce92ee38701768bcbeeb74a113d0c46be552697bc43eeac3df2c0ed13'),
('hon.guard_invoice_payment_status()',true,false,'search_path=pg_catalog, hon','d42c2d8a463004dfb1a7f118dc9c2e1b8fd081179147c7b62cde75a9142a3a43'),
('hon.require_tuition_actor(text,text)',true,false,'search_path=pg_catalog, hon','250ed5e3b2245dc5f734465c3b8143b12cb527e2952196d1c953ecdc243b60e1'),
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
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='hon.invoices'::regclass AND NOT tgisinternal)<>1 THEN
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
('hon.require_school_pay_actor(text,text)',true,false,'search_path=pg_catalog, hon','794c66b32329aaf58e0e080b7c570dcc5da5417c5726f27736ac16f455ec0cbc'),
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
('hon.require_school_checkout_actor(text)',true,false,'search_path=pg_catalog, hon','0cf880596410ab036049602a0e90267c5690976b5d10036c1a00a240c97b1988'),
('hon.school_checkout_page_json(hon.school_checkout_pages)',false,false,'search_path=pg_catalog, hon','39f46e65b834fb8f1137ccfae9ae58d9069a7639e3538af084c420b3c88d68e1'),
('hon.read_school_checkout_pages(text)',true,true,'search_path=pg_catalog, hon','02f443483ac4bd2750ebf6278e3283f86baf8e58e6715cd9c59134e617731f6d'),
('hon.save_school_checkout_page(text,jsonb,text,uuid,uuid)',true,true,'search_path=pg_catalog, hon','2ee3c365baacab116aad18fe0c37eb591db7258d7209c627c1ced7d45d1dcf53')) e(signature,definer,runtime_allowed,config,body_hash) LOOP
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
('hon.require_maya_actor(text,text)',true,false,'search_path=pg_catalog, hon','3ec3ab3ace09cba647c0ef6a7849baca7960f89d64e457893de9cf17fe916151'),
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
('hon.require_school_branding_actor(text)',true,false,'search_path=pg_catalog, hon','c40bd4f620b7673b7fe6853ca22fb8712ae5c4a0c27e2fc3ac369c20af3fb4a0'),
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
