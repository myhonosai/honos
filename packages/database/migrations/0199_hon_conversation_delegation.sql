BEGIN;

-- C1 HON conversation delegation (owner direction 2026-11-02 07:56Z: prepare the real AI team with agent delegation,
-- human approvals and school-specific authorized context, using existing HON OS contracts and authorization boundaries,
-- without competing AI systems or simulated success). Proposed migration number 0199 (after AI-R1 0198); the owner
-- allocates the final number.
--
-- A conversation belongs to one human at one school. Each human turn names exactly one live specialist (Marcus,
-- Claire or Chad) and that specialist's own typed target; the API hands the turn to the specialist's existing service
-- with the turn id as its idempotency key. Everything that matters stays where it already is: the specialist's own
-- actor gate, the S4 access decision, budget lock, plan, provider call, usage evidence and the Action Engine CONFIRM
-- proposal. This migration only stores the conversation and the turn, and reads the specialist's live state back by
-- (school, requester, idempotency key = turn id), so the browser can never bind a turn to someone else's work.
-- HON writes no text of its own here: there is no HON orchestration model in this slice, so a turn without a named
-- specialist is refused rather than answered with a made-up reply. Nothing is executed without human approval.
--
-- Tables are forced-RLS with no policies and no grants: the runtime reaches them only through these functions.

CREATE TABLE hon.hon_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL REFERENCES hon.principals(id), title text NOT NULL,
  idempotency_key uuid NOT NULL, request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  turn_count integer NOT NULL DEFAULT 0 CHECK (turn_count BETWEEN 0 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id),
  CHECK (hon.marketing_safe_text(title, 120)),
  UNIQUE (id, organization_id, school_id), UNIQUE (organization_id, school_id, owner_principal_id, idempotency_key)
);
CREATE INDEX hon_conversations_owner_recent_idx ON hon.hon_conversations (organization_id, school_id, owner_principal_id, updated_at DESC, id DESC);

CREATE TABLE hon.hon_conversation_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
  conversation_id uuid NOT NULL, requested_by uuid NOT NULL REFERENCES hon.principals(id), seq integer NOT NULL CHECK (seq BETWEEN 1 AND 200),
  text text NOT NULL, agent_key text NOT NULL CHECK (agent_key IN ('marcus', 'claire', 'chad')), delegation jsonb NOT NULL,
  idempotency_key uuid NOT NULL, request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  failure_reason text CHECK (failure_reason IN ('AGENT_NOT_AUTHORIZED', 'AGENT_REQUEST_INVALID', 'AGENT_TARGET_NOT_FOUND', 'AGENT_REQUEST_CONFLICT')),
  failed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, organization_id, school_id) REFERENCES hon.hon_conversations(id, organization_id, school_id),
  CHECK (hon.marketing_safe_text(text, 2000)), CHECK (jsonb_typeof(delegation) = 'object'),
  CHECK ((failure_reason IS NULL) = (failed_at IS NULL)),
  UNIQUE (conversation_id, seq), UNIQUE (conversation_id, idempotency_key)
);

ALTER TABLE hon.hon_conversations ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.hon_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.hon_conversation_turns ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.hon_conversation_turns FORCE ROW LEVEL SECURITY;

-- The requester must be the direct human of this transaction and hold AI planning at this exact school (the same
-- boundary as AI-R1 readiness). Each specialist's own gate still decides whether that specialist may act.
CREATE FUNCTION hon.hon_conversation_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  IF p_subject IS NULL OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
     OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
     OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
     OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
                    WHERE u.external_subject = p_subject AND p.id = actor AND p.is_active AND p.principal_type = 'HUMAN_USER')
     OR NOT hon.principal_has_school_permission(actor, hon.current_organization_id(), hon.current_school_id(), 'ai.invocation.plan') THEN
    RAISE EXCEPTION 'HON_CONVERSATION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END $$;

-- Live specialist state for one turn, found only by (school, requester, idempotency key = turn id).
CREATE FUNCTION hon.hon_turn_view(t hon.hon_conversation_turns) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE inv_id uuid; inv_status text; inv_reason text; work uuid; action uuid; updated timestamptz; status text; reason text;
BEGIN
  IF t.agent_key = 'marcus' THEN
    SELECT id, i.status, i.reason, work_item_id, action_request_id, updated_at INTO inv_id, inv_status, inv_reason, work, action, updated
    FROM hon.marketing_ai_invocations i WHERE organization_id = t.organization_id AND school_id = t.school_id AND requested_by = t.requested_by AND idempotency_key = t.id;
  ELSIF t.agent_key = 'claire' THEN
    SELECT id, i.status, i.reason, work_item_id, action_request_id, updated_at INTO inv_id, inv_status, inv_reason, work, action, updated
    FROM hon.teaching_ai_invocations i WHERE organization_id = t.organization_id AND school_id = t.school_id AND requested_by = t.requested_by AND idempotency_key = t.id;
  ELSE
    SELECT id, i.status, i.reason, work_item_id, action_request_id, updated_at INTO inv_id, inv_status, inv_reason, work, action, updated
    FROM hon.chad_follow_up_invocations i WHERE organization_id = t.organization_id AND school_id = t.school_id AND requested_by = t.requested_by AND idempotency_key = t.id;
  END IF;
  IF inv_id IS NULL THEN
    -- Not yet handed over (or the hand-over never started): a recorded refusal is FAILED; a hand-over that did not
    -- finish within five minutes is UNKNOWN (resending with the same Idempotency-Key resumes it); otherwise PROCESSING.
    status := CASE WHEN t.failure_reason IS NOT NULL THEN 'FAILED' WHEN t.created_at <= clock_timestamp() - interval '5 minutes' THEN 'UNKNOWN' ELSE 'PROCESSING' END;
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
  RETURN jsonb_build_object('turnId', t.id, 'conversationId', t.conversation_id, 'agentKey', t.agent_key, 'status', status, 'reason', reason,
    'invocationId', inv_id, 'workItemId', work, 'actionRequestId', action);
END $$;

CREATE FUNCTION hon.hon_conversation_summary(c hon.hon_conversations) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id', c.id, 'title', c.title, 'createdAt', hon.saas_ts(c.created_at), 'updatedAt', hon.saas_ts(c.updated_at),
    'turnCount', c.turn_count,
    'status', coalesce((SELECT hon.hon_turn_view(t)->>'status' FROM hon.hon_conversation_turns t WHERE t.conversation_id = c.id ORDER BY t.seq DESC LIMIT 1), 'READY'));
$$;

CREATE FUNCTION hon.begin_hon_conversation(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); org uuid := hon.current_organization_id(); school uuid := hon.current_school_id();
  c hon.hon_conversations%ROWTYPE; fingerprint text;
BEGIN
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k <> 'title')
     OR jsonb_typeof(p_input->'title') IS DISTINCT FROM 'string' OR NOT hon.marketing_safe_text(p_input->>'title', 120) THEN
    RAISE EXCEPTION 'INVALID_HON_CONVERSATION' USING ERRCODE = '22023';
  END IF;
  fingerprint := encode(sha256(convert_to(p_input::text, 'UTF8')), 'hex');
  SELECT * INTO c FROM hon.hon_conversations WHERE organization_id = org AND school_id = school AND owner_principal_id = actor AND idempotency_key = p_key FOR UPDATE;
  IF FOUND THEN
    IF c.request_hash <> fingerprint THEN RAISE EXCEPTION 'HON_CONVERSATION_REPLAY_SWAP' USING ERRCODE = '23505'; END IF;
    RETURN hon.hon_conversation_summary(c);
  END IF;
  INSERT INTO hon.hon_conversations (organization_id, school_id, owner_principal_id, title, idempotency_key, request_hash)
  VALUES (org, school, actor, btrim(p_input->>'title'), p_key, fingerprint) RETURNING * INTO c;
  RETURN hon.hon_conversation_summary(c);
END $$;

-- Newest first; keyset cursor (updatedAt, id). Only the requester's own conversations at this school.
CREATE FUNCTION hon.list_my_hon_conversations(p_subject text, p_before_updated timestamptz, p_before_id uuid, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); items jsonb; more boolean; last_updated timestamptz; last_id uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR ((p_before_updated IS NULL) <> (p_before_id IS NULL)) THEN
    RAISE EXCEPTION 'INVALID_HON_CONVERSATION_PAGE' USING ERRCODE = '22023';
  END IF;
  WITH page AS (
    SELECT c FROM hon.hon_conversations c
    WHERE c.organization_id = hon.current_organization_id() AND c.school_id = hon.current_school_id() AND c.owner_principal_id = actor
      AND (p_before_updated IS NULL OR (c.updated_at, c.id) < (p_before_updated, p_before_id))
    ORDER BY c.updated_at DESC, c.id DESC LIMIT p_limit + 1
  ), numbered AS (SELECT c, row_number() OVER (ORDER BY (c).updated_at DESC, (c).id DESC) n FROM page)
  SELECT coalesce(jsonb_agg(hon.hon_conversation_summary(c) ORDER BY n) FILTER (WHERE n <= p_limit), '[]'::jsonb),
         count(*) > p_limit, max((c).updated_at) FILTER (WHERE n = p_limit), (array_agg((c).id) FILTER (WHERE n = p_limit))[1]
  INTO items, more, last_updated, last_id FROM numbered;
  RETURN jsonb_build_object('items', items, 'next', CASE WHEN more THEN jsonb_build_object('beforeUpdatedAt', to_char(last_updated AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'beforeId', last_id) END);
END $$;

CREATE FUNCTION hon.read_hon_conversation(p_subject text, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); c hon.hon_conversations%ROWTYPE; turns jsonb;
BEGIN
  SELECT * INTO c FROM hon.hon_conversations WHERE id = p_id AND organization_id = hon.current_organization_id() AND school_id = hon.current_school_id() AND owner_principal_id = actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- Each human turn is followed by the named specialist's turn. Specialist text is never copied here: the draft stays
  -- behind the specialist's own read and Action Center, which re-check that specialist's permission.
  SELECT coalesce(jsonb_agg(x ORDER BY t.seq, x->>'role' <> 'HUMAN'), '[]'::jsonb) INTO turns
  FROM hon.hon_conversation_turns t CROSS JOIN LATERAL (SELECT hon.hon_turn_view(t) v) v
  CROSS JOIN LATERAL (VALUES
    (jsonb_build_object('turnId', t.id, 'role', 'HUMAN', 'text', t.text, 'createdAt', hon.saas_ts(t.created_at), 'status', v.v->>'status',
       'reason', NULL, 'references', jsonb_build_object('workItemId', NULL, 'actionRequestId', NULL, 'invocationId', NULL))),
    (jsonb_build_object('turnId', t.id, 'role', t.agent_key, 'text', NULL, 'createdAt', hon.saas_ts(t.created_at), 'status', v.v->>'status',
       'reason', v.v->>'reason', 'references', jsonb_build_object('workItemId', v.v->'workItemId', 'actionRequestId', v.v->'actionRequestId', 'invocationId', v.v->'invocationId')))
  ) AS r(x)
  WHERE t.conversation_id = c.id;
  RETURN hon.hon_conversation_summary(c) || jsonb_build_object('turns', turns);
END $$;

-- Records the human turn (idempotent per conversation + key) and returns what the API must hand to the specialist.
CREATE FUNCTION hon.begin_hon_turn(p_subject text, p_conversation uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); c hon.hon_conversations%ROWTYPE; t hon.hon_conversation_turns%ROWTYPE;
  fingerprint text; d jsonb; agent text; target jsonb; v jsonb;
BEGIN
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR NOT p_input ?& ARRAY['text', 'delegation']
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('text', 'delegation'))
     OR jsonb_typeof(p_input->'text') IS DISTINCT FROM 'string' OR NOT hon.marketing_safe_text(p_input->>'text', 2000)
     OR jsonb_typeof(p_input->'delegation') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_HON_TURN' USING ERRCODE = '22023';
  END IF;
  d := p_input->'delegation'; agent := d->>'agentKey';
  -- Each specialist's own typed target only; the specialist re-validates and re-authorizes it.
  IF agent = 'marcus' AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN ('agentKey', 'campaignId')) AND jsonb_typeof(d->'campaignId') = 'string'
     AND (d->>'campaignId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    target := jsonb_build_object('campaignId', lower(d->>'campaignId'), 'request', p_input->>'text');
  ELSIF agent = 'claire' AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN ('agentKey', 'curriculumId')) AND jsonb_typeof(d->'curriculumId') = 'string'
     AND (d->>'curriculumId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND length(btrim(p_input->>'text')) <= 1200 THEN
    target := jsonb_build_object('curriculumId', lower(d->>'curriculumId'), 'brief', p_input->>'text');
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
  SELECT * INTO t FROM hon.hon_conversation_turns WHERE conversation_id = c.id AND idempotency_key = p_key;
  IF FOUND THEN
    IF t.request_hash <> fingerprint THEN RAISE EXCEPTION 'HON_TURN_REPLAY_SWAP' USING ERRCODE = '23505'; END IF;
  ELSE
    IF c.turn_count >= 200 THEN RAISE EXCEPTION 'HON_CONVERSATION_FULL' USING ERRCODE = '23514'; END IF;
    INSERT INTO hon.hon_conversation_turns (organization_id, school_id, conversation_id, requested_by, seq, text, agent_key, delegation, idempotency_key, request_hash)
    VALUES (c.organization_id, c.school_id, c.id, actor, c.turn_count + 1, btrim(p_input->>'text'), agent, target, p_key, fingerprint) RETURNING * INTO t;
    UPDATE hon.hon_conversations SET turn_count = turn_count + 1, updated_at = clock_timestamp() WHERE id = c.id;
  END IF;
  v := hon.hon_turn_view(t);
  RETURN jsonb_build_object('turnId', t.id, 'agentKey', t.agent_key, 'delegation', t.delegation,
    'handOff', t.failure_reason IS NULL AND v->>'invocationId' IS NULL);
END $$;

-- A refusal before the specialist recorded anything. Ignored once the specialist has its own record (its state wins).
CREATE FUNCTION hon.fail_hon_turn(p_subject text, p_turn uuid, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); t hon.hon_conversation_turns%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('AGENT_NOT_AUTHORIZED', 'AGENT_REQUEST_INVALID', 'AGENT_TARGET_NOT_FOUND', 'AGENT_REQUEST_CONFLICT') THEN
    RAISE EXCEPTION 'INVALID_HON_TURN_FAILURE' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO t FROM hon.hon_conversation_turns WHERE id = p_turn AND organization_id = hon.current_organization_id() AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_TURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF t.failure_reason IS NULL AND hon.hon_turn_view(t)->>'invocationId' IS NULL THEN
    UPDATE hon.hon_conversation_turns SET failure_reason = p_reason, failed_at = clock_timestamp() WHERE id = t.id;
  END IF;
END $$;

CREATE FUNCTION hon.read_hon_turn_receipt(p_subject text, p_turn uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); t hon.hon_conversation_turns%ROWTYPE; v jsonb;
BEGIN
  SELECT * INTO t FROM hon.hon_conversation_turns WHERE id = p_turn AND organization_id = hon.current_organization_id() AND school_id = hon.current_school_id() AND requested_by = actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_TURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v := hon.hon_turn_view(t);
  RETURN jsonb_build_object('turnId', t.id, 'conversationId', t.conversation_id, 'status', v->>'status', 'reason', v->'reason',
    'delegatedAgentKeys', jsonb_build_array(t.agent_key),
    'actionRequestIds', CASE WHEN v->>'actionRequestId' IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v->'actionRequestId') END,
    'workItemIds', CASE WHEN v->>'workItemId' IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v->'workItemId') END,
    'invocationId', v->'invocationId');
END $$;

DO $$ DECLARE f regprocedure; r text; BEGIN
  REVOKE ALL ON hon.hon_conversations, hon.hon_conversation_turns FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON hon.hon_conversations, hon.hon_conversation_turns FROM %I', r);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.hon_conversation_actor(text)'::regprocedure, 'hon.hon_turn_view(hon.hon_conversation_turns)'::regprocedure,
      'hon.hon_conversation_summary(hon.hon_conversations)'::regprocedure, 'hon.begin_hon_conversation(text,jsonb,uuid)'::regprocedure,
      'hon.list_my_hon_conversations(text,timestamptz,uuid,integer)'::regprocedure, 'hon.read_hon_conversation(text,uuid)'::regprocedure,
      'hon.begin_hon_turn(text,uuid,jsonb,uuid)'::regprocedure, 'hon.fail_hon_turn(text,uuid,text)'::regprocedure,
      'hon.read_hon_turn_receipt(text,uuid)'::regprocedure] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_hon_conversation(text,jsonb,uuid), hon.list_my_hon_conversations(text,timestamptz,uuid,integer),
      hon.read_hon_conversation(text,uuid), hon.begin_hon_turn(text,uuid,jsonb,uuid), hon.fail_hon_turn(text,uuid,text),
      hon.read_hon_turn_receipt(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
