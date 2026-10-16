BEGIN;

-- HQ-1 is an aggregate-only operator projection. It introduces no HQ work,
-- provider invocation, credential access, financial metric, tenant selector,
-- Action Engine command, audit/outbox record, or school authorization bridge.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'HQ platform overview migration requires a trusted migration owner';
  END IF;
END;
$$;

CREATE FUNCTION hon.read_hq_platform_overview(p_external_subject text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_hq_role text;
BEGIN
  -- Resolve the verified subject against the live HQ grant inside the function.
  -- No caller-supplied role, tenant, principal, GUC, target, or time range can
  -- establish this platform-operator scope. Support grants are intentionally
  -- excluded even if a support record contains the dashboard permission.
  SELECT hq_role INTO v_hq_role
  FROM hon.resolve_hq_operator_scope(p_external_subject, 'hq.dashboard.view')
  WHERE hq_role IN ('HON_HQ_OWNER', 'HON_HQ_OPERATOR')
  LIMIT 1;

  IF v_hq_role IS NULL THEN
    RAISE EXCEPTION 'HQ platform overview access denied' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'asOf', to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'callerHqRole', CASE v_hq_role WHEN 'HON_HQ_OWNER' THEN 'OWNER' ELSE 'OPERATOR' END,
    'organizationCount', (SELECT count(*) FROM hon.organizations),
    'schoolCount', (SELECT count(*) FROM hon.schools),
    'onboarding', jsonb_build_object(
      'availability', 'AVAILABLE',
      'requestCount', (SELECT count(*) FROM hon.hq_onboarding_requests),
      'inProgressRequestCount', (SELECT count(*) FROM hon.hq_onboarding_requests WHERE status = 'IN_PROGRESS'),
      'completedRequestCount', (SELECT count(*) FROM hon.hq_onboarding_requests WHERE status = 'COMPLETED')
    ),
    'configuredProviderStates', jsonb_build_object(
      'disabled', (SELECT count(*) FROM hon.hq_ai_provider_connections WHERE state = 'DISABLED'),
      'configured', (SELECT count(*) FROM hon.hq_ai_provider_connections WHERE state = 'CONFIGURED'),
      'healthy', (SELECT count(*) FROM hon.hq_ai_provider_connections WHERE state = 'HEALTHY'),
      'degraded', (SELECT count(*) FROM hon.hq_ai_provider_connections WHERE state = 'DEGRADED'),
      'unavailable', (SELECT count(*) FROM hon.hq_ai_provider_connections WHERE state = 'UNAVAILABLE')
    ),
    'taskProfileCount', (SELECT count(*) FROM hon.hq_ai_task_profiles),
    'financialMetrics', jsonb_build_object(
      'availability', 'UNAVAILABLE',
      'reason', 'No authoritative HQ financial MRR, ARR, cash, or gross-margin projection is available.'
    ),
    'aiUsage', jsonb_build_object(
      'availability', 'UNAVAILABLE',
      'reason', 'No authoritative HQ AI usage or cost projection is available.'
    ),
    'durableHqWork', jsonb_build_object(
      'availability', 'UNAVAILABLE',
      'state', 'NO_RECORDED_WORK',
      'reason', 'No durable HQ executive work is recorded or active in HQ-1.'
    )
  );
END;
$$;

-- All source tables remain private and forced-RLS. The runtime receives only
-- this exact function; PUBLIC and all direct client roles are denied.
REVOKE ALL ON FUNCTION hon.read_hq_platform_overview(text) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_hq_platform_overview(text) FROM %I', role_name);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE ALL ON TABLE hon.organizations, hon.schools, hon.hq_onboarding_requests,
      hon.hq_ai_provider_connections, hon.hq_ai_task_profiles FROM hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_hq_platform_overview(text) TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
