BEGIN;

-- HQ usage attribution for every analysis specialist (migration 0328, allocated 2026-11-13). Built on the latest body (0272).
-- Alex (0260), Jordan (0260), Lena (0260) and Maya (0284) answer through HON's reply table, like Claire (0229), so the HQ
-- per-school usage read counted their calls under HON_REPLY. 0267 moved only Claire. Each now counts under its own agent,
-- with the names AI team readiness already uses: alex GENERAL_MANAGEMENT, jordan OPERATIONS, lena CREATIVE_COMMERCE,
-- maya RETENTION (claire stays BUSINESS_PERFORMANCE, hon stays HON_REPLY). Late provider expenses recorded as HON_REPLY
-- move the same way. Classes, totals, write-offs and unresolved counts are unchanged; only the per-agent split moves.
-- S4 enumerations (UNKNOWN resolution, late expense agent) keep HON_REPLY for these rows. Read only; ACLs unchanged.
-- Spec: docs/architecture/AI_USAGE_SPECIALIST_ATTRIBUTION.md.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.ai_org_display_ceiling(uuid,timestamptz)') IS NULL THEN RAISE EXCEPTION 'Apply migration 0272 first'; END IF;
END $$;

-- Code-owned: the HQ usage agent of a reply row's specialist. An unknown specialist stays HON_REPLY (never dropped).
CREATE FUNCTION hon.ai_usage_reply_agent(p_specialist text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE p_specialist
    WHEN 'claire' THEN 'BUSINESS_PERFORMANCE' WHEN 'alex' THEN 'GENERAL_MANAGEMENT' WHEN 'jordan' THEN 'OPERATIONS'
    WHEN 'lena' THEN 'CREATIVE_COMMERCE' WHEN 'maya' THEN 'RETENTION' ELSE 'HON_REPLY' END $$;
DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.ai_usage_reply_agent(text) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.ai_usage_reply_agent(text) FROM %I', r);
  END LOOP;
END $$;

-- 0272 body; reply rows are attributed by specialist.
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
COMMIT;
