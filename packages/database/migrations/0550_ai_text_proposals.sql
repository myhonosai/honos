BEGIN;

-- 0550 (allocated 2026-11-19 above the 0538 main ceiling; first drafted as 0380, then 0489, 0507, 0527 and 0534): one shared AI text caller, plus its first kind, WEBSITE_EDIT (WB5).
-- Design: /mnt/project-files/ai-text-proposals/AI_TEXT_PROPOSALS_DESIGN.md (repo copy docs/architecture/AI_TEXT_PROPOSALS.md).
--
-- Until now every AI text caller (Marcus, Claire/Kai teaching, Chad, the HON reply) brought its own spend table, and each
-- new caller rewrote the shared S4 functions. This migration adds ONE caller table, hon.ai_text_proposals, wires it into
-- S4 once, and adds a registry of kinds. A later kind (CM-3 CUSTOM_TOOL_DEFINITION, CA2b CONVERSATION_REPLY, the goal
-- planner's GOAL_PLAN_EXPLAIN) adds a kind row, its own entry points, its facts reader and its result validator only.
--
-- S4 wiring (each body is the latest body plus the new table, nothing else):
--   ai_org_committed_credits (0210), ai_school_committed_cost_micros (0288), ai_org_open_agent_holds (0272),
--   read_ai_unknown_invocations_from_hq (0210), ai_unknown_validate (0210), resolve_ai_unknown_invocation (0210),
--   record_ai_late_provider_expense (0210), read_ai_school_usage_from_hq (0328); the S4 start guard, reserve guards and
--   hold-origin stamp are attached as triggers; the UNKNOWN agent label is TEXT_PROPOSAL.
-- The core (hon.ai_text_*) is internal: SECURITY DEFINER, EXECUTE revoked from every role. It never decides who the
-- caller is. Each kind's entry points prove the actor, live permission and the kind's own gate before calling it.
--
-- WEBSITE_EDIT: the school owner asks for a change to the website draft in words. Marcus (marketing route, task class
-- DRAFT_MARKETING, so the live MARCUS_MARKETING HQ task profile and the school's AI limit apply) proposes a short summary
-- and a closed list of edits. The proposal changes nothing: the owner previews it and applies it as a normal draft save
-- (0361 mutate_school_website 'save', which re-validates the whole document). Nothing is published, sent or charged
-- outside the existing AGENT_INFERENCE ledger.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.school_websites') IS NULL OR to_regclass('hon.ai_school_cost_limits') IS NULL OR to_regclass('hon.ai_unknown_resolutions') IS NULL
    OR to_regprocedure('hon.ai_exception_allowance_micros(uuid,uuid)') IS NULL OR to_regclass('hon.ai_route_unavailable_attempts') IS NULL OR to_regclass('hon.eian_turns') IS NULL THEN
    RAISE EXCEPTION '0550 requires 0196, 0288, 0336, 0353, 0361 and 0474';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Kinds and proposals
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE hon.ai_text_kinds (
  kind text PRIMARY KEY CHECK (kind ~ '^[A-Z][A-Z_]{2,39}$'),
  agent_key text NOT NULL CHECK (agent_key ~ '^[a-z]{2,20}$'),
  task_class text NOT NULL CHECK (task_class ~ '^[A-Z][A-Z_]{2,39}$'),
  input_budget integer NOT NULL CHECK (input_budget BETWEEN 1 AND 128000),
  output_budget integer NOT NULL CHECK (output_budget BETWEEN 1 AND 16000),
  max_cost_microunits integer NOT NULL CHECK (max_cost_microunits BETWEEN 1 AND 1000000),
  max_result_bytes integer NOT NULL CHECK (max_result_bytes BETWEEN 2 AND 65536),
  caller text NOT NULL CHECK (caller IN ('HUMAN_UI','WORKER')),
  subject_type text NOT NULL CHECK (subject_type ~ '^[A-Z][A-Z_]{2,39}$'),
  usage_agent text NOT NULL CHECK (usage_agent ~ '^[A-Z][A-Z_]{2,39}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE hon.ai_text_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  kind text NOT NULL REFERENCES hon.ai_text_kinds(kind),
  origin_key text NOT NULL CHECK (length(origin_key) BETWEEN 1 AND 200 AND origin_key !~ '[[:cntrl:][:space:]]'),
  requested_by uuid REFERENCES hon.principals(id),
  subject_id uuid, subject_version integer CHECK (subject_version BETWEEN 0 AND 999999999),
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object' AND length(request::text)<=8192),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  work_item_id uuid NOT NULL, plan_id uuid REFERENCES hon.ai_invocation_plans(id),
  provider_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIGURATION_REQUIRED','BLOCKED','SENDING','UNKNOWN','FAILED',
    'RESULT_RECORDED','RESULT_REJECTED','APPLIED','DISMISSED')),
  reason text CHECK (reason IN ('CONFIGURATION_REQUIRED','NO_ELIGIBLE_ROUTE','CUSTOMER_BUDGET_EXCEEDED','AI_SPEND_STOPPED','UNSUPPORTED_PROVIDER',
    'INVALID_REQUEST','PROVIDER_REJECTED','PROVIDER_UNKNOWN','ROUTE_STALE','RESULT_BUDGET_EXCEEDED','RESULT_INVALID','SUBJECT_STALE','GATE_CLOSED')),
  reserved_credits integer NOT NULL DEFAULT 0 CHECK (reserved_credits BETWEEN 0 AND 200),
  held_at timestamptz,
  usage_id uuid REFERENCES hon.ai_usage_ledger(id),
  result jsonb CHECK (result IS NULL OR length(result::text)<=65536),
  result_problems jsonb CHECK (result_problems IS NULL OR (jsonb_typeof(result_problems)='array' AND jsonb_array_length(result_problems)<=50 AND length(result_problems::text)<=8192)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (kind, origin_key), UNIQUE (id, organization_id, school_id), UNIQUE (provider_request_id), UNIQUE (work_item_id), UNIQUE (plan_id), UNIQUE (usage_id),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id),
  FOREIGN KEY (work_item_id, organization_id, school_id) REFERENCES hon.work_items(id, organization_id, school_id),
  CHECK (result IS NULL OR status IN ('RESULT_RECORDED','RESULT_REJECTED','APPLIED','DISMISSED')),
  CHECK (status NOT IN ('RESULT_RECORDED','RESULT_REJECTED','APPLIED') OR result IS NOT NULL),
  CHECK (result_problems IS NULL OR (status IN ('RESULT_REJECTED','DISMISSED') AND jsonb_array_length(result_problems)>0)),
  CHECK (status<>'RESULT_REJECTED' OR result_problems IS NOT NULL)
);
CREATE INDEX ai_text_proposals_school_idx ON hon.ai_text_proposals (organization_id, school_id, kind, created_at DESC);
CREATE INDEX ai_text_proposals_holds_idx ON hon.ai_text_proposals (organization_id, school_id) WHERE reserved_credits > 0;

-- Kinds come only from migrations and never change. Proposals keep their identity, request and origin; each column that
-- moves does so once (plan, usage, result) and the closed states stay closed. held_at is owned by the zz stamp trigger.
CREATE FUNCTION hon.guard_ai_text_proposals() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE moving CONSTANT text[] := ARRAY['plan_id','status','reason','reserved_credits','usage_id','result','result_problems','updated_at'];
BEGIN
  IF TG_TABLE_NAME = 'ai_text_kinds' OR TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving)
    OR (OLD.plan_id IS NOT NULL AND NEW.plan_id IS DISTINCT FROM OLD.plan_id)
    OR (OLD.usage_id IS NOT NULL AND NEW.usage_id IS DISTINCT FROM OLD.usage_id)
    OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
    OR (OLD.result_problems IS NOT NULL AND NEW.result_problems IS DISTINCT FROM OLD.result_problems)
    OR (OLD.status IN ('APPLIED','DISMISSED','RESULT_REJECTED') AND NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status='RESULT_REJECTED' AND NEW.status='DISMISSED'))
    OR (OLD.status='FAILED' AND OLD.usage_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'AI_TEXT_PROPOSAL_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_text_kinds_immutable BEFORE UPDATE OR DELETE ON hon.ai_text_kinds FOR EACH ROW EXECUTE FUNCTION hon.guard_ai_text_proposals();
CREATE TRIGGER ai_text_kinds_no_truncate BEFORE TRUNCATE ON hon.ai_text_kinds FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_ai_text_proposals();
CREATE TRIGGER ai_text_proposals_guard BEFORE UPDATE OR DELETE ON hon.ai_text_proposals FOR EACH ROW EXECUTE FUNCTION hon.guard_ai_text_proposals();
CREATE TRIGGER ai_text_proposals_no_truncate BEFORE TRUNCATE ON hon.ai_text_proposals FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_ai_text_proposals();
-- S4: the same start guard, reserve guards and hold-origin stamp as the four existing callers.
CREATE TRIGGER ai_spend_start_guard BEFORE INSERT ON hon.ai_text_proposals FOR EACH ROW EXECUTE FUNCTION hon.ai_spend_start_guard();
CREATE TRIGGER ai_spend_reserve_guard BEFORE UPDATE OF reserved_credits ON hon.ai_text_proposals
  FOR EACH ROW WHEN (NEW.reserved_credits > OLD.reserved_credits) EXECUTE FUNCTION hon.ai_spend_reserve_guard();
CREATE TRIGGER ai_spend_reserve_guard_insert BEFORE INSERT ON hon.ai_text_proposals
  FOR EACH ROW WHEN (NEW.reserved_credits > 0) EXECUTE FUNCTION hon.ai_spend_reserve_guard();
CREATE TRIGGER zz_ai_hold_origin BEFORE INSERT OR UPDATE ON hon.ai_text_proposals FOR EACH ROW EXECUTE FUNCTION hon.ai_stamp_hold_origin();

ALTER TABLE hon.ai_text_kinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_text_kinds FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_text_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_text_proposals FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------------------------
-- Core (internal). Every function reads the tenant from the session settings and touches only that school's rows.
-- ---------------------------------------------------------------------------------------------------------------
-- Ids-only evidence. The audit row needs a principal; a WORKER kind without one writes the outbox event only.
CREATE FUNCTION hon.ai_text_event(p_id uuid, p_event text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.ai_text_proposals%ROWTYPE; payload jsonb; rid uuid := nullif(current_setting('app.hon_request_id',true),'')::uuid;
  actor uuid := nullif(current_setting('app.hon_principal_id',true),'')::uuid;
BEGIN
  SELECT * INTO STRICT i FROM hon.ai_text_proposals WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id();
  payload := jsonb_build_object('proposalId',i.id,'kind',i.kind,'workItemId',i.work_item_id,'status',i.status,'reason',i.reason,'internalOnly',true);
  IF actor IS NOT NULL THEN
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
      VALUES(i.organization_id,i.school_id,actor,coalesce(nullif(current_setting('app.hon_source',true),''),'HUMAN_UI'),'ai.text_proposal.'||p_event,
        'AI_TEXT_PROPOSAL',i.id,payload,'SUCCEEDED',rid,rid);
  END IF;
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(i.organization_id,i.school_id,'ai.text_proposal.'||p_event,1,'AI_TEXT_PROPOSAL',i.id,1,rid,rid,payload);
END $$;

-- Creates (or replays) one proposal and its work item. Same kind + origin and same request replays; anything else is 23505.
CREATE FUNCTION hon.ai_text_begin(p_kind text, p_requested_by uuid, p_origin_key text, p_subject_id uuid, p_subject_version integer, p_request jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id(); k hon.ai_text_kinds%ROWTYPE; i hon.ai_text_proposals%ROWTYPE;
  fp text; wid uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  SELECT * INTO k FROM hon.ai_text_kinds WHERE kind=p_kind;
  IF NOT FOUND OR p_origin_key IS NULL OR p_request IS NULL OR jsonb_typeof(p_request)<>'object'
    OR (k.caller='HUMAN_UI' AND p_requested_by IS NULL) THEN RAISE EXCEPTION 'INVALID_AI_TEXT_PROPOSAL' USING ERRCODE='22023'; END IF;
  fp := encode(sha256(convert_to(jsonb_build_object('kind',p_kind,'by',p_requested_by,'subject',p_subject_id,'version',p_subject_version,'request',p_request)::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.text:'||p_kind||':'||p_origin_key,0));
  SELECT * INTO i FROM hon.ai_text_proposals WHERE kind=p_kind AND origin_key=p_origin_key;
  IF FOUND THEN
    IF i.organization_id<>org OR i.school_id<>school OR i.request_hash<>fp THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_REPLAY_SWAP' USING ERRCODE='23505'; END IF;
    RETURN i.id;
  END IF;
  INSERT INTO hon.work_items(organization_id,school_id,work_type,status,subject_type,subject_id,payload,correlation_id)
    VALUES(org,school,'AI_'||k.task_class,'READY',k.subject_type,p_subject_id,'{}',nullif(current_setting('app.hon_request_id',true),'')::uuid) RETURNING id INTO wid;
  INSERT INTO hon.ai_text_proposals(organization_id,school_id,kind,origin_key,requested_by,subject_id,subject_version,request,request_hash,work_item_id)
    VALUES(org,school,p_kind,p_origin_key,p_requested_by,p_subject_id,p_subject_version,p_request,fp,wid) RETURNING * INTO i;
  PERFORM hon.ai_text_event(i.id,'requested');
  RETURN i.id;
END $$;

-- The row for an entry point, locked, for this school and requester only.
CREATE FUNCTION hon.ai_text_row(p_id uuid, p_requested_by uuid) RETURNS hon.ai_text_proposals LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.ai_text_proposals%ROWTYPE;
BEGIN
  SELECT * INTO i FROM hon.ai_text_proposals WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
    AND requested_by IS NOT DISTINCT FROM p_requested_by FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN i;
END $$;

-- {planId, workItemId, workVersion}, or NULL when there is nothing to plan. A SENDING row past 90 seconds is UNKNOWN (provider calls time out at 60).
CREATE FUNCTION hon.ai_text_planning_reference(p_id uuid, p_requested_by uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.ai_text_proposals%ROWTYPE := hon.ai_text_row(p_id, p_requested_by); w hon.work_items%ROWTYPE;
BEGIN
  IF i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN
    UPDATE hon.ai_text_proposals SET status='UNKNOWN',reason='PROVIDER_UNKNOWN',updated_at=clock_timestamp() WHERE id=i.id;
    UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;
    PERFORM hon.ai_text_event(i.id,'unknown'); RETURN NULL;
  END IF;
  IF i.status NOT IN ('PENDING','CONFIGURATION_REQUIRED','BLOCKED') THEN RETURN NULL; END IF;
  SELECT * INTO STRICT w FROM hon.work_items WHERE id=i.work_item_id AND organization_id=i.organization_id AND school_id=i.school_id FOR UPDATE;
  IF i.plan_id IS NULL AND w.status<>'READY' THEN UPDATE hon.work_items SET status='READY',version=version+1 WHERE id=w.id RETURNING * INTO w; END IF;
  RETURN jsonb_build_object('planId',i.plan_id,'workItemId',w.id,'workVersion',w.version);
END $$;

-- The final claim before a provider call. The organization budget lock is the FIRST lock (0194 order), then the row.
-- p_block is the kind's own refusal (SUBJECT_STALE, GATE_CLOSED), decided by the entry point; the core blocks with it.
-- Returns the invocation without its request text (the entry point adds it from its facts reader), or NULL.
CREATE FUNCTION hon.ai_text_prepare(p_id uuid, p_requested_by uuid, p_plan uuid, p_ready boolean, p_block text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id());
  i hon.ai_text_proposals%ROWTYPE := hon.ai_text_row(p_id, p_requested_by); k hon.ai_text_kinds%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE; why text;
BEGIN
  IF p_block IS NOT NULL AND p_block NOT IN ('SUBJECT_STALE','GATE_CLOSED') THEN RAISE EXCEPTION 'INVALID_AI_TEXT_PROPOSAL' USING ERRCODE='22023'; END IF;
  IF i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN
    UPDATE hon.ai_text_proposals SET status='UNKNOWN',reason='PROVIDER_UNKNOWN',updated_at=clock_timestamp() WHERE id=i.id;
    PERFORM hon.ai_text_event(i.id,'unknown'); RETURN NULL;
  END IF;
  IF i.status NOT IN ('PENDING','CONFIGURATION_REQUIRED','BLOCKED') THEN RETURN NULL; END IF;
  SELECT * INTO STRICT k FROM hon.ai_text_kinds WHERE kind=i.kind;
  IF p_plan IS NULL THEN why := 'NO_ELIGIBLE_ROUTE';
  ELSE
    SELECT * INTO p FROM hon.ai_invocation_plans WHERE id=p_plan AND organization_id=i.organization_id AND school_id=i.school_id AND work_item_id=i.work_item_id
      AND agent_key=k.agent_key AND task_class=k.task_class AND modality='TEXT' AND input_budget=k.input_budget AND output_budget=k.output_budget
      AND max_provider_cost_microunits=k.max_cost_microunits;
    IF NOT FOUND OR (i.plan_id IS NOT NULL AND i.plan_id<>p_plan) THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_PLAN_SWAP' USING ERRCODE='42501'; END IF;
    -- Locks serialize HQ revocation with the final claim; a historical plan does not authorize execution.
    PERFORM 1 FROM hon.hq_ai_provider_connections WHERE provider_id=p.provider_id FOR SHARE;
    PERFORM 1 FROM hon.hq_ai_model_catalog WHERE catalog_id=p.catalog_id FOR SHARE;
    PERFORM 1 FROM hon.hq_ai_routing_policies WHERE policy_id=p.routing_policy_id FOR SHARE;
    PERFORM 1 FROM hon.hq_ai_routing_candidates WHERE policy_id=p.routing_policy_id FOR SHARE;
    IF p.provider_id<>'OPENROUTER' THEN why := 'UNSUPPORTED_PROVIDER';
    ELSIF NOT EXISTS(SELECT 1 FROM hon.hq_ai_provider_connections pc JOIN hon.hq_ai_model_catalog m ON m.provider_id=pc.provider_id
        JOIN hon.hq_ai_routing_candidates rc ON rc.catalog_id=m.catalog_id JOIN hon.hq_ai_routing_policies rp ON rp.policy_id=rc.policy_id
        WHERE pc.provider_id=p.provider_id AND pc.state='HEALTHY' AND pc.version=p.provider_version AND m.catalog_id=p.catalog_id AND m.model_id=p.model_id
          AND m.version=p.catalog_version AND m.active AND m.cost_unit='TOKEN' AND 'TEXT'=ANY(m.capabilities) AND 'TEXT'=ANY(m.modalities)
          AND m.effective_from<=clock_timestamp() AND (m.effective_until IS NULL OR m.effective_until>clock_timestamp())
          AND rp.policy_id=p.routing_policy_id AND rp.organization_id=i.organization_id AND rp.school_id=i.school_id AND rp.version=p.routing_policy_version
          AND rp.active AND rp.capability='TEXT' AND rp.effective_from<=clock_timestamp() AND (rp.effective_until IS NULL OR rp.effective_until>clock_timestamp())
          AND m.unit_cost_micros*(p.input_budget+p.output_budget)<=LEAST(rp.max_cost_micros,p.max_provider_cost_microunits)) THEN why := 'ROUTE_STALE';
    ELSIF p_block IS NOT NULL THEN why := p_block;
    ELSIF NOT p_ready THEN why := 'CONFIGURATION_REQUIRED'; END IF;
  END IF;
  -- S4: pause, access and the school's own AI limit (decided here so the row says why), then the organization budget.
  IF why IS NULL AND hon.ai_spend_allowed(i.organization_id,i.school_id,clock_timestamp(),'AGENT_INFERENCE') IS NOT NULL THEN why := 'AI_SPEND_STOPPED'; END IF;
  IF why IS NULL AND hon.ai_org_committed_credits(i.organization_id,clock_timestamp())+p.customer_credit_estimate>hon.ai_org_ceiling(i.organization_id,clock_timestamp()) THEN
    why := 'CUSTOMER_BUDGET_EXCEEDED';
  END IF;
  UPDATE hon.ai_text_proposals SET plan_id=coalesce(p.id,plan_id),
    status=CASE WHEN why IS NULL THEN 'SENDING' WHEN why='CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED' ELSE 'BLOCKED' END,
    reason=why, reserved_credits=CASE WHEN why IS NULL THEN p.customer_credit_estimate ELSE 0 END, updated_at=clock_timestamp() WHERE id=i.id;
  UPDATE hon.work_items SET status=CASE WHEN why IS NULL THEN 'WORKING' ELSE 'NEEDS_ATTENTION' END,version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;
  PERFORM hon.ai_text_event(i.id,CASE WHEN why IS NULL THEN 'prepared' ELSE 'blocked' END);
  IF why IS NOT NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('providerId',p.provider_id,'modelId',p.model_id,'providerRequestId',i.provider_request_id,
    'inputBudget',p.input_budget,'outputBudget',p.output_budget,'maxCostMicrounits',p.max_provider_cost_microunits);
END $$;

-- The provider call did not give a usable answer. UNKNOWN keeps the hold for the HQ owner's resolution.
CREATE FUNCTION hon.ai_text_fail(p_id uuid, p_requested_by uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.ai_text_proposals%ROWTYPE;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('PRE_SEND','FAILED','UNKNOWN')
    OR p_reason IS NULL OR p_reason NOT IN ('CONFIGURATION_REQUIRED','UNSUPPORTED_PROVIDER','INVALID_REQUEST','PROVIDER_REJECTED','PROVIDER_UNKNOWN') THEN
    RAISE EXCEPTION 'INVALID_AI_TEXT_OUTCOME' USING ERRCODE='22023';
  END IF;
  i := hon.ai_text_row(p_id, p_requested_by);
  IF i.status<>'SENDING' THEN RAISE EXCEPTION 'AI_TEXT_OUTCOME_REPLAY' USING ERRCODE='40001'; END IF;
  UPDATE hon.ai_text_proposals SET status=CASE WHEN p_outcome='PRE_SEND' THEN 'CONFIGURATION_REQUIRED' ELSE p_outcome END, reason=p_reason,
    reserved_credits=CASE WHEN p_outcome='UNKNOWN' THEN reserved_credits ELSE 0 END, updated_at=clock_timestamp() WHERE id=i.id;
  UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;
  PERFORM hon.ai_text_event(i.id,'provider_result');
END $$;

-- Evidence first (S4-a): exactly one ledger row for a SENDING proposal with a plan, then the result. A result the kind's
-- validator refused is RESULT_REJECTED with its usage recorded (a paid answer is never turned into UNKNOWN). Usage beyond
-- the plan is FAILED/RESULT_BUDGET_EXCEEDED and keeps no result. Access is not re-checked here, so a call that was in
-- flight when access lapsed still records what it cost; the kind's apply path checks access again.
CREATE FUNCTION hon.ai_text_record(p_id uuid, p_requested_by uuid, p_usage jsonb, p_result jsonb, p_problems jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.ai_text_proposals%ROWTYPE := hon.ai_text_row(p_id, p_requested_by); k hon.ai_text_kinds%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE;
  uid uuid; credits integer; over boolean; v_next text;
BEGIN
  IF i.status<>'SENDING' OR i.usage_id IS NOT NULL OR i.plan_id IS NULL THEN RAISE EXCEPTION 'AI_TEXT_OUTCOME_REPLAY' USING ERRCODE='40001'; END IF;
  SELECT * INTO STRICT k FROM hon.ai_text_kinds WHERE kind=i.kind;
  SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id=i.plan_id;
  IF p_usage IS NULL OR jsonb_typeof(p_usage)<>'object'
    OR coalesce((SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_usage) x), ARRAY[]::text[]) <> ARRAY['inputTokens','outputTokens','providerCostMicrounits']
    OR jsonb_typeof(p_usage->'inputTokens')<>'number' OR (p_usage->>'inputTokens') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_usage->'outputTokens')<>'number' OR (p_usage->>'outputTokens') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_usage->'providerCostMicrounits')<>'number' OR (p_usage->>'providerCostMicrounits') !~ '^(0|[1-9][0-9]{0,9})$'
    OR p_result IS NULL OR length(p_result::text)>k.max_result_bytes
    OR p_problems IS NULL OR jsonb_typeof(p_problems)<>'array' OR jsonb_array_length(p_problems)>50 OR length(p_problems::text)>8192
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_problems) e WHERE jsonb_typeof(e)<>'string' OR length(e#>>'{}') NOT BETWEEN 1 AND 160) THEN
    RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023';
  END IF;
  credits := ((p_usage->>'inputTokens')::integer+(p_usage->>'outputTokens')::integer+999)/1000;
  over := (p_usage->>'inputTokens')::integer>p.input_budget OR (p_usage->>'outputTokens')::integer>p.output_budget
    OR (p_usage->>'providerCostMicrounits')::bigint>p.max_provider_cost_microunits OR credits>i.reserved_credits;
  INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,
      provider_cost_microunits,customer_credits,correlation_id,source_invocation_id,spend_class)
    VALUES(i.organization_id,i.school_id,i.requested_by,i.work_item_id,p.provider_id,p.model_id,'TEXT',(p_usage->>'inputTokens')::bigint,(p_usage->>'outputTokens')::bigint,
      (p_usage->>'providerCostMicrounits')::bigint,credits,nullif(current_setting('app.hon_request_id',true),'')::uuid,i.id,'AGENT_INFERENCE') RETURNING id INTO uid;
  v_next := CASE WHEN over THEN 'FAILED' WHEN jsonb_array_length(p_problems)>0 THEN 'RESULT_REJECTED' ELSE 'RESULT_RECORDED' END;
  UPDATE hon.ai_text_proposals SET usage_id=uid, reserved_credits=0, status=v_next,
    reason=CASE v_next WHEN 'FAILED' THEN 'RESULT_BUDGET_EXCEEDED' WHEN 'RESULT_REJECTED' THEN 'RESULT_INVALID' END,
    result=CASE WHEN over THEN NULL ELSE p_result END, result_problems=CASE WHEN v_next='RESULT_REJECTED' THEN p_problems END, updated_at=clock_timestamp()
    WHERE id=i.id;
  UPDATE hon.work_items SET status=CASE WHEN v_next='RESULT_RECORDED' THEN 'WAITING_FOR_APPROVAL' ELSE 'FAILED' END,version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;
  PERFORM hon.ai_text_event(i.id,CASE v_next WHEN 'FAILED' THEN 'budget_failed' WHEN 'RESULT_REJECTED' THEN 'result_rejected' ELSE 'result_recorded' END);
  RETURN v_next;
END $$;

-- APPLIED (from RESULT_RECORDED) or DISMISSED (from RESULT_RECORDED or RESULT_REJECTED). Replaying the same close is a no-op.
CREATE FUNCTION hon.ai_text_close(p_id uuid, p_requested_by uuid, p_status text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.ai_text_proposals%ROWTYPE;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('APPLIED','DISMISSED') THEN RAISE EXCEPTION 'INVALID_AI_TEXT_PROPOSAL' USING ERRCODE='22023'; END IF;
  i := hon.ai_text_row(p_id, p_requested_by);
  IF i.status=p_status THEN RETURN; END IF;
  IF NOT (i.status='RESULT_RECORDED' OR (p_status='DISMISSED' AND i.status='RESULT_REJECTED')) THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_OPEN' USING ERRCODE='40001'; END IF;
  UPDATE hon.ai_text_proposals SET status=p_status, updated_at=clock_timestamp() WHERE id=i.id;
  UPDATE hon.work_items SET status=CASE WHEN p_status='APPLIED' THEN 'COMPLETED' ELSE 'FAILED' END,version=version+1,updated_at=clock_timestamp()
    WHERE id=i.work_item_id AND status<>'FAILED';
  PERFORM hon.ai_text_event(i.id,lower(p_status));
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- S4 wiring: each body is the cited latest body plus hon.ai_text_proposals.
-- ---------------------------------------------------------------------------------------------------------------
-- 0210 body plus the shared text caller.
CREATE OR REPLACE FUNCTION hon.ai_org_committed_credits(p_org uuid, p_at timestamptz) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  -- Agent-inference ledger credits in the window plus every agent hold that counts (hon.ai_hold_counts), across all
  -- six agent callers (three specialists, the HON reply, parent Eian turns and the shared text proposals) and all schools of the organization. Callers hold ai.budget:<org> (hon.ai_budget_lock) and evaluate
  -- this in a statement that starts after the lock (READ COMMITTED), so every earlier committed hold is visible.
  -- A hold's time is its immutable held_at (stamped when the hold was taken), never the mutable updated_at.
  WITH w AS (SELECT hon.ai_spend_window(p_org, p_at) AS r)
  SELECT (SELECT coalesce(sum(u.customer_credits),0) FROM hon.ai_usage_ledger u, w
           WHERE u.organization_id=p_org AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=lower(w.r) AND u.occurred_at<upper(w.r))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.marketing_ai_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.teaching_ai_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.chad_follow_up_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.hon_reply_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.eian_turns i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.ai_text_proposals i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at));
$$;

-- 0288 body plus the shared text caller.
CREATE OR REPLACE FUNCTION hon.ai_school_committed_cost_micros(p_org uuid, p_school uuid, p_at timestamptz) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH w AS (SELECT hon.ai_spend_window(p_org, p_at) AS r)
  SELECT (SELECT coalesce(sum(u.provider_cost_microunits),0) FROM hon.ai_usage_ledger u, w
           WHERE u.organization_id=p_org AND u.school_id=p_school AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=lower(w.r) AND u.occurred_at<upper(w.r))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.marketing_ai_invocations i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.teaching_ai_invocations i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.chad_follow_up_invocations i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.hon_reply_invocations i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.eian_turns i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.ai_text_proposals i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at));
$$;

-- 0272 body plus the shared text caller.
CREATE OR REPLACE FUNCTION hon.ai_org_open_agent_holds(p_org uuid)
RETURNS TABLE(held_at timestamptz, status text, reserved_credits bigint, max_provider_cost_microunits bigint)
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.marketing_ai_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.teaching_ai_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.chad_follow_up_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.hon_reply_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.eian_turns i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.ai_text_proposals i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0;
$$;

ALTER TABLE hon.ai_unknown_resolutions DROP CONSTRAINT ai_unknown_resolutions_agent_check;
ALTER TABLE hon.ai_unknown_resolutions ADD CONSTRAINT ai_unknown_resolutions_agent_check CHECK (agent IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY','EIAN','TEXT_PROPOSAL'));
ALTER TABLE hon.ai_late_provider_expenses DROP CONSTRAINT ai_late_provider_expenses_agent_check;
ALTER TABLE hon.ai_late_provider_expenses ADD CONSTRAINT ai_late_provider_expenses_agent_check CHECK (agent IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY','EIAN','TEXT_PROPOSAL'));

-- 0210 body plus the shared text caller.
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
          UNION ALL SELECT 'HON_REPLY',id,organization_id,school_id,status,reserved_credits,held_at FROM hon.hon_reply_invocations
          UNION ALL SELECT 'EIAN',id,organization_id,school_id,status,reserved_credits,held_at FROM hon.eian_turns
          UNION ALL SELECT 'TEXT_PROPOSAL',id,organization_id,school_id,status,reserved_credits,held_at FROM hon.ai_text_proposals) a
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

-- 0210 body plus TEXT_PROPOSAL.
CREATE OR REPLACE FUNCTION hon.ai_unknown_validate(p_agent text, p_input jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE e jsonb := p_input->'evidence'; d text := p_input->>'decision';
  nonneg CONSTANT text := '^(0|[1-9][0-9]{0,11})$'; ref CONSTANT text := '^[A-Za-z0-9._:-]{1,200}$';
BEGIN
  IF p_agent IS NULL OR p_agent NOT IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY','EIAN','TEXT_PROPOSAL') OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
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

-- 0210 body plus TEXT_PROPOSAL (hon.ai_text_proposals). The guard trigger lets status, reason, reserved_credits and the
-- usage id move once, which is exactly what a resolution writes.
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
    WHEN 'CHAD_FOLLOW_UP' THEN 'chad_follow_up_invocations' WHEN 'HON_REPLY' THEN 'hon_reply_invocations' WHEN 'EIAN' THEN 'eian_turns'
    WHEN 'TEXT_PROPOSAL' THEN 'ai_text_proposals' END;
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

-- 0210 body plus TEXT_PROPOSAL.
CREATE OR REPLACE FUNCTION hon.record_ai_late_provider_expense(p_subject text, p_agent text, p_id uuid, p_input jsonb, p_key uuid, p_request_id uuid, p_correlation_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; e jsonb := p_input->'evidence'; r hon.ai_unknown_resolutions%ROWTYPE; x hon.ai_late_provider_expenses%ROWTYPE;
  wl hon.ai_usage_ledger%ROWTYPE; receipt jsonb;
  nonneg CONSTANT text := '^(0|[1-9][0-9]{0,11})$'; ref CONSTANT text := '^[A-Za-z0-9._:-]{1,200}$';
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_id IS NULL OR p_key IS NULL OR p_request_id IS NULL OR p_correlation_id IS NULL OR p_agent IS NULL OR p_agent NOT IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY','EIAN','TEXT_PROPOSAL')
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

-- 0328 body plus the shared text caller: ledger rows and late expenses count under the kind's usage label; open holds count.
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
           -- 0267 and this migration: every analysis specialist shares HON's reply table; each counts under its own agent.
           WHEN EXISTS (SELECT 1 FROM hon.hon_reply_invocations i WHERE i.id = u.source_invocation_id)
             THEN (SELECT hon.ai_usage_reply_agent(i.specialist) FROM hon.hon_reply_invocations i WHERE i.id = u.source_invocation_id)
           -- 0474: parent Eian turns count under their own agent.
           WHEN EXISTS (SELECT 1 FROM hon.eian_turns i WHERE i.id = u.source_invocation_id) THEN 'EIAN'
           -- 0550: each shared text proposal counts under its kind's own usage label.
           WHEN EXISTS (SELECT 1 FROM hon.ai_text_proposals i WHERE i.id = u.source_invocation_id)
             THEN (SELECT k.usage_agent FROM hon.ai_text_proposals i JOIN hon.ai_text_kinds k ON k.kind = i.kind WHERE i.id = u.source_invocation_id)
           ELSE 'UNATTRIBUTED' END AS agent,
      EXISTS (SELECT 1 FROM hon.ai_unknown_resolutions r WHERE r.ledger_entry_id = u.id AND r.decision = 'WRITE_OFF') AS write_off,
      EXISTS (SELECT 1 FROM hon.ai_unknown_resolutions r JOIN hon.ai_late_provider_expenses l ON l.resolution_id = r.id
              WHERE r.ledger_entry_id = u.id AND r.decision = 'WRITE_OFF') AS superseded,
      false AS late
    FROM hon.ai_usage_ledger u
    WHERE u.occurred_at >= p_from AND u.occurred_at < p_to
    UNION ALL
    -- Late actuals: provider expense evidence only (no ledger row, no customer credits), in their original window.
    SELECT l.organization_id, l.school_id, 'AGENT_INFERENCE', 0, l.provider_cost_microunits,
      CASE WHEN l.agent = 'HON_REPLY'
           THEN coalesce((SELECT hon.ai_usage_reply_agent(i.specialist) FROM hon.hon_reply_invocations i WHERE i.id = l.invocation_id), 'HON_REPLY')
           WHEN l.agent = 'TEXT_PROPOSAL'
           THEN coalesce((SELECT k.usage_agent FROM hon.ai_text_proposals i JOIN hon.ai_text_kinds k ON k.kind = i.kind WHERE i.id = l.invocation_id), 'TEXT_PROPOSAL')
           ELSE l.agent END, false, false, true
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
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.hon_reply_invocations
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.eian_turns
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.ai_text_proposals) h
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
        'agentCeilingCredits', hon.ai_org_display_ceiling(o.organization_id, at),
        'openUnknownHolds', (SELECT count(*) FROM (
            SELECT status, held_at, reserved_credits FROM hon.marketing_ai_invocations WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.teaching_ai_invocations WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.chad_follow_up_invocations WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.hon_reply_invocations WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.eian_turns WHERE organization_id = o.organization_id
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.ai_text_proposals WHERE organization_id = o.organization_id) h
          WHERE h.reserved_credits > 0 AND (h.status = 'UNKNOWN' OR (h.status = 'SENDING' AND h.held_at <= at - hon.ai_sending_stale_after()))),
        'aiPaused', EXISTS (SELECT 1 FROM hon.ai_spend_pauses p WHERE p.ended_at IS NULL AND (p.organization_id = o.organization_id OR p.organization_id IS NULL)))
        ORDER BY o.organization_id)
      FROM orgs o CROSS JOIN LATERAL (SELECT hon.ai_spend_window(o.organization_id, at) AS r) w), '[]'::jsonb),
    'providerCostUnit', 'MICROUNITS_USD')
  INTO result;
  RETURN result;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Kind WEBSITE_EDIT (WB5): Marcus proposes changes to this school's website draft. HUMAN_UI only, school owner.
-- ---------------------------------------------------------------------------------------------------------------
INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('WEBSITE_EDIT','marcus','DRAFT_MARKETING',16000,4000,150000,24576,'HUMAN_UI','SCHOOL_WEBSITE','WEBSITE_EDIT');

-- The requester: website.edit at this school (0361 rules) plus the Marcus capability. ai.invocation.plan and the
-- Complete entitlement are decided again by plan_ai_invocation; they are checked here first so the owner learns early.
CREATE FUNCTION hon.school_website_ai_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_school_website_actor(p_subject,'website.edit'); org uuid := hon.current_organization_id(); school uuid := hon.current_school_id();
BEGIN
  IF NOT hon.principal_has_school_permission(actor,org,school,'marketing.assistant.use') OR NOT hon.principal_has_school_permission(actor,org,school,'ai.invocation.plan')
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.tier='COMPLETE' AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'SCHOOL_WEBSITE_AI_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- What a proposal may hold: a summary and up to 25 edits from the closed list. Each edit's fields are checked again in
-- full when the owner applies it, because applying is an ordinary draft save that re-validates the whole document.
CREATE FUNCTION hon.school_website_ai_proposal_ok(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT r IS NOT NULL AND jsonb_typeof(r)='object' AND hon.school_website_keys_are(r,ARRAY['edits','summary'])
    AND jsonb_typeof(r->'summary')='string' AND length(r->>'summary') BETWEEN 1 AND 300 AND hon.school_website_field_ok('p300',r->'summary')
    AND jsonb_typeof(r->'edits')='array' AND jsonb_array_length(r->'edits')<=25 AND octet_length(convert_to(r::text,'UTF8'))<=24576
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'edits') e WHERE jsonb_typeof(e)<>'object' OR jsonb_typeof(e->'op')<>'string'
      OR e->>'op' NOT IN ('setText','addSection','removeSection','moveSection','addPage','removePage','setPage','setTheme') OR length(e::text)>4000)
$$;

-- The facts Marcus sees: the site name, theme and page outline from the current draft, with long text shortened, at most
-- 10 KB. No visitor, lead, student, family or billing data exists in a website document.
CREATE FUNCTION hon.school_website_ai_facts(p_doc jsonb, p_name text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE f jsonb; n integer;
BEGIN
  FOREACH n IN ARRAY ARRAY[160,60,0] LOOP
    SELECT jsonb_build_object('name',p_name,'theme',p_doc->'theme','pages',coalesce(jsonb_agg(jsonb_build_object('slug',p->>'slug','kind',p->>'kind','title',p->>'title',
        'inNav',p->'inNav','sections',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s->>'id','type',s->>'type') || CASE WHEN n=0 THEN '{}'::jsonb ELSE
          jsonb_build_object('props',(SELECT coalesce(jsonb_object_agg(x.key, CASE jsonb_typeof(x.value) WHEN 'string' THEN to_jsonb(left(x.value#>>'{}',n))
            WHEN 'array' THEN CASE WHEN n=160 THEN x.value ELSE jsonb_build_object('items',jsonb_array_length(x.value)) END ELSE x.value END),'{}'::jsonb)
            FROM jsonb_each(s->'props') x)) END),'[]'::jsonb) FROM jsonb_array_elements(p->'sections') s))),'[]'::jsonb))
      INTO f FROM jsonb_array_elements(p_doc->'pages') p;
    IF octet_length(convert_to(f::text,'UTF8'))<=10240 THEN RETURN f; END IF;
  END LOOP;
  RETURN jsonb_build_object('name',p_name,'pages',(SELECT jsonb_agg(jsonb_build_object('slug',p->>'slug','title',left(p->>'title',40))) FROM jsonb_array_elements(p_doc->'pages') p));
END $$;

CREATE FUNCTION hon.school_website_ai_view(p_id uuid, p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',i.id,'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,
    'reason',i.reason,'request',i.request->>'request','baseRevision',i.subject_version,'mine',i.requested_by=p_actor,
    'summary',CASE WHEN i.result IS NOT NULL THEN i.result->>'summary' END,
    'edits',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->'edits' END,
    'problems',coalesce(i.result_problems,'[]'::jsonb),
    'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.ai_text_proposals i
  WHERE i.id=p_id AND i.kind='WEBSITE_EDIT' AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
$$;

-- Entry points (granted to hon_runtime). A HUMAN_UI school owner only; the requester alone moves their own proposal.
CREATE FUNCTION hon.begin_school_website_ai_edit(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.school_website_ai_actor(p_subject); w hon.school_websites%ROWTYPE; pid uuid;
BEGIN
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR NOT hon.school_website_keys_are(p_input,ARRAY['expectedRevision','request'])
    OR jsonb_typeof(p_input->'expectedRevision')<>'number' OR (p_input->>'expectedRevision') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'request')<>'string' OR (p_input->>'request')<>btrim(p_input->>'request') OR NOT hon.marketing_safe_text(p_input->>'request',1000) THEN
    RAISE EXCEPTION 'SCHOOL_WEBSITE_AI_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO w FROM hon.school_websites WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- A new request must name the current draft; an exact retry of an accepted request replays even after later saves.
  IF (p_input->>'expectedRevision')::integer<>w.draft_revision
    AND NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE kind='WEBSITE_EDIT' AND origin_key=actor::text||':'||p_key::text) THEN
    RAISE EXCEPTION 'SCHOOL_WEBSITE_AI_STALE' USING ERRCODE='40001';
  END IF;
  pid := hon.ai_text_begin('WEBSITE_EDIT',actor,actor::text||':'||p_key::text,w.id,(p_input->>'expectedRevision')::integer,
    jsonb_build_object('request',p_input->>'request'));
  IF hon.school_website_ai_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_AI_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.school_website_ai_view(pid,actor);
END $$;

CREATE FUNCTION hon.school_website_ai_edit_planning_reference(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  RETURN hon.ai_text_planning_reference(p_id, hon.school_website_ai_actor(p_subject));
END $$;

-- The final claim. The budget lock comes first (inside the core's first declaration, before the actor gate takes any
-- row lock), so the gate runs after it here: authority, then the draft revision, then the core claim, then the facts.
CREATE FUNCTION hon.prepare_school_website_ai_edit(p_subject text, p_id uuid, p_plan uuid, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id()); actor uuid := hon.school_website_ai_actor(p_subject);
  i hon.ai_text_proposals%ROWTYPE; w hon.school_websites%ROWTYPE; inv jsonb;
BEGIN
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'WEBSITE_EDIT' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO w FROM hon.school_websites WHERE id=i.subject_id AND organization_id=i.organization_id AND school_id=i.school_id FOR SHARE;
  inv := hon.ai_text_prepare(p_id, actor, p_plan, p_ready, CASE WHEN NOT FOUND OR w.draft_revision<>i.subject_version THEN 'SUBJECT_STALE' END);
  IF inv IS NULL THEN RETURN NULL; END IF;
  RETURN inv || jsonb_build_object('request',jsonb_build_object('ownerRequest',i.request->>'request','site',hon.school_website_ai_facts(w.draft_document,w.name))::text);
END $$;

-- Outcome writers resolve the human requester only (0193 evidence rule): a call in flight when access lapsed still records.
CREATE FUNCTION hon.fail_school_website_ai_edit(p_subject text, p_id uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='WEBSITE_EDIT') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(p_id, actor, p_outcome, p_reason);
END $$;

-- p_result = {usage, proposal, problems}: the API's usage evidence, Marcus's proposal and the problems the API found when
-- it tried the edits on the draft. A proposal that is not in the closed shape is stored empty and rejected.
CREATE FUNCTION hon.record_school_website_ai_edit(p_subject text, p_id uuid, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); proposal jsonb; problems jsonb; status text;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='WEBSITE_EDIT') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR NOT hon.school_website_keys_are(p_result,ARRAY['problems','proposal','usage']) THEN
    RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023';
  END IF;
  proposal := p_result->'proposal'; problems := p_result->'problems';
  IF NOT hon.school_website_ai_proposal_ok(proposal) THEN
    proposal := jsonb_build_object('summary','','edits','[]'::jsonb);
    problems := CASE WHEN jsonb_typeof(problems)='array' THEN problems ELSE '[]'::jsonb END || to_jsonb('The answer was not a website edit list.'::text);
  END IF;
  status := hon.ai_text_record(p_id, actor, p_result->'usage', proposal, problems);
  RETURN hon.school_website_ai_view(p_id, actor) || jsonb_build_object('recorded',status);
END $$;

-- The school's recent website proposals (newest 20) for anyone who may edit the website, or one by id.
CREATE FUNCTION hon.read_school_website_ai_edits(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_school_website_actor(p_subject,'website.edit'); v jsonb;
BEGIN
  IF p_id IS NOT NULL THEN
    v := hon.school_website_ai_view(p_id, actor);
    IF v IS NULL THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    RETURN v;
  END IF;
  RETURN coalesce((SELECT jsonb_agg(hon.school_website_ai_view(x.id, actor) ORDER BY x.created_at DESC, x.id)
    FROM (SELECT id, created_at FROM hon.ai_text_proposals WHERE kind='WEBSITE_EDIT' AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
      ORDER BY created_at DESC, id LIMIT 20) x),'[]'::jsonb);
END $$;

-- APPLIED after the owner saved the edits as the draft (0361 save), or DISMISSED. The requester only.
CREATE FUNCTION hon.close_school_website_ai_edit(p_subject text, p_id uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_school_website_actor(p_subject,'website.edit');
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='WEBSITE_EDIT') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_close(p_id, actor, p_status);
  RETURN hon.school_website_ai_view(p_id, actor);
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges: deny first, then exactly the seven WEBSITE_EDIT entry points for the runtime role.
-- ---------------------------------------------------------------------------------------------------------------
DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['ai_text_kinds','ai_text_proposals'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_ai_text_proposals()','hon.ai_text_event(uuid,text)',
    'hon.ai_text_begin(text,uuid,text,uuid,integer,jsonb)','hon.ai_text_row(uuid,uuid)','hon.ai_text_planning_reference(uuid,uuid)',
    'hon.ai_text_prepare(uuid,uuid,uuid,boolean,text)','hon.ai_text_fail(uuid,uuid,text,text)','hon.ai_text_record(uuid,uuid,jsonb,jsonb,jsonb)',
    'hon.ai_text_close(uuid,uuid,text)',
    'hon.school_website_ai_actor(text)','hon.school_website_ai_proposal_ok(jsonb)','hon.school_website_ai_facts(jsonb,text)','hon.school_website_ai_view(uuid,uuid)',
    'hon.begin_school_website_ai_edit(text,jsonb,uuid)','hon.school_website_ai_edit_planning_reference(text,uuid)',
    'hon.prepare_school_website_ai_edit(text,uuid,uuid,boolean)','hon.fail_school_website_ai_edit(text,uuid,text,text)',
    'hon.record_school_website_ai_edit(text,uuid,jsonb)','hon.read_school_website_ai_edits(text,uuid)','hon.close_school_website_ai_edit(text,uuid,text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_school_website_ai_edit(text,jsonb,uuid), hon.school_website_ai_edit_planning_reference(text,uuid),
      hon.prepare_school_website_ai_edit(text,uuid,uuid,boolean), hon.fail_school_website_ai_edit(text,uuid,text,text),
      hon.record_school_website_ai_edit(text,uuid,jsonb), hon.read_school_website_ai_edits(text,uuid), hon.close_school_website_ai_edit(text,uuid,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
