BEGIN;

-- C3b: HON summarizes a confirmed group's recorded outcomes (design HON_ORCHESTRATION_KAI_AND_ACTIVATION.md §4,
-- "Unified result"). Migration number 0228 (allocated by the owner 2026-11-09).
-- A summary is an ordinary C2 question ({ text, delegation: null, summarizeTurnId }) with its own plan, reservation,
-- S4 checks and settlement. It is allowed only for this human's own group (0215) in the same conversation, while the
-- source answer is still visible to them and every member has finished (group status COMPLETED, FAILED or PARTIAL).
-- What HON receives about the group is built here from recorded rows only: the group status, the source question and
-- answer (trimmed as in history), and each member's specialist, status and reason. No drafts, no specialist output,
-- no names or contact details. HON is told to keep recorded facts apart from its own interpretation. Nothing runs.

ALTER TABLE hon.hon_reply_invocations ADD COLUMN summarizes_turn_id uuid REFERENCES hon.hon_orchestrations(source_turn_id);
ALTER TABLE hon.hon_reply_invocations ADD CONSTRAINT hon_reply_invocations_summary_fresh
  CHECK (summarizes_turn_id IS NULL OR (continues_turn_id IS NULL AND step = 1));

-- The recorded facts of this human's own finished group in this conversation, or NULL when it may not be summarized
-- now (no such group, source answer no longer visible to them, or a member still running, awaiting review or UNKNOWN).
CREATE FUNCTION hon.hon_orchestration_summary_facts(p_subject text, p_conversation uuid, p_actor uuid, p_source uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE o hon.hon_orchestrations%ROWTYPE; members jsonb; statuses text[]; status text; q text; a text;
BEGIN
  SELECT * INTO o FROM hon.hon_orchestrations WHERE source_turn_id = p_source AND conversation_id = p_conversation
    AND organization_id = hon.current_organization_id() AND school_id = hon.current_school_id() AND requested_by = p_actor;
  IF NOT FOUND OR NOT hon.hon_reply_visible(p_subject, p_source) THEN RETURN NULL; END IF;
  SELECT array_agg(v->>'status' ORDER BY t.seq),
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object('agentKey', v->>'agentKey', 'status', v->>'status', 'reason', v->>'reason')) ORDER BY t.seq)
    INTO statuses, members
  FROM hon.hon_orchestration_members m JOIN hon.hon_conversation_turns t ON t.id = m.turn_id
  CROSS JOIN LATERAL (SELECT hon.hon_turn_view(t) v) x
  WHERE m.orchestration_id = o.id;
  status := hon.hon_orchestration_status(statuses);
  IF status NOT IN ('COMPLETED', 'FAILED', 'PARTIAL') THEN RETURN NULL; END IF;
  SELECT left(s.text, 400), left(r.reply_text, 600) INTO q, a FROM hon.hon_conversation_turns s
    JOIN hon.hon_reply_invocations r ON r.turn_id = s.id AND r.status = 'COMPLETED' WHERE s.id = p_source;
  RETURN jsonb_build_object('status', status, 'sourceQuestion', q, 'sourceAnswer', a, 'members', members);
END $$;

-- 0215 body, plus the optional summarizeTurnId on a question (C3b).
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
  ELSIF agent IN ('kai', 'claire') AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN ('agentKey', 'curriculumId')) AND jsonb_typeof(d->'curriculumId') = 'string'
     AND (d->>'curriculumId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND length(btrim(p_input->>'text')) <= 1200 THEN
    target := jsonb_build_object('curriculumId', lower(d->>'curriculumId'), 'brief', p_input->>'text');
    -- K1: new teaching turns are Kai's. 'claire' is accepted for one release as a deprecated alias and stored as 'kai';
    -- a resend of a turn recorded earlier under 'claire' finds that turn by its key and keeps its recorded key.
    agent := 'kai';
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
           OR NOT hon.hon_reply_source_allowed(prior)
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
  IF t.agent_key = 'hon' THEN
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

-- 0210 body, plus the group's recorded facts for a summary (C3b), re-read after every wait.
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
        AND work_item_id = i.work_item_id AND agent_key = 'hon' AND task_class = lim->>'taskClass' AND input_budget = (lim->>'inputBudget')::integer
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
  SELECT coalesce(jsonb_agg(z.h ORDER BY z.seq), '[]'::jsonb) INTO history FROM (
    SELECT x.seq, jsonb_strip_nulls(jsonb_build_object('question', left(x.text, 400),
        -- A reporting-derived earlier answer is reused only while this human still holds reporting.view.
        'answer', CASE WHEN x.agent_key = 'hon' AND (NOT r.used_reporting OR has_reporting) THEN left(r.reply_text, 600) END,
      -- Owner blueprint: the legacy 'claire' teaching delegate is Kai; HON never sees it as Claire.
        'delegatedTo', CASE WHEN x.agent_key = 'claire' THEN 'kai' WHEN x.agent_key <> 'hon' THEN x.agent_key END)) h
    FROM hon.hon_conversation_turns x
    LEFT JOIN hon.hon_reply_invocations r ON r.turn_id = x.id AND r.status = 'COMPLETED'
    WHERE x.conversation_id = t.conversation_id AND x.seq < t.seq
    ORDER BY x.seq DESC LIMIT 3) z;
  SELECT coalesce(bool_or(r.used_reporting AND has_reporting), false) INTO derived FROM (
    SELECT x.id FROM hon.hon_conversation_turns x WHERE x.conversation_id = t.conversation_id AND x.seq < t.seq ORDER BY x.seq DESC LIMIT 3) z
    JOIN hon.hon_reply_invocations r ON r.turn_id = z.id AND r.status = 'COMPLETED';
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
    WHEN (school_facts IS NOT NULL OR derived) AND NOT hon.principal_has_school_permission(actor, i.organization_id, i.school_id, 'reporting.view') THEN 'SOURCE_ACCESS_REFUSED' END;
  IF why IS NOT NULL THEN
    UPDATE hon.hon_reply_invocations SET status = 'BLOCKED', reason = why, reserved_credits = 0, updated_at = clock_timestamp() WHERE id = i.id;
    UPDATE hon.work_items SET status = 'NEEDS_ATTENTION', version = version + 1, updated_at = clock_timestamp() WHERE id = i.work_item_id;
    RETURN NULL;
  END IF;
  facts := jsonb_strip_nulls(jsonb_build_object('school', coalesce(school_facts, jsonb_build_object('availability', 'NOT_AUTHORIZED')), 'history', history,
    'continuation', continuation, 'group', grp));
  UPDATE hon.hon_reply_invocations SET used_reporting = school_facts IS NOT NULL OR derived, context_digest = encode(sha256(convert_to(jsonb_build_object('question', t.text, 'facts', facts)::text, 'UTF8')), 'hex')
  WHERE id = i.id;
  RETURN jsonb_build_object('providerId', p.provider_id, 'modelId', p.model_id, 'providerRequestId', i.provider_request_id,
    'replyMode', i.reply_mode, 'step', i.step, 'question', t.text, 'facts', facts::text, 'inputBudget', p.input_budget, 'outputBudget', p.output_budget,
    'maxCostMicrounits', p.max_provider_cost_microunits);
END $$;

DO $$
DECLARE v_role text;
BEGIN
  REVOKE ALL ON FUNCTION hon.hon_orchestration_summary_facts(text, uuid, uuid, uuid) FROM PUBLIC;
  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.hon_orchestration_summary_facts(text, uuid, uuid, uuid) FROM %I', v_role);
  END LOOP;
END $$;

COMMIT;
