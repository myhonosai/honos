BEGIN;

-- Eian family AI, E-AI1 (0474). A parent asks Eian a free-text question in the HON Family app and HON answers from that
-- family's own records through the same governed AI runtime as Ask HON (0210/0336). Spec: docs/architecture/EIAN_FAMILY_AI.md.
-- Owner: David chose "Build it now" (2026-11-18 01:34Z) and "Eian is as HON. Included in program" (01:39Z). That builds the
-- path; a paid call still needs the provider key, the paid-call approval flag, a HEALTHY HQ route and a deploy.
--   E1  Scope: hon.parent_class_booking_scope (0329/0471), so Eian follows the parent's family choice like every parent path.
--       The client sends no family, school or organization selector.
--   E2  Gate: HON's own hon_reply_complete_live (Complete at the live clock), the 4-argument S4 spend decision (HQ pause,
--       exception allowance, school cost ceiling), the organization ceiling, and a share of that ceiling for parents
--       (hon.eian_share_percent, owner decision D3 pending, 25 until answered).
--   E3  Burst guard: 20 new turns per guardian per rolling 10 minutes, counted under a per-guardian lock. Replays never count.
--   E4  Planning: plan_ai_invocation's route selection moves, byte for byte, into the pure, ungranted
--       hon.ai_select_text_route. plan_ai_invocation keeps every check it had and calls it; plan_eian_turn checks the parent
--       scope and the Eian gate first and calls the same helper.
--   E5  Facts: built by the API from the existing guarded parent reads under one resolved scope and allow-listed there.
--       prepare re-checks that scope after its locks, validates the closed shape (fixed keys and types, caps, a byte cap, no
--       email or uuid) and records a digest. Facts and the question are untrusted data to the provider.
--   E6  Outcomes mirror 0210: one ledger row (AGENT_INFERENCE, source_invocation_id = turn id) before any answer is shown;
--       an answer over the plan budgets is FAILED and never shown; a lapse mid-flight is RESULT_HELD; UNKNOWN keeps the hold
--       for the HQ queue. Eian answers text only and may suggest one screen from a closed list; nothing it says is executed.
--   E7  S4 enumerations: the four S4 triggers on the new table, and every shared spend function gains the EIAN agent.
--       read_ai_team_readiness is unchanged on purpose: it is the staff AI roster.
-- The runtime gains no table privilege: seven SECURITY DEFINER entry points take the signed-in subject and closed inputs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Eian family AI requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Eian family AI requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.parent_class_booking_scope(text,boolean)') IS NULL OR to_regprocedure('hon.hon_reply_complete_live(uuid)') IS NULL
    OR to_regprocedure('hon.ai_spend_allowed(uuid,uuid,timestamptz,text)') IS NULL OR to_regprocedure('hon.ai_select_text_route(uuid,uuid,uuid,text,text,integer,bigint)') IS NOT NULL
    OR to_regprocedure('hon.plan_ai_invocation(uuid,jsonb,uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.parent_family_scope_any(text,uuid)') IS NULL
    OR to_regclass('hon.eian_turns') IS NOT NULL THEN
    RAISE EXCEPTION 'Eian family AI requires migrations through 0473 and must apply once';
  END IF;
END $$;

-- E-AI1: the route selection of plan_ai_invocation (0336 body, unchanged), extracted so the parent Eian planner uses
-- exactly the same HQ policy, task profile, candidate order, cost bounds and unavailable-model exclusion. Pure: explicit
-- inputs only, no settings reads, no writes, no audit, no authority checks (every caller checks its own principal
-- first). Granted to no one; reachable only from the two fixed planners below.
CREATE FUNCTION hon.ai_select_text_route(p_org uuid, p_school uuid, p_work_id uuid, p_agent text, p_task_class text, p_units integer, p_max_cost bigint)
RETURNS TABLE(denial text, catalog_id uuid, provider_id text, model_id text, catalog_version integer, provider_version integer,
  estimated_cost numeric, route_selection text, policy_id uuid, policy_version integer, profile_id uuid, profile_version integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_policy hon.hq_ai_routing_policies%ROWTYPE; v_choice record; v_denial text;
  v_category text; v_profiles integer := 0; v_profile hon.hq_ai_task_profiles%ROWTYPE;
BEGIN
  IF p_org IS NULL OR p_school IS NULL OR p_work_id IS NULL OR p_agent IS NULL OR p_task_class IS NULL OR p_units IS NULL OR p_max_cost IS NULL THEN
    RAISE EXCEPTION 'AI route selection inputs required' USING ERRCODE = '22023';
  END IF;
  -- Fail closed on absent or ambiguous active approved policies. No tenant may
  -- nominate a route/model or raise the platform risk/cost ceiling.
  IF (SELECT count(*) FROM hon.hq_ai_routing_policies
    WHERE organization_id = p_org AND school_id = p_school AND capability = 'TEXT' AND active
      AND effective_from <= now() AND (effective_until IS NULL OR now() < effective_until)) <> 1 THEN
    v_denial := 'NO_ELIGIBLE_ROUTE';
  END IF;
  IF v_denial IS NULL THEN
    SELECT * INTO v_policy FROM hon.hq_ai_routing_policies WHERE organization_id = p_org AND school_id = p_school
      AND capability = 'TEXT' AND active AND effective_from <= now() AND (effective_until IS NULL OR now() < effective_until);
    v_category := hon.ai_route_task_category(p_agent, p_task_class);
    IF v_category IS NOT NULL THEN
      SELECT count(*) INTO v_profiles FROM hon.hq_ai_task_profiles tp
      WHERE tp.routing_policy_id = v_policy.policy_id AND tp.agent_key = p_agent AND tp.task_category = v_category
        AND tp.active AND tp.cost_unit = 'TOKEN' AND tp.effective_from <= now() AND (tp.effective_until IS NULL OR now() < tp.effective_until);
    END IF;
    IF v_profiles > 1 THEN
      -- Ambiguous HQ configuration fails closed, exactly as two active policies do.
      v_denial := 'NO_ELIGIBLE_ROUTE';
    ELSIF v_profiles = 1 THEN
      SELECT tp.* INTO STRICT v_profile FROM hon.hq_ai_task_profiles tp
      WHERE tp.routing_policy_id = v_policy.policy_id AND tp.agent_key = p_agent AND tp.task_category = v_category
        AND tp.active AND tp.cost_unit = 'TOKEN' AND tp.effective_from <= now() AND (tp.effective_until IS NULL OR now() < tp.effective_until);
      -- The profile's DEFAULT, then its FALLBACKs in order; ADVANCED is never chosen here. Every legacy policy check applies,
      -- plus the profile's own cost ceiling, provider list, required capabilities/modalities and privacy controls.
      SELECT c.catalog_id, c.provider_id, c.model_id, c.version AS catalog_version, p.version AS provider_version,
        c.unit_cost_micros::numeric * p_units AS estimated_cost,
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
        AND c.unit_cost_micros::numeric * p_units <= LEAST(v_policy.max_cost_micros, v_profile.max_cost_micros, p_max_cost)
      ORDER BY (t.selection = 'FALLBACK'), t.ordinal LIMIT 1;
      -- No escape to the policy order: a model HQ did not pick for this task is never used for it.
      IF NOT FOUND THEN v_denial := 'NO_ELIGIBLE_ROUTE'; END IF;
    ELSE
      SELECT c.catalog_id, c.provider_id, c.model_id, c.version AS catalog_version, p.version AS provider_version,
        c.unit_cost_micros::numeric * p_units AS estimated_cost, 'POLICY_ORDER'::text AS route_selection INTO v_choice
      FROM hon.hq_ai_routing_candidates r
      JOIN hon.hq_ai_model_catalog c ON c.catalog_id = r.catalog_id
      JOIN hon.hq_ai_provider_connections p ON p.provider_id = c.provider_id
      WHERE r.policy_id = v_policy.policy_id AND c.active AND c.cost_unit = 'TOKEN'
        AND 'TEXT' = ANY(c.capabilities) AND 'TEXT' = ANY(c.modalities)
        AND c.effective_from <= now() AND (c.effective_until IS NULL OR now() < c.effective_until)
        AND p.state = 'HEALTHY'
        AND c.unit_cost_micros::numeric * p_units <= LEAST(v_policy.max_cost_micros, p_max_cost)
      ORDER BY r.ordinal LIMIT 1;
      -- Complete exceeds every currently registered minimum tier; degraded is
      -- deliberately denied even if HQ preview policy permits it in other slices.
      IF NOT FOUND THEN v_denial := 'NO_ELIGIBLE_ROUTE'; END IF;
    END IF;
  END IF;
  IF v_denial IS NOT NULL THEN
    RETURN QUERY SELECT v_denial, NULL::uuid, NULL::text, NULL::text, NULL::integer, NULL::integer, NULL::numeric, NULL::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  RETURN QUERY SELECT NULL::text, v_choice.catalog_id, v_choice.provider_id, v_choice.model_id, v_choice.catalog_version, v_choice.provider_version,
    v_choice.estimated_cost::numeric, v_choice.route_selection, v_policy.policy_id, v_policy.version, v_profile.profile_id, v_profile.version;
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
  v_work hon.work_items%ROWTYPE;
  v_choice record; v_plan_id uuid; v_hash text; v_existing hon.idempotency_records%ROWTYPE;
  v_response jsonb; v_payload jsonb; v_units integer; v_credits integer; v_used numeric;
  v_denial text; v_risk text; v_replay_id text; v_replay jsonb; v_found boolean;
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
  -- E-AI1: route selection moved verbatim into hon.ai_select_text_route; this planner keeps every check above.
  IF v_denial IS NULL THEN
    SELECT * INTO v_choice FROM hon.ai_select_text_route(v_org, v_school, p_work_id, p_data->>'agentKey', p_data->>'taskClass', v_units,
      (p_data->>'maxProviderCostMicrounits')::bigint);
    v_denial := v_choice.denial;
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
    v_choice.policy_id,v_choice.policy_version,v_choice.provider_version,v_hash,v_choice.profile_id,v_choice.profile_version,v_choice.route_selection) RETURNING id INTO v_plan_id;
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

-- ---- Fixed limits, owned here (no caller or stored value can raise them) ----
CREATE FUNCTION hon.eian_turn_limits() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('taskClass','SUMMARIZE','inputBudget',9000,'outputBudget',700,'maxProviderCostMicrounits',20000)
$$;
-- D3 (owner decision pending): the share of the organization's AI ceiling that parent Eian turns may commit in one
-- spend window. 25 keeps the school's own AI team working whatever parents ask; 100 shares the whole budget.
CREATE FUNCTION hon.eian_share_percent() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 25 $$;
-- Burst guard (D2): at most this many new turns per guardian in a rolling ten minutes. Replays never count.
CREATE FUNCTION hon.eian_burst_limit() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 20 $$;

-- ---- The turn ----
CREATE TABLE hon.eian_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
  family_id uuid NOT NULL REFERENCES hon.families(id),
  requested_by uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key = btrim(idempotency_key) AND idempotency_key !~ '[[:cntrl:]]'),
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 500 AND question = btrim(question)),
  work_item_id uuid NOT NULL UNIQUE REFERENCES hon.work_items(id),
  plan_id uuid REFERENCES hon.ai_invocation_plans(id),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED', 'SENDING', 'RESULT_HELD', 'COMPLETED', 'FAILED', 'UNKNOWN')),
  reason text CHECK (reason IS NULL OR reason ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  reserved_credits integer NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  held_at timestamptz,
  usage_id uuid UNIQUE REFERENCES hon.ai_usage_ledger(id),
  provider_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  context_digest text CHECK (context_digest IS NULL OR context_digest ~ '^[a-f0-9]{64}$'),
  reply_text text CHECK (reply_text IS NULL OR length(btrim(reply_text)) BETWEEN 1 AND 1500),
  suggested_screen text CHECK (suggested_screen IS NULL OR suggested_screen IN ('SCHEDULE','BOOK_CLASS','REPORT_ABSENCE','BILLING','TESTING','MESSAGES')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (requested_by, idempotency_key),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id),
  CHECK ((reply_text IS NOT NULL) = (status IN ('RESULT_HELD', 'COMPLETED'))),
  CHECK (suggested_screen IS NULL OR status IN ('RESULT_HELD', 'COMPLETED')),
  CHECK (status <> 'SENDING' OR (plan_id IS NOT NULL AND reserved_credits > 0))
);
CREATE INDEX eian_turns_hold_idx ON hon.eian_turns (organization_id) WHERE reserved_credits > 0;
CREATE INDEX eian_turns_requester_idx ON hon.eian_turns (requested_by, created_at DESC);
CREATE INDEX eian_turns_family_idx ON hon.eian_turns (family_id, requested_by, created_at DESC);
ALTER TABLE hon.eian_turns ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.eian_turns FORCE ROW LEVEL SECURITY;

-- The same S4 guards as every agent caller (0210:88-93): access decision and HQ pause on start; access, budget lock,
-- organization ceiling and school decision on every reservation increase; an immutable hold origin.
CREATE TRIGGER ai_spend_start_guard BEFORE INSERT ON hon.eian_turns FOR EACH ROW EXECUTE FUNCTION hon.ai_spend_start_guard();
CREATE TRIGGER ai_spend_reserve_guard BEFORE UPDATE OF reserved_credits ON hon.eian_turns
  FOR EACH ROW WHEN (NEW.reserved_credits > OLD.reserved_credits) EXECUTE FUNCTION hon.ai_spend_reserve_guard();
CREATE TRIGGER ai_spend_reserve_guard_insert BEFORE INSERT ON hon.eian_turns
  FOR EACH ROW WHEN (NEW.reserved_credits > 0) EXECUTE FUNCTION hon.ai_spend_reserve_guard();
CREATE TRIGGER zz_ai_hold_origin BEFORE INSERT OR UPDATE ON hon.eian_turns FOR EACH ROW EXECUTE FUNCTION hon.ai_stamp_hold_origin();

-- ---- Scope and gate ----
-- The signed-in parent's one current family (0471 choice), bound to this transaction's settings and tenant. Any
-- refusal is EIAN_FORBIDDEN. Read access is enough to ask: Eian only explains what the parent may already read.
CREATE FUNCTION hon.eian_scope(p_subject text)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid, family_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  BEGIN
    RETURN QUERY SELECT s.principal_id, s.organization_id, s.school_id, s.family_id FROM hon.parent_class_booking_scope(p_subject, false) s;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'EIAN_FORBIDDEN' USING ERRCODE = '42501';
  END;
END $$;

-- Eian is included exactly where HON is (owner 2026-11-18: "Eian is as HON. Included in program"): the parent scope
-- above (active organization and school) and HON's own live-clock entitlement test, shared so the two never drift.
CREATE FUNCTION hon.eian_access(p_subject text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid;
BEGIN
  SELECT s.organization_id INTO org FROM hon.eian_scope(p_subject) s;
  RETURN org IS NOT NULL AND hon.hon_reply_complete_live(org);
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;

-- Credits parent Eian turns commit in the organization's current window: their ledger rows plus their counting holds.
CREATE FUNCTION hon.eian_committed_credits(p_org uuid, p_at timestamptz) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH w AS (SELECT hon.ai_spend_window(p_org, p_at) AS r)
  SELECT (SELECT coalesce(sum(u.customer_credits),0) FROM hon.ai_usage_ledger u, w
           WHERE u.organization_id=p_org AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=lower(w.r) AND u.occurred_at<upper(w.r)
             AND EXISTS (SELECT 1 FROM hon.eian_turns e WHERE e.id = u.source_invocation_id))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.eian_turns i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at));
$$;

-- Why a new turn could not be answered by AI now, or NULL. Closed reasons only; never a ceiling, spend or route name.
CREATE FUNCTION hon.eian_unavailable_reason(p_org uuid, p_school uuid, p_ready boolean) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE lim jsonb := hon.eian_turn_limits(); est integer; at timestamptz := clock_timestamp(); ceiling bigint;
BEGIN
  est := ((lim->>'inputBudget')::integer + (lim->>'outputBudget')::integer + 999) / 1000;
  IF NOT hon.hon_reply_complete_live(p_org) THEN RETURN 'NOT_INCLUDED'; END IF;
  IF hon.ai_spend_allowed(p_org, p_school, at, 'AGENT_INFERENCE') IS NOT NULL THEN RETURN 'PAUSED'; END IF;
  IF NOT coalesce(p_ready, false) OR hon.ai_team_route(p_org, p_school, (lim->>'inputBudget')::bigint + (lim->>'outputBudget')::bigint,
      (lim->>'maxProviderCostMicrounits')::bigint) IS NOT NULL THEN RETURN 'NOT_CONFIGURED'; END IF;
  ceiling := hon.ai_org_ceiling(p_org, at);
  IF hon.ai_org_committed_credits(p_org, at) + est > ceiling
     OR (hon.eian_committed_credits(p_org, at) + est) * 100 > ceiling * hon.eian_share_percent() THEN RETURN 'BUDGET_REACHED'; END IF;
  RETURN NULL;
END $$;

-- What the app shows: AI answers, or guided mode with a closed reason. p_ready is the server's provider readiness.
CREATE FUNCTION hon.read_eian_status(p_subject text, p_ready boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; why text;
BEGIN
  SELECT * INTO STRICT sc FROM hon.eian_scope(p_subject);
  why := hon.eian_unavailable_reason(sc.organization_id, sc.school_id, p_ready);
  RETURN jsonb_build_object('mode', CASE WHEN why IS NULL THEN 'AI' ELSE 'GUIDED' END, 'reason', why);
END $$;

-- ---- Facts: a closed, family-safe shape (design review 2026-11-18 items 2 and A) ----
-- The API builds facts from the parent read services under one resolved scope and allow-lists them; this re-validates
-- the exact shape before anything reaches a provider: fixed sections and item keys, string or integer values, per-value
-- and per-section caps, a total byte cap, and no email address or uuid anywhere.
CREATE FUNCTION hon.eian_facts_ok(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE spec CONSTANT jsonb := '{
    "children":    {"max": 10, "keys": ["name","rank","program"]},
    "classes":     {"max": 12, "keys": ["child","name","when","status"]},
    "bookings":    {"max": 10, "keys": ["title","when","status"]},
    "testing":     {"max": 10, "keys": ["child","status","detail"]},
    "invoices":    {"max": 10, "keys": ["child","status","amount","due"]},
    "memberships": {"max": 10, "keys": ["child","state","ends"]},
    "classPasses": {"max": 10, "keys": ["child","pass","remaining","expires","status"]},
    "messages":    {"max": 5,  "keys": ["from","when","text"]},
    "knowledge":   {"max": 5,  "keys": ["title","text"]}}'::jsonb;
  k text; v jsonb; item jsonb; f text; fv jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR octet_length(p::text) > 5000 THEN RETURN false; END IF;
  -- No email address or uuid anywhere in the text, keys included.
  IF p::text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' OR p::text ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' THEN RETURN false; END IF;
  FOR k, v IN SELECT * FROM jsonb_each(p) LOOP
    IF k IN ('today','timezone','schoolName') THEN
      IF jsonb_typeof(v) <> 'string' OR length(v #>> '{}') NOT BETWEEN 1 AND 120 THEN RETURN false; END IF;
    ELSIF k = 'unavailable' THEN
      IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) > 9 THEN RETURN false; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v) x WHERE jsonb_typeof(x) <> 'string' OR NOT spec ? (x #>> '{}')) THEN RETURN false; END IF;
    ELSIF spec ? k THEN
      IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) > (spec->k->>'max')::integer THEN RETURN false; END IF;
      FOR item IN SELECT * FROM jsonb_array_elements(v) LOOP
        IF jsonb_typeof(item) <> 'object' OR item = '{}'::jsonb THEN RETURN false; END IF;
        FOR f, fv IN SELECT * FROM jsonb_each(item) LOOP
          IF NOT (spec->k->'keys') ? f THEN RETURN false; END IF;
          IF jsonb_typeof(fv) = 'number' THEN
            IF (fv #>> '{}') !~ '^-?[0-9]{1,9}$' THEN RETURN false; END IF;
          ELSIF jsonb_typeof(fv) = 'string' THEN
            IF length(fv #>> '{}') NOT BETWEEN 1 AND (CASE WHEN f = 'text' THEN 600 ELSE 120 END) THEN RETURN false; END IF;
          ELSE RETURN false; END IF;
        END LOOP;
      END LOOP;
    ELSE RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

-- ---- Views ----
CREATE FUNCTION hon.eian_turn_view(t hon.eian_turns, p_visible boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id', t.id, 'status', t.status, 'question', t.question,
    -- The answer is shown only while the parent may see it; usage evidence is unaffected.
    'reply', CASE WHEN t.status = 'COMPLETED' AND p_visible THEN t.reply_text END,
    'screen', CASE WHEN t.status = 'COMPLETED' AND p_visible THEN t.suggested_screen END,
    'reason', CASE WHEN t.status IN ('BLOCKED','CONFIGURATION_REQUIRED','FAILED','UNKNOWN') THEN
      CASE WHEN t.reason IN ('CUSTOMER_BUDGET_EXCEEDED','EIAN_SHARE_REACHED','AI_ORG_BUDGET_EXCEEDED') THEN 'BUDGET_REACHED'
           WHEN t.reason IN ('AI_ACCESS_REFUSED') THEN 'NOT_INCLUDED'
           WHEN t.status = 'CONFIGURATION_REQUIRED' OR t.reason IN ('NO_ELIGIBLE_ROUTE','UNSUPPORTED_PROVIDER','CONFIGURATION_REQUIRED') THEN 'NOT_CONFIGURED'
           WHEN t.status = 'UNKNOWN' THEN 'OUTCOME_UNKNOWN'
           WHEN t.status = 'BLOCKED' THEN 'PAUSED'
           ELSE 'NOT_ANSWERED' END END,
    'askedAt', hon.saas_ts(t.created_at));
$$;

-- The parent's own turn in the current family only. A held answer is released here once access has returned
-- (never calls a provider, writes no usage).
CREATE FUNCTION hon.read_eian_turn(p_subject text, p_turn uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; t hon.eian_turns%ROWTYPE; ok boolean;
BEGIN
  SELECT * INTO STRICT sc FROM hon.eian_scope(p_subject);
  SELECT * INTO t FROM hon.eian_turns WHERE id = p_turn AND requested_by = sc.principal_id AND family_id = sc.family_id
    AND organization_id = sc.organization_id AND school_id = sc.school_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EIAN_TURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  ok := hon.eian_access(p_subject);
  IF t.status = 'RESULT_HELD' AND ok THEN
    UPDATE hon.eian_turns SET status = 'COMPLETED', reason = NULL, updated_at = clock_timestamp() WHERE id = t.id RETURNING * INTO t;
    UPDATE hon.work_items SET status = 'COMPLETED', version = version + 1, updated_at = clock_timestamp() WHERE id = t.work_item_id;
  END IF;
  RETURN hon.eian_turn_view(t, ok);
END $$;

-- ---- Begin ----
-- One new question, or the replay of the same question under the same key. Refusals: EIAN_FORBIDDEN (scope),
-- EIAN_AI_UNAVAILABLE (not included or AI paused for this school), EIAN_BUSY (burst guard), VALIDATION_FAILED,
-- IDEMPOTENCY_KEY_REUSED (same key, different question).
CREATE FUNCTION hon.begin_eian_turn(p_subject text, p_question text, p_key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; live record; q text := btrim(p_question); t hon.eian_turns%ROWTYPE; tid uuid := gen_random_uuid(); wid uuid; n integer;
BEGIN
  SELECT * INTO STRICT sc FROM hon.eian_scope(p_subject);
  IF p_question IS NULL OR length(q) NOT BETWEEN 1 AND 500 OR q ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
     OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_key <> btrim(p_key) OR p_key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
  END IF;
  -- One key, one question: replays and races under a key resolve to one turn.
  PERFORM pg_advisory_xact_lock(hashtextextended('eian.turn:' || sc.principal_id::text || ':' || p_key, 0));
  SELECT * INTO t FROM hon.eian_turns WHERE requested_by = sc.principal_id AND idempotency_key = p_key;
  IF FOUND THEN
    IF t.question <> q OR t.family_id <> sc.family_id THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('turn', hon.eian_turn_view(t, hon.eian_access(p_subject)), 'replayed', true);
  END IF;
  IF NOT hon.eian_access(p_subject) OR hon.ai_spend_allowed(sc.organization_id, sc.school_id, clock_timestamp(), 'AGENT_INFERENCE') IS NOT NULL THEN
    RAISE EXCEPTION 'EIAN_AI_UNAVAILABLE' USING ERRCODE = '55000';
  END IF;
  -- Burst guard, counted under a per-guardian lock so parallel requests cannot all pass.
  PERFORM pg_advisory_xact_lock(hashtextextended('eian.burst:' || sc.principal_id::text, 0));
  SELECT count(*) INTO n FROM hon.eian_turns WHERE requested_by = sc.principal_id AND created_at > clock_timestamp() - interval '10 minutes';
  IF n >= hon.eian_burst_limit() THEN RAISE EXCEPTION 'EIAN_BUSY' USING ERRCODE = '54000'; END IF;
  INSERT INTO hon.work_items (organization_id, school_id, work_type, status, subject_type, subject_id, payload, correlation_id)
    VALUES (sc.organization_id, sc.school_id, 'AI_' || (hon.eian_turn_limits()->>'taskClass'), 'READY', 'EIAN_TURN', tid, '{}',
      coalesce(nullif(current_setting('app.hon_request_id', true), '')::uuid, gen_random_uuid()))
    RETURNING id INTO wid;
  INSERT INTO hon.eian_turns (id, organization_id, school_id, family_id, requested_by, idempotency_key, question, work_item_id)
    VALUES (tid, sc.organization_id, sc.school_id, sc.family_id, sc.principal_id, p_key, q, wid)
    RETURNING * INTO t;
  -- Scope again after every lock and write of the command.
  SELECT * INTO STRICT live FROM hon.eian_scope(p_subject);
  IF live.principal_id IS DISTINCT FROM sc.principal_id OR live.family_id IS DISTINCT FROM sc.family_id THEN
    RAISE EXCEPTION 'EIAN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('turn', hon.eian_turn_view(t, true), 'replayed', false);
END $$;

-- ---- Plan ----
-- The parent-path planner. The parent holds no staff planning permission, so this replaces plan_ai_invocation's
-- authority checks with the parent scope and the Eian gate, then uses the same route selection, plan row, audit,
-- outbox and organization-month estimate. One plan per turn: a repeat returns the existing plan.
CREATE FUNCTION hon.plan_eian_turn(p_subject text, p_turn uuid, p_request_id uuid, p_correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; t hon.eian_turns%ROWTYPE; w hon.work_items%ROWTYPE; lim jsonb := hon.eian_turn_limits();
  v_units integer; v_credits integer; v_used numeric; v_denial text; v_choice record; v_hash text; v_plan_id uuid; v_payload jsonb; existing uuid;
BEGIN
  IF p_request_id IS NULL OR p_correlation_id IS NULL OR p_request_id IS DISTINCT FROM nullif(current_setting('app.hon_request_id', true), '')::uuid THEN
    RAISE EXCEPTION 'AI planning request identifiers required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT sc FROM hon.eian_scope(p_subject);
  SELECT * INTO t FROM hon.eian_turns WHERE id = p_turn AND requested_by = sc.principal_id AND family_id = sc.family_id
    AND organization_id = sc.organization_id AND school_id = sc.school_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EIAN_TURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF t.status <> 'PENDING' THEN RETURN jsonb_build_object('status', 'NOT_PENDING'); END IF;
  SELECT * INTO STRICT w FROM hon.work_items WHERE id = t.work_item_id FOR UPDATE;
  SELECT id INTO existing FROM hon.ai_invocation_plans WHERE work_item_id = t.work_item_id AND agent_key = 'eian' ORDER BY created_at DESC LIMIT 1;
  IF existing IS NOT NULL THEN RETURN jsonb_build_object('status', 'PLANNED', 'planId', existing, 'replayed', true); END IF;
  -- Authority again after the row locks; a refusal plans nothing (prepare records why).
  IF NOT hon.eian_access(p_subject) THEN RETURN jsonb_build_object('status', 'NO_CHOICE', 'reason', 'AI_ACCESS_REFUSED'); END IF;
  IF w.status <> 'READY' OR w.work_type <> 'AI_' || (lim->>'taskClass') THEN RAISE EXCEPTION 'AI planning work item version/state conflict' USING ERRCODE = '40001'; END IF;
  v_units := (lim->>'inputBudget')::integer + (lim->>'outputBudget')::integer;
  v_credits := (v_units + 999) / 1000;
  -- The same organization-month estimate as plan_ai_invocation (eligibility only; not a reservation).
  SELECT COALESCE(sum(customer_credits), 0) INTO v_used FROM hon.ai_usage_ledger
    WHERE organization_id = sc.organization_id AND spend_class = 'AGENT_INFERENCE' AND occurred_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      AND occurred_at < ((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC');
  IF v_used + v_credits > hon.ai_org_ceiling(sc.organization_id, now()) THEN v_denial := 'CUSTOMER_BUDGET_EXCEEDED'; END IF;
  IF v_denial IS NULL THEN
    SELECT * INTO v_choice FROM hon.ai_select_text_route(sc.organization_id, sc.school_id, t.work_item_id, 'eian', lim->>'taskClass', v_units,
      (lim->>'maxProviderCostMicrounits')::bigint);
    v_denial := v_choice.denial;
  END IF;
  IF v_denial IS NOT NULL THEN RETURN jsonb_build_object('status', 'NO_CHOICE', 'reason', v_denial); END IF;
  v_hash := encode(sha256(convert_to(jsonb_build_object('command','ai.invocation.plan','organizationId',sc.organization_id,'schoolId',sc.school_id,
    'workItemId',t.work_item_id,'input',jsonb_build_object('agentKey','eian','turnId',t.id,'limits',lim))::text, 'UTF8')), 'hex');
  INSERT INTO hon.ai_invocation_plans (organization_id,school_id,work_item_id,work_item_version,work_item_state,
    agent_key,modality,task_class,risk_class,input_budget,output_budget,max_provider_cost_microunits,
    estimated_provider_cost_microunits,customer_credit_estimate,provider_id,model_id,catalog_id,catalog_version,
    routing_policy_id,routing_policy_version,provider_version,request_hash,task_profile_id,task_profile_version,route_selection)
  VALUES (sc.organization_id,sc.school_id,t.work_item_id,w.version,w.status,'eian','TEXT',lim->>'taskClass','LOW',
    (lim->>'inputBudget')::integer,(lim->>'outputBudget')::integer,(lim->>'maxProviderCostMicrounits')::bigint,
    v_choice.estimated_cost::bigint,v_credits,v_choice.provider_id,v_choice.model_id,v_choice.catalog_id,v_choice.catalog_version,
    v_choice.policy_id,v_choice.policy_version,v_choice.provider_version,v_hash,v_choice.profile_id,v_choice.profile_version,v_choice.route_selection)
  RETURNING id INTO v_plan_id;
  v_payload := jsonb_build_object('planId',v_plan_id,'workItemId',t.work_item_id,'workItemVersion',w.version,'status','PLANNED','requestHash',v_hash,
    'estimatedProviderCostMicrounits',v_choice.estimated_cost,'customerCreditEstimate',v_credits,'execution','NOT_PERFORMED','authority','UNCHANGED');
  INSERT INTO hon.audit_events (organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,
    prior_state,next_state,result,request_id,correlation_id,action_request_id)
  VALUES (sc.organization_id,sc.school_id,sc.principal_id,'HUMAN_UI','ai.invocation.plan','AI_INVOCATION_PLAN',v_plan_id,NULL,v_payload,'SUCCEEDED',p_request_id,p_correlation_id,NULL);
  INSERT INTO hon.outbox_events (organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
  VALUES (sc.organization_id,sc.school_id,'ai.invocation.planned',1,'AI_INVOCATION_PLAN',v_plan_id,1,p_correlation_id,p_request_id,v_payload);
  RETURN jsonb_build_object('status', 'PLANNED', 'planId', v_plan_id, 'replayed', false);
END $$;

-- ---- Prepare ----
-- Moves a pending turn to SENDING (with its reservation) or records why it cannot be sent, then returns the provider
-- input. The organization budget lock is taken first, as in every S4 prepare. p_scope names the scope the API built
-- p_facts under; it must be this turn's family and the parent's live scope after every lock (review condition A1).
-- Order of refusals: scope, access, S4 spend decision (HQ pause, exception, school decision), plan, provider
-- readiness, organization ceiling, Eian share. A refusal reserves nothing and never calls a provider.
CREATE FUNCTION hon.prepare_eian_turn(p_subject text, p_turn uuid, p_plan uuid, p_ready boolean, p_scope jsonb, p_facts jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id());
  sc record; live record; lim jsonb := hon.eian_turn_limits(); t hon.eian_turns%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE;
  why text; history jsonb; facts jsonb; ceiling bigint;
BEGIN
  SELECT * INTO STRICT sc FROM hon.eian_scope(p_subject);
  SELECT * INTO t FROM hon.eian_turns WHERE id = p_turn AND requested_by = sc.principal_id AND family_id = sc.family_id
    AND organization_id = sc.organization_id AND school_id = sc.school_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EIAN_TURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF t.status <> 'PENDING' THEN RETURN NULL; END IF;
  PERFORM 1 FROM hon.work_items WHERE id = t.work_item_id FOR UPDATE;
  -- The facts must have been built under exactly this turn's scope, and that is still the parent's scope now.
  SELECT * INTO STRICT live FROM hon.eian_scope(p_subject);
  IF p_scope IS NULL OR jsonb_typeof(p_scope) <> 'object'
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_scope) k) IS DISTINCT FROM ARRAY['familyId','organizationId','schoolId']
     OR p_scope->>'organizationId' IS DISTINCT FROM t.organization_id::text OR p_scope->>'schoolId' IS DISTINCT FROM t.school_id::text
     OR p_scope->>'familyId' IS DISTINCT FROM t.family_id::text
     OR live.principal_id IS DISTINCT FROM t.requested_by OR live.family_id IS DISTINCT FROM t.family_id THEN
    RAISE EXCEPTION 'EIAN_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT hon.eian_facts_ok(p_facts) THEN RAISE EXCEPTION 'EIAN_FACTS_INVALID' USING ERRCODE = '22023'; END IF;
  IF NOT hon.eian_access(p_subject) THEN why := 'AI_ACCESS_REFUSED'; END IF;
  IF why IS NULL THEN why := hon.ai_spend_allowed(t.organization_id, t.school_id, clock_timestamp(), 'AGENT_INFERENCE'); END IF;
  IF why IS NULL THEN
    -- No plan: the planner found no route, or its organization-month estimate was over the ceiling. Say which.
    IF p_plan IS NULL THEN
      why := CASE WHEN hon.ai_org_committed_credits(t.organization_id, clock_timestamp())
          + ((lim->>'inputBudget')::integer + (lim->>'outputBudget')::integer + 999) / 1000 > hon.ai_org_ceiling(t.organization_id, clock_timestamp())
        THEN 'CUSTOMER_BUDGET_EXCEEDED' ELSE 'NO_ELIGIBLE_ROUTE' END;
    ELSE
      SELECT * INTO p FROM hon.ai_invocation_plans WHERE id = p_plan AND organization_id = t.organization_id AND school_id = t.school_id
        AND work_item_id = t.work_item_id AND agent_key = 'eian' AND task_class = lim->>'taskClass' AND input_budget = (lim->>'inputBudget')::integer
        AND output_budget = (lim->>'outputBudget')::integer AND max_provider_cost_microunits = (lim->>'maxProviderCostMicrounits')::bigint;
      IF NOT FOUND THEN RAISE EXCEPTION 'EIAN_PLAN_SWAP' USING ERRCODE = '42501'; END IF;
      IF p.provider_id <> 'OPENROUTER' THEN why := 'UNSUPPORTED_PROVIDER'; ELSIF NOT coalesce(p_ready, false) THEN why := 'CONFIGURATION_REQUIRED'; END IF;
    END IF;
  END IF;
  -- ai.budget:<org> is already held (first declaration above).
  IF why IS NULL THEN
    ceiling := hon.ai_org_ceiling(t.organization_id, clock_timestamp());
    IF hon.ai_org_committed_credits(t.organization_id, clock_timestamp()) + p.customer_credit_estimate > ceiling THEN
      why := 'CUSTOMER_BUDGET_EXCEEDED';
    ELSIF (hon.eian_committed_credits(t.organization_id, clock_timestamp()) + p.customer_credit_estimate) * 100 > ceiling * hon.eian_share_percent() THEN
      why := 'EIAN_SHARE_REACHED';
    END IF;
  END IF;
  UPDATE hon.eian_turns SET plan_id = p.id,
    status = CASE WHEN why IS NULL THEN 'SENDING' WHEN why = 'CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED' ELSE 'BLOCKED' END,
    reason = why, reserved_credits = CASE WHEN why IS NULL THEN p.customer_credit_estimate ELSE 0 END, updated_at = clock_timestamp()
  WHERE id = t.id;
  UPDATE hon.work_items SET status = CASE WHEN why IS NULL THEN 'WORKING' ELSE 'NEEDS_ATTENTION' END, version = version + 1, updated_at = clock_timestamp()
  WHERE id = t.work_item_id;
  IF why IS NOT NULL THEN RETURN NULL; END IF;
  -- The family's last three answered turns (this guardian, this family), trimmed. Untrusted data like the facts.
  SELECT coalesce(jsonb_agg(z.h ORDER BY z.created_at), '[]'::jsonb) INTO history FROM (
    SELECT x.created_at, jsonb_build_object('question', left(x.question, 150), 'answer', left(x.reply_text, 300)) h
    FROM hon.eian_turns x WHERE x.requested_by = t.requested_by AND x.family_id = t.family_id AND x.status = 'COMPLETED' AND x.id <> t.id
      AND x.created_at < t.created_at ORDER BY x.created_at DESC LIMIT 3) z;
  -- Final live-clock revalidation before any context leaves prepare. A lapse releases the reservation and sends nothing.
  SELECT * INTO live FROM hon.eian_scope(p_subject);
  IF NOT hon.eian_access(p_subject) OR live.family_id IS DISTINCT FROM t.family_id OR live.principal_id IS DISTINCT FROM t.requested_by THEN
    UPDATE hon.eian_turns SET status = 'BLOCKED', reason = 'AI_ACCESS_REFUSED', reserved_credits = 0, updated_at = clock_timestamp() WHERE id = t.id;
    UPDATE hon.work_items SET status = 'NEEDS_ATTENTION', version = version + 1, updated_at = clock_timestamp() WHERE id = t.work_item_id;
    RETURN NULL;
  END IF;
  facts := jsonb_build_object('family', p_facts, 'history', history);
  UPDATE hon.eian_turns SET context_digest = encode(sha256(convert_to(jsonb_build_object('question', t.question, 'facts', facts)::text, 'UTF8')), 'hex')
  WHERE id = t.id;
  RETURN jsonb_build_object('providerId', p.provider_id, 'modelId', p.model_id, 'providerRequestId', t.provider_request_id,
    'question', t.question, 'facts', facts::text, 'inputBudget', p.input_budget, 'outputBudget', p.output_budget,
    'maxCostMicrounits', p.max_provider_cost_microunits);
END $$;

-- ---- Outcomes ----
-- A provider outcome without a result. PRE_SEND and FAILED release the hold; UNKNOWN keeps it for the HQ queue (S4-d).
CREATE FUNCTION hon.fail_eian_turn(p_subject text, p_turn uuid, p_outcome text, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); t hon.eian_turns%ROWTYPE;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('PRE_SEND', 'FAILED', 'UNKNOWN')
     OR p_reason IS NULL OR p_reason NOT IN ('CONFIGURATION_REQUIRED', 'UNSUPPORTED_PROVIDER', 'INVALID_REQUEST', 'PROVIDER_REJECTED', 'PROVIDER_UNKNOWN', 'PROVIDER_UNAVAILABLE')
     OR (p_reason = 'PROVIDER_UNAVAILABLE' AND p_outcome <> 'FAILED') THEN
    RAISE EXCEPTION 'INVALID_EIAN_OUTCOME' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO t FROM hon.eian_turns WHERE id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND OR t.status <> 'SENDING' THEN RAISE EXCEPTION 'EIAN_OUTCOME_REPLAY' USING ERRCODE = '40001'; END IF;
  UPDATE hon.eian_turns SET status = CASE WHEN p_outcome = 'PRE_SEND' THEN 'CONFIGURATION_REQUIRED' ELSE p_outcome END,
    reason = p_reason, reserved_credits = CASE WHEN p_outcome = 'UNKNOWN' THEN reserved_credits ELSE 0 END, updated_at = clock_timestamp()
  WHERE id = t.id;
  UPDATE hon.work_items SET status = 'NEEDS_ATTENTION', version = version + 1, updated_at = clock_timestamp() WHERE id = t.work_item_id;
END $$;

-- S4-a for Eian: evidence-only actor (succeeds after a mid-flight lapse); exactly one ledger row per call; the hold is
-- released; the answer is shown only while access holds, otherwise recorded and held. A result above the plan's
-- budgets or the reservation is recorded (the provider charged it) but never shown. Credits settle to measured tokens.
CREATE FUNCTION hon.record_eian_turn_result(p_subject text, p_turn uuid, p_result jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); t hon.eian_turns%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE;
  uid uuid; credits integer; over boolean; reply text; outcome text;
BEGIN
  SELECT * INTO t FROM hon.eian_turns WHERE id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND OR t.status <> 'SENDING' OR t.usage_id IS NOT NULL THEN RAISE EXCEPTION 'EIAN_OUTCOME_REPLAY' USING ERRCODE = '40001'; END IF;
  SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id = t.plan_id;
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' OR NOT p_result ?& ARRAY['reply', 'inputTokens', 'outputTokens', 'providerCostMicrounits']
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('reply', 'screen', 'inputTokens', 'outputTokens', 'providerCostMicrounits'))
     OR (p_result ? 'screen' AND (jsonb_typeof(p_result->'screen') <> 'string'
         OR p_result->>'screen' NOT IN ('SCHEDULE','BOOK_CLASS','REPORT_ABSENCE','BILLING','TESTING','MESSAGES')))
     OR jsonb_typeof(p_result->'reply') <> 'string' OR length(btrim(p_result->>'reply')) NOT BETWEEN 1 AND 1500
     OR jsonb_typeof(p_result->'inputTokens') <> 'number' OR (p_result->>'inputTokens') !~ '^[1-9][0-9]{0,6}$'
     OR jsonb_typeof(p_result->'outputTokens') <> 'number' OR (p_result->>'outputTokens') !~ '^[1-9][0-9]{0,6}$'
     OR jsonb_typeof(p_result->'providerCostMicrounits') <> 'number' OR (p_result->>'providerCostMicrounits') !~ '^(0|[1-9][0-9]{0,9})$' THEN
    RAISE EXCEPTION 'INVALID_EIAN_RESULT' USING ERRCODE = '22023';
  END IF;
  reply := btrim(p_result->>'reply');
  credits := ((p_result->>'inputTokens')::integer + (p_result->>'outputTokens')::integer + 999) / 1000;
  over := (p_result->>'inputTokens')::integer > p.input_budget OR (p_result->>'outputTokens')::integer > p.output_budget
    OR (p_result->>'providerCostMicrounits')::bigint > p.max_provider_cost_microunits OR credits > t.reserved_credits;
  INSERT INTO hon.ai_usage_ledger(organization_id, school_id, initiator_principal_id, work_item_id, provider_code, model_code, modality,
      input_units, output_units, provider_cost_microunits, customer_credits, correlation_id, source_invocation_id, spend_class)
    VALUES (t.organization_id, t.school_id, actor, t.work_item_id, p.provider_id, p.model_id, 'TEXT',
      (p_result->>'inputTokens')::bigint, (p_result->>'outputTokens')::bigint, (p_result->>'providerCostMicrounits')::bigint, credits,
      nullif(current_setting('app.hon_request_id', true), '')::uuid, t.id, 'AGENT_INFERENCE')
    RETURNING id INTO uid;
  outcome := CASE WHEN over THEN 'FAILED' WHEN NOT hon.eian_access(p_subject) THEN 'RESULT_HELD' ELSE 'COMPLETED' END;
  UPDATE hon.eian_turns SET usage_id = uid, reserved_credits = 0, status = outcome,
    reason = CASE WHEN outcome = 'FAILED' THEN 'RESULT_BUDGET_EXCEEDED' WHEN outcome = 'RESULT_HELD' THEN 'ACCESS_LAPSED' END,
    reply_text = CASE WHEN outcome = 'FAILED' THEN NULL ELSE reply END,
    suggested_screen = CASE WHEN outcome = 'FAILED' THEN NULL ELSE p_result->>'screen' END, updated_at = clock_timestamp()
  WHERE id = t.id;
  UPDATE hon.work_items SET status = CASE outcome WHEN 'COMPLETED' THEN 'COMPLETED' ELSE 'NEEDS_ATTENTION' END, version = version + 1, updated_at = clock_timestamp()
  WHERE id = t.work_item_id;
  RETURN outcome;
END $$;

-- ---- S4 enumerations: the Eian turn joins every shared spend function, as 0210 did for HON_REPLY ----
-- The two S4 evidence tables accept the Eian agent.
ALTER TABLE hon.ai_unknown_resolutions DROP CONSTRAINT ai_unknown_resolutions_agent_check;
ALTER TABLE hon.ai_unknown_resolutions ADD CONSTRAINT ai_unknown_resolutions_agent_check CHECK (agent IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY','EIAN'));
ALTER TABLE hon.ai_late_provider_expenses DROP CONSTRAINT ai_late_provider_expenses_agent_check;
ALTER TABLE hon.ai_late_provider_expenses ADD CONSTRAINT ai_late_provider_expenses_agent_check CHECK (agent IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY','EIAN'));

-- ai_org_committed_credits (latest body: 0210_hon_conversation_reply.sql): Eian holds count against the organization ceiling.
CREATE OR REPLACE FUNCTION hon.ai_org_committed_credits(p_org uuid, p_at timestamptz) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  -- Agent-inference ledger credits in the window plus every agent hold that counts (hon.ai_hold_counts), across all
  -- five agent callers (three specialists, the HON reply and parent Eian turns) and all schools of the organization. Callers hold ai.budget:<org> (hon.ai_budget_lock) and evaluate
  -- this in a statement that starts after the lock (READ COMMITTED), so every earlier committed hold is visible.
  -- A hold's time is its immutable held_at (stamped when the hold was taken), never the mutable updated_at.
  WITH w AS (SELECT hon.ai_spend_window(p_org, p_at) AS r)
  SELECT (SELECT coalesce(sum(u.customer_credits),0) FROM hon.ai_usage_ledger u, w
           WHERE u.organization_id=p_org AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=lower(w.r) AND u.occurred_at<upper(w.r))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.marketing_ai_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.teaching_ai_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.chad_follow_up_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.hon_reply_invocations i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(i.reserved_credits),0) FROM hon.eian_turns i, w WHERE i.organization_id=p_org AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at));
$$;

-- ai_org_open_agent_holds (latest body: 0272_hon_os_trial_ai_credit_fixes.sql): Eian holds join the trial and credit hold accounting.
CREATE OR REPLACE FUNCTION hon.ai_org_open_agent_holds(p_org uuid)
RETURNS TABLE(held_at timestamptz, status text, reserved_credits bigint, max_provider_cost_microunits bigint)
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.marketing_ai_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.teaching_ai_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.chad_follow_up_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.hon_reply_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.eian_turns i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0;
$$;

-- ai_school_committed_cost_micros (latest body: 0288_ai_school_cost_ceiling.sql): Eian holds count against the per-school cost ceiling.
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
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at));
$$;

-- ai_unknown_validate (latest body: 0210_hon_conversation_reply.sql): EIAN is a resolvable agent.
CREATE OR REPLACE FUNCTION hon.ai_unknown_validate(p_agent text, p_input jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE e jsonb := p_input->'evidence'; d text := p_input->>'decision';
  nonneg CONSTANT text := '^(0|[1-9][0-9]{0,11})$'; ref CONSTANT text := '^[A-Za-z0-9._:-]{1,200}$';
BEGIN
  IF p_agent IS NULL OR p_agent NOT IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY','EIAN') OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
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

-- resolve_ai_unknown_invocation (latest body: 0210_hon_conversation_reply.sql): an unknown Eian turn is resolved by HQ like any agent call.
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
    WHEN 'CHAD_FOLLOW_UP' THEN 'chad_follow_up_invocations' WHEN 'HON_REPLY' THEN 'hon_reply_invocations' WHEN 'EIAN' THEN 'eian_turns' END;
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

-- record_ai_late_provider_expense (latest body: 0210_hon_conversation_reply.sql): late actuals for a written-off Eian turn.
CREATE OR REPLACE FUNCTION hon.record_ai_late_provider_expense(p_subject text, p_agent text, p_id uuid, p_input jsonb, p_key uuid, p_request_id uuid, p_correlation_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; e jsonb := p_input->'evidence'; r hon.ai_unknown_resolutions%ROWTYPE; x hon.ai_late_provider_expenses%ROWTYPE;
  wl hon.ai_usage_ledger%ROWTYPE; receipt jsonb;
  nonneg CONSTANT text := '^(0|[1-9][0-9]{0,11})$'; ref CONSTANT text := '^[A-Za-z0-9._:-]{1,200}$';
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_id IS NULL OR p_key IS NULL OR p_request_id IS NULL OR p_correlation_id IS NULL OR p_agent IS NULL OR p_agent NOT IN ('MARKETING','TEACHING','CHAD_FOLLOW_UP','HON_REPLY','EIAN')
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

-- read_ai_unknown_invocations_from_hq (latest body: 0210_hon_conversation_reply.sql): unknown Eian turns appear in the HQ queue.
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
          UNION ALL SELECT 'EIAN',id,organization_id,school_id,status,reserved_credits,held_at FROM hon.eian_turns) a
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

-- read_ai_school_usage_from_hq (latest body: 0328_hq_usage_specialist_attribution.sql): HQ usage attributes Eian spend and counts unresolved Eian turns.
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
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.eian_turns) h
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
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.eian_turns WHERE organization_id = o.organization_id) h
          WHERE h.reserved_credits > 0 AND (h.status = 'UNKNOWN' OR (h.status = 'SENDING' AND h.held_at <= at - hon.ai_sending_stale_after()))),
        'aiPaused', EXISTS (SELECT 1 FROM hon.ai_spend_pauses p WHERE p.ended_at IS NULL AND (p.organization_id = o.organization_id OR p.organization_id IS NULL)))
        ORDER BY o.organization_id)
      FROM orgs o CROSS JOIN LATERAL (SELECT hon.ai_spend_window(o.organization_id, at) AS r) w), '[]'::jsonb),
    'providerCostUnit', 'MICROUNITS_USD')
  INTO result;
  RETURN result;
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.ai_select_text_route(uuid,uuid,uuid,text,text,integer,bigint)','hon.eian_turn_limits()','hon.eian_share_percent()',
      'hon.eian_burst_limit()','hon.eian_scope(text)','hon.eian_access(text)','hon.eian_committed_credits(uuid,timestamptz)',
      'hon.eian_unavailable_reason(uuid,uuid,boolean)','hon.eian_facts_ok(jsonb)','hon.eian_turn_view(hon.eian_turns,boolean)',
      'hon.read_eian_status(text,boolean)','hon.read_eian_turn(text,uuid)','hon.begin_eian_turn(text,text,text)','hon.plan_eian_turn(text,uuid,uuid,uuid)',
      'hon.prepare_eian_turn(text,uuid,uuid,boolean,jsonb,jsonb)','hon.fail_eian_turn(text,uuid,text,text)','hon.record_eian_turn_result(text,uuid,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  REVOKE ALL ON TABLE hon.eian_turns FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.eian_turns FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_eian_status(text,boolean), hon.read_eian_turn(text,uuid), hon.begin_eian_turn(text,text,text),
      hon.plan_eian_turn(text,uuid,uuid,uuid), hon.prepare_eian_turn(text,uuid,uuid,boolean,jsonb,jsonb), hon.fail_eian_turn(text,uuid,text,text),
      hon.record_eian_turn_result(text,uuid,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
