BEGIN;

-- 0637 Creative cost basis (coordinator-allocated 2026-11-22; launch-readiness review P2 [22],
-- docs/architecture/CREATIVE_COST_BASIS.md).
-- The Higgsfield and HeyGen adapters (and the synthetic runtimes) compute a cost from HON's own per-unit rate, but the
-- wallet recorded it as if it were the provider's actual cost. Real downloads are refused today (media storage is
-- unavailable), so no deployed expense was fabricated; this fixes the semantics before those paths are extended.
--   CB1  hon.settle_saas_creative_credits accepts an optional providerCostBasis (HON_ESTIMATE | PROVIDER_REPORTED),
--        present exactly when a cost is, and records it in the reservation's existing cost_reference as
--        hon:cost-basis:estimate / hon:cost-basis:provider-reported. Inputs without it are accepted unchanged.
--   CB2  hon.creative_record_generation_result accepts the same optional key and passes it to the settle.
--   CB3  hon.saas_creative_expense_json adds estimatedProviderCostMicrounits: the recorded cost that is HON's estimate
--        (basis estimate, or recorded before 0637 with no reference). Rows with an HQ evidence reference or a
--        provider-reported basis are not estimates.
-- Credits, caps, holds and the usage ledger are unchanged (an upper-bound estimate stays the conservative spend figure).
-- No table, grant or data change. Nothing here sends, charges or calls an outside service.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.settle_saas_creative_credits(text,uuid,jsonb,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.creative_record_generation_result(text,uuid,jsonb,text)') IS NULL
    OR to_regprocedure('hon.saas_creative_expense_json(uuid)') IS NULL THEN
    RAISE EXCEPTION '0637 requires 0202 and 0354'; END IF;
END $$;

CREATE FUNCTION hon.creative_cost_basis_reference(p_basis text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE p_basis WHEN 'HON_ESTIMATE' THEN 'hon:cost-basis:estimate' WHEN 'PROVIDER_REPORTED' THEN 'hon:cost-basis:provider-reported' END
$$;
REVOKE ALL ON FUNCTION hon.creative_cost_basis_reference(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION hon.settle_saas_creative_credits(p_subject text, p_reservation uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; r hon.saas_creative_reservations%ROWTYPE; updated hon.saas_creative_reservations%ROWTYPE; outcome text; keys text[];
  v_units integer; v_credits integer; cost bigint; uid uuid; at timestamptz; snapshot jsonb; basis text;
BEGIN
  IF p_reservation IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k); outcome := p->>'outcome';
  -- 0637 CB1: an optional providerCostBasis says where a recorded cost came from. It is present exactly when a cost is,
  -- and is HON_ESTIMATE (HON's own rate times units) or PROVIDER_REPORTED (the provider's answer said so).
  IF keys = ARRAY['expectedVersion','finalUnits','outcome','providerCostBasis','providerCostMicrounits'] THEN
    basis := p->>'providerCostBasis';
    IF NOT coalesce(CASE jsonb_typeof(p->'providerCostMicrounits') WHEN 'number' THEN basis IN ('HON_ESTIMATE','PROVIDER_REPORTED')
        ELSE jsonb_typeof(p->'providerCostBasis') = 'null' END, false) THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
    END IF;
    keys := ARRAY['expectedVersion','finalUnits','outcome','providerCostMicrounits'];
  END IF;
  IF NOT coalesce(keys = ARRAY['expectedVersion','finalUnits','outcome','providerCostMicrounits']
      AND jsonb_typeof(p->'expectedVersion') = 'number' AND (p->>'expectedVersion') ~ '^[1-9][0-9]{0,8}$'
      AND outcome IN ('SUCCEEDED','FAILED','UNKNOWN')
      AND (jsonb_typeof(p->'finalUnits') = 'null' OR (jsonb_typeof(p->'finalUnits') = 'number' AND (p->>'finalUnits') ~ '^[0-9]{1,4}$'))
      AND (jsonb_typeof(p->'providerCostMicrounits') = 'null' OR (jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'))
      AND CASE outcome WHEN 'SUCCEEDED' THEN jsonb_typeof(p->'finalUnits') = 'number' AND jsonb_typeof(p->'providerCostMicrounits') = 'number'
        WHEN 'FAILED' THEN jsonb_typeof(p->'finalUnits') = 'null'
        ELSE jsonb_typeof(p->'finalUnits') = 'null' AND jsonb_typeof(p->'providerCostMicrounits') = 'null' END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM hon.saas_creative_reservations WHERE id = p_reservation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  actor := hon.saas_creative_evidence_actor(p_subject, r.requested_by_principal_id);
  replay := hon.saas_claim_request(actor, p_key, 'saas.creative.settle',
    hon.saas_fingerprint(ARRAY['saas.creative.settle', p_reservation::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();
  PERFORM hon.saas_creative_lock_wallet(r.school_id, at);
  SELECT * INTO r FROM hon.saas_creative_reservations WHERE id = p_reservation FOR UPDATE;
  IF r.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF r.status <> 'RESERVED' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  cost := (p->>'providerCostMicrounits')::bigint;
  IF outcome = 'SUCCEEDED' THEN
    v_units := (p->>'finalUnits')::integer; v_credits := v_units * r.credits_per_unit;
    IF v_units > r.units THEN RAISE EXCEPTION 'SAAS_FINAL_EXCEEDS_RESERVATION' USING ERRCODE = '23514'; END IF;
    uid := hon.saas_creative_record_usage(r, actor, cost, v_units);
    PERFORM hon.saas_creative_settle_lots(r, v_credits, actor, at);
    UPDATE hon.saas_creative_reservations SET status = 'FINALIZED', status_reason = 'PROVIDER_SUCCEEDED', version = version + 1, final_units = v_units,
        final_credits = v_credits, cost_status = 'RECORDED', provider_cost_microunits = cost, cost_reference = hon.creative_cost_basis_reference(basis),
        cost_recorded_at = at, usage_id = uid,
        settled_at = at, settled_by_principal_id = actor
      WHERE id = r.id RETURNING * INTO updated;
  ELSIF outcome = 'FAILED' THEN
    IF coalesce(cost, 0) > 0 THEN uid := hon.saas_creative_record_usage(r, actor, cost, 0); END IF;
    PERFORM hon.saas_creative_settle_lots(r, 0, actor, at);
    UPDATE hon.saas_creative_reservations SET status = 'RELEASED', status_reason = 'PROVIDER_FAILED', version = version + 1,
        cost_status = CASE WHEN cost IS NULL THEN 'UNKNOWN' ELSE 'RECORDED' END, provider_cost_microunits = cost,
        cost_reference = CASE WHEN cost IS NOT NULL THEN hon.creative_cost_basis_reference(basis) END,
        cost_recorded_at = CASE WHEN cost IS NOT NULL THEN at END, usage_id = uid, settled_at = at, settled_by_principal_id = actor
      WHERE id = r.id RETURNING * INTO updated;
  ELSE
    UPDATE hon.saas_creative_reservations SET status = 'OUTCOME_UNKNOWN', status_reason = 'PROVIDER_OUTCOME_UNKNOWN', version = version + 1
      WHERE id = r.id RETURNING * INTO updated;
  END IF;
  PERFORM hon.saas_creative_touch_wallet(r.school_id, at);
  snapshot := hon.saas_creative_reservation_json(updated, false);
  RETURN hon.saas_record(actor, p_key, 'saas.creative.settle', 'saas.creative.settled', 'CREATIVE_RESERVATION', r.id, r.organization_id,
    hon.saas_creative_reservation_json(r, false), snapshot, jsonb_build_object('reservation', snapshot, 'balance', hon.saas_creative_balance_json(r.school_id, at)), at);
END $$;

CREATE OR REPLACE FUNCTION hon.creative_record_generation_result(p_subject text, p_generation uuid, p jsonb, p_job_status text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE g hon.creative_generations%ROWTYPE; outcome text; reason text; v integer; body jsonb; receipt jsonb; a jsonb; i integer := 0; n integer;
  at timestamptz; next_phase text; updated hon.creative_generations%ROWTYPE; job hon.creative_provider_jobs%ROWTYPE; basis jsonb;
BEGIN
  IF p_job_status IS NOT NULL AND p_job_status NOT IN ('RECORDED','TIMED_OUT') THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF p_generation IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR ((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['assets','failureReason','finalUnits','outcome','providerCostMicrounits']
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['assets','failureReason','finalUnits','outcome','providerCostBasis','providerCostMicrounits']) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  -- 0637 CB2: the basis travels with a SUCCEEDED or FAILED cost to the settle, which checks it.
  basis := CASE WHEN p ? 'providerCostBasis' THEN jsonb_build_object('providerCostBasis', p->'providerCostBasis') ELSE '{}'::jsonb END;
  outcome := p->>'outcome'; reason := p->>'failureReason';
  IF NOT coalesce(CASE outcome
      WHEN 'SUCCEEDED' THEN jsonb_typeof(p->'finalUnits') = 'number' AND (p->>'finalUnits') ~ '^[1-9][0-9]{0,3}$'
        AND jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'
        AND jsonb_typeof(p->'assets') = 'array' AND jsonb_array_length(p->'assets') BETWEEN 1 AND 8 AND jsonb_typeof(p->'failureReason') = 'null'
      WHEN 'FAILED' THEN jsonb_typeof(p->'finalUnits') = 'null' AND jsonb_typeof(p->'assets') = 'null' AND reason = 'PROVIDER_REJECTED'
        AND (jsonb_typeof(p->'providerCostMicrounits') = 'null' OR (jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'))
      WHEN 'NOT_SENT' THEN jsonb_typeof(p->'finalUnits') = 'null' AND coalesce(jsonb_typeof(p->'providerCostBasis'), 'null') = 'null' AND jsonb_typeof(p->'assets') = 'null' AND jsonb_typeof(p->'providerCostMicrounits') = 'null'
        AND reason IN ('PROVIDER_NOT_CONNECTED','INVALID_REQUEST')
      WHEN 'UNKNOWN' THEN jsonb_typeof(p->'finalUnits') = 'null' AND coalesce(jsonb_typeof(p->'providerCostBasis'), 'null') = 'null' AND jsonb_typeof(p->'assets') = 'null' AND jsonb_typeof(p->'providerCostMicrounits') = 'null'
        AND reason IN ('PROVIDER_UNKNOWN','UNVERIFIED_RESULT','INTERRUPTED')
      ELSE false END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO g FROM hon.creative_generations WHERE id = p_generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.saas_creative_evidence_actor(p_subject, g.requested_by_principal_id);
  IF g.phase <> 'SUBMITTING' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  -- 0354: a generation with a provider job. Once SUBMITTED only the worker (p_job_status set) records it; while still
  -- PERMITTED the requester may record NOT_SENT, FAILED or UNKNOWN (only the API knows what the submit did), never
  -- SUCCEEDED or INTERRUPTED. A runtime record never creates or skips a job.
  SELECT * INTO job FROM hon.creative_provider_jobs WHERE generation_id = g.id AND school_id = g.school_id FOR UPDATE;
  IF FOUND THEN
    IF job.status NOT IN ('PERMITTED','SUBMITTED') THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
    IF p_job_status IS NULL AND (job.status = 'SUBMITTED' OR outcome = 'SUCCEEDED' OR reason = 'INTERRUPTED') THEN
      RAISE EXCEPTION 'CREATIVE_GENERATION_HAS_PROVIDER_JOB' USING ERRCODE = '40001';
    END IF;
  ELSIF p_job_status IS NOT NULL THEN
    RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002';
  ELSIF outcome = 'SUCCEEDED' AND NOT EXISTS (SELECT 1 FROM hon.saas_creative_reservations x WHERE x.id = g.reservation_id AND x.school_id = g.school_id
      AND x.model_code ~ '^synthetic-') THEN
    -- A real provider result is recorded only through a provider job, so the HQ daily provider limit can never be
    -- skipped. The synchronous path stays for the server's synthetic runtimes (model codes synthetic-*).
    RAISE EXCEPTION 'CREATIVE_PROVIDER_PERMIT_REQUIRED' USING ERRCODE = '40001';
  END IF;
  IF reason = 'INTERRUPTED' AND clock_timestamp() < g.created_at + interval '120 seconds' THEN
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
    body := jsonb_build_object('outcome', 'SUCCEEDED', 'finalUnits', n, 'providerCostMicrounits', p->'providerCostMicrounits') || basis;
    next_phase := 'RESULT_RECORDED';
  ELSIF outcome = 'FAILED' THEN
    body := jsonb_build_object('outcome', 'FAILED', 'finalUnits', NULL, 'providerCostMicrounits', p->'providerCostMicrounits') || basis; next_phase := 'PROVIDER_FAILED';
  ELSIF outcome = 'NOT_SENT' THEN
    -- The provider never received the request, so its cost is a known zero (not a guess).
    body := jsonb_build_object('outcome', 'FAILED', 'finalUnits', NULL, 'providerCostMicrounits', 0); next_phase := 'NOT_SENT';
  ELSE
    body := jsonb_build_object('outcome', 'UNKNOWN', 'finalUnits', NULL, 'providerCostMicrounits', NULL); next_phase := 'PROVIDER_UNKNOWN';
  END IF;
  SELECT version INTO v FROM hon.saas_creative_reservations WHERE id = g.reservation_id AND school_id = g.school_id;
  -- The CW1 settle takes the wallet lock and the reservation row lock and refuses anything but RESERVED, so a second
  -- record (or one after an HQ resolution) is refused before the generation row is touched.
  receipt := hon.settle_saas_creative_credits(p_subject, g.reservation_id, body || jsonb_build_object('expectedVersion', v),
    md5('creative.generation.result:' || g.id::text)::uuid, gen_random_uuid(), gen_random_uuid());
  IF (receipt->>'replayed')::boolean THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp();
  UPDATE hon.creative_generations SET phase = next_phase, failure_reason = CASE WHEN outcome = 'SUCCEEDED' THEN NULL ELSE reason END,
      version = version + 1, completed_at = greatest(at, created_at)
    WHERE id = g.id AND phase = 'SUBMITTING' RETURNING * INTO updated;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  IF job.id IS NOT NULL THEN
    UPDATE hon.creative_provider_jobs SET status = coalesce(p_job_status, 'RECORDED'), lease_token = NULL, lease_expires_at = NULL,
        closed_at = at, closed_by = CASE WHEN p_job_status IS NULL THEN 'REQUESTER' WHEN p_job_status = 'TIMED_OUT' THEN 'DEADLINE' ELSE 'WORKER' END,
        version = version + 1
      WHERE id = job.id AND status IN ('PERMITTED','SUBMITTED');
    IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  END IF;
  IF outcome = 'SUCCEEDED' THEN
    FOR a IN SELECT x FROM jsonb_array_elements(p->'assets') x LOOP
      i := i + 1;
      INSERT INTO hon.creative_generation_assets(generation_id, school_id, ordinal, media_type, width, height, duration_seconds, origin, provider_asset_reference, created_at)
        VALUES (g.id, g.school_id, i, a->>'mediaType', (a->>'width')::integer, (a->>'height')::integer, (a->>'durationSeconds')::integer,
          CASE WHEN p_job_status IS NULL THEN 'SYNTHETIC' ELSE 'PROVIDER' END,
          a->>'providerAssetReference', at);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('generation', hon.creative_generation_json(updated), 'balance', receipt->'balance', 'replayed', false);
END $$;

CREATE OR REPLACE FUNCTION hon.saas_creative_expense_json(p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object(
    'actualProviderCostMicrounits', coalesce(sum(provider_cost_microunits), 0),
    'finalizedProviderCostMicrounits', coalesce(sum(provider_cost_microunits) FILTER (WHERE status = 'FINALIZED'), 0),
    'failedOrNotChargedProviderCostMicrounits', coalesce(sum(provider_cost_microunits) FILTER (WHERE status = 'RELEASED'), 0),
    -- 0637 CB3: the part of the recorded cost that is only HON's estimate (a basis reference of estimate, or a cost
    -- recorded before 0637 without any reference: no adapter ever reported a provider cost).
    'estimatedProviderCostMicrounits', coalesce(sum(provider_cost_microunits) FILTER (WHERE cost_status = 'RECORDED'
      AND (cost_reference IS NULL OR cost_reference = 'hon:cost-basis:estimate')), 0),
    'consumedCredits', coalesce(sum(final_credits) FILTER (WHERE status = 'FINALIZED'), 0),
    'unknownCostGenerations', count(*) FILTER (WHERE cost_status = 'UNKNOWN'),
    'pendingCostGenerations', count(*) FILTER (WHERE cost_status = 'PENDING'),
    'spendClass', 'CREATIVE_MEDIA',
    'generations', jsonb_build_object('finalized', count(*) FILTER (WHERE status = 'FINALIZED'), 'released', count(*) FILTER (WHERE status = 'RELEASED'),
      'reserved', count(*) FILTER (WHERE status = 'RESERVED'), 'outcomeUnknown', count(*) FILTER (WHERE status = 'OUTCOME_UNKNOWN')))
  FROM hon.saas_creative_reservations WHERE school_id = p_school
$$;

COMMIT;
