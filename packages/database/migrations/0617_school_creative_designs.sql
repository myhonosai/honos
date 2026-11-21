BEGIN;

-- 0617 Creative Studio design editor piece D1 (coordinator-allocated 2026-11-21; docs/architecture/CREATIVE_DESIGN_EDITOR.md).
-- Owner request (David, 2026-11-20): "something like canvas in there to make poster and stuff with ease with ai help";
-- the plan's defaults were accepted the same evening ("Just do these first").
--   DE1  creative.design.read (see the school's designs and photos) and creative.design.manage (create, change, archive,
--        restore, upload photos). Staff-assignable, given to OWNER and to every role that already holds
--        marketing.social.manage. New schools' OWNER roles receive every permission at sign-up (0241).
--   DE2  A design is one school, a name (1-80, unique per school among active designs, case-insensitive), one closed size
--        that never changes, and a version-1 document (hon.creative_design_document_ok: one page per side, closed element
--        shapes, at most 150 elements a page, at most 300,000 characters). Every photo a document places must be a design
--        photo of the same school. At most 200 active designs and 1,000 in all per school.
--   DE3  Designs are never deleted. Each change is the next version under the exact expected version; archive and restore
--        are their own command; an archived design must be restored before it changes. Every command is idempotent (exact
--        replay, key reuse refused), audited with ids, size and version only, and emits one inert ids-only outbox event.
--   DE4  Photos are JPEG, PNG or WebP, 1..1,400,000 bytes, with no metadata (the API strips it with the 0388 stripper and
--        the table refuses any that remains, hon.paper_import_image_clean). Never changed or deleted here; at most 300 a
--        school. Reading one needs creative.design.read at that school.
--   DE5  Direct human only (HUMAN_USER, HUMAN_UI, no action request or delegation), live ESSENTIAL/CORE/COMPLETE access,
--        active school and organization (0364 hon.conversation_staff_has); the actor is proved again after the locks and
--        before returning. Forced RLS with no policies; the runtime gains only EXECUTE on six entry points.
-- Nothing here sends, publishes, prints, charges, or calls an AI or other outside service.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'Creative designs require a restricted runtime'; END IF;
  IF to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.conversation_staff_has(uuid,uuid,uuid,text)') IS NULL
    OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL OR to_regprocedure('hon.paper_import_image_clean(text,bytea)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='marketing.social.manage') THEN
    RAISE EXCEPTION '0617 requires 0154, 0224, 0347, 0364 and 0388'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('creative.design.read','See the school''s saved flyers, posters, postcards and social designs and their photos',false,true),
  ('creative.design.manage','Create, change, archive and restore the school''s designs and upload photos for them',false,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('creative.design.read','creative.design.manage') AND NOT is_sensitive AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'creative design permissions already exist with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code='OWNER' AND p.code IN ('creative.design.read','creative.design.manage') ON CONFLICT DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT DISTINCT rp.role_id,rp.organization_id,p.code FROM hon.role_permissions rp CROSS JOIN hon.permissions p
 WHERE rp.permission_code='marketing.social.manage' AND p.code IN ('creative.design.read','creative.design.manage') ON CONFLICT DO NOTHING;

-- DE2 sizes: width and height in points (print, 72 per inch) or pixels (screen), and the number of sides.
CREATE FUNCTION hon.creative_design_size(p_code text,OUT width numeric,OUT height numeric,OUT sides integer)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT s.w,s.h,s.n FROM (VALUES ('FLYER_LETTER',612::numeric,792::numeric,1),('FLYER_HALF',396,612,1),('POSTER_11X17',792,1224,1),
    ('POSTER_18X24',1296,1728,1),('POSTCARD_4X6',432,288,2),('POSTCARD_5X7',504,360,2),('SOCIAL_SQUARE',1080,1080,1),
    ('SOCIAL_STORY',1080,1920,1),('EVENT_COVER',1920,1005,1)) s(code,w,h,n) WHERE s.code=p_code
$$;

-- A name: trimmed, 1..80, no control or invisible direction characters.
CREATE FUNCTION hon.creative_design_name_ok(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(length(v) BETWEEN 1 AND 80 AND btrim(v)=v AND v !~ '[[:cntrl:]​-‏‪-‮⁠-⁯﻿]',false)
$$;

-- A number within [lo, hi]; a colour #RRGGBB (upper case); a colour or JSON null.
CREATE FUNCTION hon.creative_design_num_ok(v jsonb,lo numeric,hi numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(v)='number' AND (v#>>'{}')::numeric BETWEEN lo AND hi,false)
$$;
CREATE FUNCTION hon.creative_design_color_ok(v jsonb,nullable boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce((nullable AND jsonb_typeof(v)='null') OR (jsonb_typeof(v)='string' AND v#>>'{}' ~ '^#[0-9A-F]{6}$'),false)
$$;

-- DE2 the document shape, the same rules as validateCreativeDesignDocument in @hon/contracts.
CREATE FUNCTION hon.creative_design_document_ok(d jsonb,p_size text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE sz record; pg jsonb; e jsonb; k text; keys text[]; ids text[]:='{}'; w numeric; h numeric; t text;
BEGIN
  SELECT * INTO sz FROM hon.creative_design_size(p_size);
  IF sz.sides IS NULL OR jsonb_typeof(d) IS DISTINCT FROM 'object' OR length(d::text)>330000
    OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(d) x) IS DISTINCT FROM ARRAY['pages','v']
    OR d->'v' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(d->'pages') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'pages')<>sz.sides THEN RETURN false; END IF;
  w:=sz.width; h:=sz.height;
  FOR pg IN SELECT x FROM jsonb_array_elements(d->'pages') x LOOP
    IF jsonb_typeof(pg) IS DISTINCT FROM 'object' OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(pg) x) IS DISTINCT FROM ARRAY['background','elements']
      OR NOT hon.creative_design_color_ok(pg->'background',false) OR jsonb_typeof(pg->'elements') IS DISTINCT FROM 'array'
      OR jsonb_array_length(pg->'elements')>150 THEN RETURN false; END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(pg->'elements') x LOOP
      IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR jsonb_typeof(e->'kind') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      k:=e->>'kind';
      keys:=ARRAY['h','id','kind','locked','opacity','rotation','w','x','y']||CASE k
        WHEN 'text' THEN ARRAY['align','bold','color','font','italic','lineHeight','size','text']
        WHEN 'rect' THEN ARRAY['fill','radius','stroke','strokeWidth']
        WHEN 'ellipse' THEN ARRAY['fill','stroke','strokeWidth']
        WHEN 'line' THEN ARRAY['stroke','strokeWidth']
        WHEN 'image' THEN ARRAY['fit','imageId'] END;
      IF keys IS NULL OR array_length(keys,1)=9 THEN RETURN false; END IF;
      IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(e) x) IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(keys) x)
        OR jsonb_typeof(e->'id') IS DISTINCT FROM 'string' OR e->>'id' !~ '^[a-z0-9-]{1,40}$' OR e->>'id'=ANY(ids)
        OR NOT hon.creative_design_num_ok(e->'x',-2*w,3*w) OR NOT hon.creative_design_num_ok(e->'y',-2*h,3*h)
        OR NOT ((k='line' AND hon.creative_design_num_ok(e->'w',-3*w,3*w) AND hon.creative_design_num_ok(e->'h',-3*h,3*h))
          OR (k<>'line' AND hon.creative_design_num_ok(e->'w',0.01,3*w) AND hon.creative_design_num_ok(e->'h',0.01,3*h)))
        OR NOT hon.creative_design_num_ok(e->'rotation',-360,360) OR NOT hon.creative_design_num_ok(e->'opacity',0,1)
        OR jsonb_typeof(e->'locked') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
      ids:=ids||(e->>'id');
      IF k='text' THEN
        t:=e->>'text';
        IF jsonb_typeof(e->'text') IS DISTINCT FROM 'string' OR length(t) NOT BETWEEN 1 AND 2000 OR t ~ '[\x01-\x09\x0b-\x1f\x7f‎‏‪-‮⁦-⁩﻿]'
          OR jsonb_typeof(e->'font') IS DISTINCT FROM 'string' OR e->>'font' NOT IN ('SANS','SERIF','DISPLAY','ROUNDED','HANDWRITING','MONO')
          OR NOT hon.creative_design_num_ok(e->'size',4,600) OR jsonb_typeof(e->'bold') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(e->'italic') IS DISTINCT FROM 'boolean' OR NOT hon.creative_design_color_ok(e->'color',false)
          OR jsonb_typeof(e->'align') IS DISTINCT FROM 'string' OR e->>'align' NOT IN ('left','center','right')
          OR NOT hon.creative_design_num_ok(e->'lineHeight',0.8,3) THEN RETURN false; END IF;
      ELSIF k IN ('rect','ellipse') THEN
        IF NOT hon.creative_design_color_ok(e->'fill',true) OR NOT hon.creative_design_color_ok(e->'stroke',true)
          OR NOT hon.creative_design_num_ok(e->'strokeWidth',0,200) OR (k='rect' AND NOT hon.creative_design_num_ok(e->'radius',0,2000)) THEN RETURN false; END IF;
      ELSIF k='line' THEN
        IF NOT hon.creative_design_color_ok(e->'stroke',false) OR NOT hon.creative_design_num_ok(e->'strokeWidth',0.5,200) THEN RETURN false; END IF;
      ELSE
        IF jsonb_typeof(e->'imageId') IS DISTINCT FROM 'string' OR e->>'imageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR jsonb_typeof(e->'fit') IS DISTINCT FROM 'string' OR e->>'fit' NOT IN ('cover','contain') THEN RETURN false; END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END $$;

CREATE TABLE hon.school_creative_designs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  name text NOT NULL CHECK (hon.creative_design_name_ok(name)),
  size_code text NOT NULL CHECK ((hon.creative_design_size(size_code)).sides IS NOT NULL),
  document jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  CONSTRAINT school_creative_designs_document CHECK (hon.creative_design_document_ok(document,size_code)),
  CHECK ((status='ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX school_creative_designs_active_name ON hon.school_creative_designs(organization_id,school_id,lower(name)) WHERE status='ACTIVE';
CREATE INDEX school_creative_designs_scope_idx ON hon.school_creative_designs(organization_id,school_id,status,updated_at DESC);
ALTER TABLE hon.school_creative_designs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_creative_designs FORCE ROW LEVEL SECURITY;

CREATE TABLE hon.school_creative_design_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/webp')),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 1400000),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  CONSTRAINT school_creative_design_photos_clean CHECK (hon.paper_import_image_clean(media_type,content)),
  CONSTRAINT school_creative_design_photos_checksum CHECK (checksum=encode(sha256(content),'hex'))
);
ALTER TABLE hon.school_creative_design_photos ALTER COLUMN content SET STORAGE EXTERNAL;
CREATE INDEX school_creative_design_photos_scope_idx ON hon.school_creative_design_photos(organization_id,school_id);
ALTER TABLE hon.school_creative_design_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_creative_design_photos FORCE ROW LEVEL SECURITY;
-- No policies on either table: reachable only through the fixed definer functions below.

-- DE3 designs are never deleted; scope, size, creator and creation time never change; every update is the next version.
CREATE FUNCTION hon.guard_school_creative_design() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'CREATIVE_DESIGN_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.status<>'ACTIVE' THEN RAISE EXCEPTION 'CREATIVE_DESIGN_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.size_code,NEW.created_by_principal_id,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.size_code,OLD.created_by_principal_id,OLD.created_at)
    OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'CREATIVE_DESIGN_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_creative_designs FOR EACH ROW EXECUTE FUNCTION hon.guard_school_creative_design();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_creative_designs FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_creative_design();
-- DE4 photos are insert-only here.
CREATE FUNCTION hon.guard_school_creative_design_photo() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CREATIVE_DESIGN_PHOTO_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_creative_design_photos FOR EACH ROW EXECUTE FUNCTION hon.guard_school_creative_design_photo();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_creative_design_photos FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_creative_design_photo();

-- DE5 the staff actor of the session school holding p_permission, or CREATIVE_DESIGN_FORBIDDEN. Same session rules as 0586.
CREATE FUNCTION hon.require_creative_design_actor(subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL OR p_permission IS NULL OR p_permission NOT IN ('creative.design.read','creative.design.manage') THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
  IF NOT hon.conversation_staff_has(actor,org,school,p_permission) THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.school_creative_design_summary(d hon.school_creative_designs) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('designId',d.id,'name',d.name,'sizeCode',d.size_code,'status',d.status,'version',d.version,
    'createdAt',hon.saas_ts(d.created_at),'updatedAt',hon.saas_ts(d.updated_at))
$$;
CREATE FUNCTION hon.school_creative_design_json(d hon.school_creative_designs) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.school_creative_design_summary(d)||jsonb_build_object('document',d.document)
$$;
CREATE FUNCTION hon.school_creative_design_photo_json(p hon.school_creative_design_photos) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('photoId',p.id,'mediaType',p.media_type,'bytes',octet_length(p.content),'checksum',p.checksum,'createdAt',hon.saas_ts(p.created_at))
$$;

-- The school's designs, newest change first, without documents. p: optional status (ACTIVE default, or ARCHIVED).
CREATE FUNCTION hon.read_school_creative_designs(subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; actor uuid; v_status text; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>'status')
    OR (p ? 'status' AND (jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('ACTIVE','ARCHIVED'))) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_creative_design_actor(subject,'creative.design.read');
  org:=hon.current_organization_id(); school:=hon.current_school_id(); v_status:=coalesce(p->>'status','ACTIVE');
  SELECT jsonb_build_object('designs',coalesce(jsonb_agg(hon.school_creative_design_summary(d) ORDER BY d.updated_at DESC,d.id),'[]'::jsonb)) INTO result
    FROM (SELECT * FROM hon.school_creative_designs d WHERE d.organization_id=org AND d.school_id=school AND d.status=v_status
            ORDER BY d.updated_at DESC,d.id LIMIT 1000) d;
  IF hon.require_creative_design_actor(subject,'creative.design.read') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- One design with its document. p: {designId}.
CREATE FUNCTION hon.read_school_creative_design(subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; d hon.school_creative_designs%ROWTYPE;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['designId']
    OR jsonb_typeof(p->'designId') IS DISTINCT FROM 'string' OR p->>'designId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_creative_design_actor(subject,'creative.design.read');
  SELECT * INTO d FROM hon.school_creative_designs x WHERE x.id=(p->>'designId')::uuid
    AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'CREATIVE_DESIGN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF hon.require_creative_design_actor(subject,'creative.design.read') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.school_creative_design_json(d);
END $$;

-- One photo with its bytes (base64). p: {photoId}.
CREATE FUNCTION hon.read_school_creative_design_photo(subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; x hon.school_creative_design_photos%ROWTYPE;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['photoId']
    OR jsonb_typeof(p->'photoId') IS DISTINCT FROM 'string' OR p->>'photoId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_creative_design_actor(subject,'creative.design.read');
  SELECT * INTO x FROM hon.school_creative_design_photos f WHERE f.id=(p->>'photoId')::uuid
    AND f.organization_id=hon.current_organization_id() AND f.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'CREATIVE_DESIGN_PHOTO_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF hon.require_creative_design_actor(subject,'creative.design.read') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.school_creative_design_photo_json(x)||jsonb_build_object('data',translate(encode(x.content,'base64'),E'\n',''));
END $$;

-- Shared command start: argument shape, fingerprint, reservation, locks, actor re-proof and exact replay. Returns the prior
-- response for a replay, or null for a fresh command (the caller completes the reservation).
CREATE FUNCTION hon.creative_design_command_begin(subject text,operation text,p jsonb,key text,request uuid,correlation uuid,OUT actor uuid,OUT replay jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  IF NOT hon.membership_command_args_ok(subject,key,request,correlation) OR operation NOT IN ('creative_design.save','creative_design.status','creative_design.photo') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',operation,'input',p)::text,'UTF8')),'hex');
  actor:=hon.require_creative_design_actor(subject,'creative.design.manage');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,
    hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_creative_design_actor(subject,'creative.design.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT coalesce(reserved,false) THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    replay:=prior.response_body; RETURN;
  END IF;
  -- One school's designs and photos change one command at a time, so the name and count checks cannot race.
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_creative_designs:'||school::text,0));
END $$;

-- Name free and caps respected for an active design (p_self excluded).
CREATE FUNCTION hon.creative_design_room_check(p_org uuid,p_school uuid,p_name text,p_self uuid,p_new boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM hon.school_creative_designs d WHERE d.organization_id=p_org AND d.school_id=p_school
      AND d.status='ACTIVE' AND lower(d.name)=lower(p_name) AND d.id IS DISTINCT FROM p_self) THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_NAME_TAKEN' USING ERRCODE='23505'; END IF;
  IF (SELECT count(*) FROM hon.school_creative_designs d WHERE d.organization_id=p_org AND d.school_id=p_school
      AND d.status='ACTIVE' AND d.id IS DISTINCT FROM p_self)>=200
    OR (p_new AND (SELECT count(*) FROM hon.school_creative_designs d WHERE d.organization_id=p_org AND d.school_id=p_school)>=1000) THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_LIMIT' USING ERRCODE='54000'; END IF;
END $$;

-- Ids-only audit and an inert outbox event, then the reservation completes.
CREATE FUNCTION hon.creative_design_command_finish(actor uuid,action text,entity text,entity_id uuid,entity_version integer,shape jsonb,before jsonb,
  key text,request uuid,correlation uuid,result jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  IF entity NOT IN ('CREATIVE_DESIGN','CREATIVE_DESIGN_PHOTO') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,entity,entity_id,before,shape,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,CASE entity WHEN 'CREATIVE_DESIGN' THEN 'creative_design.saved' ELSE 'creative_design.photo_added' END,1,entity,entity_id,entity_version,correlation,request,shape);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
END $$;

-- Create or change one design. p (all keys): {designId|null, expectedVersion, name, sizeCode, document}. A new design has
-- designId null and expectedVersion 0. A change keeps the size and needs an active design.
CREATE FUNCTION hon.save_school_creative_design(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb;
  d hon.school_creative_designs%ROWTYPE; before jsonb; shape jsonb; result jsonb; expected integer;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['designId','document','expectedVersion','name','sizeCode']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR NOT (jsonb_typeof(p->'designId')='null' OR (jsonb_typeof(p->'designId')='string' AND p->>'designId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR NOT hon.creative_design_name_ok(p->>'name')
    OR jsonb_typeof(p->'sizeCode') IS DISTINCT FROM 'string' OR NOT hon.creative_design_document_ok(p->'document',p->>'sizeCode')
    OR (jsonb_typeof(p->'designId')='null') <> ((p->>'expectedVersion')::integer=0) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=(p->>'expectedVersion')::integer;
  SELECT b.actor,b.replay INTO actor,replay FROM hon.creative_design_command_begin(subject,'creative_design.save',p,key,request,correlation) b;
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('design',replay,'replayed',true); END IF;
  -- DE2 every placed photo belongs to this school.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'document'->'pages') pg, jsonb_array_elements(pg->'elements') e
      WHERE e->>'kind'='image' AND NOT EXISTS(SELECT 1 FROM hon.school_creative_design_photos f
        WHERE f.id=(e->>'imageId')::uuid AND f.organization_id=org AND f.school_id=school)) THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_PHOTO_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF jsonb_typeof(p->'designId')='string' THEN
    SELECT * INTO d FROM hon.school_creative_designs x WHERE x.id=(p->>'designId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CREATIVE_DESIGN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF d.size_code<>p->>'sizeCode' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    IF d.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF d.status='ARCHIVED' THEN RAISE EXCEPTION 'CREATIVE_DESIGN_ARCHIVED' USING ERRCODE='55000'; END IF;
  END IF;
  PERFORM hon.creative_design_room_check(org,school,p->>'name',d.id,d.id IS NULL);
  IF d.id IS NULL THEN
    INSERT INTO hon.school_creative_designs(organization_id,school_id,name,size_code,document,status,created_by_principal_id,updated_by_principal_id)
      VALUES(org,school,p->>'name',p->>'sizeCode',p->'document','ACTIVE',actor,actor) RETURNING * INTO d;
  ELSE
    before:=jsonb_build_object('designId',d.id,'sizeCode',d.size_code,'status',d.status,'version',d.version);
    UPDATE hon.school_creative_designs SET name=p->>'name',document=p->'document',version=d.version+1,
        updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
  END IF;
  result:=hon.school_creative_design_json(d);
  shape:=jsonb_build_object('designId',d.id,'sizeCode',d.size_code,'status',d.status,'version',d.version);
  PERFORM hon.creative_design_command_finish(actor,CASE WHEN before IS NULL THEN 'creative_design.create' ELSE 'creative_design.update' END,
    'CREATIVE_DESIGN',d.id,d.version,shape,before,key,request,correlation,result);
  IF hon.require_creative_design_actor(subject,'creative.design.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('design',result,'replayed',false);
END $$;

-- Archive or restore one design. p (all keys): {designId, expectedVersion, status ARCHIVED|ACTIVE}. Restoring needs the
-- name free and room under the cap.
CREATE FUNCTION hon.set_school_creative_design_status(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb;
  d hon.school_creative_designs%ROWTYPE; before jsonb; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['designId','expectedVersion','status']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'designId') IS DISTINCT FROM 'string' OR p->>'designId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('ACTIVE','ARCHIVED') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT b.actor,b.replay INTO actor,replay FROM hon.creative_design_command_begin(subject,'creative_design.status',p,key,request,correlation) b;
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('design',replay,'replayed',true); END IF;
  SELECT * INTO d FROM hon.school_creative_designs x WHERE x.id=(p->>'designId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREATIVE_DESIGN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF d.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF d.status=p->>'status' THEN RAISE EXCEPTION 'CREATIVE_DESIGN_STATUS_UNCHANGED' USING ERRCODE='55000'; END IF;
  IF p->>'status'='ACTIVE' THEN PERFORM hon.creative_design_room_check(org,school,d.name,d.id,false); END IF;
  before:=jsonb_build_object('designId',d.id,'sizeCode',d.size_code,'status',d.status,'version',d.version);
  UPDATE hon.school_creative_designs SET status=p->>'status',archived_at=CASE WHEN p->>'status'='ARCHIVED' THEN clock_timestamp() END,
      version=d.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
  result:=hon.school_creative_design_json(d);
  PERFORM hon.creative_design_command_finish(actor,CASE d.status WHEN 'ARCHIVED' THEN 'creative_design.archive' ELSE 'creative_design.restore' END,
    'CREATIVE_DESIGN',d.id,d.version,jsonb_build_object('designId',d.id,'sizeCode',d.size_code,'status',d.status,'version',d.version),before,key,request,correlation,result);
  IF hon.require_creative_design_actor(subject,'creative.design.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('design',result,'replayed',false);
END $$;

-- Upload one photo. p (all keys): {mediaType, data} where data is canonical base64 of the already metadata-free bytes.
CREATE FUNCTION hon.add_school_creative_design_photo(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; bytes bytea;
  x hon.school_creative_design_photos%ROWTYPE; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['data','mediaType']
    OR jsonb_typeof(p->'mediaType') IS DISTINCT FROM 'string' OR p->>'mediaType' NOT IN ('image/jpeg','image/png','image/webp')
    OR jsonb_typeof(p->'data') IS DISTINCT FROM 'string' OR length(p->>'data') NOT BETWEEN 4 AND 1866668
    OR p->>'data' !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  bytes:=decode(p->>'data','base64');
  IF octet_length(bytes) NOT BETWEEN 1 AND 1400000 OR NOT hon.paper_import_image_clean(p->>'mediaType',bytes) THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_PHOTO_REFUSED' USING ERRCODE='22023'; END IF;
  SELECT b.actor,b.replay INTO actor,replay FROM hon.creative_design_command_begin(subject,'creative_design.photo',p,key,request,correlation) b;
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('photo',replay,'replayed',true); END IF;
  IF (SELECT count(*) FROM hon.school_creative_design_photos f WHERE f.organization_id=org AND f.school_id=school)>=300 THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_PHOTO_LIMIT' USING ERRCODE='54000'; END IF;
  INSERT INTO hon.school_creative_design_photos(organization_id,school_id,media_type,content,checksum,created_by_principal_id)
    VALUES(org,school,p->>'mediaType',bytes,encode(sha256(bytes),'hex'),actor) RETURNING * INTO x;
  result:=hon.school_creative_design_photo_json(x);
  PERFORM hon.creative_design_command_finish(actor,'creative_design.photo.add','CREATIVE_DESIGN_PHOTO',x.id,1,
    jsonb_build_object('photoId',x.id,'mediaType',x.media_type,'checksum',x.checksum),NULL,key,request,correlation,result);
  IF hon.require_creative_design_actor(subject,'creative.design.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('photo',result,'replayed',false);
END $$;

DO $$ DECLARE r text; f text; t text;
  entry text[]:=ARRAY['hon.read_school_creative_designs(text,jsonb)','hon.read_school_creative_design(text,jsonb)',
    'hon.read_school_creative_design_photo(text,jsonb)','hon.save_school_creative_design(text,jsonb,text,uuid,uuid)',
    'hon.set_school_creative_design_status(text,jsonb,text,uuid,uuid)','hon.add_school_creative_design_photo(text,jsonb,text,uuid,uuid)'];
  helpers text[]:=ARRAY['hon.creative_design_size(text)','hon.creative_design_name_ok(text)','hon.creative_design_num_ok(jsonb,numeric,numeric)',
    'hon.creative_design_color_ok(jsonb,boolean)','hon.creative_design_document_ok(jsonb,text)','hon.guard_school_creative_design()',
    'hon.guard_school_creative_design_photo()','hon.require_creative_design_actor(text,text)',
    'hon.school_creative_design_summary(hon.school_creative_designs)','hon.school_creative_design_json(hon.school_creative_designs)',
    'hon.school_creative_design_photo_json(hon.school_creative_design_photos)','hon.creative_design_command_begin(text,text,jsonb,text,uuid,uuid)',
    'hon.creative_design_room_check(uuid,uuid,text,uuid,boolean)',
    'hon.creative_design_command_finish(uuid,text,text,uuid,integer,jsonb,jsonb,text,uuid,uuid,jsonb)'];
BEGIN
  FOREACH t IN ARRAY ARRAY['hon.school_creative_designs','hon.school_creative_design_photos'] LOOP
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
