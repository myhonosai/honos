BEGIN;

-- K2c (migration 0234, allocated 2026-11-09): HON may suggest Claire, Business Performance.
-- Suggest, don't act. 0214 lets a whole HON answer suggest specialists from a closed set, filtered by the requester's
-- capability; 0215 lets the human confirm one, which sends an ordinary delegation turn grouped under that answer.
-- This adds 'claire' to that closed set:
-- 1. A HON answer may suggest Claire. The suggestion is recorded and shown only while the requester holds reporting.view
--    (0212 binding claire -> reporting.view), through the hon_reply_allowed_suggestions filter.
-- 2. The human confirms Claire with { text, delegation: { agentKey: 'claire' }, fromSuggestionTurnId }. The turn is an
--    ordinary K2 Claire analysis (0229: reporting.view at begin before and after its writes, at prepare early and in the
--    final revalidation; metrics only) and joins the answer's group as a member. The source is checked under the same
--    C3a rules, from a fresh read after every write; a refusal rolls everything back.
-- 3. Group status reads the member through hon_turn_view, so a Claire member is PENDING while her answer runs and
--    COMPLETED or FAILED with it. A C3b summary (0228) sees her agent, status and reason only, never her text.
-- Claire herself still never suggests (0229 hon_reply_invocations_claire_single_analysis), and the source of a
-- confirmation must be HON's own answer. Nothing activates a provider, spends credits or changes billing.

ALTER TABLE hon.hon_reply_invocations DROP CONSTRAINT hon_reply_invocations_suggested_agents_check;
ALTER TABLE hon.hon_reply_invocations ADD CONSTRAINT hon_reply_invocations_suggested_agents_check
  CHECK (suggested_agents <@ ARRAY['marcus', 'kai', 'chad', 'claire']::text[] AND cardinality(suggested_agents) <= 3
    AND array_position(suggested_agents, NULL) IS NULL);

ALTER TABLE hon.hon_orchestration_members DROP CONSTRAINT hon_orchestration_members_agent_key_check;
ALTER TABLE hon.hon_orchestration_members ADD CONSTRAINT hon_orchestration_members_agent_key_check
  CHECK (agent_key IN ('marcus', 'kai', 'chad', 'claire'));

-- 0214 body; 'claire' joins the closed set, filtered by her capability (reporting.view) like every agent.
CREATE OR REPLACE FUNCTION hon.hon_reply_allowed_suggestions(p_principal uuid, p_org uuid, p_school uuid, p_agents text[]) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(array_agg(a.agent ORDER BY a.ord), '{}'::text[])
  FROM unnest(coalesce(p_agents, '{}'::text[])) WITH ORDINALITY a(agent, ord)
  WHERE a.agent IN ('marcus', 'kai', 'chad', 'claire')
    AND hon.principal_has_school_permission(p_principal, p_org, p_school, hon.ai_agent_capability_permission(a.agent));
$$;

-- 0214 body; the provider result may name 'claire' among its suggestions (still at most three, distinct).
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
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_result->'suggestions') e WHERE jsonb_typeof(e) <> 'string' OR e #>> '{}' NOT IN ('marcus', 'kai', 'chad', 'claire'))
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

-- 0229 body; K2c: a Claire question may confirm HON's suggestion and join that answer's group.
CREATE OR REPLACE FUNCTION hon.begin_hon_turn(p_subject text, p_conversation uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); c hon.hon_conversations%ROWTYPE; t hon.hon_conversation_turns%ROWTYPE;
  fingerprint text; d jsonb; agent text; target jsonb; v jsonb; handoff boolean; wid uuid;
  mode text; prior hon.hon_reply_invocations%ROWTYPE; step integer := 1;
  src hon.hon_reply_invocations%ROWTYPE; orch uuid;
BEGIN
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR NOT p_input ?& ARRAY['text', 'delegation']
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('text', 'delegation', 'replyMode', 'continueTurnId', 'fromSuggestionTurnId', 'summarizeTurnId'))
     -- C2 reply mode and continuation belong to a question for HON only.
     OR ((p_input ? 'replyMode' OR p_input ? 'continueTurnId' OR p_input ? 'summarizeTurnId') AND jsonb_typeof(p_input->'delegation') IS DISTINCT FROM 'null')
     -- C3b: a group summary is a fresh question, never a continuation.
     OR (p_input ? 'summarizeTurnId' AND (p_input ? 'continueTurnId' OR jsonb_typeof(p_input->'summarizeTurnId') <> 'string'
         OR (p_input->>'summarizeTurnId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
     -- C3a: confirming a suggestion belongs to a delegation turn only.
     OR (p_input ? 'fromSuggestionTurnId' AND (jsonb_typeof(p_input->'delegation') IS DISTINCT FROM 'object' OR jsonb_typeof(p_input->'fromSuggestionTurnId') <> 'string'
         OR (p_input->>'fromSuggestionTurnId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
     OR (p_input ? 'replyMode' AND (jsonb_typeof(p_input->'replyMode') <> 'string' OR p_input->>'replyMode' NOT IN ('STANDARD', 'DETAILED')))
     OR (p_input ? 'continueTurnId' AND (jsonb_typeof(p_input->'continueTurnId') <> 'string'
         OR (p_input->>'continueTurnId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
     OR jsonb_typeof(p_input->'text') IS DISTINCT FROM 'string' OR NOT hon.marketing_safe_text(p_input->>'text', 2000)
     OR jsonb_typeof(p_input->'delegation') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'INVALID_HON_TURN' USING ERRCODE = '22023';
  END IF;
  d := p_input->'delegation'; agent := d->>'agentKey';
  -- Each specialist's own typed target only; the specialist re-validates and re-authorizes it.
  IF jsonb_typeof(d) = 'null' THEN
    -- C2: a question for HON. The question is the turn's own text; HON answers it, nothing is handed to a specialist.
    agent := 'hon';
    target := jsonb_build_object('question', btrim(p_input->>'text'));
    IF length(target->>'question') = 0 THEN RAISE EXCEPTION 'INVALID_HON_TURN' USING ERRCODE = '22023'; END IF;
  ELSIF agent = 'marcus' AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN ('agentKey', 'campaignId')) AND jsonb_typeof(d->'campaignId') = 'string'
     AND (d->>'campaignId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    target := jsonb_build_object('campaignId', lower(d->>'campaignId'), 'request', hon.hon_canonical_request_text(p_input->>'text'));
    IF NOT hon.marketing_safe_text(target->>'request', 2000) OR length(target->>'request') = 0 THEN RAISE EXCEPTION 'INVALID_HON_TURN' USING ERRCODE = '22023'; END IF;
  ELSIF agent = 'kai' AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN ('agentKey', 'curriculumId')) AND jsonb_typeof(d->'curriculumId') = 'string'
     AND (d->>'curriculumId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND length(btrim(p_input->>'text')) <= 1200 THEN
    -- K2: teaching is Kai's only. The legacy 'claire' teaching alias (K1, one release) is retired and refused below.
    target := jsonb_build_object('curriculumId', lower(d->>'curriculumId'), 'brief', p_input->>'text');
  ELSIF agent = 'claire' AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(d) k WHERE k <> 'agentKey') THEN
    -- K2: Claire, Business Performance. A read-only analysis of the school's aggregate Command Center metrics; the
    -- question is the turn's own text. Nothing is drafted, sent, approved or changed.
    target := jsonb_build_object('question', btrim(p_input->>'text'));
    IF length(target->>'question') = 0 THEN RAISE EXCEPTION 'INVALID_HON_TURN' USING ERRCODE = '22023'; END IF;
  ELSIF agent = 'chad' AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN ('agentKey', 'leadId', 'expectedLeadVersion', 'purpose'))
     AND jsonb_typeof(d->'leadId') = 'string' AND (d->>'leadId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND jsonb_typeof(d->'expectedLeadVersion') = 'number' AND (d->>'expectedLeadVersion') ~ '^[1-9][0-9]{0,8}$'
     AND d->>'purpose' IN ('INTRODUCTION', 'CHECK_IN', 'TRIAL_REMINDER', 'REENGAGEMENT') THEN
    -- Chad drafts from the lead record; the human text is kept as the conversation note only and is not sent.
    target := jsonb_build_object('leadId', lower(d->>'leadId'), 'expectedLeadVersion', (d->>'expectedLeadVersion')::integer, 'purpose', d->>'purpose');
  ELSE
    RAISE EXCEPTION 'HON_DELEGATION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  fingerprint := encode(sha256(convert_to(p_input::text, 'UTF8')), 'hex');
  SELECT * INTO c FROM hon.hon_conversations WHERE id = p_conversation AND organization_id = hon.current_organization_id() AND school_id = hon.current_school_id() AND owner_principal_id = actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- The conversation row lock can wait behind another turn: authority is held and checked again before any turn row.
  PERFORM hon.hon_conversation_hold_actor(p_subject, actor);
  SELECT * INTO t FROM hon.hon_conversation_turns WHERE conversation_id = c.id AND idempotency_key = p_key;
  IF FOUND THEN
    IF t.request_hash <> fingerprint THEN RAISE EXCEPTION 'HON_TURN_REPLAY_SWAP' USING ERRCODE = '23505'; END IF;
  ELSE
    IF c.turn_count >= 200 THEN RAISE EXCEPTION 'HON_CONVERSATION_FULL' USING ERRCODE = '23514'; END IF;
    INSERT INTO hon.hon_conversation_turns (organization_id, school_id, conversation_id, requested_by, seq, text, agent_key, delegation, delegation_fingerprint,
        idempotency_key, request_hash)
    VALUES (c.organization_id, c.school_id, c.id, actor, c.turn_count + 1, btrim(p_input->>'text'), agent, target,
        encode(sha256(convert_to(target::text, 'UTF8')), 'hex'), p_key, fingerprint) RETURNING * INTO t;
    handoff := true;
    UPDATE hon.hon_conversations SET turn_count = turn_count + 1, updated_at = clock_timestamp() WHERE id = c.id;
    IF agent = 'hon' THEN
      -- The reply is created with the turn, under the same AI planning access gate and S4 start guard (HQ pause,
      -- exception, access state): a refused question records no turn at all.
      PERFORM hon.require_ai_invocation_plan_access();
      mode := coalesce(p_input->>'replyMode', 'STANDARD');
      IF p_input ? 'continueTurnId' THEN
        -- Continue a cut-off answer: this human's own COMPLETED, truncated HON reply in this conversation, below the
        -- step limit and not yet continued (the conversation row lock above serializes concurrent continuations).
        -- The continuation keeps the answer's mode; it is its own planned, reserved and settled call.
        SELECT * INTO prior FROM hon.hon_reply_invocations WHERE turn_id = lower(p_input->>'continueTurnId')::uuid AND conversation_id = c.id
          AND organization_id = c.organization_id AND school_id = c.school_id AND requested_by = actor FOR UPDATE;
        IF NOT FOUND OR prior.status <> 'COMPLETED' OR NOT prior.truncated OR prior.step >= hon.hon_reply_max_steps()
           OR NOT hon.hon_reply_source_allowed(prior) OR prior.specialist <> 'hon'
           OR EXISTS (SELECT 1 FROM hon.hon_reply_invocations n WHERE n.continues_turn_id = prior.turn_id)
           OR (p_input ? 'replyMode' AND p_input->>'replyMode' <> prior.reply_mode) THEN
          RAISE EXCEPTION 'HON_REPLY_NOT_CONTINUABLE' USING ERRCODE = '22023';
        END IF;
        mode := prior.reply_mode; step := prior.step + 1;
      END IF;
      -- C3b: refuse early (before any reply row references the group); the same check runs again after every write.
      IF p_input ? 'summarizeTurnId'
         AND hon.hon_orchestration_summary_facts(p_subject, c.id, actor, lower(p_input->>'summarizeTurnId')::uuid) IS NULL THEN
        RAISE EXCEPTION 'HON_GROUP_NOT_SUMMARIZABLE' USING ERRCODE = '22023';
      END IF;
      INSERT INTO hon.work_items (organization_id, school_id, work_type, status, subject_type, subject_id, payload, correlation_id)
      VALUES (c.organization_id, c.school_id, 'AI_' || (hon.hon_reply_limits(mode)->>'taskClass'), 'READY', 'HON_CONVERSATION_TURN', t.id, '{}',
        nullif(current_setting('app.hon_request_id', true), '')::uuid)
      RETURNING id INTO wid;
      INSERT INTO hon.hon_reply_invocations (organization_id, school_id, conversation_id, turn_id, requested_by, work_item_id, reply_mode, step, continues_turn_id,
          summarizes_turn_id)
      VALUES (c.organization_id, c.school_id, c.id, t.id, actor, wid, mode, step, prior.turn_id, lower(p_input->>'summarizeTurnId')::uuid);
      -- C3b: a summary of a confirmed group. Checked after every write above (the turn, count, work item and reply rows
      -- can wait on locks): the group of this human's own answer in this conversation, that answer still visible to
      -- them, and every member finished (COMPLETED, FAILED or PARTIAL; never PENDING, NEEDS_REVIEW or UNKNOWN).
      -- A refusal rolls everything back: no turn is recorded.
      IF p_input ? 'summarizeTurnId'
         AND hon.hon_orchestration_summary_facts(p_subject, c.id, actor, lower(p_input->>'summarizeTurnId')::uuid) IS NULL THEN
        RAISE EXCEPTION 'HON_GROUP_NOT_SUMMARIZABLE' USING ERRCODE = '22023';
      END IF;
    ELSIF agent = 'claire' THEN
      -- Claire's capability is reporting.view (0212 binding), under the same AI planning gate and S4 start guard as HON.
      -- Checked before the reply row and again after it (the work item and reply inserts can wait on locks); a refusal
      -- rolls everything back, so no turn is recorded.
      PERFORM hon.require_ai_invocation_plan_access();
      IF NOT hon.principal_has_school_permission(actor, c.organization_id, c.school_id, 'reporting.view') THEN
        RAISE EXCEPTION 'CLAIRE_REPORTING_REQUIRED' USING ERRCODE = '42501';
      END IF;
      -- K2c: a Claire question confirmed from HON's suggestion joins that answer's group under the same C3a rules: this
      -- human's own whole COMPLETED HON answer in this conversation, visible now, still suggesting Claire for them
      -- (reporting.view, 0214 filter), and Claire not already confirmed from it. Re-validated after every write below.
      IF p_input ? 'fromSuggestionTurnId' THEN
        SELECT * INTO src FROM hon.hon_reply_invocations WHERE turn_id = lower(p_input->>'fromSuggestionTurnId')::uuid AND conversation_id = c.id
          AND organization_id = c.organization_id AND school_id = c.school_id AND requested_by = actor;
        IF NOT FOUND OR src.status <> 'COMPLETED' OR src.truncated OR src.specialist <> 'hon' OR NOT hon.hon_reply_visible(p_subject, src.turn_id)
           OR NOT agent = ANY (hon.hon_reply_allowed_suggestions(actor, c.organization_id, c.school_id, src.suggested_agents))
           OR EXISTS (SELECT 1 FROM hon.hon_orchestrations o JOIN hon.hon_orchestration_members m ON m.orchestration_id = o.id
                      WHERE o.source_turn_id = src.turn_id AND m.agent_key = agent) THEN
          RAISE EXCEPTION 'HON_SUGGESTION_NOT_CONFIRMABLE' USING ERRCODE = '22023';
        END IF;
        INSERT INTO hon.hon_orchestrations (organization_id, school_id, conversation_id, requested_by, source_turn_id)
        VALUES (c.organization_id, c.school_id, c.id, actor, src.turn_id) ON CONFLICT (source_turn_id) DO NOTHING;
        SELECT id INTO STRICT orch FROM hon.hon_orchestrations WHERE source_turn_id = src.turn_id;
        INSERT INTO hon.hon_orchestration_members (orchestration_id, organization_id, school_id, agent_key, turn_id)
        VALUES (orch, c.organization_id, c.school_id, agent, t.id);
      END IF;
      INSERT INTO hon.work_items (organization_id, school_id, work_type, status, subject_type, subject_id, payload, correlation_id)
      VALUES (c.organization_id, c.school_id, 'AI_' || (hon.hon_reply_limits('DETAILED')->>'taskClass'), 'READY', 'HON_CONVERSATION_TURN', t.id, '{}',
        nullif(current_setting('app.hon_request_id', true), '')::uuid)
      RETURNING id INTO wid;
      INSERT INTO hon.hon_reply_invocations (organization_id, school_id, conversation_id, turn_id, requested_by, work_item_id, reply_mode, step, specialist)
      VALUES (c.organization_id, c.school_id, c.id, t.id, actor, wid, 'DETAILED', 1, 'claire');
      PERFORM hon.hon_conversation_hold_actor(p_subject, actor);
      PERFORM hon.require_ai_invocation_plan_access();
      IF NOT hon.principal_has_school_permission(actor, c.organization_id, c.school_id, 'reporting.view') THEN
        RAISE EXCEPTION 'CLAIRE_REPORTING_REQUIRED' USING ERRCODE = '42501';
      END IF;
      -- K2c: the confirmed source, from a fresh read after every write (group, member, work item and reply rows).
      IF p_input ? 'fromSuggestionTurnId'
         AND (NOT EXISTS (SELECT 1 FROM hon.hon_reply_invocations r WHERE r.turn_id = src.turn_id AND r.conversation_id = c.id
                            AND r.organization_id = c.organization_id AND r.school_id = c.school_id AND r.requested_by = actor
                            AND r.status = 'COMPLETED' AND NOT r.truncated AND r.specialist = 'hon'
                            AND agent = ANY (hon.hon_reply_allowed_suggestions(actor, c.organization_id, c.school_id, r.suggested_agents)))
              OR NOT hon.hon_reply_visible(p_subject, src.turn_id)) THEN
        RAISE EXCEPTION 'HON_SUGGESTION_NOT_CONFIRMABLE' USING ERRCODE = '22023';
      END IF;
    ELSIF p_input ? 'fromSuggestionTurnId' THEN
      -- C3a: confirm a suggested specialist. The source is this human's own whole, COMPLETED HON answer in this
      -- conversation, visible to them now, whose current suggestions (capability-filtered, 0214) name this agent, and
      -- the agent was not already confirmed from it. The conversation row lock above serializes confirmations.
      SELECT * INTO src FROM hon.hon_reply_invocations WHERE turn_id = lower(p_input->>'fromSuggestionTurnId')::uuid AND conversation_id = c.id
        AND organization_id = c.organization_id AND school_id = c.school_id AND requested_by = actor;
      IF NOT FOUND OR src.status <> 'COMPLETED' OR src.truncated OR NOT hon.hon_reply_visible(p_subject, src.turn_id)
         OR NOT agent = ANY (hon.hon_reply_allowed_suggestions(actor, c.organization_id, c.school_id, src.suggested_agents))
         OR EXISTS (SELECT 1 FROM hon.hon_orchestrations o JOIN hon.hon_orchestration_members m ON m.orchestration_id = o.id
                    WHERE o.source_turn_id = src.turn_id AND m.agent_key = agent) THEN
        RAISE EXCEPTION 'HON_SUGGESTION_NOT_CONFIRMABLE' USING ERRCODE = '22023';
      END IF;
      INSERT INTO hon.hon_orchestrations (organization_id, school_id, conversation_id, requested_by, source_turn_id)
      VALUES (c.organization_id, c.school_id, c.id, actor, src.turn_id) ON CONFLICT (source_turn_id) DO NOTHING;
      SELECT id INTO STRICT orch FROM hon.hon_orchestrations WHERE source_turn_id = src.turn_id;
      INSERT INTO hon.hon_orchestration_members (orchestration_id, organization_id, school_id, agent_key, turn_id)
      VALUES (orch, c.organization_id, c.school_id, agent, t.id);
      -- The group and member writes above can wait on locks, and access, a grant or the answer's visibility can
      -- lapse meanwhile. Re-validate the exact source from a fresh read before handing off: still this human's own
      -- whole COMPLETED answer at this school, visible now (which re-checks the actor), and still suggesting an agent
      -- they may use. A refusal here rolls back the turn, the count, the group and the member together. The
      -- duplicate check is not repeated: the member row this call just wrote would match it.
      IF NOT EXISTS (SELECT 1 FROM hon.hon_reply_invocations r WHERE r.turn_id = src.turn_id AND r.conversation_id = c.id
                       AND r.organization_id = c.organization_id AND r.school_id = c.school_id AND r.requested_by = actor
                       AND r.status = 'COMPLETED' AND NOT r.truncated
                       AND agent = ANY (hon.hon_reply_allowed_suggestions(actor, c.organization_id, c.school_id, r.suggested_agents)))
         OR NOT hon.hon_reply_visible(p_subject, src.turn_id) THEN
        RAISE EXCEPTION 'HON_SUGGESTION_NOT_CONFIRMABLE' USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;
  v := hon.hon_turn_view(t);
  -- HON's own answer, or Claire's analysis (K2): both are reply invocations. A legacy 'claire' teaching turn has none.
  IF t.agent_key = 'hon' OR EXISTS (SELECT 1 FROM hon.hon_reply_invocations r WHERE r.turn_id = t.id) THEN
    -- Only a reply that never left PENDING is handed to the reply service again; its prepare admits one caller.
    handoff := EXISTS (SELECT 1 FROM hon.hon_reply_invocations r WHERE r.turn_id = t.id AND r.status = 'PENDING');
    RETURN jsonb_build_object('turnId', t.id, 'agentKey', t.agent_key, 'delegation', NULL, 'handOff', handoff);
  END IF;
  IF handoff IS NULL THEN
    handoff := t.failure_reason IS NULL AND v->>'invocationId' IS NULL
      AND (t.handoff_claimed_at IS NULL OR t.handoff_claimed_at <= clock_timestamp() - interval '5 minutes');
  END IF;
  IF handoff THEN UPDATE hon.hon_conversation_turns SET handoff_claimed_at = clock_timestamp() WHERE id = t.id; END IF;
  RETURN jsonb_build_object('turnId', t.id, 'agentKey', hon.hon_presented_agent(t.agent_key), 'delegation', t.delegation, 'handOff', handoff);
END $$;

COMMIT;
