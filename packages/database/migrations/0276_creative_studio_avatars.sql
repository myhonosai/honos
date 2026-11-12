BEGIN;

-- A1 Creative Studio avatars (0276, allocated by the coordinator). Provider-free: nothing here calls a provider, charges a
-- card, changes trial funding or activates a program.
--
-- An avatar is a school's own AI presenter look (name, style, description). It is made by exactly ONE CS1 generation
-- (0216) of the operation avatar.create, priced by whatever rate the HQ owner publishes (media kind IMAGE, 1 unit,
-- PORTRAIT), and paid only from that school's creative wallet (0202). create_creative_avatar calls the unchanged
-- create_creative_generation, so the requester's exact-school authority, the S4 pause gate and CREATIVE_MEDIA spend
-- decision, eligibility, the published rate, the school wallet lock, the 3-in-progress cap and the finality re-checks
-- all apply. The provider result is recorded by the unchanged record_creative_generation_result. The avatar's status is
-- derived from its creation generation, so an HQ resolution of a held outcome shows up without touching the avatar.
--
-- avatar.* operations are reserved: a deferred constraint trigger refuses, at commit, any avatar.* generation that has
-- no avatar row, so the generic generation entry point can never create an orphan avatar charge (A2/0277 extends the
-- same rule to avatar videos). Fair use (proposal): at most 12 avatars per school that are not failed or refunded.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON Creative Studio avatars require a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.create_creative_generation(text,uuid,jsonb,jsonb,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.creative_generation_json(hon.creative_generations)') IS NULL THEN
    RAISE EXCEPTION 'HON Creative Studio avatars require Creative Studio generations (0216)';
  END IF;
END $$;

-- One line of printable text: 1..40 characters, trimmed, no control, line-break or bidi-override characters.
CREATE FUNCTION hon.creative_avatar_name_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT p IS NOT NULL AND length(p) BETWEEN 1 AND 40 AND btrim(p) = p
    AND p !~ E'[\\x01-\\x1f\\x7f\\u202a-\\u202e\\u2066-\\u2069]'
$$;

CREATE TABLE hon.creative_avatars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  name text NOT NULL CHECK (hon.creative_avatar_name_ok(name)),
  style text NOT NULL CHECK (style IN ('REALISTIC','ILLUSTRATED','CHIBI')),
  description text NOT NULL CHECK (hon.creative_prompt_ok(description)),
  generation_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  UNIQUE (created_by_principal_id, idempotency_key),
  UNIQUE (id, school_id),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.saas_creative_wallets(school_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (generation_id, school_id) REFERENCES hon.creative_generations(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX creative_avatars_school ON hon.creative_avatars (school_id, created_at DESC, id DESC);
-- Avatars are immutable records (no rename or edit in A1).
CREATE TRIGGER creative_avatar_immutable BEFORE UPDATE OR DELETE ON hon.creative_avatars FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER creative_avatar_no_truncate BEFORE TRUNCATE ON hon.creative_avatars FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

-- avatar.* generations exist only together with their avatar record. Deferred to commit, so the avatar wrapper can insert
-- the generation first and the avatar second; SECURITY DEFINER because it fires at commit, outside the definer wrapper.
CREATE FUNCTION hon.guard_creative_avatar_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  IF NEW.operation_code LIKE 'avatar.%' AND NOT EXISTS (SELECT 1 FROM hon.creative_avatars a WHERE a.generation_id = NEW.id AND a.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'CREATIVE_AVATAR_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER creative_generation_avatar_required AFTER INSERT ON hon.creative_generations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.guard_creative_avatar_generation();

-- School view of one avatar: its look plus its creation generation (the CS1 school view: no provider, model, cost or HQ note).
CREATE FUNCTION hon.creative_avatar_json(a hon.creative_avatars) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('avatarId', a.id, 'schoolId', a.school_id, 'name', a.name, 'style', a.style, 'description', a.description,
    'status', CASE gj->>'status' WHEN 'GENERATING' THEN 'CREATING' WHEN 'SUCCEEDED' THEN 'READY' WHEN 'UNDER_REVIEW' THEN 'UNDER_REVIEW' ELSE 'NOT_CREATED' END,
    'createdAt', hon.saas_ts(a.created_at), 'generation', gj)
  FROM (SELECT hon.creative_generation_json(g) gj FROM hon.creative_generations g WHERE g.id = a.generation_id AND g.school_id = a.school_id) x
$$;

CREATE FUNCTION hon.creative_avatar_fingerprint(p_school uuid, p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('schoolId', p_school, 'name', p->'name', 'style', p->'style', 'description', p->'description')::text, 'UTF8')), 'hex')
$$;

-- CREATE: the school actor's request, idempotent per (creator, key); the same key with a different body is refused (409).
CREATE FUNCTION hon.create_creative_avatar(p_subject text, p_school uuid, p jsonb, p_provider jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; fp text; existing hon.creative_avatars%ROWTYPE; receipt jsonb; g hon.creative_generations%ROWTYPE; made hon.creative_avatars%ROWTYPE;
  live integer; again record; at timestamptz; why text; e jsonb;
BEGIN
  IF p_key IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['description','name','style']
    OR coalesce(jsonb_typeof(p->'name'), '') <> 'string' OR NOT hon.creative_avatar_name_ok(p->>'name')
    OR coalesce(p->>'style', '') NOT IN ('REALISTIC','ILLUSTRATED','CHIBI') OR jsonb_typeof(p->'style') <> 'string'
    OR coalesce(jsonb_typeof(p->'description'), '') <> 'string' OR NOT hon.creative_prompt_ok(p->>'description') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  fp := hon.creative_avatar_fingerprint(scope.school_id, p);
  SELECT * INTO existing FROM hon.creative_avatars WHERE created_by_principal_id = scope.principal_id AND idempotency_key = p_key;
  IF FOUND THEN
    IF existing.request_fingerprint <> fp OR existing.school_id <> scope.school_id THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('avatar', hon.creative_avatar_json(existing), 'balance', hon.saas_creative_balance_json(existing.school_id, clock_timestamp()), 'replayed', true);
  END IF;
  -- The unchanged CS1 create (reserve + generation + finality re-checks) under a key derived from the avatar key.
  receipt := hon.create_creative_generation(p_subject, scope.school_id,
    jsonb_build_object('operationCode', 'avatar.create', 'units', 1, 'format', 'PORTRAIT', 'prompt', p->'description'),
    p_provider, md5('creative.avatar:' || p_key::text)::uuid, p_request, p_correlation);
  IF (receipt->>'replayed')::boolean THEN
    -- A concurrent request with the same key committed first: answer with its avatar, never a second one.
    SELECT * INTO existing FROM hon.creative_avatars WHERE created_by_principal_id = scope.principal_id AND idempotency_key = p_key;
    IF NOT FOUND OR existing.request_fingerprint <> fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('avatar', hon.creative_avatar_json(existing), 'balance', hon.saas_creative_balance_json(existing.school_id, clock_timestamp()), 'replayed', true);
  END IF;
  SELECT * INTO g FROM hon.creative_generations WHERE id = (receipt#>>'{generation,generationId}')::uuid AND school_id = scope.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_CREATIVE_LEDGER_MISMATCH' USING ERRCODE = '23514'; END IF;
  -- The HQ rate decides the media kind: an avatar look is one image.
  IF g.media_kind <> 'IMAGE' OR g.units <> 1 OR g.operation_code <> 'avatar.create' THEN RAISE EXCEPTION 'CREATIVE_AVATAR_RATE_INVALID' USING ERRCODE = '23514'; END IF;
  -- Fair use: the reserve holds the school's wallet lock until commit, so this count and the insert are serialized per school.
  SELECT count(*) INTO live FROM hon.creative_avatars a JOIN hon.creative_generations cg ON cg.id = a.generation_id AND cg.school_id = a.school_id
    JOIN hon.saas_creative_reservations r ON r.id = cg.reservation_id AND r.school_id = cg.school_id
    WHERE a.school_id = scope.school_id AND r.status <> 'RELEASED';
  IF live >= 12 THEN RAISE EXCEPTION 'CREATIVE_AVATAR_LIMIT_REACHED' USING ERRCODE = '23514'; END IF;
  INSERT INTO hon.creative_avatars(school_id, organization_id, created_by_principal_id, idempotency_key, request_fingerprint, name, style, description, generation_id, created_at)
    VALUES (g.school_id, g.organization_id, scope.principal_id, p_key, fp, p->>'name', p->>'style', p->>'description', g.id, g.created_at)
    RETURNING * INTO made;
  -- Finality after this wrapper's own writes: the same live-clock decisions as CS1, still under the reserve's pause gate,
  -- wallet lock and SHARE-locked authority tables, so a grant or access window that ended meanwhile rolls everything back.
  at := clock_timestamp();
  SELECT * INTO again FROM hon.require_saas_school_actor(p_subject, scope.school_id) LIMIT 1;
  IF again.principal_id IS DISTINCT FROM scope.principal_id OR again.school_id IS DISTINCT FROM scope.school_id THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  why := hon.ai_spend_allowed(scope.organization_id, at, 'CREATIVE_MEDIA');
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || why USING ERRCODE = '23514'; END IF;
  e := hon.saas_creative_eligibility(scope.school_id, at);
  IF NOT (e->>'eligible')::boolean THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || (e->>'reason') USING ERRCODE = '23514'; END IF;
  RETURN jsonb_build_object('avatar', hon.creative_avatar_json(made), 'balance', receipt->'balance', 'replayed', false);
END $$;

-- READS: the exact school only (CW1 school actor); newest 50, filtered to the school before ordering and the limit.
CREATE FUNCTION hon.read_creative_avatars(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; list jsonb;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT coalesce(jsonb_agg(hon.creative_avatar_json(a) ORDER BY a.created_at DESC, a.id DESC), '[]'::jsonb) INTO list
    FROM (SELECT * FROM hon.creative_avatars WHERE school_id = scope.school_id ORDER BY created_at DESC, id DESC LIMIT 50) a;
  RETURN jsonb_build_object('avatars', list, 'limit', 50);
END $$;

CREATE FUNCTION hon.read_creative_avatar(p_subject text, p_school uuid, p_avatar uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; a hon.creative_avatars%ROWTYPE;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT * INTO a FROM hon.creative_avatars WHERE id = p_avatar AND school_id = scope.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN hon.creative_avatar_json(a);
END $$;

-- ---------- ACL: private deny-all table; three runtime entry points ----------
DO $$ DECLARE r text; col text; f text; BEGIN
  ALTER TABLE hon.creative_avatars ENABLE ROW LEVEL SECURITY;
  ALTER TABLE hon.creative_avatars FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE hon.creative_avatars FROM PUBLIC CASCADE;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.creative_avatars FROM %I CASCADE',r);
  END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = 'hon.creative_avatars'::regclass AND attnum > 0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.creative_avatars FROM PUBLIC CASCADE',col);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.creative_avatars FROM %I CASCADE',col,r);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace
      AND p.proname IN ('creative_avatar_name_ok','guard_creative_avatar_generation','creative_avatar_json','creative_avatar_fingerprint',
        'create_creative_avatar','read_creative_avatars','read_creative_avatar') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_creative_avatar(text,uuid,jsonb,jsonb,uuid,uuid,uuid), hon.read_creative_avatars(text,uuid),
      hon.read_creative_avatar(text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
