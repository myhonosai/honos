BEGIN;

-- AI-R1 AI team readiness (owner direction 2026-11-02 07:56Z: prepare the real HON OS AI team for owner testing without
-- paid provider calls). One read tells the requesting human, for each live agent (Marcus marketing drafts, Claire
-- teaching drafts, Chad lead follow-up drafts), whether a request would be allowed right now and, if not, which gate
-- refuses: authorization, the S4-c AI spend decision, the HQ route, or the S4-b organization budget. Proposed migration
-- number 0198 (after the S4 stack and S4-e); the owner allocates the final number.
--
-- No competing authority: authorization is decided by calling each agent's own existing actor gate
-- (hon.marketing_owner, hon.require_teaching_assistant_actor, hon.require_chad_follow_up_actor) inside a
-- subtransaction; a refusal is caught and reported, never raised. The spend decision is hon.ai_spend_allowed (S4-c) and
-- the budget is hon.ai_org_committed_credits / hon.ai_org_ceiling (S4-b/S4-d). The route mirrors the planner's own
-- eligibility rule (exactly one active TEXT policy for the school and a HEALTHY, active, TOKEN-priced candidate within the
-- agent's fixed cost cap). Nothing is written: no plan, invocation, hold, ledger row, audit or provider call. The actor
-- gates take the same short row locks a real request takes; they are released at the end of the caller's transaction.
-- Whether the server runtime is configured for paid calls (key + explicit paid-call approval) is not database state; the
-- API adds it without calling the provider.
--
-- Organization budget disclosure (Manus final review P2, 2026-11-03): readiness is school-scoped, but the S4-b budget
-- totals (committed and ceiling credits) cover every school of the organization. They are returned only when the
-- requester independently holds organization-wide authority (hon.ai_team_org_budget_authority): a human HON HQ reader
-- (the same grants as hon.require_saas_hq_actor(subject, false)), or the existing AI usage economics permission
-- ai.usage.read at EVERY school of the organization. A school-only staff member or the owner of one school in a
-- multi-school organization gets agentBudget null. A school that is not ACTIVE fails the per-school check, so the
-- totals stay hidden (fail closed) until HQ reads them. (Manus delta review P2) School-derived authority also needs
-- the organization's live entitlement (central rule, 0130) and, where the paid-access program has an access state, a
-- state with access; the decision share-locks the rows it rests on so a concurrent suspension or revocation is seen. The per-agent blocker ORGANIZATION_AI_BUDGET_REACHED is still
-- reported, because it is the same refusal a real request would return.

CREATE FUNCTION hon.ai_team_route(p_org uuid, p_school uuid, p_units bigint, p_max bigint) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT CASE
    WHEN (SELECT count(*) FROM hon.hq_ai_routing_policies WHERE organization_id = p_org AND school_id = p_school AND capability = 'TEXT' AND active
          AND effective_from <= now() AND (effective_until IS NULL OR now() < effective_until)) <> 1 THEN 'NO_ELIGIBLE_ROUTE'
    WHEN EXISTS (SELECT 1 FROM hon.hq_ai_routing_policies rp
        JOIN hon.hq_ai_routing_candidates r ON r.policy_id = rp.policy_id
        JOIN hon.hq_ai_model_catalog c ON c.catalog_id = r.catalog_id
        JOIN hon.hq_ai_provider_connections p ON p.provider_id = c.provider_id
        WHERE rp.organization_id = p_org AND rp.school_id = p_school AND rp.capability = 'TEXT' AND rp.active
          AND rp.effective_from <= now() AND (rp.effective_until IS NULL OR now() < rp.effective_until)
          AND c.active AND c.cost_unit = 'TOKEN' AND 'TEXT' = ANY(c.capabilities) AND 'TEXT' = ANY(c.modalities)
          AND c.effective_from <= now() AND (c.effective_until IS NULL OR now() < c.effective_until)
          AND p.state = 'HEALTHY' AND c.provider_id = 'OPENROUTER'
          AND c.unit_cost_micros::numeric * p_units <= LEAST(rp.max_cost_micros, p_max)) THEN NULL
    ELSE 'NO_ELIGIBLE_ROUTE' END;
$$;

CREATE FUNCTION hon.ai_team_org_budget_authority(p_actor uuid, p_org uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF p_actor IS NULL OR p_org IS NULL THEN RETURN false; END IF;
  -- (Manus delta review P2) Live revalidation: share-lock the rows this decision rests on, so a concurrent suspension,
  -- expiry, revocation or permission removal that is not yet committed is waited for and then seen (each statement
  -- below takes a fresh snapshot); a committed one is seen directly. Nothing is written.
  PERFORM 1 FROM hon.organization_entitlements WHERE organization_id = p_org FOR SHARE;
  PERFORM 1 FROM hon.saas_access_states WHERE organization_id = p_org FOR SHARE;
  PERFORM 1 FROM hon.principals WHERE id = p_actor FOR SHARE;
  PERFORM 1 FROM hon.hq_operator_grants WHERE principal_id = p_actor FOR SHARE;
  PERFORM 1 FROM hon.principal_role_grants WHERE principal_id = p_actor FOR SHARE;
  PERFORM 1 FROM hon.role_permissions WHERE role_id IN (SELECT role_id FROM hon.principal_role_grants WHERE principal_id = p_actor) FOR SHARE;
  -- A human HON HQ reader: unchanged (the HQ reader grants of hon.require_saas_hq_actor(subject, false)).
  IF EXISTS (SELECT 1 FROM hon.principals p
      WHERE p.id = p_actor AND p.is_active AND p.principal_type = 'HUMAN_USER'
        AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = p.user_id AND other.is_active) = 1
        AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p.id
          AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
          AND (g.hq_role = 'HON_HQ_OWNER' OR (g.hq_role = 'HON_HQ_OPERATOR' AND 'hq.billing.manage' = ANY(g.permission_codes))))
        AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
          AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()))) THEN
    RETURN true;
  END IF;
  -- School-derived authority additionally needs the organization's access to be live (fail closed):
  --  * the entitlement in effect by the central rule of hon.read_current_organization_entitlement() (0130): status
  --    ACTIVE inside its effective window. A suspended, expired or missing entitlement hides the totals;
  --  * when the paid-access program has an access state for the organization, a state with access: paid, scheduled
  --    cancellation, an active trial, or the authorized grace period (owner policy 2026-11-02: normal access in grace).
  --    Any other or unknown state (awaiting first payment, suspended, review hold, ended) hides the totals.
  IF NOT EXISTS (SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id = p_org AND e.status = 'ACTIVE'
        AND e.effective_from <= clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until > clock_timestamp()))
     OR EXISTS (SELECT 1 FROM hon.saas_access_states s WHERE s.organization_id = p_org
        AND s.state NOT IN ('PAYMENT_ACTIVE','CANCELLATION_SCHEDULED','TRIAL_ACTIVE','PAST_DUE_GRACE')) THEN
    RETURN false;
  END IF;
  -- And the existing AI usage economics permission at EVERY school of the organization (unchanged).
  RETURN EXISTS (SELECT 1 FROM hon.schools s WHERE s.organization_id = p_org)
     AND NOT EXISTS (SELECT 1 FROM hon.schools s WHERE s.organization_id = p_org
       AND NOT hon.principal_has_school_permission(p_actor, p_org, s.id, 'ai.usage.read'));
END $$;

CREATE FUNCTION hon.read_ai_team_readiness(p_subject text) RETURNS jsonb
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
                                 ('chad', 'CHAD_FOLLOW_UP', 2648, 60000, 3)) v(agent_key, agent, units, max_cost, estimate) LOOP
    BEGIN
      IF a.agent_key = 'marcus' THEN PERFORM hon.marketing_owner(p_subject);
      ELSIF a.agent_key = 'claire' THEN PERFORM hon.require_teaching_assistant_actor(p_subject, false);
      ELSE PERFORM hon.require_chad_follow_up_actor(p_subject); END IF;
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

DO $$ DECLARE f regprocedure; r text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.ai_team_route(uuid,uuid,bigint,bigint)'::regprocedure, 'hon.ai_team_org_budget_authority(uuid,uuid)'::regprocedure, 'hon.read_ai_team_readiness(text)'::regprocedure] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_ai_team_readiness(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
