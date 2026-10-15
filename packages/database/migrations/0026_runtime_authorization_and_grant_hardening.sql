BEGIN;

-- Runtime code may ask this fixed predicate about a previously resolved scope,
-- but never receives direct access to the global identity or role directories.
CREATE FUNCTION hon.principal_has_school_permission(
  p_principal_id uuid,
  p_organization_id uuid,
  p_school_id uuid,
  p_permission_code text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM hon.principals AS principal
    JOIN hon.principal_role_grants AS role_grant
      ON role_grant.principal_id = principal.id
     AND role_grant.organization_id = p_organization_id
     AND role_grant.school_id = p_school_id
     AND role_grant.effective_from <= now()
     AND (role_grant.effective_until IS NULL OR role_grant.effective_until > now())
    JOIN hon.role_permissions AS role_permission
      ON role_permission.role_id = role_grant.role_id
     AND role_permission.organization_id = p_organization_id
     AND role_permission.permission_code = p_permission_code
    WHERE principal.id = p_principal_id
      AND principal.is_active = true
  );
$$;

REVOKE ALL ON FUNCTION hon.principal_has_school_permission(uuid, uuid, uuid, text) FROM PUBLIC;

-- Tighten an existing deployment role as well as the future provisioning script.
-- New direct grants cover only the current conventional command/query services.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA hon FROM hon_runtime';

    EXECUTE 'GRANT SELECT ON TABLE
      hon.organization_entitlements,
      hon.people,
      hon.families,
      hon.family_members,
      hon.student_profiles,
      hon.crm_pipelines,
      hon.crm_pipeline_stages,
      hon.crm_leads,
      hon.billing_accounts,
      hon.memberships,
      hon.membership_payment_schedules,
      hon.action_policies,
      hon.action_requests,
      hon.idempotency_records,
      hon.principal_interface_preferences
      TO hon_runtime';

    EXECUTE 'GRANT INSERT ON TABLE
      hon.people,
      hon.families,
      hon.family_members,
      hon.student_profiles,
      hon.crm_pipelines,
      hon.crm_pipeline_stages,
      hon.crm_leads,
      hon.billing_accounts,
      hon.memberships,
      hon.membership_payment_schedules,
      hon.action_requests,
      hon.action_approvals,
      hon.audit_events,
      hon.outbox_events,
      hon.idempotency_records,
      hon.principal_interface_preferences
      TO hon_runtime';

    EXECUTE 'GRANT UPDATE ON TABLE
      hon.action_requests,
      hon.idempotency_records,
      hon.principal_interface_preferences
      TO hon_runtime';

    EXECUTE 'GRANT EXECUTE ON FUNCTION hon.principal_has_school_permission(uuid, uuid, uuid, text) TO hon_runtime';
  END IF;
END;
$$;

COMMIT;
