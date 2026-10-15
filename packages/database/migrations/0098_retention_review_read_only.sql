BEGIN;

-- Retention Review Signals is a true read-only projection. PostgreSQL rejects
-- row-locking reads inside SET TRANSACTION READ ONLY, so authorization is
-- checked before and after all evidence reads instead of taking row locks.
-- The final check remains the authority decision; this migration preserves the
-- original function contracts without adding a write-capable read path.

CREATE OR REPLACE FUNCTION hon.lock_retention_review_actor(p_external_subject text)
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
 ;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETENTION_REVIEW_FORBIDDEN' USING ERRCODE = '42501'; END IF;

  PERFORM 1 FROM hon.schools
  WHERE id = v_school_id AND organization_id = v_organization_id AND status = 'ACTIVE'
 ;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETENTION_REVIEW_FORBIDDEN' USING ERRCODE = '42501'; END IF;

  v_actor := hon.require_retention_review_actor(p_external_subject);
  PERFORM 1 FROM hon.users WHERE id IN (SELECT user_id FROM hon.principals WHERE id = v_actor);
  PERFORM 1 FROM hon.principals WHERE id = v_actor;
  PERFORM 1 FROM hon.principal_role_grants
  WHERE principal_id = v_actor AND organization_id = v_organization_id AND school_id = v_school_id
  ORDER BY id;
  PERFORM 1 FROM hon.roles
  WHERE id IN (SELECT role_id FROM hon.principal_role_grants
               WHERE principal_id = v_actor AND organization_id = v_organization_id AND school_id = v_school_id)
  ORDER BY id;
  PERFORM 1 FROM hon.role_permissions
  WHERE role_id IN (SELECT role_id FROM hon.principal_role_grants
                    WHERE principal_id = v_actor AND organization_id = v_organization_id AND school_id = v_school_id)
  ORDER BY role_id, permission_code;
  PERFORM 1 FROM hon.organization_entitlements WHERE organization_id = v_organization_id ORDER BY id;
  RETURN hon.require_retention_review_actor(p_external_subject);
END;
$$;

CREATE OR REPLACE FUNCTION hon.read_retention_review_signals(
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
 ;
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
  'Human-only known-membership Retention Review Signals: a true read-only redacted observed-facts projection. It has no score, prediction, financial/payment fields, directory fields, action, audit, outbox, provider, automation, messaging, membership, renewal, attendance, curriculum, or testing mutation.';

COMMIT;
