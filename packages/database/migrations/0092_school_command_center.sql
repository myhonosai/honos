BEGIN;

-- This is a deliberately narrow reporting projection, not a CRM or command
-- boundary. It receives a server-verified session subject and explicit selected
-- organization/school IDs, then resolves every authority fact itself. It never
-- reads caller tenant/principal GUCs, writes audit/outbox rows, or invokes an
-- Action Engine/provider/payment/communication procedure.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'School Command Center requires a trusted BYPASSRLS migration owner';
  END IF;
END $$;

CREATE FUNCTION hon.read_school_command_center(
  p_external_subject text,
  p_organization_id uuid,
  p_school_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_as_of timestamptz := statement_timestamp();
  v_principal_id uuid;
  v_principal_count bigint;
  v_entitlement_count bigint;
  v_tier text;
  v_result jsonb;
BEGIN
  -- A selected ID only narrows this static projection. It is never a grant and
  -- no caller GUC can establish actor, tenant, school, source, or authority.
  IF p_external_subject IS NULL OR p_organization_id IS NULL OR p_school_id IS NULL THEN
    RAISE EXCEPTION 'COMMAND_CENTER_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT count(*), min(principal.id)
    INTO v_principal_count, v_principal_id
  FROM hon.users AS app_user
  JOIN hon.principals AS principal ON principal.user_id = app_user.id
  WHERE app_user.external_subject = p_external_subject
    AND principal.principal_type = 'HUMAN_USER'
    AND principal.is_active;
  IF v_principal_count <> 1 THEN
    RAISE EXCEPTION 'COMMAND_CENTER_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- A school Command Center cannot be borrowed through HQ or parent/family
  -- authority, even if either principal also has a reporting-looking grant.
  IF EXISTS (
    SELECT 1 FROM hon.hq_operator_grants WHERE principal_id = v_principal_id
  ) OR EXISTS (
    SELECT 1
    FROM hon.principal_role_grants AS role_grant
    JOIN hon.roles AS role ON role.id = role_grant.role_id
      AND role.organization_id = role_grant.organization_id
    WHERE role_grant.principal_id = v_principal_id
      AND role.code IN ('PARENT', 'GUARDIAN', 'STUDENT', 'FAMILY')
      AND role_grant.revoked_at IS NULL
      AND role_grant.effective_from <= v_as_of
      AND (role_grant.effective_until IS NULL OR role_grant.effective_until > v_as_of)
  ) THEN
    RAISE EXCEPTION 'COMMAND_CENTER_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- The selected school must be active and have one live, exact reporting.view
  -- path for this direct human. Organization-/HQ-wide access is not sufficient.
  IF NOT EXISTS (
    SELECT 1
    FROM hon.organizations AS organization
    JOIN hon.schools AS school ON school.organization_id = organization.id
    WHERE organization.id = p_organization_id
      AND school.id = p_school_id
      AND organization.status = 'ACTIVE'
      AND school.status = 'ACTIVE'
      AND EXISTS (
        SELECT 1
        FROM hon.principal_role_grants AS role_grant
        JOIN hon.roles AS role ON role.id = role_grant.role_id
          AND role.organization_id = role_grant.organization_id
        JOIN hon.role_permissions AS permission ON permission.role_id = role.id
          AND permission.organization_id = role.organization_id
          AND permission.permission_code = 'reporting.view'
        WHERE role_grant.principal_id = v_principal_id
          AND role_grant.organization_id = p_organization_id
          AND role_grant.school_id = p_school_id
          AND role_grant.revoked_at IS NULL
          AND role_grant.effective_from <= v_as_of
          AND (role_grant.effective_until IS NULL OR role_grant.effective_until > v_as_of)
          AND (role.management_school_id IS NULL OR role.management_school_id = p_school_id)
      )
  ) THEN
    RAISE EXCEPTION 'COMMAND_CENTER_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT count(*), min(entitlement.tier::text)
    INTO v_entitlement_count, v_tier
  FROM hon.organization_entitlements AS entitlement
  WHERE entitlement.organization_id = p_organization_id
    AND entitlement.status = 'ACTIVE'
    AND entitlement.tier IN ('ESSENTIAL', 'CORE', 'COMPLETE')
    AND entitlement.effective_from <= v_as_of
    AND (entitlement.effective_until IS NULL OR entitlement.effective_until > v_as_of);
  IF v_entitlement_count <> 1 OR v_tier IS NULL THEN
    RAISE EXCEPTION 'TIER_ENTITLEMENT_REQUIRED' USING ERRCODE = '42501';
  END IF;

  WITH
  invoice_amounts AS (
    -- This is an operational current-state invoice total, not payment timing,
    -- cash revenue, collection, MRR, or a provider-confirmed settlement total.
    SELECT currency::text AS currency, count(*) AS count, sum(total_minor) AS total_minor
    FROM hon.invoices
    WHERE organization_id = p_organization_id
      AND school_id = p_school_id
      AND status = 'PAID'
      AND created_at >= v_as_of - interval '30 days'
      AND created_at < v_as_of
    GROUP BY currency
  ),
  invoice_metric AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'currency', currency,
      'count', count,
      'totalMinor', total_minor
    ) ORDER BY currency), '[]'::jsonb) AS amounts
    FROM invoice_amounts
  )
  SELECT jsonb_build_object(
    'organizationId', p_organization_id,
    'schoolId', p_school_id,
    'entitlementTier', v_tier,
    'generatedAt', v_as_of,
    'metrics', jsonb_build_object(
      'newLeads24h', jsonb_build_object(
        'availability', 'AVAILABLE',
        'windowFrom', v_as_of - interval '24 hours',
        'windowTo', v_as_of,
        'count', (SELECT count(*) FROM hon.crm_leads
          WHERE organization_id = p_organization_id AND school_id = p_school_id
            AND created_at >= v_as_of - interval '24 hours' AND created_at < v_as_of)
      ),
      'upcomingTrials24h', jsonb_build_object(
        'availability', 'AVAILABLE',
        'windowFrom', v_as_of,
        'windowTo', v_as_of + interval '24 hours',
        'count', (SELECT count(*) FROM hon.crm_appointments
          WHERE organization_id = p_organization_id AND school_id = p_school_id
            AND appointment_type = 'TRIAL' AND status = 'SCHEDULED'
            AND starts_at >= v_as_of AND starts_at < v_as_of + interval '24 hours')
      ),
      'upcomingTestingEvents30d', jsonb_build_object(
        'availability', 'AVAILABLE',
        'windowFrom', v_as_of,
        'windowTo', v_as_of + interval '30 days',
        'count', (SELECT count(*) FROM hon.testing_events
          WHERE organization_id = p_organization_id AND school_id = p_school_id
            AND status IN ('DRAFT', 'OPEN', 'CLOSED')
            AND starts_at >= v_as_of AND starts_at < v_as_of + interval '30 days')
      ),
      'pendingActionApprovals', jsonb_build_object(
        'availability', 'AVAILABLE',
        'count', (SELECT count(*) FROM hon.action_requests
          WHERE organization_id = p_organization_id AND school_id = p_school_id
            AND status = 'AWAITING_APPROVAL'
            AND (approval_expires_at IS NULL OR approval_expires_at > v_as_of))
      ),
      'outstandingWorkItems', jsonb_build_object(
        'availability', 'AVAILABLE',
        'count', (SELECT count(*) FROM hon.work_items
          WHERE organization_id = p_organization_id AND school_id = p_school_id
            AND status IN ('READY', 'THINKING', 'WORKING', 'WAITING', 'WAITING_FOR_APPROVAL', 'NEEDS_ATTENTION'))
      ),
      'membershipTermsEnding30d', jsonb_build_object(
        'availability', 'AVAILABLE',
        'windowFrom', v_as_of,
        'windowTo', v_as_of + interval '30 days',
        'count', (SELECT count(*) FROM hon.memberships
          WHERE organization_id = p_organization_id AND school_id = p_school_id
            AND state IN ('ACTIVE', 'CANCELLATION_PENDING')
            AND term_ends_at >= v_as_of AND term_ends_at < v_as_of + interval '30 days')
      ),
      'paidInvoicesCreated30d', jsonb_build_object(
        'availability', 'AVAILABLE',
        'windowFrom', v_as_of - interval '30 days',
        'windowTo', v_as_of,
        'count', (SELECT coalesce(sum(count), 0) FROM invoice_amounts),
        'amountsByCurrency', (SELECT amounts FROM invoice_metric)
      ),
      'unansweredInquiries', jsonb_build_object(
        'availability', 'UNAVAILABLE',
        'reason', 'No approved inquiry response-state projection exists.'
      ),
      'attendanceDecline', jsonb_build_object(
        'availability', 'INSUFFICIENT_DATA',
        'reason', 'No approved attendance-decline policy or longitudinal projection exists.'
      ),
      'trialConversion', jsonb_build_object(
        'availability', 'UNAVAILABLE',
        'reason', 'No authoritative trial-to-enrollment linkage is available.'
      ),
      'revenue', jsonb_build_object(
        'availability', 'UNAVAILABLE',
        'reason', 'Current paid invoice state is not authoritative cash revenue or collection data.'
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION hon.read_school_command_center(text, uuid, uuid) IS
  'Read-only deterministic single-school Command Center snapshot. The function independently resolves verified direct HUMAN_USER, exact reporting.view, active Essential/Core/Complete tier and selected active school; it ignores caller context GUCs, returns aggregate/status facts only, and has no action/provider/payment/communication effects.';

REVOKE ALL ON FUNCTION hon.read_school_command_center(text, uuid, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_command_center(text, uuid, uuid) TO hon_runtime;
  END IF;
END;
$$;

-- Bound the two projections for which existing indexes do not begin with the
-- selected operational state. No table privilege, policy, trigger, domain row,
-- provider, action, audit, or outbox object is added.
CREATE INDEX command_center_membership_term_end_idx
  ON hon.memberships (organization_id, school_id, term_ends_at)
  WHERE state IN ('ACTIVE', 'CANCELLATION_PENDING') AND term_ends_at IS NOT NULL;
CREATE INDEX command_center_pending_action_approval_idx
  ON hon.action_requests (organization_id, school_id, approval_expires_at)
  WHERE status = 'AWAITING_APPROVAL';

COMMIT;
