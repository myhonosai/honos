BEGIN;

-- 0211 (proposed) K1: Kai is HON OS's Teaching & Curriculum assistant.
-- Owner master blueprint 2026-11-06: HON is the central assistant, Kai owns teaching, and Claire is the Business Performance
-- specialist. Historical rows keep their recorded agent key 'claire' (plans, turns, ledgers, UNKNOWN resolutions and audit
-- are evidence and are never rewritten). A teaching record is identified by its capability (task class DRAFT_TEACHING,
-- teaching_ai_invocations), so legacy 'claire' teaching rows are unambiguous and are presented as Kai.
-- New teaching plans and conversation turns are recorded as 'kai'. Delegations sent as 'claire' are accepted for one release
-- and stored as 'kai'. Budgets, the S4 path, permissions (teaching.assistant.use), approvals and grants are unchanged.

ALTER TABLE hon.ai_invocation_plans DROP CONSTRAINT ai_invocation_plans_agent_key_check;
ALTER TABLE hon.ai_invocation_plans ADD CONSTRAINT ai_invocation_plans_agent_key_check
  CHECK (agent_key IN ('alex','chad','maya','marcus','jordan','claire','lena','eian','hon','kai'));
-- Only teaching may be planned for 'kai' (an analysis or draft for another capability under Kai's name is refused).
ALTER TABLE hon.ai_invocation_plans ADD CONSTRAINT ai_invocation_plans_kai_teaching_only
  CHECK (agent_key <> 'kai' OR task_class = 'DRAFT_TEACHING') NOT VALID;
ALTER TABLE hon.ai_invocation_plans VALIDATE CONSTRAINT ai_invocation_plans_kai_teaching_only;

ALTER TABLE hon.hon_conversation_turns DROP CONSTRAINT hon_conversation_turns_agent_key_check;
ALTER TABLE hon.hon_conversation_turns ADD CONSTRAINT hon_conversation_turns_agent_key_check
  CHECK (agent_key IN ('marcus', 'claire', 'chad', 'hon', 'kai'));

-- The agent a client sees: a legacy teaching turn recorded as 'claire' is Kai's.
CREATE FUNCTION hon.hon_presented_agent(p_key text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN p_key = 'claire' THEN 'kai' ELSE p_key END
$$;

CREATE OR REPLACE FUNCTION hon.validate_ai_invocation_plan_input(p_data jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE keys text[]:=ARRAY['expectedVersion','expectedState','agentKey','modality','taskClass','inputBudget','outputBudget','maxProviderCostMicrounits']; f text;
BEGIN
 IF p_data IS NULL OR jsonb_typeof(p_data)<>'object' OR NOT p_data ?& keys OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k<>ALL(keys)) THEN RAISE EXCEPTION 'Invalid AI planning metadata shape' USING ERRCODE='22023'; END IF;
 FOREACH f IN ARRAY ARRAY['expectedVersion','inputBudget','outputBudget','maxProviderCostMicrounits'] LOOP IF jsonb_typeof(p_data->f)<>'number' OR p_data->>f !~ '^[0-9]+$' OR (p_data->>f)::numeric>2147483646 THEN RAISE EXCEPTION 'Invalid AI planning integer' USING ERRCODE='22023'; END IF; END LOOP;
 IF (p_data->>'expectedVersion')::integer<1 OR (p_data->>'inputBudget')::integer NOT BETWEEN 1 AND 128000 OR (p_data->>'outputBudget')::integer NOT BETWEEN 1 AND 16000 OR (p_data->>'maxProviderCostMicrounits')::integer NOT BETWEEN 0 AND 1000000 THEN RAISE EXCEPTION 'AI planning budget or version out of range' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_data->'expectedState')<>'string' OR jsonb_typeof(p_data->'agentKey')<>'string' OR jsonb_typeof(p_data->'modality')<>'string' OR jsonb_typeof(p_data->'taskClass')<>'string' OR p_data->>'expectedState' NOT IN('READY','THINKING') OR p_data->>'agentKey' NOT IN('alex','chad','maya','marcus','jordan','claire','lena','eian','hon','kai') OR p_data->>'modality'<>'TEXT' OR p_data->>'taskClass' NOT IN('SUMMARIZE','ANALYZE','DRAFT_MARKETING','DRAFT_TEACHING','DRAFT_FOLLOW_UP') THEN RAISE EXCEPTION 'Unregistered AI planning metadata' USING ERRCODE='22023'; END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.prepare_teaching_invocation(p_subject text, p_id uuid, p_plan uuid, p_ready boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$
DECLARE budget_locked boolean:=hon.ai_budget_lock(hon.current_organization_id()); actor uuid:=hon.require_teaching_assistant_actor(p_subject,true); i hon.teaching_ai_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE;  why text; facts jsonb;
BEGIN SELECT * INTO i FROM hon.teaching_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'TEACHING_INVOCATION_NOT_FOUND' USING ERRCODE='P0002'; END IF; IF i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '30 seconds' THEN UPDATE hon.teaching_ai_invocations SET status='UNKNOWN',reason='PROVIDER_UNKNOWN',updated_at=clock_timestamp() WHERE id=i.id; PERFORM hon.teaching_assistant_event(i.id,'teaching.assistant.unknown'); RETURN NULL; END IF; IF i.status NOT IN('PENDING','CONFIGURATION_REQUIRED','BLOCKED') THEN RETURN NULL; END IF; IF p_plan IS NULL THEN UPDATE hon.teaching_ai_invocations SET status='BLOCKED',reason='NO_ELIGIBLE_ROUTE' WHERE id=i.id; UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1 WHERE id=i.work_item_id; PERFORM hon.teaching_assistant_event(i.id,'teaching.assistant.blocked'); RETURN NULL; END IF; SELECT * INTO p FROM hon.ai_invocation_plans WHERE id=p_plan AND organization_id=i.organization_id AND school_id=i.school_id AND work_item_id=i.work_item_id AND task_class='DRAFT_TEACHING' AND agent_key IN('kai','claire') AND input_budget=4096 AND output_budget=1024 AND max_provider_cost_microunits=100000; IF NOT FOUND OR (i.plan_id IS NOT NULL AND i.plan_id<>p_plan) THEN RAISE EXCEPTION 'TEACHING_PLAN_SWAP' USING ERRCODE='42501'; END IF; PERFORM 1 FROM hon.hq_ai_provider_connections WHERE provider_id=p.provider_id FOR SHARE; PERFORM 1 FROM hon.hq_ai_model_catalog WHERE catalog_id=p.catalog_id FOR SHARE; PERFORM 1 FROM hon.hq_ai_routing_policies WHERE policy_id=p.routing_policy_id FOR SHARE; PERFORM 1 FROM hon.hq_ai_routing_candidates WHERE policy_id=p.routing_policy_id FOR SHARE;
 IF p.provider_id<>'OPENROUTER' THEN why:='UNSUPPORTED_PROVIDER'; ELSIF NOT EXISTS(SELECT 1 FROM hon.hq_ai_provider_connections pc JOIN hon.hq_ai_model_catalog m ON m.provider_id=pc.provider_id JOIN hon.hq_ai_routing_candidates rc ON rc.catalog_id=m.catalog_id JOIN hon.hq_ai_routing_policies rp ON rp.policy_id=rc.policy_id WHERE pc.provider_id=p.provider_id AND pc.state='HEALTHY' AND pc.version=p.provider_version AND m.catalog_id=p.catalog_id AND m.model_id=p.model_id AND m.version=p.catalog_version AND m.active AND m.cost_unit='TOKEN' AND 'TEXT'=ANY(m.capabilities) AND 'TEXT'=ANY(m.modalities) AND m.effective_from<=clock_timestamp() AND (m.effective_until IS NULL OR m.effective_until>clock_timestamp()) AND rp.policy_id=p.routing_policy_id AND rp.organization_id=i.organization_id AND rp.school_id=i.school_id AND rp.version=p.routing_policy_version AND rp.active AND rp.capability='TEXT' AND rp.effective_from<=clock_timestamp() AND (rp.effective_until IS NULL OR rp.effective_until>clock_timestamp()) AND m.unit_cost_micros*5120<=LEAST(rp.max_cost_micros,p.max_provider_cost_microunits)) THEN why:='ROUTE_STALE'; ELSIF NOT p_ready THEN why:='CONFIGURATION_REQUIRED'; END IF;
 -- S4-b: one organization-wide agent budget; ai.budget:<org> is already held (first declaration above).
 IF why IS NULL THEN IF hon.ai_org_committed_credits(i.organization_id,clock_timestamp())+p.customer_credit_estimate>hon.ai_org_ceiling(i.organization_id,clock_timestamp()) THEN why:='CUSTOMER_BUDGET_EXCEEDED'; END IF; END IF; UPDATE hon.teaching_ai_invocations SET plan_id=p.id,status=CASE WHEN why IS NULL THEN 'SENDING' WHEN why='CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED' ELSE 'BLOCKED' END,reason=why,reserved_credits=CASE WHEN why IS NULL THEN p.customer_credit_estimate ELSE 0 END,updated_at=clock_timestamp() WHERE id=i.id; UPDATE hon.work_items SET status=CASE WHEN why IS NULL THEN 'WORKING' ELSE 'NEEDS_ATTENTION' END,version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id; PERFORM hon.teaching_assistant_event(i.id,'teaching.assistant.prepared'); IF why IS NOT NULL THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('curriculum',jsonb_build_object('id',c.id,'name',c.name,'description',coalesce(c.description,''),'modelCode',c.model_code,'version',c.version),'ranks',coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'order',r.progression_order,'requirements',coalesce((SELECT jsonb_agg(jsonb_build_object('code',q.requirement_code,'kind',q.requirement_kind,'required',q.is_required,'version',q.version) ORDER BY q.requirement_code) FROM hon.curriculum_requirements q WHERE q.curriculum_rank_id=r.id AND q.organization_id=i.organization_id AND q.school_id=i.school_id),'[]'::jsonb)) ORDER BY r.progression_order),'[]'::jsonb),'brief',i.brief_text) INTO facts FROM hon.curricula c LEFT JOIN hon.curriculum_ranks r ON r.curriculum_id=c.id AND r.organization_id=c.organization_id AND r.school_id=c.school_id WHERE c.id=i.curriculum_id AND c.organization_id=i.organization_id AND c.school_id=i.school_id AND c.lifecycle='PUBLISHED' GROUP BY c.id,c.name,c.description,c.model_code,c.version,i.brief_text; IF facts IS NULL THEN RAISE EXCEPTION 'PUBLISHED_CURRICULUM_NOT_FOUND' USING ERRCODE='P0002'; END IF; RETURN jsonb_build_object('providerId',p.provider_id,'modelId',p.model_id,'providerRequestId',i.provider_request_id,'request','Approved curriculum facts only: '||facts::text,'inputBudget',p.input_budget,'outputBudget',p.output_budget,'maxCostMicrounits',p.max_provider_cost_microunits); END $function$;

CREATE OR REPLACE FUNCTION hon.hon_turn_bind_specialist() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE t hon.hon_conversation_turns%ROWTYPE; n jsonb := to_jsonb(NEW); d jsonb; ok boolean;
BEGIN
  SELECT * INTO t FROM hon.hon_conversation_turns
   WHERE id = NEW.idempotency_key AND organization_id = NEW.organization_id AND school_id = NEW.school_id AND requested_by = NEW.requested_by;
  IF NOT FOUND THEN RETURN NEW; END IF;
  d := t.delegation;
  ok := NEW.request_hash = t.delegation_fingerprint AND CASE TG_TABLE_NAME
    WHEN 'marketing_ai_invocations' THEN t.agent_key = 'marcus' AND n->>'campaign_id' = d->>'campaignId' AND n->>'request_text' = d->>'request'
    WHEN 'teaching_ai_invocations' THEN t.agent_key IN ('kai', 'claire') AND n->>'curriculum_id' = d->>'curriculumId' AND n->>'brief_text' IS NOT DISTINCT FROM d->>'brief'
    WHEN 'chad_follow_up_invocations' THEN t.agent_key = 'chad' AND n->>'lead_id' = d->>'leadId'
      AND (n->>'lead_version')::integer = (d->>'expectedLeadVersion')::integer AND n->>'purpose' = d->>'purpose'
    ELSE false END;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'HON_TURN_DELEGATION_MISMATCH' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION hon.hon_turn_view(t hon.hon_conversation_turns) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE inv_id uuid; inv_status text; inv_reason text; work uuid; action uuid; updated timestamptz; status text; reason text;
BEGIN
  IF t.agent_key = 'marcus' THEN
    SELECT id, i.status, i.reason, work_item_id, action_request_id, updated_at INTO inv_id, inv_status, inv_reason, work, action, updated
    FROM hon.marketing_ai_invocations i WHERE organization_id = t.organization_id AND school_id = t.school_id AND requested_by = t.requested_by AND idempotency_key = t.id
      AND i.request_hash = t.delegation_fingerprint;
  ELSIF t.agent_key IN ('kai', 'claire') THEN
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
  RETURN jsonb_build_object('turnId', t.id, 'conversationId', t.conversation_id, 'agentKey', hon.hon_presented_agent(t.agent_key), 'status', status, 'reason', reason,
    'invocationId', inv_id, 'workItemId', work, 'actionRequestId', action);
END $$;

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
  RETURN jsonb_build_object('turnId', t.id, 'agentKey', hon.hon_presented_agent(t.agent_key), 'delegation', t.delegation, 'handOff', handoff);
END $$;

CREATE OR REPLACE FUNCTION hon.read_hon_turn_receipt(p_subject text, p_turn uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); t hon.hon_conversation_turns%ROWTYPE; v jsonb;
BEGIN
  SELECT * INTO t FROM hon.hon_conversation_turns WHERE id = p_turn AND organization_id = hon.current_organization_id() AND school_id = hon.current_school_id() AND requested_by = actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_TURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v := hon.hon_turn_view(t);
  RETURN jsonb_build_object('turnId', t.id, 'conversationId', t.conversation_id, 'status', v->>'status', 'reason', v->'reason',
    'delegatedAgentKeys', CASE WHEN t.agent_key = 'hon' THEN '[]'::jsonb ELSE jsonb_build_array(hon.hon_presented_agent(t.agent_key)) END,
    'actionRequestIds', CASE WHEN v->>'actionRequestId' IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v->'actionRequestId') END,
    'workItemIds', CASE WHEN v->>'workItemId' IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v->'workItemId') END,
    'invocationId', v->'invocationId',
    'reply', CASE WHEN t.agent_key = 'hon' AND v->>'status' = 'COMPLETED' THEN (SELECT to_jsonb(r.reply_text) FROM hon.hon_reply_invocations r WHERE r.turn_id = t.id AND r.status = 'COMPLETED') ELSE 'null'::jsonb END);
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
    (jsonb_build_object('turnId', t.id, 'role', hon.hon_presented_agent(t.agent_key),
       'text', CASE WHEN t.agent_key = 'hon' AND v.v->>'status' = 'COMPLETED' THEN (SELECT r.reply_text FROM hon.hon_reply_invocations r WHERE r.turn_id = t.id AND r.status = 'COMPLETED') END, 'createdAt', hon.saas_ts(t.created_at), 'status', v.v->>'status',
       'reason', v.v->>'reason', 'references', jsonb_build_object('workItemId', v.v->'workItemId', 'actionRequestId', v.v->'actionRequestId', 'invocationId', v.v->'invocationId')))
  ) AS r(x)
  WHERE t.conversation_id = c.id;
  RETURN hon.hon_conversation_summary(c) || jsonb_build_object('turns', turns);
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
  FOR a IN SELECT * FROM (VALUES ('marcus', 'MARKETING', 5120::bigint, 100000::bigint, 6), ('kai', 'TEACHING', 5120, 100000, 6),
                                 ('chad', 'CHAD_FOLLOW_UP', 2648, 60000, 3), ('hon', 'HON_REPLY', 8800, 80000, 9)) v(agent_key, agent, units, max_cost, estimate) LOOP
    BEGIN
      IF a.agent_key = 'marcus' THEN PERFORM hon.marketing_owner(p_subject);
      ELSIF a.agent_key = 'kai' THEN PERFORM hon.require_teaching_assistant_actor(p_subject, false);
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

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.hon_presented_agent(text) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.hon_presented_agent(text) FROM %I', r);
  END LOOP;
END $$;

COMMIT;
