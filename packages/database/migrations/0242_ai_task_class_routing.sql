BEGIN;

-- 0242 (R1): routing by task class. The planner reads the single active, effective HQ task profile for the planned agent
-- and a code-owned task category on the school's TEXT policy: its DEFAULT, else the first eligible FALLBACK (never
-- ADVANCED), inside the profile's cost ceiling, provider list, capabilities and privacy controls. No profile keeps the
-- legacy policy order; a profile without an eligible candidate, or two active profiles, refuse the route. The chosen
-- profile and selection are recorded on the immutable plan. Spend authority, budgets and provider runtimes are unchanged.
-- Spec: docs/architecture/AI_TASK_ROUTING.md.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'HQ resolver migrations require the reviewed privileged migration owner';
  END IF;
END $$;

-- Code-owned: callers and HQ never nominate the category of a planned call. NULL = no task routing (policy order).
CREATE FUNCTION hon.ai_route_task_category(p_agent text, p_task_class text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p_agent = 'hon' AND p_task_class = 'SUMMARIZE' THEN 'HON_STANDARD'
    WHEN p_agent = 'hon' AND p_task_class = 'ANALYZE' THEN 'HON_DETAILED'
    WHEN p_agent = 'claire' AND p_task_class = 'ANALYZE' THEN 'BUSINESS_PERFORMANCE'
    WHEN p_agent = 'marcus' AND p_task_class = 'DRAFT_MARKETING' THEN 'MARCUS_MARKETING'
    WHEN p_agent = 'chad' AND p_task_class = 'DRAFT_FOLLOW_UP' THEN 'CHAD_SALES'
    WHEN p_agent = 'kai' AND p_task_class = 'DRAFT_TEACHING' THEN 'KAI_TEACHING'
  END $$;

-- HQ may now keep task profiles for HON and Kai and for the new categories. CLAIRE_TEACHING stays as a stored legacy value.
ALTER TABLE hon.hq_ai_task_profiles DROP CONSTRAINT hq_ai_task_profiles_agent_key_check;
ALTER TABLE hon.hq_ai_task_profiles ADD CONSTRAINT hq_ai_task_profiles_agent_key_check
  CHECK (agent_key IN ('alex','chad','maya','marcus','jordan','claire','lena','eian','hon','kai'));
ALTER TABLE hon.hq_ai_task_profiles DROP CONSTRAINT hq_ai_task_profiles_task_category_check;
ALTER TABLE hon.hq_ai_task_profiles ADD CONSTRAINT hq_ai_task_profiles_task_category_check
  CHECK (task_category IN ('GENERAL_ASSISTANT','MARCUS_MARKETING','CHAD_SALES','CLAIRE_TEACHING','RETENTION','COMMAND_CENTER','WORKFLOW_PLANNING',
    'SIMPLE_CLASSIFICATION','HON_STANDARD','HON_DETAILED','BUSINESS_PERFORMANCE','KAI_TEACHING'));
CREATE INDEX hq_ai_task_profiles_route_idx ON hon.hq_ai_task_profiles(routing_policy_id, agent_key, task_category);

-- Immutable like the rest of the plan (ai_invocation_plans_immutable). Older rows were planned by policy order.
ALTER TABLE hon.ai_invocation_plans
  ADD COLUMN task_profile_id uuid,
  ADD COLUMN task_profile_version integer CHECK (task_profile_version >= 1),
  ADD COLUMN route_selection text NOT NULL DEFAULT 'POLICY_ORDER' CHECK (route_selection IN ('POLICY_ORDER','PROFILE_DEFAULT','PROFILE_FALLBACK')),
  ADD CONSTRAINT ai_invocation_plans_route_profile_check CHECK (
    (route_selection = 'POLICY_ORDER' AND task_profile_id IS NULL AND task_profile_version IS NULL)
    OR (route_selection <> 'POLICY_ORDER' AND task_profile_id IS NOT NULL AND task_profile_version IS NOT NULL));

-- 0113 body; only the agent key and task category lists are extended.
CREATE OR REPLACE FUNCTION hon.hq_ai_validate_write(p_kind text, p_data jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_keys text[];
  v_field text;
  v_allowed text[];
BEGIN
  v_keys := CASE p_kind
    WHEN 'PROVIDER' THEN ARRAY['providerId','displayName','state','credentialSecretRef','expectedVersion']
    WHEN 'CATALOG' THEN ARRAY['catalogId','providerId','modelId','displayName','capabilities','modalities','privacyControls','active','minimumTier','unitCostMicros','costUnit','effectiveFrom','effectiveUntil','expectedVersion']
    WHEN 'POLICY' THEN ARRAY['policyId','organizationId','schoolId','capability','active','minimumTier','maxCostMicros','allowDegraded','catalogIds','effectiveFrom','effectiveUntil','expectedVersion']
    WHEN 'TASK_PROFILE' THEN ARRAY['profileId','routingPolicyId','agentKey','taskCategory','costUnit','active','maxCostMicros','defaultCatalogId','fallbackCatalogIds','advancedCatalogId','requiredCapabilities','requiredModalities','allowedProviderIds','privacyControls','timeoutCategory','retryCategory','effectiveFrom','effectiveUntil','expectedVersion']
    ELSE NULL END;
  IF v_keys IS NULL OR p_data IS NULL OR jsonb_typeof(p_data) <> 'object'
    OR (p_kind = 'CATALOG' AND (
      NOT p_data ?& ARRAY['catalogId','providerId','modelId','displayName','capabilities','modalities','active','minimumTier','unitCostMicros','costUnit','effectiveFrom','effectiveUntil','expectedVersion']
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k <> ALL(v_keys))
    ))
    OR (p_kind <> 'CATALOG' AND (NOT p_data ?& v_keys OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k <> ALL(v_keys)))) THEN
    RAISE EXCEPTION 'Invalid HQ AI configuration shape' USING ERRCODE = '22023';
  END IF;
  FOREACH v_field IN ARRAY CASE p_kind WHEN 'CATALOG' THEN ARRAY['expectedVersion','unitCostMicros'] WHEN 'POLICY' THEN ARRAY['expectedVersion','maxCostMicros'] WHEN 'TASK_PROFILE' THEN ARRAY['expectedVersion','maxCostMicros'] ELSE ARRAY['expectedVersion'] END LOOP
    IF jsonb_typeof(p_data->v_field) <> 'number' OR (p_data->>v_field) !~ '^[0-9]+$'
      OR (p_data->>v_field)::numeric > 9007199254740991 THEN
      RAISE EXCEPTION 'Invalid HQ AI integer' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (p_data->>'expectedVersion')::numeric > 2147483646 THEN
    RAISE EXCEPTION 'Invalid HQ AI version' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'TASK_PROFILE' THEN
    FOREACH v_field IN ARRAY ARRAY['profileId','routingPolicyId','defaultCatalogId'] LOOP
      IF jsonb_typeof(p_data->v_field) <> 'string' OR (p_data->>v_field) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'Invalid HQ profile identifier' USING ERRCODE='22023';
      END IF;
    END LOOP;
    IF jsonb_typeof(p_data->'agentKey') <> 'string' OR p_data->>'agentKey' NOT IN ('alex','chad','maya','marcus','jordan','claire','lena','eian','hon','kai')
      OR jsonb_typeof(p_data->'taskCategory') <> 'string' OR p_data->>'taskCategory' NOT IN ('GENERAL_ASSISTANT','MARCUS_MARKETING','CHAD_SALES','CLAIRE_TEACHING','RETENTION','COMMAND_CENTER','WORKFLOW_PLANNING','SIMPLE_CLASSIFICATION','HON_STANDARD','HON_DETAILED','BUSINESS_PERFORMANCE','KAI_TEACHING')
      OR jsonb_typeof(p_data->'costUnit') <> 'string' OR p_data->>'costUnit' NOT IN ('TOKEN','SECOND','IMAGE','VIDEO','REQUEST')
      OR jsonb_typeof(p_data->'active') <> 'boolean'
      OR jsonb_typeof(p_data->'timeoutCategory') <> 'string' OR p_data->>'timeoutCategory' NOT IN ('QUICK','STANDARD','EXTENDED')
      OR jsonb_typeof(p_data->'retryCategory') <> 'string' OR p_data->>'retryCategory' NOT IN ('NONE','TRANSIENT_ONCE') THEN
      RAISE EXCEPTION 'Invalid HQ profile selection metadata' USING ERRCODE='22023';
    END IF;
    IF NOT hon.hq_ai_valid_list(p_data->'requiredCapabilities',ARRAY['TEXT','VOICE_INPUT','VOICE_OUTPUT','IMAGE','VIDEO','EMBEDDING','TOOL_EXECUTION'],1,7)
      OR NOT hon.hq_ai_valid_list(p_data->'requiredModalities',ARRAY['TEXT','VOICE_INPUT','VOICE_OUTPUT','IMAGE','VIDEO','EMBEDDING'],1,6)
      OR NOT hon.hq_ai_valid_list(p_data->'allowedProviderIds',ARRAY['OPENROUTER','DIRECT_LLM_API','HEYGEN','HIGGSFIELD'],1,4)
      OR NOT hon.hq_ai_valid_list(p_data->'privacyControls',ARRAY['NO_TRAINING','ZERO_RETENTION'],0,2) THEN
      RAISE EXCEPTION 'Invalid HQ profile restrictions' USING ERRCODE='22023';
    END IF;
    IF jsonb_typeof(p_data->'fallbackCatalogIds') <> 'array' THEN RAISE EXCEPTION 'Invalid HQ profile fallback list' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(p_data->'fallbackCatalogIds') > 7
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'fallbackCatalogIds') x WHERE jsonb_typeof(x) <> 'string' OR (x #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      OR (p_data->'advancedCatalogId' <> 'null'::jsonb AND (jsonb_typeof(p_data->'advancedCatalogId') <> 'string' OR p_data->>'advancedCatalogId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) THEN
      RAISE EXCEPTION 'Invalid HQ profile approved IDs' USING ERRCODE='22023';
    END IF;
    IF (SELECT count(*) <> count(DISTINCT id::uuid) OR count(*) > 8 FROM (
      SELECT p_data->>'defaultCatalogId' id UNION ALL SELECT jsonb_array_elements_text(p_data->'fallbackCatalogIds') UNION ALL SELECT p_data->>'advancedCatalogId' WHERE p_data->'advancedCatalogId' <> 'null'::jsonb
    ) ids) THEN RAISE EXCEPTION 'Duplicate or excessive HQ profile candidates' USING ERRCODE='22023'; END IF;
    IF jsonb_typeof(p_data->'effectiveFrom') <> 'string' OR p_data->>'effectiveFrom' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$'
      OR (p_data->'effectiveUntil' <> 'null'::jsonb AND (jsonb_typeof(p_data->'effectiveUntil') <> 'string' OR p_data->>'effectiveUntil' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$')) THEN
      RAISE EXCEPTION 'Invalid HQ profile effective window' USING ERRCODE='22023';
    END IF;
    RETURN;
  END IF;
  IF p_kind IN ('PROVIDER','CATALOG') AND (jsonb_typeof(p_data->'displayName') <> 'string' OR NOT hon.hq_ai_safe_text(p_data->>'displayName')) THEN
    RAISE EXCEPTION 'Invalid non-secret HQ AI label' USING ERRCODE = '22023';
  END IF;
  IF p_kind IN ('PROVIDER','CATALOG') AND (jsonb_typeof(p_data->'providerId') <> 'string' OR (p_data->>'providerId') NOT IN ('OPENROUTER','DIRECT_LLM_API','HEYGEN','HIGGSFIELD')) THEN
    RAISE EXCEPTION 'Provider is not registered' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'PROVIDER' THEN
    IF jsonb_typeof(p_data->'state') <> 'string' OR (p_data->>'state') NOT IN ('DISABLED','CONFIGURED','HEALTHY','DEGRADED','UNAVAILABLE')
      OR (p_data->'credentialSecretRef' <> 'null'::jsonb AND (jsonb_typeof(p_data->'credentialSecretRef') <> 'string' OR (p_data->>'credentialSecretRef') !~ '^hon-secret:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
      OR (p_data->>'state' <> 'DISABLED' AND p_data->'credentialSecretRef' = 'null'::jsonb) THEN
      RAISE EXCEPTION 'Only opaque HQ credential references and registered states are allowed' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF jsonb_typeof(p_data->'active') <> 'boolean' OR (p_data->>'minimumTier') NOT IN ('ESSENTIAL','CORE','COMPLETE') OR jsonb_typeof(p_data->'minimumTier') <> 'string'
    OR jsonb_typeof(p_data->'effectiveFrom') <> 'string' OR (p_data->>'effectiveFrom') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$'
    OR (p_data->'effectiveUntil' <> 'null'::jsonb AND (jsonb_typeof(p_data->'effectiveUntil') <> 'string' OR (p_data->>'effectiveUntil') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$')) THEN
    RAISE EXCEPTION 'Invalid HQ AI effective window or entitlement' USING ERRCODE = '22023';
  END IF;
  FOREACH v_field IN ARRAY CASE p_kind WHEN 'CATALOG' THEN ARRAY['catalogId'] ELSE ARRAY['policyId','organizationId','schoolId'] END LOOP
    IF jsonb_typeof(p_data->v_field) <> 'string' OR (p_data->>v_field) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Invalid HQ AI identifier' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF p_kind = 'CATALOG' THEN
    IF p_data ? 'privacyControls' AND NOT hon.hq_ai_valid_list(p_data->'privacyControls',ARRAY['NO_TRAINING','ZERO_RETENTION'],0,2) THEN RAISE EXCEPTION 'Invalid HQ catalog privacy attestations' USING ERRCODE='22023'; END IF;
    IF jsonb_typeof(p_data->'modelId') <> 'string' OR NOT hon.hq_ai_safe_text(p_data->>'modelId', true)
      OR jsonb_typeof(p_data->'costUnit') <> 'string' OR (p_data->>'costUnit') NOT IN ('TOKEN','SECOND','IMAGE','VIDEO','REQUEST') THEN
      RAISE EXCEPTION 'Invalid HQ AI model metadata' USING ERRCODE = '22023';
    END IF;
    FOREACH v_field IN ARRAY ARRAY['capabilities','modalities'] LOOP
      v_allowed := CASE v_field WHEN 'capabilities' THEN ARRAY['TEXT','VOICE_INPUT','VOICE_OUTPUT','IMAGE','VIDEO','EMBEDDING','TOOL_EXECUTION'] ELSE ARRAY['TEXT','VOICE_INPUT','VOICE_OUTPUT','IMAGE','VIDEO','EMBEDDING'] END;
      IF jsonb_typeof(p_data->v_field) <> 'array' THEN RAISE EXCEPTION 'Invalid HQ AI capability list' USING ERRCODE = '22023'; END IF;
      IF jsonb_array_length(p_data->v_field) NOT BETWEEN 1 AND cardinality(v_allowed)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->v_field) x WHERE jsonb_typeof(x) <> 'string' OR (x #>> '{}') <> ALL(v_allowed))
        OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(p_data->v_field) x) <> jsonb_array_length(p_data->v_field) THEN
        RAISE EXCEPTION 'Invalid HQ AI capability list' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  ELSE
    IF jsonb_typeof(p_data->'capability') <> 'string' OR (p_data->>'capability') NOT IN ('TEXT','VOICE_INPUT','VOICE_OUTPUT','IMAGE','VIDEO','EMBEDDING','TOOL_EXECUTION') OR jsonb_typeof(p_data->'allowDegraded') <> 'boolean' OR jsonb_typeof(p_data->'catalogIds') <> 'array' THEN
      RAISE EXCEPTION 'Invalid HQ AI routing metadata' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_data->'catalogIds') NOT BETWEEN 1 AND 8
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'catalogIds') x WHERE jsonb_typeof(x) <> 'string' OR (x #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      OR (SELECT count(DISTINCT lower(x)) FROM jsonb_array_elements_text(p_data->'catalogIds') x) <> jsonb_array_length(p_data->'catalogIds') THEN
      RAISE EXCEPTION 'Invalid HQ approved routing IDs' USING ERRCODE = '22023';
    END IF;
  END IF;
END $$;

-- 0212 body plus task-class routing (see header).
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
  -- 0242: routing by task class through the single active HQ task profile for this agent and code-owned category.
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

REVOKE ALL ON FUNCTION hon.ai_route_task_category(text,text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.ai_route_task_category(text,text) FROM %I', r);
  END LOOP;
END $$;

COMMIT;
