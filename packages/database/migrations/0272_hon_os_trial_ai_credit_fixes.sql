BEGIN;

-- HON OS trial AI credit: the four review follow-ups on 0246 (migration 0272, allocated 2026-11-12). Source only; the
-- trial program stays CLOSED. Nothing activates a provider, spends credits, charges or changes billing.
-- 1. Campaign cost cap counts open holds. The cap compared only provider cost already in the ledger, so a school could
--    keep up to its daily cap in flight past the cap, and an UNKNOWN outcome never counted. Now every open agent hold of
--    every school in the campaign, held since that school's trial started, counts at its plan's maximum provider cost
--    (fail closed) until it is settled or resolved. Schools deciding at the same instant each hold their own budget
--    lock, so each can still finish at most one request (perRequestCreditCap credits) past the cap; that is documented.
-- 2. HQ screens show the trial credit room, not the per-request minimum. ai_org_ceiling stays the decision value (it
--    includes today's daily room and committed + perRequestCreditCap). The HQ per-school usage read and the AI team
--    readiness budget now show hon.ai_org_display_ceiling: the interim 12000 for other organizations, and for a
--    trial-owned school the trial credits still available (0 when unfunded or the campaign cost cap is reached).
--    Per-agent availability in readiness still uses ai_org_ceiling.
-- 3. A lost hold from an earlier month still uses trial credits. S4-d counts an UNKNOWN (or stale SENDING) hold only in
--    its own month, so a trial that crosses a month boundary lost it from both committed and the pre-window ledger.
--    Holds that no longer count in the window but were taken since the trial started now reduce the trial credit room.
-- 4. A start replay re-checks the owner's live grant before returning the stored receipt (TRIAL_FORBIDDEN otherwise),
--    the same authority a first start needs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.start_hon_os_trial(text,jsonb,uuid)') IS NULL THEN RAISE EXCEPTION 'Apply free-trial migration 0246 first'; END IF;
  IF to_regprocedure('hon.read_ai_school_usage_from_hq(text,timestamptz,timestamptz)') IS NULL THEN RAISE EXCEPTION 'Apply HQ usage migration 0267 first'; END IF;
END $$;

-- Every open agent hold of an organization (all four agent callers), with the plan's maximum provider cost.
CREATE FUNCTION hon.ai_org_open_agent_holds(p_org uuid)
RETURNS TABLE(held_at timestamptz, status text, reserved_credits bigint, max_provider_cost_microunits bigint)
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.marketing_ai_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.teaching_ai_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.chad_follow_up_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0
  UNION ALL SELECT i.held_at, i.status, i.reserved_credits::bigint, p.max_provider_cost_microunits::bigint FROM hon.hon_reply_invocations i LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.organization_id=p_org AND i.reserved_credits>0;
$$;

-- Provider cost a campaign has used or may already have used: ledger cost inside each school's trial plus every open hold
-- taken since that school's trial started, at its plan's maximum (a hold without a plan counts as the whole cap: fail closed).
CREATE FUNCTION hon.hon_os_trial_campaign_cost(p_campaign uuid, p_cap bigint) RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT sum(u.provider_cost_microunits) FROM hon.hon_os_trial_enrollments x JOIN hon.ai_usage_ledger u ON u.organization_id=x.organization_id
      WHERE x.campaign_id=p_campaign AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=x.starts_at AND u.occurred_at<x.ends_at),0)
    + coalesce((SELECT sum(coalesce(h.max_provider_cost_microunits,p_cap)) FROM hon.hon_os_trial_enrollments x, hon.ai_org_open_agent_holds(x.organization_id) h
      WHERE x.campaign_id=p_campaign AND (h.held_at IS NULL OR h.held_at>=x.starts_at)),0);
$$;

-- The trial-owned school's ceiling terms. trial_owned is false for every other organization. When the trial is unfunded
-- now, or the campaign cost cap is reached, every room is 0. credit_room: credits left after usage and lost holds from
-- before this window (compared against window committed). daily_room: window usage before today (UTC) + the daily cap.
-- request_room: committed + the per-request cap.
CREATE FUNCTION hon.ai_trial_ceiling_terms(p_org uuid, p_at timestamptz, OUT trial_owned boolean, OUT credit_room bigint, OUT daily_room bigint, OUT request_room bigint)
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT t.id IS NOT NULL,
    CASE WHEN NOT funded THEN 0 ELSE (t.ai_budget->>'creditsPerEnrollment')::bigint
      -(SELECT coalesce(sum(u.customer_credits),0) FROM hon.ai_usage_ledger u
          WHERE u.organization_id=p_org AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=t.starts_at AND u.occurred_at<lower(w.r))
      -(SELECT coalesce(sum(h.reserved_credits),0) FROM hon.ai_org_open_agent_holds(p_org) h
          WHERE h.held_at>=t.starts_at AND NOT hon.ai_hold_counts(h.status,h.held_at,w.r,p_at)) END,
    CASE WHEN NOT funded THEN 0 ELSE (SELECT coalesce(sum(u.customer_credits),0) FROM hon.ai_usage_ledger u WHERE u.organization_id=p_org AND u.spend_class='AGENT_INFERENCE'
        AND u.occurred_at>=lower(w.r) AND u.occurred_at<(date_trunc('day',p_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
      +(t.ai_budget->>'dailyCreditCap')::bigint END,
    CASE WHEN NOT funded THEN 0 ELSE hon.ai_org_committed_credits(p_org,p_at)+(t.ai_budget->>'perRequestCreditCap')::bigint END
  FROM (SELECT hon.ai_spend_window(p_org,p_at) AS r) w
  LEFT JOIN hon.hon_os_trial_enrollments t ON t.organization_id=p_org
    AND EXISTS (SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=p_org AND e.version=t.granted_entitlement_version)
  CROSS JOIN LATERAL (SELECT t.id IS NOT NULL AND hon.ai_trial_funding_available(p_org,p_at,'AGENT_INFERENCE')
    AND hon.hon_os_trial_campaign_cost(t.campaign_id,(t.ai_budget->>'maximumCampaignCostMinor')::bigint*10000)
        <(t.ai_budget->>'maximumCampaignCostMinor')::bigint*10000 AS funded) f;
$$;

-- The organization agent ceiling every prepare compares committed + estimate against (under ai.budget:<org>).
-- Unchanged for every organization a trial does not own (owner-decided interim 12000, OD-23).
CREATE OR REPLACE FUNCTION hon.ai_org_ceiling(p_org uuid, p_at timestamptz) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN NOT c.trial_owned THEN 12000
    ELSE greatest(0,least(12000::bigint,c.credit_room,c.daily_room,c.request_room))::integer END
  FROM hon.ai_trial_ceiling_terms(p_org,p_at) c;
$$;

-- What HQ and readiness show as the organization's budget: the trial credits still available for a trial-owned school.
CREATE FUNCTION hon.ai_org_display_ceiling(p_org uuid, p_at timestamptz) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN NOT c.trial_owned THEN 12000 ELSE greatest(0,least(12000::bigint,c.credit_room))::integer END
  FROM hon.ai_trial_ceiling_terms(p_org,p_at) c;
$$;

-- The registering owner's grant at their own active school is still live now.
CREATE FUNCTION hon.hon_os_trial_owner_live(p_registration uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.hon_os_school_registrations r JOIN hon.principal_role_grants g ON g.id=r.owner_grant_id AND g.principal_id=r.owner_principal_id
      JOIN hon.principals p ON p.id=g.principal_id JOIN hon.schools s ON s.id=r.school_id AND s.status='ACTIVE'
      JOIN hon.organizations o ON o.id=r.organization_id AND o.status='ACTIVE'
    WHERE r.id=p_registration AND p.is_active AND g.revoked_at IS NULL
      AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()));
$$;

-- 0246 body; a replay re-checks the owner's live grant before returning the receipt.
CREATE OR REPLACE FUNCTION hon.start_hon_os_trial(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE prior hon.school_account_requests%ROWTYPE; fp text; at timestamptz; r hon.hon_os_school_registrations%ROWTYPE; offer jsonb;
  ent hon.organization_entitlements%ROWTYPE; t hon.hon_os_trial_enrollments%ROWTYPE; prior_ent jsonb; v_until timestamptz; result jsonb;
BEGIN
  IF p_key IS NULL OR p_subject IS NULL OR length(p_subject)>2048 OR p_subject NOT LIKE 'oidc:%'
    OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['campaignId','confirmation','schoolId']
    OR jsonb_typeof(p_input->'confirmation') IS DISTINCT FROM 'string' OR p_input->>'confirmation'<>'START_HON_OS_FREE_TRIAL'
    OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string' OR p_input->>'schoolId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'campaignId') IS DISTINCT FROM 'string' OR p_input->>'campaignId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'TRIAL_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT hon.hon_os_trial_open() THEN RAISE EXCEPTION 'TRIAL_CLOSED' USING ERRCODE='55000'; END IF;
  -- Owner authority cannot change while we decide (same envelope as every account writer).
  PERFORM hon.lock_school_account_authority();
  fp:=encode(sha256(convert_to('TRIAL:START:'||p_input::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.school_account_requests WHERE subject=p_subject AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'TRIAL_KEY_REUSED' USING ERRCODE='23505'; END IF;
    SELECT * INTO t FROM hon.hon_os_trial_enrollments WHERE subject=p_subject AND idempotency_key=p_key;
    IF NOT FOUND THEN RAISE EXCEPTION 'TRIAL_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    -- 0272: a replay is a read of the owner's own receipt, so it needs the same live owner grant as a first start.
    IF NOT hon.hon_os_trial_owner_live(t.registration_id) THEN RAISE EXCEPTION 'TRIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN hon.hon_os_trial_json(t);
  END IF;
  -- Only the registering owner, through their own live owner grant, at their own school.
  SELECT * INTO r FROM hon.hon_os_school_registrations WHERE subject=p_subject AND school_id=(p_input->>'schoolId')::uuid;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.principals p ON p.id=g.principal_id
      JOIN hon.schools s ON s.id=r.school_id AND s.status='ACTIVE' JOIN hon.organizations o ON o.id=r.organization_id AND o.status='ACTIVE'
      WHERE g.id=r.owner_grant_id AND g.principal_id=r.owner_principal_id AND p.is_active AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'TRIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- Capacity is counted under one lock per campaign, then the organization (inventory-before-organization order).
  PERFORM pg_advisory_xact_lock(hashtextextended('hon_os.trial_campaign:'||(p_input->>'campaignId'),0));
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||r.organization_id::text,0));
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id=r.organization_id FOR UPDATE;
  at:=clock_timestamp();
  IF NOT hon.hon_os_trial_open() THEN RAISE EXCEPTION 'TRIAL_CLOSED' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM hon.hon_os_trial_enrollments WHERE organization_id=r.organization_id) THEN
    RAISE EXCEPTION 'TRIAL_ALREADY_USED' USING ERRCODE='23505'; END IF;
  offer:=hon.hon_os_trial_campaign_offer((p_input->>'campaignId')::uuid,at);
  IF offer IS NULL THEN RAISE EXCEPTION 'TRIAL_CAMPAIGN_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM hon.hon_os_trial_enrollments WHERE campaign_id=(p_input->>'campaignId')::uuid)>=(offer->>'maximumEnrollments')::integer THEN
    RAISE EXCEPTION 'TRIAL_CAMPAIGN_FULL' USING ERRCODE='23514'; END IF;
  -- A trial only starts from no access at all: entitlement still held SUSPENDED, no access state, subscription, checkout or
  -- exception. Existing, paid, awaiting or HQ-exception schools are never touched.
  IF ent.organization_id IS NULL OR ent.status<>'SUSPENDED'
    OR EXISTS (SELECT 1 FROM hon.saas_access_states WHERE organization_id=r.organization_id)
    OR EXISTS (SELECT 1 FROM hon.saas_subscriptions WHERE organization_id=r.organization_id AND status<>'VOIDED')
    OR EXISTS (SELECT 1 FROM hon.saas_checkout_sessions WHERE organization_id=r.organization_id)
    OR EXISTS (SELECT 1 FROM hon.saas_access_exceptions WHERE organization_id=r.organization_id) THEN
    RAISE EXCEPTION 'TRIAL_NOT_ELIGIBLE' USING ERRCODE='23514'; END IF;
  prior_ent:=hon.saas_entitlement_json(r.organization_id);
  v_until:=at+make_interval(days=>(offer->>'durationDays')::integer);
  UPDATE hon.organization_entitlements SET tier=(offer->>'capabilityProfile')::hon.plan_tier,status='ACTIVE',effective_from=at,
      effective_until=v_until,version=version+1,updated_at=at
    WHERE organization_id=r.organization_id AND version=ent.version;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.school_account_requests VALUES (p_subject,p_key,fp,'{}'::jsonb);
  INSERT INTO hon.hon_os_trial_enrollments(organization_id,school_id,registration_id,campaign_id,campaign_version_id,publication_id,
      policy_decision_id,capability_profile,duration_days,terms_reference,starts_at,ends_at,prior_entitlement,granted_entitlement_version,
      enrolled_by_principal_id,subject,idempotency_key,program_status,ai_budget)
    VALUES (r.organization_id,r.school_id,r.id,(offer->>'campaignId')::uuid,(offer->>'campaignVersionId')::uuid,(offer->>'publicationId')::uuid,
      (offer->>'policyDecisionId')::uuid,offer->>'capabilityProfile',(offer->>'durationDays')::integer,offer->>'termsReference',at,v_until,
      prior_ent,ent.version+1,r.owner_principal_id,p_subject,p_key,'TEST_MODE',offer->'promotionalBudget') RETURNING * INTO t;
  result:=hon.hon_os_trial_json(t);
  -- Decision point after every write: program, campaign approval and owner grant must all still hold.
  IF NOT hon.hon_os_trial_open() THEN RAISE EXCEPTION 'TRIAL_CLOSED' USING ERRCODE='55000'; END IF;
  IF hon.hon_os_trial_campaign_offer(t.campaign_id,clock_timestamp()) IS NULL THEN RAISE EXCEPTION 'TRIAL_CAMPAIGN_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g WHERE g.id=r.owner_grant_id AND g.revoked_at IS NULL
      AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'TRIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;


-- 0229 body; the organization budget shows the display ceiling (per-agent availability keeps ai_org_ceiling).
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
                                 ('claire', 'BUSINESS_PERFORMANCE', 15000, 80000, 15)) v(agent_key, agent, units, max_cost, estimate) LOOP
    BEGIN
      IF a.agent_key = 'marcus' THEN PERFORM hon.marketing_owner(p_subject);
      ELSIF a.agent_key = 'kai' THEN PERFORM hon.require_teaching_assistant_actor(p_subject, false);
      ELSIF a.agent_key = 'chad' THEN PERFORM hon.require_chad_follow_up_actor(p_subject);
      ELSIF a.agent_key = 'claire' THEN
        -- K2: Claire needs the conversation, AI planning and her own capability (reporting.view).
        PERFORM hon.hon_conversation_actor(p_subject); PERFORM hon.require_ai_invocation_plan_access();
        IF NOT hon.principal_has_school_permission(actor, org, school, 'reporting.view') THEN RAISE EXCEPTION 'CLAIRE_REPORTING_REQUIRED' USING ERRCODE = '42501'; END IF;
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


-- 0267 body; the organization ceiling shown to HQ is the display ceiling.
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
           -- 0267: Claire's analysis turns share HON's reply table (0229); they count under her own agent.
           WHEN EXISTS (SELECT 1 FROM hon.hon_reply_invocations i WHERE i.id = u.source_invocation_id AND i.specialist = 'claire') THEN 'BUSINESS_PERFORMANCE'
           WHEN EXISTS (SELECT 1 FROM hon.hon_reply_invocations i WHERE i.id = u.source_invocation_id) THEN 'HON_REPLY'
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
      CASE WHEN l.agent = 'HON_REPLY' AND EXISTS (SELECT 1 FROM hon.hon_reply_invocations i WHERE i.id = l.invocation_id AND i.specialist = 'claire')
           THEN 'BUSINESS_PERFORMANCE' ELSE l.agent END, false, false, true
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
        UNION ALL SELECT organization_id, school_id, status, held_at, reserved_credits FROM hon.hon_reply_invocations) h
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
            UNION ALL SELECT status, held_at, reserved_credits FROM hon.hon_reply_invocations WHERE organization_id = o.organization_id) h
          WHERE h.reserved_credits > 0 AND (h.status = 'UNKNOWN' OR (h.status = 'SENDING' AND h.held_at <= at - hon.ai_sending_stale_after()))),
        'aiPaused', EXISTS (SELECT 1 FROM hon.ai_spend_pauses p WHERE p.ended_at IS NULL AND (p.organization_id = o.organization_id OR p.organization_id IS NULL)))
        ORDER BY o.organization_id)
      FROM orgs o CROSS JOIN LATERAL (SELECT hon.ai_spend_window(o.organization_id, at) AS r) w), '[]'::jsonb),
    'providerCostUnit', 'MICROUNITS_USD')
  INTO result;
  RETURN result;
END $$;


DO $$ DECLARE f text; r text; BEGIN
  FOREACH f IN ARRAY ARRAY['ai_org_open_agent_holds(uuid)','hon_os_trial_campaign_cost(uuid,bigint)',
    'ai_trial_ceiling_terms(uuid,timestamptz)','ai_org_display_ceiling(uuid,timestamptz)','hon_os_trial_owner_live(uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
END $$;
COMMIT;
