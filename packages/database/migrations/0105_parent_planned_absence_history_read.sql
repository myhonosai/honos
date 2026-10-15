BEGIN;

-- Parent/Eian planned-absence history is an observation-only projection. It has
-- no school, family, child, request, reviewer, or action selector. The verified
-- subject is resolved to exactly one live guardian family inside this function;
-- staff, HQ, and VIEWER access never become a fallback.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Trusted parent planned-absence history migration owner required';
  END IF;
END $$;

-- Retain the canonical tenant isolation posture on the source table. The fixed
-- projection verifies every tenant/family/child relationship itself and creates
-- no direct parent table policy or broad runtime table grant.
ALTER TABLE hon.planned_absence_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.planned_absence_requests FORCE ROW LEVEL SECURITY;

-- Migration 0038's exact composite family/start index serves this fixed window:
-- (organization_id, school_id, family_id, starts_at DESC).
CREATE FUNCTION hon.read_parent_planned_absence_history(p_subject text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_scope record;
  v_scope_count integer;
  v_from timestamptz;
  v_to timestamptz;
  v_requests jsonb;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject THEN
    RAISE EXCEPTION 'PARENT_PLANNED_ABSENCE_HISTORY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- The shared resolver proves an active HUMAN_USER, active tenant topology and
  -- live explicit family grant. Its two-row cap intentionally fails closed for
  -- multi-family accounts; no school/family selector or staff/HQ scope is used.
  SELECT count(*) INTO v_scope_count FROM hon.resolve_parent_journey_scopes(p_subject);
  IF v_scope_count <> 1 THEN
    RAISE EXCEPTION 'PARENT_PLANNED_ABSENCE_HISTORY_SCOPE_AMBIGUOUS' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_scope FROM hon.resolve_parent_journey_scopes(p_subject);
  IF v_scope.access_level NOT IN ('PRIMARY_GUARDIAN'::hon.family_access_level, 'SECONDARY_GUARDIAN'::hon.family_access_level) THEN
    RAISE EXCEPTION 'PARENT_PLANNED_ABSENCE_HISTORY_GUARDIAN_REQUIRED' USING ERRCODE = '42501';
  END IF;

  -- One explicit UTC half-open observation window: 180 completed days of
  -- history through the next 90 calendar days. It is not a full-history API,
  -- cursor, count, schedule, attendance, booking, makeup, or status inference.
  v_from := (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') - interval '180 days') AT TIME ZONE 'UTC';
  v_to := (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') + interval '91 days') AT TIME ZONE 'UTC';

  SELECT coalesce(jsonb_agg(x.item ORDER BY x.starts_at DESC, x.request_id DESC), '[]'::jsonb)
    INTO v_requests
  FROM (
    SELECT
      request.id AS request_id,
      request.starts_at,
      jsonb_build_object(
        'child', jsonb_build_object(
          'displayName', left(regexp_replace(concat_ws(' ', child.given_name, child.family_name), '[[:cntrl:]]', '', 'g'), 400)
        ),
        'startsAt', to_char(request.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'endsAt', to_char(request.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'status', request.status::text,
        'submittedAt', to_char(request.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'reviewedAt', CASE WHEN request.reviewed_at IS NULL THEN NULL ELSE to_char(request.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
      ) AS item
    FROM hon.planned_absence_requests AS request
    JOIN hon.student_profiles AS profile
      ON profile.id = request.student_profile_id
     AND profile.organization_id = request.organization_id
     AND profile.school_id = request.school_id
     AND profile.primary_family_id = request.family_id
     AND profile.status = 'ACTIVE'
    JOIN hon.family_members AS student_member
      ON student_member.person_id = profile.person_id
     AND student_member.organization_id = profile.organization_id
     AND student_member.school_id = profile.school_id
     AND student_member.family_id = request.family_id
     AND student_member.member_role = 'STUDENT'::hon.family_member_role
    JOIN hon.people AS child
      ON child.id = profile.person_id
     AND child.organization_id = profile.organization_id
     AND child.school_id = profile.school_id
    WHERE request.organization_id = v_scope.organization_id
      AND request.school_id = v_scope.school_id
      AND request.family_id = v_scope.family_id
      AND request.starts_at >= v_from
      AND request.starts_at < v_to
      AND btrim(concat_ws(' ', child.given_name, child.family_name)) <> ''
    ORDER BY request.starts_at DESC, request.id DESC
    LIMIT 101
  ) AS x;

  -- Recheck the full live scope after all source reads. A revoked, changed, or
  -- newly ambiguous family scope never yields a stale successful projection.
  SELECT count(*) INTO v_scope_count FROM hon.resolve_parent_journey_scopes(p_subject);
  IF v_scope_count <> 1 THEN
    RAISE EXCEPTION 'PARENT_PLANNED_ABSENCE_HISTORY_SCOPE_CHANGED' USING ERRCODE = '42501';
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
    RAISE EXCEPTION 'PARENT_PLANNED_ABSENCE_HISTORY_SCOPE_CHANGED' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'generatedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'from', to_char(v_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'to', to_char(v_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'accessLevel', v_scope.access_level::text,
    'requests', jsonb_build_object(
      'status', 'AVAILABLE',
      'items', CASE WHEN jsonb_array_length(v_requests) > 100 THEN v_requests - 100 ELSE v_requests END,
      'limited', jsonb_array_length(v_requests) > 100
    )
  );
END;
$$;

COMMENT ON FUNCTION hon.read_parent_planned_absence_history(text) IS
  'Read-only parent/Eian current-family planned-absence history. Resolves exactly one live guardian family from verified subject and returns only bounded current-child display name, absence timing, submitted/current status, and review timestamp; never request/family/student/reviewer identifiers, parent reason, staff rationale/note, schedule, roster, booking, attendance, makeup, messages, providers, AI, Action Engine, voice, automation, payment, audit, outbox, or external calls.';

REVOKE ALL ON FUNCTION hon.read_parent_planned_absence_history(text) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'hon_runtime') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_parent_planned_absence_history(text) FROM %I', role_name);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_parent_planned_absence_history(text) TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
