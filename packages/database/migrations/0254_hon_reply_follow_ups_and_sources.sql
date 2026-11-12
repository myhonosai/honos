BEGIN;

-- 0254 (allocated by the coordinator 2026-11-11): HON and Claire answers may carry "Ask next" follow-up questions and
-- "Based on" sources. Presentation data only (spec: docs/architecture/HON_FOLLOW_UPS_AND_SOURCES.md).
-- 1. Follow-ups: at most three, each 3-150 characters (code points), trimmed, no control characters, markup or links,
--    distinct; invalid or repeated items are dropped at record time, wrong JSON types are refused. Tapping one only
--    fills the composer; it is an ordinary question with its own planning and S4 path.
-- 2. Sources: a closed set (the Command Center metric keys, 'conversation', 'specialistResults'). prepare records which
--    areas the context actually carried (available_sources); a stored citation must be one of them, at most five.
-- 3. Both are kept only for a whole, recorded answer (never FAILED or cut off) and shown only on a visible COMPLETED
--    answer; a concealed or held answer shows none. No new cost, usage, provider call or spend path.

CREATE FUNCTION hon.hon_reply_source_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY['newLeads24h', 'upcomingTrials24h', 'upcomingTestingEvents30d', 'pendingActionApprovals', 'outstandingWorkItems',
    'membershipTermsEnding30d', 'paidInvoicesCreated30d', 'unansweredInquiries', 'attendanceDecline', 'trialConversion', 'revenue',
    'conversation', 'specialistResults']::text[];
$$;

-- One follow-up: no leading or trailing spaces (the API trims all whitespace, so it is stricter), 3-150 characters (code
-- points), no control characters (C0 or C1), markup or links.
CREATE FUNCTION hon.hon_reply_follow_up_ok(q text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT q IS NOT NULL AND q = btrim(q) AND length(q) BETWEEN 3 AND 150 AND q !~ '[[:cntrl:]<>]' AND q !~* '(https?|www\.|://)';
$$;

-- The stored list: at most three valid items, exactly distinct. (Case-insensitive de-duplication is done by the API, which
-- is stricter; the database never depends on two lower-casing rules agreeing.)
CREATE FUNCTION hon.hon_reply_follow_ups_ok(p text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT p IS NOT NULL AND cardinality(p) <= 3 AND array_position(p, NULL) IS NULL
    AND NOT EXISTS (SELECT 1 FROM unnest(p) q WHERE NOT hon.hon_reply_follow_up_ok(q))
    AND (SELECT count(DISTINCT q) FROM unnest(p) q) = cardinality(p);
$$;

CREATE FUNCTION hon.hon_reply_sources_distinct(p text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT p IS NOT NULL AND array_position(p, NULL) IS NULL AND (SELECT count(DISTINCT x) FROM unnest(p) x) = cardinality(p);
$$;

ALTER TABLE hon.hon_reply_invocations
  ADD COLUMN follow_up_questions text[] NOT NULL DEFAULT '{}' CHECK (hon.hon_reply_follow_ups_ok(follow_up_questions)),
  ADD COLUMN available_sources text[] NOT NULL DEFAULT '{}' CHECK (available_sources <@ hon.hon_reply_source_keys() AND array_position(available_sources, NULL) IS NULL),
  ADD COLUMN cited_sources text[] NOT NULL DEFAULT '{}' CHECK (cited_sources <@ available_sources AND cardinality(cited_sources) <= 5
    AND hon.hon_reply_sources_distinct(cited_sources)),
  ADD CONSTRAINT hon_reply_invocations_follow_ups_whole
    CHECK ((cardinality(follow_up_questions) = 0 AND cardinality(cited_sources) = 0) OR (NOT truncated AND status IN ('RESULT_HELD', 'COMPLETED')));

-- 0229 body, plus available_sources recorded with the context.
CREATE OR REPLACE FUNCTION hon.prepare_hon_reply(p_subject text, p_turn uuid, p_plan uuid, p_ready boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id());
  actor uuid := hon.hon_conversation_actor(p_subject); lim jsonb;
  i hon.hon_reply_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE; t hon.hon_conversation_turns%ROWTYPE;
  why text; school_facts jsonb; history jsonb; facts jsonb; continuation jsonb; has_reporting boolean; derived boolean := false;
  prior hon.hon_reply_invocations%ROWTYPE; grp jsonb;
BEGIN
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF i.status <> 'PENDING' THEN RETURN NULL; END IF;
  lim := hon.hon_reply_limits(i.reply_mode);
  -- Every row this prepare writes is locked before any decision (work item first, as the planner does), so no wait can
  -- fall between the authority checks below and the provider input leaving this function.
  PERFORM 1 FROM hon.work_items WHERE id = i.work_item_id FOR UPDATE;
  -- The row locks can wait behind a concurrent resend: conversation authority is held and checked again first.
  PERFORM hon.hon_conversation_hold_actor(p_subject, actor);
  -- After every wait above: the live-clock access gate (Complete at clock_timestamp(), not the transaction start).
  IF NOT hon.hon_reply_access(p_subject) THEN why := 'AI_ACCESS_REFUSED'; END IF;
  has_reporting := hon.principal_has_school_permission(actor, i.organization_id, i.school_id, 'reporting.view');
  -- A continuation of a reporting-derived answer needs that source authority now; otherwise nothing is reserved.
  IF why IS NULL AND i.continues_turn_id IS NOT NULL THEN
    SELECT * INTO prior FROM hon.hon_reply_invocations WHERE turn_id = i.continues_turn_id AND status = 'COMPLETED';
    IF NOT FOUND OR (prior.used_reporting AND NOT has_reporting) THEN why := 'SOURCE_ACCESS_REFUSED'; END IF;
  END IF;
  -- K2: Claire analyses reporting facts only; without reporting.view now nothing is reserved or sent.
  IF why IS NULL AND i.specialist = 'claire' AND NOT has_reporting THEN why := 'SOURCE_ACCESS_REFUSED'; END IF;
  -- C3b: a group summary needs its group still summarizable for this human now; otherwise nothing is reserved.
  IF why IS NULL AND i.summarizes_turn_id IS NOT NULL
     AND hon.hon_orchestration_summary_facts(p_subject, i.conversation_id, actor, i.summarizes_turn_id) IS NULL THEN
    why := 'GROUP_NOT_SUMMARIZABLE';
  END IF;
  IF why IS NULL THEN why := hon.ai_spend_allowed(i.organization_id, clock_timestamp(), 'AGENT_INFERENCE'); END IF;
  IF why IS NULL THEN
    IF p_plan IS NULL THEN why := 'NO_ELIGIBLE_ROUTE';
    ELSE
      SELECT * INTO p FROM hon.ai_invocation_plans WHERE id = p_plan AND organization_id = i.organization_id AND school_id = i.school_id
        AND work_item_id = i.work_item_id AND agent_key = i.specialist AND task_class = lim->>'taskClass' AND input_budget = (lim->>'inputBudget')::integer
        AND output_budget = (lim->>'outputBudget')::integer AND max_provider_cost_microunits = (lim->>'maxProviderCostMicrounits')::bigint;
      IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_PLAN_SWAP' USING ERRCODE = '42501'; END IF;
      IF p.provider_id <> 'OPENROUTER' THEN why := 'UNSUPPORTED_PROVIDER'; ELSIF NOT p_ready THEN why := 'CONFIGURATION_REQUIRED'; END IF;
    END IF;
  END IF;
  -- ai.budget:<org> is already held (first declaration above).
  IF why IS NULL AND hon.ai_org_committed_credits(i.organization_id, clock_timestamp()) + p.customer_credit_estimate
                     > hon.ai_org_ceiling(i.organization_id, clock_timestamp()) THEN
    why := 'CUSTOMER_BUDGET_EXCEEDED';
  END IF;
  UPDATE hon.hon_reply_invocations SET plan_id = p.id,
    status = CASE WHEN why IS NULL THEN 'SENDING' WHEN why = 'CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED' ELSE 'BLOCKED' END,
    reason = why, reserved_credits = CASE WHEN why IS NULL THEN p.customer_credit_estimate ELSE 0 END, updated_at = clock_timestamp()
  WHERE id = i.id;
  UPDATE hon.work_items SET status = CASE WHEN why IS NULL THEN 'WORKING' ELSE 'NEEDS_ATTENTION' END, version = version + 1, updated_at = clock_timestamp()
  WHERE id = i.work_item_id;
  IF why IS NOT NULL THEN RETURN NULL; END IF;
  -- Authorized school context only (see header). The Command Center projection re-checks reporting.view itself.
  IF has_reporting THEN
    BEGIN
      school_facts := hon.read_school_command_center(p_subject, i.organization_id, i.school_id)->'metrics';
    -- A refused fresh read means no reporting authority for this whole context: no protected history either.
    EXCEPTION WHEN insufficient_privilege THEN school_facts := NULL; has_reporting := false;
    END;
  END IF;
  SELECT * INTO STRICT t FROM hon.hon_conversation_turns WHERE id = i.turn_id;
  -- K2: Claire gets the metrics and the question only (no conversation history).
  IF i.specialist = 'hon' THEN
  SELECT coalesce(jsonb_agg(z.h ORDER BY z.seq), '[]'::jsonb) INTO history FROM (
    SELECT x.seq, jsonb_strip_nulls(jsonb_build_object('question', left(x.text, 400),
        -- A reporting-derived earlier answer is reused only while this human still holds reporting.view.
        'answer', CASE WHEN x.agent_key = 'hon' AND (NOT r.used_reporting OR has_reporting) THEN left(r.reply_text, 600) END,
      -- Owner blueprint: a legacy 'claire' teaching delegate (no reply row) is Kai; a K2 Claire analysis is Claire's.
        'delegatedTo', CASE WHEN x.agent_key = 'claire' AND NOT EXISTS (SELECT 1 FROM hon.hon_reply_invocations c WHERE c.turn_id = x.id) THEN 'kai'
                            WHEN x.agent_key <> 'hon' THEN x.agent_key END)) h
    FROM hon.hon_conversation_turns x
    LEFT JOIN hon.hon_reply_invocations r ON r.turn_id = x.id AND r.status = 'COMPLETED'
    WHERE x.conversation_id = t.conversation_id AND x.seq < t.seq
    ORDER BY x.seq DESC LIMIT 3) z;
  SELECT coalesce(bool_or(r.used_reporting AND has_reporting), false) INTO derived FROM (
    SELECT x.id FROM hon.hon_conversation_turns x WHERE x.conversation_id = t.conversation_id AND x.seq < t.seq ORDER BY x.seq DESC LIMIT 3) z
    JOIN hon.hon_reply_invocations r ON r.turn_id = z.id AND r.status = 'COMPLETED';
  END IF;
  -- A continuation also gets the answer's original question and the end of the part already given (data only).
  IF i.continues_turn_id IS NOT NULL THEN
    WITH RECURSIVE chain AS (
      SELECT r.turn_id, r.continues_turn_id FROM hon.hon_reply_invocations r WHERE r.turn_id = i.continues_turn_id
      UNION ALL
      SELECT r.turn_id, r.continues_turn_id FROM hon.hon_reply_invocations r JOIN chain c ON r.turn_id = c.continues_turn_id)
    SELECT jsonb_build_object('step', i.step, 'maxSteps', hon.hon_reply_max_steps(),
        'originalQuestion', (SELECT left(x.text, 2000) FROM chain c JOIN hon.hon_conversation_turns x ON x.id = c.turn_id WHERE c.continues_turn_id IS NULL),
        'previousAnswerEnd', (SELECT right(r.reply_text, 2500) FROM hon.hon_reply_invocations r WHERE r.turn_id = i.continues_turn_id AND r.status = 'COMPLETED'))
      INTO continuation;
    derived := derived OR prior.used_reporting;
  END IF;
  -- C3b: the group's recorded outcomes, read last (a source answer derived from reporting makes the context derived).
  IF i.summarizes_turn_id IS NOT NULL THEN
    grp := hon.hon_orchestration_summary_facts(p_subject, i.conversation_id, actor, i.summarizes_turn_id);
    derived := derived OR coalesce((SELECT r.used_reporting FROM hon.hon_reply_invocations r WHERE r.turn_id = i.summarizes_turn_id), false);
  END IF;
  -- Final live-clock revalidation before any context leaves prepare: access (Complete at clock_timestamp()) and, when the
  -- context carries reporting-derived material, reporting.view. A lapse here releases the reservation and sends nothing.
  why := CASE WHEN NOT hon.hon_reply_access(p_subject) THEN 'AI_ACCESS_REFUSED'
    WHEN i.summarizes_turn_id IS NOT NULL AND grp IS NULL THEN 'GROUP_NOT_SUMMARIZABLE'
    WHEN i.specialist = 'claire' AND school_facts IS NULL THEN 'SOURCE_ACCESS_REFUSED'
    WHEN (school_facts IS NOT NULL OR derived) AND NOT hon.principal_has_school_permission(actor, i.organization_id, i.school_id, 'reporting.view') THEN 'SOURCE_ACCESS_REFUSED' END;
  IF why IS NOT NULL THEN
    UPDATE hon.hon_reply_invocations SET status = 'BLOCKED', reason = why, reserved_credits = 0, updated_at = clock_timestamp() WHERE id = i.id;
    UPDATE hon.work_items SET status = 'NEEDS_ATTENTION', version = version + 1, updated_at = clock_timestamp() WHERE id = i.work_item_id;
    RETURN NULL;
  END IF;
  facts := jsonb_strip_nulls(jsonb_build_object('school', coalesce(school_facts, jsonb_build_object('availability', 'NOT_AUTHORIZED')), 'history', history,
    'continuation', continuation, 'group', grp));
  -- 0254: the closed fact areas this context actually carries, for "Based on": AVAILABLE metrics (in the closed key
  -- order), the earlier conversation (history or a continuation) and recorded specialist results (a group).
  UPDATE hon.hon_reply_invocations SET available_sources = ARRAY(
      SELECT k FROM unnest(hon.hon_reply_source_keys()) WITH ORDINALITY s(k, n)
      WHERE (k NOT IN ('conversation', 'specialistResults') AND school_facts->k->>'availability' = 'AVAILABLE')
         OR (k = 'conversation' AND (jsonb_array_length(coalesce(history, '[]'::jsonb)) > 0 OR continuation IS NOT NULL))
         OR (k = 'specialistResults' AND grp IS NOT NULL)
      ORDER BY n)
  WHERE id = i.id;
  UPDATE hon.hon_reply_invocations SET used_reporting = school_facts IS NOT NULL OR derived, context_digest = encode(sha256(convert_to(jsonb_build_object('question', t.text, 'facts', facts)::text, 'UTF8')), 'hex')
  WHERE id = i.id;
  RETURN jsonb_build_object('providerId', p.provider_id, 'modelId', p.model_id, 'providerRequestId', i.provider_request_id,
    'specialist', i.specialist, 'replyMode', i.reply_mode, 'step', i.step, 'question', t.text, 'facts', facts::text, 'inputBudget', p.input_budget, 'outputBudget', p.output_budget,
    'maxCostMicrounits', p.max_provider_cost_microunits);
END $$;

-- 0214 body, plus optional 'followUps' and 'sources' (strictly validated; kept like suggestions).
CREATE OR REPLACE FUNCTION hon.record_hon_reply_result(p_subject text, p_turn uuid, p_result jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); i hon.hon_reply_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE;
  uid uuid; credits integer; over boolean; reply text; outcome text; cut boolean; asked text[] := '{}'; follow text[] := '{}'; cited text[] := '{}';
BEGIN
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND OR i.status <> 'SENDING' OR i.usage_id IS NOT NULL THEN RAISE EXCEPTION 'HON_REPLY_OUTCOME_REPLAY' USING ERRCODE = '40001'; END IF;
  SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id = i.plan_id;
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' OR NOT p_result ?& ARRAY['reply', 'inputTokens', 'outputTokens', 'providerCostMicrounits']
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('reply', 'inputTokens', 'outputTokens', 'providerCostMicrounits', 'truncated', 'suggestions', 'followUps', 'sources'))
     OR (p_result ? 'truncated' AND jsonb_typeof(p_result->'truncated') <> 'boolean')
     OR (p_result ? 'suggestions' AND (jsonb_typeof(p_result->'suggestions') <> 'array' OR jsonb_array_length(p_result->'suggestions') > 3
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_result->'suggestions') e WHERE jsonb_typeof(e) <> 'string' OR e #>> '{}' NOT IN ('marcus', 'kai', 'chad'))
       OR (SELECT count(DISTINCT e #>> '{}') FROM jsonb_array_elements(p_result->'suggestions') e) <> jsonb_array_length(p_result->'suggestions')))
     -- 0254: follow-ups (at most three bounded plain questions, unique ignoring case) and sources (closed set, unique, at most five).
     OR (p_result ? 'followUps' AND (jsonb_typeof(p_result->'followUps') <> 'array'
       OR jsonb_array_length(p_result->'followUps') > 3
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_result->'followUps') e WHERE jsonb_typeof(e) <> 'string')))
     OR (p_result ? 'sources' AND (jsonb_typeof(p_result->'sources') <> 'array' OR jsonb_array_length(p_result->'sources') > 5
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_result->'sources') e WHERE jsonb_typeof(e) <> 'string' OR NOT (e #>> '{}') = ANY (hon.hon_reply_source_keys()))
       OR (SELECT count(DISTINCT e #>> '{}') FROM jsonb_array_elements(p_result->'sources') e) <> jsonb_array_length(p_result->'sources')))
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
  -- Follow-ups are presentation hints: an item that fails the text rule, or repeats an earlier one, is dropped (never
  -- raised), so a rule difference between the API and the database can only drop a hint, never lose the answer.
  IF p_result ? 'followUps' THEN
    SELECT coalesce(array_agg(q ORDER BY n), '{}') INTO follow FROM (
      SELECT DISTINCT ON (q) q, n FROM jsonb_array_elements_text(p_result->'followUps') WITH ORDINALITY x(q, n)
      WHERE hon.hon_reply_follow_up_ok(q) ORDER BY q, n) d;
  END IF;
  -- Only areas this answer's context carried (recorded by prepare), in the order given.
  IF p_result ? 'sources' THEN
    SELECT coalesce(array_agg(e ORDER BY n), '{}') INTO cited FROM jsonb_array_elements_text(p_result->'sources') WITH ORDINALITY x(e, n)
    WHERE e = ANY (i.available_sources);
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
    -- 0254: the same rule for follow-ups and cited sources: only on a whole, recorded answer.
    follow_up_questions = CASE WHEN outcome = 'FAILED' OR cut THEN '{}'::text[] ELSE follow END,
    cited_sources = CASE WHEN outcome = 'FAILED' OR cut THEN '{}'::text[] ELSE cited END,
    updated_at = clock_timestamp()
  WHERE id = i.id;
  UPDATE hon.work_items SET status = CASE outcome WHEN 'COMPLETED' THEN 'COMPLETED' ELSE 'NEEDS_ATTENTION' END, version = version + 1, updated_at = clock_timestamp()
  WHERE id = i.work_item_id;
  RETURN outcome;
END $$;

-- 0229 body, plus 'followUps' and 'sources'.
CREATE OR REPLACE FUNCTION hon.hon_reply_detail(p_turn uuid, p_visible boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('mode', r.reply_mode, 'step', r.step, 'maxSteps', hon.hon_reply_max_steps(),
    'truncated', r.status = 'COMPLETED' AND r.truncated,
    'canContinue', r.specialist = 'hon' AND r.status = 'COMPLETED' AND coalesce(p_visible, false) AND r.truncated AND r.step < hon.hon_reply_max_steps()
      AND NOT EXISTS (SELECT 1 FROM hon.hon_reply_invocations n WHERE n.continues_turn_id = r.turn_id),
    'continuesTurnId', r.continues_turn_id,
    'suggestions', to_jsonb(CASE WHEN r.status = 'COMPLETED' AND coalesce(p_visible, false) AND NOT r.truncated
      THEN hon.hon_reply_allowed_suggestions(r.requested_by, r.organization_id, r.school_id, r.suggested_agents) ELSE '{}'::text[] END),
    -- 0254: shown only for a whole, visible COMPLETED answer (as suggestions).
    'followUps', to_jsonb(CASE WHEN r.status = 'COMPLETED' AND coalesce(p_visible, false) AND NOT r.truncated THEN r.follow_up_questions ELSE '{}'::text[] END),
    'sources', to_jsonb(CASE WHEN r.status = 'COMPLETED' AND coalesce(p_visible, false) AND NOT r.truncated THEN r.cited_sources ELSE '{}'::text[] END))
  FROM hon.hon_reply_invocations r WHERE r.turn_id = p_turn;
$$;

DO $$
DECLARE v_role text;
BEGIN
  REVOKE ALL ON FUNCTION hon.hon_reply_source_keys() FROM PUBLIC;
  REVOKE ALL ON FUNCTION hon.hon_reply_follow_ups_ok(text[]) FROM PUBLIC;
  REVOKE ALL ON FUNCTION hon.hon_reply_follow_up_ok(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION hon.hon_reply_sources_distinct(text[]) FROM PUBLIC;
  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.hon_reply_source_keys() FROM %I', v_role);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.hon_reply_follow_ups_ok(text[]) FROM %I', v_role);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.hon_reply_follow_up_ok(text) FROM %I', v_role);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.hon_reply_sources_distinct(text[]) FROM %I', v_role);
  END LOOP;
END $$;

COMMIT;
