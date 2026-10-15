BEGIN;

-- An audited exception to school-bound RLS, not a directory or arbitrary query
-- facility. The API supplies ONLY a verified session subject and the route org.
-- All authority and the commercial tier are resolved in this statement snapshot.
CREATE FUNCTION hon.read_organization_operations_summary(
  p_external_subject text,
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz
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
  v_school_ids uuid[];
  v_tier text;
  v_result jsonb;
BEGIN
  -- Do not accept ambiguous identities, inactive humans, or a caller principal/GUC.
  SELECT count(*), (array_agg(principal.id))[1]
    INTO v_principal_count, v_principal_id
  FROM hon.users AS app_user
  JOIN hon.principals AS principal ON principal.user_id = app_user.id
  WHERE app_user.external_subject = p_external_subject
    AND principal.principal_type = 'HUMAN_USER' AND principal.is_active;
  IF v_principal_count <> 1 THEN
    RAISE EXCEPTION 'OPERATIONS_SUMMARY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT array_agg(school.id ORDER BY school.id) INTO v_school_ids
  FROM hon.schools AS school
  JOIN hon.organizations AS organization ON organization.id = school.organization_id
  WHERE school.organization_id = p_organization_id
    AND school.status = 'ACTIVE' AND organization.status = 'ACTIVE'
    AND EXISTS (
      SELECT 1 FROM hon.principal_role_grants AS role_grant
      JOIN hon.roles AS role ON role.id = role_grant.role_id
        AND role.organization_id = role_grant.organization_id
      JOIN hon.role_permissions AS permission ON permission.role_id = role.id
        AND permission.organization_id = role.organization_id
        AND permission.permission_code = 'reporting.view'
      WHERE role_grant.principal_id = v_principal_id
        AND role_grant.organization_id = p_organization_id
        AND role_grant.school_id = school.id
        AND role_grant.effective_from <= v_as_of
        AND (role_grant.effective_until IS NULL OR role_grant.effective_until > v_as_of)
    );
  IF v_school_ids IS NULL THEN
    -- No topology, tier, or even existence is exposed for an unauthorized org.
    RAISE EXCEPTION 'OPERATIONS_SUMMARY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT entitlement.tier::text INTO v_tier
  FROM hon.organization_entitlements AS entitlement
  WHERE entitlement.organization_id = p_organization_id
    AND entitlement.status = 'ACTIVE'
    AND entitlement.tier IN ('CORE', 'COMPLETE')
    AND entitlement.effective_from <= v_as_of
    AND (entitlement.effective_until IS NULL OR entitlement.effective_until > v_as_of);
  IF v_tier IS NULL THEN
    RAISE EXCEPTION 'TIER_ENTITLEMENT_REQUIRED' USING ERRCODE = '42501';
  END IF;

  -- Defense in depth for direct runtime calls; the API also validates this range.
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to)
    OR p_to <= p_from OR p_to - p_from > interval '2208 hours' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
  END IF;

  WITH
  scopes AS MATERIALIZED (
    SELECT NULL::uuid AS school_id UNION ALL SELECT unnest(v_school_ids)
  ),
  students AS (
    SELECT school_id, count(*) AS total, count(*) FILTER (WHERE status = 'ACTIVE') AS active
    FROM hon.student_profiles
    WHERE organization_id = p_organization_id AND school_id = ANY(v_school_ids)
    GROUP BY GROUPING SETS ((school_id), ())
  ),
  leads AS (
    SELECT school_id,
      count(*) FILTER (WHERE status = 'OPEN') AS open,
      count(*) FILTER (WHERE status = 'WON') AS won,
      count(*) FILTER (WHERE status = 'LOST') AS lost,
      count(*) FILTER (WHERE status = 'ARCHIVED') AS archived
    FROM hon.crm_leads
    WHERE organization_id = p_organization_id AND school_id = ANY(v_school_ids)
    GROUP BY GROUPING SETS ((school_id), ())
  ),
  ranged_sessions AS MATERIALIZED (
    SELECT school_id, id, status, starts_at FROM hon.class_sessions
    WHERE organization_id = p_organization_id AND school_id = ANY(v_school_ids)
      AND starts_at >= p_from AND starts_at < p_to
  ),
  sessions AS (
    SELECT school_id,
      count(*) FILTER (WHERE status = 'DRAFT') AS draft,
      count(*) FILTER (WHERE status = 'SCHEDULED') AS scheduled,
      count(*) FILTER (WHERE status = 'COMPLETED') AS completed,
      count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
      count(*) FILTER (WHERE status = 'SCHEDULED' AND starts_at < v_as_of) AS scheduled_due
    FROM ranged_sessions GROUP BY GROUPING SETS ((school_id), ())
  ),
  attendance AS (
    SELECT entry.school_id,
      count(*) FILTER (WHERE entry.status = 'PRESENT') AS present,
      count(*) FILTER (WHERE entry.status = 'LATE') AS late,
      count(*) FILTER (WHERE entry.status = 'EXCUSED_ABSENCE') AS excused,
      count(*) FILTER (WHERE entry.status = 'UNEXCUSED_ABSENCE') AS unexcused,
      count(*) FILTER (WHERE entry.status = 'MAKEUP') AS makeup
    FROM hon.attendance_records AS entry
    JOIN ranged_sessions AS session ON session.id = entry.class_session_id AND session.school_id = entry.school_id
    WHERE entry.organization_id = p_organization_id AND entry.school_id = ANY(v_school_ids)
    GROUP BY GROUPING SETS ((entry.school_id), ())
  ),
  activity AS (
    SELECT school_id, count(*) AS total FROM hon.crm_activities
    WHERE organization_id = p_organization_id AND school_id = ANY(v_school_ids)
      AND occurred_at >= p_from AND occurred_at < p_to
    GROUP BY GROUPING SETS ((school_id), ())
  ),
  recorded_attendance AS (
    SELECT school_id, count(*) AS total FROM hon.attendance_records
    WHERE organization_id = p_organization_id AND school_id = ANY(v_school_ids)
      AND recorded_at >= p_from AND recorded_at < p_to
    GROUP BY GROUPING SETS ((school_id), ())
  ),
  ranged_invoices AS MATERIALIZED (
    -- Internal inputs only. No invoice/person/membership/provider IDs are read.
    SELECT school_id, status, currency::text AS currency, total_minor FROM hon.invoices
    WHERE organization_id = p_organization_id AND school_id = ANY(v_school_ids)
      AND created_at >= p_from AND created_at < p_to
  ),
  invoices AS (
    SELECT school_id,
      count(*) FILTER (WHERE status = 'DRAFT') AS draft,
      count(*) FILTER (WHERE status = 'ISSUED') AS issued,
      count(*) FILTER (WHERE status = 'PAID') AS paid,
      count(*) FILTER (WHERE status = 'VOID') AS void,
      count(*) FILTER (WHERE status = 'UNCOLLECTIBLE') AS uncollectible
    FROM ranged_invoices GROUP BY GROUPING SETS ((school_id), ())
  ),
  currency_amounts AS (
    SELECT school_id, currency, jsonb_build_object(
      'DRAFT', coalesce(sum(total_minor) FILTER (WHERE status = 'DRAFT'), 0),
      'ISSUED', coalesce(sum(total_minor) FILTER (WHERE status = 'ISSUED'), 0),
      'PAID', coalesce(sum(total_minor) FILTER (WHERE status = 'PAID'), 0),
      'VOID', coalesce(sum(total_minor) FILTER (WHERE status = 'VOID'), 0),
      'UNCOLLECTIBLE', coalesce(sum(total_minor) FILTER (WHERE status = 'UNCOLLECTIBLE'), 0)
    ) AS amounts
    FROM ranged_invoices GROUP BY GROUPING SETS ((school_id, currency), (currency))
  ),
  invoice_currencies AS (
    SELECT school_id, jsonb_agg(jsonb_build_object('currency', currency, 'totalMinorByStatus', amounts) ORDER BY currency) AS amounts
    FROM currency_amounts GROUP BY school_id
  ),
  metrics AS MATERIALIZED (
    SELECT scope.school_id, jsonb_build_object(
      'studentProfiles', jsonb_build_object('total', coalesce(student.total, 0), 'active', coalesce(student.active, 0)),
      'leads', jsonb_build_object('byStatus', jsonb_build_object(
        'OPEN', coalesce(lead.open, 0), 'WON', coalesce(lead.won, 0), 'LOST', coalesce(lead.lost, 0), 'ARCHIVED', coalesce(lead.archived, 0))),
      'classSessions', jsonb_build_object('inRange', jsonb_build_object(
        'draft', coalesce(session.draft, 0), 'scheduled', coalesce(session.scheduled, 0),
        'completed', coalesce(session.completed, 0), 'cancelled', coalesce(session.cancelled, 0)),
        'scheduledDueInRange', coalesce(session.scheduled_due, 0)),
      'attendance', jsonb_build_object('inRangeByStatus', jsonb_build_object(
        'PRESENT', coalesce(entry.present, 0), 'LATE', coalesce(entry.late, 0),
        'EXCUSED_ABSENCE', coalesce(entry.excused, 0), 'UNEXCUSED_ABSENCE', coalesce(entry.unexcused, 0), 'MAKEUP', coalesce(entry.makeup, 0))),
      'recentActivity', jsonb_build_object('crmActivitiesInRange', coalesce(activity.total, 0),
        'attendanceEntriesRecordedInRange', coalesce(recorded.total, 0)),
      'invoices', jsonb_build_object('inRangeByStatus', jsonb_build_object(
        'DRAFT', coalesce(invoice.draft, 0), 'ISSUED', coalesce(invoice.issued, 0), 'PAID', coalesce(invoice.paid, 0),
        'VOID', coalesce(invoice.void, 0), 'UNCOLLECTIBLE', coalesce(invoice.uncollectible, 0)),
        'amountsByCurrency', coalesce(currency.amounts, '[]'::jsonb))
    ) AS data
    FROM scopes AS scope
    LEFT JOIN students AS student ON student.school_id IS NOT DISTINCT FROM scope.school_id
    LEFT JOIN leads AS lead ON lead.school_id IS NOT DISTINCT FROM scope.school_id
    LEFT JOIN sessions AS session ON session.school_id IS NOT DISTINCT FROM scope.school_id
    LEFT JOIN attendance AS entry ON entry.school_id IS NOT DISTINCT FROM scope.school_id
    LEFT JOIN activity ON activity.school_id IS NOT DISTINCT FROM scope.school_id
    LEFT JOIN recorded_attendance AS recorded ON recorded.school_id IS NOT DISTINCT FROM scope.school_id
    LEFT JOIN invoices AS invoice ON invoice.school_id IS NOT DISTINCT FROM scope.school_id
    LEFT JOIN invoice_currencies AS currency ON currency.school_id IS NOT DISTINCT FROM scope.school_id
  )
  SELECT jsonb_build_object(
    'organizationId', p_organization_id, 'entitlementTier', v_tier,
    'generatedAt', v_as_of, 'from', p_from, 'to', p_to,
    'scope', 'AUTHORIZED_SCHOOLS_ONLY', 'schoolCount', cardinality(v_school_ids),
    'aggregate', (SELECT data FROM metrics WHERE school_id IS NULL),
    'schools', (SELECT jsonb_agg(jsonb_build_object('schoolId', school_id, 'metrics', data) ORDER BY school_id)
      FROM metrics WHERE school_id IS NOT NULL)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION hon.read_organization_operations_summary(text, uuid, timestamptz, timestamptz) IS
  'Read-only Core/Complete projection for a verified human subject. Fixed reporting.view permission, active effective IAM/tier, authorized-school-only aggregates; no raw records, directory, provider access or writes. Owner must be a controlled migration role capable of bypassing forced RLS.';
REVOKE ALL ON FUNCTION hon.read_organization_operations_summary(text, uuid, timestamptz, timestamptz) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_organization_operations_summary(text, uuid, timestamptz, timestamptz) TO hon_runtime;
  END IF;
END;
$$;

-- No new tables, policies, or direct runtime grants. Bound each operational scan.
CREATE INDEX operations_summary_grant_scope_idx ON hon.principal_role_grants (principal_id, organization_id, school_id, effective_from) INCLUDE (role_id, effective_until);
CREATE INDEX operations_summary_invoice_range_idx ON hon.invoices (organization_id, school_id, created_at);
CREATE INDEX operations_summary_activity_range_idx ON hon.crm_activities (organization_id, school_id, occurred_at);
CREATE INDEX operations_summary_attendance_range_idx ON hon.attendance_records (organization_id, school_id, recorded_at);

COMMIT;
