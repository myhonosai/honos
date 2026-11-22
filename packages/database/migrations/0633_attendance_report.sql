BEGIN;

-- AR1 (0633, allocated by the coordinator 2026-11-22): the attendance report. Owner (David), 2026-11-22: "I don't see report
-- on attendance. Check manus crm attendance report under attendance." Modelled on the Manus CRM Attendance > Stats tab:
-- check-ins by class time for one week, 7 and 30 day participation, average check-ins per scheduled class, participation by
-- program, and each active student's last check-in (the page lists students with no check-in for 2+ weeks).
-- One read-only entry point, hon.read_attendance_report(subject, input), for the session school only, with the 0331
-- authority (hon.require_school_reports_actor: a direct human at the session school with live reporting.view, an active
-- school and organization and an active HON entitlement; HQ, family and automated callers refused).
-- Definitions, all in the school's own time zone:
--   check-in        an attendance record PRESENT, LATE or MAKEUP on a class session that is not cancelled and has started
--                   (the 0331 rule). Its time is the session's start.
--   active student  a person counted as a member now by the 0520 rule (hon.school_dashboard_members: from the term start
--                   until the first of the term end or the recorded cancellation; paused memberships still count) who has
--                   a student profile at this school.
--   7 / 30 days     today and the 6 / 29 days before it, up to now. A student attended when they have a check-in in it.
--   week            Monday to Sunday holding input.week (default: this week). One row per session start (day and time)
--                   with its check-ins; cancelled sessions are left out.
--   classes         input.month ('YYYY-MM', default this month) or 'ALL': sessions that have started, grouped by weekday,
--                   start time and class name. sessions = held; sessionsWithCheckIns = held with at least one check-in.
--   program         the program of the student's first active curriculum enrollment (by enrolled date); rank is the
--                   current rank of that enrollment. Students without one are counted under no program.
--   students        every active student (at most 2000, marked truncated beyond): name, rank, program, last check-in
--                   date and whether they attended in the last 7 / 30 days. Names only: no contact details or notes.
-- Nothing is written, sent, charged or scheduled.

CREATE FUNCTION hon.read_attendance_report(p_subject text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); tz text; s hon.schools%ROWTYPE;
  as_of timestamptz:=statement_timestamp(); today date; week_start date; month_start date; month_text text;
  d7 timestamptz; d30 timestamptz; w_from timestamptz; w_to timestamptz; c_from timestamptz; c_to timestamptz;
  week jsonb; classes jsonb; students jsonb; programs jsonb; totals jsonb; active_count integer;
  utc constant text:='YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
BEGIN
  PERFORM hon.require_school_reports_actor(p_subject);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('week','month'))
    OR (p_input ? 'week' AND (jsonb_typeof(p_input->'week')<>'string' OR (p_input->>'week') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'))
    OR (p_input ? 'month' AND (jsonb_typeof(p_input->'month')<>'string'
      OR ((p_input->>'month') <> 'ALL' AND (p_input->>'month') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'))) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM hon.schools x WHERE x.id=school AND x.organization_id=org;
  SELECT n.name INTO tz FROM pg_timezone_names n WHERE n.name=s.timezone;
  IF tz IS NULL THEN RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;

  today:=(as_of AT TIME ZONE tz)::date;
  week_start:=CASE WHEN p_input ? 'week' THEN (p_input->>'week')::date ELSE today END;
  week_start:=week_start - (extract(isodow FROM week_start)::integer - 1);
  -- A week from 2000 up to this week; anything else is not a report anyone can have data for.
  IF week_start < date '2000-01-03' OR week_start > today THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  w_from:=week_start::timestamp AT TIME ZONE tz; w_to:=least((week_start + 7)::timestamp AT TIME ZONE tz, as_of);
  d7:=(today - 6)::timestamp AT TIME ZONE tz; d30:=(today - 29)::timestamp AT TIME ZONE tz;
  month_text:=coalesce(p_input->>'month', to_char(today,'YYYY-MM'));
  IF month_text='ALL' THEN c_from:='-infinity'; c_to:=as_of;
  ELSE
    month_start:=(month_text||'-01')::date;
    IF month_start < date '2000-01-01' OR month_start > today THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    c_from:=month_start::timestamp AT TIME ZONE tz; c_to:=least((month_start + interval '1 month') AT TIME ZONE tz, as_of);
  END IF;

  -- One week of check-ins by session start.
  SELECT coalesce(jsonb_agg(jsonb_build_object('date', w.d, 'time', w.t, 'checkIns', w.n) ORDER BY w.d, w.t), '[]'::jsonb) INTO week
  FROM (SELECT to_char(cs.starts_at AT TIME ZONE tz, 'YYYY-MM-DD') d, to_char(cs.starts_at AT TIME ZONE tz, 'HH24:MI') t,
      count(a.id) FILTER (WHERE a.status IN ('PRESENT','LATE','MAKEUP')) n
    FROM hon.class_sessions cs LEFT JOIN hon.attendance_records a ON a.class_session_id=cs.id AND a.organization_id=org AND a.school_id=school
    WHERE cs.organization_id=org AND cs.school_id=school AND cs.status<>'CANCELLED' AND cs.starts_at >= w_from AND cs.starts_at < w_to
    GROUP BY 1, 2) w;

  -- Average check-ins per scheduled class (weekday, start time, name) in the chosen month or all time.
  WITH held AS (
    SELECT extract(isodow FROM cs.starts_at AT TIME ZONE tz)::integer wd, to_char(cs.starts_at AT TIME ZONE tz, 'HH24:MI') t,
      coalesce(nullif(btrim(left(btrim(cs.name), 200)),''),'-') nm, coalesce(nullif(btrim(left(btrim(g.name), 200)),''),'-') program,
      (SELECT count(*) FROM hon.attendance_records a WHERE a.class_session_id=cs.id AND a.organization_id=org AND a.school_id=school
        AND a.status IN ('PRESENT','LATE','MAKEUP')) n
    FROM hon.class_sessions cs JOIN hon.programs g ON g.id=cs.program_id AND g.organization_id=org AND g.school_id=school
    WHERE cs.organization_id=org AND cs.school_id=school AND cs.status<>'CANCELLED' AND cs.starts_at >= c_from AND cs.starts_at < c_to),
  grouped AS (
    SELECT wd, t, nm, min(program) program, count(*) sessions, count(*) FILTER (WHERE n>0) with_check_ins, sum(n) check_ins
    FROM held GROUP BY wd, t, nm ORDER BY wd, t, nm LIMIT 300)
  SELECT jsonb_build_object('month', month_text,
      'truncated', (SELECT count(*) FROM (SELECT 1 FROM held GROUP BY wd, t, nm) q) > 300,
      'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('weekday', g.wd, 'time', g.t, 'name', g.nm, 'program', g.program,
        'sessions', g.sessions, 'sessionsWithCheckIns', g.with_check_ins, 'checkIns', g.check_ins) ORDER BY g.wd, g.t, g.nm) FROM grouped g), '[]'::jsonb))
    INTO classes;

  -- Active students now, with their last check-in, program and rank.
  WITH active AS (
    SELECT DISTINCT p.id profile_id, p.person_id
    FROM hon.school_dashboard_members(org, school) m
    JOIN hon.student_profiles p ON p.person_id=m.participant AND p.organization_id=org AND p.school_id=school
    WHERE m.started <= as_of AND (m.ended IS NULL OR m.ended > as_of)),
  seen AS (
    SELECT x.profile_id, max(cs.starts_at) last_at
    FROM active x JOIN hon.attendance_records a ON a.student_profile_id=x.profile_id AND a.organization_id=org AND a.school_id=school
      AND a.status IN ('PRESENT','LATE','MAKEUP')
    JOIN hon.class_sessions cs ON cs.id=a.class_session_id AND cs.organization_id=org AND cs.school_id=school
      AND cs.status<>'CANCELLED' AND cs.starts_at <= as_of
    GROUP BY x.profile_id),
  enrolled AS (
    SELECT DISTINCT ON (e.student_profile_id) e.student_profile_id profile_id, e.program_id, nullif(btrim(left(btrim(g.name), 200)),'') program, nullif(btrim(left(btrim(r.name), 200)),'') rank
    FROM active x JOIN hon.student_curriculum_enrollments e ON e.student_profile_id=x.profile_id AND e.organization_id=org AND e.school_id=school AND e.status='ACTIVE'
    LEFT JOIN hon.programs g ON g.id=e.program_id AND g.organization_id=org AND g.school_id=school
    LEFT JOIN hon.curriculum_ranks r ON r.id=e.current_rank_id AND r.organization_id=org AND r.school_id=school
    ORDER BY e.student_profile_id, e.enrolled_at, e.id),
  rows AS (
    SELECT x.profile_id, x.person_id, left(pp.given_name, 200) given_name, left(pp.family_name, 200) family_name, en.program_id, en.program, en.rank,
      se.last_at, coalesce(se.last_at >= d7, false) a7, coalesce(se.last_at >= d30, false) a30
    FROM active x JOIN hon.people pp ON pp.id=x.person_id AND pp.organization_id=org AND pp.school_id=school
    LEFT JOIN seen se ON se.profile_id=x.profile_id LEFT JOIN enrolled en ON en.profile_id=x.profile_id)
  SELECT (SELECT count(*) FROM rows),
    jsonb_build_object('activeStudents', (SELECT count(*) FROM rows), 'attended7Days', (SELECT count(*) FROM rows WHERE a7),
      'attended30Days', (SELECT count(*) FROM rows WHERE a30)),
    coalesce((SELECT jsonb_agg(jsonb_build_object('programId', q.program_id, 'name', q.program, 'activeStudents', q.n, 'attended30Days', q.a)
        ORDER BY q.n DESC, q.program NULLS LAST, q.program_id) FROM (
      SELECT program_id, min(program) program, count(*) n, count(*) FILTER (WHERE a30) a FROM rows GROUP BY program_id) q), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(jsonb_build_object('studentProfileId', r.profile_id, 'personId', r.person_id, 'givenName', r.given_name,
        'familyName', r.family_name, 'program', r.program, 'rank', r.rank,
        'lastCheckIn', CASE WHEN r.last_at IS NULL THEN NULL ELSE to_char(r.last_at AT TIME ZONE tz, 'YYYY-MM-DD') END,
        'attended7Days', r.a7, 'attended30Days', r.a30) ORDER BY r.last_at NULLS FIRST, r.family_name, r.given_name, r.profile_id)
      FROM (SELECT * FROM rows ORDER BY last_at NULLS FIRST, family_name, given_name, profile_id LIMIT 2000) r), '[]'::jsonb)
    INTO active_count, totals, programs, students;

  RETURN jsonb_build_object('schoolId', school, 'schoolName', s.name, 'timezone', tz,
    'generatedAt', to_char(as_of AT TIME ZONE 'UTC', utc), 'localToday', to_char(today, 'YYYY-MM-DD'),
    'savedCheckIns', (SELECT count(*) FROM hon.attendance_records a JOIN hon.class_sessions cs ON cs.id=a.class_session_id
      AND cs.organization_id=org AND cs.school_id=school AND cs.status<>'CANCELLED' AND cs.starts_at <= as_of
      WHERE a.organization_id=org AND a.school_id=school AND a.status IN ('PRESENT','LATE','MAKEUP')),
    'participation', totals,
    'week', jsonb_build_object('start', to_char(week_start, 'YYYY-MM-DD'), 'end', to_char(week_start + 6, 'YYYY-MM-DD'), 'sessions', week),
    'classes', classes, 'programs', programs,
    'students', jsonb_build_object('truncated', active_count > 2000, 'items', students));
END $$;
COMMENT ON FUNCTION hon.read_attendance_report(text,jsonb) IS
'Direct HUMAN_UI read-only attendance report for the session school (AR1, 0633): weekly check-ins by class time, participation, class averages, programs and active students'' last check-in. reporting.view; no DML.';

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.read_attendance_report(text,jsonb) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_attendance_report(text,jsonb) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_attendance_report(text,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
