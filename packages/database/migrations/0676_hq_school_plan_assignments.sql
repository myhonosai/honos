BEGIN;

-- HQ school plan assignments (0676, allocated by the coordinator 2026-11-24). Owner ask 2026-11-24: "I don't even know how
-- to assign [published offers] to a school ... open or add school then give it a plan from what you have published or a
-- custom plan I set ... remove plan or change pricing." Modelled on GoHighLevel's "assign SaaS plan" and "special price"
-- for one sub-account.
--
-- An HQ owner records which HON OS plan a school's organization is on: one offer of the published offer set (0181), frozen
-- at the moment of assignment, or a custom plan for that organization only (name, monthly or annual, price; a free custom
-- plan may carry an optional end date; owner decision 2026-11-24: free may last forever). Changing the plan appends a new revision; removing appends a REMOVE revision. Nothing is
-- ever updated or deleted.
--
-- This piece only RECORDS the plan. It never opens a checkout, charges, refunds, changes a subscription, an entitlement,
-- paid access, credits, an offer or a founder spot. A later, separately approved billing piece decides how a school buys
-- its assigned plan.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ school plan assignments require a trusted migration owner';
  END IF;
END $$;

CREATE TABLE hon.hq_school_plan_assignments (
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 999999),
  school_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('ASSIGN','REMOVE')),
  source text CHECK (source IN ('OFFER','CUSTOM')),
  offer_id uuid REFERENCES hon.saas_offer_set_offers(id) ON DELETE RESTRICT,
  offer_kind text CHECK (offer_kind IN ('REGULAR_MONTHLY','REGULAR_ANNUAL','FOUNDER_MONTHLY','FOUNDER_ANNUAL','LIFETIME','FOUNDER_LIFETIME')),
  offer_set_version integer CHECK (offer_set_version > 0),
  plan_name text CHECK (plan_name = btrim(plan_name) AND length(plan_name) BETWEEN 3 AND 80),
  billing_interval text CHECK (billing_interval IN ('MONTHLY','ANNUAL','ONE_TIME')),
  price_minor bigint CHECK (price_minor BETWEEN 0 AND 10000000),
  currency text CHECK (currency = 'USD'),
  founder boolean,
  free_until date,
  note text CHECK (note = btrim(note) AND length(note) BETWEEN 1 AND 300),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, revision),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id),
  CHECK ((action = 'REMOVE') = (source IS NULL)),
  CHECK (action = 'REMOVE' OR (plan_name IS NOT NULL AND billing_interval IS NOT NULL AND price_minor IS NOT NULL
    AND currency IS NOT NULL AND founder IS NOT NULL)),
  CHECK (action = 'ASSIGN' OR (offer_id IS NULL AND offer_kind IS NULL AND offer_set_version IS NULL AND plan_name IS NULL
    AND billing_interval IS NULL AND price_minor IS NULL AND currency IS NULL AND founder IS NULL AND free_until IS NULL)),
  CHECK ((source = 'OFFER') = (offer_id IS NOT NULL) AND (offer_id IS NULL) = (offer_kind IS NULL)
    AND (offer_id IS NULL) = (offer_set_version IS NULL)),
  CHECK (source IS DISTINCT FROM 'CUSTOM' OR (billing_interval IN ('MONTHLY','ANNUAL') AND NOT founder)),
  -- Only a free custom plan may carry an end date (optional: owner decision 2026-11-24, free may last forever).
  CHECK (free_until IS NULL OR (source = 'CUSTOM' AND price_minor = 0))
);
CREATE INDEX hq_school_plan_assignments_school_idx ON hon.hq_school_plan_assignments (school_id, revision DESC);

CREATE TABLE hon.hq_school_plan_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('ASSIGN','REMOVE')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id),
  revision integer NOT NULL,
  response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (actor_principal_id, idempotency_key),
  FOREIGN KEY (organization_id, revision) REFERENCES hon.hq_school_plan_assignments(organization_id, revision)
);

CREATE FUNCTION hon.guard_hq_school_plan_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN RAISE EXCEPTION 'HQ_SCHOOL_PLAN_IMMUTABLE' USING ERRCODE = '42501'; END $$;
DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_school_plan_assignments','hq_school_plan_requests'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_school_plan_evidence()', t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_school_plan_evidence()', t);
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
    END LOOP;
  END LOOP;
END $$;

-- ---------- authority ----------
-- Commands: a current HQ owner (pricing a customer is commercial policy). Reads: an HQ owner, or an HQ operator holding
-- hq.billing.manage (the existing SaaS billing read rule).
CREATE FUNCTION hon.require_hq_school_plan_owner(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
BEGIN RETURN hon.require_saas_hq_actor(p_subject, true); END $$;

CREATE FUNCTION hon.hq_school_plan_owner_eligible(p_principal uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p_principal AND g.hq_role = 'HON_HQ_OWNER'
    AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp()))
$$;

-- ---------- projections ----------
CREATE FUNCTION hon.hq_school_plan_json(a hon.hq_school_plan_assignments) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('revision', a.revision, 'action', a.action, 'source', a.source, 'offerId', a.offer_id,
    'offerKind', a.offer_kind, 'offerSetVersion', a.offer_set_version, 'planName', a.plan_name,
    'billingInterval', a.billing_interval, 'priceMinor', a.price_minor, 'currency', a.currency, 'founder', a.founder,
    'freeUntil', to_char(a.free_until, 'YYYY-MM-DD'), 'note', a.note, 'schoolId', a.school_id,
    'recordedBy', hon.hq_marketing_person_json(a.actor_principal_id), 'recordedAt', hon.saas_ts(a.recorded_at))
$$;

-- The published offers HQ can assign: in the PUBLISHED set and not stopped (a closed public sales window does not stop HQ
-- from assigning an offer to one school).
CREATE FUNCTION hon.hq_school_plan_offers() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('offerId', f.id, 'offerCode', f.offer_code, 'offerKind', f.offer_kind,
      'billingInterval', f.billing_interval, 'founder', f.founder, 'displayName', f.display_name, 'priceMinor', f.price_minor,
      'currency', f.currency, 'offerSetVersion', s.set_version) ORDER BY f.position), '[]'::jsonb)
  FROM hon.saas_offer_set_offers f JOIN hon.saas_offer_sets s ON s.id = f.set_id
  WHERE s.status = 'PUBLISHED' AND NOT EXISTS (SELECT 1 FROM hon.saas_offer_sales_stops x WHERE x.offer_id = f.id)
$$;

CREATE FUNCTION hon.hq_school_plan_current(p_org uuid) RETURNS hon.hq_school_plan_assignments
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT a FROM hon.hq_school_plan_assignments a WHERE a.organization_id = p_org ORDER BY a.revision DESC LIMIT 1
$$;

CREATE FUNCTION hon.hq_school_plan_view(p_actor uuid, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE s hon.schools%ROWTYPE; o hon.organizations%ROWTYPE; cur hon.hq_school_plan_assignments%ROWTYPE; at timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO s FROM hon.schools WHERE id = p_school;
  IF s.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO o FROM hon.organizations WHERE id = s.organization_id;
  cur := hon.hq_school_plan_current(s.organization_id);
  RETURN jsonb_build_object('schoolId', s.id, 'organizationId', s.organization_id, 'schoolName', s.name,
    'schoolStatus', s.status::text, 'organizationStatus', o.status::text,
    'revision', coalesce(cur.revision, 0),
    'current', CASE WHEN cur.action = 'ASSIGN' THEN hon.hq_school_plan_json(cur) END,
    'history', (SELECT coalesce(jsonb_agg(hon.hq_school_plan_json(a) ORDER BY a.revision DESC), '[]'::jsonb)
      FROM (SELECT * FROM hon.hq_school_plan_assignments a WHERE a.organization_id = s.organization_id ORDER BY a.revision DESC LIMIT 50) a),
    'onNow', hon.hq_plan_promotion_school_plan(s.organization_id, at),
    'offers', hon.hq_school_plan_offers(),
    'viewer', hon.hq_marketing_person_json(p_actor) || jsonb_build_object('canManage', hon.hq_school_plan_owner_eligible(p_actor)),
    'effect', 'RECORD_ONLY', 'charging', 'OFF', 'asOf', hon.saas_ts(at));
END $$;

-- ---------- input helpers ----------
CREATE FUNCTION hon.hq_school_plan_claim(p_actor uuid, p_key uuid, p_operation text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prior hon.hq_school_plan_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hq-school-plan:' || p_actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO prior FROM hon.hq_school_plan_requests WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.operation <> p_operation OR prior.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
  RETURN prior.response || jsonb_build_object('replayed', true);
END $$;

-- Locks the organization's plan history and checks the expected revision (0 when no plan was ever recorded).
CREATE FUNCTION hon.hq_school_plan_lock(p_school uuid, p_expected integer, p_assign boolean) RETURNS hon.schools
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE s hon.schools%ROWTYPE; o hon.organizations%ROWTYPE; rev integer;
BEGIN
  SELECT * INTO s FROM hon.schools WHERE id = p_school;
  IF s.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hq-school-plan:' || s.organization_id::text, 0));
  SELECT * INTO o FROM hon.organizations WHERE id = s.organization_id;
  IF p_assign AND (s.status::text = 'ARCHIVED' OR o.status::text = 'ARCHIVED') THEN
    RAISE EXCEPTION 'HQ_SCHOOL_PLAN_SCHOOL_ARCHIVED' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max(revision), 0) INTO rev FROM hon.hq_school_plan_assignments WHERE organization_id = s.organization_id;
  IF rev <> p_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  RETURN s;
END $$;

CREATE FUNCTION hon.hq_school_plan_expected(p_input jsonb) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF jsonb_typeof(p_input->'expectedRevision') IS DISTINCT FROM 'number'
    OR (p_input->>'expectedRevision') !~ '^(0|[1-9][0-9]{0,5})$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN (p_input->>'expectedRevision')::integer;
END $$;

CREATE FUNCTION hon.hq_school_plan_note(p_input jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF jsonb_typeof(p_input->'note') = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_input->'note') IS DISTINCT FROM 'string' OR (p_input->>'note') <> btrim(p_input->>'note')
    OR length(p_input->>'note') NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN p_input->>'note';
END $$;

-- ---------- HQ commands ----------
-- ASSIGN: {expectedRevision, plan, note}. plan is {source:'OFFER', offerId} or
-- {source:'CUSTOM', name, billingInterval:'MONTHLY'|'ANNUAL', priceMinor, freeUntil}. freeUntil is a YYYY-MM-DD date after
-- today (UTC) and within three years, allowed only when priceMinor is 0 (optional: a free plan may last forever).
CREATE FUNCTION hon.assign_hq_school_plan(p_subject text, p_school uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; fp text; v_expected integer; v_plan jsonb; s hon.schools%ROWTYPE;
  n hon.hq_school_plan_assignments%ROWTYPE; cur hon.hq_school_plan_assignments%ROWTYPE; f hon.saas_offer_set_offers%ROWTYPE;
  at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  actor := hon.require_hq_school_plan_owner(p_subject);
  IF p_school IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedRevision','note','plan']
    OR jsonb_typeof(p_input->'plan') IS DISTINCT FROM 'object' THEN
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
  END IF;
  cur := hon.hq_school_plan_current(s.organization_id);
  IF cur.action = 'ASSIGN' AND (cur.source, cur.offer_id, cur.plan_name, cur.billing_interval, cur.price_minor, cur.free_until)
      IS NOT DISTINCT FROM (n.source, n.offer_id, n.plan_name, n.billing_interval, n.price_minor, n.free_until) THEN
    RAISE EXCEPTION 'HQ_SCHOOL_PLAN_NO_CHANGE' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.hq_school_plan_assignments SELECT n.*;
  result := jsonb_build_object('operation', 'ASSIGN', 'schoolId', s.id, 'organizationId', s.organization_id,
    'assignment', hon.hq_school_plan_json(n), 'effect', 'RECORD_ONLY', 'charging', 'OFF');
  INSERT INTO hon.hq_school_plan_requests VALUES (actor, p_key, 'ASSIGN', fp, s.organization_id, n.revision, result, at);
  PERFORM hon.require_hq_school_plan_owner(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- REMOVE: {expectedRevision, note}. Refused when no plan is assigned now.
CREATE FUNCTION hon.remove_hq_school_plan(p_subject text, p_school uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; fp text; v_expected integer; s hon.schools%ROWTYPE;
  n hon.hq_school_plan_assignments%ROWTYPE; cur hon.hq_school_plan_assignments%ROWTYPE; at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  actor := hon.require_hq_school_plan_owner(p_subject);
  IF p_school IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedRevision','note'] THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_expected := hon.hq_school_plan_expected(p_input); n.note := hon.hq_school_plan_note(p_input);
  fp := hon.saas_fingerprint(ARRAY['hq.school_plan.remove', p_school::text, p_input::text]);
  replay := hon.hq_school_plan_claim(actor, p_key, 'REMOVE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_school_plan_owner(p_subject); RETURN replay; END IF;
  s := hon.hq_school_plan_lock(p_school, v_expected, false);
  cur := hon.hq_school_plan_current(s.organization_id);
  IF cur.action IS DISTINCT FROM 'ASSIGN' THEN RAISE EXCEPTION 'HQ_SCHOOL_PLAN_NONE' USING ERRCODE = '23514'; END IF;
  n.organization_id := s.organization_id; n.revision := v_expected + 1; n.school_id := s.id; n.action := 'REMOVE';
  n.actor_principal_id := actor; n.recorded_at := at;
  INSERT INTO hon.hq_school_plan_assignments SELECT n.*;
  result := jsonb_build_object('operation', 'REMOVE', 'schoolId', s.id, 'organizationId', s.organization_id,
    'assignment', hon.hq_school_plan_json(n), 'effect', 'RECORD_ONLY', 'charging', 'OFF');
  INSERT INTO hon.hq_school_plan_requests VALUES (actor, p_key, 'REMOVE', fp, s.organization_id, n.revision, result, at);
  PERFORM hon.require_hq_school_plan_owner(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ---------- HQ read ----------
CREATE FUNCTION hon.read_hq_school_plan(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; result jsonb;
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, false);
  IF p_school IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  result := hon.hq_school_plan_view(actor, p_school);
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  RETURN result;
END $$;

-- ---------- ACL ----------
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['guard_hq_school_plan_evidence()','require_hq_school_plan_owner(text)','hq_school_plan_owner_eligible(uuid)',
    'hq_school_plan_json(hon.hq_school_plan_assignments)','hq_school_plan_offers()','hq_school_plan_current(uuid)',
    'hq_school_plan_view(uuid,uuid)','hq_school_plan_claim(uuid,uuid,text,text)','hq_school_plan_lock(uuid,integer,boolean)',
    'hq_school_plan_expected(jsonb)','hq_school_plan_note(jsonb)','assign_hq_school_plan(text,uuid,jsonb,uuid)',
    'remove_hq_school_plan(text,uuid,jsonb,uuid)','read_hq_school_plan(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.assign_hq_school_plan(text,uuid,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.remove_hq_school_plan(text,uuid,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_hq_school_plan(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
