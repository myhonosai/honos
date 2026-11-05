BEGIN;

-- Class Sessions current-school read: one deterministic ordering rule.
--
-- 0147 ordered and bounded the list by full PostgreSQL microsecond starts_at
-- then id, but published startsAt truncated to milliseconds, and the closed API
-- contract validates order by (published startsAt, sessionId). Two sessions in
-- the same published millisecond whose microsecond order disagreed with their
-- UUID order therefore failed contract verification (HTTP 500), and the 50-row
-- boundary could keep a row the published rule places 51st.
--
-- This replaces only the projection body (0147 is applied and unchanged). The
-- single rule is now: published UTC millisecond startsAt (truncated, the same
-- value that is published), then id. Signature, SECURITY DEFINER, VOLATILE,
-- search_path, owner, ACL (CREATE OR REPLACE keeps grants), the private actor
-- helper, both authorization calls, window, LIMIT 50 and every field are
-- unchanged. No table, permission, entitlement or grant is altered.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Class-session read ordering requires a trusted migration owner';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.read_current_school_class_sessions(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE window_start timestamptz; window_end timestamptz; result jsonb;
BEGIN
  PERFORM hon.require_current_school_class_sessions_read_actor(p_subject);
  window_start := (date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC') - interval '30 days') AT TIME ZONE 'UTC';
  window_end := (date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC') + interval '91 days') AT TIME ZONE 'UTC';
  -- Window bounds are whole UTC days, so filtering on persisted starts_at selects
  -- exactly the rows whose published millisecond lies in the window.
  SELECT coalesce(jsonb_agg(item.item ORDER BY item.published_starts_at, item.id), '[]'::jsonb) INTO result
  FROM (
    SELECT session.id, published.starts_at AS published_starts_at, jsonb_build_object(
      'sessionId', session.id,
      'name', session.name,
      'startsAt', to_char(published.starts_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'endsAt', to_char(session.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'roomName', session.room_name,
      'capacity', session.capacity,
      'bookingPolicy', session.booking_policy,
      'status', session.status::text,
      'createdAt', to_char(session.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) AS item
    FROM hon.class_sessions AS session
    CROSS JOIN LATERAL (SELECT date_trunc('milliseconds', session.starts_at AT TIME ZONE 'UTC') AS starts_at) AS published
    WHERE session.organization_id = hon.current_organization_id()
      AND session.school_id = hon.current_school_id()
      AND session.starts_at >= window_start AND session.starts_at < window_end
    ORDER BY published.starts_at, session.id
    LIMIT 50
  ) AS item;
  -- A recheck prevents returning a captured projection after a live access loss.
  PERFORM hon.require_current_school_class_sessions_read_actor(p_subject);
  RETURN result;
END $$;

-- The replacement must keep 0147's posture; ACL is inherited, never widened.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'hon.read_current_school_class_sessions(text)'::regprocedure
      AND prosecdef AND provolatile = 'v' AND proconfig = ARRAY['search_path=pg_catalog, hon'])
    OR EXISTS (SELECT 1 FROM pg_proc AS proc CROSS JOIN LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS privilege
      WHERE proc.oid IN ('hon.read_current_school_class_sessions(text)'::regprocedure, 'hon.require_current_school_class_sessions_read_actor(text)'::regprocedure)
        AND privilege.grantee = 0) THEN
    RAISE EXCEPTION 'Class-session read ordering replacement changed function posture';
  END IF;
END $$;

COMMIT;
