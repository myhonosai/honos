BEGIN;

-- CS1 (proposed 0216; the owner allocates the final number): Creative Studio image and video generation on the CW1
-- per-school creative wallet (0202). Provider-free: nothing here calls a provider, charges a card or activates a
-- program. 0214/0215 are proposed by other open PRs (#157/#158) and are not required by this migration.
--
-- One generation = one request by a staff member of ONE school (ai.premium.request at that exact school, the CW1 school
-- actor). It is paid only from that school's own wallet and never touches the internal AI-agent budget: the reservation,
-- the S4 emergency-pause gate, the CREATIVE_MEDIA spend decision, eligibility, the published rate and the wallet lock are
-- all the unchanged CW1 reserve; provider usage is the CW1 settle (ai_usage_ledger, spend_class CREATIVE_MEDIA, customer
-- credits 0). HON and the AI team (HON, Kai, Alex, Chad, Maya, Marcus, Jordan, Claire, Lena) are never involved.
--
-- Lifecycle: create (reserve + record the request, idempotent per requester and key) -> one provider call by the API ->
-- record the result exactly once (requester only, never refused by a pause or an access change: an in-flight result is
-- always recorded, the S4-a rule). SUCCEEDED charges the actual units (never above the reservation) and stores the result
-- metadata; FAILED returns the credits and keeps an unreported provider cost UNKNOWN (never a guessed zero); NOT_SENT (the
-- provider never received the request) returns the credits with a known zero cost; UNKNOWN holds the credits for the
-- human HQ owner, who resolves the reservation with evidence through the existing CW1 resolve command (AI-D3). The status
-- a school sees is derived from the reservation, so an HQ resolution shows up without touching the generation row.
--
-- Fair use (proposal, no charge): at most 3 generations in progress per school; units are bounded by the published rate.
-- CS1 stores only SYNTHETIC result metadata (fake providers); real media storage and signed reads are a later slice.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON Creative Studio generations require a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.reserve_saas_creative_credits(text,uuid,jsonb,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.settle_saas_creative_credits(text,uuid,jsonb,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.saas_creative_evidence_actor(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'HON Creative Studio generations require the CW1 creative wallet (0202)';
  END IF;
END $$;

-- Printable prompt text: 1..1000 characters, trimmed, line breaks and tabs allowed, no other control or bidi-override characters.
CREATE FUNCTION hon.creative_prompt_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT p IS NOT NULL AND length(p) BETWEEN 1 AND 1000 AND btrim(p, E' \t\n\r') = p
    AND p !~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f\\u202a-\\u202e\\u2066-\\u2069]'
$$;

CREATE TABLE hon.creative_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  reservation_id uuid NOT NULL UNIQUE,
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  operation_code text NOT NULL CHECK (operation_code ~ '^[a-z][a-z0-9_.]{2,59}$'),
  media_kind text NOT NULL CHECK (media_kind IN ('IMAGE','VIDEO')),
  units integer NOT NULL CHECK (units BETWEEN 1 AND 1000),
  format text NOT NULL CHECK (format IN ('SQUARE','PORTRAIT','LANDSCAPE')),
  prompt text NOT NULL CHECK (hon.creative_prompt_ok(prompt)),
  phase text NOT NULL CHECK (phase IN ('SUBMITTING','RESULT_RECORDED','PROVIDER_FAILED','NOT_SENT','PROVIDER_UNKNOWN')),
  failure_reason text,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (requested_by_principal_id, idempotency_key),
  UNIQUE (id, school_id),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.saas_creative_wallets(school_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (reservation_id, school_id) REFERENCES hon.saas_creative_reservations(id, school_id) ON DELETE RESTRICT,
  CHECK ((phase = 'SUBMITTING') = (completed_at IS NULL)),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (CASE phase
    WHEN 'SUBMITTING' THEN failure_reason IS NULL
    WHEN 'RESULT_RECORDED' THEN failure_reason IS NULL
    WHEN 'PROVIDER_FAILED' THEN failure_reason = 'PROVIDER_REJECTED'
    WHEN 'NOT_SENT' THEN failure_reason IN ('PROVIDER_NOT_CONNECTED','INVALID_REQUEST')
    ELSE failure_reason IN ('PROVIDER_UNKNOWN','UNVERIFIED_RESULT','INTERRUPTED') END)
);
CREATE INDEX creative_generations_school ON hon.creative_generations (school_id, created_at DESC, id DESC);

CREATE TABLE hon.creative_generation_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL,
  school_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  media_type text NOT NULL CHECK (media_type IN ('image/png','image/webp','video/mp4')),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 8192),
  duration_seconds integer CHECK (duration_seconds BETWEEN 1 AND 600),
  -- CS1: synthetic results only. Real provider media needs reviewed storage and signed reads (later slice).
  origin text NOT NULL CHECK (origin = 'SYNTHETIC'),
  provider_asset_reference text NOT NULL CHECK (provider_asset_reference ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$'),
  created_at timestamptz NOT NULL,
  UNIQUE (generation_id, ordinal),
  FOREIGN KEY (generation_id, school_id) REFERENCES hon.creative_generations(id, school_id) ON DELETE RESTRICT,
  CHECK ((media_type = 'video/mp4') = (duration_seconds IS NOT NULL))
);

-- Generations move once, SUBMITTING -> a terminal phase, with every request field unchanged. Assets are append-only.
CREATE FUNCTION hon.guard_creative_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE moving text[] := ARRAY['phase','failure_reason','version','completed_at'];
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.phase = 'SUBMITTING' AND NEW.phase <> 'SUBMITTING' AND NEW.version = OLD.version + 1
    AND (to_jsonb(NEW) - moving) = (to_jsonb(OLD) - moving) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER creative_generation_guarded BEFORE UPDATE OR DELETE ON hon.creative_generations FOR EACH ROW EXECUTE FUNCTION hon.guard_creative_generation();
CREATE TRIGGER creative_generation_no_truncate BEFORE TRUNCATE ON hon.creative_generations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_creative_generation();
CREATE TRIGGER creative_generation_asset_immutable BEFORE UPDATE OR DELETE ON hon.creative_generation_assets FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER creative_generation_asset_no_truncate BEFORE TRUNCATE ON hon.creative_generation_assets FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

-- School view of one generation. Status comes from the reservation (the credit truth); a reservation finished by anyone
-- other than the result recorder (HQ resolution) shows as RESOLVED_*. No provider, model, cost, actor or HQ note.
CREATE FUNCTION hon.creative_generation_json(g hon.creative_generations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('generationId', g.id, 'schoolId', g.school_id, 'operationCode', g.operation_code, 'mediaKind', g.media_kind,
    'units', g.units, 'format', g.format, 'prompt', g.prompt,
    'status', CASE r.status
      WHEN 'RESERVED' THEN 'GENERATING'
      WHEN 'OUTCOME_UNKNOWN' THEN 'UNDER_REVIEW'
      WHEN 'FINALIZED' THEN CASE WHEN g.phase = 'RESULT_RECORDED' THEN 'SUCCEEDED' ELSE 'RESOLVED_CHARGED' END
      ELSE CASE WHEN g.phase IN ('PROVIDER_FAILED','NOT_SENT') THEN 'FAILED' ELSE 'RESOLVED_NOT_CHARGED' END END,
    'failureReason', CASE WHEN r.status = 'OUTCOME_UNKNOWN' THEN coalesce(g.failure_reason, 'PROVIDER_UNKNOWN')
      WHEN r.status = 'FINALIZED' AND g.phase = 'RESULT_RECORDED' THEN NULL ELSE g.failure_reason END,
    'reservedCredits', r.reserved_credits,
    'chargedCredits', CASE WHEN r.status = 'FINALIZED' THEN r.final_credits END,
    'createdAt', hon.saas_ts(g.created_at),
    'completedAt', CASE WHEN r.status = 'RESERVED' THEN NULL ELSE hon.saas_ts(coalesce(g.completed_at, r.settled_at)) END,
    'assets', CASE WHEN r.status = 'FINALIZED' AND g.phase = 'RESULT_RECORDED' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('assetId', a.id, 'ordinal', a.ordinal,
        'mediaType', a.media_type, 'width', a.width, 'height', a.height, 'durationSeconds', a.duration_seconds, 'origin', a.origin) ORDER BY a.ordinal)
      FROM hon.creative_generation_assets a WHERE a.generation_id = g.id AND a.school_id = g.school_id), '[]'::jsonb) ELSE '[]'::jsonb END)
  FROM hon.saas_creative_reservations r WHERE r.id = g.reservation_id AND r.school_id = g.school_id
$$;

CREATE FUNCTION hon.creative_generation_fingerprint(p_school uuid, p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('schoolId', p_school, 'operationCode', p->'operationCode', 'units', p->'units',
    'format', p->'format', 'prompt', p->'prompt')::text, 'UTF8')), 'hex')
$$;

-- CREATE: the school actor's request. The idempotency key belongs to the requester: the same key and body return the same
-- generation (never a second reservation or provider call); the same key with a different body is refused (409). The CW1
-- reserve runs unchanged, under a key derived from the request key, so its pause gate, wallet lock, authority re-check,
-- S4 decision, eligibility, rate and balance checks, audit and outbox all apply. The provider and model come from the
-- server's configured runtime, never from the client.
CREATE FUNCTION hon.create_creative_generation(p_subject text, p_school uuid, p jsonb, p_provider jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; fp text; existing hon.creative_generations%ROWTYPE; receipt jsonb; res hon.saas_creative_reservations%ROWTYPE;
  created hon.creative_generations%ROWTYPE; busy integer; again record; at timestamptz; why text; e jsonb; out jsonb;
BEGIN
  IF p_key IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['format','operationCode','prompt','units']
    OR coalesce(jsonb_typeof(p->'operationCode'), '') <> 'string' OR (p->>'operationCode') !~ '^[a-z][a-z0-9_.]{2,59}$'
    OR coalesce(jsonb_typeof(p->'units'), '') <> 'number' OR (p->>'units') !~ '^[1-9][0-9]{0,3}$' OR (p->>'units')::integer > 1000
    OR coalesce(p->>'format', '') NOT IN ('SQUARE','PORTRAIT','LANDSCAPE') OR coalesce(jsonb_typeof(p->'prompt'), '') <> 'string'
    OR NOT hon.creative_prompt_ok(p->>'prompt')
    OR p_provider IS NULL OR jsonb_typeof(p_provider) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_provider) k) IS DISTINCT FROM ARRAY['modelCode','providerId']
    OR coalesce(jsonb_typeof(p_provider->'providerId'), '') <> 'string' OR coalesce(jsonb_typeof(p_provider->'modelCode'), '') <> 'string' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  fp := hon.creative_generation_fingerprint(scope.school_id, p);
  SELECT * INTO existing FROM hon.creative_generations WHERE requested_by_principal_id = scope.principal_id AND idempotency_key = p_key;
  IF FOUND THEN
    IF existing.request_fingerprint <> fp OR existing.school_id <> scope.school_id THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('generation', hon.creative_generation_json(existing), 'balance', hon.saas_creative_balance_json(existing.school_id, clock_timestamp()), 'replayed', true);
  END IF;
  receipt := hon.reserve_saas_creative_credits(p_subject, scope.school_id,
    jsonb_build_object('operationCode', p->'operationCode', 'units', p->'units', 'providerId', p_provider->'providerId', 'modelCode', p_provider->'modelCode'),
    md5('creative.generation:' || p_key::text)::uuid, p_request, p_correlation);
  IF (receipt->>'replayed')::boolean THEN
    -- A concurrent request with the same key committed first: answer with its generation, never a second one.
    SELECT * INTO existing FROM hon.creative_generations WHERE requested_by_principal_id = scope.principal_id AND idempotency_key = p_key;
    IF NOT FOUND OR existing.request_fingerprint <> fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('generation', hon.creative_generation_json(existing), 'balance', hon.saas_creative_balance_json(existing.school_id, clock_timestamp()), 'replayed', true);
  END IF;
  SELECT * INTO res FROM hon.saas_creative_reservations WHERE id = (receipt#>>'{reservation,reservationId}')::uuid AND school_id = scope.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_CREATIVE_LEDGER_MISMATCH' USING ERRCODE = '23514'; END IF;
  -- Fair use: the reserve holds the school's wallet lock until commit, so this count and the insert are serialized per school.
  SELECT count(*) INTO busy FROM hon.creative_generations g JOIN hon.saas_creative_reservations r ON r.id = g.reservation_id AND r.school_id = g.school_id
    WHERE g.school_id = scope.school_id AND r.status = 'RESERVED';
  IF busy >= 3 THEN RAISE EXCEPTION 'CREATIVE_TOO_MANY_IN_PROGRESS' USING ERRCODE = '23514'; END IF;
  INSERT INTO hon.creative_generations(school_id, organization_id, reservation_id, requested_by_principal_id, idempotency_key, request_fingerprint,
      operation_code, media_kind, units, format, prompt, phase, version, created_at)
    VALUES (res.school_id, res.organization_id, res.id, scope.principal_id, p_key, fp, res.operation_code, res.media_kind, res.units,
      p->>'format', p->>'prompt', 'SUBMITTING', 1, res.reserved_at)
    RETURNING * INTO created;
  out := jsonb_build_object('generation', hon.creative_generation_json(created), 'balance', receipt->'balance', 'replayed', false);
  -- Finality (after this wrapper's own writes, any wait they took, and building the answer): the requester's exact-school
  -- authority, the S4 spend decision and creative eligibility are decided again at the live clock, still under the
  -- reserve's pause gate, wallet lock and SHARE-locked authority tables. A grant, entitlement or access window that
  -- ended during that wait refuses the request, and the refusal rolls back the generation, the reservation and its audit
  -- together, so the API never hands an unauthorized generation to the provider. Nothing is reserved twice.
  at := clock_timestamp();
  SELECT * INTO again FROM hon.require_saas_school_actor(p_subject, scope.school_id) LIMIT 1;
  IF again.principal_id IS DISTINCT FROM scope.principal_id OR again.school_id IS DISTINCT FROM scope.school_id THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  why := hon.ai_spend_allowed(scope.organization_id, at, 'CREATIVE_MEDIA');
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || why USING ERRCODE = '23514'; END IF;
  e := hon.saas_creative_eligibility(scope.school_id, at);
  IF NOT (e->>'eligible')::boolean THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || (e->>'reason') USING ERRCODE = '23514'; END IF;
  RETURN out;
END $$;

-- RECORD: the provider outcome, exactly once, by the generation's own requester (the CW1 evidence actor: no entitlement,
-- role, pause or school-status check, so an in-flight result is never lost). One CW1 settle per generation, under a key
-- derived from the generation. UNKNOWN with reason INTERRUPTED (no answer was ever recorded) is accepted only after the
-- request has been open for 120 seconds, so a request still in flight is never marked unknown by a retry.
CREATE FUNCTION hon.record_creative_generation_result(p_subject text, p_generation uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE g hon.creative_generations%ROWTYPE; outcome text; reason text; v integer; body jsonb; receipt jsonb; a jsonb; i integer := 0; n integer;
  at timestamptz; next_phase text; updated hon.creative_generations%ROWTYPE;
BEGIN
  IF p_generation IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['assets','failureReason','finalUnits','outcome','providerCostMicrounits'] THEN
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
  SELECT * INTO g FROM hon.creative_generations WHERE id = p_generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.saas_creative_evidence_actor(p_subject, g.requested_by_principal_id);
  IF g.phase <> 'SUBMITTING' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
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
    body := jsonb_build_object('outcome', 'SUCCEEDED', 'finalUnits', n, 'providerCostMicrounits', p->'providerCostMicrounits');
    next_phase := 'RESULT_RECORDED';
  ELSIF outcome = 'FAILED' THEN
    body := jsonb_build_object('outcome', 'FAILED', 'finalUnits', NULL, 'providerCostMicrounits', p->'providerCostMicrounits'); next_phase := 'PROVIDER_FAILED';
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
  IF outcome = 'SUCCEEDED' THEN
    FOR a IN SELECT x FROM jsonb_array_elements(p->'assets') x LOOP
      i := i + 1;
      INSERT INTO hon.creative_generation_assets(generation_id, school_id, ordinal, media_type, width, height, duration_seconds, origin, provider_asset_reference, created_at)
        VALUES (g.id, g.school_id, i, a->>'mediaType', (a->>'width')::integer, (a->>'height')::integer, (a->>'durationSeconds')::integer, 'SYNTHETIC',
          a->>'providerAssetReference', at);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('generation', hon.creative_generation_json(updated), 'balance', receipt->'balance', 'replayed', false);
END $$;

-- READS: the exact school only (CW1 school actor); newest 50, filtered to the school before ordering and the limit.
CREATE FUNCTION hon.read_creative_generations(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; list jsonb;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT coalesce(jsonb_agg(hon.creative_generation_json(g) ORDER BY g.created_at DESC, g.id DESC), '[]'::jsonb) INTO list
    FROM (SELECT * FROM hon.creative_generations WHERE school_id = scope.school_id ORDER BY created_at DESC, id DESC LIMIT 50) g;
  RETURN jsonb_build_object('generations', list, 'limit', 50);
END $$;

CREATE FUNCTION hon.read_creative_generation(p_subject text, p_school uuid, p_generation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; g hon.creative_generations%ROWTYPE;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT * INTO g FROM hon.creative_generations WHERE id = p_generation AND school_id = scope.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN hon.creative_generation_json(g);
END $$;

-- ---------- ACL: private deny-all tables; four runtime entry points ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['creative_generations','creative_generation_assets'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.'||t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I CASCADE',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace
      AND p.proname IN ('creative_prompt_ok','guard_creative_generation','creative_generation_json','creative_generation_fingerprint',
        'create_creative_generation','record_creative_generation_result','read_creative_generations','read_creative_generation') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_creative_generation(text,uuid,jsonb,jsonb,uuid,uuid,uuid), hon.record_creative_generation_result(text,uuid,jsonb),
      hon.read_creative_generations(text,uuid), hon.read_creative_generation(text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
