BEGIN;

-- C3a part 2: grouped confirmation of HON's suggestions. Suggest, don't act.
-- A human confirms a suggested specialist by sending an ordinary C1 delegation turn with fromSuggestionTurnId naming
-- the HON answer (0214 suggestions). That turn takes its own capability, planning, budget and approval path unchanged.
-- Every confirmation from one answer is grouped under one hon_orchestrations row. Its status is derived from the
-- member turns' recorded statuses when read; nothing stores or accepts a status, and the model sets nothing.

CREATE TABLE hon.hon_orchestrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL, conversation_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES hon.principals(id),
  source_turn_id uuid NOT NULL UNIQUE REFERENCES hon.hon_reply_invocations(turn_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, organization_id, school_id) REFERENCES hon.hon_conversations(id, organization_id, school_id)
);
CREATE TABLE hon.hon_orchestration_members (
  orchestration_id uuid NOT NULL REFERENCES hon.hon_orchestrations(id), organization_id uuid NOT NULL, school_id uuid NOT NULL,
  agent_key text NOT NULL CHECK (agent_key IN ('marcus', 'kai', 'chad')),
  turn_id uuid NOT NULL UNIQUE REFERENCES hon.hon_conversation_turns(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (orchestration_id, agent_key)
);
ALTER TABLE hon.hon_orchestrations ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.hon_orchestrations FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.hon_orchestration_members ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.hon_orchestration_members FORCE ROW LEVEL SECURITY;

-- Grouping is append-only evidence of what the human confirmed.
CREATE FUNCTION hon.hon_orchestration_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'HON_ORCHESTRATION_IMMUTABLE' USING ERRCODE = '55000'; END $$;
CREATE TRIGGER hon_orchestrations_immutable BEFORE UPDATE OR DELETE ON hon.hon_orchestrations FOR EACH ROW EXECUTE FUNCTION hon.hon_orchestration_immutable();
CREATE TRIGGER hon_orchestration_members_immutable BEFORE UPDATE OR DELETE ON hon.hon_orchestration_members FOR EACH ROW EXECUTE FUNCTION hon.hon_orchestration_immutable();

-- The derived group status (contract deriveHonOrchestrationStatus): any UNKNOWN -> UNKNOWN; any running -> PENDING;
-- any awaiting approval -> NEEDS_REVIEW; all completed -> COMPLETED; all failed -> FAILED; otherwise PARTIAL.
CREATE FUNCTION hon.hon_orchestration_status(p_statuses text[]) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE
    WHEN cardinality(coalesce(p_statuses, '{}')) = 0 OR 'UNKNOWN' = ANY (p_statuses) THEN 'UNKNOWN'
    WHEN p_statuses && ARRAY['READY', 'PROCESSING', 'DELEGATING'] THEN 'PENDING'
    WHEN 'AWAITING_APPROVAL' = ANY (p_statuses) THEN 'NEEDS_REVIEW'
    WHEN p_statuses <@ ARRAY['COMPLETED'] THEN 'COMPLETED'
    WHEN p_statuses <@ ARRAY['FAILED'] THEN 'FAILED'
    ELSE 'PARTIAL' END
$$;

CREATE OR REPLACE FUNCTION hon.begin_hon_turn(p_subject text, p_conversation uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); c hon.hon_conversations%ROWTYPE; t hon.hon_conversation_turns%ROWTYPE;
  fingerprint text; d jsonb; agent text; target jsonb; v jsonb; handoff boolean; wid uuid;
  mode text; prior hon.hon_reply_invocations%ROWTYPE; step integer := 1;
  src hon.hon_reply_invocations%ROWTYPE; orch uuid;
BEGIN
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR NOT p_input ?& ARRAY['text', 'delegation']
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('text', 'delegation', 'replyMode', 'continueTurnId', 'fromSuggestionTurnId'))
     -- C2 reply mode and continuation belong to a question for HON only.
     OR ((p_input ? 'replyMode' OR p_input ? 'continueTurnId') AND jsonb_typeof(p_input->'delegation') IS DISTINCT FROM 'null')
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
      INSERT INTO hon.work_items (organization_id, school_id, work_type, status, subject_type, subject_id, payload, correlation_id)
      VALUES (c.organization_id, c.school_id, 'AI_' || (hon.hon_reply_limits(mode)->>'taskClass'), 'READY', 'HON_CONVERSATION_TURN', t.id, '{}',
        nullif(current_setting('app.hon_request_id', true), '')::uuid)
      RETURNING id INTO wid;
      INSERT INTO hon.hon_reply_invocations (organization_id, school_id, conversation_id, turn_id, requested_by, work_item_id, reply_mode, step, continues_turn_id)
      VALUES (c.organization_id, c.school_id, c.id, t.id, actor, wid, mode, step, prior.turn_id);
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

-- The groups of one of this human's own conversations: each confirmed member's turn status as the thread shows it.
CREATE FUNCTION hon.read_hon_orchestrations(p_subject text, p_conversation uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); c hon.hon_conversations%ROWTYPE; items jsonb;
BEGIN
  SELECT * INTO c FROM hon.hon_conversations WHERE id = p_conversation AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND owner_principal_id = actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('sourceTurnId', g.source_turn_id, 'status', hon.hon_orchestration_status(g.statuses), 'members', g.members)
      ORDER BY g.seq), '[]'::jsonb) INTO items
  FROM (
    SELECT o.source_turn_id, s.seq, array_agg(v.v->>'status' ORDER BY t.seq) statuses,
      jsonb_agg(jsonb_build_object('agentKey', m.agent_key, 'turnId', t.id, 'status', v.v->>'status') ORDER BY t.seq) members
    FROM hon.hon_orchestrations o
    JOIN hon.hon_conversation_turns s ON s.id = o.source_turn_id
    JOIN hon.hon_orchestration_members m ON m.orchestration_id = o.id
    JOIN hon.hon_conversation_turns t ON t.id = m.turn_id
    CROSS JOIN LATERAL (SELECT hon.hon_turn_view(t) v) v
    WHERE o.conversation_id = c.id AND o.organization_id = c.organization_id AND o.school_id = c.school_id AND o.requested_by = actor
    GROUP BY o.source_turn_id, s.seq) g;
  RETURN jsonb_build_object('items', items);
END $$;

DO $$
DECLARE v_role text; f text;
BEGIN
  REVOKE ALL ON TABLE hon.hon_orchestrations, hon.hon_orchestration_members FROM PUBLIC;
  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.hon_orchestrations, hon.hon_orchestration_members FROM %I', v_role);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon_orchestration_immutable()', 'hon_orchestration_status(text[])', 'read_hon_orchestrations(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.' || f || ' FROM PUBLIC';
    FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.' || f || ' FROM ' || quote_ident(v_role);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_hon_orchestrations(text, uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
