BEGIN;

-- School media library BL3a (0628, allocated by the coordinator 2026-11-22). Owner decisions (David): 2026-11-18 "Email
-- pictures, video as a link"; 2026-11-22 "Allow media storage" (photos and media in texts and blasts, small monthly
-- storage cost). This piece stores pictures. Spec: docs/architecture/SCHOOL_MEDIA_LIBRARY.md.
-- Rules:
--   M1  marketing.media.read (OWNER by default, staff-assignable) lists the school's pictures and opens one;
--       marketing.media.manage (sensitive, OWNER by default, staff-assignable) uploads, renames and deletes. Direct human
--       only (HUMAN_USER, HUMAN_UI, no action request or delegation), active school and organization, live
--       ESSENTIAL/CORE/COMPLETE access; the actor is proved again after the locks.
--   M2  A picture is a JPEG, PNG or GIF of 1 byte to 25 MiB and 1-20000 pixels a side. The API checks the bytes, strips
--       location and camera metadata, and passes the size and SHA-256 of exactly what it stores. The database fixes the
--       storage key (media/<assetId>); keys carry no school id and every read is authorised from the row.
--   M3  An upload is PENDING until the API confirms the stored size and checksum (READY). Delete makes it DELETED at once,
--       which stops every link; the API then removes the file and confirms (REMOVED). Rows are never deleted.
--   M4  Per school, at most 5 GiB held (PENDING, READY and DELETED-not-yet-removed) and 10 GiB uploaded per UTC calendar
--       month, checked under a per-school lock.
--   M5  Each picture has a random 43-character link token. resolve_school_media_link answers only for a READY picture of
--       an active school; it is the one entry point with no actor (the public /m/<token> link). The token only shows a
--       picture the school chose to keep in its library for messages.
--   M6  Every command has exact-request idempotency (upload, rename, delete), an audit row and an inert outbox event with
--       ids, sizes and states only (no title or bytes). The runtime gains no table privilege, only EXECUTE on the entry
--       points.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'School media requires a restricted runtime'; END IF;
  IF to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL
    OR to_regprocedure('gen_random_bytes(integer)') IS NULL OR to_regclass('hon.idempotency_records') IS NULL THEN
    RAISE EXCEPTION '0628 requires the staff eligibility, timestamp, pgcrypto and idempotency foundations'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('marketing.media.read','See the school''s media library (pictures used in emails and texts)',false,true),
  ('marketing.media.manage','Upload, rename and delete pictures in the school''s media library',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE (code='marketing.media.read' AND NOT is_sensitive AND is_staff_assignable)
      OR (code='marketing.media.manage' AND is_sensitive AND is_staff_assignable))<>2 THEN
    RAISE EXCEPTION 'media permissions already exist with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code='OWNER' AND p.code IN ('marketing.media.read','marketing.media.manage') ON CONFLICT DO NOTHING;

-- A title: one trimmed line of 1-100 characters with no control characters.
CREATE FUNCTION hon.school_media_title_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(v)='string' AND (v#>>'{}') !~ '^\s' AND (v#>>'{}') !~ '\s$'
    AND length(v#>>'{}') BETWEEN 1 AND 100 AND (v#>>'{}') !~ '[\x01-\x1F\x7F]',false)
$$;
CREATE FUNCTION hon.school_media_new_token() RETURNS text
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
  SELECT rtrim(translate(encode(gen_random_bytes(32),'base64'),'+/','-_'),'=')
$$;

CREATE TABLE hon.school_media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind='IMAGE'),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/gif')),
  title text NOT NULL CHECK (hon.school_media_title_ok(to_jsonb(title))),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 20000),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 20000),
  object_key text NOT NULL,
  link_token text NOT NULL UNIQUE CHECK (link_token ~ '^[A-Za-z0-9_-]{43}$'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','READY','DELETED','REMOVED')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ready_at timestamptz,
  deleted_at timestamptz,
  deleted_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  removed_at timestamptz,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  UNIQUE (id,organization_id,school_id),
  CHECK (object_key='media/'||id::text),
  CHECK ((ready_at IS NOT NULL)=(state='READY' OR (state IN ('DELETED','REMOVED') AND ready_at IS NOT NULL))),
  CHECK ((state IN ('DELETED','REMOVED'))=(deleted_at IS NOT NULL AND deleted_by_principal_id IS NOT NULL)),
  CHECK ((state='REMOVED')=(removed_at IS NOT NULL))
);
CREATE INDEX school_media_assets_school_idx ON hon.school_media_assets(organization_id,school_id,created_at DESC,id);
ALTER TABLE hon.school_media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_media_assets FORCE ROW LEVEL SECURITY;
-- No policy: reachable only through the fixed definer functions below.

CREATE FUNCTION hon.guard_school_media_asset() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'SCHOOL_MEDIA_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.state<>'PENDING' OR NEW.ready_at IS NOT NULL THEN RAISE EXCEPTION 'SCHOOL_MEDIA_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  -- Identity and content never change; every change bumps the version; states only move forward:
  -- PENDING->READY, PENDING|READY->DELETED, DELETED->REMOVED; a title changes only on PENDING or READY.
  IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.kind,NEW.media_type,NEW.byte_size,NEW.sha256,NEW.width,NEW.height,NEW.object_key,
      NEW.link_token,NEW.created_by_principal_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.kind,OLD.media_type,OLD.byte_size,OLD.sha256,OLD.width,OLD.height,OLD.object_key,
      OLD.link_token,OLD.created_by_principal_id,OLD.created_at)
    OR NEW.version<>OLD.version+1
    OR NOT ((NEW.state=OLD.state AND OLD.state IN ('PENDING','READY') AND NEW.title<>OLD.title)
      OR (OLD.state='PENDING' AND NEW.state='READY' AND NEW.title=OLD.title)
      OR (OLD.state IN ('PENDING','READY') AND NEW.state='DELETED' AND NEW.title=OLD.title)
      OR (OLD.state='DELETED' AND NEW.state='REMOVED' AND NEW.title=OLD.title))
    OR (OLD.ready_at IS NOT NULL AND NEW.ready_at IS DISTINCT FROM OLD.ready_at)
    OR (OLD.deleted_at IS NOT NULL AND (NEW.deleted_at,NEW.deleted_by_principal_id) IS DISTINCT FROM (OLD.deleted_at,OLD.deleted_by_principal_id)) THEN
    RAISE EXCEPTION 'SCHOOL_MEDIA_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_media_assets FOR EACH ROW EXECUTE FUNCTION hon.guard_school_media_asset();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_media_assets FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_media_asset();

-- Live direct-human authority at the current school with the given media permission. Same identity rules as 0621.
CREATE FUNCTION hon.require_school_media_actor(subject text,permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF permission IS NULL OR permission NOT IN ('marketing.media.read','marketing.media.manage')
    OR subject IS NULL OR length(subject) NOT BETWEEN 1 AND 2048 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SCHOOL_MEDIA_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code=permission AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'SCHOOL_MEDIA_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.school_media_json(a hon.school_media_assets) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('assetId',a.id,'kind',a.kind,'mediaType',a.media_type,'title',a.title,'byteSize',a.byte_size,
    'width',a.width,'height',a.height,'state',a.state,'version',a.version,
    'linkToken',CASE WHEN a.state='READY' THEN a.link_token END,
    'createdAt',hon.saas_ts(a.created_at),'readyAt',hon.saas_ts(a.ready_at),'updatedAt',hon.saas_ts(a.updated_at))
$$;
-- Bytes held (until removed) and bytes uploaded this UTC calendar month at one school.
CREATE FUNCTION hon.school_media_usage(org uuid,school uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object(
    'storedBytes',coalesce(sum(a.byte_size) FILTER (WHERE a.state IN ('PENDING','READY','DELETED')),0),'storedLimitBytes',5368709120,
    'monthBytes',coalesce(sum(a.byte_size) FILTER (WHERE a.created_at>=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0),
    'monthLimitBytes',10737418240)
  FROM hon.school_media_assets a WHERE a.organization_id=org AND a.school_id=school
$$;

-- Reserve the idempotency key, lock the authority tables, prove the actor again. Returns the prior response on replay.
CREATE FUNCTION hon.school_media_begin(subject text,operation text,p jsonb,key text,actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  IF key IS NULL OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',operation,'input',p)::text,'UTF8')),'hex');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,
    hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_school_media_actor(subject,'marketing.media.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_MEDIA_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF coalesce(reserved,false) THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  RETURN prior.response_body;
END $$;
-- Records audit and an inert outbox event (ids, size and state only), optionally saves the response, proves the actor once more.
CREATE FUNCTION hon.school_media_finish(subject text,key text,actor uuid,action text,a hon.school_media_assets,before jsonb,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb:=hon.school_media_json(a);
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(a.organization_id,a.school_id,actor,'HUMAN_UI',action,'SCHOOL_MEDIA_ASSET',a.id,before,
      jsonb_build_object('state',a.state,'version',a.version,'kind',a.kind,'byteSize',a.byte_size),'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(a.organization_id,a.school_id,action,1,'SCHOOL_MEDIA_ASSET',a.id,a.version,correlation,request,
      jsonb_build_object('assetId',a.id,'version',a.version,'state',a.state,'kind',a.kind,'byteSize',a.byte_size));
  IF key IS NOT NULL THEN
    UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
      WHERE organization_id=a.organization_id AND school_id=a.school_id AND principal_id=actor AND idempotency_key=key;
  END IF;
  IF hon.require_school_media_actor(subject,'marketing.media.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_MEDIA_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- The library: newest first (up to 500 PENDING or READY pictures) and the school's usage.
CREATE FUNCTION hon.read_school_media(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; result jsonb;
BEGIN
  actor:=hon.require_school_media_actor(subject,'marketing.media.read');
  SELECT jsonb_build_object('assets',coalesce(jsonb_agg(hon.school_media_json(a) ORDER BY a.created_at DESC,a.id),'[]'::jsonb),
      'usage',hon.school_media_usage(org,school)) INTO result
    FROM (SELECT * FROM hon.school_media_assets x WHERE x.organization_id=org AND x.school_id=school AND x.state IN ('PENDING','READY')
      ORDER BY x.created_at DESC,x.id LIMIT 500) a;
  IF hon.require_school_media_actor(subject,'marketing.media.read') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_MEDIA_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Staff preview: the storage key and type of one READY picture at the current school.
CREATE FUNCTION hon.authorize_school_media_view(subject text,asset uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; a hon.school_media_assets;
BEGIN
  actor:=hon.require_school_media_actor(subject,'marketing.media.read');
  SELECT * INTO a FROM hon.school_media_assets x WHERE x.id=asset AND x.organization_id=org AND x.school_id=school AND x.state='READY';
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF hon.require_school_media_actor(subject,'marketing.media.read') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_MEDIA_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('assetId',a.id,'objectKey',a.object_key,'mediaType',a.media_type);
END $$;

-- Step 1 of an upload: {title,mediaType,byteSize,sha256,width,height} becomes a PENDING picture with a fixed key, within
-- the school's caps. A replay returns the same picture (the API then stores the same bytes again and confirms).
CREATE FUNCTION hon.begin_school_media_upload(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; a hon.school_media_assets; usage jsonb;
BEGIN
  actor:=hon.require_school_media_actor(subject,'marketing.media.manage');
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['byteSize','height','mediaType','sha256','title','width']
    OR NOT hon.school_media_title_ok(p->'title')
    OR jsonb_typeof(p->'mediaType') IS DISTINCT FROM 'string' OR p->>'mediaType' NOT IN ('image/jpeg','image/png','image/gif')
    OR jsonb_typeof(p->'sha256') IS DISTINCT FROM 'string' OR p->>'sha256' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p->'byteSize') IS DISTINCT FROM 'number' OR p->>'byteSize' !~ '^[1-9][0-9]{0,8}$' OR (p->>'byteSize')::bigint>26214400
    OR jsonb_typeof(p->'width') IS DISTINCT FROM 'number' OR p->>'width' !~ '^[1-9][0-9]{0,4}$' OR (p->>'width')::integer>20000
    OR jsonb_typeof(p->'height') IS DISTINCT FROM 'number' OR p->>'height' !~ '^[1-9][0-9]{0,4}$' OR (p->>'height')::integer>20000
    OR request IS NULL OR correlation IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  prior:=hon.school_media_begin(subject,'begin_school_media_upload',p,key,actor);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_media:'||school::text,0));
  usage:=hon.school_media_usage(org,school);
  IF (usage->>'storedBytes')::bigint+(p->>'byteSize')::bigint>(usage->>'storedLimitBytes')::bigint THEN
    RAISE EXCEPTION 'MEDIA_STORAGE_FULL' USING ERRCODE='55000'; END IF;
  IF (usage->>'monthBytes')::bigint+(p->>'byteSize')::bigint>(usage->>'monthLimitBytes')::bigint THEN
    RAISE EXCEPTION 'MEDIA_MONTHLY_LIMIT' USING ERRCODE='55000'; END IF;
  INSERT INTO hon.school_media_assets(id,organization_id,school_id,kind,media_type,title,byte_size,sha256,width,height,object_key,link_token,created_by_principal_id)
    SELECT n.id,org,school,'IMAGE',p->>'mediaType',p->>'title',(p->>'byteSize')::bigint,p->>'sha256',(p->>'width')::integer,(p->>'height')::integer,
      'media/'||n.id::text,hon.school_media_new_token(),actor FROM (SELECT gen_random_uuid() AS id) n
    RETURNING * INTO a;
  RETURN hon.school_media_finish(subject,key,actor,'school_media.upload_started',a,NULL,request,correlation)
    ||jsonb_build_object('objectKey',a.object_key);
END $$;

-- Step 2: the API stored exactly {byteSize,sha256} under the key. PENDING becomes READY; a READY picture with the same
-- size and checksum answers as it is (a retried confirm), anything else is refused.
CREATE FUNCTION hon.finish_school_media_upload(subject text,p jsonb,request uuid,correlation uuid) RETURNS jsonb
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
  SELECT * INTO a FROM hon.school_media_assets x WHERE x.id=(p->>'assetId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF a.byte_size<>(p->>'byteSize')::bigint OR a.sha256<>p->>'sha256' THEN RAISE EXCEPTION 'MEDIA_UPLOAD_MISMATCH' USING ERRCODE='22023'; END IF;
  IF a.state='READY' THEN RETURN hon.school_media_json(a); END IF;
  IF a.state<>'PENDING' THEN RAISE EXCEPTION 'MEDIA_NOT_PENDING' USING ERRCODE='55000'; END IF;
  before:=jsonb_build_object('state',a.state,'version',a.version);
  UPDATE hon.school_media_assets SET state='READY',ready_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    WHERE id=a.id RETURNING * INTO a;
  RETURN hon.school_media_finish(subject,NULL,actor,'school_media.ready',a,before,request,correlation);
END $$;

-- {assetId,expectedVersion,title}: rename a PENDING or READY picture.
CREATE FUNCTION hon.rename_school_media(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; a hon.school_media_assets; before jsonb;
BEGIN
  actor:=hon.require_school_media_actor(subject,'marketing.media.manage');
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['assetId','expectedVersion','title']
    OR jsonb_typeof(p->'assetId') IS DISTINCT FROM 'string' OR p->>'assetId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR p->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$'
    OR NOT hon.school_media_title_ok(p->'title') OR request IS NULL OR correlation IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  prior:=hon.school_media_begin(subject,'rename_school_media',p,key,actor);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO a FROM hon.school_media_assets x WHERE x.id=(p->>'assetId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND OR a.state NOT IN ('PENDING','READY') THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF a.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  before:=jsonb_build_object('state',a.state,'version',a.version);
  IF a.title=p->>'title' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  UPDATE hon.school_media_assets SET title=p->>'title',version=version+1,updated_at=clock_timestamp() WHERE id=a.id RETURNING * INTO a;
  RETURN hon.school_media_finish(subject,key,actor,'school_media.renamed',a,before,request,correlation);
END $$;

-- {assetId,expectedVersion}: delete a PENDING or READY picture. Links stop at once; the answer carries the storage key so
-- the API can remove the file and then confirm.
CREATE FUNCTION hon.delete_school_media(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; a hon.school_media_assets; before jsonb;
BEGIN
  actor:=hon.require_school_media_actor(subject,'marketing.media.manage');
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['assetId','expectedVersion']
    OR jsonb_typeof(p->'assetId') IS DISTINCT FROM 'string' OR p->>'assetId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR p->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$'
    OR request IS NULL OR correlation IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  prior:=hon.school_media_begin(subject,'delete_school_media',p,key,actor);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO a FROM hon.school_media_assets x WHERE x.id=(p->>'assetId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND OR a.state NOT IN ('PENDING','READY') THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF a.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  before:=jsonb_build_object('state',a.state,'version',a.version);
  UPDATE hon.school_media_assets SET state='DELETED',deleted_at=clock_timestamp(),deleted_by_principal_id=actor,version=version+1,updated_at=clock_timestamp()
    WHERE id=a.id RETURNING * INTO a;
  RETURN hon.school_media_finish(subject,key,actor,'school_media.deleted',a,before,request,correlation)||jsonb_build_object('objectKey',a.object_key);
END $$;

-- The file under a DELETED picture's key is gone: DELETED becomes REMOVED (repeatable). Returns the picture's state.
CREATE FUNCTION hon.confirm_school_media_removed(subject text,asset uuid,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; a hon.school_media_assets; before jsonb;
BEGIN
  actor:=hon.require_school_media_actor(subject,'marketing.media.manage');
  IF asset IS NULL OR request IS NULL OR correlation IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM hon.school_media_assets x WHERE x.id=asset AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF a.state='REMOVED' THEN RETURN jsonb_build_object('assetId',a.id,'state',a.state); END IF;
  IF a.state<>'DELETED' THEN RAISE EXCEPTION 'MEDIA_NOT_DELETED' USING ERRCODE='55000'; END IF;
  before:=jsonb_build_object('state',a.state,'version',a.version);
  UPDATE hon.school_media_assets SET state='REMOVED',removed_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=a.id RETURNING * INTO a;
  PERFORM hon.school_media_finish(subject,NULL,actor,'school_media.removed',a,before,request,correlation);
  RETURN jsonb_build_object('assetId',a.id,'state',a.state);
END $$;

-- The public /m/<token> link: the storage key and type of a READY picture of an active school and organization, else null.
-- No actor and no tenant context; the token alone names the picture.
CREATE FUNCTION hon.resolve_school_media_link(token text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('objectKey',a.object_key,'mediaType',a.media_type)
  FROM hon.school_media_assets a
  JOIN hon.schools s ON s.id=a.school_id AND s.organization_id=a.organization_id AND s.status='ACTIVE'
  JOIN hon.organizations o ON o.id=a.organization_id AND o.status='ACTIVE'
  WHERE token ~ '^[A-Za-z0-9_-]{43}$' AND a.link_token=token AND a.state='READY'
$$;

DO $$ DECLARE r text; f text; t text;
  entry text[]:=ARRAY['hon.read_school_media(text)','hon.authorize_school_media_view(text,uuid)',
    'hon.begin_school_media_upload(text,jsonb,text,uuid,uuid)','hon.finish_school_media_upload(text,jsonb,uuid,uuid)',
    'hon.rename_school_media(text,jsonb,text,uuid,uuid)','hon.delete_school_media(text,jsonb,text,uuid,uuid)',
    'hon.confirm_school_media_removed(text,uuid,uuid,uuid)','hon.resolve_school_media_link(text)'];
  helpers text[]:=ARRAY['hon.school_media_title_ok(jsonb)','hon.school_media_new_token()','hon.guard_school_media_asset()',
    'hon.require_school_media_actor(text,text)','hon.school_media_json(hon.school_media_assets)','hon.school_media_usage(uuid,uuid)',
    'hon.school_media_begin(text,text,jsonb,text,uuid)','hon.school_media_finish(text,text,uuid,text,hon.school_media_assets,jsonb,uuid,uuid)'];
  tables text[]:=ARRAY['hon.school_media_assets'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',t,r); END LOOP;
  END LOOP;
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
