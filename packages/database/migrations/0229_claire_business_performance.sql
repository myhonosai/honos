BEGIN;

-- K2 (proposed number; the owner allocates the final one): Claire, Business Performance, read-only.
-- Owner master blueprint 2026-11-06: HON is the central assistant, Kai owns teaching, Claire is the Business Performance
-- specialist. Design: /mnt/project-files/sprint4a/K2_CLAIRE_BUSINESS_PERFORMANCE.md (project files, not in the repo).
--
-- What changes:
-- 1. K2a. The legacy 'claire' teaching alias (accepted for one release by K1, 0211) is retired: a delegation
--    { agentKey: 'claire', curriculumId } is refused (HON_DELEGATION_REQUIRED). Teaching is { agentKey: 'kai' } only.
--    Historical 'claire' teaching rows are evidence and are not rewritten; they are still presented as Kai (they have no
--    reply invocation). A teaching record stays identified by its capability (DRAFT_TEACHING, teaching_ai_invocations).
-- 2. K2b. A delegation { agentKey: 'claire' } (no other key) is a question for Claire. It runs on the C2 reply
--    machinery: one hon_reply_invocations row with specialist 'claire', always DETAILED (task class ANALYZE, 11000 input /
--    4000 output tokens, 80,000 microunits, 15 credits reserved), a fresh single step (never continued, never a group
--    summary, never with suggestions). Plans are agent 'claire', task class ANALYZE only.
-- 3. Authority. Claire's capability is reporting.view (0212 binding now maps 'claire'). begin_hon_turn refuses without
--    it before and after its writes; prepare_hon_reply refuses (BLOCKED, SOURCE_ACCESS_REFUSED, nothing reserved or
--    sent) without it early and again in the final revalidation, and never runs Claire on NOT_AUTHORIZED facts.
-- 4. Facts: the Command Center aggregate metrics (hon.read_school_command_center re-checks the human, school,
--    reporting.view and entitlement itself) and the question. No conversation history, no names, contact, family,
--    student or payment rows. The answer is always reporting-derived, so it is concealed whenever reporting.view or
--    the live AI access gate lapses (0210 header item 6).
-- 5. S4 is unchanged: the same start/reserve guards, budget lock, HQ pause, hold origin, measured settlement, late
--    expense and UNKNOWN resolution (agent HON_REPLY: the row is in hon_reply_invocations). HQ per-school usage keeps
--    these calls under HON_REPLY in this slice. Readiness lists Claire as BUSINESS_PERFORMANCE.
-- 6. Readers: a turn's reply text and detail come from its reply invocation for 'hon' and 'claire' alike.
-- Text only. Claire never drafts, sends, schedules, approves or changes anything. Nothing here activates a provider.

ALTER TABLE hon.hon_reply_invocations ADD COLUMN specialist text NOT NULL DEFAULT 'hon' CHECK (specialist IN ('hon', 'claire'));
ALTER TABLE hon.hon_reply_invocations ADD CONSTRAINT hon_reply_invocations_claire_single_analysis
  CHECK (specialist = 'hon' OR (reply_mode = 'DETAILED' AND step = 1 AND continues_turn_id IS NULL AND summarizes_turn_id IS NULL
                                AND cardinality(suggested_agents) = 0));

-- New 'claire' plans are Business Performance analyses only. Historical 'claire' DRAFT_TEACHING plans are evidence and
-- stay (NOT VALID: existing rows are not re-checked; plans are immutable, so every new row is checked).
ALTER TABLE hon.ai_invocation_plans ADD CONSTRAINT ai_invocation_plans_claire_analysis_only
  CHECK (agent_key <> 'claire' OR task_class = 'ANALYZE') NOT VALID;

-- 0212 mapping plus Claire (Business Performance): reporting.view.
CREATE OR REPLACE FUNCTION hon.ai_agent_capability_permission(p_agent text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE p_agent
    WHEN 'hon' THEN 'ai.invocation.plan'            -- HON replies: school facts still need reporting.view (else NOT_AUTHORIZED)
    WHEN 'kai' THEN 'teaching.assistant.use'        -- Teaching & Curriculum
    WHEN 'marcus' THEN 'marketing.assistant.use'    -- Marketing drafts
    WHEN 'chad' THEN 'crm.assistant.follow_up_draft' -- Lead follow-up drafts (Chad also re-checks crm.lead.read)
    WHEN 'claire' THEN 'reporting.view'             -- Business Performance analysis (K2)
  END
$$;

-- 0228 body: K2a retires the 'claire' teaching alias; K2b adds Claire's analysis turn; Claire answers are never continued.
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
      -- K2: Claire is never confirmed from a suggestion here (HON's closed suggestion set has no Claire yet).
      IF p_input ? 'fromSuggestionTurnId' THEN RAISE EXCEPTION 'HON_SUGGESTION_NOT_CONFIRMABLE' USING ERRCODE = '22023'; END IF;
      -- Claire's capability is reporting.view (0212 binding), under the same AI planning gate and S4 start guard as HON.
      -- Checked before the reply row and again after it (the work item and reply inserts can wait on locks); a refusal
      -- rolls everything back, so no turn is recorded.
      PERFORM hon.require_ai_invocation_plan_access();
      IF NOT hon.principal_has_school_permission(actor, c.organization_id, c.school_id, 'reporting.view') THEN
        RAISE EXCEPTION 'CLAIRE_REPORTING_REQUIRED' USING ERRCODE = '42501';
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

-- 0228 body plus Claire: plan agent is the row's specialist; Claire needs reporting facts (early and final checks)
-- and gets no conversation history.
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
  UPDATE hon.hon_reply_invocations SET used_reporting = school_facts IS NOT NULL OR derived, context_digest = encode(sha256(convert_to(jsonb_build_object('question', t.text, 'facts', facts)::text, 'UTF8')), 'hex')
  WHERE id = i.id;
  RETURN jsonb_build_object('providerId', p.provider_id, 'modelId', p.model_id, 'providerRequestId', i.provider_request_id,
    'specialist', i.specialist, 'replyMode', i.reply_mode, 'step', i.step, 'question', t.text, 'facts', facts::text, 'inputBudget', p.input_budget, 'outputBudget', p.output_budget,
    'maxCostMicrounits', p.max_provider_cost_microunits);
END $$;

-- 0211 body: a turn with a reply invocation (HON or Claire) takes its state from it.
CREATE OR REPLACE FUNCTION hon.hon_turn_view(t hon.hon_conversation_turns) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE inv_id uuid; inv_status text; inv_reason text; work uuid; action uuid; updated timestamptz; status text; reason text; reply boolean := false;
BEGIN
  IF t.agent_key = 'marcus' THEN
    SELECT id, i.status, i.reason, work_item_id, action_request_id, updated_at INTO inv_id, inv_status, inv_reason, work, action, updated
    FROM hon.marketing_ai_invocations i WHERE organization_id = t.organization_id AND school_id = t.school_id AND requested_by = t.requested_by AND idempotency_key = t.id
      AND i.request_hash = t.delegation_fingerprint;
  ELSIF t.agent_key = 'hon' OR EXISTS (SELECT 1 FROM hon.hon_reply_invocations r WHERE r.turn_id = t.id) THEN
    -- HON's answer, or Claire's analysis (K2): the reply invocation is the turn's state.
    SELECT id, i.status, i.reason, work_item_id, NULL::uuid, updated_at INTO inv_id, inv_status, inv_reason, work, action, updated
    FROM hon.hon_reply_invocations i WHERE organization_id = t.organization_id AND school_id = t.school_id AND requested_by = t.requested_by AND turn_id = t.id;
    reply := true;
  ELSIF t.agent_key IN ('kai', 'claire') THEN
    SELECT id, i.status, i.reason, work_item_id, action_request_id, updated_at INTO inv_id, inv_status, inv_reason, work, action, updated
    FROM hon.teaching_ai_invocations i WHERE organization_id = t.organization_id AND school_id = t.school_id AND requested_by = t.requested_by AND idempotency_key = t.id
      AND i.request_hash = t.delegation_fingerprint;
  ELSE
    SELECT id, i.status, i.reason, work_item_id, action_request_id, updated_at INTO inv_id, inv_status, inv_reason, work, action, updated
    FROM hon.chad_follow_up_invocations i WHERE organization_id = t.organization_id AND school_id = t.school_id AND requested_by = t.requested_by AND idempotency_key = t.id
      AND i.request_hash = t.delegation_fingerprint;
  END IF;
  IF reply THEN
    -- C2: the reply is created with the turn. A pending reply that has not started within five minutes is UNKNOWN
    -- (resending with the same Idempotency-Key resumes it); a SENDING reply past the stale limit is UNKNOWN.
    status := CASE
      WHEN inv_id IS NULL THEN 'UNKNOWN'
      WHEN inv_status = 'PENDING' AND updated <= clock_timestamp() - interval '5 minutes' THEN 'UNKNOWN'
      WHEN inv_status = 'SENDING' AND updated <= clock_timestamp() - hon.ai_sending_stale_after() THEN 'UNKNOWN'
      WHEN inv_status IN ('PENDING', 'SENDING', 'RESULT_HELD') THEN 'PROCESSING'
      WHEN inv_status = 'COMPLETED' THEN 'COMPLETED'
      WHEN inv_status IN ('CONFIGURATION_REQUIRED', 'BLOCKED', 'FAILED') THEN 'FAILED'
      ELSE 'UNKNOWN' END;
    reason := CASE WHEN inv_status = 'RESULT_HELD' THEN 'RESULT_HELD' WHEN inv_status = 'CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED'
                   WHEN inv_status = 'PENDING' AND status = 'UNKNOWN' THEN 'HANDOFF_NOT_CONFIRMED'
                   WHEN status IN ('FAILED', 'UNKNOWN') THEN coalesce(inv_reason, inv_status, 'HANDOFF_NOT_CONFIRMED') END;
  ELSIF inv_id IS NULL THEN
    -- Not yet handed over (or the hand-over never started): a recorded refusal is FAILED; a hand-over that did not
    -- finish within five minutes is UNKNOWN (resending with the same Idempotency-Key resumes it); otherwise PROCESSING.
    status := CASE WHEN t.failure_reason IS NOT NULL THEN 'FAILED' WHEN coalesce(t.handoff_claimed_at, t.created_at) <= clock_timestamp() - interval '5 minutes' THEN 'UNKNOWN' ELSE 'PROCESSING' END;
    reason := coalesce(t.failure_reason, CASE WHEN status = 'UNKNOWN' THEN 'HANDOFF_NOT_CONFIRMED' END);
  ELSE
    -- Specialist state is authoritative. Anything not listed is UNKNOWN, never success.
    status := CASE
      WHEN inv_status = 'SENDING' AND updated <= clock_timestamp() - hon.ai_sending_stale_after() THEN 'UNKNOWN'
      WHEN inv_status IN ('PENDING', 'SENDING', 'RESULT_RECORDED', 'RESULT_HELD') THEN 'DELEGATING'
      WHEN inv_status = 'AWAITING_APPROVAL' THEN 'AWAITING_APPROVAL'
      WHEN inv_status IN ('SAVED', 'APPROVED') THEN 'COMPLETED'
      WHEN inv_status IN ('CONFIGURATION_REQUIRED', 'BLOCKED', 'FAILED', 'REJECTED') THEN 'FAILED'
      ELSE 'UNKNOWN' END;
    reason := CASE WHEN inv_status = 'RESULT_HELD' THEN 'RESULT_HELD' WHEN inv_status = 'REJECTED' THEN 'PROPOSAL_REJECTED'
                   WHEN inv_status = 'CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED'
                   WHEN status IN ('FAILED', 'UNKNOWN') THEN coalesce(inv_reason, inv_status) END;
  END IF;
  RETURN jsonb_build_object('turnId', t.id, 'conversationId', t.conversation_id, 'agentKey', CASE WHEN reply THEN t.agent_key ELSE hon.hon_presented_agent(t.agent_key) END, 'status', status, 'reason', reason,
    'invocationId', inv_id, 'workItemId', work, 'actionRequestId', action);
END $$;

-- 0211 body: Claire's analysis is shown like HON's reply, under the same visibility rules.
CREATE OR REPLACE FUNCTION hon.read_hon_turn_receipt(p_subject text, p_turn uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); t hon.hon_conversation_turns%ROWTYPE; v jsonb; visible boolean; replied boolean;
BEGIN
  SELECT * INTO t FROM hon.hon_conversation_turns WHERE id = p_turn AND organization_id = hon.current_organization_id() AND school_id = hon.current_school_id() AND requested_by = actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_TURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v := hon.hon_turn_view(t);
  -- Source authority and the live access gate are re-checked before a HON reply is shown (0210 header item 6).
  -- K2: Claire's analysis is a reply invocation too, under the same source-authority and access rules.
  replied := t.agent_key = 'hon' OR EXISTS (SELECT 1 FROM hon.hon_reply_invocations r WHERE r.turn_id = t.id);
  visible := replied AND hon.hon_reply_visible(p_subject, t.id);
  IF replied AND v->>'status' = 'COMPLETED' AND NOT visible THEN v := v || jsonb_build_object('reason', 'RESULT_CONCEALED'); END IF;
  RETURN jsonb_build_object('turnId', t.id, 'conversationId', t.conversation_id, 'status', v->>'status', 'reason', v->'reason',
    'delegatedAgentKeys', CASE WHEN t.agent_key = 'hon' THEN '[]'::jsonb WHEN replied THEN jsonb_build_array(t.agent_key) ELSE jsonb_build_array(hon.hon_presented_agent(t.agent_key)) END,
    'actionRequestIds', CASE WHEN v->>'actionRequestId' IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v->'actionRequestId') END,
    'workItemIds', CASE WHEN v->>'workItemId' IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v->'workItemId') END,
    'invocationId', v->'invocationId',
    'reply', CASE WHEN replied AND v->>'status' = 'COMPLETED' AND visible THEN (SELECT to_jsonb(r.reply_text) FROM hon.hon_reply_invocations r WHERE r.turn_id = t.id AND r.status = 'COMPLETED') ELSE 'null'::jsonb END,
    'replyDetail', CASE WHEN replied THEN coalesce(hon.hon_reply_detail(t.id, visible), 'null'::jsonb) ELSE 'null'::jsonb END);
END $$;

-- 0211 body, same change.
CREATE OR REPLACE FUNCTION hon.read_hon_conversation(p_subject text, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); c hon.hon_conversations%ROWTYPE; turns jsonb;
BEGIN
  SELECT * INTO c FROM hon.hon_conversations WHERE id = p_id AND organization_id = hon.current_organization_id() AND school_id = hon.current_school_id() AND owner_principal_id = actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- Each human turn is followed by the named specialist's turn. Specialist text is never copied here: the draft stays
  -- behind the specialist's own read and Action Center, which re-check that specialist's permission. HON's own reply
  -- (C2) is shown only when COMPLETED; a held, failed or unknown reply shows no text.
  SELECT coalesce(jsonb_agg(x ORDER BY t.seq, x->>'role' <> 'HUMAN'), '[]'::jsonb) INTO turns
  FROM hon.hon_conversation_turns t CROSS JOIN LATERAL (SELECT hon.hon_turn_view(t) v) v
  -- Source authority and the live access gate are re-checked for every HON reply shown (0210 header item 6).
  -- K2: Claire's analysis is a reply invocation too (a legacy 'claire' teaching turn has none and is shown as Kai).
  CROSS JOIN LATERAL (SELECT t.agent_key = 'hon' OR EXISTS (SELECT 1 FROM hon.hon_reply_invocations q WHERE q.turn_id = t.id) AS replied) q
  CROSS JOIN LATERAL (SELECT q.replied AND hon.hon_reply_visible(p_subject, t.id) AS visible) s
  CROSS JOIN LATERAL (VALUES
    (jsonb_build_object('turnId', t.id, 'role', 'HUMAN', 'text', t.text, 'createdAt', hon.saas_ts(t.created_at), 'status', v.v->>'status',
       'reason', NULL, 'references', jsonb_build_object('workItemId', NULL, 'actionRequestId', NULL, 'invocationId', NULL), 'replyDetail', NULL)),
    (jsonb_build_object('turnId', t.id, 'role', CASE WHEN q.replied THEN t.agent_key ELSE hon.hon_presented_agent(t.agent_key) END,
       'text', CASE WHEN q.replied AND v.v->>'status' = 'COMPLETED' AND s.visible THEN (SELECT r.reply_text FROM hon.hon_reply_invocations r WHERE r.turn_id = t.id AND r.status = 'COMPLETED') END, 'createdAt', hon.saas_ts(t.created_at), 'status', v.v->>'status',
       'reason', CASE WHEN q.replied AND v.v->>'status' = 'COMPLETED' AND NOT s.visible THEN 'RESULT_CONCEALED' ELSE v.v->>'reason' END, 'references', jsonb_build_object('workItemId', v.v->'workItemId', 'actionRequestId', v.v->'actionRequestId', 'invocationId', v.v->'invocationId'),
       'replyDetail', CASE WHEN q.replied THEN hon.hon_reply_detail(t.id, s.visible) END))
  ) AS r(x)
  WHERE t.conversation_id = c.id;
  RETURN hon.hon_conversation_summary(c) || jsonb_build_object('turns', turns);
END $$;

-- 0214 body: only HON's own answers can be continued.
CREATE OR REPLACE FUNCTION hon.hon_reply_detail(p_turn uuid, p_visible boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('mode', r.reply_mode, 'step', r.step, 'maxSteps', hon.hon_reply_max_steps(),
    'truncated', r.status = 'COMPLETED' AND r.truncated,
    'canContinue', r.specialist = 'hon' AND r.status = 'COMPLETED' AND coalesce(p_visible, false) AND r.truncated AND r.step < hon.hon_reply_max_steps()
      AND NOT EXISTS (SELECT 1 FROM hon.hon_reply_invocations n WHERE n.continues_turn_id = r.turn_id),
    'continuesTurnId', r.continues_turn_id,
    'suggestions', to_jsonb(CASE WHEN r.status = 'COMPLETED' AND coalesce(p_visible, false) AND NOT r.truncated
      THEN hon.hon_reply_allowed_suggestions(r.requested_by, r.organization_id, r.school_id, r.suggested_agents) ELSE '{}'::text[] END))
  FROM hon.hon_reply_invocations r WHERE r.turn_id = p_turn;
$$;

-- 0210 body plus the agent to plan.
CREATE OR REPLACE FUNCTION hon.hon_reply_planning_reference(p_subject text, p_turn uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); i hon.hon_reply_invocations%ROWTYPE; v integer;
BEGIN
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF i.status <> 'PENDING' THEN RETURN NULL; END IF;
  SELECT version INTO v FROM hon.work_items WHERE id = i.work_item_id;
  RETURN jsonb_build_object('invocationId', i.id, 'workItemId', i.work_item_id, 'workVersion', v, 'limits', hon.hon_reply_limits(i.reply_mode), 'agentKey', i.specialist);
END $$;

-- 0211 body plus Claire.
CREATE OR REPLACE FUNCTION hon.read_ai_team_readiness(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id(); at timestamptz := clock_timestamp();
  actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
  access text; committed bigint; ceiling integer; complete boolean; agents jsonb := '[]'::jsonb; budget jsonb;
  a record; authorized boolean; denial text; route text; budget_left bigint;
BEGIN
  PERFORM hon.require_tenant_context();
  -- The caller must be the direct human of this transaction and hold AI planning at this exact school; a refusal
  -- here is the same refusal every agent would give, so nothing about the agents is disclosed to others.
  IF p_subject IS NULL OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
     OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
     OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
     OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
                    WHERE u.external_subject = p_subject AND p.id = actor AND p.is_active AND p.principal_type = 'HUMAN_USER')
     OR NOT hon.principal_has_school_permission(actor, org, school, 'ai.invocation.plan') THEN
    RAISE EXCEPTION 'AI_TEAM_READINESS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  complete := EXISTS (SELECT 1 FROM hon.organization_entitlements WHERE organization_id = org AND tier = 'COMPLETE' AND status = 'ACTIVE'
                      AND effective_from <= at AND (effective_until IS NULL OR at < effective_until));
  access := hon.ai_spend_allowed(org, at, 'AGENT_INFERENCE');
  committed := hon.ai_org_committed_credits(org, at);
  ceiling := hon.ai_org_ceiling(org, at);
  FOR a IN SELECT * FROM (VALUES ('marcus', 'MARKETING', 5120::bigint, 100000::bigint, 6), ('kai', 'TEACHING', 5120, 100000, 6),
                                 ('chad', 'CHAD_FOLLOW_UP', 2648, 60000, 3), ('hon', 'HON_REPLY', 9500, 80000, 10),
                                 ('claire', 'BUSINESS_PERFORMANCE', 15000, 80000, 15)) v(agent_key, agent, units, max_cost, estimate) LOOP
    BEGIN
      IF a.agent_key = 'marcus' THEN PERFORM hon.marketing_owner(p_subject);
      ELSIF a.agent_key = 'kai' THEN PERFORM hon.require_teaching_assistant_actor(p_subject, false);
      ELSIF a.agent_key = 'chad' THEN PERFORM hon.require_chad_follow_up_actor(p_subject);
      ELSIF a.agent_key = 'claire' THEN
        -- K2: Claire needs the conversation, AI planning and her own capability (reporting.view).
        PERFORM hon.hon_conversation_actor(p_subject); PERFORM hon.require_ai_invocation_plan_access();
        IF NOT hon.principal_has_school_permission(actor, org, school, 'reporting.view') THEN RAISE EXCEPTION 'CLAIRE_REPORTING_REQUIRED' USING ERRCODE = '42501'; END IF;
      ELSE PERFORM hon.hon_conversation_actor(p_subject); PERFORM hon.require_ai_invocation_plan_access(); END IF;
      authorized := true;
    EXCEPTION WHEN insufficient_privilege OR no_data_found THEN authorized := false;
    END;
    route := hon.ai_team_route(org, school, a.units, a.max_cost);
    budget_left := ceiling - committed;
    denial := CASE WHEN NOT authorized THEN 'NOT_AUTHORIZED'
                   WHEN access IS NOT NULL THEN access
                   WHEN route IS NOT NULL THEN route
                   WHEN budget_left < a.estimate THEN 'ORGANIZATION_AI_BUDGET_REACHED'
                   ELSE NULL END;
    agents := agents || jsonb_build_object('agentKey', a.agent_key, 'agent', a.agent, 'authorized', authorized,
      'spendDecision', coalesce(access, 'ALLOWED'), 'route', coalesce(route, 'CONFIGURED'), 'requestCredits', a.estimate,
      'available', denial IS NULL, 'blockedBy', denial);
  END LOOP;
  -- Organization-wide totals only for independently verified organization-wide authority (see header).
  budget := CASE WHEN hon.ai_team_org_budget_authority(actor, org)
                 THEN jsonb_build_object('committedCredits', committed, 'ceilingCredits', ceiling) END;
  RETURN jsonb_build_object('organizationId', org, 'schoolId', school, 'completeEntitlement', complete,
    'agentBudget', budget,
    'agents', agents, 'asOf', hon.saas_ts(at));
END $$;

COMMIT;
