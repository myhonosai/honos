BEGIN;

-- Retention Review Signals is an optional evidence-only, known-membership read.
-- It is intentionally not a score, prediction, forecast, financial authority,
-- directory, workflow, Action Engine boundary, or mutation surface.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Retention Review Signals requires a trusted migration owner';
  END IF;
END;
$$;

INSERT INTO hon.permissions(code, description, is_sensitive, is_staff_assignable)
VALUES (
  'retention.review.read',
  'Human staff read of redacted known-membership Retention Review Signals evidence',
  true,
  true
)
ON CONFLICT (code) DO NOTHING;

-- Preserve the canonical OWNER bootstrap convention without mass-granting users.
INSERT INTO hon.role_permissions(role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, 'retention.review.read'
FROM hon.roles AS role
WHERE role.is_system_role AND role.code = 'OWNER'
ON CONFLICT DO NOTHING;

CREATE FUNCTION hon.retention_review_has_permission(
  p_actor uuid,
  p_organization_id uuid,
  p_school_id uuid
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  SELECT hon.staff_member_eligible(p_actor, p_organization_id, p_school_id)
    AND EXISTS (
      SELECT 1
      FROM hon.principal_role_grants AS grant_row
      JOIN hon.roles AS role ON role.id = grant_row.role_id
        AND role.organization_id = grant_row.organization_id
      JOIN hon.role_permissions AS permission ON permission.role_id = role.id
        AND permission.organization_id = role.organization_id
        AND permission.permission_code = 'retention.review.read'
      WHERE grant_row.principal_id = p_actor
        AND grant_row.organization_id = p_organization_id
        AND grant_row.school_id = p_school_id
        AND grant_row.revoked_at IS NULL
        AND grant_row.effective_from <= statement_timestamp()
        AND (grant_row.effective_until IS NULL OR grant_row.effective_until > statement_timestamp())
        AND (role.management_school_id IS NULL OR role.management_school_id = p_school_id)
        AND role.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
    );
$$;

-- The API calls this resolver before it establishes tenant context. The known school
-- ID narrows the candidate scope and never confers an entitlement or permission.
CREATE FUNCTION hon.resolve_retention_review_scope(
  p_external_subject text,
  p_school_id uuid
)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  WITH direct_human AS (
    SELECT principal.id
    FROM hon.users AS app_user
    JOIN hon.principals AS principal ON principal.user_id = app_user.id
    WHERE app_user.external_subject = p_external_subject
      AND principal.principal_type = 'HUMAN_USER'
      AND principal.is_active
  ), candidates AS (
    SELECT DISTINCT human.id AS principal_id, grant_row.organization_id, grant_row.school_id
    FROM direct_human AS human
    JOIN hon.principal_role_grants AS grant_row ON grant_row.principal_id = human.id
    JOIN hon.organizations AS organization ON organization.id = grant_row.organization_id
      AND organization.status = 'ACTIVE'
    JOIN hon.schools AS school ON school.id = grant_row.school_id
      AND school.organization_id = grant_row.organization_id
      AND school.status = 'ACTIVE'
    WHERE grant_row.school_id = p_school_id
      AND (SELECT count(*) FROM direct_human) = 1
      AND hon.retention_review_has_permission(human.id, grant_row.organization_id, grant_row.school_id)
      AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq WHERE hq.principal_id = human.id)
      AND NOT EXISTS (
        SELECT 1
        FROM hon.principal_role_grants AS parent_grant
        JOIN hon.roles AS parent_role ON parent_role.id = parent_grant.role_id
          AND parent_role.organization_id = parent_grant.organization_id
        WHERE parent_grant.principal_id = human.id
          AND parent_grant.revoked_at IS NULL
          AND parent_grant.effective_from <= statement_timestamp()
          AND (parent_grant.effective_until IS NULL OR parent_grant.effective_until > statement_timestamp())
          AND parent_role.code IN ('PARENT', 'GUARDIAN', 'STUDENT', 'FAMILY')
      )
      AND (SELECT count(*) FROM hon.organization_entitlements AS entitlement
           WHERE entitlement.organization_id = grant_row.organization_id
             AND entitlement.status = 'ACTIVE'
             AND entitlement.tier IN ('ESSENTIAL', 'CORE', 'COMPLETE')
             AND entitlement.effective_from <= statement_timestamp()
             AND (entitlement.effective_until IS NULL OR entitlement.effective_until > statement_timestamp())) = 1
  )
  SELECT principal_id, organization_id, school_id
  FROM candidates
  WHERE (SELECT count(*) FROM candidates) = 1;
$$;

CREATE FUNCTION hon.require_retention_review_actor(p_external_subject text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid;
  v_entitlement_count bigint;
BEGIN
  IF current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'HUMAN_UI_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT principal.id INTO v_actor
  FROM hon.users AS app_user
  JOIN hon.principals AS principal ON principal.user_id = app_user.id
  WHERE app_user.external_subject = p_external_subject
    AND principal.principal_type = 'HUMAN_USER'
    AND principal.is_active
    AND principal.id::text = current_setting('app.hon_principal_id', true)
    AND (SELECT count(*)
         FROM hon.principals AS other_principal
         WHERE other_principal.user_id = app_user.id
           AND other_principal.principal_type = 'HUMAN_USER'
           AND other_principal.is_active) = 1;

  SELECT count(*) INTO v_entitlement_count
  FROM hon.organization_entitlements AS entitlement
  WHERE entitlement.organization_id = hon.current_organization_id()
    AND entitlement.status = 'ACTIVE'
    AND entitlement.tier IN ('ESSENTIAL', 'CORE', 'COMPLETE')
    AND entitlement.effective_from <= statement_timestamp()
    AND (entitlement.effective_until IS NULL OR entitlement.effective_until > statement_timestamp());

  IF v_actor IS NULL
    OR v_entitlement_count <> 1
    OR NOT hon.retention_review_has_permission(v_actor, hon.current_organization_id(), hon.current_school_id())
    OR EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq WHERE hq.principal_id = v_actor)
    OR EXISTS (
      SELECT 1
      FROM hon.principal_role_grants AS grant_row
      JOIN hon.roles AS role ON role.id = grant_row.role_id
        AND role.organization_id = grant_row.organization_id
      WHERE grant_row.principal_id = v_actor
        AND grant_row.revoked_at IS NULL
        AND grant_row.effective_from <= statement_timestamp()
        AND (grant_row.effective_until IS NULL OR grant_row.effective_until > statement_timestamp())
        AND role.code IN ('PARENT', 'GUARDIAN', 'STUDENT', 'FAMILY')
    ) THEN
    RAISE EXCEPTION 'RETENTION_REVIEW_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN v_actor;
END;
$$;

-- Share-lock authorization facts then revalidate after the observed-facts query.
-- This function intentionally creates no audit/outbox/idempotency/action evidence:
-- a conventional read is not a consequential command.
CREATE FUNCTION hon.lock_retention_review_actor(p_external_subject text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid;
  v_organization_id uuid := hon.current_organization_id();
  v_school_id uuid := hon.current_school_id();
BEGIN
  PERFORM 1 FROM hon.organizations
  WHERE id = v_organization_id AND status = 'ACTIVE'
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETENTION_REVIEW_FORBIDDEN' USING ERRCODE = '42501'; END IF;

  PERFORM 1 FROM hon.schools
  WHERE id = v_school_id AND organization_id = v_organization_id AND status = 'ACTIVE'
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETENTION_REVIEW_FORBIDDEN' USING ERRCODE = '42501'; END IF;

  v_actor := hon.require_retention_review_actor(p_external_subject);
  PERFORM 1 FROM hon.users WHERE id IN (SELECT user_id FROM hon.principals WHERE id = v_actor) FOR SHARE;
  PERFORM 1 FROM hon.principals WHERE id = v_actor FOR SHARE;
  PERFORM 1 FROM hon.principal_role_grants
  WHERE principal_id = v_actor AND organization_id = v_organization_id AND school_id = v_school_id
  ORDER BY id FOR SHARE;
  PERFORM 1 FROM hon.roles
  WHERE id IN (SELECT role_id FROM hon.principal_role_grants
               WHERE principal_id = v_actor AND organization_id = v_organization_id AND school_id = v_school_id)
  ORDER BY id FOR SHARE;
  PERFORM 1 FROM hon.role_permissions
  WHERE role_id IN (SELECT role_id FROM hon.principal_role_grants
                    WHERE principal_id = v_actor AND organization_id = v_organization_id AND school_id = v_school_id)
  ORDER BY role_id, permission_code FOR SHARE;
  PERFORM 1 FROM hon.organization_entitlements WHERE organization_id = v_organization_id ORDER BY id FOR SHARE;
  RETURN hon.require_retention_review_actor(p_external_subject);
END;
$$;

CREATE FUNCTION hon.read_retention_review_signals(
  p_external_subject text,
  p_membership_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_organization_id uuid := hon.current_organization_id();
  v_school_id uuid := hon.current_school_id();
  v_as_of timestamptz := date_trunc('milliseconds', statement_timestamp());
  v_attendance_from timestamptz := date_trunc('milliseconds', statement_timestamp()) - interval '28 days';
  v_membership hon.memberships%ROWTYPE;
  v_student_profile_id uuid;
  v_student_count bigint;
  v_review_state text;
  v_reviewed_at timestamptz;
  v_attendance_count bigint := 0;
  v_present_count bigint := 0;
  v_late_count bigint := 0;
  v_makeup_count bigint := 0;
  v_excused_absence_count bigint := 0;
  v_unexcused_absence_count bigint := 0;
  v_enrollment_count bigint := 0;
  v_progress_observation_count bigint := 0;
  v_testing_record_count bigint := 0;
  v_term jsonb;
  v_renewal jsonb;
  v_attendance jsonb;
  v_progression jsonb;
BEGIN
  IF p_external_subject IS NULL OR length(p_external_subject) NOT BETWEEN 1 AND 200 OR p_membership_id IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
  END IF;

  PERFORM hon.lock_retention_review_actor(p_external_subject);
  SELECT * INTO v_membership
  FROM hon.memberships
  WHERE id = p_membership_id
    AND organization_id = v_organization_id
    AND school_id = v_school_id
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETENTION_REVIEW_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;

  SELECT review_version.status, review_version.recorded_at
    INTO v_review_state, v_reviewed_at
  FROM hon.membership_renewal_reviews AS review
  JOIN LATERAL (
    SELECT version_row.status, version_row.recorded_at
    FROM hon.membership_renewal_versions AS version_row
    WHERE version_row.renewal_id = review.id
      AND version_row.organization_id = review.organization_id
      AND version_row.school_id = review.school_id
    ORDER BY version_row.version DESC
    LIMIT 1
  ) AS review_version ON true
  WHERE review.membership_id = v_membership.id
    AND review.organization_id = v_organization_id
    AND review.school_id = v_school_id
  ORDER BY review_version.recorded_at DESC, review.id DESC
  LIMIT 1;

  SELECT count(*), min(profile.id)
    INTO v_student_count, v_student_profile_id
  FROM hon.student_profiles AS profile
  WHERE profile.organization_id = v_organization_id
    AND profile.school_id = v_school_id
    AND profile.person_id = v_membership.participant_person_id;

  v_term := jsonb_build_object(
    'status', CASE WHEN v_membership.term_started_at IS NULL OR v_membership.term_ends_at IS NULL THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END,
    'membershipState', v_membership.state::text,
    'termStartedAt', CASE WHEN v_membership.term_started_at IS NULL THEN NULL ELSE to_char(v_membership.term_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'termEndsAt', CASE WHEN v_membership.term_ends_at IS NULL THEN NULL ELSE to_char(v_membership.term_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'endingObservation', CASE
      WHEN v_membership.term_ends_at IS NULL THEN 'TERM_END_NOT_RECORDED'
      WHEN v_membership.term_ends_at < v_as_of THEN 'TERM_ENDED'
      WHEN v_membership.term_ends_at < v_as_of + interval '30 days' THEN 'ENDING_WITHIN_30_DAYS'
      ELSE 'ENDING_AFTER_30_DAYS'
    END,
    'reason', CASE WHEN v_membership.term_started_at IS NULL OR v_membership.term_ends_at IS NULL THEN 'TERM_DATES_NOT_RECORDED' ELSE NULL END
  );

  v_renewal := jsonb_build_object(
    'status', CASE WHEN v_review_state IS NULL THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END,
    'latestReviewState', v_review_state,
    'recordedAt', CASE WHEN v_reviewed_at IS NULL THEN NULL ELSE to_char(v_reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'reason', CASE WHEN v_review_state IS NULL THEN 'NO_EXPLICIT_RENEWAL_REVIEW_RECORDED' ELSE NULL END
  );

  IF v_student_count <> 1 THEN
    v_attendance := jsonb_build_object(
      'status', 'UNAVAILABLE',
      'windowFrom', to_char(v_attendance_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'windowTo', to_char(v_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'recordedAttendanceCount', 0,
      'presentCount', 0,
      'lateCount', 0,
      'makeupCount', 0,
      'excusedAbsenceCount', 0,
      'unexcusedAbsenceCount', 0,
      'reason', CASE WHEN v_student_count = 0 THEN 'NO_MATCHING_STUDENT_PROFILE' ELSE 'AMBIGUOUS_STUDENT_PROFILE_LINK' END
    );
    v_progression := jsonb_build_object(
      'status', 'UNAVAILABLE',
      'curriculumEnrollmentCount', 0,
      'progressObservationCount', 0,
      'testingRecordCount', 0,
      'progressObservationAvailability', 'UNAVAILABLE',
      'testingObservationAvailability', 'UNAVAILABLE',
      'reason', CASE WHEN v_student_count = 0 THEN 'NO_MATCHING_STUDENT_PROFILE' ELSE 'AMBIGUOUS_STUDENT_PROFILE_LINK' END
    );
  ELSE
    SELECT count(*),
      count(*) FILTER (WHERE record.status = 'PRESENT'),
      count(*) FILTER (WHERE record.status = 'LATE'),
      count(*) FILTER (WHERE record.status = 'MAKEUP'),
      count(*) FILTER (WHERE record.status = 'EXCUSED_ABSENCE'),
      count(*) FILTER (WHERE record.status = 'UNEXCUSED_ABSENCE')
    INTO v_attendance_count, v_present_count, v_late_count, v_makeup_count, v_excused_absence_count, v_unexcused_absence_count
    FROM hon.attendance_records AS record
    WHERE record.organization_id = v_organization_id
      AND record.school_id = v_school_id
      AND record.student_profile_id = v_student_profile_id
      AND record.recorded_at >= v_attendance_from
      AND record.recorded_at < v_as_of;

    v_attendance := jsonb_build_object(
      'status', CASE WHEN v_attendance_count = 0 THEN 'INSUFFICIENT_DATA' ELSE 'AVAILABLE' END,
      'windowFrom', to_char(v_attendance_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'windowTo', to_char(v_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'recordedAttendanceCount', v_attendance_count,
      'presentCount', v_present_count,
      'lateCount', v_late_count,
      'makeupCount', v_makeup_count,
      'excusedAbsenceCount', v_excused_absence_count,
      'unexcusedAbsenceCount', v_unexcused_absence_count,
      'reason', CASE WHEN v_attendance_count = 0 THEN 'NO_RECORDED_ATTENDANCE_IN_WINDOW' ELSE NULL END
    );

    SELECT count(*) INTO v_enrollment_count
    FROM hon.student_curriculum_enrollments AS enrollment
    WHERE enrollment.organization_id = v_organization_id
      AND enrollment.school_id = v_school_id
      AND enrollment.student_profile_id = v_student_profile_id;

    IF v_enrollment_count > 0 THEN
      SELECT count(*) INTO v_progress_observation_count
      FROM hon.curriculum_progress_observations AS observation
      JOIN hon.student_curriculum_enrollments AS enrollment ON enrollment.id = observation.enrollment_id
        AND enrollment.organization_id = observation.organization_id
        AND enrollment.school_id = observation.school_id
      WHERE enrollment.organization_id = v_organization_id
        AND enrollment.school_id = v_school_id
        AND enrollment.student_profile_id = v_student_profile_id;

      SELECT count(*) INTO v_testing_record_count
      FROM hon.testing_candidates AS candidate
      JOIN hon.student_curriculum_enrollments AS enrollment ON enrollment.id = candidate.student_curriculum_enrollment_id
        AND enrollment.organization_id = candidate.organization_id
        AND enrollment.school_id = candidate.school_id
      WHERE enrollment.organization_id = v_organization_id
        AND enrollment.school_id = v_school_id
        AND enrollment.student_profile_id = v_student_profile_id;
    END IF;

    v_progression := jsonb_build_object(
      'status', CASE WHEN v_enrollment_count = 0 THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END,
      'curriculumEnrollmentCount', v_enrollment_count,
      'progressObservationCount', v_progress_observation_count,
      'testingRecordCount', v_testing_record_count,
      'progressObservationAvailability', CASE WHEN v_progress_observation_count = 0 THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END,
      'testingObservationAvailability', CASE WHEN v_testing_record_count = 0 THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END,
      'reason', CASE WHEN v_enrollment_count = 0 THEN 'NO_CURRICULUM_ENROLLMENT_RECORDED' ELSE NULL END
    );
  END IF;

  PERFORM hon.require_retention_review_actor(p_external_subject);
  RETURN jsonb_build_object(
    'schemaVersion', 'RETENTION_REVIEW_SIGNALS_V1',
    'membershipId', v_membership.id,
    'observedAt', to_char(v_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'humanOnly', true,
    'readOnly', true,
    'evidenceOnly', true,
    'predictionOrAutomaticAction', false,
    'membershipTerm', v_term,
    'renewalReview', v_renewal,
    'followUp', jsonb_build_object(
      'status', 'UNAVAILABLE',
      'reason', 'NO_UNAMBIGUOUS_MEMBERSHIP_TO_FOLLOW_UP_RELATION'
    ),
    'attendance', v_attendance,
    'progression', v_progression
  );
END;
$$;

COMMENT ON FUNCTION hon.read_retention_review_signals(text, uuid) IS
  'Human-only known-membership Retention Review Signals: a read-only redacted observed-facts projection. It has no score, prediction, financial/payment fields, directory fields, action, audit, outbox, provider, automation, messaging, membership, renewal, attendance, curriculum, or testing mutation.';

REVOKE ALL ON FUNCTION hon.retention_review_has_permission(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.resolve_retention_review_scope(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.require_retention_review_actor(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.lock_retention_review_actor(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.read_retention_review_signals(text, uuid) FROM PUBLIC;

DO $$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.retention_review_has_permission(uuid,uuid,uuid) FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.resolve_retention_review_scope(text,uuid) FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.require_retention_review_actor(text) FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.lock_retention_review_actor(text) FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_retention_review_signals(text,uuid) FROM %I', role_name);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.resolve_retention_review_scope(text, uuid), hon.read_retention_review_signals(text, uuid) TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
