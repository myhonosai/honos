BEGIN;

-- 0338 (HX-1): HQ executive workspace Performance. One read-only aggregate per HQ agent (HON or one of the six HQ
-- executives) for the current UTC month: questions asked, answered, failed, under review (incl. interrupted), in
-- progress, resolved, distinct askers, HQ credits charged and the last question time. Gated like asking that agent: an
-- active HQ person with hq.dashboard.view and the agent's own HQ permission (0264). No question text, answers, names,
-- providers, models or provider cost (the same view rule as 0263). Spec: docs/architecture/HQ_EXECUTIVE_WORKSPACE.md.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.hq_hon_counts(text[],text[])') IS NULL THEN RAISE EXCEPTION 'Apply HQ executives migration 0264 first'; END IF;
END $$;

CREATE FUNCTION hon.read_hq_hon_agent_performance(p_subject text, p_agent text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; at timestamptz := clock_timestamp(); period date; result jsonb;
BEGIN
  actor := hon.require_hq_hon_actor(p_subject, false);
  IF p_agent IS NULL OR p_agent <> ALL (ARRAY['hon','chase','mia','ethan','olivia','ryan','sophia']) THEN
    RAISE EXCEPTION 'INVALID_HQ_HON_AGENT' USING ERRCODE = '22023';
  END IF;
  IF NOT hon.hq_hon_permission_held(actor, hon.hq_hon_agent_permission(p_agent)) THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  period := hon.hq_hon_period(at);
  SELECT jsonb_build_object('agentKey', p_agent, 'periodStart', to_char(period, 'YYYY-MM-DD'),
      'asked', count(*),
      'answered', count(*) FILTER (WHERE t.status = 'ANSWERED'),
      'failed', count(*) FILTER (WHERE t.status = 'FAILED'),
      'underReview', count(*) FILTER (WHERE t.status = 'UNDER_REVIEW' OR (t.status = 'ANSWERING' AND t.created_at <= at - interval '120 seconds')),
      'inProgress', count(*) FILTER (WHERE t.status = 'ANSWERING' AND t.created_at > at - interval '120 seconds'),
      'resolved', count(*) FILTER (WHERE t.status IN ('RESOLVED_CHARGED','RESOLVED_NOT_CHARGED')),
      'askers', count(DISTINCT t.asked_by),
      'chargedCredits', coalesce(sum(t.charged_credits), 0),
      'lastAskedAt', CASE WHEN max(t.created_at) IS NULL THEN NULL ELSE hon.saas_ts(max(t.created_at)) END,
      'asOf', hon.saas_ts(at))
    INTO result
  FROM hon.hq_hon_turns t WHERE t.period_start = period AND t.agent_key = p_agent;
  -- Authority after the read, as the other HQ HON reads do.
  PERFORM hon.require_hq_hon_actor(p_subject, false);
  RETURN result;
END $$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.read_hq_hon_agent_performance(text,text) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_hq_hon_agent_performance(text,text) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_hq_hon_agent_performance(text,text) TO hon_runtime;
  END IF;
END $$;
COMMIT;
