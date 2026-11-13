BEGIN;

-- 0336 (RA-1): reduced-AI mode for HON and the analysis specialists that answer through HON's reply table (Claire, Alex,
-- Jordan, Lena, Maya). Spec: docs/architecture/AI_REDUCED_MODE.md. Stand-in providers only; nothing activates a provider.
-- 1. A new definite failure reason, PROVIDER_UNAVAILABLE (the runtime gives it for HTTP 404, 429 and OpenRouter's 503
--    "no available provider"): FAILED, the hold is released, nothing is charged. 502, 504, timeouts and anything else
--    stay UNKNOWN and are never resent.
-- 2. One automatic fallback. When the failed call's plan was its HQ task profile's DEFAULT and that profile's
--    retryCategory is TRANSIENT_ONCE, hon.reopen_hon_reply_for_fallback records the failed attempt immutably
--    (hon.ai_route_unavailable_attempts, at most one per reply) and puts the reply back to PENDING with a new provider
--    request id. The planner then never chooses that model again for that work item, so the second plan is the profile's
--    first eligible FALLBACK (or no route). Every prepare check, the budget lock, the access decision, pauses and
--    ceilings apply again. A turn makes at most two provider calls; the second failure is final.
-- 3. hon_reply_planning_reference returns planKey: the invocation id for the first plan, the attempt id for the fallback.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.ai_route_task_category(text,text)') IS NULL THEN RAISE EXCEPTION 'Apply routing migration 0287 first'; END IF;
END $$;

-- Immutable evidence of a model that was definitely unavailable for one reply. Never updated or deleted.
CREATE TABLE hon.ai_route_unavailable_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  work_item_id uuid NOT NULL REFERENCES hon.work_items(id),
  invocation_id uuid NOT NULL UNIQUE REFERENCES hon.hon_reply_invocations(id),
  plan_id uuid NOT NULL UNIQUE REFERENCES hon.ai_invocation_plans(id),
  catalog_id uuid NOT NULL,
  failed_provider_request_id uuid NOT NULL UNIQUE,
  reason text NOT NULL CHECK (reason = 'PROVIDER_UNAVAILABLE'),
  failed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ai_route_unavailable_attempts_work_idx ON hon.ai_route_unavailable_attempts(work_item_id, catalog_id);
ALTER TABLE hon.ai_route_unavailable_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_route_unavailable_attempts FORCE ROW LEVEL SECURITY;
CREATE FUNCTION hon.ai_route_unavailable_attempts_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'AI_ROUTE_ATTEMPT_IMMUTABLE' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER ai_route_unavailable_attempts_immutable BEFORE UPDATE OR DELETE ON hon.ai_route_unavailable_attempts
  FOR EACH ROW EXECUTE FUNCTION hon.ai_route_unavailable_attempts_immutable();
CREATE TRIGGER ai_route_unavailable_attempts_no_truncate BEFORE TRUNCATE ON hon.ai_route_unavailable_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION hon.ai_route_unavailable_attempts_immutable();

-- RA-1: the one fallback. Only this human's own reply, FAILED as PROVIDER_UNAVAILABLE, nothing held or recorded, planned
-- as its profile's DEFAULT, with that profile (as planned) still on TRANSIENT_ONCE. Returns true when reopened.
CREATE FUNCTION hon.reopen_hon_reply_for_fallback(p_subject text, p_turn uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); i hon.hon_reply_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE;
BEGIN
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM hon.work_items WHERE id = i.work_item_id FOR UPDATE;
  PERFORM hon.hon_conversation_hold_actor(p_subject, actor);
  IF i.status <> 'FAILED' OR i.reason IS DISTINCT FROM 'PROVIDER_UNAVAILABLE' OR i.plan_id IS NULL OR i.usage_id IS NOT NULL
     OR i.reserved_credits <> 0 OR EXISTS (SELECT 1 FROM hon.ai_route_unavailable_attempts a WHERE a.invocation_id = i.id) THEN
    RETURN false;
  END IF;
  SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id = i.plan_id;
  IF p.route_selection <> 'PROFILE_DEFAULT' OR NOT EXISTS (SELECT 1 FROM hon.hq_ai_task_profiles tp
       WHERE tp.profile_id = p.task_profile_id AND tp.version = p.task_profile_version AND tp.retry_category = 'TRANSIENT_ONCE') THEN
    RETURN false;
  END IF;
  INSERT INTO hon.ai_route_unavailable_attempts(organization_id, school_id, work_item_id, invocation_id, plan_id, catalog_id, failed_provider_request_id, reason)
  VALUES (i.organization_id, i.school_id, i.work_item_id, i.id, p.id, p.catalog_id, i.provider_request_id, 'PROVIDER_UNAVAILABLE');
  UPDATE hon.hon_reply_invocations SET status = 'PENDING', reason = NULL, plan_id = NULL, provider_request_id = gen_random_uuid(),
    updated_at = clock_timestamp() WHERE id = i.id;
  UPDATE hon.work_items SET status = 'READY', version = version + 1, updated_at = clock_timestamp() WHERE id = i.work_item_id;
  RETURN true;
END $$;

-- 0287 body; only the profile candidate filter adds the 0336 exclusion.
CREATE OR REPLACE FUNCTION hon.plan_ai_invocation(p_work_id uuid, p_data jsonb, p_key uuid, p_request_id uuid, p_correlation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$
DECLARE
  v_org uuid := hon.current_organization_id(); v_school uuid := hon.current_school_id();
  v_actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
  v_work hon.work_items%ROWTYPE; v_policy hon.hq_ai_routing_policies%ROWTYPE;
  v_choice record; v_plan_id uuid; v_hash text; v_existing hon.idempotency_records%ROWTYPE;
  v_response jsonb; v_payload jsonb; v_units integer; v_credits integer; v_used numeric;
  v_denial text; v_risk text; v_replay_id text; v_replay jsonb; v_found boolean;
  -- 0287: routing by task class through the single active HQ task profile for this agent and code-owned category.
  v_category text; v_profiles integer := 0; v_profile hon.hq_ai_task_profiles%ROWTYPE;
BEGIN
  PERFORM hon.require_ai_invocation_plan_access();
  PERFORM hon.validate_ai_invocation_plan_input(p_data);
  -- 0212: each agent is planned only by a principal holding that agent's own capability permission (profile-only agents never).
  PERFORM hon.require_ai_agent_capability(p_data->>'agentKey');
  IF p_work_id IS NULL OR p_key IS NULL OR p_request_id IS NULL OR p_correlation_id IS NULL
    OR p_request_id IS DISTINCT FROM nullif(current_setting('app.hon_request_id', true), '')::uuid THEN
    RAISE EXCEPTION 'AI planning request identifiers required' USING ERRCODE = '22023';
  END IF;
  SELECT id, work_type, version, status INTO v_work.id, v_work.work_type, v_work.version, v_work.status
  FROM hon.work_items WHERE id = p_work_id AND organization_id = v_org AND school_id = v_school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Scoped durable work item not found' USING ERRCODE = 'P0002'; END IF;
  -- jsonb textual ordering gives an order-independent deterministic metadata
  -- fingerprint. Neither work payload/result nor prompts enter this hash.
  v_hash := encode(sha256(convert_to(jsonb_build_object('command','ai.invocation.plan','organizationId',v_org,'schoolId',v_school,'workItemId',p_work_id,'input',p_data)::text, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_school::text || ':' || v_actor::text || ':' || p_key::text, 0));
  SELECT * INTO v_existing FROM hon.idempotency_records
    WHERE organization_id = v_org AND school_id = v_school AND principal_id = v_actor AND idempotency_key = p_key::text FOR UPDATE;
  v_found := FOUND;
  -- 0212: live authority after every wait, for the replay and the fresh plan alike.
  PERFORM hon.hold_and_recheck_ai_planning_authority(p_data->>'agentKey');
  IF v_found THEN
    IF v_existing.request_fingerprint <> v_hash THEN RAISE EXCEPTION 'AI planning idempotency conflict' USING ERRCODE = '23505'; END IF;
    IF v_existing.status <> 'COMPLETED' OR v_existing.response_body IS NULL THEN RAISE EXCEPTION 'AI planning request in progress' USING ERRCODE = '40001'; END IF;
    v_replay_id := v_existing.response_body->'plan'->>'id';
    IF v_replay_id IS NULL OR v_replay_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'AI planning replay is not bound to an authoritative plan' USING ERRCODE = '23505';
    END IF;
    SELECT hon.ai_invocation_plan_summary(p.id) INTO v_replay FROM hon.ai_invocation_plans p
    WHERE p.id = v_replay_id::uuid AND p.organization_id = v_org AND p.school_id = v_school
      AND p.work_item_id = p_work_id AND p.request_hash = v_hash
      AND EXISTS (SELECT 1 FROM hon.audit_events a WHERE a.organization_id = v_org AND a.school_id = v_school
        AND a.actor_principal_id = v_actor AND a.entity_id = p.id AND a.action_code = 'ai.invocation.plan'
        AND a.entity_type = 'AI_INVOCATION_PLAN' AND a.source = 'HUMAN_UI' AND a.result = 'SUCCEEDED');
    IF v_replay IS NULL THEN RAISE EXCEPTION 'AI planning replay does not match the scoped authoritative plan' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('status','PLANNED','plan',v_replay,'replayed',true,'authority','UNCHANGED','execution','NOT_PERFORMED');
  END IF;
  IF v_work.version <> (p_data->>'expectedVersion')::integer OR v_work.status <> p_data->>'expectedState' THEN
    RAISE EXCEPTION 'AI planning work item version/state conflict' USING ERRCODE = '40001';
  END IF;
  -- Risk is code-owned, not a caller or HQ routing assertion. Only these
  -- metadata-only work types are supported; sensitive/action tasks fail closed.
  IF v_work.work_type <> 'AI_' || (p_data->>'taskClass') THEN
    RAISE EXCEPTION 'AI planning task/work type is not approved' USING ERRCODE = '22023';
  END IF;
  v_risk := CASE p_data->>'taskClass' WHEN 'SUMMARIZE' THEN 'LOW' ELSE 'MODERATE' END;
  v_units := (p_data->>'inputBudget')::integer + (p_data->>'outputBudget')::integer;
  v_credits := (v_units + 999) / 1000;
  -- Estimate only: org-wide current UTC month usage affects eligibility but no
  -- allowance or ledger is updated, and plans are NOT reservations/charges.
  SELECT COALESCE(sum(customer_credits), 0) INTO v_used FROM hon.ai_usage_ledger
    WHERE organization_id = v_org AND spend_class = 'AGENT_INFERENCE' AND occurred_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      AND occurred_at < ((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC');
  IF v_used + v_credits > hon.ai_org_ceiling(v_org, now()) THEN v_denial := 'CUSTOMER_BUDGET_EXCEEDED'; END IF;
  -- Fail closed on absent or ambiguous active approved policies. No tenant may
  -- nominate a route/model or raise the platform risk/cost ceiling.
  IF v_denial IS NULL AND (SELECT count(*) FROM hon.hq_ai_routing_policies
    WHERE organization_id = v_org AND school_id = v_school AND capability = 'TEXT' AND active
      AND effective_from <= now() AND (effective_until IS NULL OR now() < effective_until)) <> 1 THEN
    v_denial := 'NO_ELIGIBLE_ROUTE';
  END IF;
  IF v_denial IS NULL THEN
    SELECT * INTO v_policy FROM hon.hq_ai_routing_policies WHERE organization_id = v_org AND school_id = v_school
      AND capability = 'TEXT' AND active AND effective_from <= now() AND (effective_until IS NULL OR now() < effective_until);
    v_category := hon.ai_route_task_category(p_data->>'agentKey', p_data->>'taskClass');
    IF v_category IS NOT NULL THEN
      SELECT count(*) INTO v_profiles FROM hon.hq_ai_task_profiles tp
      WHERE tp.routing_policy_id = v_policy.policy_id AND tp.agent_key = p_data->>'agentKey' AND tp.task_category = v_category
        AND tp.active AND tp.cost_unit = 'TOKEN' AND tp.effective_from <= now() AND (tp.effective_until IS NULL OR now() < tp.effective_until);
    END IF;
    IF v_profiles > 1 THEN
      -- Ambiguous HQ configuration fails closed, exactly as two active policies do.
      v_denial := 'NO_ELIGIBLE_ROUTE';
    ELSIF v_profiles = 1 THEN
      SELECT tp.* INTO STRICT v_profile FROM hon.hq_ai_task_profiles tp
      WHERE tp.routing_policy_id = v_policy.policy_id AND tp.agent_key = p_data->>'agentKey' AND tp.task_category = v_category
        AND tp.active AND tp.cost_unit = 'TOKEN' AND tp.effective_from <= now() AND (tp.effective_until IS NULL OR now() < tp.effective_until);
      -- The profile's DEFAULT, then its FALLBACKs in order; ADVANCED is never chosen here. Every legacy policy check applies,
      -- plus the profile's own cost ceiling, provider list, required capabilities/modalities and privacy controls.
      SELECT c.catalog_id, c.provider_id, c.model_id, c.version AS catalog_version, p.version AS provider_version,
        c.unit_cost_micros::numeric * v_units AS estimated_cost,
        CASE t.selection WHEN 'DEFAULT' THEN 'PROFILE_DEFAULT' ELSE 'PROFILE_FALLBACK' END AS route_selection INTO v_choice
      FROM hon.hq_ai_task_profile_candidates t
      JOIN hon.hq_ai_routing_candidates r ON r.policy_id = v_policy.policy_id AND r.catalog_id = t.catalog_id
      JOIN hon.hq_ai_model_catalog c ON c.catalog_id = t.catalog_id
      JOIN hon.hq_ai_provider_connections p ON p.provider_id = c.provider_id
      WHERE t.profile_id = v_profile.profile_id AND t.selection IN ('DEFAULT','FALLBACK')
        AND c.active AND c.cost_unit = 'TOKEN' AND 'TEXT' = ANY(c.capabilities) AND 'TEXT' = ANY(c.modalities)
        AND c.effective_from <= now() AND (c.effective_until IS NULL OR now() < c.effective_until)
        AND p.state = 'HEALTHY'
        -- 0336: a model that was definitely unavailable for this work item is never chosen again for it (RA-1 fallback).
        AND NOT EXISTS (SELECT 1 FROM hon.ai_route_unavailable_attempts ua WHERE ua.work_item_id = p_work_id AND ua.catalog_id = c.catalog_id)
        AND c.provider_id = ANY(v_profile.allowed_provider_ids)
        AND v_profile.required_capabilities <@ c.capabilities AND v_profile.required_modalities <@ c.modalities
        AND v_profile.privacy_controls <@ c.privacy_controls
        AND c.unit_cost_micros::numeric * v_units <= LEAST(v_policy.max_cost_micros, v_profile.max_cost_micros, (p_data->>'maxProviderCostMicrounits')::bigint)
      ORDER BY (t.selection = 'FALLBACK'), t.ordinal LIMIT 1;
      -- No escape to the policy order: a model HQ did not pick for this task is never used for it.
      IF NOT FOUND THEN v_denial := 'NO_ELIGIBLE_ROUTE'; END IF;
    ELSE
      SELECT c.catalog_id, c.provider_id, c.model_id, c.version AS catalog_version, p.version AS provider_version,
        c.unit_cost_micros::numeric * v_units AS estimated_cost, 'POLICY_ORDER'::text AS route_selection INTO v_choice
      FROM hon.hq_ai_routing_candidates r
      JOIN hon.hq_ai_model_catalog c ON c.catalog_id = r.catalog_id
      JOIN hon.hq_ai_provider_connections p ON p.provider_id = c.provider_id
      WHERE r.policy_id = v_policy.policy_id AND c.active AND c.cost_unit = 'TOKEN'
        AND 'TEXT' = ANY(c.capabilities) AND 'TEXT' = ANY(c.modalities)
        AND c.effective_from <= now() AND (c.effective_until IS NULL OR now() < c.effective_until)
        AND p.state = 'HEALTHY'
        AND c.unit_cost_micros::numeric * v_units <= LEAST(v_policy.max_cost_micros, (p_data->>'maxProviderCostMicrounits')::bigint)
      ORDER BY r.ordinal LIMIT 1;
      -- Complete exceeds every currently registered minimum tier; degraded is
      -- deliberately denied even if HQ preview policy permits it in other slices.
      IF NOT FOUND THEN v_denial := 'NO_ELIGIBLE_ROUTE'; END IF;
    END IF;
  END IF;
  IF v_denial IS NOT NULL THEN
    -- A denied choice is not a plan or a charge. Nothing is persisted, so a
    -- later retry may reevaluate live configuration; successful plans replay.
    RETURN jsonb_build_object('status','NO_CHOICE','reason',v_denial,'plan',NULL,'replayed',false,'authority','UNCHANGED','execution','NOT_PERFORMED');
  END IF;
  INSERT INTO hon.ai_invocation_plans (organization_id,school_id,work_item_id,work_item_version,work_item_state,
    agent_key,modality,task_class,risk_class,input_budget,output_budget,max_provider_cost_microunits,
    estimated_provider_cost_microunits,customer_credit_estimate,provider_id,model_id,catalog_id,catalog_version,
    routing_policy_id,routing_policy_version,provider_version,request_hash,task_profile_id,task_profile_version,route_selection)
  VALUES (v_org,v_school,p_work_id,v_work.version,v_work.status,p_data->>'agentKey','TEXT',p_data->>'taskClass',v_risk,
    (p_data->>'inputBudget')::integer,(p_data->>'outputBudget')::integer,(p_data->>'maxProviderCostMicrounits')::bigint,
    v_choice.estimated_cost::bigint,v_credits,v_choice.provider_id,v_choice.model_id,v_choice.catalog_id,v_choice.catalog_version,
    v_policy.policy_id,v_policy.version,v_choice.provider_version,v_hash,v_profile.profile_id,v_profile.version,v_choice.route_selection) RETURNING id INTO v_plan_id;
  v_response := jsonb_build_object('status','PLANNED','plan',hon.ai_invocation_plan_summary(v_plan_id),'replayed',false,'authority','UNCHANGED','execution','NOT_PERFORMED');
  v_payload := jsonb_build_object('planId',v_plan_id,'workItemId',p_work_id,'workItemVersion',v_work.version,'status','PLANNED','requestHash',v_hash,'estimatedProviderCostMicrounits',v_choice.estimated_cost,'customerCreditEstimate',v_credits,'execution','NOT_PERFORMED','authority','UNCHANGED');
  INSERT INTO hon.audit_events (organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,
    prior_state,next_state,result,request_id,correlation_id,action_request_id)
  VALUES (v_org,v_school,v_actor,'HUMAN_UI','ai.invocation.plan','AI_INVOCATION_PLAN',v_plan_id,NULL,v_payload,'SUCCEEDED',p_request_id,p_correlation_id,NULL);
  INSERT INTO hon.outbox_events (organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
  VALUES (v_org,v_school,'ai.invocation.planned',1,'AI_INVOCATION_PLAN',v_plan_id,1,p_correlation_id,p_request_id,v_payload);
  INSERT INTO hon.idempotency_records (organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,response_status,response_body,expires_at)
  VALUES (v_org,v_school,v_actor,p_key::text,v_hash,'COMPLETED',201,v_response,now() + interval '24 hours');
  RETURN v_response;
END $function$;

-- 0210 body; PROVIDER_UNAVAILABLE is accepted as a FAILED reason.
CREATE OR REPLACE FUNCTION hon.fail_hon_reply(p_subject text, p_turn uuid, p_outcome text, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); i hon.hon_reply_invocations%ROWTYPE;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('PRE_SEND', 'FAILED', 'UNKNOWN')
     OR p_reason IS NULL OR p_reason NOT IN ('CONFIGURATION_REQUIRED', 'UNSUPPORTED_PROVIDER', 'INVALID_REQUEST', 'PROVIDER_REJECTED', 'PROVIDER_UNKNOWN', 'PROVIDER_UNAVAILABLE') THEN
    RAISE EXCEPTION 'INVALID_HON_REPLY_OUTCOME' USING ERRCODE = '22023';
  END IF;
  -- 0336: PROVIDER_UNAVAILABLE is a definite outcome (the provider refused before generating): FAILED only.
  IF p_reason = 'PROVIDER_UNAVAILABLE' AND p_outcome <> 'FAILED' THEN
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

-- 0229 body plus planKey.
CREATE OR REPLACE FUNCTION hon.hon_reply_planning_reference(p_subject text, p_turn uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); i hon.hon_reply_invocations%ROWTYPE; v integer;
BEGIN
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF i.status <> 'PENDING' THEN RETURN NULL; END IF;
  SELECT version INTO v FROM hon.work_items WHERE id = i.work_item_id;
  -- 0336: the planning idempotency key. The first plan uses the invocation id; the one fallback plan uses its attempt id,
  -- so it never replays the plan whose model was unavailable.
  RETURN jsonb_build_object('invocationId', i.id, 'workItemId', i.work_item_id, 'workVersion', v, 'limits', hon.hon_reply_limits(i.reply_mode), 'agentKey', i.specialist,
    'planKey', coalesce((SELECT a.id FROM hon.ai_route_unavailable_attempts a WHERE a.invocation_id = i.id), i.id));
END $$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON TABLE hon.ai_route_unavailable_attempts FROM PUBLIC;
  REVOKE ALL ON FUNCTION hon.ai_route_unavailable_attempts_immutable() FROM PUBLIC;
  REVOKE ALL ON FUNCTION hon.reopen_hon_reply_for_fallback(text,uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.ai_route_unavailable_attempts FROM %I', r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.ai_route_unavailable_attempts_immutable() FROM %I', r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.reopen_hon_reply_for_fallback(text,uuid) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.reopen_hon_reply_for_fallback(text,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
