BEGIN;

-- 0278 Readiness keeps both 0260 and 0272.
--
-- 0260 (Alex, Jordan and Lena) and 0272 (trial AI credit fixes) were written in parallel, and both redefine
-- hon.read_ai_team_readiness from the 0229 body. Migrations apply in number order, so 0272 replaced the 0260 body:
-- readiness lost the three analysis specialists and their capability check. This is the 0260 body with the 0272
-- change: the cost ceiling shown is hon.ai_org_display_ceiling(org, at). Nothing else changes; grants are kept by
-- CREATE OR REPLACE.

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
                                 ('chad', 'CHAD_FOLLOW_UP', 2648, 60000, 3), ('hon', 'HON_REPLY', 9500, 80000, 10),
                                 ('claire', 'BUSINESS_PERFORMANCE', 15000, 80000, 15), ('alex', 'GENERAL_MANAGEMENT', 15000, 80000, 15),
                                 ('jordan', 'OPERATIONS', 15000, 80000, 15), ('lena', 'CREATIVE_COMMERCE', 15000, 80000, 15)) v(agent_key, agent, units, max_cost, estimate) LOOP
    BEGIN
      IF a.agent_key = 'marcus' THEN PERFORM hon.marketing_owner(p_subject);
      ELSIF a.agent_key = 'kai' THEN PERFORM hon.require_teaching_assistant_actor(p_subject, false);
      ELSIF a.agent_key = 'chad' THEN PERFORM hon.require_chad_follow_up_actor(p_subject);
      ELSIF hon.hon_analysis_specialist(a.agent_key) THEN
        -- K2/0260: an analysis specialist needs the conversation, AI planning and its own capability (0212 binding).
        PERFORM hon.hon_conversation_actor(p_subject); PERFORM hon.require_ai_invocation_plan_access();
        IF NOT hon.principal_has_school_permission(actor, org, school, hon.ai_agent_capability_permission(a.agent_key)) THEN
          RAISE EXCEPTION 'HON_SPECIALIST_CAPABILITY_REQUIRED' USING ERRCODE = '42501';
        END IF;
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
                 THEN jsonb_build_object('committedCredits', committed, 'ceilingCredits', hon.ai_org_display_ceiling(org, at)) END;
  RETURN jsonb_build_object('organizationId', org, 'schoolId', school, 'completeEntitlement', complete,
    'agentBudget', budget,
    'agents', agents, 'asOf', hon.saas_ts(at));
END $$;


COMMIT;
