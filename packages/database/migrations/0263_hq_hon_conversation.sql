BEGIN;

-- B1 HQ Ask HON + HQ AI text budget (0263, allocated by the coordinator 2026-11-11). HQ gets its own HON conversation:
-- an HQ person asks HON a question about HON OS itself and HON answers from the HQ platform overview (0127). It mirrors
-- the school conversation but has no organization or school, and it is paid from a separate monthly HQ AI text budget
-- set by the human HQ owner (the 0253 HQ Creative Studio budget pattern): an internal planning limit in credits, never a
-- charge, a provider budget or a payment.
--
-- S4 for HQ: one turn reserves the mode's fixed credits (STANDARD 10, DETAILED 15, the school HON numbers) against this
-- UTC month's HQ cap under the period lock, after the platform AGENT_INFERENCE / ALL emergency pause gate; the route is
-- chosen here (never by a caller); the API makes at most one provider call; the outcome is recorded exactly once with
-- measured tokens and cost (ANSWERED charges ceil(tokens / 1000), never above the reservation; FAILED and NOT_SENT charge
-- nothing; anything unknown or out of bounds is held UNDER_REVIEW until the HQ owner resolves it with evidence).
--
-- Fully separate from every school: nothing here reads or writes ai_usage_ledger, ai_invocation_plans, a school AI
-- budget, hon_turns / hon_reply_invocations or any school creative wallet. School authority never reaches HQ: only an HQ
-- grant is accepted. HON reads and recommends only; it never sends, changes or approves anything.
--
-- Authority: HQ owner, or HQ operator holding hq.dashboard.view (the overview's own permission), asks and reads their
-- own turns; the HQ owner alone sets the cap and resolves held turns. An answer is shown only while the reader still
-- holds every permission its facts used (source_permissions). No provider is connected by this migration: the API
-- refuses a turn (503) before any write while the provider runtime is unconfigured (OPENROUTER_PAID_CALL_APPROVED).
-- Executives (B2, 0264) plug in through hon.hq_hon_agent_permission and hon.hq_hon_agent_facts.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ Ask HON requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.read_hq_platform_overview(text)') IS NULL OR to_regprocedure('hon.hq_marketing_person_json(uuid)') IS NULL
    OR to_regclass('hon.ai_spend_pauses') IS NULL OR to_regclass('hon.hq_ai_model_catalog') IS NULL
    OR to_regprocedure('hon.saas_fingerprint(text[])') IS NULL THEN
    RAISE EXCEPTION 'HQ Ask HON requires the HQ overview (0127), HQ marketing (0252), S4 pauses (0195) and the HQ AI catalog (0052)';
  END IF;
END $$;

-- ---------- tables ----------
CREATE TABLE hon.hq_hon_budget_periods (
  period_start date PRIMARY KEY CHECK (extract(day FROM period_start) = 1),
  credit_cap integer NOT NULL CHECK (credit_cap BETWEEN 0 AND 10000000),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 999999999),
  set_by uuid NOT NULL REFERENCES hon.principals(id),
  set_at timestamptz NOT NULL
);

CREATE TABLE hon.hq_hon_budget_changes (
  period_start date NOT NULL REFERENCES hon.hq_hon_budget_periods(period_start),
  version integer NOT NULL CHECK (version > 0),
  credit_cap integer NOT NULL CHECK (credit_cap BETWEEN 0 AND 10000000),
  previous_cap integer CHECK (previous_cap BETWEEN 0 AND 10000000),
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 300),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (period_start, version),
  CHECK ((version = 1) = (previous_cap IS NULL))
);

CREATE TABLE hon.hq_hon_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start date NOT NULL REFERENCES hon.hq_hon_budget_periods(period_start),
  asked_by uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  -- B1: HON only. B2 (0264) widens this to the six HQ executives.
  agent_key text NOT NULL CHECK (agent_key = 'hon'),
  reply_mode text NOT NULL CHECK (reply_mode IN ('STANDARD','DETAILED')),
  question text NOT NULL CHECK (question = btrim(question) AND length(question) BETWEEN 1 AND 2000 AND question !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'),
  input_budget integer NOT NULL CHECK (input_budget BETWEEN 1 AND 100000),
  output_budget integer NOT NULL CHECK (output_budget BETWEEN 1 AND 100000),
  max_cost_microunits bigint NOT NULL CHECK (max_cost_microunits BETWEEN 1 AND 1000000000),
  reserved_credits integer NOT NULL CHECK (reserved_credits BETWEEN 1 AND 1000),
  provider_id text NOT NULL REFERENCES hon.hq_ai_provider_connections(provider_id),
  model_id text NOT NULL CHECK (hon.hq_ai_safe_text(model_id, true)),
  catalog_id uuid NOT NULL REFERENCES hon.hq_ai_model_catalog(catalog_id),
  catalog_version integer NOT NULL CHECK (catalog_version >= 1),
  -- The permissions the facts were read under; the answer is concealed when the reader no longer holds every one.
  source_permissions text[] NOT NULL CHECK (cardinality(source_permissions) BETWEEN 1 AND 4 AND array_position(source_permissions, NULL) IS NULL
    AND source_permissions <@ ARRAY['hq.dashboard.view','hq.marketing.read','hq.support.manage','hq.billing.manage']::text[]),
  status text NOT NULL CHECK (status IN ('ANSWERING','ANSWERED','FAILED','UNDER_REVIEW','RESOLVED_CHARGED','RESOLVED_NOT_CHARGED')),
  failure_reason text,
  reply text CHECK (reply = btrim(reply) AND length(reply) BETWEEN 1 AND 24000),
  truncated boolean,
  input_tokens integer CHECK (input_tokens BETWEEN 1 AND 1000000),
  output_tokens integer CHECK (output_tokens BETWEEN 1 AND 1000000),
  charged_credits integer CHECK (charged_credits >= 0),
  -- Provider expense, separate from the HQ credits: PENDING while open; RECORDED when reported or evidenced (zero only when
  -- the request never left the server); UNKNOWN when it ended without a known cost (never a guessed zero).
  cost_status text NOT NULL CHECK (cost_status IN ('PENDING','RECORDED','UNKNOWN')),
  provider_cost_microunits bigint CHECK (provider_cost_microunits BETWEEN 0 AND 1000000000),
  resolution_reference text CHECK (resolution_reference = btrim(resolution_reference) AND length(resolution_reference) BETWEEN 1 AND 200),
  resolved_by uuid REFERENCES hon.principals(id),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (asked_by, idempotency_key),
  CHECK (period_start = date_trunc('month', created_at AT TIME ZONE 'UTC')::date),
  CHECK ((status = 'ANSWERING') = (completed_at IS NULL)),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK ((cost_status = 'RECORDED') = (provider_cost_microunits IS NOT NULL)),
  CHECK ((status IN ('RESOLVED_CHARGED','RESOLVED_NOT_CHARGED')) = (resolved_by IS NOT NULL AND resolution_reference IS NOT NULL)),
  CHECK (charged_credits IS NULL OR charged_credits <= reserved_credits),
  CHECK (CASE status
    WHEN 'ANSWERING' THEN failure_reason IS NULL AND reply IS NULL AND truncated IS NULL AND input_tokens IS NULL AND output_tokens IS NULL
      AND charged_credits IS NULL AND cost_status = 'PENDING'
    WHEN 'ANSWERED' THEN failure_reason IS NULL AND reply IS NOT NULL AND truncated IS NOT NULL AND input_tokens <= input_budget
      AND output_tokens <= output_budget AND charged_credits = least(reserved_credits, (input_tokens + output_tokens + 999) / 1000)
      AND cost_status = 'RECORDED' AND provider_cost_microunits <= max_cost_microunits
    WHEN 'FAILED' THEN failure_reason IN ('PROVIDER_REJECTED','CONFIGURATION_REQUIRED','UNSUPPORTED_PROVIDER','INVALID_REQUEST') AND reply IS NULL
      AND charged_credits IS NULL AND cost_status IN ('RECORDED','UNKNOWN')
    WHEN 'UNDER_REVIEW' THEN failure_reason IN ('PROVIDER_UNKNOWN','UNVERIFIED_RESULT','INTERRUPTED') AND reply IS NULL
      AND charged_credits IS NULL AND cost_status = 'PENDING'
    WHEN 'RESOLVED_CHARGED' THEN reply IS NULL AND charged_credits IS NOT NULL AND cost_status IN ('RECORDED','UNKNOWN')
    ELSE reply IS NULL AND charged_credits IS NULL AND cost_status IN ('RECORDED','UNKNOWN') END)
);
CREATE INDEX hq_hon_turns_asker_idx ON hon.hq_hon_turns (asked_by, created_at DESC, id DESC);
CREATE INDEX hq_hon_turns_period_idx ON hon.hq_hon_turns (period_start, status);

CREATE TABLE hon.hq_hon_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('BUDGET','RESOLVE')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (actor_principal_id, idempotency_key)
);

-- ---------- immutability ----------
-- A budget period changes only by a version bump of its cap; a turn moves only ANSWERING -> a result, or
-- ANSWERING/UNDER_REVIEW -> resolved, with every request field unchanged. History and requests never change.
CREATE FUNCTION hon.guard_hq_hon_record() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE moving text[];
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'HQ_HON_RECORD_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'hq_hon_budget_periods' THEN
    IF (to_jsonb(NEW)->>'set_at')::timestamptz >= (to_jsonb(OLD)->>'set_at')::timestamptz
      AND (to_jsonb(NEW) - ARRAY['credit_cap','version','set_by','set_at']) = (to_jsonb(OLD) - ARRAY['credit_cap','version','set_by','set_at']) THEN
      RETURN NEW;
    END IF;
  ELSIF (to_jsonb(OLD)->>'status' = 'ANSWERING' AND to_jsonb(NEW)->>'status' IN ('ANSWERED','FAILED','UNDER_REVIEW','RESOLVED_CHARGED','RESOLVED_NOT_CHARGED'))
      OR (to_jsonb(OLD)->>'status' = 'UNDER_REVIEW' AND to_jsonb(NEW)->>'status' IN ('RESOLVED_CHARGED','RESOLVED_NOT_CHARGED')) THEN
    moving := ARRAY['status','failure_reason','reply','truncated','input_tokens','output_tokens','charged_credits','cost_status',
      'provider_cost_microunits','resolution_reference','resolved_by','version','completed_at'];
    IF (to_jsonb(NEW) - moving) = (to_jsonb(OLD) - moving)
      AND (to_jsonb(OLD)->'completed_at' = 'null'::jsonb OR to_jsonb(NEW)->'completed_at' = to_jsonb(OLD)->'completed_at')
      AND (to_jsonb(OLD)->'failure_reason' = 'null'::jsonb OR to_jsonb(NEW)->'failure_reason' = to_jsonb(OLD)->'failure_reason') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'HQ_HON_RECORD_IMMUTABLE' USING ERRCODE = '42501';
END $$;
CREATE FUNCTION hon.guard_hq_hon_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN RAISE EXCEPTION 'HQ_HON_RECORD_IMMUTABLE' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_hon_budget_periods FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_hon_record();
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_hon_turns FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_hon_record();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_hon_budget_changes FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_hon_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_hon_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_hon_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_hon_budget_periods FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_hon_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_hon_budget_changes FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_hon_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_hon_turns FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_hon_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_hon_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_hon_evidence();

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_hon_budget_periods','hq_hon_budget_changes','hq_hon_turns','hq_hon_requests'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
    END LOOP;
  END LOOP;
END $$;

-- ---------- authority ----------
-- HQ grants only. The same person rules as HQ marketing (0252): one active human principal, no family access. The HQ
-- owner holds every HQ permission; an operator holds exactly the codes on their live grant. Support grants never count.
CREATE FUNCTION hon.hq_hon_permission_held(p_principal uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.principals p WHERE p.id = p_principal AND p.is_active AND p.principal_type = 'HUMAN_USER'
    AND (SELECT count(*) FROM hon.principals o WHERE o.user_id = p.user_id AND o.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p.id
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (g.hq_role = 'HON_HQ_OWNER' OR (g.hq_role = 'HON_HQ_OPERATOR' AND p_permission = ANY(g.permission_codes))))
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp())))
$$;

CREATE FUNCTION hon.hq_hon_owner_eligible(p_principal uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT hon.hq_hon_permission_held(p_principal, 'hq.dashboard.view') AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g
    WHERE g.principal_id = p_principal AND g.hq_role = 'HON_HQ_OWNER'
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp()))
$$;

-- p_owner: the HQ owner only (cap, resolutions); otherwise anyone who may ask HQ HON (hq.dashboard.view).
CREATE FUNCTION hon.require_hq_hon_actor(p_subject text, p_owner boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid;
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  WHERE u.external_subject = p_subject AND p.is_active AND hon.hq_hon_permission_held(p.id, 'hq.dashboard.view')
    AND (NOT coalesce(p_owner, true) OR hon.hq_hon_owner_eligible(p.id));
  IF actor IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END $$;

-- ---------- plug-in points (B2 adds the executives) ----------
-- The one HQ permission an agent's facts need. B1: HON reads the HQ overview under hq.dashboard.view.
CREATE FUNCTION hon.hq_hon_agent_permission(p_agent text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_agent WHEN 'hon' THEN 'hq.dashboard.view' END
$$;

-- The agent's facts, read with the asker's own authority (each reader re-checks it). Aggregate counts only.
CREATE FUNCTION hon.hq_hon_agent_facts(p_subject text, p_agent text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE overview jsonb;
BEGIN
  IF p_agent IS DISTINCT FROM 'hon' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  overview := hon.read_hq_platform_overview(p_subject);
  RETURN jsonb_build_object('hqOverview', overview - 'callerHqRole',
    'hqAiTextBudget', hon.hq_hon_budget_json(hon.hq_hon_period(clock_timestamp())) - ARRAY['setBy','setAt','version']);
END $$;

-- ---------- helpers ----------
CREATE FUNCTION hon.hq_hon_period(p_at timestamptz) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$ SELECT date_trunc('month', p_at AT TIME ZONE 'UTC')::date $$;

-- One lock per budget period: the cap change, every new turn, every result and every resolution of that month.
CREATE FUNCTION hon.hq_hon_lock_period(p_period date) RETURNS void
LANGUAGE sql VOLATILE SET search_path = pg_catalog, hon AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('hq-hon-period:' || p_period::text, 0))
$$;

-- The fixed per-mode limits, the school HON numbers (packages/contracts HON_REPLY_MODES): never a caller value.
CREATE FUNCTION hon.hq_hon_mode_limits(p_mode text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_mode
    WHEN 'STANDARD' THEN '{"inputBudget":8000,"outputBudget":1500,"maxCostMicrounits":80000,"reservedCredits":10}'::jsonb
    WHEN 'DETAILED' THEN '{"inputBudget":11000,"outputBudget":4000,"maxCostMicrounits":80000,"reservedCredits":15}'::jsonb END
$$;

CREATE FUNCTION hon.hq_hon_budget_json(p_period date) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH use AS (SELECT coalesce(sum(charged_credits) FILTER (WHERE status IN ('ANSWERED','RESOLVED_CHARGED')), 0)::bigint used,
      coalesce(sum(reserved_credits) FILTER (WHERE status IN ('ANSWERING','UNDER_REVIEW')), 0)::bigint held,
      count(*) FILTER (WHERE status = 'ANSWERING')::integer busy
    FROM hon.hq_hon_turns WHERE period_start = p_period)
  SELECT jsonb_build_object('periodStart', to_char(p_period, 'YYYY-MM-DD'), 'creditCap', b.credit_cap, 'usedCredits', use.used,
    'heldCredits', use.held, 'availableCredits', CASE WHEN b.credit_cap IS NULL THEN 0 ELSE greatest(b.credit_cap - use.used - use.held, 0) END,
    'inProgress', use.busy, 'version', b.version, 'setBy', CASE WHEN b.set_by IS NULL THEN NULL ELSE hon.hq_marketing_person_json(b.set_by) END,
    'setAt', CASE WHEN b.set_at IS NULL THEN NULL ELSE hon.saas_ts(b.set_at) END)
  FROM use LEFT JOIN hon.hq_hon_budget_periods b ON b.period_start = p_period
$$;

-- p_reader: the answer is shown only while the reader holds every source permission now. Provider, model and cost are
-- never shown.
CREATE FUNCTION hon.hq_hon_turn_json(t hon.hq_hon_turns, p_reader uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH allowed AS (SELECT bool_and(hon.hq_hon_permission_held(p_reader, perm)) ok FROM unnest(t.source_permissions) perm)
  SELECT jsonb_build_object('turnId', t.id, 'agentKey', t.agent_key, 'replyMode', t.reply_mode, 'question', t.question,
    'status', t.status, 'failureReason', t.failure_reason,
    'reply', CASE WHEN allowed.ok THEN t.reply END, 'truncated', t.truncated,
    'concealed', t.reply IS NOT NULL AND NOT allowed.ok,
    'reservedCredits', t.reserved_credits, 'chargedCredits', t.charged_credits, 'askedBy', hon.hq_marketing_person_json(t.asked_by),
    'version', t.version, 'createdAt', hon.saas_ts(t.created_at),
    'completedAt', CASE WHEN t.completed_at IS NULL THEN NULL ELSE hon.saas_ts(t.completed_at) END)
  FROM allowed
$$;

CREATE FUNCTION hon.hq_hon_claim(p_actor uuid, p_key uuid, p_operation text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prior hon.hq_hon_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hq-hon:' || p_actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO prior FROM hon.hq_hon_requests WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.operation <> p_operation OR prior.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
  RETURN prior.response || jsonb_build_object('replayed', true);
END $$;

CREATE FUNCTION hon.hq_hon_text(p_input jsonb, p_key text, p_min integer, p_max integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF jsonb_typeof(p_input->p_key) IS DISTINCT FROM 'string' OR (p_input->>p_key) <> btrim(p_input->>p_key)
    OR length(p_input->>p_key) NOT BETWEEN p_min AND p_max OR (p_input->>p_key) ~ '[\x01-\x1F\x7F]' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN p_input->>p_key;
END $$;

CREATE FUNCTION hon.hq_hon_expected(p_input jsonb) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN (p_input->>'expectedVersion')::integer;
END $$;

-- ---------- commands ----------
-- BUDGET (HQ owner only): {periodStart, creditCap, expectedVersion (null for a new month), reason}. Only the current or a
-- future UTC month (at most 12 ahead). A cap below what the month already used plus holds is refused.
CREATE FUNCTION hon.set_hq_hon_budget(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; fp text; v_period date; v_cap integer; v_reason text; b hon.hq_hon_budget_periods%ROWTYPE;
  v_now date; v_committed bigint; at timestamptz; result jsonb;
BEGIN
  actor := hon.require_hq_hon_actor(p_subject, true);
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['creditCap','expectedVersion','periodStart','reason']
    OR jsonb_typeof(p_input->'creditCap') IS DISTINCT FROM 'number' OR (p_input->>'creditCap') !~ '^(0|[1-9][0-9]{0,7})$'
    OR (p_input->>'creditCap')::integer > 10000000
    OR NOT (jsonb_typeof(p_input->'expectedVersion') = 'null'
      OR (jsonb_typeof(p_input->'expectedVersion') = 'number' AND (p_input->>'expectedVersion') ~ '^[1-9][0-9]{0,8}$'))
    OR jsonb_typeof(p_input->'periodStart') IS DISTINCT FROM 'string' OR (p_input->>'periodStart') !~ '^[0-9]{4}-[0-9]{2}-01$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  BEGIN v_period := (p_input->>'periodStart')::date;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END;
  IF to_char(v_period, 'YYYY-MM-DD') <> p_input->>'periodStart' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  v_cap := (p_input->>'creditCap')::integer; v_reason := hon.hq_hon_text(p_input, 'reason', 3, 300);
  fp := hon.saas_fingerprint(ARRAY['hq.hon.budget', p_input::text]);
  replay := hon.hq_hon_claim(actor, p_key, 'BUDGET', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_hon_actor(p_subject, true); RETURN replay; END IF;
  v_now := hon.hq_hon_period(clock_timestamp());
  IF v_period < v_now OR v_period > (v_now + interval '12 months')::date THEN
    RAISE EXCEPTION 'HQ_HON_PERIOD_NOT_ALLOWED' USING ERRCODE = '23514';
  END IF;
  PERFORM hon.hq_hon_lock_period(v_period);
  SELECT * INTO b FROM hon.hq_hon_budget_periods WHERE period_start = v_period FOR UPDATE;
  IF b.period_start IS NULL THEN
    IF jsonb_typeof(p_input->'expectedVersion') <> 'null' THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  ELSIF jsonb_typeof(p_input->'expectedVersion') = 'null' OR b.version <> (p_input->>'expectedVersion')::integer THEN
    RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001';
  ELSIF b.credit_cap = v_cap THEN
    RAISE EXCEPTION 'HQ_HON_BUDGET_NO_CHANGE' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(sum(CASE WHEN status IN ('ANSWERED','RESOLVED_CHARGED') THEN charged_credits
      WHEN status IN ('ANSWERING','UNDER_REVIEW') THEN reserved_credits ELSE 0 END), 0) INTO v_committed
    FROM hon.hq_hon_turns WHERE period_start = v_period;
  IF v_cap < v_committed THEN RAISE EXCEPTION 'HQ_HON_CAP_BELOW_USE' USING ERRCODE = '23514'; END IF;
  at := clock_timestamp();
  IF b.period_start IS NULL THEN
    INSERT INTO hon.hq_hon_budget_periods VALUES (v_period, v_cap, 1, actor, at) RETURNING * INTO b;
    INSERT INTO hon.hq_hon_budget_changes VALUES (v_period, 1, v_cap, NULL, v_reason, actor, at);
  ELSE
    at := greatest(at, b.set_at);
    INSERT INTO hon.hq_hon_budget_changes VALUES (v_period, b.version + 1, v_cap, b.credit_cap, v_reason, actor, at);
    UPDATE hon.hq_hon_budget_periods SET credit_cap = v_cap, version = version + 1, set_by = actor, set_at = at
      WHERE period_start = v_period RETURNING * INTO b;
  END IF;
  result := jsonb_build_object('budget', hon.hq_hon_budget_json(v_period));
  INSERT INTO hon.hq_hon_requests VALUES (actor, p_key, 'BUDGET', fp, result, at);
  PERFORM hon.require_hq_hon_actor(p_subject, true);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ASK: {question, replyMode, agentKey} -> {turn, invocation | null, budget, replayed}. The same asker and key return the
-- same turn (never a second reservation or provider call; the invocation is returned only by the call that created it);
-- the same key with another body is refused. The route is the cheapest active, healthy OpenRouter text model whose cost
-- for the mode's budgets fits its cost ceiling, chosen here. Order: key lock, pause gate, then the period lock.
CREATE FUNCTION hon.ask_hq_hon(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; fp text; existing hon.hq_hon_turns%ROWTYPE; created hon.hq_hon_turns%ROWTYPE; b hon.hq_hon_budget_periods%ROWTYPE;
  v_mode text; v_agent text; v_question text; v_perm text; lim jsonb; route record; v_period date; budget jsonb; facts jsonb; at timestamptz;
BEGIN
  actor := hon.require_hq_hon_actor(p_subject, false);
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['agentKey','question','replyMode']
    OR jsonb_typeof(p_input->'replyMode') IS DISTINCT FROM 'string' OR coalesce(p_input->>'replyMode', '') NOT IN ('STANDARD','DETAILED')
    OR jsonb_typeof(p_input->'agentKey') IS DISTINCT FROM 'string' OR hon.hq_hon_agent_permission(p_input->>'agentKey') IS NULL
    OR jsonb_typeof(p_input->'question') IS DISTINCT FROM 'string' OR (p_input->>'question') <> btrim(p_input->>'question')
    OR length(p_input->>'question') NOT BETWEEN 1 AND 2000 OR (p_input->>'question') ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_mode := p_input->>'replyMode'; v_agent := p_input->>'agentKey'; v_question := p_input->>'question';
  v_perm := hon.hq_hon_agent_permission(v_agent); lim := hon.hq_hon_mode_limits(v_mode);
  fp := hon.saas_fingerprint(ARRAY['hq.hon.ask', p_input::text]);
  -- One turn per asker and key at a time; a concurrent duplicate waits, then replays.
  PERFORM pg_advisory_xact_lock(hashtextextended('hq-hon-turn:' || actor::text || ':' || p_key::text, 0));
  SELECT * INTO existing FROM hon.hq_hon_turns WHERE asked_by = actor AND idempotency_key = p_key;
  IF FOUND THEN
    IF existing.request_fingerprint <> fp THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    PERFORM hon.require_hq_hon_actor(p_subject, false);
    RETURN jsonb_build_object('turn', hon.hq_hon_turn_json(existing, actor), 'invocation', NULL,
      'budget', hon.hq_hon_budget_json(existing.period_start), 'replayed', true);
  END IF;
  IF NOT hon.hq_hon_permission_held(actor, v_perm) THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  -- S4 pause gate (0195): a platform pause command holds 'ai.pause:platform:<class>' exclusively while it records the
  -- pause, so taking it shared here waits for that commit and the check below sees it. A school's own pause never applies.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ai.pause:platform:AGENT_INFERENCE', 0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ai.pause:platform:ALL', 0));
  IF EXISTS (SELECT 1 FROM hon.ai_spend_pauses p WHERE p.ended_at IS NULL AND p.organization_id IS NULL AND p.spend_class IN ('AGENT_INFERENCE','ALL')) THEN
    RAISE EXCEPTION 'HQ_HON_PAUSED_BY_HQ' USING ERRCODE = '23514';
  END IF;
  SELECT c.catalog_id, c.provider_id, c.model_id, c.version INTO route
  FROM hon.hq_ai_model_catalog c JOIN hon.hq_ai_provider_connections p ON p.provider_id = c.provider_id
  WHERE c.provider_id = 'OPENROUTER' AND p.state = 'HEALTHY' AND c.active AND c.cost_unit = 'TOKEN'
    AND 'TEXT' = ANY(c.capabilities) AND 'TEXT' = ANY(c.modalities)
    AND c.effective_from <= clock_timestamp() AND (c.effective_until IS NULL OR clock_timestamp() < c.effective_until)
    AND c.unit_cost_micros::numeric * ((lim->>'inputBudget')::integer + (lim->>'outputBudget')::integer) <= (lim->>'maxCostMicrounits')::bigint
  ORDER BY c.unit_cost_micros, c.catalog_id LIMIT 1;
  IF route.catalog_id IS NULL THEN RAISE EXCEPTION 'HQ_HON_NO_ELIGIBLE_ROUTE' USING ERRCODE = '23514'; END IF;
  -- The month is decided after the key lock wait; the period lock serializes the cap check and the insert.
  v_period := hon.hq_hon_period(clock_timestamp());
  PERFORM hon.hq_hon_lock_period(v_period);
  at := clock_timestamp();
  IF hon.hq_hon_period(at) <> v_period THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  SELECT * INTO b FROM hon.hq_hon_budget_periods WHERE period_start = v_period;
  IF b.period_start IS NULL THEN RAISE EXCEPTION 'HQ_HON_BUDGET_NOT_SET' USING ERRCODE = '23514'; END IF;
  budget := hon.hq_hon_budget_json(v_period);
  IF (budget->>'inProgress')::integer >= 3 THEN RAISE EXCEPTION 'HQ_HON_TOO_MANY_IN_PROGRESS' USING ERRCODE = '23514'; END IF;
  IF (lim->>'reservedCredits')::integer > (budget->>'availableCredits')::bigint THEN RAISE EXCEPTION 'HQ_HON_BUDGET_EXHAUSTED' USING ERRCODE = '23514'; END IF;
  -- The facts are read with the asker's own authority (the reader re-checks it) and are never stored.
  facts := hon.hq_hon_agent_facts(p_subject, v_agent);
  INSERT INTO hon.hq_hon_turns (period_start, asked_by, idempotency_key, request_fingerprint, agent_key, reply_mode, question,
    input_budget, output_budget, max_cost_microunits, reserved_credits, provider_id, model_id, catalog_id, catalog_version,
    source_permissions, status, cost_status, version, created_at)
  VALUES (v_period, actor, p_key, fp, v_agent, v_mode, v_question, (lim->>'inputBudget')::integer, (lim->>'outputBudget')::integer,
    (lim->>'maxCostMicrounits')::bigint, (lim->>'reservedCredits')::integer, route.provider_id, route.model_id, route.catalog_id, route.version,
    ARRAY[v_perm], 'ANSWERING', 'PENDING', 1, at)
  RETURNING * INTO created;
  -- Finality: authority is decided again after every write and wait; a grant that ended meanwhile rolls everything back,
  -- so the API never hands an unauthorized question to a provider.
  PERFORM hon.require_hq_hon_actor(p_subject, false);
  IF NOT hon.hq_hon_permission_held(actor, v_perm) THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object('turn', hon.hq_hon_turn_json(created, actor),
    'invocation', jsonb_build_object('turnId', created.id, 'agentKey', created.agent_key, 'providerId', created.provider_id,
      'modelId', created.model_id, 'providerRequestId', created.id, 'replyMode', created.reply_mode, 'question', created.question,
      'facts', facts::text, 'inputBudget', created.input_budget, 'outputBudget', created.output_budget,
      'maxCostMicrounits', created.max_cost_microunits),
    'budget', hon.hq_hon_budget_json(v_period), 'replayed', false);
END $$;

-- RECORD: the provider outcome, exactly once, by the turn's own asker (person check only: no grant, pause or budget
-- check, so an in-flight result is never lost). {outcome, reply, truncated, inputTokens, outputTokens,
-- providerCostMicrounits, failureReason}. An ANSWERED result outside the turn's budgets or cost ceiling is never trusted:
-- it is held UNDER_REVIEW (UNVERIFIED_RESULT). UNKNOWN with reason INTERRUPTED is accepted only after 120 seconds.
CREATE FUNCTION hon.record_hq_hon_result(p_subject text, p_turn uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE t hon.hq_hon_turns%ROWTYPE; outcome text; reason text; actor uuid; at timestamptz; v_in integer; v_out integer; v_cost bigint;
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_turn IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM
      ARRAY['failureReason','inputTokens','outcome','outputTokens','providerCostMicrounits','reply','truncated'] THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  outcome := p->>'outcome'; reason := p->>'failureReason';
  IF NOT coalesce(CASE outcome
      WHEN 'ANSWERED' THEN jsonb_typeof(p->'reply') = 'string' AND (p->>'reply') = btrim(p->>'reply') AND length(p->>'reply') BETWEEN 1 AND 24000
        AND jsonb_typeof(p->'truncated') = 'boolean' AND jsonb_typeof(p->'failureReason') = 'null'
        AND jsonb_typeof(p->'inputTokens') = 'number' AND (p->>'inputTokens') ~ '^[1-9][0-9]{0,6}$'
        AND jsonb_typeof(p->'outputTokens') = 'number' AND (p->>'outputTokens') ~ '^[1-9][0-9]{0,6}$'
        AND jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,10}$'
      WHEN 'FAILED' THEN reason = 'PROVIDER_REJECTED'
        AND (jsonb_typeof(p->'providerCostMicrounits') = 'null' OR (jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,10}$'))
      WHEN 'NOT_SENT' THEN reason IN ('CONFIGURATION_REQUIRED','UNSUPPORTED_PROVIDER','INVALID_REQUEST') AND jsonb_typeof(p->'providerCostMicrounits') = 'null'
      WHEN 'UNKNOWN' THEN reason IN ('PROVIDER_UNKNOWN','UNVERIFIED_RESULT','INTERRUPTED') AND jsonb_typeof(p->'providerCostMicrounits') = 'null'
      ELSE false END, false)
    OR (outcome <> 'ANSWERED' AND (jsonb_typeof(p->'reply') <> 'null' OR jsonb_typeof(p->'truncated') <> 'null'
      OR jsonb_typeof(p->'inputTokens') <> 'null' OR jsonb_typeof(p->'outputTokens') <> 'null')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO t FROM hon.hq_hon_turns WHERE id = p_turn;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  -- The asker in person (active, same subject); a lapsed grant does not lose the result.
  SELECT pr.id INTO actor FROM hon.users u JOIN hon.principals pr ON pr.user_id = u.id
    WHERE u.external_subject = p_subject AND pr.id = t.asked_by AND pr.is_active AND pr.principal_type = 'HUMAN_USER';
  IF actor IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  PERFORM hon.hq_hon_lock_period(t.period_start);
  SELECT * INTO t FROM hon.hq_hon_turns WHERE id = p_turn FOR UPDATE;
  IF t.status <> 'ANSWERING' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp();
  IF reason = 'INTERRUPTED' AND at < t.created_at + interval '120 seconds' THEN
    RAISE EXCEPTION 'HQ_HON_TURN_IN_PROGRESS' USING ERRCODE = '40001';
  END IF;
  IF outcome = 'ANSWERED' THEN
    v_in := (p->>'inputTokens')::integer; v_out := (p->>'outputTokens')::integer; v_cost := (p->>'providerCostMicrounits')::bigint;
    IF v_in > t.input_budget OR v_out > t.output_budget OR v_cost > t.max_cost_microunits THEN
      UPDATE hon.hq_hon_turns SET status = 'UNDER_REVIEW', failure_reason = 'UNVERIFIED_RESULT', version = version + 1,
        completed_at = greatest(at, created_at) WHERE id = t.id RETURNING * INTO t;
    ELSE
      UPDATE hon.hq_hon_turns SET status = 'ANSWERED', reply = p->>'reply', truncated = (p->>'truncated')::boolean, input_tokens = v_in,
        output_tokens = v_out, charged_credits = least(reserved_credits, (v_in + v_out + 999) / 1000), cost_status = 'RECORDED',
        provider_cost_microunits = v_cost, version = version + 1, completed_at = greatest(at, created_at)
      WHERE id = t.id RETURNING * INTO t;
    END IF;
  ELSIF outcome = 'FAILED' THEN
    UPDATE hon.hq_hon_turns SET status = 'FAILED', failure_reason = reason,
      cost_status = CASE WHEN jsonb_typeof(p->'providerCostMicrounits') = 'number' THEN 'RECORDED' ELSE 'UNKNOWN' END,
      provider_cost_microunits = (p->>'providerCostMicrounits')::bigint, version = version + 1, completed_at = greatest(at, created_at)
    WHERE id = t.id RETURNING * INTO t;
  ELSIF outcome = 'NOT_SENT' THEN
    -- The request never left the server, so its provider cost is a known zero (not a guess).
    UPDATE hon.hq_hon_turns SET status = 'FAILED', failure_reason = reason, cost_status = 'RECORDED', provider_cost_microunits = 0,
      version = version + 1, completed_at = greatest(at, created_at)
    WHERE id = t.id RETURNING * INTO t;
  ELSE
    UPDATE hon.hq_hon_turns SET status = 'UNDER_REVIEW', failure_reason = reason, version = version + 1, completed_at = greatest(at, created_at)
    WHERE id = t.id RETURNING * INTO t;
  END IF;
  RETURN jsonb_build_object('turn', hon.hq_hon_turn_json(t, actor), 'budget', hon.hq_hon_budget_json(t.period_start));
END $$;

-- RESOLVE (HQ owner only): {expectedVersion, resolution CHARGED | NOT_CHARGED, chargedCredits (CHARGED only, at most the
-- reservation), providerCostMicrounits (number or null = unknown), evidenceReference}. For a turn UNDER_REVIEW, or
-- ANSWERING for more than 120 seconds. No reply is ever shown for a resolved turn.
CREATE FUNCTION hon.resolve_hq_hon_turn(p_subject text, p_turn uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; fp text; t hon.hq_hon_turns%ROWTYPE; v_credits integer; v_ref text; v_cost bigint; at timestamptz; result jsonb;
BEGIN
  actor := hon.require_hq_hon_actor(p_subject, true);
  IF p_turn IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['chargedCredits','evidenceReference','expectedVersion','providerCostMicrounits','resolution']
    OR coalesce(p_input->>'resolution', '') NOT IN ('CHARGED','NOT_CHARGED') OR jsonb_typeof(p_input->'resolution') IS DISTINCT FROM 'string'
    OR NOT (jsonb_typeof(p_input->'providerCostMicrounits') = 'null'
      OR (jsonb_typeof(p_input->'providerCostMicrounits') = 'number' AND (p_input->>'providerCostMicrounits') ~ '^[0-9]{1,10}$'))
    OR NOT (CASE p_input->>'resolution' WHEN 'CHARGED' THEN jsonb_typeof(p_input->'chargedCredits') = 'number' AND (p_input->>'chargedCredits') ~ '^[0-9]{1,4}$'
      ELSE jsonb_typeof(p_input->'chargedCredits') = 'null' END) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  PERFORM hon.hq_hon_expected(p_input);
  v_ref := hon.hq_hon_text(p_input, 'evidenceReference', 1, 200);
  v_cost := (p_input->>'providerCostMicrounits')::bigint;
  IF v_cost > 1000000000 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  fp := hon.saas_fingerprint(ARRAY['hq.hon.resolve', p_turn::text, p_input::text]);
  replay := hon.hq_hon_claim(actor, p_key, 'RESOLVE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_hon_actor(p_subject, true); RETURN replay; END IF;
  SELECT * INTO t FROM hon.hq_hon_turns WHERE id = p_turn;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.hq_hon_lock_period(t.period_start);
  SELECT * INTO t FROM hon.hq_hon_turns WHERE id = p_turn FOR UPDATE;
  IF t.version <> (p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF t.status NOT IN ('ANSWERING','UNDER_REVIEW') THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  -- A turn still ANSWERING is resolvable only once it is clearly interrupted (120 s), so a late provider result is never
  -- overtaken by a resolution.
  IF t.status = 'ANSWERING' AND t.created_at > clock_timestamp() - interval '120 seconds' THEN
    RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001';
  END IF;
  at := greatest(clock_timestamp(), t.created_at);
  IF p_input->>'resolution' = 'CHARGED' THEN
    v_credits := (p_input->>'chargedCredits')::integer;
    IF v_credits > t.reserved_credits THEN RAISE EXCEPTION 'HQ_HON_CHARGE_EXCEEDS_RESERVATION' USING ERRCODE = '23514'; END IF;
    UPDATE hon.hq_hon_turns SET status = 'RESOLVED_CHARGED', charged_credits = v_credits,
      cost_status = CASE WHEN v_cost IS NULL THEN 'UNKNOWN' ELSE 'RECORDED' END, provider_cost_microunits = v_cost, resolution_reference = v_ref,
      resolved_by = actor, version = version + 1, completed_at = coalesce(completed_at, at)
    WHERE id = t.id RETURNING * INTO t;
  ELSE
    UPDATE hon.hq_hon_turns SET status = 'RESOLVED_NOT_CHARGED', cost_status = CASE WHEN v_cost IS NULL THEN 'UNKNOWN' ELSE 'RECORDED' END,
      provider_cost_microunits = v_cost, resolution_reference = v_ref, resolved_by = actor, version = version + 1, completed_at = coalesce(completed_at, at)
    WHERE id = t.id RETURNING * INTO t;
  END IF;
  result := jsonb_build_object('turn', hon.hq_hon_turn_json(t, actor), 'budget', hon.hq_hon_budget_json(t.period_start));
  INSERT INTO hon.hq_hon_requests VALUES (actor, p_key, 'RESOLVE', fp, result, clock_timestamp());
  PERFORM hon.require_hq_hon_actor(p_subject, true);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ---------- reads ----------
-- The conversation: this UTC month's budget, the reader's own newest 50 turns, and for the HQ owner the newest 12 cap
-- changes and every turn held for review (newest 50). Provider identity, model and provider cost are never shown.
CREATE FUNCTION hon.read_hq_hon_conversation(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; owner boolean; result jsonb;
BEGIN
  actor := hon.require_hq_hon_actor(p_subject, false);
  owner := hon.hq_hon_owner_eligible(actor);
  result := jsonb_build_object('budget', hon.hq_hon_budget_json(hon.hq_hon_period(clock_timestamp())),
    'turns', (SELECT coalesce(jsonb_agg(hon.hq_hon_turn_json(t, actor) ORDER BY t.created_at DESC, t.id DESC), '[]'::jsonb)
      FROM (SELECT * FROM hon.hq_hon_turns WHERE asked_by = actor ORDER BY created_at DESC, id DESC LIMIT 50) t),
    'budgetHistory', CASE WHEN owner THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('periodStart', to_char(h.period_start, 'YYYY-MM-DD'),
        'version', h.version, 'creditCap', h.credit_cap, 'previousCap', h.previous_cap, 'reason', h.reason,
        'actor', hon.hq_marketing_person_json(h.actor_principal_id), 'recordedAt', hon.saas_ts(h.recorded_at))
        ORDER BY h.recorded_at DESC, h.period_start DESC, h.version DESC), '[]'::jsonb)
      FROM (SELECT * FROM hon.hq_hon_budget_changes ORDER BY recorded_at DESC, period_start DESC, version DESC LIMIT 12) h) ELSE '[]'::jsonb END,
    'underReview', CASE WHEN owner THEN (SELECT coalesce(jsonb_agg(hon.hq_hon_turn_json(t, actor) ORDER BY t.created_at DESC, t.id DESC), '[]'::jsonb)
      FROM (SELECT * FROM hon.hq_hon_turns WHERE status = 'UNDER_REVIEW'
        OR (status = 'ANSWERING' AND created_at <= clock_timestamp() - interval '120 seconds') ORDER BY created_at DESC, id DESC LIMIT 50) t) ELSE '[]'::jsonb END,
    'limit', 50, 'viewer', hon.hq_marketing_person_json(actor) || jsonb_build_object('isOwner', owner),
    'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_hon_actor(p_subject, false);
  RETURN result;
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['guard_hq_hon_record()','guard_hq_hon_evidence()','hq_hon_permission_held(uuid,text)','hq_hon_owner_eligible(uuid)',
    'require_hq_hon_actor(text,boolean)','hq_hon_agent_permission(text)','hq_hon_agent_facts(text,text)','hq_hon_period(timestamptz)',
    'hq_hon_lock_period(date)','hq_hon_mode_limits(text)','hq_hon_budget_json(date)','hq_hon_turn_json(hon.hq_hon_turns,uuid)',
    'hq_hon_claim(uuid,uuid,text,text)','hq_hon_text(jsonb,text,integer,integer)','hq_hon_expected(jsonb)',
    'set_hq_hon_budget(text,jsonb,uuid)','ask_hq_hon(text,jsonb,uuid)','record_hq_hon_result(text,uuid,jsonb)',
    'resolve_hq_hon_turn(text,uuid,jsonb,uuid)','read_hq_hon_conversation(text)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.set_hq_hon_budget(text,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.ask_hq_hon(text,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.record_hq_hon_result(text,uuid,jsonb) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.resolve_hq_hon_turn(text,uuid,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_hq_hon_conversation(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
