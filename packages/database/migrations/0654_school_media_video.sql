BEGIN;

-- Video in the school media library and in blasts BL3c (0654, allocated by the coordinator 2026-11-22). Owner decisions
-- (David): 2026-11-18 "Email pictures, video as a link"; 2026-11-22 "Allow media storage" and "Allow 720p copies". Builds
-- on 0628 (media library) and 0653 (pictures inside email blasts). Spec: docs/architecture/SCHOOL_MEDIA_LIBRARY.md (Video).
-- Rules:
--   V1  A video is an MP4, MOV (QuickTime) or WebM file of 1 byte to 5 GiB. The browser stores the original straight into the
--       private bucket through a one-time signed upload link for the fixed key media/<assetId>; HON never makes the original
--       public. The API confirms the stored size and the file signature before the video becomes READY.
--   V2  A READY video gets a 720p playback copy (media/<assetId>.720.mp4) and a poster (media/<assetId>.poster.jpg) made by
--       HON with every metadata field (location, camera, dates) removed. Only the copy and the poster are ever linked. The
--       copy job holds a lease (two hours), is tried at most three times, and runs as a code-owned service principal with no
--       authority. Width, height and duration come from the copy.
--   V3  Caps (0628 M4) count the original, the copy and the poster. The upload month counts the original.
--   V4  /m/<token> of a video opens the copy and /m/<token>/poster the poster, both only once the copy is DONE; the public
--       video page resolves the same way. Delete stops every link at once; the API removes all three files.
--   V5  An email blast body may hold video lines {{video:<assetId>}}; pictures and videos together at most 10. Save and send
--       require each video to be a READY video of the same school with its copy DONE. The worker lookup answers videos too.
--   V6  The runtime gains EXECUTE on the video upload start and finish, the three copy job calls and the two public video
--       resolvers, and nothing else. Every command keeps exact-request idempotency, audit and an inert outbox event with ids,
--       sizes and states only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'School media video requires a restricted runtime'; END IF;
  IF to_regprocedure('hon.resolve_school_media_link(text)') IS NULL OR to_regprocedure('hon.communication_email_pictures(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '0654 requires 0628 and 0653'; END IF;
END $$;

-- Code-owned video copy job. No user, role, HQ, family or delegated authority belongs to it.
INSERT INTO hon.principals(id,principal_type,display_name)
  VALUES('00000000-0000-4000-8000-000000000654','SYSTEM_SERVICE','Code-owned school video copy job');

ALTER TABLE hon.school_media_assets
  DROP CONSTRAINT school_media_assets_kind_check,
  DROP CONSTRAINT school_media_assets_media_type_check,
  DROP CONSTRAINT school_media_assets_byte_size_check,
  ALTER COLUMN sha256 DROP NOT NULL,
  ALTER COLUMN width DROP NOT NULL,
  ALTER COLUMN height DROP NOT NULL,
  ADD COLUMN copy_state text CHECK (copy_state IN ('QUEUED','WORKING','DONE','FAILED')),
  ADD COLUMN copy_attempts integer NOT NULL DEFAULT 0 CHECK (copy_attempts BETWEEN 0 AND 3),
  ADD COLUMN copy_lease uuid,
  ADD COLUMN copy_lease_until timestamptz,
  ADD COLUMN copy_bytes bigint CHECK (copy_bytes BETWEEN 1 AND 5368709120),
  ADD COLUMN poster_bytes bigint CHECK (poster_bytes BETWEEN 1 AND 26214400),
  ADD COLUMN copy_sha256 text CHECK (copy_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN duration_ms integer CHECK (duration_ms BETWEEN 1 AND 1800000),
  ADD COLUMN copy_done_at timestamptz,
  ADD CONSTRAINT school_media_assets_kind_check CHECK (
    (kind='IMAGE' AND media_type IN ('image/jpeg','image/png','image/gif') AND byte_size BETWEEN 1 AND 26214400
      AND sha256 IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND copy_state IS NULL AND copy_attempts=0
      AND copy_lease IS NULL AND copy_lease_until IS NULL AND copy_bytes IS NULL AND poster_bytes IS NULL AND copy_sha256 IS NULL
      AND duration_ms IS NULL AND copy_done_at IS NULL)
    OR (kind='VIDEO' AND media_type IN ('video/mp4','video/quicktime','video/webm') AND byte_size BETWEEN 1 AND 5368709120 AND sha256 IS NULL
      AND (copy_state IS NULL)=(ready_at IS NULL)
      AND (copy_state='WORKING')=(copy_lease IS NOT NULL AND copy_lease_until IS NOT NULL)
      AND (copy_state='DONE')=(copy_done_at IS NOT NULL)
      AND (copy_state='DONE')=(copy_bytes IS NOT NULL AND poster_bytes IS NOT NULL AND copy_sha256 IS NOT NULL AND duration_ms IS NOT NULL
        AND width IS NOT NULL AND height IS NOT NULL)
      AND (copy_state IS DISTINCT FROM 'DONE' OR (width<=1280 AND height<=1280))));

-- Identity and content never change; every change bumps the version; states only move forward (0628). A video's copy moves
-- QUEUED -> WORKING -> QUEUED (retry) | DONE | FAILED, WORKING -> WORKING only on a new lease after the old one ran out,
-- and only while the video is READY; the copy's facts are written once, at DONE.
CREATE OR REPLACE FUNCTION hon.guard_school_media_asset() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'SCHOOL_MEDIA_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.state<>'PENDING' OR NEW.ready_at IS NOT NULL OR NEW.copy_state IS NOT NULL OR NEW.copy_attempts<>0 THEN
      RAISE EXCEPTION 'SCHOOL_MEDIA_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.kind,NEW.media_type,NEW.byte_size,NEW.sha256,NEW.object_key,
      NEW.link_token,NEW.created_by_principal_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.kind,OLD.media_type,OLD.byte_size,OLD.sha256,OLD.object_key,
      OLD.link_token,OLD.created_by_principal_id,OLD.created_at)
    OR NEW.version<>OLD.version+1
    OR NOT ((NEW.state=OLD.state AND OLD.state IN ('PENDING','READY') AND NEW.title<>OLD.title)
      OR (NEW.state=OLD.state AND OLD.state='READY' AND OLD.kind='VIDEO' AND NEW.title=OLD.title AND NEW.copy_state IS DISTINCT FROM OLD.copy_state)
      OR (NEW.state=OLD.state AND OLD.state='READY' AND OLD.kind='VIDEO' AND NEW.title=OLD.title AND OLD.copy_state='WORKING' AND NEW.copy_state='WORKING'
        AND OLD.copy_lease_until<=clock_timestamp() AND NEW.copy_lease IS DISTINCT FROM OLD.copy_lease)
      OR (OLD.state='PENDING' AND NEW.state='READY' AND NEW.title=OLD.title)
      OR (OLD.state IN ('PENDING','READY') AND NEW.state='DELETED' AND NEW.title=OLD.title)
      OR (OLD.state='DELETED' AND NEW.state='REMOVED' AND NEW.title=OLD.title))
    OR (OLD.ready_at IS NOT NULL AND NEW.ready_at IS DISTINCT FROM OLD.ready_at)
    OR (OLD.deleted_at IS NOT NULL AND (NEW.deleted_at,NEW.deleted_by_principal_id) IS DISTINCT FROM (OLD.deleted_at,OLD.deleted_by_principal_id)) THEN
    RAISE EXCEPTION 'SCHOOL_MEDIA_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF OLD.kind='IMAGE' AND (NEW.width,NEW.height) IS DISTINCT FROM (OLD.width,OLD.height) THEN RAISE EXCEPTION 'SCHOOL_MEDIA_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF OLD.kind='VIDEO' THEN
    -- The copy: allowed moves only, attempts only grow on a claim, the facts are written once at DONE and never again.
    IF NOT ((NEW.copy_state IS NOT DISTINCT FROM OLD.copy_state AND NEW.copy_lease IS NOT DISTINCT FROM OLD.copy_lease)
        OR (OLD.state='PENDING' AND NEW.state='READY' AND OLD.copy_state IS NULL AND NEW.copy_state='QUEUED')
        OR (NEW.state='READY' AND OLD.copy_state='QUEUED' AND NEW.copy_state='WORKING' AND NEW.copy_attempts=OLD.copy_attempts+1)
        OR (NEW.state='READY' AND OLD.copy_state='WORKING' AND NEW.copy_state='WORKING' AND NEW.copy_attempts=OLD.copy_attempts+1)
        OR (NEW.state='READY' AND OLD.copy_state='WORKING' AND NEW.copy_state IN ('QUEUED','DONE','FAILED') AND NEW.copy_attempts=OLD.copy_attempts))
      OR (NEW.copy_attempts<>OLD.copy_attempts AND NEW.copy_state IS DISTINCT FROM 'WORKING')
      OR (OLD.copy_state IN ('DONE','FAILED') AND NEW.copy_state IS DISTINCT FROM OLD.copy_state)
      OR (OLD.copy_state IS DISTINCT FROM 'WORKING' AND (NEW.copy_bytes,NEW.poster_bytes,NEW.copy_sha256,NEW.duration_ms,NEW.width,NEW.height,NEW.copy_done_at)
        IS DISTINCT FROM (OLD.copy_bytes,OLD.poster_bytes,OLD.copy_sha256,OLD.duration_ms,OLD.width,OLD.height,OLD.copy_done_at))
      OR (OLD.copy_state='WORKING' AND NEW.copy_state IS DISTINCT FROM 'DONE' AND (NEW.copy_bytes,NEW.poster_bytes,NEW.copy_sha256,NEW.duration_ms,NEW.width,NEW.height,NEW.copy_done_at)
        IS DISTINCT FROM (OLD.copy_bytes,OLD.poster_bytes,OLD.copy_sha256,OLD.duration_ms,OLD.width,OLD.height,OLD.copy_done_at)) THEN
      RAISE EXCEPTION 'SCHOOL_MEDIA_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSIF NEW.copy_attempts<>OLD.copy_attempts THEN RAISE EXCEPTION 'SCHOOL_MEDIA_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

-- The library row: 0628 fields plus the copy state and duration. A link token only once the item can be shown.
CREATE OR REPLACE FUNCTION hon.school_media_json(a hon.school_media_assets) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('assetId',a.id,'kind',a.kind,'mediaType',a.media_type,'title',a.title,'byteSize',a.byte_size,
    'width',a.width,'height',a.height,'state',a.state,'version',a.version,
    'linkToken',CASE WHEN a.state='READY' AND (a.kind='IMAGE' OR a.copy_state='DONE') THEN a.link_token END,
    'copyState',a.copy_state,'durationMs',a.duration_ms,
    'createdAt',hon.saas_ts(a.created_at),'readyAt',hon.saas_ts(a.ready_at),'updatedAt',hon.saas_ts(a.updated_at))
$$;
-- Bytes held (until removed: original, copy and poster) and bytes uploaded this UTC calendar month (originals).
CREATE OR REPLACE FUNCTION hon.school_media_usage(org uuid,school uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object(
    'storedBytes',coalesce(sum(a.byte_size+coalesce(a.copy_bytes,0)+coalesce(a.poster_bytes,0)) FILTER (WHERE a.state IN ('PENDING','READY','DELETED')),0),'storedLimitBytes',5368709120,
    'monthBytes',coalesce(sum(a.byte_size) FILTER (WHERE a.created_at>=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0),
    'monthLimitBytes',10737418240)
  FROM hon.school_media_assets a WHERE a.organization_id=org AND a.school_id=school
$$;

-- 0628 picture confirm, now refusing a video (whose original is confirmed by finish_school_video_upload).
CREATE OR REPLACE FUNCTION hon.finish_school_media_upload(subject text,p jsonb,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; a hon.school_media_assets; before jsonb;
BEGIN
  actor:=hon.require_school_media_actor(subject,'marketing.media.manage');
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['assetId','byteSize','sha256']
    OR jsonb_typeof(p->'assetId') IS DISTINCT FROM 'string' OR p->>'assetId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'sha256') IS DISTINCT FROM 'string' OR p->>'sha256' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p->'byteSize') IS DISTINCT FROM 'number' OR p->>'byteSize' !~ '^[1-9][0-9]{0,8}$'
    OR request IS NULL OR correlation IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,
    hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_school_media_actor(subject,'marketing.media.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_MEDIA_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM hon.school_media_assets x WHERE x.id=(p->>'assetId')::uuid AND x.organization_id=org AND x.school_id=school AND x.kind='IMAGE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF a.byte_size<>(p->>'byteSize')::bigint OR a.sha256 IS DISTINCT FROM p->>'sha256' THEN RAISE EXCEPTION 'MEDIA_UPLOAD_MISMATCH' USING ERRCODE='22023'; END IF;
  IF a.state='READY' THEN RETURN hon.school_media_json(a); END IF;
  IF a.state<>'PENDING' THEN RAISE EXCEPTION 'MEDIA_NOT_PENDING' USING ERRCODE='55000'; END IF;
  before:=jsonb_build_object('state',a.state,'version',a.version);
  UPDATE hon.school_media_assets SET state='READY',ready_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    WHERE id=a.id RETURNING * INTO a;
  RETURN hon.school_media_finish(subject,NULL,actor,'school_media.ready',a,before,request,correlation);
END $$;

-- Step 1 of a video upload: {title,mediaType,byteSize} becomes a PENDING video with the fixed key media/<id>, within the
-- caps. The API then signs a one-time upload link for exactly that key. A replay answers with the video as it is now.
CREATE FUNCTION hon.begin_school_video_upload(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; a hon.school_media_assets; usage jsonb;
BEGIN
  actor:=hon.require_school_media_actor(subject,'marketing.media.manage');
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['byteSize','mediaType','title']
    OR NOT hon.school_media_title_ok(p->'title')
    OR jsonb_typeof(p->'mediaType') IS DISTINCT FROM 'string' OR p->>'mediaType' NOT IN ('video/mp4','video/quicktime','video/webm')
    OR jsonb_typeof(p->'byteSize') IS DISTINCT FROM 'number' OR p->>'byteSize' !~ '^[1-9][0-9]{0,9}$' OR (p->>'byteSize')::bigint>5368709120
    OR request IS NULL OR correlation IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  prior:=hon.school_media_begin(subject,'begin_school_video_upload',p,key,actor);
  IF prior IS NOT NULL THEN RETURN hon.school_media_current(org,school,prior); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_media:'||school::text,0));
  usage:=hon.school_media_usage(org,school);
  IF (usage->>'storedBytes')::bigint+(p->>'byteSize')::bigint>(usage->>'storedLimitBytes')::bigint THEN
    RAISE EXCEPTION 'MEDIA_STORAGE_FULL' USING ERRCODE='55000'; END IF;
  IF (usage->>'monthBytes')::bigint+(p->>'byteSize')::bigint>(usage->>'monthLimitBytes')::bigint THEN
    RAISE EXCEPTION 'MEDIA_MONTHLY_LIMIT' USING ERRCODE='55000'; END IF;
  INSERT INTO hon.school_media_assets(id,organization_id,school_id,kind,media_type,title,byte_size,object_key,link_token,created_by_principal_id)
    SELECT n.id,org,school,'VIDEO',p->>'mediaType',p->>'title',(p->>'byteSize')::bigint,'media/'||n.id::text,hon.school_media_new_token(),actor
      FROM (SELECT gen_random_uuid() AS id) n
    RETURNING * INTO a;
  RETURN hon.school_media_finish(subject,key,actor,'school_media.upload_started',a,NULL,request,correlation)
    ||jsonb_build_object('objectKey',a.object_key);
END $$;

-- Step 2: the API found exactly {byteSize} bytes of a video file under the key. PENDING becomes READY with its copy QUEUED;
-- a READY video of the same size answers as it is (a retried confirm), anything else is refused.
CREATE FUNCTION hon.finish_school_video_upload(subject text,p jsonb,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; a hon.school_media_assets; before jsonb;
BEGIN
  actor:=hon.require_school_media_actor(subject,'marketing.media.manage');
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['assetId','byteSize']
    OR jsonb_typeof(p->'assetId') IS DISTINCT FROM 'string' OR p->>'assetId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'byteSize') IS DISTINCT FROM 'number' OR p->>'byteSize' !~ '^[1-9][0-9]{0,9}$'
    OR request IS NULL OR correlation IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,
    hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_school_media_actor(subject,'marketing.media.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_MEDIA_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM hon.school_media_assets x WHERE x.id=(p->>'assetId')::uuid AND x.organization_id=org AND x.school_id=school AND x.kind='VIDEO' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF a.byte_size<>(p->>'byteSize')::bigint THEN RAISE EXCEPTION 'MEDIA_UPLOAD_MISMATCH' USING ERRCODE='22023'; END IF;
  IF a.state='READY' THEN RETURN hon.school_media_json(a); END IF;
  IF a.state<>'PENDING' THEN RAISE EXCEPTION 'MEDIA_NOT_PENDING' USING ERRCODE='55000'; END IF;
  before:=jsonb_build_object('state',a.state,'version',a.version);
  UPDATE hon.school_media_assets SET state='READY',ready_at=clock_timestamp(),copy_state='QUEUED',version=version+1,updated_at=clock_timestamp()
    WHERE id=a.id RETURNING * INTO a;
  RETURN hon.school_media_finish(subject,NULL,actor,'school_media.ready',a,before,request,correlation);
END $$;

-- Audit and an inert outbox event for the copy job (ids, sizes and states only), as the code-owned 0654 service.
CREATE FUNCTION hon.school_video_copy_record(a hon.school_media_assets,action text,before jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE svc uuid:='00000000-0000-4000-8000-000000000654'; request uuid:=gen_random_uuid();
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(a.organization_id,a.school_id,svc,'SYSTEM_SERVICE',action,'SCHOOL_MEDIA_ASSET',a.id,before,
      jsonb_build_object('state',a.state,'version',a.version,'copyState',a.copy_state,'copyAttempts',a.copy_attempts,'copyBytes',a.copy_bytes),'SUCCEEDED',request,a.id);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(a.organization_id,a.school_id,action,1,'SCHOOL_MEDIA_ASSET',a.id,a.version,a.id,request,
      jsonb_build_object('assetId',a.id,'version',a.version,'state',a.state,'copyState',a.copy_state,'copyBytes',a.copy_bytes));
END $$;

-- The copy job takes one video: the oldest QUEUED copy of a READY video of an active school, or a WORKING copy whose lease
-- ran out. A copy that ran out of its third lease becomes FAILED instead. Answers the new lease and the three fixed keys,
-- or null when there is nothing to do.
CREATE FUNCTION hon.claim_school_video_copy() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE a hon.school_media_assets; before jsonb;
BEGIN
  FOR a IN SELECT x.* FROM hon.school_media_assets x WHERE x.kind='VIDEO' AND x.state='READY' AND x.copy_state='WORKING'
      AND x.copy_lease_until<=clock_timestamp() AND x.copy_attempts>=3 ORDER BY x.copy_lease_until,x.id LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
    before:=jsonb_build_object('copyState',a.copy_state,'version',a.version);
    UPDATE hon.school_media_assets SET copy_state='FAILED',copy_lease=NULL,copy_lease_until=NULL,version=version+1,updated_at=clock_timestamp()
      WHERE id=a.id RETURNING * INTO a;
    PERFORM hon.school_video_copy_record(a,'school_media.copy_failed',before);
  END LOOP;
  SELECT x.* INTO a FROM hon.school_media_assets x
    JOIN hon.schools s ON s.id=x.school_id AND s.organization_id=x.organization_id AND s.status='ACTIVE'
    JOIN hon.organizations o ON o.id=x.organization_id AND o.status='ACTIVE'
   WHERE x.kind='VIDEO' AND x.state='READY'
     AND (x.copy_state='QUEUED' OR (x.copy_state='WORKING' AND x.copy_lease_until<=clock_timestamp() AND x.copy_attempts<3))
   ORDER BY x.ready_at,x.id LIMIT 1 FOR UPDATE OF x SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  before:=jsonb_build_object('copyState',a.copy_state,'version',a.version);
  UPDATE hon.school_media_assets SET copy_state='WORKING',copy_attempts=copy_attempts+1,copy_lease=gen_random_uuid(),
      copy_lease_until=clock_timestamp()+interval '2 hours',version=version+1,updated_at=clock_timestamp()
    WHERE id=a.id RETURNING * INTO a;
  PERFORM hon.school_video_copy_record(a,'school_media.copy_started',before);
  RETURN jsonb_build_object('assetId',a.id,'lease',a.copy_lease,'mediaType',a.media_type,'byteSize',a.byte_size,'attempt',a.copy_attempts,
    'sourceKey',a.object_key,'copyKey',a.object_key||'.720.mp4','posterKey',a.object_key||'.poster.jpg');
END $$;

-- The lease holder stored the copy and the poster: {copyBytes,posterBytes,copySha256,width,height,durationMs}. DONE, or
-- {"discard":true} when the video was deleted meanwhile (the job then removes the two files it stored).
CREATE FUNCTION hon.finish_school_video_copy(asset uuid,lease uuid,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE a hon.school_media_assets; before jsonb;
BEGIN
  IF asset IS NULL OR lease IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['copyBytes','copySha256','durationMs','height','posterBytes','width']
    OR jsonb_typeof(p->'copyBytes') IS DISTINCT FROM 'number' OR p->>'copyBytes' !~ '^[1-9][0-9]{0,9}$' OR (p->>'copyBytes')::bigint>5368709120
    OR jsonb_typeof(p->'posterBytes') IS DISTINCT FROM 'number' OR p->>'posterBytes' !~ '^[1-9][0-9]{0,7}$' OR (p->>'posterBytes')::bigint>26214400
    OR jsonb_typeof(p->'copySha256') IS DISTINCT FROM 'string' OR p->>'copySha256' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p->'width') IS DISTINCT FROM 'number' OR p->>'width' !~ '^[1-9][0-9]{0,3}$' OR (p->>'width')::integer>1280
    OR jsonb_typeof(p->'height') IS DISTINCT FROM 'number' OR p->>'height' !~ '^[1-9][0-9]{0,3}$' OR (p->>'height')::integer>1280
    OR jsonb_typeof(p->'durationMs') IS DISTINCT FROM 'number' OR p->>'durationMs' !~ '^[1-9][0-9]{0,6}$' OR (p->>'durationMs')::integer>1800000 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM hon.school_media_assets x WHERE x.id=asset AND x.kind='VIDEO' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF a.state IN ('DELETED','REMOVED') THEN RETURN jsonb_build_object('assetId',a.id,'discard',true); END IF;
  IF a.copy_state IS DISTINCT FROM 'WORKING' OR a.copy_lease IS DISTINCT FROM lease OR a.copy_lease_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'MEDIA_COPY_LEASE_LOST' USING ERRCODE='55000'; END IF;
  before:=jsonb_build_object('copyState',a.copy_state,'version',a.version);
  UPDATE hon.school_media_assets SET copy_state='DONE',copy_lease=NULL,copy_lease_until=NULL,copy_bytes=(p->>'copyBytes')::bigint,
      poster_bytes=(p->>'posterBytes')::bigint,copy_sha256=p->>'copySha256',width=(p->>'width')::integer,height=(p->>'height')::integer,
      duration_ms=(p->>'durationMs')::integer,copy_done_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    WHERE id=a.id RETURNING * INTO a;
  PERFORM hon.school_video_copy_record(a,'school_media.copy_done',before);
  RETURN jsonb_build_object('assetId',a.id,'copyState',a.copy_state);
END $$;

-- The lease holder could not make the copy (code: a short upper-case reason). Back to QUEUED, or FAILED after the third try.
CREATE FUNCTION hon.fail_school_video_copy(asset uuid,lease uuid,code text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE a hon.school_media_assets; before jsonb;
BEGIN
  IF asset IS NULL OR lease IS NULL OR code IS NULL OR code !~ '^[A-Z][A-Z_]{1,39}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM hon.school_media_assets x WHERE x.id=asset AND x.kind='VIDEO' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF a.state IN ('DELETED','REMOVED') THEN RETURN jsonb_build_object('assetId',a.id,'discard',true); END IF;
  IF a.copy_state IS DISTINCT FROM 'WORKING' OR a.copy_lease IS DISTINCT FROM lease THEN RAISE EXCEPTION 'MEDIA_COPY_LEASE_LOST' USING ERRCODE='55000'; END IF;
  before:=jsonb_build_object('copyState',a.copy_state,'version',a.version,'code',code);
  UPDATE hon.school_media_assets SET copy_state=CASE WHEN a.copy_attempts>=3 THEN 'FAILED' ELSE 'QUEUED' END,copy_lease=NULL,copy_lease_until=NULL,
      version=version+1,updated_at=clock_timestamp()
    WHERE id=a.id RETURNING * INTO a;
  PERFORM hon.school_video_copy_record(a,CASE WHEN a.copy_state='FAILED' THEN 'school_media.copy_failed' ELSE 'school_media.copy_retry' END,before);
  RETURN jsonb_build_object('assetId',a.id,'copyState',a.copy_state);
END $$;

-- The public /m/<token> link: a READY picture, or the 720p copy of a READY video whose copy is DONE, of an active school.
CREATE OR REPLACE FUNCTION hon.resolve_school_media_link(token text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT CASE a.kind WHEN 'IMAGE' THEN jsonb_build_object('objectKey',a.object_key,'mediaType',a.media_type)
    ELSE jsonb_build_object('objectKey',a.object_key||'.720.mp4','mediaType','video/mp4') END
  FROM hon.school_media_assets a
  JOIN hon.schools s ON s.id=a.school_id AND s.organization_id=a.organization_id AND s.status='ACTIVE'
  JOIN hon.organizations o ON o.id=a.organization_id AND o.status='ACTIVE'
  WHERE token ~ '^[A-Za-z0-9_-]{43}$' AND a.link_token=token AND a.state='READY' AND (a.kind='IMAGE' OR a.copy_state='DONE')
$$;
-- /m/<token>/poster: the poster of a READY video whose copy is DONE, of an active school.
CREATE FUNCTION hon.resolve_school_video_poster(token text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('objectKey',a.object_key||'.poster.jpg','mediaType','image/jpeg')
  FROM hon.school_media_assets a
  JOIN hon.schools s ON s.id=a.school_id AND s.organization_id=a.organization_id AND s.status='ACTIVE'
  JOIN hon.organizations o ON o.id=a.organization_id AND o.status='ACTIVE'
  WHERE token ~ '^[A-Za-z0-9_-]{43}$' AND a.link_token=token AND a.kind='VIDEO' AND a.state='READY' AND a.copy_state='DONE'
$$;
-- The public video page (/v/<token>): the school's display name, the title and the copy's size and length. Nothing else.
CREATE FUNCTION hon.resolve_school_video_page(token text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('schoolName',s.name,'title',a.title,'width',a.width,'height',a.height,'durationMs',a.duration_ms)
  FROM hon.school_media_assets a
  JOIN hon.schools s ON s.id=a.school_id AND s.organization_id=a.organization_id AND s.status='ACTIVE'
  JOIN hon.organizations o ON o.id=a.organization_id AND o.status='ACTIVE'
  WHERE token ~ '^[A-Za-z0-9_-]{43}$' AND a.link_token=token AND a.kind='VIDEO' AND a.state='READY' AND a.copy_state='DONE'
$$;

-- Blasts (V5). Video lines are {{video:<assetId>}}, each alone on a line.
CREATE FUNCTION hon.school_blast_video_ids(p_body text) RETURNS uuid[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(array_agg(DISTINCT m[1]::uuid ORDER BY m[1]::uuid),'{}'::uuid[])
    FROM regexp_matches(coalesce(p_body,''),'^\{\{video:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\}$','gn') m
$$;
-- A blast body: SMS as in 0621; EMAIL up to 3,500 characters with at most 10 picture and video lines together, each counted
-- as one character for the 0621 plain-text rules.
CREATE OR REPLACE FUNCTION hon.school_blast_body_ok(v jsonb,chan text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE chan
    WHEN 'SMS' THEN hon.school_blast_text_ok(v,1,1000)
    WHEN 'EMAIL' THEN coalesce(jsonb_typeof(v)='string' AND length(v#>>'{}')<=3500
      AND (SELECT count(*) FROM regexp_matches(v#>>'{}','^\{\{(picture|video):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\}$','gn'))<=10
      AND hon.school_blast_text_ok(to_jsonb(regexp_replace(v#>>'{}','^\{\{(picture|video):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\}$','x','gn')),1,3500),false)
    ELSE false END
$$;
-- Every picture of a body is a READY picture, and every video a READY video with its copy DONE, of this school.
CREATE OR REPLACE FUNCTION hon.school_blast_pictures_ready(org uuid,school uuid,p_body text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM unnest(hon.school_blast_picture_ids(p_body)) i WHERE NOT EXISTS(SELECT 1 FROM hon.school_media_assets a
      WHERE a.id=i AND a.organization_id=org AND a.school_id=school AND a.kind='IMAGE' AND a.state='READY')) THEN
    RAISE EXCEPTION 'BLAST_PICTURE_NOT_READY' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(hon.school_blast_video_ids(p_body)) i WHERE NOT EXISTS(SELECT 1 FROM hon.school_media_assets a
      WHERE a.id=i AND a.organization_id=org AND a.school_id=school AND a.kind='VIDEO' AND a.state='READY' AND a.copy_state='DONE')) THEN
    RAISE EXCEPTION 'BLAST_VIDEO_NOT_READY' USING ERRCODE='55000'; END IF;
END $$;
-- The pictures and videos of the campaign email a lease is sending (0653 P3, now with kind). NULL when it has none.
CREATE OR REPLACE FUNCTION hon.communication_email_pictures(p_delivery uuid,p_lease uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('assetId',a.id,'kind',a.kind,'token',a.link_token,'title',a.title,'width',a.width,'height',a.height) ORDER BY a.id),'[]'::jsonb)
      FROM hon.school_media_assets a WHERE a.organization_id=b.organization_id AND a.school_id=b.school_id AND a.state='READY'
        AND ((a.kind='IMAGE' AND a.id=ANY(hon.school_blast_picture_ids(b.body)))
          OR (a.kind='VIDEO' AND a.copy_state='DONE' AND a.id=ANY(hon.school_blast_video_ids(b.body)))))
    FROM hon.communication_deliveries d
    JOIN hon.communication_messages m ON m.id=d.message_id AND m.organization_id=d.organization_id AND m.school_id=d.school_id
    JOIN hon.school_blasts b ON b.id=m.origin_id AND b.organization_id=m.organization_id AND b.school_id=m.school_id
   WHERE d.id=p_delivery AND p_lease IS NOT NULL AND d.lease_token=p_lease AND d.status='SENDING' AND d.channel='EMAIL'
     AND m.channel='EMAIL' AND m.origin_kind='CAMPAIGN' AND b.channel='EMAIL' AND b.status<>'DRAFT'
     AND cardinality(hon.school_blast_picture_ids(b.body))+cardinality(hon.school_blast_video_ids(b.body))>0
$$;

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.begin_school_video_upload(text,jsonb,text,uuid,uuid)','hon.finish_school_video_upload(text,jsonb,uuid,uuid)',
    'hon.claim_school_video_copy()','hon.finish_school_video_copy(uuid,uuid,jsonb)','hon.fail_school_video_copy(uuid,uuid,text)',
    'hon.resolve_school_video_poster(text)','hon.resolve_school_video_page(text)'];
  helpers text[]:=ARRAY['hon.school_video_copy_record(hon.school_media_assets,text,jsonb)','hon.school_blast_video_ids(text)'];
BEGIN
  FOREACH f IN ARRAY helpers||entry LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;
COMMIT;
