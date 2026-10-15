BEGIN;

-- The School Health Score is an optional, conventional, read-only operational
-- indicator. It is not a prediction, recommendation, retention/cancellation
-- certainty, cash-revenue measure, or a command boundary. The fixed projection
-- resolves its own direct human, school, permission, and entitlement facts and
-- never obtains authority from caller GUCs, parent/family access, or HQ access.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'School Health Score requires a trusted BYPASSRLS migration owner';
  END IF;
END $$;

CREATE FUNCTION hon.read_school_health_score(
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
  -- Millisecond precision makes the displayed UTC half-open windows exact.
  v_as_of timestamptz := date_trunc('milliseconds', statement_timestamp());
  v_principal_id uuid;
  v_principal_count bigint;
  v_entitlement_count bigint;
  v_tier text;
  v_result jsonb;
BEGIN
  -- Selected IDs are selectors only. They are never a grant, and no caller GUC
  -- can establish principal, organization, school, source, or authority.
  IF p_external_subject IS NULL OR p_organization_id IS NULL OR p_school_id IS NULL THEN
    RAISE EXCEPTION 'SCHOOL_HEALTH_SCORE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT count(*), min(principal.id::text)::uuid
    INTO v_principal_count, v_principal_id
  FROM hon.users AS app_user
  JOIN hon.principals AS principal ON principal.user_id = app_user.id
  WHERE app_user.external_subject = p_external_subject
    AND principal.principal_type = 'HUMAN_USER'
    AND principal.is_active;
  IF v_principal_count <> 1 THEN
    RAISE EXCEPTION 'SCHOOL_HEALTH_SCORE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- A school Health Score never borrows parent/family or HQ authority.
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
    RAISE EXCEPTION 'SCHOOL_HEALTH_SCORE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- A live direct, school-scoped reporting.view grant is required. Organization
  -- wide/HQ access and a different school cannot satisfy this predicate.
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
    RAISE EXCEPTION 'SCHOOL_HEALTH_SCORE_FORBIDDEN' USING ERRCODE = '42501';
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
  windows AS (
    SELECT v_as_of AS generated_at,
      v_as_of - interval '28 days' AS attendance_from,
      v_as_of - interval '56 days' AS pipeline_from,
      v_as_of - interval '90 days' AS retention_from,
      v_as_of - interval '28 days' AS operations_from
  ),
  completed_sessions AS MATERIALIZED (
    SELECT session.id
    FROM hon.class_sessions AS session, windows
    WHERE session.organization_id = p_organization_id
      AND session.school_id = p_school_id
      AND session.status = 'COMPLETED'
      AND session.starts_at >= windows.attendance_from
      AND session.starts_at < windows.generated_at
  ),
  attendance_facts AS (
    SELECT
      (SELECT count(*) FROM completed_sessions) AS completed_sessions,
      count(attendance.id) AS recorded_observations,
      count(attendance.id) FILTER (WHERE attendance.status IN ('PRESENT', 'LATE', 'MAKEUP')) AS engaged_observations
    FROM hon.attendance_records AS attendance
    JOIN completed_sessions AS session ON session.id = attendance.class_session_id
    WHERE attendance.organization_id = p_organization_id
      AND attendance.school_id = p_school_id
  ),
  pipeline_facts AS (
    SELECT
      (SELECT count(*) FROM hon.crm_leads AS lead, windows
       WHERE lead.organization_id = p_organization_id AND lead.school_id = p_school_id
         AND lead.created_at >= windows.pipeline_from AND lead.created_at < windows.generated_at) AS leads_created,
      count(appointment.id) AS trial_appointments,
      count(appointment.id) FILTER (WHERE appointment.status IN ('COMPLETED', 'NO_SHOW', 'CANCELLED')) AS trial_outcomes_recorded
    FROM hon.crm_appointments AS appointment, windows
    WHERE appointment.organization_id = p_organization_id
      AND appointment.school_id = p_school_id
      AND appointment.appointment_type = 'TRIAL'
      AND appointment.starts_at >= windows.pipeline_from
      AND appointment.starts_at < windows.generated_at
  ),
  retention_facts AS (
    SELECT
      (SELECT count(*) FROM hon.memberships AS membership, windows
       WHERE membership.organization_id = p_organization_id AND membership.school_id = p_school_id
         AND membership.term_started_at IS NOT NULL AND membership.term_ends_at IS NOT NULL
         AND membership.term_ends_at > membership.term_started_at
         AND membership.term_ends_at >= windows.retention_from AND membership.term_ends_at < windows.generated_at) AS membership_terms_ended,
      (SELECT count(*) FROM hon.membership_renewal_reviews AS review, windows
       WHERE review.organization_id = p_organization_id AND review.school_id = p_school_id
         AND review.created_at >= windows.retention_from AND review.created_at < windows.generated_at) AS renewal_reviews_recorded
  ),
  operations_facts AS (
    SELECT
      (SELECT count(*) FROM hon.action_requests AS request, windows
       WHERE request.organization_id = p_organization_id AND request.school_id = p_school_id
         AND request.status = 'AWAITING_APPROVAL'
         AND (request.approval_expires_at IS NULL OR request.approval_expires_at > windows.generated_at)
         AND request.created_at >= windows.operations_from AND request.created_at < windows.generated_at) AS pending_approvals,
      (SELECT count(*) FROM hon.work_items AS work_item, windows
       WHERE work_item.organization_id = p_organization_id AND work_item.school_id = p_school_id
         AND work_item.status IN ('READY', 'THINKING', 'WORKING', 'WAITING', 'WAITING_FOR_APPROVAL', 'NEEDS_ATTENTION')
         AND work_item.created_at >= windows.operations_from AND work_item.created_at < windows.generated_at) AS outstanding_work_items
  ),
  scored AS (
    SELECT windows.*,
      attendance.completed_sessions, attendance.recorded_observations, attendance.engaged_observations,
      pipeline.leads_created, pipeline.trial_appointments, pipeline.trial_outcomes_recorded,
      retention.membership_terms_ended, retention.renewal_reviews_recorded,
      operations.pending_approvals, operations.outstanding_work_items,
      attendance.completed_sessions >= 4 AND attendance.recorded_observations >= 20 AS attendance_sufficient,
      pipeline.leads_created >= 5 AND pipeline.trial_appointments >= 3 AS pipeline_sufficient,
      retention.membership_terms_ended >= 5 AND retention.renewal_reviews_recorded >= 3 AS retention_sufficient,
      (operations.pending_approvals + operations.outstanding_work_items) >= 1 AS operations_sufficient,
      least(100, greatest(0, round(100.0 * attendance.engaged_observations / nullif(attendance.recorded_observations, 0))::integer)) AS attendance_score,
      least(100, greatest(0, round(100.0 * pipeline.trial_outcomes_recorded / nullif(pipeline.trial_appointments, 0))::integer)) AS pipeline_score,
      least(100, greatest(0, round(100.0 * retention.renewal_reviews_recorded / nullif(retention.membership_terms_ended, 0))::integer)) AS retention_score,
      least(100, greatest(0, 100 - operations.pending_approvals * 10 - operations.outstanding_work_items * 5)) AS operations_score
    FROM windows
    CROSS JOIN attendance_facts AS attendance
    CROSS JOIN pipeline_facts AS pipeline
    CROSS JOIN retention_facts AS retention
    CROSS JOIN operations_facts AS operations
  ),
  categories AS (
    SELECT *, jsonb_build_object(
      'attendanceEngagement', jsonb_build_object(
        'status', CASE WHEN attendance_sufficient THEN 'AVAILABLE' ELSE 'INSUFFICIENT_DATA' END,
        'windowFrom', to_char(attendance_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'windowTo', to_char(generated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'evidence', jsonb_build_object('completedSessions', completed_sessions, 'recordedAttendanceObservations', recorded_observations, 'engagedAttendanceObservations', engaged_observations),
        'reasons', to_jsonb(array_remove(ARRAY[
          CASE WHEN completed_sessions < 4 THEN 'MIN_COMPLETED_SESSIONS' END,
          CASE WHEN recorded_observations < 20 THEN 'MIN_RECORDED_ATTENDANCE_OBSERVATIONS' END
        ], NULL))
      ) || CASE WHEN attendance_sufficient THEN jsonb_build_object('score', attendance_score) ELSE '{}'::jsonb END,
      'pipelineTrial', jsonb_build_object(
        'status', CASE WHEN pipeline_sufficient THEN 'AVAILABLE' ELSE 'INSUFFICIENT_DATA' END,
        'windowFrom', to_char(pipeline_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'windowTo', to_char(generated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'evidence', jsonb_build_object('leadsCreated', leads_created, 'trialAppointments', trial_appointments, 'trialOutcomesRecorded', trial_outcomes_recorded),
        'reasons', to_jsonb(array_remove(ARRAY[
          CASE WHEN leads_created < 5 THEN 'MIN_RECENT_LEADS' END,
          CASE WHEN trial_appointments < 3 THEN 'MIN_RECENT_TRIAL_APPOINTMENTS' END
        ], NULL))
      ) || CASE WHEN pipeline_sufficient THEN jsonb_build_object('score', pipeline_score) ELSE '{}'::jsonb END,
      'retention', jsonb_build_object(
        'status', CASE WHEN retention_sufficient THEN 'AVAILABLE' ELSE 'INSUFFICIENT_DATA' END,
        'windowFrom', to_char(retention_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'windowTo', to_char(generated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'evidence', jsonb_build_object('membershipTermsEnded', membership_terms_ended, 'renewalReviewsRecorded', renewal_reviews_recorded),
        'reasons', to_jsonb(array_remove(ARRAY[
          CASE WHEN membership_terms_ended < 5 THEN 'MIN_MEMBERSHIP_TERMS_ENDED' END,
          CASE WHEN renewal_reviews_recorded < 3 THEN 'MIN_RENEWAL_REVIEWS_RECORDED' END
        ], NULL))
      ) || CASE WHEN retention_sufficient THEN jsonb_build_object('score', retention_score) ELSE '{}'::jsonb END,
      'operations', jsonb_build_object(
        'status', CASE WHEN operations_sufficient THEN 'AVAILABLE' ELSE 'INSUFFICIENT_DATA' END,
        'windowFrom', to_char(operations_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'windowTo', to_char(generated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'evidence', jsonb_build_object('pendingApprovals', pending_approvals, 'outstandingWorkItems', outstanding_work_items),
        'reasons', to_jsonb(array_remove(ARRAY[
          CASE WHEN (pending_approvals + outstanding_work_items) < 1 THEN 'NO_RECENT_OPERATIONS_WORKLOAD_SAMPLE' END
        ], NULL))
      ) || CASE WHEN operations_sufficient THEN jsonb_build_object('score', operations_score) ELSE '{}'::jsonb END
    ) AS value
    FROM scored
  ),
  overall_reasons AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object('category', category, 'reasons', reasons) ORDER BY category), '[]'::jsonb) AS value
    FROM (
      SELECT 'ATTENDANCE_ENGAGEMENT' AS category, (value->'attendanceEngagement'->'reasons') AS reasons, attendance_sufficient AS sufficient FROM categories
      UNION ALL SELECT 'PIPELINE_TRIAL', value->'pipelineTrial'->'reasons', pipeline_sufficient FROM categories
      UNION ALL SELECT 'RETENTION', value->'retention'->'reasons', retention_sufficient FROM categories
      UNION ALL SELECT 'OPERATIONS', value->'operations'->'reasons', operations_sufficient FROM categories
    ) AS insufficient
    WHERE NOT sufficient
  )
  SELECT jsonb_build_object(
    'organizationId', p_organization_id,
    'schoolId', p_school_id,
    'entitlementTier', v_tier,
    'formulaVersion', 'SCHOOL_HEALTH_SCORE_V1',
    'generatedAt', to_char(categories.generated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'weights', jsonb_build_object('attendanceEngagement', 35, 'pipelineTrial', 25, 'retention', 25, 'operations', 15),
    'categories', categories.value,
    'overall', jsonb_build_object(
      'status', CASE WHEN attendance_sufficient AND pipeline_sufficient AND retention_sufficient AND operations_sufficient THEN 'AVAILABLE' ELSE 'INSUFFICIENT_DATA' END,
      'reasons', overall_reasons.value
    ) || CASE WHEN attendance_sufficient AND pipeline_sufficient AND retention_sufficient AND operations_sufficient
      THEN jsonb_build_object('score', least(100, greatest(0, round((attendance_score * 35 + pipeline_score * 25 + retention_score * 25 + operations_score * 15) / 100.0)::integer)))
      ELSE '{}'::jsonb END
  ) INTO v_result
  FROM categories
  CROSS JOIN overall_reasons;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION hon.read_school_health_score(text, uuid, uuid) IS
  'Read-only deterministic single-school operational indicator. Independently resolves verified direct HUMAN_USER, exact reporting.view, active Essential/Core/Complete entitlement and selected active school; ignores caller context GUCs; returns aggregate-only formula/evidence/status facts; has no prediction, recommendation, action, provider, billing/payment, audit, outbox, or work effects.';

REVOKE ALL ON FUNCTION hon.read_school_health_score(text, uuid, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_health_score(text, uuid, uuid) TO hon_runtime;
  END IF;
END;
$$;

-- Read indexes only; no table grants, policies, triggers, domain rows, provider,
-- action, audit, outbox, or derived-score storage are added.
CREATE INDEX health_score_attendance_session_idx
  ON hon.attendance_records (organization_id, school_id, class_session_id);
CREATE INDEX health_score_leads_created_idx
  ON hon.crm_leads (organization_id, school_id, created_at);
CREATE INDEX health_score_trial_starts_idx
  ON hon.crm_appointments (organization_id, school_id, appointment_type, starts_at);
CREATE INDEX health_score_membership_terms_idx
  ON hon.memberships (organization_id, school_id, term_ends_at)
  WHERE term_started_at IS NOT NULL AND term_ends_at IS NOT NULL;
CREATE INDEX health_score_renewal_review_created_idx
  ON hon.membership_renewal_reviews (organization_id, school_id, created_at);
CREATE INDEX health_score_pending_approvals_created_idx
  ON hon.action_requests (organization_id, school_id, created_at)
  WHERE status = 'AWAITING_APPROVAL';
CREATE INDEX health_score_nonterminal_work_created_idx
  ON hon.work_items (organization_id, school_id, created_at)
  WHERE status IN ('READY', 'THINKING', 'WORKING', 'WAITING', 'WAITING_FOR_APPROVAL', 'NEEDS_ATTENTION');

COMMIT;
