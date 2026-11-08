BEGIN;

-- Forward-paging class-session list (0221, allocated by the owner 2026-11-08). One read-only SECURITY DEFINER
-- projection of the current school's class sessions starting on or after a school-local date (default: the school's
-- local today), in the published order of 0203 (UTC millisecond startsAt, then id), keyset-paginated with no fixed
-- 50-row or 91-day cap. It keeps 0147's boundary: runtime still reads sessions only through named projections, and the
-- same private actor helper (direct human, schedule.session.read live at the current school, organization/school
-- lifecycle, entitlement) decides access before and after the read. Every row has exactly the 0147/0203 fields. It
-- writes nothing, takes no lock and changes no command, table, permission or grant. The page cursor is signed by the
-- API; this function only receives the plain keyset position.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Class-session pages require a trusted migration owner';
  END IF;
END $$;

CREATE FUNCTION hon.read_school_class_session_page(subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; actor uuid; lim integer:=50; tz text; at timestamptz:=clock_timestamp();
  local_today date; from_date date; from_at timestamptz; after_at timestamptz; after_id uuid; items jsonb; more boolean;
BEGIN
  actor:=hon.require_current_school_class_sessions_read_actor(subject);
  org:=hon.current_organization_id(); school:=hon.current_school_id();

  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('limit','fromDate','afterStartsAt','afterId'))
    OR (p ? 'limit' AND (jsonb_typeof(p->'limit') IS DISTINCT FROM 'number' OR (p->'limit')::text !~ '^[1-9][0-9]{0,2}$' OR (p->>'limit')::integer>100))
    OR (p ? 'fromDate' AND (jsonb_typeof(p->'fromDate') IS DISTINCT FROM 'string' OR p->>'fromDate' !~ '^(20[0-9]{2}|2100)-[0-9]{2}-[0-9]{2}$'))
    OR (p ? 'afterStartsAt') IS DISTINCT FROM (p ? 'afterId')
    OR (p ? 'afterStartsAt' AND (jsonb_typeof(p->'afterStartsAt') IS DISTINCT FROM 'string'
      OR p->>'afterStartsAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}000Z$'))
    OR (p ? 'afterId' AND (jsonb_typeof(p->'afterId') IS DISTINCT FROM 'string'
      OR p->>'afterId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p ? 'limit' THEN lim:=(p->>'limit')::integer; END IF;
  IF p ? 'fromDate' THEN
    -- to_date rejects an impossible calendar date (2026-02-30, month 13) with a field-out-of-range error.
    BEGIN from_date:=to_date(p->>'fromDate','YYYY-MM-DD');
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END;
  END IF;
  IF p ? 'afterId' THEN after_at:=(p->>'afterStartsAt')::timestamptz; after_id:=(p->>'afterId')::uuid; END IF;

  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN
    RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  local_today:=(at AT TIME ZONE tz)::date;
  from_date:=coalesce(from_date,local_today);
  -- School-local midnight is a whole second, so comparing persisted starts_at selects exactly the rows whose published
  -- millisecond is on or after it.
  from_at:=from_date::timestamp AT TIME ZONE tz;

  WITH page AS MATERIALIZED (
    SELECT session.*,date_trunc('milliseconds',session.starts_at AT TIME ZONE 'UTC') AS published
    FROM hon.class_sessions session
    WHERE session.organization_id=org AND session.school_id=school
      AND session.starts_at>=from_at
      -- A later position: published millisecond then id (0203's rule). starts_at>=after_at is implied and lets the
      -- range use the starts_at index.
      AND (after_id IS NULL OR (session.starts_at>=after_at
        AND (date_trunc('milliseconds',session.starts_at AT TIME ZONE 'UTC'),session.id)>((after_at AT TIME ZONE 'UTC'),after_id)))
    ORDER BY date_trunc('milliseconds',session.starts_at AT TIME ZONE 'UTC'),session.id LIMIT lim+1
  ), shaped AS (
    SELECT q.*,row_number() OVER (ORDER BY q.published,q.id) rn FROM page q
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'sessionId',s.id,
      'name',s.name,
      'startsAt',to_char(s.published,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'endsAt',to_char(s.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'roomName',s.room_name,
      'capacity',s.capacity,
      'bookingPolicy',s.booking_policy,
      'status',s.status::text,
      'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'cursorStartsAt',to_char(s.published,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) ORDER BY s.published,s.id) FILTER (WHERE s.rn<=lim),'[]'::jsonb),count(*)>lim
    INTO items,more FROM shaped s;

  -- A recheck prevents returning a captured projection after a live access loss.
  IF hon.require_current_school_class_sessions_read_actor(subject) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CLASS_SESSIONS_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('items',items,'hasMore',more,'limit',lim,'schoolTimezone',tz,
    'localToday',to_char(local_today,'YYYY-MM-DD'),'fromDate',to_char(from_date,'YYYY-MM-DD'));
END $$;

COMMENT ON FUNCTION hon.read_school_class_session_page(text,jsonb) IS
'Direct HUMAN_UI read-only forward page of the current school''s class sessions starting on or after a school-local date (default local today), ordered by published UTC millisecond startsAt then id (0203), keyset-paginated, 1-100 rows. Same private actor helper as read_current_school_class_sessions (schedule.session.read), re-checked after the read. Same fields as 0147/0203. No DML, locks, audit, outbox or idempotency.';

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.read_school_class_session_page(text,jsonb) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_school_class_session_page(text,jsonb) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_class_session_page(text,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
