BEGIN;

-- 0668 (RA-1 follow-up, review P3 on 0336; was 0342, renumbered by the ledger 2026-11-24): the legacy POLICY_ORDER branch of
-- the text route selection gains the same failed-model exclusion as the task-profile branch. Since 0474 the selection lives
-- in the pure helper hon.ai_select_text_route (called by plan_ai_invocation and plan_eian_turn), so this replaces that
-- helper: body is 0474's with only that one condition added. Grants unchanged (CREATE OR REPLACE keeps the owner-only ACL).
-- plan_ai_invocation and plan_eian_turn are not touched. Spec: docs/architecture/AI_REDUCED_MODE.md.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.ai_route_unavailable_attempts') IS NULL THEN RAISE EXCEPTION 'Apply migration 0336 first'; END IF;
  IF to_regprocedure('hon.ai_select_text_route(uuid,uuid,uuid,text,text,integer,bigint)') IS NULL THEN RAISE EXCEPTION 'Apply migration 0474 first'; END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.ai_select_text_route(p_org uuid, p_school uuid, p_work_id uuid, p_agent text, p_task_class text, p_units integer, p_max_cost bigint)
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
        -- 0668: the legacy policy order also never picks a model that was definitely unavailable for this work item, so a
        -- fallback after HQ deactivates the task profile between attempts cannot call the failed model again.
        AND NOT EXISTS (SELECT 1 FROM hon.ai_route_unavailable_attempts ua WHERE ua.work_item_id = p_work_id AND ua.catalog_id = c.catalog_id)
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

COMMIT;
