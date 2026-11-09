BEGIN;

-- C3a part 1: HON may suggest specialists for an answer. Suggest, don't act.
-- A suggestion is a closed list of delegate keys (marcus, kai, chad; at most three, no repeats) stored with the
-- reply. It runs nothing: the human confirms a suggestion by sending an ordinary C1 delegation turn, which takes
-- its own planning, capability, budget and approval path. Model output is data only.
-- Stored: only agents the requester holds the agent's capability permission for at record time (0212 mapping), and
-- nothing for a cut-off answer or one recorded over budget. Shown: only for a COMPLETED, visible answer, and only
-- agents the requester still holds the capability for now; a concealed or held answer shows none.

ALTER TABLE hon.hon_reply_invocations ADD COLUMN suggested_agents text[] NOT NULL DEFAULT '{}'
  CHECK (suggested_agents <@ ARRAY['marcus', 'kai', 'chad']::text[] AND cardinality(suggested_agents) <= 3
    AND array_position(suggested_agents, NULL) IS NULL);
ALTER TABLE hon.hon_reply_invocations ADD CONSTRAINT hon_reply_invocations_suggestions_whole
  CHECK (cardinality(suggested_agents) = 0 OR (NOT truncated AND status IN ('RESULT_HELD', 'COMPLETED')));

-- The given agents (in order) that this principal may use at this exact school now.
CREATE FUNCTION hon.hon_reply_allowed_suggestions(p_principal uuid, p_org uuid, p_school uuid, p_agents text[]) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(array_agg(a.agent ORDER BY a.ord), '{}'::text[])
  FROM unnest(coalesce(p_agents, '{}'::text[])) WITH ORDINALITY a(agent, ord)
  WHERE a.agent IN ('marcus', 'kai', 'chad')
    AND hon.principal_has_school_permission(p_principal, p_org, p_school, hon.ai_agent_capability_permission(a.agent));
$$;

CREATE OR REPLACE FUNCTION hon.hon_reply_detail(p_turn uuid, p_visible boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('mode', r.reply_mode, 'step', r.step, 'maxSteps', hon.hon_reply_max_steps(),
    'truncated', r.status = 'COMPLETED' AND r.truncated,
    'canContinue', r.status = 'COMPLETED' AND coalesce(p_visible, false) AND r.truncated AND r.step < hon.hon_reply_max_steps()
      AND NOT EXISTS (SELECT 1 FROM hon.hon_reply_invocations n WHERE n.continues_turn_id = r.turn_id),
    'continuesTurnId', r.continues_turn_id,
    'suggestions', to_jsonb(CASE WHEN r.status = 'COMPLETED' AND coalesce(p_visible, false) AND NOT r.truncated
      THEN hon.hon_reply_allowed_suggestions(r.requested_by, r.organization_id, r.school_id, r.suggested_agents) ELSE '{}'::text[] END))
  FROM hon.hon_reply_invocations r WHERE r.turn_id = p_turn;
$$;

-- 0210 body, plus the optional 'suggestions' key (an array of distinct delegate keys, at most three). Unknown keys,
-- repeats or anything else are refused as before; the evidence row is unchanged.
CREATE OR REPLACE FUNCTION hon.record_hon_reply_result(p_subject text, p_turn uuid, p_result jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); i hon.hon_reply_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE;
  uid uuid; credits integer; over boolean; reply text; outcome text; cut boolean; asked text[] := '{}';
BEGIN
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND OR i.status <> 'SENDING' OR i.usage_id IS NOT NULL THEN RAISE EXCEPTION 'HON_REPLY_OUTCOME_REPLAY' USING ERRCODE = '40001'; END IF;
  SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id = i.plan_id;
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' OR NOT p_result ?& ARRAY['reply', 'inputTokens', 'outputTokens', 'providerCostMicrounits']
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('reply', 'inputTokens', 'outputTokens', 'providerCostMicrounits', 'truncated', 'suggestions'))
     OR (p_result ? 'truncated' AND jsonb_typeof(p_result->'truncated') <> 'boolean')
     OR (p_result ? 'suggestions' AND (jsonb_typeof(p_result->'suggestions') <> 'array' OR jsonb_array_length(p_result->'suggestions') > 3
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_result->'suggestions') e WHERE jsonb_typeof(e) <> 'string' OR e #>> '{}' NOT IN ('marcus', 'kai', 'chad'))
       OR (SELECT count(DISTINCT e #>> '{}') FROM jsonb_array_elements(p_result->'suggestions') e) <> jsonb_array_length(p_result->'suggestions')))
     OR jsonb_typeof(p_result->'reply') <> 'string' OR length(btrim(p_result->>'reply')) NOT BETWEEN 1 AND 24000
     OR jsonb_typeof(p_result->'inputTokens') <> 'number' OR (p_result->>'inputTokens') !~ '^[1-9][0-9]{0,6}$'
     OR jsonb_typeof(p_result->'outputTokens') <> 'number' OR (p_result->>'outputTokens') !~ '^[1-9][0-9]{0,6}$'
     OR jsonb_typeof(p_result->'providerCostMicrounits') <> 'number' OR (p_result->>'providerCostMicrounits') !~ '^(0|[1-9][0-9]{0,9})$' THEN
    RAISE EXCEPTION 'INVALID_HON_REPLY_RESULT' USING ERRCODE = '22023';
  END IF;
  reply := btrim(p_result->>'reply');
  cut := coalesce((p_result->>'truncated')::boolean, false);
  IF p_result ? 'suggestions' THEN
    SELECT coalesce(array_agg(e ORDER BY n), '{}') INTO asked FROM jsonb_array_elements_text(p_result->'suggestions') WITH ORDINALITY x(e, n);
  END IF;
  credits := ((p_result->>'inputTokens')::integer + (p_result->>'outputTokens')::integer + 999) / 1000;
  over := (p_result->>'inputTokens')::integer > p.input_budget OR (p_result->>'outputTokens')::integer > p.output_budget
    OR (p_result->>'providerCostMicrounits')::bigint > p.max_provider_cost_microunits OR credits > i.reserved_credits;
  INSERT INTO hon.ai_usage_ledger(organization_id, school_id, initiator_principal_id, work_item_id, provider_code, model_code, modality,
      input_units, output_units, provider_cost_microunits, customer_credits, correlation_id, source_invocation_id, spend_class)
    VALUES (i.organization_id, i.school_id, actor, i.work_item_id, p.provider_id, p.model_id, 'TEXT',
      (p_result->>'inputTokens')::bigint, (p_result->>'outputTokens')::bigint, (p_result->>'providerCostMicrounits')::bigint, credits,
      nullif(current_setting('app.hon_request_id', true), '')::uuid, i.id, 'AGENT_INFERENCE')
    RETURNING id INTO uid;
  outcome := CASE WHEN over THEN 'FAILED' WHEN NOT hon.hon_reply_access(p_subject) OR NOT hon.hon_reply_source_allowed(i) THEN 'RESULT_HELD' ELSE 'COMPLETED' END;
  UPDATE hon.hon_reply_invocations SET usage_id = uid, reserved_credits = 0, status = outcome,
    reason = CASE WHEN outcome = 'FAILED' THEN 'RESULT_BUDGET_EXCEEDED' WHEN outcome = 'RESULT_HELD' AND NOT hon.hon_reply_source_allowed(i) THEN 'SOURCE_ACCESS_LAPSED'
                  WHEN outcome = 'RESULT_HELD' THEN 'ACCESS_LAPSED' END,
    reply_text = CASE WHEN outcome = 'FAILED' THEN NULL ELSE reply END,
    truncated = outcome <> 'FAILED' AND cut,
    -- Only a whole, recorded answer keeps suggestions, and only for agents this requester may use now.
    suggested_agents = CASE WHEN outcome = 'FAILED' OR cut THEN '{}'::text[]
      ELSE hon.hon_reply_allowed_suggestions(i.requested_by, i.organization_id, i.school_id, asked) END,
    updated_at = clock_timestamp()
  WHERE id = i.id;
  UPDATE hon.work_items SET status = CASE outcome WHEN 'COMPLETED' THEN 'COMPLETED' ELSE 'NEEDS_ATTENTION' END, version = version + 1, updated_at = clock_timestamp()
  WHERE id = i.work_item_id;
  RETURN outcome;
END $$;

DO $$
DECLARE v_role text;
BEGIN
  REVOKE ALL ON FUNCTION hon.hon_reply_allowed_suggestions(uuid, uuid, uuid, text[]) FROM PUBLIC;
  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.hon_reply_allowed_suggestions(uuid, uuid, uuid, text[]) FROM %I', v_role);
  END LOOP;
END $$;

COMMIT;
