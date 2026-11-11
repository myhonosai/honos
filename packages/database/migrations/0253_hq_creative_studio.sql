BEGIN;

-- M2 HQ Creative Studio + HQ creative budget (0253, allocated by the coordinator 2026-11-11). HON's own image and video
-- requests for marketing HON OS, paid from a separate monthly HQ credit budget set by the human HQ owner. It mirrors the
-- school Creative Studio (0216): the same published operation codes and unit rates (0202 saas_creative_rates, read only),
-- the same prompt rule, at most 3 requests in progress, reserve before the one provider call, record the outcome exactly
-- once (SUCCEEDED charges the actual units, never above the reservation; FAILED and NOT_SENT charge nothing; an unknown or
-- unverified result is held UNDER_REVIEW until the HQ owner resolves it with evidence).
--
-- Fully separate from every school: no organization or school column, and nothing here reads, reserves, settles or debits
-- a school creative wallet, lot, ledger or reservation (saas_creative_wallet*, saas_creative_lots, saas_creative_ledger,
-- saas_creative_reservations), the AI-agent budget or ai_usage_ledger. A platform-wide HQ emergency pause of CREATIVE_MEDIA
-- (or ALL) spend stops new HQ requests too. HQ only: HQ owner, or an HQ operator holding hq.marketing.manage (request) or
-- hq.marketing.read (read); the budget cap and resolutions are HQ owner only. A credit cap is an internal planning limit,
-- never a charge, a provider budget or a payment. No provider is connected by this migration: the API refuses a request
-- (503) before any write while the production provider runtime is unconfigured.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ Creative Studio requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.require_hq_marketing_actor(text,boolean)') IS NULL OR to_regprocedure('hon.creative_prompt_ok(text)') IS NULL
    OR to_regclass('hon.saas_creative_rates') IS NULL OR to_regprocedure('hon.saas_creative_evidence_actor(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'HQ Creative Studio requires HQ marketing (0252), Creative Studio (0216) and CW1 rates (0202)';
  END IF;
END $$;

-- ---------- tables ----------
CREATE TABLE hon.hq_creative_budget_periods (
  period_start date PRIMARY KEY CHECK (extract(day FROM period_start) = 1),
  credit_cap integer NOT NULL CHECK (credit_cap BETWEEN 0 AND 10000000),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 999999999),
  set_by uuid NOT NULL REFERENCES hon.principals(id),
  set_at timestamptz NOT NULL
);

CREATE TABLE hon.hq_creative_budget_changes (
  period_start date NOT NULL REFERENCES hon.hq_creative_budget_periods(period_start),
  version integer NOT NULL CHECK (version > 0),
  credit_cap integer NOT NULL CHECK (credit_cap BETWEEN 0 AND 10000000),
  previous_cap integer CHECK (previous_cap BETWEEN 0 AND 10000000),
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 300),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (period_start, version),
  CHECK ((version = 1) = (previous_cap IS NULL))
);

CREATE TABLE hon.hq_creative_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start date NOT NULL REFERENCES hon.hq_creative_budget_periods(period_start),
  campaign_id uuid REFERENCES hon.hq_marketing_campaigns(id),
  requested_by uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  rate_version_id uuid NOT NULL,
  operation_code text NOT NULL CHECK (operation_code ~ '^[a-z][a-z0-9_.]{2,59}$'),
  media_kind text NOT NULL CHECK (media_kind IN ('IMAGE','VIDEO')),
  credits_per_unit integer NOT NULL CHECK (credits_per_unit > 0),
  units integer NOT NULL CHECK (units BETWEEN 1 AND 1000),
  reserved_credits integer NOT NULL CHECK (reserved_credits > 0),
  format text NOT NULL CHECK (format IN ('SQUARE','PORTRAIT','LANDSCAPE')),
  prompt text NOT NULL CHECK (hon.creative_prompt_ok(prompt)),
  provider_id text NOT NULL REFERENCES hon.hq_ai_provider_connections(provider_id),
  model_code text NOT NULL CHECK (hon.hq_ai_safe_text(model_code, true)),
  status text NOT NULL CHECK (status IN ('GENERATING','SUCCEEDED','FAILED','UNDER_REVIEW','RESOLVED_CHARGED','RESOLVED_NOT_CHARGED')),
  failure_reason text,
  final_units integer CHECK (final_units >= 0),
  charged_credits integer CHECK (charged_credits >= 0),
  -- Provider expense, separate from the HQ credits: PENDING while open; RECORDED when reported or evidenced (zero only when
  -- reported as zero or the request never left the server); UNKNOWN when it ended without a known cost (never a guessed zero).
  cost_status text NOT NULL CHECK (cost_status IN ('PENDING','RECORDED','UNKNOWN')),
  provider_cost_microunits bigint CHECK (provider_cost_microunits BETWEEN 0 AND 999999999999999),
  resolution_reference text CHECK (resolution_reference = btrim(resolution_reference) AND length(resolution_reference) BETWEEN 1 AND 200),
  resolved_by uuid REFERENCES hon.principals(id),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (requested_by, idempotency_key),
  FOREIGN KEY (rate_version_id, operation_code) REFERENCES hon.saas_creative_rates(rate_version_id, operation_code),
  CHECK (reserved_credits = credits_per_unit * units),
  CHECK (period_start = date_trunc('month', created_at AT TIME ZONE 'UTC')::date),
  CHECK ((status = 'GENERATING') = (completed_at IS NULL)),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK ((cost_status = 'RECORDED') = (provider_cost_microunits IS NOT NULL)),
  CHECK ((status IN ('RESOLVED_CHARGED','RESOLVED_NOT_CHARGED')) = (resolved_by IS NOT NULL AND resolution_reference IS NOT NULL)),
  CHECK (CASE status
    WHEN 'GENERATING' THEN failure_reason IS NULL AND final_units IS NULL AND charged_credits IS NULL AND cost_status = 'PENDING'
    WHEN 'SUCCEEDED' THEN failure_reason IS NULL AND final_units BETWEEN 1 AND units AND charged_credits = final_units * credits_per_unit
      AND cost_status = 'RECORDED'
    WHEN 'FAILED' THEN failure_reason IN ('PROVIDER_REJECTED','PROVIDER_NOT_CONNECTED','INVALID_REQUEST') AND final_units IS NULL
      AND charged_credits IS NULL AND cost_status IN ('RECORDED','UNKNOWN')
    WHEN 'UNDER_REVIEW' THEN failure_reason IN ('PROVIDER_UNKNOWN','UNVERIFIED_RESULT','INTERRUPTED') AND final_units IS NULL
      AND charged_credits IS NULL AND cost_status = 'PENDING'
    WHEN 'RESOLVED_CHARGED' THEN final_units BETWEEN 0 AND units AND charged_credits = final_units * credits_per_unit
      AND cost_status IN ('RECORDED','UNKNOWN')
    ELSE final_units IS NULL AND charged_credits IS NULL AND cost_status IN ('RECORDED','UNKNOWN') END)
);
CREATE INDEX hq_creative_generations_created_idx ON hon.hq_creative_generations (created_at DESC, id DESC);
CREATE INDEX hq_creative_generations_period_idx ON hon.hq_creative_generations (period_start, status);

CREATE TABLE hon.hq_creative_generation_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL REFERENCES hon.hq_creative_generations(id),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  media_type text NOT NULL CHECK (media_type IN ('image/png','image/webp','video/mp4')),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 8192),
  duration_seconds integer CHECK (duration_seconds BETWEEN 1 AND 600),
  -- M2: synthetic results only, like CS1. Real provider media needs reviewed storage and signed reads (later, owner approval).
  origin text NOT NULL CHECK (origin = 'SYNTHETIC'),
  provider_asset_reference text NOT NULL CHECK (provider_asset_reference ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$'),
  created_at timestamptz NOT NULL,
  UNIQUE (generation_id, ordinal),
  CHECK ((media_type = 'video/mp4') = (duration_seconds IS NOT NULL))
);

CREATE TABLE hon.hq_creative_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('BUDGET','RESOLVE')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (actor_principal_id, idempotency_key)
);

-- ---------- immutability ----------
-- A budget period changes only by a version bump of its cap; a generation moves only GENERATING -> a result, or
-- GENERATING/UNDER_REVIEW -> resolved, with every request field unchanged. History, assets and requests never change.
CREATE FUNCTION hon.guard_hq_creative_record() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE moving text[];
BEGIN
  -- Field references are resolved per table (PL/pgSQL does not short-circuit record fields), hence the nested IFs.
  IF TG_OP <> 'UPDATE' OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'HQ_CREATIVE_RECORD_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'hq_creative_budget_periods' THEN
    IF (to_jsonb(NEW)->>'set_at')::timestamptz >= (to_jsonb(OLD)->>'set_at')::timestamptz
      AND (to_jsonb(NEW) - ARRAY['credit_cap','version','set_by','set_at']) = (to_jsonb(OLD) - ARRAY['credit_cap','version','set_by','set_at']) THEN
      RETURN NEW;
    END IF;
  ELSIF (to_jsonb(OLD)->>'status' = 'GENERATING' AND to_jsonb(NEW)->>'status' IN ('SUCCEEDED','FAILED','UNDER_REVIEW','RESOLVED_CHARGED','RESOLVED_NOT_CHARGED'))
      OR (to_jsonb(OLD)->>'status' = 'UNDER_REVIEW' AND to_jsonb(NEW)->>'status' IN ('RESOLVED_CHARGED','RESOLVED_NOT_CHARGED')) THEN
    moving := ARRAY['status','failure_reason','final_units','charged_credits','cost_status','provider_cost_microunits','resolution_reference',
      'resolved_by','version','completed_at'];
    -- The first completion time and failure reason stay fixed once set.
    IF (to_jsonb(NEW) - moving) = (to_jsonb(OLD) - moving)
      AND (to_jsonb(OLD)->'completed_at' = 'null'::jsonb OR to_jsonb(NEW)->'completed_at' = to_jsonb(OLD)->'completed_at')
      AND (to_jsonb(OLD)->'failure_reason' = 'null'::jsonb OR to_jsonb(NEW)->'failure_reason' = to_jsonb(OLD)->'failure_reason') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'HQ_CREATIVE_RECORD_IMMUTABLE' USING ERRCODE = '42501';
END $$;
CREATE FUNCTION hon.guard_hq_creative_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN RAISE EXCEPTION 'HQ_CREATIVE_RECORD_IMMUTABLE' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_creative_budget_periods FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_creative_record();
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_creative_generations FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_creative_record();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_creative_budget_changes FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_creative_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_creative_generation_assets FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_creative_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_creative_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_creative_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_creative_budget_periods FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_creative_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_creative_budget_changes FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_creative_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_creative_generations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_creative_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_creative_generation_assets FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_creative_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_creative_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_creative_evidence();

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_creative_budget_periods','hq_creative_budget_changes','hq_creative_generations','hq_creative_generation_assets','hq_creative_requests'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
    END LOOP;
  END LOOP;
END $$;

-- ---------- authority ----------
-- The human HQ owner now (budget cap and resolutions): same person rules as hq_marketing_principal_eligible.
CREATE FUNCTION hon.hq_creative_owner_eligible(p_principal uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT hon.hq_marketing_principal_eligible(p_principal, true) AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g
    WHERE g.principal_id = p_principal AND g.hq_role = 'HON_HQ_OWNER'
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp()))
$$;

CREATE FUNCTION hon.require_hq_creative_owner(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.require_hq_marketing_actor(p_subject, true);
BEGIN
  IF NOT hon.hq_creative_owner_eligible(actor) THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END $$;

-- ---------- helpers ----------
CREATE FUNCTION hon.hq_creative_period(p_at timestamptz) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$ SELECT date_trunc('month', p_at AT TIME ZONE 'UTC')::date $$;

-- One lock per budget period: the cap change, every new request, every result and every resolution of that month.
CREATE FUNCTION hon.hq_creative_lock_period(p_period date) RETURNS void
LANGUAGE sql VOLATILE SET search_path = pg_catalog, hon AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('hq-creative-period:' || p_period::text, 0))
$$;

CREATE FUNCTION hon.hq_creative_budget_json(p_period date) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH use AS (SELECT coalesce(sum(charged_credits) FILTER (WHERE status IN ('SUCCEEDED','RESOLVED_CHARGED')), 0)::bigint used,
      coalesce(sum(reserved_credits) FILTER (WHERE status IN ('GENERATING','UNDER_REVIEW')), 0)::bigint held,
      count(*) FILTER (WHERE status = 'GENERATING')::integer busy
    FROM hon.hq_creative_generations WHERE period_start = p_period)
  SELECT jsonb_build_object('periodStart', to_char(p_period, 'YYYY-MM-DD'), 'creditCap', b.credit_cap, 'usedCredits', use.used,
    'heldCredits', use.held, 'availableCredits', CASE WHEN b.credit_cap IS NULL THEN 0 ELSE greatest(b.credit_cap - use.used - use.held, 0) END,
    'inProgress', use.busy, 'version', b.version, 'setBy', CASE WHEN b.set_by IS NULL THEN NULL ELSE hon.hq_marketing_person_json(b.set_by) END,
    'setAt', CASE WHEN b.set_at IS NULL THEN NULL ELSE hon.saas_ts(b.set_at) END)
  FROM use LEFT JOIN hon.hq_creative_budget_periods b ON b.period_start = p_period
$$;

CREATE FUNCTION hon.hq_creative_generation_json(g hon.hq_creative_generations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('generationId', g.id, 'periodStart', to_char(g.period_start, 'YYYY-MM-DD'),
    'campaign', (SELECT jsonb_build_object('campaignId', c.id, 'code', c.code, 'name', c.name) FROM hon.hq_marketing_campaigns c WHERE c.id = g.campaign_id),
    'operationCode', g.operation_code, 'mediaKind', g.media_kind, 'units', g.units, 'format', g.format, 'prompt', g.prompt,
    'status', g.status, 'failureReason', g.failure_reason, 'reservedCredits', g.reserved_credits, 'chargedCredits', g.charged_credits,
    'requestedBy', hon.hq_marketing_person_json(g.requested_by), 'version', g.version,
    'createdAt', hon.saas_ts(g.created_at), 'completedAt', CASE WHEN g.completed_at IS NULL THEN NULL ELSE hon.saas_ts(g.completed_at) END,
    'assets', CASE WHEN g.status = 'SUCCEEDED' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('assetId', a.id, 'ordinal', a.ordinal,
        'mediaType', a.media_type, 'width', a.width, 'height', a.height, 'durationSeconds', a.duration_seconds, 'origin', a.origin) ORDER BY a.ordinal)
      FROM hon.hq_creative_generation_assets a WHERE a.generation_id = g.id), '[]'::jsonb) ELSE '[]'::jsonb END)
$$;

CREATE FUNCTION hon.hq_creative_viewer_json(p_actor uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT hon.hq_marketing_person_json(p_actor) || jsonb_build_object('canManage', hon.hq_marketing_principal_eligible(p_actor, true),
    'isOwner', hon.hq_creative_owner_eligible(p_actor))
$$;

CREATE FUNCTION hon.hq_creative_receipt(g hon.hq_creative_generations, p_replayed boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('generation', hon.hq_creative_generation_json(g), 'budget', hon.hq_creative_budget_json(g.period_start), 'replayed', p_replayed)
$$;

CREATE FUNCTION hon.hq_creative_claim(p_actor uuid, p_key uuid, p_operation text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prior hon.hq_creative_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hq-creative:' || p_actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO prior FROM hon.hq_creative_requests WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.operation <> p_operation OR prior.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
  RETURN prior.response || jsonb_build_object('replayed', true);
END $$;

CREATE FUNCTION hon.hq_creative_reference(p_input jsonb, p_key text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF jsonb_typeof(p_input->p_key) IS DISTINCT FROM 'string' OR (p_input->>p_key) <> btrim(p_input->>p_key)
    OR length(p_input->>p_key) NOT BETWEEN 3 AND 300 OR (p_input->>p_key) ~ '[\x01-\x1F\x7F]' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN p_input->>p_key;
END $$;

-- ---------- commands ----------
-- BUDGET (HQ owner only): {periodStart, creditCap, expectedVersion (null for a new month), reason}. Only the current or a
-- future UTC month (at most 12 ahead). A cap below what the month already used plus holds is refused.
CREATE FUNCTION hon.set_hq_creative_budget(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; fp text; v_period date; v_cap integer; v_reason text; b hon.hq_creative_budget_periods%ROWTYPE;
  v_now date; v_committed bigint; at timestamptz; result jsonb;
BEGIN
  actor := hon.require_hq_creative_owner(p_subject);
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['creditCap','expectedVersion','periodStart','reason']
    OR jsonb_typeof(p_input->'creditCap') IS DISTINCT FROM 'number' OR (p_input->>'creditCap') !~ '^(0|[1-9][0-9]{0,7})$'
    OR (p_input->>'creditCap')::integer > 10000000
    OR NOT (jsonb_typeof(p_input->'expectedVersion') = 'null'
      OR (jsonb_typeof(p_input->'expectedVersion') = 'number' AND (p_input->>'expectedVersion') ~ '^[1-9][0-9]{0,8}$')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_period := hon.hq_marketing_date(p_input, 'periodStart');
  IF extract(day FROM v_period) <> 1 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  v_cap := (p_input->>'creditCap')::integer; v_reason := hon.hq_creative_reference(p_input, 'reason');
  fp := hon.saas_fingerprint(ARRAY['hq.creative.budget', p_input::text]);
  replay := hon.hq_creative_claim(actor, p_key, 'BUDGET', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_creative_owner(p_subject); RETURN replay; END IF;
  v_now := hon.hq_creative_period(clock_timestamp());
  IF v_period < v_now OR v_period > (v_now + interval '12 months')::date THEN
    RAISE EXCEPTION 'HQ_CREATIVE_PERIOD_NOT_ALLOWED' USING ERRCODE = '23514';
  END IF;
  PERFORM hon.hq_creative_lock_period(v_period);
  SELECT * INTO b FROM hon.hq_creative_budget_periods WHERE period_start = v_period FOR UPDATE;
  IF b.period_start IS NULL THEN
    IF jsonb_typeof(p_input->'expectedVersion') <> 'null' THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  ELSIF jsonb_typeof(p_input->'expectedVersion') = 'null' OR b.version <> (p_input->>'expectedVersion')::integer THEN
    RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001';
  ELSIF b.credit_cap = v_cap THEN
    RAISE EXCEPTION 'HQ_CREATIVE_BUDGET_NO_CHANGE' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(sum(CASE WHEN status IN ('SUCCEEDED','RESOLVED_CHARGED') THEN charged_credits
      WHEN status IN ('GENERATING','UNDER_REVIEW') THEN reserved_credits ELSE 0 END), 0) INTO v_committed
    FROM hon.hq_creative_generations WHERE period_start = v_period;
  IF v_cap < v_committed THEN RAISE EXCEPTION 'HQ_CREATIVE_CAP_BELOW_USE' USING ERRCODE = '23514'; END IF;
  at := clock_timestamp();
  IF b.period_start IS NULL THEN
    INSERT INTO hon.hq_creative_budget_periods VALUES (v_period, v_cap, 1, actor, at) RETURNING * INTO b;
    INSERT INTO hon.hq_creative_budget_changes VALUES (v_period, 1, v_cap, NULL, v_reason, actor, at);
  ELSE
    at := greatest(at, b.set_at);
    INSERT INTO hon.hq_creative_budget_changes VALUES (v_period, b.version + 1, v_cap, b.credit_cap, v_reason, actor, at);
    UPDATE hon.hq_creative_budget_periods SET credit_cap = v_cap, version = version + 1, set_by = actor, set_at = at
      WHERE period_start = v_period RETURNING * INTO b;
  END IF;
  result := jsonb_build_object('budget', hon.hq_creative_budget_json(v_period));
  INSERT INTO hon.hq_creative_requests VALUES (actor, p_key, 'BUDGET', fp, result, at);
  PERFORM hon.require_hq_creative_owner(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- CREATE (manage): {operationCode, units, format, prompt, campaignId|null} and the server's provider route {providerId,
-- modelCode} (never a client choice). The same requester and key return the same generation (never a second reservation
-- or provider call); the same key with another body is refused. Reserves against this UTC month's HQ cap.
CREATE FUNCTION hon.create_hq_creative_generation(p_subject text, p_input jsonb, p_provider jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; fp text; existing hon.hq_creative_generations%ROWTYPE; created hon.hq_creative_generations%ROWTYPE;
  rate hon.saas_creative_rates%ROWTYPE; b hon.hq_creative_budget_periods%ROWTYPE; c hon.hq_marketing_campaigns%ROWTYPE;
  v_period date; v_units integer; v_credits integer; v_campaign uuid; budget jsonb; at timestamptz; result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, true);
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['campaignId','format','operationCode','prompt','units']
    OR jsonb_typeof(p_input->'operationCode') IS DISTINCT FROM 'string' OR (p_input->>'operationCode') !~ '^[a-z][a-z0-9_.]{2,59}$'
    OR jsonb_typeof(p_input->'units') IS DISTINCT FROM 'number' OR (p_input->>'units') !~ '^[1-9][0-9]{0,3}$' OR (p_input->>'units')::integer > 1000
    OR coalesce(p_input->>'format', '') NOT IN ('SQUARE','PORTRAIT','LANDSCAPE') OR jsonb_typeof(p_input->'format') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'prompt') IS DISTINCT FROM 'string' OR NOT hon.creative_prompt_ok(p_input->>'prompt')
    OR NOT (jsonb_typeof(p_input->'campaignId') = 'null' OR (jsonb_typeof(p_input->'campaignId') = 'string'
      AND (p_input->>'campaignId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR p_provider IS NULL OR jsonb_typeof(p_provider) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_provider) k) IS DISTINCT FROM ARRAY['modelCode','providerId']
    OR jsonb_typeof(p_provider->'providerId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_provider->'modelCode') IS DISTINCT FROM 'string'
    OR NOT coalesce(hon.hq_ai_safe_text(p_provider->>'modelCode', true), false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_units := (p_input->>'units')::integer; v_campaign := (p_input->>'campaignId')::uuid;
  fp := hon.saas_fingerprint(ARRAY['hq.creative.generation', p_input::text]);
  -- One request per requester and key at a time; a concurrent duplicate waits, then replays.
  PERFORM pg_advisory_xact_lock(hashtextextended('hq-creative-generation:' || actor::text || ':' || p_key::text, 0));
  SELECT * INTO existing FROM hon.hq_creative_generations WHERE requested_by = actor AND idempotency_key = p_key;
  IF FOUND THEN
    IF existing.request_fingerprint <> fp THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    PERFORM hon.require_hq_marketing_actor(p_subject, true);
    RETURN hon.hq_creative_receipt(existing, true);
  END IF;
  IF EXISTS (SELECT 1 FROM hon.ai_spend_pauses p WHERE p.ended_at IS NULL AND p.organization_id IS NULL AND p.spend_class IN ('CREATIVE_MEDIA','ALL')) THEN
    RAISE EXCEPTION 'HQ_CREATIVE_PAUSED_BY_HQ' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.hq_ai_provider_connections WHERE provider_id = p_provider->>'providerId') THEN
    RAISE EXCEPTION 'HQ_CREATIVE_PROVIDER_UNKNOWN' USING ERRCODE = '23514';
  END IF;
  IF v_campaign IS NOT NULL THEN
    SELECT * INTO c FROM hon.hq_marketing_campaigns WHERE id = v_campaign;
    IF c.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
    IF c.status = 'ARCHIVED' THEN RAISE EXCEPTION 'HQ_CAMPAIGN_ARCHIVED' USING ERRCODE = '23514'; END IF;
  END IF;
  SELECT r.* INTO rate FROM hon.saas_creative_rates r JOIN hon.saas_creative_rate_versions v ON v.id = r.rate_version_id
    WHERE v.status = 'PUBLISHED' AND r.operation_code = p_input->>'operationCode';
  IF rate.operation_code IS NULL THEN RAISE EXCEPTION 'HQ_CREATIVE_OPERATION_NOT_PRICED' USING ERRCODE = '23514'; END IF;
  IF v_units > rate.max_units_per_request THEN RAISE EXCEPTION 'HQ_CREATIVE_UNITS_EXCEEDED' USING ERRCODE = '23514'; END IF;
  v_credits := rate.credits_per_unit * v_units;
  -- The month is decided after the key lock wait; the period lock serializes the cap check and the insert.
  v_period := hon.hq_creative_period(clock_timestamp());
  PERFORM hon.hq_creative_lock_period(v_period);
  at := clock_timestamp();
  IF hon.hq_creative_period(at) <> v_period THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  SELECT * INTO b FROM hon.hq_creative_budget_periods WHERE period_start = v_period;
  IF b.period_start IS NULL THEN RAISE EXCEPTION 'HQ_CREATIVE_BUDGET_NOT_SET' USING ERRCODE = '23514'; END IF;
  budget := hon.hq_creative_budget_json(v_period);
  IF (budget->>'inProgress')::integer >= 3 THEN RAISE EXCEPTION 'HQ_CREATIVE_TOO_MANY_IN_PROGRESS' USING ERRCODE = '23514'; END IF;
  IF v_credits > (budget->>'availableCredits')::bigint THEN RAISE EXCEPTION 'HQ_CREATIVE_BUDGET_EXHAUSTED' USING ERRCODE = '23514'; END IF;
  INSERT INTO hon.hq_creative_generations (period_start, campaign_id, requested_by, idempotency_key, request_fingerprint, rate_version_id,
    operation_code, media_kind, credits_per_unit, units, reserved_credits, format, prompt, provider_id, model_code, status, cost_status,
    version, created_at)
  VALUES (v_period, v_campaign, actor, p_key, fp, rate.rate_version_id, rate.operation_code, rate.media_kind, rate.credits_per_unit, v_units,
    v_credits, p_input->>'format', p_input->>'prompt', p_provider->>'providerId', p_provider->>'modelCode', 'GENERATING', 'PENDING', 1, at)
  RETURNING * INTO created;
  result := hon.hq_creative_receipt(created, false);
  -- Finality: authority is decided again after every write and wait; a grant that ended meanwhile rolls everything back,
  -- so the API never hands an unauthorized request to a provider.
  PERFORM hon.require_hq_marketing_actor(p_subject, true);
  RETURN result;
END $$;

-- RECORD: the provider outcome, exactly once, by the generation's own requester (person check only: no grant, pause or
-- budget check, so an in-flight result is never lost). {outcome, finalUnits, providerCostMicrounits, failureReason, assets}
-- as in 0216. UNKNOWN with reason INTERRUPTED is accepted only after the request has been open for 120 seconds.
CREATE FUNCTION hon.record_hq_creative_generation_result(p_subject text, p_generation uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE g hon.hq_creative_generations%ROWTYPE; outcome text; reason text; n integer; a jsonb; i integer := 0; at timestamptz;
BEGIN
  IF p_generation IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['assets','failureReason','finalUnits','outcome','providerCostMicrounits'] THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  outcome := p->>'outcome'; reason := p->>'failureReason';
  IF NOT coalesce(CASE outcome
      WHEN 'SUCCEEDED' THEN jsonb_typeof(p->'finalUnits') = 'number' AND (p->>'finalUnits') ~ '^[1-9][0-9]{0,3}$'
        AND jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'
        AND jsonb_typeof(p->'assets') = 'array' AND jsonb_array_length(p->'assets') BETWEEN 1 AND 8 AND jsonb_typeof(p->'failureReason') = 'null'
      WHEN 'FAILED' THEN jsonb_typeof(p->'finalUnits') = 'null' AND jsonb_typeof(p->'assets') = 'null' AND reason = 'PROVIDER_REJECTED'
        AND (jsonb_typeof(p->'providerCostMicrounits') = 'null' OR (jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'))
      WHEN 'NOT_SENT' THEN jsonb_typeof(p->'finalUnits') = 'null' AND jsonb_typeof(p->'assets') = 'null' AND jsonb_typeof(p->'providerCostMicrounits') = 'null'
        AND reason IN ('PROVIDER_NOT_CONNECTED','INVALID_REQUEST')
      WHEN 'UNKNOWN' THEN jsonb_typeof(p->'finalUnits') = 'null' AND jsonb_typeof(p->'assets') = 'null' AND jsonb_typeof(p->'providerCostMicrounits') = 'null'
        AND reason IN ('PROVIDER_UNKNOWN','UNVERIFIED_RESULT','INTERRUPTED')
      ELSE false END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO g FROM hon.hq_creative_generations WHERE id = p_generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.saas_creative_evidence_actor(p_subject, g.requested_by);
  PERFORM hon.hq_creative_lock_period(g.period_start);
  SELECT * INTO g FROM hon.hq_creative_generations WHERE id = p_generation FOR UPDATE;
  IF g.status <> 'GENERATING' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp();
  IF reason = 'INTERRUPTED' AND at < g.created_at + interval '120 seconds' THEN
    RAISE EXCEPTION 'CREATIVE_GENERATION_IN_PROGRESS' USING ERRCODE = '40001';
  END IF;
  IF outcome = 'SUCCEEDED' THEN
    n := (p->>'finalUnits')::integer;
    IF n > g.units OR (g.media_kind = 'VIDEO' AND jsonb_array_length(p->'assets') <> 1) THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
    FOR a IN SELECT x FROM jsonb_array_elements(p->'assets') x LOOP
      IF jsonb_typeof(a) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a) k) IS DISTINCT FROM ARRAY['durationSeconds','height','mediaType','providerAssetReference','width']
        OR coalesce(a->>'mediaType', '') NOT IN (CASE g.media_kind WHEN 'IMAGE' THEN 'image/png' ELSE 'video/mp4' END, CASE g.media_kind WHEN 'IMAGE' THEN 'image/webp' ELSE 'video/mp4' END)
        OR coalesce(jsonb_typeof(a->'width'), '') <> 'number' OR (a->>'width') !~ '^[1-9][0-9]{0,3}$' OR (a->>'width')::integer > 8192
        OR coalesce(jsonb_typeof(a->'height'), '') <> 'number' OR (a->>'height') !~ '^[1-9][0-9]{0,3}$' OR (a->>'height')::integer > 8192
        OR (g.media_kind = 'IMAGE' AND jsonb_typeof(a->'durationSeconds') <> 'null')
        OR (g.media_kind = 'VIDEO' AND NOT (jsonb_typeof(a->'durationSeconds') = 'number' AND (a->>'durationSeconds') ~ '^[1-9][0-9]{0,2}$' AND (a->>'durationSeconds')::integer <= 600))
        OR coalesce(jsonb_typeof(a->'providerAssetReference'), '') <> 'string' OR (a->>'providerAssetReference') !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$' THEN
        RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
      END IF;
    END LOOP;
    UPDATE hon.hq_creative_generations SET status = 'SUCCEEDED', final_units = n, charged_credits = n * credits_per_unit, cost_status = 'RECORDED',
      provider_cost_microunits = (p->>'providerCostMicrounits')::bigint, version = version + 1, completed_at = greatest(at, created_at)
    WHERE id = g.id RETURNING * INTO g;
    FOR a IN SELECT x FROM jsonb_array_elements(p->'assets') x LOOP
      i := i + 1;
      INSERT INTO hon.hq_creative_generation_assets (generation_id, ordinal, media_type, width, height, duration_seconds, origin, provider_asset_reference, created_at)
      VALUES (g.id, i, a->>'mediaType', (a->>'width')::integer, (a->>'height')::integer, (a->>'durationSeconds')::integer, 'SYNTHETIC', a->>'providerAssetReference', at);
    END LOOP;
  ELSIF outcome = 'FAILED' THEN
    UPDATE hon.hq_creative_generations SET status = 'FAILED', failure_reason = reason,
      cost_status = CASE WHEN jsonb_typeof(p->'providerCostMicrounits') = 'number' THEN 'RECORDED' ELSE 'UNKNOWN' END,
      provider_cost_microunits = (p->>'providerCostMicrounits')::bigint, version = version + 1, completed_at = greatest(at, created_at)
    WHERE id = g.id RETURNING * INTO g;
  ELSIF outcome = 'NOT_SENT' THEN
    -- The request never left the server, so its provider cost is a known zero (not a guess).
    UPDATE hon.hq_creative_generations SET status = 'FAILED', failure_reason = reason, cost_status = 'RECORDED', provider_cost_microunits = 0,
      version = version + 1, completed_at = greatest(at, created_at)
    WHERE id = g.id RETURNING * INTO g;
  ELSE
    UPDATE hon.hq_creative_generations SET status = 'UNDER_REVIEW', failure_reason = reason, version = version + 1, completed_at = greatest(at, created_at)
    WHERE id = g.id RETURNING * INTO g;
  END IF;
  RETURN hon.hq_creative_receipt(g, false);
END $$;

-- RESOLVE (HQ owner only): {expectedVersion, resolution SUCCEEDED | NOT_CHARGED, finalUnits (SUCCEEDED only),
-- providerCostMicrounits (number or null = unknown), evidenceReference}. For a request GENERATING or UNDER_REVIEW.
CREATE FUNCTION hon.resolve_hq_creative_generation(p_subject text, p_generation uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; fp text; g hon.hq_creative_generations%ROWTYPE; v_units integer; v_ref text; v_cost bigint; at timestamptz; result jsonb;
BEGIN
  actor := hon.require_hq_creative_owner(p_subject);
  IF p_generation IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['evidenceReference','expectedVersion','finalUnits','providerCostMicrounits','resolution']
    OR coalesce(p_input->>'resolution', '') NOT IN ('SUCCEEDED','NOT_CHARGED') OR jsonb_typeof(p_input->'resolution') IS DISTINCT FROM 'string'
    OR NOT (jsonb_typeof(p_input->'providerCostMicrounits') = 'null'
      OR (jsonb_typeof(p_input->'providerCostMicrounits') = 'number' AND (p_input->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'))
    OR NOT (CASE p_input->>'resolution' WHEN 'SUCCEEDED' THEN jsonb_typeof(p_input->'finalUnits') = 'number' AND (p_input->>'finalUnits') ~ '^[0-9]{1,4}$'
      ELSE jsonb_typeof(p_input->'finalUnits') = 'null' END) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  PERFORM hon.hq_marketing_expected(p_input);
  v_ref := hon.hq_marketing_text(p_input, 'evidenceReference', 1, 200);
  v_cost := (p_input->>'providerCostMicrounits')::bigint;
  fp := hon.saas_fingerprint(ARRAY['hq.creative.resolve', p_generation::text, p_input::text]);
  replay := hon.hq_creative_claim(actor, p_key, 'RESOLVE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_creative_owner(p_subject); RETURN replay; END IF;
  SELECT * INTO g FROM hon.hq_creative_generations WHERE id = p_generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.hq_creative_lock_period(g.period_start);
  SELECT * INTO g FROM hon.hq_creative_generations WHERE id = p_generation FOR UPDATE;
  IF g.version <> (p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF g.status NOT IN ('GENERATING','UNDER_REVIEW') THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := greatest(clock_timestamp(), g.created_at);
  IF p_input->>'resolution' = 'SUCCEEDED' THEN
    v_units := (p_input->>'finalUnits')::integer;
    IF v_units > g.units THEN RAISE EXCEPTION 'HQ_CREATIVE_FINAL_EXCEEDS_RESERVATION' USING ERRCODE = '23514'; END IF;
    UPDATE hon.hq_creative_generations SET status = 'RESOLVED_CHARGED', final_units = v_units, charged_credits = v_units * credits_per_unit,
      cost_status = CASE WHEN v_cost IS NULL THEN 'UNKNOWN' ELSE 'RECORDED' END, provider_cost_microunits = v_cost, resolution_reference = v_ref,
      resolved_by = actor, version = version + 1, completed_at = coalesce(completed_at, at)
    WHERE id = g.id RETURNING * INTO g;
  ELSE
    UPDATE hon.hq_creative_generations SET status = 'RESOLVED_NOT_CHARGED', cost_status = CASE WHEN v_cost IS NULL THEN 'UNKNOWN' ELSE 'RECORDED' END,
      provider_cost_microunits = v_cost, resolution_reference = v_ref, resolved_by = actor, version = version + 1, completed_at = coalesce(completed_at, at)
    WHERE id = g.id RETURNING * INTO g;
  END IF;
  result := jsonb_build_object('generation', hon.hq_creative_generation_json(g), 'budget', hon.hq_creative_budget_json(g.period_start));
  INSERT INTO hon.hq_creative_requests VALUES (actor, p_key, 'RESOLVE', fp, result, clock_timestamp());
  PERFORM hon.require_hq_creative_owner(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ---------- reads ----------
-- The studio: this UTC month's budget, the newest 12 cap changes, the published rates (same as schools, read only), the
-- newest 50 requests and the viewer. Provider identity, model and provider cost are never shown.
CREATE FUNCTION hon.read_hq_creative_studio(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, false);
  result := jsonb_build_object('budget', hon.hq_creative_budget_json(hon.hq_creative_period(clock_timestamp())),
    'budgetHistory', (SELECT coalesce(jsonb_agg(jsonb_build_object('periodStart', to_char(h.period_start, 'YYYY-MM-DD'), 'version', h.version,
        'creditCap', h.credit_cap, 'previousCap', h.previous_cap, 'reason', h.reason, 'actor', hon.hq_marketing_person_json(h.actor_principal_id),
        'recordedAt', hon.saas_ts(h.recorded_at)) ORDER BY h.recorded_at DESC, h.period_start DESC, h.version DESC), '[]'::jsonb)
      FROM (SELECT * FROM hon.hq_creative_budget_changes ORDER BY recorded_at DESC, period_start DESC, version DESC LIMIT 12) h),
    'rates', (SELECT coalesce(jsonb_agg(jsonb_build_object('operationCode', r.operation_code, 'mediaKind', r.media_kind, 'displayName', r.display_name,
        'billingUnit', r.billing_unit, 'creditsPerUnit', r.credits_per_unit, 'maxUnitsPerRequest', r.max_units_per_request) ORDER BY r.operation_code), '[]'::jsonb)
      FROM hon.saas_creative_rates r JOIN hon.saas_creative_rate_versions v ON v.id = r.rate_version_id AND v.status = 'PUBLISHED'),
    'generations', (SELECT coalesce(jsonb_agg(hon.hq_creative_generation_json(g) ORDER BY g.created_at DESC, g.id DESC), '[]'::jsonb)
      FROM (SELECT * FROM hon.hq_creative_generations ORDER BY created_at DESC, id DESC LIMIT 50) g),
    'limit', 50, 'viewer', hon.hq_creative_viewer_json(actor), 'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_marketing_actor(p_subject, false);
  RETURN result;
END $$;

CREATE FUNCTION hon.read_hq_creative_generation(p_subject text, p_generation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; g hon.hq_creative_generations%ROWTYPE; result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, false);
  IF p_generation IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO g FROM hon.hq_creative_generations WHERE id = p_generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  result := hon.hq_creative_generation_json(g);
  PERFORM hon.require_hq_marketing_actor(p_subject, false);
  RETURN result;
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['guard_hq_creative_record()','guard_hq_creative_evidence()','hq_creative_owner_eligible(uuid)',
    'require_hq_creative_owner(text)','hq_creative_period(timestamptz)','hq_creative_lock_period(date)','hq_creative_budget_json(date)',
    'hq_creative_generation_json(hon.hq_creative_generations)','hq_creative_viewer_json(uuid)','hq_creative_receipt(hon.hq_creative_generations,boolean)',
    'hq_creative_claim(uuid,uuid,text,text)','hq_creative_reference(jsonb,text)','set_hq_creative_budget(text,jsonb,uuid)',
    'create_hq_creative_generation(text,jsonb,jsonb,uuid)','record_hq_creative_generation_result(text,uuid,jsonb)',
    'resolve_hq_creative_generation(text,uuid,jsonb,uuid)','read_hq_creative_studio(text)','read_hq_creative_generation(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.set_hq_creative_budget(text,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.create_hq_creative_generation(text,jsonb,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.record_hq_creative_generation_result(text,uuid,jsonb) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.resolve_hq_creative_generation(text,uuid,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_hq_creative_studio(text) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_hq_creative_generation(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
