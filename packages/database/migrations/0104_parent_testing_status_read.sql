BEGIN;

-- Parent/Eian testing status is a narrow read-only projection. It accepts only the
-- verified subject, resolves exactly one current family itself, and never exposes
-- selector IDs, scorecards/evaluations, reviewer content, rank/promotion, or actions.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Trusted parent testing status migration owner required';
  END IF;
END $$;

ALTER TABLE hon.testing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_events FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_registration_interests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_registration_interests FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_certificates FORCE ROW LEVEL SECURITY;

-- Exact lookup paths only; these create no parent-facing status store.
CREATE INDEX IF NOT EXISTS parent_testing_status_candidate_enrollment_idx
  ON hon.testing_candidates (organization_id, school_id, student_curriculum_enrollment_id, testing_event_id, id);
CREATE INDEX IF NOT EXISTS parent_testing_status_interest_family_student_idx
  ON hon.testing_registration_interests (organization_id, school_id, family_id, student_profile_id, created_at DESC, id);

CREATE FUNCTION hon.read_parent_testing_status(p_subject text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_scope record;
  v_scope_count integer;
  v_children jsonb;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject THEN
    RAISE EXCEPTION 'PARENT_TESTING_STATUS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- This server-side resolver returns at most two live scopes so neither a school,
  -- family, staff role, HQ role, nor a stale grant is picked as a fallback.
  SELECT count(*) INTO v_scope_count FROM hon.resolve_parent_journey_scopes(p_subject);
  IF v_scope_count <> 1 THEN
    RAISE EXCEPTION 'PARENT_TESTING_STATUS_SCOPE_AMBIGUOUS' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_scope FROM hon.resolve_parent_journey_scopes(p_subject);

  SELECT jsonb_build_object(
    'status', 'AVAILABLE',
    'items', CASE WHEN jsonb_array_length(raw.items) > 100 THEN raw.items - 100 ELSE raw.items END,
    'limited', jsonb_array_length(raw.items) > 100
  ) INTO v_children
  FROM (
    SELECT coalesce(jsonb_agg(x.item ORDER BY x.display_name, x.profile_id), '[]'::jsonb) AS items
    FROM (
      SELECT
        profile.id AS profile_id,
        concat_ws(' ', person.given_name, person.family_name) AS display_name,
        jsonb_build_object(
          'displayName', left(regexp_replace(concat_ws(' ', person.given_name, person.family_name), '[[:cntrl:]]', '', 'g'), 400),
          'upcomingEvent', upcoming.item,
          'candidates', candidates.data,
          'registrationInterests', interests.data,
          'certificate', CASE
            WHEN v_scope.access_level NOT IN ('PRIMARY_GUARDIAN'::hon.family_access_level, 'SECONDARY_GUARDIAN'::hon.family_access_level)
              THEN jsonb_build_object('status', 'UNAVAILABLE', 'reason', 'GUARDIAN_SCOPE_REQUIRED')
            WHEN NOT payer.safe
              THEN jsonb_build_object('status', 'UNAVAILABLE', 'reason', 'PAYER_LINK_UNVERIFIED')
            WHEN certificate.exists
              THEN jsonb_build_object('status', 'ISSUED')
            ELSE jsonb_build_object('status', 'NOT_ISSUED')
          END
        ) AS item
      FROM hon.student_profiles AS profile
      JOIN hon.people AS person
        ON person.id = profile.person_id
       AND person.organization_id = profile.organization_id
       AND person.school_id = profile.school_id
      JOIN hon.family_members AS member
        ON member.family_id = v_scope.family_id
       AND member.person_id = profile.person_id
       AND member.organization_id = profile.organization_id
       AND member.school_id = profile.school_id
       AND member.member_role = 'STUDENT'::hon.family_member_role
      CROSS JOIN LATERAL (
        SELECT jsonb_build_object(
          'status', 'AVAILABLE',
          'items', CASE WHEN jsonb_array_length(raw_candidates.items) > 50 THEN raw_candidates.items - 50 ELSE raw_candidates.items END,
          'limited', jsonb_array_length(raw_candidates.items) > 50
        ) AS data
        FROM (
          SELECT coalesce(jsonb_agg(candidate_rows.item ORDER BY candidate_rows.starts_at DESC, candidate_rows.candidate_id), '[]'::jsonb) AS items
          FROM (
            SELECT candidate.id AS candidate_id, event.starts_at,
              jsonb_build_object(
                'event', jsonb_build_object(
                  'label', left(regexp_replace(event.name, '[[:cntrl:]]', '', 'g'), 200),
                  'startsAt', event.starts_at,
                  'endsAt', event.ends_at
                ),
                'overallStatus', candidate.result::text
              ) AS item
            FROM hon.student_curriculum_enrollments AS enrollment
            JOIN hon.testing_candidates AS candidate
              ON candidate.student_curriculum_enrollment_id = enrollment.id
             AND candidate.organization_id = enrollment.organization_id
             AND candidate.school_id = enrollment.school_id
            JOIN hon.testing_events AS event
              ON event.id = candidate.testing_event_id
             AND event.organization_id = candidate.organization_id
             AND event.school_id = candidate.school_id
            WHERE enrollment.student_profile_id = profile.id
              AND enrollment.organization_id = v_scope.organization_id
              AND enrollment.school_id = v_scope.school_id
            ORDER BY event.starts_at DESC, candidate.id
            LIMIT 51
          ) AS candidate_rows
        ) AS raw_candidates
      ) AS candidates
      CROSS JOIN LATERAL (
        SELECT jsonb_build_object(
          'status', 'AVAILABLE',
          'items', CASE WHEN jsonb_array_length(raw_interests.items) > 50 THEN raw_interests.items - 50 ELSE raw_interests.items END,
          'limited', jsonb_array_length(raw_interests.items) > 50
        ) AS data
        FROM (
          SELECT coalesce(jsonb_agg(interest_rows.item ORDER BY interest_rows.submitted_at DESC, interest_rows.interest_id), '[]'::jsonb) AS items
          FROM (
            SELECT interest.id AS interest_id, interest.created_at AS submitted_at,
              jsonb_build_object(
                'event', jsonb_build_object(
                  'label', left(regexp_replace(event.name, '[[:cntrl:]]', '', 'g'), 200),
                  'startsAt', event.starts_at,
                  'endsAt', event.ends_at
                ),
                'status', interest.status::text,
                'submittedAt', interest.created_at,
                'reviewedAt', interest.reviewed_at
              ) AS item
            FROM hon.testing_registration_interests AS interest
            JOIN hon.testing_events AS event
              ON event.id = interest.testing_event_id
             AND event.organization_id = interest.organization_id
             AND event.school_id = interest.school_id
            WHERE interest.organization_id = v_scope.organization_id
              AND interest.school_id = v_scope.school_id
              AND interest.family_id = v_scope.family_id
              AND interest.student_profile_id = profile.id
            ORDER BY interest.created_at DESC, interest.id
            LIMIT 51
          ) AS interest_rows
        ) AS raw_interests
      ) AS interests
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object(
          'label', left(regexp_replace(future_event.name, '[[:cntrl:]]', '', 'g'), 200),
          'startsAt', future_event.starts_at,
          'endsAt', future_event.ends_at
        ) AS item
        FROM (
          SELECT event.id, event.name, event.starts_at, event.ends_at
          FROM hon.student_curriculum_enrollments AS enrollment
          JOIN hon.testing_candidates AS candidate
            ON candidate.student_curriculum_enrollment_id = enrollment.id
           AND candidate.organization_id = enrollment.organization_id
           AND candidate.school_id = enrollment.school_id
          JOIN hon.testing_events AS event
            ON event.id = candidate.testing_event_id
           AND event.organization_id = candidate.organization_id
           AND event.school_id = candidate.school_id
          WHERE enrollment.student_profile_id = profile.id
            AND enrollment.organization_id = v_scope.organization_id
            AND enrollment.school_id = v_scope.school_id
          UNION ALL
          SELECT event.id, event.name, event.starts_at, event.ends_at
          FROM hon.testing_registration_interests AS interest
          JOIN hon.testing_events AS event
            ON event.id = interest.testing_event_id
           AND event.organization_id = interest.organization_id
           AND event.school_id = interest.school_id
          WHERE interest.organization_id = v_scope.organization_id
            AND interest.school_id = v_scope.school_id
            AND interest.family_id = v_scope.family_id
            AND interest.student_profile_id = profile.id
        ) AS future_event
        WHERE future_event.starts_at > clock_timestamp()
        ORDER BY future_event.starts_at, future_event.id
        LIMIT 1
      ) AS upcoming ON true
      CROSS JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1
          FROM hon.memberships AS membership
          JOIN hon.billing_accounts AS account
            ON account.id = membership.billing_account_id
           AND account.organization_id = membership.organization_id
           AND account.school_id = membership.school_id
          JOIN hon.family_members AS participant
            ON participant.person_id = membership.participant_person_id
           AND participant.organization_id = membership.organization_id
           AND participant.school_id = membership.school_id
           AND participant.family_id = v_scope.family_id
           AND participant.member_role = 'STUDENT'::hon.family_member_role
          JOIN hon.family_members AS payer_member
            ON payer_member.person_id = account.responsible_person_id
           AND payer_member.organization_id = account.organization_id
           AND payer_member.school_id = account.school_id
           AND payer_member.family_id = v_scope.family_id
           AND payer_member.member_role = 'GUARDIAN'::hon.family_member_role
           AND payer_member.is_billing_contact
          WHERE membership.organization_id = v_scope.organization_id
            AND membership.school_id = v_scope.school_id
            AND membership.participant_person_id = profile.person_id
        ) AS safe
      ) AS payer
      CROSS JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1
          FROM hon.student_curriculum_enrollments AS enrollment
          JOIN hon.testing_candidates AS candidate
            ON candidate.student_curriculum_enrollment_id = enrollment.id
           AND candidate.organization_id = enrollment.organization_id
           AND candidate.school_id = enrollment.school_id
          JOIN hon.testing_certificates AS issued
            ON issued.testing_candidate_id = candidate.id
           AND issued.organization_id = candidate.organization_id
           AND issued.school_id = candidate.school_id
          WHERE enrollment.student_profile_id = profile.id
            AND enrollment.organization_id = v_scope.organization_id
            AND enrollment.school_id = v_scope.school_id
        ) AS exists
      ) AS certificate
      WHERE profile.organization_id = v_scope.organization_id
        AND profile.school_id = v_scope.school_id
        AND profile.primary_family_id = v_scope.family_id
        AND profile.status = 'ACTIVE'
      ORDER BY person.given_name, person.family_name, profile.id
      LIMIT 101
    ) AS x
  ) AS raw;

  -- Verify the family is still one exact live result after all source reads.
  SELECT count(*) INTO v_scope_count FROM hon.resolve_parent_journey_scopes(p_subject);
  IF v_scope_count <> 1 THEN
    RAISE EXCEPTION 'PARENT_TESTING_STATUS_SCOPE_CHANGED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM hon.resolve_parent_journey_scopes(p_subject) AS current_scope
    WHERE current_scope.principal_id = v_scope.principal_id
      AND current_scope.organization_id = v_scope.organization_id
      AND current_scope.school_id = v_scope.school_id
      AND current_scope.family_id = v_scope.family_id
      AND current_scope.access_level = v_scope.access_level
  ) THEN
    RAISE EXCEPTION 'PARENT_TESTING_STATUS_SCOPE_CHANGED' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'generatedAt', clock_timestamp(),
    'accessLevel', v_scope.access_level::text,
    'children', coalesce(v_children, jsonb_build_object('status', 'AVAILABLE', 'items', '[]'::jsonb, 'limited', false))
  );
END;
$$;

COMMENT ON FUNCTION hon.read_parent_testing_status(text) IS
  'Read-only parent/Eian current-family testing status. It resolves one live family from verified subject and returns only redacted child event timing, overall candidate status, own interest state, and payer-safe certificate existence; never evaluator/criteria/comments, grading/promotion/rank/certificate issue/download, payment, message, provider, AI, Action Engine, voice, automation, audit, outbox, or external calls.';

REVOKE ALL ON FUNCTION hon.read_parent_testing_status(text) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'hon_runtime') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_parent_testing_status(text) FROM %I', role_name);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_parent_testing_status(text) TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
