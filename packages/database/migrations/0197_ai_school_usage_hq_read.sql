BEGIN;

-- S4-e HQ per-school AI usage and actual provider cost (owner direction 2026-11-02 07:56Z: "Each school has
-- independent, auditable AI usage and actual provider-cost tracking"; owner HQ authority policy 2026-10-31: HQ sees
-- per-school usage and cost). Read only: no spend path, no policy value, no program change, no provider call.
-- Proposed migration number 0197 (next after the S4 stack 0193-0196); the owner allocates the final number.
--
-- Source of truth is the existing append-only hon.ai_usage_ledger (one row per charged provider result, written by the
-- S4-a evidence path or the S4-d HQ resolution). Each school's rows are reported separately, split by spend class
-- (agent inference never mixes with creative media, AI-17) and, for agent rows, by the agent whose invocation wrote
-- the row (S4-a source_invocation_id; rows written before S4-a are reported as UNATTRIBUTED, never guessed).
-- Credits are only summed inside one spend class (legacy agent credits and creative credits are different units);
-- provider cost (micro-USD) is summed per school across classes.
-- Organization rows add the live budget picture HQ needs to act: the current window, committed credits against the
-- interim legacy ceiling (OD-23: not the creative-credit wallet), open UNKNOWN holds and any active HQ AI pause.
--
-- Cost basis is explicit (Manus review P2, 2026-11-03): a ledger row written by an HQ WRITE_OFF resolution (0196)
-- carries the owner's ESTIMATE, not a provider charge, so it is never added to the provider-reported total.
--   providerReportedCostMicrounits  rows whose cost came from the provider's own result (the S4-a evidence path) or
--                                   from provider evidence an HQ owner recorded (RECORD_PROVIDER_COST);
--   estimatedWriteOffCostMicrounits rows written by WRITE_OFF (counted separately in writeOffEntries);
--   unreconciledInvocations         calls whose outcome is still unknown (UNKNOWN, or SENDING past the stale limit,
--                                   with a hold): they have no ledger row and no known cost, so no amount is shown.
-- The ledger and the resolution records are unchanged; this read only labels them.

CREATE FUNCTION hon.read_ai_school_usage_from_hq(p_subject text, p_from timestamptz, p_to timestamptz) RETURNS jsonb
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
           ELSE 'UNATTRIBUTED' END AS agent,
      EXISTS (SELECT 1 FROM hon.ai_unknown_resolutions r WHERE r.ledger_entry_id = u.id AND r.decision = 'WRITE_OFF') AS write_off
    FROM hon.ai_usage_ledger u
    WHERE u.occurred_at >= p_from AND u.occurred_at < p_to
  ), totals AS (
    SELECT organization_id, school_id, spend_class, agent, sum(customer_credits)::bigint credits,
      coalesce(sum(provider_cost_microunits) FILTER (WHERE NOT write_off), 0)::bigint cost,
      coalesce(sum(provider_cost_microunits) FILTER (WHERE write_off), 0)::bigint estimate,
      count(*)::bigint entries, count(*) FILTER (WHERE write_off)::bigint write_offs
    FROM rows GROUP BY organization_id, school_id, spend_class, agent
  ), schools AS (
    SELECT t.organization_id, t.school_id,
      jsonb_build_object('organizationId', t.organization_id, 'schoolId', t.school_id,
        'providerReportedCostMicrounits', sum(t.cost), 'estimatedWriteOffCostMicrounits', sum(t.estimate),
        'entries', sum(t.entries), 'writeOffEntries', sum(t.write_offs),
        'unreconciledInvocations', (SELECT count(*) FROM (
            SELECT status, updated_at, reserved_credits FROM hon.marketing_ai_invocations WHERE organization_id = t.organization_id AND school_id = t.school_id
            UNION ALL SELECT status, updated_at, reserved_credits FROM hon.teaching_ai_invocations WHERE organization_id = t.organization_id AND school_id = t.school_id
            UNION ALL SELECT status, updated_at, reserved_credits FROM hon.chad_follow_up_invocations WHERE organization_id = t.organization_id AND school_id = t.school_id) h
          WHERE h.reserved_credits > 0 AND (h.status = 'UNKNOWN' OR (h.status = 'SENDING' AND h.updated_at <= at - hon.ai_sending_stale_after()))),
        'byClass', jsonb_object_agg(t.k, t.v)) AS j,
      sum(t.cost) AS cost, sum(t.estimate) AS estimate
    FROM (
      SELECT organization_id, school_id, spend_class AS k, sum(credits) credits, sum(cost) cost, sum(estimate) estimate,
        sum(entries) entries, sum(write_offs) write_offs,
        jsonb_build_object('credits', sum(credits), 'providerReportedCostMicrounits', sum(cost), 'estimatedWriteOffCostMicrounits', sum(estimate),
          'entries', sum(entries), 'writeOffEntries', sum(write_offs),
          -- Aggregates are computed for every class group regardless of the CASE, so the per-agent aggregate skips rows
        -- without an agent (CREATIVE_MEDIA, HQ_INTERNAL); otherwise a NULL key fails the whole read.
        'byAgent', CASE WHEN spend_class = 'AGENT_INFERENCE'
            THEN jsonb_object_agg(agent, jsonb_build_object('credits', credits, 'providerReportedCostMicrounits', cost,
                'estimatedWriteOffCostMicrounits', estimate, 'entries', entries, 'writeOffEntries', write_offs))
              FILTER (WHERE agent IS NOT NULL)
            ELSE NULL END) AS v
      FROM totals GROUP BY organization_id, school_id, spend_class
    ) t
    GROUP BY t.organization_id, t.school_id
  ), limited AS (
    SELECT * FROM schools ORDER BY cost DESC, estimate DESC, organization_id, school_id LIMIT 500
  ), orgs AS (
    SELECT DISTINCT organization_id FROM limited
  )
  SELECT jsonb_build_object(
    'from', hon.saas_ts(p_from), 'to', hon.saas_ts(p_to), 'asOf', hon.saas_ts(at),
    'truncated', (SELECT count(*) FROM schools) > 500,
    'schools', coalesce((SELECT jsonb_agg(l.j ORDER BY l.cost DESC, l.estimate DESC, l.organization_id, l.school_id) FROM limited l), '[]'::jsonb),
    'organizations', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'organizationId', o.organization_id,
        'agentWindowStart', hon.saas_ts(lower(w.r)), 'agentWindowEnd', hon.saas_ts(upper(w.r)),
        'agentCommittedCredits', hon.ai_org_committed_credits(o.organization_id, at),
        'agentCeilingCredits', hon.ai_org_ceiling(o.organization_id, at),
        'openUnknownHolds', (SELECT count(*) FROM (
            SELECT status, updated_at, reserved_credits FROM hon.marketing_ai_invocations WHERE organization_id = o.organization_id
            UNION ALL SELECT status, updated_at, reserved_credits FROM hon.teaching_ai_invocations WHERE organization_id = o.organization_id
            UNION ALL SELECT status, updated_at, reserved_credits FROM hon.chad_follow_up_invocations WHERE organization_id = o.organization_id) h
          WHERE h.reserved_credits > 0 AND (h.status = 'UNKNOWN' OR (h.status = 'SENDING' AND h.updated_at <= at - hon.ai_sending_stale_after()))),
        'aiPaused', EXISTS (SELECT 1 FROM hon.ai_spend_pauses p WHERE p.ended_at IS NULL AND (p.organization_id = o.organization_id OR p.organization_id IS NULL)))
        ORDER BY o.organization_id)
      FROM orgs o CROSS JOIN LATERAL (SELECT hon.ai_spend_window(o.organization_id, at) AS r) w), '[]'::jsonb),
    'providerCostUnit', 'MICROUNITS_USD')
  INTO result;
  RETURN result;
END $$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.read_ai_school_usage_from_hq(text,timestamptz,timestamptz) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_ai_school_usage_from_hq(text,timestamptz,timestamptz) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_ai_school_usage_from_hq(text,timestamptz,timestamptz) TO hon_runtime;
  END IF;
END $$;

COMMIT;
