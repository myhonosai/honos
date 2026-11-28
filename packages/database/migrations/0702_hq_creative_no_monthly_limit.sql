BEGIN;

-- 0702 HQ Creative Studio: no monthly limit by default (coordinator-allocated 2026-11-28). Owner decisions: David
-- 2026-11-24 "no monthly AI cap on HQ" (per-request limits stay), and 2026-11-28 01:13Z on the HQ Creative Studio box
-- "No HQ budget is set for this month. Requests are refused until the HQ owner sets one." / "Set this month's cap":
-- "I don't want this".
--   NL1  hon.create_hq_creative_generation no longer refuses HQ_CREATIVE_BUDGET_NOT_SET. A UTC month with no budget row
--        is recorded by its first request at 10,000,000 credits (0253's top cap, read by the web as "no monthly limit"),
--        with budget change version 1 "No monthly limit (HQ default)" attributed to the requester, under the period lock.
--   NL2  Unchanged: per-request units and published rates, at most 3 in progress, the platform creative pause, the
--        provider check, idempotent replay, authority before and after every write, outcomes and resolution. A month the
--        HQ owner set explicitly (set_hq_creative_budget, 0253) keeps that cap; a cap of 0 still stops HQ creative.
--   NL3  The read (hq_creative_budget_json) is unchanged: a month with no row still reads creditCap null.
-- No data change, no new grant, no provider call, no school row touched.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.create_hq_creative_generation(text,jsonb,jsonb,uuid)') IS NULL
    OR to_regclass('hon.hq_creative_budget_periods') IS NULL OR to_regclass('hon.hq_creative_budget_changes') IS NULL THEN
    RAISE EXCEPTION '0702 requires 0253'; END IF;
END $$;

-- CREATE (manage): as 0253, except NL1. The same requester and key return the same generation (never a second reservation
-- or provider call); the same key with another body is refused. Reserves against this UTC month's HQ cap.
CREATE OR REPLACE FUNCTION hon.create_hq_creative_generation(p_subject text, p_input jsonb, p_provider jsonb, p_key uuid) RETURNS jsonb
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
  -- S4 pause gate (0195): a platform pause command holds 'ai.pause:platform:<class>' exclusively while it records the
  -- pause, so taking it shared here waits for that commit and the check below sees it. (saas_creative_pause_gate(NULL)
  -- cannot be reused: its school scope would be NULL.) Order: key lock, pause gate, then the period lock.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ai.pause:platform:CREATIVE_MEDIA', 0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ai.pause:platform:ALL', 0));
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
  -- 0702: a month the HQ owner has not set has no monthly limit. The first request of that month records the month at the
  -- top cap (10,000,000 credits, the most 0253 allows) with an immutable budget change, attributed to the requester.
  IF b.period_start IS NULL THEN
    INSERT INTO hon.hq_creative_budget_periods (period_start, credit_cap, version, set_by, set_at) VALUES (v_period, 10000000, 1, actor, at)
      RETURNING * INTO b;
    INSERT INTO hon.hq_creative_budget_changes (period_start, version, credit_cap, previous_cap, reason, actor_principal_id, recorded_at)
    VALUES (v_period, 1, 10000000, NULL, 'No monthly limit (HQ default)', actor, at);
  END IF;
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

COMMIT;
