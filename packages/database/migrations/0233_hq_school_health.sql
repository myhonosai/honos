BEGIN;

-- B-HQ-2b HQ school health (0233, approved by the owner 2026-11-09). Read-only activity counts per school so HQ can see
-- which schools may need help: attendance, classes, bookings, leads, active students and open HQ support cases, over the
-- last 30 days against the 30 before, plus advisory signals derived only from those counts. It names no person, shows no
-- money, writes nothing, takes no lock and sends nothing. Signals are hints for a person to look, never an outcome.
-- Readers: an HQ owner; an HQ operator with hq.billing.manage (the SaaS HQ reader rule, as the school detail); or HQ
-- staff holding hq.support.manage (the support rule, 0232). Authority is decided again after the read (0206 rule).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ school health requires a trusted migration owner';
  END IF;
END $$;

-- The reader: SaaS HQ reader first, else HQ support staff. Raises SAAS_FORBIDDEN (42501) for anyone else. Never granted.
CREATE FUNCTION hon.require_hq_health_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  BEGIN
    RETURN hon.require_saas_hq_actor(p_subject, false);
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN hon.require_hq_support_actor(p_subject);
  END;
END $$;

-- One school's health facts at p_at. Windows are the 30 days before p_at and the 30 days before that. Internal: never granted.
CREATE FUNCTION hon.hq_school_health_facts(p_school uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE d30 timestamptz := p_at - interval '30 days'; d60 timestamptz := p_at - interval '60 days'; d14 timestamptz := p_at - interval '14 days';
  att_now integer; att_prev integer; att_last timestamptz; held integer; upcoming integer; booked integer;
  leads_now integer; leads_prev integer; won integer; open_leads integer; students integer; cases integer; signals text[] := '{}';
BEGIN
  -- Attendance that counts as a visit (present, late or make-up), by when it was recorded.
  SELECT count(*) FILTER (WHERE recorded_at > d30), count(*) FILTER (WHERE recorded_at > d60 AND recorded_at <= d30), max(recorded_at)
    INTO att_now, att_prev, att_last
    FROM hon.attendance_records WHERE school_id = p_school AND status IN ('PRESENT','LATE','MAKEUP') AND recorded_at <= p_at;
  SELECT count(*) FILTER (WHERE starts_at > d30 AND starts_at <= p_at AND status IN ('SCHEDULED','COMPLETED')),
         count(*) FILTER (WHERE starts_at > p_at AND starts_at <= p_at + interval '14 days' AND status = 'SCHEDULED')
    INTO held, upcoming FROM hon.class_sessions WHERE school_id = p_school AND starts_at > d30;
  SELECT count(*) INTO booked FROM hon.class_bookings WHERE school_id = p_school AND booked_at > d30 AND booked_at <= p_at;
  SELECT count(*) FILTER (WHERE created_at > d30 AND created_at <= p_at), count(*) FILTER (WHERE created_at > d60 AND created_at <= d30),
         count(*) FILTER (WHERE won_at > d30 AND won_at <= p_at), count(*) FILTER (WHERE status = 'OPEN')
    INTO leads_now, leads_prev, won, open_leads FROM hon.crm_leads WHERE school_id = p_school;
  SELECT count(*) INTO students FROM hon.student_profiles WHERE school_id = p_school AND status = 'ACTIVE';
  SELECT count(*) INTO cases FROM hon.hq_support_cases WHERE school_id = p_school AND status IN ('OPEN','WAITING_ON_SCHOOL');

  IF students = 0 THEN signals := array_append(signals, 'NO_ACTIVE_STUDENTS'); END IF;
  IF students > 0 AND (att_last IS NULL OR att_last <= d14) THEN signals := array_append(signals, 'NO_ATTENDANCE_14_DAYS'); END IF;
  IF att_prev >= 10 AND att_now * 2 < att_prev THEN signals := array_append(signals, 'ATTENDANCE_DOWN'); END IF;
  IF upcoming = 0 THEN signals := array_append(signals, 'NO_CLASSES_NEXT_14_DAYS'); END IF;
  IF leads_now = 0 THEN signals := array_append(signals, 'NO_NEW_LEADS_30_DAYS'); END IF;
  IF cases > 0 THEN signals := array_append(signals, 'OPEN_SUPPORT_CASES'); END IF;

  RETURN jsonb_build_object(
    'attendance', jsonb_build_object('last30Days', att_now, 'previous30Days', att_prev, 'lastRecordedAt', hon.saas_ts(att_last)),
    'classes', jsonb_build_object('heldLast30Days', held, 'scheduledNext14Days', upcoming),
    'bookingsLast30Days', booked,
    'leads', jsonb_build_object('newLast30Days', leads_now, 'newPrevious30Days', leads_prev, 'wonLast30Days', won, 'open', open_leads),
    'activeStudents', students,
    'openSupportCases', cases,
    'signals', to_jsonb(signals));
END $$;

-- One school's health.
CREATE FUNCTION hon.read_hq_school_health(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE s hon.schools%ROWTYPE; at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  PERFORM hon.require_hq_health_actor(p_subject);
  IF p_school IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO s FROM hon.schools WHERE id = p_school;
  IF s.id IS NULL THEN RAISE EXCEPTION 'HQ_SCHOOL_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  result := jsonb_build_object('schoolId', s.id, 'health', hon.hq_school_health_facts(s.id, at), 'asOf', hon.saas_ts(at));
  PERFORM hon.require_hq_health_actor(p_subject);
  RETURN result;
END $$;

-- Schools with at least one signal, most signals first (then name), at most p_limit (1..200). `checked` is how many schools
-- were looked at; `truncated` says more schools carry signals than were returned.
CREATE FUNCTION hon.read_hq_schools_needing_attention(p_subject text, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE at timestamptz := clock_timestamp(); rows jsonb; flagged integer; checked integer; result jsonb;
BEGIN
  PERFORM hon.require_hq_health_actor(p_subject);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  WITH facts AS (
    SELECT s.id, left(s.name, 300) AS school_name, s.organization_id, left(coalesce(o.display_name, o.legal_name), 300) AS org_name,
      hon.hq_school_health_facts(s.id, at) AS h
    FROM hon.schools s JOIN hon.organizations o ON o.id = s.organization_id
    WHERE s.status = 'ACTIVE'
  ), flagged_rows AS (
    SELECT *, jsonb_array_length(h->'signals') AS n FROM facts WHERE jsonb_array_length(h->'signals') > 0
  )
  SELECT (SELECT count(*) FROM facts), (SELECT count(*) FROM flagged_rows),
    coalesce((SELECT jsonb_agg(jsonb_build_object('schoolId', f.id, 'schoolDisplayName', f.school_name, 'organizationId', f.organization_id,
        'organizationDisplayName', f.org_name, 'health', f.h) ORDER BY f.n DESC, f.school_name, f.id)
      FROM (SELECT * FROM flagged_rows ORDER BY n DESC, school_name, id LIMIT p_limit) f), '[]'::jsonb)
    INTO checked, flagged, rows;
  result := jsonb_build_object('schools', rows, 'checked', checked, 'flagged', flagged, 'truncated', flagged > p_limit, 'limit', p_limit,
    'asOf', hon.saas_ts(at));
  PERFORM hon.require_hq_health_actor(p_subject);
  RETURN result;
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['require_hq_health_actor(text)','hq_school_health_facts(uuid,timestamptz)','read_hq_school_health(text,uuid)',
    'read_hq_schools_needing_attention(text,integer)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_hq_school_health(text,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_hq_schools_needing_attention(text,integer) TO hon_runtime;
  END IF;
END $$;

COMMIT;
