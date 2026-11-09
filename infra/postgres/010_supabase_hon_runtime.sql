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
  -- hon.memberships: column-restricted DRAFT INSERT only (0177), granted below.
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
  -- hon.memberships has no runtime UPDATE (0177): activation and cancellation
  -- run only inside the protected definer functions granted in the 0177 section.
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
  hon.testing_registration_interest_status,
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
REVOKE ALL ON FUNCTION hon.resolve_parent_journey_scopes(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.read_parent_billing_view(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.read_parent_testing_status(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.read_parent_planned_absence_history(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.require_parent_planned_absence_scope(text) FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.read_parent_planned_absence_request_context(text),hon.lock_parent_planned_absence_request(text,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.read_parent_message_history(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.resolve_testing_registration_review_scopes(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.read_parent_testing_registration_view(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.mutate_parent_testing_registration_interest(text,uuid,uuid,uuid,text,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.read_staff_testing_registrations(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.mutate_staff_testing_registration_decision(text,uuid,jsonb,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.principal_has_school_permission(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.provision_school_from_hq(text, text, text, text, text, text, hon.plan_tier, text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.current_organization_id() TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.current_school_id() TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.require_tenant_context() TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.resolve_authorized_scope(text, uuid, text) TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.resolve_hq_operator_scope(text, text) TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.resolve_parent_family_scope(text, uuid) TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.resolve_parent_journey_scopes(text) TO hon_runtime;
-- Fixed, current-guardian-family billing observation only. Existing billing table
-- SELECT privileges are unchanged for reviewed staff reads; this grants no
-- provider, method/token, invoice/payment mutation, or collection capability.
GRANT EXECUTE ON FUNCTION hon.read_parent_billing_view(text) TO hon_runtime;
-- Parent testing status is a single selector-free read-only projection. It adds
-- no scorecard/certificate/table grants and cannot mutate registration, payment,
-- grading, promotion, messaging, providers, AI, Action Engine, voice, or automation.
GRANT EXECUTE ON FUNCTION hon.read_parent_testing_status(text) TO hon_runtime;
-- Fixed guardian-family planned-absence history only. It grants no request,
-- review, schedule, booking, attendance, makeup, message, or table capability.
GRANT EXECUTE ON FUNCTION hon.read_parent_planned_absence_history(text) TO hon_runtime;
-- Minimal subject-only child choices and locked human canonical-request revalidation.
GRANT EXECUTE ON FUNCTION hon.read_parent_planned_absence_request_context(text),hon.lock_parent_planned_absence_request(text,uuid,uuid,text) TO hon_runtime;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.require_parent_planned_absence_scope(text),hon.read_parent_planned_absence_request_context(text),hon.lock_parent_planned_absence_request(text,uuid,uuid,text) FROM %I',r);
 END LOOP;
END $$;
-- Current direct-human review queue and authority lock only; never expose the
-- private actor helper or grant a directory/history/export capability.
REVOKE ALL ON FUNCTION hon.require_planned_absence_review_actor(text) FROM hon_runtime, PUBLIC;
REVOKE ALL ON FUNCTION hon.resolve_planned_absence_review_scope(text),hon.lock_planned_absence_review_actor(text),hon.read_staff_planned_absence_review_queue(text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.resolve_planned_absence_review_scope(text),hon.require_planned_absence_review_actor(text),hon.lock_planned_absence_review_actor(text),hon.read_staff_planned_absence_review_queue(text) FROM %I',r);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION hon.resolve_planned_absence_review_scope(text),hon.lock_planned_absence_review_actor(text),hon.read_staff_planned_absence_review_queue(text) TO hon_runtime;
-- Parent message history returns only receipt-evidence-unavailable. It grants
-- no queue, delivery, recipient, sender, provider, or message-content access.
GRANT EXECUTE ON FUNCTION hon.read_parent_message_history(text) TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.resolve_testing_registration_review_scopes(text) TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.read_parent_testing_registration_view(text,uuid) TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.mutate_parent_testing_registration_interest(text,uuid,uuid,uuid,text,text,uuid,uuid) TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.read_staff_testing_registrations(text) TO hon_runtime;
GRANT EXECUTE ON FUNCTION hon.mutate_staff_testing_registration_decision(text,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
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

-- Deterministic school Command Center: one aggregate-only projection. It adds
-- no table access and accepts no caller-provided tenant/principal GUC authority.
REVOKE ALL ON FUNCTION hon.read_school_command_center(text,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.read_school_command_center(text,uuid,uuid) FROM %I',r);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION hon.read_school_command_center(text,uuid,uuid) TO hon_runtime;

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
  hon.hq_ai_routing_registry(text, uuid), hon.hq_ai_task_profile_registry(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.plan_ai_invocation(uuid, jsonb, uuid, uuid, uuid),
  hon.require_ai_invocation_plan_access(), hon.hq_ai_control_plane_read(text),
  hon.hq_ai_control_plane_write(text, text, jsonb, uuid, uuid),
  hon.hq_ai_routing_registry(text, uuid), hon.hq_ai_task_profile_registry(text, uuid) TO hon_runtime;
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

-- Private descriptive human marketplace only. No curation/runtime table/helper access.
-- Function ACLs and column revocations are deliberately closed even with inherited default ACLs.
DO $$ DECLARE r text; t text; a text; f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%marketplace%') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['marketplace_assets','marketplace_versions','marketplace_curations','marketplace_selections','marketplace_requests','marketplace_events','marketplace_outbox'] LOOP
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a,t); END LOOP;
 END LOOP;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  FOREACH t IN ARRAY ARRAY['marketplace_assets','marketplace_versions','marketplace_curations','marketplace_selections','marketplace_requests','marketplace_events','marketplace_outbox'] LOOP
   EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
   FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r); END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%marketplace%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.resolve_marketplace_scope(text,uuid),hon.read_marketplace(text,text,uuid,uuid,integer),hon.mutate_marketplace(text,text,uuid,jsonb,text,uuid) TO hon_runtime;
 END IF;
END $$;

BEGIN;
-- Exact entrypoints only, including closed column ACLs under inherited defaults.
DO $$ DECLARE r text; t text; a text; f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%achievement%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature); END LOOP;
 FOREACH t IN ARRAY ARRAY['achievement_definitions','achievement_definition_versions','achievement_awards','achievement_award_versions','achievement_requests','achievement_events','achievement_outbox'] LOOP
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a,t); END LOOP;
 END LOOP;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  FOREACH t IN ARRAY ARRAY['achievement_definitions','achievement_definition_versions','achievement_awards','achievement_award_versions','achievement_requests','achievement_events','achievement_outbox'] LOOP
   EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
   FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r); END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%achievement%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.resolve_achievement_scope(text,uuid),hon.read_achievements(text,text,uuid,uuid,uuid,integer),hon.mutate_achievements(text,text,uuid,uuid,jsonb,text,uuid,uuid),hon.read_parent_achievements(text,uuid,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;

-- Marketing Assistant: only fixed trusted boundaries; no table access or secret storage.
DO $$ DECLARE r text; t text; a text; f record; BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname IN('marketing_safe_text','marketing_owner','marketing_event','guard_marketing_invocation','read_marketing_invocation','list_my_marketing_invocations','begin_marketing_request','prepare_marketing_invocation','fail_marketing_invocation','record_marketing_result','bind_marketing_proposal','marketing_action_is_current','reject_marketing_draft','save_approved_marketing_draft','marketing_planning_reference','read_marketing_campaign_content') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r); END LOOP;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['marketing_ai_invocations','marketing_ai_drafts','marketing_campaign_content'] LOOP
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a,t); END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
   FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r); END LOOP;
  END LOOP;
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION hon.read_marketing_invocation(text,uuid),hon.list_my_marketing_invocations(text),hon.begin_marketing_request(text,jsonb,uuid),hon.prepare_marketing_invocation(text,uuid,uuid,boolean),hon.fail_marketing_invocation(text,uuid,text,text),hon.record_marketing_result(text,uuid,jsonb),hon.bind_marketing_proposal(text,uuid,uuid),hon.marketing_action_is_current(uuid,jsonb),hon.reject_marketing_draft(uuid),hon.save_approved_marketing_draft(text,uuid),hon.marketing_planning_reference(text,uuid),hon.read_marketing_campaign_content(text,uuid) TO hon_runtime;

-- Deterministic School Health Score: one fixed aggregate-only read projection.
-- It adds no direct source-table privilege, provider capability, or write path.
REVOKE ALL ON FUNCTION hon.read_school_health_score(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.read_school_health_score(text,uuid,uuid) TO hon_runtime;

-- Teaching Studio human foundation: private plan/resource/assessment tables and
-- helpers remain unavailable. Only fixed direct-human scope/read/write boundaries
-- execute; no student directory, parent, HQ, AI, Action Engine, or provider grant.
DO $$ DECLARE r text; t text; a text; f record; BEGIN
 FOREACH t IN ARRAY ARRAY['teaching_lesson_plans','teaching_lesson_plan_revisions','teaching_resources','teaching_resource_revisions','instructor_assessments','instructor_assessment_revisions','teaching_studio_requests'] LOOP
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a,t); END LOOP;
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%teaching_studio%' OR p.proname LIKE 'teaching_%') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r); END LOOP;
 END LOOP;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  FOREACH t IN ARRAY ARRAY['teaching_lesson_plans','teaching_lesson_plan_revisions','teaching_resources','teaching_resource_revisions','instructor_assessments','instructor_assessment_revisions','teaching_studio_requests'] LOOP
   EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
   FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r); END LOOP;
  END LOOP;
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION hon.resolve_teaching_studio_scope(text,uuid),hon.read_teaching_studio(text,text,uuid,uuid,integer),hon.mutate_teaching_studio(text,text,uuid,uuid,jsonb,text,uuid,uuid) TO hon_runtime;

-- Retention Review Signals: a true read-only, evidence-only human staff projection.
-- No direct table access and no helper execution are granted; these two fixed
-- functions independently enforce direct HUMAN_UI identity, exact permission,
-- active Essential/Core/Complete entitlement and current school scope.
DO $$ DECLARE r text; f record; BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'hon'
      AND p.proname IN (
        'retention_review_has_permission',
        'resolve_retention_review_scope',
        'require_retention_review_actor',
        'lock_retention_review_actor',
        'read_retention_review_signals'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.signature);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f.signature, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.resolve_retention_review_scope(text, uuid),
      hon.read_retention_review_signals(text, uuid) TO hon_runtime;
  END IF;
END $$;


-- Human testing certificates: private immutable school records only. The runtime
-- receives exactly scope/read/issue function execution; no table, column, helper,
-- provider, Action Engine, delivery, or directory privilege is introduced.
DO $$
DECLARE r text; t text; a text; f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'hon' AND p.proname LIKE '%testing_certificate%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.signature);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['testing_certificates','testing_certificate_requests','testing_certificate_outbox'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
    FOR a IN SELECT attname FROM pg_attribute WHERE attrelid = format('hon.%I', t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC', a, t);
    END LOOP;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    FOREACH t IN ARRAY ARRAY['testing_certificates','testing_certificate_requests','testing_certificate_outbox'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
      FOR a IN SELECT attname FROM pg_attribute WHERE attrelid = format('hon.%I', t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I', a, t, r);
      END LOOP;
    END LOOP;
    FOR f IN
      SELECT p.oid::regprocedure AS signature
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'hon' AND p.proname LIKE '%testing_certificate%'
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f.signature, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION
      hon.resolve_testing_certificate_scope(text,uuid),
      hon.read_testing_certificate(text,uuid),
      hon.issue_testing_certificate(text,uuid,jsonb,text,uuid,uuid)
    TO hon_runtime;
  END IF;
END $$;


-- Human testing scorecards: independently attributable internal observations only.
-- The runtime receives exactly scope/read/record execution; no direct scorecard,
-- candidate, event, directory, parent, Action Engine, provider, or consumer access.
DO $$
DECLARE r text; t text; a text; f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'hon' AND p.proname LIKE '%testing_scorecard%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.signature);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['testing_scorecards','testing_scorecard_evaluations','testing_scorecard_requests','testing_scorecard_outbox'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
    FOR a IN SELECT attname FROM pg_attribute WHERE attrelid = format('hon.%I', t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC', a, t);
    END LOOP;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    FOREACH t IN ARRAY ARRAY['testing_scorecards','testing_scorecard_evaluations','testing_scorecard_requests','testing_scorecard_outbox'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
      FOR a IN SELECT attname FROM pg_attribute WHERE attrelid = format('hon.%I', t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I', a, t, r);
      END LOOP;
    END LOOP;
    FOR f IN
      SELECT p.oid::regprocedure AS signature
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'hon' AND p.proname LIKE '%testing_scorecard%'
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f.signature, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION
      hon.resolve_testing_scorecard_scope(text,uuid),
      hon.read_testing_scorecard(text,uuid,uuid),
      hon.record_testing_scorecard_evaluation(text,uuid,uuid,jsonb,text,uuid,uuid)
    TO hon_runtime;
  END IF;
END $$;


-- Chad CRM follow-up assistant: immutable content proposals only. No direct table,
-- helper, communication queue, or delivery capability.
BEGIN;
DO $$
DECLARE r text; t text; a text; f record;
BEGIN
  FOREACH t IN ARRAY ARRAY['chad_follow_up_invocations','chad_follow_up_drafts'] LOOP
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a,t); END LOOP;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
    FOREACH t IN ARRAY ARRAY['chad_follow_up_invocations','chad_follow_up_drafts'] LOOP
      EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
      FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname IN('guard_chad_follow_up','resolve_chad_follow_up_scope','require_chad_follow_up_actor','chad_follow_up_event','read_chad_follow_up_invocation','list_my_chad_follow_up_invocations','begin_chad_follow_up_request','chad_follow_up_planning_reference','prepare_chad_follow_up_invocation','fail_chad_follow_up_invocation','record_chad_follow_up_result','bind_chad_follow_up_proposal','chad_follow_up_draft_is_current','transition_chad_follow_up_draft') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.resolve_chad_follow_up_scope(text),hon.read_chad_follow_up_invocation(text,uuid),hon.list_my_chad_follow_up_invocations(text),hon.begin_chad_follow_up_request(text,jsonb,uuid),hon.chad_follow_up_planning_reference(text,uuid),hon.prepare_chad_follow_up_invocation(text,uuid,uuid,boolean),hon.fail_chad_follow_up_invocation(text,uuid,text,text),hon.record_chad_follow_up_result(text,uuid,jsonb),hon.bind_chad_follow_up_proposal(text,uuid,uuid),hon.chad_follow_up_draft_is_current(uuid,jsonb),hon.transition_chad_follow_up_draft(uuid,text) TO hon_runtime; END IF;
END $$;
COMMIT;

-- Claire Teaching Assistant: private curriculum-only drafting records. No direct
-- table/column or helper access; only these explicit server boundaries execute.
BEGIN;
DO $$
DECLARE r text; t text; a text; f record;
BEGIN
  FOREACH t IN ARRAY ARRAY['teaching_ai_invocations','teaching_ai_drafts','teaching_studio_ai_drafts'] LOOP
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a,t);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND p.proname IN('teaching_assistant_safe_text','guard_teaching_assistant','resolve_teaching_assistant_scope','require_teaching_assistant_actor','teaching_assistant_event','read_teaching_invocation','list_my_teaching_invocations','list_teaching_assistant_curricula','begin_teaching_request','teaching_planning_reference','prepare_teaching_invocation','fail_teaching_invocation','record_teaching_result','bind_teaching_proposal','teaching_action_is_current','reject_teaching_draft','save_approved_teaching_draft') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
    FOREACH t IN ARRAY ARRAY['teaching_ai_invocations','teaching_ai_drafts','teaching_studio_ai_drafts'] LOOP
      EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
      FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r);
      END LOOP;
    END LOOP;
    FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='hon' AND p.proname IN('teaching_assistant_safe_text','guard_teaching_assistant','resolve_teaching_assistant_scope','require_teaching_assistant_actor','teaching_assistant_event','read_teaching_invocation','list_my_teaching_invocations','list_teaching_assistant_curricula','begin_teaching_request','teaching_planning_reference','prepare_teaching_invocation','fail_teaching_invocation','record_teaching_result','bind_teaching_proposal','teaching_action_is_current','reject_teaching_draft','save_approved_teaching_draft') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.resolve_teaching_assistant_scope(text),hon.read_teaching_invocation(text,uuid),hon.list_my_teaching_invocations(text),hon.list_teaching_assistant_curricula(text),hon.begin_teaching_request(text,jsonb,uuid),hon.teaching_planning_reference(text,uuid),hon.prepare_teaching_invocation(text,uuid,uuid,boolean),hon.fail_teaching_invocation(text,uuid,text,text),hon.record_teaching_result(text,uuid,jsonb),hon.bind_teaching_proposal(text,uuid,uuid),hon.teaching_action_is_current(uuid,jsonb),hon.reject_teaching_draft(uuid),hon.save_approved_teaching_draft(text,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;

-- Human instructor qualifications: immutable internal evidence only. The runtime
-- receives exactly one scope resolver, one redacted read, and one fixed mutation;
-- private tables, helpers, Action Engine, scheduling, testing, and providers stay denied.
BEGIN;
DO $$
DECLARE r text; t text; a text; f record;
BEGIN
  FOREACH t IN ARRAY ARRAY['instructor_qualifications','instructor_qualification_revisions','instructor_qualification_evidence','instructor_qualification_evidence_reviews','instructor_qualification_requests','instructor_qualification_outbox'] LOOP
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a,t); END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%instructor_qualification%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature); END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
    FOREACH t IN ARRAY ARRAY['instructor_qualifications','instructor_qualification_revisions','instructor_qualification_evidence','instructor_qualification_evidence_reviews','instructor_qualification_requests','instructor_qualification_outbox'] LOOP
      EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
      FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r); END LOOP;
    END LOOP;
    FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%instructor_qualification%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.resolve_instructor_qualification_scope(text),hon.read_instructor_qualification(text,text,uuid,uuid),hon.mutate_instructor_qualification(text,text,uuid,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;

-- HQ profiles remain function-only. No PUBLIC/runtime table or column ACLs.
REVOKE ALL ON TABLE hon.hq_ai_task_profiles,hon.hq_ai_task_profile_candidates FROM PUBLIC,hon_runtime;
REVOKE ALL ON FUNCTION hon.hq_ai_valid_list(jsonb,text[],integer,integer),
  hon.hq_ai_task_profile_snapshot(uuid),hon.hq_ai_snapshot(),hon.hq_ai_validate_write(text,jsonb),
  hon.hq_ai_safe_text(text,boolean) FROM PUBLIC,hon_runtime;

-- Advanced attendance: fixed function-only commands and exact scoped record reads.
BEGIN;
REVOKE ALL ON TABLE hon.attendance_progression_policies,hon.attendance_policy_requests FROM PUBLIC,hon_runtime;
REVOKE ALL ON FUNCTION hon.default_attendance_categories(),hon.valid_attendance_categories(jsonb),hon.snapshot_attendance_credit() FROM PUBLIC,hon_runtime;
REVOKE ALL ON FUNCTION hon.lock_attendance_actor(text,text),hon.read_attendance_policy(text,uuid),hon.configure_attendance_policy(text,uuid,jsonb,text,uuid,uuid),hon.record_attendance(text,uuid,jsonb,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.lock_attendance_actor(text,text),hon.read_attendance_policy(text,uuid),hon.configure_attendance_policy(text,uuid,jsonb,text,uuid,uuid),hon.record_attendance(text,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
REVOKE ALL ON hon.attendance_records FROM PUBLIC,hon_runtime;
DO $$ DECLARE a text; r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON hon.attendance_records FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.record_attendance(text,uuid,jsonb,text,uuid,uuid) FROM %I',r);
 END LOOP;
 FOR a IN SELECT attname FROM pg_attribute WHERE attrelid='hon.attendance_records'::regclass AND attnum>0 AND NOT attisdropped LOOP
  EXECUTE format('REVOKE ALL (%I) ON hon.attendance_records FROM PUBLIC,hon_runtime',a);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL (%I) ON hon.attendance_records FROM %I',a,r);
  END LOOP;
 END LOOP;
END $$;
GRANT SELECT ON hon.attendance_records TO hon_runtime;
COMMIT;

-- Promotion readiness exact grants: no new table or helper authority.
BEGIN;
REVOKE ALL ON FUNCTION hon.read_promotion_readiness(text,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.read_promotion_readiness(text,uuid,uuid) FROM %I',r);
 END LOOP;
 GRANT EXECUTE ON FUNCTION hon.read_promotion_readiness(text,uuid,uuid) TO hon_runtime;
END $$;
COMMIT;

-- ClassPass exact grants: direct table/column and helper authority are denied.
BEGIN;
REVOKE ALL ON hon.classpass_products,hon.classpass_passes,hon.classpass_ledger FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_classpass_snapshot(),hon.guard_classpass_booking(),hon.lock_classpass_actor(text,text),hon.read_classpass(text,text,uuid),hon.command_classpass(text,text,uuid,jsonb,text,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; t text; a text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON hon.classpass_products,hon.classpass_passes,hon.classpass_ledger FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_classpass_snapshot(),hon.guard_classpass_booking(),hon.lock_classpass_actor(text,text),hon.read_classpass(text,text,uuid),hon.command_classpass(text,text,uuid,jsonb,text,uuid,uuid) FROM %I',r);
 END LOOP;
 FOR t IN SELECT unnest(ARRAY['classpass_products','classpass_passes','classpass_ledger']) LOOP
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a,t);
   FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r);
   END LOOP;
  END LOOP;
 END LOOP;
 GRANT EXECUTE ON FUNCTION hon.read_classpass(text,text,uuid),hon.command_classpass(text,text,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
END $$;
COMMIT;

-- Generic human booking lock: runtime needs EXECUTE, never session UPDATE.
BEGIN;
REVOKE ALL ON FUNCTION hon.lock_class_booking_session(text,uuid),hon.require_classpass_read_actor(text) FROM PUBLIC;
DO $$ DECLARE r text; a text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.lock_class_booking_session(text,uuid),hon.require_classpass_read_actor(text) FROM %I',r);
  EXECUTE format('REVOKE UPDATE ON hon.class_sessions FROM %I',r);
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid='hon.class_sessions'::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE UPDATE (%I) ON hon.class_sessions FROM %I',a,r);
  END LOOP;
 END LOOP;
 REVOKE UPDATE ON hon.class_sessions FROM PUBLIC;
 FOR a IN SELECT attname FROM pg_attribute WHERE attrelid='hon.class_sessions'::regclass AND attnum>0 AND NOT attisdropped LOOP
  EXECUTE format('REVOKE UPDATE (%I) ON hon.class_sessions FROM PUBLIC',a);
 END LOOP;
 GRANT EXECUTE ON FUNCTION hon.lock_class_booking_session(text,uuid) TO hon_runtime;
END $$;
COMMIT;

-- Fixed parent ClassPass read: no direct table or command grants.
REVOKE ALL ON FUNCTION hon.read_parent_classpass_view(text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.read_parent_classpass_view(text) FROM %I',r);
 END LOOP;
 GRANT EXECUTE ON FUNCTION hon.read_parent_classpass_view(text) TO hon_runtime;
END $$;

-- Kiosk handoff: only fixed functions, never direct table/column authority.
-- Parameter logging is superuser-controlled: no elevated runtime setting grant.
ALTER ROLE hon_runtime SET log_parameter_max_length=0;
ALTER ROLE hon_runtime SET log_parameter_max_length_on_error=0;
DO $$ DECLARE r text; t text; signature text; BEGIN
 FOREACH t IN ARRAY ARRAY['kiosk_terminals','kiosk_terminal_sessions','kiosk_claims','kiosk_handoffs','kiosk_receipts'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
  END LOOP;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['manage_kiosk_terminal(text,text,uuid,uuid,text)','provision_kiosk_claim(text,uuid,uuid,uuid,text)','submit_kiosk_handoff(text,text)','read_kiosk_handoff(text,uuid)','lock_kiosk_actor(text,text)','kiosk_secret_valid(text)','guard_kiosk_transition()'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM PUBLIC',signature);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM %I',signature,r);
  END LOOP;
  IF signature IN('manage_kiosk_terminal(text,text,uuid,uuid,text)','provision_kiosk_claim(text,uuid,uuid,uuid,text)','submit_kiosk_handoff(text,text)','read_kiosk_handoff(text,uuid)') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION hon.%s TO hon_runtime',signature); END IF;
 END LOOP;
END $$;

-- Human retention acknowledgement: exact private function-only boundary.
DO $$ DECLARE r text; t text; f text; a text; BEGIN
 FOREACH t IN ARRAY ARRAY['retention_review_acknowledgements','retention_review_acknowledgement_receipts','retention_review_acknowledgement_outbox','retention_review_acknowledgement_evidence_keys'] LOOP
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
  END LOOP;
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a,t);
   FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r);
   END LOOP;
  END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['require_retention_acknowledgement_actor(text)','retention_review_evidence_fingerprint(jsonb,timestamptz)','read_retention_review_acknowledgement_evidence(text,uuid)','acknowledge_retention_review_evidence(text,uuid,text,text,timestamptz,uuid,uuid,uuid)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM %I',f,r);
  END LOOP;
 END LOOP;
 GRANT EXECUTE ON FUNCTION hon.read_retention_review_acknowledgement_evidence(text,uuid),hon.acknowledge_retention_review_evidence(text,uuid,text,text,timestamptz,uuid,uuid,uuid) TO hon_runtime;
END $$;

-- HQ-1 platform overview: one aggregate-only fixed projection. No direct
-- tenant-directory, onboarding, HQ provider/profile, work, billing, usage,
-- identity, credential, or client execution privilege is introduced.
DO $$ DECLARE r text; t text; a text; BEGIN
 FOREACH t IN ARRAY ARRAY['organizations','schools','hq_onboarding_requests','hq_ai_provider_connections','hq_ai_task_profiles'] LOOP
  EXECUTE format('REVOKE ALL ON hon.%I FROM hon_runtime,PUBLIC',t);
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM hon_runtime,PUBLIC',a,t);
  END LOOP;
 END LOOP;
 REVOKE ALL ON FUNCTION hon.read_hq_platform_overview(text) FROM PUBLIC,hon_runtime;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.read_hq_platform_overview(text) FROM %I',r);
  FOREACH t IN ARRAY ARRAY['organizations','schools','hq_onboarding_requests','hq_ai_provider_connections','hq_ai_task_profiles'] LOOP
   EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
   FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r);
   END LOOP;
  END LOOP;
 END LOOP;
 GRANT EXECUTE ON FUNCTION hon.read_hq_platform_overview(text) TO hon_runtime;
END $$;

-- HQ School Management: exactly one selector-free customer-account projection.
-- Source tables stay private; no support, impersonation, provider, payment,
-- action, audit/outbox, or school-level authority is granted by this block.
DO $$ DECLARE r text; t text; a text; BEGIN
 FOREACH t IN ARRAY ARRAY['organizations','schools','organization_entitlements'] LOOP
  EXECUTE format('REVOKE ALL ON hon.%I FROM hon_runtime,PUBLIC CASCADE',t);
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM hon_runtime,PUBLIC CASCADE',a,t);
  END LOOP;
 END LOOP;
 REVOKE ALL ON FUNCTION hon.read_hq_school_directory(text) FROM PUBLIC,hon_runtime;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.read_hq_school_directory(text) FROM %I',r);
  FOREACH t IN ARRAY ARRAY['organizations','schools','organization_entitlements'] LOOP
    EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
   FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r);
   END LOOP;
  END LOOP;
 END LOOP;
 GRANT EXECUTE ON FUNCTION hon.read_hq_school_directory(text) TO hon_runtime;
END $$;

-- Conventional tenant services read only the current active tier through 0130's
-- fixed no-argument projection. No direct table/column entitlement privileges,
-- client execution, grant option, or runtime ownership/BYPASSRLS are introduced.
DO $$ DECLARE r text; BEGIN
 REVOKE ALL ON FUNCTION hon.read_current_organization_entitlement() FROM PUBLIC,hon_runtime;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.read_current_organization_entitlement() FROM %I',r);
 END LOOP;
 GRANT EXECUTE ON FUNCTION hon.read_current_organization_entitlement() TO hon_runtime;
END $$;

-- Retention factual attention exact grants: private roots/history/receipts/inert facts only.
DO $$ DECLARE r text; t text; f text; a text; BEGIN
 FOREACH t IN ARRAY ARRAY['retention_attention_alerts','retention_attention_resolutions','retention_attention_record_receipts','retention_attention_resolution_receipts','retention_attention_outbox'] LOOP
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
  END LOOP;
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a,t);
   FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r);
   END LOOP;
  END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['require_retention_attention_actor(text,text)','retention_attention_codes(jsonb)','retention_attention_projection(uuid,boolean)','read_retention_attention_alerts(text,uuid)','read_retention_attention_evidence(text,uuid)','record_retention_attention_alert(text,uuid,text,text,timestamptz,text,uuid,uuid,uuid)','resolve_retention_attention_alert(text,uuid,uuid,integer,text,uuid,uuid,uuid)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM %I',f,r);
  END LOOP;
 END LOOP;
 GRANT EXECUTE ON FUNCTION hon.read_retention_attention_alerts(text,uuid),hon.read_retention_attention_evidence(text,uuid),hon.record_retention_attention_alert(text,uuid,text,text,timestamptz,text,uuid,uuid,uuid),hon.resolve_retention_attention_alert(text,uuid,uuid,integer,text,uuid,uuid,uuid) TO hon_runtime;
END $$;

-- Curriculum library exact grant reconciliation (no raw table or column grants).
DO $$ DECLARE t text; r text; a record; f text; BEGIN
 FOREACH t IN ARRAY ARRAY['curriculum_resources','curriculum_resource_versions','curriculum_resource_requests','curriculum_resource_facts'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
  END LOOP;
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a.attname,t);
   FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a.attname,t,r);
   END LOOP;
  END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['valid_curriculum_resource_url(text)','guard_curriculum_resource()','lock_curriculum_resource_actor(text)','curriculum_resource_projection(hon.curriculum_resources)','read_staff_curriculum_library(text)','mutate_curriculum_resource(text,text,uuid,jsonb,text,uuid,uuid)','read_parent_curriculum_library(text,uuid)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM %I',f,r);
  END LOOP;
 END LOOP;
 GRANT EXECUTE ON FUNCTION hon.read_staff_curriculum_library(text),hon.mutate_curriculum_resource(text,text,uuid,jsonb,text,uuid,uuid),hon.read_parent_curriculum_library(text,uuid) TO hon_runtime;
END $$;

-- Owner launch exact grant reconciliation (no raw table or column grants).
DO $$ DECLARE t text; r text; a record; f text; BEGIN
 FOREACH t IN ARRAY ARRAY['student_registration_receipts','student_registration_outbox','guardian_child_registration_receipts','guardian_child_registration_outbox'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
  END LOOP;
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a.attname,t);
   FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a.attname,t,r);
   END LOOP;
  END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['guard_enrollment_program_identity()','resolve_owner_launch_scope(text)','require_owner_launch_actor(text)','lock_owner_launch_actor(text)','register_owner_launch_student(text,jsonb,text,uuid,uuid)','read_owner_launch(text)','read_owner_launch_saved_students(text)','require_owner_launch_family_actor(text)','register_owner_launch_guardian_child(text,jsonb,text,uuid,uuid)','book_owner_launch_first_class(text,jsonb,text,uuid,uuid)','draft_owner_launch_membership(text,jsonb,text,uuid,uuid)','read_owner_launch_membership_draft(text)','read_owner_launch_first_class_booking_context(text)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM %I',f,r);
  END LOOP;
 END LOOP;
 GRANT EXECUTE ON FUNCTION hon.resolve_owner_launch_scope(text),hon.register_owner_launch_student(text,jsonb,text,uuid,uuid),hon.read_owner_launch(text),hon.read_owner_launch_saved_students(text),hon.register_owner_launch_guardian_child(text,jsonb,text,uuid,uuid),hon.book_owner_launch_first_class(text,jsonb,text,uuid,uuid),hon.draft_owner_launch_membership(text,jsonb,text,uuid,uuid),hon.read_owner_launch_membership_draft(text),hon.read_owner_launch_first_class_booking_context(text) TO hon_runtime;
END $$;

-- Preserve 0141/0142's existing function-only authority across the blanket
-- function revocation above; no new directory/table capability is introduced.
REVOKE ALL ON FUNCTION hon.resolve_current_staff_reporting_scope(text),hon.read_staff_reporting_schools(text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.resolve_current_staff_reporting_scope(text),hon.read_staff_reporting_schools(text) FROM %I',r);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION hon.resolve_current_staff_reporting_scope(text),hon.read_staff_reporting_schools(text) TO hon_runtime;

-- CRM-only lead close exact reconciliation:
REVOKE ALL ON TABLE hon.crm_lead_close_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_crm_lead_close_history(), hon.crm_lead_close_has_permission(uuid,uuid,uuid,text),
  hon.resolve_crm_lead_close_scope(text,uuid), hon.require_crm_lead_close_actor(text), hon.guard_crm_lead_close_update(),
  hon.close_crm_lead(text,uuid,jsonb,uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','hon_runtime') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.crm_lead_close_requests FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_crm_lead_close_history(), hon.crm_lead_close_has_permission(uuid,uuid,uuid,text), hon.resolve_crm_lead_close_scope(text,uuid), hon.require_crm_lead_close_actor(text), hon.guard_crm_lead_close_update(), hon.close_crm_lead(text,uuid,jsonb,uuid,uuid,uuid) FROM %I',r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.resolve_crm_lead_close_scope(text,uuid), hon.close_crm_lead(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
-- End CRM-only lead close exact reconciliation.

-- HQ entitlement transition exact reconciliation:
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['organization_entitlements','hq_entitlement_requests','hq_entitlement_audit','hq_entitlement_outbox'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.'||t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I CASCADE',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_hq_entitlement_evidence()','hon.require_hq_entitlement_actor(text)',
    'hon.transition_organization_entitlement_from_hq(text,uuid,text,integer,uuid,text,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.transition_organization_entitlement_from_hq(text,uuid,text,integer,uuid,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
-- End HQ entitlement transition exact reconciliation.

-- Champions Club foundation exact reconciliation:
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['champions_policies','champions_referral_codes','champions_attributions','champions_attribution_history',
      'champions_requests','champions_audit','champions_outbox'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.'||t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE',col,t);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_champions_evidence()','hon.guard_champions_records()','hon.champions_refuse_context()',
      'hon.require_champions_hq_actor(text,boolean)','hon.require_champions_school_actor(text,uuid)',
      'hon.champions_claim_request(uuid,uuid,text,text,uuid,uuid)',
      'hon.champions_record(uuid,uuid,text,text,text,uuid,uuid,jsonb,jsonb,jsonb,timestamptz)',
      'hon.champions_fingerprint(text[])','hon.champions_ts(timestamptz)','hon.champions_policy_json(hon.champions_policies)',
      'hon.champions_attribution_json(hon.champions_attributions)','hon.champions_orgs_share_user(uuid,uuid)',
      'hon.issue_champions_referral_code(text,uuid,uuid,uuid,uuid)','hon.read_champions_school_view(text,uuid)',
      'hon.read_champions_program_from_hq(text)','hon.create_champions_policy_draft(text,jsonb,uuid,uuid,uuid)',
      'hon.publish_champions_policy(text,uuid,uuid,uuid,uuid)','hon.capture_champions_attribution(text,jsonb,uuid,uuid,uuid)',
      'hon.decide_champions_attribution(text,uuid,jsonb,uuid,uuid,uuid)','hon.read_champions_attributions_from_hq(text,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.issue_champions_referral_code(text,uuid,uuid,uuid,uuid), hon.read_champions_school_view(text,uuid),
      hon.read_champions_program_from_hq(text), hon.create_champions_policy_draft(text,jsonb,uuid,uuid,uuid),
      hon.publish_champions_policy(text,uuid,uuid,uuid,uuid), hon.capture_champions_attribution(text,jsonb,uuid,uuid,uuid),
      hon.decide_champions_attribution(text,uuid,jsonb,uuid,uuid,uuid), hon.read_champions_attributions_from_hq(text,text)
      TO hon_runtime;
  END IF;
END $$;
-- End Champions Club foundation exact reconciliation.

-- Champions Club reward accounting exact reconciliation:
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['champions_reward_policies','champions_reward_entries','champions_reward_history'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.'||t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE',col,t);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_champions_rewards()','hon.champions_reward_policy_json(hon.champions_reward_policies)',
      'hon.champions_reward_json(hon.champions_reward_entries)','hon.read_champions_reward_program_from_hq(text)',
      'hon.create_champions_reward_policy_draft(text,jsonb,uuid,uuid,uuid)','hon.publish_champions_reward_policy(text,uuid,uuid,uuid,uuid)',
      'hon.reconcile_champions_rewards(text,uuid,uuid,uuid,uuid)','hon.decide_champions_reward(text,uuid,jsonb,uuid,uuid,uuid)',
      'hon.read_champions_reward_ledger_from_hq(text,text)','hon.read_champions_school_rewards(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_champions_reward_program_from_hq(text), hon.create_champions_reward_policy_draft(text,jsonb,uuid,uuid,uuid),
      hon.publish_champions_reward_policy(text,uuid,uuid,uuid,uuid), hon.reconcile_champions_rewards(text,uuid,uuid,uuid,uuid),
      hon.decide_champions_reward(text,uuid,jsonb,uuid,uuid,uuid), hon.read_champions_reward_ledger_from_hq(text,text),
      hon.read_champions_school_rewards(text,uuid)
      TO hon_runtime;
  END IF;
END $$;
-- End Champions Club reward accounting exact reconciliation.

-- Champions Club leaderboard exact reconciliation:
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['champions_leaderboard_preferences','champions_leaderboard_holds'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.'||t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE',col,t);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_champions_leaderboard()','hon.champions_period_month(text,text)','hon.champions_standings(date)',
      'hon.champions_milestone_progress(integer)','hon.champions_school_statistics_json(uuid,boolean)',
      'hon.read_champions_leaderboard_from_hq(text,text,text)','hon.read_champions_school_statistics_from_hq(text,uuid)',
      'hon.set_champions_leaderboard_hold(text,jsonb,uuid,uuid,uuid)','hon.read_champions_leaderboard_for_school(text,uuid,text,text)',
      'hon.read_champions_school_statistics(text,uuid)','hon.set_champions_leaderboard_preference(text,uuid,jsonb,uuid,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_champions_leaderboard_from_hq(text,text,text), hon.read_champions_school_statistics_from_hq(text,uuid),
      hon.set_champions_leaderboard_hold(text,jsonb,uuid,uuid,uuid), hon.read_champions_leaderboard_for_school(text,uuid,text,text),
      hon.read_champions_school_statistics(text,uuid), hon.set_champions_leaderboard_preference(text,uuid,jsonb,uuid,uuid,uuid)
      TO hon_runtime;
  END IF;
END $$;
-- End Champions Club leaderboard exact reconciliation.

-- Flexible billing accounts (0159): the line-56 baseline revokes every hon
-- function from the runtime, so restore exactly the two fixed direct-human
-- billing-account authority checks the conventional billing-account command
-- calls. No IAM directory table access or other capability is granted.
DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.require_current_direct_human_billing_account_actor(uuid),
    hon.lock_current_direct_human_billing_accounts(uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.require_current_direct_human_billing_account_actor(uuid), hon.lock_current_direct_human_billing_accounts(uuid) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.require_current_direct_human_billing_account_actor(uuid),
      hon.lock_current_direct_human_billing_accounts(uuid) TO hon_runtime;
  END IF;
END $$;
-- End flexible billing accounts exact reconciliation.

-- CRM lead registration: preserve no direct conversion-record, directory, or
-- helper capability when this canonical reconciliation is run after migration
-- 0160. The restricted runtime receives exactly one verified-scope resolver
-- and one direct-human fixed command; neither enables enrollment, membership,
-- billing, payment, provider, AI, Action Engine, communication, or automation.
DO $$ DECLARE r text; t text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['crm_lead_registration_conversions'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.' || t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC', col, t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I', col, t, r);
      END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'guard_crm_lead_registration_history()',
    'crm_lead_registration_has_permission(uuid,uuid,uuid,text)',
    'resolve_crm_lead_registration_scope(text,uuid)',
    'require_crm_lead_registration_actor(text,text)',
    'register_crm_lead_person(text,uuid,jsonb,uuid,uuid,uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.resolve_crm_lead_registration_scope(text,uuid),
      hon.register_crm_lead_person(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
-- End CRM lead registration exact reconciliation.

-- Adult CRM membership draft exact reconciliation: no new source-table capability.
DO $$ DECLARE r text; col text; f text; BEGIN
  REVOKE ALL ON TABLE hon.crm_adult_membership_draft_sources FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.crm_adult_membership_draft_sources FROM %I',r);
  END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='hon.crm_adult_membership_draft_sources'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.crm_adult_membership_draft_sources FROM PUBLIC',col);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.crm_adult_membership_draft_sources FROM %I',col,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_crm_adult_membership_draft_source()','hon.require_crm_adult_membership_actor(text)','hon.crm_adult_membership_relation(uuid)','hon.read_crm_adult_membership_preparation(text,uuid)','hon.read_crm_adult_membership_draft_confirmation(text,uuid)','hon.draft_crm_adult_membership(text,jsonb,uuid,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  GRANT EXECUTE ON FUNCTION hon.read_crm_adult_membership_preparation(text,uuid),hon.read_crm_adult_membership_draft_confirmation(text,uuid),hon.draft_crm_adult_membership(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
END $$;
-- End adult CRM membership draft exact reconciliation.

-- CRM lead registration recovery exact reconciliation: one read-only function with runtime EXECUTE; its private current-DRAFT check has none.
DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.crm_adult_membership_draft_is_current(uuid),hon.read_crm_lead_registration_recovery(text,uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.crm_adult_membership_draft_is_current(uuid),hon.read_crm_lead_registration_recovery(text,uuid) FROM %I',r);
  END LOOP;
  GRANT EXECUTE ON FUNCTION hon.read_crm_lead_registration_recovery(text,uuid) TO hon_runtime;
END $$;
-- End CRM lead registration recovery exact reconciliation.

-- School membership plan catalog exact reconciliation (0175): private tables, five runtime entry points, private helpers.
DO $$ DECLARE r text; col text; t text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['membership_plans','membership_plan_versions','membership_plan_selections'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_membership_plan()','hon.guard_membership_plan_version()','hon.guard_membership_plan_selection()',
    'hon.require_membership_plan_manager(text)','hon.membership_plan_validated_terms(jsonb)','hon.membership_plan_version_summary(uuid,integer)',
    'hon.read_school_membership_plan_catalog(text)','hon.create_school_membership_plan(text,jsonb,uuid,uuid,uuid)','hon.revise_school_membership_plan(text,uuid,jsonb,uuid,uuid,uuid)',
    'hon.read_crm_adult_membership_plan_options(text)','hon.draft_crm_adult_membership_from_plan(text,jsonb,uuid,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  GRANT EXECUTE ON FUNCTION hon.read_school_membership_plan_catalog(text),hon.create_school_membership_plan(text,jsonb,uuid,uuid,uuid),
    hon.revise_school_membership_plan(text,uuid,jsonb,uuid,uuid,uuid),hon.read_crm_adult_membership_plan_options(text),
    hon.draft_crm_adult_membership_from_plan(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
END $$;
-- End school membership plan catalog exact reconciliation.

-- CRM guardian/child enrollment exact reconciliation (0176): private immutable tables, four runtime entry points, private helpers.
DO $$ DECLARE r text; col text; t text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['crm_guardian_child_enrolled_children','crm_guardian_child_payer_designations','crm_guardian_child_membership_draft_sources'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_crm_guardian_child_enrollment_history()','hon.capture_crm_guardian_child_registration_child()',
    'hon.require_crm_guardian_child_enrollment_actor(text)','hon.crm_guardian_child_family_relation(uuid)','hon.crm_guardian_child_child_relation(uuid)',
    'hon.crm_guardian_child_current_designation(uuid,uuid,uuid,uuid,uuid)','hon.crm_guardian_child_membership_draft_current(uuid)',
    'hon.read_crm_guardian_child_enrollment(text,uuid)','hon.designate_crm_guardian_child_payer(text,uuid,jsonb,uuid,uuid,uuid)',
    'hon.add_crm_guardian_child_additional_child(text,uuid,jsonb,uuid,uuid,uuid)','hon.draft_crm_guardian_child_membership_from_plan(text,jsonb,uuid,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  GRANT EXECUTE ON FUNCTION hon.read_crm_guardian_child_enrollment(text,uuid),hon.designate_crm_guardian_child_payer(text,uuid,jsonb,uuid,uuid,uuid),
    hon.add_crm_guardian_child_additional_child(text,uuid,jsonb,uuid,uuid,uuid),hon.draft_crm_guardian_child_membership_from_plan(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
END $$;
-- End CRM guardian/child enrollment exact reconciliation.

-- Membership activation gate exact reconciliation (0177): no runtime UPDATE/DELETE on memberships, DRAFT-only
-- column INSERT, private immutable evidence tables, three runtime entry points, private helpers.
DO $$ DECLARE r text; col text; t text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['membership_activation_decisions','membership_effective_periods','membership_activation_follow_ups'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON TABLE hon.memberships FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON TABLE hon.memberships FROM %I',r);
  END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='hon.memberships'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE INSERT (%I),UPDATE (%I) ON hon.memberships FROM PUBLIC',col,col);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE INSERT (%I),UPDATE (%I) ON hon.memberships FROM %I',col,col,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_membership_activation_evidence()','hon.guard_membership_state_transition()','hon.membership_local_date(timestamptz,text)',
    'hon.membership_local_day_start(date,text)','hon.membership_effective_status_at(hon.membership_state,timestamptz,timestamptz,timestamptz)',
    'hon.membership_activation_text_ok(text,integer)','hon.membership_activation_date(jsonb)','hon.membership_lifecycle_permission(uuid,uuid,uuid,text)',
    'hon.require_membership_lifecycle_actor(text,text)','hon.evaluate_membership_activation(uuid,boolean,date,date)',
    'hon.preview_school_membership_activation(text,uuid,jsonb)','hon.activate_school_membership(text,uuid,jsonb,text,uuid,uuid)',
    'hon.cancel_school_membership(text,uuid,jsonb,text,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  GRANT INSERT (organization_id,school_id,billing_account_id,participant_person_id,plan_code,term_started_at,term_ends_at) ON hon.memberships TO hon_runtime;
  GRANT EXECUTE ON FUNCTION hon.preview_school_membership_activation(text,uuid,jsonb),hon.activate_school_membership(text,uuid,jsonb,text,uuid,uuid),
    hon.cancel_school_membership(text,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
END $$;
-- End membership activation gate exact reconciliation.

-- Membership date revisions exact reconciliation (0178): private immutable revision evidence, private helpers,
-- five runtime entry points. The runtime gains no privilege on hon.memberships (0177 D41 option C stands).
DO $$ DECLARE r text; col text; t text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['membership_date_revisions','membership_date_revision_follow_ups'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_membership_date_revision_insert()','hon.membership_instant_text(timestamptz)',
    'hon.membership_next_anchored_term_end(date,integer,date)','hon.membership_date_revision_retroactive_days(date,date,date,date,date)',
    'hon.membership_current_period(uuid)','hon.membership_reporting_status(hon.membership_state,timestamptz,timestamptz,boolean,timestamptz)',
    'hon.evaluate_membership_date_revision(uuid,text,boolean,date,date)','hon.preview_membership_date_revision(text,uuid,jsonb)',
    'hon.revise_membership_dates(text,uuid,jsonb,text,uuid,uuid)','hon.read_membership_date_history(text,uuid)',
    'hon.read_membership_date_confirmation_queue(text,jsonb)','hon.read_school_membership_status_summary(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  GRANT EXECUTE ON FUNCTION hon.preview_membership_date_revision(text,uuid,jsonb),hon.revise_membership_dates(text,uuid,jsonb,text,uuid,uuid),
    hon.read_membership_date_history(text,uuid),hon.read_membership_date_confirmation_queue(text,jsonb),
    hon.read_school_membership_status_summary(text) TO hon_runtime;
END $$;
-- End membership date revisions exact reconciliation.

-- Champions Club contests exact reconciliation:
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['champions_contests','champions_contest_prizes','champions_contest_schools','champions_contest_pauses',
      'champions_contest_results','champions_contest_winners','champions_contest_history'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.'||t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE',col,t);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_champions_contests()','hon.champions_contest_counts(uuid,timestamptz)','hon.champions_contest_standings(uuid)',
      'hon.champions_contest_json(hon.champions_contests)','hon.champions_contest_write_config(uuid,jsonb,boolean)',
      'hon.command_champions_contest(text,uuid,jsonb,uuid,uuid,uuid)','hon.read_champions_contests_from_hq(text,text)',
      'hon.read_champions_contest_from_hq(text,uuid)','hon.read_champions_contests_for_school(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.command_champions_contest(text,uuid,jsonb,uuid,uuid,uuid), hon.read_champions_contests_from_hq(text,text),
      hon.read_champions_contest_from_hq(text,uuid), hon.read_champions_contests_for_school(text,uuid)
      TO hon_runtime;
  END IF;
END $$;
-- End Champions Club contests exact reconciliation.

-- Champions Club integration exact reconciliation:
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.champions_reconcile_core(uuid,uuid,timestamptz)','hon.read_champions_overview_from_hq(text)',
      'hon.reconcile_champions_rewards(text,uuid,uuid,uuid,uuid)','hon.decide_champions_attribution(text,uuid,jsonb,uuid,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_champions_overview_from_hq(text), hon.reconcile_champions_rewards(text,uuid,uuid,uuid,uuid),
      hon.decide_champions_attribution(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
-- End Champions Club integration exact reconciliation.

-- HON subscription catalog (B1) exact reconciliation:
DO $$ DECLARE r text; f text; BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND p.proname ~ 'saas' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_catalog_from_hq(text), hon.create_saas_catalog_draft(text,jsonb,uuid,uuid,uuid),
      hon.publish_saas_catalog(text,uuid,uuid,uuid,uuid), hon.read_saas_founder_reservations_from_hq(text,text),
      hon.reserve_saas_founder_offer(text,jsonb,uuid,uuid,uuid), hon.release_saas_founder_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_subscriptions_from_hq(text,text), hon.read_saas_organization_subscription_from_hq(text,uuid),
      hon.record_saas_subscription(text,jsonb,uuid,uuid,uuid), hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
-- End HON subscription catalog exact reconciliation.

-- HON invoices and payment evidence (B2) exact reconciliation (supersedes the B1 grant list):
DO $$ DECLARE r text; f text; BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND p.proname ~ 'saas' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_catalog_from_hq(text), hon.create_saas_catalog_draft(text,jsonb,uuid,uuid,uuid),
      hon.publish_saas_catalog(text,uuid,uuid,uuid,uuid), hon.read_saas_founder_reservations_from_hq(text,text),
      hon.reserve_saas_founder_offer(text,jsonb,uuid,uuid,uuid), hon.release_saas_founder_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_subscriptions_from_hq(text,text), hon.read_saas_organization_subscription_from_hq(text,uuid),
      hon.record_saas_subscription(text,jsonb,uuid,uuid,uuid), hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_invoices_from_hq(text,text), hon.read_saas_invoice_from_hq(text,uuid), hon.read_saas_payment_standing_from_hq(text,uuid),
      hon.create_saas_invoice_draft(text,jsonb,uuid,uuid,uuid), hon.command_saas_invoice(text,uuid,jsonb,uuid,uuid,uuid),
      hon.record_saas_payment_evidence(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
-- End HON invoices and payment evidence exact reconciliation.

-- HON premium credit accounting (B3) exact reconciliation (supersedes the B1/B2 grant lists):
DO $$ DECLARE r text; f text; BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND p.proname ~ 'saas' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_catalog_from_hq(text), hon.create_saas_catalog_draft(text,jsonb,uuid,uuid,uuid),
      hon.publish_saas_catalog(text,uuid,uuid,uuid,uuid), hon.read_saas_founder_reservations_from_hq(text,text),
      hon.reserve_saas_founder_offer(text,jsonb,uuid,uuid,uuid), hon.release_saas_founder_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_subscriptions_from_hq(text,text), hon.read_saas_organization_subscription_from_hq(text,uuid),
      hon.record_saas_subscription(text,jsonb,uuid,uuid,uuid), hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_invoices_from_hq(text,text), hon.read_saas_invoice_from_hq(text,uuid), hon.read_saas_payment_standing_from_hq(text,uuid),
      hon.create_saas_invoice_draft(text,jsonb,uuid,uuid,uuid), hon.command_saas_invoice(text,uuid,jsonb,uuid,uuid,uuid),
      hon.record_saas_payment_evidence(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_credit_program_from_hq(text), hon.read_saas_organization_credits_from_hq(text,uuid),
      hon.set_saas_credit_program(text,jsonb,uuid,uuid,uuid), hon.record_saas_provider_cost_evidence(text,jsonb,uuid,uuid,uuid),
      hon.create_saas_pricing_draft(text,jsonb,uuid,uuid,uuid), hon.publish_saas_pricing(text,uuid,uuid,uuid,uuid),
      hon.command_saas_credit_allowance(text,jsonb,uuid,uuid,uuid), hon.read_saas_school_credits(text,uuid),
      hon.estimate_saas_premium_operation(text,uuid,text,integer), hon.reserve_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid),
      hon.settle_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_credit_reservation(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
-- End HON premium credit accounting exact reconciliation.

-- HON refunds and Champions reward application (B4) exact reconciliation (supersedes the B1-B3 grant lists):
DO $$ DECLARE r text; f text; BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND p.proname ~ 'saas' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_catalog_from_hq(text), hon.create_saas_catalog_draft(text,jsonb,uuid,uuid,uuid),
      hon.publish_saas_catalog(text,uuid,uuid,uuid,uuid), hon.read_saas_founder_reservations_from_hq(text,text),
      hon.reserve_saas_founder_offer(text,jsonb,uuid,uuid,uuid), hon.release_saas_founder_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_subscriptions_from_hq(text,text), hon.read_saas_organization_subscription_from_hq(text,uuid),
      hon.record_saas_subscription(text,jsonb,uuid,uuid,uuid), hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_invoices_from_hq(text,text), hon.read_saas_invoice_from_hq(text,uuid), hon.read_saas_payment_standing_from_hq(text,uuid),
      hon.create_saas_invoice_draft(text,jsonb,uuid,uuid,uuid), hon.command_saas_invoice(text,uuid,jsonb,uuid,uuid,uuid),
      hon.record_saas_payment_evidence(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_credit_program_from_hq(text), hon.read_saas_organization_credits_from_hq(text,uuid),
      hon.set_saas_credit_program(text,jsonb,uuid,uuid,uuid), hon.record_saas_provider_cost_evidence(text,jsonb,uuid,uuid,uuid),
      hon.create_saas_pricing_draft(text,jsonb,uuid,uuid,uuid), hon.publish_saas_pricing(text,uuid,uuid,uuid,uuid),
      hon.command_saas_credit_allowance(text,jsonb,uuid,uuid,uuid), hon.read_saas_school_credits(text,uuid),
      hon.estimate_saas_premium_operation(text,uuid,text,integer), hon.reserve_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid),
      hon.settle_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_credit_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_refund_eligibility_from_hq(text,uuid,timestamptz), hon.read_saas_refund_requests_from_hq(text,text),
      hon.read_saas_refund_reserve_from_hq(text), hon.create_saas_refund_request(text,jsonb,uuid,uuid,uuid),
      hon.decide_saas_refund_request(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_reward_preview_from_hq(text,uuid),
      hon.read_saas_referral_alerts_from_hq(text,text), hon.set_saas_reward_fulfillment(text,jsonb,uuid,uuid,uuid),
      hon.apply_saas_referral_reward(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_credit_application_preview(text,uuid),
      hon.apply_saas_account_credit(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_referral_alert(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
-- End HON refunds and Champions reward application exact reconciliation.

-- HON payment provider integration, test mode (B5) exact reconciliation (supersedes the B1-B4 grant lists):
DO $$ DECLARE r text; f text; BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND p.proname ~ 'saas' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_catalog_from_hq(text), hon.create_saas_catalog_draft(text,jsonb,uuid,uuid,uuid),
      hon.publish_saas_catalog(text,uuid,uuid,uuid,uuid), hon.read_saas_founder_reservations_from_hq(text,text),
      hon.reserve_saas_founder_offer(text,jsonb,uuid,uuid,uuid), hon.release_saas_founder_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_subscriptions_from_hq(text,text), hon.read_saas_organization_subscription_from_hq(text,uuid),
      hon.record_saas_subscription(text,jsonb,uuid,uuid,uuid), hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_invoices_from_hq(text,text), hon.read_saas_invoice_from_hq(text,uuid), hon.read_saas_payment_standing_from_hq(text,uuid),
      hon.create_saas_invoice_draft(text,jsonb,uuid,uuid,uuid), hon.command_saas_invoice(text,uuid,jsonb,uuid,uuid,uuid),
      hon.record_saas_payment_evidence(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_credit_program_from_hq(text), hon.read_saas_organization_credits_from_hq(text,uuid),
      hon.set_saas_credit_program(text,jsonb,uuid,uuid,uuid), hon.record_saas_provider_cost_evidence(text,jsonb,uuid,uuid,uuid),
      hon.create_saas_pricing_draft(text,jsonb,uuid,uuid,uuid), hon.publish_saas_pricing(text,uuid,uuid,uuid,uuid),
      hon.command_saas_credit_allowance(text,jsonb,uuid,uuid,uuid), hon.read_saas_school_credits(text,uuid),
      hon.estimate_saas_premium_operation(text,uuid,text,integer), hon.reserve_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid),
      hon.settle_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_credit_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_refund_eligibility_from_hq(text,uuid,timestamptz), hon.read_saas_refund_requests_from_hq(text,text),
      hon.read_saas_refund_reserve_from_hq(text), hon.create_saas_refund_request(text,jsonb,uuid,uuid,uuid),
      hon.decide_saas_refund_request(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_reward_preview_from_hq(text,uuid),
      hon.read_saas_referral_alerts_from_hq(text,text), hon.set_saas_reward_fulfillment(text,jsonb,uuid,uuid,uuid),
      hon.apply_saas_referral_reward(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_credit_application_preview(text,uuid),
      hon.apply_saas_account_credit(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_referral_alert(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_payments_from_hq(text), hon.read_saas_school_plan_options(text,uuid), hon.set_saas_payment_program(text,jsonb,uuid,uuid,uuid),
      hon.create_saas_checkout_from_school(text,uuid,jsonb,uuid,uuid,uuid), hon.create_saas_checkout_from_hq(text,jsonb,uuid,uuid,uuid),
      hon.attach_saas_checkout_session(text,uuid,jsonb,uuid,uuid,uuid), hon.cancel_saas_checkout(text,uuid,jsonb,uuid,uuid,uuid),
      hon.sweep_saas_checkouts(text,uuid,uuid,uuid), hon.ingest_saas_provider_event(jsonb,text) TO hon_runtime;
  END IF;
END $$;
-- End HON payment provider integration exact reconciliation.

-- HON school billing reads and paid-access foundation (B5.1) exact reconciliation (supersedes the B1-B5 grant lists):
DO $$ DECLARE r text; f text; BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND p.proname ~ 'saas' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_catalog_from_hq(text), hon.create_saas_catalog_draft(text,jsonb,uuid,uuid,uuid),
      hon.publish_saas_catalog(text,uuid,uuid,uuid,uuid), hon.read_saas_founder_reservations_from_hq(text,text),
      hon.reserve_saas_founder_offer(text,jsonb,uuid,uuid,uuid), hon.release_saas_founder_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_subscriptions_from_hq(text,text), hon.read_saas_organization_subscription_from_hq(text,uuid),
      hon.record_saas_subscription(text,jsonb,uuid,uuid,uuid), hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_invoices_from_hq(text,text), hon.read_saas_invoice_from_hq(text,uuid), hon.read_saas_payment_standing_from_hq(text,uuid),
      hon.create_saas_invoice_draft(text,jsonb,uuid,uuid,uuid), hon.command_saas_invoice(text,uuid,jsonb,uuid,uuid,uuid),
      hon.record_saas_payment_evidence(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_credit_program_from_hq(text), hon.read_saas_organization_credits_from_hq(text,uuid),
      hon.set_saas_credit_program(text,jsonb,uuid,uuid,uuid), hon.record_saas_provider_cost_evidence(text,jsonb,uuid,uuid,uuid),
      hon.create_saas_pricing_draft(text,jsonb,uuid,uuid,uuid), hon.publish_saas_pricing(text,uuid,uuid,uuid,uuid),
      hon.command_saas_credit_allowance(text,jsonb,uuid,uuid,uuid), hon.read_saas_school_credits(text,uuid),
      hon.estimate_saas_premium_operation(text,uuid,text,integer), hon.reserve_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid),
      hon.settle_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_credit_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_refund_eligibility_from_hq(text,uuid,timestamptz), hon.read_saas_refund_requests_from_hq(text,text),
      hon.read_saas_refund_reserve_from_hq(text), hon.create_saas_refund_request(text,jsonb,uuid,uuid,uuid),
      hon.decide_saas_refund_request(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_reward_preview_from_hq(text,uuid),
      hon.read_saas_referral_alerts_from_hq(text,text), hon.set_saas_reward_fulfillment(text,jsonb,uuid,uuid,uuid),
      hon.apply_saas_referral_reward(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_credit_application_preview(text,uuid),
      hon.apply_saas_account_credit(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_referral_alert(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_payments_from_hq(text), hon.read_saas_school_plan_options(text,uuid), hon.set_saas_payment_program(text,jsonb,uuid,uuid,uuid),
      hon.create_saas_checkout_from_school(text,uuid,jsonb,uuid,uuid,uuid), hon.create_saas_checkout_from_hq(text,jsonb,uuid,uuid,uuid),
      hon.attach_saas_checkout_session(text,uuid,jsonb,uuid,uuid,uuid), hon.cancel_saas_checkout(text,uuid,jsonb,uuid,uuid,uuid),
      hon.sweep_saas_checkouts(text,uuid,uuid,uuid), hon.ingest_saas_provider_event(jsonb,text),
      hon.read_saas_school_invoices(text,uuid,text,text,timestamptz,uuid,integer), hon.read_saas_school_invoice(text,uuid,uuid),
      hon.read_saas_school_billing_account(text,uuid), hon.read_saas_access_readiness_from_hq(text,uuid) TO hon_runtime;
  END IF;
END $$;
-- End HON school billing reads exact reconciliation.

-- Interface language persistence (0171) exact reconciliation.
DO $$ DECLARE r text; f text; BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND p.proname ~ 'language' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_my_language_preference(text,uuid), hon.set_my_language_preference(text,jsonb,uuid,uuid,uuid),
      hon.read_school_language_default(text,uuid), hon.set_school_language_default(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
-- End interface language persistence exact reconciliation.

-- HON paid-access B6A first-payment activation (0172) exact reconciliation (supersedes the B5.1 grant list):
DO $$ DECLARE r text; f text; BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND p.proname ~ 'saas' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_catalog_from_hq(text), hon.create_saas_catalog_draft(text,jsonb,uuid,uuid,uuid),
      hon.publish_saas_catalog(text,uuid,uuid,uuid,uuid), hon.read_saas_founder_reservations_from_hq(text,text),
      hon.reserve_saas_founder_offer(text,jsonb,uuid,uuid,uuid), hon.release_saas_founder_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_subscriptions_from_hq(text,text), hon.read_saas_organization_subscription_from_hq(text,uuid),
      hon.record_saas_subscription(text,jsonb,uuid,uuid,uuid), hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_invoices_from_hq(text,text), hon.read_saas_invoice_from_hq(text,uuid), hon.read_saas_payment_standing_from_hq(text,uuid),
      hon.create_saas_invoice_draft(text,jsonb,uuid,uuid,uuid), hon.command_saas_invoice(text,uuid,jsonb,uuid,uuid,uuid),
      hon.record_saas_payment_evidence(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_credit_program_from_hq(text), hon.read_saas_organization_credits_from_hq(text,uuid),
      hon.set_saas_credit_program(text,jsonb,uuid,uuid,uuid), hon.record_saas_provider_cost_evidence(text,jsonb,uuid,uuid,uuid),
      hon.create_saas_pricing_draft(text,jsonb,uuid,uuid,uuid), hon.publish_saas_pricing(text,uuid,uuid,uuid,uuid),
      hon.command_saas_credit_allowance(text,jsonb,uuid,uuid,uuid), hon.read_saas_school_credits(text,uuid),
      hon.estimate_saas_premium_operation(text,uuid,text,integer), hon.reserve_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid),
      hon.settle_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_credit_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_refund_eligibility_from_hq(text,uuid,timestamptz), hon.read_saas_refund_requests_from_hq(text,text),
      hon.read_saas_refund_reserve_from_hq(text), hon.create_saas_refund_request(text,jsonb,uuid,uuid,uuid),
      hon.decide_saas_refund_request(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_reward_preview_from_hq(text,uuid),
      hon.read_saas_referral_alerts_from_hq(text,text), hon.set_saas_reward_fulfillment(text,jsonb,uuid,uuid,uuid),
      hon.apply_saas_referral_reward(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_credit_application_preview(text,uuid),
      hon.apply_saas_account_credit(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_referral_alert(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_payments_from_hq(text), hon.read_saas_school_plan_options(text,uuid), hon.set_saas_payment_program(text,jsonb,uuid,uuid,uuid),
      hon.create_saas_checkout_from_school(text,uuid,jsonb,uuid,uuid,uuid), hon.create_saas_checkout_from_hq(text,jsonb,uuid,uuid,uuid),
      hon.attach_saas_checkout_session(text,uuid,jsonb,uuid,uuid,uuid), hon.cancel_saas_checkout(text,uuid,jsonb,uuid,uuid,uuid),
      hon.sweep_saas_checkouts(text,uuid,uuid,uuid), hon.ingest_saas_provider_event(jsonb,text),
      hon.read_saas_school_invoices(text,uuid,text,text,timestamptz,uuid,integer), hon.read_saas_school_invoice(text,uuid,uuid),
      hon.read_saas_school_billing_account(text,uuid), hon.read_saas_access_readiness_from_hq(text,uuid),
      hon.read_saas_organization_access_from_hq(text,uuid), hon.place_saas_organization_awaiting_payment(text,uuid,jsonb,uuid,uuid,uuid),
      hon.retry_saas_first_payment_activation(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
-- End HON paid-access B6A exact reconciliation.

-- HON OS commercial offers (0181) exact reconciliation: three private deny-all tables, private helpers and eight runtime
-- entry points (HQ offer management reads and owner commands, and the school purchaser discovery read).
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_offer_sets','saas_offer_set_offers','saas_offer_sales_stops'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_saas_offer_sets()','hon.guard_saas_offer_set_offers()','hon.saas_hon_os_product_json()',
      'hon.saas_offer_json(hon.saas_offer_set_offers)','hon.saas_offer_set_json(uuid)','hon.saas_offer_set_preview(uuid)',
      'hon.saas_offer_set_content_valid(jsonb)','hon.saas_offer_set_write_content(uuid,jsonb)','hon.saas_offer_owner(text)',
      'hon.read_saas_offer_management_from_hq(text)','hon.read_saas_offer_set_from_hq(text,uuid)',
      'hon.create_saas_offer_set_draft(text,jsonb,uuid,uuid,uuid)','hon.revise_saas_offer_set_draft(text,uuid,jsonb,uuid,uuid,uuid)',
      'hon.discard_saas_offer_set_draft(text,uuid,jsonb,uuid,uuid,uuid)','hon.publish_saas_offer_set(text,uuid,jsonb,uuid,uuid,uuid)',
      'hon.stop_saas_offer_sales(text,uuid,jsonb,uuid,uuid,uuid)','hon.read_saas_hon_os_offers_for_school(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_offer_management_from_hq(text), hon.read_saas_offer_set_from_hq(text,uuid),
      hon.create_saas_offer_set_draft(text,jsonb,uuid,uuid,uuid), hon.revise_saas_offer_set_draft(text,uuid,jsonb,uuid,uuid,uuid),
      hon.discard_saas_offer_set_draft(text,uuid,jsonb,uuid,uuid,uuid), hon.publish_saas_offer_set(text,uuid,jsonb,uuid,uuid,uuid),
      hon.stop_saas_offer_sales(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_hon_os_offers_for_school(text,uuid) TO hon_runtime;
  END IF;
END $$;
-- End HON OS commercial offers exact reconciliation.

-- HON OS purchase binding (0182) exact reconciliation: private purchase helpers and one runtime entry point (the school
-- purchaser's test-mode HON OS checkout). The purchase columns live in already private deny-all tables.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.saas_hon_os_billing_interval(text)','hon.saas_hon_os_recurring(hon.saas_offer_set_offers)',
      'hon.saas_hon_os_offer_on_sale(hon.saas_offer_set_offers,timestamptz)','hon.saas_hon_os_accepted_offer(hon.saas_offer_set_offers)',
      'hon.saas_hon_os_digest(jsonb)','hon.saas_hon_os_offer_usage(uuid,timestamptz,uuid)','hon.saas_hon_os_founder_usage(timestamptz,uuid)',
      'hon.saas_hon_os_refusal(uuid,hon.saas_offer_set_offers,timestamptz)','hon.saas_open_hon_os_checkout(uuid,uuid,uuid,uuid,timestamptz)',
      'hon.saas_hon_os_purchase_json(hon.saas_checkout_sessions)','hon.create_saas_hon_os_checkout_from_school(text,uuid,jsonb,uuid,uuid,uuid)',
      'hon.saas_activate_hon_os_checkout(uuid,jsonb,timestamptz)','hon.saas_planned_monthly_credits(hon.saas_subscriptions)',
      'hon.saas_refund_window_hours(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_saas_hon_os_checkout_from_school(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
-- End HON OS purchase binding exact reconciliation.

-- HON OS new-school onboarding (0183) exact reconciliation: the registration initializer and the HON OS activation core
-- are private (no runtime role may execute them). Replaced functions keep their existing grants.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.initialize_saas_hon_os_school_account(text,jsonb,uuid,uuid,uuid)',
      'hon.saas_activate_hon_os_checkout_core(uuid,jsonb,timestamptz,boolean)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
END $$;
-- End HON OS new-school onboarding exact reconciliation.

-- HON OS-only new sales (0184, owner decision D8) exact reconciliation: the pinned new-sales policy is a private deny-all
-- table, and its read helper and the legacy new-sale guard are private. Replaced functions keep their existing grants.
DO $$ DECLARE r text; col text; f text; BEGIN
  ALTER TABLE hon.saas_new_sales_policy ENABLE ROW LEVEL SECURITY;
  ALTER TABLE hon.saas_new_sales_policy FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE hon.saas_new_sales_policy FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.saas_new_sales_policy FROM %I',r);
  END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='hon.saas_new_sales_policy'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.saas_new_sales_policy FROM PUBLIC',col);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.saas_new_sales_policy FROM %I',col,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.saas_legacy_new_sales_open()','hon.guard_saas_legacy_new_sale()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
END $$;
-- End HON OS-only new sales exact reconciliation.

-- Secure HQ school provisioning (0185, owner decision D9) exact reconciliation: the HQ-owner access exception table is a
-- private deny-all table; its guards and helpers are private; only the four HQ commands and read are runtime-callable.
-- Replaced functions (provisioning, the HQ tier transition, HON OS refusal and offers read, B6A place-awaiting and the
-- Champions contest counts) keep their existing grants; the awaiting-state exception guard is private.
DO $$ DECLARE r text; col text; f text; BEGIN
  ALTER TABLE hon.saas_access_exceptions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE hon.saas_access_exceptions FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE hon.saas_access_exceptions FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.saas_access_exceptions FROM %I',r);
  END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='hon.saas_access_exceptions'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.saas_access_exceptions FROM PUBLIC',col);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.saas_access_exceptions FROM %I',col,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_saas_access_exceptions()','hon.guard_saas_access_exception_grant()','hon.guard_saas_access_state_exception()',
    'hon.saas_access_exception_live(uuid)',
    'hon.saas_access_exception_json(hon.saas_access_exceptions)','hon.saas_end_access_exception(uuid,text,text,uuid,timestamp with time zone)',
    'hon.grant_saas_access_exception(text,uuid,jsonb,uuid,uuid,uuid)','hon.revoke_saas_access_exception(text,uuid,jsonb,uuid,uuid,uuid)',
    'hon.close_expired_saas_access_exceptions(text,uuid,uuid,uuid)','hon.read_saas_access_exceptions_from_hq(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  GRANT EXECUTE ON FUNCTION hon.grant_saas_access_exception(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  GRANT EXECUTE ON FUNCTION hon.revoke_saas_access_exception(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  GRANT EXECUTE ON FUNCTION hon.close_expired_saas_access_exceptions(text,uuid,uuid,uuid) TO hon_runtime;
  GRANT EXECUTE ON FUNCTION hon.read_saas_access_exceptions_from_hq(text,uuid) TO hon_runtime;
END $$;
-- End secure HQ school provisioning exact reconciliation.

-- D10 exception-only policy: exact private-table/function privilege reconciliation.
DO $$ DECLARE r text; c text; f text; BEGIN
  ALTER TABLE hon.saas_exception_policy_decisions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE hon.saas_exception_policy_decisions FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE hon.saas_exception_policy_decisions FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.saas_exception_policy_decisions FROM %I',r);
  END LOOP;
  FOR c IN SELECT attname FROM pg_attribute WHERE attrelid='hon.saas_exception_policy_decisions'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.saas_exception_policy_decisions FROM PUBLIC',c);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.saas_exception_policy_decisions FROM %I',c,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_saas_exception_policy_decision()','hon.verify_saas_exception_policy_evidence()','hon.verify_saas_exception_policy_binding()','hon.saas_exception_policy_json(hon.saas_exception_policy_decisions)','hon.saas_require_exception_policy()','hon.decide_saas_exception_policy(text,jsonb,uuid,uuid,uuid)','hon.read_saas_exception_policy(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.decide_saas_exception_policy(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_saas_exception_policy(text) TO hon_runtime;
  END IF;
END $$;

-- D11-A customer trial governance: metadata only; no activation endpoint.

-- Exact private table/column/function ACLs. No public/signup/activation or issuance function exists.
DO $$ DECLARE r text;t text;c text;f text;BEGIN
 FOREACH t IN ARRAY ARRAY['saas_trial_program','saas_trial_policy_versions','saas_trial_policy_decisions','saas_trial_campaign_versions','saas_trial_publications'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);END LOOP;
  FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
   FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r);END LOOP;
  END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['hon.saas_trial_keys(jsonb,text[])','hon.saas_trial_uint(jsonb,bigint,bigint)','hon.saas_trial_choices(jsonb,jsonb)','hon.saas_trial_timestamp(jsonb)','hon.saas_trial_policy_valid(jsonb)','hon.saas_trial_campaign_valid(jsonb)','hon.saas_trial_policy_json(hon.saas_trial_policy_versions)','hon.saas_trial_decision_json(hon.saas_trial_policy_decisions)','hon.saas_trial_campaign_json(hon.saas_trial_campaign_versions)','hon.saas_trial_publication_json(hon.saas_trial_publications)','hon.saas_trial_begin(text,uuid,text,jsonb,uuid,uuid)','hon.saas_trial_preview(uuid)','hon.propose_saas_trial_policy(text,jsonb,uuid,uuid,uuid)','hon.decide_saas_trial_policy(text,jsonb,uuid,uuid,uuid)','hon.draft_saas_trial_campaign(text,jsonb,uuid,uuid,uuid)','hon.publish_saas_trial_campaign(text,uuid,jsonb,uuid,uuid,uuid)','hon.withdraw_saas_trial_campaign(text,uuid,jsonb,uuid,uuid,uuid)','hon.guard_saas_trial_insert()','hon.verify_saas_trial_evidence()','hon.read_saas_trial_governance(text)','hon.read_saas_trial_campaign(text,uuid)','hon.preview_saas_trial_publication(text,uuid)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
 GRANT EXECUTE ON FUNCTION hon.propose_saas_trial_policy(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.decide_saas_trial_policy(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.draft_saas_trial_campaign(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.publish_saas_trial_campaign(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.withdraw_saas_trial_campaign(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.read_saas_trial_governance(text) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.read_saas_trial_campaign(text,uuid) TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.preview_saas_trial_publication(text,uuid) TO hon_runtime;
 END IF;
END $$;

-- Commercial A2 exact private-table/function reconciliation (0188). No provider or activation authority.
DO $$ DECLARE r text;t text;c text;f text;BEGIN
 FOREACH t IN ARRAY ARRAY['saas_price_schedules','saas_price_acceptances'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
   FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
  END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['hon.saas_price_usd(integer)','hon.saas_price_content(uuid,uuid)',
  'hon.saas_price_schedule_json(hon.saas_price_schedules)','hon.saas_price_acceptance_json(hon.saas_price_acceptances)',
  'hon.saas_price_lock_authority()','hon.record_saas_price_schedule(text,jsonb,uuid,uuid,uuid)',
  'hon.saas_price_acceptance_preview(uuid,uuid,uuid)','hon.preview_saas_price_acceptance(text,uuid,uuid)',
  'hon.accept_saas_price_schedule(text,uuid,jsonb,uuid,uuid,uuid)','hon.read_saas_price_schedule(text,uuid)',
  'hon.read_saas_price_acceptance(text,uuid,uuid)','hon.guard_saas_price_insert()','hon.verify_saas_price_evidence()',
  'hon.guard_saas_price_provider_boundary()'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.record_saas_price_schedule(text,jsonb,uuid,uuid,uuid),hon.preview_saas_price_acceptance(text,uuid,uuid),
   hon.accept_saas_price_schedule(text,uuid,jsonb,uuid,uuid,uuid),hon.read_saas_price_schedule(text,uuid),hon.read_saas_price_acceptance(text,uuid,uuid) TO hon_runtime;
 END IF;
END $$;

-- Commercial B1 0189 private intent only. Never provider or payment authority.
DO $$ DECLARE r text;c text;f text; BEGIN
 REVOKE ALL ON TABLE hon.saas_subscription_generations FROM PUBLIC;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.saas_subscription_generations FROM %I',r); END LOOP;
 FOR c IN SELECT attname FROM pg_attribute WHERE attrelid='hon.saas_subscription_generations'::regclass AND attnum>0 AND NOT attisdropped LOOP
  EXECUTE format('REVOKE ALL (%I) ON hon.saas_subscription_generations FROM PUBLIC',c);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.saas_subscription_generations FROM %I',c,r); END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['hon.saas_generation_lock_authority()','hon.saas_generation_content(uuid,uuid)','hon.saas_generation_json(hon.saas_subscription_generations)',
  'hon.saas_generation_available(uuid)','hon.record_saas_subscription_generation(text,uuid,jsonb,uuid,uuid,uuid)',
  'hon.read_saas_subscription_generation(text,uuid,uuid)','hon.read_saas_subscription_generation_from_hq(text,uuid)',
  'hon.guard_saas_generation_insert()','hon.verify_saas_generation_evidence()'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.record_saas_subscription_generation(text,uuid,jsonb,uuid,uuid,uuid),
   hon.read_saas_subscription_generation(text,uuid,uuid),hon.read_saas_subscription_generation_from_hq(text,uuid) TO hon_runtime;
 END IF;
END $$;


-- A2P-1 read-only preparation scope (0190): no new table or provider grants.
DO $$ DECLARE r text; BEGIN
 IF to_regprocedure('hon.read_a2p_preparation_scope(text)') IS NULL THEN RAISE EXCEPTION 'Apply A2P-1 migration 0190 first'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','hon_outbox_worker','hon_runtime'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON FUNCTION hon.read_a2p_preparation_scope(text) FROM %I',r); END IF;
 END LOOP;
 REVOKE ALL ON FUNCTION hon.read_a2p_preparation_scope(text) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION hon.read_a2p_preparation_scope(text) TO hon_runtime;
END $$;

-- P0-1 0191 private school account custody and fixed function grants.
DO $$ DECLARE t text; r text; f text; c text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_owner_invitations','school_account_requests','school_account_events'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['guard_school_account_evidence()','guard_school_owner_invitation()','lock_school_account_authority()',
    'check_school_owner_acceptance(text,text,jsonb,uuid)',
    'school_invitation_json(hon.school_owner_invitations)','school_account_result(hon.school_owner_invitations)',
    'school_account_record(text,uuid,text,uuid,text,jsonb)','manage_school_owner_invitation(text,text,jsonb,uuid)',
    'accept_school_owner_invitation(text,text,jsonb,uuid)','read_school_owner_invitations(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.manage_school_owner_invitation(text,text,jsonb,uuid),hon.accept_school_owner_invitation(text,text,jsonb,uuid),hon.read_school_owner_invitations(text,uuid) TO hon_runtime;
  END IF;
END $$;

-- 0192 owner CRM suspension policy: verified-owner read-only authority and the in-app access standing read are the
-- only runtime entry points; the window helper stays private. Earlier saas blocks revoke every saas function, so the
-- standing read is re-granted here.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['crm_owner_read_only_window(uuid)','authorize_crm_owner_read_only(text,uuid,text,uuid,uuid)',
    'read_saas_school_access_standing(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.authorize_crm_owner_read_only(text,uuid,text,uuid,uuid), hon.read_saas_school_access_standing(text,uuid) TO hon_runtime;
  END IF;
END $$;

-- 0147 current-school Class Sessions read: the blanket function revoke near the top of this script removes 0147's
-- EXECUTE grant, so re-grant exactly that one named SECURITY DEFINER projection. Its private authority helper, PUBLIC
-- and client roles stay revoked. No table, column, helper or grant-option privilege is added here.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['require_current_school_class_sessions_read_actor(text)','read_current_school_class_sessions(text)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_current_school_class_sessions(text) TO hon_runtime;
  END IF;
END $$;

-- S4-a 0193 durable AI usage evidence: evidence-only actor stays internal; payload read and hold are fixed runtime boundaries.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['ai_evidence_actor(text)','read_marketing_result_payload(text,uuid)','hold_marketing_result(text,uuid)',
    'read_teaching_result_payload(text,uuid)','hold_teaching_result(text,uuid)',
    'read_chad_follow_up_result_payload(text,uuid)','hold_chad_follow_up_result(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_marketing_result_payload(text,uuid),hon.hold_marketing_result(text,uuid),
      hon.read_teaching_result_payload(text,uuid),hon.hold_teaching_result(text,uuid),
      hon.read_chad_follow_up_result_payload(text,uuid),hon.hold_chad_follow_up_result(text,uuid) TO hon_runtime;
  END IF;
END $$;

-- S4-b 0194 organization agent budget: window, ceiling, committed sum, lock and reserve guard stay internal (no runtime grant).
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['ai_spend_window(uuid,timestamptz)','ai_org_ceiling(uuid,timestamptz)','ai_org_committed_credits(uuid,timestamptz)',
    'ai_budget_lock(uuid)','ai_spend_reserve_guard()'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
END $$;

-- S4-c 0195 AI access decision: decision, hooks and guards stay internal; only the HQ pause command and read are runtime boundaries.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['guard_ai_spend_pauses()','guard_ai_spend_pause_commands()','ai_promotional_access(uuid,timestamptz,text)','ai_trial_funding_available(uuid,timestamptz,text)',
    'ai_access_state_decision(text,boolean,boolean)','ai_spend_allowed(uuid,timestamptz,text)','ai_spend_start_guard()','ai_spend_b3_guard()',
    'command_ai_spend_pause(text,jsonb,uuid)','read_ai_spend_pauses_from_hq(text)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  REVOKE ALL ON TABLE hon.ai_spend_pauses FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON TABLE hon.ai_spend_pauses FROM '||quote_ident(r); END LOOP;
  REVOKE ALL ON TABLE hon.ai_spend_pause_commands FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON TABLE hon.ai_spend_pause_commands FROM '||quote_ident(r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.command_ai_spend_pause(text,jsonb,uuid), hon.read_ai_spend_pauses_from_hq(text) TO hon_runtime;
  END IF;
END $$;

-- S4-d 0196 UNKNOWN resolution: counting and validation stay internal; only the HQ resolve command and queue read are runtime boundaries.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['ai_sending_stale_after()','ai_hold_counts(text,timestamptz,tstzrange,timestamptz)','ai_org_committed_credits(uuid,timestamptz)',
    'guard_ai_unknown_resolutions()','ai_unknown_receipt(hon.ai_unknown_resolutions,boolean)','ai_unknown_validate(text,jsonb)',
    'resolve_ai_unknown_invocation(text,text,uuid,jsonb,uuid,uuid,uuid)','read_ai_unknown_invocations_from_hq(text)',
    'ai_stamp_hold_origin()','ai_late_expense_receipt(hon.ai_late_provider_expenses,boolean)','record_ai_late_provider_expense(text,text,uuid,jsonb,uuid,uuid,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  REVOKE ALL ON TABLE hon.ai_unknown_resolutions FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON TABLE hon.ai_unknown_resolutions FROM '||quote_ident(r); END LOOP;
  REVOKE ALL ON TABLE hon.ai_late_provider_expenses FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON TABLE hon.ai_late_provider_expenses FROM '||quote_ident(r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.resolve_ai_unknown_invocation(text,text,uuid,jsonb,uuid,uuid,uuid), hon.read_ai_unknown_invocations_from_hq(text),
      hon.record_ai_late_provider_expense(text,text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

-- S4-e 0197 HQ per-school AI usage: the HQ read is the only runtime boundary (it reads the ledger as definer).
DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.read_ai_school_usage_from_hq(text,timestamptz,timestamptz) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.read_ai_school_usage_from_hq(text,timestamptz,timestamptz) FROM '||quote_ident(r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_ai_school_usage_from_hq(text,timestamptz,timestamptz) TO hon_runtime;
  END IF;
END $$;

-- AI-R1 0198 AI team readiness: the route helper stays internal; only the tenant readiness read is a runtime boundary.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['ai_team_route(uuid,uuid,bigint,bigint)','ai_team_org_budget_authority(uuid,uuid)','read_ai_team_readiness(text)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_ai_team_readiness(text) TO hon_runtime;
  END IF;
END $$;

-- C1 0199 HON conversation delegation: conversation tables are reached only through functions; internal view helpers stay private.
DO $$ DECLARE r text; f text; BEGIN
  REVOKE ALL ON TABLE hon.hon_conversations, hon.hon_conversation_turns FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON TABLE hon.hon_conversations, hon.hon_conversation_turns FROM '||quote_ident(r); END LOOP;
  FOREACH f IN ARRAY ARRAY['hon_conversation_actor(text)','hon_turn_view(hon.hon_conversation_turns)','hon_conversation_summary(hon.hon_conversations)',
      'begin_hon_conversation(text,jsonb,uuid)','list_my_hon_conversations(text,timestamptz,uuid,integer)','read_hon_conversation(text,uuid)',
      'begin_hon_turn(text,uuid,jsonb,uuid)','fail_hon_turn(text,uuid,text)','read_hon_turn_receipt(text,uuid)',
      'hon_conversation_hold_actor(text,uuid)','hon_turn_bind_specialist()','hon_canonical_request_text(text)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_hon_conversation(text,jsonb,uuid), hon.list_my_hon_conversations(text,timestamptz,uuid,integer),
      hon.read_hon_conversation(text,uuid), hon.begin_hon_turn(text,uuid,jsonb,uuid), hon.fail_hon_turn(text,uuid,text), hon.read_hon_turn_receipt(text,uuid) TO hon_runtime;
  END IF;
END $$;

-- D-M1 0200 CRM lead membership discovery: one direct-human read; no table access.
DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.read_crm_lead_memberships(text,uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.read_crm_lead_memberships(text,uuid) FROM '||quote_ident(r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_crm_lead_memberships(text,uuid) TO hon_runtime;
  END IF;
END $$;

-- CW1 0202 HON OS creative credit wallet: private deny-all tables; HQ and school commands/reads are the only runtime
-- entry points. Internal helpers and the top-up fulfillment contract stay private (fulfillment is not wired to any
-- webhook). Earlier saas blocks revoke every saas function, so the runtime entry points are granted here.
DO $$ DECLARE t text; r text; f text; c text; BEGIN
  IF to_regprocedure('hon.reserve_saas_creative_credits(text,uuid,jsonb,uuid,uuid,uuid)') IS NULL THEN RAISE EXCEPTION 'Apply CW1 migration 0202 first'; END IF;
  IF to_regclass('hon.saas_creative_cost_events') IS NULL THEN RAISE EXCEPTION 'Apply the corrected CW1 migration 0202 first'; END IF;
  FOREACH t IN ARRAY ARRAY['saas_creative_program','saas_creative_rate_versions','saas_creative_rates','saas_creative_topup_packages','saas_creative_wallets',
    'saas_creative_topup_purchases','saas_creative_adjustments','saas_creative_lots','saas_creative_reservations','saas_creative_ledger','saas_creative_cost_events'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND p.proname ~ 'creative' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.set_saas_creative_program(text,jsonb,uuid,uuid,uuid), hon.publish_saas_creative_rates(text,jsonb,uuid,uuid,uuid),
      hon.grant_saas_creative_credits_from_hq(text,uuid,jsonb,uuid,uuid,uuid), hon.debit_saas_creative_lot_from_hq(text,uuid,jsonb,uuid,uuid,uuid),
      hon.resolve_saas_creative_reservation_from_hq(text,uuid,jsonb,uuid,uuid,uuid), hon.record_saas_creative_cost_from_hq(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_creative_wallet_from_hq(text,uuid),
      hon.read_saas_creative_wallets_from_hq(text), hon.read_saas_creative_wallet(text,uuid), hon.open_saas_creative_window(text,uuid,uuid,uuid,uuid),
      hon.reserve_saas_creative_credits(text,uuid,jsonb,uuid,uuid,uuid), hon.settle_saas_creative_credits(text,uuid,jsonb,uuid,uuid,uuid),
      hon.create_saas_creative_topup_purchase(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

-- CS1 0216 (proposed) Creative Studio generations on the CW1 school wallet: private deny-all tables, internal helpers stay
-- private (the CW1 block above revokes every creative function), four fixed runtime entry points.
DO $$ DECLARE t text; r text; c text; BEGIN
  IF to_regprocedure('hon.create_creative_generation(text,uuid,jsonb,jsonb,uuid,uuid,uuid)') IS NULL THEN RAISE EXCEPTION 'Apply CS1 migration 0216 first'; END IF;
  FOREACH t IN ARRAY ARRAY['creative_generations','creative_generation_assets'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_creative_generation(text,uuid,jsonb,jsonb,uuid,uuid,uuid), hon.record_creative_generation_result(text,uuid,jsonb),
      hon.read_creative_generations(text,uuid), hon.read_creative_generation(text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

-- 0204 (provisional) school staff invitations: private custody tables, internal helpers, three fixed runtime entry points.
DO $$ DECLARE t text; r text; f text; c text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_staff_invitations','school_staff_account_events'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['guard_school_staff_invitation()','school_staff_manager(text,uuid)','school_staff_role_grantable(uuid,uuid,uuid,uuid)',
    'school_staff_invitation_json(hon.school_staff_invitations)','school_staff_account_result(hon.school_staff_invitations)',
    'school_staff_account_record(text,uuid,text,uuid,text,jsonb)','school_staff_acceptor_conflict(text,text,hon.school_staff_invitations)',
    'manage_school_staff_invitation(text,text,jsonb,uuid)','accept_school_staff_invitation(text,text,jsonb,uuid)','read_school_staff_invitations(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.manage_school_staff_invitation(text,text,jsonb,uuid),hon.accept_school_staff_invitation(text,text,jsonb,uuid),hon.read_school_staff_invitations(text,uuid) TO hon_runtime;
  END IF;
END $$;

-- 0205 (provisional) school family access invitations: private custody tables, internal helpers, three fixed runtime entry points.
DO $$ DECLARE t text; r text; f text; c text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_family_access_invitations','school_family_account_events'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['guard_school_family_access_invitation()','school_family_access_manager(text,uuid)','school_family_access_revoker(text,uuid)','school_family_access_actor(text,uuid,text)',
    'school_family_access_invitation_json(hon.school_family_access_invitations)','school_family_account_result(hon.school_family_access_invitations)',
    'school_family_account_record(text,uuid,text,uuid,text,jsonb)','school_family_acceptor_conflict(text,text,hon.school_family_access_invitations)',
    'manage_school_family_access_invitation(text,text,jsonb,uuid)','accept_school_family_access_invitation(text,text,jsonb,uuid)','read_school_family_access_invitations(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.manage_school_family_access_invitation(text,text,jsonb,uuid),hon.accept_school_family_access_invitation(text,text,jsonb,uuid),hon.read_school_family_access_invitations(text,uuid) TO hon_runtime;
  END IF;
END $$;

-- 0207 (provisional) staff invitation role discovery: one exact-school read is the only runtime entry point.
DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.read_school_staff_invitation_roles(text,uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.read_school_staff_invitation_roles(text,uuid) FROM '||quote_ident(r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_staff_invitation_roles(text,uuid) TO hon_runtime;
  END IF;
END $$;

-- 0208 (provisional) HQ school provisioning: the expected-principal-bound function is the only runtime entry point.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hq_provisioning_actor(text)',
    'provision_school_from_hq(text,text,text,text,text,text,hon.plan_tier,text,text,uuid,uuid)',
    'provision_school_from_hq_human(text,uuid,text,text,text,text,text,hon.plan_tier,text,text,uuid,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.provision_school_from_hq_human(text,uuid,text,text,text,text,text,hon.plan_tier,text,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

-- C2 0210 (proposed) Ask HON: the reply table is reached only through functions; internal helpers stay private.
DO $$ DECLARE r text; f text; BEGIN
  IF to_regclass('hon.hon_reply_invocations') IS NULL THEN RAISE EXCEPTION 'Apply C2 migration 0210 first'; END IF;
  REVOKE ALL ON TABLE hon.hon_reply_invocations FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON TABLE hon.hon_reply_invocations FROM '||quote_ident(r); END LOOP;
  FOREACH f IN ARRAY ARRAY['hon_reply_limits(text)','hon_reply_max_steps()','hon_reply_detail(uuid,boolean)','hon_reply_access(text)','hon_reply_complete_live(uuid)','hon_reply_source_allowed(hon.hon_reply_invocations)','hon_reply_visible(text,uuid)','hon_reply_planning_reference(text,uuid)','prepare_hon_reply(text,uuid,uuid,boolean)',
      'fail_hon_reply(text,uuid,text,text)','record_hon_reply_result(text,uuid,jsonb)','release_held_hon_reply(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.hon_reply_planning_reference(text,uuid), hon.prepare_hon_reply(text,uuid,uuid,boolean), hon.fail_hon_reply(text,uuid,text,text),
      hon.record_hon_reply_result(text,uuid,jsonb), hon.release_held_hon_reply(text,uuid) TO hon_runtime;
  END IF;
END $$;

-- C3a 0214 (proposed) HON reply suggestions: the capability filter is an internal helper. No ordinary application role has
-- direct EXECUTE; trusted SECURITY DEFINER owners call it internally. The table CHECK bounds the closed set and size;
-- uniqueness of suggested agents is enforced by hon.record_hon_reply_result, not by the CHECK.
DO $$ DECLARE r text; BEGIN
  IF to_regprocedure('hon.hon_reply_allowed_suggestions(uuid,uuid,uuid,text[])') IS NULL THEN RAISE EXCEPTION 'Apply C3a migration 0214 first'; END IF;
  REVOKE ALL ON FUNCTION hon.hon_reply_allowed_suggestions(uuid,uuid,uuid,text[]) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.hon_reply_allowed_suggestions(uuid,uuid,uuid,text[]) FROM '||quote_ident(r);
  END LOOP;
END $$;

-- C3a 0215 (proposed) grouped confirmations: tables reached only through functions; one read for the runtime.
DO $$ DECLARE r text; f text; BEGIN
  IF to_regclass('hon.hon_orchestrations') IS NULL THEN RAISE EXCEPTION 'Apply C3a migration 0215 first'; END IF;
  REVOKE ALL ON TABLE hon.hon_orchestrations, hon.hon_orchestration_members FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE 'REVOKE ALL ON TABLE hon.hon_orchestrations, hon.hon_orchestration_members FROM '||quote_ident(r);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon_orchestration_immutable()','hon_orchestration_status(text[])','read_hon_orchestrations(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.read_hon_orchestrations(text,uuid) TO hon_runtime; END IF;
END $$;

-- B-CRM-1a 0217 (proposed) person record update: one read and one command are the only runtime entry points;
-- the runtime role still has no UPDATE on hon.people.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['school_person_actor(text,uuid,boolean)','school_person_json(uuid,text)','read_school_person(text,uuid,uuid)','update_school_person(text,jsonb,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_person(text,uuid,uuid),hon.update_school_person(text,jsonb,uuid) TO hon_runtime;
  END IF;
END $$;

-- B-CRM-1b 0218 (proposed) student birth date + CRM enrollment identity corrections: the birth date command is the
-- only new runtime entry point; helpers, the corrections table and the person command receipts stay private.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['crm_guardian_child_current_identity(uuid,uuid,uuid)','record_crm_guardian_child_identity_correction(uuid,uuid,uuid,uuid,uuid,text,text,date)',
    'guard_school_person_command_receipt()','school_person_is_owner(uuid,uuid)','update_school_student_birth_date(text,jsonb,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE 'REVOKE ALL ON TABLE hon.crm_guardian_child_identity_corrections FROM '||quote_ident(r);
    EXECUTE 'REVOKE ALL ON TABLE hon.school_person_command_receipts FROM '||quote_ident(r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.update_school_student_birth_date(text,jsonb,uuid) TO hon_runtime;
  END IF;
END $$;

-- B-HQ-1 0219 (proposed) HQ access overview: the HQ read is the only runtime boundary; its three helpers stay internal.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['saas_exception_policy_ready()','saas_access_overview_facts(uuid,timestamptz)','saas_access_overview_row(uuid,boolean,timestamptz)',
    'read_saas_access_overview_from_hq(text,text,timestamptz,uuid,integer)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_access_overview_from_hq(text,text,timestamptz,uuid,integer) TO hon_runtime;
  END IF;
END $$;

-- U6 0220 school-wide membership list: the one read-only definer projection is the only runtime boundary.
DO $$ DECLARE r text; BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION hon.read_school_membership_list(text,jsonb) FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.read_school_membership_list(text,jsonb) FROM '||quote_ident(r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_membership_list(text,jsonb) TO hon_runtime;
  END IF;
END $$;

-- 0221 forward-paging class-session list: the one read-only definer projection is the only runtime boundary (0147's
-- function-only session read intent).
DO $$ DECLARE r text; BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION hon.read_school_class_session_page(text,jsonb) FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.read_school_class_session_page(text,jsonb) FROM '||quote_ident(r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_class_session_page(text,jsonb) TO hon_runtime;
  END IF;
END $$;

-- B-ID-4 0223 (proposed) school ownership: the HQ-owner read, the HQ-owner command and the school-owner read
-- are the only runtime boundary; the helpers and the three private tables stay internal.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['school_owner_review_or_busy(uuid)','guard_school_primary_owner()','school_owner_grant_rows(uuid,timestamptz)','school_live_primary_grant(uuid,timestamptz)',
    'school_set_primary_owner(uuid,uuid,uuid,text,uuid,timestamptz)',
    'school_ownership_owner_json(uuid,timestamptz,uuid)','school_ownership_notices_json(uuid)',
    'read_school_ownership_from_hq(text,uuid)','manage_school_ownership(text,text,jsonb,uuid)',
    'read_school_ownership(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_ownership_from_hq(text,uuid),
      hon.manage_school_ownership(text,text,jsonb,uuid),hon.read_school_ownership(text,uuid) TO hon_runtime;
  END IF;
END $$;

-- 0224 membership pause, cancellation and manual refund records: private policy/pause/refund tables, private helpers,
-- seven runtime entry points. The runtime gains no privilege on hon.memberships or on the new tables.
DO $$ DECLARE r text; col text; t text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_membership_pause_policies','membership_pauses','membership_refund_records'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_school_membership_pause_policy_insert()','hon.guard_membership_pause()',
    'hon.membership_pause_text_ok(jsonb,boolean)','hon.membership_pause_date(jsonb)','hon.membership_school_today()',
    'hon.membership_pause_policy_json(uuid,uuid)','hon.membership_pause_json(hon.membership_pauses)','hon.membership_refund_json(hon.membership_refund_records)',
    'hon.membership_pause_begin(text,text,text,text)',
    'hon.membership_pause_finish(text,text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,text,uuid,integer,uuid,uuid)',
    'hon.membership_command_args_ok(text,text,uuid,uuid)','hon.read_school_membership_pause_policy(text)',
    'hon.set_school_membership_pause_policy(text,jsonb,text,uuid,uuid)','hon.pause_school_membership(text,uuid,jsonb,text,uuid,uuid)',
    'hon.resume_school_membership(text,uuid,jsonb,text,uuid,uuid)','hon.record_membership_refund(text,uuid,jsonb,text,uuid,uuid)',
    'hon.read_membership_pauses_and_refunds(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_membership_pause_policy(text),hon.set_school_membership_pause_policy(text,jsonb,text,uuid,uuid),
      hon.pause_school_membership(text,uuid,jsonb,text,uuid,uuid),hon.resume_school_membership(text,uuid,jsonb,text,uuid,uuid),
      hon.record_membership_refund(text,uuid,jsonb,text,uuid,uuid),hon.read_membership_pauses_and_refunds(text,uuid) TO hon_runtime;
  END IF;
END $$;

-- C-HQ-3 0225 (proposed) HQ school detail: the HQ read is the only runtime boundary; its counts helper stays internal.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hq_school_invitation_counts(text,uuid,timestamptz)','read_hq_school_detail_from_hq(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_hq_school_detail_from_hq(text,uuid) TO hon_runtime;
  END IF;
END $$;

-- C3b 0228 HON group summary: the group-facts helper is internal; summaries use the existing turn and reply
-- entry points (begin_hon_turn, prepare_hon_reply), whose grants are unchanged.
DO $$ DECLARE r text; BEGIN
  IF to_regprocedure('hon.hon_orchestration_summary_facts(text,uuid,uuid,uuid)') IS NULL THEN RAISE EXCEPTION 'Apply C3b migration 0228 first'; END IF;
  REVOKE ALL ON FUNCTION hon.hon_orchestration_summary_facts(text,uuid,uuid,uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.hon_orchestration_summary_facts(text,uuid,uuid,uuid) FROM '||quote_ident(r);
  END LOOP;
END $$;

-- 0226 school student CSV import: three private evidence tables, private helpers, five runtime entry points.
-- The runtime gains no privilege on the new tables or on people, families, family members or student profiles.
DO $$ DECLARE r text; t text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['student_import_batches','student_import_rows','student_import_requests'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_student_import()','hon.require_student_import_actor(text)','hon.student_import_fields()',
    'hon.student_import_check_row(jsonb,jsonb,jsonb,date)','hon.student_import_guardian(jsonb)','hon.student_import_summary(uuid)',
    'hon.student_import_detail(uuid)','hon.student_import_begin(text,text,jsonb,text,uuid,uuid)',
    'hon.student_import_finish(text,uuid,text,uuid,text,uuid,uuid,jsonb)','hon.stage_student_import(text,jsonb,text,uuid,uuid)',
    'hon.decide_student_import(text,jsonb,text,uuid,uuid)','hon.apply_student_import_row(uuid,integer,uuid,uuid,uuid)',
    'hon.finalize_student_import(text,jsonb,text,uuid,uuid)','hon.read_student_imports(text)','hon.read_student_import(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.stage_student_import(text,jsonb,text,uuid,uuid),hon.decide_student_import(text,jsonb,text,uuid,uuid),
      hon.finalize_student_import(text,jsonb,text,uuid,uuid),hon.read_student_imports(text),hon.read_student_import(text,uuid) TO hon_runtime;
  END IF;
END $$;
