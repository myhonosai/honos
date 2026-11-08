BEGIN;

-- U6 school-wide membership list (0220, allocated by the owner 2026-11-08). One read-only SECURITY DEFINER projection
-- of the current school's memberships, newest first, keyset-paginated, with each row's lifecycle state and its
-- reporting status (SCHEDULED / IN_EFFECT / ENDED / UNDATED, exactly as hon.read_membership_date_history derives it).
-- It is a function because the confirmed-date evidence (membership_effective_periods, membership_date_revisions) is
-- private to runtime. It writes nothing, takes no lock, exposes no money, reasons, payer or agreement facts, and
-- changes no command. The page cursor is signed by the API; this function only receives the plain keyset position.
CREATE FUNCTION hon.read_school_membership_list(subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; permission text; used text;
  lim integer:=50; wanted hon.membership_state; after_at timestamptz; after_id uuid; tz text; at timestamptz:=clock_timestamp();
  items jsonb; more boolean;
BEGIN
  -- Any one of the history permissions, live at the current school (same set as the per-membership history read).
  FOREACH permission IN ARRAY ARRAY['billing.membership.read','billing.membership.activate','billing.membership.dates.revise'] LOOP
    BEGIN actor:=hon.require_membership_lifecycle_actor(subject,permission); used:=permission; EXIT;
    EXCEPTION WHEN SQLSTATE '42501' THEN actor:=NULL; END;
  END LOOP;
  IF actor IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_LIST_FORBIDDEN' USING ERRCODE='42501'; END IF;

  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('limit','state','afterCreatedAt','afterId'))
    OR (p ? 'limit' AND (jsonb_typeof(p->'limit') IS DISTINCT FROM 'number' OR (p->'limit')::text !~ '^[1-9][0-9]{0,2}$' OR (p->>'limit')::integer>100))
    OR (p ? 'state' AND (jsonb_typeof(p->'state') IS DISTINCT FROM 'string'
      OR NOT (p->>'state' = ANY(enum_range(NULL::hon.membership_state)::text[]))))
    OR (p ? 'afterCreatedAt') IS DISTINCT FROM (p ? 'afterId')
    OR (p ? 'afterCreatedAt' AND (jsonb_typeof(p->'afterCreatedAt') IS DISTINCT FROM 'string'
      OR p->>'afterCreatedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'))
    OR (p ? 'afterId' AND (jsonb_typeof(p->'afterId') IS DISTINCT FROM 'string'
      OR p->>'afterId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p ? 'limit' THEN lim:=(p->>'limit')::integer; END IF;
  IF p ? 'state' THEN wanted:=(p->>'state')::hon.membership_state; END IF;
  IF p ? 'afterId' THEN after_at:=(p->>'afterCreatedAt')::timestamptz; after_id:=(p->>'afterId')::uuid; END IF;

  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN
    RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;

  WITH page AS MATERIALIZED (
    SELECT m.* FROM hon.memberships m
    WHERE m.organization_id=org AND m.school_id=school
      AND (wanted IS NULL OR m.state=wanted)
      AND (after_id IS NULL OR (m.created_at,m.id)<(after_at,after_id))
    ORDER BY m.created_at DESC,m.id DESC LIMIT lim+1
  ), shaped AS (
    SELECT q.id,q.created_at,row_number() OVER (ORDER BY q.created_at DESC,q.id DESC) rn,cur.period cur,q.state,q.term_started_at,q.term_ends_at,
      q.version,q.plan_code,q.billing_account_id,q.participant_person_id
    FROM page q CROSS JOIN LATERAL (SELECT hon.membership_current_period(q.id) period) cur
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'membershipId',s.id,'state',s.state::text,'version',s.version,'planCode',s.plan_code,'billingAccountId',s.billing_account_id,
      'participant',(SELECT jsonb_build_object('personId',pp.id,'givenName',pp.given_name,'familyName',pp.family_name)
        FROM hon.people pp WHERE pp.id=s.participant_person_id AND pp.organization_id=org AND pp.school_id=school),
      'effectiveStatus',hon.membership_reporting_status(s.state,s.term_started_at,s.term_ends_at,s.cur IS NOT NULL,at),
      'datesConfirmed',s.cur IS NOT NULL,
      'currentPeriod',CASE WHEN s.cur IS NULL THEN NULL ELSE jsonb_build_object('periodVersion',s.cur->'periodVersion','changeKind',s.cur->'changeKind',
        'startDate',s.cur->'startDate','endDate',s.cur->'endDate') END,
      'legacyStoredTerm',CASE WHEN s.cur IS NOT NULL THEN NULL ELSE jsonb_build_object('termStartedAt',hon.membership_instant_text(s.term_started_at),
        'termEndsAt',hon.membership_instant_text(s.term_ends_at)) END,
      'createdAt',hon.membership_instant_text(s.created_at),
      'cursorCreatedAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) ORDER BY s.created_at DESC,s.id DESC) FILTER (WHERE s.rn<=lim),'[]'::jsonb),count(*)>lim
    INTO items,more FROM shaped s;

  -- A recheck prevents returning a captured projection after a live access loss.
  IF hon.require_membership_lifecycle_actor(subject,used) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_LIST_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('items',items,'hasMore',more,'limit',lim,'schoolTimezone',tz,'localToday',hon.membership_local_date(at,tz));
END $$;

COMMENT ON FUNCTION hon.read_school_membership_list(text,jsonb) IS
'U6 direct HUMAN_UI read-only list of the current school''s memberships, newest first (created_at, id), keyset-paginated: lifecycle state, reporting status derived from confirmed periods (UNDATED when none), current confirmed period dates or legacy stored instants as hints, plan code, participant name. Any of billing.membership.read/activate/dates.revise live at the school, re-checked after the read. No DML, locks, audit, outbox, idempotency, money or reasons.';

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.read_school_membership_list(text,jsonb) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_school_membership_list(text,jsonb) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_membership_list(text,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
