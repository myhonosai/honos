-- HON / Supabase development runtime role
-- Execute this entire script in the Supabase SQL Editor as the project
-- administrator, after replacing the password placeholder with a freshly
-- generated base64url secret. Do not save the secret in Git or a shared note.
--
-- Generate the password locally, outside the SQL Editor:
-- node -e "console.log(require('node:crypto').randomBytes(36).toString('base64url'))"
--
-- The generated base64url value has no quote characters, so it can be pasted
-- directly into the PASSWORD literal below.

-- Safe recovery when a previous failed SQL Editor run left its transaction
-- aborted. Outside a transaction PostgreSQL emits only a harmless warning.
ROLLBACK;
BEGIN;

-- Re-runnable ACL reconciliation. Existing roles must already be restricted;
-- never rotate credentials or elevate an existing login as part of a rerun.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (NOT rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication)) THEN RAISE EXCEPTION 'Existing hon_runtime is unsafe'; END IF;
 ELSE
  CREATE ROLE hon_runtime LOGIN PASSWORD '<PASTE_FRESH_BASE64URL_PASSWORD_HERE>' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 20;
 END IF;
END $$;

-- A newly created login has no explicit role memberships. Verify that invariant
-- rather than attempting to revoke Supabase-owned administrative roles, which
-- a SQL Editor role is not permitted to administer.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members AS membership
    JOIN pg_roles AS member_role ON member_role.oid = membership.member
    WHERE member_role.rolname = 'hon_runtime'
  ) THEN
    RAISE EXCEPTION 'Fresh hon_runtime role unexpectedly has an explicit membership.';
  END IF;
END;
$$;

-- Minimal database and schema visibility. The application never needs CREATE,
-- TEMP, extension, role, or database-management privileges.
REVOKE ALL PRIVILEGES ON DATABASE postgres FROM hon_runtime;
GRANT CONNECT ON DATABASE postgres TO hon_runtime;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM hon_runtime;
REVOKE ALL PRIVILEGES ON SCHEMA hon FROM PUBLIC;
GRANT USAGE ON SCHEMA hon TO hon_runtime;
ALTER ROLE hon_runtime SET search_path = hon, pg_catalog;

-- Minimal data-plane privileges for already-migrated HON operational tables.
-- RLS still applies after these grants and is forced by HON migration 0004.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA hon FROM hon_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hon FROM hon_runtime;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA hon FROM hon_runtime;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA hon FROM PUBLIC;
REVOKE USAGE ON TYPE
  hon.principal_type,
  hon.membership_status,
  hon.audit_result,
  hon.outbox_status,
  hon.lead_status,
  hon.membership_state,
  hon.invoice_status,
  hon.payment_state,
  hon.action_request_status,
  hon.approval_decision,
  hon.authority_mode,
  hon.outbox_delivery_outcome,
  hon.family_member_role,
  hon.family_access_level,
  hon.ai_modality,
  hon.plan_tier,
  hon.knowledge_article_audience,
  hon.knowledge_article_lifecycle,
  hon.planned_absence_request_status,
  hon.crm_appointment_type,
  hon.crm_appointment_status
FROM hon_runtime, PUBLIC;
-- The runtime role does not administer tenant topology, commercial tier,
-- Action policy, identity, IAM, or parent-access grants. Existing/future
-- mutations in those areas use fixed SECURITY DEFINER procedures or a later
-- reviewed domain command boundary.
GRANT SELECT ON TABLE
 hon.organization_entitlements,
 hon.people,
 hon.families,
 hon.family_members,
 hon.student_profiles,
 hon.crm_pipelines,
 hon.crm_pipeline_stages,
 hon.crm_leads,
 hon.crm_appointments,
 hon.billing_accounts,
 hon.memberships,
  hon.membership_payment_schedules,
  -- Operations reporting needs aggregate-only invoice/payment-attempt counts;
  -- do not grant any billing mutation privilege to the runtime role.
  hon.invoices,
  hon.payment_attempts,
  hon.action_policies,
  hon.action_requests,
  -- AI economics is a read-only aggregate projection; never grant ledger writes.
  hon.ai_usage_ledger,
  -- Plans are immutable snapshots; only the fixed planning definer appends.
  hon.ai_invocation_plans,
  hon.idempotency_records,
  hon.principal_interface_preferences,
  hon.curricula,
  hon.curriculum_ranks,
  hon.curriculum_requirements,
  hon.student_curriculum_enrollments,
  hon.testing_events,
  hon.testing_candidates,
  hon.promotion_decisions,
  hon.programs,
  hon.class_templates,
  hon.class_sessions,
  hon.class_session_instructors,
  hon.attendance_records,
  hon.knowledge_articles,
  hon.planned_absence_requests
TO hon_runtime;
GRANT INSERT ON TABLE
 hon.people,
 hon.families,
 hon.family_members,
 hon.student_profiles,
 hon.crm_pipelines,
 hon.crm_pipeline_stages,
 hon.crm_leads,
 hon.crm_appointments,
  -- Human invoice drafting plus the narrow DRAFT-to-ISSUED transition; payment
  -- execution and every other billing mutation remain unavailable.
  hon.invoices,
 hon.billing_accounts,
 hon.memberships,
  hon.membership_payment_schedules,
  hon.action_requests,
  hon.action_approvals,
  hon.audit_events,
  hon.outbox_events,
  hon.idempotency_records,
  hon.principal_interface_preferences,
  hon.curricula,
  hon.curriculum_ranks,
  hon.curriculum_requirements,
  hon.student_curriculum_enrollments,
  hon.testing_events,
  hon.testing_candidates,
  hon.promotion_decisions,
  hon.programs,
  hon.class_templates,
  hon.class_sessions,
  hon.class_session_instructors,
  hon.attendance_records,
  hon.knowledge_articles,
  hon.planned_absence_requests
TO hon_runtime;
-- Staff booking creation needs RLS-bound duplicate/capacity reads and inserts,
-- but no direct UPDATE/DELETE privilege on bookings. Keep this explicit so the
-- runtime setup remains fail-closed when scheduling features evolve.
GRANT SELECT, INSERT ON TABLE hon.class_bookings TO hon_runtime;
GRANT UPDATE ON TABLE
 hon.action_requests,
 hon.idempotency_records,
 hon.principal_interface_preferences,
  -- Human invoice issuance is the only reviewed invoice state transition.
  hon.invoices,
  -- Human membership activation and direct cancellation are the only reviewed
  -- membership state transitions; payment schedule and provider effects remain
  -- outside this privilege.
  hon.memberships,
 -- The conventional trial outcome command is a version-checked lifecycle update.
 hon.crm_appointments,
 -- Approval is the sole mutable knowledge transition; no DELETE privilege is granted.
  hon.knowledge_articles,
  -- Human staff review is the sole mutable planned-absence transition; no DELETE privilege is granted.
  hon.planned_absence_requests,
  -- Durable human work-item transitions require no identity-directory access.
  hon.work_items
TO hon_runtime;
GRANT USAGE ON TYPE
  hon.principal_type,
  hon.membership_status,
  hon.audit_result,
  hon.outbox_status,
  hon.lead_status,
  hon.membership_state,
  hon.invoice_status,
  hon.payment_state,
  hon.action_request_status,
  hon.approval_decision,
  hon.authority_mode,
  hon.outbox_delivery_outcome,
  hon.family_member_role,
  hon.family_access_level,
  hon.ai_modality,
  hon.plan_tier,
  hon.curriculum_lifecycle,
  hon.testing_event_status,
  hon.testing_candidate_result,
  hon.promotion_decision_status,
  hon.schedule_item_status,
  -- Cast by the class-booking capacity decision and booking insert.
  hon.class_booking_status,
  hon.attendance_status,
  hon.knowledge_article_audience,
  hon.knowledge_article_lifecycle,
  hon.planned_absence_request_status,
  hon.crm_appointment_type,
  hon.crm_appointment_status
TO hon_runtime;

-- Reproduce the exact existing 0046/0047/0051 migration minima when this role is
-- first created AFTER all migrations. These grant no delivery/provider access.
GRANT SELECT, INSERT, UPDATE ON TABLE hon.communication_consents,
  hon.communication_messages,hon.ai_team_presentation_preferences TO hon_runtime;
GRANT USAGE ON TYPE hon.communication_consent_channel,
  hon.communication_consent_status,hon.communication_consent_source,
  hon.communication_message_channel,hon.communication_message_lifecycle TO hon_runtime;

-- Keep function execution explicit rather than granting every current/future
-- function. Current application transaction helpers need only these functions.
REVOKE ALL ON FUNCTION hon.current_organization_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.current_school_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.require_tenant_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.resolve_authorized_scope(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.resolve_hq_operator_scope(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.resolve_parent_family_scope(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.principal_has_school_permission(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.provision_school_from_hq(text, text, text, text, text, text, hon.plan_tier, text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.current_organization_id() TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.current_school_id() TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.require_tenant_context() TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.resolve_authorized_scope(text, uuid, text) TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.resolve_hq_operator_scope(text, text) TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.resolve_parent_family_scope(text, uuid) TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.principal_has_school_permission(uuid, uuid, uuid, text) TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.provision_school_from_hq(text, text, text, text, text, text, hon.plan_tier, text, text, uuid, uuid) TO hon_runtime;

-- Read-only Core/Complete multi-location projection. No IAM/directory/HQ or
-- CRM activity table grant is needed; all schools/tier are resolved internally.
REVOKE ALL ON FUNCTION hon.read_organization_operations_summary(text, uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.read_organization_operations_summary(text, uuid, timestamptz, timestamptz) TO hon_runtime;

-- Human-only staff IAM: no direct users/principals/roles/permission/grant access.
REVOKE ALL ON TABLE hon.users,hon.principals,hon.roles,hon.permissions,
  hon.role_permissions,hon.principal_role_grants FROM hon_runtime;
REVOKE ALL ON FUNCTION hon.resolve_staff_role_target(uuid,text,uuid) FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_staff_custom_role_recipients() FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.mutate_staff_role(text,text,uuid,jsonb,text,uuid,uuid),
  hon.read_staff_role(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.mutate_staff_role(text,text,uuid,jsonb,text,uuid,uuid),
  hon.read_staff_role(text,text,uuid) TO hon_runtime;

-- Human internal document boundary: no direct table or helper execution.
REVOKE ALL ON TABLE hon.document_templates,hon.document_versions,
  hon.document_publications,hon.document_acknowledgements,hon.document_command_requests FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_document_immutability(),
  hon.document_family_authorized(text,uuid,boolean),
  hon.require_document_actor(text,text,text,uuid,boolean) FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.mutate_document(text,text,text,uuid,jsonb,text,uuid,uuid),
  hon.read_documents(text,text,text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.mutate_document(text,text,text,uuid,jsonb,text,uuid,uuid),
  hon.read_documents(text,text,text,uuid,integer) TO hon_runtime;

-- Deterministic single-school staff display search; no new direct table grants.
REVOKE ALL ON FUNCTION hon.search_school(text,uuid,uuid,text,text[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.search_school(text,uuid,uuid,text,text[],uuid) TO hon_runtime;

-- Private human lead imports: no table access, no validator/applier execution.
REVOKE ALL ON TABLE hon.lead_import_batches,hon.lead_import_rows,
  hon.lead_import_evidence,hon.lead_import_requests FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_lead_import_evidence(),hon.require_lead_import_actor(text,text),
  hon.lead_import_summary(uuid),hon.validate_lead_import_row(jsonb,jsonb,jsonb),
  hon.apply_imported_lead(uuid,integer,uuid,uuid,uuid) FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.resolve_lead_import_scope(text,text),
  hon.mutate_lead_import(text,text,uuid,jsonb,text,uuid,uuid),hon.read_lead_import(text,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.resolve_lead_import_scope(text,text),
  hon.mutate_lead_import(text,text,uuid,jsonb,text,uuid,uuid),hon.read_lead_import(text,text,uuid,uuid) TO hon_runtime;

DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.lead_import_batches,hon.lead_import_rows,hon.lead_import_evidence,hon.lead_import_requests FROM %I',role_name);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.resolve_lead_import_scope(text,text),hon.mutate_lead_import(text,text,uuid,jsonb,text,uuid,uuid),hon.read_lead_import(text,text,uuid,uuid),hon.guard_lead_import_evidence(),hon.require_lead_import_actor(text,text),hon.lead_import_summary(uuid),hon.validate_lead_import_row(jsonb,jsonb,jsonb),hon.apply_imported_lead(uuid,integer,uuid,uuid,uuid) FROM %I',role_name);
 END LOOP;
END $$;

-- Decision-only tenant planning and authenticated HQ control-plane boundaries.
-- Never grant direct access to HQ provider/config/credential-reference tables.
REVOKE ALL ON FUNCTION hon.plan_ai_invocation(uuid, jsonb, uuid, uuid, uuid),
  hon.require_ai_invocation_plan_access(), hon.hq_ai_control_plane_read(text),
  hon.hq_ai_control_plane_write(text, text, jsonb, uuid, uuid),
  hon.hq_ai_routing_registry(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.plan_ai_invocation(uuid, jsonb, uuid, uuid, uuid),
  hon.require_ai_invocation_plan_access(), hon.hq_ai_control_plane_read(text),
  hon.hq_ai_control_plane_write(text, text, jsonb, uuid, uuid),
  hon.hq_ai_routing_registry(text, uuid) TO hon_runtime;
-- Internal validators/projections and immutability trigger remain non-executable.
REVOKE ALL ON FUNCTION hon.validate_ai_invocation_plan_input(jsonb),
  hon.ai_invocation_plan_summary(uuid), hon.reject_ai_invocation_plan_mutation()
  FROM hon_runtime, PUBLIC;

-- Human curriculum progress (0070/0071): private state/evidence, fixed commands
-- and safe projections. Preserve only the evidenced testing column minima.
REVOKE ALL ON TABLE hon.curriculum_requirements,hon.curriculum_requirement_versions,
  hon.curriculum_enrollment_history,hon.curriculum_progress_observations,hon.curriculum_command_requests FROM hon_runtime, PUBLIC;
REVOKE INSERT,UPDATE,DELETE ON hon.student_curriculum_enrollments FROM hon_runtime, PUBLIC;
-- Required by promotion's locked dependency read and exact evidenced rank update.
-- No identity, status, enrollment-date, or other enrollment column is writable.
GRANT UPDATE(current_rank_id,version,updated_at) ON hon.student_curriculum_enrollments TO hon_runtime;
REVOKE ALL ON FUNCTION hon.lock_human_testing_authority(text),hon.lock_human_testing_record(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.lock_human_testing_authority(text),hon.lock_human_testing_record(text,text,uuid) TO hon_runtime;
-- Existing instructor grading requires only its assessment and version columns.
REVOKE UPDATE ON hon.testing_candidates FROM hon_runtime;
GRANT UPDATE(result,instructor_notes,version,updated_at) ON hon.testing_candidates TO hon_runtime;
REVOKE ALL ON FUNCTION hon.guard_curriculum_history(),hon.guard_curriculum_requirement(),
  hon.snapshot_curriculum_requirement(),hon.guard_curriculum_enrollment_identity(),
  hon.require_curriculum_actor(text,text),hon.validate_curriculum_observation(),
  hon.guard_curriculum_structure_identity(),hon.verify_curriculum_enrollment_evidence() FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.mutate_curriculum_progress(text,text,uuid,uuid,jsonb,text,uuid,uuid),
  hon.read_staff_curriculum_progress(text,text,uuid,uuid),hon.read_parent_curriculum_progress(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.mutate_curriculum_progress(text,text,uuid,uuid,jsonb,text,uuid,uuid),
  hon.read_staff_curriculum_progress(text,text,uuid,uuid),hon.read_parent_curriculum_progress(text,uuid) TO hon_runtime;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE INSERT,UPDATE,DELETE ON hon.student_curriculum_enrollments FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.lock_human_testing_authority(text),hon.lock_human_testing_record(text,text,uuid),hon.guard_curriculum_structure_identity(),hon.verify_curriculum_enrollment_evidence() FROM %I',r);
  EXECUTE format('REVOKE ALL ON TABLE hon.curriculum_requirements,hon.curriculum_requirement_versions,hon.curriculum_enrollment_history,hon.curriculum_progress_observations,hon.curriculum_command_requests FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_curriculum_history(),hon.guard_curriculum_requirement(),hon.snapshot_curriculum_requirement(),hon.guard_curriculum_enrollment_identity(),hon.require_curriculum_actor(text,text),hon.validate_curriculum_observation(),hon.mutate_curriculum_progress(text,text,uuid,uuid,jsonb,text,uuid,uuid),hon.read_staff_curriculum_progress(text,text,uuid,uuid),hon.read_parent_curriculum_progress(text,uuid) FROM %I',r);
 END LOOP;
END $$;

-- Conventional school revenue planning: only these two fixed functions execute.
REVOKE ALL ON TABLE hon.revenue_plans,hon.revenue_plan_versions,hon.revenue_plan_requests FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.validate_revenue_plan_input(jsonb),hon.guard_revenue_plan(),hon.guard_revenue_plan_history(),hon.require_revenue_planning_actor(text),hon.lock_revenue_planning_actor(text),hon.revenue_plan_snapshot(uuid) FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.save_revenue_plan(text,uuid,jsonb,text,uuid,uuid),hon.read_revenue_plan(text,text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.save_revenue_plan(text,uuid,jsonb,text,uuid,uuid),hon.read_revenue_plan(text,text,uuid,integer) TO hon_runtime;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.revenue_plans,hon.revenue_plan_versions,hon.revenue_plan_requests FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.validate_revenue_plan_input(jsonb),hon.guard_revenue_plan(),hon.guard_revenue_plan_history(),hon.require_revenue_planning_actor(text),hon.lock_revenue_planning_actor(text),hon.revenue_plan_snapshot(uuid),hon.save_revenue_plan(text,uuid,jsonb,text,uuid,uuid),hon.read_revenue_plan(text,text,uuid,integer) FROM %I',r);
 END LOOP;
END $$;
-- Human campaign planning and source capture: no new runtime table privileges.
REVOKE ALL ON TABLE hon.marketing_campaigns,hon.marketing_campaign_versions,hon.marketing_campaign_requests,hon.crm_lead_attributions FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_campaign_history(),hon.validate_campaign_window(text,text,boolean),hon.validate_campaign_input(jsonb,boolean),hon.campaign_summary(uuid),hon.guard_campaign_record(),hon.require_campaign_actor(text,text),hon.lock_campaign_actor(text,text),hon.capture_lead_attribution(),hon.guard_campaign_evidence_insert(),hon.check_campaign_current_version() FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.resolve_campaign_scope(text,text),hon.authorize_campaign_lead(text,boolean),hon.mutate_campaign(text,text,uuid,jsonb,text,uuid,uuid),hon.read_campaigns(text,text,uuid,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.resolve_campaign_scope(text,text),hon.authorize_campaign_lead(text,boolean),hon.mutate_campaign(text,text,uuid,jsonb,text,uuid,uuid),hon.read_campaigns(text,text,uuid,text,text,integer) TO hon_runtime;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.marketing_campaigns,hon.marketing_campaign_versions,hon.marketing_campaign_requests,hon.crm_lead_attributions FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_campaign_history(),hon.validate_campaign_window(text,text,boolean),hon.validate_campaign_input(jsonb,boolean),hon.campaign_summary(uuid),hon.guard_campaign_record(),hon.require_campaign_actor(text,text),hon.lock_campaign_actor(text,text),hon.capture_lead_attribution(),hon.guard_campaign_evidence_insert(),hon.check_campaign_current_version(),hon.resolve_campaign_scope(text,text),hon.authorize_campaign_lead(text,boolean),hon.mutate_campaign(text,text,uuid,jsonb,text,uuid,uuid),hon.read_campaigns(text,text,uuid,text,text,integer) FROM %I',r);
 END LOOP;
END $$;

-- Human staff planning: exact functions only, no directory or table access.
REVOKE ALL ON TABLE hon.staff_profiles,hon.staff_planning_revisions,hon.staff_planning_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_staff_planning_history(),hon.validate_staff_planning_input(text,jsonb),hon.staff_member_eligible(uuid,uuid,uuid),hon.staff_has_planning_permission(uuid,uuid,uuid,text),hon.require_staff_planning_actor(text,uuid,text),hon.lock_staff_planning_actor(text,uuid,text),hon.staff_revision_summary(uuid,text,integer),hon.guard_staff_profile_insert(),hon.guard_staff_revision_insert(),hon.resolve_staff_availability_scope(text,text),hon.save_staff_planning_revision(text,uuid,text,jsonb,text,uuid,uuid),hon.read_staff_availability(text,uuid,text,integer) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.staff_profiles,hon.staff_planning_revisions,hon.staff_planning_requests FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_staff_planning_history(),hon.validate_staff_planning_input(text,jsonb),hon.staff_member_eligible(uuid,uuid,uuid),hon.staff_has_planning_permission(uuid,uuid,uuid,text),hon.require_staff_planning_actor(text,uuid,text),hon.lock_staff_planning_actor(text,uuid,text),hon.staff_revision_summary(uuid,text,integer),hon.guard_staff_profile_insert(),hon.guard_staff_revision_insert(),hon.resolve_staff_availability_scope(text,text),hon.save_staff_planning_revision(text,uuid,text,jsonb,text,uuid,uuid),hon.read_staff_availability(text,uuid,text,integer) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.resolve_staff_availability_scope(text,text),hon.save_staff_planning_revision(text,uuid,text,jsonb,text,uuid,uuid),hon.read_staff_availability(text,uuid,text,integer) TO hon_runtime;
 END IF;
END $$;

-- Inert automation configuration: four exact entry points only.
REVOKE ALL ON TABLE hon.automation_rules,hon.automation_rule_versions,hon.automation_rule_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_automation_history(),hon.automation_closed(jsonb,text[]),hon.validate_automation_input(jsonb,boolean),hon.automation_has_permission(uuid,uuid,uuid,text),hon.require_automation_actor(text,text),hon.lock_automation_actor(text,text),hon.automation_rule_summary(uuid,integer),hon.guard_automation_insert(),hon.plan_automation_descriptor(jsonb,jsonb),hon.resolve_automation_rule_scope(text,text),hon.save_automation_rule(text,uuid,jsonb,text,uuid,uuid),hon.read_automation_rules(text,uuid,integer),hon.dry_run_automation_rule(text,uuid,jsonb) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.automation_rules,hon.automation_rule_versions,hon.automation_rule_requests FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_automation_history(),hon.automation_closed(jsonb,text[]),hon.validate_automation_input(jsonb,boolean),hon.automation_has_permission(uuid,uuid,uuid,text),hon.require_automation_actor(text,text),hon.lock_automation_actor(text,text),hon.automation_rule_summary(uuid,integer),hon.guard_automation_insert(),hon.plan_automation_descriptor(jsonb,jsonb),hon.resolve_automation_rule_scope(text,text),hon.save_automation_rule(text,uuid,jsonb,text,uuid,uuid),hon.read_automation_rules(text,uuid,integer),hon.dry_run_automation_rule(text,uuid,jsonb) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.resolve_automation_rule_scope(text,text),hon.save_automation_rule(text,uuid,jsonb,text,uuid,uuid),hon.read_automation_rules(text,uuid,integer),hon.dry_run_automation_rule(text,uuid,jsonb) TO hon_runtime; END IF;
END $$;
-- Human CRM follow-ups: no direct private table or helper access.
REVOKE ALL ON TABLE hon.crm_follow_ups,hon.crm_follow_up_versions,hon.crm_follow_up_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_follow_up_history(),hon.validate_follow_up_input(text,jsonb),hon.follow_up_has_permission(uuid,uuid,uuid,text),hon.resolve_follow_up_scope(text),hon.require_follow_up_actor(text),hon.lock_follow_up_actor(text,uuid),hon.follow_up_authorized(uuid,uuid),hon.follow_up_summary(uuid,integer),hon.guard_follow_up_insert(),hon.mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid),hon.read_follow_ups(text,uuid,text,text,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.crm_follow_ups,hon.crm_follow_up_versions,hon.crm_follow_up_requests FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_follow_up_history(),hon.validate_follow_up_input(text,jsonb),hon.follow_up_has_permission(uuid,uuid,uuid,text),hon.resolve_follow_up_scope(text),hon.require_follow_up_actor(text),hon.lock_follow_up_actor(text,uuid),hon.follow_up_authorized(uuid,uuid),hon.follow_up_summary(uuid,integer),hon.guard_follow_up_insert(),hon.mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid),hon.read_follow_ups(text,uuid,text,text,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.resolve_follow_up_scope(text),hon.mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid),hon.read_follow_ups(text,uuid,text,text,uuid) TO hon_runtime; END IF;
END $$;

-- Human renewal reviews: five exact human boundaries; no private/helper/directory access.
REVOKE ALL ON TABLE hon.membership_renewal_reviews,hon.membership_renewal_versions,hon.membership_renewal_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_renewal_history(),hon.validate_renewal_input(text,jsonb),hon.renewal_has_permission(uuid,uuid,uuid,text),hon.resolve_renewal_scope(text),hon.require_renewal_actor(text),hon.lock_renewal_actor(text),hon.renewal_membership_facts(uuid),hon.renewal_summary(uuid,integer),hon.guard_renewal_insert(),hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid),hon.read_renewals(text,uuid,text,uuid,integer),hon.read_renewal_membership(text,uuid),hon.read_renewal_history(text,uuid,integer) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.membership_renewal_reviews,hon.membership_renewal_versions,hon.membership_renewal_requests FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_renewal_history(),hon.validate_renewal_input(text,jsonb),hon.renewal_has_permission(uuid,uuid,uuid,text),hon.resolve_renewal_scope(text),hon.require_renewal_actor(text),hon.lock_renewal_actor(text),hon.renewal_membership_facts(uuid),hon.renewal_summary(uuid,integer),hon.guard_renewal_insert(),hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid),hon.read_renewals(text,uuid,text,uuid,integer),hon.read_renewal_membership(text,uuid),hon.read_renewal_history(text,uuid,integer) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.resolve_renewal_scope(text),hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid),hon.read_renewals(text,uuid,text,uuid,integer),hon.read_renewal_membership(text,uuid),hon.read_renewal_history(text,uuid,integer) TO hon_runtime; END IF;
END $$;

-- Safe future-migration defaults for the privileged migration role.
-- New objects receive no runtime or PUBLIC access until their
-- introducing migration grants the reviewed minimum explicitly.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA hon REVOKE ALL ON TABLES FROM hon_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA hon REVOKE ALL ON SEQUENCES FROM hon_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA hon REVOKE ALL ON FUNCTIONS FROM hon_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA hon REVOKE ALL ON TYPES FROM hon_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA hon REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA hon REVOKE USAGE ON TYPES FROM PUBLIC;

-- Exact public forms ingress; never grant PUBLIC or Supabase client execution.
GRANT EXECUTE ON FUNCTION hon.resolve_public_form_scope(text,text),hon.read_public_forms(text),hon.mutate_public_form(text,text,uuid,jsonb,text,uuid,uuid),hon.read_published_form(text),hon.submit_public_form(text,jsonb,text) TO hon_runtime;

-- Human owner community: deny all direct data access; precise boundaries only.
REVOKE ALL ON hon.community_verifications,hon.community_organizations,hon.community_members,hon.community_profiles,hon.community_content,hon.community_versions,hon.community_requests,hon.community_events FROM hon_runtime, PUBLIC;
GRANT EXECUTE ON FUNCTION hon.resolve_community_scope(text,uuid),hon.read_community_profile(text),hon.mutate_community(text,text,uuid,jsonb,text,uuid),hon.read_community(text,text,uuid,uuid,uuid),hon.read_community_history(text,uuid,integer) TO hon_runtime;
-- Human Action Engine evidence read only; existing request writes are unchanged.
GRANT SELECT ON hon.action_approvals TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.require_human_action_review(text,uuid),hon.human_action_reviewer(),hon.crm_lead_target_is_current(uuid,uuid) TO hon_runtime;
REVOKE ALL ON FUNCTION hon.guard_action_review_immutability() FROM hon_runtime, PUBLIC;
-- Complete voice handoff: private tables/helpers; only two fixed entrypoints.
REVOKE ALL ON hon.voice_sessions,hon.voice_session_requests FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_voice_history(),hon.require_voice_actor(text),hon.require_voice_references(uuid,uuid,uuid),hon.voice_session_snapshot(uuid) FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.read_voice_session(text,uuid),hon.mutate_voice_session(text,text,uuid,jsonb,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.read_voice_session(text,uuid),hon.mutate_voice_session(text,text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
-- Conventional human work: no direct table/column access, legacy payload or state mutation.
REVOKE ALL ON hon.work_items,hon.human_work_history,hon.human_work_requests FROM hon_runtime,PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_human_work_history(),hon.validate_human_work(text,jsonb),hon.human_work_permission(uuid,uuid,uuid,text),hon.resolve_human_work_scope(text),hon.require_human_work_actor(text),hon.lock_human_work_actor(text,uuid[]),hon.human_work_visible(uuid,hon.work_items),hon.human_work_transition_allowed(text,text),hon.human_work_snapshot(uuid,integer,uuid,integer),hon.guard_human_work_row(),hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid),hon.read_human_work(text,uuid,text,text,uuid,integer),hon.lock_ai_planning_work_reference(uuid) FROM hon_runtime,PUBLIC;
GRANT EXECUTE ON FUNCTION hon.resolve_human_work_scope(text),hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid),hon.read_human_work(text,uuid,text,text,uuid,integer),hon.lock_ai_planning_work_reference(uuid) TO hon_runtime;
DO $$ DECLARE r text; t text; a text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  FOREACH t IN ARRAY ARRAY['work_items','human_work_history','human_work_requests'] LOOP
   EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
   FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r);
    EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a,t);
   END LOOP;
  END LOOP;
  IF r<>'hon_runtime' THEN EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_human_work_history(),hon.validate_human_work(text,jsonb),hon.human_work_permission(uuid,uuid,uuid,text),hon.resolve_human_work_scope(text),hon.require_human_work_actor(text),hon.lock_human_work_actor(text,uuid[]),hon.human_work_visible(uuid,hon.work_items),hon.human_work_transition_allowed(text,text),hon.human_work_snapshot(uuid,integer,uuid,integer),hon.guard_human_work_row(),hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid),hon.read_human_work(text,uuid,text,text,uuid,integer),hon.lock_ai_planning_work_reference(uuid) FROM %I',r); END IF;
 END LOOP;
END $$;

COMMIT;

-- Future HON migrations must explicitly grant the exact table/sequence/function
-- privileges they introduce to hon_runtime. The default policy is deliberately
-- fail-closed; a new object should remain unavailable until reviewed.
-- Global identity/IAM directory tables (users, principals, roles, permissions,
-- role grants) are intentionally excluded. A separately audited scope-resolver
-- boundary will resolve a verified identity to a school-scoped command context;
-- normal runtime data-plane work never enumerates the platform identity directory.
