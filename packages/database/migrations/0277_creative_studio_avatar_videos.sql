BEGIN;

-- A2 Creative Studio avatar videos (0277, allocated by the coordinator). Provider-free: nothing here calls a provider,
-- charges a card, changes trial funding or activates a program.
--
-- An avatar video is a school's READY avatar (0276) speaking a short script. It is made by exactly ONE CS1 generation
-- (0216) of the operation avatar.video, priced by whatever rate the HQ owner publishes (media kind VIDEO, one unit per
-- second, 5..60 seconds) and paid only from that school's creative wallet (0202). create_creative_avatar_video calls the
-- unchanged create_creative_generation, so every CS1 rule applies (exact-school authority, S4 pause gate and
-- CREATIVE_MEDIA spend decision, eligibility, published rate, wallet lock, 3-in-progress cap, finality re-checks). The
-- result is recorded by the unchanged record_creative_generation_result; the video's status is derived from it.
--
-- The 0276 commit-time guard is replaced so that avatar.create needs its avatar row, avatar.video needs its avatar-video
-- row, and any other avatar.* operation is refused: the generic entry point can never create an avatar charge.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON Creative Studio avatar videos require a trusted migration owner';
  END IF;
  IF to_regclass('hon.creative_avatars') IS NULL OR to_regprocedure('hon.guard_creative_avatar_generation()') IS NULL
    OR to_regprocedure('hon.creative_avatar_json(hon.creative_avatars)') IS NULL THEN
    RAISE EXCEPTION 'HON Creative Studio avatar videos require Creative Studio avatars (0276)';
  END IF;
END $$;

CREATE TABLE hon.creative_avatar_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  avatar_id uuid NOT NULL,
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  script text NOT NULL CHECK (hon.creative_prompt_ok(script)),
  seconds integer NOT NULL CHECK (seconds BETWEEN 5 AND 60),
  format text NOT NULL CHECK (format IN ('SQUARE','PORTRAIT','LANDSCAPE')),
  generation_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  UNIQUE (created_by_principal_id, idempotency_key),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.saas_creative_wallets(school_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (avatar_id, school_id) REFERENCES hon.creative_avatars(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (generation_id, school_id) REFERENCES hon.creative_generations(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX creative_avatar_videos_school ON hon.creative_avatar_videos (school_id, created_at DESC, id DESC);
CREATE TRIGGER creative_avatar_video_immutable BEFORE UPDATE OR DELETE ON hon.creative_avatar_videos FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER creative_avatar_video_no_truncate BEFORE TRUNCATE ON hon.creative_avatar_videos FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

-- Replaces the 0276 body (same signature, owner, ACL and deferred trigger): each avatar.* operation needs its own record.
CREATE OR REPLACE FUNCTION hon.guard_creative_avatar_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  IF NEW.operation_code = 'avatar.create' THEN
    IF NOT EXISTS (SELECT 1 FROM hon.creative_avatars a WHERE a.generation_id = NEW.id AND a.school_id = NEW.school_id) THEN
      RAISE EXCEPTION 'CREATIVE_AVATAR_REQUIRED' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.operation_code = 'avatar.video' THEN
    IF NOT EXISTS (SELECT 1 FROM hon.creative_avatar_videos v WHERE v.generation_id = NEW.id AND v.school_id = NEW.school_id) THEN
      RAISE EXCEPTION 'CREATIVE_AVATAR_REQUIRED' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.operation_code LIKE 'avatar.%' THEN
    RAISE EXCEPTION 'CREATIVE_AVATAR_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

-- School view of one avatar video: its avatar, script and its generation (the CS1 school view).
CREATE FUNCTION hon.creative_avatar_video_json(v hon.creative_avatar_videos) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('videoId', v.id, 'schoolId', v.school_id, 'avatarId', v.avatar_id, 'script', v.script, 'seconds', v.seconds, 'format', v.format,
    'status', CASE gj->>'status' WHEN 'GENERATING' THEN 'CREATING' WHEN 'SUCCEEDED' THEN 'READY' WHEN 'UNDER_REVIEW' THEN 'UNDER_REVIEW' ELSE 'NOT_CREATED' END,
    'createdAt', hon.saas_ts(v.created_at), 'generation', gj)
  FROM (SELECT hon.creative_generation_json(g) gj FROM hon.creative_generations g WHERE g.id = v.generation_id AND g.school_id = v.school_id) x
$$;

CREATE FUNCTION hon.creative_avatar_video_fingerprint(p_school uuid, p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('schoolId', p_school, 'avatarId', p->'avatarId', 'script', p->'script', 'seconds', p->'seconds', 'format', p->'format')::text, 'UTF8')), 'hex')
$$;

-- CREATE: the school actor's request for one of its READY avatars, idempotent per (creator, key).
CREATE FUNCTION hon.create_creative_avatar_video(p_subject text, p_school uuid, p jsonb, p_provider jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; fp text; existing hon.creative_avatar_videos%ROWTYPE; av hon.creative_avatars%ROWTYPE; receipt jsonb; g hon.creative_generations%ROWTYPE;
  made hon.creative_avatar_videos%ROWTYPE; again record; at timestamptz; why text; e jsonb;
BEGIN
  IF p_key IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['avatarId','format','script','seconds']
    OR coalesce(jsonb_typeof(p->'avatarId'), '') <> 'string' OR (p->>'avatarId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR coalesce(jsonb_typeof(p->'seconds'), '') <> 'number' OR (p->>'seconds') !~ '^[1-9][0-9]?$' OR (p->>'seconds')::integer NOT BETWEEN 5 AND 60
    OR coalesce(jsonb_typeof(p->'format'), '') <> 'string' OR (p->>'format') NOT IN ('SQUARE','PORTRAIT','LANDSCAPE')
    OR coalesce(jsonb_typeof(p->'script'), '') <> 'string' OR NOT hon.creative_prompt_ok(p->>'script') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  fp := hon.creative_avatar_video_fingerprint(scope.school_id, p);
  SELECT * INTO existing FROM hon.creative_avatar_videos WHERE created_by_principal_id = scope.principal_id AND idempotency_key = p_key;
  IF FOUND THEN
    IF existing.request_fingerprint <> fp OR existing.school_id <> scope.school_id THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('video', hon.creative_avatar_video_json(existing), 'balance', hon.saas_creative_balance_json(existing.school_id, clock_timestamp()), 'replayed', true);
  END IF;
  -- Only this school's own avatar, and only once its look was made (READY). A SUCCEEDED generation is final.
  SELECT * INTO av FROM hon.creative_avatars WHERE id = (p->>'avatarId')::uuid AND school_id = scope.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.creative_generations cg WHERE cg.id = av.generation_id AND cg.school_id = av.school_id
      AND hon.creative_generation_json(cg)->>'status' = 'SUCCEEDED') THEN
    RAISE EXCEPTION 'CREATIVE_AVATAR_NOT_READY' USING ERRCODE = '23514';
  END IF;
  receipt := hon.create_creative_generation(p_subject, scope.school_id,
    jsonb_build_object('operationCode', 'avatar.video', 'units', p->'seconds', 'format', p->'format', 'prompt', p->'script'),
    p_provider, md5('creative.avatar.video:' || p_key::text)::uuid, p_request, p_correlation);
  IF (receipt->>'replayed')::boolean THEN
    SELECT * INTO existing FROM hon.creative_avatar_videos WHERE created_by_principal_id = scope.principal_id AND idempotency_key = p_key;
    IF NOT FOUND OR existing.request_fingerprint <> fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('video', hon.creative_avatar_video_json(existing), 'balance', hon.saas_creative_balance_json(existing.school_id, clock_timestamp()), 'replayed', true);
  END IF;
  SELECT * INTO g FROM hon.creative_generations WHERE id = (receipt#>>'{generation,generationId}')::uuid AND school_id = scope.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_CREATIVE_LEDGER_MISMATCH' USING ERRCODE = '23514'; END IF;
  -- The HQ rate decides the media kind: an avatar video is a VIDEO charged per second.
  IF g.media_kind <> 'VIDEO' OR g.units <> (p->>'seconds')::integer OR g.operation_code <> 'avatar.video' THEN
    RAISE EXCEPTION 'CREATIVE_AVATAR_RATE_INVALID' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.creative_avatar_videos(school_id, organization_id, avatar_id, created_by_principal_id, idempotency_key, request_fingerprint, script, seconds, format, generation_id, created_at)
    VALUES (g.school_id, g.organization_id, av.id, scope.principal_id, p_key, fp, p->>'script', (p->>'seconds')::integer, p->>'format', g.id, g.created_at)
    RETURNING * INTO made;
  -- Finality after this wrapper's own writes (the A1 rule): live-clock authority, CREATIVE_MEDIA spend and eligibility.
  at := clock_timestamp();
  SELECT * INTO again FROM hon.require_saas_school_actor(p_subject, scope.school_id) LIMIT 1;
  IF again.principal_id IS DISTINCT FROM scope.principal_id OR again.school_id IS DISTINCT FROM scope.school_id THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  why := hon.ai_spend_allowed(scope.organization_id, at, 'CREATIVE_MEDIA');
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || why USING ERRCODE = '23514'; END IF;
  e := hon.saas_creative_eligibility(scope.school_id, at);
  IF NOT (e->>'eligible')::boolean THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || (e->>'reason') USING ERRCODE = '23514'; END IF;
  RETURN jsonb_build_object('video', hon.creative_avatar_video_json(made), 'balance', receipt->'balance', 'replayed', false);
END $$;

-- READS: the exact school only; newest 50, filtered to the school before ordering and the limit.
CREATE FUNCTION hon.read_creative_avatar_videos(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; list jsonb;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT coalesce(jsonb_agg(hon.creative_avatar_video_json(v) ORDER BY v.created_at DESC, v.id DESC), '[]'::jsonb) INTO list
    FROM (SELECT * FROM hon.creative_avatar_videos WHERE school_id = scope.school_id ORDER BY created_at DESC, id DESC LIMIT 50) v;
  RETURN jsonb_build_object('videos', list, 'limit', 50);
END $$;

CREATE FUNCTION hon.read_creative_avatar_video(p_subject text, p_school uuid, p_video uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; v hon.creative_avatar_videos%ROWTYPE;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT * INTO v FROM hon.creative_avatar_videos WHERE id = p_video AND school_id = scope.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN hon.creative_avatar_video_json(v);
END $$;

-- ---------- ACL: private deny-all table; three runtime entry points ----------
DO $$ DECLARE r text; col text; f text; BEGIN
  ALTER TABLE hon.creative_avatar_videos ENABLE ROW LEVEL SECURITY;
  ALTER TABLE hon.creative_avatar_videos FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE hon.creative_avatar_videos FROM PUBLIC CASCADE;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.creative_avatar_videos FROM %I CASCADE',r);
  END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = 'hon.creative_avatar_videos'::regclass AND attnum > 0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.creative_avatar_videos FROM PUBLIC CASCADE',col);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.creative_avatar_videos FROM %I CASCADE',col,r);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace
      AND p.proname IN ('guard_creative_avatar_generation','creative_avatar_video_json','creative_avatar_video_fingerprint',
        'create_creative_avatar_video','read_creative_avatar_videos','read_creative_avatar_video') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_creative_avatar_video(text,uuid,jsonb,jsonb,uuid,uuid,uuid), hon.read_creative_avatar_videos(text,uuid),
      hon.read_creative_avatar_video(text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
