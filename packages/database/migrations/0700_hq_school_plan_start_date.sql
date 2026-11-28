BEGIN;

-- HQ school plan start date (0700, allocated by the coordinator 2026-11-26; merges after 0699). Owner ask 2026-11-26
-- (David, on the create-school "Pick a plan" step): "It should set start date too right? So it can schedule payments".
--
-- Every ASSIGN revision now records start_date: the UTC day the plan starts, from one year ago to one year ahead, which the
-- later billing piece will use as the first billing date. A free plan's end date must fall after its start. Changing only
-- the start date is a change. REMOVE rows carry none. Existing ASSIGN rows are backfilled with the UTC day they were
-- recorded (the only UPDATE this append-only table ever gets, done here by the migration owner with the guard paused).
--
-- Still RECORDS only: no checkout, charge, schedule, subscription, entitlement or access change.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ school plan assignments require a trusted migration owner';
  END IF;
END $$;


ALTER TABLE hon.hq_school_plan_assignments ADD COLUMN start_date date;
ALTER TABLE hon.hq_school_plan_assignments DISABLE TRIGGER immutable;
UPDATE hon.hq_school_plan_assignments SET start_date = (recorded_at AT TIME ZONE 'UTC')::date WHERE action = 'ASSIGN';
ALTER TABLE hon.hq_school_plan_assignments ENABLE TRIGGER immutable;
ALTER TABLE hon.hq_school_plan_assignments
  ADD CONSTRAINT hq_school_plan_start_date_assign CHECK ((action = 'ASSIGN') = (start_date IS NOT NULL)),
  ADD CONSTRAINT hq_school_plan_free_after_start CHECK (free_until IS NULL OR free_until > start_date);

CREATE OR REPLACE FUNCTION hon.hq_school_plan_json(a hon.hq_school_plan_assignments) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('revision', a.revision, 'action', a.action, 'source', a.source, 'offerId', a.offer_id,
    'offerKind', a.offer_kind, 'offerSetVersion', a.offer_set_version, 'planName', a.plan_name,
    'billingInterval', a.billing_interval, 'priceMinor', a.price_minor, 'currency', a.currency, 'founder', a.founder,
    'freeUntil', to_char(a.free_until, 'YYYY-MM-DD'), 'startDate', to_char(a.start_date, 'YYYY-MM-DD'), 'note', a.note, 'schoolId', a.school_id,
    'recordedBy', hon.hq_marketing_person_json(a.actor_principal_id), 'recordedAt', hon.saas_ts(a.recorded_at))
$$;

CREATE OR REPLACE FUNCTION hon.assign_hq_school_plan(p_subject text, p_school uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; fp text; v_expected integer; v_plan jsonb; s hon.schools%ROWTYPE;
  n hon.hq_school_plan_assignments%ROWTYPE; cur hon.hq_school_plan_assignments%ROWTYPE; f hon.saas_offer_set_offers%ROWTYPE;
  at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  actor := hon.require_hq_school_plan_owner(p_subject);
  IF p_school IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) NOT IN (ARRAY['expectedRevision','note','plan'],
      ARRAY['expectedRevision','note','plan','startDate'])
    OR jsonb_typeof(p_input->'plan') IS DISTINCT FROM 'object'
    OR (p_input ? 'startDate' AND (jsonb_typeof(p_input->'startDate') IS DISTINCT FROM 'string'
      OR (p_input->>'startDate') !~ '^20[2-9][0-9]-[01][0-9]-[0-3][0-9]$')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_expected := hon.hq_school_plan_expected(p_input); v_plan := p_input->'plan';
  n.note := hon.hq_school_plan_note(p_input);
  IF v_plan->>'source' = 'OFFER' THEN
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_plan) k) IS DISTINCT FROM ARRAY['offerId','source']
      OR jsonb_typeof(v_plan->'offerId') IS DISTINCT FROM 'string'
      OR (v_plan->>'offerId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
    END IF;
  ELSIF v_plan->>'source' = 'CUSTOM' THEN
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_plan) k) IS DISTINCT FROM ARRAY['billingInterval','freeUntil','name','priceMinor','source']
      OR jsonb_typeof(v_plan->'name') IS DISTINCT FROM 'string' OR (v_plan->>'name') <> btrim(v_plan->>'name')
      OR length(v_plan->>'name') NOT BETWEEN 3 AND 80
      OR jsonb_typeof(v_plan->'billingInterval') IS DISTINCT FROM 'string' OR (v_plan->>'billingInterval') NOT IN ('MONTHLY','ANNUAL')
      OR jsonb_typeof(v_plan->'priceMinor') IS DISTINCT FROM 'number' OR (v_plan->>'priceMinor') !~ '^(0|[1-9][0-9]{0,7})$'
      OR (v_plan->>'priceMinor')::bigint > 10000000
      OR NOT (jsonb_typeof(v_plan->'freeUntil') = 'null'
        OR (jsonb_typeof(v_plan->'freeUntil') = 'string' AND (v_plan->>'freeUntil') ~ '^20[2-9][0-9]-[01][0-9]-[0-3][0-9]$')) THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  fp := hon.saas_fingerprint(ARRAY['hq.school_plan.assign', p_school::text, p_input::text]);
  replay := hon.hq_school_plan_claim(actor, p_key, 'ASSIGN', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_school_plan_owner(p_subject); RETURN replay; END IF;
  s := hon.hq_school_plan_lock(p_school, v_expected, true);

  n.organization_id := s.organization_id; n.revision := v_expected + 1; n.school_id := s.id; n.action := 'ASSIGN';
  n.source := v_plan->>'source'; n.currency := 'USD'; n.actor_principal_id := actor; n.recorded_at := at;
  -- 0700: the day the plan starts (UTC). Missing = today, so an API built before 0700 keeps working during a deploy.
  BEGIN n.start_date := COALESCE((p_input->>'startDate')::date, (at AT TIME ZONE 'UTC')::date);
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END;
  IF n.start_date < ((at AT TIME ZONE 'UTC') - interval '1 year')::date OR n.start_date > ((at AT TIME ZONE 'UTC') + interval '1 year')::date THEN
    RAISE EXCEPTION 'HQ_SCHOOL_PLAN_START_INVALID' USING ERRCODE = '23514';
  END IF;
  IF n.source = 'OFFER' THEN
    -- Only an offer of the published set that HQ has not stopped. Its terms are frozen here; a later offer version never
    -- changes this record.
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('saas.offer_sets', 0));
    SELECT o.* INTO f FROM hon.saas_offer_set_offers o JOIN hon.saas_offer_sets st ON st.id = o.set_id
    WHERE o.id = (v_plan->>'offerId')::uuid AND st.status = 'PUBLISHED'
      AND NOT EXISTS (SELECT 1 FROM hon.saas_offer_sales_stops x WHERE x.offer_id = o.id);
    IF f.id IS NULL THEN RAISE EXCEPTION 'HQ_SCHOOL_PLAN_OFFER_NOT_AVAILABLE' USING ERRCODE = '23514'; END IF;
    n.offer_id := f.id; n.offer_kind := f.offer_kind; n.plan_name := f.display_name; n.billing_interval := f.billing_interval;
    n.price_minor := f.price_minor; n.founder := f.founder;
    SELECT st.set_version INTO n.offer_set_version FROM hon.saas_offer_sets st WHERE st.id = f.set_id;
  ELSE
    n.plan_name := v_plan->>'name'; n.billing_interval := v_plan->>'billingInterval';
    n.price_minor := (v_plan->>'priceMinor')::bigint; n.founder := false;
    BEGIN n.free_until := (v_plan->>'freeUntil')::date;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END;
    IF n.price_minor > 0 AND n.free_until IS NOT NULL THEN
      RAISE EXCEPTION 'HQ_SCHOOL_PLAN_END_DATE_ONLY_WHEN_FREE' USING ERRCODE = '23514';
    END IF;
    IF n.free_until IS NOT NULL AND (n.free_until <= (at AT TIME ZONE 'UTC')::date
        OR n.free_until > ((at AT TIME ZONE 'UTC') + interval '3 years')::date) THEN
      RAISE EXCEPTION 'HQ_SCHOOL_PLAN_FREE_END_INVALID' USING ERRCODE = '23514';
    END IF;
    IF n.free_until IS NOT NULL AND n.free_until <= n.start_date THEN
      RAISE EXCEPTION 'HQ_SCHOOL_PLAN_FREE_END_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;
  cur := hon.hq_school_plan_current(s.organization_id);
  IF cur.action = 'ASSIGN' AND (cur.source, cur.offer_id, cur.plan_name, cur.billing_interval, cur.price_minor, cur.free_until, cur.start_date)
      IS NOT DISTINCT FROM (n.source, n.offer_id, n.plan_name, n.billing_interval, n.price_minor, n.free_until, n.start_date) THEN
    RAISE EXCEPTION 'HQ_SCHOOL_PLAN_NO_CHANGE' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.hq_school_plan_assignments SELECT n.*;
  result := jsonb_build_object('operation', 'ASSIGN', 'schoolId', s.id, 'organizationId', s.organization_id,
    'assignment', hon.hq_school_plan_json(n), 'effect', 'RECORD_ONLY', 'charging', 'OFF');
  INSERT INTO hon.hq_school_plan_requests VALUES (actor, p_key, 'ASSIGN', fp, s.organization_id, n.revision, result, at);
  PERFORM hon.require_hq_school_plan_owner(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- CREATE OR REPLACE keeps each function's owner and ACL; restate them so the result never depends on that.
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hq_school_plan_json(hon.hq_school_plan_assignments)','assign_hq_school_plan(text,uuid,jsonb,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.assign_hq_school_plan(text,uuid,jsonb,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
