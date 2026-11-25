BEGIN;

-- 0651 HQ Creative Studio cost basis (coordinator-allocated 2026-11-22; launch-readiness P3 carried by #602 / 0637,
-- docs/architecture/CREATIVE_COST_BASIS.md).
-- 0637 made the school creative wallet record whether a cost is HON's own estimate or the provider's reported cost. HQ's
-- own Creative Studio (0253) records the same adapters' cost in hon.hq_creative_generations.provider_cost_microunits with
-- no basis, so a HON estimate could later be read as the provider's actual cost. No such cost is shown today and no real
-- provider is connected (the runtime is unconfigured in production); this fixes the record before either changes.
--   HB1  hon.record_hq_creative_generation_result accepts an optional providerCostBasis (HON_ESTIMATE | PROVIDER_REPORTED),
--        present exactly when a cost is, and stores it in the new column provider_cost_basis. Inputs without the key are
--        accepted unchanged (basis NULL), so the database can deploy before the API.
--   HB2  provider_cost_basis may be set only with a RECORDED cost; NULL means no basis was stated (a NOT_SENT known zero,
--        an owner resolution, or a row recorded before 0651) and is never read as a provider-reported cost.
--   HB3  hon.guard_hq_creative_record lets the basis move with the cost at completion only, like every other result column.
-- No data change, no new grant, no provider call. The owner resolution path (resolve_hq_creative_generation) is unchanged.

ALTER TABLE hon.hq_creative_generations
  ADD COLUMN provider_cost_basis text CHECK (provider_cost_basis IN ('HON_ESTIMATE','PROVIDER_REPORTED')),
  ADD CONSTRAINT hq_creative_generations_cost_basis_with_cost CHECK (provider_cost_basis IS NULL OR cost_status = 'RECORDED');
COMMENT ON COLUMN hon.hq_creative_generations.provider_cost_basis IS
  'HON_ESTIMATE: HON''s own rate times units; PROVIDER_REPORTED: the provider''s answer stated the cost; NULL: no basis stated (never a provider-reported cost).';

CREATE OR REPLACE FUNCTION hon.guard_hq_creative_record() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE moving text[];
BEGIN
  -- Field references are resolved per table (PL/pgSQL does not short-circuit record fields), hence the nested IFs.
  IF TG_OP <> 'UPDATE' OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'HQ_CREATIVE_RECORD_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'hq_creative_budget_periods' THEN
    IF (to_jsonb(NEW)->>'set_at')::timestamptz >= (to_jsonb(OLD)->>'set_at')::timestamptz
      AND (to_jsonb(NEW) - ARRAY['credit_cap','version','set_by','set_at']) = (to_jsonb(OLD) - ARRAY['credit_cap','version','set_by','set_at']) THEN
      RETURN NEW;
    END IF;
  ELSIF (to_jsonb(OLD)->>'status' = 'GENERATING' AND to_jsonb(NEW)->>'status' IN ('SUCCEEDED','FAILED','UNDER_REVIEW','RESOLVED_CHARGED','RESOLVED_NOT_CHARGED'))
      OR (to_jsonb(OLD)->>'status' = 'UNDER_REVIEW' AND to_jsonb(NEW)->>'status' IN ('RESOLVED_CHARGED','RESOLVED_NOT_CHARGED')) THEN
    moving := ARRAY['status','failure_reason','final_units','charged_credits','cost_status','provider_cost_microunits','provider_cost_basis','resolution_reference',
      'resolved_by','version','completed_at'];
    -- The first completion time and failure reason stay fixed once set.
    IF (to_jsonb(NEW) - moving) = (to_jsonb(OLD) - moving)
      AND (to_jsonb(OLD)->'completed_at' = 'null'::jsonb OR to_jsonb(NEW)->'completed_at' = to_jsonb(OLD)->'completed_at')
      AND (to_jsonb(OLD)->'failure_reason' = 'null'::jsonb OR to_jsonb(NEW)->'failure_reason' = to_jsonb(OLD)->'failure_reason') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'HQ_CREATIVE_RECORD_IMMUTABLE' USING ERRCODE = '42501';
END $$;

CREATE OR REPLACE FUNCTION hon.record_hq_creative_generation_result(p_subject text, p_generation uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE g hon.hq_creative_generations%ROWTYPE; outcome text; reason text; n integer; a jsonb; i integer := 0; at timestamptz;
BEGIN
  IF p_generation IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR ((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['assets','failureReason','finalUnits','outcome','providerCostMicrounits']
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['assets','failureReason','finalUnits','outcome','providerCostBasis','providerCostMicrounits']) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  -- HB1: when given, the basis is present exactly when a cost is (a cost is only ever given for SUCCEEDED or FAILED).
  IF p ? 'providerCostBasis' AND NOT (CASE WHEN jsonb_typeof(p->'providerCostMicrounits') = 'number'
      THEN coalesce(jsonb_typeof(p->'providerCostBasis') = 'string' AND p->>'providerCostBasis' IN ('HON_ESTIMATE','PROVIDER_REPORTED'), false)
      ELSE jsonb_typeof(p->'providerCostBasis') = 'null' END) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  outcome := p->>'outcome'; reason := p->>'failureReason';
  IF NOT coalesce(CASE outcome
      WHEN 'SUCCEEDED' THEN jsonb_typeof(p->'finalUnits') = 'number' AND (p->>'finalUnits') ~ '^[1-9][0-9]{0,3}$'
        AND jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'
        AND jsonb_typeof(p->'assets') = 'array' AND jsonb_array_length(p->'assets') BETWEEN 1 AND 8 AND jsonb_typeof(p->'failureReason') = 'null'
      WHEN 'FAILED' THEN jsonb_typeof(p->'finalUnits') = 'null' AND jsonb_typeof(p->'assets') = 'null' AND reason = 'PROVIDER_REJECTED'
        AND (jsonb_typeof(p->'providerCostMicrounits') = 'null' OR (jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'))
      WHEN 'NOT_SENT' THEN jsonb_typeof(p->'finalUnits') = 'null' AND jsonb_typeof(p->'assets') = 'null' AND jsonb_typeof(p->'providerCostMicrounits') = 'null'
        AND reason IN ('PROVIDER_NOT_CONNECTED','INVALID_REQUEST')
      WHEN 'UNKNOWN' THEN jsonb_typeof(p->'finalUnits') = 'null' AND jsonb_typeof(p->'assets') = 'null' AND jsonb_typeof(p->'providerCostMicrounits') = 'null'
        AND reason IN ('PROVIDER_UNKNOWN','UNVERIFIED_RESULT','INTERRUPTED')
      ELSE false END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO g FROM hon.hq_creative_generations WHERE id = p_generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.saas_creative_evidence_actor(p_subject, g.requested_by);
  PERFORM hon.hq_creative_lock_period(g.period_start);
  SELECT * INTO g FROM hon.hq_creative_generations WHERE id = p_generation FOR UPDATE;
  IF g.status <> 'GENERATING' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp();
  IF reason = 'INTERRUPTED' AND at < g.created_at + interval '120 seconds' THEN
    RAISE EXCEPTION 'CREATIVE_GENERATION_IN_PROGRESS' USING ERRCODE = '40001';
  END IF;
  IF outcome = 'SUCCEEDED' THEN
    n := (p->>'finalUnits')::integer;
    IF n > g.units OR (g.media_kind = 'VIDEO' AND jsonb_array_length(p->'assets') <> 1) THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
    FOR a IN SELECT x FROM jsonb_array_elements(p->'assets') x LOOP
      IF jsonb_typeof(a) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a) k) IS DISTINCT FROM ARRAY['durationSeconds','height','mediaType','providerAssetReference','width']
        OR coalesce(a->>'mediaType', '') NOT IN (CASE g.media_kind WHEN 'IMAGE' THEN 'image/png' ELSE 'video/mp4' END, CASE g.media_kind WHEN 'IMAGE' THEN 'image/webp' ELSE 'video/mp4' END)
        OR coalesce(jsonb_typeof(a->'width'), '') <> 'number' OR (a->>'width') !~ '^[1-9][0-9]{0,3}$' OR (a->>'width')::integer > 8192
        OR coalesce(jsonb_typeof(a->'height'), '') <> 'number' OR (a->>'height') !~ '^[1-9][0-9]{0,3}$' OR (a->>'height')::integer > 8192
        OR (g.media_kind = 'IMAGE' AND jsonb_typeof(a->'durationSeconds') <> 'null')
        OR (g.media_kind = 'VIDEO' AND NOT (jsonb_typeof(a->'durationSeconds') = 'number' AND (a->>'durationSeconds') ~ '^[1-9][0-9]{0,2}$' AND (a->>'durationSeconds')::integer <= 600))
        OR coalesce(jsonb_typeof(a->'providerAssetReference'), '') <> 'string' OR (a->>'providerAssetReference') !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$' THEN
        RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
      END IF;
    END LOOP;
    UPDATE hon.hq_creative_generations SET status = 'SUCCEEDED', final_units = n, charged_credits = n * credits_per_unit, cost_status = 'RECORDED',
      provider_cost_microunits = (p->>'providerCostMicrounits')::bigint, provider_cost_basis = p->>'providerCostBasis', version = version + 1, completed_at = greatest(at, created_at)
    WHERE id = g.id RETURNING * INTO g;
    FOR a IN SELECT x FROM jsonb_array_elements(p->'assets') x LOOP
      i := i + 1;
      INSERT INTO hon.hq_creative_generation_assets (generation_id, ordinal, media_type, width, height, duration_seconds, origin, provider_asset_reference, created_at)
      VALUES (g.id, i, a->>'mediaType', (a->>'width')::integer, (a->>'height')::integer, (a->>'durationSeconds')::integer, 'SYNTHETIC', a->>'providerAssetReference', at);
    END LOOP;
  ELSIF outcome = 'FAILED' THEN
    UPDATE hon.hq_creative_generations SET status = 'FAILED', failure_reason = reason,
      cost_status = CASE WHEN jsonb_typeof(p->'providerCostMicrounits') = 'number' THEN 'RECORDED' ELSE 'UNKNOWN' END,
      provider_cost_microunits = (p->>'providerCostMicrounits')::bigint, provider_cost_basis = p->>'providerCostBasis', version = version + 1,
      completed_at = greatest(at, created_at)
    WHERE id = g.id RETURNING * INTO g;
  ELSIF outcome = 'NOT_SENT' THEN
    -- The request never left the server, so its provider cost is a known zero (not a guess).
    UPDATE hon.hq_creative_generations SET status = 'FAILED', failure_reason = reason, cost_status = 'RECORDED', provider_cost_microunits = 0,
      version = version + 1, completed_at = greatest(at, created_at)
    WHERE id = g.id RETURNING * INTO g;
  ELSE
    UPDATE hon.hq_creative_generations SET status = 'UNDER_REVIEW', failure_reason = reason, version = version + 1, completed_at = greatest(at, created_at)
    WHERE id = g.id RETURNING * INTO g;
  END IF;
  RETURN hon.hq_creative_receipt(g, false);
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['guard_hq_creative_record()','record_hq_creative_generation_result(text,uuid,jsonb)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.record_hq_creative_generation_result(text,uuid,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
