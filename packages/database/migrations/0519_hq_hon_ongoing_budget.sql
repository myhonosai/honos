BEGIN;

-- 0519 HQ HON ongoing budget (owner David 2026-11-18: HQ AI is the company's own account, "make on going and pay for
-- what we used"). The HQ AI text budget no longer lapses at each new UTC month: a month the owner has not set takes the
-- latest earlier month's cap. The read shows that carried cap with version null (the month has no row of its own yet);
-- the first question of the month records it as the month's row plus an immutable budget change "Carried over from
-- YYYY-MM", attributed to the owner who set the source month. Setting a month explicitly works as before
-- (expectedVersion null while the month has no row). Unchanged: per-question limits, at most 3 in progress, the
-- platform pause, routing, authority and records (0263/0264). A cap of 0 still stops HQ AI.

-- The latest month at or before p_period that has a recorded budget.
CREATE FUNCTION hon.hq_hon_effective_period(p_period date) RETURNS SETOF hon.hq_hon_budget_periods
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT b.* FROM hon.hq_hon_budget_periods b WHERE b.period_start <= p_period ORDER BY b.period_start DESC LIMIT 1
$$;

-- Caller holds hon.hq_hon_lock_period(p_period). Inserts only; the 0263 guards still refuse any update or delete.
CREATE FUNCTION hon.hq_hon_carry_forward(p_period date) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE src hon.hq_hon_budget_periods%ROWTYPE; at timestamptz := clock_timestamp();
BEGIN
  IF EXISTS (SELECT 1 FROM hon.hq_hon_budget_periods WHERE period_start = p_period) THEN RETURN; END IF;
  SELECT * INTO src FROM hon.hq_hon_budget_periods WHERE period_start < p_period ORDER BY period_start DESC LIMIT 1;
  IF src.period_start IS NULL THEN RETURN; END IF;
  INSERT INTO hon.hq_hon_budget_periods (period_start, credit_cap, version, set_by, set_at) VALUES (p_period, src.credit_cap, 1, src.set_by, at);
  INSERT INTO hon.hq_hon_budget_changes (period_start, version, credit_cap, previous_cap, reason, actor_principal_id, recorded_at)
  VALUES (p_period, 1, src.credit_cap, NULL, 'Carried over from ' || to_char(src.period_start, 'YYYY-MM'), src.set_by, at);
END $$;

-- As 0263, except the cap (and who set it) comes from the effective month; version only when the month has its own row.
CREATE OR REPLACE FUNCTION hon.hq_hon_budget_json(p_period date) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH use AS (SELECT coalesce(sum(charged_credits) FILTER (WHERE status IN ('ANSWERED','RESOLVED_CHARGED')), 0)::bigint used,
      coalesce(sum(reserved_credits) FILTER (WHERE status IN ('ANSWERING','UNDER_REVIEW')), 0)::bigint held,
      count(*) FILTER (WHERE status = 'ANSWERING')::integer busy
    FROM hon.hq_hon_turns WHERE period_start = p_period),
  b AS (SELECT e.credit_cap, CASE WHEN e.period_start = p_period THEN e.version END AS version, e.set_by, e.set_at
    FROM hon.hq_hon_effective_period(p_period) e)
  SELECT jsonb_build_object('periodStart', to_char(p_period, 'YYYY-MM-DD'), 'creditCap', b.credit_cap, 'usedCredits', use.used,
    'heldCredits', use.held, 'availableCredits', CASE WHEN b.credit_cap IS NULL THEN 0 ELSE greatest(b.credit_cap - use.used - use.held, 0) END,
    'inProgress', use.busy, 'version', b.version, 'setBy', CASE WHEN b.set_by IS NULL THEN NULL ELSE hon.hq_marketing_person_json(b.set_by) END,
    'setAt', CASE WHEN b.set_at IS NULL THEN NULL ELSE hon.saas_ts(b.set_at) END)
  FROM use LEFT JOIN b ON true
$$;

-- As 0263, plus the carry-forward under the period lock before the budget check.
CREATE OR REPLACE FUNCTION hon.ask_hq_hon(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
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
  PERFORM hon.hq_hon_carry_forward(v_period);
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

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hq_hon_effective_period(date)','hq_hon_carry_forward(date)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
END $$;

COMMIT;
