BEGIN;

-- C3 (0355): private media storage records for real creative provider results, signed-read authorization and delete.
-- docs/architecture/CREATIVE_AI_IMAGE_VIDEO_PROVIDERS.md §5 / §12. Provider-free: nothing here calls a provider or a
-- storage service, holds a key or activates a program.
--
-- A real provider result (0354 job) is recorded only together with the files HON copied into its own private bucket:
-- the worker downloads each file, checks its type, size and dimensions from the bytes, strips metadata, uploads it to
-- the object key the database fixes for that job and ordinal (creative/<jobId>/<ordinal>), and then records the result
-- and the stored objects in one call. The 0354 result function no longer accepts SUCCEEDED, so a provider result can never
-- be charged for media HON does not hold. The worker never sees a school, a requester or a prompt; object keys carry no
-- school identifier, and every read is authorized from the asset's own row, never from the key.
--
-- Reads: the school's creative staff (the 0216 actor) get a storage key for an asset of their exact school that is
-- stored and not deleted; the API turns it into a 5-minute signed URL. Delete: the same actor marks the object deleted
-- (reads stop at once, identifier-only record kept), the API removes the file and confirms the removal.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON creative media storage requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.record_creative_provider_job_result(uuid,uuid,jsonb)') IS NULL
    OR to_regprocedure('hon.creative_close_provider_job(hon.creative_provider_jobs,jsonb,text)') IS NULL
    OR to_regprocedure('hon.require_saas_school_actor(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'HON creative media storage requires creative provider jobs (0354)';
  END IF;
END $$;

CREATE TABLE hon.creative_stored_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES hon.creative_provider_jobs(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  storage_key text NOT NULL UNIQUE,
  media_type text NOT NULL CHECK (media_type IN ('image/png','image/webp','video/mp4')),
  byte_size bigint NOT NULL CHECK (byte_size >= 1 AND byte_size <= CASE WHEN media_type = 'video/mp4' THEN 209715200 ELSE 26214400 END),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- The recorded asset, when the job was recorded. NULL when the job closed without settling (requester gone, or the
  -- reservation finished elsewhere): the file is kept as evidence for the HQ resolution.
  asset_id uuid UNIQUE REFERENCES hon.creative_generation_assets(id) ON DELETE RESTRICT,
  stored_at timestamptz NOT NULL,
  deleted_at timestamptz,
  deleted_by_principal_id uuid,
  removed_at timestamptz,
  UNIQUE (job_id, ordinal),
  CHECK (storage_key = 'creative/' || job_id::text || '/' || ordinal::text),
  CHECK ((deleted_at IS NULL) = (deleted_by_principal_id IS NULL)),
  CHECK (removed_at IS NULL OR deleted_at IS NOT NULL),
  CHECK (deleted_at IS NULL OR deleted_at >= stored_at),
  CHECK (removed_at IS NULL OR removed_at >= deleted_at)
);
CREATE INDEX creative_stored_objects_school ON hon.creative_stored_objects (school_id);
CREATE INDEX creative_stored_objects_pending_removal ON hon.creative_stored_objects (deleted_at) WHERE deleted_at IS NOT NULL AND removed_at IS NULL;

-- Rows are never removed. Only two moves: mark deleted once (who and when), then mark the file removed once.
CREATE FUNCTION hon.guard_creative_stored_object() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY['deleted_at','deleted_by_principal_id','removed_at']) = (to_jsonb(OLD) - ARRAY['deleted_at','deleted_by_principal_id','removed_at'])
    AND ((OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.removed_at IS NULL)
      OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at = OLD.deleted_at AND NEW.deleted_by_principal_id = OLD.deleted_by_principal_id
          AND OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER creative_stored_object_guarded BEFORE UPDATE OR DELETE ON hon.creative_stored_objects FOR EACH ROW EXECUTE FUNCTION hon.guard_creative_stored_object();
CREATE TRIGGER creative_stored_object_no_truncate BEFORE TRUNCATE ON hon.creative_stored_objects FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_creative_stored_object();

-- ---------- worker (hon_communication_worker) ----------
-- RESULT (0354 replaced): FAILED or UNKNOWN only. A provider success is recorded with its stored files below.
CREATE OR REPLACE FUNCTION hon.record_creative_provider_job_result(p_job uuid, p_lease uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE j hon.creative_provider_jobs%ROWTYPE;
BEGIN
  IF p_job IS NULL OR p_lease IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR coalesce(p->>'outcome', '') NOT IN ('FAILED','UNKNOWN')
    OR coalesce(p->>'failureReason', '') = 'INTERRUPTED' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  j := hon.creative_leased_job(p_job, p_lease);
  RETURN jsonb_build_object('status', hon.creative_close_provider_job(j, p, 'RECORDED'));
END $$;

-- STORED RESULT: a provider success plus one stored object per asset, in asset order. The assets carry the type, size
-- and duration the worker measured from the stored bytes; the database fixes each object key. The result goes through
-- the unchanged 0354 close (0216 validation, CW1 settle, requester as actor); the objects are kept whatever the close.
CREATE FUNCTION hon.record_creative_provider_job_stored_result(p_job uuid, p_lease uuid, p jsonb, p_objects jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE j hon.creative_provider_jobs%ROWTYPE; final text; n integer; i integer; o jsonb; a jsonb; asset uuid; at timestamptz;
BEGIN
  IF p_job IS NULL OR p_lease IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR coalesce(p->>'outcome', '') <> 'SUCCEEDED'
    OR jsonb_typeof(p->'assets') IS DISTINCT FROM 'array' OR p_objects IS NULL OR jsonb_typeof(p_objects) <> 'array'
    OR jsonb_array_length(p_objects) <> jsonb_array_length(p->'assets') OR jsonb_array_length(p_objects) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  n := jsonb_array_length(p_objects);
  FOR i IN 0 .. n - 1 LOOP
    o := p_objects->i; a := p->'assets'->i;
    IF jsonb_typeof(o) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(o) k) IS DISTINCT FROM ARRAY['byteSize','sha256']
      OR coalesce(jsonb_typeof(o->'byteSize'), '') <> 'number' OR (o->>'byteSize') !~ '^[1-9][0-9]{0,8}$'
      OR coalesce(jsonb_typeof(o->'sha256'), '') <> 'string' OR (o->>'sha256') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(a) <> 'object' OR coalesce(a->>'mediaType', '') NOT IN ('image/png','image/webp','video/mp4')
      OR (o->>'byteSize')::bigint > (CASE WHEN a->>'mediaType' = 'video/mp4' THEN 209715200 ELSE 26214400 END) THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  j := hon.creative_leased_job(p_job, p_lease);
  final := hon.creative_close_provider_job(j, p, 'RECORDED');
  at := clock_timestamp();
  FOR i IN 1 .. n LOOP
    o := p_objects->(i - 1); a := p->'assets'->(i - 1); asset := NULL;
    IF final = 'RECORDED' THEN
      SELECT x.id INTO asset FROM hon.creative_generation_assets x WHERE x.generation_id = j.generation_id AND x.school_id = j.school_id AND x.ordinal = i;
      IF asset IS NULL THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
    END IF;
    INSERT INTO hon.creative_stored_objects(job_id, school_id, ordinal, storage_key, media_type, byte_size, sha256, asset_id, stored_at)
      VALUES (j.id, j.school_id, i, 'creative/' || j.id::text || '/' || i::text, a->>'mediaType', (o->>'byteSize')::bigint, o->>'sha256', asset, at);
  END LOOP;
  RETURN jsonb_build_object('status', final);
END $$;

-- ---------- school reads and delete (hon_runtime) ----------
-- The stored object of one asset of the caller's exact school, or refused. Never by key, never across schools.
CREATE FUNCTION hon.creative_school_object(p_subject text, p_school uuid, p_asset uuid, p_lock boolean) RETURNS hon.creative_stored_objects
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE scope record; obj hon.creative_stored_objects%ROWTYPE;
BEGIN
  IF p_asset IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  IF p_lock THEN
    SELECT o.* INTO obj FROM hon.creative_stored_objects o JOIN hon.creative_generation_assets a ON a.id = o.asset_id AND a.school_id = o.school_id
     WHERE o.asset_id = p_asset AND o.school_id = scope.school_id FOR UPDATE OF o;
  ELSE
    SELECT o.* INTO obj FROM hon.creative_stored_objects o JOIN hon.creative_generation_assets a ON a.id = o.asset_id AND a.school_id = o.school_id
     WHERE o.asset_id = p_asset AND o.school_id = scope.school_id;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN obj;
END $$;

CREATE FUNCTION hon.authorize_creative_asset_read(p_subject text, p_school uuid, p_asset uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE obj hon.creative_stored_objects%ROWTYPE;
BEGIN
  obj := hon.creative_school_object(p_subject, p_school, p_asset, false);
  IF obj.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('assetId', obj.asset_id, 'storageKey', obj.storage_key, 'mediaType', obj.media_type, 'byteSize', obj.byte_size);
END $$;

-- DELETE: idempotent. The first call marks the object deleted by this person; every call answers with the key while the
-- file is not yet confirmed removed, so the API can retry the removal.
CREATE FUNCTION hon.delete_creative_asset(p_subject text, p_school uuid, p_asset uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE obj hon.creative_stored_objects%ROWTYPE; scope record;
BEGIN
  obj := hon.creative_school_object(p_subject, p_school, p_asset, true);
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  IF obj.deleted_at IS NULL THEN
    UPDATE hon.creative_stored_objects SET deleted_at = clock_timestamp(), deleted_by_principal_id = scope.principal_id WHERE id = obj.id RETURNING * INTO obj;
  END IF;
  RETURN jsonb_build_object('assetId', obj.asset_id, 'storageKey', CASE WHEN obj.removed_at IS NULL THEN obj.storage_key END,
    'deletedAt', hon.saas_ts(obj.deleted_at), 'removed', obj.removed_at IS NOT NULL);
END $$;

CREATE FUNCTION hon.confirm_creative_asset_removed(p_subject text, p_school uuid, p_asset uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE obj hon.creative_stored_objects%ROWTYPE;
BEGIN
  obj := hon.creative_school_object(p_subject, p_school, p_asset, true);
  IF obj.deleted_at IS NULL THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  IF obj.removed_at IS NULL THEN
    UPDATE hon.creative_stored_objects SET removed_at = greatest(clock_timestamp(), deleted_at) WHERE id = obj.id RETURNING * INTO obj;
  END IF;
  RETURN jsonb_build_object('assetId', obj.asset_id, 'storageKey', NULL, 'deletedAt', hon.saas_ts(obj.deleted_at), 'removed', true);
END $$;

-- School view (0216 replaced, same shape): a deleted asset is no longer listed.
CREATE OR REPLACE FUNCTION hon.creative_generation_json(g hon.creative_generations) RETURNS jsonb
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
      FROM hon.creative_generation_assets a WHERE a.generation_id = g.id AND a.school_id = g.school_id
        AND NOT EXISTS (SELECT 1 FROM hon.creative_stored_objects o WHERE o.asset_id = a.id AND o.deleted_at IS NOT NULL)), '[]'::jsonb) ELSE '[]'::jsonb END)
  FROM hon.saas_creative_reservations r WHERE r.id = g.reservation_id AND r.school_id = g.school_id
$$;

-- ---------- ACL ----------
DO $$ DECLARE r text; col text; f text; BEGIN
  ALTER TABLE hon.creative_stored_objects ENABLE ROW LEVEL SECURITY;
  ALTER TABLE hon.creative_stored_objects FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE hon.creative_stored_objects FROM PUBLIC CASCADE;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.creative_stored_objects FROM %I CASCADE', r);
  END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = 'hon.creative_stored_objects'::regclass AND attnum > 0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.creative_stored_objects FROM PUBLIC CASCADE', col);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace
      AND p.proname IN ('guard_creative_stored_object','record_creative_provider_job_result','record_creative_provider_job_stored_result',
        'creative_school_object','authorize_creative_asset_read','delete_creative_asset','confirm_creative_asset_removed','creative_generation_json') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.authorize_creative_asset_read(text,uuid,uuid), hon.delete_creative_asset(text,uuid,uuid),
      hon.confirm_creative_asset_removed(text,uuid,uuid) TO hon_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.record_creative_provider_job_result(uuid,uuid,jsonb), hon.record_creative_provider_job_stored_result(uuid,uuid,jsonb,jsonb)
      TO hon_communication_worker;
  END IF;
END $$;

COMMIT;
