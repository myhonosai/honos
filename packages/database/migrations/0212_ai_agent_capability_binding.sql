BEGIN;

-- 0212 (proposed): per-agent AI capability binding in the planning boundary.
-- Until now hon.plan_ai_invocation required only the agent-agnostic ai.invocation.plan, so a principal with that permission
-- could plan any agent key, including profile-only specialists; each specialist service re-checked its own permission
-- afterwards. The planner now also requires the agent's own capability permission at this school, so the specialist check
-- becomes defence in depth. Agents without a working backend (alex, maya, jordan, lena, eian, and claire until it becomes
-- the Business Performance specialist) have no capability and cannot be planned. Teaching-only staff hold
-- teaching.assistant.use and can plan Kai without any CRM, marketing, billing or reporting permission.
-- No table, ledger, budget, approval or grant changes; plans and history are untouched.

-- The capability permission each plannable agent requires. NULL = not plannable.
CREATE FUNCTION hon.ai_agent_capability_permission(p_agent text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE p_agent
    WHEN 'hon' THEN 'ai.invocation.plan'            -- HON replies: school facts still need reporting.view (else NOT_AUTHORIZED)
    WHEN 'kai' THEN 'teaching.assistant.use'        -- Teaching & Curriculum
    WHEN 'marcus' THEN 'marketing.assistant.use'    -- Marketing drafts
    WHEN 'chad' THEN 'crm.assistant.follow_up_draft' -- Lead follow-up drafts (Chad also re-checks crm.lead.read)
  END
$$;

CREATE FUNCTION hon.require_ai_agent_capability(p_agent text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE cap text := hon.ai_agent_capability_permission(p_agent);
  actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
BEGIN
  IF cap IS NULL OR actor IS NULL
     OR NOT hon.principal_has_school_permission(actor, hon.current_organization_id(), hon.current_school_id(), cap) THEN
    RAISE EXCEPTION 'AI planning permission denied' USING ERRCODE = '42501';
  END IF;
END $$;

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
  v_denial text; v_risk text; v_replay_id text; v_replay jsonb;
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
  IF FOUND THEN
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
    SELECT c.catalog_id, c.provider_id, c.model_id, c.version AS catalog_version, p.version AS provider_version,
      c.unit_cost_micros::numeric * v_units AS estimated_cost INTO v_choice
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
  IF v_denial IS NOT NULL THEN
    -- A denied choice is not a plan or a charge. Nothing is persisted, so a
    -- later retry may reevaluate live configuration; successful plans replay.
    RETURN jsonb_build_object('status','NO_CHOICE','reason',v_denial,'plan',NULL,'replayed',false,'authority','UNCHANGED','execution','NOT_PERFORMED');
  END IF;
  INSERT INTO hon.ai_invocation_plans (organization_id,school_id,work_item_id,work_item_version,work_item_state,
    agent_key,modality,task_class,risk_class,input_budget,output_budget,max_provider_cost_microunits,
    estimated_provider_cost_microunits,customer_credit_estimate,provider_id,model_id,catalog_id,catalog_version,
    routing_policy_id,routing_policy_version,provider_version,request_hash)
  VALUES (v_org,v_school,p_work_id,v_work.version,v_work.status,p_data->>'agentKey','TEXT',p_data->>'taskClass',v_risk,
    (p_data->>'inputBudget')::integer,(p_data->>'outputBudget')::integer,(p_data->>'maxProviderCostMicrounits')::bigint,
    v_choice.estimated_cost::bigint,v_credits,v_choice.provider_id,v_choice.model_id,v_choice.catalog_id,v_choice.catalog_version,
    v_policy.policy_id,v_policy.version,v_choice.provider_version,v_hash) RETURNING id INTO v_plan_id;
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

DO $$ DECLARE f regprocedure; r text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.ai_agent_capability_permission(text)'::regprocedure, 'hon.require_ai_agent_capability(text)'::regprocedure] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
END $$;

COMMIT;
