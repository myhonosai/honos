BEGIN;
-- S4-b organization-wide agent budget and lock (AI-2, AI-3, AI-17). Owner decisions AI-D6/OD-23 (2026-10-31),
-- build authorized 2026-11-01. Marcus, Claire and Chad now share ONE organization budget per window, computed by
-- one function, under ONE advisory lock (ai.budget:<org>) taken first in every prepare. Before this, each agent
-- summed only its own holds, so three agents together could commit more than the 12,000 ceiling (KF-AI2), and
-- same-agent serialization depended on an incidental row lock (KF-AI3).
-- Policy values are unchanged: the legacy 12,000 ceiling and the UTC calendar-month window, now each in one
-- function. No new spend path, no allowance, no provider call, no grant to the runtime role.

-- AI-17: agent budget counts agent inference only. Creative (B3) usage rows are classified and never reduce it.
-- Unclassified future rows default to AGENT_INFERENCE, which counts against the agent budget (fail closed).
ALTER TABLE hon.ai_usage_ledger ADD COLUMN spend_class text NOT NULL DEFAULT 'AGENT_INFERENCE'
  CONSTRAINT ai_usage_ledger_spend_class_check CHECK (spend_class IN ('AGENT_INFERENCE','CREATIVE_MEDIA','HQ_INTERNAL'));
UPDATE hon.ai_usage_ledger u SET spend_class='CREATIVE_MEDIA'
 WHERE EXISTS (SELECT 1 FROM hon.saas_credit_reservations r WHERE r.usage_id=u.id OR r.id=u.correlation_id);
CREATE INDEX ai_usage_ledger_org_class_occurred_idx ON hon.ai_usage_ledger(organization_id, spend_class, occurred_at);

CREATE FUNCTION hon.ai_spend_window(p_org uuid, p_at timestamptz) RETURNS tstzrange LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  -- The single place the budget window is defined. Today: the UTC calendar month for every organization
  -- (unchanged behavior). A paid-period window needs its own owner decision (FD-A5).
  SELECT tstzrange(date_trunc('month', p_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
                   (date_trunc('month', p_at AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC', '[)');
$$;

CREATE FUNCTION hon.ai_org_ceiling(p_org uuid, p_at timestamptz) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  -- Owner-decided legacy/interim agent ceiling (OD-23). Allowances from approved sources replace this later.
  SELECT 12000;
$$;

CREATE FUNCTION hon.ai_org_committed_credits(p_org uuid, p_at timestamptz) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  -- Agent-inference ledger credits in the window plus every open agent hold, across all three agents and all
  -- schools of the organization. Callers hold ai.budget:<org> (hon.ai_budget_lock) and evaluate this in a
  -- statement that starts after the lock (READ COMMITTED), so every earlier committed hold is visible.
  WITH w AS (SELECT hon.ai_spend_window(p_org, p_at) AS r)
  SELECT (SELECT coalesce(sum(u.customer_credits),0) FROM hon.ai_usage_ledger u, w
           WHERE u.organization_id=p_org AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=lower(w.r) AND u.occurred_at<upper(w.r))
       + (SELECT coalesce(sum(reserved_credits),0) FROM hon.marketing_ai_invocations WHERE organization_id=p_org)
       + (SELECT coalesce(sum(reserved_credits),0) FROM hon.teaching_ai_invocations WHERE organization_id=p_org)
       + (SELECT coalesce(sum(reserved_credits),0) FROM hon.chad_follow_up_invocations WHERE organization_id=p_org);
$$;

CREATE FUNCTION hon.ai_budget_lock(p_org uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN
  -- The FIRST lock every prepare takes (its first declaration, before the agent gate locks organization, school
  -- and principal rows). Only agent spend paths take it, and nothing that holds it waits for another spend path,
  -- so it cannot join a lock cycle: a prepare never holds ai.budget while waiting on a row lock that another
  -- prepare holds. Entitlement, exception and activation writers never take it. Re-entrant within a transaction.
  IF p_org IS NULL THEN RAISE EXCEPTION 'AI_BUDGET_SCOPE_REQUIRED' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.budget:' || p_org::text, 0));
  RETURN true;
END $$;

-- Defense in depth: any increase of an agent hold, by any path, re-checks the organization budget under the lock.
CREATE FUNCTION hon.ai_spend_reserve_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE prior bigint := CASE WHEN TG_OP='UPDATE' THEN OLD.reserved_credits ELSE 0 END;
BEGIN
  PERFORM hon.ai_budget_lock(NEW.organization_id);
  IF hon.ai_org_committed_credits(NEW.organization_id, clock_timestamp()) - prior + NEW.reserved_credits
     > hon.ai_org_ceiling(NEW.organization_id, clock_timestamp()) THEN
    RAISE EXCEPTION 'AI_ORG_BUDGET_EXCEEDED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_spend_reserve_guard BEFORE UPDATE OF reserved_credits ON hon.marketing_ai_invocations
  FOR EACH ROW WHEN (NEW.reserved_credits > OLD.reserved_credits) EXECUTE FUNCTION hon.ai_spend_reserve_guard();
CREATE TRIGGER ai_spend_reserve_guard_insert BEFORE INSERT ON hon.marketing_ai_invocations
  FOR EACH ROW WHEN (NEW.reserved_credits > 0) EXECUTE FUNCTION hon.ai_spend_reserve_guard();
CREATE TRIGGER ai_spend_reserve_guard BEFORE UPDATE OF reserved_credits ON hon.teaching_ai_invocations
  FOR EACH ROW WHEN (NEW.reserved_credits > OLD.reserved_credits) EXECUTE FUNCTION hon.ai_spend_reserve_guard();
CREATE TRIGGER ai_spend_reserve_guard_insert BEFORE INSERT ON hon.teaching_ai_invocations
  FOR EACH ROW WHEN (NEW.reserved_credits > 0) EXECUTE FUNCTION hon.ai_spend_reserve_guard();
CREATE TRIGGER ai_spend_reserve_guard BEFORE UPDATE OF reserved_credits ON hon.chad_follow_up_invocations
  FOR EACH ROW WHEN (NEW.reserved_credits > OLD.reserved_credits) EXECUTE FUNCTION hon.ai_spend_reserve_guard();
CREATE TRIGGER ai_spend_reserve_guard_insert BEFORE INSERT ON hon.chad_follow_up_invocations
  FOR EACH ROW WHEN (NEW.reserved_credits > 0) EXECUTE FUNCTION hon.ai_spend_reserve_guard();

-- Prepare paths: the per-agent sums are replaced by the organization function under the lock. A refusal keeps
-- the existing durable BLOCKED / CUSTOMER_BUDGET_EXCEEDED outcome and never reaches a provider.
-- Planning eligibility and ledger writers: class-aware (record_* write AGENT_INFERENCE, B3 writes CREATIVE_MEDIA).
CREATE OR REPLACE FUNCTION hon.prepare_marketing_invocation(p_subject text, p_id uuid, p_plan uuid, p_ready boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$
DECLARE budget_locked boolean:=hon.ai_budget_lock(hon.current_organization_id()); actor uuid:=hon.marketing_owner(p_subject); i hon.marketing_ai_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE;  v_reason text;
BEGIN
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MARKETING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '30 seconds' THEN UPDATE hon.marketing_ai_invocations SET status='UNKNOWN',reason='PROVIDER_UNKNOWN',updated_at=clock_timestamp() WHERE id=i.id; PERFORM hon.marketing_event(i.id,'marketing.assistant.unknown'); RETURN NULL; END IF;
 IF i.status NOT IN('PENDING','CONFIGURATION_REQUIRED','BLOCKED') THEN RETURN NULL; END IF;
 IF p_plan IS NULL THEN UPDATE hon.marketing_ai_invocations SET status='BLOCKED',reason='NO_ELIGIBLE_ROUTE' WHERE id=i.id; UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1 WHERE id=i.work_item_id; PERFORM hon.marketing_event(i.id,'marketing.assistant.blocked'); RETURN NULL; END IF;
 SELECT * INTO p FROM hon.ai_invocation_plans WHERE id=p_plan AND organization_id=i.organization_id AND school_id=i.school_id AND work_item_id=i.work_item_id AND task_class='DRAFT_MARKETING' AND agent_key='marcus' AND input_budget=4096 AND output_budget=1024 AND max_provider_cost_microunits=100000;
 IF NOT FOUND OR (i.plan_id IS NOT NULL AND i.plan_id<>p_plan) THEN RAISE EXCEPTION 'MARKETING_PLAN_SWAP' USING ERRCODE='42501'; END IF;
 -- Locks serialize HQ revocation with the final claim; historical plans do not authorize execution.
 PERFORM 1 FROM hon.hq_ai_provider_connections WHERE provider_id=p.provider_id FOR SHARE;
 PERFORM 1 FROM hon.hq_ai_model_catalog WHERE catalog_id=p.catalog_id FOR SHARE;
 PERFORM 1 FROM hon.hq_ai_routing_policies WHERE policy_id=p.routing_policy_id FOR SHARE;
 PERFORM 1 FROM hon.hq_ai_routing_candidates WHERE policy_id=p.routing_policy_id FOR SHARE;
 IF p.provider_id<>'OPENROUTER' THEN v_reason:='UNSUPPORTED_PROVIDER';
 ELSIF NOT EXISTS(SELECT 1 FROM hon.hq_ai_provider_connections pc JOIN hon.hq_ai_model_catalog m ON m.provider_id=pc.provider_id JOIN hon.hq_ai_routing_candidates rc ON rc.catalog_id=m.catalog_id JOIN hon.hq_ai_routing_policies rp ON rp.policy_id=rc.policy_id WHERE pc.provider_id=p.provider_id AND pc.state='HEALTHY' AND pc.version=p.provider_version AND m.catalog_id=p.catalog_id AND m.model_id=p.model_id AND m.version=p.catalog_version AND m.active AND m.cost_unit='TOKEN' AND 'TEXT'=ANY(m.capabilities) AND 'TEXT'=ANY(m.modalities) AND m.effective_from<=clock_timestamp() AND (m.effective_until IS NULL OR m.effective_until>clock_timestamp()) AND rp.policy_id=p.routing_policy_id AND rp.organization_id=i.organization_id AND rp.school_id=i.school_id AND rp.version=p.routing_policy_version AND rp.active AND rp.capability='TEXT' AND rp.effective_from<=clock_timestamp() AND (rp.effective_until IS NULL OR rp.effective_until>clock_timestamp()) AND m.unit_cost_micros*5120<=LEAST(rp.max_cost_micros,p.max_provider_cost_microunits)) THEN v_reason:='ROUTE_STALE';
 ELSIF NOT p_ready THEN v_reason:='CONFIGURATION_REQUIRED'; END IF;
 -- S4-b: one organization-wide agent budget; ai.budget:<org> is already held (first declaration above).
 IF v_reason IS NULL THEN IF hon.ai_org_committed_credits(i.organization_id,clock_timestamp())+p.customer_credit_estimate>hon.ai_org_ceiling(i.organization_id,clock_timestamp()) THEN v_reason:='CUSTOMER_BUDGET_EXCEEDED'; END IF; END IF;
 UPDATE hon.marketing_ai_invocations SET plan_id=p.id,status=CASE WHEN v_reason IS NULL THEN 'SENDING' WHEN v_reason='CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED' ELSE 'BLOCKED' END,reason=v_reason,reserved_credits=CASE WHEN v_reason IS NULL THEN p.customer_credit_estimate ELSE 0 END,updated_at=clock_timestamp() WHERE id=i.id;
 UPDATE hon.work_items SET status=CASE WHEN v_reason IS NULL THEN 'WORKING' ELSE 'NEEDS_ATTENTION' END,version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;
 PERFORM hon.marketing_event(i.id,'marketing.assistant.prepared');
 IF v_reason IS NOT NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('providerId',p.provider_id,'modelId',p.model_id,'providerRequestId',i.provider_request_id,'request',i.request_text,'inputBudget',p.input_budget,'outputBudget',p.output_budget,'maxCostMicrounits',p.max_provider_cost_microunits);
END $function$;

CREATE OR REPLACE FUNCTION hon.prepare_teaching_invocation(p_subject text, p_id uuid, p_plan uuid, p_ready boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$
DECLARE budget_locked boolean:=hon.ai_budget_lock(hon.current_organization_id()); actor uuid:=hon.require_teaching_assistant_actor(p_subject,true); i hon.teaching_ai_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE;  why text; facts jsonb;
BEGIN SELECT * INTO i FROM hon.teaching_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'TEACHING_INVOCATION_NOT_FOUND' USING ERRCODE='P0002'; END IF; IF i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '30 seconds' THEN UPDATE hon.teaching_ai_invocations SET status='UNKNOWN',reason='PROVIDER_UNKNOWN',updated_at=clock_timestamp() WHERE id=i.id; PERFORM hon.teaching_assistant_event(i.id,'teaching.assistant.unknown'); RETURN NULL; END IF; IF i.status NOT IN('PENDING','CONFIGURATION_REQUIRED','BLOCKED') THEN RETURN NULL; END IF; IF p_plan IS NULL THEN UPDATE hon.teaching_ai_invocations SET status='BLOCKED',reason='NO_ELIGIBLE_ROUTE' WHERE id=i.id; UPDATE hon.work_items SET status='NEEDS_ATTENTION',version=version+1 WHERE id=i.work_item_id; PERFORM hon.teaching_assistant_event(i.id,'teaching.assistant.blocked'); RETURN NULL; END IF; SELECT * INTO p FROM hon.ai_invocation_plans WHERE id=p_plan AND organization_id=i.organization_id AND school_id=i.school_id AND work_item_id=i.work_item_id AND task_class='DRAFT_TEACHING' AND agent_key='claire' AND input_budget=4096 AND output_budget=1024 AND max_provider_cost_microunits=100000; IF NOT FOUND OR (i.plan_id IS NOT NULL AND i.plan_id<>p_plan) THEN RAISE EXCEPTION 'TEACHING_PLAN_SWAP' USING ERRCODE='42501'; END IF; PERFORM 1 FROM hon.hq_ai_provider_connections WHERE provider_id=p.provider_id FOR SHARE; PERFORM 1 FROM hon.hq_ai_model_catalog WHERE catalog_id=p.catalog_id FOR SHARE; PERFORM 1 FROM hon.hq_ai_routing_policies WHERE policy_id=p.routing_policy_id FOR SHARE; PERFORM 1 FROM hon.hq_ai_routing_candidates WHERE policy_id=p.routing_policy_id FOR SHARE;
 IF p.provider_id<>'OPENROUTER' THEN why:='UNSUPPORTED_PROVIDER'; ELSIF NOT EXISTS(SELECT 1 FROM hon.hq_ai_provider_connections pc JOIN hon.hq_ai_model_catalog m ON m.provider_id=pc.provider_id JOIN hon.hq_ai_routing_candidates rc ON rc.catalog_id=m.catalog_id JOIN hon.hq_ai_routing_policies rp ON rp.policy_id=rc.policy_id WHERE pc.provider_id=p.provider_id AND pc.state='HEALTHY' AND pc.version=p.provider_version AND m.catalog_id=p.catalog_id AND m.model_id=p.model_id AND m.version=p.catalog_version AND m.active AND m.cost_unit='TOKEN' AND 'TEXT'=ANY(m.capabilities) AND 'TEXT'=ANY(m.modalities) AND m.effective_from<=clock_timestamp() AND (m.effective_until IS NULL OR m.effective_until>clock_timestamp()) AND rp.policy_id=p.routing_policy_id AND rp.organization_id=i.organization_id AND rp.school_id=i.school_id AND rp.version=p.routing_policy_version AND rp.active AND rp.capability='TEXT' AND rp.effective_from<=clock_timestamp() AND (rp.effective_until IS NULL OR rp.effective_until>clock_timestamp()) AND m.unit_cost_micros*5120<=LEAST(rp.max_cost_micros,p.max_provider_cost_microunits)) THEN why:='ROUTE_STALE'; ELSIF NOT p_ready THEN why:='CONFIGURATION_REQUIRED'; END IF;
 -- S4-b: one organization-wide agent budget; ai.budget:<org> is already held (first declaration above).
 IF why IS NULL THEN IF hon.ai_org_committed_credits(i.organization_id,clock_timestamp())+p.customer_credit_estimate>hon.ai_org_ceiling(i.organization_id,clock_timestamp()) THEN why:='CUSTOMER_BUDGET_EXCEEDED'; END IF; END IF; UPDATE hon.teaching_ai_invocations SET plan_id=p.id,status=CASE WHEN why IS NULL THEN 'SENDING' WHEN why='CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED' ELSE 'BLOCKED' END,reason=why,reserved_credits=CASE WHEN why IS NULL THEN p.customer_credit_estimate ELSE 0 END,updated_at=clock_timestamp() WHERE id=i.id; UPDATE hon.work_items SET status=CASE WHEN why IS NULL THEN 'WORKING' ELSE 'NEEDS_ATTENTION' END,version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id; PERFORM hon.teaching_assistant_event(i.id,'teaching.assistant.prepared'); IF why IS NOT NULL THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('curriculum',jsonb_build_object('id',c.id,'name',c.name,'description',coalesce(c.description,''),'modelCode',c.model_code,'version',c.version),'ranks',coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'order',r.progression_order,'requirements',coalesce((SELECT jsonb_agg(jsonb_build_object('code',q.requirement_code,'kind',q.requirement_kind,'required',q.is_required,'version',q.version) ORDER BY q.requirement_code) FROM hon.curriculum_requirements q WHERE q.curriculum_rank_id=r.id AND q.organization_id=i.organization_id AND q.school_id=i.school_id),'[]'::jsonb)) ORDER BY r.progression_order),'[]'::jsonb),'brief',i.brief_text) INTO facts FROM hon.curricula c LEFT JOIN hon.curriculum_ranks r ON r.curriculum_id=c.id AND r.organization_id=c.organization_id AND r.school_id=c.school_id WHERE c.id=i.curriculum_id AND c.organization_id=i.organization_id AND c.school_id=i.school_id AND c.lifecycle='PUBLISHED' GROUP BY c.id,c.name,c.description,c.model_code,c.version,i.brief_text; IF facts IS NULL THEN RAISE EXCEPTION 'PUBLISHED_CURRICULUM_NOT_FOUND' USING ERRCODE='P0002'; END IF; RETURN jsonb_build_object('providerId',p.provider_id,'modelId',p.model_id,'providerRequestId',i.provider_request_id,'request','Approved curriculum facts only: '||facts::text,'inputBudget',p.input_budget,'outputBudget',p.output_budget,'maxCostMicrounits',p.max_provider_cost_microunits); END $function$;

CREATE OR REPLACE FUNCTION hon.prepare_chad_follow_up_invocation(p_subject text, p_id uuid, p_plan uuid, p_ready boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$ DECLARE budget_locked boolean:=hon.ai_budget_lock(hon.current_organization_id()); actor uuid:=hon.require_chad_follow_up_actor(p_subject);i hon.chad_follow_up_invocations%ROWTYPE;p hon.ai_invocation_plans%ROWTYPE;l hon.crm_leads%ROWTYPE;why text;facts jsonb;BEGIN SELECT * INTO i FROM hon.chad_follow_up_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'CHAD_FOLLOW_UP_NOT_FOUND' USING ERRCODE='P0002';END IF;IF i.status NOT IN('PENDING','CONFIGURATION_REQUIRED','BLOCKED') THEN RETURN NULL;END IF;IF p_plan IS NULL THEN why:='NO_ELIGIBLE_ROUTE';ELSE SELECT * INTO p FROM hon.ai_invocation_plans WHERE id=p_plan AND organization_id=i.organization_id AND school_id=i.school_id AND work_item_id=i.work_item_id AND task_class='DRAFT_FOLLOW_UP' AND agent_key='chad' AND input_budget=2048 AND output_budget=600 AND max_provider_cost_microunits=60000;IF NOT FOUND OR (i.plan_id IS NOT NULL AND i.plan_id<>p_plan) THEN RAISE EXCEPTION 'CHAD_FOLLOW_UP_PLAN_SWAP' USING ERRCODE='42501';END IF;IF p.provider_id<>'OPENROUTER' THEN why:='UNSUPPORTED_PROVIDER';ELSIF NOT p_ready THEN why:='CONFIGURATION_REQUIRED';END IF;END IF;SELECT * INTO l FROM hon.crm_leads WHERE id=i.lead_id AND organization_id=i.organization_id AND school_id=i.school_id AND status='OPEN' FOR SHARE;IF NOT FOUND OR l.version<>i.lead_version THEN why:='LEAD_STALE';END IF;-- S4-b: one organization-wide agent budget; ai.budget:<org> is already held (first declaration above).
 IF why IS NULL THEN IF hon.ai_org_committed_credits(i.organization_id,clock_timestamp())+p.customer_credit_estimate>hon.ai_org_ceiling(i.organization_id,clock_timestamp()) THEN why:='CUSTOMER_BUDGET_EXCEEDED'; END IF; END IF;UPDATE hon.chad_follow_up_invocations SET plan_id=p.id,status=CASE WHEN why IS NULL THEN 'SENDING' WHEN why='CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED' ELSE 'BLOCKED' END,reason=why,reserved_credits=CASE WHEN why IS NULL THEN p.customer_credit_estimate ELSE 0 END,updated_at=clock_timestamp() WHERE id=i.id;UPDATE hon.work_items SET status=CASE WHEN why IS NULL THEN 'WORKING' ELSE 'NEEDS_ATTENTION' END,version=version+1,updated_at=clock_timestamp() WHERE id=i.work_item_id;PERFORM hon.chad_follow_up_event(i.id,'chad.follow_up_draft.prepared');IF why IS NOT NULL THEN RETURN NULL;END IF;facts:=jsonb_build_object('purpose',i.purpose,'leadStatus',l.status,'pipelineStageId',l.pipeline_stage_id,'sourceCode',l.source_code,'programInterestCode',l.program_interest_code,'nextFollowUpAt',l.next_follow_up_at,'leadVersion',l.version);RETURN jsonb_build_object('providerId',p.provider_id,'modelId',p.model_id,'providerRequestId',i.provider_request_id,'request','Approved non-identifying lead facts only: '||facts::text,'inputBudget',p.input_budget,'outputBudget',p.output_budget,'maxCostMicrounits',p.max_provider_cost_microunits);END $function$;

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

CREATE OR REPLACE FUNCTION hon.record_marketing_result(p_subject text, p_id uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$
DECLARE actor uuid:=hon.ai_evidence_actor(p_subject); i hon.marketing_ai_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE; uid uuid; credits integer; d jsonb:=p_result->'draft'; over_budget boolean;
BEGIN
 SELECT * INTO i FROM hon.marketing_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;
 IF NOT FOUND OR i.status<>'SENDING' OR i.usage_id IS NOT NULL THEN RAISE EXCEPTION 'MARKETING_OUTCOME_REPLAY' USING ERRCODE='40001'; END IF;
 SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id=i.plan_id;
 IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR NOT p_result ?& ARRAY['draft','inputTokens','outputTokens','providerCostMicrounits'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN('draft','inputTokens','outputTokens','providerCostMicrounits')) OR jsonb_typeof(d)<>'object' OR NOT d ?& ARRAY['title','content'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN('title','content')) OR jsonb_typeof(d->'title')<>'string' OR jsonb_typeof(d->'content')<>'string' OR NOT hon.marketing_safe_text(d->>'title',160) OR NOT hon.marketing_safe_text(d->>'content',6000) OR (p_result->>'inputTokens') !~ '^[0-9]+$' OR (p_result->>'outputTokens') !~ '^[0-9]+$' OR (p_result->>'providerCostMicrounits') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'INVALID_MARKETING_RESULT' USING ERRCODE='22023'; END IF;
 credits:=((p_result->>'inputTokens')::integer+(p_result->>'outputTokens')::integer+999)/1000;
 over_budget:=(p_result->>'inputTokens')::integer>p.input_budget OR (p_result->>'outputTokens')::integer>p.output_budget OR (p_result->>'providerCostMicrounits')::bigint>p.max_provider_cost_microunits OR credits>i.reserved_credits;
 INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,provider_cost_microunits,customer_credits,correlation_id,source_invocation_id,spend_class)
 VALUES(i.organization_id,i.school_id,actor,i.work_item_id,p.provider_id,p.model_id,'TEXT',(p_result->>'inputTokens')::bigint,(p_result->>'outputTokens')::bigint,(p_result->>'providerCostMicrounits')::bigint,credits,nullif(current_setting('app.hon_request_id',true),'')::uuid,i.id,'AGENT_INFERENCE') RETURNING id INTO uid;
 UPDATE hon.marketing_ai_invocations SET usage_id=uid,reserved_credits=0,status=CASE WHEN over_budget THEN 'FAILED' ELSE 'RESULT_RECORDED' END,reason=CASE WHEN over_budget THEN 'RESULT_BUDGET_EXCEEDED' ELSE NULL END,updated_at=clock_timestamp() WHERE id=i.id;
 IF over_budget THEN UPDATE hon.work_items SET status='FAILED',version=version+1 WHERE id=i.work_item_id; PERFORM hon.marketing_event(i.id,'marketing.assistant.budget_failed'); RETURN NULL; END IF;
 INSERT INTO hon.marketing_ai_drafts(invocation_id,organization_id,school_id,campaign_id,title,content) VALUES(i.id,i.organization_id,i.school_id,i.campaign_id,d->>'title',d->>'content'); PERFORM hon.marketing_event(i.id,'marketing.assistant.result_recorded'); RETURN jsonb_build_object('invocationId',i.id,'campaignId',i.campaign_id,'campaignVersion',i.campaign_version,'title',d->>'title','content',d->>'content');
END $function$;

CREATE OR REPLACE FUNCTION hon.record_teaching_result(p_subject text, p_id uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$
DECLARE actor uuid:=hon.ai_evidence_actor(p_subject); i hon.teaching_ai_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE; uid uuid; credits integer; d jsonb:=p_result->'draft'; over boolean;
BEGIN SELECT * INTO i FROM hon.teaching_ai_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE; IF NOT FOUND OR i.status<>'SENDING' OR i.usage_id IS NOT NULL THEN RAISE EXCEPTION 'TEACHING_OUTCOME_REPLAY' USING ERRCODE='40001'; END IF; SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id=i.plan_id; IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR NOT p_result?&ARRAY['draft','inputTokens','outputTokens','providerCostMicrounits'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN('draft','inputTokens','outputTokens','providerCostMicrounits')) OR jsonb_typeof(d)<>'object' OR NOT d?&ARRAY['title','content'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN('title','content')) OR jsonb_typeof(d->'title')<>'string' OR jsonb_typeof(d->'content')<>'string' OR NOT hon.teaching_assistant_safe_text(d->>'title',160) OR NOT hon.teaching_assistant_safe_text(d->>'content',6000) OR (p_result->>'inputTokens')!~'^[0-9]+$' OR (p_result->>'outputTokens')!~'^[0-9]+$' OR (p_result->>'providerCostMicrounits')!~'^[0-9]+$' THEN RAISE EXCEPTION 'INVALID_TEACHING_RESULT' USING ERRCODE='22023'; END IF; credits:=((p_result->>'inputTokens')::integer+(p_result->>'outputTokens')::integer+999)/1000; over:=(p_result->>'inputTokens')::integer>p.input_budget OR (p_result->>'outputTokens')::integer>p.output_budget OR (p_result->>'providerCostMicrounits')::bigint>p.max_provider_cost_microunits OR credits>i.reserved_credits; INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,provider_cost_microunits,customer_credits,correlation_id,source_invocation_id,spend_class) VALUES(i.organization_id,i.school_id,actor,i.work_item_id,p.provider_id,p.model_id,'TEXT',(p_result->>'inputTokens')::bigint,(p_result->>'outputTokens')::bigint,(p_result->>'providerCostMicrounits')::bigint,credits,nullif(current_setting('app.hon_request_id',true),'')::uuid,i.id,'AGENT_INFERENCE') RETURNING id INTO uid; UPDATE hon.teaching_ai_invocations SET usage_id=uid,reserved_credits=0,status=CASE WHEN over THEN 'FAILED' ELSE 'RESULT_RECORDED' END,reason=CASE WHEN over THEN 'RESULT_BUDGET_EXCEEDED' ELSE NULL END,updated_at=clock_timestamp() WHERE id=i.id; IF over THEN UPDATE hon.work_items SET status='FAILED',version=version+1 WHERE id=i.work_item_id; PERFORM hon.teaching_assistant_event(i.id,'teaching.assistant.budget_failed'); RETURN NULL; END IF; INSERT INTO hon.teaching_ai_drafts(invocation_id,organization_id,school_id,curriculum_id,title,content) VALUES(i.id,i.organization_id,i.school_id,i.curriculum_id,d->>'title',d->>'content'); PERFORM hon.teaching_assistant_event(i.id,'teaching.assistant.result_recorded'); RETURN jsonb_build_object('invocationId',i.id,'curriculumId',i.curriculum_id,'curriculumVersion',i.curriculum_version,'title',d->>'title','content',d->>'content'); END $function$;

CREATE OR REPLACE FUNCTION hon.record_chad_follow_up_result(p_subject text, p_id uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$ DECLARE actor uuid:=hon.ai_evidence_actor(p_subject);i hon.chad_follow_up_invocations%ROWTYPE;p hon.ai_invocation_plans%ROWTYPE;d jsonb:=p_result->'draft';uid uuid;credits integer;over boolean;BEGIN SELECT * INTO i FROM hon.chad_follow_up_invocations WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND requested_by=actor FOR UPDATE;IF NOT FOUND OR i.status<>'SENDING' OR i.usage_id IS NOT NULL THEN RAISE EXCEPTION 'CHAD_FOLLOW_UP_OUTCOME_REPLAY' USING ERRCODE='40001';END IF;SELECT * INTO STRICT p FROM hon.ai_invocation_plans WHERE id=i.plan_id;IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR NOT p_result ?& ARRAY['draft','inputTokens','outputTokens','providerCostMicrounits'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN('draft','inputTokens','outputTokens','providerCostMicrounits')) OR jsonb_typeof(d)<>'object' OR NOT d ?& ARRAY['subject','content'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN('subject','content')) OR jsonb_typeof(d->'subject')<>'string' OR jsonb_typeof(d->'content')<>'string' OR length(btrim(d->>'subject')) NOT BETWEEN 1 AND 120 OR length(btrim(d->>'content')) NOT BETWEEN 1 AND 3000 OR (p_result->>'inputTokens')!~'^[0-9]+$' OR (p_result->>'outputTokens')!~'^[0-9]+$' OR (p_result->>'providerCostMicrounits')!~'^[0-9]+$' THEN RAISE EXCEPTION 'INVALID_CHAD_FOLLOW_UP_RESULT' USING ERRCODE='22023';END IF;credits:=((p_result->>'inputTokens')::integer+(p_result->>'outputTokens')::integer+999)/1000;over:=(p_result->>'inputTokens')::integer>p.input_budget OR (p_result->>'outputTokens')::integer>p.output_budget OR (p_result->>'providerCostMicrounits')::bigint>p.max_provider_cost_microunits OR credits>i.reserved_credits;INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,work_item_id,provider_code,model_code,modality,input_units,output_units,provider_cost_microunits,customer_credits,correlation_id,source_invocation_id,spend_class) VALUES(i.organization_id,i.school_id,actor,i.work_item_id,p.provider_id,p.model_id,'TEXT',(p_result->>'inputTokens')::bigint,(p_result->>'outputTokens')::bigint,(p_result->>'providerCostMicrounits')::bigint,credits,nullif(current_setting('app.hon_request_id',true),'')::uuid,i.id,'AGENT_INFERENCE') RETURNING id INTO uid;UPDATE hon.chad_follow_up_invocations SET usage_id=uid,reserved_credits=0,status=CASE WHEN over THEN 'FAILED' ELSE 'RESULT_RECORDED' END,reason=CASE WHEN over THEN 'RESULT_BUDGET_EXCEEDED' ELSE NULL END,updated_at=clock_timestamp() WHERE id=i.id;IF over THEN UPDATE hon.work_items SET status='FAILED',version=version+1 WHERE id=i.work_item_id;PERFORM hon.chad_follow_up_event(i.id,'chad.follow_up_draft.budget_failed');RETURN NULL;END IF;INSERT INTO hon.chad_follow_up_drafts(invocation_id,organization_id,school_id,lead_id,subject,content) VALUES(i.id,i.organization_id,i.school_id,i.lead_id,d->>'subject',d->>'content'); PERFORM hon.chad_follow_up_event(i.id,'chad.follow_up_draft.result_recorded'); RETURN jsonb_build_object('invocationId',i.id,'leadId',i.lead_id,'leadVersion',i.lead_version,'purpose',i.purpose,'subject',d->>'subject','content',d->>'content','delivery','NOT_CREATED_OR_SENT');END $function$;

CREATE OR REPLACE FUNCTION hon.saas_record_provider_usage(r hon.saas_credit_reservations, p_actor uuid, p_cost bigint, p_input bigint, p_output bigint)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hon'
AS $function$
DECLARE uid uuid;
BEGIN
  INSERT INTO hon.ai_usage_ledger(organization_id, school_id, initiator_principal_id, work_item_id, action_request_id, provider_code, model_code,
      modality, input_units, output_units, provider_cost_microunits, customer_credits, correlation_id, spend_class)
    VALUES (r.organization_id, r.school_id, p_actor, r.work_item_id, r.action_request_id, r.provider_id, r.model_code,
      CASE r.category WHEN 'IMAGE_GENERATION' THEN 'IMAGE' WHEN 'VIDEO_GENERATION' THEN 'VIDEO' WHEN 'VOICE_GENERATION' THEN 'VOICE_OUTPUT'
        WHEN 'AI_EMPLOYEE_TASK' THEN 'TOOL_EXECUTION' WHEN 'OTHER_APPROVED' THEN 'TOOL_EXECUTION' ELSE 'TEXT' END::hon.ai_modality,
      p_input, p_output, p_cost, 0, r.id, 'CREATIVE_MEDIA')
    RETURNING id INTO uid;
  RETURN uid;
END $function$;


DO $$ DECLARE f regprocedure; BEGIN
 FOREACH f IN ARRAY ARRAY['hon.ai_spend_window(uuid,timestamptz)'::regprocedure,'hon.ai_org_ceiling(uuid,timestamptz)'::regprocedure,
  'hon.ai_org_committed_credits(uuid,timestamptz)'::regprocedure,'hon.ai_budget_lock(uuid)'::regprocedure,'hon.ai_spend_reserve_guard()'::regprocedure] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM hon_runtime',f); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon',f); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated',f); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM service_role',f); END IF;
 END LOOP;
END $$;
COMMIT;
