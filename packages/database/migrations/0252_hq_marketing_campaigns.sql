BEGIN;

-- M1 HQ marketing campaigns (0252, allocated by the coordinator 2026-11-11). HON's own marketing of HON OS: HQ-internal
-- campaign plans with a channel (Google Ads, Meta ads, email, referral ...), dates and a planned budget, and an immutable
-- version history. HQ only: an HQ owner, or an HQ operator holding hq.marketing.manage (read and write) or
-- hq.marketing.read (read only). No school, family, AI or runtime role can read or write these rows, and nothing here
-- touches school campaigns. A planned budget is a planning number: nothing here publishes an ad, contacts a provider,
-- spends money, sends a message or touches billing, entitlements, payments or creative credits.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ marketing campaigns require a trusted migration owner';
  END IF;
END $$;

CREATE TABLE hon.hq_marketing_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,39}$'),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 3 AND 120),
  goal text NOT NULL CHECK (goal = btrim(goal) AND length(goal) BETWEEN 3 AND 500),
  audience text NOT NULL CHECK (audience IN ('NEW_SCHOOLS','TRIAL_SCHOOLS','EXISTING_SCHOOLS','PARTNERS','OTHER')),
  offer_label text NOT NULL CHECK (offer_label = btrim(offer_label) AND length(offer_label) BETWEEN 1 AND 120),
  channel text NOT NULL CHECK (channel IN ('GOOGLE_ADS','META_ADS','ORGANIC_SOCIAL','EMAIL','REFERRAL','EVENT','WEBSITE','PARTNERSHIP','OTHER')),
  status text NOT NULL CHECK (status IN ('DRAFT','ACTIVE','PAUSED','ARCHIVED')),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  planned_budget_minor bigint NOT NULL CHECK (planned_budget_minor BETWEEN 0 AND 10000000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  created_by uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  CHECK (ends_on >= starts_on AND ends_on - starts_on <= 731),
  CHECK (updated_at >= created_at)
);
CREATE INDEX hq_marketing_campaigns_created_idx ON hon.hq_marketing_campaigns (created_at DESC, id DESC);

CREATE TABLE hon.hq_marketing_campaign_versions (
  campaign_id uuid NOT NULL REFERENCES hon.hq_marketing_campaigns(id),
  version integer NOT NULL CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('CREATED','UPDATED','STATUS')),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (campaign_id, version),
  CHECK ((kind = 'CREATED') = (version = 1))
);

CREATE TABLE hon.hq_marketing_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('CREATE','UPDATE','STATUS')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  campaign_id uuid NOT NULL REFERENCES hon.hq_marketing_campaigns(id),
  response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (actor_principal_id, idempotency_key)
);

-- A campaign changes only by a version bump of its editable fields, never once archived; history and requests never change.
CREATE FUNCTION hon.guard_hq_marketing_campaign() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1 AND OLD.status <> 'ARCHIVED' AND NEW.updated_at >= OLD.updated_at
    AND (to_jsonb(NEW) - ARRAY['name','goal','audience','offer_label','channel','status','starts_on','ends_on','planned_budget_minor','updated_at','version'])
      = (to_jsonb(OLD) - ARRAY['name','goal','audience','offer_label','channel','status','starts_on','ends_on','planned_budget_minor','updated_at','version']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HQ_MARKETING_RECORD_IMMUTABLE' USING ERRCODE = '42501';
END $$;
CREATE FUNCTION hon.guard_hq_marketing_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN RAISE EXCEPTION 'HQ_MARKETING_RECORD_IMMUTABLE' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_marketing_campaigns FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_marketing_campaign();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_marketing_campaigns FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_marketing_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_marketing_campaign_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_marketing_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_marketing_campaign_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_marketing_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_marketing_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_marketing_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_marketing_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_marketing_evidence();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_marketing_campaigns','hq_marketing_campaign_versions','hq_marketing_requests'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
  END LOOP;
END $$;
DO $$ DECLARE r text; t text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    FOREACH t IN ARRAY ARRAY['hq_marketing_campaigns','hq_marketing_campaign_versions','hq_marketing_requests'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
    END LOOP;
  END LOOP;
END $$;

-- ---------- authority ----------
-- Whether a principal may read (p_write false) or change (p_write true) HQ marketing now: a current HQ owner, or a current
-- HQ operator holding hq.marketing.manage (or, to read only, hq.marketing.read); an active human, the only active principal
-- of its user, with no live family access. HQ support grants never qualify.
CREATE FUNCTION hon.hq_marketing_principal_eligible(p_principal uuid, p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.principals p WHERE p.id = p_principal AND p.is_active AND p.principal_type = 'HUMAN_USER'
    AND (SELECT count(*) FROM hon.principals o WHERE o.user_id = p.user_id AND o.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p.id
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (g.hq_role = 'HON_HQ_OWNER' OR (g.hq_role = 'HON_HQ_OPERATOR'
        AND ('hq.marketing.manage' = ANY(g.permission_codes) OR (NOT coalesce(p_write, true) AND 'hq.marketing.read' = ANY(g.permission_codes))))))
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp())))
$$;

CREATE FUNCTION hon.require_hq_marketing_actor(p_subject text, p_write boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid;
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  WHERE u.external_subject = p_subject AND hon.hq_marketing_principal_eligible(p.id, p_write);
  IF actor IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END $$;

-- ---------- projections ----------
CREATE FUNCTION hon.hq_marketing_person_json(p_principal uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('principalId', p.id,
    'displayName', left(coalesce(nullif(btrim(u.display_name), ''), 'HQ team member'), 120))
  FROM hon.principals p JOIN hon.users u ON u.id = p.user_id WHERE p.id = p_principal
$$;

CREATE FUNCTION hon.hq_marketing_campaign_json(c hon.hq_marketing_campaigns) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('campaignId', c.id, 'code', c.code, 'name', c.name, 'goal', c.goal, 'audience', c.audience,
    'offerLabel', c.offer_label, 'channel', c.channel, 'status', c.status,
    'startsOn', to_char(c.starts_on, 'YYYY-MM-DD'), 'endsOn', to_char(c.ends_on, 'YYYY-MM-DD'),
    'plannedBudgetMinor', c.planned_budget_minor, 'currency', c.currency, 'createdBy', hon.hq_marketing_person_json(c.created_by),
    'createdAt', hon.saas_ts(c.created_at), 'updatedAt', hon.saas_ts(c.updated_at), 'version', c.version)
$$;

-- Only the editable plan facts, as kept in each version snapshot.
CREATE FUNCTION hon.hq_marketing_snapshot(c hon.hq_marketing_campaigns) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('name', c.name, 'goal', c.goal, 'audience', c.audience, 'offerLabel', c.offer_label, 'channel', c.channel,
    'status', c.status, 'startsOn', to_char(c.starts_on, 'YYYY-MM-DD'), 'endsOn', to_char(c.ends_on, 'YYYY-MM-DD'),
    'plannedBudgetMinor', c.planned_budget_minor)
$$;

-- Replays a completed request of this actor and key, refuses reuse with other content, or returns NULL to proceed.
CREATE FUNCTION hon.hq_marketing_claim(p_actor uuid, p_key uuid, p_operation text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prior hon.hq_marketing_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hq-marketing:' || p_actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO prior FROM hon.hq_marketing_requests WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.operation <> p_operation OR prior.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
  RETURN prior.response || jsonb_build_object('replayed', true);
END $$;

CREATE FUNCTION hon.hq_marketing_text(p_input jsonb, p_key text, p_min integer, p_max integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF jsonb_typeof(p_input->p_key) IS DISTINCT FROM 'string' OR (p_input->>p_key) <> btrim(p_input->>p_key)
    OR length(p_input->>p_key) NOT BETWEEN p_min AND p_max OR (p_input->>p_key) ~ '[\x01-\x1F\x7F]' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN p_input->>p_key;
END $$;

CREATE FUNCTION hon.hq_marketing_date(p_input jsonb, p_key text) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE d date;
BEGIN
  IF jsonb_typeof(p_input->p_key) IS DISTINCT FROM 'string' OR (p_input->>p_key) !~ '^(20[2-9][0-9])-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  BEGIN d := (p_input->>p_key)::date;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END;
  IF to_char(d, 'YYYY-MM-DD') <> p_input->>p_key THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  RETURN d;
END $$;

CREATE FUNCTION hon.hq_marketing_expected(p_input jsonb) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN (p_input->>'expectedVersion')::integer;
END $$;

-- The plan fields shared by CREATE and UPDATE, checked and returned as a row-shaped record (id, code and audit columns unset).
CREATE FUNCTION hon.hq_marketing_plan(p_input jsonb) RETURNS hon.hq_marketing_campaigns
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE c hon.hq_marketing_campaigns%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_input->'audience') IS DISTINCT FROM 'string'
    OR (p_input->>'audience') NOT IN ('NEW_SCHOOLS','TRIAL_SCHOOLS','EXISTING_SCHOOLS','PARTNERS','OTHER')
    OR jsonb_typeof(p_input->'channel') IS DISTINCT FROM 'string'
    OR (p_input->>'channel') NOT IN ('GOOGLE_ADS','META_ADS','ORGANIC_SOCIAL','EMAIL','REFERRAL','EVENT','WEBSITE','PARTNERSHIP','OTHER')
    OR jsonb_typeof(p_input->'plannedBudgetMinor') IS DISTINCT FROM 'number' OR (p_input->>'plannedBudgetMinor') !~ '^(0|[1-9][0-9]{0,10})$'
    OR (p_input->>'plannedBudgetMinor')::bigint > 10000000000 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  c.name := hon.hq_marketing_text(p_input, 'name', 3, 120);
  c.goal := hon.hq_marketing_text(p_input, 'goal', 3, 500);
  c.offer_label := hon.hq_marketing_text(p_input, 'offerLabel', 1, 120);
  c.audience := p_input->>'audience'; c.channel := p_input->>'channel';
  c.starts_on := hon.hq_marketing_date(p_input, 'startsOn'); c.ends_on := hon.hq_marketing_date(p_input, 'endsOn');
  IF c.ends_on < c.starts_on OR c.ends_on - c.starts_on > 731 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  c.planned_budget_minor := (p_input->>'plannedBudgetMinor')::bigint;
  RETURN c;
END $$;

-- Locks the campaign and checks its version and that it is not archived. Shared by UPDATE and STATUS.
CREATE FUNCTION hon.hq_marketing_lock(p_campaign uuid, p_expected integer) RETURNS hon.hq_marketing_campaigns
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE c hon.hq_marketing_campaigns%ROWTYPE;
BEGIN
  SELECT * INTO c FROM hon.hq_marketing_campaigns WHERE id = p_campaign FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF c.version <> p_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF c.status = 'ARCHIVED' THEN RAISE EXCEPTION 'HQ_CAMPAIGN_ARCHIVED' USING ERRCODE = '23514'; END IF;
  RETURN c;
END $$;

-- ---------- commands ----------
-- CREATE: {code, name, goal, audience, offerLabel, channel, startsOn, endsOn, plannedBudgetMinor}; starts as DRAFT.
CREATE FUNCTION hon.create_hq_marketing_campaign(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; plan hon.hq_marketing_campaigns%ROWTYPE; c hon.hq_marketing_campaigns%ROWTYPE; fp text;
  at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, true);
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k)
      <> ARRAY['audience','channel','code','endsOn','goal','name','offerLabel','plannedBudgetMinor','startsOn']
    OR jsonb_typeof(p_input->'code') IS DISTINCT FROM 'string' OR (p_input->>'code') !~ '^[A-Z0-9][A-Z0-9-]{1,39}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  plan := hon.hq_marketing_plan(p_input);
  fp := hon.saas_fingerprint(ARRAY['hq.marketing.create', p_input::text]);
  replay := hon.hq_marketing_claim(actor, p_key, 'CREATE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_marketing_actor(p_subject, true); RETURN replay; END IF;
  IF EXISTS (SELECT 1 FROM hon.hq_marketing_campaigns WHERE code = p_input->>'code') THEN
    RAISE EXCEPTION 'HQ_CAMPAIGN_CODE_TAKEN' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.hq_marketing_campaigns (code, name, goal, audience, offer_label, channel, status, starts_on, ends_on,
    planned_budget_minor, created_by, created_at, updated_at)
  VALUES (p_input->>'code', plan.name, plan.goal, plan.audience, plan.offer_label, plan.channel, 'DRAFT', plan.starts_on, plan.ends_on,
    plan.planned_budget_minor, actor, at, at) RETURNING * INTO c;
  INSERT INTO hon.hq_marketing_campaign_versions VALUES (c.id, 1, 'CREATED', actor, hon.hq_marketing_snapshot(c), at);
  result := jsonb_build_object('operation', 'CREATE', 'campaign', hon.hq_marketing_campaign_json(c));
  INSERT INTO hon.hq_marketing_requests VALUES (actor, p_key, 'CREATE', fp, c.id, result, at);
  PERFORM hon.require_hq_marketing_actor(p_subject, true);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- UPDATE: {expectedVersion, name, goal, audience, offerLabel, channel, startsOn, endsOn, plannedBudgetMinor}; the code never changes.
CREATE FUNCTION hon.update_hq_marketing_campaign(p_subject text, p_campaign uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; plan hon.hq_marketing_campaigns%ROWTYPE; c hon.hq_marketing_campaigns%ROWTYPE; v_expected integer;
  fp text; at timestamptz; result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, true);
  IF p_campaign IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k)
      <> ARRAY['audience','channel','endsOn','expectedVersion','goal','name','offerLabel','plannedBudgetMinor','startsOn'] THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_expected := hon.hq_marketing_expected(p_input); plan := hon.hq_marketing_plan(p_input);
  fp := hon.saas_fingerprint(ARRAY['hq.marketing.update', p_campaign::text, p_input::text]);
  replay := hon.hq_marketing_claim(actor, p_key, 'UPDATE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_marketing_actor(p_subject, true); RETURN replay; END IF;
  c := hon.hq_marketing_lock(p_campaign, v_expected);
  IF (c.name, c.goal, c.audience, c.offer_label, c.channel, c.starts_on, c.ends_on, c.planned_budget_minor)
    = (plan.name, plan.goal, plan.audience, plan.offer_label, plan.channel, plan.starts_on, plan.ends_on, plan.planned_budget_minor) THEN
    RAISE EXCEPTION 'HQ_CAMPAIGN_NO_CHANGE' USING ERRCODE = '23514';
  END IF;
  at := greatest(clock_timestamp(), c.updated_at);
  UPDATE hon.hq_marketing_campaigns SET name = plan.name, goal = plan.goal, audience = plan.audience, offer_label = plan.offer_label,
    channel = plan.channel, starts_on = plan.starts_on, ends_on = plan.ends_on, planned_budget_minor = plan.planned_budget_minor,
    updated_at = at, version = version + 1
  WHERE id = c.id RETURNING * INTO c;
  INSERT INTO hon.hq_marketing_campaign_versions VALUES (c.id, c.version, 'UPDATED', actor, hon.hq_marketing_snapshot(c), at);
  result := jsonb_build_object('operation', 'UPDATE', 'campaign', hon.hq_marketing_campaign_json(c));
  INSERT INTO hon.hq_marketing_requests VALUES (actor, p_key, 'UPDATE', fp, c.id, result, at);
  PERFORM hon.require_hq_marketing_actor(p_subject, true);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- STATUS: {expectedVersion, status}. DRAFT -> ACTIVE | ARCHIVED; ACTIVE -> PAUSED | ARCHIVED; PAUSED -> ACTIVE | ARCHIVED.
-- ARCHIVED is final. Marking a campaign ACTIVE records the plan only; it never starts an ad or any spend.
CREATE FUNCTION hon.set_hq_marketing_campaign_status(p_subject text, p_campaign uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; c hon.hq_marketing_campaigns%ROWTYPE; v_expected integer; v_status text; fp text; at timestamptz; result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, true);
  IF p_campaign IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) <> ARRAY['expectedVersion','status']
    OR jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR (p_input->>'status') NOT IN ('ACTIVE','PAUSED','ARCHIVED') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_expected := hon.hq_marketing_expected(p_input); v_status := p_input->>'status';
  fp := hon.saas_fingerprint(ARRAY['hq.marketing.status', p_campaign::text, p_input::text]);
  replay := hon.hq_marketing_claim(actor, p_key, 'STATUS', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_marketing_actor(p_subject, true); RETURN replay; END IF;
  c := hon.hq_marketing_lock(p_campaign, v_expected);
  IF NOT ((c.status = 'DRAFT' AND v_status IN ('ACTIVE','ARCHIVED')) OR (c.status = 'ACTIVE' AND v_status IN ('PAUSED','ARCHIVED'))
    OR (c.status = 'PAUSED' AND v_status IN ('ACTIVE','ARCHIVED'))) THEN
    RAISE EXCEPTION 'HQ_CAMPAIGN_STATUS_NOT_ALLOWED' USING ERRCODE = '23514';
  END IF;
  at := greatest(clock_timestamp(), c.updated_at);
  UPDATE hon.hq_marketing_campaigns SET status = v_status, updated_at = at, version = version + 1 WHERE id = c.id RETURNING * INTO c;
  INSERT INTO hon.hq_marketing_campaign_versions VALUES (c.id, c.version, 'STATUS', actor, hon.hq_marketing_snapshot(c), at);
  result := jsonb_build_object('operation', 'STATUS', 'campaign', hon.hq_marketing_campaign_json(c));
  INSERT INTO hon.hq_marketing_requests VALUES (actor, p_key, 'STATUS', fp, c.id, result, at);
  PERFORM hon.require_hq_marketing_actor(p_subject, true);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ---------- reads ----------
-- List: p_status NULL (all), 'OPEN' (not archived) or one status; keyset by (created_at, id) DESC. The summary covers every
-- campaign: counts per status and the planned budget of campaigns that are not archived (planning only, never spend).
CREATE FUNCTION hon.read_hq_marketing_campaigns(p_subject text, p_status text, p_cursor_at timestamptz, p_cursor_id uuid, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; v_rows jsonb; v_last hon.hq_marketing_campaigns%ROWTYPE; n integer; result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, false);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR (p_cursor_at IS NULL) <> (p_cursor_id IS NULL)
    OR (p_status IS NOT NULL AND p_status NOT IN ('OPEN','DRAFT','ACTIVE','PAUSED','ARCHIVED')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  WITH page AS (
    SELECT c AS r, c.created_at, c.id FROM hon.hq_marketing_campaigns c
    WHERE (p_status IS NULL OR (p_status = 'OPEN' AND c.status <> 'ARCHIVED') OR c.status = p_status)
      AND (p_cursor_at IS NULL OR (c.created_at, c.id) < (p_cursor_at, p_cursor_id))
    ORDER BY c.created_at DESC, c.id DESC LIMIT p_limit)
  SELECT coalesce(jsonb_agg(hon.hq_marketing_campaign_json(page.r) ORDER BY page.created_at DESC, page.id DESC), '[]'::jsonb), count(*)
  INTO v_rows, n FROM page;
  IF n = p_limit THEN SELECT * INTO v_last FROM hon.hq_marketing_campaigns WHERE id = (v_rows->(n - 1)->>'campaignId')::uuid; END IF;
  result := jsonb_build_object('campaigns', v_rows, 'limit', p_limit,
    'nextCursor', CASE WHEN n = p_limit THEN jsonb_build_object('createdAt', hon.saas_ts(v_last.created_at), 'campaignId', v_last.id) END,
    'summary', (SELECT jsonb_build_object('DRAFT', count(*) FILTER (WHERE status = 'DRAFT'), 'ACTIVE', count(*) FILTER (WHERE status = 'ACTIVE'),
      'PAUSED', count(*) FILTER (WHERE status = 'PAUSED'), 'ARCHIVED', count(*) FILTER (WHERE status = 'ARCHIVED'),
      'plannedBudgetOpenMinor', coalesce(sum(planned_budget_minor) FILTER (WHERE status <> 'ARCHIVED'), 0))
      FROM hon.hq_marketing_campaigns),
    'viewer', hon.hq_marketing_person_json(actor) || jsonb_build_object('canManage', hon.hq_marketing_principal_eligible(actor, true)),
    'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_marketing_actor(p_subject, false);
  RETURN result;
END $$;

CREATE FUNCTION hon.read_hq_marketing_campaign(p_subject text, p_campaign uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; c hon.hq_marketing_campaigns%ROWTYPE; result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, false);
  IF p_campaign IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO c FROM hon.hq_marketing_campaigns WHERE id = p_campaign;
  IF c.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  result := jsonb_build_object('campaign', hon.hq_marketing_campaign_json(c),
    'versions', (SELECT coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'kind', v.kind,
        'actor', hon.hq_marketing_person_json(v.actor_principal_id), 'snapshot', v.snapshot, 'recordedAt', hon.saas_ts(v.recorded_at))
      ORDER BY v.version), '[]'::jsonb) FROM hon.hq_marketing_campaign_versions v WHERE v.campaign_id = c.id),
    'viewer', hon.hq_marketing_person_json(actor) || jsonb_build_object('canManage', hon.hq_marketing_principal_eligible(actor, true)),
    'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_marketing_actor(p_subject, false);
  RETURN result;
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['guard_hq_marketing_campaign()','guard_hq_marketing_evidence()','hq_marketing_principal_eligible(uuid,boolean)',
    'require_hq_marketing_actor(text,boolean)','hq_marketing_person_json(uuid)','hq_marketing_campaign_json(hon.hq_marketing_campaigns)',
    'hq_marketing_snapshot(hon.hq_marketing_campaigns)','hq_marketing_claim(uuid,uuid,text,text)','hq_marketing_text(jsonb,text,integer,integer)',
    'hq_marketing_date(jsonb,text)','hq_marketing_expected(jsonb)','hq_marketing_plan(jsonb)','hq_marketing_lock(uuid,integer)',
    'create_hq_marketing_campaign(text,jsonb,uuid)','update_hq_marketing_campaign(text,uuid,jsonb,uuid)',
    'set_hq_marketing_campaign_status(text,uuid,jsonb,uuid)','read_hq_marketing_campaigns(text,text,timestamptz,uuid,integer)',
    'read_hq_marketing_campaign(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_hq_marketing_campaign(text,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.update_hq_marketing_campaign(text,uuid,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.set_hq_marketing_campaign_status(text,uuid,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_hq_marketing_campaigns(text,text,timestamptz,uuid,integer) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_hq_marketing_campaign(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
