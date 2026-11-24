BEGIN;

-- Weekly attendance streaks (0602, assigned by the coordinator 2026-11-20; docs/architecture/PARENT_APP_PLAYFUL_STYLE.md S1).
-- The owner approved a weekly attendance streak on the HON Family app's Home screen (flame count).
--   W1  For each ACTIVE child of the family (STUDENT member whose primary family is this family), the number of
--       consecutive weeks with at least one attended class: attendance PRESENT, LATE or MAKEUP on a class session that has
--       already started. Weeks are Monday to Sunday in the school's time zone, by the session's start.
--   W2  The streak ends with the current week, or with the previous week while the current week has no attendance yet,
--       so a family is never shown a broken streak on a Monday morning. Counted back at most 104 weeks.
--   W3  Families with one live grant at the school (any access level, VIEWER included) read it. The result is each child's
--       name and a number only: no dates, sessions, statuses, staff or identifiers.
-- Read only: no table, no DML, no outbox. The runtime gains no table privilege: the entry point is SECURITY DEFINER.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Attendance streaks require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Attendance streaks require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.parent_class_booking_scope(text,boolean)') IS NULL OR to_regclass('hon.attendance_records') IS NULL THEN
    RAISE EXCEPTION 'Attendance streaks require 0032 and 0329';
  END IF;
END $$;

-- W3: the 0329 family scope (one live grant, tenant, principal, source, live school and entitlement), with its own refusal
-- code. Reading needs no guardian level.
CREATE FUNCTION hon.parent_attendance_streak_scope(subject text)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid, family_id uuid, access_level text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  BEGIN
    RETURN QUERY SELECT * FROM hon.parent_class_booking_scope(subject,false);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'ATTENDANCE_STREAKS_FORBIDDEN' USING ERRCODE='42501';
  END;
END $$;

-- W1/W2: one child's streak. Distinct attended weeks (newest first) up to the anchor week; the streak is the run of weeks
-- that equal anchor, anchor-1 week, anchor-2 weeks, ... (distinct weeks only fall further behind once a gap appears).
CREATE FUNCTION hon.parent_attendance_streak_weeks(org uuid, school uuid, child uuid, tz text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH now_week AS (SELECT date_trunc('week',clock_timestamp() AT TIME ZONE tz)::date AS w),
  attended AS (
    SELECT DISTINCT date_trunc('week',s.starts_at AT TIME ZONE tz)::date AS wk
    FROM hon.attendance_records ar
    JOIN hon.class_sessions s ON s.id=ar.class_session_id AND s.organization_id=ar.organization_id AND s.school_id=ar.school_id
    WHERE ar.organization_id=org AND ar.school_id=school AND ar.student_profile_id=child
      AND ar.status IN ('PRESENT','LATE','MAKEUP') AND s.starts_at<=clock_timestamp()
      AND s.starts_at>=((SELECT w FROM now_week)-104*7)::timestamp AT TIME ZONE tz),
  anchor AS (
    SELECT CASE WHEN EXISTS(SELECT 1 FROM attended WHERE wk=(SELECT w FROM now_week)) THEN (SELECT w FROM now_week)
      WHEN EXISTS(SELECT 1 FROM attended WHERE wk=(SELECT w FROM now_week)-7) THEN (SELECT w FROM now_week)-7 END AS a),
  ranked AS (
    SELECT wk, row_number() OVER (ORDER BY wk DESC) AS rn FROM attended, anchor WHERE anchor.a IS NOT NULL AND wk<=anchor.a)
  SELECT least(coalesce((SELECT count(*) FILTER (WHERE ranked.wk=anchor.a-7*(ranked.rn::integer-1)) FROM ranked, anchor),0),104)::integer;
$$;

-- W3 parent read: each ACTIVE child of the family (at most 20, by name), with a streak in weeks.
CREATE FUNCTION hon.read_parent_attendance_streaks(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; tz text; children jsonb;
BEGIN
  SELECT * INTO sc FROM hon.parent_attendance_streak_scope(subject);
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=sc.school_id AND s.organization_id=sc.organization_id;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=tz) THEN RAISE EXCEPTION 'ATTENDANCE_STREAKS_UNAVAILABLE' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.name,'weeks',hon.parent_attendance_streak_weeks(sc.organization_id,sc.school_id,c.id,tz)) ORDER BY c.name, c.id),'[]')
  INTO children FROM (
    SELECT sp.id, concat_ws(' ',pe.given_name,pe.family_name) AS name
    FROM hon.student_profiles sp
    JOIN hon.family_members m ON m.person_id=sp.person_id AND m.organization_id=sp.organization_id AND m.school_id=sp.school_id
      AND m.family_id=sc.family_id AND m.member_role='STUDENT'
    JOIN hon.people pe ON pe.id=sp.person_id AND pe.organization_id=sp.organization_id AND pe.school_id=sp.school_id
    WHERE sp.primary_family_id=sc.family_id AND sp.status='ACTIVE' AND sp.organization_id=sc.organization_id AND sp.school_id=sc.school_id
      AND btrim(concat_ws(' ',pe.given_name,pe.family_name))<>''
    ORDER BY 2, 1 LIMIT 20) c;
  RETURN jsonb_build_object('children',children);
END $$;

COMMENT ON FUNCTION hon.read_parent_attendance_streaks(text) IS
'0602 parent read: for each ACTIVE child of the one live family grant, consecutive school-time-zone weeks (Monday to Sunday) with attended classes, ending this week or last week, at most 104. Name and number only. No DML.';

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_parent_attendance_streaks(text)'];
  fns text[]:=ARRAY['hon.parent_attendance_streak_scope(text)','hon.parent_attendance_streak_weeks(uuid,uuid,uuid,text)']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
    IF EXISTS(SELECT 1 FROM unnest(fns) f2 WHERE f2<>ALL(entry) AND has_function_privilege('hon_runtime',f2,'EXECUTE')) THEN
      RAISE EXCEPTION 'Attendance streak helpers must stay private';
    END IF;
  END IF;
END $$;

COMMIT;
