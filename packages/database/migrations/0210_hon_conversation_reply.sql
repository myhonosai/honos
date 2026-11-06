BEGIN;

-- C2 "Ask HON": a provider-backed conversational reply inside the C1 HON conversation (owner directive 2026-11-06
-- 08:51Z "Continue Building Until AI Is Functional", Sprint 4A items 3-8). Proposed migration number 0210; the owner
-- allocates the final number. Built and proven with injected test providers only. Nothing here activates a provider:
-- a real call still needs OPENROUTER_API_KEY, OPENROUTER_PAID_CALL_APPROVED=true, an HQ routing policy with a HEALTHY
-- connection, an active Complete entitlement and room under the organization AI ceiling.
--
-- What changes:
-- 1. A turn may now be a question to HON ({ text, delegation: null }) instead of a delegation to Marcus, Claire or
--    Chad. C1 delegations are unchanged.
-- 2. A question creates one durable hon_reply_invocations row in the same transaction as the turn (turn id is its key),
--    planned as agent 'hon', task class ANALYZE (already approved, risk MODERATE), with fixed budgets
--    8000 input / 800 output tokens / 80,000 provider-cost microunits.
-- 3. The context HON receives is built here, never taken from the request: the school's existing aggregate
--    Command Center metrics (hon.read_school_command_center, which re-checks the human, the exact school, live
--    reporting.view and the entitlement itself; without reporting.view HON is told the facts are NOT_AUTHORIZED) and
--    at most the three previous turns of this same conversation (the human's text trimmed to 400 characters, HON's own
--    completed reply trimmed to 600, or the name of the specialist a turn was delegated to). No names, contact details,
--    family, student or payment rows, and no free-text CRM notes.
-- 4. The reply is text only. HON can describe and recommend; nothing it says is executed. Consequential work still
--    goes through a specialist delegation and an Action Center CONFIRM approval.
-- 5. S4 coverage: the same spend start/reserve guards (access decision, HQ pause, budget lock), immutable hold origin,
--    organization committed credits, UNKNOWN resolution (agent HON_REPLY), late provider expense, HQ per-school usage
--    and AI team readiness now include the HON reply. Usage evidence is recorded before the reply is shown; a reply
--    whose access lapsed mid-flight is recorded and held, and shown only after access returns.
--
-- Tables stay forced-RLS with no policies and no grants: the runtime reaches them only through these functions.

-- ---- Planning registers the conversational agent key 'hon' (no new task class) ----
ALTER TABLE hon.ai_invocation_plans DROP CONSTRAINT ai_invocation_plans_agent_key_check;
ALTER TABLE hon.ai_invocation_plans ADD CONSTRAINT ai_invocation_plans_agent_key_check
  CHECK (agent_key IN ('alex','chad','maya','marcus','jordan','claire','lena','eian','hon'));

-- ---- A turn may be a question to HON ----
ALTER TABLE hon.hon_conversation_turns DROP CONSTRAINT hon_conversation_turns_agent_key_check;
ALTER TABLE hon.hon_conversation_turns ADD CONSTRAINT hon_conversation_turns_agent_key_check
  CHECK (agent_key IN ('marcus', 'claire', 'chad', 'hon'));

CREATE TABLE hon.hon_reply_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
  conversation_id uuid NOT NULL, turn_id uuid NOT NULL UNIQUE REFERENCES hon.hon_conversation_turns(id),
  requested_by uuid NOT NULL REFERENCES hon.principals(id), work_item_id uuid NOT NULL UNIQUE REFERENCES hon.work_items(id),
  plan_id uuid REFERENCES hon.ai_invocation_plans(id),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED', 'SENDING', 'RESULT_HELD', 'COMPLETED', 'FAILED', 'UNKNOWN')),
  reason text CHECK (reason IS NULL OR reason ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  reserved_credits integer NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  held_at timestamptz,
  usage_id uuid UNIQUE REFERENCES hon.ai_usage_ledger(id),
  provider_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  context_digest text CHECK (context_digest IS NULL OR context_digest ~ '^[a-f0-9]{64}$'),
  reply_text text CHECK (reply_text IS NULL OR length(btrim(reply_text)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, organization_id, school_id) REFERENCES hon.hon_conversations(id, organization_id, school_id),
  CHECK ((reply_text IS NOT NULL) = (status IN ('RESULT_HELD', 'COMPLETED'))),
  CHECK (status <> 'SENDING' OR (plan_id IS NOT NULL AND reserved_credits > 0))
);
CREATE INDEX hon_reply_invocations_hold_idx ON hon.hon_reply_invocations (organization_id) WHERE reserved_credits > 0;
ALTER TABLE hon.hon_reply_invocations ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.hon_reply_invocations FORCE ROW LEVEL SECURITY;

-- The same S4 guards as the three specialists: access decision and HQ pause on start; access, budget lock and the
-- organization ceiling on every reservation increase; an immutable hold origin for window-scoped UNKNOWN counting.
CREATE TRIGGER ai_spend_start_guard BEFORE INSERT ON hon.hon_reply_invocations FOR EACH ROW EXECUTE FUNCTION hon.ai_spend_start_guard();
CREATE TRIGGER ai_spend_reserve_guard BEFORE UPDATE OF reserved_credits ON hon.hon_reply_invocations
  FOR EACH ROW WHEN (NEW.reserved_credits > OLD.reserved_credits) EXECUTE FUNCTION hon.ai_spend_reserve_guard();
CREATE TRIGGER ai_spend_reserve_guard_insert BEFORE INSERT ON hon.hon_reply_invocations
  FOR EACH ROW WHEN (NEW.reserved_credits > 0) EXECUTE FUNCTION hon.ai_spend_reserve_guard();
CREATE TRIGGER zz_ai_hold_origin BEFORE INSERT OR UPDATE ON hon.hon_reply_invocations FOR EACH ROW EXECUTE FUNCTION hon.ai_stamp_hold_origin();

-- Fixed reply budgets: the plan must carry exactly these (a swapped plan is refused).
CREATE FUNCTION hon.hon_reply_limits() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('inputBudget', 8000, 'outputBudget', 800, 'maxProviderCostMicrounits', 80000);
$$;

-- True when this transaction's direct human may still spend on a HON reply at this exact school: the conversation
-- actor (ai.invocation.plan here) plus the AI planning access gate (active school and organization, Complete).
CREATE FUNCTION hon.hon_reply_access(p_subject text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.hon_conversation_actor(p_subject);
  PERFORM hon.require_ai_invocation_plan_access();
  RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;

-- What the API needs to plan a pending reply. NULL once the reply has left PENDING (a resend never plans again).
CREATE FUNCTION hon.hon_reply_planning_reference(p_subject text, p_turn uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); i hon.hon_reply_invocations%ROWTYPE; v integer;
BEGIN
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF i.status <> 'PENDING' THEN RETURN NULL; END IF;
  SELECT version INTO v FROM hon.work_items WHERE id = i.work_item_id;
  RETURN jsonb_build_object('invocationId', i.id, 'workItemId', i.work_item_id, 'workVersion', v);
END $$;

-- Moves a pending reply to SENDING (with its reservation) or records why it cannot be sent, then returns the provider
-- input. The organization budget lock is taken first, as in every S4 prepare. Order of refusals: access, S4 spend
-- decision (HQ pause, exception, access state), plan, provider readiness, organization ceiling. A refusal reserves
-- nothing and never calls a provider.
CREATE FUNCTION hon.prepare_hon_reply(p_subject text, p_turn uuid, p_plan uuid, p_ready boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id());
  actor uuid := hon.hon_conversation_actor(p_subject); lim jsonb := hon.hon_reply_limits();
  i hon.hon_reply_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE; t hon.hon_conversation_turns%ROWTYPE;
  why text; school_facts jsonb; history jsonb; facts jsonb;
BEGIN
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF i.status <> 'PENDING' THEN RETURN NULL; END IF;
  -- The row lock can wait behind a concurrent resend: conversation authority is held and checked again first.
  PERFORM hon.hon_conversation_hold_actor(p_subject, actor);
  IF NOT hon.hon_reply_access(p_subject) THEN why := 'AI_ACCESS_REFUSED'; END IF;
  IF why IS NULL THEN why := hon.ai_spend_allowed(i.organization_id, clock_timestamp(), 'AGENT_INFERENCE'); END IF;
  IF why IS NULL THEN
    IF p_plan IS NULL THEN why := 'NO_ELIGIBLE_ROUTE';
    ELSE
      SELECT * INTO p FROM hon.ai_invocation_plans WHERE id = p_plan AND organization_id = i.organization_id AND school_id = i.school_id
        AND work_item_id = i.work_item_id AND agent_key = 'hon' AND task_class = 'ANALYZE' AND input_budget = (lim->>'inputBudget')::integer
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
  IF hon.principal_has_school_permission(actor, i.organization_id, i.school_id, 'reporting.view') THEN
    BEGIN
      school_facts := hon.read_school_command_center(p_subject, i.organization_id, i.school_id)->'metrics';
    EXCEPTION WHEN insufficient_privilege THEN school_facts := NULL;
    END;
  END IF;
  SELECT * INTO STRICT t FROM hon.hon_conversation_turns WHERE id = i.turn_id;
  SELECT coalesce(jsonb_agg(z.h ORDER BY z.seq), '[]'::jsonb) INTO history FROM (
    SELECT x.seq, jsonb_strip_nulls(jsonb_build_object('question', left(x.text, 400),
        'answer', CASE WHEN x.agent_key = 'hon' THEN left(r.reply_text, 600) END,
      -- Owner blueprint: the legacy 'claire' teaching delegate is Kai; HON never sees it as Claire.
        'delegatedTo', CASE WHEN x.agent_key = 'claire' THEN 'kai' WHEN x.agent_key <> 'hon' THEN x.agent_key END)) h
    FROM hon.hon_conversation_turns x
    LEFT JOIN hon.hon_reply_invocations r ON r.turn_id = x.id AND r.status = 'COMPLETED'
    WHERE x.conversation_id = t.conversation_id AND x.seq < t.seq
    ORDER BY x.seq DESC LIMIT 3) z;
  facts := jsonb_build_object('school', coalesce(school_facts, jsonb_build_object('availability', 'NOT_AUTHORIZED')), 'history', history);
  UPDATE hon.hon_reply_invocations SET context_digest = encode(sha256(convert_to(jsonb_build_object('question', t.text, 'facts', facts)::text, 'UTF8')), 'hex')
  WHERE id = i.id;
  RETURN jsonb_build_object('providerId', p.provider_id, 'modelId', p.model_id, 'providerRequestId', i.provider_request_id,
    'question', t.text, 'facts', facts::text, 'inputBudget', p.input_budget, 'outputBudget', p.output_budget,
    'maxCostMicrounits', p.max_provider_cost_microunits);
END $$;

-- A provider outcome without a result. PRE_SEND and FAILED release the hold; UNKNOWN keeps it for the HQ queue (S4-d).
CREATE FUNCTION hon.fail_hon_reply(p_subject text, p_turn uuid, p_outcome text, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); i hon.hon_reply_invocations%ROWTYPE;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('PRE_SEND', 'FAILED', 'UNKNOWN')
     OR p_reason IS NULL OR p_reason NOT IN ('CONFIGURATION_REQUIRED', 'UNSUPPORTED_PROVIDER', 'INVALID_REQUEST', 'PROVIDER_REJECTED', 'PROVIDER_UNKNOWN') THEN
    RAISE EXCEPTION 'INVALID_HON_REPLY_OUTCOME' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND OR i.status <> 'SENDING' THEN RAISE EXCEPTION 'HON_REPLY_OUTCOME_REPLAY' USING ERRCODE = '40001'; END IF;
  UPDATE hon.hon_reply_invocations SET status = CASE WHEN p_outcome = 'PRE_SEND' THEN 'CONFIGURATION_REQUIRED' ELSE p_outcome END,
    reason = p_reason, reserved_credits = CASE WHEN p_outcome = 'UNKNOWN' THEN reserved_credits ELSE 0 END, updated_at = clock_timestamp()
  WHERE id = i.id;
  UPDATE hon.work_items SET status = 'NEEDS_ATTENTION', version = version + 1, updated_at = clock_timestamp() WHERE id = i.work_item_id;
END $$;

-- S4-a for the reply: evidence-only actor (succeeds after a mid-flight lapse); exactly one ledger row per call; the
-- hold is released; the reply is shown only while access holds, otherwise it is recorded and held. A result above
-- the plan's budgets or the reservation is recorded (the provider charged it) but never shown.
CREATE FUNCTION hon.record_hon_reply_result(p_subject text, p_turn uuid, p_result jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); i hon.hon_reply_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE;
  uid uuid; credits integer; over boolean; reply text; outcome text;
BEGIN
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND OR i.status <> 'SENDING' OR i.usage_id IS NOT NULL THEN RAISE EXCEPTION 'HON_REPLY_OUTCOME_REPLAY' USING ERRCODE = '40001'; END IF;
  SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id = i.plan_id;
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' OR NOT p_result ?& ARRAY['reply', 'inputTokens', 'outputTokens', 'providerCostMicrounits']
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('reply', 'inputTokens', 'outputTokens', 'providerCostMicrounits'))
     OR jsonb_typeof(p_result->'reply') <> 'string' OR length(btrim(p_result->>'reply')) NOT BETWEEN 1 AND 4000
     OR jsonb_typeof(p_result->'inputTokens') <> 'number' OR (p_result->>'inputTokens') !~ '^[1-9][0-9]{0,6}$'
     OR jsonb_typeof(p_result->'outputTokens') <> 'number' OR (p_result->>'outputTokens') !~ '^[1-9][0-9]{0,6}$'
     OR jsonb_typeof(p_result->'providerCostMicrounits') <> 'number' OR (p_result->>'providerCostMicrounits') !~ '^(0|[1-9][0-9]{0,9})$' THEN
    RAISE EXCEPTION 'INVALID_HON_REPLY_RESULT' USING ERRCODE = '22023';
  END IF;
  reply := btrim(p_result->>'reply');
  credits := ((p_result->>'inputTokens')::integer + (p_result->>'outputTokens')::integer + 999) / 1000;
  over := (p_result->>'inputTokens')::integer > p.input_budget OR (p_result->>'outputTokens')::integer > p.output_budget
    OR (p_result->>'providerCostMicrounits')::bigint > p.max_provider_cost_microunits OR credits > i.reserved_credits;
  INSERT INTO hon.ai_usage_ledger(organization_id, school_id, initiator_principal_id, work_item_id, provider_code, model_code, modality,
      input_units, output_units, provider_cost_microunits, customer_credits, correlation_id, source_invocation_id, spend_class)
    VALUES (i.organization_id, i.school_id, actor, i.work_item_id, p.provider_id, p.model_id, 'TEXT',
      (p_result->>'inputTokens')::bigint, (p_result->>'outputTokens')::bigint, (p_result->>'providerCostMicrounits')::bigint, credits,
      nullif(current_setting('app.hon_request_id', true), '')::uuid, i.id, 'AGENT_INFERENCE')
    RETURNING id INTO uid;
  outcome := CASE WHEN over THEN 'FAILED' WHEN hon.hon_reply_access(p_subject) THEN 'COMPLETED' ELSE 'RESULT_HELD' END;
  UPDATE hon.hon_reply_invocations SET usage_id = uid, reserved_credits = 0, status = outcome,
    reason = CASE outcome WHEN 'FAILED' THEN 'RESULT_BUDGET_EXCEEDED' WHEN 'RESULT_HELD' THEN 'ACCESS_LAPSED' END,
    reply_text = CASE WHEN outcome = 'FAILED' THEN NULL ELSE reply END, updated_at = clock_timestamp()
  WHERE id = i.id;
  UPDATE hon.work_items SET status = CASE outcome WHEN 'COMPLETED' THEN 'COMPLETED' ELSE 'NEEDS_ATTENTION' END, version = version + 1, updated_at = clock_timestamp()
  WHERE id = i.work_item_id;
  RETURN outcome;
END $$;

-- A held reply becomes visible once access has returned. Never calls a provider and writes no usage.
CREATE FUNCTION hon.release_held_hon_reply(p_subject text, p_turn uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); i hon.hon_reply_invocations%ROWTYPE;
BEGIN
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF i.status <> 'RESULT_HELD' THEN RETURN false; END IF;
  PERFORM hon.hon_conversation_hold_actor(p_subject, actor);
  IF NOT hon.hon_reply_access(p_subject) THEN RETURN false; END IF;
  UPDATE hon.hon_reply_invocations SET status = 'COMPLETED', reason = NULL, updated_at = clock_timestamp() WHERE id = i.id;
  UPDATE hon.work_items SET status = 'COMPLETED', version = version + 1, updated_at = clock_timestamp() WHERE id = i.work_item_id;
  RETURN true;
END $$;

-- ---- S4 enumerations now include the HON reply (agent HON_REPLY) ----
ALTER TABLE hon.ai_unknown_resolutions DROP CONSTRAINT ai_unknown_resolutions_agent_check;
ALTER TABLE hon.ai_unknown_resolutions ADD CONSTRAINT ai_unknown_resolutions_agent_check CHECK (agent IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY'));
ALTER TABLE hon.ai_late_provider_expenses DROP CONSTRAINT ai_late_provider_expenses_agent_check;
ALTER TABLE hon.ai_late_provider_expenses ADD CONSTRAINT ai_late_provider_expenses_agent_check CHECK (agent IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY'));

-- Planning metadata accepts the conversational agent key (budgets and task classes unchanged).
CREATE OR REPLACE FUNCTION hon.validate_ai_invocation_plan_input(p_data jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE keys text[]:=ARRAY['expectedVersion','expectedState','agentKey','modality','taskClass','inputBudget','outputBudget','maxProviderCostMicrounits']; f text;
BEGIN
 IF p_data IS NULL OR jsonb_typeof(p_data)<>'object' OR NOT p_data ?& keys OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k<>ALL(keys)) THEN RAISE EXCEPTION 'Invalid AI planning metadata shape' USING ERRCODE='22023'; END IF;
 FOREACH f IN ARRAY ARRAY['expectedVersion','inputBudget','outputBudget','maxProviderCostMicrounits'] LOOP IF jsonb_typeof(p_data->f)<>'number' OR p_data->>f !~ '^[0-9]+$' OR (p_data->>f)::numeric>2147483646 THEN RAISE EXCEPTION 'Invalid AI planning integer' USING ERRCODE='22023'; END IF; END LOOP;
 IF (p_data->>'expectedVersion')::integer<1 OR (p_data->>'inputBudget')::integer NOT BETWEEN 1 AND 128000 OR (p_data->>'outputBudget')::integer NOT BETWEEN 1 AND 16000 OR (p_data->>'maxProviderCostMicrounits')::integer NOT BETWEEN 0 AND 1000000 THEN RAISE EXCEPTION 'AI planning budget or version out of range' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_data->'expectedState')<>'string' OR jsonb_typeof(p_data->'agentKey')<>'string' OR jsonb_typeof(p_data->'modality')<>'string' OR jsonb_typeof(p_data->'taskClass')<>'string' OR p_data->>'expectedState' NOT IN('READY','THINKING') OR p_data->>'agentKey' NOT IN('alex','chad','maya','marcus','jordan','claire','lena','eian','hon') OR p_data->>'modality'<>'TEXT' OR p_data->>'taskClass' NOT IN('SUMMARIZE','ANALYZE','DRAFT_MARKETING','DRAFT_TEACHING','DRAFT_FOLLOW_UP') THEN RAISE EXCEPTION 'Unregistered AI planning metadata' USING ERRCODE='22023'; END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.ai_org_committed_credits(p_org uuid, p_at timestamptz) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  -- Agent-inference ledger credits in the window plus every agent hold that counts (hon.ai_hold_counts), across all
  -- four agent callers (three specialists and the HON reply) and all schools of the organization. Callers hold ai.budget:<org> (hon.ai_budget_lock) and evaluate
  -- this in a statement that starts after the lock (READ COMMITTED), so every earlier committed hold is visible.
  -- A hold's time is its immutable held_at (stamped when the hold was taken), never the mutable updated_at.
  WITH w AS (SELECT hon.ai_spend_window(p_org, p_at) AS r)
  SELECT (SELECT coalesce(sum(u.customer_credits),0) FROM hon.ai_usage_ledger u, w
           WHERE u.organization_id=p_org AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=lower(w.r) AND u.occurred_at<upper(w.r))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.marketing_ai_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.teaching_ai_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.chad_follow_up_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.hon_reply_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at));
$$;

CREATE OR REPLACE FUNCTION hon.ai_unknown_validate(p_agent text, p_input jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE e jsonb := p_input->'evidence'; d text := p_input->>'decision';
  nonneg CONSTANT text := '^(0|[1-9][0-9]{0,11})$'; ref CONSTANT text := '^[A-Za-z0-9._:-]{1,200}$';
BEGIN
  IF p_agent IS NULL OR p_agent NOT IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY') OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
     OR coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k), ARRAY[]::text[]) <> ARRAY['decision','evidence','reason']
     OR jsonb_typeof(p_input->'decision') <> 'string' OR d NOT IN ('RECORD_PROVIDER_COST','NO_PROVIDER_CHARGE','WRITE_OFF')
     OR jsonb_typeof(p_input->'reason') <> 'string' OR (p_input->>'reason') <> btrim(p_input->>'reason') OR length(p_input->>'reason') NOT BETWEEN 10 AND 500
     OR jsonb_typeof(e) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_AI_UNKNOWN_RESOLUTION' USING ERRCODE='22023';
  END IF;
  IF d = 'RECORD_PROVIDER_COST' AND NOT (
       coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k), ARRAY[]::text[]) = ARRAY['inputTokens','outputTokens','providerCostMicrounits','providerGenerationId']
       AND jsonb_typeof(e->'providerGenerationId') = 'string' AND (e->>'providerGenerationId') ~ ref
       AND jsonb_typeof(e->'inputTokens') = 'number' AND (e->>'inputTokens') ~ nonneg AND (e->>'inputTokens')::bigint <= 100000000
       AND jsonb_typeof(e->'outputTokens') = 'number' AND (e->>'outputTokens') ~ nonneg AND (e->>'outputTokens')::bigint <= 100000000
       AND jsonb_typeof(e->'providerCostMicrounits') = 'number' AND (e->>'providerCostMicrounits') ~ nonneg) THEN
    RAISE EXCEPTION 'INVALID_AI_UNKNOWN_RESOLUTION' USING ERRCODE='22023';
  END IF;
  IF d = 'NO_PROVIDER_CHARGE' AND NOT (
       coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k), ARRAY[]::text[]) = ARRAY['providerLookupReference']
       AND jsonb_typeof(e->'providerLookupReference') = 'string' AND (e->>'providerLookupReference') ~ ref) THEN
    RAISE EXCEPTION 'INVALID_AI_UNKNOWN_RESOLUTION' USING ERRCODE='22023';
  END IF;
  IF d = 'WRITE_OFF' AND NOT (
       coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k), ARRAY[]::text[]) = ARRAY['estimatedProviderCostMicrounits']
       AND jsonb_typeof(e->'estimatedProviderCostMicrounits') = 'number' AND (e->>'estimatedProviderCostMicrounits') ~ nonneg) THEN
    RAISE EXCEPTION 'INVALID_AI_UNKNOWN_RESOLUTION' USING ERRCODE='22023';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.resolve_ai_unknown_invocation(p_subject text, p_agent text, p_id uuid, p_input jsonb, p_key uuid, p_request_id uuid, p_correlation_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; tbl text; fp text; r hon.ai_unknown_resolutions%ROWTYPE; e jsonb; d text;
  v_org uuid; v_school uuid; v_requester uuid; v_work uuid; v_plan uuid; v_status text; v_reserved integer; v_usage uuid; v_held timestamptz;
  p hon.ai_invocation_plans%ROWTYPE; uid uuid; credits bigint; receipt jsonb;
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_id IS NULL OR p_key IS NULL OR p_request_id IS NULL OR p_correlation_id IS NULL THEN RAISE EXCEPTION 'INVALID_AI_UNKNOWN_RESOLUTION' USING ERRCODE='22023'; END IF;
  PERFORM hon.ai_unknown_validate(p_agent, p_input);
  d := p_input->>'decision'; e := p_input->'evidence';
  fp := encode(sha256(convert_to(jsonb_build_object('agent',p_agent,'id',p_id,'input',p_input,'by',actor)::text,'UTF8')),'hex');
  -- Authority holds through the mutation (the D9/0185 pattern): the shared lock stops any user, principal, HQ grant
  -- or family grant change until this transaction ends, and authority is checked again after every wait, so an owner
  -- revoked or expired while this command waited is refused before any replay, ledger, audit or outbox write.
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- Replays and concurrent attempts with one key resolve to one row.
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.unknown:' || p_key::text, 0));
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM hon.ai_unknown_resolutions WHERE resolution_key = p_key;
  IF FOUND THEN
    IF r.resolution_fingerprint <> fp THEN RAISE EXCEPTION 'AI_UNKNOWN_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN hon.ai_unknown_receipt(r, true);
  END IF;
  tbl := CASE p_agent WHEN 'MARKETING' THEN 'marketing_ai_invocations' WHEN 'TEACHING' THEN 'teaching_ai_invocations'
    WHEN 'CHAD_FOLLOW_UP' THEN 'chad_follow_up_invocations' WHEN 'HON_REPLY' THEN 'hon_reply_invocations' END;
  IF tbl IS NULL THEN RAISE EXCEPTION 'INVALID_AI_UNKNOWN_RESOLUTION' USING ERRCODE='22023'; END IF;
  -- The invocation row is the only row lock taken; no budget lock is needed because a resolution only releases holds.
  EXECUTE format('SELECT organization_id,school_id,requested_by,work_item_id,plan_id,status,reserved_credits,usage_id,held_at FROM hon.%I WHERE id=$1 FOR UPDATE', tbl)
    INTO v_org, v_school, v_requester, v_work, v_plan, v_status, v_reserved, v_usage, v_held USING p_id;
  -- The invocation row lock can wait behind a recording or another resolution: check authority again after it.
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'AI_UNKNOWN_INVOCATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_usage IS NOT NULL OR v_reserved IS NULL OR v_reserved <= 0 OR v_plan IS NULL OR v_status IS NULL OR v_status NOT IN ('UNKNOWN','SENDING') THEN
    RAISE EXCEPTION 'AI_UNKNOWN_NOT_RESOLVABLE' USING ERRCODE='23514';
  END IF;
  -- (Manus delta review P2) No trustworthy original hold time: fail closed for every decision and status. A missing
  -- held_at can prove neither staleness (a SENDING call may still be in flight) nor the window, and the UNKNOWN status of
  -- such a row may itself have been inferred from the mutable updated_at. The hold keeps counting (ai_hold_counts) and
  -- is never released here; no ledger row, resolution, audit or outbox row is written.
  IF v_held IS NULL THEN RAISE EXCEPTION 'AI_UNKNOWN_ORIGIN_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  -- A SENDING hold is resolvable only once its immutable origin proves it stale (never from updated_at).
  IF v_status = 'SENDING' AND NOT (v_held <= clock_timestamp() - hon.ai_sending_stale_after()) THEN
    RAISE EXCEPTION 'AI_UNKNOWN_NOT_RESOLVABLE' USING ERRCODE='23514';
  END IF;
  SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id = v_plan;
  IF d = 'RECORD_PROVIDER_COST' THEN
    credits := ((e->>'inputTokens')::bigint + (e->>'outputTokens')::bigint + 999) / 1000;
    INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,
        provider_cost_microunits,customer_credits,correlation_id,source_invocation_id,spend_class,occurred_at)
      VALUES (v_org,v_school,v_requester,v_work,p.provider_id,p.model_id,'TEXT',(e->>'inputTokens')::bigint,(e->>'outputTokens')::bigint,
        (e->>'providerCostMicrounits')::bigint,credits,p_correlation_id,p_id,'AGENT_INFERENCE',v_held)
      RETURNING id INTO uid;
  ELSIF d = 'WRITE_OFF' THEN
    INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,
        provider_cost_microunits,customer_credits,correlation_id,source_invocation_id,spend_class,occurred_at)
      VALUES (v_org,v_school,v_requester,v_work,p.provider_id,p.model_id,'TEXT',0,0,(e->>'estimatedProviderCostMicrounits')::bigint,0,p_correlation_id,p_id,'AGENT_INFERENCE',v_held)
      RETURNING id INTO uid;
  END IF;
  EXECUTE format('UPDATE hon.%I SET status=''UNKNOWN'',reason=''PROVIDER_UNKNOWN'',reserved_credits=0,usage_id=$2,updated_at=clock_timestamp() WHERE id=$1', tbl) USING p_id, uid;
  INSERT INTO hon.ai_unknown_resolutions(agent,invocation_id,organization_id,school_id,prior_status,held_at,released_credits,decision,reason,evidence,ledger_entry_id,
      resolution_key,resolution_fingerprint,resolved_by_principal_id)
    VALUES (p_agent,p_id,v_org,v_school,v_status,v_held,v_reserved,d,p_input->>'reason',e,uid,p_key,fp,actor) RETURNING * INTO r;
  receipt := hon.ai_unknown_receipt(r, false);
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
    VALUES (v_org, v_school, actor, 'HON_HQ', 'hq.ai.unknown_invocation.resolve', 'AI_INVOCATION', p_id,
      jsonb_build_object('agent',p_agent,'status',v_status,'reservedCredits',v_reserved,'heldAt',hon.saas_ts(v_held)), receipt - 'replayed', 'SUCCEEDED', p_request_id, p_correlation_id, now());
  -- Inert: no consumer exists for this event type. It is evidence for later reconciliation reporting.
  INSERT INTO hon.outbox_events (organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
    VALUES (v_org, v_school, 'ai.unknown_invocation.resolved', 1, 'AI_INVOCATION', p_id, 1, p_correlation_id, p_request_id, receipt - 'replayed');
  RETURN receipt;
END $$;

CREATE OR REPLACE FUNCTION hon.record_ai_late_provider_expense(p_subject text, p_agent text, p_id uuid, p_input jsonb, p_key uuid, p_request_id uuid, p_correlation_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; e jsonb := p_input->'evidence'; r hon.ai_unknown_resolutions%ROWTYPE; x hon.ai_late_provider_expenses%ROWTYPE;
  wl hon.ai_usage_ledger%ROWTYPE; receipt jsonb;
  nonneg CONSTANT text := '^(0|[1-9][0-9]{0,11})$'; ref CONSTANT text := '^[A-Za-z0-9._:-]{1,200}$';
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_id IS NULL OR p_key IS NULL OR p_request_id IS NULL OR p_correlation_id IS NULL OR p_agent IS NULL OR p_agent NOT IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY')
     OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
     OR coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k), ARRAY[]::text[]) <> ARRAY['evidence','reason']
     OR jsonb_typeof(p_input->'reason') <> 'string' OR (p_input->>'reason') <> btrim(p_input->>'reason') OR length(p_input->>'reason') NOT BETWEEN 10 AND 500
     OR jsonb_typeof(e) <> 'object'
     OR coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k), ARRAY[]::text[]) <> ARRAY['inputTokens','outputTokens','providerCostMicrounits','providerGenerationId']
     OR jsonb_typeof(e->'providerGenerationId') <> 'string' OR (e->>'providerGenerationId') !~ ref
     OR jsonb_typeof(e->'inputTokens') <> 'number' OR (e->>'inputTokens') !~ nonneg OR (e->>'inputTokens')::bigint > 100000000
     OR jsonb_typeof(e->'outputTokens') <> 'number' OR (e->>'outputTokens') !~ nonneg OR (e->>'outputTokens')::bigint > 100000000
     OR jsonb_typeof(e->'providerCostMicrounits') <> 'number' OR (e->>'providerCostMicrounits') !~ nonneg THEN
    RAISE EXCEPTION 'INVALID_AI_LATE_PROVIDER_EXPENSE' USING ERRCODE='22023';
  END IF;
  fp := encode(sha256(convert_to(jsonb_build_object('agent',p_agent,'id',p_id,'input',p_input,'by',actor)::text,'UTF8')),'hex');
  -- Same authority pattern as the resolution: shared lock on the authority tables, then rechecks after every wait.
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- Lock order: key, then the call (one late expense per written-off call; replays and races resolve to one row).
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.late.key:' || p_key::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.late:' || p_agent || ':' || p_id::text, 0));
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO x FROM hon.ai_late_provider_expenses WHERE expense_key = p_key;
  IF FOUND THEN
    IF x.expense_fingerprint <> fp THEN RAISE EXCEPTION 'AI_LATE_EXPENSE_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN hon.ai_late_expense_receipt(x, true);
  END IF;
  SELECT * INTO r FROM hon.ai_unknown_resolutions WHERE agent = p_agent AND invocation_id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_UNKNOWN_INVOCATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF r.decision <> 'WRITE_OFF' THEN RAISE EXCEPTION 'AI_LATE_EXPENSE_NOT_WRITTEN_OFF' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM hon.ai_late_provider_expenses WHERE resolution_id = r.id) THEN RAISE EXCEPTION 'AI_LATE_EXPENSE_ALREADY_RECORDED' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM hon.ai_late_provider_expenses WHERE provider_generation_id = e->>'providerGenerationId') THEN
    RAISE EXCEPTION 'AI_LATE_EXPENSE_DUPLICATE_GENERATION' USING ERRCODE='23514';
  END IF;
  -- The WRITE_OFF ledger row (zero customer credits, estimated cost) is read, never changed, and no second row is written.
  SELECT * INTO STRICT wl FROM hon.ai_usage_ledger WHERE id = r.ledger_entry_id;
  INSERT INTO hon.ai_late_provider_expenses(resolution_id,agent,invocation_id,organization_id,school_id,provider_generation_id,input_units,output_units,
      provider_cost_microunits,estimated_provider_cost_microunits,provider_code,model_code,occurred_at,reason,expense_key,expense_fingerprint,recorded_by_principal_id)
    VALUES (r.id,p_agent,p_id,r.organization_id,r.school_id,e->>'providerGenerationId',(e->>'inputTokens')::bigint,(e->>'outputTokens')::bigint,
      (e->>'providerCostMicrounits')::bigint,wl.provider_cost_microunits,wl.provider_code,wl.model_code,r.held_at,p_input->>'reason',p_key,fp,actor) RETURNING * INTO x;
  receipt := hon.ai_late_expense_receipt(x, false);
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
    VALUES (r.organization_id, r.school_id, actor, 'HON_HQ', 'hq.ai.late_provider_expense.record', 'AI_INVOCATION', p_id,
      jsonb_build_object('resolutionId',r.id,'decision',r.decision,'estimatedProviderCostMicrounits',wl.provider_cost_microunits), receipt - 'replayed', 'SUCCEEDED', p_request_id, p_correlation_id, now());
  INSERT INTO hon.outbox_events (organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
    VALUES (r.organization_id, r.school_id, 'ai.late_provider_expense.recorded', 1, 'AI_INVOCATION', p_id, 2, p_correlation_id, p_request_id, receipt - 'replayed');
  RETURN receipt;
END $$;

CREATE OR REPLACE FUNCTION hon.read_ai_unknown_invocations_from_hq(p_subject text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_saas_hq_actor(p_subject, false); at timestamptz := clock_timestamp();
BEGIN
  RETURN jsonb_build_object(
    'open', coalesce((SELECT jsonb_agg(jsonb_build_object('agent',o.agent,'invocationId',o.id,'organizationId',o.organization_id,'schoolId',o.school_id,
        'status',o.status,'reservedCredits',o.reserved_credits,'heldAt',CASE WHEN o.held_at IS NULL THEN NULL ELSE hon.saas_ts(o.held_at) END,
        'countsAgainstCurrentWindow',coalesce(o.held_at <@ hon.ai_spend_window(o.organization_id, at), true)) ORDER BY o.held_at NULLS FIRST, o.id)
      FROM (SELECT * FROM (
          SELECT 'MARKETING' agent,id,organization_id,school_id,status,reserved_credits,held_at FROM hon.marketing_ai_invocations
          UNION ALL SELECT 'TEACHING',id,organization_id,school_id,status,reserved_credits,held_at FROM hon.teaching_ai_invocations
          UNION ALL SELECT 'CHAD_FOLLOW_UP',id,organization_id,school_id,status,reserved_credits,held_at FROM hon.chad_follow_up_invocations
          UNION ALL SELECT 'HON_REPLY',id,organization_id,school_id,status,reserved_credits,held_at FROM hon.hon_reply_invocations) a
        WHERE a.reserved_credits > 0 AND (a.status = 'UNKNOWN' OR (a.status = 'SENDING' AND a.held_at <= at - hon.ai_sending_stale_after()))
        ORDER BY a.held_at NULLS FIRST, a.id LIMIT 200) o), '[]'::jsonb),
    'resolved', coalesce((SELECT jsonb_agg((hon.ai_unknown_receipt(s.x, false) - 'replayed') || jsonb_build_object('reason',(s.x).reason,'evidence',(s.x).evidence,
        'resolvedByPrincipalId',(s.x).resolved_by_principal_id,'priorStatus',(s.x).prior_status,'heldAt',CASE WHEN (s.x).held_at IS NULL THEN NULL ELSE hon.saas_ts((s.x).held_at) END,
        'lateProviderExpense',(SELECT jsonb_build_object('expenseId',l.id,'providerCostMicrounits',l.provider_cost_microunits,
          'occurredAt',hon.saas_ts(l.occurred_at),'recordedAt',hon.saas_ts(l.recorded_at)) FROM hon.ai_late_provider_expenses l WHERE l.resolution_id=(s.x).id)) ORDER BY (s.x).resolved_at DESC, (s.x).id)
      FROM (SELECT x FROM hon.ai_unknown_resolutions x ORDER BY x.resolved_at DESC, x.id LIMIT 100) s), '[]'::jsonb),
    'staleAfterSeconds', extract(epoch FROM hon.ai_sending_stale_after())::integer,
    'asOf', hon.saas_ts(at));
END $$;

CREATE OR REPLACE FUNCTION hon.read_ai_school_usage_from_hq(p_subject text, p_from timestamptz, p_to timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_saas_hq_actor(p_subject, false); at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '92 days' OR p_to > at + interval '1 day' THEN
    RAISE EXCEPTION 'INVALID_AI_USAGE_RANGE' USING ERRCODE='22023';
  END IF;
  WITH rows AS (
    SELECT u.organization_id, u.school_id, u.spend_class, u.customer_credits, u.provider_cost_microunits,
      CASE WHEN u.spend_class <> 'AGENT_INFERENCE' THEN NULL
           WHEN u.source_invocation_id IS NULL THEN 'UNATTRIBUTED'
           WHEN EXISTS (SELECT 1 FROM hon.marketing_ai_invocations i WHERE i.id = u.source_invocation_id) THEN 'MARKETING'
           WHEN EXISTS (SELECT 1 FROM hon.teaching_ai_invocations i WHERE i.id = u.source_invocation_id) THEN 'TEACHING'
           WHEN EXISTS (SELECT 1 FROM hon.chad_follow_up_invocations i WHERE i.id = u.source_invocation_id) THEN 'CHAD_FOLLOW_UP'
           WHEN EXISTS (SELECT 1 FROM hon.hon_reply_invocations i WHERE i.id = u.source_invocation_id) THEN 'HON_REPLY'
           ELSE 'UNATTRIBUTED' END AS agent,
      EXISTS (SELECT 1 FROM hon.ai_unknown_resolutions r WHERE r.ledger_entry_id = u.id AND r.decision = 'WRITE_OFF') AS write_off,
      EXISTS (SELECT 1 FROM hon.ai_unknown_resolutions r JOIN hon.ai_late_provider_expenses l ON l.resolution_id = r.id
              WHERE r.ledger_entry_id = u.id AND r.decision = 'WRITE_OFF') AS superseded,
      false AS late
    FROM hon.ai_usage_ledger u
    WHERE u.occurred_at >= p_from AND u.occurred_at < p_to
    UNION ALL
    -- Late actuals: provider expense evidence only (no ledger row, no customer credits), in their original window.
    SELECT l.organization_id, l.school_id, 'AGENT_INFERENCE', 0, l.provider_cost_microunits, l.agent, false, false, true
    FROM hon.ai_late_provider_expenses l
    WHERE l.occurred_at >= p_from AND l.occurred_at < p_to
  ), totals AS (
    SELECT organization_id, school_id, spend_class, agent, sum(customer_credits)::bigint credits,
      coalesce(sum(provider_cost_microunits) FILTER (WHERE NOT write_off AND NOT late), 0)::bigint cost,
      coalesce(sum(provider_cost_microunits) FILTER (WHERE write_off), 0)::bigint estimate,
      count(*) FILTER (WHERE NOT late)::bigint entries, count(*) FILTER (WHERE write_off)::bigint write_offs,
      coalesce(sum(provider_cost_microunits) FILTER (WHERE late), 0)::bigint late_cost, count(*) FILTER (WHERE late)::bigint late_entries,
      coalesce(sum(provider_cost_microunits) FILTER (WHERE superseded), 0)::bigint superseded
    FROM rows GROUP BY organization_id, school_id, spend_class, agent
  ), classes AS (
    SELECT organization_id, school_id, spend_class AS k, sum(credits) credits, sum(cost) cost, sum(estimate) estimate,
      sum(entries) entries, sum(write_offs) write_offs, sum(late_cost) late_cost, sum(late_entries) late_entries, sum(superseded) superseded,
      jsonb_build_object('credits', sum(credits), 'providerReportedCostMicrounits', sum(cost), 'estimatedWriteOffCostMicrounits', sum(estimate),
        'entries', sum(entries), 'writeOffEntries', sum(write_offs),
        'lateProviderCostMicrounits', sum(late_cost), 'lateProviderExpenseEntries', sum(late_entries), 'supersededWriteOffEstimateMicrounits', sum(superseded),
        -- Aggregates are computed for every class group regardless of the CASE, so the per-agent aggregate skips rows
        -- without an agent (CREATIVE_MEDIA, HQ_INTERNAL); otherwise a NULL key fails the whole read.
        'byAgent', CASE WHEN spend_class = 'AGENT_INFERENCE'
          THEN jsonb_object_agg(agent, jsonb_build_object('credits', credits, 'providerReportedCostMicrounits', cost,
              'estimatedWriteOffCostMicrounits', estimate, 'entries', entries, 'writeOffEntries', write_offs,
              'lateProviderCostMicrounits', late_cost, 'lateProviderExpenseEntries', late_entries, 'supersededWriteOffEstimateMicrounits', superseded))
            FILTER (WHERE agent IS NOT NULL)
          ELSE NULL END) AS v
    FROM totals GROUP BY organization_id, school_id, spend_class
  ), unresolved AS (
    -- (Manus delta review P2) Calls whose outcome is still unknown, per school: UNKNOWN, or SENDING past the stale limit
    -- by the immutable held_at, with a hold (the HQ UNKNOWN queue predicate). Current state, not range-scoped, like the
    -- per-school count it feeds. They have no ledger row and no known cost, so they add no amount anywhere.
    SELECT h.organization_id, h.school_id, count(*)::bigint n FROM (
        SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.marketing_ai_invocations
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.teaching_ai_invocations
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.chad_follow_up_invocations
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.hon_reply_invocations) h
      WHERE h.reserved_credits > 0 AND (h.status = 'UNKNOWN' OR (h.status = 'SENDING' AND h.held_at <= at - hon.ai_sending_stale_after()))
      GROUP BY h.organization_id, h.school_id
  ), school_keys AS (
    -- A school is listed when it has ledger or late-expense rows in the range, or unresolved calls now. A school with
    -- neither is not listed (zero activity). Each school appears once.
    SELECT organization_id, school_id FROM classes UNION SELECT organization_id, school_id FROM unresolved
  ), schools AS (
    SELECT s.organization_id, s.school_id,
      jsonb_build_object('organizationId', s.organization_id, 'schoolId', s.school_id,
        'providerReportedCostMicrounits', coalesce(sum(c.cost), 0), 'estimatedWriteOffCostMicrounits', coalesce(sum(c.estimate), 0),
        'entries', coalesce(sum(c.entries), 0), 'writeOffEntries', coalesce(sum(c.write_offs), 0),
        'lateProviderCostMicrounits', coalesce(sum(c.late_cost), 0), 'lateProviderExpenseEntries', coalesce(sum(c.late_entries), 0),
        'supersededWriteOffEstimateMicrounits', coalesce(sum(c.superseded), 0),
        'unreconciledInvocations', coalesce(max(u.n), 0),
        'byClass', coalesce(jsonb_object_agg(c.k, c.v) FILTER (WHERE c.k IS NOT NULL), '{}'::jsonb)) AS j,
      coalesce(sum(c.cost), 0) AS cost, coalesce(sum(c.estimate), 0) AS estimate, coalesce(max(u.n), 0) AS unresolved
    FROM school_keys s
    LEFT JOIN classes c ON c.organization_id = s.organization_id AND c.school_id = s.school_id
    LEFT JOIN unresolved u ON u.organization_id = s.organization_id AND u.school_id = s.school_id
    GROUP BY s.organization_id, s.school_id
  ), limited AS (
    SELECT * FROM schools ORDER BY cost DESC, estimate DESC, unresolved DESC, organization_id, school_id LIMIT 500
  ), orgs AS (
    SELECT DISTINCT organization_id FROM limited
  )
  SELECT jsonb_build_object(
    'from', hon.saas_ts(p_from), 'to', hon.saas_ts(p_to), 'asOf', hon.saas_ts(at),
    'truncated', (SELECT count(*) FROM schools) > 500,
    'schools', coalesce((SELECT jsonb_agg(l.j ORDER BY l.cost DESC, l.estimate DESC, l.unresolved DESC, l.organization_id, l.school_id) FROM limited l), '[]'::jsonb),
    'organizations', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'organizationId', o.organization_id,
        'agentWindowStart', hon.saas_ts(lower(w.r)), 'agentWindowEnd', hon.saas_ts(upper(w.r)),
        'agentCommittedCredits', hon.ai_org_committed_credits(o.organization_id, at),
        'agentCeilingCredits', hon.ai_org_ceiling(o.organization_id, at),
        'openUnknownHolds', (SELECT count(*) FROM (
            SELECT status, held_at, reserved_credits FROM hon.marketing_ai_invocations WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.teaching_ai_invocations WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.chad_follow_up_invocations WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.hon_reply_invocations WHERE organization_id = o.organization_id) h
          WHERE h.reserved_credits > 0 AND (h.status = 'UNKNOWN' OR (h.status = 'SENDING' AND h.held_at <= at - hon.ai_sending_stale_after()))),
        'aiPaused', EXISTS (SELECT 1 FROM hon.ai_spend_pauses p WHERE p.ended_at IS NULL AND (p.organization_id = o.organization_id OR p.organization_id IS NULL)))
        ORDER BY o.organization_id)
      FROM orgs o CROSS JOIN LATERAL (SELECT hon.ai_spend_window(o.organization_id, at) AS r) w), '[]'::jsonb),
    'providerCostUnit', 'MICROUNITS_USD')
  INTO result;
  RETURN result;
END $$;

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
  FOR a IN SELECT * FROM (VALUES ('marcus', 'MARKETING', 5120::bigint, 100000::bigint, 6), ('claire', 'TEACHING', 5120, 100000, 6),
                                 ('chad', 'CHAD_FOLLOW_UP', 2648, 60000, 3), ('hon', 'HON_REPLY', 8800, 80000, 9)) v(agent_key, agent, units, max_cost, estimate) LOOP
    BEGIN
      IF a.agent_key = 'marcus' THEN PERFORM hon.marketing_owner(p_subject);
      ELSIF a.agent_key = 'claire' THEN PERFORM hon.require_teaching_assistant_actor(p_subject, false);
      ELSIF a.agent_key = 'chad' THEN PERFORM hon.require_chad_follow_up_actor(p_subject);
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

-- Turn state for a HON question comes from its reply invocation.
CREATE OR REPLACE FUNCTION hon.hon_turn_view(t hon.hon_conversation_turns) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE inv_id uuid; inv_status text; inv_reason text; work uuid; action uuid; updated timestamptz; status text; reason text;
BEGIN
  IF t.agent_key = 'marcus' THEN
    SELECT id, i.status, i.reason, work_item_id, action_request_id, updated_at INTO inv_id, inv_status, inv_reason, work, action, updated
    FROM hon.marketing_ai_invocations i WHERE organization_id = t.organization_id AND school_id = t.school_id AND requested_by = t.requested_by AND idempotency_key = t.id
      AND i.request_hash = t.delegation_fingerprint;
  ELSIF t.agent_key = 'claire' THEN
    SELECT id, i.status, i.reason, work_item_id, action_request_id, updated_at INTO inv_id, inv_status, inv_reason, work, action, updated
    FROM hon.teaching_ai_invocations i WHERE organization_id = t.organization_id AND school_id = t.school_id AND requested_by = t.requested_by AND idempotency_key = t.id
      AND i.request_hash = t.delegation_fingerprint;
  ELSIF t.agent_key = 'hon' THEN
    SELECT id, i.status, i.reason, work_item_id, NULL::uuid, updated_at INTO inv_id, inv_status, inv_reason, work, action, updated
    FROM hon.hon_reply_invocations i WHERE organization_id = t.organization_id AND school_id = t.school_id AND requested_by = t.requested_by AND turn_id = t.id;
  ELSE
    SELECT id, i.status, i.reason, work_item_id, action_request_id, updated_at INTO inv_id, inv_status, inv_reason, work, action, updated
    FROM hon.chad_follow_up_invocations i WHERE organization_id = t.organization_id AND school_id = t.school_id AND requested_by = t.requested_by AND idempotency_key = t.id
      AND i.request_hash = t.delegation_fingerprint;
  END IF;
  IF t.agent_key = 'hon' THEN
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
  RETURN jsonb_build_object('turnId', t.id, 'conversationId', t.conversation_id, 'agentKey', t.agent_key, 'status', status, 'reason', reason,
    'invocationId', inv_id, 'workItemId', work, 'actionRequestId', action);
END $$;

-- A turn is a delegation (C1) or a question for HON (C2).
CREATE OR REPLACE FUNCTION hon.begin_hon_turn(p_subject text, p_conversation uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); c hon.hon_conversations%ROWTYPE; t hon.hon_conversation_turns%ROWTYPE;
  fingerprint text; d jsonb; agent text; target jsonb; v jsonb; handoff boolean; wid uuid;
BEGIN
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR NOT p_input ?& ARRAY['text', 'delegation']
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('text', 'delegation'))
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
      INSERT INTO hon.work_items (organization_id, school_id, work_type, status, subject_type, subject_id, payload, correlation_id)
      VALUES (c.organization_id, c.school_id, 'AI_ANALYZE', 'READY', 'HON_CONVERSATION_TURN', t.id, '{}', nullif(current_setting('app.hon_request_id', true), '')::uuid)
      RETURNING id INTO wid;
      INSERT INTO hon.hon_reply_invocations (organization_id, school_id, conversation_id, turn_id, requested_by, work_item_id)
      VALUES (c.organization_id, c.school_id, c.id, t.id, actor, wid);
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
  RETURN jsonb_build_object('turnId', t.id, 'agentKey', t.agent_key, 'delegation', t.delegation, 'handOff', handoff);
END $$;

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
  CROSS JOIN LATERAL (VALUES
    (jsonb_build_object('turnId', t.id, 'role', 'HUMAN', 'text', t.text, 'createdAt', hon.saas_ts(t.created_at), 'status', v.v->>'status',
       'reason', NULL, 'references', jsonb_build_object('workItemId', NULL, 'actionRequestId', NULL, 'invocationId', NULL))),
    (jsonb_build_object('turnId', t.id, 'role', t.agent_key,
       'text', CASE WHEN t.agent_key = 'hon' AND v.v->>'status' = 'COMPLETED' THEN (SELECT r.reply_text FROM hon.hon_reply_invocations r WHERE r.turn_id = t.id AND r.status = 'COMPLETED') END, 'createdAt', hon.saas_ts(t.created_at), 'status', v.v->>'status',
       'reason', v.v->>'reason', 'references', jsonb_build_object('workItemId', v.v->'workItemId', 'actionRequestId', v.v->'actionRequestId', 'invocationId', v.v->'invocationId')))
  ) AS r(x)
  WHERE t.conversation_id = c.id;
  RETURN hon.hon_conversation_summary(c) || jsonb_build_object('turns', turns);
END $$;

CREATE OR REPLACE FUNCTION hon.read_hon_turn_receipt(p_subject text, p_turn uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); t hon.hon_conversation_turns%ROWTYPE; v jsonb;
BEGIN
  SELECT * INTO t FROM hon.hon_conversation_turns WHERE id = p_turn AND organization_id = hon.current_organization_id() AND school_id = hon.current_school_id() AND requested_by = actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_TURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v := hon.hon_turn_view(t);
  RETURN jsonb_build_object('turnId', t.id, 'conversationId', t.conversation_id, 'status', v->>'status', 'reason', v->'reason',
    'delegatedAgentKeys', CASE WHEN t.agent_key = 'hon' THEN '[]'::jsonb ELSE jsonb_build_array(t.agent_key) END,
    'actionRequestIds', CASE WHEN v->>'actionRequestId' IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v->'actionRequestId') END,
    'workItemIds', CASE WHEN v->>'workItemId' IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v->'workItemId') END,
    'invocationId', v->'invocationId',
    'reply', CASE WHEN t.agent_key = 'hon' AND v->>'status' = 'COMPLETED' THEN (SELECT to_jsonb(r.reply_text) FROM hon.hon_reply_invocations r WHERE r.turn_id = t.id AND r.status = 'COMPLETED') ELSE 'null'::jsonb END);
END $$;

DO $$ DECLARE f regprocedure; r text; BEGIN
  REVOKE ALL ON hon.hon_reply_invocations FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON hon.hon_reply_invocations FROM %I', r);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.hon_reply_limits()'::regprocedure, 'hon.hon_reply_access(text)'::regprocedure,
      'hon.hon_reply_planning_reference(text,uuid)'::regprocedure, 'hon.prepare_hon_reply(text,uuid,uuid,boolean)'::regprocedure,
      'hon.fail_hon_reply(text,uuid,text,text)'::regprocedure, 'hon.record_hon_reply_result(text,uuid,jsonb)'::regprocedure,
      'hon.release_held_hon_reply(text,uuid)'::regprocedure] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.hon_reply_planning_reference(text,uuid), hon.prepare_hon_reply(text,uuid,uuid,boolean),
      hon.fail_hon_reply(text,uuid,text,text), hon.record_hon_reply_result(text,uuid,jsonb), hon.release_held_hon_reply(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
